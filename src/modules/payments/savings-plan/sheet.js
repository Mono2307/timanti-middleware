'use strict';

// The savings-plan tracker: one row per plan on a "Savings Plans" tab of the same Google Sheet as the
// buy-plan tracker (services/buy-plan-sheet/apps-script.gs.js writes whichever tab the push names).
// Pushed every 10 minutes while savings plans are switched on, and right after a plan starts or a
// voucher is issued. A view only: nothing reads it back; a failed push waits for the next one.

const axios = require('axios');
const { config } = require('../../../core/config');
const { log } = require('../../../core/logger');
const R = require('./rules');
const store = require('./store');
const { readDraft, todayIst, adminDraftUrl } = require('./draft');

const TAB = 'Savings Plans';
const EVERY_MS = 10 * 60 * 1000;
const COLUMNS = ['Draft', 'Customer', 'Phone', 'Email', 'Months', 'Instalment', 'Start', 'Matures',
  'Saved', 'Instalments paid', 'Late payments', 'Next due', 'Next amount', 'Status', 'Closes on',
  'Redeem now', 'Voucher', 'Draft link', 'Updated'];
const STATUS = { completed: 'Completed (voucher issued)', terminated: 'Closed (voucher, no bonus)', redeemed: 'Voucher used up', cancelled: 'Cancelled' };

// Pure: one sheet row from a plan, its payments (the draft's legs, or none if the draft was not read).
function rowFor(plan, legs, today) {
  const st = R.savingsState(plan, legs || [], today);
  const active = plan.status === 'active';
  const status = !active ? (STATUS[plan.status] || plan.status)
    : st.fullyPaid ? 'Fully paid: issue the voucher'
    : st.overdueDays > 0 ? `Late ${st.overdueDays} days`
    : 'On track';
  const voucher = plan.voucher_code && plan.voucher_code !== 'ISSUING' ? `${plan.voucher_code} (Rs${Math.round(plan.voucher_value)})` : '';
  return [
    plan.draft_name, plan.customer_name || '', plan.customer_phone || '', plan.customer_email || '',
    plan.months, Math.round(plan.instalment), plan.start_date, st.maturity,
    active ? st.paid : Math.round(plan.paid_at_end ?? st.paid), st.paidCount, active ? st.lateCount : (plan.late_count ?? st.lateCount),
    active && st.next ? st.next.due : '', active && st.next ? st.A : '',
    status, active && st.overdueDays > 0 ? st.closeOn : '',
    active && st.redeem.kind !== 'none' ? `Rs${st.redeem.value} (${st.redeem.kind})` : '',
    voucher, adminDraftUrl(plan.draft_order_id), new Date().toISOString(),
  ];
}

async function buildTable(now = Date.now()) {
  const today = todayIst(now);
  const rows = [];
  for (const status of ['active', 'completed', 'terminated', 'redeemed']) {
    for (const plan of await store.listPlansByStatus(status)) {
      // Ended plans are not re-read from Shopify: their figures are on the plan row.
      const d = status === 'active' ? await readDraft(plan.draft_order_id).catch(() => null) : null;
      rows.push(rowFor(plan, d ? d.legs : [], today));
    }
  }
  rows.sort((a, b) => String(b[6]).localeCompare(String(a[6])));   // newest start first
  return { tab: TAB, columns: COLUMNS, rows };
}

async function pushToSheet() {
  const url = config.appsScript.buyPlan;
  if (!url) return { ok: false, skipped: 'BUY_PLAN_SHEET_URL not set' };
  const table = await buildTable();
  const res = await axios.post(url, { secret: config.appsScript.buyPlanSecret || '', ...table },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
  if (!res.data?.ok) throw new Error(`sheet said: ${JSON.stringify(res.data).slice(0, 200)}`);
  return { ok: true, rows: table.rows.length };
}

let pending = null;
function pushSoon() {
  if (pending || !config.savingsPlan.enabled || !config.appsScript.buyPlan) return;
  pending = setTimeout(() => {
    pending = null;
    pushToSheet().catch(e => log.error('savings-plan', `sheet push: ${e.message}`));
  }, 20000);
  if (typeof pending.unref === 'function') pending.unref();
}

function startSheetSync() {
  if (!config.appsScript.buyPlan) { log.info('savings-plan', 'tracker sheet off (BUY_PLAN_SHEET_URL not set)'); return; }
  const t = setInterval(() => pushToSheet().catch(e => log.error('savings-plan', `sheet push: ${e.message}`)), EVERY_MS);
  if (typeof t.unref === 'function') t.unref();
  pushSoon();
}

module.exports = { rowFor, buildTable, pushToSheet, pushSoon, startSheetSync, COLUMNS, TAB };
