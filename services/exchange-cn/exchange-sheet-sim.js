#!/usr/bin/env node
//
// Exchange sheet simulator — the Apps Script end to end, without Google
// ======================================================================
// Runs the real EXCHANGE-CALCULATOR-FULL.gs.txt against a mock spreadsheet (with a small evaluator
// for the handful of formulas the calculator writes), a mock Shopify served from
// exchange-orders-snapshot.json + exchange-catalogue-live.json, and a mock Supabase config.
//
// It drives the same entry points staff do — typing an order number (handleEdit), picking pieces
// (applySkuSelection), flipping dropdowns, typing a weighed weight — and then asks the issue gate
// whether a document may go out and for how much. Every scenario asserts the outcome.
//
//   node services/exchange-cn/exchange-sheet-sim.js
//
// No network. Nothing here can reach Shopify, Supabase or the middleware.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = __dirname;
const snap = JSON.parse(fs.readFileSync(path.join(DIR, 'exchange-orders-snapshot.json'), 'utf8'));
const cat = JSON.parse(fs.readFileSync(path.join(DIR, 'exchange-catalogue-live.json'), 'utf8'));

// ── Mock spreadsheet ─────────────────────────────────────────────────────────────────────────────
function colToNum(c) { return c.split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0); }
function numToCol(n) { let s = ''; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

function makeSheet(name) {
  const cells = {};                          // A1 → { v, f, note, bg }
  const cell = (a1) => (cells[a1] = cells[a1] || {});
  const sheet = {
    cells, rules: [],
    getName: () => name,
    evalCell(a1, depth = 0) {
      const c = cells[a1];
      if (!c) return '';
      if (c.f) return evalFormula(c.f, (r) => sheet.evalCell(r, depth + 1), depth);
      return c.v === undefined || c.v === null ? '' : c.v;
    },
    getRange(a, b, nr, nc) {
      let refs;
      if (typeof a === 'string') refs = [a];
      else { refs = []; for (let r = a; r < a + (nr || 1); r++) for (let k = b; k < b + (nc || 1); k++) refs.push(numToCol(k) + r); }
      const first = refs[0];
      const rng = {
        getSheet: () => sheet,
        getA1Notation: () => first,
        getRow: () => Number(first.replace(/^[A-Z]+/, '')),
        getColumn: () => colToNum(first.replace(/\d+$/, '')),
        getValue: () => sheet.evalCell(first),
        getValues: () => [[sheet.evalCell(first)]],
        setValue: (v) => { refs.forEach((r) => { cell(r).v = v; delete cell(r).f; }); return rng; },
        setFormula: (f) => { refs.forEach((r) => { cell(r).f = f; delete cell(r).v; }); return rng; },
        clearContent: () => { refs.forEach((r) => { delete cell(r).v; delete cell(r).f; }); return rng; },
        clearNote: () => { refs.forEach((r) => { delete cell(r).note; }); return rng; },
        setNote: (n) => { refs.forEach((r) => { cell(r).note = n; }); return rng; },
        getNote: () => cell(first).note || '',
        setBackground: (bg) => { refs.forEach((r) => { cell(r).bg = bg; }); return rng; },
        setFontColor: () => rng, setFontStyle: () => rng, setFontWeight: () => rng,
        clearDataValidations: () => { refs.forEach((r) => { delete cell(r).dv; }); return rng; },
        setDataValidation: (dv) => { refs.forEach((r) => { cell(r).dv = dv; }); return rng; },
        getDataValidation: () => cell(first).dv || null,
        protect: () => ({ setDescription: () => ({ setWarningOnly: () => {} }) }),
      };
      return rng;
    },
    getConditionalFormatRules: () => sheet.rules.slice(),
    setConditionalFormatRules: (r) => { sheet.rules = r; },
    getProtections: () => [],
    getLastRow: () => 1,
    appendRow: () => {},
  };
  return sheet;
}

// Only the formula shapes the calculator writes. Anything else throws, so a new formula cannot
// slip past the simulator unevaluated.
function evalFormula(f, get, depth) {
  if (depth > 20) throw new Error('formula cycle at ' + f);
  let s = f.replace(/^=/, '');
  if (!/^[A-Z0-9_(),.*+\-"=:<> ]+$/.test(s)) throw new Error('unsupported formula: ' + f);
  s = s.replace(/SUM\(([A-Z]+)(\d+):([A-Z]+)(\d+)\)/g, (m, c1, r1, c2, r2) => `__sum("${c1}",${r1},"${c2}",${r2})`)
       .replace(/\bIF\(/g, '__if(').replace(/\bMIN\(/g, 'Math.min(').replace(/\bN\(/g, '__n(')
       .replace(/\b([A-Z]{1,2}\d+)=""/g, '(__v("$1")==="")')
       .replace(/(?<!["\w])([A-Z]{1,2}\d+)(?![\w"])/g, '__v("$1")');
  const __v = (r) => { const x = get(r); return x === '' ? '' : x; };
  const __n = (x) => (typeof x === 'number' ? x : (parseFloat(x) || 0));
  const __if = (c, a, b) => (c ? a : b);
  const __sum = (c1, r1, c2, r2) => { let t = 0; for (let r = r1; r <= r2; r++) t += __n(get(c1 + r)); return t; };
  // eslint-disable-next-line no-new-func
  const out = Function('__v', '__n', '__if', '__sum', 'return (' + s + ');')(__v, __n, __if, __sum);
  return typeof out === 'number' && isNaN(out) ? 0 : out;
}

// ── Mock services ────────────────────────────────────────────────────────────────────────────────
function makeEnv() {
  const calc = makeSheet('Exchange Calculator');
  const env = { calc, alerts: [], posts: [], answer: 'YES' };
  lastEnv = env;
  const Button = { YES: 'YES', NO: 'NO', OK: 'OK' };
  const ui = {
    Button, ButtonSet: { OK: 'OK', YES_NO: 'YES_NO', OK_CANCEL: 'OK_CANCEL' },
    alert(title, body, buttons) {
      env.alerts.push({ title: String(title), body: body === undefined ? '' : String(body) });
      return buttons === 'YES_NO' ? (env.answer === 'YES' ? Button.YES : Button.NO) : Button.OK;
    },
    prompt: () => ({ getSelectedButton: () => Button.CANCEL, getResponseText: () => '' }),
  };
  const store = () => { const m = {}; return {
    getProperty: (k) => (k in m ? m[k] : null), setProperty: (k, v) => { m[k] = String(v); },
    deleteProperty: (k) => { delete m[k]; }, _m: m }; };
  const scriptProps = store(), docProps = store();
  scriptProps.setProperty('SUPABASE_URL', 'https://supabase.mock');
  scriptProps.setProperty('SUPABASE_SERVICE_KEY', 'mock');

  const rateCfg = Object.assign({}, cat._gold_rate_config);
  delete rateCfg._note;
  const resp = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });

  const UrlFetchApp = {
    fetch(url, opts) {
      opts = opts || {};
      if (url.startsWith('https://supabase.mock')) {
        const key = decodeURIComponent((url.match(/key=eq\.([^&]+)/) || [])[1] || '');
        if (key === 'shopify_access_token') return resp(200, [{ value: 'shpat_mock' }]);
        if (key === 'gold_rate') return env.noRates ? resp(200, []) : resp(200, [{ value: JSON.stringify(rateCfg) }]);
        return resp(200, []);
      }
      // Writes are refused (nothing here may create a voucher); the one read-only POST is the
      // GraphQL catalogue search.
      if ((opts.method || 'get') !== 'get' && !/\/graphql\.json$/.test(url)) { env.posts.push(url); return resp(500, {}); }
      const ep = url.replace(/^.*\/admin\/api\/[^/]+\//, '');
      let m;
      if ((m = ep.match(/^orders\.json\?name=%23(\d+)/))) {
        const o = snap.orders.find((x) => x.name === '#' + m[1]);
        return resp(200, { orders: o ? [Object.assign({ customer: { first_name: 'Test', last_name: 'Customer', email: 'test@example.invalid' } }, o)] : [] });
      }
      if ((m = ep.match(/^variants\/(\d+)\.json/))) {
        const v = cat.variants[m[1]];
        if (!v || v.status === 'deleted') return resp(404, { errors: 'Not Found' });
        return resp(200, { variant: { id: Number(m[1]), sku: v.sku, product_id: v.product_id } });
      }
      if ((m = ep.match(/^variants\/(\d+)\/metafields\.json/))) {
        const v = cat.variants[m[1]];
        if (!v || v.status !== 'ok') return resp(404, {});
        return resp(200, { metafields: Object.entries(v.variant).map(([k, val]) => ({ namespace: 'custom', key: k, value: val })) });
      }
      if ((m = ep.match(/^products\/(\d+)\/metafields\.json/))) {
        const p = (cat.products || {})[m[1]];
        return resp(200, { metafields: p ? Object.entries(p.metafields).map(([k, val]) => ({ namespace: 'custom', key: k, value: val })) : [] });
      }
      if ((m = ep.match(/^products\/(\d+)\.json/))) {
        const p = (cat.products || {})[m[1]];
        return p ? resp(200, { product: { id: Number(m[1]), variants: p.variants } }) : resp(404, {});
      }
      if (ep === 'graphql.json') {
        // productVariants(query:"sku:CODE*") over the snapshot's live variants
        const q = (JSON.parse(opts.payload).query.match(/sku:([^*"\\]+)\*/) || [])[1] || '';
        const nodes = Object.entries(cat.variants)
          .filter(([, v]) => v.status === 'ok' && v.sku && v.sku.toUpperCase().startsWith(q.toUpperCase()))
          .map(([id, v]) => ({ legacyResourceId: id, sku: v.sku, product: { legacyResourceId: String(v.product_id) } }));
        return resp(200, { data: { productVariants: { nodes } } });
      }
      throw new Error('unmocked fetch: ' + url);
    },
  };

  const ctx = {
    console, Math, JSON, Date, Number, String, Object, Array, isNaN, parseFloat, parseInt, encodeURIComponent,
    Logger: { log() {} },
    SpreadsheetApp: {
      getUi: () => ui,
      getActiveSpreadsheet: () => ({ getSheetByName: (n) => (n === 'Exchange Calculator' ? calc : null) }),
      flush() {},
      newConditionalFormatRule: () => { const b = { whenFormulaSatisfied: (f) => { b.f = f; return b; },
        setBackground: () => b, setFontColor: () => b, setRanges: () => b,
        build: () => ({ getBooleanCondition: () => ({ getCriteriaValues: () => [b.f] }) }) }; return b; },
      newDataValidation: () => { const b = { requireValueInList: () => b, setAllowInvalid: () => b, build: () => ({}) }; return b; },
      ProtectionType: { RANGE: 'RANGE' },
    },
    PropertiesService: { getScriptProperties: () => scriptProps, getDocumentProperties: () => docProps },
    UrlFetchApp,
    Utilities: { formatDate: (d) => new Date(d).toISOString().slice(0, 10) },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(DIR, 'EXCHANGE-CALCULATOR-FULL.gs.txt'), 'utf8') +
    '\n;this.__x = { handleEdit, applySkuSelection, exchangeGate_, refreshFinalIssueValue_, buildCalcTable_, healCalcLabels_, ' +
    'ORDER_NUM_CELL, SKU_CELL, SOURCE_CELL, EXCHTYPE_CELL, DOCTYPE_CELL, WEIGHED_NETWT_CELL, OVERRIDE_REASON_CELL, ' +
    'FINAL_ISSUE_CELL, CHECKS_CELL, NET_WT_CELL, CUSTOM_DED_CELL, OG_WEIGHT_CELL };', ctx);
  env.x = ctx.__x;
  env.ui = ui;
  env.scriptProps = scriptProps;

  // Staff actions
  env.edit = (a1, value) => {
    const r = calc.getRange(a1);
    const oldValue = calc.evalCell(a1);
    r.setValue(value);
    env.x.handleEdit({ range: r, value, oldValue: oldValue === '' ? undefined : oldValue });
  };
  env.set = (a1, v) => calc.getRange(a1).setValue(v);
  env.val = (a1) => calc.evalCell(a1);
  env.lastAlert = () => env.alerts[env.alerts.length - 1] || { title: '', body: '' };
  env.gate = () => env.x.exchangeGate_(calc, ui);
  // What a fresh build lays down: the totals, NET and value-to-issue formulas, then the defaults.
  env.x.buildCalcTable_(calc);
  env.set(env.x.SOURCE_CELL, 'Purchase Exchange');
  env.set(env.x.EXCHTYPE_CELL, 'Deduction');
  env.set(env.x.DOCTYPE_CELL, 'Voucher');
  return env;
}

// ── Scenarios ────────────────────────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
let lastEnv = null;
const failures = [];
function check(name, ok, detail) {
  if (ok) pass++; else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); }
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!ok && lastEnv) lastEnv.alerts.slice(-2).forEach((a) => console.log('        last alert: ' + (a.title + ' | ' + a.body).replace(/\s+/g, ' ').slice(0, 300)));
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.02;
function scenario(title, fn) { console.log('\n' + title); try { fn(); } catch (e) { check('ran without throwing', false, e.stack.split('\n').slice(0, 3).join(' | ')); } }

scenario('#1045 legacy order, post-discount era — Deduction capped at the stone paid', () => {
  const e = makeEnv();
  e.edit(e.x.ORDER_NUM_CELL, '#1045');
  check('value to issue = 2.494 g × 8,831 + MIN(80% × 37,000, 12,759.59)', near(e.val(e.x.FINAL_ISSUE_CELL), 22024.51 + 12759.59), e.val(e.x.FINAL_ISSUE_CELL));
  check('checks cell asks for confirmation (catalogue weight)', /⚠️/.test(e.val(e.x.CHECKS_CELL)), e.val(e.x.CHECKS_CELL));
  e.answer = 'NO';
  check('gate refuses when staff answer NO', e.gate() === null);
  e.answer = 'YES';
  const g = e.gate();
  check('gate passes on YES with the checked value', g && near(g.value, 34784.10), g && g.value);
  check('the confirmation is recorded for the log', g && /catalogue weight/.test(g.note));
});

scenario('#1045 Full Value — credits what was charged, not the breakup (which is post-discount)', () => {
  const e = makeEnv();
  e.edit(e.x.ORDER_NUM_CELL, '#1045');
  e.edit(e.x.EXCHTYPE_CELL, 'Full Value');
  check('value to issue = ₹40,500 charged', near(e.val(e.x.FINAL_ISSUE_CELL), 40500), e.val(e.x.FINAL_ISSUE_CELL));
  const g = e.gate();
  check('gate passes', g && near(g.value, 40500));
});

scenario('#1060 already exchanged — blocked in both modes', () => {
  const e = makeEnv();
  e.edit(e.x.ORDER_NUM_CELL, '#1060');
  check('lookup alert names the earlier exchange note', /EXC27-KAHSR-0001/.test(e.lastAlert().body), e.lastAlert().body.slice(0, 80));
  check('Deduction gate refuses', e.gate() === null);
  e.edit(e.x.EXCHTYPE_CELL, 'Full Value');
  check('Full Value gate refuses', e.gate() === null);
  check('refusal says why', /already exchanged/.test(e.lastAlert().body));
});

scenario('#1045 looked up by the OLD script, then switched to Full Value — re-checks instead of showing 0', () => {
  const e = makeEnv();
  // What the old script leaves behind: order and SKU filled in, no checks stored, no "charged" figure.
  e.set(e.x.ORDER_NUM_CELL, '#1045');
  e.set(e.x.SKU_CELL, 'PD00021|Y|14|VVSVSEFG|H|NA|1.18|NA');
  e.edit(e.x.EXCHTYPE_CELL, 'Full Value');
  check('value to issue = ₹40,500, not 0', near(e.val(e.x.FINAL_ISSUE_CELL), 40500), e.val(e.x.FINAL_ISSUE_CELL));
  const g = e.gate();
  check('and it can be issued', g && near(g.value, 40500), g && g.value);
});

scenario('#1050 Full Value with no breakup on the order — issues the ₹58,865.89 charged, even if the display cell is blank', () => {
  const e = makeEnv();
  e.edit(e.x.ORDER_NUM_CELL, '#1050');
  e.edit(e.x.EXCHTYPE_CELL, 'Full Value');
  check('value to issue = ₹58,865.89', near(e.val(e.x.FINAL_ISSUE_CELL), 58865.89), e.val(e.x.FINAL_ISSUE_CELL));
  check('nothing is written to row 36 (a merged header on the live sheet) or B39',
        e.val('B36') === '' && e.val('B39') === '', 'B36=' + e.val('B36') + ' B39=' + e.val('B39'));
  check('Value to Issue reads no cell for the amount', !/B36|B39/.test(e.calc.cells[e.x.FINAL_ISSUE_CELL].f || ''),
        e.calc.cells[e.x.FINAL_ISSUE_CELL].f);
  const g = e.gate();
  check('and it issues', g && near(g.value, 58865.89), g && g.value);
});

scenario('#1056 discount split unknown — stone taken at the least it could have cost, no sign-off', () => {
  const e = makeEnv();
  e.edit(e.x.ORDER_NUM_CELL, '#1056');
  const g = e.gate();
  check('Deduction issues gold + ₹60,578 (Diamond 65,400 − whole 4,822 discount)', g && near(g.value, 1.570 * 11355 + 60578), g && g.value);
  e.edit(e.x.EXCHTYPE_CELL, 'Full Value');
  const g2 = e.gate();
  check('Full Value gate passes at ₹85,000', g2 && near(g2.value, 85000), g2 && g2.value);
});

scenario('#1041 no breakup, catalogue says 8.4 g on a ₹58,942 bangle — credit held to what was paid', () => {
  const e = makeEnv();
  const o = snap.orders.find((x) => x.name === '#1041');
  e.set(e.x.ORDER_NUM_CELL, '#1041');
  e.scriptProps.setProperty('_PENDING_LINE_ITEMS', JSON.stringify(o.line_items));
  e.scriptProps.setProperty('_PENDING_ORDER', JSON.stringify(Object.assign({}, o, { line_items: undefined })));
  e.x.applySkuSelection([0]);
  check('value to issue held to ₹57,225.22 (₹58,941.98 ex-GST)', near(e.val(e.x.FINAL_ISSUE_CELL), 57225.22), e.val(e.x.FINAL_ISSUE_CELL));
  const g = e.gate();
  check('gate passes after confirmation, and the log says why', g && near(g.value, 57225.22) && /held to/.test(g.note));
  e.set(e.x.CUSTOM_DED_CELL, -2000); e.x.refreshFinalIssueValue_(e.calc);
  check('a custom deduction still comes off the limited value', near(e.val(e.x.FINAL_ISSUE_CELL), 55225.22), e.val(e.x.FINAL_ISSUE_CELL));
});

scenario('#1050 sold variant id gone — a listing with the SAME code (RG00088) wins over RG00088A', () => {
  // Synthetic: the snapshot does not hold the live RG00088 listing (token rotated before it could be
  // read), so one is added here, alongside an RG00088A decoy on the order's own product.
  const add = {
    '90000000000001': { status: 'ok', sku: 'RG00088A|Y|18|VS-EF|H|20|0.47|NA', product_id: 9121815953665,
                        variant: { net_metal_weight_g: '2.766', gold_rate: '11355.0', price_breakup_diamond: '14100.0' } },
    '90000000000002': { status: 'ok', sku: 'RG00088|Y|18|VS-EF|H|20|0.44|NA', product_id: 9100000000002,
                        variant: { net_metal_weight_g: '2.900', gold_rate: '11355.0', price_breakup_diamond: '13200.0' } },
  };
  Object.assign(cat.variants, add);
  const prod = cat.products['9121815953665'], before = prod.variants;
  prod.variants = [{ id: 90000000000001, sku: add['90000000000001'].sku }];
  try {
    const e = makeEnv();
    e.edit(e.x.ORDER_NUM_CELL, '#1050');
    const msgs = e.alerts.map((a) => a.body).join(' ');
    check('the RG00088 listing is used, not RG00088A', /same code \(RG00088\|/.test(msgs) && !/RG00088A/.test(msgs), msgs.slice(0, 160));
    check('its weight (2.9 g) drives the gold value', /2\.9 g/.test(msgs));
  } finally {
    prod.variants = before;
    Object.keys(add).forEach((k) => delete cat.variants[k]);
  }
});

scenario('Lost draft-order label (as found on the live sheet) — restored on open', () => {
  const e = makeEnv();
  e.calc.getRange('A6').clearContent();
  e.x.healCalcLabels_(e.calc);
  check('A6 reads the New Draft label again', /New Draft\/Order #/.test(String(e.val('A6'))), e.val('A6'));
  e.calc.getRange('A6').setValue('Draft # (renamed by hand)');
  e.x.healCalcLabels_(e.calc);
  check('a hand-edited label is left alone', e.val('A6') === 'Draft # (renamed by hand)');
  e.calc.getRange('A36').setValue('Charged for this item (tax incl.)');   // written by the previous version
  e.calc.getRange('A39').setValue('Deduction limit (no breakup on order)');
  e.x.healCalcLabels_(e.calc);
  check('the labels the previous version put in rows 36 and 39 are removed', e.val('A36') === '' && e.val('A39') === '');
});

scenario('#1044 sold variant id gone, product live — valued off the product\'s current listing', () => {
  const e = makeEnv();
  e.edit(e.x.ORDER_NUM_CELL, '#1044');
  check('value = 0.834 g × 8,831 (ER00054A 14K WG) + diamond capped at the ₹12,967.84 paid',
        near(e.val(e.x.FINAL_ISSUE_CELL), 7365.05 + 12967.84), e.val(e.x.FINAL_ISSUE_CELL));
  const g0 = e.gate();
  check('issues after confirming the stand-in listing', g0 && /ER00054A/.test(g0.note));
  e.edit(e.x.WEIGHED_NETWT_CELL, 1.1);
  check('weighed weight without a reason is still blocked', e.gate() === null);
  check('…and says the reason is needed', /reason/.test(e.lastAlert().body));
  e.edit(e.x.OVERRIDE_REASON_CELL, 'weighed at counter, 1.25 g gross − 0.15 g stones');
  // Diamond: 80% of the current listing's ₹25,200 = ₹20,160, capped at the ₹12,967.84 actually paid.
  const want = 1.1 * 8831 + 12967.84;
  check('value = weighed 1.1 g × 8,831 + diamond capped at the ₹12,967.84 paid', near(e.val(e.x.FINAL_ISSUE_CELL), want), e.val(e.x.FINAL_ISSUE_CELL));
  const g = e.gate();
  check('gate passes after confirmation', g && near(g.value, want));
  check('log note records the weighed override', g && /weighed/.test(g.note));
});

scenario('#1055 seventeen coins on one line — two coins exchanged, not seventeen', () => {
  const e = makeEnv();
  const o = snap.orders.find((x) => x.name === '#1055');
  e.set(e.x.ORDER_NUM_CELL, '#1055');
  e.scriptProps.setProperty('_PENDING_LINE_ITEMS', JSON.stringify(o.line_items));
  e.scriptProps.setProperty('_PENDING_ORDER', JSON.stringify(Object.assign({}, o, { line_items: undefined })));
  e.x.applySkuSelection([0, 1]);                          // "1 of 17", "2 of 17"
  check('Deduction = 2 × 0.5 g × 22K rate', near(e.val(e.x.FINAL_ISSUE_CELL), 2 * 6939.42), e.val(e.x.FINAL_ISSUE_CELL));
  e.edit(e.x.EXCHTYPE_CELL, 'Full Value');
  check('Full Value = 2 × ₹7,846.50, not the ₹1,33,390.50 line', near(e.val(e.x.FINAL_ISSUE_CELL), 2 * 7846.50), e.val(e.x.FINAL_ISSUE_CELL));
  check('gate passes', !!e.gate());
});

scenario('#1055 silver coin — Deduction is 100% of the metal at today\'s catalogue silver price', () => {
  const e = makeEnv();
  const o = snap.orders.find((x) => x.name === '#1055');
  e.set(e.x.ORDER_NUM_CELL, '#1055');
  e.scriptProps.setProperty('_PENDING_LINE_ITEMS', JSON.stringify(o.line_items));
  e.scriptProps.setProperty('_PENDING_ORDER', JSON.stringify(Object.assign({}, o, { line_items: undefined })));
  e.x.applySkuSelection([17]);                            // first silver coin
  const g0 = e.gate();
  check('Deduction = 5 g × ₹290 = ₹1,450, no making, no GST', g0 && near(g0.value, 1450), g0 && g0.value);
  e.edit(e.x.EXCHTYPE_CELL, 'Full Value');
  const g = e.gate();
  check('Full Value = ₹1,519.25', g && near(g.value, 1519.25), g && g.value);
});

scenario('#1052 two items together — each capped on its own', () => {
  const e = makeEnv();
  const o = snap.orders.find((x) => x.name === '#1052');
  e.set(e.x.ORDER_NUM_CELL, '#1052');
  e.scriptProps.setProperty('_PENDING_LINE_ITEMS', JSON.stringify(o.line_items));
  e.scriptProps.setProperty('_PENDING_ORDER', JSON.stringify(Object.assign({}, o, { line_items: undefined })));
  e.x.applySkuSelection([0, 1]);
  check('Deduction = 2,80,352.28 + 1,73,970.75', near(e.val(e.x.FINAL_ISSUE_CELL), 280352.28 + 173970.75), e.val(e.x.FINAL_ISSUE_CELL));
  const g = e.gate();
  check('gate passes after confirming the deleted listing and the weight mismatch', g && /deleted/.test(g.note) && /13.25/.test(g.note));
});

scenario('Tampering — a calculated cell edited after the lookup', () => {
  const e = makeEnv();
  e.edit(e.x.ORDER_NUM_CELL, '#1072');
  e.set(e.x.NET_WT_CELL, 5);                              // someone overtypes the weight
  check('gate refuses the changed value', e.gate() === null);
  check('…and says the value does not match', /does not match/.test(e.lastAlert().title + e.lastAlert().body));
});

scenario('Custom deductions — negative is applied, positive is refused', () => {
  const e = makeEnv();
  e.edit(e.x.ORDER_NUM_CELL, '#1072');
  const base = e.val(e.x.FINAL_ISSUE_CELL);
  e.set(e.x.CUSTOM_DED_CELL, -1000); e.x.refreshFinalIssueValue_(e.calc);
  const g = e.gate();
  check('Deduction issues base − 1,000', g && near(g.value, base - 1000), g && g.value);
  e.edit(e.x.EXCHTYPE_CELL, 'Full Value');
  const g2 = e.gate();
  check('Full Value issues charged − 1,000', g2 && near(g2.value, 263346.71 - 1000), g2 && g2.value);
  e.set(e.x.CUSTOM_DED_CELL, 500); e.x.refreshFinalIssueValue_(e.calc);
  check('a positive custom deduction is refused', e.gate() === null);
});

scenario('Stale checks — SKU changed without a lookup', () => {
  const e = makeEnv();
  e.edit(e.x.ORDER_NUM_CELL, '#1072');
  e.set(e.x.SKU_CELL, 'SOMETHING-ELSE');
  check('gate refuses and asks for a fresh lookup', e.gate() === null && /not been checked/.test(e.lastAlert().title));
});

scenario('Old Gold toggle — the order block refuses input, and old gold needs the toggle first', () => {
  const e = makeEnv();
  e.edit(e.x.OG_WEIGHT_CELL, 10);
  check('old-gold weight refused under Purchase Exchange', e.val(e.x.OG_WEIGHT_CELL) === '' && /Old Gold first/.test(e.lastAlert().title));
  e.set(e.x.DOCTYPE_CELL, 'Exchange Note');
  e.edit(e.x.SOURCE_CELL, 'Old Gold');
  check('switching to Old Gold forces Voucher', e.val(e.x.DOCTYPE_CELL) === 'Voucher');
  check('the order block is grayed by a rule on the Source cell', e.calc.rules.length === 1);
  e.edit(e.x.ORDER_NUM_CELL, '#1072');
  check('an order number typed under Old Gold is put back', e.val(e.x.ORDER_NUM_CELL) === '' && /no order to look up/.test(e.lastAlert().title));
  e.edit(e.x.DOCTYPE_CELL, 'Exchange Note');
  check('Exchange Note refused under Old Gold', e.val(e.x.DOCTYPE_CELL) === 'Voucher');
  e.edit(e.x.SOURCE_CELL, 'Old Gold');
  check('re-applying the rule does not duplicate it', e.calc.rules.length === 1);
});

scenario('#1073 voucher already on the order (an overpayment refund) — confirm, not block', () => {
  const e = makeEnv();
  e.edit(e.x.ORDER_NUM_CELL, '#1073');
  e.answer = 'NO';
  check('staff can decline', e.gate() === null);
  e.answer = 'YES';
  const g = e.gate();
  check('staff can proceed after reading it', g && /VCH27-KAHSR-0002/.test(g.note));
});

scenario('Test / cancelled / refunded orders — nothing issues', () => {
  for (const n of ['#1011', '#1074', '#1005', '#1019']) {
    const e = makeEnv();
    e.edit(e.x.ORDER_NUM_CELL, n);
    const ded = e.gate();
    e.edit(e.x.EXCHTYPE_CELL, 'Full Value');
    const full = e.gate();
    check(n + ' refused in both modes', ded === null && full === null);
  }
});

scenario('Gold-rate config unreachable — falls back to the product rate and says so', () => {
  const e = makeEnv();
  e.noRates = true;
  e.edit(e.x.ORDER_NUM_CELL, '#1072');
  check('value still computed from the variant rate', near(e.val(e.x.FINAL_ISSUE_CELL), 3.94 * 8831 + 184000), e.val(e.x.FINAL_ISSUE_CELL));
});

console.log('\n' + '='.repeat(78));
console.log(`  ${pass} passed, ${fail} failed`);
failures.forEach((f) => console.log('  FAIL  ' + f));
console.log('='.repeat(78));
process.exit(fail ? 1 : 0);
