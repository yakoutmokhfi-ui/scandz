#!/usr/bin/env bash
# ============================================================
# Scanym — PAYMENT FOUNDATION P1 v3 (CORRECTION ÉTROITE APRÈS AUDIT
# INDÉPENDANT DE LA v2) — Harnais reproductible pour
# supabase/DRAFT-lot-payment-p1-foundation.sql.
#
# Hérite intégralement de la v2 (findings PAY-P1-01 à 07, tous fermés
# et inchangés) et ajoute la vérification de la SEULE correction v3,
# PAY-P1-V2-01 (MEDIUM, audit indépendant) : orders.
# current_payment_transaction_id est désormais protégé par une FK
# COMPOSITE avec orders.id vers payment_transactions(id, order_id),
# pas seulement une FK à 1 colonne vers payment_transactions(id) --
# assertions 3b/3c (structurel) et 35b/35c/35d (reproduction directe
# de l'exploit démontré par l'audit indépendant, désormais rejeté).
#
# Couvre toujours explicitement :
#   - au plus UNE tentative ACTIVE par commande (PAY-P1-01)
#   - au plus UNE tentative PAYÉE par commande (PAY-P1-01)
#   - callback ancien ne peut jamais écraser une tentative plus
#     récente / courante (PAY-P1-02)
#   - le pointeur courant ne peut structurellement PAS référencer la
#     tentative d'une autre commande (PAY-P1-V2-01, CORRECTION v3)
#   - AUCUN grant DML direct à service_role (PAY-P1-03, RPC-only)
#   - normalisation provider_code/provider_reference (PAY-P1-04)
#   - CONCURRENCE RÉELLE (sessions psql concurrentes, pas de
#     simulation) sur l'initiation et sur la confirmation (PAY-P1-05)
#   - vérification de signature du helper, pas seulement du nom
#     (PAY-P1-06)
#   - décision explicite montant zéro / refund (PAY-P1-07)
#
# Baseline : chaîne réelle complète jusqu'à
# DRAFT-lot-merchant-delivery-pricing.sql (installée), PLUS deux
# tenants fictifs génériques construits ici.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/payment-p1-foundation-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_A_SQL="$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-model.sql"
DRAFT_B_SQL="$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-lot-b-rpc.sql"
DRAFT_SADFP_SQL="$SUPABASE_DIR/DRAFT-lot-server-delivery-fulfillment-pricing.sql"
DRAFT_MERCHANT_PRICING_SQL="$SUPABASE_DIR/DRAFT-lot-merchant-delivery-pricing.sql"
DRAFT_PAYMENT_P1_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p1-foundation.sql"
DB="scanym_payment_p1v2_$$"

PASS_COUNT=0
FAIL_COUNT=0
STRUCT_COUNT=0
BEHAV_COUNT=0
CONC_COUNT=0

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
FAIL_LOG="/tmp/scanym-payment-p1v2-fails-$$.log"
: > "$FAIL_LOG"
fail() {
  FAIL_COUNT=$((FAIL_COUNT+1))
  printf '%s\n' "$*" >> "$FAIL_LOG"
  log "FAIL: $*"
}
# Étiquettes de discipline de test (section 18 de la mission) :
# BEHAV = comportement observé via appel réel de RPC ; STRUCT =
# assertion structurelle (schéma/contrainte/index/grant, sans exécuter
# de logique métier) ; CONC = comportement observé via de VRAIES
# sessions concurrentes (pas une simulation séquentielle).
behav() { BEHAV_COUNT=$((BEHAV_COUNT+1)); pass "$@"; }
struct() { STRUCT_COUNT=$((STRUCT_COUNT+1)); pass "$@"; }
conc() { CONC_COUNT=$((CONC_COUNT+1)); pass "$@"; }

DB_DRIFT="scanym_payment_p1v2_drift_$$"
DB_NOHELPER="scanym_payment_p1v2_nohelper_$$"
TMPDIR_CONC="/tmp/scanym-payment-p1v2-conc-$$"
mkdir -p "$TMPDIR_CONC"
cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_NOHELPER\";" >/dev/null 2>&1 || true
  rm -f "${FAIL_LOG:-}" 2>/dev/null || true
  rm -rf "${TMPDIR_CONC:-}" 2>/dev/null || true
}
trap cleanup EXIT

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then pass "$desc"; else fail "$desc — '$needle' absent de : $haystack"; fi
}

sql() { psql -X -A -q -t -d "$DB" -c "$1"; }

# postgres superuser direct (bypasse GRANT, mais PAS RLS/CHECK/FK/UNIQUE
# -- exactement ce qu'il faut pour tester les contraintes structurelles
# indépendamment de qui a le droit d'écrire).
super_rc() {
  psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-p1v2-out-$$.txt 2>/tmp/scanym-p1v2-err-$$.txt
  echo $?
}

