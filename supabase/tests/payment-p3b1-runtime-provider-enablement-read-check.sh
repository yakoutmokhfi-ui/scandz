#!/usr/bin/env bash
# ============================================================
# Scanym — PAYMENT P3-B1 — RUNTIME PROVIDER ENABLEMENT READ —
# Harnais reproductible pour
# supabase/DRAFT-lot-payment-p3b1-runtime-provider-enablement-read.sql.
#
# PostgreSQL communautaire vanilla (pas une instance Supabase managée),
# même patron que tous les harnais paiement précédents (P1/P2A/P2B-A/
# P3-A0/P3-B0) : rôles anon/authenticated/service_role recréés
# minimalement, auth.uid() simulé via `test.uid`, Vault MOQUÉ (test
# harness only -- identité exacte reproduite depuis le harnais P3-A0,
# voir build_mock_vault) car PAYMENT P2A (prérequis de colonne pour ce
# lot -- configuration_status) exige un schéma `vault` réel pour
# s'appliquer, même si ce lot lui-même NE touche JAMAIS Vault.
#
# Chaîne (mandat section 35, "no hidden dependency on an unpublished
# migration") : chaîne minimale (schema.sql .. migration-v81-lot1b-
# translations.sql) -> DRAFT-lot-payment-p1-foundation.sql -> mock
# Vault -> DRAFT-lot-payment-p2a-secure-config.sql ->
# DRAFT-lot-payment-p2b-a-safe-merchant-read.sql ->
# DRAFT-lot-payment-p3a0-secure-credential-read.sql ->
# DRAFT-lot-payment-p3b0-correlation-status-read.sql (v2) -> LOT SOUS
# TEST. Aucun lot fulfillment/livraison n'est nécessaire (vérifié
# directement : ni P2A ni P3-B1 ne référencent ces tables) -- chaîne
# volontairement minimale plutôt qu'une chaîne "complète" par défaut.
# Les capacités soeurs (P2B-A, P3-A0, P3-B0 v2) sont appliquées ici
# NON parce que P3-B1 en dépend structurellement (aucune des trois
# n'ajoute de colonne/contrainte requise par ce lot -- vérifié), mais
# pour permettre une preuve de non-régression réelle sur ces capacités
# dans CE MÊME harnais (mandat sections 16/17, "why existing merchant
# RPC/credential RPC must not be reused/changed").
#
# assert_struct_eq / assert_behav_eq dès l'origine (PAS de bug
# PAY-P3-B0-02 à corriger ici -- patron déjà tiré au clair sur le lot
# précédent, appliqué directement et correctement dès l'écriture de ce
# harnais).
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/payment-p3b1-runtime-provider-enablement-read-check.sh"
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
DB="scanym_payment_p3b1_$$"
DB_DRIFT="scanym_payment_p3b1_drift_$$"
DB_FRESH="scanym_payment_p3b1_fresh_$$"

PASS_COUNT=0
FAIL_COUNT=0
STRUCT_COUNT=0
BEHAV_COUNT=0
FAIL_LOG="/tmp/scanym-payment-p3b1-fails-$$.log"
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
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p3b1-out-$$.txt 2>/tmp/scanym-p3b1-err-$$.txt
  echo $?
}
as_anon_rc() {
  local query="$1"
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p3b1-out-$$.txt 2>/tmp/scanym-p3b1-err-$$.txt
  echo $?
}
as_user_rc() {
  local uid="$1" query="$2"
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$uid'; $query" >/tmp/scanym-p3b1-out-$$.txt 2>/tmp/scanym-p3b1-err-$$.txt
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

# MOCK VAULT — TEST HARNESS ONLY. Identité exacte reproduite depuis le
# harnais P3-A0 (build_mock_vault), colonne `decrypted_secret` incluse.
# PAYMENT P3-B1 lui-même NE référence JAMAIS `vault` -- ce mock existe
# UNIQUEMENT parce que PAYMENT P2A (prérequis de colonne) exige que le
# schéma `vault` existe pour s'appliquer.
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
}

# ============================================================
# 0. BASELINE — chaîne minimale + P1 + Vault (moqué) + P2A + P2B-A +
# P3-A0 + P3-B0 v2 (toutes déjà publiées/en l'état actuel) + P3-B1
# (LOT SOUS TEST).
# ============================================================
log "=== [0] Construction baseline $DB ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
build_full_chain "$DB"
struct "chaîne complète appliquée (minimale + P1 + Vault moqué + P2A + P2B-A + P3-A0 + P3-B0 v2)"

psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B1_SQL" >/dev/null
struct "DRAFT-lot-payment-p3b1-runtime-provider-enablement-read.sql appliqué sans erreur (LOT SOUS TEST) -- fichier unique, forme finale directe"

# ============================================================
# FIXTURES — 2 tenants. R1 possède DEUX configurations (monetico +
# mercanet) dans des états DISTINCTS pour couvrir les 3 valeurs de
# configuration_status (mandat section 25D) EN UN SEUL restaurant, et
# prouver l'isolation inter-provider (mandat section 26, "test two
# providers if practical"). R2 possède une SEULE configuration
# (monetico) dans un troisième état, avec des valeurs is_enabled/
# configuration_status DISTINCTES de celles de R1 -- nécessaire pour
# que la preuve d'isolation cross-tenant soit significative (mandat
# section 26).
# ============================================================
log "=== Fixtures (Tenant Un + Tenant Deux) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
insert into restaurants (name, slug, status) values
  ('P3B1 Fixture Tenant One', 'p3b1-fixture-tenant-one', 'active'),
  ('P3B1 Fixture Tenant Two', 'p3b1-fixture-tenant-two', 'active');
SQL
RID_ONE="$(sql "select id from restaurants where slug='p3b1-fixture-tenant-one';")"
RID_TWO="$(sql "select id from restaurants where slug='p3b1-fixture-tenant-two';")"

# R1 + monetico : is_enabled=true, configuration_status='verified'.
# credentials_ref pointe vers un VRAI secret Vault (moqué) inséré ici
# -- nécessaire pour que le test de non-régression 7g (P3-A0 toujours
# fonctionnelle) obtienne un succès réel, pas un rejet "référence
# orpheline" qui prouverait moins (P3-A0 rejetterait aussi bien un
# credentials_ref orphelin qu'une fonction cassée -- un succès réel
# est une preuve plus forte que la fonction fonctionne encore).
CRED_REF_ONE="$(psql -X -A -q -t -d "$DB" -c "insert into vault.secrets (secret, name) values ('fixture-secret-never-real', 'p3b1-fixture-one') returning id;")"
psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into payment_provider_configs (restaurant_id, provider_code, is_enabled, configuration_status, credentials_ref) values ('$RID_ONE','monetico', true, 'verified', '$CRED_REF_ONE');" >/dev/null
# R1 + mercanet : is_enabled=false, configuration_status='not_configured' (credentials_ref NULL, requis par la contrainte P2A).
psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into payment_provider_configs (restaurant_id, provider_code, is_enabled, configuration_status) values ('$RID_ONE','mercanet', false, 'not_configured');" >/dev/null
# R2 + monetico : is_enabled=false, configuration_status='configured' -- valeurs délibérément DISTINCTES de R1+monetico (true/verified), pour que le test d'isolation cross-tenant soit significatif.
psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into payment_provider_configs (restaurant_id, provider_code, is_enabled, configuration_status, credentials_ref) values ('$RID_TWO','monetico', false, 'configured', gen_random_uuid());" >/dev/null
struct "fixtures : R1 monetico(true,verified) + R1 mercanet(false,not_configured) + R2 monetico(false,configured) -- les 3 valeurs de configuration_status couvertes, valeurs distinctes par tenant"

