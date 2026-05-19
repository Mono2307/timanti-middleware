// ─────────────────────────────────────────────────────────────────────────────
// TIMANTI — EXCHANGE CREDIT NOTE APPS SCRIPT
// Paste this entire file into Extensions → Apps Script inside the Google Sheet.
//
// SETUP (one-time):
//   1. Open Extensions → Apps Script
//   2. Paste this code, save
//   3. Run "Create Credit Note" from the Timanti CN Tools menu
//   4. First run will ask for permissions — approve all
//   5. Use "Setup Supabase Credentials" from the menu to store credentials
//
// SHOPIFY TOKEN: fetched live from Supabase config table (key = shopify_access_token)
// SHOPIFY SCOPES NEEDED: read_orders, write_orders, write_discounts
// ─────────────────────────────────────────────────────────────────────────────

const SHOPIFY_SHOP = 'auracarat.myshopify.com';

// ── MENU ─────────────────────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Timanti CN Tools')
    .addItem('✅  Create Credit Note & Tag Order', 'createCreditNote')
    .addSeparator()
    .addItem('🔑  Setup Supabase Credentials', 'setupSupabase')
    .addItem('🔍  Test API Connection', 'testConnection')
    .addItem('🐛  Debug Cell Values', 'debugCells')
    .addToUi();
}

// Strips ₹, commas, spaces — handles both number values and formatted strings
function toNum(val) {
  if (typeof val === 'number') return val;
  return parseFloat(String(val).replace(/[^0-9.-]/g, '')) || 0;
}

// ── DEBUG: run this first to verify cell references ──────────────────────────
function debugCells() {
  const calc = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Exchange Calculator');
  const cells = ['B4','B5','B7','B15','B16','B19','B20','B27','B28','B29','B36','B40','B43'];
  const lines = cells.map(ref => {
    const raw = calc.getRange(ref).getValue();
    return `${ref}: [${typeof raw}] ${raw}`;
  });
  SpreadsheetApp.getUi().alert(lines.join('\n'));
}

// ── MAIN FUNCTION ─────────────────────────────────────────────────────────────
function createCreditNote() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const calc = ss.getSheetByName('Exchange Calculator');
  const log  = ss.getSheetByName('CN Log');
  const ui   = SpreadsheetApp.getUi();

  // ── 1. Read inputs ────────────────────────────────────────────────────────
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

  // ── 2. Validate ────────────────────────────────────────────────────────────
  if (!customerEmail || !orderNumber || netCredit <= 0) {
    ui.alert('Missing data. Fill customer email, order number, and ensure net credit > 0.');
    return;
  }

  // ── 3. Generate CN number ──────────────────────────────────────────────────
  const year   = today.getFullYear();
  const serial = String(log.getLastRow()).padStart(4, '0');
  const cnNum  = `CNTM-${year}-${serial}`;

  // ── 4. Create Shopify price rule ───────────────────────────────────────────
  const expiryIso  = validUntil.toISOString();
  const priceRule  = shopifyPost('price_rules.json', {
    price_rule: {
      title:              cnNum,
      target_type:        'line_item',
      target_selection:   'all',
      allocation_method:  'across',
      value_type:         'fixed_amount',
      value:              `-${netCredit.toFixed(2)}`,
      customer_selection: 'all',
      starts_at:          today.toISOString(),
      ends_at:            expiryIso,
      usage_limit:        1
    }
  });

  if (!priceRule || !priceRule.price_rule) {
    ui.alert('Failed to create price rule in Shopify. Check Supabase credentials and token scopes.');
    return;
  }

  // ── 5. Create discount code ────────────────────────────────────────────────
  const priceRuleId = priceRule.price_rule.id;
  const discCode    = shopifyPost(`price_rules/${priceRuleId}/discount_codes.json`, {
    discount_code: { code: cnNum }
  });

  if (!discCode || !discCode.discount_code) {
    ui.alert('Price rule created but discount code failed. Check Shopify manually.');
    return;
  }

  // ── 6. Write CN number back to sheet ──────────────────────────────────────
  calc.getRange('B43').setValue(cnNum);

  // ── 7. Write CN metafields + tag order ───────────────────────────────────
  const cleanOrderNum = orderNumber.replace('#', '');
  const orderId       = getOrderId(cleanOrderNum);

  if (orderId) {
    shopifyPost(`orders/${orderId}/metafields.json`, {
      metafield: { namespace: 'timanti', key: 'cn_number', value: cnNum, type: 'single_line_text_field' }
    });
    shopifyPost(`orders/${orderId}/metafields.json`, {
      metafield: { namespace: 'timanti', key: 'cn_value', value: String(netCredit.toFixed(2)), type: 'single_line_text_field' }
    });
    shopifyPost(`orders/${orderId}/metafields.json`, {
      metafield: { namespace: 'timanti', key: 'cn_expiry', value: expiryFmt, type: 'single_line_text_field' }
    });
    addOrderTag(orderId, 'cn-issued');
  } else {
    Logger.log(`Order ${orderNumber} not found in Shopify — metafields and tag not added`);
  }

  // ── 8. Append to CN Log ────────────────────────────────────────────────────
  const issued    = Utilities.formatDate(today, 'Asia/Kolkata', 'dd-MM-yyyy');
  const expiryFmt = Utilities.formatDate(validUntil, 'Asia/Kolkata', 'dd-MM-yyyy');

  log.appendRow([
    issued,
    cnNum,
    orderNumber,
    customerName,
    customerEmail,
    netWt,
    diaWt,
    goldVal,
    diaVal,
    netCredit,
    expiryFmt,
    'Issued',
    ''
  ]);

  // ── 9. Done ────────────────────────────────────────────────────────────────
  ui.alert(
    `✅ Credit Note Created\n\n` +
    `CN Number: ${cnNum}\n` +
    `Discount Code: ${cnNum}\n` +
    `Net Value: ₹${netCredit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}\n` +
    `Valid Until: ${expiryFmt}\n\n` +
    `Tag 'cn-issued' added to order ${orderNumber}.\n` +
    `Resend will trigger the email to ${customerEmail} (when server flag is enabled).`
  );
}

