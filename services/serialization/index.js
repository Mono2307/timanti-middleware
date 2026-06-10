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
//   scope: 'state'  → keyed by (docType, stateCode); requires a resolvable state
//   scope: 'global' → keyed by (docType, 'ALL'); ignores state
const DEFAULT_REGISTRY = {
  customer_order: { scope: 'state',  start: 1001, code: '{STATE}-{SEQ}',          display: 'Aura Carat {STATE} {SEQ}' },
  po:             { scope: 'state',  start: 1001, code: 'PO-{STATE}-{SEQ}',        display: 'PO-{STATE}-{SEQ}' },
  memo:           { scope: 'state',  start: 1001, code: 'MEMO-{STATE}-{SEQ}',      display: 'MEMO-{STATE}-{SEQ}' },
  transfer:       { scope: 'state',  start: 1001, code: 'TRANSFER-{STATE}-{SEQ}',  display: 'TRANSFER-{STATE}-{SEQ}' },
  repair:         { scope: 'global', start: 1,    code: 'REP-{SEQ}',               display: 'REP-{SEQ}' },
  credit_note:    { scope: 'global', start: 1,    code: 'CNTM-{SEQ}',              display: 'CNTM-{SEQ}' },
};

// Machine-written keys (we never write custom.state_code — that's the staff store dropdown).
const SERIAL_KEYS = ['document_type', 'serial_state', 'serial_no', 'serial_code', 'serial_display'];

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

function format(template, stateCode, seq) {
  return template.replace('{STATE}', stateCode).replace('{SEQ}', String(seq));
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

// Normalizes a raw location/store code to a plain state code for the sequence key.
// Staff pick store-level codes (KA-HSR, MH-HQ); the sequence is per-STATE, so we take
// the prefix before the first '-'.  "KA-HSR" → "KA", "mh-hq" → "MH", "KA" → "KA".
function deriveStateCode(raw) {
  return String(raw || '').toUpperCase().split('-')[0].trim() || null;
}

// Precedence: explicit stateCode > location lookup > shipping address. Each source is
// normalized through deriveStateCode so store-level codes collapse to the state.
async function resolveState(deps, { stateCode, shopifyLocationId, shippingAddress }) {
  if (stateCode) return deriveStateCode(stateCode);
  const fromLoc = await resolveStateFromLocation(deps, shopifyLocationId);
  if (fromLoc) return deriveStateCode(fromLoc);
  const fromShip = resolveStateFromShippingAddress(shippingAddress);
  return fromShip ? deriveStateCode(fromShip) : null;
}

// ─── Allocation (the ONLY caller of the RPC) ────────────────────────────────────

async function allocateSerial(deps, { docType, stateCode }) {
  const registry = await getRegistry(deps);
  const reg = registry[docType];
  if (!reg) throw new Error(`unknown docType: ${docType}`);

  const isGlobal = reg.scope === 'global';
  const state = isGlobal ? GLOBAL : deriveStateCode(stateCode);
  if (!isGlobal && !state) throw new Error(`state required for docType ${docType}`);

  const { data, error } = await deps.supabase.rpc('allocate_serial', {
    p_doc_type: docType, p_state_code: state, p_start: reg.start,
  });
  if (error) throw new Error(`allocate_serial RPC failed: ${error.message}`);
  const seq = Number(data);

  // For global sequences the {STATE} token is dropped from the templates.
  const displayState = isGlobal ? '' : state;
  return {
    seq,
    stateCode: state,
    code: format(reg.code, displayState, seq).replace('--', '-').replace(/-$/, ''),
    display: format(reg.display, displayState, seq).replace(/\s+/g, ' ').trim(),
  };
}

// ─── Metafield read / write ─────────────────────────────────────────────────────

// resource: 'orders' | 'draft_orders'. Returns ALL custom metafields as {key: value}
// — we need serial_code for idempotency and the staff-set state_code for state fallback.
async function readSerialMetafields(deps, resource, id, token) {
  const { data } = await axios.get(
    `${deps.shopifyStoreUrl}/admin/api/${API}/${resource}/${id}/metafields.json`,
    { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
  );
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
    const { data } = await axios.get(
      `${deps.shopifyStoreUrl}/admin/api/${API}/${resource}/${id}/metafields.json`,
      { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
    );
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
        await axios.put(
          `${deps.shopifyStoreUrl}/admin/api/${API}/metafields/${existingId}.json`,
          { metafield: { id: existingId, value: String(value), type } },
          { headers, timeout: 10000 }
        );
      } else {
        await axios.post(
          `${deps.shopifyStoreUrl}/admin/api/${API}/${resource}/${id}/metafields.json`,
          { metafield: { namespace: 'custom', key, value: String(value), type } },
          { headers, timeout: 10000 }
        );
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
// We never write `state_code` — that is the staff-owned store dropdown (KA-HSR/MH-HQ);
// the derived plain state is written as `serial_state` instead.
async function allocateAndStamp(deps, { docType, stateCode, shopifyLocationId, shippingAddress, documentType, draftOrderId, orderId }) {
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
        state_code: deriveStateCode(existing.serial_state || existing.state_code),
        serial_no: existing.serial_no,
        serial_code: existing.serial_code,
        serial_display: existing.serial_display,
      };
    }
  }

  const registry = await getRegistry(deps);
  const reg = registry[docType];
  if (!reg) throw new Error(`unknown docType: ${docType}`);

  // State: explicit arg → location → shipping → the resource's staff-set custom.state_code.
  let state = await resolveState(deps, { stateCode, shopifyLocationId, shippingAddress });
  if (!state && existing.state_code) state = deriveStateCode(existing.state_code);

  if (reg.scope === 'state' && !state) {
    const err = new Error(`could not resolve state for docType ${docType}`);
    err.code = 'NO_STATE';
    throw err;
  }

  const alloc = await allocateSerial(deps, { docType, stateCode: state });
  const fields = {
    document_type: documentType || docType,
    serial_state:  alloc.stateCode,
    serial_no:     alloc.seq,
    serial_code:   alloc.code,
    serial_display: alloc.display,
  };
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
};
