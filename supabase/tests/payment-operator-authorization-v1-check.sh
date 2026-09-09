#!/usr/bin/env bash
# ============================================================
# Scanym — OPERATOR DASHBOARD — PAYMENT OPERATOR AUTHORIZATION v1
# Harnais SQL réel (PostgreSQL réel, aucune simulation), même
# convention que catalogue-operator-authorization-v1-check.sh et
# payment-p2b-a-safe-merchant-read-check.sh : construit la chaîne de
# migrations RÉELLES jusqu'au baseline requis
# 2af60c890ff146fafb94b7911fa3367eef0c774c (main), applique
# DRAFT-lot-payment-operator-authorization-v1.sql et prouve chaque
# item de la matrice de test obligatoire du mandat.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/payment-operator-authorization-v1-check.sh"
# ============================================================

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_A_SQL="$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-model.sql"
DRAFT_B_SQL="$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-lot-b-rpc.sql"
DRAFT_SADFP_SQL="$SUPABASE_DIR/DRAFT-lot-server-delivery-fulfillment-pricing.sql"
DRAFT_MERCHANT_PRICING_SQL="$SUPABASE_DIR/DRAFT-lot-merchant-delivery-pricing.sql"
DRAFT_PAYMENT_P1_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p1-foundation.sql"
DRAFT_PAYMENT_P2A_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p2a-secure-config.sql"
DRAFT_PAYMENT_P2BA_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p2b-a-safe-merchant-read.sql"
DRAFT_PAYOP_SQL="$SUPABASE_DIR/DRAFT-lot-payment-operator-authorization-v1.sql"
DB="scanym_payop_v1_$$"
DB_DBL="scanym_payop_v1_dbl_$$"

PASS=0
FAIL=0
FAIL_LOG="/tmp/scanym-payop-fails-$$.log"
: > "$FAIL_LOG"

log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS=$((PASS+1)); log "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); printf '%s\n' "$1" >> "$FAIL_LOG"; log "FAIL: $1"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_DBL\";" >/dev/null 2>&1 || true
  psql -c "drop role if exists payop_locked_owner;" >/dev/null 2>&1 || true
  rm -f "$FAIL_LOG" 2>/dev/null || true
}
trap cleanup EXIT

sql() { psql -X -A -q -t -d "$DB" -c "$1" 2>/tmp/scanym-payop-err-$$.txt; }
sql_rc() { psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-payop-out-$$.txt 2>/tmp/scanym-payop-err-$$.txt; echo $?; }
sql_err() { cat /tmp/scanym-payop-err-$$.txt 2>/dev/null; }

as_authenticated() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    2>/tmp/scanym-payop-err-$$.txt
}
as_authenticated_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    >/tmp/scanym-payop-out-$$.txt 2>/tmp/scanym-payop-err-$$.txt
  echo $?
}
as_anon_rc() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-payop-out-$$.txt 2>/tmp/scanym-payop-err-$$.txt
  echo $?
}
as_role_rc() {
  PGOPTIONS="-c role=$1" psql -X -A -q -t -d "$DB" -c "$2" >/tmp/scanym-payop-out-$$.txt 2>/tmp/scanym-payop-err-$$.txt
  echo $?
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_ok() {
  if [ "$2" -eq 0 ]; then pass "$1 (rc=0)"; else fail "$1 — attendu rc=0, obtenu rc=$2 : $(sql_err)"; fi
}
assert_denied() {
  if [ "$2" -ne 0 ]; then pass "$1 (rc=$2, refusé comme attendu)"; else fail "$1 — attendu un refus (rc!=0), obtenu rc=0"; fi
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
    psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1 || { log "FATAL: échec application $f"; return 1; }
    psql -d "$dbname" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  done
  for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql; do
    psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1 || { log "FATAL: échec application $f"; return 1; }
  done
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-illico-v2.sql" >/dev/null 2>&1
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-sanaa.sql" >/dev/null 2>&1
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-sirocco-demo.sql" >/dev/null 2>&1
  psql -d "$dbname" -c "update restaurants set status='active';" >/dev/null 2>&1
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" >/dev/null 2>&1 || return 1
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v83-lot2a4-privilege-hardening.sql" >/dev/null 2>&1 || return 1
  psql -d "$dbname" -c "alter default privileges in schema public grant execute on functions to service_role;" >/dev/null 2>&1
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v84-lot2b1-delivery-info-rpc.sql" >/dev/null 2>&1 || return 1
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_A_SQL" >/dev/null 2>&1 || return 1
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_B_SQL" >/dev/null 2>&1 || return 1
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_SADFP_SQL" >/dev/null 2>&1 || return 1
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_MERCHANT_PRICING_SQL" >/dev/null 2>&1 || return 1
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P1_SQL" >/dev/null 2>&1 || return 1
  return 0
}

build_mock_vault() {
  local dbname="$1"
  psql -d "$dbname" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create schema vault;
create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  secret text not null, name text, description text, key_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create function vault.create_secret(new_secret text, new_name text, new_description text, new_key_id uuid default null)
returns uuid language plpgsql as $fn$
declare v_id uuid;
begin
  insert into vault.secrets (secret, name, description, key_id) values (new_secret, new_name, new_description, new_key_id) returning id into v_id;
  return v_id;
end; $fn$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null)
returns void language plpgsql as $fn$
begin
  update vault.secrets set secret = coalesce(new_secret, secret), name = coalesce(new_name, name), description = coalesce(new_description, description), key_id = coalesce(new_key_id, key_id), updated_at = now() where id = secret_id;
end; $fn$;
create view vault.decrypted_secrets as select id, secret as decrypted_secret, name, description, key_id, created_at, updated_at from vault.secrets;
SQL
}

