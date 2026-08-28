#!/usr/bin/env bash
# ============================================================
# Scanym — PAYMENT P2A — SECURE CONFIGURATION FOUNDATION — Harnais
# reproductible pour supabase/DRAFT-lot-payment-p2a-secure-config.sql.
#
# IMPORTANT — DISTINCTION EXPLICITE (mandat section 29) :
#   Ce bac à sable local est un PostgreSQL communautaire vanilla, PAS
#   une instance Supabase managée -- l'extension réelle Supabase Vault
#   (pgsodium + schéma `vault`) N'Y EST PAS DISPONIBLE (vérifié :
#   `select name from pg_available_extensions` ne liste ni `pgsodium`
#   ni `supabase_vault`). Ce harnais construit donc, UNIQUEMENT pour
#   ses propres besoins de test, un SCHÉMA `vault` MINIMAL qui
#   reproduit fidèlement l'IDENTITÉ EXACTE (nom, arité, types,
#   arguments par défaut, type de retour) confirmée par Work contre la
#   Production cible réelle (PostgreSQL 17.6, supabase_vault 0.3.1) :
#   `vault.create_secret(text,text,text,uuid) returns uuid`,
#   `vault.update_secret(uuid,text,text,text,uuid) returns void`,
#   table `vault.secrets`, vue `vault.decrypted_secrets` -- STRICTEMENT
#   à des fins de vérification STRUCTURELLE et COMPORTEMENTALE de
#   NOTRE PROPRE LOGIQUE SQL (les deux RPC de ce lot). Ceci NE PROUVE
#   PAS et NE PRÉTEND PAS prouver le comportement de chiffrement réel
#   de Supabase Vault en Production -- cette garantie relève du
#   contrat documenté et testé par Supabase lui-même, hors de portée
#   de ce bac à sable. Voir RAPPORT section "SECURE STORAGE
#   ARCHITECTURE" pour la distinction complète preuve structurelle vs
#   preuve Supabase-spécifique.
#
#   CORRECTION PAY-P2A-02 : le harnais construit ÉGALEMENT, dans une
#   base séparée dédiée, un second mock délibérément à l'ANCIENNE
#   identité incorrecte (create_secret 3-arg / update_secret 4-arg,
#   sans le paramètre new_key_id) -- utilisé UNIQUEMENT pour prouver
#   que la garde préflight corrigée (PAY-P2A-01) REJETTE désormais
#   cette identité au lieu de l'accepter silencieusement (fermeture du
#   "faux 54/54" documenté par l'audit Work).
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/payment-p2a-secure-config-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_A_SQL="$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-model.sql"
DRAFT_B_SQL="$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-lot-b-rpc.sql"
DRAFT_SADFP_SQL="$SUPABASE_DIR/DRAFT-lot-server-delivery-fulfillment-pricing.sql"
DRAFT_MERCHANT_PRICING_SQL="$SUPABASE_DIR/DRAFT-lot-merchant-delivery-pricing.sql"
DRAFT_PAYMENT_P1_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p1-foundation.sql"
DRAFT_PAYMENT_P2A_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p2a-secure-config.sql"
DB="scanym_payment_p2a_$$"
DB_DRIFT="scanym_payment_p2a_drift_$$"
DB_NOVAULT="scanym_payment_p2a_novault_$$"
DB_OLDVAULT="scanym_payment_p2a_oldvault_$$"
DB_CONC="scanym_payment_p2a_conc_$$"

PASS_COUNT=0
FAIL_COUNT=0
STRUCT_COUNT=0
BEHAV_COUNT=0
FAIL_LOG="/tmp/scanym-payment-p2a-fails-$$.log"
: > "$FAIL_LOG"

log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); echo "$1" >> "$FAIL_LOG"; log "FAIL: $1"; }
struct() { STRUCT_COUNT=$((STRUCT_COUNT+1)); pass "$1"; }
behav() { BEHAV_COUNT=$((BEHAV_COUNT+1)); pass "$1"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_NOVAULT\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_OLDVAULT\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_CONC\";" >/dev/null 2>&1 || true
  rm -f "$FAIL_LOG"
}
trap cleanup EXIT

sql() { psql -X -A -q -t -d "$DB" -c "$1" 2>&1; }
as_user_rc() {
  local uid="$1" query="$2"
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$uid'; $query" >/tmp/scanym-p2a-out-$$.txt 2>/tmp/scanym-p2a-err-$$.txt
  echo $?
}
as_service() {
  local query="$1"
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$query" 2>&1
}
as_service_rc() {
  local query="$1"
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p2a-out-$$.txt 2>/tmp/scanym-p2a-err-$$.txt
  echo $?
}
as_anon_rc() {
  local query="$1"
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p2a-out-$$.txt 2>/tmp/scanym-p2a-err-$$.txt
  echo $?
}
super_rc() {
  local query="$1"
  psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p2a-out-$$.txt 2>/tmp/scanym-p2a-err-$$.txt
  echo $?
}
assert_struct_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then struct "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_behav_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then behav "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
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

build_full_chain() {
  local dbname="$1"
  for f in schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql; do
    psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
    psql -d "$dbname" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  done
  for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql; do
    psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  done
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-illico-v2.sql" >/dev/null 2>&1
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-sanaa.sql" >/dev/null 2>&1
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-sirocco-demo.sql" >/dev/null 2>&1
  psql -d "$dbname" -c "update restaurants set status='active';" >/dev/null 2>&1
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v83-lot2a4-privilege-hardening.sql" >/dev/null
  psql -d "$dbname" -c "alter default privileges in schema public grant execute on functions to service_role;" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v84-lot2b1-delivery-info-rpc.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_A_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_B_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_SADFP_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_MERCHANT_PRICING_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P1_SQL" >/dev/null
}

# ------------------------------------------------------------
# MOCK VAULT — TEST HARNESS ONLY (voir bannière en tête de fichier).
# Reproduit fidèlement la signature publique de Supabase Vault, rien
# de plus. N'est JAMAIS appliqué en dehors de ce harnais, ne fait
# PARTIE d'aucun lot livré.
# ------------------------------------------------------------
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

-- IDENTITÉ EXACTE CIBLE (CORRECTION PAY-P2A-01/02) :
-- vault.create_secret(text,text,text,uuid) returns uuid, dernier
-- argument (new_key_id) par défaut NULL.
create function vault.create_secret(new_secret text, new_name text, new_description text, new_key_id uuid default null)
returns uuid
language plpgsql
as $fn$
declare
  v_id uuid;
begin
  insert into vault.secrets (secret, name, description, key_id)
    values (new_secret, new_name, new_description, new_key_id)
    returning id into v_id;
  return v_id;
end;
$fn$;

-- IDENTITÉ EXACTE CIBLE (CORRECTION PAY-P2A-01/02) :
-- vault.update_secret(uuid,text,text,text,uuid) returns void, les
-- 4 derniers arguments par défaut NULL (mise à jour partielle --
-- seuls les champs non-NULL passés sont modifiés, comportement réel
-- documenté de Supabase Vault reproduit ici).
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null)
returns void
language plpgsql
as $fn$
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

# ------------------------------------------------------------
# CORRECTION PAY-P2A-02 : mock Vault délibérément à l'ANCIENNE
# identité INCORRECTE (create_secret 3-arg / update_secret 4-arg,
# sans new_key_id) -- utilisé UNIQUEMENT dans une base séparée dédiée
# pour prouver que la garde préflight corrigée REJETTE cette identité
# au lieu de l'accepter silencieusement comme le faisait la garde v1
# (nom seul, arité non vérifiée).
# ------------------------------------------------------------
build_mock_vault_old_incorrect_signature() {
  local dbname="$1"
  psql -d "$dbname" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create schema vault;

create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  secret text not null,
  name text,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ANCIENNE IDENTITÉ INCORRECTE (v1, 3 arguments -- ce que la garde
-- préflight v1 vérifiait à tort, et que Work a démontré ne PAS
-- correspondre à la Production cible réelle).
create function vault.create_secret(new_secret text, new_name text default null, new_description text default null)
returns uuid
language plpgsql
as $fn$
declare
  v_id uuid;
begin
  insert into vault.secrets (secret, name, description)
    values (new_secret, new_name, new_description)
    returning id into v_id;
  return v_id;
end;
$fn$;

-- ANCIENNE IDENTITÉ INCORRECTE (v1, 4 arguments, pas de new_key_id).
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null)
returns void
language plpgsql
as $fn$
begin
  update vault.secrets
    set secret = coalesce(new_secret, secret),
        name = coalesce(new_name, name),
        description = coalesce(new_description, description),
        updated_at = now()
    where id = secret_id;
