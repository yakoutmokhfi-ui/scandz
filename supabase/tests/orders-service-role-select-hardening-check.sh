#!/usr/bin/env bash
# ============================================================
# Scanym — ORDERS SERVICE_ROLE SELECT HARDENING v1 — Harnais
# reproductible pour
# supabase/DRAFT-lot-orders-service-role-select-hardening.sql.
#
# PostgreSQL communautaire vanilla (pas une instance Supabase managée).
#
# DIFFÉRENCE MÉTHODOLOGIQUE IMPORTANTE (mandat section 25, "Do not rely
# only on a harness where service_role starts with zero rights. This is
# critical.") : contrairement à TOUS les harnais paiement précédents
# (P1/P2A/P2B-A/P3-A0/P3-B0/P3-B1/P3-B2), où service_role est recréé
# avec AUCUN privilège de table par défaut (property de mon
# environnement de test, pas nécessairement de Production réelle -- ce
# décalage documenté est précisément la raison d'être de ce lot), ce
# harnais accorde EXPLICITEMENT `select` à `service_role` sur
# `public.orders` APRÈS la construction de la chaîne complète, pour
# reproduire délibérément l'état "AVANT" rapporté en Production avant
# de mesurer l'effet du durcissement. Ceci n'est PAS une reproduction
# certifiée de Production (cette session n'a et n'a jamais eu d'accès
# Production réel -- voir la bannière du fichier SQL) -- c'est une
# construction délibérée d'un scénario "AVANT" conforme à l'intrant du
# mandat, pour prouver que la migration produit bien l'état "APRÈS"
# attendu quel que soit le point de départ exact.
#
# Chaîne : chaîne minimale (schema.sql .. migration-v81-lot1b-
# translations.sql) -> DRAFT-lot-payment-p1-foundation.sql -> Vault
# moqué -> P2A -> P2B-A -> P3-A0 -> P3-B0 v2 -> P3-B1 (toutes déjà
# publiées) -> GRANT SELECT explicite à service_role (simulation
# "AVANT") -> LOT SOUS TEST (hardening) -> [test de compatibilité
# uniquement] candidat P3-B2 (non publié, appliqué UNIQUEMENT ici,
# jamais dans la migration de ce lot elle-même, mandat section 9).
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/orders-service-role-select-hardening-check.sh"
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
DRAFT_HARDENING_SQL="$SUPABASE_DIR/DRAFT-lot-orders-service-role-select-hardening.sql"
DRAFT_P3B2_CANDIDATE_SQL="$SUPABASE_DIR/tests/fixtures/p3b2-candidate-order-payment-context-read.sql"
DB="scanym_orders_hardening_$$"
DB_FRESH="scanym_orders_hardening_fresh_$$"

PASS_COUNT=0
FAIL_COUNT=0
STRUCT_COUNT=0
BEHAV_COUNT=0
FAIL_LOG="/tmp/scanym-orders-hardening-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }
struct() { STRUCT_COUNT=$((STRUCT_COUNT+1)); pass "$@"; }
behav() { BEHAV_COUNT=$((BEHAV_COUNT+1)); pass "$@"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
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
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-oh-out-$$.txt 2>/tmp/scanym-oh-err-$$.txt
  echo $?
}
as_anon_rc() {
  local query="$1"
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-oh-out-$$.txt 2>/tmp/scanym-oh-err-$$.txt
  echo $?
}
as_user() {
  local uid="$1" query="$2"
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$uid'; $query" 2>&1
}
as_user_rc() {
  local uid="$1" query="$2"
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$uid'; $query" >/tmp/scanym-oh-out-$$.txt 2>/tmp/scanym-oh-err-$$.txt
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
# 0. BASELINE — chaîne complète publiée.
# ============================================================
log "=== [0] Construction baseline $DB ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
build_full_chain "$DB"
struct "chaîne complète appliquée (minimale + P1 + Vault moqué + P2A + P2B-A + P3-A0 + P3-B0 v2 + P3-B1)"

# ============================================================
# 1. SIMULATION DE L'ÉTAT "AVANT" RAPPORTÉ EN PRODUCTION (mandat
# section 25 -- "Do not rely only on a harness where service_role
# starts with zero rights").
# ============================================================
log "=== [1] Simulation explicite de l'état AVANT (service_role SELECT accordé) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -c "grant select on public.orders to service_role;" >/dev/null
struct "simulation AVANT appliquée : grant select on public.orders to service_role (reproduit l'intrant Production du mandat)"

# ============================================================
# FIXTURES — restaurants/commandes pour les tests AVANT et APRÈS.
# ============================================================
log "=== Fixtures (Restaurant A + Restaurant B) ==="
OWNER_UID_A="50000000-0000-0000-0000-000000000001"
psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into auth.users (id, email) values ('$OWNER_UID_A', 'owner@orders-hardening-fixture-a.test');
insert into restaurants (name, slug, status) values
  ('Orders Hardening Fixture A', 'orders-hardening-fixture-a', 'active'),
  ('Orders Hardening Fixture B', 'orders-hardening-fixture-b', 'active');
SQL
RID_A="$(sql "select id from restaurants where slug='orders-hardening-fixture-a';")"
RID_B="$(sql "select id from restaurants where slug='orders-hardening-fixture-b';")"
psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into restaurant_users (restaurant_id, user_id, role) values ('$RID_A','$OWNER_UID_A','owner');" >/dev/null
ORDER_A="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_A', 1, 'pickup', 12.50, 12.50, 'EUR') returning id;")"
ORDER_B="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_B', 1, 'pickup', 30.00, 30.00, 'EUR') returning id;")"
TOKEN_A="$(sql "select public_token from orders where id='$ORDER_A';")"

