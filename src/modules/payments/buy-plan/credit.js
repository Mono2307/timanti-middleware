'use strict';

// Buy plan — vouchers are a STAFF step, never automatic (founder, 2026-11-09). The system works out
// what is owed back and prompts the store (Buy plan screen, store email, daily digest); nothing is
// issued, and nothing about a voucher is emailed to the customer, until staff press Issue voucher.
//   credit  an active plan has been paid beyond its price: a cheaper piece after Change product, gold
//           fell before the final price, a stale link paid after the balance dropped. Staff first
//           offer a piece of higher value; the voucher is for the difference if the customer wants it.
//   closed  a plan closed for non-payment: everything paid, once staff confirm it really came in.
// (Cancel plan → Customer opted out is the third way, cancel.js; it is a staff step already.)
//
// voucher_value on the plan is the running total of every voucher issued on it and voucher_code
// lists their codes, so the same money is never given back twice: a close or a cancel after a credit
// voucher only counts what was not already returned.
//
// Issuing a credit voucher settles the plan at its current price (final_total), so a floating plan
// is not repriced afterwards and the money given back can never be asked for again; Change product is
// refused from then on (routes.js).

const { log } = require('../../../core/logger');
const S = require('./schedule');
const store = require('./store');
const notify = require('./notify');
const { issuePlanVoucher } = require('./voucher');

const vouchered = (plan) => Math.max(0, Math.round(Number(plan.voucher_value) || 0));
const codesOf = (plan) => String(plan.voucher_code || '').split(',').map(c => c.trim()).filter(Boolean);

function refuse(message, status = 400) { const e = new Error(message); e.status = status; return e; }

// What staff may put on a voucher now. st is planState for the plan. { kind, amount } — 0: nothing.
function voucherDue(plan, st) {
  if (plan.status === 'forfeited') return { kind: 'closed', amount: Math.max(0, Math.round(st.paid) - vouchered(plan)) };
  if (plan.status === 'active' && !plan.change_pending) return { kind: 'credit', amount: Math.max(0, Math.round(st.credit) - vouchered(plan)) };
  return { kind: null, amount: 0 };
}

// Add an issued voucher to the plan's running total and code list.
async function recordVoucher(plan, voucher, extra = {}) {
  const patch = { voucher_value: vouchered(plan) + voucher.value, voucher_code: [...codesOf(plan), voucher.code].join(','), ...extra };
  Object.assign(plan, patch);
  await store.updatePlan(plan.id, patch);
}

// Staff pressed Issue voucher. Throws (with a status) if there is nothing to issue.
async function issueStaffVoucher(plan, d, st, { today, by = null }) {
  const due = voucherDue(plan, st);
  if (!(due.amount > 0)) throw refuse('There is nothing to put on a voucher for this plan', 409);
  // Claim the amount first, so a second press while this one runs finds nothing left to issue.
  const before = { voucher_value: plan.voucher_value ?? null };
  const codes = codesOf(plan);
  const total = vouchered(plan) + due.amount;
  await store.updatePlan(plan.id, { voucher_value: total });
  let voucher;
  try {
    voucher = await issuePlanVoucher({ plan, d, value: due.amount, today, why: due.kind === 'closed' ? 'plan closed' : 'paid over the price' });
  } catch (e) {
    await store.updatePlan(plan.id, before).catch(() => {});
    Object.assign(plan, before);
    throw e;
  }
  // A credit voucher settles the plan at today's price (see the top).
  const patch = { voucher_value: total, voucher_code: [...codes, voucher.code].join(','),
    ...(due.kind === 'credit' ? { final_total: S.currentTotal(plan) } : {}) };
  Object.assign(plan, patch);
  await store.updatePlan(plan.id, patch);
  await notify.sendVoucherIssued(plan, d, { kind: due.kind, voucher })
    .catch(e => log.error('buy-plan', `${plan.draft_name}: voucher email: ${e.message}`));
  log.info('buy-plan', `${plan.draft_name}: voucher ${voucher.code} for Rs${voucher.value} (${due.kind}) issued by ${by || 'staff'}`);
  return { kind: due.kind, voucher };
}

module.exports = { voucherDue, vouchered, codesOf, recordVoucher, issueStaffVoucher };
