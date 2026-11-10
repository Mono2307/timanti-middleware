const assert = require('assert');
const S = require('./schedule');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// A ₹1,20,000 plan started 22 Oct 2026. Due dates: 22 Oct, 22 Nov, 22 Dec, 22 Jan, 22 Feb, 22 Mar.
const START = '2026-10-22';
const plan = (over = {}) => ({ mode: 'equal', total: 120000, start_date: START, installments: 6, final_total: null, ...over });
const D = S.dueDates(START);
const pay = (date, value) => ({ value, date });
const at = (plan_, legs, today) => S.planState(plan_, legs, today);

console.log('dueDates');
t('six dates by default, first is the start date', () => {
  assert.deepStrictEqual(D, ['2026-10-22', '2026-11-22', '2026-12-22', '2027-01-22', '2027-02-22', '2027-03-22']);
});
t('4 or 5 installments', () => {
  assert.strictEqual(S.dueDates(START, 4).length, 4);
  assert.strictEqual(S.dueDates(START, 5)[4], '2027-02-22');
});
t('clamps to month end (31 Jan → 28 Feb)', () => assert.strictEqual(S.dueDates('2027-01-31')[1], '2027-02-28'));
t('rejects a bad start date', () => assert.deepStrictEqual(S.dueDates('nope'), []));

console.log('paying as agreed');
t('day one: total/6 due now', () => {
  const s = at(plan(), [], START);
  assert.deepStrictEqual([s.k, s.dueNow, s.balance], [1, 20000, 120000]);
});
t('six × 20,000 on the due dates clears the plan', () => {
  const s = at(plan(), D.map(d => pay(d, 20000)), '2027-03-22');
  assert.deepStrictEqual([s.balance, s.dueNow, s.upcoming], [0, 0, null]);
  assert.ok(s.rows.every(r => r.status === 'paid'));
});
t('after paying installment 1, nothing is due until the next date, which asks for 20,000', () => {
  const s = at(plan(), [pay(START, 20000)], '2026-11-10');
  assert.strictEqual(s.dueNow, 0);
  assert.deepStrictEqual(s.upcoming, { k: 2, due: '2026-11-22', amount: 20000 });
});
t('4 installments: total/4 each', () => {
  const s = at(plan({ installments: 4 }), [], START);
  assert.strictEqual(s.dueNow, 30000);
  assert.deepStrictEqual(s.rows.map(r => r.amount), [30000, 30000, 30000, 30000]);
});

console.log('paying more, paying less (founder, 2026-10-30)');
t('overpay 40,000 at #1 → the other five are 16,000', () => {
  const s = at(plan(), [pay(START, 40000)], START);
  assert.strictEqual(s.upcoming.amount, 16000);
  assert.deepStrictEqual(s.rows.slice(1).map(r => r.amount), [16000, 16000, 16000, 16000, 16000]);
});
t('a part-payment counts for the installment; the shortfall is spread over the rest', () => {
  const s = at(plan(), [pay(START, 5000)], '2026-11-01');
  assert.strictEqual(s.dueNow, 0);
  assert.strictEqual(s.upcoming.amount, 23000);   // 115,000 / 5
});
t('a missed installment is carried forward: the next asks for double', () => {
  const s = at(plan(), [], '2026-11-19');
  assert.strictEqual(s.upcoming.amount, 40000);
  const s2 = at(plan(), [], '2026-11-22');
  assert.deepStrictEqual([s2.k, s2.dueNow], [2, 40000]);
  assert.strictEqual(s2.rows[0].status, 'missed');
});
t('missed #1, paid 20,000 at #2 → 100,000 over #3..#6 = 25,000 each', () => {
  const s = at(plan(), [pay('2026-11-22', 20000)], '2026-11-25');
  assert.strictEqual(s.upcoming.amount, 25000);
  assert.deepStrictEqual(s.rows.slice(2).map(r => r.amount), [25000, 25000, 25000, 25000]);
});
t('paid 30,000 at #2 after missing #1 → 22,500 each', () => {
  assert.strictEqual(at(plan(), [pay('2026-11-22', 30000)], '2026-11-25').upcoming.amount, 22500);
});
t('the last installment is always the whole balance', () => {
  const s = at(plan(), [pay(START, 20000), pay('2026-11-22', 1000)], '2027-03-22');
  assert.deepStrictEqual([s.k, s.dueNow], [6, 99000]);
});
t('two payments in one installment both count', () => {
  const s = at(plan(), [pay(START, 10000), pay('2026-10-30', 10000)], '2026-11-01');
  assert.strictEqual(s.paidIn[1], 20000);
  assert.strictEqual(s.upcoming.amount, 20000);
});
t('a payment before the plan starts counts for installment 1', () => {
  assert.strictEqual(at(plan(), [pay('2026-10-01', 20000)], START).dueNow, 0);
});

