#!/usr/bin/env bash
# ============================================================
# Scanym — CATALOGUE PRODUCT REORDER v1 — harnais SQL RÉEL
# (PostgreSQL réel, bases jetables, aucune simulation, aucune base
# hébergée, aucune clé).
#
# Même idiome que supabase/tests/product-service-modes-v1-check.sh et
# supabase/tests/catalogue-management-ux-v1-check.sh (bootstrap,
# émulation des rôles et de auth.uid(), assertions explicites,
# nettoyage garanti).
#
# CHAÎNE REJOUÉE -- la plus complète connue pour le domaine catalogue,
# dans l'ordre historique des lots :
#   chaîne de product-service-modes-v1-check.sh (baseline commandes /
#   CGV / suivi), dans laquelle sont insérés, à leur position
#   historique (avant ONLINE WITHDRAWAL), les lots catalogue que ce
#   harnais-là ne rejoue pas : OPERATOR AUTHORIZATION (OB-2), IMPORT
#   COMMIT IDEMPOTENCY (OB-4), VAT COMPLETENESS GUARD, OPERATOR
#   CATALOGUE RESET, COLLECTIONS/TAGS FOUNDATION, CATALOGUE MANAGEMENT
#   UX, TRANSLATIONS MANAGEMENT v2 ; puis ONLINE WITHDRAWAL, DELIVERY
#   COUNTRY SCOPE, PRODUCT SERVICE MODES et MERCHANT CUSTOMER
#   COMMUNICATIONS v1 (dernier lot de main).
#
#   SEUL fichier du dépôt touchant menu_items / les RPC catalogue qui
#   n'est PAS rejoué : DRAFT-lot-bulk-product-photos-storage-
#   authorization-v1.sql. Son contrôle de dérive exige une version
#   intermédiaire de set_product_photo (« v1.3 ») absente du dépôt ;
#   il n'ajoute que assert_product_role_for (nom distinct) et ne
#   modifie ni menu_items.display_order, ni assert_product_role, ni
#   set_product_order -- rien dont dépende ce lot.
#
# CE QUI EST PROUVÉ ICI (au niveau base) : application sans aucune
# modification de données, droits, périmètres (sous-catégorie /
# produits directs), bornes, isolation entre établissements, rôles,
# contrôle optimiste, VRAIE concurrence (sessions psql parallèles),
# cohabitation avec set_product_order / create_product /
# update_product / archive / restore, non-régression disponibilité et
# modes de vente, lecture publique, anti-dérive, rollback.
#
# Usage, depuis la racine du dépôt :
#   su postgres -c "bash supabase/tests/catalogue-product-reorder-v1-check.sh"
# ============================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOT_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-product-reorder-v1.sql"
ROLLBACK_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-product-reorder-v1-ROLLBACK.sql"

# Base MODÈLE (chaîne + jeu d'essai, SANS le lot), clonée pour chaque
# scénario destructif : anti-dérive et rollback ne peuvent pas partager
# la base des assertions fonctionnelles sans les invalider.
DB_TEMPLATE="scanym_cpr1_tpl_$$"
DB="scanym_cpr1_$$"
DB_SCRATCH="scanym_cpr1_scratch_$$"

TMP="/tmp/scanym-cpr1-$$"
mkdir -p "$TMP"
OUT="$TMP/out.txt"
ERR="$TMP/err.txt"
: > "$OUT"; : > "$ERR"

PASS=0
FAIL=0

log()  { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS=$((PASS+1)); log "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); log "FAIL: $1"; }
fatal() { log "FATAL: $*"; exit 1; }

cleanup() {
  psql -X -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -X -c "drop database if exists \"$DB_SCRATCH\";" >/dev/null 2>&1 || true
  psql -X -c "drop database if exists \"$DB_TEMPLATE\";" >/dev/null 2>&1 || true
  rm -rf "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

assert_eq() {
  local d="$1" e="$2" a="$3"
  if [ "$e" = "$a" ]; then pass "$d (=$a)"; else fail "$d — attendu '$e', obtenu '$a'"; fi
}
assert_ne() {
  local d="$1" e="$2" a="$3"
  if [ "$e" != "$a" ]; then pass "$d"; else fail "$d — valeur inchangée '$a' alors qu'un changement était attendu"; fi
}
assert_ok() { if [ "$2" -eq 0 ]; then pass "$1 (rc=0)"; else fail "$1 — attendu rc=0, obtenu rc=$2 : $(tr '\n' ' ' < "$ERR" | cut -c1-300)"; fi; }
assert_refused() {
  # $1 description, $2 rc, $3 motif attendu dans le message d'erreur
  local msg; msg="$(tr '\n' ' ' < "$ERR")"
  if [ "$2" -ne 0 ] && printf '%s' "$msg" | grep -qF -- "$3"; then
    pass "$1 (refusé : $3)"
  else
    fail "$1 — attendu un refus portant '$3', obtenu rc=$2 : $(printf '%s' "$msg" | cut -c1-300)"
  fi
}

# --- accès superutilisateur (jeu d'essai et lectures de vérification) ---
q()     { psql -X -A -q -t -d "$DB" -c "$1" 2>"$ERR"; }
q_in()  { psql -X -A -q -t -d "$1" -c "$2" 2>"$ERR"; }

# --- appels en tant qu'utilisateur applicatif (rôle authenticated) ---
as_user() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "set local test.uid = '$1'; $2" >"$OUT" 2>"$ERR"
}
as_anon() { PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" >"$OUT" 2>"$ERR"; }
as_service() { PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$1" >"$OUT" 2>"$ERR"; }
last_out() { tail -1 "$OUT" 2>/dev/null; }

# --- résolution des produits du jeu d'essai par leur nom (unique) ---
pid() { q "select id from public.menu_items where name = '$1';"; }
# liste de noms séparés par '|' -> littéral uuid[] dans CET ordre
ids() {
  q "select '{' || coalesce(string_agg(mi.id::text, ',' order by n.ord), '') || '}'
     from unnest(string_to_array('$1', '|')) with ordinality as n(name, ord)
     join public.menu_items mi on mi.name = n.name;"
}

# move <uid> <produit> <up|down> <ordre attendu : noms séparés par |>
# Résultat dans $OUT / $ERR, code retour dans MOVE_RC.
MOVE_RC=0
move() {
  local p arr
  p="$(pid "$2")"
  arr="$(ids "$4")"
  as_user "$1" "select public.move_product_order('$p'::uuid, '$3', '$arr'::uuid[]);"
  MOVE_RC=$?
}

# Ordre STOCKÉ d'un périmètre non archivé : « nom=valeur|nom=valeur ».
# $1 = catégorie, $2 = sous-catégorie ou NULL.
scope_state() {
  q "select coalesce(string_agg(mi.name || '=' || mi.display_order, '|' order by mi.display_order, mi.name), '')
     from public.menu_items mi
     where mi.category_id = '$1' and mi.subcategory_id is not distinct from $2 and mi.archived_at is null;"
}
# Empreinte (id, display_order) d'un périmètre, archivés compris.
scope_fp() {
  q "select coalesce(md5(string_agg(mi.id::text || '=' || mi.display_order, ',' order by mi.id)), 'empty')
     from public.menu_items mi
     where mi.category_id = '$1' and mi.subcategory_id is not distinct from $2;"
}
# Le périmètre est-il DENSE (valeurs 1..N distinctes) ? -> t / f
scope_dense() {
  q "select (count(*) = count(distinct mi.display_order)
             and coalesce(min(mi.display_order), 1) = 1
             and coalesce(max(mi.display_order), count(*)) = count(*))::text
     from public.menu_items mi
     where mi.category_id = '$1' and mi.subcategory_id is not distinct from $2 and mi.archived_at is null;"
}
# Empreinte d'ORDRE de toute la base : (id, display_order) de tous les produits.
order_fp_in() {
  q_in "$1" "select count(*)::text || ':' || coalesce(md5(string_agg(mi.id::text || '=' || mi.display_order, ',' order by mi.id)), 'empty') from public.menu_items mi;"
}
# Empreinte de TOUT sauf l'ordre : chaque colonne de menu_items hors
# display_order / updated_at, plus les restrictions de modes de vente.
non_order_fp() {
  q "select md5(coalesce((select string_agg((to_jsonb(mi) - 'display_order' - 'updated_at')::text, ',' order by mi.id) from public.menu_items mi), '')
            || '#' ||
            coalesce((select string_agg(s.menu_item_id::text || ':' || s.mode_code, ',' order by s.menu_item_id, s.mode_code) from public.menu_item_sale_modes s), ''));"
}
# Empreinte de TAXONOMIE : (id, category_id, subcategory_id) de tous les produits.
taxonomy_fp() {
  q "select md5(string_agg(mi.id::text || ':' || mi.category_id::text || ':' || coalesce(mi.subcategory_id::text, '-'), ',' order by mi.id)) from public.menu_items mi;"
}
fn_count_in() {
  q_in "$1" "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'move_product_order';"
}

# ------------------------------------------------------------------
# Bootstrap Supabase minimal + chaîne.
# ------------------------------------------------------------------
build_common_bootstrap() {
  psql -X -d "$1" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<'SQL'
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

MINIMAL_CHAIN="schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql"
REST_CHAIN="migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v76-storage-origin-config.sql migration-v71-hardening.sql migration-v72-hardening.sql migration-v73-hardening.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql migration-v82-lot2a-sale-modes.sql migration-v83-lot2a4-privilege-hardening.sql migration-v84-lot2b1-delivery-info-rpc.sql DRAFT-lot-fulfillment-routing-model.sql DRAFT-lot-fulfillment-routing-lot-b-rpc.sql DRAFT-lot-server-delivery-fulfillment-pricing.sql DRAFT-lot-payment-p3b6-checkout-billing-context.sql DRAFT-lot-customer-order-tracking-foundation.sql DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql DRAFT-lot-receipt-invoice-tax-detail-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1-1-remediation.sql DRAFT-lot-payment-p1-foundation.sql DRAFT-lot-merchant-delivery-pricing.sql DRAFT-lot-orders-service-role-select-hardening.sql"
CGV_CHAIN="DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql DRAFT-lot-seller-legal-profile-cgv-engine-v1-2.sql DRAFT-lot-seller-legal-profile-cgv-engine-v1-3.sql DRAFT-lot-seller-legal-profile-cgv-engine-v1-4.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-1.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-2.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-4.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-5.sql"
ORDER_CHAIN="DRAFT-lot-order-received-enqueue-recovery-v1.sql migration-20260919000000-order-success-boundary-v1.sql"
TRACKING_CHAIN="DRAFT-lot-tracking-final-fiscal-summary-v1-1.sql DRAFT-lot-customer-tracking-capability-v3-1.sql DRAFT-lot-customer-contact-live-tracking-v1.sql DRAFT-lot-customer-followup-tracking-email-v1.sql"
# Lots catalogue, à leur position historique (avant ONLINE WITHDRAWAL).
CATALOGUE_CHAIN="DRAFT-lot-catalogue-operator-authorization-v1.sql DRAFT-lot-catalogue-import-commit-idempotency-v1-1.sql DRAFT-lot-catalogue-vat-completeness-guard-v1.sql DRAFT-lot-operator-catalogue-reset-v1.sql DRAFT-lot-catalogue-collections-tags-foundation-v1.sql DRAFT-lot-catalogue-management-ux-v1.sql DRAFT-lot-translations-management-v2.sql"
TAIL_CHAIN="DRAFT-lot-online-withdrawal-foundation-v1.sql DRAFT-lot-online-withdrawal-v1-1-cgv-mixed-regime.sql DRAFT-lot-delivery-country-scope-v1.sql DRAFT-lot-product-service-modes-v1.sql DRAFT-lot-merchant-customer-communications-v1.sql"

apply_to() { psql -X -d "$1" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$2" >/dev/null 2>"$ERR"; }

build_chain() {
  local db="$1" f
  for f in $MINIMAL_CHAIN $REST_CHAIN $CGV_CHAIN $ORDER_CHAIN $TRACKING_CHAIN $CATALOGUE_CHAIN $TAIL_CHAIN; do
    [ -f "$SUPABASE_DIR/$f" ] || fatal "maillon de chaîne absent : supabase/$f"
  done
  for f in $MINIMAL_CHAIN; do
    apply_to "$db" "$f" || fatal "chaîne, $f : $(grep -m2 ERROR "$ERR" | tr '\n' ' ')"
    psql -X -d "$db" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  done
  for f in $REST_CHAIN $CGV_CHAIN; do
    apply_to "$db" "$f" || fatal "chaîne, $f : $(grep -m2 ERROR "$ERR" | tr '\n' ' ')"
  done
  psql -X -d "$db" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  for f in $ORDER_CHAIN; do
    apply_to "$db" "$f" || fatal "chaîne, $f : $(grep -m2 ERROR "$ERR" | tr '\n' ' ')"
  done
  # Talon repris VERBATIM de product-service-modes-v1-check.sh.
  psql -X -d "$db" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<'SQL' || fatal "talon order_invoice_request"
create table public.order_invoice_request (
  order_id uuid primary key references public.orders(id) on delete cascade
);
alter table public.order_invoice_request enable row level security;
revoke all on table public.order_invoice_request from public, anon, authenticated;
SQL
  for f in $TRACKING_CHAIN $CATALOGUE_CHAIN $TAIL_CHAIN; do
    apply_to "$db" "$f" || fatal "chaîne, $f : $(grep -m2 ERROR "$ERR" | tr '\n' ' ')"
  done
}

# Identités du jeu d'essai.
OWNER_A="a0000000-0000-0000-0000-0000000000a1"
MANAGER_A="a0000000-0000-0000-0000-0000000000a2"
STAFF_A="a0000000-0000-0000-0000-0000000000a3"
OWNER_B="b0000000-0000-0000-0000-0000000000b1"
OPERATOR="c0000000-0000-0000-0000-0000000000c1"
STRANGER="d0000000-0000-0000-0000-0000000000d1"

load_fixtures() {
  psql -X -d "$1" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<SQL
insert into auth.users (id, email) values
  ('$OWNER_A','owner@a.test'), ('$MANAGER_A','manager@a.test'), ('$STAFF_A','staff@a.test'),
  ('$OWNER_B','owner@b.test'), ('$OPERATOR','operator@scanym.test'), ('$STRANGER','stranger@x.test');
insert into public.scanym_operators (user_id) values ('$OPERATOR');

insert into public.restaurants (id, name, slug, status, is_active, country) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Au lait cru', 'au-lait-cru-cpr1', 'active', true, 'FR'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Hotel Royal', 'hotel-royal-cpr1', 'active', true, 'FR');
insert into public.restaurant_users (restaurant_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '$OWNER_A',   'owner'),
  ('aaaaaaaa-0000-0000-0000-000000000001', '$MANAGER_A', 'manager'),
  ('aaaaaaaa-0000-0000-0000-000000000001', '$STAFF_A',   'staff'),
  ('bbbbbbbb-0000-0000-0000-000000000001', '$OWNER_B',   'owner');
insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled, config) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'pickup',   true, '{}'::jsonb),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'delivery', true, '{}'::jsonb);

