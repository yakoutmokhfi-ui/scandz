#!/usr/bin/env bash
# ============================================================
# Scanym — PAYMENT P3-B6 — CHECKOUT BILLING CONTEXT v1 — Harnais
# reproductible pour
# supabase/DRAFT-lot-payment-p3b6-checkout-billing-context.sql.
#
# PostgreSQL communautaire vanilla (pas une instance Supabase managée),
# même patron que tous les harnais paiement précédents.
#
# CHAÎNE DE DÉPENDANCE RÉELLE (ré-auditée directement, mandat section 7
# -- PAS supposée) : PAYMENT P3-B6 ne dépend STRUCTURELLEMENT que de la
# fondation ORDERS/LOT 2A (sale modes) ET de
# DRAFT-lot-server-delivery-fulfillment-pricing.sql, qui porte la
# définition ACTUELLE de create_order (v82 seule est INSUFFISANTE et
# obsolète -- voir l'en-tête du fichier SQL sous test pour le détail de
# l'erreur de premier passage corrigée). AUCUNE dépendance sur
# P1/P2A/P2B-A/P3-A0/P3-B0..B5 (aucun de ces objets n'est référencé
# ici) -- non inclus dans ce harnais ; leur non-régression est prouvée
# séparément par leurs propres harnais INCHANGÉS.
#
# IMPORTANT (leçon opérationnelle héritée du lot P3-B4) : ce script
# DOIT être invoqué en tant qu'utilisateur système `postgres`
# DIRECTEMENT (`su postgres -c "bash ..."` ou
# `sudo -u postgres bash ...` -- jamais en enveloppant chaque appel
# psql individuel dans son propre `sudo -u postgres`).
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/payment-p3b6-checkout-billing-context-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b6-checkout-billing-context.sql"
DB="scanym_payment_p3b6_$$"
DB_DRIFT="scanym_payment_p3b6_drift_$$"
DB_NODEP="scanym_payment_p3b6_nodep_$$"

PASS_COUNT=0
FAIL_COUNT=0
STRUCT_COUNT=0
BEHAV_COUNT=0
CONC_COUNT=0
FAIL_LOG="/tmp/scanym-payment-p3b6-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }
struct() { STRUCT_COUNT=$((STRUCT_COUNT+1)); pass "$@"; }
behav() { BEHAV_COUNT=$((BEHAV_COUNT+1)); pass "$@"; }
conc() { CONC_COUNT=$((CONC_COUNT+1)); pass "$@"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_NODEP\";" >/dev/null 2>&1 || true
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
sql_on() { local dbname="$1"; shift; psql -X -A -q -t -d "$dbname" -c "$1"; }

as_service() { PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$1" 2>&1; }
as_anon() { PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" 2>&1; }
as_authenticated() { PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "$1" 2>&1; }
as_service_rc() {
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-p3b6-out-$$.txt 2>/tmp/scanym-p3b6-err-$$.txt
  echo $?
}
as_anon_rc() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-p3b6-out-$$.txt 2>/tmp/scanym-p3b6-err-$$.txt
  echo $?
}
as_authenticated_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-p3b6-out-$$.txt 2>/tmp/scanym-p3b6-err-$$.txt
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

build_full_chain_through_sibling_delivery_pricing() {
  local dbname="$1"
  build_common_bootstrap "$dbname"
  build_minimal_chain "$dbname"
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v83-lot2a4-privilege-hardening.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v84-lot2b1-delivery-info-rpc.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-model.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-lot-b-rpc.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-server-delivery-fulfillment-pricing.sql" >/dev/null
}

seed_smoke_restaurant() {
  local dbname="$1"
  psql -d "$dbname" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into public.restaurants (id, slug, name, is_active, status)
values ('11111111-1111-1111-1111-111111111111','p3b6-check','P3B6 Check', true, 'active');
insert into public.restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number)
values ('11111111-1111-1111-1111-111111111111','EUR', 1, '+33600000000');
insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled, config)
values
  ('11111111-1111-1111-1111-111111111111','delivery', true, '{"delivery_zone_prefixes": ["75"], "delivery_min_items": 0}'::jsonb),
  ('11111111-1111-1111-1111-111111111111','pickup', true, '{}'::jsonb),
  ('11111111-1111-1111-1111-111111111111','table', true, '{}'::jsonb);
insert into public.menu_categories (id, restaurant_id, name, is_active, display_order)
values ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','Cat', true, 1);
insert into public.menu_items (id, category_id, name, price, is_available)
values ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222','Item', 10.00, true);
SQL
}

create_order_row() {
  # $1=mode $2=customer_jsonb $3=table_number(or "null")
  local mode="$1" customer="$2" tbl="${3:-null}"
  as_anon "select * from create_order('p3b6-check', '$mode', '[{\"menu_item_id\":\"33333333-3333-3333-3333-333333333333\",\"quantity\":1}]'::jsonb, $tbl, '$customer'::jsonb, null, 'fr');"
}

