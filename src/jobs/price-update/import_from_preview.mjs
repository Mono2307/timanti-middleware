/**
 * import_from_preview.mjs
 * =======================
 * Reads PREVIEW_VARIANT_IMPORT_*_v2.csv and writes to Shopify.
 *
 * Price update  : productVariantsBulkUpdate — price ONLY, grouped by product.
 *                 DO NOT include weight in this mutation — Shopify silently
 *                 drops the entire call with no error if unsupported fields appear.
 * Metafields    : metafieldsSet — 6 dynamic fields per variant (gold + gst + totals + rate + timestamp).
 * Archived skip : variants whose parent product is ARCHIVED are skipped.
 *                 DRAFT and ACTIVE are both written.
 * Resume        : RESUME = true skips variant IDs already in progress log.
 */

import fs from 'fs';
import { createReadStream } from 'fs';
import { parse } from 'csv-parse';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../.env') });

// ── CLI args ──────────────────────────────────────────────────────────────────
// --input  <path>  Override the input CSV (used by daily orchestrator)
// --no-resume      Force a fresh run, ignoring any existing progress log

const _args     = process.argv.slice(2);
const _inputIdx = _args.indexOf('--input');

// ── Config ────────────────────────────────────────────────────────────────────

const INPUT_CSV = _inputIdx !== -1
  ? resolve(_args[_inputIdx + 1])
  : resolve(__dirname, '../Outputs/PREVIEW_VARIANT_IMPORT_20260421_v2.csv');

const RESUME = !_args.includes('--no-resume');

// Progress and error logs are scoped to the input file so daily runs never
// collide with manual runs or each other.
const _stem      = basename(INPUT_CSV, '.csv');
const OUTPUTS_DIR  = process.env.OUTPUTS_DIR || resolve(__dirname, '../Outputs');
const ERROR_LOG    = resolve(OUTPUTS_DIR, `import_preview_errors_${_stem}.json`);
const PROGRESS_LOG = resolve(OUTPUTS_DIR, `import_preview_progress_${_stem}.json`);
const SKIPPED_LOG  = resolve(OUTPUTS_DIR, `import_preview_skipped_${_stem}.json`);

const STORE_DOMAIN    = (process.env.STORE_DOMAIN    || '').trim();
const ADMIN_API_TOKEN = (process.env.ADMIN_API_TOKEN || '').trim();
const GRAPHQL_URL     = `https://${STORE_DOMAIN}/admin/api/2024-10/graphql.json`;

const MAX_RETRIES      = 6;
const THROTTLE_WAIT_MS = 2000;
const PRICE_BATCH_SIZE = 50;   // max variants per productVariantsBulkUpdate call

// ── GraphQL ───────────────────────────────────────────────────────────────────

async function gql(query, variables, attempt = 0) {
  let json;
  try {
    const res = await fetch(GRAPHQL_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': ADMIN_API_TOKEN },
      body:    JSON.stringify({ query, variables }),
    });
    json = await res.json();
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      const wait = 3000 * (attempt + 1);
      console.log(`  Network error (${err.message}) — retry ${attempt + 1} in ${wait}ms...`);
      await new Promise(r => setTimeout(r, wait));
      return gql(query, variables, attempt + 1);
    }
    throw err;
  }

  const errorsArr = Array.isArray(json?.errors) ? json.errors : [];
  const throttled = (json?.extensions?.cost?.throttleStatus?.currentlyAvailable === 0)
    || errorsArr.some(e => e?.extensions?.code === 'THROTTLED');

  if (throttled && attempt < MAX_RETRIES) {
    const wait = THROTTLE_WAIT_MS * (attempt + 1);
    console.log(`  Throttled — waiting ${wait}ms...`);
    await new Promise(r => setTimeout(r, wait));
    return gql(query, variables, attempt + 1);
  }

  return json;
}

// ── Product status cache ──────────────────────────────────────────────────────
// Cache strategy: one API call per product (~350), not per variant (~15,876).
// First query for any variant fetches ALL variant IDs on that product and
// pre-fills the cache for every sibling — so 14K and 18K variants under the
// same product share a single status lookup.

const variantToProduct = new Map();  // variantId → { productId, status }

const Q_VARIANT_PRODUCT = `
  query($id: ID!) {
    node(id: $id) {
      ... on ProductVariant {
        product {
          id status
          variants(first: 250) {
            nodes { id }
          }
        }
      }
    }
  }`;

