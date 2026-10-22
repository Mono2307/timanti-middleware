'use strict';

// Outside-jewellery repairs: pieces Timanti did not sell, taken in under a repair campaign.
//
// An outside repair is an ordinary repair draft. Everything downstream (estimate, GoKwik link,
// free path, Mark Complete, refund/balance, TS serial, the repair note) reads the piece from the
// draft's "repair" line-item properties, so the only thing that differs is WHERE those properties
// come from: a Timanti repair copies them off the original order; an outside repair has them
// written by the intake form from what staff recorded at the counter.
//
// Everything printable lives on line-item properties and tags, never on new metafields:
// AutoPrinter Pro only exposes the first 10 pinned metafields to the template, and 81 draft
// definitions already compete for those slots. The one metafield this feature writes,
// custom.repair_inspection, is an unpinned audit copy the template never reads.
//
// This file is pure: no I/O, so every rule here is covered by outside.test.js.

const SPEC_SEP = '~||~';

const OUTSIDE_TAG            = 'repair-outside';
const MISSING_INSPECTION_TAG = 'repair-missing-inspection';
const CAMPAIGN_TAG_PREFIX    = 'camp:';
// Shopify silently truncates tags past 40 characters, which would break the prefix match.
const TAG_MAX                = 40;

// From the day the customer is told the repair is finished.
const COLLECTION_DAYS   = 30;
// Not yet decided by the founder. Rendered verbatim so it is impossible to miss in a proof.
const LATE_FEE_TEXT     = '[LATE FEE: TBD]';

// The four things the customer agrees to at intake. Printed on the acknowledgement email and the
// repair note. The intake form shows its own copy of this list; keep the two in step.
const OUTSIDE_TERMS = [
  'Stone type, count and carat weight are as declared by you and observed by us; they are not certified by Timanti.',
  'Timanti is not responsible for damage arising from pre-existing wear, weakness, prior repairs or defects noted at intake.',
  'The metal and purity recorded are the result of our test at intake, which you have accepted.',
  `The piece must be collected within ${COLLECTION_DAYS} days of our telling you it is ready. After that it is shipped to your address on file at your cost, or, with no address on file, a late fee of ${LATE_FEE_TEXT} accrues.`,
];

const METAL_TEST_METHODS = ['XRF', 'Touchstone', 'Declared by customer'];

const WORK_OPTIONS = [
  'Resize', 'Solder / joint repair', 'Polish / buff', 'Rhodium / plating', 'Stone reset (tighten)',
  'Stone replace', 'Clasp / lock', 'Chain repair', 'Prong / claw rebuild', 'Other',
];

// What a weight change at completion can be put down to. `sign` is how the grams entered count
// towards the change: sizing up adds metal, polishing takes it away. Stones can go either way, so
// staff enter that one signed.
const WEIGHT_CAUSES = [
  { key: 'metal_added',   label: 'Metal added (sizing up / build-up)', short: 'metal added',   sign: +1 },
  { key: 'metal_removed', label: 'Metal removed (sizing down)',        short: 'metal removed', sign: -1 },
  { key: 'polish_loss',   label: 'Polish / buffing loss',              short: 'polish loss',   sign: -1 },
  { key: 'solder',        label: 'Solder added',                       short: 'solder',        sign: +1 },
  { key: 'stones',        label: 'Stones added (+) / removed (−)',     short: 'stones',        sign:  0 },
];
// Scales read to 0.01 g; anything under half of that is rounding, not an unexplained change.
const WEIGHT_EPSILON = 0.005;

// ── small helpers ────────────────────────────────────────────────────────────

// A property value must never contain the list separator, or a reader would split it into two
// pieces; and line-item properties are text, so everything is stringified and trimmed.
const clean = (v) => String(v ?? '').split(SPEC_SEP).join(' ').replace(/\s+/g, ' ').trim();

const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