# ============================================================
# [0] BASELINE — chaîne minimale + LOT 2A (v82/v83/v84) + routing
# model/RPC + delivery fulfillment pricing (déjà publiés) + PAYMENT
# P3-B6 (LOT SOUS TEST).
# ============================================================
log "=== [0] Construction baseline $DB ==="
createdb "$DB"
build_full_chain_through_sibling_delivery_pricing "$DB"
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/dev/null
seed_smoke_restaurant "$DB"
struct "Application propre du lot P3-B6 sur baseline réelle (v82+v83+v84+routing+delivery-pricing)"

# ------------------------------------------------------------
# [1] STRUCTURE — table order_billing_context
# ------------------------------------------------------------
log "=== [1] Structure de order_billing_context ==="
assert_struct_eq "order_billing_context existe" "1" "$(sql "select count(*) from information_schema.tables where table_schema='public' and table_name='order_billing_context';")"
assert_struct_eq "order_billing_context.order_id est PK" "1" "$(sql "select count(*) from information_schema.table_constraints where table_name='order_billing_context' and constraint_type='PRIMARY KEY';")"
assert_struct_eq "order_billing_context référence orders(id) on delete cascade" "1" "$(sql "select count(*) from information_schema.referential_constraints rc join information_schema.table_constraints tc on tc.constraint_name=rc.constraint_name where tc.table_name='order_billing_context' and rc.delete_rule='CASCADE';")"
for col in order_id source address_line_1 address_line_2 city postal_code country state_or_province customer_name customer_email customer_phone created_at updated_at; do
  assert_struct_eq "colonne order_billing_context.$col existe" "1" "$(sql "select count(*) from information_schema.columns where table_schema='public' and table_name='order_billing_context' and column_name='$col';")"
done
assert_struct_eq "RLS activée sur order_billing_context" "t" "$(sql "select relrowsecurity from pg_class where relname='order_billing_context';")"

# ------------------------------------------------------------
# [2] ACL — aucun accès direct à la table, pour QUICONQUE.
# ------------------------------------------------------------
log "=== [2] ACL table order_billing_context ==="
assert_struct_eq "anon ne peut pas lire order_billing_context" "1" "$(as_anon_rc "select * from order_billing_context limit 1;")"
assert_struct_eq "authenticated ne peut pas lire order_billing_context" "1" "$(as_authenticated_rc "select * from order_billing_context limit 1;")"
assert_struct_eq "service_role ne peut PAS lire order_billing_context directement (accès RPC uniquement)" "1" "$(as_service_rc "select * from order_billing_context limit 1;")"

# ------------------------------------------------------------
# [3] GRANTS RPC — service_role UNIQUEMENT, jamais anon/authenticated.
# ------------------------------------------------------------
log "=== [3] Grants RPC ==="
assert_struct_eq "set_order_billing_context: aucun grant à anon" "0" "$(sql "select count(*) from information_schema.role_routine_grants where routine_name='set_order_billing_context' and grantee='anon';")"
assert_struct_eq "set_order_billing_context: aucun grant à authenticated" "0" "$(sql "select count(*) from information_schema.role_routine_grants where routine_name='set_order_billing_context' and grantee='authenticated';")"
assert_struct_eq "set_order_billing_context: grant à service_role" "1" "$(sql "select count(*) from information_schema.role_routine_grants where routine_name='set_order_billing_context' and grantee='service_role';")"
assert_struct_eq "get_order_billing_context: aucun grant à anon" "0" "$(sql "select count(*) from information_schema.role_routine_grants where routine_name='get_order_billing_context' and grantee='anon';")"
assert_struct_eq "get_order_billing_context: aucun grant à authenticated" "0" "$(sql "select count(*) from information_schema.role_routine_grants where routine_name='get_order_billing_context' and grantee='authenticated';")"
assert_struct_eq "get_order_billing_context: grant à service_role" "1" "$(sql "select count(*) from information_schema.role_routine_grants where routine_name='get_order_billing_context' and grantee='service_role';")"
assert_struct_eq "get_order_billing_context est STABLE" "s" "$(sql "select provolatile from pg_proc where proname='get_order_billing_context';")"

# ------------------------------------------------------------
# [4] BEHAV — create_order (mode delivery) capture désormais street/city
# ------------------------------------------------------------
log "=== [4] create_order — street/city ==="
ROW=$(create_order_row "delivery" '{"name":"Jean Dupont","phone":"0612345678","email":"jean@example.com","address":"12 rue de Paris, 75001 Paris","postalCode":"75001","street":"12 rue de Paris","city":"Paris"}')
OID_DELIVERY=$(echo "$ROW" | cut -d'|' -f1)
TOKEN_DELIVERY=$(echo "$ROW" | cut -d'|' -f3)
DELIVERY_ROW=$(sql "select formatted_address, postal_code, street, city, country from order_delivery_address where order_id = '$OID_DELIVERY';")
assert_behav_eq "order_delivery_address.street peuplé" "12 rue de Paris" "$(echo "$DELIVERY_ROW" | cut -d'|' -f3)"
assert_behav_eq "order_delivery_address.city peuplé" "Paris" "$(echo "$DELIVERY_ROW" | cut -d'|' -f4)"
assert_behav_eq "order_delivery_address.country reste 'FR' par défaut (non traité comme confirmation)" "FR" "$(echo "$DELIVERY_ROW" | cut -d'|' -f5)"
assert_behav_eq "order_delivery_address.formatted_address/postal_code inchangés" "12 rue de Paris, 75001 Paris|75001" "$(echo "$DELIVERY_ROW" | cut -d'|' -f1,2)"

