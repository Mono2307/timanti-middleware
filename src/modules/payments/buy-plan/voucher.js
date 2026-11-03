'use strict';

// Buy plan — the voucher a plan pays out (founder, 2026-10-30):
//   - a plan closed for non-payment: everything the customer paid;
//   - a product change to a cheaper piece the customer has already paid more than: the difference.
// Valid one year, for ONE purchase worth at least its value (no change given), bound to the customer.
//
// Built exactly like the vouchers the store issues from the Exchange sheet (services/exchange-cn,
// createVoucher_): a VCH serial minted in the serial ledger, a customer-bound single-use Shopify
// price rule + discount code named after it, and the credit-instrument ledger row that lets staff
// apply it to a draft. The one difference is the minimum purchase, which Shopify enforces online.

const { config } = require('../../../core/config');
const { supabase } = require('../../../core/supabase');
const { getShopifyToken, postJson } = require('../../../core/shopify');
const { updateDraftOrderMetafields } = require('../../../core/metafields');
const { log } = require('../../../core/logger');
const serialization = require('../../serialization');
const creditInstruments = require('../../adjustments/credit_instruments');
const { addMonths } = require('../../adjustments/cad_advance');

const DEFAULT_STORE_CODE = 'KA-HSR';   // the Exchange sheet's STORE_CODE fallback

const serialDeps = () => ({ supabase, getShopifyToken, shopifyStoreUrl: config.shopify.storeUrl, updateDraftOrderMetafields });

// Returns { code, value, validUntil (YYYY-MM-DD) }. Throws if any Shopify step fails; the serial, once
// minted, is in the error message so staff can finish by hand.
async function issuePlanVoucher({ plan, d, value, today, why }) {
  const amount = Math.round(Number(value) || 0);
  if (!(amount > 0)) throw new Error('nothing to put on a voucher');
  if (!plan.customer_id) throw new Error('the plan has no customer');
  const storeCode = String((d && d.mf && d.mf.state_code) || DEFAULT_STORE_CODE).toUpperCase().trim();
  const minted = await serialization.mintSerial(serialDeps(), {
    docType: 'voucher', storeCode, resourceType: 'voucher', resourceIdFromCode: true,
  });
  const code = minted.serial_code;
  const validUntil = addMonths(today, 12);
  try {
    const { price_rule: rule } = await postJson('price_rules.json', { price_rule: {
      title: code,
      target_type: 'line_item',
      target_selection: 'all',
      allocation_method: 'across',
      value_type: 'fixed_amount',
      value: `-${amount.toFixed(2)}`,
      customer_selection: 'prerequisite',
      prerequisite_customer_ids: [Number(plan.customer_id)],
      prerequisite_subtotal_range: { greater_than_or_equal_to: amount.toFixed(2) },
      starts_at: new Date().toISOString(),
      ends_at: `${validUntil}T23:59:59+05:30`,
      usage_limit: 1,
    } });
    await postJson(`price_rules/${rule.id}/discount_codes.json`, { discount_code: { code } });
    await creditInstruments.upsertIssued(supabase, {
      instrumentType: 'voucher', serialCode: code, value: amount,
      customerId: plan.customer_id, customerName: plan.customer_name,
      sourceOrderName: `BUY-PLAN ${plan.draft_name} (${why})`, stateCode: storeCode,
      expiresAt: `${validUntil}T23:59:59+05:30`, priceRuleId: String(rule.id),
    });
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    throw new Error(`voucher ${code} was numbered but not finished in Shopify: ${detail}`);
  }
  if (config.loyalty.enabled) {
    require('../../loyalty/routes').allowVoucherWithLoyalty(code)
      .catch(e => log.warn('buy-plan', `voucher ${code} loyalty combine: ${e.message}`));
  }
  log.info('buy-plan', `${plan.draft_name}: voucher ${code} for Rs${amount} (${why}), valid to ${validUntil}`);
  return { code, value: amount, validUntil };
}

module.exports = { issuePlanVoucher };
