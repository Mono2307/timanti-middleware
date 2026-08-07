const assert = require('assert');
const {
  MAX_INSTALLMENTS, readInstallments, sumInstallments, installmentModes, installmentLegPatch,
} = require('./installments');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('readInstallments');
t('empty map yields no legs', () => {
  assert.deepStrictEqual(readInstallments({}), []);
  assert.deepStrictEqual(readInstallments(null), []);
});
t('reads value + mode + date, defaults type to payment', () => {
  const rows = readInstallments({ installment_1_value: '15000', installment_1_mode: 'upi', installment_1_date: '2026-07-14' });
  assert.deepStrictEqual(rows, [{ slot: 1, value: 15000, mode: 'upi', date: '2026-07-14', type: 'payment' }]);
});
t('is sparse-safe — slot 2 empty, slot 3 populated', () => {
  const rows = readInstallments({
    installment_1_value: '100', installment_3_value: '300', installment_3_mode: 'cash',
  });
  assert.deepStrictEqual(rows.map(r => r.slot), [1, 3]);
});
t('ignores zero, negative and non-numeric values', () => {
  assert.strictEqual(readInstallments({ installment_1_value: '0' }).length, 0);
  assert.strictEqual(readInstallments({ installment_1_value: '-5' }).length, 0);
  assert.strictEqual(readInstallments({ installment_1_value: '' }).length, 0);
  assert.strictEqual(readInstallments({ installment_1_value: 'abc' }).length, 0);
});
t('only slot 1 can be cad_advance', () => {
  const rows = readInstallments({
    installment_1_value: '5000', installment_1_type: 'cad_advance',
    installment_2_value: '2000', installment_2_type: 'cad_advance', // must be ignored
  });
  assert.strictEqual(rows[0].type, 'cad_advance');
  assert.strictEqual(rows[1].type, 'payment');
});
t('caps at MAX_INSTALLMENTS', () => {
  const map = {};
  for (let i = 1; i <= MAX_INSTALLMENTS + 3; i++) map[`installment_${i}_value`] = '10';
  assert.strictEqual(readInstallments(map).length, MAX_INSTALLMENTS);
});

console.log('sumInstallments');
t('sums the founder scenario: 15000 upi + 20000 card + 6379.49 cash', () => {
  const rows = readInstallments({
    installment_1_value: '15000',   installment_1_mode: 'upi',
    installment_2_value: '20000',   installment_2_mode: 'card',
    installment_3_value: '6379.49', installment_3_mode: 'cash',
  });
  assert.strictEqual(sumInstallments(rows), 41379.49);
});
t('EXCLUDES a cad_advance leg — the double-deduction guard', () => {
  const rows = readInstallments({
    installment_1_value: '5000', installment_1_mode: 'upi', installment_1_type: 'cad_advance',
    installment_2_value: '20000', installment_2_mode: 'card',
  });
  assert.strictEqual(sumInstallments(rows), 20000);
});
t('a cad_advance-only draft has zero collected', () => {
  const rows = readInstallments({ installment_1_value: '5000', installment_1_type: 'cad_advance' });
  assert.strictEqual(sumInstallments(rows), 0);
});
t('handles empty input', () => {
  assert.strictEqual(sumInstallments([]), 0);
  assert.strictEqual(sumInstallments(null), 0);
});

console.log('CAD advance end-to-end arithmetic (decision 1a)');
t('Path A: advance netted exactly once, customer still owes the product', () => {
  // Draft total INCLUDES the CAD Advance line: product 40000 + advance 5000.
  const total = 45000, advance = 5000;
  const rows = readInstallments({
    installment_1_value: '5000', installment_1_mode: 'upi', installment_1_type: 'cad_advance',
  });
  const netBase = total - advance;               // syncAmountToCollect
  const pending = Math.max(0, netBase - sumInstallments(rows));
  assert.strictEqual(pending, 40000);            // the product price, deducted once
});
t('without the cad_advance flag the same rupees would be deducted twice', () => {
  const total = 45000, advance = 5000;
  const rows = readInstallments({ installment_1_value: '5000', installment_1_mode: 'upi' });
  const pending = Math.max(0, (total - advance) - sumInstallments(rows));
  assert.strictEqual(pending, 35000);            // 5000 short — the bug the flag prevents
});

console.log('installmentModes');
t('dedupes and preserves slot order', () => {
  const rows = readInstallments({
    installment_1_value: '1', installment_1_mode: 'upi',
    installment_2_value: '2', installment_2_mode: 'card',
    installment_3_value: '3', installment_3_mode: 'upi',
  });
  assert.deepStrictEqual(installmentModes(rows), ['upi', 'card']);
});
t('drops blanks', () => {
  const rows = readInstallments({ installment_1_value: '1', installment_2_value: '2', installment_2_mode: 'cash' });
  assert.deepStrictEqual(installmentModes(rows), ['cash']);
});

console.log('installmentLegPatch');
t('first payment lands in slot 1', () => {
  assert.deepStrictEqual(installmentLegPatch([], { value: 15000, mode: 'upi', date: '2026-07-14' }), {
    installment_1_value: '15000.00', installment_1_mode: 'upi', installment_1_date: '2026-07-14',
  });
});
t('second payment lands in slot 2 and does not touch slot 1', () => {
  const rows = readInstallments({ installment_1_value: '15000', installment_1_mode: 'upi' });
  const patch = installmentLegPatch(rows, { value: 20000, mode: 'card', date: '2026-07-20' });
  assert.deepStrictEqual(patch, {
    installment_2_value: '20000.00', installment_2_mode: 'card', installment_2_date: '2026-07-20',
  });
});
t('fills the first FREE slot, not the next index', () => {
  const rows = readInstallments({ installment_1_value: '1', installment_3_value: '3' });
  const patch = installmentLegPatch(rows, { value: 2, mode: 'cash', date: '2026-07-21' });
  assert.strictEqual(patch.installment_2_value, '2.00');
});
t('a 5th payment folds into slot 4 rather than being dropped', () => {
  const map = {};
  for (let i = 1; i <= 4; i++) { map[`installment_${i}_value`] = '1000'; map[`installment_${i}_mode`] = 'cash'; }
  const rows = readInstallments(map);
  const patch = installmentLegPatch(rows, { value: 500, mode: 'upi', date: '2026-07-22' });
  assert.strictEqual(patch.installment_4_value, '1500.00');   // 1000 + 500, money preserved
});
t('appending never loses money across a full 4-leg sequence', () => {
  const legs = [
    { value: 15000, mode: 'upi',  date: '2026-07-14' },
    { value: 20000, mode: 'card', date: '2026-07-20' },
    { value: 6379.49, mode: 'cash', date: '2026-07-25' },
    { value: 1000, mode: 'pos',  date: '2026-07-26' },
    { value: 500,  mode: 'cash', date: '2026-07-27' },  // overflow
  ];
  let map = {};
  for (const leg of legs) Object.assign(map, installmentLegPatch(readInstallments(map), leg));
  const total = legs.reduce((s, l) => s + l.value, 0);
  assert.strictEqual(sumInstallments(readInstallments(map)), total);
});

console.log(`\n${n} assertions passed`);