as_user_rc() {
  local uid="$1" query="$2"
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$uid'; $query" >/tmp/scanym-p1v2-out-$$.txt 2>/tmp/scanym-p1v2-err-$$.txt
  echo $?
}
as_user() {
  local uid="$1" query="$2"
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$uid'; $query" 2>&1
}
as_service() {
  local query="$1"
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$query" 2>&1
}
as_service_rc() {
  local query="$1"
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p1v2-out-$$.txt 2>/tmp/scanym-p1v2-err-$$.txt
  echo $?
}
as_anon_rc() {
  local query="$1"
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p1v2-out-$$.txt 2>/tmp/scanym-p1v2-err-$$.txt
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
  # Chaîne MINIMALE couvrant exactement les prérequis de
  # DRAFT-lot-payment-p1-foundation.sql (orders/restaurants/
  # is_member_of/has_role_in/touch_updated_at) -- SANS les lots
  # livraison/fulfillment (DRAFT_A/B/SADFP/merchant-pricing) qui sont
  # ce qui installe normalement scanym_numeric_is_non_finite. Sert
  # UNIQUEMENT à prouver le chemin "helper réellement absent avant ce
  # lot" (PAY-P1-06) -- on ne peut plus le prouver en DROPant le helper
  # d'une chaîne complète, celle-ci en a désormais des dépendants
  # (restaurant_sale_mode_fulfillments CHECK constraints).
  local dbname="$1"
  for f in schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql; do
    psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
    psql -d "$dbname" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  done
  for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql; do
    psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  done
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
}

# ============================================================
# 0. BASELINE
# ============================================================
log "=== [0] Construction baseline $DB (chaîne réelle complète, sans le lot testé) ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
build_common_bootstrap "$DB"
build_full_chain "$DB"
struct "chaîne réelle appliquée jusqu'à DRAFT-lot-merchant-delivery-pricing.sql (installé)"

log "=== [0] Application de DRAFT-lot-payment-p1-foundation.sql (v2 corrigée) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P1_SQL" >/dev/null
struct "DRAFT-lot-payment-p1-foundation.sql (v2) appliqué sans erreur"

# ============================================================
# FIXTURES GÉNÉRIQUES
# ============================================================
log "=== Fixtures génériques (Tenant Un + Tenant Deux) ==="
OWNER_UID="30000000-0000-0000-0000-000000000001"
MANAGER_UID="30000000-0000-0000-0000-000000000002"
STAFF_UID="30000000-0000-0000-0000-000000000003"
OTHER_OWNER_UID="40000000-0000-0000-0000-000000000001"

psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into auth.users (id, email) values
  ('$OWNER_UID', 'owner@payment-fixture-one.test'),
  ('$MANAGER_UID', 'manager@payment-fixture-one.test'),
  ('$STAFF_UID', 'staff@payment-fixture-one.test'),
  ('$OTHER_OWNER_UID', 'owner@payment-fixture-two.test');

with resto as (
  insert into restaurants (name, slug, status) values ('Payment Fixture Tenant One', 'payment-fixture-tenant-one', 'active') returning id
)
insert into restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number)
select id, 0, 'EUR', '+33600000300' from resto;

with resto2 as (
  insert into restaurants (name, slug, status) values ('Payment Fixture Tenant Two', 'payment-fixture-tenant-two', 'active') returning id
)
insert into restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number)
select id, 0, 'EUR', '+33600000400' from resto2;
SQL

RID_ONE="$(sql "select id from restaurants where slug='payment-fixture-tenant-one';")"
RID_TWO="$(sql "select id from restaurants where slug='payment-fixture-tenant-two';")"

psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into restaurant_users (restaurant_id, user_id, role) values
  ('$RID_ONE', '$OWNER_UID', 'owner'),
  ('$RID_ONE', '$MANAGER_UID', 'manager'),
  ('$RID_ONE', '$STAFF_UID', 'staff'),
  ('$RID_TWO', '$OTHER_OWNER_UID', 'owner');
SQL

ORDER_ONE="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 1, 'pickup', 25.00, 25.00, 'EUR') returning id;")"
ORDER_TWO="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_TWO', 1, 'pickup', 12.50, 12.50, 'EUR') returning id;")"
ORDER_RETRY="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 2, 'pickup', 30.00, 30.00, 'EUR') returning id;")"
ORDER_ZERO="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 3, 'pickup', 0.00, 0.00, 'EUR') returning id;")"
ORDER_CONC_INIT="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 4, 'pickup', 40.00, 40.00, 'EUR') returning id;")"
ORDER_CONC_CONFIRM="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 5, 'pickup', 50.00, 50.00, 'EUR') returning id;")"
struct "fixtures : 2 tenants, 4 utilisateurs, 6 commandes (25.00, 12.50, 30.00, 0.00, 40.00, 50.00 EUR)"

# ============================================================
# 1-6 : SCHÉMA
# ============================================================
log "=== [1-6] SCHÉMA ==="
struct_val() { struct "$1 (=$2)"; }
assert_struct_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then struct "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_behav_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then behav "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_conc_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then conc "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}

