"""
shopify_snapshot.py
===================
Pages through ALL live Shopify variants (ACTIVE + DRAFT, skips ARCHIVED).
Reads stored metafields: net weight, gross weight, diamond cost, making cost,
gemstone cost.
Recalculates gold component + GST using the day's gold rate.
Writes the preview CSV that import_from_preview.mjs consumes.

Called by orchestrator.py — not run directly.
"""

import csv
import json
import time
import logging
import requests
from datetime import datetime
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).parent))
from config import (STORE_DOMAIN, API_VERSION, GST_RATE, DECIMAL_PRECISION,
                    STATIC_PRICE_GATI_IDS, GEMSTONE_MF_KEY)

# ── GraphQL query — fetches 250 variants per page with all needed metafields ──
# %-interpolated (not .format) so the GraphQL braces need no escaping.

_Q = """
query($cursor: String) {
  productVariants(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      sku
      product { id status title handle }
      wt:    metafield(namespace: "custom", key: "net_metal_weight_g")    { value }
      gross: metafield(namespace: "custom", key: "total_metal_weight_g")  { value }
      dia:   metafield(namespace: "custom", key: "price_breakup_diamond") { value }
      make:  metafield(namespace: "custom", key: "price_breakup_making")  { value }
      gem:   metafield(namespace: "custom", key: "%s") { value }
      # Already-priced marker. Carries the set_at of the run that last priced this variant, so
      # an interrupted run can tell what it already finished WITHOUT a local progress file.
      done:  metafield(namespace: "custom", key: "gold_last_updated_at") { value }
    }
  }
}
""" % GEMSTONE_MF_KEY

_NO_WEIGHT_COLS = [
    'run_date', 'gati_id', 'sku', 'variant_id',
    'product_title', 'product_status', 'karat',
    'gross_weight_g', 'diamond_cost', 'making_cost', 'admin_url',
]

_COLS = [
    'shopify_variant_id', 'shopify_sku', 'search_prefix',
    'price_to_write', 'grams_to_write',
    'mf_net_metal_weight_g', 'mf_total_metal_weight_g',
    'mf_price_breakup_gold', 'mf_price_breakup_diamond',
    'mf_price_breakup_making', 'mf_price_breakup_gemstone',
    'mf_price_breakup_gst',
    'mf_price_total', 'mf_price_subtotal',
    'mf_gold_rate', 'mf_gold_last_updated_at',
]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _gql(url, headers, query, variables, log, attempt=0):
    MAX_RETRIES = 6
    try:
        r = requests.post(url, headers=headers,
                          json={'query': query, 'variables': variables},
                          timeout=30)
        j = r.json()
        available = (j.get('extensions', {})
                      .get('cost', {})
                      .get('throttleStatus', {})
                      .get('currentlyAvailable', 999))
        # Shopify reports auth failures as a STRING here ("[API] Invalid API key...") and
        # everything else as a list, so normalise before iterating - a string would otherwise
        # raise AttributeError inside the generator below and surface as a network error.
        _raw   = j.get('errors')
        errors = _raw if isinstance(_raw, list) else ([{'message': str(_raw)}] if _raw else [])
        throttled = available == 0 or any(
            (e.get('extensions') or {}).get('code') == 'THROTTLED' for e in errors
        )
        if throttled and attempt < MAX_RETRIES:
            wait = 3 * (attempt + 1)
            log.info(f'  Throttled — waiting {wait}s')
            time.sleep(wait)
            return _gql(url, headers, query, variables, log, attempt + 1)
        return j
    except Exception as e:
        if attempt < MAX_RETRIES:
            log.warning(f'  Network error ({e}), retry {attempt + 1}')
            time.sleep(3)
            return _gql(url, headers, query, variables, log, attempt + 1)
        raise


def _mf_str(node, key):
    obj = node.get(key)
    if not obj:
        return ''
    return (obj.get('value') or '').strip()


def _mf_float(node, key):
    obj = node.get(key)
    if not obj:
        return 0.0
    try:
        return float(obj.get('value') or 0)
    except (ValueError, TypeError):
        return 0.0


def _numeric_id(gid: str) -> str:
    """gid://shopify/ProductVariant/12345 → '12345'"""
    return (gid or '').rsplit('/', 1)[-1]


_STORE_HANDLE = STORE_DOMAIN.replace('.myshopify.com', '')


def _admin_url(product_gid: str, variant_gid: str) -> str:
    pid = _numeric_id(product_gid)
    vid = _numeric_id(variant_gid)
    if not pid:
        return ''
    base = f'https://admin.shopify.com/store/{_STORE_HANDLE}/products/{pid}'
    return f'{base}/variants/{vid}' if vid else base


# ── Main ──────────────────────────────────────────────────────────────────────

