#!/usr/bin/env bash
# ============================================================
# Scanym — PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4 — Harnais
# reproductible pour
# supabase/DRAFT-lot-payment-p3b-monetico-checkout-runtime-v4.sql.
#
# PostgreSQL communautaire vanilla, même patron que tous les harnais
# paiement précédents (P1..P3-B MONETICO CHECKOUT RUNTIME v3). Chaîne
# complète (minimale + P1 + Vault moqué + P2A + P2B-A + P3-A0 +
# P3-B0..P3-B6 + PAYMENT P3-B MONETICO CHECKOUT RUNTIME v3, toutes déjà
# publiées) + le LOT SOUS TEST (v4 : get_order_service_mode +
# claim_payment_provider_event_by_id).
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/payment-p3b-monetico-checkout-runtime-v4-check.sh"
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
DRAFT_PAYMENT_P3B6_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b6-checkout-billing-context.sql"
DRAFT_PAYMENT_V3_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b-monetico-checkout-runtime-v3.sql"
DRAFT_PAYMENT_V4_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b-monetico-checkout-runtime-v4.sql"
DB="scanym_payment_p3bmcr_v4_$$"
DB_DRIFT="scanym_payment_p3bmcr_v4_drift_$$"

PASS_COUNT=0
FAIL_COUNT=0
STRUCT_COUNT=0
BEHAV_COUNT=0
FAIL_LOG="/tmp/scanym-payment-p3bmcr-v4-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }
struct() { STRUCT_COUNT=$((STRUCT_COUNT+1)); pass "$@"; }
behav() { BEHAV_COUNT=$((BEHAV_COUNT+1)); pass "$@"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
  rm -f "${FAIL_LOG:-}" 2>/dev/null || true
}
trap cleanup EXIT

assert_struct_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then struct "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_behav_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then behav "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}

sql() { psql -X -A -q -t -d "$DB" -c "$1"; }

as_service() {
  local query="$1"
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$query" 2>&1
}
as_service_rc() {
  local query="$1"
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p3bmcr-v4-out-$$.txt 2>/tmp/scanym-p3bmcr-v4-err-$$.txt
  echo $?
}
as_anon() {
  local query="$1"
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$query" 2>&1
}
as_anon_rc() {
  local query="$1"
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p3bmcr-v4-out-$$.txt 2>/tmp/scanym-p3bmcr-v4-err-$$.txt
  echo $?
}
as_authenticated_rc() {
  local uid="$1" query="$2"
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$uid'; $query" >/tmp/scanym-p3bmcr-v4-out-$$.txt 2>/tmp/scanym-p3bmcr-v4-err-$$.txt
  echo $?
}

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

# MOCK VAULT — TEST HARNESS ONLY.
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

build_full_chain_through_v3() {
  local dbname="$1"
  build_common_bootstrap "$dbname"
  build_minimal_chain "$dbname"
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v83-lot2a4-privilege-hardening.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v84-lot2b1-delivery-info-rpc.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-model.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-lot-b-rpc.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-server-delivery-fulfillment-pricing.sql" >/dev/null
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
  # PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.6 -- ferme
  # P3BV45-SQL-INSTALL-CHAIN-01 : migration forward appliquée
  # EXPLICITEMENT ici, avant P3-B6/v3/v4 -- ceux-ci référencent déjà
  # next_attempt_at (claim_payment_provider_event_by_id, v4.sql).
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_V46_FORWARD_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B6_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_V3_SQL" >/dev/null
}

fp() {
  echo -n "$1" | sha256sum | cut -d' ' -f1
}

# ============================================================
# [0] BASELINE — chaîne complète jusqu'à PAYMENT P3-B MONETICO CHECKOUT
# RUNTIME v3 (toutes déjà publiées) + le LOT SOUS TEST (v4).
# ============================================================
log "=== [0] Construction baseline $DB ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
build_full_chain_through_v3 "$DB"
struct "chaîne complète appliquée (minimale + P1 + Vault moqué + P2A + P2B-A + P3-A0 + P3-B0..P3-B6 + PAYMENT P3-B MONETICO CHECKOUT RUNTIME v3)"

psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_V4_SQL" >/dev/null
struct "DRAFT-lot-payment-p3b-monetico-checkout-runtime-v4.sql appliqué sans erreur (LOT SOUS TEST)"

# ============================================================
# [D] ANTI DOUBLE-APPLICATION + DÉRIVE SCHÉMA.
# ============================================================
log "=== [D] Anti double-application ==="
RC_DOUBLE_APPLY="$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_V4_SQL" >/tmp/scanym-p3bmcr-v4-double-$$.txt 2>&1; echo $?)"
assert_behav_eq "Da. seconde application du lot v4 refusée (RC != 0)" "1" "$([ "$RC_DOUBLE_APPLY" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "Db. message SCANYM_SCHEMA_DRIFT présent dans le refus" "1" "$(grep -c 'SCANYM_SCHEMA_DRIFT' /tmp/scanym-p3bmcr-v4-double-$$.txt || true)"
rm -f /tmp/scanym-p3bmcr-v4-double-$$.txt

log "=== [D] DÉRIVE — chaîne SANS PAYMENT P3-B5 (claim_payment_provider_events absent) ==="
psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
createdb "$DB_DRIFT"
build_common_bootstrap "$DB_DRIFT"
build_minimal_chain "$DB_DRIFT"
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" >/dev/null
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P1_SQL" >/dev/null
RC_DRIFT_NO_P3B5="$(psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_V4_SQL" >/tmp/scanym-p3bmcr-v4-drift-$$.txt 2>&1; echo $?)"
assert_behav_eq "Dc. application refusée sans PAYMENT P3-B5 (payment_provider_events/claim_payment_provider_events absents) -- RC != 0" "1" "$([ "$RC_DRIFT_NO_P3B5" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "Dd. message SCANYM_SCHEMA_DRIFT présent dans le refus" "1" "$(grep -c 'SCANYM_SCHEMA_DRIFT' /tmp/scanym-p3bmcr-v4-drift-$$.txt || true)"
rm -f /tmp/scanym-p3bmcr-v4-drift-$$.txt
psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true

