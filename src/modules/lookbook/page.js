'use strict';

/**
 * The two pages: the password gate and the lookbook itself.
 *
 * Styled to timanti.in, not to a generic admin tool, because a customer sees this screen over the
 * counter. The tokens below were read off the live storefront rather than guessed: IvyMode display
 * serif over Mulish sans, pure white ground, black hairline rules, square corners everywhere (the
 * storefront uses border-radius 0 throughout), and a single orange accent, #fc7d27, which is the
 * exact colour the site uses for its active nav item.
 *
 * The structure mirrors the storefront too: a black announcement bar, a centred serif wordmark,
 * the categories as a nav row, and a HORIZONTAL filter bar above the grid - timanti.in puts its
 * collection filters in a bar (Metal / Stone shape / Price / Type / Stone Size), not a sidebar.
 *
 * Fonts are named but never fetched. The page stays self-contained - no external stylesheet, no
 * CDN - so it opens instantly on shop-floor wifi; a device with IvyMode/Mulish installed renders
 * them exactly, everything else falls back gracefully.
 *
 * IMPORTANT, if you edit the client script below: it sits inside a server-side template literal,
 * so client-side JS here uses string CONCATENATION rather than its own template literals. A stray
 * dollar-brace would be interpolated by Node at render time instead of by the browser at runtime.
 */

const { CLIENT_SOURCE: CODE_SEARCH_JS } = require('./search');

const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const SHELL_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#fff; --ink:#121212; --muted:rgba(0,0,0,.45);
    --line:#e4e4e4; --tile:#f5f4f2; --accent:#fc7d27;
    --serif:"IvyMode","Playfair Display",Didot,"Bodoni MT",Georgia,serif;
    --sans:Mulish,"Avenir Next","Segoe UI",system-ui,-apple-system,Helvetica,Arial,sans-serif;
  }
  html,body{height:100%}
  body{background:var(--bg);color:var(--ink);font:15px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
  button{font:inherit;color:inherit;background:none;border:none;cursor:pointer}
  img{display:block;max-width:100%}
  /* The storefront is square-cornered throughout - no rounded anything. */
  input,button{border-radius:0}
`;

/** The gate. Deliberately tells an unauthenticated visitor nothing about the catalog behind it. */
function loginPage({ error = '', configured = true } = {}) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Lookbook</title>
<style>
${SHELL_CSS}
  body{display:flex;flex-direction:column}
  .announce{background:#000;color:#fff;text-align:center;padding:9px 16px;
            font-size:10.5px;letter-spacing:.18em;text-transform:uppercase}
  .mid{flex:1;display:grid;place-items:center;padding:24px}
  form{width:100%;max-width:330px;text-align:center}
  .wordmark{font-family:var(--serif);font-size:34px;letter-spacing:.16em;margin-bottom:6px}
  .sub{font-size:10.5px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);margin-bottom:30px}
  input{width:100%;padding:13px 16px;border:1px solid var(--line);background:var(--bg);
        color:var(--ink);font-size:16px;text-align:center;letter-spacing:.06em;font-family:var(--sans)}
  input:focus{outline:none;border-color:var(--ink)}
  button{width:100%;margin-top:10px;padding:13px;border:1px solid var(--ink);
         font-size:13px;letter-spacing:.1em;text-transform:uppercase}
  button:hover{background:var(--ink);color:#fff}
  .err{margin-top:14px;color:var(--accent);font-size:13.5px;min-height:20px}
  .note{margin-top:18px;color:var(--muted);font-size:13px;line-height:1.6}
</style></head><body>
  <div class="announce">Certified and hallmarked lab grown diamond jewellery</div>
  <div class="mid">
    <form method="POST" action="/lookbook/login">
      <div class="wordmark">TIMANTI</div>
      <div class="sub">Catalog Lookbook</div>
      ${configured
        ? `<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
           <button type="submit">Open</button>
           <div class="err">${esc(error)}</div>`
        : `<div class="note">Not configured on this deployment.<br>Set LOOKBOOK_PASSWORD and LOOKBOOK_SESSION_SECRET.</div>`}
    </form>
  </div>
</body></html>`;
}

/**
 * The lookbook: a collection page and a PDP, in the storefront's own clothes.
 *
 * The two surfaces are deliberately different. The collection view may show whatever helps staff
 * find a piece; the PDP is what gets turned around to face a buyer, so it starts clean every time
 * it opens (see the reset of `staff` in openAt) rather than remembering that someone left the
 * internal panel up.
 */
