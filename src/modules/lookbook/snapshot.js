'use strict';

/**
 * Builds the lookbook snapshot: the whole browsable catalog, flattened and pre-faceted.
 *
 * WHY A SNAPSHOT AT ALL
 * The filter rail has to answer "what karats exist", "what price bands exist" instantly, over the
 * entire catalog, while a customer is watching. Asking Shopify per keystroke cannot do that. So
 * the catalog is walked once a night, normalised into the shape the UI actually filters on, and
 * served as one file. Price and stock are the two things that must not be a day old, so those --
 * and only those -- are re-read live (see live.js).
 *
 * WHY TWO PASSES
 * One query carrying products AND their variants AND media AND metafields exceeds Shopify's
 * 1000-point query budget at any realistic page size. Products and variants are therefore walked
 * separately and joined in memory on product id. The variant pass is deliberately shaped like
 * src/jobs/price-update/shopify_snapshot.py, which has walked this same catalog daily in
 * production for months.
 */

const { paginate } = require('./shopify-gql');
const { log } = require('../../core/logger');

// Page sizes are a cost trade-off, not a preference: cost is roughly `first` x per-node cost,
// against a 1000-point ceiling. These are conservative starting values; gql() logs the real
// actualQueryCost of the first page of each pass so they can be raised on evidence.
/**
 * Bump whenever the snapshot gains or changes a field the UI depends on.
 *
 * WHY THIS EXISTS: the filter bar renders only the facets present in the stored snapshot, so
 * shipping code that adds a facet does nothing until the next scheduled rebuild - new code reading
 * old data, with no error anywhere. Deploying stone cut and centre stone put exactly that in front
 * of a customer. A version stamp makes a deploy that changes the shape of the data rebuild on boot
 * instead of waiting for the clock.
 */
const SCHEMA_VERSION = 2;

const PRODUCT_PAGE = 100;
const VARIANT_PAGE = 100;

const PRODUCTS_QUERY = `
  query LookbookProducts($cursor: String) {
    products(first: ${PRODUCT_PAGE}, after: $cursor, query: "status:ACTIVE OR status:DRAFT") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title handle status productType vendor tags
        options { name values }
        media(first: 8) { nodes { mediaContentType ... on MediaImage { image { url altText } } } }
        carats:     metafield(namespace: "custom", key: "totaldiamondweight")  { value }
        stones:     metafield(namespace: "custom", key: "totaldiamondcount")   { value }
        gemWeight:  metafield(namespace: "custom", key: "gemstone_weight")     { value }
        gemPcs:     metafield(namespace: "custom", key: "coloured_stone_pcs")  { value }
        makingRate: metafield(namespace: "custom", key: "making_charges_rate") { value }
        catMf:      metafield(namespace: "custom", key: "category")             { value }
        subCat:     metafield(namespace: "custom", key: "sub_category")         { value }
        cstWeight:  metafield(namespace: "custom", key: "cst_weight")           { value }
        cstCount:   metafield(namespace: "custom", key: "cst_count")            { value }
        stoneCut:   metafield(namespace: "custom", key: "stone_cut")            { value }
      }
    }
  }`;

const VARIANTS_QUERY = `
  query LookbookVariants($cursor: String) {
    productVariants(first: ${VARIANT_PAGE}, after: $cursor, query: "product_status:active OR product_status:draft") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id sku title price inventoryQuantity availableForSale
        selectedOptions { name value }
        image { url }
        product { id status }
        net:         metafield(namespace: "custom", key: "net_metal_weight_g")   { value }
        gross:       metafield(namespace: "custom", key: "gross_weight_g")       { value }
        grossLegacy: metafield(namespace: "custom", key: "gross_wt")             { value }
        totalMetal:  metafield(namespace: "custom", key: "total_metal_weight_g") { value }
        carats:      metafield(namespace: "custom", key: "totaldiamondweight")   { value }
        pricedAt:    metafield(namespace: "custom", key: "gold_last_updated_at") { value }
        bGold:       metafield(namespace: "custom", key: "price_breakup_gold")    { value }
        bDiamond:    metafield(namespace: "custom", key: "price_breakup_diamond") { value }
        bMaking:     metafield(namespace: "custom", key: "price_breakup_making")  { value }
        bGem:        metafield(namespace: "custom", key: "gemstone_charges")      { value }
        bGst:        metafield(namespace: "custom", key: "price_breakup_gst")     { value }
        bSubtotal:   metafield(namespace: "custom", key: "price_subtotal")        { value }
        bTotal:      metafield(namespace: "custom", key: "price_total")           { value }
        goldRate:    metafield(namespace: "custom", key: "gold_rate")             { value }
      }
    }
  }`;

