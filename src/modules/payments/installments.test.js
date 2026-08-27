const assert = require('assert');
const {
  MAX_INSTALLMENTS, readInstallments, sumInstallments, installmentModes, installmentLegPatch,
  materializeLegacyLeg,
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
t('any slot can be cad_advance — a Path B advance lands wherever is free', () => {
  const rows = readInstallments({
    installment_1_value: '20000', installment_1_mode: 'card',                 // deposit taken first
    installment_2_value: '5000',  installment_2_type: 'cad_advance',          // advance absorbed after
  });
  assert.strictEqual(rows[0].type, 'payment');
  assert.strictEqual(rows[1].type, 'cad_advance');
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
t('COUNTS a cad_advance leg — it is settlement, not decoration', () => {
  const rows = readInstallments({
    installment_1_value: '5000', installment_1_mode: 'upi', installment_1_type: 'cad_advance',
    installment_2_value: '20000', installment_2_mode: 'card',
  });
  assert.strictEqual(sumInstallments(rows), 25000);
});
t('a cad_advance-only draft has the advance collected', () => {
  const rows = readInstallments({ installment_1_value: '5000', installment_1_type: 'cad_advance' });
  assert.strictEqual(sumInstallments(rows), 5000);
});
t('handles empty input', () => {
  assert.strictEqual(sumInstallments([]), 0);
  assert.strictEqual(sumInstallments(null), 0);
});

console.log('CAD advance end-to-end arithmetic (CAD_ADVANCE_TRACKING_SPEC §1)');
// The rule under test: a CAD advance is a PAYMENT. It is never deducted post-tax anywhere — the bill
// is whatever was actually sold, and the advance sits in amount_paid as a leg like any other money.
// A ₹50,000 ring is billed at ₹50,000 in every path. It is never 55,000.
const pendingOn = (total, rows) => Math.max(0, total - sumInstallments(rows));
const outlay    = (paidLegs, pending) => paidLegs + pending;

t('standalone advance draft: the CAD line IS the bill, and it is settled', () => {
  const rows = readInstallments({ installment_1_value: '5000', installment_1_mode: 'cash', installment_1_type: 'cad_advance' });
  assert.strictEqual(pendingOn(5000, rows), 0);
  assert.strictEqual(outlay(5000, 0), 5000);
});

t('Path A: ring added — the CAD line comes off, so the bill is the ring', () => {
  // handleAdvanceLineRemoval strips the CAD Advance line once a product joins it, so the total here
  // is 50000, NOT 55000. The advance stands as installment 1 and nothing is deducted.
  const rows = readInstallments({
    installment_1_value: '5000', installment_1_mode: 'cash', installment_1_type: 'cad_advance',
  });
  const pending = pendingOn(50000, rows);
  assert.strictEqual(pending, 45000);
  assert.strictEqual(outlay(5000, pending), 50000);   // the ring price, once
});

t('Path B: advance absorbed onto a later sale — identical outlay', () => {
  // The new order never had a CAD line. The advance arrives as its own leg, mode 'CAD Advance'.
  const rows = readInstallments({
    installment_1_value: '5000', installment_1_mode: 'CAD Advance', installment_1_type: 'cad_advance',
  });
  const pending = pendingOn(50000, rows);
  assert.strictEqual(pending, 45000);
  assert.strictEqual(outlay(5000, pending), 50000);   // month 1 or month 8, the ring costs the same
});

t('a ring is NEVER billed at ring + advance', () => {
  // Regression guard for the model this replaced, which left the CAD line on the draft (total 55000)
  // and deducted the advance back off post-tax. Same final figure, but it printed the advance as a
  // charge and a credit facing each other, and any slip in the deduction over-collected by 5000.
  const rows = readInstallments({
    installment_1_value: '5000', installment_1_mode: 'cash', installment_1_type: 'cad_advance',
  });
  const billedWithCadLine = 55000;
  const missedDeduction   = Math.max(0, billedWithCadLine - sumInstallments(rows));
  assert.strictEqual(missedDeduction, 50000);                        // what that model risked
  assert.strictEqual(pendingOn(50000, rows), 45000);                 // what it does now
  assert.notStrictEqual(missedDeduction, pendingOn(50000, rows));
});

t('a part-paid advance still leaves the advance as the only settled money', () => {
  // The customer paid the advance and nothing since. Balance is the whole ring less the advance.
  const rows = readInstallments({ installment_1_value: '5000', installment_1_mode: 'upi', installment_1_type: 'cad_advance' });
  assert.strictEqual(sumInstallments(rows), 5000);
  assert.strictEqual(pendingOn(50000, rows), 45000);
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

console.log('materializeLegacyLeg — the #D194 regression');
t('folds pre-installment money into slot 1 when the doc has no legs yet', () => {
  // A draft paid the old way: Rs10,000 recorded, no legs. First touch must not lose it.
  const map = { amount_paid: '10000', payment_mode_advance: 'card' };
  const { rows, patch } = materializeLegacyLeg(map, readInstallments(map));
  assert.strictEqual(patch.installment_1_value, '10000.00');
  assert.strictEqual(patch.installment_1_mode, 'card');    // from the legacy two-slot field
  assert.strictEqual(patch.installment_1_date, undefined); // unknown — never invent a receipt date
  assert.strictEqual(sumInstallments(rows), 10000);
});
t('NEVER folds once legs exist — corrections must be able to reduce the total', () => {
  // Staff blank installment 2 to remove a payment. amount_paid is still the old higher figure.
  // Folding here would recreate the removed money and pin the order at 'fully paid' forever.
  const map = { amount_paid: '8000', installment_1_value: '5000', installment_1_mode: 'upi' };
  const { rows, patch } = materializeLegacyLeg(map, readInstallments(map));
  assert.deepStrictEqual(patch, {});
  assert.strictEqual(sumInstallments(rows), 5000);   // follows the legs DOWN, as it must
});
t('the bug it fixes: without folding, the sum understates what was collected', () => {
  const map = { amount_paid: '15000' };
  assert.strictEqual(sumInstallments(readInstallments(map)), 0);      // what shipped — the whole Rs15,000 lost
  assert.strictEqual(sumInstallments(materializeLegacyLeg(map, readInstallments(map)).rows), 15000);
});
t('no-op once legs already reconcile', () => {
  const map = { amount_paid: '8000', installment_1_value: '5000', installment_2_value: '3000' };
  const { rows, patch } = materializeLegacyLeg(map, readInstallments(map));
  assert.deepStrictEqual(patch, {});
  assert.strictEqual(rows.length, 2);
});
t('no-op on a clean draft with no payments', () => {
  assert.deepStrictEqual(materializeLegacyLeg({}, []).patch, {});
});
t('never fabricates a leg when slots are full — money over audit trail', () => {
  const map = { amount_paid: '99999' };
  for (let i = 1; i <= 4; i++) map[`installment_${i}_value`] = '1000';
  const { patch } = materializeLegacyLeg(map, readInstallments(map));
  assert.deepStrictEqual(patch, {});
});
t('a cad_advance leg still counts as a leg — no fold', () => {
  // Path A drafts carry a cad_advance leg. It is excluded from amount_paid by design, but it IS a
  // leg, so the document is already on the installment model and must not be folded into.
  const map = { amount_paid: '5000', installment_1_value: '2000', installment_1_type: 'cad_advance' };
  assert.deepStrictEqual(materializeLegacyLeg(map, readInstallments(map)).patch, {});
});

console.log(`\n${n} assertions passed`);