# ============================================================
# 2. ÉTAT "AVANT" — VÉRIFICATION COMPORTEMENTALE (pas seulement
# catalogue, mandat section 15).
# ============================================================
log "=== [2] ÉTAT AVANT — comportemental ==="
RC_SERVICE_BEFORE="$(as_service_rc "select id from orders where id='$ORDER_A';")"
assert_behav_eq "2a. AVANT : service_role peut SELECT directement orders (RC=0, simulation de l'intrant Production)" "0" "$RC_SERVICE_BEFORE"
RC_AUTH_A_OWN_BEFORE="$(as_user_rc "$OWNER_UID_A" "select id from orders where id='$ORDER_A';")"
assert_behav_eq "2b. AVANT : authenticated (membre de A) peut SELECT sa propre commande A" "0" "$RC_AUTH_A_OWN_BEFORE"
AUTH_B_VISIBLE_BEFORE="$(as_user "$OWNER_UID_A" "select count(*) from orders where id='$ORDER_B';")"
assert_behav_eq "2c. AVANT : authenticated (membre de A, PAS de B) ne voit PAS la commande B (RLS déjà effective avant durcissement)" "0" "$AUTH_B_VISIBLE_BEFORE"
assert_struct_eq "2d. AVANT : has_table_privilege(service_role,'SELECT') = true (catalogue, confirme la simulation)" "t" "$(sql "select has_table_privilege('service_role','orders','SELECT');")"
ANON_TABLE_GRANT_BEFORE="$(sql "select has_table_privilege('anon','orders','SELECT');")"

# ============================================================
# 3. APPLICATION DE LA MIGRATION DE DURCISSEMENT (LOT SOUS TEST).
# ============================================================
log "=== [3] Application de DRAFT-lot-orders-service-role-select-hardening.sql ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_HARDENING_SQL" >/dev/null
struct "DRAFT-lot-orders-service-role-select-hardening.sql appliqué sans erreur (LOT SOUS TEST)"

