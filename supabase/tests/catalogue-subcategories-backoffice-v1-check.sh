#!/usr/bin/env bash
# ============================================================
# Scanym — CATALOGUE / SUBCATEGORIES v1 — harnais SQL réel
# (PostgreSQL réel, aucune simulation), exécuté en tant qu'utilisateur
# système postgres (authentification peer).
#
# Construit la chaîne de migrations complète JUSQU'AU baseline requis
# (même chaîne prouvée par le harnais RECEIPT/INVOICE TAX DETAIL v1.1,
# + le lot receipt/invoice lui-même pour fidélité maximale au HEAD
# réel 1844403cfd0d6109fe386ace5fca2cf52c1df47e), puis applique
# supabase/DRAFT-lot-catalogue-subcategories-backoffice-v1.sql et
# prouve chaque invariant du mandat STREAM A.
# ============================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DRAFT_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-subcategories-backoffice-v1.sql"
DB="scanym_subcat_v1_$$"

PASS=0
FAIL=0
log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS=$((PASS+1)); log "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); log "FAIL: $1"; }

cleanup() {
  dropdb --if-exists "$DB" >/dev/null 2>&1
  dropdb --if-exists "${DB}_drift" >/dev/null 2>&1
}
trap cleanup EXIT

sql() { psql -X -A -q -t -d "$DB" -c "$1" 2>/tmp/scanym-subcat-v1-err-$$.txt; }
sql_rc() { psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-subcat-v1-out-$$.txt 2>/tmp/scanym-subcat-v1-err-$$.txt; echo $?; }

as_authenticated() {
  # $1 = uid, $2 = sql -- le set_config est fait dans un bloc DO (aucune
  # ligne de sortie), donc stdout ne contient QUE le résultat de $2 --
  # une erreur dans $2 laisse stdout vide (jamais confondu avec une
  # sortie résiduelle du set_config).
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    2>/tmp/scanym-subcat-v1-err-$$.txt
}
as_authenticated_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    >/tmp/scanym-subcat-v1-out-$$.txt 2>/tmp/scanym-subcat-v1-err-$$.txt
  echo $?
}
as_anon() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" 2>/tmp/scanym-subcat-v1-err-$$.txt
}
as_anon_rc() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-subcat-v1-out-$$.txt 2>/tmp/scanym-subcat-v1-err-$$.txt
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

build_full_chain_before_lot() {
  local dbname="$1"
  build_common_bootstrap "$dbname"
  build_minimal_chain "$dbname"
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v83-lot2a4-privilege-hardening.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v84-lot2b1-delivery-info-rpc.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-model.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-lot-b-rpc.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-server-delivery-fulfillment-pricing.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-payment-p3b6-checkout-billing-context.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-customer-order-tracking-foundation.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-receipt-invoice-tax-detail-v1.sql" >/dev/null
}

seed_smoke_restaurant() {
  local dbname="$1"
  psql -d "$dbname" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into public.restaurants (id, slug, name, is_active, status)
values ('11111111-1111-1111-1111-111111111111','subcat-v1-check','Subcat V1 Check', true, 'active');
insert into public.restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number)
values ('11111111-1111-1111-1111-111111111111','EUR', 1, '+33600000000');
insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled, config)
values
  ('11111111-1111-1111-1111-111111111111','delivery', true, '{"delivery_zone_prefixes": ["75"], "delivery_min_items": 0}'::jsonb),
  ('11111111-1111-1111-1111-111111111111','pickup', true, '{}'::jsonb),
  ('11111111-1111-1111-1111-111111111111','table', true, '{}'::jsonb);
insert into auth.users (id, email) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner@test.local');
insert into public.restaurant_users (restaurant_id, user_id, role)
values ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner');
-- Catégorie "Fromages" (mandat, exemple canonique).
insert into public.menu_categories (id, restaurant_id, name, is_active, display_order)
values ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','Fromages', true, 1);
-- Catégorie "Boissons", sans sous-catégorie (mandat, exemple B).
insert into public.menu_categories (id, restaurant_id, name, is_active, display_order)
values ('33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','Boissons', true, 2);
SQL
}

