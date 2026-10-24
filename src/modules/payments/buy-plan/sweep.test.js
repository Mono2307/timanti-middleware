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

const world = { plans: [], drafts: {}, markers: new Set(), config: {}, sent: [], links: [] };
fake('./store.js', {
  listActivePlans: async () => world.plans.filter(p => p.status === 'active'),
  updatePlan: async (id, patch) => Object.assign(world.plans.find(p => p.id === id), patch),
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
});
fake('./links.js', { createPlanLink: async (plan, amount) => { world.links.push(amount); return { shortUrl: 'https://pay', amount }; } });
const realDraft = require('./draft');
fake('./draft.js', { ...realDraft, readDraft: async (id) => world.drafts[id] || null });

const { runBuyPlanSweep } = require('./sweep');
const S = require('./schedule');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };
const at = (iso) => Date.parse(`${iso}T06:00:00Z`);   // 11:30 IST

function reset({ legs = [], status = 'open' } = {}) {
  world.plans = [{ id: 1, draft_order_id: '100', draft_name: '#D300', total: 120000, status: 'active',
    customer_name: 'Asha', customer_phone: '9830000000', customer_email: 'a@b.in',
    start_date: '2026-10-24', due_dates: S.dueDates('2026-10-24') }];
  world.drafts = { 100: { id: '100', draft: { name: '#D300', status, line_items: [] }, mf: {}, tags: ['buy-plan', 'rate-locked'], customer: {}, total: 120000, legs } };
  world.markers = new Set(); world.config = {}; world.sent = []; world.links = [];
}

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

  console.log(`\n${n} passed`);
})().catch(e => { console.error(e); process.exit(1); });
