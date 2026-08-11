#!/usr/bin/env node
/**
 * Route inventory — the regression gate for the repo restructure.
 *
 * Loads the app WITHOUT starting it and prints every HTTP route it registers, sorted and
 * stable. Moving code between files must never change this output; if it does, a route was
 * dropped, duplicated or renamed, and the refactor step that caused it is wrong.
 *
 * Safety: `app.listen()` is stubbed to a no-op that never invokes its callback. In server.js
 * every startup side-effect (initShopifyToken, the 30s transaction poller) lives inside that
 * callback, so nothing here touches Shopify, Supabase, Pine or the network.
 *
 *   node tools/route-inventory.js              # print the inventory
 *   node tools/route-inventory.js --check      # diff against tools/baseline-routes.txt
 *   node tools/route-inventory.js --write      # (re)write the baseline — only when a route
 *                                              #  change is genuinely intended
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const BASELINE = path.join(__dirname, 'baseline-routes.txt');

// ── Dummy env ────────────────────────────────────────────────────────────────
// Only needs to satisfy module-level construction (createClient throws on a bad URL).
// Nothing is dialled, so the values are deliberately non-functional.
const DUMMY_ENV = {
  SUPABASE_URL:         'https://route-inventory.invalid',
  SUPABASE_SERVICE_KEY: 'route-inventory-not-a-real-key',
  SHOPIFY_STORE_URL:    'https://route-inventory.invalid',
  PORT:                 '0',
};
for (const [k, v] of Object.entries(DUMMY_ENV)) if (!process.env[k]) process.env[k] = v;

// ── Capture the express app and neuter listen() ──────────────────────────────
const realExpress = require('express');
const apps = [];

function wrappedExpress(...args) {
  const app = realExpress(...args);
  apps.push(app);
  app.listen = function stubbedListen() {
    // Never invoke the callback: that is where initShopifyToken() and setInterval() live.
    return { close() {}, on() {}, address: () => ({ port: 0 }) };
  };
  return app;
}
Object.setPrototypeOf(wrappedExpress, realExpress);
Object.assign(wrappedExpress, realExpress);

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'express') return wrappedExpress;
  return origLoad.apply(this, arguments);
};

// ── Load the app, keeping its console noise out of our output ────────────────
const realLog = console.log, realErr = console.error, realWarn = console.warn;
console.log = console.error = console.warn = () => {};
let loadError = null;
try {
  require(path.join(__dirname, '..', 'server.js'));
} catch (err) {
  loadError = err;
}
console.log = realLog; console.error = realErr; console.warn = realWarn;
Module._load = origLoad;

if (loadError) {
  realErr('route-inventory: FAILED to load server.js\n');
  realErr(loadError.stack);
  process.exit(2);
}

// ── Walk the router stack ────────────────────────────────────────────────────
function collect(app) {
  const out = [];
  const stack = (app._router && app._router.stack) || (app.router && app.router.stack) || [];

  const walk = (layers, prefix) => {
    for (const layer of layers) {
      if (layer.route) {
        const routePath = prefix + layer.route.path;
        const methods = Object.keys(layer.route.methods)
          .filter(m => layer.route.methods[m])
          .map(m => m.toUpperCase())
          .sort();
        for (const m of methods) out.push(`${m.padEnd(6)} ${routePath}`);
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        walk(layer.handle.stack, prefix);   // mounted sub-routers
      }
    }
  };
  walk(stack, '');
  return out;
}

const routes = apps.flatMap(collect);
// Sort by path then method so the file is diff-stable regardless of registration order.
routes.sort((a, b) => {
  const [ma, pa] = [a.slice(0, 6).trim(), a.slice(7)];
  const [mb, pb] = [b.slice(0, 6).trim(), b.slice(7)];
  return pa === pb ? ma.localeCompare(mb) : pa.localeCompare(pb);
});

// Duplicate registrations are legitimate here (several endpoints are exposed as both GET and
// POST on purpose), so they are kept — but flagged, because an accidental double-register
// during the split would otherwise look identical to an intentional one.
const seen = new Map();
for (const r of routes) seen.set(r, (seen.get(r) || 0) + 1);
const dupes = [...seen.entries()].filter(([, n]) => n > 1);

const body = [
  `# route inventory — ${routes.length} routes across ${apps.length} express app(s)`,
  '# Regenerate: node tools/route-inventory.js --write',
  '# This file must not change during a pure move/refactor.',
  '',
  ...routes,
  '',
].join('\n');

if (process.argv.includes('--write')) {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, body);
  realLog(`route-inventory: wrote baseline — ${routes.length} routes`);
  if (dupes.length) realLog(`  note: ${dupes.length} route(s) registered more than once`);
  process.exit(0);
}

if (process.argv.includes('--check')) {
  if (!fs.existsSync(BASELINE)) {
    realErr('route-inventory: no baseline at tools/baseline-routes.txt — run with --write first');
    process.exit(2);
  }
  // Normalise line endings before comparing: git checks this file out as CRLF on Windows
  // while we generate LF, which would otherwise report every single line as drift.
  const norm = (s) => s.replace(/\r\n/g, '\n');
  const expected = fs.readFileSync(BASELINE, 'utf8');
  if (norm(expected) === norm(body)) {
    realLog(`route-inventory: OK — ${routes.length} routes match the baseline`);
    process.exit(0);
  }
  realErr('route-inventory: DRIFT vs tools/baseline-routes.txt\n');
  const e = norm(expected).split('\n').filter(l => l && !l.startsWith('#'));
  const a = norm(body).split('\n').filter(l => l && !l.startsWith('#'));
  for (const line of e) if (!a.includes(line)) realErr(`  - LOST    ${line}`);
  for (const line of a) if (!e.includes(line)) realErr(`  + ADDED   ${line}`);
  process.exit(1);
}

realLog(body);
