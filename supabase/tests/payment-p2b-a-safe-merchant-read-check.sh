#!/usr/bin/env bash
# ============================================================
# Scanym — PAYMENT P2B-A v2 — SAFE MERCHANT PAYMENT CONFIG READ RPC —
# Harnais reproductible (CORRECTION v2) pour
# supabase/DRAFT-lot-payment-p2b-a-safe-merchant-read.sql.
#
# CORRECTION v2 -- ferme les constats Work sur le HARNAIS uniquement
# (le SQL v1 est byte-identique, non redessiné) :
#   PAY-P2B-A-01 (MEDIUM) : MANIFEST-SHA256 absent du paquet livré ->
#     voir la discipline d'empaquetage en fin de mission (ce fichier
#     ne construit pas le paquet, mais son FILELIST/MANIFEST doivent
#     être cohérents ; corrigé côté empaquetage).
#   PAY-P2B-A-02 (MEDIUM) : les preuves de frontière secret (tests
#     v1 25/26/26b) reposaient sur un `regexp_replace` maison pour
#     retirer les commentaires SQL avant un `ilike` sur `prosrc` --
#     fragile par construction (n'importe quel futur commentaire ou
#     littéral contenant ces mots-clés peut fausser le test). REMPLACÉ
#     par une preuve COMPORTEMENTALE basée sur les privilèges réels
#     PostgreSQL : le RPC est temporairement ré-attribué (OWNER TO) à
#     un rôle de test dédié (`p2ba_locked_owner`) qui NE POSSÈDE
#     structurellement AUCUN privilège sur vault.secrets /
#     vault.decrypted_secrets ni sur la colonne credentials_ref -- si
#     le corps de la fonction touchait réellement l'un de ces objets,
#     l'exécution échouerait avec "permission denied". Un CONTRÔLE
#     NÉGATIF prouve d'abord que ces restrictions sont réellement
#     appliquées (une requête directe sous ce rôle contre ces mêmes
#     objets échoue bien), rendant le succès du RPC sous ce même rôle
#     une preuve authentique d'absence d'accès -- pas un artefact d'un
#     rôle mal restreint.
#   PAY-P2B-A-03 (LOW) : l'assertion "absence de fuite" (test v1 38)
#     scannait des fichiers de capture qui avaient déjà été supprimés
#     par un `rm -f` plus haut dans le script -- assertion
#     structurellement vide (toujours vraie, quoi qu'il arrive).
#     CORRIGÉ : un journal de capture UNIQUE et cumulatif
#     ($CAPTURE_LOG) reçoit désormais la sortie de CHAQUE appel psql
#     (toutes fonctions d'aide confondues) pendant toute la durée du
#     harnais ; le scan de fuite s'exécute AVANT tout nettoyage, et le
#     nettoyage (trap EXIT) ne supprime ce journal qu'APRÈS. Des
#     marqueurs synthétiques distinctifs (SYNTHETIC-P2BA-SECRET-*,
#     SYNTHETIC-P2BA-CREDENTIAL-REF-*) sont injectés dans les fixtures
#     pour que le scan ait quelque chose de non trivial à chercher.
#   PAY-P2B-A-04 (LOW) : preuve ACL directe insuffisante -- ajout de
#     `has_function_privilege(...)` pour anon/authenticated (preuve de
#     privilège effectif, catalogue natif PostgreSQL) en complément du
#     contrôle PUBLIC via information_schema (le pseudo-grantee PUBLIC
#     n'est pas acceptable comme argument de has_function_privilege).
#
# P2B-A ne touche JAMAIS Vault (métadonnées uniquement), mais dépend
# de PAYMENT P2A (colonne configuration_status) qui, elle, exige un
# schéma `vault` réel pour sa propre garde préflight -- ce harnais
# construit donc le même mock Vault test-only que le harnais P2A
# (identité exacte 4/5-arg confirmée par Work) UNIQUEMENT pour
# pouvoir appliquer P2A en amont ; aucune assertion de ce fichier ne
# porte sur Vault lui-même (hormis la preuve d'ABSENCE d'accès).
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/payment-p2b-a-safe-merchant-read-check.sh"
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
DRAFT_PAYMENT_P2BA_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p2b-a-safe-merchant-read.sql"
DB="scanym_payment_p2ba_$$"
DB_DRIFT="scanym_payment_p2ba_drift_$$"

PASS_COUNT=0
FAIL_COUNT=0
STRUCT_COUNT=0
BEHAV_COUNT=0
FAIL_LOG="/tmp/scanym-payment-p2ba-fails-$$.log"
: > "$FAIL_LOG"

# ------------------------------------------------------------
# JOURNAL DE CAPTURE CUMULATIF (correction PAY-P2B-A-03) -- reçoit la
# sortie de CHAQUE commande psql exécutée par ce harnais, pour toute sa
# durée. Scanné pour fuite AVANT nettoyage (jamais après suppression).
# ------------------------------------------------------------
CAPTURE_LOG="/tmp/scanym-p2ba-capture-$$.log"
: > "$CAPTURE_LOG"

