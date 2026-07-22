// ─────────────────────────────────────────────────────────────────────────────
// TIMANTI — EXCHANGE CREDIT NOTE APPS SCRIPT
// Paste this entire file into Extensions → Apps Script inside the Google Sheet.
//
// SETUP (one-time):
//   1. Open Extensions → Apps Script → paste this file, save
//   2. Timanti CN Tools → "⚙️  Setup Auto-fill Triggers"  (approve permissions)
//   3. Timanti CN Tools → "🔑  Setup Supabase Credentials"
//
// AUTO-FILL FLOW:
//   • Type an order number in B7  → B4 name, B5 email, B6 phone, B8 date auto-fill
//     – 1 line item  → B10 SKU, B12 karat, B15 net wt, B16 dia cts auto-fill
//                      B19 gold rate (order properties), C19 live gold rate (variant metafield)
//                      B20 & C20 dia value (variant metafield custom.price_breakup_diamond)
//     – Multiple     → checkbox dialog appears; pick one or more SKUs
//                      Net wt & dia cts are summed; gold rates shown as X/Y per SKU
//   • Select a SKU in B10 manually → same fields auto-fill (single-SKU path)
//
// SHOPIFY TOKEN  : fetched live from Supabase config table (key = shopify_access_token)
// SHOPIFY SCOPES : read_orders, write_orders, write_discounts
// ─────────────────────────────────────────────────────────────────────────────

const SHOPIFY_SHOP    = 'auracarat.myshopify.com';
const CALC_SHEET_NAME = 'Exchange Calculator';
const STORE_CODE      = 'KA-HSR';   // issuing store fallback when STORE_CODE_CELL is blank

// ─────────────────────────────────────────────────────────────────────────────
// LAYOUT — controls-at-top (v2). Every cell the script reads/writes is named here;
// there are NO hardcoded A1 refs elsewhere, so the layout is defined entirely by
// this block. The restructureControlsToTop() migration rearranges a legacy sheet
// to match: it inserts 14 rows at the top for the CONTROLS block, which shifts the
// old customer/order/calc rows down by 14 (Google Sheets auto-adjusts every calc
// formula), then re-points these constants. Data cells below are the legacy rows + 14.
// ─────────────────────────────────────────────────────────────────────────────

// ── CONTROLS (top block, rows 1-14) ──
const DOCTYPE_CELL     = 'B4';   // dropdown: Voucher | Exchange Note        (label A4)
const NEWDRAFT_CELL    = 'B6';   // new sale's draft/order # (Exchange Note)  (label A6)
const STORE_CODE_CELL  = 'B5';   // staff-set issuing store, overrides STORE_CODE when non-blank (label A5)
const SOURCE_CELL          = 'B2';   // dropdown: Purchase Exchange | Old Gold   (label A2)
const EXCHTYPE_CELL        = 'B3';   // dropdown: Deduction | Full Value         (label A3)
const OG_CUSTOMER_CELL     = 'B8';   // Old Gold: phone or email to look up the customer (label A8)
const OG_CUSTID_CELL       = 'B9';   // Old Gold: resolved "id | name" (auto, locked)    (label A9)
const OG_WEIGHT_CELL       = 'B10';  // Old Gold: gross weight in grams                  (label A10)
const OG_PURITY_CELL       = 'B11';  // Old Gold: purity in karat (9..24)                (label A11)
const OG_RATE_CELL         = 'B12';  // Old Gold: buy-back rate/g (auto, locked)         (label A12)
const OVERRIDE_REASON_CELL = 'B13';  // reason, required when the final value is overridden (label A13)

// ── DATA (customer / order / item / weights / rates / calc), rows shifted +14 ──
const CUST_NAME_CELL   = 'B18';  // was B4
const CUST_EMAIL_CELL  = 'B19';  // was B5
const CUST_PHONE_CELL  = 'B20';  // was B6
const ORDER_NUM_CELL   = 'B21';  // was B7  (drives the SKU lookup)
const ORDER_DATE_CELL  = 'B22';  // was B8
const SKU_CELL         = 'B24';  // was B10 (the SKU picker dropdown)
const KARAT_CELL       = 'B26';  // was B12
const NET_WT_CELL      = 'B29';  // was B15
const DIA_CTS_CELL     = 'B30';  // was B16
const GOLD_RATE_ORD_CELL  = 'B33';  // was B19 (order-time gold rate, "X / Y" for multi)
const GOLD_RATE_LIVE_CELL = 'C33';  // was C19 (live gold rate, "X / Y" for multi)
const GOLD_RATE_EFF_CELL  = 'D33';  // was D19 (weighted effective rate — B27 formula base)
const LGD_RATE_CELL    = 'B34';  // was B20
const DIA_VALUE_CELL   = 'C34';  // was C20 (variant diamond value; the '=C20' base)
const GOLD_VAL_CELL    = 'B41';  // was B27
const DIA_VAL_CELL     = 'B42';  // was B28
const NET_VALUE_CELL   = 'B50';  // was B36 (NET CREDIT NOTE VALUE — the final value)
const DOCNUM_OUT_CELL  = 'B57';  // was B43 (script writes the VCH/EXC number here)

const RESTRUCTURE_ROWS = 14;     // rows inserted at top by restructureControlsToTop()

const SOURCE_OLD_GOLD      = 'old gold';   // SOURCE_CELL value (lower-cased) that triggers the old-gold flow
const EXCHTYPE_FULL        = 'full';       // EXCHTYPE_CELL value (lower-cased prefix) for full-invoice-value
// Customer-facing email kill-switch. FALSE while testing so test runs never mail a real customer.
// Flip to true for go-live. Guards BOTH sendVoucherEmail_ and sendExcEmail_ — the only two send
// paths (the middleware never mails on its own; /api/exc-redeem sends nothing).
const SEND_CUSTOMER_EMAILS = false;

const VOUCHER_LOG     = 'Voucher Log';   // renamed from 'CN Log'
const EXCHANGE_LOG    = 'Exchange Log';  // new tab for Exchange Notes

// Row number from an A1 cell ref (e.g. 'B21' → 21). Used so onEdit/layout logic follows the
// layout constants instead of hardcoding rows.
function cellRow_(a1) { return Number(String(a1).replace(/^[A-Z]+/, '')); }

// ── MENU ─────────────────────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Timanti CN Tools')
    .addItem('✅  Create Document (Voucher / Exchange)', 'createDocument')
    .addItem('🗑️  Void Voucher', 'voidVoucher')
    .addItem('🗑️  Void Exchange Note', 'voidExchangeNote')
    .addSeparator()
    .addItem('🔄  Lookup Order Now', 'lookupOrderManual')
    .addItem('🔎  Look up Old-Gold customer', 'lookupOldGoldCustomer')
    .addItem('⚖️  Fetch Old-Gold buy-back rate', 'fetchOldGoldRate')
    .addSeparator()
    .addItem('🏗️  Rebuild calculator (fresh, controls on top)', 'buildExchangeCalculator')
    .addItem('🔧  Restructure existing sheet (migrate in place)', 'restructureControlsToTop')
    .addItem('⚙️  Setup Auto-fill Triggers', 'setupTriggers')
    .addItem('🗑️  Remove Auto-fill Triggers', 'removeTriggers')
    .addSeparator()
    .addItem('🔑  Setup Supabase Credentials', 'setupSupabase')
    .addItem('🔍  Test API Connection', 'testConnection')
    .addItem('🐛  Debug Cell Values', 'debugCells')
    .addItem('🐛  Show Line Item Properties', 'showLineItemProperties')
    .addToUi();
}

// One-time structural setup: builds the Document Type dropdown (DOCTYPE_CELL) + New Draft/Order #
// field (NEWDRAFT_CELL), labels, default, help note, and a conditional format that grays the
// New Draft cell when "Voucher" is selected.
// Safe to re-run (idempotent). Also creates the Voucher Log / Exchange Log tabs if missing.
function setupDocTypeFields() {
  var ss   = SpreadsheetApp.getActiveSpreadsheet();
  var calc = ss.getSheetByName(CALC_SHEET_NAME);
  var ui   = SpreadsheetApp.getUi();
  if (!calc) { ui.alert('Sheet "' + CALC_SHEET_NAME + '" not found.'); return; }

  var docTypeRange  = calc.getRange(DOCTYPE_CELL);
  var newDraftRange = calc.getRange(NEWDRAFT_CELL);

  // SAFETY GUARD: refuse to write if the target cells (or their labels) already hold
  // something that isn't ours. Protects the live sheet even if the row guess is off.
  var docLabelRange = calc.getRange(docTypeRange.getRow(),  docTypeRange.getColumn()  - 1);
  var drfLabelRange = calc.getRange(newDraftRange.getRow(), newDraftRange.getColumn() - 1);
  var ours = { 'Document Type': 1, 'Voucher': 1, 'Exchange Note': 1,
               'New Draft/Order # (Exchange Note only)': 1 };
  var blocked = [docLabelRange, docTypeRange, drfLabelRange, newDraftRange].filter(function (r) {
    var v = String(r.getValue()).trim();
    return v !== '' && !ours[v];
  });
  if (blocked.length) {
    ui.alert('Aborted — row ' + docTypeRange.getRow() + ' is not empty.\n\n' +
      blocked.map(function (r) { return '  • ' + r.getA1Notation() + ' = "' + String(r.getValue()).trim() + '"'; }).join('\n') +
      '\n\nNothing was changed. Tell me a different free row and I\'ll move DOCTYPE_CELL / NEWDRAFT_CELL.');
    return;
  }

  // Labels in the column immediately left of each field.
  calc.getRange(docTypeRange.getRow(),  docTypeRange.getColumn()  - 1).setValue('Document Type');
  calc.getRange(newDraftRange.getRow(), newDraftRange.getColumn() - 1).setValue('New Draft/Order # (Exchange Note only)');

  // Dropdown on the Document Type cell.
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['Voucher', 'Exchange Note'], true)
    .setAllowInvalid(false)
    .setHelpText('Voucher = 1-year store credit (discount code). Exchange Note = instant deduction on a new invoice.')
    .build();
  docTypeRange.setDataValidation(rule);
  if (!String(docTypeRange.getValue()).trim()) docTypeRange.setValue('Voucher');

  newDraftRange.setNote('Only for Exchange Note. Enter the new sale\'s draft order number (e.g. #D123) — the exchange value is deducted from that invoice.');

  // Gray out the New Draft cell whenever the doc type is Voucher (visual "not needed" cue).
  var keep = calc.getConditionalFormatRules().filter(function (r) {
    var rngs = r.getRanges();
    return !rngs.some(function (g) { return g.getA1Notation() === newDraftRange.getA1Notation(); });
  });
  var absDocType = docTypeRange.getA1Notation().replace(/([A-Z]+)(\d+)/, '$$$1$$$2'); // B37 → $B$37
  keep.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=' + absDocType + '="Voucher"')
    .setBackground('#efefef')
    .setRanges([newDraftRange])
    .build());
  calc.setConditionalFormatRules(keep);

  // Ensure log tabs exist.
  if (!ss.getSheetByName(VOUCHER_LOG)) {
    var old = ss.getSheetByName('CN Log');
    if (old) old.setName(VOUCHER_LOG); else ss.insertSheet(VOUCHER_LOG);
  }
  if (!ss.getSheetByName(EXCHANGE_LOG)) {
    var ex = ss.insertSheet(EXCHANGE_LOG);
    ex.appendRow(['Issued', 'EXC Number', 'Old Order', 'New Draft', 'Customer', 'Email',
                  'Net Wt', 'Dia Wt', 'Gold Val', 'Dia Val', 'Exchange Value', 'Status', 'New Draft ID']);
  }

  ui.alert('Document Type fields ready:\n\n' +
    '• ' + DOCTYPE_CELL + ' — dropdown (Voucher / Exchange Note), default Voucher\n' +
    '• ' + NEWDRAFT_CELL + ' — New Draft/Order # (grays out for Voucher)\n\n' +
    'Tabs: "' + VOUCHER_LOG + '" and "' + EXCHANGE_LOG + '" are present.');
}

