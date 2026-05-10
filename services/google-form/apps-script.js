/**
 * Timanti Draft Order Reprice — Google Apps Script
 *
 * ════════════════════════════════════════════════════════════════
 * FORM STRUCTURE  —  2 sections, exact field titles matter
 * ════════════════════════════════════════════════════════════════
 *
 * Page 1  (always shown — 2 fields)
 *   1. Draft Order ID          Short answer
 *   2. Mode                    Multiple choice
 *        ○ Manual Price Override   → go to Section 2
 *        ○ Weight-based Reprice    → go to Section 3
 *
 * ── Section 2: Manual Price Override  (9 fields, all comma-separated) ──
 *   3.  Gold (Rs)              "25000" or "25000, 18000" for 2 items
 *   4.  Diamond (Rs)           "10000" or "10000, 7500"
 *   5.  Making (Rs)            "5000"  or "5000, 4000"
 *   6.  Discount (Rs)          "0"  or "2000, 0"  — leave blank = no discount
 *   7.  Net Weight (g)         "5.2"  or "5.2, 3.8"
 *   8.  Gross Weight (g)       "6.1"  or "6.1, 4.5"
 *   9.  Diamond Carats         "0.50" or "0.50, 0.30"  — leave blank if none
 *   10. Diamond Pieces         "12"   or "12, 8"        — leave blank if none
 *   11. Gemstone Carats        "1.2"  or blank
 *   → Submit
 *
 * ── Section 3: Weight-based Reprice  (6 fields) ──
 *   7.  Net Weight (g)         same format as above
 *   8.  Gross Weight (g)
 *   9.  Diamond Carats
 *   10. Diamond Pieces
 *   11. Gemstone Carats
 *   12. Force reprice?         Checkbox  (tick = skip 5% delta guard)
 *   → Submit
 *
 * Fields 7–11 appear in BOTH sections — duplicate them across the two pages.
 * Blank entries in a comma list fall back to the item's existing property value.
 *
 * How pricing works in Manual mode:
 *   Gross  = Gold + Diamond + Making   (per item, tax-inclusive)
 *   Final  = Gross − Discount           (what Shopify charges)
 *   GST    = Final / 1.03 × 0.03        (auto-computed, shown on invoice)
 *   Shopify line item price = Final / qty
 *
 * ════════════════════════════════════════════════════════════════
 * SETUP
 * ════════════════════════════════════════════════════════════════
 * 1. Create the form above. Link responses to a Google Sheet.
 * 2. Sheet → Extensions → Apps Script → paste this file.
 * 3. Set SERVER_URL below.
 * 4. Triggers → Add Trigger → onFormSubmit → From spreadsheet → On form submit.
 */

const SERVER_URL = 'https://YOUR_SERVER_URL_HERE'; // ← replace

function onFormSubmit(e) {
  try {
    const answers = {};
    for (const r of e.response.getItemResponses()) {
      answers[r.getItem().getTitle()] = r.getResponse();
    }

    const rawId        = String(answers['Draft Order ID'] || '').trim();
    const draftOrderId = (rawId.match(/\d{8,}/) || [])[0];
    if (!draftOrderId) {
      logResult('ERROR', rawId, '—', 'Could not parse Draft Order ID');
      return;
    }

    const modeAnswer = String(answers['Mode'] || '');
    const mode       = modeAnswer.includes('Manual') ? 'manual' : 'weights';

    // Fields shared across both modes
    const shared = {
      netWeights:      String(answers['Net Weight (g)']     || '').trim(),
      grossWeights:    String(answers['Gross Weight (g)']    || '').trim(),
      diamondCarats:   String(answers['Diamond Carats']      || '').trim(),
      gemstoneWeights: String(answers['Gemstone Carats']     || '').trim(),
    };

    let payload;
    if (mode === 'manual') {
      payload = {
        draftOrderId,
        mode: 'manual',
        gold:        String(answers['Gold (Rs)']      || '').trim(),
        diamond:     String(answers['Diamond (Rs)']   || '').trim(),
        making:      String(answers['Making (Rs)']    || '').trim(),
        discount:    String(answers['Discount (Rs)']  || '').trim(),
        diamondPcs:  String(answers['Diamond Pieces'] || '').trim(),
        ...shared,
      };
    } else {
      const forceVal = answers['Force reprice?'];
      payload = {
        draftOrderId,
        mode: 'weights',
        force: Array.isArray(forceVal) ? forceVal.length > 0 : !!forceVal,
        diamondPcs: String(answers['Diamond Pieces'] || '').trim(),
        ...shared,
      };
    }

    const resp   = UrlFetchApp.fetch(`${SERVER_URL}/api/form-reprice`, {
      method:             'post',
      contentType:        'application/json',
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    const result = JSON.parse(resp.getContentText());

    logResult(
      result.success ? 'OK' : 'FAIL',
      draftOrderId,
      mode,
      result.error || `updated=${result.updatedCount ?? '—'} force=${result.force ?? false}`
    );
  } catch (err) {
    logResult('EXCEPTION', '', '—', err.message);
  }
}

function logResult(status, draftOrderId, mode, detail) {
  Logger.log(`[${status}] draft=${draftOrderId} mode=${mode} — ${detail}`);
  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Reprice Log') || ss.insertSheet('Reprice Log');
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Timestamp', 'Status', 'Draft Order ID', 'Mode', 'Detail']);
      sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    }
    sheet.appendRow([new Date(), status, draftOrderId, mode, detail]);
  } catch (_) {}
}