OWNER_UID='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
OTHER_UID='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
CAT_FROMAGES='22222222-2222-2222-2222-222222222222'
CAT_BOISSONS='33333333-3333-3333-3333-333333333333'

# ============================================================
# [0] BASELINE — chaîne complète jusqu'au HEAD réel + LOT SOUS TEST.
# ============================================================
log "=== [0] Construction baseline $DB ==="
createdb "$DB"
build_full_chain_before_lot "$DB"
RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/tmp/scanym-subcat-v1-out-$$.txt 2>/tmp/scanym-subcat-v1-err-$$.txt; echo $?)
if [ "$RC" -eq 0 ]; then
  pass "Application propre du lot CATALOGUE / SUBCATEGORIES v1 sur baseline réelle complète"
else
  fail "Application du lot a échoué (rc=$RC) -- voir /tmp/scanym-subcat-v1-err-$$.txt"
  cat /tmp/scanym-subcat-v1-err-$$.txt
fi
seed_smoke_restaurant "$DB"

# ============================================================
# [1] STRUCTURE
# ============================================================
log "=== [1] Structure menu_subcategories / menu_items.subcategory_id ==="

R=$(sql "select count(*) from information_schema.tables where table_schema='public' and table_name='menu_subcategories';")
[ "$R" = "1" ] && pass "table menu_subcategories existe (=$R)" || fail "table menu_subcategories absente (=$R)"

R=$(sql "select data_type from information_schema.columns where table_name='menu_items' and column_name='subcategory_id';")
[ "$R" = "uuid" ] && pass "menu_items.subcategory_id existe, uuid (=$R)" || fail "menu_items.subcategory_id incorrect (=$R)"

R=$(sql "select is_nullable from information_schema.columns where table_name='menu_items' and column_name='subcategory_id';")
[ "$R" = "YES" ] && pass "menu_items.subcategory_id est NULLABLE (=$R)" || fail "menu_items.subcategory_id n'est pas nullable (=$R)"

R=$(sql "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='idx_menu_subcategories_unique_name';")
[ "$R" = "1" ] && pass "index unique anti-doublon sous-catégorie présent (=$R)" || fail "index unique anti-doublon absent (=$R)"

R=$(sql "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='menu_items' and t.tgname='trg_menu_items_subcategory_category_match';")
[ "$R" = "1" ] && pass "trigger de cohérence sous-catégorie/catégorie présent (=$R)" || fail "trigger de cohérence absent (=$R)"

R=$(sql "select relrowsecurity from pg_class where oid = 'public.menu_subcategories'::regclass;")
[ "$R" = "t" ] && pass "RLS active sur menu_subcategories (=$R)" || fail "RLS inactive sur menu_subcategories (=$R)"

# ============================================================
# [2] ACL / droits d'écriture
# ============================================================
log "=== [2] ACL menu_subcategories ==="

RC=$(as_anon_rc "insert into public.menu_subcategories (category_id, name) values ('$CAT_FROMAGES','Direct anon insert');")
[ "$RC" -ne 0 ] && pass "anon ne peut pas INSERT menu_subcategories (rc=$RC)" || fail "anon a pu INSERT menu_subcategories"

RC=$(as_authenticated_rc "$OWNER_UID" "insert into public.menu_subcategories (category_id, name) values ('$CAT_FROMAGES','Direct authenticated insert');")
[ "$RC" -ne 0 ] && pass "authenticated ne peut pas INSERT menu_subcategories directement, hors RPC (rc=$RC)" || fail "authenticated a pu INSERT menu_subcategories directement"

# ============================================================
# [3] Contrats RPC
# ============================================================
log "=== [3] Contrats RPC ==="

R=$(sql "select pg_get_function_identity_arguments(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_subcategory';")
[ "$R" = "p_category_id uuid, p_name text, p_display_order integer" ] && pass "create_subcategory signature exacte (=$R)" || fail "create_subcategory signature inattendue (=$R)"

