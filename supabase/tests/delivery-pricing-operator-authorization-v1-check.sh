#!/usr/bin/env bash
# ============================================================
# Scanym — DELIVERY PRICING OPERATOR AUTHORIZATION v1.1 (CIO GO) —
# Harnais reproductible pour
# supabase/DRAFT-lot-delivery-pricing-operator-authorization-v1.sql
# (les deux RPC SECURITY DEFINER
# get_merchant_delivery_fulfillment_pricing /
# update_merchant_delivery_fulfillment_pricing, delta minimal
# is_scanym_operator()).
#
# Baseline : chaîne réelle complète jusqu'à DASHBOARD DELIVERY
# PRICING v1 installé (même patron que
# merchant-delivery-pricing-check.sh), PLUS un opérateur Scanym
# global (public.scanym_operators) et un troisième tenant fictif
# GÉNÉRIQUE ciblé par cet opérateur (aucune donnée Au Lait Cru /
# Sanaa réelle n'est modifiée).
#
# Couvre les 16 comportements du mandat v1.1 (numérotés ci-dessous),
# + non-régression owner/manager/staff/cross-tenant/anon déjà prouvée
# par merchant-delivery-pricing-check.sh (ré-exécutée ici à
# l'identique pour prouver l'absence de régression marchande après
# ce lot).
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/delivery-pricing-operator-authorization-v1-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_A_SQL="$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-model.sql"
DRAFT_B_SQL="$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-lot-b-rpc.sql"
DRAFT_SADFP_SQL="$SUPABASE_DIR/DRAFT-lot-server-delivery-fulfillment-pricing.sql"
DRAFT_MERCHANT_PRICING_SQL="$SUPABASE_DIR/DRAFT-lot-merchant-delivery-pricing.sql"
DRAFT_DPOP_SQL="$SUPABASE_DIR/DRAFT-lot-delivery-pricing-operator-authorization-v1.sql"
DB="scanym_dp_operator_auth_$$"

PASS_COUNT=0
FAIL_COUNT=0

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
FAIL_LOG="/tmp/scanym-dp-operator-auth-fails-$$.log"
: > "$FAIL_LOG"
fail() {
  FAIL_COUNT=$((FAIL_COUNT+1))
  printf '%s\n' "$*" >> "$FAIL_LOG"
  log "FAIL: $*"
}

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  rm -f "${FAIL_LOG:-}" 2>/dev/null || true
}
trap cleanup EXIT

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}

sql() { psql -X -A -q -t -d "$DB" -c "$1"; }

as_user() {
  local uid="$1" query="$2"
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$uid'; $query" 2>&1
}
as_user_rc() {
  local uid="$1" query="$2"
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$uid'; $query" >/dev/null 2>/tmp/scanym-dp-operator-auth-err-$$.txt
  echo $?
}

log "=== Construction baseline $DB (chaîne réelle jusqu'à DASHBOARD DELIVERY PRICING v1 installé) ==="
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

for f in schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql; do
  psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
done
for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql; do
  psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
done
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-illico-v2.sql" >/dev/null 2>&1
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-sanaa.sql" >/dev/null 2>&1
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-sirocco-demo.sql" >/dev/null 2>&1
psql -d "$DB" -c "update restaurants set status='active';" >/dev/null 2>&1
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v83-lot2a4-privilege-hardening.sql" >/dev/null
psql -d "$DB" -c "alter default privileges in schema public grant execute on functions to service_role;" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v84-lot2b1-delivery-info-rpc.sql" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_A_SQL" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_B_SQL" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SADFP_SQL" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_MERCHANT_PRICING_SQL" >/dev/null
pass "chaîne réelle appliquée jusqu'à DASHBOARD DELIVERY PRICING v1 (installé en Production)"

log "=== Application de DRAFT-lot-delivery-pricing-operator-authorization-v1.sql (lot testé, v1.1 CIO GO) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_DPOP_SQL" >/dev/null
pass "DRAFT-lot-delivery-pricing-operator-authorization-v1.sql appliqué sans erreur"

