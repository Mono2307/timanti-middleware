'use strict';

// Buy plan — reading a plan's draft. Everything the plan is computed from comes off the live draft:
// the payments are its installment legs, wherever they were recorded (GoKwik, Pine, cash, the panel).

const { getJson, graphql } = require('../../../core/shopify');
const { config } = require('../../../core/config');
const { readInstallments } = require('../installments');

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
  const mfAt = {};   // when each metafield was last written (collectFresh)
  for (const m of metafields) if (m.namespace === 'custom') { mf[m.key] = m.value; mfAt[m.key] = m.updated_at; }

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
  return { id, draft, mf, mfAt, customer, total, legs, tags: splitTags(draft.tags) };
}

// The jewellery lines the pricing engine prices (server.js handleRecalculatePriceTag uses the same
// filter, and custom.gold_rate is positional over exactly these lines, in this order): not an Exchange
// Note line, not a negative discount line, and either hydrated (a Gold property) or a variant.
const prop = (li, name) => (li.properties || []).find(p => p.name === name)?.value;
const rs = (v) => parseFloat(String(v || '').replace(/Rs|,/g, '').trim()) || 0;
function productLines(lineItems) {
  return (lineItems || []).filter(li =>
    !(String(li.title || '').startsWith('Exchange Note ') || prop(li, '_exc_ref') !== undefined) &&
    !(String(li.title || '').toLowerCase().includes('discount') && parseFloat(li.price) < 0) &&
    (prop(li, 'Gold') !== undefined || !!li.variant_id));
}

const GST = 1.03;
// The gold plan's first installment: the gold in every piece (the line's Gold property, already
// × quantity), in whole rupees, WITHOUT GST: the tax is collected over installments 2..6
// (founder, 2026-10-29).
function goldValue(d) {
  return Math.round(productLines(d.draft.line_items).reduce((sum, li) => sum + rs(prop(li, 'Gold')), 0));
}

const paidSoFar = (d) => (d.legs || []).reduce((sum, l) => sum + Math.max(0, Number(l.value) || 0), 0);

function startBlockers(d, mode = 'equal') {
  const b = [];
  if (d.draft.status !== 'open') b.push(`${d.draft.name} is already ${d.draft.status}`);
  if (!d.customer.id) b.push('Add a customer to the draft');
  if (!d.customer.phone) b.push('The customer needs a phone number (payment links go by SMS)');
  if (!d.customer.email) b.push('The customer needs an email address (reminders go by email)');
  if (d.total <= 0) b.push('The draft has nothing to collect');
  else if (paidSoFar(d) >= d.total) b.push('The draft is already fully paid');
  if (mode === 'gold' && !b.length) {
    const gv = goldValue(d);
    const paid = paidSoFar(d);
    if (gv <= 0) b.push('No gold value on the draft lines (no Gold breakup), so the gold rate cannot be locked this way');
    else if (paid < gv) b.push(`Collect the gold value first: Rs${gv.toLocaleString('en-IN')}${paid ? ` (Rs${paid.toLocaleString('en-IN')} paid so far)` : ''}`);
  }
  return b;
}

// Which pieces are on the draft: the jewellery lines by variant (or title) and quantity, sorted.
// A plan's pieces change only through "Change product" (routes.js); the sweep compares this against
// the snapshot to catch a draft edited without it.
const linesKey = (lineItems) => productLines(lineItems)
  .map(li => `${li.variant_id || String(li.title || '').trim()}x${li.quantity || 1}`).sort().join('|');

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

// ── Writing lines back ──────────────────────────────────────────────────────────────────────────
// GraphQL priceOverride is the only way to give a variant line a price of our own (REST resets it to
// the catalog price), and it needs API 2025-01. draftOrderUpdate REPLACES the line list, so callers
// pass every line, the ones they did not change included.
const GQL_VERSION = '2025-01';

// A REST applied_discount ({ value, value_type, title, description }) as GraphQL input.
function discountInput(ad) {
  const value = parseFloat(ad && ad.value);
  if (!ad || !(value > 0)) return undefined;
  const out = { value, valueType: String(ad.value_type || '').toLowerCase() === 'percentage' ? 'PERCENTAGE' : 'FIXED_AMOUNT' };
  if (ad.title) out.title = String(ad.title);
  if (ad.description) out.description = String(ad.description);
  return out;
}