log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); echo "$1" >> "$FAIL_LOG"; log "FAIL: $1"; }
struct() { STRUCT_COUNT=$((STRUCT_COUNT+1)); pass "$1"; }
behav() { BEHAV_COUNT=$((BEHAV_COUNT+1)); pass "$1"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
  # p2ba_locked_owner est un RÔLE (objet CLUSTER-WIDE, PAS un objet
  # propre à $DB) -- il doit être explicitement supprimé ici, sinon une
  # exécution ultérieure du harnais échouera dès `create role` avec
  # "role already exists" (bug réel découvert en testant la répétabilité
  # 3x exigée par le mandat -- corrigé en rendant la création ET la
  # suppression idempotentes, voir aussi le garde `drop role if exists`
  # juste avant la création plus bas dans le script).
  psql -c "drop role if exists p2ba_locked_owner;" >/dev/null 2>&1 || true
  rm -f "$FAIL_LOG" "$CAPTURE_LOG"
}
trap cleanup EXIT

# Toutes les fonctions d'aide ci-dessous ajoutent systématiquement leur
# sortie complète (stdout+stderr) à $CAPTURE_LOG, en plus de la
# retourner pour les assertions -- c'est ce cumul qui rend le scan de
# fuite final significatif (correction PAY-P2B-A-03).
sql() {
  local out
  out="$(psql -X -A -q -t -d "$DB" -c "$1" 2>&1)"
  { echo "--- sql() ---"; printf '%s\n' "$out"; } >> "$CAPTURE_LOG"
  printf '%s' "$out"
}
as_user_rc() {
  local uid="$1" query="$2" out rc
  out="$(PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$uid'; $query" 2>&1)"
  rc=$?
  { echo "--- as_user_rc uid=$uid rc=$rc ---"; printf '%s\n' "$out"; } >> "$CAPTURE_LOG"
  echo "$rc"
}
as_user() {
  local uid="$1" query="$2" out
  out="$(PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$uid'; $query" 2>&1)"
  { echo "--- as_user uid=$uid ---"; printf '%s\n' "$out"; } >> "$CAPTURE_LOG"
  printf '%s' "$out"
}
as_service() {
  local query="$1" out
  out="$(PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$query" 2>&1)"
  { echo "--- as_service ---"; printf '%s\n' "$out"; } >> "$CAPTURE_LOG"
  printf '%s' "$out"
}
as_anon_rc() {
  local query="$1" out rc
  out="$(PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$query" 2>&1)"
  rc=$?
  { echo "--- as_anon_rc rc=$rc ---"; printf '%s\n' "$out"; } >> "$CAPTURE_LOG"
  echo "$rc"
}
as_role_rc() {
  local role="$1" query="$2" out rc
  out="$(PGOPTIONS="-c role=$role" psql -X -A -q -t -d "$DB" -c "$query" 2>&1)"
  rc=$?
  { echo "--- as_role_rc role=$role rc=$rc ---"; printf '%s\n' "$out"; } >> "$CAPTURE_LOG"
  echo "$rc"
}
super_rc() {
  local query="$1" out rc
  out="$(psql -X -A -q -t -d "$DB" -c "$query" 2>&1)"
  rc=$?
  { echo "--- super_rc rc=$rc ---"; printf '%s\n' "$out"; } >> "$CAPTURE_LOG"
  echo "$rc"
}
# Exécute un batch multi-instructions (ex : begin; update ...;) sans
# ON_ERROR_STOP ni commit explicite -- si une instruction échoue, le
# bloc de transaction implicite avorte et RIEN n'est committé (la
# connexion se ferme sans COMMIT). Retourne le code de sortie psql.
super_txn_rc() {
  local sqltext="$1" out rc
  out="$(psql -X -A -q -t -d "$DB" -v ON_ERROR_STOP=1 -c "$sqltext" 2>&1)"
  rc=$?
  { echo "--- super_txn_rc rc=$rc ---"; printf '%s\n' "$out"; } >> "$CAPTURE_LOG"
  echo "$rc"
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
# MOCK VAULT — TEST HARNESS ONLY, requis UNIQUEMENT pour que la garde
# préflight de PAYMENT P2A (prérequis de P2B-A) soit satisfaite.
# Identique au mock du harnais P2A (identité exacte 4/5-arg). AUCUNE
# assertion de CE harnais ne porte sur le CONTENU de Vault -- seule son
# ABSENCE D'ACCÈS depuis le RPC P2B-A est prouvée (section dédiée).
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

# ============================================================
# 0. BASELINE — chaîne réelle jusqu'à P1 + P2A (publiées, mock Vault
# test-only pour satisfaire la garde préflight P2A), puis P2B-A.
# ============================================================
log "=== [0] Construction baseline $DB (chaîne réelle jusqu'à P1 + P2A, publiées) ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
build_common_bootstrap "$DB"
build_full_chain "$DB"
build_mock_vault "$DB"
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2A_SQL" >/dev/null
struct "chaîne réelle appliquée jusqu'à P1 + P2A (publiées, mock Vault test-only satisfaisant leur garde préflight)"

log "=== [0] Application de DRAFT-lot-payment-p2b-a-safe-merchant-read.sql (SQL v1, byte-identique) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2BA_SQL" >/dev/null
struct "DRAFT-lot-payment-p2b-a-safe-merchant-read.sql appliqué sans erreur"

# ============================================================
# FIXTURES — deux tenants, plusieurs configurations, AUCUN secret réel.
# Les valeurs de secret embarquent un marqueur synthétique distinctif
# (correction PAY-P2B-A-03) permettant un scan de fuite non trivial.
# ============================================================
log "=== Fixtures (Tenant A avec 2 configs, Tenant B avec 1 config) ==="
OWNER_A="50000000-0000-0000-0000-0000000000a1"
OWNER_B="50000000-0000-0000-0000-0000000000b1"

psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into auth.users (id, email) values
  ('$OWNER_A', 'owner@p2ba-fixture-a.test'),
  ('$OWNER_B', 'owner@p2ba-fixture-b.test');

with resto as (
  insert into restaurants (name, slug, status) values ('P2B-A Fixture Tenant A', 'p2ba-fixture-tenant-a', 'active') returning id
)
insert into restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number)
select id, 0, 'EUR', '+33600000801' from resto;

