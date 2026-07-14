/**
 * Timanti Reports — Google Apps Script
 * ─────────────────────────────────────
 * One sheet, one tab per report. A single "📊 Reports" menu drives every report the middleware
 * exposes; each menu item writes to its own named tab. Filter cells live at the top of each tab
 * (labels auto-laid on every run); the result table is written below them.
 *
 * Reports:
 *   Sales          GET /api/sales-report      — stitched line-item sales (drafts + orders), GST columns
 *   Adjustments    GET /api/adjustment-report — per-order sales/adjustment breakdown, GST columns
 *   Payment Recon  GET /api/recon             — bank↔order payment reconciliation (Pine/GoKwik)
 *   Credit Ledger  GET /api/recon-ledger      — voucher/exchange-note lifecycle (summary/outstanding/tieout)
 *   Serial         GET /api/serial-report     — per-serial list from the serial ledger
 *   Counters       GET /api/serial-counters   — current counter per use case (next number)
 *
 * Setup (one-time): Extensions → Apps Script → paste this file → Save → reload the sheet.
 * Then pick "📊 Reports" → any report. The first run of each creates its tab and lays out the filters.
 */

const MIDDLEWARE_URL = 'https://timanti-middleware.fly.dev'; // update if the Fly URL changes

// Each report: the tab it writes to, its endpoint, the filter cells it reads (label + query param,
// laid out top-to-bottom from row 1), and an explicit column order (omit → derive from the JSON keys).
const REPORTS = {
  sales: {
    tab: 'Sales', endpoint: '/api/sales-report',
    filters: [
      { label: 'From (YYYY-MM-DD)', param: 'from', required: true },
      { label: 'To (YYYY-MM-DD)',   param: 'to',   required: true },
      { label: 'State (opt)',       param: 'state' },
      { label: 'Stage (opt)',       param: 'paymentStatus' },
    ],
    cols: ['stage','draft_name','order_name','day','customer','place_of_supply','shipping_state',
           'product_title','variant_title','sku','hsn','qty','gross_sales','discount','net_sales',
           'taxable_value','igst','sgst','cgst','custom_serial','amount_paid','amount_pending',
           'net_to_collect','payment_mode'],
  },
  adjustments: {
    tab: 'Adjustments', endpoint: '/api/adjustment-report', totals: true,
    filters: [
      { label: 'From (YYYY-MM-DD)', param: 'from', required: true },
      { label: 'To (YYYY-MM-DD)',   param: 'to',   required: true },
    ],
    cols: ['name','created_at','customer','place_of_supply','shipping_state','custom_serial','hsn',
           'qty','gross_value','discount_applied','taxable_value','igst','sgst','cgst','voucher_value',
           'exchange_note_value','old_gold_value','advance','amount_to_be_collected','amount_paid','total_price'],
  },
  recon: {
    tab: 'Payment Recon', endpoint: '/api/recon', extraQp: 'format=json',
    filters: [], // reads the fixed Recon Test file set on the server
  },
  ledger: {
    tab: 'Credit Ledger', endpoint: '/api/recon-ledger',
    filters: [
      { label: 'View (summary|outstanding|tieout)', param: 'view' },
      { label: 'Type (opt)', param: 'type' },
      { label: 'From (opt)', param: 'from' },
      { label: 'To (opt)',   param: 'to' },
    ],
  },
  serial: {
    tab: 'Serial', endpoint: '/api/serial-report',
    filters: [
      { label: 'Doc Type (opt)', param: 'docType' },
      { label: 'State (opt)',    param: 'state' },
      { label: 'Status (opt)',   param: 'status' },
      { label: 'From (opt)',     param: 'from' },
      { label: 'To (opt)',       param: 'to' },
    ],
    cols: ['resource','name','created_at','customer','total','document_type','state_code',
           'serial_no','serial_code','serial_display','status','cancelled_at'],
  },
  counters: {
    tab: 'Counters', endpoint: '/api/serial-counters',
    filters: [
      { label: 'State (opt)',    param: 'state' },
      { label: 'Doc Type (opt)', param: 'docType' },
    ],
    cols: ['use_case','doc_type','store_code','fy','code_prefix','current_value','next_value',
           'minted_count','cancelled_count','last_minted_at'],
  },
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📊 Reports')
    .addItem('Sales', 'reportSales')
    .addItem('Adjustments', 'reportAdjustments')
    .addItem('Payment Recon', 'reportRecon')
    .addItem('Credit Ledger', 'reportLedger')
    .addItem('Serial', 'reportSerial')
    .addItem('Counters', 'reportCounters')
    .addToUi();
}