// -- Field derivation --------------------------------------------------------

/** `gid://shopify/Product/123` becomes `123`. The UI and the live endpoint both key on the bare id. */
const numericId = (gid) => String(gid || '').split('/').pop() || null;

/**
 * Absent stays absent. Number('') is 0, so without the empty check a metafield that simply is not
 * set reads as a real zero -- which is not a rounding detail here: it would let an unset variant
 * carat value override the product's design spec with 0.00 ct, and print that under the photo.
 */
const num = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const mfNum = (mf) => num(mf && mf.value);

/** Matches templates/pricing-estimate.liquid:371-380 -- staff and customers both read "Yellow Gold". */
const TONE_LABELS = {
  YG: 'Yellow Gold', WG: 'White Gold', RG: 'Rose Gold',
  Y:  'Yellow Gold', W:  'White Gold', P:  'Rose Gold',
  // PG (pink gold) is what the live catalog actually carries on ~two thirds of its products -
  // the first run against the real store surfaced "PG" as a raw facet value in front of
  // customers. PK/RS are included as near neighbours rather than waiting for the next surprise.
  PG: 'Rose Gold', PK: 'Rose Gold', RS: 'Rose Gold',
};
const toneLabel = (code) => TONE_LABELS[String(code || '').trim().toUpperCase()] || (code || null);

/** Design-id prefixes seen in this catalog. Only a fallback -- productType wins when it is set. */
const CATEGORY_BY_PREFIX = {
  NK: 'Necklace', RG: 'Ring', ER: 'Earring', BR: 'Bracelet',
  BN: 'Bangle', PD: 'Pendant', CH: 'Chain', SC: 'Silver Coin',
};

/**
 * Pipe-delimited SKU: `NK00026|P|14|VVSVS-EFG|H|16|6.00|NA`.
 *
 * Every segment here is already load-bearing elsewhere -- segment 2 picks the gold rate in
 * shopify_snapshot.py:202-211 and groups GST in delivery-challan.liquid:109. Parsed defensively:
 * plenty of SKUs in this catalog are not in this format at all, and a lookbook that throws on one
 * odd SKU shows an empty page.
 */
function parseSku(sku) {
  const parts = String(sku || '').split('|').map((s) => s.trim());
  const empty = { designId: null, prefix: null, tone: null, karat: null, grade: null, family: null };
  if (parts.length < 3 || !parts[0]) return empty;
  const prefixMatch = parts[0].match(/^[A-Za-z]+/);
  return {
    designId: parts[0] || null,
    prefix:   prefixMatch ? prefixMatch[0].toUpperCase() : null,
    tone:     parts[1] || null,
    karat:    parts[2] ? parts[2] + 'K' : null,
    grade:    parts[3] && parts[3] !== 'NA' ? parts[3] : null,
    // `search_prefix` in the price-update snapshot: design + tone + karat, i.e. the product family.
    family:   parts.slice(0, 3).join('|'),
  };
}

/**
 * Variant options keyed by option NAME, not position.
 *
 * reporting/reports.js:63-88 splits on " / " positionally and warns about it in its own comment:
 * it does that only because the REST draft-order payload carries no selectedOptions. Here it does,
 * so the names are used, and the positional split survives purely as a fallback for products whose
 * options are unnamed.
 */
function optionsOf(variant) {
  const out = {};
  for (const o of (variant.selectedOptions || [])) {
    if (!o || !o.name || !o.value || o.value === 'Default Title') continue;
    out[String(o.name).trim().toLowerCase()] = String(o.value).trim();
  }
  if (Object.keys(out).length) return out;

  const t = String(variant.title || '').trim();
  if (!t || t === 'Default Title') return out;
  const parts = t.split(' / ').map((s) => s.trim()).filter(Boolean);
  if (parts[0]) out.__pos1 = parts[0];
  if (parts[1]) out.__pos2 = parts[1];
  if (parts[2]) out.__pos3 = parts[2];
  return out;
}

