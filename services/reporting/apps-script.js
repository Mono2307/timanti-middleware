/**
 * Serial Reports — Google Apps Script
 * ───────────────────────────────────
 * Sheet-driven report generator for the serialization system. Staff fill the
 * input cells and pick a menu action; this calls the middleware's
 * GET /api/serial-report and writes the result table — no hand-built URLs.
 *
 * Setup (one-time):
 *   1. Open the "Serial Reports" Google Sheet → Extensions → Apps Script.
 *   2. Paste this file → Save → reload the sheet.
 *   3. Lay out the input cells on the active sheet (labels in col A, inputs in col B):
 *        A1 Resource   B1  both | orders | draft_orders
 *        A2 Doc Type   B2  (blank=all) customer_order | repair | po | memo | transfer | credit_note
 *        A3 State      B3  (blank=all) KA | MH | ...
 *        A4 From       B4  date (optional)
 *        A5 To         B5  date (optional)
 *      The report table is written starting at row 8.
 */

const MIDDLEWARE_URL = 'https://timanti-middleware.fly.dev'; // update if the Fly URL changes
const OUTPUT_START_ROW = 8;

const REPORT_COLS = [
  'resource', 'name', 'created_at', 'customer', 'total',
  'document_type', 'state_code', 'store_code', 'serial_no', 'serial_code', 'serial_display'
];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📊 Serial Reports')
    .addItem('Generate Report', 'generateReport')
    .addItem('Set Up Input Cells', 'setupInputCells')
    .addToUi();
}

function setupInputCells() {
  const sh = SpreadsheetApp.getActiveSheet();
  const labels = [['Resource', 'both'], ['Doc Type', ''], ['State', ''], ['From', ''], ['To', '']];
  sh.getRange(1, 1, labels.length, 2).setValues(labels);
  sh.getRange('A1:A5').setFontWeight('bold');
  SpreadsheetApp.getUi().alert('Input cells laid out in A1:B5. Fill them, then run "Generate Report".');
}

function fmtDate(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone() || 'Asia/Kolkata', 'yyyy-MM-dd');
  }
  return String(v).trim();
}

function generateReport() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();

  const params = {
    resource: String(sh.getRange('B1').getValue() || 'both').trim() || 'both',
    docType:  String(sh.getRange('B2').getValue() || '').trim(),
    state:    String(sh.getRange('B3').getValue() || '').trim(),
    from:     fmtDate(sh.getRange('B4').getValue()),
    to:       fmtDate(sh.getRange('B5').getValue()),
  };

  const qp = Object.keys(params)
    .filter(k => params[k])
    .map(k => k + '=' + encodeURIComponent(params[k]))
    .join('&');

  let body;
  try {
    const res = UrlFetchApp.fetch(MIDDLEWARE_URL + '/api/serial-report?' + qp, {
      method: 'get', muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      ui.alert('Report failed: middleware returned ' + res.getResponseCode() + '\n' + res.getContentText());
      return;
    }
    body = JSON.parse(res.getContentText());
  } catch (e) {
    ui.alert('Report failed: ' + e.message);
    return;
  }

  const rows = (body && body.rows) || [];

  // Clear any previous output below the input block.
  const lastRow = sh.getLastRow();
  if (lastRow >= OUTPUT_START_ROW) {
    sh.getRange(OUTPUT_START_ROW, 1, lastRow - OUTPUT_START_ROW + 1, REPORT_COLS.length).clearContent();
  }

  // Header.
  sh.getRange(OUTPUT_START_ROW, 1, 1, REPORT_COLS.length).setValues([REPORT_COLS]).setFontWeight('bold');

  if (!rows.length) {
    sh.getRange(OUTPUT_START_ROW + 1, 1).setValue('No matching records.');
    ui.alert('Report complete — 0 records.');
    return;
  }

  const matrix = rows.map(r => REPORT_COLS.map(c => r[c] != null ? r[c] : ''));
  sh.getRange(OUTPUT_START_ROW + 1, 1, matrix.length, REPORT_COLS.length).setValues(matrix);

  ui.alert('Report complete — ' + rows.length + ' record(s) written.');
}
