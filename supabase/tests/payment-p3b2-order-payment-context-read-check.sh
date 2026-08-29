#!/usr/bin/env bash
# ============================================================
# Scanym — PAYMENT P3-B2 — ORDER PAYMENT CONTEXT READ — Harnais
# reproductible pour
# supabase/DRAFT-lot-payment-p3b2-order-payment-context-read.sql.
#
# PostgreSQL communautaire vanilla (pas une instance Supabase managée),
# même patron que tous les harnais paiement précédents (P1/P2A/P2B-A/
# P3-A0/P3-B0/P3-B1) : rôles anon/authenticated/service_role recréés
# minimalement, auth.uid() simulé via `test.uid`.
#
# Chaîne (mandat section 26, "no unpublished dependency") : chaîne
# minimale (schema.sql .. migration-v81-lot1b-translations.sql) ->
# DRAFT-lot-payment-p1-foundation.sql -> LOT SOUS TEST. Ce lot ne
# dépend PAS de P2A/P2B-A/P3-A0/P3-B0/P3-B1 (vérifié directement :
# aucune de ces capacités n'ajoute de colonne/contrainte requise ici,
# la fonction sous test lit exclusivement orders.restaurant_id/
# .payment_status, posées par migration-orders.sql/PAYMENT P1
# FOUNDATION) -- chaîne volontairement minimale plutôt qu'une chaîne
# "complète" par défaut. get_order_payment_status/get_payment_
# transaction_correlation/get_payment_runtime_provider_config sont
# néanmoins appliquées ici (P3-B0 v2 + P3-B1) UNIQUEMENT pour permettre
# une preuve de non-régression réelle sur ces capacités soeurs dans CE
# MÊME harnais (mandat section 18/23). Le durcissement ORDERS
# SERVICE_ROLE SELECT v1, désormais publié dans le baseline, est
# appliqué AVANT P3-B2 afin de prouver que la RPC SECURITY DEFINER
# fonctionne sans restituer le SELECT direct de public.orders.
#
# assert_struct_eq / assert_behav_eq dès l'origine.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/payment-p3b2-order-payment-context-read-check.sh"
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
DRAFT_ORDERS_HARDENING_SQL="$SUPABASE_DIR/DRAFT-lot-orders-service-role-select-hardening.sql"
DRAFT_PAYMENT_P3B2_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b2-order-payment-context-read.sql"
DB="scanym_payment_p3b2_$$"
DB_DRIFT="scanym_payment_p3b2_drift_$$"
DB_FRESH="scanym_payment_p3b2_fresh_$$"

