'use strict';

/**
 * In-store loyalty: the draft-order side.
 *
 * HOW IT WORKS
 *   Staff press "Apply loyalty" in the panel → the panel adds the tag `apply-loyalty`.
 *   handleLoyaltyStep (a step in server.js runDraftUpdateHandlers) then:
 *     - checks there is a customer, they have reached a tier, and no ORDER-LEVEL discount code is
 *       on the draft. The campaign's automatic diamond discount and manual per-line cuts stack with
 *       loyalty (founder, 2026-10-21); vouchers / exchange notes / old gold / advances are tender;
 *     - works out which product lines are eligible and the rate (tier % + occasion bonus);
 *     - stores that decision in custom.loyalty_applied and adds the tags `loyalty-applied` and
 *       `reprice`.
 *   The reprice then adds a { t:'dia', m:'pct', v:rate, src:'loyalty' } entry and a
 *   { t:'mk', m:'pct', v:making %, src:'loyalty', cap } entry to each eligible line's per-line
 *   discounts (engine.withLoyaltyEntries); engine.capLoyaltyMaking holds the making cut within the
 *   tier's per-transaction cap, and the existing pricing engine does the rest: pre-GST, each cut
 *   capped at its component, Discount on Diamond / Making / Taxable Value / GST props written
 *   exactly as for any other discount.
 *
 *   Because the entry is a PERCENTAGE re-applied on every reprice, staff editing the Diamond prop
 *   (or weights, carats) moves the discount with it. Because eligibility is stored per VARIANT, the
 *   positional-pricing wipe that follows a line change cannot lose it; this step re-checks the line
 *   set on every pass and re-evaluates when it changes.
 *
 *   `remove-loyalty` takes it off. If an order-level code is put on a draft that carries loyalty,
 *   this step takes loyalty off and says so — the code would otherwise be silently dropped.
 *
 *   The birthday/anniversary +2% is good for one transaction a month: a draft only gets it when no
 *   other redemption has taken it this IST month (ledger.occasionRedemptionSince).
 *
 * TAGS ARE ≤ 40 CHARACTERS (Shopify limit), so failures are tagged with a short code
 * (`loyalty-invalid: below tier`) and the full sentence goes to custom.loyalty_note for the panel.
 */

const { getJson, putJson, deleteJson, graphql } = require('../../core/shopify');
const { updateDraftOrderMetafields } = require('../../core/metafields');
const { supabase } = require('../../core/supabase');
const { config } = require('../../core/config');
const { log } = require('../../core/logger');
const E = require('./engine');
const ledger = require('./ledger');
const { loadConfig } = require('./config');
const { readCustomer } = require('./customer');
const { isRateLocked } = require('../payments/buy-plan/lock');

const APPLIED_KEY = 'loyalty_applied';
const NOTE_KEY = 'loyalty_note';
const T_APPLY = 'apply-loyalty';
const T_REMOVE = 'remove-loyalty';
const T_ON = 'loyalty-applied';
const T_INVALID = 'loyalty-invalid';

const splitTags = (s) => String(s || '').split(',').map(t => t.trim()).filter(Boolean);
const hasTag = (tags, t) => tags.some(x => x.toLowerCase() === t);

/** Same filter the pricing engine uses for product lines (server.js handleRecalculatePriceTag). */
function productLines(draft) {
  return (draft.line_items || []).filter(item =>
    !E.isExchangeLine(item) &&
    !((item.title || '').toLowerCase().includes('discount') && parseFloat(item.price) < 0) &&
    ((item.properties || []).some(p => p.name === 'Gold') || !!item.variant_id));
}

const propOf = (item, name) => {
  const p = (item.properties || []).find(x => x && x.name === name);
  return p ? p.value : '';
};
const rupees = (v) => Math.abs(parseFloat(String(v || '').replace(/[^0-9.]/g, '')) || 0);

/**
 * Catalogue facts per variant that eligibility rules need: SKU, product type, tags, collections and
 * the catalogue diamond value. One GraphQL read for the whole draft.
 */