// ── AUTO-FILL: INSTALLABLE onEdit HANDLER ────────────────────────────────────
// Installed via setupTriggers(). Runs under the account that created the trigger.
// Errors are surfaced via ui.alert so silent failures can't happen.
function handleEdit(e) {
  try {
    const sheet = e.range.getSheet();
    if (sheet.getName() !== CALC_SHEET_NAME) return;
    const col = e.range.getColumn();
    const row = e.range.getRow();
    if (col === 2 && row === cellRow_(ORDER_NUM_CELL)) { onOrderNumberEntered(sheet); return; }
    if (col === 2 && row === cellRow_(SKU_CELL))       { onSkuSelected(sheet);        return; }
    // Old-gold auto-fill: purity → buy-back rate (+ value into B36); weight → refresh value;
    // customer phone/email → resolve customer.
    if (e.range.getA1Notation() === OG_PURITY_CELL) { try { fetchOldGoldRate(); } catch (x) {} return; }
    if (e.range.getA1Notation() === OG_WEIGHT_CELL) { try { showOldGoldValue_(sheet, oldGoldValue_(sheet)); } catch (x) {} return; }
    if (e.range.getA1Notation() === OG_CUSTOMER_CELL) { try { lookupOldGoldCustomer(); } catch (x) {} return; }
  } catch (err) {
    SpreadsheetApp.getUi().alert('❌ Auto-fill error:\n' + err.message);
  }
}

// ── ORDER NUMBER → populate customer fields + SKU picker ─────────────────────
// allowModal: true when called from a menu item (has container.ui scope);
//             false/omitted when called from the installable onEdit trigger (no UI scope).
function onOrderNumberEntered(sheet, allowModal) {
  const raw = String(sheet.getRange(ORDER_NUM_CELL).getValue()).trim();
  if (!raw) return;

  // Clear all previously auto-filled cells
  [CUST_NAME_CELL, CUST_EMAIL_CELL, CUST_PHONE_CELL, ORDER_DATE_CELL, SKU_CELL, KARAT_CELL,
   NET_WT_CELL, DIA_CTS_CELL, GOLD_RATE_ORD_CELL, LGD_RATE_CELL, GOLD_RATE_LIVE_CELL,
   DIA_VALUE_CELL, GOLD_RATE_EFF_CELL, GOLD_VAL_CELL, DIA_VAL_CELL].forEach(function(ref) {
    sheet.getRange(ref).clearContent();
  });
  sheet.getRange(SKU_CELL).clearDataValidations();

  const orderName = raw.replace('#', '');

  // Single API call — fetch everything needed in one shot
  const data = shopifyGet(
    'orders.json?name=%23' + orderName +
    '&status=any&fields=id,customer,line_items,shipping_address,billing_address,created_at'
  );

  if (!data || !data.orders || data.orders.length === 0) {
    SpreadsheetApp.getUi().alert('Order #' + orderName + ' not found in Shopify.');
    return;
  }

  const order    = data.orders[0];
  const customer = order.customer || {};

  // ── Customer fields ──────────────────────────────────────────────────────
  const name  = [customer.first_name, customer.last_name].filter(Boolean).join(' ');
  const email = customer.email || '';

  // Phone: shipping first, fallback to billing
  var phone = '';
  if (order.shipping_address && order.shipping_address.phone) {
    phone = order.shipping_address.phone;
  } else if (order.billing_address && order.billing_address.phone) {
    phone = order.billing_address.phone;
  }

  // Order date — guard against missing/invalid created_at
  var orderDate = '';
  try {
    if (order.created_at) {
      orderDate = Utilities.formatDate(new Date(order.created_at), 'Asia/Kolkata', 'dd-MM-yyyy');
    }
  } catch (_) {}

  sheet.getRange(CUST_NAME_CELL).setValue(name);
  sheet.getRange(CUST_EMAIL_CELL).setValue(email);
  sheet.getRange(CUST_PHONE_CELL).setValue(phone);
  sheet.getRange(ORDER_DATE_CELL).setValue(orderDate);

  // ── Line items ───────────────────────────────────────────────────────────
  const lineItems = order.line_items || [];
  if (lineItems.length === 0) return;

  // Count UNITS, not lines — a single qty-2 line must still offer a picker, or staff would
  // silently exchange one unit's worth of gold for a two-unit purchase.
  const expanded = expandLineItems_(lineItems);

  if (expanded.length === 1) {
    // Auto-select and populate immediately
    sheet.getRange(SKU_CELL).setValue(expanded[0].label);
    populateFromLineItem(sheet, lineItems[0]);
    return;
  }

  // Multiple SKUs — two paths depending on whether we have UI access:
  //   Menu ("Lookup Order Now") → modal dialog, supports multi-select + aggregation
  //   Trigger (auto onEdit)    → dropdown on B10, single-SKU selection
  if (allowModal) {
    showSkuCheckboxDialog(lineItems);
    return;
  }

  // Trigger path: no container.ui scope — use data validation dropdown instead.
  // User picks one SKU; onSkuSelected fires and populates that item's fields.
  // For multi-SKU aggregation use "🔄 Lookup Order Now" from the menu.
  var skuList = expanded.map(function(e) { return e.label; });
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(skuList, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(SKU_CELL).clearContent();
  sheet.getRange(SKU_CELL).setDataValidation(rule);
  sheet.getRange(SKU_CELL).setNote(
    skuList.length + ' SKUs found.\n' +
    '• Pick one below for single-item rates.\n' +
    '• Use "🔄 Lookup Order Now" in the menu to select multiple SKUs.'
  );
}

// Expands each Shopify line item into one entry PER UNIT. Shopify stores "2 of the same ring" as a
// single line item with quantity:2 — the old code counted it once, paying out half the gold. Each
// unit becomes its own pickable row ("SKU (1 of 2)") so staff exchange exactly the units in hand.
// Returns [{ li, label }]; li is shared by reference (read-only downstream).
function expandLineItems_(lineItems) {
  var out = [];
  (lineItems || []).forEach(function (li) {
    var qty  = Math.max(1, parseInt(li.quantity, 10) || 1);
    var base = li.sku || li.title || '';
    for (var n = 1; n <= qty; n++) {
      out.push({ li: li, label: qty > 1 ? base + ' (' + n + ' of ' + qty + ')' : base });
    }
  });
  return out;
}

// Strips the " (n of q)" unit suffix added by expandLineItems_, recovering the raw SKU.
function stripUnitSuffix_(label) {
  return String(label || '').replace(/\s*\(\d+ of \d+\)\s*$/, '').trim();
}

// ── MULTI-SKU PROMPT (menu path — avoids showModalDialog scope restriction) ───
// Uses ui.prompt (plain text input) which works with the same scope as alert().
function showSkuCheckboxDialog(lineItems) {
  var ui       = SpreadsheetApp.getUi();
  // One row per UNIT, not per line item — a qty-2 line offers two tickable rows.
  var expanded = expandLineItems_(lineItems);
  var numbered = expanded.map(function(e, i) {
    return (i + 1) + '. ' + (e.label || 'Item ' + (i + 1));
  }).join('\n');

  var result = ui.prompt(
    'Select SKUs for Exchange',
    numbered + '\n\nEnter item numbers separated by commas (e.g. "1" or "1,2"):',
    ui.ButtonSet.OK_CANCEL
  );

  if (result.getSelectedButton() !== ui.Button.OK) return;

  var raw     = result.getResponseText().trim();
  var indices = raw.split(/[,\s]+/)
    .map(function(s) { return parseInt(s.trim(), 10) - 1; })
    .filter(function(i) { return !isNaN(i) && i >= 0 && i < expanded.length; });

  if (!indices.length) {
    ui.alert('No valid numbers entered. Use "1" for item 1, "1,2" for both.');
    return;
  }

  // Store so applySkuSelection can look them up
  PropertiesService.getScriptProperties().setProperty('_PENDING_LINE_ITEMS', JSON.stringify(lineItems));
  applySkuSelection(indices);
}

// Called directly from showSkuCheckboxDialog (indices already resolved)
function applySkuSelection(selectedIndices) {
  var json = PropertiesService.getScriptProperties().getProperty('_PENDING_LINE_ITEMS');
  if (!json) throw new Error('Session expired — re-enter the order number and try again.');

  // Rebuild the per-unit expansion rather than storing it — duplicated line-item objects would
  // push the stored JSON toward the 9 KB Script Properties limit that already bit this flow once.
  var lineItems = JSON.parse(json);
  var expanded  = expandLineItems_(lineItems);
  var selected  = selectedIndices.map(function(i) { return expanded[i].li; });

  var sheet    = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CALC_SHEET_NAME);
  var skuLabel = selectedIndices.map(function(i) { return expanded[i].label; }).join(', ');
  sheet.getRange(SKU_CELL).setValue(skuLabel);
  sheet.getRange(SKU_CELL).clearDataValidations();
  sheet.getRange(SKU_CELL).clearNote();

  if (selected.length === 1) {
    populateFromLineItem(sheet, selected[0]);
  } else {
    populateFromMultipleLineItems(sheet, selected);
  }
}