PASS_COUNT=0
FAIL_COUNT=0
STRUCT_COUNT=0
BEHAV_COUNT=0
FAIL_LOG="/tmp/scanym-payment-p3b2-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }
struct() { STRUCT_COUNT=$((STRUCT_COUNT+1)); pass "$@"; }
behav() { BEHAV_COUNT=$((BEHAV_COUNT+1)); pass "$@"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_FRESH\";" >/dev/null 2>&1 || true
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
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p3b2-out-$$.txt 2>/tmp/scanym-p3b2-err-$$.txt
  echo $?
}
as_anon() {
  local query="$1"
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$query" 2>&1
}
as_anon_rc() {
  local query="$1"
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p3b2-out-$$.txt 2>/tmp/scanym-p3b2-err-$$.txt
  echo $?
}
as_user_rc() {
  local uid="$1" query="$2"
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$uid'; $query" >/tmp/scanym-p3b2-out-$$.txt 2>/tmp/scanym-p3b2-err-$$.txt
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

# MOCK VAULT — TEST HARNESS ONLY (identique aux harnais précédents) --
# requis uniquement parce que PAYMENT P2A (appliqué ici pour la preuve
# de non-régression sur P2B-A/P3-A0/P3-B0/P3-B1, PAS parce que P3-B2 en
# dépend) exige que le schéma `vault` existe.
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

build_full_chain() {
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
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_ORDERS_HARDENING_SQL" >/dev/null
}

# ============================================================
# 0. BASELINE — chaîne minimale + P1 + Vault (moqué) + P2A + P2B-A +
# P3-A0 + P3-B0 v2 + P3-B1 + ORDERS SERVICE_ROLE SELECT HARDENING v1
# (toutes déjà publiées/en l'état actuel) + P3-B2 (LOT SOUS TEST).
# ============================================================
log "=== [0] Construction baseline $DB ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
build_full_chain "$DB"
struct "chaîne complète appliquée (minimale + P1 + Vault moqué + P2A + P2B-A + P3-A0 + P3-B0 v2 + P3-B1 + ORDERS SERVICE_ROLE SELECT HARDENING v1)"

psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B2_SQL" >/dev/null
struct "DRAFT-lot-payment-p3b2-order-payment-context-read.sql appliqué sans erreur (LOT SOUS TEST) -- fichier unique, forme finale directe"

# ============================================================
# FIXTURES — 2 tenants, plusieurs commandes chacun, pour couvrir
# possession valide/invalide, isolation cross-tenant, et non-régression
# des capacités soeurs (mandat section 16).
# ============================================================
log "=== Fixtures (Tenant Un + Tenant Deux) ==="
OWNER_UID="30000000-0000-0000-0000-000000000001"
psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into auth.users (id, email) values ('$OWNER_UID', 'owner@p3b2-fixture-one.test');
insert into restaurants (name, slug, status) values
  ('P3B2 Fixture Tenant One', 'p3b2-fixture-tenant-one', 'active'),
  ('P3B2 Fixture Tenant Two', 'p3b2-fixture-tenant-two', 'active');
SQL
RID_ONE="$(sql "select id from restaurants where slug='p3b2-fixture-tenant-one';")"
RID_TWO="$(sql "select id from restaurants where slug='p3b2-fixture-tenant-two';")"
psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into restaurant_users (restaurant_id, user_id, role) values ('$RID_ONE','$OWNER_UID','owner');" >/dev/null

# ORDER_ONE (R1) : paiement 'paid'. ORDER_TWO (R2) : 'pending'.
# ORDER_UNSTARTED (R1) : jamais engagée ('not_required', défaut P1).
ORDER_ONE="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 1, 'pickup', 12.50, 12.50, 'EUR') returning id;")"
ORDER_TWO="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_TWO', 1, 'pickup', 30.00, 30.00, 'EUR') returning id;")"
ORDER_UNSTARTED="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 2, 'pickup', 8.00, 8.00, 'EUR') returning id;")"
ORDER_ELIGIBLE="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 3, 'pickup', 15.00, 15.00, 'EUR') returning id;")"
psql -d "$DB" -v ON_ERROR_STOP=1 -c "update orders set payment_status='paid' where id='$ORDER_ONE';" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -c "update orders set payment_status='pending' where id='$ORDER_TWO';" >/dev/null
TOKEN_ONE="$(sql "select public_token from orders where id='$ORDER_ONE';")"
TOKEN_TWO="$(sql "select public_token from orders where id='$ORDER_TWO';")"
TOKEN_UNSTARTED="$(sql "select public_token from orders where id='$ORDER_UNSTARTED';")"
TOKEN_ELIGIBLE="$(sql "select public_token from orders where id='$ORDER_ELIGIBLE';")"
assert_struct_eq "fixture: les 4 public_token sont distincts" "4" "$(printf '%s\n%s\n%s\n%s\n' "$TOKEN_ONE" "$TOKEN_TWO" "$TOKEN_UNSTARTED" "$TOKEN_ELIGIBLE" | sort -u | wc -l | tr -d ' ')"

