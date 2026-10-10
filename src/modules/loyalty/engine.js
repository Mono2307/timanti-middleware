'use strict';

/**
 * Loyalty rules engine — pure functions, no I/O.
 *
 * Every number the programme produces comes from here, online and in-store alike, so the two
 * channels cannot disagree about what a customer is owed. Callers fetch the data (customer, lines,
 * config) and hand it in; nothing below talks to Shopify or Supabase.
 *
 * THE PROGRAMME (founder's spec, 2026-10-07 — loyalty/planning/LOYALTY_PLAN_A_MIDDLEWARE.md)
 *   ₹1 of order value = 1 point. Points only measure lifetime spend toward a tier; they are never
 *   spent. Tiers (editable in config): ₹2L → 3%, ₹5L → 5%, ₹10L → 7%, off the DIAMOND value only.
 *   +2% in the birthday or anniversary month (once, even if both fall in the same month).
 *   Loyalty never combines with another discount; vouchers and exchange notes are tender, not
 *   discounts, and are unaffected.
 *
 * UNITS
 *   Diamond values here are PRE-TAX rupees, as every `Diamond` line prop and every
 *   `custom.price_breakup_diamond` variant metafield already is. The in-store reprice takes the
 *   percentage off that pre-tax figure itself. Online, Shopify discounts a GST-inclusive price, so
 *   the rupee amount handed to a Shopify code is grossed up by the GST factor (see onlineAmount).
 */

const GST_FACTOR = 1.03;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// ── Tiers ───────────────────────────────────────────────────────────────────────────────────────

/** Tiers sorted by threshold, lowest first. */
function sortedTiers(cfg) {
  return [...((cfg && cfg.tiers) || [])].sort((a, b) => a.min - b.min);
}

/**
 * The tier a lifetime points total qualifies for, or null below the first threshold.
 * Also reports the next tier and the gap to it, for the account page and the panel.
 */
function tierFor(points, cfg) {
  const pts = Math.max(0, Math.floor(Number(points) || 0));
  const tiers = sortedTiers(cfg);
  let current = null;
  let next = null;
  for (const t of tiers) {
    if (pts >= t.min) current = t;
    else { next = t; break; }
  }
  return {
    tier: current,
    next,
    gapToNext: next ? next.min - pts : 0,
    points: pts,
  };
}

// ── Birthday / anniversary ──────────────────────────────────────────────────────────────────────

/**
 * Month (1-12) of a date-ish value: "1990-03-14", "1990-03-14T00:00:00Z", or a Date. Null when it
 * cannot be read. Parsed from the string itself, not through Date, so a bare date is never shifted
 * a day by a timezone conversion.
 */
function monthOf(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value) ? null : value.getUTCMonth() + 1;
  const m = String(value).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const month = parseInt(m[2], 10);
  return month >= 1 && month <= 12 ? month : null;
}

/** Today's calendar month in IST (UTC+5:30), whatever the server's clock zone. */
function istMonth(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  return ist.getUTCMonth() + 1;
}

