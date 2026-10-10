'use strict';

/**
 * Lifetime backfill: every historical order → the loyalty ledger, so customers start at the tier
 * their real history earns (founder's rule: lifetime spend, net of refunds, including past orders).
 *
 * Runs server-side because only this service's token reads orders of every age (read_all_orders).
 * Two phases, always in this order:
 *   1. DRY RUN (default) — reads every order, computes points per customer with the SAME rule live
 *      earning uses (engine.orderEarnValue), and produces a CSV for the founder to check. Writes
 *      nothing.
 *   2. COMMIT — writes one 'backfill' ledger row per order, then publishes each customer's points and
 *      tier to Shopify. Never emails anyone.
 *
 * One job at a time, held in memory; poll GET /api/loyalty/backfill for progress and the CSV.
 */

const axios = require('axios');
const { restUrl, shopifyHeaders, getShopifyToken, graphql } = require('../../core/shopify');
const { supabase } = require('../../core/supabase');
const { log } = require('../../core/logger');
const { isCadAdvanceOnly } = require('../adjustments/cad_advance');
const E = require('./engine');
const ledger = require('./ledger');
const { loadConfig } = require('./config');
const { refreshCustomer } = require('./customer');

let job = null;

const FIELDS = 'id,name,tags,created_at,cancelled_at,total_price,source_name,customer,line_items,discount_applications,discount_codes,refunds';

/** Every order, oldest page first, following Shopify's page_info cursor. */
async function* allOrders() {
  const token = await getShopifyToken();
  let url = restUrl(`orders.json?status=any&limit=250&fields=${FIELDS}`);
  while (url) {
    const res = await axios.get(url, { headers: shopifyHeaders(token), timeout: 60000 });
    yield res.data.orders || [];
    const link = String(res.headers.link || '');
    const next = link.split(',').find(p => /rel="next"/.test(p));
    url = next ? next.match(/<([^>]+)>/)[1] : null;
  }
}

/** custom.amount_refunded for a page of orders — in-store refunds live only there. */
async function refundedMap(orderIds) {
  const out = {};
  if (!orderIds.length) return out;
  const data = await graphql(`query($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { id
      refunded: metafield(namespace: "custom", key: "amount_refunded") { value } } } }`,
    { ids: orderIds.map(id => `gid://shopify/Order/${id}`) });
  for (const n of (data.nodes || [])) if (n && n.id) out[n.id.split('/').pop()] = Number(n.refunded && n.refunded.value) || 0;
  return out;
}

const csvCell = (v) => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function run({ commit }) {
  const cfg = await loadConfig();
  const perOrder = [];
  const customers = new Map();
  for await (const orders of allOrders()) {
    const refunded = await refundedMap(orders.map(o => String(o.id))).catch(() => ({}));
    for (const o of orders) {
      job.ordersSeen++;
      const cid = o.customer && o.customer.id ? String(o.customer.id) : null;
      if (!cid) continue;
      const points = isCadAdvanceOnly(o) ? 0 : E.earnPoints(o, cfg, { amountRefunded: refunded[String(o.id)] || 0 }).points;
      perOrder.push({ cid, orderId: String(o.id), name: o.name, points, channel: o.source_name === 'shopify_draft_order' ? 'store' : 'online' });
      const c = customers.get(cid) || {
        id: cid, name: [o.customer.first_name, o.customer.last_name].filter(Boolean).join(' '),
        email: o.customer.email || '', orders: 0, points: 0,
      };
      c.orders++; c.points += points;
      customers.set(cid, c);
    }
  }

  const rows = [...customers.values()].map(c => {
    const t = E.tierFor(c.points, cfg);
    return { ...c, tier: t.tier ? t.tier.name : '', pct: t.tier ? t.tier.pct : 0, gap: t.gapToNext };
  }).sort((a, b) => b.points - a.points);
  job.csv = ['customer_id,name,email,orders,points,tier,discount_pct,gap_to_next_tier']
    .concat(rows.map(r => [r.id, r.name, r.email, r.orders, r.points, r.tier, r.pct, r.gap].map(csvCell).join(',')))
    .join('\n');
  job.summary = {
    orders: job.ordersSeen, customers: rows.length,
    byTier: cfg.tiers.reduce((m, t) => ({ ...m, [t.name]: rows.filter(r => r.tier === t.name).length }), { none: rows.filter(r => !r.tier).length }),
  };

  if (!commit) return;
  for (const o of perOrder) {
    await ledger.upsertOrderEntry(supabase, { customerId: o.cid, orderId: o.orderId, orderName: o.name, points: o.points, kind: 'backfill', channel: o.channel });
    job.ledgerWritten++;
  }
  for (const r of rows) {
    try { await refreshCustomer(r.id, { notify: false }); job.customersPublished++; }
    catch (e) { job.errors.push(`${r.id}: ${e.message}`); }
  }
}

/** Start a backfill. Refuses while one is running. */
function start({ commit = false } = {}) {
  if (job && job.running) return { started: false, job: status() };
  job = {
    running: true, commit, startedAt: new Date().toISOString(), finishedAt: null,
    ordersSeen: 0, ledgerWritten: 0, customersPublished: 0, errors: [], csv: '', summary: null,
  };
  run({ commit })
    .catch(e => { job.errors.push(e.message); log.error('loyalty', `backfill failed: ${e.message}`); })
    .finally(() => { job.running = false; job.finishedAt = new Date().toISOString(); log.info('loyalty', `backfill ${commit ? 'COMMIT' : 'dry run'} finished: ${JSON.stringify(job.summary)}`); });
  return { started: true, job: status() };
}

function status() {
  if (!job) return null;
  const { csv, ...rest } = job;
  return { ...rest, errors: job.errors.slice(0, 50), csvReady: !!csv };
}

const csv = () => (job ? job.csv : '');

module.exports = { start, status, csv };
