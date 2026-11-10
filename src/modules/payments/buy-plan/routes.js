'use strict';

/**
 * Buy plan routes.
 *
 * Staff — the "Buy plan" admin action on a draft (More actions), authenticated by its session token:
 *   GET  /api/buy-plan/draft/:draftId   the plan, its rows and payments, or a preview of each way to
 *                                       run it (gold / equal × 4, 5, 6 installments) + what blocks it
 *   POST /api/buy-plan/start            start the plan: record it, lock the price, stamp the dates,
 *                                       email the customer their schedule
 *   POST /api/buy-plan/gold-link        before a gold-value-first plan: a link for the gold value
 *   POST /api/buy-plan/send-link        a GoKwik link for any amount from Rs1,000 (or the balance, if
 *                                       less) up to the balance — SMS + the plan email
 *   POST /api/buy-plan/record-payment   a payment taken in store (cash / card / UPI / bank transfer),
 *                                       recorded the same way a GoKwik or Pine payment is
 *   POST /api/buy-plan/change-product   after staff change the pieces on the draft: reprice it at
 *                                       today's rate and re-spread the plan (a gold plan loses its lock)
 *   POST /api/buy-plan/cancel           cancel the plan (cancel.js): the customer opted out (voucher for
 *                                       the money staff confirm was received), or a demo / staff mistake
 *                                       (no voucher; the draft can be given a new plan)
 *   POST /api/buy-plan/issue-voucher    staff issue the voucher the system has worked out (credit.js):
 *                                       paid over the price, or a plan closed for non-payment. Nothing
 *                                       ever issues one on its own.
 *
 * Customer — the "Pay a different amount" link in every plan email (signed token, no login):
 *   GET  /pay/plan/:token               the balance, what is due, an amount box
 *   POST /pay/plan/:token               validate → GoKwik link → redirect to it
 *
 * Operator:
 *   POST /api/buy-plan/sweep            run the sweep now (x-webhook-secret =
 *                                       PRICE_UPDATE_WEBHOOK_SECRET). dryRun=true reports only;
 *                                       asOf=YYYY-MM-DD runs it as if it were that day; draft=D327 (or
 *                                       the draft id) runs it on that one plan only.
 *
 * Starting a plan is ALWAYS a deliberate staff action. Nothing else — a payment link, a payment, a
 * tag — ever turns a draft into a buy plan.
 */

const express = require('express');
const { config } = require('../../../core/config');
const { putJson, getBuyingRateTable } = require('../../../core/shopify');
const { updateDraftOrderMetafields } = require('../../../core/metafields');
const { log } = require('../../../core/logger');
const { verifySessionToken } = require('../../after-sales/session_token');
const { RATE_LOCK_TAG, BUY_PLAN_TAG, CHANGE_REPRICE_TAG } = require('./lock');
const S = require('./schedule');
const store = require('./store');
const notify = require('./notify');
const final = require('./final');
const { createPlanLink, readPayToken, customPayUrl } = require('./links');
const { runBuyPlanSweep, followUp } = require('./sweep');
const { restoreDeletedPlanDraft } = require('./restore');
const { cancelPlan, isMistake } = require('./cancel');
const credit = require('./credit');
const sheet = require('./sheet');
const { todayIst, readDraft, startBlockers, snapshotOf, lockedGoldRate, goldValue, paidSoFar, linesKey } = require('./draft');

function requireStaffSession(req, res, next) {
  try {
    const h = String(req.headers.authorization || '');
    req.staff = verifySessionToken(h.startsWith('Bearer ') ? h.slice(7).trim() : '', {
      clientId: config.loyalty.mfmClientId,
      clientSecrets: config.loyalty.proxySecrets,
      shopDomain: config.shopify.storeUrl,
    });
    return next();
  } catch (e) {
    log.warn('buy-plan', `auth refused: ${e.message}`);
    return res.status(e.message === 'not configured' ? 503 : 401).json({ ok: false, error: `auth: ${e.message}` });
  }
}

const MODES = ['gold', 'equal'];
// The installment mode field only accepts its choices (admin/routes.js PAYMENT_MODE_FALLBACK).
const STORE_MODES = ['cash', 'card', 'upi', 'bank transfer'];

