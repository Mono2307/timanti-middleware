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

// Document classification (run "Set up Document Type fields" once to build these cells).
// Both sit on row 37 (the blank row under NET CREDIT NOTE VALUE) so no existing rows shift —
// the script hardcodes B27/B28/B36/B43, so inserting rows would break them. setupDocTypeFields
// aborts if these cells (or their labels) aren't empty, so a wrong guess can't overwrite data.
// To relocate, change these two refs only — nothing else hardcodes the positions.
const DOCTYPE_CELL    = 'B37';   // dropdown: Voucher | Exchange Note   (label in A37)
const NEWDRAFT_CELL   = 'D37';   // new sale's draft/order # (Exchange Note only)  (label in C37)
const VOUCHER_LOG     = 'Voucher Log';   // renamed from 'CN Log'
const EXCHANGE_LOG    = 'Exchange Log';  // new tab for Exchange Notes

// ── MENU ─────────────────────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Timanti CN Tools')
    .addItem('✅  Create Document (Voucher / Exchange)', 'createDocument')
    .addItem('🗑️  Void Voucher', 'voidVoucher')
    .addItem('🗑️  Void Exchange Note', 'voidExchangeNote')
    .addSeparator()
    .addItem('🔄  Lookup Order Now', 'lookupOrderManual')
    .addSeparator()
    .addItem('🧩  Set up Document Type fields', 'setupDocTypeFields')
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
    if (col === 2 && row === 7)  { onOrderNumberEntered(sheet); return; }
    if (col === 2 && row === 10) { onSkuSelected(sheet);        return; }
  } catch (err) {
    SpreadsheetApp.getUi().alert('❌ Auto-fill error:\n' + err.message);
  }
}

// ── ORDER NUMBER → populate customer fields + SKU picker ─────────────────────
// allowModal: true when called from a menu item (has container.ui scope);
//             false/omitted when called from the installable onEdit trigger (no UI scope).
function onOrderNumberEntered(sheet, allowModal) {
  const raw = String(sheet.getRange('B7').getValue()).trim();
  if (!raw) return;

  // Clear all previously auto-filled cells
  ['B4','B5','B6','B8','B10','B12','B15','B16','B19','B20','C19','C20','B27','B28'].forEach(function(ref) {
    sheet.getRange(ref).clearContent();
  });
  sheet.getRange('B10').clearDataValidations();

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

  sheet.getRange('B4').setValue(name);
  sheet.getRange('B5').setValue(email);
  sheet.getRange('B6').setValue(phone);
  sheet.getRange('B8').setValue(orderDate);

  // ── Line items ───────────────────────────────────────────────────────────
  const lineItems = order.line_items || [];
  if (lineItems.length === 0) return;

  if (lineItems.length === 1) {
    // Auto-select and populate immediately
    sheet.getRange('B10').setValue(lineItems[0].sku || lineItems[0].title || '');
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
  var skuList = lineItems.map(function(li) { return li.sku || li.title || ''; });
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(skuList, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange('B10').clearContent();
  sheet.getRange('B10').setDataValidation(rule);
  sheet.getRange('B10').setNote(
    skuList.length + ' SKUs found.\n' +
    '• Pick one below for single-item rates.\n' +
    '• Use "🔄 Lookup Order Now" in the menu to select multiple SKUs.'
  );
}

// ── MULTI-SKU PROMPT (menu path — avoids showModalDialog scope restriction) ───
// Uses ui.prompt (plain text input) which works with the same scope as alert().
function showSkuCheckboxDialog(lineItems) {
  var ui       = SpreadsheetApp.getUi();
  var numbered = lineItems.map(function(li, i) {
    return (i + 1) + '. ' + (li.sku || li.title || 'Item ' + (i + 1));
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
    .filter(function(i) { return !isNaN(i) && i >= 0 && i < lineItems.length; });

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

  var lineItems = JSON.parse(json);
  var selected  = selectedIndices.map(function(i) { return lineItems[i]; });

  var sheet    = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CALC_SHEET_NAME);
  var skuLabel = selected.map(function(li) { return li.sku || li.title; }).join(', ');
  sheet.getRange('B10').setValue(skuLabel);
  sheet.getRange('B10').clearDataValidations();
  sheet.getRange('B10').clearNote();

  if (selected.length === 1) {
    populateFromLineItem(sheet, selected[0]);
  } else {
    populateFromMultipleLineItems(sheet, selected);
  }
}

// Aggregate net wt, dia cts, gold value, and dia value across multiple SKUs.
// B19 shows order-time rates as "X / Y", C19 shows live rates as "X / Y".
// B27 and B28 are written as numbers (sum) so the 80%/100% formula rows stay correct.
function populateFromMultipleLineItems(sheet, lineItems) {
  var totalNetWt       = 0;
  var totalDiaCts      = 0;
  var totalLiveDiaVal  = 0;
  var totalLiveGoldVal = 0;
  var orderRates       = [];
  var liveRates        = [];
  var karat            = null;
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
      if (netWt !== null) totalLiveGoldVal += netWt * goldRateLive;
    }
    if (!karat) karat = extractKarat(li.sku);
  });

  if (hasNetWt)  sheet.getRange('B15').setValue(totalNetWt);
  if (hasDiaCts) sheet.getRange('B16').setValue(totalDiaCts);
  if (karat)     sheet.getRange('B12').setValue(karat);

  if (orderRates.length) sheet.getRange('B19').setValue(orderRates.join(' / '));
  if (liveRates.length)  sheet.getRange('C19').setValue(liveRates.join(' / '));

  if (hasDiaVal) {
    sheet.getRange('B20').setValue(totalLiveDiaVal);
    sheet.getRange('C20').setValue(totalLiveDiaVal);
  }

  if (totalLiveGoldVal > 0) sheet.getRange('B27').setValue(totalLiveGoldVal);
  if (hasDiaVal)            sheet.getRange('B28').setValue(totalLiveDiaVal);

  SpreadsheetApp.flush();
}