# ============================================================
# 4. ÉTAT "APRÈS" — CATALOGUE.
# ============================================================
log "=== [4] ÉTAT APRÈS — catalogue ==="
assert_struct_eq "4a. APRÈS : has_table_privilege(service_role,'SELECT') = false (postcondition non-négociable, mandat section 4)" "f" "$(sql "select has_table_privilege('service_role','orders','SELECT');")"
assert_struct_eq "4b. APRÈS : has_table_privilege(authenticated,'SELECT') = true (INCHANGÉ)" "t" "$(sql "select has_table_privilege('authenticated','orders','SELECT');")"
ANON_TABLE_GRANT_AFTER="$(sql "select has_table_privilege('anon','orders','SELECT');")"
assert_struct_eq "4c. APRÈS : has_table_privilege(anon,'SELECT') sur orders INCHANGÉ par rapport à AVANT durcissement (cette migration ne mentionne jamais anon ; l'éventuel grant de table posé par le bootstrap du harnais de test -- reflet du comportement Supabase réel où RLS, pas l'absence de grant, est la protection réelle pour anon -- n'est ni ajouté ni retiré ici, et l'accès réel d'anon reste filtré à zéro ligne par RLS, vérifié comportementalement en 6d)" "$ANON_TABLE_GRANT_BEFORE" "$ANON_TABLE_GRANT_AFTER"
assert_struct_eq "4d. APRÈS : AUCUN grant résiduel à PUBLIC sur orders (INCHANGÉ)" "0" "$(sql "select count(*) from information_schema.role_table_grants where table_schema='public' and table_name='orders' and grantee='PUBLIC' and privilege_type='SELECT';")"
assert_struct_eq "4e. APRÈS : propriétaire de la table INCHANGÉ (postgres)" "postgres" "$(sql "select tableowner from pg_tables where schemaname='public' and tablename='orders';")"
assert_struct_eq "4f. APRÈS : RLS toujours active (INCHANGÉE)" "t" "$(sql "select relrowsecurity from pg_class where relname='orders' and relnamespace='public'::regnamespace;")"
assert_struct_eq "4g. APRÈS : policy 'merchant reads restaurant orders' toujours présente, INCHANGÉE" "1" "$(sql "select count(*) from pg_policies where schemaname='public' and tablename='orders' and policyname='merchant reads restaurant orders';")"
assert_struct_eq "4h. APRÈS : la définition de la policy (membership via restaurant_users/auth.uid()) est INCHANGÉE" "1" "$(sql "select count(*) from pg_policies where schemaname='public' and tablename='orders' and policyname='merchant reads restaurant orders' and qual ilike '%restaurant_users%' and qual ilike '%auth.uid%';")"
assert_struct_eq "4i. APRÈS : service_role conserve BYPASSRLS=true (attribut de rôle non touché par ce lot, seul le privilège de TABLE a changé)" "t" "$(sql "select rolbypassrls from pg_roles where rolname='service_role';")"

# ============================================================
# 5. ÉTAT "APRÈS" — COMPORTEMENTAL (mandat section 15, "This must be a
# behavioral test, not only catalog introspection").
# ============================================================
log "=== [5] ÉTAT APRÈS — comportemental ==="
RC_SERVICE_AFTER="$(as_service_rc "select id from orders where id='$ORDER_A';")"
assert_behav_eq "5a. APRÈS : service_role NE PEUT PLUS SELECT directement orders (permission denied, RC != 0)" "1" "$([ "$RC_SERVICE_AFTER" != "0" ] && echo 1 || echo 0)"
ERR_SERVICE_AFTER="$(as_service "select id from orders where id='$ORDER_A';" 2>&1 || true)"
assert_behav_eq "5b. APRÈS : le message de refus mentionne bien 'permission denied' (refus de privilège, pas un autre type d'erreur)" "1" "$(echo "$ERR_SERVICE_AFTER" | grep -ci 'permission denied' || true)"

RC_AUTH_A_OWN_AFTER="$(as_user_rc "$OWNER_UID_A" "select id from orders where id='$ORDER_A';")"
assert_behav_eq "6a. APRÈS : authenticated (membre de A) peut TOUJOURS SELECT sa propre commande A (Dashboard non affecté)" "0" "$RC_AUTH_A_OWN_AFTER"
AUTH_B_VISIBLE_AFTER="$(as_user "$OWNER_UID_A" "select count(*) from orders where id='$ORDER_B';")"
assert_behav_eq "6b. APRÈS : authenticated (membre de A) ne voit TOUJOURS PAS la commande B (isolation RLS inchangée)" "0" "$AUTH_B_VISIBLE_AFTER"
OWNER_UID_B="60000000-0000-0000-0000-000000000001"
psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into auth.users (id, email) values ('$OWNER_UID_B', 'owner@orders-hardening-fixture-b.test');
insert into restaurant_users (restaurant_id, user_id, role) values ('$RID_B','$OWNER_UID_B','owner');
SQL
RC_AUTH_B_OWN_AFTER="$(as_user_rc "$OWNER_UID_B" "select id from orders where id='$ORDER_B';")"
assert_behav_eq "6c. APRÈS : authenticated (membre de B) peut SELECT sa propre commande B (preuve bidirectionnelle, isolation tenant toujours effective)" "0" "$RC_AUTH_B_OWN_AFTER"

