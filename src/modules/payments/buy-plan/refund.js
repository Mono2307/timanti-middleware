'use strict';

// Buy plan — refunding money paid over the price to the customer's own payment, through GoKwik
// (founder, 23 Nov 2026). The case: the piece made for the customer weighs less than the plan's piece,
// staff press Change product, and the plan has now been paid more than its new price. Staff then
// offer a piece of higher value, a voucher for the difference (credit.js), or — this module — the
// difference back to the card / UPI the customer paid the links with.
//
// HOW IT WORKS
//   - Only money paid by a GoKwik payment link can go back this way. Each link payment is one GoKwik
//     transaction; the refund is made against it with gokwik_oid = the link's merchant reference, the
//     value the payment webhook sent back (read from gokwik_webhook_log by the transaction id).
//   - GoKwik's refund status API says what has already gone back on each payment, so the same money
//     is never refunded twice, whoever started the earlier refund.
//   - The newest payments are refunded first (GoKwik refuses refunds on payments older than its limit).
//   - Each refund is written to the draft as a refund leg (custom.refund_N_*: value, mode online_link,
//     date, ref = the GoKwik refund id). The draft's refund sync then books it and recomputes
//     amount_refunded; credit.js counts it as given back, so it is never offered again as a voucher.
//   - Cash, card-machine and bank-transfer payments cannot go back through GoKwik: if the excess is
//     more than the link payments can return, the rest stays owed and the screen offers a voucher.
//   - A refund settles the plan at its current price, like a credit voucher: a floating plan is not
//     repriced afterwards.
//   - No cash leaves the store and nothing here is automatic: staff press Refund after the customer agrees.
//
// SWITCHED OFF until BUY_PLAN_REFUNDS=on (24 Nov 2026). GoKwik's v2 refund API (api.gokwik.co) answers
// "Order not found" for a payment-link payment by its gokwik_oid, transaction id or draft: it covers
// checkout orders. Waiting on GoKwik for the identifier (or endpoint) that refunds a payment-link
// transaction. Until then the screen shows only the voucher, as before.

const { supabase } = require('../../../core/supabase');
const { config } = require('../../../core/config');
const { log } = require('../../../core/logger');
const { updateDraftOrderMetafields } = require('../../../core/metafields');
const gokwik = require('../../../integrations/gokwik');
const { readRefunds, sumRefunds, refundLegPatch, MAX_REFUNDS } = require('../refunds');
const S = require('./schedule');
const store = require('./store');

const r0 = (n) => Math.max(0, Math.round(Number(n) || 0));
const refuse = (message, status = 400) => Object.assign(new Error(message), { status });
const LOCK_MS = 10 * 60 * 1000;
const FAILED = /fail|reject|cancel/i;
const enabled = (deps = {}) => (deps.enabled !== undefined ? deps.enabled : Boolean(config.gokwik.refundsOn));

// Money already returned on the draft (refund legs, any source).
const refundedOn = (d) => Math.round(sumRefunds(readRefunds((d && d.mf) || {})));

// Pure: which payments to refund, newest first. payments: [{ txn, oid, at, left }] (left = what that
// payment can still return). freeSlots: refund legs left on the draft (each GoKwik call takes one; past
// the last, refundLegPatch folds into the last slot, so a cap of MAX_REFUNDS calls keeps it readable).
// Returns { parts: [{ txn, oid, amount }], total, short }.
function allocate(owed, payments, maxCalls = MAX_REFUNDS) {
  let need = r0(owed);
  const parts = [];
  const order = [...(payments || [])].filter(p => p.oid && r0(p.left) > 0)
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  for (const p of order) {
    if (!(need > 0) || parts.length >= maxCalls) break;
    const amount = Math.min(need, r0(p.left));
    parts.push({ txn: p.txn, oid: p.oid, amount });
    need -= amount;
  }
  const total = parts.reduce((s, p) => s + p.amount, 0);
  return { parts, total, short: Math.max(0, r0(owed) - total) };
}

// The GoKwik link payments on a draft and what each can still return. deps for tests.
async function linkPayments(draftId, deps = {}) {
  const db = deps.supabase || supabase;
  const gk = deps.gokwik || gokwik;
  const { data, error } = await db.from('payment_links').select('gokwik_txn_id, amount, updated_at, created_at')
    .eq('draft_order_id', String(draftId)).eq('status', 'success');
  if (error) throw new Error(`payment_links: ${error.message}`);
  const out = [];
  for (const l of data || []) {
    if (!l.gokwik_txn_id) continue;
    const { data: logs } = await db.from('gokwik_webhook_log').select('body')
      .eq('body->>transaction_id', l.gokwik_txn_id).limit(5);
    const oid = ((logs || []).map(r => r.body).find(b => b && b.gokwik_oid) || {}).gokwik_oid || null;
    const done = await gk.listRefunds({ transactionPaymentId: l.gokwik_txn_id });
    const back = done.filter(x => !FAILED.test(x.status)).reduce((s, x) => s + x.amount, 0);
    out.push({ txn: l.gokwik_txn_id, oid, at: l.updated_at || l.created_at, paid: r0(l.amount), refunded: r0(back), left: Math.max(0, r0(l.amount) - r0(back)) });
  }
  return out;
}

