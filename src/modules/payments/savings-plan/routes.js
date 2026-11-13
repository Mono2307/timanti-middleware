'use strict';

/**
 * Savings plan routes. Everything is off unless SAVINGS_PLAN_ENABLED (config.savingsPlan.enabled).
 *
 * Staff — from the draft (session token, as the Buy plan screen):
 *   GET  /api/savings-plan/draft/:draftId   the plan (state, schedule, what can be done now), or — for a
 *                                           draft not yet on a plan — what a 6- or 10-month plan would be
 *                                           and what stops it starting
 *   POST /api/savings-plan/start            { draftId, months, nominee? } start the plan on a draft whose
 *                                           only line is the custom item "Savings Plan" (instalment ×
 *                                           months); the first link goes out unless instalment 1 is paid
 *   POST /api/savings-plan/send-link        { draftId } a GoKwik link for what is due now (or the next
 *                                           instalment) — SMS + email
 *   POST /api/savings-plan/issue-voucher    { draftId, how, confirm } how: full | early | stopped |
 *                                           terminated (end.js). Nothing ever issues one on its own.
 *   POST /api/savings-plan/cancel           { draftId, confirm } a demo or a plan started by mistake, only
 *                                           while nothing is paid: no voucher, the draft is released
 *
 * Payments taken in store are typed into the draft's Installments section in the panel, exactly as on
 * any draft (HQ, 12 Nov 2026); the plan reads them from the draft.
 *
 * Operator:
 *   POST /api/savings-plan/sweep            run the sweep now (x-webhook-secret = PRICE_UPDATE_WEBHOOK_SECRET);
 *                                           dryRun=true, asOf=YYYY-MM-DD, draft=D412 as for the buy plan
 */

const { config } = require('../../../core/config');
const { log } = require('../../../core/logger');
const { verifySessionToken } = require('../../after-sales/session_token');
const R = require('./rules');
const store = require('./store');
const notify = require('./notify');
const { issueVoucher, choices, CLAIM } = require('./end');
const { runSavingsSweep, linkAmount } = require('./sweep');
const sheet = require('./sheet');
const { createPlanLink, cancelOpenLinks } = require('../buy-plan/links');
const {
  readDraft, todayIst, startCheck, tagsFor, writeTags, makeLineNonTaxable, termsMetafields, writeMetafields,
} = require('./draft');

function requireEnabled(req, res, next) {
  if (!config.savingsPlan.enabled) return res.status(503).json({ ok: false, error: 'Savings plans are not switched on yet' });
  return next();
}

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
    log.warn('savings-plan', `auth refused: ${e.message}`);
    return res.status(e.message === 'not configured' ? 503 : 401).json({ ok: false, error: `auth: ${e.message}` });
  }
}

const fail = (res, e, what) => {
  log.error('savings-plan', `${what}: ${e.message}`);
  return res.status(e.status || 500).json({ ok: false, error: e.message });
};
const refuse = (message, status = 400) => Object.assign(new Error(message), { status });

async function mustReadDraft(draftId) {
  const d = await readDraft(draftId);
  if (!d) throw refuse('Draft order not found', 404);
  return d;
}

// The plan the draft holds. A cancelled plan gives the draft back.
async function planOn(draftId) {
  const plan = await store.getPlanByDraft(draftId);
  return plan && plan.status !== 'cancelled' ? plan : null;
}

