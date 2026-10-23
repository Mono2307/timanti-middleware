'use strict';

/**
 * Promo codes on the DIAMOND value only, e.g. ISB10 = 10% off custom.price_breakup_diamond.
 *
 * Shopify's own discounts cannot read a metafield, so (exactly like the loyalty benefit in online.js)
 * the cart drawer asks this service for a code and this service mints a one-time Shopify code worth
 * the exact rupee amount:
 *
 *   customer types ISB10 -> POST /apps/loyalty/promo { code, lines }
 *     -> 10% x diamond value of each eligible line (pre-tax), grossed up for GST
 *     -> one-time fixed-amount Shopify code PRM-XXXXXXXXXX, limited to the eligible variants,
 *        usage limit 1, expires in online.code_ttl_minutes
 *     -> the drawer applies that code to the cart; GoKwik carries it to checkout like any code.
 *
 * The code list lives in the loyalty config metafield (config.promos), so a percentage, an expiry date
 * or a new code is a metafield edit, not a deploy. The earn webhook settles the code when the order
 * arrives (earn.js settlePromoCode).
 *
 * Like the loyalty code it is a PRODUCT-class discount that combines with ORDER discounts only, so a
 * promo code and a loyalty code cannot sit on the same cart. The drawer swaps one for the other.
 */

const crypto = require('crypto');
const { graphql } = require('../../core/shopify');
const { supabase } = require('../../core/supabase');
const { log } = require('../../core/logger');
const E = require('./engine');
const ledger = require('./ledger');
const { loadConfig } = require('./config');
const { cartLineFacts, deleteDiscountNode } = require('./online');

const CODE_PREFIX = 'PRM-';
const MAX_CODES_PER_HOUR = 10;          // per logged-in customer (shared with loyalty codes)
const MAX_GUEST_CODES_PER_HOUR = 60;    // all guests together
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Pure maths. lines: [{ ...lineEligibility fields, diamond (pre-tax Rs, already x quantity) }].
 * Same eligibility rules as loyalty (SCOIN/GCOIN, no-loyalty tag, no diamond value ... are out).
 * Returns { ok, perLine: [{ idx, eligible, reason, diamond, discount }], total } with PRE-TAX rupees.
 */
function computePromo({ promo, lines = [], cfg }) {
  const perLine = lines.map((line, idx) => {
    const e = E.lineEligibility(line, cfg);
    const diamond = Math.max(0, Number(line.diamond) || 0);
    return { idx, eligible: e.eligible, reason: e.reason, diamond: r2(diamond), discount: e.eligible ? r2(diamond * promo.pct / 100) : 0 };
  });
  const total = r2(perLine.reduce((s, l) => s + l.discount, 0));
  return { ok: perLine.some(l => l.eligible) && total > 0, perLine, total };
}

/**
 * The cart drawer calls this with whatever the customer typed.
 * Returns { ok:false, notPromo:true } for any code that is not a configured promo, so the drawer
 * can pass it on to Shopify as an ordinary code (vouchers, FNF5 ...).
 */
