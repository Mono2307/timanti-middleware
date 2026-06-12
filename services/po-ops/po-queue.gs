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

const TAB = { MTO: 'mto', INSTOCK: 'InStock', UNCLASSIFIED: 'unclassified' };

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
    .addItem('Reprice Selected Row',       'repriceTrigger')
    .addSeparator()
    .addItem('Sync All Now',               'syncAllTrigger')
    .addItem('Run Batch Raise Now',        'batchRaisePoDailyTrigger')
    .addSeparator()
    .addItem('Set Batch Store Code',       'setBatchStoreCode')
    .addItem('Fix Duplicate Rows',         'dedupAllTabs')
    .addToUi();
}

// Store code applied to batch/merchandising POs (these have no source order). Persisted as a
// Script Property so the unattended daily batch trigger can read it. The middleware mints the
// PO serial (PO-{CODE}-{SEQ}) from this code at HQ acknowledge; blank → no serial. Auto-POs
// (raised from a customer order) ignore this and use the source order's own store code.
function getBatchStoreCode() {
  return (PropertiesService.getScriptProperties().getProperty('BATCH_STORE_CODE') || '').toUpperCase().trim();
}

function setBatchStoreCode() {
  const ui = SpreadsheetApp.getUi();
  const current = getBatchStoreCode();
  const resp = ui.prompt(
    'Batch PO Store Code',
    'Store code for batch/merchandising POs (e.g. MH-HQ, KA-HSR).\nCurrent: ' + (current || '(none)') + '\n\nEnter a new value (or leave blank to clear):',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const code = String(resp.getResponseText()).toUpperCase().trim();
  PropertiesService.getScriptProperties().setProperty('BATCH_STORE_CODE', code);
  ui.alert(code ? ('✅ Batch store code set to ' + code) : '✅ Batch store code cleared.');
}

function requireMiddlewareUrl() {
  if (!MIDDLEWARE_URL) {
    SpreadsheetApp.getUi().alert(
      '❌ MIDDLEWARE_URL not set.\n\n' +
      'Go to Extensions → Apps Script → Project Settings → Script Properties\n' +
      'and add:\n\n  MIDDLEWARE_URL = https://timanti-middleware.fly.dev'
    );
    return false;
  }
  return true;
}

// =================================================================
// Web App entry point — called by middleware
// =================================================================

function doPost(e) {
  // Serialize concurrent requests — Shopify fires create+update simultaneously,
  // without a lock both read the same empty index and both insert duplicate rows.
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (_) { return jsonResponse({ ok: false, error: 'Lock timeout' }); }
  try {
    const body = JSON.parse(e.postData.contents);
    let result;
    switch (body.action) {
      case 'upsertRows':    result = upsertRows(body.tab, body.rows); break;
      case 'markRaised':    result = markRaised(body.tab, body.lineItemIds, body.batchId, body.raisedAt); break;
      case 'removeSource':  result = removeSourceRows(body.sourceId); break;
      case 'pruneOrphans':  result = pruneOrphanRows(body.validSourceIds); break;
      default: result = { error: 'Unknown action: ' + body.action };
    }
    return jsonResponse({ ok: true, data: result });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  } finally {
    lock.releaseLock();
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

  // ONE source → ONE tab. A draft/order and its line items must live in a single tab. When a
  // draft is reclassified (order_type set later → unclassified→mto/InStock) or converted to an
  // order in a different tab, its line items get new ids and re-insert here, but the old pending
  // rows linger in the other tab. Evict every source in this payload — plus any originating
  // draft (source_draft_name) — from the OTHER tabs first. Only pending rows are removed;
  // raised-po / po-created stay put as the committed PO record.
  const evictIds = new Set(rows.map(r => String(r.source_id)));
  rows.map(r => r.source_draft_name).filter(Boolean).forEach(d => evictIds.add(String(d)));
  removeSourcesFromOtherTabs(tabName, evictIds);

  // Draft→order conversion: the order's rows carry source_draft_name = the originating
  // draft order's numeric id. The order's line items get brand-new line_item_ids, so they
  // won't match the existing draft rows — purge ALL pending rows still keyed to that draft
  // up front, then let the order's line items insert fresh below. (Doing this per-row with a
  // pre-built SOURCE_ID index collapsed multi-line orders, because every line item resolved to
  // the same single draft row.) Non-pending draft rows (raised-po / po-created) are preserved.
  const draftIdsToClear = new Set(
    rows.map(r => r.source_draft_name).filter(Boolean).map(String)
  );
  draftIdsToClear.forEach(draftId => removeStaleRows(sheet, C, draftId, new Set()));

  // For each source_id in the payload, delete stale pending rows whose
  // line_item_id is no longer present (handles re-added line items on drafts)
  const incoming = {};
  rows.forEach(r => {
    const sid = String(r.source_id);
    if (!incoming[sid]) incoming[sid] = new Set();
    incoming[sid].add(String(r.line_item_id));
  });
  Object.entries(incoming).forEach(([sid, currentIds]) => removeStaleRows(sheet, C, sid, currentIds));

  const lineItemIndex = buildIndex(sheet, C.LINE_ITEM_ID);
  let inserted = 0, refreshed = 0;

  rows.forEach(row => {
    const lineItemId = String(row.line_item_id);
    const existRow = lineItemIndex[lineItemId];

    if (existRow) {
      const status = sheet.getRange(existRow, C.STATUS).getValue();
      if (status === 'pending') {
        writeRow(sheet, existRow, row, C, false);
        refreshed++;
      } else {
        sheet.getRange(existRow, C.SYNCED_AT).setValue(row.synced_at);
        sheet.getRange(existRow, C.SOURCE_ID).setValue(row.source_id);
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

// Evict a source's pending rows from every tab except the one it now belongs to.
// Keeps a source (and its line items) from appearing in two tabs after reclassification
// or a cross-tab draft→order conversion. raised-po / po-created rows are preserved.
function removeSourcesFromOtherTabs(targetTab, sourceIds) {
  [TAB.MTO, TAB.INSTOCK, TAB.UNCLASSIFIED].forEach(function(name) {
    if (name === targetTab) return;
    const sheet = SS.getSheetByName(name);
    if (!sheet) return;
    const C = getColumnMap(name);
    sourceIds.forEach(function(sid) {
      removeStaleRows(sheet, C, String(sid), new Set()); // empty set → remove all pending for this source
    });
  });
}

function removeStaleRows(sheet, C, sourceId, currentLineItemIds) {
  const last = sheet.getLastRow();
  if (last < 2) return;
  const sourceVals = sheet.getRange(2, C.SOURCE_ID, last - 1, 1).getValues();
  const liVals     = sheet.getRange(2, C.LINE_ITEM_ID, last - 1, 1).getValues();
  const statusVals = sheet.getRange(2, C.STATUS, last - 1, 1).getValues();

  // Collect stale rows bottom-to-top so deleteRow doesn't shift indices
  const toDelete = [];
  for (let i = last - 2; i >= 0; i--) {
    if (String(sourceVals[i][0]) !== String(sourceId)) continue;
    if (currentLineItemIds.has(String(liVals[i][0]))) continue;
    if (statusVals[i][0] === 'pending') toDelete.push(i + 2);
  }
  toDelete.forEach(r => sheet.deleteRow(r));
}

// =================================================================
// One-time dedup — removes duplicate pending rows sharing the same
// line_item_id, keeping the most recently synced one.
// Run from PO Ops → Fix Duplicate Rows after the race-condition bug.
// =================================================================

function dedupAllTabs() {
  var removed = 0;
  [TAB.MTO, TAB.INSTOCK, TAB.UNCLASSIFIED].forEach(function(name) {
    const sheet = SS.getSheetByName(name);
    if (!sheet) return;
    const C    = getColumnMap(name);
    const last = sheet.getLastRow();
    if (last < 2) return;

    const liVals     = sheet.getRange(2, C.LINE_ITEM_ID, last - 1, 1).getValues();
    const statusVals = sheet.getRange(2, C.STATUS,       last - 1, 1).getValues();
    const syncedVals = sheet.getRange(2, C.SYNCED_AT,    last - 1, 1).getValues();

    // For each line_item_id seen multiple times, keep only the row with latest synced_at
    const seen = {}; // line_item_id -> { rowIdx (1-based), syncedAt }
    const toDelete = [];

    for (let i = 0; i < last - 1; i++) {
      const lid    = String(liVals[i][0]);
      const status = statusVals[i][0];
      if (!lid || status !== 'pending') continue; // only dedup pending rows

      const syncedAt = new Date(syncedVals[i][0] || 0).getTime();
      const rowIdx   = i + 2;

      if (!seen[lid]) {
        seen[lid] = { rowIdx, syncedAt };
      } else if (syncedAt >= seen[lid].syncedAt) {
        toDelete.push(seen[lid].rowIdx); // current winner is older — drop it
        seen[lid] = { rowIdx, syncedAt };
      } else {
        toDelete.push(rowIdx); // this row is older — drop it
      }
    }

    // Delete bottom-to-top so row indices stay valid
    toDelete.sort(function(a, b) { return b - a; });
    toDelete.forEach(function(r) { sheet.deleteRow(r); });
    removed += toDelete.length;
  });

  SpreadsheetApp.getUi().alert('Done — removed ' + removed + ' duplicate row(s).');
}

// =================================================================
// Remove all pending rows for a deleted draft order (real-time webhook)
// =================================================================

function removeSourceRows(sourceId) {
  let removed = 0;
  [TAB.MTO, TAB.INSTOCK, TAB.UNCLASSIFIED].forEach(function(name) {
    const sheet = SS.getSheetByName(name);
    if (!sheet) return;
    const C = getColumnMap(name);
    const before = sheet.getLastRow();
    removeStaleRows(sheet, C, String(sourceId), new Set()); // empty set = remove all pending for this source
    removed += Math.max(0, before - sheet.getLastRow());
  });
  return { removed };
}

// =================================================================
// Prune pending rows whose source_id is no longer in the live set
// Called after nightly sync-all. Preserves raised-po / po-created rows.
// =================================================================

function pruneOrphanRows(validSourceIds) {
  const validSet = new Set(validSourceIds.map(String));
  let removed = 0;
  [TAB.MTO, TAB.INSTOCK, TAB.UNCLASSIFIED].forEach(function(name) {
    const sheet = SS.getSheetByName(name);
    if (!sheet) return;
    const C    = getColumnMap(name);
    const last = sheet.getLastRow();
    if (last < 2) return;
    const sourceVals = sheet.getRange(2, C.SOURCE_ID, last - 1, 1).getValues();
    const statusVals = sheet.getRange(2, C.STATUS,    last - 1, 1).getValues();
    const toDelete = [];
    for (let i = last - 2; i >= 0; i--) {
      const sid = String(sourceVals[i][0]);
      if (!sid)               continue;
      if (validSet.has(sid))  continue;
      if (statusVals[i][0] !== 'pending') continue; // keep raised-po / po-created / skip
      toDelete.push(i + 2);
    }
    toDelete.forEach(function(r) { sheet.deleteRow(r); }); // already bottom-to-top
    removed += toDelete.length;
  });
  return { removed };
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
  if (!requireMiddlewareUrl()) return;
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

  // Don't let raised-po rows vanish silently: getApprovedRows drops Unclassified rows whose
  // PO Type is blank, so the log above can read "No raised-po rows" while rows are actually
  // sitting there approved. Surface them explicitly.
  const missingType = unclassifiedRaisedMissingType();
  if (missingType.length) {
    const names = missingType.join(', ');
    Logger.log('⚠️ Unclassified: ' + missingType.length + ' raised-po row(s) NOT raised — PO Type is blank: ' + names);
    try {
      SpreadsheetApp.getUi().alert('⚠️ ' + missingType.length + ' raised-po row(s) in Unclassified were NOT raised because the PO Type column is blank.\n\nFill PO Type (mto / in-stock) for: ' + names + '\n\nThen run Batch Raise again.');
    } catch (_) { /* time-based trigger has no UI — log only */ }
  }
}

// raised-po rows in Unclassified that are skipped only because PO Type (col P) is blank.
function unclassifiedRaisedMissingType() {
  const sheet = SS.getSheetByName(TAB.UNCLASSIFIED);
  if (!sheet) return [];
  const C    = getColumnMap(TAB.UNCLASSIFIED);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const data = sheet.getRange(2, 1, last - 1, tabWidth(TAB.UNCLASSIFIED)).getValues();
  const names = [];
  data.forEach(r => {
    if (r[C.STATUS - 1] === 'raised-po' && !String(r[C.PO_TYPE - 1] || '').trim()) {
      names.push(r[C.ORDER_NAME - 1] || r[C.SKU - 1] || '(row)');
    }
  });
  return names;
}

function callBatchRaise(poType, tabName, rows) {
  const resp = UrlFetchApp.fetch(MIDDLEWARE_URL + '/api/po-ops/batch-raise-po', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ po_type: poType, rows, store_code: getBatchStoreCode() }),
    muteHttpExceptions: true
  });

  const result = JSON.parse(resp.getContentText());
  if (result.ok) {
    try {
      markRaised(tabName, rows.map(r => r.line_item_id), result.batch_id, result.raised_at);
      Logger.log('Batch raised ' + poType + ' (' + tabName + ') — batch_id: ' + result.batch_id);
    } catch (markErr) {
      Logger.log('markRaised FAILED: ' + markErr.message);
      SpreadsheetApp.getUi().alert('⚠️ PO was created in Shopify (' + result.batch_id + ') but sheet update failed:\n' + markErr.message + '\n\nManually set those rows to po-created.');
    }
  } else {
    const msg = result.error || ('HTTP ' + resp.getResponseCode());
    Logger.log('Batch FAILED ' + poType + ' (' + tabName + '): ' + msg);
    SpreadsheetApp.getUi().alert('❌ Batch raise failed for ' + poType + ':\n' + msg);
  }
}

// =================================================================
// Reprice — PO Ops menu > "Reprice Selected Row"
// Works on MTO tab and Unclassified tab (MTO rows only).
// Reads jewel measurements + gold rate, calls middleware.
// =================================================================

function repriceTrigger() {
  if (!requireMiddlewareUrl()) return;
  const ui    = SpreadsheetApp.getUi();
  const sheet = SS.getActiveSheet();
  const name  = sheet.getName();
  Logger.log('[REPRICE] active sheet: ' + name + ', row: ' + sheet.getActiveCell().getRow());

  const isMto = name === TAB.MTO;
  const isUc  = name === TAB.UNCLASSIFIED;

  if (!isMto && !isUc) {
    ui.alert('Reprice only works on the MTO or Unclassified tab.\n\nDetected tab: "' + name + '"\n\nIf you are already on MTO, use the custom menu (PO Ops → Reprice Selected Row), not the Run button in the Apps Script editor.');
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
// Scheduled sync — called by daily trigger at 7 AM IST (01:30 UTC)
// Catches any draft/order changes missed by webhooks
// =================================================================

function syncAllTrigger() {
  if (!requireMiddlewareUrl()) return;
  const ui   = SpreadsheetApp.getUi();
  const resp = UrlFetchApp.fetch(MIDDLEWARE_URL + '/api/po-ops/sync-all', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({}),
    muteHttpExceptions: true
  });
  const result = JSON.parse(resp.getContentText());
  Logger.log('[SYNC-ALL] ' + JSON.stringify(result));
  if (result.ok) {
    ui.alert('✅ Sync started — all drafts and orders are being pulled into the sheet. Check back in ~30 seconds.');
  } else {
    ui.alert('❌ Sync failed: ' + (result.error || resp.getResponseCode()));
  }
}

// =================================================================
// One-time setup: install daily triggers
//   7 AM IST  (01:30 UTC) — full sync (catch missed webhooks)
//   8 PM IST  (14:30 UTC) — batch PO raise
// Run this once from the Apps Script editor to install both triggers.
// =================================================================

function setupDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['batchRaisePoDailyTrigger', 'syncAllTrigger'].includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('syncAllTrigger')
    .timeBased()
    .atHour(1)
    .nearMinute(30)
    .everyDays(1)
    .create();

  ScriptApp.newTrigger('batchRaisePoDailyTrigger')
    .timeBased()
    .atHour(14)
    .nearMinute(30)
    .everyDays(1)
    .create();

  Logger.log('Daily triggers set: sync at 7:00 AM IST, batch raise at 8:00 PM IST');
}