# ============================================================
# 0. BASELINE — chaîne réelle jusqu'à P1 + P2A + P2B-A (publiées),
#    puis application du lot testé.
# ============================================================
log "=== [0] Construction $DB (chaîne réelle jusqu'au baseline, avant le lot testé) ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB" || { log "FATAL: createdb a échoué"; exit 1; }
build_common_bootstrap "$DB"
build_full_chain "$DB" || { log "FATAL: chaîne de migrations a échoué"; exit 1; }
build_mock_vault "$DB"
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2A_SQL" >/dev/null 2>&1 || { log "FATAL: P2A a échoué"; exit 1; }
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2BA_SQL" >/dev/null 2>&1 || { log "FATAL: P2B-A a échoué"; exit 1; }
pass "Chaîne complète appliquée jusqu'au prérequis (P1 + P2A + P2B-A, avant le lot testé)"

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYOP_SQL" >/tmp/scanym-payop-out-$$.txt 2>/tmp/scanym-payop-err-$$.txt; echo $?)
if [ "$RC" -eq 0 ]; then
  pass "Application propre de PAYMENT OPERATOR AUTHORIZATION v1 (garde préflight + post-commit satisfaites)"
else
  fail "Application du lot a échoué (rc=$RC) : $(sql_err)"
  cat "$FAIL_LOG"; exit 1
fi

log "=== [1] Fixtures ==="
# Trois établissements nommés d'après le champ réel (Au lait cru,
# Royal Hotel, Sanaa Cookies & Fondant) + un opérateur Scanym GLOBAL
# (aucune ligne restaurant_users, ni sur A ni sur B ni sur C).
RESTO_ALC="11111111-1111-1111-1111-111111111111"   # Au lait cru
RESTO_RH="22222222-2222-2222-2222-222222222222"    # Royal Hotel
RESTO_SAN="33333333-3333-3333-3333-333333333333"   # Sanaa
RESTO_INVALID="99999999-9999-9999-9999-999999999999" # n'existe pas

sql "insert into public.restaurants (id, slug, name, is_active, status, country) values
  ('$RESTO_ALC','au-lait-cru','Au lait cru', true, 'active', 'FR'),
  ('$RESTO_RH','royal-hotel','Royal Hotel', true, 'active', 'FR'),
  ('$RESTO_SAN','sanaa','Sanaa Cookies & Fondant', true, 'active', 'FR');" >/dev/null
sql "insert into public.restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number) values
  ('$RESTO_ALC','EUR',1,'+33600000001'),
  ('$RESTO_RH','EUR',1,'+33600000002'),
  ('$RESTO_SAN','EUR',1,'+33600000003');" >/dev/null