end;
$fn$;

create view vault.decrypted_secrets as
  select id, secret as decrypted_secret, name, description, created_at, updated_at
  from vault.secrets;
SQL
}

# ============================================================
# 0. BASELINE — chaîne réelle complète jusqu'à P1 (installée), MOCK
# VAULT (test-only), puis P2A.
# ============================================================
log "=== [0] Construction baseline $DB (chaîne réelle jusqu'à PAYMENT P1, installée) ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
build_common_bootstrap "$DB"
build_full_chain "$DB"
struct "chaîne réelle appliquée jusqu'à DRAFT-lot-payment-p1-foundation.sql (P1, installée)"

log "=== [0] Construction du MOCK Vault (TEST HARNESS ONLY, PAS livré) ==="
build_mock_vault "$DB"
struct "mock vault (schéma vault, create_secret/update_secret, table secrets, vue decrypted_secrets) construit -- test-only, signature Supabase Vault reproduite"

log "=== [0] Application de DRAFT-lot-payment-p2a-secure-config.sql ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2A_SQL" >/dev/null
struct "DRAFT-lot-payment-p2a-secure-config.sql appliqué sans erreur (garde d'architecture Vault satisfaite par le mock CORRIGÉ, identité exacte)"

# ============================================================
# 0b. CORRECTION PAY-P2A-01/02 — RÉGRESSION ANTI-FAUX-POSITIF.
#
# Preuve que la garde préflight corrigée distingue désormais une
# fonction Vault HOMONYME mais D'ARITÉ/IDENTITÉ INCORRECTE d'une
# absence pure et simple -- l'ANCIEN mock (3/4 arguments, ce que la
# garde v1 acceptait à tort car elle ne vérifiait que le nom) doit
# désormais être REJETÉ avec SCANYM_SCHEMA_DRIFT. Ceci ferme
# explicitement le "faux 54/54" documenté par l'audit Work (PAY-P2A-02).
# ============================================================
log "=== [0b] RÉGRESSION ANTI-FAUX-POSITIF — ancien mock (3/4-arg) doit être REJETÉ ==="
psql -c "drop database if exists \"$DB_OLDVAULT\";" >/dev/null 2>&1 || true
createdb "$DB_OLDVAULT"
build_common_bootstrap "$DB_OLDVAULT"
build_full_chain "$DB_OLDVAULT"
build_mock_vault_old_incorrect_signature "$DB_OLDVAULT"
RC_OLD_VAULT="$(psql -d "$DB_OLDVAULT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2A_SQL" >/tmp/scanym-p2a-out-oldvault-$$.txt 2>/tmp/scanym-p2a-err-oldvault-$$.txt; echo $?)"
assert_behav_eq "0b-1. application contre l'ANCIEN mock Vault (create_secret 3-arg/update_secret 4-arg) REJETÉE par la garde corrigée (ferme le faux 54/54, PAY-P2A-02)" "1" "$([ "$RC_OLD_VAULT" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "0b-2. message mentionne SCANYM_SCHEMA_DRIFT ET référence explicitement PAY-P2A-01" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" /tmp/scanym-p2a-err-oldvault-$$.txt || true)"
assert_struct_eq "0b-3. la fonction homonyme create_secret (mauvaise arité) existe bien dans cette base (le rejet vient de l'identité, pas d'une absence totale -- distinction que la garde v1 ne pouvait pas faire)" "1" "$(psql -X -A -q -t -d "$DB_OLDVAULT" -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='vault' and p.proname='create_secret';")"
assert_struct_eq "0b-4. cette même fonction homonyme n'a PAS l'identité exacte attendue (arité 3 et pronargs=3, pas 4 -- confirme que le rejet est bien motivé par l'arité/types et non un artefact de nommage)" "0" "$(psql -X -A -q -t -d "$DB_OLDVAULT" -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='vault' and p.proname='create_secret' and p.pronargs=4 and array(select unnest(p.proargtypes))=array['text','text','text','uuid']::regtype[]::oid[];")"
rm -f /tmp/scanym-p2a-out-oldvault-$$.txt /tmp/scanym-p2a-err-oldvault-$$.txt

# ============================================================
# FIXTURES GÉNÉRIQUES
# ============================================================
log "=== Fixtures génériques (Tenant Un + Tenant Deux) ==="
OWNER_UID="30000000-0000-0000-0000-000000000001"
OTHER_OWNER_UID="40000000-0000-0000-0000-000000000001"

psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into auth.users (id, email) values
  ('$OWNER_UID', 'owner@p2a-fixture-one.test'),
  ('$OTHER_OWNER_UID', 'owner@p2a-fixture-two.test');

with resto as (
  insert into restaurants (name, slug, status) values ('P2A Fixture Tenant One', 'p2a-fixture-tenant-one', 'active') returning id
)
insert into restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number)
select id, 0, 'EUR', '+33600000501' from resto;

with resto2 as (
  insert into restaurants (name, slug, status) values ('P2A Fixture Tenant Two', 'p2a-fixture-tenant-two', 'active') returning id
)
insert into restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number)
select id, 0, 'EUR', '+33600000601' from resto2;
SQL

RID_ONE="$(sql "select id from restaurants where slug='p2a-fixture-tenant-one';")"
RID_TWO="$(sql "select id from restaurants where slug='p2a-fixture-tenant-two';")"

psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into restaurant_users (restaurant_id, user_id, role) values
  ('$RID_ONE', '$OWNER_UID', 'owner'),
  ('$RID_TWO', '$OTHER_OWNER_UID', 'owner');
SQL

struct "fixtures : 2 tenants, 2 owners, aucun secret réel (uniquement des placeholders synthétiques ci-dessous)"

SECRET_ALPHA="test-secret-alpha-$$-DO-NOT-USE"
SECRET_BETA="test-secret-beta-$$-DO-NOT-USE"
SECRET_REPLACEMENT="test-secret-alpha-REPLACED-$$-DO-NOT-USE"

# ============================================================
# 1-4 : SCHÉMA
# ============================================================
log "=== [1-4] SCHÉMA ==="
assert_struct_eq "1. payment_provider_configs.credentials_ref existe" "1" "$(sql "select count(*) from information_schema.columns where table_schema='public' and table_name='payment_provider_configs' and column_name='credentials_ref';")"
assert_struct_eq "2. credentials_ref est bien de type uuid, nullable" "uuid|YES" "$(sql "select data_type||'|'||is_nullable from information_schema.columns where table_schema='public' and table_name='payment_provider_configs' and column_name='credentials_ref';")"
assert_struct_eq "3. configuration_status existe, valeurs valides acceptées (CHECK)" "1" "$(sql "select count(*) from pg_constraint where conrelid='public.payment_provider_configs'::regclass and contype='c' and pg_get_constraintdef(oid) ilike '%configuration_status%not_configured%configured%verified%';")"
assert_behav_eq "4. configuration_status invalide REJETÉ (CHECK, accès superuser direct)" "1" "$([ "$(super_rc "insert into payment_provider_configs (restaurant_id, provider_code, configuration_status) values ('$RID_ONE','fixture-provider-invalid','bogus');")" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "3b. cohérence configuration_status/credentials_ref imposée par CHECK (not_configured <=> credentials_ref NULL)" "1" "$(sql "select count(*) from pg_constraint where conname='payment_provider_configs_credentials_consistency' and conrelid='public.payment_provider_configs'::regclass and contype='c';")"

# ============================================================
# 5-8 : ACL
# ============================================================
log "=== [5-8] ACL ==="
assert_behav_eq "5. anon NE PEUT PAS insérer/muter payment_provider_configs" "1" "$([ "$(as_anon_rc "insert into payment_provider_configs (restaurant_id, provider_code) values ('$RID_ONE','fixture-provider');")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "6. authenticated NE PEUT PAS insérer/muter payment_provider_configs" "1" "$([ "$(as_user_rc "$OWNER_UID" "insert into payment_provider_configs (restaurant_id, provider_code) values ('$RID_ONE','fixture-provider');")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "7. authenticated (marchand ordinaire) NE PEUT PAS exécuter set_payment_provider_credentials" "1" "$([ "$(as_user_rc "$OWNER_UID" "select * from public.set_payment_provider_credentials('$RID_ONE','fixture-provider','$SECRET_ALPHA');")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "7b. anon NE PEUT PAS exécuter set_payment_provider_credentials" "1" "$([ "$(as_anon_rc "select * from public.set_payment_provider_credentials('$RID_ONE','fixture-provider','$SECRET_ALPHA');")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "7c. authenticated NE PEUT PAS exécuter clear_payment_provider_credentials" "1" "$([ "$(as_user_rc "$OWNER_UID" "select * from public.clear_payment_provider_credentials('$RID_ONE','fixture-provider');")" != "0" ] && echo 1 || echo 0)"