insert into public.menu_categories (id, restaurant_id, name, display_order) values
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Fromages', 1),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-000000000001', 'Boissons', 2),
  ('bbbbbbbb-0000-0000-0000-0000000000c1', 'bbbbbbbb-0000-0000-0000-000000000001', 'Carte', 1);
insert into public.menu_subcategories (id, category_id, name, display_order) values
  ('aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'Chèvres', 1),
  ('aaaaaaaa-0000-0000-0000-0000000000d2', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'Brebis', 2);

-- Fromages, produits DIRECTS : valeurs denses. Abondance est INDISPONIBLE
-- (masquée de la carte, mais présente et déplaçable au back-office).
insert into public.menu_items (category_id, subcategory_id, name, price, display_order, is_available, tax_rate) values
  ('aaaaaaaa-0000-0000-0000-0000000000c1', null, 'Comté',     12.50, 1, true,  5.5),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', null, 'Beaufort',  14.00, 2, true,  5.5),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', null, 'Abondance', 11.00, 3, false, null);
-- Chèvres : catalogue HISTORIQUE, quatre ex æquo à 0, plus un archivé.
insert into public.menu_items (category_id, subcategory_id, name, price, display_order, is_available, tax_rate, archived_at) values
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'Zeste de chèvre', 6.00, 0, true, 5.5, null),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'éclat cendré',    7.00, 0, true, 5.5, null),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'Banon',           8.00, 0, true, 5.5, null),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'crottin',         4.00, 0, true, 5.5, null),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'Ancien chèvre',   5.00, 0, false, null, now());
-- Brebis : valeurs distinctes mais NON denses.
insert into public.menu_items (category_id, subcategory_id, name, price, display_order, is_available, tax_rate) values
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-0000000000d2', 'Ossau',     9.00, 4, true, 5.5),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-0000000000d2', 'Roquefort', 9.50, 9, true, 5.5);
-- Boissons, produits directs : valeurs distinctes NON denses.
insert into public.menu_items (category_id, subcategory_id, name, price, display_order, is_available, tax_rate) values
  ('aaaaaaaa-0000-0000-0000-0000000000c2', null, 'Eau',   2.00,  5, true, 5.5),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', null, 'Jus',   3.00,  9, true, 5.5),
  ('aaaaaaaa-0000-0000-0000-0000000000c2', null, 'Cidre', 4.00, 14, true, 20);
-- Établissement B : catalogue historique, JAMAIS réordonné par ce harnais.
insert into public.menu_items (category_id, subcategory_id, name, price, display_order, is_available, tax_rate) values
  ('bbbbbbbb-0000-0000-0000-0000000000c1', null, 'B-Trois', 3.00, 0, true, 10),
  ('bbbbbbbb-0000-0000-0000-0000000000c1', null, 'B-Un',    1.00, 0, true, 10),
  ('bbbbbbbb-0000-0000-0000-0000000000c1', null, 'B-Deux',  2.00, 0, true, 10);
-- Restriction de mode de vente : Comté en retrait uniquement.
insert into public.menu_item_sale_modes (menu_item_id, mode_code)
  select id, 'pickup' from public.menu_items where name = 'Comté';
SQL
}

RID_A="aaaaaaaa-0000-0000-0000-000000000001"
RID_B="bbbbbbbb-0000-0000-0000-000000000001"
CAT_FRO="aaaaaaaa-0000-0000-0000-0000000000c1"
CAT_BOI="aaaaaaaa-0000-0000-0000-0000000000c2"
CAT_B="bbbbbbbb-0000-0000-0000-0000000000c1"
SUB_CHE="'aaaaaaaa-0000-0000-0000-0000000000d1'"
SUB_BRE="'aaaaaaaa-0000-0000-0000-0000000000d2'"

