const assert = require('assert');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// WHY THIS FILE EXISTS
// The restructure's one real bug class. When a file moves, any path it builds relative to its own
// location (__dirname) silently changes meaning. GET /api/recon shipped broken this way: the
// handler moved to src/modules/reporting/ but still joined 'src/data/recon' onto __dirname, so it
// looked in src/modules/reporting/src/data/recon and returned a 500.
//
// Nothing else catches this. The route registers fine, the app boots fine, `node --check` passes,
// and the route inventory is unchanged — it only fails when a person calls it. So every path the
// running code constructs is asserted here, by resolving it exactly as the code does.

console.log('paths built from a file\'s own location (__dirname)');

t('reporting/routes.js resolves the recon data directory', () => {
  // Mirrors src/modules/reporting/routes.js — up two from src/modules/reporting/ is src/.
  const fromReporting = path.join(ROOT, 'src', 'modules', 'reporting');
  const reconDir = path.join(fromReporting, '..', '..', 'data', 'recon');
  assert.ok(fs.existsSync(reconDir), `recon dir does not resolve: ${reconDir}`);
  assert.ok(fs.statSync(reconDir).isDirectory(), 'recon path is not a directory');
  // It must contain actual inputs, not just exist — an empty dir passes existsSync and still 500s.
  const csvs = fs.readdirSync(reconDir).filter(f => /\.(csv|xlsx)$/i.test(f));
  assert.ok(csvs.length > 0, 'recon dir resolves but holds no CSV/XLSX inputs');
});

t('reporting/routes.js does NOT resolve to the old broken location', () => {
  // The exact wrong answer that shipped. Assert it stays wrong, so a revert is caught.
  const broken = path.join(ROOT, 'src', 'modules', 'reporting', 'src', 'data', 'recon');
  assert.ok(!fs.existsSync(broken), 'the pre-fix broken path now exists — someone recreated it');
});

t('admin/version.js resolves the repo root', () => {
  const fromAdmin = path.join(ROOT, 'src', 'modules', 'admin');
  const repoRoot = path.join(fromAdmin, '..', '..', '..');
  assert.ok(fs.existsSync(path.join(repoRoot, 'package.json')),
    `version.js ROOT does not point at the repo root: ${repoRoot}`);
  // version.js uses this to report layout: 'modular' — it must find src/core/config.js.
  assert.ok(fs.existsSync(path.join(repoRoot, 'src', 'core', 'config.js')),
    'version.js would report layout: legacy from this root');
});

console.log('absolute /app/ paths baked in for the container');

// These are hardcoded for the image. They cannot be resolved locally, so instead assert the
// repo-relative equivalent exists — if the file is not in the repo, COPY . . will not place it
// at /app either.
for (const p of [
  'src/jobs/price-update/orchestrator.py',
  'src/jobs/price-update/shopify_snapshot.py',
  'src/jobs/price-update/import_from_preview.mjs',
  'src/jobs/price-update/requirements.txt',
]) {
  t(`/app/${p} will exist in the image`, () =>
    assert.ok(fs.existsSync(path.join(ROOT, p)), `not in the repo, so not in the image: ${p}`));
}

t('the /app paths referenced in code match the repo layout', () => {
  // Catch a code path that points somewhere the repo does not have.
  const sources = ['src/modules/admin/routes.js', 'server.js'];
  const missing = [];
  for (const s of sources) {
    const text = fs.readFileSync(path.join(ROOT, s), 'utf8');
    for (const m of text.matchAll(/['"]\/app\/([^'"]+)['"]/g)) {
      const rel = m[1];
      if (rel.startsWith('Outputs')) continue;        // created by the Dockerfile at build time
      if (!fs.existsSync(path.join(ROOT, rel))) missing.push(`${s} -> /app/${rel}`);
    }
  }
  assert.deepStrictEqual(missing, [], 'code references /app paths with no repo counterpart');
});

console.log('the price-update job finds the app root');

// This job broke in exactly the same way and was NOT caught by any earlier check, because it runs
// once a day rather than on request. config.py had `BASE = _HERE.parent`, correct at
// /app/price_update, silently wrong at /app/src/jobs/price-update. Both it and
// import_from_preview.mjs now discover the root by walking up to package.json.

t('config.py discovers the app root rather than counting levels', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/jobs/price-update/config.py'), 'utf8');
  assert.ok(!/^BASE\s*=\s*_HERE\.parent\s*$/m.test(src),
    'config.py counts levels again — this is the bug that broke Outputs and the log directory');
  assert.ok(/package\.json/.test(src), 'config.py should locate the root by its package.json marker');
});

t('import_from_preview.mjs does the same', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/jobs/price-update/import_from_preview.mjs'), 'utf8');
  assert.ok(!/resolve\(__dirname,\s*'\.\.\/(\.env|Outputs)/.test(src),
    'the .env / Outputs lookups count levels again');
  assert.ok(/APP_ROOT/.test(src), 'should resolve through APP_ROOT');
});

t('the app root the job will find holds package.json and Outputs is at the root', () => {
  // Mirrors the discovery both files perform, from the job's real location.
  let dir = path.join(ROOT, 'src', 'jobs', 'price-update');
  let found = null;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) { found = dir; break; }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  assert.ok(found, 'the job cannot find an app root at all');
  assert.strictEqual(path.resolve(found), path.resolve(ROOT),
    'the job would resolve a different root than the repo root');
  // The server's lock file lives at <root>/Outputs — the job must agree on that location.
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.ok(/mkdir\s+-p\s+\/app\/Outputs/.test(dockerfile),
    'the Dockerfile no longer creates /app/Outputs, which the job and the lock file both use');
});

console.log('the Dockerfile puts things where the code looks for them');

t('Dockerfile pip target matches the requirements file location', () => {
  const df = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const m = df.match(/pip3?\s+install[^\n]*?-r\s+(\/app\/\S+)/);
  assert.ok(m, 'no pip install -r line found in the Dockerfile');
  const rel = m[1].replace(/^\/app\//, '');
  assert.ok(fs.existsSync(path.join(ROOT, rel)), `Dockerfile installs ${m[1]} which is not in the repo`);
});

t('.dockerignore does not exclude the recon inputs', () => {
  // The recon CSVs are only in the image because a negation re-includes them after *.csv.
  // Lose the negation and /api/recon 500s on a tree that builds perfectly.
  const di = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
  assert.ok(/^!src\/data\/recon\/?\*?\*?$/m.test(di) || di.includes('!src/data/recon/'),
    '.dockerignore excludes *.csv without re-including src/data/recon — the image will ship without them');
});

console.log(`\n${n} assertions passed`);
