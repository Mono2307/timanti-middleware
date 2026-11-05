/**
 * Timanti — Buy Plan tracker sheet.
 *
 * The middleware (src/modules/payments/buy-plan/sheet.js) POSTs the whole plan table here every
 * 10 minutes and after each payment or plan change. This script rewrites the "Buy Plans" tab.
 * The sheet is a view: edits made in it are overwritten on the next push.
 *
 * Setup (once):
 *  1. Create a Google Sheet. Extensions → Apps Script. Paste this file. Save.
 *  2. Project Settings → Script properties → add SECRET = any long random text.
 *  3. Deploy → New deployment → Web app. Execute as: Me. Who has access: Anyone. Deploy, copy the URL.
 *  4. On Fly set BUY_PLAN_SHEET_URL = that URL and BUY_PLAN_SHEET_SECRET = the same SECRET.
 */
var TAB = 'Buy Plans';

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
    if (!secret || body.secret !== secret) return json({ ok: false, error: 'unauthorized' });
    var columns = body.columns || [];
    var rows = body.rows || [];
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(TAB) || ss.insertSheet(TAB);
    sh.clearContents();
    var stamp = 'Last update: ' + Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd MMM yyyy HH:mm') + ' IST  ·  ' + rows.length + ' plan(s)';
    sh.getRange(1, 1).setValue(stamp).setFontStyle('italic');
    if (columns.length) {
      sh.getRange(2, 1, 1, columns.length).setValues([columns]).setFontWeight('bold').setBackground('#1f3a5f').setFontColor('#ffffff');
      sh.setFrozenRows(2);
    }
    if (rows.length) sh.getRange(3, 1, rows.length, columns.length).setValues(rows);
    colour(sh, columns, rows.length);
    return json({ ok: true, rows: rows.length });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

// Status colours: overdue / closing red, on track green, closed grey.
function colour(sh, columns, n) {
  var c = columns.indexOf('Status') + 1;
  if (!c || !n) return;
  var range = sh.getRange(3, c, n, 1);
  var vals = range.getValues();
  var bg = vals.map(function (r) {
    var s = String(r[0]);
    if (/closing|overdue|missing/i.test(s)) return ['#f8d7da'];
    if (/on track|Completed/i.test(s)) return ['#d4edda'];
    if (/Closed|Cancelled/i.test(s)) return ['#e2e3e5'];
    return ['#fff3cd'];
  });
  range.setBackgrounds(bg);
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
