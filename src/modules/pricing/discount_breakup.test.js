'use strict';

const assert = require('assert');
const B = require('./discount_breakup');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
const near = (a, b) => Math.abs(a - b) < 0.005;

console.log('sources');
t('auto-dia is the campaign, loyalty is loyalty, untagged is manual, native is other', () => {
  assert.strictEqual(B.sourceOf({ src: 'auto-dia' }), 'campaign');
  assert.strictEqual(B.sourceOf({ src: 'loyalty' }), 'loyalty');
  assert.strictEqual(B.sourceOf({ t: 'dia', m: 'pct', v: 3 }), 'manual');
  assert.strictEqual(B.sourceOf({ src: 'native' }), 'other');
});

console.log('campaign label');
t('name with dd/mm/yy-dd/mm/yy', () => {
  assert.strictEqual(B.campaignLabel({ name: 'Dussehra 2026', start: '2026-10-21', end: '2026-11-08' }), 'Dussehra 2026 (21/10/26-08/11/26)');
});
t('no dates: the name alone; no name: a plain description', () => {
  assert.strictEqual(B.campaignLabel({ name: 'Dussehra 2026' }), 'Dussehra 2026');
  assert.strictEqual(B.campaignLabel({}), 'Auto diamond discount');
});

console.log('campaign window (IST dates, both ends inclusive)');
const DUSSEHRA = { name: 'Dussehra 2026', start: '2026-10-21', end: '2026-11-08' };
t('runs from 21/10 through the whole of 08/11 IST', () => {
  assert.strictEqual(B.campaignWindow(DUSSEHRA, new Date('2026-10-20T18:30:00Z')), 'active');   // 00:00 IST 21 Oct
  assert.strictEqual(B.campaignWindow(DUSSEHRA, new Date('2026-11-08T18:29:00Z')), 'active');   // 23:59 IST 8 Nov
});
t('stops at midnight IST going into 09/11', () => {
  assert.strictEqual(B.campaignWindow(DUSSEHRA, new Date('2026-11-08T18:30:00Z')), 'ended');
});
t('not before it starts', () => {
  assert.strictEqual(B.campaignWindow(DUSSEHRA, new Date('2026-10-20T18:29:00Z')), 'before');
});
t('no dates set: open, as the discount always behaved', () => {
  assert.strictEqual(B.campaignWindow({ name: 'X' }), 'open');
  assert.strictEqual(B.campaignWindow(undefined), 'open');
});

console.log('split by source');
t('uncapped: each source keeps its own rupees', () => {
  // Diamond 60,000: campaign 15% = 9,000, loyalty 5% = 3,000; manual 10% of making 20,000 = 2,000.
  const raw = { dia: { campaign: 9000, loyalty: 3000 }, mk: { manual: 2000 }, tot: {} };
  const s = B.splitBySource(raw, { dia: 12000, mk: 2000, tot: 0, total: 14000 });
  assert.ok(near(s.campaign, 9000) && near(s.loyalty, 3000) && near(s.manual, 2000));
});
t('capped at the diamond: sources shrink pro rata and still add up', () => {
  // Diamond 10,000 with 80% campaign + 7% loyalty + a flat 2,000 manual → 11,000 asked, 10,000 given.
  const raw = { dia: { campaign: 8000, loyalty: 700, manual: 2000 }, mk: {}, tot: {} };
  const s = B.splitBySource(raw, { dia: 10000, mk: 0, tot: 0, total: 10000 });
  assert.ok(near(s.campaign + s.loyalty + s.manual, 10000));
  assert.ok(near(s.campaign, 8000 * 10000 / 10700));
});
t('the final taxable clamp is shared across every target', () => {
  const raw = { dia: { campaign: 100 }, mk: { manual: 100 }, tot: {} };
  const s = B.splitBySource(raw, { dia: 100, mk: 100, tot: 0, total: 150 });
  assert.ok(near(s.campaign, 75) && near(s.manual, 75));
});

console.log('order breakup');
t('sums the lines, names the campaign from the entries', () => {
  const b = B.buildBreakup([
    { bySrc: { campaign: 9000, loyalty: 3000, manual: 0 }, campaigns: ['Dussehra 2026 (21/10/26-08/11/26)'] },
    { bySrc: { campaign: 1500, manual: 500 }, campaigns: ['Dussehra 2026 (21/10/26-08/11/26)'] },
  ]);
  assert.deepStrictEqual(b, {
    campaign: { label: 'Dussehra 2026 (21/10/26-08/11/26)', amount: 10500 },
    manual: 500, loyalty: 3000, other: 0, code: 0, total: 14000,
  });
});
t('auto entries from before campaigns were stamped take the configured label', () => {
  const b = B.buildBreakup([{ bySrc: { campaign: 100 } }], { fallbackCampaign: 'Dussehra 2026 (21/10/26-08/11/26)' });
  assert.strictEqual(b.campaign.label, 'Dussehra 2026 (21/10/26-08/11/26)');
});
t('no campaign rupees, no campaign label', () => {
  assert.strictEqual(B.buildBreakup([{ bySrc: { loyalty: 100 } }]).campaign.label, '');
});
t('nothing discounted is null', () => {
  assert.strictEqual(B.buildBreakup([{ bySrc: { campaign: 0 } }, { bySrc: { code: 0 } }]), null);
  assert.strictEqual(B.breakupJson(null), '');
});

console.log(`\n${n} assertions passed`);