log "=== [4b] create_order — street/city absents -> NULL, aucune régression ==="
ROW2=$(create_order_row "delivery" '{"name":"Jean Dupont","phone":"0612345678","email":"jean@example.com","address":"5 avenue Foo, 75002 Paris","postalCode":"75002"}')
OID_NOSTREET=$(echo "$ROW2" | cut -d'|' -f1)
NOSTREET_ROW=$(sql "select street, city from order_delivery_address where order_id = '$OID_NOSTREET';")
assert_behav_eq "street NULL quand absent du payload" "" "$(echo "$NOSTREET_ROW" | cut -d'|' -f1)"
assert_behav_eq "city NULL quand absent du payload" "" "$(echo "$NOSTREET_ROW" | cut -d'|' -f2)"

log "=== [4c] create_order — moteur de tarification (déjà publié) toujours fonctionnel après ce lot ==="
assert_behav_eq "subtotal/delivery_fee/total corrects (legacy, aucune règle active)" "10.00|0.00|10.00" "$(echo "$ROW2" | cut -d'|' -f4,5,6)"

log "=== [4d] create_order — modes sans adresse restent valides sans aucune donnée de facturation (mandat section 6) ==="
PICKUP_ROW=$(create_order_row "pickup" '{"name":"Jean Dupont","phone":"0612345678"}')
OID_PICKUP=$(echo "$PICKUP_ROW" | cut -d'|' -f1)
TOKEN_PICKUP=$(echo "$PICKUP_ROW" | cut -d'|' -f3)
assert_struct_eq "pickup: aucune ligne order_delivery_address créée" "0" "$(sql "select count(*) from order_delivery_address where order_id = '$OID_PICKUP';")"

TABLE_ROW=$(create_order_row "table" '{"name":"Jean Dupont","phone":"0612345678"}' "7")
OID_TABLE=$(echo "$TABLE_ROW" | cut -d'|' -f1)
TOKEN_TABLE=$(echo "$TABLE_ROW" | cut -d'|' -f3)

# ------------------------------------------------------------
# [5] BEHAV — set_order_billing_context (delivery_reuse)
# ------------------------------------------------------------
log "=== [5] set_order_billing_context — delivery_reuse ==="
SET1=$(as_service "select * from set_order_billing_context('$OID_DELIVERY'::uuid, '$TOKEN_DELIVERY'::uuid, 'delivery_reuse', null, null, null, null, 'fr', null, null, null, null);")
assert_struct_eq "delivery_reuse: succès (retour non vide)" "1" "$([ -n "$SET1" ] && echo 1 || echo 0)"

GET1=$(as_service "select * from get_order_billing_context('$OID_DELIVERY'::uuid, '$TOKEN_DELIVERY'::uuid);")
assert_behav_eq "delivery_reuse: address_line_1 = street de order_delivery_address" "12 rue de Paris" "$(echo "$GET1" | cut -d'|' -f2)"
assert_behav_eq "delivery_reuse: city = city de order_delivery_address" "Paris" "$(echo "$GET1" | cut -d'|' -f4)"
assert_behav_eq "delivery_reuse: postal_code = postal_code de order_delivery_address" "75001" "$(echo "$GET1" | cut -d'|' -f5)"
assert_behav_eq "delivery_reuse: country = valeur EXPLICITEMENT fournie, normalisée majuscule (PAS le défaut colonne 'FR' de order_delivery_address réutilisé silencieusement)" "FR" "$(echo "$GET1" | cut -d'|' -f6)"

log "=== [5b] delivery_reuse — impossible si order_delivery_address.street/city manquant ==="
SET1B_RC=$(as_service_rc "select * from set_order_billing_context('$OID_NOSTREET'::uuid, '$(sql "select public_token::text from orders where id='$OID_NOSTREET';")'::uuid, 'delivery_reuse', null, null, null, null, 'FR', null, null, null, null);")
assert_struct_eq "delivery_reuse échoue si street/city de livraison absents (fail-closed)" "1" "$SET1B_RC"

log "=== [5c] delivery_reuse — impossible sans aucune order_delivery_address (mode pickup) ==="
SET1C_RC=$(as_service_rc "select * from set_order_billing_context('$OID_PICKUP'::uuid, '$TOKEN_PICKUP'::uuid, 'delivery_reuse', null, null, null, null, 'FR', null, null, null, null);")
assert_struct_eq "delivery_reuse échoue si aucune order_delivery_address pour la commande" "1" "$SET1C_RC"

