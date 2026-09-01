#!/usr/bin/env bash
# ============================================================
# Scanym — PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.4 — Harnais
# RÉEL PostgreSQL pour la migration forward
# supabase/DRAFT-lot-payment-p3b-monetico-checkout-runtime-v46-forward.sql
# (ferme P3BV43-SQL-PUBLICATION-01, P3BV42-TEST-MATRIX-01 -- preuve
# SQL RÉELLE, jamais un simulateur seul).
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/payment-p3b-monetico-checkout-runtime-v46-forward-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_PAYMENT_P1_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p1-foundation.sql"
DRAFT_PAYMENT_P2A_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p2a-secure-config.sql"
DRAFT_PAYMENT_P2BA_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p2b-a-safe-merchant-read.sql"
DRAFT_PAYMENT_P3A0_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3a0-secure-credential-read.sql"
DRAFT_PAYMENT_P3B0_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b0-correlation-status-read.sql"
DRAFT_PAYMENT_P3B1_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b1-runtime-provider-enablement-read.sql"
DRAFT_PAYMENT_P3B2_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b2-order-payment-context-read.sql"
DRAFT_PAYMENT_P3B3_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b3-active-payment-attempt-resume-read.sql"
DRAFT_PAYMENT_P3B4_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b4-provider-runtime-mode-read.sql"
DRAFT_PAYMENT_P3B5_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b5-durable-provider-callback-inbox.sql"
DRAFT_PAYMENT_V46_FORWARD_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b-monetico-checkout-runtime-v46-forward.sql"

DB="scanym_payment_v46_forward_$$"
DB_PREFLIGHT="scanym_payment_v46_preflight_$$"

PASS_COUNT=0
FAIL_COUNT=0
FAIL_LOG="/tmp/scanym-payment-v46-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_PREFLIGHT\";" >/dev/null 2>&1 || true
  rm -f "${FAIL_LOG:-}" 2>/dev/null || true
}
trap cleanup EXIT

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}

as_service() {
  local dbname="$1" query="$2"
  PGOPTIONS="-c role=service_role" psql -v VERBOSITY=verbose -X -A -q -t -d "$dbname" -c "$query" 2>&1
}
sql() { psql -X -A -q -t -d "$DB" -c "$1"; }
sql_db() { psql -X -A -q -t -d "$1" -c "$2"; }

fp() { echo -n "$1" | sha256sum | cut -d' ' -f1; }

build_common_bootstrap() {
  local dbname="$1"
  psql -d "$dbname" >/dev/null <<'SQL'
create schema if not exists auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;
create extension if not exists pgcrypto;
create publication supabase_realtime;
do $$ begin
  if not exists (select from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
alter role service_role bypassrls;
alter role anon nobypassrls;
alter role authenticated nobypassrls;
create schema if not exists storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/'); $$;
SQL
}

build_minimal_chain() {
  local dbname="$1"
  for f in schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql; do
    psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
    psql -d "$dbname" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  done
  for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql; do
    psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  done
}

build_mock_vault() {
  local dbname="$1"
  psql -d "$dbname" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create schema vault;
create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  secret text not null,
  name text,
  description text,
  key_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create function vault.create_secret(new_secret text, new_name text, new_description text, new_key_id uuid default null)
returns uuid language plpgsql as $fn$
declare v_id uuid;
begin
  insert into vault.secrets (secret, name, description, key_id)
    values (new_secret, new_name, new_description, new_key_id)
    returning id into v_id;
  return v_id;
end;
$fn$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null)
returns void language plpgsql as $fn$
begin
  update vault.secrets
    set secret = coalesce(new_secret, secret),
        name = coalesce(new_name, name),
        description = coalesce(new_description, description),
        key_id = coalesce(new_key_id, key_id),
        updated_at = now()
    where id = secret_id;
end;
$fn$;
create view vault.decrypted_secrets as
  select id, secret as decrypted_secret, name, description, key_id, created_at, updated_at
  from vault.secrets;
SQL
}

