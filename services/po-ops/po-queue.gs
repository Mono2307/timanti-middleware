// =================================================================
// Timanti PO Queue — Google Apps Script
// Attach to a NEW Google Sheet: "Timanti PO Queue"
//
// Script Properties (Extensions > Apps Script > Project Settings > Script Properties):
//   MIDDLEWARE_URL = https://timanti-middleware.fly.dev
//
// Deploy as Web App:
//   Execute as: Me | Who has access: Anyone with Google Account
//   Copy the Web App URL → set as PO_QUEUE_SCRIPT_URL in Fly.dev secrets
// =================================================================

const SS = SpreadsheetApp.getActiveSpreadsheet();
const MIDDLEWARE_URL = PropertiesService.getScriptProperties().getProperty('MIDDLEWARE_URL');

const TAB = { MTO: 'MTO', INSTOCK: 'InStock' };

// ── MTO tab columns (1-based, A=1) — 23 cols A–W ────────────────
const C_MTO = {
  DRAFT_ORDER_ID: 1,    // A hidden
  DRAFT_ORDER_NAME: 2,  // B
  CUSTOMER_NAME: 3,     // C
  LINE_ITEM_ID: 4,      // D hidden
  VARIANT_ID: 5,        // E hidden
  PRODUCT_TITLE: 6,     // F
  SKU: 7,               // G
  ORIGINAL_QTY: 8,      // H
  QTY_TO_RAISE: 9,      // I ← staff editable
  JEWEL_CODE: 10,       // J
  LINE_ITEM_PROPS: 11,  // K
  SYNCED_AT: 12,        // L
  STATUS: 13,           // M ← staff editable: pending/raised-po/skip/po-created
  PO_BATCH_ID: 14,      // N
  PO_RAISED_AT: 15,     // O
  NET_WT: 16,           // P ← reprice fields below
  GROSS_WT: 17,         // Q
  DIA_CTS: 18,          // R
  GEMSTONE_CTS: 19,     // S
  GOLD_RATE: 20,        // T
  GOLD_RATE_DATE: 21,   // U
  REPRICE_STATUS: 22,   // V
  REPRICED_AT: 23       // W
};

// ── InStock tab columns (1-based) — 15 cols A–O ─────────────────
const C_IS = {
  DRAFT_ORDER_ID: 1,
  DRAFT_ORDER_NAME: 2,
  CUSTOMER_NAME: 3,
  LINE_ITEM_ID: 4,
  VARIANT_ID: 5,
  PRODUCT_TITLE: 6,
  SKU: 7,
  ORIGINAL_QTY: 8,
  QTY_TO_RAISE: 9,      // ← staff editable
  JEWEL_CODE: 10,
  LINE_ITEM_PROPS: 11,
  SYNCED_AT: 12,
  STATUS: 13,            // ← staff editable
  PO_BATCH_ID: 14,
  PO_RAISED_AT: 15
};

// =================================================================
// Custom menu — replaces drawn button
// =================================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('PO Ops')
    .addItem('Reprice Selected Row', 'repriceTrigger')
    .addSeparator()
    .addItem('Run Batch Raise Now', 'batchRaisePoDailyTrigger')
    .addToUi();
}

// =================================================================
// Web App entry point — called by middleware
// =================================================================

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    let result;
    switch (body.action) {
      case 'upsertRows': result = upsertRows(body.tab, body.rows); break;
      case 'markRaised': result = markRaised(body.tab, body.lineItemIds, body.batchId, body.raisedAt); break;
      default: result = { error: 'Unknown action: ' + body.action };
    }
    return jsonResponse({ ok: true, data: result });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// =================================================================
// Upsert rows — called by middleware on webhook + nightly cron
// =================================================================

