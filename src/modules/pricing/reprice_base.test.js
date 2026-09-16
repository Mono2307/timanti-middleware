'use strict';

const assert = require('assert');
const { preTaxBase, rupees } = require('./reprice_base');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

const r2 = (v) => Math.round(v * 100) / 100;

// One line of #D218, rounded to the shape of the worked example: gold 60,000 + diamond 30,000 +
// making 10,000, with a 10% diamond discount.
const GOLD = 60000, DIA = 30000, MAKING = 10000;
const PRE_TAX = GOLD + DIA + MAKING;          // 100,000
const DISCOUNT = r2(DIA * 0.10);              // 3,000 pre-tax

// What the engine does with a base once it has one. Mirrors handleRecalculatePriceTag: Gross Value
// is pre-discount tax-inclusive, Discount Applied is pre-tax rupees, price = (base - disc) * 1.03.
function priceLine(base, discount) {
  const taxable = r2(Math.max(0, base - discount));
  return {
    price: r2(taxable * 1.03),
    props: [
      { name: 'Gross Value',      value: `Rs${r2(base * 1.03).toFixed(2)}` },
      { name: 'Discount Applied', value: `Rs${discount.toFixed(2)}` },
    ],
  };
}

console.log('rupee parsing');
t('strips the prefix and separators', () => {
  assert.strictEqual(rupees('Rs1,234.56'), 1234.56);
  assert.strictEqual(rupees('Rs0.00'), 0);
  assert.strictEqual(rupees(undefined), 0);
  assert.strictEqual(rupees('—'), 0);
});

console.log('the component rebuild wins whenever it is available');
t('uses newPreTaxGross', () => {
  const { base, source } = preTaxBase({ price: '1.00', quantity: 1 }, { newPreTaxGross: PRE_TAX });
  assert.strictEqual(base, PRE_TAX);
  assert.strictEqual(source, 'components');
});

console.log('a line that cannot be rebuilt reads the PRE-discount Gross Value, never the price');
t('base ignores the discount already taken out of the price', () => {
  const run1 = priceLine(PRE_TAX, DISCOUNT);
  const line = { price: String(run1.price), quantity: 1, properties: run1.props };
  const { base, source } = preTaxBase(line, null);
  assert.strictEqual(source, 'gross-prop');
  assert.strictEqual(base, PRE_TAX, 'base must be the pre-discount 100,000, not the discounted 97,000');
});

console.log('REGRESSION #D218: repricing a discounted line twice changes nothing');
t('ten runs land on the first run price', () => {
  const first = priceLine(PRE_TAX, DISCOUNT);
  let line = { price: String(first.price), quantity: 1, properties: first.props };
  for (let i = 0; i < 10; i++) {
    const { base } = preTaxBase(line, null);
    const run = priceLine(base, DISCOUNT);
    assert.strictEqual(run.price, first.price, `run ${i + 2} moved the price`);
    line = { price: String(run.price), quantity: 1, properties: run.props };
  }
});

t('the old price-derived base is what compounded — proof the test is testing something', () => {
  // The pre-fix behaviour, inlined: base = price / 1.03. Kept as a guard so a regression cannot be
  // mistaken for a no-op test.
  const first = priceLine(PRE_TAX, DISCOUNT);
  const legacyBase = r2(first.price / 1.03);
  const second = priceLine(legacyBase, DISCOUNT);
  assert.notStrictEqual(second.price, first.price);
  assert.strictEqual(r2(first.price - second.price), r2(DISCOUNT * 1.03));  // 3,090 lost per run
});

console.log('a never-priced line still gets a base');
t('falls back to the price when there is no Gross Value', () => {
  const { base, source } = preTaxBase({ price: '103.00', quantity: 2 }, null);
  assert.strictEqual(source, 'price');
  assert.strictEqual(base, 200);
});

console.log(`\n  ${n} assertions passed`);
