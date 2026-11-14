'use strict';

/**
 * Design-code (Gati ID) matching for the lookbook search box.
 *
 * THE PROBLEM IT SOLVES
 * Design codes come in families that differ by one trailing letter: RG00048 and RG00048A are two
 * different pieces. A plain substring search for "rg00048" matches both, and the grid used to show
 * them as two cards with near-identical titles and nothing to tell them apart, so staff picked the
 * wrong one. Staff also type the short form ("RG48") which a substring search never matches at all.
 *
 * HOW A QUERY IS READ
 *   RG00048  -> exactly RG00048 first, then its letter variants (RG00048A, RG00048B)
 *   RG48     -> the same: leading zeros are not significant, so RG48 == RG00048
 *   RG48A    -> exactly RG00048A, and nothing else from the family
 *   RG00 / RG4 -> typeahead: every code that continues what has been typed
 *
 * These functions are shipped to the browser verbatim (page.js injects their source), so they are
 * written in plain ES5, with no template literals and nothing from Node.
 */

/** Upper-case, and drop spaces, dashes and pipes: "rg-00048 a" and "RG00048A" are the same code. */
function normCode(s) {
  return String(s === null || s === undefined ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Letters, digits, then an optional suffix. "RG00048A" -> { p: 'RG', d: '00048', s: 'A' }. */
function parseCode(s) {
  var m = /^([A-Z]+)(\d+)([A-Z0-9]*)$/.exec(normCode(s));
  return m ? { p: m[1], d: m[2], s: m[3] } : null;
}

/** Does the query look like a design code (letters followed by at least one digit)? */
function looksLikeCode(q) {
  return /^[A-Z]+\d/.test(normCode(q));
}

/**
 * How well `code` answers the query `q`:
 *   3  the same code ("RG48" or "RG00048" for RG00048)
 *   2  the same design number with a letter suffix ("RG48" for RG00048A)
 *   1  a typeahead continuation ("RG00" or "RG4" for RG00048)
 *   0  no match
 */
function codeScore(q, code) {
  var nq = normCode(q), nc = normCode(code);
  if (!nq || !nc) return 0;
  if (nq === nc) return 3;
  var a = parseCode(nq), b = parseCode(nc);
  if (a && b && a.p === b.p) {
    var an = String(Number(a.d)), bn = String(Number(b.d));
    if (an === bn) {
      if (a.s === b.s) return 3;
      if (b.s.indexOf(a.s) === 0) return 2;
      return 0;   // RG48A must not offer RG00048B
    }
    // The typed number is still being typed: RG4 continues to RG00040..RG00049, RG00400...
    if (!a.s && bn.indexOf(an) === 0) return 1;
  }
  if (nc.indexOf(nq) === 0) return 1;
  return 0;
}

/** Best score over a list of codes (a product can carry more than one design code). */
function bestCodeScore(q, codes) {
  var best = 0;
  for (var i = 0; codes && i < codes.length; i++) {
    var s = codeScore(q, codes[i]);
    if (s > best) best = s;
  }
  return best;
}

/**
 * Order for suggestions: score, then A-Z. A-Z keeps a family together (RG00048, RG00048A,
 * RG00048B, then RG00049) instead of scattering the letter variants after every shorter code.
 */
function compareSuggestions(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  return a.code < b.code ? -1 : (a.code > b.code ? 1 : 0);
}

const CLIENT_SOURCE = [normCode, parseCode, looksLikeCode, codeScore, bestCodeScore, compareSuggestions]
  .map((fn) => fn.toString())
  .join('\n');

module.exports = {
  normCode, parseCode, looksLikeCode, codeScore, bestCodeScore, compareSuggestions, CLIENT_SOURCE,
};