build_full_chain_through_p3b5() {
  local dbname="$1"
  build_common_bootstrap "$dbname"
  build_minimal_chain "$dbname"
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P1_SQL" >/dev/null
  build_mock_vault "$dbname"
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2A_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2BA_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3A0_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B0_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B1_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B2_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B3_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B4_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B5_SQL" >/dev/null
}

log "=== [0] Préflight fail-closed sur base SANS P3-B5 ==="
psql -c "drop database if exists \"$DB_PREFLIGHT\";" >/dev/null 2>&1 || true
createdb "$DB_PREFLIGHT"
build_common_bootstrap "$DB_PREFLIGHT"
build_minimal_chain "$DB_PREFLIGHT"
psql -d "$DB_PREFLIGHT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P1_SQL" >/dev/null

set +e
PREFLIGHT_OUTPUT="$(psql -v VERBOSITY=verbose -d "$DB_PREFLIGHT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_V46_FORWARD_SQL" 2>&1)"
PREFLIGHT_RC=$?
set -e
if [ "$PREFLIGHT_RC" -ne 0 ] && echo "$PREFLIGHT_OUTPUT" | grep -q "SCANYM_SCHEMA_DRIFT"; then
  pass "0a. préflight refuse fail-closed (SCANYM_SCHEMA_DRIFT) sur une base sans payment_provider_events"
else
  fail "0a. préflight aurait dû refuser fail-closed -- rc=$PREFLIGHT_RC, sortie: $PREFLIGHT_OUTPUT"
fi
psql -c "drop database if exists \"$DB_PREFLIGHT\";" >/dev/null 2>&1 || true

log "=== [1] Base complète SANS migration forward ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
build_full_chain_through_p3b5 "$DB"
pass "1a. chaîne complète P1..P3-B5 appliquée sans erreur (SANS la migration forward)"

# ============================================================
# Vérification EXPLICITE (mandat §5) : next_attempt_at ABSENTE avant
# la migration forward -- confirme que ce harnais installe bien le
# VRAI prédécesseur historique, jamais une version déjà enrichie.
# ============================================================
assert_eq "1a2. next_attempt_at ABSENTE avant la migration forward (confirme le VRAI prédécesseur historique, ferme P3BV44-FORWARD-PREDECESSOR-01)" "0" "$(sql "select count(*) from information_schema.columns where table_schema='public' and table_name='payment_provider_events' and column_name='next_attempt_at';")"

sql "insert into restaurants (slug, name) values ('v46-r1','V46 R1');" >/dev/null
RID1="$(sql "select id from restaurants where slug='v46-r1';")"
OID1="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID1', 1, 'pickup', 10.00, 10.00, 'EUR') returning id;")"
as_service "$DB" "select transaction_id from initiate_payment_attempt('$OID1','monetico','ref-v46-a');" >/dev/null
FP_A="$(fp 'monetico|ref-v46-a|paid|1')"
EVT_A="$(as_service "$DB" "select id from record_payment_provider_event('monetico','ref-v46-a','$FP_A','paid',null,10.00,'EUR',null);")"
TOK_A="$(as_service "$DB" "select claim_token from claim_payment_provider_events(1, 60);")"

set +e
REJECT_OUTPUT="$(as_service "$DB" "select * from update_payment_provider_event_processing_status('$EVT_A','$TOK_A','failed_terminal','P0002_DETERMINISTIC');")"
set -e
if echo "$REJECT_OUTPUT" | grep -q "42501"; then
  pass "1b. SANS la migration forward : received -> failed_terminal REFUSÉ (42501) -- confirme que la migration forward est bien nécessaire"
else
  fail "1b. attendu un rejet 42501 sans la migration forward, obtenu: $REJECT_OUTPUT"
fi

log "=== [2] Application de la migration forward sur la base DÉJÀ installée ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_V46_FORWARD_SQL" >/dev/null
pass "2a. migration forward appliquée sans erreur sur une base P3-B5 DÉJÀ installée"