// ── SKU SELECTED → populate jewel fields ─────────────────────────────────────
// Does a fresh Shopify call — avoids Script Properties 9 KB limit that caused
// silent cache failures. Low-volume tool so the extra call is fine.
function onSkuSelected(sheet) {
  const selected  = String(sheet.getRange('B10').getValue()).trim();
  if (!selected) return;

  const orderName = String(sheet.getRange('B7').getValue()).trim().replace('#', '');
  if (!orderName) return;

  const data = shopifyGet(
    'orders.json?name=%23' + orderName + '&status=any&fields=id,line_items'
  );

  if (!data || !data.orders || data.orders.length === 0) {
    SpreadsheetApp.getUi().alert('Order #' + orderName + ' not found — cannot load SKU data.');
    return;
  }

  const lineItems = data.orders[0].line_items || [];
  const li        = lineItems.find(function(item) {
    return (item.sku || item.title) === selected;
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

  if (netWt         !== null) sheet.getRange('B15').setValue(netWt);
  if (diaCts        !== null) sheet.getRange('B16').setValue(diaCts);
  if (goldRateOrder !== null) sheet.getRange('B19').setValue(goldRateOrder);
  if (goldRateLive  !== null) sheet.getRange('C19').setValue(goldRateLive);
  if (diaValue      !== null) {
    sheet.getRange('B20').setValue(diaValue);
    sheet.getRange('C20').setValue(diaValue);
    // B28 driven by C20 so the 80%/100% rows stay live
    sheet.getRange('B28').setFormula('=C20');
  }
  // B27 driven by C19 so the 80%/100% rows stay live
  // If your B27 formula includes a karat purity factor (e.g. =B15*(18/24)*C19), adjust here.
  if (goldRateLive !== null && netWt !== null) {
    sheet.getRange('B27').setFormula('=B15*C19');
  }

  var karat = extractKarat(lineItem.sku);
  if (karat) sheet.getRange('B12').setValue(karat);

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

  const customerName  = calc.getRange('B4').getValue();
  const customerEmail = calc.getRange('B5').getValue();
  const orderNumber   = String(calc.getRange('B7').getValue()).trim();
  const netWt         = toNum(calc.getRange('B15').getValue());
  const diaWt         = toNum(calc.getRange('B16').getValue());
  const goldVal       = toNum(calc.getRange('B27').getValue());
  const diaVal        = toNum(calc.getRange('B28').getValue());
  const netCredit     = toNum(calc.getRange('B36').getValue());

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
  const seq    = allocateVoucherSerial();
  const serial = String(seq != null ? seq : log.getLastRow()).padStart(4, '0');
  const cnNum  = 'VCH-' + year + '-' + serial;

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

  calc.getRange('B43').setValue(cnNum);

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
    'Order ' + orderNumber + ' tagged. Email sent to ' + customerEmail + '.'
  );
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

  const customerName  = calc.getRange('B4').getValue();
  const customerEmail = calc.getRange('B5').getValue();
  const orderNumber   = String(calc.getRange('B7').getValue()).trim();   // OLD order (item exchanged)
  const newDraftRef   = String(calc.getRange(NEWDRAFT_CELL).getValue()).trim();  // NEW sale's draft
  const netWt         = toNum(calc.getRange('B15').getValue());
  const diaWt         = toNum(calc.getRange('B16').getValue());
  const goldVal       = toNum(calc.getRange('B27').getValue());
  const diaVal        = toNum(calc.getRange('B28').getValue());
  const excValue      = toNum(calc.getRange('B36').getValue());

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
  const year   = today.getFullYear();
  const seq    = allocateExcSerial();
  if (seq == null) { ui.alert('Could not allocate an Exchange Note number (middleware unreachable). Try again.'); return; }
  const serial = String(seq).padStart(4, '0');
  const excNum = 'EXC-' + year + '-' + serial;
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

  calc.getRange('B43').setValue(excNum);

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
    'The new invoice total is reduced by this amount (GST unchanged). Email sent to ' + customerEmail + '.'
  );
}