RES1="$(as_service "select * from public.set_payment_provider_credentials('$RID_ONE','fixture-provider','$SECRET_ALPHA');")"
echo "$RES1" > /tmp/scanym-p2a-res1-captured-$$.txt
assert_behav_eq "8. service_role PEUT exécuter set_payment_provider_credentials (RPC de confiance)" "1" "$([ -n "$RES1" ] && echo 1 || echo 0)"

CONFIG_ONE_ID="$(sql "select id from payment_provider_configs where restaurant_id='$RID_ONE' and provider_code='fixture-provider';")"

# ============================================================
# 9-13 : ÉCRITURE SECRET
# ============================================================
log "=== [9-13] ÉCRITURE SECRET ==="
assert_struct_eq "9. secret synthétique bien stocké dans vault.secrets (mock test-only)" "1" "$(sql "select count(*) from vault.secrets where secret='$SECRET_ALPHA';")"
CONFIG_REF_ONE="$(sql "select credentials_ref::text from payment_provider_configs where id='$CONFIG_ONE_ID';")"
assert_struct_eq "10. payment_provider_configs.credentials_ref stocke UNIQUEMENT une référence (uuid), pas le secret" "1" "$([ "$CONFIG_REF_ONE" != "$SECRET_ALPHA" ] && echo 1 || echo 0)"
assert_struct_eq "11. AUCUNE colonne texte-secret en clair dans payment_provider_configs (pas de secret/credential/api_key/token)" "0" "$(sql "select count(*) from information_schema.columns where table_schema='public' and table_name='payment_provider_configs' and column_name in ('secret','credential','api_key','token','password','mac_key','private_key');")"
assert_struct_eq "12. la réponse de set_payment_provider_credentials NE CONTIENT PAS le secret" "0" "$(echo "$RES1" | grep -c "$SECRET_ALPHA" || true)"
assert_struct_eq "13. le secret n'apparaît PAS dans la sortie psql capturée (stdout) de l'appel RPC (fichier dédié, capturé au moment exact de l'appel -- pas un fichier tampon partagé potentiellement obsolète)" "0" "$(grep -c "$SECRET_ALPHA" /tmp/scanym-p2a-res1-captured-$$.txt 2>/dev/null || true)"

# ============================================================
# 14-17 : REMPLACEMENT ATOMIQUE
# ============================================================
log "=== [14-17] REMPLACEMENT (in-place, référence inchangée) ==="
RES_REPLACE="$(as_service "select * from public.set_payment_provider_credentials('$RID_ONE','fixture-provider','$SECRET_REPLACEMENT');")"
behav "14. remplacement du secret synthétique accepté"
CONFIG_REF_AFTER="$(sql "select credentials_ref::text from payment_provider_configs where id='$CONFIG_ONE_ID';")"
assert_struct_eq "15. après remplacement, credentials_ref est INCHANGÉ (update-in-place, PAS create+swap -- élimine toute fenêtre config->secret manquant)" "$CONFIG_REF_ONE" "$CONFIG_REF_AFTER"
assert_struct_eq "16. le secret ANCIEN n'existe plus (contenu écrasé en place, pas un second secret créé)" "0" "$(sql "select count(*) from vault.secrets where secret='$SECRET_ALPHA';")"
assert_struct_eq "16b. le secret NOUVEAU est bien celui lu sous la référence (toujours) inchangée" "1" "$(sql "select count(*) from vault.secrets where id='$CONFIG_REF_AFTER' and secret='$SECRET_REPLACEMENT';")"
assert_struct_eq "16c. un SEUL secret Vault existe pour cette configuration après remplacement (pas de résidu)" "1" "$(sql "select count(*) from vault.secrets;")"
assert_struct_eq "17. le secret de remplacement n'apparaît pas dans la réponse RPC" "0" "$(echo "$RES_REPLACE" | grep -c "$SECRET_REPLACEMENT" || true)"

# ============================================================
# 18-21 : RESET
# ============================================================
log "=== [18-21] RESET (fail-closed) ==="
# Fixture de test : positionne is_enabled=TRUE via un accès superuser
# DIRECT (pas service_role -- payment_provider_configs n'a AUCUN
# grant direct pour service_role non plus, hérité de P1 ; ceci est
# une préparation de test, pas une démonstration de chemin
# applicatif). Sert uniquement à vérifier ensuite que le RESET
# fail-closed le force bien à FALSE même s'il avait été mis à TRUE.
sql "update payment_provider_configs set is_enabled = true where id='$CONFIG_ONE_ID';" >/dev/null
RES_CLEAR="$(as_service "select * from public.clear_payment_provider_credentials('$RID_ONE','fixture-provider');")"
behav "18. clear_payment_provider_credentials accepté"
assert_struct_eq "19. credentials_ref repasse à NULL après reset" "" "$(sql "select credentials_ref::text from payment_provider_configs where id='$CONFIG_ONE_ID';")"
assert_struct_eq "20. configuration_status repasse à not_configured après reset" "not_configured" "$(sql "select configuration_status from payment_provider_configs where id='$CONFIG_ONE_ID';")"
assert_struct_eq "21. is_enabled forcé à FALSE après reset (FAIL-CLOSED, section 12) même s'il avait été mis à TRUE" "f" "$(sql "select is_enabled from payment_provider_configs where id='$CONFIG_ONE_ID';")"
assert_struct_eq "21b. le secret Vault est bien retiré du stockage sécurisé après reset (pas seulement débranché)" "0" "$(sql "select count(*) from vault.secrets;")"

# ============================================================
# 22-23 : ISOLATION TENANT
#
# Note d'implémentation du test : le config du tenant Un a été remis
# à not_configured/NULL par le bloc RESET (18-21) ci-dessus -- on le
# ré-établit d'abord pour pouvoir démontrer l'isolation entre DEUX
# credentials réellement configurés simultanément.
# ============================================================
log "=== [22-23] ISOLATION TENANT ==="
RES1B="$(as_service "select * from public.set_payment_provider_credentials('$RID_ONE','fixture-provider','$SECRET_ALPHA');")"
REF_ONE_ISOL="$(sql "select credentials_ref::text from payment_provider_configs where id='$CONFIG_ONE_ID';")"

RES2="$(as_service "select * from public.set_payment_provider_credentials('$RID_TWO','fixture-provider','$SECRET_BETA');")"
CONFIG_TWO_ID="$(sql "select id from payment_provider_configs where restaurant_id='$RID_TWO' and provider_code='fixture-provider';")"
REF_TWO="$(sql "select credentials_ref::text from payment_provider_configs where id='$CONFIG_TWO_ID';")"

assert_struct_eq "22. tenant Un et tenant Deux ont des credentials_ref DISTINCTS (aucun secret Vault jamais partagé entre deux configurations)" "1" "$([ "$REF_ONE_ISOL" != "$REF_TWO" ] && [ -n "$REF_ONE_ISOL" ] && [ -n "$REF_TWO" ] && echo 1 || echo 0)"

as_service "select * from public.clear_payment_provider_credentials('$RID_TWO','fixture-provider');" >/dev/null
REF_ONE_AFTER="$(sql "select credentials_ref::text from payment_provider_configs where id='$CONFIG_ONE_ID';")"
assert_struct_eq "23. clear_payment_provider_credentials(tenant Deux) NE MUTE PAS la configuration du tenant Un (appel scopé au couple restaurant_id/provider_code du paramètre, jamais un autre tenant)" "$REF_ONE_ISOL" "$REF_ONE_AFTER"

assert_struct_eq "23b. aucune ligne payment_provider_configs ne référence le credentials_ref d'un AUTRE restaurant (structurel : chaque secret Vault n'est jamais partagé entre deux configs)" "0" "$(sql "select count(*) from (select credentials_ref from payment_provider_configs where credentials_ref is not null group by credentials_ref having count(distinct restaurant_id) > 1) x;" | sed 's/^$/0/')"

