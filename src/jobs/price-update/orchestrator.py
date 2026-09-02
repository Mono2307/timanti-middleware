"""
orchestrator.py
===============
Master runner for the daily AuraCarat price update.

Pipeline:
  1. Fetch Shopify token from Supabase (single source of truth)
  2. Load and validate gold_rate.json (aborts if stale > 20h)
  3. Page all live Shopify variants → recalculate prices → write preview CSV
  4. Run import_from_preview.mjs on that CSV (price + metafields)
  5. Send result emails via Resend

Run via Task Scheduler at 12:00 AM:
  python orchestrator.py

Or manually:
  cd Scripts/daily_price_update
  python orchestrator.py
"""

import argparse
import json
import logging
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from config import (
    BASE, OUTPUTS, LOGS_DIR, SCRIPTS,
    GOLD_RATE_FILE, IMPORT_SCRIPT,
    SUPABASE_URL, SUPABASE_KEY, SUPABASE_TOKEN_KEY,
    STORE_DOMAIN, API_VERSION, GOLD_RATE_MAX_AGE_HOURS,
    RATIO_18K, RATIO_14K, RATIO_22K, RATIO_24K,
)


# ── Logging setup ─────────────────────────────────────────────────────────────

def _setup_logging(log_path: Path) -> logging.Logger:
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    fmt    = logging.Formatter('[%(asctime)s] %(levelname)-5s  %(message)s', '%Y-%m-%d %H:%M:%S')
    logger = logging.getLogger('daily_update')
    logger.setLevel(logging.DEBUG)
    logger.handlers.clear()

    fh = logging.FileHandler(log_path, encoding='utf-8')
    fh.setFormatter(fmt)
    logger.addHandler(fh)

    ch = logging.StreamHandler(sys.stdout)
    ch.setFormatter(fmt)
    logger.addHandler(ch)

    return logger


# ── Step 1: fetch token from Supabase ─────────────────────────────────────────

def _fetch_token(log: logging.Logger) -> str:
    import requests as _req
    url     = f'{SUPABASE_URL}/rest/v1/config?key=eq.{SUPABASE_TOKEN_KEY}&select=value'
    headers = {'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}'}
    log.info('Fetching Shopify token from Supabase...')
    try:
        r = _req.get(url, headers=headers, timeout=10)
        r.raise_for_status()
        rows = r.json()
        if not rows:
            raise ValueError(f'No row found for key="{SUPABASE_TOKEN_KEY}" in Supabase config table')
        token = rows[0]['value'].strip()
        log.info('Token fetched OK')
        return token
    except Exception as e:
        raise RuntimeError(f'Supabase token fetch failed: {e}') from e


# ── Supabase gold rate helpers ────────────────────────────────────────────────

def save_gold_rate_supabase(pure: float, set_at: str):
    """Upsert gold rate into the Supabase config table."""
    import requests as _req
    payload = json.dumps({'pure': pure, 'set_at': set_at})
    url     = f'{SUPABASE_URL}/rest/v1/config'
    headers = {
        'apikey':        SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates',
    }
    r = _req.post(url, headers=headers,
                  data=json.dumps({'key': 'gold_rate', 'value': payload}),
                  timeout=10)
    r.raise_for_status()


