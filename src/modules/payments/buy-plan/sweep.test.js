process.env.SUPABASE_URL         ||= 'https://buy-plan-test.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL    ||= 'https://buy-plan-test.invalid';

const assert = require('assert');
const path = require('path');

// Replace the sweep's I/O (Supabase, Shopify, email, GoKwik, vouchers) with in-memory fakes, then load it.
const fake = (rel, exports) => {
  const file = require.resolve(path.join(__dirname, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

const world = { plans: [], drafts: {}, markers: new Set(), config: {}, sent: [], links: [], repriced: [], vouchers: [], written: [], openLink: null };
fake('./store.js', {
  latestOpenLink: async () => world.openLink,
  listActivePlans: async () => world.plans.filter(p => p.status === 'active'),
  updatePlan: async (id, patch) => Object.assign(world.plans.find(p => p.id === id), patch),
  getPlan: async (id) => world.plans.find(p => p.id === id) || null,
  wasSent: async (id, k, a, kind) => world.markers.has(`${id}|${k}|${a}|${kind}`),
  markSent: async (id, k, a, kind) => { world.markers.add(`${id}|${k}|${a}|${kind}`); },
  getConfigValue: async (k) => world.config[k] ?? null,
  setConfigValue: async (k, v) => { world.config[k] = v; },
});
fake('./notify.js', {
  sendLink: async (plan, d, link, o = {}) => world.sent.push(`${o.relink ? 'relink:' : ''}${o.overdue ? 'overdue' : 'due'}#${o.k}:${link.amount}`),
  sendPricePutBack: async (plan, d, fixes, error) => world.sent.push(`put-back:${fixes.map(f => f.to).join(',')}${error ? ':failed' : ''}`),
  sendReceived: async (plan, d, amount) => world.sent.push(`received:${amount}`),
  sendCompleted: async () => world.sent.push('completed'),
  sendStaffDigest: async (rows) => world.sent.push(`digest:${rows.length}`),
  sendFinalPrice: async (plan, d, link) => world.sent.push(`final-price:${plan.final_total}:${link ? link.amount : 'none'}`),
  sendFinalCredit: async (plan, d, credit) => world.sent.push(`credit:${credit}`),
  sendClosingSoon: async (plan, d, link, o) => world.sent.push(`closing:${o.closeOn}`),
  sendChanged: async (plan, d, o) => world.sent.push(`changed:${o.oldTotal}->${o.newTotal}${o.voucher ? ':' + o.voucher.code : ''}`),
  sendLinesChanged: async () => world.sent.push('lines-changed'),
  sendForfeited: async () => world.sent.push('forfeit-alert'),
});
fake('./final.js', {
  startFinalReprice: async (plan, d) => { world.repriced.push(d.id); d.tags.push('rate-locked', 'sync-payment'); return { rates: [], changes: [], skipped: [] }; },
  finalRepriceDone: (tags) => tags.includes('rate-locked') && !tags.includes('buy-plan-final') && !tags.includes('sync-payment'),
  changeRepriceDone: (tags) => !tags.includes('buy-plan-change') && !tags.includes('reprice'),
});
fake('./links.js', { createPlanLink: async (plan, amount) => { world.links.push(amount); return { shortUrl: 'https://pay', amount }; } });
fake('./forfeit.js', { forfeitPlan: async (plan, d, st, today, reason) => {
  plan.status = 'forfeited'; world.sent.push(`forfeit:${st.paid}:${reason}`); return { voucher: { code: 'VCH-1' } };
} });
fake('./voucher.js', { issuePlanVoucher: async ({ value }) => { world.vouchers.push(value); return { code: 'VCH-2', value, validUntil: '2027-11-25' }; } });
const metafields = require.resolve('../../../core/metafields');
require.cache[metafields] = { id: metafields, filename: metafields, loaded: true, exports: { updateDraftOrderMetafields: async () => {} } };
const realDraft = require('./draft');
fake('./draft.js', { ...realDraft, readDraft: async (id) => world.drafts[id] || null,
  writeDraftLines: async (id, lines, o = {}) => {
    if (world.writeFails) throw new Error('Shopify said no');
    world.written.push({ id, lines, tags: o.tags });
  } });

const { runBuyPlanSweep } = require('./sweep');
const S = require('./schedule');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };
const at = (iso) => Date.parse(`${iso}T06:00:00Z`);   // 11:30 IST
const START = '2026-10-24';
const D = S.dueDates(START);   // 24 Oct, 24 Nov, 24 Dec, 24 Jan, 24 Feb, 24 Mar
const ring = { title: 'Ring', variant_id: 7, quantity: 1, price: '1', properties: [] };

function reset({ legs = [], status = 'open', mode = 'gold', tags = ['buy-plan', 'rate-locked'], over = {}, lines = [ring] } = {}) {
  world.plans = [{ id: 1, draft_order_id: '100', draft_name: '#D300', total: 120000, status: 'active',
    customer_name: 'Asha', customer_phone: '9830000000', customer_email: 'a@b.in', installments: 6,
    start_date: START, due_dates: D, mode, gold_value: null, final_total: null, price_changes: [],
    acknowledged_paid: legs.reduce((s, l) => s + l.value, 0), lines_key: realDraft.linesKey([ring]), ...over }];
  world.drafts = { 100: { id: '100', draft: { name: '#D300', status, line_items: lines }, mf: {}, tags: [...tags], customer: {}, total: 120000, legs } };
  world.markers = new Set(); world.config = {}; world.sent = []; world.links = []; world.repriced = []; world.vouchers = [];
  world.written = []; world.openLink = null; world.writeFails = false;
}
const paid = (date, value) => ({ value, date });
const five = D.slice(0, 5).map(d => paid(d, 20000));

(async () => {
  console.log('runBuyPlanSweep');

  await t('day of signup, installment 1 not yet paid: nothing', async () => {
    reset();
    await runBuyPlanSweep({ now: at(START) });
    assert.deepStrictEqual(world.sent, []);
  });

  await t('installment 1 unpaid 3 days later: overdue reminder + digest', async () => {
    reset();
    await runBuyPlanSweep({ now: at('2026-10-27') });
    assert.deepStrictEqual(world.sent, ['overdue#1:20000', 'digest:1']);
  });

  await t('a payment after the start: "received" once, then nothing until 3 days before installment 2', async () => {
    reset();
    world.drafts[100].legs = [paid('2026-10-25', 20000)];
    await runBuyPlanSweep({ now: at('2026-10-25') });
    await runBuyPlanSweep({ now: at('2026-10-26') });
    await runBuyPlanSweep({ now: at('2026-11-20') });
    assert.deepStrictEqual(world.sent, ['received:20000']);
  });

  await t('3 days before installment 2: one reminder for what it asks, one digest', async () => {
    reset({ legs: [paid(START, 20000)] });
    await runBuyPlanSweep({ now: at('2026-11-21') });
    await runBuyPlanSweep({ now: at('2026-11-21') });
    assert.deepStrictEqual(world.sent, ['due#2:20000', 'digest:1']);
  });

  await t('after a Rs40,000 payment the next reminder asks for the re-spread Rs16,000', async () => {
    reset({ legs: [paid(START, 40000)] });
    await runBuyPlanSweep({ now: at('2026-11-22') });
    assert.deepStrictEqual(world.sent, ['due#2:16000', 'digest:1']);
  });

  await t('installment 1 missed: the reminder for installment 2 asks for both', async () => {
    reset();
    world.markers.add('1|1|customer|overdue');
    await runBuyPlanSweep({ now: at('2026-11-21') });
    assert.deepStrictEqual(world.sent.filter(s => !s.startsWith('digest')), ['due#2:40000']);
  });

  await t('the digest goes once a day even if the sweep runs four times', async () => {
    reset({ legs: [paid(START, 20000)] });
    for (let i = 0; i < 4; i++) await runBuyPlanSweep({ now: at('2026-11-23') });
    assert.strictEqual(world.sent.filter(s => s.startsWith('digest')).length, 1);
  });

  await t('30 days with nothing paid since installment 2 fell due: one warning with the close date', async () => {
    reset({ legs: [paid(START, 20000)] });
    world.markers.add('1|2|customer|due'); world.markers.add('1|2|customer|overdue');
    await runBuyPlanSweep({ now: at('2026-12-24') });
    await runBuyPlanSweep({ now: at('2026-12-25') });
    assert.deepStrictEqual(world.sent.filter(s => s.startsWith('closing')), ['closing:2027-01-23']);
  });

  await t('60 days: the plan closes and the money paid becomes a voucher', async () => {
    reset({ legs: [paid(START, 20000)] });
    await runBuyPlanSweep({ now: at('2027-01-23'), dryRun: true });
    assert.strictEqual(world.plans[0].status, 'active');
    await runBuyPlanSweep({ now: at('2027-01-23') });
    assert.ok(world.sent.includes('forfeit:20000:no payment for 60 days'));
    assert.strictEqual(world.plans[0].status, 'forfeited');
  });

  await t('converted draft: plan completed, "plan complete" once', async () => {
    reset({ status: 'completed', legs: [paid(START, 120000)] });
    await runBuyPlanSweep({ now: at('2026-10-30') });
    assert.strictEqual(world.plans[0].status, 'completed');
    assert.deepStrictEqual(world.sent, ['completed']);
  });

  await t('deleted draft: the restore hook is called', async () => {
    reset();
    delete world.drafts[100];
    let restored = null;
    await runBuyPlanSweep({ now: at('2026-10-30'), restore: async (id) => { restored = id; } });
    assert.strictEqual(restored, '100');
  });

  await t('dryRun sends nothing and records nothing', async () => {
    reset();
    const r = await runBuyPlanSweep({ now: at('2026-10-27'), dryRun: true });
    assert.deepStrictEqual(world.sent, []);
    assert.strictEqual(world.markers.size, 0);
    assert.strictEqual(r.digestRows.length, 1);
  });

  await t('pieces changed without "Change product": one alert to the store, and the restore copy keeps the plan\'s pieces', async () => {
    const other = { ...ring, variant_id: 99 };
    reset({ legs: [paid(START, 20000)], lines: [other], over: { snapshot: { line_items: [ring] } } });
    await runBuyPlanSweep({ now: at('2026-11-01') });
    await runBuyPlanSweep({ now: at('2026-11-02') });
    assert.deepStrictEqual(world.sent.filter(s => s === 'lines-changed'), ['lines-changed']);
    assert.strictEqual(world.plans[0].snapshot.line_items[0].variant_id, 7);
  });

  await t('two issues on one plan both reach the digest', async () => {
    const other = { ...ring, variant_id: 99 };
    reset({ lines: [other], over: { snapshot: { line_items: [ring] } } });
    await runBuyPlanSweep({ now: at('2026-10-27') });   // pieces changed AND installment 1 overdue
    assert.ok(world.sent.includes('digest:2'));
  });

  console.log('a re-added piece keeps its locked price');
  const locked = { ...ring, price: '120000.00', properties: [{ name: 'Gold', value: 'Rs80000.00' }, { name: '_gold_rate', value: '10000' }, { name: '_jewel_code', value: 'R1' }] };
  const readded = { ...ring, price: '150000.00', properties: [] };

  await t('re-added at the catalog price: the plan line is put back, the restore copy keeps it, the store is told', async () => {
    reset({ legs: [paid(START, 20000)], lines: [readded], over: { snapshot: { line_items: [locked] } } });
    const r = await runBuyPlanSweep({ now: at('2026-11-01') });
    assert.strictEqual(world.written.length, 1);
    assert.strictEqual(world.written[0].lines[0].price, '120000.00');
    assert.deepStrictEqual(world.written[0].lines[0].properties, locked.properties);
    assert.ok(world.written[0].tags.includes('sync-payment'));
    assert.ok(world.written[0].tags.includes('rate-locked'));
    assert.strictEqual(world.plans[0].snapshot.line_items[0].price, '120000.00');
    assert.deepStrictEqual(world.sent, ['put-back:120000', 'digest:1']);
    assert.match(r.plans[0].sent.join(), /put back Ring at Rs120000/);
  });

  await t('at the plan price already: nothing is written', async () => {
    reset({ legs: [paid(START, 20000)], lines: [locked], over: { snapshot: { line_items: [locked] } } });
    await runBuyPlanSweep({ now: at('2026-11-01') });
    assert.deepStrictEqual(world.written, []);
    assert.deepStrictEqual(world.sent, []);
  });

  await t('not while a reprice is on the draft, and not on a dry run', async () => {
    reset({ legs: [paid(START, 20000)], lines: [readded], tags: ['buy-plan', 'rate-locked', 'reprice'], over: { snapshot: { line_items: [locked] } } });
    await runBuyPlanSweep({ now: at('2026-11-01') });
    assert.deepStrictEqual(world.written, []);
    reset({ legs: [paid(START, 20000)], lines: [readded], over: { snapshot: { line_items: [locked] } } });
    const r = await runBuyPlanSweep({ now: at('2026-11-01'), dryRun: true });
    assert.deepStrictEqual(world.written, []);
    assert.strictEqual(r.digestRows.length, 1);
  });

  await t('the write fails: the store is told to fix it by hand, once, and the snapshot is not overwritten', async () => {
    reset({ legs: [paid(START, 20000)], lines: [readded], over: { snapshot: { line_items: [locked] } } });
    world.writeFails = true;
    await runBuyPlanSweep({ now: at('2026-11-01') });
    await runBuyPlanSweep({ now: at('2026-11-02') });
    assert.deepStrictEqual(world.sent.filter(s => s.startsWith('put-back')), ['put-back:120000:failed']);
    assert.strictEqual(world.plans[0].snapshot.line_items[0].price, '120000.00');
  });

  console.log('a fresh link when the one held lapses');
  const overdue2 = () => {
    reset({ legs: [paid(START, 20000)] });
    world.markers.add('1|2|customer|due'); world.markers.add('1|2|customer|overdue');
  };

  await t('installment 2 overdue and its link lapses in 3 days: one new link, once', async () => {
    overdue2();
    world.openLink = { gokwik_link_id: 'L1', amount: 20000, expires_at: '2026-12-01T10:00:00Z' };
    await runBuyPlanSweep({ now: at('2026-11-28') });
    await runBuyPlanSweep({ now: at('2026-11-28') });
    assert.deepStrictEqual(world.sent.filter(s => !s.startsWith('digest')), ['relink:overdue#2:20000']);
    assert.deepStrictEqual(world.links, [20000]);
  });

  await t('an already-expired link is replaced too; a link with weeks left is not', async () => {
    overdue2();
    world.openLink = { gokwik_link_id: 'L1', amount: 20000, expires_at: '2026-11-20T10:00:00Z' };
    await runBuyPlanSweep({ now: at('2026-11-28') });
    assert.deepStrictEqual(world.links, [20000]);
    overdue2();
    world.openLink = { gokwik_link_id: 'L1', amount: 20000, expires_at: '2026-12-20T10:00:00Z' };
    await runBuyPlanSweep({ now: at('2026-11-28') });
    assert.deepStrictEqual(world.links, []);
  });

  await t('not when this pass already sent a link, nor on a dry run, nor with nothing due', async () => {
    reset({ legs: [paid(START, 20000)] });
    world.openLink = { gokwik_link_id: 'L1', amount: 20000, expires_at: '2026-11-22T10:00:00Z' };
    await runBuyPlanSweep({ now: at('2026-11-21') });   // the due#2 reminder carries a new link already
    assert.deepStrictEqual(world.links, [20000]);
    overdue2();
    world.openLink = { gokwik_link_id: 'L1', amount: 20000, expires_at: '2026-12-01T10:00:00Z' };
    await runBuyPlanSweep({ now: at('2026-11-28'), dryRun: true });
    assert.deepStrictEqual(world.links, []);
    reset({ legs: [paid(START, 20000)] });
    world.openLink = { gokwik_link_id: 'L1', amount: 20000, expires_at: '2026-11-05T10:00:00Z' };
    await runBuyPlanSweep({ now: at('2026-11-04') });   // installment 2 is three weeks off
    assert.deepStrictEqual(world.links, []);
  });

  console.log('equal plans: the final price');

  await t('3 days before the last installment the draft is repriced, once', async () => {
    reset({ mode: 'equal', legs: five, tags: ['buy-plan'] });
    await runBuyPlanSweep({ now: at('2027-03-21') });
    await runBuyPlanSweep({ now: at('2027-03-21') });
    assert.deepStrictEqual(world.repriced, ['100']);
    assert.strictEqual(world.plans[0].final_total, null);
  });

  await t('not before', async () => {
    reset({ mode: 'equal', legs: five, tags: ['buy-plan'] });
    await runBuyPlanSweep({ now: at('2027-03-20') });
    assert.deepStrictEqual(world.repriced, []);
  });

  await t('once repriced, the price is final and the link is for the rest, with no second reminder', async () => {
    reset({ mode: 'equal', legs: five, tags: ['buy-plan', 'rate-locked'] });
    world.markers.add('1|6|staff|final_reprice');
    world.drafts[100].total = 126000;
    await runBuyPlanSweep({ now: at('2027-03-21') });
    assert.strictEqual(world.plans[0].final_total, 126000);
    assert.deepStrictEqual(world.sent, ['final-price:126000:26000']);
    assert.ok(world.plans[0].snapshot, 'the final prices become the plan\'s snapshot');
    await runBuyPlanSweep({ now: at('2027-03-22') });
    assert.deepStrictEqual(world.links, [26000]);
  });

  await t('gold fell below what was paid: the store is alerted to settle a credit', async () => {
    reset({ mode: 'equal', legs: [paid(START, 120000)], tags: ['buy-plan', 'rate-locked'] });
    world.markers.add('1|6|staff|final_reprice');
    world.drafts[100].total = 112000;
    await runBuyPlanSweep({ now: at('2027-03-21') });
    assert.deepStrictEqual(world.sent, ['final-price:112000:none', 'credit:8000']);
  });

  await t('the final price waits until the recompute has consumed sync-payment', async () => {
    reset({ mode: 'equal', legs: five, tags: ['buy-plan', 'rate-locked', 'sync-payment'] });
    world.markers.add('1|6|staff|final_reprice');
    world.drafts[100].total = 126000;
    await runBuyPlanSweep({ now: at('2027-03-21') });
    assert.strictEqual(world.plans[0].final_total, null);
    assert.deepStrictEqual(world.sent, ['digest:1']);
  });

  await t('a reprice that never finished reaches the staff digest', async () => {
    reset({ mode: 'equal', legs: five, tags: ['buy-plan', 'buy-plan-final', 'reprice'] });
    world.markers.add('1|6|staff|final_reprice');
    await runBuyPlanSweep({ now: at('2027-03-22') });
    assert.deepStrictEqual(world.sent, ['digest:1']);
  });

  console.log('product change');

  await t('once its reprice has run: new price, new schedule email, plan re-spread', async () => {
    reset({ mode: 'equal', legs: [paid(START, 50000)], tags: ['buy-plan'],
      over: { change_pending: { started_at: new Date().toISOString(), old_total: 120000, lost_lock: true } } });
    world.drafts[100].total = 150000;
    await runBuyPlanSweep({ now: at('2026-11-01') });
    assert.ok(world.sent.includes('changed:120000->150000'));
    assert.strictEqual(world.plans[0].change_pending, null);
    assert.strictEqual(S.currentTotal(world.plans[0]), 150000);
  });

  await t('cheaper piece than already paid: the difference becomes a voucher', async () => {
    reset({ mode: 'equal', legs: [paid(START, 50000)], tags: ['buy-plan'],
      over: { change_pending: { started_at: new Date().toISOString(), old_total: 120000, lost_lock: false } } });
    world.drafts[100].total = 40000;
    await runBuyPlanSweep({ now: at('2026-11-01') });
    assert.deepStrictEqual(world.vouchers, [10000]);
    assert.ok(world.sent.includes('changed:120000->40000:VCH-2'));
  });

  await t('still repricing: wait, no messages', async () => {
    reset({ mode: 'equal', legs: [paid(START, 50000)], tags: ['buy-plan', 'buy-plan-change', 'reprice'],
      over: { change_pending: { started_at: new Date().toISOString(), old_total: 120000 } } });
    await runBuyPlanSweep({ now: at('2026-11-01') });
    assert.deepStrictEqual(world.sent, []);
  });

  console.log('single-plan run (draft=)');

  await t('runs only the named plan, by D number or draft id, and never sends the digest', async () => {
    reset();
    world.plans.push({ ...world.plans[0], id: 2, draft_order_id: '200', draft_name: '#D301' });
    world.drafts[200] = { ...world.drafts[100], id: '200', draft: { ...world.drafts[100].draft, name: '#D301' } };
    const r = await runBuyPlanSweep({ now: at('2026-10-27'), only: 'D300' });
    assert.deepStrictEqual(r.plans.map(p => p.plan), ['#D300']);
    assert.deepStrictEqual(world.sent, ['overdue#1:20000']);
    assert.strictEqual(world.config.buy_plan_digest_last, undefined);
    assert.strictEqual(r.digestRows.length, 1);
    const byId = await runBuyPlanSweep({ now: at('2026-10-27'), only: '200', dryRun: true });
    assert.deepStrictEqual(byId.plans.map(p => p.plan), ['#D301']);
  });

  await t('an unknown or inactive draft is refused, not a silent run of nothing', async () => {
    reset();
    await assert.rejects(runBuyPlanSweep({ now: at('2026-10-27'), only: '#D999' }), /No active buy plan/);
    world.plans[0].status = 'cancelled';
    await assert.rejects(runBuyPlanSweep({ now: at('2026-10-27'), only: 'D300' }), /No active buy plan/);
  });

  console.log(`\n${n} passed`);
})().catch(e => { console.error(e); process.exit(1); });
