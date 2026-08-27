'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Reporting service — the single module that owns every report builder.
//
//   • buildSalesReport   — stitched, line-item SALES view (open/partial drafts + completed orders)
//   • buildSerialCounters — counter/summary view: minted serials per use case + current counter
//   • runRecon / toCSV   — payment reconciliation (re-exported from ./recon)
//
// The server passes a `deps` bag ({ axios, storeUrl, token, supabase, serialization }) so this
// module carries no env wiring of its own. GST/HSN/serial derivations mirror templates/tax-invoice.liquid
// so the reports tie out to the printed invoices.
// ─────────────────────────────────────────────────────────────────────────────

const { runRecon, toCSV: reconToCSV } = require('./recon');
const { readInstallments, installmentModes } = require('../payments/installments');

// ── Small helpers ────────────────────────────────────────────────────────────

const num  = (v) => (parseFloat(v) || 0);
const r2   = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;
const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN') : '');

// Bare supplier/place-of-supply state from the compound store code: "KA-HSR" → "KA".
// GST + state normalisation come from src/core/tax.js, shared with recon.js so both reports
// can never disagree on tax again. Rates: flat 3%, intra-state CGST+SGST 1.5% each.
const { gstSplit, supplierState, normState } = require('../../core/tax');

// Read a numeric line-item property from a {name/key,value} array (strips the "Rs" prefix).
function lineProp(attrs, name) {
  const p = (attrs || []).find(a => (a.name || a.key) === name);
  if (!p) return null;
  const v = parseFloat(String(p.value || '').replace(/Rs/i, '').replace(/,/g, '').trim());
  return Number.isFinite(v) ? v : null;
}

const HSN_DEFAULT = '71131914'; // matches the invoice fallback when product.custom.hsn_code is blank

// Given a line's Gross Value / Discount / Taxable props (+ fallbacks), return the money + GST block.
function lineMoney({ grossValue, discount, taxableProp, storeState, shipState }) {
  const gross   = r2(grossValue);
  const disc    = r2(discount);
  const netIncl = r2(gross - disc);                 // tax-inclusive, post-discount
  const taxable = taxableProp != null ? r2(taxableProp) : r2(netIncl / 1.03);
  const gst     = gstSplit(taxable, storeState, shipState);
  return {
    gross_sales: gross, discount: disc, net_sales: netIncl, taxable_value: taxable,
    igst: gst.igst, sgst: gst.sgst, cgst: gst.cgst,
  };
}

// ── Draft → order lineage ────────────────────────────────────────────────────
// Shopify completes a draft in place (PUT .../complete.json): the draft flips to
// status=completed and carries `order_id`, but NOTHING is written back onto the
// order identifying the draft it came from. So an order row can only name its
// originating draft by walking the completed drafts and indexing them by order_id.
// Keyed by the numeric order id, which is what `draft_order.order_id` holds.

async function buildOrderToDraftMap(deps) {
  const { axios, storeUrl, token } = deps;
  const map = {};
  if (!storeUrl || !token) return map;
  let pageUrl = `${storeUrl}/admin/api/2024-01/draft_orders.json?status=completed&limit=250`;
  let page = 0;
  while (pageUrl && page++ < 50) {
    let resp;
    try {
      resp = await axios.get(pageUrl, { headers: { 'X-Shopify-Access-Token': token }, timeout: 30000 });
    } catch (_) { break; }   // lineage is enrichment — never fail the whole report over it
    for (const d of (resp.data.draft_orders || [])) {
      if (d.order_id) map[String(d.order_id)] = d.name || '';
    }
    const link = resp.headers['link'] || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    pageUrl = next ? next[1] : null;
  }
  return map;
}

// ── Sales report — orders side (GraphQL) ─────────────────────────────────────

