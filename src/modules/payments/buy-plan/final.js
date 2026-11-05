'use strict';

// Buy plan — repricing a plan draft at today's gold rate: the equal plan's final price, and a
// product change (see schedule.js for the plan types).
//
// FINAL PRICE (equal plan). Three days before the last installment's date ONLY the gold in each piece
// moves to that day's rate; diamonds, gemstones and making stay at the prices on the draft (founder,
// 2026-11-05). So this is not the pricing engine's reprice, which re-reads every part from the catalog:
// each line's Gold property is scaled by today's rate over the rate it was priced at (its _gold_rate),
// and the line's price moves by that difference plus GST. The lines are written straight back, the
// draft tagged rate-locked + sync-payment; the draft webhook recomputes the collect figures and consumes
// sync-payment, and the sweep then reads the new net-to-collect as the plan's final price.
//
// PRODUCT CHANGE. The new piece has no earlier price, so it goes through the engine: today's rate per
// piece goes into custom.gold_rate (positional over the jewellery lines) and the draft is tagged
// buy-plan-change + reprice, which lets that one reprice through the lock (lock.js).
//
// Today's rate for a piece is its variant's custom.gold_rate (the daily price job writes the day's
// rate for that karat onto every variant). A custom line with no variant takes the day's sale rate
// for the karat whose rate at the plan's start was nearest the rate the line was priced at.

const { getJson, putJson, getBuyingRateTable } = require('../../../core/shopify');
const { updateDraftOrderMetafields } = require('../../../core/metafields');
const { log } = require('../../../core/logger');
const { productLines, prop, rs, GST, SYNC_TAG, withTags, writeDraftLines } = require('./draft');
const { RATE_LOCK_TAG, FINAL_REPRICE_TAG, CHANGE_REPRICE_TAG } = require('./lock');

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

// Pure. Roughly how far the price moves at these rates. Gold is the only part the final price changes.
function estimateDelta(rates) {
  return Math.round(rates.reduce((sum, r) =>
    sum + (r.newRate && r.oldRate ? r.gold * (r.newRate / r.oldRate - 1) : 0), 0) * GST);
}

