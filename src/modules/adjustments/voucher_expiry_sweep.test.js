const assert = require('assert');
const { runVoucherExpirySweep, REMINDED_KEY } = require('./voucher_expiry_sweep');

// Why this file exists: the 30-day voucher reminder was guarded by an in-memory Set over a
// one-day window. A restart re-sent that day's mails; a day of downtime skipped that day's
// vouchers for good. The guard is now persisted (config table) and the window is "<= 30 days,
// not yet expired". Every dep here is a fake.

const queue = [];
const at = (name, fn) => queue.push([name, fn]);

const NOW = Date.UTC(2026, 9, 30, 6, 0, 0);            // 30 Oct 2026
const day = (d) => new Date(Date.UTC(2026, 10, d, 12)).toISOString();   // November d

function fakeSupabase({ config = null, vouchers = [], readThrows = false }) {
  const upserts = [];
  const filters = {};
  const from = (table) => {
    const chain = {
      select() { return chain; },
      eq(k, v) { filters[`${table}.${k}`] = v; return chain; },
      gte(k, v) { filters[`${table}.${k}>=`] = v; return chain; },
      lt(k, v) { filters[`${table}.${k}<`] = v; return chain; },
      maybeSingle() {
        if (readThrows) return Promise.reject(new Error('db down'));
        return Promise.resolve({ data: config });
      },
      then(res) { return Promise.resolve({ data: vouchers, error: null }).then(res); },
      upsert(row) { upserts.push(row); return Promise.resolve({ error: null }); },
    };
    return chain;
  };
  return { from, upserts, filters };
}

const deps = (supabase, sent) => ({
  supabase,
  sendEmail: async (m) => { sent.push(m); },
  withStoreCc: () => [],
  buildVoucherExpiryHtml: () => '<i>voucher</i>',
  customerEmailFor: async () => 'customer@example.com',
});

at('window is tolerant: anything not yet expired and due within 30 days', async () => {
  const sb = fakeSupabase({ config: { value: '[]' }, vouchers: [] });
  await runVoucherExpirySweep(deps(sb, []), { now: NOW });
  assert.strictEqual(sb.filters['credit_instruments.expires_at>='], new Date(NOW).toISOString());
  // End of the 30th day out: 29 Nov 2026 is NOW + 30d, so the bound is 30 Nov 00:00 UTC.
  assert.strictEqual(sb.filters['credit_instruments.expires_at<'], '2026-11-30T00:00:00.000Z');
});

at('a missed day still goes out, and what was sent is persisted', async () => {
  const sent = [];
  const sb = fakeSupabase({ config: { value: '[]' }, vouchers: [
    { serial_code: 'VCH-1', value: 5000, expires_at: day(27), source_order_name: '#1100' },
  ] });
  const res = await runVoucherExpirySweep(deps(sb, sent), { now: NOW });
  assert.strictEqual(res.sent, 1);
  assert.strictEqual(sent[0].to, 'customer@example.com');
  assert.strictEqual(sb.upserts.length, 1);
  assert.strictEqual(sb.upserts[0].key, REMINDED_KEY);
  assert.deepStrictEqual(JSON.parse(sb.upserts[0].value), ['VCH-1']);
});

at('never mails the same voucher twice — the guard survives a restart', async () => {
  const sent = [];
  const sb = fakeSupabase({ config: { value: JSON.stringify(['VCH-1']) }, vouchers: [
    { serial_code: 'VCH-1', value: 5000, expires_at: day(27) },
    { serial_code: 'VCH-2', value: 2000, expires_at: day(29) },
  ] });
  const res = await runVoucherExpirySweep(deps(sb, sent), { now: NOW });
  assert.strictEqual(res.sent, 1);
  assert.match(sent[0].subject, /VCH-2/);
  assert.deepStrictEqual(JSON.parse(sb.upserts[0].value), ['VCH-1', 'VCH-2']);
});

at('a failed send is not recorded, so the next run retries it', async () => {
  const sb = fakeSupabase({ config: { value: '[]' }, vouchers: [
    { serial_code: 'VCH-3', value: 1000, expires_at: day(20) },
  ] });
  const res = await runVoucherExpirySweep({ ...deps(sb, []), sendEmail: async () => { throw new Error('bounce'); } }, { now: NOW });
  assert.strictEqual(res.sent, 0);
  assert.strictEqual(res.skipped, 1);
  assert.strictEqual(sb.upserts.length, 0);
});

at('an unreadable marker sends nothing', async () => {
  const sent = [];
  const sb = fakeSupabase({ readThrows: true, vouchers: [
    { serial_code: 'VCH-4', value: 1000, expires_at: day(20) },
  ] });
  const res = await runVoucherExpirySweep(deps(sb, sent), { now: NOW });
  assert.strictEqual(res.blocked, true);
  assert.strictEqual(sent.length, 0);
});

at('first run seeds the window instead of re-mailing what the one-day sweep already sent', async () => {
  const sent = [];
  const sb = fakeSupabase({ config: null, vouchers: [
    { serial_code: 'VCH-OLD', value: 1000, expires_at: day(10) },   // inside the window, before day 30
    { serial_code: 'VCH-NEW', value: 1000, expires_at: day(29) },   // the 30th-day cohort
  ] });
  const res = await runVoucherExpirySweep(deps(sb, sent), { now: NOW });
  assert.strictEqual(res.sent, 1);
  assert.strictEqual(res.seeded, 1);
  assert.match(sent[0].subject, /VCH-NEW/);
  assert.deepStrictEqual(JSON.parse(sb.upserts[0].value), ['VCH-OLD', 'VCH-NEW']);
});

at('dry run neither sends nor persists', async () => {
  const sent = [];
  const sb = fakeSupabase({ config: { value: '[]' }, vouchers: [
    { serial_code: 'VCH-5', value: 1000, expires_at: day(20) },
  ] });
  const res = await runVoucherExpirySweep(deps(sb, sent), { now: NOW, dryRun: true });
  assert.strictEqual(res.sent, 1);
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(sb.upserts.length, 0);
});

(async () => {
  let n = 0;
  console.log('voucher expiry sweep — persisted guard, tolerant window');
  for (const [name, fn] of queue) { await fn(); n++; console.log('  ok  ' + name); }
  console.log(`\n${n} assertions passed`);
})().catch((err) => { console.error('  FAIL ', err && err.message, '\n', err); process.exit(1); });
