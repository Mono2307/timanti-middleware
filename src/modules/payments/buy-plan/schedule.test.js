const assert = require('assert');
const { PLAN_INSTALLMENTS, dueDates, amountDue, replay, validatePayment, scheduleRows } = require('./schedule');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
const legs = (...vals) => vals.map((value, i) => ({ value, date: `2026-1${i % 3}-01` }));

console.log('dueDates');
t('six dates, first is the start date', () => {
  assert.deepStrictEqual(dueDates('2026-10-22'),
    ['2026-10-22', '2026-11-22', '2026-12-22', '2027-01-22', '2027-02-22', '2027-03-22']);
});
t('clamps to month end (31 Jan → 28 Feb)', () => {
  assert.strictEqual(dueDates('2027-01-31')[1], '2027-02-28');
  assert.strictEqual(dueDates('2027-01-31')[2], '2027-03-31');
});
t('rejects a bad start date', () => assert.deepStrictEqual(dueDates('nope'), []));

console.log('amountDue');
t('day 1 is total/6', () => assert.strictEqual(amountDue(1, 120000), 20000));
t('rounds up, never down', () => assert.strictEqual(amountDue(1, 100001), 16667));
t('last installment takes the whole balance', () => assert.strictEqual(amountDue(6, 16666), 16666));
t('zero balance owes nothing', () => assert.strictEqual(amountDue(3, 0), 0));

console.log('replay');
t('equal path: six × 20,000 clears the plan', () => {
  const s = replay(120000, legs(20000, 20000, 20000, 20000, 20000, 20000));
  assert.strictEqual(s.next, null);
  assert.strictEqual(s.balance, 0);
  assert.strictEqual(s.settled.length, 6);
});
t('no payments: installment 1 open, owes total/6', () => {
  const s = replay(120000, []);
  assert.deepStrictEqual([s.next, s.owed, s.balance], [1, 20000, 120000]);
});
t('overpay 40,000 at k=1 → k=2 owes 16,000', () => {
  const s = replay(120000, legs(40000));
  assert.deepStrictEqual([s.next, s.owed, s.balance], [2, 16000, 80000]);
});
t('short staff leg keeps the installment open with the shortfall owed', () => {
  const s = replay(120000, legs(15000));
  assert.deepStrictEqual([s.next, s.owed, s.balance], [1, 5000, 105000]);
  const s2 = replay(120000, legs(15000, 5000));
  assert.deepStrictEqual([s2.next, s2.owed], [2, 20000]);
});
t('one payment can clear the whole balance', () => {
  const s = replay(120000, legs(20000, 100000));
  assert.strictEqual(s.next, null);
  assert.strictEqual(s.owed, 0);
});
t('rounding remainder lands on k=6', () => {
  const s = replay(100001, legs(16667, 16667, 16667, 16667, 16667));
  assert.deepStrictEqual([s.next, s.owed, s.balance], [6, 16666, 16666]);
});
t('more legs than installments: the rest is owed on k=6', () => {
  const s = replay(120000, legs(20000, 20000, 20000, 20000, 20000, 10000));
  assert.deepStrictEqual([s.next, s.owed, s.balance], [6, 10000, 10000]);
});

console.log('validatePayment');
t('rejects below the minimum', () => {
  const r = validatePayment(replay(120000, []), 19999);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.min, 20000);
});
t('rejects above the balance', () => assert.strictEqual(validatePayment(replay(120000, []), 120001).ok, false));
t('accepts the minimum and any overpayment up to the balance', () => {
  assert.strictEqual(validatePayment(replay(120000, []), 20000).ok, true);
  assert.strictEqual(validatePayment(replay(120000, []), 120000).ok, true);
});
t('rejects any payment on a cleared plan', () => {
  assert.strictEqual(validatePayment(replay(120000, legs(120000)), 1).ok, false);
});

console.log('scheduleRows');
t('six rows that add up to the total on day 1', () => {
  const rows = scheduleRows({ total: 100001, start_date: '2026-10-22' }, [], '2026-10-22');
  assert.strictEqual(rows.length, PLAN_INSTALLMENTS);
  assert.strictEqual(rows.reduce((a, r) => a + r.amount, 0), 100001);
  assert.deepStrictEqual(rows.map(r => r.status), ['open', 'upcoming', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
});
t('after an overpayment the later rows shrink and still add up', () => {
  const rows = scheduleRows({ total: 120000, start_date: '2026-10-22' }, legs(40000), '2026-10-25');
  assert.strictEqual(rows[0].status, 'paid');
  assert.deepStrictEqual(rows.slice(1).map(r => r.amount), [16000, 16000, 16000, 16000, 16000]);
});
t('an open installment past its due date reads overdue', () => {
  const rows = scheduleRows({ total: 120000, start_date: '2026-10-22' }, legs(20000), '2026-11-30');
  assert.strictEqual(rows[1].status, 'overdue');
});

console.log(`\n${n} passed`);
