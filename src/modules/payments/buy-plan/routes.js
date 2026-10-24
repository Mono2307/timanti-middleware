'use strict';

/**
 * Buy plan routes.
 *
 * Staff — the "Buy plan" admin action on a draft (More actions), authenticated by its session token:
 *   GET  /api/buy-plan/draft/:draftId   the plan and its 6 rows, or a preview + what blocks starting
 *   POST /api/buy-plan/start            start the plan: record it, lock the price, stamp the dates,
 *                                       email the customer their schedule
 *   POST /api/buy-plan/send-link        a GoKwik link for any amount from the amount due now (the
 *                                       minimum) to the balance — SMS + the plan email
 *
 * Customer — the "Pay a different amount" link in every plan email (signed token, no login):
 *   GET  /pay/plan/:token               the balance, the minimum, an amount box
 *   POST /pay/plan/:token               validate → GoKwik link → redirect to it
 *
 * Operator:
 *   POST /api/buy-plan/sweep            run the reminder sweep now (x-webhook-secret =
 *                                       PRICE_UPDATE_WEBHOOK_SECRET). dryRun=true reports only;
 *                                       asOf=YYYY-MM-DD runs it as if it were that day.
 *
 * Starting a plan is ALWAYS a deliberate staff action. Nothing else — a payment link, a payment, a
 * tag — ever turns a draft into a buy plan.
 */

const express = require('express');
const { config } = require('../../../core/config');
const { putJson } = require('../../../core/shopify');
const { updateDraftOrderMetafields } = require('../../../core/metafields');
const { log } = require('../../../core/logger');
const { verifySessionToken } = require('../../after-sales/session_token');
const { RATE_LOCK_TAG, BUY_PLAN_TAG } = require('./lock');
const S = require('./schedule');
const store = require('./store');
const notify = require('./notify');
const { createPlanLink, readPayToken, customPayUrl } = require('./links');
const { runBuyPlanSweep } = require('./sweep');
const { restoreDeletedPlanDraft } = require('./restore');
const { todayIst, readDraft, startBlockers, snapshotOf, lockedGoldRate } = require('./draft');

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

