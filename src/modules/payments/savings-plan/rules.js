'use strict';

// Savings plan — the rules. Pure functions, no I/O. (Founder / HQ decisions, 9–12 Nov 2026; the
// customer terms are Timanti_Savings_Plan_Design_and_TnC_v5.)
//
// A savings plan is a Shopify draft order with one custom line, "Savings Plan", priced at
// instalment × months. It never becomes an order: at the end it pays out a Savings Scheme Voucher.
//
//   - 6 or 10 monthly instalments of a FIXED amount A, chosen at enrolment (₹1,000 to ₹1,00,000,
//     in multiples of ₹100). A cannot change; the line price is A × months.
//   - Instalment 1 is due on the start date, the rest on the same day of each following month.
//   - Bonus (a share of ONE instalment): 6 months → 50%, 10 months → 100% (BlueStone 10+1).
//   - 10-month plan only, early redemption on BlueStone's steps: from month 6 with 5 instalments
//     paid → 25%; from month 8 with 7 paid → 50%.
//   - Paid in full early (prepaid): the full bonus straight away (HQ, 12 Nov 2026 — see
//     PREPAID_BONUS_NOW; the founder may move it to the maturity date).
//   - Late = an instalment covered after its due date. More than LATE_LIMIT late → no bonus at all.
//   - Grace: an unpaid instalment may be paid up to GRACE_DAYS after its due date. On the day after
//     that the plan terminates: a voucher for the money paid, no bonus.
//   - The customer stopping the plan is a termination too.
//   - Never a cash refund.
//
// HOW PAYMENTS COUNT. Money is never refused. Payments are taken in date order and fill
// instalments in turn: a payment of 2 × A covers two instalments (paying ahead), a payment of less
// than A covers none until the next one tops it up. An instalment counts as paid on the date the
// running total first reaches it. A payment that is not a whole number of instalments is flagged
// for staff (oddPayments) but still counts, rupee for rupee.

const { addMonths } = require('../../adjustments/cad_advance');

const MONTH_CHOICES = [6, 10];
const MIN_INSTALMENT = 1000;
const MAX_INSTALMENT = 100000;
const INSTALMENT_STEP = 100;
const LATE_LIMIT = 2;
const GRACE_DAYS = 30;
const GRACE_WARN_DAYS = [15, 25];
const VOUCHER_MONTHS = 12;
const PREPAID_BONUS_NOW = true;

// The bonus at full payment, and the early-redemption steps, as % of one instalment.
// step.paid: instalments that must be paid; step.month: the month it opens (the due date of
// instalment `month`, i.e. dates[month - 1]).
const PLANS = {
  6:  { fullPct: 50,  steps: [] },
  10: { fullPct: 100, steps: [{ paid: 7, month: 8, pct: 50 }, { paid: 5, month: 6, pct: 25 }] },
};

const SAVINGS_LINE_TITLE = 'Savings Plan';
const PLAN_TAG = 'savings-plan';
const STATUS_TAGS = {
  active: 'savings-in-progress',
  completed: 'savings-completed',
  terminated: 'savings-terminated',
  redeemed: 'savings-redeemed',
};

const iso = (v) => String(v || '').slice(0, 10);
const isIso = (v) => /^\d{4}-\d{2}-\d{2}$/.test(iso(v));
const daysBetween = (fromIso, toIso) =>
  Math.round((Date.parse(`${iso(toIso)}T00:00:00Z`) - Date.parse(`${iso(fromIso)}T00:00:00Z`)) / 86400000);
