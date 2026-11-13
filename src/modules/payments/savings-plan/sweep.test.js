process.env.SUPABASE_URL         ||= 'https://savings-plan-test.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL    ||= 'https://savings-plan-test.invalid';

const assert = require('assert');
const path = require('path');

// The sweep and the end of a plan, with every outside call (Supabase, Shopify, email, GoKwik, the
// voucher) replaced by an in-memory fake.
const fake = (rel, exports) => {
  const file = require.resolve(path.join(__dirname, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

const world = { plans: [], drafts: {}, markers: new Set(), config: {}, sent: [], links: [], vouchers: [], tags: {}, mf: {}, claimed: new Set() };
const reset = () => Object.assign(world, { plans: [], drafts: {}, markers: new Set(), config: {}, sent: [], links: [], vouchers: [], tags: {}, mf: {}, claimed: new Set() });

fake('./store.js', {
  listPlansByStatus: async (s) => world.plans.filter(p => p.status === s),
  getPlanByDraft: async (id) => world.plans.find(p => p.draft_order_id === String(id)) || null,
  syncContact: async () => {},
  updatePlan: async (id, patch) => Object.assign(world.plans.find(p => p.id === id), patch),
  wasSent: async (id, k, a, kind) => world.markers.has(`${id}|${k}|${a}|${kind}`),
  markSent: async (id, k, a, kind) => { world.markers.add(`${id}|${k}|${a}|${kind}`); },
  getConfigValue: async (k) => world.config[k] ?? null,
  setConfigValue: async (k, v) => { world.config[k] = v; },
});
const log = (s) => async () => { world.sent.push(s); };
fake('./notify.js', {
  sendStarted: log('started'),
  sendDue: async (plan, d, st, link, o) => world.sent.push(`${o.overdue ? 'overdue' : 'due'}#${o.k}:${link.amount}`),
  sendGraceWarning: async (plan, d, st, link, o) => world.sent.push(`grace${o.days}${o.earlyNow ? `:early${o.earlyNow.value}` : ''}`),
  sendReceived: async (plan, d, st, amount) => world.sent.push(`received:${amount}`),
  sendEarlyOpen: async (plan, d, st) => world.sent.push(`early:${st.redeem.pct}:${st.redeem.value}`),
  sendFullyPaid: async (plan, d, st) => world.sent.push(`fullypaid:${st.redeem.value}`),
  sendTerminated: async (plan, d, st) => world.sent.push(`terminated:${st.paid}`),
  sendVoucherIssued: async (plan, d, v) => world.sent.push(`voucher:${v.code}:${v.value}`),
  toStore: async (plan, d, o) => world.sent.push(`store:${o.subject}`),
  sendDigest: async (rows) => world.sent.push(`digest:${rows.length}`),
  whatsappToCustomer: () => 'https://wa.me/x',
});
const links = require.resolve('../buy-plan/links');
require.cache[links] = { id: links, filename: links, loaded: true, exports: {
  createPlanLink: async (plan, amount, o) => { world.links.push(`${amount}:${o.installmentType}`); return { shortUrl: 'https://pay', amount }; },
  cancelOpenLinks: async () => { world.sent.push('links-cancelled'); },
} };
fake('./voucher.js', { issueSavingsVoucher: async ({ paid, bonus }) => {
  const v = { code: `SSV27-KAHSR-000${world.vouchers.length + 1}`, value: paid + bonus, paid, bonus, validUntil: '2027-11-12' };
  world.vouchers.push(v);
  return v;
} });
const supa = require.resolve('../../../core/supabase');
// end.js claims a plan with update().eq().is('voucher_code', null).select(); this fake does just that.
require.cache[supa] = { id: supa, filename: supa, loaded: true, exports: { supabase: { from: () => {
  let id;
  const q = {
    update: () => q, eq: (col, v) => { if (col === 'id') id = v; return q; },
    is: () => q,
    select: async () => {
      const plan = world.plans.find(p => p.id === id);
      if (!plan || plan.voucher_code || world.claimed.has(id)) return { data: [] };
      world.claimed.add(id); plan.voucher_code = 'ISSUING';
      return { data: [{ id }] };
    },
  };
  return q;
} } } };
const realDraft = require('./draft');
fake('./draft.js', { ...realDraft,
  readDraft: async (id) => world.drafts[id] || null,
  writeTags: async (d, tags) => { d.tags = tags; world.tags[d.id] = tags; },
  writeMetafields: async (d, fields) => { world.mf[d.id] = { ...(world.mf[d.id] || {}), ...fields }; },
});

const R = require('./rules');
const { runSavingsSweep } = require('./sweep');
const { issueVoucher, choices } = require('./end');

let n = 0;
const t = async (name, fn) => { reset(); await fn(); n++; console.log('  ok  ' + name); };
const at = (iso) => Date.parse(`${iso}T06:00:00Z`);   // 11:30 IST
const START = '2026-11-12';
const D = R.dueDates(START, 10);

function setup({ months = 10, legs = [], status = 'active', acknowledged = null } = {}) {
  const plan = { id: 1, draft_order_id: '900', draft_name: '#D900', customer_name: 'Asha', customer_phone: '9800000000',
    customer_email: 'a@x', customer_id: '55', months, instalment: 2000, total: 2000 * months, start_date: START,
    due_dates: R.dueDates(START, months), status,
    acknowledged_paid: acknowledged ?? legs.reduce((s, l) => s + l.value, 0) };
  world.plans.push(plan);
  world.drafts['900'] = { id: '900', draft: { name: '#D900', status: 'open', line_items: [{ title: 'Savings Plan', price: String(2000 * months), quantity: 1 }] },
    customer: { id: '55' }, mf: {}, legs, tags: ['savings-plan', 'savings-in-progress'] };
  return plan;
}
const paid = (k, late = 0) => D.slice(0, k).map((d, i) => ({ value: 2000, date: R.addDays(d, i < late ? 3 : 0), slot: i + 1 }));

(async () => {
  console.log('reminders');
  await t('3 days before a due date: one link for the instalment, labelled savings_plan', async () => {
    setup({ legs: paid(1) });
    await runSavingsSweep({ now: at(R.addDays(D[1], -3)) });
    await runSavingsSweep({ now: at(R.addDays(D[1], -2)) });
    assert.deepStrictEqual(world.sent.filter(s => s.startsWith('due')), ['due#2:2000']);
    assert.deepStrictEqual(world.links, ['2000:savings_plan']);
  });
  await t('3 days overdue: one overdue reminder, and the plan is on the digest', async () => {
    setup({ legs: paid(1) });
    await runSavingsSweep({ now: at(R.addDays(D[1], 3)) });
    assert.ok(world.sent.includes('overdue#2:2000'));
    assert.ok(world.sent.some(s => s.startsWith('digest:')));
  });
  await t('a payment since the last run is confirmed once', async () => {
    setup({ legs: paid(2), acknowledged: 2000 });
    await runSavingsSweep({ now: at(D[1]) });
    await runSavingsSweep({ now: at(R.addDays(D[1], 1)) });
    assert.deepStrictEqual(world.sent.filter(s => s.startsWith('received')), ['received:2000']);
  });

  console.log('grace and termination');
  await t('day 15 and day 25 warnings, each once', async () => {
    setup({ legs: paid(3) });
    for (const day of [15, 16, 25, 26]) await runSavingsSweep({ now: at(R.addDays(D[3], day)) });
    assert.deepStrictEqual(world.sent.filter(s => s.startsWith('grace')), ['grace15', 'grace25']);
  });
  await t('a warning on an early-redemption step tells the customer what redeeming now pays', async () => {
    setup({ legs: paid(7) });
    await runSavingsSweep({ now: at(R.addDays(D[7], 15)) });
    assert.ok(world.sent.includes('grace15:early15000'));
  });
  await t('day 31: terminated, links cancelled, draft tagged, store told; no voucher yet', async () => {
    const plan = setup({ legs: paid(4) });
    await runSavingsSweep({ now: at(R.addDays(D[4], 31)) });
    assert.strictEqual(plan.status, 'terminated');
    assert.ok(world.sent.includes('terminated:8000') && world.sent.includes('links-cancelled'));
    assert.ok(world.tags['900'].includes('savings-terminated') && !world.tags['900'].includes('savings-in-progress'));
    assert.strictEqual(world.vouchers.length, 0);
  });

  console.log('early redemption and full payment');
  await t('a 10-month plan reaching month 6 with 5 paid is told it can redeem early, once', async () => {
    setup({ legs: paid(5) });
    await runSavingsSweep({ now: at(D[5]) });
    await runSavingsSweep({ now: at(R.addDays(D[5], 1)) });
    assert.deepStrictEqual(world.sent.filter(s => s.startsWith('early')), ['early:25:10500']);
  });
  await t('fully paid: the customer and the store are told once, and no more links go out', async () => {
    setup({ legs: [{ value: 20000, date: START, slot: 1 }] });
    await runSavingsSweep({ now: at(START) });
    await runSavingsSweep({ now: at(R.addDays(START, 1)) });
    assert.deepStrictEqual(world.sent.filter(s => s.startsWith('fullypaid') || s.startsWith('store:')), ['fullypaid:22000', 'store:fully paid — issue the voucher']);
    assert.strictEqual(world.links.length, 0);
  });

  console.log('issuing the voucher');
  await t('full: Rs22,000 voucher, plan completed, outcome written to the draft (bonus never a payment)', async () => {
    const plan = setup({ legs: paid(10) });
    const d = world.drafts['900'];
    const r = await issueVoucher(plan, d, R.savingsState(plan, d.legs, D[9]), { how: 'full', today: D[9] });
    assert.strictEqual(r.voucher.value, 22000);
    assert.deepStrictEqual([plan.status, plan.bonus, plan.paid_at_end, plan.voucher_code], ['completed', 2000, 20000, 'SSV27-KAHSR-0001']);
    assert.ok(world.tags['900'].includes('savings-completed') && world.tags['900'].includes('ssv:SSV27-KAHSR-0001') && world.tags['900'].includes('ssv-bonus:rs2000'));
    assert.deepStrictEqual([world.mf['900'].savings_bonus, world.mf['900'].savings_voucher_value], ['2000', '22000']);
    assert.strictEqual(d.legs.length, 10);   // nothing added to the payment slots
  });
  await t('a second press finds the voucher issued', async () => {
    const plan = setup({ legs: paid(10) });
    const d = world.drafts['900'];
    await issueVoucher(plan, d, R.savingsState(plan, d.legs, D[9]), { how: 'full', today: D[9] });
    await assert.rejects(issueVoucher(plan, d, R.savingsState(plan, d.legs, D[9]), { how: 'full', today: D[9] }), /already issued/);
    assert.strictEqual(world.vouchers.length, 1);
  });
  await t('early at month 8 with 7 paid: Rs15,000', async () => {
    const plan = setup({ legs: paid(7) });
    const d = world.drafts['900'];
    const r = await issueVoucher(plan, d, R.savingsState(plan, d.legs, D[7]), { how: 'early', today: D[7] });
    assert.deepStrictEqual([r.voucher.value, plan.status, plan.end_kind], [15000, 'completed', 'early']);
  });
  await t('early is refused before month 6', async () => {
    const plan = setup({ legs: paid(5) });
    const d = world.drafts['900'];
    await assert.rejects(issueVoucher(plan, d, R.savingsState(plan, d.legs, D[4]), { how: 'early', today: D[4] }), /month 6/);
    assert.strictEqual(plan.voucher_code, undefined);
  });
  await t('customer stops: the money paid, no bonus, plan terminated', async () => {
    const plan = setup({ legs: paid(6) });
    const d = world.drafts['900'];
    const r = await issueVoucher(plan, d, R.savingsState(plan, d.legs, D[6]), { how: 'stopped', today: D[6] });
    assert.deepStrictEqual([r.voucher.value, r.voucher.bonus, plan.status], [12000, 0, 'terminated']);
  });
  await t('a terminated plan can only issue the no-bonus voucher', async () => {
    const plan = setup({ legs: paid(7), status: 'terminated' });
    const d = world.drafts['900'];
    const st = R.savingsState(plan, d.legs, R.addDays(D[7], 40));
    assert.deepStrictEqual(choices(plan, st).map(c => [c.how, c.value]), [['terminated', 14000]]);
    await assert.rejects(issueVoucher(plan, d, st, { how: 'early', today: R.addDays(D[7], 40) }), /closed/);
    const r = await issueVoucher(plan, d, st, { how: 'terminated', today: R.addDays(D[7], 40) });
    assert.strictEqual(r.voucher.value, 14000);
  });
  await t('choices on a running plan: what staff can press', async () => {
    const plan = setup({ legs: paid(7) });
    const d = world.drafts['900'];
    assert.deepStrictEqual(choices(plan, R.savingsState(plan, d.legs, D[7])).map(c => c.how), ['early', 'stopped']);
  });

  console.log('the draft');
  await t('a converted savings draft is reported to the store, once', async () => {
    setup({ legs: paid(2) });
    world.drafts['900'].draft.status = 'completed';
    await runSavingsSweep({ now: at(D[2]) });
    await runSavingsSweep({ now: at(R.addDays(D[2], 1)) });
    assert.deepStrictEqual(world.sent.filter(s => s.startsWith('store:')), ['store:the draft was converted to an order']);
  });

  console.log('tracker sheet');
  await t('a sheet row: saved, paid count, late, status, close date', async () => {
    const { rowFor, COLUMNS } = require('./sheet');
    const plan = setup({ legs: paid(3, 1) });
    const row = rowFor(plan, world.drafts['900'].legs, R.addDays(D[3], 5));
    const at = (c) => row[COLUMNS.indexOf(c)];
    assert.strictEqual(row.length, COLUMNS.length);
    assert.deepStrictEqual([at('Saved'), at('Instalments paid'), at('Late payments'), at('Status'), at('Closes on')],
      [6000, 3, 1, 'Late 5 days', R.addDays(D[3], 31)]);
  });
  await t('an ended plan shows its voucher and the figures it ended on', async () => {
    const { rowFor, COLUMNS } = require('./sheet');
    const plan = setup({ status: 'completed' });
    Object.assign(plan, { paid_at_end: 20000, late_count: 0, voucher_code: 'SSV27-KAHSR-0001', voucher_value: 22000 });
    const row = rowFor(plan, [], D[9]);
    const at = (c) => row[COLUMNS.indexOf(c)];
    assert.deepStrictEqual([at('Saved'), at('Status'), at('Voucher')], [20000, 'Completed (voucher issued)', 'SSV27-KAHSR-0001 (Rs22000)']);
  });

  console.log(`\n${n} savings-plan sweep tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