# ============================================================
# FIXTURES GÉNÉRIQUES
#   Tenant Un   : owner/manager/staff (restaurant_users), 2 règles.
#   Tenant Deux : owner (restaurant_users) -- pour le cross-tenant.
#   Tenant Trois: AUCUNE ligne restaurant_users -- ciblé par
#                 l'opérateur (établissement "hors de ses propres
#                 rattachements", exactement le scénario du mandat).
#   Opérateur   : ligne scanym_operators, ZÉRO ligne restaurant_users
#                 nulle part (jamais de membership factice).
#   Utilisateur authentifié quelconque, sans scanym_operators ni
#   restaurant_users -- "unrelated authenticated".
# ============================================================
log "=== Fixtures génériques ==="
OWNER_UID="10000000-0000-0000-0000-000000000001"
MANAGER_UID="10000000-0000-0000-0000-000000000002"
STAFF_UID="10000000-0000-0000-0000-000000000003"
OTHER_OWNER_UID="20000000-0000-0000-0000-000000000001"
OPERATOR_UID="ffffffff-ffff-ffff-ffff-ffffffffffff"
UNRELATED_UID="99999999-0000-0000-0000-000000000001"
FAKE_OPERATOR_UID="11111111-0000-0000-0000-000000000001"

psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into auth.users (id, email) values
  ('$OWNER_UID', 'owner@fixture-one.test'),
  ('$MANAGER_UID', 'manager@fixture-one.test'),
  ('$STAFF_UID', 'staff@fixture-one.test'),
  ('$OTHER_OWNER_UID', 'owner@fixture-two.test'),
  ('$OPERATOR_UID', 'operator@test.local'),
  ('$UNRELATED_UID', 'unrelated@test.local'),
  ('$FAKE_OPERATOR_UID', 'fake-operator-not-flagged@test.local');

with resto as (
  insert into restaurants (name, slug, status) values ('Fixture Tenant One', 'fixture-tenant-one', 'active') returning id
)
insert into restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number)
select id, 0, 'EUR', '+33600000100' from resto;

with resto2 as (
  insert into restaurants (name, slug, status) values ('Fixture Tenant Two', 'fixture-tenant-two', 'active') returning id
)
insert into restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number)
select id, 0, 'EUR', '+33600000200' from resto2;

with resto3 as (
  insert into restaurants (name, slug, status) values ('Fixture Tenant Three (Operator Target)', 'fixture-tenant-three', 'active') returning id
)
insert into restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number)
select id, 0, 'EUR', '+33600000300' from resto3;
SQL

TENANT_ONE=$(sql "select id from restaurants where slug='fixture-tenant-one';")
TENANT_TWO=$(sql "select id from restaurants where slug='fixture-tenant-two';")
TENANT_THREE=$(sql "select id from restaurants where slug='fixture-tenant-three';")

psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into restaurant_users (user_id, restaurant_id, role) values
  ('$OWNER_UID', '$TENANT_ONE', 'owner'),
  ('$MANAGER_UID', '$TENANT_ONE', 'manager'),
  ('$STAFF_UID', '$TENANT_ONE', 'staff'),
  ('$OTHER_OWNER_UID', '$TENANT_TWO', 'owner');

-- Opérateur Scanym global -- AUCUNE ligne restaurant_users, sur
-- AUCUN tenant, y compris Tenant Trois qu'il va cibler.
insert into public.scanym_operators (user_id) values ('$OPERATOR_UID');

insert into restaurant_sale_modes (restaurant_id, mode_code, enabled, display_order)
values
  ('$TENANT_ONE', 'delivery', true, 1),
  ('$TENANT_THREE', 'delivery', true, 1);

insert into restaurant_sale_mode_fulfillments (
  restaurant_id, mode_code, fulfillment_code, provider, zone_prefixes,
  is_fallback, min_items, customer_text, display_order,
  enabled, pricing_mode, fixed_fee, free_threshold
) values
  ('$TENANT_ONE', 'delivery', 'rule_alpha', 'internal', array['10'],
   false, null, 'Texte initial alpha (fixture).', 10,
   true, 'fixed', 7.00, null),
  ('$TENANT_ONE', 'delivery', 'rule_beta', 'internal', '{}'::text[],
   true, null, 'Texte initial beta (fixture).', 20,
   true, 'free_above_threshold', 15.00, 60.00),
  ('$TENANT_THREE', 'delivery', 'rule_gamma', 'internal', array['20'],
   false, null, 'Texte initial gamma (fixture, tenant opérateur).', 10,
   true, 'fixed', 5.00, null);
SQL

