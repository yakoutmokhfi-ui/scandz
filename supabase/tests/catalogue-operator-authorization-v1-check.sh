#!/usr/bin/env bash
# ============================================================
# Scanym — OPERATOR BACKOFFICE — OB-2 — harnais SQL réel
# (PostgreSQL réel, aucune simulation), exécuté en tant qu'utilisateur
# système postgres (authentification peer).
#
# Construit la chaîne de migrations RÉELLES jusqu'au baseline requis
# d81eaba03b58e2cfd4af575113ab0ad08fec37da (main, incluant MERCHANT
# LEGAL & TAX PROFILE v1.2 déjà publié -- chaîne identique et
# proprement réutilisée depuis supabase/tests/merchant-legal-tax-
# profile-v1-check.sh, qui l'a déjà prouvée applicable jusqu'à ce
# baseline), puis applique supabase/DRAFT-lot-catalogue-operator-
# authorization-v1.sql (état v1 + v1.1, réécrit sur place -- fichier
# jamais publié, même convention que legal-tax v1->v1.1->v1.2) et
# prouve chaque item de la matrice de test obligatoire du mandat OB-2
# ainsi que du mandat de complétion v1.1.
#
# PÉRIMÈTRE v1 (rappel) : assert_category_role, assert_product_role,
# assert_subcategory_role, create_category, create_product (corps
# uniquement, aucune signature).
#
# PÉRIMÈTRE v1.1 (AJOUT -- CATALOGUE OPERATOR READ-PATH COMPLETION) :
# get_merchant_catalogue(uuid, boolean) -- RPC de LECTURE, corps
# uniquement, même forme de retour (29 colonnes), ajout du seul
# bypass "or public.is_scanym_operator()" en complément du contrôle
# de membership restaurant_users préexistant (qui, lui, n'a jamais
# filtré par rôle -- owner/manager/staff gardent donc EXACTEMENT le
# même accès lecture qu'avant ce lot, cf. section G, tests G1-G3).
#
# La chaîne ci-dessous n'a donc PAS besoin d'inclure MERCHANT LEGAL &
# TAX PROFILE v1 elle-même (receipt_settings, sans rapport avec le
# catalogue) -- elle s'arrête juste avant, au même point que la
# chaîne prouvée par le harnais legal-tax v1.2 AVANT l'application de
# son propre lot.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/catalogue-operator-authorization-v1-check.sh"
# ============================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DRAFT_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-operator-authorization-v1.sql"
DB="scanym_ob2_catalogue_auth_$$"

PASS=0
FAIL=0
FAIL_LOG="/tmp/scanym-ob2-fails-$$.log"
: > "$FAIL_LOG"

log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS=$((PASS+1)); log "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); printf '%s\n' "$1" >> "$FAIL_LOG"; log "FAIL: $1"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  rm -f "$FAIL_LOG" 2>/dev/null || true
}
trap cleanup EXIT

sql() { psql -X -A -q -t -d "$DB" -c "$1" 2>/tmp/scanym-ob2-err-$$.txt; }
sql_rc() { psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-ob2-out-$$.txt 2>/tmp/scanym-ob2-err-$$.txt; echo $?; }
sql_err() { cat /tmp/scanym-ob2-err-$$.txt 2>/dev/null; }

as_authenticated() {
  # $1 = uid, $2 = sql
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    2>/tmp/scanym-ob2-err-$$.txt
}
as_authenticated_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    >/tmp/scanym-ob2-out-$$.txt 2>/tmp/scanym-ob2-err-$$.txt
  echo $?
}
as_anon_rc() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-ob2-out-$$.txt 2>/tmp/scanym-ob2-err-$$.txt
  echo $?
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_ok() { # $1=desc $2=rc, attend 0
  if [ "$2" -eq 0 ]; then pass "$1 (rc=0)"; else fail "$1 — attendu rc=0, obtenu rc=$2 : $(sql_err)"; fi
}
assert_denied() { # $1=desc $2=rc, attend != 0
  if [ "$2" -ne 0 ]; then pass "$1 (rc=$2, refusé comme attendu)"; else fail "$1 — attendu un refus (rc!=0), obtenu rc=0"; fi
}