function appPage() {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Lookbook</title>
<!-- Every product image comes from Shopify's CDN. Opening that connection during HTML parse saves
     a DNS lookup + TLS handshake before the first tile can even start downloading. -->
<link rel="preconnect" href="https://cdn.shopify.com" crossorigin>
<link rel="dns-prefetch" href="https://cdn.shopify.com">
<style>
${SHELL_CSS}
  /* -- masthead ------------------------------------------------------------ */
  .announce{background:#000;color:#fff;text-align:center;padding:9px 16px;
            font-size:10.5px;letter-spacing:.18em;text-transform:uppercase}
  .head{position:sticky;top:0;z-index:30;background:var(--bg);border-bottom:1px solid var(--line)}
  .brandline{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:16px;padding:16px 24px 10px}
  .wordmark{font-family:var(--serif);font-size:29px;letter-spacing:.15em;text-align:center;white-space:nowrap}
  .meta{font-size:11.5px;color:var(--muted);letter-spacing:.03em}
  .tools{display:flex;justify-content:flex-end}
  .search{width:min(260px,42vw);padding:8px 12px;border:1px solid var(--line);
          font-size:13.5px;font-family:var(--sans);color:var(--ink);background:var(--bg)}
  .search:focus{outline:none;border-color:var(--ink)}
  .nav{display:flex;justify-content:center;gap:26px;padding:4px 24px 13px;overflow-x:auto;white-space:nowrap}
  .nav button{font-size:12.5px;letter-spacing:.07em;text-transform:uppercase;padding:3px 0}
  .nav button:hover{color:var(--accent)}
  .nav button.on{color:var(--accent)}

  /* -- filter bar (horizontal, like the storefront's collection page) ------- */
  .filterbar{display:flex;align-items:center;gap:22px;padding:0 24px;
             border-bottom:1px solid var(--line);min-height:52px;flex-wrap:wrap}
  .fb{font-size:13.5px;padding:14px 0;display:inline-flex;align-items:center;gap:6px}
  .fb .cv{font-size:8px;opacity:.45}
  .fb:hover{color:var(--accent)}
  .fb.on{color:var(--accent)}
  .fb .n{font-size:10.5px;color:var(--accent)}
  .spacer{flex:1}
  .clear{font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
  .clear:hover{color:var(--accent)}
  .sortwrap{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted)}
  .sortwrap select{border:1px solid var(--line);padding:6px 8px;font:inherit;color:var(--ink);background:var(--bg)}
  .sortwrap select:focus{outline:none;border-color:var(--accent)}
  .range{display:flex;align-items:center;gap:8px;margin-top:16px;padding-top:14px;border-top:1px solid var(--line);flex-wrap:wrap}
  .range label{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
  .range input{width:110px;padding:7px 10px;border:1px solid var(--line);font:inherit;font-size:13px;color:var(--ink);background:var(--bg)}
  .range input:focus{outline:none;border-color:var(--accent)}
  .range button{padding:7px 14px;border:1px solid var(--ink);font-size:12px;letter-spacing:.06em;text-transform:uppercase}
  .range button:hover{background:var(--ink);color:#fff}
  .range .rclear{border-color:var(--line);color:var(--muted)}
  .nophoto{position:absolute;left:0;bottom:0;right:0;padding:6px 9px;background:rgba(0,0,0,.55);color:#fff;
           font-size:9.5px;letter-spacing:.11em;text-transform:uppercase;text-align:center}
  .panel{display:none;border-bottom:1px solid var(--line);padding:18px 24px 22px}
  .panel.open{display:block}
  .chips{display:flex;flex-wrap:wrap;gap:8px}
  .chip{padding:7px 13px;border:1px solid var(--line);font-size:13px;background:var(--bg)}
  .chip:hover{border-color:var(--ink)}
  .chip.on{border-color:var(--accent);color:var(--accent)}
  .chip .n{color:var(--muted);font-size:10.5px;margin-left:6px}
  .chip.on .n{color:var(--accent)}

  /* -- product grid -------------------------------------------------------- */
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:34px 18px;padding:26px 24px 70px}
  @media(min-width:1000px){.grid{grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:46px 24px;padding:34px 24px 90px}}
  .card{cursor:pointer}
  .shot{position:relative;aspect-ratio:1;background:var(--tile);overflow:hidden}
  .shot img{width:100%;height:100%;object-fit:cover;transition:opacity .2s}
  .card:hover .shot img{opacity:.9}
  .noimg{width:100%;height:100%;display:grid;place-items:center;color:#d6d3ce;font-size:26px}
  .flag{position:absolute;left:0;top:0;padding:5px 9px;background:#000;color:#fff;
        font-size:9.5px;letter-spacing:.11em;text-transform:uppercase}
  .info{padding-top:13px}
  .name{font-family:var(--serif);font-size:16px;line-height:1.3;margin-bottom:5px}
  .cost{font-size:13.5px}
  .cost .from{color:var(--muted);font-size:12px}
  .avail{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-top:4px}
  .swatches{display:flex;gap:7px;margin-top:11px;flex-wrap:wrap;align-items:center}
  .sw{width:17px;height:17px;border-radius:50%;border:1px solid rgba(0,0,0,.18)}
  .sw.on{box-shadow:0 0 0 2px var(--bg),0 0 0 3px var(--accent)}
  .kt{padding:2px 7px;border:1px solid var(--line);font-size:10.5px;color:var(--muted);letter-spacing:.04em}
  .kt:hover{border-color:var(--ink);color:var(--ink)}
  .kt.on{border-color:var(--accent);color:var(--accent)}
  .empty,.loading{padding:70px 24px;color:var(--muted);font-family:var(--serif);font-size:17px}

  /* -- PDP ----------------------------------------------------------------- */
  .pdp{position:fixed;inset:0;z-index:60;background:var(--bg);display:none;flex-direction:column}
  .pdp.open{display:flex}
  .pdpbar{display:flex;align-items:center;gap:12px;padding:12px 22px;border-bottom:1px solid var(--line);flex:none}
  .pos{font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
  .pdpbar .sp{flex:1}
  .iconbtn{width:33px;height:33px;border:1px solid var(--line);font-size:15px;line-height:1}
  .iconbtn:hover{border-color:var(--ink)}
  .iconbtn.on{background:var(--accent);border-color:var(--accent);color:#fff}
  .pdpbody{flex:1;min-height:0;overflow-y:auto}
  @media(min-width:900px){.pdpbody{display:grid;grid-template-columns:1.05fr .95fr;gap:44px;padding:28px 34px;overflow:hidden}}
  .gallery{display:flex;flex-direction:column;min-height:0}
  .hero{position:relative;flex:1;min-height:44vh;background:var(--tile);overflow:hidden;touch-action:none}
  .hero img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
  /* Invisible tap-to-advance zones, stacked BELOW the corner controls on purpose: as later
     siblings they otherwise won paint order and swallowed the close button entirely. */
  .navz{position:absolute;top:0;bottom:0;width:20%;opacity:0;z-index:1}
  .navz.prev{left:0} .navz.next{right:0}
  .thumbs{display:flex;gap:9px;padding:13px 0 0;flex:none;overflow-x:auto}
  .thumbs img{width:56px;height:56px;object-fit:cover;border:1px solid var(--line);cursor:pointer;flex:none}
  .thumbs img.on{border-color:var(--accent)}
  .buybox{padding:22px;min-height:0;overflow-y:auto}
  @media(min-width:900px){.buybox{padding:0 6px 0 0}}
  .eyebrow{font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin-bottom:9px}
  .buybox h1{font-family:var(--serif);font-size:27px;font-weight:400;line-height:1.2;margin-bottom:11px}
  .price{font-size:21px;margin-bottom:5px}
  .stock{font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:24px}
  .stock .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--accent);margin-right:7px;vertical-align:1px}
  .stock .flag{position:static;margin-left:9px}
  .opt{margin-bottom:18px}
  .opt .lbl{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-bottom:9px}
  .opt .row{display:flex;flex-wrap:wrap;gap:8px}
  .specs{margin-top:26px;border-top:1px solid var(--line)}
  .specs .r{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid var(--line);font-size:13.5px}
  .specs .r span:first-child{color:var(--muted)}
  .breakup{margin-top:26px;border:1px solid var(--line);padding:16px 18px}
  .breakup .bt{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
  .breakup .r{display:flex;justify-content:space-between;gap:16px;padding:5px 0;font-size:13.5px}
  .breakup .r span:first-child{color:var(--muted)}
  .breakup .r.sub{border-top:1px solid var(--line);margin-top:7px;padding-top:10px}
  .breakup .r.tot{border-top:1px solid var(--ink);margin-top:7px;padding-top:10px;font-size:15px}
  .breakup .r.tot span{color:var(--ink)}
  .breakup .note{margin-top:10px;font-size:11px;letter-spacing:.05em;color:var(--muted)}
  .staff{margin-top:20px;padding:14px 16px;background:var(--tile);font-size:12.5px;color:var(--muted);display:none}
  .staff.on{display:block}
  .staff code{color:var(--ink);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .staff a{color:var(--accent)}

  /* -- design-code search ---------------------------------------------------- */
  .searchwrap{position:relative}
  .suggest{position:absolute;right:0;top:calc(100% + 4px);width:min(440px,92vw);max-height:70vh;overflow-y:auto;
           background:var(--bg);border:1px solid var(--ink);z-index:50;display:none;text-align:left}
  .suggest.open{display:block}
  /* Phones: hang the list off the sticky header, full width, instead of off the narrow input. */
  @media(max-width:700px){.searchwrap{position:static}.suggest{left:12px;right:12px;width:auto;top:100%}}
  .sg{display:grid;grid-template-columns:auto 1fr auto;gap:4px 12px;padding:10px 12px;border-bottom:1px solid var(--line);cursor:pointer;align-items:baseline}
  .sg:last-child{border-bottom:none}
  .sg.on,.sg:hover{background:var(--tile)}
  .sg .c{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;font-weight:700;letter-spacing:.02em}
  .sg .c.exact{color:var(--accent)}
  .sg .t{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sg .p{font-size:12px;color:var(--muted);white-space:nowrap}
  .sg .s{grid-column:1 / -1;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
  .sg .s.in{color:var(--accent)}
  .sghint{padding:8px 12px;font-size:11.5px;color:var(--muted)}
  .code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;letter-spacing:.03em;margin-bottom:4px}
  .code.hit{color:var(--accent);font-weight:700}
  .instock{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin-top:4px}
  .mto{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-top:4px}

  /* -- PDP: live price, available variant, draft order ---------------------- */
  .livenote{font-size:11px;letter-spacing:.05em;color:var(--muted);margin-bottom:20px}
  .livenote.wait{color:var(--accent)}
  .actions{margin:20px 0 6px;display:flex;flex-direction:column;gap:10px}
  .act{padding:11px 14px;border:1px solid var(--ink);font-size:12.5px;letter-spacing:.08em;text-transform:uppercase;text-align:center}
  .act:hover{background:var(--ink);color:#fff}
  .act.primary{background:var(--ink);color:#fff}
  .act.primary:hover{background:var(--accent);border-color:var(--accent)}
  .act[disabled]{opacity:.5;cursor:default}
  .actrow{display:flex;gap:8px}
  .actions .row{display:flex;flex-wrap:wrap;gap:8px}
  .actrow .act{flex:1}
  .res{font-size:12.5px;line-height:1.5}
  .res.err{color:var(--accent)}
  .res a{color:var(--accent)}
  .res code,.vline code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink)}
  .vline{font-size:11.5px;color:var(--muted);line-height:1.5}
  .signedout{position:fixed;left:0;right:0;bottom:0;z-index:90;background:var(--accent);color:#fff;
             padding:12px 18px;text-align:center;font-size:13px;display:none}
  .signedout.on{display:block}
  .signedout a{color:#fff;font-weight:700}
</style></head><body>

<div class="announce">Certified and hallmarked lab grown diamond jewellery</div>

<header class="head">
  <div class="brandline">
    <span class="meta" id="count"></span>
    <div class="wordmark">TIMANTI</div>
    <div class="tools"><div class="searchwrap">
      <input class="search" id="q" type="search" placeholder="Search name or design code" autocomplete="off"
             autocapitalize="characters" spellcheck="false" role="combobox" aria-autocomplete="list" aria-controls="suggest">
      <div class="suggest" id="suggest" role="listbox"></div>
    </div></div>
  </div>
  <nav class="nav" id="nav"></nav>
</header>

<div class="filterbar" id="filterbar"></div>
<div class="panel" id="panel"></div>

<div class="loading" id="loading">Loading catalog...</div>
<main class="grid" id="grid"></main>

<div class="pdp" id="pdp">
  <div class="pdpbar">
    <span class="pos" id="pos"></span>
    <span class="sp"></span>
    <button class="iconbtn" id="staffBtn" title="Staff details">i</button>
    <button class="iconbtn" id="closeBtn" title="Close">&times;</button>
  </div>
  <div class="pdpbody">
    <div class="gallery">
      <div class="hero" id="hero">
        <img id="heroImg" alt="">
        <div class="navz prev" id="navPrev"></div>
        <div class="navz next" id="navNext"></div>
      </div>
      <div class="thumbs" id="thumbs"></div>
    </div>
    <div class="buybox" id="buybox"></div>
  </div>
</div>

<div class="signedout" id="signedout">This screen has been signed out, so prices can no longer be checked live.
  <a href="/lookbook">Sign in again</a></div>

<script>
(function () {
  'use strict';

  /* Design-code matching, shared verbatim with search.js (and its tests). */
  ${CODE_SEARCH_JS}

  var S = { items: [], facets: {}, built: null, hidden: 0, etag: null, sel: {}, q: '',
            pmin: null, pmax: null, sort: 'featured',
            filtered: [], live: {}, card: {}, open: null, idx: -1, img: 0, axis: {}, staff: false,
            /* PDP state, reset on every open: the pinned variant, the in-stock lookup, the draft box */
            vid: null, avail: null, draft: null, pdpLive: 'idle',
            /* what the last /lookbook/pulse said */
            epoch: null, repricing: false,
            sugg: { list: [], idx: -1 } };

  /* A live price older than this is re-read before it is shown on a card. The PDP always re-reads. */
  var LIVE_TTL = 3 * 60 * 1000;
  var PULSE_MS = 45 * 1000;

  var FACET_LABELS = { subCategory:'Type', karat:'Karat', tone:'Metal', size:'Size',
                       stoneCut:'Stone cut', grade:'Diamond grade', priceBand:'Price',
                       cstBand:'Centre stone', cstCount:'Centre stones',
                       weightBand:'Gold weight', caratBand:'Total diamonds',
                       channel:'Sales channel', photo:'Photos' };
  /* Category is promoted out of the filter bar and into the nav, the way the storefront does it. */
  var BAR_ORDER = ['subCategory','karat','tone','size','stoneCut','cstBand','cstCount',
                   'grade','priceBand','weightBand','caratBand','channel','photo'];
  var ITEM_FIELD = { category:'category', subCategory:'subCategory', karat:'karats', tone:'tones',
                     size:'sizes', stoneCut:'stoneCuts', grade:'grades', priceBand:'priceBand',
                     cstBand:'cstBand', cstCount:'cstCount',
                     weightBand:'weightBand', caratBand:'caratBand',
                     channel:'channels', photo:'photo' };
  var TONE_HEX = { 'Yellow Gold':'#e3c04a', 'White Gold':'#dcdde0', 'Rose Gold':'#e3b19d' };

  var $ = function (id) { return document.getElementById(id); };
  var money = new Intl.NumberFormat('en-IN', { style:'currency', currency:'INR', maximumFractionDigits:0 });

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  /* Shopify's CDN resizes on request, which is the single biggest thing making this usable on
     store wifi. Anything that is not an http(s) URL - a data: placeholder, say - passes through
     untouched, because appending a query to it would corrupt it. */
  function px(url, w) {
    if (!url) return '';
    if (String(url).slice(0, 4) !== 'http') return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'width=' + w;
  }
  /* Cheapest variant the daily pricer actually MAINTAINS, falling back to the cheapest of any.
     Picking on price alone opened a piece on a zero-weight variant whenever that happened to be
     the lowest number - which then showed "Price on request" and no breakup on a product whose
     other variants are perfectly well priced. The default a customer lands on should be a real,
     quotable one. */
  function cheapest(it) {
    var managed = null, any = null;
    for (var i = 0; i < it.variants.length; i++) {
      var v = it.variants[i];
      if (!(v.price > 0)) continue;
      if (!any || v.price < any.price) any = v;
      if (v.priceManaged && (!managed || v.price < managed.price)) managed = v;
    }
    return managed || any || it.variants[0] || null;
  }
  function cardVariant(it) {
    var sel = S.card[it.id];
    if (sel) {
      for (var i = 0; i < it.variants.length; i++) {
        var v = it.variants[i];
        if ((!sel.tone || v.toneLabel === sel.tone) && (!sel.karat || v.karat === sel.karat)) return v;
      }
    }
    return cheapest(it);
  }
  /* The catalog's alt text encodes the metal tone, consistently, on every image:
       "White Gold-Supernova Statement Solitaires Lab-Grown Diamond Ring_view=3DV"
     That is the storefront's own convention for showing the right colour for the selected variant,
     so the lookbook follows it rather than inventing one. Only 64% of variants carry their own
     image, which is why matching on alt text - not variant.image - is what actually works. */
  function toneKey(tone) {
    var t = String(tone || '').toLowerCase();
    if (t.indexOf('yellow') !== -1) return 'yellow';
    if (t.indexOf('white') !== -1) return 'white';
    if (t.indexOf('rose') !== -1 || t.indexOf('pink') !== -1) return 'rose';
    return null;
  }

  /* Every image for a product in the selected tone, in Shopify's own media order. */
  function mediaForTone(it, tone) {
    var key = toneKey(tone);
    var all = it.media || [];
    if (!key) return all.map(function (m) { return m.url; });
    var hit = [];
    for (var i = 0; i < all.length; i++) {
      var a = String(all[i].alt || '').toLowerCase();
      /* "rose" also has to catch a "Pink Gold-" prefix. */
      if (a.indexOf(key) === 0 || (key === 'rose' && a.indexOf('pink') === 0)) hit.push(all[i].url);
    }
    return hit;
  }

  function imgFor(it, v) {
    var toned = mediaForTone(it, v && v.toneLabel);
    if (toned.length) return toned[0];
    if (v && v.image) return v.image;
    if (it.media && it.media.length) return it.media[0].url;
    for (var i = 0; i < it.variants.length; i++) if (it.variants[i].image) return it.variants[i].image;
    return null;
  }
  function priceOf(v) {
    if (!v) return null;
    var l = S.live[v.id];
    return l && typeof l.price === 'number' ? l.price : v.price;
  }
  /* Live stock when it has been read, the snapshot's otherwise. null = not tracked. */
  function stockOf(v) {
    if (!v) return null;
    var l = S.live[v.id];
    if (l && typeof l.stock === 'number') return l.stock;
    return typeof v.stock === 'number' ? v.stock : null;
  }
  function inStockVariants(it) {
    return it.variants.filter(function (v) { var s = stockOf(v); return s !== null && s >= 1; });
  }
  function isFresh(id, needFull) {
    var l = S.live[id];
    return !!l && Date.now() - l.at < LIVE_TTL && (!needFull || l.full);
  }
  /* "18K · Yellow Gold · 12": the words staff use for a variant. */
  function variantLabel(v) {
    var bits = [v.karat, v.toneLabel, v.size ? 'size ' + v.size : null, v.grade].filter(Boolean);
    return bits.length ? bits.join(' · ') : (v.title || 'Single variant');
  }
  function codesOf(it) { return it.designIds || []; }
  function stockHtml(it) {
    var ins = inStockVariants(it);
    if (!ins.length) return '<div class="mto">Made to order</div>';
    if (ins.length === 1) return '<div class="instock">In stock · ' + esc(variantLabel(ins[0])) + '</div>';
    return '<div class="instock">' + ins.length + ' variants in stock</div>';
  }

  /* -- filtering ---------------------------------------------------------- */
  function matches(it) {
    it._score = 0;
    if (S.q) {
      /* A design code is matched as a code (RG48 == RG00048, and RG48A excludes RG00048), not as
         a substring - that is what put RG00048 and RG00048A side by side, indistinguishable. */
      if (looksLikeCode(S.q)) it._score = bestCodeScore(S.q, codesOf(it));
      var hay = (it.title + ' ' + (it.family || '') + ' ' +
                 it.variants.map(function (v) { return v.sku || ''; }).join(' ')).toLowerCase();
      if (!it._score && hay.indexOf(S.q) === -1) return false;
    }
    /* An explicit range beats guessing which bucket the customer meant. Overlap, not containment:
       a piece spanning 40k-60k should surface for someone who asked for "under 50k". */
    if (S.pmin !== null && !(it.priceTo >= S.pmin)) return false;
    if (S.pmax !== null && !(it.priceFrom <= S.pmax)) return false;

    for (var k in S.sel) {
      var picked = S.sel[k];
      if (!picked || !picked.length) continue;
      var field = it[ITEM_FIELD[k]];
      var vals = Array.isArray(field) ? field : [field];
      var hit = false;
      for (var i = 0; i < picked.length && !hit; i++) {
        /* Coerced: cstCount is numeric on the item and a string in the facet chip. */
        for (var j = 0; j < vals.length && !hit; j++) {
          if (vals[j] !== null && vals[j] !== undefined && String(vals[j]) === String(picked[i])) hit = true;
        }
      }
      if (!hit) return false;
    }
    return true;
  }
  function activeCount() {
    var n = 0;
    for (var k in S.sel) n += (S.sel[k] || []).length;
    if (S.pmin !== null || S.pmax !== null) n++;
    return n;
  }
  /* Price actually shown, so sorting matches what the customer is reading. */
  function sortPrice(it) {
    var v = cardVariant(it);
    var p = (v && v.priceManaged) ? priceOf(v) : null;
    return p > 0 ? p : (it.priceFrom > 0 ? it.priceFrom : Infinity);
  }

  function apply() {
    S.filtered = S.items.filter(matches);

    /* Photographed pieces lead, whatever the sort. A lookbook is the picture; an unphotographed
       piece is still real and still findable, it just belongs at the end rather than removed. */
    var dir = S.sort === 'asc' ? 1 : (S.sort === 'desc' ? -1 : 0);
    S.filtered.sort(function (a, b) {
      /* A searched code leads everything, photographed or not: the exact RG00048 first, then its
         letter variants, then typeahead continuations. */
      if (a._score !== b._score) return b._score - a._score;
      if (!!a.noImage !== !!b.noImage) return a.noImage ? 1 : -1;
      if (!dir) return 0;
      var pa = sortPrice(a), pb = sortPrice(b);
      if (pa === pb) return 0;
      return (pa - pb) * dir;
    });
    $('count').textContent = S.filtered.length + ' of ' + S.items.length + ' pieces' +
      (S.built ? '  ·  updated ' + new Date(S.built).toLocaleDateString('en-IN', { day:'numeric', month:'short' }) : '') +
      /* Never drop pieces silently - staff will search for one and wonder where it went. */
      (S.hidden ? '  ·  ' + S.hidden + ' awaiting photography (shown last)' : '');
    renderNav();
    renderBar();
    renderGrid();
  }

  function renderNav() {
    var cats = S.facets.category || [];
    var picked = S.sel.category || [];
    var out = ['<button data-cat="" class="' + (picked.length ? '' : 'on') + '">All</button>'];
    for (var i = 0; i < cats.length; i++) {
      var on = picked.indexOf(cats[i].value) !== -1;
      out.push('<button data-cat="' + esc(cats[i].value) + '" class="' + (on ? 'on' : '') + '">' +
               esc(cats[i].value) + '</button>');
    }
    $('nav').innerHTML = out.join('');
  }

  function renderBar() {
    var out = [];
    for (var i = 0; i < BAR_ORDER.length; i++) {
      var key = BAR_ORDER[i];
      if (!S.facets[key] || !S.facets[key].length) continue;
      var n = (S.sel[key] || []).length;
      out.push('<button class="fb' + (n || S.open === key ? ' on' : '') + '" data-fb="' + key + '">' +
               esc(FACET_LABELS[key]) + (n ? '<span class="n">' + n + '</span>' : '') +
               '<span class="cv">&#9660;</span></button>');
    }
    out.push('<span class="spacer"></span>');
    if (activeCount()) out.push('<button class="clear" id="clearBtn">Clear all</button>');
    out.push('<span class="sortwrap">Sort' +
      '<select id="sortSel">' +
      '<option value="featured"' + (S.sort === 'featured' ? ' selected' : '') + '>Featured</option>' +
      '<option value="asc"' + (S.sort === 'asc' ? ' selected' : '') + '>Price: low to high</option>' +
      '<option value="desc"' + (S.sort === 'desc' ? ' selected' : '') + '>Price: high to low</option>' +
      '</select></span>');
    $('filterbar').innerHTML = out.join('');

    var p = $('panel');
    if (!S.open || !S.facets[S.open]) { p.className = 'panel'; p.innerHTML = ''; return; }
    var list = S.facets[S.open];

    /* Sub-type is only meaningful within a category - 30 values across 6 categories is noise. When
       a category is chosen, show only its own; otherwise merge duplicates across categories. */
    if (S.open === 'subCategory') {
      var cat = (S.sel.category || [])[0];
      if (cat) {
        list = list.filter(function (x) { return x.parent === cat; });
      } else {
        var merged = {};
        for (var m = 0; m < list.length; m++) {
          merged[list[m].value] = (merged[list[m].value] || 0) + list[m].count;
        }
        list = Object.keys(merged).map(function (v) { return { value: v, count: merged[v] }; })
          .sort(function (a, b) { return b.count - a.count || a.value.localeCompare(b.value); });
      }
    }

    var chips = ['<div class="chips">'];
    for (var j = 0; j < list.length; j++) {
      var sel = (S.sel[S.open] || []).indexOf(String(list[j].value)) !== -1;
      chips.push('<button class="chip' + (sel ? ' on' : '') + '" data-f="' + esc(S.open) +
                 '" data-v="' + esc(list[j].value) + '">' + esc(list[j].value) +
                 '<span class="n">' + list[j].count + '</span></button>');
    }
    chips.push('</div>');

    if (S.open === 'priceBand') {
      chips.push('<div class="range">' +
        '<label for="pmin">From</label><input id="pmin" type="number" inputmode="numeric" min="0" step="1000" placeholder="₹ min" value="' +
        (S.pmin === null ? '' : S.pmin) + '">' +
        '<label for="pmax">To</label><input id="pmax" type="number" inputmode="numeric" min="0" step="1000" placeholder="₹ max" value="' +
        (S.pmax === null ? '' : S.pmax) + '">' +
        '<button id="pApply">Apply</button>' +
        (S.pmin !== null || S.pmax !== null ? '<button id="pClear" class="rclear">Clear range</button>' : '') +
        '</div>');
    }

    p.className = 'panel open';
    p.innerHTML = chips.join('');
  }

  function renderGrid() {
    var g = $('grid');
    if (!S.filtered.length) { g.innerHTML = '<div class="empty">Nothing matches those filters.</div>'; return; }
    var html = [];
    for (var i = 0; i < S.filtered.length; i++) html.push(cardHtml(S.filtered[i], i));
    g.innerHTML = html.join('');
    refreshVisiblePrices();
  }

  function cardHtml(it, i) {
    var v = cardVariant(it);
    var img = imgFor(it, v);
    var sel = S.card[it.id] || {};
    var out = [];
    out.push('<div class="card" data-i="' + i + '" role="button" tabindex="0">');
    out.push('<div class="shot">');
    // srcset lets the browser pick by real rendered size and DPR - a phone column is ~165px, so
    // it takes the 320 and skips two thirds of the bytes a fixed 520 would have cost. The first
    // row loads eagerly; everything below the fold stays lazy.
    out.push(img
      ? '<img ' + (i < 5 ? '' : 'loading="lazy" ') + 'decoding="async" ' +
        'sizes="(min-width:1000px) 250px, 45vw" ' +
        'srcset="' + px(img, 320) + ' 320w, ' + px(img, 520) + ' 520w, ' + px(img, 800) + ' 800w" ' +
        'src="' + px(img, 520) + '" alt="' + esc(it.title) + '">'
      : '<div class="noimg">&#9671;</div><div class="nophoto">Photo coming soon</div>');
    if (it.draft) out.push('<span class="flag">Not published</span>');
    out.push('</div><div class="info">');
    /* The design code on every card: the one thing that tells RG00048 from RG00048A. */
    if (codesOf(it).length)
      out.push('<div class="code' + (it._score === 3 ? ' hit' : '') + '">' + esc(codesOf(it).join(' / ')) + '</div>');
    out.push('<div class="name">' + esc(it.title) + '</div>');
    out.push('<div class="cost" data-price="' + it.id + '">' + priceHtml(it, v) + '</div>');
    out.push('<div data-stock="' + it.id + '">' + stockHtml(it) + '</div>');
    out.push('<div class="swatches">');
    for (var t = 0; t < it.tones.length; t++) {
      var tone = it.tones[t];
      out.push('<button class="sw' + (sel.tone === tone ? ' on' : '') + '" data-sw="tone" data-id="' + it.id +
               '" data-val="' + esc(tone) + '" title="' + esc(tone) + '" style="background:' +
               (TONE_HEX[tone] || '#ddd') + '"></button>');
    }
    for (var k = 0; k < it.karats.length; k++) {
      out.push('<button class="kt' + (sel.karat === it.karats[k] ? ' on' : '') + '" data-sw="karat" data-id="' +
               it.id + '" data-val="' + esc(it.karats[k]) + '">' + esc(it.karats[k]) + '</button>');
    }
    out.push('</div></div></div>');
    return out.join('');
  }

  /* Per VARIANT, not per product. A product can hold a mix of priced and unpriced variants, and the
     one on screen is the one being quoted - gating on the product would let a zero-weight variant
     (which the daily pricer skips) display a stale hand-set price as if it were live. */
  function priceHtml(it, v) {
    if (!v || !v.priceManaged) return '<span class="from">Price on request</span>';
    var p = priceOf(v);
    if (!(p > 0)) return '<span class="from">Price on request</span>';
    var multi = S.card[it.id] ? false : it.priceFrom !== it.priceTo;
    return (multi ? '<span class="from">From </span>' : '') + money.format(p);
  }

  /* force: ignore the TTL - used when a pulse says prices just moved. */
  function refreshVisiblePrices(force) {
    var ids = [];
    for (var i = 0; i < S.filtered.length && ids.length < 100; i++) {
      var v = cardVariant(S.filtered[i]);
      if (v && (force || !isFresh(v.id))) ids.push(v.id);
    }
    if (!ids.length) return;
    fetchLive(ids).then(repaintCards);
  }
  function repaintCards() {
    for (var i = 0; i < S.filtered.length; i++) {
      var it = S.filtered[i], v = cardVariant(it);
      var pEl = document.querySelector('[data-price="' + it.id + '"]');
      if (pEl) pEl.innerHTML = priceHtml(it, v);
      var sEl = document.querySelector('[data-stock="' + it.id + '"]');
      if (sEl) sEl.innerHTML = stockHtml(it);
    }
  }

  function signedOut() { $('signedout').className = 'signedout on'; }

  /* full: also the price breakup (the PDP). The server chunks it to stay inside Shopify's budget. */
  function fetchLive(ids, full) {
    if (!ids.length) return Promise.resolve();
    var at = Date.now();
    return fetch('/lookbook/live?ids=' + encodeURIComponent(ids.slice(0, 100).join(',')) + (full ? '&full=1' : ''),
                 { cache: 'no-store' })
      .then(function (r) {
        /* Before this, a session that lapsed while the page sat open made every live read fail
           silently, and the page went on showing snapshot prices - the "only a re-login fixes it"
           symptom. Now it says so. */
        if (r.status === 401) { signedOut(); return null; }
        return r.ok ? r.json() : null;
      })
      .then(function (j) {
        if (!j || !j.variants) return;
        for (var k in j.variants) {
          var row = j.variants[k];
          /* A lean read must not throw away a breakup a full read already holds for this epoch. */
          var prev = S.live[k];
          if (!row.full && prev && prev.full && prev.price === row.price) { row.full = true; row.breakup = prev.breakup;
            row.pricedAt = prev.pricedAt; row.goldRate = prev.goldRate; }
          row.at = at;
          S.live[k] = row;
        }
      })
      .catch(function () { /* keep the snapshot price rather than blanking the card */ });
  }

  /* -- PDP ----------------------------------------------------------------- */
  function imagesFor(it, v) {
    /* Selecting Rose Gold should show the rose gold photographs, not every colour the piece comes
       in. Falls back to the full set when a tone has no dedicated shots, so a piece never goes
       imageless just because its photography is incomplete. */
    var toned = mediaForTone(it, v && v.toneLabel);
    if (toned.length) {
      if (v && v.image && toned.indexOf(v.image) === -1) toned.unshift(v.image);
      return toned;
    }
    var urls = [];
    if (v && v.image) urls.push(v.image);
    for (var i = 0; i < it.media.length; i++) if (urls.indexOf(it.media[i].url) === -1) urls.push(it.media[i].url);
    return urls;
  }
  function pickVariant(it) {
    /* A variant chosen by "Show available variant" is exact - karat/tone/size alone can leave two
       variants tied (they can differ by diamond grade), and the draft must carry the in-stock one. */
    if (S.vid) for (var j = 0; j < it.variants.length; j++) if (it.variants[j].id === S.vid) return it.variants[j];
    var best = null, bestScore = -1;
    for (var i = 0; i < it.variants.length; i++) {
      var v = it.variants[i], score = 0;
      if (S.axis.karat && v.karat === S.axis.karat) score++;
      if (S.axis.tone && v.toneLabel === S.axis.tone) score++;
      if (S.axis.size && v.size === S.axis.size) score++;
      if (score > bestScore) { bestScore = score; best = v; }
    }
    return best;
  }

  function openAt(i) {
    if (i < 0 || i >= S.filtered.length) return;
    S.idx = i; S.img = 0;
    S.staff = false;   /* reset on EVERY open: this panel gets turned around to face a customer */
    var it = S.filtered[i];
    var v = cardVariant(it) || it.variants[0] || {};
    S.axis = { karat: v.karat, tone: v.toneLabel, size: v.size };
    S.vid = null; S.avail = null; S.draft = null;
    $('pdp').classList.add('open');
    document.body.style.overflow = 'hidden';
    refreshPdpLive();
  }

  /* The PDP ALWAYS re-reads price, stock and breakup from Shopify when it opens - never a cached
     number - so a piece opened minutes after a gold-rate run shows the new price with no reload. */
  function refreshPdpLive() {
    if (S.idx < 0) return Promise.resolve();
    var it = S.filtered[S.idx];
    var ids = it.variants.map(function (v2) { return v2.id; });
    S.pdpLive = 'wait';
    renderPdp();
    return fetchLive(ids, true).then(function () {
      if (S.filtered[S.idx] !== it) return;   // the staff member moved on meanwhile
      S.pdpLive = 'done';
      renderPdp();
    });
  }
  function closePdp() {
    $('pdp').classList.remove('open');
    document.body.style.overflow = '';
    S.idx = -1;
  }

  function renderPdp() {
    if (S.idx < 0) return;
    var it = S.filtered[S.idx];
    var v = pickVariant(it);
    var imgs = imagesFor(it, v);
    if (S.img >= imgs.length) S.img = 0;

    $('heroImg').src = imgs.length ? px(imgs[S.img], 1400) : '';
    $('heroImg').alt = it.title;
    $('pos').textContent = (S.idx + 1) + ' of ' + S.filtered.length;

    var th = [];
    for (var d = 0; d < imgs.length; d++)
      th.push('<img class="' + (d === S.img ? 'on' : '') + '" data-img="' + d + '" src="' + px(imgs[d], 160) + '" alt="">');
    $('thumbs').innerHTML = imgs.length > 1 ? th.join('') : '';
    [imgs[S.img + 1], imgs[S.img - 1]].forEach(function (u) { if (u) { var im = new Image(); im.src = px(u, 1400); } });

    var p = (v && v.priceManaged) ? priceOf(v) : null;
    var lv = v ? S.live[v.id] : null;
    var out = [];
    var eyebrow = [it.category].concat(codesOf(it)).filter(Boolean).join('  ·  ');
    if (eyebrow) out.push('<div class="eyebrow">' + esc(eyebrow) + '</div>');
    out.push('<h1>' + esc(it.title) + '</h1>');
    out.push('<div class="price">' + (p > 0 ? money.format(p) : 'Price on request') + '</div>');
    if (S.pdpLive === 'wait' && !(lv && lv.full && Date.now() - lv.at < 15000)) {
      out.push('<div class="livenote wait">Checking today’s price…</div>');
    } else if (lv && lv.full) {
      out.push('<div class="livenote">Live price · checked ' +
        esc(new Date(lv.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })) + '</div>');
    }
    /* Availability is deliberately not shown. Nearly everything here is made to order, so the
       label carried no information and read as a caveat next to the price in front of a customer. */
    if (it.draft) out.push('<div class="stock"><span class="flag">Not published</span></div>');

    out.push(optHtml('karat', 'Karat', it.karats));
    out.push(optHtml('tone', 'Metal', it.tones));
    out.push(optHtml('size', 'Size', it.sizes));
    out.push(actionsHtml(it, v));

    var rows = [];
    if (it.carats > 0) rows.push(['Diamonds', it.carats + ' ct' + (it.stones > 0 ? '  ·  ' + it.stones + ' stones' : '')]);
    if (it.hasColouredStones) rows.push(['Coloured stones', (it.gemPcs > 0 ? it.gemPcs + ' pcs' : 'Yes')]);
    if (v && v.grossWt > 0) rows.push(['Gold weight', v.grossWt + ' g']);
    if (v && v.grade) rows.push(['Clarity / colour', v.grade]);
    if (rows.length) {
      out.push('<div class="specs">');
      for (var r = 0; r < rows.length; r++)
        out.push('<div class="r"><span>' + esc(rows[r][0]) + '</span><span>' + esc(rows[r][1]) + '</span></div>');
      out.push('</div>');
    }

    /* Price breakup. In Indian jewellery retail the component split is a standard CUSTOMER-facing
       disclosure - it is already on the estimate and the tax invoice - so it belongs in the open
       panel, not behind the staff toggle. Only rows the pricer actually wrote are rendered: a
       missing metafield must not become a zero row, which reads as "no making charge". */
    /* The breakup comes from the same live read as the price above it. The snapshot's copy is a
       fallback only: between a reprice and the next rebuild it is the PREVIOUS day's split. */
    var b = (lv && lv.full && lv.breakup) || (v && v.breakup) || {};
    var goldRate = (lv && lv.full && lv.goldRate > 0) ? lv.goldRate : (v && v.goldRate);
    var pricedAt = (lv && lv.full && lv.pricedAt) || (v && v.pricedAt);
    if (v && v.priceManaged) {
      var br = [];
      if (b.gold > 0)     br.push(['Gold' + (goldRate > 0 ? ' @ ' + money.format(goldRate) + '/g' : ''), b.gold]);
      if (b.diamond > 0)  br.push(['Diamonds', b.diamond]);
      if (b.gemstone > 0) br.push(['Coloured stones', b.gemstone]);
      if (b.making > 0)   br.push(['Making', b.making]);
      if (br.length) {
        out.push('<div class="breakup"><div class="bt">Price breakup</div>');
        for (var q = 0; q < br.length; q++)
          out.push('<div class="r"><span>' + esc(br[q][0]) + '</span><span>' + money.format(br[q][1]) + '</span></div>');
        if (b.subtotal > 0) out.push('<div class="r sub"><span>Subtotal</span><span>' + money.format(b.subtotal) + '</span></div>');
        if (b.gst > 0)      out.push('<div class="r"><span>GST 3%</span><span>' + money.format(b.gst) + '</span></div>');
        var grand = b.total > 0 ? b.total : priceOf(v);
        if (grand > 0) out.push('<div class="r tot"><span>Total</span><span>' + money.format(grand) + '</span></div>');
        if (pricedAt) out.push('<div class="note">Gold rate as of ' + esc(new Date(pricedAt).toLocaleString('en-IN',
          { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) + '</div>');
        out.push('</div>');
      }
    }

    var sb = [];
    if (v && v.sku) sb.push('SKU <code>' + esc(v.sku) + '</code>');
    if (v && v.netWt > 0) sb.push('net ' + v.netWt + ' g');
    if (it.makingRate > 0) sb.push('making ' + money.format(it.makingRate) + '/g');
    if (!v || !v.priceManaged) sb.push('<b>price NOT maintained by the daily job</b>');
    sb.push('<a href="https://admin.shopify.com/store/auracarat/products/' + esc(it.id) + '" target="_blank" rel="noopener">open in Shopify</a>');
    out.push('<div class="staff' + (S.staff ? ' on' : '') + '">' + sb.join(' &nbsp;·&nbsp; ') + '</div>');

    $('buybox').innerHTML = out.join('');
    $('staffBtn').className = 'iconbtn' + (S.staff ? ' on' : '');
  }

  /* "Show available variant" and "Create draft order". */
  function actionsHtml(it, v) {
    var out = ['<div class="actions">'];

    out.push('<button class="act" data-act="avail"' + (S.avail && S.avail.busy ? ' disabled' : '') + '>' +
             (S.avail && S.avail.busy ? 'Checking stock…' : 'Show available variant') + '</button>');
    if (S.avail && !S.avail.busy) {
      if (S.avail.error) {
        out.push('<div class="res err">' + esc(S.avail.error) + '</div>');
      } else if (!S.avail.ids.length) {
        out.push('<div class="res">No variant of this design is in stock right now - it is made to order.</div>');
      } else {
        var list = it.variants.filter(function (x) { return S.avail.ids.indexOf(x.id) !== -1; });
        out.push('<div class="res">' + (list.length === 1
          ? 'In stock: <b>' + esc(variantLabel(list[0])) + '</b> - selected below.'
          : list.length + ' variants are in stock. Tap one to select it:') + '</div>');
        if (list.length > 1) {
          out.push('<div class="row">');
          for (var i = 0; i < list.length; i++) {
            out.push('<button class="chip' + (v && v.id === list[i].id ? ' on' : '') + '" data-vid="' + esc(list[i].id) + '">' +
                     esc(variantLabel(list[i])) + ' <span class="n">' + stockOf(list[i]) + '</span></button>');
          }
          out.push('</div>');
        }
      }
    }

    /* The draft box always says exactly which variant it will push. */
    var d = S.draft && v && S.draft.vid === v.id ? S.draft : null;
    if (v && v.id) {
      var st = stockOf(v);
      out.push('<div class="vline">Variant: ' + esc(variantLabel(v)) +
               (v.sku ? '<br>SKU <code>' + esc(v.sku) + '</code>' : '') +
               (st !== null ? '<br>' + (st >= 1 ? st + ' in stock' : 'Not in stock') : '') + '</div>');
      if (!d) {
        out.push('<button class="act primary" data-act="draft">Create draft order</button>');
      } else if (d.state === 'confirm') {
        out.push('<div class="res">Create a draft in Shopify for <b>' + esc(variantLabel(v)) +
                 '</b>, against the “Lookbook Walk-in” customer?</div>');
        out.push('<div class="actrow"><button class="act primary" data-act="draft-yes">Yes, create</button>' +
                 '<button class="act" data-act="draft-no">Cancel</button></div>');
      } else if (d.state === 'busy') {
        out.push('<button class="act primary" disabled>Creating draft…</button>');
      } else if (d.state === 'done') {
        out.push('<div class="res">Draft <b>' + esc(d.name) + '</b> ' + (d.duplicate ? 'was already created a moment ago' : 'created') +
                 '. <a href="' + esc(d.url) + '" target="_blank" rel="noopener">Open it in Shopify</a> and replace the ' +
                 'Lookbook Walk-in customer before billing.</div>');
      } else if (d.state === 'error') {
        out.push('<div class="res err">' + esc(d.msg) + '</div>');
        out.push('<button class="act primary" data-act="draft">Try again</button>');
      }
    }
    out.push('</div>');
    return out.join('');
  }

  function showAvailable() {
    var it = S.filtered[S.idx];
    if (!it) return;
    S.avail = { busy: true };
    renderPdp();
    /* Stock must be live here: the snapshot's figure is up to a day old and a piece may have sold. */
    fetchLive(it.variants.map(function (x) { return x.id; }), true).then(function () {
      if (S.filtered[S.idx] !== it) return;
      var fresh = it.variants.filter(function (x) { return isFresh(x.id); });
      if (fresh.length < it.variants.length) {
        S.avail = { error: 'Could not read live stock from Shopify. Check the connection and try again.' };
        renderPdp();
        return;
      }
      var ins = inStockVariants(it);
      S.avail = { ids: ins.map(function (x) { return x.id; }) };
      if (ins.length) selectVariant(ins[0]);
      S.img = 0;
      renderPdp();
    });
  }
  function selectVariant(v) {
    S.vid = v.id;
    S.axis = { karat: v.karat, tone: v.toneLabel, size: v.size };
  }

  function createDraft(v) {
    S.draft = { vid: v.id, state: 'busy' };
    renderPdp();
    fetch('/lookbook/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                               body: JSON.stringify({ variantId: v.id }) })
      .then(function (r) {
        if (r.status === 401) signedOut();
        return r.json().catch(function () { return { success: false, error: 'HTTP ' + r.status }; });
      })
      .then(function (j) {
        if (!S.draft || S.draft.vid !== v.id) return;
        S.draft = j && j.success
          ? { vid: v.id, state: 'done', name: j.name, url: j.adminUrl, duplicate: j.duplicate }
          : { vid: v.id, state: 'error', msg: (j && j.error) || 'The draft was not created.' };
        renderPdp();
      })
      .catch(function () {
        S.draft = { vid: v.id, state: 'error', msg: 'No connection - the draft was not created.' };
        renderPdp();
      });
  }

  function optHtml(key, label, values) {
    if (!values || values.length < 2) return '';
    var out = ['<div class="opt"><div class="lbl">' + label + '</div><div class="row">'];
    for (var i = 0; i < values.length; i++) {
      var on = S.axis[key] === values[i];
      out.push('<button class="chip' + (on ? ' on' : '') + '" data-axis="' + key + '" data-val="' + esc(values[i]) + '">' +
               esc(values[i]) + '</button>');
    }
    out.push('</div></div>');
    return out.join('');
  }

  function step(d) { if (S.idx + d >= 0 && S.idx + d < S.filtered.length) openAt(S.idx + d); }
  function stepImg(d) {
    var it = S.filtered[S.idx];
    if (!it) return;
    var imgs = imagesFor(it, pickVariant(it));
    if (imgs.length < 2) return;
    S.img = (S.img + d + imgs.length) % imgs.length;
    renderPdp();
  }

  /* -- events -------------------------------------------------------------- */
  $('nav').addEventListener('click', function (e) {
    var b = e.target.closest('[data-cat]');
    if (!b) return;
    var c = b.dataset.cat;
    S.sel.category = c ? [c] : [];
    apply();
  });

  $('filterbar').addEventListener('change', function (e) {
    if (e.target.id !== 'sortSel') return;
    S.sort = e.target.value;
    apply();
  });

  $('filterbar').addEventListener('click', function (e) {
    if (e.target.closest('#clearBtn')) {
      S.sel = {}; S.pmin = null; S.pmax = null; S.open = null;
      apply();
      return;
    }
    var b = e.target.closest('[data-fb]');
    if (!b) return;
    S.open = (S.open === b.dataset.fb) ? null : b.dataset.fb;
    renderBar();
  });

  $('panel').addEventListener('click', function (e) {
    if (e.target.id === 'pApply' || e.target.id === 'pClear') {
      if (e.target.id === 'pClear') {
        S.pmin = null; S.pmax = null;
      } else {
        var lo = parseFloat(($('pmin') || {}).value);
        var hi = parseFloat(($('pmax') || {}).value);
        S.pmin = isFinite(lo) ? lo : null;
        S.pmax = isFinite(hi) ? hi : null;
        /* Entered the wrong way round is a slip, not an error - swap rather than return nothing. */
        if (S.pmin !== null && S.pmax !== null && S.pmin > S.pmax) {
          var t = S.pmin; S.pmin = S.pmax; S.pmax = t;
        }
      }
      apply();
      return;
    }
    var chip = e.target.closest('.chip');
    if (!chip) return;
    var f = chip.dataset.f, v = chip.dataset.v;
    S.sel[f] = S.sel[f] || [];
    var at = S.sel[f].indexOf(v);
    if (at === -1) S.sel[f].push(v); else S.sel[f].splice(at, 1);
    apply();
  });

  $('grid').addEventListener('click', function (e) {
    var sw = e.target.closest('[data-sw]');
    if (sw) {
      e.stopPropagation();
      var id = sw.dataset.id;
      S.card[id] = S.card[id] || {};
      S.card[id][sw.dataset.sw] = S.card[id][sw.dataset.sw] === sw.dataset.val ? null : sw.dataset.val;
      renderGrid();
      return;
    }
    var card = e.target.closest('.card');
    if (card) openAt(Number(card.dataset.i));
  });

  $('panel').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    if (e.target.id !== 'pmin' && e.target.id !== 'pmax') return;
    e.preventDefault();
    var btn = $('pApply');
    if (btn) btn.click();
  });

  /* -- predictive design-code search ---------------------------------------
     As soon as the box holds letters + a digit, a list drops down of every design code that fits,
     each with its title, price and what is in stock, so RG00048 and RG00048A are told apart before
     anything is opened. Picking one opens that exact piece. */
  var SUGGEST_MAX = 12;

  function buildSuggestions(q) {
    if (!looksLikeCode(q)) return [];
    var rows = [];
    for (var i = 0; i < S.items.length; i++) {
      var it = S.items[i], codes = codesOf(it);
      for (var c = 0; c < codes.length; c++) {
        var sc = codeScore(q, codes[c]);
        if (sc) rows.push({ item: it, code: codes[c], score: sc });
      }
    }
    return rows.sort(compareSuggestions);
  }

  function renderSuggest() {
    var box = $('suggest'), all = S.sugg.all || [];
    if (!all.length) {
      box.className = 'suggest' + (looksLikeCode($('q').value) ? ' open' : '');
      box.innerHTML = looksLikeCode($('q').value) ? '<div class="sghint">No design code starts like that.</div>' : '';
      return;
    }
    var out = [];
    for (var i = 0; i < S.sugg.list.length; i++) {
      var r = S.sugg.list[i], it = r.item, ins = inStockVariants(it);
      var cv = cheapest(it), cp = cv && cv.priceManaged ? priceOf(cv) : null;
      var price = cp > 0 ? (it.priceFrom !== it.priceTo ? 'from ' : '') + money.format(cp) : '';
      out.push('<div class="sg' + (i === S.sugg.idx ? ' on' : '') + '" data-sg="' + i + '" role="option">' +
        '<span class="c' + (r.score === 3 ? ' exact' : '') + '">' + esc(r.code) + '</span>' +
        '<span class="t">' + esc(it.title) + '</span>' +
        '<span class="p">' + esc(price) + '</span>' +
        '<span class="s' + (ins.length ? ' in' : '') + '">' +
          (ins.length ? 'In stock: ' + esc(ins.map(variantLabel).join('  |  ')) : 'Made to order') +
          (it.draft ? '  ·  not published' : '') + '</span>' +
        '</div>');
    }
    if (all.length > S.sugg.list.length)
      out.push('<div class="sghint">' + (all.length - S.sugg.list.length) + ' more - keep typing to narrow it down</div>');
    box.innerHTML = out.join('');
    box.className = 'suggest open';
  }

  var sgLive;
  function updateSuggest(val) {
    var all = buildSuggestions(val);
    S.sugg = { all: all, list: all.slice(0, SUGGEST_MAX), idx: -1 };
    renderSuggest();
    /* The in-stock line is what staff choose on, so read it live, a beat after typing settles. */
    clearTimeout(sgLive);
    sgLive = setTimeout(function () {
      var ids = [];
      S.sugg.list.forEach(function (r) { r.item.variants.forEach(function (v) { if (!isFresh(v.id) && ids.length < 100) ids.push(v.id); }); });
      if (ids.length) fetchLive(ids).then(renderSuggest);
    }, 250);
  }
  function closeSuggest() { $('suggest').className = 'suggest'; S.sugg.idx = -1; }

  function chooseSuggestion(r) {
    closeSuggest();
    $('q').value = r.code;
    clearTimeout(qt);
    S.q = r.code.toLowerCase();
    apply();
    var at = S.filtered.indexOf(r.item);
    if (at !== -1) openAt(at);
  }

  var qt;
  $('q').addEventListener('input', function (e) {
    clearTimeout(qt);
    var raw = e.target.value.trim();
    var val = raw.toLowerCase();
    updateSuggest(raw);
    qt = setTimeout(function () { S.q = val; apply(); }, 140);
  });
  $('q').addEventListener('keydown', function (e) {
    var list = S.sugg.list || [];
    if (e.key === 'ArrowDown' && list.length) { e.preventDefault(); S.sugg.idx = Math.min(S.sugg.idx + 1, list.length - 1); renderSuggest(); }
    else if (e.key === 'ArrowUp' && list.length) { e.preventDefault(); S.sugg.idx = Math.max(S.sugg.idx - 1, 0); renderSuggest(); }
    else if (e.key === 'Escape') closeSuggest();
    else if (e.key === 'Enter') {
      /* Enter opens a highlighted row, or the code typed in full when exactly one piece has it. */
      var exact = list.filter(function (r) { return r.score === 3; });
      if (S.sugg.idx >= 0 && list[S.sugg.idx]) { e.preventDefault(); chooseSuggestion(list[S.sugg.idx]); }
      else if (exact.length === 1) { e.preventDefault(); chooseSuggestion(exact[0]); }
    }
  });
  $('q').addEventListener('focus', function (e) { if (e.target.value.trim()) updateSuggest(e.target.value.trim()); });
  /* mousedown, not click: click fires after the input's blur has already closed the list. */
  $('suggest').addEventListener('mousedown', function (e) {
    var row = e.target.closest('[data-sg]');
    if (!row) return;
    e.preventDefault();
    chooseSuggestion(S.sugg.list[Number(row.dataset.sg)]);
  });
  $('q').addEventListener('blur', function () { setTimeout(closeSuggest, 120); });

  $('closeBtn').addEventListener('click', closePdp);
  $('navPrev').addEventListener('click', function () { step(-1); });
  $('navNext').addEventListener('click', function () { step(1); });
  $('staffBtn').addEventListener('click', function () { S.staff = !S.staff; renderPdp(); });
  $('thumbs').addEventListener('click', function (e) {
    if (e.target.dataset.img === undefined) return;
    S.img = Number(e.target.dataset.img);
    renderPdp();
  });
  $('buybox').addEventListener('click', function (e) {
    var it = S.filtered[S.idx];
    var act = e.target.closest('[data-act]');
    if (act && it && !act.disabled) {
      var a = act.dataset.act, v = pickVariant(it);
      if (a === 'avail') showAvailable();
      else if (a === 'draft' && v) { S.draft = { vid: v.id, state: 'confirm' }; renderPdp(); }
      else if (a === 'draft-no') { S.draft = null; renderPdp(); }
      else if (a === 'draft-yes' && v) createDraft(v);
      return;
    }
    var pick = e.target.closest('[data-vid]');
    if (pick && it) {
      for (var i = 0; i < it.variants.length; i++) if (it.variants[i].id === pick.dataset.vid) selectVariant(it.variants[i]);
      S.img = 0;
      renderPdp();
      return;
    }
    var chip = e.target.closest('[data-axis]');
    if (!chip) return;
    S.axis[chip.dataset.axis] = chip.dataset.val;
    S.vid = null;   /* a hand-picked option overrides the in-stock pick */
    S.img = 0;
    renderPdp();
  });

  document.addEventListener('keydown', function (e) {
    if (!$('pdp').classList.contains('open')) return;
    if (e.key === 'Escape') closePdp();
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowDown') stepImg(1);
    else if (e.key === 'ArrowUp') stepImg(-1);
  });

  var t0 = null;
  var hero = $('hero');
  hero.addEventListener('touchstart', function (e) {
    var t = e.changedTouches[0];
    t0 = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  hero.addEventListener('touchend', function (e) {
    if (!t0) return;
    var t = e.changedTouches[0], dx = t.clientX - t0.x, dy = t.clientY - t0.y;
    t0 = null;
    if (Math.abs(dx) < 40 && Math.abs(dy) < 40) return;
    if (Math.abs(dx) >= Math.abs(dy)) step(dx < 0 ? 1 : -1);
    else stepImg(dy < 0 ? 1 : -1);
  }, { passive: true });

  /* -- staying fresh --------------------------------------------------------
     This page gets left open on a counter all day, across a gold-rate reprice and a snapshot
     rebuild. Without this it would keep showing the prices it happened to fetch at open time.
     Cheap by design: the conditional request is a 304 unless the snapshot actually changed, and
     clearing S.live simply lets the normal batched live lookup run again. */
  var CHECK_MS = 10 * 60 * 1000;
  var lastCheck = Date.now();

  function revalidate() {
    lastCheck = Date.now();
    S.live = {};                       // force live price + stock to be re-read
    fetch('/lookbook/catalog.json', { headers: S.etag ? { 'If-None-Match': S.etag } : {} })
      .then(function (r) {
        if (r.status === 401) { signedOut(); return null; }
        if (r.status === 304) {                                  // catalog unchanged; prices refresh
          renderGrid();
          if (S.idx >= 0) refreshPdpLive();
          return null;
        }
        var t = r.headers.get('ETag');
        if (t) S.etag = t;
        return r.json();
      })
      .then(function (snap) {
        if (!snap) return;
        /* Keep the SAME piece open across a rebuild. The old code re-rendered by index, and the
           index can point at a different product once the new catalog is filtered and sorted. */
        var openId = S.idx >= 0 && S.filtered[S.idx] ? S.filtered[S.idx].id : null;
        S.items = snap.items || [];
        S.facets = snap.facets || {};
        S.built = snap.builtAt;
        S.hidden = snap.droppedNoImage || 0;
        apply();
        if (openId !== null) {
          var at = -1;
          for (var i = 0; i < S.filtered.length; i++) if (S.filtered[i].id === openId) at = i;
          if (at === -1) closePdp();
          else { S.idx = at; refreshPdpLive(); }
        }
      })
      .catch(function () { /* stay on what is already rendered */ });
  }

  /* The pulse. Every ~45s (and the moment the tab comes back) the page asks the server one cheap
     question: has a reprice moved prices, or has the catalog been rebuilt? The server answers from
     memory. When prices moved, every cached live price is dropped and what is on screen - the
     cards and the open PDP - is re-read straight away. While a reprice is still RUNNING, prices
     change piece by piece, so the open PDP and visible cards are re-read on every pulse until it
     ends. Net effect: after a gold-rate run the screen corrects itself within a minute, with no
     reload, re-login or new tab. */
  function pulse() {
    fetch('/lookbook/pulse', { cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401) { signedOut(); return null; }
        return r.ok ? r.json() : null;
      })
      .then(function (p) {
        if (!p) return;
        var moved = S.epoch !== null && p.priceEpoch !== S.epoch;
        S.epoch = p.priceEpoch;
        S.repricing = !!p.repricing;
        if (p.etag && S.etag && p.etag !== S.etag) { revalidate(); return; }   // revalidate re-reads everything
        if (moved) S.live = {};
        if (moved || S.repricing) {
          refreshVisiblePrices(true);
          if (S.idx >= 0) refreshPdpLive();
        }
      })
      .catch(function () { /* offline for a moment; the next pulse tries again */ });
  }

  setInterval(pulse, PULSE_MS);
  setInterval(revalidate, CHECK_MS);   // belt and braces, should the pulse ever be unreachable
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    pulse();
    if (Date.now() - lastCheck > CHECK_MS) revalidate();
    /* A tablet woken from sleep: whatever the PDP shows is from before it slept. */
    else if (S.idx >= 0) refreshPdpLive();
  });

  /* -- boot ---------------------------------------------------------------- */
  fetch('/lookbook/catalog.json')
    .then(function (r) {
      if (r.status === 401) { location.href = '/lookbook'; throw new Error('signed out'); }
      S.etag = r.headers.get('ETag');
      return r.json();
    })
    .then(function (snap) {
      $('loading').style.display = 'none';
      S.items = snap.items || [];
      S.facets = snap.facets || {};
      S.built = snap.builtAt;
      S.hidden = snap.droppedNoImage || 0;
      if (!S.items.length) {
        $('grid').innerHTML = '<div class="empty">The catalog snapshot is still building.<br>Try again in a minute.</div>';
        return;
      }
      apply();
      pulse();   // learn the current price epoch now, so the first change is noticed
    })
    .catch(function (err) {
      $('loading').textContent = 'Could not load the catalog. ' + (err && err.message ? err.message : '');
    });
})();
</script>
</body></html>`;
}

module.exports = { loginPage, appPage, esc };