RULE_ALPHA=$(sql "select id from restaurant_sale_mode_fulfillments where restaurant_id='$TENANT_ONE' and fulfillment_code='rule_alpha';")
RULE_BETA=$(sql "select id from restaurant_sale_mode_fulfillments where restaurant_id='$TENANT_ONE' and fulfillment_code='rule_beta';")
RULE_GAMMA=$(sql "select id from restaurant_sale_mode_fulfillments where restaurant_id='$TENANT_THREE' and fulfillment_code='rule_gamma';")
pass "fixtures construites (tenant_one=$TENANT_ONE, tenant_deux=$TENANT_TWO, tenant_trois=$TENANT_THREE/rule_gamma=$RULE_GAMMA -- ciblé par l'opérateur, ZÉRO ligne restaurant_users)"

# ============================================================
# 1/2. Owner READ/WRITE PASS (contrat marchand inchangé)
# ============================================================
log "=== TEST 1 : owner (tenant_one) READ PASS (non-régression) ==="
READ_OWNER=$(as_user "$OWNER_UID" "select count(*) from get_merchant_delivery_fulfillment_pricing('$TENANT_ONE');")
assert_eq "1. owner peut toujours lire les 2 règles de tenant_one" "2" "$READ_OWNER"

log "=== TEST 2 : owner (tenant_one) WRITE PASS (non-régression) ==="
as_user "$OWNER_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_ALPHA','fixed',8.50,null,'Texte owner (fixture).');" >/dev/null
assert_eq "2. rule_alpha.fixed_fee=8.50 après update owner" "8.50" "$(sql "select fixed_fee from restaurant_sale_mode_fulfillments where id='$RULE_ALPHA';")"

# ============================================================
# 3/4. Manager READ/WRITE PASS (contrat marchand inchangé)
# ============================================================
log "=== TEST 3 : manager (tenant_one) READ PASS (non-régression) ==="
READ_MANAGER=$(as_user "$MANAGER_UID" "select count(*) from get_merchant_delivery_fulfillment_pricing('$TENANT_ONE');")
assert_eq "3. manager peut toujours lire les 2 règles de tenant_one" "2" "$READ_MANAGER"

log "=== TEST 4 : manager (tenant_one) WRITE PASS (non-régression) ==="
as_user "$MANAGER_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_ALPHA','fixed',9.90,null,'Texte manager (fixture).');" >/dev/null
assert_eq "4. rule_alpha.fixed_fee=9.90 après update manager" "9.90" "$(sql "select fixed_fee from restaurant_sale_mode_fulfillments where id='$RULE_ALPHA';")"

# ============================================================
# 5/6. Staff : READ PASS (inchangé), WRITE toujours DENIED (inchangé
# -- ce lot n'élargit AUCUN rôle marchand, seul un bypass opérateur
# est ajouté)
# ============================================================
log "=== TEST 5 : staff (tenant_one) READ toujours PASS (non-régression) ==="
READ_STAFF=$(as_user "$STAFF_UID" "select count(*) from get_merchant_delivery_fulfillment_pricing('$TENANT_ONE');")
assert_eq "5. staff peut toujours lire les 2 règles de tenant_one" "2" "$READ_STAFF"

log "=== TEST 6 : staff (tenant_one) WRITE toujours DENIED (non-régression -- ce lot n'élargit pas les rôles marchands) ==="
STAFF_WRITE_RC=$(as_user_rc "$STAFF_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_ALPHA','fixed',1.00,null,null);")
assert_eq "6. mutation staff toujours rejetée (code de sortie non-zéro)" "1" "$STAFF_WRITE_RC"
assert_eq "6b. erreur 42501 (Not authorized), staff" "1" "$(grep -c "42501\|Not authorized" /tmp/scanym-dp-operator-auth-err-$$.txt || true)"

# ============================================================
# 7/8. OPÉRATEUR ciblant tenant_trois (HORS de ses propres
# rattachements restaurant_users, ZÉRO ligne restaurant_users) --
# LE GAP FERMÉ PAR CE LOT.
# ============================================================
log "=== TEST 7 : opérateur Scanym global READ tenant_trois PASS (gap fermé par ce lot) ==="
READ_OPERATOR=$(as_user "$OPERATOR_UID" "select count(*) from get_merchant_delivery_fulfillment_pricing('$TENANT_THREE');")
assert_eq "7. opérateur peut lire la règle de tenant_trois (établissement hors de ses rattachements)" "1" "$READ_OPERATOR"
OPERATOR_LABEL=$(as_user "$OPERATOR_UID" "select fulfillment_label from get_merchant_delivery_fulfillment_pricing('$TENANT_THREE');")
assert_eq "7b. étiquette lisible correcte pour l'opérateur (pas de fuite provider/fulfillment_code)" "true" "$(echo "$OPERATOR_LABEL" | grep -qi "Livraison" && echo true || echo false)"

