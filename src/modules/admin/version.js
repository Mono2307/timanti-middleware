'use strict';

/**
 * GET /api/version — which build is actually running?
 *
 * Every other health endpoint returns 200 whether the old or the new code answered, so there was
 * no way to confirm a deploy had taken effect other than watching the Actions log. That matters
 * most during a cutover, when "is this the version I just deployed, or the one before it?" is the
 * only question worth asking.
 *
 * GIT_SHA is stamped into the image at build time by both deploy workflows
 * (--build-arg GIT_SHA=…). It reads 'unknown' for a local run or an image built by hand.
 *
 * `layout` distinguishes the restructured tree from the pre-restructure one at a glance, without
 * needing to know commit hashes.
 */

const fs   = require('fs');
const path = require('path');

const STARTED_AT = new Date().toISOString();
const ROOT = path.join(__dirname, '..', '..', '..');

function register(app) {
  app.get('/api/version', (_req, res) => {
    const sha = process.env.GIT_SHA || 'unknown';
    res.json({
      ok: true,
      commit:    sha,
      commitShort: sha.slice(0, 7),
      // 'modular' = the src/ restructure; 'legacy' = the old flat services/ tree.
      layout:    fs.existsSync(path.join(ROOT, 'src', 'core', 'config.js')) ? 'modular' : 'legacy',
      startedAt: STARTED_AT,
      uptimeSec: Math.round(process.uptime()),
      node:      process.version,
    });
  });
}

module.exports = { register };
