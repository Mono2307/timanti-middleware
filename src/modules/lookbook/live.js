'use strict';

/**
 * Live price and stock for a handful of variants.
 *
 * The snapshot is a night old by design -- imagery and structure do not change hourly. Price and
 * availability do: the gold-rate reprice moves every managed price daily, and a piece can sell
 * while the page is open. Quoting a stale number to a customer standing in the store is the one
 * failure this page must not have, so those fields are re-read on demand.
 *
 * Two shapes:
 *   lean  price + stock. What the grid asks for, up to 100 variants in one request.
 *   full  lean + the price breakup the pricer writes (gold, diamond, making, GST, total, gold rate,
 *         priced-at). What the PDP asks for. Without it the PDP showed a LIVE price above a
 *         SNAPSHOT breakup, and in the hour between a reprice and the next rebuild the two
 *         disagreed in front of the customer.
 *
 * Batched deliberately: the client asks once for everything visible, not once per card.
 */

const { gql } = require('./shopify-gql');

/** Shopify's node lookup takes a bounded list; 100 keeps the lean query well inside the cost budget. */
const MAX_IDS = 100;
/**
 * The full query costs roughly 12 points per variant (nine metafields plus the node and product),
 * so 100 at once would ask for ~1,200 against a 1,000-point ceiling. 25 per call keeps each well
 * under it; a product with 90 variants is four calls.
 */
const FULL_CHUNK = 25;

const LEAN_FIELDS = `
        id
        price
        inventoryQuantity
        availableForSale
        product { id status }`;

const BREAKUP_FIELDS = `
        pricedAt:  metafield(namespace: "custom", key: "gold_last_updated_at")  { value }
        goldRate:  metafield(namespace: "custom", key: "gold_rate")             { value }
        bGold:     metafield(namespace: "custom", key: "price_breakup_gold")    { value }
        bDiamond:  metafield(namespace: "custom", key: "price_breakup_diamond") { value }
        bMaking:   metafield(namespace: "custom", key: "price_breakup_making")  { value }
        bGem:      metafield(namespace: "custom", key: "gemstone_charges")      { value }
        bGst:      metafield(namespace: "custom", key: "price_breakup_gst")     { value }
        bSubtotal: metafield(namespace: "custom", key: "price_subtotal")        { value }
        bTotal:    metafield(namespace: "custom", key: "price_total")           { value }`;

const query = (full) => `
  query LookbookLive($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {${LEAN_FIELDS}${full ? BREAKUP_FIELDS : ''}
      }
    }
  }`;

const toGid = (id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/ProductVariant/${id}`);
const bareId = (gid) => String(gid || '').split('/').pop();

/** Same rule as snapshot.js: an unset metafield is absent, never a zero. */
const mf = (m) => {
  const s = m && m.value !== null && m.value !== undefined ? String(m.value).trim() : '';
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

function shape(node, full) {
  const out = {
    price: Number(node.price),
    stock: Number.isFinite(node.inventoryQuantity) ? node.inventoryQuantity : null,
    available: node.availableForSale === true,
    status: (node.product && node.product.status) || null,
  };
  if (full) {
    out.full = true;
    out.pricedAt = (node.pricedAt && node.pricedAt.value) || null;
    out.goldRate = mf(node.goldRate);
    out.breakup = {
      gold: mf(node.bGold), diamond: mf(node.bDiamond), gemstone: mf(node.bGem), making: mf(node.bMaking),
      subtotal: mf(node.bSubtotal), gst: mf(node.bGst), total: mf(node.bTotal),
    };
  }
  return out;
}

/**
 * Look up `ids` (bare numeric variant ids) and return a map keyed by the same bare ids.
 *
 * A map rather than an array because the client merges the result onto cards it already rendered;
 * matching by index would silently mis-assign prices the moment Shopify omits a deleted node.
 */
async function fetchLive(ids, { full = false } = {}) {
  const wanted = [...new Set((ids || []).map((i) => String(i).trim()).filter(Boolean))].slice(0, MAX_IDS);
  if (!wanted.length) return {};

  const size = full ? FULL_CHUNK : MAX_IDS;
  const out = {};
  // Sequential, not parallel: the reprice job shares this bucket, and four simultaneous full
  // reads are exactly the burst that gets one of them throttled.
  for (let i = 0; i < wanted.length; i += size) {
    const chunk = wanted.slice(i, i + size);
    const { data } = await gql(query(full), { ids: chunk.map(toGid) }, { label: full ? 'live-full' : 'live', timeout: 15000 });
    for (const node of ((data && data.nodes) || [])) {
      // A deleted variant comes back as null in the same position; skip rather than throw, so one
      // removed piece cannot blank the prices of everything else on screen.
      if (!node || !node.id) continue;
      out[bareId(node.id)] = shape(node, full);
    }
  }
  return out;
}

module.exports = { fetchLive, MAX_IDS, FULL_CHUNK, shape };