clone_template() {
  psql -X -c "drop database if exists \"$1\";" >/dev/null 2>&1
  createdb -T "$DB_TEMPLATE" "$1" 2>"$ERR" || fatal "clonage du modèle vers $1 : $(cat "$ERR")"
}

# ============================================================
log "=== [0] Base modèle : chaîne complète + jeu d'essai (SANS le lot) ==="
psql -X -c "drop database if exists \"$DB_TEMPLATE\";" >/dev/null 2>&1 || true
createdb "$DB_TEMPLATE" || fatal "createdb"
build_common_bootstrap "$DB_TEMPLATE" || fatal "bootstrap : $(cat "$ERR")"
build_chain "$DB_TEMPLATE"
load_fixtures "$DB_TEMPLATE" || fatal "jeu d'essai : $(cat "$ERR")"
log "chaîne prédécesseur appliquée (baseline main), jeu d'essai chargé."

clone_template "$DB"
assert_eq "0a. baseline : move_product_order ABSENTE avant le lot" "0" "$(fn_count_in "$DB")"
assert_eq "0b. baseline : set_product_order (V67b) présente" "1" \
  "$(q "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='set_product_order';")"

# ============================================================
log "=== [1] Application du lot — aucune donnée modifiée ==="
FP_ORDER_BEFORE="$(order_fp_in "$DB")"
FP_NON_ORDER_BEFORE="$(non_order_fp)"
FN_FP_BEFORE="$(q "select md5(string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')=' || md5(p.prosrc), ',' order by p.proname, pg_get_function_identity_arguments(p.oid))) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public';")"

psql -X -d "$DB" -v ON_ERROR_STOP=1 -f "$LOT_SQL" >"$OUT" 2>"$ERR"
assert_ok "1a. le lot s'applique intégralement (contrôles préalables et post-application passés)" $?
assert_eq "1b. move_product_order installée, une seule signature" "1" "$(fn_count_in "$DB")"
assert_eq "1c. signature exacte" "p_product_id uuid, p_direction text, p_expected_order uuid[]" \
  "$(q "select pg_get_function_identity_arguments('public.move_product_order(uuid, text, uuid[])'::regprocedure);")"
assert_eq "1d. AUCUN BACKFILL : (id, display_order) de tous les produits inchangé par l'installation" "$FP_ORDER_BEFORE" "$(order_fp_in "$DB")"
assert_eq "1e. aucune autre colonne produit / mode de vente modifiée par l'installation" "$FP_NON_ORDER_BEFORE" "$(non_order_fp)"
assert_eq "1f. aucune fonction préexistante modifiée (empreinte nom+signature+corps hors move_product_order)" "$FN_FP_BEFORE" \
  "$(q "select md5(string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')=' || md5(p.prosrc), ',' order by p.proname, pg_get_function_identity_arguments(p.oid))) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname <> 'move_product_order';")"
assert_eq "1g. SECURITY DEFINER, search_path vide, propriétaire postgres" "true|search_path=\"\"|postgres" \
  "$(q "select p.prosecdef::text || '|' || array_to_string(p.proconfig, ',') || '|' || pg_get_userbyid(p.proowner) from pg_proc p where p.oid = 'public.move_product_order(uuid, text, uuid[])'::regprocedure;")"

# Références figées pour tout le reste du harnais.
FP_B_ORDER="$(scope_fp "$CAT_B" NULL)"
FP_TAXONOMY="$(taxonomy_fp)"
FP_NON_ORDER="$(non_order_fp)"

# ============================================================
log "=== [2] Droits ==="
P_BEAUFORT="$(pid 'Beaufort')"
as_anon "select public.move_product_order('$P_BEAUFORT'::uuid, 'up', '{}'::uuid[]);"
assert_refused "2a. anon ne peut pas exécuter la RPC" $? "permission denied"
as_service "select public.move_product_order('$P_BEAUFORT'::uuid, 'up', '{}'::uuid[]);"
assert_refused "2b. service_role ne peut pas exécuter la RPC" $? "permission denied"
PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
  -c "select public.move_product_order('$P_BEAUFORT'::uuid, 'up', '{}'::uuid[]);" >"$OUT" 2>"$ERR"
assert_refused "2c. authenticated SANS identité (auth.uid() nul) est refusé" $? "Authentication required"
assert_eq "2d. aucun droit d'écriture direct sur menu_items pour authenticated / anon" "f|f|f|f" \
  "$(q "select has_table_privilege('authenticated','public.menu_items','UPDATE')::text || '|' || has_table_privilege('authenticated','public.menu_items','INSERT')::text || '|' || has_table_privilege('anon','public.menu_items','UPDATE')::text || '|' || has_table_privilege('anon','public.menu_items','INSERT')::text;" | sed 's/false/f/g')"
PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
  -c "set local test.uid = '$OWNER_A'; update public.menu_items set display_order = 99 where id = '$P_BEAUFORT';" >"$OUT" 2>"$ERR"
assert_refused "2e. écriture DIRECTE de display_order par le propriétaire refusée (seule la RPC écrit)" $? "permission denied"

# ============================================================
log "=== [3] Périmètre « produits directs de la catégorie » (valeurs denses) ==="
assert_eq "3a. état initial Fromages / directs" "Comté=1|Beaufort=2|Abondance=3" "$(scope_state "$CAT_FRO" NULL)"
FP_CHE_BEFORE="$(scope_fp "$CAT_FRO" "$SUB_CHE")"
FP_BRE_BEFORE="$(scope_fp "$CAT_FRO" "$SUB_BRE")"
FP_BOI_BEFORE="$(scope_fp "$CAT_BOI" NULL)"
XMIN_ABONDANCE="$(q "select xmin::text from public.menu_items where name='Abondance';")"

move "$OWNER_A" 'Beaufort' up 'Comté|Beaufort|Abondance'
assert_ok "3b. MILIEU vers le HAUT accepté" "$MOVE_RC"
assert_eq "3c. la RPC retourne la nouvelle position" "1" "$(last_out)"
assert_eq "3d. ordre persisté après MONTER" "Beaufort=1|Comté=2|Abondance=3" "$(scope_state "$CAT_FRO" NULL)"
assert_eq "3e. périmètre déjà dense : la ligne non concernée n'est PAS réécrite (xmin inchangé)" "$XMIN_ABONDANCE" \
  "$(q "select xmin::text from public.menu_items where name='Abondance';")"

move "$OWNER_A" 'Comté' down 'Beaufort|Comté|Abondance'
assert_ok "3f. MILIEU vers le BAS accepté" "$MOVE_RC"
assert_eq "3g. la RPC retourne la nouvelle position" "3" "$(last_out)"
assert_eq "3h. ordre persisté après DESCENDRE (produit indisponible déplacé comme les autres)" "Beaufort=1|Abondance=2|Comté=3" "$(scope_state "$CAT_FRO" NULL)"

move "$OWNER_A" 'Beaufort' up 'Beaufort|Abondance|Comté'
assert_refused "3i. le PREMIER ne peut pas monter" "$MOVE_RC" "SCANYM_PRODUCT_ORDER_BOUNDARY"
move "$OWNER_A" 'Comté' down 'Beaufort|Abondance|Comté'
assert_refused "3j. le DERNIER ne peut pas descendre" "$MOVE_RC" "SCANYM_PRODUCT_ORDER_BOUNDARY"
assert_eq "3k. un refus de borne n'écrit rien" "Beaufort=1|Abondance=2|Comté=3" "$(scope_state "$CAT_FRO" NULL)"

assert_eq "3l. REPLI CATÉGORIE : la sous-catégorie Chèvres n'est pas touchée" "$FP_CHE_BEFORE" "$(scope_fp "$CAT_FRO" "$SUB_CHE")"
assert_eq "3m. REPLI CATÉGORIE : la sous-catégorie Brebis n'est pas touchée" "$FP_BRE_BEFORE" "$(scope_fp "$CAT_FRO" "$SUB_BRE")"
assert_eq "3n. l'autre catégorie (Boissons) n'est pas touchée" "$FP_BOI_BEFORE" "$(scope_fp "$CAT_BOI" NULL)"

# ============================================================
log "=== [4] Périmètre « sous-catégorie » + catalogue HISTORIQUE (ex æquo) ==="
# Ordre de la carte client pour quatre ex æquo à 0 : nom normalisé
# (minuscules), comparaison ORDINALE -> « é » (U+00E9) vient APRÈS « z ».
# Une collation linguistique SQL placerait « éclat » avant « Zeste » :
# c'est précisément pourquoi l'ordre affiché est transmis, et non
# recalculé par SQL.
CHE_JS='Banon|crottin|Zeste de chèvre|éclat cendré'
assert_eq "4a. état initial Chèvres : quatre ex æquo à 0 (archivé exclu)" "4|0|0" \
  "$(q "select count(*)::text || '|' || min(display_order) || '|' || max(display_order) from public.menu_items where subcategory_id = $SUB_CHE and archived_at is null;")"
FP_DIRECT_BEFORE="$(scope_fp "$CAT_FRO" NULL)"
ARCHIVED_BEFORE="$(q "select display_order::text || '|' || (archived_at is not null)::text from public.menu_items where name='Ancien chèvre';")"

move "$OWNER_A" 'Zeste de chèvre' up "$CHE_JS"
assert_ok "4b. premier déplacement d'un groupe historique accepté (ordre affiché = ordre de la carte)" "$MOVE_RC"
assert_eq "4c. MATÉRIALISATION : ordre vu par le client + le seul échange demandé" \
  "Banon=1|Zeste de chèvre=2|crottin=3|éclat cendré=4" "$(scope_state "$CAT_FRO" "$SUB_CHE")"
