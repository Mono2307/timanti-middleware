'use strict';

// Buy plan — the sweep. Runs every 6 hours; every message is guarded by a sent-marker, so running
// more often only means a reminder is never more than a few hours late.
//
// Vouchers are never issued here: when money is owed back the store is prompted (credit.js).
// Per active plan, in order:
//   1. draft gone             → restore it from the snapshot (the delete webhook normally got there first)
//   2. draft completed        → plan completed; "plan complete" email to the customer, once
//   3. product change pending → once its reprice has run: the new price and the new schedule; if the
//                               customer has already paid more than the new price, the store is told
//   4. floating plan          → 3 days before the last due date, the gold moves to that day's rate
//                               (only the gold, final.js); a follow-up 5 minutes later, once the
//                               collect figures are recomputed, fixes the final price and sends its link
//   5. pieces edited without "Change product" → one alert to the store (the snapshot keeps the
//                               plan's pieces, so a deleted draft comes back as the plan, not the edit)
//      the same piece re-added at another price → the snapshot's line is put back (keepLockedPrices)
//   6. new money since the last run → "payment received" with the new schedule
//   7. closure due            → the plan closes; the store is prompted to issue the voucher (forfeit.js)
//   8. closure warnings       → day 30 / 45 without a payment, day 15 / 25 after the last due date
//   9. next installment due within 3 days → a GoKwik link for what it asks, email + SMS
//  10. current installment 3+ days overdue → one overdue reminder with a fresh link
//  11. the link the customer holds lapses within 3 days, installment still unpaid → a new one, once
// Then one staff digest a day: everything due in 3 days, overdue, or about to close — every issue on
// a plan, not only the first.

const { log } = require('../../../core/logger');
const { updateDraftOrderMetafields } = require('../../../core/metafields');
const S = require('./schedule');
const store = require('./store');
const notify = require('./notify');
const { createPlanLink } = require('./links');
const final = require('./final');
const { forfeitPlan } = require('./forfeit');
const { voucherDue } = require('./credit');
const { readDraft, snapshotOf, todayIst, daysBetween, adminDraftUrl, linesKey,
  linesToRestore, withRestored, writeDraftLines, withTags, collectFresh, SYNC_TAG } = require('./draft');
const { readInstallments } = require('../installments');
const { isRateLocked } = require('./lock');

const REMIND_DAYS_BEFORE = 3;
const OVERDUE_AFTER_DAYS = 3;
const RELINK_DAYS_BEFORE = 3;   // a new link when the one the customer holds lapses within this many days
const FINAL_REPRICE_DAYS_BEFORE = 3;   // founder, 2026-10-30: the final link arrives with the reminder
const DIGEST_KEY = 'buy_plan_digest_last';
const RUN_EVERY_MS = 6 * 60 * 60 * 1000;
// A reprice runs off a Shopify webhook and usually lands within a minute: look every 15 seconds, for
// up to 10 minutes, and stop as soon as it has. A product change accepts the new price once the
// collect figure has caught up (collectFresh), or after FRESH_WAIT_MS at the latest.
const POLL_MS = 15 * 1000;
const POLL_FOR_MS = 10 * 60 * 1000;
const FRESH_WAIT_MS = 5 * 60 * 1000;
const STUCK_AFTER_MS = 60 * 60 * 1000;

const digestRow = (plan, d, n, k, due, amount, extra = {}) => ({
  draftName: plan.draft_name, adminUrl: adminDraftUrl(d.id), customerName: plan.customer_name,
  phone: plan.customer_phone, mode: plan.mode, n, k, due, amount, overdue: false, ...extra,
});

function followUp(planId, startedAt = Date.now()) {
  const t = setTimeout(async () => {
    let again = false;
    try {
      const plan = await store.getPlan(planId);
      if (plan && plan.status === 'active') {
        const r = await sweepPlan(plan, todayIst(), { dryRun: false, restore: null });
        again = /^waiting/.test(String(r?.action || ''));
      }
    } catch (e) { log.error('buy-plan', `follow-up for plan ${planId}: ${e.message}`); again = true; }
    if (again && Date.now() - startedAt < POLL_FOR_MS) followUp(planId, startedAt);
  }, POLL_MS);
  if (t.unref) t.unref();
}

