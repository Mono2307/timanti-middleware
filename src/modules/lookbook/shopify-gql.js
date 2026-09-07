'use strict';

/**
 * A throttle-aware GraphQL caller for the catalog walk.
 *
 * WHY NOT core/shopify.js's `graphql()`
 * That helper returns `data.data` and discards `extensions`, which is exactly where Shopify puts
 * the leaky-bucket state. Walking a whole catalog is the one job in this service that will hit the
 * rate limit, and it cannot back off on information it never sees. Rather than change a helper
 * that ~80 live call sites depend on, this keeps the difference local: same token, same API
 * version, same store URL, but the full response body.
 *
 * The retry logic is a port of src/jobs/price-update/shopify_snapshot.py:66-92, which has been
 * walking this same catalog daily in production. Same signals, same backoff — if the Python job
 * survives this catalog, so does this.
 */

const axios = require('axios');
const { config } = require('../../core/config');
const { getShopifyToken, API_VERSION } = require('../../core/shopify');
const { log } = require('../../core/logger');

const MAX_ATTEMPTS = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a query, retrying while Shopify says the bucket is empty.
 *
 * Returns `{ data, cost }`. `cost` is surfaced so the caller can log what a page actually costs:
 * the page sizes below are a guess until a real catalog proves them, and the only way to tune them
 * is to see `actualQueryCost` from the live store.
 */
async function gql(query, variables = {}, { timeout = 30000, label = 'gql' } = {}) {
  let lastErr = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let body;
    try {
      const token = await getShopifyToken();
      const res = await axios.post(
        `${config.shopify.storeUrl}/admin/api/${API_VERSION}/graphql.json`,
        { query, variables },
        { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, timeout }
      );
      body = res.data || {};
    } catch (err) {
      // A 429 is the HTTP-level version of the same signal; anything else is a real failure and
      // retrying it just delays the error by half a minute.
      const status = err.response?.status;
      if (status !== 429 && status !== 502 && status !== 503) throw err;
      lastErr = err;
      await sleep(3000 * (attempt + 1));
      continue;
    }

    // Only an ACTUAL throttle rejection is worth retrying. An empty bucket alongside a successful
    // response is not a failure - the data is already in hand, and re-issuing the query would
    // discard a page we paid for and pay for it again. That mistake turned the variants pass into
    // a 3s-per-page crawl that re-fetched everything it had just read.
    const rejected = (body.errors || []).some((e) => e && e.extensions && e.extensions.code === 'THROTTLED');
    if (rejected) {
      lastErr = new Error('throttled');
      const wait = 3000 * (attempt + 1);
      log.warn('lookbook', `${label}: throttled, waiting ${wait}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
      await sleep(wait);
      continue;
    }

    if (body.errors?.length) throw new Error(`Shopify GraphQL (${label}): ${JSON.stringify(body.errors)}`);

    // Succeeded. If the bucket cannot cover another page, pace before returning so the NEXT call
    // does not get rejected - Shopify refills at ~50 points/sec on a standard plan.
    const st = body.extensions && body.extensions.cost;
    if (st && st.throttleStatus) {
      const need = st.requestedQueryCost || 0;
      const have = st.throttleStatus.currentlyAvailable;
      const rate = st.throttleStatus.restoreRate || 50;
      if (have != null && have < need) {
        const wait = Math.min(Math.ceil(((need - have) / rate) * 1000) + 100, 5000);
        log.info('lookbook', `${label}: pacing ${wait}ms for the bucket to refill`);
        await sleep(wait);
      }
    }

    return {
      data: body.data,
      cost: body.extensions?.cost
        ? {
            requested: body.extensions.cost.requestedQueryCost,
            actual:    body.extensions.cost.actualQueryCost,
            available: body.extensions.cost.throttleStatus?.currentlyAvailable,
          }
        : null,
    };
  }

  throw new Error(`Shopify GraphQL (${label}): gave up after ${MAX_ATTEMPTS} attempts — ${lastErr?.message}`);
}

/**
 * Walk a cursor-paginated connection to exhaustion.
 *
 * `pick` pulls the connection out of the response so this stays agnostic about which connection is
 * being walked. `pageCap` is a guard, not a limit: a bug in the cursor handling would otherwise
 * loop forever against a live API, and that is a worse failure than a truncated snapshot.
 */
async function paginate(query, pick, { label = 'gql', pageCap = 400, onPage } = {}) {
  const nodes = [];
  let cursor = null;
  let pages = 0;

  do {
    const { data, cost } = await gql(query, { cursor }, { label });
    const conn = pick(data);
    if (!conn) break;

    nodes.push(...(conn.nodes || []));
    cursor = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;

    // Log the first page's cost only: it is the number that tells you whether the page size is
    // safe, and repeating it for every page would bury the rest of the boot log.
    if (pages === 0 && cost) {
      log.info('lookbook', `${label}: page cost ${cost.actual}/${cost.requested}, bucket ${cost.available} left`);
    }
    if (onPage) onPage(nodes.length, ++pages);
    else pages++;
  } while (cursor && pages < pageCap);

  if (cursor) log.warn('lookbook', `${label}: stopped at the ${pageCap}-page cap with more to read`);
  return nodes;
}

module.exports = { gql, paginate, sleep };
