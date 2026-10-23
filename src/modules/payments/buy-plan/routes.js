'use strict';

/**
 * Buy plan routes — called by the "Buy plan" admin action on a draft order (More actions), which
 * authenticates with its session token exactly like the outside-repair intake.
 *
 *   GET  /api/buy-plan/draft/:draftId   what the action shows: the plan and its 6 rows, or — before a
 *                                       plan exists — a preview and anything that blocks starting one
 *   POST /api/buy-plan/start            start the plan: record it, lock the price, stamp the dates
 *   POST /api/buy-plan/send-link        send the customer a GoKwik link for any amount between the
 *                                       amount due now (the minimum) and the balance
 *
 * Starting a plan is ALWAYS a deliberate staff action. Nothing else — a payment link, a payment, a
 * tag — ever turns a draft into a buy plan.
 */

const { config } = require('../../../core/config');
const { getJson, putJson } = require('../../../core/shopify');
const { updateDraftOrderMetafields } = require('../../../core/metafields');
const { log } = require('../../../core/logger');
const { verifySessionToken } = require('../../after-sales/session_token');
const { readInstallments } = require('../installments');
const { RATE_LOCK_TAG, BUY_PLAN_TAG } = require('./lock');
const S = require('./schedule');
const store = require('./store');

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

// Today in IST, YYYY-MM-DD — the store's calendar day, which is what a due date means to a customer.
const todayIst = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);

const splitTags = (tags) => String(tags || '').split(',').map(t => t.trim()).filter(Boolean);

// Everything a plan is computed from, read live off the draft.
async function readDraft(draftId) {
  const id = String(draftId || '').replace(/\D/g, '');
  if (!id) { const e = new Error('draftId is required'); e.status = 400; throw e; }
  const [{ draft_order: draft }, { metafields = [] }] = await Promise.all([
    getJson(`draft_orders/${id}.json`),
    getJson(`draft_orders/${id}/metafields.json`),
  ]);
  if (!draft) { const e = new Error('Draft order not found'); e.status = 404; throw e; }
  const mf = {};
  for (const m of metafields) if (m.namespace === 'custom') mf[m.key] = m.value;

  const c = draft.customer || {};
  const customer = {
    id: c.id ? String(c.id) : null,
    name: [c.first_name, c.last_name].filter(Boolean).join(' ') || draft.billing_address?.name || '',
    email: c.email || draft.email || '',
    phone: c.phone || draft.billing_address?.phone || draft.shipping_address?.phone || '',
  };
  // The plan finances what is left to COLLECT — after vouchers, exchange notes, old gold and any
  // CAD advance — not the sticker total. Payments already on the draft count towards installment 1.
  const net = parseFloat(mf.amount_to_be_collected);
  const total = Math.round(Number.isFinite(net) && net > 0 ? net : parseFloat(draft.total_price) || 0);
  const legs = readInstallments(mf).filter(l => l.type !== 'cad_advance');
  return { id, draft, mf, customer, total, legs, tags: splitTags(draft.tags) };
}

function startBlockers(d) {
  const b = [];
  if (d.draft.status !== 'open') b.push(`${d.draft.name} is already ${d.draft.status}`);
  if (!d.customer.id) b.push('Add a customer to the draft');
  if (!d.customer.phone) b.push('The customer needs a phone number (payment links go by SMS)');
  if (!d.customer.email) b.push('The customer needs an email address (reminders go by email)');
  if (d.total <= 0) b.push('The draft has nothing to collect');
  else if (S.replay(d.total, d.legs).balance <= 0) b.push('The draft is already fully paid');
  return b;
}

// What the draft would be restored from if it were deleted. Taken when the plan starts and
// refreshed as payments land.
function snapshotOf(d) {
  const keep = ['variant_id', 'product_id', 'title', 'variant_title', 'sku', 'quantity', 'price',
    'properties', 'applied_discount', 'taxable', 'requires_shipping', 'custom'];
  return {
    taken_at: new Date().toISOString(),
    name: d.draft.name,
    line_items: (d.draft.line_items || []).map(li => Object.fromEntries(keep.map(k => [k, li[k]]))),
    applied_discount: d.draft.applied_discount || null,
    customer_id: d.customer.id,
    email: d.customer.email,
    billing_address: d.draft.billing_address || null,
    shipping_address: d.draft.shipping_address || null,
    note: d.draft.note || null,
    tags: d.tags,
    metafields: d.mf,
  };
}

// The gold rate each line was priced at — the rate the plan locks. Draft-level custom.gold_rate
// overrides, else each line's own _gold_rate property.
function lockedGoldRate(d) {
  if (String(d.mf.gold_rate || '').trim()) return String(d.mf.gold_rate).trim();
  return (d.draft.line_items || [])
    .map(li => (li.properties || []).find(p => p.name === '_gold_rate')?.value)
    .filter(Boolean).join(',') || null;
}

function view(d, plan) {
  if (plan) {
    const state = S.replay(plan.total, d.legs);
    return {
      ok: true, draft: d.draft.name, customer: d.customer, plan: {
        status: plan.status, total: Number(plan.total), startDate: plan.start_date,
        lockedGoldRate: plan.locked_gold_rate, paid: state.paid, balance: state.balance,
        next: state.next, minPayment: state.owed,
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

async function getDraftPlan(req, res) {
  try {
    const d = await readDraft(req.params.draftId);
    return res.json(view(d, await store.getPlanByDraft(d.id)));
  } catch (e) { return fail(res, e, 'read'); }
}

async function startPlan(req, res) {
  try {
    const d = await readDraft(req.body?.draftId);
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
    await updateDraftOrderMetafields(d.id, { plan_due_dates: dueDates.join(','), plan_total: String(d.total) });

    log.info('buy-plan', `${d.draft.name}: plan started — Rs${d.total} over ${S.PLAN_INSTALLMENTS}, from ${start}`);
    return res.json(view({ ...d, tags: [...d.tags, BUY_PLAN_TAG, RATE_LOCK_TAG] }, plan));
  } catch (e) { return fail(res, e, 'start'); }
}

async function sendLink(req, res) {
  try {
    const d = await readDraft(req.body?.draftId);
    const plan = await store.getPlanByDraft(d.id);
    if (!plan) return res.status(404).json({ ok: false, error: `${d.draft.name} has no buy plan` });
    const check = S.validatePayment(S.replay(plan.total, d.legs), req.body?.amount);
    if (!check.ok) return res.status(400).json({ ok: false, error: check.reason, min: check.min, max: check.max });

    // The existing send-link flow does the rest: GoKwik link, payment_links row, SMS and email.
    const tags = [...d.tags.filter(t => !/^send-link-/i.test(t)), `send-link-${check.amount}`].join(', ');
    await putJson(`draft_orders/${d.id}.json`, { draft_order: { id: d.id, tags } });
    log.info('buy-plan', `${d.draft.name}: payment link requested for Rs${check.amount}`);
    return res.json({ ok: true, amount: check.amount, phone: d.customer.phone });
  } catch (e) { return fail(res, e, 'send-link'); }
}

function register(app) {
  app.get('/api/buy-plan/draft/:draftId', requireStaffSession, getDraftPlan);
  app.post('/api/buy-plan/start', requireStaffSession, startPlan);
  app.post('/api/buy-plan/send-link', requireStaffSession, sendLink);
}

module.exports = { register, startBlockers, snapshotOf, lockedGoldRate };
