'use strict';

// Savings plan — the Savings Scheme Voucher (HQ, 10–12 Nov 2026).
//   - Its own serial series, SSV27-KAHSR-0001 (serialization DEFAULT_REGISTRY.savings_voucher), so it is
//     never mistaken for an ordinary VCH voucher.
//   - Valid 1 year, bound to the customer, online or in store.
//   - Value = the money paid + the bonus. The ledger row keeps the two apart (paid_part, bonus_part) so
//     Accounts can book the customer's money and Timanti's bonus separately.
//   - It sits in the credit-instrument ledger as instrument_type 'voucher', so the store applies it to a
//     purchase draft exactly like any voucher (apply-voucher:<code>) and the invoice prints it.
//
// PART USE is decided (the balance stays on the voucher) but not built yet: until it is, the Shopify
// discount needs a purchase of at least the voucher's value, like a buy-plan voucher, so it can never
// be spent online on a smaller order and lose its balance. In store, staff apply it only to a purchase
// of at least its value. The module stays switched off until part use is built.

const { config } = require('../../../core/config');
const { supabase } = require('../../../core/supabase');
const { getShopifyToken, postJson } = require('../../../core/shopify');
const { updateDraftOrderMetafields } = require('../../../core/metafields');
const { log } = require('../../../core/logger');
const serialization = require('../../serialization');
const creditInstruments = require('../../adjustments/credit_instruments');
const { addMonths } = require('../../adjustments/cad_advance');
const R = require('./rules');

const DEFAULT_STORE_CODE = 'KA-HSR';
const serialDeps = () => ({ supabase, getShopifyToken, shopifyStoreUrl: config.shopify.storeUrl, updateDraftOrderMetafields });

// Returns { code, value, paid, bonus, validUntil }. Throws if a Shopify step fails; once the serial is
// minted it is in the message, so staff can finish by hand.
async function issueSavingsVoucher({ plan, d, paid, bonus, today }) {
  const amount = Math.round(Number(paid) || 0) + Math.round(Number(bonus) || 0);
  if (!(amount > 0)) throw new Error('nothing to put on a voucher');
  if (!plan.customer_id) throw new Error('the plan has no customer');
  const storeCode = String((d && d.mf && d.mf.state_code) || DEFAULT_STORE_CODE).toUpperCase().trim();
  const minted = await serialization.mintSerial(serialDeps(), {
    docType: 'savings_voucher', storeCode, resourceType: 'voucher', resourceIdFromCode: true,
  });
  const code = minted.serial_code;
  const validUntil = addMonths(today, R.VOUCHER_MONTHS);
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
      sourceOrderId: plan.draft_order_id,
      sourceOrderName: `SAVINGS ${plan.draft_name} (paid ${Math.round(paid)} + bonus ${Math.round(bonus)})`,
      stateCode: storeCode, expiresAt: `${validUntil}T23:59:59+05:30`, priceRuleId: String(rule.id),
    });
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    throw new Error(`voucher ${code} was numbered but not finished in Shopify: ${detail}`);
  }
  // The paid / bonus split (migration.sql). Bookkeeping only: never fails the issue.
  const { error } = await supabase.from('credit_instruments')
    .update({ paid_part: Math.round(paid), bonus_part: Math.round(bonus), updated_at: new Date().toISOString() })
    .eq('instrument_type', 'voucher').eq('serial_code', code);
  if (error) log.error('savings-plan', `${code}: paid/bonus split not recorded: ${error.message}`);
  if (config.loyalty.enabled) {
    require('../../loyalty/routes').allowVoucherWithLoyalty(code)
      .catch(e => log.warn('savings-plan', `voucher ${code} loyalty combine: ${e.message}`));
  }
  log.info('savings-plan', `${plan.draft_name}: ${code} for Rs${amount} (paid ${Math.round(paid)} + bonus ${Math.round(bonus)}), valid to ${validUntil}`);
  return { code, value: amount, paid: Math.round(paid), bonus: Math.round(bonus), validUntil };
}

module.exports = { issueSavingsVoucher };