assert_eq "2a2. next_attempt_at PRÉSENTE après la migration forward (ferme P3BV44-FORWARD-PREDECESSOR-01)" "1" "$(sql "select count(*) from information_schema.columns where table_schema='public' and table_name='payment_provider_events' and column_name='next_attempt_at';")"
assert_eq "2a3. index d'éligibilité étendu présent (couvre next_attempt_at)" "1" "$(sql "select count(*) from pg_indexes where schemaname='public' and tablename='payment_provider_events' and indexname='idx_payment_provider_events_claimable' and indexdef ilike '%next_attempt_at%';")"

assert_eq "2c. table payment_provider_events non recréée -- toujours EXACTEMENT 1 ligne" "1" "$(sql "select count(*) from payment_provider_events;")"

assert_eq "2e. SECURITY DEFINER toujours vrai après remplacement" "t" "$(sql "select prosecdef from pg_proc where proname='update_payment_provider_event_processing_status';")"
assert_eq "2f. search_path='' toujours vrai après remplacement" "t" "$(sql "select 'search_path=\"\"' = any(proconfig) from pg_proc where proname='update_payment_provider_event_processing_status';")"
assert_eq "2g. anon n'a PAS EXECUTE" "f" "$(sql "select has_function_privilege('anon','update_payment_provider_event_processing_status(uuid,uuid,text,text)','execute');")"
assert_eq "2h. authenticated n'a PAS EXECUTE" "f" "$(sql "select has_function_privilege('authenticated','update_payment_provider_event_processing_status(uuid,uuid,text,text)','execute');")"
assert_eq "2i. service_role a bien EXECUTE" "t" "$(sql "select has_function_privilege('service_role','update_payment_provider_event_processing_status(uuid,uuid,text,text)','execute');")"

log "=== [3] Matrice comportementale A-N (RÉELLE, PostgreSQL) ==="

psql -X -A -q -t -d "$DB" -c "update payment_provider_events set claim_token=gen_random_uuid(), claim_expires_at=now()+interval '60 seconds' where id='$EVT_A';" >/dev/null
TOK_A3="$(sql "select claim_token from payment_provider_events where id='$EVT_A';")"
RESULT_A="$(as_service "$DB" "select processing_status from update_payment_provider_event_processing_status('$EVT_A','$TOK_A3','failed_terminal','P0002_DETERMINISTIC');")"
assert_eq "A. received -> failed_terminal : PASS" "failed_terminal" "$RESULT_A"

sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID1', 2, 'pickup', 10.00, 10.00, 'EUR');" >/dev/null
OID_B="$(sql "select id from orders where order_number=2 and restaurant_id='$RID1';")"
as_service "$DB" "select transaction_id from initiate_payment_attempt('$OID_B','monetico','ref-v46-b');" >/dev/null
FP_B="$(fp 'monetico|ref-v46-b|paid|1')"
EVT_B="$(as_service "$DB" "select id from record_payment_provider_event('monetico','ref-v46-b','$FP_B','paid',null,10.00,'EUR',null);")"
TOK_B="$(as_service "$DB" "select claim_token from claim_payment_provider_events(1, 60);")"
RESULT_B="$(as_service "$DB" "select processing_status from update_payment_provider_event_processing_status('$EVT_B','$TOK_B','failed_retryable','40001');")"
assert_eq "B. received -> failed_retryable : PASS" "failed_retryable" "$RESULT_B"

sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID1', 3, 'pickup', 10.00, 10.00, 'EUR');" >/dev/null
OID_C="$(sql "select id from orders where order_number=3 and restaurant_id='$RID1';")"
as_service "$DB" "select transaction_id from initiate_payment_attempt('$OID_C','monetico','ref-v46-c');" >/dev/null
FP_C="$(fp 'monetico|ref-v46-c|paid|1')"
EVT_C="$(as_service "$DB" "select id from record_payment_provider_event('monetico','ref-v46-c','$FP_C','paid',null,10.00,'EUR',null);")"
TOK_C="$(as_service "$DB" "select claim_token from claim_payment_provider_events(1, 60);")"
RESULT_C="$(as_service "$DB" "select processing_status from update_payment_provider_event_processing_status('$EVT_C','$TOK_C','applied',null);")"
assert_eq "C. received -> applied : PASS" "applied" "$RESULT_C"

sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID1', 4, 'pickup', 10.00, 10.00, 'EUR');" >/dev/null
OID_D="$(sql "select id from orders where order_number=4 and restaurant_id='$RID1';")"
as_service "$DB" "select transaction_id from initiate_payment_attempt('$OID_D','monetico','ref-v46-d');" >/dev/null
FP_D="$(fp 'monetico|ref-v46-d|paid|1')"
EVT_D="$(as_service "$DB" "select id from record_payment_provider_event('monetico','ref-v46-d','$FP_D','paid',null,10.00,'EUR',null);")"
TOK_D="$(as_service "$DB" "select claim_token from claim_payment_provider_events(1, 60);")"
RESULT_D="$(as_service "$DB" "select processing_status from update_payment_provider_event_processing_status('$EVT_D','$TOK_D','ignored',null);")"
assert_eq "D. received -> ignored : PASS" "ignored" "$RESULT_D"

sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID1', 5, 'pickup', 10.00, 10.00, 'EUR');" >/dev/null
OID_E="$(sql "select id from orders where order_number=5 and restaurant_id='$RID1';")"
as_service "$DB" "select transaction_id from initiate_payment_attempt('$OID_E','monetico','ref-v46-e');" >/dev/null
FP_E="$(fp 'monetico|ref-v46-e|paid|1')"
EVT_E="$(as_service "$DB" "select id from record_payment_provider_event('monetico','ref-v46-e','$FP_E','paid',null,10.00,'EUR',null);")"
TOK_E="$(as_service "$DB" "select claim_token from claim_payment_provider_events(1, 60);")"
set +e
RESULT_E="$(as_service "$DB" "select * from update_payment_provider_event_processing_status('$EVT_E','$TOK_E','received',null);")"
set -e
if echo "$RESULT_E" | grep -q "22023"; then
  pass "E. transition invalide (cible 'received') : REJETÉE, comme attendu"
else
  fail "E. transition invalide aurait dû être rejetée, obtenu: $RESULT_E"
fi

set +e
RESULT_F="$(as_service "$DB" "select * from update_payment_provider_event_processing_status('$EVT_C','$TOK_C','failed_retryable','x');")"
set -e
if echo "$RESULT_F" | grep -q "42501"; then
  pass "F. terminal (applied) -> failed_retryable : REJETÉE (verrouillage terminal)"
else
  fail "F. transition depuis terminal aurait dû être rejetée, obtenu: $RESULT_F"
fi

set +e
RESULT_G="$(as_service "$DB" "select * from update_payment_provider_event_processing_status('$EVT_B','00000000-0000-0000-0000-000000000000','applied',null);")"
set -e
if echo "$RESULT_G" | grep -q "P0004"; then
  pass "G. mauvais jeton de revendication : P0004"
else
  fail "G. mauvais jeton aurait dû être rejeté en P0004, obtenu: $RESULT_G"
fi

sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID1', 6, 'pickup', 10.00, 10.00, 'EUR');" >/dev/null
OID_H="$(sql "select id from orders where order_number=6 and restaurant_id='$RID1';")"
as_service "$DB" "select transaction_id from initiate_payment_attempt('$OID_H','monetico','ref-v46-h');" >/dev/null
FP_H="$(fp 'monetico|ref-v46-h|paid|1')"
EVT_H="$(as_service "$DB" "select id from record_payment_provider_event('monetico','ref-v46-h','$FP_H','paid',null,10.00,'EUR',null);")"
TOK_H="$(as_service "$DB" "select claim_token from claim_payment_provider_events(1, 60);")"
sql "update payment_provider_events set claim_expires_at = now() - interval '1 second' where id='$EVT_H';" >/dev/null
set +e
RESULT_H="$(as_service "$DB" "select * from update_payment_provider_event_processing_status('$EVT_H','$TOK_H','applied',null);")"
set -e
if echo "$RESULT_H" | grep -q "P0004"; then
  pass "H. bail expiré : REJETÉ (P0004)"