assert_struct_eq "1. orders.payment_status existe" "1" "$(sql "select count(*) from information_schema.columns where table_schema='public' and table_name='orders' and column_name='payment_status';")"
assert_struct_eq "2. orders.current_payment_transaction_id existe (nouveau, CORRECTION PAY-P1-02)" "1" "$(sql "select count(*) from information_schema.columns where table_schema='public' and table_name='orders' and column_name='current_payment_transaction_id';")"
assert_struct_eq "3. orders.current_payment_transaction_id est bien couvert par une FK vers payment_transactions" "1" "$(sql "select count(*) from pg_constraint where conrelid='public.orders'::regclass and contype='f' and pg_get_constraintdef(oid) ilike '%current_payment_transaction_id%' and pg_get_constraintdef(oid) ilike '%payment_transactions%';")"
assert_struct_eq "3b. (CORRECTION PAY-P1-V2-01) cette FK est COMPOSITE (2 colonnes), plus une simple FK à 1 colonne" "1" "$(sql "select count(*) from pg_constraint where conname='orders_current_payment_transaction_fk' and conrelid='public.orders'::regclass and contype='f' and array_length(conkey,1)=2;")"
assert_struct_eq "3c. (CORRECTION PAY-P1-V2-01) payment_transactions porte unique(id, order_id) (support de la FK composite ci-dessus)" "1" "$(sql "select count(*) from pg_constraint where conname='payment_transactions_id_order_id_unique' and conrelid='public.payment_transactions'::regclass and contype='u' and array_length(conkey,1)=2;")"
assert_struct_eq "4. 'refunded' RETIRÉ de orders.payment_status (décision section 15/PAY-P1-07)" "0" "$(sql "select count(*) from pg_constraint where conrelid='public.orders'::regclass and pg_get_constraintdef(oid) ilike '%payment_status%refunded%';")"
assert_struct_eq "5. payment_transactions existe" "1" "$(sql "select count(*) from information_schema.tables where table_schema='public' and table_name='payment_transactions';")"
assert_struct_eq "6. payment_transactions n'a AUCUNE colonne raw_notification" "0" "$(sql "select count(*) from information_schema.columns where table_schema='public' and table_name='payment_transactions' and column_name='raw_notification';")"
assert_struct_eq "7. 'refunded' RETIRÉ de payment_transactions.status" "0" "$(sql "select count(*) from pg_constraint where conrelid='public.payment_transactions'::regclass and pg_get_constraintdef(oid) ilike '%status%refunded%';")"
assert_struct_eq "8. payment_provider_configs existe, sans colonne credential/secret/api_key/vault" "0" "$(sql "select count(*) from information_schema.columns where table_schema='public' and table_name='payment_provider_configs' and column_name in ('credentials_ref','secret_key','api_key','vault_id','secret','password');")"

# CORRECTION section 17.M : assertions ROBUSTES via pg_index (au lieu
# de pg_get_constraintdef sur une simple UNIQUE constraint) --
# distingue explicitement un index unique PARTIEL (indpred IS NOT NULL)
# d'un index unique INCONDITIONNEL.
assert_struct_eq "9. index unique PARTIEL 'une seule tentative ACTIVE par commande' existe (indpred non nul)" "1" "$(sql "select count(*) from pg_index i join pg_class c on c.oid=i.indexrelid where c.relname='payment_transactions_one_active_per_order' and i.indisunique and i.indpred is not null;")"
assert_struct_eq "10. index unique PARTIEL 'une seule tentative PAYÉE par commande' existe (indpred non nul)" "1" "$(sql "select count(*) from pg_index i join pg_class c on c.oid=i.indexrelid where c.relname='payment_transactions_one_paid_per_order' and i.indisunique and i.indpred is not null;")"
assert_struct_eq "11. AUCUN index unique INCONDITIONNEL sur (order_id) seul (ne limiterait pas à N tentatives dans le temps)" "0" "$(sql "select count(*) from pg_index i join pg_class t on t.oid=i.indrelid join pg_class c on c.oid=i.indexrelid where t.relname='payment_transactions' and i.indisunique and i.indpred is null and pg_get_indexdef(i.indexrelid) ~* '\(order_id\)\$';")"
assert_struct_eq "12. FK COMPOSITE (order_id, restaurant_id) -> orders(id, restaurant_id) existe (CORRECTION PAY-P1-11)" "1" "$(sql "select count(*) from pg_constraint where conname='payment_transactions_order_restaurant_fk' and conrelid='public.payment_transactions'::regclass and array_length(conkey,1)=2;")"
assert_struct_eq "13. orders porte bien unique(id, restaurant_id) (support de la FK composite)" "1" "$(sql "select count(*) from pg_constraint where conname='orders_id_restaurant_id_unique' and conrelid='public.orders'::regclass and contype='u';")"
assert_struct_eq "14. provider_code CHECK jeu de caractères sûr existe (CORRECTION PAY-P1-04)" "1" "$(sql "select count(*) from pg_constraint where conrelid='public.payment_transactions'::regclass and contype='c' and pg_get_constraintdef(oid) ~ '\\^\\[a-zA-Z0-9_-\\]\\+\\\$';")"
assert_struct_eq "15. amount CHECK strictement positif (amount > 0, CORRECTION section 10 ZERO AMOUNT)" "1" "$(sql "select count(*) from pg_constraint where conrelid='public.payment_transactions'::regclass and contype='c' and pg_get_constraintdef(oid) = 'CHECK ((amount > (0)::numeric))';")"

