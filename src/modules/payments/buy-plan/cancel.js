'use strict';

// Buy plan — cancelling a plan by hand, from the Buy plan screen (founder, 2026-11-09). Two kinds:
//   opted_out  the customer backs out. The same voucher a plan closed for non-payment gets (one year,
//              one purchase worth at least its value; no cash refund): staff tick each payment they
//              have checked really reached the store (verifiedSlots) — a voucher for a payment that
//              never came in is real money out of the till — and old gold / exchange notes handed in
//              are added (credit.js payout).
//   mistake    a demo, or a plan started by mistake. No voucher and no customer email. The draft is
//              a normal draft again with whatever was recorded on it: delete it, or start a new plan
//              on it (routes.js lets a mistake be started over).
// Either way the plan stops: no reminders, no closing, no reprice lock, and deleting the draft no
// longer rebuilds it. As in forfeit.js, the plan is marked cancelled BEFORE the voucher is made, so
// a retry can never issue a second one.

const { log } = require('../../../core/logger');
const S = require('./schedule');
const store = require('./store');
const notify = require('./notify');
const { issuePlanVoucher } = require('./voucher');
const { payout, recordVoucher, consumeHandedIn } = require('./credit');
const { releaseDraft } = require('./forfeit');

const CANCELLED_TAG = 'buy-plan-cancelled';
const KINDS = { opted_out: 'customer opted out', mistake: 'demo or staff mistake' };

const isMistake = (plan) => plan?.status === 'cancelled' && String(plan.closed_reason || '').startsWith(KINDS.mistake);

function refuse(message, status = 400) { const e = new Error(message); e.status = status; return e; }

// verifiedSlots: the payments staff ticked as checked (opted_out). moneyReceived: true = every payment
// (the single tick of the first version of the screen).
async function cancelPlan(plan, d, { kind, verifiedSlots = null, moneyReceived = false, note = '', by = null, today }) {
  if (!KINDS[kind]) throw refuse('Choose why the plan is being cancelled');
  if (plan.change_pending) throw refuse('A product change is being priced. Reopen in a few minutes, then cancel.', 409);
  const st = S.planState(plan, d.legs, today);
  const legs = d.legs || [];
  const slots = Array.isArray(verifiedSlots) ? verifiedSlots : moneyReceived === true ? legs.map(l => l.slot) : null;
  if (kind === 'opted_out' && legs.length && slots === null) {
    throw refuse('Tick each payment you have checked actually reached the store before a voucher is made. If they were only recorded for a demo, cancel as a demo or staff mistake.');
  }
  // Verified money + old gold / exchange notes handed in, less any voucher already issued (credit.js).
  const paid = kind === 'opted_out' ? payout(plan, st, d, slots || []) : Math.round(st.paid);
  const clean = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const reason = clean ? `${KINDS[kind]}: ${clean}` : KINDS[kind];
  await store.updatePlan(plan.id, { status: 'cancelled', closed_at: new Date().toISOString(), closed_reason: reason });

  let voucher = null;
  let voucherError = null;
  if (kind === 'opted_out' && paid > 0) {
    try {
      voucher = await issuePlanVoucher({ plan, d, value: paid, today, why: 'plan cancelled' });
      await recordVoucher(plan, voucher);
      await consumeHandedIn(plan, d, voucher.code);
    } catch (e) {
      voucherError = e.message;
      log.error('buy-plan', `${plan.draft_name}: cancel voucher: ${e.message}`);
    }
  }

  await releaseDraft(plan, d, CANCELLED_TAG);
  await notify.sendCancelled(plan, d, { kind, paid, voucher, voucherError, reason, by })
    .catch(e => log.error('buy-plan', `${plan.draft_name}: cancel emails: ${e.message}`));
  log.info('buy-plan', `${plan.draft_name}: plan cancelled (${reason}) by ${by || 'staff'}, paid Rs${paid}${voucher ? ` → ${voucher.code}` : kind === 'opted_out' && paid > 0 ? ' → NO VOUCHER' : ''}`);
  return { paid, voucher, voucherError, reason };
}

module.exports = { cancelPlan, isMistake, KINDS, CANCELLED_TAG };