const grams = (n) => `${n.toFixed(2)} g`;
const signedGrams = (n) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)} g`;

const splitTags = (tags) => (Array.isArray(tags) ? tags : String(tags || '').split(','))
  .map(t => String(t).trim()).filter(Boolean);

function isOutside(tags) {
  return splitTags(tags).includes(OUTSIDE_TAG);
}

function campaignTag(code) {
  const slug = String(code || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? (CAMPAIGN_TAG_PREFIX + slug).slice(0, TAG_MAX) : '';
}

// ── intake ───────────────────────────────────────────────────────────────────

// What the intake form must have before a draft may be tagged into the repair flow. Returned as
// labels staff can act on, not field names.
function validateInspection(insp) {
  const i = insp || {};
  const missing = [];
  if (!clean(i.description))              missing.push('Description of the piece');
  if (!clean(i.metal))                    missing.push('Metal and karat');
  if (!clean(i.metalTest?.method))        missing.push('How the metal was tested');
  if (!(num(i.grossWeight) > 0))          missing.push('Gross weight at intake');
  if (!(Array.isArray(i.photos) && i.photos.some(p => clean(p)))) missing.push('At least one photo');
  if (i.termsAccepted !== true)           missing.push('Customer has accepted the terms');
  return missing;
}

// The inspection → the line-item properties every repair document already reads. Keys that
// already exist for Timanti repairs (SPEC_KEYS in ../index.js, _intake_gross_wt) are reused so the
// emails and the repair note need no change to show the piece; the rest are new and only printed
// for outside pieces. Empty values are left out rather than written blank.
function buildOutsideProps(insp, nowIso = new Date().toISOString()) {
  const i = insp || {};
  const weight = num(i.grossWeight);
  const stones = i.stones || {};
  const work   = i.work || {};
  const test   = i.metalTest || {};

  const props = {
    _item_title:      clean(i.description),
    _sku:             'OUTSIDE',
    _variant_title:   clean(i.metal),
    _image_url:       clean((i.photos || []).find(p => clean(p))),
    _gross_wt:        weight > 0 ? weight.toFixed(2) : '',
    _intake_gross_wt: weight > 0 ? weight.toFixed(2) : '',
    _diamond_pcs:     clean(stones.diaPcs),
    _diamond_cts:     clean(stones.diaCts),
    _gemstone_cts:    clean(stones.gemCts),
    _stones_note:     clean(stones.note),
    _metal_test:      clean([test.method, test.reading].filter(x => clean(x)).join(' ')),
    _hallmark:        clean(i.hallmark) || 'None',
    _condition:       clean(i.condition),
    _work:            clean([...(work.items || []).map(clean).filter(Boolean), clean(work.note)].filter(Boolean).join('; ')),
    _terms_ok:        i.termsAccepted === true ? nowIso : '',
  };
  for (const k of Object.keys(props)) if (!props[k]) delete props[k];
  return props;
}

// The props the intake gate insists on, read back off the draft's line. Catches a draft tagged
// repair-outside by hand without going through the form.
const REQUIRED_PROPS = [
  ['_item_title',      'Description of the piece'],
  ['_intake_gross_wt', 'Gross weight at intake'],
  ['_image_url',       'At least one photo'],
  ['_terms_ok',        'Customer has accepted the terms'],
];

function missingFromProps(props) {
  const p = props || {};
  return REQUIRED_PROPS.filter(([k]) => !clean(p[k])).map(([, label]) => label);
}

// ── estimate breakdown ───────────────────────────────────────────────────────

// [{label, amount}] ⇄ "Labour|1500~||~Metal added 0.30 g @ ₹7,050/g|2115". One property, so the
// breakdown prints without a pinned metafield; the template splits on the same separator it
// already uses for multi-piece lists.
function formatCostLines(lines) {
  return (lines || [])
    .map(l => ({ label: clean(l.label).replace(/\|/g, '/'), amount: Math.round(num(l.amount) || 0) }))
    .filter(l => l.label && l.amount > 0)
    .map(l => `${l.label}|${l.amount}`)
    .join(SPEC_SEP);
}

function parseCostLines(value) {
  if (!clean(value)) return [];
  return String(value).split(SPEC_SEP).map(row => {
    const at = row.lastIndexOf('|');
    if (at < 0) return null;
    const amount = num(row.slice(at + 1));
    const label = row.slice(0, at).trim();
    return label && amount > 0 ? { label, amount: Math.round(amount) } : null;
  }).filter(Boolean);
}

const costTotal = (lines) => (lines || []).reduce((s, l) => s + (Math.round(num(l.amount) || 0)), 0);

// ── weight accounting at completion ──────────────────────────────────────────

// intake and out are grams; causes is { key: grams } with unsigned grams for the fixed-sign causes
// and a signed figure for stones. Returns what the change was, how much of it the causes explain,
// and whether the remainder is just scale rounding.
function reconcileWeight({ intake, out, causes } = {}) {
  const inG  = num(intake);
  const outG = num(out);
  if (!(inG > 0) || !(outG > 0)) return null;
  const applied = [];
  let explained = 0;
  for (const c of WEIGHT_CAUSES) {
    const raw = num(causes?.[c.key]);
    if (!raw) continue;
    const g = c.sign === 0 ? raw : c.sign * Math.abs(raw);
    explained += g;
    applied.push({ key: c.key, short: c.short, grams: g });
  }
  const change    = outG - inG;
  const remainder = change - explained;
  return {
    intake: inG, out: outG, change, explained, remainder, applied,
    balanced: Math.abs(remainder) < WEIGHT_EPSILON,
  };
}

// "In 8.42 g | +0.30 g metal added | −0.04 g polish loss | Out 8.68 g", plus a note when the
// causes do not account for everything. Printed under the before/after rows on the repair note.
function formatReconcile(r, note) {
  if (!r) return '';
  const parts = [`In ${grams(r.intake)}`, ...r.applied.map(a => `${signedGrams(a.grams)} ${a.short}`)];
  if (!r.balanced) parts.push(`${signedGrams(r.remainder)} other${clean(note) ? `: ${clean(note)}` : ''}`);
  else if (clean(note)) parts.push(clean(note));
  parts.push(`Out ${grams(r.out)}`);
  return clean(parts.join(' | '));
}

module.exports = {
  SPEC_SEP, OUTSIDE_TAG, MISSING_INSPECTION_TAG, CAMPAIGN_TAG_PREFIX,
  COLLECTION_DAYS, LATE_FEE_TEXT, OUTSIDE_TERMS, METAL_TEST_METHODS, WORK_OPTIONS,
  WEIGHT_CAUSES, WEIGHT_EPSILON,
  splitTags, isOutside, campaignTag, validateInspection, buildOutsideProps, missingFromProps,
  formatCostLines, parseCostLines, costTotal, reconcileWeight, formatReconcile,
};