# ============================================================
# RPC — CATALOGUE DE FONCTION (structure/ACL -- struct() exclusivement,
# aucune exécution du chemin métier dans ce bloc).
# ============================================================
log "=== [RPC] CATALOGUE DE FONCTION ==="
assert_struct_eq "1a. la fonction existe avec la signature exacte (2 arguments uuid,uuid)" "1" "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_order_payment_context' and p.pronargs=2 and array(select unnest(p.proargtypes))=array['uuid','uuid']::regtype[]::oid[];")"
assert_struct_eq "1b. SECURITY DEFINER (prosecdef=true)" "t" "$(sql "select prosecdef from pg_proc where proname='get_order_payment_context' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1c. langage = sql" "sql" "$(sql "select l.lanname from pg_proc p join pg_language l on l.oid=p.prolang where p.proname='get_order_payment_context' and p.pronamespace='public'::regnamespace;")"
assert_struct_eq "1d. volatilité = stable" "s" "$(sql "select provolatile from pg_proc where proname='get_order_payment_context' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1e. search_path explicitement vide" "1" "$(sql "select count(*) from pg_proc where proname='get_order_payment_context' and pronamespace='public'::regnamespace and 'search_path=\"\"' = any(proconfig);")"
assert_struct_eq "1f. propriétaire = rôle ayant exécuté la migration (aucun OWNER TO explicite requis)" "$(sql "select current_user;")" "$(sql "select r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner where p.proname='get_order_payment_context' and p.pronamespace='public'::regnamespace;")"
assert_struct_eq "1g. EXECUTE effectif service_role = OUI" "t" "$(sql "select has_function_privilege('service_role', 'public.get_order_payment_context(uuid,uuid)', 'execute');")"
assert_struct_eq "1h. EXECUTE effectif anon = NON (mandat section 5, browser n'a pas besoin de restaurant_id)" "f" "$(sql "select has_function_privilege('anon', 'public.get_order_payment_context(uuid,uuid)', 'execute');")"
assert_struct_eq "1i. EXECUTE effectif authenticated = NON" "f" "$(sql "select has_function_privilege('authenticated', 'public.get_order_payment_context(uuid,uuid)', 'execute');")"
assert_struct_eq "1j. AUCUN grant EXECUTE résiduel à PUBLIC" "0" "$(sql "select count(*) from information_schema.role_routine_grants where routine_schema='public' and routine_name='get_order_payment_context' and grantee='PUBLIC';")"
assert_struct_eq "1k. CONTRAT -- retourne EXACTEMENT 2 colonnes, dans cet ordre : restaurant_id,payment_status" "restaurant_id,payment_status" "$(sql "select array_to_string(proargnames[array_position(proargmodes,'t'::\"char\"):array_length(proargmodes,1)], ',') from pg_proc where proname='get_order_payment_context' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1l. type de sortie 'restaurant_id' = uuid" "uuid" "$(sql "select proallargtypes[array_position(proargmodes,'t'::\"char\")]::regtype::text from pg_proc where proname='get_order_payment_context' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1m. type de sortie 'payment_status' = text" "text" "$(sql "select proallargtypes[array_position(proargmodes,'t'::\"char\")+1]::regtype::text from pg_proc where proname='get_order_payment_context' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1n. PREUVE STRUCTURELLE -- les 2 SEULS arguments IN sont p_order_id,p_public_token (aucun restaurant_id/provider_code fourni par l'appelant)" "p_order_id,p_public_token" "$(sql "select array_to_string(proargnames[1:array_position(proargmodes,'t'::\"char\")-1], ',') from pg_proc where proname='get_order_payment_context' and pronamespace='public'::regnamespace;")"

# ============================================================
# AUCUNE DONNÉE EN TROP (mandat section 8) -- catalogue seul.
# ============================================================
log "=== AUCUNE DONNÉE EN TROP (contrat de colonnes) ==="
NO_EXTRA_COLS="$(sql "select count(*) from unnest(string_to_array((select array_to_string(proargnames[array_position(proargmodes,'t'::\"char\"):array_length(proargmodes,1)], ',') from pg_proc where proname='get_order_payment_context' and pronamespace='public'::regnamespace), ',')) col where col ilike '%credential%' or col ilike '%secret%' or col ilike '%vault%' or col ilike '%token%' or col in ('order_number','total','subtotal','currency','provider_reference','transaction_id','customer_name','customer_phone','customer_email','delivery_address','created_at','updated_at');")"
assert_struct_eq "1o. AUCUNE colonne de sortie ne contient credential/secret/vault/token, ni order_number/total/currency/customer_*/timestamps (contrat minimal, mandat section 8)" "0" "$NO_EXTRA_COLS"

# ============================================================
# RPC — COMPORTEMENT (exécution réelle -- behav() exclusivement).
# ============================================================
log "=== [RPC] COMPORTEMENT — POSSESSION VALIDE ==="
OUT_R1="$(as_service "select restaurant_id, payment_status from public.get_order_payment_context('$ORDER_ONE','$TOKEN_ONE');")"
assert_behav_eq "2a. commande Un (R1, possession valide) -> restaurant_id=R1, payment_status='paid'" "${RID_ONE}|paid" "$OUT_R1"
OUT_R2="$(as_service "select restaurant_id, payment_status from public.get_order_payment_context('$ORDER_TWO','$TOKEN_TWO');")"
assert_behav_eq "2b. commande Deux (R2, possession valide) -> restaurant_id=R2, payment_status='pending'" "${RID_TWO}|pending" "$OUT_R2"
OUT_UNSTARTED="$(as_service "select restaurant_id, payment_status from public.get_order_payment_context('$ORDER_UNSTARTED','$TOKEN_UNSTARTED');")"
assert_behav_eq "2c. commande jamais engagée -> payment_status='not_required' (défaut P1, fidèlement exposé)" "${RID_ONE}|not_required" "$OUT_UNSTARTED"

log "=== [RPC] COMPORTEMENT — ISOLATION CROSS-TENANT ==="
RESTAURANT_ONLY_R1="$(as_service "select restaurant_id from public.get_order_payment_context('$ORDER_ONE','$TOKEN_ONE');")"
RESTAURANT_ONLY_R2="$(as_service "select restaurant_id from public.get_order_payment_context('$ORDER_TWO','$TOKEN_TWO');")"
assert_behav_eq "3a. restaurant_id isolé de commande Un = R1 EXACTEMENT, jamais R2" "$RID_ONE" "$RESTAURANT_ONLY_R1"
assert_behav_eq "3b. restaurant_id isolé de commande Deux = R2 EXACTEMENT, jamais R1 -- isolation cross-tenant dans les deux sens" "$RID_TWO" "$RESTAURANT_ONLY_R2"

log "=== [RPC] COMPORTEMENT — ÉCHEC FERMÉ (fail-closed, aucune ligne) ==="
ROWCOUNT_WRONG_TOKEN="$(as_service "select count(*) from public.get_order_payment_context('$ORDER_ONE','$TOKEN_TWO');")"
assert_behav_eq "4a. mauvais jeton (jeton de Deux sur commande de Un) -> AUCUNE ligne (jamais restaurant_id/payment_status de Un)" "0" "$ROWCOUNT_WRONG_TOKEN"
RANDOM_ORDER_ID="00000000-0000-0000-0000-000000000000"
ROWCOUNT_WRONG_ORDER="$(as_service "select count(*) from public.get_order_payment_context('$RANDOM_ORDER_ID','$TOKEN_ONE');")"
assert_behav_eq "4b. order_id inconnu avec jeton valide d'une autre commande -> AUCUNE ligne" "0" "$ROWCOUNT_WRONG_ORDER"
ROWCOUNT_NULL_ORDER="$(as_service "select count(*) from public.get_order_payment_context(null,'$TOKEN_ONE');")"
assert_behav_eq "4c. p_order_id NULL -> AUCUNE ligne" "0" "$ROWCOUNT_NULL_ORDER"
ROWCOUNT_NULL_TOKEN="$(as_service "select count(*) from public.get_order_payment_context('$ORDER_ONE',null);")"
assert_behav_eq "4d. p_public_token NULL -> AUCUNE ligne" "0" "$ROWCOUNT_NULL_TOKEN"
ROWCOUNT_BOTH_NULL="$(as_service "select count(*) from public.get_order_payment_context(null,null);")"
assert_behav_eq "4e. order_id et public_token tous deux NULL -> AUCUNE ligne (jamais une exception distincte)" "0" "$ROWCOUNT_BOTH_NULL"
ROWCOUNT_RANDOM_TOKEN="$(as_service "select count(*) from public.get_order_payment_context('$ORDER_ONE','00000000-0000-0000-0000-000000000000');")"
assert_behav_eq "4f. order_id valide, jeton aléatoire non attribué -> AUCUNE ligne" "0" "$ROWCOUNT_RANDOM_TOKEN"

# 4g/4h : même comportement observable exact (aucune ligne, aucune
# erreur -- rc=0 dans les deux cas) pour "mauvais jeton" vs "mauvaise
# commande" -- preuve directe de l'exigence mandat section 7/17
# (confidentialité de la possession).
RC_WRONG_TOKEN="$(as_service_rc "select * from public.get_order_payment_context('$ORDER_ONE','$TOKEN_TWO');")"
RC_WRONG_ORDER="$(as_service_rc "select * from public.get_order_payment_context('$RANDOM_ORDER_ID','$TOKEN_ONE');")"
assert_behav_eq "4g. code de sortie identique (0, pas d'erreur) pour mauvais jeton et mauvaise commande" "$RC_WRONG_TOKEN" "$RC_WRONG_ORDER"
assert_behav_eq "4h. ce code de sortie commun est bien 0 (SELECT vide, jamais une exception distinctive)" "0" "$RC_WRONG_TOKEN"

log "=== [RPC] COMPORTEMENT — MODÈLE D'EXÉCUTION (anon/authenticated refusés) ==="
RC_ANON="$(as_anon_rc "select * from public.get_order_payment_context('$ORDER_ONE','$TOKEN_ONE');")"
assert_behav_eq "5a. anon EXECUTE refusé (permission denied, RC != 0) même avec possession valide" "1" "$([ "$RC_ANON" != "0" ] && echo 1 || echo 0)"
RC_AUTH="$(as_user_rc "$OWNER_UID" "select * from public.get_order_payment_context('$ORDER_ONE','$TOKEN_ONE');")"
assert_behav_eq "5b. authenticated (même personnel du restaurant concerné) EXECUTE refusé (permission denied, RC != 0)" "1" "$([ "$RC_AUTH" != "0" ] && echo 1 || echo 0)"

log "=== [RPC] COMPORTEMENT — AUCUNE MUTATION (mandat section 12) ==="
STATUS_BEFORE="$(sql "select payment_status from orders where id='$ORDER_ONE';")"
WHATSAPP_BEFORE="$(sql "select whatsapp_opened from orders where id='$ORDER_ONE';")"
as_service "select * from public.get_order_payment_context('$ORDER_ONE','$TOKEN_ONE');" >/dev/null
as_service "select * from public.get_order_payment_context('$ORDER_ONE','$TOKEN_TWO');" >/dev/null
as_service "select * from public.get_order_payment_context('$ORDER_ONE','$TOKEN_ONE');" >/dev/null
STATUS_AFTER="$(sql "select payment_status from orders where id='$ORDER_ONE';")"
WHATSAPP_AFTER="$(sql "select whatsapp_opened from orders where id='$ORDER_ONE';")"
assert_behav_eq "6a. payment_status inchangé après appels répétés (valides et invalides)" "$STATUS_BEFORE" "$STATUS_AFTER"
assert_behav_eq "6b. whatsapp_opened inchangé (aucun effet de bord de type mark_whatsapp_opened)" "$WHATSAPP_BEFORE" "$WHATSAPP_AFTER"

# ============================================================
# NON-RÉGRESSION (mandat sections 18/19/23) — orders ACL, RPC soeurs
# INCHANGÉES.
# ============================================================
log "=== NON-RÉGRESSION (ACL DE TABLE + RPC SOEURS) ==="
assert_struct_eq "7a. orders : RLS toujours active" "t" "$(sql "select relrowsecurity from pg_class where relname='orders' and relnamespace='public'::regnamespace;")"
assert_struct_eq "7b. orders : policy 'merchant reads restaurant orders' (v29, staff-only) toujours présente (inchangée)" "1" "$(sql "select count(*) from pg_policies where schemaname='public' and tablename='orders' and policyname='merchant reads restaurant orders';")"
assert_struct_eq "7c. orders : AUCUN grant de table nouveau à service_role (architecture RPC-only préservée, mandat section 11)" "f" "$(sql "select has_table_privilege('service_role','orders','SELECT');")"
ANON_ORDERS_DIRECT_ROWS="$(as_anon "select count(*) from orders where id='$ORDER_ONE';")"
assert_behav_eq "7d. anon ne peut toujours PAS lire orders directement (RLS -- même patron que la non-régression P3-B0 12d ; le grant SELECT de table posé par le harnais de test reste filtré à zéro ligne par RLS, aucune policy anon n'existe sur orders)" "0" "$ANON_ORDERS_DIRECT_ROWS"
RC_SERVICE_ORDERS_DIRECT="$(as_service_rc "select payment_status from orders where id='$ORDER_ONE';")"
assert_behav_eq "7e. service_role ne peut toujours PAS lire orders directement (permission denied, RC != 0) -- get_order_payment_context reste la SEULE porte de lecture serveur pour restaurant_id" "1" "$([ "$RC_SERVICE_ORDERS_DIRECT" != "0" ] && echo 1 || echo 0)"

assert_struct_eq "8a. get_order_payment_status : signature INCHANGÉE (1 colonne, payment_status)" "payment_status" "$(sql "select array_to_string(proargnames[array_position(proargmodes,'t'::\"char\"):array_length(proargmodes,1)], ',') from pg_proc where proname='get_order_payment_status' and pronamespace='public'::regnamespace;")"
assert_struct_eq "8b. get_order_payment_status : EXECUTE anon toujours OUI (contrat CLIENT public non affaibli)" "t" "$(sql "select has_function_privilege('anon', 'public.get_order_payment_status(uuid,uuid)', 'execute');")"
OUT_STATUS_STILL_WORKS="$(as_anon "select payment_status from public.get_order_payment_status('$ORDER_ONE','$TOKEN_ONE');")"
assert_behav_eq "8c. get_order_payment_status toujours réellement fonctionnelle (appel réussi, résultat correct)" "paid" "$OUT_STATUS_STILL_WORKS"

RC_WHATSAPP_STILL_WORKS="$(as_anon_rc "select public.mark_whatsapp_opened('$ORDER_ELIGIBLE','$TOKEN_ELIGIBLE');")"
assert_behav_eq "9a. mark_whatsapp_opened toujours réellement fonctionnelle (appel réussi)" "0" "$RC_WHATSAPP_STILL_WORKS"
WHATSAPP_FLAG_AFTER="$(sql "select whatsapp_opened from orders where id='$ORDER_ELIGIBLE';")"
assert_behav_eq "9b. mark_whatsapp_opened a bien produit son effet attendu (whatsapp_opened=true) -- fonction non cassée par ce lot" "t" "$WHATSAPP_FLAG_AFTER"

RC_INITIATE_STILL_WORKS="$(as_service_rc "select * from public.initiate_payment_attempt('$ORDER_UNSTARTED','monetico','p3b2-nonreg-ref');")"
assert_behav_eq "10a. initiate_payment_attempt toujours réellement fonctionnelle (appel réussi, service_role, signature à 3 arguments inchangée)" "0" "$RC_INITIATE_STILL_WORKS"
UNSTARTED_STATUS_AFTER_INIT="$(sql "select payment_status from orders where id='$ORDER_UNSTARTED';")"
assert_behav_eq "10b. initiate_payment_attempt a bien produit son effet attendu (payment_status='pending') -- fonction non cassée par ce lot" "pending" "$UNSTARTED_STATUS_AFTER_INIT"

RC_CORRELATION_STILL_WORKS="$(as_service_rc "select * from public.get_payment_transaction_correlation('monetico','p3b2-nonreg-ref');")"
assert_behav_eq "11. get_payment_transaction_correlation toujours réellement fonctionnelle (appel réussi, P3-B0 v2 non affectée)" "0" "$RC_CORRELATION_STILL_WORKS"

psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into payment_provider_configs (restaurant_id, provider_code, is_enabled, configuration_status) values ('$RID_TWO','monetico', true, 'not_configured');" >/dev/null
RC_RUNTIME_CONFIG_STILL_WORKS="$(as_service_rc "select * from public.get_payment_runtime_provider_config('$RID_TWO','monetico');")"
assert_behav_eq "12. get_payment_runtime_provider_config toujours réellement fonctionnelle (appel réussi, P3-B1 non affectée)" "0" "$RC_RUNTIME_CONFIG_STILL_WORKS"

# ============================================================
# D. GARDES PRÉFLIGHT (double application + dérive schéma).
# ============================================================
log "=== [D] GARDES PRÉFLIGHT ==="
RC_DOUBLE_APPLY="$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B2_SQL" >/tmp/scanym-p3b2-double-$$.txt 2>&1; echo $?)"
assert_behav_eq "D1. double-application refusée (RC != 0)" "1" "$([ "$RC_DOUBLE_APPLY" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "D2. message SCANYM_SCHEMA_DRIFT présent dans le refus de double-application" "1" "$(grep -c 'SCANYM_SCHEMA_DRIFT' /tmp/scanym-p3b2-double-$$.txt || true)"
rm -f /tmp/scanym-p3b2-double-$$.txt

log "=== [D] DÉRIVE — orders SANS payment_status (P1 absent) ==="
psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
createdb "$DB_DRIFT"
build_common_bootstrap "$DB_DRIFT"
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/schema.sql" >/dev/null
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-orders.sql" >/dev/null
RC_DRIFT_NO_P1="$(psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B2_SQL" >/tmp/scanym-p3b2-drift-$$.txt 2>&1; echo $?)"
assert_behav_eq "D3. application refusée sur schéma sans payment_status (P1 absent) -- RC != 0" "1" "$([ "$RC_DRIFT_NO_P1" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "D4. message SCANYM_SCHEMA_DRIFT présent dans le refus (prérequis manquant)" "1" "$(grep -c 'SCANYM_SCHEMA_DRIFT' /tmp/scanym-p3b2-drift-$$.txt || true)"
rm -f /tmp/scanym-p3b2-drift-$$.txt
psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true

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
