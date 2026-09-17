/**
 * Google Apps Script — PO Tracker Web App
 * =========================================
 * Replaces the need for a Google service account.
 * Deploy this as a web app (execute as: Me, access: Anyone).
 *
 * SETUP INSTRUCTIONS:
 * 1. Open Google Sheets → Extensions → Apps Script
 * 2. Replace the default code with this file
 * 3. Set SHEET_ID to your spreadsheet ID (from the URL)
 * 4. Click Deploy → New Deployment → Web App
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. Copy the web app URL → paste as APPS_SCRIPT_URL env var in Supabase
 *
 * IMPORTANT: Each time you change the script, create a NEW deployment version.
 * The URL stays the same if you deploy to the same deployment.
 */

const SHEET_ID  = "1nYHTlg9fbxV-SvidxROCWbM-geKMVGv7LlUkE-buA-k";
const TAB_NAME  = "PO_Log";

const COLUMNS = [
  "po_number",
  "po_type",
  "source_order",
  "customer_name",
  "item_description",
  "gati_id",
  "sku",
  "priority",
  "target_dispatch",
  "customer_promise",
  "po_sent_at",
  "acknowledged_at",
  "ordered_at",
  "qc_at",
  "shipped_at",
  "received_at",
  "notes"
];

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TAB_NAME);

    if (payload.action === "append") {
      // Write a new row
      const row = COLUMNS.map(col => payload.row[col] ?? "");
      sheet.appendRow(row);
      return ContentService.createTextOutput(JSON.stringify({ ok: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (payload.action === "update") {
      // Find the row by po_number (column A = index 1)
      const data = sheet.getDataRange().getValues();
      const poNumberColIdx = COLUMNS.indexOf("po_number"); // 0-based
      const targetColIdx   = COLUMNS.indexOf(payload.column); // 0-based

      if (targetColIdx === -1) {
        return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "Unknown column: " + payload.column }))
          .setMimeType(ContentService.MimeType.JSON);
      }

      for (let i = 1; i < data.length; i++) { // skip header row
        if (data[i][poNumberColIdx] === payload.po_number) {
          sheet.getRange(i + 1, targetColIdx + 1).setValue(payload.value);
          return ContentService.createTextOutput(JSON.stringify({ ok: true, row: i + 1 }))
            .setMimeType(ContentService.MimeType.JSON);
        }
      }

      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "PO not found: " + payload.po_number }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "Unknown action" }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ── Setup helper — run this once to create the header row ──────────────────
// Run from Apps Script editor: select setupSheet → Run
function setupSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(TAB_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(TAB_NAME);
  }

  // Write header row
  sheet.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]);

  // Bold + freeze header
  sheet.getRange(1, 1, 1, COLUMNS.length).setFontWeight("bold").setBackground("#2F5496").setFontColor("#FFFFFF");
  sheet.setFrozenRows(1);

  // Set column widths
  sheet.setColumnWidth(1, 100);  // po_number
  sheet.setColumnWidth(2, 130);  // po_type
  sheet.setColumnWidth(3, 110);  // source_order
  sheet.setColumnWidth(4, 160);  // customer_name
  sheet.setColumnWidth(5, 240);  // item_description
  sheet.setColumnWidth(6, 100);  // gati_id
  sheet.setColumnWidth(7, 160);  // sku
  sheet.setColumnWidth(8, 90);   // priority
  sheet.setColumnWidth(9, 130);  // target_dispatch
  sheet.setColumnWidth(10, 150); // customer_promise
  for (let i = 11; i <= 17; i++) sheet.setColumnWidth(i, 150); // timestamps

  // Conditional formatting
  const range = sheet.getRange(2, 1, 1000, COLUMNS.length);
  const rules = [];

  // pending (po_sent_at set, acknowledged_at empty) → yellow
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(`=AND($K2<>"",$L2="")`)
    .setBackground("#FFF9C4").setRanges([range]).build());

  // acknowledged → light blue
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(`=AND($L2<>"",$M2="")`)
    .setBackground("#E3F2FD").setRanges([range]).build());

  // ordered → orange
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(`=AND($M2<>"",$N2="")`)
    .setBackground("#FFE0B2").setRanges([range]).build());

  // qc_passed → purple tint
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(`=AND($N2<>"",$O2="")`)
    .setBackground("#EDE7F6").setRanges([range]).build());

  // shipped → green
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(`=AND($O2<>"",$P2="")`)
    .setBackground("#E8F5E9").setRanges([range]).build());

  // received → grey
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(`=$P2<>""`)
    .setBackground("#F5F5F5").setFontColor("#9E9E9E").setRanges([range]).build());

  sheet.setConditionalFormatRules(rules);

  Logger.log("Sheet setup complete: " + TAB_NAME);
}
