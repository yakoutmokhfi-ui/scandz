#!/usr/bin/env bash
# ============================================================
# Scanym — STUART LOT C — DELIVERY FINANCIAL PERSISTENCE
# FOUNDATION v1 — Harnais reproductible pour
# supabase/DRAFT-lot-delivery-financial-persistence-foundation-v1.sql.
#
# PostgreSQL communautaire vanilla, même patron que tous les harnais
# précédents.
#
# CHAÎNE DE DÉPENDANCE RÉELLE (reconstruite par recoupement des blocs
# SCANYM_SCHEMA_DRIFT de chaque fichier, aucune chaîne unique
# canonique n'existe dans ce dépôt -- voir le livrable final) :
# chaîne minimale ORDERS/LOT 2A jusqu'à v81 -> v82/v83/v84 (sale
# modes) -> fulfillment-routing-model -> fulfillment-routing-lot-b-rpc
# -> server-delivery-fulfillment-pricing (delivery_fee/provider_code)
# -> PAYMENT P1 (scanym_numeric_is_non_finite, payment_transactions)
# -> P2A/P2B-A/P3-B0/P3-B1 (chaîne Payment publiée) -> PAYMENT P3-B6
# (billing context, dernière definition de create_order avant
# CATALOGUE FISCAL/RECEIPT) -> MERCHANT LEGAL TAX PROFILE v1 ->
# CATALOGUE FISCAL v1.3 -> RECEIPT/INVOICE TAX DETAIL v1 (dernière
# définition réelle de create_order) -> CUSTOMER ORDER TRACKING
# FOUNDATION -> ORDERS SERVICE_ROLE SELECT HARDENING -> ce lot.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/delivery-financial-persistence-foundation-v1-check.sh"
# ============================================================

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
LOT_SQL="$SUPABASE_DIR/DRAFT-lot-delivery-financial-persistence-foundation-v1.sql"
DB="scanym_lotc_check_$$"

PASS_COUNT=0
FAIL_COUNT=0
STRUCT_COUNT=0
BEHAV_COUNT=0
FAIL_LOG="/tmp/scanym-lotc-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }
struct() { STRUCT_COUNT=$((STRUCT_COUNT+1)); pass "$@"; }
behav() { BEHAV_COUNT=$((BEHAV_COUNT+1)); pass "$@"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  rm -f "${FAIL_LOG:-}" 2>/dev/null || true
}
trap cleanup EXIT

sql() { psql -X -A -q -t -d "$DB" -c "$1"; }
as_anon() { PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" 2>&1; }
as_authenticated() {
  local uid="$1" query="$2"
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$\$ begin perform set_config('test.uid', '$uid', false); end \$\$; $query" 2>&1
}

assert_struct_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then struct "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_behav_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then behav "$desc"; else fail "$desc — attendu de contenir '$needle', obtenu: $haystack"; fi
}
assert_behav_not_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then fail "$desc — NE DEVAIT PAS contenir '$needle', obtenu: $haystack"; else behav "$desc"; fi
}

# ------------------------------------------------------------
# 0. Construction de la chaîne.
# ------------------------------------------------------------
log "=== [0] Construction chaîne $DB ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"

psql -d "$DB" >/dev/null <<'SQL'
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

