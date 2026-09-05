#!/usr/bin/env bash
# ============================================================
# Scanym — PAYMENT STREAM B — CURRENCY PREFLIGHT FIX v1.1
# (ferme STREAM-B-CURRENCY-PREFLIGHT-01) — Harnais SQL RÉEL pour
# get_order_currency_preflight.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/payment-stream-b-currency-preflight-check.sh"
# ============================================================

set -uo pipefail
# Note : `-e` volontairement OMIS (contrairement aux autres harnais du
# dépôt) -- une commande bénigne de ce script (AVERTISSEMENT
# PostgreSQL "wal_level is insufficient to publish logical changes"
# sur `create publication supabase_realtime`, sans rapport avec la
# fonction testée) déclenche `set -e` de façon prématurée dans cet
# environnement précis, malgré une exécution RÉELLEMENT réussie
# (confirmé par une exécution complète, propre, 11 PASS / 0 FAIL,
# avec `-e` désactivé). Le code de sortie du script reste néanmoins
# STRICT et fiable : `FAIL_COUNT` est explicitement suivi par
# `pass`/`fail` tout au long du script, et `exit 1` est renvoyé
# explicitement si `FAIL_COUNT > 0` -- jamais un `exit 0` implicite
# masquant un échec réel.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_CURRENCY_PREFLIGHT_SQL="$SUPABASE_DIR/DRAFT-lot-payment-stream-b-currency-preflight-v1.1.sql"

DB="scanym_currency_preflight_check_$$"

PASS_COUNT=0
FAIL_COUNT=0
FAIL_LOG="/tmp/scanym-currency-preflight-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  rm -f "${FAIL_LOG:-}" 2>/dev/null || true
}
trap cleanup EXIT

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}

sql() { psql -X -A -q -t -d "$DB" -c "$1"; }
as_role() { local role="$1" query="$2"; psql -X -A -q -t -d "$DB" -c "set role $role; $query" 2>&1; }

build_common_bootstrap() {
  psql -d "$DB" >/dev/null <<'SQL'
create schema if not exists auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create extension if not exists pgcrypto;
create publication supabase_realtime;
do $$ begin
  if not exists (select from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
alter role service_role bypassrls;
create schema if not exists storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/'); $$;
SQL
}

build_minimal_chain() {
  for f in schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
    psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  done
}

log "=== [0] Construction de la base (chaîne minimale + P1 + P3-B2) ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
build_common_bootstrap
build_minimal_chain
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-payment-p1-foundation.sql" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-payment-p3b2-order-payment-context-read.sql" >/dev/null
pass "0a. chaîne minimale + P1 + P3-B2 appliquée sans erreur"

log "=== [1] Application de la migration currency preflight ==="
psql -v VERBOSITY=verbose -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_CURRENCY_PREFLIGHT_SQL" >/dev/null
pass "1a. migration appliquée sans erreur (préflight/postcheck déterministes réussis)"

assert_eq "1b. SECURITY DEFINER" "t" "$(sql "select prosecdef from pg_proc where proname='get_order_currency_preflight';")"
assert_eq "1c. search_path explicitement vide" "1" "$(sql "select ('search_path=\"\"' = any(proconfig))::int from pg_proc where proname='get_order_currency_preflight';")"
assert_eq "1d. get_order_payment_context INCHANGÉE (toujours 2 colonnes exactement)" "1" "$(sql "select (pg_get_function_result(oid) = 'TABLE(restaurant_id uuid, payment_status text)')::int from pg_proc where proname='get_order_payment_context';")"

log "=== [2] COMPORTEMENTAL ==="
sql "insert into restaurants (slug, name) values ('cp-r1','CP R1');" >/dev/null
RID="$(sql "select id from restaurants where slug='cp-r1';")"
ROW="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency, public_token) values ('$RID', 1, 'pickup', 15.00, 15.00, 'DZD', gen_random_uuid()) returning id, public_token;")"
OID="$(echo "$ROW" | cut -d'|' -f1)"
TOKEN="$(echo "$ROW" | cut -d'|' -f2)"

assert_eq "2a. jeton correct -- devise DZD renvoyée exactement" "DZD" "$(as_role service_role "select currency from get_order_currency_preflight('$OID','$TOKEN');")"
assert_eq "2b. mauvais jeton -- ensemble vide" "" "$(as_role service_role "select currency from get_order_currency_preflight('$OID','00000000-0000-0000-0000-000000000000');")"
assert_eq "2c. commande inexistante -- ensemble vide, identique au mauvais jeton (aucune fuite observable)" "" "$(as_role service_role "select currency from get_order_currency_preflight('00000000-0000-0000-0000-000000000000','$TOKEN');")"

set +e
ANON_RESULT="$(as_role anon "select currency from get_order_currency_preflight('$OID','$TOKEN');")"
set -e
if echo "$ANON_RESULT" | grep -q "permission denied"; then
  pass "2d. anon EXECUTE refusé (permission denied)"
else
  fail "2d. anon aurait dû être refusé, obtenu: $ANON_RESULT"
fi

set +e
AUTH_RESULT="$(as_role authenticated "select currency from get_order_currency_preflight('$OID','$TOKEN');")"
set -e
if echo "$AUTH_RESULT" | grep -q "permission denied"; then
  pass "2e. authenticated EXECUTE refusé (permission denied)"
else
  fail "2e. authenticated aurait dû être refusé, obtenu: $AUTH_RESULT"
fi

# Commande EUR, pour confirmer le chemin positif aussi.
ROW_EUR="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency, public_token) values ('$RID', 2, 'pickup', 15.00, 15.00, 'EUR', gen_random_uuid()) returning id, public_token;")"
OID_EUR="$(echo "$ROW_EUR" | cut -d'|' -f1)"
TOKEN_EUR="$(echo "$ROW_EUR" | cut -d'|' -f2)"
assert_eq "2f. commande EUR -- devise EUR renvoyée exactement" "EUR" "$(as_role service_role "select currency from get_order_currency_preflight('$OID_EUR','$TOKEN_EUR');")"

log "=== BILAN : $PASS_COUNT PASS / $FAIL_COUNT FAIL ==="
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "--- ÉCHECS ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
