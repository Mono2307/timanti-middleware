'use strict';

// What the customer and the store see differently for an outside piece. Every function returns ''
// for a Timanti repair, so the call sites in ../index.js can pass the result through unconditionally.
// The email builders themselves are unchanged apart from an `extraHtml` slot they append.

const { section, h3, termsSection } = require('../../../integrations/email/templates');
const S = require('./specs');

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function lineProps(draft) {
  const props = {};
  for (const p of (draft?.line_items?.[0]?.properties || [])) props[p.name] = p.value;
  return props;
}

function stonesText(p) {
  const parts = [];
  if (p._diamond_pcs || p._diamond_cts) parts.push(`Diamonds ${[p._diamond_pcs && `${p._diamond_pcs} pcs`, p._diamond_cts && `${p._diamond_cts} ct`].filter(Boolean).join(', ')}`);
  if (p._gemstone_cts) parts.push(`Gemstones ${p._gemstone_cts} ct`);
  if (p._stones_note) parts.push(p._stones_note);
  return parts.join('; ');
}

// [label, value] rows of what staff recorded at the counter, blanks dropped.
function inspectionRows(p) {
  return [
    ['Metal (as tested)', [p._variant_title, p._metal_test && `— ${p._metal_test}`].filter(Boolean).join(' ')],
    ['Hallmark / HUID', p._hallmark],
    ['Gross weight at intake', p._intake_gross_wt && `${p._intake_gross_wt} g`],
    ['Stones (as declared, uncertified)', stonesText(p)],
    ['Condition noted', p._condition],
    ['Work requested', p._work],
  ].filter(([, v]) => v);
}

function rowsTable(rows) {
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0">${rows.map(([k, v]) => `
    <tr><td style="font-size:13px; color:#888888; padding:4px 12px 4px 0; vertical-align:top; width:42%;">${esc(k)}</td>
        <td style="font-size:13px; color:#333333; padding:4px 0; vertical-align:top;">${esc(v)}</td></tr>`).join('')}
  </table>`;
}

// Acknowledgement: what we recorded, and the terms they accepted at the counter.
function receivedExtraHtml(draft) {
  if (!S.isOutside(draft?.tags)) return '';
  const p = lineProps(draft);
  return section(h3('As inspected at intake') + rowsTable(inspectionRows(p)))
    + termsSection('Terms for this repair', 'You accepted these when you handed your piece to us.', S.OUTSIDE_TERMS.map(esc));
}

// Ready email: the weight record, and the collection deadline that now starts running.
function readyExtraHtml(draft) {
  if (!S.isOutside(draft?.tags)) return '';
  const p = lineProps(draft);
  const weight = p._wt_reconcile
    ? section(h3('Weight record') + `<p style="font-size:13px; color:#333333; line-height:1.6; margin:0; text-align:left;">${esc(p._wt_reconcile)}</p>`
      + `<p style="font-size:12px; color:#888888; line-height:1.5; margin:8px 0 0; text-align:left;">Weight when we received your piece, what changed during the repair and why, and its weight now.</p>`)
    : '';
  return weight + section(h3('Please collect within ' + S.COLLECTION_DAYS + ' days')
    + `<p style="font-size:12.5px; color:#555555; line-height:1.6; margin:0; text-align:left;">${esc(S.OUTSIDE_TERMS[3])}</p>`);
}

// The internal intake mail prints the draft note as free text; the inspection is appended to it so
// whoever sets the estimate knows the job without opening Shopify.
function hqNotes(draft, notes) {
  if (!S.isOutside(draft?.tags)) return notes;
  const block = ['OUTSIDE PIECE — not sold by Timanti', ...inspectionRows(lineProps(draft)).map(([k, v]) => `${k}: ${v}`)].join('\n');
  return notes ? `${block}\n\n${notes}` : block;
}

// Itemised estimate rows for ANY repair that has them.
function breakdownFromDraft(draft) {
  return S.parseCostLines(lineProps(draft)._cost_lines);
}

module.exports = { receivedExtraHtml, readyExtraHtml, hqNotes, breakdownFromDraft, inspectionRows };
