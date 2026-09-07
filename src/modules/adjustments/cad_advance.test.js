const assert = require('assert');
const {
  isCadAdvanceLine, hasCadAdvanceLine, hasProductLineBesidesCad, isCadAdvanceOnly,
  cadAdvanceLineTotal, cadLedgerKey, CAD_ADVANCE_MODE, addMonths,
} = require('./cad_advance');
const { convertStaleDrafts, expireOverdueAdvances, remindExpiring, sendMonthlyDigest } = require('./cad_advance_sweep');
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
      is(k, v) { state.filters[`${k} is`] = v; return chain; },
      order() { return chain; },
      maybeSingle() { calls.push(state); return Promise.resolve({ data: rowsByCall.config || null }); },
      then(res) { calls.push(state); return Promise.resolve({ data: rowsByCall[state.table] || [], error: null }).then(res); },
      update(patch) { state.update = patch; return chain; },
      upsert(row) { state.upsert = row; calls.push(state); return Promise.resolve({ error: null }); },
      insert(row) { state.insert = row; calls.push(state); return Promise.resolve({ error: null }); },
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

at('four simultaneous webhooks act ONCE — the #D208 duplicate-log race', async () => {
  // One staff action produced four draft_orders/update deliveries. Every handler here is
  // read-check-write, so all four read the pre-write state, all passed the "already done?" check,
  // and all acted — four identical rows in the sheet log. On the redeem path the same race would
  // absorb one advance into four installment slots.
  let calls = 0;
  const h = handlersWith({
    gqlSetDraftLineItems: async () => { await new Promise(r => setTimeout(r, 20)); calls++; },
  });
  const draft = { id: 208, name: '#D208', line_items: [cad, ring] };
  await Promise.all([
    h.handleAdvanceLineRemoval(draft),
    h.handleAdvanceLineRemoval(draft),
    h.handleAdvanceLineRemoval(draft),
    h.handleAdvanceLineRemoval(draft),
  ]);
  assert.strictEqual(calls, 1, 'the draft is rewritten once, not once per webhook delivery');
});

