/**
 * CAD Advance Log — Apps Script handler for the Exchange Calculator sheet.
 *
 * Paste this into the SAME Apps Script project that already serves EXCHANGE_APPS_SCRIPT_URL (the one
 * handling action === 'issue_voucher' for the CN Log), then re-deploy the web app.
 *
 * The middleware POSTs one of these on every state change of a design advance:
 *
 *   {
 *     action:        'log_cad_advance',
 *     source:        'cad-advance',
 *     event:         'captured' | 'applied' | 'redeemed' | 'expired' | 'deleted' | 'refunded',
 *     draft_ref:     '#D205'        // the advance's own document — draft name, or order name once converted
 *     value:         5000,
 *     customer_name: 'A Kumar',
 *     expires_at:    '2027-09-01',  // only on 'captured'
 *     against:       '#1042',       // the order it was applied/redeemed against, where relevant
 *     draft_id:      '1461677883649',
 *     logged_at:     '2026-09-07T13:00:00.000Z'
 *   }
 *
 * Design notes
 * ────────────
 * - APPEND ONLY. One row per event, never an update in place. The point of the log is the history:
 *   an advance taken, applied, then redeemed should read as three lines, so staff can see when each
 *   thing happened. The Supabase register holds current state; this holds the story.
 * - The tab and its header row are created on first use, so there is nothing to set up by hand.
 * - Unknown actions fall through untouched, so adding this cannot disturb the voucher handler.
 */

var CAD_ADVANCE_SHEET = 'CAD Advance Log';

var CAD_ADVANCE_HEADERS = [
  'Logged At (IST)',
  'Event',
  'Reference',
  'Value',
  'Customer',
  'Expires On',
  'Applied / Redeemed Against',
  'Draft ID'
];

/**
 * Append one advance event. Returns a short status string for the caller's log.
 */
function logCadAdvance_(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CAD_ADVANCE_SHEET);

  if (!sh) {
    sh = ss.insertSheet(CAD_ADVANCE_SHEET);
    sh.appendRow(CAD_ADVANCE_HEADERS);
    sh.getRange(1, 1, 1, CAD_ADVANCE_HEADERS.length)
      .setFontWeight('bold')
      .setBackground('#f0f0f0');
    sh.setFrozenRows(1);
  }

  // Times arrive as UTC ISO from the server; staff read IST.
  var when = p.logged_at ? new Date(p.logged_at) : new Date();
  var whenIst = Utilities.formatDate(when, 'Asia/Kolkata', 'yyyy-MM-dd HH:mm');

  sh.appendRow([
    whenIst,
    String(p.event || ''),
    String(p.draft_ref || ''),
    p.value === '' || p.value == null ? '' : Number(p.value),
    String(p.customer_name || ''),
    p.expires_at ? String(p.expires_at).slice(0, 10) : '',
    String(p.against || ''),
    String(p.draft_id || '')
  ]);

  return 'logged ' + p.event + ' ' + p.draft_ref;
}

/**
 * ── WIRING ──────────────────────────────────────────────────────────────────────────────────────
 *
 * Add ONE line to the existing doPost, alongside the issue_voucher branch. It should look roughly
 * like this — keep whatever your current structure is, this is only showing where the branch goes:
 *
 *   function doPost(e) {
 *     var p = JSON.parse(e.postData.contents);
 *
 *     if (p.action === 'issue_voucher')    { ...existing CN Log code... }
 *     if (p.action === 'log_cad_advance')  { return jsonOut_({ ok: true, msg: logCadAdvance_(p) }); }
 *
 *     ...
 *   }
 *
 * If your doPost has no jsonOut_ helper, this works standalone:
 *
 *   return ContentService
 *     .createTextOutput(JSON.stringify({ ok: true, msg: logCadAdvance_(p) }))
 *     .setMimeType(ContentService.MimeType.JSON);
 *
 * The middleware ignores the response body entirely — it only cares that the POST did not error —
 * so anything JSON-shaped is fine.
 *
 * AFTER PASTING: Deploy → Manage deployments → edit the active web-app deployment → Deploy. A new
 * deployment URL would need EXCHANGE_APPS_SCRIPT_URL changed too, so edit the existing one.
 */

/**
 * Optional: run this once from the editor to prove the tab and the append work, without waiting for
 * a real advance. It writes a clearly-marked row you can delete afterwards.
 */
function testCadAdvanceLog_() {
  var msg = logCadAdvance_({
    event:         'captured',
    draft_ref:     '#TEST-DELETE-ME',
    value:         5000,
    customer_name: 'Test Row — safe to delete',
    expires_at:    '2027-09-01',
    logged_at:     new Date().toISOString()
  });
  Logger.log(msg);
}
