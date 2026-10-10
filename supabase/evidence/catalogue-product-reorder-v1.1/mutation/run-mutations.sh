#!/usr/bin/env bash
# Scanym — CATALOGUE PRODUCT REORDER v1.1 — exécution des contrôles de
# mutation (voir mutations.py). Chaque mutant vit dans une COPIE du
# dépôt ; le dépôt lui-même n'est jamais modifié.
#
# Usage, depuis la racine du dépôt, sous un utilisateur ordinaire :
#   SCANYM_DISPOSABLE_CLUSTER=1 bash <ce script> <pglite|realpg|lib> [parallélisme]
#     pglite : mutants SQL  x  tests/catalogue-product-reorder-v1-sql.test.ts
#     realpg : mutants SQL  x  supabase/tests/catalogue-product-reorder-v1-check.sh
#     lib    : mutants de la bibliothèque de sûreté  x  sondes HARNESS-01..08
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(pwd -P)"
MODE="${1:?pglite|realpg|lib}"
JOBS="${2:-4}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/scanym-cpr1-mut.XXXXXXXXXX")"
trap 'rm -rf -- "$WORK"' EXIT

one() {
  local mode="$1" name="$2" dir="$WORK/$2" kind=sql
  [ "$mode" = "lib" ] && kind=lib
  python3 "$HERE/mutations.py" "$REPO" "$WORK" "$kind" "$name" || { echo "$name : MUTATION NON APPLIQUÉE"; return; }
  case "$mode" in
    pglite)
      ( cd "$dir" && node --experimental-strip-types --import ./tests/register.mjs --test tests/catalogue-product-reorder-v1-sql.test.ts > out.txt 2>&1 )
      echo "$name : $(grep -c '^not ok' "$dir/out.txt") preuve(s) en échec sur $(grep -E '^# tests' "$dir/out.txt" | awk '{print $3}') :: $(grep '^not ok' "$dir/out.txt" | sed -E 's/^not ok [0-9]+ - //' | cut -c1-58 | tr '\n' '|')"
      ;;
    realpg)
      ( cd "$dir" && bash supabase/tests/catalogue-product-reorder-v1-check.sh > out.txt 2>&1 )
      echo "$name : $(grep -c 'FAIL:' "$dir/out.txt") preuve(s) en échec ($(grep 'RÉSUMÉ' "$dir/out.txt" | sed 's/.*RÉSUMÉ : //')) :: $(grep 'FAIL:' "$dir/out.txt" | sed -E 's/^\[[0-9:]+\] FAIL: //' | cut -c1-40 | head -8 | tr '\n' '|')"
      ;;
    lib)
      ( cd "$dir" && bash supabase/tests/catalogue-product-reorder-v1-harness-safety-check.sh > out.txt 2>&1 )
      echo "$name : $(grep -c 'FAIL:' "$dir/out.txt") sonde(s) en échec ($(grep 'RÉSUMÉ DES SONDES' "$dir/out.txt" | sed 's/.*RÉSUMÉ DES SONDES : //')) :: $(grep 'FAIL:' "$dir/out.txt" | sed -E 's/^\[[0-9:]+\] FAIL: //' | cut -c1-48 | head -6 | tr '\n' '|')"
      ;;
  esac
  rm -rf -- "$dir"
}
export -f one
export WORK REPO HERE

KIND=sql; [ "$MODE" = "lib" ] && KIND=lib
python3 "$HERE/mutations.py" list "$KIND" | xargs -P "$JOBS" -I{} bash -c 'one "$0" "$1"' "$MODE" {} | LC_ALL=C sort
