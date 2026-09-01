const assert = require('assert');
const { lineMoney, legColumns, legsFromTags, SALES_COLS } = require('./reports');
const { readInstallments } = require('../payments/installments');
const { readRefunds } = require('../payments/refunds');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('lineMoney — the discount is PRE-TAX');
t('taxable = gross/1.03 - discount, never (gross-discount)/1.03', () => {
  // 103000 tax-inclusive gross, 10000 pre-tax discount.
  const m = lineMoney({ grossValue: 103000, discount: 10000, storeState: 'KA', shipState: 'KA' });
  assert.strictEqual(m.taxable_value, 90000);
  // The old formula gave 90291.26 — 291.26 of taxable value that never existed.
  assert.notStrictEqual(m.taxable_value, 90291.26);
});
t('GST follows the corrected taxable, not the inflated one', () => {
  const m = lineMoney({ grossValue: 103000, discount: 10000, storeState: 'KA', shipState: 'KA' });
  assert.strictEqual(m.cgst + m.sgst + m.igst, 2700);
});
t('agrees with the adjustment report formula for any discount', () => {
  for (const [gross, disc] of [[103000, 10000], [51500, 0], [206000, 25000], [10300, 300]]) {
    const m = lineMoney({ grossValue: gross, discount: disc, storeState: 'KA', shipState: 'KA' });
    const adjustmentReportFormula = Math.round(Math.max(0, gross / 1.03 - disc) * 100) / 100;
    assert.strictEqual(m.taxable_value, adjustmentReportFormula, `gross=${gross} disc=${disc}`);
  }
});
t('a discount larger than the pre-tax value floors at zero, never negative tax', () => {
  const m = lineMoney({ grossValue: 1030, discount: 5000, storeState: 'KA', shipState: 'KA' });
  assert.strictEqual(m.taxable_value, 0);
  assert.strictEqual(m.igst + m.cgst + m.sgst, 0);
});
t('an explicit Taxable Value line property still wins', () => {
  const m = lineMoney({ grossValue: 103000, discount: 10000, taxableProp: 88888, storeState: 'KA', shipState: 'KA' });
  assert.strictEqual(m.taxable_value, 88888);
});
t('net_sales stays tax-INCLUSIVE post-discount', () => {
  const m = lineMoney({ grossValue: 103000, discount: 10000, storeState: 'KA', shipState: 'KA' });
  assert.strictEqual(m.net_sales, 93000);
});

console.log('legColumns — legs spread rightward');
t('every slot gets four columns, empty when absent', () => {
  const c = legColumns([], []);
  assert.strictEqual(Object.keys(c).length, 4 * 4 + 2 * 4);
  assert.strictEqual(c.i1_value, '');
  assert.strictEqual(c.r2_ref, '');
});
t('places each leg in its own slot columns', () => {
  const mf = {
    installment_1_value: '50000', installment_1_mode: 'cash', installment_1_date: '2026-08-28',
    installment_2_value: '60000', installment_2_mode: 'upi',  installment_2_date: '2026-09-02',
    refund_1_value: '10000', refund_1_mode: 'upi', refund_1_date: '2026-08-30', refund_1_ref: 'UTR9',
  };
  const c = legColumns(readInstallments(mf), readRefunds(mf));
  assert.strictEqual(c.i1_value, 50000);
  assert.strictEqual(c.i1_mode, 'cash');
  assert.strictEqual(c.i2_value, 60000);
  assert.strictEqual(c.r1_value, 10000);
  assert.strictEqual(c.r1_ref, 'UTR9');
  assert.strictEqual(c.i3_value, '');
});
t('is sparse-safe — a leg in slot 3 lands in slot 3, not slot 1', () => {
  const c = legColumns(readInstallments({ installment_3_value: '900', installment_3_mode: 'card' }), []);
  assert.strictEqual(c.i1_value, '');
  assert.strictEqual(c.i3_value, 900);
  assert.strictEqual(c.i3_mode, 'card');
});
t('a cad_advance leg is labelled, so a design advance is separable from a real collection', () => {
  const c = legColumns(readInstallments({ installment_1_value: '5000', installment_1_type: 'cad_advance' }), []);
  assert.strictEqual(c.i1_type, 'cad_advance');
});
t('a plain leg reads as payment', () => {
  const c = legColumns(readInstallments({ installment_1_value: '5000' }), []);
  assert.strictEqual(c.i1_type, 'payment');
});

