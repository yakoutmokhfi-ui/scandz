#!/usr/bin/env bash
# ============================================================
# Scanym — PAYMENT P3-B4 — PROVIDER RUNTIME MODE READ — Harnais
# reproductible pour
# supabase/DRAFT-lot-payment-p3b4-provider-runtime-mode-read.sql.
#
# PostgreSQL communautaire vanilla (pas une instance Supabase managée),
# même patron que tous les harnais paiement précédents (P1/P2A/P2B-A/
# P3-A0/P3-B0/P3-B1) : rôles anon/authenticated/service_role recréés
# minimalement, auth.uid() simulé via `test.uid`, Vault MOQUÉ (test
# harness only -- identité exacte reproduite depuis le harnais P3-A0/
# P3-B1, voir build_mock_vault) car PAYMENT P2A (prérequis de colonne
# pour ce lot -- configuration_status) exige un schéma `vault` réel
# pour s'appliquer, même si ce lot lui-même NE touche JAMAIS Vault.
#
# Chaîne (mandat section 4/25, "no hidden dependency on an unpublished
# migration") : chaîne minimale (schema.sql .. migration-v81-lot1b-
# translations.sql) -> DRAFT-lot-payment-p1-foundation.sql -> mock
# Vault -> DRAFT-lot-payment-p2a-secure-config.sql ->
# DRAFT-lot-payment-p2b-a-safe-merchant-read.sql ->
# DRAFT-lot-payment-p3a0-secure-credential-read.sql ->
# DRAFT-lot-payment-p3b0-correlation-status-read.sql (v2) ->
# DRAFT-lot-payment-p3b1-runtime-provider-enablement-read.sql (PAYMENT
# P3-B1 EST un prérequis d'ORDRE explicite de ce lot, vérifié en garde
# préflight par le lot lui-même -- voir son en-tête) -> LOT SOUS TEST.
# Les capacités soeurs (P2B-A, P3-A0, P3-B0 v2) sont appliquées ici
# NON parce que P3-B4 en dépend structurellement (aucune des trois
# n'ajoute de colonne/contrainte requise par ce lot -- vérifié), mais
# pour permettre une preuve de non-régression réelle sur ces capacités
# dans CE MÊME harnais.
#
# IMPORTANT (leçon opérationnelle de ce lot) : `PGOPTIONS="-c
# role=..."` n'est appliqué par psql QUE si la variable atteint
# effectivement le processus psql -- un `sudo -u postgres psql ...`
# depuis un shell root NE PROPAGE PAS PGOPTIONS par défaut (sudo
# réinitialise l'environnement), ce qui ferait passer silencieusement
# TOUTES les requêtes "as_anon"/"as_authenticated" en tant que
# `postgres` (superutilisateur dans une installation vanilla, donc
# AUCUNE restriction de privilège n'est alors réellement testée -- un
# faux passant dangereux, découvert et corrigé pendant l'écriture de ce
# harnais). CE SCRIPT DOIT ÊTRE INVOQUÉ EN TANT QU'UTILISATEUR SYSTÈME
# `postgres` DIRECTEMENT (`su postgres -c "bash ..."` ou
# `sudo -u postgres bash ...` -- jamais en enveloppant chaque appel
# psql individuel dans son propre `sudo -u postgres`), de sorte que les
# `PGOPTIONS=... psql` internes ci-dessous s'appliquent dans LE MÊME
# processus shell, sans traverser une seconde frontière sudo.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/payment-p3b4-provider-runtime-mode-read-check.sh"
# ou, depuis un shell root :
#   sudo -u postgres bash supabase/tests/payment-p3b4-provider-runtime-mode-read-check.sh
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
DRAFT_PAYMENT_P3B4_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b4-provider-runtime-mode-read.sql"
DB="scanym_payment_p3b4_$$"
DB_DRIFT="scanym_payment_p3b4_drift_$$"
DB_FRESH="scanym_payment_p3b4_fresh_$$"