/** First option whose name matches any of `names`; falls back to a positional slot. */
function pickOption(opts, names, posKey) {
  for (const n of names) {
    for (const k of Object.keys(opts)) {
      if (k === n || k.indexOf(n) !== -1) return opts[k];
    }
  }
  return opts[posKey] || null;
}

/**
 * Gross weight, in the precedence server.js:1120-1125 established the hard way:
 * total_metal_weight_g is frequently set equal to NET, so reading it first prints the net weight
 * in the gross column. It is the last resort, not the first choice.
 */
const grossWeightOf = (v) => {
  const a = mfNum(v.gross);
  if (a !== null) return a;
  const b = mfNum(v.grossLegacy);
  if (b !== null) return b;
  return mfNum(v.totalMetal);
};

const BANDS = {
  // timanti.in's own price bands, lifted from the storefront's Rings mega-menu, so a staff member
  // filtering here sees the same buckets a customer sees on the site.
  price: [[20000, 'Under ₹20k'], [50000, '₹20k – ₹50k'], [75000, '₹50k – ₹75k'],
          [100000, '₹75k – ₹1L'], [Infinity, '₹1L & Above']],
  weight: [[2, 'Under 2g'], [5, '2-5g'], [10, '5-10g'], [20, '10-20g'], [Infinity, '20g+']],
  carat: [[0.25, 'Under 0.25ct'], [0.5, '0.25-0.5ct'], [1, '0.5-1ct'], [2, '1-2ct'], [Infinity, '2ct+']],
  // Centre stone is a different conversation from total carat weight - a 1ct solitaire and a 1ct
  // cluster are not the same piece - so it gets its own scale.
  cst: [[0.5, 'Under 0.5ct'], [1, '0.5-1ct'], [1.5, '1-1.5ct'], [2, '1.5-2ct'], [3, '2-3ct'], [Infinity, '3ct+']],
};

/**
 * custom.stone_cut is a list.single_line_text_field, so Shopify hands it over as a JSON array in a
 * string: ["Round","Cushion"]. Parsed defensively - a malformed value must not take out the whole
 * nightly build for the sake of one product.
 */
function parseList(mf) {
  const raw = mf && mf.value;
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    return [String(v).trim()].filter(Boolean);
  } catch (err) {
    return String(raw).split(',').map((x) => x.trim()).filter(Boolean);
  }
}

function bandOf(value, bands) {
  if (!(value > 0)) return null;
  for (const pair of bands) if (value < pair[0]) return pair[1];
  return null;
}

// -- Normalisation -----------------------------------------------------------

/**
 * Join the two passes into the product-shaped records the UI browses.
 *
 * A card is a PRODUCT; its variants are chips inside it. So each product carries the union of its
 * variants' filterable values -- a product matches "18K" if any of its variants is 18K -- which is
 * what lets the client filter the whole catalog in a single pass over one array.
 */