def build_snapshot(token: str, gold_rate: dict, output_csv: Path, log: logging.Logger,
                   test_gati: str = None) -> dict:
    """
    Fetches all live variants, recalculates prices, writes preview CSV.
    Returns a stats dict consumed by orchestrator and notifier.
    Pass test_gati to restrict the run to one product (e.g. 'RG00001').
    """
    url     = f'https://{STORE_DOMAIN}/admin/api/{API_VERSION}/graphql.json'
    headers = {'X-Shopify-Access-Token': token, 'Content-Type': 'application/json'}

    rate_18k  = gold_rate['18k']
    rate_14k  = gold_rate['14k']
    rate_22k  = gold_rate['22k']
    rate_24k  = gold_rate['24k']
    p         = DECIMAL_PRECISION
    # Normalise set_at to seconds precision for Shopify date_time metafield
    raw_set_at      = gold_rate.get('set_at', '')
    gold_updated_at = raw_set_at[:19] + '+00:00' if len(raw_set_at) >= 19 else raw_set_at

    # ── Phase 1: paginate all variants ───────────────────────────────────────
    all_variants   = []
    archived_count = 0
    cursor         = None
    page_num       = 0

    log.info('Snapshot — paging all Shopify variants...')

    while True:
        page_num  += 1
        variables  = {'cursor': cursor} if cursor else {}
        res = _gql(url, headers, _Q, variables, log)

        # A response with no usable data ENDS THE LOOP if it is allowed through, because the
        # missing pageInfo reads as hasNextPage=false. That is how a throttle that outlasted
        # _gql's retries turned into "0 active variants" - a silent empty catalogue, reported
        # as a clean run that simply had nothing to do. Fail loudly instead: an empty page is
        # never a legitimate answer for a catalogue with 15,000 variants in it.
        data = res.get('data') or {}
        page = data.get('productVariants') or {}
        if not page:
            raise RuntimeError(
                f'Snapshot page {page_num} returned no data - '
                f'{json.dumps(res.get("errors"))[:300] if res.get("errors") else "empty response"}')

        nodes      = page.get('nodes', [])

        for node in nodes:
            status = (node.get('product') or {}).get('status', 'UNKNOWN')
            if status == 'ARCHIVED':
                archived_count += 1
            else:
                all_variants.append(node)

        if page_num % 10 == 0 or not page.get('pageInfo', {}).get('hasNextPage'):
            log.info(f'  Page {page_num} — {len(all_variants)} active variants fetched so far')

        if not page.get('pageInfo', {}).get('hasNextPage'):
            break
        cursor = page['pageInfo']['endCursor']

    log.info(f'Snapshot done — {len(all_variants)} active, {archived_count} archived skipped')

    # Fetching nothing is a fault, never a result. Guarding here as well as per-page means no
    # future failure mode can quietly hand the importer an empty catalogue to write.
    if not all_variants:
        raise RuntimeError(
            'Snapshot fetched 0 active variants. The catalogue is not empty, so this is a '
            'read failure - check the Shopify token and the API response above.')

    # ── Test mode: restrict to one product ───────────────────────────────────
    if test_gati:
        prefix_filter = test_gati.upper().strip() + '|'
        all_variants  = [v for v in all_variants
                         if (v.get('sku') or '').upper().startswith(prefix_filter)]
        log.info(f'TEST MODE — filtered to GATI {test_gati.upper()}: {len(all_variants)} variants')

    # ── Phase 2: recalculate prices ───────────────────────────────────────────
    rows            = []
    no_weight       = []
    excluded        = []
    products_seen   = set()
    gemstone_priced = 0   # variants carrying a non-zero gemstone value
    already_done    = 0   # priced by an earlier attempt of THIS run — see below
    run_date        = datetime.now().strftime('%Y-%m-%d')

    # Normalise exclusion list once (uppercase, stripped)
    _excluded_ids = {g.upper().strip() for g in STATIC_PRICE_GATI_IDS}

    for v in all_variants:
        sku   = (v.get('sku') or '').strip()
        parts = sku.split('|')

        # Skip static-price items (silver coins, fixed-rate products, etc.)
        gati_id = parts[0].strip().upper() if parts else ''
        if gati_id in _excluded_ids:
            excluded.append(sku)
            continue

        # Determine karat from SKU position 3 (e.g. "24", "22", "18", or "14")
        karat_part = parts[2].strip() if len(parts) > 2 else ''
        if '24' in karat_part:
            gold_rate_used, karat_label = rate_24k, '24K'
        elif '22' in karat_part:
            gold_rate_used, karat_label = rate_22k, '22K'
        elif '14' in karat_part:
            gold_rate_used, karat_label = rate_14k, '14K'
        else:
            gold_rate_used, karat_label = rate_18k, '18K'

        net_wt   = _mf_float(v, 'wt')
        gross_wt = _mf_float(v, 'gross') or net_wt   # fall back to net if not stored
        diamond  = _mf_float(v, 'dia')
        making   = _mf_float(v, 'make')
        gemstone = _mf_float(v, 'gem')   # 0 when the variant carries no gemstone value

        if net_wt == 0:
            prod = v.get('product') or {}
            no_weight.append({
                'run_date':       run_date,
                'gati_id':        gati_id,
                'sku':            sku,
                'variant_id':     _numeric_id(v.get('id', '')),
                'product_title':  prod.get('title', ''),
                'product_status': prod.get('status', ''),
                'karat':          karat_label,
                # gross_wt fell back to net (0) above, so read the raw metafield here —
                # a non-zero gross with zero net means the fix is just copying it across
                'gross_weight_g': _mf_float(v, 'gross'),
                'diamond_cost':   diamond,
                'making_cost':    making,
                'admin_url':      _admin_url(prod.get('id', ''), v.get('id', '')),
            })
            continue

        # ── Resume without a progress file ────────────────────────────────────
        # If this variant already carries THIS run's stamp, an earlier attempt priced it and was
        # then killed. Skip it: the numbers would be byte-identical, and re-writing them costs a
        # Shopify call each while the remaining work waits.
        #
        # The marker lives in Shopify and the run id lives in Supabase, so this survives anything
        # that happens to the container — which matters because /data was never mounted and the
        # progress log the importer keeps has therefore never survived a single deploy.
        #
        # A CHANGED rate produces a different set_at, so nothing matches and the whole catalogue
        # re-prices, which is exactly what should happen.
        # Compare the first 19 chars ("YYYY-MM-DDTHH:MM:SS") rather than the whole string. Shopify
        # returned date_time metafields verbatim when this was checked, but a normalisation of
        # "+00:00" to "Z" would silently break the match — and a silently-not-resuming resume is
        # indistinguishable from a working one until it wastes two hours.
        if gold_updated_at and (_mf_str(v, 'done')[:19] == gold_updated_at[:19]):
            already_done += 1
            continue

        # Taxable value = gold + diamond + making + gemstone. Gemstone is a
        # component in its own right; leaving it out understates both the price
        # and the GST charged on it.
        gold     = round(net_wt * gold_rate_used, p)
        subtotal = round(gold + diamond + making + gemstone, p)
        gst      = round(subtotal * GST_RATE, p)
        total    = round(subtotal + gst, p)

        if gemstone > 0:
            gemstone_priced += 1

        prefix     = '|'.join(parts[:3]) if len(parts) >= 3 else sku
        product_id = (v.get('product') or {}).get('id', '')
        products_seen.add(product_id)

        rows.append({
            'shopify_variant_id':         v['id'],
            'shopify_sku':                sku,
            'search_prefix':              prefix,
            'price_to_write':             total,
            'grams_to_write':             net_wt,
            'mf_net_metal_weight_g':      net_wt,
            'mf_total_metal_weight_g':    gross_wt,
            'mf_price_breakup_gold':      gold,
            'mf_price_breakup_diamond':   diamond,
            'mf_price_breakup_making':    making,
            'mf_price_breakup_gemstone':  gemstone,
            'mf_price_breakup_gst':       gst,
            'mf_price_total':             total,
            'mf_price_subtotal':          subtotal,
            'mf_gold_rate':               round(gold_rate_used, 2),
            'mf_gold_last_updated_at':    gold_updated_at,
        })

    # ── Write preview CSV ─────────────────────────────────────────────────────
    output_csv.parent.mkdir(parents=True, exist_ok=True)
    with open(output_csv, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=_COLS)
        writer.writeheader()
        writer.writerows(rows)

    log.info(f'Preview CSV written — {len(rows)} rows → {output_csv.name}')
    if already_done:
        log.info(f'  RESUMED — {already_done} variant(s) already carried this run\'s stamp '
                 f'({gold_updated_at}) and were skipped. Only {len(rows)} remain to write.')
    # Sanity signal for the gemstone component: if this is 0 on a run that should
    # have gemstone pieces, GEMSTONE_MF_KEY is pointing at the wrong metafield.
    log.info(f'  {gemstone_priced} of {len(rows)} priced variants carry a gemstone value '
             f'(custom.{GEMSTONE_MF_KEY})')

    if excluded:
        log.info(f'  {len(excluded)} variants excluded (static-price list): {excluded[:5]}{"..." if len(excluded) > 5 else ""}')

    # Write full no-weight list to a dated CSV so it can be reviewed after the run
    no_weight_csv = None
    if no_weight:
        no_weight.sort(key=lambda r: (r['gati_id'], r['sku']))
        stem = output_csv.stem.replace('PREVIEW_VARIANT_IMPORT_', '').replace('_v2', '')
        no_weight_csv = output_csv.parent / f'SKIPPED_NO_WEIGHT_{stem}.csv'
        with open(no_weight_csv, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=_NO_WEIGHT_COLS)
            writer.writeheader()
            writer.writerows(no_weight)
        log.warning(f'  {len(no_weight)} variants skipped (no net_metal_weight_g): full list → {no_weight_csv.name}')

    return {
        'variants_in_snapshot':  len(all_variants),
        'variants_priced':       len(rows),
        'variants_with_gemstone': gemstone_priced,
        'variants_no_weight':    len(no_weight),
        'variants_excluded':     len(excluded),
        'variants_already_done': already_done,
        'archived_skipped':      archived_count,
        'products_covered':      len(products_seen),
        'preview_csv':           str(output_csv),
        'no_weight_csv':         str(no_weight_csv) if no_weight_csv else '',
        'no_weight_rows':        no_weight,
    }