# ============================================================
# 16-20 : AUTORITÉ RPC-ONLY (CORRECTION PAY-P1-03)
# ============================================================
log "=== [16-20] AUTORITÉ RPC-ONLY (PAY-P1-03) ==="
assert_struct_eq "16. service_role N'A PLUS AUCUN privilège direct sur payment_transactions (RPC-only, CORRECTION PAY-P1-03)" "0" "$(sql "select count(*) from information_schema.role_table_grants where table_name='payment_transactions' and grantee='service_role';")"
assert_struct_eq "17. authenticated conserve uniquement SELECT sur payment_transactions (lecture seule inchangée)" "SELECT" "$(sql "select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where table_name='payment_transactions' and grantee='authenticated';")"
assert_struct_eq "18. anon n'a AUCUN privilège sur payment_transactions" "0" "$(sql "select count(*) from information_schema.role_table_grants where table_name='payment_transactions' and grantee='anon';")"
assert_struct_eq "19. AUCUN rôle applicatif n'a de privilège sur payment_provider_configs (aucun back-office en P1)" "0" "$(sql "select count(*) from information_schema.role_table_grants where table_name='payment_provider_configs' and grantee in ('anon','authenticated','service_role');")"
assert_behav_eq "20. authenticated NE PEUT PAS exécuter initiate_payment_attempt" "1" "$([ "$(as_user_rc "$OWNER_UID" "select public.initiate_payment_attempt('$ORDER_ONE','fixture-provider','ref-x');")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "21. anon NE PEUT PAS exécuter initiate_payment_attempt" "1" "$([ "$(as_anon_rc "select public.initiate_payment_attempt('$ORDER_ONE','fixture-provider','ref-y');")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "22. authenticated NE PEUT PAS exécuter confirm_payment_attempt" "1" "$([ "$(as_user_rc "$OWNER_UID" "select public.confirm_payment_attempt('fixture-provider','ref-z','paid');")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "23. service_role NE PEUT PLUS insérer directement (DML retiré, CORRECTION PAY-P1-03)" "1" "$([ "$(as_service_rc "insert into payment_transactions (restaurant_id, order_id, provider_code, provider_reference, amount, currency) values ('$RID_ONE','$ORDER_ONE','fixture-provider','direct-insert-1',25.00,'EUR');")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "24. authenticated NE PEUT PAS SELECT sur payment_provider_configs" "1" "$([ "$(as_user_rc "$OWNER_UID" "select count(*) from payment_provider_configs;")" != "0" ] && echo 1 || echo 0)"

# ============================================================
# 25-30 : MONTANT/DEVISE SERVEUR-AUTORITAIRE + ZERO AMOUNT
# ============================================================
log "=== [25-30] MONTANT/DEVISE + ZERO AMOUNT (section 10) ==="
RES1="$(as_service "select transaction_id, amount, currency from public.initiate_payment_attempt('$ORDER_ONE','fixture-provider','ref-attempt-1');")"
AMT1="$(echo "$RES1" | awk -F'|' '{print $2}')"
CUR1="$(echo "$RES1" | awk -F'|' '{print $3}')"
assert_behav_eq "25. montant de la 1ère tentative = orders.total serveur (25.00), jamais un paramètre client" "25" "$(printf '%.0f' "$AMT1")"
assert_behav_eq "26. devise de la 1ère tentative = orders.currency serveur (EUR)" "EUR" "$CUR1"
assert_struct_eq "27. initiate_payment_attempt n'accepte AUCUN paramètre p_amount/p_currency/p_restaurant_id (signature fermée)" "0" "$(sql "select count(*) from pg_proc where proname='initiate_payment_attempt' and pg_get_function_arguments(oid) ilike '%amount%';")"
assert_behav_eq "28. CHECK rejette un montant NaN (superuser direct, teste la contrainte, pas le grant)" "1" "$([ "$(super_rc "insert into payment_transactions (restaurant_id, order_id, provider_code, provider_reference, amount, currency) values ('$RID_ONE','$ORDER_ONE','fixture-provider','ref-nan','NaN','EUR');")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "29. CHECK rejette un montant Infinity (superuser direct)" "1" "$([ "$(super_rc "insert into payment_transactions (restaurant_id, order_id, provider_code, provider_reference, amount, currency) values ('$RID_ONE','$ORDER_ONE','fixture-provider','ref-inf','Infinity','EUR');")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "30. CHECK rejette un montant ZÉRO (amount > 0 strict, superuser direct)" "1" "$([ "$(super_rc "insert into payment_transactions (restaurant_id, order_id, provider_code, provider_reference, amount, currency) values ('$RID_ONE','$ORDER_ONE','fixture-provider','ref-zero',0,'EUR');")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "31. initiate_payment_attempt REFUSE une commande de montant total = 0 (décision explicite section 10)" "1" "$([ "$(as_service_rc "select public.initiate_payment_attempt('$ORDER_ZERO','fixture-provider','ref-zero-order');")" != "0" ] && echo 1 || echo 0)"

# ============================================================
# 32-35 : ISOLATION TENANT (structurelle, FK composite)
# ============================================================
log "=== [32-35] ISOLATION TENANT STRUCTURELLE (section 11/17.K) ==="
assert_behav_eq "32. couple (order_id tenant one, restaurant_id tenant deux) REJETÉ même en accès direct superuser (FK composite)" "1" "$([ "$(super_rc "insert into payment_transactions (restaurant_id, order_id, provider_code, provider_reference, amount, currency) values ('$RID_TWO','$ORDER_ONE','fixture-provider','ref-mismatch',10,'EUR');")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "33. tentative légitime tenant one porte le restaurant_id RÉEL de la commande" "$RID_ONE" "$(sql "select restaurant_id::text from payment_transactions where order_id='$ORDER_ONE' and provider_reference='ref-attempt-1';")"
assert_behav_eq "34. owner tenant deux NE VOIT PAS les tentatives du tenant one (RLS cross-tenant)" "0" "$(as_user "$OTHER_OWNER_UID" "select count(*) from payment_transactions where order_id='$ORDER_ONE';")"
RES2="$(as_service "select transaction_id, amount, currency from public.initiate_payment_attempt('$ORDER_TWO','fixture-provider','ref-attempt-2');")"
assert_behav_eq "35. tentative tenant deux porte bien restaurant_id du tenant deux" "$RID_TWO" "$(sql "select restaurant_id::text from payment_transactions where order_id='$ORDER_TWO' and provider_reference='ref-attempt-2';")"

