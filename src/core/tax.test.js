const assert = require('assert');
const { gstSplit, supplierState, r2 } = require('./tax');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('gstSplit — rates');
t('intra-state splits into CGST + SGST at 1.5% each', () => {
  assert.deepStrictEqual(gstSplit(1000, 'KA', 'KA'), { igst: 0, cgst: 15, sgst: 15 });
});
t('inter-state is IGST at 3%', () => {
  assert.deepStrictEqual(gstSplit(1000, 'KA', 'MH'), { igst: 30, cgst: 0, sgst: 0 });
});
t('intra- and inter-state totals can differ by 1p — this is expected, not a bug', () => {
  // CGST and SGST are each rounded to 2dp independently, then added; IGST is one rounding of
  // the whole. On ₹12,345.67 that is 185.19 + 185.19 = 370.38 versus a single 370.37.
  // This is how the tax invoice presents it too, so the split is authoritative and the
  // difference is a rounding artefact of the format, not an error to "fix".
  const a = gstSplit(12345.67, 'KA', 'KA'), b = gstSplit(12345.67, 'KA', 'MH');
  assert.strictEqual(r2(a.cgst + a.sgst), 370.38);
  assert.strictEqual(b.igst,              370.37);
  assert.ok(Math.abs(r2(a.cgst + a.sgst) - b.igst) <= 0.01,
    'the two presentations must never diverge by more than a paisa');
});

console.log('gstSplit — half-paisa rounding (the recon-vs-reports disagreement)');
// These are the exact cases where the two old implementations differed. recon.js rounded DOWN
// because +(68.505).toFixed(2) === "68.50" — 68.505 is stored as 68.50499…. Round-half-UP is
// the convention, so these must round up.
t('4567.00 -> 68.51 each, not 68.50', () => {
  assert.deepStrictEqual(gstSplit(4567.00, 'KA', 'KA'), { igst: 0, cgst: 68.51, sgst: 68.51 });
});
t('1.00 -> 0.02 each, not 0.01', () => {
  assert.deepStrictEqual(gstSplit(1.00, 'KA', 'KA'), { igst: 0, cgst: 0.02, sgst: 0.02 });
});
t('r2 rounds half up, not to even', () => {
  assert.strictEqual(r2(0.005), 0.01);
  assert.strictEqual(r2(2.675), 2.68);
  assert.strictEqual(r2(68.505), 68.51);
});

console.log('state normalisation');
t('strips a store suffix and uppercases', () => {
  assert.strictEqual(supplierState('KA-BLR'), 'KA');
  assert.strictEqual(supplierState(' ka '),   'KA');
});
t('defaults to KA when absent', () => {
  assert.strictEqual(supplierState(''),        'KA');
  assert.strictEqual(supplierState(null),      'KA');
});
t('a missing destination is treated as intra-state, never IGST', () => {
  // An address-less document must not silently become an inter-state sale.
  assert.deepStrictEqual(gstSplit(1000, 'KA', ''), { igst: 0, cgst: 15, sgst: 15 });
});
t('destination casing and store suffix do not flip the split', () => {
  assert.deepStrictEqual(gstSplit(1000, 'KA-BLR', 'ka'), { igst: 0, cgst: 15, sgst: 15 });
});

console.log(`\n${n} assertions passed`);
