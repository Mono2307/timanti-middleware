'use strict';

// Buy plan — closing a plan for non-payment (founder, 2026-10-30; the rules are in schedule.js).
// Everything the customer paid becomes a voucher (voucher.js): one year, one purchase worth at least
// its value. The draft is released: its plan tags come off (so the price lock and the delete guard
// stop) and it is tagged buy-plan-closed. It is NOT deleted here — its payments are what the voucher
// stands for, and the store deletes it once they have seen the alert.
//
// The plan is marked forfeited BEFORE the voucher is made, so a crash in between can never issue a
// second voucher on the next sweep; the store alert then says to create it by hand.

const { putJson } = require('../../../core/shopify');
const { log } = require('../../../core/logger');
const store = require('./store');
const notify = require('./notify');
const { issuePlanVoucher } = require('./voucher');
const { RATE_LOCK_TAG, BUY_PLAN_TAG, FINAL_REPRICE_TAG, CHANGE_REPRICE_TAG } = require('./lock');

const CLOSED_TAG = 'buy-plan-closed';
const PLAN_TAGS = [BUY_PLAN_TAG, RATE_LOCK_TAG, FINAL_REPRICE_TAG, CHANGE_REPRICE_TAG, 'reprice'];

async function forfeitPlan(plan, d, st, today, reason) {
  const paid = st.paid;
  await store.updatePlan(plan.id, { status: 'forfeited', closed_at: new Date().toISOString(), closed_reason: reason });

  let voucher = null;
  let voucherError = null;
  if (paid > 0) {
    try {
      voucher = await issuePlanVoucher({ plan, d, value: paid, today, why: 'plan closed' });
      await store.updatePlan(plan.id, { voucher_code: voucher.code, voucher_value: voucher.value });
    } catch (e) {
      voucherError = e.message;
      log.error('buy-plan', `${plan.draft_name}: forfeit voucher: ${e.message}`);
    }
  }

  if (d) {
    const tags = [...d.tags.filter(t => !PLAN_TAGS.includes(String(t).toLowerCase())), CLOSED_TAG];
    await putJson(`draft_orders/${d.id}.json`, { draft_order: { id: d.id, tags: tags.join(', ') } })
      .catch(e => log.error('buy-plan', `${plan.draft_name}: release tags: ${e.message}`));
  }
  await notify.sendForfeited(plan, d, { paid, voucher, voucherError, reason });
  await store.markSent(plan.id, st.n, 'customer', 'forfeited');
  log.info('buy-plan', `${plan.draft_name}: plan closed (${reason}), Rs${paid} → ${voucher ? voucher.code : 'NO VOUCHER'}`);
  return { voucher, voucherError };
}

module.exports = { forfeitPlan, CLOSED_TAG };