async function variantFacts(variantIds) {
  const ids = [...new Set(variantIds.filter(Boolean).map(String))];
  if (!ids.length) return {};
  const data = await graphql(`query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant {
      id sku
      diamond: metafield(namespace: "custom", key: "price_breakup_diamond") { value }
      making:  metafield(namespace: "custom", key: "price_breakup_making") { value }
      jewel:   metafield(namespace: "custom", key: "jewel_code") { value }
      product { productType tags collections(first: 25) { nodes { handle } } }
    } } }`, { ids: ids.map(id => `gid://shopify/ProductVariant/${id}`) });
  const out = {};
  for (const n of (data.nodes || [])) {
    if (!n || !n.id) continue;
    out[n.id.split('/').pop()] = {
      sku: n.sku || '',
      productType: (n.product && n.product.productType) || '',
      tags: (n.product && n.product.tags) || [],
      collections: ((n.product && n.product.collections && n.product.collections.nodes) || []).map(c => c.handle),
      diamondUnit: n.diamond ? Number(n.diamond.value) || 0 : 0,
      makingUnit: n.making ? Number(n.making.value) || 0 : 0,
      jewelCode: n.jewel ? n.jewel.value : '',
    };
  }
  return out;
}

/** Engine-ready line descriptions for a draft's product lines. */
async function describeDraftLines(draft) {
  const items = productLines(draft);
  const facts = await variantFacts(items.map(i => i.variant_id));
  return items.map(item => {
    const f = facts[String(item.variant_id)] || {};
    const qty = Number(item.quantity) || 1;
    // The live Diamond prop wins — staff edit it at the counter. The catalogue value is the fallback
    // for a line the pricing engine has not touched yet.
    const diamond = rupees(propOf(item, 'Diamond')) || (f.diamondUnit || 0) * qty;
    // Same for making: the line's PRE-discount Making prop, else the catalogue figure.
    const making = rupees(propOf(item, 'Making')) || rupees(propOf(item, 'Making Charges')) || (f.makingUnit || 0) * qty;
    return {
      variant_id: item.variant_id, title: item.title, quantity: qty,
      sku: f.sku || item.sku || '', productType: f.productType || '', tags: f.tags || [],
      collections: f.collections || [], jewelCode: propOf(item, '_jewel_code') || f.jewelCode || '',
      diamond, making,
    };
  });
}

function hasLineEntries(mf) {
  try {
    const arr = mf.line_discounts ? JSON.parse(mf.line_discounts) : [];
    return Array.isArray(arr) && arr.some(e => Array.isArray(e) && e.length);
  } catch { return false; }
}

async function readDraftMetafields(draftId) {
  const data = await getJson(`draft_orders/${draftId}/metafields.json`);
  const all = data.metafields || [];
  const map = {};
  for (const m of all) if (m.namespace === 'custom') map[m.key] = m.value;
  return { all, map };
}

async function deleteDraftMetafield(draftId, all, key) {
  const mf = all.find(m => m.namespace === 'custom' && m.key === key);
  if (!mf) return;
  await deleteJson(`draft_orders/${draftId}/metafields/${mf.id}.json`)
    .catch(e => log.error('loyalty', `draft ${draftId}: could not delete custom.${key} — ${e.message}`));
}

async function setDraftTags(draftId, tags) {
  await putJson(`draft_orders/${draftId}.json`, { draft_order: { id: draftId, tags: [...new Set(tags)].join(', ') } });
}

/**
 * Tier ladder and progress for the staff panel: every tier with whether it is reached, the previous
 * and next thresholds, and the share of the way from one to the other (100 at the top tier).
 */
function tierProgress(t, cfg) {
  const tiers = [...(cfg.tiers || [])].sort((a, b) => a.min - b.min);
  const from = t.tier ? t.tier.min : 0;
  const progressPct = t.next
    ? Math.max(0, Math.min(100, Math.floor(((t.points - from) / (t.next.min - from)) * 100)))
    : 100;
  return {
    points: t.points, tier: t.tier, next: t.next, gapToNext: t.gapToNext, progressPct,
    ladder: tiers.map(x => ({ key: x.key, name: x.name, min: x.min, pct: x.pct, making_pct: x.making_pct, making_cap: x.making_cap, reached: t.points >= x.min })),
  };
}

/**
 * Evaluate loyalty for a draft without writing anything. Used by the apply path and by the panel's
 * preview, so what staff see before pressing Apply is exactly what Apply will do.
 */