R=$(sql "select pg_get_function_identity_arguments(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='update_subcategory';")
[ "$R" = "p_subcategory_id uuid, p_name text, p_display_order integer" ] && pass "update_subcategory signature exacte (=$R)" || fail "update_subcategory signature inattendue (=$R)"

R=$(sql "select has_function_privilege('anon','public.create_subcategory(uuid,text,integer)','EXECUTE');")
[ "$R" = "f" ] && pass "anon n'a pas EXECUTE sur create_subcategory (=$R)" || fail "anon a EXECUTE sur create_subcategory (=$R)"
R=$(sql "select has_function_privilege('authenticated','public.create_subcategory(uuid,text,integer)','EXECUTE');")
[ "$R" = "t" ] && pass "authenticated a EXECUTE sur create_subcategory (=$R)" || fail "authenticated n'a pas EXECUTE sur create_subcategory (=$R)"

# ============================================================
# [4] RÉGRESSION -- catégorie SANS sous-catégorie (Boissons/Eau/Jus),
#     get_merchant_catalogue doit se comporter EXACTEMENT comme avant
#     ce lot (une ligne par produit direct, subcategory_id/name/order
#     tous NULL, aucune ligne fantôme supplémentaire).
# ============================================================
log "=== [4] Régression -- catégorie sans sous-catégorie ==="

PID_EAU=$(as_authenticated "$OWNER_UID" "select create_product('$CAT_BOISSONS','Eau','Eau plate',2.00);" | tr -d ' ')
PID_JUS=$(as_authenticated "$OWNER_UID" "select create_product('$CAT_BOISSONS','Jus','Jus d''orange',3.50);" | tr -d ' ')

R=$(as_authenticated "$OWNER_UID" "select count(*) from get_merchant_catalogue('11111111-1111-1111-1111-111111111111', false) where category_id='$CAT_BOISSONS';")
[ "$R" = "2" ] && pass "Boissons (sans sous-catégorie) : exactement 2 lignes produit, aucune ligne fantôme (=$R)" || fail "Boissons : nombre de lignes inattendu (=$R)"

R=$(as_authenticated "$OWNER_UID" "select count(*) from get_merchant_catalogue('11111111-1111-1111-1111-111111111111', false) where category_id='$CAT_BOISSONS' and subcategory_id is null;")
[ "$R" = "2" ] && pass "Boissons : subcategory_id NULL pour les 2 produits directs (=$R)" || fail "Boissons : subcategory_id inattendu (=$R)"

R=$(as_authenticated "$OWNER_UID" "select string_agg(name, ',' order by display_order) from get_merchant_catalogue('11111111-1111-1111-1111-111111111111', false) where category_id='$CAT_BOISSONS';")
[ "$R" = "Eau,Jus" ] && pass "Boissons : ordre déterministe préservé (=$R)" || fail "Boissons : ordre inattendu (=$R)"

# ============================================================
# [5] Création sous-catégorie + produit rattaché (Fromages -> Chèvres)
# ============================================================
log "=== [5] Fromages -> Chèvres -> Charolais/Pélardon ==="

SUBCAT_CHEVRES=$(as_authenticated "$OWNER_UID" "select create_subcategory('$CAT_FROMAGES','Chèvres');" | tr -d ' ')
[ -n "$SUBCAT_CHEVRES" ] && pass "create_subcategory('Chèvres') a retourné un id (=$SUBCAT_CHEVRES)" || fail "create_subcategory('Chèvres') n'a rien retourné"

PID_CHAROLAIS=$(as_authenticated "$OWNER_UID" "select create_product('$CAT_FROMAGES','Charolais','Chèvre AOP',7.50,null,null,null,false,'$SUBCAT_CHEVRES');" | tr -d ' ')
[ -n "$PID_CHAROLAIS" ] && pass "create_product Charolais avec p_subcategory_id a réussi" || fail "create_product Charolais a échoué"