with resto2 as (
  insert into restaurants (name, slug, status) values ('P2B-A Fixture Tenant B', 'p2ba-fixture-tenant-b', 'active') returning id
)
insert into restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number)
select id, 0, 'EUR', '+33600000901' from resto2;
SQL

RID_A="$(sql "select id from restaurants where slug='p2ba-fixture-tenant-a';")"
RID_B="$(sql "select id from restaurants where slug='p2ba-fixture-tenant-b';")"

psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into restaurant_users (restaurant_id, user_id, role) values
  ('$RID_A', '$OWNER_A', 'owner'),
  ('$RID_B', '$OWNER_B', 'owner');
SQL

SECRET_MARKER="SYNTHETIC-P2BA-SECRET-DO-NOT-USE"
CREDREF_MARKER="SYNTHETIC-P2BA-CREDENTIAL-REF-DO-NOT-USE"
SECRET_A1="${SECRET_MARKER}-a1-$$"
SECRET_A2="${SECRET_MARKER}-a2-$$"
SECRET_B1="${SECRET_MARKER}-b1-$$"

# Deux configurations DISTINCTES pour le tenant A (cardinalité,
# unique(restaurant_id, provider_code) permet plusieurs prestataires) --
# créées via le VRAI RPC P2A (chemin de Production), pas une insertion
# directe.
as_service "select * from public.set_payment_provider_credentials('$RID_A','fixture-provider-one','$SECRET_A1');" >/dev/null
as_service "select * from public.set_payment_provider_credentials('$RID_A','fixture-provider-two','$SECRET_A2');" >/dev/null
as_service "select * from public.set_payment_provider_credentials('$RID_B','fixture-provider-one','$SECRET_B1');" >/dev/null

# Fixture de test supplémentaire (accès superuser DIRECT -- P2A
# n'expose aucun RPC pour positionner is_enabled/last_verified_at ;
# ceci prépare uniquement les données de test, ce n'est pas un chemin
# applicatif) : active une des deux configs de A et lui donne une date
# de dernière vérification, pour prouver que P2B-A restitue bien ces
# champs quels que soient leurs valeurs.
sql "update payment_provider_configs set is_enabled = true, last_verified_at = now() where restaurant_id = '$RID_A' and provider_code = 'fixture-provider-one';" >/dev/null

# Canari Vault dédié : un secret Vault mock dont le NOM porte le
# marqueur credentials_ref synthétique -- n'est lié à AUCUNE
# configuration réelle. Sert de preuve positive (recherche) que ce
# marqueur -- et donc toute métadonnée Vault -- n'apparaît JAMAIS dans
# la sortie réelle du RPC (section CREDENTIALS_REF PROOF, item C).
CREDREF_CANARY_ID="$(sql "insert into vault.secrets (secret, name, description) values ('${SECRET_MARKER}-canary-$$', '$CREDREF_MARKER', 'canary fixture, jamais lié à une configuration réelle') returning id;")"

struct "fixtures : tenant A (2 configs, une activée+vérifiée), tenant B (1 config), aucun secret réel (placeholders synthétiques marqués $SECRET_MARKER / $CREDREF_MARKER uniquement)"

# ============================================================
# STRUCTURE (1-6)
# ============================================================
log "=== [1-6] STRUCTURE ==="
assert_struct_eq "1. la fonction public.get_merchant_payment_provider_config existe" "1" "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_merchant_payment_provider_config';")"
assert_struct_eq "2. signature d'entrée EXACTE : un seul paramètre uuid" "uuid" "$(sql "select pg_get_function_identity_arguments(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_merchant_payment_provider_config';" | sed 's/p_restaurant_id //')"
EXPECTED_RETURN="TABLE(provider_code text, mode text, configuration_status text, is_enabled boolean, last_verified_at timestamp with time zone, updated_at timestamp with time zone)"
assert_struct_eq "3. contrat de retour EXACT (six colonnes, types et ordre attendus, rien de plus -- pg_get_function_result, métadonnée catalogue analysée, pas une lecture ad hoc du texte source)" "$EXPECTED_RETURN" "$(sql "select pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_merchant_payment_provider_config';")"
assert_struct_eq "4. SECURITY DEFINER (pg_proc.prosecdef)" "t" "$(sql "select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_merchant_payment_provider_config';")"
assert_struct_eq "5. search_path vide (set search_path = '', pg_proc.proconfig)" "1" "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_merchant_payment_provider_config' and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=\"\"');")"
assert_struct_eq "6. AUCUN SQL dynamique (ni EXECUTE ni format(...) dans le corps exécutable de la fonction)" "0" "$(sql "select (case when prosrc ilike '%execute %' or prosrc ilike '%format(%' then 1 else 0 end) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_merchant_payment_provider_config';")"

