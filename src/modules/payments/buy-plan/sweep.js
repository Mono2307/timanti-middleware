'use strict';

// Buy plan — the reminder sweep. Runs every 6 hours; every message is guarded by a sent-marker, so
// running more often only means a reminder is never more than a few hours late.
//
// Per active plan, in order:
//   1. draft gone           → restore it from the snapshot (the delete webhook normally got there first)
//   2. draft completed      → plan completed; "plan complete" email to the customer, once
//   3. new payment settled  → "payment received" email with the recalculated schedule, once per installment
//   4. due within 3 days    → a GoKwik link for the amount due now, by email + SMS (not installment 1:
//                             that is due the day the plan starts, at the counter)
//   5. 3+ days overdue      → one overdue reminder with a fresh link
// Equal plans only (schedule.js), before any of 3-5:
//   - 3 days before installment 6: "your last installment is priced on <date>", with an estimate
//   - on the date of installment 6: reprice the draft at that day's gold rate (final.js); a follow-up
//     run 5 minutes later reads the new price, fixes it as the plan's final price and sends the link
// Then one staff digest a day: everything due in 3 days or overdue, with a WhatsApp link per customer.

const { log } = require('../../../core/logger');
const S = require('./schedule');
const store = require('./store');
const notify = require('./notify');
const { createPlanLink } = require('./links');
const final = require('./final');
const { readDraft, snapshotOf, todayIst, daysBetween, adminDraftUrl } = require('./draft');

const REMIND_DAYS_BEFORE = 3;
const OVERDUE_AFTER_DAYS = 3;
const DIGEST_KEY = 'buy_plan_digest_last';
const RUN_EVERY_MS = 6 * 60 * 60 * 1000;
const FOLLOW_UP_MS = 5 * 60 * 1000;   // the reprice runs off a Shopify webhook; give it time to land

const digestRow = (plan, d, k, due, amount, extra = {}) => ({
  draftName: plan.draft_name, adminUrl: adminDraftUrl(d.id), customerName: plan.customer_name,
  phone: plan.customer_phone, mode: plan.mode, k, due, amount, overdue: false, ...extra,
});

function followUp(planId) {
  const t = setTimeout(async () => {
    try {
      const plan = await store.getPlan(planId);
      if (plan && plan.status === 'active') await sweepPlan(plan, todayIst(), { dryRun: false, restore: null });
    } catch (e) { log.error('buy-plan', `follow-up for plan ${planId}: ${e.message}`); }
  }, FOLLOW_UP_MS);
  if (t.unref) t.unref();
}

// The equal plan's last-installment pricing. Returns a result to stop at, or null to carry on.
async function finalStep(plan, d, today, { dryRun }) {
  const due6 = String((plan.due_dates || [])[S.PLAN_INSTALLMENTS - 1] || '').slice(0, 10);
  const days = daysBetween(today, due6);
  if (days > 0) {
    if (days <= REMIND_DAYS_BEFORE && !(await store.wasSent(plan.id, S.PLAN_INSTALLMENTS, 'customer', 'final_notice'))) {
      if (dryRun) return { plan: plan.draft_name, action: 'would send the final-price notice' };
      const estimate = await final.estimateFinal(plan, d);
      await notify.sendFinalNotice(plan, d, estimate);
      await store.markSent(plan.id, S.PLAN_INSTALLMENTS, 'customer', 'final_notice');
    }
    return null;
  }

  if (!(await store.wasSent(plan.id, S.PLAN_INSTALLMENTS, 'staff', 'final_reprice'))) {
    if (dryRun) return { plan: plan.draft_name, action: "would reprice at today's gold rate" };
    const rates = await final.startFinalReprice(plan, d);
    await store.markSent(plan.id, S.PLAN_INSTALLMENTS, 'staff', 'final_reprice');
    await store.updatePlan(plan.id, { final_rates: { date: today, rates } });
    followUp(plan.id);
    return { plan: plan.draft_name, action: 'final reprice started' };
  }

  if (!final.finalRepriceDone(d.tags)) {
    return { plan: plan.draft_name, action: 'waiting for the final reprice',
      digest: digestRow(plan, d, S.PLAN_INSTALLMENTS, due6, 0, { overdue: true, note: 'Final reprice has not finished. Open the draft and check its tags (buy-plan-final / reprice).' }) };
  }

  if (dryRun) return { plan: plan.draft_name, action: 'would fix the final price' };
  plan.final_total = d.total;
  await store.updatePlan(plan.id, { final_total: d.total, final_repriced_at: new Date().toISOString() });
  const state = S.planState(plan, d.legs);
  const link = state.next ? await createPlanLink(plan, state.owed) : null;
  await notify.sendFinalPrice(plan, d, link);
  await store.markSent(plan.id, S.PLAN_INSTALLMENTS, 'customer', 'final_price');
  if (state.next === S.PLAN_INSTALLMENTS) await store.markSent(plan.id, S.PLAN_INSTALLMENTS, 'customer', 'due');
  if (state.credit > 0) await notify.sendFinalCredit(plan, d, state.credit);
  log.info('buy-plan', `${plan.draft_name}: final price Rs${d.total} (balance Rs${state.balance}, credit Rs${state.credit})`);
  return { plan: plan.draft_name, action: 'final price set', finalTotal: d.total, balance: state.balance, credit: state.credit };
}