sql "insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner-alc@test.local'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','manager-alc@test.local'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','staff-alc@test.local'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd','unrelated@test.local'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','owner-rh@test.local'),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff','operator@test.local'),
  ('11111111-0000-0000-0000-000000000001','fake-operator-not-flagged@test.local');" >/dev/null
sql "insert into public.restaurant_users (restaurant_id, user_id, role) values
  ('$RESTO_ALC','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner'),
  ('$RESTO_ALC','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','manager'),
  ('$RESTO_ALC','cccccccc-cccc-cccc-cccc-cccccccccccc','staff'),
  ('$RESTO_RH','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','owner');" >/dev/null
# ffffffff = opérateur Scanym global : ligne scanym_operators,
# AUCUNE ligne restaurant_users (ni A ni B ni C) — cas mandat central.
sql "insert into public.scanym_operators (user_id) values ('ffffffff-ffff-ffff-ffff-ffffffffffff');" >/dev/null

# Configuration paiement de chaque établissement — distincte et
# reconnaissable (provider_code différent par tenant, pour prouver
# qu'aucune confusion n'est possible), + credentials_ref/secret Vault
# canari qui ne doit JAMAIS être renvoyé par le RPC.
# payment_provider_configs.credentials_ref porte un index unique
# partiel (PAY-P2A-04, where non nul) -- CHAQUE ligne doit référencer
# un secret Vault DISTINCT, jamais le même canari réutilisé pour
# plusieurs tenants.
CANARY_SECRET_ALC=$(sql "insert into vault.secrets (secret, name, description) values ('SYNTHETIC-PAYOP-SECRET-canary-alc', 'canary-alc', 'jamais lié à une configuration réelle') returning id;")
CANARY_SECRET_RH=$(sql "insert into vault.secrets (secret, name, description) values ('SYNTHETIC-PAYOP-SECRET-canary-rh', 'canary-rh', 'jamais lié à une configuration réelle') returning id;")
CANARY_SECRET_SAN=$(sql "insert into vault.secrets (secret, name, description) values ('SYNTHETIC-PAYOP-SECRET-canary-san', 'canary-san', 'jamais lié à une configuration réelle') returning id;")
sql "insert into public.payment_provider_configs (restaurant_id, provider_code, mode, status, configuration_status, is_enabled, credentials_ref, last_verified_at) values
  ('$RESTO_ALC','monetico','live','active','verified', true, '$CANARY_SECRET_ALC', now()),
  ('$RESTO_RH','monetico','test','pending_setup','configured', false, '$CANARY_SECRET_RH', null),
  ('$RESTO_SAN','stuart_pay','live','active','verified', true, '$CANARY_SECRET_SAN', now());" >/dev/null

UID_OWNER_ALC="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
UID_MANAGER_ALC="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
UID_STAFF_ALC="cccccccc-cccc-cccc-cccc-cccccccccccc"
UID_UNRELATED="dddddddd-dddd-dddd-dddd-dddddddddddd"
UID_OWNER_RH="eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"
UID_OPERATOR="ffffffff-ffff-ffff-ffff-ffffffffffff"
UID_FAKE_OPERATOR="11111111-0000-0000-0000-000000000001"

# ============================================================
# SECTION OPERATOR — matrice minimale du mandat
# ============================================================
log "=== [OPERATOR] Au lait cru / Royal Hotel / Sanaa + switch ==="

R=$(as_authenticated "$UID_OPERATOR" "select provider_code from get_merchant_payment_provider_config('$RESTO_ALC');")
assert_eq "Opérateur -> Au lait cru : provider_code correct (jamais Royal/Sanaa)" "monetico" "$R"

R=$(as_authenticated "$UID_OPERATOR" "select provider_code from get_merchant_payment_provider_config('$RESTO_RH');")
assert_eq "Opérateur -> Royal Hotel : provider_code correct" "monetico" "$R"
R=$(as_authenticated "$UID_OPERATOR" "select mode from get_merchant_payment_provider_config('$RESTO_RH');")
assert_eq "Opérateur -> Royal Hotel : mode correct (test, jamais live d'un autre tenant)" "test" "$R"

R=$(as_authenticated "$UID_OPERATOR" "select provider_code from get_merchant_payment_provider_config('$RESTO_SAN');")
assert_eq "Opérateur -> Sanaa : provider_code correct" "stuart_pay" "$R"

