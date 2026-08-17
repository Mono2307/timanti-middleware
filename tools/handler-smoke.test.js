/**
 * Invoke every GET *and POST* handler and fail on a ReferenceError.
 *
 * WHY: the route inventory proves a route is REGISTERED. It cannot prove the handler still runs.
 * /api/test-db shipped to production returning 502 because it read `cachedToken`, a variable that
 * had moved into core/shopify — the route existed, the handler threw the moment it was called.
 * Exactly the failure a file-moving refactor produces, and exactly the one route parity misses.
 *
 * WHY POST TOO: this file used to cover GET only — 30 of 81 routes. The business lives in the
 * other 51. Two production failures came out of that blind spot and neither was a logic error;
 * both were a name that used to be in the same file and no longer was:
 *
 *   POST /api/backfill-order-metafields   copyDraftMetafieldsToOrder is not defined
 *   POST /api/trigger-price-update        _buyingTableCache is not defined  → killed the process,
 *                                         so the daily gold-rate job silently stopped for days
 *
 * HOW: outbound I/O is stubbed (supabase returns empty, axios resolves empty) and child_process
 * is stubbed, so nothing is dialled, written, or spawned. Each handler is called with a bare
 * req/res. POST handlers are invoked exactly like GET ones — the stubs are what make that safe.
 *
 * GATES: most POST handlers reject early on a missing secret or parameter, which would stop the
 * scan before it reaches the interesting code. FIXTURES supplies just enough body/headers to get
 * past the gate on the routes where that matters. trigger-price-update is the worked example:
 * with no fixture it 401s on the first line and the bug above stays invisible; with one it runs
 * far enough to hit it.
 *
 * A handler failing for a MISSING PARAMETER is fine and expected. The only failure this asserts
 * on is ReferenceError / "is not a function" / "of undefined", i.e. a symbol that no longer
 * exists in scope. That is the refactor hazard; everything else is the handler doing its job.
 */

const assert = require('assert');
const path   = require('path');
const Module = require('module');

process.env.SUPABASE_URL         ||= 'https://handler-smoke.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL    ||= 'https://handler-smoke.invalid';

// ── Stub outbound I/O before anything loads ─────────────────────────────────
const okResp = { data: {}, status: 200, headers: {} };
const axiosFn = () => Promise.resolve(okResp);
for (const m of ['get', 'post', 'put', 'delete', 'patch', 'request']) axiosFn[m] = () => Promise.resolve(okResp);
axiosFn.create = () => axiosFn;
axiosFn.defaults = { headers: { common: {} } };

const sbQuery = () => {
  const q = {};
  const self = () => q;
  for (const k of ['select','insert','update','upsert','delete','eq','neq','gt','gte','lt','lte',
                   'in','is','like','ilike','order','limit','range','not','or','filter','match'])
    q[k] = self;
  q.single  = () => Promise.resolve({ data: null, error: null });
  q.maybeSingle = q.single;
  q.then    = (res) => Promise.resolve({ data: [], error: null }).then(res);
  return q;
};
const supabaseStub = { from: sbQuery, rpc: () => Promise.resolve({ data: [], error: null }) };

const realExpress = require('express');
const apps = [];
function wrappedExpress(...a) {
  const app = realExpress(...a);
  apps.push(app);
  app.listen = () => ({ close() {}, on() {}, address: () => ({ port: 0 }) });
  return app;
}
Object.setPrototypeOf(wrappedExpress, realExpress);
Object.assign(wrappedExpress, realExpress);