# CORRECTION PAY-P1-V2-01 (audit indépendant v2) : reproduction EXACTE
# de l'exploit démontré par l'audit -- pointer orders.current_payment_
# transaction_id d'une commande vers la tentative d'une AUTRE commande
# (autre tenant), en accès superutilisateur direct (le même niveau
# d'accès que le propriétaire des fonctions SECURITY DEFINER). Avant
# la correction v3, ceci était ACCEPTÉ sans erreur. Doit désormais
# être REJETÉ au niveau base par la FK composite.
TXN_ONE_ID="$(sql "select current_payment_transaction_id::text from orders where id='$ORDER_ONE';")"
TXN_TWO_ID="$(sql "select current_payment_transaction_id::text from orders where id='$ORDER_TWO';")"
assert_behav_eq "35b. (CORRECTION PAY-P1-V2-01) pointer orders.current_payment_transaction_id du tenant one vers la tentative du tenant deux est REJETÉ même en accès superuser direct (FK composite -- reproduction de l'exploit d'audit)" "1" "$([ "$(super_rc "update orders set current_payment_transaction_id='$TXN_TWO_ID' where id='$ORDER_ONE';")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "35c. (CORRECTION PAY-P1-V2-01) après la tentative rejetée, orders.current_payment_transaction_id du tenant one reste INCHANGÉ (sa propre tentative, pas celle du tenant deux)" "$TXN_ONE_ID" "$(sql "select current_payment_transaction_id::text from orders where id='$ORDER_ONE';")"
assert_behav_eq "35d. (CORRECTION PAY-P1-V2-01) pointer une commande vers SA PROPRE tentative reste ACCEPTÉ (non-régression)" "0" "$([ "$(super_rc "update orders set current_payment_transaction_id='$TXN_ONE_ID' where id='$ORDER_ONE';")" != "0" ] && echo 1 || echo 0)"

# ============================================================
# A. ONE ACTIVE ATTEMPT (mission 17.A)
# ============================================================
log "=== [A] ONE ACTIVE ATTEMPT (17.A) ==="
assert_behav_eq "36. (17.A.1) A pending existe déjà sur ORDER_ONE" "pending" "$(sql "select status from payment_transactions where order_id='$ORDER_ONE' and provider_reference='ref-attempt-1';")"
assert_behav_eq "37. (17.A.2/3) initiation B pendant que A est active -> REJETÉE" "1" "$([ "$(as_service_rc "select public.initiate_payment_attempt('$ORDER_ONE','fixture-provider','ref-attempt-1-B');")" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "38. une seule ligne 'pending' existe pour ORDER_ONE après le rejet ci-dessus" "1" "$(sql "select count(*) from payment_transactions where order_id='$ORDER_ONE' and status='pending';")"

# ============================================================
# B/C. RETRY APRÈS ÉCHEC / ANNULATION (mission 17.B/17.C)
# ============================================================
log "=== [B/C] RETRY APRÈS ÉCHEC / ANNULATION (17.B/17.C) ==="
as_service "select public.initiate_payment_attempt('$ORDER_RETRY','fixture-provider','ref-retry-A');" >/dev/null
as_service "select public.confirm_payment_attempt('fixture-provider','ref-retry-A','failed');" >/dev/null
assert_behav_eq "39. (17.B.4) tentative A du lot retry est bien 'failed'" "failed" "$(sql "select status from payment_transactions where order_id='$ORDER_RETRY' and provider_reference='ref-retry-A';")"
assert_behav_eq "40. (17.B.5/6) B peut être initiée après échec de A -- retry autorisé" "0" "$([ "$(as_service_rc "select public.initiate_payment_attempt('$ORDER_RETRY','fixture-provider','ref-retry-B');")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "41. B est bien 'pending' et devient current" "pending" "$(sql "select payment_status from orders where id='$ORDER_RETRY';")"
as_service "select public.confirm_payment_attempt('fixture-provider','ref-retry-B','cancelled');" >/dev/null
assert_behav_eq "42. (17.C.7) B annulée" "cancelled" "$(sql "select status from payment_transactions where order_id='$ORDER_RETRY' and provider_reference='ref-retry-B';")"
assert_behav_eq "43. (17.C.8) C peut être initiée après annulation de B -- retry autorisé" "0" "$([ "$(as_service_rc "select public.initiate_payment_attempt('$ORDER_RETRY','fixture-provider','ref-retry-C');")" != "0" ] && echo 1 || echo 0)"

