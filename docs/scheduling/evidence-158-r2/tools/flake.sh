#!/bin/bash
# usage: flake.sh <label> <n>   (run in chk158; env set)
cd /tmp/claude-0/-home-claude/2499d641-6765-5ef0-9d27-bf4f052dd788/scratchpad/chk158
export NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder SUPABASE_SERVICE_ROLE_KEY=placeholder
for i in $(seq 1 $2); do
  node --experimental-strip-types --import ./tests/register.mjs --test tests/csdj2-checkout-schedule-158.test.ts tests/csdj2-checkout-schedule-158.dom.test.ts tests/csdj2-checkout-schedule-158-r1.dom.test.ts tests/csdj2-checkout-schedule-158-r2.test.ts tests/csdj2-checkout-schedule-158-r2.dom.test.ts 2>&1 | grep -E "^# (tests|pass|fail)|^not ok" | tr '\n' ' '
  echo " [$1 run $i]"
done
