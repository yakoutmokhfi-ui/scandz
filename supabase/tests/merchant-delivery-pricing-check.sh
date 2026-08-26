#!/usr/bin/env bash
# ============================================================
# Scanym — DASHBOARD DELIVERY PRICING v1 — Harnais reproductible pour
# supabase/DRAFT-lot-merchant-delivery-pricing.sql (les deux RPC
# SECURITY DEFINER get_merchant_delivery_fulfillment_pricing /
# update_merchant_delivery_fulfillment_pricing).
#
# Baseline : chaîne réelle complète jusqu'à SADFP v3 installé (même
# patron que les harnais précédents), PLUS deux tenants FICTIFS
# GÉNÉRIQUES construits ici (aucune donnée Au Lait Cru / Sanaa réelle
# n'est modifiée -- mission : "No hardcoding: Au Lait Cru / 75 /
# Stuart / Chronofresh").
#
# Couvre les 22 comportements obligatoires de la mission (numérotés
# ci-dessous dans les logs), + non-régression provider/routage/Sanaa.
#
# CORRECTION APRÈS AUDIT WORK — DDP-V1-01 (HIGH, NaN monetary
# hardening) : sections EDS + 23-30 ci-dessous, ajoutées SANS modifier
# aucune des 22 vérifications d'origine.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/merchant-delivery-pricing-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_A_SQL="$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-model.sql"
DRAFT_B_SQL="$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-lot-b-rpc.sql"
DRAFT_SADFP_SQL="$SUPABASE_DIR/DRAFT-lot-server-delivery-fulfillment-pricing.sql"
DRAFT_MERCHANT_PRICING_SQL="$SUPABASE_DIR/DRAFT-lot-merchant-delivery-pricing.sql"
DB="scanym_merchant_pricing_$$"

PASS_COUNT=0
FAIL_COUNT=0

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
FAIL_LOG="/tmp/scanym-merchant-pricing-fails-$$.log"
: > "$FAIL_LOG"
fail() {
  FAIL_COUNT=$((FAIL_COUNT+1))
  printf '%s\n' "$*" >> "$FAIL_LOG"
  log "FAIL: $*"
}

DB_EDS="scanym_merchant_pricing_eds_$$"
cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_EDS\";" >/dev/null 2>&1 || true
  rm -f "${FAIL_LOG:-}" 2>/dev/null || true
}
trap cleanup EXIT

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}

sql() { psql -X -A -q -t -d "$DB" -c "$1"; }

# Appel en tant qu'utilisateur authentifié précis (test.uid), même
# patron que fulfillment-routing-lot-a-check.sh (AS_ILLICO_MEMBER...).
as_user() {
  local uid="$1" query="$2"
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$uid'; $query" 2>&1
}
as_user_rc() {
  local uid="$1" query="$2"
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$uid'; $query" >/dev/null 2>/tmp/scanym-merchant-pricing-err-$$.txt
  echo $?
}

log "=== Construction baseline $DB (chaîne réelle jusqu'à SADFP v3 + nouveau lot merchant pricing) ==="
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
pass "chaîne réelle appliquée jusqu'à SADFP v3 (installé en Production)"

log "=== Application de DRAFT-lot-merchant-delivery-pricing.sql (lot testé) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_MERCHANT_PRICING_SQL" >/dev/null
pass "DRAFT-lot-merchant-delivery-pricing.sql appliqué sans erreur"

# ============================================================
# FIXTURES GÉNÉRIQUES (aucune donnée Au Lait Cru / Sanaa réelle
# modifiée -- deux tenants FICTIFS, codes/zones génériques).
# ============================================================
log "=== Fixtures génériques (Tenant Un : 2 règles ; Tenant Deux : 1 règle, pour le test cross-tenant) ==="
OWNER_UID="10000000-0000-0000-0000-000000000001"
MANAGER_UID="10000000-0000-0000-0000-000000000002"
STAFF_UID="10000000-0000-0000-0000-000000000003"
OTHER_OWNER_UID="20000000-0000-0000-0000-000000000001"

psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into auth.users (id, email) values
  ('$OWNER_UID', 'owner@fixture-one.test'),
  ('$MANAGER_UID', 'manager@fixture-one.test'),
  ('$STAFF_UID', 'staff@fixture-one.test'),
  ('$OTHER_OWNER_UID', 'owner@fixture-two.test');

