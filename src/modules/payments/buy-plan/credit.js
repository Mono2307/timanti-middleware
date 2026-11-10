'use strict';

// Buy plan — vouchers are a STAFF step, never automatic (founder, 2026-11-09). The system works out
// what is owed back and prompts the store (Buy plan screen, store email, daily digest); nothing is
// issued, and nothing about a voucher is emailed to the customer, until staff press Issue voucher.
//   credit  an active plan has been paid beyond its price: a cheaper piece after Change product, gold
//           fell before the final price, a stale link paid after the balance dropped. Staff first
//           offer a piece of higher value; the voucher is for the difference if the customer wants it.
//   closed  a plan closed for non-payment (and Cancel plan → Customer opted out, cancel.js): staff tick
//           each payment they have checked really came in. The voucher is those payments, plus any
//           old gold and exchange note handed in toward the plan (founder D1, 2026-11-09).
//
// voucher_value on the plan is the running total of every voucher issued on it and voucher_code
// lists their codes, so the same money is never given back twice: a close or a cancel after a credit
// voucher only counts what was not already returned.
//
// Issuing a credit voucher settles the plan at its current price (final_total), so a floating plan
// is not repriced afterwards and the money given back can never be asked for again; Change product is
// refused from then on (routes.js).

const { supabase } = require('../../../core/supabase');
const { log } = require('../../../core/logger');
const creditInstruments = require('../../adjustments/credit_instruments');
const S = require('./schedule');
const store = require('./store');
const notify = require('./notify');
const { issuePlanVoucher } = require('./voucher');

const vouchered = (plan) => Math.max(0, Math.round(Number(plan.voucher_value) || 0));
const codesOf = (plan) => String(plan.voucher_code || '').split(',').map(c => c.trim()).filter(Boolean);
const r0 = (n) => Math.max(0, Math.round(parseFloat(n) || 0));

function refuse(message, status = 400) { const e = new Error(message); e.status = status; return e; }

// Old gold and exchange notes handed in toward the plan: they reduced what was left to collect, so a
// plan that ends without the piece gives them back in its voucher.
function handedIn(d) {
  const mf = (d && d.mf) || {};
  const oldGold = r0(mf.old_gold_value);
  const exchangeNote = r0(mf.exchange_note_value);
  return { oldGold, exchangeNote, total: oldGold + exchangeNote };
}

// The money staff confirmed came in: the slots they ticked. null when not asked.
function verifiedMoney(d, verifiedSlots) {
  if (!Array.isArray(verifiedSlots)) return null;
  const legs = (d && d.legs) || [];
  const want = new Set(verifiedSlots.map(Number));
  for (const s of want) if (!legs.some(l => l.slot === s)) throw refuse(`Payment ${s} is not on this plan`);
  return Math.round(legs.filter(l => want.has(l.slot)).reduce((sum, l) => sum + l.value, 0));
}

// What a plan that ends without its piece gives back: the (verified) money, plus what was handed in,
// less any voucher already issued on it. verifiedSlots null: every payment (the digest's estimate).
function payout(plan, st, d, verifiedSlots = null) {
  const money = verifiedMoney(d, verifiedSlots);
  return Math.max(0, (money === null ? Math.round(st.paid) : money) + handedIn(d).total - vouchered(plan));
}

// What staff may put on a voucher now. { kind, amount } — 0: nothing.
function voucherDue(plan, st, d = null, verifiedSlots = null) {
  if (plan.status === 'forfeited') return { kind: 'closed', amount: payout(plan, st, d, verifiedSlots) };
  if (plan.status === 'active' && !plan.change_pending) return { kind: 'credit', amount: Math.max(0, Math.round(st.credit) - vouchered(plan)) };
  return { kind: null, amount: 0 };
}

// Each payment on the draft with where it came from, so staff can check it before a voucher:
// source 'gokwik' (online link, ref = UTR), 'pine' (card terminal), 'buy-plan' (recorded in store on the
// Buy plan screen), or '' (no payment record: typed straight into the Metafield Manager).
// records: store.listPayments. Matched by amount, same day first.
function paymentSlots(legs, records) {
  const left = [...(records || [])];
  const take = (pred) => { const i = left.findIndex(pred); return i < 0 ? null : left.splice(i, 1)[0]; };
  return (legs || []).map(l => {
    const same = (p) => Math.abs(p.amount - l.value) < 1;
    const rec = take(p => same(p) && String(p.at || '').slice(0, 10) === l.date) || take(same);
    return { slot: l.slot, amount: Math.round(l.value), date: l.date, mode: l.mode, source: rec ? rec.source : '', ref: rec ? rec.utr || '' : '' };
  });
}

// An exchange note handed in is now inside the voucher: mark it used, so deleting the draft later
// cannot reopen it (credit_instruments revertApplied only touches 'applied' rows).
async function consumeHandedIn(plan, d, code) {
  if (!d || !(handedIn(d).exchangeNote > 0)) return;
  try {
    const { data, error } = await supabase.from('credit_instruments').select('serial_code')
      .eq('instrument_type', 'exchange_note').eq('status', 'applied').eq('target_draft_id', String(d.id));
    if (error) throw new Error(error.message);
    for (const r of data || []) {
      await creditInstruments.redeem(supabase, { instrumentType: 'exchange_note', serialCode: r.serial_code,
        targetDraftId: d.id, targetOrderName: `BUY-PLAN ${plan.draft_name} → ${code}` });
    }
  } catch (e) {
    log.error('buy-plan', `${plan.draft_name}: mark exchange note used in ${code}: ${e.message}`);
  }
}

// Staff pressed Issue voucher. verifiedSlots: for a closed plan, the payments staff ticked as checked.
// Throws (with a status) if there is nothing to issue.
async function issueStaffVoucher(plan, d, st, { today, by = null, verifiedSlots = null }) {
  if (plan.status === 'forfeited' && (d?.legs || []).length && !Array.isArray(verifiedSlots)) {
    throw refuse('Tick each payment you have checked actually reached Timanti');
  }
  const due = voucherDue(plan, st, d, verifiedSlots);
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
  if (due.kind === 'closed') await consumeHandedIn(plan, d, voucher.code);
  await notify.sendVoucherIssued(plan, d, { kind: due.kind, voucher })
    .catch(e => log.error('buy-plan', `${plan.draft_name}: voucher email: ${e.message}`));
  log.info('buy-plan', `${plan.draft_name}: voucher ${voucher.code} for Rs${voucher.value} (${due.kind}) issued by ${by || 'staff'}`);
  return { kind: due.kind, voucher };
}

// Shared with cancel.js: record a voucher issued elsewhere on the plan's running total.
async function recordVoucher(plan, voucher, extra = {}) {
  const patch = { voucher_value: vouchered(plan) + voucher.value, voucher_code: [...codesOf(plan), voucher.code].join(','), ...extra };
  Object.assign(plan, patch);
  await store.updatePlan(plan.id, patch);
}

module.exports = {
  voucherDue, payout, handedIn, verifiedMoney, paymentSlots, vouchered, codesOf,
  recordVoucher, consumeHandedIn, issueStaffVoucher,
};
