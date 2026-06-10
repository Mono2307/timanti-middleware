'use strict';

// Serialization service
// ─────────────────────
// Issues location- and document-type-scoped serial numbers from an atomic
// Supabase counter (allocate_serial RPC) and stamps them onto Shopify Orders /
// Draft Orders as `custom` metafields. The metafields ride the existing
// custom-namespace draft→order copy path, so a number survives conversion.
//
// Deps (injected, mirrors PO_DEPS):
//   { supabase, getShopifyToken, shopifyStoreUrl, updateDraftOrderMetafields }

const axios = require('axios');

const API = '2024-01';
const GLOBAL = 'ALL'; // state_code sentinel for non-location-scoped sequences

// Document-type registry. Override at runtime via the `config.serial_registry`
// JSON row (merged over these defaults) — new doc types/locations need no code.
//   scope: 'store'  → keyed by (docType, full compound store code e.g. KA-HSR)
//   scope: 'global' → keyed by (docType, 'ALL'); ignores location
// Tokens: {CODE}=origin store code, {DELIVERY}=destination store code, {SEQ}=number.
// needsDelivery → requires a staff-set custom.delivery_code (memo/transfer).
const DEFAULT_REGISTRY = {
  customer_order: { scope: 'store',  start: 1001, code: 'TMNT-{CODE}-{SEQ}',               display: 'TMNT-{CODE}-{SEQ}' },
  po:             { scope: 'store',  start: 1,    code: 'PO-{CODE}-{SEQ}',                 display: 'PO-{CODE}-{SEQ}' },
  memo:           { scope: 'store',  start: 1,    code: 'MEMO-{CODE}/{DELIVERY}-{SEQ}',     display: 'MEMO-{CODE}/{DELIVERY}-{SEQ}',     needsDelivery: true },
  transfer:       { scope: 'store',  start: 1,    code: 'TRANSFER-{CODE}/{DELIVERY}-{SEQ}', display: 'TRANSFER-{CODE}/{DELIVERY}-{SEQ}', needsDelivery: true },
  repair:         { scope: 'store',  start: 1,    code: 'REP-{CODE}-{SEQ}',                display: 'REP-{CODE}-{SEQ}' },
  credit_note:    { scope: 'global', start: 1,    code: 'CNTM-{SEQ}',                      display: 'CNTM-{SEQ}' },
};

// Machine-written keys. state_code holds the full compound store code (e.g. KA-HSR),
// staff-entered; delivery_code (memo/transfer destination) is also staff-entered.
const SERIAL_KEYS = ['document_type', 'state_code', 'serial_no', 'serial_code', 'serial_display'];

let _registryCache = null;
let _registryAt = 0;
const REGISTRY_TTL = 5 * 60 * 1000;

async function getRegistry(deps) {
  if (_registryCache && (Date.now() - _registryAt) < REGISTRY_TTL) return _registryCache;
  let merged = { ...DEFAULT_REGISTRY };
  try {
    const { data } = await deps.supabase.from('config').select('value').eq('key', 'serial_registry').maybeSingle();
    if (data?.value) {
      const override = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
      for (const [k, v] of Object.entries(override)) merged[k] = { ...merged[k], ...v };
    }
  } catch (e) {
    console.warn('[serial] registry override load failed, using defaults:', e.message);
  }
  _registryCache = merged;
  _registryAt = Date.now();
  return merged;
}

function shopifyHeaders(token) {
  return { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Retries an axios call on Shopify 429 (Too Many Requests), honoring Retry-After.
async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err.response?.status === 429 && attempt < 6) {
        const ra = parseFloat(err.response.headers?.['retry-after']) || 2;
        await sleep(Math.ceil(ra * 1000) + 250);
        continue;
      }
      throw err;
    }
  }
}

function format(template, code, seq, delivery) {
  return template
    .replace('{CODE}', code || '')
    .replace('{STATE}', code || '')   // backward-compat alias
    .replace('{DELIVERY}', delivery || '')
    .replace('{SEQ}', String(seq));
}

// ─── State resolution ─────────────────────────────────────────────────────────

async function resolveStateFromLocation(deps, shopifyLocationId) {
  if (!shopifyLocationId) return null;
  try {
    const { data } = await deps.supabase
      .from('locations').select('state_code')
      .eq('shopify_location_id', String(shopifyLocationId)).maybeSingle();
    return data?.state_code ? String(data.state_code).toUpperCase() : null;
  } catch (e) {
    console.warn('[serial] resolveStateFromLocation failed:', e.message);
    return null;
  }
}

function resolveStateFromShippingAddress(addr) {
  return (addr?.province_code || '').toUpperCase() || null;
}

// Normalizes a store code for use as the counter key and in the serial — the FULL
// compound code is kept (no derivation). "ka-hsr" → "KA-HSR", " MH-HQ " → "MH-HQ".
function deriveStateCode(raw) {
  return String(raw || '').toUpperCase().trim() || null;
}

