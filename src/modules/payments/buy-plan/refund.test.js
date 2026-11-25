process.env.SUPABASE_URL         ||= 'https://buy-plan-test.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL    ||= 'https://buy-plan-test.invalid';

const assert = require('assert');
const X = require('./refund');
const credit = require('./credit');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };

// A fake world: two GoKwik link payments on draft 100, the webhook log, GoKwik, the store.
function world({ links = [], logs = {}, refunded = {}, failOn = null } = {}) {
  const w = { initiated: [], mf: [], plan: [], config: {} };
  const from = (table) => {
    const q = { f: {} };
    q.select = () => q;
    q.eq = (k, v) => { q.f[k] = v; return q; };
    q.limit = async () => ({ data: logs[q.f['body->>transaction_id']] ? [{ body: { transaction_id: q.f['body->>transaction_id'], gokwik_oid: logs[q.f['body->>transaction_id']] } }] : [] });
    q.then = (res) => res({ data: table === 'payment_links' ? links : [], error: null });
    return q;
  };
  const deps = {
    enabled: true,
    supabase: { from },
    gokwik: {
      listRefunds: async ({ transactionPaymentId }) => (refunded[transactionPaymentId] || []),
      initiateRefund: async ({ gokwikOid, amount }) => {
        if (failOn === gokwikOid) throw Object.assign(new Error('GoKwik: Cannot initiate refund for an order more than 30 days old'), { status: 400 });
        w.initiated.push(`${gokwikOid}:${amount}`);
        return { refundId: `RKWIK${w.initiated.length}`, status: 'Initiated', parts: [{ refundId: `RKWIK${w.initiated.length}`, amount }] };
      },
    },
    store: {
      getConfigValue: async (k) => w.config[k] ?? null,
      setConfigValue: async (k, v) => { w.config[k] = v; },
      updatePlan: async (id, p) => { w.plan.push(p); },
    },
    updateDraftOrderMetafields: async (id, patch) => { w.mf.push(patch); },
  };
  return { w, deps };
}
const plan = () => ({ id: 1, draft_name: '#D300', status: 'active', total: 100000, installments: 6, mode: 'equal', price_changes: [] });
const draft = (mf = {}) => ({ id: '100', mf, legs: [] });
const L = [
  { gokwik_txn_id: 'KWIKA', amount: 20000, created_at: '2026-10-01', updated_at: '2026-10-01' },
  { gokwik_txn_id: 'KWIKB', amount: 5000, created_at: '2026-11-01', updated_at: '2026-11-01' },
];
const LOGS = { KWIKA: '100-111', KWIKB: '100-222' };

(async () => {
  console.log('allocate');
  await t('newest payment first, each capped at what it can still return', async () => {
    const a = X.allocate(8000, [{ txn: 'A', oid: 'a', at: '2026-10-01', left: 20000 }, { txn: 'B', oid: 'b', at: '2026-11-01', left: 5000 }]);
    assert.deepStrictEqual(a, { parts: [{ txn: 'B', oid: 'b', amount: 5000 }, { txn: 'A', oid: 'a', amount: 3000 }], total: 8000, short: 0 });
  });
  await t('more owed than the links can return: the rest is short', async () => {
    const a = X.allocate(30000, [{ txn: 'A', oid: 'a', at: '2026-10-01', left: 20000 }]);
    assert.deepStrictEqual([a.total, a.short], [20000, 10000]);
  });
  await t('a payment with no GoKwik order id, or nothing left, is skipped', async () => {
    const a = X.allocate(1000, [{ txn: 'A', oid: null, left: 5000 }, { txn: 'B', oid: 'b', left: 0 }]);
    assert.deepStrictEqual([a.total, a.short], [0, 1000]);
  });

  console.log('link payments');
  await t('what each link payment can still return, after GoKwik refunds already made (failed ones do not count)', async () => {
    const { deps } = world({ links: L, logs: LOGS, refunded: { KWIKA: [{ amount: 2000, status: 'Completed' }, { amount: 500, status: 'Failed' }] } });
    const p = await X.linkPayments('100', deps);
    assert.deepStrictEqual(p.map(x => [x.txn, x.oid, x.left]), [['KWIKA', '100-111', 18000], ['KWIKB', '100-222', 5000]]);
  });

  console.log('issue a refund');
  await t('Rs8,000 over the price: two refunds, newest payment first, written as refund legs; plan settled', async () => {
    const { w, deps } = world({ links: L, logs: LOGS });
    const r = await X.issueRefund(plan(), draft(), 8000, { today: '2026-11-23', by: 'staff-1', deps });
    assert.deepStrictEqual(w.initiated, ['100-222:5000', '100-111:3000']);
    assert.deepStrictEqual([r.refunded, r.short], [8000, 0]);
    assert.deepStrictEqual(w.mf[0], { refund_1_value: '5000.00', refund_1_mode: 'online_link', refund_1_date: '2026-11-23', refund_1_ref: 'RKWIK1' });
    assert.strictEqual(w.mf[1].refund_2_value, '3000.00');
    assert.ok('final_total' in w.plan[0]);
    assert.strictEqual(w.config.buy_plan_refund_lock_1, '0');
  });
  await t('a second press while one runs is refused', async () => {
    const { w, deps } = world({ links: L, logs: LOGS });
    w.config.buy_plan_refund_lock_1 = String(Date.now());
    await assert.rejects(X.issueRefund(plan(), draft(), 8000, { today: '2026-11-23', deps }), /already being made/);
  });
  await t('nothing paid by link: refused, voucher instead', async () => {
    const { deps } = world({ links: [], logs: {} });
    await assert.rejects(X.issueRefund(plan(), draft(), 8000, { today: '2026-11-23', deps }), /voucher/);
  });
  await t('GoKwik refusing the first refund stops it, nothing recorded', async () => {
    const { w, deps } = world({ links: L, logs: LOGS, failOn: '100-222' });
    await assert.rejects(X.issueRefund(plan(), draft(), 8000, { today: '2026-11-23', deps }), /30 days old/);
    assert.deepStrictEqual(w.mf, []);
  });
  await t('a closed or repricing plan cannot be refunded here', async () => {
    const { deps } = world({ links: L, logs: LOGS });
    await assert.rejects(X.issueRefund({ ...plan(), status: 'forfeited' }, draft(), 8000, { today: '2026-11-23', deps }), /forfeited/);
    await assert.rejects(X.issueRefund({ ...plan(), change_pending: { x: 1 } }, draft(), 8000, { today: '2026-11-23', deps }), /being priced/);
  });

  await t('switched off (BUY_PLAN_REFUNDS not on): no option on the screen, and the refund is refused', async () => {
    const { deps } = world({ links: L, logs: LOGS });
    deps.enabled = false;
    assert.strictEqual(await X.refundOption(plan(), draft(), 8000, deps), null);
    await assert.rejects(X.issueRefund(plan(), draft(), 8000, { today: '2026-11-23', deps }), /not switched on/);
  });

  console.log('credit after a refund');
  await t('money refunded is no longer owed as a voucher', async () => {
    const st = { credit: 8000, paid: 108000 };
    assert.strictEqual(credit.voucherDue(plan(), st, draft()).amount, 8000);
    assert.strictEqual(credit.voucherDue(plan(), st, draft({ refund_1_value: '5000.00' })).amount, 3000);
    assert.strictEqual(credit.voucherDue(plan(), st, draft({ refund_1_value: '5000.00', refund_2_value: '3000.00' })).amount, 0);
  });

  console.log(`\n${n} buy-plan refund tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