else
  fail "H. bail expiré aurait dû être rejeté en P0004, obtenu: $RESULT_H"
fi

TOK_H2="$(as_service "$DB" "select claim_token from claim_payment_provider_events(1, 60);")"
RESULT_I="$(as_service "$DB" "select processing_status from update_payment_provider_event_processing_status('$EVT_H','$TOK_H2','applied',null);")"
assert_eq "I. revendicant remplacé (nouveau bail après expiration) : PASS" "applied" "$RESULT_I"

assert_eq "J. évènement B (failed_retryable, next_attempt_at futur) NON revendicable immédiatement" "0" "$(sql "select count(*) from claim_payment_provider_events(100,60) where id='$EVT_B';")"

sql "update payment_provider_events set next_attempt_at = now() - interval '1 second' where id='$EVT_B';" >/dev/null
assert_eq "K. évènement B, next_attempt_at désormais passé : REVENDICABLE" "1" "$(sql "select count(*) from claim_payment_provider_events(100,60) where id='$EVT_B';")"

TOK_B2="$(sql "select claim_token from payment_provider_events where id='$EVT_B';")"
as_service "$DB" "select * from update_payment_provider_event_processing_status('$EVT_B','$TOK_B2','failed_retryable','40001_again');" >/dev/null
assert_eq "L. retry_count après 2e échec = 2" "2" "$(sql "select retry_count from payment_provider_events where id='$EVT_B';")"
assert_eq "L. next_attempt_at correspond au barème (120s, 2e tentative)" "t" "$(sql "select (next_attempt_at - now()) between interval '110 seconds' and interval '130 seconds' from payment_provider_events where id='$EVT_B';")"

for i in 3 4 5; do
  sql "update payment_provider_events set next_attempt_at = now() - interval '1 second' where id='$EVT_B';" >/dev/null
  TOK_LOOP="$(as_service "$DB" "select claim_token from claim_payment_provider_events(1,60);")"
  as_service "$DB" "select * from update_payment_provider_event_processing_status('$EVT_B','$TOK_LOOP','failed_retryable','40001_loop');" >/dev/null
done
assert_eq "M(a). retry_count après 5 échecs = 5" "5" "$(sql "select retry_count from payment_provider_events where id='$EVT_B';")"
sql "update payment_provider_events set next_attempt_at = now() - interval '1 second' where id='$EVT_B';" >/dev/null
TOK_ESCALATE="$(as_service "$DB" "select claim_token from claim_payment_provider_events(1,60);")"
RESULT_M="$(as_service "$DB" "select processing_status from update_payment_provider_event_processing_status('$EVT_B','$TOK_ESCALATE','failed_retryable','40001_sixth');")"
assert_eq "M(b). 6e échec (retry_count courant=5 >= plafond) : ESCALADE RÉELLE vers failed_terminal" "failed_terminal" "$RESULT_M"
assert_eq "M(c). retry_count reste à 5 après escalade" "5" "$(sql "select retry_count from payment_provider_events where id='$EVT_B';")"

for i in $(seq 1 15); do
  sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID1', 100+$i, 'pickup', 5.00, 5.00, 'EUR');" >/dev/null
  OID_P="$(sql "select id from orders where order_number=100+$i and restaurant_id='$RID1';")"
  as_service "$DB" "select transaction_id from initiate_payment_attempt('$OID_P','monetico','ref-poison-$i');" >/dev/null
  FP_P="$(fp "monetico|ref-poison-$i|refused|1")"
  EVT_P="$(as_service "$DB" "select id from record_payment_provider_event('monetico','ref-poison-$i','$FP_P','refused',null,5.00,'EUR',null);")"
  TOK_P="$(as_service "$DB" "select claim_token from claim_payment_provider_events(1,60);")"
  as_service "$DB" "select * from update_payment_provider_event_processing_status('$EVT_P','$TOK_P','failed_terminal','poison');" >/dev/null