// Aggregate net wt, dia cts, gold value, and dia value across multiple SKUs.
// B19 shows order-time rates as "X / Y", C19 shows live rates as "X / Y" (human-readable only).
//
// D19 carries the WEIGHTED EFFECTIVE gold rate (total gold value ÷ total weight) so B27 can stay a
// real formula (=B15*D19) in both the single- and multi-SKU cases. Previously the multi case wrote
// B27 as a static number — arithmetically right at the instant of selection, but frozen: editing
// the weight afterwards left the value stale with no warning. C19 can't be used for this because
// it holds display text like "10980 / 9500", and text can't be multiplied.
function populateFromMultipleLineItems(sheet, lineItems) {
  var totalNetWt       = 0;
  var totalDiaCts      = 0;
  var totalLiveDiaVal  = 0;
  var totalLiveGoldVal = 0;
  var orderRates       = [];
  var liveRates        = [];
  var karat            = null;
  var karats           = [];   // every distinct karat seen — a mixed lot must not silently show one
  var ratedNetWt       = 0;    // weight of items that actually had a live rate (weighted-avg base)
  var hasNetWt         = false;
  var hasDiaCts        = false;
  var hasDiaVal        = false;

  lineItems.forEach(function(li) {
    var props = {};
    (li.properties || []).forEach(function(p) { props[p.name] = p.value; });

    var netWt         = props['_net_wt']      != null ? parseFloat(props['_net_wt'])      : null;
    var diaCts        = props['_diamond_cts'] != null ? parseFloat(props['_diamond_cts']) : null;
    var goldRateOrder = props['_gold_rate']   != null ? parseFloat(props['_gold_rate'])   : null;
    var goldRateLive  = null;
    var diaValue      = null;

    if (li.variant_id) {
      var vmData = shopifyGet('variants/' + li.variant_id + '/metafields.json');
      if (vmData && vmData.metafields) {
        var vmf = {};
        vmData.metafields.forEach(function(mf) {
          if (mf.namespace === 'custom') vmf[mf.key] = mf.value;
        });
        if (netWt === null && vmf['net_metal_weight_g']   != null) netWt        = parseFloat(vmf['net_metal_weight_g']);
        if (vmf['gold_rate']             != null)                   goldRateLive = parseFloat(vmf['gold_rate']);
        if (vmf['price_breakup_diamond'] != null)                   diaValue     = parseFloat(vmf['price_breakup_diamond']);
      }
    }

    if (diaCts === null && li.product_id) {
      var pmData = shopifyGet('products/' + li.product_id + '/metafields.json');
      if (pmData && pmData.metafields) {
        pmData.metafields.forEach(function(mf) {
          if (mf.namespace === 'custom' && mf.key === 'totaldiamondweight' && diaCts === null) {
            diaCts = parseFloat(mf.value);
          }
        });
      }
    }

    if (netWt        !== null) { totalNetWt  += netWt;  hasNetWt  = true; }
    if (diaCts       !== null) { totalDiaCts += diaCts; hasDiaCts = true; }
    if (diaValue     !== null) { totalLiveDiaVal += diaValue; hasDiaVal = true; }
    if (goldRateOrder !== null) orderRates.push(goldRateOrder);
    if (goldRateLive  !== null) {
      liveRates.push(goldRateLive);
      if (netWt !== null) { totalLiveGoldVal += netWt * goldRateLive; ratedNetWt += netWt; }
    }
    var k = extractKarat(li.sku);
    if (k && karats.indexOf(k) === -1) karats.push(k);
    if (!karat) karat = k;
  });

  if (hasNetWt)  sheet.getRange(NET_WT_CELL).setValue(totalNetWt);
  if (hasDiaCts) sheet.getRange(DIA_CTS_CELL).setValue(totalDiaCts);
  // Mixed-karat lots show every karat ("18K / 22K") rather than silently printing the first one.
  if (karats.length) sheet.getRange(KARAT_CELL).setValue(karats.join(' / '));

  if (orderRates.length) sheet.getRange(GOLD_RATE_ORD_CELL).setValue(orderRates.join(' / '));
  if (liveRates.length)  sheet.getRange(GOLD_RATE_LIVE_CELL).setValue(liveRates.join(' / '));

  if (hasDiaVal) {
    sheet.getRange(LGD_RATE_CELL).setValue(totalLiveDiaVal);
    sheet.getRange(DIA_VALUE_CELL).setValue(totalLiveDiaVal);
  }

  // Weighted effective rate → B27 stays a live formula. Divide by the RATED weight only, so an
  // item with no live rate can't dilute the average; if that leaves rated < total weight the
  // formula would over-credit the unrated grams, so warn instead of silently mispricing.
  if (totalLiveGoldVal > 0 && ratedNetWt > 0) {
    sheet.getRange(GOLD_RATE_EFF_CELL).setValue(totalLiveGoldVal / ratedNetWt);
    sheet.getRange(GOLD_RATE_EFF_CELL).setNote('Weighted effective gold rate (auto). gold value = weight × this rate. Do not edit.');
    sheet.getRange(GOLD_VAL_CELL).setFormula('=' + NET_WT_CELL + '*' + GOLD_RATE_EFF_CELL);
    if (Math.abs(ratedNetWt - totalNetWt) > 0.0001) {
      SpreadsheetApp.getUi().alert(
        '⚠️ Some selected items have no live gold rate.\n\n' +
        'Rated weight: ' + ratedNetWt.toFixed(3) + ' g of ' + totalNetWt.toFixed(3) + ' g total.\n\n' +
        'The gold value now applies the weighted rate to the FULL weight, which over-credits the ' +
        'unrated grams. Check the variant metafields before issuing.');
    }
  }
  if (hasDiaVal) sheet.getRange(DIA_VAL_CELL).setFormula('=' + DIA_VALUE_CELL);

  SpreadsheetApp.flush();
}

// ── SKU SELECTED → populate jewel fields ─────────────────────────────────────
// Does a fresh Shopify call — avoids Script Properties 9 KB limit that caused
// silent cache failures. Low-volume tool so the extra call is fine.
function onSkuSelected(sheet) {
  const selected  = String(sheet.getRange(SKU_CELL).getValue()).trim();
  if (!selected) return;

  const orderName = String(sheet.getRange(ORDER_NUM_CELL).getValue()).trim().replace('#', '');
  if (!orderName) return;

  const data = shopifyGet(
    'orders.json?name=%23' + orderName + '&status=any&fields=id,line_items'
  );

  if (!data || !data.orders || data.orders.length === 0) {
    SpreadsheetApp.getUi().alert('Order #' + orderName + ' not found — cannot load SKU data.');
    return;
  }

  const lineItems = data.orders[0].line_items || [];
  const wanted    = stripUnitSuffix_(selected);   // dropdown labels carry a " (1 of 2)" unit suffix
  const li        = lineItems.find(function(item) {
    return (item.sku || item.title) === wanted;
  });

  if (!li) {
    SpreadsheetApp.getUi().alert('SKU "' + selected + '" not found in order #' + orderName + '.');
    return;
  }

  populateFromLineItem(sheet, li);
}

// ── POPULATE JEWEL FIELDS FROM A SINGLE LINE ITEM ────────────────────────────
// B19  = gold rate locked at order time (line item property _gold_rate)
// C19  = live gold rate right now       (variant metafield custom.gold_rate)
// B20  = live diamond value             (variant metafield custom.price_breakup_diamond)
// C20  = same live diamond value        (shown in C column for formula use)
// B27  = live gold value formula  → =B15*C19  (adjust if your formula differs)
// B28  = live diamond value formula → =C20
function populateFromLineItem(sheet, lineItem) {
  var props = {};
  (lineItem.properties || []).forEach(function(p) { props[p.name] = p.value; });

  var netWt         = props['_net_wt']      != null ? parseFloat(props['_net_wt'])      : null;
  var diaCts        = props['_diamond_cts'] != null ? parseFloat(props['_diamond_cts']) : null;
  var goldRateOrder = props['_gold_rate']   != null ? parseFloat(props['_gold_rate'])   : null;

  var goldRateLive = null;
  var diaValue     = null;

  // Always fetch variant metafields — needed for C19, B20/C20, and net wt fallback
  if (lineItem.variant_id) {
    var vmData = shopifyGet('variants/' + lineItem.variant_id + '/metafields.json');
    if (vmData && vmData.metafields) {
      var vmf = {};
      vmData.metafields.forEach(function(mf) {
        if (mf.namespace === 'custom') vmf[mf.key] = mf.value;
      });
      if (netWt === null && vmf['net_metal_weight_g']    != null) netWt        = parseFloat(vmf['net_metal_weight_g']);
      if (vmf['gold_rate']              != null)                   goldRateLive = parseFloat(vmf['gold_rate']);
      if (vmf['price_breakup_diamond']  != null)                   diaValue     = parseFloat(vmf['price_breakup_diamond']);
    }
  }

  // Product metafield fallback for diamond carats
  if (diaCts === null && lineItem.product_id) {
    var pmData = shopifyGet('products/' + lineItem.product_id + '/metafields.json');
    if (pmData && pmData.metafields) {
      pmData.metafields.forEach(function(mf) {
        if (mf.namespace === 'custom' && mf.key === 'totaldiamondweight' && diaCts === null) {
          diaCts = parseFloat(mf.value);
        }
      });
    }
  }

  if (netWt         !== null) sheet.getRange(NET_WT_CELL).setValue(netWt);
  if (diaCts        !== null) sheet.getRange(DIA_CTS_CELL).setValue(diaCts);
  if (goldRateOrder !== null) sheet.getRange(GOLD_RATE_ORD_CELL).setValue(goldRateOrder);
  if (goldRateLive  !== null) sheet.getRange(GOLD_RATE_LIVE_CELL).setValue(goldRateLive);
  if (diaValue      !== null) {
    sheet.getRange(LGD_RATE_CELL).setValue(diaValue);
    sheet.getRange(DIA_VALUE_CELL).setValue(diaValue);
    // B28 driven by C20 so the 80%/100% rows stay live
    sheet.getRange(DIA_VAL_CELL).setFormula('=' + DIA_VALUE_CELL);
  }
  // B27 driven by D19 (the effective rate) so single- and multi-SKU use ONE formula shape.
  // Single SKU: D19 is just this item's rate. Multi: it's the weighted average. See
  // populateFromMultipleLineItems for why C19 can't be used (it holds display text there).
  // If your B27 formula includes a karat purity factor (e.g. =B15*(18/24)*D19), adjust here.
  if (goldRateLive !== null && netWt !== null) {
    sheet.getRange(GOLD_RATE_EFF_CELL).setValue(goldRateLive);
    sheet.getRange(GOLD_RATE_EFF_CELL).setNote('Effective gold rate (auto). gold value = weight × this rate. Do not edit.');
    sheet.getRange(GOLD_VAL_CELL).setFormula('=' + NET_WT_CELL + '*' + GOLD_RATE_EFF_CELL);
  }

  var karat = extractKarat(lineItem.sku);
  if (karat) sheet.getRange(KARAT_CELL).setValue(karat);

  SpreadsheetApp.flush();
}



// SKU format: NK00068|Y|18|... — karat is always pipe-index 2
function extractKarat(sku) {
  if (!sku) return '';
  var parts = String(sku).split('|');
  var k     = parts[2] ? parts[2].trim() : '';
  return k ? k + 'K' : '';
}

// ── MANUAL LOOKUP (menu fallback) ────────────────────────────────────────────
function lookupOrderManual() {
  try {
    var calc = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CALC_SHEET_NAME);
    if (!calc) { SpreadsheetApp.getUi().alert('Sheet "' + CALC_SHEET_NAME + '" not found.'); return; }
    onOrderNumberEntered(calc, true); // menu has UI scope — show modal for multi-SKU
  } catch (err) {
    SpreadsheetApp.getUi().alert('❌ Lookup error:\n' + err.message);
  }
}

// ── TRIGGER MANAGEMENT ────────────────────────────────────────────────────────
function setupTriggers() {
  // Remove duplicates first
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === 'handleEdit'; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('handleEdit')
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onEdit()
    .create();

  SpreadsheetApp.getUi().alert('✅ Auto-fill triggers installed.\n\nType an order number in B7 to test.');
}

function removeTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === 'handleEdit'; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });
  SpreadsheetApp.getUi().alert('Triggers removed.');
}

// ── DISPATCHER: branch on the Document Type cell ─────────────────────────────
// DOCTYPE_CELL (B37) = "Voucher" (1-year store credit, discount code) or
// "Exchange Note" (instant post-tax deduction on a new invoice).
function createDocument() {
  const calc = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CALC_SHEET_NAME);
  // Source wins over Document Type: Old Gold is always a voucher bound to a customer, no order.
  if (currentSource_(calc) === SOURCE_OLD_GOLD) return createOldGoldVoucher_();
  const modality = String(calc.getRange(DOCTYPE_CELL).getValue()).trim().toLowerCase();
  if (modality.indexOf('exchange') === 0 || modality === 'exc') return createExchangeNote_();
  return createVoucher_();
}

// Back-compat alias for any saved trigger / habit pointing at the old name.
function createCreditNote() { return createVoucher_(); }

