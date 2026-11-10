'use strict';

// Buy plan — the schedule and the money rules. Pure functions, no I/O.
//
// A buy plan is 4, 5 or 6 monthly installments (staff choose at the start; 6 by default).
// Installment 1 is due the day the plan starts; the rest fall on the same day-of-month in the
// months after. Each installment owns the PERIOD from its due date to the next one. Two ways to run
// it (founder, 2026-10-24 / 2026-10-30):
//
//   'gold'   GOLD VALUE FIRST. Installment 1 is the gold value of the pieces (before GST), paid
//            before the plan starts. That locks the gold rate; the rest, GST included, is spread
//            over the installments after it.
//   'equal'  EQUAL INSTALLMENTS. total/n each at today's price, the gold rate NOT locked: 3 days
//            before the last due date the draft is repriced at that day's rate, and the last
//            installment is whatever the new price leaves. A gold plan whose product is changed
//            becomes this kind (its lock is gone for good).
//
// THE MONEY RULES (founder, 2026-10-30).
//   - The plan keeps a standing installment amount A. On day 1, A = total/n (gold: the gold value).
//   - A period with NO payment carries its whole amount forward: the next one asks for both.
//   - ANY payment in a period (at least MIN_PAYMENT, or the balance if smaller) counts for that
//     period, and whatever is still unpaid is re-spread evenly over the installments after it.
//     So paying more lowers the later ones and paying less raises them; a missed month doubles the
//     next, and paying again re-spreads.
//   - The last installment is always the whole balance.
//   - A price change (product change, the equal plan's final reprice) re-spreads the new balance
//     over the installments still to come.
//
// FORFEITURE. The plan closes (the money paid becomes a voucher, see forfeit.js) when either:
//   - CLOSE_AFTER_DAYS pass with no payment while an installment is unpaid, counted from the first
//     due date after the last period that saw a payment; or
//   - the balance is still unpaid LAST_CLOSE_AFTER_DAYS after the last due date.
// The customer is warned at WARN_DAYS / LAST_WARN_DAYS.

const { addMonths } = require('../../adjustments/cad_advance');

const PLAN_INSTALLMENTS = 6;
const INSTALLMENT_CHOICES = [4, 5, 6];
const MIN_PAYMENT = 1000;
const MAX_PAYMENTS = 6;
const CLOSE_AFTER_DAYS = 60;
const WARN_DAYS = [30, 45];
const LAST_CLOSE_AFTER_DAYS = 30;
const LAST_WARN_DAYS = [15, 25];

const iso = (v) => String(v || '').slice(0, 10);
const isIso = (v) => /^\d{4}-\d{2}-\d{2}$/.test(iso(v));
const daysBetween = (fromIso, toIso) =>
  Math.round((Date.parse(`${iso(toIso)}T00:00:00Z`) - Date.parse(`${iso(fromIso)}T00:00:00Z`)) / 86400000);