function reportSales()       { generate_('sales'); }
function reportAdjustments() { generate_('adjustments'); }
function reportRecon()       { generate_('recon'); }
function reportLedger()      { generate_('ledger'); }
function reportSerial()      { generate_('serial'); }
function reportCounters()    { generate_('counters'); }

function fmtDate_(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone() || 'Asia/Kolkata', 'yyyy-MM-dd');
  }
  return String(v).trim();
}

// Only from/to are treated as dates; everything else (state, docType, view…) stays a plain string.
function isDateParam_(p) { return p === 'from' || p === 'to'; }

// YYYY-MM-DD for N days ago (0 = today), in the sheet's timezone.
function isoDaysAgo_(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'Asia/Kolkata', 'yyyy-MM-dd');
}

// The generic runner: ensure the tab, lay out filter labels, read filter values, fetch, write.
function generate_(key) {
  const cfg = REPORTS[key];
  const ui  = SpreadsheetApp.getUi();
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const sh  = ss.getSheetByName(cfg.tab) || ss.insertSheet(cfg.tab);

  // Pass 1: write EVERY filter label in col A first, so all inputs are visible at once
  // (do not bail mid-loop, or later fields like To/State never get laid out).
  for (let i = 0; i < cfg.filters.length; i++) {
    sh.getRange(i + 1, 1).setValue(cfg.filters[i].label).setFontWeight('bold');
  }
  SpreadsheetApp.flush();

  // Pass 2: read col B. Required date fields (from/to) auto-fill to a last-30-days range and are
  // written back into the cell so the report always runs and you can see/adjust the range.
  const params = {};
  const missing = [];
  for (let i = 0; i < cfg.filters.length; i++) {
    const f = cfg.filters[i];
    const raw = sh.getRange(i + 1, 2).getValue();
    let val = isDateParam_(f.param) ? fmtDate_(raw) : String(raw == null ? '' : raw).trim();
    if (!val && f.required) {
      if (isDateParam_(f.param)) { val = (f.param === 'from') ? isoDaysAgo_(30) : isoDaysAgo_(0); sh.getRange(i + 1, 2).setValue(val); }
      else { missing.push(f.label + ' (cell B' + (i + 1) + ')'); }
    }
    if (val) params[f.param] = val;
  }
  if (missing.length) { ui.alert('Fill these, then run again:\n• ' + missing.join('\n• ')); return; }

  const parts = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); });
  if (cfg.extraQp) parts.push(cfg.extraQp);
  const url = MIDDLEWARE_URL + cfg.endpoint + (parts.length ? '?' + parts.join('&') : '');

  let body;
  try {
    const res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) { ui.alert('Report failed: ' + res.getResponseCode() + '\n' + res.getContentText()); return; }
    body = JSON.parse(res.getContentText());
  } catch (e) { ui.alert('Report failed: ' + e.message); return; }

  let rows = (body && body.rows) || [];
  if (cfg.totals && body && body.totals) rows = rows.concat([body.totals]);

  // Columns: explicit order when configured, else the keys of the first row.
  const cols = cfg.cols || (rows.length ? Object.keys(rows[0]) : []);
  const startRow = cfg.filters.length + 2; // one blank line between filters and the table

  const lastRow = sh.getLastRow();
  if (lastRow >= startRow) sh.getRange(startRow, 1, lastRow - startRow + 1, Math.max(cols.length, 30)).clearContent();

  if (!cols.length || !rows.length) {
    sh.getRange(startRow, 1).setValue('No records.');
    ui.alert('Report complete — 0 records.');
    return;
  }

  sh.getRange(startRow, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
  const matrix = rows.map(function (r) { return cols.map(function (c) { return r[c] != null ? r[c] : ''; }); });
  sh.getRange(startRow + 1, 1, matrix.length, cols.length).setValues(matrix);
  if (cfg.totals && body && body.totals) {
    sh.getRange(startRow + matrix.length, 1, 1, cols.length).setFontWeight('bold'); // TOTAL row
  }
  ui.alert('"' + cfg.tab + '" complete — ' + (body && body.count != null ? body.count : rows.length) + ' record(s).');
}