# ------------------------------------------------------------
# [5d] CORRECTIF v2 (ferme P3B6-BILLING-TRUNCATION-01) — delivery_reuse
# avec une adresse de livraison RÉELLE mais dépassant la limite de
# facturation (>50) : DOIT échouer explicitement, JAMAIS tronquer
# silencieusement l'adresse en une valeur différente/plus courte.
# ------------------------------------------------------------
log "=== [5d] delivery_reuse — adresse de livraison réelle trop longue (>50) -> REJET explicite, jamais de troncature ==="
LONG_STREET="12345678901234567890123456789012345678901234567890123456789012345"  # 65 caractères
ROW_LONG=$(create_order_row "delivery" "{\"name\":\"Jean Dupont\",\"phone\":\"0612345678\",\"email\":\"jean@example.com\",\"address\":\"$LONG_STREET, 75001 Paris\",\"postalCode\":\"75001\",\"street\":\"$LONG_STREET\",\"city\":\"Paris\"}")
OID_LONG=$(echo "$ROW_LONG" | cut -d'|' -f1)
TOKEN_LONG=$(echo "$ROW_LONG" | cut -d'|' -f3)
assert_struct_eq "order_delivery_address.street conserve la valeur COMPLÈTE non tronquée (65 caractères, create_order n'est PAS modifié par ce correctif)" "65" "$(sql "select length(street) from order_delivery_address where order_id='$OID_LONG';")"
SET1D_RC=$(as_service_rc "select * from set_order_billing_context('$OID_LONG'::uuid, '$TOKEN_LONG'::uuid, 'delivery_reuse', null, null, null, null, 'FR', null, null, null, null);")
assert_struct_eq "delivery_reuse échoue explicitement (fail-closed) quand street de livraison dépasse 50 caractères -- jamais de left()/troncature" "1" "$SET1D_RC"
assert_struct_eq "AUCUNE ligne order_billing_context créée par l'appel rejeté ci-dessus (échec atomique, rien de partiel)" "0" "$(sql "select count(*) from order_billing_context where order_id='$OID_LONG';")"

LONG_CITY="Villeneuve-sur-une-Longue-Distance-Administrative-Extraordinaire"  # 64 caractères (>50)
ROW_LONG_CITY=$(create_order_row "delivery" "{\"name\":\"Jean Dupont\",\"phone\":\"0612345678\",\"email\":\"jean@example.com\",\"address\":\"1 rue Courte, 75001 $LONG_CITY\",\"postalCode\":\"75001\",\"street\":\"1 rue Courte\",\"city\":\"$LONG_CITY\"}")
OID_LONG_CITY=$(echo "$ROW_LONG_CITY" | cut -d'|' -f1)
TOKEN_LONG_CITY=$(echo "$ROW_LONG_CITY" | cut -d'|' -f3)
SET1E_RC=$(as_service_rc "select * from set_order_billing_context('$OID_LONG_CITY'::uuid, '$TOKEN_LONG_CITY'::uuid, 'delivery_reuse', null, null, null, null, 'FR', null, null, null, null);")
assert_struct_eq "delivery_reuse échoue explicitement quand city de livraison dépasse 50 caractères" "1" "$SET1E_RC"

# ------------------------------------------------------------
# [6] BEHAV — set_order_billing_context (manual)
# ------------------------------------------------------------
log "=== [6] set_order_billing_context — manual ==="
SET2_RC=$(as_service_rc "select * from set_order_billing_context('$OID_PICKUP'::uuid, '$TOKEN_PICKUP'::uuid, 'manual', null, null, 'Paris', '75001', 'FR', null, 'Jean', null, null);")
assert_struct_eq "manual échoue sans address_line_1 (fail-closed)" "1" "$SET2_RC"

SET3_RC=$(as_service_rc "select * from set_order_billing_context('$OID_PICKUP'::uuid, '$TOKEN_PICKUP'::uuid, 'manual', '1 rue Test', null, null, '75001', 'FR', null, null, null, null);")
assert_struct_eq "manual échoue sans city (fail-closed)" "1" "$SET3_RC"

SET4_RC=$(as_service_rc "select * from set_order_billing_context('$OID_PICKUP'::uuid, '$TOKEN_PICKUP'::uuid, 'manual', '1 rue Test', null, 'Paris', null, 'FR', null, null, null, null);")
assert_struct_eq "manual échoue sans postal_code (fail-closed)" "1" "$SET4_RC"

as_service "select * from set_order_billing_context('$OID_PICKUP'::uuid, '$TOKEN_PICKUP'::uuid, 'manual', '1 rue Test', null, 'Paris', '75001', 'fr', null, 'Jean Dupont', 'jean@example.com', '0612345678');" >/dev/null
GET2=$(as_service "select * from get_order_billing_context('$OID_PICKUP'::uuid, '$TOKEN_PICKUP'::uuid);")
assert_behav_eq "manual: country normalisé en majuscule" "FR" "$(echo "$GET2" | cut -d'|' -f6)"
assert_behav_eq "manual: customer_name persisté" "Jean Dupont" "$(echo "$GET2" | cut -d'|' -f8)"

