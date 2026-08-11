# Deploying

Two independent deploy targets. Confusing them is the most common mistake in this repo.

| Target | What it ships | Triggered by |
|---|---|---|
| **Fly** — `timanti-middleware.fly.dev` | `server.js` + `src/` | GitHub Actions |
| **Shopify** — the admin extension | `apps/metafield-manager/` | Shopify CLI, from your machine |

Committing is not deploying. Both targets need an explicit action.

---

## Deploying the middleware

`flyctl` and `gh` are not installed on the primary dev machine, so this runs in the cloud.

**Normal deploy** — github.com/Mono2307/timanti-middleware → **Actions** →
**Deploy to Fly.io** → *Run workflow*. Builds whatever `main` currently is.

**Deploy a specific commit** (also the fastest rollback) — **Actions** →
**Deploy Specific Commit to Fly.io** → *Run workflow* → paste the SHA. It overlays `fly.toml`
from `main`, so config stays consistent even when shipping an older tree. Takes about two minutes.

### After any deploy, check these

Read-only, safe against production, no setup:

```
GET /api/test-db                              Supabase reachable
GET /api/recon-ledger?view=summary            credit-instrument ledger
GET /api/serial-report?docType=customer_order serial counters
GET /api/adjustment-report?from=&to=          adjustments by issuance/redemption
```

If `/api/test-db` fails, the usual cause is a missing Fly secret — see `ENVIRONMENT.md`.

### Rolling back

Redeploy the previous commit with **Deploy Specific Commit**. Do not revert-and-redeploy under
pressure; shipping a known-good SHA is faster and has fewer ways to go wrong.

Durable restore points exist as tags on GitHub:

| Tag | What |
|---|---|
| `restore/2026-08-08-feat` | Production code immediately before the repo restructure |
| `restore/2026-08-08-main` | The old `main` branch before unification |

---

## Deploying the Shopify extension

```bash
cd apps/metafield-manager
npx @shopify/cli app deploy -c timanti-metafield-manager-new
```

- The bare `shopify` command is not on PATH — use `npx`.
- Do not pass `--force` or set `CI=1`; the interactive confirmation is wanted here.
- The config flag selects the right app; without it the CLI may target the wrong one.

After deploying, open **a real draft order and a real order** in Shopify Admin and confirm both
panels render and save. All four extension targets render the same shared component
(`shared/MetafieldManager.jsx`), so if one is broken all four are.

---

## Branches

`main` is the deploy branch and the source of truth. `deploy.yml` builds the default branch, so
work that has not reached `main` is not live regardless of what is committed elsewhere.

This repo has twice drifted into a stale `main` with the real code on a long-lived feature
branch, which meant every deploy needed a hand-copied SHA. If you branch, merge back quickly.

---

## What is not deployed from here

- **Order Printer templates, Apps Scripts, SQL migrations** — pasted into panels by hand, kept in
  `../timanti-ops-assets/`. See that repo's README for which folder feeds which panel.
- **Supabase edge functions** (PO Ops) — deployed with `supabase functions deploy`.
- **Supabase schema** — migrations in `../timanti-ops-assets/sql/` are run manually in the SQL
  editor. Nothing applies them automatically.