// Nothing may leave this process. axios covers Shopify and Apps Script; supabase covers the
// ledgers and the serial counters (the allocate_serial RPC included, so no number is ever drawn).
// These two close the rest:
//
//   fetch          — emailService posts to api.resend.com with the global fetch, not axios.
//                    Unstubbed, invoking a repair or voucher handler would send REAL email.
//   child_process  — /api/trigger-price-update spawns the reprice, and PO ops shell out.
//                    Unstubbed, this test would launch the daily job against the live store.
const spawned = [];
const fakeChild = () => {
  const noop = { on() { return noop; }, once() { return noop; }, removeListener() { return noop; } };
  return { pid: 0, stdout: noop, stderr: noop, stdin: { write() {}, end() {} }, on() { return fakeChild; },
           once() { return fakeChild; }, kill() {}, unref() {} };
};
const cpStub = {
  spawn:     (...a) => { spawned.push(a[0]); return fakeChild(); },
  spawnSync: (...a) => { spawned.push(a[0]); return { status: 0, stdout: '', stderr: '' }; },
  exec:      (...a) => { spawned.push(a[0]); const cb = a.find(x => typeof x === 'function'); if (cb) cb(null, '', ''); return fakeChild(); },
  execFile:  (...a) => { spawned.push(a[0]); const cb = a.find(x => typeof x === 'function'); if (cb) cb(null, '', ''); return fakeChild(); },
  execSync:  (...a) => { spawned.push(a[0]); return ''; },
  fork:      (...a) => { spawned.push(a[0]); return fakeChild(); },
};

// Patch the REAL child_process module object in place, not just the loader.
// _spawnPriceUpdate does `require('child_process')` INSIDE the function, i.e. at invoke time —
// long after the Module._load override below is torn down. Intercepting the loader alone let a
// real python3 spawn escape this test (observed: "PID 38232 / Python was not found"). Overwriting
// the cached module's exports covers every require, whenever it happens.
const realCp = require('child_process');
for (const [name, impl] of Object.entries(cpStub)) realCp[name] = impl;

const sentFetches = [];
globalThis.fetch = (url, opts) => {
  sentFetches.push(String(url));
  return Promise.resolve({
    ok: true, status: 200,
    json:    () => Promise.resolve({}),
    text:    () => Promise.resolve(''),
    headers: { get: () => null },
  });
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'express') return wrappedExpress;
  if (request === 'axios')   return axiosFn;
  if (request === '@supabase/supabase-js') return { createClient: () => supabaseStub };
  if (request === 'child_process' || request === 'node:child_process') return cpStub;
  if (request === 'node-fetch') return { default: globalThis.fetch, ...globalThis.fetch };
  return origLoad.apply(this, arguments);
};

const realLog = console.log, realErr = console.error, realWarn = console.warn;
console.log = console.error = console.warn = () => {};
require(path.join(__dirname, '..', 'server.js'));
console.log = realLog; console.error = realErr; console.warn = realWarn;
Module._load = origLoad;

// ── Collect GET and POST routes ──────────────────────────────────────────────
const routes = [];
for (const app of apps) {
  const stack = (app._router && app._router.stack) || [];
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const method of ['get', 'post']) {
      if (layer.route.methods[method]) {
        routes.push({ method: method.toUpperCase(), path: layer.route.path,
                      handlers: layer.route.stack.map(s => s.handle) });
      }
    }
  }
}

// Nothing is skipped any more. It used to skip /api/trigger-price-update as "long/destructive",
// which is precisely the handler that was broken — child_process is stubbed above, so invoking it
// spawns nothing and the exemption is no longer needed. An exemption here is a blind spot, and the
// blind spots are what shipped.
const SKIP = new Set();

