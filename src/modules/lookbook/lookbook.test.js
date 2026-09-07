/**
 * Lookbook unit tests.
 *
 * The handler smoke test proves these routes do not throw. It cannot prove the page shows the
 * RIGHT number, and this page is read over someone's shoulder by a paying customer. So the rules
 * that decide what is on screen are pinned here: which weight is the gross weight, which price is
 * safe to display, and whether a session cookie can be forged.
 *
 * Pure functions only -- nothing here dials Shopify or Supabase.
 */

const assert = require('assert');

process.env.SUPABASE_URL              ||= 'https://lookbook-test.invalid';
process.env.SUPABASE_SERVICE_KEY      ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL         ||= 'https://lookbook-test.invalid';
process.env.LOOKBOOK_PASSWORD         ||= 'test-password';
process.env.LOOKBOOK_SESSION_SECRET   ||= 'test-signing-secret';

const snap = require('./snapshot');
const auth = require('../../core/auth');
const store = require('./store');
const { loginPage, appPage } = require('./page');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// ── SKU parsing ──────────────────────────────────────────────────────────────
console.log('SKU segments drive category, karat and diamond grade');

t('parses a full 8-segment SKU', () => {
  const p = snap.parseSku('NK00026|P|14|VVSVS-EFG|H|16|6.00|NA');
  assert.strictEqual(p.designId, 'NK00026');
  assert.strictEqual(p.prefix, 'NK');
  assert.strictEqual(p.tone, 'P');
  assert.strictEqual(p.karat, '14K');
  assert.strictEqual(p.grade, 'VVSVS-EFG');
  assert.strictEqual(p.family, 'NK00026|P|14');   // search_prefix, as in shopify_snapshot.py
});

t('a SKU that is not in this format does not throw or invent values', () => {
  for (const bad of [null, '', 'SIELLE-1', 'NK00026']) {
    const p = snap.parseSku(bad);
    assert.strictEqual(p.karat, null, `karat invented for ${JSON.stringify(bad)}`);
    assert.strictEqual(p.grade, null);
  }
});

t('an NA gemstone slot is absence, not a grade called "NA"', () => {
  assert.strictEqual(snap.parseSku('RG001|Y|18|NA|H|12|1.0|NA').grade, null);
});

// ── Options ──────────────────────────────────────────────────────────────────
console.log('variant options are read by NAME, with the positional split as a fallback');

t('named selectedOptions win', () => {
  const opts = snap.optionsOf({
    selectedOptions: [{ name: 'Karat', value: '18K' }, { name: 'Tone', value: 'YG' }, { name: 'Size', value: '16' }],
    title: '18K / YG / 16',
  });
  assert.strictEqual(snap.pickOption(opts, ['karat', 'purity', 'metal'], '__pos1'), '18K');
  assert.strictEqual(snap.pickOption(opts, ['tone', 'colour', 'color'], '__pos2'), 'YG');
  assert.strictEqual(snap.pickOption(opts, ['size', 'length'], '__pos3'), '16');
});

t('unnamed options fall back to the " / " split', () => {
  const opts = snap.optionsOf({ selectedOptions: [], title: '22K / WG / 18' });
  assert.strictEqual(snap.pickOption(opts, ['karat'], '__pos1'), '22K');
  assert.strictEqual(snap.pickOption(opts, ['tone'], '__pos2'), 'WG');
});

t('"Default Title" is not an option value', () => {
  assert.deepStrictEqual(snap.optionsOf({ selectedOptions: [{ name: 'Title', value: 'Default Title' }], title: 'Default Title' }), {});
});

t('tone codes expand the way the invoice templates expand them', () => {
  assert.strictEqual(snap.toneLabel('YG'), 'Yellow Gold');
  assert.strictEqual(snap.toneLabel('WG'), 'White Gold');
  assert.strictEqual(snap.toneLabel('RG'), 'Rose Gold');
  assert.strictEqual(snap.toneLabel('P'), 'Rose Gold');   // SKU segment 1 uses P for pink/rose
  // PG is what the LIVE catalog actually carries on ~two thirds of its products. The first run
  // against the real store rendered a raw "PG" facet chip to customers; this pins the fix.
  assert.strictEqual(snap.toneLabel('PG'), 'Rose Gold');
  assert.strictEqual(snap.toneLabel('pg'), 'Rose Gold', 'tone codes must be case-insensitive');
});