# ============================================================
# D. DOUBLE PAID PREVENTION (mission 17.D)
# ============================================================
log "=== [D] DOUBLE PAID PREVENTION (17.D) ==="
as_service "select public.confirm_payment_attempt('fixture-provider','ref-retry-C','paid');" >/dev/null
assert_behav_eq "44. (17.D.10) C devient paid" "paid" "$(sql "select status from payment_transactions where order_id='$ORDER_RETRY' and provider_reference='ref-retry-C';")"
assert_behav_eq "45. (17.D.11) une confirmation 'paid' sur A (déjà failed, verrouillage terminal) est REFUSÉE" "1" "$([ "$(as_service_rc "select public.confirm_payment_attempt('fixture-provider','ref-retry-A','paid');")" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "46. (17.D.12) UNE SEULE ligne 'paid' existe pour ORDER_RETRY (index unique partiel + logique applicative concordent)" "1" "$(sql "select count(*) from payment_transactions where order_id='$ORDER_RETRY' and status='paid';")"

# ============================================================
# G. OLD CALLBACK PROTECTION (mission 17.G / section 6-7)
# ============================================================
log "=== [G] OLD CALLBACK PROTECTION (17.G) ==="
assert_behav_eq "47. après A failed puis B/C retry, orders.payment_status reflète C (paid), jamais A" "paid" "$(sql "select payment_status from orders where id='$ORDER_RETRY';")"
assert_behav_eq "48. orders.current_payment_transaction_id pointe bien vers C (la tentative payée), pas vers A" "1" "$(sql "select (o.current_payment_transaction_id = t.id)::int from orders o join payment_transactions t on t.order_id=o.id and t.provider_reference='ref-retry-C' where o.id='$ORDER_RETRY';")"
# Rejeu tardif de l'échec de A (déjà 'failed', même statut) : no-op
# idempotent, NE DOIT PAS toucher orders (qui est déjà 'paid' via C).
as_service "select public.confirm_payment_attempt('fixture-provider','ref-retry-A','failed');" >/dev/null
assert_behav_eq "49. (17.G) rejeu tardif de l'échec de A (même statut, no-op) NE TOUCHE PAS orders.payment_status (reste paid via C)" "paid" "$(sql "select payment_status from orders where id='$ORDER_RETRY';")"

# ============================================================
# H. CURRENT POINTER (mission 17.H)
# ============================================================
log "=== [H] CURRENT POINTER (17.H) ==="
assert_struct_eq "50. (17.H) current_payment_transaction_id positionné à l'initiation (déjà vérifié §48), jamais modifié par confirm_payment_attempt" "1" "$(sql "select count(*) from pg_proc where proname='confirm_payment_attempt' and prosrc not ilike '%set current_payment_transaction_id%';")"

# ============================================================
# I. TIMESTAMP IDEMPOTENCE (mission 17.I)
# ============================================================
log "=== [I] TIMESTAMP IDEMPOTENCE (17.I) ==="
PAID_AT_BEFORE="$(sql "select paid_at from payment_transactions where order_id='$ORDER_RETRY' and provider_reference='ref-retry-C';")"
as_service "select public.confirm_payment_attempt('fixture-provider','ref-retry-C','paid');" >/dev/null
PAID_AT_AFTER="$(sql "select paid_at from payment_transactions where order_id='$ORDER_RETRY' and provider_reference='ref-retry-C';")"
assert_behav_eq "51. (17.I) paid_at INCHANGÉ après rejeu idempotent de la même confirmation 'paid'" "$PAID_AT_BEFORE" "$PAID_AT_AFTER"

# ============================================================
# L. PROVIDER NORMALIZATION (mission 17.L / section 5)
# ============================================================
log "=== [L] PROVIDER NORMALIZATION (17.L) ==="
ORDER_NORM="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 6, 'pickup', 9.00, 9.00, 'EUR') returning id;")"
as_service "select public.initiate_payment_attempt('$ORDER_NORM',' fixture-provider ',' ref-norm-x ');" >/dev/null
assert_behav_eq "52. (17.L) provider_reference stocké TRIMÉ (' ref-norm-x ' -> 'ref-norm-x')" "ref-norm-x" "$(sql "select provider_reference from payment_transactions where order_id='$ORDER_NORM';")"
assert_behav_eq "53. (17.L) provider_code stocké TRIMÉ, CASSE PRÉSERVÉE (' fixture-provider ' -> 'fixture-provider', pas de mise en minuscule forcée)" "fixture-provider" "$(sql "select provider_code from payment_transactions where order_id='$ORDER_NORM';")"
ORDER_NORM2="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 7, 'pickup', 8.00, 8.00, 'EUR') returning id;")"
assert_behav_eq "54. (17.L) '  ref-norm-x  ' (espaces) NE PEUT PAS contourner l'unicité contre 'ref-norm-x' déjà stocké" "1" "$([ "$(as_service_rc "select public.initiate_payment_attempt('$ORDER_NORM2','fixture-provider','  ref-norm-x  ');")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "55. p_provider_code vide après trim est rejeté (pas seulement une chaîne vide brute)" "1" "$([ "$(as_service_rc "select public.initiate_payment_attempt('$ORDER_NORM2','   ','ref-whatever');")" != "0" ] && echo 1 || echo 0)"

# ============================================================
# HELPER (PAY-P1-06) — signature exacte + chemin "helper absent"
# ============================================================
log "=== HELPER scanym_numeric_is_non_finite — signature + chemin absent (PAY-P1-06) ==="
assert_struct_eq "56. helper a la signature exacte (1 arg numeric, retour boolean)" "1" "$(sql "select count(*) from pg_proc p join pg_type rt on rt.oid=p.prorettype where p.proname='scanym_numeric_is_non_finite' and rt.typname='bool' and p.pronargs=1 and (p.proargtypes::regtype[])[0]='numeric'::regtype;")"

