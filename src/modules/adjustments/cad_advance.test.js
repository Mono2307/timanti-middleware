const assert = require('assert');
const {
  isCadAdvanceLine, hasCadAdvanceLine, hasProductLineBesidesCad, isCadAdvanceOnly,
  cadAdvanceLineTotal, cadLedgerKey, CAD_ADVANCE_MODE,
} = require('./cad_advance');
const { convertStaleDrafts, expireOverdueAdvances, sendMonthlyDigest } = require('./cad_advance_sweep');
const { createCadAdvanceHandlers } = require('./cad_advance_handlers');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// Async cases are QUEUED and run in order at the end. Firing them off unawaited passed by accident:
// the tally printed before any of them finished, their logs interleaved, and a rejection surfaced as
// a bare unhandled promise rather than as the named case that failed.
const queue = [];
const at      = (name, fn) => queue.push(['test', name, fn]);
const heading = (label)    => queue.push(['heading', label]);

const cad     = { title: 'CAD Advance', price: '5000', quantity: 1 };
const cadSku  = { title: 'Design fee', sku: 'CAD-ADV-2000', price: '2000', quantity: 1 };
const ring    = { title: 'Solitaire Ring', price: '50000', quantity: 1 };
const discount = { title: 'Manual discount', price: '-1000', quantity: 1 };

console.log('CAD line predicates');
t('matches on title and on SKU', () => {
  assert.ok(isCadAdvanceLine(cad));
  assert.ok(isCadAdvanceLine(cadSku));
  assert.ok(!isCadAdvanceLine(ring));
});
t('hasProductLineBesidesCad ignores negative discount lines', () => {
  assert.ok(!hasProductLineBesidesCad({ line_items: [cad, discount] }));
  assert.ok(hasProductLineBesidesCad({ line_items: [cad, ring] }));
});
t('isCadAdvanceOnly: advance alone, even beside a discount', () => {
  assert.ok(isCadAdvanceOnly({ line_items: [cad] }));
  assert.ok(isCadAdvanceOnly({ line_items: [cad, discount] }));
  assert.ok(!isCadAdvanceOnly({ line_items: [cad, ring] }));
});
t('isCadAdvanceOnly is FALSE with no line items — a truncated payload must never suppress a serial', () => {
  assert.ok(!isCadAdvanceOnly({}));
  assert.ok(!isCadAdvanceOnly({ line_items: [] }));
});
t('cadAdvanceLineTotal sums quantity, and only CAD lines', () => {
  assert.strictEqual(cadAdvanceLineTotal({ line_items: [cad, ring] }), 5000);
  assert.strictEqual(cadAdvanceLineTotal({ line_items: [{ ...cad, quantity: 2 }] }), 10000);
  assert.strictEqual(cadAdvanceLineTotal({ line_items: [ring] }), 0);
});
t('ledger key trims, and the absorbed-leg mode is a fixed string', () => {
  assert.strictEqual(cadLedgerKey('  #1042 '), '#1042');
  assert.strictEqual(CAD_ADVANCE_MODE, 'CAD Advance');
});

// ── Sweep decision logic, with stubbed I/O ──────────────────────────────────────────────────────
// The point of these is the DECISIONS, not the transport: which drafts get converted, which
// advances get expired, and whether the digest fires. Every dep is a fake.

function fakeSupabase(rowsByCall) {
  const calls = [];
  const q = (table) => {
    const state = { table, filters: {} };
    const chain = {
      select() { return chain; },
      eq(k, v) { state.filters[k] = v; return chain; },
      lte(k, v) { state.filters[`${k}<=`] = v; return chain; },
      gte(k, v) { state.filters[`${k}>=`] = v; return chain; },
      lt(k, v) { state.filters[`${k}<`] = v; return chain; },
      in(k, v) { state.filters[`${k} in`] = v; return chain; },
      order() { return chain; },
      maybeSingle() { calls.push(state); return Promise.resolve({ data: rowsByCall.config || null }); },
      then(res) { calls.push(state); return Promise.resolve({ data: rowsByCall[state.table] || [], error: null }).then(res); },
      update(patch) { state.update = patch; return chain; },
      upsert(row) { state.upsert = row; calls.push(state); return Promise.resolve({ error: null }); },
    };
    return chain;
  };
  return { from: q, _calls: calls };
}

