/**
 * Invoke every GET handler and fail on a ReferenceError.
 *
 * WHY: the route inventory proves a route is REGISTERED. It cannot prove the handler still runs.
 * /api/test-db shipped to production returning 502 because it read `cachedToken`, a variable that
 * had moved into core/shopify — the route existed, the handler threw the moment it was called.
 * Exactly the failure a file-moving refactor produces, and exactly the one route parity misses.
 *
 * HOW: outbound I/O is stubbed (supabase returns empty, axios resolves empty, fs.existsSync false)
 * so nothing is dialled and nothing is written. Each GET handler is called with a bare req/res.
 *
 * A handler failing for a MISSING PARAMETER is fine and expected — these are called with no query
 * string. The only failure this asserts on is ReferenceError / "is not a function" / "of undefined",
 * i.e. a symbol that no longer exists in scope. That is the refactor hazard; everything else is
 * the handler doing its job.
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

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'express') return wrappedExpress;
  if (request === 'axios')   return axiosFn;
  if (request === '@supabase/supabase-js') return { createClient: () => supabaseStub };
  return origLoad.apply(this, arguments);
};

const realLog = console.log, realErr = console.error, realWarn = console.warn;
console.log = console.error = console.warn = () => {};
require(path.join(__dirname, '..', 'server.js'));
console.log = realLog; console.error = realErr; console.warn = realWarn;
Module._load = origLoad;

// ── Collect GET routes ───────────────────────────────────────────────────────
const routes = [];
for (const app of apps) {
  const stack = (app._router && app._router.stack) || [];
  for (const layer of stack) {
    if (layer.route && layer.route.methods.get) {
      routes.push({ path: layer.route.path, handlers: layer.route.stack.map(s => s.handle) });
    }
  }
}

// Handlers that intentionally kick off long/destructive work. Registered, not invoked.
const SKIP = new Set(['/api/trigger-price-update']);

const SCOPE_ERR = /is not defined|is not a function|of undefined|of null|Cannot read propert/i;

(async () => {
  const broken = [];
  let called = 0;

  for (const r of routes) {
    if (SKIP.has(r.path)) continue;
    const req = { query: {}, params: {}, body: {}, headers: {}, get: () => undefined };
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
      if (SCOPE_ERR.test(err.message)) broken.push({ path: r.path, err: err.message });
    }
  }

  console.log(`handler smoke — invoked ${called} GET handlers with stubbed I/O`);
  if (broken.length) {
    for (const b of broken) console.log(`  BROKEN  GET ${b.path}\n          ${b.err}`);
  }
  assert.deepStrictEqual(broken, [],
    'handler(s) reference a symbol that no longer exists — almost certainly moved during a refactor');
  console.log('  ok  no handler references a missing symbol');
  console.log(`\n1 assertions passed`);
})();
