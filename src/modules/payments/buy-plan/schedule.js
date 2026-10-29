'use strict';

// Buy plan — the schedule and the money rule. Pure functions, no I/O.
//
// A buy plan is the fixed, non-configurable 6-installment plan: the customer pays the net-to-collect
// over six monthly installments. Installment 1 is due the day the plan starts; 2..6 fall on the same
// day-of-month in the following five months. There are exactly two ways to run it (founder, 2026-10-24):
//
//   'gold'   GOLD VALUE FIRST. Installment 1 is the gold value of the pieces (before GST) and is
//            paid before the plan starts. Paying it locks the gold rate: the price never changes
//            again, and the rest is spread evenly over installments 2..6.
//   'equal'  EQUAL INSTALLMENTS. Six equal installments of total/6 at today's price, but the gold
//            rate is NOT locked: on the date of installment 6 the draft is repriced at that day's
//            rate, and the last installment is whatever the new price leaves (more or less).
//
// THE MONEY RULE. The amount due on installment k is the balance spread evenly over the installments
// still to come — ceil(balance / (6 - k + 1)), the last one taking whatever is left. On day 1 that is
// total/6. Paying MORE lowers every later installment (the balance is smaller, the divisor the same).
// Paying LESS is not allowed: the amount due is also the minimum a payment link may be raised for.
//
// Staff can still record a short cash/UPI leg by hand in the panel, so the replay below has to cope
// with one: a short leg leaves the installment open with the shortfall still owed, and the next leg
// settles it. It never shifts the schedule.

const { addMonths } = require('../../adjustments/cad_advance');

const PLAN_INSTALLMENTS = 6;