async function view(d, plan) {
  const today = todayIst();
  if (plan) {
    const st = S.planState(plan, d.legs, today);
    const planKey = plan.lines_key || linesKey((plan.snapshot || {}).line_items);
    const piecesChanged = Boolean(planKey) && linesKey(d.draft.line_items) !== planKey;
    const due = credit.voucherDue(plan, st, d);
    const records = await store.listPayments(d.id);
    return {
      ok: true, draft: d.draft.name, customer: d.customer, plan: {
        status: plan.status, mode: plan.mode, n: st.n, total: st.total, startTotal: Number(plan.total),
        finalTotal: plan.final_total === null || plan.final_total === undefined ? null : Number(plan.final_total),
        awaitingFinalPrice: S.awaitingFinalPrice(plan), finalDate: st.dates[st.n - 1],
        goldValue: Number(plan.gold_value) || null, startDate: plan.start_date,
        lockedGoldRate: plan.mode === 'gold' ? plan.locked_gold_rate : null,
        paid: st.paid, balance: st.balance, credit: st.credit, k: st.k, dueNow: st.dueNow, upcoming: st.upcoming,
        minPayment: st.minPayment, suggested: st.suggested, closeOn: st.closure.closeOn, warn: st.closure.warn,
        customPayUrl: plan.status === 'active' ? customPayUrl(plan.id) : null,
        voucherCode: plan.voucher_code || null, voucherValue: Number(plan.voucher_value) || null,
        voucherCodes: credit.codesOf(plan), vouchered: credit.vouchered(plan),
        // What staff may issue now (Issue voucher), and what a Customer-opted-out cancel would issue.
        voucherDue: due.amount, voucherKind: due.kind, cancelVoucher: credit.payout(plan, st, d),
        // For the per-payment check before a close/cancel voucher: each payment and its source, and
        // the old gold / exchange note that go into that voucher on top.
        slots: credit.paymentSlots(d.legs, records), handedIn: credit.handedIn(d),
        payments: st.payments, lastPayment: st.lastPayment,
        // The changed pieces at their catalog prices — a guide before Change product is pressed.
        newPiecesEstimate: piecesChanged ? Math.round(parseFloat(d.draft.total_price) || 0) : null,
        closedReason: plan.closed_reason || null, closedAt: plan.closed_at || null, changePending: Boolean(plan.change_pending),
        piecesChanged,
      },
      rows: st.rows,
      payments: records,
      storeModes: STORE_MODES,
    };
  }
  // No plan yet: each way of running it, for 4, 5 and 6 installments, with what blocks it.
  const gv = goldValue(d);
  const paid = paidSoFar(d);
  const options = {};
  for (const mode of MODES) {
    options[mode] = { blockers: startBlockers(d, mode), rows: {} };
    for (const n of S.INSTALLMENT_CHOICES) {
      const p = { mode, total: d.total, start_date: today, installments: n, gold_value: mode === 'gold' ? Math.max(gv, paid) : null };
      options[mode].rows[n] = S.planState(p, d.legs, today).rows;
    }
  }
  return {
    ok: true, draft: d.draft.name, customer: d.customer, plan: null,
    preview: {
      total: d.total, startDate: today, goldValue: gv, paid, goldOutstanding: Math.max(0, gv - paid),
      // Open on the way the payments already allow: gold value first once it is covered.
      suggestedMode: gv > 0 && paid >= gv ? 'gold' : 'equal',
      finalDates: Object.fromEntries(S.INSTALLMENT_CHOICES.map(n => [n, S.dueDates(today, n)[n - 1]])),
    },
    options, installmentChoices: S.INSTALLMENT_CHOICES, storeModes: STORE_MODES,
  };
}

function fail(res, e, what) {
  log.error('buy-plan', `${what}: ${e.message}`);
  return res.status(e.status || 500).json({ ok: false, error: e.message });
}

async function mustReadDraft(draftId) {
  const d = await readDraft(draftId);
  if (!d) { const e = new Error('Draft order not found'); e.status = 404; throw e; }
  return d;
}

// The plan on the draft, if it still holds it. A plan cancelled as a demo or staff mistake does not:
// the draft is a normal draft again and a new plan may be started on it.
async function planOn(draftId) {
  const plan = await store.getPlanByDraft(draftId);
  return plan && !isMistake(plan) ? plan : null;
}