async function getProduct(variantId) {
  if (variantToProduct.has(variantId)) return variantToProduct.get(variantId);
  const res     = await gql(Q_VARIANT_PRODUCT, { id: variantId });
  const product = res?.data?.node?.product;
  if (!product) {
    const result = { productId: null, status: 'UNKNOWN' };
    variantToProduct.set(variantId, result);
    return result;
  }
  const result = { productId: product.id, status: product.status };
  // pre-fill every sibling variant — all share the same productId + status
  for (const v of product.variants?.nodes || []) {
    variantToProduct.set(v.id, result);
  }
  return result;
}

// ── Mutations ─────────────────────────────────────────────────────────────────

// Price update — price ONLY in this mutation (weight silently breaks it)
const M_BULK_PRICE = `
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price }
      userErrors { field message code }
    }
  }`;

const M_METAFIELDS = `
  mutation metafieldsSet($m: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $m) {
      userErrors { field message }
    }
  }`;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Only fields that change with every gold rate update.
// Static fields (weights, diamond, making) are written once at product creation
// by the Generate/Update scripts — no need to rewrite them daily.
const METAFIELD_COLS = [
  'mf_price_breakup_gold',
  'mf_price_breakup_gst',
  'mf_price_total',
  'mf_price_subtotal',
  'mf_gold_rate',
  'mf_gold_last_updated_at',
];
const MF_KEY = {
  mf_price_breakup_gold:    'price_breakup_gold',
  mf_price_breakup_gst:     'price_breakup_gst',
  mf_price_total:           'price_total',
  mf_price_subtotal:        'price_subtotal',
  mf_gold_rate:             'gold_rate',
  mf_gold_last_updated_at:  'gold_last_updated_at',
};
// Fields that are not number_decimal — key is the CSV column name
const MF_TYPE = {
  mf_gold_last_updated_at: 'date_time',
};

function cleanNum(raw) {
  if (!raw || raw === 'nan' || raw === 'NaN' || raw === '') return null;
  const n = parseFloat(String(raw).trim());
  return isNaN(n) ? null : String(n);
}

