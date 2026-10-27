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
 * Like the loyalty code it is a PRODUCT-class discount that combines with ORDER discounts only. Promo and
 * loyalty STACK (founder, 2026-10-26), but Shopify keeps one product discount per line, so for a
 * logged-in member the code is worth BOTH: promo % of the diamond + the tier's diamond and capped making
 * discount, each worked out on the pre-tax value, summed, then grossed up once. Asking for loyalty with
 * a live promo code on the cart re-mints it the same way (online.js). The code it replaces is retired,
 * so the drawer swapping one code for the other always leaves the combined one.
 */

const crypto = require('crypto');
const { graphql } = require('../../core/shopify');
const { supabase } = require('../../core/supabase');
const { log } = require('../../core/logger');
const E = require('./engine');
const ledger = require('./ledger');
const { loadConfig } = require('./config');
const { cartLineFacts, deleteDiscountNode, loyaltyForCart, supersedeCodes } = require('./online');

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
      jewelCode: f.jewelCode, diamond: (f.diamondUnit || 0) * l.quantity, making: (f.makingUnit || 0) * l.quantity };
  });
  const r = computePromo({ promo, lines: described, cfg });
  if (!r.ok) return { ok: false, reason: `${key} applies to the diamond value of a piece, and none of the pieces in your cart is eligible.` };
  const signature = described.map(l => `${l.variant_id}x${l.quantity}`).sort().join(',');

  // This customer's live codes for the same cart. Never for guests: their rows share one bucket, so a
  // live code could belong to somebody else's identical cart.
  const sameCart = isGuest ? [] : (await ledger.pendingCodesFor(supabase, cid)).filter(p => p.lines && p.lines.signature === signature);

  // A member's loyalty benefit rides on the same code. A loyalty failure never blocks the promo.
  let loy = null;
  if (!isGuest && cfg.enabled) {
    try {
      const got = await loyaltyForCart(cid, described, cfg, { excludeCodes: sameCart.map(p => p.code) });
      if (got.r && got.r.ok) loy = got.r;
    } catch (e) { log.warn('loyalty', `promo ${key}: loyalty for ${cid} not added: ${e.message}`); }
  }

  // Shopify takes a code off the GST-INCLUSIVE price, so the pre-tax cut is grossed up by 1.03: 10% of
  // a Rs40,000 diamond is Rs4,000 off before GST = Rs4,120 off the final price. Without it the code
  // gave 9.7% (founder, 2026-10-24: exact % before GST, the same as loyalty and the in-store discounts).
  const totalPreTax = r2(r.total + (loy ? loy.total : 0));
  const amountIncl = E.onlineAmount(totalPreTax);
  const eligibleVariants = described.filter((_, i) => r.perLine[i].eligible || (loy && loy.perLine[i].eligible)).map(l => l.variant_id);
  const result = (code, extra) => ({
    ok: true, code, label: key, pct: promo.pct, amount: amountIncl, promo_amount: E.onlineAmount(r.total),
    loyalty: loy ? { tier: loy.tier.name, rate: loy.rate, making_pct: loy.makingPct, amount: E.onlineAmount(loy.total) } : null,
    ...(loy ? { rate: loy.rate, tier: loy.tier.name } : {}),
    ...extra,
  });

  // Same cart, code still live, same amount -> hand back the same code.
  const reuse = sameCart.find(p => p.promo_code === key && !!p.tier === !!loy && Math.abs(Number(p.discount_incl_tax) - amountIncl) < 0.01);
  if (reuse) return result(reuse.code, { reused: true });

  const code = `${CODE_PREFIX}${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + cfg.online.code_ttl_minutes * 60 * 1000);
  const res = await graphql(`mutation($d: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $d) {
        codeDiscountNode { id } userErrors { field message } } }`, {
    d: {
      title: `Promo ${key} ${promo.pct}% on diamond${loy ? ` + Loyalty ${loy.tier.name} ${loy.rate}% dia + ${loy.makingPct}% making` : ''}${isGuest ? '' : ' - customer ' + cid}`,
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
    customer_id: cid, promo_code: key,
    // With loyalty on the code: tier/rate/occasion as a loyalty code records them (earn.js credits the
    // member and the bonus counts as used); the promo's own % and amount sit in lines.promo.
    ...(loy ? { tier: loy.tier.key, rate: loy.rate, occasion: loy.occasion.occasions.join('+') || null } : { rate: promo.pct }),
    diamond_base: r2(r.perLine.reduce((s, l, i) => s + (l.eligible || (loy && loy.perLine[i].eligible) ? l.diamond : 0), 0)),
    discount_pre_tax: totalPreTax, discount_incl_tax: amountIncl,
    lines: {
      signature,
      promo: { code: key, pct: promo.pct, pre_tax: r.total },
      loyalty: loy ? { tier: loy.tier.key, rate: loy.rate, making_pct: loy.makingPct, making_cap: loy.makingCap, pre_tax: loy.total } : null,
      perLine: r.perLine.map((l, i) => ({
        variant_id: described[i].variant_id, diamond: l.diamond, discount: l.discount, eligible: l.eligible,
        ...(loy ? { loyalty_discount: loy.perLine[i].discount, making: loy.perLine[i].making, making_discount: loy.perLine[i].makingDiscount } : {}),
      })),
    },
    expires_at: endsAt.toISOString(),
    });
  } catch (e) {
    // Never leave a live, untracked discount behind: if the redemption could not be recorded
    // (e.g. the promo_code column is missing), take the Shopify code back out and say so.
    await deleteDiscountNode(out.codeDiscountNode.id);
    log.error('loyalty', `promo ${key}: could not record redemption for ${code}, discount removed: ${e.message}`);
    return { ok: false, reason: 'We could not apply this code just now. Please try again.' };
  }
  // The code(s) this one replaces on the same cart (a loyalty-only code, an older promo code) go.
  if (sameCart.length) await supersedeCodes(sameCart);
  log.info('loyalty', `promo ${key}${loy ? ` + loyalty ${loy.tier.key} ${loy.rate}%` : ''}: code ${code} for ${isGuest ? 'a guest' : 'customer ' + cid} = Rs${amountIncl} incl. GST on ${eligibleVariants.length} variant(s)`);
  return result(code, { expires_at: endsAt.toISOString() });
}

module.exports = { CODE_PREFIX, computePromo, createPromoCode };
