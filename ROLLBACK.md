# Consolidation Rollback — 2026-07-08

Full log: `CONSOLIDATION_2026-07-08.log`

## What changed
- `origin/main`: `67ff10e` → **`92f977c`** (squash-merged the metafield-manager server logic:
  payments recompute, apply-voucher/apply-exc handlers, CAD advance, recon credit-instrument
  ledger, old-gold buying rate, getCollectionBase). Fast-forward, no history rewrite.
- Deleted branches: `feat/serialization` (local+remote), `flyio-new-files` (remote),
  `claude/relaxed-morse-243aba` (local). All had ZERO unique commits vs main.
- Kept: `main`, `feat/metafield-manager-extension`.
- Local `main` synced to `92f977c`. Your uncommitted WIP was stashed and restored.

## Restore points (durable tags, pushed to origin)
| Tag | SHA | What |
|---|---|---|
| `backup/main-preconsolidate` | `67ff10e` | main BEFORE the merge |
| `backup/consolidated-main` | `92f977c` | the new merged state |
| `backup/feat-serialization-local` | `a4ccd3e` | deleted local branch |
| `backup/feat-serialization-remote` | `8550fb8` | deleted remote branch |
| `backup/flyio-new-files` | `ecc56c0` | deleted remote branch |
| `backup/claude-relaxed-morse` | `560b5d6` | deleted local branch |

## Undo commands

### Revert main to before the merge
```bash
git push origin backup/main-preconsolidate:main --force-with-lease
git branch -f main backup/main-preconsolidate    # sync local (main must not be checked out)
```
(Then Fly must be re-deployed from main to roll back the running service.)

### Restore a deleted branch
```bash
git push origin backup/feat-serialization-remote:refs/heads/feat/serialization
git push origin backup/flyio-new-files:refs/heads/flyio-new-files
git branch feat/serialization backup/feat-serialization-local
git branch claude/relaxed-morse-243aba backup/claude-relaxed-morse
```

## Cleanup once you're confident (optional)
```bash
git push origin --delete \
  backup/main-preconsolidate backup/consolidated-main \
  backup/feat-serialization-local backup/feat-serialization-remote \
  backup/flyio-new-files backup/claude-relaxed-morse
git tag -d backup/main-preconsolidate backup/consolidated-main \
  backup/feat-serialization-local backup/feat-serialization-remote \
  backup/flyio-new-files backup/claude-relaxed-morse
git worktree prune   # clears the leftover .git/worktrees/wt-consol once unlocked
```

## Still TODO to make the new handlers fully work
1. **Deploy Fly from main** (GitHub → Actions → "Deploy to Fly.io" → Run workflow) — ships `92f977c`.
2. **Run `services/exchange-cn/credit_instruments_setup.sql` against Supabase** — creates the
   credit-instrument ledger table the voucher/exc handlers write to. Without it the ledger-void
   silently no-ops (try/caught, non-fatal).
