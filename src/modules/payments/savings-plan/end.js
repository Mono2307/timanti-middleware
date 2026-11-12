'use strict';

// Savings plan — how a plan ends. Two steps, as on the buy plan: the system decides that a plan can
// end, and a person issues the voucher.
//
//   terminatePlan  the sweep, 30 days past an unpaid due date: status terminated, the draft tagged,
//                  open links cancelled, the customer and the store told. No voucher yet.
//   issueVoucher   staff, on the draft's savings screen: 'full' (every instalment paid), 'early'
//                  (a 10-month plan on its month-6 / month-8 step, after the customer asked), 'stopped'
//                  (the customer gives up the plan), or a terminated plan's voucher. Writes the outcome
//                  onto the plan row, the draft's metafields and tags (design §5b), and emails the voucher.
//
// The draft is never deleted when a voucher is issued (HQ, 12 Nov 2026): it is the record while the
// voucher is open. It never becomes an order either (convert.js refuses it).

const { log } = require('../../../core/logger');
const { supabase } = require('../../../core/supabase');
const { cancelOpenLinks } = require('../buy-plan/links');
const R = require('./rules');
const store = require('./store');
const notify = require('./notify');
const { issueSavingsVoucher } = require('./voucher');
const { tagsFor, writeTags, outcomeMetafields, writeMetafields } = require('./draft');

const refuse = (message, status = 400) => Object.assign(new Error(message), { status });
const CLAIM = 'ISSUING';

async function terminatePlan(plan, d, st, today, reason) {
  await store.updatePlan(plan.id, { status: 'terminated', end_kind: 'terminated', closed_at: new Date().toISOString(), closed_reason: reason, late_count: st.lateCount });
  plan.status = 'terminated';
  await cancelOpenLinks(plan.draft_order_id).catch(e => log.error('savings-plan', `${plan.draft_name}: cancel links: ${e.message}`));
  if (d) {
    await writeTags(d, tagsFor(d, 'terminated')).catch(e => log.error('savings-plan', `${plan.draft_name}: tags: ${e.message}`));
    await writeMetafields(d, { savings_status: 'terminated' });
  }
  await notify.sendTerminated(plan, d, st).catch(e => log.error('savings-plan', `${plan.draft_name}: terminated email: ${e.message}`));
  await notify.toStore(plan, d, {
    subject: 'closed — issue the voucher', heading: 'plan closed for non-payment',
    body: `Instalment ${st.next ? st.next.k : ''} was not paid within ${R.GRACE_DAYS} days of its due date. Check the payments on the draft, then open the savings plan screen and press Issue voucher. The voucher is the money paid, with no bonus. Do not delete the draft.`,
    facts: [{ label: 'Paid', value: `Rs${st.paid.toLocaleString('en-IN')}` }, { label: 'Voucher due', value: `Rs${st.paid.toLocaleString('en-IN')}` }],
  }).catch(e => log.error('savings-plan', `${plan.draft_name}: store email: ${e.message}`));
  await store.markSent(plan.id, st.n, 'staff', 'terminated');
  log.info('savings-plan', `${plan.draft_name}: terminated (${reason}), Rs${st.paid} owed as a voucher`);
}

// What staff may do now, for the screen: [{ how, value, bonus, pct, label }]. Empty when nothing.
function choices(plan, st) {
  if (plan.voucher_code && plan.voucher_code !== CLAIM) return [];
  if (plan.status === 'terminated') return [{ how: 'terminated', ...R.payoutFor(plan, st, 'terminated'), label: 'Issue the voucher (no bonus)' }];
  if (plan.status !== 'active') return [];
  const out = [];
  for (const [how, label] of [['full', 'Issue the voucher'], ['early', 'Redeem early'], ['stopped', 'Customer stops the plan (no bonus)']]) {
    const p = R.payoutFor(plan, st, how);
    if (p.ok) out.push({ how, ...p, label });
  }
  return out;
}

async function issueVoucher(plan, d, st, { how, today, by = null }) {
  // Already issued comes first: it is the answer staff need on a second press, whatever the status now is.
  if (plan.voucher_code && plan.voucher_code !== CLAIM) throw refuse(`Voucher ${plan.voucher_code} was already issued on this plan`, 409);
  if (plan.status === 'terminated' && how !== 'terminated') throw refuse('This plan has closed: its voucher is the money paid, with no bonus');
  if (plan.status === 'active' && how === 'terminated') throw refuse('This plan is still running');
  if (!['active', 'terminated'].includes(plan.status)) throw refuse(`This savings plan is ${plan.status}`, 409);
  const p = R.payoutFor(plan, st, how);
  if (!p.ok) throw refuse(p.reason);

  // Claim the plan first, so a second press while this one runs finds it taken.
  const { data: claimed, error } = await supabase.from('savings_plans')
    .update({ voucher_code: CLAIM, updated_at: new Date().toISOString() })
    .eq('id', plan.id).is('voucher_code', null).select('id');
  if (error) throw new Error(`claim: ${error.message}`);
  if (!claimed || !claimed.length) throw refuse('A voucher is already being issued on this plan', 409);

  let voucher;
  try {
    voucher = await issueSavingsVoucher({ plan, d, paid: p.paid, bonus: p.bonus, today });
  } catch (e) {
    await store.updatePlan(plan.id, { voucher_code: null }).catch(() => {});
    throw e;
  }
  const status = how === 'full' || how === 'early' ? 'completed' : 'terminated';
  const patch = {
    status, end_kind: how, late_count: st.lateCount, paid_at_end: p.paid, bonus_pct: p.pct, bonus: p.bonus,
    voucher_code: voucher.code, voucher_value: voucher.value, voucher_issued_at: new Date().toISOString(),
    closed_at: plan.closed_at || new Date().toISOString(),
    closed_reason: plan.closed_reason || (how === 'stopped' ? `stopped by the customer (${by || 'staff'})` : how === 'early' ? 'redeemed early' : 'completed'),
  };
  await store.updatePlan(plan.id, patch);
  Object.assign(plan, patch);
  await cancelOpenLinks(plan.draft_order_id).catch(e => log.error('savings-plan', `${plan.draft_name}: cancel links: ${e.message}`));
  if (d) {
    await writeTags(d, tagsFor(d, status, [`ssv:${voucher.code}`, `ssv-value:rs${voucher.value}`, `ssv-bonus:rs${voucher.bonus}`]))
      .catch(e => log.error('savings-plan', `${plan.draft_name}: tags: ${e.message}`));
    await writeMetafields(d, outcomeMetafields(plan));
  }
  await notify.sendVoucherIssued(plan, d, voucher).catch(e => log.error('savings-plan', `${plan.draft_name}: voucher email: ${e.message}`));
  log.info('savings-plan', `${plan.draft_name}: ${how} — ${voucher.code} Rs${voucher.value} issued by ${by || 'staff'}`);
  return { how, voucher, plan: { status, lateCount: st.lateCount, bonusPct: p.pct } };
}

module.exports = { terminatePlan, issueVoucher, choices, CLAIM };
