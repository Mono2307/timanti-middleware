'use strict';

/**
 * The staff discount breakup — which scheme each rupee of a draft's discount came from.
 *
 * WHY THIS FILE EXISTS
 * Since 2026-10-21 three discounts can sit on one line together (founder's call): the CAMPAIGN's
 * automatic diamond discount, a MANUAL cut staff typed in, and LOYALTY. The line props only say how
 * much came off the diamond and the making ('Discount on Diamond' / 'Discount on Making'), not on
 * whose account, so staff could not tell the customer "₹X is the Dussehra offer, ₹Y your Gold
 * benefit". This splits the same rupees by source, and the reprice publishes the result in
 * custom.discount_breakup for the panel. Staff-only: nothing customer-facing reads it.
 *
 * SOURCES — read off each custom.line_discounts entry's `src`:
 *   'auto-dia'  → campaign  (the automatic diamond discount; its `camp` names the campaign)
 *   'loyalty'   → loyalty
 *   'native'    → other     (a Shopify collection / order discount captured onto the line)
 *   anything else, or none → manual (what staff typed in the per-line editor)
 * An order-level code is not a per-line entry; on a line with no entries it lands as `code`.
 *
 * ADDS UP. Each target's cut is capped at its base (diamond, making, line taxable) and the line's total
 * at its taxable value — exactly as resolveLineDiscount in server.js does — and every source is scaled
 * by the same cap, so the sources always sum to the line's Discount Applied, to the paisa before
 * rounding. Pre-tax rupees throughout, like every other discount figure in the engine.
 */

const SOURCES = ['campaign', 'manual', 'loyalty', 'other', 'code'];

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** Which breakup row a custom.line_discounts entry belongs to. */
function sourceOf(entry) {
  const src = String((entry && entry.src) || '').toLowerCase();
  if (src === 'auto-dia') return 'campaign';
  if (src === 'loyalty') return 'loyalty';
  if (src === 'native') return 'other';
  return 'manual';
}

/** "2026-10-21" → "21/10/26". Empty for anything else. */
function ddmmyy(iso) {
  const m = String(iso || '').match(/^\d{2}(\d{2})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/**
 * The campaign's label, as staff read it: "Dussehra 2026 (21/10/26-08/11/26)".
 * campaign: { name, start, end } (YYYY-MM-DD). Falls back to a plain description with no name.
 */
function campaignLabel(campaign) {
  const name = String((campaign && campaign.name) || '').trim();
  if (!name) return 'Auto diamond discount';
  const a = ddmmyy(campaign.start);
  const b = ddmmyy(campaign.end);
  return a && b ? `${name} (${a}-${b})` : name;
}

/**
 * Split one line's capped discount portions by source.
 *
 * raw: { dia: {src: Rs}, mk: {src: Rs}, tot: {src: Rs} } — UNCAPPED cut per target per source.
 * capped: { dia, mk, tot, total } — the line's portions after the engine's caps.
 * Returns { campaign, manual, loyalty, other, code } in pre-tax Rs; sums to capped.total.
 */
function splitBySource(raw, capped) {
  const out = Object.fromEntries(SOURCES.map(s => [s, 0]));
  const sumOf = (o) => Object.values(o || {}).reduce((s, v) => s + (Number(v) || 0), 0);
  const parts = ['dia', 'mk', 'tot'];
  const portion = { dia: capped.dia || 0, mk: capped.mk || 0, tot: capped.tot || 0 };
  const beforeClamp = portion.dia + portion.mk + portion.tot;
  const clamp = beforeClamp > 0 ? (capped.total || 0) / beforeClamp : 0;
  for (const p of parts) {
    const rawSum = sumOf(raw[p]);
    if (!(rawSum > 0)) continue;
    const scale = (portion[p] / rawSum) * clamp;
    for (const [src, v] of Object.entries(raw[p])) out[src] += (Number(v) || 0) * scale;
  }
  return out;
}

/**
 * The order-level breakup from the per-line splits.
 *
 * lines: [{ bySrc: {campaign, manual, loyalty, other, code}, campaigns: [label] }]
 * fallbackCampaign: the label for auto entries stamped before campaigns were (no `camp`).
 * Returns { campaign: { label, amount }, manual, loyalty, other, code, total } — Rs, 2 dp — or null
 * when nothing at all is discounted.
 */
function buildBreakup(lines, { fallbackCampaign = 'Auto diamond discount' } = {}) {
  const sum = Object.fromEntries(SOURCES.map(s => [s, 0]));
  const labels = [];
  for (const l of lines || []) {
    if (!l || !l.bySrc) continue;
    for (const s of SOURCES) sum[s] += Number(l.bySrc[s]) || 0;
    for (const c of l.campaigns || []) if (c && !labels.includes(c)) labels.push(c);
  }
  const total = SOURCES.reduce((s, k) => s + sum[k], 0);
  if (!(total > 0.005)) return null;
  return {
    campaign: { label: sum.campaign > 0.005 ? (labels.join(' + ') || fallbackCampaign) : '', amount: r2(sum.campaign) },
    manual: r2(sum.manual),
    loyalty: r2(sum.loyalty),
    other: r2(sum.other),
    code: r2(sum.code),
    total: r2(total),
  };
}

/** The JSON the reprice stores in custom.discount_breakup, or '' when there is nothing to store. */
function breakupJson(breakup) {
  return breakup ? JSON.stringify(breakup) : '';
}

module.exports = { SOURCES, sourceOf, ddmmyy, campaignLabel, splitBySource, buildBreakup, breakupJson };
