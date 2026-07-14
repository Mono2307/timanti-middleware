'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { parse: csvParse } = require('csv-parse/sync');
const XLSX = require('xlsx');

// ── Date helpers ───────────────────────────────────────────────────────────────

function parsePineDate(s) {
  // "25/04/2026 08:32:10 PM"  or  "10/05/2026 08:04:38 PM"
  s = (s || '').trim();
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00Z`) : null;
}

function parseMPRDate(v) {
  // "25-Apr-26"
  const months = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};
  const m = String(v || '').match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
  if (!m) return null;
  const mo = String(months[m[2]] || 1).padStart(2,'0');
  return new Date(`${2000+parseInt(m[3])}-${mo}-${m[1].padStart(2,'0')}T00:00:00Z`);
}

function parseGKDate(s) {
  s = (s || '').trim();
  // "30-04-2026 17:53"
  let m = s.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00Z`);
  // "7/5/2026 02:28 PM"  (M/D/YYYY — May GoKwik format)
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}T00:00:00Z`);
  return null;
}

function parseShopDate(s) {
  s = (s || '').trim();
  // "2026-04-19"
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(`${s.slice(0,10)}T00:00:00Z`);
  // "26/4/2026"  or  "1/5/2026"
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}T00:00:00Z`);
  return null;
}

function fmtDate(d) { return d ? d.toISOString().slice(0,10) : ''; }
function daysDiff(a, b) {
  if (!a || !b) return 999;
  return Math.abs(a.getTime() - b.getTime()) / 86400000;
}

// ── String helpers ─────────────────────────────────────────────────────────────

