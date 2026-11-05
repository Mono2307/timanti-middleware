process.env.SUPABASE_URL         ||= 'https://buy-plan-test.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL    ||= 'https://buy-plan-test.invalid';

// The two kinds of buy plan: gold value first, and equal installments with a final reprice.
const assert = require('assert');
const { goldValue, startBlockers } = require('./draft');
const { lineRates, estimateDelta, goldOnlyReprice, finalRepriceDone, changeRepriceDone } = require('./final');
const { linesKey, linesToRestore, withRestored } = require('./draft');
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
t('done once rate-locked is on and the recompute has consumed sync-payment', () => {
  assert.strictEqual(finalRepriceDone(['buy-plan', 'buy-plan-final', 'reprice']), false);
  assert.strictEqual(finalRepriceDone(['buy-plan', 'rate-locked', 'sync-payment']), false);
  assert.strictEqual(finalRepriceDone(['buy-plan', 'rate-locked']), true);
});

console.log('final price: only the gold moves');
const priced = (extra = {}) => ({
  title: 'Ring', price: '120000.00', quantity: 1, variant_id: 7,
  properties: [
    { name: 'Gold', value: 'Rs50000.00' }, { name: 'Diamond', value: 'Rs55000.00' }, { name: 'Making', value: 'Rs11650.49' },
    { name: 'Gross Value', value: 'Rs120000.00' }, { name: 'Taxable Value', value: 'Rs116504.85' }, { name: 'GST', value: 'Rs3495.15' },
    { name: '_gold_rate', value: '10000' }, { name: '_jewel_code', value: 'R1' },
  ], ...extra,
});
const val = (li, name) => li.properties.find(p => p.name === name)?.value;
t('gold × new rate / old rate; the price moves by the gold difference plus GST; diamond and making stay', () => {
  const { lines, changes } = goldOnlyReprice([priced()], [{ oldRate: 10000, newRate: 10500 }]);
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(lines[0].price, '122575.00');            // 120000 + 2500 × 1.03
  assert.strictEqual(val(lines[0], 'Gold'), 'Rs52500.00');
  assert.strictEqual(val(lines[0], '_gold_rate'), '10500');
  assert.strictEqual(val(lines[0], 'Diamond'), 'Rs55000.00');
  assert.strictEqual(val(lines[0], 'Making'), 'Rs11650.49');
  assert.strictEqual(val(lines[0], 'Gross Value'), 'Rs122575.00');
  assert.strictEqual(val(lines[0], 'Taxable Value'), 'Rs119004.85');
  assert.strictEqual(val(lines[0], 'GST'), 'Rs3570.15');
  assert.strictEqual(val(lines[0], '_jewel_code'), 'R1');
});
t('gold falls: the price falls by the same rule, rounded to the rupee of gold', () => {
  const { lines } = goldOnlyReprice([priced()], [{ oldRate: 10000, newRate: 9333.33 }]);
  assert.strictEqual(val(lines[0], 'Gold'), 'Rs46667.00');     // round(50000 × 0.933333)
  assert.strictEqual(lines[0].price, '116567.01');            // 120000 − 3333 × 1.03
});
t('Gold is the whole line\'s; the price is per piece', () => {
  const two = priced({ quantity: 2, price: '60000.00' });
  const { lines } = goldOnlyReprice([two], [{ oldRate: 10000, newRate: 10500 }]);
  assert.strictEqual(lines[0].price, '61287.50');             // 60000 + 2500 × 1.03 / 2
});
t('the old rate is the line\'s own _gold_rate, so a second run changes nothing', () => {
  const once = goldOnlyReprice([priced()], [{ oldRate: 10000, newRate: 10500 }]).lines;
  const twice = goldOnlyReprice(once, [{ oldRate: 10000, newRate: 10500 }]);
  assert.deepStrictEqual(twice.changes, []);
  assert.strictEqual(twice.lines[0].price, '122575.00');
});
t('no Gold breakup or no rate: left as it is and reported; Exchange Note lines pass through', () => {
  const bare = { title: 'Pendant', price: '9000.00', quantity: 1, variant_id: 8, properties: [] };
  const exc = { title: 'Exchange Note EN-1', price: '-5000.00', quantity: 1, properties: [{ name: 'Gold', value: 'Rs1' }] };
  const { lines, changes, skipped } = goldOnlyReprice([bare, exc, priced()], [{ oldRate: 0, newRate: 10500 }, { oldRate: 10000, newRate: null }]);
  assert.deepStrictEqual(changes, []);
  assert.deepStrictEqual(skipped.map(s => s.why), ['no Gold breakup', 'no gold rate']);
  assert.strictEqual(lines[0], bare);
  assert.strictEqual(lines[1], exc);
  assert.strictEqual(lines[2].price, '120000.00');
});
t('the reminder\'s estimate agrees with the final price', () => {
  const rates = lineRates([priced()], { variantRates: { 7: 10500 } });
  const { lines } = goldOnlyReprice([priced()], rates);
  assert.strictEqual(Math.round(parseFloat(lines[0].price) - 120000), estimateDelta(rates));
});