// Pure. The equal plan's final price on the lines: for each jewellery line
//   newGold  = round(oldGold × newRate / oldRate)                 (Gold is the line's, × quantity)
//   newPrice = oldPrice + (newGold − oldGold) × 1.03 / quantity    (price is per unit)
// and the Gold, _gold_rate, Gross Value, Taxable Value and GST properties follow, so the invoice's
// breakup still adds up. The old rate is the line's own _gold_rate: it was written with that Gold value,
// so a second run on already-moved lines changes nothing. A line with no Gold or no rate is left as it is.
// Returns { lines (the whole list, every line), changes, skipped }.
function goldOnlyReprice(lineItems, rates) {
  const products = productLines(lineItems);
  const changes = [], skipped = [];
  const money = (v) => `Rs${v.toFixed(2)}`;
  const lines = (lineItems || []).map(li => {
    const i = products.indexOf(li);
    if (i < 0) return li;
    const r = rates[i] || {};
    const title = li.title || `line ${i + 1}`;
    const oldGold = rs(prop(li, 'Gold'));
    const oldRate = rs(prop(li, '_gold_rate')) || Number(r.oldRate) || 0;
    const newRate = Number(r.newRate) || 0;
    if (!(oldGold > 0)) { skipped.push({ title, why: 'no Gold breakup' }); return li; }
    if (!(oldRate > 0) || !(newRate > 0)) { skipped.push({ title, why: 'no gold rate' }); return li; }
    if (Math.abs(newRate - oldRate) < 0.005) return li;

    const newGold = Math.round(oldGold * newRate / oldRate);
    const dGold = newGold - oldGold;
    const qty = Number(li.quantity) || 1;
    const oldPrice = parseFloat(li.price) || 0;
    const newPrice = Math.round((oldPrice + dGold * GST / qty) * 100) / 100;
    const moved = { 'Gold': newGold, 'Gross Value': dGold * GST, 'Taxable Value': dGold, 'GST': dGold * (GST - 1) };
    const properties = (li.properties || []).map(p => {
      if (p.name === '_gold_rate') return { name: p.name, value: String(newRate) };
      if (p.name === 'Gold') return { name: p.name, value: money(newGold) };
      if (p.name in moved) return { name: p.name, value: money(rs(p.value) + moved[p.name]) };
      return p;
    });
    if (!properties.some(p => p.name === '_gold_rate')) properties.push({ name: '_gold_rate', value: String(newRate) });
    changes.push({ title, oldGold, newGold, oldRate, newRate, oldPrice, newPrice, quantity: qty });
    return { ...li, price: newPrice.toFixed(2), properties };
  });
  return { lines, changes, skipped };
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

// The product change: write today's rates and ask the engine for the reprice. Throws (and changes
// nothing) if any piece has no rate.
async function startReprice(plan, d, tag = CHANGE_REPRICE_TAG) {
  const rates = await todaysRates(plan, d);
  if (!rates.length) throw new Error('no jewellery lines to reprice');
  const missing = rates.filter(r => !r.newRate);
  if (missing.length) throw new Error(`no gold rate today for: ${missing.map(r => r.title || `line ${r.idx + 1}`).join(', ')}`);
  await updateDraftOrderMetafields(d.id, { gold_rate: rates.map(r => r.newRate.toFixed(2)).join(',') });
  const tags = [...new Set([...d.tags.filter(t => t.toLowerCase() !== RATE_LOCK_TAG), tag, 'reprice'])];
  await putJson(`draft_orders/${d.id}.json`, { draft_order: { id: d.id, tags: tags.join(', ') } });
  return rates;
}

// The equal plan's final price: gold only, written straight onto the lines (see the top).
// Returns { rates, changes, skipped }.
async function startFinalReprice(plan, d) {
  const rates = await todaysRates(plan, d);
  if (!rates.length) throw new Error('no jewellery lines to reprice');
  const { lines, changes, skipped } = goldOnlyReprice(d.draft.line_items, rates);
  for (const s of skipped) log.warn('buy-plan', `${d.draft.name}: final price: ${s.title} left at its price (${s.why})`);
  const tags = withTags(d.tags.filter(t => t.toLowerCase() !== FINAL_REPRICE_TAG), [RATE_LOCK_TAG, SYNC_TAG]);
  if (changes.length) await writeDraftLines(d.id, lines, { tags });
  else await putJson(`draft_orders/${d.id}.json`, { draft_order: { id: d.id, tags: tags.join(', ') } });
  // A draft-level custom.gold_rate overrides each line's _gold_rate for any later reader; keep it in step.
  if (changes.length && String(d.mf.gold_rate || '').trim()) {
    const moved = productLines(lines).map((li, i) => rs(prop(li, '_gold_rate')) || rates[i].oldRate || 0);
    await updateDraftOrderMetafields(d.id, { gold_rate: moved.map(r => Number(r).toFixed(2)).join(',') }).catch(() => {});
  }
  for (const c of changes) {
    log.info('buy-plan', `${d.draft.name}: final price: ${c.title} gold Rs${c.oldGold} → Rs${c.newGold} (rate ${c.oldRate} → ${c.newRate}), price Rs${c.oldPrice} → Rs${c.newPrice}`);
  }
  return { rates, changes, skipped };
}

// The final price has landed once the draft is rate-locked and the payment step has consumed
// sync-payment. (buy-plan-final + reprice: a final reprice started by the engine before 2026-11-06.)
const finalRepriceDone = (tags) => {
  const list = (tags || []).map(t => String(t).toLowerCase());
  return list.includes(RATE_LOCK_TAG) && ![FINAL_REPRICE_TAG, 'reprice', SYNC_TAG].some(t => list.includes(t));
};
// A product-change reprice has run once both its tags are gone.
const changeRepriceDone = (tags) => {
  const list = (tags || []).map(t => String(t).toLowerCase());
  return !list.includes(CHANGE_REPRICE_TAG) && !list.includes('reprice');
};

module.exports = {
  lineRates, estimateDelta, goldOnlyReprice, nearestKarat, estimateFinal, startReprice, startFinalReprice,
  finalRepriceDone, changeRepriceDone,
};
