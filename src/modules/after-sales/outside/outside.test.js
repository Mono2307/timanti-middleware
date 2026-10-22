const assert = require('assert');

// Enough env to construct the module graph; nothing here dials out.
process.env.SUPABASE_URL         ||= 'https://outside-repair-test.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL    ||= 'https://outside-repair-test.invalid';
const S = require('./specs');
const { intakeTags } = require('./routes');
const { resolveRepairSpecs, repairItemsFromDraft, SPEC_SEP } = require('../index');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
const at = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };

// Why this file exists: an outside piece has no Timanti order, so the "as received" specs every
// repair email and the repair note print are written by the intake form instead of copied. If the
// props drift from the keys those readers expect, the customer is acknowledged for the word
// "repair" with no photo and no weight — and the weight at intake is the figure any later dispute
// about the piece is settled against.

const full = {
  description: '22K gold bangle, plain', metal: '22K YG',
  metalTest: { method: 'XRF', reading: '91.6%' }, hallmark: 'HUID AB12CD',
  grossWeight: '18.4', stones: { diaPcs: '', diaCts: '', gemCts: '', note: '' },
  condition: 'Dent near the clasp; old solder joint', work: { items: ['Solder / joint repair', 'Polish / buff'], note: 'reshape round' },
  photos: ['https://cdn.shopify.com/a.jpg', 'https://cdn.shopify.com/b.jpg'], termsAccepted: true,
};

console.log('validateInspection — what the form refuses to submit without');
t('a complete inspection has nothing missing', () => assert.deepStrictEqual(S.validateInspection(full), []));
t('no photo is refused', () => assert.deepStrictEqual(S.validateInspection({ ...full, photos: [] }), ['At least one photo']));
t('a zero or blank weight is refused', () => {
  assert.ok(S.validateInspection({ ...full, grossWeight: '0' }).includes('Gross weight at intake'));
  assert.ok(S.validateInspection({ ...full, grossWeight: '' }).includes('Gross weight at intake'));
});
// The terms tick must be a deliberate true, not a truthy string that a form bug could send.
t('terms must be exactly true', () =>
  assert.ok(S.validateInspection({ ...full, termsAccepted: 'yes' }).includes('Customer has accepted the terms')));
t('nothing at all lists every field', () => assert.strictEqual(S.validateInspection(undefined).length, 6));

console.log('buildOutsideProps — the inspection lands on the keys the documents read');
const props = S.buildOutsideProps(full, '2026-10-22T10:00:00.000Z');
t('title, metal, image and weight use the existing spec keys', () => {
  assert.strictEqual(props._item_title, '22K gold bangle, plain');
  assert.strictEqual(props._variant_title, '22K YG');
  assert.strictEqual(props._image_url, 'https://cdn.shopify.com/a.jpg');
  assert.strictEqual(props._gross_wt, '18.40');
});
// The repair note's "Before repair" row reads _intake_gross_wt first.
t('the intake weight is mirrored for the Before-repair row', () => assert.strictEqual(props._intake_gross_wt, '18.40'));
t('outside-only details are recorded', () => {
  assert.strictEqual(props._metal_test, 'XRF 91.6%');
  assert.strictEqual(props._hallmark, 'HUID AB12CD');
  assert.strictEqual(props._work, 'Solder / joint repair; Polish / buff; reshape round');
  assert.strictEqual(props._terms_ok, '2026-10-22T10:00:00.000Z');
  assert.strictEqual(props._sku, 'OUTSIDE');
});
t('empty stone fields are left off, not written blank', () => {
  assert.ok(!('_diamond_pcs' in props));
  assert.ok(!('_stones_note' in props));
});
t('no hallmark is recorded as None, not omitted', () =>
  assert.strictEqual(S.buildOutsideProps({ ...full, hallmark: '' })._hallmark, 'None'));
// A separator inside a value would split one piece into two rows on every reader.
t('the list separator is stripped from free text', () =>
  assert.ok(!S.buildOutsideProps({ ...full, description: `ring ${SPEC_SEP} band` })._item_title.includes(SPEC_SEP)));
t('specs.js and index.js agree on the separator', () => assert.strictEqual(S.SPEC_SEP, SPEC_SEP));

console.log('missingFromProps — the intake gate for a hand-tagged draft');
t('props written by the form pass the gate', () => assert.deepStrictEqual(S.missingFromProps(props), []));
t('a bare "repair" line is held, naming what is missing', () =>
  assert.deepStrictEqual(S.missingFromProps({}), ['Description of the piece', 'Gross weight at intake', 'At least one photo', 'Customer has accepted the terms']));

console.log('tags');
t('isOutside reads a comma string or an array', () => {
  assert.ok(S.isOutside('repair-intake, repair-outside'));
  assert.ok(S.isOutside(['repair-outside']));
  assert.ok(!S.isOutside('repair-intake'));
});
t('campaign tags are slugged and fit Shopify\'s 40 characters', () => {
  assert.strictEqual(S.campaignTag('Diwali Repair Fest 2026'), 'camp:diwali-repair-fest-2026');
  assert.ok(S.campaignTag('x'.repeat(80)).length <= 40);
  assert.strictEqual(S.campaignTag(''), '');
});
t('a fresh draft gets outside + campaign + the paid class tag', () =>
  assert.deepStrictEqual(intakeTags([], { repairClass: 'paid', campaign: 'diwali' }), ['repair-outside', 'camp:diwali', 'repair-intake']));
