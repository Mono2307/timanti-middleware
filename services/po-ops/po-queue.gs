// =================================================================
// Timanti PO Queue — Google Apps Script
// Attach to a NEW Google Sheet: "Timanti PO Queue"
//
// Script Properties (Extensions > Apps Script > Project Settings > Script Properties):
//   MIDDLEWARE_URL = https://timanti-middleware.fly.dev
//
// Deploy as Web App:
//   Execute as: Me | Who has access: Anyone
//   Copy the Web App URL → set as PO_QUEUE_SCRIPT_URL in Fly.dev secrets
// =================================================================

const SS = SpreadsheetApp.getActiveSpreadsheet();
const MIDDLEWARE_URL = PropertiesService.getScriptProperties().getProperty('MIDDLEWARE_URL');

const TAB = { MTO: 'MTO', INSTOCK: 'InStock', UNCLASSIFIED: 'Unclassified' };

// ── MTO tab columns (1-based, A=1) — 23 cols A–W ────────────────
const C_MTO = {
  SOURCE_ID: 1,         // A hidden
  ORDER_NAME: 2,        // B
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
  NET_WT: 16,           // P ← reprice fields
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
  SOURCE_ID: 1,
  ORDER_NAME: 2,
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

// ── Unclassified tab columns (1-based) — 24 cols A–X ────────────
// Staff fills PO_TYPE (col P) with 'mto' or 'in-stock' before approving
const C_UC = {
  SOURCE_ID: 1,         // A hidden
  ORDER_NAME: 2,        // B
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
  PO_TYPE: 16,          // P ← staff fills: mto / in-stock
  NET_WT: 17,           // Q ← reprice fields
  GROSS_WT: 18,         // R
  DIA_CTS: 19,          // S
  GEMSTONE_CTS: 20,     // T
  GOLD_RATE: 21,        // U
  GOLD_RATE_DATE: 22,   // V
  REPRICE_STATUS: 23,   // W
  REPRICED_AT: 24       // X
};

function getColumnMap(tabName) {
  if (tabName === TAB.MTO)           return C_MTO;
  if (tabName === TAB.INSTOCK)       return C_IS;
  if (tabName === TAB.UNCLASSIFIED)  return C_UC;
  throw new Error('Unknown tab: ' + tabName);
}

function tabWidth(tabName) {
  if (tabName === TAB.MTO)           return 23;
  if (tabName === TAB.INSTOCK)       return 15;
  if (tabName === TAB.UNCLASSIFIED)  return 24;
  return 15;
}

// =================================================================
// Custom menu
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
  const C = getColumnMap(tabName);

  const lineItemIndex = buildIndex(sheet, C.LINE_ITEM_ID);
  const orderNameIndex = buildIndex(sheet, C.ORDER_NAME);
  let inserted = 0, refreshed = 0;

  rows.forEach(row => {
    const lineItemId = String(row.line_item_id);
    let existRow = lineItemIndex[lineItemId];

    // Dedup: order converted from a draft — find the existing draft row by its order name
    if (!existRow && row.source_draft_name) {
      existRow = orderNameIndex[String(row.source_draft_name)];
    }

    if (existRow) {
      const status = sheet.getRange(existRow, C.STATUS).getValue();
      if (status === 'pending') {
        writeRow(sheet, existRow, row, C, false);
        refreshed++;
      } else {
        // Staff has made decisions — only refresh sync timestamp and source_id
        sheet.getRange(existRow, C.SYNCED_AT).setValue(row.synced_at);
        if (row.source_draft_name) {
          // Draft was converted to order — update the source_id to the order id
          sheet.getRange(existRow, C.SOURCE_ID).setValue(row.source_id);
        }
      }
    } else {
      const newRow = sheet.getLastRow() + 1;
      writeRow(sheet, newRow, row, C, true);
      lineItemIndex[lineItemId] = newRow;
      inserted++;
    }
  });

  return { inserted, refreshed };
}

function writeRow(sheet, rowIdx, row, C, isNew) {
  const s = (col, val) => sheet.getRange(rowIdx, col).setValue(val);
  s(C.SOURCE_ID,       row.source_id);
  s(C.ORDER_NAME,      row.order_name);
  s(C.CUSTOMER_NAME,   row.customer_name);
  s(C.LINE_ITEM_ID,    row.line_item_id);
  s(C.VARIANT_ID,      row.variant_id || '');
  s(C.PRODUCT_TITLE,   row.product_title);
  s(C.SKU,             row.sku);
  s(C.ORIGINAL_QTY,    row.original_qty);
  s(C.JEWEL_CODE,      row.jewel_code || '');
  s(C.LINE_ITEM_PROPS, row.line_item_properties || '');
  s(C.SYNCED_AT,       row.synced_at);
  if (isNew) {
    s(C.QTY_TO_RAISE, row.original_qty);
    s(C.STATUS, 'pending');
  }
}

function buildIndex(sheet, col) {
  const last = sheet.getLastRow();
  if (last < 2) return {};
  const vals = sheet.getRange(2, col, last - 1, 1).getValues();
  const map = {};
  vals.forEach((r, i) => { if (r[0]) map[String(r[0])] = i + 2; });
  return map;
}

// =================================================================
// Mark rows as PO raised
// =================================================================