const withPrice = (plan, date, total, why) => [...(plan.price_changes || []), { date, total: Math.round(total), why }];

// 3. A product change: finish it once the reprice has written the new price.
async function finishChange(plan, d, today, { dryRun }) {
  const pending = plan.change_pending || {};
  const since = Date.now() - Date.parse(pending.started_at || 0);
  if (!final.changeRepriceDone(d.tags) || (!collectFresh(d) && since < FRESH_WAIT_MS)) {
    const late = since > STUCK_AFTER_MS;
    return { plan: plan.draft_name, action: 'waiting for the product-change reprice',
      digest: late ? digestRow(plan, d, S.countOf(plan), 0, today, 0, { overdue: true, stuck: true,
        note: 'Product change: the reprice has not finished. Open the draft and check its tags (buy-plan-change / reprice).' }) : null };
  }
  if (dryRun) return { plan: plan.draft_name, action: 'would finish the product change' };

  const oldTotal = S.currentTotal(plan);
  const newTotal = d.total;
  const patch = {
    price_changes: withPrice(plan, today, newTotal, 'product change'),
    change_pending: null, lines_key: linesKey(d.draft.line_items), snapshot: snapshotOf(d),
  };
  // A plan already given its final price stays final, at the new price.
  if (plan.final_total !== null && plan.final_total !== undefined) patch.final_total = newTotal;
  Object.assign(plan, patch);
  await store.updatePlan(plan.id, patch);
  await updateDraftOrderMetafields(d.id, { plan_total: String(newTotal) }).catch(() => {});

  // Paid more than the new piece: no voucher here. The store is prompted to offer a piece of higher
  // value, or to issue a voucher for the difference by hand (credit.js).
  const st = S.planState(plan, d.legs, today);
  const owed = voucherDue(plan, st).amount;
  await notify.sendChanged(plan, d, { oldTotal, newTotal, lostLock: Boolean(pending.lost_lock), credit: owed, today });
  if (owed > 0) await notify.sendFinalCredit(plan, d, owed, { why: 'change', oldTotal, newTotal }).catch(e => log.error('buy-plan', `credit alert: ${e.message}`));
  log.info('buy-plan', `${plan.draft_name}: product changed, Rs${oldTotal} → Rs${newTotal}${owed > 0 ? `, paid Rs${owed} over the new price (store prompted)` : ''}`);
  return null;   // carry on with the rest of the sweep at the new price
}

// 4. The floating plan's last-installment pricing. Returns a result to stop at, or null to carry on.
async function finalStep(plan, d, today, { dryRun }) {
  const n = S.countOf(plan);
  const lastDue = S.datesOf(plan)[n - 1];
  if (daysBetween(today, lastDue) > FINAL_REPRICE_DAYS_BEFORE) return null;

  if (!(await store.wasSent(plan.id, n, 'staff', 'final_reprice'))) {
    if (dryRun) return { plan: plan.draft_name, action: "would reprice at today's gold rate" };
    const { rates, changes, skipped } = await final.startFinalReprice(plan, d);
    await store.markSent(plan.id, n, 'staff', 'final_reprice');
    await store.updatePlan(plan.id, { final_rates: { date: today, rates, changes, skipped } });
    followUp(plan.id);
    return { plan: plan.draft_name, action: 'final reprice started' };
  }

  if (!final.finalRepriceDone(d.tags)) {
    return { plan: plan.draft_name, action: 'waiting for the final reprice',
      digest: digestRow(plan, d, n, n, lastDue, 0, { overdue: true, stuck: true,
        note: 'Final price has not finished. Open the draft and check its tags (sync-payment / buy-plan-final / reprice); saving the payment panel re-runs the recompute.' }) };
  }

  if (dryRun) return { plan: plan.draft_name, action: 'would fix the final price' };
  // The lines now carry the final prices: they are the plan's from here on (keepLockedPrices compares
  // against this snapshot).
  const patch = { final_total: d.total, final_repriced_at: new Date().toISOString(), price_changes: withPrice(plan, today, d.total, 'final price'),
    lines_key: linesKey(d.draft.line_items), snapshot: snapshotOf(d) };
  Object.assign(plan, patch);
  await store.updatePlan(plan.id, patch);
  const st = S.planState(plan, d.legs, today);
  const link = st.balance > 0 ? await createPlanLink(plan, st.balance) : null;
  await notify.sendFinalPrice(plan, d, link, { today });
  await store.markSent(plan.id, n, 'customer', 'final_price');
  await store.markSent(plan.id, n, 'customer', 'due');
  if (st.credit > 0) await notify.sendFinalCredit(plan, d, st.credit);
  log.info('buy-plan', `${plan.draft_name}: final price Rs${d.total} (balance Rs${st.balance}, credit Rs${st.credit})`);
  return { plan: plan.draft_name, action: 'final price set', finalTotal: d.total, balance: st.balance, credit: st.credit };
}