// ── The gross-weight trap ────────────────────────────────────────────────────
console.log('gross weight follows the precedence that order #1069 established');

t('gross_weight_g wins over total_metal_weight_g', () => {
  // The real numbers from the bug: reading total_metal_weight_g as gross printed the NET weight.
  const v = { gross: { value: '6.656' }, grossLegacy: null, totalMetal: { value: '5.45' } };
  assert.strictEqual(snap.grossWeightOf(v), 6.656);
});

t('falls back to the legacy key, then to total_metal_weight_g', () => {
  assert.strictEqual(snap.grossWeightOf({ gross: null, grossLegacy: { value: '4.2' }, totalMetal: { value: '3.1' } }), 4.2);
  assert.strictEqual(snap.grossWeightOf({ gross: null, grossLegacy: null, totalMetal: { value: '3.1' } }), 3.1);
  assert.strictEqual(snap.grossWeightOf({ gross: null, grossLegacy: null, totalMetal: null }), null);
});

// ── Bands ────────────────────────────────────────────────────────────────────
console.log('bands bucket on the lower edge and ignore missing values');

t('price and carat bands', () => {
  // The labels are timanti.in's own storefront bands, not invented ones.
  assert.strictEqual(snap.bandOf(19999, snap.BANDS.price), 'Under ₹20k');
  assert.strictEqual(snap.bandOf(20000, snap.BANDS.price), '₹20k – ₹50k');
  assert.strictEqual(snap.bandOf(9000000, snap.BANDS.price), '₹1L & Above');
  assert.strictEqual(snap.bandOf(0, snap.BANDS.price), null);
  assert.strictEqual(snap.bandOf(null, snap.BANDS.carat), null);
});

// ── Normalisation ────────────────────────────────────────────────────────────
const product = (over) => Object.assign({
  id: 'gid://shopify/Product/111',
  title: 'Solitaire Ring', handle: 'solitaire-ring', status: 'ACTIVE',
  productType: 'Ring', vendor: 'Timanti', tags: [],
  options: [{ name: 'Karat', values: ['18K'] }],
  media: { nodes: [{ mediaContentType: 'IMAGE', image: { url: 'https://cdn/a.jpg', altText: '' } }] },
  carats: { value: '0.75' }, stones: { value: '12' },
  gemWeight: null, gemPcs: null, makingRate: { value: '900' },
}, over);

const variant = (over) => Object.assign({
  id: 'gid://shopify/ProductVariant/222',
  sku: 'RG00012|Y|18|VVSVS-EFG|H|14|0.75|NA',
  title: '18K / YG / 14', price: '145000',
  inventoryQuantity: 2, availableForSale: true,
  selectedOptions: [{ name: 'Karat', value: '18K' }, { name: 'Tone', value: 'YG' }, { name: 'Size', value: '14' }],
  image: null, product: { id: 'gid://shopify/Product/111', status: 'ACTIVE' },
  net: { value: '5.45' }, gross: { value: '6.656' }, grossLegacy: null, totalMetal: { value: '5.45' },
  carats: null, pricedAt: { value: '2026-09-03T04:00:00Z' },
  goldRate: { value: '9150' },
  bGold: { value: '49867.50' }, bDiamond: { value: '31500' }, bMaking: { value: '4905' }, bGem: null,
  bSubtotal: { value: '86272.50' }, bGst: { value: '2588.18' }, bTotal: { value: '88860.68' },
}, over);

console.log('normalise joins the two passes into product cards');

t('a product carries the union of its variants’ filterable values', () => {
  const out = snap.normalize([product()], [
    variant(),
    variant({ id: 'gid://shopify/ProductVariant/223', price: '162000',
              selectedOptions: [{ name: 'Karat', value: '22K' }, { name: 'Tone', value: 'WG' }, { name: 'Size', value: '16' }] }),
  ]);
  assert.strictEqual(out.items.length, 1);
  const it = out.items[0];
  assert.strictEqual(it.id, '111');
  assert.strictEqual(it.category, 'Ring');
  assert.deepStrictEqual(it.karats.sort(), ['18K', '22K']);
  assert.deepStrictEqual(it.tones.sort(), ['White Gold', 'Yellow Gold']);
  assert.strictEqual(it.priceFrom, 145000);
  assert.strictEqual(it.priceTo, 162000);
  assert.strictEqual(it.priceBand, '₹1L & Above');
  assert.strictEqual(it.caratBand, '0.5-1ct');
  assert.strictEqual(it.variants[0].grossWt, 6.656);
});

