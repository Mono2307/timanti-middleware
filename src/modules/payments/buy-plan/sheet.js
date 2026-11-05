'use strict';
// The buy-plan tracker sheet (founder, 2026-11-05): one row per plan with the customer, the draft,
// the plan, what is paid and owed, what is next and its status. The middleware pushes the whole table
// to an Apps Script web app (services/buy-plan-sheet/apps-script.gs.js) every 10 minutes and right
// after a payment or a plan change, so the sheet is never more than minutes behind. The sheet is a
// view: nothing reads it back, and a failed push just waits for the next one.

const axios = require('axios');
const { supabase } = require('../../../core/supabase');
const { config } = require('../../../core/config');
const { log } = require('../../../core/logger');
const S = require('./schedule');
const { readDraft, todayIst, adminDraftUrl } = require('./draft');

const EVERY_MS = 10 * 60 * 1000;
const COLUMNS = ['Draft', 'Customer', 'Phone', 'Email', 'Plan', 'Installments', 'Start', 'Last due',
  'Plan total', 'Paid', 'Balance', 'Next due', 'Next amount', 'Due now', 'Status', 'Closes on', 'Warning',
  'Voucher', 'Payments', 'Draft link', 'Updated'];

const STATUS = { active: 'Active', completed: 'Completed', forfeited: 'Closed (voucher)', cancelled: 'Cancelled' };

// Pure: one sheet row from a plan, its live payments (legs) and today.
function rowFor(plan, legs, today, draftExists = true) {
  const st = S.planState(plan, legs || [], today);
  const overdue = st.rows.some(r => r.status === 'missed' || r.status === 'overdue');
  let status = STATUS[plan.status] || plan.status;
  if (plan.status === 'active') {
    if (!draftExists) status = 'Active: draft missing';
    else if (plan.change_pending) status = 'Active: product change pricing';
    else if (st.closure?.warn) status = `Active: closing ${st.closure.closeOn}`;
    else if (overdue) status = 'Active: overdue';
    else status = 'Active: on track';
  }
  return [
    plan.draft_name, plan.customer_name || '', plan.customer_phone || '', plan.customer_email || '',
    plan.mode === 'gold' ? 'Gold value lock' : 'Equal', st.n, plan.start_date, st.dates[st.n - 1] || '',
    st.total, st.paid, st.balance,
    plan.status === 'active' && st.upcoming ? st.upcoming.due : '', plan.status === 'active' && st.upcoming ? st.upcoming.amount : '',
    plan.status === 'active' ? st.dueNow : '',
    // The close date only matters once a payment is late.
    status, plan.status === 'active' && (overdue || st.closure?.warn) ? (st.closure?.closeOn || '') : '', st.closure?.warn?.kind || '',
    plan.voucher_code ? `${plan.voucher_code} (Rs${plan.voucher_value})` : '',
    (legs || []).length, adminDraftUrl(plan.draft_order_id), new Date().toISOString(),
  ];
}

async function buildTable(now = Date.now()) {
  const { data, error } = await supabase.from('buy_plans').select('*').order('id', { ascending: false });
  if (error) throw new Error(`buy_plans list: ${error.message}`);
  const today = todayIst(now);
  const rows = [];
  for (const plan of data || []) {
    // Closed plans are not re-read from Shopify: their draft may be gone and their numbers are final.
    const d = plan.status === 'active' ? await readDraft(plan.draft_order_id).catch(() => null) : null;
    const legs = d ? d.legs : ((plan.snapshot || {}).legs || []);
    rows.push(rowFor(plan, legs, today, plan.status !== 'active' || Boolean(d)));
  }
  return { columns: COLUMNS, rows };
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

// Debounced, so a burst of payments is one push.
let pending = null;
function pushSoon() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    pushToSheet().catch(e => log.error('buy-plan', `sheet push: ${e.message}`));
  }, 20000);
  if (typeof pending.unref === 'function') pending.unref();
}

function startSheetSync() {
  if (!config.appsScript.buyPlan) { log.info('buy-plan', 'tracker sheet off (BUY_PLAN_SHEET_URL not set)'); return; }
  const t = setInterval(() => pushToSheet().catch(e => log.error('buy-plan', `sheet push: ${e.message}`)), EVERY_MS);
  if (typeof t.unref === 'function') t.unref();
  pushSoon();
}

module.exports = { rowFor, buildTable, pushToSheet, pushSoon, startSheetSync, COLUMNS };