# Bascule séquentielle (même session logique, 3 appels successifs) —
# aucune rétention de la config du tenant précédent (chaque appel est
# une requête RPC indépendante, stateless côté SQL par construction :
# la preuve porte sur le fait qu'aucun des 3 résultats ne "fuit" vers
# le suivant).
R1=$(as_authenticated "$UID_OPERATOR" "select provider_code from get_merchant_payment_provider_config('$RESTO_ALC');")
R2=$(as_authenticated "$UID_OPERATOR" "select provider_code from get_merchant_payment_provider_config('$RESTO_RH');")
R3=$(as_authenticated "$UID_OPERATOR" "select provider_code from get_merchant_payment_provider_config('$RESTO_SAN');")
if [ "$R1" = "monetico" ] && [ "$R2" = "monetico" ] && [ "$R3" = "stuart_pay" ] && [ "$R2" != "$R1" -o "$(as_authenticated "$UID_OPERATOR" "select mode from get_merchant_payment_provider_config('$RESTO_RH');")" != "$(as_authenticated "$UID_OPERATOR" "select mode from get_merchant_payment_provider_config('$RESTO_ALC');")" ]; then
  pass "Opérateur : bascule Au lait cru -> Royal Hotel -> Sanaa sans fuite (mode Royal Hotel=test distinct de Au lait cru=live)"
else
  fail "Opérateur : bascule séquentielle a produit une confusion entre tenants"
fi

# ============================================================
# SECTION AUTHORIZATION
# ============================================================
log "=== [AUTHORIZATION] ==="

RC=$(as_authenticated_rc "$UID_OPERATOR" "select * from get_merchant_payment_provider_config('$RESTO_ALC');")
assert_ok "Opérateur autorisé, cible Au lait cru -> ALLOWED" "$RC"

RC=$(as_authenticated_rc "$UID_UNRELATED" "select * from get_merchant_payment_provider_config('$RESTO_ALC');")
assert_denied "Non-opérateur, non-membre, cible Au lait cru -> DENIED (arbitrary r ne crée aucune autorisation)" "$RC"

RC=$(as_authenticated_rc "$UID_UNRELATED" "select * from get_merchant_payment_provider_config('$RESTO_INVALID');")
assert_denied "Restaurant invalide (n'existe pas) -> FAIL-CLOSED, jamais un contenu d'un autre tenant" "$RC"

# Opérateur AUTHENTIQUE mais cible un restaurant qui n'existe pas :
# passe le contrôle d'autorisation (is_scanym_operator() ne dépend
# pas de p_restaurant_id) mais la requête renvoie STRUCTURELLEMENT 0
# ligne — jamais une erreur différente, jamais un contenu d'un autre
# tenant (voir commentaire dédié dans le SQL, section 1).
RC=$(as_authenticated_rc "$UID_OPERATOR" "select * from get_merchant_payment_provider_config('$RESTO_INVALID');")
assert_ok "Opérateur authentique, restaurant inexistant -> appel ACCEPTÉ (pas d'erreur d'autorisation)" "$RC"
CNT=$(as_authenticated "$UID_OPERATOR" "select count(*) from get_merchant_payment_provider_config('$RESTO_INVALID');")
assert_eq "Opérateur authentique, restaurant inexistant -> 0 ligne renvoyée (jamais un contenu d'un autre tenant)" "0" "$CNT"

RC=$(as_authenticated_rc "$UID_FAKE_OPERATOR" "select * from get_merchant_payment_provider_config('$RESTO_ALC');")
assert_denied "Utilisateur authentifié SANS ligne scanym_operators (même nommé 'fake-operator') -> DENIED (aucune membership factice, aucun bypass par convention de nom)" "$RC"

RC=$(as_anon_rc "select * from get_merchant_payment_provider_config('$RESTO_ALC');")
assert_denied "Anonyme -> DENIED" "$RC"

# ============================================================
# SECTION MERCHANT — non-régression totale
# ============================================================
log "=== [MERCHANT] non-régression owner/manager/staff ==="