ANON_VISIBLE_AFTER="$(PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "select count(*) from orders where id='$ORDER_A';" 2>/dev/null || echo "ERR")"
assert_behav_eq "6d. APRÈS : anon ne voit toujours aucune ligne d'orders (RLS, inchangé)" "0" "$ANON_VISIBLE_AFTER"

# ============================================================
# 6. NON-RÉGRESSION RPC SECURITY DEFINER (mandat section 8/17 --
# appels RÉELS, service_role appelant, APRÈS que son SELECT direct a
# été révoqué).
# ============================================================
log "=== [6] NON-RÉGRESSION RPC SECURITY DEFINER (service_role, SELECT direct révoqué) ==="
OUT_STATUS_ANON="$(PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "select payment_status from public.get_order_payment_status('$ORDER_A','$TOKEN_A');")"
assert_behav_eq "7a. get_order_payment_status (anon) toujours fonctionnelle après durcissement" "not_required" "$OUT_STATUS_ANON"

RC_WHATSAPP_AFTER="$(PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "select public.mark_whatsapp_opened('$ORDER_A','$TOKEN_A');" >/tmp/scanym-oh-out-$$.txt 2>/tmp/scanym-oh-err-$$.txt; echo $?)"
assert_behav_eq "7b. mark_whatsapp_opened (anon) toujours fonctionnelle après durcissement" "0" "$RC_WHATSAPP_AFTER"
WHATSAPP_FLAG="$(sql "select whatsapp_opened from orders where id='$ORDER_A';")"
assert_behav_eq "7c. mark_whatsapp_opened a bien produit son effet (whatsapp_opened=true), preuve d'une vraie mutation réussie malgré le SECURITY DEFINER" "t" "$WHATSAPP_FLAG"

RC_INITIATE_AFTER="$(as_service_rc "select * from public.initiate_payment_attempt('$ORDER_A','monetico','oh-nonreg-ref');")"
assert_behav_eq "7d. initiate_payment_attempt (service_role) toujours fonctionnelle après durcissement -- SECURITY DEFINER inchangé par le retrait du SELECT direct de l'appelant" "0" "$RC_INITIATE_AFTER"
ORDER_A_STATUS_AFTER_INIT="$(sql "select payment_status from orders where id='$ORDER_A';")"
assert_behav_eq "7e. initiate_payment_attempt a bien produit son effet attendu (payment_status='pending')" "pending" "$ORDER_A_STATUS_AFTER_INIT"

RC_CORRELATION_AFTER="$(as_service_rc "select * from public.get_payment_transaction_correlation('monetico','oh-nonreg-ref');")"
assert_behav_eq "7f. get_payment_transaction_correlation (service_role) toujours fonctionnelle après durcissement" "0" "$RC_CORRELATION_AFTER"

psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into payment_provider_configs (restaurant_id, provider_code, is_enabled, configuration_status) values ('$RID_B','monetico', true, 'not_configured');" >/dev/null
RC_RUNTIME_CONFIG_AFTER="$(as_service_rc "select * from public.get_payment_runtime_provider_config('$RID_B','monetico');")"
assert_behav_eq "7g. get_payment_runtime_provider_config (service_role) toujours fonctionnelle après durcissement" "0" "$RC_RUNTIME_CONFIG_AFTER"

# ============================================================
# 7. COMPATIBILITÉ P3-B2 (mandat section 18 -- candidat NON publié,
# appliqué ICI UNIQUEMENT pour prouver la compatibilité, jamais dans la
# migration de durcissement elle-même).
# ============================================================
log "=== [7] COMPATIBILITÉ CANDIDAT P3-B2 (test/harnais uniquement) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_P3B2_CANDIDATE_SQL" >/dev/null
struct "candidat P3-B2 (fixture de test, contenu identique au paquet déjà audité) appliqué sans erreur, APRÈS le durcissement"