// ── VOUCHER (rebranded credit note) — 1-year discount code, tagged to the order ──
function createVoucher_() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const calc = ss.getSheetByName(CALC_SHEET_NAME);
  const log  = ss.getSheetByName(VOUCHER_LOG) || ss.getSheetByName('CN Log');
  const ui   = SpreadsheetApp.getUi();
  if (!log) { ui.alert('Log tab "' + VOUCHER_LOG + '" not found. Run "Set up Document Type fields" first.'); return; }

  const customerName  = calc.getRange(CUST_NAME_CELL).getValue();
  const customerEmail = calc.getRange(CUST_EMAIL_CELL).getValue();
  const orderNumber   = String(calc.getRange(ORDER_NUM_CELL).getValue()).trim();
  const netWt         = toNum(calc.getRange(NET_WT_CELL).getValue());
  const diaWt         = toNum(calc.getRange(DIA_CTS_CELL).getValue());
  const goldVal       = toNum(calc.getRange(GOLD_VAL_CELL).getValue());
  const diaVal        = toNum(calc.getRange(DIA_VAL_CELL).getValue());
  const netCredit     = toNum(calc.getRange(NET_VALUE_CELL).getValue());

  const today      = new Date();
  // 1-year validity (same day next year — JS rolls leap years over cleanly).
  const validUntil = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate());

  if (!customerEmail || !orderNumber || netCredit <= 0) {
    ui.alert('Missing data. Fill customer email, order number, and ensure net credit > 0.');
    return;
  }

  const year   = today.getFullYear();
  // Serial from the central counter service (atomic, no gaps/dupes across devices).
  // Falls back to the legacy sheet-row count if the middleware is unreachable.
  // Print the ledger's own code (VCH27-KAHSR-0001) — never re-format locally. Middleware down →
  // legacy sheet-row format so a voucher can still be issued; reconcile that number by hand after.
  const alloc  = allocateVoucherSerial();
  const cnNum  = (alloc && alloc.serial_code)
                 ? alloc.serial_code
                 : 'VCH-' + year + '-' + String(log.getLastRow()).padStart(4, '0');

  const issued    = Utilities.formatDate(today, 'Asia/Kolkata', 'dd-MM-yyyy');
  const expiryFmt = Utilities.formatDate(validUntil, 'Asia/Kolkata', 'dd-MM-yyyy');
  const expiryIso = validUntil.toISOString();

  const cleanOrderNum = orderNumber.replace('#', '');
  const orderData     = getOrderData(cleanOrderNum);
  const orderId       = orderData ? orderData.id        : null;
  const customerId    = orderData ? orderData.customerId : null;

  const priceRulePayload = {
    title:              cnNum,
    target_type:        'line_item',
    target_selection:   'all',
    allocation_method:  'across',
    value_type:         'fixed_amount',
    value:              '-' + netCredit.toFixed(2),
    customer_selection: customerId ? 'prerequisite' : 'all',
    starts_at:          today.toISOString(),
    ends_at:            expiryIso,
    usage_limit:        1
  };
  if (customerId) priceRulePayload.prerequisite_customer_ids = [customerId];

  const priceRule = shopifyPost('price_rules.json', { price_rule: priceRulePayload });
  if (!priceRule || !priceRule.price_rule) {
    ui.alert('Failed to create price rule in Shopify. Check Supabase credentials and token scopes.');
    return;
  }

  const priceRuleId = priceRule.price_rule.id;
  const discCode    = shopifyPost('price_rules/' + priceRuleId + '/discount_codes.json', {
    discount_code: { code: cnNum }
  });
  if (!discCode || !discCode.discount_code) {
    ui.alert('Price rule created but discount code failed. Check Shopify manually.');
    return;
  }

  calc.getRange(DOCNUM_OUT_CELL).setValue(cnNum);

  // Record the voucher in the credit-instrument ledger. WITHOUT this the voucher exists only as a
  // Shopify discount code: handleApplyVoucherTag looks it up via getBySerial and, finding nothing,
  // tags the draft "voucher-invalid: ... not found" and deducts nothing. The Exchange Note gets its
  // ledger row for free inside /api/exc-redeem; the voucher has no such call, so it must issue here.
  if (!issueCreditInstrument_({
        instrumentType:  'voucher',
        serialCode:      cnNum,
        value:           netCredit,
        customerId:      customerId ? String(customerId) : null,
        customerName:    customerName,
        sourceOrderName: orderNumber,
        stateCode:       resolveStoreCode_(),
        expiresAt:       expiryIso,
        priceRuleId:     String(priceRuleId)
      })) {
    ui.alert('⚠️ ' + cnNum + ' was created in Shopify but NOT recorded in the ledger.\n\n' +
             'It will fail to apply from the admin app ("not found"). Re-run once the middleware is reachable.');
  }

  // Internal cn-* tag names kept unchanged so the existing OPP print template renders untouched.
  if (orderId) {
    addOrderTags(orderId, [
      'cn-issued',
      'cn-num:' + cnNum,
      'cn-val:' + netCredit.toFixed(2),
      'cn-exp:' + expiryFmt,
      'cn-iss:' + issued
    ]);
  } else {
    ui.alert('⚠️ Order ' + orderNumber + ' not found in Shopify. Voucher created but order not tagged.');
  }

  // Last column (M) holds the Shopify price_rule_id so a later Void can delete the discount.
  log.appendRow([issued, cnNum, orderNumber, customerName, customerEmail,
                 netWt, diaWt, goldVal, diaVal, netCredit, expiryFmt, 'Issued', String(priceRuleId)]);

  sendVoucherEmail_(customerName, customerEmail, cnNum, netCredit, expiryFmt, orderNumber);

  ui.alert(
    '✅ Voucher Created\n\n' +
    'Voucher: ' + cnNum + '\n' +
    'Discount Code: ' + cnNum + '\n' +
    'Value: ₹' + netCredit.toLocaleString('en-IN', { minimumFractionDigits: 2 }) + '\n' +
    'Valid Until: ' + expiryFmt + ' (1 year)\n\n' +
    'Order ' + orderNumber + ' tagged. ' +
    (SEND_CUSTOMER_EMAILS ? 'Email sent to ' + customerEmail + '.' : '✉️ Email SUPPRESSED (test mode).')
  );
}

// ── OLD-GOLD VOUCHER — buy-back credit, no reference order, no draft ──────────────
// Customer walks in with scrap/old gold. Staff enter weight + purity; it's valued off the same
// buying_rate_table the middleware uses, and issued as a 1-year voucher BOUND TO THE CUSTOMER
// (prerequisite_customer_ids). No order, no draft — the voucher stands alone and is redeemed later
// against a future sale. The customer is resolved from OG_CUSTID_CELL (populate it via the
// "Look up Old-Gold customer" menu item, which calls lookupCustomer_).
function createOldGoldVoucher_() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const calc = ss.getSheetByName(CALC_SHEET_NAME);
  const log  = ss.getSheetByName(VOUCHER_LOG) || ss.getSheetByName('CN Log');
  const ui   = SpreadsheetApp.getUi();
  if (!log) { ui.alert('Log tab "' + VOUCHER_LOG + '" not found. Run the setup first.'); return; }

  // Customer: "id | name" written into OG_CUSTID_CELL by the lookup. Require a resolved id — an
  // old-gold voucher with no customer would be a bearer instrument redeemable by anyone.
  const custRaw = String(calc.getRange(OG_CUSTID_CELL).getValue()).trim();
  const custId  = custRaw.split('|')[0].trim();
  const custNm  = (custRaw.split('|')[1] || '').trim() || String(calc.getRange(CUST_NAME_CELL).getValue()).trim();
  if (!custId || !/^\d+$/.test(custId)) {
    ui.alert('No customer resolved.\n\nEnter a phone or email in ' + OG_CUSTOMER_CELL +
             ' and run "🔎 Look up Old-Gold customer" from the menu first.');
    return;
  }

  const weight = toNum(calc.getRange(OG_WEIGHT_CELL).getValue());
  const purity = toNum(calc.getRange(OG_PURITY_CELL).getValue());
  const rate   = toNum(calc.getRange(OG_RATE_CELL).getValue()) || getBuyingRate_(purity);
  if (!(weight > 0) || !(purity > 0)) { ui.alert('Enter old-gold weight (' + OG_WEIGHT_CELL + ') and purity (' + OG_PURITY_CELL + ').'); return; }
  if (!(rate > 0)) { ui.alert('No buy-back rate for ' + purity + 'kt. Check the buying rate table is set.'); return; }

  // Old-gold value = weight × buy-back rate, computed here at issue time. It does NOT read or write
  // the NET cell (that cell is the Purchase-Exchange formula; touching it would break the exchange
  // calc). Any note typed in OVERRIDE_REASON_CELL is recorded on the log for audit.
  const value  = Math.round(weight * rate * 100) / 100;
  const reason = String(calc.getRange(OVERRIDE_REASON_CELL).getValue()).trim();

  const today      = new Date();
  const validUntil = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate());
  const issued     = Utilities.formatDate(today, 'Asia/Kolkata', 'dd-MM-yyyy');
  const expiryFmt  = Utilities.formatDate(validUntil, 'Asia/Kolkata', 'dd-MM-yyyy');
  const expiryIso  = validUntil.toISOString();
  const year       = today.getFullYear();

  const alloc = allocateVoucherSerial();
  const cnNum = (alloc && alloc.serial_code)
                ? alloc.serial_code
                : 'VCH-' + year + '-' + String(log.getLastRow()).padStart(4, '0');

  // Customer-bound, single-use price rule — identical shape to createVoucher_, minus the order link.
  const priceRule = shopifyPost('price_rules.json', { price_rule: {
    title:              cnNum,
    target_type:        'line_item',
    target_selection:   'all',
    allocation_method:  'across',
    value_type:         'fixed_amount',
    value:              '-' + value.toFixed(2),
    customer_selection: 'prerequisite',
    prerequisite_customer_ids: [Number(custId)],
    starts_at:          today.toISOString(),
    ends_at:            expiryIso,
    usage_limit:        1
  }});
  if (!priceRule || !priceRule.price_rule) { ui.alert('Failed to create the price rule in Shopify. Check token scopes.'); return; }
  const priceRuleId = priceRule.price_rule.id;
  const discCode = shopifyPost('price_rules/' + priceRuleId + '/discount_codes.json', { discount_code: { code: cnNum } });
  if (!discCode || !discCode.discount_code) { ui.alert('Price rule created but discount code failed. Check Shopify.'); return; }

  calc.getRange(DOCNUM_OUT_CELL).setValue(cnNum);

  if (!issueCreditInstrument_({
        instrumentType:  'voucher',
        serialCode:      cnNum,
        value:           value,
        customerId:      String(custId),
        customerName:    custNm,
        sourceOrderName: 'OLD-GOLD ' + weight.toFixed(3) + 'g @ ' + purity + 'kt',
        stateCode:       resolveStoreCode_(),
        expiresAt:       expiryIso,
        priceRuleId:     String(priceRuleId)
      })) {
    ui.alert('⚠️ ' + cnNum + ' created in Shopify but NOT recorded in the ledger. It will fail to apply. Re-run when the middleware is reachable.');
  }

  // Log columns match the Voucher Log header; old-gold specifics go in the weight/gold-value slots.
  log.appendRow([issued, cnNum, 'OLD-GOLD', custNm, calc.getRange(CUST_EMAIL_CELL).getValue(),
                 weight, 0, value, 0, value, expiryFmt, 'Issued', String(priceRuleId), reason]);

  sendVoucherEmail_(custNm, calc.getRange(CUST_EMAIL_CELL).getValue(), cnNum, value, expiryFmt, 'OLD-GOLD');

  ui.alert(
    '✅ Old-Gold Voucher Created\n\n' +
    'Voucher: ' + cnNum + '\n' +
    'Customer: ' + custNm + ' (id ' + custId + ')\n' +
    'Old gold: ' + weight.toFixed(3) + ' g @ ' + purity + 'kt × ₹' + rate.toFixed(2) + '/g\n' +
    'Value: ₹' + value.toLocaleString('en-IN', { minimumFractionDigits: 2 }) +
    (reason ? '  (override: ' + reason + ')' : '') + '\n' +
    'Valid Until: ' + expiryFmt + ' (1 year)\n\n' +
    (SEND_CUSTOMER_EMAILS ? 'Email sent.' : '✉️ Email SUPPRESSED (test mode).')
  );
}

