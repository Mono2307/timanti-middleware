process.env.SUPABASE_URL         ||= 'https://buy-plan-test.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL    ||= 'https://buy-plan-test.invalid';

// The two kinds of buy plan: gold value first, and equal installments with a final reprice.
const assert = require('assert');
const S = require('./schedule');
const { goldValue, startBlockers } = require('./draft');
const { lineRates, estimateDelta, finalRepriceDone } = require('./final');
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

console.log('gold plan schedule');
const goldPlan = { mode: 'gold', total: 120000, gold_value: 51500, start_date: '2026-10-28' };
t('installment 1 is the gold value; the rest is spread over 2..6', () => {
  const s = S.planState(goldPlan, legs(51500));
  assert.strictEqual(s.next, 2);
  assert.strictEqual(s.owed, 13700);   // 68,500 / 5
  const rows = S.scheduleRows(goldPlan, legs(51500), '2026-10-28');
  assert.deepStrictEqual(rows.map(r => r.amount), [null, 13700, 13700, 13700, 13700, 13700]);
});
t('paying the gold value in two parts still settles installment 1', () => {
  const s = S.planState(goldPlan, legs(30000, 21500));
  assert.strictEqual(s.next, 2);
  assert.deepStrictEqual(s.settled.map(x => x.k), [1]);
});
t('paying more than the gold value lowers installments 2..6', () => {
  assert.strictEqual(S.planState({ ...goldPlan, gold_value: 70000 }, legs(70000)).owed, 10000);
});

console.log('equal plan schedule');
const eq = { mode: 'equal', total: 120000, start_date: '2026-10-28', final_total: null };
t('six equal installments; installment 6 is marked an estimate until repriced', () => {
  const rows = S.scheduleRows(eq, [], '2026-10-28');
  assert.deepStrictEqual(rows.map(r => r.amount), [20000, 20000, 20000, 20000, 20000, 20000]);
  assert.strictEqual(rows[5].estimate, true);
  assert.strictEqual(rows[4].estimate, false);
  assert.strictEqual(S.awaitingFinalPrice(eq), true);
});
t('gold up: the last installment carries the whole difference', () => {
  const s = S.planState({ ...eq, final_total: 126000 }, legs(20000, 20000, 20000, 20000, 20000));
  assert.strictEqual(s.next, 6);
  assert.strictEqual(s.owed, 26000);
  assert.strictEqual(s.credit, 0);
});
t('gold down: the last installment shrinks', () => {
  assert.strictEqual(S.planState({ ...eq, final_total: 114000 }, legs(20000, 20000, 20000, 20000, 20000)).owed, 14000);
});
t('earlier installments stay settled against the starting price', () => {
  const s = S.planState({ ...eq, final_total: 150000 }, legs(20000, 20000));
  assert.deepStrictEqual(s.settled.map(x => x.k), [1, 2]);
  assert.strictEqual(s.next, 3);
  assert.strictEqual(s.owed, 20000);
  assert.strictEqual(s.balance, 110000);
});
t('paid in full early, gold fell: no balance, the store owes a credit', () => {
  const s = S.planState({ ...eq, final_total: 110000 }, legs(120000));
  assert.strictEqual(s.next, null);
  assert.strictEqual(s.credit, 10000);
});
t('paid in full early, gold rose: installment 6 is the difference', () => {
  const s = S.planState({ ...eq, final_total: 125000 }, legs(120000));
  assert.strictEqual(s.next, 6);
  assert.strictEqual(s.owed, 5000);
});

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

console.log(`\n${n} passed`);