// Precedence: explicit stateCode > location lookup > shipping address.
async function resolveState(deps, { stateCode, shopifyLocationId, shippingAddress }) {
  if (stateCode) return deriveStateCode(stateCode);
  const fromLoc = await resolveStateFromLocation(deps, shopifyLocationId);
  if (fromLoc) return deriveStateCode(fromLoc);
  const fromShip = resolveStateFromShippingAddress(shippingAddress);
  return fromShip ? deriveStateCode(fromShip) : null;
}

// ─── Allocation (the ONLY caller of the RPC) ────────────────────────────────────

async function allocateSerial(deps, { docType, stateCode, deliveryCode }) {
  const registry = await getRegistry(deps);
  const reg = registry[docType];
  if (!reg) throw new Error(`unknown docType: ${docType}`);

  const isGlobal = reg.scope === 'global';
  const code = isGlobal ? GLOBAL : deriveStateCode(stateCode);
  if (!isGlobal && !code) throw new Error(`store code required for docType ${docType}`);

  const { data, error } = await deps.supabase.rpc('allocate_serial', {
    p_doc_type: docType, p_state_code: code, p_start: reg.start,
  });
  if (error) throw new Error(`allocate_serial RPC failed: ${error.message}`);
  const seq = Number(data);

  // For global sequences the {CODE} token is dropped from the templates.
  const tplCode  = isGlobal ? '' : code;
  const delivery = deriveStateCode(deliveryCode) || '';
  const tidy = (s) => s.replace('/-', '-').replace('--', '-').replace(/[-/]$/, '').trim();
  return {
    seq,
    stateCode: code,
    code:    tidy(format(reg.code,    tplCode, seq, delivery)),
    display: tidy(format(reg.display, tplCode, seq, delivery)),
  };
}

// ─── Metafield read / write ─────────────────────────────────────────────────────

// resource: 'orders' | 'draft_orders'. Returns ALL custom metafields as {key: value}
// — we need serial_code for idempotency and the staff-set state_code for state fallback.
async function readSerialMetafields(deps, resource, id, token) {
  const { data } = await withRetry(() => axios.get(
    `${deps.shopifyStoreUrl}/admin/api/${API}/${resource}/${id}/metafields.json`,
    { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
  ));
  const out = {};
  for (const mf of (data.metafields || [])) {
    if (mf.namespace === 'custom') out[mf.key] = mf.value;
  }
  return out;
}

function serialType(key) {
  return key === 'serial_no' ? 'number_integer' : 'single_line_text_field';
}

// Resilient per-field writer for both orders and draft_orders. Each field is written
// independently so one field with a conflicting metafield definition can't abort the rest
// (critically: serial_code must always land for idempotency). Returns collected errors.
async function writeSerialMetafields(deps, resource, id, fields, token) {
  const headers = shopifyHeaders(token);
  const errors = [];
  const existingByKey = {};
  try {
    const { data } = await withRetry(() => axios.get(
      `${deps.shopifyStoreUrl}/admin/api/${API}/${resource}/${id}/metafields.json`,
      { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
    ));
    for (const mf of (data.metafields || [])) {
      if (mf.namespace === 'custom') existingByKey[mf.key] = mf.id;
    }
  } catch (e) {
    errors.push({ stage: 'read', error: e.response?.data || e.message });
  }

  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined || String(value).trim() === '') continue;
    const type = serialType(key);
    const existingId = existingByKey[key];
    try {
      if (existingId) {
        await withRetry(() => axios.put(
          `${deps.shopifyStoreUrl}/admin/api/${API}/metafields/${existingId}.json`,
          { metafield: { id: existingId, value: String(value), type } },
          { headers, timeout: 10000 }
        ));
      } else {
        await withRetry(() => axios.post(
          `${deps.shopifyStoreUrl}/admin/api/${API}/${resource}/${id}/metafields.json`,
          { metafield: { namespace: 'custom', key, value: String(value), type } },
          { headers, timeout: 10000 }
        ));
      }
    } catch (err) {
      errors.push({ key, error: err.response?.data || err.message });
      console.error(`[serial] ${resource} metafield ${key} failed:`, JSON.stringify(err.response?.data) || err.message);
    }
  }
  return { errors };
}

async function stampSerial(deps, resource, id, fields, token) {
  return writeSerialMetafields(deps, resource, id, fields, token);
}

