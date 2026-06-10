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

// Precedence: explicit stateCode > location lookup > shipping address.
async function resolveState(deps, { stateCode, shopifyLocationId, shippingAddress }) {
  if (stateCode) return String(stateCode).toUpperCase();
  const fromLoc = await resolveStateFromLocation(deps, shopifyLocationId);
  if (fromLoc) return fromLoc;
  return resolveStateFromShippingAddress(shippingAddress);
}

// ─── Allocation (the ONLY caller of the RPC) ────────────────────────────────────

async function allocateSerial(deps, { docType, stateCode }) {
  const registry = await getRegistry(deps);
  const reg = registry[docType];
  if (!reg) throw new Error(`unknown docType: ${docType}`);

  const isGlobal = reg.scope === 'global';
  const state = isGlobal ? GLOBAL : (stateCode ? String(stateCode).toUpperCase() : null);
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

// resource: 'orders' | 'draft_orders'
async function readSerialMetafields(deps, resource, id, token) {
  const { data } = await axios.get(
    `${deps.shopifyStoreUrl}/admin/api/${API}/${resource}/${id}/metafields.json`,
    { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
  );
  const out = {};
  for (const mf of (data.metafields || [])) {
    if (mf.namespace === 'custom' && SERIAL_KEYS.includes(mf.key)) out[mf.key] = mf.value;
  }
  return out;
}

function serialType(key) {
  return key === 'serial_no' ? 'number_integer' : 'single_line_text_field';
}

// Writes the serial metafields to an order. Drafts go through the injected
// updateDraftOrderMetafields (which already does the custom-namespace GET→PUT/POST).
async function writeOrderSerialMetafields(deps, orderId, fields, token) {
  const headers = shopifyHeaders(token);
  const { data: existingData } = await axios.get(
    `${deps.shopifyStoreUrl}/admin/api/${API}/orders/${orderId}/metafields.json`,
    { headers: { 'X-Shopify-Access-Token': token }, timeout: 10000 }
  );
  const existingByKey = {};
  for (const mf of (existingData.metafields || [])) {
    if (mf.namespace === 'custom') existingByKey[mf.key] = mf.id;
  }
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined || String(value).trim() === '') continue;
    const body = { metafield: { namespace: 'custom', key, value: String(value), type: serialType(key) } };
    const existingId = existingByKey[key];
    try {
      if (existingId) {
        await axios.put(
          `${deps.shopifyStoreUrl}/admin/api/${API}/orders/${orderId}/metafields/${existingId}.json`,
          { metafield: { id: existingId, value: String(value), type: serialType(key) } },
          { headers, timeout: 10000 }
        );
      } else {
        await axios.post(
          `${deps.shopifyStoreUrl}/admin/api/${API}/orders/${orderId}/metafields.json`,
          body, { headers, timeout: 10000 }
        );
      }
    } catch (err) {
      console.error(`[serial] order metafield ${key} failed:`, err.response?.data || err.message);
    }
  }
}

async function stampSerial(deps, resource, id, fields, token) {
  if (resource === 'draft_orders') {
    await deps.updateDraftOrderMetafields(id, fields);
  } else {
    await writeOrderSerialMetafields(deps, id, fields, token);
  }
}

// ─── allocateAndStamp: server-side one-shot (allocate + idempotent stamp) ────────
// Pass exactly one of { draftOrderId, orderId } to stamp; omit both to just allocate.
async function allocateAndStamp(deps, { docType, stateCode, shopifyLocationId, shippingAddress, documentType, draftOrderId, orderId }) {
  const resource = draftOrderId ? 'draft_orders' : (orderId ? 'orders' : null);
  const resourceId = draftOrderId || orderId;
  const token = await deps.getShopifyToken();

  // Idempotency: never allocate twice for the same resource.
  if (resource) {
    const existing = await readSerialMetafields(deps, resource, resourceId, token);
    if (existing.serial_code) {
      return {
        allocated: false,
        serial_no: existing.serial_no,
        serial_code: existing.serial_code,
        serial_display: existing.serial_display,
        state_code: existing.state_code,
        document_type: existing.document_type,
      };
    }
  }

  const state = await resolveState(deps, { stateCode, shopifyLocationId, shippingAddress });
  const registry = await getRegistry(deps);
  const reg = registry[docType];
  if (!reg) throw new Error(`unknown docType: ${docType}`);
  if (reg.scope === 'state' && !state) {
    const err = new Error(`could not resolve state for docType ${docType}`);
    err.code = 'NO_STATE';
    throw err;
  }

  const alloc = await allocateSerial(deps, { docType, stateCode: state });
  const fields = {
    document_type: documentType || docType,
    state_code: alloc.stateCode,
    serial_no: alloc.seq,
    serial_code: alloc.code,
    serial_display: alloc.display,
  };
  if (resource) await stampSerial(deps, resource, resourceId, fields, token);

  return { allocated: true, ...fields };
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
