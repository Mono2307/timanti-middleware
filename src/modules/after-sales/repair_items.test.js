const assert = require('assert');

// Enough env to construct the module graph; nothing here dials out.
process.env.SUPABASE_URL         ||= 'https://repair-items-test.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL    ||= 'https://repair-items-test.invalid';
const { parseRepairItemIds, repairItemsFromDraft, SPEC_SEP } = require('./index');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// Why this file exists: a repair draft references ONE original order, but that order may have
// carried several pieces and only one of them may be on the counter. The copy used to take
// line_items[0] unconditionally, so a two-piece order put the wrong photo, name and gross weight
// on every customer email and on the repair note — and nothing said so. The selection metafield
// and the delimited spec lists are what fixed it, and both fail SILENTLY when they drift: a
// mis-parsed selection emails the customer about a piece they never brought in, and a mis-zipped
// list pairs one piece's title with another's weight.

const draftWith = (props, extra = {}) => ({
  line_items: [{ title: 'repair', quantity: 1, properties: Object.entries(props).map(([name, value]) => ({ name, value })), ...extra }]
});

console.log('parseRepairItemIds — what a selection means');
t('a JSON array of ids comes back as strings', () =>
  assert.deepStrictEqual(
    parseRepairItemIds([{ namespace: 'custom', key: 'repair_items', value: '[123,456]' }]),
    ['123', '456']));
// Empty is the important case: it must mean EVERY piece, which the caller expresses by getting an
// empty list back and skipping the filter. Reading it as "the first piece" is the original bug.
t('no metafield at all is an empty selection', () =>
  assert.deepStrictEqual(parseRepairItemIds([]), []));
t('an empty value is an empty selection', () =>
  assert.deepStrictEqual(parseRepairItemIds([{ namespace: 'custom', key: 'repair_items', value: '' }]), []));
t('a malformed value degrades to an empty selection, it does not throw', () =>
  assert.deepStrictEqual(parseRepairItemIds([{ namespace: 'custom', key: 'repair_items', value: 'not json' }]), []));
t('a JSON non-array degrades to an empty selection', () =>
  assert.deepStrictEqual(parseRepairItemIds([{ namespace: 'custom', key: 'repair_items', value: '{"a":1}' }]), []));
// The panel writes `custom`; a stray key of the same name in another namespace is not the selection.
t('only the custom namespace counts', () =>
  assert.deepStrictEqual(parseRepairItemIds([{ namespace: 'timanti', key: 'repair_items', value: '[9]' }]), []));

console.log('repairItemsFromDraft — one piece still renders exactly as it did');
t('a single piece yields one row with its own values', () => {
  const items = repairItemsFromDraft(draftWith({
    _item_title: 'Solitaire Ring', _variant_title: '14K / YG', _gross_wt: '2.10',
    _image_url: 'https://cdn/x.jpg'
  }));
  assert.strictEqual(items.length, 1);
  assert.deepStrictEqual(items[0], {
    title: 'Solitaire Ring', qty: 1, variant: '14K / YG',
    imageUrl: 'https://cdn/x.jpg', grossWeight: '2.10'
  });
});
// The draft's own line quantity describes the JOB, so it is only meaningful on a single-piece repair.
t('the draft line quantity carries through on a single piece', () => {
  const d = draftWith({ _item_title: 'Solitaire Ring' }, { quantity: 3 });
  assert.strictEqual(repairItemsFromDraft(d)[0].qty, 3);
});

console.log('repairItemsFromDraft — several pieces zip back by index');
t('two pieces yield two correctly paired rows', () => {
  const items = repairItemsFromDraft(draftWith({
    _item_title: `Solitaire Ring${SPEC_SEP}Drop Earrings`,
    _variant_title: `14K / YG${SPEC_SEP}18K / WG`,
    _gross_wt: `2.10${SPEC_SEP}4.00`,
    _image_url: `https://cdn/ring.jpg${SPEC_SEP}https://cdn/ear.jpg`
  }));
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].title, 'Solitaire Ring');
  assert.strictEqual(items[0].grossWeight, '2.10');
  assert.strictEqual(items[1].title, 'Drop Earrings');
  assert.strictEqual(items[1].grossWeight, '4.00');
  assert.strictEqual(items[1].imageUrl, 'https://cdn/ear.jpg');
});
// The copy writes an empty slot for a piece that resolved nothing, so the lists stay the same
// length. If a short list ever shifted the rest, piece two would wear piece one's weight.
t('an empty slot blanks that row only, it does not shift the others', () => {
  const items = repairItemsFromDraft(draftWith({
    _item_title: `Ring${SPEC_SEP}Earrings${SPEC_SEP}Bangle`,
    _gross_wt: `2.10${SPEC_SEP}${SPEC_SEP}9.90`,
    _image_url: `https://cdn/ring.jpg${SPEC_SEP}`
  }));
  assert.deepStrictEqual(items.map(i => i.grossWeight), ['2.10', '', '9.90']);
  assert.deepStrictEqual(items.map(i => i.imageUrl), ['https://cdn/ring.jpg', null, null]);
});
t('quantity is 1 per row once there is more than one piece', () => {
  const d = draftWith({ _item_title: `Ring${SPEC_SEP}Earrings` }, { quantity: 5 });
  assert.deepStrictEqual(repairItemsFromDraft(d).map(i => i.qty), [1, 1]);
});

console.log('repairItemsFromDraft — nothing copied yet');
// The gate holds an intake with no order reference, but reconcile and the HQ mails still render.
// One row titled "Your jewellery" is the documented fallback; zero rows would print an empty table.
t('a draft with no specs still renders exactly one fallback row', () => {
  const items = repairItemsFromDraft({ line_items: [{ title: 'Repair-RG00020', quantity: 1, properties: [] }] });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].title, 'Repair-RG00020');
});
t('a draft with no line items at all still renders one row', () => {
  const items = repairItemsFromDraft({ line_items: [] });
  assert.deepStrictEqual(items.map(i => i.title), ['Your jewellery']);
});
// freshSpecs is what the copy just wrote; the in-memory draft predates it, so it must win.
t('freshSpecs overrides the stale properties on the draft', () => {
  const items = repairItemsFromDraft(
    draftWith({ _item_title: 'Stale Ring' }),
    { _item_title: `Ring${SPEC_SEP}Earrings`, _gross_wt: `2.10${SPEC_SEP}4.00` }
  );
  assert.deepStrictEqual(items.map(i => i.title), ['Ring', 'Earrings']);
});

console.log(`\n${n} assertions passed`);
