/**
 * Timanti Draft Order Reprice — Google Apps Script
 *
 * ════════════════════════════════════════════════════════════════
 * FORM STRUCTURE  (exact field titles matter)
 * ════════════════════════════════════════════════════════════════
 *
 * Page 1  (always shown)
 *   1.  Draft Order ID          Short answer   — numeric ID or full Shopify admin URL
 *   2.  Mode                    Multiple choice
 *         ○ Manual Price Override   → go to Section 2
 *         ○ Weight-based Reprice    → go to Section 3
 *
 * ── Section 2: Manual Price Override ──  (all comma-separated, positional per item)
 *   3.  Gold Rate (Rs/g)        Short answer   — e.g. "5500" (for the karat entered below)
 *   4.  Gold Karat              Short answer   — e.g. "22"  (leave blank if entering gold in Rs directly)
 *   5.  Gold (Rs)               Short answer   — overrides rate×wt if filled; blank = auto-compute from rate×netWt
 *   6.  Diamond (Rs)            Short answer
 *   7.  Making (Rs)             Short answer
 *   8.  Discount (Rs)           Short answer   — leave blank = Rs 0
 *   9.  Net Weight (g)          Short answer
 *   10. Gross Weight (g)        Short answer
 *   11. Diamond Carats          Short answer   — blank if none
 *   12. Diamond Pieces          Short answer   — blank if none
 *   13. Gemstone Carats         Short answer   — blank if none
 *   → Submit
 *
 * ── Section 3: Weight-based Reprice ──
 *   3.  Gold Rate (Rs/g)        Short answer   — optional; locks _gold_rate before reprice
 *   4.  Gold Karat              Short answer   — required if Gold Rate is filled
 *   9.  Net Weight (g)          Short answer
 *   10. Gross Weight (g)        Short answer
 *   11. Diamond Carats          Short answer
 *   12. Diamond Pieces          Short answer
 *   13. Gemstone Carats         Short answer
 *   14. Force reprice?          Checkbox       — tick to skip 5% delta guard
 *   → Submit
 *
 * Gold rate logic:
 *   _gold_rate stored = input rate converted to each item's own karat (from variant title).
 *   18kt back-calc = inputRate × (18 / inputKarat). Locked to form submission timestamp.
 *   In manual mode, if Gold (Rs) is blank, gold = rate_for_item_karat × Net Weight.
 *
 * ════════════════════════════════════════════════════════════════
 * SETUP
 * ════════════════════════════════════════════════════════════════
 * 1. Create the form above. Link responses to a Google Sheet.
 * 2. Sheet → Extensions → Apps Script → paste this file.
 * 3. Set SERVER_URL below.
 * 4. Triggers → Add Trigger → choose function "onFormSubmit"
 *    → Event source: From spreadsheet  → Event type: On form submit
 *    DO NOT run the function manually — it requires a real form-submit event object.
 */

const SERVER_URL = 'https://YOUR_SERVER_URL_HERE'; // ← replace

function onFormSubmit(e) {
  // Guard: this function requires a real form-submit event. Running it manually will fail.
  if (!e || !e.response) {
    Logger.log('onFormSubmit called without a valid event object. Run via trigger, not manually.');
    return;
  }

  try {
    const answers = {};
    for (const r of e.response.getItemResponses()) {
      answers[r.getItem().getTitle()] = r.getResponse();
    }

    const rawId        = String(answers['Draft Order ID'] || '').trim();
    const draftOrderId = (rawId.match(/\d{8,}/) || [])[0];
    if (!draftOrderId) {
      logResult('ERROR', rawId, '—', 'Could not parse Draft Order ID — paste the numeric ID or full URL');
      return;
    }

    const modeAnswer = String(answers['Mode'] || '');
    const mode       = modeAnswer.includes('Manual') ? 'manual' : 'weights';

    // Shared fields — appear in both sections
    const shared = {
      goldRate:        String(answers['Gold Rate (Rs/g)']  || '').trim(),
      goldKarat:       String(answers['Gold Karat']        || '').trim(),
      netWeights:      String(answers['Net Weight (g)']    || '').trim(),
      grossWeights:    String(answers['Gross Weight (g)']  || '').trim(),
      diamondCarats:   String(answers['Diamond Carats']    || '').trim(),
      diamondPcs:      String(answers['Diamond Pieces']    || '').trim(),
      gemstoneWeights: String(answers['Gemstone Carats']   || '').trim(),
    };

    let payload;
    if (mode === 'manual') {
      payload = {
        draftOrderId,
        mode: 'manual',
        gold:     String(answers['Gold (Rs)']     || '').trim(),
        diamond:  String(answers['Diamond (Rs)']  || '').trim(),
        making:   String(answers['Making (Rs)']   || '').trim(),
        discount: String(answers['Discount (Rs)'] || '').trim(),
        ...shared,
      };
    } else {
      const forceVal = answers['Force reprice?'];
      payload = {
        draftOrderId,
        mode: 'weights',
        force: Array.isArray(forceVal) ? forceVal.length > 0 : !!forceVal,
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

    const detail = result.error
      || `updated=${result.updatedCount ?? '—'} rate18kt=${result.rate18kt ?? '—'} force=${result.force ?? false}`;
    logResult(result.success ? 'OK' : 'FAIL', draftOrderId, mode, detail);

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
