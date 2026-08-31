# -*- coding: utf-8 -*-
"""
repair_stale_metafields.py
==========================
Repairs variants whose price was written but whose metafields were not - the
state a run interrupted between Phase 2 (price) and Phase 3 (metafields) leaves
behind.

Those variants are self-consistent and wrong: gold, subtotal, GST and total all
reconcile at the PREVIOUS rate, sitting under a price computed at the CURRENT
one. Nothing about the metafield set looks broken; it just describes a price the
customer is not paying.

The repair rewrites the metafields from the rate the rest of the catalogue is
on, then writes gold_last_updated_at LAST, as a commit marker - so an
interruption here leaves a variant looking un-done rather than falsely done.

    py -3 repair_stale_metafields.py                 # dry run, writes nothing
    py -3 repair_stale_metafields.py --apply         # actually write
    py -3 repair_stale_metafields.py --apply --limit 20

Reads the token from ADMIN_API_TOKEN (env or .env).
"""
import argparse
import collections
import io
import json
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
STORE = 'auracarat.myshopify.com'
VERSION = '2024-10'
GST_RATE = 0.03
PRECISION = 2

# The five value fields, then the stamp on its own - order matters.
VALUE_KEYS = ('price_breakup_gold', 'price_breakup_gst',
              'price_subtotal', 'price_total', 'gold_rate')
STAMP_KEY = 'gold_last_updated_at'


def token():
    for name in ('ADMIN_API_TOKEN', 'SHOPIFY_TOKEN', 'SHOPIFY_ACCESS_TOKEN'):
        if os.environ.get(name):
            return os.environ[name].strip()
    for folder in (HERE, os.path.dirname(os.path.dirname(os.path.dirname(HERE)))):
        env = os.path.join(folder, '.env')
        if not os.path.exists(env):
            continue
        found = {}
        for line in io.open(env, encoding='utf-8'):
            if '=' in line and not line.strip().startswith('#'):
                k, v = line.split('=', 1)
                found[k.strip()] = v.strip().strip('"\'')
        for name in ('ADMIN_API_TOKEN', 'SHOPIFY_TOKEN', 'SHOPIFY_ACCESS_TOKEN'):
            if found.get(name):
                return found[name]
    sys.exit('No ADMIN_API_TOKEN found in env or .env')


TOK = None