function lineInput(li) {
  const attrs = (li.properties || []).map(p => ({ key: p.name, value: String(p.value) }));
  const price = { amount: parseFloat(li.price).toFixed(2), currencyCode: 'INR' };
  const discount = discountInput(li.applied_discount);
  const out = li.variant_id
    ? { variantId: `gid://shopify/ProductVariant/${li.variant_id}`, quantity: li.quantity, priceOverride: price, customAttributes: attrs }
    : { title: li.title, quantity: li.quantity, originalUnitPriceWithCurrency: price,
        taxable: li.taxable ?? true, requiresShipping: li.requires_shipping ?? false, customAttributes: attrs };
  if (discount) out.appliedDiscount = discount;
  return out;
}

// The tag the payment step of the draft webhook consumes once it has recomputed the collect figures
// (server.js handlePaymentMetafieldSync) — the same nudge the admin panel sends after a save.
const SYNC_TAG = 'sync-payment';

// The amount to collect (what d.total is read from) was recomputed after the draft's last write. A
// reprice writes the lines and drops its tags first; the collect figure is recomputed by a later pass.
// Unknown timestamps count as fresh.
function collectFresh(d) {
  const at = Date.parse(d?.mfAt?.amount_to_be_collected || '');
  const draftAt = Date.parse(d?.draft?.updated_at || '');
  if (!Number.isFinite(at) || !Number.isFinite(draftAt)) return true;
  return at >= draftAt - 2000;
}
const withTags = (tags, add) => {
  const list = [...(tags || [])];
  for (const t of add) if (!list.some(x => String(x).toLowerCase() === t)) list.push(t);
  return list;
};

async function writeDraftLines(draftId, lineItems, { tags } = {}) {
  const input = { lineItems: (lineItems || []).map(lineInput) };
  if (tags) input.tags = tags;
  const res = await graphql(
    `mutation($id: ID!, $input: DraftOrderInput!) { draftOrderUpdate(id: $id, input: $input) {
       draftOrder { id } userErrors { field message } } }`,
    { id: `gid://shopify/DraftOrder/${String(draftId).replace(/\D/g, '')}`, input }, { apiVersion: GQL_VERSION });
  const errs = res?.draftOrderUpdate?.userErrors || [];
  if (errs.length) throw new Error(`draftOrderUpdate: ${JSON.stringify(errs)}`);
}

// ── A re-added piece keeps its locked price ─────────────────────────────────────────────────────
// Removing a piece from the draft and adding it back from the catalog brings it in at TODAY's catalog
// price with no breakup (hydration steps aside on a locked draft). The pieces key is unchanged, so
// checkLines sees nothing. These compare each jewellery line with the snapshot's line for the same
// piece and quantity.
const BREAKUP_PROPS = ['Gold', 'Diamond', 'Making', 'Making Charges', 'Gemstone', '_gold_rate', 'Gross Value'];
const pieceOf = (li) => `${li.variant_id || String(li.title || '').trim()}x${li.quantity || 1}`;

// Pure. The live lines (by index into liveLines) whose price or breakup differs from the snapshot's
// line for the same piece. Only breakup properties the snapshot line carries are compared.
function linesToRestore(snapLines, liveLines) {
  const pool = new Map();
  for (const s of productLines(snapLines)) {
    if (!pool.has(pieceOf(s))) pool.set(pieceOf(s), []);
    pool.get(pieceOf(s)).push(s);
  }
  const out = [];
  (liveLines || []).forEach((li, idx) => {
    if (!productLines([li]).length) return;
    const snap = (pool.get(pieceOf(li)) || []).shift();
    const want = snap ? parseFloat(snap.price) : NaN;
    if (!Number.isFinite(want)) return;
    const priceMoved = Math.abs((parseFloat(li.price) || 0) - want) >= 0.5;
    const propsMoved = BREAKUP_PROPS.some(name => {
      const v = prop(snap, name);
      return v !== undefined && String(prop(li, name) ?? '') !== String(v);
    });
    if (priceMoved || propsMoved) out.push({ idx, title: li.title || snap.title || '', from: parseFloat(li.price) || 0, to: want, snap });
  });
  return out;
}

// Pure. The live line list with each restored line swapped for its snapshot line.
const withRestored = (liveLines, fixes) => (liveLines || []).map((li, idx) => {
  const f = fixes.find(x => x.idx === idx);
  return f ? { ...f.snap } : li;
});

module.exports = {
  todayIst, daysBetween, splitTags, adminDraftUrl, readDraft, startBlockers, snapshotOf, lockedGoldRate,
  productLines, goldValue, paidSoFar, prop, rs, GST, linesKey,
  GQL_VERSION, SYNC_TAG, collectFresh, withTags, discountInput, lineInput, writeDraftLines, linesToRestore, withRestored,
};