with resto as (
  insert into restaurants (name, slug, status) values ('Fixture Tenant One', 'fixture-tenant-one', 'active') returning id
),
config as (
  insert into restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number)
  select id, 0, 'EUR', '+33600000100' from resto
),
cat as (
  insert into menu_categories (restaurant_id, name, display_order, is_active)
  select id, 'Fixture', 1, true from resto returning id
)
insert into menu_items (category_id, name, price, is_available)
select cat.id, 'Article fixture (1 EUR)', 1.00, true from cat;

with resto2 as (
  insert into restaurants (name, slug, status) values ('Fixture Tenant Two', 'fixture-tenant-two', 'active') returning id
)
insert into restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number)
select id, 0, 'EUR', '+33600000200' from resto2;
SQL

TENANT_ONE=$(sql "select id from restaurants where slug='fixture-tenant-one';")
TENANT_TWO=$(sql "select id from restaurants where slug='fixture-tenant-two';")
ITEM_ONE=$(sql "select mi.id from menu_items mi join menu_categories mc on mc.id=mi.category_id where mc.restaurant_id='$TENANT_ONE' limit 1;")

psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into restaurant_users (user_id, restaurant_id, role) values
  ('$OWNER_UID', '$TENANT_ONE', 'owner'),
  ('$MANAGER_UID', '$TENANT_ONE', 'manager'),
  ('$STAFF_UID', '$TENANT_ONE', 'staff'),
  ('$OTHER_OWNER_UID', '$TENANT_TWO', 'owner');

insert into restaurant_sale_modes (restaurant_id, mode_code, enabled, display_order)
values ('$TENANT_ONE', 'delivery', true, 1);

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
   true, 'free_above_threshold', 15.00, 60.00);
SQL

RULE_ALPHA=$(sql "select id from restaurant_sale_mode_fulfillments where restaurant_id='$TENANT_ONE' and fulfillment_code='rule_alpha';")
RULE_BETA=$(sql "select id from restaurant_sale_mode_fulfillments where restaurant_id='$TENANT_ONE' and fulfillment_code='rule_beta';")
pass "fixtures construites (tenant_one=$TENANT_ONE, rule_alpha=$RULE_ALPHA fixed/7.00, rule_beta=$RULE_BETA free_above_threshold/15.00-60.00)"

SANAA_ID=$(sql "select id from restaurants where slug='sanaa-cookies';")
SANAA_OWNER_UID="30000000-0000-0000-0000-000000000001"
psql -d "$DB" -c "insert into auth.users (id, email) values ('$SANAA_OWNER_UID', 'owner@sanaa.test');" >/dev/null
psql -d "$DB" -c "insert into restaurant_users (user_id, restaurant_id, role) values ('$SANAA_OWNER_UID', '$SANAA_ID', 'owner');" >/dev/null
SANAA_RULES_BEFORE=$(sql "select count(*) from restaurant_sale_mode_fulfillments where restaurant_id='$SANAA_ID';")

# ============================================================
# 1. LECTURE — merchant can read own delivery pricing rules
# ============================================================
log "=== TEST 1 : lecture marchand (staff, tenant_one) ==="
READ_STAFF=$(as_user "$STAFF_UID" "select count(*) from get_merchant_delivery_fulfillment_pricing('$TENANT_ONE');")
assert_eq "1. staff peut lire les 2 règles de tenant_one" "2" "$READ_STAFF"
READ_MODES=$(as_user "$STAFF_UID" "select string_agg(pricing_mode, ',' order by pricing_mode) from get_merchant_delivery_fulfillment_pricing('$TENANT_ONE');")
assert_eq "1b. les 2 pricing_mode initiaux sont lus correctement (fixed + free_above_threshold)" "fixed,free_above_threshold" "$READ_MODES"
LABEL_FALLBACK=$(as_user "$STAFF_UID" "select fulfillment_label from get_merchant_delivery_fulfillment_pricing('$TENANT_ONE') where pricing_mode='free_above_threshold';")
assert_eq "1c. étiquette lisible pour la règle de repli mentionne 'repli', jamais fulfillment_code/provider brut" "true" "$(echo "$LABEL_FALLBACK" | grep -qi "repli" && echo true || echo false)"
NO_PROVIDER_LEAK=$(as_user "$STAFF_UID" "select fulfillment_label from get_merchant_delivery_fulfillment_pricing('$TENANT_ONE');" | grep -ci "internal\|rule_alpha\|rule_beta" || true)
assert_eq "1d. aucune fuite de provider/fulfillment_code brut dans les étiquettes" "0" "$NO_PROVIDER_LEAK"

