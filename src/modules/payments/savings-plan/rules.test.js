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
t('6 or 10 months, ₹1,000–₹1,00,000 in ₹100 steps', () => {
  assert.deepStrictEqual(R.enrolmentProblems({ months: 10, instalment: 2000 }), []);
  assert.deepStrictEqual(R.enrolmentProblems({ months: 6, instalment: 100000 }), []);
  assert.strictEqual(R.enrolmentProblems({ months: 8, instalment: 2000 }).length, 1);
  assert.strictEqual(R.enrolmentProblems({ months: 6, instalment: 900 }).length, 1);
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
t('10-month plan, all paid but 3 late: ₹20,000, no bonus', () => {
  const legs = D10.map((d, i) => pay(i >= 7 ? R.addDays(d, 5) : d));
  const s = at(plan(10), legs, '2027-09-12');
  assert.strictEqual(s.lateCount, 3);
  assert.deepStrictEqual([s.redeem.bonus, s.redeem.value, s.redeem.bonusLost], [0, 20000, 2000]);
});
t('10-month plan, 4 paid, 5th unpaid past 30 days: terminated, voucher ₹8,000', () => {
  const s = at(plan(10), onTime(D10, 4), R.addDays(D10[4], 31));
  assert.ok(s.terminateNow);
  assert.deepStrictEqual(R.payoutFor(plan(10), s, 'terminated'), { ok: true, paid: 8000, pct: 0, bonus: 0, value: 8000, reason: null });
});

console.log('late payments');
t('2 late keeps the bonus, the 3rd loses it', () => {
  const two = D10.map((d, i) => pay(i < 2 ? R.addDays(d, 1) : d));
  assert.strictEqual(at(plan(10), two, '2027-09-12').redeem.bonus, 2000);
  const three = D10.map((d, i) => pay(i < 3 ? R.addDays(d, 1) : d));
  assert.strictEqual(at(plan(10), three, '2027-09-12').redeem.bonus, 0);
});
t('the late rule also takes the early-redemption bonus', () => {
  const legs = D10.slice(0, 5).map((d, i) => pay(i < 3 ? R.addDays(d, 2) : d));
  const r = at(plan(10), legs, D10[5]).redeem;
  assert.deepStrictEqual([r.kind, r.bonus, r.value], ['early', 0, 10000]);
});
t('a payment on its due date is on time', () => {
  assert.strictEqual(at(plan(6), onTime(D6, 3), D6[2]).lateCount, 0);
});
t('a payment typed in with no date counts as on time', () => {
  assert.strictEqual(at(plan(6), [{ value: 2000, slot: 1 }, { value: 2000, slot: 2 }], '2027-01-20').lateCount, 0);
});

console.log('grace and termination');
t('day 30 after the due date may still be paid (late); day 31 terminates', () => {
  const due = D10[3];
  const s30 = at(plan(10), onTime(D10, 3), R.addDays(due, 30));
  assert.deepStrictEqual([s30.terminateNow, s30.overdueDays, s30.warn], [false, 30, 'grace25']);
  const paidDay30 = at(plan(10), [...onTime(D10, 3), pay(R.addDays(due, 30))], R.addDays(due, 30));
  assert.deepStrictEqual([paidDay30.paidCount, paidDay30.lateCount, paidDay30.terminateNow], [4, 1, false]);
  assert.ok(at(plan(10), onTime(D10, 3), R.addDays(due, 31)).terminateNow);
});
t('grace warnings at day 15 and day 25', () => {
  const due = D10[2];
  assert.strictEqual(at(plan(10), onTime(D10, 2), R.addDays(due, 14)).warn, null);
  assert.strictEqual(at(plan(10), onTime(D10, 2), R.addDays(due, 15)).warn, 'grace15');
  assert.strictEqual(at(plan(10), onTime(D10, 2), R.addDays(due, 25)).warn, 'grace25');
});
t('termination pays back the money only, even on an early-redemption step', () => {
  const s = at(plan(10), onTime(D10, 7), R.addDays(D10[7], 31));
  assert.ok(s.terminateNow);
  assert.strictEqual(R.payoutFor(plan(10), s, 'terminated').value, 14000);
});
t('stopping the plan: the money paid, no bonus for the months reached', () => {
  const s = at(plan(10), onTime(D10, 6), D10[6]);
  assert.deepStrictEqual(R.payoutFor(plan(10), s, 'stopped'), { ok: true, paid: 12000, pct: 0, bonus: 0, value: 12000, reason: null });
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
t('early redemption is refused once every instalment is paid', () => {
  const s = at(plan(10), onTime(D10, 10), D10[9]);
  assert.match(R.payoutFor(plan(10), s, 'early').reason, /full plan/);
});

console.log('paying ahead (prepaid)');
t('the whole plan paid on day one: full bonus straight away', () => {
  const s = at(plan(10), [pay(START, 20000)], START);
  assert.deepStrictEqual([s.fullyPaid, s.lateCount, s.redeem.kind, s.redeem.value], [true, 0, 'full', 22000]);
});
t('the rest prepaid in one go after some late months keeps the late count', () => {
  const legs = [pay(R.addDays(D6[0], 0)), pay(R.addDays(D6[1], 3)), pay(R.addDays(D6[2], 3)), pay(D6[3], 6000)];
  const s = at(plan(6), legs, D6[3]);
  assert.deepStrictEqual([s.paidCount, s.lateCount, s.redeem.value], [6, 2, 13000]);
});

console.log('odd amounts');
t('a part payment counts toward the next instalment and is flagged', () => {
  const s = at(plan(6), [pay(START), pay(D6[1], 1500)], D6[1]);
  assert.deepStrictEqual([s.paid, s.paidCount, s.oddPayments.length, s.dueNow], [3500, 1, 1, 500]);
});
t('the top-up covers the instalment on the day it lands', () => {
  const s = at(plan(6), [pay(START), pay(D6[1], 1500), pay(R.addDays(D6[1], 4), 500)], R.addDays(D6[1], 4));
  assert.deepStrictEqual([s.paidCount, s.lateCount], [2, 1]);
});
t('overpaying beyond the plan is reported and still counts on the voucher', () => {
  const s = at(plan(6), [pay(START, 12500)], START);
  assert.deepStrictEqual([s.overpaid, s.redeem.value], [500, 13500]);
});

console.log('what is due now');
t('day one: one instalment; two missed months: two', () => {
  assert.strictEqual(at(plan(10), [], START).dueNow, 2000);
  assert.strictEqual(at(plan(10), [pay(START)], R.addDays(D10[2], 1)).dueNow, 4000);
  assert.strictEqual(at(plan(10), [pay(START)], R.addDays(D10[1], -1)).dueNow, 0);
});
t('rows show paid (with late flag), overdue, due and upcoming', () => {
  const s = at(plan(6), [pay(START), pay(R.addDays(D6[1], 2))], D6[3]);
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