function upsertRows(tabName, rows) {
  const sheet = SS.getSheetByName(tabName);
  if (!sheet) throw new Error('Tab not found: ' + tabName);
  const C = tabName === TAB.MTO ? C_MTO : C_IS;

  const existingMap = buildLineItemIndex(sheet, C.LINE_ITEM_ID);
  let inserted = 0, refreshed = 0;

  rows.forEach(row => {
    const id = String(row.line_item_id);
    const existRow = existingMap[id];

    if (existRow) {
      const status = sheet.getRange(existRow, C.STATUS).getValue();
      if (status === 'pending') {
        writeRow(sheet, existRow, row, C, false);
        refreshed++;
      } else {
        // Staff has made decisions — only refresh sync timestamp
        sheet.getRange(existRow, C.SYNCED_AT).setValue(row.synced_at);
      }
    } else {
      const newRow = sheet.getLastRow() + 1;
      writeRow(sheet, newRow, row, C, true);
      existingMap[id] = newRow;
      inserted++;
    }
  });

  return { inserted, refreshed };
}

function writeRow(sheet, rowIdx, row, C, isNew) {
  const s = (col, val) => sheet.getRange(rowIdx, col).setValue(val);
  s(C.DRAFT_ORDER_ID,   row.draft_order_id);
  s(C.DRAFT_ORDER_NAME, row.draft_order_name);
  s(C.CUSTOMER_NAME,    row.customer_name);
  s(C.LINE_ITEM_ID,     row.line_item_id);
  s(C.VARIANT_ID,       row.variant_id || '');
  s(C.PRODUCT_TITLE,    row.product_title);
  s(C.SKU,              row.sku);
  s(C.ORIGINAL_QTY,     row.original_qty);
  s(C.JEWEL_CODE,       row.jewel_code || '');
  s(C.LINE_ITEM_PROPS,  row.line_item_properties || '');
  s(C.SYNCED_AT,        row.synced_at);
  if (isNew) {
    s(C.QTY_TO_RAISE, row.original_qty);
    s(C.STATUS, 'pending');
  }
  // qty_to_raise and status are never overwritten — staff owns those columns
}

function buildLineItemIndex(sheet, lineItemIdCol) {
  const last = sheet.getLastRow();
  if (last < 2) return {};
  const vals = sheet.getRange(2, lineItemIdCol, last - 1, 1).getValues();
  const map = {};
  vals.forEach((r, i) => { if (r[0]) map[String(r[0])] = i + 2; });
  return map;
}

// =================================================================
// Mark rows as PO raised — called after batchRaisePoDailyTrigger
// =================================================================

function markRaised(tabName, lineItemIds, batchId, raisedAt) {
  const sheet = SS.getSheetByName(tabName);
  if (!sheet) throw new Error('Tab not found: ' + tabName);
  const C = tabName === TAB.MTO ? C_MTO : C_IS;
  const idSet = new Set(lineItemIds.map(String));
  const last = sheet.getLastRow();
  if (last < 2) return;

  sheet.getRange(2, C.LINE_ITEM_ID, last - 1, 1).getValues().forEach((r, i) => {
    if (!idSet.has(String(r[0]))) return;
    const sr = i + 2;
    sheet.getRange(sr, C.STATUS).setValue('po-created');
    sheet.getRange(sr, C.PO_BATCH_ID).setValue(batchId);
    sheet.getRange(sr, C.PO_RAISED_AT).setValue(raisedAt);
  });
}

// =================================================================
// Get approved rows — reads MTO or InStock tab for raised-po rows
// =================================================================

function getApprovedRows(tabName) {
  const sheet = SS.getSheetByName(tabName);
  if (!sheet) return [];
  const C = tabName === TAB.MTO ? C_MTO : C_IS;
  const last = sheet.getLastRow();
  if (last < 2) return [];

  const numCols = tabName === TAB.MTO ? 23 : 15;
  const data = sheet.getRange(2, 1, last - 1, numCols).getValues();

  return data
    .filter(r => r[C.STATUS - 1] === 'raised-po')
    .map(r => ({
      draft_order_id:       String(r[C.DRAFT_ORDER_ID - 1]),
      draft_order_name:     r[C.DRAFT_ORDER_NAME - 1],
      customer_name:        r[C.CUSTOMER_NAME - 1],
      line_item_id:         String(r[C.LINE_ITEM_ID - 1]),
      variant_id:           String(r[C.VARIANT_ID - 1] || ''),
      product_title:        r[C.PRODUCT_TITLE - 1],
      sku:                  r[C.SKU - 1],
      qty_to_raise:         Number(r[C.QTY_TO_RAISE - 1]) || Number(r[C.ORIGINAL_QTY - 1]),
      jewel_code:           r[C.JEWEL_CODE - 1] || '',
      line_item_properties: r[C.LINE_ITEM_PROPS - 1] || ''
    }));
}