done
for i in $(seq 1 5); do
  sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID1', 200+$i, 'pickup', 5.00, 5.00, 'EUR');" >/dev/null
  OID_P2="$(sql "select id from orders where order_number=200+$i and restaurant_id='$RID1';")"
  as_service "$DB" "select transaction_id from initiate_payment_attempt('$OID_P2','monetico','ref-poison-future-$i');" >/dev/null
  FP_P2="$(fp "monetico|ref-poison-future-$i|refused|1")"
  EVT_P2="$(as_service "$DB" "select id from record_payment_provider_event('monetico','ref-poison-future-$i','$FP_P2','refused',null,5.00,'EUR',null);")"
  TOK_P2="$(as_service "$DB" "select claim_token from claim_payment_provider_events(1,60);")"
  as_service "$DB" "select * from update_payment_provider_event_processing_status('$EVT_P2','$TOK_P2','failed_retryable','transient_future');" >/dev/null
done
sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID1', 999, 'pickup', 5.00, 5.00, 'EUR');" >/dev/null
OID_LEGIT="$(sql "select id from orders where order_number=999 and restaurant_id='$RID1';")"
as_service "$DB" "select transaction_id from initiate_payment_attempt('$OID_LEGIT','monetico','ref-legit');" >/dev/null
FP_LEGIT="$(fp 'monetico|ref-legit|paid|1')"
EVT_LEGIT="$(as_service "$DB" "select id from record_payment_provider_event('monetico','ref-legit','$FP_LEGIT','paid',null,5.00,'EUR',null);")"

CLAIMED_BATCH="$(as_service "$DB" "select count(*) from claim_payment_provider_events(20,60);")"
assert_eq "N. sur un batch de taille 20, exactement 1 évènement éligible revendiqué" "1" "$CLAIMED_BATCH"
assert_eq "N. l'évènement revendiqué est bien le légitime" "1" "$(sql "select count(*) from payment_provider_events where id='$EVT_LEGIT' and claim_token is not null;")"

# ============================================================
# PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.6 -- ferme
# P3BV45-ROLLBACK-EXECUTION-01 (mandat §8, "no report-only evidence").
#
# PREUVE OBLIGATOIRE D'ÉCHEC INJECTÉ DANS CE HARNAIS LIVRÉ LUI-MÊME --
# jamais seulement un rapport narratif. Construit une base FRAÎCHE
# avec le VRAI prédécesseur historique installé, applique une COPIE
# de la migration forward dont le postcheck a été délibérément cassé
# (assertion toujours fausse), et prouve que la transaction ENTIÈRE
# (DDL + fonctions + ACL compris) est annulée -- rien ne persiste.
# ============================================================
log "=== [ROLLBACK] Preuve d'annulation transactionnelle complète (échec de postcheck injecté) ==="
DB_ROLLBACK="scanym_payment_v46_rollback_$$"
psql -c "drop database if exists \"$DB_ROLLBACK\";" >/dev/null 2>&1 || true
createdb "$DB_ROLLBACK"
build_full_chain_through_p3b5 "$DB_ROLLBACK"

BROKEN_MIGRATION="/tmp/scanym-v46-broken-migration-$$.sql"
# Copie la migration réelle, remplace UNIQUEMENT la condition du
# premier postcheck déterministe par une condition TOUJOURS vraie
# (déclenche systématiquement SCANYM_SCHEMA_DRIFT juste avant COMMIT,
# APRÈS que tout le DDL/fonctions/ACL a déjà été exécuté dans la MÊME
# transaction).
python3 -c "
import re
with open('$DRAFT_PAYMENT_V46_FORWARD_SQL') as f:
    content = f.read()