async function collectOrders(deps, { from, to }, rows, draftByOrderId = {}) {
  const { axios, storeUrl, token } = deps;
  const search = `created_at:>=${from} created_at:<=${to}`;
  let cursor = null, page = 0;
  do {
    const query = `query($q:String!,$after:String){ orders(first:50, query:$q, after:$after, sortKey:CREATED_AT){
      pageInfo{ hasNextPage endCursor }
      edges{ node{
        id name createdAt customer{ displayName }
        shippingAddress{ provinceCode province }
        totalPriceSet{ shopMoney{ amount } }
        metafields(namespace:"custom", first:40){ edges{ node{ key value } } }
        lineItems(first:50){ edges{ node{
          title variantTitle quantity sku
          originalTotalSet{ shopMoney{ amount } }
          discountedTotalSet{ shopMoney{ amount } }
          product{ hsn: metafield(namespace:"custom", key:"hsn_code"){ value } }
          customAttributes{ key value }
        } } }
      } }
    } }`;
    const { data } = await axios.post(
      `${storeUrl}/admin/api/2024-01/graphql.json`,
      { query, variables: { q: search, after: cursor } },
      { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    const conn = data && data.data && data.data.orders;
    if (!conn) throw new Error('Shopify GraphQL error' + (data && data.errors ? `: ${JSON.stringify(data.errors)}` : ''));

    for (const e of conn.edges) {
      const n = e.node;
      const mf = {};
      for (const me of n.metafields.edges) mf[me.node.key] = me.node.value;

      const storeState = mf.state_code || '';                 // place of supply (e.g. KA-HSR)
      const shipState  = n.shippingAddress?.provinceCode || '';
      // Collections come from the installment legs. amount_paid is the middleware's running sum of
      // them and stays authoritative (it also covers orders predating the migration, which have no
      // legs). cad_advance legs are INCLUDED in that sum: a design advance is money settled against
      // this order. It is not also deducted from amount_to_be_collected unless the CAD Advance line
      // item is on the document, in which case the deduction is cancelling that line's own charge.
      const legs    = readInstallments(mf);
      const paid    = num(mf.amount_paid);
      const net     = mf.amount_to_be_collected != null ? num(mf.amount_to_be_collected)
                                                        : num(n.totalPriceSet?.shopMoney?.amount);
      const pending = Math.max(0, r2(net - paid));
      const isFull  = mf.is_finalized === 'true' || String(mf.payment_status || '').toLowerCase() === 'full' || (paid > 0 && pending < 1);
      const stage   = isFull ? 'completed-paid' : (paid > 0 ? 'partial' : 'unpaid');
      const pmode   = legs.length ? installmentModes(legs).join(' / ')
                                  : [mf.payment_mode_advance, mf.payment_mode_final].filter(Boolean).join(' / ');
      // How the money arrived: one payment or several. Counted off the legs rather than inferred
      // from which of two named mode fields happened to be set.
      const legCount = legs.length || (mf.payment_mode_advance && mf.payment_mode_final ? 2 : (paid > 0 ? 1 : 0));
      const paymentType = isFull ? (legCount > 1 ? `full: ${legCount} installments` : 'full: one-time')
                                 : (paid > 0 ? `partial${legCount > 1 ? `: ${legCount} installments` : ''}` : 'unpaid');
      // the draft this order was converted from, if it started life as one
      const orderLegacyId = String(n.id || '').split('/').pop();
      const originDraft = draftByOrderId[orderLegacyId] || '';

      const lines = n.lineItems.edges.map(le => le.node);
      lines.forEach((li, idx) => {
        const attrs = li.customAttributes || [];
        const gv = lineProp(attrs, 'Gross Value');
        const money = lineMoney({
          grossValue: gv != null ? gv : num(li.originalTotalSet?.shopMoney?.amount),
          discount:   lineProp(attrs, 'Discount Applied') || 0,
          taxableProp: lineProp(attrs, 'Taxable Value'),
          storeState, shipState,
        });
        rows.push({
          stage,
          payment_type:  paymentType,
          draft_name:   originDraft,
          order_name:   n.name || '',
          day:          fmtDay(n.createdAt),
          customer:     (n.customer && n.customer.displayName) || '',
          place_of_supply: supplierState(storeState),
          shipping_state:  shipState,
          product_title:   li.title || '',
          variant_title:   li.variantTitle || '',
          sku:             li.sku || '',
          hsn:             (li.product && li.product.hsn && li.product.hsn.value) || HSN_DEFAULT,
          qty:             li.quantity || 0,
          ...money,
          custom_serial:   mf.serial_code || '',
          // order-level money on the FIRST line only, so summing a column never double-counts a doc
          amount_paid:     idx === 0 ? r2(paid) : '',
          amount_pending:  idx === 0 ? pending  : '',
          net_to_collect:  idx === 0 ? r2(net)  : '',
          payment_mode:    idx === 0 ? pmode    : '',
          installments:    idx === 0 ? legCount : '',
        });
      });
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor && ++page < 50);
}

// ── Sales report — drafts side (REST: open + invoice_sent) ───────────────────
// Completed drafts are excluded by Shopify (they've become orders, picked up by collectOrders), so a
// sale appears exactly once. Draft line HSN/serial/state_code metafields aren't inline on the list
// endpoint, so HSN falls back to the default and place-of-supply approximates from shipping; the
// completed-order row carries the authoritative GST/serial figures.
//
// DATE FILTERING IS DONE CLIENT-SIDE, DELIBERATELY. The REST draft_orders endpoint does not support
// created_at_min/created_at_max — it accepts updated_at_* and since_id only — and Shopify silently
// IGNORES unsupported query params rather than erroring. Passing them looked like it worked while
// actually returning every open/invoice_sent draft ever created, so each month's report re-counted
// the same drafts (a July run carried #D115 from May and #D194 from August, and June's run carried
// the identical draft list). Filter on d.created_at here instead, and never trust the endpoint to
// have narrowed anything.

async function collectDrafts(deps, { from, to }, rows) {
  const { axios, storeUrl, token } = deps;
  const hdrs = { 'X-Shopify-Access-Token': token };
  const fromT = from ? new Date(from + 'T00:00:00Z').getTime() : null;
  const toT   = to   ? new Date(to   + 'T23:59:59.999Z').getTime() : null;
  const inWindow = (iso) => {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return false;
    return (fromT == null || t >= fromT) && (toT == null || t <= toT);
  };
  const seen = new Set();

  for (const status of ['open', 'invoice_sent']) {
    const qp = new URLSearchParams({ limit: '250', status });
    let pageUrl = `${storeUrl}/admin/api/2024-01/draft_orders.json?${qp}`;
    while (pageUrl) {
      const { data, headers } = await axios.get(pageUrl, { headers: hdrs, timeout: 30000 });
      for (const d of (data.draft_orders || [])) {
        // A converted draft is represented by its order row (collectOrders) — never both.
        // Shopify's status filter should already exclude these; this is the belt-and-braces
        // dedupe the sales report is specified to do.
        if (d.order_id) continue;
        // a draft can surface under more than one status pass
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        if (!inWindow(d.created_at)) continue;
        const tags = (d.tags || '').split(',').map(t => t.trim()).filter(Boolean);
        const tag  = (prefix) => { const t = tags.find(x => x.startsWith(prefix)); return t ? t.slice(prefix.length) : ''; };
        const deposit = tag('deposit:');
        const paid    = num((tag('paid:') || '').replace(/Rs/i, ''));
        const pending = num((tag('pending:') || '').replace(/Rs/i, ''));
        const total   = num((tag('total:') || '').replace(/Rs/i, '')) || r2(paid + pending);
        // Sales report only counts drafts with a RECORDED payment (an advance/partial or a full
        // pre-payment) — plain open/unpaid drafts are not sales yet, so skip them.
        if (!(paid > 0 || deposit === 'partial' || deposit === 'fully-paid')) continue;
        const stage   = deposit === 'fully-paid' ? 'draft-paid' : (paid > 0 ? 'partial' : 'open-draft');
        const paymentType = deposit === 'fully-paid' ? 'full: paid-in-advance' : 'partial';
        // Modes come off tags on the draft side (no metafield fetch here). `pmodes:` is the
        // aggregate covering every leg; the two-slot tags are the pre-migration fallback.
        const pmodesTag = tag('pmodes:');
        const pmode   = pmodesTag ? pmodesTag.split('/').filter(Boolean).join(' / ')
                                  : [tag('pmode-advance:'), tag('pmode-final:')].filter(Boolean).join(' / ');
        // The draft side reads tags only, and `pmodes:` carries DISTINCT modes — two cash legs look
        // like one. Leaving the count blank rather than printing an undercount; the converted-order
        // row carries the real figure.
        const legCount = '';

        const shipState  = d.shipping_address?.province_code || '';
        // Draft has no custom.state_code inline. Mirror the invoice's supplier default (KA) so the
        // intra/inter split against the shipping state stays meaningful; the completed-order row
        // carries the authoritative place-of-supply.
        const storeState = 'KA';
        const customer   = d.customer
          ? `${d.customer.first_name || ''} ${d.customer.last_name || ''}`.trim()
          : (d.billing_address?.name || '');

        const productItems = (d.line_items || []).filter(
          item => !((item.title || '').toLowerCase().includes('discount') && parseFloat(item.price) < 0)
        );
        productItems.forEach((item, idx) => {
          const attrs = item.properties || [];
          const gv = lineProp(attrs, 'Gross Value');
          const money = lineMoney({
            grossValue: gv != null ? gv : (parseFloat(item.price) * item.quantity),
            discount:   lineProp(attrs, 'Discount Applied') || 0,
            taxableProp: lineProp(attrs, 'Taxable Value'),
            storeState, shipState,
          });
          rows.push({
            stage,
            payment_type: paymentType,
            draft_name:  d.name || '',
            order_name:  '',
            day:         fmtDay(d.created_at),
            customer,
            place_of_supply: supplierState(storeState),
            shipping_state:  shipState,
            product_title:   item.title || '',
            variant_title:   item.variant_title || '',
            sku:             item.sku || '',
            hsn:             HSN_DEFAULT,
            qty:             item.quantity || 0,
            ...money,
            custom_serial:   '',
            amount_paid:     idx === 0 ? r2(paid)    : '',
            amount_pending:  idx === 0 ? r2(pending) : '',
            net_to_collect:  idx === 0 ? r2(total)   : '',
            payment_mode:    idx === 0 ? pmode       : '',
            installments:    idx === 0 ? legCount    : '',
          });
        });
      }
      const link = headers['link'] || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      pageUrl = next ? next[1] : null;
    }
  }
}

const SALES_COLS = [
  'stage', 'payment_type', 'draft_name', 'order_name', 'day', 'customer', 'place_of_supply', 'shipping_state',
  'product_title', 'variant_title', 'sku', 'hsn', 'qty',
  'gross_sales', 'discount', 'net_sales', 'taxable_value', 'igst', 'sgst', 'cgst',
  'custom_serial', 'amount_paid', 'amount_pending', 'net_to_collect', 'payment_mode', 'installments',
];

async function buildSalesReport(deps, { from, to, state, paymentStatus } = {}) {
  const rows = [];
  const draftByOrderId = await buildOrderToDraftMap(deps);
  await collectOrders(deps, { from, to }, rows, draftByOrderId);
  await collectDrafts(deps, { from, to }, rows);
  let out = rows;
  if (state)         out = out.filter(r => r.place_of_supply === normState(state));
  if (paymentStatus) out = out.filter(r => r.stage === String(paymentStatus).toLowerCase());
  return out;
}

// ── Serial counter report ────────────────────────────────────────────────────
// Summary over the already-built counter system: one row per counter (doc_type × store × FY) with
// the CURRENT counter value (next = current + 1) and minted/cancelled counts from serial_ledger.
// serial_counters.state_code holds the FY-folded key for per-FY doc types ("27|KA-HSR").

// Nicer display labels; falls back to Title Case of the doc_type when unmapped.
const USE_CASE_LABELS = {
  customer_order: 'Customer Order (B2C)', customer_service: 'Service Order (paid)',
  free_service: 'Service Order (free)', b2b: 'B2B / Transfer Invoice',
  delivery_challan: 'Delivery Challan', memo_custom: 'Custom Memo', po: 'Purchase Order',
  voucher: 'Voucher', exchange_note: 'Exchange Note', credit_note: 'Credit Note', repair: 'Repair',
};
const titleCase = (s) => String(s || '').split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// Build the printed serial prefix from a registry entry, e.g. TM{FY}-{CODE}-{SEQ} → "TM27-KAHSR-".
function codePrefix(reg, fy, storeCode) {
  if (!reg || !reg.code) return '';
  const codeTok = storeCode === 'ALL' ? '' : String(storeCode || '').replace(/-/g, '');
  return String(reg.code)
    .replace('{FY}', fy || '')
    .replace('{CODE}', codeTok)
    .replace('{STATE}', codeTok)
    .replace('{SEQ}', '')
    .replace(/-+$/, '-');
}

async function buildSerialCounters(deps, { state, docType } = {}) {
  const { supabase, serialization } = deps;
  const registry = serialization && serialization.getRegistry ? await serialization.getRegistry(deps) : {};

  const { data: counters, error } = await supabase.from('serial_counters').select('*');
  if (error) throw new Error(error.message);

  // One aggregate pass over the ledger, keyed by the same (doc_type, store_code) the counter uses.
  const { data: ledger, error: lErr } = await supabase
    .from('serial_ledger').select('doc_type, store_code, status, created_at').limit(100000);
  if (lErr) throw new Error(lErr.message);
  const agg = {};
  for (const l of (ledger || [])) {
    const k = `${l.doc_type}|${l.store_code}`;
    const g = agg[k] || (agg[k] = { minted: 0, cancelled: 0, last: '' });
    g.minted++;
    if (l.status === 'cancelled') g.cancelled++;
    if (!g.last || String(l.created_at) > g.last) g.last = String(l.created_at);
  }

  let rows = (counters || []).map(c => {
    const key = String(c.state_code || '');                    // FY-folded counter key
    const hasFy = key.includes('|');
    const fy    = hasFy ? key.split('|')[0] : '';
    const store = hasFy ? key.split('|').slice(1).join('|') : key;
    const reg   = registry[c.doc_type];
    const g     = agg[`${c.doc_type}|${key}`] || { minted: 0, cancelled: 0, last: '' };
    return {
      use_case:       USE_CASE_LABELS[c.doc_type] || titleCase(c.doc_type),
      doc_type:       c.doc_type,
      store_code:     store,
      fy:             fy,
      code_prefix:    codePrefix(reg, fy, store),
      current_value:  c.current_value,
      next_value:     Number(c.current_value) + 1,
      minted_count:   g.minted,
      cancelled_count: g.cancelled,
      last_minted_at: g.last ? fmtDay(g.last) : '',
    };
  });

  if (docType) rows = rows.filter(r => r.doc_type === String(docType).toLowerCase());
  if (state)   rows = rows.filter(r => normState(r.store_code) === normState(state) || supplierState(r.store_code) === normState(state));
  rows.sort((a, b) => (a.doc_type + a.store_code + a.fy).localeCompare(b.doc_type + b.store_code + b.fy));
  return rows;
}

// ── CSV ──────────────────────────────────────────────────────────────────────

function toCSV(rows, cols) {
  const columns = cols || (rows.length ? Object.keys(rows[0]) : []);
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [columns.join(',')]
    .concat(rows.map(r => columns.map(c => esc(r[c])).join(',')))
    .join('\r\n');
}

module.exports = {
  buildSalesReport,
  buildSerialCounters,
  SALES_COLS,
  toCSV,
  gstSplit,
  supplierState,
  // re-exported so the reporting module is the single entry point for every report
  runRecon,
  reconToCSV,
};