// =================================================================
// Daily batch trigger — reads sheet, calls middleware, marks rows
// =================================================================

function batchRaisePoDailyTrigger() {
  [{ type: 'mto', tab: TAB.MTO }, { type: 'in-stock', tab: TAB.INSTOCK }]
    .forEach(({ type, tab }) => {
      const rows = getApprovedRows(tab);
      if (!rows.length) { Logger.log('No raised-po rows for ' + type); return; }

      const resp = UrlFetchApp.fetch(MIDDLEWARE_URL + '/api/po-ops/batch-raise-po', {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ po_type: type, rows }),
        muteHttpExceptions: true
      });

      const result = JSON.parse(resp.getContentText());
      if (result.ok) {
        markRaised(tab, rows.map(r => r.line_item_id), result.batch_id, result.raised_at);
        Logger.log('Batch raised ' + type + ' — batch_id: ' + result.batch_id);
      } else {
        Logger.log('Batch FAILED ' + type + ': ' + (result.error || resp.getResponseCode()));
      }
    });
}

// =================================================================
// Reprice — PO Ops menu > "Reprice Selected Row"
// Reads jewel measurements + gold rate from the selected MTO row,
// calls middleware, marks row as repriced.
// =================================================================

function repriceTrigger() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SS.getActiveSheet();

  if (sheet.getName() !== TAB.MTO) {
    ui.alert('Switch to the MTO tab and select the row you want to reprice.');
    return;
  }
  const row = sheet.getActiveCell().getRow();
  if (row < 2) { ui.alert('Select a data row first.'); return; }

  const g = col => sheet.getRange(row, col).getValue();
  const draftOrderId = g(C_MTO.DRAFT_ORDER_ID);
  const lineItemId   = g(C_MTO.LINE_ITEM_ID);
  const netWt        = g(C_MTO.NET_WT);
  const grossWt      = g(C_MTO.GROSS_WT);

  if (!draftOrderId || !lineItemId) {
    ui.alert('Row is missing draft order ID or line item ID.'); return;
  }
  if (!netWt || !grossWt) {
    ui.alert('Enter Net Wt and Gross Wt before repricing.'); return;
  }

  const rawDate = g(C_MTO.GOLD_RATE_DATE);
  const goldRateDate = rawDate
    ? Utilities.formatDate(new Date(rawDate), Session.getScriptTimeZone(), 'yyyy-MM-dd')
    : null;

  const payload = {
    draft_order_id: String(draftOrderId),
    line_item_id:   String(lineItemId),
    jewel_code:     String(g(C_MTO.JEWEL_CODE) || ''),
    net_wt:         Number(netWt),
    gross_wt:       Number(grossWt),
    dia_cts:        Number(g(C_MTO.DIA_CTS) || 0),
    gemstone_cts:   Number(g(C_MTO.GEMSTONE_CTS) || 0),
    gold_rate:      g(C_MTO.GOLD_RATE) ? Number(g(C_MTO.GOLD_RATE)) : null,
    gold_rate_date: goldRateDate
  };

  const resp = UrlFetchApp.fetch(MIDDLEWARE_URL + '/api/po-ops/reprice-from-sheet', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const result = JSON.parse(resp.getContentText());
  if (result.ok) {
    sheet.getRange(row, C_MTO.REPRICE_STATUS).setValue('repriced');
    sheet.getRange(row, C_MTO.REPRICED_AT).setValue(new Date().toISOString());
    ui.alert('Repriced successfully.');
  } else {
    ui.alert('Reprice failed: ' + (result.error || 'HTTP ' + resp.getResponseCode()));
  }
}

// =================================================================
// One-time setup: install daily trigger at 8 PM IST (14:30 UTC)
// =================================================================

function setupDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'batchRaisePoDailyTrigger')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('batchRaisePoDailyTrigger')
    .timeBased()
    .atHour(14)
    .nearMinute(30)
    .everyDays(1)
    .create();

  Logger.log('Daily trigger set: 8:00 PM IST');
}
