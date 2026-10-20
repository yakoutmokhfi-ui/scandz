#!/bin/bash
# usage: runsuite.sh <worktree> <label> <env|noenv>
cd "$1" || exit 2
if [ "$3" = env ]; then export NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder SUPABASE_SERVICE_ROLE_KEY=placeholder; else unset NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY; fi
S=/tmp/claude-0/-home-claude/2499d641-6765-5ef0-9d27-bf4f052dd788/scratchpad
git rev-parse HEAD > $S/suite-$2.sha
node --experimental-strip-types --import ./tests/register.mjs --test tests/*.test.ts > $S/suite-$2.tap 2>&1
echo "exit=$?" >> $S/suite-$2.tap
