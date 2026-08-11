#!/usr/bin/env node
/**
 * npm run verify — the gate that must pass after every refactor commit.
 *
 *   1. syntax      every tracked .js/.mjs parses
 *   2. tests       npm test (installment money math)
 *   3. routes      the HTTP surface is byte-identical to tools/baseline-routes.txt
 *   4. dockerfile  every path the Dockerfile references still exists
 *
 * Step 4 stands in for `docker build`, which cannot run here — the Docker daemon is not
 * reachable on this machine. It catches the realistic failure mode of a file-moving refactor
 * (a COPY/RUN path that no longer resolves) without needing a builder. The genuine image
 * build still happens on Fly's remote builders at deploy time.
 *
 * Exit code is non-zero if any step fails, so it can gate a commit.
 */

'use strict';

const { execFileSync, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const steps = [];
let failed = false;

function run(name, fn) {
  process.stdout.write(`\n── ${name} ${'─'.repeat(Math.max(0, 58 - name.length))}\n`);
  try {
    const detail = fn();
    steps.push([name, 'PASS', detail || '']);
    console.log(`   PASS  ${detail || ''}`);
  } catch (err) {
    failed = true;
    steps.push([name, 'FAIL', (err.message || '').split('\n')[0]]);
    console.error(`   FAIL  ${err.message}`);
    if (err.stdout) console.error(String(err.stdout));
  }
}

// ── 1. syntax ────────────────────────────────────────────────────────────────
run('syntax — node --check on every tracked JS file', () => {
  const files = execSync('git ls-files -z "*.js" "*.mjs"', { cwd: ROOT })
    .toString().split('\0').filter(Boolean)
    .filter(f => !f.startsWith('node_modules/') && !f.includes('/node_modules/'));
  const bad = [];
  for (const f of files) {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); }
    catch { bad.push(f); }
  }
  if (bad.length) throw new Error(`${bad.length} file(s) failed to parse:\n     ${bad.join('\n     ')}`);
  return `${files.length} files parse`;
});

// ── 2. tests ─────────────────────────────────────────────────────────────────
run('tests — npm test', () => {
  const out = execSync('npm test --silent', { cwd: ROOT, stdio: 'pipe' }).toString();
  const m = out.match(/(\d+) assertions passed/g) || [];
  const total = m.reduce((s, x) => s + parseInt(x, 10), 0);
  return total ? `${total} assertions passed` : 'tests ran';
});

// ── 3. routes ────────────────────────────────────────────────────────────────
run('routes — HTTP surface matches the baseline', () => {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, 'route-inventory.js'), '--check'],
      { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    return out.replace(/^route-inventory:\s*/, '');
  } catch (err) {
    throw new Error(`route drift\n${String(err.stdout || '')}${String(err.stderr || '')}`);
  }
});

// ── 4. dockerfile path integrity ─────────────────────────────────────────────
run('dockerfile — referenced paths still exist', () => {
  const df = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const missing = [];
  const checked = [];

  // COPY <src>... <dest>  — skip --from=build stage copies and the bare "COPY . ."
  for (const line of df.split('\n')) {
    const copy = line.match(/^\s*COPY\s+(?!--from)(.+)$/i);
    if (copy) {
      const parts = copy[1].trim().split(/\s+/);
      for (const src of parts.slice(0, -1)) {
        if (src === '.' || src.startsWith('--')) continue;
        checked.push(src);
        if (!fs.existsSync(path.join(ROOT, src))) missing.push(`COPY ${src}`);
      }
    }
    // absolute /app/... paths referenced by RUN (e.g. pip install -r /app/.../requirements.txt)
    for (const m of line.matchAll(/\/app\/([^\s'"]+)/g)) {
      const rel = m[1];
      if (rel.startsWith('Outputs')) continue;           // created by the Dockerfile itself
      checked.push(rel);
      if (!fs.existsSync(path.join(ROOT, rel))) missing.push(`${line.trim().slice(0, 40)}… → /app/${rel}`);
    }
  }

  // Runtime paths the server reads or spawns — these break silently, not at build time.
  const runtime = [
    ['src/jobs/price-update/orchestrator.py', 'spawned by /api/trigger-price-update'],
    ['src/data/recon',                'read by GET /api/recon'],
  ];
  for (const [p, why] of runtime) {
    checked.push(p);
    if (!fs.existsSync(path.join(ROOT, p))) missing.push(`${p}  (${why})`);
  }

  if (missing.length) throw new Error(`${missing.length} missing path(s):\n     ${missing.join('\n     ')}`);
  return `${checked.length} paths resolve`;
});

// ── summary ──────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(64));
for (const [name, status, detail] of steps) {
  console.log(`  ${status === 'PASS' ? 'PASS' : 'FAIL'}  ${name.split(' —')[0].padEnd(12)} ${detail}`);
}
console.log('='.repeat(64));
console.log(failed ? '  VERIFY FAILED\n' : '  VERIFY OK\n');
process.exit(failed ? 1 : 0);