# ============================================================
# 2/3. ÉCRITURE fixed — owner puis manager
# ============================================================
log "=== TEST 2 : owner peut mettre à jour 'fixed' ==="
as_user "$OWNER_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_ALPHA','fixed',8.50,null,'Texte owner (fixture).');" >/dev/null
assert_eq "2. rule_alpha.fixed_fee=8.50 après update owner" "8.50" "$(sql "select fixed_fee from restaurant_sale_mode_fulfillments where id='$RULE_ALPHA';")"
assert_eq "2b. rule_alpha.customer_text mis à jour par owner" "Texte owner (fixture)." "$(sql "select customer_text from restaurant_sale_mode_fulfillments where id='$RULE_ALPHA';")"

log "=== TEST 3 : manager peut mettre à jour 'fixed' ==="
as_user "$MANAGER_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_ALPHA','fixed',9.90,null,'Texte manager (fixture).');" >/dev/null
assert_eq "3. rule_alpha.fixed_fee=9.90 après update manager" "9.90" "$(sql "select fixed_fee from restaurant_sale_mode_fulfillments where id='$RULE_ALPHA';")"

# ============================================================
# 4/5/6. ÉCRITURE free_above_threshold — owner, seuil, texte
# ============================================================
log "=== TEST 4/5/6 : owner peut mettre à jour 'free_above_threshold', seuil et texte persistent ==="
as_user "$OWNER_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_BETA','free_above_threshold',20.00,75.00,'Texte beta mis à jour (fixture).');" >/dev/null
assert_eq "4. rule_beta.pricing_mode=free_above_threshold après update owner" "free_above_threshold" "$(sql "select pricing_mode from restaurant_sale_mode_fulfillments where id='$RULE_BETA';")"
assert_eq "5. rule_beta.free_threshold=75.00 persiste" "75.00" "$(sql "select free_threshold from restaurant_sale_mode_fulfillments where id='$RULE_BETA';")"
assert_eq "6. rule_beta.customer_text persiste" "Texte beta mis à jour (fixture)." "$(sql "select customer_text from restaurant_sale_mode_fulfillments where id='$RULE_BETA';")"

# Snapshot structurel AVANT la suite des tentatives refusées, pour
# prouver l'immutabilité (tests 15-18) après TOUTES les tentatives.
STRUCT_BEFORE=$(sql "select provider || '|' || fulfillment_code || '|' || array_to_string(zone_prefixes,',') || '|' || is_fallback from restaurant_sale_mode_fulfillments where id='$RULE_ALPHA' order by id;")

# ============================================================
# 7. staff mutation rejected
# ============================================================
log "=== TEST 7 : staff ne peut PAS écrire (rejeté) ==="
STAFF_RC=$(as_user_rc "$STAFF_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_ALPHA','fixed',1.00,null,null);")
assert_eq "7. mutation staff rejetée (code de sortie non-zéro)" "1" "$STAFF_RC"
assert_eq "7b. erreur 42501 (Not authorized)" "1" "$(grep -c "42501\|Not authorized" /tmp/scanym-merchant-pricing-err-$$.txt || true)"
assert_eq "7c. rule_alpha.fixed_fee inchangé après tentative staff" "9.90" "$(sql "select fixed_fee from restaurant_sale_mode_fulfillments where id='$RULE_ALPHA';")"

# ============================================================
# 8. cross-tenant mutation rejected
# ============================================================
log "=== TEST 8 : owner d'un AUTRE tenant ne peut PAS écrire sur rule_alpha (cross-tenant) ==="
CROSS_RC=$(as_user_rc "$OTHER_OWNER_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_ALPHA','fixed',1.00,null,null);")
assert_eq "8. mutation cross-tenant rejetée (code de sortie non-zéro)" "1" "$CROSS_RC"
assert_eq "8b. erreur 42501 (Not authorized), aucun indice d'existence de la règle" "1" "$(grep -c "42501\|Not authorized" /tmp/scanym-merchant-pricing-err-$$.txt || true)"
assert_eq "8c. rule_alpha.fixed_fee inchangé après tentative cross-tenant" "9.90" "$(sql "select fixed_fee from restaurant_sale_mode_fulfillments where id='$RULE_ALPHA';")"