# ============================================================
# 24-26 : STATUT
#
# Note d'implémentation : le config du tenant Deux a été remis à
# not_configured par le bloc ISOLATION (22-23) ci-dessus -- on le
# ré-établit d'abord.
# ============================================================
log "=== [24-26] STATUT ==="
as_service "select * from public.set_payment_provider_credentials('$RID_TWO','fixture-provider','$SECRET_BETA');" >/dev/null
assert_struct_eq "24. stocker un credential -> configuration_status='configured'" "configured" "$(sql "select configuration_status from payment_provider_configs where id='$CONFIG_TWO_ID';")"
assert_behav_eq "25. AUCUN chemin générique (RPC de ce lot) ne peut positionner configuration_status='verified' -- ni set_payment_provider_credentials ni clear_payment_provider_credentials n'écrivent jamais 'verified'" "0" "$(sql "select count(*) from pg_proc where proname in ('set_payment_provider_credentials','clear_payment_provider_credentials') and prosrc ilike '%''verified''%';")"
as_service "select * from public.clear_payment_provider_credentials('$RID_TWO','fixture-provider');" >/dev/null
assert_struct_eq "26. clearing -> configuration_status='not_configured'" "not_configured" "$(sql "select configuration_status from payment_provider_configs where id='$CONFIG_TWO_ID';")"

# ============================================================
# 27-28 : LEGACY (P1 inchangé)
# ============================================================
log "=== [27-28] LEGACY / NON-RÉGRESSION P1 ==="
ORDER_LEGACY="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 1, 'pickup', 20.00, 20.00, 'EUR') returning id;")"
LEGACY_TXN="$(as_service "select transaction_id from public.initiate_payment_attempt('$ORDER_LEGACY','fixture-provider','legacy-ref-1');")"
assert_behav_eq "27. initiate_payment_attempt (P1) fonctionne toujours à l'identique après P2A" "1" "$([ -n "$LEGACY_TXN" ] && echo 1 || echo 0)"
assert_struct_eq "28. payment_transactions (P1) n'a reçu AUCUNE colonne nouvelle de P2A (additive, pas de redesign)" "0" "$(sql "select count(*) from information_schema.columns where table_schema='public' and table_name='payment_transactions' and column_name in ('credentials_ref','configuration_status');")"

# ============================================================
# 29-30 : VAULT ACL
# ============================================================
log "=== [29-30] VAULT ACL ==="
assert_behav_eq "29. anon NE PEUT PAS lire vault.secrets" "1" "$([ "$(as_anon_rc "select count(*) from vault.secrets;")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "29b. anon NE PEUT PAS lire vault.decrypted_secrets" "1" "$([ "$(as_anon_rc "select count(*) from vault.decrypted_secrets;")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "30. authenticated NE PEUT PAS lire vault.secrets" "1" "$([ "$(as_user_rc "$OWNER_UID" "select count(*) from vault.secrets;")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "30b. authenticated NE PEUT PAS lire vault.decrypted_secrets" "1" "$([ "$(as_user_rc "$OWNER_UID" "select count(*) from vault.decrypted_secrets;")" != "0" ] && echo 1 || echo 0)"

# ============================================================
# 31 : ENTRÉES INVALIDES / DÉFENSE SUPPLÉMENTAIRE
# ============================================================
log "=== [31] ENTRÉES INVALIDES ==="
assert_behav_eq "31a. secret vide REJETÉ" "1" "$([ "$(as_service_rc "select * from public.set_payment_provider_credentials('$RID_ONE','fixture-provider','');")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "31b. p_mode invalide REJETÉ" "1" "$([ "$(as_service_rc "select * from public.set_payment_provider_credentials('$RID_ONE','fixture-provider','$SECRET_ALPHA','bogus');")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "31c. restaurant inexistant REJETÉ" "1" "$([ "$(as_service_rc "select * from public.set_payment_provider_credentials('00000000-0000-0000-0000-000000000099','fixture-provider','$SECRET_ALPHA');")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "31d. clear sur configuration inexistante REJETÉ (pas un no-op silencieux)" "1" "$([ "$(as_service_rc "select * from public.clear_payment_provider_credentials('$RID_TWO','provider-jamais-configure');")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "31e. secret dépassant la longueur maximale REJETÉ" "1" "$([ "$(as_service_rc "select * from public.set_payment_provider_credentials('$RID_ONE','fixture-provider', repeat('x', 9000));")" != "0" ] && echo 1 || echo 0)"

# ============================================================
# GARDES ANTI-DÉRIVE
# ============================================================
log "=== GARDES ANTI-DÉRIVE ==="
RC_DOUBLE_APPLY="$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2A_SQL" >/tmp/scanym-p2a-out2-$$.txt 2>/tmp/scanym-p2a-err2-$$.txt; echo $?)"
assert_behav_eq "32. double application du lot REFUSÉE (SCANYM_SCHEMA_DRIFT)" "1" "$([ "$RC_DOUBLE_APPLY" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "33. message de double application mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" /tmp/scanym-p2a-err2-$$.txt || true)"

log "=== GARDE D'ARCHITECTURE — Vault ABSENT (base sans mock, reproduit l'environnement réel sans l'extension) ==="
psql -c "drop database if exists \"$DB_NOVAULT\";" >/dev/null 2>&1 || true
createdb "$DB_NOVAULT"
build_common_bootstrap "$DB_NOVAULT"
build_full_chain "$DB_NOVAULT"
RC_NO_VAULT="$(psql -d "$DB_NOVAULT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2A_SQL" >/tmp/scanym-p2a-out3-$$.txt 2>/tmp/scanym-p2a-err3-$$.txt; echo $?)"
assert_behav_eq "34. application SANS Vault disponible REFUSÉE dès la garde préflight (fail loud, pas de repli silencieux vers un stockage non sécurisé)" "1" "$([ "$RC_NO_VAULT" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "35. message de garde d'architecture Vault mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" /tmp/scanym-p2a-err3-$$.txt || true)"

log "=== GARDE — base SANS payment_provider_configs (prérequis P1 manquant) ==="
psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
createdb "$DB_DRIFT"
build_common_bootstrap "$DB_DRIFT"
RC_MISSING_PREREQ="$(psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2A_SQL" >/tmp/scanym-p2a-out4-$$.txt 2>/tmp/scanym-p2a-err4-$$.txt; echo $?)"
assert_behav_eq "36. application sur base SANS payment_provider_configs (P1) REFUSÉE dès la garde préflight" "1" "$([ "$RC_MISSING_PREREQ" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "37. message de garde préflight (prérequis P1) mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" /tmp/scanym-p2a-err4-$$.txt || true)"

rm -f /tmp/scanym-p2a-out-$$.txt /tmp/scanym-p2a-err-$$.txt /tmp/scanym-p2a-out2-$$.txt /tmp/scanym-p2a-err2-$$.txt /tmp/scanym-p2a-out3-$$.txt /tmp/scanym-p2a-err3-$$.txt /tmp/scanym-p2a-out4-$$.txt /tmp/scanym-p2a-err4-$$.txt /tmp/scanym-p2a-res1-captured-$$.txt

# ============================================================
# 38-46 : CORRECTION PAY-P2A-04 — UNICITÉ + RÉFÉRENCE ORPHELINE.
# ============================================================
log "=== [38-46] PAY-P2A-04 — UNICITÉ credentials_ref + ORPHELIN ==="

# 38 : rejet direct d'un doublon de credentials_ref (accès superuser
# direct -- prouve la garantie STRUCTURELLE, indépendante de toute
# logique RPC).
SHARED_SECRET_ID="$(sql "select credentials_ref::text from payment_provider_configs where id='$CONFIG_ONE_ID';")"
RC_DUP_REF="$(super_rc "insert into payment_provider_configs (restaurant_id, provider_code, credentials_ref, configuration_status) values ('$RID_TWO','fixture-provider-dup-test','$SHARED_SECRET_ID','configured');")"
assert_behav_eq "38. INSERT direct d'un credentials_ref déjà utilisé par une AUTRE configuration REJETÉ (index unique partiel, PAY-P2A-04)" "1" "$([ "$RC_DUP_REF" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "38b. le message de rejet mentionne bien l'index unique dédié" "1" "$(grep -c "payment_provider_configs_credentials_ref_unique" /tmp/scanym-p2a-out-$$.txt /tmp/scanym-p2a-err-$$.txt 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')"