/** Today's date in IST as YYYY-MM-DD. */
function istDate(now = new Date()) {
  return new Date(now.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * The occasion bonus in force for a customer today.
 * Returns { pct, occasions: ['birthday'|'anniversary', ...] }. With occasion_bonus_stacks false
 * (the default) two occasions in one month still give one bonus — the larger.
 */
function occasionBonus({ birthday, anniversary } = {}, now = new Date(), cfg = {}) {
  const month = istMonth(now);
  const hits = [];
  const b = cfg.birthday || {};
  const a = cfg.anniversary || {};
  if (Number(b.pct) > 0 && monthOf(birthday) === month) hits.push({ name: 'birthday', pct: Number(b.pct) });
  if (Number(a.pct) > 0 && monthOf(anniversary) === month) hits.push({ name: 'anniversary', pct: Number(a.pct) });
  if (!hits.length) return { pct: 0, occasions: [] };
  const pct = cfg.occasion_bonus_stacks
    ? hits.reduce((s, h) => s + h.pct, 0)
    : Math.max(...hits.map(h => h.pct));
  return { pct, occasions: hits.map(h => h.name) };
}

// ── Line eligibility ────────────────────────────────────────────────────────────────────────────

const lc = (s) => String(s || '').trim().toLowerCase();
const listLc = (xs) => (Array.isArray(xs) ? xs : []).map(lc).filter(Boolean);

/**
 * Whether one line can carry the loyalty discount, and why not when it can't.
 *
 * line: { sku, productType, tags: [], collections: [] (handles or ids), jewelCode, diamond,
 *         isExchange, isNegativeDiscount }
 *
 * Exclude rules always beat include rules. An empty include block means "everything not excluded".
 */
function lineEligibility(line, cfg) {
  const el = (cfg && cfg.eligibility) || {};
  const inc = el.include || {};
  const exc = el.exclude || {};
  if (line.isExchange) return { eligible: false, reason: 'exchange note line' };
  if (line.isNegativeDiscount) return { eligible: false, reason: 'discount line' };

  const sku = lc(line.sku);
  const tags = listLc(line.tags);
  const cols = listLc(line.collections);
  const jc = lc(line.jewelCode);

  if (sku && listLc(exc.skus).includes(sku)) return { eligible: false, reason: `SKU ${line.sku} excluded` };
  const exTag = listLc(exc.tags).find(t => tags.includes(t));
  if (exTag) return { eligible: false, reason: `tag ${exTag} excluded` };
  const exCol = listLc(exc.collections).find(c => cols.includes(c));
  if (exCol) return { eligible: false, reason: `collection ${exCol} excluded` };
  if (listLc(exc.product_types).includes(lc(line.productType)) && lc(line.productType)) {
    return { eligible: false, reason: `product type ${line.productType} excluded` };
  }
  const exPrefix = listLc(exc.jewel_code_prefixes).find(p => jc && jc.startsWith(p));
  if (exPrefix) return { eligible: false, reason: `jewel code ${line.jewelCode} excluded` };

  const incTypes = listLc(inc.product_types);
  const incTags = listLc(inc.tags);
  const incCols = listLc(inc.collections);
  const incSkus = listLc(inc.skus);
  const hasInclude = incTypes.length || incTags.length || incCols.length || incSkus.length;
  if (hasInclude) {
    const hit = incTypes.includes(lc(line.productType)) ||
      incTags.some(t => tags.includes(t)) ||
      incCols.some(c => cols.includes(c)) ||
      (sku && incSkus.includes(sku));
    if (!hit) return { eligible: false, reason: 'not in the included products' };
  }

  if (el.require_diamond_value !== false && !(Number(line.diamond) > 0)) {
    return { eligible: false, reason: 'no diamond value' };
  }
  return { eligible: true, reason: '' };
}

// ── The benefit ─────────────────────────────────────────────────────────────────────────────────

/**
 * Everything loyalty gives this customer on these lines today.
 *
 * input: { points, birthday, anniversary, lines: [{ ...lineEligibility fields, diamond (pre-tax Rs,
 *          already × quantity) }], now, cfg }
 * Returns { ok, reason, tier, rate, basePct, occasion, perLine: [{ idx, eligible, reason, diamond,
 *           discount }], total }
 *   discount is PRE-TAX rupees, capped at the line's diamond value.
 */
function computeLoyalty({ points, birthday, anniversary, lines = [], now = new Date(), cfg } = {}) {
  const t = tierFor(points, cfg);
  const empty = (reason) => ({
    ok: false, reason, tier: t.tier, next: t.next, gapToNext: t.gapToNext, points: t.points,
    rate: 0, basePct: 0, occasion: { pct: 0, occasions: [] }, perLine: [], total: 0,
  });
  if (!cfg || cfg.enabled === false) return empty('loyalty programme is switched off');
  if (!t.tier) return empty('below the first tier');

  const occasion = occasionBonus({ birthday, anniversary }, now, cfg);
  const rate = Number(t.tier.pct) + occasion.pct;
  const perLine = lines.map((line, idx) => {
    const e = lineEligibility(line, cfg);
    const diamond = Math.max(0, Number(line.diamond) || 0);
    const discount = e.eligible ? Math.min(diamond, r2(diamond * rate / 100)) : 0;
    return { idx, eligible: e.eligible, reason: e.reason, diamond: r2(diamond), discount };
  });
  const total = r2(perLine.reduce((s, l) => s + l.discount, 0));
  if (!perLine.some(l => l.eligible)) {
    return { ...empty('no eligible pieces'), tier: t.tier, rate, basePct: Number(t.tier.pct), occasion, perLine };
  }
  return {
    ok: true, reason: '', tier: t.tier, next: t.next, gapToNext: t.gapToNext, points: t.points,
    rate, basePct: Number(t.tier.pct), occasion, perLine, total,
  };
}

/** A pre-tax rupee discount expressed on Shopify's GST-inclusive prices (for an online code). */
function onlineAmount(preTax) {
  return r2(preTax * GST_FACTOR);
}

// ── Earning ─────────────────────────────────────────────────────────────────────────────────────

/** Same test the pricing engine uses (server.js isExcLine): exchange-note lines are tender. */
function isExchangeLine(li) {
  return String(li.title || '').startsWith('Exchange Note ') ||
    (li.properties || []).some(p => p && p.name === '_exc_ref');
}

/**
 * Points an order earns: what the customer actually spent on it, in whole rupees.
 *
 *   order total (GST-inclusive, after real discounts such as loyalty or a promo)
 *   + tender that Shopify books as a reduction but is really payment — online VCH voucher codes,
 *     and exchange-note lines in-store
 *   − refunds (Shopify refund transactions, or the middleware's custom.amount_refunded, whichever
 *     is larger — in-store refunds are only recorded in the metafield)
 *
 * Cancelled orders earn nothing. Points are counted when the ORDER exists — a draft's installment
 * entries never earn on their own (founder's rule, 2026-10-07).
 */
function orderEarnValue(order, { amountRefunded = 0 } = {}) {
  if (!order || order.cancelled_at) return 0;
  const total = Number(order.total_price) || 0;

  // VCH voucher codes reduce total_price online but are tender. Add them back.
  let voucherTender = 0;
  const apps = order.discount_applications || [];
  const lines = order.line_items || [];
  apps.forEach((app, i) => {
    const ident = String(app.code || app.title || '');
    if (!/^VCH/i.test(ident)) return;
    for (const li of lines) for (const al of (li.discount_allocations || [])) {
      if (Number(al.discount_application_index) === i) voucherTender += Number(al.amount) || 0;
    }
  });

  // Exchange-note lines are negative custom lines: add their absolute value back.
  const exchangeTender = lines.filter(isExchangeLine)
    .reduce((s, li) => s + Math.abs((Number(li.price) || 0) * (Number(li.quantity) || 1)), 0);

  let shopifyRefunds = 0;
  for (const rf of (order.refunds || [])) {
    for (const tx of (rf.transactions || [])) {
      if (String(tx.kind) === 'refund' && String(tx.status) === 'success') shopifyRefunds += Number(tx.amount) || 0;
    }
  }
  const refunds = Math.max(shopifyRefunds, Number(amountRefunded) || 0);
  return Math.max(0, Math.floor(total + voucherTender + exchangeTender - refunds));
}

/**
 * Exchange notes ISSUED against this order — goods returned and turned into credit. Treated like a
 * refund (founder, 2026-10-10): the source order stops earning on what was exchanged, and the order
 * the note is spent on earns its full value instead. The source order carries the record in its own
 * tags: `exc-given` plus `exc-val:<rupees>` (one per note).
 */
function exchangeIssuedValue(order) {
  const tags = String((order && order.tags) || '').split(',').map(t => t.trim());
  if (!tags.some(t => t.toLowerCase() === 'exc-given')) return 0;
  return tags.filter(t => /^exc-val:/i.test(t))
    .reduce((s, t) => s + (parseFloat(t.slice(t.indexOf(':') + 1)) || 0), 0);
}

/** The order's number, from its name ("#1057" → 1057). Null if the name carries none. */
function orderNumber(order) {
  const m = String((order && order.name) || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Points an order earns under the programme's rules: orderEarnValue, less exchange notes issued
 * against it, and nothing at all for an order before the programme's first order or one the config
 * marks as replaced by a later invoice. Returns { points, excluded: reason|'' }.
 */
function earnPoints(order, cfg, { amountRefunded = 0 } = {}) {
  const e = (cfg && cfg.earning) || {};
  const num = orderNumber(order);
  if (e.min_order_number && num != null && num < e.min_order_number) return { points: 0, excluded: `before #${e.min_order_number}` };
  const sup = (e.superseded_orders || {})[String(order.name || '')];
  if (sup) return { points: 0, excluded: `replaced by ${sup}` };
  const gross = orderEarnValue(order, { amountRefunded });
  return { points: Math.max(0, Math.floor(gross - exchangeIssuedValue(order))), excluded: '' };
}

// ── Draft-order discount state ──────────────────────────────────────────────────────────────────

/** Parse custom.loyalty_applied (JSON). Null when absent or unreadable. */
function readApplied(raw) {
  if (!raw) return null;
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return v && Number(v.rate) > 0 ? v : null;
  } catch { return null; }
}

/**
 * Does the draft carry any OTHER discount? Loyalty is exclusive, so this is the gate both ways.
 * Reads the draft's custom.* metafield map. Vouchers, exchange notes, old gold and CAD advances
 * are tender and do not count.
 */
function otherDiscountOnDraft(mfMap = {}) {
  if (Number(mfMap.discount_rate) > 0) return 'a discount code is already applied';
  const code = String(mfMap.discount_code || '').trim();
  if (code) return `discount ${code} is already applied`;
  try {
    const codes = mfMap.discount_codes ? JSON.parse(mfMap.discount_codes) : [];
    if (Array.isArray(codes) && codes.length) return 'a discount code is already applied';
  } catch { /* unreadable list counts as none */ }
  try {
    const arr = mfMap.line_discounts ? JSON.parse(mfMap.line_discounts) : [];
    if (Array.isArray(arr) && arr.some(e => Array.isArray(e) && e.some(x => x && x.src !== 'loyalty' && Number(x.v) > 0))) {
      return 'a per-line discount is already applied';
    }
  } catch { /* unreadable list counts as none */ }
  return '';
}

/**
 * Add the loyalty entry to each eligible product line's per-line discount list.
 *
 * lineDiscArr is custom.line_discounts parsed (indexed by product-line position); productItems is
 * the reprice's product-line list in the same order. Eligibility was decided when loyalty was
 * applied and is stored BY VARIANT, so a reordered or re-added line keeps its discount and a line
 * the step has not yet checked gets none. Returns a NEW array; the input is not touched.
 */
function withLoyaltyEntries(lineDiscArr, productItems, applied) {
  if (!applied || !(Number(applied.rate) > 0)) return lineDiscArr;
  const eligible = new Set((applied.eligible_variants || []).map(String));
  const out = (productItems || []).map((_, i) => (Array.isArray(lineDiscArr[i]) ? [...lineDiscArr[i]] : []));
  (productItems || []).forEach((item, i) => {
    if (!item || !item.variant_id || !eligible.has(String(item.variant_id))) return;
    out[i] = out[i].filter(e => !(e && e.src === 'loyalty'));
    out[i].push({ t: 'dia', m: 'pct', v: Number(applied.rate), src: 'loyalty' });
  });
  return out;
}

module.exports = {
  GST_FACTOR,
  tierFor, sortedTiers,
  monthOf, istMonth, istDate, occasionBonus,
  lineEligibility, computeLoyalty, onlineAmount,
  isExchangeLine, orderEarnValue, exchangeIssuedValue, orderNumber, earnPoints,
  readApplied, otherDiscountOnDraft, withLoyaltyEntries,
};