assert_eq "4d. le périmètre est dense (1..N distincts)" "true" "$(scope_dense "$CAT_FRO" "$SUB_CHE")"
assert_eq "4e. PÉRIMÈTRE SOUS-CATÉGORIE : les produits directs de la catégorie ne sont pas touchés" "$FP_DIRECT_BEFORE" "$(scope_fp "$CAT_FRO" NULL)"
assert_eq "4f. PÉRIMÈTRE SOUS-CATÉGORIE : l'autre sous-catégorie (Brebis) n'est pas touchée" "$FP_BRE_BEFORE" "$(scope_fp "$CAT_FRO" "$SUB_BRE")"
assert_eq "4g. le produit ARCHIVÉ du périmètre n'est ni renuméroté ni restauré" "$ARCHIVED_BEFORE" \
  "$(q "select display_order::text || '|' || (archived_at is not null)::text from public.menu_items where name='Ancien chèvre';")"

move "$OWNER_A" 'éclat cendré' up 'Banon|Zeste de chèvre|crottin|éclat cendré'
assert_ok "4h. second déplacement dans le même périmètre" "$MOVE_RC"
assert_eq "4i. ordre persisté" "Banon=1|Zeste de chèvre=2|éclat cendré=3|crottin=4" "$(scope_state "$CAT_FRO" "$SUB_CHE")"

# Brebis : valeurs distinctes non denses (4, 9) -> renumérotées 1..N.
move "$OWNER_A" 'Roquefort' up 'Ossau|Roquefort'
assert_ok "4j. périmètre à valeurs distinctes non denses accepté" "$MOVE_RC"
assert_eq "4k. renuméroté en positions denses" "Roquefort=1|Ossau=2" "$(scope_state "$CAT_FRO" "$SUB_BRE")"

# ============================================================
log "=== [5] Ordre, pas taxonomie — aucun déplacement entre catégories ==="
assert_eq "5a. (id, category_id, subcategory_id) de TOUS les produits inchangé après les déplacements" "$FP_TAXONOMY" "$(taxonomy_fp)"

STATE_DIRECT="$(scope_state "$CAT_FRO" NULL)"
STATE_CHE="$(scope_state "$CAT_FRO" "$SUB_CHE")"
STATE_BOI="$(scope_state "$CAT_BOI" NULL)"
move "$OWNER_A" 'Abondance' up 'Beaufort|Abondance|Comté|Eau'
assert_refused "5b. liste contenant un produit d'une AUTRE CATÉGORIE refusée" "$MOVE_RC" "SCANYM_PRODUCT_ORDER_STALE"
move "$OWNER_A" 'Abondance' up 'Beaufort|Abondance|Comté|Banon'
assert_refused "5c. liste contenant un produit d'une SOUS-CATÉGORIE de la même catégorie refusée" "$MOVE_RC" "SCANYM_PRODUCT_ORDER_STALE"
move "$OWNER_A" 'Abondance' up 'Eau|Jus|Cidre'
assert_refused "5d. produit ciblé hors de la liste (liste d'un autre périmètre) refusé" "$MOVE_RC" "SCANYM_PRODUCT_ORDER_STALE"
move "$OWNER_A" 'Banon' down 'Banon|Zeste de chèvre|éclat cendré|crottin|Ancien chèvre'
assert_refused "5e. liste incluant le produit ARCHIVÉ du périmètre refusée" "$MOVE_RC" "SCANYM_PRODUCT_ORDER_STALE"
# SUBSTITUTIONS À CARDINALITÉ ÉGALE : la liste a exactement la taille du
# périmètre, mais l'un de ses membres est remplacé par un produit
# étranger. La garde de taille ne suffit pas ici : c'est l'appartenance
# de CHAQUE élément au périmètre qui doit refuser.
move "$OWNER_A" 'Abondance' up 'Beaufort|Abondance|Banon'
assert_refused "5f. substitution par un produit d'une SOUS-CATÉGORIE de la même catégorie (même taille) refusée" "$MOVE_RC" "SCANYM_PRODUCT_ORDER_STALE"
move "$OWNER_A" 'Abondance' up 'Beaufort|Abondance|Eau'
assert_refused "5g. substitution par un produit d'une AUTRE CATÉGORIE (même taille) refusée" "$MOVE_RC" "SCANYM_PRODUCT_ORDER_STALE"
# L'archivé (valeur 0) est placé EN TÊTE : la liste reste non décroissante
# (0, 1, 2, 3), de même taille et sans doublon -- seul le filtre
# « non archivé » du contrôle d'appartenance peut la refuser.
move "$OWNER_A" 'Zeste de chèvre' down 'Ancien chèvre|Banon|Zeste de chèvre|éclat cendré'
assert_refused "5h. substitution par le produit ARCHIVÉ du même périmètre (même taille, ordre cohérent) refusée" "$MOVE_RC" "SCANYM_PRODUCT_ORDER_STALE"
move "$OWNER_A" 'Zeste de chèvre' down 'Banon|Zeste de chèvre|éclat cendré|Comté'
assert_refused "5i. substitution par un produit DIRECT de la catégorie dans une liste de sous-catégorie (même taille) refusée" "$MOVE_RC" "SCANYM_PRODUCT_ORDER_STALE"
assert_eq "5j. aucun de ces refus n'a écrit (directs)" "$STATE_DIRECT" "$(scope_state "$CAT_FRO" NULL)"
assert_eq "5k. aucun de ces refus n'a écrit (Chèvres)" "$STATE_CHE" "$(scope_state "$CAT_FRO" "$SUB_CHE")"
assert_eq "5l. aucun de ces refus n'a écrit (Boissons)" "$STATE_BOI" "$(scope_state "$CAT_BOI" NULL)"

# ============================================================
log "=== [6] Isolation entre établissements + rôles ==="
move "$OWNER_B" 'Abondance' up 'Beaufort|Abondance|Comté'
assert_refused "6a. le propriétaire de B ne peut pas réordonner un produit de A" "$MOVE_RC" "Not authorized for this product"
move "$STRANGER" 'Abondance' up 'Beaufort|Abondance|Comté'
assert_refused "6b. un utilisateur sans aucun rattachement est refusé" "$MOVE_RC" "Not authorized for this product"
move "$STAFF_A" 'Abondance' up 'Beaufort|Abondance|Comté'
assert_refused "6c. staff de A est refusé (décision de merchandising : owner/manager)" "$MOVE_RC" "Not authorized for this product"
assert_eq "6d. aucun de ces refus n'a écrit" "$STATE_DIRECT" "$(scope_state "$CAT_FRO" NULL)"

move "$OWNER_A" 'Abondance' up 'Beaufort|Abondance|Comté|B-Un'
assert_refused "6e. le propriétaire de A ne peut pas glisser un produit de B dans sa liste" "$MOVE_RC" "SCANYM_PRODUCT_ORDER_STALE"
move "$OWNER_A" 'Abondance' up 'Beaufort|Abondance|B-Un'
assert_refused "6e-bis. … ni le SUBSTITUER à l'un des siens (liste de même taille que le périmètre)" "$MOVE_RC" "SCANYM_PRODUCT_ORDER_STALE"
move "$OWNER_A" 'B-Un' up 'B-Deux|B-Trois|B-Un'
assert_refused "6f. le propriétaire de A ne peut pas viser un produit de B" "$MOVE_RC" "Not authorized for this product"
assert_eq "6g. l'établissement B est strictement intact" "$FP_B_ORDER" "$(scope_fp "$CAT_B" NULL)"
assert_eq "6g-bis. … et le périmètre de A visé par ces tentatives aussi" "$STATE_DIRECT" "$(scope_state "$CAT_FRO" NULL)"

as_user "$OWNER_A" "select public.move_product_order('00000000-0000-0000-0000-00000000dead'::uuid, 'up', '{}'::uuid[]);"
assert_refused "6h. produit inexistant" $? "Product not found"

move "$MANAGER_A" 'Abondance' up 'Beaufort|Abondance|Comté'
assert_ok "6i. manager de A autorisé" "$MOVE_RC"
assert_eq "6j. ordre après le déplacement du manager" "Abondance=1|Beaufort=2|Comté=3" "$(scope_state "$CAT_FRO" NULL)"
move "$OPERATOR" 'Abondance' down 'Abondance|Beaufort|Comté'
assert_ok "6k. opérateur Scanym (sans rattachement à A) autorisé via assert_product_role (OB-2)" "$MOVE_RC"
assert_eq "6l. ordre après le déplacement de l'opérateur" "Beaufort=1|Abondance=2|Comté=3" "$(scope_state "$CAT_FRO" NULL)"