at('the guard releases, so a later genuine call still runs', async () => {
  // A lock that never cleared would be worse than the duplicates: the FIRST capture would work and
  // every advance afterwards on that draft would be silently ignored.
  let calls = 0;
  const h = handlersWith({ gqlSetDraftLineItems: async () => { calls++; } });
  const draft = { id: 209, name: '#D209', line_items: [cad, ring] };
  await h.handleAdvanceLineRemoval(draft);
  await h.handleAdvanceLineRemoval(draft);
  assert.strictEqual(calls, 2, 'sequential calls are not blocked by a stale lock');
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

console.log('addMonths — the 11-month reminder date');
t('adds whole calendar months', () => {
  assert.strictEqual(addMonths('2026-01-15', 11), '2026-12-15');
  assert.strictEqual(addMonths('2026-09-01', 11), '2027-08-01');
});
t('clamps into a short month rather than spilling into the next', () => {
  // 31 Mar + 11 months is 28 Feb, never 3 March — a reminder must not overshoot into the month
  // where the advance has already lapsed.
  assert.strictEqual(addMonths('2026-03-31', 11), '2027-02-28');
  assert.strictEqual(addMonths('2028-03-31', 11), '2029-02-28');
});
t('survives rubbish input', () => {
  assert.strictEqual(addMonths('', 11), null);
  assert.strictEqual(addMonths('not-a-date', 11), null);
});

heading('remindExpiring — the customer nudge at 11 months');
at('emails the customer once the 11-month mark is reached', async () => {
  let sent = null;
  const res = await remindExpiring({
    supabase: fakeSupabase({ credit_instruments: [
      { serial_code: '#1042', value: '5000', customer_name: 'A Kumar', source_order_name: '#1042',
        issued_at: '2025-10-05', expires_at: '2026-10-05', status: 'open' },
    ] }),
    sendEmail: async (m) => { sent = m; },
    withStoreCc: () => [],
    buildCadAdvanceExpiryHtml: () => '<i>advance</i>',
    customerEmailFor: async () => 'customer@example.com',
  }, { now: Date.UTC(2026, 8, 10) });     // 10 Sep 2026 — past 5 Sep, the 11-month mark
  assert.strictEqual(res.sent, 1);
  assert.strictEqual(sent.to, 'customer@example.com');
  assert.match(sent.subject, /design advance expires/i);
});

at('stays quiet before the 11-month mark', async () => {
  let sent = false;
  const res = await remindExpiring({
    supabase: fakeSupabase({ credit_instruments: [
      { serial_code: '#1043', value: '5000', issued_at: '2026-08-01', expires_at: '2027-08-01', status: 'open' },
    ] }),
    sendEmail: async () => { sent = true; },
    withStoreCc: () => [],
    buildCadAdvanceExpiryHtml: () => '<i></i>',
    customerEmailFor: async () => 'customer@example.com',
  }, { now: Date.UTC(2026, 8, 10) });
  assert.strictEqual(sent, false);
  assert.strictEqual(res.due, 0);
});

at('never mails the same advance twice', async () => {
  let sent = false;
  const res = await remindExpiring({
    supabase: fakeSupabase({
      config: { value: JSON.stringify(['#1042']) },
      credit_instruments: [
        { serial_code: '#1042', value: '5000', issued_at: '2025-10-05', expires_at: '2026-10-05', status: 'open' },
      ] }),
    sendEmail: async () => { sent = true; },
    withStoreCc: () => [],
    buildCadAdvanceExpiryHtml: () => '<i></i>',
    customerEmailFor: async () => 'customer@example.com',
  }, { now: Date.UTC(2026, 8, 10) });
  assert.strictEqual(sent, false);
  assert.strictEqual(res.due, 0);
});

at('an advance with no contactable customer is logged, not silently dropped', async () => {
  const res = await remindExpiring({
    supabase: fakeSupabase({ credit_instruments: [
      { serial_code: '#1044', value: '5000', issued_at: '2025-10-05', expires_at: '2026-10-05', status: 'applied' },
    ] }),
    sendEmail: async () => { throw new Error('should not send'); },
    withStoreCc: () => [],
    buildCadAdvanceExpiryHtml: () => '<i></i>',
    customerEmailFor: async () => null,
  }, { now: Date.UTC(2026, 8, 10) });
  assert.strictEqual(res.sent, 0);
  assert.strictEqual(res.skipped, 1);
});

heading('sendMonthlyDigest');
at('reports THIS month — what is due to expire before the month is out', async () => {
  let sent = null;
  const res = await sendMonthlyDigest({
    supabase: fakeSupabase({ credit_instruments: [
      { serial_code: '#1042', value: '5000', customer_name: 'A', expires_at: '2026-08-14', issued_at: '2025-08-14' },
    ] }),
    sendEmail: async (m) => { sent = m; },
    withStoreCc: () => ['store@x'],
    buildCadAdvanceDigestHtml: ({ monthLabel }) => `<i>${monthLabel}</i>`,
    accountsEmail: 'accounts@x',
  }, { now: Date.UTC(2026, 7, 1) });      // 1 Aug 2026 → the August window
  assert.strictEqual(res.month, '2026-08');
  assert.ok(sent && /August 2026/.test(sent.subject), 'subject names the month being reported');
  assert.strictEqual(sent.to, 'accounts@x');
});

at('sends on the 1st, and still catches up if the 1st was missed', async () => {
  // Not gated on the calendar day: a machine down or deploying on the 1st would otherwise skip the
  // month entirely, and a missed write-off list is worse than one that lands on the 4th.
  let sent = false;
  const res = await sendMonthlyDigest({
    supabase: fakeSupabase({ credit_instruments: [
      { serial_code: '#1050', value: '2000', expires_at: '2026-08-20', issued_at: '2025-08-20' },
    ] }),
    sendEmail: async () => { sent = true; },
    withStoreCc: () => [],
    buildCadAdvanceDigestHtml: () => '<i></i>',
    accountsEmail: 'accounts@x',
  }, { now: Date.UTC(2026, 7, 4) });      // the 4th, marker unset
  assert.strictEqual(sent, true);
  assert.strictEqual(res.month, '2026-08');
});

at('does not re-send once the marker records the month', async () => {
  let sent = false;
  const res = await sendMonthlyDigest({
    supabase: fakeSupabase({ config: { value: '2026-08' }, credit_instruments: [] }),
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