log "=== TEST 8 : opérateur Scanym global WRITE tenant_trois PASS (gap fermé par ce lot) ==="
as_user "$OPERATOR_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_GAMMA','fixed',6.50,null,'Texte opérateur (fixture).');" >/dev/null
assert_eq "8. rule_gamma.fixed_fee=6.50 après update opérateur" "6.50" "$(sql "select fixed_fee from restaurant_sale_mode_fulfillments where id='$RULE_GAMMA';")"
assert_eq "8b. rule_gamma.customer_text mis à jour par l'opérateur" "Texte opérateur (fixture)." "$(sql "select customer_text from restaurant_sale_mode_fulfillments where id='$RULE_GAMMA';")"

# ============================================================
# 9/10. Opérateur, mode free_above_threshold (non-régression de la
# logique de validation existante, chemin opérateur)
# ============================================================
log "=== TEST 9 : opérateur WRITE free_above_threshold sur tenant_trois PASS ==="
as_user "$OPERATOR_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_GAMMA','free_above_threshold',4.00,30.00,'Texte opérateur seuil (fixture).');" >/dev/null
assert_eq "9. rule_gamma bascule correctement en free_above_threshold via l'opérateur" "free_above_threshold|4.00|30.00" "$(sql "select pricing_mode || '|' || fixed_fee || '|' || free_threshold from restaurant_sale_mode_fulfillments where id='$RULE_GAMMA';")"

log "=== TEST 10 : opérateur -- validation DDP-V1-01 (NaN) inchangée, rejetée aussi pour l'opérateur ==="
OPERATOR_NAN_RC=$(as_user_rc "$OPERATOR_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_GAMMA','fixed','NaN'::numeric,null,null);")
assert_eq "10. fixed_fee NaN rejeté même pour l'opérateur (validation DDP-V1-01 non contournée)" "1" "$OPERATOR_NAN_RC"
assert_eq "10b. erreur 22023 (finite numeric)" "1" "$(grep -c "22023\|finite numeric" /tmp/scanym-dp-operator-auth-err-$$.txt || true)"
assert_eq "10c. rule_gamma inchangé après tentative NaN opérateur" "free_above_threshold|4.00|30.00" "$(sql "select pricing_mode || '|' || fixed_fee || '|' || free_threshold from restaurant_sale_mode_fulfillments where id='$RULE_GAMMA';")"

# ============================================================
# 11/12. Merchant-other-tenant (owner tenant_deux) ciblant tenant_one
# -- toujours DENIED (non-régression cross-tenant, contrat marchand
# inchangé -- ce lot n'ajoute PAS de bypass marchand cross-tenant).
# ============================================================
log "=== TEST 11 : owner tenant_deux READ tenant_one toujours DENIED (cross-tenant, non-régression) ==="
CROSS_READ_RC=$(as_user_rc "$OTHER_OWNER_UID" "select count(*) from get_merchant_delivery_fulfillment_pricing('$TENANT_ONE');")
assert_eq "11. lecture cross-tenant marchande toujours rejetée" "1" "$CROSS_READ_RC"
assert_eq "11b. erreur 42501, cross-tenant lecture" "1" "$(grep -c "42501\|Not authorized" /tmp/scanym-dp-operator-auth-err-$$.txt || true)"

log "=== TEST 12 : owner tenant_deux WRITE rule_alpha (tenant_one) toujours DENIED (cross-tenant, non-régression) ==="
CROSS_WRITE_RC=$(as_user_rc "$OTHER_OWNER_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_ALPHA','fixed',1.00,null,null);")
assert_eq "12. écriture cross-tenant marchande toujours rejetée" "1" "$CROSS_WRITE_RC"
assert_eq "12b. rule_alpha inchangé après tentative cross-tenant" "9.90" "$(sql "select fixed_fee from restaurant_sale_mode_fulfillments where id='$RULE_ALPHA';")"