function view(d, plan) {
  if (plan) {
    const state = S.replay(plan.total, d.legs);
    return {
      ok: true, draft: d.draft.name, customer: d.customer, plan: {
        status: plan.status, total: Number(plan.total), startDate: plan.start_date,
        lockedGoldRate: plan.locked_gold_rate, paid: state.paid, balance: state.balance,
        next: state.next, minPayment: state.owed, customPayUrl: customPayUrl(plan.id),
      },
      rows: S.scheduleRows(plan, d.legs, todayIst()),
    };
  }
  const start = todayIst();
  return {
    ok: true, draft: d.draft.name, customer: d.customer, plan: null,
    preview: { total: d.total, startDate: start, monthly: S.amountDue(1, d.total) },
    rows: S.scheduleRows({ total: d.total, start_date: start }, d.legs, start),
    blockers: startBlockers(d),
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

async function getDraftPlan(req, res) {
  try {
    const d = await mustReadDraft(req.params.draftId);
    return res.json(view(d, await store.getPlanByDraft(d.id)));
  } catch (e) { return fail(res, e, 'read'); }
}

async function startPlan(req, res) {
  try {
    const d = await mustReadDraft(req.body?.draftId);
    if (await store.getPlanByDraft(d.id)) return res.status(409).json({ ok: false, error: `${d.draft.name} already has a buy plan` });
    const blockers = startBlockers(d);
    if (blockers.length) return res.status(400).json({ ok: false, error: 'Cannot start a buy plan', missing: blockers });

    const start = todayIst();
    const dueDates = S.dueDates(start);
    // Record first: the unique key makes this the one place two simultaneous starts are told apart.
    const plan = await store.insertPlan({
      draft_order_id: d.id, draft_name: d.draft.name,
      customer_id: d.customer.id, customer_email: d.customer.email,
      customer_phone: d.customer.phone, customer_name: d.customer.name,
      total: d.total, locked_gold_rate: lockedGoldRate(d),
      start_date: start, due_dates: dueDates, status: 'active',
      snapshot: snapshotOf(d), created_by: req.staff?.sub ? String(req.staff.sub) : null,
    });

    // Then lock the draft. If Shopify refuses, take the plan back out so the two never disagree.
    try {
      const tags = [...new Set([...d.tags, BUY_PLAN_TAG, RATE_LOCK_TAG])].join(', ');
      await putJson(`draft_orders/${d.id}.json`, { draft_order: { id: d.id, tags } });
    } catch (e) {
      await store.deletePlan(plan.id).catch(() => {});
      throw new Error(`could not lock the draft: ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`);
    }
    // plan_total is also what gives the draft its 6 installment slots (payments/installments.js).
    await updateDraftOrderMetafields(d.id, { plan_due_dates: dueDates.join(','), plan_total: String(d.total) });

    // Payments already on the draft are not news to the customer: mark them confirmed.
    const settled = S.replay(plan.total, d.legs).settled.length;
    for (let k = 1; k <= settled; k++) await store.markSent(plan.id, k, 'customer', 'received');
    await notify.sendStarted(plan, d).catch(e => log.error('buy-plan', `started email ${d.draft.name}: ${e.message}`));

    log.info('buy-plan', `${d.draft.name}: plan started — Rs${d.total} over ${S.PLAN_INSTALLMENTS}, from ${start}`);
    return res.json(view({ ...d, tags: [...d.tags, BUY_PLAN_TAG, RATE_LOCK_TAG] }, plan));
  } catch (e) { return fail(res, e, 'start'); }
}

async function sendLink(req, res) {
  try {
    const d = await mustReadDraft(req.body?.draftId);
    const plan = await store.getPlanByDraft(d.id);
    if (!plan) return res.status(404).json({ ok: false, error: `${d.draft.name} has no buy plan` });
    const check = S.validatePayment(S.replay(plan.total, d.legs), req.body?.amount);
    if (!check.ok) return res.status(400).json({ ok: false, error: check.reason, min: check.min, max: check.max });

    const link = await createPlanLink(plan, check.amount);
    await notify.sendLink(plan, d, link);
    log.info('buy-plan', `${d.draft.name}: staff sent a link for Rs${check.amount}`);
    return res.json({ ok: true, amount: check.amount, phone: plan.customer_phone, url: link.shortUrl });
  } catch (e) { return fail(res, e, 'send-link'); }
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
  if (plan.status !== 'active') return { error: plan.status === 'completed' ? 'This plan is fully paid. Thank you!' : 'This plan is no longer active. Please contact the store.' };
  const d = await readDraft(plan.draft_order_id);
  if (!d) return { error: 'This plan is being updated. Please try again in a few minutes or contact the store.' };
  return { plan, d, state: S.replay(plan.total, d.legs) };
}

function payForm(token, plan, state, error = '', amount = '') {
  return page('Pay your buy plan', `
    <h1>Buy plan ${escHtml(plan.draft_name)}</h1>
    <p class="muted">Installment ${state.next} of 6. Pay the amount due or more. Anything extra lowers the installments after this one.</p>
    <div class="row"><span>Paid so far</span><span>${inr(state.paid)}</span></div>
    <div class="row"><span>Balance</span><strong>${inr(state.balance)}</strong></div>
    <div class="row"><span>Amount due now (minimum)</span><span>${inr(state.owed)}</span></div>
    <form method="post" action="/pay/plan/${escHtml(token)}">
      <label for="amount">Amount to pay (₹${Number(state.owed).toLocaleString('en-IN')} to ₹${Number(state.balance).toLocaleString('en-IN')})</label>
      <input id="amount" name="amount" type="number" inputmode="numeric" min="${state.owed}" max="${state.balance}" step="1" value="${escHtml(amount || state.owed)}" required>
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
    const result = await runBuyPlanSweep({ dryRun: String(p.dryRun) === 'true', now: asOf, restore: restoreDeletedPlanDraft });
    return res.json({ ok: true, ...result });
  } catch (e) { return fail(res, e, 'sweep'); }
}

function register(app) {
  app.get('/api/buy-plan/draft/:draftId', requireStaffSession, getDraftPlan);
  app.post('/api/buy-plan/start', requireStaffSession, startPlan);
  app.post('/api/buy-plan/send-link', requireStaffSession, sendLink);
  app.get('/pay/plan/:token', payPageGet);
  app.post('/pay/plan/:token', express.urlencoded({ extended: false }), payPagePost);
  app.post('/api/buy-plan/sweep', sweepNow);
}

// Re-exported for tests that predate the split into draft.js.
module.exports = { register, startBlockers, snapshotOf, lockedGoldRate };
