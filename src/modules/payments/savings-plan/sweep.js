'use strict';

// Savings plan — the sweep. Runs every 6 hours, like the buy plan's; every message is guarded by a
// sent-marker, so running more often only means a reminder is never more than a few hours late.
// Vouchers are never issued here: when one is due the store is prompted (end.js).
//
// Per active plan, in order:
//   1. draft gone / converted     → the store is told, once (a savings draft must never convert)
//   2. new money since last time  → "payment received"; a payment that is not a whole number of
//                                   instalments goes on the digest for staff to check
//   3. fully paid                 → at the maturity date: "your plan is complete" to the customer, "issue
//                                   the voucher" to the store. Before it (prepaid): "the bonus comes on …"
//   4. two late in a row          → terminated (end.js): the second late instalment 8 days past its due date
//   5. late / closing             → a warning when the next instalment becomes late (due + 8), and again
//                                   5 days before the plan would close, with a fresh link
//   6. a 10-month plan reaches its month-6 / month-8 step → "you can redeem early"
//   7. next instalment due within 3 days → a GoKwik link for it, email + SMS
//   8. 3+ days overdue            → one overdue reminder with a link
// Then one staff digest a day: overdue plans, plans to issue a voucher on, payments to check.

const { log } = require('../../../core/logger');
const { createPlanLink } = require('../buy-plan/links');
const R = require('./rules');
const store = require('./store');
const notify = require('./notify');
const { terminatePlan, CLAIM } = require('./end');
const { readDraft, todayIst, adminDraftUrl } = require('./draft');
const { restoreDeletedSavingsDraft, takeSnapshot } = require('./restore');
const { daysBetween } = R;

const REMIND_DAYS_BEFORE = 3;
const OVERDUE_AFTER_DAYS = 3;
const DIGEST_KEY = 'savings_plan_digest_last';
const RUN_EVERY_MS = 6 * 60 * 60 * 1000;
// A plan started with a past start date is left alone by the automatic check for its first 24 hours,
// so staff can record the payments already made before it chases or closes anything. A check run on
// that one plan (the screen's Run check now, or the operator's draft= run) does not wait.
const BACKDATED_HOLD_MS = 24 * 60 * 60 * 1000;
const onHold = (plan, now) => {
  const made = Date.parse(plan.created_at || '');
  if (!Number.isFinite(made) || now - made >= BACKDATED_HOLD_MS) return false;
  return String(plan.start_date).slice(0, 10) < todayIst(made);
};

const rupees = (n) => `Rs${Math.round(Number(n || 0)).toLocaleString('en-IN')}`;
const digestRow = (plan, note, waText = null) => ({
  draftName: plan.draft_name, adminUrl: adminDraftUrl(plan.draft_order_id),
  customerName: plan.customer_name, phone: plan.customer_phone, note,
  waUrl: waText ? notify.whatsappToCustomer(plan, waText) : null,
});
const link = (plan, amount) => createPlanLink(plan, amount, { installmentType: 'savings_plan', reuse: true });

// What a link should ask for now: everything due and unpaid, or the next instalment (less any part
// payment already towards it).
const linkAmount = (st) => (st.dueNow > 0 ? st.dueNow : Math.max(0, st.A - (st.paid - st.paidCount * st.A)));

async function once(plan, k, audience, kind, dryRun, send) {
  if (await store.wasSent(plan.id, k, audience, kind)) return false;
  if (dryRun) return true;
  await send();
  await store.markSent(plan.id, k, audience, kind);
  return true;
}

