"""
notifier.py
===========
Sends emails via Resend.
  Email 1 — full run report        → monodeep.dutta@timanti.in
  Email 2 — rates confirmation     → hsrstore@timanti.in, CC shweta + monodeep
  Alert   — failure notification   → monodeep.dutta@timanti.in

Called by orchestrator.py — not run directly.
"""

import resend
from datetime import datetime
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).parent))
from config import (
    RESEND_API_KEY, FROM_EMAIL,
    EMAIL_RUN_REPORT_TO, EMAIL_RATES_TO, EMAIL_RATES_CC,
)


def _fmt_date():
    now = datetime.now()
    return now.strftime('%d %b %Y').lstrip('0')


def _fmt_duration(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    return f'{m}m {s}s'


def _init():
    resend.api_key = RESEND_API_KEY


# ── Email 1: full run report ──────────────────────────────────────────────────

def send_run_report(gold_rate: dict, snapshot_stats: dict, import_stats: dict,
                    run_id: str, log_path: Path,
                    is_test: bool = False, test_gati: str = ''):
    _init()

    date_str    = _fmt_date()
    written     = import_stats.get('variants_written', 0)
    errors      = import_stats.get('errors', 0)
    duration    = _fmt_duration(import_stats.get('duration_seconds', 0))
    status_icon = '✓' if errors == 0 else '⚠'
    err_colour  = '#27ae60' if errors == 0 else '#c0392b'
    test_banner = (f'<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;'
                   f'padding:10px 16px;margin-bottom:20px;font-size:13px;color:#856404;">'
                   f'<strong>TEST RUN</strong> — product {test_gati} only. '
                   f'No changes made to other variants.</div>') if is_test else ''
    subject_prefix = f'[TEST {test_gati}] ' if is_test else ''

    html = f"""
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
            max-width:560px;color:#1a1a1a;margin:0 auto;">

  {test_banner}
  <h2 style="border-bottom:2px solid #1a1a2e;padding-bottom:10px;color:#1a1a2e;margin-top:0;">
    AuraCarat Price Update — {date_str} {status_icon}
  </h2>

  <h3 style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#888;margin-bottom:8px;">
    Gold Rates Applied
  </h3>
  <table style="border-collapse:collapse;width:100%;margin-bottom:24px;font-size:14px;">
    <tr style="background:#fffbf0;">
      <td style="padding:9px 14px;font-weight:600;">Pure Gold</td>
      <td style="padding:9px 14px;">Rs {gold_rate['pure']:,.0f} / gram</td>
    </tr>
    <tr>
      <td style="padding:9px 14px;font-weight:600;">18K Rate</td>
      <td style="padding:9px 14px;">Rs {gold_rate['18k']:,.2f} / gram</td>
    </tr>
    <tr style="background:#fffbf0;">
      <td style="padding:9px 14px;font-weight:600;">14K Rate</td>
      <td style="padding:9px 14px;">Rs {gold_rate['14k']:,.2f} / gram</td>
    </tr>
  </table>

  <h3 style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#888;margin-bottom:8px;">
    Run Results
  </h3>
  <table style="border-collapse:collapse;width:100%;margin-bottom:24px;font-size:14px;">
    <tr style="background:#f8f9fa;">
      <td style="padding:9px 14px;">Variants updated</td>
      <td style="padding:9px 14px;font-weight:700;font-size:16px;">{written:,}</td>
    </tr>
    <tr>
      <td style="padding:9px 14px;">Products covered</td>
      <td style="padding:9px 14px;">{snapshot_stats.get('products_covered', 0)}</td>
    </tr>
    <tr style="background:#f8f9fa;">
      <td style="padding:9px 14px;">Archived skipped</td>
      <td style="padding:9px 14px;">{snapshot_stats.get('archived_skipped', 0)}</td>
    </tr>
    <tr>
      <td style="padding:9px 14px;">Missing weight (skipped)</td>
      <td style="padding:9px 14px;">{snapshot_stats.get('variants_no_weight', 0)}</td>
    </tr>
    <tr style="background:#f8f9fa;">
      <td style="padding:9px 14px;">Errors</td>
      <td style="padding:9px 14px;font-weight:600;color:{err_colour};">{errors}</td>
    </tr>
    <tr>
      <td style="padding:9px 14px;">Duration</td>
      <td style="padding:9px 14px;">{duration}</td>
    </tr>
  </table>

  <p style="color:#aaa;font-size:11px;border-top:1px solid #eee;padding-top:10px;">
    Run ID: {run_id} &nbsp;·&nbsp; Log: Outputs/logs/{log_path.name}
  </p>
</div>"""

    resend.Emails.send({
        'from':    FROM_EMAIL,
        'to':      EMAIL_RUN_REPORT_TO,
        'subject': f'{subject_prefix}AuraCarat Price Update — {date_str} {status_icon} {written:,} variants',
        'html':    html,
    })


# ── Email 2: rates confirmation ───────────────────────────────────────────────

def send_rates_confirmation(gold_rate: dict, snapshot_stats: dict, import_stats: dict):
    _init()

    date_str = _fmt_date()
    written  = import_stats.get('variants_written', 0)
    now_str  = datetime.now().strftime('%d %b %Y %H:%M')

    html = f"""
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
            max-width:480px;color:#1a1a1a;margin:0 auto;">

  <h2 style="border-bottom:2px solid #1a1a2e;padding-bottom:10px;color:#1a1a2e;margin-top:0;">
    Gold Rates Applied — {date_str}
  </h2>

  <table style="border-collapse:collapse;width:100%;font-size:15px;margin-bottom:24px;">
    <tr style="background:#fffbf0;">
      <td style="padding:14px 18px;font-weight:600;">Pure Gold</td>
      <td style="padding:14px 18px;font-size:22px;font-weight:700;color:#b8860b;">
        Rs {gold_rate['pure']:,.0f} / gram
      </td>
    </tr>
    <tr>
      <td style="padding:14px 18px;font-weight:600;">18K Rate</td>
      <td style="padding:14px 18px;">Rs {gold_rate['18k']:,.2f} / gram</td>
    </tr>
    <tr style="background:#f8f9fa;">
      <td style="padding:14px 18px;font-weight:600;">14K Rate</td>
      <td style="padding:14px 18px;">Rs {gold_rate['14k']:,.2f} / gram</td>
    </tr>
  </table>

  <p style="font-size:14px;color:#444;margin-bottom:8px;">
    <strong>{written:,}</strong> product variants updated on Shopify with the above rates.
  </p>

  <p style="color:#aaa;font-size:11px;border-top:1px solid #eee;padding-top:10px;">
    Rate set: {gold_rate.get('set_at', 'N/A')[:16].replace('T', ' ')} UTC
    &nbsp;·&nbsp; Applied: {now_str} IST
  </p>
</div>"""

    resend.Emails.send({
        'from':    FROM_EMAIL,
        'to':      EMAIL_RATES_TO,
        'cc':      EMAIL_RATES_CC,
        'subject': f'Gold Rates Applied — {date_str} | Rs {gold_rate["pure"]:,.0f}/g pure',
        'html':    html,
    })


# ── Alert: run failed ─────────────────────────────────────────────────────────

def send_alert(error_message: str, run_id: str, gold_rate: dict = None):
    _init()

    date_str  = _fmt_date()
    rate_info = f'Rs {gold_rate["pure"]:,.0f}/g' if gold_rate else 'not loaded yet'

    html = f"""
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
            max-width:480px;color:#1a1a1a;margin:0 auto;">

  <h2 style="color:#c0392b;border-bottom:2px solid #c0392b;padding-bottom:10px;margin-top:0;">
    ⚠ Price Update Failed — {date_str}
  </h2>

  <table style="border-collapse:collapse;width:100%;font-size:14px;margin-bottom:20px;">
    <tr style="background:#fff5f5;">
      <td style="padding:10px 14px;font-weight:600;width:140px;">Error</td>
      <td style="padding:10px 14px;color:#c0392b;">{error_message}</td>
    </tr>
    <tr>
      <td style="padding:10px 14px;font-weight:600;">Gold rate</td>
      <td style="padding:10px 14px;">{rate_info}</td>
    </tr>
    <tr style="background:#fff5f5;">
      <td style="padding:10px 14px;font-weight:600;">Run ID</td>
      <td style="padding:10px 14px;font-family:monospace;">{run_id}</td>
    </tr>
  </table>

  <p style="color:#888;font-size:12px;">
    Check: Outputs/logs/daily_price_update_{run_id}.log
  </p>
</div>"""

    resend.Emails.send({
        'from':    FROM_EMAIL,
        'to':      EMAIL_RUN_REPORT_TO,
        'subject': f'⚠ AuraCarat Price Update FAILED — {date_str}',
        'html':    html,
    })


# ── Acknowledgement: test run triggered ──────────────────────────────────────

def send_test_ack(gati_id: str, gold_rate: dict):
    _init()

    date_str = _fmt_date()
    now_str  = datetime.now().strftime('%d %b %Y %H:%M')

    html = f"""
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
            max-width:480px;color:#1a1a1a;margin:0 auto;">

  <h2 style="border-bottom:2px solid #1a1a2e;padding-bottom:10px;color:#1a1a2e;margin-top:0;">
    Test Run Triggered — {gati_id}
  </h2>

  <p style="font-size:14px;color:#444;margin-bottom:20px;">
    A test price update has been kicked off for <strong>{gati_id}</strong>.
    You will receive a second email when the run completes with the full result.
  </p>

  <table style="border-collapse:collapse;width:100%;font-size:14px;margin-bottom:20px;">
    <tr style="background:#fffbf0;">
      <td style="padding:10px 14px;font-weight:600;">Pure Gold</td>
      <td style="padding:10px 14px;">Rs {gold_rate['pure']:,.0f} / gram</td>
    </tr>
    <tr>
      <td style="padding:10px 14px;font-weight:600;">18K Rate</td>
      <td style="padding:10px 14px;">Rs {gold_rate['18k']:,.2f} / gram</td>
    </tr>
    <tr style="background:#fffbf0;">
      <td style="padding:10px 14px;font-weight:600;">14K Rate</td>
      <td style="padding:10px 14px;">Rs {gold_rate['14k']:,.2f} / gram</td>
    </tr>
  </table>

  <p style="color:#aaa;font-size:11px;border-top:1px solid #eee;padding-top:10px;">
    Triggered: {now_str} IST
  </p>
</div>"""

    resend.Emails.send({
        'from':    FROM_EMAIL,
        'to':      EMAIL_RUN_REPORT_TO,
        'subject': f'[TEST] Run triggered for {gati_id} — {date_str}',
        'html':    html,
    })
