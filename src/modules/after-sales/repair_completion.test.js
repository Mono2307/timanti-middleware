const assert = require('assert');

// Enough env to construct the module graph; nothing here dials out.
process.env.SUPABASE_URL         ||= 'https://repair-completion-test.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL    ||= 'https://repair-completion-test.invalid';
const { resolveRepairCompletion, parseEnteredAmount } = require('./index');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// Why this file exists: the ready+final email is the only completion email, and two of its
// branches were wrong without anything failing. Pay-at-store showed the FINAL figure as
// "Estimated charges" (the quoted estimate was simply lost), and a final cost of 0 typed at
// Mark Complete was read as blank and replaced by the draft total — so a repair finished at no
// charge asked the customer to pay the full estimate.

console.log('parseEnteredAmount — blank is not zero');
t('absent / empty / whitespace / junk are null', () => {
  for (const v of [undefined, null, '', '   ', 'abc']) assert.strictEqual(parseEnteredAmount(v), null);
});
t('"0" is 0, not blank', () => assert.strictEqual(parseEnteredAmount('0'), 0));
t('Indian-format commas are tolerated', () => assert.strictEqual(parseEnteredAmount('3,500'), 3500));

console.log('resolveRepairCompletion — the ready+final branch table');
t('pay-at-store: Estimated is the quoted estimate, Payable is the final (spec path C)', () => {
  const r = resolveRepairCompletion({ finalCost: 2630, paidAmount: 0, storedEstimate: 3500, draftTotal: 3500 });
  assert.strictEqual(r.mode, 'collect');
  assert.strictEqual(r.estimateAmount, 3500);
  assert.strictEqual(r.effectiveFinal, 2630);
});
t('pay-at-store on an older draft with no stored estimate falls back to the draft total', () => {
  const r = resolveRepairCompletion({ finalCost: 2630, paidAmount: 0, storedEstimate: null, draftTotal: 3500 });
  assert.strictEqual(r.mode, 'collect');
  assert.strictEqual(r.estimateAmount, 3500);
});
t('no final entered, not prepaid: final derived from the draft total', () => {
  const r = resolveRepairCompletion({ finalCost: null, paidAmount: 0, draftTotal: 3500 });
  assert.strictEqual(r.mode, 'collect');
  assert.strictEqual(r.effectiveFinal, 3500);
  assert.strictEqual(r.derivedFrom, 'draft total');
});
t('an explicit 0, not prepaid, is honoured — free, nothing to pay', () => {
  const r = resolveRepairCompletion({ finalCost: 0, paidAmount: 0, draftTotal: 3500 });
  assert.strictEqual(r.mode, 'free');
  assert.strictEqual(r.effectiveFinal, 0);
});
t('an explicit 0 on a prepaid repair refunds what was paid', () => {
  const r = resolveRepairCompletion({ finalCost: 0, paidAmount: 3500, draftTotal: 3500 });
  assert.strictEqual(r.mode, 'refund');
  assert.strictEqual(r.delta, 3500);
});
t('complimentary tag wins over any amount — never asks for payment', () => {
  const r = resolveRepairCompletion({ finalCost: null, paidAmount: 0, draftTotal: 3500, isFree: true });
  assert.strictEqual(r.mode, 'free');
  assert.strictEqual(r.effectiveFinal, 0);
  const r2 = resolveRepairCompletion({ finalCost: 1200, paidAmount: 0, draftTotal: 3500, isFree: true });
  assert.strictEqual(r2.mode, 'free');
});
t('prepaid: refund / balance / settled keep estimate = paid so the arithmetic adds up', () => {
  const lower = resolveRepairCompletion({ finalCost: 2630, paidAmount: 3500, storedEstimate: 3500, draftTotal: 3500 });
  assert.deepStrictEqual([lower.mode, lower.delta, lower.estimateAmount], ['refund', 870, 3500]);
  const higher = resolveRepairCompletion({ finalCost: 4000, paidAmount: 3500, draftTotal: 3500 });
  assert.deepStrictEqual([higher.mode, higher.delta], ['balance', -500]);
  const same = resolveRepairCompletion({ finalCost: null, paidAmount: 3500, draftTotal: 3500 });
  assert.deepStrictEqual([same.mode, same.effectiveFinal, same.derivedFrom], ['settled', 3500, 'payment_amount']);
});
t('nothing anywhere resolves to free', () => {
  assert.strictEqual(resolveRepairCompletion({ finalCost: null, paidAmount: 0, draftTotal: 0 }).mode, 'free');
});

console.log(`\n${n} assertions passed`);
