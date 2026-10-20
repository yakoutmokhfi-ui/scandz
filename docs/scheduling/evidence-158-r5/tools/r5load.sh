#!/bin/bash
# Isolation de l'effet de charge : mêmes 2 fichiers sensibles, code de MAIN, parallélisme 2, 5 itérations par condition.
S=/tmp/claude-0/-home-claude/2499d641-6765-5ef0-9d27-bf4f052dd788/scratchpad
OUT=$S/158-r5-load-isolation.txt; : > $OUT
export NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder SUPABASE_SERVICE_ROLE_KEY=placeholder
run() { # cond, loadcmd
  for i in 1 2 3 4 5; do
    LP=""
    if [ -n "$2" ]; then ( cd $S/r5cand && eval "$2" ) >/dev/null 2>&1 & LP=$!; fi
    r=$(cd $S/r5main && node --experimental-strip-types --import ./tests/register.mjs --test --test-concurrency=2 tests/v155-admin-catalogue-import-entry-point.dom.test.ts tests/catalogue-product-reorder-v1.dom.test.ts 2>&1 | grep -E '^# (pass|fail)|^not ok' | cut -c1-90 | tr '\n' ' ')
    [ -n "$LP" ] && { kill $LP 2>/dev/null; pkill -P $LP 2>/dev/null; wait $LP 2>/dev/null; }
    echo "$1 #$i: $r" | tee -a $OUT
  done
}
run "A sans charge" ""
run "B charge = test DOM R4 (candidat)" "node --experimental-strip-types --import ./tests/register.mjs --test tests/csdj2-checkout-schedule-158-r4.dom.test.ts"
run "C charge = test DOM R5 (candidat)" "node --experimental-strip-types --import ./tests/register.mjs --test tests/csdj2-checkout-schedule-158-r5.dom.test.ts"
run "D charge = 1 boucle CPU pure (aucun code du dépôt)" "node -e 'while(true){}'"
run "E charge = 2 boucles CPU pures" "node -e 'while(true){}' & node -e 'while(true){}' & wait"
pkill -f "while(true)" ; echo done > $S/r5load.done