build_common_bootstrap() {
  psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
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

# Chaîne identique et déjà prouvée par supabase/tests/merchant-legal-tax-profile-v1-check.sh,
# arrêtée juste avant son propre lot (receipt_settings, sans rapport avec ce lot).
MINIMAL_CHAIN="schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql"
REST_CHAIN="migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v76-storage-origin-config.sql migration-v71-hardening.sql migration-v72-hardening.sql migration-v73-hardening.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql migration-v82-lot2a-sale-modes.sql migration-v83-lot2a4-privilege-hardening.sql migration-v84-lot2b1-delivery-info-rpc.sql DRAFT-lot-fulfillment-routing-model.sql DRAFT-lot-fulfillment-routing-lot-b-rpc.sql DRAFT-lot-server-delivery-fulfillment-pricing.sql DRAFT-lot-payment-p3b6-checkout-billing-context.sql DRAFT-lot-customer-order-tracking-foundation.sql DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql DRAFT-lot-receipt-invoice-tax-detail-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1-1-remediation.sql DRAFT-lot-payment-p1-foundation.sql DRAFT-lot-merchant-delivery-pricing.sql DRAFT-lot-orders-service-role-select-hardening.sql"

build_chain() {
  for f in $MINIMAL_CHAIN; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1 || { log "FATAL: échec application $f"; return 1; }
    psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  done
  for f in $REST_CHAIN; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1 || { log "FATAL: échec application $f"; return 1; }
  done
  return 0
}

log "=== [0] Construction $DB (chaîne réelle jusqu'au baseline) ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB" || { log "FATAL: createdb a échoué"; exit 1; }
build_common_bootstrap || { log "FATAL: bootstrap commun a échoué"; exit 1; }
build_chain || { log "FATAL: chaîne de migrations a échoué"; exit 1; }
pass "Chaîne complète appliquée jusqu'au prérequis (avant le lot testé)"

RC=$(sql_rc "$(cat "$DRAFT_SQL")")
if [ "$RC" -eq 0 ]; then
  pass "Application propre de CATALOGUE OPERATOR AUTHORIZATION v1"
else
  fail "Application du lot a échoué (rc=$RC) : $(sql_err)"
  cat "$FAIL_LOG"
  exit 1
fi
psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1

log "=== [1] Fixtures ==="
# Restaurant A (r1) et Restaurant B (r2), un opérateur Scanym GLOBAL
# (pas de ligne restaurant_users pour lui, ni sur A ni sur B).
sql "insert into public.restaurants (id, slug, name, is_active, status, country) values ('11111111-1111-1111-1111-111111111111','ra','Restaurant A', true, 'active', 'FR'), ('22222222-2222-2222-2222-222222222222','rb','Restaurant B', true, 'active', 'FR');" >/dev/null
sql "insert into public.restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number) values ('11111111-1111-1111-1111-111111111111','EUR',1,'+33600000000'), ('22222222-2222-2222-2222-222222222222','EUR',1,'+33600000001');" >/dev/null
sql "insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner-a@test.local'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','manager-a@test.local'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','staff-a@test.local'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd','unrelated@test.local'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','owner-b@test.local'),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff','operator@test.local');" >/dev/null
sql "insert into public.restaurant_users (restaurant_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner'),
  ('11111111-1111-1111-1111-111111111111','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','manager'),
  ('11111111-1111-1111-1111-111111111111','cccccccc-cccc-cccc-cccc-cccccccccccc','staff'),
  ('22222222-2222-2222-2222-222222222222','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','owner');" >/dev/null
# ffffffff = opérateur Scanym global : ligne scanym_operators, AUCUNE
# ligne restaurant_users (ni A ni B) -- exactement le cas mandat #6.
sql "insert into public.scanym_operators (user_id) values ('ffffffff-ffff-ffff-ffff-ffffffffffff');" >/dev/null

# Une catégorie et un produit d'amorçage sur A (créés directement en
# SQL, hors RPC, pour ne pas dépendre du comportement testé).
sql "insert into public.menu_categories (id, restaurant_id, name, display_order, is_active) values ('caaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Cat A', 1, true);" >/dev/null
sql "insert into public.menu_items (id, category_id, name, price, display_order, is_available) values ('da000000-0000-0000-0000-000000000001','caaaaaaa-0000-0000-0000-000000000001','Produit A', 5.00, 1, true);" >/dev/null
sql "insert into public.menu_categories (id, restaurant_id, name, display_order, is_active) values ('cbbbbbbb-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','Cat B', 1, true);" >/dev/null

UID_OWNER_A="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
UID_MANAGER_A="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
UID_STAFF_A="cccccccc-cccc-cccc-cccc-cccccccccccc"
UID_UNRELATED="dddddddd-dddd-dddd-dddd-dddddddddddd"
UID_OWNER_B="eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"
UID_OPERATOR="ffffffff-ffff-ffff-ffff-ffffffffffff"
CAT_A="caaaaaaa-0000-0000-0000-000000000001"
CAT_B="cbbbbbbb-0000-0000-0000-000000000001"
PROD_A="da000000-0000-0000-0000-000000000001"
RESTO_A="11111111-1111-1111-1111-111111111111"
RESTO_B="22222222-2222-2222-2222-222222222222"

# ============================================================
# SECTION A — create_category (contrôle en ligne) — matrice complète
# ============================================================
log "=== [A] create_category — matrice de test obligatoire ==="

RC=$(as_authenticated_rc "$UID_OWNER_A" "select create_category('$RESTO_A','A1 Owner',null);")
assert_ok "A1 owner de A -> ALLOWED sur A (create_category)" "$RC"

RC=$(as_authenticated_rc "$UID_MANAGER_A" "select create_category('$RESTO_A','A2 Manager',null);")
assert_ok "A2 manager de A -> ALLOWED sur A (create_category)" "$RC"

RC=$(as_authenticated_rc "$UID_STAFF_A" "select create_category('$RESTO_A','A3 Staff',null);")
assert_denied "A3 staff de A -> DENIED (create_category)" "$RC"

RC=$(as_authenticated_rc "$UID_UNRELATED" "select create_category('$RESTO_A','A4 Unrelated',null);")
assert_denied "A4 utilisateur authentifié non-lié -> DENIED (create_category)" "$RC"

RC=$(as_authenticated_rc "$UID_OWNER_B" "select create_category('$RESTO_A','A5 OwnerB-on-A',null);")
assert_denied "A5 owner de B -> DENIED sur A (create_category, cross-tenant)" "$RC"

RC=$(as_authenticated_rc "$UID_OPERATOR" "select create_category('$RESTO_A','A6 Operator-on-A',null);")
assert_ok "A6 opérateur SANS ligne restaurant_users pour A -> ALLOWED sur A (create_category)" "$RC"

RC=$(as_authenticated_rc "$UID_OPERATOR" "select create_category('$RESTO_B','A7 Operator-on-B',null);")
assert_ok "A7 même opérateur -> ALLOWED sur B aussi (autorité globale, create_category)" "$RC"

RC=$(as_anon_rc "select create_category('$RESTO_A','A8 Anon',null);")
assert_denied "A8 anon -> DENIED (create_category)" "$RC"

RC=$(as_authenticated_rc "$UID_UNRELATED" "select create_category('99999999-9999-9999-9999-999999999999','A9 UnknownResto',null);")
assert_denied "A9a restaurant inconnu, utilisateur ordinaire -> DENIED avant toute écriture (create_category)" "$RC"
RC=$(as_authenticated_rc "$UID_OPERATOR" "select create_category('99999999-9999-9999-9999-999999999999','A9 UnknownRestoOperator',null);")
assert_denied "A9b restaurant inconnu, opérateur -> échoue quand même proprement (contrainte FK restaurant_id, jamais une écriture fantôme, create_category)" "$RC"

RC=$(as_authenticated_rc "$UID_OWNER_A" "select create_category('$RESTO_A','',null);")
assert_denied "A10 validation métier inchangée : nom vide toujours rejeté pour owner (create_category)" "$RC"
RC=$(as_authenticated_rc "$UID_OPERATOR" "select create_category('$RESTO_A','',null);")
assert_denied "A10b validation métier inchangée : nom vide toujours rejeté MÊME pour opérateur (create_category, la nouvelle autorisation ne contourne pas la validation)" "$RC"

# ============================================================
# SECTION B — create_product (contrôle en ligne) — matrice complète
# ============================================================
log "=== [B] create_product — matrice de test obligatoire ==="

RC=$(as_authenticated_rc "$UID_OWNER_A" "select create_product('$CAT_A','B1 Owner','d',5.00);")
assert_ok "B1 owner de A -> ALLOWED sur A (create_product)" "$RC"

RC=$(as_authenticated_rc "$UID_MANAGER_A" "select create_product('$CAT_A','B2 Manager','d',5.00);")
assert_ok "B2 manager de A -> ALLOWED sur A (create_product)" "$RC"

RC=$(as_authenticated_rc "$UID_STAFF_A" "select create_product('$CAT_A','B3 Staff','d',5.00);")
assert_denied "B3 staff de A -> DENIED (create_product)" "$RC"

RC=$(as_authenticated_rc "$UID_UNRELATED" "select create_product('$CAT_A','B4 Unrelated','d',5.00);")
assert_denied "B4 utilisateur authentifié non-lié -> DENIED (create_product)" "$RC"

RC=$(as_authenticated_rc "$UID_OWNER_B" "select create_product('$CAT_A','B5 OwnerB-on-A','d',5.00);")
assert_denied "B5 owner de B -> DENIED sur la catégorie de A (create_product, cross-tenant)" "$RC"

RC=$(as_authenticated_rc "$UID_OPERATOR" "select create_product('$CAT_A','B6 Operator-on-A','d',5.00);")
assert_ok "B6 opérateur SANS ligne restaurant_users pour A -> ALLOWED sur A (create_product)" "$RC"

RC=$(as_authenticated_rc "$UID_OPERATOR" "select create_product('$CAT_B','B7 Operator-on-B','d',5.00);")
assert_ok "B7 même opérateur -> ALLOWED sur B aussi (autorité globale, create_product)" "$RC"

RC=$(as_anon_rc "select create_product('$CAT_A','B8 Anon','d',5.00);")
assert_denied "B8 anon -> DENIED (create_product)" "$RC"

RC=$(as_authenticated_rc "$UID_UNRELATED" "select create_product('99999999-9999-9999-9999-999999999999','B9 UnknownCat','d',5.00);")
assert_denied "B9a catégorie inconnue, utilisateur ordinaire -> DENIED proprement (create_product)" "$RC"
RC=$(as_authenticated_rc "$UID_OPERATOR" "select create_product('99999999-9999-9999-9999-999999999999','B9 UnknownCatOperator','d',5.00);")
assert_denied "B9b catégorie inconnue, opérateur -> échoue quand même proprement (Category not found, create_product)" "$RC"

RC=$(as_authenticated_rc "$UID_OWNER_A" "select create_product('$CAT_A','B10 BadPrice','d',-5);")
assert_denied "B10 validation métier inchangée : prix négatif toujours rejeté pour owner (create_product)" "$RC"
RC=$(as_authenticated_rc "$UID_OPERATOR" "select create_product('$CAT_A','B10b BadPriceOperator','d',99999999);")
assert_denied "B10b validation métier inchangée : prix hors bornes toujours rejeté MÊME pour opérateur (create_product)" "$RC"

# ============================================================
# SECTION C — update_category (via assert_category_role) — matrice condensée
# ============================================================
log "=== [C] update_category — matrice condensée (assert_category_role) ==="

RC=$(as_authenticated_rc "$UID_OWNER_A" "select update_category('$CAT_A','C1 Owner Rename',1,null);")
assert_ok "C1 owner de A -> ALLOWED (update_category)" "$RC"
RC=$(as_authenticated_rc "$UID_MANAGER_A" "select update_category('$CAT_A','C2 Manager Rename',1,null);")
assert_ok "C2 manager de A -> ALLOWED (update_category)" "$RC"
RC=$(as_authenticated_rc "$UID_STAFF_A" "select update_category('$CAT_A','C3 Staff Rename',1,null);")
assert_denied "C3 staff de A -> DENIED (update_category)" "$RC"
RC=$(as_authenticated_rc "$UID_UNRELATED" "select update_category('$CAT_A','C4 Unrelated',1,null);")
assert_denied "C4 utilisateur non-lié -> DENIED (update_category)" "$RC"
RC=$(as_authenticated_rc "$UID_OWNER_B" "select update_category('$CAT_A','C5 OwnerB-on-A',1,null);")
assert_denied "C5 owner de B -> DENIED sur catégorie de A (update_category, cross-tenant)" "$RC"
RC=$(as_authenticated_rc "$UID_OPERATOR" "select update_category('$CAT_A','C6 Operator',1,null);")
assert_ok "C6 opérateur sans ligne restaurant_users -> ALLOWED (update_category)" "$RC"
RC=$(as_anon_rc "select update_category('$CAT_A','C7 Anon',1,null);")
assert_denied "C7 anon -> DENIED (update_category)" "$RC"
RC=$(as_authenticated_rc "$UID_OPERATOR" "select update_category('99999999-9999-9999-9999-999999999999','C8 UnknownCat',1,null);")
assert_denied "C8 catégorie inconnue, opérateur -> échoue proprement (Category not found, update_category)" "$RC"

# ============================================================
# SECTION D — create_subcategory / update_subcategory — matrice condensée
# ============================================================
log "=== [D] create_subcategory / update_subcategory — matrice condensée ==="

RC=$(as_authenticated_rc "$UID_OWNER_A" "select create_subcategory('$CAT_A','D1 Owner Sub',null);")
assert_ok "D1 owner de A -> ALLOWED (create_subcategory)" "$RC"
RC=$(as_authenticated_rc "$UID_STAFF_A" "select create_subcategory('$CAT_A','D2 Staff Sub',null);")
assert_denied "D2 staff de A -> DENIED (create_subcategory)" "$RC"
RC=$(as_authenticated_rc "$UID_OWNER_B" "select create_subcategory('$CAT_A','D3 OwnerB-on-A',null);")
assert_denied "D3 owner de B -> DENIED sur catégorie de A (create_subcategory, cross-tenant)" "$RC"
RC=$(as_authenticated_rc "$UID_OPERATOR" "select create_subcategory('$CAT_A','D4 Operator Sub',null);")
assert_ok "D4 opérateur sans ligne restaurant_users -> ALLOWED (create_subcategory)" "$RC"
RC=$(as_anon_rc "select create_subcategory('$CAT_A','D5 Anon Sub',null);")
assert_denied "D5 anon -> DENIED (create_subcategory)" "$RC"

SUB_A=$(as_authenticated "$UID_OWNER_A" "select id from menu_subcategories where name='D1 Owner Sub' limit 1;")
RC=$(as_authenticated_rc "$UID_OWNER_A" "select update_subcategory('$SUB_A','D6 Owner Rename',1);")
assert_ok "D6 owner de A -> ALLOWED (update_subcategory)" "$RC"
RC=$(as_authenticated_rc "$UID_STAFF_A" "select update_subcategory('$SUB_A','D7 Staff Rename',1);")
assert_denied "D7 staff de A -> DENIED (update_subcategory)" "$RC"
RC=$(as_authenticated_rc "$UID_UNRELATED" "select update_subcategory('$SUB_A','D8 Unrelated',1);")
assert_denied "D8 utilisateur non-lié -> DENIED (update_subcategory)" "$RC"
RC=$(as_authenticated_rc "$UID_OPERATOR" "select update_subcategory('$SUB_A','D9 Operator Rename',1);")
assert_ok "D9 opérateur sans ligne restaurant_users -> ALLOWED (update_subcategory)" "$RC"
RC=$(as_anon_rc "select update_subcategory('$SUB_A','D10 Anon',1);")
assert_denied "D10 anon -> DENIED (update_subcategory)" "$RC"

# ============================================================
# SECTION E — update_product (via assert_product_role) — matrice condensée
# ============================================================
log "=== [E] update_product — matrice condensée (assert_product_role) ==="

RC=$(as_authenticated_rc "$UID_OWNER_A" "select update_product('$PROD_A','E1 Owner','d',5.00);")
assert_ok "E1 owner de A -> ALLOWED (update_product)" "$RC"
RC=$(as_authenticated_rc "$UID_MANAGER_A" "select update_product('$PROD_A','E2 Manager','d',5.00);")
assert_ok "E2 manager de A -> ALLOWED (update_product)" "$RC"
RC=$(as_authenticated_rc "$UID_STAFF_A" "select update_product('$PROD_A','E3 Staff','d',5.00);")
assert_denied "E3 staff de A -> DENIED (update_product)" "$RC"
RC=$(as_authenticated_rc "$UID_UNRELATED" "select update_product('$PROD_A','E4 Unrelated','d',5.00);")
assert_denied "E4 utilisateur non-lié -> DENIED (update_product)" "$RC"
RC=$(as_authenticated_rc "$UID_OWNER_B" "select update_product('$PROD_A','E5 OwnerB-on-A','d',5.00);")
assert_denied "E5 owner de B -> DENIED sur produit de A (update_product, cross-tenant)" "$RC"
RC=$(as_authenticated_rc "$UID_OPERATOR" "select update_product('$PROD_A','E6 Operator','d',5.00);")
assert_ok "E6 opérateur sans ligne restaurant_users -> ALLOWED (update_product)" "$RC"
RC=$(as_anon_rc "select update_product('$PROD_A','E7 Anon','d',5.00);")
assert_denied "E7 anon -> DENIED (update_product)" "$RC"
RC=$(as_authenticated_rc "$UID_OPERATOR" "select update_product('99999999-9999-9999-9999-999999999999','E8 Unknown','d',5.00);")
assert_denied "E8 produit inconnu, opérateur -> échoue proprement (Product not found, update_product)" "$RC"

# ============================================================
# SECTION F — RPC produit restantes (via assert_product_role) —
# vérification ponctuelle : l'opérateur y gagne désormais accès aussi
# (conséquence transitive attendue, documentée dans FINDINGS.md), et
# la règle staff pré-existante de set_product_availability n'est PAS
# régressée.
# ============================================================
log "=== [F] set_product_availability / archive_product / restore_product / set_product_order / set_product_photo ==="

RC=$(as_authenticated_rc "$UID_STAFF_A" "select set_product_availability('$PROD_A', false);")
assert_ok "F1 NON-RÉGRESSION : staff de A garde son accès pré-existant à set_product_availability" "$RC"
RC=$(as_authenticated_rc "$UID_OPERATOR" "select set_product_availability('$PROD_A', true);")
assert_ok "F2 opérateur -> ALLOWED aussi sur set_product_availability (conséquence transitive attendue)" "$RC"
RC=$(as_authenticated_rc "$UID_UNRELATED" "select set_product_availability('$PROD_A', true);")
assert_denied "F3 utilisateur non-lié -> toujours DENIED sur set_product_availability" "$RC"

RC=$(as_authenticated_rc "$UID_OPERATOR" "select set_product_order('$PROD_A', 2);")
assert_ok "F4 opérateur -> ALLOWED sur set_product_order (conséquence transitive attendue)" "$RC"
RC=$(as_authenticated_rc "$UID_STAFF_A" "select set_product_order('$PROD_A', 3);")
assert_denied "F5 NON-RÉGRESSION : staff toujours DENIED sur set_product_order (jamais ouvert à staff, inchangé)" "$RC"

RC=$(as_authenticated_rc "$UID_OPERATOR" "select set_product_photo('$PROD_A', 'https://example.test/photo.jpg');")
assert_ok "F6 opérateur -> ALLOWED sur set_product_photo (conséquence transitive attendue -- RPC de liaison, PAS le stockage, voir FINDINGS.md)" "$RC"

RC=$(as_authenticated_rc "$UID_OPERATOR" "select archive_product('$PROD_A');")
assert_ok "F7 opérateur -> ALLOWED sur archive_product (conséquence transitive attendue)" "$RC"
RC=$(as_authenticated_rc "$UID_OPERATOR" "select restore_product('$PROD_A');")
assert_ok "F8 opérateur -> ALLOWED sur restore_product (conséquence transitive attendue)" "$RC"

# ============================================================
# SECTION G — get_merchant_catalogue : v1.1 CATALOGUE OPERATOR
# READ-PATH COMPLETION. L'opérateur peut désormais aussi LIRE le
# catalogue -- ce lot v1.1 ferme le gap documenté par v1
# (OB2-READ-PATH-NOT-EXTENDED-01). Le contrat d'origine
# (owner/manager/staff-MEMBRE, sans filtre de rôle -- get_merchant_
# catalogue n'a JAMAIS filtré par rôle, contrairement aux RPC de
# mutation) est préservé À L'IDENTIQUE ; seul le bypass opérateur est
# ajouté à côté.
# ============================================================
log "=== [G] get_merchant_catalogue — v1.1 READ-PATH COMPLETION ==="

# --- Non-régression marchand (mandat v1.1, items 1/3) : owner et
# manager gardent EXACTEMENT le même accès lecture qu'avant ce lot.
RC=$(as_authenticated_rc "$UID_OWNER_A" "select count(*) from get_merchant_catalogue('$RESTO_A', false);")
assert_ok "G1 NON-RÉGRESSION : owner de A -> ALLOWED en lecture (get_merchant_catalogue)" "$RC"
RC=$(as_authenticated_rc "$UID_MANAGER_A" "select count(*) from get_merchant_catalogue('$RESTO_A', false);")
assert_ok "G2 NON-RÉGRESSION : manager de A -> ALLOWED en lecture (get_merchant_catalogue)" "$RC"
# le contrat d'origine n'a JAMAIS filtré par rôle sur cette RPC
# (contrairement aux RPC de mutation) : staff a donc TOUJOURS eu accès
# en lecture -- non-régression explicite, pas une extension de ce lot.
RC=$(as_authenticated_rc "$UID_STAFF_A" "select count(*) from get_merchant_catalogue('$RESTO_A', false);")
assert_ok "G3 NON-RÉGRESSION : staff de A -> ALLOWED en lecture (contrat PRÉ-EXISTANT, get_merchant_catalogue n'a jamais filtré par rôle -- inchangé par v1.1)" "$RC"

# --- Opérateur (mandat v1.1, items obligatoires "OPERATOR TESTS" 1-4).
RC=$(as_authenticated_rc "$UID_OPERATOR" "select count(*) from get_merchant_catalogue('$RESTO_A', false);")
assert_ok "G4 CORRECTIF v1.1 : opérateur SANS ligne restaurant_users pour A -> ALLOWED en lecture (get_merchant_catalogue)" "$RC"
RC=$(as_authenticated_rc "$UID_OPERATOR" "select count(*) from get_merchant_catalogue('$RESTO_B', false);")
assert_ok "G5 même opérateur -> ALLOWED en lecture sur B aussi (autorité globale, get_merchant_catalogue)" "$RC"

# --- Identité des données retournées : l'opérateur voit EXACTEMENT
# les mêmes lignes que l'owner (même restaurant, même forme, aucune
# donnée filtrée/dégradée pour l'opérateur).
OWNER_COUNT=$(as_authenticated "$UID_OWNER_A" "select count(*) from get_merchant_catalogue('$RESTO_A', false);")
OPERATOR_COUNT=$(as_authenticated "$UID_OPERATOR" "select count(*) from get_merchant_catalogue('$RESTO_A', false);")
assert_eq "G6 owner et opérateur voient EXACTEMENT le même nombre de lignes pour A (aucune donnée dégradée/filtrée pour l'opérateur)" "$OWNER_COUNT" "$OPERATOR_COUNT"
# la forme des données (colonnes) est inchangée : cette colonne
# n'existait qu'après CATALOGUE/SUBCATEGORIES v1 -- si le SELECT
# échoue, la forme a été altérée par ce lot.
RC=$(as_authenticated_rc "$UID_OPERATOR" "select category_name, subcategory_name, tax_rate, reference_price_per_kg from get_merchant_catalogue('$RESTO_A', false) limit 1;")
assert_ok "G7 forme de retour inchangée (colonnes catégorie/sous-catégorie/fiscales toutes présentes) pour l'opérateur" "$RC"

# --- Isolation (mandat v1.1, "ISOLATION TESTS" 1/3) : un utilisateur
# ORDINAIRE (pas opérateur) reste strictement cross-tenant-isolé --
# seule la voie opérateur globale est nouvelle, jamais un relâchement
# général de l'isolation.
RC=$(as_authenticated_rc "$UID_UNRELATED" "select count(*) from get_merchant_catalogue('$RESTO_A', false);")
assert_denied "G8 ISOLATION : utilisateur authentifié non-lié -> TOUJOURS DENIED en lecture (get_merchant_catalogue)" "$RC"
RC=$(as_authenticated_rc "$UID_OWNER_B" "select count(*) from get_merchant_catalogue('$RESTO_A', false);")
assert_denied "G9 ISOLATION : owner de B -> TOUJOURS DENIED en lecture sur A (get_merchant_catalogue, cross-tenant, aucune extension du contrat existant)" "$RC"
RC=$(as_anon_rc "select count(*) from get_merchant_catalogue('$RESTO_A', false);")
assert_denied "G10 anon -> TOUJOURS DENIED en lecture (get_merchant_catalogue)" "$RC"

# ============================================================
# SECTION H — Non-régression structurelle
# ============================================================
log "=== [H] Non-régression structurelle ==="

R=$(sql "select p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('assert_category_role','assert_product_role','assert_subcategory_role','create_category','create_product','get_merchant_catalogue') and p.prosecdef=false;")
assert_eq "H1 SECURITY DEFINER préservé sur les 6 fonctions modifiées (5 v1 + get_merchant_catalogue v1.1, 0 contre-exemple)" "" "$R"

R=$(sql "select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('assert_category_role','assert_product_role','assert_subcategory_role','create_category','create_product','get_merchant_catalogue') and (p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c='search_path=\"\"'));")
assert_eq "H2 search_path = '' préservé sur les 6 fonctions modifiées (5 v1 + get_merchant_catalogue v1.1, 0 contre-exemple)" "" "$R"

R=$(sql "select has_table_privilege('anon','public.menu_items','INSERT') or has_table_privilege('anon','public.menu_items','UPDATE') or has_table_privilege('authenticated','public.menu_items','INSERT') or has_table_privilege('authenticated','public.menu_items','UPDATE');")
assert_eq "H3 aucun droit d'écriture direct anon/authenticated sur menu_items (toujours via RPC uniquement)" "f" "$R"
R=$(sql "select has_table_privilege('anon','public.menu_categories','INSERT') or has_table_privilege('authenticated','public.menu_categories','INSERT');")
assert_eq "H4 aucun droit d'écriture direct anon/authenticated sur menu_categories" "f" "$R"
R=$(sql "select has_table_privilege('anon','public.menu_subcategories','INSERT') or has_table_privilege('authenticated','public.menu_subcategories','INSERT');")
assert_eq "H5 aucun droit d'écriture direct anon/authenticated sur menu_subcategories" "f" "$R"

R=$(sql "select has_function_privilege('anon','public.create_category(uuid,text,integer)','EXECUTE') or has_function_privilege('anon','public.create_product(uuid,text,text,numeric,text,numeric,integer,boolean,uuid)','EXECUTE') or has_function_privilege('anon','public.update_category(uuid,text,integer,text)','EXECUTE') or has_function_privilege('anon','public.update_product(uuid,text,text,numeric,text,numeric,integer,boolean,uuid)','EXECUTE') or has_function_privilege('anon','public.create_subcategory(uuid,text,integer)','EXECUTE') or has_function_privilege('anon','public.update_subcategory(uuid,text,integer)','EXECUTE') or has_function_privilege('anon','public.get_merchant_catalogue(uuid,boolean)','EXECUTE');")
assert_eq "H6 anon n'a EXECUTE sur AUCUNE RPC catalogue après ce lot (y compris get_merchant_catalogue, v1.1)" "f" "$R"

R=$(sql "select create_order is not null from pg_proc where proname='create_order' limit 1;" 2>/dev/null)
if [ -n "$R" ]; then
  assert_eq "H7 create_order toujours défini (non touché par ce lot)" "t" "$R"
fi

R=$(sql "select count(*) from information_schema.columns where table_schema='public' and table_name='menu_items' and column_name in ('subcategory_id','tax_rate','unit_weight_grams','weight_is_approximate');")
assert_eq "H8 colonnes fiscales/sous-catégorie de menu_items intactes (4 colonnes)" "4" "$R"

log ""
log "=== RÉSUMÉ === PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  log "--- Échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
