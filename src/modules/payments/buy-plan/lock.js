'use strict';

// Buy plan — the price lock.
//
// A buy plan blocks the gold rate on the day it starts: the customer pays the price agreed that day,
// however the rate moves over the six months. So once a plan is started, nothing may reprice the
// draft. Every repricing path in the codebase funnels through handleRecalculatePriceTag, and the
// two that rewrite the gold rate BEFORE getting there (the jewel-code form and the PO sheet) plus the
// two that change the price by discount (apply-discount, loyalty) check this as well.
//
// The lock is a TAG, not a metafield, on purpose: every one of those paths already holds the draft's
// tags, so checking costs no extra API call on the hot draft-update webhook. `buy-plan` (the plan's
// own marker) also counts, so a plan whose rate-locked tag was stripped by hand still refuses.
// Deliberately NOT ot:buy-plan: ot: tags are rebuilt from custom.order_type (in-stock | mto) and drive
// the confirmation email, and a buy-plan piece is still one of those two.

const RATE_LOCK_TAG = 'rate-locked';
const BUY_PLAN_TAG  = 'buy-plan';
const REFUSED_NOTE  = 'rate locked: buy plan';
// The equal plan's final price used to be an engine reprice let through by this tag. Since 2026-11-06
// it moves only the gold and is written straight onto the lines (final.js), so nothing sets this tag
// any more; it is still honoured so a draft caught mid-reprice by that deploy finishes: while it is
// on the lock steps aside, and the reprice swaps it for rate-locked.
const FINAL_REPRICE_TAG = 'buy-plan-final';
// A product change (routes.js changeProduct): today's rate goes into custom.gold_rate and the draft is
// tagged buy-plan-change + reprice. The lock steps aside for that one reprice too, and the reprice
// drops the tag WITHOUT locking: a changed plan floats until its final reprice (founder, 2026-10-30).
const CHANGE_REPRICE_TAG = 'buy-plan-change';

const tagList = (tags) => (Array.isArray(tags) ? tags : String(tags || '').split(','))
  .map(t => String(t).trim().toLowerCase()).filter(Boolean);

function isRateLocked(tags) {
  const list = tagList(tags);
  if (list.includes(FINAL_REPRICE_TAG) || list.includes(CHANGE_REPRICE_TAG)) return false;
  return list.includes(RATE_LOCK_TAG) || list.includes(BUY_PLAN_TAG);
}

// The tags a reprice writes back: buy-plan-final becomes rate-locked, buy-plan-change just goes.
// Anything else is untouched.
function relockAfterReprice(tags) {
  const list = (Array.isArray(tags) ? tags : String(tags || '').split(','))
    .map(t => String(t).trim()).filter(t => t && t.toLowerCase() !== CHANGE_REPRICE_TAG);
  if (!list.some(t => t.toLowerCase() === FINAL_REPRICE_TAG)) return list;
  const kept = list.filter(t => t.toLowerCase() !== FINAL_REPRICE_TAG);
  return kept.some(t => t.toLowerCase() === RATE_LOCK_TAG) ? kept : [...kept, RATE_LOCK_TAG];
}

module.exports = { RATE_LOCK_TAG, BUY_PLAN_TAG, FINAL_REPRICE_TAG, CHANGE_REPRICE_TAG, REFUSED_NOTE, isRateLocked, relockAfterReprice };