t('a zero-weight variant is flagged as not priced by the daily job', () => {
  // shopify_snapshot.py skips these, so variant.price is whatever was last set by hand.
  const out = snap.normalize([product()], [variant({ net: { value: '0' } })]);
  assert.strictEqual(out.items[0].variants[0].priceManaged, false);
  assert.strictEqual(out.items[0].priceManaged, false, 'the card must not present a stale price as live');
});

t('a product with at least one managed variant is still priceable', () => {
  const out = snap.normalize([product()], [
    variant({ net: { value: '0' } }),
    variant({ id: 'gid://shopify/ProductVariant/224' }),
  ]);
  assert.strictEqual(out.items[0].priceManaged, true);
});

t('the price breakup is carried per variant, component by component', () => {
  const v = snap.normalize([product()], [variant()]).items[0].variants[0];
  assert.strictEqual(v.breakup.gold, 49867.5);
  assert.strictEqual(v.breakup.diamond, 31500);
  assert.strictEqual(v.breakup.making, 4905);
  assert.strictEqual(v.breakup.subtotal, 86272.5);
  assert.strictEqual(v.breakup.gst, 2588.18);
  assert.strictEqual(v.breakup.total, 88860.68);
  assert.strictEqual(v.goldRate, 9150);
});

t('a component the pricer never wrote stays absent, not zero', () => {
  // A zero row would render as "Coloured stones  Rs0", which reads as a real quoted component.
  const v = snap.normalize([product()], [variant()]).items[0].variants[0];
  assert.strictEqual(v.breakup.gemstone, null, 'an unset component must be null so the row is skipped');
});

t('archived products never reach the lookbook', () => {
  const out = snap.normalize([product({ status: 'ARCHIVED' })], [variant()]);
  assert.strictEqual(out.items.length, 0);
});

t('draft products are kept and flagged', () => {
  const out = snap.normalize([product({ status: 'DRAFT' })], [variant()]);
  assert.strictEqual(out.items.length, 1);
  assert.strictEqual(out.items[0].draft, true);
});

t('a product with no image at all is dropped and counted', () => {
  const out = snap.normalize([product({ media: { nodes: [] } })], [variant()]);
  assert.strictEqual(out.items.length, 0);
  assert.strictEqual(out.droppedNoImage, 1);
});

t('a variant image alone is enough to keep the product', () => {
  const out = snap.normalize([product({ media: { nodes: [] } })], [variant({ image: { url: 'https://cdn/v.jpg' } })]);
  assert.strictEqual(out.items.length, 1);
});

t('a product with no variants does not crash the walk', () => {
  const out = snap.normalize([product()], []);
  assert.strictEqual(out.items.length, 1);
  assert.strictEqual(out.items[0].priceFrom, null);
});

// ── Facets ───────────────────────────────────────────────────────────────────
console.log('facets are derived from the catalog, never declared');

t('counts values and omits facets the catalog cannot fill', () => {
  const out = snap.normalize([product()], [variant()]);
  const facets = snap.buildFacets(out.items);
  assert.deepStrictEqual(facets.category, [{ value: 'Ring', count: 1 }]);
  assert.deepStrictEqual(facets.karat, [{ value: '18K', count: 1 }]);
  assert.ok(!('collection' in facets), 'a facet with no values must not be rendered');
});

t('empty catalog yields no facets rather than empty ones', () => {
  assert.deepStrictEqual(snap.buildFacets([]), {});
});

// ── Session cookies ──────────────────────────────────────────────────────────
console.log('the session cookie cannot be forged, extended or replayed after expiry');

t('a freshly issued session verifies', () => {
  assert.strictEqual(auth.verifySession(auth.issueSession()), true);
});

t('a tampered expiry is rejected', () => {
  const [exp, sig] = auth.issueSession().split('.');
  const later = Number(exp) + 60 * 60 * 1000;
  assert.strictEqual(auth.verifySession(`${later}.${sig}`), false);
});