# ============================================================
log "=== [7] Entrées invalides ==="
P_ABONDANCE="$(pid 'Abondance')"
ARR_DIRECT="$(ids 'Beaufort|Abondance|Comté')"
as_user "$OWNER_A" "select public.move_product_order('$P_ABONDANCE'::uuid, 'left', '$ARR_DIRECT'::uuid[]);"
assert_refused "7a. direction inconnue" $? "SCANYM_PRODUCT_ORDER_INVALID_DIRECTION"
as_user "$OWNER_A" "select public.move_product_order('$P_ABONDANCE'::uuid, null, '$ARR_DIRECT'::uuid[]);"
assert_refused "7b. direction nulle" $? "SCANYM_PRODUCT_ORDER_INVALID_DIRECTION"
as_user "$OWNER_A" "select public.move_product_order('$P_ABONDANCE'::uuid, 'up', null);"
assert_refused "7c. liste nulle" $? "SCANYM_PRODUCT_ORDER_STALE"
as_user "$OWNER_A" "select public.move_product_order('$P_ABONDANCE'::uuid, 'up', '{}'::uuid[]);"
assert_refused "7d. liste vide" $? "SCANYM_PRODUCT_ORDER_STALE"
move "$OWNER_A" 'Abondance' up 'Beaufort|Abondance'
assert_refused "7e. liste INCOMPLÈTE (un produit du périmètre manque)" "$MOVE_RC" "SCANYM_PRODUCT_ORDER_STALE"
as_user "$OWNER_A" "select public.move_product_order('$P_ABONDANCE'::uuid, 'up', array['$(pid 'Beaufort')','$P_ABONDANCE','$P_ABONDANCE']::uuid[]);"
assert_refused "7f. liste avec DOUBLON (même cardinalité que le périmètre)" $? "SCANYM_PRODUCT_ORDER_STALE"
as_user "$OWNER_A" "select public.move_product_order('$P_ABONDANCE'::uuid, 'up', array['$(pid 'Beaufort')'::uuid,'$P_ABONDANCE'::uuid,null]);"
assert_refused "7g. liste avec élément NUL" $? "SCANYM_PRODUCT_ORDER_STALE"
move "$OWNER_A" 'Abondance' up 'Comté|Abondance|Beaufort'
assert_refused "7h. valeurs stockées DISTINCTES : un ordre qui les contredit est refusé (la base fait autorité)" "$MOVE_RC" "SCANYM_PRODUCT_ORDER_STALE"
assert_eq "7i. aucun de ces refus n'a écrit" "Beaufort=1|Abondance=2|Comté=3" "$(scope_state "$CAT_FRO" NULL)"

# Tableau à borne inférieure arbitraire (appel SQL direct) : la position
# est lue sur l'ordinalité, l'échange reste exact.
as_user "$OWNER_A" "select public.move_product_order('$P_ABONDANCE'::uuid, 'up', ('[5:7]=' || '$ARR_DIRECT')::uuid[]);"
assert_ok "7j. tableau à borne inférieure 5 accepté" $?
assert_eq "7k. … et l'échange est exact" "Abondance=1|Beaufort=2|Comté=3" "$(scope_state "$CAT_FRO" NULL)"
assert_eq "7l. … et la position retournée est correcte" "1" "$(last_out)"

# ============================================================
log "=== [8] Contrôle optimiste — vue périmée (séquentiel) ==="
# Deux onglets ont chargé le même ordre ; le premier déplace, le second
# rejoue SA vue d'avant.
move "$OWNER_A" 'Comté' up 'Abondance|Beaufort|Comté'
assert_ok "8a. onglet 1 : déplacement accepté" "$MOVE_RC"
move "$MANAGER_A" 'Beaufort' up 'Abondance|Beaufort|Comté'
assert_refused "8b. onglet 2 (vue périmée) : refusé, rien n'est écrit par-dessus" "$MOVE_RC" "SCANYM_PRODUCT_ORDER_STALE"
assert_eq "8c. le déplacement de l'onglet 1 est intact" "Abondance=1|Comté=2|Beaufort=3" "$(scope_state "$CAT_FRO" NULL)"
move "$MANAGER_A" 'Beaufort' up 'Abondance|Comté|Beaufort'
assert_ok "8d. onglet 2, après rechargement : accepté" "$MOVE_RC"
assert_eq "8e. ordre final" "Abondance=1|Beaufort=2|Comté=3" "$(scope_state "$CAT_FRO" NULL)"
# Rejeu réseau d'une requête déjà appliquée : refusée, jamais appliquée deux fois.
move "$MANAGER_A" 'Beaufort' up 'Abondance|Comté|Beaufort'
assert_refused "8f. rejeu d'une requête déjà appliquée : refusé" "$MOVE_RC" "SCANYM_PRODUCT_ORDER_STALE"
assert_eq "8g. … sans double application" "Abondance=1|Beaufort=2|Comté=3" "$(scope_state "$CAT_FRO" NULL)"

# ============================================================
log "=== [9] VRAIE concurrence — sessions psql parallèles ==="
# 9A. Même périmètre, même vue de départ, deux déplacements différents.
#     La session 1 garde sa transaction ouverte ; la session 2 doit
#     ATTENDRE le verrou d'établissement, puis être refusée (périmée).
P_COMTE="$(pid 'Comté')"; P_BEAUFORT="$(pid 'Beaufort')"
ARR="$(ids 'Abondance|Beaufort|Comté')"
PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" >"$TMP/s1.out" 2>"$TMP/s1.err" <<SQL &
begin;
set local test.uid = '$OWNER_A';
select public.move_product_order('$P_COMTE'::uuid, 'up', '$ARR'::uuid[]);
select pg_sleep(2.5);
commit;
SQL
S1_PID=$!
sleep 0.8
WAITERS_BEFORE="$(q "select count(*) from pg_locks where locktype = 'advisory' and not granted;")"
T0=$(date +%s%N)
PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
  -c "set local test.uid = '$MANAGER_A'; select public.move_product_order('$P_BEAUFORT'::uuid, 'up', '$ARR'::uuid[]);" \
  >"$TMP/s2.out" 2>"$TMP/s2.err" &
S2_PID=$!
sleep 0.6
WAITERS_DURING="$(q "select count(*) from pg_locks where locktype = 'advisory' and not granted;")"
wait $S2_PID; S2_RC=$?
T1=$(date +%s%N)
wait $S1_PID; S1_RC=$?
S2_MS=$(( (T1 - T0) / 1000000 ))
assert_eq "9A-a. session 1 validée" "0" "$S1_RC"
assert_eq "9A-b. aucune attente de verrou avant la session 2" "0" "$WAITERS_BEFORE"
assert_eq "9A-c. la session 2 ATTEND le verrou transactionnel d'établissement" "1" "$WAITERS_DURING"
if [ "$S2_MS" -ge 1000 ]; then pass "9A-d. la session 2 a été bloquée jusqu'au commit de la session 1 (${S2_MS} ms)"; else fail "9A-d. session 2 non bloquée (${S2_MS} ms)"; fi
if [ "$S2_RC" -ne 0 ] && grep -qF "SCANYM_PRODUCT_ORDER_STALE" "$TMP/s2.err"; then
  pass "9A-e. la session 2 est refusée comme périmée une fois le verrou obtenu"
else
  fail "9A-e. session 2 : attendu SCANYM_PRODUCT_ORDER_STALE, obtenu rc=$S2_RC $(tr '\n' ' ' < "$TMP/s2.err" | cut -c1-200)"
fi
assert_eq "9A-f. seul le déplacement de la session 1 est appliqué" "Abondance=1|Comté=2|Beaufort=3" "$(scope_state "$CAT_FRO" NULL)"
assert_eq "9A-g. positions distinctes et denses" "true" "$(scope_dense "$CAT_FRO" NULL)"

# 9B. Deux périmètres DIFFÉRENTS du même établissement, en parallèle :
#     sérialisés par le verrou, tous deux acceptés.
P_EAU="$(pid 'Eau')"; ARR_BOI="$(ids 'Eau|Jus|Cidre')"
P_BANON="$(pid 'Banon')"; ARR_CHE="$(ids 'Banon|Zeste de chèvre|éclat cendré|crottin')"
PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" >"$TMP/s1.out" 2>"$TMP/s1.err" <<SQL &
begin;
set local test.uid = '$OWNER_A';
select public.move_product_order('$P_EAU'::uuid, 'down', '$ARR_BOI'::uuid[]);
select pg_sleep(1.2);
commit;
SQL
S1_PID=$!
sleep 0.4
PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
  -c "set local test.uid = '$MANAGER_A'; select public.move_product_order('$P_BANON'::uuid, 'down', '$ARR_CHE'::uuid[]);" \
  >"$TMP/s2.out" 2>"$TMP/s2.err" &
S2_PID=$!
wait $S1_PID; S1_RC=$?
wait $S2_PID; S2_RC=$?
assert_eq "9B-a. périmètre Boissons : accepté" "0" "$S1_RC"
assert_eq "9B-b. périmètre Chèvres, en parallèle : accepté" "0" "$S2_RC"
assert_eq "9B-c. Boissons (valeurs 5/9/14) renuméroté 1..N" "Jus=1|Eau=2|Cidre=3" "$(scope_state "$CAT_BOI" NULL)"
assert_eq "9B-d. Chèvres" "Zeste de chèvre=1|Banon=2|éclat cendré=3|crottin=4" "$(scope_state "$CAT_FRO" "$SUB_CHE")"

# 9C. Chemin numérique historique (set_product_order, SANS verrou
#     d'établissement) contre un déplacement en cours sur la même
#     ligne : il attend le verrou de ligne, puis s'applique -- jamais
#     d'écriture perdue en silence, jamais d'erreur.
P_JUS="$(pid 'Jus')"; ARR_BOI="$(ids 'Jus|Eau|Cidre')"
PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" >"$TMP/s1.out" 2>"$TMP/s1.err" <<SQL &
begin;
set local test.uid = '$OWNER_A';
select public.move_product_order('$P_JUS'::uuid, 'down', '$ARR_BOI'::uuid[]);
select pg_sleep(1.5);
commit;
SQL
S1_PID=$!
sleep 0.5
T0=$(date +%s%N)
PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
  -c "set local test.uid = '$MANAGER_A'; select public.set_product_order('$P_JUS'::uuid, 40);" >"$TMP/s2.out" 2>"$TMP/s2.err"