// Menu action: value the old gold from purity in OG_PURITY_CELL → rate into OG_RATE_CELL, and show
// the resulting value. It is deliberately NOT written to the NET cell (NET_VALUE_CELL is a live
// formula for Purchase Exchange — writing a static number there would destroy that formula). The
// old-gold value is computed fresh at issue time in createOldGoldVoucher_; here it's just surfaced.
function fetchOldGoldRate() {
  var calc = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CALC_SHEET_NAME);
  var ui   = SpreadsheetApp.getUi();
  var purity = toNum(calc.getRange(OG_PURITY_CELL).getValue());
  if (!(purity > 0)) { ui.alert('Enter the old-gold purity (karat) in ' + OG_PURITY_CELL + ' first.'); return; }
  var rate = getBuyingRate_(purity);
  if (!(rate > 0)) { ui.alert('No buy-back rate for ' + purity + 'kt — check the buying rate table is set in Supabase.'); return; }
  calc.getRange(OG_RATE_CELL).setValue(rate);
  var value = oldGoldValue_(calc);
  showOldGoldValue_(calc, value);
  var weight = toNum(calc.getRange(OG_WEIGHT_CELL).getValue());
  ui.alert('Buy-back rate for ' + purity + 'kt: ₹' + rate.toFixed(2) + '/g' +
           (weight > 0 ? '\nOld-gold value for ' + weight.toFixed(3) + ' g: ₹' + value.toFixed(2) : ''));
}

// weight × rate, rounded to paise. Pure — reads the OG cells, writes nothing.
function oldGoldValue_(calc) {
  var weight = toNum(calc.getRange(OG_WEIGHT_CELL).getValue());
  var rate   = toNum(calc.getRange(OG_RATE_CELL).getValue());
  return Math.round(weight * rate * 100) / 100;
}

// Surface the computed old-gold value WITHOUT touching the NET formula: a note on the rate cell.
function showOldGoldValue_(calc, value) {
  if (value > 0) calc.getRange(OG_RATE_CELL).setNote('Old-gold value = weight × rate = ₹' + value.toFixed(2));
}

// One-time setup: builds the Source / Exchange-Type / Old-Gold field block below B47, and LOCKS the
// calculated cells (weights, carats, rates, computed values) so staff can only edit the final value
// (B36) — with a reason in OVERRIDE_REASON_CELL. Idempotent; refuses to overwrite non-ours content.
// ── MIGRATION: move all controls to a block at the TOP of the sheet ──────────────
// Legacy layout ran Customer → Item → Weights → Rates → Deductions → Calc, with the controls
// (Doc Type, Source, Old-Gold, Store) bolted on at the bottom. This inserts a CONTROLS block at
// the very top by inserting RESTRUCTURE_ROWS rows at row 1 — which shifts every legacy row down by
// that amount and, crucially, lets Google Sheets AUTO-ADJUST every calculation formula (the
// 80%/100%/deduction rows) so the numbers are preserved exactly. It then builds the control fields
// in the new top rows and clears the now-shifted legacy control cells. The layout constants at the
// top of this file already point at the post-migration positions, so run this ONCE.
//
// TEST ON A COPY FIRST (File → Make a copy). Idempotent-guarded: re-running is a no-op.

// ── FRESH BUILD: construct the whole Exchange Calculator from scratch, controls-on-top ────────────
// Deterministic reset. Rebuilds every label, dropdown, and CALC FORMULA at the exact cells the layout
// constants point to — so the sheet always matches the script and nothing can be left corrupted. Run
// this instead of the migration if the sheet's formulas got damaged. Input cells are left blank; the
// populate/auto-fill logic fills them from an order as normal.
//
// Calc convention (matches the original): Gold at 100%, Diamond at 80%, minus deductions.
//   Gross Exchange Value = Gold Value + Diamond Value × 80%
//   NET                  = Gross − Total Deductions
function buildExchangeCalculator() {
  var ss   = SpreadsheetApp.getActiveSpreadsheet();
  var calc = ss.getSheetByName(CALC_SHEET_NAME);
  var ui   = SpreadsheetApp.getUi();
  if (!calc) { ui.alert('Sheet "' + CALC_SHEET_NAME + '" not found.'); return; }

  var confirm = ui.alert('Rebuild the Exchange Calculator?',
    'This rewrites all labels, dropdowns and calc formulas on the "' + CALC_SHEET_NAME + '" tab to the ' +
    'controls-on-top layout. Input data on the tab is cleared. The log tabs are untouched.\n\nProceed?',
    ui.ButtonSet.YES_NO);
  if (confirm !== ui.Button.YES) return;

  // Clear the working area (labels A, values B, helper cols C/D) down to the details block.
  calc.getRange('A1:D60').clearContent().clearDataValidations().clearNote();
  calc.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) {
    try { if (/Timanti CN/.test(p.getDescription())) p.remove(); } catch (e) {}
  });

  function label(a1, text) { var r = calc.getRange(a1); calc.getRange(r.getRow(), 1).setValue(text); }
  function header(row, text) { calc.getRange(row, 1).setValue(text); }
  function drop(a1, list, def) {
    var r = calc.getRange(a1);
    r.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(false).build());
    if (def) r.setValue(def);
  }

  // ── CONTROLS (top) ──
  header(1, '0 — CONTROLS  (set these first)');
  label(SOURCE_CELL,   'Source');            drop(SOURCE_CELL,   ['Purchase Exchange', 'Old Gold'], 'Purchase Exchange');
  label(EXCHTYPE_CELL, 'Exchange Type');     drop(EXCHTYPE_CELL, ['Deduction', 'Full Value'],       'Deduction');
  label(DOCTYPE_CELL,  'Document Type');     drop(DOCTYPE_CELL,  ['Voucher', 'Exchange Note'],       'Voucher');
  label(STORE_CODE_CELL, 'Store Code');      calc.getRange(STORE_CODE_CELL).setNote('e.g. KA-HSR or KA-TEST. Blank = ' + STORE_CODE);
  label(NEWDRAFT_CELL, 'New Draft/Order # (Exchange Note only)');
  header(cellRow_(OG_CUSTOMER_CELL) - 1, '— OLD GOLD  (only when Source = Old Gold) —');
  label(OG_CUSTOMER_CELL, 'Old Gold — Customer phone/email');
  label(OG_CUSTID_CELL,   'Old Gold — Customer (auto)');
  label(OG_WEIGHT_CELL,   'Old Gold — Weight (g)');
  label(OG_PURITY_CELL,   'Old Gold — Purity (karat)');
  label(OG_RATE_CELL,     'Old Gold — Buy-back rate/g (auto)');
  label(OVERRIDE_REASON_CELL, 'Final value override — reason');

  // ── 1: Customer & order ──
  header(cellRow_(CUST_NAME_CELL) - 1, '1 — CUSTOMER & ORDER DETAILS');
  label(CUST_NAME_CELL, 'Customer Name');
  label(CUST_EMAIL_CELL, 'Customer Email');
  label(CUST_PHONE_CELL, 'Customer Phone');
  label(ORDER_NUM_CELL, 'Original Order Number (e.g. #1020)');
  label(ORDER_DATE_CELL, 'Original Order Date');
  header(cellRow_(SKU_CELL) - 1, 'Item Being Exchanged');
  label(SKU_CELL, 'SKU / Jewellery Code');
  label(KARAT_CELL, 'Metal Karat');

  // ── 2: Weights ──
  header(cellRow_(NET_WT_CELL) - 1, '2 — WEIGHTS');
  label(NET_WT_CELL, 'Net Gold Weight (g)');
  label(DIA_CTS_CELL, 'Total Diamond Weight (cts)');

  // ── 3: Rates ──
  header(cellRow_(GOLD_RATE_ORD_CELL) - 1, '3 — TODAY\'S RATES');
  label(GOLD_RATE_ORD_CELL, 'Gold Rate (order / live / effective →)');
  label(LGD_RATE_CELL, 'Diamond Value (from variant →)');

  // ── 4 + 5: Calculation ──
  header(cellRow_(GOLD_VAL_CELL) - 1, '4 — CALCULATION  (auto)');
  var gv = cellRow_(GOLD_VAL_CELL);       // 41
  label(GOLD_VAL_CELL, 'Gold Value (100%)');            // B41  =NetWt × effRate (script writes on populate)
  label(DIA_VAL_CELL,  'Diamond Value (raw)');          // B42  =variant diamond value
  calc.getRange(gv + 2, 1).setValue('Gross Exchange Value (Gold + Diamond×80%)');
  calc.getRange(gv + 2, 2).setFormula('=' + GOLD_VAL_CELL + '+' + DIA_VAL_CELL + '*0.8');   // B43
  calc.getRange(gv + 3, 1).setValue('Less: Making / Labour');       // B44
  calc.getRange(gv + 4, 1).setValue('Less: Shipping');              // B45
  calc.getRange(gv + 5, 1).setValue('Less: IGI Re-Certification');  // B46
  calc.getRange(gv + 6, 1).setValue('Less: Discount Applied');      // B47
  calc.getRange(gv + 7, 1).setValue('Less: Custom deductions');     // B48
  calc.getRange(gv + 8, 1).setValue('Total Deductions');            // B49
  calc.getRange(gv + 8, 2).setFormula('=SUM(B' + (gv + 3) + ':B' + (gv + 7) + ')');
  calc.getRange(cellRow_(NET_VALUE_CELL), 1).setValue('NET CREDIT NOTE VALUE');             // B50
  calc.getRange(NET_VALUE_CELL).setFormula('=B' + (gv + 2) + '-B' + (gv + 8));              // =Gross − TotalDed

  // ── 6: Document details ──
  header(cellRow_(DOCNUM_OUT_CELL) - 1, '5 — CREDIT NOTE / EXCHANGE DETAILS');
  label(DOCNUM_OUT_CELL, 'Credit Note / EXC Number (auto)');

  // Gate the calc/rate cells (warn-on-edit) and ensure log tabs exist.
  lockCalcCells_(calc);
  ensureLogTabs_(ss);

  ui.alert('✅ Exchange Calculator rebuilt (controls on top).\n\n' +
           'NET (' + NET_VALUE_CELL + ') = Gross − Total Deductions, with Gold 100% + Diamond 80%.\n' +
           'Enter an order number in ' + ORDER_NUM_CELL + ' to auto-fill and verify the numbers.');
}

// Creates the Voucher Log / Exchange Log tabs if missing (extracted so the fresh build can call it).
function ensureLogTabs_(ss) {
  if (!ss.getSheetByName(VOUCHER_LOG)) {
    var old = ss.getSheetByName('CN Log');
    if (old) old.setName(VOUCHER_LOG); else ss.insertSheet(VOUCHER_LOG);
  }
  if (!ss.getSheetByName(EXCHANGE_LOG)) {
    var ex = ss.insertSheet(EXCHANGE_LOG);
    ex.appendRow(['Issued', 'EXC Number', 'Old Order', 'New Draft', 'Customer', 'Email',
                  'Net Wt', 'Dia Wt', 'Gold Val', 'Dia Val', 'Exchange Value', 'Status', 'New Draft ID']);
  }
}

