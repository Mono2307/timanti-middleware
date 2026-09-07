'use strict';

/**
 * Live price and stock for a handful of variants.
 *
 * The snapshot is a night old by design -- imagery and structure do not change hourly. Price and
 * availability do: the gold-rate reprice moves every managed price daily, and a piece can sell
 * while the page is open. Quoting a stale number to a customer standing in the store is the one
 * failure this page must not have, so those two fields (and only those) are re-read on demand.
 *
 * Batched deliberately: the client asks once for everything visible, not once per card. A grid of
 * 40 cards is one request, not 40.
 */

const { gql } = require('./shopify-gql');

/** Shopify's node lookup takes a bounded list; 100 keeps the query well inside the cost budget. */
const MAX_IDS = 100;

const LIVE_QUERY = `
  query LookbookLive($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        price
        inventoryQuantity
        availableForSale
        product { id status }
      }
    }
  }`;

const toGid = (id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/ProductVariant/${id}`);
const bareId = (gid) => String(gid || '').split('/').pop();

/**
 * Look up `ids` (bare numeric variant ids) and return a map keyed by the same bare ids.
 *
 * A map rather than an array because the client merges the result onto cards it already rendered;
 * matching by index would silently mis-assign prices the moment Shopify omits a deleted node.
 */
async function fetchLive(ids) {
  const wanted = [...new Set((ids || []).map((i) => String(i).trim()).filter(Boolean))].slice(0, MAX_IDS);
  if (!wanted.length) return {};

  const { data } = await gql(LIVE_QUERY, { ids: wanted.map(toGid) }, { label: 'live', timeout: 15000 });

  const out = {};
  for (const node of ((data && data.nodes) || [])) {
    // A deleted variant comes back as null in the same position; skip rather than throw, so one
    // removed piece cannot blank the prices of everything else on screen.
    if (!node || !node.id) continue;
    out[bareId(node.id)] = {
      price: Number(node.price),
      stock: Number.isFinite(node.inventoryQuantity) ? node.inventoryQuantity : null,
      available: node.availableForSale === true,
      status: (node.product && node.product.status) || null,
    };
  }
  return out;
}

module.exports = { fetchLive, MAX_IDS };
