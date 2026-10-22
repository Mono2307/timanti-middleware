'use strict';

const assert = require('assert');
const {
  resolveDiscount, readDiscountCodes, resolveOrderCodes, stackLineDiscount, addCode, removeCode, codeFields,
} = require('./discounts');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
const r2 = (v) => Math.round(v * 100) / 100;

// One line: diamond 40,000 pre-tax, gross 100,000 pre-tax → 103,000 tax-inclusive.
const LINE = { diamond: 40000, grossIncl: 103000 };

console.log('resolveDiscount (moved from server.js, unchanged)');
t('custom % is on the pre-tax diamond', () => {
  assert.strictEqual(r2(resolveDiscount({ kind: 'custom', mode: 'pct', rate: 10, lines: [LINE] }).total), 4000);
});
t('code % is on the tax-inclusive total, converted to pre-tax', () => {
  assert.strictEqual(r2(resolveDiscount({ kind: 'code', mode: 'pct', rate: 5, lines: [LINE] }).total), 5000);
});

console.log('readDiscountCodes');
t('the list wins over the single slot', () => {
  const codes = readDiscountCodes({
    discount_codes: JSON.stringify([{ code: 'FNF5', kind: 'code', mode: 'pct', rate: 5 }, { code: 'LOYAL2', kind: 'code', mode: 'pct', rate: 2 }]),
    discount_rate: '5', discount_code: 'FNF5',
  });
  assert.deepStrictEqual(codes.map(c => c.code), ['FNF5', 'LOYAL2']);
});
t('a pre-list draft reads its single slot as a one-entry list', () => {
  const codes = readDiscountCodes({ discount_rate: '10.00', discount_mode: 'pct', discount_kind: 'custom', discount_code: 'CUSTOM 10%' });
  assert.deepStrictEqual(codes, [{ code: 'CUSTOM 10%', kind: 'custom', mode: 'pct', rate: 10 }]);
});
t('#D235: a code name with no rate (wiped by the old positional reset) resolves to nothing', () => {
  assert.deepStrictEqual(readDiscountCodes({ discount_code: 'FNF5' }), []);
});
t('frozen-rupee legacy fallback still works on a draft that never had per-line discounts', () => {
  const codes = readDiscountCodes({ discount_applied: '1500' });
  assert.strictEqual(codes.length, 1);
  assert.strictEqual(codes[0].legacy, true);
});
t('discount_applied is NOT read back as a code once per-line discounts exist (it includes them)', () => {
  assert.deepStrictEqual(readDiscountCodes({ discount_applied: '6940', line_discounts: '[[{"t":"dia","m":"pct","v":10}]]' }), []);
});

console.log('stacking');
t('two codes are additive, not compounding: 10% + 10% of diamond = 20%', () => {
  const codes = [{ code: 'A', kind: 'custom', mode: 'pct', rate: 10 }, { code: 'B', kind: 'custom', mode: 'pct', rate: 10 }];
  assert.strictEqual(r2(resolveOrderCodes(codes, [LINE]).total), 8000);
});
t('order-level codes together never exceed the line diamond', () => {
  const codes = [{ code: 'A', kind: 'custom', mode: 'pct', rate: 80 }, { code: 'B', kind: 'custom', mode: 'pct', rate: 80 }];
  assert.strictEqual(r2(resolveOrderCodes(codes, [LINE]).total), 40000);
});
t('#D234: a code ADDS on top of the per-line entries instead of being replaced by them', () => {
  const pl = { total: 6940, diaPortion: 4240, mkPortion: 2700, totalPortion: 0 };
  const out = stackLineDiscount(pl, 2000, { diamond: 42400, taxable: 100000 });
  assert.strictEqual(r2(out.total), 8940);
  assert.strictEqual(r2(out.dia), 6240);
  assert.strictEqual(r2(out.mk), 2700);
});
t('no per-line entries: the line takes the order-level share alone (old behaviour)', () => {
  assert.deepStrictEqual(stackLineDiscount(null, 1500, { diamond: 40000, taxable: 100000 }), { total: 1500, dia: 1500, mk: 0, tot: 0 });
});
t('per-line diamond cut + code share is capped at the diamond', () => {
  const pl = { total: 30000, diaPortion: 30000, mkPortion: 0, totalPortion: 0 };
  const out = stackLineDiscount(pl, 20000, { diamond: 40000, taxable: 100000 });
  assert.strictEqual(out.dia, 40000);
  assert.strictEqual(out.total, 40000);
});
t('the whole line is capped at its taxable value and the split still adds up', () => {
  const pl = { total: 9000, diaPortion: 3000, mkPortion: 1000, totalPortion: 5000 };
  const out = stackLineDiscount(pl, 4000, { diamond: 8000, taxable: 10000 });
  assert.strictEqual(r2(out.total), 10000);
  assert.strictEqual(r2(out.dia + out.mk + out.tot), r2(out.total));
});

console.log('adding and removing codes');
t('applying a second code appends it', () => {
  const { codes, duplicate } = addCode([{ code: 'FNF5', kind: 'code', mode: 'pct', rate: 5 }], { code: 'LOYAL2', kind: 'code', mode: 'pct', rate: 2 });
  assert.strictEqual(duplicate, false);
  assert.deepStrictEqual(codes.map(c => c.code), ['FNF5', 'LOYAL2']);
});
t('re-applying the same code refreshes it rather than stacking it twice', () => {
  const { codes, duplicate } = addCode([{ code: 'FNF5', kind: 'code', mode: 'pct', rate: 5 }], { code: 'fnf5', kind: 'code', mode: 'pct', rate: 7 });
  assert.strictEqual(duplicate, true);
  assert.strictEqual(codes.length, 1);
  assert.strictEqual(codes[0].rate, 7);
});
t('a frozen-rupee legacy discount is kept, as a flat custom entry, when a code stacks on it', () => {
  const { codes } = addCode(readDiscountCodes({ discount_applied: '1500' }), { code: 'FNF5', kind: 'code', mode: 'pct', rate: 5 });
  assert.deepStrictEqual(codes.map(c => [c.kind, c.mode, c.rate]), [['custom', 'flat', 1500], ['code', 'pct', 5]]);
  assert.ok(JSON.parse(codeFields(codes).discount_codes).length === 2);
});
t('removing one code leaves the others', () => {
  const { codes, removed } = removeCode([{ code: 'FNF5' }, { code: 'LOYAL2' }], 'fnf5');
  assert.strictEqual(removed, 1);
  assert.deepStrictEqual(codes.map(c => c.code), ['LOYAL2']);
});
t('remove all', () => {
  assert.deepStrictEqual(removeCode([{ code: 'A' }, { code: 'B' }], 'all'), { codes: [], removed: 2 });
});
t('fields: the list, a comma-joined display label, and the last code in the single slot', () => {
  const f = codeFields([{ code: 'FNF5', kind: 'code', mode: 'pct', rate: 5 }, { code: 'LOYAL2', kind: 'code', mode: 'flat', rate: 500 }]);
  assert.strictEqual(f.discount_code, 'FNF5, LOYAL2');
  assert.strictEqual(f.discount_rate, '500.00');
  assert.strictEqual(f.discount_mode, 'flat');
});
t('an empty list deletes every code field', () => {
  assert.deepStrictEqual(codeFields([]), { discount_codes: null, discount_code: null, discount_rate: null, discount_mode: null, discount_kind: null });
});

console.log(`\n${n} assertions passed`);
