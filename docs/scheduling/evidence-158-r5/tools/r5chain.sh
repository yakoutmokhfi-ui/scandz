#!/bin/bash
S=/tmp/claude-0/-home-claude/2499d641-6765-5ef0-9d27-bf4f052dd788/scratchpad
cd $S/r5cand
export NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder SUPABASE_SERVICE_ROLE_KEY=placeholder
npx tsc --noEmit -p . > $S/158-r5-tsc.log 2>&1; echo "tsc_exit=$?" >> $S/158-r5-tsc.log
npx next build > $S/158-r5-build.log 2>&1; echo "build_exit=$?" >> $S/158-r5-build.log
for run in "r5cand r5-cand-c1a 1" "r5main r5-main-c1a 1" "r5cand r5-cand-c2a 2" "r5main r5-main-c2a 2" "r5cand r5-cand-c2b 2" "r5main r5-main-c2b 2" "r5cand r5-cand-c1b 1" "r5cand r5-cand-c2c 2" "r5main r5-main-c2c 2"; do set -- $run; $S/runsuite.sh $S/$1 $2 env $3; done
echo done > $S/r5chain.done