PID_PELARDON=$(as_authenticated "$OWNER_UID" "select create_product('$CAT_FROMAGES','Pélardon','Chèvre AOP',6.00,null,null,null,false,'$SUBCAT_CHEVRES');" | tr -d ' ')

# Produit direct dans Fromages, sans sous-catégorie (les deux modèles
# coexistent dans la MÊME catégorie -- mandat §5/§10, souplesse
# maximale, aucun cas interdit).
PID_TOMME=$(as_authenticated "$OWNER_UID" "select create_product('$CAT_FROMAGES','Tomme','Vache',5.00);" | tr -d ' ')

R=$(as_authenticated "$OWNER_UID" "select count(*) from get_merchant_catalogue('11111111-1111-1111-1111-111111111111', false) where category_id='$CAT_FROMAGES' and subcategory_id='$SUBCAT_CHEVRES';")
[ "$R" = "2" ] && pass "sous-catégorie Chèvres : 2 produits (Charolais, Pélardon) (=$R)" || fail "sous-catégorie Chèvres : nombre de produits inattendu (=$R)"

R=$(as_authenticated "$OWNER_UID" "select count(*) from get_merchant_catalogue('11111111-1111-1111-1111-111111111111', false) where category_id='$CAT_FROMAGES' and subcategory_id is null and product_id is not null;")
[ "$R" = "1" ] && pass "Fromages : 1 produit direct (Tomme), coexiste avec la sous-catégorie (=$R)" || fail "Fromages : produits directs inattendus (=$R)"

R=$(as_authenticated "$OWNER_UID" "select string_agg(name,',' order by display_order) from get_merchant_catalogue('11111111-1111-1111-1111-111111111111', false) where category_id='$CAT_FROMAGES' and subcategory_id='$SUBCAT_CHEVRES';")
[ "$R" = "Charolais,Pélardon" ] && pass "ordre déterministe des produits dans la sous-catégorie (=$R)" || fail "ordre inattendu dans la sous-catégorie (=$R)"

R=$(as_authenticated "$OWNER_UID" "select subcategory_name from get_merchant_catalogue('11111111-1111-1111-1111-111111111111', false) where category_id='$CAT_FROMAGES' and subcategory_id='$SUBCAT_CHEVRES' limit 1;")
[ "$R" = "Chèvres" ] && pass "subcategory_name renvoyé correctement (=$R)" || fail "subcategory_name incorrect (=$R)"

# Groupe racine avant les sous-catégories (tri déterministe, mandat §10).
R=$(as_authenticated "$OWNER_UID" "select string_agg(name,',' order by
      case when subcategory_id is null then 0 else 1 end,
      subcategory_display_order nulls last, display_order)
    from get_merchant_catalogue('11111111-1111-1111-1111-111111111111', false) where category_id='$CAT_FROMAGES';")
[ "$R" = "Tomme,Charolais,Pélardon" ] && pass "Fromages : ordre global déterministe, racine avant sous-catégories (=$R)" || fail "Fromages : ordre global inattendu (=$R)"

# ============================================================
# [6] Sous-catégorie vide visible pour le commerçant
# ============================================================
log "=== [6] Sous-catégorie vide visible (dashboard) ==="

SUBCAT_EMPTY=$(as_authenticated "$OWNER_UID" "select create_subcategory('$CAT_FROMAGES','Pâtes pressées');" | tr -d ' ')
R=$(as_authenticated "$OWNER_UID" "select count(*) from get_merchant_catalogue('11111111-1111-1111-1111-111111111111', false) where category_id='$CAT_FROMAGES' and subcategory_id='$SUBCAT_EMPTY';")
[ "$R" = "1" ] && pass "sous-catégorie vide visible (1 ligne, product_id null) (=$R)" || fail "sous-catégorie vide non visible (=$R)"
R=$(as_authenticated "$OWNER_UID" "select product_id from get_merchant_catalogue('11111111-1111-1111-1111-111111111111', false) where category_id='$CAT_FROMAGES' and subcategory_id='$SUBCAT_EMPTY';")
[ -z "$R" ] && pass "sous-catégorie vide : product_id est bien NULL (=$R)" || fail "sous-catégorie vide : product_id inattendu (=$R)"

