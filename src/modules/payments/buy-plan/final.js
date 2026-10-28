'use strict';

// Buy plan — the equal plan's final reprice (see schedule.js for the two plan types).
//
// On the date of installment 6 the draft is repriced at that day's gold rate, the same way staff
// reprice any draft: today's rate per piece goes into custom.gold_rate (positional over the jewellery
// lines) and the draft is tagged `reprice`. The `buy-plan-final` tag lets that one reprice through the
// lock, and the reprice itself swaps it for `rate-locked` (lock.js), so the new price is locked as soon
// as it is written. The sweep then reads the new net-to-collect as the plan's final price.
//
// Today's rate for a piece is its variant's custom.gold_rate (the daily price job writes the day's
// rate for that karat onto every variant). A custom line with no variant takes the day's sale rate
// for the karat whose rate at the plan's start was nearest the rate the line was priced at.

const { getJson, putJson, getBuyingRateTable } = require('../../../core/shopify');
const { updateDraftOrderMetafields } = require('../../../core/metafields');
const { productLines, prop, rs, GST } = require('./draft');
const { RATE_LOCK_TAG, FINAL_REPRICE_TAG } = require('./lock');

function nearestKarat(rate, table) {
  let best = null;
  let bestGap = Infinity;
  for (const [k, v] of Object.entries(table || {})) {
    const r = Number(v);
    if (!(r > 0) || !(rate > 0)) continue;
    const gap = Math.abs(Math.log(rate / r));
    if (gap < bestGap) { bestGap = gap; best = k; }
  }
  return best;
}

// Pure. One row per jewellery line, in custom.gold_rate order: its gold, the rate it is priced at,
// and today's rate (null if none could be found).
function lineRates(lineItems, { variantRates = {}, saleRates = {}, startSaleRates = null, draftRates = '' } = {}) {
  const overrides = String(draftRates || '').split(',').map(v => parseFloat(v) || 0);
  return productLines(lineItems).map((li, idx) => {
    const oldRate = overrides[idx] > 0 ? overrides[idx] : rs(prop(li, '_gold_rate'));
    let newRate = Number(variantRates[String(li.variant_id)]) || 0;
    if (!(newRate > 0) && oldRate > 0) {
      const ref = startSaleRates && Object.keys(startSaleRates).length ? startSaleRates : saleRates;
      newRate = Number(saleRates[nearestKarat(oldRate, ref)]) || 0;
    }
    return { idx, title: li.title || '', gold: rs(prop(li, 'Gold')), oldRate, newRate: newRate > 0 ? Math.round(newRate * 100) / 100 : null };
  });
}

// Pure. Roughly how far the price moves at these rates. Gold is the only part the reprice changes.
function estimateDelta(rates) {
  return Math.round(rates.reduce((sum, r) =>
    sum + (r.newRate && r.oldRate ? r.gold * (r.newRate / r.oldRate - 1) : 0), 0) * GST);
}

async function todaysRates(plan, d) {
  const variantRates = {};
  for (const li of productLines(d.draft.line_items)) {
    if (!li.variant_id || variantRates[li.variant_id] !== undefined) continue;
    try {
      const { metafields = [] } = await getJson(`variants/${li.variant_id}/metafields.json`);
      const m = metafields.find(x => x.namespace === 'custom' && x.key === 'gold_rate');
      variantRates[li.variant_id] = m ? parseFloat(m.value) || 0 : 0;
    } catch { variantRates[li.variant_id] = 0; }
  }
  const table = await getBuyingRateTable();
  return lineRates(d.draft.line_items, {
    variantRates, saleRates: table?.sale_rates || {}, startSaleRates: plan.start_rates || null, draftRates: d.mf.gold_rate,
  });
}

// What the final installment would be at today's rate — for the reminder 3 days before.
async function estimateFinal(plan, d) {
  const rates = await todaysRates(plan, d);
  return Math.max(0, Math.round(Number(plan.total)) + estimateDelta(rates));
}

// Write today's rates and ask for the reprice. Throws (and changes nothing) if any piece has no rate.
async function startFinalReprice(plan, d) {
  const rates = await todaysRates(plan, d);
  if (!rates.length) throw new Error('no jewellery lines to reprice');
  const missing = rates.filter(r => !r.newRate);
  if (missing.length) throw new Error(`no gold rate today for: ${missing.map(r => r.title || `line ${r.idx + 1}`).join(', ')}`);
  await updateDraftOrderMetafields(d.id, { gold_rate: rates.map(r => r.newRate.toFixed(2)).join(',') });
  const tags = [...new Set([...d.tags.filter(t => t.toLowerCase() !== RATE_LOCK_TAG), FINAL_REPRICE_TAG, 'reprice'])];
  await putJson(`draft_orders/${d.id}.json`, { draft_order: { id: d.id, tags: tags.join(', ') } });
  return rates;
}

// The reprice has run once the draft carries rate-locked again and no longer carries the final tag.
const finalRepriceDone = (tags) => {
  const list = (tags || []).map(t => String(t).toLowerCase());
  return list.includes(RATE_LOCK_TAG) && !list.includes(FINAL_REPRICE_TAG) && !list.includes('reprice');
};

module.exports = { lineRates, estimateDelta, nearestKarat, estimateFinal, startFinalReprice, finalRepriceDone };
