const assert = require('assert');
const R = require('./rules');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// ₹2,000 a month from 12 Nov 2026.
const START = '2026-11-12';
const plan = (months, over = {}) => ({ months, instalment: 2000, start_date: START, ...over });
const D10 = R.dueDates(START, 10);
const D6 = R.dueDates(START, 6);
const pay = (date, value = 2000) => ({ value, date });
const onTime = (dates, k) => dates.slice(0, k).map(d => pay(d));
const at = (p, legs, today) => R.savingsState(p, legs, today);

console.log('dates');
t('10 dates, first is the start date', () => {
  assert.strictEqual(D10.length, 10);
  assert.deepStrictEqual([D10[0], D10[5], D10[7], D10[9]], ['2026-11-12', '2027-04-12', '2027-06-12', '2027-08-12']);
});
t('matures month 7 / month 11', () => {
  assert.strictEqual(R.maturityDate(START, 6), '2027-05-12');
  assert.strictEqual(R.maturityDate(START, 10), '2027-09-12');
});

console.log('enrolment');
t('6 or 10 months, ₹2,000–₹1,00,000 in ₹100 steps', () => {
  assert.deepStrictEqual(R.enrolmentProblems({ months: 10, instalment: 2000 }), []);
  assert.deepStrictEqual(R.enrolmentProblems({ months: 6, instalment: 100000 }), []);
  assert.strictEqual(R.enrolmentProblems({ months: 8, instalment: 2000 }).length, 1);
  assert.strictEqual(R.enrolmentProblems({ months: 6, instalment: 1900 }).length, 1);
  assert.strictEqual(R.enrolmentProblems({ months: 6, instalment: 1000 }).length, 1);
  assert.strictEqual(R.enrolmentProblems({ months: 6, instalment: 100100 }).length, 1);
  assert.strictEqual(R.enrolmentProblems({ months: 6, instalment: 2050 }).length, 1);
});
t('instalment from the line: total ÷ months, only when it divides', () => {
  assert.strictEqual(R.instalmentFromLine(20000, 10), 2000);
  assert.strictEqual(R.instalmentFromLine(12000, 6), 2000);
  assert.strictEqual(R.instalmentFromLine(20001, 10), null);
});
t('the Savings Plan line is a custom line titled "Savings Plan"', () => {
  assert.ok(R.isSavingsLine({ title: 'Savings Plan', price: '20000.00' }));
  assert.ok(R.isSavingsLine({ title: ' savings plan ' }));
  assert.ok(!R.isSavingsLine({ title: 'Savings Plan', variant_id: 123 }));
  assert.ok(!R.isSavingsLine({ title: 'CAD Advance' }));
});

console.log('the design-document examples (₹2,000)');
t('6-month plan, all 6 paid: ₹12,000 + ₹1,000 = ₹13,000', () => {
  const r = at(plan(6), onTime(D6, 6), '2027-05-12').redeem;
  assert.deepStrictEqual([r.kind, r.pct, r.bonus, r.value], ['full', 50, 1000, 13000]);
});
t('10-month plan, all 10 paid: ₹20,000 + ₹2,000 = ₹22,000', () => {
  const r = at(plan(10), onTime(D10, 10), '2027-09-12').redeem;
  assert.deepStrictEqual([r.kind, r.pct, r.bonus, r.value], ['full', 100, 2000, 22000]);
});
t('10-month plan, early at month 6 with 5 paid: ₹10,500', () => {
  const r = at(plan(10), onTime(D10, 5), D10[5]).redeem;
  assert.deepStrictEqual([r.kind, r.pct, r.value], ['early', 25, 10500]);
});
t('10-month plan, early at month 8 with 7 paid: ₹15,000', () => {
  const r = at(plan(10), onTime(D10, 7), D10[7]).redeem;
  assert.deepStrictEqual([r.kind, r.pct, r.value], ['early', 50, 15000]);
});