R=$(as_authenticated "$UID_OWNER_ALC" "select provider_code from get_merchant_payment_provider_config('$RESTO_ALC');")
assert_eq "Owner Au lait cru -> lecture PASS, comportement inchangé" "monetico" "$R"
R=$(as_authenticated "$UID_MANAGER_ALC" "select provider_code from get_merchant_payment_provider_config('$RESTO_ALC');")
assert_eq "Manager Au lait cru -> lecture PASS, comportement inchangé" "monetico" "$R"
R=$(as_authenticated "$UID_STAFF_ALC" "select provider_code from get_merchant_payment_provider_config('$RESTO_ALC');")
assert_eq "Staff Au lait cru -> lecture PASS, comportement inchangé (contrat P2B-A : is_member_of sans filtre de rôle)" "monetico" "$R"

RC=$(as_authenticated_rc "$UID_OWNER_ALC" "select * from get_merchant_payment_provider_config('$RESTO_RH');")
assert_denied "Owner Au lait cru -> Royal Hotel (autre tenant, non-opérateur) -> DENIED" "$RC"
RC=$(as_authenticated_rc "$UID_OWNER_RH" "select * from get_merchant_payment_provider_config('$RESTO_ALC');")
assert_denied "Owner Royal Hotel -> Au lait cru (autre tenant) -> DENIED (cross-tenant read)" "$RC"

# ============================================================
# SECTION SECURITY
# ============================================================
log "=== [SECURITY] ==="

# Cross-tenant read : couvert ci-dessus (owner A -> B, owner B -> A) ;
# confirmation supplémentaire côté opérateur non-authentique.
RC=$(as_authenticated_rc "$UID_UNRELATED" "select * from get_merchant_payment_provider_config('$RESTO_RH');")
assert_denied "Cross-tenant read (non-membre, non-opérateur) -> DENIED" "$RC"

# Cross-tenant write : ce module reste STRUCTURELLEMENT READ-ONLY —
# aucune RPC de mutation n'existe pour payment_provider_configs (ce
# lot n'en ajoute aucune). La preuve est qu'AUCUN accès direct
# INSERT/UPDATE/DELETE n'existe sur la table pour authenticated/anon,
# et qu'aucune fonction publique de mutation ne référence cette
# table.
CNT=$(sql "select count(*) from information_schema.role_table_grants where table_schema='public' and table_name='payment_provider_configs' and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE','DELETE');")
assert_eq "Cross-tenant write : AUCUN grant INSERT/UPDATE/DELETE anon/authenticated sur payment_provider_configs (aucune écriture possible, opérateur ou marchand)" "0" "$CNT"
CNT=$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and has_function_privilege('authenticated', p.oid, 'EXECUTE') and pg_get_functiondef(p.oid) ilike '%insert into public.payment_provider_configs%';")
assert_eq "Cross-tenant write : AUCUNE fonction exécutable par authenticated ne fait INSERT dans payment_provider_configs" "0" "$CNT"
CNT=$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and has_function_privilege('authenticated', p.oid, 'EXECUTE') and pg_get_functiondef(p.oid) ilike '%update public.payment_provider_configs%';")
assert_eq "Cross-tenant write : AUCUNE fonction exécutable par authenticated ne fait UPDATE sur payment_provider_configs" "0" "$CNT"

# Secrets never returned : colonnes réellement renvoyées par le RPC,
# comportementalement (pas seulement structurellement) — le canari
# Vault et credentials_ref ne doivent JAMAIS apparaître.
COLS=$(as_authenticated "$UID_OPERATOR" "select string_agg(a.attname, ',') from pg_proc p join pg_namespace n on n.oid=p.pronamespace, unnest(p.proallargtypes) with ordinality as t(oid,ord) left join lateral (select attname from pg_attribute) a on false where false;")
# (sonde structurelle déjà couverte par le SQL lui-même — la preuve
# comportementale directe est plus simple : interroger la RPC et
# vérifier qu'aucune valeur renvoyée n'égale le secret canari.)
LEAK=$(as_authenticated "$UID_OPERATOR" "select count(*) from get_merchant_payment_provider_config('$RESTO_ALC') g where g::text ilike '%SYNTHETIC-PAYOP-SECRET-canary%' or g::text = '$CANARY_SECRET_ALC';")
assert_eq "Secret non exposé : le secret Vault canari n'apparaît DANS AUCUNE valeur renvoyée par le RPC (opérateur)" "0" "$LEAK"
LEAK2=$(as_authenticated "$UID_OWNER_ALC" "select count(*) from get_merchant_payment_provider_config('$RESTO_ALC') g where g::text ilike '%SYNTHETIC-PAYOP-SECRET-canary%' or g::text = '$CANARY_SECRET_ALC';")
assert_eq "Secret non exposé : idem côté marchand (non-régression)" "0" "$LEAK2"