# ============================================================
# MÉTADONNÉES CATALOGUE — OWNER / LANGUAGE / VOLATILITY (mandat §8)
# ============================================================
log "=== MÉTADONNÉES CATALOGUE (owner/language/volatility) ==="
ORIGINAL_OWNER="$(sql "select r.rolname from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname='public' and p.proname='get_merchant_payment_provider_config';")"
APPLY_ROLE="$(sql "select current_user;")"
assert_struct_eq "6b. propriétaire du RPC = rôle ayant appliqué la migration ($APPLY_ROLE)" "$APPLY_ROLE" "$ORIGINAL_OWNER"
assert_struct_eq "6c. langage = plpgsql (pg_language)" "plpgsql" "$(sql "select l.lanname from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang where n.nspname='public' and p.proname='get_merchant_payment_provider_config';")"
assert_struct_eq "6d. volatilité = STABLE (pg_proc.provolatile='s')" "s" "$(sql "select provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_merchant_payment_provider_config';")"

# ============================================================
# ACL (7-10) — correction PAY-P2B-A-04 : preuve directe via
# has_function_privilege (privilège EFFECTIF réel), pas seulement une
# lecture de ligne de grant.
# ============================================================
log "=== [7-10] ACL ==="
# has_function_privilege n'accepte pas le pseudo-grantee PUBLIC comme
# argument -- pour PUBLIC spécifiquement, l'outil catalogue correct
# reste la présence/absence d'une ligne de grant explicite.
assert_struct_eq "7. PUBLIC ne peut pas exécuter (aucune ligne de grant PUBLIC -- information_schema.role_routine_grants, has_function_privilege n'accepte pas PUBLIC comme argument)" "0" "$(sql "select count(*) from information_schema.role_routine_grants where routine_schema='public' and routine_name='get_merchant_payment_provider_config' and grantee='PUBLIC';")"
assert_struct_eq "8. anon NE PEUT PAS exécuter -- has_function_privilege('anon', ..., 'EXECUTE') (privilège effectif réel)" "f" "$(sql "select has_function_privilege('anon', 'public.get_merchant_payment_provider_config(uuid)', 'EXECUTE');")"
assert_struct_eq "9. authenticated PEUT exécuter -- has_function_privilege('authenticated', ..., 'EXECUTE') (privilège effectif réel)" "t" "$(sql "select has_function_privilege('authenticated', 'public.get_merchant_payment_provider_config(uuid)', 'EXECUTE');")"
assert_behav_eq "9b. comportemental : anon rejeté à l'exécution réelle (cohérent avec le catalogue ci-dessus)" "1" "$([ "$(as_anon_rc "select * from public.get_merchant_payment_provider_config('$RID_A');")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "9c. comportemental : authenticated (membre) réussit à l'exécution réelle (cohérent avec le catalogue ci-dessus)" "1" "$([ "$(as_user_rc "$OWNER_A" "select * from public.get_merchant_payment_provider_config('$RID_A');")" = "0" ] && echo 1 || echo 0)"
assert_struct_eq "10. AUCUN grant SELECT direct nouveau sur payment_provider_configs pour authenticated (RPC = seule frontière de lecture)" "0" "$(sql "select count(*) from information_schema.role_table_grants where table_schema='public' and table_name='payment_provider_configs' and grantee='authenticated' and privilege_type='SELECT';")"

# ============================================================
# ACCÈS DIRECT À LA TABLE (mandat section 9/12) — preuve explicite
# ============================================================
log "=== ACCÈS DIRECT À LA TABLE — refusé, puis RPC réussit ==="
assert_behav_eq "11. SELECT direct sur payment_provider_configs par authenticated REFUSÉ (contournement du RPC impossible)" "1" "$([ "$(as_user_rc "$OWNER_A" "select * from payment_provider_configs where restaurant_id='$RID_A';")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "12. immédiatement après, le RPC sûr RÉUSSIT pour ce même membre sur son propre tenant (le chemin légitime fonctionne, seul le contournement est bloqué)" "1" "$([ "$(as_user_rc "$OWNER_A" "select * from public.get_merchant_payment_provider_config('$RID_A');")" = "0" ] && echo 1 || echo 0)"