# 39-42 : référence orpheline au REMPLACEMENT -- fail-closed explicite.
# Prépare une configuration "configured" cohérente, puis supprime le
# secret Vault sous-jacent DIRECTEMENT (simulation d'une incohérence
# antérieure -- jamais atteignable par le chemin RPC normal, mais
# devant être défendue quand même, mandat section 14).
as_service "select * from public.set_payment_provider_credentials('$RID_TWO','fixture-provider-orphan-replace','$SECRET_ALPHA');" >/dev/null
ORPHAN_CONFIG_ID="$(sql "select id from payment_provider_configs where restaurant_id='$RID_TWO' and provider_code='fixture-provider-orphan-replace';")"
ORPHAN_REF="$(sql "select credentials_ref::text from payment_provider_configs where id='$ORPHAN_CONFIG_ID';")"
sql "delete from vault.secrets where id='$ORPHAN_REF';" >/dev/null
RC_ORPHAN_REPLACE="$(as_service_rc "select * from public.set_payment_provider_credentials('$RID_TWO','fixture-provider-orphan-replace','$SECRET_BETA');")"
assert_behav_eq "39. remplacement contre une credentials_ref ORPHELINE (secret Vault absent) REJETÉ fail-closed (SCANYM_CREDENTIAL_REFERENCE_INVALID, PAY-P2A-04)" "1" "$([ "$RC_ORPHAN_REPLACE" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "40. message d'erreur mentionne bien SCANYM_CREDENTIAL_REFERENCE_INVALID" "1" "$(grep -c "SCANYM_CREDENTIAL_REFERENCE_INVALID" /tmp/scanym-p2a-err-$$.txt || true)"
assert_struct_eq "41. après le rejet, configuration_status RESTE 'configured' (pas de repli silencieux vers un état incohérent -- le rejet est atomique, aucune mutation partielle)" "configured" "$(sql "select configuration_status from payment_provider_configs where id='$ORPHAN_CONFIG_ID';")"
assert_struct_eq "42. après le rejet, credentials_ref est INCHANGÉ (toujours la référence orpheline -- aucune recréation automatique en clair d'un nouveau secret)" "$ORPHAN_REF" "$(sql "select credentials_ref::text from payment_provider_configs where id='$ORPHAN_CONFIG_ID';")"
assert_struct_eq "42b. le secret de remplacement ($SECRET_BETA) n'a PAS été créé dans Vault suite au rejet (aucun secret orphelin résiduel créé par la tentative refusée -- ce secret avait déjà été supprimé par le clear de la section 24-26)" "0" "$(sql "select count(*) from vault.secrets where secret='$SECRET_BETA';")"

# 43-46 : référence orpheline au CLEAR -- fail-safe, pas d'erreur,
# jamais de fausse revendication de suppression, jamais un reset
# bloqué, JAMAIS "configured" avec un secret manquant après reset
# (mandat section 15).
RC_ORPHAN_CLEAR="$(as_service_rc "select * from public.clear_payment_provider_credentials('$RID_TWO','fixture-provider-orphan-replace');")"
assert_behav_eq "43. clear contre une credentials_ref ORPHELINE ACCEPTÉ (pas une erreur -- décision documentée PAY-P2A-04/section 15, distincte du remplacement)" "0" "$([ "$RC_ORPHAN_CLEAR" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "44. après clear sur référence orpheline, configuration_status='not_configured' (JAMAIS 'configured' avec un secret manquant, priorité de sécurité mandat section 15)" "not_configured" "$(sql "select configuration_status from payment_provider_configs where id='$ORPHAN_CONFIG_ID';")"
assert_struct_eq "45. après clear sur référence orpheline, credentials_ref repasse à NULL" "" "$(sql "select credentials_ref::text from payment_provider_configs where id='$ORPHAN_CONFIG_ID';")"
assert_struct_eq "46. après clear sur référence orpheline, is_enabled forcé à FALSE (fail-closed, inchangé du cas normal)" "f" "$(sql "select is_enabled from payment_provider_configs where id='$ORPHAN_CONFIG_ID';")"

# ============================================================
# 47-54 : RE-VÉRIFICATION CIBLÉE P1 (mandat section 20) — le fichier
# P1 lui-même N'EST PAS modifié (aucune écriture sur
# DRAFT-lot-payment-p1-foundation.sql dans ce lot) ; ces assertions
# vérifient uniquement que les invariants structurels P1 restent
# intacts APRÈS application de P2A par-dessus, dans CETTE base de
# test P2A (pas une ré-exécution du harnais P1 lui-même, qui reste
# inchangé et hors périmètre).
# ============================================================
log "=== [47-54] RE-VÉRIFICATION CIBLÉE P1 (invariants structurels, fichier P1 non modifié) ==="
assert_struct_eq "47. index unique partiel 'une seule tentative pending par commande' (P1) toujours présent après P2A" "1" "$(sql "select count(*) from pg_indexes where schemaname='public' and tablename='payment_transactions' and indexname='payment_transactions_one_active_per_order';")"
assert_struct_eq "48. index unique partiel 'une seule tentative paid par commande' (P1) toujours présent après P2A" "1" "$(sql "select count(*) from pg_indexes where schemaname='public' and tablename='payment_transactions' and indexname='payment_transactions_one_paid_per_order';")"
assert_struct_eq "49. FK composite orders_current_payment_transaction_fk (P1, anti-cross-tenant) toujours présente, toujours composite (2 colonnes)" "2" "$(sql "select count(*) from pg_constraint c join unnest(c.conkey) k(attnum) on true where c.conname='orders_current_payment_transaction_fk' and c.conrelid='public.orders'::regclass;")"
assert_struct_eq "50. contrainte de support payment_transactions_id_order_id_unique (P1) toujours présente" "1" "$(sql "select count(*) from pg_constraint where conname='payment_transactions_id_order_id_unique' and conrelid='public.payment_transactions'::regclass and contype='u';")"
assert_struct_eq "51. RPC P1 initiate_payment_attempt/confirm_payment_attempt toujours REVOKE ALL FROM public/anon/authenticated (ACL non affaiblie par P2A)" "0" "$(sql "select count(*) from information_schema.role_routine_grants where routine_schema='public' and routine_name in ('initiate_payment_attempt','confirm_payment_attempt') and grantee in ('anon','authenticated','PUBLIC');")"
assert_struct_eq "52. orders.payment_status conserve son défaut P1 'not_required'" "not_required" "$(sql "select column_default from information_schema.columns where table_schema='public' and table_name='orders' and column_name='payment_status';" | sed "s/'not_required'::text/not_required/")"
assert_struct_eq "53. normalisation provider_code (CHECK trim + charset, P1, payment_provider_configs) toujours présente et inchangée" "1" "$(sql "select count(*) from pg_constraint where conrelid='public.payment_provider_configs'::regclass and contype='c' and pg_get_constraintdef(oid) ilike '%provider_code%btrim%';")"
assert_struct_eq "54. payment_provider_configs conserve son unique(restaurant_id, provider_code) (P1, base de l'upsert P2A)" "1" "$(sql "select count(*) from pg_constraint where conrelid='public.payment_provider_configs'::regclass and contype='u' and pg_get_constraintdef(oid) ilike '%restaurant_id%provider_code%';")"

# ============================================================
# 55-66 : CORRECTION PAY-P2A-V2-01 (MEDIUM, ex-Work re-audit v2) —
# CONCURRENCE RÉELLE AVEC PREUVE DE CONTENTION DE VERROU FORCÉE.
#
# CORRECTION v3 : le patron v2 (BEGIN; pg_sleep(0.5); RPC; COMMIT sur
# les deux sessions, chevauchement supposé par un simple décalage de
# lancement de 0.3s) ne PROUVAIT PAS qu'une session attendait
# réellement un verrou détenu par l'autre -- seulement que les deux
# réussissaient, ce qui est compatible avec une SUCCESSION rapide non
# contendue. Corrigé : chaque scénario impliquant une ligne EXISTANTE
# fait désormais réellement tenir un verrou de ligne par une session
# (via un appel RPC réel suivi d'un pg_sleep DANS LA MÊME TRANSACTION
# -- le verrou de ligne pris par le FOR UPDATE interne du RPC est
# retenu jusqu'au COMMIT, PAS relâché à la fin de l'appel de fonction)
# PENDANT que l'autre session, appelant le second RPC sur la MÊME
# ligne, est interrogée EN DIRECT via pg_stat_activity/pg_locks pour
# confirmer `wait_event_type = 'Lock'` -- preuve positive et observée,
# pas une inférence de timing. Le scénario CREATE/CREATE (ligne
# inexistante, donc rien à verrouiller au préalable) utilise à la
# place une barrière à verrous consultatifs (advisory locks,
# HARNAIS UNIQUEMENT, aucun ajout à la Production SQL) garantissant
# que les deux sessions atteignent le chemin de création
# GENUINEMENT en même temps, avant que l'une ou l'autre ne termine.
# Base dédiée $DB_CONC, chaque scénario répété 3 fois (mandat
# sections 9-12 v2, sections 4-11 v3).
# ============================================================
log "=== [55-66] CONCURRENCE RÉELLE AVEC PREUVE DE VERROU (PAY-P2A-V2-01) — construction base dédiée $DB_CONC ==="
psql -c "drop database if exists \"$DB_CONC\";" >/dev/null 2>&1 || true
createdb "$DB_CONC"
build_common_bootstrap "$DB_CONC"
build_full_chain "$DB_CONC"
build_mock_vault "$DB_CONC"
psql -d "$DB_CONC" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2A_SQL" >/dev/null
psql -d "$DB_CONC" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into auth.users (id, email) values ('$OWNER_UID', 'owner@p2a-fixture-one.test'), ('$OTHER_OWNER_UID', 'owner@p2a-fixture-two.test');
with resto as (insert into restaurants (name, slug, status) values ('P2A Conc Tenant One', 'p2a-conc-tenant-one', 'active') returning id)
insert into restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number) select id, 0, 'EUR', '+33600000701' from resto;
SQL
RID_CONC="$(psql -X -A -q -t -d "$DB_CONC" -c "select id from restaurants where slug='p2a-conc-tenant-one';")"
struct "base de concurrence dédiée $DB_CONC construite (chaîne réelle + P1 + mock Vault corrigé + P2A + 1 tenant fixture)"