async function activePlan(d) {
  const plan = await planOn(d.id);
  if (!plan) { const e = new Error(`${d.draft.name} has no buy plan`); e.status = 404; throw e; }
  if (plan.status !== 'active') { const e = new Error(`This buy plan is ${plan.status}`); e.status = 409; throw e; }
  await store.syncContact(plan, d.customer);   // messages go to the customer as they are now
  return plan;
}

async function getDraftPlan(req, res) {
  try {
    const d = await mustReadDraft(req.params.draftId);
    return res.json(await view(d, await planOn(d.id)));
  } catch (e) { return fail(res, e, 'read'); }
}

async function startPlan(req, res) {
  try {
    const mode = String(req.body?.mode || '');
    if (!MODES.includes(mode)) return res.status(400).json({ ok: false, error: 'Choose how the customer will pay: gold value first, or equal installments' });
    const n = Number(req.body?.installments || S.PLAN_INSTALLMENTS);
    if (!S.INSTALLMENT_CHOICES.includes(n)) return res.status(400).json({ ok: false, error: `Choose ${S.INSTALLMENT_CHOICES.join(', ')} installments` });
    const d = await mustReadDraft(req.body?.draftId);
    if (await planOn(d.id)) return res.status(409).json({ ok: false, error: `${d.draft.name} already has a buy plan` });
    const blockers = startBlockers(d, mode);
    if (blockers.length) return res.status(400).json({ ok: false, error: 'Cannot start a buy plan', missing: blockers });

    // A plan cancelled as a mistake gives up the draft id (it is unique) and keeps its row for the record.
    const earlier = await store.getPlanByDraft(d.id);
    if (earlier) await store.updatePlan(earlier.id, { draft_order_id: `${d.id}-cancelled-${earlier.id}` });

    const start = todayIst();
    const dueDates = S.dueDates(start, n);
    const table = await getBuyingRateTable().catch(() => null);
    const paid = paidSoFar(d);
    // Record first: the unique key makes this the one place two simultaneous starts are told apart.
    const plan = await store.insertPlan({
      draft_order_id: d.id, draft_name: d.draft.name,
      customer_id: d.customer.id, customer_email: d.customer.email,
      customer_phone: d.customer.phone, customer_name: d.customer.name,
      total: d.total, locked_gold_rate: lockedGoldRate(d), mode, installments: n,
      // Installment 1 of a gold plan: the gold value, or more if more was paid before the start.
      gold_value: mode === 'gold' ? Math.max(goldValue(d), paid) : null,
      start_rates: table?.sale_rates || null,
      start_date: start, due_dates: dueDates, status: 'active',
      // Payments already on the draft are not news to the customer.
      acknowledged_paid: paid, lines_key: linesKey(d.draft.line_items),
      snapshot: snapshotOf(d), created_by: req.staff?.sub ? String(req.staff.sub) : null,
    });

    // Then lock the draft. If Shopify refuses, take the plan back out so the two never disagree.
    // Both plans freeze the price (the buy-plan tag); only the gold plan has its rate locked for good.
    const planTags = mode === 'gold' ? [BUY_PLAN_TAG, RATE_LOCK_TAG] : [BUY_PLAN_TAG];
    try {
      const tags = [...new Set([...d.tags, ...planTags])].join(', ');
      await putJson(`draft_orders/${d.id}.json`, { draft_order: { id: d.id, tags } });
    } catch (e) {
      await store.deletePlan(plan.id).catch(() => {});
      throw new Error(`could not lock the draft: ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`);
    }
    // plan_due_dates puts each payment in its installment's slot; plan_total gives the draft its 6
    // slots (payments/installments.js).
    await updateDraftOrderMetafields(d.id, { plan_due_dates: dueDates.join(','), plan_total: String(d.total) });
    await notify.sendStarted(plan, d).catch(e => log.error('buy-plan', `started email ${d.draft.name}: ${e.message}`));

    log.info('buy-plan', `${d.draft.name}: ${mode} plan started — Rs${d.total} over ${n}, from ${start}`);
    return res.json(await view({ ...d, tags: [...d.tags, ...planTags] }, plan));
  } catch (e) { return fail(res, e, 'start'); }
}

