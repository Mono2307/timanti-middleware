'use strict';

/**
 * Reporting — every read-only view over the business.
 *
 * ENTRY POINT
 *   register(app, ctx)  mounts the six report endpoints below.
 *
 * ENDPOINTS
 *   GET  /api/recon             reconcile the CSVs baked into src/data/recon against Shopify
 *   POST /api/recon             same matcher, but over uploaded exports (no redeploy needed)
 *   GET  /api/sales-report      stitched line-item view across open drafts and completed orders
 *   GET  /api/serial-counters   current serial position per document type
 *   GET  /api/recon-ledger      credit-instrument ledger: issued / applied / redeemed / void
 *   GET  /api/adjustment-report vouchers, exchange notes and advances by issuance and redemption
 *
 * EXIT POINTS — what this module calls outward
 *   modules/reporting/reports.js   the builders (runRecon, buildSalesReport, …)
 *   modules/adjustments/…          credit-instrument ledger reads
 *   modules/serialization          counter reads
 *   core/shopify                   token + REST
 *   core/supabase                  ledger tables
 *
 * This module is READ-ONLY by design: it must never write to Shopify or Supabase. Reports are
 * run ad hoc by staff against live data, so a write here would be an unreviewed mutation.
 */

const express = require('express');
const path    = require('path');
const axios   = require('axios');

const { config }   = require('../../core/config');
const { supabase } = require('../../core/supabase');
const { getShopifyToken } = require('../../core/shopify');
const { log } = require('../../core/logger');

const serialization     = require('../serialization');
const creditInstruments = require('../adjustments/credit_instruments');

// Report builders — the single entry point for every report (sales, counters, recon).
const reports = require('./reports');
const { runRecon, toCSV: reconToCSV } = reports;