// For the Buy plan screen: what a refund would return now. owed: credit.voucherDue(...).amount.
async function refundOption(plan, d, owed, deps = {}) {
  if (!enabled(deps)) return null;
  if (!(r0(owed) > 0) || plan.status !== 'active') return { online: 0, short: 0, payments: [] };
  const payments = await linkPayments(d.id, deps);
  const a = allocate(owed, payments);
  return { online: a.total, short: a.short, payments: payments.map(p => ({ txn: p.txn, paid: p.paid, refunded: p.refunded, left: p.left, ready: Boolean(p.oid) })) };
}

// Staff pressed Refund. owed: what credit.js says is due back now. Returns { refunded, parts, short }.
async function issueRefund(plan, d, owed, { today, by = null, deps = {} } = {}) {
  if (!enabled(deps)) throw refuse('Refunds through GoKwik are not switched on yet: issue a voucher', 409);
  if (plan.status !== 'active') throw refuse(`This buy plan is ${plan.status}`, 409);
  if (plan.change_pending) throw refuse('The product change is still being priced: wait a minute and try again', 409);
  if (!(r0(owed) > 0)) throw refuse('Nothing has been paid over the price on this plan', 409);
  const st = deps.store || store;
  const gk = deps.gokwik || gokwik;
  const writeMf = deps.updateDraftOrderMetafields || updateDraftOrderMetafields;

  // One refund at a time on a plan: a second press while this one runs is refused.
  const lockKey = `buy_plan_refund_lock_${plan.id}`;
  const held = Number(await st.getConfigValue(lockKey)) || 0;
  if (Date.now() - held < LOCK_MS) throw refuse('A refund is already being made on this plan', 409);
  await st.setConfigValue(lockKey, String(Date.now()));
  try {
    const a = allocate(owed, await linkPayments(d.id, deps));
    if (!a.parts.length) throw refuse('None of this plan was paid by a GoKwik payment link that can still be refunded. Issue a voucher for it instead.', 409);
    const mf = { ...(d.mf || {}) };
    const done = [];
    for (const p of a.parts) {
      let r;
      try { r = await gk.initiateRefund({ gokwikOid: p.oid, amount: p.amount }); }
      catch (e) {
        if (!done.length) throw e;
        log.error('buy-plan', `${plan.draft_name}: refund of Rs${p.amount} on ${p.txn} failed after Rs${done.reduce((s, x) => s + x.amount, 0)} went back: ${e.message}`);
        break;
      }
      const ref = [r.refundId, ...r.parts.filter(x => x.refundId !== r.refundId).map(x => x.refundId)].filter(Boolean).join(' + ');
      const patch = refundLegPatch(readRefunds(mf), { value: p.amount, mode: 'online_link', date: today, ref });
      await writeMf(d.id, patch).catch(e => log.error('buy-plan', `${plan.draft_name}: refund ${ref} (Rs${p.amount}) went through but was not written on the draft: ${e.message}. Add it to the refund fields by hand.`));
      Object.assign(mf, patch);
      done.push({ txn: p.txn, amount: p.amount, refundId: r.refundId, status: r.status });
      log.info('buy-plan', `${plan.draft_name}: refund ${ref} Rs${p.amount} on ${p.txn} (${r.status}) by ${by || 'staff'}`);
    }
    const refunded = done.reduce((s, x) => s + x.amount, 0);
    // Settled at today's price, as a credit voucher does (credit.js).
    const patch = { final_total: S.currentTotal(plan) };
    Object.assign(plan, patch);
    await st.updatePlan(plan.id, patch);
    const history = JSON.parse((await st.getConfigValue(`buy_plan_refunds_${plan.id}`)) || '[]');
    await st.setConfigValue(`buy_plan_refunds_${plan.id}`, JSON.stringify([...history, ...done.map(x => ({ ...x, on: today, by }))]));
    return { refunded, parts: done, short: r0(owed) - refunded };
  } finally {
    await st.setConfigValue(lockKey, '0').catch(() => {});
  }
}

module.exports = { allocate, linkPayments, refundOption, issueRefund, refundedOn };