function normalize(products, variants) {
  const byProduct = new Map();
  for (const v of variants) {
    const pid = numericId(v.product && v.product.id);
    if (!pid) continue;
    if (!byProduct.has(pid)) byProduct.set(pid, []);
    byProduct.get(pid).push(v);
  }

  const items = [];
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];

  for (const p of products) {
    const pid = numericId(p.id);
    if (!pid || p.status === 'ARCHIVED') continue;

    const media = (p.media && p.media.nodes ? p.media.nodes : [])
      .filter((m) => m && m.mediaContentType === 'IMAGE' && m.image && m.image.url)
      .map((m) => ({ url: m.image.url, alt: m.image.altText || '' }));

    const productCarats = mfNum(p.carats);

    const variantRecords = (byProduct.get(pid) || []).map((v) => {
      const opts = optionsOf(v);
      const sku  = parseSku(v.sku);
      const net  = mfNum(v.net);

      // Karat/tone/size come from the named option first and the SKU second. Both exist in this
      // catalog and they agree; the SKU covers products whose options were never named.
      const karat   = pickOption(opts, ['karat', 'purity', 'metal'], '__pos1') || sku.karat;
      const toneRaw = pickOption(opts, ['tone', 'colour', 'color'], '__pos2') || sku.tone;
      const size    = pickOption(opts, ['size', 'length'], '__pos3');

      return {
        id:    numericId(v.id),
        sku:   v.sku || null,
        title: v.title && v.title !== 'Default Title' ? v.title : null,
        price: num(v.price),
        // The pricer skips zero-weight variants (shopify_snapshot.py:219-236), so their price is
        // whatever someone last set by hand. Presenting that to a customer as today's price is the
        // one genuinely damaging thing this page could do, hence the explicit flag.
        priceManaged: net > 0,
        stock: Number.isFinite(v.inventoryQuantity) ? v.inventoryQuantity : null,
        available: v.availableForSale === true,
        karat: karat || null,
        tone: toneRaw || null,
        toneLabel: toneLabel(toneRaw),
        size: size || null,
        grade: sku.grade,
        family: sku.family,
        image: v.image && v.image.url ? v.image.url : null,
        netWt: net,
        grossWt: grossWeightOf(v),
        carats: mfNum(v.carats) !== null ? mfNum(v.carats) : productCarats,
        pricedAt: (v.pricedAt && v.pricedAt.value) || null,
        goldRate: mfNum(v.goldRate),
        // The component breakdown the daily pricer writes. Kept as its own object rather than
        // flattened so the UI can render "every row that exists" without knowing the key names,
        // and so a variant the pricer skipped simply has an empty breakup instead of a row of
        // zeroes that would read as "this piece has no making charge".
        breakup: {
          gold:     mfNum(v.bGold),
          diamond:  mfNum(v.bDiamond),
          gemstone: mfNum(v.bGem),
          making:   mfNum(v.bMaking),
          subtotal: mfNum(v.bSubtotal),
          gst:      mfNum(v.bGst),
          total:    mfNum(v.bTotal),
        },
      };
    });

    const prices  = variantRecords.map((v) => v.price).filter((n) => n > 0);
    const weights = variantRecords.map((v) => v.grossWt).filter((n) => n > 0);
    const firstSku = parseSku(variantRecords.length ? variantRecords[0].sku : null);

    items.push({
      id: pid,
      title: p.title,
      handle: p.handle,
      status: p.status,
      draft: p.status === 'DRAFT',
      // productType is the category of record; custom.category and the SKU prefix are fallbacks
      // for the handful of products where productType is unset.
      category: p.productType || (p.catMf && p.catMf.value) || CATEGORY_BY_PREFIX[firstSku.prefix] || 'Uncategorised',
      subCategory: (p.subCat && p.subCat.value) || null,
      cstWeight: mfNum(p.cstWeight),
      cstCount: mfNum(p.cstCount),
      cstBand: bandOf(mfNum(p.cstWeight), BANDS.cst),
      stoneCuts: parseList(p.stoneCut),
      vendor: p.vendor || null,
      tags: p.tags || [],
      family: firstSku.family,
      media,
      // Product-level design spec. Per server.js:1141-1143 the per-unit RATES are product-level;
      // the values they produce are variant-level.
      carats: productCarats,
      stones: mfNum(p.stones),
      gemWeight: mfNum(p.gemWeight),
      gemPcs: mfNum(p.gemPcs),
      makingRate: mfNum(p.makingRate),
      hasColouredStones: (mfNum(p.gemPcs) || 0) > 0 || (mfNum(p.gemWeight) || 0) > 0,
      priceFrom: prices.length ? Math.min.apply(null, prices) : null,
      priceTo:   prices.length ? Math.max.apply(null, prices) : null,
      priceManaged: variantRecords.some((v) => v.priceManaged),
      weightFrom: weights.length ? Math.min.apply(null, weights) : null,
      karats: uniq(variantRecords.map((v) => v.karat)),
      tones:  uniq(variantRecords.map((v) => v.toneLabel)),
      sizes:  uniq(variantRecords.map((v) => v.size)),
      grades: uniq(variantRecords.map((v) => v.grade)),
      priceBand:  bandOf(prices.length ? Math.min.apply(null, prices) : null, BANDS.price),
      weightBand: bandOf(weights.length ? Math.min.apply(null, weights) : null, BANDS.weight),
      caratBand:  bandOf(productCarats, BANDS.carat),
      variants: variantRecords,
    });
  }

  // Pieces with no photograph are KEPT and flagged, not dropped. 174 of the live catalog's active
  // products have no image in Shopify at all; removing them means a staff member searches for one
  // and it simply is not there, with no explanation. The UI sorts them to the very end instead, so
  // the lookbook still leads with photography without pretending the rest do not exist.
  for (const it of items) it.noImage = !(it.media.length || it.variants.some((v) => v.image));
  return { items, droppedNoImage: items.filter((i) => i.noImage).length };
}