async function sweepPlan(plan, today, { dryRun, restore }) {
  const d = await readDraft(plan.draft_order_id);
  if (!d) {
    if (!dryRun && restore) await restore(plan.draft_order_id);
    return { plan: plan.draft_name, action: 'draft missing — restore attempted' };
  }

  if (d.draft.status === 'completed') {
    if (dryRun) return { plan: plan.draft_name, action: 'would complete' };
    await store.updatePlan(plan.id, { status: 'completed' });
    if (!(await store.wasSent(plan.id, S.PLAN_INSTALLMENTS, 'customer', 'completed'))) {
      await notify.sendCompleted(plan);
      await store.markSent(plan.id, S.PLAN_INSTALLMENTS, 'customer', 'completed');
    }
    return { plan: plan.draft_name, action: 'completed' };
  }

  if (S.awaitingFinalPrice(plan)) {
    const stop = await finalStep(plan, d, today, { dryRun });
    if (stop) return stop;
  }

  const state = S.planState(plan, d.legs);
  const out = { plan: plan.draft_name, next: state.next, owed: state.owed, balance: state.balance, sent: [] };
  if (!dryRun) await store.updatePlan(plan.id, { snapshot: snapshotOf(d) });

  // 3. A payment closed an installment since the last run: confirm it, with the new figures.
  const lastSettled = state.settled.length;
  if (lastSettled && !(await store.wasSent(plan.id, lastSettled, 'customer', 'received'))) {
    if (!dryRun) {
      await notify.sendReceived(plan, d);
      for (let k = 1; k <= lastSettled; k++) await store.markSent(plan.id, k, 'customer', 'received');
    }
    out.sent.push(`received #${lastSettled}`);
  }
  if (!state.next) return out;   // fully paid; the existing flow converts the draft

  const k = state.next;
  const due = String((plan.due_dates || [])[k - 1] || '').slice(0, 10);
  const daysToDue = daysBetween(today, due);
  // Installment 1 is due the day the plan starts, with the customer at the counter: it only reaches
  // the staff digest once it is actually overdue.
  const digest = (daysToDue <= REMIND_DAYS_BEFORE && (k > 1 || daysToDue < 0))
    ? digestRow(plan, d, k, due, state.owed, { overdue: daysToDue < 0 }) : null;

  // 4. Due soon. (An equal plan's installment 6 gets its link from the final pricing instead.)
  const unpriced = k === S.PLAN_INSTALLMENTS && S.awaitingFinalPrice(plan);
  if (k > 1 && !unpriced && daysToDue <= REMIND_DAYS_BEFORE && daysToDue > -OVERDUE_AFTER_DAYS
      && !(await store.wasSent(plan.id, k, 'customer', 'due'))) {
    if (!dryRun) {
      const link = await createPlanLink(plan, state.owed);
      await notify.sendLink(plan, d, link);
      await store.markSent(plan.id, k, 'customer', 'due');
    }
    out.sent.push(`due #${k} Rs${state.owed}`);
  }

  // 5. Overdue.
  if (daysToDue <= -OVERDUE_AFTER_DAYS && !(await store.wasSent(plan.id, k, 'customer', 'overdue'))) {
    if (!dryRun) {
      const link = await createPlanLink(plan, state.owed);
      await notify.sendLink(plan, d, link, { overdue: true });
      await store.markSent(plan.id, k, 'customer', 'overdue');
    }
    out.sent.push(`overdue #${k} Rs${state.owed}`);
  }
  return { ...out, digest };
}

async function runBuyPlanSweep({ dryRun = false, restore = null, now = Date.now() } = {}) {
  const today = todayIst(now);
  const plans = await store.listActivePlans();
  const results = [];
  const digestRows = [];
  for (const plan of plans) {
    try {
      const r = await sweepPlan(plan, today, { dryRun, restore });
      if (r.digest) digestRows.push(r.digest);
      results.push(r);
    } catch (e) {
      // One bad plan must not stop the rest.
      log.error('buy-plan', `sweep ${plan.draft_name}: ${e.message}`);
      results.push({ plan: plan.draft_name, error: e.message });
    }
  }

  let digest = 'nothing due';
  if (digestRows.length) {
    if ((await store.getConfigValue(DIGEST_KEY)) === today) digest = 'already sent today';
    else if (dryRun) digest = `would send (${digestRows.length})`;
    else {
      await notify.sendStaffDigest(digestRows);
      await store.setConfigValue(DIGEST_KEY, today);
      digest = `sent (${digestRows.length})`;
    }
  }
  log.info('buy-plan', `sweep ${today}: ${plans.length} active plan(s), digest ${digest}`);
  return { today, plans: results, digest, digestRows: dryRun ? digestRows : undefined };
}

function startBuyPlanSweep(opts = {}) {
  const kick = () => runBuyPlanSweep(opts).catch(err => log.error('buy-plan', `sweep failed: ${err.message}`));
  setTimeout(kick, 150 * 1000);   // after the voucher / CAD / loyalty sweeps, so boot logs stay readable
  setInterval(kick, RUN_EVERY_MS);
}

module.exports = { runBuyPlanSweep, startBuyPlanSweep, sweepPlan, finalStep, REMIND_DAYS_BEFORE, OVERDUE_AFTER_DAYS };