log "=== [56b] Chemin HELPER ABSENT (chaîne minimale SANS les lots livraison qui l'installent d'ordinaire) ==="
psql -c "drop database if exists \"$DB_NOHELPER\";" >/dev/null 2>&1 || true
createdb "$DB_NOHELPER"
build_common_bootstrap "$DB_NOHELPER"
build_minimal_chain "$DB_NOHELPER"
HELPER_ABSENT_BEFORE="$(psql -X -A -t -q -d "$DB_NOHELPER" -c "select count(*) from pg_proc where proname='scanym_numeric_is_non_finite';")"
assert_struct_eq "56c. helper bien ABSENT avant application du lot payment (chaîne minimale, base de contrôle)" "0" "$HELPER_ABSENT_BEFORE"
psql -d "$DB_NOHELPER" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P1_SQL" >/dev/null
HELPER_PRESENT_AFTER="$(psql -X -A -t -q -d "$DB_NOHELPER" -c "select count(*) from pg_proc where proname='scanym_numeric_is_non_finite';")"
assert_struct_eq "57. (PAY-P1-06) helper CRÉÉ par ce lot quand absent, migration réussie" "1" "$HELPER_PRESENT_AFTER"
psql -d "$DB_NOHELPER" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into restaurants (name, slug) values ('Nohelper Fixture', 'nohelper-fixture');
insert into restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number)
select id, 0, 'EUR', '+33600000900' from restaurants where slug='nohelper-fixture';
SQL
RID_NOHELPER="$(psql -X -A -t -q -d "$DB_NOHELPER" -c "select id from restaurants where slug='nohelper-fixture';")"
OID_NOHELPER="$(psql -X -A -t -q -d "$DB_NOHELPER" -c "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_NOHELPER', 1, 'pickup', 5.00, 5.00, 'EUR') returning id;")"
NAN_REJECTED_NOHELPER="$([ "$(psql -X -A -q -t -d "$DB_NOHELPER" -c "insert into payment_transactions (restaurant_id, order_id, provider_code, provider_reference, amount, currency) values ('$RID_NOHELPER', '$OID_NOHELPER', 'fixture-provider', 'ref-nohelper-nan', 'NaN', 'EUR');" >/dev/null 2>&1; echo $?)" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "58. (PAY-P1-06) helper recréé est bien FONCTIONNEL -- rejette NaN après recréation" "1" "$NAN_REJECTED_NOHELPER"
psql -c "drop database if exists \"$DB_NOHELPER\";" >/dev/null 2>&1 || true

