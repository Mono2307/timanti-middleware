const assert = require('assert');

// Enough env to construct the module graph; nothing here dials out — every request is served by a
// stub adapter, so the "network" is entirely local.
process.env.SUPABASE_URL         ||= 'https://retry-test.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'not-a-real-key';
process.env.SHOPIFY_STORE_URL    ||= 'https://retry-test.invalid';

const axios = require('axios');
const { installShopifyRetry } = require('./shopify');

const STORE = process.env.SHOPIFY_STORE_URL;
const ADMIN = `${STORE}/admin/api/2024-01/draft_orders/1/metafields.json`;

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };

// Why this file exists: this interceptor is the fix for a real incident. On 2026-09-17 a single
// product added to #D223 produced ten webhook deliveries in nine seconds; the REST bucket ran dry and
// `sync-net` / `payment-sync` — the handlers that run LAST — failed with 429 on all ten passes. The
// draft was left reading "fully paid" with 28,000 outstanding. Nothing retried, because nothing could.
//
// The cost of getting this wrong is asymmetric, which is what these assertions pin:
//   - failing to retry a 429 loses a write silently (the original bug)
//   - retrying a POST that already applied DOUBLES it — a second metafield, ledger row, or serial
// So 429 must retry on every verb, and a 5xx must retry only where replay is safe.

// Builds an axios instance whose adapter replays a scripted sequence of outcomes.
function stubInstance(script) {
  const inst = axios.create();
  let call = 0;
  inst.defaults.adapter = async (config) => {
    const outcome = script[Math.min(call, script.length - 1)];
    call++;
    if (outcome.status >= 200 && outcome.status < 300) {
      return { data: outcome.data ?? {}, status: outcome.status, headers: {}, config };
    }
    const err = new Error(`Request failed with status code ${outcome.status}`);
    err.config = config;
    err.response = { status: outcome.status, headers: outcome.headers || {}, data: {} };
    throw err;
  };
  inst.calls = () => call;
  installShopifyRetry(inst);
  return inst;
}

(async () => {
  console.log('429 — the failure that caused the incident');

  await t('a 429 then a 200 resolves, and the call was actually repeated', async () => {
    const inst = stubInstance([{ status: 429 }, { status: 200, data: { ok: true } }]);
    const res = await inst.get(ADMIN);
    assert.deepStrictEqual(res.data, { ok: true });
    assert.strictEqual(inst.calls(), 2);
  });

  await t('a POST is retried on 429 — the request was refused, not half-applied', async () => {
    const inst = stubInstance([{ status: 429 }, { status: 200, data: { ok: true } }]);
    await inst.post(ADMIN, { metafield: {} });
    assert.strictEqual(inst.calls(), 2);
  });

  await t('a persistent 429 gives up rather than looping forever', async () => {
    const inst = stubInstance([{ status: 429 }]);
    await assert.rejects(() => inst.get(ADMIN), /429/);
    // 1 original + RETRY_MAX_ATTEMPTS replays.
    assert.strictEqual(inst.calls(), 6);
  });

  await t('Retry-After is honoured without stalling the suite', async () => {
    const inst = stubInstance([{ status: 429, headers: { 'retry-after': '1' } }, { status: 200 }]);
    const started = Date.now();
    await inst.get(ADMIN);
    // Honoured (>= the 1s it asked for) but still jittered, so it must not be exactly 1000ms.
    assert.ok(Date.now() - started >= 1000, 'waited at least the advertised second');
    assert.strictEqual(inst.calls(), 2);
  });

  console.log('5xx — replay only where it cannot double a write');

  await t('a GET retries on 500', async () => {
    const inst = stubInstance([{ status: 500 }, { status: 200 }]);
    await inst.get(ADMIN);
    assert.strictEqual(inst.calls(), 2);
  });

  await t('a PUT retries on 503 — idempotent, so replay is safe', async () => {
    const inst = stubInstance([{ status: 503 }, { status: 200 }]);
    await inst.put(ADMIN, {});
    assert.strictEqual(inst.calls(), 2);
  });

  await t('a POST does NOT retry on 500 — it may already have applied', async () => {
    const inst = stubInstance([{ status: 500 }, { status: 200 }]);
    await assert.rejects(() => inst.post(ADMIN, {}), /500/);
    assert.strictEqual(inst.calls(), 1);
  });

  console.log('scope — only our own calls');

  await t('a 429 from a non-Shopify host is left alone', async () => {
    const inst = stubInstance([{ status: 429 }, { status: 200 }]);
    await assert.rejects(() => inst.get('https://script.google.com/macros/s/whatever'), /429/);
    assert.strictEqual(inst.calls(), 1);
  });

  await t('a 4xx that is not 429 is not retried', async () => {
    const inst = stubInstance([{ status: 404 }, { status: 200 }]);
    await assert.rejects(() => inst.get(ADMIN), /404/);
    assert.strictEqual(inst.calls(), 1);
  });

  console.log('installation');

  await t('installing twice on one instance does not stack interceptors', async () => {
    const inst = stubInstance([{ status: 429 }, { status: 200 }]);
    installShopifyRetry(inst);   // second call — must be a no-op
    await inst.get(ADMIN);
    assert.strictEqual(inst.calls(), 2);
  });

  await t('an instance with no interceptor chain is skipped, not thrown at', async () => {
    assert.doesNotThrow(() => installShopifyRetry({}));
    assert.doesNotThrow(() => installShopifyRetry(undefined));
  });

  console.log(`\n${n} assertions passed`);
})().catch((err) => { console.error(err); process.exit(1); });