// ── TOKEN: fetched live from Supabase config table ────────────────────────────
function getToken() {
  const props       = PropertiesService.getScriptProperties();
  const supabaseUrl = props.getProperty('SUPABASE_URL');
  const supabaseKey = props.getProperty('SUPABASE_SERVICE_KEY');

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase credentials not set. Use "Setup Supabase Credentials" from the menu.');
  }

  const res = UrlFetchApp.fetch(
    `${supabaseUrl}/rest/v1/config?key=eq.shopify_access_token&select=value`,
    {
      headers: {
        'apikey':        supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      },
      muteHttpExceptions: true
    }
  );

  if (res.getResponseCode() >= 400) {
    throw new Error(`Supabase token fetch failed: ${res.getContentText()}`);
  }

  const rows = JSON.parse(res.getContentText());
  if (!rows || rows.length === 0) throw new Error('shopify_access_token not found in Supabase config table');
  return rows[0].value;
}

// ── SHOPIFY HELPERS ───────────────────────────────────────────────────────────
function shopifyPost(endpoint, payload) {
  const url = `https://${SHOPIFY_SHOP}/admin/api/2024-01/${endpoint}`;
  const res = UrlFetchApp.fetch(url, {
    method:  'post',
    headers: {
      'X-Shopify-Access-Token': getToken(),
      'Content-Type':           'application/json'
    },
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 400) {
    Logger.log(`Shopify POST ${endpoint} failed: ${res.getContentText()}`);
    return null;
  }
  return JSON.parse(res.getContentText());
}

function shopifyGet(endpoint) {
  const url = `https://${SHOPIFY_SHOP}/admin/api/2024-01/${endpoint}`;
  const res = UrlFetchApp.fetch(url, {
    headers: { 'X-Shopify-Access-Token': getToken() },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 400) return null;
  return JSON.parse(res.getContentText());
}

function shopifyPut(endpoint, payload) {
  const url = `https://${SHOPIFY_SHOP}/admin/api/2024-01/${endpoint}`;
  const res = UrlFetchApp.fetch(url, {
    method:  'put',
    headers: {
      'X-Shopify-Access-Token': getToken(),
      'Content-Type':           'application/json'
    },
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 400) return null;
  return JSON.parse(res.getContentText());
}

function getOrderId(orderName) {
  const data = shopifyGet(`orders.json?name=%23${orderName}&fields=id,tags&status=any`);
  if (data && data.orders && data.orders.length > 0) return data.orders[0].id;
  return null;
}

function addOrderTag(orderId, newTag) {
  const data = shopifyGet(`orders/${orderId}.json?fields=id,tags`);
  if (!data) return;
  const existing = data.order.tags ? data.order.tags.split(', ').map(t => t.trim()) : [];
  if (existing.includes(newTag)) return;
  existing.push(newTag);
  shopifyPut(`orders/${orderId}.json`, {
    order: { id: orderId, tags: existing.join(', ') }
  });
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
    ui.alert('Token fetched: ' + token.substring(0, 10) + '...\nNow testing Shopify...');

    const url = `https://${SHOPIFY_SHOP}/admin/api/2024-01/shop.json`;
    const res = UrlFetchApp.fetch(url, {
      headers: { 'X-Shopify-Access-Token': token },
      muteHttpExceptions: true
    });

    const statusCode = res.getResponseCode();
    const body = res.getContentText();

    if (statusCode >= 400) {
      ui.alert(`❌ Shopify returned ${statusCode}:\n${body.substring(0, 300)}`);
      return;
    }

    const data = JSON.parse(body);
    if (data && data.shop) {
      ui.alert(`✅ Connected to: ${data.shop.name}\nDomain: ${data.shop.domain}`);
    } else {
      ui.alert(`❌ Unexpected response:\n${body.substring(0, 300)}`);
    }
  } catch (err) {
    ui.alert(`❌ Error: ${err.message}`);
  }
}