async function sweepPlan(plan, today, { dryRun }) {
  const out = { plan: plan.draft_name, sent: [], digest: [] };
  const d = await readDraft(plan.draft_order_id);
  // Deleted (the delete webhook normally got there first): rebuilt if it held money, else cancelled.
  if (!d) {
    if (dryRun) return { ...out, action: 'draft deleted — would restore it (money on it) or cancel the plan (nothing paid)' };
    const r = await restoreDeletedSavingsDraft(plan.draft_order_id).catch(e => ({ error: e.message }));
    if (r?.error) log.error('savings-plan', `${plan.draft_name}: restore: ${r.error}`);
    return { ...out, action: r?.cancelled ? 'draft deleted with nothing paid — plan cancelled'
      : r?.rebuilt ? `draft deleted — restored as ${r.newName}` : `draft deleted — ${r?.error || 'not rebuilt, store and HQ told'}` };
  }
  if (d.draft.status === 'completed') {
    const what = 'was converted to an order';
    await once(plan, 0, 'staff', d ? 'converted' : 'missing', dryRun, () => notify.toStore(plan, d, {
      subject: `the draft ${what}`, heading: `the savings draft ${what}`,
      body: `A savings plan draft must stay a draft until its voucher is used. Its payments are the plan's record. Tell HQ: the plan has stopped sending reminders.`,
    }));
    out.digest.push(digestRow(plan, `The draft ${what}. Tell HQ.`));
    return { ...out, action: `draft ${what}` };
  }
  if (!dryRun) {
    await store.syncContact(plan, d.customer);
    await takeSnapshot(plan, d);
  }
  const st = R.savingsState(plan, d.legs, today);
  Object.assign(out, { paid: st.paid, paidCount: st.paidCount, lateCount: st.lateCount, next: st.next });

  // 2. New money.
  const acknowledged = Number(plan.acknowledged_paid) || 0;
  if (st.paid > acknowledged + 0.5) {
    if (!dryRun) {
      await notify.sendReceived(plan, d, st, st.paid - acknowledged);
      await store.updatePlan(plan.id, { acknowledged_paid: st.paid });
    }
    out.sent.push(`received ${rupees(st.paid - acknowledged)}`);
  }
  for (const p of st.oddPayments) {
    out.digest.push(digestRow(plan, `Payment ${p.slot} is ${rupees(p.value)}, not a whole number of ${rupees(st.A)} instalments. Check it was typed correctly.`));
  }
  if (st.overpaid > 0) out.digest.push(digestRow(plan, `Paid ${rupees(st.overpaid)} more than the plan. It goes on the voucher; check it was meant.`));

  // 3. Fully paid. On or after the maturity date: the customer is told, the store issues the voucher
  //    with the full bonus. Before it (prepaid): the bonus waits for the maturity date (founder, 23 Nov
  //    2026), so the customer is told that once and nothing is issued yet.
  if (st.fullyPaid) {
    if (st.redeem.kind !== 'full') {
      if (await once(plan, st.n, 'customer', 'prepaid', dryRun, () => notify.sendPrepaid(plan, d, st))) out.sent.push('prepaid');
      return { ...out, action: `fully paid ahead — the full bonus is due on ${st.maturity}` };
    }
    if (await once(plan, st.n, 'customer', 'fullypaid', dryRun, () => notify.sendFullyPaid(plan, d, st))) out.sent.push('fully paid');
    await once(plan, st.n, 'staff', 'fullypaid', dryRun, () => notify.toStore(plan, d, {
      subject: 'fully paid — issue the voucher', heading: 'fully paid',
      body: 'Every instalment is paid and the plan has reached its maturity date. Check the payments, then open the savings plan screen and press Issue voucher.',
      facts: [{ label: 'Paid', value: rupees(st.paid) }, { label: 'Late payments', value: String(st.lateCount) },
        { label: 'Voucher', value: rupees(st.redeem.value) }],
    }));
    out.digest.push(digestRow(plan, `Fully paid: issue the Savings Scheme Voucher (${rupees(st.redeem.value)}).`));
    return { ...out, action: 'fully paid — voucher to issue' };
  }

  // 4. Termination: two instalments in a row late.
  if (st.terminateNow) {
    const why = notify.closedWhy(st);
    if (dryRun) return { ...out, action: `would terminate: ${why}` };
    await terminatePlan(plan, d, st, today, why);
    return { ...out, action: 'terminated' };
  }

  // 5. Late warnings: the next instalment has become late; the plan closes within a few days.
  if (st.warn) {
    const earlyNow = st.redeem.kind === 'early' ? st.redeem : null;
    if (await once(plan, st.next.k, 'customer', st.warn, dryRun, async () => {
      const l = await link(plan, linkAmount(st));
      await notify.sendLateWarning(plan, d, st, l, { kind: st.warn, closeOn: st.closeOn, earlyNow });
    })) out.sent.push(st.warn);
  }

  // 6. Early-redemption step reached (10-month plans).
  if (st.redeem.kind === 'early') {
    const kind = `early${st.paidCount >= 7 ? 50 : 25}`;
    const k = st.paidCount >= 7 ? 8 : 6;
    if (await once(plan, k, 'customer', kind, dryRun, () => notify.sendEarlyOpen(plan, d, st))) out.sent.push(kind);
  }

  // 7. Due soon / 8. overdue.
  const toDue = daysBetween(today, st.next.due);
  if (toDue >= 0 && toDue <= REMIND_DAYS_BEFORE) {
    if (await once(plan, st.next.k, 'customer', 'due', dryRun, async () => {
      const l = await link(plan, linkAmount(st));
      await notify.sendDue(plan, d, st, l, { k: st.next.k, dueDate: st.next.due });
    })) out.sent.push(`due ${st.next.k}`);
  } else if (st.overdueDays >= OVERDUE_AFTER_DAYS && !st.warn) {
    if (await once(plan, st.next.k, 'customer', 'overdue', dryRun, async () => {
      const l = await link(plan, linkAmount(st));
      await notify.sendDue(plan, d, st, l, { k: st.next.k, dueDate: st.next.due, overdue: true });
    })) out.sent.push(`overdue ${st.next.k}`);
  }
  if (st.overdueDays >= OVERDUE_AFTER_DAYS) {
    const onTimeBy = R.addDays(st.next.due, R.LATE_GRACE_DAYS);
    const lateNote = today > onTimeBy ? 'It is now a late payment.' : `Paid by ${onTimeBy} it still counts as on time.`;
    out.digest.push(digestRow(plan,
      `Instalment ${st.next.k} (${rupees(linkAmount(st))}) is ${st.overdueDays} days overdue. ${lateNote} The plan closes on ${st.closeOn} if nothing more is paid.`,
      `Hello ${plan.customer_name || ''}, this is Timanti. Instalment ${st.next.k} of your savings plan (${plan.draft_name}), ${rupees(linkAmount(st))}, was due on ${st.next.due}. The payment link is in your email. `
        + (today > onTimeBy ? `Please pay before ${R.addDays(st.closeOn, -1)} to keep your plan.` : `Please pay by ${onTimeBy} so it counts as on time.`)));
  }
  return out;
}