# ============================================================
# [7] Déplacements de produit -- catégorie <-> sous-catégorie, et
#     sous-catégorie A -> sous-catégorie B (mandat §16 -- data model).
# ============================================================
log "=== [7] Déplacements de produit ==="

# 7a. category -> subcategory (Tomme rejoint Chèvres).
RC=$(as_authenticated_rc "$OWNER_UID" "select update_product('$PID_TOMME','Tomme','Vache',5.00,null,null,null,false,'$SUBCAT_CHEVRES');")
[ "$RC" -eq 0 ] && pass "update_product : déplacement category -> subcategory réussi" || fail "update_product : déplacement category -> subcategory a échoué"
R=$(as_authenticated "$OWNER_UID" "select subcategory_id from get_merchant_catalogue('11111111-1111-1111-1111-111111111111', false) where product_id='$PID_TOMME';")
[ "$R" = "$SUBCAT_CHEVRES" ] && pass "Tomme est maintenant dans Chèvres (=$R)" || fail "Tomme n'a pas rejoint Chèvres (=$R)"

# 7b. subcategory -> category (Tomme revient directement sous Fromages).
RC=$(as_authenticated_rc "$OWNER_UID" "select update_product('$PID_TOMME','Tomme','Vache',5.00,null,null,null,false,null);")
[ "$RC" -eq 0 ] && pass "update_product : déplacement subcategory -> category réussi" || fail "update_product : déplacement subcategory -> category a échoué"
R=$(as_authenticated "$OWNER_UID" "select subcategory_id from get_merchant_catalogue('11111111-1111-1111-1111-111111111111', false) where product_id='$PID_TOMME';")
[ -z "$R" ] && pass "Tomme est de nouveau directement sous Fromages (subcategory_id=NULL) (=$R)" || fail "Tomme n'est pas revenu direct (=$R)"

# 7c. subcategory A -> subcategory B (Pélardon quitte Chèvres pour Pâtes pressées).
RC=$(as_authenticated_rc "$OWNER_UID" "select update_product('$PID_PELARDON','Pélardon','Chèvre AOP',6.00,null,null,null,false,'$SUBCAT_EMPTY');")
[ "$RC" -eq 0 ] && pass "update_product : déplacement subcategory A -> subcategory B réussi" || fail "update_product : déplacement A->B a échoué"
R=$(as_authenticated "$OWNER_UID" "select subcategory_id from get_merchant_catalogue('11111111-1111-1111-1111-111111111111', false) where product_id='$PID_PELARDON';")
[ "$R" = "$SUBCAT_EMPTY" ] && pass "Pélardon est maintenant dans 'Pâtes pressées' (=$R)" || fail "Pélardon n'a pas changé de sous-catégorie (=$R)"
# remise en état pour la suite du harnais
as_authenticated "$OWNER_UID" "select update_product('$PID_PELARDON','Pélardon','Chèvre AOP',6.00,null,null,null,false,'$SUBCAT_CHEVRES');" >/dev/null

# ============================================================
# [8] Garde de cohérence -- sous-catégorie d'une AUTRE catégorie
# ============================================================
log "=== [8] Garde de cohérence catégorie/sous-catégorie ==="

SUBCAT_BOISSONS=$(as_authenticated "$OWNER_UID" "select create_subcategory('$CAT_BOISSONS','Sodas');" | tr -d ' ')

RC=$(as_authenticated_rc "$OWNER_UID" "select create_product('$CAT_FROMAGES','Bad Product','x',1,null,null,null,false,'$SUBCAT_BOISSONS');")
[ "$RC" -ne 0 ] && pass "create_product refuse une sous-catégorie d'une AUTRE catégorie (rc=$RC)" || fail "create_product a accepté une sous-catégorie incohérente"
R=$(cat /tmp/scanym-subcat-v1-err-$$.txt)
echo "$R" | grep -q "SCANYM_SUBCATEGORY_CATEGORY_MISMATCH" && pass "message SCANYM_SUBCATEGORY_CATEGORY_MISMATCH explicite" || fail "message d'erreur inattendu : $R"