log "=== [6b] manual — champs optionnels vides -> NULL, jamais chaîne vide (mandat section 5) ==="
as_service "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', '2 rue Vide', '   ', 'Lyon', '69001', 'fr', '', '  ', '', null);" >/dev/null
GET3=$(as_service "select * from get_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid);")
assert_behav_eq "manual: address_line_2 vide -> NULL (chaîne vide dans le résultat -t)" "" "$(echo "$GET3" | cut -d'|' -f3)"
assert_behav_eq "manual: state_or_province vide -> NULL" "" "$(echo "$GET3" | cut -d'|' -f7)"
assert_behav_eq "manual: customer_name blanc -> NULL" "" "$(echo "$GET3" | cut -d'|' -f8)"
assert_behav_eq "manual: customer_email vide -> NULL" "" "$(echo "$GET3" | cut -d'|' -f9)"

log "=== [6c] COUNTRY — validation stricte ISO 3166-1 alpha-2 (mandat section 12/23) ==="
assert_struct_eq "country malformé ('France') rejeté" "1" "$(as_service_rc "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', 'x', null, 'y', '00000', 'France', null, null, null, null);")"
assert_struct_eq "country vide rejeté" "1" "$(as_service_rc "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', 'x', null, 'y', '00000', '', null, null, null, null);")"
assert_struct_eq "country null rejeté" "1" "$(as_service_rc "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', 'x', null, 'y', '00000', null, null, null, null, null);")"
assert_struct_eq "country '1 chiffre 1 lettre' rejeté" "1" "$(as_service_rc "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', 'x', null, 'y', '00000', 'F1', null, null, null, null);")"
as_service "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', 'x', null, 'y', '00000', 'be', null, null, null, null);" >/dev/null
GET_BE=$(as_service "select * from get_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid);")
assert_behav_eq "country 'be' minuscule normalisé en 'BE'" "BE" "$(echo "$GET_BE" | cut -d'|' -f6)"

log "=== [6d] UPSERT — reconfirmation écrase l'ancienne valeur (mandat: possibilité de re-choisir) ==="
as_service "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', 'Nouvelle rue', null, 'Marseille', '13001', 'FR', null, null, null, null);" >/dev/null
GET_UPSERT=$(as_service "select * from get_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid);")
assert_behav_eq "upsert: nouvelle valeur remplace l'ancienne" "Nouvelle rue|Marseille" "$(echo "$GET_UPSERT" | cut -d'|' -f2,4)"
assert_struct_eq "upsert: une seule ligne pour cette commande (pas de doublon)" "1" "$(sql "select count(*) from order_billing_context where order_id='$OID_TABLE';")"

# ------------------------------------------------------------
# [6e] CORRECTIF v2 (ferme P3B6-BILLING-TRUNCATION-01) — bornes EXACTES
# pour le mode 'manual' : limite PASS, limite+1 FAIL, valeur stockée
# jamais raccourcie (mandat v2 section 5 : "critically prove no
# resulting stored/mapped value is silently shortened").
# ------------------------------------------------------------
log "=== [6e] manual — bornes exactes (limite PASS / limite+1 FAIL), aucune valeur stockée n'est raccourcie ==="
S50=$(python3 -c "print('a'*50)")
S51=$(python3 -c "print('a'*51)")
S10=$(python3 -c "print('1'*10)")
S11=$(python3 -c "print('1'*11)")
S45=$(python3 -c "print('n'*45)")
S46=$(python3 -c "print('n'*46)")
EMAIL_LOCAL_94=$(python3 -c "print('e'*88)")   # 88 + '@x.com' (6) = 94, sous 100
EMAIL_LOCAL_101=$(python3 -c "print('e'*95)")  # 95 + '@x.com' (6) = 101, au-dessus de 100
S18=$(python3 -c "print('1'*18)")
S19=$(python3 -c "print('1'*19)")

# address_line_1 : 50 PASS, 51 FAIL
as_service "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', '$S50', null, 'Paris', '75001', 'FR', null, null, null, null);" >/dev/null
GET_B1=$(as_service "select * from get_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid);")
assert_behav_eq "address_line_1 exactement 50 -> accepté, valeur COMPLÈTE conservée (jamais raccourcie)" "$S50" "$(echo "$GET_B1" | cut -d'|' -f2)"
assert_struct_eq "address_line_1 51 caractères -> REJETÉ (fail-closed, jamais tronqué à 50)" "1" "$(as_service_rc "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', '$S51', null, 'Paris', '75001', 'FR', null, null, null, null);")"

# city : 50 PASS, 51 FAIL
as_service "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', '1 rue Test', null, '$S50', '75001', 'FR', null, null, null, null);" >/dev/null
GET_B2=$(as_service "select * from get_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid);")
assert_behav_eq "city exactement 50 -> accepté, valeur COMPLÈTE conservée" "$S50" "$(echo "$GET_B2" | cut -d'|' -f4)"
assert_struct_eq "city 51 caractères -> REJETÉ (fail-closed, jamais tronqué à 50)" "1" "$(as_service_rc "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', '1 rue Test', null, '$S51', '75001', 'FR', null, null, null, null);")"