# Preuve comportementale renforcée (même patron que PAY-P2B-A
# "locked owner") : le RPC réussit même exécuté sous un propriétaire
# SANS AUCUN privilège sur vault.secrets/vault.decrypted_secrets --
# preuve que le corps ne touche jamais Vault, même après l'ajout du
# bypass opérateur.
sql "drop role if exists payop_locked_owner;" >/dev/null 2>&1
sql "create role payop_locked_owner nologin;" >/dev/null
sql "grant usage on schema public to payop_locked_owner;" >/dev/null
# auth.uid() est appelé en tout premier par le corps de la fonction --
# le schéma auth doit être USAGE (indépendamment de l'EXECUTE sur
# auth.uid() lui-même, déjà public par défaut), sinon l'appel échoue
# avec "permission denied for schema auth" AVANT même d'atteindre la
# logique métier -- ce ne serait pas un signal Vault/credentials_ref,
# juste un faux échec de la fixture de test elle-même (même piège
# documenté et déjà corrigé par le harnais PAY-P2B-A sibling).
sql "grant usage on schema auth to payop_locked_owner;" >/dev/null
sql "grant select on public.payment_provider_configs to payop_locked_owner;" >/dev/null
sql "grant execute on function public.is_member_of(uuid) to payop_locked_owner;" >/dev/null
sql "grant execute on function public.is_scanym_operator() to payop_locked_owner;" >/dev/null
sql "revoke all on table vault.secrets from payop_locked_owner;" >/dev/null 2>&1
sql "revoke all on table vault.decrypted_secrets from payop_locked_owner;" >/dev/null 2>&1
NEGCTRL_RC=$(as_role_rc "payop_locked_owner" "select secret from vault.secrets limit 1;")
assert_denied "[contrôle négatif] payop_locked_owner NE PEUT PAS lire vault.secrets directement (prouve que la restriction est réelle)" "$NEGCTRL_RC"
sql "alter function public.get_merchant_payment_provider_config(uuid) owner to payop_locked_owner;" >/dev/null
RC_RESTRICTED=$(as_authenticated_rc "$UID_OPERATOR" "select * from get_merchant_payment_provider_config('$RESTO_ALC');")
assert_ok "[VAULT ACCESS PROOF] le RPC RÉUSSIT (opérateur) même sous un propriétaire SANS AUCUN privilège Vault -- corps ne touche jamais Vault" "$RC_RESTRICTED"
sql "alter function public.get_merchant_payment_provider_config(uuid) owner to postgres;" >/dev/null
sql "drop role if exists payop_locked_owner;" >/dev/null 2>&1

# service_role absent from browser : contrôle structurel du code
# CLIENT (lib/services/dashboard.ts::getMerchantPaymentProviderConfig)
# — hors du périmètre de CE harnais SQL, prouvé séparément (voir
# SQL-AUTHORIZATION-EVIDENCE.md, "Lecture du chemin client").
CNT=$(sql "select count(*) from information_schema.role_routine_grants where routine_name='get_merchant_payment_provider_config' and grantee='service_role';")
if [ "$CNT" != "0" ]; then pass "service_role conserve EXECUTE côté serveur (attendu, canal Supabase interne — ne prouve rien côté navigateur, voir preuve applicative séparée) (=$CNT)"; else fail "service_role a perdu EXECUTE (régression inattendue, hors périmètre de ce lot)"; fi

# RLS toujours activée sur la table, sans policy (contrat P1
# inchangé) -- seul chemin de lecture = cette fonction SECURITY
# DEFINER.
RLS=$(sql "select relrowsecurity from pg_class where relname='payment_provider_configs';")
assert_eq "RLS toujours activée sur payment_provider_configs (contrat P1, inchangé)" "t" "$RLS"
POLCOUNT=$(sql "select count(*) from pg_policies where tablename='payment_provider_configs';")
assert_eq "Toujours AUCUNE policy sur payment_provider_configs (contrat P1, inchangé -- seul chemin = RPC SECURITY DEFINER)" "0" "$POLCOUNT"

