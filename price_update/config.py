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

# ── Email recipients ──────────────────────────────────────────────────────────
EMAIL_RUN_REPORT_TO = 'monodeep.dutta@timanti.in'
EMAIL_RATES_TO      = 'hsrstore@timanti.in'
EMAIL_RATES_CC      = ['shweta@timanti.in', 'monodeep.dutta@timanti.in']

# ── Price constants ───────────────────────────────────────────────────────────
RATIO_18K         = 0.771
RATIO_14K         = 0.604
GST_RATE          = 0.03
DECIMAL_PRECISION = 2

# ── Gold rate staleness guard ─────────────────────────────────────────────────
GOLD_RATE_MAX_AGE_HOURS = 20
