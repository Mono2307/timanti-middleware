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

// ── MENU ─────────────────────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Timanti CN Tools')
    .addItem('✅  Create Credit Note & Tag Order', 'createCreditNote')
    .addSeparator()
    .addItem('🔄  Lookup Order Now', 'lookupOrderManual')
    .addSeparator()
    .addItem('⚙️  Setup Auto-fill Triggers', 'setupTriggers')
    .addItem('🗑️  Remove Auto-fill Triggers', 'removeTriggers')
    .addSeparator()
    .addItem('🔑  Setup Supabase Credentials', 'setupSupabase')
    .addItem('🔍  Test API Connection', 'testConnection')
    .addItem('🐛  Debug Cell Values', 'debugCells')
    .addItem('🐛  Show Line Item Properties', 'showLineItemProperties')
    .addToUi();
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

// ── MAIN FUNCTION: CREATE CREDIT NOTE ────────────────────────────────────────
function createCreditNote() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const calc = ss.getSheetByName(CALC_SHEET_NAME);
  const log  = ss.getSheetByName('CN Log');
  const ui   = SpreadsheetApp.getUi();

  const customerName  = calc.getRange('B4').getValue();
  const customerEmail = calc.getRange('B5').getValue();
  const orderNumber   = String(calc.getRange('B7').getValue()).trim();
  const netWt         = toNum(calc.getRange('B15').getValue());
  const diaWt         = toNum(calc.getRange('B16').getValue());
  const goldVal       = toNum(calc.getRange('B27').getValue());
  const diaVal        = toNum(calc.getRange('B28').getValue());
  const netCredit     = toNum(calc.getRange('B36').getValue());

  const today      = new Date();
  const validUntil = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 90);

  if (!customerEmail || !orderNumber || netCredit <= 0) {
    ui.alert('Missing data. Fill customer email, order number, and ensure net credit > 0.');
    return;
  }

  const year   = today.getFullYear();
  // Serial now comes from the central counter service (atomic, no gaps/dupes across devices).
  // Falls back to the legacy sheet-row count if the middleware is unreachable.
  const seq    = allocateCnSerial();
  const serial = String(seq != null ? seq : log.getLastRow()).padStart(4, '0');
  const cnNum  = 'CNTM-' + year + '-' + serial;

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

  if (orderId) {
    addOrderTags(orderId, [
      'cn-issued',
      'cn-num:' + cnNum,
      'cn-val:' + netCredit.toFixed(2),
      'cn-exp:' + expiryFmt,
      'cn-iss:' + issued
    ]);
  } else {
    ui.alert('⚠️ Order ' + orderNumber + ' not found in Shopify. CN created but order not tagged.');
  }

  log.appendRow([issued, cnNum, orderNumber, customerName, customerEmail,
                 netWt, diaWt, goldVal, diaVal, netCredit, expiryFmt, 'Issued', '']);

  sendCnEmailViaMiddleware(customerName, customerEmail, cnNum, netCredit, expiryFmt, orderNumber);

  ui.alert(
    '✅ Credit Note Created\n\n' +
    'CN Number: ' + cnNum + '\n' +
    'Discount Code: ' + cnNum + '\n' +
    'Net Value: ₹' + netCredit.toLocaleString('en-IN', { minimumFractionDigits: 2 }) + '\n' +
    'Valid Until: ' + expiryFmt + '\n\n' +
    "Tag 'cn-issued' added to order " + orderNumber + '.\n' +
    'Resend will trigger the email to ' + customerEmail + ' (when server flag is enabled).'
  );
}

// ── EMAIL — routed through middleware → Resend → hello@timanti.in ─────────────
// Template: emailService.js → buildCreditNoteHtml()
// Middleware route: POST /api/cn-email
const MIDDLEWARE_URL = 'https://timanti-middleware.fly.dev'; // update if URL changes

function sendCnEmailViaMiddleware(customerName, customerEmail, cnNum, netCredit, expiryFmt, orderNumber) {
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
      Logger.log('CN email warning: middleware returned ' + code + ' — ' + res.getContentText());
    }
  } catch (e) {
    Logger.log('CN email failed: ' + e.message);
  }
}

// ── CN SERIAL — central counter via middleware ────────────────────────────────
// Returns the next credit_note sequence number (integer), or null on any failure
// so the caller can fall back to the legacy sheet-row count.
function allocateCnSerial() {
  try {
    var res = UrlFetchApp.fetch(MIDDLEWARE_URL + '/api/serial/allocate', {
      method:             'post',
      contentType:        'application/json',
      muteHttpExceptions: true,
      payload:            JSON.stringify({ docType: 'credit_note' })
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('CN serial warning: middleware returned ' + res.getResponseCode() + ' — ' + res.getContentText());
      return null;
    }
    var body = JSON.parse(res.getContentText());
    return (body && body.serial_no != null) ? Number(body.serial_no) : null;
  } catch (e) {
    Logger.log('CN serial failed: ' + e.message);
    return null;
  }
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
