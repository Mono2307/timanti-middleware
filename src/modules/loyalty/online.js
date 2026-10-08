'use strict';

/**
 * Online loyalty: the storefront cart → a one-time Shopify discount code → GoKwik.
 *
 * GoKwik checkout does not work out discounts and does not let the customer enter codes; it carries
 * whatever codes are already on the Shopify cart. So the cart's "My benefits" block (theme app
 * extension) asks this service, through the Shopify app proxy, for:
 *   GET  /apps/loyalty/benefits  → the logged-in customer's tier, today's rate, and their open
 *                                  vouchers (codes usable online)
 *   POST /apps/loyalty/apply     → a single-use code worth exactly the diamond-only discount on the
 *                                  cart's eligible pieces
 *
 * The code is a fixed amount, limited to the eligible variants, single use, expiring in two hours,
 * PRODUCT class combining with ORDER-class discounts only — so a voucher code (order class) can sit
 * beside it on the cart and a promo code cannot. It is NOT locked to the customer: GoKwik logs the
 * buyer in by phone and may attach the order to a different Shopify customer, which would make a
 * customer-locked code fail at checkout. The order webhook credits whoever asked for it instead
 * (earn.js).
 *
 * The app proxy signs every request with the app's client secret; nothing here trusts a customer id
 * that did not come through that signature.
 */

const crypto = require('crypto');
const { graphql } = require('../../core/shopify');
const { supabase } = require('../../core/supabase');
const { config } = require('../../core/config');
const { log } = require('../../core/logger');
const creditInstruments = require('../adjustments/credit_instruments');
const E = require('./engine');
const ledger = require('./ledger');
const { loadConfig } = require('./config');
const { readCustomer } = require('./customer');

const MAX_CODES_PER_HOUR = 10;

/**
 * Verify a Shopify app-proxy signature. Shopify sorts the query parameters (minus `signature`),
 * joins each as key=value (array values comma-joined) with NO separator, and HMAC-SHA256s that with
 * the app's client secret. Any one of the configured secrets may match.
 */
function verifyProxySignature(query, secrets) {
  const q = { ...(query || {}) };
  const given = String(q.signature || '');
  delete q.signature;
  if (!given || !secrets || !secrets.length) return false;
  const message = Object.keys(q).sort()
    .map(k => `${k}=${Array.isArray(q[k]) ? q[k].join(',') : q[k]}`).join('');
  return secrets.some(secret => {
    const expected = crypto.createHmac('sha256', secret).update(message).digest('hex');
    return expected.length === given.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
  });
}

/** Facts for cart lines: catalogue diamond value, SKU, type, tags, collections. One GraphQL read. */
async function cartLineFacts(lines) {
  const ids = [...new Set(lines.map(l => String(l.variant_id)).filter(Boolean))];
  if (!ids.length) return {};
  const data = await graphql(`query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant {
      id sku price
      diamond: metafield(namespace: "custom", key: "price_breakup_diamond") { value }
      jewel:   metafield(namespace: "custom", key: "jewel_code") { value }
      product { title productType tags collections(first: 25) { nodes { handle } } }
    } } }`, { ids: ids.map(id => `gid://shopify/ProductVariant/${id}`) });
  const out = {};
  for (const n of (data.nodes || [])) {
    if (!n || !n.id) continue;
    out[n.id.split('/').pop()] = {
      sku: n.sku || '', title: (n.product && n.product.title) || '',
      productType: (n.product && n.product.productType) || '', tags: (n.product && n.product.tags) || [],
      collections: ((n.product && n.product.collections && n.product.collections.nodes) || []).map(c => c.handle),
      diamondUnit: n.diamond ? Number(n.diamond.value) || 0 : 0, jewelCode: n.jewel ? n.jewel.value : '',
    };
  }
  return out;
}

/** The customer's loyalty position, as the cart block shows it. */
async function benefitsFor(customerId) {
  const cfg = await loadConfig();
  const customer = await readCustomer(customerId);
  if (!customer) return { loggedIn: true, found: false };
  const points = await ledger.customerPoints(supabase, customerId).catch(() => Number(customer.points) || 0);
  const info = E.tierFor(points, cfg);
  const occasion = E.occasionBonus(customer, new Date(), cfg);
  let vouchers = [];
  try {
    // Only vouchers carry a Shopify code; exchange notes are in-store only.
    vouchers = (await creditInstruments.listOpenForCustomer(supabase, { customerId, instrumentType: 'voucher' }))
      .map(v => ({ code: v.serial_code, value: Number(v.value) || 0, expires_at: v.expires_at || null }));
  } catch (e) { log.warn('loyalty', `voucher list for ${customerId} failed: ${e.message}`); }
  return {
    loggedIn: true, found: true,
    firstName: customer.firstName,
    enabled: cfg.enabled,
    points: info.points,
    tier: info.tier ? { key: info.tier.key, name: info.tier.name, pct: info.tier.pct } : null,
    next: info.next ? { name: info.next.name, pct: info.next.pct, gap: info.gapToNext } : null,
    occasion: occasion.occasions,
    rate: info.tier ? info.tier.pct + occasion.pct : 0,
    vouchers,
  };
}