function restructureControlsToTop() {
  var ss   = SpreadsheetApp.getActiveSpreadsheet();
  var calc = ss.getSheetByName(CALC_SHEET_NAME);
  var ui   = SpreadsheetApp.getUi();
  if (!calc) { ui.alert('Sheet "' + CALC_SHEET_NAME + '" not found.'); return; }

  // Guard: the label to the left of SOURCE_CELL is 'Source' only after a successful migration.
  var srcLabel = String(calc.getRange(cellRow_(SOURCE_CELL), 1).getValue()).trim();
  if (srcLabel === 'Source') { ui.alert('Already restructured — controls are at the top. Nothing changed.'); return; }

  var confirm = ui.alert('Restructure the Exchange Calculator?',
    'This inserts a CONTROLS block at the top and shifts existing rows down by ' + RESTRUCTURE_ROWS + '.\n\n' +
    'Run this on a COPY of the sheet first and verify the calc numbers before using it live.\n\nProceed?',
    ui.ButtonSet.YES_NO);
  if (confirm !== ui.Button.YES) return;

  // 1. Insert the top block. Sheets auto-adjusts all calc formulas for the downward shift.
  calc.insertRowsBefore(1, RESTRUCTURE_ROWS);

  // 2. Build the control fields. Label goes in column A of the same row as the value cell.
  function put(cellA1, label, opts) {
    var r = calc.getRange(cellA1);
    calc.getRange(r.getRow(), 1).setValue(label);
    if (opts && opts.list) {
      r.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(opts.list, true).setAllowInvalid(false).build());
      if (opts.def && !String(r.getValue()).trim()) r.setValue(opts.def);
    }
    if (opts && opts.note) r.setNote(opts.note);
  }
  calc.getRange('A1').setValue('0 — CONTROLS  (set these first)');
  put(SOURCE_CELL,        'Source',        { list: ['Purchase Exchange', 'Old Gold'], def: 'Purchase Exchange' });
  put(EXCHTYPE_CELL,      'Exchange Type', { list: ['Deduction', 'Full Value'],       def: 'Deduction' });
  put(DOCTYPE_CELL,       'Document Type', { list: ['Voucher', 'Exchange Note'],       def: 'Voucher' });
  put(STORE_CODE_CELL,    'Store Code',    { note: 'Issuing store, e.g. KA-HSR or KA-TEST. Blank = ' + STORE_CODE });
  put(NEWDRAFT_CELL,      'New Draft/Order # (Exchange Note only)', { note: 'Ring up the new item as a draft first, then enter e.g. #D123.' });
  calc.getRange(cellRow_(OG_CUSTOMER_CELL) - 1, 1).setValue('— OLD GOLD  (only when Source = Old Gold) —');
  put(OG_CUSTOMER_CELL,     'Old Gold — Customer phone/email', { note: 'Then run "Look up Old-Gold customer" (or just type — it auto-resolves).' });
  put(OG_CUSTID_CELL,       'Old Gold — Customer (auto)');
  put(OG_WEIGHT_CELL,       'Old Gold — Weight (g)');
  put(OG_PURITY_CELL,       'Old Gold — Purity (karat)');
  put(OG_RATE_CELL,         'Old Gold — Buy-back rate/g (auto)');
  put(OVERRIDE_REASON_CELL, 'Final value override — reason');

  // 3. Clear the legacy control cells (old rows 45-55, now shifted down by RESTRUCTURE_ROWS).
  for (var rr = 45 + RESTRUCTURE_ROWS; rr <= 55 + RESTRUCTURE_ROWS; rr++) {
    calc.getRange(rr, 1).clearContent();
    calc.getRange(rr, 2).clearContent();
    calc.getRange(rr, 2).clearDataValidations();
  }

  // 4. Gate the calc cells (warn-on-edit) at their new positions.
  lockCalcCells_(calc);

  ui.alert('✅ Restructured.\n\n' +
           'Controls are now at the top (rows 1-' + (RESTRUCTURE_ROWS - 1) + '). Existing rows moved down by ' +
           RESTRUCTURE_ROWS + ' and the calc formulas auto-adjusted.\n\n' +
           'Verify the NET value matches what it was before, then use as normal. ' +
           'Only the final value (' + NET_VALUE_CELL + ') is freely editable.');
}

// Warn-on-edit protection on the auto-calculated cells so staff can't hand-edit weights/rates/values.
// Warning-only works without domain-admin rights (a hard lock needs setDomainEdit the owner may lack).
function lockCalcCells_(calc) {
  var lockCells = [NET_WT_CELL, DIA_CTS_CELL, GOLD_RATE_ORD_CELL, GOLD_RATE_LIVE_CELL, GOLD_RATE_EFF_CELL,
                   LGD_RATE_CELL, DIA_VALUE_CELL, GOLD_VAL_CELL, DIA_VAL_CELL, OG_RATE_CELL, OG_CUSTID_CELL];
  lockCells.forEach(function (a1) {
    var rng = calc.getRange(a1);
    calc.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) {
      if (p.getRange().getA1Notation() === rng.getA1Notation()) p.remove();
    });
    calc.getRange(a1).protect().setDescription('Auto-calculated — do not edit (Timanti CN)').setWarningOnly(true);
  });
}

// Menu action: resolve the customer typed into OG_CUSTOMER_CELL and write "id | name" to OG_CUSTID_CELL.
function lookupOldGoldCustomer() {
  var calc = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CALC_SHEET_NAME);
  var ui   = SpreadsheetApp.getUi();
  var q    = String(calc.getRange(OG_CUSTOMER_CELL).getValue()).trim();
  if (!q) { ui.alert('Enter a phone or email in ' + OG_CUSTOMER_CELL + ' first.'); return; }
  var c = lookupCustomer_(q);
  if (!c) { calc.getRange(OG_CUSTID_CELL).clearContent(); ui.alert('No customer found for "' + q + '".'); return; }
  calc.getRange(OG_CUSTID_CELL).setValue(c.id + ' | ' + c.name);
  if (c.name)  calc.getRange(CUST_NAME_CELL).setValue(c.name);
  if (c.email) calc.getRange(CUST_EMAIL_CELL).setValue(c.email);
  if (c.phone) calc.getRange(CUST_PHONE_CELL).setValue(c.phone);
  ui.alert('✅ Customer: ' + c.name + '\nid ' + c.id + (c.email ? '\n' + c.email : ''));
}

// ── EXCHANGE NOTE — instant post-tax deduction applied to a NEW invoice ──────────
// Staff ring up the new item (creating a Shopify draft), then enter that draft # in NEWDRAFT_CELL.
// The middleware appends a negative custom line item (EXC-...) to that draft.
function createExchangeNote_() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const calc = ss.getSheetByName(CALC_SHEET_NAME);
  const log  = ss.getSheetByName(EXCHANGE_LOG);
  const ui   = SpreadsheetApp.getUi();
  if (!log) { ui.alert('Log tab "' + EXCHANGE_LOG + '" not found. Run "Set up Document Type fields" first.'); return; }

  const customerName  = calc.getRange(CUST_NAME_CELL).getValue();
  const customerEmail = calc.getRange(CUST_EMAIL_CELL).getValue();
  const orderNumber   = String(calc.getRange(ORDER_NUM_CELL).getValue()).trim();   // OLD order (item exchanged)
  const newDraftRef   = String(calc.getRange(NEWDRAFT_CELL).getValue()).trim();  // NEW sale's draft
  const netWt         = toNum(calc.getRange(NET_WT_CELL).getValue());
  const diaWt         = toNum(calc.getRange(DIA_CTS_CELL).getValue());
  const goldVal       = toNum(calc.getRange(GOLD_VAL_CELL).getValue());
  const diaVal        = toNum(calc.getRange(DIA_VAL_CELL).getValue());
  let   excValue      = toNum(calc.getRange(NET_VALUE_CELL).getValue());

  // Exchange type. 'Full Value' credits the ORIGINAL invoice's taxable (pre-GST) value instead of
  // today's metal+stone calc. NOTE FOR ACCOUNTANT: this uses the order's post-discount, pre-tax
  // subtotal (Shopify subtotal_price). Confirm the tax basis before relying on it — the deduction is
  // applied POST-tax on the new invoice, so crediting a pre-GST figure post-tax is deliberate.
  const exchType = String(calc.getRange(EXCHTYPE_CELL).getValue()).trim().toLowerCase();
  if (exchType.indexOf(EXCHTYPE_FULL) === 0) {
    const taxable = getOrderTaxableValue_(orderNumber);
    if (!(taxable > 0)) {
      ui.alert('Full Value selected but the original invoice taxable value for ' + orderNumber +
               ' could not be read. Switch to Deduction or check the order number.');
      return;
    }
    // Use the taxable figure directly; do NOT write it into the NET cell. NET_VALUE_CELL holds the
    // Deduction-mode formula — overwriting it with a static number destroyed that formula, so a later
    // Deduction run then read the stale full-value number. The figure is shown in the confirmation.
    excValue = taxable;
  }

  if (!customerEmail || !orderNumber || excValue <= 0) {
    ui.alert('Missing data. Fill customer email, old order number, and ensure exchange value > 0.');
    return;
  }
  if (!newDraftRef) {
    ui.alert('Enter the new sale\'s draft order number in ' + NEWDRAFT_CELL + ' (e.g. #D123).\n\n' +
             'Ring up the new item as a draft in Shopify first, then run this again.');
    return;
  }

  const today  = new Date();
  // No local-format fallback here: an Exchange Note must not hit an invoice without a real
  // ledger number, so a failed allocation aborts rather than inventing one.
  const alloc  = allocateExcSerial();
  if (!alloc || !alloc.serial_code) { ui.alert('Could not allocate an Exchange Note number (middleware unreachable). Try again.'); return; }
  const excNum = alloc.serial_code;
  const issued = Utilities.formatDate(today, 'Asia/Kolkata', 'dd-MM-yyyy');

  // Apply the deduction to the new draft via the middleware. Returns the resolved numeric draft id.
  const result = applyExchangeNote_(newDraftRef, excNum, excValue, orderNumber, customerName);
  if (!result || !result.success) {
    ui.alert('❌ Exchange Note not applied.\n\n' +
             (result && result.error ? result.error : 'Middleware error — check that the draft number is correct.') +
             '\n\nThe number ' + excNum + ' was reserved; void it if you do not retry.');
    return;
  }
  const newDraftId   = result.draftId || '';
  const newDraftName = newDraftRef.indexOf('#') === 0 ? newDraftRef : ('#' + newDraftRef);

  calc.getRange(DOCNUM_OUT_CELL).setValue(excNum);

  // Tag the OLD order so the exchanged item is traceable to the new sale.
  const cleanOrderNum = orderNumber.replace('#', '');
  const orderData     = getOrderData(cleanOrderNum);
  if (orderData && orderData.id) {
    addOrderTags(orderData.id, [
      'exc-given',
      'exc-num:' + excNum,
      'exc-val:' + excValue.toFixed(2),
      'exc-applied-to:' + newDraftName,
      'exc-iss:' + issued
    ]);
  } else {
    ui.alert('⚠️ Old order ' + orderNumber + ' not found — Exchange Note applied but old order not tagged.');
  }

  log.appendRow([issued, excNum, orderNumber, newDraftName, customerName, customerEmail,
                 netWt, diaWt, goldVal, diaVal, excValue, 'Applied', String(newDraftId)]);

  sendExcEmail_(customerName, customerEmail, excNum, excValue, orderNumber, newDraftName);

  ui.alert(
    '✅ Exchange Note Applied\n\n' +
    'Exchange Note: ' + excNum + '\n' +
    'Deducted: ₹' + excValue.toLocaleString('en-IN', { minimumFractionDigits: 2 }) + '\n' +
    'Applied to: ' + newDraftName + '\n\n' +
    'The new invoice total is reduced by this amount (GST unchanged). ' +
    (SEND_CUSTOMER_EMAILS ? 'Email sent to ' + customerEmail + '.' : '✉️ Email SUPPRESSED (test mode).')
  );
}

// ── EMAIL — routed through middleware → Resend → hello@timanti.in ─────────────
// Voucher template: emailService.js → buildCreditNoteHtml() via POST /api/cn-email
// Exchange Note template: buildExchangeNoteHtml() via POST /api/exc-email
const MIDDLEWARE_URL = 'https://timanti-middleware.fly.dev'; // update if URL changes

function sendVoucherEmail_(customerName, customerEmail, cnNum, netCredit, expiryFmt, orderNumber) {
  if (!customerEmail) return;
  if (!SEND_CUSTOMER_EMAILS) { Logger.log('Voucher email SUPPRESSED (SEND_CUSTOMER_EMAILS=false): ' + cnNum + ' → ' + customerEmail); return; }
  try {
    var res = UrlFetchApp.fetch(MIDDLEWARE_URL + '/api/cn-email', {
      method:             'post',
      contentType:        'application/json',
      muteHttpExceptions: true,
      payload:            JSON.stringify({
        customerName:  customerName,
        customerEmail: customerEmail,
        cnNumber:      cnNum,
        creditValue:   String(Math.round(netCredit)),
        validUntil:    expiryFmt,
        originalOrder: orderNumber
      })
    });
    var code = res.getResponseCode();
    if (code !== 200) {
      Logger.log('Voucher email warning: middleware returned ' + code + ' — ' + res.getContentText());
    }
  } catch (e) {
    Logger.log('Voucher email failed: ' + e.message);
  }
}

