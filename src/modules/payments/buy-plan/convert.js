'use strict';

// Buy plan — a plan draft may not become an order while money is still owed on it (founder D2,
// 2026-11-09). server.js asks before every conversion it makes (/api/convert-to-order and
// completeShopifyOrder). Shopify's own Create order / Mark as paid cannot be stopped from here; the
// sweep catches those afterwards (sweep.js: no "complete" email, the store is told what is owed).

const S = require('./schedule');
const store = require('./store');
const { readDraft } = require('./draft');
const { config } = require('../../../core/config');

// A savings-plan draft NEVER becomes an order (HQ, 12 Nov 2026): it pays out a Savings Scheme Voucher,
// which is spent on a separate purchase draft. Only asked while savings plans are switched on, so a
// deploy before its table exists adds no failing query to every conversion.
async function savingsBlock(draftId) {
  if (!config.savingsPlan.enabled) return null;
  const plan = await require('../savings-plan/store').getPlanByDraft(String(draftId).replace(/\D/g, ''));
  if (!plan || plan.status === 'cancelled') return null;
  return `Savings plan ${plan.draft_name}: a savings plan draft is never converted to an order. Its voucher is used on a separate purchase.`;
}

// null when the draft may be converted, else the reason it may not (shown to staff as is).
async function conversionBlock(draftId) {
  const savings = await savingsBlock(draftId);
  if (savings) return savings;
  const plan = await store.getPlanByDraft(String(draftId).replace(/\D/g, ''));
  if (!plan || plan.status !== 'active') return null;
  const d = await readDraft(plan.draft_order_id);
  if (!d) return null;
  const st = S.planState(plan, d.legs, new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10));
  if (st.balance > 0) return `Buy plan ${plan.draft_name}: Rs${st.balance.toLocaleString('en-IN')} is still to be paid. Collect it before converting the draft to an order.`;
  if (S.awaitingFinalPrice(plan)) return `Buy plan ${plan.draft_name}: the final price is worked out 3 days before the last installment. Convert after that.`;
  if (plan.change_pending) return `Buy plan ${plan.draft_name}: a product change is still being priced. Try again in a minute.`;
  return null;
}

module.exports = { conversionBlock, savingsBlock };