/** Delete a discount by node id. Best effort — the sweep retries expired ones. */
async function deleteDiscountNode(nodeId) {
  try {
    const r = await graphql(`mutation($id: ID!) { discountCodeDelete(id: $id) { userErrors { message } } }`, { id: nodeId });
    const errs = (r && r.discountCodeDelete && r.discountCodeDelete.userErrors) || [];
    if (errs.length) throw new Error(errs.map(e => e.message).join('; '));
    return true;
  } catch (e) {
    log.warn('loyalty', `discount ${nodeId} delete failed: ${e.message}`);
    return false;
  }
}

function randomCode(prefix) {
  return `${prefix}${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

/**
 * Create the one-time code for a cart. lines: [{ variant_id, quantity }] as the cart block sends
 * them (from /cart.js). Returns { ok, code?, amount?, reason? }.
 */
async function createCartCode(customerId, lines) {
  const cfg = await loadConfig();
  if (!cfg.enabled) return { ok: false, reason: 'The loyalty programme is not running right now.' };
  const clean = (Array.isArray(lines) ? lines : [])
    .map(l => ({ variant_id: String(l.variant_id || ''), quantity: Math.max(1, parseInt(l.quantity, 10) || 1) }))
    .filter(l => /^\d+$/.test(l.variant_id));
  if (!clean.length) return { ok: false, reason: 'Your cart is empty.' };

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  if (await ledger.codesIssuedSince(supabase, customerId, since) >= MAX_CODES_PER_HOUR) {
    return { ok: false, reason: 'Too many attempts. Please try again in a while.' };
  }

  const customer = await readCustomer(customerId);
  if (!customer) return { ok: false, reason: 'We could not find your account.' };
  const points = await ledger.customerPoints(supabase, customerId);
  const facts = await cartLineFacts(clean);
  const described = clean.map(l => {
    const f = facts[l.variant_id] || {};
    return { ...l, sku: f.sku, title: f.title, productType: f.productType, tags: f.tags, collections: f.collections,
      jewelCode: f.jewelCode, diamond: (f.diamondUnit || 0) * l.quantity };
  });
  const r = E.computeLoyalty({ points, birthday: customer.birthday, anniversary: customer.anniversary, lines: described, cfg });
  if (!r.ok) {
    const reason = r.reason === 'below the first tier'
      ? `Spend ₹${Math.round(r.gapToNext).toLocaleString('en-IN')} more to unlock your first loyalty benefit.`
      : r.reason === 'no eligible pieces' ? 'None of the pieces in your cart is eligible for the loyalty benefit.'
        : 'The loyalty benefit is not available right now.';
    return { ok: false, reason };
  }

  const amountIncl = E.onlineAmount(r.total);
  const eligibleVariants = described.filter((_, i) => r.perLine[i].eligible).map(l => l.variant_id);
  const signature = described.map(l => `${l.variant_id}x${l.quantity}`).sort().join(',');

  // Same cart, same customer, code still live → hand back the same code instead of minting another.
  const live = await ledger.pendingCodesFor(supabase, customerId);
  const reuse = live.find(p => p.lines && p.lines.signature === signature && Math.abs(Number(p.discount_incl_tax) - amountIncl) < 0.01);
  if (reuse) return { ok: true, code: reuse.code, amount: amountIncl, rate: r.rate, tier: r.tier.name, reused: true };

  const prefix = cfg.online.code_prefix;
  const code = randomCode(prefix);
  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + cfg.online.code_ttl_minutes * 60 * 1000);
  const res = await graphql(`mutation($d: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $d) {
        codeDiscountNode { id } userErrors { field message } } }`, {
    d: {
      title: `Loyalty ${r.tier.name} ${r.rate}% — customer ${customerId}`,
      code,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      customerSelection: { all: true },
      customerGets: {
        value: { discountAmount: { amount: amountIncl.toFixed(2), appliesOnEachItem: false } },
        items: { products: { productVariantsToAdd: eligibleVariants.map(v => `gid://shopify/ProductVariant/${v}`) } },
      },
      usageLimit: 1,
      appliesOncePerCustomer: false,
      combinesWith: { orderDiscounts: true, productDiscounts: false, shippingDiscounts: true },
    },
  });
  const out = res && res.discountCodeBasicCreate;
  const errs = (out && out.userErrors) || [];
  if (errs.length || !(out && out.codeDiscountNode)) {
    log.error('loyalty', `code create failed for ${customerId}: ${JSON.stringify(errs)}`);
    return { ok: false, reason: 'We could not apply your benefit just now. Please try again.' };
  }
  await ledger.insertRedemption(supabase, {
    code, discount_node_id: out.codeDiscountNode.id, channel: 'online', status: 'pending',
    customer_id: String(customerId), tier: r.tier.key, rate: r.rate,
    occasion: r.occasion.occasions.join('+') || null,
    diamond_base: r.perLine.filter(l => l.eligible).reduce((s, l) => s + l.diamond, 0),
    discount_pre_tax: r.total, discount_incl_tax: amountIncl,
    lines: { signature, perLine: r.perLine.map((l, i) => ({ variant_id: described[i].variant_id, diamond: l.diamond, discount: l.discount, eligible: l.eligible })) },
    expires_at: endsAt.toISOString(),
  });
  log.info('loyalty', `code ${code} for customer ${customerId}: ${r.tier.key} ${r.rate}% = Rs${amountIncl} incl. GST on ${eligibleVariants.length} variant(s)`);
  return { ok: true, code, amount: amountIncl, rate: r.rate, tier: r.tier.name, expires_at: endsAt.toISOString() };
}

module.exports = { verifyProxySignature, benefitsFor, createCartCode, deleteDiscountNode, cartLineFacts };
