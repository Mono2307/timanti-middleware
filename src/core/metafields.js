'use strict';

/**
 * Shopify `custom.*` metafield reads and writes.
 *
 * Metafields are this system's real database: every derived number the middleware computes —
 * amount_paid, gross_value, serial_no, the installment legs — is written back onto the draft or
 * order as a `custom.*` metafield, because that is what Order Printer templates and staff can
 * see. Getting the TYPE right matters: Shopify rejects a value whose type does not match the
 * existing definition, and a rejected write fails silently from the caller's point of view.
 *
 * server.js previously carried two near-identical writers, one for draft_orders and one for
 * orders, differing only in the resource segment of the URL. They are one function here.
 */

const { config }   = require('./config');
const { getShopifyToken, getJson, putJson, postJson } = require('./shopify');
const { log } = require('./logger');

/**
 * The Shopify metafield type for a `custom.*` key.
 *
 * Two deliberate oddities:
 *  - `gold_rate` and `making` are TEXT, not numbers, so they can hold a positional
 *    comma-separated list ("9713,10200") for a multi-product reprice. Readers parseFloat each
 *    position, so the text type costs nothing and buys multi-line support.
 *  - installment_N_value / _date are matched by pattern; _mode and _type fall through to text.
 *  - refund_N_value / _date likewise; _mode and _ref (the gateway UTR) fall through to text.
 */
function getMetafieldType(key) {
  if (key === 'gold_rate' || key === 'making') return 'single_line_text_field';
  if (/^installment_[1-9]\d*_value$/.test(key)) return 'number_decimal';
  if (/^installment_[1-9]\d*_date$/.test(key))  return 'date';
  if (/^refund_[1-9]\d*_value$/.test(key))      return 'number_decimal';
  if (/^refund_[1-9]\d*_date$/.test(key))       return 'date';
  if (key === 'amount_paid' || key === 'amount_paid_final' || key === 'amount_pending' ||
      key === 'exchange_note_value' || key === 'voucher_value' || key === 'amount_to_be_collected' ||
      key === 'old_gold_value' || key === 'old_gold_weight' || key === 'old_gold_purity' ||
      key === 'gross_value' || key === 'discount_applied' || key === 'discount_rate' ||
      key === 'advance' || key === 'amount_refunded') return 'number_decimal';
  if (key === 'is_finalized') return 'boolean';
  if (key === 'gold_rate_date') return 'date_time';
  if (key === 'advance_date') return 'date';
  if (key === 'serial_no') return 'number_integer';
  return 'single_line_text_field';
}

/**
 * Write `custom.*` metafields onto a draft order or an order.
 *
 * Existing keys are updated BY ID rather than re-created: Shopify 422s on a duplicate
 * namespace+key, so a blind create fails for every field after the first write.
 *
 * Blank values are skipped, not written as empty. Clearing a field therefore needs an explicit
 * delete — that is intentional, because a truncated webhook payload must never be able to wipe
 * a recorded payment.
 *
 * Never throws: metafield writes are side effects of webhook handling, and a failed write must
 * not abort the pipeline step that triggered it. Failures are logged.
 *
 * @param {'draft_orders'|'orders'} resource
 */
async function updateMetafields(resource, id, fields, tokenArg) {
  try {
    const token = tokenArg || await getShopifyToken();

    const existing = await getJson(`${resource}/${id}/metafields.json`, { token });
    const existingById = {};
    for (const mf of (existing.metafields || [])) {
      if (mf.namespace === 'custom') existingById[mf.key] = mf.id;
    }

    for (const [key, value] of Object.entries(fields)) {
      if (value === null || value === undefined || String(value).trim() === '') continue;
      const existingId = existingById[key];
      const type = getMetafieldType(key);
      if (existingId) {
        await putJson(`metafields/${existingId}.json`,
          { metafield: { id: existingId, value: String(value), type } }, { token });
      } else {
        await postJson(`${resource}/${id}/metafields.json`,
          { metafield: { namespace: 'custom', key, value: String(value), type } }, { token });
      }
    }
    log.info('metafields', `updated ${resource.replace('_orders', ' order').replace('orders', 'order')} ${id}`, Object.keys(fields));
  } catch (err) {
    log.error('metafields', `update failed for ${resource} ${id}:`, err.response?.data || err.message);
  }
}

const updateDraftOrderMetafields = (draftOrderId, fields, token) =>
  updateMetafields('draft_orders', draftOrderId, fields, token);

/**
 * Order-level writer. Used to FREEZE reproducible values onto the order
 * (gross_value / discount_applied / voucher_value) that the tax invoice and reconciliation read
 * after the draft is gone.
 */
const updateOrderMetafields = (orderId, fields, token) =>
  updateMetafields('orders', orderId, fields, token);

module.exports = {
  getMetafieldType,
  updateMetafields,
  updateDraftOrderMetafields,
  updateOrderMetafields,
};
