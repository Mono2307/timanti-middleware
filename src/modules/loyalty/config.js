'use strict';

/**
 * Loyalty programme configuration.
 *
 * Lives in ONE shop metafield, `loyalty.program_config` (JSON), so tiers, percentages and the
 * include/exclude rules can be changed in Shopify admin → Settings → Custom data without a deploy.
 * Read through a 5-minute cache. A broken edit never takes the programme down: the last good copy
 * keeps serving (or the defaults, before any good copy was seen), and the problem is logged.
 */

const { graphql } = require('../../core/shopify');
const { log } = require('../../core/logger');

const NAMESPACE = 'loyalty';
const KEY = 'program_config';
const TTL_MS = 5 * 60 * 1000;

/** The founder's grid. Also what /api/loyalty/setup seeds the metafield with. */
const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  tiers: [
    { key: 'T1', name: 'Silver',   min: 200000,  pct: 3 },
    { key: 'T2', name: 'Gold',     min: 500000,  pct: 5 },
    { key: 'T3', name: 'Platinum', min: 1000000, pct: 7 },
  ],
  birthday:    { pct: 2, window: 'month' },
  anniversary: { pct: 2, window: 'month' },
  occasion_bonus_stacks: false,
  eligibility: {
    include: { product_types: [], tags: [], collections: [], skus: [] },
    exclude: { skus: ['SCOIN'], tags: ['no-loyalty'], collections: [], product_types: [], jewel_code_prefixes: [] },
    require_diamond_value: true,
  },
  online: { code_prefix: 'LOY-', code_ttl_minutes: 120 },
  emails: { tier_change: false },
});

/**
 * Validate and normalise a parsed config. Throws with a readable message on anything that would
 * make the engine misbehave — a tier without a number, a percentage over 100.
 */
function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('config is not an object');
  const tiers = Array.isArray(raw.tiers) ? raw.tiers : [];
  if (!tiers.length) throw new Error('config has no tiers');
  const keys = new Set();
  const norm = tiers.map((t, i) => {
    const min = Number(t.min);
    const pct = Number(t.pct);
    const key = String(t.key || `T${i + 1}`).trim();
    if (!(min >= 0)) throw new Error(`tier ${key}: min must be a number`);
    if (!(pct > 0 && pct <= 100)) throw new Error(`tier ${key}: pct must be between 0 and 100`);
    if (keys.has(key)) throw new Error(`tier key ${key} is repeated`);
    keys.add(key);
    return { key, name: String(t.name || key), min, pct };
  }).sort((a, b) => a.min - b.min);

  const pctOf = (o) => {
    const p = Number((o || {}).pct || 0);
    if (!(p >= 0 && p <= 100)) throw new Error('occasion pct must be between 0 and 100');
    return { pct: p, window: 'month' };
  };
  const el = raw.eligibility || {};
  const arr = (x) => (Array.isArray(x) ? x.map(String) : []);
  return {
    enabled: raw.enabled !== false,
    tiers: norm,
    birthday: pctOf(raw.birthday),
    anniversary: pctOf(raw.anniversary),
    occasion_bonus_stacks: !!raw.occasion_bonus_stacks,
    eligibility: {
      include: {
        product_types: arr((el.include || {}).product_types),
        tags: arr((el.include || {}).tags),
        collections: arr((el.include || {}).collections),
        skus: arr((el.include || {}).skus),
      },
      exclude: {
        skus: arr((el.exclude || {}).skus),
        tags: arr((el.exclude || {}).tags),
        collections: arr((el.exclude || {}).collections),
        product_types: arr((el.exclude || {}).product_types),
        jewel_code_prefixes: arr((el.exclude || {}).jewel_code_prefixes),
      },
      require_diamond_value: el.require_diamond_value !== false,
    },
    online: {
      code_prefix: String((raw.online || {}).code_prefix || 'LOY-'),
      code_ttl_minutes: Math.max(10, Number((raw.online || {}).code_ttl_minutes) || 120),
    },
    emails: { tier_change: !!(raw.emails || {}).tier_change },
  };
}

let _cache = null;
let _cachedAt = 0;
let _lastGood = null;

/** Read the shop metafield, uncached. Returns the raw string or null. */
async function fetchRawConfig() {
  const data = await graphql(`{ shop { metafield(namespace: "${NAMESPACE}", key: "${KEY}") { value } } }`);
  return (data && data.shop && data.shop.metafield && data.shop.metafield.value) || null;
}

/** The live config. Never throws: falls back to the last good copy, then to the defaults. */
async function loadConfig({ force = false } = {}) {
  if (!force && _cache && Date.now() - _cachedAt < TTL_MS) return _cache;
  try {
    const raw = await fetchRawConfig();
    const cfg = raw ? normalizeConfig(JSON.parse(raw)) : normalizeConfig(DEFAULT_CONFIG);
    _cache = cfg; _cachedAt = Date.now(); _lastGood = cfg;
    return cfg;
  } catch (err) {
    log.error('loyalty', `config unreadable — using ${_lastGood ? 'last good copy' : 'defaults'}: ${err.message}`);
    const fallback = _lastGood || normalizeConfig(DEFAULT_CONFIG);
    _cache = fallback; _cachedAt = Date.now();
    return fallback;
  }
}

/** For tests and the setup endpoint. */
function _resetCache() { _cache = null; _cachedAt = 0; _lastGood = null; }

module.exports = { NAMESPACE, KEY, DEFAULT_CONFIG, normalizeConfig, loadConfig, fetchRawConfig, _resetCache };