console.log('late payments (7 days grace; 2 late → 75% of the bonus, 4 late → 50%)');
const lateAt = (dates, which) => dates.map((d, i) => pay(which.includes(i + 1) ? R.addDays(d, 10) : d));
t('paid on day 7 after the due date is on time; day 8 is late', () => {
  assert.strictEqual(at(plan(6), [pay(R.addDays(D6[0], 7))], D6[1]).lateCount, 0);
  assert.strictEqual(at(plan(6), [pay(R.addDays(D6[0], 8))], D6[1]).lateCount, 1);
});
t('1 late: the full bonus', () => {
  assert.strictEqual(at(plan(10), lateAt(D10, [3]), '2027-09-12').redeem.bonus, 2000);
});
t('2 late (not in a row): a quarter of the bonus lost — ₹1,500', () => {
  const r = at(plan(10), lateAt(D10, [2, 5]), '2027-09-12').redeem;
  assert.deepStrictEqual([r.bonus, r.value, r.bonusLost, r.pct], [1500, 21500, 500, 75]);
});
t('3 late: still 75%', () => {
  assert.strictEqual(at(plan(10), lateAt(D10, [2, 5, 8]), '2027-09-12').redeem.bonus, 1500);
});
t('4 late: half the bonus lost — ₹1,000', () => {
  const s = at(plan(10), lateAt(D10, [1, 3, 5, 7]), '2027-09-12');
  assert.deepStrictEqual([s.lateCount, s.terminateNow, s.redeem.bonus, s.redeem.value], [4, false, 1000, 21000]);
});
t('the cut applies to the early-redemption bonus too', () => {
  const r = at(plan(10), lateAt(D10.slice(0, 7), [2, 4]), D10[7]).redeem;
  assert.deepStrictEqual([r.kind, r.bonus, r.value], ['early', 750, 14750]);
});
t('a payment on its due date is on time', () => {
  assert.strictEqual(at(plan(6), onTime(D6, 3), D6[2]).lateCount, 0);
});
t('a payment typed in with no date counts as on time', () => {
  assert.strictEqual(at(plan(6), [{ value: 2000, slot: 1 }, { value: 2000, slot: 2 }], '2027-01-20').lateCount, 0);
});