function view(d, plan) {
  const today = todayIst();
  if (plan) {
    const st = R.savingsState(plan, d.legs, today);
    return {
      ok: true, draft: d.draft.name, customer: d.customer,
      plan: {
        status: plan.status, months: plan.months, instalment: Number(plan.instalment), total: Number(plan.total),
        startDate: plan.start_date, maturity: st.maturity, nominee: plan.nominee || null,
        paid: st.paid, paidCount: st.paidCount, lateCount: st.lateCount, lateLimit: R.LATE_LIMIT, bonusOk: st.bonusOk,
        next: st.next, overdueDays: st.overdueDays, closeOn: st.closeOn, dueNow: st.dueNow, linkAmount: linkAmount(st),
        fullyPaid: st.fullyPaid, oddPayments: st.oddPayments, overpaid: st.overpaid,
        redeemNow: st.redeem,
        voucherCode: plan.voucher_code && plan.voucher_code !== CLAIM ? plan.voucher_code : null,
        voucherValue: plan.voucher_value != null ? Number(plan.voucher_value) : null,
        endKind: plan.end_kind || null, closedReason: plan.closed_reason || null,
      },
      rows: st.rows,
      actions: choices(plan, st),
    };
  }
  const options = {};
  for (const months of R.MONTH_CHOICES) {
    const c = startCheck(d, months);
    const A = c.instalment;
    options[months] = {
      problems: c.problems, instalment: A, total: c.total,
      bonus: A ? Math.round(A * R.PLANS[months].fullPct / 100) : null,
      voucherAtEnd: A ? A * months + Math.round(A * R.PLANS[months].fullPct / 100) : null,
      dates: R.dueDates(today, months), maturity: R.maturityDate(today, months),
    };
  }
  return { ok: true, draft: d.draft.name, customer: d.customer, plan: null, options };
}

async function getDraftPlan(req, res) {
  try {
    const d = await mustReadDraft(req.params.draftId);
    return res.json(view(d, await planOn(d.id)));
  } catch (e) { return fail(res, e, 'read'); }
}

async function startPlan(req, res) {
  try {
    const months = Number(req.body?.months);
    const d = await mustReadDraft(req.body?.draftId);
    if (await planOn(d.id)) throw refuse(`${d.draft.name} already has a savings plan`, 409);
    if (d.tags.some(t => ['buy-plan', 'ot:buy-plan'].includes(String(t).toLowerCase()))) {
      throw refuse(`${d.draft.name} is a buy plan`, 409);
    }
    const c = startCheck(d, months);
    if (c.problems.length) return res.status(400).json({ ok: false, error: 'Cannot start a savings plan', missing: c.problems });

    // A plan cancelled as a mistake gives up the draft id (it is unique) and keeps its row.
    const earlier = await store.getPlanByDraft(d.id);
    if (earlier) await store.updatePlan(earlier.id, { draft_order_id: `${d.id}-cancelled-${earlier.id}` });

    const start = todayIst();
    const plan = await store.insertPlan({
      draft_order_id: d.id, draft_name: d.draft.name,
      customer_id: d.customer.id, customer_email: d.customer.email, customer_phone: d.customer.phone, customer_name: d.customer.name,
      months, instalment: c.instalment, total: c.total, start_date: start, due_dates: R.dueDates(start, months),
      nominee: String(req.body?.nominee || '').trim() || null, status: 'active',
      // Money already on the draft is not news to the customer.
      acknowledged_paid: d.legs.reduce((s, l) => s + (Number(l.value) || 0), 0),
      created_by: req.staff?.sub ? String(req.staff.sub) : null,
    });

    // Then the draft. If Shopify refuses, take the plan back out so the two never disagree.
    try {
      await makeLineNonTaxable(d);
      await writeTags(d, tagsFor(d, 'active'));
    } catch (e) {
      await store.deletePlan(plan.id).catch(() => {});
      throw new Error(`could not set up the draft: ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`);
    }
    // savings_months also gives the draft its 10 instalment slots (payments/installments.js).
    await writeMetafields(d, termsMetafields(plan));

    const st = R.savingsState(plan, d.legs, start);
    let first = null;
    if (st.dueNow > 0) {
      first = await createPlanLink(plan, linkAmount(st), { installmentType: 'savings_plan' })
        .catch(e => { log.error('savings-plan', `${d.draft.name}: first link: ${e.message}`); return null; });
    }
    await notify.sendStarted(plan, d, st, first).catch(e => log.error('savings-plan', `started email ${d.draft.name}: ${e.message}`));
    if (first) await store.markSent(plan.id, 1, 'customer', 'due');
    sheet.pushSoon();
    log.info('savings-plan', `${d.draft.name}: ${months}-month plan started at Rs${c.instalment}/month from ${start}`);
    return res.json({ ...view({ ...d, tags: tagsFor(d, 'active') }, plan), firstLink: first ? first.shortUrl : null });
  } catch (e) { return fail(res, e, 'start'); }
}