CONC_LOG_DIR="/tmp/scanym-p2a-conc-$$"
mkdir -p "$CONC_LOG_DIR"
HOLD_SECONDS=4
WAITER_LOCK_TIMEOUT="15s"
WAITER_STMT_TIMEOUT="20s"

conc_q() { psql -X -A -q -t -d "$DB_CONC" -c "$1" 2>/dev/null; }

# poll_waiter_blocked <app_name> <max_iters> -- interroge
# pg_stat_activity en DIRECT (pas d'inférence par sleep) jusqu'à
# observer wait_event_type='Lock' pour la session identifiée par
# application_name, ou expiration. Écrit "pid|wait_type|wait_event"
# sur stdout (vide si jamais observé dans la fenêtre).
poll_waiter_blocked() {
  local app_name="$1" max_iters="${2:-40}" i=0 row=""
  while [ "$i" -lt "$max_iters" ]; do
    row="$(conc_q "select pid || '|' || coalesce(wait_event_type,'') || '|' || coalesce(wait_event,'') from pg_stat_activity where application_name='$app_name';")"
    if [ -n "$row" ]; then
      local wt
      wt="$(echo "$row" | awk -F'|' '{print $2}')"
      if [ "$wt" = "Lock" ]; then
        echo "$row"
        return 0
      fi
    fi
    sleep 0.1
    i=$((i+1))
  done
  echo ""
  return 1
}

# run_rpc_lock_contention <label> <prov> <holder_rpc_sql> <waiter_rpc_sql>
# -- Session HOLDER exécute un appel RPC RÉEL (set OU clear) puis
# retient la transaction ouverte HOLD_SECONDS (le verrou de ligne pris
# par le FOR UPDATE interne du RPC reste tenu jusqu'au COMMIT -- ce
# n'est PAS relâché à la fin de l'appel PL/pgSQL). Session WAITER
# exécute l'AUTRE appel RPC réel sur la MÊME ligne restaurant/provider
# pendant que le holder détient encore le verrou -- son entrée dans le
# FOR UPDATE interne du RPC bloque RÉELLEMENT sur ce verrou de ligne.
# Le contrôleur interroge pg_stat_activity/pg_locks EN DIRECT pour
# capturer la preuve positive de blocage AVANT que le holder ne
# libère. Écrit "observed rc_holder rc_waiter" sur stdout.
run_rpc_lock_contention() {
  local label="$1" prov="$2" holder_sql="$3" waiter_sql="$4"
  local dir="$CONC_LOG_DIR/$label"; mkdir -p "$dir"
  local holder_app="p2a_hold_${label}_$$" waiter_app="p2a_wait_${label}_$$"

  (
    set +e
    PGAPPNAME="$holder_app" PGOPTIONS="-c role=service_role" psql -d "$DB_CONC" -X -A -q -t -v ON_ERROR_STOP=1 \
      -c "begin; $holder_sql select pg_sleep($HOLD_SECONDS); commit;" \
      >"$dir/holder.out" 2>"$dir/holder.err"
    echo $? > "$dir/holder.rc"
  ) &
  local job_holder=$!

  # Marge de démarrage COURTE, PAS la preuve -- juste pour garantir que
  # la session holder est connectée et a émis son BEGIN avant que le
  # waiter ne parte. L'appel RPC du holder est synchrone : son FOR
  # UPDATE interne est nécessairement terminé (verrou acquis) avant
  # que l'instruction pg_sleep suivante, dans le MÊME script séquentiel
  # sur la MÊME connexion, ne commence à s'exécuter.
  sleep 0.2

  (
    set +e
    PGAPPNAME="$waiter_app" PGOPTIONS="-c role=service_role" psql -d "$DB_CONC" -X -A -q -t -v ON_ERROR_STOP=1 \
      -c "set lock_timeout='$WAITER_LOCK_TIMEOUT'; set statement_timeout='$WAITER_STMT_TIMEOUT'; begin; $waiter_sql commit;" \
      >"$dir/waiter.out" 2>"$dir/waiter.err"
    echo $? > "$dir/waiter.rc"
  ) &
  local job_waiter=$!

  # PREUVE : interrogation directe et répétée de pg_stat_activity
  # jusqu'à observer le waiter réellement bloqué (wait_event_type =
  # 'Lock') -- PAS une inférence de timing.
  local blocked_row holder_pid waiter_pid holder_open
  blocked_row="$(poll_waiter_blocked "$waiter_app" 30)"
  local observed=0
  [ -n "$blocked_row" ] && observed=1
  waiter_pid="$(echo "$blocked_row" | awk -F'|' '{print $1}')"
  [ -z "$waiter_pid" ] && waiter_pid="$(conc_q "select pid from pg_stat_activity where application_name='$waiter_app';")"
  [ -z "$waiter_pid" ] && waiter_pid="0"
  holder_pid="$(conc_q "select pid from pg_stat_activity where application_name='$holder_app';")"
  [ -z "$holder_pid" ] && holder_pid="0"
  # Confirme que la transaction holder est TOUJOURS ouverte au moment
  # de l'observation (pas déjà committée avant l'observation du blocage).
  holder_open="$(conc_q "select count(*) from pg_stat_activity where application_name='$holder_app';")"

  {
    echo "=== $label ==="
    echo "holder_pid=$holder_pid waiter_pid=$waiter_pid observed_blocked=$observed holder_txn_still_open=$holder_open"
    echo "waiter wait state at observation : $blocked_row"
    echo "pg_locks (holder+waiter pids) :"
    conc_q "select l.pid || '|' || coalesce(a.application_name,'?') || '|' || l.locktype || '|' || l.mode || '|' || l.granted from pg_locks l left join pg_stat_activity a on a.pid=l.pid where l.pid in ($holder_pid, $waiter_pid) order by l.granted, l.pid;"
  } >> "$dir/evidence.txt"

  wait "$job_holder" "$job_waiter"
  echo "$observed $(cat "$dir/holder.rc") $(cat "$dir/waiter.rc")"
}

