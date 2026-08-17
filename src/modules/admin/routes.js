'use strict';

/**
 * Admin — operational tooling, not customer-facing behaviour.
 *
 * Everything here is run by a human fixing something: repricing the catalogue against a new gold
 * rate, backfilling data onto documents that predate a feature, or creating the Shopify metafield
 * definitions a new field needs. None of it runs on the normal order path.
 *
 * ENTRY POINT
 *   register(app, ctx)
 *
 * ALSO EXPORTED
 *   clearStalePriceUpdateFlag()  called once at boot — see the note on the lock below.
 *
 * ENDPOINTS
 *   GET  /api/price-update-diag              are the Python job's files present in the image
 *   POST /api/trigger-price-update           run the daily gold-rate reprice
 *   GET+POST /api/backfill-installments      derive installment legs on historical documents
 *   POST /api/backfill-draft-tags            re-apply payment tags to drafts
 *   POST /api/backfill-order-metafields      freeze reproducible values onto old orders
 *   POST /api/backfill-order-tags            re-apply payment tags to orders
 *   GET+POST /api/metafield-definitions/ensure  create missing custom.* definitions
 *
 * THE PRICE-UPDATE LOCK
 * The reprice spawns a long-running Python process and must never run twice concurrently — two
 * passes would write different gold rates onto the same variants. It is guarded two ways: an
 * in-memory boolean, and a lock file at /app/Outputs/price_update.running that survives within a
 * container's life. A deploy kills the process without clearing the file, so a stale lock would
 * block every subsequent run — hence clearStalePriceUpdateFlag() at boot.
 *
 * EXIT POINTS
 *   src/jobs/price-update/orchestrator.py   spawned as a child process
 *   modules/payments/backfill-installments  leg derivation
 *   core/shopify, core/supabase, core/metafields
 *
 * ctx.applyPaymentTagsToOrder / ctx.applyPaymentTagsToDraftOrder — TEMPORARY COUPLING. The tag
 * backfills replay the same logic the live payment path uses, and that still lives in server.js.
 * Injected through ctx so this module never requires the bootstrap; becomes a normal require once
 * payments is extracted.
 */

const fs    = require('fs');
const axios = require('axios');

const { config }   = require('../../core/config');
const { supabase } = require('../../core/supabase');
const { getShopifyToken, graphql, primeBuyingRateTable } = require('../../core/shopify');
const { log } = require('../../core/logger');

const backfillInstallments = require('../payments/backfill-installments');
// buildInstallmentMfDefs loops to MAX_INSTALLMENTS. It read the bare name — in scope while this
// lived in server.js, a free variable once it moved — so /api/metafield-definitions/ensure threw
// the moment it was called. It is exported by the payments module; take it from there.
const { MAX_INSTALLMENTS } = require('../payments/installments');

let _priceUpdateRunning = false;
const PRICE_UPDATE_FLAG = '/app/Outputs/price_update.running';

/**
 * Clear a lock left behind by a deploy that killed a running reprice.
 * Called once from the bootstrap; without it the next run refuses to start.
 */
function clearStalePriceUpdateFlag() {
  try {
    if (fs.existsSync(PRICE_UPDATE_FLAG)) {
      fs.unlinkSync(PRICE_UPDATE_FLAG);
      log.warn('admin', 'stale price-update flag cleared — a previous run was interrupted. Re-trigger to resume.');
    }
  } catch (_) { /* best effort: a missing /app/Outputs is not an error */ }
}