const addDays = (d, n) => new Date(Date.parse(`${iso(d)}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const r0 = (v) => Math.round(Number(v) || 0);

// n YYYY-MM-DD due dates, the first being the start date itself.
function dueDates(startDate, n = PLAN_INSTALLMENTS) {
  const start = iso(startDate);
  if (!isIso(start)) return [];
  return Array.from({ length: n }, (_, i) => (i === 0 ? start : addMonths(start, i)));
}

const countOf = (plan) => Number(plan.installments) || (plan.due_dates || []).length || PLAN_INSTALLMENTS;
const datesOf = (plan) => ((plan.due_dates || []).length ? plan.due_dates.map(iso) : dueDates(plan.start_date, countOf(plan)));

// The installment whose period a date falls in (1..n). Before the start counts as installment 1.
function periodOf(date, dates) {
  let k = 1;
  for (let i = 0; i < dates.length; i++) if (dates[i] <= iso(date)) k = i + 1;
  return k;
}

// Floating = repriced on the last date: an equal plan, or a gold plan whose product was changed.
const floats = (plan) => plan.mode === 'equal';
const hasFinalPrice = (plan) => plan.final_total !== null && plan.final_total !== undefined && plan.final_total !== '';
const awaitingFinalPrice = (plan) => floats(plan) && !hasFinalPrice(plan);

// Every price the plan has had after its start, oldest first: product changes and the final reprice.
function priceChanges(plan) {
  const list = (plan.price_changes || []).filter(c => c && isIso(c.date) && Number(c.total) >= 0)
    .map(c => ({ date: iso(c.date), total: r0(c.total) }));
  if (hasFinalPrice(plan) && !list.length) {
    // Plans priced before price_changes existed: the final price, dated when it was set.
    const dates = datesOf(plan);
    list.push({ date: iso(plan.final_repriced_at) || dates[dates.length - 1], total: r0(plan.final_total) });
  }
  return list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
const currentTotal = (plan) => { const c = priceChanges(plan); return c.length ? c[c.length - 1].total : r0(plan.total); };

// Where the plan stands on `today`, from its payments (the draft's installment legs).
// Returns:
//   n, k          the number of installments; the one whose period today is in
//   total         the price now (after any product change / final reprice)
//   paid, balance, credit (paid beyond the price: owed back to the customer)
//   dueNow        what installment k still asks for (0 once anything was paid in its period, except
//                 on the last installment, which is always the whole balance)
//   upcoming      { k, due, amount } — the next due date and what it will ask for if nothing more is
//                 paid before it (a carried-forward amount included), or null on the last one
//   paidIn[k]     paid in each installment's period (1-based)
//   closure       { overdueSince, closeOn, close, warn } — see FORFEITURE above
//   rows          the schedule for display (see scheduleRows)
function planState(plan, legs, today = new Date().toISOString()) {
  const n = countOf(plan);
  const dates = datesOf(plan);
  const now = iso(today);
  // A gold plan's installment 1 is its gold value. (Once a gold plan's product is changed it is an
  // equal plan, but installment 1 was paid before it started, so the history replays the same.)
  const firstDue = plan.mode === 'gold' ? r0(plan.gold_value) : 0;

  const events = [];
  for (let q = 2; q <= n; q++) if (dates[q - 1] <= now) events.push({ date: dates[q - 1], order: 0, kind: 'period' });
  for (const leg of legs || []) {
    const v = r0(leg && leg.value);
    if (v <= 0) continue;
    const date = isIso(leg.date) ? iso(leg.date) : dates[Math.min(n, Math.max(1, Number(leg.slot) || 1)) - 1];
    events.push({ date, order: 1, kind: 'pay', value: v });
  }
  for (const c of priceChanges(plan)) events.push({ date: c.date, order: 2, kind: 'price', total: c.total });
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));

  let total = r0(plan.total);
  let paid = 0;
  let k = 1;
  let paidThis = false;
  let arrears = 0;
  let A = firstDue > 0 ? firstDue : Math.ceil(total / n);
  const paidIn = Array(n + 1).fill(0);
  const lastPaidOn = Array(n + 1).fill(null);
  const respread = (left) => { A = left > 0 ? Math.ceil(Math.max(0, total - paid) / left) : 0; };

  for (const e of events) {
    if (e.kind === 'period') {
      arrears = paidThis ? 0 : arrears + A;
      k = Math.min(n, k + 1);
      paidThis = false;
    } else if (e.kind === 'pay') {
      paid += e.value;
      paidIn[k] += e.value;
      lastPaidOn[k] = e.date;
      paidThis = true;
      arrears = 0;
      respread(n - k);
    } else {
      total = e.total;
      arrears = 0;
      respread(paidThis ? n - k : n - k + 1);
    }
  }

  const balance = Math.max(0, total - paid);
  const credit = Math.max(0, paid - total);
  const last = k === n;
  const dueNow = balance <= 0 ? 0 : last ? balance : (paidThis ? 0 : Math.min(balance, arrears + A));
  const upcoming = balance > 0 && !last
    ? { k: k + 1, due: dates[k], amount: k + 1 === n ? balance : Math.min(balance, dueNow + A) }
    : null;

  // Forfeiture clock.
  let lastPaid = 0;
  for (let q = 1; q <= n; q++) if (paidIn[q] > 0) lastPaid = q;
  let overdueSince = null;
  let closeOn = null;
  let warn = null;
  if (balance > 0) {
    if (lastPaid < n && dates[lastPaid] && dates[lastPaid] <= now) overdueSince = dates[lastPaid];
    const byGap = overdueSince ? addDays(overdueSince, CLOSE_AFTER_DAYS) : null;
    const byLast = addDays(dates[n - 1], LAST_CLOSE_AFTER_DAYS);
    closeOn = byGap && byGap < byLast ? byGap : byLast;
    const gap = overdueSince ? daysBetween(overdueSince, now) : -1;
    const afterLast = daysBetween(dates[n - 1], now);
    for (const w of WARN_DAYS) if (gap >= w) warn = { kind: `warn${w}`, k: lastPaid + 1 };
    for (const w of LAST_WARN_DAYS) if (afterLast >= w) warn = { kind: `last${w}`, k: n };
  }
  const close = Boolean(closeOn && now >= closeOn);

  // At most MAX_PAYMENTS payments on a plan (founder, 2026-11-09): each takes its own slot and there
  // are six. Once five are in, the next one must clear the balance.
  const payments = (legs || []).filter(l => r0(l && l.value) > 0).length;
  const lastPayment = balance > 0 && payments >= MAX_PAYMENTS - 1;

  const state = {
    n, k, dates, total, paid, balance, credit, dueNow, upcoming, paidIn, lastPaidOn,
    closure: { overdueSince, closeOn, close, warn },
    payments, lastPayment,
    // The smallest payment a link may be raised for; the balance when less is left, and the whole
    // balance once only one payment is left.
    minPayment: balance > 0 ? (lastPayment ? balance : Math.min(MIN_PAYMENT, balance)) : 0,
    // What staff and the customer are pointed at: what is due now, else the next installment.
    suggested: balance > 0 ? (lastPayment ? balance : (dueNow || (upcoming ? upcoming.amount : balance))) : 0,
  };
  state.rows = scheduleRows(plan, state, now, A);
  return state;
}

// The installment rows for display. Past periods show what was paid in them (or "missed" — the
// amount moved forward); the current one what it asks for now; later ones a projection that
// assumes each is paid exactly as asked (paying more or less changes them, which is the point).
function scheduleRows(plan, state, now, A) {
  const { n, k, dates, paidIn, lastPaidOn, balance, dueNow } = state;
  const estimate = awaitingFinalPrice(plan);
  let bal = balance - dueNow;
  let standing = k < n ? (dueNow > 0 ? Math.ceil(Math.max(0, bal) / (n - k)) : A) : 0;
  return dates.map((due, i) => {
    const q = i + 1;
    const est = estimate && q === n;
    if (q < k) {
      return paidIn[q] > 0
        ? { k: q, due, amount: paidIn[q], status: 'paid', paidOn: lastPaidOn[q] }
        : { k: q, due, amount: 0, status: 'missed' };
    }
    if (q === k) {
      if (balance <= 0 || (dueNow === 0 && paidIn[q] > 0)) return { k: q, due, amount: paidIn[q], status: 'paid', paidOn: lastPaidOn[q] };
      return { k: q, due, amount: dueNow, status: due < now ? 'overdue' : 'due', paid: paidIn[q], estimate: est };
    }
    if (bal <= 0) return { k: q, due, amount: 0, status: 'upcoming', estimate: est };
    const amount = q === n ? bal : Math.min(bal, standing);
    bal -= amount;
    if (q < n) standing = Math.ceil(Math.max(0, bal) / (n - q));
    return { k: q, due, amount, status: 'upcoming', estimate: est };
  });
}

// Validate a requested payment amount against the plan's current state.
// Returns { ok: true, amount } or { ok: false, reason, min, max }.
// People type "20,000", "₹20,000" or "Rs 20000"; Number() reads those as NaN, which became 0.
const parseAmount = (v) => r0(String(v ?? '').replace(/rs\.?|₹|inr|,|\s/gi, ''));

function validatePayment(state, amount) {
  const amt = parseAmount(amount);
  const min = state.minPayment;
  const max = state.balance;
  if (max <= 0) return { ok: false, reason: 'Plan is fully paid', min: 0, max: 0 };
  if (state.lastPayment && amt !== max) return { ok: false, reason: `Five payments have been made, so this one must be the whole balance, Rs${max.toLocaleString('en-IN')}`, min, max };
  if (amt < min) return { ok: false, reason: `The smallest payment is Rs${min.toLocaleString('en-IN')}`, min, max };
  if (amt > max) return { ok: false, reason: `The most you can pay is the balance, Rs${max.toLocaleString('en-IN')}`, min, max };
  return { ok: true, amount: amt };
}

// The one status wording every board shows (tracker sheet, sales report), so they can never disagree.
// st is planState(plan, legs, today); draftExists=false when an active plan's draft is gone.
const STATUS_LABELS = { active: 'Active', completed: 'Completed', forfeited: 'Closed (voucher)', cancelled: 'Cancelled' };
function statusLabel(plan, st, draftExists = true) {
  if (plan.status !== 'active') return STATUS_LABELS[plan.status] || plan.status;
  const overdue = st.rows.some(r => r.status === 'missed' || r.status === 'overdue');
  if (!draftExists) return 'Active: draft missing';
  if (plan.change_pending) return 'Active: product change pricing';
  if (st.closure?.warn) return `Active: closing ${st.closure.closeOn}`;
  if (overdue) return 'Active: overdue';
  return 'Active: on track';
}

// The payments of a plan whose draft is no longer read (closed, or gone). The snapshot has no legs
// field of its own: they are the installment slots in the draft's metafields as last snapshotted.
// readInstallments is passed in so this module stays free of requires beyond cad_advance.
function snapshotLegs(plan, readInstallments) {
  const snap = plan.snapshot || {};
  if (Array.isArray(snap.legs)) return snap.legs;
  return readInstallments(snap.metafields || {}).filter(l => l.type !== 'cad_advance');
}

module.exports = {
  statusLabel, snapshotLegs,
  PLAN_INSTALLMENTS, INSTALLMENT_CHOICES, MIN_PAYMENT, CLOSE_AFTER_DAYS, WARN_DAYS, LAST_CLOSE_AFTER_DAYS, LAST_WARN_DAYS,
  dueDates, countOf, datesOf, periodOf, floats, awaitingFinalPrice, priceChanges, currentTotal,
  planState, scheduleRows, validatePayment, daysBetween, addDays,
};
