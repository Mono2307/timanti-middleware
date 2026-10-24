'use strict';

// Buy plan — reading a plan's draft. Everything the plan is computed from comes off the live draft:
// the payments are its installment legs, wherever they were recorded (GoKwik, Pine, cash, the panel).

const { getJson } = require('../../../core/shopify');
const { config } = require('../../../core/config');
const { readInstallments } = require('../installments');
const S = require('./schedule');

// Today in IST, YYYY-MM-DD — the store's calendar day, which is what a due date means to a customer.
const todayIst = (now = Date.now()) => new Date(now + 330 * 60 * 1000).toISOString().slice(0, 10);
const daysBetween = (fromIso, toIso) =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);

const splitTags = (tags) => String(tags || '').split(',').map(t => t.trim()).filter(Boolean);
const adminDraftUrl = (id) => `${String(config.shopify.storeUrl || '').replace(/\/+$/, '')}/admin/draft_orders/${id}`;

// Returns null if the draft no longer exists (deleted).
async function readDraft(draftId) {
  const id = String(draftId || '').replace(/\D/g, '');
  if (!id) { const e = new Error('draftId is required'); e.status = 400; throw e; }
  let draft;
  try {
    ({ draft_order: draft } = await getJson(`draft_orders/${id}.json`));
  } catch (e) {
    if (e.response?.status === 404) return null;
    throw e;
  }
  if (!draft) return null;
  const { metafields = [] } = await getJson(`draft_orders/${id}/metafields.json`);
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
// refreshed by the sweep as payments land.
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

module.exports = { todayIst, daysBetween, splitTags, adminDraftUrl, readDraft, startBlockers, snapshotOf, lockedGoldRate };