console.log('closing: two late in a row');
t('a customer who stops after 4: instalment 5 late on day 8, the plan closes 8 days after instalment 6 is due', () => {
  const late5 = at(plan(10), onTime(D10, 4), R.addDays(D10[4], 8));
  assert.deepStrictEqual([late5.terminateNow, late5.warn, late5.closeOn, late5.closePair], [false, 'late', R.addDays(D10[5], 8), [5, 6]]);
  const before = at(plan(10), onTime(D10, 4), R.addDays(D10[5], 7));
  assert.deepStrictEqual([before.terminateNow, before.warn], [false, 'closing']);
  const s = at(plan(10), onTime(D10, 4), R.addDays(D10[5], 8));
  assert.ok(s.terminateNow);
  assert.deepStrictEqual(R.payoutFor(plan(10), s, 'terminated'), { ok: true, paid: 8000, pct: 0, bonus: 0, value: 8000, reason: null });
});
t('a late instalment then the next unpaid 8 days past its due date: closes', () => {
  const legs = [...onTime(D10, 2), pay(R.addDays(D10[2], 12))];   // 3 late
  assert.strictEqual(at(plan(10), legs, R.addDays(D10[3], 7)).terminateNow, false);
  assert.strictEqual(at(plan(10), legs, R.addDays(D10[3], 7)).warn, 'closing');
  assert.strictEqual(at(plan(10), legs, R.addDays(D10[3], 8)).terminateNow, true);
});
t('a late instalment then the next paid on time: the plan runs on', () => {
  const legs = [...onTime(D10, 2), pay(R.addDays(D10[2], 12)), pay(D10[3])];
  const s = at(plan(10), legs, R.addDays(D10[4], 1));
  assert.deepStrictEqual([s.terminateNow, s.lateCount, s.closePair], [false, 1, [5, 6]]);
});
t('two late payments in a row, both paid: closed all the same', () => {
  const legs = [...onTime(D10, 2), pay(R.addDays(D10[2], 9)), pay(R.addDays(D10[3], 9))];
  const s = at(plan(10), legs, R.addDays(D10[3], 9));
  assert.deepStrictEqual([s.terminateNow, s.closeOn, s.closePair], [true, R.addDays(D10[3], 8), [3, 4]]);
});
t('the last instalment never paid: closes 8 days after the maturity date', () => {
  const s = at(plan(6), onTime(D6, 5), R.addDays(D6[5], 9));
  assert.deepStrictEqual([s.terminateNow, s.closeOn], [false, R.addDays(R.maturityDate(START, 6), 8)]);
  assert.ok(at(plan(6), onTime(D6, 5), R.addDays(R.maturityDate(START, 6), 8)).terminateNow);
});
t('closed after 7 paid (month-8 step reached): keeps the 50% bonus, ₹14,000 + ₹1,000', () => {
  const s = at(plan(10), onTime(D10, 7), R.addDays(D10[8], 8));
  assert.ok(s.terminateNow);
  assert.deepStrictEqual(R.payoutFor(plan(10), s, 'terminated'), { ok: true, paid: 14000, pct: 50, bonus: 1000, value: 15000, reason: null });
});
t('closed after 5 paid (month-6 step reached): keeps the 25% bonus, ₹10,000 + ₹500', () => {
  const s = at(plan(10), onTime(D10, 5), R.addDays(D10[6], 8));
  assert.ok(s.terminateNow);
  assert.deepStrictEqual([R.payoutFor(plan(10), s, 'terminated').bonus, R.payoutFor(plan(10), s, 'terminated').value], [500, 10500]);
});
t('closed on the month-8 step with 2 late: 75% of the step bonus', () => {
  const s = at(plan(10), lateAt(D10.slice(0, 7), [2, 5]), R.addDays(D10[8], 8));
  assert.deepStrictEqual([s.terminateNow, R.payoutFor(plan(10), s, 'terminated').bonus], [true, 750]);
});
t('6-month plan closed: no step to keep, the money only', () => {
  const s = at(plan(6), onTime(D6, 3), R.addDays(D6[4], 8));
  assert.deepStrictEqual([s.terminateNow, R.payoutFor(plan(6), s, 'terminated').value], [true, 6000]);
});
t('stopping the plan after 6 paid at month 7: keeps the month-6 step bonus (25%)', () => {
  const s = at(plan(10), onTime(D10, 6), D10[6]);
  assert.deepStrictEqual(R.payoutFor(plan(10), s, 'stopped'), { ok: true, paid: 12000, pct: 25, bonus: 500, value: 12500, reason: null });
});
t('stopping before any step: the money paid, no bonus', () => {
  const s = at(plan(10), onTime(D10, 4), D10[4]);
  assert.deepStrictEqual(R.payoutFor(plan(10), s, 'stopped'), { ok: true, paid: 8000, pct: 0, bonus: 0, value: 8000, reason: null });
});
t('a plan paid in full at maturity cannot be stopped: only the full-bonus voucher', () => {
  const s = at(plan(10), onTime(D10, 10), R.maturityDate(START, 10));
  assert.strictEqual(R.payoutFor(plan(10), s, 'stopped').ok, false);
  assert.strictEqual(R.payoutFor(plan(10), s, 'full').bonus, 2000);
});

console.log('early redemption');
t('opens only from month 6 with 5 paid, not before', () => {
  assert.strictEqual(at(plan(10), onTime(D10, 5), R.addDays(D10[5], -1)).redeem.kind, 'none');
  assert.strictEqual(at(plan(10), onTime(D10, 4), D10[5]).redeem.kind, 'none');
});
t('5 instalments prepaid in month 2 do not open the month-6 step early', () => {
  const s = at(plan(10), [pay(START, 10000)], D10[1]);
  assert.deepStrictEqual([s.paidCount, s.redeem.kind], [5, 'none']);
});
t('month 8 with only 6 paid is still the 25% step', () => {
  assert.deepStrictEqual([at(plan(10), onTime(D10, 6), D10[7]).redeem.pct], [25]);
});
t('the 6-month plan has no early redemption', () => {
  const s = at(plan(6), onTime(D6, 5), D6[5]);
  assert.strictEqual(s.redeem.kind, 'none');
  assert.strictEqual(R.payoutFor(plan(6), s, 'early').ok, false);
});
t('early redemption is refused once the full bonus is due', () => {
  const s = at(plan(10), onTime(D10, 10), R.maturityDate(START, 10));
  assert.match(R.payoutFor(plan(10), s, 'early').reason, /full plan/);
});