function markRaised(tabName, lineItemIds, batchId, raisedAt) {
  const sheet = SS.getSheetByName(tabName);
  if (!sheet) throw new Error('Tab not found: ' + tabName);
  const C = getColumnMap(tabName);
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
// Get approved rows — reads tab for raised-po rows
// =================================================================

function getApprovedRows(tabName) {
  const sheet = SS.getSheetByName(tabName);
  if (!sheet) return [];
  const C    = getColumnMap(tabName);
  const cols = tabWidth(tabName);
  const last = sheet.getLastRow();
  if (last < 2) return [];

  const data = sheet.getRange(2, 1, last - 1, cols).getValues();

  return data
    .filter(r => r[C.STATUS - 1] === 'raised-po')
    .filter(r => tabName !== TAB.UNCLASSIFIED || r[C.PO_TYPE - 1]) // Unclassified must have po_type filled
    .map(r => ({
      source_id:            String(r[C.SOURCE_ID - 1]),
      draft_order_name:     r[C.ORDER_NAME - 1],       // kept as draft_order_name for batch.js compat
      customer_name:        r[C.CUSTOMER_NAME - 1],
      line_item_id:         String(r[C.LINE_ITEM_ID - 1]),
      variant_id:           String(r[C.VARIANT_ID - 1] || ''),
      product_title:        r[C.PRODUCT_TITLE - 1],
      sku:                  r[C.SKU - 1],
      qty_to_raise:         Number(r[C.QTY_TO_RAISE - 1]) || Number(r[C.ORIGINAL_QTY - 1]),
      jewel_code:           r[C.JEWEL_CODE - 1] || '',
      line_item_properties: r[C.LINE_ITEM_PROPS - 1] || '',
      ...(tabName === TAB.UNCLASSIFIED ? { po_type: r[C.PO_TYPE - 1] } : {})
    }));
}

// =================================================================
// Daily batch trigger
// =================================================================

function batchRaisePoDailyTrigger() {
  // MTO and InStock: po_type comes from the tab
  [{ type: 'mto', tab: TAB.MTO }, { type: 'in-stock', tab: TAB.INSTOCK }]
    .forEach(({ type, tab }) => {
      const rows = getApprovedRows(tab);
      if (!rows.length) { Logger.log('No raised-po rows for ' + type); return; }
      callBatchRaise(type, tab, rows);
    });

  // Unclassified: group by the po_type column value staff filled in
  const ucRows = getApprovedRows(TAB.UNCLASSIFIED);
  if (ucRows.length) {
    const byType = {};
    ucRows.forEach(r => {
      if (!byType[r.po_type]) byType[r.po_type] = [];
      byType[r.po_type].push(r);
    });
    Object.entries(byType).forEach(([type, rows]) => callBatchRaise(type, TAB.UNCLASSIFIED, rows));
  } else {
    Logger.log('No raised-po rows for Unclassified');
  }
}

function callBatchRaise(poType, tabName, rows) {
  const resp = UrlFetchApp.fetch(MIDDLEWARE_URL + '/api/po-ops/batch-raise-po', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ po_type: poType, rows }),
    muteHttpExceptions: true
  });

  const result = JSON.parse(resp.getContentText());
  if (result.ok) {
    markRaised(tabName, rows.map(r => r.line_item_id), result.batch_id, result.raised_at);
    Logger.log('Batch raised ' + poType + ' (' + tabName + ') — batch_id: ' + result.batch_id);
  } else {
    Logger.log('Batch FAILED ' + poType + ' (' + tabName + '): ' + (result.error || resp.getResponseCode()));
  }
}

// =================================================================
// Reprice — PO Ops menu > "Reprice Selected Row"
// Works on MTO tab and Unclassified tab (MTO rows only).
// Reads jewel measurements + gold rate, calls middleware.
// =================================================================

function repriceTrigger() {
  const ui    = SpreadsheetApp.getUi();
  const sheet = SS.getActiveSheet();
  const name  = sheet.getName();

  const isMto = name === TAB.MTO;
  const isUc  = name === TAB.UNCLASSIFIED;

  if (!isMto && !isUc) {
    ui.alert('Switch to the MTO or Unclassified tab and select the row you want to reprice.');
    return;
  }

  const row = sheet.getActiveCell().getRow();
  if (row < 2) { ui.alert('Select a data row first.'); return; }

  const C = getColumnMap(name);
  const g = col => sheet.getRange(row, col).getValue();

  if (isUc && g(C.PO_TYPE) !== 'mto') {
    ui.alert('Reprice is only available for MTO rows. Fill in PO Type = mto first.');
    return;
  }

  const sourceId   = g(C.SOURCE_ID);
  const lineItemId = g(C.LINE_ITEM_ID);
  const netWt      = g(C.NET_WT);
  const grossWt    = g(C.GROSS_WT);

  if (!sourceId || !lineItemId) {
    ui.alert('Row is missing source ID or line item ID.'); return;
  }
  if (!netWt || !grossWt) {
    ui.alert('Enter Net Wt and Gross Wt before repricing.'); return;
  }

  const rawDate = g(C.GOLD_RATE_DATE);
  const goldRateDate = rawDate
    ? Utilities.formatDate(new Date(rawDate), Session.getScriptTimeZone(), 'yyyy-MM-dd')
    : null;

  const payload = {
    draft_order_id: String(sourceId),
    line_item_id:   String(lineItemId),
    jewel_code:     String(g(C.JEWEL_CODE) || ''),
    net_wt:         Number(netWt),
    gross_wt:       Number(grossWt),
    dia_cts:        Number(g(C.DIA_CTS) || 0),
    gemstone_cts:   Number(g(C.GEMSTONE_CTS) || 0),
    gold_rate:      g(C.GOLD_RATE) ? Number(g(C.GOLD_RATE)) : null,
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
    sheet.getRange(row, C.REPRICE_STATUS).setValue('repriced');
    sheet.getRange(row, C.REPRICED_AT).setValue(new Date().toISOString());
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