def _fetch_gold_rate_supabase(log: logging.Logger):
    """Read gold rate from Supabase. Returns parsed dict or None on any failure."""
    import requests as _req
    # ORDER BY, and take the newest. This used to select 'value' with no ordering and read
    # rows[0], which is whatever Postgres happened to return first. The trigger route upserts
    # this key, and if the table ever holds more than one gold_rate row - which the route
    # cannot rule out, because it reads with .maybeSingle() and treats the resulting
    # "multiple rows" error as "no previous rate" - then rows[0] is the OLDEST row, and the
    # job reads a stale rate forever while the form appears to work perfectly.
    #
    # That is not a hypothetical failure: set_at doubles as the RUN ID, so a stale set_at
    # makes the snapshot believe every variant already carries this run's stamp. It skips
    # the entire catalogue, writes nothing, and reports "0 variants" with no error anywhere.
    url     = (f'{SUPABASE_URL}/rest/v1/config?key=eq.gold_rate'
               f'&select=value,updated_at&order=updated_at.desc')
    headers = {'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}'}
    try:
        r = _req.get(url, headers=headers, timeout=10)
        r.raise_for_status()
        rows = r.json()
        if not rows:
            return None
        if len(rows) > 1:
            log.error(
                f'{len(rows)} gold_rate rows in Supabase config - reading the newest '
                f'({rows[0].get("updated_at")}) and IGNORING {len(rows) - 1} older one(s). '
                f'The config table needs a unique constraint on "key"; until it has one the '
                f'trigger route can keep inserting duplicates instead of updating.')
        return json.loads(rows[0]['value'])
    except Exception as e:
        log.warning(f'Supabase gold rate fetch failed: {e}')
        return None


# ── Step 2: load and validate gold rate ──────────────────────────────────────

def _load_gold_rate(log: logging.Logger) -> dict:
    data   = _fetch_gold_rate_supabase(log)
    source = 'Supabase'
    if data is None:
        source = 'local file'
        if not GOLD_RATE_FILE.exists():
            raise RuntimeError(
                'Gold rate not found in Supabase or local file. '
                'Set it via the Google Form or http://localhost:5050 before running.'
            )
        data = json.loads(GOLD_RATE_FILE.read_text(encoding='utf-8'))

    pure   = float(data['pure'])
    set_at = data.get('set_at', '')
    mode   = str(data.get('mode', 'auto')).strip().lower()

    # Manual 18kt/14kt rates from the form (entered directly by staff, never derived)
    def _opt_float(v):
        try:
            return float(v) if v not in (None, '') else None
        except (TypeError, ValueError):
            return None
    manual_18k = _opt_float(data.get('r18k'))
    manual_14k = _opt_float(data.get('r14k'))

    try:
        sa = datetime.fromisoformat(set_at)
        if sa.tzinfo is None:
            sa = sa.replace(tzinfo=timezone.utc)
        age_h = (datetime.now(timezone.utc) - sa).total_seconds() / 3600
        if age_h > GOLD_RATE_MAX_AGE_HOURS:
            raise RuntimeError(
                f'Gold rate is {age_h:.1f}h old (limit: {GOLD_RATE_MAX_AGE_HOURS}h). '
                f'Please update it via the Google Form or http://localhost:5050 before running.'
            )
    except RuntimeError:
        raise
    except Exception:
        age_h = 0.0
        log.warning('Could not parse gold rate timestamp — proceeding anyway')

    # 22K and 24K are always derived from pure. 18K and 14K are used as entered
    # only when the form is set to manual mode AND both rates are provided.
    rate_22k = round(pure * RATIO_22K, 2)
    rate_24k = round(pure * RATIO_24K, 2)

    if mode == 'manual' and manual_18k is not None and manual_14k is not None:
        calc_mode = 'manual'
        rate_18k  = round(manual_18k, 2)
        rate_14k  = round(manual_14k, 2)
    else:
        calc_mode = 'auto'
        rate_18k  = round(pure * RATIO_18K, 2)
        rate_14k  = round(pure * RATIO_14K, 2)
        if mode == 'manual':
            log.warning('Mode=manual but 18kt/14kt not both provided — falling back to auto calculation')

    log.info(f'Gold rate ({source}, {calc_mode}) — pure: Rs {pure:,.0f}/g | 24K: Rs {rate_24k:,.2f}/g | 22K: Rs {rate_22k:,.2f}/g | 18K: Rs {rate_18k:,.2f}/g | 14K: Rs {rate_14k:,.2f}/g')
    log.info(f'Rate age  — {age_h:.1f}h (set {set_at})')

    return {
        'pure':      pure,
        '18k':       rate_18k,
        '14k':       rate_14k,
        '22k':       rate_22k,
        '24k':       rate_24k,
        'mode':      calc_mode,
        'set_at':    set_at,
        'age_hours': age_h,
        'ratio_18k': RATIO_18K,
        'ratio_14k': RATIO_14K,
        'ratio_22k': RATIO_22K,
        'ratio_24k': RATIO_24K,
    }


