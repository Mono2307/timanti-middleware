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
// tags, so checking costs no extra API call on the hot draft-update webhook. `ot:buy-plan` (the
// order-type routing tag) also counts, so a plan whose rate-locked tag was stripped by hand still
// refuses — but rate-locked is the one the plan writes, because staff can change the order type.

const RATE_LOCK_TAG = 'rate-locked';
const BUY_PLAN_TAG  = 'ot:buy-plan';
const REFUSED_NOTE  = 'rate locked: buy plan';

const tagList = (tags) => (Array.isArray(tags) ? tags : String(tags || '').split(','))
  .map(t => String(t).trim().toLowerCase()).filter(Boolean);

function isRateLocked(tags) {
  const list = tagList(tags);
  return list.includes(RATE_LOCK_TAG) || list.includes(BUY_PLAN_TAG);
}

module.exports = { RATE_LOCK_TAG, BUY_PLAN_TAG, REFUSED_NOTE, isRateLocked };
