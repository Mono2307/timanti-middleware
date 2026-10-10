#!/usr/bin/env node
// One-off backfill of the order-confirmation routing tags (ch:/ot:/ship:) from each document's
// custom.channel / custom.order_type / custom.shipment metafields. Going forward the admin panel and
// the draft webhook pass keep these in step (see src/core/comms_tags.js); this brings documents
// created before that up to date so converting one sends the right email.
//
//   SHOPIFY_TOKEN=shpat_... node tools/backfill-routing-tags.js            # dry run, open drafts
//   SHOPIFY_TOKEN=shpat_... node tools/backfill-routing-tags.js --apply
//   ... --orders 30        also the 30 most recent orders (only matters for re-sent emails)
//   ... --draft D243       one draft by name (repeatable), instead of every open draft
//
// Writes with tagsAdd / tagsRemove, so it never rewrites or races any other tag on the document.
// Each write fires a draft/order update webhook, so writes are spaced out.

const { isCommsTag, commsTagsFromMetafields } = require('../src/core/comms_tags');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ordersIdx = args.indexOf('--orders');
const ORDER_COUNT = ordersIdx >= 0 ? parseInt(args[ordersIdx + 1], 10) || 0 : 0;
const ONLY = args.flatMap((a, i) => (a === '--draft' ? [String(args[i + 1] || '').replace(/^#?/, '#')] : []));
const STORE = process.env.SHOPIFY_STORE_URL || 'https://auracarat.myshopify.com';
const TOKEN = process.env.SHOPIFY_TOKEN;
const API = `${STORE}/admin/api/2025-01`;
const GAP_MS = 1500;

if (!TOKEN) { console.error('Set SHOPIFY_TOKEN.'); process.exit(1); }
const H = { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rest(path) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, { headers: H });
    if (res.status === 429 && attempt < 10) { await sleep(1000 * (Number(res.headers.get("retry-after")) || 2) + 500 * attempt); continue; }
    if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
    return res.json();
  }
}

async function gql(query, variables) {
  const res = await fetch(`${API}/graphql.json`, { method: 'POST', headers: H, body: JSON.stringify({ query, variables }) });
  const j = await res.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

async function openDrafts() {
  const out = [];
  for (const status of ['open', 'invoice_sent']) {
    let since = 0;
    for (;;) {
      const { draft_orders } = await rest(`/draft_orders.json?status=${status}&limit=250&since_id=${since}&fields=id,name,tags`);
      out.push(...draft_orders);
      if (draft_orders.length < 250) break;
      since = draft_orders[draft_orders.length - 1].id;
    }
  }
  return out;
}

async function plan(kind, doc) {
  const { metafields } = await rest(`/${kind}/${doc.id}/metafields.json?namespace=custom`);
  const mfMap = Object.fromEntries((metafields || []).map((m) => [m.key, m.value]));
  const want = commsTagsFromMetafields(mfMap);
  const have = String(doc.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  const haveLc = new Set(have.map((t) => t.toLowerCase()));
  const add = want.filter((t) => !haveLc.has(t));
  const remove = have.filter((t) => isCommsTag(t) && !want.includes(t.toLowerCase()));
  return { want, add, remove, missing: ['channel', 'order_type', 'shipment'].filter((k) => !String(mfMap[k] || '').trim()) };
}

(async () => {
  let docs = (await openDrafts()).map((d) => ({ kind: 'draft_orders', gid: `gid://shopify/DraftOrder/${d.id}`, ...d }));
  if (ONLY.length) docs = docs.filter((d) => ONLY.includes(d.name));
  if (ORDER_COUNT) {
    const { orders } = await rest(`/orders.json?status=any&limit=${Math.min(ORDER_COUNT, 250)}&fields=id,name,tags`);
    docs.push(...orders.map((o) => ({ kind: 'orders', gid: `gid://shopify/Order/${o.id}`, ...o })));
  }
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${docs.length} document(s)\n`);

  let changed = 0;
  for (const d of docs) {
    const p = await plan(d.kind, d);
    const note = p.missing.length ? `  (blank: ${p.missing.join(', ')})` : '';
    if (!p.add.length && !p.remove.length) { console.log(`  ok    ${d.name}  [${p.want.join(' ')}]${note}`); continue; }
    console.log(`  ${APPLY ? 'write' : 'would'} ${d.name}  +[${p.add.join(' ')}] -[${p.remove.join(' ')}]${note}`);
    changed++;
    if (!APPLY) continue;
    if (p.remove.length) await gql('mutation($id:ID!,$t:[String!]!){tagsRemove(id:$id,tags:$t){userErrors{message}}}', { id: d.gid, t: p.remove });
    if (p.add.length) {
      const r = await gql('mutation($id:ID!,$t:[String!]!){tagsAdd(id:$id,tags:$t){userErrors{message}}}', { id: d.gid, t: p.add });
      if (r.tagsAdd.userErrors.length) console.log(`        ! ${JSON.stringify(r.tagsAdd.userErrors)}`);
    }
    await sleep(GAP_MS);
  }
  console.log(`\n${changed} document(s) ${APPLY ? 'updated' : 'need tags'}.${APPLY ? '' : ' Re-run with --apply to write.'}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
