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

/**
 * The application root — the directory holding package.json (/app in the container).
 *
 * Discovered rather than counted. `../` was correct while this file lived at /app/price_update;
 * the 2026-08 restructure moved it to /app/src/jobs/price-update, which silently repointed both
 * the .env lookup and the Outputs directory at /app/src/jobs — a directory that does not exist.
 * Neither failed at startup; they would only have surfaced on the next daily run.
 */
const APP_ROOT = (() => {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(resolve(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve(__dirname, '../../..');   // last-resort fallback
})();

dotenv.config({ path: resolve(APP_ROOT, '.env') });

// ── CLI args ──────────────────────────────────────────────────────────────────
// --input  <path>  Override the input CSV (used by daily orchestrator)
// --no-resume      Force a fresh run, ignoring any existing progress log

const _args     = process.argv.slice(2);
const _inputIdx = _args.indexOf('--input');

// ── Config ────────────────────────────────────────────────────────────────────

const INPUT_CSV = _inputIdx !== -1
  ? resolve(_args[_inputIdx + 1])
  : resolve(APP_ROOT, 'Outputs/PREVIEW_VARIANT_IMPORT_20260421_v2.csv');

const RESUME = !_args.includes('--no-resume');

// Progress and error logs are scoped to the input file so daily runs never
// collide with manual runs or each other.
const _stem      = basename(INPUT_CSV, '.csv');
const OUTPUTS_DIR  = process.env.OUTPUTS_DIR || resolve(APP_ROOT, 'Outputs');
const ERROR_LOG    = resolve(OUTPUTS_DIR, `import_preview_errors_${_stem}.json`);
const PROGRESS_LOG = resolve(OUTPUTS_DIR, `import_preview_progress_${_stem}.json`);
const SKIPPED_LOG  = resolve(OUTPUTS_DIR, `import_preview_skipped_${_stem}.json`);

const STORE_DOMAIN    = (process.env.STORE_DOMAIN    || '').trim();
const ADMIN_API_TOKEN = (process.env.ADMIN_API_TOKEN || '').trim();
const GRAPHQL_URL     = `https://${STORE_DOMAIN}/admin/api/2024-10/graphql.json`;

const MAX_RETRIES      = 6;
const THROTTLE_WAIT_MS = 2000;
const PRICE_BATCH_SIZE = 50;   // max variants per productVariantsBulkUpdate call
const MF_PER_CALL      = 25;   // Shopify's cap on metafieldsSet

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

  // Remember what is left of the cost budget so the metafield loop can pace itself
  // rather than drive the bucket to empty and then live at the retry ceiling.
  const avail = json?.extensions?.cost?.throttleStatus?.currentlyAvailable;
  if (typeof avail === 'number') _costAvailable = avail;

  // A response carrying errors and NO data is a failed call and has to be raised as one.
  //
  // Shopify answers a throttled or rejected mutation with {"errors":[...]} and no "data"
  // key at all. A caller that only inspects data.<mutation>.userErrors therefore reads
  // undefined, falls through its "|| []", sees an empty array and concludes the call
  // succeeded. That is exactly how variants ended up priced at the new rate with a breakup
  // still at the old one — and then stamped as done, which put them beyond the reach of
  // every recovery path the job has.
  //
  // Phase 2 already checked bulkRes.errors. Phase 3 did not, which is why prices landed
  // and breakups silently did not.
  if (errorsArr.length > 0 && !json?.data) {
    throw new Error(`GraphQL call failed: ${JSON.stringify(errorsArr).slice(0, 300)}`);
  }

  return json;
}

// Cost budget remaining after the most recent call, and a pre-emptive pause when it runs
// low. The value phase sends 25 metafields per call — about five times the old per-variant
// payload — so an unpaced loop empties the bucket and then spends the rest of the run being
// throttled. Waiting for a refill is cheaper than retrying, and it keeps calls out of the
// failure path rather than relying on the failure path being correct.
let _costAvailable = Infinity;
const COST_FLOOR   = 300;

async function paceForCost() {
  if (_costAvailable >= COST_FLOOR) return;
  const wait = Math.min(5000, Math.ceil((COST_FLOOR - _costAvailable) / 50) * 1000);
  if (wait > 0) {
    await new Promise(r => setTimeout(r, wait));
    _costAvailable = COST_FLOOR;   // refreshed for real by the next call's response
  }
}

// One metafieldsSet call, reduced to a plain did-it-work answer.
//
// Three different things count as failure and all three used to be invisible here: a
// transport error, a GraphQL-level error with no data, and userErrors on the mutation
// itself. Anything that is not an unambiguous success is a failure, because the caller
// uses this answer to decide whether to stamp the variant as done.
async function setMetafields(list) {
  await paceForCost();
  try {
    const res = await gql(M_METAFIELDS, { m: list });
    const set = res?.data?.metafieldsSet;
    if (!set) return { ok: false, message: 'response carried no metafieldsSet payload' };
    const ue = set.userErrors || [];
    return ue.length > 0 ? { ok: false, message: ue[0].message } : { ok: true, message: '' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
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
// The value fields, written first. gold_last_updated_at is deliberately NOT in
// this list - it is the commit marker and is written separately, after these
// have landed without error. See Phase 3 below.
const METAFIELD_COLS = [
  'mf_price_breakup_gold',
  'mf_price_breakup_gst',
  'mf_price_total',
  'mf_price_subtotal',
  'mf_gold_rate',
];
const STAMP_COL = 'mf_gold_last_updated_at';

// Values batch across variants the way prices already do. One call per variant is what made
// a full run take hours: 15k variants, 15k calls.
//
// This MUST be declared after METAFIELD_COLS, not up in the config block with the other
// tunables. A const is in the temporal dead zone until its declaration runs, so reading
// METAFIELD_COLS.length from higher up the file threw
//   ReferenceError: Cannot access 'METAFIELD_COLS' before initialization
// at module load - the importer died before its first line of work, every single run, and
// the orchestrator saw no 'Variants written' line to parse and reported 0.
const MF_VARIANTS_PER_CALL = Math.floor(MF_PER_CALL / METAFIELD_COLS.length);
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

  // ── Phase 3a: value metafields per variant ───────────────────────────────
  //
  // The stamp is NOT written here. Phase 2 has already changed the price, so
  // between that write and this one a variant carries a new price under an old
  // breakup - self-consistent at the previous rate and therefore invisible on
  // inspection. Stamping in the same call as the values would mark such a
  // variant done even when the values failed, and the next run would skip it.
  //
  // Writing the stamp only after the values land means an interruption leaves
  // the variant reading NOT done. The next run re-prices it, which is the
  // recoverable failure rather than the silent one.
  console.log(`\nPhase 3a — writing value metafields, ${MF_VARIANTS_PER_CALL} variants per call...`);
  let mfDone = 0;
  const stamped = [];          // variants whose values landed cleanly

  // Flatten to a work list so batches can span products, as the price phase does.
  const mfWork = [];
  for (const [, entries] of byProduct) {
    for (const { row, variantId } of entries) {
      const metafields = [];
      for (const col of METAFIELD_COLS) {
        const type = MF_TYPE[col] || 'number_decimal';
        const val  = cleanNum(row[col]);
        if (val !== null) {
          metafields.push({ ownerId: variantId, namespace: 'custom', key: MF_KEY[col], type, value: val });
        }
      }
      if (metafields.length > 0) mfWork.push({ variantId, row, metafields });
    }
  }

  for (let i = 0; i < mfWork.length; i += MF_VARIANTS_PER_CALL) {
    const chunk   = mfWork.slice(i, i + MF_VARIANTS_PER_CALL);
    const payload = chunk.flatMap(w => w.metafields);

    const out = await setMetafields(payload);

    if (out.ok) {
      for (const w of chunk) stamped.push({ variantId: w.variantId, row: w.row });
    } else {
      // A rejected batch says nothing about which variant caused it, so retry the chunk
      // one at a time. One bad variant must not cost the four beside it their update —
      // and a batch that failed for capacity reasons usually succeeds singly.
      console.error(`  Batch failed (${out.message}) — retrying ${chunk.length} variants singly`);
      for (const w of chunk) {
        const one = await setMetafields(w.metafields);
        if (one.ok) {
          stamped.push({ variantId: w.variantId, row: w.row });
        } else {
          console.error(`  ERR metafields ${w.row.shopify_sku}: ${one.message}`);
          errors.push({ variantId: w.variantId, sku: w.row.shopify_sku, stage: 'metafields', message: one.message });
        }
      }
    }

    mfDone += chunk.length;
    if (mfDone % 500 < MF_VARIANTS_PER_CALL) console.log(`  Value metafields written: ${mfDone}`);
  }

  // ── Phase 3b: the commit marker ──────────────────────────────────────────
  // Only variants whose values were accepted get stamped.
  console.log(`\nPhase 3b — stamping ${stamped.length} variants whose values landed...`);
  const stampWork = stamped
    .map(({ variantId, row }) => {
      const raw = row[STAMP_COL];
      const val = raw && raw.trim() ? raw.trim() : null;
      return val === null ? null : { variantId, row, mf: {
        ownerId: variantId, namespace: 'custom', key: MF_KEY[STAMP_COL],
        type: MF_TYPE[STAMP_COL] || 'date_time', value: val } };
    })
    .filter(Boolean);

  let stampDone = 0;
  for (let i = 0; i < stampWork.length; i += MF_PER_CALL) {
    const chunk = stampWork.slice(i, i + MF_PER_CALL);
    const out   = await setMetafields(chunk.map(w => w.mf));

    if (out.ok) {
      for (const w of chunk) await markDone(w.variantId);
    } else {
      console.error(`  Stamp batch failed (${out.message}) — retrying ${chunk.length} singly`);
      for (const w of chunk) {
        const one = await setMetafields([w.mf]);
        if (one.ok) {
          await markDone(w.variantId);
        } else {
          console.error(`  ERR stamp ${w.row.shopify_sku}: ${one.message}`);
          errors.push({ variantId: w.variantId, sku: w.row.shopify_sku, stage: 'stamp', message: one.message });
        }
      }
    }

    stampDone += chunk.length;
    if (stampDone % 500 < MF_PER_CALL) console.log(`  Stamped: ${stampDone}`);
  }

  const unstamped = mfDone - stamped.length;
  if (unstamped > 0) {
    console.warn(`  ${unstamped} variant(s) were NOT stamped because their values failed. ` +
                 `They will be re-priced on the next run.`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  // "Written" now means the value metafields actually landed. It used to be the size of
  // byProduct — the number of variants the run INTENDED to touch, counted before a single
  // call was made and never reduced by a failure, so a run in which every write failed
  // still reported the whole catalogue as written.
  const attempted = [...byProduct.values()].reduce((s, e) => s + e.length, 0);

  console.log('\n' + '='.repeat(80));
  console.log('DONE');
  console.log(`  Variants processed       : ${attempted}`);
  console.log(`  Variants written         : ${stamped.length}`);
  console.log(`  Values failed            : ${attempted - stamped.length}`);
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