# ============================================================
# 9. unauthenticated mutation rejected
# ============================================================
log "=== TEST 9 : mutation non authentifiée rejetée (anon ET authenticated sans test.uid) ==="
ANON_RC=0
PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "select update_merchant_delivery_fulfillment_pricing('$RULE_ALPHA','fixed',1.00,null,null);" >/dev/null 2>/tmp/scanym-merchant-pricing-anon-err-$$.txt || ANON_RC=$?
assert_eq "9a. anon (aucun EXECUTE grant) : rejeté" "true" "$([ "$ANON_RC" -ne 0 ] && echo true || echo false)"
assert_eq "9b. anon : erreur de type permission denied" "1" "$(grep -ci "permission denied" /tmp/scanym-merchant-pricing-anon-err-$$.txt || true)"
NOAUTH_RC=0
PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "select update_merchant_delivery_fulfillment_pricing('$RULE_ALPHA','fixed',1.00,null,null);" >/dev/null 2>/tmp/scanym-merchant-pricing-noauth-err-$$.txt || NOAUTH_RC=$?
assert_eq "9c. authenticated sans test.uid (auth.uid() NULL) : rejeté" "true" "$([ "$NOAUTH_RC" -ne 0 ] && echo true || echo false)"
assert_eq "9d. erreur 28000 (Authentication required)" "1" "$(grep -c "28000\|Authentication required" /tmp/scanym-merchant-pricing-noauth-err-$$.txt || true)"
assert_eq "9e. rule_alpha.fixed_fee inchangé après tentatives non authentifiées" "9.90" "$(sql "select fixed_fee from restaurant_sale_mode_fulfillments where id='$RULE_ALPHA';")"

# ============================================================
# 10-14. Validation fail-closed (toutes en tant qu'owner légitime)
# ============================================================
log "=== TEST 10 : pricing_mode invalide rejeté ==="
V10_RC=$(as_user_rc "$OWNER_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_ALPHA','bogus_mode',5.00,null,null);")
assert_eq "10. pricing_mode invalide rejeté" "1" "$V10_RC"
assert_eq "10b. erreur 22023 (Invalid pricing_mode)" "1" "$(grep -c "22023\|Invalid pricing_mode" /tmp/scanym-merchant-pricing-err-$$.txt || true)"

log "=== TEST 11 : fixed_fee négatif rejeté ==="
V11_RC=$(as_user_rc "$OWNER_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_ALPHA','fixed',-1.00,null,null);")
assert_eq "11. fixed_fee négatif rejeté" "1" "$V11_RC"

log "=== TEST 12 : free_threshold négatif rejeté ==="
V12_RC=$(as_user_rc "$OWNER_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_ALPHA','free_above_threshold',5.00,-10.00,null);")
assert_eq "12. free_threshold négatif rejeté" "1" "$V12_RC"

log "=== TEST 13 : 'fixed' + free_threshold non NULL rejeté ==="
V13_RC=$(as_user_rc "$OWNER_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_ALPHA','fixed',5.00,10.00,null);")
assert_eq "13. combinaison fixed+threshold rejetée" "1" "$V13_RC"

log "=== TEST 14 : 'free_above_threshold' sans threshold rejeté ==="
V14_RC=$(as_user_rc "$OWNER_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_ALPHA','free_above_threshold',5.00,null,null);")
assert_eq "14. free_above_threshold sans threshold rejeté" "1" "$V14_RC"

assert_eq "10-14. aucune de ces 5 tentatives invalides n'a modifié rule_alpha (toujours 9.90/fixed)" "9.90|fixed" "$(sql "select fixed_fee || '|' || pricing_mode from restaurant_sale_mode_fulfillments where id='$RULE_ALPHA';")"

# ============================================================
# 15-18. Champs structurels inchangés (immutabilité)
# ============================================================
log "=== TEST 15-18 : provider/fulfillment_code/zone_prefixes/is_fallback inchangés ==="
STRUCT_AFTER=$(sql "select provider || '|' || fulfillment_code || '|' || array_to_string(zone_prefixes,',') || '|' || is_fallback from restaurant_sale_mode_fulfillments where id='$RULE_ALPHA' order by id;")
assert_eq "15-18. structure de rule_alpha strictement inchangée après TOUTES les tentatives (autorisées et refusées)" "$STRUCT_BEFORE" "$STRUCT_AFTER"

