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
// Then one staff digest a day: everything due in 3 days or overdue, with a WhatsApp link per customer.

const { log } = require('../../../core/logger');
const S = require('./schedule');
const store = require('./store');
const notify = require('./notify');
const { createPlanLink } = require('./links');
const { readDraft, snapshotOf, todayIst, daysBetween, adminDraftUrl } = require('./draft');

const REMIND_DAYS_BEFORE = 3;
const OVERDUE_AFTER_DAYS = 3;
const DIGEST_KEY = 'buy_plan_digest_last';
const RUN_EVERY_MS = 6 * 60 * 60 * 1000;

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

  const state = S.replay(plan.total, d.legs);
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
  const digest = (daysToDue <= REMIND_DAYS_BEFORE && (k > 1 || daysToDue < 0)) ? {
    draftName: plan.draft_name, adminUrl: adminDraftUrl(d.id), customerName: plan.customer_name,
    phone: plan.customer_phone, k, due, amount: state.owed, overdue: daysToDue < 0,
  } : null;

  // 4. Due soon.
  if (k > 1 && daysToDue <= REMIND_DAYS_BEFORE && daysToDue > -OVERDUE_AFTER_DAYS
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

module.exports = { runBuyPlanSweep, startBuyPlanSweep, sweepPlan, REMIND_DAYS_BEFORE, OVERDUE_AFTER_DAYS };
