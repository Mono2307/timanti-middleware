const assert = require('assert');
const { previewSerial, allocateSerial, fyEnd } = require('./index');

let n = 0;
const at = (name, fn) => { pending.push(fn().then(() => { n++; console.log('  ok  ' + name); })); };
const pending = [];

// Minimal Supabase stand-in. serial_counters is a plain map keyed the way the real table is keyed —
// (doc_type, state_code) — so a test can assert on the KEY as well as the number, which is the half
// the old /api/serial/peek got wrong.
function makeDeps(counters) {
  counters = counters || {};
  const deps = {
    counters,
    supabase: {
      from(table) {
        const f = {};
        const q = {
          select: () => q,
          eq: (col, val) => { f[col] = val; return q; },
          maybeSingle: async () => {
            if (table !== 'serial_counters') return { data: null };  // config: no registry override
            const key = f.doc_type + '|' + f.state_code;
            return { data: counters[key] == null ? null
              : { current_value: counters[key], updated_at: '2026-09-15T10:00:00Z' } };
          },
        };
        return q;
      },
      rpc: async (name, args) => {
        assert.strictEqual(name, 'allocate_serial');
        const key = args.p_doc_type + '|' + args.p_state_code;
        counters[key] = counters[key] == null ? args.p_start : counters[key] + 1;
        return { data: counters[key] };
      },
    },
  };
  return deps;
}

console.log('previewSerial — what staff are shown before they commit');

at('an untouched counter previews the registry start, not start+1', async () => {
  const p = await previewSerial(makeDeps(), { docType: 'delivery_challan', stateCode: 'KA-HSR' });
  assert.strictEqual(p.next_seq, 1);
  assert.strictEqual(p.next_code, 'DC-KAHSR-0001');
  assert.strictEqual(p.current_value, null);
});

at('the B2B series previews as AURA-…, padded to four', async () => {
  const p = await previewSerial(makeDeps({ 'b2b|KA-HSR': 6 }), { docType: 'b2b', stateCode: 'KA-HSR' });
  assert.strictEqual(p.next_code, 'AURA-KAHSR-0007');
});

at('a lower-case or padded store code resolves to the same counter', async () => {
  const p = await previewSerial(makeDeps({ 'delivery_challan|KA-HSR': 3 }),
    { docType: 'delivery_challan', stateCode: ' ka-hsr ' });
  assert.strictEqual(p.next_code, 'DC-KAHSR-0004');
});

at('an FY-scoped type reads the FY-FOLDED key — the bug that made /peek always answer null', async () => {
  const key = 'customer_order|' + fyEnd() + '|KA-HSR';
  const counters = {}; counters[key] = 12;
  const p = await previewSerial(makeDeps(counters), { docType: 'customer_order', stateCode: 'KA-HSR' });
  assert.strictEqual(p.counterKey, fyEnd() + '|KA-HSR');
  assert.strictEqual(p.current_value, 12);
  assert.strictEqual(p.next_code, 'TM' + fyEnd() + '-KAHSR-00013');
});

at('two stores keep separate books', async () => {
  const deps = makeDeps({ 'delivery_challan|KA-HSR': 40, 'delivery_challan|MH-HQ': 2 });
  const ka = await previewSerial(deps, { docType: 'delivery_challan', stateCode: 'KA-HSR' });
  const mh = await previewSerial(deps, { docType: 'delivery_challan', stateCode: 'MH-HQ' });
  assert.strictEqual(ka.next_code, 'DC-KAHSR-0041');
  assert.strictEqual(mh.next_code, 'DC-MHHQ-0003');
});

at('a store-scoped type with no store code says so instead of previewing nothing', async () => {
  await assert.rejects(
    () => previewSerial(makeDeps(), { docType: 'delivery_challan' }),
    /store code required/);
});

at('an unknown doc type is rejected, not silently formatted', async () => {
  await assert.rejects(
    () => previewSerial(makeDeps(), { docType: 'not_a_doc_type', stateCode: 'KA-HSR' }),
    /unknown docType/);
});

console.log('previewSerial vs allocateSerial — the preview must not be able to lie');

// The manual-document sheet shows a preview and then mints. If those two could format the same
// sequence differently, a challan would print one number and the ledger would record another, and
// nothing downstream would notice. They share counterKeyFor and renderSerial precisely so this
// cannot happen — this test is what keeps them sharing.
at('every manual doc type previews exactly what the next mint produces', async () => {
  for (const docType of ['delivery_challan', 'b2b']) {
    for (const store of ['KA-HSR', 'MH-HQ']) {
      const deps = makeDeps();
      for (let i = 0; i < 3; i++) {
        const preview = await previewSerial(deps, { docType, stateCode: store });
        const minted  = await allocateSerial(deps, { docType, stateCode: store });
        assert.strictEqual(minted.code, preview.next_code, docType + ' ' + store + ' draw ' + (i + 1));
        assert.strictEqual(minted.seq, preview.next_seq);
        assert.strictEqual(minted.counterKey, preview.counterKey);
      }
    }
  }
});

at('the agreement holds for FY-scoped types too, key and printed form alike', async () => {
  const deps = makeDeps();
  for (const docType of ['customer_order', 'customer_service', 'free_service', 'voucher', 'exchange_note']) {
    const preview = await previewSerial(deps, { docType, stateCode: 'KA-HSR' });
    const minted  = await allocateSerial(deps, { docType, stateCode: 'KA-HSR' });
    assert.strictEqual(minted.code, preview.next_code, docType);
    assert.strictEqual(minted.counterKey, preview.counterKey, docType);
    assert.ok(preview.counterKey.indexOf(fyEnd() + '|') === 0, docType + ' key is FY-folded');
  }
});

at('a preview taken before someone else mints is stale, not authoritative', async () => {
  const deps = makeDeps();
  // Two staff both see 0001.
  const a = await previewSerial(deps, { docType: 'delivery_challan', stateCode: 'KA-HSR' });
  const b = await previewSerial(deps, { docType: 'delivery_challan', stateCode: 'KA-HSR' });
  assert.strictEqual(a.next_code, b.next_code);
  // Whoever mints first gets it; the second draws the NEXT one, and must print what it drew.
  const first  = await allocateSerial(deps, { docType: 'delivery_challan', stateCode: 'KA-HSR' });
  const second = await allocateSerial(deps, { docType: 'delivery_challan', stateCode: 'KA-HSR' });
  assert.strictEqual(first.code, 'DC-KAHSR-0001');
  assert.strictEqual(second.code, 'DC-KAHSR-0002');
  assert.notStrictEqual(second.code, b.next_code);
});

Promise.all(pending)
  .then(() => console.log('\n  ' + n + ' assertions passed\n'))
  .catch((err) => { console.error('\n  FAILED: ' + err.message + '\n'); process.exit(1); });