# ============================================================
# SECTION SQL STRUCTURE — grants, signature, idempotence
# ============================================================
log "=== [SQL STRUCTURE] ==="

assert_eq "anon SANS EXECUTE sur get_merchant_payment_provider_config" "f" "$(sql "select has_function_privilege('anon','public.get_merchant_payment_provider_config(uuid)','EXECUTE');")"
assert_eq "authenticated AVEC EXECUTE sur get_merchant_payment_provider_config (inchangé)" "t" "$(sql "select has_function_privilege('authenticated','public.get_merchant_payment_provider_config(uuid)','EXECUTE');")"

DEF=$(sql "select pg_get_functiondef(oid) from pg_proc where proname='get_merchant_payment_provider_config';")
if echo "$DEF" | grep -q "is_scanym_operator"; then pass "Le corps référence is_scanym_operator (bypass opérateur présent)"; else fail "is_scanym_operator absent du corps après application"; fi
if echo "$DEF" | grep -q "is_member_of(p_restaurant_id)"; then pass "Le corps référence toujours is_member_of(p_restaurant_id) (condition marchande préservée)"; else fail "is_member_of(p_restaurant_id) absent -- régression marchande"; fi

# ============================================================
# DOUBLE-APPLICATION -- doit être refusée (idempotence/garde
# anti-double-application), dans une base SÉPARÉE (répétabilité
# 3x exigée par le mandat -- même patron que P2B-A).
# ============================================================
log "=== [IDEMPOTENCE] double-application refusée ==="
psql -c "drop database if exists \"$DB_DBL\";" >/dev/null 2>&1 || true
createdb "$DB_DBL"
build_common_bootstrap "$DB_DBL"
build_full_chain "$DB_DBL" >/dev/null 2>&1
build_mock_vault "$DB_DBL"
psql -d "$DB_DBL" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2A_SQL" >/dev/null 2>&1
psql -d "$DB_DBL" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2BA_SQL" >/dev/null 2>&1
psql -d "$DB_DBL" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYOP_SQL" >/dev/null 2>&1
RC1=$?
DBL_RC=$(psql -d "$DB_DBL" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYOP_SQL" >/tmp/scanym-payop-dbl-$$.txt 2>&1; echo $?)
if [ "$RC1" -eq 0 ] && [ "$DBL_RC" -ne 0 ] && grep -q "SCANYM_SCHEMA_DRIFT" /tmp/scanym-payop-dbl-$$.txt; then
  pass "Première application OK, seconde application refusée proprement (SCANYM_SCHEMA_DRIFT, garde anti-double-application)"
else
  fail "Comportement d'idempotence inattendu (rc1=$RC1, rc2=$DBL_RC)"
fi
rm -f /tmp/scanym-payop-dbl-$$.txt

# ============================================================
# CLEAN-DATABASE INSTALL TEST -- déjà prouvé par [0] ci-dessus
# (chaîne fraîche jusqu'au baseline + application propre du lot,
# aucune base pré-existante réutilisée) ; répété ici une 3e fois
# pour la répétabilité exigée par le mandat.
# ============================================================
log "=== [CLEAN INSTALL x3] ==="
for i in 1 2 3; do
  DBX="scanym_payop_clean_${i}_$$"
  psql -c "drop database if exists \"$DBX\";" >/dev/null 2>&1 || true
  createdb "$DBX"
  build_common_bootstrap "$DBX"
  build_full_chain "$DBX" >/dev/null 2>&1
  build_mock_vault "$DBX"
  psql -d "$DBX" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2A_SQL" >/dev/null 2>&1
  psql -d "$DBX" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2BA_SQL" >/dev/null 2>&1
  RCX=$(psql -d "$DBX" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYOP_SQL" >/dev/null 2>&1; echo $?)
  assert_ok "Installation propre sur base vierge, itération $i/3" "$RCX"
  psql -c "drop database if exists \"$DBX\";" >/dev/null 2>&1 || true
done

log "=== RÉSUMÉ ==="
log "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  log "--- échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