# ============================================================
# 19. order pricing still server-authoritative
# ============================================================
log "=== TEST 19 : checkout reste server-authoritative (utilise le prix mis à jour, jamais un prix client) ==="
ORDER_T1=$(PGOPTIONS='-c role=anon' psql -X -A -t -d "$DB" -c "select subtotal, delivery_fee, total from create_order('fixture-tenant-one','delivery', jsonb_build_array(jsonb_build_object('menu_item_id','$ITEM_ONE','quantity',1,'option_item_id',null)), null, jsonb_build_object('name','Client Fixture','phone','0600000099','email','c@example.com','address','Adresse Fixture','postalCode','10500'), null, 'fr');")
assert_eq "19. delivery_fee du checkout = 9.90 (valeur serveur mise à jour par owner, PAS une valeur cliente)" "1.00|9.90|10.90" "$ORDER_T1"

# ============================================================
# 20. provider still absent from public customer output
# ============================================================
log "=== TEST 20 : provider toujours absent du RPC public (inchangé par ce lot) ==="
PUBLIC_RPC=$(PGOPTIONS='-c role=anon' psql -X -A -t -d "$DB" -c "select * from get_restaurant_public_delivery_fulfillments('$TENANT_ONE');")
assert_eq "20. aucune fuite 'internal'/provider via le RPC public" "0" "$(echo "$PUBLIC_RPC" | grep -ci "internal" || true)"

# ============================================================
# 21/22. tenant avec zéro règle -> état vide, aucune création auto
# ============================================================
log "=== TEST 21/22 : Sanaa (0 règle de livraison) -> lecture vide, aucune création automatique ==="
SANAA_READ=$(as_user "$SANAA_OWNER_UID" "select count(*) from get_merchant_delivery_fulfillment_pricing('$SANAA_ID');")
assert_eq "21. lecture Sanaa (0 règle) renvoie 0 ligne -- état vide côté Dashboard" "0" "$SANAA_READ"
assert_eq "22. aucune règle créée automatiquement pour Sanaa par la simple lecture" "$SANAA_RULES_BEFORE" "$(sql "select count(*) from restaurant_sale_mode_fulfillments where restaurant_id='$SANAA_ID';")"

# ============================================================
# CORRECTION APRÈS AUDIT WORK — DDP-V1-01 (HIGH) — NaN MONETARY
# HARDENING. Tests 23-30 ci-dessous + section EDS (Existing Data
# Safety) séparée, ajoutés SANS modifier les 22 tests d'origine.
# ============================================================

# ------------------------------------------------------------
# EDS. SÉCURITÉ DES DONNÉES EXISTANTES : le préflight de la migration
# corrigée doit faire échouer TOUTE la migration (transaction
# begin/commit) si une ligne existante contient déjà NaN/Infinity --
# AVANT toute modification de contrainte, sans normalisation
# silencieuse. Nécessite une base JETABLE SÉPARÉE dans laquelle une
# valeur NaN est insérée SOUS L'ANCIENNE contrainte (pré-correction,
# qui l'acceptait -- c'est précisément DDP-V1-01), PUIS on applique la
# migration corrigée par-dessus et on vérifie l'échec explicite + le
# rollback complet (aucune des 2 fonctions RPC n'existe après l'échec).
# ------------------------------------------------------------
log "=== TEST EDS : sécurité des données existantes (préflight avant durcissement de contrainte) ==="
psql -c "drop database if exists \"$DB_EDS\";" >/dev/null 2>&1 || true
createdb "$DB_EDS"
psql -d "$DB_EDS" >/dev/null <<'SQL'
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
  psql -d "$DB_EDS" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  psql -d "$DB_EDS" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
done
for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql; do
  psql -d "$DB_EDS" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