# postal_code : 10 PASS, 11 FAIL
as_service "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', '1 rue Test', null, 'Paris', '$S10', 'FR', null, null, null, null);" >/dev/null
GET_B3=$(as_service "select * from get_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid);")
assert_behav_eq "postal_code exactement 10 -> accepté, valeur COMPLÈTE conservée" "$S10" "$(echo "$GET_B3" | cut -d'|' -f5)"
assert_struct_eq "postal_code 11 caractères -> REJETÉ (fail-closed, jamais tronqué à 10)" "1" "$(as_service_rc "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', '1 rue Test', null, 'Paris', '$S11', 'FR', null, null, null, null);")"

# address_line_2 (optionnel) : 50 PASS, 51 FAIL (jamais omis silencieusement s'il est FOURNI mais trop long -- politique "fourni-invalide -> rejette")
as_service "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', '1 rue Test', '$S50', 'Paris', '75001', 'FR', null, null, null, null);" >/dev/null
GET_B4=$(as_service "select * from get_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid);")
assert_behav_eq "address_line_2 exactement 50 -> accepté, valeur COMPLÈTE conservée" "$S50" "$(echo "$GET_B4" | cut -d'|' -f3)"
assert_struct_eq "address_line_2 FOURNI à 51 caractères -> REJETÉ explicitement (politique: fourni-mais-invalide rejette, jamais omis silencieusement)" "1" "$(as_service_rc "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', '1 rue Test', '$S51', 'Paris', '75001', 'FR', null, null, null, null);")"

# state_or_province (optionnel) : 10 PASS, 11 FAIL
as_service "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', '1 rue Test', null, 'Paris', '75001', 'FR', '$S10', null, null, null);" >/dev/null
GET_B5=$(as_service "select * from get_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid);")
assert_behav_eq "state_or_province exactement 10 -> accepté, valeur COMPLÈTE conservée" "$S10" "$(echo "$GET_B5" | cut -d'|' -f7)"
assert_struct_eq "state_or_province FOURNI à 11 caractères -> REJETÉ explicitement" "1" "$(as_service_rc "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', '1 rue Test', null, 'Paris', '75001', 'FR', '$S11', null, null, null);")"

# customer_name (optionnel) : 45 PASS, 46 FAIL
as_service "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', '1 rue Test', null, 'Paris', '75001', 'FR', null, '$S45', null, null);" >/dev/null
GET_B6=$(as_service "select * from get_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid);")
assert_behav_eq "customer_name exactement 45 -> accepté, valeur COMPLÈTE conservée" "$S45" "$(echo "$GET_B6" | cut -d'|' -f8)"
assert_struct_eq "customer_name FOURNI à 46 caractères -> REJETÉ explicitement" "1" "$(as_service_rc "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', '1 rue Test', null, 'Paris', '75001', 'FR', null, '$S46', null, null);")"

# customer_email (optionnel) : max documenté (100) PASS, max+1 FAIL
EMAIL_OK="${EMAIL_LOCAL_94}@x.com"    # 94 caractères, <=100
EMAIL_TOO_LONG="${EMAIL_LOCAL_101}@x.com"  # 101 caractères, >100
as_service "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', '1 rue Test', null, 'Paris', '75001', 'FR', null, null, '$EMAIL_OK', null);" >/dev/null
GET_B7=$(as_service "select * from get_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid);")
assert_behav_eq "customer_email sous la borne (94<=100) -> accepté, valeur COMPLÈTE conservée" "$EMAIL_OK" "$(echo "$GET_B7" | cut -d'|' -f9)"
assert_struct_eq "customer_email FOURNI au-dessus de la borne (101>100) -> REJETÉ explicitement" "1" "$(as_service_rc "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', '1 rue Test', null, 'Paris', '75001', 'FR', null, null, '$EMAIL_TOO_LONG', null);")"

# customer_phone (optionnel) : 18 PASS, 19 FAIL
as_service "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', '1 rue Test', null, 'Paris', '75001', 'FR', null, null, null, '$S18');" >/dev/null
GET_B8=$(as_service "select * from get_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid);")
assert_behav_eq "customer_phone exactement 18 -> accepté, valeur COMPLÈTE conservée" "$S18" "$(echo "$GET_B8" | cut -d'|' -f10)"
assert_struct_eq "customer_phone FOURNI à 19 caractères -> REJETÉ explicitement" "1" "$(as_service_rc "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'manual', '1 rue Test', null, 'Paris', '75001', 'FR', null, null, null, '$S19');")"

