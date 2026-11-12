'use strict';

// Savings plan — spending a Savings Scheme Voucher, possibly over several purchases (HQ, 10 Nov 2026:
// "part use allowed, the balance stays on the voucher").
//
// An ordinary voucher is single-use: applied whole, redeemed when its draft converts, its Shopify code
// deleted. A Savings Scheme Voucher (SSV…) differs in three places, and only there:
//
//   apply (in store, server.js handleApplyVoucherTag)
//       only what the bill needs is applied: min(balance, the bill after other credits). The draft's
//       voucher_value is that amount, so the invoice and the collect figures are right as they are.
//   conversion (server.js, the draft-completed lock) / online order (serialization/routes.js freeze)
//       settleUse(): one row in savings_voucher_uses per order (its unique key makes a replayed webhook
//       a no-op), then the balance goes down by what was used.
//         balance left → the ledger row is OPEN again with credit_instruments.remaining = the balance,
//                        and the Shopify code is re-made for the balance (same code, same expiry), so
//                        the customer can use it online again
//         nothing left → redeemed as usual, the code deleted, and the plan's draft moves to
//                        savings-redeemed (the plan row status 'redeemed')
//
// The customer is emailed the balance after every part use.

const { supabase } = require('../../../core/supabase');
const { postJson, deleteJson } = require('../../../core/shopify');
const { log } = require('../../../core/logger');
const { config } = require('../../../core/config');
const creditInstruments = require('../../adjustments/credit_instruments');

const USES = 'savings_voucher_uses';
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const isSavingsCode = (code) => /^SSV/i.test(String(code || '').trim());
// What is left on the voucher. Rows issued before part use existed have no `remaining`: their value.
const remainingOf = (inst) => r2(inst && inst.remaining !== null && inst.remaining !== undefined ? inst.remaining : inst && inst.value);
// How much of the voucher a bill of `billNet` (after every other credit) takes.
const usableOn = (inst, billNet) => r2(Math.max(0, Math.min(remainingOf(inst), Number(billNet) || 0)));

// Pure: what one use does to the voucher. { used, left, closes }.
function afterUse(inst, used) {
  const take = r2(Math.min(remainingOf(inst), Math.max(0, Number(used) || 0)));
  const left = r2(remainingOf(inst) - take);
  return { used: take, left, closes: left < 1 };
}

// The Shopify side of a Savings Scheme Voucher: a customer-bound, single-use fixed discount with no
// minimum purchase (Shopify caps a fixed discount at the order's subtotal; the balance is re-made by
// settleUse). Returns the price rule id. Used at issue (voucher.js) and after every part use.
async function makeDiscount({ code, amount, customerId, endsAt }) {
  const { price_rule: rule } = await postJson('price_rules.json', { price_rule: {
    title: code, target_type: 'line_item', target_selection: 'all', allocation_method: 'across',
    value_type: 'fixed_amount', value: `-${r2(amount).toFixed(2)}`,
    customer_selection: 'prerequisite', prerequisite_customer_ids: [Number(customerId)],
    starts_at: new Date().toISOString(), ends_at: endsAt, usage_limit: 1,
  } });
  await postJson(`price_rules/${rule.id}/discount_codes.json`, { discount_code: { code } });
  return String(rule.id);
}

async function deleteDiscount(priceRuleId) {
  if (!priceRuleId) return;
  try { await deleteJson(`price_rules/${priceRuleId}.json`); }
  catch (e) { if (e.response?.status !== 404) throw e; }
}

// One use of a Savings Scheme Voucher on an order. channel: 'store' (draft converted) | 'online'.
// Idempotent per (code, order). Never throws into the caller's webhook: failures are logged.
async function settleUse({ code, used, orderId, orderName, channel, deps = {} }) {
  const db = deps.supabase || supabase;
  const ci = deps.creditInstruments || creditInstruments;
  const discount = deps.discount || { makeDiscount, deleteDiscount };
  const plans = deps.plans || require('./plans');
  try {
    const inst = await ci.getBySerial(db, { instrumentType: 'voucher', serialCode: code });
    if (!inst) { log.warn('savings-plan', `settle ${code}: not in the ledger`); return null; }
    const u = afterUse(inst, used);
    if (!(u.used > 0)) return null;

    // The unique (serial_code, order_id) key: a second delivery for the same order stops here.
    const { error: insErr } = await db.from(USES).insert({
      serial_code: code, order_id: String(orderId), order_name: orderName || null, amount: u.used,
      balance_after: u.left, channel,
    });
    if (insErr) {
      if (insErr.code === '23505') return { duplicate: true };
      throw new Error(`${USES} insert: ${insErr.message}`);
    }

    if (u.closes) {
      await ci.redeem(db, { instrumentType: 'voucher', serialCode: code, targetOrderId: orderId, targetOrderName: orderName, value: inst.value });
      await db.from('credit_instruments').update({ remaining: 0, updated_at: new Date().toISOString() })
        .eq('instrument_type', 'voucher').eq('serial_code', code);
      await discount.deleteDiscount(inst.price_rule_id).catch(e => log.error('savings-plan', `${code}: delete code: ${e.message}`));
      await plans.voucherSpent(code).catch(e => log.error('savings-plan', `${code}: plan → redeemed: ${e.message}`));
      log.info('savings-plan', `${code}: Rs${u.used} used on ${orderName || orderId} — voucher used up`);
      return { ...u, closed: true };
    }

    // Balance left: the row is open again, for the balance.
    const now = new Date().toISOString();
    await db.from('credit_instruments').update({
      status: 'open', remaining: u.left, target_draft_id: null, applied_at: null,
      target_order_id: null, target_order_name: null, redeemed_at: null, updated_at: now,
    }).eq('instrument_type', 'voucher').eq('serial_code', code);
    // The online code: re-made for the balance (an online use spent the old one; a store use leaves it
    // at the old value, which would over-pay).
    try {
      await discount.deleteDiscount(inst.price_rule_id);
      const ruleId = await discount.makeDiscount({ code, amount: u.left, customerId: inst.customer_id, endsAt: inst.expires_at });
      await db.from('credit_instruments').update({ price_rule_id: ruleId, updated_at: new Date().toISOString() })
        .eq('instrument_type', 'voucher').eq('serial_code', code);
      // A re-made code loses the loyalty combine setting the issued one had (voucher.js).
      if (config.loyalty.enabled && !deps.discount) {
        await require('../../loyalty/routes').allowVoucherWithLoyalty(code)
          .catch(e => log.warn('savings-plan', `${code} loyalty combine: ${e.message}`));
      }
    } catch (e) {
      log.error('savings-plan', `${code}: the online code was not re-made for Rs${u.left} (${e.message}). It still works in store; re-make it by hand for online use.`);
    }
    await plans.voucherBalance(code, u.left, { used: u.used, orderName, expiresAt: inst.expires_at }).catch(e => log.error('savings-plan', `${code}: balance note: ${e.message}`));
    log.info('savings-plan', `${code}: Rs${u.used} used on ${orderName || orderId} (${channel}), Rs${u.left} left`);
    return { ...u, closed: false };
  } catch (e) {
    log.error('savings-plan', `settle ${code} on ${orderName || orderId}: ${e.message}`);
    return null;
  }
}

module.exports = { isSavingsCode, remainingOf, usableOn, afterUse, settleUse, makeDiscount, deleteDiscount, USES };
