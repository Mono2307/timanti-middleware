/**
 * Timanti Draft Order Reprice — Google Apps Script
 *
 * ════════════════════════════════════════════════════════════════
 * FORM FIELD TITLES  (must match exactly — case-sensitive)
 * ════════════════════════════════════════════════════════════════
 *
 * Page 1  (always shown)
 *   Draft Order ID     Short answer
 *   Mode               Multiple choice
 *       ○ Manual Price Override   → go to Section 2
 *       ○ Weight-based Reprice    → go to Section 3
 *
 * ── Section 2: Manual Price Override ──
 *   Separator: use "/" between items. Commas inside numbers are fine.
 *   e.g.  "21,165/26,422"  →  item1=21165  item2=26422
 *
 *   gold            Gold value in Rs per line item
 *   diamond         Diamond value in Rs per line item
 *   making          Making charges in Rs per line item
 *   discount        Discount in Rs per line item  (blank = 0)
 *   netWeights      Net weight in grams per item
 *   grossWeights    Gross weight in grams per item
 *   diamondCarats   Diamond carats per item
 *   diamondPcs      Diamond pieces per item
 *   gemstoneWeights Gemstone carats per item
 *   Gold Rate (Rs/g) Optional — locks gold rate; auto-computes gold if gold blank
 *   Gold Karat       Required if Gold Rate is filled (e.g. 22)
 *
 * ── Section 3: Weight-based Reprice ──
 *   netWeights      Net weight in grams per item
 *   grossWeights    Gross weight in grams per item
 *   diamondCarats   Diamond carats per item
 *   diamondPcs      Diamond pieces per item
 *   gemstoneWeights Gemstone carats per item
 *   Gold Rate (Rs/g) Optional — updates _gold_rate before reprice
 *   Gold Karat       Required if Gold Rate is filled
 *   Force reprice?  Checkbox — tick to skip 5% delta guard
 *
 * ════════════════════════════════════════════════════════════════
 * SETUP
 * ════════════════════════════════════════════════════════════════
 * 1. Create the form above. Link responses to a Google Sheet.
 * 2. Sheet → Extensions → Apps Script → paste this file.
 * 3. Set SERVER_URL below.
 * 4. Triggers → Add Trigger → onFormSubmit
 *    → Event source: From spreadsheet  → Event type: On form submit
 *    DO NOT run onFormSubmit manually — use testRow4() instead.
 */

const SERVER_URL = 'https://YOUR_SERVER_URL_HERE'; // ← replace

function onFormSubmit(e) {
  if (!e || (!e.response && !e.namedValues)) {
    Logger.log('onFormSubmit called without a valid event object. Run via trigger, not manually.');
    return;
  }

  try {
    const answers = {};
    if (e.response) {
      // Form-bound trigger or testRow4() — e.response has getItemResponses()
      for (const r of e.response.getItemResponses()) {
        answers[r.getItem().getTitle()] = r.getResponse();
      }
    } else {
      // Spreadsheet-bound trigger — e.namedValues keys are field titles, values are single-element arrays
      for (const [key, val] of Object.entries(e.namedValues)) {
        answers[key] = Array.isArray(val) ? val[0] : val;
      }
    }

    const rawId        = String(answers['Draft Order ID'] || '').trim();
    const draftOrderId = (rawId.match(/\d{8,}/) || [])[0];
    if (!draftOrderId) {
      logResult('ERROR', rawId, '—', 'Could not parse Draft Order ID');
      return;
    }

    const modeAnswer = String(answers['Mode'] || '');
    const mode       = modeAnswer.includes('Manual') ? 'manual' : 'weights';

    // Shared fields — same titles in both sections
    const shared = {
      goldRate:        String(answers['Gold Rate (Rs/g)']  || '').trim(),
      goldKarat:       String(answers['Gold Karat']        || '').trim(),
      netWeights:      String(answers['netWeights']        || '').trim(),
      grossWeights:    String(answers['grossWeights']      || '').trim(),
      diamondCarats:   String(answers['diamondCarats']     || '').trim(),
      diamondPcs:      String(answers['diamondPcs']        || '').trim(),
      gemstoneWeights: String(answers['gemstoneWeights']   || '').trim(),
      invoiceDate:     String(answers['Invoice Date']      || '').trim(),
    };

    let payload;
    if (mode === 'manual') {
      payload = {
        draftOrderId,
        mode: 'manual',
        gold:     String(answers['gold']     || '').trim(),
        diamond:  String(answers['diamond']  || '').trim(),
        making:   String(answers['making']   || '').trim(),
        discount: String(answers['discount'] || '').trim(),
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

/**
 * Replays the row 4 form response through onFormSubmit.
 * Row 1 = headers, Row 2 = 1st response (index 0), Row 4 = index 2.
 * Run this from the Apps Script editor to test without resubmitting the form.
 */
function testRow4() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const form = FormApp.openByUrl(ss.getFormUrl());
  const responses = form.getResponses();
  const response  = responses[2]; // row 4 = index 2
  if (!response) {
    Logger.log('No response at index 2 (row 4). Check the form has at least 3 submissions.');
    return;
  }
  Logger.log('Replaying row 4: ' + response.getId());
  onFormSubmit({ response });
}

/**
 * Direct API test — POSTs row 4 values straight to the server.
 * Run this if testRow4() has field-title issues or for quick iteration.
 */
function testRow4Direct() {
  const payload = {
    draftOrderId:    '1365166719233',
    mode:            'manual',
    gold:            '21165/26422',
    diamond:         '72850/55200',
    making:          '2073/2588',
    discount:        '0/0',
    netWeights:      '2.18/2.72',
    grossWeights:    '2.54/3.0',
    diamondCarats:   '1.79/1.38',
    diamondPcs:      '38/1',
    gemstoneWeights: '0/0',
    goldRate:        '9713',
    goldKarat:       '14',
  };

  const resp = UrlFetchApp.fetch(SERVER_URL + '/api/form-reprice', {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const result = JSON.parse(resp.getContentText());
  Logger.log('Raw response: ' + resp.getContentText());
  const detail = result.error
    || ('updated=' + (result.updatedCount ?? '—') + ' rate18kt=' + (result.rate18kt ?? '—'));
  logResult(result.success ? 'OK' : 'FAIL', payload.draftOrderId, payload.mode, detail);
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
