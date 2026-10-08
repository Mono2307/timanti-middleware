#!/usr/bin/env node
/**
 * Loyalty acceptance run — the automated part of loyalty/UAT_LOYALTY.md.
 *
 *   ADMIN_API_SECRET=... node tools/loyalty-uat.js --customer <id> --eligible <variantId> \
 *       [--excluded <variantId>] [--second <variantId>] [--base https://timanti-middleware.fly.dev]
 *
 * 1. Runs the offline suites (engine + flow tests) on this machine.
 * 2. Starts the live self-test on the deployed service and prints each criterion PASS/FAIL/SKIP.
 *
 * Creates no orders. The live run uses scratch DRAFTS (deleted afterwards), its own one-time codes
 * (deleted), and temporary ledger adjustments on the UAT customer (deleted). Exit code is non-zero
 * if anything failed.
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const BASE = arg('base') || 'https://timanti-middleware.fly.dev';
const SECRET = process.env.ADMIN_API_SECRET;
const params = {
  customerId: arg('customer'),
  eligibleVariantId: arg('eligible'),
  excludedVariantId: arg('excluded'),
  secondVariantId: arg('second'),
};

const pad = (s, n) => String(s).padEnd(n);
const ROOT = path.join(__dirname, '..');

function offline() {
  console.log('\n  1. Offline suites (this machine)\n');
  let ok = true;
  for (const f of ['src/modules/loyalty/engine.test.js', 'src/modules/loyalty/flows.test.js']) {
    try {
      const out = execSync(`node "${path.join(ROOT, f)}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const m = out.match(/(\d+) assertions passed/);
      console.log(`  PASS  ${pad(f, 40)} ${m ? m[1] + ' checks' : ''}`);
    } catch (e) {
      ok = false;
      console.log(`  FAIL  ${f}\n${String(e.stdout || '').split('\n').slice(-15).join('\n')}${e.stderr || ''}`);
    }
  }
  return ok;
}

async function call(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method, headers: { 'Content-Type': 'application/json', 'x-admin-secret': SECRET },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} → HTTP ${res.status} ${json.error || ''}`);
  return json;
}

async function live() {
  console.log(`\n  2. Live self-test — ${BASE}\n`);
  if (!SECRET) { console.log('  SKIP  ADMIN_API_SECRET not set'); return false; }
  if (!params.customerId || !params.eligibleVariantId) { console.log('  SKIP  --customer and --eligible are required'); return false; }
  const start = await call('POST', '/api/loyalty/selftest', params);
  if (!start.started) console.log('  (a self-test was already running — showing that one)');
  let job;
  const seen = new Set();
  for (;;) {
    job = (await call('GET', '/api/loyalty/selftest')).job;
    for (const r of job.results) {
      const key = `${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`  ${pad(r.status, 5)} ${pad(r.id, 4)} ${r.name}${r.detail ? `\n               ${r.detail}` : ''}`);
    }
    if (!job.running) break;
    await new Promise(r => setTimeout(r, 4000));
  }
  console.log(`\n  ${job.pass} pass · ${job.fail} fail · ${job.skip} skip   (run ${job.runId})`);
  if (job.cleanupErrors.length) console.log(`  cleanup problems: ${job.cleanupErrors.join('; ')}`);
  return job.fail === 0;
}

(async () => {
  const a = offline();
  const b = await live().catch(e => { console.log(`  FAIL  live run: ${e.message}`); return false; });
  console.log(`\n  ${a && b ? 'ALL AUTOMATED CRITERIA PASSED' : 'SOMETHING FAILED — see above'}`);
  console.log('  Manual criteria (cart/profile UI, GoKwik): loyalty/UAT_LOYALTY.md\n');
  process.exit(a && b ? 0 : 1);
})();
