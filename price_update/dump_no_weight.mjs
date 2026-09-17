/**
 * dump_no_weight.mjs
 * ==================
 * One-shot, out-of-band dump of every live variant the daily price run skips
 * because `custom.net_metal_weight_g` is missing or zero.
 *
 * Mirrors the skip rules in shopify_snapshot.py exactly:
 *   - product status ARCHIVED        → not counted (never priced anyway)
 *   - GATI id in STATIC_PRICE_GATI_IDS → excluded (silver coins etc.)
 *   - net_metal_weight_g == 0        → THIS list
 *
 * Run (token from Supabase config.shopify_access_token, or any Admin API token
 * with read_products):
 *
 *   ADMIN_API_TOKEN=shpat_xxx node dump_no_weight.mjs
 *
 * Or let it fetch the live token itself:
 *
 *   SUPABASE_SERVICE_KEY=xxx node dump_no_weight.mjs
 *
 * Writes SKIPPED_NO_WEIGHT_<YYYYMMDD>.csv next to this file (override with
 * --out <path>).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STORE_DOMAIN = process.env.STORE_DOMAIN || 'auracarat.myshopify.com';
const API_VERSION  = '2024-10';
const STORE_HANDLE = STORE_DOMAIN.replace('.myshopify.com', '');
const EXCLUDED     = new Set(['SCOIN']);   // keep in sync with config.STATIC_PRICE_GATI_IDS
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mvprpdurguootqiwkaeu.supabase.co';

const COLUMNS = [
  'run_date', 'gati_id', 'sku', 'variant_id',
  'product_title', 'product_status', 'karat',
  'gross_weight_g', 'diamond_cost', 'making_cost', 'admin_url',
];

const QUERY = `
query($cursor: String) {
  productVariants(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      sku
      product { id status title }
      wt:    metafield(namespace: "custom", key: "net_metal_weight_g")    { value }
      gross: metafield(namespace: "custom", key: "total_metal_weight_g")  { value }
      dia:   metafield(namespace: "custom", key: "price_breakup_diamond") { value }
      make:  metafield(namespace: "custom", key: "price_breakup_making")  { value }
    }
  }
}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const numericId = gid => (gid || '').split('/').pop();
const mfFloat = (node, key) => {
  const v = node?.[key]?.value;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

async function fetchToken() {
  if (process.env.ADMIN_API_TOKEN) return process.env.ADMIN_API_TOKEN.trim();

  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!key) {
    throw new Error(
      'Need ADMIN_API_TOKEN (Shopify Admin token) or SUPABASE_SERVICE_KEY in the environment.'
    );
  }
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/config?key=eq.shopify_access_token&select=value`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  if (!r.ok) throw new Error(`Supabase token fetch failed: ${r.status} ${await r.text()}`);
  const rows = await r.json();
  if (!rows.length) throw new Error('No shopify_access_token row in Supabase config');
  console.log('Token fetched from Supabase');
  return rows[0].value.trim();
}

async function gql(token, variables, attempt = 0) {
  const MAX_RETRIES = 6;
  try {
    const r = await fetch(`https://${STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
      method:  'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query: QUERY, variables }),
    });
    const j = await r.json();
    if (j.errors && typeof j.errors === 'string') throw new Error(j.errors);

    const available = j?.extensions?.cost?.throttleStatus?.currentlyAvailable ?? 999;
    const throttled = available === 0 ||
      (Array.isArray(j.errors) && j.errors.some(e => e?.extensions?.code === 'THROTTLED'));
    if (throttled && attempt < MAX_RETRIES) {
      const wait = 3000 * (attempt + 1);
      console.log(`  Throttled — waiting ${wait / 1000}s`);
      await sleep(wait);
      return gql(token, variables, attempt + 1);
    }
    if (Array.isArray(j.errors) && j.errors.length) {
      throw new Error(JSON.stringify(j.errors).slice(0, 300));
    }
    return j;
  } catch (e) {
    if (attempt < MAX_RETRIES) {
      console.warn(`  Network error (${e.message}), retry ${attempt + 1}`);
      await sleep(3000);
      return gql(token, variables, attempt + 1);
    }
    throw e;
  }
}

function karatOf(parts) {
  const k = (parts[2] || '').trim();
  if (k.includes('24')) return '24K';
  if (k.includes('22')) return '22K';
  if (k.includes('14')) return '14K';
  return '18K';
}

const csvCell = v => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  const outArgIdx = process.argv.indexOf('--out');
  const stamp     = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outPath   = outArgIdx !== -1
    ? path.resolve(process.argv[outArgIdx + 1])
    : path.join(__dirname, `SKIPPED_NO_WEIGHT_${stamp}.csv`);

  const token   = await fetchToken();
  const runDate = new Date().toISOString().slice(0, 10);

  const noWeight = [];
  let cursor = null, page = 0;
  let scanned = 0, archived = 0, excluded = 0, priced = 0;

  console.log('Paging all Shopify variants...');
  for (;;) {
    page += 1;
    const res   = await gql(token, cursor ? { cursor } : {});
    const conn  = res?.data?.productVariants;
    if (!conn) throw new Error(`Unexpected reply: ${JSON.stringify(res).slice(0, 300)}`);

    for (const v of conn.nodes) {
      scanned += 1;
      const prod   = v.product || {};
      if (prod.status === 'ARCHIVED') { archived += 1; continue; }

      const sku    = (v.sku || '').trim();
      const parts  = sku.split('|');
      const gatiId = (parts[0] || '').trim().toUpperCase();
      if (EXCLUDED.has(gatiId)) { excluded += 1; continue; }

      if (mfFloat(v, 'wt') !== 0) { priced += 1; continue; }

      noWeight.push({
        run_date:       runDate,
        gati_id:        gatiId,
        sku,
        variant_id:     numericId(v.id),
        product_title:  prod.title || '',
        product_status: prod.status || '',
        karat:          karatOf(parts),
        gross_weight_g: mfFloat(v, 'gross'),
        diamond_cost:   mfFloat(v, 'dia'),
        making_cost:    mfFloat(v, 'make'),
        admin_url:      prod.id
          ? `https://admin.shopify.com/store/${STORE_HANDLE}/products/${numericId(prod.id)}/variants/${numericId(v.id)}`
          : '',
      });
    }

    if (page % 10 === 0 || !conn.pageInfo.hasNextPage) {
      console.log(`  Page ${page} — ${scanned} variants scanned, ${noWeight.length} missing weight so far`);
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  noWeight.sort((a, b) => a.gati_id.localeCompare(b.gati_id) || a.sku.localeCompare(b.sku));

  const csv = [COLUMNS.join(',')]
    .concat(noWeight.map(r => COLUMNS.map(c => csvCell(r[c])).join(',')))
    .join('\n');
  fs.writeFileSync(outPath, csv, 'utf8');

  // Roll up by product so the fix list is readable at a glance.
  // Key on the product URL, not gati_id — blank-SKU variants have no GATI and
  // would otherwise collapse into one bogus group under the first row's title.
  const byProduct = new Map();
  for (const r of noWeight) {
    const k = r.admin_url.split('/variants')[0] || `(no product) ${r.product_title}`;
    if (!byProduct.has(k)) {
      byProduct.set(k, { count: 0, title: r.product_title, gati: r.gati_id, status: r.product_status, noSku: 0 });
    }
    const g = byProduct.get(k);
    g.count += 1;
    if (!r.sku) g.noSku += 1;
  }
  const top = [...byProduct.entries()].sort((a, b) => b[1].count - a[1].count);
  const noSkuTotal = noWeight.filter(r => !r.sku).length;

  console.log('\n' + '='.repeat(70));
  console.log(`Scanned          : ${scanned.toLocaleString()} variants`);
  console.log(`Archived skipped : ${archived.toLocaleString()}`);
  console.log(`Static excluded  : ${excluded.toLocaleString()}`);
  console.log(`Priced normally  : ${priced.toLocaleString()}`);
  console.log(`MISSING WEIGHT   : ${noWeight.length.toLocaleString()}  across ${byProduct.size} products`);
  console.log('='.repeat(70));
  console.log('\nTop products by skipped variants:');
  for (const [gati, info] of top.slice(0, 25)) {
    console.log(`  ${String(info.count).padStart(4)}  ${gati.padEnd(12)} ${(info.title || '').slice(0, 45)}`);
  }
  if (top.length > 25) console.log(`  ... +${top.length - 25} more products`);
  console.log(`\nCSV written → ${outPath}`);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
