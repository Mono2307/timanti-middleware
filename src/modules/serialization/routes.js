'use strict';

/**
 * Serialization routes — allocating and correcting document numbers.
 *
 * Every business document gets a human-readable serial (customer orders, repairs, memos,
 * transfers, purchase orders, vouchers, exchange notes). Numbers are FY-scoped and per store, so
 * they cannot simply be a database sequence: allocation, cancellation and re-stamping all have to
 * be reversible, and the ledger has to survive a mis-numbered document being voided.
 *
 * ENTRY POINT
 *   register(app, ctx)   mounts the routes below.
 *
 * ALSO EXPORTED
 *   SERIAL_DEPS()  the dependency bundle the serialization engine takes. Exported because five
 *                  call sites elsewhere (draft tag handlers, voucher/exchange void) allocate and
 *                  cancel serials outside these routes.
 *
 * ENDPOINTS
 *   POST /api/serial/allocate             allocate, and optionally stamp, a serial
 *   POST /api/serial/cancel-by-code       release a serial by its code
 *   POST /api/serial/order-serial         mint the customer-order serial at conversion
 *   GET  /api/serial/peek                 next number without consuming it
 *   GET+POST /api/serial/backfill           number historical documents
 *   GET+POST /api/serial/clear              clear stamped serials (recovery)
 *   GET+POST /api/serial/restamp-from-ledger  re-apply from the ledger after a bad write
 *   GET+POST /api/serial/counter            read/set a counter
 *   GET+POST /api/serial/set-state          force a counter's state
 *   GET+POST /api/serial/ledger-backfill    rebuild ledger rows from stamped documents
 *
 * The recovery endpoints are exposed on GET as well as POST on purpose: they are operated by a
 * human pasting a URL into a browser, not by a client. They are destructive — read the handler
 * before clicking one.
 *
 * EXIT POINTS
 *   modules/serialization/index.js   the allocation engine and ledger
 *   modules/adjustments              credit-instrument ledger, for voucher/exchange serials
 *   core/shopify, core/metafields, core/supabase
 */

const axios = require('axios');

const { config }   = require('../../core/config');
const { supabase } = require('../../core/supabase');
const { getShopifyToken } = require('../../core/shopify');
const { updateDraftOrderMetafields, updateOrderMetafields } = require('../../core/metafields');
const { log } = require('../../core/logger');

const serialization     = require('./index');
const creditInstruments = require('../adjustments/credit_instruments');
const { isCadAdvanceOnly } = require('../adjustments/cad_advance');

const SERIAL_CUSTOMER_ORDER       = config.serial.customerOrder;
const SERIAL_CUSTOMER_ORDER_START = config.serial.customerOrderStart;

/** Dependency bundle for the serialization engine. Also used by callers outside this module. */
const SERIAL_DEPS = () => ({
  supabase,
  getShopifyToken,
  shopifyStoreUrl: config.shopify.storeUrl,
  updateDraftOrderMetafields,
});