function planMatches(plan, only) {
  const want = String(only).trim().replace(/^#/, '').toUpperCase();
  return String(plan.draft_order_id) === want || String(plan.draft_name || '').replace(/^#/, '').toUpperCase() === want;
}

async function runSavingsSweep({ dryRun = false, now = Date.now(), only = null } = {}) {
  const today = todayIst(now);
  const plans = (await store.listPlansByStatus('active')).filter(p => !only || planMatches(p, only));
  if (only && !plans.length) throw Object.assign(new Error(`No active savings plan on ${only}`), { status: 404 });
  const results = [];
  const rows = [];
  for (const plan of plans) {
    if (!only && onHold(plan, now)) {
      results.push({ plan: plan.draft_name, action: 'backdated today: the automatic check starts 24 hours after it was set up' });
      continue;
    }
    try {
      const r = await sweepPlan(plan, today, { dryRun });
      rows.push(...r.digest);
      results.push(r);
    } catch (e) {
      log.error('savings-plan', `sweep ${plan.draft_name}: ${e.message}`);
      results.push({ plan: plan.draft_name, error: e.message });
    }
  }
  // Terminated plans whose voucher is still to issue: on the digest every day.
  if (!only) {
    for (const plan of await store.listPlansByStatus('terminated').catch(() => [])) {
      if (!plan.voucher_code || plan.voucher_code === CLAIM) rows.push(digestRow(plan, 'Closed: check the payments, then press Issue voucher on the savings plan screen.'));
    }
  }

  let digest = 'nothing due';
  if (rows.length && only) digest = `not sent on a single-plan run (${rows.length})`;
  else if (rows.length) {
    if ((await store.getConfigValue(DIGEST_KEY)) === today) digest = 'already sent today';
    else if (dryRun) digest = `would send (${rows.length})`;
    else {
      await notify.sendDigest(rows, { today });
      await store.setConfigValue(DIGEST_KEY, today);
      digest = `sent (${rows.length})`;
    }
  }
  log.info('savings-plan', `sweep ${today}: ${plans.length} active plan(s), digest ${digest}`);
  return { today, plans: results, digest, digestRows: dryRun || only ? rows : undefined };
}

function startSavingsSweep() {
  const kick = () => runSavingsSweep().catch(err => log.error('savings-plan', `sweep failed: ${err.message}`));
  setTimeout(kick, 180 * 1000);   // after the buy-plan sweep
  setInterval(kick, RUN_EVERY_MS);
}

module.exports = { runSavingsSweep, startSavingsSweep, sweepPlan, planMatches, linkAmount, onHold, REMIND_DAYS_BEFORE, OVERDUE_AFTER_DAYS, BACKDATED_HOLD_MS };