console.log('a re-added piece keeps its locked price');
t('the same piece at the catalog price with no breakup is put back to the snapshot line', () => {
  const snap = priced();
  const live = [{ title: 'Ring', price: '150000.00', quantity: 1, variant_id: 7, properties: [] }];
  const fixes = linesToRestore([snap], live);
  assert.deepStrictEqual(fixes.map(f => [f.idx, f.from, f.to]), [[0, 150000, 120000]]);
  assert.deepStrictEqual(withRestored(live, fixes)[0], snap);
});
t('same price but the breakup moved: put back; same price and breakup: nothing', () => {
  const moved = priced({ properties: priced().properties.map(p => p.name === 'Gold' ? { ...p, value: 'Rs51000.00' } : p) });
  assert.strictEqual(linesToRestore([priced()], [moved]).length, 1);
  assert.deepStrictEqual(linesToRestore([priced()], [priced()]), []);
  assert.deepStrictEqual(linesToRestore([priced()], [priced({ price: '120000.30' })]), []);   // paise of rounding
});
t('pieces pair by variant and quantity; other lines and pieces not in the snapshot are left alone', () => {
  const a = priced(), b = priced({ variant_id: 9, price: '8000.00' });
  const exc = { title: 'Exchange Note EN-1', price: '-5000.00', quantity: 1, properties: [] };
  const live = [exc, { ...b, properties: [], price: '9500.00' }, a, { title: 'Chain', variant_id: 11, quantity: 1, price: '3000.00', properties: [] }];
  const fixes = linesToRestore([a, b], live);
  assert.deepStrictEqual(fixes.map(f => f.idx), [1]);
  const out = withRestored(live, fixes);
  assert.strictEqual(out[0], exc);
  assert.strictEqual(out[1].price, '8000.00');
  assert.strictEqual(out[3].price, '3000.00');
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
t('the first payment goes in slot 1, whatever its date', () => {
  assert.deepStrictEqual(planLegPatch([], { value: 5000, mode: 'card', date: '2026-12-25' }, dates),
    { installment_1_value: '5000.00', installment_1_mode: 'card', installment_1_date: '2026-12-25' });
});
t('a second payment in the same month is the second installment, not added to the first', () => {
  const rows = [{ slot: 1, value: 5000, mode: 'card', date: '2026-10-25', type: 'payment' }];
  assert.deepStrictEqual(planLegPatch(rows, { value: 2000, mode: 'upi', date: '2026-10-28' }, dates),
    { installment_2_value: '2000.00', installment_2_mode: 'upi', installment_2_date: '2026-10-28' });
});
t('slots 5 and 6 are used, and a 7th payment folds into slot 6', () => {
  const rows = [1, 2, 3, 4, 5].map(slot => ({ slot, value: 1000, mode: 'cash', date: '2026-10-25', type: 'payment' }));
  assert.strictEqual(planLegPatch(rows, { value: 3000, mode: 'card', date: '2026-11-23' }, dates).installment_6_value, '3000.00');
  rows.push({ slot: 6, value: 3000, mode: 'card', date: '2026-11-23', type: 'payment' });
  assert.strictEqual(planLegPatch(rows, { value: 500, mode: 'upi', date: '2026-12-23' }, dates).installment_6_value, '3500.00');
});

console.log(`\n${n} passed`);