async function evaluateDraft(draft, mfMap) {
  const cfg = await loadConfig();
  const customerId = draft.customer && draft.customer.id;
  if (!customerId) return { ok: false, code: 'no customer', reason: 'Add the customer to the draft first.' };
  const customer = await readCustomer(customerId);
  if (!customer) return { ok: false, code: 'no customer', reason: 'The customer on this draft could not be found.' };
  let points = 0;
  try { points = await ledger.customerPoints(supabase, customerId); }
  catch (e) {
    // Ledger unreachable: fall back to the copy on the customer rather than refusing at the counter.
    log.error('loyalty', `ledger read failed for ${customerId}, using customer metafield: ${e.message}`);
    points = Number(customer.points) || 0;
  }
  // The customer's standing on its own (tier, spend, progress), shown to staff even when Apply is
  // refused, so the counter always knows who they are serving.
  const t = E.tierFor(points, cfg);
  const standing = { customer: { id: String(customerId), name: customer.name }, ...tierProgress(t, cfg) };
  const mf = mfMap || {};
  const other = E.otherDiscountOnDraft(mf) ||
    // A rupee discount_applied with no loyalty record, no rate and NO per-line entries is a legacy flat
    // custom discount. With per-line entries (e.g. the auto diamond discount) it is just their resolved
    // total, already judged by otherDiscountOnDraft above.
    (!E.readApplied(mf[APPLIED_KEY]) && !(Number(mf.discount_rate) > 0) && !hasLineEntries(mf) &&
      Math.abs(parseFloat(mf.discount_applied || 0)) > 0 ? 'a discount is already applied' : '');
  if (other) return { ...standing, ok: false, code: 'other discount', reason: `Loyalty cannot be combined with an order-level discount code: ${other}. Remove it first.` };

  const lines = await describeDraftLines(draft);
  const occasionUsed = await occasionUsedThisMonth(customerId, draft.id);
  const r = E.computeLoyalty({ points, birthday: customer.birthday, anniversary: customer.anniversary, lines, cfg, occasionUsed });
  const base = {
    ...standing,
    points: r.points, tier: r.tier, next: r.next, gapToNext: r.gapToNext,
    rate: r.rate, basePct: r.basePct, occasion: r.occasion, total: r.total,
    makingPct: r.makingPct, makingCap: r.makingCap, diamondTotal: r.diamondTotal, makingTotal: r.makingTotal,
    lines: lines.map((l, i) => ({
      variant_id: l.variant_id, title: l.title, diamond: l.diamond, making: l.making,
      eligible: r.perLine[i] ? r.perLine[i].eligible : false,
      reason: r.perLine[i] ? r.perLine[i].reason : '',
      discount: r.perLine[i] ? r.perLine[i].discount : 0,
      makingDiscount: r.perLine[i] ? r.perLine[i].makingDiscount : 0,
    })),
  };
  if (!r.ok) {
    const code = r.reason === 'below the first tier' ? 'below tier'
      : r.reason === 'no eligible pieces' ? 'no eligible pieces' : 'programme off';
    const reason = code === 'below tier'
      ? `Lifetime spend ${Math.round(r.points).toLocaleString('en-IN')} is below the first tier (${r.next ? r.next.min.toLocaleString('en-IN') : '-'}).`
      : code === 'no eligible pieces' ? 'None of the pieces on this draft is eligible.' : 'The loyalty programme is switched off.';
    return { ...base, ok: false, code, reason };
  }
  return { ...base, ok: true, code: '', reason: '' };
}

/**
 * The redemption that already took this month's birthday/anniversary bonus, other than this
 * draft's own, or null. A ledger outage gives the bonus rather than refusing it at the counter.
 */
async function occasionUsedThisMonth(customerId, draftId) {
  try {
    const r = await ledger.occasionRedemptionSince(supabase, customerId, E.istMonthStartIso(), { excludeDraftId: draftId });
    return r ? { order_name: r.order_name || null, channel: r.channel } : null;
  } catch (e) {
    log.error('loyalty', `occasion-use read failed for ${customerId}: ${e.message}`);
    return null;
  }
}

/** custom.loyalty_applied — compact, it is stored as a text metafield. */
function appliedRecord(draft, ev) {
  return JSON.stringify({
    tier: ev.tier.key, name: ev.tier.name, rate: ev.rate,
    mk: ev.makingPct || 0, mkcap: ev.makingCap || 0,
    occ: ev.occasion.occasions.join('+') || '',
    cid: String(ev.customer.id),
    eligible_variants: ev.lines.filter(l => l.eligible).map(l => String(l.variant_id)),
    checked: productLines(draft).map(i => String(i.variant_id || '')).sort(),
    at: new Date().toISOString(),
  });
}

/** Tag set after a refusal: drop our trigger tags, record one short invalid tag. */
function refusedTags(tags, code) {
  return [...tags.filter(t => !/^loyalty-invalid/i.test(t) && ![T_APPLY, T_REMOVE].includes(t.toLowerCase())),
    `${T_INVALID}: ${String(code).replace(/,/g, ' -')}`.slice(0, 40)];
}

