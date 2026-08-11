'use strict';

/**
 * Every environment variable the middleware reads, in one place.
 *
 * Before this file, `process.env` was consulted from ~35 scattered call sites, so the only way
 * to know what the service needed was to grep for it — and a missing Fly secret surfaced as a
 * confusing runtime error deep in a handler rather than at boot.
 *
 * Rules:
 *   - Modules import from here; they do not read process.env directly.
 *   - Parsing and defaults happen HERE, once, so every consumer sees the same value.
 *   - Booleans go through flagOn() so "True", "1", "yes" and " on " all behave.
 *
 * `docs/ENVIRONMENT.md` is generated from the comments below — keep them accurate.
 */

/** Lenient boolean parse: True/TRUE/1/yes/on (any casing, surrounding space ok) → true. */
const flagOn = (v) => ['true', '1', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());

/** Strict boolean parse, kept separate because the AUTO_* flags have always been exact-match. */
const isTrue = (v) => v === 'true';

const config = {
  // ── Runtime ────────────────────────────────────────────────────────────────
  port:            process.env.PORT || 8080,
  /** Public base URL of this service; used to build links inside emails and Shopify tags. */
  serverUrl:       process.env.SERVER_URL || process.env.MIDDLEWARE_BASE_URL || '',

  // ── Shopify ────────────────────────────────────────────────────────────────
  shopify: {
    /** e.g. https://timanti.myshopify.com — no trailing slash. */
    storeUrl:      process.env.SHOPIFY_STORE_URL,
    /** Fallback only. The live token is fetched at runtime from Supabase — see core/shopify.js. */
    accessToken:   process.env.SHOPIFY_ACCESS_TOKEN,
    clientId:      process.env.SHOPIFY_CLIENT_ID,
    clientSecret:  process.env.SHOPIFY_CLIENT_SECRET,
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET,
  },

  // ── Supabase (config table, ledgers, serial counters) ──────────────────────
  supabase: {
    url:           process.env.SUPABASE_URL,
    serviceKey:    process.env.SUPABASE_SERVICE_KEY,
  },

  // ── Pine Labs card terminals ───────────────────────────────────────────────
  pine: {
    /** 'production' selects PINE_LABS_API_URL; anything else uses the UAT host. */
    mode:          process.env.PINE_PAYMENT_MODE,
    apiUrl:        process.env.PINE_LABS_API_URL,
    uatApiUrl:     process.env.PINE_LABS_UAT_API_URL,
    securityToken: process.env.PINE_LABS_SECURITY_TOKEN,
  },

  // ── Gokwik payment links ───────────────────────────────────────────────────
  gokwik: {
    baseUrl:       process.env.GOKWIK_BASE_URL,
    appId:         process.env.GOKWIK_APP_ID,
    appSecret:     process.env.GOKWIK_APP_SECRET,
  },

  // ── Outbound comms ─────────────────────────────────────────────────────────
  email: {
    resendApiKey:  process.env.RESEND_API_KEY,
    hq:            process.env.HQ_EMAIL,
    hqCc:          process.env.HQ_CC_EMAIL,
    store:         process.env.STORE_EMAIL,
    /** Credit-note email is gated so it can be dark-launched. */
    cnEnabled:     flagOn(process.env.CN_EMAIL_ENABLED),
  },
  smsApiKey:       process.env.FAST2SMS_API_KEY,

  // ── Google Apps Script web apps (sheet integrations) ───────────────────────
  appsScript: {
    /** PO Ops sheet. */
    poOps:         process.env.APPS_SCRIPT_URL,
    /** Exchange / credit-note sheet — a different script and sheet. */
    exchange:      process.env.EXCHANGE_APPS_SCRIPT_URL,
    poQueue:       process.env.PO_QUEUE_SCRIPT_URL,
  },

  // ── Serialization feature flags — wire one document type at a time ─────────
  serial: {
    customerOrder: flagOn(process.env.SERIAL_CUSTOMER_ORDER),
    repair:        flagOn(process.env.SERIAL_REPAIR),
    memoTransfer:  flagOn(process.env.SERIAL_MEMO_TRANSFER),
    po:            flagOn(process.env.SERIAL_PO),
    /**
     * Customer-order serials only mint for orders created on/after this instant (IST), so
     * July and earlier are never retro-numbered.
     */
    customerOrderStart: process.env.SERIAL_CUSTOMER_ORDER_START || '2026-08-01T00:00:00+05:30',
  },

  // ── Automation switches ────────────────────────────────────────────────────
  // Deliberately strict === 'true': these trigger money movement and customer email, so a
  // typo must fail closed rather than accidentally enable a flow.
  auto: {
    pushToTerminal:     isTrue(process.env.AUTO_PUSH_TO_TERMINAL),
    convertDraftToOrder:isTrue(process.env.AUTO_CONVERT_DRAFT_TO_ORDER),
    sendDraftInvoice:   isTrue(process.env.AUTO_SEND_DRAFT_INVOICE),
    sendDepositEmail:   isTrue(process.env.AUTO_SEND_DEPOSIT_EMAIL),
  },

  // ── Misc integrations ──────────────────────────────────────────────────────
  typeformWebhookSecret:   process.env.TYPEFORM_WEBHOOK_SECRET,
  priceUpdateWebhookSecret:process.env.PRICE_UPDATE_WEBHOOK_SECRET,
  catalogueUrl:            process.env.CATALOGUE_URL,
  storeMapUrl:             process.env.STORE_MAP_URL,
  sequelTrackingBase:      process.env.SEQUEL_TRACKING_BASE,
};

/**
 * Fail fast on the handful of variables without which nothing works at all.
 * Everything else degrades to a disabled feature, which is the correct behaviour.
 */
function assertRequired() {
  const missing = [];
  if (!config.supabase.url)        missing.push('SUPABASE_URL');
  if (!config.supabase.serviceKey) missing.push('SUPABASE_SERVICE_KEY');
  if (!config.shopify.storeUrl)    missing.push('SHOPIFY_STORE_URL');
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }
}

module.exports = { config, flagOn, isTrue, assertRequired };