async function sendLink(req, res) {
  try {
    const d = await mustReadDraft(req.body?.draftId);
    const plan = await activePlan(d);
    const check = S.validatePayment(S.planState(plan, d.legs, todayIst()), req.body?.amount);
    if (!check.ok) return res.status(400).json({ ok: false, error: check.reason, min: check.min, max: check.max });

    const st = S.planState(plan, d.legs, todayIst());
    const next = st.dueNow > 0 ? { k: st.k, due: st.dates[st.k - 1] } : (st.upcoming || { k: st.k, due: st.dates[st.k - 1] });
    const link = await createPlanLink(plan, check.amount);
    await notify.sendLink(plan, d, link, { k: next.k, dueDate: next.due });
    log.info('buy-plan', `${d.draft.name}: staff sent a link for Rs${check.amount}`);
    return res.json({ ok: true, amount: check.amount, phone: plan.customer_phone, url: link.shortUrl });
  } catch (e) { return fail(res, e, 'send-link'); }
}

// Before a gold plan starts: a link for the gold value still outstanding. Paying it is what lets
// staff start the plan (startBlockers). It is an ordinary payment on the draft; nothing is locked yet.
async function sendGoldLink(req, res) {
  try {
    const d = await mustReadDraft(req.body?.draftId);
    if (await planOn(d.id)) return res.status(409).json({ ok: false, error: `${d.draft.name} already has a buy plan` });
    const basic = startBlockers(d, 'equal');
    if (basic.length) return res.status(400).json({ ok: false, error: 'Cannot send the gold value link', missing: basic });
    const gv = goldValue(d);
    const amount = gv - paidSoFar(d);
    if (gv <= 0) return res.status(400).json({ ok: false, error: 'No gold value on the draft lines' });
    if (amount <= 0) return res.status(400).json({ ok: false, error: 'The gold value is already paid. Start the plan.' });
    const link = await createPlanLink({
      draft_order_id: d.id, draft_name: d.draft.name, total: d.total,
      customer_phone: d.customer.phone, customer_name: d.customer.name, customer_email: d.customer.email,
    }, amount);
    await notify.sendGoldLink(d, link, gv);
    log.info('buy-plan', `${d.draft.name}: gold value link for Rs${amount}`);
    return res.json({ ok: true, amount, phone: d.customer.phone, url: link.shortUrl });
  } catch (e) { return fail(res, e, 'gold-link'); }
}

// A payment taken in store. It goes through the same path as a GoKwik or Pine payment
// (handlePaymentCompletion: deposit row, the installment slot for today's period, amount_paid, tags),
// so the draft's payment table, the invoice and the reports see it like any other payment. The
// "payment received" email follows from the sweep.
function recordPaymentHandler(ctx) {
  return async function recordPayment(req, res) {
    try {
      const d = await mustReadDraft(req.body?.draftId);
      // Before the plan starts (a gold plan's gold value taken at the counter) there is no plan yet:
      // the payment just lands on the draft, and Start counts it.
      const existing = await planOn(d.id);
      const plan = existing ? await activePlan(d) : null;
      const mode = String(req.body?.mode || '').toLowerCase();
      if (!STORE_MODES.includes(mode)) return res.status(400).json({ ok: false, error: `How was it paid? ${STORE_MODES.join(', ')}` });
      const state = plan ? S.planState(plan, d.legs, todayIst())
        : (() => { const balance = Math.max(0, Math.round(d.total - paidSoFar(d))); return { balance, minPayment: Math.min(S.MIN_PAYMENT, balance) }; })();
      const check = S.validatePayment(state, req.body?.amount);
      if (!check.ok) return res.status(400).json({ ok: false, error: check.reason, min: check.min, max: check.max });
      if (typeof ctx?.handlePaymentCompletion !== 'function') throw new Error('payment recording is not wired');

      await ctx.handlePaymentCompletion({
        id: `buy-plan-${plan ? plan.id : 'pre-' + d.id}-${Date.now()}`, shopify_draft_id: d.id, draft_order_name: d.draft.name,
        customer_name: plan?.customer_name || d.customer?.name, is_partial: true, amount_paisa: check.amount * 100, payment_mode: mode,
      }, { paymentSource: 'buy-plan', paymentModeOverride: mode });
      sheet.pushSoon();
      log.info('buy-plan', `${d.draft.name}: Rs${check.amount} ${mode} recorded in store by ${req.staff?.sub || 'staff'}${plan ? '' : ' (before the plan started)'}`);
      const after = await mustReadDraft(d.id);
      return res.json(await view(after, plan));
    } catch (e) { return fail(res, e, 'record-payment'); }
  };
}