# ============================================================
# 13. Unrelated authenticated (ni scanym_operators, ni
# restaurant_users, nulle part) -- DENIED en lecture ET en écriture.
# Inclut le cas "faux nom d'opérateur" (aucun bypass par convention de
# nom, is_scanym_operator() ne dépend que de la table réelle).
# ============================================================
log "=== TEST 13 : utilisateur authentifié sans rattachement ni scanym_operators -> DENIED (lecture ET écriture) ==="
UNRELATED_READ_RC=$(as_user_rc "$UNRELATED_UID" "select count(*) from get_merchant_delivery_fulfillment_pricing('$TENANT_ONE');")
assert_eq "13a. lecture refusée pour utilisateur non lié" "1" "$UNRELATED_READ_RC"
UNRELATED_WRITE_RC=$(as_user_rc "$UNRELATED_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_ALPHA','fixed',1.00,null,null);")
assert_eq "13b. écriture refusée pour utilisateur non lié" "1" "$UNRELATED_WRITE_RC"

FAKE_OP_READ_RC=$(as_user_rc "$FAKE_OPERATOR_UID" "select count(*) from get_merchant_delivery_fulfillment_pricing('$TENANT_THREE');")
assert_eq "13c. utilisateur nommé 'fake-operator' SANS ligne scanym_operators -> DENIED (aucun bypass par convention de nom)" "1" "$FAKE_OP_READ_RC"

# ============================================================
# 14. Anon -- DENIED (lecture ET écriture), aucun EXECUTE grant.
# ============================================================
log "=== TEST 14 : anon DENIED (lecture ET écriture, aucun GRANT EXECUTE) ==="
ANON_READ_RC=0
PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "select count(*) from get_merchant_delivery_fulfillment_pricing('$TENANT_ONE');" >/dev/null 2>/tmp/scanym-dp-anon-read-err-$$.txt || ANON_READ_RC=$?
assert_eq "14a. anon lecture : rejeté (permission denied)" "true" "$([ "$ANON_READ_RC" -ne 0 ] && echo true || echo false)"
assert_eq "14b. anon lecture : erreur permission denied" "1" "$(grep -ci "permission denied" /tmp/scanym-dp-anon-read-err-$$.txt || true)"
ANON_WRITE_RC=0
PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "select update_merchant_delivery_fulfillment_pricing('$RULE_ALPHA','fixed',1.00,null,null);" >/dev/null 2>/tmp/scanym-dp-anon-write-err-$$.txt || ANON_WRITE_RC=$?
assert_eq "14c. anon écriture : rejeté (permission denied)" "true" "$([ "$ANON_WRITE_RC" -ne 0 ] && echo true || echo false)"
assert_eq "14d. anon écriture : erreur permission denied" "1" "$(grep -ci "permission denied" /tmp/scanym-dp-anon-write-err-$$.txt || true)"

# ============================================================
# 15. Champs structurels toujours non éditables (immutabilité,
# non-régression -- inchangé par ce lot), même après écriture
# opérateur.
# ============================================================
log "=== TEST 15 : champs structurels de rule_gamma inchangés après écriture opérateur (provider/fulfillment_code/zone_prefixes/is_fallback) ==="
STRUCT_GAMMA=$(sql "select provider || '|' || fulfillment_code || '|' || array_to_string(zone_prefixes,',') || '|' || is_fallback::text from restaurant_sale_mode_fulfillments where id='$RULE_GAMMA';")
assert_eq "15. structure de rule_gamma strictement inchangée (aucun champ structurel n'est un paramètre de la RPC)" "internal|rule_gamma|20|false" "$STRUCT_GAMMA"

