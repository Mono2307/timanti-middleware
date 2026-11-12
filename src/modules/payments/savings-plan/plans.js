'use strict';

// Savings plan — what a use of its voucher does to the plan (called by redeem.js settleUse).
//   voucherBalance  part used: the plan's draft shows the balance (custom.savings_voucher_balance), the
//                   customer is emailed what is left and until when
//   voucherSpent    used up: plan status 'redeemed', its draft tagged savings-redeemed (from here the
//                   draft may be deleted, HQ 12 Nov 2026), balance 0

const { log } = require('../../../core/logger');
const store = require('./store');
const notify = require('./notify');
const { readDraft, tagsFor, writeTags, writeMetafields } = require('./draft');

async function planDraft(code) {
  const plan = await store.getPlanByVoucher(code);
  if (!plan) { log.warn('savings-plan', `${code}: no plan carries this voucher`); return {}; }
  return { plan, d: await readDraft(plan.draft_order_id).catch(() => null) };
}

async function voucherBalance(code, left, { used, orderName, expiresAt } = {}) {
  const { plan, d } = await planDraft(code);
  if (!plan) return;
  if (d) await writeMetafields(d, { savings_voucher_balance: String(Math.round(left)) });
  await notify.sendVoucherBalance(plan, { code, used, left, orderName, expiresAt })
    .catch(e => log.error('savings-plan', `${code}: balance email: ${e.message}`));
}

async function voucherSpent(code) {
  const { plan, d } = await planDraft(code);
  if (!plan) return;
  await store.updatePlan(plan.id, { status: 'redeemed' });
  if (d) {
    const keep = d.tags.filter(t => /^ssv(-value|-bonus)?:/i.test(t));
    await writeTags(d, tagsFor(d, 'redeemed', keep));
    await writeMetafields(d, { savings_status: 'redeemed', savings_voucher_balance: '0' });
  }
  log.info('savings-plan', `${plan.draft_name}: voucher ${code} used up — plan redeemed`);
}

module.exports = { voucherBalance, voucherSpent };