RC=$(as_authenticated_rc "$OWNER_UID" "select update_product('$PID_TOMME','Tomme','Vache',5.00,null,null,null,false,'$SUBCAT_BOISSONS');")
[ "$RC" -ne 0 ] && pass "update_product refuse une sous-catégorie d'une AUTRE catégorie (rc=$RC)" || fail "update_product a accepté une sous-catégorie incohérente"

# 8c. Le trigger reste le filet de sécurité même hors RPC (INSERT SQL
# direct en tant que superutilisateur, bypass complet des RPC -- prouve
# la défense en profondeur, pas seulement la validation applicative).
RC=$(sql_rc "insert into public.menu_items (category_id, name, price, subcategory_id) values ('$CAT_FROMAGES','Direct bad insert',1,'$SUBCAT_BOISSONS');")
[ "$RC" -ne 0 ] && pass "trigger de cohérence bloque un INSERT SQL direct incohérent (rc=$RC, défense en profondeur)" || fail "trigger de cohérence n'a pas bloqué l'INSERT direct incohérent"

# ============================================================
# [9] Anti-doublon nom de sous-catégorie
# ============================================================
log "=== [9] Anti-doublon nom de sous-catégorie ==="

RC=$(as_authenticated_rc "$OWNER_UID" "select create_subcategory('$CAT_FROMAGES','Chèvres');")
[ "$RC" -ne 0 ] && pass "doublon de nom REFUSÉ dans la même catégorie (rc=$RC)" || fail "doublon de nom accepté dans la même catégorie"
grep -q "SCANYM_SUBCATEGORY_DUPLICATE_NAME" /tmp/scanym-subcat-v1-err-$$.txt && pass "message SCANYM_SUBCATEGORY_DUPLICATE_NAME explicite" || fail "message de doublon inattendu"

# Même nom, catégorie DIFFÉRENTE -- doit être accepté (portée de
# l'unicité = category_id, jamais globale).
RC=$(as_authenticated_rc "$OWNER_UID" "select create_subcategory('$CAT_BOISSONS','Chèvres');")
[ "$RC" -eq 0 ] && pass "même nom accepté dans une catégorie DIFFÉRENTE (portée correcte de l'unicité)" || fail "même nom refusé à tort dans une catégorie différente"

# ============================================================
# [10] Isolation tenant / rôle
# ============================================================
log "=== [10] Isolation tenant / rôle ==="

RC=$(as_authenticated_rc "$OTHER_UID" "select create_subcategory('$CAT_FROMAGES','Intrus');")
[ "$RC" -ne 0 ] && pass "un utilisateur SANS rôle sur ce restaurant ne peut pas créer de sous-catégorie (rc=$RC)" || fail "utilisateur non autorisé a pu créer une sous-catégorie"

RC=$(as_authenticated_rc "$OTHER_UID" "select update_subcategory('$SUBCAT_CHEVRES','Hack',1);")
[ "$RC" -ne 0 ] && pass "un utilisateur SANS rôle sur ce restaurant ne peut pas modifier une sous-catégorie (rc=$RC)" || fail "utilisateur non autorisé a pu modifier une sous-catégorie"

RC=$(as_anon_rc "select create_subcategory('$CAT_FROMAGES','Anon');")
[ "$RC" -ne 0 ] && pass "anon ne peut pas appeler create_subcategory (rc=$RC)" || fail "anon a pu appeler create_subcategory"

# ============================================================
# [11] Renommage + réordonnancement (update_subcategory)
# ============================================================
log "=== [11] update_subcategory -- renommage + ordre ==="

