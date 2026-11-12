'use strict';

// Savings plan — the Savings Scheme Voucher (HQ, 10–12 Nov 2026).
//   - Its own serial series, SSV27-KAHSR-0001 (serialization DEFAULT_REGISTRY.savings_voucher), so it is
//     never mistaken for an ordinary VCH voucher.
//   - Valid 1 year, bound to the customer, online or in store.
//   - Value = the money paid + the bonus. The ledger row keeps the two apart (paid_part, bonus_part) so
//     Accounts can book the customer's money and Timanti's bonus separately, and carries the balance
//     (remaining), which starts at the full value.
//   - It sits in the credit-instrument ledger as instrument_type 'voucher', so the store applies it to a
//     purchase draft exactly like any voucher (apply-voucher:<code>) and the invoice prints it.
//   - PART USE: the balance stays on the voucher (redeem.js). So the Shopify code has no minimum
//     purchase: Shopify caps it at the order, and the balance is re-made after the order.

const { config } = require('../../../core/config');
const { supabase } = require('../../../core/supabase');
const { getShopifyToken } = require('../../../core/shopify');
const { updateDraftOrderMetafields } = require('../../../core/metafields');
const { log } = require('../../../core/logger');
const serialization = require('../../serialization');
const creditInstruments = require('../../adjustments/credit_instruments');
const { addMonths } = require('../../adjustments/cad_advance');
const { makeDiscount } = require('./redeem');
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
  const endsAt = `${validUntil}T23:59:59+05:30`;
  try {
    const priceRuleId = await makeDiscount({ code, amount, customerId: plan.customer_id, endsAt });
    await creditInstruments.upsertIssued(supabase, {
      instrumentType: 'voucher', serialCode: code, value: amount,
      customerId: plan.customer_id, customerName: plan.customer_name,
      sourceOrderId: plan.draft_order_id,
      sourceOrderName: `SAVINGS ${plan.draft_name} (paid ${Math.round(paid)} + bonus ${Math.round(bonus)})`,
      stateCode: storeCode, expiresAt: endsAt, priceRuleId,
    });
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    throw new Error(`voucher ${code} was numbered but not finished in Shopify: ${detail}`);
  }
  // The paid / bonus split and the opening balance (migration.sql). Bookkeeping: never fails the issue,
  // but a missing balance is read as the full value (redeem.js remainingOf), so nothing is lost.
  const { error } = await supabase.from('credit_instruments')
    .update({ paid_part: Math.round(paid), bonus_part: Math.round(bonus), remaining: amount, updated_at: new Date().toISOString() })
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
