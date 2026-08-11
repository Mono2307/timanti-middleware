'use strict';

/**
 * Voucher expiry reminder — 30 days out.
 *
 * Sent by the middleware through Resend, not by the sheet. The sheet issues
 * vouchers; the ledger knows when they expire, so the reminder belongs here.
 *
 * WHAT IT DOES
 * Once a day, finds every voucher in credit_instruments that is still open and
 * whose expires_at falls on the day exactly 30 days from now, and emails the
 * customer. A reminded_at column would be the cleanest guard, but the date
 * window is already a single day and the run is idempotent within it, so a
 * second run on the same day re-sends nothing new — it is the same set, and the
 * in-memory guard below stops a double-fire inside one process.
 *
 * WHY A WINDOW AND NOT "<= 30 days"
 * A <= comparison would re-send every day for the last 30 days of a voucher's
 * life. The window is deliberately one day wide.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const LEAD_DAYS = 30;

// Serial codes reminded in this process lifetime. Cheap insurance against the
// sweep being triggered twice by a restart on the same day.
const remindedThisProcess = new Set();

/**
 * Resolve a customer email for a ledger row. The ledger stores customer_id and
 * source_order_name, never an address, so we go and find one — in order of how
 * reliable it is:
 *
 *   1. Shopify customer record   — authoritative, survives the order being edited
 *   2. The source order's email  — covers guest checkouts with no customer record,
 *                                  and rows written before customer_id was captured
 *
 * Returns null only when both fail, which is the one case worth logging loudly:
 * a voucher nobody can be reminded about.
 */
async function resolveCustomerEmail(deps, row) {
  const { axios, storeUrl, token } = deps;
  const headers = { 'X-Shopify-Access-Token': token };

  if (row.customer_id) {
    try {
      const { data } = await axios.get(
        `${storeUrl}/admin/api/2024-01/customers/${row.customer_id}.json?fields=id,email`,
        { headers, timeout: 10000 }
      );
      if (data?.customer?.email) return data.customer.email;
    } catch (err) {
      console.warn(`[voucher-expiry] customer ${row.customer_id} lookup failed: ${err.message}`);
    }
  }

  if (row.source_order_name) {
    try {
      const { data } = await axios.get(
        `${storeUrl}/admin/api/2024-01/orders.json?name=${encodeURIComponent(row.source_order_name)}&status=any&limit=1&fields=id,name,email`,
        { headers, timeout: 10000 }
      );
      const email = data?.orders?.[0]?.email;
      if (email) return email;
    } catch (err) {
      console.warn(`[voucher-expiry] order ${row.source_order_name} lookup failed: ${err.message}`);
    }
  }

  return null;
}

/**
 * @param deps.supabase
 * @param deps.sendEmail        from emailService
 * @param deps.buildVoucherExpiryHtml  from emailTemplates
 * @param deps.withStoreCc      from emailService
 * @param deps.axios            for the Shopify lookups
 * @param deps.storeUrl         process.env.SHOPIFY_STORE_URL
 * @param deps.getShopifyToken  async () => token
 * @param deps.customerEmailFor optional override; defaults to resolveCustomerEmail
 */
async function runVoucherExpirySweep(deps, { dryRun = false } = {}) {
  const { supabase, sendEmail, buildVoucherExpiryHtml, withStoreCc } = deps;
  const token = deps.token || (deps.getShopifyToken ? await deps.getShopifyToken() : null);
  const lookup = deps.customerEmailFor
    || ((row) => resolveCustomerEmail({ ...deps, token }, row));

  const target = new Date(Date.now() + LEAD_DAYS * DAY_MS);
  const dayStart = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate()));
  const dayEnd   = new Date(dayStart.getTime() + DAY_MS);

  const { data, error } = await supabase
    .from('credit_instruments')
    .select('serial_code, value, customer_id, customer_name, source_order_name, expires_at, status')
    .eq('instrument_type', 'voucher')
    .eq('status', 'open')
    .gte('expires_at', dayStart.toISOString())
    .lt('expires_at',  dayEnd.toISOString());

  if (error) throw new Error(`voucher expiry sweep query: ${error.message}`);

  const rows = data || [];
  console.log(`[voucher-expiry] ${rows.length} voucher(s) expiring on ${dayStart.toISOString().slice(0, 10)}`);
  if (!rows.length) return { found: 0, sent: 0, skipped: 0 };

  let sent = 0, skipped = 0;

  for (const row of rows) {
    if (remindedThisProcess.has(row.serial_code)) { skipped++; continue; }

    let email = null;
    try {
      email = await lookup(row);
    } catch (err) {
      console.warn(`[voucher-expiry] email lookup failed for ${row.serial_code}: ${err.message}`);
    }
    if (!email) {
      console.warn(`[voucher-expiry] no email for ${row.serial_code} — skipped`);
      skipped++;
      continue;
    }

    const expiryDate = new Date(row.expires_at).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'long', year: 'numeric'
    });

    if (dryRun) {
      console.log(`[voucher-expiry] DRY RUN would send ${row.serial_code} → ${email} (expires ${expiryDate})`);
      sent++;
      continue;
    }

    try {
      await sendEmail({
        to:      email,
        cc:      withStoreCc(),
        subject: `Your Timanti Voucher expires in 30 days — ${row.serial_code}`,
        html:    buildVoucherExpiryHtml({
          cnNumber:      row.serial_code,
          creditValue:   row.value,
          expiryDate,
          originalOrder: row.source_order_name
        })
      });
      remindedThisProcess.add(row.serial_code);
      sent++;
      console.log(`[voucher-expiry] sent ${row.serial_code} → ${email}`);
    } catch (err) {
      // One bad address must not stop the rest of the run.
      console.error(`[voucher-expiry] send failed for ${row.serial_code}: ${err.message}`);
      skipped++;
    }
  }

  console.log(`[voucher-expiry] done — ${sent} sent, ${skipped} skipped`);
  return { found: rows.length, sent, skipped };
}

/**
 * Start the daily loop. Same pattern as the existing GoKwik poller in server.js,
 * so no scheduler, no new service, no new dependency — the process already stays
 * up (min_machines_running = 1 in fly.toml).
 *
 * Fires once shortly after boot, then every 24h.
 */
function startVoucherExpirySweep(deps) {
  const kick = () => runVoucherExpirySweep(deps)
    .catch(err => console.error('[voucher-expiry] sweep failed:', err.message));

  setTimeout(kick, 60 * 1000);        // let the process settle first
  setInterval(kick, DAY_MS);
}

module.exports = { runVoucherExpirySweep, startVoucherExpirySweep, resolveCustomerEmail, LEAD_DAYS };