t('the free class starts the free flow instead', () =>
  assert.ok(intakeTags([], { repairClass: 'free' }).includes('free-repair')));
// Adding the other class to an already-classed draft would run both flows.
t('a draft already classed is not given a second class', () => {
  const tags = intakeTags(['free-repair'], { repairClass: 'paid' });
  assert.ok(!tags.includes('repair-intake'));
});
t('re-submitting clears the hold tag', () =>
  assert.ok(!intakeTags(['repair-intake', 'repair-outside', 'repair-missing-inspection'], {}).includes('repair-missing-inspection')));

console.log('estimate breakdown');
const lines = [{ label: 'Labour', amount: 1500 }, { label: 'Metal added 0.30 g @ ₹7,050/g', amount: 2115 }, { label: 'blank', amount: 0 }];
t('format → parse round-trips, dropping zero rows', () =>
  assert.deepStrictEqual(S.parseCostLines(S.formatCostLines(lines)), lines.slice(0, 2)));
t('the total is the sum of the rows', () => assert.strictEqual(S.costTotal(S.parseCostLines(S.formatCostLines(lines))), 3615));
t('a pipe in a label cannot shift the amount', () =>
  assert.deepStrictEqual(S.parseCostLines(S.formatCostLines([{ label: 'a|b', amount: 10 }])), [{ label: 'a/b', amount: 10 }]));
t('nothing parses to nothing', () => assert.deepStrictEqual(S.parseCostLines(''), []));

console.log('reconcileWeight — every change at completion is accounted for');
t('sizing up and polish loss explain the change exactly', () => {
  const r = S.reconcileWeight({ intake: '8.42', out: '8.68', causes: { metal_added: '0.30', polish_loss: '0.04' } });
  assert.ok(r.balanced);
  assert.strictEqual(S.formatReconcile(r), 'In 8.42 g | +0.30 g metal added | −0.04 g polish loss | Out 8.68 g');
});
// Staff type positive grams; the cause decides the direction.
t('a removal entered as a positive number still counts as a loss', () =>
  assert.ok(S.reconcileWeight({ intake: '10', out: '9.5', causes: { metal_removed: '0.5' } }).balanced));
t('stones are signed', () =>
  assert.ok(S.reconcileWeight({ intake: '5', out: '4.9', causes: { stones: '-0.1' } }).balanced));
t('an unexplained remainder is shown, with the note', () => {
  const r = S.reconcileWeight({ intake: '8.42', out: '8.30', causes: { polish_loss: '0.04' } });
  assert.ok(!r.balanced);
  assert.strictEqual(S.formatReconcile(r, 'old solder came away'), 'In 8.42 g | −0.04 g polish loss | −0.08 g other: old solder came away | Out 8.30 g');
});
t('no change and no causes is balanced', () => assert.ok(S.reconcileWeight({ intake: '3', out: '3', causes: {} }).balanced));
t('a missing weight cannot be reconciled', () => assert.strictEqual(S.reconcileWeight({ intake: '', out: '3' }), null));

console.log('terms');
t('the collection term states 30 days and the late-fee placeholder', () => {
  assert.ok(S.OUTSIDE_TERMS[3].includes('30 days'));
  assert.ok(S.OUTSIDE_TERMS[3].includes('[LATE FEE: TBD]'));
});

console.log('forms — what the staff forms accept');
const F = require('./forms');
t('karat is read from the metal however it is written', () => {
  assert.strictEqual(F.karatOf('22K YG'), 22);
  assert.strictEqual(F.karatOf('14K / YG'), 14);
  assert.strictEqual(F.karatOf('18kt rose'), 18);
  assert.strictEqual(F.karatOf('Platinum 950'), null);
});
t('a posted breakdown is sanitised to positive rows', () =>
  assert.deepStrictEqual(F.parseBreakdown(JSON.stringify([{ label: 'Labour', amount: '1500' }, { label: 'x', amount: -5 }])), [{ label: 'Labour', amount: 1500 }]));
t('a malformed breakdown is no breakdown, not an error', () => {
  assert.deepStrictEqual(F.parseBreakdown('not json'), []);
  assert.deepStrictEqual(F.parseBreakdown(''), []);
});
t('Mark Complete refuses an outside piece with no weight after repair', () =>
  assert.ok(F.parseCompleteReconcile({}, '8.42').error));
t('Mark Complete refuses an unexplained change with no note', () =>
  assert.ok(/unexplained/.test(F.parseCompleteReconcile({ postGrossWt: '8.30' }, '8.42').error)));
