#!/usr/bin/env bash
# Classify every tracked file for the Phase-2 split.
#
# Rules are evaluated top-down, so the MOST SPECIFIC patterns come first. Two categories are
# destructive and are therefore deliberately narrow:
#   GENERATED — regenerable build output. The only thing deleted without being archived.
#   dead-code — no runtime reference, but still archived to the assets repo rather than dropped.
# Everything else is copied out and then removed from git, where history still holds it.

classify() {
  case "$1" in
    # ── generated output — the only outright deletions ─────────────────────
    price_update/__pycache__/*)            echo GENERATED;;
    price_update/SKIPPED_NO_WEIGHT*.csv)   echo GENERATED;;

    # ── dead code: zero runtime references (archived, not dropped) ─────────
    services/pricing-engine/index.js)      echo dead-code;;
    services/pricing-engine/src/*)         echo dead-code;;

    # ── things that LOOK like artifacts but are not — these must win over the
    # generic extension rules further down.
    #   Recon Test/  : GET /api/recon reads it from disk in the container, and
    #                  _recon_store/ is the durable reconciliation ledger.
    #   tools/       : baseline-routes.txt is the regression gate, not a doc.
    #   metafield-mgr: the Shopify app's own README/CHANGELOG ship with the app.
    #   .github/     : workflow YAML is the deploy mechanism.
    #   requirements : the Dockerfile pip-installs it at build time.
    "Recon Test"/*)                        echo KEEP;;
    tools/*)                               echo KEEP;;
    metafield-manager/*)                   echo KEEP;;
    .github/*)                             echo KEEP;;
    price_update/requirements.txt)         echo KEEP;;

    # ── copy-paste artifacts (most specific first) ─────────────────────────
    *apps-script*.js|*sheets-app-script.js|*.gs|*.gs.txt) echo apps-script;;
    *.liquid)                              echo order-printer;;
    *.sql)                                 echo sql;;
    *.html)                                echo forms;;
    "PO Ops"/supabase/functions/*)         echo supabase-functions;;
    "PO Ops"/files/mnt/*)                  echo supabase-functions;;
    *.md|*.docx|*.txt)                     echo docs;;
    *postman_collection.json)              echo docs;;
    *.csv)                                 echo reference-data;;
    "PO Ops"/*|*.env.example)              echo docs;;

    # ── runtime / build / app source — stays in the deploy repo ────────────
    server.js|emailService.js|emailTemplates.js)        echo KEEP;;
    package.json|package-lock.json|Dockerfile|fly.toml) echo KEEP;;
    .dockerignore|.gitignore|.gitattributes)     echo KEEP;;
    .github/*|tools/*)                                  echo KEEP;;
    "Recon Test"/*)                                     echo KEEP;;
    price_update/*)                                     echo KEEP;;
    metafield-manager/*)                                echo KEEP;;
    services/*/*.js|services/*/*/*.js)                  echo KEEP;;

    *) echo UNCLASSIFIED;;
  esac
}

cd "$(dirname "$0")/.." || exit 1
while IFS= read -r -d '' f; do printf '%s\t%s\n' "$(classify "$f")" "$f"; done < <(git ls-files -z)