# ============================================================
# E/F. CONCURRENCE RÉELLE (mission 17.E / 17.F, PAY-P1-05)
# ============================================================
log "=== [E] CONCURRENT INITIATION — deux VRAIES sessions psql concurrentes sur la MÊME commande ==="
cat > "$TMPDIR_CONC/session1_init.sql" <<SQL
begin;
select transaction_id from public.initiate_payment_attempt('$ORDER_CONC_INIT','fixture-provider','conc-init-A');
select pg_sleep(1);
commit;
SQL
cat > "$TMPDIR_CONC/session2_init.sql" <<SQL
begin;
select transaction_id from public.initiate_payment_attempt('$ORDER_CONC_INIT','fixture-provider','conc-init-B');
commit;
SQL
( set +e; PGOPTIONS="-c role=service_role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -f "$TMPDIR_CONC/session1_init.sql" > "$TMPDIR_CONC/session1_init.out" 2>"$TMPDIR_CONC/session1_init.err"; echo $? > "$TMPDIR_CONC/session1_init.rc" ) &
sleep 0.3
( set +e; PGOPTIONS="-c role=service_role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -f "$TMPDIR_CONC/session2_init.sql" > "$TMPDIR_CONC/session2_init.out" 2>"$TMPDIR_CONC/session2_init.err"; echo $? > "$TMPDIR_CONC/session2_init.rc" ) &
wait
RC1="$(cat "$TMPDIR_CONC/session1_init.rc")"
RC2="$(cat "$TMPDIR_CONC/session2_init.rc")"
SUCCESS_COUNT_INIT=0
[ "$RC1" = "0" ] && SUCCESS_COUNT_INIT=$((SUCCESS_COUNT_INIT+1))
[ "$RC2" = "0" ] && SUCCESS_COUNT_INIT=$((SUCCESS_COUNT_INIT+1))
assert_conc_eq "59. (17.E) exactement UNE des deux initiations concurrentes réelles a réussi (session1 rc=$RC1, session2 rc=$RC2)" "1" "$SUCCESS_COUNT_INIT"
assert_struct_eq "60. (17.E) exactement UNE tentative active existe après la course concurrente réelle" "1" "$(sql "select count(*) from payment_transactions where order_id='$ORDER_CONC_INIT' and status='pending';")"

log "=== [F] CONCURRENT CONFIRMATION — tentative morte vs tentative courante, VRAIES sessions concurrentes ==="
as_service "select public.initiate_payment_attempt('$ORDER_CONC_CONFIRM','fixture-provider','conc-confirm-A');" >/dev/null
as_service "select public.confirm_payment_attempt('fixture-provider','conc-confirm-A','failed');" >/dev/null
as_service "select public.initiate_payment_attempt('$ORDER_CONC_CONFIRM','fixture-provider','conc-confirm-B');" >/dev/null
cat > "$TMPDIR_CONC/session1_confirm.sql" <<SQL
begin;
select transaction_id from public.confirm_payment_attempt('fixture-provider','conc-confirm-B','paid');
select pg_sleep(1);
commit;
SQL
cat > "$TMPDIR_CONC/session2_confirm.sql" <<SQL
begin;
select transaction_id from public.confirm_payment_attempt('fixture-provider','conc-confirm-A','paid');
commit;
SQL
( set +e; PGOPTIONS="-c role=service_role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -f "$TMPDIR_CONC/session1_confirm.sql" > "$TMPDIR_CONC/session1_confirm.out" 2>"$TMPDIR_CONC/session1_confirm.err"; echo $? > "$TMPDIR_CONC/session1_confirm.rc" ) &
sleep 0.3
( set +e; PGOPTIONS="-c role=service_role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -f "$TMPDIR_CONC/session2_confirm.sql" > "$TMPDIR_CONC/session2_confirm.out" 2>"$TMPDIR_CONC/session2_confirm.err"; echo $? > "$TMPDIR_CONC/session2_confirm.rc" ) &
wait
RC1C="$(cat "$TMPDIR_CONC/session1_confirm.rc")"
RC2C="$(cat "$TMPDIR_CONC/session2_confirm.rc")"
assert_conc_eq "61. (17.F) confirmation de la tentative COURANTE (B) sous course réelle réussit (rc)" "0" "$RC1C"
assert_conc_eq "62. (17.F) confirmation concurrente de la tentative MORTE/non-courante (A, déjà failed) sous course réelle est REJETÉE (verrouillage terminal)" "1" "$([ "$RC2C" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "63. (17.F) UNE SEULE ligne 'paid' existe pour cette commande après la course réelle" "1" "$(sql "select count(*) from payment_transactions where order_id='$ORDER_CONC_CONFIRM' and status='paid';")"
assert_behav_eq "64. (17.F) orders.payment_status = 'paid' (via B, jamais via A) après la course réelle" "paid" "$(sql "select payment_status from orders where id='$ORDER_CONC_CONFIRM';")"

# ============================================================
# COMPATIBILITÉ ASCENDANTE
# ============================================================
log "=== COMPATIBILITÉ ASCENDANTE ==="
assert_struct_eq "65. orders.status (cycle cuisine) CHECK toujours présent, ne mentionne pas payment" "1" "$(sql "select count(*) from pg_constraint where conrelid='public.orders'::regclass and contype='c' and pg_get_constraintdef(oid) ilike '%status%' and conname not ilike '%payment%' and pg_get_constraintdef(oid) not ilike '%payment%';")"
assert_behav_eq "66. transition orders.status (cuisine) fonctionnelle, indépendante de payment_status" "accepted" "$(sql "update orders set status='accepted' where id='$ORDER_ONE' returning status;")"
assert_behav_eq "67. cette transition n'a pas modifié payment_status" "pending" "$(sql "select payment_status from orders where id='$ORDER_ONE';")"
assert_struct_eq "68. create_order (RPC existant) toujours présent" "1" "$(sql "select count(*) from pg_proc where proname='create_order';")"
assert_struct_eq "69. is_member_of / has_role_in réutilisés tels quels" "1" "$(sql "select (select count(*) from pg_proc where proname='is_member_of')=1 and (select count(*) from pg_proc where proname='has_role_in')=1;" | sed 's/t/1/;s/f/0/')"

# ============================================================
# GARDES ANTI-DÉRIVE
# ============================================================
log "=== GARDES ANTI-DÉRIVE ==="
RC_DOUBLE_APPLY="$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P1_SQL" >/tmp/scanym-p1v2-out-$$.txt 2>/tmp/scanym-p1v2-err-$$.txt; echo $?)"
assert_behav_eq "70. double application du lot REFUSÉE (SCANYM_SCHEMA_DRIFT)" "1" "$([ "$RC_DOUBLE_APPLY" != "0" ] && echo 1 || echo 0)"
assert_contains "71. message de double application mentionne SCANYM_SCHEMA_DRIFT" "SCANYM_SCHEMA_DRIFT" "$(cat /tmp/scanym-p1v2-err-$$.txt)"

psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
createdb "$DB_DRIFT"
build_common_bootstrap "$DB_DRIFT"
RC_MISSING_PREREQ="$(psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P1_SQL" >/tmp/scanym-p1v2-out-$$.txt 2>/tmp/scanym-p1v2-err-$$.txt; echo $?)"
assert_behav_eq "72. application sur base SANS orders/is_member_of REFUSÉE dès la garde préflight" "1" "$([ "$RC_MISSING_PREREQ" != "0" ] && echo 1 || echo 0)"
assert_contains "73. message de garde préflight mentionne SCANYM_SCHEMA_DRIFT" "SCANYM_SCHEMA_DRIFT" "$(cat /tmp/scanym-p1v2-err-$$.txt)"

# ============================================================
# BILAN
# ============================================================
log "=== BILAN : $PASS_COUNT PASS / $FAIL_COUNT FAIL (dont $STRUCT_COUNT structurelles, $BEHAV_COUNT comportementales, $CONC_COUNT concurrence réelle) ==="
if [ "$FAIL_COUNT" -gt 0 ]; then
  log "--- Détail des échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