content = content.replace(
    '''if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payment_provider_events'
      and column_name = 'next_attempt_at' and data_type = 'timestamp with time zone'
  ) then''',
    'if true then'
)
with open('$BROKEN_MIGRATION', 'w') as f:
    f.write(content)
"

set +e
ROLLBACK_OUTPUT="$(psql -v VERBOSITY=verbose -d "$DB_ROLLBACK" -v ON_ERROR_STOP=1 -f "$BROKEN_MIGRATION" 2>&1)"
ROLLBACK_RC=$?
set -e
rm -f "$BROKEN_MIGRATION"

if [ "$ROLLBACK_RC" -ne 0 ] && echo "$ROLLBACK_OUTPUT" | grep -q "SCANYM_SCHEMA_DRIFT"; then
  pass "ROLLBACK-1. migration forcée à échouer au postcheck : sort avec un code de sortie NON-ZÉRO (rc=$ROLLBACK_RC), comme exigé"
else
  fail "ROLLBACK-1. attendu un échec SCANYM_SCHEMA_DRIFT avec rc!=0, obtenu rc=$ROLLBACK_RC: $ROLLBACK_OUTPUT"
fi

assert_eq "ROLLBACK-2. next_attempt_at ABSENTE après l'échec forcé (rollback transactionnel complet du DDL)" "0" "$(sql_db "$DB_ROLLBACK" "select count(*) from information_schema.columns where table_schema='public' and table_name='payment_provider_events' and column_name='next_attempt_at';")"
assert_eq "ROLLBACK-3. index d'éligibilité étendu ABSENT après l'échec forcé" "0" "$(sql_db "$DB_ROLLBACK" "select count(*) from pg_indexes where schemaname='public' and tablename='payment_provider_events' and indexname='idx_payment_provider_events_claimable' and indexdef ilike '%next_attempt_at%';")"
assert_eq "ROLLBACK-4. update_payment_provider_event_processing_status inchangée -- ne référence PAS next_attempt_at dans son corps après l'échec forcé" "0" "$(sql_db "$DB_ROLLBACK" "select (case when (select prosrc from pg_proc where proname='update_payment_provider_event_processing_status') ilike '%next_attempt_at%' then 1 else 0 end);")"

# Prédécesseur historique toujours pleinement fonctionnel après le
# rollback (aucune corruption résiduelle).
sql_db "$DB_ROLLBACK" "insert into restaurants (slug, name) values ('v46-rollback-r1','V46 Rollback R1');" >/dev/null
RID_RB="$(sql_db "$DB_ROLLBACK" "select id from restaurants where slug='v46-rollback-r1';")"
OID_RB="$(sql_db "$DB_ROLLBACK" "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_RB', 1, 'pickup', 10.00, 10.00, 'EUR') returning id;")"
as_service "$DB_ROLLBACK" "select transaction_id from initiate_payment_attempt('$OID_RB','monetico','ref-rollback-a');" >/dev/null
FP_RB="$(fp 'monetico|ref-rollback-a|paid|1')"
EVT_RB="$(as_service "$DB_ROLLBACK" "select id from record_payment_provider_event('monetico','ref-rollback-a','$FP_RB','paid',null,10.00,'EUR',null);")"
TOK_RB="$(as_service "$DB_ROLLBACK" "select claim_token from claim_payment_provider_events(1, 60);")"
RESULT_RB="$(as_service "$DB_ROLLBACK" "select processing_status from update_payment_provider_event_processing_status('$EVT_RB','$TOK_RB','applied',null);")"
assert_eq "ROLLBACK-5. le prédécesseur historique reste PLEINEMENT FONCTIONNEL après l'échec forcé -- aucune corruption résiduelle" "applied" "$RESULT_RB"

psql -c "drop database if exists \"$DB_ROLLBACK\";" >/dev/null 2>&1 || true

log "=== BILAN : $PASS_COUNT PASS / $FAIL_COUNT FAIL ==="
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "--- ÉCHECS ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