# ------------------------------------------------------------
# [6f] CORRECTIF v2 (ferme P3B6-SOURCE-MAPPING-01, LOW -- garde SQL
# déjà exhaustive, vérifiée ici explicitement) : `p_source` en dehors
# de {'manual','delivery_reuse'} DOIT échouer, jamais retomber
# silencieusement sur l'une des deux valeurs connues.
# ------------------------------------------------------------
log "=== [6f] p_source exhaustif — toute valeur hors {'manual','delivery_reuse'} est REJETÉE ==="
assert_struct_eq "p_source='automatic' (valeur inconnue) -> REJETÉ" "1" "$(as_service_rc "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'automatic', '1 rue Test', null, 'Paris', '75001', 'FR', null, null, null, null);")"
assert_struct_eq "p_source='' (chaîne vide) -> REJETÉ" "1" "$(as_service_rc "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, '', '1 rue Test', null, 'Paris', '75001', 'FR', null, null, null, null);")"
assert_struct_eq "p_source='Manual' (casse différente) -> REJETÉ (comparaison sensible à la casse, jamais normalisée silencieusement)" "1" "$(as_service_rc "select * from set_order_billing_context('$OID_TABLE'::uuid, '$TOKEN_TABLE'::uuid, 'Manual', '1 rue Test', null, 'Paris', '75001', 'FR', null, null, null, null);")"

# ------------------------------------------------------------
# [7] BEHAV — get_order_billing_context : possession + vide-pas-erreur
# ------------------------------------------------------------
log "=== [7] get_order_billing_context — possession + ensemble vide ==="
assert_struct_eq "possession invalide (mauvais token) rejetée sur get" "1" "$(as_service_rc "select * from get_order_billing_context('$OID_DELIVERY'::uuid, gen_random_uuid());")"
assert_struct_eq "possession invalide (mauvais token) rejetée sur set" "1" "$(as_service_rc "select * from set_order_billing_context('$OID_DELIVERY'::uuid, gen_random_uuid(), 'manual', 'x', null, 'y', '00000', 'FR', null, null, null, null);")"
EMPTY_COUNT=$(as_service "select count(*) from get_order_billing_context('$OID_PICKUP'::uuid, '$TOKEN_PICKUP'::uuid);")
# (Nota: OID_PICKUP a déjà un contexte assemblé en [6] -- on teste plutôt une commande neuve.)
NEW_ROW=$(create_order_row "pickup" '{"name":"Sans Contexte","phone":"0600000000"}')
OID_NOCTX=$(echo "$NEW_ROW" | cut -d'|' -f1)
TOKEN_NOCTX=$(echo "$NEW_ROW" | cut -d'|' -f3)
assert_behav_eq "get sur commande sans contexte assemblé -> ensemble vide (0 ligne), pas d'erreur" "0" "$(as_service "select count(*) from get_order_billing_context('$OID_NOCTX'::uuid, '$TOKEN_NOCTX'::uuid);")"

# ------------------------------------------------------------
# [8] PRIVACY / GDPR — purge_old_customer_data supprime order_billing_context
# ------------------------------------------------------------
log "=== [8] GDPR — purge_old_customer_data ==="
sql "update orders set created_at = now() - interval '200 days' where id = '$OID_DELIVERY';" >/dev/null
BEFORE_PURGE=$(sql "select count(*) from order_billing_context where order_id='$OID_DELIVERY';")
assert_struct_eq "avant purge: ligne order_billing_context présente" "1" "$BEFORE_PURGE"
sql "select purge_old_customer_data(90);" >/dev/null
assert_behav_eq "après purge: ligne order_billing_context entièrement supprimée (whole-row delete)" "0" "$(sql "select count(*) from order_billing_context where order_id='$OID_DELIVERY';")"
assert_behav_eq "après purge: orders.personal_data_purged=true (comportement pré-existant, inchangé)" "t" "$(sql "select personal_data_purged from orders where id='$OID_DELIVERY';")"
assert_struct_eq "purge_old_customer_data reste refusé à service_role (grants pré-existants inchangés)" "1" "$(as_service_rc "select purge_old_customer_data(90);")"
assert_struct_eq "purge_old_customer_data reste refusé à anon" "1" "$(as_anon_rc "select purge_old_customer_data(90);")"

# ------------------------------------------------------------
# [9] NON-RÉGRESSION — création de commande sans street/city (API pré-
# existante) continue de fonctionner à l'identique pour tous les modes.
# ------------------------------------------------------------
log "=== [9] Non-régression create_order (modes sans adresse) ==="
assert_behav_eq "pickup: total correct" "10.00" "$(echo "$PICKUP_ROW" | cut -d'|' -f6)"
assert_behav_eq "table: total correct" "10.00" "$(echo "$TABLE_ROW" | cut -d'|' -f6)"

# ------------------------------------------------------------
# [10] GARDES DE SCHÉMA — préflight anti-dérive + anti double-application
# ------------------------------------------------------------
log "=== [10] Gardes de schéma (drift + double application) ==="
createdb "$DB_DRIFT"
build_common_bootstrap "$DB_DRIFT"
build_minimal_chain "$DB_DRIFT"
# PAS de v82/v83/v84/routing/delivery-pricing -- prérequis manquants.
DRIFT_RC=0
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/tmp/scanym-p3b6-drift-$$.log 2>&1 || DRIFT_RC=$?
assert_struct_eq "application sans prérequis LOT 2A échoue explicitement (SCANYM_SCHEMA_DRIFT)" "1" "$([ "$DRIFT_RC" -ne 0 ] && grep -q "SCANYM_SCHEMA_DRIFT" /tmp/scanym-p3b6-drift-$$.log && echo 1 || echo 0)"
rm -f /tmp/scanym-p3b6-drift-$$.log