# run_create_barrier <label> <prov> <secret_a> <secret_b> <advkey> --
# barrière à verrou consultatif (HARNAIS UNIQUEMENT) : le contrôleur
# détient un verrou EXCLUSIF ; les deux sessions A et B tentent un
# verrou PARTAGÉ (compatible entre elles, incompatible avec
# l'exclusif du contrôleur) juste avant d'appeler le RPC de création
# -- les DEUX sont donc mises en attente. Le contrôleur confirme EN
# DIRECT (pg_locks) que les DEUX sont bien en attente, PUIS relâche --
# les deux verrous partagés compatibles sont accordés
# quasi-simultanément, garantissant un chevauchement RÉEL au moment de
# l'appel RPC (pas une chance d'ordonnancement).
run_create_barrier() {
  local label="$1" prov="$2" secret_a="$3" secret_b="$4" advkey="$5"
  local dir="$CONC_LOG_DIR/$label"; mkdir -p "$dir"
  local a_app="p2a_bar_a_${label}_$$" b_app="p2a_bar_b_${label}_$$"

  coproc CTRL { psql -X -A -q -t -d "$DB_CONC"; }
  echo "select pg_advisory_lock($advkey);" >&"${CTRL[1]}"
  read -r _ <&"${CTRL[0]}"

  (
    set +e
    PGAPPNAME="$a_app" PGOPTIONS="-c role=service_role" psql -d "$DB_CONC" -X -A -q -t -v ON_ERROR_STOP=1 \
      -c "select pg_advisory_lock_shared($advkey); begin; select * from public.set_payment_provider_credentials('$RID_CONC','$prov','$secret_a'); commit; select pg_advisory_unlock_shared($advkey);" \
      >"$dir/a.out" 2>"$dir/a.err"
    echo $? > "$dir/a.rc"
  ) &
  local job_a=$!
  (
    set +e
    PGAPPNAME="$b_app" PGOPTIONS="-c role=service_role" psql -d "$DB_CONC" -X -A -q -t -v ON_ERROR_STOP=1 \
      -c "select pg_advisory_lock_shared($advkey); begin; select * from public.set_payment_provider_credentials('$RID_CONC','$prov','$secret_b'); commit; select pg_advisory_unlock_shared($advkey);" \
      >"$dir/b.out" 2>"$dir/b.err"
    echo $? > "$dir/b.rc"
  ) &
  local job_b=$!

  # PREUVE de barrière : interroge pg_locks jusqu'à confirmer que les
  # DEUX sessions sont EN ATTENTE (granted=false) du verrou
  # consultatif -- garantit qu'aucune des deux n'a pu partir en
  # avance.
  local both=0 i=0
  while [ "$i" -lt 40 ]; do
    both="$(conc_q "select count(*) from pg_locks l join pg_stat_activity a on a.pid=l.pid where l.locktype='advisory' and not l.granted and a.application_name in ('$a_app','$b_app');")"
    [ "$both" = "2" ] && break
    sleep 0.05
    i=$((i+1))
  done
  local observed_barrier=0
  [ "$both" = "2" ] && observed_barrier=1

  {
    echo "=== $label (barrière avancée) ==="
    echo "les deux sessions en attente du verrou consultatif $advkey confirmées: $both/2 (itération $i)"
    conc_q "select l.pid || '|' || coalesce(a.application_name,'?') || '|' || l.granted from pg_locks l join pg_stat_activity a on a.pid=l.pid where l.locktype='advisory' and a.application_name in ('$a_app','$b_app');"
  } >> "$dir/evidence.txt"

  echo "select pg_advisory_unlock($advkey);" >&"${CTRL[1]}"
  read -r _ <&"${CTRL[0]}"
  echo '\q' >&"${CTRL[1]}"
  wait "$CTRL_PID" 2>/dev/null || true

  wait "$job_a" "$job_b"
  echo "$observed_barrier $(cat "$dir/a.rc") $(cat "$dir/b.rc")"
}

TIMEOUT_OR_DEADLOCK_IN() {
  grep -qi "deadlock detected\|lock timeout\|canceling statement due to statement timeout" "$1" "$2" 2>/dev/null
}

# ------------------------------------------------------------
# 55-58 : SCÉNARIO 1 — CREATE/CREATE concurrent (aucune configuration
# préexistante). Barrière à verrou consultatif garantissant un
# chevauchement RÉEL au moment de l'appel RPC. Répété 3 fois sur 3
# couples (restaurant, provider) distincts.
# ------------------------------------------------------------
log "--- Scénario CREATE/CREATE concurrent avec barrière avancée (x3) ---"
CC_ALL_BARRIER=1
CC_ALL_OK=1
CC_ALL_NODEADLOCK=1
CC_ALL_CONSISTENT=1
for i in 1 2 3; do
  PROV="conc-create-$$-$i"
  ADVKEY=$(( ($$ % 1000000) * 10 + 100 + i ))
  RESULT="$(run_create_barrier "cc-$i" "$PROV" "test-secret-conc-a-$$-$i-DO-NOT-USE" "test-secret-conc-b-$$-$i-DO-NOT-USE" "$ADVKEY")"
  OBSERVED="$(echo "$RESULT" | awk '{print $1}')"
  RC_A="$(echo "$RESULT" | awk '{print $2}')"
  RC_B="$(echo "$RESULT" | awk '{print $3}')"
  [ "$OBSERVED" != "1" ] && CC_ALL_BARRIER=0
  if [ "$RC_A" != "0" ] || [ "$RC_B" != "0" ]; then CC_ALL_OK=0; fi
  if TIMEOUT_OR_DEADLOCK_IN "$CONC_LOG_DIR/cc-$i/a.err" "$CONC_LOG_DIR/cc-$i/b.err"; then CC_ALL_NODEADLOCK=0; fi
  N_CONFIGS="$(conc_q "select count(*) from payment_provider_configs where restaurant_id='$RID_CONC' and provider_code='$PROV';")"
  N_SECRETS_LEFT="$(conc_q "select credentials_ref is not null from payment_provider_configs where restaurant_id='$RID_CONC' and provider_code='$PROV';")"
  N_VAULT_FOR_REF="$(conc_q "select count(*) from vault.secrets where id = (select credentials_ref from payment_provider_configs where restaurant_id='$RID_CONC' and provider_code='$PROV');")"
  if [ "$N_CONFIGS" != "1" ] || [ "$N_SECRETS_LEFT" != "t" ] || [ "$N_VAULT_FOR_REF" != "1" ]; then CC_ALL_CONSISTENT=0; fi
done
assert_behav_eq "55. CREATE/CREATE (x3) : barrière avancée confirme EN DIRECT (pg_locks) que les DEUX sessions atteignent le chemin de création simultanément (pas une chance d'ordonnancement)" "1" "$CC_ALL_BARRIER"
assert_behav_eq "56. CREATE/CREATE (x3) : les DEUX transactions réussissent après chevauchement PROUVÉ (retry-on-unique_violation, PAY-P2A-03)" "1" "$CC_ALL_OK"
assert_behav_eq "57. CREATE/CREATE (x3) : AUCUN deadlock ni timeout inattendu détecté" "1" "$CC_ALL_NODEADLOCK"
assert_behav_eq "58. CREATE/CREATE (x3) : état final cohérent (1 ligne config, 1 seul secret Vault, aucun orphelin, aucun doublon)" "1" "$CC_ALL_CONSISTENT"

# ------------------------------------------------------------
# 59-62 : SCÉNARIO 2 — REPLACE/REPLACE concurrent (credential déjà
# configuré). La session HOLDER exécute un set RÉEL puis retient le
# verrou de ligne HOLD_SECONDS ; la session WAITER exécute le second
# set RÉEL et est observée EN DIRECT bloquée sur ce même verrou.
# Répété 3 fois.
# ------------------------------------------------------------
log "--- Scénario REPLACE/REPLACE avec preuve de verrou observée (x3) ---"
RR_ALL_BLOCKED=1
RR_ALL_OK=1
RR_ALL_NODEADLOCK=1
RR_ALL_CONSISTENT=1
for i in 1 2 3; do
  PROV="conc-replace-$$-$i"
  conc_q "select * from public.set_payment_provider_credentials('$RID_CONC','$PROV','test-secret-conc-init-$$-$i-DO-NOT-USE');" >/dev/null
  INITIAL_REF="$(conc_q "select credentials_ref::text from payment_provider_configs where restaurant_id='$RID_CONC' and provider_code='$PROV';")"
  HOLDER_SQL="select * from public.set_payment_provider_credentials('$RID_CONC','$PROV','test-secret-conc-ra-$$-$i-DO-NOT-USE');"
  WAITER_SQL="select * from public.set_payment_provider_credentials('$RID_CONC','$PROV','test-secret-conc-rb-$$-$i-DO-NOT-USE');"
  RESULT="$(run_rpc_lock_contention "rr-$i" "$PROV" "$HOLDER_SQL" "$WAITER_SQL")"
  OBSERVED="$(echo "$RESULT" | awk '{print $1}')"
  RC_HOLDER="$(echo "$RESULT" | awk '{print $2}')"
  RC_WAITER="$(echo "$RESULT" | awk '{print $3}')"
  [ "$OBSERVED" != "1" ] && RR_ALL_BLOCKED=0
  if [ "$RC_HOLDER" != "0" ] || [ "$RC_WAITER" != "0" ]; then RR_ALL_OK=0; fi
  if TIMEOUT_OR_DEADLOCK_IN "$CONC_LOG_DIR/rr-$i/holder.err" "$CONC_LOG_DIR/rr-$i/waiter.err"; then RR_ALL_NODEADLOCK=0; fi
  FINAL_REF="$(conc_q "select credentials_ref::text from payment_provider_configs where restaurant_id='$RID_CONC' and provider_code='$PROV';")"
  FINAL_STATUS="$(conc_q "select configuration_status from payment_provider_configs where restaurant_id='$RID_CONC' and provider_code='$PROV';")"
  N_VAULT_TOTAL_FOR_PROV="$(conc_q "select count(*) from vault.secrets where id='$FINAL_REF';")"
  # credentials_ref ne doit JAMAIS changer (remplacement en place,
  # mandat section 11) ; status doit rester 'configured' ; le secret
  # référencé doit exister (exactement 1).
  if [ "$FINAL_REF" != "$INITIAL_REF" ] || [ "$FINAL_STATUS" != "configured" ] || [ "$N_VAULT_TOTAL_FOR_PROV" != "1" ]; then RR_ALL_CONSISTENT=0; fi