S2_RC=$?
T1=$(date +%s%N)
wait $S1_PID; S1_RC=$?
S2_MS=$(( (T1 - T0) / 1000000 ))
assert_eq "9C-a. déplacement validé" "0" "$S1_RC"
assert_eq "9C-b. set_product_order concurrent validé (sans erreur)" "0" "$S2_RC"
if [ "$S2_MS" -ge 600 ]; then pass "9C-c. set_product_order a attendu le verrou de ligne du déplacement (${S2_MS} ms)"; else fail "9C-c. set_product_order non sérialisé (${S2_MS} ms)"; fi
assert_eq "9C-d. état final cohérent : le déplacement PUIS la valeur numérique" "Eau=1|Cidre=3|Jus=40" "$(scope_state "$CAT_BOI" NULL)"
move "$OWNER_A" 'Jus' up 'Eau|Cidre|Jus'
assert_ok "9C-e. un déplacement ultérieur repart de l'état réel" "$MOVE_RC"
assert_eq "9C-f. … et redensifie le périmètre" "Eau=1|Jus=2|Cidre=3" "$(scope_state "$CAT_BOI" NULL)"

# 9C-bis. Le verrou couvre TOUT le périmètre, pas seulement les lignes
#     réécrites : dans un périmètre déjà dense, le déplacement de Eau ne
#     réécrit que Eau et Jus ; Cidre n'est PAS modifié, et pourtant une
#     écriture concurrente sur Cidre doit attendre la fin du déplacement
#     (le contrôle de l'ordre attendu et l'écriture portent ainsi sur le
#     même état du périmètre).
P_EAU="$(pid 'Eau')"; P_CIDRE="$(pid 'Cidre')"; ARR_BOI="$(ids 'Eau|Jus|Cidre')"
XMIN_CIDRE="$(q "select xmin::text from public.menu_items where name='Cidre';")"
PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" >"$TMP/s1.out" 2>"$TMP/s1.err" <<SQL &
begin;
set local test.uid = '$OWNER_A';
select public.move_product_order('$P_EAU'::uuid, 'down', '$ARR_BOI'::uuid[]);
select pg_sleep(1.5);
commit;
SQL
S1_PID=$!
sleep 0.5
XMIN_CIDRE_DURING="$(q "select xmin::text from public.menu_items where name='Cidre';")"
T0=$(date +%s%N)
PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
  -c "set local test.uid = '$MANAGER_A'; select public.set_product_order('$P_CIDRE'::uuid, 40);" >"$TMP/s2.out" 2>"$TMP/s2.err"
S2_RC=$?
T1=$(date +%s%N)
wait $S1_PID; S1_RC=$?
S2_MS=$(( (T1 - T0) / 1000000 ))
assert_eq "9C-bis-a. déplacement validé" "0" "$S1_RC"
assert_eq "9C-bis-b. la ligne voisine NON réécrite par le déplacement n'a pas été modifiée par lui (xmin inchangé)" "$XMIN_CIDRE" "$XMIN_CIDRE_DURING"
assert_eq "9C-bis-c. écriture concurrente sur cette ligne voisine validée (sans erreur)" "0" "$S2_RC"
if [ "$S2_MS" -ge 600 ]; then pass "9C-bis-d. … mais elle a ATTENDU la fin du déplacement : tout le périmètre est verrouillé (${S2_MS} ms)"; else fail "9C-bis-d. ligne voisine non verrouillée pendant le déplacement (${S2_MS} ms)"; fi
assert_eq "9C-bis-e. état final cohérent" "Jus=1|Eau=2|Cidre=40" "$(scope_state "$CAT_BOI" NULL)"
move "$OWNER_A" 'Eau' up 'Jus|Eau|Cidre'
assert_ok "9C-bis-f. remise en ordre" "$MOVE_RC"
assert_eq "9C-bis-g. périmètre redensifié" "Eau=1|Jus=2|Cidre=3" "$(scope_state "$CAT_BOI" NULL)"

# 9D. Rafale : 8 sessions simultanées, même périmètre, même vue de
#     départ. Exactement UNE gagne ; les sept autres sont périmées.
ARR_CHE="$(ids 'Zeste de chèvre|Banon|éclat cendré|crottin')"
P_CROTTIN="$(pid 'crottin')"
BURST_PIDS=""
for i in 1 2 3 4 5 6 7 8; do
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "set local test.uid = '$OWNER_A'; select public.move_product_order('$P_CROTTIN'::uuid, 'up', '$ARR_CHE'::uuid[]);" \
    >"$TMP/burst-$i.out" 2>"$TMP/burst-$i.err" &
  BURST_PIDS="$BURST_PIDS $!"
done
BURST_OK=0; BURST_STALE=0; BURST_OTHER=0
i=0
for p in $BURST_PIDS; do
  i=$((i+1))
  if wait "$p"; then BURST_OK=$((BURST_OK+1));
  elif grep -qF "SCANYM_PRODUCT_ORDER_STALE" "$TMP/burst-$i.err"; then BURST_STALE=$((BURST_STALE+1));
  else BURST_OTHER=$((BURST_OTHER+1)); fi
done
assert_eq "9D-a. rafale de 8 : exactement 1 accepté" "1" "$BURST_OK"
assert_eq "9D-b. rafale de 8 : 7 refusés comme périmés" "7" "$BURST_STALE"
assert_eq "9D-c. rafale de 8 : aucune autre erreur (ni interblocage, ni violation)" "0" "$BURST_OTHER"
assert_eq "9D-d. un seul échange appliqué" "Zeste de chèvre=1|Banon=2|crottin=3|éclat cendré=4" "$(scope_state "$CAT_FRO" "$SUB_CHE")"

# 9E. Charge : 6 ouvriers, chacun relit l'ordre courant puis déplace un
#     produit, 8 fois, en parallèle sur le même périmètre. Chaque
#     tentative est soit acceptée, soit périmée ; l'invariant final est
#     un périmètre dense, sans doublon, de même contenu.
worker() {
  local n="$1" ok=0 stale=0 other=0 k arr prod dir
  for k in 1 2 3 4 5 6 7 8; do
    arr="$(psql -X -A -q -t -d "$DB" -c "select '{' || string_agg(id::text, ',' order by display_order, id) || '}' from public.menu_items where subcategory_id = $SUB_CHE and archived_at is null;")"
    if [ $(( (n + k) % 2 )) -eq 0 ]; then
      prod="$(psql -X -A -q -t -d "$DB" -c "select id from public.menu_items where subcategory_id = $SUB_CHE and archived_at is null order by display_order, id offset 1 limit 1;")"; dir="up"
    else
      prod="$(psql -X -A -q -t -d "$DB" -c "select id from public.menu_items where subcategory_id = $SUB_CHE and archived_at is null order by display_order, id offset 2 limit 1;")"; dir="down"
    fi
    if PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
         -c "set local test.uid = '$OWNER_A'; select public.move_product_order('$prod'::uuid, '$dir', '$arr'::uuid[]);" \
         >/dev/null 2>"$TMP/w-$n-$k.err"; then
      ok=$((ok+1))
    elif grep -qF "SCANYM_PRODUCT_ORDER_STALE" "$TMP/w-$n-$k.err"; then stale=$((stale+1))
    else other=$((other+1)); fi
  done
  echo "$ok $stale $other" > "$TMP/w-$n.res"
}
W_PIDS=""
for n in 1 2 3 4 5 6; do worker "$n" & W_PIDS="$W_PIDS $!"; done
for p in $W_PIDS; do wait "$p"; done
W_OK=0; W_STALE=0; W_OTHER=0
for n in 1 2 3 4 5 6; do
  read -r a b c < "$TMP/w-$n.res"
  W_OK=$((W_OK+a)); W_STALE=$((W_STALE+b)); W_OTHER=$((W_OTHER+c))
done
assert_eq "9E-a. charge (48 tentatives) : chacune acceptée ou périmée" "48" "$((W_OK + W_STALE))"
assert_eq "9E-b. charge : aucune autre erreur" "0" "$W_OTHER"
if [ "$W_OK" -ge 1 ]; then pass "9E-c. charge : des déplacements ont bien été acceptés ($W_OK acceptés, $W_STALE périmés)"; else fail "9E-c. charge : aucun déplacement accepté"; fi
assert_eq "9E-d. charge : positions denses 1..N, aucun doublon" "true" "$(scope_dense "$CAT_FRO" "$SUB_CHE")"
assert_eq "9E-e. charge : même contenu de périmètre (4 produits)" "Banon|Zeste de chèvre|crottin|éclat cendré" \
  "$(q "select string_agg(name, '|' order by name collate \"C\") from public.menu_items where subcategory_id = $SUB_CHE and archived_at is null;")"

# ============================================================
log "=== [10] Ordre déterministe après rechargement ==="
READ_1="$(scope_state "$CAT_FRO" "$SUB_CHE")|$(scope_state "$CAT_FRO" NULL)|$(scope_state "$CAT_BOI" NULL)"
READ_2="$(scope_state "$CAT_FRO" "$SUB_CHE")|$(scope_state "$CAT_FRO" NULL)|$(scope_state "$CAT_BOI" NULL)"
assert_eq "10a. deux relectures successives donnent le même ordre" "$READ_1" "$READ_2"
assert_eq "10b. plus aucun ex æquo dans les périmètres réordonnés de A" "0" \
  "$(q "select count(*) from (select mi.category_id, mi.subcategory_id, mi.display_order from public.menu_items mi join public.menu_categories mc on mc.id = mi.category_id where mc.restaurant_id = '$RID_A' and mi.archived_at is null group by 1,2,3 having count(*) > 1) d;")"

