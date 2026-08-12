#!/usr/bin/env node
/**
 * Daily health check against the live service.
 *
 *   node tools/health.js                    # check production
 *   node tools/health.js http://localhost:8080
 *
 * Read-only. Every endpoint here either reads or reports; none writes, converts, or consumes a
 * serial number, so this is safe to run at any time including during trading.
 *
 * Exit code is non-zero if anything failed, so it can drive an alert later if wanted.
 */

'use strict';

const BASE = process.argv[2] || 'https://timanti-middleware.fly.dev';
const today = new Date().toISOString().slice(0, 10);
const monthStart = today.slice(0, 8) + '01';

// `why` explains what a failure would actually mean — a status code alone does not tell you
// whether to panic.
const CHECKS = [
  { path: '/api/version',                                       why: 'which build is live' },
  { path: '/api/test-db',                                       why: 'database + configuration reachable' },
  { path: '/api/recon',                                         why: 'recon data folder resolves (this path broke once)' },
  { path: `/api/sales-report?from=${monthStart}&to=${today}`,   why: 'reporting over live data' },
  { path: `/api/adjustment-report?from=${monthStart}&to=${today}`, why: 'voucher / exchange reporting' },
  { path: '/api/recon-ledger?view=summary',                     why: 'credit-instrument ledger' },
  { path: '/api/serial-report?docType=customer_order',          why: 'document numbering' },
  { path: '/api/price-update-diag',                             why: 'gold-rate job files present in the image' },
  { path: '/api/serial/peek?docType=customer_order',            why: 'next serial readable (does not consume it)' },
];

const fetchWithTimeout = (url, ms = 45000) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { signal: ac.signal }).finally(() => clearTimeout(t));
};

(async () => {
  console.log(`\n  health check — ${BASE}`);
  console.log(`  ${new Date().toISOString()}\n`);

  // Report the build first: everything below is meaningless if the wrong version is live.
  try {
    const v = await (await fetchWithTimeout(`${BASE}/api/version`)).json();
    const layoutOk = v.layout === 'modular';
    console.log(`  build   ${v.commitShort}   layout: ${v.layout}${layoutOk ? '' : '   <-- OLD STRUCTURE'}`);
    console.log(`  uptime  ${(v.uptimeSec / 3600).toFixed(1)}h   since ${v.startedAt}\n`);
  } catch (e) {
    console.log(`  build   UNREACHABLE — ${e.message}\n`);
  }

  let failed = 0;
  for (const c of CHECKS) {
    let line;
    try {
      const res  = await fetchWithTimeout(BASE + c.path);
      const body = await res.text();
      const ok   = res.status === 200 && body.length > 4;
      if (!ok) failed++;
      line = `  ${ok ? 'ok  ' : 'FAIL'}  ${String(res.status).padEnd(4)}${String(body.length + 'b').padEnd(9)}${c.path}`;
      if (!ok) line += `\n        ${c.why}\n        ${body.slice(0, 160)}`;
    } catch (e) {
      failed++;
      line = `  FAIL  ---            ${c.path}\n        ${c.why}\n        ${e.message}`;
    }
    console.log(line);
  }

  console.log('');
  if (failed) {
    console.log(`  ${failed} of ${CHECKS.length} FAILED`);
    console.log('  Roll back with Actions -> Deploy Specific Commit -> a3a0dc78...');
    console.log('  See docs/CONTINUITY.md\n');
  } else {
    console.log(`  all ${CHECKS.length} healthy\n`);
  }
  process.exit(failed ? 1 : 0);
})();