console.log('paying ahead (prepaid): only the bonus earned so far');
t('the whole plan paid on day one: no bonus before the maturity date', () => {
  const s = at(plan(10), [pay(START, 20000)], START);
  assert.deepStrictEqual([s.fullyPaid, s.lateCount, s.redeem.kind, s.redeem.value], [true, 0, 'none', 20000]);
  assert.deepStrictEqual(R.payoutFor(plan(10), s, 'stopped'), { ok: true, paid: 20000, pct: 0, bonus: 0, value: 20000, reason: null });
  assert.strictEqual(R.payoutFor(plan(10), s, 'full').ok, false);
});
t('prepaid, redeemed in month 8: the month-8 step bonus (50%)', () => {
  const s = at(plan(10), [pay(START, 20000)], D10[7]);
  assert.deepStrictEqual([s.redeem.kind, s.redeem.value], ['early', 21000]);
});
t('prepaid and left to the maturity date: the full bonus', () => {
  const s = at(plan(10), [pay(START, 20000)], R.maturityDate(START, 10));
  assert.deepStrictEqual([s.redeem.kind, s.redeem.value], ['full', 22000]);
});
t('the rest prepaid in one go after some late months keeps the late count', () => {
  const legs = [pay(D6[0]), pay(R.addDays(D6[1], 9)), pay(D6[2]), pay(R.addDays(D6[3], 9), 6000)];
  const s = at(plan(6), legs, R.maturityDate(START, 6));
  assert.deepStrictEqual([s.paidCount, s.lateCount, s.redeem.value], [6, 2, 12750]);
});

console.log('odd amounts');
t('a part payment counts toward the next instalment and is flagged', () => {
  const s = at(plan(6), [pay(START), pay(D6[1], 1500)], D6[1]);
  assert.deepStrictEqual([s.paid, s.paidCount, s.oddPayments.length, s.dueNow], [3500, 1, 1, 500]);
});
t('the top-up covers the instalment on the day it lands', () => {
  const s = at(plan(6), [pay(START), pay(D6[1], 1500), pay(R.addDays(D6[1], 10), 500)], R.addDays(D6[1], 10));
  assert.deepStrictEqual([s.paidCount, s.lateCount], [2, 1]);
});
t('overpaying beyond the plan is reported and still counts on the voucher', () => {
  const s = at(plan(6), [pay(START, 12500)], R.maturityDate(START, 6));
  assert.deepStrictEqual([s.overpaid, s.redeem.value], [500, 13500]);
});

console.log('what is due now');
t('day one: one instalment; two missed months: two', () => {
  assert.strictEqual(at(plan(10), [], START).dueNow, 2000);
  assert.strictEqual(at(plan(10), [pay(START)], R.addDays(D10[2], 1)).dueNow, 4000);
  assert.strictEqual(at(plan(10), [pay(START)], R.addDays(D10[1], -1)).dueNow, 0);
});
t('rows show paid (with late flag), overdue, due and upcoming', () => {
  const s = at(plan(6), [pay(START), pay(R.addDays(D6[1], 9))], D6[3]);
  assert.deepStrictEqual(s.rows.map(r => r.status), ['paid', 'paid', 'overdue', 'due', 'upcoming', 'upcoming']);
  assert.deepStrictEqual(s.rows.map(r => Boolean(r.late)), [false, true, false, false, false, false]);
});

console.log('tags');
t('status tags', () => {
  assert.strictEqual(R.statusTag('active'), 'savings-in-progress');
  assert.strictEqual(R.statusTag('terminated'), 'savings-terminated');
  assert.ok(R.isSavingsStatusTag('Savings-Completed'));
  assert.ok(R.isSavingsDraftTags('foo, savings-plan'));
  assert.ok(!R.isSavingsDraftTags(['buy-plan']));
});

console.log(`\n${n} savings-plan rule tests passed`);