apply() { psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$1" >/dev/null; }

for f in schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql; do
  apply "$f" || { fail "chaîne minimale interrompue à $f"; exit 1; }
  psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
done
for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql migration-v82-lot2a-sale-modes.sql migration-v83-lot2a4-privilege-hardening.sql migration-v84-lot2b1-delivery-info-rpc.sql DRAFT-lot-fulfillment-routing-model.sql DRAFT-lot-fulfillment-routing-lot-b-rpc.sql DRAFT-lot-server-delivery-fulfillment-pricing.sql DRAFT-lot-payment-p1-foundation.sql; do
  apply "$f" || { fail "chaîne interrompue à $f"; exit 1; }
done

psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), secret text not null, name text, description text, key_id uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create function vault.create_secret(new_secret text, new_name text, new_description text, new_key_id uuid default null) returns uuid language plpgsql as $fn$
declare v_id uuid; begin insert into vault.secrets (secret, name, description, key_id) values (new_secret, new_name, new_description, new_key_id) returning id into v_id; return v_id; end; $fn$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null) returns void language plpgsql as $fn$
begin update vault.secrets set secret=coalesce(new_secret,secret), name=coalesce(new_name,name), description=coalesce(new_description,description), key_id=coalesce(new_key_id,key_id), updated_at=now() where id=secret_id; end; $fn$;
create view vault.decrypted_secrets as select id, secret as decrypted_secret, name, description, key_id, created_at, updated_at from vault.secrets;
SQL

for f in DRAFT-lot-payment-p2a-secure-config.sql DRAFT-lot-payment-p2b-a-safe-merchant-read.sql DRAFT-lot-payment-p3a0-secure-credential-read.sql DRAFT-lot-payment-p3b0-correlation-status-read.sql DRAFT-lot-payment-p3b1-runtime-provider-enablement-read.sql DRAFT-lot-payment-p3b6-checkout-billing-context.sql DRAFT-lot-merchant-legal-tax-profile-v1.sql DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql DRAFT-lot-receipt-invoice-tax-detail-v1.sql DRAFT-lot-customer-order-tracking-foundation.sql DRAFT-lot-orders-service-role-select-hardening.sql; do
  apply "$f" || { fail "chaîne interrompue à $f"; exit 1; }
done
struct "chaîne complète appliquée jusqu'à ORDERS SERVICE_ROLE SELECT HARDENING (inclus)"

# ------------------------------------------------------------
# 1. Application du lot sous test.
# ------------------------------------------------------------
log "=== [1] Application du lot ==="
if psql -d "$DB" -v ON_ERROR_STOP=1 -f "$LOT_SQL" >/dev/null 2>/tmp/scanym-lotc-apply-err-$$.log; then
  struct "lot appliqué sans erreur"
else
  fail "échec d'application du lot: $(cat /tmp/scanym-lotc-apply-err-$$.log)"
fi
rm -f /tmp/scanym-lotc-apply-err-$$.log

# ------------------------------------------------------------
# 2. Structure.
# ------------------------------------------------------------
log "=== [2] Structure ==="
assert_struct_eq "[1] orders.provider_cost existe" "provider_cost" "$(sql "select column_name from information_schema.columns where table_name='orders' and column_name='provider_cost';")"
assert_struct_eq "[1b] orders.provider_cost nullable" "YES" "$(sql "select is_nullable from information_schema.columns where table_name='orders' and column_name='provider_cost';")"
assert_struct_eq "[1c] orders.provider_cost numeric(12,2)" "numeric|12|2" "$(sql "select data_type||'|'||numeric_precision||'|'||numeric_scale from information_schema.columns where table_name='orders' and column_name='provider_cost';")"
assert_struct_eq "[2] orders.delivery_merchant_subsidy existe" "delivery_merchant_subsidy" "$(sql "select column_name from information_schema.columns where table_name='orders' and column_name='delivery_merchant_subsidy';")"
assert_struct_eq "[grant] create_order signature inchangée" "create_order" "$(sql "select proname from pg_proc where proname='create_order';")"
assert_struct_eq "[grant] anon ne peut pas EXECUTE la nouvelle RPC" "" "$(sql "select grantee from information_schema.routine_privileges where routine_name='set_order_delivery_provider_financials' and grantee in ('anon','authenticated');")"
assert_struct_eq "[grant] service_role peut EXECUTE la nouvelle RPC" "service_role" "$(sql "select grantee from information_schema.routine_privileges where routine_name='set_order_delivery_provider_financials' and grantee='service_role';")"