t('an expired session is rejected even with a valid signature', () => {
  assert.strictEqual(auth.verifySession(auth.issueSession(-1)), false);
});

t('garbage is rejected without throwing', () => {
  for (const bad of ['', null, 'x', 'abc.def', '....', '99999999999999.zz']) {
    assert.strictEqual(auth.verifySession(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

t('the password compare accepts only the real password', () => {
  assert.strictEqual(auth.checkPassword('test-password'), true);
  assert.strictEqual(auth.checkPassword('test-passwor'), false);
  assert.strictEqual(auth.checkPassword(''), false);
  assert.strictEqual(auth.checkPassword(undefined), false);
});

t('cookies are parsed out of a real header', () => {
  const jar = auth.parseCookies({ headers: { cookie: 'a=1; ' + auth.COOKIE + '=abc.def; b=2' } });
  assert.strictEqual(jar[auth.COOKIE], 'abc.def');
  assert.deepStrictEqual(auth.parseCookies({ headers: {} }), {});
});

t('the cookie is HttpOnly and scoped to /lookbook', () => {
  const c = auth.loginCookie({ headers: {} });
  assert.ok(c.includes('HttpOnly'), 'a page script must never be able to read the session');
  assert.ok(c.includes('Path=/lookbook'));
  assert.ok(c.includes('SameSite=Lax'));
  // Secure is conditional: hardcoding it would silently break http://localhost testing.
  assert.ok(!c.includes('Secure'), 'plain http must not get a Secure cookie it can never store');
  assert.ok(auth.loginCookie({ headers: { 'x-forwarded-proto': 'https' } }).includes('Secure'));
});

t('a session gate reads the cookie end to end', () => {
  const value = auth.loginCookie({ headers: {} }).split(';')[0].split('=')[1];
  assert.strictEqual(auth.hasSession({ headers: { cookie: auth.COOKIE + '=' + value } }), true);
  assert.strictEqual(auth.hasSession({ headers: { cookie: auth.COOKIE + '=forged' } }), false);
  assert.strictEqual(auth.hasSession({ headers: {} }), false);
});

// ── Rebuild schedule ─────────────────────────────────────────────────────────
console.log('the nightly rebuild is anchored to the clock, not to boot');

t('always schedules within the next 24 hours', () => {
  for (const iso of ['2026-09-04T00:00:00Z', '2026-09-04T22:31:00Z', '2026-09-03T22:30:00Z']) {
    const ms = store.msUntilNextRebuild(Date.parse(iso));
    assert.ok(ms > 0 && ms <= 24 * 60 * 60 * 1000, `${iso} scheduled ${ms}ms out`);
  }
});

t('lands on 04:00 IST', () => {
  const from = Date.parse('2026-09-04T00:00:00Z');            // 05:30 IST, so the next one is tomorrow
  const at = new Date(from + store.msUntilNextRebuild(from) + 330 * 60 * 1000);
  assert.strictEqual(at.getUTCHours(), store.REBUILD_HOUR_IST);
  assert.strictEqual(at.getUTCMinutes(), 0);
});

// ── Pages ────────────────────────────────────────────────────────────────────
console.log('the pages render without a catalog present');

t('the login page never leaks the password and states when it is unconfigured', () => {
  const html = loginPage({ error: 'That password did not work.' });
  assert.ok(html.includes('type="password"'));
  assert.ok(!html.includes('test-password'), 'the configured password must never reach the HTML');
  assert.ok(loginPage({ configured: false }).includes('LOOKBOOK_PASSWORD'));
});

t('the login page escapes what it echoes back', () => {
  assert.ok(!loginPage({ error: '<img src=x onerror=alert(1)>' }).includes('<img src=x'));
});

t('the app page ships self-contained', () => {
  const html = appPage();
  assert.ok(html.includes('/lookbook/catalog.json'));
  assert.ok(html.includes('/lookbook/live'));
  // No build step and no CDN: the whole page must work on store wifi with nothing else to fetch.
  assert.ok(!/<script[^>]+src=/.test(html), 'the page must not load external scripts');
  assert.ok(!/<link[^>]+stylesheet/.test(html), 'the page must not load external stylesheets');
});

console.log(`\n${n} assertions passed`);