console.log('the smallest payment');
t('Rs1,000, or the balance when less is left', () => {
  assert.strictEqual(S.validatePayment(at(plan(), [], START), 999).ok, false);
  assert.deepStrictEqual(S.validatePayment(at(plan(), [], START), 1000), { ok: true, amount: 1000 });
  const nearlyDone = at(plan(), [pay(START, 119500)], START);
  assert.strictEqual(nearlyDone.minPayment, 500);
  assert.strictEqual(S.validatePayment(nearlyDone, 500).ok, true);
});
t('accepts amounts typed with commas, ₹ or Rs', () => {
  const s = at(plan(), [], START);
  for (const v of ['20,000', '₹20,000', 'Rs 20,000', ' 20000 ']) assert.deepStrictEqual(S.validatePayment(s, v), { ok: true, amount: 20000 });
});
t('never more than the balance', () => assert.strictEqual(S.validatePayment(at(plan(), [], START), 120001).ok, false));

console.log('gold value first');
const gold = plan({ mode: 'gold', gold_value: 50000 });
t('installment 1 is the gold value; the rest over 5', () => {
  const s = at(gold, [pay(START, 50000)], START);
  assert.deepStrictEqual(s.rows.map(r => r.amount), [50000, 14000, 14000, 14000, 14000, 14000]);
});
t('with 4 installments the rest is over 3', () => {
  const s = at({ ...gold, installments: 4 }, [pay(START, 50000)], START);
  assert.strictEqual(s.upcoming.amount, 23334);
});

console.log('price changes');
t('equal plan: the final price changes only what is left', () => {
  const legs = D.slice(0, 5).map(d => pay(d, 20000));
  const p = plan({ final_total: 126000, price_changes: [{ date: '2027-03-19', total: 126000 }] });
  const s = at(p, legs, '2027-03-19');
  assert.deepStrictEqual([s.upcoming.k, s.upcoming.amount], [6, 26000]);
});
t('gold fell below what was paid: nothing left, a credit', () => {
  const p = plan({ final_total: 110000, price_changes: [{ date: '2027-03-19', total: 110000 }] });
  const s = at(p, [pay(START, 120000)], '2027-03-19');
  assert.deepStrictEqual([s.balance, s.credit], [0, 10000]);
});
t('product change re-spreads the new balance over the installments left', () => {
  const p = plan({ price_changes: [{ date: '2026-11-25', total: 150000 }] });
  const s = at(p, [pay(START, 20000), pay('2026-11-22', 20000)], '2026-11-25');
  assert.strictEqual(s.upcoming.amount, 27500);   // 110,000 over #3..#6
});
t('a cheaper piece than already paid: a credit', () => {
  const p = plan({ price_changes: [{ date: '2026-11-25', total: 30000 }] });
  assert.strictEqual(at(p, [pay(START, 20000), pay('2026-11-22', 20000)], '2026-11-25').credit, 10000);
});

console.log('closing for non-payment');
t('60 days with no payment after an installment fell due → closes', () => {
  const legs = [pay(START, 20000)];
  const s = at(plan(), legs, '2027-01-20');           // 22 Nov + 59
  assert.strictEqual(s.closure.close, false);
  assert.strictEqual(s.closure.closeOn, '2027-01-21');
  assert.strictEqual(at(plan(), legs, '2027-01-21').closure.close, true);
});
t('warnings at 30 and 45 days', () => {
  const legs = [pay(START, 20000)];
  assert.strictEqual(at(plan(), legs, '2026-12-21').closure.warn, null);
  assert.deepStrictEqual(at(plan(), legs, '2026-12-22').closure.warn, { kind: 'warn30', k: 2 });
  assert.deepStrictEqual(at(plan(), legs, '2027-01-06').closure.warn, { kind: 'warn45', k: 2 });
});
t('any payment restarts the clock', () => {
  const s = at(plan(), [pay(START, 20000), pay('2027-01-10', 1000)], '2027-02-20');
  assert.strictEqual(s.closure.close, false);
  // The payment fell in installment 3's period, so the clock runs from installment 4's date.
  assert.strictEqual(s.closure.overdueSince, '2027-01-22');
  assert.strictEqual(s.closure.closeOn, '2027-03-23');
});
t('the last installment unpaid 30 days after its date → closes', () => {
  const legs = D.slice(0, 5).map(d => pay(d, 20000));
  assert.strictEqual(at(plan(), legs, '2027-04-20').closure.close, false);
  assert.strictEqual(at(plan(), legs, '2027-04-21').closure.close, true);
  assert.deepStrictEqual(at(plan(), legs, '2027-04-06').closure.warn, { kind: 'last15', k: 6 });
});
t('a paid-off plan never closes', () => {
  assert.strictEqual(at(plan(), [pay(START, 120000)], '2028-01-01').closure.close, false);
});

t('six payments at most: after five, the next must be the whole balance', () => {
  const four = D.slice(0, 4).map(d => pay(d, 10000));
  const s4 = at(plan(), four, D[3]);
  assert.strictEqual(s4.lastPayment, false);
  assert.strictEqual(s4.minPayment, 1000);
  const s5 = at(plan(), [...four, pay(D[3], 10000)], D[3]);
  assert.strictEqual(s5.payments, 5);
  assert.strictEqual(s5.lastPayment, true);
  assert.strictEqual(s5.minPayment, 70000);
  assert.strictEqual(s5.suggested, 70000);
  assert.strictEqual(S.validatePayment(s5, 20000).ok, false);
  assert.match(S.validatePayment(s5, 20000).reason, /whole balance/);
  assert.strictEqual(S.validatePayment(s5, 70000).ok, true);
});

console.log(`\n${n} passed`);