const addDays = (d, n) => new Date(Date.parse(`${iso(d)}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const r0 = (v) => Math.round(Number(v) || 0);
const parseAmount = (v) => r0(String(v ?? '').replace(/rs\.?|₹|inr|,|\s/gi, ''));

function dueDates(startDate, n) {
  const start = iso(startDate);
  if (!isIso(start)) return [];
  return Array.from({ length: n }, (_, i) => (i === 0 ? start : addMonths(start, i)));
}

// The month after the last instalment, on the start-date day: month 7 or month 11.
const maturityDate = (startDate, n) => addMonths(iso(startDate), n);

// Enrolment check. Returns [] when it may start, else the reasons it may not.
function enrolmentProblems({ months, instalment }) {
  const out = [];
  const n = Number(months);
  const a = Number(instalment);
  if (!MONTH_CHOICES.includes(n)) out.push(`Choose ${MONTH_CHOICES.join(' or ')} months`);
  if (!Number.isFinite(a) || a <= 0) out.push('The instalment is missing');
  else {
    if (a < MIN_INSTALMENT) out.push(`The smallest instalment is Rs${MIN_INSTALMENT.toLocaleString('en-IN')}`);
    if (a > MAX_INSTALMENT) out.push(`The largest instalment is Rs${MAX_INSTALMENT.toLocaleString('en-IN')}`);
    if (Math.round(a) !== a || a % INSTALMENT_STEP !== 0) out.push(`The instalment must be a multiple of Rs${INSTALMENT_STEP}`);
  }
  return out;
}

// The instalment a "Savings Plan" line implies: its total ÷ months. null if it does not divide.
function instalmentFromLine(lineTotal, months) {
  const total = Number(lineTotal);
  const n = Number(months);
  if (!(total > 0) || !(n > 0)) return null;
  const a = total / n;
  return Math.abs(a - Math.round(a)) < 0.005 ? Math.round(a) : null;
}

const countOf = (plan) => Number(plan.months) || 0;
const datesOf = (plan) => ((plan.due_dates || []).length ? plan.due_dates.map(iso) : dueDates(plan.start_date, countOf(plan)));

// Where the plan stands on `today`.
//   n, A, dates, maturity        the plan
//   paid, paidCount              money in; whole instalments it covers (capped at n)
//   overpaid                     money beyond n × A (staff check; it still goes on the voucher)
//   lateCount, bonusOk           instalments covered after their due date; lateCount ≤ LATE_LIMIT
//   oddPayments                  payments that are not a whole number of instalments
//   next                         { k, due } — the first instalment not yet covered, or null
//   overdueDays, closeOn         how late `next` is; the day the plan terminates if it stays unpaid
//   terminateNow, warn           closeOn has come; the grace warning due ('grace15' | 'grace25')
//   dueNow                       what to ask for now: every instalment due by today and not covered
//   fullyPaid
//   redeem                       what redeeming TODAY would pay out (see redeemOptions)
//   rows                         one per instalment, for display
function savingsState(plan, legs, today) {
  const n = countOf(plan);
  const A = r0(plan.instalment);
  const dates = datesOf(plan);
  const now = iso(today);

  const pays = (legs || [])
    .filter(l => l && l.type !== 'cad_advance' && r0(l.value) > 0)
    .map((l, i) => ({ value: r0(l.value), date: isIso(l.date) ? iso(l.date) : null, slot: Number(l.slot) || i + 1, mode: l.mode || '' }))
    // A payment with no date (typed in without one) is taken to have arrived on the due date of the
    // instalment it covers: on time. Sort those after the dated ones on the same footing as their slot.
    .sort((a, b) => (a.date && b.date ? (a.date < b.date ? -1 : a.date > b.date ? 1 : a.slot - b.slot) : a.slot - b.slot));

  let paid = 0;
  const coveredOn = Array(n + 1).fill(null);
  const late = Array(n + 1).fill(false);
  const oddPayments = [];
  for (const p of pays) {
    const before = Math.floor(paid / A);
    paid += p.value;
    if (A > 0 && p.value % A !== 0) oddPayments.push({ slot: p.slot, value: p.value, date: p.date });
    const after = Math.min(n, Math.floor(paid / A));
    for (let q = before + 1; q <= after; q++) {
      const on = p.date || dates[q - 1];
      coveredOn[q] = on;
      late[q] = on > dates[q - 1];
    }
  }
  const paidCount = A > 0 ? Math.min(n, Math.floor(paid / A)) : 0;
  const lateCount = late.filter(Boolean).length;
  const fullyPaid = n > 0 && paidCount >= n;
  const overpaid = Math.max(0, paid - n * A);

  const next = fullyPaid ? null : { k: paidCount + 1, due: dates[paidCount] };
  const overdueDays = next && next.due < now ? daysBetween(next.due, now) : 0;
  const closeOn = next ? addDays(next.due, GRACE_DAYS + 1) : null;
  const terminateNow = Boolean(closeOn && now >= closeOn);
  let warn = null;
  for (const w of GRACE_WARN_DAYS) if (overdueDays >= w && !terminateNow) warn = `grace${w}`;

  const dueByToday = dates.filter(d => d <= now).length;
  const owedInstalments = Math.max(0, dueByToday - paidCount);
  const dueNow = fullyPaid ? 0 : owedInstalments * A - (paid - paidCount * A);

  const state = {
    n, A, dates, maturity: maturityDate(plan.start_date, n),
    paid, paidCount, overpaid, lateCount, bonusOk: lateCount <= LATE_LIMIT, oddPayments,
    next, overdueDays, closeOn, terminateNow, warn, dueNow: Math.max(0, dueNow), fullyPaid,
  };
  state.redeem = redeemOptions(plan, state, now);
  state.rows = dates.map((due, i) => {
    const k = i + 1;
    if (coveredOn[k]) return { k, due, amount: A, status: 'paid', paidOn: coveredOn[k], late: late[k] };
    return { k, due, amount: A, status: due < now ? 'overdue' : due === now ? 'due' : 'upcoming' };
  });
  return state;
}

// What the plan pays out if it is redeemed (or ends) today. Pure.
//   kind 'full'   every instalment paid (on or before maturity) — the plan's full bonus
//        'early'  a 10-month plan on an early-redemption step (5 paid from month 6, 7 from month 8)
//        'none'   nothing earns a bonus yet: stopping now returns the money paid, no bonus
//   pct, bonus, value = paid + bonus. bonusLost: a bonus the plan would earn but for the late rule.
function redeemOptions(plan, st, today) {
  const rules = PLANS[st.n] || { fullPct: 0, steps: [] };
  let kind = 'none';
  let pct = 0;
  if (st.fullyPaid && (PREPAID_BONUS_NOW || today >= st.maturity)) { kind = 'full'; pct = rules.fullPct; }
  else {
    for (const s of rules.steps) {
      if (st.paidCount >= s.paid && today >= st.dates[s.month - 1]) { kind = 'early'; pct = s.pct; break; }
    }
  }
  const earned = Math.round(st.A * pct / 100);
  const bonus = st.bonusOk ? earned : 0;
  return { kind, pct: st.bonusOk ? pct : 0, bonus, value: st.paid + bonus, bonusLost: st.bonusOk ? 0 : earned };
}

// The voucher for how the plan ends. how: 'full' | 'early' | 'terminated' | 'stopped'.
// Returns { ok, paid, pct, bonus, value, reason } — ok false with a reason when it cannot end that way.
function payoutFor(plan, st, how) {
  if (how === 'terminated' || how === 'stopped') {
    return { ok: st.paid > 0, paid: st.paid, pct: 0, bonus: 0, value: st.paid, reason: st.paid > 0 ? null : 'Nothing has been paid on this plan' };
  }
  const r = st.redeem;
  if (how === 'full' && r.kind !== 'full') return { ok: false, reason: `${st.paidCount} of ${st.n} instalments are paid` };
  if (how === 'early' && r.kind !== 'early') {
    return { ok: false, reason: st.n !== 10
      ? 'Early redemption is only on the 10-month plan'
      : r.kind === 'full' ? 'Every instalment is paid: redeem the full plan instead'
      : 'Early redemption opens from month 6 with 5 instalments paid, or month 8 with 7 paid' };
  }
  return { ok: true, paid: st.paid, pct: r.pct, bonus: r.bonus, value: r.value, reason: null };
}

// The status tag for a plan row's status.
const statusTag = (status) => STATUS_TAGS[status] || STATUS_TAGS.active;
// Every tag this module owns on a draft (the status tags plus the plan tag).
const isSavingsStatusTag = (t) => Object.values(STATUS_TAGS).includes(String(t || '').trim().toLowerCase());

const isSavingsLine = (li) => !li?.variant_id && String(li?.title || '').trim().toLowerCase() === SAVINGS_LINE_TITLE.toLowerCase();
const isSavingsDraftTags = (tags) => (Array.isArray(tags) ? tags : String(tags || '').split(','))
  .some(t => String(t).trim().toLowerCase() === PLAN_TAG);

module.exports = {
  MONTH_CHOICES, MIN_INSTALMENT, MAX_INSTALMENT, INSTALMENT_STEP, LATE_LIMIT, GRACE_DAYS, GRACE_WARN_DAYS,
  VOUCHER_MONTHS, PREPAID_BONUS_NOW, PLANS, SAVINGS_LINE_TITLE, PLAN_TAG, STATUS_TAGS,
  dueDates, maturityDate, enrolmentProblems, instalmentFromLine, savingsState, redeemOptions, payoutFor,
  statusTag, isSavingsStatusTag, isSavingsLine, isSavingsDraftTags, parseAmount, daysBetween, addDays,
};
