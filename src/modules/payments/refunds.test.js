const assert = require('assert');
const {
  MAX_REFUNDS, readRefunds, sumRefunds, refundLedgerKey, refundLegPatch, paymentState,
} = require('./refunds');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('readRefunds');
t('empty map yields no legs', () => {
  assert.deepStrictEqual(readRefunds({}), []);
  assert.deepStrictEqual(readRefunds(null), []);
});
t('reads value + mode + date + ref', () => {
  const rows = readRefunds({
    refund_1_value: '10000', refund_1_mode: 'upi', refund_1_date: '2026-08-30', refund_1_ref: 'UTR8891',
  });
  assert.deepStrictEqual(rows, [{ slot: 1, value: 10000, mode: 'upi', date: '2026-08-30', ref: 'UTR8891' }]);
});
t('is sparse-safe — slot 1 empty, slot 2 populated', () => {
  assert.deepStrictEqual(readRefunds({ refund_2_value: '500' }).map(r => r.slot), [2]);
});
t('ignores zero, negative and non-numeric values', () => {
  assert.strictEqual(readRefunds({ refund_1_value: '0' }).length, 0);
  assert.strictEqual(readRefunds({ refund_1_value: '-5' }).length, 0);
  assert.strictEqual(readRefunds({ refund_1_value: '' }).length, 0);
  assert.strictEqual(readRefunds({ refund_1_value: 'abc' }).length, 0);
});
t('caps at MAX_REFUNDS', () => {
  const map = {};
  for (let i = 1; i <= MAX_REFUNDS + 3; i++) map[`refund_${i}_value`] = '100';
  assert.strictEqual(readRefunds(map).length, MAX_REFUNDS);
});

console.log('sumRefunds');
t('sums every leg, always positive', () => {
  assert.strictEqual(sumRefunds(readRefunds({ refund_1_value: '10000', refund_2_value: '2500' })), 12500);
  assert.strictEqual(sumRefunds([]), 0);
  assert.strictEqual(sumRefunds(null), 0);
});

console.log('refundLedgerKey');
t('is the document name plus the slot', () => {
  assert.strictEqual(refundLedgerKey('#D189', 1), '#D189-R1');
  assert.strictEqual(refundLedgerKey('  #D189  ', 2), '#D189-R2');
});
t('two refunds on one draft do not collide', () => {
  assert.notStrictEqual(refundLedgerKey('#D189', 1), refundLedgerKey('#D189', 2));
});

console.log('refundLegPatch');
t('places the first leg in slot 1', () => {
  assert.deepStrictEqual(
    refundLegPatch([], { value: 10000, mode: 'upi', date: '2026-08-30', ref: 'UTR1' }),
    { refund_1_value: '10000.00', refund_1_mode: 'upi', refund_1_date: '2026-08-30', refund_1_ref: 'UTR1' });
});
t('places the next leg in the next free slot', () => {
  const rows = readRefunds({ refund_1_value: '10000' });
  assert.deepStrictEqual(
    refundLegPatch(rows, { value: 500, mode: 'cash', date: '2026-09-01', ref: '' }),
    { refund_2_value: '500.00', refund_2_mode: 'cash', refund_2_date: '2026-09-01' });
});
t('omits blank fields rather than writing empty — core/metafields skips blanks anyway', () => {
  const patch = refundLegPatch([], { value: 100, mode: '', date: '', ref: '' });
  assert.deepStrictEqual(patch, { refund_1_value: '100.00' });
});
t('slots exhausted folds into the last slot — a refund is never dropped', () => {
  const rows = readRefunds({ refund_1_value: '100', refund_2_value: '200' });
  const patch = refundLegPatch(rows, { value: 50, mode: 'neft', date: '2026-09-02', ref: 'UTR9' });
  assert.strictEqual(patch[`refund_${MAX_REFUNDS}_value`], '250.00');
  assert.strictEqual(patch[`refund_${MAX_REFUNDS}_mode`], 'neft');
});

console.log('paymentState — the refund arithmetic');
t('no refund behaves exactly as before', () => {
  const s = paymentState({ amountPaid: 50000, collectionBase: 100000 });
  assert.strictEqual(s.netPaid, 50000);
  assert.strictEqual(s.amountPending, 50000);
  assert.deepStrictEqual([s.isUnpaid, s.isPartial, s.isFull], [false, true, false]);
});
t('a partial refund raises the balance by exactly the refund', () => {
  const before = paymentState({ amountPaid: 50000, collectionBase: 100000 });
  const after  = paymentState({ amountPaid: 50000, amountRefunded: 10000, collectionBase: 100000 });
  assert.strictEqual(after.amountPending - before.amountPending, 10000);
  assert.strictEqual(after.netPaid, 40000);
});
t('the identity pending = net - paid + refunded holds', () => {
  const s = paymentState({ amountPaid: 50000, amountRefunded: 10000, collectionBase: 100000 });
  assert.strictEqual(s.amountPending, 100000 - 50000 + 10000);
});
t('amount_paid is never written down — refunds are a parallel dimension', () => {
  // The whole safety argument: reconcileDepositPaid takes max(deposit, legSum) so a payment figure
  // can never shrink. Nothing here reduces amountPaid, so the two never fight.
  const s = paymentState({ amountPaid: 50000, amountRefunded: 50000, collectionBase: 100000 });
  assert.strictEqual(s.netPaid, 0);
});
t('a FULL refund reads as unpaid, not partial — the bug this state exists to stop', () => {
  const s = paymentState({ amountPaid: 50000, amountRefunded: 50000, collectionBase: 100000 });
  assert.deepStrictEqual([s.isUnpaid, s.isPartial, s.isFull], [true, false, false]);
});
t('overpayment returned settles the document', () => {
  // Paid 100k against a 100k order, then the order contracted to 90k and 10k went back.
  const s = paymentState({ amountPaid: 100000, amountRefunded: 10000, collectionBase: 90000 });
  assert.strictEqual(s.amountPending, 0);
  assert.strictEqual(s.isFull, true);
});
t('contraction then a balance payment ties out to the order total', () => {
  // Paid 50k, refunded 10k, added a product back to 100k, paid the 60k balance.
  const s = paymentState({ amountPaid: 110000, amountRefunded: 10000, collectionBase: 100000 });
  assert.strictEqual(s.netPaid, 100000);
  assert.strictEqual(s.isFull, true);
});
t('float dust inside the 1-rupee epsilon still reads as fully paid', () => {
  const s = paymentState({ amountPaid: 100000.4, amountRefunded: 10000, collectionBase: 90000 });
  assert.strictEqual(s.isFull, true);
});
t('a refund of a few paise does not flip a paid document to unpaid', () => {
  const s = paymentState({ amountPaid: 100000, amountRefunded: 0.25, collectionBase: 90000 });
  assert.strictEqual(s.isFull, true);
});

console.log(`\n${n} assertions passed`);