// Six YYYY-MM-DD due dates, the first being the start date itself.
function dueDates(startDate) {
  const start = String(startDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return [];
  return Array.from({ length: PLAN_INSTALLMENTS }, (_, i) => (i === 0 ? start : addMonths(start, i)));
}

// Amount due on installment k (1-based) given the balance outstanding when it opens.
function amountDue(k, balance) {
  const bal = Math.max(0, Math.round(Number(balance) || 0));
  if (bal === 0) return 0;
  if (k >= PLAN_INSTALLMENTS) return bal;
  return Math.min(bal, Math.ceil(bal / (PLAN_INSTALLMENTS - k + 1)));
}

// Replay the payment legs (oldest first) against the plan total.
// Returns where the plan stands right now:
//   next     — the open installment (1..6), or null once the balance is cleared
//   owed     — what is still owed on that installment = the minimum the next payment may be
//   balance  — total minus everything paid
//   paid     — sum of the legs
//   settled  — [{ k, settledOn }] for every installment closed so far
//   credit   — paid beyond the final price (equal plan, gold fell): the store owes this back
// opts.firstDue   — installment 1 is this amount instead of total/6 (the gold plan's gold value)
// opts.finalTotal — the equal plan's price after its final reprice. Installments 1..5 stay measured
//                   against the original total (a payment made in month 2 cannot become "short"
//                   because gold moved in month 6); only the balance, and so installment 6, moves.
function replay(total, legs, { firstDue = null, finalTotal = null } = {}) {
  const planTotal = Math.max(0, Math.round(Number(total) || 0));
  const first = Math.round(Number(firstDue) || 0);
  const dueOn = (k, bal) => (k === 1 && first > 0 ? Math.min(bal, first) : amountDue(k, bal));
  let balance = planTotal;
  let k = 1;
  let owed = dueOn(k, balance);
  const settled = [];

  for (const leg of legs || []) {
    const v = Math.round(Number(leg && leg.value) || 0);
    if (v <= 0 || balance <= 0) continue;
    balance = Math.max(0, balance - v);
    if (v >= owed || balance === 0) {
      settled.push({ k, settledOn: (leg && leg.date) || null });
      k++;
      owed = k > PLAN_INSTALLMENTS ? balance : dueOn(k, balance);
    } else {
      owed -= v;
    }
  }

  // Overflow: more installments settled than the plan has (only possible if staff split a payment
  // oddly). Whatever balance remains is owed against the last installment.
  if (k > PLAN_INSTALLMENTS && balance > 0) { k = PLAN_INSTALLMENTS; owed = balance; }

  const base = {
    next: balance > 0 ? k : null,
    owed: balance > 0 ? owed : 0,
    balance,
    paid: planTotal - balance,
    settled,
    credit: 0,
  };
  if (finalTotal === null || finalTotal === undefined || finalTotal === '') return base;

  const fin = Math.max(0, Math.round(Number(finalTotal) || 0));
  const paid = (legs || []).reduce((sum, l) => sum + Math.max(0, Math.round(Number(l && l.value) || 0)), 0);
  const bal = Math.max(0, fin - paid);
  if (bal === 0) return { ...base, next: null, owed: 0, balance: 0, paid, credit: paid - fin };
  // Installments 1..5 still open: the old amount due stands. Otherwise installment 6 is the rest.
  if (base.next && base.next < PLAN_INSTALLMENTS) return { ...base, owed: Math.min(base.owed, bal), balance: bal, paid };
  return { ...base, next: PLAN_INSTALLMENTS, owed: bal, balance: bal, paid };
}

// The plan's state from its row: the gold plan's first installment, the equal plan's final price.
function planState(plan, legs) {
  return replay(plan.total, legs, {
    firstDue: plan.mode === 'gold' ? plan.gold_value : null,
    finalTotal: plan.mode === 'equal' ? plan.final_total : null,
  });
}

// An equal plan whose last installment has not been priced yet.
const awaitingFinalPrice = (plan) => plan.mode === 'equal' && (plan.final_total === null || plan.final_total === undefined);

// Validate a requested payment amount against the plan's current state.
// Returns { ok: true, amount } or { ok: false, reason, min, max }.
function validatePayment(state, amount) {
  const amt = Math.round(Number(amount) || 0);
  const min = state.owed;
  const max = state.balance;
  if (!state.next || max <= 0) return { ok: false, reason: 'Plan is fully paid', min: 0, max: 0 };
  if (amt < min) return { ok: false, reason: `Minimum payment is Rs${min}`, min, max };
  if (amt > max) return { ok: false, reason: `Maximum payment is the balance, Rs${max}`, min, max };
  return { ok: true, amount: amt };
}

// The full 6-row schedule for display: due date, amount due (projected from the current balance for
// installments not yet open) and status. "Projected" because a future overpayment changes them.
function scheduleRows(plan, legs, today) {
  const dates = plan.due_dates && plan.due_dates.length ? plan.due_dates : dueDates(plan.start_date);
  const state = planState(plan, legs);
  const now = String(today || new Date().toISOString()).slice(0, 10);
  const estimate = awaitingFinalPrice(plan);
  const settledBy = new Map(state.settled.map(s => [s.k, s.settledOn]));

  // Later installments: project by paying each open one at exactly its minimum.
  let projected = state.balance - state.owed;
  return dates.map((due, i) => {
    const k = i + 1;
    if (settledBy.has(k)) return { k, due, amount: null, status: 'paid', paidOn: settledBy.get(k) };
    if (!state.next || k < state.next) return { k, due, amount: 0, status: 'paid', paidOn: null };
    // The equal plan's installment 6 is only an estimate at today's price until it is repriced.
    const est = estimate && k === PLAN_INSTALLMENTS;
    if (k === state.next) return { k, due, amount: state.owed, status: due < now ? 'overdue' : 'open', estimate: est };
    const amount = amountDue(k, projected);
    projected -= amount;
    return { k, due, amount, status: 'upcoming', estimate: est };
  });
}

module.exports = { PLAN_INSTALLMENTS, dueDates, amountDue, replay, planState, awaitingFinalPrice, validatePayment, scheduleRows };