async function markDone(variantId) {
  const line = JSON.stringify({ id: variantId, ts: new Date().toISOString() }) + '\n';
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      fs.appendFileSync(PROGRESS_LOG, line);
      return;
    } catch (err) {
      if (err.code !== 'EBUSY' || attempt >= 7) throw err;
      // OneDrive locking the file — wait and retry
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
  }
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_LOG)) return new Set();
  const lines = fs.readFileSync(PROGRESS_LOG, 'utf8').trim().split('\n').filter(Boolean);
  const done  = new Set();
  for (const line of lines) {
    try { done.add(JSON.parse(line).id); } catch {}
  }
  return done;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  if (!STORE_DOMAIN || !ADMIN_API_TOKEN) {
    console.error('Missing STORE_DOMAIN or ADMIN_API_TOKEN in .env');
    process.exit(1);
  }

  console.log('='.repeat(80));
  console.log('IMPORT FROM PREVIEW CSV');
  console.log('  Price : productVariantsBulkUpdate (price-only, grouped by product)');
  console.log('  MF    : metafieldsSet (8 fields per variant)');
  console.log('  Skip  : ARCHIVED products only');
  console.log('='.repeat(80));
  console.log(`Store  : ${STORE_DOMAIN}`);
  console.log(`Input  : ${INPUT_CSV}`);
  console.log(`Resume : ${RESUME}`);
  console.log();

  const doneIds = RESUME ? loadProgress() : new Set();
  if (RESUME && doneIds.size > 0) console.log(`Resuming — ${doneIds.size} variants already done\n`);

  // Load CSV
  const allRows = [];
  await new Promise((res, rej) => {
    createReadStream(INPUT_CSV)
      .pipe(parse({ columns: true, trim: true }))
      .on('data', r => allRows.push(r))
      .on('end', res).on('error', rej);
  });
  console.log(`Loaded ${allRows.length} rows from CSV`);

  const toProcess = RESUME ? allRows.filter(r => !doneIds.has(r.shopify_variant_id)) : allRows;
  console.log(`To process this run: ${toProcess.length}`);
  console.log();

  // ── Phase 1: Check product status, group active rows by productId ──────────
  console.log('Phase 1 — checking product status for each variant...');
  const byProduct = new Map();   // productId → [{ row, variantId }]
  const skipped   = [];
  let statusChecked = 0;

  for (const row of toProcess) {
    statusChecked++;
    if (statusChecked % 500 === 0) console.log(`  Status checked: ${statusChecked}/${toProcess.length}`);

    const variantId        = row.shopify_variant_id;
    const { productId, status } = await getProduct(variantId);

    if (status === 'ARCHIVED') {
      skipped.push({ variantId, sku: row.shopify_sku, productId });
      await markDone(variantId);
      continue;
    }

    if (!byProduct.has(productId)) byProduct.set(productId, []);
    byProduct.get(productId).push({ row, variantId });
  }

  console.log(`  Done — ${byProduct.size} active product(s), ${skipped.length} archived skipped\n`);

  // ── Phase 2: Bulk price update per product ────────────────────────────────
  console.log('Phase 2 — bulk price update by product...');
  const errors = [];
  let productsDone = 0;

  for (const [productId, entries] of byProduct) {
    productsDone++;
    if (productsDone % 25 === 1) {
      console.log(`\n  Product ${productsDone}/${byProduct.size}  id: ${productId.split('/').pop()}  (${entries.length} variants)`);
    }

    // Build price payload — price ONLY
    const pricePayload = entries
      .map(({ row, variantId }) => {
        const price = cleanNum(row.mf_price_total) ?? cleanNum(row.price_to_write);
        return price !== null ? { id: variantId, price } : null;
      })
      .filter(Boolean);

    // Send in batches of PRICE_BATCH_SIZE
    for (let i = 0; i < pricePayload.length; i += PRICE_BATCH_SIZE) {
      const batch    = pricePayload.slice(i, i + PRICE_BATCH_SIZE);
      const bulkRes  = await gql(M_BULK_PRICE, { productId, variants: batch });
      const bulkErrs = bulkRes?.data?.productVariantsBulkUpdate?.userErrors || [];
      const topErrs  = bulkRes?.errors || [];
      if (bulkErrs.length > 0 || topErrs.length > 0) {
        const msg = bulkErrs[0]?.message || topErrs[0]?.message || 'unknown';
        console.error(`  ERR bulk price product ${productId.split('/').pop()}: ${msg}`);
        errors.push({ productId, stage: 'bulkPrice', message: msg });
      }
    }
  }

  // ── Phase 3: Metafields per variant ──────────────────────────────────────
  console.log('\nPhase 3 — writing metafields per variant...');
  let mfDone = 0;

  for (const [, entries] of byProduct) {
    for (const { row, variantId } of entries) {
      mfDone++;
      if (mfDone % 500 === 0) console.log(`  Metafields written: ${mfDone}`);

      const metafields = [];
      for (const col of METAFIELD_COLS) {
        const type = MF_TYPE[col] || 'number_decimal';
        const val  = type === 'date_time'
          ? (row[col] && row[col].trim() ? row[col].trim() : null)
          : cleanNum(row[col]);
        if (val !== null) {
          metafields.push({ ownerId: variantId, namespace: 'custom', key: MF_KEY[col], type, value: val });
        }
      }

      if (metafields.length > 0) {
        const mRes    = await gql(M_METAFIELDS, { m: metafields });
        const mErrors = mRes?.data?.metafieldsSet?.userErrors || [];
        if (mErrors.length > 0) {
          console.error(`  ERR metafields ${row.shopify_sku}: ${mErrors[0].message}`);
          errors.push({ variantId, sku: row.shopify_sku, stage: 'metafields', message: mErrors[0].message });
        }
      }

      await markDone(variantId);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const totalWritten = [...byProduct.values()].reduce((s, e) => s + e.length, 0);

  console.log('\n' + '='.repeat(80));
  console.log('DONE');
  console.log(`  Variants written         : ${totalWritten}`);
  console.log(`  Skipped (ARCHIVED)       : ${skipped.length}`);
  console.log(`  Errors                   : ${errors.length}`);

  if (skipped.length > 0) {
    fs.writeFileSync(SKIPPED_LOG, JSON.stringify(skipped, null, 2));
    console.log(`  Skipped log              : ${SKIPPED_LOG}`);
  }
  if (errors.length > 0) {
    fs.writeFileSync(ERROR_LOG, JSON.stringify(errors, null, 2));
    console.log(`  Error log                : ${ERROR_LOG}`);
  }
  console.log('='.repeat(80));
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