// 5. The pieces on the draft are not the plan's, and no change is under way.
async function checkLines(plan, d, { dryRun }) {
  const planKey = plan.lines_key || linesKey((plan.snapshot || {}).line_items);
  const now = linesKey(d.draft.line_items);
  if (!planKey || now === planKey) return false;
  const key = `buy_plan_lines_${plan.id}`;
  if (!dryRun && (await store.getConfigValue(key)) !== now) {
    await notify.sendLinesChanged(plan, d);
    await store.setConfigValue(key, now);
  }
  return true;
}

// 5b. The same piece is on the draft at a price (or breakup) other than the plan's — typically removed
// and re-added from the catalog, which brings it in at today's catalog price with no breakup. Put the
// snapshot's line back. Only while the lock is in force: a product change or the final price writes
// new prices on purpose, and the snapshot follows them once they are done.
async function keepLockedPrices(plan, d, { dryRun }) {
  const snapLines = (plan.snapshot || {}).line_items;
  const tags = d.tags.map(t => t.toLowerCase());
  if (!snapLines || plan.change_pending || !isRateLocked(d.tags) || tags.includes('reprice')) return { fixes: [] };
  const fixes = linesToRestore(snapLines, d.draft.line_items);
  if (!fixes.length || dryRun) return { fixes };
  let error = null;
  try {
    await writeDraftLines(d.id, withRestored(d.draft.line_items, fixes), { tags: withTags(d.tags, [SYNC_TAG]) });
    for (const f of fixes) log.warn('buy-plan', `${plan.draft_name}: ${f.title} was at Rs${f.from}, put back to the plan's Rs${f.to}`);
  } catch (e) {
    error = e.message;
    log.error('buy-plan', `${plan.draft_name}: could not put the plan price back: ${error}`);
  }
  // A put-back happens once (the next sweep finds the plan's line); a write that keeps failing alerts
  // once per distinct finding, not every 6 hours.
  const key = `buy_plan_putback_${plan.id}`;
  const seen = fixes.map(f => `${f.idx}:${f.from}`).join(',');
  if (!error || (await store.getConfigValue(key)) !== seen) {
    await notify.sendPricePutBack(plan, d, fixes, error).catch(e => log.error('buy-plan', `put-back alert: ${e.message}`));
    if (error) await store.setConfigValue(key, seen);
  }
  return { fixes, error };
}