# ============================================================
# [1] STRUCTUREL — get_order_service_mode.
# ============================================================
log "=== [1] STRUCTUREL — get_order_service_mode ==="
assert_struct_eq "1a. la fonction existe avec la signature exacte (2 arguments uuid,uuid)" "1" "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_order_service_mode' and p.pronargs=2 and array(select unnest(p.proargtypes))=array['uuid','uuid']::regtype[]::oid[];")"
assert_struct_eq "1b. SECURITY DEFINER" "t" "$(sql "select prosecdef from pg_proc where proname='get_order_service_mode' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1c. langage = sql" "sql" "$(sql "select l.lanname from pg_proc p join pg_language l on l.oid=p.prolang where p.proname='get_order_service_mode' and p.pronamespace='public'::regnamespace;")"
assert_struct_eq "1d. volatilité = stable (LECTURE PURE)" "s" "$(sql "select provolatile from pg_proc where proname='get_order_service_mode' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1e. search_path explicitement vide" "1" "$(sql "select count(*) from pg_proc where proname='get_order_service_mode' and pronamespace='public'::regnamespace and 'search_path=\"\"' = any(proconfig);")"
assert_struct_eq "1f. EXECUTE effectif service_role = OUI" "t" "$(sql "select has_function_privilege('service_role', 'public.get_order_service_mode(uuid,uuid)', 'execute');")"
assert_struct_eq "1g. EXECUTE effectif anon = NON (jamais côté navigateur, mandat P3B-V4-SHIPPING-AUTHORITY-01)" "f" "$(sql "select has_function_privilege('anon', 'public.get_order_service_mode(uuid,uuid)', 'execute');")"
assert_struct_eq "1h. EXECUTE effectif authenticated = NON" "f" "$(sql "select has_function_privilege('authenticated', 'public.get_order_service_mode(uuid,uuid)', 'execute');")"
assert_struct_eq "1i. AUCUN grant EXECUTE résiduel à PUBLIC" "0" "$(sql "select count(*) from information_schema.role_routine_grants where routine_schema='public' and routine_name='get_order_service_mode' and grantee='PUBLIC';")"
assert_struct_eq "1j. CONTRAT -- retourne EXACTEMENT 1 colonne : service_mode" "service_mode" "$(sql "select array_to_string(proargnames[array_position(proargmodes,'t'::\"char\"):array_length(proargmodes,1)], ',') from pg_proc where proname='get_order_service_mode' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1k. les 2 SEULS arguments IN sont p_order_id,p_public_token" "p_order_id,p_public_token" "$(sql "select array_to_string(proargnames[1:array_position(proargmodes,'t'::\"char\")-1], ',') from pg_proc where proname='get_order_service_mode' and pronamespace='public'::regnamespace;")"

# ============================================================
# [2] COMPORTEMENTAL — get_order_service_mode.
# ============================================================
log "=== [2] COMPORTEMENTAL — get_order_service_mode ==="
OWNER_UID="40000000-0000-0000-0000-000000000001"
psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into auth.users (id, email) values ('$OWNER_UID', 'owner@p3bmcr-v4-fixture.test');
insert into restaurants (name, slug, status) values
  ('P3BMCR v4 Fixture Tenant One', 'p3bmcr-v4-fixture-tenant-one', 'active'),
  ('P3BMCR v4 Fixture Tenant Two', 'p3bmcr-v4-fixture-tenant-two', 'active');
SQL
RID_ONE="$(sql "select id from restaurants where slug='p3bmcr-v4-fixture-tenant-one';")"
RID_TWO="$(sql "select id from restaurants where slug='p3bmcr-v4-fixture-tenant-two';")"
psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into restaurant_users (restaurant_id, user_id, role) values ('$RID_ONE','$OWNER_UID','owner');" >/dev/null

ORDER_PICKUP="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 1, 'pickup', 12.50, 12.50, 'EUR') returning id;")"
ORDER_DELIVERY="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, delivery_fee, total, currency) values ('$RID_ONE', 2, 'delivery', 20.00, 5.00, 25.00, 'EUR') returning id;")"
ORDER_OTHER_TENANT="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_TWO', 1, 'pickup', 9.00, 9.00, 'EUR') returning id;")"
TOKEN_PICKUP="$(sql "select public_token from orders where id='$ORDER_PICKUP';")"
TOKEN_DELIVERY="$(sql "select public_token from orders where id='$ORDER_DELIVERY';")"
TOKEN_OTHER="$(sql "select public_token from orders where id='$ORDER_OTHER_TENANT';")"

OUT_PICKUP="$(as_service "select service_mode from public.get_order_service_mode('$ORDER_PICKUP','$TOKEN_PICKUP');")"
assert_behav_eq "2a. commande pickup, possession valide -> service_mode='pickup'" "pickup" "$OUT_PICKUP"
OUT_DELIVERY="$(as_service "select service_mode from public.get_order_service_mode('$ORDER_DELIVERY','$TOKEN_DELIVERY');")"
assert_behav_eq "2b. commande delivery, possession valide -> service_mode='delivery'" "delivery" "$OUT_DELIVERY"

ROWCOUNT_WRONG_TOKEN="$(as_service "select count(*) from public.get_order_service_mode('$ORDER_PICKUP','$TOKEN_DELIVERY');")"
assert_behav_eq "2c. mauvais jeton (même tenant, autre commande) -> AUCUNE ligne" "0" "$ROWCOUNT_WRONG_TOKEN"
ROWCOUNT_CROSS_TENANT="$(as_service "select count(*) from public.get_order_service_mode('$ORDER_OTHER_TENANT','$TOKEN_PICKUP');")"
assert_behav_eq "2d. jeton d'un autre tenant sur commande d'un tenant différent -> AUCUNE ligne (isolation cross-tenant)" "0" "$ROWCOUNT_CROSS_TENANT"
RANDOM_ORDER_ID="00000000-0000-0000-0000-000000000000"
ROWCOUNT_UNKNOWN_ORDER="$(as_service "select count(*) from public.get_order_service_mode('$RANDOM_ORDER_ID','$TOKEN_PICKUP');")"
assert_behav_eq "2e. order_id inconnu -> AUCUNE ligne" "0" "$ROWCOUNT_UNKNOWN_ORDER"
ROWCOUNT_NULL_BOTH="$(as_service "select count(*) from public.get_order_service_mode(null,null);")"
assert_behav_eq "2f. arguments NULL des deux côtés -> AUCUNE ligne (jamais une exception distincte)" "0" "$ROWCOUNT_NULL_BOTH"

RC_ANON="$(as_anon_rc "select * from public.get_order_service_mode('$ORDER_PICKUP','$TOKEN_PICKUP');")"
assert_behav_eq "2g. anon EXECUTE refusé (permission denied) même avec possession valide" "1" "$([ "$RC_ANON" != "0" ] && echo 1 || echo 0)"
RC_AUTH="$(as_authenticated_rc "$OWNER_UID" "select * from public.get_order_service_mode('$ORDER_PICKUP','$TOKEN_PICKUP');")"
assert_behav_eq "2h. authenticated (staff du restaurant) EXECUTE refusé (permission denied)" "1" "$([ "$RC_AUTH" != "0" ] && echo 1 || echo 0)"

SM_BEFORE="$(sql "select service_mode from orders where id='$ORDER_PICKUP';")"
as_service "select * from public.get_order_service_mode('$ORDER_PICKUP','$TOKEN_PICKUP');" >/dev/null
as_service "select * from public.get_order_service_mode('$ORDER_PICKUP','$TOKEN_DELIVERY');" >/dev/null
SM_AFTER="$(sql "select service_mode from orders where id='$ORDER_PICKUP';")"
assert_behav_eq "2i. AUCUNE MUTATION -- service_mode inchangé après appels répétés (valides et invalides)" "$SM_BEFORE" "$SM_AFTER"

# ============================================================
# [3] STRUCTUREL — claim_payment_provider_event_by_id.
# ============================================================
log "=== [3] STRUCTUREL — claim_payment_provider_event_by_id ==="
assert_struct_eq "3a. la fonction existe avec la signature exacte (2 arguments, 1 avec défaut)" "1" "$(sql "select count(*) from pg_proc where proname='claim_payment_provider_event_by_id' and pronargs=2;")"
assert_struct_eq "3b. pronargdefaults=1 (p_lease_seconds a un défaut, p_event_id non)" "1" "$(sql "select pronargdefaults from pg_proc where proname='claim_payment_provider_event_by_id';")"
assert_struct_eq "3c. SECURITY DEFINER" "t" "$(sql "select prosecdef from pg_proc where proname='claim_payment_provider_event_by_id';")"
assert_struct_eq "3d. langage = plpgsql" "plpgsql" "$(sql "select l.lanname from pg_proc p join pg_language l on l.oid=p.prolang where p.proname='claim_payment_provider_event_by_id';")"
assert_struct_eq "3e. volatilité = volatile (pose un bail -- MUTATION)" "v" "$(sql "select provolatile from pg_proc where proname='claim_payment_provider_event_by_id';")"
assert_struct_eq "3f. search_path explicitement vide" "1" "$(sql "select ('search_path=' = any(proconfig) or 'search_path=\"\"' = any(proconfig))::int from pg_proc where proname='claim_payment_provider_event_by_id';")"
assert_struct_eq "3g. EXECUTE effectif service_role = OUI" "t" "$(sql "select has_function_privilege('service_role','claim_payment_provider_event_by_id(uuid,integer)','EXECUTE');")"
assert_struct_eq "3h. EXECUTE effectif anon = NON" "f" "$(sql "select has_function_privilege('anon','claim_payment_provider_event_by_id(uuid,integer)','EXECUTE');")"
assert_struct_eq "3i. EXECUTE effectif authenticated = NON" "f" "$(sql "select has_function_privilege('authenticated','claim_payment_provider_event_by_id(uuid,integer)','EXECUTE');")"
assert_struct_eq "3j. AUCUN grant EXECUTE résiduel à PUBLIC" "0" "$(sql "select has_function_privilege('public','claim_payment_provider_event_by_id(uuid,integer)','EXECUTE')::int;")"
assert_struct_eq "3k. CONTRAT DE SORTIE -- 16 colonnes, IDENTIQUES à claim_payment_provider_events" "id,restaurant_id,order_id,payment_transaction_id,provider_code,provider_reference,event_fingerprint,provider_event_type,provider_event_code,amount,currency,authorization_reference,processing_status,retry_count,claim_token,claim_expires_at" "$(sql "select string_agg(u.argname, ',' order by u.ord) from pg_proc p, lateral (select argname, ord from unnest(p.proargnames, p.proargmodes) with ordinality as x(argname, argmode, ord) where argmode='t') u where p.proname='claim_payment_provider_event_by_id';")"
assert_struct_eq "3l. le corps utilise FOR UPDATE SKIP LOCKED" "1" "$(sql "select (case when (select prosrc from pg_proc where proname='claim_payment_provider_event_by_id') ~* 'for update skip locked' then 1 else 0 end);")"
assert_struct_eq "3m. AUCUN SQL dynamique (EXECUTE/format() absent du corps)" "0" "$(sql "select (case when (select prosrc from pg_proc where proname='claim_payment_provider_event_by_id') ~* 'execute |format\(' then 1 else 0 end);")"

# ============================================================
# [4] COMPORTEMENTAL — claim_payment_provider_event_by_id.
# ============================================================
log "=== [4] COMPORTEMENTAL — claim_payment_provider_event_by_id ==="
# record_payment_provider_event (PAYMENT P3-B5, INCHANGÉE) exige une
# corrélation PRÉALABLE avec une tentative de paiement existante
# (échec fermé sinon) -- chaque évènement de ce bloc a donc SA PROPRE
# commande + tentative initiée via initiate_payment_attempt (P1)
# AVANT tout enregistrement d'évènement, exactement comme un callback
# Monetico réel arrive toujours après une initiation de checkout.
ORDER_EVT1="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 10, 'pickup', 25.00, 25.00, 'EUR') returning id;")"
as_service "select * from initiate_payment_attempt('$ORDER_EVT1','monetico','ref-p3bmcr-v4-1');" >/dev/null

FP1="$(fp 'monetico|ref-p3bmcr-v4-1|byid1')"
EVT1="$(as_service "select id from record_payment_provider_event('monetico','ref-p3bmcr-v4-1','$FP1','paid','paiement',25.00,'EUR',null);")"

CLAIMED_ROW="$(as_service "select id, claim_token from claim_payment_provider_event_by_id('$EVT1', 60);")"
CLAIMED_ID="$(echo "$CLAIMED_ROW" | cut -d'|' -f1)"
CLAIM_TOKEN="$(echo "$CLAIMED_ROW" | cut -d'|' -f2)"
assert_behav_eq "4a. revendication d'un évènement 'received' éligible -> id RETOURNÉ EXACTEMENT" "$EVT1" "$CLAIMED_ID"
assert_behav_eq "4b. claim_token NON vide retourné" "1" "$([ -n "$CLAIM_TOKEN" ] && echo 1 || echo 0)"

ROWCOUNT_SECOND_CLAIM="$(as_service "select count(*) from claim_payment_provider_event_by_id('$EVT1', 60);")"
assert_behav_eq "4c. un second appel immédiat sur le MÊME id -> AUCUNE ligne (bail non expiré, déjà revendiqué)" "0" "$ROWCOUNT_SECOND_CLAIM"

ROWCOUNT_BATCH_AFTER_BYID_CLAIM="$(as_service "select count(*) from claim_payment_provider_events(10, 60) where id='$EVT1';")"
assert_behav_eq "4d. l'évènement revendiqué par id N'EST PLUS revendicable par le lot générique (MÊME politique d'éligibilité/bail que claim_payment_provider_events, partagée)" "0" "$ROWCOUNT_BATCH_AFTER_BYID_CLAIM"

as_service "select update_payment_provider_event_processing_status('$EVT1', '$CLAIM_TOKEN', 'applied', null);" >/dev/null
ROWCOUNT_AFTER_APPLIED="$(as_service "select count(*) from claim_payment_provider_event_by_id('$EVT1', 60);")"
assert_behav_eq "4e. après finalisation 'applied' (terminal), une NOUVELLE revendication par id -> AUCUNE ligne (jamais un second traitement d'un évènement déjà appliqué)" "0" "$ROWCOUNT_AFTER_APPLIED"

RC_UNKNOWN_ID="$(as_service_rc "select * from claim_payment_provider_event_by_id('00000000-0000-0000-0000-000000000000', 60);")"
assert_behav_eq "4f. id inexistant -> AUCUNE erreur (RC=0, ensemble vide, jamais une exception)" "0" "$RC_UNKNOWN_ID"
ROWCOUNT_UNKNOWN_ID="$(as_service "select count(*) from claim_payment_provider_event_by_id('00000000-0000-0000-0000-000000000000', 60);")"
assert_behav_eq "4g. id inexistant -> AUCUNE ligne" "0" "$ROWCOUNT_UNKNOWN_ID"

RC_NULL_ID="$(as_service_rc "select * from claim_payment_provider_event_by_id(null, 60);")"
assert_behav_eq "4h. p_event_id NULL -> AUCUNE erreur (RC=0, ensemble vide)" "0" "$RC_NULL_ID"

RC_LEASE_TOO_LOW="$(as_service_rc "select * from claim_payment_provider_event_by_id('$EVT1', 4);")"
assert_behav_eq "4i. p_lease_seconds=4 -> échec fermé (même borne que claim_payment_provider_events)" "1" "$([ "$RC_LEASE_TOO_LOW" != "0" ] && echo 1 || echo 0)"
RC_LEASE_TOO_HIGH="$(as_service_rc "select * from claim_payment_provider_event_by_id('$EVT1', 3601);")"
assert_behav_eq "4j. p_lease_seconds=3601 -> échec fermé" "1" "$([ "$RC_LEASE_TOO_HIGH" != "0" ] && echo 1 || echo 0)"

ORDER_EVT2="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 11, 'pickup', 10.00, 10.00, 'EUR') returning id;")"
as_service "select * from initiate_payment_attempt('$ORDER_EVT2','monetico','ref-p3bmcr-v4-2');" >/dev/null
FP2="$(fp 'monetico|ref-p3bmcr-v4-2|byid2')"
EVT2="$(as_service "select id from record_payment_provider_event('monetico','ref-p3bmcr-v4-2','$FP2','paid','paiement',10.00,'EUR',null);")"
RC_DEFAULT_LEASE="$(as_service_rc "select * from claim_payment_provider_event_by_id('$EVT2');")"
assert_behav_eq "4k. appel SANS p_lease_seconds -> défaut (60) appliqué, aucune erreur" "0" "$RC_DEFAULT_LEASE"

