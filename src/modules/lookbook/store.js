'use strict';

/**
 * Where the lookbook snapshot lives, and when it is rebuilt.
 *
 * WHY NOT A FILE ON DISK
 * Fly runs this service with no volume -- `fly.toml` has no [mounts], and /app/Outputs is treated
 * as disposable precisely because a deploy wipes it. A JSON file would therefore reset on every
 * deploy and the first staff member to open the page after one would wait out a full catalog walk.
 * So the durable copy goes to the Supabase `config` table, mirroring the `buying_rate_table`
 * pattern already in core/shopify.js: memory is the hot path, Postgres is the thing that survives.
 *
 * Stored gzipped and base64'd. `config.value` is a text column and a normalised catalog is mostly
 * repeated keys, which gzip is extremely good at -- typically an order of magnitude smaller, which
 * is the difference between a row Postgres is happy with and one it is not.
 */

const zlib = require('zlib');
const crypto = require('crypto');
const { supabase } = require('../../core/supabase');
const { log } = require('../../core/logger');
const { buildSnapshot } = require('./snapshot');

const CONFIG_KEY = 'lookbook_snapshot';
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60 * 1000;

/**
 * 04:00 IST. The gold-rate reprice runs daily and rewrites every managed variant's price; building
 * the snapshot before it finishes would bake in yesterday's prices for a whole day. Every other
 * periodic job in this service fires relative to BOOT, which is fine for a sweep and wrong here --
 * a redeploy at 15:00 would otherwise pin the nightly catalog build to 15:00 forever.
 */
const REBUILD_HOUR_IST = 4;

let _snapshot = null;   // the live copy every request is served from
let _etag = null;
// The response body, gzipped once at build time. This is the largest thing the service sends and
// it changes once a night, so compressing it per request would burn CPU re-doing identical work -
// and re-serialising 10k variants on every page load is worse than the transfer itself.
let _gzip = null;
let _building = null;   // in-flight build, shared so two callers cannot walk the catalog at once

const etagOf = (snapshot) =>
  '"' + crypto.createHash('sha1').update(JSON.stringify(snapshot)).digest('hex').slice(0, 16) + '"';

const pack   = (obj) => zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf8')).toString('base64');
const unpack = (str) => JSON.parse(zlib.gunzipSync(Buffer.from(str, 'base64')).toString('utf8'));

function setSnapshot(snapshot) {
  _snapshot = snapshot;
  _etag = etagOf(snapshot);
  _gzip = zlib.gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8'), { level: 9 });
  log.info('lookbook', `payload: ${Math.round(_gzip.length / 1024)} KB gzipped on the wire`);
  return snapshot;
}

/** The snapshot as it stands, or null if nothing has been loaded or built yet. */
const get = () => _snapshot;
const etag = () => _etag;
const ageMs = () => (_snapshot && _snapshot.builtAt ? Date.now() - Date.parse(_snapshot.builtAt) : null);

async function loadFromSupabase() {
  try {
    const { data } = await supabase.from('config').select('value').eq('key', CONFIG_KEY).single();
    if (!data || !data.value) return null;
    const snapshot = unpack(data.value);
    setSnapshot(snapshot);
    log.info('lookbook', `snapshot loaded from Supabase: ${snapshot.productCount} products, built ${snapshot.builtAt}`);
    return snapshot;
  } catch (err) {
    log.warn('lookbook', 'snapshot load failed:', err.message);
    return null;
  }
}

async function saveToSupabase(snapshot) {
  try {
    const packed = pack(snapshot);
    await supabase.from('config').upsert({
      key: CONFIG_KEY,
      value: packed,
      updated_at: new Date().toISOString(),
    });
    log.info('lookbook', `snapshot saved to Supabase (${Math.round(packed.length / 1024)} KB gzipped)`);
  } catch (err) {
    // A failed save is not a failed build: the in-memory copy is already serving. It just means
    // the next boot walks the catalog again instead of reading it back.
    log.error('lookbook', 'snapshot save failed:', err.message);
  }
}

/**
 * Rebuild from Shopify.
 *
 * Concurrent callers share one build. Without that, the nightly timer firing while an operator
 * hits /lookbook/refresh would walk the entire catalog twice at once and burn the rate limit that
 * the reprice job also depends on.
 */
function refresh() {
  if (_building) return _building;
  _building = (async () => {
    try {
      const snapshot = await buildSnapshot();
      setSnapshot(snapshot);
      await saveToSupabase(snapshot);
      return snapshot;
    } finally {
      _building = null;
    }
  })();
  return _building;
}

/** ms until the next REBUILD_HOUR_IST, computed in IST regardless of the container's clock. */
function msUntilNextRebuild(now = Date.now()) {
  const ist = new Date(now + IST_OFFSET_MS);
  const nextUtc = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), REBUILD_HOUR_IST, 0, 0) - IST_OFFSET_MS;
  let delay = nextUtc - now;
  if (delay <= 0) delay += DAY_MS;
  return delay;
}

/**
 * Boot: serve whatever Supabase has immediately, then rebuild if it is stale.
 *
 * The order matters. Loading first means a deploy does not blank the page for the length of a
 * catalog walk -- staff see yesterday's imagery (with live prices over it) while the rebuild runs
 * behind them.
 */
function start() {
  const kick = (why) => refresh().catch((err) => log.error('lookbook', `${why} rebuild failed:`, err.message));

  setTimeout(async () => {
    const loaded = await loadFromSupabase();
    const age = ageMs();
    if (!loaded || age === null || age > DAY_MS) {
      log.info('lookbook', loaded ? 'stored snapshot is stale, rebuilding' : 'no stored snapshot, building');
      kick('boot');
    }
  }, 20 * 1000); // let the Shopify token and Supabase client settle first, as the other sweeps do

  const schedule = () => {
    const delay = msUntilNextRebuild();
    log.info('lookbook', `next catalog rebuild in ${Math.round(delay / 60000)} min (${REBUILD_HOUR_IST}:00 IST)`);
    setTimeout(() => { kick('nightly'); schedule(); }, delay);
  };
  schedule();
}

/** Pre-gzipped response body, or null before the first snapshot exists. */
const gzipped = () => _gzip;

module.exports = { get, etag, gzipped, ageMs, refresh, start, loadFromSupabase, msUntilNextRebuild, CONFIG_KEY, REBUILD_HOUR_IST };
