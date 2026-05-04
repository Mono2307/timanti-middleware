"""
shopify_snapshot.py
===================
Pages through ALL live Shopify variants (ACTIVE + DRAFT, skips ARCHIVED).
Reads stored metafields: net weight, gross weight, diamond cost, making cost.
Recalculates gold component + GST using the day's gold rate.
Writes the preview CSV that import_from_preview.mjs consumes.

Called by orchestrator.py — not run directly.
"""

import csv
import time
import logging
import requests
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).parent))
from config import STORE_DOMAIN, API_VERSION, GST_RATE, DECIMAL_PRECISION

# ── GraphQL query — fetches 250 variants per page with all needed metafields ──

_Q = """
query($cursor: String) {
  productVariants(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      sku
      product { id status }
      wt:    metafield(namespace: "custom", key: "net_metal_weight_g")    { value }
      gross: metafield(namespace: "custom", key: "total_metal_weight_g")  { value }
      dia:   metafield(namespace: "custom", key: "price_breakup_diamond") { value }
      make:  metafield(namespace: "custom", key: "price_breakup_making")  { value }
    }
  }
}
"""

_COLS = [
    'shopify_variant_id', 'shopify_sku', 'search_prefix',
    'price_to_write', 'grams_to_write',
    'mf_net_metal_weight_g', 'mf_total_metal_weight_g',
    'mf_price_breakup_gold', 'mf_price_breakup_diamond',
    'mf_price_breakup_making', 'mf_price_breakup_gst',
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
        errors = j.get('errors', [])
        throttled = available == 0 or any(
            e.get('extensions', {}).get('code') == 'THROTTLED' for e in errors
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


def _mf_float(node, key):
    obj = node.get(key)
    if not obj:
        return 0.0
    try:
        return float(obj.get('value') or 0)
    except (ValueError, TypeError):
        return 0.0


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
        res        = _gql(url, headers, _Q, variables, log)
        page       = res.get('data', {}).get('productVariants', {})
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

    # ── Test mode: restrict to one product ───────────────────────────────────
    if test_gati:
        prefix_filter = test_gati.upper().strip() + '|'
        all_variants  = [v for v in all_variants
                         if (v.get('sku') or '').upper().startswith(prefix_filter)]
        log.info(f'TEST MODE — filtered to GATI {test_gati.upper()}: {len(all_variants)} variants')

    # ── Phase 2: recalculate prices ───────────────────────────────────────────
    rows          = []
    no_weight     = []
    products_seen = set()

    for v in all_variants:
        sku   = (v.get('sku') or '').strip()
        parts = sku.split('|')

        # Determine karat from SKU position 3 (e.g. "18" or "14")
        karat_part     = parts[2].strip() if len(parts) > 2 else ''
        gold_rate_used = rate_14k if '14' in karat_part else rate_18k

        net_wt   = _mf_float(v, 'wt')
        gross_wt = _mf_float(v, 'gross') or net_wt   # fall back to net if not stored
        diamond  = _mf_float(v, 'dia')
        making   = _mf_float(v, 'make')

        if net_wt == 0:
            no_weight.append(sku)
            continue

        gold     = round(net_wt * gold_rate_used, p)
        subtotal = round(gold + diamond + making, p)
        gst      = round(subtotal * GST_RATE, p)
        total    = round(subtotal + gst, p)

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

    if no_weight:
        sample = no_weight[:5]
        more   = f' ... +{len(no_weight) - 5} more' if len(no_weight) > 5 else ''
        log.warning(f'  {len(no_weight)} variants skipped (no net_metal_weight_g stored): {sample}{more}')

    return {
        'variants_in_snapshot': len(all_variants),
        'variants_priced':      len(rows),
        'variants_no_weight':   len(no_weight),
        'archived_skipped':     archived_count,
        'products_covered':     len(products_seen),
        'preview_csv':          str(output_csv),
    }