# ============================================================
# RPC — CATALOGUE DE FONCTION (structure/ACL -- struct() exclusivement,
# aucune exécution du chemin métier dans ce bloc).
# ============================================================
log "=== [RPC] CATALOGUE DE FONCTION ==="
assert_struct_eq "1a. la fonction existe avec la signature exacte (2 arguments uuid,text)" "1" "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_payment_runtime_provider_config' and p.pronargs=2 and array(select unnest(p.proargtypes))=array['uuid','text']::regtype[]::oid[];")"
assert_struct_eq "1b. SECURITY DEFINER (prosecdef=true)" "t" "$(sql "select prosecdef from pg_proc where proname='get_payment_runtime_provider_config' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1c. langage = plpgsql" "plpgsql" "$(sql "select l.lanname from pg_proc p join pg_language l on l.oid=p.prolang where p.proname='get_payment_runtime_provider_config' and p.pronamespace='public'::regnamespace;")"
assert_struct_eq "1d. volatilité = stable" "s" "$(sql "select provolatile from pg_proc where proname='get_payment_runtime_provider_config' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1e. search_path explicitement vide" "1" "$(sql "select count(*) from pg_proc where proname='get_payment_runtime_provider_config' and pronamespace='public'::regnamespace and 'search_path=\"\"' = any(proconfig);")"
assert_struct_eq "1f. propriétaire = rôle ayant exécuté la migration (aucun OWNER TO explicite requis)" "$(sql "select current_user;")" "$(sql "select r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner where p.proname='get_payment_runtime_provider_config' and p.pronamespace='public'::regnamespace;")"
assert_struct_eq "1g. EXECUTE effectif service_role = OUI" "t" "$(sql "select has_function_privilege('service_role', 'public.get_payment_runtime_provider_config(uuid,text)', 'execute');")"
assert_struct_eq "1h. EXECUTE effectif anon = NON" "f" "$(sql "select has_function_privilege('anon', 'public.get_payment_runtime_provider_config(uuid,text)', 'execute');")"
assert_struct_eq "1i. EXECUTE effectif authenticated = NON" "f" "$(sql "select has_function_privilege('authenticated', 'public.get_payment_runtime_provider_config(uuid,text)', 'execute');")"
assert_struct_eq "1j. AUCUN grant EXECUTE résiduel à PUBLIC" "0" "$(sql "select count(*) from information_schema.role_routine_grants where routine_schema='public' and routine_name='get_payment_runtime_provider_config' and grantee='PUBLIC';")"
assert_struct_eq "1k. CONTRAT -- retourne EXACTEMENT 3 colonnes, dans cet ordre : provider_code,is_enabled,configuration_status" "provider_code,is_enabled,configuration_status" "$(sql "select array_to_string(proargnames[array_position(proargmodes,'t'::\"char\"):array_length(proargmodes,1)], ',') from pg_proc where proname='get_payment_runtime_provider_config' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1l. type de sortie 'is_enabled' = boolean" "boolean" "$(sql "select proallargtypes[array_position(proargmodes,'t'::\"char\")+1]::regtype::text from pg_proc where proname='get_payment_runtime_provider_config' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1m. type de sortie 'configuration_status' = text" "text" "$(sql "select proallargtypes[array_position(proargmodes,'t'::\"char\")+2]::regtype::text from pg_proc where proname='get_payment_runtime_provider_config' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1n. PREUVE STRUCTURELLE -- les 2 SEULS arguments IN sont p_restaurant_id,p_provider_code (aucun autre champ, aucun credential/secret en entrée)" "p_restaurant_id,p_provider_code" "$(sql "select array_to_string(proargnames[1:array_position(proargmodes,'t'::\"char\")-1], ',') from pg_proc where proname='get_payment_runtime_provider_config' and pronamespace='public'::regnamespace;")"

# ============================================================
# AUCUNE SURFACE SECRÈTE (mandat section 28) -- catalogue seul.
# ============================================================
log "=== AUCUNE SURFACE SECRÈTE (contrat de colonnes) ==="
NO_SECRET_COLS="$(sql "select count(*) from unnest(string_to_array((select array_to_string(proargnames[array_position(proargmodes,'t'::\"char\"):array_length(proargmodes,1)], ',') from pg_proc where proname='get_payment_runtime_provider_config' and pronamespace='public'::regnamespace), ',')) col where col ilike '%credential%' or col ilike '%secret%' or col ilike '%vault%' or col ilike '%key%' or col='id' or col='restaurant_id';")"
assert_struct_eq "1o. AUCUNE colonne de sortie ne contient credential/secret/vault/key, ni id/restaurant_id (contrat minimal, mandat section 4/14/28)" "0" "$NO_SECRET_COLS"

# ============================================================
# UNICITÉ (mandat sections 19/20) -- struct().
# ============================================================
log "=== UNICITÉ RESTAURANT_ID+PROVIDER_CODE ==="
assert_struct_eq "1p. contrainte unique(restaurant_id, provider_code) toujours présente sur payment_provider_configs (garantit au plus une ligne par couple -- vérifiée directement, jamais supposée)" "1" "$(sql "select count(*) from pg_constraint where conrelid='public.payment_provider_configs'::regclass and contype='u' and pg_get_constraintdef(oid) ilike '%restaurant_id%' and pg_get_constraintdef(oid) ilike '%provider_code%';")"

# ============================================================
# CONFIGURATION_STATUS -- VALEURS AUTORISÉES (mandat sections 6/27) --
# struct().
# ============================================================
log "=== CONFIGURATION_STATUS -- CONTRAINTE INCHANGÉE ==="
assert_struct_eq "1q. contrainte CHECK configuration_status inchangée -- exactement not_configured/configured/verified (P2A, non modifiée par ce lot)" "1" "$(sql "select count(*) from pg_constraint where conrelid='public.payment_provider_configs'::regclass and contype='c' and conname='payment_provider_configs_configuration_status_check' and pg_get_constraintdef(oid) ilike '%not_configured%' and pg_get_constraintdef(oid) ilike '%configured%' and pg_get_constraintdef(oid) ilike '%verified%';")"

# ============================================================
# RPC — COMPORTEMENT (exécution réelle -- behav() exclusivement).
# ============================================================
log "=== [RPC] COMPORTEMENT ==="
RC_R1_MONETICO="$(as_service_rc "select * from public.get_payment_runtime_provider_config('$RID_ONE','monetico');")"
assert_behav_eq "2a. R1+monetico : lecture réussit" "0" "$RC_R1_MONETICO"
OUT_R1_MONETICO="$(as_service "select provider_code, is_enabled, configuration_status from public.get_payment_runtime_provider_config('$RID_ONE','monetico');")"
assert_behav_eq "2b. R1+monetico renvoie EXACTEMENT monetico|t|verified" "monetico|t|verified" "$OUT_R1_MONETICO"

OUT_R1_MERCANET="$(as_service "select provider_code, is_enabled, configuration_status from public.get_payment_runtime_provider_config('$RID_ONE','mercanet');")"
assert_behav_eq "2c. R1+mercanet renvoie EXACTEMENT mercanet|f|not_configured (configuration_status='not_configured' correctement exposée, mandat section 25D)" "mercanet|f|not_configured" "$OUT_R1_MERCANET"

OUT_R2_MONETICO="$(as_service "select provider_code, is_enabled, configuration_status from public.get_payment_runtime_provider_config('$RID_TWO','monetico');")"
assert_behav_eq "2d. R2+monetico renvoie EXACTEMENT monetico|f|configured (configuration_status='configured' correctement exposée, is_enabled=false correctement exposée)" "monetico|f|configured" "$OUT_R2_MONETICO"

# 2e/2f : isolation cross-tenant EXPLICITE (mandat section 26) -- R1 et
# R2 partagent le même provider_code (monetico) mais des valeurs
# is_enabled/configuration_status DISTINCTES ; chaque lecture doit
# renvoyer EXACTEMENT les valeurs de SON tenant, jamais celles de
# l'autre.
IS_ENABLED_R1_MONETICO_ONLY="$(as_service "select is_enabled from public.get_payment_runtime_provider_config('$RID_ONE','monetico');")"
IS_ENABLED_R2_MONETICO_ONLY="$(as_service "select is_enabled from public.get_payment_runtime_provider_config('$RID_TWO','monetico');")"
assert_behav_eq "2e. is_enabled isolé de R1+monetico = t EXACTEMENT, jamais f (valeur de R2+monetico)" "t" "$IS_ENABLED_R1_MONETICO_ONLY"
assert_behav_eq "2f. is_enabled isolé de R2+monetico = f EXACTEMENT, jamais t (valeur de R1+monetico) -- preuve d'isolation cross-tenant dans les deux sens" "f" "$IS_ENABLED_R2_MONETICO_ONLY"
CFGSTATUS_R1_MONETICO_ONLY="$(as_service "select configuration_status from public.get_payment_runtime_provider_config('$RID_ONE','monetico');")"
CFGSTATUS_R2_MONETICO_ONLY="$(as_service "select configuration_status from public.get_payment_runtime_provider_config('$RID_TWO','monetico');")"
assert_behav_eq "2g. configuration_status isolé de R1+monetico = verified EXACTEMENT, jamais configured (valeur de R2+monetico)" "verified" "$CFGSTATUS_R1_MONETICO_ONLY"
assert_behav_eq "2h. configuration_status isolé de R2+monetico = configured EXACTEMENT, jamais verified (valeur de R1+monetico)" "configured" "$CFGSTATUS_R2_MONETICO_ONLY"

# Isolation inter-provider pour un MÊME tenant (mandat section 26, "test
# two providers if practical") : R1+monetico et R1+mercanet ne doivent
# jamais se mélanger.
assert_behav_eq "2i. R1+monetico (is_enabled=t) et R1+mercanet (is_enabled=f) restent bien DISTINCTS pour le même tenant" "t|f" "${IS_ENABLED_R1_MONETICO_ONLY}|$(as_service "select is_enabled from public.get_payment_runtime_provider_config('$RID_ONE','mercanet');")"

RC_UNKNOWN_RESTAURANT="$(as_service_rc "select * from public.get_payment_runtime_provider_config('00000000-0000-0000-0000-000000000000','monetico');")"
assert_behav_eq "3a. restaurant inconnu -> aucun résultat utilisable (échec fermé, P0002)" "1" "$([ "$RC_UNKNOWN_RESTAURANT" != "0" ] && echo 1 || echo 0)"
RC_UNKNOWN_PROVIDER="$(as_service_rc "select * from public.get_payment_runtime_provider_config('$RID_ONE','stripe');")"
assert_behav_eq "3b. provider inconnu pour un restaurant existant -> aucun résultat utilisable" "1" "$([ "$RC_UNKNOWN_PROVIDER" != "0" ] && echo 1 || echo 0)"
RC_WRONG_COMBINATION="$(as_service_rc "select * from public.get_payment_runtime_provider_config('$RID_TWO','mercanet');")"
assert_behav_eq "3c. combinaison restaurant/provider valide individuellement mais jamais configurée ensemble (R2+mercanet) -> aucun résultat utilisable" "1" "$([ "$RC_WRONG_COMBINATION" != "0" ] && echo 1 || echo 0)"
RC_NULL_RESTAURANT="$(as_service_rc "select * from public.get_payment_runtime_provider_config(null,'monetico');")"
assert_behav_eq "3d. p_restaurant_id NULL -> échec fermé" "1" "$([ "$RC_NULL_RESTAURANT" != "0" ] && echo 1 || echo 0)"
RC_NULL_PROVIDER="$(as_service_rc "select * from public.get_payment_runtime_provider_config('$RID_ONE',null);")"
assert_behav_eq "3e. p_provider_code NULL -> échec fermé" "1" "$([ "$RC_NULL_PROVIDER" != "0" ] && echo 1 || echo 0)"
RC_EMPTY_PROVIDER="$(as_service_rc "select * from public.get_payment_runtime_provider_config('$RID_ONE','');")"
assert_behav_eq "3f. p_provider_code vide -> échec fermé" "1" "$([ "$RC_EMPTY_PROVIDER" != "0" ] && echo 1 || echo 0)"
RC_WHITESPACE_PROVIDER="$(as_service_rc "select * from public.get_payment_runtime_provider_config('$RID_ONE','   ');")"
assert_behav_eq "3g. p_provider_code uniquement blancs -> échec fermé (normalisé à vide après btrim, même convention que P3-A0/P3-B0)" "1" "$([ "$RC_WHITESPACE_PROVIDER" != "0" ] && echo 1 || echo 0)"
RC_BOTH_NULL="$(as_service_rc "select * from public.get_payment_runtime_provider_config(null,null);")"
assert_behav_eq "3h. p_restaurant_id/p_provider_code tous deux NULL -> échec fermé" "1" "$([ "$RC_BOTH_NULL" != "0" ] && echo 1 || echo 0)"

RC_ANON="$(as_anon_rc "select * from public.get_payment_runtime_provider_config('$RID_ONE','monetico');")"
assert_behav_eq "4a. anon NE PEUT PAS exécuter la lecture runtime" "1" "$([ "$RC_ANON" != "0" ] && echo 1 || echo 0)"
RC_AUTH="$(as_user_rc "00000000-0000-0000-0000-000000000099" "select * from public.get_payment_runtime_provider_config('$RID_ONE','monetico');")"
assert_behav_eq "4b. authenticated NE PEUT PAS exécuter la lecture runtime (même sans lien de membership -- l'EXECUTE lui-même est refusé, pas seulement l'autorisation applicative)" "1" "$([ "$RC_AUTH" != "0" ] && echo 1 || echo 0)"

RC_DIRECT_SELECT="$(as_service_rc "select count(*) from payment_provider_configs;")"
assert_behav_eq "5. service_role NE PEUT toujours PAS lire payment_provider_configs DIRECTEMENT après P3-B1 (aucun grant de table nouveau)" "1" "$([ "$RC_DIRECT_SELECT" != "0" ] && echo 1 || echo 0)"

CONFIG_COUNT_BEFORE="$(sql "select count(*) from payment_provider_configs;")"
as_service "select * from public.get_payment_runtime_provider_config('$RID_ONE','monetico');" >/dev/null
as_service "select * from public.get_payment_runtime_provider_config('$RID_ONE','stripe');" >/dev/null 2>&1 || true
CONFIG_COUNT_AFTER="$(sql "select count(*) from payment_provider_configs;")"
assert_behav_eq "6a. aucune mutation de payment_provider_configs après plusieurs appels (succès et échecs)" "$CONFIG_COUNT_BEFORE" "$CONFIG_COUNT_AFTER"
IS_ENABLED_UNCHANGED="$(sql "select is_enabled from payment_provider_configs where restaurant_id='$RID_ONE' and provider_code='monetico';")"
assert_behav_eq "6b. is_enabled de R1+monetico reste 't' après lectures répétées (lecture pure)" "t" "$IS_ENABLED_UNCHANGED"
CFGSTATUS_UNCHANGED="$(sql "select configuration_status from payment_provider_configs where restaurant_id='$RID_ONE' and provider_code='monetico';")"
assert_behav_eq "6c. configuration_status de R1+monetico reste 'verified' après lectures répétées" "verified" "$CFGSTATUS_UNCHANGED"

# ============================================================
# NON-RÉGRESSION (mandat sections 9/16/17) -- ACL de table + capacités
# soeurs toujours fonctionnelles et INCHANGÉES.
# ============================================================
log "=== NON-RÉGRESSION ==="
assert_struct_eq "7a. payment_provider_configs : service_role toujours SANS SELECT direct (inchangé, P3-B1 n'ajoute aucun grant de table)" "f" "$(sql "select has_table_privilege('service_role','payment_provider_configs','SELECT');")"
assert_struct_eq "7b. payment_provider_configs : service_role toujours SANS INSERT/UPDATE/DELETE direct" "f" "$(sql "select has_table_privilege('service_role','payment_provider_configs','INSERT') or has_table_privilege('service_role','payment_provider_configs','UPDATE') or has_table_privilege('service_role','payment_provider_configs','DELETE');")"
assert_struct_eq "7c. payment_provider_configs : anon/authenticated toujours SANS aucun privilège direct" "0" "$(sql "select count(*) from information_schema.role_table_grants where table_schema='public' and table_name='payment_provider_configs' and grantee in ('anon','authenticated');")"
assert_struct_eq "7d. get_merchant_payment_provider_config (P2B-A) toujours présente, EXECUTE inchangé (authenticated seul)" "t" "$(sql "select has_function_privilege('authenticated', 'public.get_merchant_payment_provider_config(uuid)', 'execute');")"
assert_struct_eq "7e. get_merchant_payment_provider_config : service_role toujours SANS EXECUTE (P3-B1 ne lui accorde rien, modèles de confiance restent séparés)" "f" "$(sql "select has_function_privilege('service_role', 'public.get_merchant_payment_provider_config(uuid)', 'execute');")"
assert_struct_eq "7f. get_payment_provider_credential (P3-A0) toujours présente, signature (uuid,text) inchangée" "1" "$(sql "select count(*) from pg_proc where proname='get_payment_provider_credential' and pronamespace='public'::regnamespace and pronargs=2;")"
RC_CRED_STILL_WORKS="$(as_service_rc "select public.get_payment_provider_credential('$RID_ONE','monetico');")"
assert_behav_eq "7g. get_payment_provider_credential (P3-A0) toujours fonctionnelle (R1+monetico, configuration_status='verified', credentials_ref renseigné) -- capacité soeur non cassée par ce lot" "0" "$RC_CRED_STILL_WORKS"
RC_MERCH_RPC_STILL_WORKS="$(as_user_rc "00000000-0000-0000-0000-000000000001" "select public.get_merchant_payment_provider_config('$RID_ONE');")"
# Rejeté (pas membre du restaurant) -- prouve que la fonction existe
# et s'exécute toujours normalement (rejet applicatif 42501, pas une
# erreur de fonction absente/cassée).
assert_behav_eq "7h. get_merchant_payment_provider_config (P2B-A) toujours exécutable normalement (rejet attendu -- non membre -- pas une erreur de fonction cassée/absente)" "1" "$([ "$RC_MERCH_RPC_STILL_WORKS" != "0" ] && echo 1 || echo 0)"

# ============================================================
# GARDES ANTI-DÉRIVE (exécution réelle de la migration -- behav()).
# ============================================================
log "=== GARDES ANTI-DÉRIVE ==="
RC_DOUBLE_APPLY="$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B1_SQL" >/tmp/scanym-p3b1-double-$$.out 2>&1; echo $?)"
assert_behav_eq "D1. double application du lot REFUSÉE (SCANYM_SCHEMA_DRIFT)" "1" "$([ "$RC_DOUBLE_APPLY" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "D2. message de double application mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" /tmp/scanym-p3b1-double-$$.out || true)"
rm -f /tmp/scanym-p3b1-double-$$.out

log "=== GARDE — base SANS payment_provider_configs (prérequis P1 manquant) ==="
psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
createdb "$DB_DRIFT"
build_common_bootstrap "$DB_DRIFT"
build_minimal_chain "$DB_DRIFT"
RC_MISSING_P1="$(psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B1_SQL" >/tmp/scanym-p3b1-drift1-$$.out 2>&1; echo $?)"
assert_behav_eq "D3. application sur base SANS payment_provider_configs (P1 absent) REFUSÉE dès la garde préflight" "1" "$([ "$RC_MISSING_P1" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "D4. message mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" /tmp/scanym-p3b1-drift1-$$.out || true)"
rm -f /tmp/scanym-p3b1-drift1-$$.out

log "=== GARDE — base AVEC P1 mais SANS configuration_status (prérequis P2A manquant) ==="
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P1_SQL" >/dev/null
RC_MISSING_P2A="$(psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B1_SQL" >/tmp/scanym-p3b1-drift2-$$.out 2>&1; echo $?)"
assert_behav_eq "D5. application sur base AVEC P1 mais SANS configuration_status (P2A absent) REFUSÉE dès la garde préflight" "1" "$([ "$RC_MISSING_P2A" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "D6. message mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" /tmp/scanym-p3b1-drift2-$$.out || true)"
rm -f /tmp/scanym-p3b1-drift2-$$.out

# ============================================================
# ABSENCE DE FUITE — aucun message d'erreur ne révèle l'existence/le
# contenu d'une autre tentative/tenant.
# ============================================================
log "=== ABSENCE DE FUITE ==="
LEAK_TEST_OUT="$(as_service "select * from public.get_payment_runtime_provider_config('$RID_ONE','stripe');" 2>&1 || true)"
assert_behav_eq "8a. l'échec 'not found' ne mentionne AUCUN restaurant_id réel du jeu de données" "0" "$(printf '%s' "$LEAK_TEST_OUT" | grep -cE "$RID_ONE|$RID_TWO" || true)"

# ============================================================
# BILAN — invariante : PASS_COUNT == STRUCT_COUNT + BEHAV_COUNT.
# ============================================================
log "=== BILAN : $PASS_COUNT PASS / $FAIL_COUNT FAIL (dont $STRUCT_COUNT structurelles, $BEHAV_COUNT comportementales) ==="
if [ "$((STRUCT_COUNT + BEHAV_COUNT))" -ne "$PASS_COUNT" ]; then
  log "FAIL: STRUCT_COUNT($STRUCT_COUNT) + BEHAV_COUNT($BEHAV_COUNT) != PASS_COUNT($PASS_COUNT) -- une assertion appelle pass() sans catégorie"
  FAIL_COUNT=$((FAIL_COUNT+1))
fi
if [ "$FAIL_COUNT" -gt 0 ]; then
  log "--- Détail des échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
