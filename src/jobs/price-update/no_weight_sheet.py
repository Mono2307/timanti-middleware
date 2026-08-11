"""
no_weight_sheet.py
==================
Pushes the daily "skipped — no net metal weight" list to a Google Sheet via an
Apps Script web app (same pattern as PO Ops: no service account needed).

The sheet is a SNAPSHOT, not a log — each run replaces the whole tab, so the
sheet always shows exactly what today's run could not price. Staff fix the
weight in Shopify, and the row disappears from tomorrow's sheet.

Set NO_WEIGHT_SHEET_URL to the deployed Apps Script web app URL.
Deployment instructions: no_weight_sheet.gs.txt

Called by orchestrator.py — not run directly.
"""

import json
import logging

import requests

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from config import NO_WEIGHT_SHEET_URL, NO_WEIGHT_SHEET_CHUNK

# Column order must match COLUMNS in no_weight_sheet.gs.txt
COLUMNS = [
    'run_date', 'gati_id', 'sku', 'variant_id',
    'product_title', 'product_status', 'karat',
    'gross_weight_g', 'diamond_cost', 'making_cost', 'admin_url',
]


def _post(payload: dict, timeout: int = 60) -> dict:
    # Apps Script web apps answer with a 302 to googleusercontent; requests
    # follows it, which is what we want.
    r = requests.post(NO_WEIGHT_SHEET_URL, data=json.dumps(payload),
                      headers={'Content-Type': 'application/json'},
                      timeout=timeout)
    r.raise_for_status()
    try:
        return r.json()
    except ValueError:
        raise RuntimeError(f'Non-JSON reply from Apps Script: {r.text[:200]}')


def push_no_weight(rows: list, run_id: str, log: logging.Logger) -> dict:
    """
    Replace the sheet tab with `rows`. Returns a small result dict; never raises
    — a Sheets outage must not fail the price run, which has already succeeded
    by the time this is called.
    """
    if not NO_WEIGHT_SHEET_URL:
        log.info('No-weight sheet — NO_WEIGHT_SHEET_URL not set, skipping push')
        return {'pushed': False, 'reason': 'not_configured'}

    try:
        # Chunked so a large list can't blow the Apps Script request limit.
        # First chunk clears the tab; the rest append to it.
        total = len(rows)
        sent  = 0
        for i in range(0, max(total, 1), NO_WEIGHT_SHEET_CHUNK):
            chunk = [[r.get(c, '') for c in COLUMNS]
                     for r in rows[i:i + NO_WEIGHT_SHEET_CHUNK]]
            res = _post({
                'action':  'replace' if i == 0 else 'append',
                'run_id':  run_id,
                'columns': COLUMNS,
                'rows':    chunk,
            })
            if not res.get('ok'):
                raise RuntimeError(res.get('error', 'unknown Apps Script error'))
            sent += len(chunk)

        url = res.get('sheet_url', '')
        log.info(f'No-weight sheet — {sent:,} rows pushed{" → " + url if url else ""}')
        return {'pushed': True, 'rows': sent, 'sheet_url': url}

    except Exception as e:
        log.error(f'No-weight sheet push failed (run otherwise unaffected): {e}')
        return {'pushed': False, 'reason': str(e)}