function register(app, ctx) {
  const { applyPaymentTagsToOrder, applyPaymentTagsToDraftOrder, copyDraftMetafieldsToOrder } = ctx;


// ─────────────────────────────────────────
// Price Update Diagnostics
// ─────────────────────────────────────────

app.get('/api/price-update-diag', (req, res) => {
  const { execFile } = require('child_process');
  const script = [
    'import sys, os',
    'print("python:", sys.version)',
    'import requests; print("requests: OK")',
    'import resend; print("resend: OK")',
    'from pathlib import Path',
    'print("orchestrator:", Path("/app/src/jobs/price-update/orchestrator.py").exists())',
    'print("snapshot:", Path("/app/src/jobs/price-update/shopify_snapshot.py").exists())',
    'print("importer:", Path("/app/src/jobs/price-update/import_from_preview.mjs").exists())',
    'print("SUPABASE_KEY set:", bool(os.environ.get("SUPABASE_SERVICE_KEY")))',
    'print("RESEND_API_KEY set:", bool(os.environ.get("RESEND_API_KEY")))',
    'print("FROM_EMAIL set:", bool(os.environ.get("FROM_EMAIL")))',
  ].join('\n');

  execFile('python3', ['-c', script], { timeout: 10000 }, (err, stdout, stderr) => {
    res.json({
      ok:     !err,
      stdout: stdout || '',
      stderr: stderr || '',
      error:  err ? err.message : null,
    });
  });
});

// ─────────────────────────────────────────
// Price Update Trigger
// ─────────────────────────────────────────



// Spawn the daily reprice.
//
// Every failure mode here used to take the whole web process down with it, which is how the
// job could fail for days without anyone knowing. There was no 'error' listener on the child
// and no try/catch around spawn(), so a failed spawn either threw synchronously — rejecting
// this route's promise, which Express 4 does not catch, so Node killed the process — or
// emitted an unhandled 'error' event, which EventEmitter rethrows. Either way: no HTTP
// response (the caller sees a 502), no log anyone reads, no alert, and the machine restarts.
// Observed as a 502 in ~1.3s on 2026-08-15, identically for a full run and for a single-product
// test run, which is what proved it was the spawn and not the workload.
//
// It also set _priceUpdateRunning and wrote the lock file BEFORE spawning, so a crash left a
// stale lock claiming a run was in progress. Both are now cleared on every failure path.
function _spawnPriceUpdate(extraArgs = []) {
  const { spawn } = require('child_process');
  const fs = require('fs');

  const release = () => {
    _priceUpdateRunning = false;
    try { fs.unlinkSync(PRICE_UPDATE_FLAG); } catch (_) {}
  };

  _priceUpdateRunning = true;
  try { fs.writeFileSync(PRICE_UPDATE_FLAG, String(process.pid)); } catch (_) {}

  let proc;
  try {
    proc = spawn('python3', ['/app/src/jobs/price-update/orchestrator.py', ...extraArgs], {
      detached: false,
      stdio:    ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // Synchronous throw from spawn itself. Report it to the caller instead of dying.
    release();
    console.error('[price-update] spawn threw:', err.message);
    err.spawnFailed = true;
    throw err;
  }

  // Asynchronous spawn failure (ENOENT, EACCES, EAGAIN...). Without this listener Node
  // rethrows it as an uncaught exception and the process exits.
  proc.on('error', err => {
    release();
    console.error(`[price-update] child process error: ${err.code || ''} ${err.message}`);
  });

  proc.stdout.on('data', d => console.log(`[price-update] ${d.toString().trim()}`));
  proc.stderr.on('data', d => console.error(`[price-update ERR] ${d.toString().trim()}`));
  proc.on('close', (code, signal) => {
    release();
    // A signal here means the run was killed rather than finishing — the silent failure mode
    // from 2026-07-22, where SIGKILL skipped Python's except block so no FATAL email went out.
    console.log(signal
      ? `[price-update] KILLED by ${signal} — run did NOT complete, no report email will arrive`
      : `[price-update] exited with code ${code}`);
  });
  return proc;
}

app.post('/api/trigger-price-update', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!process.env.PRICE_UPDATE_WEBHOOK_SECRET || secret !== process.env.PRICE_UPDATE_WEBHOOK_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  if (_priceUpdateRunning) {
    console.warn('Price update already running — duplicate trigger ignored');
    return res.status(409).json({ success: false, error: 'A price update is already running. Wait for it to finish.' });
  }

  const pure = parseFloat(req.body.pure_rate);
  if (isNaN(pure) || pure < 1000 || pure > 200000) {
    return res.status(400).json({ success: false, error: 'pure_rate must be between 1000 and 200000' });
  }

  // Calculation mode: 'manual' uses the entered 18K/14K rates verbatim; anything
  // else (default 'auto') derives 18K/14K from pure. 22K/24K always derive from pure.
  const calcMode  = String(req.body.calc_mode || req.body.mode || 'auto').trim().toLowerCase() === 'manual' ? 'manual' : 'auto';
  const manual18k = parseFloat(req.body.r18k);
  const manual14k = parseFloat(req.body.r14k);
  if (calcMode === 'manual') {
    if (isNaN(manual18k) || isNaN(manual14k)) {
      return res.status(400).json({ success: false, error: 'manual mode requires numeric r18k and r14k' });
    }
    // Sanity guard: reject manual rates that deviate more than ±10% from what
    // auto would compute from pure — catches typos / wrong-karat entries.
    const auto18k = pure * 0.771;
    const auto14k = pure * 0.604;
    const dev18   = Math.abs(manual18k - auto18k) / auto18k;
    const dev14   = Math.abs(manual14k - auto14k) / auto14k;
    if (dev18 > 0.10 || dev14 > 0.10) {
      return res.status(400).json({
        success: false,
        error: `manual rate out of ±10% range vs auto. ` +
               `18K entered ${manual18k.toFixed(2)} (auto ${auto18k.toFixed(2)}, ${(dev18 * 100).toFixed(1)}% off); ` +
               `14K entered ${manual14k.toFixed(2)} (auto ${auto14k.toFixed(2)}, ${(dev14 * 100).toFixed(1)}% off)`,
      });
    }
  }

  const setAt    = new Date().toISOString();
  const rateBlob = { pure, mode: calcMode, set_at: setAt };
  if (calcMode === 'manual') {
    rateBlob.r18k = manual18k;
    rateBlob.r14k = manual14k;
  }
  const payload = JSON.stringify(rateBlob);

  const { error: dbErr } = await supabase.from('config').upsert({
    key:        'gold_rate',
    value:      payload,
    updated_at: setAt,
  });

  if (dbErr) {
    console.error('Price update trigger: Supabase write failed:', dbErr.message);
    return res.status(500).json({ success: false, error: 'Failed to save gold rate to Supabase' });
  }

  // Build & store the old-gold buying rate table (9..24kt), derived from pure with a 5% haircut.
  const BUYING_HAIRCUT = 0.05;
  const buyingRates = {};
  for (let k = 9; k <= 24; k++) buyingRates[k] = +((k / 24) * pure * (1 - BUYING_HAIRCUT)).toFixed(2);
  const buyingBlob = JSON.stringify({ base_24k: pure, haircut_pct: 5, set_at: setAt, rates: buyingRates });
  const { error: buyErr } = await supabase.from('config').upsert({
    key: 'buying_rate_table', value: buyingBlob, updated_at: setAt,
  });
  if (buyErr) {
    console.error('Price update trigger: buying table write failed:', buyErr.message);
  } else {
    primeBuyingRateTable(JSON.parse(buyingBlob));
  }

  const testGati = (req.body.test_gati || '').toString().trim().toUpperCase();
  const extraArgs = testGati ? ['--test', testGati] : [];
  const proc = _spawnPriceUpdate(extraArgs);

  const rate18k = calcMode === 'manual' ? manual18k.toFixed(2) : (pure * 0.771).toFixed(2);
  const rate14k = calcMode === 'manual' ? manual14k.toFixed(2) : (pure * 0.604).toFixed(2);
  const runMode = testGati ? `TEST (${testGati})` : 'FULL RUN';
  console.log(`Price update triggered [${runMode}] [${calcMode}] — pure Rs${pure}/g | 18K Rs${rate18k} | 14K Rs${rate14k} | PID ${proc.pid}`);

  return res.json({
    success:    true,
    message:    'Gold rate saved. Price update started — results emailed when complete.',
    pure_rate:  pure,
    rate_18k:   parseFloat(rate18k),
    rate_14k:   parseFloat(rate14k),
    calc_mode:  calcMode,
    set_at:     setAt,
    mode:       testGati ? `test:${testGati}` : 'full',
  });
});

// ─────────────────────────────────────────
// Backfill endpoints
// ─────────────────────────────────────────

// GET/POST /api/backfill-installments
// Populates installment legs on documents that predate the installment model.
//   scope=drafts (default) — replays store_deposit_payments, the real per-leg audit trail
//   scope=orders           — synthesizes from the two-slot pair; needs ?orderIds=1,2,3
// DRY RUN BY DEFAULT — pass apply=true to write. Idempotent: documents that already have a leg are
// skipped, and a draft whose audit rows disagree with its recorded amount_paid is reported as
// 'drift' and left alone rather than silently overwritten.
async function runBackfillInstallments(req, res) {
  try {
    const p = { ...(req.query || {}), ...(req.body || {}) };
    const apply = (p.apply === 'true' || p.apply === true);
    const scope = String(p.scope || 'drafts').toLowerCase();
    const split = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
    const deps = { axios, storeUrl: process.env.SHOPIFY_STORE_URL, token: await getShopifyToken(), supabase };

    const results = scope === 'orders'
      ? await backfillInstallments.backfillOrders(deps, { apply, orderIds: split(p.orderIds) })
      : await backfillInstallments.backfillDrafts(deps, {
          apply,
          draftIds: split(p.draftIds).length ? split(p.draftIds) : null,
          limit: parseInt(p.limit, 10) || 500,
        });

    const tally = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
    return res.json({ success: true, dryRun: !apply, scope, tally, results });
  } catch (err) {
    console.error('backfill-installments error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
app.get('/api/backfill-installments', runBackfillInstallments);
app.post('/api/backfill-installments', runBackfillInstallments);

// POST /api/backfill-draft-tags
// Reads metafields from draft orders and writes payment tags.
// Body: { nameFrom: 1038, nameTo: 1053 } for a name range, or {} for all open+invoice_sent.
app.post('/api/backfill-draft-tags', async (req, res) => {
  try {
    const token   = await getShopifyToken();
    const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

    if (req.body.nameFrom !== undefined || req.body.nameTo !== undefined) {
      const from = parseInt(req.body.nameFrom);
      const to   = parseInt(req.body.nameTo);
      if (isNaN(from) || isNaN(to) || from > to) {
        return res.status(400).json({ success: false, error: 'nameFrom and nameTo must be valid integers with nameFrom <= nameTo' });
      }
      let processed = 0, tagged = 0, errors = 0;
      for (let n = from; n <= to; n++) {
        try {
          // Shopify has no status=any for draft orders — search open then invoice_sent
          let draft = null;
          for (const s of ['open', 'invoice_sent']) {
            const { data } = await axios.get(
              `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders.json?name=%23${n}&status=${s}`,
              { headers, timeout: 10000 }
            );
            draft = (data.draft_orders || [])[0];
            if (draft) break;
          }
          if (!draft) { console.log(`backfill-draft-tags: draft #${n} not found`); continue; }
          const ok = await applyPaymentTagsToDraftOrder(draft.id.toString(), token);
          if (ok) tagged++;
          processed++;
        } catch (err) {
          console.error(`backfill-draft-tags: #${n} failed:`, err.message);
          errors++;
        }
      }
      return res.json({ success: true, processed, tagged, errors });
    }

    // Batch — open + invoice_sent
    let processed = 0, tagged = 0, errors = 0;
    for (const status of ['open', 'invoice_sent']) {
      let pageUrl = `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders.json?status=${status}&limit=250`;
      while (pageUrl) {
        const { data, headers: respHeaders } = await axios.get(pageUrl, { headers, timeout: 30000 });
        for (const d of (data.draft_orders || [])) {
          try {
            const ok = await applyPaymentTagsToDraftOrder(d.id.toString(), token);
            if (ok) tagged++;
            processed++;
          } catch (err) {
            console.error(`backfill-draft-tags: draft ${d.id} failed:`, err.message);
            errors++;
          }
        }
        const link = respHeaders['link'] || '';
        const next = link.match(/<([^>]+)>;\s*rel="next"/);
        pageUrl = next ? next[1] : null;
      }
    }
    return res.json({ success: true, processed, tagged, errors });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/backfill-order-metafields
// Fetches completed draft orders (paginated) and copies their custom metafields to the
// resulting order. Body: { draftOrderId, orderId } for a single pair, or {} for all.
app.post('/api/backfill-order-metafields', async (req, res) => {
  try {
    const token = await getShopifyToken();

    if (req.body.draftOrderId && req.body.orderId) {
      const copied = await copyDraftMetafieldsToOrder(
        req.body.draftOrderId.toString(), req.body.orderId.toString(), token
      );
      return res.json({ success: true, processed: 1, copied });
    }

    // Batch mode — walk all completed draft orders
    const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
    let pageUrl = `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/draft_orders.json?status=completed&limit=250`;
    let processed = 0, totalCopied = 0, errors = 0;

    while (pageUrl) {
      const { data, headers: respHeaders } = await axios.get(pageUrl, { headers, timeout: 30000 });
      for (const d of (data.draft_orders || [])) {
        if (!d.order_id) continue;
        try {
          const copied = await copyDraftMetafieldsToOrder(d.id.toString(), d.order_id.toString(), token);
          totalCopied += copied;
          processed++;
        } catch (err) {
          console.error(`backfill-order-metafields: draft ${d.id} → order ${d.order_id} failed:`, err.message);
          errors++;
        }
      }
      const link = respHeaders['link'] || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      pageUrl = next ? next[1] : null;
    }

    return res.json({ success: true, processed, totalCopied, errors });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/backfill-order-tags
// Reads custom payment metafields from an order (or recent orders) and writes payment tags.
// Body: { orderId } for one order, or {} to process all orders with payment metafields.
app.post('/api/backfill-order-tags', async (req, res) => {
  try {
    const token   = await getShopifyToken();
    const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

    // Single numeric order ID
    if (req.body.orderId) {
      const tagged = await applyPaymentTagsToOrder(req.body.orderId.toString(), token);
      return res.json({ success: true, tagged });
    }

    // Order name range: { nameFrom: 1038, nameTo: 1053 }
    if (req.body.nameFrom !== undefined || req.body.nameTo !== undefined) {
      const from = parseInt(req.body.nameFrom);
      const to   = parseInt(req.body.nameTo);
      if (isNaN(from) || isNaN(to) || from > to) {
        return res.status(400).json({ success: false, error: 'nameFrom and nameTo must be valid integers with nameFrom <= nameTo' });
      }
      let processed = 0, tagged = 0, errors = 0;
      for (let n = from; n <= to; n++) {
        try {
          const { data } = await axios.get(
            `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders.json?name=%23${n}&status=any`,
            { headers, timeout: 10000 }
          );
          const order = (data.orders || [])[0];
          if (!order) { console.log(`backfill-order-tags: order #${n} not found`); continue; }
          const ok = await applyPaymentTagsToOrder(order.id.toString(), token);
          if (ok) tagged++;
          processed++;
        } catch (err) {
          console.error(`backfill-order-tags: #${n} failed:`, err.message);
          errors++;
        }
      }
      return res.json({ success: true, processed, tagged, errors });
    }

    // Batch mode — walk all orders
    let pageUrl = `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/orders.json?status=any&limit=250`;
    let processed = 0, tagged = 0, errors = 0;

    while (pageUrl) {
      const { data, headers: respHeaders } = await axios.get(pageUrl, { headers, timeout: 30000 });
      for (const order of (data.orders || [])) {
        try {
          const ok = await applyPaymentTagsToOrder(order.id.toString(), token);
          if (ok) tagged++;
          processed++;
        } catch (err) {
          console.error(`backfill-order-tags: order ${order.id} failed:`, err.message);
          errors++;
        }
      }
      const link = respHeaders['link'] || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      pageUrl = next ? next[1] : null;
    }

    return res.json({ success: true, processed, tagged, errors });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// GET/POST /api/metafield-definitions/ensure
// Creates the Shopify metafield DEFINITIONS this repo depends on, idempotently. Writing a
// metafield does not require a definition — but without one the field is invisible in Shopify's
// own Settings → Custom data UI, isn't filterable, isn't available to Flow, and (the reason that
// bites here) the admin extension renders it as a free-text box instead of a typed widget.
// Re-runnable: an existing definition returns userError code TAKEN, reported as 'exists'.
// DRY RUN BY DEFAULT — pass ?apply=true to actually create.
// ?group=adjustments|installments|all (default all) scopes the run.
// ─────────────────────────────────────────
// Gross weight recorded at repair intake, with the customer present. Distinct from
// custom.gross_weight_g, which the Mark Complete form writes AFTER the repair — the two are
// different measurements of the same piece at opposite ends of the job, and the whole point of
// keeping both is being able to show they match. number_decimal so it sorts and validates as a
// weight rather than as free text.
//
// The extension resolves namespace and type from the LIVE definition at save time, so without
// this the field renders in the Repair section and then fails silently on save.
const REPAIR_MF_DEFS = [
  { key: 'repair_intake_gross_weight', name: 'Repair — Gross Weight at Intake (g)', type: 'number_decimal',
    description: 'Gross weight of the piece when taken in for repair, recorded in the presence of the customer. The number any later weight dispute is settled against.' },
];

const ADJUSTMENT_MF_DEFS = [
  { key: 'exchange_note_code', name: 'Exchange Note Applied', type: 'single_line_text_field', description: 'Serial code of the exchange note applied to this order (e.g. EXC27-KAHSR-0001).' },
  { key: 'voucher_code',       name: 'Voucher Applied',       type: 'single_line_text_field', description: 'Serial code of the voucher applied to this order (e.g. VCH27-KAHSR-0001).' },
];

// Mode list used only when the live custom.payment_mode_advance definition carries no choices
// validation. Mirrors the live enum as of 2026-08-07, plus the modes this server writes itself.
// Note 'bank transfer' has a space where 'online_link' has an underscore — both are real, do NOT
// normalise, existing records depend on the exact strings.
const PAYMENT_MODE_FALLBACK = ['cash', 'upi', 'card', 'online_link', 'bank transfer', 'pos'];

// Reads the authoritative payment-mode enum off the existing payment_mode_advance definition so
// the installment mode dropdowns offer exactly the same values as the field they replace.
// Returns null when the definition is absent or carries no choices validation.
async function fetchPaymentModeChoices(token) {
  const QUERY = `query {
    metafieldDefinitions(first: 1, ownerType: DRAFTORDER, namespace: "custom", key: "payment_mode_advance") {
      nodes { validations { name value } }
    }
  }`;
  try {
    const { data } = await axios.post(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/graphql.json`,
      { query: QUERY },
      { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 15000 });
    const v = (data?.data?.metafieldDefinitions?.nodes?.[0]?.validations || []).find(x => x.name === 'choices');
    if (!v?.value) return null;
    const parsed = JSON.parse(v.value);
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch (e) {
    console.error('fetchPaymentModeChoices failed:', e.message);
    return null;
  }
}

// Definitions for the installment legs. MAX_INSTALLMENTS and the readers live up with the payment
// helpers; this only describes the Shopify-side definitions.
function buildInstallmentMfDefs(modeChoices) {
  const choices = (list) => [{ name: 'choices', value: JSON.stringify(list) }];
  const defs = [];
  for (let n = 1; n <= MAX_INSTALLMENTS; n++) {
    defs.push({ key: `installment_${n}_value`, name: `Installment ${n} — Value`, type: 'number_decimal',
      description: `Amount received in installment ${n}. amount_paid is the sum of all installment values.` });
    defs.push({ key: `installment_${n}_mode`, name: `Installment ${n} — Mode`, type: 'single_line_text_field',
      description: `Payment mode used for installment ${n}.`, validations: choices(modeChoices) });
    defs.push({ key: `installment_${n}_date`, name: `Installment ${n} — Date`, type: 'date',
      description: `Date installment ${n} was received. Stamped when the payment lands; editable so a late-recorded payment can be corrected (this date prints on the customer invoice).` });
  }
  // Only slot 1 can hold a CAD design advance (it absorbs the FIRST payment), so one flag suffices.
  // cad_advance rows render as "Design Advance" and are excluded from amount_paid — custom.advance
  // already reduces amount_to_be_collected, so counting it again would deduct it twice.
  defs.push({ key: 'installment_1_type', name: 'Installment 1 — Type', type: 'single_line_text_field',
    description: 'payment (default) or cad_advance. cad_advance means installment 1 mirrors custom.advance for display only and is excluded from amount_paid.',
    validations: choices(['payment', 'cad_advance']) });
  return defs;
}

async function runEnsureMetafieldDefinitions(req, res) {
  const p = { ...(req.query || {}), ...(req.body || {}) };
  const apply = (p.apply === 'true' || p.apply === true);
  const group = String(p.group || 'all').toLowerCase();
  const owners = ['DRAFTORDER', 'ORDER'];
  let token = null;
  try {
    token = await getShopifyToken();
  } catch (err) {
    console.error('metafield-definitions/ensure token error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }

  // Read the live enum even on a dry run, so the response shows exactly what would be created.
  let modeChoices = PAYMENT_MODE_FALLBACK;
  let modeChoicesSource = 'fallback';
  if (group !== 'adjustments') {
    const live = await fetchPaymentModeChoices(token);
    if (live) { modeChoices = live; modeChoicesSource = 'live:custom.payment_mode_advance'; }
    // A choices validation is enforced ON WRITE, so the enum must cover every mode this server can
    // emit or that payment silently fails to record a leg. 'pos' is the fallback when a transaction
    // carries no mode of its own and is not in the staff-facing list. Union rather than replace —
    // never narrow an enum below what the writer emits.
    const serverWrites = ['pos'];
    const missing = serverWrites.filter(m => !modeChoices.includes(m));
    if (missing.length) {
      modeChoices = modeChoices.concat(missing);
      modeChoicesSource += ` + server-written [${missing.join(', ')}]`;
    }
  }

  const defs = [];
  if (group === 'all' || group === 'adjustments')  defs.push(...ADJUSTMENT_MF_DEFS);
  if (group === 'all' || group === 'installments') defs.push(...buildInstallmentMfDefs(modeChoices));
  if (group === 'all' || group === 'repair')       defs.push(...REPAIR_MF_DEFS);

  const planned = [];
  for (const d of defs) for (const ownerType of owners) planned.push({ ...d, ownerType, namespace: 'custom' });
  if (!apply) {
    return res.json({ success: true, dryRun: true, group, modeChoices, modeChoicesSource,
      count: planned.length, wouldCreate: planned,
      hint: 'Re-run with ?apply=true to create these definitions.' });
  }
  try {
    const MUTATION = `mutation($def: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $def) {
        createdDefinition { id key namespace ownerType }
        userErrors { field message code }
      }
    }`;
    const results = [];
    for (const def of planned) {
      try {
        const { data } = await axios.post(
          `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01/graphql.json`,
          { query: MUTATION, variables: { def: {
              name: def.name, namespace: def.namespace, key: def.key,
              type: def.type, ownerType: def.ownerType, description: def.description,
              ...(def.validations ? { validations: def.validations } : {}) } } },
          { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, timeout: 15000 });
        const payload = data?.data?.metafieldDefinitionCreate;
        const errs = payload?.userErrors || [];
        if (errs.length) {
          // TAKEN = a definition for this namespace/key/owner already exists. Not an error for us.
          const taken = errs.some(e => e.code === 'TAKEN');
          results.push({ key: def.key, ownerType: def.ownerType, status: taken ? 'exists' : 'error',
                         errors: taken ? undefined : errs });
        } else {
          results.push({ key: def.key, ownerType: def.ownerType, status: 'created', id: payload?.createdDefinition?.id });
        }
      } catch (e) {
        results.push({ key: def.key, ownerType: def.ownerType, status: 'error', errors: [{ message: e.message }] });
      }
    }
    const failed = results.filter(r => r.status === 'error');
    return res.status(failed.length ? 207 : 200).json({
      success: !failed.length, group, modeChoices, modeChoicesSource,
      created: results.filter(r => r.status === 'created').length,
      exists:  results.filter(r => r.status === 'exists').length,
      results });
  } catch (err) {
    console.error('metafield-definitions/ensure error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
app.get('/api/metafield-definitions/ensure', runEnsureMetafieldDefinitions);
app.post('/api/metafield-definitions/ensure', runEnsureMetafieldDefinitions);

}

module.exports = { register, clearStalePriceUpdateFlag };