// ── EMAIL — routed through middleware → Resend → hello@timanti.in ─────────────
// Voucher template: emailService.js → buildCreditNoteHtml() via POST /api/cn-email
// Exchange Note template: buildExchangeNoteHtml() via POST /api/exc-email
const MIDDLEWARE_URL = 'https://timanti-middleware.fly.dev'; // update if URL changes

function sendVoucherEmail_(customerName, customerEmail, cnNum, netCredit, expiryFmt, orderNumber) {
  if (!customerEmail) return;
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
// Allocates (and mints into the ledger) the next sequence number for a doc type.
// Returns the integer seq, or null on any failure.
function allocateSerial_(docType) {
  try {
    var res = UrlFetchApp.fetch(MIDDLEWARE_URL + '/api/serial/allocate', {
      method:             'post',
      contentType:        'application/json',
      muteHttpExceptions: true,
      payload:            JSON.stringify({ docType: docType })
    });
    if (res.getResponseCode() !== 200) {
      Logger.log(docType + ' serial warning: middleware returned ' + res.getResponseCode() + ' — ' + res.getContentText());
      return null;
    }
    var body = JSON.parse(res.getContentText());
    return (body && body.serial_no != null) ? Number(body.serial_no) : null;
  } catch (e) {
    Logger.log(docType + ' serial failed: ' + e.message);
    return null;
  }
}

// Voucher falls back to the sheet-row count if the middleware is down; Exchange Note does not
// (it must not be applied to an invoice without a real ledger number).
function allocateVoucherSerial() { return allocateSerial_('voucher'); }
function allocateExcSerial()     { return allocateSerial_('exchange_note'); }

// Retires a serial in the middleware ledger (status=cancelled, never reused). Identified by seq —
// the customer-facing VCH-/EXC-YYYY-NNNN shares only the seq with the ledger. Non-throwing.
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
  const cells = ['B4','B5','B6','B7','B8','B10','B12','B15','B16','B19','C19','B20','C20','B27','B28','B29','B36','B40','B43'];
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
    const raw  = String(calc.getRange('B7').getValue()).trim();
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