function register(app, ctx) {
  // applyPaymentTagsToOrder still lives in the bootstrap (see the header note). It MUST be taken
  // from ctx: when this module was lifted out of server.js the call below kept referring to the
  // bare name, which resolved fine inside the monolith and became a free variable here. Node only
  // resolves it when the handler runs, so the app booted clean and every orders/updated webhook
  // then died on a ReferenceError — after the 200 ack, and before the serial mint.
  const { applyPaymentTagsToOrder } = ctx;

// Body: { docType, stateCode?, shopifyLocationId?, shippingAddress?, draftOrderId?, orderId?, documentType? }
app.post('/api/serial/allocate', async (req, res) => {
  try {
    const { docType } = req.body || {};
    if (!docType) return res.status(400).json({ success: false, error: 'docType required' });
    // Vouchers and exchange notes are valid the moment they're created → record in the ledger
    // (keyed by their own VCH-/EXC- code) so they can be voided. Neither has a Shopify resource id
    // at allocate time. Minted ONCE here — downstream endpoints (e.g. /api/exc-redeem) must not
    // re-mint, or the customer-facing number and the ledger row would diverge.
    if (docType === 'voucher' || docType === 'exchange_note') {
      // EXC/VCH are now per-store (EXC27-KAHSR-0001) — the caller must pass the issuing store code.
      const storeCode = (req.body.stateCode || req.body.storeCode || '').toUpperCase().trim();
      if (!storeCode) return res.status(400).json({ success: false, error: `stateCode (store code) required for ${docType}` });
      const r = await serialization.mintSerial(SERIAL_DEPS(), {
        docType, storeCode, resourceType: docType, resourceIdFromCode: true,
      });
      return res.json({ success: true, allocated: r.minted, serial_no: r.seq, serial_code: r.serial_code, serial_display: r.serial_code });
    }
    const result = await serialization.allocateAndStamp(SERIAL_DEPS(), req.body);
    return res.json({ success: true, ...result });
  } catch (err) {
    if (err.code === 'NO_STATE') return res.status(400).json({ success: false, error: err.message });
    console.error('[serial] allocate failed:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/serial/cancel-by-code — retire a serial that has no Shopify resource id (credit notes).
// Identify by serialNo (the seq — preferred for CNs, whose CNTM-YYYY-NNNN shares only the seq with
// the ledger) or by serialCode (the ledger resource_id). Body: { serialNo?|serialCode?, docType? }.
app.post('/api/serial/cancel-by-code', async (req, res) => {
  try {
    const body    = req.body || {};
    const docType = body.docType || 'voucher';
    const seq     = body.serialNo != null ? Number(body.serialNo) : null;
    if (seq == null && !body.serialCode) {
      return res.status(400).json({ success: false, error: 'serialNo or serialCode required' });
    }
    const r = await serialization.cancelSerial(SERIAL_DEPS(),
      seq != null ? { docType, seq } : { docType, resourceId: String(body.serialCode) });
    if (!r) return res.status(404).json({ success: false, error: `no serial found for ${seq != null ? 'seq ' + seq : body.serialCode}` });
    return res.json({ success: true, serial_code: r.serial_code, seq: r.seq, status: r.status, cancelled_at: r.cancelled_at });
  } catch (err) {
    console.error('[serial] cancel-by-code failed:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Freeze an online-redeemed VOUCHER as a POST-tax adjustment on the order.
// A voucher is a Shopify discount CODE (needed for online self-redemption + Shopify single-use/expiry).
// At checkout Shopify applies it through discount_allocations, reducing the SUBTOTAL (pre-tax) — but our
// prices are GST-inclusive and a voucher is a credit instrument, so it must be POST-tax. We reclassify:
// freeze the VCH-identity discount into custom.voucher_value (post-tax), fold every OTHER discount
// (ordinary promo) into custom.discount_applied (pre-tax — see the /1.03 conversion below), and freeze
// custom.gross_value (full, pre-discount, tax-inclusive) so the tax invoice reproduces GST as
// gross/1.03 − discount_applied, then − voucher.
// Online orders are already paid at checkout and never enter the draft/deposit collection path, so this
// re-classification is for invoice/recon reproducibility only — it does NOT re-subtract money.
// Reads NATIVE discount objects on the webhook body (line props are absent online / flaky offline).
// Only touches orders carrying a VCH code (offline vouchers are metafields, not codes); idempotent.
async function freezeOnlineVoucher(order, token) {
  const codes = order.discount_codes || [];
  if (!codes.some(c => /^VCH/i.test(String(c.code || '')))) return; // no online voucher here

  const { data: mfData } = await axios.get(
    `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${order.id}/metafields.json`,
    { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
  );
  const frozen = (mfData.metafields || []).find(m => m.namespace === 'custom' && m.key === 'voucher_value');
  if (frozen && parseFloat(frozen.value) > 0) return; // already frozen

  const lines = order.line_items || [];
  const apps  = order.discount_applications || [];
  const grossValue = lines.reduce((s, li) => s + parseFloat(li.price || 0) * (li.quantity || 0), 0);

  let voucherValue = 0, discountApplied = 0;
  apps.forEach((app, i) => {
    let amt = 0;
    for (const li of lines) for (const alloc of (li.discount_allocations || [])) {
      if (Number(alloc.discount_application_index) === i) amt += parseFloat(alloc.amount || 0);
    }
    if (amt <= 0) return;
    const ident = String(app.code || app.title || '');
    if (/^VCH/i.test(ident)) voucherValue += amt; else discountApplied += amt;
  });

  // Fallback when allocations are missing: classify straight off discount_codes amounts.
  if (voucherValue === 0 && discountApplied === 0) {
    for (const c of codes) {
      const amt = parseFloat(c.amount || 0);
      if (amt <= 0) continue;
      if (/^VCH/i.test(String(c.code || ''))) voucherValue += amt; else discountApplied += amt;
    }
  }
  if (voucherValue <= 0) return; // nothing classified as a voucher — leave the order alone

  // Shopify allocates a promo against our GST-INCLUSIVE prices, so `discountApplied` is tax-inclusive
  // rupees. custom.discount_applied is pre-tax by definition (every reader does gross/1.03 − discount),
  // so convert at this boundary. The voucher is a post-tax credit instrument and stays as-is.
  const discountPreTax = discountApplied / 1.03;

  await updateOrderMetafields(String(order.id), {
    gross_value:      grossValue.toFixed(2),
    discount_applied: discountPreTax.toFixed(2),
    voucher_value:    voucherValue.toFixed(2),
  }, token);
  console.log(`[voucher-freeze] order ${order.name || order.id}: gross=${grossValue.toFixed(2)} discount_applied=${discountPreTax.toFixed(2)} (incl ${discountApplied.toFixed(2)}) voucher_value=${voucherValue.toFixed(2)}`);

  // Record the online voucher redemption in the credit-instrument ledger.
  const vchCode = (codes.find(c => /^VCH/i.test(String(c.code || ''))) || {}).code;
  if (vchCode) {
    try {
      await creditInstruments.redeem(supabase, {
        instrumentType: 'voucher', serialCode: vchCode,
        targetOrderId: order.id, targetOrderName: order.name, value: voucherValue,
      });
    } catch (e) { console.error('[ledger] online voucher redeem:', e.message); }
  }
}

// orders/create + orders/update webhook → stamp a customer_order serial on online orders
// once staff have entered the order's custom.state_code (place of supply). Shipping province
// is NOT used. Draft-origin orders are skipped — they're serialized on the draft and copied.
// orders/create + orders/update → mint a customer_order serial at the ORDER level (v2 ledger).
// Fires for BOTH online (staff set state_code on the order) and offline (state_code copied from
// the paid draft). Mints only once store code is present; idempotent via the ledger.
// It ALSO runs the post-tax voucher freeze (independent of the serial flag).
app.post('/api/serial/order-serial', async (req, res) => {
  res.json({ success: true }); // ack immediately; work is fire-and-forget
  const order = req.body || {};
  if (!order.id) return;
  let token;
  try { token = await getShopifyToken(); }
  catch (e) { console.error(`[order-serial] token fetch failed for ${order.id}:`, e.message); return; }

  // Post-tax voucher freeze — runs regardless of serial flags (only touches orders with a VCH code).
  freezeOnlineVoucher(order, token).catch(e => console.error(`[voucher-freeze] order ${order.id}:`, e.message));

  // Payment recompute — the order-side twin of the draft webhook's payment-sync step.
  //
  // Installments are editable AFTER conversion (the admin panel renders them on the order page and
  // the metafields are copied over at conversion), but nothing here used to recompute: the panel
  // adds a `sync-payment` tag and only the DRAFT chain ever consumed it. So an order edited to
  // full-and-final kept printing the old balance on its tax invoice.
  //
  // Runs unconditionally rather than gating on the tag, because a metafield save does not always
  // carry one and a stale balance on an invoice is worse than a no-op read. Safe to run on every
  // orders/update: applyPaymentTagsToOrder returns early when there is nothing to bill, and skips
  // the tag write entirely when nothing changed — which is what stops this webhook re-triggering
  // itself in a loop. Fire-and-forget; never blocks the serial mint below.
  applyPaymentTagsToOrder(String(order.id), token)
    .catch(e => console.error(`[payment-sync] order ${order.name || order.id}:`, e.message));

  if (!SERIAL_CUSTOMER_ORDER) return;

  // Date gate: only number orders created on/after the cutoff (default 1 Aug 2026 IST).
  // Keeps July (and earlier) orders unnumbered even if they are edited after the cutoff.
  const _serialCutoff  = new Date(SERIAL_CUSTOMER_ORDER_START);
  const _orderCreated  = order.created_at ? new Date(order.created_at) : null;
  if (_orderCreated && !isNaN(_serialCutoff.getTime()) && _orderCreated < _serialCutoff) {
    console.log(`[serial] order ${order.name || order.id} created ${order.created_at} < start ${SERIAL_CUSTOMER_ORDER_START} — skip mint`);
    return;
  }

  // A CAD-advance-only order is NOT an invoice. Nothing was sold: it is a receipt for money taken
  // against a purchase that may never happen, and it is deliberately unnumbered — the customer gets
  // a payment confirmation, and the sale that eventually absorbs the advance carries the invoice
  // number. Minting here would burn a permanent number (customer-order serials have no cancellation
  // path by design) and leave a document in the GST series with no supply behind it.
  //
  // isCadAdvanceOnly is false when the payload carries no line items at all, so a truncated webhook
  // can never silently suppress a real invoice number.
  if (isCadAdvanceOnly(order)) {
    console.log(`[serial] order ${order.name || order.id} is a CAD advance receipt — no serial minted (by design)`);
    return;
  }

  (async () => {
    const deps = SERIAL_DEPS();
    const mf = await serialization.readSerialMetafields(deps, 'orders', String(order.id), token);
    if (mf.serial_code) return; // already numbered (v1 or prior) — NEVER re-mint, even if the ledger lacks it
    const storeCode = (mf.state_code || '').toUpperCase().trim();
    if (!storeCode) return; // store code not set yet — nothing to mint
    const r = await serialization.mintSerial(deps, {
      docType: 'customer_order', storeCode,
      resourceType: 'order', resourceId: String(order.id), resourceName: order.name,
      stamp: true,
    });
    if (r.minted) console.log(`[serial] customer_order order ${order.name || order.id} → ${r.serial_code}`);
  })().catch(e => console.error(`[serial] order-serial failed for ${order.id}:`, e.message));
});

// NOTE: customer-order serials are PERMANENT once minted — there is intentionally NO cancellation
// path for them. A cancelled/refunded order keeps its number (like an invoice number); any reversal
// is handled by a separate credit note. Only PO / memo / transfer / credit_note can be voided.

// Read-only peek at the current value of a counter (never allocates).
app.get('/api/serial/peek', async (req, res) => {
  try {
    const { docType, state } = req.query;
    if (!docType) return res.status(400).json({ success: false, error: 'docType required' });
    const registry = await serialization.getRegistry(SERIAL_DEPS());
    const reg = registry[docType];
    if (!reg) return res.status(400).json({ success: false, error: `unknown docType: ${docType}` });
    const stateCode = reg.scope === 'global' ? 'ALL' : (state ? String(state).toUpperCase() : null);
    if (reg.scope === 'state' && !stateCode) return res.status(400).json({ success: false, error: 'state required' });
    const { data } = await supabase
      .from('serial_counters').select('current_value, updated_at')
      .eq('doc_type', docType).eq('state_code', stateCode).maybeSingle();
    return res.json({
      success: true, docType, stateCode,
      current_value: data ? Number(data.current_value) : null,
      next_value: data ? Number(data.current_value) + 1 : reg.start,
      updated_at: data?.updated_at || null,
    });
  } catch (err) {
    console.error('[serial] peek failed:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/serial/backfill — one-time assignment of customer_order serials to ALREADY-PUNCHED
// orders, in chronological order (earliest KA order → KA-1001, etc.). Opt-in = staff has set the
// order's custom.state_code; opt-out = tag the order `skip-serial`. DRY RUN BY DEFAULT.
//
// Body: { nameFrom?, nameTo?, from?, to?, docType='customer_order', skipTag='skip-serial', dryRun=true }
//   nameFrom/nameTo : numeric order-name range (e.g. 1038..1056)
//   from/to         : created_at range (YYYY-MM-DD) — alternative to name range
//   dryRun=true     : preview only (predicts numbers, allocates nothing)
//   dryRun=false    : actually allocate + stamp
async function runSerialBackfill(req, res) {
  try {
    if (!SERIAL_CUSTOMER_ORDER) return res.status(400).json({ success: false, error: 'SERIAL_CUSTOMER_ORDER flag is off' });
    const p = { ...(req.query || {}), ...(req.body || {}) };
    const { nameFrom, nameTo, from, to } = p;
    const docType = p.docType || 'customer_order';
    const skipTag = p.skipTag != null ? p.skipTag : 'skip-serial';
    const code    = (p.code || '').toUpperCase().trim() || null; // store code to apply if order has none
    const dryRun  = !(p.dryRun === false || p.dryRun === 'false'); // default true; execute only on explicit ?dryRun=false
    const token = await getShopifyToken();
    const hdrs  = { 'X-Shopify-Access-Token': token, 'Accept': 'application/json' };
    const deps  = SERIAL_DEPS();

    // Fetch orders oldest-first so serials follow chronological order.
    const qp = new URLSearchParams({ status: 'any', order: 'created_at asc', limit: '250' });
    if (from) qp.set('created_at_min', new Date(from).toISOString());
    if (to)   qp.set('created_at_max', new Date(to + 'T23:59:59Z').toISOString());
    let url = `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders.json?${qp}`;
    const orders = [];
    while (url) {
      const { data, headers } = await axios.get(url, { headers: hdrs, timeout: 30000 });
      orders.push(...(data.orders || []));
      const m = (headers['link'] || '').match(/<([^>]+)>;\s*rel="next"/);
      url = m ? m[1] : null;
    }

    const nf = nameFrom != null ? parseInt(nameFrom) : null;
    const nt = nameTo   != null ? parseInt(nameTo)   : null;
    const processed = [], skipped = [];
    const sim = {}; // dry-run per-state running counter

    for (const o of orders) {
      const num = parseInt((o.name || '').replace(/\D/g, ''));
      if (nf != null && num < nf) continue;
      if (nt != null && num > nt) continue;

      const tags = (o.tags || '').split(',').map(t => t.trim().toLowerCase());
      if (skipTag && tags.includes(skipTag.toLowerCase())) { skipped.push({ name: o.name, reason: 'skip-tag' }); continue; }

      const mf = await serialization.readSerialMetafields(deps, 'orders', String(o.id), token);
      if (mf.serial_code) { skipped.push({ name: o.name, reason: 'already', serial_code: mf.serial_code }); continue; }
      // The ?code= param wins so a clean redo can re-stamp; else use the order's existing state_code.
      const state = code || (mf.state_code ? mf.state_code.toUpperCase() : null);
      if (!state) { skipped.push({ name: o.name, reason: 'no-state_code' }); continue; }

      if (dryRun) {
        if (sim[state] == null) sim[state] = 0;
        sim[state] += 1;
        // Approximate only — the live allocate path resolves the real FY-folded counter + format.
        processed.push({ name: o.name, state, predicted_serial_code: `${docType} ${state} #~${sim[state]} (approx; run live for the real serial)` });
      } else {
        const r = await serialization.allocateAndStamp(deps, { docType, orderId: String(o.id), stateCode: state });
        processed.push({ name: o.name, state, serial_code: r.serial_code, stamped: r.stamped });
        await new Promise(res => setTimeout(res, 350)); // throttle to stay under Shopify's rate limit
      }
    }

    return res.json({ success: true, dryRun, processedCount: processed.length, skippedCount: skipped.length, processed, skipped });
  } catch (err) {
    console.error('[serial] backfill failed:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
app.get('/api/serial/backfill', runSerialBackfill);   // browser-clickable
app.post('/api/serial/backfill', runSerialBackfill);

// GET/POST /api/serial/clear — removes the machine-written serial metafields
// (document_type, serial_no, serial_code, serial_display) so a resource can be re-numbered.
// Leaves the staff-entered state_code intact. Browser-clickable.
//   ?draftOrderId=X | ?orderId=X | ?nameFrom=1038&nameTo=1056  (orders range)
async function runSerialClear(req, res) {
  try {
    const p = { ...(req.query || {}), ...(req.body || {}) };
    const token = await getShopifyToken();
    const hdrs  = { 'X-Shopify-Access-Token': token, 'Accept': 'application/json' };
    const withState = (p.withState === 'true' || p.withState === true);
    // Order matters: remove state_code FIRST and serial_code LAST. While serial_code exists the
    // live webhook idempotent-skips; once it's gone, state_code is already gone too → no re-stamp.
    const keys  = (withState ? ['state_code'] : []).concat(['document_type', 'serial_no', 'serial_display', 'serial_code']);
    const cleared = [];

    async function clearOne(resource, id, name) {
      const { data } = await serialization.withRetry(() => axios.get(
        `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/${resource}/${id}/metafields.json`,
        { headers: hdrs, timeout: 15000 }));
      const removed = [];
      for (const mf of (data.metafields || [])) {
        if (mf.namespace === 'custom' && keys.includes(mf.key)) {
          await serialization.withRetry(() => axios.delete(`${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/metafields/${mf.id}.json`, { headers: hdrs, timeout: 15000 }));
          removed.push(mf.key);
          await new Promise(r => setTimeout(r, 200)); // throttle deletes
        }
      }
      cleared.push({ resource, name: name || id, removed });
    }

    if (p.draftOrderId) await clearOne('draft_orders', p.draftOrderId);
    if (p.orderId)      await clearOne('orders', p.orderId);

    if (p.nameFrom != null || p.nameTo != null) {
      const nf = p.nameFrom != null ? parseInt(p.nameFrom) : null;
      const nt = p.nameTo   != null ? parseInt(p.nameTo)   : null;
      let url = `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders.json?status=any&order=created_at asc&limit=250`;
      const orders = [];
      while (url) {
        const { data, headers } = await serialization.withRetry(() => axios.get(url, { headers: hdrs, timeout: 30000 }));
        orders.push(...(data.orders || []));
        const m = (headers['link'] || '').match(/<([^>]+)>;\s*rel="next"/);
        url = m ? m[1] : null;
      }
      for (const o of orders) {
        const num = parseInt((o.name || '').replace(/\D/g, ''));
        if (nf != null && num < nf) continue;
        if (nt != null && num > nt) continue;
        await clearOne('orders', String(o.id), o.name);
        await new Promise(r => setTimeout(r, 300)); // throttle
      }
    }

    return res.json({ success: true, clearedCount: cleared.length, cleared });
  } catch (err) {
    console.error('[serial] clear failed:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
app.get('/api/serial/clear', runSerialClear);
app.post('/api/serial/clear', runSerialClear);

// GET/POST /api/serial/restamp-from-ledger — re-mirror serial metafields onto resources from the
// serial_ledger (the source of truth). Recovers orders whose metafields a clear stripped AND
// offline draft→order orders that got the serial but never the state_code. This ALLOCATES NOTHING
// and advances NO counter — it writes the existing ledger numbers (and store code) back, overwriting
// whatever is on the order. Dry-run unless ?apply=true.
//   ?docType=customer_order  ?status=active  ?nameFrom=1038&nameTo=1056  ?apply=true
async function runSerialRestamp(req, res) {
  try {
    const p       = { ...(req.query || {}), ...(req.body || {}) };
    const docType = p.docType || 'customer_order';
    const status  = p.status  || 'active';
    const apply   = (p.apply === 'true' || p.apply === true);
    const nf      = p.nameFrom != null ? parseInt(p.nameFrom) : null;
    const nt      = p.nameTo   != null ? parseInt(p.nameTo)   : null;
    const deps    = SERIAL_DEPS();
    const token   = await getShopifyToken();

    // Source of truth: ledger rows for this doc type, ordered by seq. Only order-backed rows can be
    // restamped (credit notes have no Shopify resource).
    let q = deps.supabase.from('serial_ledger').select('*')
      .eq('doc_type', docType).eq('resource_type', 'order').order('seq', { ascending: true });
    if (status !== 'all') q = q.eq('status', status);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    const report = [];
    for (const row of (rows || [])) {
      if (!row.resource_id) { report.push({ seq: row.seq, serial_code: row.serial_code, action: 'skip:no-resource-id' }); continue; }
      const num = parseInt(String(row.resource_name || '').replace(/\D/g, ''));
      if (nf != null && num && num < nf) continue;
      if (nt != null && num && num > nt) continue;

      // Full re-mirror from the ledger (the source of truth): write EVERY field — state_code
      // plus all serial fields — onto the order. The offline draft→order path copies the serial
      // across but drops state_code, so a state-only backfill isn't enough; we rewrite the lot.
      // writeSerialMetafields skips blank values, so a ledger row with no store_code simply
      // leaves state_code untouched. Counters are NOT advanced — these are the existing numbers.
      // store_code may be FY-folded (e.g. "27|KA-HSR") for per-FY doc types; the staff-facing
      // state_code metafield wants only the bare store code, so strip any "FY|" prefix.
      const bareStore = String(row.store_code || '').split('|').pop();
      const fields = {
        document_type:  row.doc_type,
        serial_no:      row.seq,
        serial_code:    row.serial_code,
        serial_display: row.serial_code, // customer_order display == code
        state_code:     bareStore === 'ALL' ? '' : bareStore,
      };

      if (!apply) { report.push({ name: row.resource_name, serial_code: row.serial_code, store_code: row.store_code, action: 'would-stamp', fields }); continue; }

      const w = await serialization.stampSerial(deps, 'orders', String(row.resource_id), fields, token);
      report.push({ name: row.resource_name, serial_code: row.serial_code, store_code: row.store_code, action: w.errors.length ? 'stamp-errors' : 'stamped', errors: w.errors });
      await new Promise(r => setTimeout(r, 250)); // throttle Shopify writes
    }

    const summary = report.reduce((a, r) => { a[r.action] = (a[r.action] || 0) + 1; return a; }, {});
    return res.json({ success: true, dryRun: !apply, docType, status, count: report.length, summary, report });
  } catch (err) {
    console.error('[serial] restamp failed:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
app.get('/api/serial/restamp-from-ledger', runSerialRestamp);
app.post('/api/serial/restamp-from-ledger', runSerialRestamp);

// GET/POST /api/serial/counter — read / set / delete a single counter row. Browser-clickable.
//   ?docType=customer_order&state=KA-HSR            → read current + next
//   ?docType=customer_order&state=KA-HSR&set=1018   → set current_value (next = 1019)
//   ?docType=repair&state=KA-HSR&delete=true        → delete the row (resets to its start)
async function runSerialCounter(req, res) {
  try {
    const p = { ...(req.query || {}), ...(req.body || {}) };
    const docType = p.docType;
    const state = (p.state || '').toUpperCase().trim();
    if (!docType || !state) return res.status(400).json({ success: false, error: 'docType and state required' });

    if (p.delete === 'true' || p.delete === true) {
      await supabase.from('serial_counters').delete().eq('doc_type', docType).eq('state_code', state);
      return res.json({ success: true, action: 'deleted', docType, state });
    }
    if (p.set != null && p.set !== '') {
      const v = parseInt(p.set);
      await supabase.from('serial_counters').upsert(
        { doc_type: docType, state_code: state, current_value: v, updated_at: new Date().toISOString() },
        { onConflict: 'doc_type,state_code' });
      return res.json({ success: true, action: 'set', docType, state, current_value: v, next_value: v + 1 });
    }
    const { data } = await supabase.from('serial_counters')
      .select('current_value, updated_at').eq('doc_type', docType).eq('state_code', state).maybeSingle();
    return res.json({ success: true, docType, state,
      current_value: data ? Number(data.current_value) : null,
      next_value: data ? Number(data.current_value) + 1 : null });
  } catch (err) {
    console.error('[serial] counter admin failed:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
app.get('/api/serial/counter', runSerialCounter);
app.post('/api/serial/counter', runSerialCounter);

// GET/POST /api/serial/set-state — bulk-set custom.state_code (store code) on an order range
// or one resource. Use to retag historical orders before re-numbering. Browser-clickable.
//   ?nameFrom=1038&nameTo=1056&code=KA-HSR   |   ?orderId=123&code=KA-HSR   |   ?draftOrderId=123&code=KA-HSR
async function runSerialSetState(req, res) {
  try {
    const p = { ...(req.query || {}), ...(req.body || {}) };
    const code = (p.code || '').toUpperCase().trim();
    if (!code) return res.status(400).json({ success: false, error: 'code required' });
    const token = await getShopifyToken();
    const deps  = SERIAL_DEPS();
    const hdrs  = { 'X-Shopify-Access-Token': token, 'Accept': 'application/json' };
    const updated = [];

    async function setOne(resource, id, name) {
      const r = await serialization.stampSerial(deps, resource, id, { state_code: code }, token);
      updated.push({ resource, name: name || id, ok: r.errors.length === 0, errors: r.errors });
    }

    if (p.orderId)      await setOne('orders', p.orderId);
    if (p.draftOrderId) await setOne('draft_orders', p.draftOrderId);

    if (p.nameFrom != null || p.nameTo != null) {
      const nf = p.nameFrom != null ? parseInt(p.nameFrom) : null;
      const nt = p.nameTo   != null ? parseInt(p.nameTo)   : null;
      let url = `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders.json?status=any&order=created_at asc&limit=250`;
      const orders = [];
      while (url) {
        const { data, headers } = await serialization.withRetry(() => axios.get(url, { headers: hdrs, timeout: 30000 }));
        orders.push(...(data.orders || []));
        const m = (headers['link'] || '').match(/<([^>]+)>;\s*rel="next"/);
        url = m ? m[1] : null;
      }
      for (const o of orders) {
        const num = parseInt((o.name || '').replace(/\D/g, ''));
        if (nf != null && num < nf) continue;
        if (nt != null && num > nt) continue;
        await setOne('orders', String(o.id), o.name);
        await new Promise(r => setTimeout(r, 300));
      }
    }
    return res.json({ success: true, code, updatedCount: updated.length, updated });
  } catch (err) {
    console.error('[serial] set-state failed:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
app.get('/api/serial/set-state', runSerialSetState);
app.post('/api/serial/set-state', runSerialSetState);

// GET/POST /api/serial/ledger-backfill — load already-stamped orders into serial_ledger.
// Non-breaking (Stage 1). ?docType=customer_order&code=KA-HSR&nameFrom=1038&nameTo=1056
//   code = store_code to record (use it because historical state_code may be blank).
async function runSerialLedgerBackfill(req, res) {
  try {
    const p = { ...(req.query || {}), ...(req.body || {}) };
    const docType = p.docType || 'customer_order';
    const code = (p.code || '').toUpperCase().trim() || null;
    const token = await getShopifyToken();
    const hdrs  = { 'X-Shopify-Access-Token': token, 'Accept': 'application/json' };
    const deps  = SERIAL_DEPS();

    const nf = p.nameFrom != null ? parseInt(p.nameFrom) : null;
    const nt = p.nameTo   != null ? parseInt(p.nameTo)   : null;
    let url = `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders.json?status=any&order=created_at asc&limit=250`;
    const orders = [];
    while (url) {
      const { data, headers } = await serialization.withRetry(() => axios.get(url, { headers: hdrs, timeout: 30000 }));
      orders.push(...(data.orders || []));
      const m = (headers['link'] || '').match(/<([^>]+)>;\s*rel="next"/);
      url = m ? m[1] : null;
    }

    const inserted = [], skipped = [];
    for (const o of orders) {
      const num = parseInt((o.name || '').replace(/\D/g, ''));
      if (nf != null && num < nf) continue;
      if (nt != null && num > nt) continue;
      const mf = await serialization.readSerialMetafields(deps, 'orders', String(o.id), token);
      if (!mf.serial_code) { skipped.push({ name: o.name, reason: 'no-serial' }); continue; }
      const storeCode = code || (mf.state_code ? mf.state_code.toUpperCase() : null) || 'UNKNOWN';
      const { error } = await supabase.from('serial_ledger').insert({
        doc_type: docType, store_code: storeCode, seq: parseInt(mf.serial_no), serial_code: mf.serial_code,
        resource_type: 'order', resource_id: String(o.id), resource_name: o.name, status: 'active',
      });
      if (error) skipped.push({ name: o.name, reason: /duplicate|unique/i.test(error.message) ? 'already-in-ledger' : error.message });
      else inserted.push({ name: o.name, serial_code: mf.serial_code, seq: parseInt(mf.serial_no) });
      await new Promise(r => setTimeout(r, 150));
    }
    return res.json({ success: true, insertedCount: inserted.length, skippedCount: skipped.length, inserted, skipped });
  } catch (err) {
    console.error('[serial] ledger-backfill failed:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
app.get('/api/serial/ledger-backfill', runSerialLedgerBackfill);
app.post('/api/serial/ledger-backfill', runSerialLedgerBackfill);

}

module.exports = { register, SERIAL_DEPS };
