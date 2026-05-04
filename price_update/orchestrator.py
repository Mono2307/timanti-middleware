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
    STORE_DOMAIN, GOLD_RATE_MAX_AGE_HOURS,
    RATIO_18K, RATIO_14K,
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
    url     = f'{SUPABASE_URL}/rest/v1/config?key=eq.gold_rate&select=value'
    headers = {'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}'}
    try:
        r = _req.get(url, headers=headers, timeout=10)
        r.raise_for_status()
        rows = r.json()
        if not rows:
            return None
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

    rate_18k = round(pure * RATIO_18K, 2)
    rate_14k = round(pure * RATIO_14K, 2)

    log.info(f'Gold rate ({source}) — pure: Rs {pure:,.0f}/g | 18K: Rs {rate_18k:,.2f}/g | 14K: Rs {rate_14k:,.2f}/g')
    log.info(f'Rate age  — {age_h:.1f}h (set {set_at})')

    return {
        'pure':     pure,
        '18k':      rate_18k,
        '14k':      rate_14k,
        'set_at':   set_at,
        'age_hours': age_h,
        'ratio_18k': RATIO_18K,
        'ratio_14k': RATIO_14K,
    }


# ── Step 4: run the Node importer ─────────────────────────────────────────────

def _run_importer(token: str, preview_csv: Path, log: logging.Logger) -> dict:
    env = {
        **os.environ,
        'ADMIN_API_TOKEN': token,
        'STORE_DOMAIN':    STORE_DOMAIN,
    }

    log.info(f'Importer starting — {preview_csv.name}')
    t0 = time.time()

    proc = subprocess.Popen(
        ['node', str(IMPORT_SCRIPT),
         '--input',     str(preview_csv),
         '--no-resume'],
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

def run(test_gati: str = None):
    """
    Run the full price update pipeline.
    Call this directly from code (e.g. gold_rate_form) or use main() for CLI.
    test_gati: restrict to a single GATI ID (e.g. 'RG00001'), or None for all.
    """
    if test_gati:
        test_gati = test_gati.upper().strip()

    run_id   = datetime.now().strftime('%Y%m%d_%H%M%S')
    log_path = LOGS_DIR / f'daily_price_update_{run_id}.log'
    log      = _setup_logging(log_path)

    log.info('=' * 70)
    run_label = f'TEST RUN ({test_gati})' if test_gati else 'DAILY PRICE UPDATE'
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
        log.info(f'  18K rate  : Rs {gold_rate["18k"]:>10,.2f} / gram')
        log.info(f'  14K rate  : Rs {gold_rate["14k"]:>10,.2f} / gram')
        log.info(f'  Rate set  : {gold_rate.get("set_at", "")[:16].replace("T", " ")} UTC')
        log.info('-' * 70)

        # 3. Snapshot + price recalculation
        from shopify_snapshot import build_snapshot
        today       = datetime.now().strftime('%Y%m%d')
        preview_csv = OUTPUTS / f'PREVIEW_VARIANT_IMPORT_{today}_v2.csv'

        log.info(f'Building snapshot → {preview_csv.name}')
        snapshot_stats = build_snapshot(token, gold_rate, preview_csv, log,
                                        test_gati=test_gati)

        log.info(
            f'Snapshot summary — '
            f'{snapshot_stats["variants_priced"]:,} priced, '
            f'{snapshot_stats["products_covered"]} products, '
            f'{snapshot_stats["archived_skipped"]} archived skipped, '
            f'{snapshot_stats["variants_no_weight"]} missing weight'
        )

        # 4. Import to Shopify
        import_stats = _run_importer(token, preview_csv, log)

        # 5. Emails
        from notifier import send_run_report, send_rates_confirmation
        log.info('Sending emails...')
        send_run_report(gold_rate, snapshot_stats, import_stats, run_id, log_path,
                        is_test=bool(test_gati), test_gati=test_gati or '')
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
    args = parser.parse_args()

    if args.rate_override:
        import json
        data = {'pure': args.rate_override,
                'set_at': datetime.now(timezone.utc).isoformat()}
        GOLD_RATE_FILE.write_text(json.dumps(data, indent=2), encoding='utf-8')
        print(f'Gold rate set to Rs {args.rate_override:,.0f}/g')

    try:
        run(test_gati=args.test_gati)
    except Exception:
        sys.exit(1)


if __name__ == '__main__':
    main()