RC=$(as_authenticated_rc "$OWNER_UID" "select update_subcategory('$SUBCAT_CHEVRES','Chèvres AOP',5);")
[ "$RC" -eq 0 ] && pass "update_subcategory (renommage + ordre) a réussi" || fail "update_subcategory a échoué"
R=$(as_authenticated "$OWNER_UID" "select subcategory_name from get_merchant_catalogue('11111111-1111-1111-1111-111111111111', false) where subcategory_id='$SUBCAT_CHEVRES' limit 1;")
[ "$R" = "Chèvres AOP" ] && pass "renommage reflété dans get_merchant_catalogue (=$R)" || fail "renommage non reflété (=$R)"
R=$(as_authenticated "$OWNER_UID" "select subcategory_display_order from get_merchant_catalogue('11111111-1111-1111-1111-111111111111', false) where subcategory_id='$SUBCAT_CHEVRES' limit 1;")
[ "$R" = "5" ] && pass "ordre d'affichage reflété (=$R)" || fail "ordre d'affichage non reflété (=$R)"

# ============================================================
# [12] Catalogue public -- filtrage archivé/indisponible inchangé,
#      catégorie inconnue de la sous-catégorie n'affecte pas
#      is_available/archived_at (indépendance totale).
# ============================================================
log "=== [12] Filtrage produit indépendant de la sous-catégorie ==="

as_authenticated "$OWNER_UID" "select set_product_availability('$PID_CHAROLAIS', false);" >/dev/null
R=$(as_authenticated "$OWNER_UID" "select is_available from get_merchant_catalogue('11111111-1111-1111-1111-111111111111', false) where product_id='$PID_CHAROLAIS';")
[ "$R" = "f" ] && pass "is_available toujours piloté indépendamment de la sous-catégorie (=$R)" || fail "is_available incohérent (=$R)"
as_authenticated "$OWNER_UID" "select set_product_availability('$PID_CHAROLAIS', true);" >/dev/null

as_authenticated "$OWNER_UID" "select archive_product('$PID_CHAROLAIS');" >/dev/null
R=$(as_authenticated "$OWNER_UID" "select count(*) from get_merchant_catalogue('11111111-1111-1111-1111-111111111111', false) where product_id='$PID_CHAROLAIS';")
[ "$R" = "0" ] && pass "produit archivé disparaît de la vue non-archivée, sous-catégorie ou non (=$R)" || fail "produit archivé toujours visible en vue non-archivée (=$R)"
R=$(as_authenticated "$OWNER_UID" "select count(*) from get_merchant_catalogue('11111111-1111-1111-1111-111111111111', true) where product_id='$PID_CHAROLAIS';")
[ "$R" = "1" ] && pass "produit archivé visible en vue archivée, avec sa sous-catégorie intacte (=$R)" || fail "produit archivé absent de la vue archivée (=$R)"
R=$(as_authenticated "$OWNER_UID" "select subcategory_id from get_merchant_catalogue('11111111-1111-1111-1111-111111111111', true) where product_id='$PID_CHAROLAIS';")
[ "$R" = "$SUBCAT_CHEVRES" ] && pass "archivage ne détache jamais la sous-catégorie (=$R)" || fail "archivage a détaché la sous-catégorie (=$R)"
as_authenticated "$OWNER_UID" "select restore_product('$PID_CHAROLAIS');" >/dev/null

# ============================================================
# [13] AUTORITÉ FINANCIÈRE INCHANGÉE -- une commande sur un produit en
#      sous-catégorie facture EXACTEMENT price × quantité, comme un
#      produit direct (mandat §11 -- la sous-catégorie n'a AUCUNE
#      incidence sur create_order).
# ============================================================
log "=== [13] Autorité financière inchangée (create_order) ==="

R=$(as_anon "select subtotal, total from create_order('subcat-v1-check', 'pickup', '[{\"menu_item_id\":\"$PID_CHAROLAIS\",\"quantity\":3}]'::jsonb, null, '{\"name\":\"Client Test\",\"phone\":\"0600000000\"}'::jsonb, null, 'fr');")
[ "$R" = "22.50|22.50" ] && pass "commande sur produit en sous-catégorie : 3 × 7.50 = 22.50, inchangé (=$R)" || fail "montant de commande inattendu pour produit en sous-catégorie (=$R)"