done
psql -d "$DB_EDS" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-illico-v2.sql" >/dev/null 2>&1
psql -d "$DB_EDS" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-sanaa.sql" >/dev/null 2>&1
psql -d "$DB_EDS" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-sirocco-demo.sql" >/dev/null 2>&1
psql -d "$DB_EDS" -c "update restaurants set status='active';" >/dev/null 2>&1
psql -d "$DB_EDS" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" >/dev/null
psql -d "$DB_EDS" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v83-lot2a4-privilege-hardening.sql" >/dev/null
psql -d "$DB_EDS" -c "alter default privileges in schema public grant execute on functions to service_role;" >/dev/null
psql -d "$DB_EDS" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v84-lot2b1-delivery-info-rpc.sql" >/dev/null
psql -d "$DB_EDS" -v ON_ERROR_STOP=1 -f "$DRAFT_A_SQL" >/dev/null
psql -d "$DB_EDS" -v ON_ERROR_STOP=1 -f "$DRAFT_B_SQL" >/dev/null
psql -d "$DB_EDS" -v ON_ERROR_STOP=1 -f "$DRAFT_SADFP_SQL" >/dev/null
pass "EDS : chaîne réelle appliquée jusqu'à SADFP v3 (contrainte PRÉ-correction, vulnérable) sur base séparée"

EDS_TENANT=$(psql -X -A -q -t -d "$DB_EDS" -c "insert into restaurants (name, slug, status) values ('Fixture EDS', 'fixture-eds', 'active') returning id;")
psql -d "$DB_EDS" -c "insert into restaurant_sale_modes (restaurant_id, mode_code, enabled, display_order) values ('$EDS_TENANT','delivery',true,1);" >/dev/null
EDS_INSERT_RC=0
psql -d "$DB_EDS" -c "insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, zone_prefixes, is_fallback, display_order, enabled, pricing_mode, fixed_fee, free_threshold) values ('$EDS_TENANT','delivery','rule_eds','internal','{}'::text[],false,10,true,'fixed','NaN'::numeric,null);" >/dev/null 2>/tmp/scanym-eds-insert-err-$$.txt || EDS_INSERT_RC=$?
assert_eq "EDS-1. AVANT correction : la contrainte SADFP v3 d'origine ACCEPTE 'NaN'::numeric (preuve directe de DDP-V1-01, contrainte non durcie)" "0" "$EDS_INSERT_RC"

EDS_MIGRATION_RC=0
psql -d "$DB_EDS" -v ON_ERROR_STOP=1 -f "$DRAFT_MERCHANT_PRICING_SQL" >/dev/null 2>/tmp/scanym-eds-migration-err-$$.txt || EDS_MIGRATION_RC=$?
assert_eq "EDS-2. la migration corrigée ÉCHOUE (préflight) car une ligne existante contient déjà NaN" "1" "$([ "$EDS_MIGRATION_RC" -ne 0 ] && echo 1 || echo 0)"
assert_eq "EDS-3. message d'erreur explicite SCANYM_EXISTING_DATA_NONFINITE (pas un échec générique)" "1" "$(grep -c "SCANYM_EXISTING_DATA_NONFINITE" /tmp/scanym-eds-migration-err-$$.txt || true)"
EDS_FN_EXISTS=$(psql -X -A -q -t -d "$DB_EDS" -c "select exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='update_merchant_delivery_fulfillment_pricing');")
assert_eq "EDS-4. rollback complet : la migration échouée n'a laissé AUCUNE des 2 fonctions RPC installées (begin/commit atomique)" "f" "$EDS_FN_EXISTS"
EDS_ROW_UNCHANGED=$(psql -X -A -q -t -d "$DB_EDS" -c "select fixed_fee::text from restaurant_sale_mode_fulfillments where restaurant_id='$EDS_TENANT';")
assert_eq "EDS-5. la ligne NaN existante n'a été ni supprimée ni silencieusement normalisée par la tentative de migration" "NaN" "$EDS_ROW_UNCHANGED"
rm -f /tmp/scanym-eds-insert-err-$$.txt /tmp/scanym-eds-migration-err-$$.txt
psql -c "drop database if exists \"$DB_EDS\";" >/dev/null 2>&1 || true

