process.env.SUPABASE_URL         ||= 'https://buy-plan-test.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL    ||= 'https://buy-plan-test.invalid';

const assert = require('assert');
const path = require('path');

// Replace cancel.js's I/O (Supabase, vouchers, Shopify tags + links, email) with in-memory fakes.
const fake = (rel, exports) => {
  const file = require.resolve(path.join(__dirname, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

const world = {};
fake('./store.js', { updatePlan: async (id, patch) => { world.updates.push(patch); Object.assign(world.plan, patch); } });
fake('./voucher.js', { issuePlanVoucher: async ({ value, why }) => {
  if (world.voucherFails) throw new Error('Shopify said no');
  world.vouchers.push(`${value}:${why}`);
  return { code: 'VCH-9', value, validUntil: '2027-11-09' };
} });
fake('./forfeit.js', { releaseDraft: async (plan, d, tag) => { world.released.push(tag); } });
fake('./notify.js', { sendCancelled: async (plan, d, o) => {
  world.sent.push(`${o.kind}:${o.paid}:${o.voucher ? o.voucher.code : o.voucherError ? 'failed' : 'none'}`);
} });

const { cancelPlan, isMistake, CANCELLED_TAG } = require('./cancel');
const S = require('./schedule');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };
const START = '2026-11-01';

function reset({ legs = [], over = {} } = {}) {
  Object.assign(world, { updates: [], vouchers: [], released: [], sent: [], voucherFails: false });
  world.plan = { id: 1, draft_order_id: '100', draft_name: '#D400', total: 60000, status: 'active', mode: 'equal',
    customer_id: '9', customer_name: 'Asha', installments: 6, start_date: START, due_dates: S.dueDates(START, 6),
    gold_value: null, final_total: null, price_changes: [], ...over };
  world.d = { id: '100', draft: { name: '#D400', status: 'open', line_items: [] }, mf: {}, tags: ['buy-plan'], legs };
}
const go = (o) => cancelPlan(world.plan, world.d, { today: '2026-11-09', by: 'staff-1', ...o });

(async () => {
  console.log('cancelPlan');

  await t('customer opted out after paying: voucher for everything paid, once the money is confirmed', async () => {
    reset({ legs: [{ value: 10000, date: START }, { value: 2500, date: '2026-11-05' }] });
    await assert.rejects(go({ kind: 'opted_out' }), /actually reached the store/);
    assert.strictEqual(world.plan.status, 'active');
    assert.deepStrictEqual(world.vouchers, []);
    const r = await go({ kind: 'opted_out', moneyReceived: true, note: '  moving   cities ' });
    assert.strictEqual(world.plan.status, 'cancelled');
    assert.strictEqual(world.plan.closed_reason, 'customer opted out: moving cities');
    assert.deepStrictEqual(world.vouchers, ['12500:plan cancelled']);
    assert.strictEqual(world.plan.voucher_code, 'VCH-9');
    assert.strictEqual(r.voucher.code, 'VCH-9');
    assert.deepStrictEqual(world.released, [CANCELLED_TAG]);
    assert.deepStrictEqual(world.sent, ['opted_out:12500:VCH-9']);
    assert.strictEqual(isMistake(world.plan), false);
  });

  await t('the plan is marked cancelled before the voucher, so a retry can never make a second one', async () => {
    reset({ legs: [{ value: 5000, date: START }] });
    world.voucherFails = true;
    const r = await go({ kind: 'opted_out', moneyReceived: true });
    assert.strictEqual(world.updates[0].status, 'cancelled');
    assert.match(r.voucherError, /Shopify said no/);
    assert.deepStrictEqual(world.sent, ['opted_out:5000:failed']);
    assert.deepStrictEqual(world.released, [CANCELLED_TAG]);
  });

  await t('opted out with nothing paid: no voucher, no money check needed', async () => {
    reset();
    await go({ kind: 'opted_out' });
    assert.deepStrictEqual(world.vouchers, []);
    assert.deepStrictEqual(world.sent, ['opted_out:0:none']);
  });

  await t('demo or staff mistake: no voucher even with payments recorded, and the draft can be started over', async () => {
    reset({ legs: [{ value: 10000, date: START }] });
    await go({ kind: 'mistake' });
    assert.strictEqual(world.plan.status, 'cancelled');
    assert.deepStrictEqual(world.vouchers, []);
    assert.deepStrictEqual(world.sent, ['mistake:10000:none']);
    assert.strictEqual(isMistake(world.plan), true);
  });

  await t('refused: no reason, or a product change still being priced', async () => {
    reset();
    await assert.rejects(go({ kind: 'refund' }), /Choose why/);
    reset({ over: { change_pending: { started_at: new Date().toISOString() } } });
    await assert.rejects(go({ kind: 'mistake' }), e => e.status === 409);
    assert.strictEqual(world.plan.status, 'active');
  });

  console.log(`\n${n} passed`);
})().catch(e => { console.error(e); process.exit(1); });
