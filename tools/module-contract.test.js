const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

// Env sufficient for module construction; nothing here dials out.
process.env.SUPABASE_URL         ||= 'https://module-contract.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL    ||= 'https://module-contract.invalid';

const ROOT = path.join(__dirname, '..');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// Why this file exists: the restructure moved ~1,600 lines of routing into modules behind a
// register(app, ctx) contract. Nothing enforced that contract, so a module could quietly drift
// back to reaching for process.env or requiring the bootstrap, and the structure would rot
// without anything failing. These assertions are the enforcement.

const MODULES = ['reporting', 'serialization', 'procurement', 'admin'];

console.log('every module exposes register(app, ctx)');
for (const m of MODULES) {
  t(`${m} exports register`, () => {
    const mod = require(path.join(ROOT, 'src', 'modules', m, 'routes.js'));
    assert.strictEqual(typeof mod.register, 'function', `${m}.register must be a function`);
    assert.ok(mod.register.length >= 1, `${m}.register must accept (app, ctx)`);
  });
}

console.log('registering twice on a fresh app yields the same routes (no hidden state)');
t('reporting is idempotent across app instances', () => {
  const express = require('express');
  const count = () => {
    const app = express();
    require(path.join(ROOT, 'src', 'modules', 'reporting', 'routes.js')).register(app, {});
    return app._router.stack.filter(l => l.route).length;
  };
  assert.strictEqual(count(), count());
  assert.ok(count() > 0, 'reporting registered no routes at all');
});

// A RATCHET, not a clean-slate assertion. 15 files still read process.env directly — bodies that
// were moved verbatim during the restructure and not yet rewired to core/config. Rewriting them
// all at once would mean touching live payment and pricing code for a cosmetic gain, so instead
// this pins the current set: the list may SHRINK freely, but a new offender fails the build.
// Delete names from here as they are migrated; when it is empty, replace this with `=== 0`.
const ENV_READERS_BASELINE = new Set([
  'src/modules/admin/routes.js',
  'src/modules/admin/version.js',          // reads GIT_SHA — legitimate, it IS the build stamp
  'src/modules/after-sales/index.js',
  'src/modules/procurement/action.js',
  'src/modules/procurement/batch.js',
  'src/modules/procurement/routes.js',
  'src/modules/procurement/sync.js',
  'src/modules/procurement/webhook.js',
  'src/modules/reporting/routes.js',
  'src/modules/serialization/routes.js',
  'src/integrations/email/index.js',
  'src/integrations/email/templates.js',
  'src/integrations/gokwik/index.js',
  'src/integrations/sms/index.js',
  'src/integrations/typeform/index.js',
]);

console.log('no NEW module starts reading process.env directly');
t(`the env-reader list only shrinks (baseline: ${ENV_READERS_BASELINE.size})`, () => {
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js') || e.name.endsWith('.test.js')) continue;
      // Strip comments so a documented mention does not count as a read.
      const code = fs.readFileSync(p, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/process\.env\./.test(code)) found.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
  };
  walk(path.join(ROOT, 'src', 'modules'));
  walk(path.join(ROOT, 'src', 'integrations'));

  const added = found.filter(f => !ENV_READERS_BASELINE.has(f));
  assert.deepStrictEqual(added, [],
    'new direct process.env reads — import from core/config instead:\n     ' + added.join('\n     '));

  const fixed = [...ENV_READERS_BASELINE].filter(f => !found.includes(f));
  if (fixed.length) console.log(`       (${fixed.length} migrated since the baseline — trim the list)`);
});

console.log('no module requires the bootstrap (that would be a dependency cycle)');
t('nothing under src/ requires server.js', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      if (/require\([^)]*server(\.js)?['"]\)/.test(fs.readFileSync(p, 'utf8'))) {
        offenders.push(path.relative(ROOT, p));
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  assert.deepStrictEqual(offenders, [], 'modules must receive what they need via ctx');
});

console.log('the three runtime disk paths still resolve');
for (const [p, why] of [
  ['src/jobs/price-update/orchestrator.py', 'spawned by /api/trigger-price-update'],
  ['src/jobs/price-update/requirements.txt', 'pip-installed by the Dockerfile'],
  ['src/data/recon',                        'read by GET /api/recon'],
]) {
  t(`${p} — ${why}`, () => assert.ok(fs.existsSync(path.join(ROOT, p)), `missing: ${p}`));
}

console.log(`\n${n} assertions passed`);