# ============================================================
# AUTORISATION (mandat section 10, régression complète)
# ============================================================
log "=== AUTORISATION ==="
RES_A="$(as_user "$OWNER_A" "select * from public.get_merchant_payment_provider_config('$RID_A');")"
assert_behav_eq "13. membre du tenant A voit sa propre configuration (résultat non vide)" "1" "$([ -n "$RES_A" ] && echo 1 || echo 0)"
assert_behav_eq "14. non-membre (aucun rattachement restaurant_users) REJETÉ 42501" "1" "$(as_user "50000000-0000-0000-0000-00000000dead" "select * from public.get_merchant_payment_provider_config('$RID_A');" 2>&1 | grep -c "42501\|Not authorized" || true)"
assert_behav_eq "15. membre A NE PEUT PAS lire la configuration du tenant B (cross-tenant rejeté 42501)" "1" "$(as_user "$OWNER_A" "select * from public.get_merchant_payment_provider_config('$RID_B');" 2>&1 | grep -c "42501\|Not authorized" || true)"
assert_behav_eq "16. restaurant_id invalide/inexistant traité SANS erreur serveur inattendue -- rejeté 42501 comme un non-membre (n'expose pas si le restaurant existe)" "1" "$(as_user "$OWNER_A" "select * from public.get_merchant_payment_provider_config('00000000-0000-0000-0000-000000000099');" 2>&1 | grep -c "42501\|Not authorized" || true)"
assert_behav_eq "17. restaurant_id NULL rejeté proprement (22004), pas une exception non gérée" "1" "$(as_user "$OWNER_A" "select * from public.get_merchant_payment_provider_config(null);" 2>&1 | grep -c "22004\|p_restaurant_id requis" || true)"
assert_struct_eq "18. aucune fuite de métadonnée tenant : le message d'erreur du rejet cross-tenant ne contient ni le nom, ni le slug du tenant B" "0" "$(as_user "$OWNER_A" "select * from public.get_merchant_payment_provider_config('$RID_B');" 2>&1 | grep -ic "p2ba-fixture-tenant-b\|P2B-A Fixture Tenant B" || true)"

# ============================================================
# DONNÉES SÛRES — les six champs
# ============================================================
log "=== DONNÉES SÛRES (six champs) ==="
ROW_A1="$(as_user "$OWNER_A" "select provider_code, mode, configuration_status, is_enabled, last_verified_at is not null, updated_at is not null from public.get_merchant_payment_provider_config('$RID_A') where provider_code='fixture-provider-one';")"
assert_struct_eq "19. provider_code retourné correctement" "fixture-provider-one" "$(echo "$ROW_A1" | awk -F'|' '{print $1}')"
assert_struct_eq "20. mode retourné correctement" "test" "$(echo "$ROW_A1" | awk -F'|' '{print $2}')"
assert_struct_eq "21. configuration_status retourné correctement" "configured" "$(echo "$ROW_A1" | awk -F'|' '{print $3}')"
assert_struct_eq "22. is_enabled retourné correctement (activé par la fixture)" "t" "$(echo "$ROW_A1" | awk -F'|' '{print $4}')"
assert_struct_eq "23. last_verified_at retourné (non NULL, positionné par la fixture)" "t" "$(echo "$ROW_A1" | awk -F'|' '{print $5}')"
assert_struct_eq "24. updated_at retourné (non NULL)" "t" "$(echo "$ROW_A1" | awk -F'|' '{print $6}')"

# ============================================================
# CREDENTIALS_REF PROOF (mandat section 4, A-D) + VAULT ACCESS PROOF
# (mandat section 5) — correction PAY-P2B-A-02.
#
# A. contrat de retour n'a pas credentials_ref (catalogue).
# B. sélectionner credentials_ref sur le résultat échoue (42703).
# C. la valeur RÉELLE credentials_ref, et le marqueur canari Vault, ne
#    sont JAMAIS présents dans la sortie réelle du RPC.
# D. preuve comportementale (privilèges) que la requête interne ne
#    sélectionne JAMAIS credentials_ref -- ET que le corps ne touche
#    JAMAIS vault.secrets/vault.decrypted_secrets : le RPC est
#    temporairement réattribué à un rôle de test dédié qui NE POSSÈDE
#    structurellement AUCUN privilège sur ces objets ; un contrôle
#    négatif prouve d'abord que la restriction est réellement
#    appliquée, rendant le succès du RPC sous ce rôle une preuve
#    authentique (pas un artefact de rôle mal restreint).
# ============================================================
log "=== CREDENTIALS_REF PROOF + VAULT ACCESS PROOF ==="
FN_RETURN_DEF="$(sql "select pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_merchant_payment_provider_config';")"
assert_struct_eq "25. [A] credentials_ref ABSENT du contrat de retour (pg_get_function_result, catalogue analysé)" "0" "$(echo "$FN_RETURN_DEF" | grep -c "credentials_ref" || true)"
RC_CREDREF_SELECT="$(as_user_rc "$OWNER_A" "select credentials_ref from public.get_merchant_payment_provider_config('$RID_A') x;")"
assert_struct_eq "26. [B] credentials_ref ABSENT du résultat réel -- sélectionner cette colonne sur le jeu de résultat échoue 42703 (la colonne n'existe structurellement pas)" "1" "$([ "$RC_CREDREF_SELECT" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "27. aucune colonne 'id' isolée ni mention 'vault' dans le contrat de retour (pg_get_function_result)" "0" "$(echo "$FN_RETURN_DEF" | grep -Eic '\bid\b|vault' || true)"
assert_struct_eq "28. aucun mot-clé 'secret' dans le contrat de retour (pg_get_function_result)" "0" "$(echo "$FN_RETURN_DEF" | grep -ic "secret" || true)"