PASS_COUNT=0
FAIL_COUNT=0
STRUCT_COUNT=0
BEHAV_COUNT=0
FAIL_LOG="/tmp/scanym-payment-p3b4-fails-$$.log"
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
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p3b4-out-$$.txt 2>/tmp/scanym-p3b4-err-$$.txt
  echo $?
}
as_anon_rc() {
  local query="$1"
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p3b4-out-$$.txt 2>/tmp/scanym-p3b4-err-$$.txt
  echo $?
}
as_user_rc() {
  local uid="$1" query="$2"
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$uid'; $query" >/tmp/scanym-p3b4-out-$$.txt 2>/tmp/scanym-p3b4-err-$$.txt
  echo $?
}
current_effective_role() {
  # Contrôle anti-régression du harnais lui-même (voir la note
  # opérationnelle en en-tête) : prouve que PGOPTIONS atteint bien le
  # processus psql AVANT de faire confiance à la moindre assertion
  # "as_anon"/"as_service" ci-dessous.
  local role="$1"
  PGOPTIONS="-c role=$role" psql -X -A -q -t -d "$DB" -c "select current_user;"
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
# harnais P3-A0/P3-B1 (build_mock_vault). PAYMENT P3-B4 lui-même NE
# référence JAMAIS `vault` -- ce mock existe UNIQUEMENT parce que
# PAYMENT P2A (prérequis de colonne configuration_status) exige que le
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
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B1_SQL" >/dev/null
}

# ============================================================
# 0. BASELINE — chaîne minimale + P1 + Vault (moqué) + P2A + P2B-A +
# P3-A0 + P3-B0 v2 + P3-B1 (toutes déjà publiées/en l'état actuel) +
# P3-B4 (LOT SOUS TEST).
# ============================================================
log "=== [0] Construction baseline $DB ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
build_full_chain "$DB"
struct "chaîne complète appliquée (minimale + P1 + Vault moqué + P2A + P2B-A + P3-A0 + P3-B0 v2 + P3-B1)"

# Contrôle anti-régression du harnais lui-même (voir note opérationnelle
# en en-tête) -- doit être vérifié AVANT toute assertion ACL en aval.
assert_struct_eq "0z. contrôle harnais -- PGOPTIONS atteint bien psql (role=anon effectif)" "anon" "$(current_effective_role anon)"

psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B4_SQL" >/dev/null
struct "DRAFT-lot-payment-p3b4-provider-runtime-mode-read.sql appliqué sans erreur (LOT SOUS TEST) -- fichier unique, forme finale directe"

# ============================================================
# FIXTURES — 2 tenants, mode DISTINCT (mandat section 21). R1
# possède DEUX configurations (monetico mode=test + mercanet mode=live)
# dans le MÊME tenant pour prouver l'isolation inter-provider avec des
# modes distincts. R2 possède une SEULE configuration (monetico,
# mode=live) -- valeurs is_enabled/configuration_status/mode toutes
# DISTINCTES de R1+monetico, nécessaire pour que la preuve d'isolation
# cross-tenant soit significative.
# ============================================================
log "=== Fixtures (Tenant Un + Tenant Deux) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
insert into restaurants (name, slug, status) values
  ('P3B4 Fixture Tenant One', 'p3b4-fixture-tenant-one', 'active'),
  ('P3B4 Fixture Tenant Two', 'p3b4-fixture-tenant-two', 'active');
SQL
RID_ONE="$(sql "select id from restaurants where slug='p3b4-fixture-tenant-one';")"
RID_TWO="$(sql "select id from restaurants where slug='p3b4-fixture-tenant-two';")"

# R1 + monetico : is_enabled=true, configuration_status='verified', mode='test'.
CRED_REF_ONE="$(psql -X -A -q -t -d "$DB" -c "insert into vault.secrets (secret, name) values ('fixture-secret-never-real', 'p3b4-fixture-one') returning id;")"
psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into payment_provider_configs (restaurant_id, provider_code, is_enabled, configuration_status, mode, credentials_ref) values ('$RID_ONE','monetico', true, 'verified', 'test', '$CRED_REF_ONE');" >/dev/null
# R1 + mercanet : is_enabled=false, configuration_status='not_configured', mode='live' (credentials_ref NULL, requis par la contrainte P2A pour not_configured).
psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into payment_provider_configs (restaurant_id, provider_code, is_enabled, configuration_status, mode) values ('$RID_ONE','mercanet', false, 'not_configured', 'live');" >/dev/null
# R2 + monetico : is_enabled=false, configuration_status='configured', mode='live' -- valeurs DÉLIBÉRÉMENT distinctes de R1+monetico (true/verified/test).
CRED_REF_TWO="$(psql -X -A -q -t -d "$DB" -c "insert into vault.secrets (secret, name) values ('fixture-secret-never-real-2', 'p3b4-fixture-two') returning id;")"
psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into payment_provider_configs (restaurant_id, provider_code, is_enabled, configuration_status, mode, credentials_ref) values ('$RID_TWO','monetico', false, 'configured', 'live', '$CRED_REF_TWO');" >/dev/null
struct "fixtures : R1 monetico(true,verified,test) + R1 mercanet(false,not_configured,live) + R2 monetico(false,configured,live) -- modes distincts par tenant"