function sendExcEmail_(customerName, customerEmail, excNum, excValue, oldOrder, newOrder) {
  if (!customerEmail) return;
  if (!SEND_CUSTOMER_EMAILS) { Logger.log('EXC email SUPPRESSED (SEND_CUSTOMER_EMAILS=false): ' + excNum + ' → ' + customerEmail); return; }
  try {
    var res = UrlFetchApp.fetch(MIDDLEWARE_URL + '/api/exc-email', {
      method:             'post',
      contentType:        'application/json',
      muteHttpExceptions: true,
      payload:            JSON.stringify({
        customerName:  customerName,
        customerEmail: customerEmail,
        excNumber:     excNum,
        excValue:      String(Math.round(excValue)),
        oldOrder:      oldOrder,
        newOrder:      newOrder
      })
    });
    var code = res.getResponseCode();
    if (code !== 200) {
      Logger.log('EXC email warning: middleware returned ' + code + ' — ' + res.getContentText());
    }
  } catch (e) {
    Logger.log('EXC email failed: ' + e.message);
  }
}

// Applies the Exchange Note deduction to a new draft via the middleware. Returns the parsed
// JSON ({ success, draftId, ... }) or an { success:false, error } object on failure.
function applyExchangeNote_(newDraftRef, excNum, excValue, oldOrder, customerName) {
  try {
    var res = UrlFetchApp.fetch(MIDDLEWARE_URL + '/api/exc-redeem', {
      method:             'post',
      contentType:        'application/json',
      muteHttpExceptions: true,
      payload:            JSON.stringify({
        newDraftRef:     newDraftRef,
        excNumber:       excNum,
        excValue:        excValue,
        oldOrderNumber:  oldOrder,
        customerName:    customerName
      })
    });
    var body = {};
    try { body = JSON.parse(res.getContentText()); } catch (e) {}
    if (res.getResponseCode() !== 200) {
      return { success: false, error: (body && body.error) || ('middleware ' + res.getResponseCode()) };
    }
    return body;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── SERIAL — central counter via middleware ───────────────────────────────────
// Allocates (and mints into the ledger) the next serial for a doc type.
// Returns the full response body ({ serial_no, serial_code, serial_display }), or null on failure.
// Callers MUST print serial_code — do not re-format locally, or the printed number drifts from
// the ledger (the old local build produced EXC-2026-0001 while the ledger held EXC27-KAHSR-0001).
function allocateSerial_(docType, storeCode) {
  try {
    var res = UrlFetchApp.fetch(MIDDLEWARE_URL + '/api/serial/allocate', {
      method:             'post',
      contentType:        'application/json',
      muteHttpExceptions: true,
      // stateCode is REQUIRED for voucher/exchange_note serials (per-store); server 400s without it.
      payload:            JSON.stringify({ docType: docType, stateCode: storeCode || STORE_CODE })
    });
    if (res.getResponseCode() !== 200) {
      Logger.log(docType + ' serial warning: middleware returned ' + res.getResponseCode() + ' — ' + res.getContentText());
      return null;
    }
    var body = JSON.parse(res.getContentText());
    return (body && body.serial_no != null) ? body : null;
  } catch (e) {
    Logger.log(docType + ' serial failed: ' + e.message);
    return null;
  }
}

// Voucher falls back to the sheet-row count if the middleware is down; Exchange Note does not
// (it must not be applied to an invoice without a real ledger number).
function allocateVoucherSerial() { return allocateSerial_('voucher', resolveStoreCode_()); }
function allocateExcSerial()     { return allocateSerial_('exchange_note', resolveStoreCode_()); }

// Issuing store code from STORE_CODE_CELL, falling back to the STORE_CODE constant when the cell
// is blank. Read per-call (not cached) so switching the cell to a test store takes effect at once.
function resolveStoreCode_() {
  var calc = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CALC_SHEET_NAME);
  var cell = calc ? String(calc.getRange(STORE_CODE_CELL).getValue()).trim().toUpperCase() : '';
  return cell || STORE_CODE;
}

// Writes a credit instrument into the ledger (credit_instruments) at ISSUE time. Idempotent
// server-side (upsertIssued), so a retry after a partial failure is safe. Returns true on success.
function issueCreditInstrument_(payload) {
  try {
    var res = UrlFetchApp.fetch(MIDDLEWARE_URL + '/api/credit-instrument/issue', {
      method:             'post',
      contentType:        'application/json',
      muteHttpExceptions: true,
      payload:            JSON.stringify(payload)
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('credit-instrument issue warning: ' + res.getResponseCode() + ' — ' + res.getContentText());
      return false;
    }
    return true;
  } catch (e) {
    Logger.log('credit-instrument issue failed: ' + e.message);
    return false;
  }
}

// Retires a serial in the middleware ledger (status=cancelled, never reused). Identified by seq,
// which callers parse off the trailing segment of the code (VCH27-KAHSR-0001 → 0001). Non-throwing.
function cancelSerialByCode_(docType, seq) {
  if (seq == null || isNaN(seq)) return false;
  try {
    var res = UrlFetchApp.fetch(MIDDLEWARE_URL + '/api/serial/cancel-by-code', {
      method:             'post',
      contentType:        'application/json',
      muteHttpExceptions: true,
      payload:            JSON.stringify({ docType: docType, serialNo: Number(seq) })
    });
    if (res.getResponseCode() !== 200) {
      Logger.log(docType + ' cancel warning: middleware returned ' + res.getResponseCode() + ' — ' + res.getContentText());
      return false;
    }
    return true;
  } catch (e) {
    Logger.log(docType + ' cancel failed: ' + e.message);
    return false;
  }
}

// ── VOID VOUCHER ──────────────────────────────────────────────────────────────
// A voucher can only be VOIDED before its expiry date. Voiding deletes the Shopify discount
// (price rule) and retires the serial in the ledger.
function voidVoucher() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var log = ss.getSheetByName(VOUCHER_LOG) || ss.getSheetByName('CN Log');
  var ui  = SpreadsheetApp.getUi();
  if (!log) { ui.alert('Log tab "' + VOUCHER_LOG + '" not found.'); return; }

  var resp = ui.prompt('Void Voucher', 'Enter the voucher number to void (e.g. VCH-2026-0042):', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var cnNum = String(resp.getResponseText()).trim();
  if (!cnNum) { ui.alert('No voucher number entered.'); return; }

  // Locate the voucher in the log (col B = number).
  var data = log.getDataRange().getValues();
  var rowIdx = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][1]).trim().toUpperCase() === cnNum.toUpperCase()) { rowIdx = i; break; }
  }
  if (rowIdx === -1) { ui.alert(cnNum + ' not found in ' + VOUCHER_LOG + '.'); return; }

  var row         = data[rowIdx];
  var expiryFmt   = String(row[10]).trim();  // col K — dd-MM-yyyy
  var status      = String(row[11]).trim();  // col L
  var priceRuleId = String(row[12]).trim();  // col M

  if (/void/i.test(status)) { ui.alert(cnNum + ' is already voided.'); return; }

  // Only voidable before expiry.
  var expDate = parseDmy(expiryFmt);
  if (expDate && new Date() > expDate) {
    ui.alert(cnNum + ' expired on ' + expiryFmt + ' — it can no longer be voided.');
    return;
  }

  var confirm = ui.alert('Void ' + cnNum + '?',
    'This deletes the Shopify discount and retires the serial. This cannot be undone.',
    ui.ButtonSet.YES_NO);
  if (confirm !== ui.Button.YES) return;

  // 1. Delete the Shopify price rule (removes its discount code too).
  if (priceRuleId) {
    shopifyDelete('price_rules/' + priceRuleId + '.json');
  } else {
    Logger.log('Void ' + cnNum + ': no price_rule_id on log row — skipping Shopify delete.');
  }

  // 2. Retire the serial (by seq parsed from the voucher number).
  var seq = parseInt(String(cnNum).split('-').pop(), 10);
  var retired = cancelSerialByCode_('voucher', seq);

  // 3. Mark the log row voided (col L).
  log.getRange(rowIdx + 1, 12).setValue('Voided');

  ui.alert('✅ ' + cnNum + ' voided.\n\nDiscount removed' +
           (retired ? ' and serial retired in the ledger.' : '. ⚠️ Ledger retire failed — check the logs.'));
}

// ── VOID EXCHANGE NOTE ────────────────────────────────────────────────────────
// Removes the EXC line item from the new draft and retires the serial. Only possible while the
// new sale is still a DRAFT (the middleware refuses if it has converted to an order).
function voidExchangeNote() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var log = ss.getSheetByName(EXCHANGE_LOG);
  var ui  = SpreadsheetApp.getUi();
  if (!log) { ui.alert('Log tab "' + EXCHANGE_LOG + '" not found.'); return; }

  var resp = ui.prompt('Void Exchange Note', 'Enter the EXC number to void (e.g. EXC-2026-0042):', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var excNum = String(resp.getResponseText()).trim();
  if (!excNum) { ui.alert('No EXC number entered.'); return; }

  var data = log.getDataRange().getValues();
  var rowIdx = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][1]).trim().toUpperCase() === excNum.toUpperCase()) { rowIdx = i; break; }
  }
  if (rowIdx === -1) { ui.alert(excNum + ' not found in ' + EXCHANGE_LOG + '.'); return; }

  var row        = data[rowIdx];
  var oldOrder   = String(row[2]).trim();   // col C
  var status     = String(row[11]).trim();  // col L
  var newDraftId = String(row[12]).trim();  // col M — resolved numeric draft id

  if (/void/i.test(status)) { ui.alert(excNum + ' is already voided.'); return; }

  var confirm = ui.alert('Void ' + excNum + '?',
    'This removes the exchange line from the new draft and retires the serial. Only works if the new sale is still a draft.',
    ui.ButtonSet.YES_NO);
  if (confirm !== ui.Button.YES) return;

  // Ask the middleware to remove the EXC line + cancel the serial.
  try {
    var res = UrlFetchApp.fetch(MIDDLEWARE_URL + '/api/exc-void', {
      method:             'post',
      contentType:        'application/json',
      muteHttpExceptions: true,
      payload:            JSON.stringify({ newDraftId: newDraftId, excNumber: excNum })
    });
    var body = {};
    try { body = JSON.parse(res.getContentText()); } catch (e) {}
    if (res.getResponseCode() !== 200) {
      ui.alert('❌ Could not void ' + excNum + ':\n\n' + ((body && body.error) || ('middleware ' + res.getResponseCode())));
      return;
    }
  } catch (e) {
    ui.alert('❌ Void failed: ' + e.message);
    return;
  }

  // Strip the exc-* tags from the old order.
  if (oldOrder) {
    var od = getOrderData(oldOrder.replace('#', ''));
    if (od && od.id) removeOrderTagsByPrefix_(od.id, ['exc-given', 'exc-num:', 'exc-val:', 'exc-applied-to:', 'exc-iss:']);
  }

  log.getRange(rowIdx + 1, 12).setValue('Voided');
  ui.alert('✅ ' + excNum + ' voided.\n\nExchange line removed from the draft and serial retired.');
}

// Removes any tags on an order that exactly match or start with one of the given prefixes.
function removeOrderTagsByPrefix_(orderId, prefixes) {
  var data = shopifyGet('orders/' + orderId + '.json?fields=id,tags');
  if (!data || !data.order) return;
  var existing = data.order.tags ? data.order.tags.split(', ').map(function (t) { return t.trim(); }) : [];
  var kept = existing.filter(function (t) {
    return !prefixes.some(function (p) { return t === p || t.indexOf(p) === 0; });
  });
  shopifyPut('orders/' + orderId + '.json', { order: { id: orderId, tags: kept.join(', ') } });
}