async function createPromoCode(customerId, rawCode, lines) {
  const cfg = await loadConfig();
  const key = String(rawCode || '').trim().toUpperCase();
  const promo = (cfg.promos || {})[key];
  if (!promo) return { ok: false, notPromo: true };

  if (!promo.active) return { ok: false, reason: 'This code is not valid.' };
  const now = new Date();
  if (promo.starts_at && now < new Date(promo.starts_at)) return { ok: false, reason: 'This code is not active yet.' };
  if (promo.ends_at && now > new Date(promo.ends_at)) return { ok: false, reason: 'This code has expired.' };
  if (promo.require_login && !customerId) return { ok: false, reason: 'Please log in to use this code.' };

  const clean = (Array.isArray(lines) ? lines : [])
    .map(l => ({ variant_id: String(l.variant_id || ''), quantity: Math.max(1, parseInt(l.quantity, 10) || 1) }))
    .filter(l => /^\d+$/.test(l.variant_id));
  if (!clean.length) return { ok: false, reason: 'Your cart is empty.' };

  const isGuest = !customerId;
  const cid = isGuest ? 'guest' : String(customerId);
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const cap = isGuest ? MAX_GUEST_CODES_PER_HOUR : MAX_CODES_PER_HOUR;
  if (await ledger.codesIssuedSince(supabase, cid, since) >= cap) {
    return { ok: false, reason: 'Too many attempts. Please try again in a while.' };
  }

  const facts = await cartLineFacts(clean);
  const described = clean.map(l => {
    const f = facts[l.variant_id] || {};
    return { ...l, sku: f.sku, title: f.title, productType: f.productType, tags: f.tags, collections: f.collections,
      jewelCode: f.jewelCode, diamond: (f.diamondUnit || 0) * l.quantity };
  });
  const r = computePromo({ promo, lines: described, cfg });
  if (!r.ok) return { ok: false, reason: `${key} applies to the diamond value of a piece, and none of the pieces in your cart is eligible.` };

  const amountIncl = E.onlineAmount(r.total);
  const eligibleVariants = described.filter((_, i) => r.perLine[i].eligible).map(l => l.variant_id);
  const signature = described.map(l => `${l.variant_id}x${l.quantity}`).sort().join(',');

  // Same cart, same customer, code still live -> hand back the same code. Not for guests: their
  // rows share one bucket, so a live code could belong to somebody else's identical cart.
  if (!isGuest) {
    const live = await ledger.pendingCodesFor(supabase, cid);
    const reuse = live.find(p => p.promo_code === key && p.lines && p.lines.signature === signature &&
      Math.abs(Number(p.discount_incl_tax) - amountIncl) < 0.01);
    if (reuse) return { ok: true, code: reuse.code, label: key, pct: promo.pct, amount: amountIncl, reused: true };
  }

  const code = `${CODE_PREFIX}${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + cfg.online.code_ttl_minutes * 60 * 1000);
  const res = await graphql(`mutation($d: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $d) {
        codeDiscountNode { id } userErrors { field message } } }`, {
    d: {
      title: `Promo ${key} ${promo.pct}% on diamond${isGuest ? '' : ' - customer ' + cid}`,
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
    log.error('loyalty', `promo ${key} code create failed for ${cid}: ${JSON.stringify(errs)}`);
    return { ok: false, reason: 'We could not apply this code just now. Please try again.' };
  }
  try {
    await ledger.insertRedemption(supabase, {
    code, discount_node_id: out.codeDiscountNode.id, channel: 'online', status: 'pending',
    customer_id: cid, promo_code: key, rate: promo.pct,
    diamond_base: r.perLine.filter(l => l.eligible).reduce((s, l) => s + l.diamond, 0),
    discount_pre_tax: r.total, discount_incl_tax: amountIncl,
    lines: { signature, perLine: r.perLine.map((l, i) => ({ variant_id: described[i].variant_id, diamond: l.diamond, discount: l.discount, eligible: l.eligible })) },
    expires_at: endsAt.toISOString(),
    });
  } catch (e) {
    // Never leave a live, untracked discount behind: if the redemption could not be recorded
    // (e.g. the promo_code column is missing), take the Shopify code back out and say so.
    await deleteDiscountNode(out.codeDiscountNode.id);
    log.error('loyalty', `promo ${key}: could not record redemption for ${code}, discount removed: ${e.message}`);
    return { ok: false, reason: 'We could not apply this code just now. Please try again.' };
  }
  log.info('loyalty', `promo ${key}: code ${code} for ${isGuest ? 'a guest' : 'customer ' + cid} = Rs${amountIncl} incl. GST on ${eligibleVariants.length} variant(s)`);
  return { ok: true, code, label: key, pct: promo.pct, amount: amountIncl, expires_at: endsAt.toISOString() };
}

module.exports = { CODE_PREFIX, computePromo, createPromoCode };