# get_merchant_catalogue (back-office) rend chaque périmètre dans l'ordre persisté.
EXPECTED_BOI="$(q "select string_agg(name, '|' order by display_order) from public.menu_items where category_id = '$CAT_BOI' and archived_at is null;")"
as_user "$OWNER_A" "select string_agg(name, '|' order by rn) from (select name, row_number() over () as rn from public.get_merchant_catalogue('$RID_A'::uuid, false) where category_id = '$CAT_BOI' and product_id is not null) c;"
assert_eq "10c. get_merchant_catalogue (propriétaire) rend l'ordre persisté" "$EXPECTED_BOI" "$(last_out)"

# ============================================================
log "=== [11] La carte client lit l'ordre du back-office ==="
# Lecture PUBLIQUE (rôle anon, policies RLS réelles) des colonnes que
# lib/services/restaurant.ts trie : display_order au sein du groupe.
EXPECTED_PUBLIC="$(q "select string_agg(name, '|' order by display_order) from public.menu_items where category_id = '$CAT_FRO' and subcategory_id is null and archived_at is null and is_available;")"
as_anon "select string_agg(name, '|' order by display_order, name) from public.menu_items where category_id = '$CAT_FRO' and subcategory_id is null and archived_at is null and is_available;"
assert_eq "11a. anon lit les produits directs disponibles dans l'ordre persisté (indisponible masqué, ordre relatif conservé)" "$EXPECTED_PUBLIC" "$(last_out)"
as_anon "select string_agg(name || '=' || display_order, '|' order by display_order, name) from public.menu_items where subcategory_id = $SUB_CHE and archived_at is null and is_available;"
assert_eq "11b. anon lit la sous-catégorie dans l'ordre persisté" "$(scope_state "$CAT_FRO" "$SUB_CHE")" "$(last_out)"

# ============================================================
log "=== [12] Cohabitation : création, import, édition, archivage ==="
# create_product (chemin de l'import catalogue, ligne par ligne dans
# l'ordre du fichier) : un nouveau produit arrive en FIN de périmètre.
as_user "$OWNER_A" "select public.create_product(p_category_id => '$CAT_BOI'::uuid, p_name => 'Limonade', p_description => null, p_price => 3.50, p_tax_rate => 5.5);"
assert_ok "12a. create_product après renumérotation" $?
assert_eq "12b. le nouveau produit est en fin de périmètre" "Eau=1|Jus=2|Cidre=3|Limonade=4" "$(scope_state "$CAT_BOI" NULL)"
as_user "$OWNER_A" "select public.create_product(p_category_id => '$CAT_BOI'::uuid, p_name => 'Sirop', p_description => null, p_price => 2.50, p_tax_rate => 5.5);"
assert_eq "12c. deux créations successives conservent leur ordre de création (ordre du fichier d'import)" "Eau=1|Jus=2|Cidre=3|Limonade=4|Sirop=5" "$(scope_state "$CAT_BOI" NULL)"
move "$OWNER_A" 'Jus' up 'Eau|Jus|Cidre'
assert_refused "12d. une vue antérieure à la création est périmée" "$MOVE_RC" "SCANYM_PRODUCT_ORDER_STALE"
move "$OWNER_A" 'Sirop' up 'Eau|Jus|Cidre|Limonade|Sirop'
assert_ok "12e. déplacement avec la vue à jour" "$MOVE_RC"
assert_eq "12f. ordre" "Eau=1|Jus=2|Cidre=3|Sirop=4|Limonade=5" "$(scope_state "$CAT_BOI" NULL)"

# update_product (chemin UPDATE de l'import) ne touche jamais l'ordre.
P_SIROP="$(pid 'Sirop')"
as_user "$OWNER_A" "select public.update_product(p_product_id => '$P_SIROP'::uuid, p_name => 'Sirop', p_description => 'Menthe', p_price => 2.80, p_tax_rate => 5.5);"
assert_ok "12g. update_product sur un produit réordonné" $?
assert_eq "12h. update_product ne modifie pas display_order" "Eau=1|Jus=2|Cidre=3|Sirop=4|Limonade=5" "$(scope_state "$CAT_BOI" NULL)"

# Archivage puis restauration.
as_user "$OWNER_A" "select public.archive_product('$(pid 'Cidre')'::uuid);"
assert_ok "12i. archive_product" $?
move "$OWNER_A" 'Cidre' up 'Eau|Jus|Cidre|Sirop|Limonade'
assert_refused "12j. un produit archivé ne se réordonne pas" "$MOVE_RC" "Product not found or archived"
move "$OWNER_A" 'Sirop' up 'Eau|Jus|Cidre|Sirop|Limonade'
assert_refused "12k. une vue contenant le produit désormais archivé est périmée" "$MOVE_RC" "SCANYM_PRODUCT_ORDER_STALE"
move "$OWNER_A" 'Sirop' up 'Eau|Jus|Sirop|Limonade'
assert_ok "12l. déplacement dans le périmètre sans l'archivé" "$MOVE_RC"
assert_eq "12m. périmètre redensifié sans l'archivé" "Eau=1|Sirop=2|Jus=3|Limonade=4" "$(scope_state "$CAT_BOI" NULL)"
assert_eq "12n. la valeur de l'archivé n'a pas été réécrite" "3" "$(q "select display_order from public.menu_items where name='Cidre';")"
as_user "$OWNER_A" "select public.restore_product('$(pid 'Cidre')'::uuid);"
assert_ok "12o. restore_product" $?
# Cidre (3) et Jus (3) sont ex æquo : l'un ou l'autre ordre est accepté,
# le déplacement redensifie.
move "$OWNER_A" 'Limonade' up 'Eau|Sirop|Cidre|Jus|Limonade'
assert_ok "12p. après restauration (ex æquo), l'ordre affiché est accepté" "$MOVE_RC"
assert_eq "12q. périmètre dense, 5 produits" "Eau=1|Sirop=2|Cidre=3|Limonade=4|Jus=5" "$(scope_state "$CAT_BOI" NULL)"

# update_product change la SOUS-CATÉGORIE (même catégorie) : le produit
# rejoint l'autre périmètre avec sa valeur ; la vue d'avant est périmée
# dans les deux périmètres.
P_OSSAU="$(pid 'Ossau')"
as_user "$OWNER_A" "select public.update_product(p_product_id => '$P_OSSAU'::uuid, p_name => 'Ossau', p_description => null, p_price => 9.00, p_tax_rate => 5.5, p_subcategory_id => 'aaaaaaaa-0000-0000-0000-0000000000d1'::uuid);"
assert_ok "12r. update_product déplace Ossau de Brebis vers Chèvres (taxonomie : chemin existant, hors de ce lot)" $?
CHE_NOW="$(q "select string_agg(name, '|' order by display_order, name) from public.menu_items where subcategory_id = $SUB_CHE and archived_at is null;")"
move "$OWNER_A" 'Ossau' up "$CHE_NOW"
if [ "$MOVE_RC" -eq 0 ] || grep -qF "SCANYM_PRODUCT_ORDER_BOUNDARY" "$ERR"; then
  pass "12s. le produit arrivé dans le périmètre se réordonne avec ses nouveaux voisins"
else
  fail "12s. déplacement du produit arrivé refusé : $(tr '\n' ' ' < "$ERR" | cut -c1-200)"
fi
assert_eq "12t. Chèvres : 5 produits, dense après déplacement" "5|true" \
  "$(q "select count(*) from public.menu_items where subcategory_id = $SUB_CHE and archived_at is null;")|$( [ "$MOVE_RC" -eq 0 ] && scope_dense "$CAT_FRO" "$SUB_CHE" || echo true )"
# Remise en place pour l'empreinte de taxonomie finale.
as_user "$OWNER_A" "select public.update_product(p_product_id => '$P_OSSAU'::uuid, p_name => 'Ossau', p_description => null, p_price => 9.00, p_tax_rate => 5.5, p_subcategory_id => 'aaaaaaaa-0000-0000-0000-0000000000d2'::uuid);"

# set_product_order (champ numérique historique) fonctionne toujours.
as_user "$OWNER_A" "select public.set_product_order('$(pid 'Eau')'::uuid, 7);"
assert_ok "12u. set_product_order (V67b) toujours opérationnelle" $?
assert_eq "12v. … et écrit la valeur demandée" "7" "$(q "select display_order from public.menu_items where name='Eau';")"

# ============================================================
log "=== [13] Non-régression disponibilité et modes de vente ==="
# Les produits créés / archivés / restaurés / édités en [12] le sont par
# LEURS RPC ; on vérifie ici que les DÉPLACEMENTS, eux, n'ont touché à
# rien d'autre que l'ordre sur les produits d'origine.
assert_eq "13a. disponibilité des produits d'origine inchangée par tous les déplacements" \
  "Abondance=false|Banon=true|Beaufort=true|Comté=true|Eau=true|Jus=true|Ossau=true|Roquefort=true|Zeste de chèvre=true|crottin=true|éclat cendré=true" \
  "$(q "select string_agg(mi.name || '=' || mi.is_available::text, '|' order by mi.name collate \"C\") from public.menu_items mi join public.menu_categories mc on mc.id = mi.category_id where mc.restaurant_id = '$RID_A' and mi.name in ('Abondance','Banon','Beaufort','Comté','Eau','Jus','Ossau','Roquefort','Zeste de chèvre','crottin','éclat cendré');")"
