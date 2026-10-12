'use strict';

/**
 * The slim tier timeline on the customer-account profile block: a hairline track from ₹0 through
 * Silver → Gold → Platinum, filled to the member's lifetime spend, with each stage's name and
 * threshold in small type underneath and the current stage in its tier colour.
 *
 * Customer-account extensions only allow Shopify's own colour tones, so the gold fill and gold label
 * cannot be drawn there; the block shows this SVG instead (GET /api/loyalty/tier.svg?p=<points>).
 * It is deliberately about one line of text tall (600×40) so the block barely grows. It carries no
 * customer data beyond the points number the block passes in.
 */

const TIER_COLOURS = {
  T1: '#8E9298',   // silver
  T2: '#B08D57',   // gold
  T3: '#6F6A75',   // platinum
};
const TRACK = '#E4DED4';
const INK = '#3A3A3A';
const MUTED = '#9A948B';
const FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const lakh = (v) => {
  const n = Number(v) || 0;
  if (n >= 100000) return `₹${+(n / 100000).toFixed(n % 100000 ? 1 : 0)}L`;
  return `₹${Math.round(n / 1000)}K`;
};

/**
 * @param {number} points  lifetime points
 * @param {object} cfg     normalised loyalty config (tiers sorted by min)
 */
function tierSvg(points, cfg) {
  const tiers = (cfg.tiers || []).slice(0, 3);
  const pts = Math.max(0, Number(points) || 0);
  const W = 600, H = 40, x0 = 8, x1 = W - 8, y = 9;
  // Stages evenly spaced (₹0, then each tier), so the track reads as steps rather than raw rupees.
  const stops = [{ min: 0 }].concat(tiers);
  const xAt = (i) => x0 + (x1 - x0) * (i / (stops.length - 1));
  let px = x0;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i].min, b = stops[i + 1].min;
    if (pts >= b) { px = xAt(i + 1); continue; }
    px = xAt(i) + (xAt(i + 1) - xAt(i)) * Math.max(0, (pts - a) / (b - a));
    break;
  }
  let current = null;
  for (const t of tiers) if (pts >= t.min) current = t;
  const fill = current ? (TIER_COLOURS[current.key] || TIER_COLOURS.T2) : TIER_COLOURS.T2;

  const marks = tiers.map((t, i) => {
    const cx = xAt(i + 1);
    const reached = pts >= t.min;
    const isCurrent = current && current.key === t.key;
    const colour = TIER_COLOURS[t.key] || fill;
    // Last label right-aligned so it never runs off the edge.
    const anchor = i === tiers.length - 1 ? 'end' : 'middle';
    const lx = i === tiers.length - 1 ? x1 : cx;
    return `<circle cx="${cx}" cy="${y}" r="${isCurrent ? 4.5 : 3.5}" fill="${reached ? colour : '#FFFFFF'}" stroke="${reached ? colour : '#CDC5B8'}" stroke-width="1.25"/>`
      + `<text x="${lx}" y="${y + 23}" text-anchor="${anchor}" font-family="${FONT}" font-size="12" letter-spacing="0.4">`
      + `<tspan fill="${isCurrent ? colour : INK}" font-weight="${isCurrent ? 600 : 400}">${esc(t.name)}</tspan>`
      + `<tspan fill="${MUTED}"> ${esc(lakh(t.min))}</tspan></text>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(current ? current.name + ' member' : 'Timanti Loyalty')}">`
    + `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${TRACK}" stroke-width="1.5" stroke-linecap="round"/>`
    + (px > x0 ? `<line x1="${x0}" y1="${y}" x2="${px}" y2="${y}" stroke="${fill}" stroke-width="1.5" stroke-linecap="round"/>` : '')
    + `<circle cx="${x0}" cy="${y}" r="2.5" fill="${pts > 0 ? fill : TRACK}"/>`
    + marks
    + `</svg>`;
}

module.exports = { tierSvg, TIER_COLOURS };
