process.env.SUPABASE_URL         ||= 'https://buy-plan-test.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL    ||= 'https://buy-plan-test.invalid';

// The two kinds of buy plan: gold value first, and equal installments with a final reprice.
const assert = require('assert');
const { goldValue, startBlockers } = require('./draft');
const { lineRates, estimateDelta, finalRepriceDone, changeRepriceDone } = require('./final');
const { linesKey } = require('./draft');
const { planLegPatch } = require('../installments');
const { isRateLocked, relockAfterReprice } = require('./lock');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
const legs = (...vals) => vals.map((value, i) => ({ value, date: `2026-1${i % 3}-01` }));
const line = (gold, rate, extra = {}) => ({
  title: 'Ring', price: '1', quantity: 1, variant_id: 7,
  properties: [{ name: 'Gold', value: `Rs${gold}` }, { name: '_gold_rate', value: String(rate) }], ...extra,
});
const draft = (over = {}) => ({
  id: '1', mf: {}, tags: [], total: 120000, legs: [],
  customer: { id: '9', name: 'Asha', email: 'a@b.in', phone: '9830000000' },
  draft: { name: '#D1', status: 'open', line_items: [line(50000, 10000)] }, ...over,
});

console.log('gold value');
t('is the Gold breakup of every jewellery line, before GST', () => {
  const d = draft({ draft: { name: '#D1', status: 'open', line_items: [line(50000, 10000), line(10000, 7700, { variant_id: 8 })] } });
  assert.strictEqual(goldValue(d), 60000);
});
t('ignores Exchange Note and negative discount lines', () => {
  const d = draft({ draft: { name: '#D1', status: 'open', line_items: [
    line(50000, 10000),
    { title: 'Exchange Note EN-1', price: '-5000', properties: [{ name: 'Gold', value: 'Rs999' }] },
    { title: 'Discount', price: '-100', properties: [{ name: 'Gold', value: 'Rs999' }] },
  ] } });
  assert.strictEqual(goldValue(d), 50000);
});
t('a gold plan cannot start until the gold value is paid', () => {
  assert.match(startBlockers(draft(), 'gold').join(), /Collect the gold value first: Rs50,000/);
  assert.match(startBlockers(draft({ legs: legs(20000) }), 'gold').join(), /Rs20,000 paid so far/);
  assert.deepStrictEqual(startBlockers(draft({ legs: legs(50000) }), 'gold'), []);
});
t('an equal plan needs no payment to start', () => assert.deepStrictEqual(startBlockers(draft(), 'equal'), []));

console.log('final reprice');
t("today's rate comes from the variant; a custom line falls back to its karat's sale rate", () => {
  const rates = lineRates([
    line(50000, 10000, { variant_id: 7 }),
    line(7700, 7700, { variant_id: null }),
  ], { variantRates: { 7: 10500 }, saleRates: { 14: 6100, 18: 8000, 22: 9600, 24: 10500 }, startSaleRates: { 14: 5900, 18: 7700, 22: 9200, 24: 10000 } });
  assert.deepStrictEqual(rates.map(r => r.newRate), [10500, 8000]);
});
t('a draft-level gold_rate override is the rate the line was priced at', () => {
  const rates = lineRates([line(50000, 9000)], { variantRates: { 7: 10500 }, draftRates: '10000' });
  assert.strictEqual(rates[0].oldRate, 10000);
});
t('the estimate moves only the gold, with GST', () => {
  assert.strictEqual(estimateDelta([{ gold: 50000, oldRate: 10000, newRate: 10500 }]), 2575);
});
t('the lock steps aside for buy-plan-final, and the reprice puts rate-locked back', () => {
  assert.strictEqual(isRateLocked(['buy-plan']), true);
  assert.strictEqual(isRateLocked(['buy-plan', 'buy-plan-final', 'reprice']), false);
  assert.deepStrictEqual(relockAfterReprice(['ch:offline', 'buy-plan', 'buy-plan-final']), ['ch:offline', 'buy-plan', 'rate-locked']);
  assert.deepStrictEqual(relockAfterReprice(['ch:offline']), ['ch:offline']);
});
t('done once rate-locked is back and the trigger tags are gone', () => {
  assert.strictEqual(finalRepriceDone(['buy-plan', 'buy-plan-final', 'reprice']), false);
  assert.strictEqual(finalRepriceDone(['buy-plan', 'rate-locked']), true);
});

console.log('product change');
t('the lock steps aside for buy-plan-change, and the reprice drops it WITHOUT locking', () => {
  assert.strictEqual(isRateLocked(['buy-plan', 'buy-plan-change', 'reprice']), false);
  assert.deepStrictEqual(relockAfterReprice(['buy-plan', 'buy-plan-change']), ['buy-plan']);
  assert.strictEqual(isRateLocked(['buy-plan']), true);
});
t('done once both its tags are gone', () => {
  assert.strictEqual(changeRepriceDone(['buy-plan', 'buy-plan-change', 'reprice']), false);
  assert.strictEqual(changeRepriceDone(['buy-plan']), true);
});
t('the pieces key ignores order and non-jewellery lines', () => {
  const a = [line(1, 1, { variant_id: 7 }), line(1, 1, { variant_id: 8 })];
  const b = [line(1, 1, { variant_id: 8 }), { title: 'Exchange Note EN-1', price: '-5', properties: [] }, line(1, 1, { variant_id: 7 })];
  assert.strictEqual(linesKey(a), linesKey(b));
  assert.notStrictEqual(linesKey(a), linesKey([line(1, 1, { variant_id: 9 })]));
});

console.log('payments land in their installment slot');
const dates = '2026-10-22,2026-11-22,2026-12-22,2027-01-22,2027-02-22,2027-03-22';
t('a payment goes in the slot of the installment its date falls in', () => {
  assert.deepStrictEqual(planLegPatch([], { value: 5000, mode: 'card', date: '2026-12-25' }, dates),
    { installment_3_value: '5000.00', installment_3_mode: 'card', installment_3_date: '2026-12-25' });
});
t('a second payment in the same installment is added to it', () => {
  const rows = [{ slot: 3, value: 5000, mode: 'card', date: '2026-12-25', type: 'payment' }];
  assert.deepStrictEqual(planLegPatch(rows, { value: 2000, mode: 'upi', date: '2027-01-05' }, dates),
    { installment_3_value: '7000.00', installment_3_mode: 'upi', installment_3_date: '2027-01-05' });
});
t('a slot holding a deposit from before the plan is not merged into', () => {
  const rows = [{ slot: 1, value: 1000, mode: 'cash', date: '2026-10-01', type: 'payment' },
                { slot: 2, value: 1000, mode: 'cash', date: '2026-10-05', type: 'payment' }];
  assert.strictEqual(planLegPatch(rows, { value: 3000, mode: 'card', date: '2026-11-23' }, dates).installment_3_value, '3000.00');
});

console.log(`\n${n} passed`);