heading('convertStaleDrafts');
at('converts an advance-only draft that is still open', async () => {
  const converted = [];
  const res = await convertStaleDrafts({
    supabase: fakeSupabase({ credit_instruments: [
      { serial_code: '#D189', value: '5000', source_order_id: '111', issued_at: '2026-07-01' },
    ] }),
    axios: { get: async () => ({ data: { draft_order: { id: 111, name: '#D189', status: 'open', line_items: [cad] } } }) },
    storeUrl: 'https://x', getShopifyToken: async () => 'tok',
    completeDraftOrder: async (id) => { converted.push(id); return '999'; },
  });
  assert.deepStrictEqual(converted, ['111']);
  assert.strictEqual(res.converted, 1);
});

at('LEAVES a draft that has since gained a product — Path A is in progress', async () => {
  const converted = [];
  const res = await convertStaleDrafts({
    supabase: fakeSupabase({ credit_instruments: [
      { serial_code: '#D190', value: '5000', source_order_id: '112', issued_at: '2026-07-01' },
    ] }),
    axios: { get: async () => ({ data: { draft_order: { id: 112, name: '#D190', status: 'open', line_items: [cad, ring] } } }) },
    storeUrl: 'https://x', getShopifyToken: async () => 'tok',
    completeDraftOrder: async (id) => { converted.push(id); return '999'; },
  });
  assert.deepStrictEqual(converted, []);
  assert.strictEqual(res.skipped, 1);
});

at('ignores rows already keyed to an ORDER — those converted long ago', async () => {
  const res = await convertStaleDrafts({
    supabase: fakeSupabase({ credit_instruments: [
      { serial_code: '#1042', value: '5000', source_order_id: '113', issued_at: '2026-07-01' },
    ] }),
    axios: { get: async () => { throw new Error('should not be called'); } },
    storeUrl: 'https://x', getShopifyToken: async () => 'tok',
    completeDraftOrder: async () => { throw new Error('should not convert'); },
  });
  assert.strictEqual(res.found, 0);
});

at('one failing draft does not stop the rest of the run', async () => {
  const converted = [];
  let call = 0;
  const res = await convertStaleDrafts({
    supabase: fakeSupabase({ credit_instruments: [
      { serial_code: '#D191', value: '5000', source_order_id: '114', issued_at: '2026-07-01' },
      { serial_code: '#D192', value: '5000', source_order_id: '115', issued_at: '2026-07-01' },
    ] }),
    axios: { get: async () => {
      if (++call === 1) throw new Error('shopify 500');
      return { data: { draft_order: { id: 115, name: '#D192', status: 'open', line_items: [cad] } } };
    } },
    storeUrl: 'https://x', getShopifyToken: async () => 'tok',
    completeDraftOrder: async (id) => { converted.push(id); return '999'; },
  });
  assert.deepStrictEqual(converted, ['115']);
  assert.strictEqual(res.converted, 1);
  assert.strictEqual(res.skipped, 1);
});

heading('handlers — dependency wiring');
// These handlers were lifted out of server.js into a deps factory. A misnamed dep would not surface
// at require time, only when a live webhook ran — so drive one all the way through with fakes.
const handlersWith = (over = {}) => createCadAdvanceHandlers({
  axios: { get: async () => ({ data: { metafields: [{ namespace: 'custom', key: 'advance_status', value: 'open' }] } }) },
  storeUrl: 'https://x',
  supabase: fakeSupabase({ credit_instruments: [] }),
  getShopifyToken: async () => 'tok',
  updateDraftOrderMetafields: async () => {},
  updateOrderMetafields: async () => {},
  gqlSetDraftLineItems: async () => {},
  ...over,
});

at('Path A: removes the CAD line once a product joins it, keeping the product', async () => {
  let wrote = null;
  const h = handlersWith({ gqlSetDraftLineItems: async (id, lines) => { wrote = { id, lines }; } });
  await h.handleAdvanceLineRemoval({ id: 111, name: '#D189', line_items: [cad, ring] });
  assert.ok(wrote, 'the draft was rewritten');
  assert.deepStrictEqual(wrote.lines.map(l => l.title), ['Solitaire Ring']);
});

at('leaves a standalone advance draft alone — the CAD line IS the bill there', async () => {
  let wrote = null;
  const h = handlersWith({ gqlSetDraftLineItems: async (id, lines) => { wrote = { id, lines }; } });
  await h.handleAdvanceLineRemoval({ id: 111, name: '#D189', line_items: [cad] });
  assert.strictEqual(wrote, null);
});