RC_ANON_CLAIM="$(as_anon_rc "select * from claim_payment_provider_event_by_id('$EVT2', 60);")"
assert_behav_eq "4l. anon NE PEUT PAS exécuter claim_payment_provider_event_by_id" "1" "$([ "$RC_ANON_CLAIM" != "0" ] && echo 1 || echo 0)"
RC_AUTH_CLAIM="$(as_authenticated_rc "$OWNER_UID" "select * from claim_payment_provider_event_by_id('$EVT2', 60);")"
assert_behav_eq "4m. authenticated NE PEUT PAS exécuter claim_payment_provider_event_by_id" "1" "$([ "$RC_AUTH_CLAIM" != "0" ] && echo 1 || echo 0)"

log "=== [4bis] REPRISE APRÈS EXPIRATION DE BAIL ==="
ORDER_EVT3="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 12, 'pickup', 5.00, 5.00, 'EUR') returning id;")"
as_service "select * from initiate_payment_attempt('$ORDER_EVT3','monetico','ref-p3bmcr-v4-3');" >/dev/null
FP3="$(fp 'monetico|ref-p3bmcr-v4-3|byid3')"
EVT3="$(as_service "select id from record_payment_provider_event('monetico','ref-p3bmcr-v4-3','$FP3','paid','paiement',5.00,'EUR',null);")"
as_service "select id from claim_payment_provider_event_by_id('$EVT3', 60);" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -c "update payment_provider_events set claim_expires_at = now() - interval '1 second' where id='$EVT3';" >/dev/null
ROWCOUNT_AFTER_EXPIRY="$(as_service "select count(*) from claim_payment_provider_event_by_id('$EVT3', 60);")"
assert_behav_eq "4bis-a. bail expiré (superutilisateur de test simule le passage du temps) -> à nouveau revendicable" "1" "$ROWCOUNT_AFTER_EXPIRY"