assert_eq "13b. restriction de mode de vente de Comté intacte (retrait uniquement)" "pickup" \
  "$(q "select string_agg(mode_code, ',' order by mode_code) from public.menu_item_sale_modes where menu_item_id = '$(pid 'Comté')';")"
assert_eq "13c. aucun mode de vente créé pour un autre produit" "1" "$(q "select count(*) from public.menu_item_sale_modes;")"
assert_eq "13d. prix, TVA, noms, archivage des produits jamais édités : inchangés" \
  "$(q_in "$DB_TEMPLATE" "select md5(string_agg((to_jsonb(mi) - 'display_order' - 'updated_at')::text, ',' order by mi.name collate \"C\")) from public.menu_items mi where mi.name in ('Abondance','Banon','Beaufort','Comté','Jus','Roquefort','Zeste de chèvre','crottin','éclat cendré','Ancien chèvre','B-Un','B-Deux','B-Trois');")" \
  "$(q "select md5(string_agg((to_jsonb(mi) - 'display_order' - 'updated_at')::text, ',' order by mi.name collate \"C\")) from public.menu_items mi where mi.name in ('Abondance','Banon','Beaufort','Comté','Jus','Roquefort','Zeste de chèvre','crottin','éclat cendré','Ancien chèvre','B-Un','B-Deux','B-Trois');")"
ORDER_BEAUFORT="$(q "select display_order from public.menu_items where name='Beaufort';")"
as_user "$STAFF_A" "select public.set_product_availability('$(pid 'Beaufort')'::uuid, false);"
assert_ok "13e. set_product_availability (staff) fonctionne après réordonnancement" $?
assert_eq "13f. … bascule la disponibilité sans effet sur l'ordre" "false|$ORDER_BEAUFORT" \
  "$(q "select is_available::text || '|' || display_order from public.menu_items where name='Beaufort';")"
as_user "$OWNER_A" "select public.update_product(p_product_id => '$(pid 'Beaufort')'::uuid, p_name => 'Beaufort', p_description => null, p_price => 14.00, p_tax_rate => 5.5, p_allowed_sale_modes => array['delivery']);"
assert_ok "13g. update_product restreint les modes de vente d'un produit réordonné" $?
assert_eq "13h. … restriction enregistrée, ordre inchangé" "delivery|$ORDER_BEAUFORT" \
  "$(q "select (select string_agg(mode_code, ',') from public.menu_item_sale_modes where menu_item_id = mi.id) || '|' || mi.display_order from public.menu_items mi where mi.name='Beaufort';")"

# ============================================================
log "=== [14] Marchand historique jamais réordonné : strictement inchangé ==="
assert_eq "14a. établissement B : (id, display_order) identique à l'état d'avant le lot" "$FP_B_ORDER" "$(scope_fp "$CAT_B" NULL)"
assert_eq "14b. établissement B : toujours trois ex æquo à 0 (aucune matérialisation sans geste du marchand)" "3|0|0" \
  "$(q "select count(*)::text || '|' || min(display_order) || '|' || max(display_order) from public.menu_items where category_id = '$CAT_B';")"
assert_eq "14c. taxonomie de tous les produits d'origine inchangée de bout en bout" "$FP_TAXONOMY" \
  "$(q "select md5(string_agg(mi.id::text || ':' || mi.category_id::text || ':' || coalesce(mi.subcategory_id::text, '-'), ',' order by mi.id)) from public.menu_items mi where mi.name not in ('Limonade','Sirop');")"

# ============================================================
log "=== [15] Anti-dérive — refus sans aucune modification ==="
psql -X -d "$DB" -v ON_ERROR_STOP=1 -f "$LOT_SQL" >"$OUT" 2>"$ERR"
assert_refused "15a. double application refusée" $? "SCANYM_SCHEMA_DRIFT"
assert_eq "15b. … la fonction installée est toujours unique" "1" "$(fn_count_in "$DB")"

lot_fn_count_in() {
  q_in "$1" "select count(*) from pg_proc p where p.oid = to_regprocedure('public.move_product_order(uuid, text, uuid[])');"
}
drift_case() {
  # $1 libellé, $2 SQL de dérive, $3 motif attendu
  clone_template "$DB_SCRATCH"
  psql -X -d "$DB_SCRATCH" -v ON_ERROR_STOP=1 -c "$2" >/dev/null 2>"$ERR" || { fail "$1 — préparation de la dérive impossible : $(cat "$ERR")"; return; }
  local fp_before; fp_before="$(order_fp_in "$DB_SCRATCH")"
  # SANS ON_ERROR_STOP : le contrôle est DANS la transaction, le commit
  # final d'une transaction avortée est un rollback.
  psql -X -d "$DB_SCRATCH" -f "$LOT_SQL" >"$OUT" 2>"$ERR"
  if grep -qF -- "$3" "$ERR" && [ "$(lot_fn_count_in "$DB_SCRATCH")" = "0" ] && [ "$(order_fp_in "$DB_SCRATCH")" = "$fp_before" ]; then
    pass "$1 (refusé : $3 ; RPC du lot non créée, données intactes, même sans ON_ERROR_STOP)"
  else
    fail "$1 — attendu '$3' et aucune création ; RPC du lot=$(lot_fn_count_in "$DB_SCRATCH") ; erreur : $(grep -m1 ERROR "$ERR" | cut -c1-200)"
  fi
}
drift_case "15c. dérive : surcharge de assert_product_role" \
  "create function public.assert_product_role(p_product_id uuid) returns uuid language sql as 'select null::uuid';" "SCANYM_SCHEMA_DRIFT"
drift_case "15d. dérive : menu_items.display_order n'est plus integer" \
  "alter table public.menu_items alter column display_order type bigint;" "SCANYM_SCHEMA_DRIFT"
drift_case "15e. dérive : droit UPDATE direct accordé à authenticated" \
  "grant update on public.menu_items to authenticated;" "SCANYM_SCHEMA_DRIFT"
drift_case "15f. dérive : set_product_order absente" \
  "drop function public.set_product_order(uuid, integer);" "SCANYM_SCHEMA_DRIFT"
drift_case "15g. dérive : assert_product_role sans search_path vide" \
  "alter function public.assert_product_role(uuid, text[]) reset search_path;" "SCANYM_SCHEMA_DRIFT"
drift_case "15h. dérive : RLS désactivée sur menu_items" \
  "alter table public.menu_items disable row level security;" "SCANYM_SCHEMA_DRIFT"
drift_case "15i. dérive : une fonction move_product_order d'une autre signature existe déjà" \
  "create function public.move_product_order(p uuid) returns integer language sql as 'select 1';" "SCANYM_SCHEMA_DRIFT"

# ============================================================
log "=== [16] Rollback ==="
FP_ORDER_BEFORE_RB="$(order_fp_in "$DB")"
FP_NON_ORDER_BEFORE_RB="$(non_order_fp)"
psql -X -d "$DB" -v ON_ERROR_STOP=1 -f "$ROLLBACK_SQL" >"$OUT" 2>"$ERR"
assert_ok "16a. le rollback s'exécute intégralement" $?
assert_eq "16b. move_product_order supprimée" "0" "$(fn_count_in "$DB")"
assert_eq "16c. les ordres enregistrés par les marchands sont CONSERVÉS (aucune donnée réécrite)" "$FP_ORDER_BEFORE_RB" "$(order_fp_in "$DB")"
assert_eq "16d. aucune autre donnée produit touchée par le rollback" "$FP_NON_ORDER_BEFORE_RB" "$(non_order_fp)"
assert_eq "16e. set_product_order et assert_product_role intactes" "2" \
  "$(q "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('set_product_order','assert_product_role');")"
as_user "$OWNER_A" "select public.set_product_order('$(pid 'Eau')'::uuid, 1);"
assert_ok "16f. le champ numérique historique fonctionne après rollback" $?
psql -X -d "$DB" -v ON_ERROR_STOP=1 -f "$ROLLBACK_SQL" >"$OUT" 2>"$ERR"
assert_refused "16g. relancer le rollback sur une base déjà rétrogradée est refusé" $? "SCANYM_ROLLBACK_DRIFT"
psql -X -d "$DB" -v ON_ERROR_STOP=1 -f "$LOT_SQL" >"$OUT" 2>"$ERR"
assert_ok "16h. le lot se réinstalle après rollback" $?
move "$OWNER_A" 'Roquefort' down 'Roquefort|Ossau'
assert_ok "16i. … et la RPC réinstallée fonctionne sur les ordres conservés" "$MOVE_RC"

clone_template "$DB_SCRATCH"
FP_SCRATCH="$(order_fp_in "$DB_SCRATCH")"
psql -X -d "$DB_SCRATCH" -f "$ROLLBACK_SQL" >"$OUT" 2>"$ERR"
if grep -qF "SCANYM_ROLLBACK_DRIFT" "$ERR" && [ "$(order_fp_in "$DB_SCRATCH")" = "$FP_SCRATCH" ]; then
  pass "16j. rollback sur une base qui n'a jamais reçu le lot : refusé, aucune mutation (même sans ON_ERROR_STOP)"
else
  fail "16j. rollback sur base vierge : $(grep -m1 ERROR "$ERR" | cut -c1-200)"
fi

# ============================================================
log "=== RÉSUMÉ : PASS=$PASS FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ]
