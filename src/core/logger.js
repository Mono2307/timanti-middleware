'use strict';

/**
 * Module-prefixed logging.
 *
 * Fly aggregates stdout from one process, so a bare console.log gives no clue which subsystem
 * emitted it — and with ~85 endpoints across nine domains, "Draft updated" is not a useful log
 * line. Every message here carries its module, so `flyctl logs | grep '[pricing]'` works.
 *
 *   log.info('pricing', 'repriced #D1234', { lines: 3 })   →  [pricing] repriced #D1234 { lines: 3 }
 *
 * Deliberately thin: no transport, no dependency, no async. Fly captures stdout/stderr and that
 * is the whole logging pipeline. If structured JSON logs are ever wanted, this is the one file
 * that changes.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

const emit = (level, stream) => (moduleName, ...args) => {
  if (LEVELS[level] < threshold) return;
  stream(`[${moduleName}]`, ...args);
};

const log = {
  debug: emit('debug', console.log),
  info:  emit('info',  console.log),
  warn:  emit('warn',  console.warn),
  error: emit('error', console.error),

  /**
   * Bind a module name once so handlers do not repeat it.
   *   const log = require('../../core/logger').for('pricing');
   *   log.info('repriced #D1234');
   */
  for(moduleName) {
    return {
      debug: (...a) => log.debug(moduleName, ...a),
      info:  (...a) => log.info(moduleName, ...a),
      warn:  (...a) => log.warn(moduleName, ...a),
      error: (...a) => log.error(moduleName, ...a),
    };
  },
};

module.exports = { log, LEVELS };