console.log('legsFromTags — the drafts side rebuilds the same table');
t('parses the writer tag format', () => {
  const { inst, refunds } = legsFromTags(['i1:50000@cash@2026-08-28', 'r1:10000@upi@2026-08-30']);
  assert.deepStrictEqual(inst,    [{ slot: 1, value: 50000, mode: 'cash', date: '2026-08-28', type: 'payment' }]);
  assert.deepStrictEqual(refunds, [{ slot: 1, value: 10000, mode: 'upi',  date: '2026-08-30' }]);
});
t('the trailing @c marks a cad_advance leg', () => {
  const { inst } = legsFromTags(['i2:5000@CAD Advance@2026-08-20@c']);
  assert.strictEqual(inst[0].type, 'cad_advance');
  assert.strictEqual(inst[0].mode, 'CAD Advance');   // a mode containing a space survives
});
t('ignores every unrelated tag', () => {
  const { inst, refunds } = legsFromTags(['deposit:partial', 'paid:Rs50000', 'pmodes:cash/upi', 'invoice:x']);
  assert.deepStrictEqual(inst, []);
  assert.deepStrictEqual(refunds, []);
});
t('drops a zero or unparseable leg rather than emitting a phantom row', () => {
  const { inst } = legsFromTags(['i1:0@cash@2026-08-28', 'i2:@upi@', 'i3:abc@upi@']);
  assert.deepStrictEqual(inst, []);
});
t('a missing mode or date yields empty strings, not undefined', () => {
  const { inst } = legsFromTags(['i1:1000']);
  assert.strictEqual(inst[0].mode, '');
  assert.strictEqual(inst[0].date, '');
});
t('drafts and orders agree: the same document reads identically both ways', () => {
  // What the tag writer emits for this document, vs what the metafields say.
  const mf = {
    installment_1_value: '50000', installment_1_mode: 'cash', installment_1_date: '2026-08-28',
    refund_1_value: '10000', refund_1_mode: 'upi', refund_1_date: '2026-08-30', refund_1_ref: 'UTR9',
  };
  const fromMf   = legColumns(readInstallments(mf), readRefunds(mf));
  const tagSide  = legsFromTags(['i1:50000@cash@2026-08-28', 'r1:10000@upi@2026-08-30']);
  const fromTags = legColumns(tagSide.inst, tagSide.refunds);
  // Everything matches except the gateway ref, which has no room in a 40-char tag.
  for (const k of Object.keys(fromMf)) {
    if (k === 'r1_ref') continue;
    assert.strictEqual(fromTags[k], fromMf[k], `column ${k}`);
  }
  assert.strictEqual(fromTags.r1_ref, '');
});

console.log('SALES_COLS');
t('carries every leg column the collectors emit', () => {
  for (const k of Object.keys(legColumns([], []))) {
    assert.ok(SALES_COLS.includes(k), `SALES_COLS is missing ${k} — it would be dropped from the CSV`);
  }
});
t('totals sit to the RIGHT of the legs they are computed from', () => {
  assert.ok(SALES_COLS.indexOf('r2_ref') < SALES_COLS.indexOf('amount_paid'));
  assert.ok(SALES_COLS.indexOf('amount_paid') < SALES_COLS.indexOf('net_collected'));
});
t('has no duplicate columns', () => {
  assert.strictEqual(new Set(SALES_COLS).size, SALES_COLS.length);
});

console.log(`\n${n} assertions passed`);
