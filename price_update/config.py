import os
from pathlib import Path

# /app/price_update → parent is /app
_HERE        = Path(__file__).resolve().parent
BASE         = _HERE.parent          # /app
# /data is a persistent Fly volume — survives deploys and restarts
# Falls back to /app/Outputs if volume not mounted (local dev)
OUTPUTS      = Path('/data') if Path('/data').exists() else BASE / 'Outputs'
LOGS_DIR     = OUTPUTS / 'logs'
IMPORT_SCRIPT = _HERE / 'import_from_preview.mjs'
SCRIPTS       = _HERE            # cwd for import_from_preview.mjs subprocess
GOLD_RATE_FILE = BASE / 'gold_rate.json'  # ephemeral fallback; Supabase is primary

# ── Supabase ──────────────────────────────────────────────────────────────────
# Uses SUPABASE_SERVICE_KEY to match the name already set as a Fly.io secret
SUPABASE_URL       = os.environ.get('SUPABASE_URL', 'https://mvprpdurguootqiwkaeu.supabase.co')
SUPABASE_KEY       = os.environ.get('SUPABASE_SERVICE_KEY', '')
SUPABASE_TOKEN_KEY = 'shopify_access_token'

# ── Shopify ───────────────────────────────────────────────────────────────────
STORE_DOMAIN = 'auracarat.myshopify.com'
API_VERSION  = '2024-10'

# ── Resend ────────────────────────────────────────────────────────────────────
RESEND_API_KEY = os.environ.get('RESEND_API_KEY', '')
FROM_EMAIL     = os.environ.get('FROM_EMAIL', '')

# ── No-weight sheet (Google Apps Script web app) ──────────────────────────────
# Deployed web app that receives the daily "skipped — no net metal weight" list.
# Separate from PO Ops' APPS_SCRIPT_URL: different sheet, different script.
# Unset → the push is skipped and the run continues normally.
NO_WEIGHT_SHEET_URL   = os.environ.get('NO_WEIGHT_SHEET_URL', '')
NO_WEIGHT_SHEET_CHUNK = 500   # rows per POST, keeps each request well under limits

# ── Email recipients ──────────────────────────────────────────────────────────
EMAIL_RUN_REPORT_TO = 'monodeep.dutta@timanti.in'
EMAIL_RATES_TO      = 'hsrstore@timanti.in'
EMAIL_RATES_CC      = ['shweta@timanti.in', 'monodeep.dutta@timanti.in']

# ── Price constants ───────────────────────────────────────────────────────────
RATIO_18K         = 0.771
RATIO_14K         = 0.604
RATIO_22K         = 0.9167   # 22/24 pure gold ratio
RATIO_24K         = 1.0      # 24/24 pure gold ratio
GST_RATE          = 0.03
DECIMAL_PRECISION = 2

# ── Taxable value composition ─────────────────────────────────────────────────
# Subtotal (the GST base) = gold + diamond + making + gemstone.
# Gemstone used to be folded into price_breakup_diamond; it is now a component
# of its own, so it has to be added to the subtotal or both the price and the
# 3% computed on it come out short.
#
# A variant with no gemstone metafield reads 0 and prices exactly as before,
# so this is a no-op for plain gold and diamond-only pieces.
#
# ⚠ This key must match the variant metafield the catalogue actually writes
#   gemstone VALUE (rupees) to — not gemstone weight. A wrong key fails silently
#   as gemstone = 0. Validate with `orchestrator.py --dry-run --test <GATI>`
#   before a live run.
GEMSTONE_MF_KEY = 'price_breakup_gemstone'

# ── Static-price exclusion list ───────────────────────────────────────────────
# Variants whose GATI ID (first SKU segment) is in this list are skipped
# entirely — the importer will not touch their price.
# Use this for silver coins, fixed-price items, etc.
# Example: STATIC_PRICE_GATI_IDS = ['SC00001', 'SC00002']
STATIC_PRICE_GATI_IDS: list[str] = ['SCOIN']

# ── Gold rate staleness guard ─────────────────────────────────────────────────
GOLD_RATE_MAX_AGE_HOURS = 20