at('will NOT remove the line before the advance is captured — the money is unrecorded', async () => {
  let wrote = null;
  const h = handlersWith({
    axios: { get: async () => ({ data: { metafields: [] } }) },   // no advance_status yet
    gqlSetDraftLineItems: async (id, lines) => { wrote = { id, lines }; },
  });
  await h.handleAdvanceLineRemoval({ id: 111, name: '#D189', line_items: [cad, ring] });
  assert.strictEqual(wrote, null);
});

heading('expireOverdueAdvances');
at('stamps the order so the redeem gate refuses it, and skips drafts it cannot stamp', async () => {
  const stamped = [];
  const res = await expireOverdueAdvances({
    supabase: fakeSupabase({ credit_instruments: [
      { serial_code: '#1042', source_order_name: '#1042', value: '5000', expires_at: '2026-08-01' },
      { serial_code: '#D189', source_order_name: '#D189', value: '2000', expires_at: '2026-08-01' },
    ] }),
    axios: { get: async () => ({ data: { orders: [{ id: 777, name: '#1042' }] } }) },
    storeUrl: 'https://x', getShopifyToken: async () => 'tok',
    updateOrderMetafields: async (id, patch) => { stamped.push([id, patch.advance_status]); },
  });
  assert.strictEqual(res.expired, 2);            // both leave the register as expired
  assert.deepStrictEqual(stamped, [['777', 'expired']]);   // only the one with a real order
  assert.strictEqual(res.stamped, 1);
});

at('dry run reports without expiring anything', async () => {
  const stamped = [];
  const res = await expireOverdueAdvances({
    supabase: fakeSupabase({ credit_instruments: [
      { serial_code: '#1042', source_order_name: '#1042', value: '5000', expires_at: '2026-08-01' },
    ] }),
    axios: { get: async () => { throw new Error('should not be called'); } },
    storeUrl: 'https://x', getShopifyToken: async () => { throw new Error('should not be called'); },
    updateOrderMetafields: async (id, patch) => { stamped.push([id, patch]); },
  }, { dryRun: true });
  assert.strictEqual(res.expired, 1);
  assert.strictEqual(res.stamped, 0);
  assert.deepStrictEqual(stamped, []);
});

heading('sendMonthlyDigest');
at('reports the month just ended, not the current one', async () => {
  let sent = null;
  const res = await sendMonthlyDigest({
    supabase: fakeSupabase({ credit_instruments: [
      { serial_code: '#1042', value: '5000', customer_name: 'A', expires_at: '2026-07-14', issued_at: '2025-07-14' },
    ] }),
    sendEmail: async (m) => { sent = m; },
    withStoreCc: () => ['store@x'],
    buildCadAdvanceDigestHtml: ({ monthLabel }) => `<i>${monthLabel}</i>`,
    accountsEmail: 'accounts@x',
  }, { now: Date.UTC(2026, 7, 3) });      // 3 Aug 2026 → digest covers July
  assert.strictEqual(res.month, '2026-07');
  assert.ok(sent && /July 2026/.test(sent.subject), 'subject names the reported month');
  assert.strictEqual(sent.to, 'accounts@x');
});

at('does not re-send once the marker records the month', async () => {
  let sent = false;
  const res = await sendMonthlyDigest({
    supabase: fakeSupabase({ config: { value: '2026-07' }, credit_instruments: [] }),
    sendEmail: async () => { sent = true; },
    withStoreCc: () => [],
    buildCadAdvanceDigestHtml: () => '<i></i>',
    accountsEmail: 'accounts@x',
  }, { now: Date.UTC(2026, 7, 3) });
  assert.strictEqual(sent, false);
  assert.match(res.reason, /already sent/);
});

at('stays silent when there is nothing to report', async () => {
  let sent = false;
  const res = await sendMonthlyDigest({
    supabase: fakeSupabase({ credit_instruments: [] }),
    sendEmail: async () => { sent = true; },
    withStoreCc: () => [],
    buildCadAdvanceDigestHtml: () => '<i></i>',
    accountsEmail: 'accounts@x',
  }, { now: Date.UTC(2026, 7, 3) });
  assert.strictEqual(sent, false);
  assert.strictEqual(res.reason, 'nothing to report');
});

(async () => {
  for (const entry of queue) {
    if (entry[0] === 'heading') { console.log(entry[1]); continue; }
    const [, name, fn] = entry;
    await fn();
    n++;
    console.log('  ok  ' + name);
  }
  console.log(`\n${n} assertions passed`);
})().catch((err) => { console.error('  FAIL ', err && err.message, '\n', err); process.exit(1); });
