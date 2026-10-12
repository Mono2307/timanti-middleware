'use strict';

/**
 * The tier graphic on the customer-account profile block: the member's tier in its own colour and a
 * quiet progress track Silver → Gold → Platinum with each threshold underneath.
 *
 * Customer-account extensions only allow Shopify's own colour tones, so a gold "Gold" and a branded
 * track cannot be drawn there. The block shows this SVG instead (GET /api/loyalty/tier.svg?p=<points>).
 * It carries no customer data beyond the points number the block itself passes in.
 */

const TIER_COLOURS = {
  T1: '#8E9298',   // silver
  T2: '#B08D57',   // gold
  T3: '#6F6A75',   // platinum
};
const TRACK = '#E7E1D8';
const INK = '#1A1A1A';
const MUTED = '#8A857D';

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
  const W = 560, H = 132, x0 = 36, x1 = W - 36, y = 70;
  // Stops: start, then each tier evenly spaced, so the path reads as steps rather than raw rupees.
  const stops = [{ min: 0 }].concat(tiers);
  const xAt = (i) => x0 + (x1 - x0) * (i / (stops.length - 1));
  // Progress: linear inside the segment the points fall in.
  let px = x0;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i].min, b = stops[i + 1].min;
    if (pts >= b) { px = xAt(i + 1); continue; }
    px = xAt(i) + (xAt(i + 1) - xAt(i)) * Math.max(0, (pts - a) / (b - a));
    break;
  }
  let current = null;
  for (const t of tiers) if (pts >= t.min) current = t;
  const accent = current ? (TIER_COLOURS[current.key] || TIER_COLOURS.T2) : TIER_COLOURS.T2;
  const title = current ? `${current.name} Member` : 'Member';

  const markers = tiers.map((t, i) => {
    const cx = xAt(i + 1);
    const reached = pts >= t.min;
    const colour = TIER_COLOURS[t.key] || accent;
    const isCurrent = current && current.key === t.key;
    return `
    <circle cx="${cx}" cy="${y}" r="${isCurrent ? 6 : 4.5}" fill="${reached ? colour : '#FFFFFF'}" stroke="${reached ? colour : '#CFC7BA'}" stroke-width="1.5"/>
    <text x="${cx}" y="${y + 26}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="13" letter-spacing="1" fill="${isCurrent ? colour : INK}" ${isCurrent ? 'font-weight="600"' : ''}>${esc(t.name)}</text>
    <text x="${cx}" y="${y + 44}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="11" letter-spacing="0.6" fill="${MUTED}">${esc(lakh(t.min))} · ${esc(t.pct)}%</text>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
  <text x="${W / 2}" y="30" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="20" letter-spacing="3" fill="${accent}">${esc(title.toUpperCase())}</text>
  <line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${TRACK}" stroke-width="2" stroke-linecap="round"/>
  <line x1="${x0}" y1="${y}" x2="${px}" y2="${y}" stroke="${accent}" stroke-width="2" stroke-linecap="round"/>
  <circle cx="${x0}" cy="${y}" r="3" fill="${pts > 0 ? accent : TRACK}"/>${markers}
</svg>`;
}

module.exports = { tierSvg, TIER_COLOURS };