# ------------------------------------------------------------
# A/23. RPC : fixed_fee = 'NaN'::numeric rejeté (pricing_mode='fixed')
# ------------------------------------------------------------
log "=== TEST 23 (A) : fixed_fee NaN via RPC (pricing_mode=fixed) rejeté, zéro mutation ==="
V23_RC=$(as_user_rc "$OWNER_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_ALPHA','fixed','NaN'::numeric,null,null);")
assert_eq "23. fixed_fee NaN rejeté (code de sortie non-zéro)" "1" "$V23_RC"
assert_eq "23b. erreur 22023 (finite numeric)" "1" "$(grep -c "22023\|finite numeric" /tmp/scanym-merchant-pricing-err-$$.txt || true)"
assert_eq "23c. rule_alpha.fixed_fee inchangé (aucune mutation)" "9.90" "$(sql "select fixed_fee from restaurant_sale_mode_fulfillments where id='$RULE_ALPHA';")"

# ------------------------------------------------------------
# B/24. RPC : free_threshold = 'NaN'::numeric rejeté
# (pricing_mode='free_above_threshold', fixed_fee valide)
# ------------------------------------------------------------
log "=== TEST 24 (B) : free_threshold NaN via RPC (pricing_mode=free_above_threshold, fixed_fee valide) rejeté, zéro mutation ==="
V24_RC=$(as_user_rc "$OWNER_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_BETA','free_above_threshold',20.00,'NaN'::numeric,null);")
assert_eq "24. free_threshold NaN rejeté (code de sortie non-zéro)" "1" "$V24_RC"
assert_eq "24b. erreur 22023 (finite numeric)" "1" "$(grep -c "22023\|finite numeric" /tmp/scanym-merchant-pricing-err-$$.txt || true)"
assert_eq "24c. rule_beta inchangé (20.00 attendu absent -- valeurs pré-tentative conservées)" "20.00|75.00" "$(sql "select fixed_fee || '|' || free_threshold from restaurant_sale_mode_fulfillments where id='$RULE_BETA';")"

# ------------------------------------------------------------
# 25/26. Même bascule pour +Infinity (justifiée empiriquement : même
# contournement que NaN, ET persistable par le type numeric --
# mission : "do not speculate", vérifié directement avant ce lot).
# ------------------------------------------------------------
log "=== TEST 25 : fixed_fee = Infinity via RPC rejeté ==="
V25_RC=$(as_user_rc "$OWNER_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_ALPHA','fixed','Infinity'::numeric,null,null);")
assert_eq "25. fixed_fee Infinity rejeté" "1" "$V25_RC"
assert_eq "25b. rule_alpha.fixed_fee toujours inchangé" "9.90" "$(sql "select fixed_fee from restaurant_sale_mode_fulfillments where id='$RULE_ALPHA';")"

log "=== TEST 26 : free_threshold = Infinity via RPC rejeté ==="
V26_RC=$(as_user_rc "$OWNER_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_BETA','free_above_threshold',20.00,'Infinity'::numeric,null);")
assert_eq "26. free_threshold Infinity rejeté" "1" "$V26_RC"
assert_eq "26b. rule_beta toujours inchangé" "20.00|75.00" "$(sql "select fixed_fee || '|' || free_threshold from restaurant_sale_mode_fulfillments where id='$RULE_BETA';")"

# ------------------------------------------------------------
# C/27-28. Écriture privilégiée DIRECTE (hors RPC) : prouve que la
# protection ne dépend PAS uniquement du RPC -- la contrainte de table
# elle-même doit rejeter NaN, via le chemin privilégié du harnais
# (rôle exécutant les commandes d'administration de la base, déjà
# utilisé pour amorcer les fixtures ci-dessus -- même patron que
# "update restaurants set status='active';" en tête de script).
# ------------------------------------------------------------
log "=== TEST 27 (C) : écriture privilégiée directe de NaN dans fixed_fee -- doit violer la contrainte CHECK ==="
DIRECT_NAN_RC=0
psql -d "$DB" -c "update restaurant_sale_mode_fulfillments set fixed_fee = 'NaN'::numeric where id='$RULE_ALPHA';" >/dev/null 2>/tmp/scanym-direct-nan-err-$$.txt || DIRECT_NAN_RC=$?
assert_eq "27. UPDATE direct privilégié de fixed_fee=NaN rejeté par la contrainte de table" "1" "$([ "$DIRECT_NAN_RC" -ne 0 ] && echo 1 || echo 0)"
assert_eq "27b. message de violation de contrainte CHECK (fixed_fee_check)" "1" "$(grep -ci "constraint\|check" /tmp/scanym-direct-nan-err-$$.txt || true)"
assert_eq "27c. rule_alpha.fixed_fee inchangé après l'écriture directe rejetée" "9.90" "$(sql "select fixed_fee from restaurant_sale_mode_fulfillments where id='$RULE_ALPHA';")"