# ============================================================
# [5] NON-RÉGRESSION — capacités sœurs P1..v3 INCHANGÉES.
# ============================================================
log "=== [5] NON-RÉGRESSION ==="
RC_CLAIM_BATCH_STILL_WORKS="$(as_service_rc "select * from claim_payment_provider_events(10, 60);")"
assert_behav_eq "5a. claim_payment_provider_events (P3-B5 v2) toujours réellement fonctionnelle" "0" "$RC_CLAIM_BATCH_STILL_WORKS"
assert_struct_eq "5b. orders : AUCUN grant de table nouveau à service_role (architecture RPC-only préservée)" "f" "$(sql "select has_table_privilege('service_role','orders','SELECT');")"
assert_struct_eq "5c. payment_provider_events : AUCUN grant de table nouveau à service_role" "f" "$(sql "select has_table_privilege('service_role','payment_provider_events','SELECT');")"
assert_behav_eq "5d. get_order_payment_status(P1) toujours réellement fonctionnelle (EXECUTE anon, contrat CLIENT public inchangé)" "not_required" "$(as_anon "select payment_status from public.get_order_payment_status('$ORDER_PICKUP','$TOKEN_PICKUP');")"
RC_SNAPSHOT_STILL_WORKS="$(as_service_rc "select * from public.get_order_payment_status_snapshot('$ORDER_PICKUP','$TOKEN_PICKUP');")"
assert_behav_eq "5e. get_order_payment_status_snapshot (v3, service_role UNIQUEMENT) toujours réellement fonctionnelle" "0" "$RC_SNAPSHOT_STILL_WORKS"

# ============================================================
# INVARIANT FINAL DU HARNAIS.
# ============================================================
log "=== [FIN] BILAN ==="
log "PASS=$PASS_COUNT (struct=$STRUCT_COUNT, behav=$BEHAV_COUNT) FAIL=$FAIL_COUNT"
if [ "$((STRUCT_COUNT + BEHAV_COUNT))" -ne "$PASS_COUNT" ]; then
  echo "HARNAIS INCOHÉRENT : STRUCT_COUNT+BEHAV_COUNT != PASS_COUNT" >&2
  exit 1
fi
if [ "$FAIL_COUNT" -ne 0 ]; then
  echo "----- ÉCHECS -----"
  cat "$FAIL_LOG"
  exit 1
fi
echo "TOUS LES TESTS ONT RÉUSSI : $PASS_COUNT/$PASS_COUNT ($STRUCT_COUNT structurels + $BEHAV_COUNT comportementaux)"