async function takeOff(draft, tags, all, { invalidCode = null, note = null } = {}) {
  await deleteDraftMetafield(draft.id, all, APPLIED_KEY);
  // discount_applied is the rupee total the reprice wrote while loyalty was on. Left behind, the
  // pricing engine's legacy reader would treat it as a flat custom discount and re-apply it.
  await deleteDraftMetafield(draft.id, all, 'discount_applied');
  if (note) await updateDraftOrderMetafields(draft.id, { [NOTE_KEY]: note });
  else await deleteDraftMetafield(draft.id, all, NOTE_KEY);
  let next = tags.filter(t => ![T_APPLY, T_REMOVE, T_ON].includes(t.toLowerCase()) && !/^loyalty-invalid/i.test(t));
  if (invalidCode) next.push(`${T_INVALID}: ${String(invalidCode).replace(/,/g, ' -')}`.slice(0, 40));
  next.push('reprice');
  await setDraftTags(draft.id, next);
}

/**
 * The draft-update step. Runs on every pass but costs nothing unless one of the loyalty tags is
 * present, so drafts without loyalty pay no extra Shopify calls (see the webhook rate-limit note in
 * server.js runDraftUpdateChain).
 */
async function handleLoyaltyStep(draft) {
  if (!config.loyalty.enabled) return;
  const draftId = draft && draft.id;
  if (!draftId) return;
  const tags = splitTags(draft.tags);
  const wantApply = hasTag(tags, T_APPLY);
  const wantRemove = hasTag(tags, T_REMOVE);
  const isOn = hasTag(tags, T_ON);
  if (!wantApply && !wantRemove && !isOn) return;

  const { all, map } = await readDraftMetafields(draftId);

  if (wantRemove) {
    await takeOff(draft, tags, all);
    log.info('loyalty', `draft ${draft.name || draftId}: loyalty removed by staff`);
    return;
  }

  const applied = E.readApplied(map[APPLIED_KEY]);

  if (wantApply && isRateLocked(tags)) {
    // A buy plan locked the price on the day it started; a loyalty discount would change it.
    await updateDraftOrderMetafields(draftId, { [NOTE_KEY]: 'This draft is on a buy plan. Its price is locked, so loyalty cannot be applied.' });
    await setDraftTags(draftId, refusedTags(tags, 'rate locked'));
    log.info('loyalty', `draft ${draft.name || draftId}: loyalty refused — rate-locked (buy plan)`);
    return;
  }

  if (wantApply) {
    // Re-applying is a refresh: drop our own record first so the exclusivity check does not trip
    // over loyalty's own entries.
    const ev = await evaluateDraft(draft, map);
    if (!ev.ok) {
      await updateDraftOrderMetafields(draftId, { [NOTE_KEY]: ev.reason });
      await deleteDraftMetafield(draftId, all, APPLIED_KEY);
      await setDraftTags(draftId, [...refusedTags(tags, ev.code).filter(t => t.toLowerCase() !== T_ON), ...(applied ? ['reprice'] : [])]);
      log.info('loyalty', `draft ${draft.name || draftId}: loyalty refused — ${ev.reason}`);
      return;
    }
    await updateDraftOrderMetafields(draftId, { [APPLIED_KEY]: appliedRecord(draft, ev) });
    await deleteDraftMetafield(draftId, all, NOTE_KEY);
    const next = tags.filter(t => t.toLowerCase() !== T_APPLY && !/^loyalty-invalid/i.test(t));
    await setDraftTags(draftId, [...next, T_ON, 'reprice']);
    log.info('loyalty', `draft ${draft.name || draftId}: ${ev.tier.key} ${ev.rate}% dia + ${ev.makingPct}% making (cap Rs${ev.makingCap}) applied to ${ev.lines.filter(l => l.eligible).length} line(s), est. Rs${ev.total}`);
    return;
  }

  // Maintenance pass on a draft that carries loyalty.
  if (!applied) {
    await setDraftTags(draftId, tags.filter(t => t.toLowerCase() !== T_ON));
    return;
  }
  const other = E.otherDiscountOnDraft(map);
  if (other) {
    await takeOff(draft, tags, all, {
      invalidCode: 'other discount added',
      note: `Loyalty was taken off because ${other}. Loyalty cannot be combined with an order-level discount code.`,
    });
    log.info('loyalty', `draft ${draft.name || draftId}: loyalty removed — ${other}`);
    return;
  }
  const lineSet = productLines(draft).map(i => String(i.variant_id || '')).sort().join(',');
  const customerNow = String((draft.customer && draft.customer.id) || '');
  if (lineSet === (applied.checked || []).join(',') && customerNow === String(applied.cid)) return;

  // The pieces or the customer changed since loyalty was applied — decide again.
  const ev = await evaluateDraft(draft, map);
  if (!ev.ok) {
    await takeOff(draft, tags, all, { invalidCode: ev.code, note: `Loyalty was taken off: ${ev.reason}` });
    log.info('loyalty', `draft ${draft.name || draftId}: loyalty dropped after a change — ${ev.reason}`);
    return;
  }
  await updateDraftOrderMetafields(draftId, { [APPLIED_KEY]: appliedRecord(draft, ev) });
  await setDraftTags(draftId, [...tags, 'reprice']);
  log.info('loyalty', `draft ${draft.name || draftId}: loyalty re-evaluated after a change — ${ev.rate}% on ${ev.lines.filter(l => l.eligible).length} line(s)`);
}