# ============================================================
# [14] Régression -- get_merchant_catalogue préserve is_option_source/
#      category_is_option_source malgré la restructuration en CTE.
# ============================================================
log "=== [14] Non-régression option-source ==="

CAT_PATISSERIE=$(as_authenticated "$OWNER_UID" "select create_category('11111111-1111-1111-1111-111111111111','Pâtisserie',3);" | tr -d ' ')
PID_TARTE=$(as_authenticated "$OWNER_UID" "select create_product('$CAT_PATISSERIE','Tarte citron','x',4);" | tr -d ' ')
PID_FORMULE=$(as_authenticated "$OWNER_UID" "select create_product('$CAT_BOISSONS','Formule','x',12);" | tr -d ' ')
sql "update public.menu_items set option_source_category_id='$CAT_PATISSERIE' where id='$PID_FORMULE';" >/dev/null

R=$(as_authenticated "$OWNER_UID" "select category_is_option_source from get_merchant_catalogue('11111111-1111-1111-1111-111111111111', false) where category_id='$CAT_PATISSERIE' limit 1;")
[ "$R" = "t" ] && pass "category_is_option_source toujours calculé correctement (=$R)" || fail "category_is_option_source incorrect après restructuration CTE (=$R)"

R=$(as_authenticated "$OWNER_UID" "select is_option_source from get_merchant_catalogue('11111111-1111-1111-1111-111111111111', false) where product_id='$PID_TARTE';")
[ "$R" = "t" ] && pass "is_option_source (produit) toujours calculé correctement (=$R)" || fail "is_option_source (produit) incorrect (=$R)"

# ============================================================
# [15] GARDE DE DÉRIVE -- rejeu sur une base sans le lot, doit échouer.
# ============================================================
log "=== [15] Garde de dérive -- rejeu sans dépendances ==="

DB_DRIFT="${DB}_drift"
createdb "$DB_DRIFT"
build_common_bootstrap "$DB_DRIFT"
build_minimal_chain "$DB_DRIFT"
RC=$(psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/tmp/scanym-subcat-v1-out-$$.txt 2>/tmp/scanym-subcat-v1-err-$$.txt; echo $?)
[ "$RC" -ne 0 ] && pass "application échoue sans CATALOGUE FISCAL v1.3 (préflight signature 8 params) (rc=$RC)" || fail "application a réussi à tort sans dépendances"
grep -q "SCANYM_SCHEMA_DRIFT" /tmp/scanym-subcat-v1-err-$$.txt && pass "message SCANYM_SCHEMA_DRIFT explicite" || fail "message d'erreur inattendu"
R=$(psql -X -A -t -d "$DB_DRIFT" -c "select count(*) from information_schema.tables where table_name='menu_subcategories';")
[ "$R" = "0" ] && pass "aucune trace de menu_subcategories après échec du préflight (rollback complet) (=$R)" || fail "menu_subcategories existe après un préflight en échec (=$R)"

# ============================================================
# [16] DOUBLE APPLICATION -- refusée explicitement.
# ============================================================
log "=== [16] Garde anti-double-application ==="

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/tmp/scanym-subcat-v1-out-$$.txt 2>/tmp/scanym-subcat-v1-err-$$.txt; echo $?)
[ "$RC" -ne 0 ] && pass "double application refusée explicitement (rc=$RC)" || fail "double application acceptée à tort"
grep -q "SCANYM_SCHEMA_DRIFT" /tmp/scanym-subcat-v1-err-$$.txt && pass "message de double-application explicite" || fail "message de double-application inattendu"

echo ""
echo "============================================================"
echo "RÉSUMÉ — CATALOGUE / SUBCATEGORIES v1"
echo "  TOTAL PASS : $PASS"
echo "  TOTAL FAIL : $FAIL"
echo "============================================================"
rm -f /tmp/scanym-subcat-v1-out-$$.txt /tmp/scanym-subcat-v1-err-$$.txt
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
