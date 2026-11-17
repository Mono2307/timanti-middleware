process.env.SUPABASE_URL         ||= 'https://savings-plan-test.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL    ||= 'https://savings-plan-test.invalid';

const assert = require('assert');
const path = require('path');

// A deleted savings draft (restore.js): rebuilt when it held money, cancelled when it did not, and the
// store + HQ told once when it cannot be rebuilt. Supabase, GoKwik and email are in-memory fakes.
const fake = (rel, exports) => {
  const file = require.resolve(path.join(__dirname, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

const world = { updates: [], mails: [], cancelled: [], deposit: null };
const supa = require.resolve('../../../core/supabase');
require.cache[supa] = { id: supa, filename: supa, loaded: true, exports: { supabase: { from: (table) => {
  const q = {
    select: () => q, eq: () => q,
    maybeSingle: async () => ({ data: table === 'store_deposits' ? world.deposit : null }),
    update: (patch) => { world.updates.push({ table, patch }); return q; },
    then: (ok) => ok({ error: null }),
  };
  return q;
} } } };
const links = require.resolve('../buy-plan/links');
require.cache[links] = { id: links, filename: links, loaded: true, exports: {
  cancelOpenLinks: async (id) => { world.cancelled.push(id); },
} };
fake('./notify.js', { toHq: async (plan, o) => { world.mails.push(o.subject); } });
const cfg = require('../../../core/config');
cfg.config.savingsPlan.enabled = true;

const { restoreDeletedSavingsDraft, SAVINGS_RESTORE_KEYS } = require('./restore');

const markers = new Set();
const mkStore = (plan) => ({
  getPlanByDraft: async () => plan,
  updatePlan: async (id, patch) => Object.assign(plan, patch),
  wasSent: async (id, k, a, kind) => markers.has(`${id}|${k}|${a}|${kind}`),
  markSent: async (id, k, a, kind) => { markers.add(`${id}|${k}|${a}|${kind}`); },
});
const basePlan = (over = {}) => ({ id: 7, draft_order_id: '500', draft_name: '#D500', status: 'active', total: 10000, acknowledged_paid: 0, ...over });
const snap = (legs) => ({
  line_items: [{ title: 'Savings Plan', price: '10000.00', quantity: 1, taxable: false }],
  customer_id: '55', email: 'a@x', tags: ['savings-plan', 'savings-in-progress'],
  metafields: Object.fromEntries(legs.flatMap((v, i) => [[`installment_${i + 1}_value`, String(v)], [`installment_${i + 1}_date`, '2026-11-16']])
    .concat([['savings_months', '10'], ['installment_10_value', ''], ['loyalty_points', '50']])),
});

let n = 0;
const t = async (name, fn) => { Object.assign(world, { updates: [], mails: [], cancelled: [], deposit: null }); markers.clear(); await fn(); n++; console.log('  ok  ' + name); };

(async () => {
  console.log('deleted savings drafts');
  await t('nothing paid: the plan is cancelled quietly and gives up the draft id', async () => {
    const plan = basePlan();
    const r = await restoreDeletedSavingsDraft('500', { store: mkStore(plan) });
    assert.deepStrictEqual(r, { cancelled: true });
    assert.strictEqual(plan.status, 'cancelled');
    assert.strictEqual(plan.draft_order_id, '500-deleted-7');
    assert.deepStrictEqual(world.mails, []);
    assert.deepStrictEqual(world.cancelled, ['500']);
  });
  await t('money on it: rebuilt from the snapshot (line, payments, savings fields), store and HQ told', async () => {
    const plan = basePlan({ snapshot: snap([1000, 1000]) });
    let input = null;
    const graphql = async (q, v) => { input = v.input; return { draftOrderCreate: { draftOrder: { legacyResourceId: 501, name: '#D501' }, userErrors: [] } }; };
    const r = await restoreDeletedSavingsDraft('500', { store: mkStore(plan), graphql });
    assert.deepStrictEqual(r, { rebuilt: true, newId: '501', newName: '#D501', paid: 2000 });
    assert.strictEqual(plan.draft_order_id, '501');
    assert.strictEqual(plan.draft_name, '#D501');
    assert.strictEqual(input.lineItems[0].taxable, false);
    const keys = input.metafields.map(m => m.key).sort();
    assert.deepStrictEqual(keys, ['installment_1_date', 'installment_1_value', 'installment_2_date', 'installment_2_value', 'savings_months']);
    assert.strictEqual(input.purchasingEntity.customerId, 'gid://shopify/Customer/55');
    assert.deepStrictEqual(world.mails, ['the draft #D500 was deleted and restored as #D501']);
  });
  await t('money recorded only on the deposit row still counts as money', async () => {
    const plan = basePlan({ snapshot: snap([]) });
    world.deposit = { amount_paid: 3000 };
    const graphql = async () => ({ draftOrderCreate: { draftOrder: { legacyResourceId: 502, name: '#D502' }, userErrors: [] } });
    const r = await restoreDeletedSavingsDraft('500', { store: mkStore(plan), graphql });
    assert.strictEqual(r.paid, 3000);
    assert.strictEqual(r.rebuilt, true);
  });
  await t('money but no snapshot: store and HQ told once, the plan is left for HQ', async () => {
    const plan = basePlan({ acknowledged_paid: 4000 });
    const s = mkStore(plan);
    await restoreDeletedSavingsDraft('500', { store: s });
    const again = await restoreDeletedSavingsDraft('500', { store: s });
    assert.strictEqual(again.alreadyTold, true);
    assert.strictEqual(world.mails.length, 1);
    assert.match(world.mails[0], /Rs4,000 paid/);
    assert.strictEqual(plan.status, 'active');
  });
  await t('a cancelled or used-up plan is left alone', async () => {
    for (const status of ['cancelled', 'redeemed']) {
      assert.strictEqual(await restoreDeletedSavingsDraft('500', { store: mkStore(basePlan({ status })) }), null);
    }
  });
  await t('the keys: slots 1–10 and the savings fields, nothing else', async () => {
    for (const k of ['installment_10_value', 'installment_3_mode', 'savings_voucher_code', 'amount_paid']) assert.ok(SAVINGS_RESTORE_KEYS.test(k), k);
    for (const k of ['installment_11_value', 'loyalty_points', 'voucher_value']) assert.ok(!SAVINGS_RESTORE_KEYS.test(k), k);
  });

  console.log(`\n${n} savings-plan restore tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