/**
 * At conversion: record the in-store redemption. Idempotent per draft. Reads the draft's own
 * metafields — they are still there after completion — for the rupees the reprice actually applied.
 */
async function recordStoreRedemption(draft, orderId, orderName) {
  if (!config.loyalty.enabled) return;
  const tags = splitTags(draft.tags);
  if (!hasTag(tags, T_ON)) return;
  if (await ledger.storeRedemptionForDraft(supabase, draft.id)) return;
  const { map } = await readDraftMetafields(draft.id);
  const applied = E.readApplied(map[APPLIED_KEY]);
  if (!applied) return;
  const pre = Math.abs(parseFloat(map.discount_applied || 0)) || 0;
  const eligible = new Set((applied.eligible_variants || []).map(String));
  const diamondBase = productLines(draft).filter(i => eligible.has(String(i.variant_id)))
    .reduce((s, i) => s + rupees(propOf(i, 'Diamond')), 0);
  await ledger.insertRedemption(supabase, {
    channel: 'store', status: 'used',
    customer_id: String(applied.cid), order_customer_id: String((draft.customer && draft.customer.id) || applied.cid),
    draft_id: String(draft.id), order_id: String(orderId), order_name: orderName || null,
    tier: applied.tier, rate: applied.rate, occasion: applied.occ || null,
    diamond_base: diamondBase, discount_pre_tax: pre, discount_incl_tax: E.onlineAmount(pre),
    lines: applied.eligible_variants, used_at: new Date().toISOString(),
  });
  log.info('loyalty', `order ${orderName || orderId}: store redemption recorded — ${applied.tier} ${applied.rate}%, Rs${pre.toFixed(2)} pre-tax`);
}

// Draft custom.* keys that carry an ORDER-LEVEL discount. While loyalty is on they are ignored by
// the reprice (an order-level code cannot sit beside loyalty), so a stale value never adds one.
// Per-line entries — the campaign's auto discount, manual cuts — are kept and stack with loyalty.
const ORDER_LEVEL_KEYS = ['discount_rate', 'discount_kind', 'discount_mode', 'discount_code', 'discount_codes', 'discount_applied'];

/**
 * The one hook into the pricing engine. Called by handleRecalculatePriceTag right after it reads the
 * draft's custom.* metafields, BEFORE anything is priced. When loyalty is applied it rewrites the
 * in-memory map so that:
 *   - every order-level discount key is gone (loyalty is exclusive), and
 *   - custom.line_discounts carries loyalty's diamond % and making % entries on each eligible product line.
 * The metafields themselves are not touched. When loyalty is not applied the map is left alone.
 */
function applyLoyaltyToPricingInputs(mfMap, draft) {
  if (!config.loyalty.enabled || !mfMap) return false;
  const applied = E.readApplied(mfMap[APPLIED_KEY]);
  if (!applied) return false;
  for (const k of ORDER_LEVEL_KEYS) delete mfMap[k];
  let existing = [];
  try { existing = mfMap.line_discounts ? JSON.parse(mfMap.line_discounts) : []; } catch { existing = []; }
  mfMap.line_discounts = JSON.stringify(E.withLoyaltyEntries(Array.isArray(existing) ? existing : [], productLines(draft), applied));
  return true;
}

module.exports = {
  applyLoyaltyToPricingInputs,
  APPLIED_KEY, NOTE_KEY, T_APPLY, T_REMOVE, T_ON,
  handleLoyaltyStep, evaluateDraft, describeDraftLines, recordStoreRedemption, productLines,
  readDraftMetafields, occasionUsedThisMonth,
};