# ============================================================
# RPC — CATALOGUE DE FONCTION (structure/ACL -- struct() exclusivement,
# aucune exécution du chemin métier dans ce bloc).
# ============================================================
log "=== [RPC] CATALOGUE DE FONCTION ==="
assert_struct_eq "1a. la fonction existe avec la signature exacte (2 arguments uuid,text)" "1" "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_payment_runtime_provider_environment' and p.pronargs=2 and array(select unnest(p.proargtypes))=array['uuid','text']::regtype[]::oid[];")"
assert_struct_eq "1b. SECURITY DEFINER (prosecdef=true)" "t" "$(sql "select prosecdef from pg_proc where proname='get_payment_runtime_provider_environment' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1c. langage = plpgsql" "plpgsql" "$(sql "select l.lanname from pg_proc p join pg_language l on l.oid=p.prolang where p.proname='get_payment_runtime_provider_environment' and p.pronamespace='public'::regnamespace;")"
assert_struct_eq "1d. volatilité = stable" "s" "$(sql "select provolatile from pg_proc where proname='get_payment_runtime_provider_environment' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1e. search_path explicitement vide" "1" "$(sql "select count(*) from pg_proc where proname='get_payment_runtime_provider_environment' and pronamespace='public'::regnamespace and 'search_path=\"\"' = any(proconfig);")"
assert_struct_eq "1f. propriétaire = rôle ayant exécuté la migration (aucun OWNER TO explicite requis)" "$(sql "select current_user;")" "$(sql "select r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner where p.proname='get_payment_runtime_provider_environment' and p.pronamespace='public'::regnamespace;")"
assert_struct_eq "1g. EXECUTE effectif service_role = OUI" "t" "$(sql "select has_function_privilege('service_role', 'public.get_payment_runtime_provider_environment(uuid,text)', 'execute');")"
assert_struct_eq "1h. EXECUTE effectif anon = NON" "f" "$(sql "select has_function_privilege('anon', 'public.get_payment_runtime_provider_environment(uuid,text)', 'execute');")"
assert_struct_eq "1i. EXECUTE effectif authenticated = NON" "f" "$(sql "select has_function_privilege('authenticated', 'public.get_payment_runtime_provider_environment(uuid,text)', 'execute');")"
assert_struct_eq "1j. AUCUN grant EXECUTE résiduel à PUBLIC" "0" "$(sql "select count(*) from information_schema.role_routine_grants where routine_schema='public' and routine_name='get_payment_runtime_provider_environment' and grantee='PUBLIC';")"
assert_struct_eq "1k. CONTRAT -- retourne EXACTEMENT 4 colonnes, dans cet ordre : provider_code,is_enabled,configuration_status,mode" "provider_code,is_enabled,configuration_status,mode" "$(sql "select array_to_string(proargnames[array_position(proargmodes,'t'::\"char\"):array_length(proargmodes,1)], ',') from pg_proc where proname='get_payment_runtime_provider_environment' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1l. type de sortie 'is_enabled' = boolean" "boolean" "$(sql "select proallargtypes[array_position(proargmodes,'t'::\"char\")+1]::regtype::text from pg_proc where proname='get_payment_runtime_provider_environment' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1m. type de sortie 'configuration_status' = text" "text" "$(sql "select proallargtypes[array_position(proargmodes,'t'::\"char\")+2]::regtype::text from pg_proc where proname='get_payment_runtime_provider_environment' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1m2. type de sortie 'mode' = text" "text" "$(sql "select proallargtypes[array_position(proargmodes,'t'::\"char\")+3]::regtype::text from pg_proc where proname='get_payment_runtime_provider_environment' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1n. PREUVE STRUCTURELLE -- les 2 SEULS arguments IN sont p_restaurant_id,p_provider_code (aucun autre champ, aucun credential/secret en entrée)" "p_restaurant_id,p_provider_code" "$(sql "select array_to_string(proargnames[1:array_position(proargmodes,'t'::\"char\")-1], ',') from pg_proc where proname='get_payment_runtime_provider_environment' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1o. AUCUN SQL dynamique (EXECUTE/format() absent du corps de la fonction)" "0" "$(sql "select (case when prosrc ilike '%execute %format%' or prosrc ilike '%execute format%' then 1 else 0 end) from pg_proc where proname='get_payment_runtime_provider_environment' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1p. AUCUN verrou FOR UPDATE/FOR SHARE dans le corps de la fonction" "0" "$(sql "select (case when prosrc ilike '%for update%' or prosrc ilike '%for share%' then 1 else 0 end) from pg_proc where proname='get_payment_runtime_provider_environment' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1q. AUCUNE instruction INSERT/UPDATE/DELETE dans le corps de la fonction (lecture pure)" "0" "$(sql "select (case when prosrc ilike '%insert into%' or prosrc ilike '%update %set%' or prosrc ilike '%delete from%' then 1 else 0 end) from pg_proc where proname='get_payment_runtime_provider_environment' and pronamespace='public'::regnamespace;")"

# ============================================================
# AUCUNE SURFACE SECRÈTE (mandat sections 9/28) -- catalogue seul.
# ============================================================
log "=== AUCUNE SURFACE SECRÈTE (contrat de colonnes) ==="
NO_SECRET_COLS="$(sql "select count(*) from unnest(string_to_array((select array_to_string(proargnames[array_position(proargmodes,'t'::\"char\"):array_length(proargmodes,1)], ',') from pg_proc where proname='get_payment_runtime_provider_environment' and pronamespace='public'::regnamespace), ',')) col where col ilike '%credential%' or col ilike '%secret%' or col ilike '%vault%' or col ilike '%key%' or col='id' or col='restaurant_id';")"
assert_struct_eq "1r. AUCUNE colonne de sortie ne contient credential/secret/vault/key, ni id/restaurant_id" "0" "$NO_SECRET_COLS"

# ============================================================
# UNICITÉ + CONTRAINTES (mandat sections 11/19/20) -- struct().
# ============================================================
log "=== UNICITÉ RESTAURANT_ID+PROVIDER_CODE ==="
assert_struct_eq "1s. contrainte unique(restaurant_id, provider_code) toujours présente sur payment_provider_configs" "1" "$(sql "select count(*) from pg_constraint where conrelid='public.payment_provider_configs'::regclass and contype='u' and pg_get_constraintdef(oid) ilike '%restaurant_id%' and pg_get_constraintdef(oid) ilike '%provider_code%';")"

log "=== CONFIGURATION_STATUS / MODE -- CONTRAINTES INCHANGÉES ==="
assert_struct_eq "1t. contrainte CHECK configuration_status inchangée -- exactement not_configured/configured/verified (P2A, non modifiée par ce lot)" "1" "$(sql "select count(*) from pg_constraint where conrelid='public.payment_provider_configs'::regclass and contype='c' and conname='payment_provider_configs_configuration_status_check' and pg_get_constraintdef(oid) ilike '%not_configured%' and pg_get_constraintdef(oid) ilike '%configured%' and pg_get_constraintdef(oid) ilike '%verified%';")"
assert_struct_eq "1u. contrainte CHECK mode inchangée -- exactement test/live (P1, non modifiée par ce lot)" "1" "$(sql "select count(*) from pg_constraint where conrelid='public.payment_provider_configs'::regclass and contype='c' and conname='payment_provider_configs_mode_check' and pg_get_constraintdef(oid) ilike '%test%' and pg_get_constraintdef(oid) ilike '%live%';")"

# ============================================================
# RPC — COMPORTEMENT (exécution réelle -- behav() exclusivement).
# ============================================================
log "=== [RPC] COMPORTEMENT ==="
RC_R1_MONETICO="$(as_service_rc "select * from public.get_payment_runtime_provider_environment('$RID_ONE','monetico');")"
assert_behav_eq "2a. R1+monetico : lecture réussit" "0" "$RC_R1_MONETICO"
OUT_R1_MONETICO="$(as_service "select provider_code, is_enabled, configuration_status, mode from public.get_payment_runtime_provider_environment('$RID_ONE','monetico');")"
assert_behav_eq "2b. R1+monetico renvoie EXACTEMENT monetico|t|verified|test" "monetico|t|verified|test" "$OUT_R1_MONETICO"

OUT_R1_MERCANET="$(as_service "select provider_code, is_enabled, configuration_status, mode from public.get_payment_runtime_provider_environment('$RID_ONE','mercanet');")"
assert_behav_eq "2c. R1+mercanet renvoie EXACTEMENT mercanet|f|not_configured|live (mode='live' isolé du mode='test' de R1+monetico, MÊME tenant)" "mercanet|f|not_configured|live" "$OUT_R1_MERCANET"

OUT_R2_MONETICO="$(as_service "select provider_code, is_enabled, configuration_status, mode from public.get_payment_runtime_provider_environment('$RID_TWO','monetico');")"
assert_behav_eq "2d. R2+monetico renvoie EXACTEMENT monetico|f|configured|live" "monetico|f|configured|live" "$OUT_R2_MONETICO"

# 2e-2h : isolation cross-tenant EXPLICITE (mandat section 21) -- R1 et
# R2 partagent le même provider_code (monetico) mais des valeurs
# is_enabled/configuration_status/mode DISTINCTES ; chaque lecture doit
# renvoyer EXACTEMENT les valeurs de SON tenant, jamais celles de
# l'autre.
MODE_R1_MONETICO_ONLY="$(as_service "select mode from public.get_payment_runtime_provider_environment('$RID_ONE','monetico');")"
MODE_R2_MONETICO_ONLY="$(as_service "select mode from public.get_payment_runtime_provider_environment('$RID_TWO','monetico');")"
assert_behav_eq "2e. mode isolé de R1+monetico = test EXACTEMENT, jamais live (valeur de R2+monetico) -- PREUVE CENTRALE DE CE LOT" "test" "$MODE_R1_MONETICO_ONLY"
assert_behav_eq "2f. mode isolé de R2+monetico = live EXACTEMENT, jamais test (valeur de R1+monetico) -- isolation dans les deux sens" "live" "$MODE_R2_MONETICO_ONLY"
IS_ENABLED_R1_MONETICO_ONLY="$(as_service "select is_enabled from public.get_payment_runtime_provider_environment('$RID_ONE','monetico');")"
IS_ENABLED_R2_MONETICO_ONLY="$(as_service "select is_enabled from public.get_payment_runtime_provider_environment('$RID_TWO','monetico');")"
assert_behav_eq "2g. is_enabled isolé de R1+monetico = t EXACTEMENT, jamais f (valeur de R2+monetico)" "t" "$IS_ENABLED_R1_MONETICO_ONLY"
assert_behav_eq "2h. is_enabled isolé de R2+monetico = f EXACTEMENT, jamais t (valeur de R1+monetico)" "f" "$IS_ENABLED_R2_MONETICO_ONLY"

# Isolation inter-provider pour un MÊME tenant (R1+monetico mode=test
# vs R1+mercanet mode=live) : ne doivent jamais se mélanger.
assert_behav_eq "2i. R1+monetico (mode=test) et R1+mercanet (mode=live) restent bien DISTINCTS pour le MÊME tenant" "test|live" "${MODE_R1_MONETICO_ONLY}|$(as_service "select mode from public.get_payment_runtime_provider_environment('$RID_ONE','mercanet');")"

RC_UNKNOWN_RESTAURANT="$(as_service_rc "select * from public.get_payment_runtime_provider_environment('00000000-0000-0000-0000-000000000000','monetico');")"
assert_behav_eq "3a. restaurant inconnu -> aucun résultat utilisable (échec fermé, P0002)" "1" "$([ "$RC_UNKNOWN_RESTAURANT" != "0" ] && echo 1 || echo 0)"
RC_UNKNOWN_PROVIDER="$(as_service_rc "select * from public.get_payment_runtime_provider_environment('$RID_ONE','stripe');")"
assert_behav_eq "3b. provider inconnu pour un restaurant existant -> aucun résultat utilisable" "1" "$([ "$RC_UNKNOWN_PROVIDER" != "0" ] && echo 1 || echo 0)"
RC_WRONG_COMBINATION="$(as_service_rc "select * from public.get_payment_runtime_provider_environment('$RID_TWO','mercanet');")"
assert_behav_eq "3c. combinaison restaurant/provider valide individuellement mais jamais configurée ensemble (R2+mercanet) -> aucun résultat utilisable" "1" "$([ "$RC_WRONG_COMBINATION" != "0" ] && echo 1 || echo 0)"
RC_NULL_RESTAURANT="$(as_service_rc "select * from public.get_payment_runtime_provider_environment(null,'monetico');")"
assert_behav_eq "3d. p_restaurant_id NULL -> échec fermé" "1" "$([ "$RC_NULL_RESTAURANT" != "0" ] && echo 1 || echo 0)"
RC_NULL_PROVIDER="$(as_service_rc "select * from public.get_payment_runtime_provider_environment('$RID_ONE',null);")"
assert_behav_eq "3e. p_provider_code NULL -> échec fermé" "1" "$([ "$RC_NULL_PROVIDER" != "0" ] && echo 1 || echo 0)"
RC_EMPTY_PROVIDER="$(as_service_rc "select * from public.get_payment_runtime_provider_environment('$RID_ONE','');")"
assert_behav_eq "3f. p_provider_code vide -> échec fermé" "1" "$([ "$RC_EMPTY_PROVIDER" != "0" ] && echo 1 || echo 0)"
RC_WHITESPACE_PROVIDER="$(as_service_rc "select * from public.get_payment_runtime_provider_environment('$RID_ONE','   ');")"
assert_behav_eq "3g. p_provider_code uniquement blancs -> échec fermé (normalisé à vide après btrim)" "1" "$([ "$RC_WHITESPACE_PROVIDER" != "0" ] && echo 1 || echo 0)"
RC_BOTH_NULL="$(as_service_rc "select * from public.get_payment_runtime_provider_environment(null,null);")"
assert_behav_eq "3h. p_restaurant_id/p_provider_code tous deux NULL -> échec fermé" "1" "$([ "$RC_BOTH_NULL" != "0" ] && echo 1 || echo 0)"
RC_WHITESPACE_PADDED_MATCH="$(as_service "select provider_code from public.get_payment_runtime_provider_environment('$RID_ONE','  monetico  ');" 2>&1)"
assert_behav_eq "3i. provider_code avec espaces superflus est normalisé (btrim) puis correspond -- même convention que P3-A0/P3-B0/P3-B1" "monetico" "$RC_WHITESPACE_PADDED_MATCH"

RC_ANON="$(as_anon_rc "select * from public.get_payment_runtime_provider_environment('$RID_ONE','monetico');")"
assert_behav_eq "4a. anon NE PEUT PAS exécuter la lecture runtime" "1" "$([ "$RC_ANON" != "0" ] && echo 1 || echo 0)"
RC_AUTH="$(as_user_rc "00000000-0000-0000-0000-000000000099" "select * from public.get_payment_runtime_provider_environment('$RID_ONE','monetico');")"
assert_behav_eq "4b. authenticated NE PEUT PAS exécuter la lecture runtime (même sans lien de membership -- l'EXECUTE lui-même est refusé)" "1" "$([ "$RC_AUTH" != "0" ] && echo 1 || echo 0)"

RC_DIRECT_SELECT="$(as_service_rc "select count(*) from payment_provider_configs;")"
assert_behav_eq "5. service_role NE PEUT toujours PAS lire payment_provider_configs DIRECTEMENT après P3-B4 (aucun grant de table nouveau)" "1" "$([ "$RC_DIRECT_SELECT" != "0" ] && echo 1 || echo 0)"

CONFIG_COUNT_BEFORE="$(sql "select count(*) from payment_provider_configs;")"
as_service "select * from public.get_payment_runtime_provider_environment('$RID_ONE','monetico');" >/dev/null
as_service "select * from public.get_payment_runtime_provider_environment('$RID_ONE','stripe');" >/dev/null 2>&1 || true
CONFIG_COUNT_AFTER="$(sql "select count(*) from payment_provider_configs;")"
assert_behav_eq "6a. aucune mutation de payment_provider_configs après plusieurs appels (succès et échecs)" "$CONFIG_COUNT_BEFORE" "$CONFIG_COUNT_AFTER"
MODE_UNCHANGED="$(sql "select mode from payment_provider_configs where restaurant_id='$RID_ONE' and provider_code='monetico';")"
assert_behav_eq "6b. mode de R1+monetico reste 'test' après lectures répétées (lecture pure)" "test" "$MODE_UNCHANGED"
IS_ENABLED_UNCHANGED="$(sql "select is_enabled from payment_provider_configs where restaurant_id='$RID_ONE' and provider_code='monetico';")"
assert_behav_eq "6c. is_enabled de R1+monetico reste 't' après lectures répétées" "t" "$IS_ENABLED_UNCHANGED"

# ============================================================
# NON-RÉGRESSION (mandat sections 16/17) -- ACL de table + capacités
# soeurs (dont PAYMENT P3-B1, la capacité que ce lot complète SANS la
# modifier) toujours fonctionnelles et INCHANGÉES.
# ============================================================
log "=== NON-RÉGRESSION ==="
assert_struct_eq "7a. payment_provider_configs : service_role toujours SANS SELECT direct" "f" "$(sql "select has_table_privilege('service_role','payment_provider_configs','SELECT');")"
assert_struct_eq "7b. payment_provider_configs : service_role toujours SANS INSERT/UPDATE/DELETE direct" "f" "$(sql "select has_table_privilege('service_role','payment_provider_configs','INSERT') or has_table_privilege('service_role','payment_provider_configs','UPDATE') or has_table_privilege('service_role','payment_provider_configs','DELETE');")"
assert_struct_eq "7c. payment_provider_configs : anon/authenticated toujours SANS aucun privilège direct" "0" "$(sql "select count(*) from information_schema.role_table_grants where table_schema='public' and table_name='payment_provider_configs' and grantee in ('anon','authenticated');")"

assert_struct_eq "7d. get_payment_runtime_provider_config (PAYMENT P3-B1) toujours présente, signature (uuid,text) inchangée" "1" "$(sql "select count(*) from pg_proc where proname='get_payment_runtime_provider_config' and pronamespace='public'::regnamespace and pronargs=2;")"
assert_struct_eq "7e. get_payment_runtime_provider_config (PAYMENT P3-B1) toujours EXACTEMENT 3 colonnes de sortie (provider_code,is_enabled,configuration_status) -- contrat NON rouvert par ce lot" "provider_code,is_enabled,configuration_status" "$(sql "select array_to_string(proargnames[array_position(proargmodes,'t'::\"char\"):array_length(proargmodes,1)], ',') from pg_proc where proname='get_payment_runtime_provider_config' and pronamespace='public'::regnamespace;")"
RC_P3B1_STILL_WORKS="$(as_service_rc "select * from public.get_payment_runtime_provider_config('$RID_ONE','monetico');")"
assert_behav_eq "7f. get_payment_runtime_provider_config (PAYMENT P3-B1) toujours fonctionnelle -- capacité soeur non cassée par ce lot" "0" "$RC_P3B1_STILL_WORKS"
OUT_P3B1_UNCHANGED="$(as_service "select provider_code, is_enabled, configuration_status from public.get_payment_runtime_provider_config('$RID_ONE','monetico');")"
assert_behav_eq "7g. get_payment_runtime_provider_config renvoie encore EXACTEMENT monetico|t|verified (résultat identique à avant ce lot, mode simplement absent de son contrat -- jamais ajouté)" "monetico|t|verified" "$OUT_P3B1_UNCHANGED"

assert_struct_eq "7h. get_merchant_payment_provider_config (P2B-A) toujours présente, EXECUTE inchangé (authenticated seul)" "t" "$(sql "select has_function_privilege('authenticated', 'public.get_merchant_payment_provider_config(uuid)', 'execute');")"
assert_struct_eq "7i. get_merchant_payment_provider_config : service_role toujours SANS EXECUTE" "f" "$(sql "select has_function_privilege('service_role', 'public.get_merchant_payment_provider_config(uuid)', 'execute');")"
assert_struct_eq "7j. get_payment_provider_credential (P3-A0) toujours présente, signature (uuid,text) inchangée" "1" "$(sql "select count(*) from pg_proc where proname='get_payment_provider_credential' and pronamespace='public'::regnamespace and pronargs=2;")"
RC_CRED_STILL_WORKS="$(as_service_rc "select public.get_payment_provider_credential('$RID_ONE','monetico');")"
assert_behav_eq "7k. get_payment_provider_credential (P3-A0) toujours fonctionnelle (R1+monetico, configuration_status='verified', credentials_ref renseigné) -- capacité soeur non cassée par ce lot" "0" "$RC_CRED_STILL_WORKS"
RC_MERCH_RPC_STILL_WORKS="$(as_user_rc "00000000-0000-0000-0000-000000000001" "select public.get_merchant_payment_provider_config('$RID_ONE');")"
assert_behav_eq "7l. get_merchant_payment_provider_config (P2B-A) toujours exécutable normalement (rejet attendu -- non membre -- pas une erreur de fonction cassée/absente)" "1" "$([ "$RC_MERCH_RPC_STILL_WORKS" != "0" ] && echo 1 || echo 0)"

assert_struct_eq "7m. initiate_payment_attempt (PAYMENT P1) toujours présente, signature inchangée" "1" "$(sql "select count(*) from pg_proc where proname='initiate_payment_attempt' and pronamespace='public'::regnamespace and pronargs=3;")"
assert_struct_eq "7n. confirm_payment_attempt (PAYMENT P1) toujours présente, signature inchangée" "1" "$(sql "select count(*) from pg_proc where proname='confirm_payment_attempt' and pronamespace='public'::regnamespace and pronargs=4;")"
assert_struct_eq "7o. get_payment_transaction_correlation (PAYMENT P3-B0) toujours présente" "1" "$(sql "select count(*) from pg_proc where proname='get_payment_transaction_correlation' and pronamespace='public'::regnamespace;")"
assert_struct_eq "7p. get_order_payment_status (PAYMENT P3-B0) toujours présente" "1" "$(sql "select count(*) from pg_proc where proname='get_order_payment_status' and pronamespace='public'::regnamespace;")"

# ============================================================
# GARDES ANTI-DÉRIVE (exécution réelle de la migration -- behav()).
# ============================================================
log "=== GARDES ANTI-DÉRIVE ==="
RC_DOUBLE_APPLY="$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B4_SQL" >/tmp/scanym-p3b4-double-$$.out 2>&1; echo $?)"
assert_behav_eq "D1. double application du lot REFUSÉE (SCANYM_SCHEMA_DRIFT)" "1" "$([ "$RC_DOUBLE_APPLY" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "D2. message de double application mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" /tmp/scanym-p3b4-double-$$.out || true)"
rm -f /tmp/scanym-p3b4-double-$$.out

log "=== GARDE — base SANS payment_provider_configs (prérequis P1 manquant) ==="
psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
createdb "$DB_DRIFT"
build_common_bootstrap "$DB_DRIFT"
build_minimal_chain "$DB_DRIFT"
RC_MISSING_P1="$(psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B4_SQL" >/tmp/scanym-p3b4-drift1-$$.out 2>&1; echo $?)"
assert_behav_eq "D3. application sur base SANS payment_provider_configs (P1 absent) REFUSÉE dès la garde préflight" "1" "$([ "$RC_MISSING_P1" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "D4. message mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" /tmp/scanym-p3b4-drift1-$$.out || true)"
rm -f /tmp/scanym-p3b4-drift1-$$.out

log "=== GARDE — base AVEC P1 mais SANS configuration_status (prérequis P2A manquant) ==="
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P1_SQL" >/dev/null
RC_MISSING_P2A="$(psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B4_SQL" >/tmp/scanym-p3b4-drift2-$$.out 2>&1; echo $?)"
assert_behav_eq "D5. application sur base AVEC P1 mais SANS configuration_status (P2A absent) REFUSÉE dès la garde préflight" "1" "$([ "$RC_MISSING_P2A" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "D6. message mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" /tmp/scanym-p3b4-drift2-$$.out || true)"
rm -f /tmp/scanym-p3b4-drift2-$$.out

log "=== GARDE — base AVEC P1+P2A mais SANS PAYMENT P3-B1 (garde d'ORDRE de capacités) ==="
build_mock_vault "$DB_DRIFT"
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2A_SQL" >/dev/null
RC_MISSING_P3B1="$(psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B4_SQL" >/tmp/scanym-p3b4-drift3-$$.out 2>&1; echo $?)"
assert_behav_eq "D7. application sur base AVEC P1+P2A mais SANS PAYMENT P3-B1 REFUSÉE dès la garde préflight (cohérence d'ordre de capacités, mandat section 4)" "1" "$([ "$RC_MISSING_P3B1" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "D8. message mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" /tmp/scanym-p3b4-drift3-$$.out || true)"
rm -f /tmp/scanym-p3b4-drift3-$$.out

log "=== GARDE — mode CHECK constraint absente/différente (contrainte renommée simulée) ==="
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B1_SQL" >/dev/null
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -c "alter table payment_provider_configs drop constraint payment_provider_configs_mode_check;" >/dev/null
RC_MISSING_MODE_CHECK="$(psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B4_SQL" >/tmp/scanym-p3b4-drift4-$$.out 2>&1; echo $?)"
assert_behav_eq "D9. application sur base où la contrainte CHECK mode a été retirée REFUSÉE (mandat section 27, sémantique de mode ambiguë)" "1" "$([ "$RC_MISSING_MODE_CHECK" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "D10. message mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" /tmp/scanym-p3b4-drift4-$$.out || true)"
rm -f /tmp/scanym-p3b4-drift4-$$.out

# ============================================================
# ABSENCE DE FUITE — aucun message d'erreur ne révèle l'existence/le
# contenu d'une autre tentative/tenant.
# ============================================================
log "=== ABSENCE DE FUITE ==="
LEAK_TEST_OUT="$(as_service "select * from public.get_payment_runtime_provider_environment('$RID_ONE','stripe');" 2>&1 || true)"
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
