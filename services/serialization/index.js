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
//   fy: true        → financial-year-scoped: the FY-end (IST) is folded into the counter
//                     key so the sequence RESETS each FY, and {FY} is printed in the serial.
//   pad             → zero-pad width for {SEQ}.
// Tokens: {CODE}=full compound store code, {DELIVERY}=destination store code,
//         {FY}=2-digit financial-year-end, {SEQ}=zero-padded number.
//
// Serials are capped at 16 chars for the GST tax-invoice series (customer_order, customer_service,
// free_service, b2b); the brand token is trimmed (TM/TS/FS) so KAHSR + FY still fit.
// The store code is rendered WITHOUT its hyphen in every serial (KA-HSR → KAHSR), which frees the
// char that lets the B2C/service series carry a 5-digit sequence. The counter key and the staff-facing
// custom.state_code metafield keep the full hyphenated KA-HSR. See SERIALIZATION_MIGRATION_PLAN.md.
const DEFAULT_REGISTRY = {
  // B2C product order — per-store, resets per FY. TM27-KAHSR-00001 (16 chars).
  customer_order:   { scope: 'store',  start: 1, pad: 5, fy: true,  code: 'TM{FY}-{CODE}-{SEQ}', display: 'TM{FY}-{CODE}-{SEQ}' },
  // B2C PAID service order — repairs + CAD/design merged into ONE per-store, per-FY counter. TS27-KAHSR-00001.
  customer_service: { scope: 'store',  start: 1, pad: 5, fy: true,  code: 'TS{FY}-{CODE}-{SEQ}', display: 'TS{FY}-{CODE}-{SEQ}' },
  // B2C FREE service order — complimentary/warranty repairs, separate per-store, per-FY counter. FS27-KAHSR-00001.
  free_service:     { scope: 'store',  start: 1, pad: 5, fy: true,  code: 'FS{FY}-{CODE}-{SEQ}', display: 'FS{FY}-{CODE}-{SEQ}' },
  // B2B tax invoice == inter-store transfer == sale (one doc type, one counter). AURA-KAHSR-0001.
  b2b:              { scope: 'store',  start: 1, pad: 4, fy: false, code: 'AURA-{CODE}-{SEQ}',   display: 'AURA-{CODE}-{SEQ}' },
  // Delivery challan (was memo). Origin only in the serial; destination lives in custom.delivery_code.
  delivery_challan: { scope: 'store',  start: 1, pad: 4, fy: false, code: 'DC-{CODE}-{SEQ}',     display: 'DC-{CODE}-{SEQ}' },
  po:               { scope: 'store',  start: 1, pad: 5, fy: false, code: 'PO-{CODE}-{SEQ}',     display: 'PO-{CODE}-{SEQ}' },
  // Adjustments — per-store now, reset per FY. EXC27-KAHSR-0001 / VCH27-KAHSR-0001.
  voucher:          { scope: 'store',  start: 1, pad: 4, fy: true,  code: 'VCH{FY}-{CODE}-{SEQ}', display: 'VCH{FY}-{CODE}-{SEQ}' },
  exchange_note:    { scope: 'store',  start: 1, pad: 4, fy: true,  code: 'EXC{FY}-{CODE}-{SEQ}', display: 'EXC{FY}-{CODE}-{SEQ}' },
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

// 2-digit financial-year-END in IST (India FY = Apr 1 → Mar 31). FY 2026-27 → "27".
// Computed in IST regardless of server timezone, frozen into the serial at mint time.
function fyEnd(now = new Date()) {
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000)); // UTC+5:30
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth() + 1; // 1-12
  const endYear = (m >= 4) ? y + 1 : y;
  return String(endYear).slice(-2);
}

function padSeq(seq, width) {
  const s = String(seq);
  return (width && s.length < width) ? s.padStart(width, '0') : s;
}

function format(template, { code, seq, delivery, fy, pad }) {
  return template
    .replace('{FY}', fy || '')
    .replace('{CODE}', code || '')
    .replace('{STATE}', code || '')   // backward-compat alias
    .replace('{DELIVERY}', delivery || '')
    .replace('{SEQ}', padSeq(seq, pad));
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

  // FY-scoped types fold the FY-end into the counter key (and the ledger store_code) so the
  // sequence resets each financial year; the same {FY} is printed in the serial.
  const fy = reg.fy ? fyEnd() : '';
  const counterKey = reg.fy ? `${fy}|${code}` : code;

  const { data, error } = await deps.supabase.rpc('allocate_serial', {
    p_doc_type: docType, p_state_code: counterKey, p_start: reg.start,
  });
  if (error) throw new Error(`allocate_serial RPC failed: ${error.message}`);
  const seq = Number(data);

  // For global sequences the {CODE} token is dropped from the templates. The store code is printed
  // WITHOUT its hyphen (KA-HSR → KAHSR) — the full hyphenated code still drives the counter key above.
  const tplCode  = (isGlobal ? '' : code).replace(/-/g, '');
  const delivery = (deriveStateCode(deliveryCode) || '').replace(/-/g, '');
  const tidy = (s) => s.replace('/-', '-').replace('--', '-').replace(/[-/]$/, '').trim();
  const fmtArgs = { seq, delivery, fy, pad: reg.pad };
  return {
    seq,
    stateCode: code,       // bare store code for the staff-facing custom.state_code metafield
    counterKey,            // FY-folded key — used as the ledger store_code (unique per FY)
    fy,
    code:    tidy(format(reg.code,    { ...fmtArgs, code: tplCode })),
    display: tidy(format(reg.display, { ...fmtArgs, code: tplCode })),
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
// resourceIdFromCode: for resources that have no external id (credit notes), key the ledger row
// by the freshly-minted serial_code itself, so it can later be cancelled by code.
async function mintSerial(deps, { docType, storeCode, deliveryCode, resourceType, resourceId, resourceName, stamp = false, resourceIdFromCode = false }) {
  let ridStr = resourceId != null ? String(resourceId) : null;

  // 1. Idempotency: already minted for this resource?
  if (ridStr) {
    const { data: existing } = await deps.supabase.from('serial_ledger')
      .select('*').eq('doc_type', docType).eq('resource_id', ridStr).maybeSingle();
    if (existing) return { ...existing, minted: false };
  }

  // 2. Atomic next number via the existing counter.
  const alloc = await allocateSerial(deps, { docType, stateCode: storeCode, deliveryCode });

  // For id-less resources, use the just-minted code as the resource id (unique by construction).
  if (!ridStr && resourceIdFromCode) ridStr = alloc.code;

  // 3. Record in the ledger (the resource-unique constraint resolves webhook races).
  const { data: row, error } = await deps.supabase.from('serial_ledger').insert({
    doc_type: docType, store_code: alloc.counterKey, seq: alloc.seq, serial_code: alloc.code,
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
// Identify the row by resourceId (the usual path) OR by seq (credit notes, whose customer-facing
// CNTM-YYYY-NNNN number shares only the seq with the ledger's serial_code).
async function cancelSerial(deps, { docType, resourceId, seq }) {
  let q = deps.supabase.from('serial_ledger')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('doc_type', docType);
  if (resourceId != null)   q = q.eq('resource_id', String(resourceId));
  else if (seq != null)     q = q.eq('seq', Number(seq));
  else throw new Error('cancelSerial requires resourceId or seq');
  const { data } = await q.select().maybeSingle();
  return data;
}

module.exports = {
  DEFAULT_REGISTRY,
  SERIAL_KEYS,
  getRegistry,
  allocateSerial,
  fyEnd,
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