function stripApos(s) { return (s || '').replace(/^'+/, '').trim(); }

function parseBillInvoice(raw) {
  const s = stripApos(raw);
  const m = s.match(/(#[A-Z]\d+)/i);
  return m ? m[1].toUpperCase() : '';
}

function normPlatformRef(s) {
  s = (s || '').trim();
  if (!s || /^GKMREF/i.test(s) || /^KWIK/i.test(s)) return '';
  if (s.startsWith('#')) return s;
  if (/^D\d+$/i.test(s)) return '#' + s.toUpperCase();
  return '';
}

function isTest(amount, orderNumber) {
  return amount < 2 || /TEST/i.test(orderNumber || '');
}

function nameSim(a, b) {
  if (!a || !b) return 0;
  const tok = s => s.toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(Boolean);
  const ta = new Set(tok(a));
  const hits = tok(b).filter(t => ta.has(t)).length;
  return hits / Math.max(ta.size, tok(b).length, 1);
}

// ── File finder ────────────────────────────────────────────────────────────────

function findFiles(dir, keyword) {
  return fs.readdirSync(dir)
    .filter(f => f.toLowerCase().includes(keyword.toLowerCase()))
    .sort();
}

// ── Pine Labs parsers ──────────────────────────────────────────────────────────

function loadPineTxns(dir) {
  const files = findFiles(dir, 'all transactions').filter(f => f.endsWith('.csv'));
  const seen = new Set();
  const txns = [];
  for (const fname of files) {
    const rows = csvParse(fs.readFileSync(path.join(dir, fname), 'utf8'), { columns: true, skip_empty_lines: true, relax_quotes: true });
    for (const r of rows) {
      if ((r['Txn Status'] || '').toLowerCase() !== 'success') continue;
      const amount = parseFloat(r['Amount'] || '0');
      if (isTest(amount)) continue;
      const txnId = stripApos(r['Transaction ID'] || '');
      if (seen.has(txnId)) continue;
      seen.add(txnId);
      const cpm = r['Customer Payment Mode ID'] || '';
      const last4 = cpm.includes('****') ? cpm.replace(/'+/g,'').split('****').pop() : '';
      txns.push({
        source:      'Pine Labs',
        txnId,
        date:        parsePineDate(r['Date'] || ''),
        settlDate:   null,
        amount,
        fee:         0,
        netPaid:     0,
        utr:         '',
        paymentMode: (r['Payment Mode'] || '').toUpperCase(),
        name:        (r['Name'] || '').trim(),
        vpa:         stripApos(cpm),
        cardLast4:   last4,
        billInvoice: parseBillInvoice(r['Bill Invoice'] || ''),
      });
    }
  }
  return txns;
}

function loadMPR(dir) {
  const files = findFiles(dir, 'mpr').filter(f => f.endsWith('.xlsx'));
  const byId = {};
  for (const fname of files) {
    const fpath = path.join(dir, fname);
    // Copy to temp to avoid OneDrive lock
    const tmp = path.join(os.tmpdir(), `mpr_${Date.now()}_${fname}`);
    fs.copyFileSync(fpath, tmp);
    let wb;
    try { wb = XLSX.readFile(tmp, { cellDates: false }); } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
    const ws = wb.Sheets['Trxn details'];
    if (!ws) continue;
    const all = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    // Row 0 = section labels, Row 1 = column names
    const hdrs = all[1] || [];
    const col = name => hdrs.indexOf(name);
    for (const r of all.slice(2)) {
      if (r[col('Trxn type')] !== 'SALE') continue;
      const tid = String(r[col('Transaction Id')] || '').trim();
      if (!tid || byId[tid]) continue;
      const pan = String(r[col('Card Pan Number')] || '').replace(/\*/g, '');
      byId[tid] = {
        fee:       parseFloat(r[col('Total Fee (including Taxes)')] || '0'),
        netPaid:   parseFloat(r[col('Paid to Merchant A/c')] || '0'),
        utr:       String(r[col('UTR No')] || '').trim(),
        settlDate: parseMPRDate(r[col('Settlement Date')]),
        // Extra fields to reconstruct a settlement-only transaction (a SALE that
        // settled here but is missing from the "All transactions" export).
        txnDate:    parseMPRDate(r[col('Txn Date')]),
        gross:      parseFloat(r[col('Gross Txn Amount')] || '0'),
        instrument: String(r[col('Instrument Type')] || '').trim(),
        cardLast4:  pan ? pan.slice(-4) : '',
        vpa:        String(r[col('Payer VPA')] || '').trim(),
      };
    }
  }
  return byId;
}

// ── GoKwik parsers ────────────────────────────────────────────────────────────

function loadGKTxns(dir) {
  const files = findFiles(dir, 'transaction-report').filter(f => f.endsWith('.csv'));
  const seen = new Set();
  const txns = [];
  for (const fname of files) {
    const rows = csvParse(fs.readFileSync(path.join(dir, fname), 'utf8'), { columns: true, skip_empty_lines: true, relax_quotes: true });
    for (const r of rows) {
      if ((r['Status'] || '').toLowerCase() !== 'success') continue;
      const amount = parseFloat(r['Amount'] || '0');
      const orderNum = r['Order Number'] || '';
      if (isTest(amount, orderNum)) continue;
      const pid = (r['Payment ID'] || '').trim();
      if (seen.has(pid)) continue;
      seen.add(pid);
      // Draft refs sit in Order Number (D41, D72…); Shopify order refs (#1028) sit in Platform order number
      const ref = normPlatformRef(orderNum) || normPlatformRef(r['Platform order number'] || '');
      txns.push({
        source:          'GoKwik',
        paymentId:       pid,
        platformOrderNum: ref,
        date:            parseGKDate(r['Created At'] || ''),
        amount,
        fee:             0,
        netPaid:         0,
        settlDate:       null,
        utr:             '',
        paymentMode:     (r['Payment Mode'] || '').toUpperCase(),
        vpa:             (r['Payer vpa'] || '').trim(),
        cardLast4:       (r['Card Last 4 Digits'] || '').trim(),
        platformOrderId: '',
      });
    }
  }
  return txns;
}

function loadGKSettlement(dir) {
  const files = findFiles(dir, 'settlement_v2').filter(f => f.endsWith('.csv'));
  const byPid = {};
  for (const fname of files) {
    const rows = csvParse(fs.readFileSync(path.join(dir, fname), 'utf8'), { columns: true, skip_empty_lines: true, relax_quotes: true });
    for (const r of rows) {
      if ((r['Transaction Type'] || '').toLowerCase() !== 'payment') continue;
      const pid = (r['Payment Id'] || '').trim();
      if (!pid || byPid[pid]) continue;
      byPid[pid] = {
        platformOrderId: normPlatformRef(r['Platform Order Id'] || ''),
        fee:             parseFloat(r['Fee'] || '0') + parseFloat(r['Tax'] || '0'),
        netPaid:         parseFloat(r['Credit'] || '0'),
        utr:             (r['Settlement UTR'] || '').trim(),
        settlDate:       parseGKDate(r['Settlement Date'] || ''),
      };
    }
  }
  return byPid;
}

// ── Shopify data parsers ───────────────────────────────────────────────────────

function loadShopifyOrders(dir) {
  const file = findFiles(dir, 'accounts').find(f => f.endsWith('.csv'));
  if (!file) return [];
  const rows = csvParse(fs.readFileSync(path.join(dir, file), 'utf8'), { columns: true, skip_empty_lines: true, relax_quotes: true });
  const map = {};
  for (const r of rows) {
    const ref = (r['Order name'] || '').trim();
    if (!ref) continue;
    if (!map[ref]) map[ref] = { ref, customer: (r['Customer name'] || '').trim(), date: parseShopDate(r['Day'] || ''), total: 0, type: 'order' };
    map[ref].total += parseFloat(r['Net sales'] || '0');
  }
  return Object.values(map);
}

function loadShopifyDrafts(dir) {
  const file = findFiles(dir, 'draft-orders-report').find(f => f.endsWith('.csv'));
  if (!file) return [];
  const rows = csvParse(fs.readFileSync(path.join(dir, file), 'utf8'), { columns: true, skip_empty_lines: true, relax_quotes: true });
  const map = {};
  for (const r of rows) {
    const ref = (r['Order name'] || '').trim();
    if (!ref) continue;
    if (!map[ref]) map[ref] = { ref, customer: (r['Customer name'] || '').trim(), date: parseShopDate(r['Day'] || ''), total: 0, type: 'draft', paymentTags: r['Payment Tags'] || '' };
    map[ref].total += parseFloat(r['Net sales'] || '0');
  }
  const drafts = Object.values(map);
  // Parse advance_paid from payment tags: "paid:Rs96000"
  for (const d of drafts) {
    const m = (d.paymentTags || '').match(/paid:Rs(\d+)/);
    if (m) d.advance_paid = parseInt(m[1]);
  }
  return drafts;
}

// ── Shopify API: draft→order mapping ─────────────────────────────────────────

async function buildDraftToOrderMap(draftRefs, storeUrl, token) {
  const map = {};
  if (!storeUrl || !token || draftRefs.length === 0) return map;
  let url = `${storeUrl}/admin/api/2024-01/draft_orders.json?status=completed&limit=250`;
  const matched = [];
  while (url) {
    const resp = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    if (!resp.ok) break;
    const data = await resp.json();
    for (const d of (data.draft_orders || [])) {
      if (draftRefs.includes(d.name) && d.order_id) matched.push(d);
    }
    const link = resp.headers.get('Link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  for (const d of matched) {
    try {
      const r = await fetch(`${storeUrl}/admin/api/2024-01/orders/${d.order_id}.json?fields=id,name`, { headers: { 'X-Shopify-Access-Token': token } });
      const j = await r.json();
      if (j.order) map[d.name] = j.order.name;
    } catch (_) {}
  }
  return map;
}

// ── Matching ──────────────────────────────────────────────────────────────────

function findCandidates(amount, entities) {
  return entities.filter(e =>
    Math.abs(e.total - amount) <= 1.5 ||
    (e.type === 'draft' && e.advance_paid != null && Math.abs(e.advance_paid - amount) <= 1.5)
  );
}

function matchByAmountDate(txn, entities) {
  const cands = findCandidates(txn.amount, entities);
  if (!cands.length) return { method: 'UNLINKED', match: null, confidence: 'NONE', notes: 'No amount match' };

  const name = txn.name || txn.vpa || '';
  const scored = cands
    .map(e => ({ e, days: daysDiff(txn.date, e.date), sim: nameSim(name, e.customer) }))
    .filter(x => x.days <= 3)
    .sort((a, b) => a.days - b.days || b.sim - a.sim);

  if (!scored.length) return { method: 'UNLINKED', match: null, confidence: 'NONE', notes: 'Amount match but >3d date gap' };
  if (scored.length === 1) return { method: 'AMOUNT_DATE', match: scored[0].e, confidence: scored[0].days <= 1 ? 'MEDIUM' : 'LOW', notes: '' };

  const [top, sec] = scored;
  if (top.sim > 0.25 && top.sim > sec.sim + 0.2) return { method: 'AMOUNT_DATE', match: top.e, confidence: 'MEDIUM', notes: `Name preferred over ${sec.e.ref}` };
  if (top.days < sec.days - 0.5) return { method: 'AMOUNT_DATE', match: top.e, confidence: 'LOW', notes: `Closer date preferred over ${sec.e.ref}` };

  const note = scored.map(x => `${x.e.ref}(Δ${x.days.toFixed(0)}d,${(x.sim*100).toFixed(0)}%)`).join(' | ');
  return { method: 'AMBIGUOUS', match: null, confidence: 'AMBIGUOUS', notes: note };
}

function determineRole(amount, entity) {
  if (!entity) return 'unknown';
  const diff = entity.total - amount;
  if (Math.abs(diff) <= 1.5) return 'full_payment';
  if (diff > 1.5) return 'advance';
  return 'overpayment';
}

// ── GST (order-level) ───────────────────────────────────────────────────────
// Mirrors templates/tax-invoice.liquid: flat 3% on a tax-inclusive total (taxable = total/1.03),
// intra-state → CGST+SGST 1.5% each, inter-state → IGST 3%. Duplicated (not imported from reports.js)
// to avoid a circular require, since reports.js requires this module.

function supplierState(stateCode) { return String(stateCode || '').split('-')[0].trim().toUpperCase() || 'KA'; }
function gstSplit(taxable, supplier, dest) {
  const sup = supplierState(supplier);
  const d   = String(dest || '').trim().toUpperCase() || sup;
  const t   = Math.round(taxable * 100) / 100;
  return d === sup
    ? { igst: 0,         cgst: +(t * 0.015).toFixed(2), sgst: +(t * 0.015).toFixed(2) }
    : { igst: +(t * 0.03).toFixed(2), cgst: 0,          sgst: 0 };
}

// ── Row builder ───────────────────────────────────────────────────────────────

function buildRow(txn, mr) {
  const m = mr.match;
  const amount = txn.amount;
  // GST on the matched order total. ShippingState/CustomSerial are enriched later (a Shopify lookup
  // for matched refs); the split defaults to intra-state (KA) until the shipping state is known.
  const orderTotal = m ? m.total : 0;
  const taxable = orderTotal > 0 ? Math.round((orderTotal / 1.03) * 100) / 100 : 0;
  const gst = gstSplit(taxable, m && m.state, '');
  return {
    _vpa:    txn.vpa || txn.name || '',
    _date:   txn.date,
    _amount: amount,
    _entity: m,
    Source:         txn.source,
    TxnDate:        fmtDate(txn.date),
    SettlementDate: fmtDate(txn.settlDate),
    TxnID:          txn.txnId || txn.paymentId || '',
    PaymentMode:    txn.paymentMode || '',
    Cardholder:     txn.name || txn.vpa || '',
    CardLast4:      txn.cardLast4 || '',
    GrossAmount:    amount.toFixed(2),
    Fee:            (txn.fee || 0).toFixed(2),
    NetPaid:        (txn.netPaid > 0 ? txn.netPaid : amount).toFixed(2),
    SettlementUTR:  txn.utr || '',
    OrderRef:       m ? m.ref : (mr.method === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'UNLINKED'),
    OrderTotal:     m ? m.total.toFixed(2) : '',
    TaxableValue:   m ? taxable.toFixed(2) : '',
    IGST:           m ? gst.igst.toFixed(2) : '',
    SGST:           m ? gst.sgst.toFixed(2) : '',
    CGST:           m ? gst.cgst.toFixed(2) : '',
    ShippingState:  '',
    CustomSerial:   '',
    Customer:       m ? m.customer : '',
    EntityType:     m ? m.type : '',
    MatchMethod:    mr.method,
    Confidence:     mr.confidence,
    Role:           determineRole(amount, m),
    Notes:          mr.notes || '',
  };
}

// ── Shopify enrichment: shipping province + serial code for matched order refs ──
// Bounded to the DISTINCT matched order names (low volume). Drafts (#D…) are skipped — their serial
// isn't minted until completion. Failures degrade gracefully (columns stay blank).
async function enrichOrderMeta(refs, storeUrl, token) {
  const map = {};
  const orderRefs = [...new Set(refs.filter(r => /^#\d+$/.test(r)))];
  for (const ref of orderRefs) {
    try {
      const query = `query($q:String!){ orders(first:1, query:$q){ edges{ node{ shippingAddress{provinceCode} serial: metafield(namespace:"custom", key:"serial_code"){value} } } } }`;
      const resp = await fetch(`${storeUrl}/admin/api/2024-01/graphql.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { q: `name:${ref}` } }),
      });
      if (!resp.ok) continue;
      const j = await resp.json();
      const node = j?.data?.orders?.edges?.[0]?.node;
      if (node) map[ref] = { shippingState: node.shippingAddress?.provinceCode || '', serial: node.serial?.value || '' };
    } catch (_) { /* leave blank */ }
  }
  return map;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runRecon({ dir, storeUrl, token }) {
  // ── Load Pine Labs ──
  const pineTxns = loadPineTxns(dir);
  const mprById  = loadMPR(dir);
  for (const t of pineTxns) {
    const m = mprById[t.txnId];
    if (m) { t.fee = m.fee; t.netPaid = m.netPaid; t.settlDate = m.settlDate; t.utr = m.utr; }
  }

  // Union in settlement-only Pine transactions: a SALE that settled (present in
  // the MPR) but is missing from the "All transactions" export is still real,
  // collected money — reconstruct it from the MPR so recon never drops it.
  const pineIds = new Set(pineTxns.map(t => t.txnId));
  for (const [tid, m] of Object.entries(mprById)) {
    if (pineIds.has(tid)) continue;
    const amount = m.gross || (m.netPaid + m.fee);
    if (isTest(amount)) continue;
    pineTxns.push({
      source:      'Pine Labs',
      txnId:       tid,
      date:        m.txnDate,
      settlDate:   m.settlDate,
      amount,
      fee:         m.fee,
      netPaid:     m.netPaid,
      utr:         m.utr,
      paymentMode: (m.instrument || 'CARD').toUpperCase(),
      name:        '',
      vpa:         m.vpa || '',
      cardLast4:   m.cardLast4 || '',
      billInvoice: '',
    });
  }

  // ── Load GoKwik ──
  const gkTxns    = loadGKTxns(dir);
  const gkSettle  = loadGKSettlement(dir);
  for (const t of gkTxns) {
    const s = gkSettle[t.paymentId];
    if (s) { t.fee = s.fee; t.netPaid = s.netPaid; t.settlDate = s.settlDate; t.utr = s.utr; if (s.platformOrderId) t.platformOrderId = s.platformOrderId; }
  }

  // ── Load Shopify ──
  const shopOrders = loadShopifyOrders(dir);
  const shopDrafts = loadShopifyDrafts(dir);
  const allEntities = [...shopOrders, ...shopDrafts];
  const entityByRef = Object.fromEntries(allEntities.map(e => [e.ref, e]));

  // ── Resolve draft→order via Shopify API ──
  const draftRefs = [...new Set([
    ...pineTxns.filter(t => t.billInvoice.startsWith('#D')).map(t => t.billInvoice),
    ...gkTxns.map(t => t.platformOrderId || t.platformOrderNum).filter(r => r.startsWith('#D')),
  ])];
  const draftToOrder = await buildDraftToOrderMap(draftRefs, storeUrl, token);

  // Register resolved order entities that aren't already in our data
  for (const [draftName, orderName] of Object.entries(draftToOrder)) {
    if (!entityByRef[orderName]) {
      const src = entityByRef[draftName];
      if (src) {
        const clone = { ...src, ref: orderName, type: 'order(from draft)' };
        entityByRef[orderName] = clone;
        allEntities.push(clone);
      }
    }
  }

  // ── First pass: match each transaction ──
  const rows = [];

  const resolveRef = ref => draftToOrder[ref] || ref;

  const matchPine = t => {
    if (t.billInvoice) {
      const resolved = resolveRef(t.billInvoice);
      const entity = entityByRef[resolved] || entityByRef[t.billInvoice];
      if (entity) return { method: 'BILL_INVOICE', match: entity, confidence: 'HIGH', notes: '' };
      // Draft not resolved via API — fall back to amount+date
      const fb = matchByAmountDate(t, allEntities);
      if (fb.match) { fb.notes = `${t.billInvoice} via amount-date (draft ref unresolved)`; return fb; }
      return { method: 'BILL_INVOICE', match: null, confidence: 'LOW', notes: `${t.billInvoice} not in report data` };
    }
    return matchByAmountDate(t, allEntities);
  };

  const matchGK = t => {
    const ref = t.platformOrderId || t.platformOrderNum;
    if (ref.startsWith('#D')) {
      const resolved = resolveRef(ref);
      const entity = entityByRef[resolved] || entityByRef[ref];
      if (entity) return { method: 'DRAFT_REF', match: entity, confidence: 'HIGH', notes: '' };
      // Fall back to amount+date
      const fb = matchByAmountDate(t, allEntities);
      if (fb.match) { fb.notes = `${ref} via amount-date (draft ref unresolved)`; return fb; }
      return { method: 'DRAFT_REF', match: null, confidence: 'LOW', notes: `${ref} not in report data` };
    }
    if (ref.startsWith('#')) {
      const entity = entityByRef[ref];
      return entity
        ? { method: 'ORDER_REF', match: entity, confidence: 'HIGH', notes: '' }
        : { method: 'ORDER_REF', match: null, confidence: 'LOW', notes: `${ref} not in provided Shopify report` };
    }
    return matchByAmountDate(t, allEntities);
  };

  for (const t of pineTxns) rows.push(buildRow(t, matchPine(t)));
  for (const t of gkTxns)   rows.push(buildRow(t, matchGK(t)));

  // ── Second pass: VPA cross-reference for remaining UNLINKED ──
  // If an unlinked txn shares a VPA/name with an already-matched txn → borrow that match
  for (const row of rows) {
    if (row.OrderRef !== 'UNLINKED' && row.OrderRef !== 'AMBIGUOUS') continue;
    const vpa = (row._vpa || '').toLowerCase();
    if (!vpa || vpa === 'null' || /^\*+\d{4}$/.test(vpa)) continue; // skip masked card numbers
    for (const other of rows) {
      if (other === row || !other._entity) continue;
      if ((other._vpa || '').toLowerCase() === vpa) {
        const m = other._entity;
        row._entity       = m;
        row.OrderRef      = m.ref;
        row.OrderTotal    = m.total.toFixed(2);
        row.Customer      = m.customer;
        row.EntityType    = m.type;
        row.MatchMethod   = 'VPA_CROSS_REF';
        row.Confidence    = 'MEDIUM';
        row.Role          = determineRole(parseFloat(row.GrossAmount), m);
        row.Notes         = 'Matched via shared VPA/UPI ID';
        break;
      }
    }
  }

  // ── Third pass: payer-agnostic split-payment combinations ──
  // Orders are often paid in installments across different cards / UPI IDs / dates
  // (a deposit at draft time + the balance on delivery, weeks apart). Test whether
  // any SUBSET of the still-unlinked legs SUMS to an order/draft total, with every
  // leg within a window of the order date. Payer identity is NOT required.
  // Uniqueness-guarded (the sum must match exactly one entity) and capped for cost;
  // LOW confidence, since amounts — not identity — drive the link.
  const SPLIT_WINDOW_DAYS = 35; // allows deposits made weeks before the order is finalised
  const MAX_LEGS = 3;
  const isUnlinked = row => row.OrderRef === 'UNLINKED' || row.OrderRef === 'AMBIGUOUS';
  const comboSum   = combo => combo.reduce((s, l) => s + parseFloat(l.GrossAmount), 0);
  const combinations = (arr, k) => {
    const res = [];
    const rec = (start, cur) => {
      if (cur.length === k) { res.push(cur.slice()); return; }
      for (let i = start; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); }
    };
    rec(0, []);
    return res;
  };

  const entitiesByDate = [...allEntities].sort((a, b) =>
    fmtDate(a.date).localeCompare(fmtDate(b.date)) || a.ref.localeCompare(b.ref));
  for (const e of entitiesByDate) {
    const pool = rows.filter(r => isUnlinked(r) && r._date && daysDiff(r._date, e.date) <= SPLIT_WINDOW_DAYS);
    if (pool.length < 2) continue;
    let combo = null;
    for (let size = 2; size <= Math.min(pool.length, MAX_LEGS) && !combo; size++) {
      for (const c of combinations(pool, size)) {
        const s = comboSum(c);
        // uniqueness: this sum must reconcile to exactly one entity, else skip
        if (Math.abs(s - e.total) <= 1.5 && allEntities.filter(x => Math.abs(x.total - s) <= 1.5).length === 1) {
          combo = c; break;
        }
      }
    }
    if (!combo) continue;
    const total = comboSum(combo);
    let span = 0;
    for (const a of combo) for (const b of combo) span = Math.max(span, daysDiff(a._date, b._date));
    const taxable = e.total > 0 ? Math.round((e.total / 1.03) * 100) / 100 : 0;
    const gst = gstSplit(taxable, e.state, '');
    combo.forEach((l, i) => {
      l._entity      = e;
      l.OrderRef     = e.ref;
      l.OrderTotal   = e.total.toFixed(2);
      l.TaxableValue = taxable.toFixed(2);
      l.IGST         = gst.igst.toFixed(2);
      l.SGST         = gst.sgst.toFixed(2);
      l.CGST         = gst.cgst.toFixed(2);
      l.Customer     = e.customer;
      l.EntityType   = e.type;
      l.MatchMethod  = 'SPLIT_PAYMENT';
      l.Confidence   = 'LOW';
      l.Role         = 'split_payment';
      l.Notes        = `Leg ${i + 1}/${combo.length} of split (sum Rs${total.toFixed(2)} = ${e.ref}, legs span ${span.toFixed(0)}d)`;
    });
  }

  // ── Enrich matched orders with shipping state + serial, then refine the GST split ──
  const meta = await enrichOrderMeta(rows.map(r => r.OrderRef), storeUrl, token);
  for (const row of rows) {
    const e = meta[row.OrderRef];
    if (!e) continue;
    row.ShippingState = e.shippingState || '';
    row.CustomSerial  = e.serial || '';
    if (row.OrderTotal && e.shippingState) {
      const taxable = parseFloat(row.TaxableValue) || 0;
      const gst = gstSplit(taxable, row._entity && row._entity.state, e.shippingState);
      row.IGST = gst.igst.toFixed(2); row.SGST = gst.sgst.toFixed(2); row.CGST = gst.cgst.toFixed(2);
    }
  }

  // Strip internal fields
  return rows.map(({ _vpa, _entity, _date, _amount, ...clean }) => clean);
}

// ── CSV serialiser ────────────────────────────────────────────────────────────

function toCSV(rows) {
  if (!rows.length) return 'No data';
  const hdrs = Object.keys(rows[0]);
  const esc  = v => { const s = String(v ?? ''); return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g,'""')}"` : s; };
  return [hdrs.join(','), ...rows.map(r => hdrs.map(h => esc(r[h])).join(','))].join('\n');
}

module.exports = { runRecon, toCSV };