CREDREF_A1="$(sql "select credentials_ref from public.payment_provider_configs where restaurant_id='$RID_A' and provider_code='fixture-provider-one';")"
RPC_OUTPUT_A="$(as_user "$OWNER_A" "select * from public.get_merchant_payment_provider_config('$RID_A');")"
assert_struct_eq "29. [C] la valeur RÉELLE de credentials_ref (UUID Vault fixture) n'apparaît JAMAIS dans la sortie réelle du RPC" "0" "$(printf '%s' "$RPC_OUTPUT_A" | grep -c "$CREDREF_A1" || true)"
assert_struct_eq "30. [C] le marqueur canari Vault ($CREDREF_MARKER) n'apparaît JAMAIS dans la sortie réelle du RPC" "0" "$(printf '%s' "$RPC_OUTPUT_A" | grep -c "$CREDREF_MARKER" || true)"

# --- Rôle de test dédié, privilèges structurellement restreints ---
# p2ba_locked_owner est un rôle CLUSTER-WIDE (pas propre à $DB) --
# `drop role if exists` défensif avant `create role` pour que le
# harnais reste répétable même si une exécution précédente a été
# interrompue avant d'atteindre le nettoyage normal (trap cleanup).
psql -c "drop role if exists p2ba_locked_owner;" >/dev/null 2>&1 || true
sql "create role p2ba_locked_owner nologin;" >/dev/null
sql "grant select (restaurant_id, provider_code, mode, configuration_status, is_enabled, last_verified_at, updated_at) on public.payment_provider_configs to p2ba_locked_owner;" >/dev/null
sql "grant execute on function public.is_member_of(uuid) to p2ba_locked_owner;" >/dev/null
sql "grant usage on schema public to p2ba_locked_owner;" >/dev/null
# auth.uid() est appelé en tout premier par le corps de la fonction --
# le schéma auth doit être USAGE (indépendamment de l'EXECUTE sur
# auth.uid() lui-même, déjà public par défaut) sinon l'appel échoue
# avec "permission denied for schema auth" AVANT même d'atteindre la
# logique métier -- ce ne serait pas un signal Vault/credentials_ref,
# juste un faux échec de la fixture de test elle-même.
sql "grant usage on schema auth to p2ba_locked_owner;" >/dev/null
# Défensif/documentaire : aucun privilège vault ni sur la colonne
# credentials_ref n'est accordé (l'absence de GRANT suffit déjà en
# PostgreSQL, mais un REVOKE explicite documente l'intention et reste
# un no-op sûr si déjà absent).
sql "revoke all on table vault.secrets from p2ba_locked_owner;" >/dev/null
sql "revoke all on table vault.decrypted_secrets from p2ba_locked_owner;" >/dev/null
sql "revoke select (credentials_ref, id) on public.payment_provider_configs from p2ba_locked_owner;" >/dev/null

# Contrôle NÉGATIF -- prouve que ces restrictions sont RÉELLEMENT
# appliquées avant de s'appuyer sur elles comme preuve.
NEGCTRL_CREDREF_RC="$(as_role_rc "p2ba_locked_owner" "select credentials_ref from public.payment_provider_configs limit 1;")"
assert_behav_eq "31. [contrôle négatif] p2ba_locked_owner NE PEUT PAS lire credentials_ref directement (permission denied attendu -- prouve que la restriction est réelle)" "1" "$([ "$NEGCTRL_CREDREF_RC" != "0" ] && echo 1 || echo 0)"
NEGCTRL_VAULT_RC="$(as_role_rc "p2ba_locked_owner" "select secret from vault.secrets limit 1;")"
assert_behav_eq "32. [contrôle négatif] p2ba_locked_owner NE PEUT PAS lire vault.secrets directement (permission denied attendu -- prouve que la restriction est réelle)" "1" "$([ "$NEGCTRL_VAULT_RC" != "0" ] && echo 1 || echo 0)"

# Ré-attribution temporaire du RPC à ce rôle restreint.
sql "alter function public.get_merchant_payment_provider_config(uuid) owner to p2ba_locked_owner;" >/dev/null
RC_RESTRICTED_EXEC="$(as_user_rc "$OWNER_A" "select * from public.get_merchant_payment_provider_config('$RID_A');")"
# Restauration IMMÉDIATE du propriétaire d'origine avant toute autre
# assertion (n'affecte pas les grants EXECUTE existants, qui persistent
# indépendamment du propriétaire).
sql "alter function public.get_merchant_payment_provider_config(uuid) owner to \"$ORIGINAL_OWNER\";" >/dev/null