# ── Step 4: run the Node importer ─────────────────────────────────────────────

def _run_importer(token: str, preview_csv: Path, log: logging.Logger,
                  resume: bool = False) -> dict:
    env = {
        **os.environ,
        'ADMIN_API_TOKEN': token,
        'STORE_DOMAIN':    STORE_DOMAIN,
        'OUTPUTS_DIR':     str(OUTPUTS),
    }

    log.info(f'Importer starting — {preview_csv.name}  (resume={resume})')
    t0 = time.time()

    args = ['node', str(IMPORT_SCRIPT), '--input', str(preview_csv)]
    if not resume:
        args.append('--no-resume')

    proc = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
        cwd=str(SCRIPTS),
    )

    output_lines: list[str] = []
    for raw_line in proc.stdout:
        line = raw_line.rstrip()
        output_lines.append(line)
        if line.strip():
            log.info(f'  [importer] {line}')

    proc.wait()
    duration = time.time() - t0

    if proc.returncode != 0:
        log.error(f'Importer exited with code {proc.returncode}')

    full = '\n'.join(output_lines)

    def _pi(pattern):
        m = re.search(pattern, full, re.IGNORECASE)
        return int(m.group(1)) if m else 0

    written = _pi(r'Variants written\s*:\s*(\d+)')
    skipped = _pi(r'Skipped[^\n]*:\s*(\d+)')
    errors  = _pi(r'Errors\s*:\s*(\d+)')

    log.info(f'Importer done — written={written:,}  skipped={skipped}  errors={errors}  {_fmt_dur(duration)}')

    return {
        'variants_written': written,
        'archived_skipped': skipped,
        'errors':           errors,
        'duration_seconds': duration,
        'exit_code':        proc.returncode,
    }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _fmt_dur(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    return f'{m}m {s}s'



# ── Post-import verification ─────────────────────────────────────────────────
# The import leaves the API's cost bucket empty, so verification waits for it to refill
# before starting and retries rather than giving up on the first refusal.
VERIFY_SETTLE_SECONDS = 20
VERIFY_MAX_RETRIES    = 5
_VERIFY_Q = """
query($cursor: String) {
  productVariants(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id sku price
      product { status }
      tot: metafield(namespace: "custom", key: "price_total") { value }
    }
  }
}
"""


def verify_prices(token: str, log: logging.Logger, out_dir: Path, run_id: str):
    """Re-read the catalogue and assert the price charged equals price_total.

    Phase 2 writes the price and Phase 3 writes the breakup. A run that dies
    between them leaves a variant whose metafields are self-consistent at the
    PREVIOUS rate sitting under a price at the CURRENT one - nothing about that
    set looks wrong on inspection, so it has to be caught by comparing the two.

    Returns (mismatch_count, csv_path_or_empty).
    """
    import csv as _csv
    import json as _json
    import urllib.request as _url

    endpoint = f'https://{STORE_DOMAIN}/admin/api/{API_VERSION}/graphql.json'

    # The importer has just spent the cost budget on ~4,000 metafield writes. Opening a
    # 60-page pagination the instant it stops guarantees the first call is throttled, and
    # this path used to turn that into "verification could not run" - which then produced
    # an alert asserting the catalogue was wrong without a single variant being compared.
    time.sleep(VERIFY_SETTLE_SECONDS)

    def _q(cursor, attempt=0):
        body = _json.dumps({'query': _VERIFY_Q,
                            'variables': {'cursor': cursor}}).encode()
        req = _url.Request(endpoint, data=body, method='POST', headers={
            'X-Shopify-Access-Token': token, 'Content-Type': 'application/json'})
        try:
            with _url.urlopen(req, timeout=120) as r:
                out = _json.loads(r.read().decode())
        except Exception:
            if attempt >= VERIFY_MAX_RETRIES:
                raise
            time.sleep(3 * (attempt + 1))
            return _q(cursor, attempt + 1)

        errs = out.get('errors') or []
        throttled = any((e.get('extensions') or {}).get('code') == 'THROTTLED'
                        for e in errs if isinstance(e, dict))

        # Retry anything that came back without data, not only an explicit THROTTLED.
        # A response with errors and no data is a failed call whatever its label.
        if (throttled or not out.get('data')) and attempt < VERIFY_MAX_RETRIES:
            time.sleep(4 * (attempt + 1))
            return _q(cursor, attempt + 1)
        if errs and not out.get('data'):
            raise RuntimeError(_json.dumps(errs)[:300])

        # Pace off the remaining budget the way repair_stale_metafields.py already does,
        # so a long pagination does not walk straight back into the throttle it just
        # backed away from.
        cost = ((out.get('extensions') or {}).get('cost') or {}).get('throttleStatus') or {}
        if cost.get('currentlyAvailable', 999) < 200:
            time.sleep(2)

        return out['data']['productVariants']

    bad, seen, cursor = [], 0, None
    while True:
        page = _q(cursor)
        for n in page['nodes']:
            if (n.get('product') or {}).get('status') == 'ARCHIVED':
                continue
            seen += 1
            tot_obj = n.get('tot') or {}
            try:
                tot = float((tot_obj.get('value') or '').strip())
                price = float(n.get('price'))
            except (TypeError, ValueError):
                continue
            if abs(tot - price) > 0.01:
                bad.append({'sku': n.get('sku', ''),
                            'variant_id': (n.get('id') or '').rsplit('/', 1)[-1],
                            'price_charged': price, 'price_total_metafield': tot,
                            'gap': round(tot - price, 2)})
        if not page['pageInfo']['hasNextPage']:
            break
        cursor = page['pageInfo']['endCursor']

    log.info(f'Verification — {seen:,} live variants checked, {len(bad)} mismatched')
    if not bad:
        return 0, ''

    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f'PRICE_MISMATCH_{run_id}.csv'
    with open(path, 'w', newline='', encoding='utf-8') as f:
        w = _csv.DictWriter(f, fieldnames=['sku', 'variant_id', 'price_charged',
                                           'price_total_metafield', 'gap'])
        w.writeheader()
        w.writerows(sorted(bad, key=lambda r: -abs(r['gap'])))
    log.error(f'  {len(bad)} variants carry a breakup that contradicts the price '
              f'charged -> {path.name}')
    return len(bad), str(path)


def _write_summary(run_id, gold_rate, snapshot_stats, import_stats, log_path):
    summary = {
        'run_id':    run_id,
        'gold_rate': gold_rate,
        'snapshot':  snapshot_stats,
        'import':    import_stats,
        'log_file':  str(log_path),
    }
    path = LOGS_DIR / f'daily_price_update_{run_id[:8]}.summary.json'
    path.write_text(json.dumps(summary, indent=2), encoding='utf-8')
    return path


# ── Core pipeline (callable directly or via CLI) ──────────────────────────────

def run(test_gati: str = None, dry_run: bool = False):
    """
    Run the full price update pipeline.
    Call this directly from code (e.g. gold_rate_form) or use main() for CLI.
    test_gati: restrict to a single GATI ID (e.g. 'RG00001'), or None for all.
    dry_run:   build the preview CSV and stop — nothing is written to Shopify
               and no email is sent. Use it to eyeball the price breakup
               (gold / diamond / making / gemstone / GST) before a live run.
    """
    if test_gati:
        test_gati = test_gati.upper().strip()

    run_id   = datetime.now().strftime('%Y%m%d_%H%M%S')
    log_path = LOGS_DIR / f'daily_price_update_{run_id}.log'
    log      = _setup_logging(log_path)

    log.info('=' * 70)
    run_label = f'TEST RUN ({test_gati})' if test_gati else 'DAILY PRICE UPDATE'
    if dry_run:
        run_label += '  [DRY RUN — no writes to Shopify]'
    log.info(f'AURACARAT {run_label}  —  RUN {run_id}')
    log.info('=' * 70)

    gold_rate      = None
    snapshot_stats = {}
    import_stats   = {}

    try:
        # 1. Token
        token = _fetch_token(log)

        # 2. Gold rate
        gold_rate = _load_gold_rate(log)

        log.info('-' * 70)
        log.info(f'  GOLD RATES FOR THIS RUN')
        log.info(f'  Pure gold : Rs {gold_rate["pure"]:>10,.0f} / gram')
        log.info(f'  24K rate  : Rs {gold_rate["24k"]:>10,.2f} / gram')
        log.info(f'  22K rate  : Rs {gold_rate["22k"]:>10,.2f} / gram')
        log.info(f'  18K rate  : Rs {gold_rate["18k"]:>10,.2f} / gram')
        log.info(f'  14K rate  : Rs {gold_rate["14k"]:>10,.2f} / gram')
        log.info(f'  Calc mode : {gold_rate.get("mode", "auto").upper()} (18K/14K {"entered manually" if gold_rate.get("mode") == "manual" else "derived from pure"})')
        log.info(f'  Rate set  : {gold_rate.get("set_at", "")[:16].replace("T", " ")} UTC')
        log.info('-' * 70)

        # 3. Snapshot + price recalculation
        from shopify_snapshot import build_snapshot
        today       = datetime.now().strftime('%Y%m%d')

        # Test and dry runs get their own filename. They cover a fraction of the
        # catalogue, so writing them to the production name would leave a stub CSV
        # that the day's real run then "resumes" from — pricing only that fraction
        # and silently skipping everything else.
        # The production CSV is keyed by the RUN, not the day.
        #
        # It used to be PREVIEW_VARIANT_IMPORT_{today}_v2.csv. A SECOND rate submitted on the same
        # day therefore found the FIRST run's CSV, set resuming=True, skipped the snapshot entirely,
        # and then hit the first run's progress log (named off the same CSV stem) listing every
        # variant as already done. Net effect: it priced nothing, reported "0 variants updated",
        # and SILENTLY DISCARDED THE NEW RATE. The rate was saved in Supabase, so everything looked
        # healthy while the catalogue stayed on the earlier price.
        #
        # Observed 2026-08-21: 10:58 IST submitted 16147 and applied it; 15:03 IST submitted 16284
        # and applied nothing. Gold had risen, so the store was underpricing every live item until
        # someone noticed the zero in the report.
        #
        # set_at is the run id (see /api/trigger-price-update), so keying on it gives both
        # behaviours for free: re-submitting the SAME rate reuses set_at, finds the same CSV and
        # correctly resumes an interrupted run; a DIFFERENT rate gets a new set_at, finds no CSV,
        # and correctly rebuilds the snapshot.
        run_tag = re.sub(r'\D', '', str(gold_rate.get('set_at') or ''))[8:14] or run_id
        if dry_run or test_gati:
            tag         = '_'.join(x for x in ('DRYRUN' if dry_run else 'TEST', test_gati) if x)
            preview_csv = OUTPUTS / f'PREVIEW_VARIANT_IMPORT_{today}_{tag}_{run_id}_v2.csv'
        else:
            preview_csv = OUTPUTS / f'PREVIEW_VARIANT_IMPORT_{today}_r{run_tag}_v2.csv'

        # THE SNAPSHOT ALWAYS RUNS. A file on disk is no longer a reason to skip it.
        #
        # Resume is answered by SHOPIFY, not by local files: build_snapshot skips any variant
        # already carrying this run's set_at stamp, and that marker survives restarts, deploys
        # and an empty /app/Outputs. This block used to sit in FRONT of that mechanism and
        # override it - if a CSV with this run's name happened to exist, the snapshot was
        # skipped entirely and the importer was pointed at that file plus its progress log.
        #
        # What that cost, 2026-09-02: the same rate was submitted twice. The second trigger
        # reused the same set_at (by design - identical rate, same UTC day), found the first
        # attempt's CSV still on disk (the machine had not been restarted, so /app/Outputs was
        # intact), skipped the snapshot, and handed the importer a progress log that already
        # listed every variant as done. It wrote nothing and mailed "0 product variants
        # updated" as a SUCCESS, while the catalogue stayed on the previous day's rates.
        #
        # Confirmed by replaying build_snapshot against the live catalogue: a fresh set_at
        # yields 15,106 outstanding variants and the stale one yields 60. Neither yields 0,
        # so a run reporting 0 cannot have called the snapshot at all.
        #
        # Rebuilding costs ~60 paged reads at ~90 cost points each - negligible against a
        # 2,000-point budget - and it makes "what is outstanding" authoritative instead of
        # inferred from files on storage that is thrown away by every deploy.
        resuming = False
        log.info(f'Building snapshot → {preview_csv.name}')
        snapshot_stats = build_snapshot(token, gold_rate, preview_csv, log,
                                        test_gati=test_gati)
        log.info(
            f'Snapshot summary — '
            f'{snapshot_stats["variants_priced"]:,} priced, '
            f'{snapshot_stats["products_covered"]} products, '
            f'{snapshot_stats["archived_skipped"]} archived skipped, '
            f'{snapshot_stats["variants_no_weight"]} missing weight, '
            f'{snapshot_stats.get("variants_with_gemstone", 0):,} with a gemstone value'
        )

        # 0 outstanding is only legitimate when the snapshot says everything already carries
        # THIS run's stamp. Any other route to 0 means the run is about to report success for
        # work it never did, which is the failure this whole block exists to prevent.
        _outstanding = snapshot_stats.get('variants_priced', 0)
        _already     = snapshot_stats.get('variants_already_done', 0)
        if _outstanding == 0 and _already == 0:
            raise RuntimeError(
                'Snapshot produced 0 variants to price and 0 already carrying this run\'s '
                'stamp. That is not a no-op, it is a read that returned nothing - refusing to '
                'report a successful run over it.')
        if _outstanding == 0:
            log.info(f'Nothing outstanding — all {_already:,} variants already carry this '
                     f'run\'s stamp. This run is a no-op by design.')

        if dry_run:
            log.info('=' * 70)
            log.info('DRY RUN COMPLETE — nothing written to Shopify, no email sent')
            log.info(f'  Preview CSV : {preview_csv}')
            log.info('  Check mf_price_breakup_gemstone and mf_price_subtotal in that CSV '
                     'against the product before running live.')
            log.info('=' * 70)
            return

        # 4. Import to Shopify
        import_stats = _run_importer(token, preview_csv, log, resume=resuming)

        # 5. Verify before telling anyone it worked.
        #
        # A run that dies between the price write and the breakup write leaves
        # variants that look fine field by field but whose stored total does not
        # match what the customer is charged. Sending a success mail on top of
        # that is worse than sending nothing, so the check gates the mail.
        log.info('Verifying prices against stored totals...')
        try:
            mismatches, mismatch_csv = verify_prices(
                token, log, preview_csv.parent, run_id)
        except Exception as exc:
            log.error(f'Verification could not run: {exc}')
            mismatches, mismatch_csv = -1, ''
        import_stats['price_mismatches'] = mismatches
        import_stats['mismatch_csv'] = mismatch_csv

        # 6. Emails
        from notifier import send_run_report, send_rates_confirmation, send_alert
        if mismatches != 0:
            written = import_stats.get('variants_written', 0)

            # 0 written is not a failure on its own. The snapshot skips variants already
            # carrying this run's set_at, so re-submitting the SAME rate on the same UTC
            # day resumes the same run and correctly finds nothing outstanding. Say so,
            # because the alert otherwise reads as "the job did nothing" when the real
            # meaning is "there was nothing left to do".
            zero_note = (
                '\n\nNOTE: 0 variants were written because every variant already carries '
                'this run\'s stamp. Re-submitting the SAME rate on the same day resumes '
                'this run and will keep writing nothing. To force a full re-price, submit '
                'a different rate.' if written == 0 else '')

            if mismatches > 0:
                detail = (f'{mismatches:,} variant(s) carry a price breakup that '
                          f'contradicts the price charged.')
                body = (
                    f'{detail}\n\n'
                    f'The price update wrote {written:,} variants. A stored total that '
                    f'disagrees with the live price is the signature of a run interrupted '
                    f'between the price write and the metafield write.\n\n'
                    f'Fix: run repair_stale_metafields.py (no flags = dry run, then '
                    f'--apply).' + zero_note + '\n\n'
                    + (f'Affected variants: {mismatch_csv}' if mismatch_csv else ''))
            else:
                # NOTHING WAS COMPARED. This branch used to send the same body as the one
                # above, asserting that the stored totals disagreed with the live prices -
                # a claim it had no evidence for, because the check it depends on had just
                # failed to run. "I could not look" and "I looked and it is wrong" are
                # different messages and must not share wording.
                detail = 'Post-import verification could not run.'
                body = (
                    f'{detail}\n\n'
                    f'The catalogue has NOT been checked. This is not a report that '
                    f'anything is wrong - it is a report that nothing was verified.\n\n'
                    f'The price update wrote {written:,} variants.' + zero_note + '\n\n'
                    f'To find out whether the catalogue is actually consistent, run '
                    f'repair_stale_metafields.py with no flags - it is a dry run and '
                    f'writes nothing.')

            log.error(f'HOLDING the success mail — {detail}')
            send_alert(body, run_id, gold_rate)
            log.info('Alert sent instead of the run report')
        else:
            log.info('Verification clean — sending emails...')
            send_run_report(gold_rate, snapshot_stats, import_stats, run_id, log_path,
                            is_test=bool(test_gati), test_gati=test_gati or '',
                            no_weight_csv=snapshot_stats.get('no_weight_csv', ''))
            if not test_gati:
                send_rates_confirmation(gold_rate, snapshot_stats, import_stats)
            log.info('Emails sent')

        # 6. Summary JSON
        summary_path = _write_summary(run_id, gold_rate, snapshot_stats, import_stats, log_path)

        log.info('=' * 70)
        status = 'COMPLETE' if import_stats.get('errors', 0) == 0 else 'COMPLETE WITH ERRORS'
        log.info(f'RUN {status}')
        log.info(f'  Variants written : {import_stats.get("variants_written", 0):,}')
        log.info(f'  Products covered : {snapshot_stats.get("products_covered", 0)}')
        log.info(f'  Errors           : {import_stats.get("errors", 0)}')
        log.info(f'  Duration         : {_fmt_dur(import_stats.get("duration_seconds", 0))}')
        log.info(f'  Summary JSON     : {summary_path.name}')
        log.info('=' * 70)

    except Exception as exc:
        log.error(f'FATAL: {exc}', exc_info=True)
        if dry_run:
            # A dry run is an operator sanity check, not the daily job — its
            # failures belong in the console, not in the FATAL alert inbox.
            log.error('Dry run failed — no alert email sent')
            raise
        try:
            from notifier import send_alert
            send_alert(str(exc), run_id, gold_rate)
            log.info('Alert email sent')
        except Exception as mail_err:
            log.error(f'Alert email also failed: {mail_err}')
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--test', dest='test_gati', default=None,
                        help='Run for a single GATI ID only (e.g. RG00001)')
    parser.add_argument('--rate', dest='rate_override', type=float, default=None,
                        help='Pure gold rate in Rs/g — saves to gold_rate.json and runs')
    parser.add_argument('--dry-run', dest='dry_run', action='store_true',
                        help='Build the preview CSV only — no Shopify writes, no email')
    args = parser.parse_args()

    if args.rate_override:
        import json
        data = {'pure': args.rate_override,
                'set_at': datetime.now(timezone.utc).isoformat()}
        GOLD_RATE_FILE.write_text(json.dumps(data, indent=2), encoding='utf-8')
        print(f'Gold rate set to Rs {args.rate_override:,.0f}/g')

    try:
        run(test_gati=args.test_gati, dry_run=args.dry_run)
    except Exception:
        sys.exit(1)


if __name__ == '__main__':
    main()
