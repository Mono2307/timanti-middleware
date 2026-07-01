/**
 * Credit-Instrument Recon — Google Apps Script
 * ────────────────────────────────────────────
 * Sheet-driven reconciliation report over the middleware's credit_instruments ledger
 * (Exchange Notes + Vouchers). Paste into the Recon sheet → Extensions → Apps Script.
 *
 * Two things this does:
 *   1. Generate Report  → GET /api/recon-ledger (summary | outstanding | tieout), writes the table.
 *   2. Backfill Ledger  → reads the existing "Voucher Log" / "Exchange Log" tabs and POSTs each row
 *                         to /api/credit-instrument/issue so historical instruments enter the ledger.
 *                         The endpoint is idempotent (upsert) — safe to re-run.
 *
 * Setup (one-time):
 *   1. Extensions → Apps Script → paste this file → Save → reload the sheet.
 *   2. "📒 Recon" → "Set Up Input Cells".  Fill B1..B4, then "Generate Report".
 *      A1 View   B1  summary | outstanding | tieout
 *      A2 Type   B2  (blank=all) voucher | exchange_note
 *      A3 From   B3  date (optional, on issued_at)
 *      A4 To     B4  date (optional)
 *   Report table is written starting at row 8.
 */

const MIDDLEWARE_URL  = 'https://timanti-middleware.fly.dev'; // update if the Fly URL changes
const OUTPUT_START_ROW = 8;

const VIEW_COLS = {
  summary:     ['instrument_type','month','issued_count','issued_value','redeemed_count','redeemed_value',
                'outstanding_count','outstanding_value','voided_count','voided_value','expired_count','expired_value','balances'],
  outstanding: ['instrument_type','serial_code','value','customer_name','source_order_name','issued_at','expires_at','days_to_expiry'],
  tieout:      ['instrument_type','serial_code','value','customer_name','source_order_name','target_order_name','target_draft_id','redeemed_at'],
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📒 Recon')
    .addItem('Generate Report', 'generateReconReport')
    .addItem('Set Up Input Cells', 'setupReconInputCells')
    .addSeparator()
    .addItem('Backfill Ledger from Logs', 'backfillLedgerFromLogs')
    .addToUi();
}

function setupReconInputCells() {
  const sh = SpreadsheetApp.getActiveSheet();
  const labels = [['View', 'summary'], ['Type', ''], ['From', ''], ['To', '']];
  sh.getRange(1, 1, labels.length, 2).setValues(labels);
  sh.getRange('A1:A4').setFontWeight('bold');
  SpreadsheetApp.getUi().alert('Input cells laid out in A1:B4. Fill them, then run "Generate Report".');
}

function fmtDate_(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone() || 'Asia/Kolkata', 'yyyy-MM-dd');
  }
  return String(v).trim();
}

function generateReconReport() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();

  const view = String(sh.getRange('B1').getValue() || 'summary').trim().toLowerCase() || 'summary';
  const params = {
    view: view,
    type: String(sh.getRange('B2').getValue() || '').trim(),
    from: fmtDate_(sh.getRange('B3').getValue()),
    to:   fmtDate_(sh.getRange('B4').getValue()),
  };
  const qp = Object.keys(params).filter(function (k) { return params[k]; })
    .map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');

  let body;
  try {
    const res = UrlFetchApp.fetch(MIDDLEWARE_URL + '/api/recon-ledger?' + qp, { method: 'get', muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) { ui.alert('Report failed: ' + res.getResponseCode() + '\n' + res.getContentText()); return; }
    body = JSON.parse(res.getContentText());
  } catch (e) { ui.alert('Report failed: ' + e.message); return; }

  const cols = VIEW_COLS[view] || VIEW_COLS.summary;
  const rows = (body && body.rows) || [];

  const lastRow = sh.getLastRow();
  if (lastRow >= OUTPUT_START_ROW) {
    sh.getRange(OUTPUT_START_ROW, 1, lastRow - OUTPUT_START_ROW + 1, cols.length + 2).clearContent();
  }
  sh.getRange(OUTPUT_START_ROW, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
  if (!rows.length) { sh.getRange(OUTPUT_START_ROW + 1, 1).setValue('No records.'); ui.alert('Report complete — 0 records.'); return; }

  const matrix = rows.map(function (r) { return cols.map(function (c) { return r[c] != null ? r[c] : ''; }); });
  sh.getRange(OUTPUT_START_ROW + 1, 1, matrix.length, cols.length).setValues(matrix);
  ui.alert('Report complete — ' + rows.length + ' row(s). View: ' + view);
}

// dd-MM-yyyy → ISO string (midnight IST-agnostic), or '' if unparseable.
function dmyToIso_(s) {
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(String(s).trim());
  if (!m) return '';
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).toISOString();
}

function postIssue_(payload) {
  const res = UrlFetchApp.fetch(MIDDLEWARE_URL + '/api/credit-instrument/issue', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(payload),
  });
  return res.getResponseCode();
}

// One-time (idempotent) backfill: replay the Voucher Log + Exchange Log tabs into the ledger. The
// middleware upsert ignores duplicates, so re-running only fills gaps.
function backfillLedgerFromLogs() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let ok = 0, fail = 0, skipped = 0;

  // Voucher Log: A issued, B num, C order, D name, E email, F-I, J netCredit, K expiry(dd-MM-yyyy), L status.
  const vLog = ss.getSheetByName('Voucher Log') || ss.getSheetByName('CN Log');
  if (vLog) {
    const data = vLog.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const row = data[i]; const serial = String(row[1] || '').trim(); const value = Number(row[9]);
      if (!serial || !(value > 0)) { skipped++; continue; }
      const status = /void/i.test(String(row[11])) ? 'voided' : 'open';
      const code = postIssue_({
        instrumentType: 'voucher', serialCode: serial, value: value,
        customerName: row[3], sourceOrderName: String(row[2] || '').trim(),
        expiresAt: dmyToIso_(row[10]) || null, status: status,
      });
      if (code === 200) ok++; else fail++;
    }
  }

  // Exchange Log: A issued, B EXC num, C old order, D new draft, E customer, F email, ..., K value, L status, M newDraftId.
  const eLog = ss.getSheetByName('Exchange Log');
  if (eLog) {
    const data = eLog.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const row = data[i]; const serial = String(row[1] || '').trim(); const value = Number(row[10]);
      if (!serial || !(value > 0)) { skipped++; continue; }
      const status = /void/i.test(String(row[11])) ? 'voided' : (/appl/i.test(String(row[11])) ? 'redeemed' : 'open');
      const code = postIssue_({
        instrumentType: 'exchange_note', serialCode: serial, value: value,
        customerName: row[4], sourceOrderName: String(row[2] || '').trim(),
        targetOrderName: String(row[3] || '').trim(), status: status,
      });
      if (code === 200) ok++; else fail++;
    }
  }

  ui.alert('Backfill complete.\n\nWritten/confirmed: ' + ok + '\nFailed: ' + fail + '\nSkipped (no serial/value): ' + skipped +
           (vLog ? '' : '\n\n⚠️ No "Voucher Log" tab found.') + (eLog ? '' : '\n⚠️ No "Exchange Log" tab found.'));
}