/**
 * Facet lists, counted, built from what the catalog actually contains.
 *
 * Derived rather than declared: gender, style and collection do not exist in this data today, and
 * a hardcoded rail would show permanently empty filters. If those fields ever get populated they
 * appear here on the next nightly build with no code change.
 */
function buildFacets(items) {
  const tally = (values) => {
    const counts = new Map();
    for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .map((e) => ({ value: e[0], count: e[1] }));
  };
  const flat = (fn) => items.reduce((acc, i) => {
    const r = fn(i);
    return acc.concat(Array.isArray(r) ? r : [r]);
  }, []);
  const ordered = (values, order) =>
    tally(values).sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value));

  // Sub-category chips carry their parent category. 30 values across 6 categories is unusable as
  // one flat list, so the UI narrows them once a category is chosen.
  const subCounts = new Map();
  for (const i of items) {
    if (!i.subCategory) continue;
    const k = JSON.stringify([i.category, i.subCategory]);
    subCounts.set(k, (subCounts.get(k) || 0) + 1);
  }
  const subCategory = [...subCounts.entries()]
    .map((e) => { const p = JSON.parse(e[0]); return { value: p[1], count: e[1], parent: p[0] }; })
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

  const facets = {
    category: tally(flat((i) => i.category)),
    subCategory,
    stoneCut: tally(flat((i) => i.stoneCuts)),
    cstBand: ordered(flat((i) => i.cstBand), BANDS.cst.map((b) => b[1])),
    cstCount: tally(flat((i) => (i.cstCount > 0 ? String(i.cstCount) : null)))
      .sort((a, b) => Number(a.value) - Number(b.value)),
    karat: tally(flat((i) => i.karats)).sort((a, b) => parseInt(a.value, 10) - parseInt(b.value, 10)),
    tone: tally(flat((i) => i.tones)),
    size: tally(flat((i) => i.sizes)).sort((a, b) => (num(a.value) || 0) - (num(b.value) || 0)),
    grade: tally(flat((i) => i.grades)),
    priceBand:  ordered(flat((i) => i.priceBand),  BANDS.price.map((b) => b[1])),
    weightBand: ordered(flat((i) => i.weightBand), BANDS.weight.map((b) => b[1])),
    caratBand:  ordered(flat((i) => i.caratBand),  BANDS.carat.map((b) => b[1])),
  };

  // Drop facets the catalog cannot fill -- a rail of empty filters is worse than a shorter rail.
  for (const k of Object.keys(facets)) if (!facets[k].length) delete facets[k];
  return facets;
}

// -- Build -------------------------------------------------------------------

async function buildSnapshot() {
  const startedAt = Date.now();

  const products = await paginate(PRODUCTS_QUERY, (d) => d && d.products, { label: 'products' });
  log.info('lookbook', `products pass: ${products.length} products`);

  const variants = await paginate(VARIANTS_QUERY, (d) => d && d.productVariants, { label: 'variants' });
  log.info('lookbook', `variants pass: ${variants.length} variants`);

  const normalized = normalize(products, variants);
  const items = normalized.items;

  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    builtAt: new Date().toISOString(),
    buildMs: Date.now() - startedAt,
    productCount: items.length,
    variantCount: items.reduce((n, i) => n + i.variants.length, 0),
    droppedNoImage: normalized.droppedNoImage,
    facets: buildFacets(items),
    items,
  };

  log.info('lookbook',
    `snapshot built: ${snapshot.productCount} products / ${snapshot.variantCount} variants in ` +
    `${Math.round(snapshot.buildMs / 1000)}s (${snapshot.droppedNoImage} skipped for having no image)`);

  return snapshot;
}

module.exports = {
  SCHEMA_VERSION,
  buildSnapshot, normalize, buildFacets, parseList,
  parseSku, optionsOf, pickOption, toneLabel, grossWeightOf, bandOf, numericId, BANDS,
};