// Parses a dd-MM-yyyy string into a Date (end-of-day, IST-agnostic). Returns null if unparseable.
function parseDmy(s) {
  var m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(String(s).trim());
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 23, 59, 59);
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function toNum(val) {
  if (typeof val === 'number') return val;
  return parseFloat(String(val).replace(/[^0-9.-]/g, '')) || 0;
}

// ── TOKEN ─────────────────────────────────────────────────────────────────────
function getToken() {
  const props       = PropertiesService.getScriptProperties();
  const supabaseUrl = props.getProperty('SUPABASE_URL');
  const supabaseKey = props.getProperty('SUPABASE_SERVICE_KEY');

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase credentials not set. Use "Setup Supabase Credentials" from the menu.');
  }

  const res = UrlFetchApp.fetch(
    supabaseUrl + '/rest/v1/config?key=eq.shopify_access_token&select=value',
    {
      headers: { 'apikey': supabaseKey, 'Authorization': 'Bearer ' + supabaseKey },
      muteHttpExceptions: true
    }
  );

  if (res.getResponseCode() >= 400) {
    throw new Error('Supabase token fetch failed: ' + res.getContentText());
  }

  const rows = JSON.parse(res.getContentText());
  if (!rows || rows.length === 0) throw new Error('shopify_access_token not found in Supabase config table');
  return rows[0].value;
}

// Reads any row from the Supabase `config` table by key. Returns the raw string value, or null if
// absent. Same credentials/path as getToken (the token is just the shopify_access_token key).
function getSupabaseConfig_(key) {
  const props       = PropertiesService.getScriptProperties();
  const supabaseUrl = props.getProperty('SUPABASE_URL');
  const supabaseKey = props.getProperty('SUPABASE_SERVICE_KEY');
  if (!supabaseUrl || !supabaseKey) throw new Error('Supabase credentials not set. Use "Setup Supabase Credentials".');
  const res = UrlFetchApp.fetch(
    supabaseUrl + '/rest/v1/config?key=eq.' + encodeURIComponent(key) + '&select=value',
    { headers: { 'apikey': supabaseKey, 'Authorization': 'Bearer ' + supabaseKey }, muteHttpExceptions: true });
  if (res.getResponseCode() >= 400) throw new Error('Supabase config fetch failed: ' + res.getContentText());
  const rows = JSON.parse(res.getContentText());
  return (rows && rows.length) ? rows[0].value : null;
}

// Old-gold buy-back rate per gram for a (possibly fractional) karat. Reads the SAME buying_rate_table
// the middleware uses (server.js getBuyingRateTable/buyingRateFor), so the sheet and any middleware
// re-valuation agree to the paise. Formula: karat/24 × base_24k × (1 − haircut_pct/100).
// Returns null if the table is missing or purity is outside 0<p<=24.
function getBuyingRate_(purity) {
  var p = toNum(purity);
  if (!(p > 0) || p > 24) return null;
  var raw = getSupabaseConfig_('buying_rate_table');
  if (!raw) return null;
  var t;
  try { t = JSON.parse(raw); } catch (e) { return null; }
  if (!t || !(t.base_24k > 0)) return null;
  return Math.round((p / 24) * t.base_24k * (1 - (t.haircut_pct || 0) / 100) * 100) / 100;
}

// Looks up a customer by phone or email via the Shopify Admin API. Returns { id, name, email, phone }
// or null. Used by the Old Gold flow, which has no order to pull a customer from.
function lookupCustomer_(query) {
  var q = String(query || '').trim();
  if (!q) return null;
  var field = q.indexOf('@') !== -1 ? 'email' : 'phone';
  var data = shopifyGet('customers/search.json?query=' + encodeURIComponent(field + ':' + q));
  if (!data || !data.customers || !data.customers.length) return null;
  var c = data.customers[0];
  return {
    id:    c.id,
    name:  [c.first_name, c.last_name].filter(Boolean).join(' '),
    email: c.email || '',
    phone: (c.phone || (c.default_address && c.default_address.phone) || '')
  };
}

// Reads the source mode (Purchase Exchange | Old Gold) from SOURCE_CELL, lower-cased. Blank = default.
function currentSource_(calc) {
  return String(calc.getRange(SOURCE_CELL).getValue()).trim().toLowerCase();
}

// Original invoice's taxable (pre-GST) value for a Full-Value exchange: Shopify's post-discount,
// pre-tax subtotal. Returns 0 if the order can't be read. See the accountant note at the call site.
function getOrderTaxableValue_(orderNumber) {
  var name = String(orderNumber || '').replace('#', '').trim();
  if (!name) return 0;
  var data = shopifyGet('orders.json?name=%23' + name + '&status=any&fields=id,subtotal_price,total_tax,total_price');
  if (!data || !data.orders || !data.orders.length) return 0;
  return toNum(data.orders[0].subtotal_price);
}

// ── SHOPIFY HELPERS ───────────────────────────────────────────────────────────
function shopifyGet(endpoint) {
  const url = 'https://' + SHOPIFY_SHOP + '/admin/api/2024-01/' + endpoint;
  const res = UrlFetchApp.fetch(url, {
    headers: { 'X-Shopify-Access-Token': getToken() },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 400) {
    Logger.log('Shopify GET ' + endpoint + ' failed: ' + res.getContentText());
    return null;
  }
  return JSON.parse(res.getContentText());
}

function shopifyPost(endpoint, payload) {
  const url = 'https://' + SHOPIFY_SHOP + '/admin/api/2024-01/' + endpoint;
  const res = UrlFetchApp.fetch(url, {
    method:             'post',
    headers:            { 'X-Shopify-Access-Token': getToken(), 'Content-Type': 'application/json' },
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 400) {
    Logger.log('Shopify POST ' + endpoint + ' failed: ' + res.getContentText());
    return null;
  }
  return JSON.parse(res.getContentText());
}

function shopifyPut(endpoint, payload) {
  const url = 'https://' + SHOPIFY_SHOP + '/admin/api/2024-01/' + endpoint;
  const res = UrlFetchApp.fetch(url, {
    method:             'put',
    headers:            { 'X-Shopify-Access-Token': getToken(), 'Content-Type': 'application/json' },
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 400) return null;
  return JSON.parse(res.getContentText());
}

function shopifyDelete(endpoint) {
  var url = 'https://' + SHOPIFY_SHOP + '/admin/api/2024-01/' + endpoint;
  var res = UrlFetchApp.fetch(url, {
    method:             'delete',
    headers:            { 'X-Shopify-Access-Token': getToken() },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 400) {
    Logger.log('Shopify DELETE ' + endpoint + ' failed: ' + res.getContentText());
    return false;
  }
  return true;
}

function getOrderData(orderName) {
  const data = shopifyGet('orders.json?name=%23' + orderName + '&fields=id,tags,customer&status=any');
  if (data && data.orders && data.orders.length > 0) {
    const order = data.orders[0];
    return { id: order.id, customerId: order.customer ? order.customer.id : null };
  }
  return null;
}

function addOrderTags(orderId, newTags) {
  const data = shopifyGet('orders/' + orderId + '.json?fields=id,tags');
  if (!data) return;
  const existing = data.order.tags ? data.order.tags.split(', ').map(function(t) { return t.trim(); }) : [];
  newTags.forEach(function(tag) {
    // Remove any existing tag with the same prefix (e.g. old cn-val:) before adding the new one
    var prefix = tag.indexOf(':') !== -1 ? tag.split(':')[0] + ':' : null;
    if (prefix) {
      var idx = existing.findIndex(function(t) { return t.indexOf(prefix) === 0; });
      if (idx !== -1) existing.splice(idx, 1);
    }
    if (!existing.includes(tag)) existing.push(tag);
  });
  shopifyPut('orders/' + orderId + '.json', { order: { id: orderId, tags: existing.join(', ') } });
}

// ── DEBUG ─────────────────────────────────────────────────────────────────────
function debugCells() {
  const calc  = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CALC_SHEET_NAME);
  const cells = [SOURCE_CELL, EXCHTYPE_CELL, DOCTYPE_CELL, STORE_CODE_CELL, NEWDRAFT_CELL,
                 CUST_NAME_CELL, CUST_EMAIL_CELL, CUST_PHONE_CELL, ORDER_NUM_CELL, ORDER_DATE_CELL,
                 SKU_CELL, KARAT_CELL, NET_WT_CELL, DIA_CTS_CELL, GOLD_RATE_ORD_CELL, GOLD_RATE_LIVE_CELL,
                 GOLD_RATE_EFF_CELL, LGD_RATE_CELL, DIA_VALUE_CELL, GOLD_VAL_CELL, DIA_VAL_CELL,
                 NET_VALUE_CELL, DOCNUM_OUT_CELL];
  const lines = cells.map(function(ref) {
    const raw = calc.getRange(ref).getValue();
    return ref + ': [' + (typeof raw) + '] ' + raw;
  });
  SpreadsheetApp.getUi().alert(lines.join('\n'));
}

// Shows all line item properties for the current B7 order — confirms property names
function showLineItemProperties() {
  try {
    const calc = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CALC_SHEET_NAME);
    const raw  = String(calc.getRange(ORDER_NUM_CELL).getValue()).trim();
    if (!raw) { SpreadsheetApp.getUi().alert('Enter an order number in B7 first.'); return; }

    const orderName = raw.replace('#', '');
    const data      = shopifyGet('orders.json?name=%23' + orderName + '&status=any&fields=id,line_items');

    if (!data || !data.orders || data.orders.length === 0) {
      SpreadsheetApp.getUi().alert('Order #' + orderName + ' not found.');
      return;
    }

    const lineItems = data.orders[0].line_items || [];
    const lines     = [];

    lineItems.forEach(function(li, i) {
      lines.push('── Line item ' + (i + 1) + ': ' + (li.sku || li.title) + ' ──');
      (li.properties || []).forEach(function(p) { lines.push('  ' + p.name + ': ' + p.value); });
      if (!li.properties || li.properties.length === 0) lines.push('  (no properties)');
    });

    SpreadsheetApp.getUi().alert(lines.join('\n'));
  } catch (err) {
    SpreadsheetApp.getUi().alert('❌ Error: ' + err.message);
  }
}

// ── SETUP & TEST ──────────────────────────────────────────────────────────────
function setupSupabase() {
  const ui    = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();

  const urlResult = ui.prompt('Supabase URL', 'Paste your Supabase project URL (e.g. https://xyz.supabase.co)', ui.ButtonSet.OK_CANCEL);
  if (urlResult.getSelectedButton() !== ui.Button.OK) return;
  props.setProperty('SUPABASE_URL', urlResult.getResponseText().trim());

  const keyResult = ui.prompt('Supabase Service Key', 'Paste your service_role key (stored securely in script properties)', ui.ButtonSet.OK_CANCEL);
  if (keyResult.getSelectedButton() !== ui.Button.OK) return;
  props.setProperty('SUPABASE_SERVICE_KEY', keyResult.getResponseText().trim());

  ui.alert('Credentials saved. Run "Test API Connection" to verify.');
}

function testConnection() {
  const ui = SpreadsheetApp.getUi();
  try {
    const token = getToken();
    const res   = UrlFetchApp.fetch('https://' + SHOPIFY_SHOP + '/admin/api/2024-01/shop.json', {
      headers: { 'X-Shopify-Access-Token': token },
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    const body = res.getContentText();
    if (code >= 400) { ui.alert('❌ Shopify returned ' + code + ':\n' + body.substring(0, 300)); return; }
    const data = JSON.parse(body);
    if (data && data.shop) {
      ui.alert('✅ Connected to: ' + data.shop.name + '\nDomain: ' + data.shop.domain);
    } else {
      ui.alert('❌ Unexpected response:\n' + body.substring(0, 300));
    }
  } catch (err) {
    ui.alert('❌ Error: ' + err.message);
  }
}