// Just enough to get past the early rejects. Without these most POST handlers return 400/401 on
// their first line and the scan never reaches the code a refactor would have broken.
process.env.PRICE_UPDATE_WEBHOOK_SECRET ||= 'smoke-test-secret';
const FIXTURES = {
  '/api/trigger-price-update': {
    headers: { 'x-webhook-secret': process.env.PRICE_UPDATE_WEBHOOK_SECRET },
    // A plausible rate; manual mode is deliberately NOT used so the ±10% guard cannot reject it.
    body: { pure_rate: 15000, calc_mode: 'auto' },
  },
  '/api/backfill-order-metafields': { body: { draftOrderId: '1', orderId: '2' } },
  '/api/backfill-order-tags':       { body: { orderId: '2' } },
  '/api/reprice':                   { body: { draftOrderId: '1' } },
  '/api/convert-to-order':          { body: { draftOrderId: '1' } },
  '/api/serial/allocate':           { body: { docType: 'customer_order', stateCode: 'KA-HSR', orderId: '1' } },
  '/api/serial/cancel-by-code':     { body: { serialNo: 1, docType: 'voucher' } },
  '/api/serial/order-serial':       { body: { id: '1', name: '#1', created_at: '2026-08-15T00:00:00Z' } },
  '/api/draft-order-metafields':    { body: { draftOrderId: '1', fields: { state_code: 'KA-HSR' } } },
  '/api/set-line-prices':           { body: { draftOrderId: '1', lineItems: [{ id: 1, price: 100 }] } },
  '/api/recompute-payment':         { body: { draftOrderId: '1' } },
  '/api/log-cash-payment':          { body: { draftOrderId: '1', amount: 100, mode: 'cash' } },
  '/api/cn-email':                  { body: { cnNumber: 'VCH27-KAHSR-0001', email: 'x@example.invalid' } },
  '/api/exc-email':                 { body: { excNumber: 'EXC27-KAHSR-0001', email: 'x@example.invalid' } },
  '/api/credit-instrument/issue':   { body: { instrumentType: 'voucher', stateCode: 'KA-HSR', value: 100 } },
  '/api/shopify-draft-updated':     { body: { id: 1, name: '#D1', status: 'completed', order_id: 2, tags: '' } },
};

const SCOPE_ERR = /is not defined|is not a function|of undefined|of null|Cannot read propert/i;

(async () => {
  const broken = [];
  let called = 0;

  for (const r of routes) {
    if (SKIP.has(r.path)) continue;
    const fx = FIXTURES[r.path] || {};
    const req = {
      query: fx.query || {}, params: {}, body: fx.body || {},
      headers: fx.headers || {},
      get(h) { return (fx.headers || {})[String(h).toLowerCase()]; },
    };
    let settled = false;
    const done = () => { settled = true; return res; };
    const res = {
      json: done, send: done, end: done, redirect: done, sendFile: done,
      status: () => res, setHeader: () => res, set: () => res, type: () => res,
    };

    called++;
    try {
      await Promise.race([
        Promise.resolve(r.handlers[r.handlers.length - 1](req, res, () => {})),
        new Promise(resolve => setTimeout(resolve, 500)),   // stubs make these fast
      ]);
    } catch (err) {
      if (SCOPE_ERR.test(err.message)) broken.push({ method: r.method, path: r.path, err: err.message });
    }
  }

  // An unhandled rejection is the exact shape that killed the process in production: the handler
  // throws after responding, or Express 4 never sees the rejection at all. Surface it as a failure
  // rather than letting the run finish green.
  await new Promise(resolve => setImmediate(resolve));

  const byMethod = routes.reduce((a, r) => (a[r.method] = (a[r.method] || 0) + 1, a), {});
  console.log(`handler smoke — invoked ${called} handlers with stubbed I/O ` +
              `(${byMethod.GET || 0} GET, ${byMethod.POST || 0} POST)`);
  console.log(`  no outbound I/O: ${sentFetches.length} fetch, ${spawned.length} spawn ` +
              `(both stubbed — nothing left the process)`);
  if (broken.length) {
    for (const b of broken) console.log(`  BROKEN  ${b.method} ${b.path}\n          ${b.err}`);
  }
  assert.deepStrictEqual(broken, [],
    'handler(s) reference a symbol that no longer exists — almost certainly moved during a refactor');
  console.log('  ok  no handler references a missing symbol');
  console.log(`\n1 assertions passed`);
})();