RC_P3B2_CANDIDATE="$(as_service_rc "select * from public.get_order_payment_context('$ORDER_A','$TOKEN_A');")"
assert_behav_eq "8a. get_order_payment_context (candidat P3-B2, service_role) réussit malgré le SELECT direct révoqué" "0" "$RC_P3B2_CANDIDATE"
OUT_P3B2_CANDIDATE="$(as_service "select restaurant_id, payment_status from public.get_order_payment_context('$ORDER_A','$TOKEN_A');")"
assert_behav_eq "8b. get_order_payment_context renvoie EXACTEMENT restaurant_id=A, payment_status='pending' (cohérent avec 7e)" "${RID_A}|pending" "$OUT_P3B2_CANDIDATE"
RC_SERVICE_STILL_DENIED="$(as_service_rc "select id from orders where id='$ORDER_A';")"
assert_behav_eq "8c. service_role reste refusé en SELECT direct même après application du candidat P3-B2 (le candidat n'a lui-même ajouté aucun grant de table, confirmé)" "1" "$([ "$RC_SERVICE_STILL_DENIED" != "0" ] && echo 1 || echo 0)"

# ============================================================
# 8. IDEMPOTENCE (mandat section 11).
# ============================================================
log "=== [8] IDEMPOTENCE ==="
RC_REAPPLY="$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_HARDENING_SQL" >/tmp/scanym-oh-reapply-$$.txt 2>&1; echo $?)"
assert_behav_eq "9a. ré-application de la migration sur une base où service_role n'a déjà plus SELECT : AUCUNE erreur (RC=0, REVOKE intrinsèquement idempotent)" "0" "$RC_REAPPLY"
assert_struct_eq "9b. après ré-application : has_table_privilege(service_role,'SELECT') toujours false" "f" "$(sql "select has_table_privilege('service_role','orders','SELECT');")"
assert_struct_eq "9c. après ré-application : authenticated toujours inchangé (SELECT=true)" "t" "$(sql "select has_table_privilege('authenticated','orders','SELECT');")"
rm -f /tmp/scanym-oh-reapply-$$.txt

# ============================================================
# 9. STRUCTURE DU FICHIER DE MIGRATION LUI-MÊME (mandat section 23 --
# preuve directe sur le texte du fichier, pas seulement sur l'état
# final de la base).
# ============================================================
log "=== [9] STRUCTURE DU FICHIER DE MIGRATION ==="
HARDENING_SQL_BODY="$(cat "$DRAFT_HARDENING_SQL")"
assert_struct_eq "10a. exactement une instruction REVOKE SELECT sur public.orders" "1" "$(echo "$HARDENING_SQL_BODY" | grep -ci '^revoke select on table public\.orders from service_role;$')"
assert_struct_eq "10b. AUCUNE instruction GRANT dans le fichier" "0" "$(echo "$HARDENING_SQL_BODY" | grep -Ei '^\s*grant\b' | grep -vc '^--' || true)"
assert_struct_eq "10c. AUCUNE instruction CREATE POLICY / ALTER POLICY / DROP POLICY" "0" "$(echo "$HARDENING_SQL_BODY" | grep -ci 'create policy\|alter policy\|drop policy' || true)"
assert_struct_eq "10d. AUCUNE instruction CREATE TABLE / ALTER TABLE ... ADD/DROP COLUMN" "0" "$(echo "$HARDENING_SQL_BODY" | grep -ci 'create table\|add column\|drop column' || true)"
assert_struct_eq "10e. AUCUNE instruction CREATE TRIGGER" "0" "$(echo "$HARDENING_SQL_BODY" | grep -ci 'create trigger' || true)"
assert_struct_eq "10f. AUCUNE instruction CREATE FUNCTION / CREATE OR REPLACE FUNCTION" "0" "$(echo "$HARDENING_SQL_BODY" | grep -ci 'create function\|create or replace function' || true)"
assert_struct_eq "10g. AUCUNE instruction ALTER DEFAULT PRIVILEGES EXÉCUTABLE (une mention en commentaire expliquant ce choix est attendue et ne compte pas)" "0" "$(echo "$HARDENING_SQL_BODY" | grep -v '^--' | grep -ci 'alter default privileges' || true)"
ACL_LINES="$(echo "$HARDENING_SQL_BODY" | grep -Ei '^\s*(revoke|grant)\b')"
ACL_LINES_COUNT="$(echo "$ACL_LINES" | grep -c . || true)"
ACL_LINES_NOT_ORDERS="$(echo "$ACL_LINES" | grep -civ 'public\.orders' || true)"
assert_struct_eq "10h. exactement une seule ligne ACL (revoke/grant) dans tout le fichier" "1" "$ACL_LINES_COUNT"
assert_struct_eq "10i. cette seule ligne ACL nomme bien public.orders, aucune autre table" "0" "$ACL_LINES_NOT_ORDERS"

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
