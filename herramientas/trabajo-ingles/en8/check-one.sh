#!/bin/sh
# ./check-one.sh <name>  -> normalise raw/<name>.txt and run the real staging gate (dry-run). Prints DRY-OK or REJECT reasons.
cd /c/Danilo/Programas/LEXICOIL/_trabajo-ingles/en8 && node ingest.mjs "$1" | tail -1
cd /c/Danilo/Programas/LEXICOIL/lexiloop-en8 && node scripts/ingest-to-staging.mjs --lang en --level B1 --file "../_trabajo-ingles/en8/norm/$1.json" --auto-approve --dry-run 2>&1 | grep -E "DRY-OK|REJECT"
