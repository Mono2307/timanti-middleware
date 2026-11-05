'use strict';
// A piece on an active buy plan has just been sold to someone else.
//
// There is no stock hold (Shopify is not the inventory system), so an equal-plan piece stays on sale
// and another customer can buy it. When an order comes in with a variant that an active plan is
// for, the store is told at once so the piece can be reordered (founder, 2026-11-05).
//
// The plan's own order is not an alert: a completed plan draft becomes an order with the same lines,
// for the same customer, carrying the buy-plan tag.

const { sendEmail } = require('../../../integrations/email');
const { config } = require('../../../core/config');
const { log } = require('../../../core/logger');
const store = require('./store');
const { adminDraftUrl } = require('./draft');

const STORE = () => config.email.store || 'hsrstore@timanti.in';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Pure: which active plans does this order take a piece from?
function plansHit(order, plans) {
  const tags = String(order.tags || '').split(',').map(t => t.trim().toLowerCase());
  if (tags.includes('buy-plan') || tags.includes('ot:buy-plan')) return [];
  const buyer = String(order.customer?.id || '');
  const sold = new Map();
  for (const l of order.line_items || []) if (l.variant_id) sold.set(String(l.variant_id), l.title || l.name || '');
  const hits = [];
  for (const plan of plans) {
    if (buyer && buyer === String(plan.customer_id || '')) continue;
    const pieces = ((plan.snapshot || {}).line_items || [])
      .filter(l => l.variant_id && sold.has(String(l.variant_id)))
      .map(l => l.title || sold.get(String(l.variant_id)));
    if (pieces.length) hits.push({ plan, pieces });
  }
  return hits;
}

async function alertIfPlanPieceSold(order) {
  if (!order?.id || !(order.line_items || []).some(l => l.variant_id)) return [];
  const hits = plansHit(order, await store.listActivePlans());
  for (const { plan, pieces } of hits) {
    log.warn('buy-plan', `${order.name}: sold ${pieces.join(', ')}, which is on buy plan ${plan.draft_name}`);
    await sendEmail({
      to: STORE(), internal: true,
      subject: `Reorder: ${pieces.join(', ')} sold, on buy plan ${plan.draft_name}`,
      html: `<p>Order <strong>${esc(order.name)}</strong> has just sold <strong>${esc(pieces.join(', '))}</strong>.</p>
<p>This piece is on an active buy plan: <a href="${esc(adminDraftUrl(plan.draft_order_id))}">${esc(plan.draft_name)}</a>,
${esc(plan.customer_name || '')} (${esc(plan.customer_phone || '')}). Please reorder or replace it now so the customer's piece is ready.
If a different piece will be given, use Buy plan → Change product on the draft.</p>`,
    });
  }
  return hits;
}

module.exports = { alertIfPlanPieceSold, plansHit };