# ------------------------------------------------------------
# 3. Fixtures.
# ------------------------------------------------------------
log "=== Fixtures ==="
OWNER_A="70000000-0000-0000-0000-000000000001"
OWNER_B="70000000-0000-0000-0000-000000000002"
psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into auth.users (id, email) values ('$OWNER_A', 'owner-a@lotc.test'), ('$OWNER_B', 'owner-b@lotc.test');
insert into restaurants (name, slug, status) values ('LOT C A', 'lotc-a', 'active'), ('LOT C B', 'lotc-b', 'active');
SQL
RID_A="$(sql "select id from restaurants where slug='lotc-a';")"
RID_B="$(sql "select id from restaurants where slug='lotc-b';")"
psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into restaurant_users (restaurant_id, user_id, role) values ('$RID_A','$OWNER_A','owner'), ('$RID_B','$OWNER_B','owner');" >/dev/null

mk_order() {
  local rid="$1" num="$2" mode="$3" dfee="$4"
  sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency, delivery_fee) values ('$rid', $num, '$mode', 20.00, $(sql "select 20.00 + $dfee"), 'EUR', $dfee) returning id;"
}

# ------------------------------------------------------------
# 4. Comportement — écriture valide (exemple mandat 8.40/5.00/3.40).
# ------------------------------------------------------------
log "=== [4] Écriture valide ==="
OID1="$(mk_order "$RID_A" 1 delivery 5.00)"
OUT="$(sql "select provider_cost||'|'||delivery_merchant_subsidy from set_order_delivery_provider_financials('$OID1', 8.40, 3.40, 'EUR');")"
assert_struct_eq "[3] écriture valide provider_cost=8.40/subsidy=3.40" "8.40|3.40" "$OUT"
assert_struct_eq "[persisted] relecture directe" "8.40|3.40" "$(sql "select provider_cost||'|'||delivery_merchant_subsidy from orders where id='$OID1';")"

# ------------------------------------------------------------
# 5. Immuabilité (mandat #7 — snapshot historique jamais ré-écrit).
# ------------------------------------------------------------
log "=== [5] Immuabilité ==="
ERR="$(sql "select set_order_delivery_provider_financials('$OID1', 1.00, 0, 'EUR');" 2>&1)"
assert_behav_contains "[7] second write refusé (immuable)" "déjà enregistré" "$ERR"
assert_struct_eq "[7b] valeur historique inchangée après tentative" "8.40|3.40" "$(sql "select provider_cost||'|'||delivery_merchant_subsidy from orders where id='$OID1';")"

# ------------------------------------------------------------
# 6. Rejets (mandat #10/#11/#12).
# ------------------------------------------------------------
log "=== [6] Validations fail-closed ==="
OID2="$(mk_order "$RID_A" 2 delivery 5.00)"
ERR="$(sql "select set_order_delivery_provider_financials('$OID2', -1, 0, 'EUR');" 2>&1)"
assert_behav_contains "[10] provider_cost négatif rejeté" "invalide" "$ERR"

OID3="$(mk_order "$RID_A" 3 delivery 5.00)"
ERR="$(sql "select set_order_delivery_provider_financials('$OID3', 8.40, 3.40, 'DZD');" 2>&1)"
assert_behav_contains "[11] devise incompatible rejetée" "devise" "$ERR"

OID4="$(mk_order "$RID_A" 4 delivery 5.00)"
ERR="$(sql "select set_order_delivery_provider_financials('$OID4', 8.405, 3.405, 'EUR');" 2>&1)"
assert_behav_contains "[12] >2 décimales rejeté avant persistance" "2 décimales" "$ERR"
assert_struct_eq "[12b] aucune persistance partielle" "" "$(sql "select provider_cost from orders where id='$OID4';")"

OID5="$(mk_order "$RID_A" 5 delivery 5.00)"
ERR="$(sql "select set_order_delivery_provider_financials('$OID5', 8.40, 1.00, 'EUR');" 2>&1)"
assert_behav_contains "[defensif] subside incohérent rejeté" "incohérent" "$ERR"