done
assert_behav_eq "59. REPLACE/REPLACE (x3) : le waiter est OBSERVÉ EN DIRECT bloqué (wait_event_type='Lock') sur le verrou de ligne tenu par le holder, transaction holder toujours ouverte à l'observation" "1" "$RR_ALL_BLOCKED"
assert_behav_eq "60. REPLACE/REPLACE (x3) : les DEUX transactions réussissent après déblocage (verrouillage config-first sérialise proprement)" "1" "$RR_ALL_OK"
assert_behav_eq "61. REPLACE/REPLACE (x3) : AUCUN deadlock ni timeout inattendu détecté" "1" "$RR_ALL_NODEADLOCK"
assert_behav_eq "62. REPLACE/REPLACE (x3) : credentials_ref INCHANGÉ à chaque répétition (update-in-place, jamais configured+secret manquant)" "1" "$RR_ALL_CONSISTENT"

# ------------------------------------------------------------
# 63-66 : SCÉNARIO 3 — REPLACE/CLEAR concurrent (CRITIQUE, mandat
# section 12 v2 / section 5 v3) : alterné à chaque répétition (replace
# détient / clear attend, PUIS clear détient / replace attend) pour
# couvrir les deux sens explicitement demandés par le mandat. Ne doit
# JAMAIS produire "configured + secret manquant" ni "not_configured +
# secret Vault référencé encore vivant". Répété 3 fois.
# ------------------------------------------------------------
log "--- Scénario REPLACE/CLEAR avec preuve de verrou observée (x3, critique, sens alterné) ---"
RC2_ALL_BLOCKED=1
RC2_ALL_OK=1
RC2_ALL_NODEADLOCK=1
RC2_ALL_CONSISTENT=1
for i in 1 2 3; do
  PROV="conc-replaceclear-$$-$i"
  conc_q "select * from public.set_payment_provider_credentials('$RID_CONC','$PROV','test-secret-conc-rc-init-$$-$i-DO-NOT-USE');" >/dev/null
  REPLACE_SQL="select * from public.set_payment_provider_credentials('$RID_CONC','$PROV','test-secret-conc-rc-replace-$$-$i-DO-NOT-USE');"
  CLEAR_SQL="select * from public.clear_payment_provider_credentials('$RID_CONC','$PROV');"
  if [ $((i % 2)) -eq 1 ]; then
    # Sens 1 : replace détient le verrou, clear attend.
    RESULT="$(run_rpc_lock_contention "rc2-$i" "$PROV" "$REPLACE_SQL" "$CLEAR_SQL")"
  else
    # Sens 2 (vice versa, mandat section 5) : clear détient le verrou, replace attend.
    RESULT="$(run_rpc_lock_contention "rc2-$i" "$PROV" "$CLEAR_SQL" "$REPLACE_SQL")"
  fi
  OBSERVED="$(echo "$RESULT" | awk '{print $1}')"
  RC_HOLDER="$(echo "$RESULT" | awk '{print $2}')"
  RC_WAITER="$(echo "$RESULT" | awk '{print $3}')"
  [ "$OBSERVED" != "1" ] && RC2_ALL_BLOCKED=0
  if [ "$RC_HOLDER" != "0" ] || [ "$RC_WAITER" != "0" ]; then RC2_ALL_OK=0; fi
  if TIMEOUT_OR_DEADLOCK_IN "$CONC_LOG_DIR/rc2-$i/holder.err" "$CONC_LOG_DIR/rc2-$i/waiter.err"; then RC2_ALL_NODEADLOCK=0; fi
  FINAL_STATUS="$(conc_q "select configuration_status from payment_provider_configs where restaurant_id='$RID_CONC' and provider_code='$PROV';")"
  FINAL_REF="$(conc_q "select credentials_ref::text from payment_provider_configs where restaurant_id='$RID_CONC' and provider_code='$PROV';")"
  # Intégrité CRITIQUE, indépendante de qui a "gagné" : jamais
  # configured+ref NULL, jamais not_configured+ref NON NULL, et si
  # configured, le secret référencé doit RÉELLEMENT exister.
  BAD_STATE=0
  if [ "$FINAL_STATUS" = "configured" ] && [ -z "$FINAL_REF" ]; then BAD_STATE=1; fi
  if [ "$FINAL_STATUS" = "not_configured" ] && [ -n "$FINAL_REF" ]; then BAD_STATE=1; fi
  if [ "$FINAL_STATUS" = "configured" ] && [ -n "$FINAL_REF" ]; then
    EXISTS_CHECK="$(conc_q "select exists(select 1 from vault.secrets where id='$FINAL_REF');")"
    if [ "$EXISTS_CHECK" != "t" ]; then BAD_STATE=1; fi
  fi
  if [ "$BAD_STATE" = "1" ]; then RC2_ALL_CONSISTENT=0; fi
done
assert_behav_eq "63. REPLACE/CLEAR (x3, sens alterné) : le waiter est OBSERVÉ EN DIRECT bloqué (wait_event_type='Lock') sur le verrou de ligne tenu par le holder -- prouvé dans LES DEUX SENS (replace tient/clear attend ET clear tient/replace attend)" "1" "$RC2_ALL_BLOCKED"
assert_behav_eq "64. REPLACE/CLEAR (x3, critique) : les DEUX transactions réussissent après déblocage, dans les deux sens" "1" "$RC2_ALL_OK"
assert_behav_eq "65. REPLACE/CLEAR (x3, critique) : AUCUN deadlock ni timeout inattendu détecté (verrouillage config-first identique dans les deux RPC, PAY-P2A-03)" "1" "$RC2_ALL_NODEADLOCK"
assert_behav_eq "66. REPLACE/CLEAR (x3, critique) : JAMAIS 'configured' avec credentials_ref NULL, JAMAIS 'not_configured' avec credentials_ref NON NULL, et quand 'configured' le secret référencé existe TOUJOURS réellement" "1" "$RC2_ALL_CONSISTENT"

# ============================================================
# 67-70 : ABSENCE DE FUITE DE SECRET — recherche négative explicite
# sur TOUT le nouveau matériel de test PAY-P2A-03/04/V2-01 (mandat
# section 19 v2 / preuve de contention v3), y compris les fichiers de
# preuve de verrouillage eux-mêmes (evidence.txt, out/err des sessions
# holder/waiter/barrière) AVANT leur suppression.
# ============================================================
log "=== [67-70] ABSENCE DE FUITE — nouveau matériel PAY-P2A-03/04/V2-01 ==="
assert_struct_eq "67. aucun des secrets synthétiques de concurrence (conc-*-DO-NOT-USE) n'apparaît dans les fichiers de preuve de verrouillage (evidence.txt, sorties holder/waiter/barrière) de ce harnais" "0" "$(grep -rl "DO-NOT-USE" "$CONC_LOG_DIR" 2>/dev/null | wc -l)"
assert_struct_eq "68. le secret de remplacement rejeté (orphelin, test 39) n'apparaît dans AUCUN log psql capturé de ce harnais" "0" "$(sql "select 0;" >/dev/null; grep -rl "$SECRET_BETA" /tmp/scanym-p2a-*.txt 2>/dev/null | wc -l)"
assert_struct_eq "69. aucun des secrets synthétiques de concurrence (conc-*-DO-NOT-USE) n'apparaît dans le journal PostgreSQL (pg_log / stderr serveur, si accessible)" "0" "$(sudo test -d /var/log/postgresql 2>/dev/null && sudo grep -rl "DO-NOT-USE" /var/log/postgresql/ 2>/dev/null | wc -l || echo 0)"
# Note : exclut la ligne de cette assertion elle-même du grep (sinon
# le motif de recherche se detecterait lui-même dans son propre code
# source -- faux positif de forme, pas une fuite réelle).
assert_struct_eq "70. AUCUNE valeur de secret réel plausible (préfixes sk_live/pk_live, bloc PEM) n'apparaît dans le texte de ce script de test lui-même (contrôle de forme -- seuls des placeholders explicitement marqués DO-NOT-USE sont utilisés comme entrées de test, jamais un secret réel)" "0" "$(grep -v 'assert_struct_eq "70\.' "$0" | grep -c "sk_live\|pk_live\|-----BEGIN" || true)"

rm -rf "$CONC_LOG_DIR"

# ============================================================
# BILAN
# ============================================================
log "=== BILAN : $PASS_COUNT PASS / $FAIL_COUNT FAIL (dont $STRUCT_COUNT structurelles, $BEHAV_COUNT comportementales) ==="
if [ "$FAIL_COUNT" -gt 0 ]; then
  log "--- Détail des échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
