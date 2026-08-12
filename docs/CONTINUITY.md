# Business continuity — the week after the migration

The reorganised structure went live on 11 August 2026 and became the mainline on 12 August. This is
the watch list for the days that follow, and the rules that keep the repo from drifting back.

---

## The one rule

**There is one branch and it is `main`. It is the branch that deploys.**

This repo drifted into a stale-`main`-with-real-work-elsewhere state three separate times. Each time
it meant deploys needed a hand-copied commit reference, and each time reconciling it took a day. The
rule is now enforced in three places rather than remembered:

| Where | What it does |
|---|---|
| `hooks/pre-push` | Refuses to push any branch except `main`. Activate with `git config core.hooksPath hooks` |
| GitHub branch protection | Prevents `main` being force-pushed or deleted |
| Only one branch exists | Nothing else to accidentally commit to |

`git push --no-verify` bypasses the hook. That is deliberate friction for a genuine exception — if
you find yourself typing it from habit, the rule has stopped doing its job.

---

## Daily check (about 60 seconds)

Run `node tools/health.js`, or open these in a browser. All should return data.

| Endpoint | Confirms |
|---|---|
| `/api/version` | Which build is live. `layout` must read `modular` |
| `/api/test-db` | Database and configuration reachable |
| `/api/recon` | Reconciliation data folder resolves *(this one broke once — see below)* |
| `/api/sales-report?from=&to=` | Reporting over live data |
| `/api/recon-ledger?view=summary` | Voucher / exchange-note ledger |
| `/api/price-update-diag` | The gold-rate job's files are present |
| `/api/serial-report?docType=customer_order` | Numbering |

**`/api/version` is the one to check first.** If `commit` is not what you last deployed, someone
deployed something else.

---

## What to watch, in order of likelihood

### 1. Paths that moved (highest risk, and the known failure mode)

Every file that reads something from disk had its path rewritten. One of these was wrong and shipped:
`GET /api/recon` resolved the wrong folder and returned a 500. It was fixed in `eb6c755`.

This class of bug does **not** fail at startup and does **not** fail the automatic checks — the route
registers fine and only breaks when something calls it. The three paths that matter:

- `src/data/recon/` — read by `/api/recon`
- `src/jobs/price-update/orchestrator.py` — run by the daily gold-rate job
- `/app/Outputs/price_update.running` — the lock that stops two reprices at once

**Watch:** the first reconciliation of the month, and the first daily price update after the
migration. Those are the two that only run occasionally and so have had least exercise.

### 2. Anything that runs on a schedule rather than on demand

By definition these have not been tested by normal trading:

- **Daily gold-rate reprice** — should run once a day. Check `/api/price-update-diag` and whether
  prices actually moved.
- **Voucher expiry reminders** — a sweep that was written but never started, and is now wired in.
  First reminders fire 30 days before a voucher expires. Nobody has seen one yet.
- **Transaction poller** — every 30 seconds while a card payment is in flight.

### 3. Repairs

The completion email was crashing on every finished repair since 7 August — no customer email, no
completion tag, no completion date, **no repair serial**. Fixed, but the fix has not been seen
working on a real repair yet.

**Watch:** the next completed repair. Confirm the customer got the email, and that the draft has a
`repair-completion-notified` tag, a `repair_completed_at` value, and a serial.

Repairs completed between 7 and 12 August are still missing all of that. They will need a backfill.

### 4. Tax figures

Reconciliation and sales reports used to disagree by one paisa on some rows. They now share one
calculation that rounds half **up** — ₹4,567 gives CGST ₹68.51 where it previously gave ₹68.50.

**Watch:** the first month-end reconciliation. Small differences against previously-generated
reports are expected and correct.

---

## If something breaks

**Roll back first, diagnose second.** Two minutes of the old version beats twenty minutes of
investigation while staff are blocked.

> GitHub → **Actions** → **Deploy Specific Commit to Fly.io** → *Run workflow* →
> `a3a0dc783137761da8a29ec223b21c09992f2e4c`

That is the last version before the reorganisation. Then say what broke.

**Be aware what rolling back costs:** that version still has the repair-email crash, the split tax
calculation, and no voucher expiry reminders. It is an escape hatch, not somewhere to stay.

**Reference copy of the old structure:** `C:\timanti-old-structure-2026-08-12\` — browsable files,
a map of where everything moved, and self-contained bundles. See its README.

---

## Retiring the safety net

Nothing below is urgent. The archive is 5 MB and the tags cost nothing.

| When | Do |
|---|---|
| After 7 days of normal trading | Delete the branch `feat/metafield-manager-extension` if it still exists |
| After 7 days | Delete the six stale `backup/*` tags from July — they predate all of this and only add noise |
| After 30 days | Delete `C:\timanti-old-structure-2026-08-12\` if it has never been needed |
| Keep indefinitely | `restore/2026-08-12-main` on GitHub. It is the definitive pre-migration point and costs nothing |

---

## Still outstanding

Not blockers, but they should not be forgotten:

- **`REPAIR_TEST_EMAIL`** in `src/modules/after-sales/index.js` redirects repair mail to
  `monodeep.dutta@timanti.in` instead of the customer. Marked "revert after testing".
- **Repairs completed 7–12 August** need backfilling: completion tag, date, and serial.
- **`buildRefundConfirmationHtml`** was written on 7 August and is still connected to nothing.
- **`/api/test-db` exposes Pine security tokens** in plain text to anyone with the URL. Pre-existing.
- **`server.js` is still ~4,450 lines.** Payments, adjustments, pricing and the order pipeline remain
  in it. Optional work — see `ARCHITECTURE.md` for why they move together or not at all.