async function sweepPlan(plan, today, { dryRun, restore }) {
  const d = await readDraft(plan.draft_order_id);
  if (!d) {
    if (!dryRun && restore) await restore(plan.draft_order_id);
    return { plan: plan.draft_name, action: 'draft missing — restore attempted' };
  }
  const n = S.countOf(plan);
  if (!dryRun) await store.syncContact(plan, d.customer);   // messages go to the customer as they are now

  if (d.draft.status === 'completed') {
    if (dryRun) return { plan: plan.draft_name, action: 'would complete' };
    // Converted with money still owed (Shopify's own Create order / Mark as paid: ours refuse it,
    // convert.js): the plan is over, but the customer is NOT told it is complete; the store is told
    // what is still owed, to collect against the order.
    const owed = S.planState(plan, d.legs, today).balance;
    await store.updatePlan(plan.id, { status: 'completed', ...(owed > 0 ? { closed_reason: `converted with Rs${owed} unpaid` } : {}) });
    if (owed > 0) {
      if (!(await store.wasSent(plan.id, n, 'staff', 'completed'))) {
        await notify.sendConvertedOwing(plan, d, owed);
        await store.markSent(plan.id, n, 'staff', 'completed');
      }
      return { plan: plan.draft_name, action: `converted with Rs${owed} still owed — store told` };
    }
    if (!(await store.wasSent(plan.id, n, 'customer', 'completed'))) {
      await notify.sendCompleted(plan);
      await store.markSent(plan.id, n, 'customer', 'completed');
    }
    return { plan: plan.draft_name, action: 'completed' };
  }

  if (plan.change_pending) {
    const stop = await finishChange(plan, d, today, { dryRun });
    if (stop) return stop;
  }
  if (S.awaitingFinalPrice(plan)) {
    const stop = await finalStep(plan, d, today, { dryRun });
    if (stop) return stop;
  }

  const edited = await checkLines(plan, d, { dryRun });
  const kept = edited ? { fixes: [] } : await keepLockedPrices(plan, d, { dryRun });
  if (!dryRun) {
    // Keep the restore copy current (payments, tags), but never adopt pieces the plan is not for, nor
    // a line at a price other than the plan's.
    const snap = snapshotOf(d);
    if ((edited || kept.fixes.length) && plan.snapshot) { snap.line_items = plan.snapshot.line_items; snap.applied_discount = plan.snapshot.applied_discount; }
    await store.updatePlan(plan.id, { snapshot: snap });
  }

  const st = S.planState(plan, d.legs, today);
  // Five payments in: whatever the next link is for, it is for the whole balance (schedule.js).
  if (st.lastPayment) {
    if (st.dueNow > 0) st.dueNow = st.balance;
    if (st.upcoming) st.upcoming = { ...st.upcoming, amount: st.balance };
  }
  const out = { plan: plan.draft_name, k: st.k, dueNow: st.dueNow, upcoming: st.upcoming, balance: st.balance, sent: [] };
  const rows = [];
  if (edited) rows.push(digestRow(plan, d, n, st.k, today, st.dueNow, { overdue: true, stuck: true, note: 'Pieces changed without "Change product".' }));
  for (const f of kept.fixes) {
    rows.push(digestRow(plan, d, n, st.k, today, st.dueNow, { overdue: true, stuck: true, note: kept.error
      ? `${plan.draft_name}: ${f.title} was re-added at a different price, and putting the plan price back failed (${kept.error}). Fix the line by hand.`
      : `${plan.draft_name}: ${f.title} was re-added at a different price; the plan price was put back.` }));
    out.sent.push(`${dryRun ? 'would put back' : 'put back'} ${f.title} at Rs${f.to}`);
  }
  let linked = false;   // a link went (or, on a dry run, would go) to the customer in this pass

  // 6. Money arrived since the last confirmation.
  const acknowledged = Number(plan.acknowledged_paid) || 0;
  if (st.paid > acknowledged + 0.5) {
    if (!dryRun) {
      await notify.sendReceived(plan, d, st.paid - acknowledged, { today });
      await store.updatePlan(plan.id, { acknowledged_paid: st.paid });
    }
    out.sent.push(`received Rs${st.paid - acknowledged}`);
  }
  if (st.balance <= 0) {   // fully paid; staff complete the draft
    const owed = voucherDue(plan, st).amount;
    if (owed > 0) rows.push(digestRow(plan, d, n, st.k, today, owed, { overdue: true, stuck: true,
      note: `Paid ${owed.toLocaleString('en-IN')} more than the price. Offer a piece of higher value, or open Buy plan and press Issue voucher.` }));
    else if (!S.awaitingFinalPrice(plan) && !plan.change_pending) rows.push(digestRow(plan, d, n, n, today, st.total, { ready: true,
      note: 'Fully paid: convert the draft to an order.' }));
    return { ...out, digest: rows };
  }

  // Five payments in and the customer still holds a link for less than the balance (raised before the
  // fifth payment): replace it with one for the whole balance, once per balance.
  if (st.lastPayment && !st.closure.close) {
    const open = await store.latestOpenLink(plan.draft_order_id);
    const key = `buy_plan_lastlink_${plan.id}`;
    if (open && Number(open.amount) < st.balance && (await store.getConfigValue(key)) !== String(st.balance)) {
      const k = st.dueNow > 0 ? st.k : (st.upcoming ? st.upcoming.k : st.k);
      if (!dryRun) {
        const link = await createPlanLink(plan, st.balance);
        await notify.sendLink(plan, d, link, { k, dueDate: st.dates[k - 1], whole: true, today });
        await store.setConfigValue(key, String(st.balance));
      }
      out.sent.push(`last-payment link Rs${st.balance}`);
      linked = true;
    }
  }

  // 7. Closure.
  const c = st.closure;
  if (c.close) {
    if (dryRun) return { ...out, action: `would close the plan and issue a voucher for Rs${st.paid}` };
    const reason = c.overdueSince && S.addDays(c.overdueSince, S.CLOSE_AFTER_DAYS) <= today
      ? `no payment for ${S.CLOSE_AFTER_DAYS} days` : `not paid off ${S.LAST_CLOSE_AFTER_DAYS} days after the last installment`;
    const r = await forfeitPlan(plan, d, st, today, reason);
    return { ...out, action: `closed: ${reason}`, voucher: r.voucher ? r.voucher.code : null, voucherError: r.voucherError };
  }

  // 8. Closure warnings.
  if (c.warn && !(await store.wasSent(plan.id, c.warn.k, 'customer', c.warn.kind))) {
    if (!dryRun) {
      const link = await createPlanLink(plan, st.suggested);
      await notify.sendClosingSoon(plan, d, link, { closeOn: c.closeOn, lastInstallment: c.warn.kind.startsWith('last'), today });
      await store.markSent(plan.id, c.warn.k, 'customer', c.warn.kind);
    }
    linked = true;
    out.sent.push(`${c.warn.kind}: closes ${c.closeOn}`);
  }
  if (c.warn) rows.push(digestRow(plan, d, n, st.k, st.dates[st.k - 1], st.suggested, { overdue: true, closeOn: c.closeOn, note: `Closes on ${c.closeOn} unless paid` }));

  // 9. The next installment is due within 3 days. (A floating plan's last one gets its link from the
  // final pricing instead.)
  const up = st.upcoming;
  const unpriced = up && up.k === n && S.awaitingFinalPrice(plan);
  if (up && !unpriced && daysBetween(today, up.due) <= REMIND_DAYS_BEFORE) {
    if (!(await store.wasSent(plan.id, up.k, 'customer', 'due'))) {
      if (!dryRun) {
        const link = await createPlanLink(plan, up.amount);
        await notify.sendLink(plan, d, link, { k: up.k, dueDate: up.due, today });
        await store.markSent(plan.id, up.k, 'customer', 'due');
      }
      linked = true;
      out.sent.push(`due #${up.k} Rs${up.amount}`);
    }
    if (!c.warn) rows.push(digestRow(plan, d, n, up.k, up.due, up.amount));
  }

  // 10. The current installment is overdue.
  const dueOn = st.dates[st.k - 1];
  const late = daysBetween(dueOn, today);
  if (st.dueNow > 0 && late >= OVERDUE_AFTER_DAYS) {
    if (!(await store.wasSent(plan.id, st.k, 'customer', 'overdue'))) {
      if (!dryRun) {
        const link = await createPlanLink(plan, st.dueNow);
        await notify.sendLink(plan, d, link, { k: st.k, dueDate: dueOn, overdue: true, today });
        await store.markSent(plan.id, st.k, 'customer', 'overdue');
      }
      linked = true;
      out.sent.push(`overdue #${st.k} Rs${st.dueNow}`);
    }
    if (!c.warn) rows.push(digestRow(plan, d, n, st.k, dueOn, st.dueNow, { overdue: true }));
  }

  // 11. The link the customer holds lapses within 3 days (or has) and the installment is still unpaid:
  // a new one, once per expiring link (the marker names that link's expiry).
  const ask = st.dueNow > 0 ? { k: st.k, due: dueOn, amount: st.dueNow, overdue: late >= OVERDUE_AFTER_DAYS }
    : up && !unpriced && daysBetween(today, up.due) <= REMIND_DAYS_BEFORE ? { k: up.k, due: up.due, amount: up.amount, overdue: false }
    : null;
  if (ask && !linked) {
    const open = await store.latestOpenLink(plan.draft_order_id);
    const expires = open ? Date.parse(open.expires_at) : NaN;
    if (Number.isFinite(expires) && daysBetween(today, todayIst(expires)) <= RELINK_DAYS_BEFORE) {
      const key = `buy_plan_relink_${plan.id}`;
      const mark = `${ask.k}|${open.expires_at}`;
      if ((await store.getConfigValue(key)) !== mark) {
        if (!dryRun) {
          const link = await createPlanLink(plan, ask.amount);
          await notify.sendLink(plan, d, link, { k: ask.k, dueDate: ask.due, overdue: ask.overdue, relink: true, today });
          await store.setConfigValue(key, mark);
        }
        out.sent.push(`new link #${ask.k} Rs${ask.amount}`);
      }
    }
  }
  return { ...out, digest: rows };
}

