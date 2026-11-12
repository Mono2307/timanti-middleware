process.env.SUPABASE_URL         ||= 'https://savings-plan-test.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL    ||= 'https://savings-plan-test.invalid';

const assert = require('assert');
const X = require('./redeem');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };

// A fake ledger + uses table + Shopify discount + plan side, for settleUse.
function world(inst) {
  const w = { inst: { ...inst }, uses: [], redeemed: [], deleted: [], made: [], plan: [] };
  const table = (name) => {
    const q = { name, filters: {} };
    q.insert = async (row) => {
      if (w.uses.some(u => u.serial_code === row.serial_code && u.order_id === row.order_id)) return { error: { code: '23505', message: 'dup' } };
      w.uses.push(row); return { error: null };
    };
    q.update = (patch) => ({ eq: () => ({ eq: async () => { Object.assign(w.inst, patch); return { error: null }; } }) });
    return q;
  };
  const deps = {
    supabase: { from: table },
    creditInstruments: {
      getBySerial: async () => w.inst,
      redeem: async (db, p) => { w.redeemed.push(p.targetOrderName); w.inst.status = 'redeemed'; },
    },
    discount: {
      deleteDiscount: async (id) => { w.deleted.push(id); },
      makeDiscount: async ({ amount }) => { w.made.push(amount); return `rule-${w.made.length}`; },
    },
    plans: {
      voucherBalance: async (code, left) => w.plan.push(`balance:${left}`),
      voucherSpent: async () => w.plan.push('spent'),
    },
  };
  return { w, deps };
}
const SSV = { serial_code: 'SSV27-KAHSR-0001', value: 22000, remaining: 22000, status: 'open', price_rule_id: 'rule-0', customer_id: '55', expires_at: '2027-11-12T23:59:59+05:30' };

(async () => {
  console.log('which codes');
  await t('SSV codes are savings vouchers; VCH and others are not', () => {
    assert.ok(X.isSavingsCode('SSV27-KAHSR-0001') && X.isSavingsCode(' ssv27-kahsr-0002'));
    assert.ok(!X.isSavingsCode('VCH27-KAHSR-0001') && !X.isSavingsCode(''));
  });

  console.log('how much a bill takes');
  await t('a ₹15,000 bill takes ₹15,000 of a ₹22,000 voucher; a ₹30,000 bill takes all of it', () => {
    assert.strictEqual(X.usableOn(SSV, 15000), 15000);
    assert.strictEqual(X.usableOn(SSV, 30000), 22000);
  });
  await t('the balance is what is left, not the issued value', () => {
    assert.strictEqual(X.usableOn({ ...SSV, remaining: 7000 }, 30000), 7000);
  });
  await t('a row with no balance recorded counts its full value', () => {
    assert.strictEqual(X.remainingOf({ value: 13000, remaining: null }), 13000);
  });
  await t('a bill already covered by other credits takes nothing', () => {
    assert.strictEqual(X.usableOn(SSV, -500), 0);
  });
  await t('afterUse: used, left, and whether it closes', () => {
    assert.deepStrictEqual(X.afterUse(SSV, 15000), { used: 15000, left: 7000, closes: false });
    assert.deepStrictEqual(X.afterUse({ ...SSV, remaining: 7000 }, 7000), { used: 7000, left: 0, closes: true });
    assert.deepStrictEqual(X.afterUse({ ...SSV, remaining: 7000 }, 9000), { used: 7000, left: 0, closes: true });
  });

  console.log('settling a use');
  await t('part use in store: balance kept, row open again, code re-made for the balance, customer told', async () => {
    const { w, deps } = world(SSV);
    const r = await X.settleUse({ code: SSV.serial_code, used: 15000, orderId: '1', orderName: '#1001', channel: 'store', deps });
    assert.deepStrictEqual([r.used, r.left, r.closed], [15000, 7000, false]);
    assert.deepStrictEqual([w.inst.status, w.inst.remaining, w.inst.target_order_id], ['open', 7000, null]);
    assert.deepStrictEqual([w.deleted, w.made, w.inst.price_rule_id], [['rule-0'], [7000], 'rule-1']);
    assert.deepStrictEqual(w.plan, ['balance:7000']);
    assert.strictEqual(w.redeemed.length, 0);
  });
  await t('the same order delivered twice is settled once', async () => {
    const { w, deps } = world(SSV);
    await X.settleUse({ code: SSV.serial_code, used: 15000, orderId: '1', orderName: '#1001', channel: 'store', deps });
    const again = await X.settleUse({ code: SSV.serial_code, used: 15000, orderId: '1', orderName: '#1001', channel: 'store', deps });
    assert.deepStrictEqual(again, { duplicate: true });
    assert.strictEqual(w.inst.remaining, 7000);
    assert.strictEqual(w.uses.length, 1);
  });
  await t('the last of the balance: redeemed, code deleted, plan moves to redeemed', async () => {
    const { w, deps } = world({ ...SSV, remaining: 7000 });
    const r = await X.settleUse({ code: SSV.serial_code, used: 7000, orderId: '2', orderName: '#1002', channel: 'online', deps });
    assert.strictEqual(r.closed, true);
    assert.deepStrictEqual([w.inst.status, w.inst.remaining, w.redeemed, w.deleted, w.made, w.plan], ['redeemed', 0, ['#1002'], ['rule-0'], [], ['spent']]);
  });
  await t('two uses in a row: 22,000 → 7,000 → 0', async () => {
    const { w, deps } = world(SSV);
    await X.settleUse({ code: SSV.serial_code, used: 15000, orderId: '1', orderName: '#1001', channel: 'store', deps });
    await X.settleUse({ code: SSV.serial_code, used: 7000, orderId: '2', orderName: '#1002', channel: 'online', deps });
    assert.deepStrictEqual(w.uses.map(u => [u.order_name, u.amount, u.balance_after, u.channel]),
      [['#1001', 15000, 7000, 'store'], ['#1002', 7000, 0, 'online']]);
    assert.strictEqual(w.inst.status, 'redeemed');
  });
  await t('a use of nothing does nothing', async () => {
    const { w, deps } = world(SSV);
    assert.strictEqual(await X.settleUse({ code: SSV.serial_code, used: 0, orderId: '1', channel: 'store', deps }), null);
    assert.strictEqual(w.uses.length, 0);
  });
  await t('the code failing to re-make never loses the balance in the ledger', async () => {
    const { w, deps } = world(SSV);
    deps.discount.makeDiscount = async () => { throw new Error('Shopify down'); };
    const r = await X.settleUse({ code: SSV.serial_code, used: 5000, orderId: '1', orderName: '#1001', channel: 'store', deps });
    assert.deepStrictEqual([r.left, w.inst.status, w.inst.remaining], [17000, 'open', 17000]);
  });

  console.log(`\n${n} savings-voucher part-use tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