OID6="$(mk_order "$RID_A" 6 pickup 0)"
ERR="$(sql "select set_order_delivery_provider_financials('$OID6', 8.40, 3.40, 'EUR');" 2>&1)"
assert_behav_contains "[18] commande non-livraison rejetée" "non éligible" "$ERR"

OID7="$(mk_order "$RID_A" 7 delivery 5.00)"
OUT="$(sql "select delivery_merchant_subsidy from set_order_delivery_provider_financials('$OID7', 3.00, 0, 'EUR');")"
assert_struct_eq "[subside=0] providerCost < customerFee -> subsidy=0, jamais négatif" "0.00" "$OUT"

# ------------------------------------------------------------
# 7. Autorité serveur (mandat #13).
# ------------------------------------------------------------
log "=== [7] Autorité serveur ==="
OID8="$(mk_order "$RID_A" 8 delivery 5.00)"
OUT="$(as_anon "select set_order_delivery_provider_financials('$OID8', 8.40, 3.40, 'EUR');")"
assert_behav_contains "[13] anon ne peut pas appeler la RPC" "permission denied" "$OUT"
OUT2="$(as_anon "update orders set provider_cost=1, delivery_merchant_subsidy=1 where id='$OID8';")"
assert_behav_contains "[13b] anon ne peut pas UPDATE directement provider_cost" "permission denied" "$OUT2"

# ------------------------------------------------------------
# 8. Isolation tenant + lecture marchande (mandat #14/#17).
# ------------------------------------------------------------
log "=== [8] Isolation tenant / lecture marchande ==="
OID9="$(mk_order "$RID_A" 9 delivery 5.00)"
sql "select set_order_delivery_provider_financials('$OID9', 8.40, 3.40, 'EUR');" >/dev/null
OUT_A="$(as_authenticated "$OWNER_A" "select provider_cost||'|'||delivery_merchant_subsidy from orders where id='$OID9';")"
assert_struct_eq "[17] marchand A lit provider_cost/subsidy de sa propre commande" "8.40|3.40" "$OUT_A"
OUT_B="$(as_authenticated "$OWNER_B" "select count(*) from orders where id='$OID9';")"
assert_struct_eq "[14] marchand B ne voit pas la commande du marchand A (RLS existante, inchangée)" "0" "$OUT_B"

# ------------------------------------------------------------
# 9. Non-exposition client (mandat #15/#16) — get_order_tracking.
# ------------------------------------------------------------
log "=== [9] Non-exposition client ==="
TOKEN9="$(sql "select public_token from orders where id='$OID9';")"
TRACK_OUT="$(as_anon "select * from get_order_tracking('$OID9', '$TOKEN9');")"
assert_behav_not_contains "[15/16] get_order_tracking ne contient pas 8.40 (provider_cost)" "8.4" "$TRACK_OUT"
assert_behav_not_contains "[15/16b] get_order_tracking ne contient pas 3.40 (subsidy)" "3.4" "$TRACK_OUT"

# ------------------------------------------------------------
# 10. Non-régression ciblée — total/delivery_fee inchangés.
# ------------------------------------------------------------
log "=== [10] Non-régression order total ==="
assert_struct_eq "[4] total = subtotal + delivery_fee toujours vrai après ce lot" "25.00" "$(sql "select total from orders where id='$OID9';")"
assert_struct_eq "[5] total n'utilise jamais provider_cost" "25.00" "$(sql "select (subtotal+delivery_fee) from orders where id='$OID9';")"

# ------------------------------------------------------------
# Bilan.
# ------------------------------------------------------------
log "=== BILAN === PASS=$PASS_COUNT (struct=$STRUCT_COUNT, behav=$BEHAV_COUNT) FAIL=$FAIL_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  log "--- Échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