// The plan a filter names: its draft number (D327, #D327) or its draft id.
const planMatches = (plan, only) => {
  const want = String(only).replace(/^#/, '').toUpperCase();
  return String(plan.draft_order_id) === want || String(plan.draft_name || '').replace(/^#/, '').toUpperCase() === want;
};

// only: run on that one plan (planMatches). A filtered run never sends or marks the daily digest —
// the store's real digest for the day must still go out — it just returns the rows.
async function runBuyPlanSweep({ dryRun = false, restore = null, now = Date.now(), only = null } = {}) {
  const today = todayIst(now);
  const plans = (await store.listActivePlans()).filter(p => !only || planMatches(p, only));
  if (only && !plans.length) throw Object.assign(new Error(`No active buy plan on ${only}`), { status: 404 });
  const results = [];
  const digestRows = [];
  for (const plan of plans) {
    try {
      const r = await sweepPlan(plan, today, { dryRun, restore });
      digestRows.push(...[].concat(r.digest || []));   // every issue on the plan, not just the first
      results.push(r);
    } catch (e) {
      // One bad plan must not stop the rest.
      log.error('buy-plan', `sweep ${plan.draft_name}: ${e.message}`);
      results.push({ plan: plan.draft_name, error: e.message });
    }
  }

  // Plans closed for non-payment whose voucher staff have not issued yet: on the digest every day.
  if (!only) {
    for (const plan of await store.listPlansByStatus('forfeited').catch(() => [])) {
      try {
        const d = await readDraft(plan.draft_order_id).catch(() => null);
        const legs = d ? d.legs : readInstallments((plan.snapshot || {}).metafields || {}).filter(l => l.type !== 'cad_advance');
        const owed = voucherDue(plan, S.planState(plan, legs, today), d).amount;
        if (owed > 0) digestRows.push(digestRow(plan, d || { id: plan.draft_order_id }, S.countOf(plan), 0, today, owed, { overdue: true, stuck: true,
          note: d ? `Closed: check the ${owed.toLocaleString('en-IN')} paid really came in, then open Buy plan and press Issue voucher. Do not delete the draft before.`
            : `Closed and the draft was deleted before its voucher was issued: create a voucher for ${owed.toLocaleString('en-IN')} by hand.` }));
      } catch (e) { log.error('buy-plan', `closed plan ${plan.draft_name}: ${e.message}`); }
    }
  }

  let digest = 'nothing due';
  if (digestRows.length && only) digest = `not sent on a single-plan run (${digestRows.length})`;
  else if (digestRows.length) {
    if ((await store.getConfigValue(DIGEST_KEY)) === today) digest = 'already sent today';
    else if (dryRun) digest = `would send (${digestRows.length})`;
    else {
      await notify.sendStaffDigest(digestRows, { today });
      await store.setConfigValue(DIGEST_KEY, today);
      digest = `sent (${digestRows.length})`;
    }
  }
  log.info('buy-plan', `sweep ${today}: ${plans.length} active plan(s), digest ${digest}`);
  return { today, plans: results, digest, digestRows: dryRun || only ? digestRows : undefined };
}

function startBuyPlanSweep(opts = {}) {
  const kick = () => runBuyPlanSweep(opts).catch(err => log.error('buy-plan', `sweep failed: ${err.message}`));
  setTimeout(kick, 150 * 1000);   // after the voucher / CAD / loyalty sweeps, so boot logs stay readable
  setInterval(kick, RUN_EVERY_MS);
}

module.exports = {
  runBuyPlanSweep, startBuyPlanSweep, sweepPlan, planMatches, finalStep, finishChange, followUp,
  keepLockedPrices, REMIND_DAYS_BEFORE, OVERDUE_AFTER_DAYS, FINAL_REPRICE_DAYS_BEFORE, RELINK_DAYS_BEFORE,
};
