'use strict';

// Buy plan — closing a plan for non-payment (founder, 2026-10-30; the rules are in schedule.js).
// Everything the customer paid is owed back as a voucher (one year, one purchase worth at least its
// value), but it is NOT issued here (founder, 2026-11-09): the store is told, checks the money really
// came in, and presses Issue voucher on the Buy plan screen (credit.js). The customer hears about the
// voucher when it is issued. The draft is released: its plan tags come off (so the price lock and the
// delete guard stop), it is tagged buy-plan-closed, and any open payment link is cancelled. It is NOT
// deleted here: the voucher is issued from it, and the store deletes it after that.

const { putJson } = require('../../../core/shopify');
const { log } = require('../../../core/logger');
const store = require('./store');
const notify = require('./notify');
const { vouchered } = require('./credit');
const { cancelOpenLinks } = require('./links');
const { RATE_LOCK_TAG, BUY_PLAN_TAG, FINAL_REPRICE_TAG, CHANGE_REPRICE_TAG } = require('./lock');

const CLOSED_TAG = 'buy-plan-closed';
const PLAN_TAGS = [BUY_PLAN_TAG, RATE_LOCK_TAG, FINAL_REPRICE_TAG, CHANGE_REPRICE_TAG, 'reprice'];

// The plan no longer holds the draft: its plan tags come off (the price lock and the delete guard
// stop), `endTag` says why, and any payment link the customer still holds is cancelled.
async function releaseDraft(plan, d, endTag) {
  await cancelOpenLinks(plan.draft_order_id)
    .catch(e => log.error('buy-plan', `${plan.draft_name}: cancel links: ${e.message}`));
  if (!d) return;
  const tags = [...d.tags.filter(t => !PLAN_TAGS.includes(String(t).toLowerCase())), endTag];
  await putJson(`draft_orders/${d.id}.json`, { draft_order: { id: d.id, tags: tags.join(', ') } })
    .catch(e => log.error('buy-plan', `${plan.draft_name}: release tags: ${e.message}`));
}

async function forfeitPlan(plan, d, st, today, reason) {
  const owed = Math.max(0, Math.round(st.paid) - vouchered(plan));
  await store.updatePlan(plan.id, { status: 'forfeited', closed_at: new Date().toISOString(), closed_reason: reason });
  plan.status = 'forfeited';
  await releaseDraft(plan, d, CLOSED_TAG);
  await notify.sendForfeited(plan, d, { owed, reason });
  await store.markSent(plan.id, st.n, 'staff', 'forfeited');
  log.info('buy-plan', `${plan.draft_name}: plan closed (${reason}), Rs${owed} owed as a voucher: store prompted`);
  return { owed };
}

module.exports = { forfeitPlan, releaseDraft, CLOSED_TAG };