async function activePlan(d) {
  const plan = await planOn(d.id);
  if (!plan) throw refuse(`${d.draft.name} has no savings plan`, 404);
  if (plan.status !== 'active') throw refuse(`This savings plan is ${plan.status}`, 409);
  await store.syncContact(plan, d.customer);
  return plan;
}

async function sendLink(req, res) {
  try {
    const d = await mustReadDraft(req.body?.draftId);
    const plan = await activePlan(d);
    const st = R.savingsState(plan, d.legs, todayIst());
    if (st.fullyPaid) throw refuse('Every instalment is paid');
    const amount = linkAmount(st);
    const l = await createPlanLink(plan, amount, { installmentType: 'savings_plan' });
    await notify.sendDue(plan, d, st, l, { k: st.next.k, dueDate: st.next.due, overdue: st.overdueDays > 0 });
    log.info('savings-plan', `${d.draft.name}: staff sent a link for Rs${amount}`);
    return res.json({ ok: true, amount, phone: plan.customer_phone, url: l.shortUrl });
  } catch (e) { return fail(res, e, 'send-link'); }
}

async function issueVoucherHandler(req, res) {
  try {
    const d = await mustReadDraft(req.body?.draftId);
    const plan = await planOn(d.id);
    if (!plan) throw refuse(`${d.draft.name} has no savings plan`, 404);
    if (req.body?.confirm !== true) throw refuse('Tick that you have checked the payments on the draft first');
    const how = String(req.body?.how || '');
    if (!['full', 'early', 'stopped', 'terminated'].includes(how)) throw refuse('Choose how the plan ends');
    const today = todayIst();
    const r = await issueVoucher(plan, d, R.savingsState(plan, d.legs, today), { how, today, by: req.staff?.sub ? String(req.staff.sub) : null });
    sheet.pushSoon();
    return res.json({ ok: true, ...r });
  } catch (e) { return fail(res, e, 'issue-voucher'); }
}

async function cancelHandler(req, res) {
  try {
    const d = await mustReadDraft(req.body?.draftId);
    const plan = await activePlan(d);
    if (req.body?.confirm !== true) throw refuse('Confirm the cancellation first');
    if (d.legs.length) throw refuse('Money has been paid on this plan. Use Issue voucher → Customer stops the plan instead.');
    await store.updatePlan(plan.id, { status: 'cancelled', closed_at: new Date().toISOString(), closed_reason: `cancelled by ${req.staff?.sub || 'staff'} (demo or mistake)` });
    await cancelOpenLinks(d.id).catch(() => {});
    await writeTags(d, d.tags.filter(t => !R.isSavingsStatusTag(t) && String(t).toLowerCase() !== R.PLAN_TAG));
    await writeMetafields(d, { savings_status: 'cancelled' });
    log.info('savings-plan', `${d.draft.name}: cancelled (demo or mistake)`);
    return res.json({ ok: true });
  } catch (e) { return fail(res, e, 'cancel'); }
}

async function sweepNow(req, res) {
  const secret = config.priceUpdateWebhookSecret;
  if (!secret || req.headers['x-webhook-secret'] !== secret) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const p = { ...(req.query || {}), ...(req.body || {}) };
  const now = /^\d{4}-\d{2}-\d{2}$/.test(String(p.asOf || '')) ? Date.parse(`${p.asOf}T06:00:00Z`) : Date.now();
  try {
    return res.json({ ok: true, ...(await runSavingsSweep({ dryRun: String(p.dryRun) === 'true', now, only: String(p.draft || '').trim() || null })) });
  } catch (e) { return fail(res, e, 'sweep'); }
}

function register(app) {
  app.get('/api/savings-plan/draft/:draftId', requireEnabled, requireStaffSession, getDraftPlan);
  app.post('/api/savings-plan/start', requireEnabled, requireStaffSession, startPlan);
  app.post('/api/savings-plan/send-link', requireEnabled, requireStaffSession, sendLink);
  app.post('/api/savings-plan/issue-voucher', requireEnabled, requireStaffSession, issueVoucherHandler);
  app.post('/api/savings-plan/cancel', requireEnabled, requireStaffSession, cancelHandler);
  app.post('/api/savings-plan/sweep', requireEnabled, sweepNow);
}

module.exports = { register, view };