// ─── allocateAndStamp: server-side one-shot (allocate + idempotent stamp) ────────
// Pass exactly one of { draftOrderId, orderId } to stamp; omit both to just allocate.
// state_code (full compound store code, e.g. KA-HSR) is staff-entered; we only fill it
// when blank (Pine flow), never clobbering it. memo/transfer also read staff delivery_code.
async function allocateAndStamp(deps, { docType, stateCode, shopifyLocationId, shippingAddress, deliveryCode, documentType, draftOrderId, orderId }) {
  const resource = draftOrderId ? 'draft_orders' : (orderId ? 'orders' : null);
  const resourceId = draftOrderId || orderId;
  const token = await deps.getShopifyToken();

  // Idempotency: never allocate twice for the same resource.
  let existing = {};
  if (resource) {
    existing = await readSerialMetafields(deps, resource, resourceId, token);
    if (existing.serial_code) {
      return {
        allocated: false,
        stamped: true,
        document_type: existing.document_type,
        state_code: existing.state_code || null,
        serial_no: existing.serial_no,
        serial_code: existing.serial_code,
        serial_display: existing.serial_display,
      };
    }
  }

  const registry = await getRegistry(deps);
  const reg = registry[docType];
  if (!reg) throw new Error(`unknown docType: ${docType}`);

  // Store code: explicit arg → location → shipping → the resource's staff-set custom.state_code.
  let code = await resolveState(deps, { stateCode, shopifyLocationId, shippingAddress });
  if (!code && existing.state_code) code = deriveStateCode(existing.state_code);
  if (reg.scope === 'store' && !code) {
    const err = new Error(`could not resolve store code for docType ${docType}`);
    err.code = 'NO_STATE';
    throw err;
  }

  // Delivery (memo/transfer): explicit arg → the resource's staff-set custom.delivery_code.
  const delivery = deriveStateCode(deliveryCode) || deriveStateCode(existing.delivery_code);
  if (reg.needsDelivery && !delivery) {
    const err = new Error(`could not resolve delivery code for docType ${docType}`);
    err.code = 'NO_DELIVERY';
    throw err;
  }

  const alloc = await allocateSerial(deps, { docType, stateCode: code, deliveryCode: delivery });
  const fields = {
    document_type: documentType || docType,
    serial_no:     alloc.seq,
    serial_code:   alloc.code,
    serial_display: alloc.display,
  };
  // state_code is a staff input. Only fill it when staff left it blank (e.g. Pine flow).
  if (!existing.state_code) fields.state_code = alloc.stateCode;
  let writeResult = { errors: [] };
  if (resource) writeResult = await stampSerial(deps, resource, resourceId, fields, token);

  return {
    allocated: true,
    stamped: resource ? writeResult.errors.length === 0 : null,
    writeErrors: writeResult.errors,
    document_type: fields.document_type,
    state_code: alloc.stateCode,
    serial_no: alloc.seq,
    serial_code: alloc.code,
    serial_display: alloc.display,
  };
}

// ─── v2 ledger (Stage 1) ─────────────────────────────────────────────────────
// mintSerial: the source-of-truth allocator. Idempotent per (docType, resourceId) via
// the serial_ledger.serial_ledger_resource_unique constraint — a resource can never get
// two numbers, no matter how many times this is called. Optionally mirrors onto Shopify.
async function mintSerial(deps, { docType, storeCode, deliveryCode, resourceType, resourceId, resourceName, stamp = false }) {
  const ridStr = resourceId != null ? String(resourceId) : null;

  // 1. Idempotency: already minted for this resource?
  if (ridStr) {
    const { data: existing } = await deps.supabase.from('serial_ledger')
      .select('*').eq('doc_type', docType).eq('resource_id', ridStr).maybeSingle();
    if (existing) return { ...existing, minted: false };
  }

  // 2. Atomic next number via the existing counter.
  const alloc = await allocateSerial(deps, { docType, stateCode: storeCode, deliveryCode });

  // 3. Record in the ledger (the resource-unique constraint resolves webhook races).
  const { data: row, error } = await deps.supabase.from('serial_ledger').insert({
    doc_type: docType, store_code: alloc.stateCode, seq: alloc.seq, serial_code: alloc.code,
    resource_type: resourceType || null, resource_id: ridStr, resource_name: resourceName || null,
    status: 'active',
  }).select().single();

  if (error) {
    // Lost a race on resource_id → return the row that won (the seq we drew is burned).
    if (ridStr) {
      const { data: won } = await deps.supabase.from('serial_ledger')
        .select('*').eq('doc_type', docType).eq('resource_id', ridStr).maybeSingle();
      if (won) return { ...won, minted: false };
    }
    throw new Error(`serial_ledger insert failed: ${error.message}`);
  }

  // 4. Optionally mirror onto the Shopify resource.
  let stampErrors = [];
  if (stamp && resourceType && ridStr) {
    const token = await deps.getShopifyToken();
    const fields = { document_type: docType, serial_no: alloc.seq, serial_code: alloc.code, serial_display: alloc.display };
    const res = resourceType === 'order' ? 'orders' : 'draft_orders';
    const w = await stampSerial(deps, res, ridStr, fields, token);
    stampErrors = w.errors;
  }

  return { ...row, minted: true, stampErrors };
}

// cancelSerial: retire a number (status=cancelled). Never reused — GST-clean.
async function cancelSerial(deps, { docType, resourceId }) {
  const { data } = await deps.supabase.from('serial_ledger')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('doc_type', docType).eq('resource_id', String(resourceId)).select().maybeSingle();
  return data;
}

module.exports = {
  DEFAULT_REGISTRY,
  SERIAL_KEYS,
  getRegistry,
  allocateSerial,
  resolveState,
  resolveStateFromLocation,
  resolveStateFromShippingAddress,
  readSerialMetafields,
  stampSerial,
  allocateAndStamp,
  mintSerial,
  cancelSerial,
  withRetry,
};