REAPPLY_RC=0
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/tmp/scanym-p3b6-reapply-$$.log 2>&1 || REAPPLY_RC=$?
assert_struct_eq "double application refusée explicitement (garde anti-double-application)" "1" "$([ "$REAPPLY_RC" -ne 0 ] && grep -q "SCANYM_SCHEMA_DRIFT" /tmp/scanym-p3b6-reapply-$$.log && echo 1 || echo 0)"
rm -f /tmp/scanym-p3b6-reapply-$$.log

# ------------------------------------------------------------
# [10b] CORRECTIF v2 (ferme P3B6-CREATE-ORDER-GUARD-01) — une base
# portant la définition OBSOLÈTE de create_order (LOT 2A/v82 seul, SANS
# DRAFT-lot-server-delivery-fulfillment-pricing.sql) a EXACTEMENT la
# même signature de PARAMÈTRES à 7 arguments que la définition actuelle
# -- une simple vérification d'existence (v1 de ce lot) ou même
# to_regprocedure seul ne détecteraient PAS cette dérive. Seule la
# comparaison EXACTE de pg_get_function_result (contrat RETURNS TABLE)
# la détecte : v82 seul renvoie TABLE(order_id uuid, order_number
# bigint, public_token uuid, total numeric) -- 4 colonnes, PAS les 6
# attendues.
# ------------------------------------------------------------
log "=== [10b] Garde renforcée create_order — dérive de CONTRAT DE RETOUR (v82 seul, même signature de paramètres, colonnes de retour différentes) détectée explicitement ==="
DB_OLDCREATEORDER="scanym_payment_p3b6_oldco_$$"
createdb "$DB_OLDCREATEORDER"
build_common_bootstrap "$DB_OLDCREATEORDER"
build_minimal_chain "$DB_OLDCREATEORDER"
psql -d "$DB_OLDCREATEORDER" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" >/dev/null
psql -d "$DB_OLDCREATEORDER" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v83-lot2a4-privilege-hardening.sql" >/dev/null
psql -d "$DB_OLDCREATEORDER" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v84-lot2b1-delivery-info-rpc.sql" >/dev/null
# PAS de DRAFT-lot-fulfillment-routing-model.sql / -lot-b-rpc.sql /
# DRAFT-lot-server-delivery-fulfillment-pricing.sql -- create_order
# reste donc à son ancien contrat de retour (v82), sciemment, pour ce
# test.
assert_struct_eq "pré-condition du test: create_order a bien l'ANCIEN contrat de retour à 4 colonnes dans cette base de test dédiée" "TABLE(order_id uuid, order_number bigint, public_token uuid, total numeric)" "$(psql -d "$DB_OLDCREATEORDER" -X -A -t -c "select pg_get_function_result('public.create_order(text, text, jsonb, integer, jsonb, text, text)'::regprocedure);")"
OLDCO_RC=0
psql -d "$DB_OLDCREATEORDER" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/tmp/scanym-p3b6-oldco-$$.log 2>&1 || OLDCO_RC=$?
assert_struct_eq "application sur create_order à l'ANCIEN contrat de retour échoue explicitement (garde renforcée pg_catalog, pas seulement une existence de nom)" "1" "$([ "$OLDCO_RC" -ne 0 ] && grep -q "SCANYM_SCHEMA_DRIFT" /tmp/scanym-p3b6-oldco-$$.log && echo 1 || echo 0)"
assert_struct_eq "le message de garde mentionne explicitement le contrat RETURNS TABLE inattendu (pas un message générique)" "1" "$(grep -q "contrat RETURNS TABLE inattendu" /tmp/scanym-p3b6-oldco-$$.log && echo 1 || echo 0)"
rm -f /tmp/scanym-p3b6-oldco-$$.log
psql -c "drop database if exists \"$DB_OLDCREATEORDER\";" >/dev/null 2>&1 || true

# ============================================================
# RÉSUMÉ
# ============================================================
log "=== RÉSUMÉ ==="
log "STRUCT=$STRUCT_COUNT BEHAV=$BEHAV_COUNT CONC=$CONC_COUNT PASS=$PASS_COUNT FAIL=$FAIL_COUNT"

if [ "$PASS_COUNT" -ne "$((STRUCT_COUNT + BEHAV_COUNT + CONC_COUNT))" ]; then
  log "INVARIANT ROMPU: PASS_COUNT ($PASS_COUNT) != STRUCT+BEHAV+CONC ($((STRUCT_COUNT + BEHAV_COUNT + CONC_COUNT)))"
  exit 1
fi

if [ "$FAIL_COUNT" -ne 0 ]; then
  log "=== ÉCHECS ==="
  cat "$FAIL_LOG"
  exit 1
fi

log "TOUS LES TESTS ONT RÉUSSI ($PASS_COUNT / $PASS_COUNT)"
exit 0