function register(app, ctx) {

app.get('/api/recon', async (req, res) => {
  try {
    const reconDir = path.join(__dirname, 'src', 'data', 'recon');
    const token    = await getShopifyToken();
    const rows     = await runRecon({ dir: reconDir, storeUrl: process.env.SHOPIFY_STORE_URL, token });
    if ((req.query.format || '').toLowerCase() === 'json') {
      return res.json({ success: true, count: rows.length, rows });
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="recon-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(reconToCSV(rows));
  } catch (err) {
    console.error('Recon error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/recon   body: { files: [{ name, contentBase64 }, ...], format?: 'json'|'csv' }
// Reconcile against UPLOADED exports instead of the CSVs baked into the image. GET /api/recon
// reads /app/src/data/recon, which only changes when the image is rebuilt — so refreshing the
// monthly dumps used to mean a commit and a deploy. Posting the files runs the identical
// matcher over them, so dropping new exports somewhere and posting them is enough.
// Same file-name conventions as the folder ("All transactions", "MPR", "transaction-report",
// "settlement_v2", "Accounts", "draft-orders-report"); several months can be sent at once.
app.post('/api/recon', express.json({ limit: '25mb' }), async (req, res) => {
  try {
    const files = (req.body && req.body.files) || [];
    if (!Array.isArray(files) || !files.length) {
      return res.status(400).json({ success: false, error: 'body.files must be a non-empty array of { name, contentBase64 }' });
    }
    const bad = files.find(f => !f || !f.name || !(f.contentBase64 || f.content));
    if (bad) return res.status(400).json({ success: false, error: 'each file needs { name, contentBase64 }' });

    const token = await getShopifyToken();
    const rows  = await runRecon({ files, storeUrl: process.env.SHOPIFY_STORE_URL, token });
    if ((req.body.format || 'json').toLowerCase() === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="recon-${new Date().toISOString().slice(0,10)}.csv"`);
      return res.send(reconToCSV(rows));
    }
    return res.json({ success: true, count: rows.length, filesReceived: files.map(f => f.name), rows });
  } catch (err) {
    console.error('Recon (upload) error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/sales-report?from=YYYY-MM-DD&to=YYYY-MM-DD&state=&paymentStatus=&format=json|csv
// The stitched SALES view: one row per line item across open/partial DRAFTS and completed ORDERS,
// deduped so a partial-paid draft and the order it becomes never both appear. Carries the GST/HSN/
// serial/shipping columns that tie back to the tax invoice. Order-level money (paid/pending/net) sits
// on the first line of each doc only, so summing a column never double-counts.
app.get('/api/sales-report', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ success: false, error: 'from and to (YYYY-MM-DD) are required' });
  try {
    const deps = { axios, storeUrl: process.env.SHOPIFY_STORE_URL, token: await getShopifyToken(), supabase, serialization };
    const rows = await reports.buildSalesReport(deps, {
      from, to, state: req.query.state, paymentStatus: req.query.paymentStatus,
    });
    if ((req.query.format || 'json').toLowerCase() === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="sales-report-${from}_${to}.csv"`);
      return res.send(reports.toCSV(rows, reports.SALES_COLS));
    }
    return res.json({ success: true, count: rows.length, rows });
  } catch (err) {
    console.error('sales-report error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/serial-counters?state=&docType=&format=json|csv
// Counter/summary report: one row per counter (doc_type × store × FY) with the CURRENT counter value
// (next = current + 1) plus minted/cancelled counts from the ledger — so staff see what number each
// use case is on. Distinct from /api/serial-report (the per-serial list). Pure Supabase read.
app.get('/api/serial-counters', async (req, res) => {
  try {
    const rows = await reports.buildSerialCounters({ supabase, serialization }, {
      state: req.query.state, docType: req.query.docType,
    });
    if ((req.query.format || 'json').toLowerCase() === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="serial-counters-${new Date().toISOString().slice(0,10)}.csv"`);
      return res.send(reports.toCSV(rows));
    }
    return res.json({ success: true, count: rows.length, rows });
  } catch (err) {
    console.error('serial-counters error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/recon-ledger', async (req, res) => {
  try {
    const view = (req.query.view || 'summary').toLowerCase();
    const rows = await creditInstruments.fetchAll(supabase, {
      from: req.query.from, to: req.query.to, instrumentType: req.query.type,
    });
    const now = Date.now();
    let out = [];

    if (view === 'detail' || view === 'all') {
      // One row per instrument, every state, with both order references — the full breakup.
      out = rows.map(r => {
        const st = creditInstruments.effectiveStatus(r, now);
        return {
          instrument_type:  r.instrument_type,
          serial_code:      r.serial_code,
          state:            st === 'open' ? 'outstanding' : st,   // outstanding|redeemed|voided|expired
          value:            parseFloat(r.value).toFixed(2),
          customer_name:    r.customer_name || '',
          issued_against:   r.source_order_name || '',            // order it was generated on
          applied_to_draft: r.target_draft_id || '',              // draft it's reserved on (pending)
          redeemed_against: r.target_order_name || '',            // order it was truly redeemed on
          issued_at:        r.issued_at || '',
          applied_at:       r.applied_at || '',
          redeemed_at:      r.redeemed_at || '',
          voided_at:        r.voided_at || '',
          expires_at:       r.expires_at || '',
        };
      }).sort((a, b) => (a.instrument_type + a.serial_code).localeCompare(b.instrument_type + b.serial_code));

    } else if (view === 'summary') {
      const groups = {};
      for (const r of rows) {
        const month = String(r.issued_at || '').slice(0, 7);
        const key = `${r.instrument_type}|${month}`;
        const g = groups[key] || (groups[key] = {
          instrument_type: r.instrument_type, month,
          issued_count: 0, issued_value: 0, redeemed_count: 0, redeemed_value: 0,
          applied_count: 0, applied_value: 0,
          outstanding_count: 0, outstanding_value: 0, voided_count: 0, voided_value: 0,
          expired_count: 0, expired_value: 0,
        });
        const val = parseFloat(r.value) || 0;
        g.issued_count++; g.issued_value += val;
        const st = creditInstruments.effectiveStatus(r, now);
        if (st === 'redeemed')      { g.redeemed_count++;    g.redeemed_value    += val; }
        else if (st === 'applied')  { g.applied_count++;     g.applied_value     += val; }  // reserved on a draft (not yet a true redemption)
        else if (st === 'voided')   { g.voided_count++;      g.voided_value      += val; }
        else if (st === 'expired')  { g.expired_count++;     g.expired_value     += val; }
        else                        { g.outstanding_count++; g.outstanding_value += val; }
      }
      out = Object.values(groups).map(g => ({
        ...g,
        issued_value: g.issued_value.toFixed(2), redeemed_value: g.redeemed_value.toFixed(2),
        applied_value: g.applied_value.toFixed(2),
        outstanding_value: g.outstanding_value.toFixed(2), voided_value: g.voided_value.toFixed(2),
        expired_value: g.expired_value.toFixed(2),
        balances: (g.redeemed_count + g.applied_count + g.outstanding_count + g.voided_count + g.expired_count) === g.issued_count,
      })).sort((a, b) => (a.instrument_type + a.month).localeCompare(b.instrument_type + b.month));

    } else if (view === 'outstanding') {
      out = rows.filter(r => creditInstruments.effectiveStatus(r, now) === 'open').map(r => ({
        instrument_type: r.instrument_type, serial_code: r.serial_code, value: parseFloat(r.value).toFixed(2),
        customer_name: r.customer_name || '', source_order_name: r.source_order_name || '',
        issued_at: r.issued_at, expires_at: r.expires_at || '',
        days_to_expiry: r.expires_at ? Math.round((new Date(r.expires_at).getTime() - now) / 864e5) : '',
      })).sort((a, b) => String(a.expires_at).localeCompare(String(b.expires_at)));

    } else if (view === 'tieout') {
      out = rows.filter(r => creditInstruments.effectiveStatus(r, now) === 'redeemed').map(r => ({
        instrument_type: r.instrument_type, serial_code: r.serial_code, value: parseFloat(r.value).toFixed(2),
        customer_name: r.customer_name || '', source_order_name: r.source_order_name || '',
        target_order_name: r.target_order_name || '', target_draft_id: r.target_draft_id || '',
        redeemed_at: r.redeemed_at || '',
      }));
    } else {
      return res.status(400).json({ success: false, error: `unknown view: ${view}` });
    }

    if ((req.query.format || '').toLowerCase() === 'csv') {
      const cols = out.length ? Object.keys(out[0]) : [];
      const csv = [cols.join(',')].concat(out.map(r => cols.map(c => {
        const v = r[c] == null ? '' : String(r[c]);
        return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
      }).join(','))).join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="recon-ledger-${view}.csv"`);
      return res.send(csv);
    }
    return res.json({ success: true, view, count: out.length, rows: out });
  } catch (err) {
    console.error('recon-ledger error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});


app.get('/api/adjustment-report', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ success: false, error: 'from and to (YYYY-MM-DD) are required' });
  const num = (v) => (parseFloat(v) || 0);
  try {
    const token = await getShopifyToken();
    const search = `created_at:>=${from} created_at:<=${to}`;
    const rows = [];

    // Instrument lifecycle join: show BOTH sides — a voucher/exchange-note ISSUED against an order
    // and REDEEMED against another. Fetch all instruments once, index by the order they were issued
    // on (source) and redeemed on (target), tagging each with its state + the counterpart order.
    const nowMs = Date.now();
    const bySource = {}, byTarget = {};
    for (const r of await creditInstruments.fetchAll(supabase, {})) {
      const st = creditInstruments.effectiveStatus(r, nowMs);
      const stateLbl = st === 'open' ? 'outstanding' : st;
      const money = `₹${(parseFloat(r.value) || 0).toFixed(0)}`;
      if (r.source_order_name) (bySource[r.source_order_name] = bySource[r.source_order_name] || [])
        .push(`${r.serial_code} ${money} [${stateLbl}]${r.target_order_name ? ' → ' + r.target_order_name : ''}`);
      if (r.target_order_name) (byTarget[r.target_order_name] = byTarget[r.target_order_name] || [])
        .push(`${r.serial_code} ${money} [${stateLbl}]${r.source_order_name ? ' ← ' + r.source_order_name : ''}`);
    }

    let cursor = null, page = 0;
    do {
      const query = `query($q:String!,$after:String){ orders(first:50, query:$q, after:$after, sortKey:CREATED_AT){ pageInfo{hasNextPage endCursor} edges{ node{ name createdAt customer{displayName} shippingAddress{provinceCode} subtotalPriceSet{shopMoney{amount}} totalPriceSet{shopMoney{amount}} metafields(namespace:"custom", first:100){edges{node{key value}}} lineItems(first:50){edges{node{ quantity product{ hsn: metafield(namespace:"custom", key:"hsn_code"){value} } }}} } } } }`;
      const { data } = await axios.post(
        `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/graphql.json`,
        { query, variables: { q: search, after: cursor } },
        { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      const conn = data && data.data && data.data.orders;
      if (!conn) return res.status(502).json({ success: false, error: 'Shopify GraphQL error', detail: data && data.errors });
      for (const e of conn.edges) {
        const n = e.node; const mf = {};
        for (const me of n.metafields.edges) mf[me.node.key] = me.node.value;
        const gross = mf.gross_value != null ? num(mf.gross_value) : num(n.subtotalPriceSet.shopMoney.amount);
        const discount = num(mf.discount_applied);
        // GST ties to the tax invoice: gross is tax-INCLUSIVE and pre-discount; discount_applied is
        // PRE-tax rupees (normalized at every writer), so taxable = gross/1.03 − discount. Do NOT divide
        // the discount too — it is already pre-tax, and doing so under-applies it by 2.91% of its value.
        // Flat 3% split by supplier store state (custom.state_code) vs shipping province.
        const shipState = n.shippingAddress?.provinceCode || '';
        const taxable   = Math.round(Math.max(0, gross / 1.03 - discount) * 100) / 100;
        const gst       = reports.gstSplit(taxable, mf.state_code || '', shipState);
        const lines     = (n.lineItems?.edges || []).map(le => le.node);
        const totalQty  = lines.reduce((s, li) => s + (li.quantity || 0), 0);
        const hsnSet    = [...new Set(lines.map(li => (li.product?.hsn?.value) || '71131914'))];
        rows.push({
          name: n.name, created_at: n.createdAt, customer: (n.customer && n.customer.displayName) || '',
          place_of_supply:        reports.supplierState(mf.state_code || ''),
          shipping_state:         shipState,
          custom_serial:          mf.serial_code || '',
          hsn:                    hsnSet.join(' | '),
          qty:                    totalQty,
          gross_value:            gross.toFixed(2),
          discount_applied:       discount.toFixed(2),
          taxable_value:          taxable.toFixed(2),
          igst:                   gst.igst.toFixed(2),
          sgst:                   gst.sgst.toFixed(2),
          cgst:                   gst.cgst.toFixed(2),
          voucher_value:          num(mf.voucher_value).toFixed(2),
          exchange_note_value:    num(mf.exchange_note_value).toFixed(2),
          old_gold_value:         num(mf.old_gold_value).toFixed(2),
          advance:                num(mf.advance).toFixed(2),
          amount_to_be_collected: (mf.amount_to_be_collected != null ? num(mf.amount_to_be_collected) : num(n.totalPriceSet.shopMoney.amount)).toFixed(2),
          // amount_paid is the cumulative sum of the installment legs and stands alone;
          // amount_paid_final is legacy, pinned to 0, and added only so orders written before the
          // installment migration (which still split the two) tie out to the same figure.
          // `advance` stays a SEPARATE column above — the CAD design advance is tax-free at
          // collection, and folding it into amount_paid would make that treatment unauditable.
          amount_paid:            (num(mf.amount_paid) + num(mf.amount_paid_final)).toFixed(2),
          total_price:            num(n.totalPriceSet.shopMoney.amount).toFixed(2),
          instruments_issued:     (bySource[n.name] || []).join(' | '),   // credits generated on this order
          instruments_redeemed:   (byTarget[n.name] || []).join(' | '),   // credits used on this order
        });
      }
      cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (cursor && ++page < 50);

    const sumKeys = ['qty','gross_value','discount_applied','taxable_value','igst','sgst','cgst','voucher_value','exchange_note_value','old_gold_value','advance','amount_to_be_collected','amount_paid','total_price'];
    const totals = { name: 'TOTAL', created_at: '', customer: `${rows.length} orders` };
    for (const k of sumKeys) totals[k] = rows.reduce((s, r) => s + num(r[k]), 0).toFixed(2);

    if ((req.query.format || '').toLowerCase() === 'csv') {
      const cols = ['name','created_at','customer','place_of_supply','shipping_state','custom_serial','hsn', ...sumKeys, 'instruments_issued','instruments_redeemed'];
      const all = rows.concat([totals]);
      const csv = [cols.join(',')].concat(all.map(r => cols.map(c => {
        const v = r[c] == null ? '' : String(r[c]);
        return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
      }).join(','))).join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="adjustment-report-${from}_${to}.csv"`);
      return res.send(csv);
    }
    return res.json({ success: true, count: rows.length, totals, rows });
  } catch (err) {
    console.error('adjustment-report error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/recompute-payment { draftOrderId } | { orderId }
// Recomputes Amount Pending + Payment Status off the NET-to-collect and persists them. Called directly
// by the metafield-manager admin action right after it saves amount_paid, so the balance updates

}

module.exports = { register };