assert_behav_eq "33. [D] le RPC RÉUSSIT même exécuté sous un propriétaire SANS AUCUN privilège sur credentials_ref -- preuve comportementale que la requête interne ne sélectionne jamais cette colonne (échouerait sinon en permission denied, cf. contrôle négatif 31)" "1" "$([ "$RC_RESTRICTED_EXEC" = "0" ] && echo 1 || echo 0)"
assert_behav_eq "34. [VAULT ACCESS PROOF] le RPC RÉUSSIT même exécuté sous un propriétaire SANS AUCUN privilège sur vault.secrets/vault.decrypted_secrets -- preuve comportementale que le corps ne touche jamais Vault (échouerait sinon en permission denied, cf. contrôle négatif 32)" "1" "$([ "$RC_RESTRICTED_EXEC" = "0" ] && echo 1 || echo 0)"
assert_struct_eq "35. propriétaire du RPC restauré correctement après la preuve de privilège (aucune dérive de propriété laissée par le harnais)" "$ORIGINAL_OWNER" "$(sql "select r.rolname from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname='public' and p.proname='get_merchant_payment_provider_config';")"

# ============================================================
# CARDINALITÉ (mandat section 11)
# ============================================================
log "=== CARDINALITÉ ==="
# NOTE : le tenant B possède DÉJÀ une configuration (fixture-provider-one,
# créée ci-dessus via set_payment_provider_credentials) -- "zéro
# configuration -> zéro ligne" est donc testé contre un tenant membre
# valide mais VRAIMENT sans configuration (RID_EMPTY/OWNER_EMPTY),
# pas contre RID_B qui a un compte attendu de 1.
RID_EMPTY="$(sql "insert into restaurants (name, slug, status) values ('P2B-A Fixture Tenant Empty', 'p2ba-fixture-tenant-empty', 'active') returning id;")"
sql "insert into restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number) values ('$RID_EMPTY', 0, 'EUR', '+33600001001');" >/dev/null
OWNER_EMPTY="50000000-0000-0000-0000-0000000000e1"
sql "insert into auth.users (id, email) values ('$OWNER_EMPTY', 'owner@p2ba-fixture-empty.test');" >/dev/null
sql "insert into restaurant_users (restaurant_id, user_id, role) values ('$RID_EMPTY', '$OWNER_EMPTY', 'owner');" >/dev/null
assert_struct_eq "36. tenant membre valide mais AUCUNE configuration jamais créée -> ZÉRO ligne (pas d'erreur, pas de ligne fabriquée)" "0" "$(as_user "$OWNER_EMPTY" "select count(*) from public.get_merchant_payment_provider_config('$RID_EMPTY') x;" | tail -1)"
assert_struct_eq "37. tenant B (une seule configuration) -> EXACTEMENT une ligne" "1" "$(as_user "$OWNER_B" "select count(*) from public.get_merchant_payment_provider_config('$RID_B') x;" | tail -1)"
assert_struct_eq "38. tenant A (deux configurations distinctes, provider_code différent) -> EXACTEMENT deux lignes -- AUCUN LIMIT 1 arbitraire" "2" "$(as_user "$OWNER_A" "select count(*) from public.get_merchant_payment_provider_config('$RID_A') x;" | tail -1)"
assert_struct_eq "39. les deux lignes du tenant A portent bien les DEUX provider_code distincts attendus" "fixture-provider-one|fixture-provider-two" "$(as_user "$OWNER_A" "select string_agg(provider_code, '|' order by provider_code) from public.get_merchant_payment_provider_config('$RID_A');")"

# ============================================================
# P1/P2A NON-RÉGRESSION (mandat section 12)
# ============================================================
log "=== P1/P2A NON-RÉGRESSION ==="
assert_struct_eq "40. objets P1 inchangés -- payment_transactions conserve son SELECT RLS-filtré pour authenticated" "1" "$(sql "select count(*) from information_schema.role_table_grants where table_schema='public' and table_name='payment_transactions' and grantee='authenticated' and privilege_type='SELECT';")"
assert_struct_eq "41. RPC P2A set_payment_provider_credentials/clear_payment_provider_credentials toujours présents et toujours REVOKE ALL FROM public/anon/authenticated (P2B-A n'a rien ouvert de plus)" "0" "$(sql "select count(*) from information_schema.role_routine_grants where routine_schema='public' and routine_name in ('set_payment_provider_credentials','clear_payment_provider_credentials') and grantee in ('anon','authenticated','PUBLIC');")"
assert_struct_eq "42. ACL Vault inchangée -- anon/authenticated toujours sans accès à vault.secrets/vault.decrypted_secrets" "0" "$(sql "select count(*) from information_schema.role_table_grants where table_schema='vault' and table_name in ('secrets','decrypted_secrets') and grantee in ('anon','authenticated');")"
# NOTE : row_security_active() dépend du RÔLE APPELANT (un
# propriétaire/superutilisateur contourne RLS par défaut) -- le fait
# structurel stable quel que soit le rôle est pg_class.relrowsecurity.
assert_struct_eq "43. RLS de payment_provider_configs INCHANGÉE (relrowsecurity toujours activée depuis P1, TOUJOURS aucune policy)" "true|0" "$(sql "select relrowsecurity::text || '|' || (select count(*) from pg_policies where schemaname='public' and tablename='payment_provider_configs')::text from pg_class where relname='payment_provider_configs' and relnamespace = 'public'::regnamespace;")"