log "=== TEST 28 (C) : écriture privilégiée directe de NaN dans free_threshold -- doit violer la contrainte CHECK ==="
DIRECT_NAN_FT_RC=0
psql -d "$DB" -c "update restaurant_sale_mode_fulfillments set free_threshold = 'NaN'::numeric where id='$RULE_BETA';" >/dev/null 2>/tmp/scanym-direct-nan-ft-err-$$.txt || DIRECT_NAN_FT_RC=$?
assert_eq "28. UPDATE direct privilégié de free_threshold=NaN rejeté par la contrainte de table" "1" "$([ "$DIRECT_NAN_FT_RC" -ne 0 ] && echo 1 || echo 0)"
assert_eq "28b. message de violation de contrainte CHECK (free_threshold_check)" "1" "$(grep -ci "constraint\|check" /tmp/scanym-direct-nan-ft-err-$$.txt || true)"
assert_eq "28c. rule_beta inchangé après l'écriture directe rejetée" "20.00|75.00" "$(sql "select fixed_fee || '|' || free_threshold from restaurant_sale_mode_fulfillments where id='$RULE_BETA';")"
rm -f /tmp/scanym-direct-nan-err-$$.txt /tmp/scanym-direct-nan-ft-err-$$.txt

# ------------------------------------------------------------
# D/29-30. Valeurs valides toujours acceptées (non-régression), y
# compris la valeur limite 0 (bord de >= 0, distincte de NaN/Infinity).
# ------------------------------------------------------------
log "=== TEST 29 (D) : fixed_fee=0.00 (valeur limite valide) toujours accepté après durcissement ==="
as_user "$OWNER_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_ALPHA','fixed',0.00,null,'Texte limite zéro (fixture).');" >/dev/null
assert_eq "29. rule_alpha.fixed_fee=0.00 accepté (mode fixed, valeur limite)" "0.00" "$(sql "select fixed_fee from restaurant_sale_mode_fulfillments where id='$RULE_ALPHA';")"

log "=== TEST 30 (D) : free_above_threshold avec fixed_fee et free_threshold valides toujours accepté après durcissement ==="
as_user "$OWNER_UID" "select update_merchant_delivery_fulfillment_pricing('$RULE_BETA','free_above_threshold',20.00,0.00,'Texte limite seuil zéro (fixture).');" >/dev/null
assert_eq "30. rule_beta accepte fixed_fee=20.00/free_threshold=0.00 (valeur limite valide, mode free_above_threshold)" "20.00|0.00" "$(sql "select fixed_fee || '|' || free_threshold from restaurant_sale_mode_fulfillments where id='$RULE_BETA';")"

# Restaure rule_alpha/rule_beta à leur état attendu par les vérifications
# 15-18 déjà exécutées plus haut (ces 2 lignes n'affectent aucune
# assertion déjà validée, la comparaison STRUCT_BEFORE/STRUCT_AFTER a
# déjà eu lieu avant ce bloc).

# ============================================================
# GARDE-FOU SUPPLÉMENTAIRE : aucun GRANT UPDATE direct sur la table
# pour authenticated (mission SECURITY : "Do NOT grant authenticated
# users direct UPDATE").
# ============================================================
log "=== GARDE-FOU : aucun privilège UPDATE direct pour authenticated sur restaurant_sale_mode_fulfillments ==="
DIRECT_UPDATE=$(sql "select has_table_privilege('authenticated', 'public.restaurant_sale_mode_fulfillments', 'UPDATE');")
assert_eq "authenticated n'a AUCUN privilège UPDATE direct sur la table (écriture exclusivement via la RPC)" "f" "$DIRECT_UPDATE"

rm -f /tmp/scanym-merchant-pricing-err-$$.txt /tmp/scanym-merchant-pricing-anon-err-$$.txt /tmp/scanym-merchant-pricing-noauth-err-$$.txt

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
  echo "DES VÉRIFICATIONS DASHBOARD DELIVERY PRICING v1 ONT ÉCHOUÉ"
  exit 1
fi
echo "TOUTES LES VÉRIFICATIONS DASHBOARD DELIVERY PRICING v1 ONT RÉUSSI"