def gql(query, variables=None, attempt=0):
    body = json.dumps({'query': query, 'variables': variables or {}}).encode()
    req = urllib.request.Request(
        f'https://{STORE}/admin/api/{VERSION}/graphql.json',
        data=body, method='POST',
        headers={'X-Shopify-Access-Token': TOK, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            out = json.loads(r.read().decode())
    except Exception as exc:
        if attempt < 4:
            time.sleep(2 ** attempt)
            return gql(query, variables, attempt + 1)
        raise
    if out.get('errors'):
        raise RuntimeError(json.dumps(out['errors'])[:400])
    throttle = ((out.get('extensions') or {}).get('cost') or {}).get('throttleStatus') or {}
    if throttle.get('currentlyAvailable', 999) < 200:
        time.sleep(1.5)
    return out['data']


SCAN = '''
query($cursor: String) {
  productVariants(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id sku price
      product { id status }
      wt:    metafield(namespace:"custom", key:"net_metal_weight_g")    { value }
      dia:   metafield(namespace:"custom", key:"price_breakup_diamond") { value }
      make:  metafield(namespace:"custom", key:"price_breakup_making")  { value }
      gem:   metafield(namespace:"custom", key:"gemstone_charges")      { value }
      sub:   metafield(namespace:"custom", key:"price_subtotal")        { value }
      tot:   metafield(namespace:"custom", key:"price_total")           { value }
      rate:  metafield(namespace:"custom", key:"gold_rate")             { value }
      done:  metafield(namespace:"custom", key:"gold_last_updated_at")  { value }
    }
  }
}
'''

SET_MF = '''
mutation($m: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $m) { userErrors { field message } }
}
'''


def f(node, key):
    o = node.get(key)
    if not o:
        return None
    try:
        return float((o.get('value') or '').strip())
    except (ValueError, TypeError):
        return None


def s(node, key):
    o = node.get(key)
    return ((o or {}).get('value') or '').strip()


def karat_of(sku):
    parts = (sku or '').split('|')
    k = parts[2].strip() if len(parts) > 2 else ''
    for tag in ('24', '22', '14'):
        if tag in k:
            return tag + 'K'
    return '18K'


def scan(log=print):
    """Every live variant, with what it would need to be consistent."""
    out, cursor = [], None
    while True:
        page = gql(SCAN, {'cursor': cursor})['productVariants']
        for n in page['nodes']:
            if (n.get('product') or {}).get('status') == 'ARCHIVED':
                continue
            out.append(n)
        if not page['pageInfo']['hasNextPage']:
            break
        cursor = page['pageInfo']['endCursor']
        log(f'  scanned {len(out):,} variants...')
    return out


def find_broken(nodes):
    """Variants whose stored total disagrees with the price actually charged.

    That is the signature of a run that wrote Phase 2 but not Phase 3.
    """
    rates = collections.defaultdict(collections.Counter)
    stamps = collections.Counter()
    for n in nodes:
        r, d = f(n, 'rate'), s(n, 'done')
        if r:
            rates[karat_of(n.get('sku'))][r] += 1
        if d:
            stamps[d] += 1
    # the rate and stamp the majority of the catalogue is on
    current = {k: c.most_common(1)[0][0] for k, c in rates.items()}
    stamp = stamps.most_common(1)[0][0] if stamps else ''

    broken = []
    for n in nodes:
        price, tot = f(n, 'price') if False else None, f(n, 'tot')
        try:
            price = float(n.get('price'))
        except (TypeError, ValueError):
            continue
        if tot is None or abs(tot - price) <= 0.01:
            continue
        net, dia = f(n, 'wt'), f(n, 'dia')
        if not net:
            continue
        make = f(n, 'make') or 0.0
        gem = f(n, 'gem') or 0.0
        karat = karat_of(n.get('sku'))
        rate = current.get(karat)
        if rate is None:
            continue
        gold = round(net * rate, PRECISION)
        sub = round(gold + (dia or 0.0) + make + gem, PRECISION)
        gst = round(sub * GST_RATE, PRECISION)
        total = round(sub + gst, PRECISION)
        broken.append({
            'id': n['id'], 'sku': n.get('sku', ''), 'karat': karat,
            'price_charged': price, 'stored_total': tot,
            'gap': round(tot - price, 2),
            'new': {'price_breakup_gold': gold, 'price_breakup_gst': gst,
                    'price_subtotal': sub, 'price_total': total,
                    'gold_rate': rate},
            'stamp': stamp,
            'matches_price': abs(total - price) <= 1.0,
        })
    return broken, current, stamp


MF_PER_CALL = 25            # Shopify's limit for metafieldsSet
VALUES_PER_VARIANT = len(VALUE_KEYS)
VARIANTS_PER_CALL = MF_PER_CALL // VALUES_PER_VARIANT      # 5


def _value_payload(v):
    return [{'ownerId': v['id'], 'namespace': 'custom', 'key': k,
             'type': 'number_decimal', 'value': str(val)}
            for k, val in v['new'].items()]


def _stamp_payload(v):
    return {'ownerId': v['id'], 'namespace': 'custom', 'key': STAMP_KEY,
            'type': 'date_time', 'value': v['stamp']}


def write_batch(variants, apply=False, log=print):
    """Values for a batch, then stamps for the ones whose values landed.

    Batching does not weaken the ordering: every value write in the batch is
    committed before any stamp in it goes out, so an interruption still leaves
    unstamped variants rather than falsely-stamped ones. A batch that reports
    errors is retried one variant at a time, so a single bad variant cannot
    block the four beside it.
    """
    if not apply:
        return len(variants), 0, []

    ok, failed, errors = [], 0, []

    # ── values ──────────────────────────────────────────────────────────────
    for i in range(0, len(variants), VARIANTS_PER_CALL):
        chunk = variants[i:i + VARIANTS_PER_CALL]
        payload = [m for v in chunk for m in _value_payload(v)]
        res = gql(SET_MF, {'m': payload})
        errs = (res.get('metafieldsSet') or {}).get('userErrors') or []
        if not errs:
            ok.extend(chunk)
            continue
        # something in the chunk was rejected - find out which
        for v in chunk:
            res = gql(SET_MF, {'m': _value_payload(v)})
            e = (res.get('metafieldsSet') or {}).get('userErrors') or []
            if e:
                failed += 1
                errors.append((v['sku'], json.dumps(e)[:160]))
            else:
                ok.append(v)

    # ── stamps, only for variants whose values are in ───────────────────────
    for i in range(0, len(ok), MF_PER_CALL):
        chunk = ok[i:i + MF_PER_CALL]
        res = gql(SET_MF, {'m': [_stamp_payload(v) for v in chunk]})
        errs = (res.get('metafieldsSet') or {}).get('userErrors') or []
        if errs:
            for v in chunk:
                res = gql(SET_MF, {'m': [_stamp_payload(v)]})
                e = (res.get('metafieldsSet') or {}).get('userErrors') or []
                if e:
                    errors.append((v['sku'] + ' [stamp]', json.dumps(e)[:160]))

    return len(ok), failed, errors


def main():
    global TOK
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='actually write')
    ap.add_argument('--limit', type=int, default=0)
    args = ap.parse_args()
    TOK = token()

    print('Scanning live variants ...')
    nodes = scan()
    print(f'  {len(nodes):,} live variants')

    broken, current, stamp = find_broken(nodes)
    print(f'\nCurrent rate per karat : {current}')
    print(f'Current stamp          : {stamp}')
    print(f'Variants to repair     : {len(broken):,}')
    if not broken:
        print('Nothing to do.')
        return

    bad = [b for b in broken if not b['matches_price']]
    print(f'  of which the recomputed total would NOT match the price: {len(bad)}')
    if bad:
        print('  those are left alone - they need a full re-price, not a metafield repair')
    todo = [b for b in broken if b['matches_price']]
    if args.limit:
        todo = todo[:args.limit]

    gaps = [b['gap'] for b in todo]
    print(f'\n  repairing {len(todo):,} variants')
    print(f'  stored total overstates the charge by Rs {min(gaps):,.2f} to '
          f'Rs {max(gaps):,.2f}')
    print('\n  examples:')
    for b in todo[:4]:
        print(f"    {b['sku'][:36]:36} price {b['price_charged']:>11,.2f}  "
              f"stored {b['stored_total']:>11,.2f} -> {b['new']['price_total']:>11,.2f}")

    if not args.apply:
        print('\nDRY RUN - nothing written. Re-run with --apply to write.')
        return

    print(f'\nWriting in batches of {VARIANTS_PER_CALL} '
          f'(~{len(todo) // VARIANTS_PER_CALL + len(todo) // MF_PER_CALL} API calls) ...')
    t0 = time.time()
    ok = fail = 0
    all_errors = []
    STEP = 250
    for i in range(0, len(todo), STEP):
        chunk = todo[i:i + STEP]
        good, bad, errs = write_batch(chunk, apply=True)
        ok += good
        fail += bad
        all_errors.extend(errs)
        print(f'  {min(i + STEP, len(todo)):,}/{len(todo):,}  '
              f'repaired {ok:,}  failed {fail}  '
              f'({time.time() - t0:.0f}s)')
    print(f'\nDone in {time.time() - t0:.0f}s. {ok:,} repaired, {fail} failed.')
    for sku, msg in all_errors[:10]:
        print(f'  ERR {sku}: {msg}')

    print('Verifying ...')
    nodes = scan(log=lambda *a: None)
    still, _, _ = find_broken(nodes)
    print(f'  {len(still):,} variants still disagree (was {len(broken):,})')


if __name__ == '__main__':
    main()