ROWID_A1="$(sql "select id from public.payment_provider_configs where restaurant_id='$RID_A' and provider_code='fixture-provider-one';")"
ROWID_A2="$(sql "select id from public.payment_provider_configs where restaurant_id='$RID_A' and provider_code='fixture-provider-two';")"
RC_DUP_CREDREF="$(super_txn_rc "begin; update public.payment_provider_configs set credentials_ref = (select credentials_ref from public.payment_provider_configs where id='$ROWID_A1') where id='$ROWID_A2';")"
assert_behav_eq "44. contrainte d'unicité credentials_ref (P2A, payment_provider_configs_credentials_ref_unique) TOUJOURS appliquée -- dupliquer une référence existante échoue (rien committé, batch avorté sans COMMIT)" "1" "$([ "$RC_DUP_CREDREF" != "0" ] && echo 1 || echo 0)"
RC_BAD_STATUS="$(super_txn_rc "begin; update public.payment_provider_configs set configuration_status = 'p2ba-bogus-status-test' where id='$ROWID_A1';")"
assert_behav_eq "45. contrainte CHECK configuration_status (P2A) TOUJOURS appliquée -- une valeur hors énumération échoue (rien committé, batch avorté sans COMMIT)" "1" "$([ "$RC_BAD_STATUS" != "0" ] && echo 1 || echo 0)"
POST_CHECK_STATUS="$(sql "select configuration_status from public.payment_provider_configs where id='$ROWID_A1';")"
assert_struct_eq "46. confirmation : la tentative avortée du test 45 n'a RIEN modifié (configuration_status toujours 'configured')" "configured" "$POST_CHECK_STATUS"

# ============================================================
# GARDES ANTI-DÉRIVE
# ============================================================
log "=== GARDES ANTI-DÉRIVE ==="
RC_DOUBLE_APPLY="$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2BA_SQL" >>"$CAPTURE_LOG" 2>>"$CAPTURE_LOG"; echo $?)"
assert_behav_eq "47. double application du lot REFUSÉE (SCANYM_SCHEMA_DRIFT)" "1" "$([ "$RC_DOUBLE_APPLY" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "48. message de double application mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" "$CAPTURE_LOG" || true)"

log "=== GARDE — base SANS payment_provider_configs.configuration_status (P2A manquant) ==="
psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
createdb "$DB_DRIFT"
build_common_bootstrap "$DB_DRIFT"
build_full_chain "$DB_DRIFT"
RC_MISSING_P2A="$(psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2BA_SQL" >>"$CAPTURE_LOG" 2>/tmp/scanym-p2ba-driftguard-err-$$.txt; echo $?)"
cat /tmp/scanym-p2ba-driftguard-err-$$.txt >> "$CAPTURE_LOG"
assert_behav_eq "49. application sur base SANS configuration_status (P2A manquant) REFUSÉE dès la garde préflight" "1" "$([ "$RC_MISSING_P2A" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "50. message de garde préflight (prérequis P2A) mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" /tmp/scanym-p2ba-driftguard-err-$$.txt || true)"
rm -f /tmp/scanym-p2ba-driftguard-err-$$.txt

# ============================================================
# ABSENCE DE FUITE DE SECRET (correction PAY-P2B-A-03) — le scan
# s'exécute ICI, contre le journal de capture CUMULATIF qui contient
# la sortie de TOUTES les commandes psql exécutées depuis le début du
# harnais, et AVANT tout nettoyage (le trap EXIT ne supprime
# $CAPTURE_LOG qu'après la fin du script, donc après ce scan).
# ============================================================
log "=== ABSENCE DE FUITE — journal de capture cumulatif (${CAPTURE_LOG}, $(wc -l < "$CAPTURE_LOG") lignes) ==="
# NOTE IMPORTANTE sur la portée de ce scan : $CAPTURE_LOG contient
# uniquement la SORTIE (stdout+stderr, donc résultats et messages
# d'erreur) de chaque appel psql -- jamais le TEXTE de la requête
# envoyée (psql tourne en mode silencieux, sans écho de commande). Le
# marqueur secret n'est donc JAMAIS censé apparaître nulle part dans ce
# journal, y compris au moment où la fixture est créée -- seule une
# fuite RÉELLE (le secret revenant dans un résultat ou un message
# d'erreur) le ferait apparaître. C'est ce qui rend ce scan non trivial
# (contrairement à v1, où les fichiers scannés avaient déjà été
# supprimés -- l'assertion était donc vide de sens).
assert_struct_eq "51. aucun secret synthétique (marqueur $SECRET_MARKER) n'apparaît nulle part dans le journal de capture cumulatif de TOUTES les sorties psql du harnais" "0" "$(grep -c "$SECRET_MARKER" "$CAPTURE_LOG" || true)"
assert_struct_eq "52. aucun marqueur credentials_ref canari ($CREDREF_MARKER) n'apparaît nulle part dans le journal de capture cumulatif (couvre aussi les chemins d'erreur, pas seulement la sortie RPC nominale déjà vérifiée au test 30)" "0" "$(grep -c "$CREDREF_MARKER" "$CAPTURE_LOG" || true)"
assert_struct_eq "53. AUCUNE valeur de secret réel plausible (préfixes sk_live/pk_live, bloc PEM) dans le texte de ce script lui-même" "0" "$(grep -v 'assert_struct_eq "53\.' "$0" | grep -c "sk_live\|pk_live\|-----BEGIN" || true)"

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