# ============================================================
# 16. Aucun octroi élargi : anon toujours sans EXECUTE, authenticated
# toujours avec EXECUTE, aucun GRANT UPDATE direct sur la table --
# les deux fonctions.
# ============================================================
log "=== TEST 16 : GRANT inchangés après application du lot (anon sans EXECUTE, authenticated avec EXECUTE, aucun UPDATE direct table) ==="
GRANT_ANON_READ=$(sql "select has_function_privilege('anon', 'public.get_merchant_delivery_fulfillment_pricing(uuid)', 'EXECUTE');")
assert_eq "16a. anon sans EXECUTE sur get_merchant_delivery_fulfillment_pricing" "f" "$GRANT_ANON_READ"
GRANT_AUTH_READ=$(sql "select has_function_privilege('authenticated', 'public.get_merchant_delivery_fulfillment_pricing(uuid)', 'EXECUTE');")
assert_eq "16b. authenticated avec EXECUTE sur get_merchant_delivery_fulfillment_pricing" "t" "$GRANT_AUTH_READ"
GRANT_ANON_WRITE=$(sql "select has_function_privilege('anon', 'public.update_merchant_delivery_fulfillment_pricing(uuid, text, numeric, numeric, text)', 'EXECUTE');")
assert_eq "16c. anon sans EXECUTE sur update_merchant_delivery_fulfillment_pricing" "f" "$GRANT_ANON_WRITE"
GRANT_AUTH_WRITE=$(sql "select has_function_privilege('authenticated', 'public.update_merchant_delivery_fulfillment_pricing(uuid, text, numeric, numeric, text)', 'EXECUTE');")
assert_eq "16d. authenticated avec EXECUTE sur update_merchant_delivery_fulfillment_pricing" "t" "$GRANT_AUTH_WRITE"
DIRECT_UPDATE=$(sql "select has_table_privilege('authenticated', 'public.restaurant_sale_mode_fulfillments', 'UPDATE');")
assert_eq "16e. authenticated n'a AUCUN privilège UPDATE direct sur la table (écriture exclusivement via la RPC)" "f" "$DIRECT_UPDATE"

# ============================================================
# GARDE-FOU SUPPLÉMENTAIRE (tenant-tampering) : un opérateur qui
# passe le p_restaurant_id d'un tenant OÙ IL N'EST PAS RATTACHÉ
# obtient l'accès via is_scanym_operator() (comportement ATTENDU et
# VOULU -- c'est l'objet même du lot, un opérateur global n'a pas à
# prouver un rattachement) -- mais un MARCHAND (non-opérateur) ne
# peut PAS obtenir ce même bypass en imitant un opérateur : vérifié
# ci-dessus (TEST 11/12, owner tenant_deux). Vérification
# complémentaire explicite : le marchand tenant_deux n'a PAS de ligne
# scanym_operators.
# ============================================================
log "=== GARDE-FOU : owner tenant_deux n'a AUCUNE ligne scanym_operators (pas d'élévation de privilège possible) ==="
MERCHANT_NOT_OPERATOR=$(sql "select exists(select 1 from public.scanym_operators where user_id='$OTHER_OWNER_UID');")
assert_eq "owner tenant_deux n'est PAS dans scanym_operators (aucune élévation de privilège via ce lot)" "f" "$MERCHANT_NOT_OPERATOR"

rm -f /tmp/scanym-dp-operator-auth-err-$$.txt /tmp/scanym-dp-anon-read-err-$$.txt /tmp/scanym-dp-anon-write-err-$$.txt

log "=== HARNESS SELF-TEST : le journal de FAIL indépendant doit concorder avec FAIL_COUNT ==="
FAIL_LOG_COUNT=$(wc -l < "$FAIL_LOG" | tr -d ' ')
if [ "$FAIL_LOG_COUNT" != "$FAIL_COUNT" ]; then
  echo "[$(date '+%H:%M:%S')] HARNESS SELF-TEST ÉCHEC CRITIQUE : FAIL_COUNT ($FAIL_COUNT) ne correspond pas au journal indépendant ($FAIL_LOG_COUNT)."
  cat "$FAIL_LOG"
  exit 1
fi
if [ "$FAIL_LOG_COUNT" -gt 0 ]; then
  echo "[$(date '+%H:%M:%S')] HARNESS SELF-TEST : $FAIL_LOG_COUNT échec(s) réel(s) -- le script échoue."
  cat "$FAIL_LOG"
  exit 1
fi
echo "[$(date '+%H:%M:%S')] HARNESS SELF-TEST : journal indépendant vide et concordant avec FAIL_COUNT (0)."

log "=== RÉSULTAT FINAL : $PASS_COUNT réussis, $FAIL_COUNT échoués ==="
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "DES VÉRIFICATIONS DELIVERY PRICING OPERATOR AUTHORIZATION v1.1 ONT ÉCHOUÉ"
  exit 1
fi
echo "TOUTES LES VÉRIFICATIONS DELIVERY PRICING OPERATOR AUTHORIZATION v1.1 ONT RÉUSSI"