// Staff have changed the pieces on the draft. Reprice it at today's gold rate (the lock steps aside
// for this one reprice) and, once that has run, re-spread the plan over the installments left
// (sweep.js finishChange, 5 minutes later). Everything paid carries over; the dates stay. A gold plan
// gives up its locked rate for good and floats like an equal plan (founder, 2026-10-30).
async function changeProduct(req, res) {
  try {
    const d = await mustReadDraft(req.body?.draftId);
    const plan = await activePlan(d);
    if (plan.change_pending) return res.status(409).json({ ok: false, error: 'A product change is already being priced. Reopen in a minute.' });
    if (credit.vouchered(plan) > 0) return res.status(409).json({ ok: false, error: `A voucher (${credit.codesOf(plan).join(', ')}) was already issued on this plan, so it is settled at its price. Complete the draft, or cancel the plan.` });
    const planKey = plan.lines_key || linesKey((plan.snapshot || {}).line_items);
    if (linesKey(d.draft.line_items) === planKey) {
      return res.status(400).json({ ok: false, error: 'The pieces on the draft are the same as the plan\'s. Change the pieces on the draft first, then press Change product.' });
    }
    if (req.body?.confirm !== true) return res.status(400).json({ ok: false, error: 'Confirm the change first' });

    const lostLock = plan.mode === 'gold';
    const rates = await final.startReprice(plan, d, CHANGE_REPRICE_TAG);
    const pending = { started_at: new Date().toISOString(), old_total: S.currentTotal(plan), lost_lock: lostLock, by: req.staff?.sub || null };
    await store.updatePlan(plan.id, { mode: 'equal', change_pending: pending });
    followUp(plan.id);
    sheet.pushSoon();
    log.info('buy-plan', `${d.draft.name}: product change started${lostLock ? ' (gold lock given up)' : ''}, ${rates.length} piece(s) at today's rate`);
    return res.json({ ok: true, lostLock, message: 'Repricing the new pieces at today\'s gold rate. The new schedule usually appears here within a minute (reopen to see it), and the customer is emailed.' });
  } catch (e) { return fail(res, e, 'change-product'); }
}

// Staff cancel the plan. kind 'opted_out': the customer backs out and what they paid becomes a voucher,
// once staff confirm (moneyReceived) that the money really came in. kind 'mistake': a demo or a plan
// started by mistake — no voucher, no customer email. confirm: the tick on the screen.
async function cancelHandler(req, res) {
  try {
    const d = await mustReadDraft(req.body?.draftId);
    const plan = await activePlan(d);
    if (req.body?.confirm !== true) return res.status(400).json({ ok: false, error: 'Confirm the cancellation first' });
    const r = await cancelPlan(plan, d, {
      kind: String(req.body?.kind || ''), moneyReceived: req.body?.moneyReceived === true,
      verifiedSlots: Array.isArray(req.body?.verifiedSlots) ? req.body.verifiedSlots : null,
      note: req.body?.note, by: req.staff?.sub ? String(req.staff.sub) : null, today: todayIst(),
    });
    sheet.pushSoon();
    return res.json({ ok: true, ...r, voucher: r.voucher || null });
  } catch (e) { return fail(res, e, 'cancel'); }
}

// Staff issue the voucher the plan owes (credit.js). confirm: the customer agreed (paid over the
// price) / the tick that the money really came in (a closed plan).
async function issueVoucherHandler(req, res) {
  try {
    const d = await mustReadDraft(req.body?.draftId);
    const plan = await planOn(d.id);
    if (!plan) return res.status(404).json({ ok: false, error: `${d.draft.name} has no buy plan` });
    if (req.body?.confirm !== true) return res.status(400).json({ ok: false, error: 'Tick the confirmation first' });
    const today = todayIst();
    const r = await credit.issueStaffVoucher(plan, d, S.planState(plan, d.legs, today), {
      today, by: req.staff?.sub ? String(req.staff.sub) : null,
      verifiedSlots: Array.isArray(req.body?.verifiedSlots) ? req.body.verifiedSlots : null,
    });
    sheet.pushSoon();
    return res.json({ ok: true, ...r });
  } catch (e) { return fail(res, e, 'issue-voucher'); }
}