t('Mark Complete accepts an unexplained change once a note is given', () =>
  assert.strictEqual(F.parseCompleteReconcile({ postGrossWt: '8.30', wcNote: 'old solder came away' }, '8.42').line,
    'In 8.42 g | −0.12 g other: old solder came away | Out 8.30 g'));
t('Mark Complete records the accounted-for line', () =>
  assert.strictEqual(F.parseCompleteReconcile({ postGrossWt: '8.68', wc_metal_added: '0.30', wc_polish_loss: '0.04' }, '8.42').line,
    'In 8.42 g | +0.30 g metal added | −0.04 g polish loss | Out 8.68 g'));
t('the reconcile fragment makes the after-weight mandatory', () =>
  assert.ok(F.completeReconcileHtml({ intakeWeight: '8.42' }).includes('gross.required = true')));

console.log('emails — outside content appears only on outside pieces');
const Em = require('./emails');
const T = require('../../../integrations/email/templates');
const asDraft = (tags, extra = {}) => ({ tags, note: 'Customer in a hurry',
  line_items: [{ title: 'repair', quantity: 1, properties: Object.entries({ ...props, ...extra }).map(([name, value]) => ({ name, value })) }] });
t('a Timanti repair gets no extra sections and unchanged notes', () => {
  const d = asDraft('repair-intake');
  assert.strictEqual(Em.receivedExtraHtml(d), '');
  assert.strictEqual(Em.readyExtraHtml(d), '');
  assert.strictEqual(Em.hqNotes(d, 'x'), 'x');
});
t('the acknowledgement carries the inspection and all four terms', () => {
  const html = Em.receivedExtraHtml(asDraft('repair-intake, repair-outside'));
  assert.ok(html.includes('As inspected at intake') && html.includes('XRF 91.6%') && html.includes('HUID AB12CD'));
  for (const term of S.OUTSIDE_TERMS) assert.ok(html.includes(term.slice(0, 30)));
});
t('the ready email carries the weight record and the 30-day rule', () => {
  const html = Em.readyExtraHtml(asDraft('repair-outside', { _wt_reconcile: 'In 18.40 g | −0.03 g polish loss | Out 18.37 g' }));
  assert.ok(html.includes('In 18.40 g') && html.includes('Please collect within 30 days'));
});
t('the HQ mail leads with the outside-piece block, then the staff note', () => {
  const notes = Em.hqNotes(asDraft('repair-outside'), 'Customer in a hurry');
  assert.ok(notes.startsWith('OUTSIDE PIECE'));
  assert.ok(notes.includes('Work requested: Solder / joint repair; Polish / buff; reshape round'));
  assert.ok(notes.endsWith('Customer in a hurry'));
});
t('an itemised estimate prints its rows above the total', () => {
  const d = asDraft('repair-intake', { _cost_lines: S.formatCostLines([{ label: 'Labour', amount: 1500 }, { label: 'Stones', amount: 500 }]) });
  const html = T.buildRepairEstimateV2Html({ draftRef: '#D1', items: [], amount: 2000, paymentUrl: '#', approveStoreUrl: '#', whatsappUrl: '#', breakdown: Em.breakdownFromDraft(d) });
  assert.ok(html.indexOf('Labour') > 0 && html.indexOf('Labour') < html.indexOf('Estimated charges'));
});
t('an estimate without a breakdown renders as before', () => {
  const html = T.buildRepairEstimateV2Html({ draftRef: '#D1', items: [], amount: 2000, paymentUrl: '#', approveStoreUrl: '#', whatsappUrl: '#' });
  assert.ok(html.includes('Estimated charges') && !html.includes('Labour'));
});

(async () => {
  console.log('resolveRepairSpecs — outside pieces are read back, not copied');
  const draft = {
    tags: 'repair-intake, repair-outside',
    line_items: [{ title: 'repair', quantity: 1, properties: Object.entries(props).map(([name, value]) => ({ name, value })) }],
  };
  // No network: the outside branch returns before any Shopify call, which is the point — there
  // is no order to look up.
  await at('specs come back in the same shape the order copy returns', async () => {
    const specs = await resolveRepairSpecs(draft, 'no-token');
    assert.strictEqual(specs._item_title, '22K gold bangle, plain');
    assert.strictEqual(specs._gross_wt, '18.40');
    assert.ok(!('_metal_test' in specs), 'only SPEC_KEYS are returned');
  });
  await at('an outside draft with no inspection yet resolves nothing', async () => {
    assert.strictEqual(await resolveRepairSpecs({ tags: 'repair-outside', line_items: [{ properties: [] }] }, 'no-token'), false);
  });
  await at('the customer emails render the inspected piece', async () => {
    const [row] = repairItemsFromDraft(draft, await resolveRepairSpecs(draft, 'no-token'));
    assert.strictEqual(row.title, '22K gold bangle, plain');
    assert.strictEqual(row.imageUrl, 'https://cdn.shopify.com/a.jpg');
    assert.strictEqual(row.grossWeight, '18.40');
  });
  console.log(`\n${n} assertions passed`);
})().catch(e => { console.error(e); process.exit(1); });
