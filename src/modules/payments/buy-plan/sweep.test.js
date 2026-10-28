process.env.SUPABASE_URL         ||= 'https://buy-plan-test.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL    ||= 'https://buy-plan-test.invalid';

const assert = require('assert');
const path = require('path');

// Replace the sweep's I/O (Supabase, Shopify, email, GoKwik) with in-memory fakes, then load it.
const fake = (rel, exports) => {
  const file = require.resolve(path.join(__dirname, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

const world = { plans: [], drafts: {}, markers: new Set(), config: {}, sent: [], links: [], repriced: [] };
fake('./store.js', {
  listActivePlans: async () => world.plans.filter(p => p.status === 'active'),
  updatePlan: async (id, patch) => Object.assign(world.plans.find(p => p.id === id), patch),
  getPlan: async (id) => world.plans.find(p => p.id === id) || null,
  wasSent: async (id, k, a, kind) => world.markers.has(`${id}|${k}|${a}|${kind}`),
  markSent: async (id, k, a, kind) => { world.markers.add(`${id}|${k}|${a}|${kind}`); },
  getConfigValue: async (k) => world.config[k] ?? null,
  setConfigValue: async (k, v) => { world.config[k] = v; },
});
fake('./notify.js', {
  sendLink: async (plan, d, link, o = {}) => world.sent.push(`${o.overdue ? 'overdue' : 'due'}:${link.amount}`),
  sendReceived: async () => world.sent.push('received'),
  sendCompleted: async () => world.sent.push('completed'),
  sendStaffDigest: async (rows) => world.sent.push(`digest:${rows.length}`),
  sendFinalNotice: async (plan, d, est) => world.sent.push(`final-notice:${est}`),
  sendFinalPrice: async (plan, d, link) => world.sent.push(`final-price:${plan.final_total}:${link ? link.amount : 'none'}`),
  sendFinalCredit: async (plan, d, credit) => world.sent.push(`credit:${credit}`),
});
fake('./final.js', {
  estimateFinal: async () => 125000,
  startFinalReprice: async (plan, d) => { world.repriced.push(d.id); d.tags.push('buy-plan-final', 'reprice'); return []; },
  finalRepriceDone: (tags) => tags.includes('rate-locked') && !tags.includes('buy-plan-final'),
});
fake('./links.js', { createPlanLink: async (plan, amount) => { world.links.push(amount); return { shortUrl: 'https://pay', amount }; } });
const realDraft = require('./draft');
fake('./draft.js', { ...realDraft, readDraft: async (id) => world.drafts[id] || null });

const { runBuyPlanSweep } = require('./sweep');
const S = require('./schedule');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };
const at = (iso) => Date.parse(`${iso}T06:00:00Z`);   // 11:30 IST

function reset({ legs = [], status = 'open', mode, tags = ['buy-plan', 'rate-locked'] } = {}) {
  world.plans = [{ id: 1, draft_order_id: '100', draft_name: '#D300', total: 120000, status: 'active',
    customer_name: 'Asha', customer_phone: '9830000000', customer_email: 'a@b.in',
    start_date: '2026-10-24', due_dates: S.dueDates('2026-10-24'), mode, final_total: null }];
  world.drafts = { 100: { id: '100', draft: { name: '#D300', status, line_items: [] }, mf: {}, tags: [...tags], customer: {}, total: 120000, legs } };
  world.markers = new Set(); world.config = {}; world.sent = []; world.links = []; world.repriced = [];
}
const five = [1, 2, 3, 4, 5].map(() => ({ value: 20000, date: '2026-10-24' }));
const markReceived = (upTo) => { for (let k = 1; k <= upTo; k++) world.markers.add(`1|${k}|customer|received`); };

(async () => {
  console.log('runBuyPlanSweep');

  await t('day of signup: nothing for installment 1 (it is paid at the counter), no digest', async () => {
    reset();
    await runBuyPlanSweep({ now: at('2026-10-24') });
    assert.deepStrictEqual(world.sent, []);
  });

  await t('installment 1 unpaid 3 days later: overdue reminder + digest', async () => {
    reset();
    await runBuyPlanSweep({ now: at('2026-10-27') });
    assert.deepStrictEqual(world.sent, ['overdue:20000', 'digest:1']);
  });

  await t('paid installment 1: "received" once, then nothing until 3 days before installment 2', async () => {
    reset({ legs: [{ value: 20000, date: '2026-10-24' }] });
    await runBuyPlanSweep({ now: at('2026-10-25') });
    await runBuyPlanSweep({ now: at('2026-10-26') });
    await runBuyPlanSweep({ now: at('2026-11-20') });
    assert.deepStrictEqual(world.sent, ['received']);
  });

  await t('3 days before installment 2: one due reminder with a link for the amount due, one digest', async () => {
    reset({ legs: [{ value: 20000, date: '2026-10-24' }] });
    world.markers.add('1|1|customer|received');
    await runBuyPlanSweep({ now: at('2026-11-21') });
    await runBuyPlanSweep({ now: at('2026-11-21') });   // a second run the same day sends nothing
    assert.deepStrictEqual(world.sent, ['due:20000', 'digest:1']);
    assert.deepStrictEqual(world.links, [20000]);
  });

  await t('after a Rs40,000 overpayment the next reminder asks for the recalculated Rs16,000', async () => {
    reset({ legs: [{ value: 40000, date: '2026-10-24' }] });
    world.markers.add('1|1|customer|received');
    await runBuyPlanSweep({ now: at('2026-11-22') });
    assert.deepStrictEqual(world.sent, ['due:16000', 'digest:1']);
  });

  await t('the digest goes once a day even if the sweep runs four times', async () => {
    reset({ legs: [{ value: 20000, date: '2026-10-24' }] });
    world.markers.add('1|1|customer|received');
    for (let i = 0; i < 4; i++) await runBuyPlanSweep({ now: at('2026-11-23') });
    assert.strictEqual(world.sent.filter(s => s.startsWith('digest')).length, 1);
  });

  await t('converted draft: plan completed, "plan complete" once', async () => {
    reset({ status: 'completed', legs: [{ value: 120000, date: '2026-10-24' }] });
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

  await t('equal plan: 3 days before installment 6, a notice with the estimate and no link', async () => {
    reset({ mode: 'equal', legs: five, tags: ['buy-plan'] }); markReceived(5);
    await runBuyPlanSweep({ now: at('2027-03-21') });
    await runBuyPlanSweep({ now: at('2027-03-22') });
    assert.deepStrictEqual(world.sent.filter(x => !x.startsWith('digest')), ['final-notice:125000']);
    assert.deepStrictEqual(world.links, []);
  });

  await t('equal plan: on the date of installment 6 the draft is repriced, once', async () => {
    reset({ mode: 'equal', legs: five, tags: ['buy-plan'] }); markReceived(5);
    world.markers.add('1|6|customer|final_notice');
    await runBuyPlanSweep({ now: at('2027-03-24') });
    await runBuyPlanSweep({ now: at('2027-03-24') });
    assert.deepStrictEqual(world.repriced, ['100']);
    assert.strictEqual(world.plans[0].final_total, null);
  });

  await t('equal plan: once repriced, the new price is final and the link is for the rest', async () => {
    reset({ mode: 'equal', legs: five, tags: ['buy-plan', 'rate-locked'] }); markReceived(5);
    world.markers.add('1|6|customer|final_notice'); world.markers.add('1|6|staff|final_reprice');
    world.drafts[100].total = 126000;
    await runBuyPlanSweep({ now: at('2027-03-24') });
    assert.strictEqual(world.plans[0].final_total, 126000);
    assert.deepStrictEqual(world.sent, ['final-price:126000:26000']);
    await runBuyPlanSweep({ now: at('2027-03-25') });
    assert.deepStrictEqual(world.links, [26000]);   // no second link for installment 6
  });

  await t('equal plan: gold fell below what was paid, so the store is alerted to settle a credit', async () => {
    reset({ mode: 'equal', legs: [{ value: 120000, date: '2026-10-24' }], tags: ['buy-plan', 'rate-locked'] }); markReceived(6);
    world.markers.add('1|6|customer|final_notice'); world.markers.add('1|6|staff|final_reprice');
    world.drafts[100].total = 112000;
    await runBuyPlanSweep({ now: at('2027-03-24') });
    assert.deepStrictEqual(world.sent, ['final-price:112000:none', 'credit:8000']);
  });

  await t('equal plan: a reprice that never finished reaches the staff digest', async () => {
    reset({ mode: 'equal', legs: five, tags: ['buy-plan', 'buy-plan-final', 'reprice'] }); markReceived(5);
    world.markers.add('1|6|customer|final_notice'); world.markers.add('1|6|staff|final_reprice');
    await runBuyPlanSweep({ now: at('2027-03-25') });
    assert.deepStrictEqual(world.sent, ['digest:1']);
  });

  console.log(`\n${n} passed`);
})().catch(e => { console.error(e); process.exit(1); });