// ── Customer page: pay a different amount ───────────────────────────────────────────────────────


// Same logo as the plan emails (integrations/email/templates.js).
const LOGO_URL = 'https://cdn.shopify.com/s/files/1/0775/8322/0993/files/WhatsApp_Image_2026-04-23_at_10.42.47_AM.jpg?v=1777029219';

const page = (title, inner) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>
  body{margin:0;background:#f4f4f4;font-family:'Helvetica Neue',Arial,sans-serif;color:#111}
  .card{max-width:420px;margin:32px auto;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:28px 24px}
  h1{font-size:20px;font-weight:600;margin:0 0 6px} .muted{color:#777;font-size:14px;line-height:1.6}
  .row{display:flex;justify-content:space-between;font-size:15px;padding:6px 0;border-bottom:1px solid #f0f0f0}
  label{display:block;font-size:14px;margin:20px 0 6px} input{width:100%;box-sizing:border-box;font-size:18px;padding:12px;border:1px solid #ccc;border-radius:4px}
  button{margin-top:16px;width:100%;background:#000;color:#fff;border:0;border-radius:4px;font-size:16px;padding:14px;cursor:pointer}
  .err{background:#fdecec;color:#b42318;padding:10px 12px;border-radius:4px;font-size:14px;margin-top:14px}
  img{display:block;margin:0 auto 18px;width:110px}
</style></head><body><div class="card">
<img src="${LOGO_URL}" alt="Timanti">${inner}</div></body></html>`;
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));


async function loadForPayPage(token) {
  const planId = readPayToken(token);
  if (!planId) return { error: 'This link is not valid or has expired. Please contact the store.' };
  const plan = await store.getPlan(planId);
  if (!plan) return { error: 'We could not find this plan. Please contact the store.' };
  if (plan.status !== 'active') {
    return { error: plan.status === 'completed' ? 'This plan is fully paid. Thank you!'
      : plan.status === 'forfeited' ? `This plan has closed${plan.voucher_code ? ` and what you paid is now voucher ${plan.voucher_code}` : ''}. Please contact the store.`
      : 'This plan is no longer active. Please contact the store.' };
  }
  const d = await readDraft(plan.draft_order_id);
  if (!d) return { error: 'This plan is being updated. Please try again in a few minutes or contact the store.' };
  await store.syncContact(plan, d.customer);
  return { plan, d, state: S.planState(plan, d.legs, todayIst()) };
}

function payForm(token, plan, state, error = '', amount = '') {
  const due = state.dueNow > 0 ? `Due now: ${inr(state.dueNow)}`
    : state.upcoming ? `Next installment: ${inr(state.upcoming.amount)} on ${escHtml(state.upcoming.due)}` : '';
  return page('Pay your buy plan', `
    <h1>Buy plan ${escHtml(plan.draft_name)}</h1>
    <p class="muted">${state.lastPayment
      ? `Five payments have been made on this plan, so this payment is the whole balance, ${inr(state.balance)}.`
      : `Pay any amount from ${inr(state.minPayment)}. Paying more makes the installments after it smaller; paying less makes them larger.`}${S.awaitingFinalPrice(plan) ? " Your last installment is worked out 3 days before it is due, at that day&#39;s gold rate." : ""} A copy of the payment link is also sent to your phone and email.</p>
    <div class="row"><span>Paid so far</span><span>${inr(state.paid)}</span></div>
    <div class="row"><span>Balance</span><strong>${inr(state.balance)}</strong></div>
    ${due ? `<div class="row"><span>${due.split(':')[0]}</span><span>${due.slice(due.indexOf(':') + 2)}</span></div>` : ''}
    <form method="post" action="/pay/plan/${escHtml(token)}">
      <label for="amount">Amount to pay (₹${Number(state.minPayment).toLocaleString('en-IN')} to ₹${Number(state.balance).toLocaleString('en-IN')})</label>
      <input id="amount" name="amount" type="number" inputmode="numeric" min="${state.minPayment}" max="${state.balance}" step="1" value="${escHtml(amount || state.suggested)}" required>
      ${error ? `<div class="err">${escHtml(error)}</div>` : ''}
      <button type="submit">Continue to payment</button>
    </form>`);
}

async function payPageGet(req, res) {
  try {
    const r = await loadForPayPage(req.params.token);
    if (r.error) return res.status(200).send(page('Timanti', `<h1>Buy plan</h1><p class="muted">${escHtml(r.error)}</p>`));
    return res.send(payForm(req.params.token, r.plan, r.state));
  } catch (e) {
    log.error('buy-plan', `pay page: ${e.message}`);
    return res.status(500).send(page('Timanti', '<h1>Something went wrong</h1><p class="muted">Please try again shortly or contact the store.</p>'));
  }
}

async function payPagePost(req, res) {
  try {
    const r = await loadForPayPage(req.params.token);
    if (r.error) return res.status(200).send(page('Timanti', `<h1>Buy plan</h1><p class="muted">${escHtml(r.error)}</p>`));
    const check = S.validatePayment(r.state, req.body?.amount);
    if (!check.ok) return res.status(400).send(payForm(req.params.token, r.plan, r.state, check.reason, req.body?.amount));
    const link = await createPlanLink(r.plan, check.amount);
    log.info('buy-plan', `${r.plan.draft_name}: customer chose Rs${check.amount} on the pay page`);
    // The link opens now, and a copy goes by SMS + email: their earlier link was just cancelled, so
    // closing this tab must not leave them without one.
    const st = r.state;
    const next = st.dueNow > 0 ? { k: st.k, due: st.dates[st.k - 1] } : (st.upcoming || { k: st.k, due: st.dates[st.k - 1] });
    notify.sendLink(r.plan, r.d, link, { k: next.k, dueDate: next.due, chosen: true })
      .catch(e => log.error('buy-plan', `${r.plan.draft_name}: pay-page link copy: ${e.message}`));
    return res.redirect(303, link.shortUrl);
  } catch (e) {
    log.error('buy-plan', `pay page post: ${e.message}`);
    return res.status(500).send(page('Timanti', '<h1>Something went wrong</h1><p class="muted">Please try again shortly or contact the store.</p>'));
  }
}


// ── Operator: run the sweep now ─────────────────────────────────────────────────────────────────

async function sweepNow(req, res) {
  const secret = config.priceUpdateWebhookSecret;
  if (!secret || req.headers['x-webhook-secret'] !== secret) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const p = { ...(req.query || {}), ...(req.body || {}) };
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(p.asOf || '')) ? Date.parse(`${p.asOf}T06:00:00Z`) : Date.now();
  try {
    const only = String(p.draft || '').trim() || null;
    const result = await runBuyPlanSweep({ dryRun: String(p.dryRun) === 'true', now: asOf, restore: restoreDeletedPlanDraft, only });
    return res.json({ ok: true, ...result });
  } catch (e) { return fail(res, e, 'sweep'); }
}

// Operator: push the tracker sheet now.
async function sheetSyncNow(req, res) {
  const secret = config.priceUpdateWebhookSecret;
  if (!secret || req.headers['x-webhook-secret'] !== secret) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  try { return res.json(await sheet.pushToSheet()); } catch (e) { return fail(res, e, 'sheet-sync'); }
}

function register(app, ctx) {
  app.get('/api/buy-plan/draft/:draftId', requireStaffSession, getDraftPlan);
  app.post('/api/buy-plan/start', requireStaffSession, startPlan);
  app.post('/api/buy-plan/send-link', requireStaffSession, sendLink);
  app.post('/api/buy-plan/gold-link', requireStaffSession, sendGoldLink);
  app.post('/api/buy-plan/record-payment', requireStaffSession, recordPaymentHandler(ctx));
  app.post('/api/buy-plan/change-product', requireStaffSession, changeProduct);
  app.post('/api/buy-plan/cancel', requireStaffSession, cancelHandler);
  app.post('/api/buy-plan/issue-voucher', requireStaffSession, issueVoucherHandler);
  app.get('/pay/plan/:token', payPageGet);
  app.post('/pay/plan/:token', express.urlencoded({ extended: false }), payPagePost);
  app.post('/api/buy-plan/sweep', sweepNow);
  app.post('/api/buy-plan/sheet-sync', sheetSyncNow);
  sheet.startSheetSync();
}

// Re-exported for tests that predate the split into draft.js.
module.exports = { register, startBlockers, snapshotOf, lockedGoldRate };
