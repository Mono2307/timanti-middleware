'use strict';

/**
 * Earning: orders/create and orders/update → the loyalty ledger.
 *
 * Called fire-and-forget from the order webhook (/api/serial/order-serial). Points are counted when
 * an ORDER exists — online checkout, or a draft converting — never from a draft's installment
 * entries (founder's rule, 2026-10-07). The order's value is upserted, so the several deliveries
 * Shopify sends for one order, and any later refund, only ever leave the current figure.
 *
 * Online loyalty codes are also settled here: the pending redemption recorded when the storefront
 * asked for the code is marked used, and the order is credited to the customer who ASKED for the
 * code. GoKwik logs buyers in by phone, which can attach the order to a different Shopify customer;
 * that mismatch is recorded on the redemption for staff to review rather than guessed at.
 */

const { graphql } = require('../../core/shopify');
const { supabase } = require('../../core/supabase');
const { config } = require('../../core/config');
const { log } = require('../../core/logger');
const { updateOrderMetafields } = require('../../core/metafields');
const { isCadAdvanceOnly } = require('../adjustments/cad_advance');
const E = require('./engine');
const ledger = require('./ledger');
const { refreshCustomer } = require('./customer');
const { deleteDiscountNode } = require('./online');

// Shopify sends several deliveries per order within seconds. Coalesce them: keep the newest
// payload per order and process it once the burst has gone quiet.
const QUIET_MS = 15 * 1000;
const pending = new Map();

function onOrderWebhook(order) {
  if (!config.loyalty.enabled || !order || !order.id) return;
  const key = String(order.id);
  const prev = pending.get(key);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    pending.delete(key);
    processOrder(order).catch(e => log.error('loyalty', `earning failed for order ${order.name || order.id}: ${e.message}`));
  }, QUIET_MS);
  pending.set(key, { timer });
}

/** In-store refunds live only in custom.amount_refunded, which is not on the webhook payload. */
async function amountRefundedFor(orderId) {
  try {
    const data = await graphql(`query($id: ID!) { order(id: $id) {
        refunded: metafield(namespace: "custom", key: "amount_refunded") { value } } }`,
      { id: `gid://shopify/Order/${orderId}` });
    return Number(data && data.order && data.order.refunded && data.order.refunded.value) || 0;
  } catch (e) {
    log.warn('loyalty', `amount_refunded read failed for order ${orderId}: ${e.message}`);
    return 0;
  }
}

/** Settle a LOY- code on this order. Returns the customer id the order should be credited to. */
async function settleOnlineCode(order, cfg) {
  const prefix = (cfg.online && cfg.online.code_prefix) || 'LOY-';
  const codeEntry = (order.discount_codes || []).find(c => String(c.code || '').toUpperCase().startsWith(prefix.toUpperCase()));
  if (!codeEntry) return null;
  const red = await ledger.getRedemptionByCode(supabase, codeEntry.code);
  if (!red) {
    log.warn('loyalty', `order ${order.name}: code ${codeEntry.code} has no redemption record`);
    return null;
  }
  if (red.status === 'used') return red.customer_id;

  const orderCustomer = order.customer && order.customer.id ? String(order.customer.id) : null;
  const mismatch = !!(orderCustomer && orderCustomer !== String(red.customer_id));
  const appliedIncl = Number(codeEntry.amount) || 0;
  await ledger.updateRedemption(supabase, red.id, {
    status: 'used', used_at: new Date().toISOString(),
    order_id: String(order.id), order_name: order.name || null,
    order_customer_id: orderCustomer, customer_mismatch: mismatch,
    discount_incl_tax: appliedIncl || red.discount_incl_tax,
  });
  if (Math.abs(appliedIncl - Number(red.discount_incl_tax || 0)) > 1) {
    log.warn('loyalty', `order ${order.name}: code ${codeEntry.code} applied Rs${appliedIncl}, expected Rs${red.discount_incl_tax} — check`);
  }
  if (mismatch) {
    log.warn('loyalty', `order ${order.name}: loyalty code requested by customer ${red.customer_id} but the order is on ${orderCustomer} (GoKwik phone login?) — flagged for review`);
  }
  // Freeze who benefited, for staff and the invoice. The discount stays a pre-tax diamond discount.
  await updateOrderMetafields(String(order.id), {
    loyalty_customer_id: String(red.customer_id),
    loyalty_tier: red.tier || '',
    loyalty_rate: String(red.rate || ''),
  });
  if (red.discount_node_id) await deleteDiscountNode(red.discount_node_id);
  return String(red.customer_id);
}

async function processOrder(order) {
  const { loadConfig } = require('./config');
  const cfg = await loadConfig();
  const loyaltyCustomer = await settleOnlineCode(order, cfg).catch(e => {
    log.error('loyalty', `order ${order.name}: code settlement failed: ${e.message}`);
    return null;
  });
  const customerId = loyaltyCustomer || (order.customer && order.customer.id ? String(order.customer.id) : null);
  if (!customerId) return;

  // A CAD-advance-only order is a receipt for money taken, not a sale; the sale that absorbs the
  // advance earns the points. Counting both would double them.
  const points = isCadAdvanceOnly(order) ? 0 : E.earnPoints(order, cfg, { amountRefunded: await amountRefundedFor(order.id) }).points;
  const channel = order.source_name === 'shopify_draft_order' ? 'store' : 'online';
  const { changed, previousCustomerId } = await ledger.upsertOrderEntry(supabase, {
    customerId, orderId: order.id, orderName: order.name, points, kind: 'earn', channel,
  });
  if (!changed) return;
  log.info('loyalty', `order ${order.name}: ${points} points → customer ${customerId}`);
  await refreshCustomer(customerId, { notify: true });
  if (previousCustomerId && String(previousCustomerId) !== String(customerId)) {
    await refreshCustomer(previousCustomerId, { notify: false });
  }
}

module.exports = { onOrderWebhook, processOrder, settleOnlineCode };
