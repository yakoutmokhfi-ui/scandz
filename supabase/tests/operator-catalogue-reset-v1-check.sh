#!/usr/bin/env bash
# ============================================================
# Scanym — CLAUDE NOUGARO — OPERATOR BACKOFFICE — SAFE CATALOGUE
# RESET v1.1 — harnais SQL réel (PostgreSQL réel, aucune simulation),
# exécuté en tant qu'utilisateur système postgres (authentification
# peer). Même style/idiome que supabase/tests/catalogue-import-
# commit-v1-1-check.sh et supabase/tests/catalogue-subcategories-
# backoffice-v1-check.sh (réutilisés tels quels).
#
# v1.1 (remédiation CTO) ajoute : [v1.1 CONFIRM A-G] confirmation
# serveur (phrase absente/vide/erronée/autre marchand/casse/espacement,
# bypass UI direct par RPC, tenant B intact) ; assertions is_active
# sur les catégories/sous-catégorie retenues (désactivées, jamais
# supprimées) et sur get_merchant_catalogue qui les expose ;
# [v1.1 Q/R] preuve fonctionnelle qu'un réimport peut créer une
# catégorie/sous-catégorie de MÊME NOM que la structure retenue-
# désactivée, sans violation d'unicité.
#
# Chaîne de migrations : MINIMAL_CHAIN + REST_CHAIN (identiques à
# catalogue-import-commit-v1-1-check.sh, déjà prouvées), suivies de
# DRAFT-lot-catalogue-operator-authorization-v1.sql (OB-2, prérequis
# is_scanym_operator() bypass sur get_merchant_catalogue),
# DRAFT-lot-catalogue-import-commit-idempotency-v1-1.sql (OB-4,
# prérequis create_product actuel), DRAFT-lot-catalogue-vat-
# completeness-guard-v1.sql (seul fichier supplémentaire, publié
# entre le baseline OB-4 v1.2 et le baseline de ce lot, qui altère
# menu_items/create_product/update_product -- confirmé par grep
# exhaustif "alter table.*menu_items|create (or replace) function
# public.(create_product|update_product)" sur tous les fichiers
# supabase/*.sql absents des deux chaînes ci-dessus ; TOUS les autres
# fichiers supplémentaires (payment/stuart/CGV/invoice/delivery/n1a/
# merchant-legal-tax/seed/rollback/update-*) ne touchent JAMAIS
# menu_items/menu_categories/menu_subcategories/order_items/
# restaurants/restaurant_users/scanym_operators/is_scanym_operator --
# même principe de "chaîne du domaine le plus proche" déjà pratiqué
# par tous les harnais siblings de ce dépôt), puis
# DRAFT-lot-operator-catalogue-reset-v1.sql (CE LOT).
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/operator-catalogue-reset-v1-check.sh"
# ============================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OB2_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-operator-authorization-v1.sql"
OB4_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-import-commit-idempotency-v1-1.sql"
VAT_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-vat-completeness-guard-v1.sql"
RESET_SQL="$SUPABASE_DIR/DRAFT-lot-operator-catalogue-reset-v1.sql"
ROLLBACK_SQL="$SUPABASE_DIR/DRAFT-lot-operator-catalogue-reset-v1-ROLLBACK.sql"
DB="scanym_catreset_v1_$$"
# v1.2 -- base DÉDIÉE au scénario de rollback : un rollback SUPPRIME le
# lot (fonctions, table d'audit, colonne), il ne peut donc pas partager
# la base des 87 autres assertions sans les invalider.
DB_ROLLBACK="scanym_catreset_rb_$$"

PASS=0
FAIL=0
FAIL_LOG="/tmp/scanym-catreset-fails-$$.log"
: > "$FAIL_LOG"

log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS=$((PASS+1)); log "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); printf '%s\n' "$1" >> "$FAIL_LOG"; log "FAIL: $1"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_ROLLBACK\";" >/dev/null 2>&1 || true
  rm -f "$FAIL_LOG" /tmp/scanym-catreset-*-$$.txt /tmp/scanym-catreset-fixture-$$.txt /tmp/scanym-catreset-chain-err-$$.txt 2>/dev/null || true
}
trap cleanup EXIT

sql() { psql -X -A -q -t -d "$DB" -c "$1" 2>/tmp/scanym-catreset-err-$$.txt; }
sql_rc() { psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-catreset-out-$$.txt 2>/tmp/scanym-catreset-err-$$.txt; echo $?; }
sql_err() { cat /tmp/scanym-catreset-err-$$.txt 2>/dev/null; }

as_authenticated() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    2>/tmp/scanym-catreset-err-$$.txt
}
as_authenticated_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    >/tmp/scanym-catreset-out-$$.txt 2>/tmp/scanym-catreset-err-$$.txt
  echo $?
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_ok() { if [ "$2" -eq 0 ]; then pass "$1 (rc=0)"; else fail "$1 — attendu rc=0, obtenu rc=$2 : $(sql_err)"; fi }
assert_denied() { if [ "$2" -ne 0 ]; then pass "$1 (rc=$2, refusé comme attendu)"; else fail "$1 — attendu un refus (rc!=0), obtenu rc=0"; fi }
assert_contains() { if printf '%s' "$3" | grep -qF "$2"; then pass "$1"; else fail "$1 — '$2' absent de : $3"; fi }

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

MINIMAL_CHAIN="schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql"
REST_CHAIN="migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v76-storage-origin-config.sql migration-v71-hardening.sql migration-v72-hardening.sql migration-v73-hardening.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql migration-v82-lot2a-sale-modes.sql migration-v83-lot2a4-privilege-hardening.sql migration-v84-lot2b1-delivery-info-rpc.sql DRAFT-lot-fulfillment-routing-model.sql DRAFT-lot-fulfillment-routing-lot-b-rpc.sql DRAFT-lot-server-delivery-fulfillment-pricing.sql DRAFT-lot-payment-p3b6-checkout-billing-context.sql DRAFT-lot-customer-order-tracking-foundation.sql DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql DRAFT-lot-receipt-invoice-tax-detail-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1-1-remediation.sql DRAFT-lot-payment-p1-foundation.sql DRAFT-lot-merchant-delivery-pricing.sql DRAFT-lot-orders-service-role-select-hardening.sql"

build_chain() {
  for f in $MINIMAL_CHAIN; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>/tmp/scanym-catreset-chain-err-$$.txt
    if [ $? -ne 0 ]; then log "FATAL applying $f: $(cat /tmp/scanym-catreset-chain-err-$$.txt)"; return 1; fi
    psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  done
  for f in $REST_CHAIN; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>/tmp/scanym-catreset-chain-err-$$.txt
    if [ $? -ne 0 ]; then log "FATAL applying $f: $(cat /tmp/scanym-catreset-chain-err-$$.txt)"; return 1; fi
  done
  for f in "$OB2_SQL" "$OB4_SQL" "$VAT_SQL" "$RESET_SQL"; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>/tmp/scanym-catreset-chain-err-$$.txt
    if [ $? -ne 0 ]; then log "FATAL applying $(basename "$f"): $(cat /tmp/scanym-catreset-chain-err-$$.txt)"; return 1; fi
  done
  return 0
}

log "=== [SETUP] création base $DB, bootstrap auth/storage, chaîne complète + CATALOGUE RESET v1 ==="
psql -c "create database \"$DB\";" >/dev/null 2>&1
build_common_bootstrap
if ! build_chain; then
  log "FATAL: chaîne de migrations a échoué"
  exit 1
fi
log "=== chaîne appliquée avec succès (schema.sql .. OB2 .. OB4 .. VAT guard .. CATALOGUE RESET v1) ==="

# ------------------------------------------------------------------
# [FIXTURE] Deux établissements distincts, mêmes noms de
# catégorie/produit ("Fromages"/"Raclette") -- mandat §21.
#   Tenant A = Au Lait Cru : 2 catégories peuplées (jamais videables),
#     1 catégorie VIDE (jamais peuplée -- doit être supprimée),
#     1 sous-catégorie VIDE sous une catégorie peuplée (doit être
#     supprimée), 1 sous-catégorie PEUPLÉE (doit être retenue),
#     1 produit déjà archivé AVANT le reset (ne doit pas être
#     re-compté), 1 produit référencé par une commande historique.
#   Tenant B = Hotel Royal : catégories/produits de MÊMES NOMS,
#     jamais touchés par le reset de A.
#   1 opérateur Scanym, 1 owner ordinaire (non-opérateur), 1 compte
#   authentifié sans aucun rattachement (ni operator ni restaurant_users).
# ------------------------------------------------------------------
log "=== [FIXTURE] tenants A (Au Lait Cru) / B (Hotel Royal), opérateur, comptes non autorisés ==="
psql -d "$DB" -v ON_ERROR_STOP=1 >/tmp/scanym-catreset-fixture-$$.txt 2>&1 <<'SQL'
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'operator@scanym.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'owner-alc@example.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'owner-royal@example.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'stranger@example.test');

insert into public.scanym_operators (user_id) values ('00000000-0000-0000-0000-0000000000a1');

insert into public.restaurants (id, name, slug, is_active) values
  ('00000000-0000-0000-0000-00000000b001', 'Au Lait Cru', 'au-lait-cru', true),
  ('00000000-0000-0000-0000-00000000b002', 'Hotel Royal', 'hotel-royal', true);

insert into public.restaurant_users (user_id, restaurant_id, role) values
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000b001', 'owner'),
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-00000000b002', 'owner');

-- Tenant A -- catégories : 2 peuplées, 1 vide
insert into public.menu_categories (id, restaurant_id, name, display_order) values
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000b001', 'Fromages', 1),
  ('00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-00000000b001', 'Boissons', 2),
  ('00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-00000000b001', 'Categorie Vide A', 3);

-- Tenant A -- sous-catégories : 1 peuplée sous Fromages, 1 vide sous Fromages
insert into public.menu_subcategories (id, category_id, name, display_order) values
  ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000c001', 'Chevres', 1),
  ('00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-00000000c001', 'Sous-cat Vide A', 2);

-- Tenant A -- produits
insert into public.menu_items (id, category_id, subcategory_id, name, price, display_order, is_available, archived_at, tax_rate) values
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000d001', 'Charolais', 4.50, 1, true, null, 5.5),
  ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-00000000c002', null, 'Raclette', 7.00, 1, true, null, 5.5),
  ('00000000-0000-0000-0000-00000000e003', '00000000-0000-0000-0000-00000000c002', null, 'Eau minerale', 1.50, 2, false, now(), null);

-- Commande historique référencant Charolais (e001) -- doit survivre intacte.
insert into public.orders (id, restaurant_id, order_number, status, service_mode, subtotal, total, currency)
  values ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000b001', 1, 'completed', 'pickup', 4.50, 4.50, 'EUR');
insert into public.order_items (order_id, menu_item_id, item_name, quantity, unit_price, line_total)
  values ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000e001', 'Charolais', 1, 4.50, 4.50);

-- Tenant B -- MÊMES noms de catégorie/produit que A, jamais touché.
insert into public.menu_categories (id, restaurant_id, name, display_order) values
  ('00000000-0000-0000-0000-00000000c101', '00000000-0000-0000-0000-00000000b002', 'Fromages', 1),
  ('00000000-0000-0000-0000-00000000c102', '00000000-0000-0000-0000-00000000b002', 'Boissons', 2);
insert into public.menu_subcategories (id, category_id, name, display_order) values
  ('00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000c101', 'Chevres', 1);
insert into public.menu_items (id, category_id, subcategory_id, name, price, display_order, is_available, tax_rate) values
  ('00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-00000000c101', '00000000-0000-0000-0000-00000000d101', 'Raclette', 9.00, 1, true, 5.5);
SQL
fixture_rc=$?
if [ "$fixture_rc" -eq 0 ]; then
  pass "[FIXTURE] tenants A/B, opérateur, propriétaires, commande historique insérés"
else
  fail "[FIXTURE] échec du chargement (rc=$fixture_rc) : $(cat /tmp/scanym-catreset-fixture-$$.txt)"
  log "FATAL: fixture incomplète, arrêt du harnais"
  cat /tmp/scanym-catreset-fixture-$$.txt
  exit 1
fi

RESTA="00000000-0000-0000-0000-00000000b001"
RESTB="00000000-0000-0000-0000-00000000b002"
OPERATOR="00000000-0000-0000-0000-0000000000a1"
OWNER_A="00000000-0000-0000-0000-0000000000a2"
STRANGER="00000000-0000-0000-0000-0000000000a4"

# v1.1 -- phrase de confirmation EXACTE attendue par le serveur pour
# Au Lait Cru (dérivée par reset_merchant_catalogue depuis
# restaurants.name -- 'RESET ' || nom tel quel, AUCUNE mise en
# majuscule -- voir en-tête de DRAFT-lot-operator-catalogue-reset-v1
# .sql pour le rationale du changement depuis v1).
PHRASE_A="RESET Au Lait Cru"
PHRASE_B="RESET Hotel Royal"

# ==================================================================
# [C/D] AUTHORIZATION — l'autorisation SERVEUR doit refuser tout
# appelant non-opérateur, y compris le PROPRE owner du restaurant
# ciblé (action Operator Backoffice, sans repli owner/manager) --
# AVANT même que la confirmation ne soit évaluée (phrase volontairement
# vide ici : l'échec doit survenir sur l'autorisation, jamais sur la
# confirmation).
# ==================================================================
log "=== [C/D] AUTORISATION — non-opérateur, owner du restaurant lui-même, compte anonyme ==="
rc=$(as_authenticated_rc "$STRANGER" "select * from public.reset_merchant_catalogue('$RESTA', '');")
assert_denied "reset refusé pour un compte authentifié sans rattachement" "$rc"
assert_contains "message 42501 (stranger)" "Not authorized" "$(sql_err)"

rc=$(as_authenticated_rc "$OWNER_A" "select * from public.reset_merchant_catalogue('$RESTA', '$PHRASE_A');")
assert_denied "reset refusé pour le PROPRE owner du restaurant ciblé (operator-only, aucun repli owner/manager) -- même avec la phrase EXACTE" "$rc"
assert_contains "message 42501 (owner)" "Not authorized" "$(sql_err)"

rc=$(sql_rc "select * from public.reset_merchant_catalogue('$RESTA', '$PHRASE_A');")
assert_denied "reset refusé sans authentification (role postgres direct, auth.uid() NULL)" "$rc"

rc=$(as_authenticated_rc "$STRANGER" "select * from public.preview_catalogue_reset('$RESTA');")
assert_denied "preview refusé pour un compte non-opérateur" "$rc"

audit_count_after_auth_denials=$(sql "select count(*) from public.catalogue_reset_audit_log;")
assert_eq "[C/D] aucune ligne d'audit écrite par les 3 tentatives refusées pour AUTORISATION (échec avant même l'évaluation de la confirmation)" "0" "$audit_count_after_auth_denials"

# ==================================================================
# [A/B] PREVIEW — lecture seule, compteurs scopés au tenant A.
# ==================================================================
log "=== [A/B] PREVIEW — comptage exact, aucune mutation ==="
before_products=$(sql "select count(*) from public.menu_items where archived_at is null;")
out=$(as_authenticated "$OPERATOR" "select active_products_count, archived_products_count, subcategories_total, subcategories_removable, subcategories_retained, categories_total, categories_removable, categories_retained, products_with_order_history, categories_active_after_reset, subcategories_active_after_reset from public.preview_catalogue_reset('$RESTA');")
IFS='|' read -r p_active p_archived p_sub_total p_sub_removable p_sub_retained p_cat_total p_cat_removable p_cat_retained p_order_hist p_cat_active_after p_sub_active_after <<< "$out"
assert_eq "[A] preview active_products_count = 2 (Charolais+Raclette, Eau minerale déjà archivée exclue)" "2" "$p_active"
assert_eq "[A] preview archived_products_count = 1 (Eau minerale, déjà archivée AVANT ce reset)" "1" "$p_archived"
assert_eq "[A] preview subcategories_total = 2" "2" "$p_sub_total"
assert_eq "[A] preview subcategories_removable = 1 (Sous-cat Vide A)" "1" "$p_sub_removable"
assert_eq "[A] preview subcategories_retained = 1 (Chevres, porte Charolais)" "1" "$p_sub_retained"
assert_eq "[A] preview categories_total = 3" "3" "$p_cat_total"
assert_eq "[A] preview categories_removable = 1 (Categorie Vide A)" "1" "$p_cat_removable"
assert_eq "[A] preview categories_retained = 2 (Fromages, Boissons -- toutes deux peuplées)" "2" "$p_cat_retained"
assert_eq "[A] preview products_with_order_history = 1 (Charolais, référencé par la commande historique)" "1" "$p_order_hist"
assert_eq "[v1.1] preview categories_active_after_reset = 0 (désactivation inconditionnelle des catégories retenues)" "0" "$p_cat_active_after"
assert_eq "[v1.1] preview subcategories_active_after_reset = 0 (désactivation inconditionnelle des sous-catégories retenues)" "0" "$p_sub_active_after"

after_products=$(sql "select count(*) from public.menu_items where archived_at is null;")
assert_eq "[B] preview répété = ZÉRO mutation (active products inchangé)" "$before_products" "$after_products"
audit_rows_before_commit=$(sql "select count(*) from public.catalogue_reset_audit_log;")
assert_eq "[B] preview n'écrit AUCUNE ligne d'audit (lecture seule stricte)" "0" "$audit_rows_before_commit"

# Tenant B totalement intact à ce stade (aucune lecture/mutation
# croisée n'a jamais pu se produire depuis un appel scopé à A).
b_active_before=$(sql "select count(*) from public.menu_items mi join public.menu_categories mc on mc.id = mi.category_id where mc.restaurant_id = '$RESTB' and mi.archived_at is null;")
assert_eq "[F] tenant B intact après preview de A (1 produit actif)" "1" "$b_active_before"

# ==================================================================
# [v1.1 CONFIRM A-G] STRONG CONFIRMATION SERVEUR — remédiation CTO.
# Un opérateur PARFAITEMENT autorisé, appelant reset_merchant_catalogue
# DIRECTEMENT en SQL (aucune UI impliquée -- exactement le scénario
# "bypass UI" du mandat v1.1 §2.F), avec une phrase absente/vide/
# erronée/pour un autre marchand/de casse ou d'espacement différent :
# TOUJOURS refusé, TOUJOURS zéro mutation, TOUJOURS un événement
# d'audit 'rejected_confirmation' (jamais 'completed'/'no_op').
# ==================================================================
log "=== [v1.1 CONFIRM A-G] STRONG CONFIRMATION SERVEUR — phrase absente/vide/erronée/autre marchand/casse/espacement ==="

products_before_confirm_tests=$(sql "select count(*) from public.menu_items mi join public.menu_categories mc on mc.id = mi.category_id where mc.restaurant_id = '$RESTA' and mi.archived_at is null;")

# [A] Phrase erronée (mot correct, contenu incorrect).
out=$(as_authenticated "$OPERATOR" "select result from public.reset_merchant_catalogue('$RESTA', 'RESET Un Autre Nom');")
assert_eq "[v1.1-A] phrase erronée -- rejetée, result = rejected_confirmation" "rejected_confirmation" "$out"

# [B] Phrase vide (chaîne vide) et phrase NULL (paramètre explicitement absent).
out=$(as_authenticated "$OPERATOR" "select result from public.reset_merchant_catalogue('$RESTA', '');")
assert_eq "[v1.1-B] phrase vide (chaîne vide) -- rejetée, result = rejected_confirmation" "rejected_confirmation" "$out"
out=$(as_authenticated "$OPERATOR" "select result from public.reset_merchant_catalogue('$RESTA', null);")
assert_eq "[v1.1-B] phrase NULL -- rejetée, result = rejected_confirmation" "rejected_confirmation" "$out"

# [C] Phrase EXACTE mais pour un AUTRE marchand (Hotel Royal, tenant
# B) transmise pour un commit ciblant le tenant A -- doit échouer, le
# serveur compare contre le nom du restaurant CIBLÉ (p_restaurant_id),
# jamais contre un nom "plausible" quelconque.
out=$(as_authenticated "$OPERATOR" "select result from public.reset_merchant_catalogue('$RESTA', '$PHRASE_B');")
assert_eq "[v1.1-C] phrase exacte d'un AUTRE marchand -- rejetée, result = rejected_confirmation" "rejected_confirmation" "$out"

# [D] Casse/espacement différents -- comparaison EXACTE et littérale
# (mandat v1.1 "Prefer exact literal confirmation"), AUCUNE
# normalisation hors des espaces de BORDURE de la saisie. La phrase
# TOUT-MAJUSCULES de l'ancien v1 ("RESET AU LAIT CRU") est désormais,
# elle aussi, un cas de rejet -- preuve directe que la dérivation
# côté serveur a bien changé.
out=$(as_authenticated "$OPERATOR" "select result from public.reset_merchant_catalogue('$RESTA', 'reset Au Lait Cru');")
assert_eq "[v1.1-D] casse différente (\"reset\" minuscule) -- rejetée" "rejected_confirmation" "$out"
out=$(as_authenticated "$OPERATOR" "select result from public.reset_merchant_catalogue('$RESTA', 'RESET AU LAIT CRU');")
assert_eq "[v1.1-D] phrase TOUT-MAJUSCULES (ancien format v1) -- rejetée, la dérivation serveur a changé" "rejected_confirmation" "$out"
out=$(as_authenticated "$OPERATOR" "select result from public.reset_merchant_catalogue('$RESTA', 'RESET  Au Lait Cru');")
assert_eq "[v1.1-D] espace interne double -- rejetée (seuls les espaces de BORDURE sont ignorés)" "rejected_confirmation" "$out"

# La tolérance aux espaces de BORDURE de la saisie (seule
# normalisation documentée/autorisée, mandat v1.1 §1) est prouvée
# fonctionnellement plus bas : le COMMIT réel ci-dessous transmet
# volontairement "  $PHRASE_A  " (espaces de bordure) et DOIT produire
# result = 'completed', pas un rejet -- inutile de "consommer" un
# second scénario ici.

products_after_confirm_tests=$(sql "select count(*) from public.menu_items mi join public.menu_categories mc on mc.id = mi.category_id where mc.restaurant_id = '$RESTA' and mi.archived_at is null;")
assert_eq "[v1.1-A/B/C/D] zéro mutation après 7 tentatives refusées (produits actifs inchangés)" "$products_before_confirm_tests" "$products_after_confirm_tests"

rejected_audit_count=$(sql "select count(*) from public.catalogue_reset_audit_log where restaurant_id = '$RESTA' and result = 'rejected_confirmation';")
assert_eq "[v1.1-F] 7 événements d'audit 'rejected_confirmation' écrits (traçabilité complète d'un bypass UI direct par RPC)" "7" "$rejected_audit_count"

completed_audit_count_before_real_commit=$(sql "select count(*) from public.catalogue_reset_audit_log where restaurant_id = '$RESTA' and result in ('completed', 'no_op');")
assert_eq "[v1.1-F] AUCUN événement d'audit 'completed'/'no_op' avant le premier commit réel (bypass UI direct par RPC : IMPOSSIBLE de muter sans la phrase exacte)" "0" "$completed_audit_count_before_real_commit"

# [G] Tenant B strictement intact après ces 7 tentatives refusées
# ciblant A (aucune fuite croisée, même avec la phrase EXACTE de B
# transmise dans [C] ci-dessus -- elle ciblait p_restaurant_id = A,
# jamais B).
b_active_after_confirm_tests=$(sql "select count(*) from public.menu_items mi join public.menu_categories mc on mc.id = mi.category_id where mc.restaurant_id = '$RESTB' and mi.archived_at is null;")
assert_eq "[v1.1-G] tenant B intact après les tentatives de confirmation refusées ciblant A" "1" "$b_active_after_confirm_tests"
audit_count_b_after_confirm_tests=$(sql "select count(*) from public.catalogue_reset_audit_log where restaurant_id = '$RESTB';")
assert_eq "[v1.1-G] aucune ligne d'audit pour le tenant B (jamais ciblé, même par la phrase [C])" "0" "$audit_count_b_after_confirm_tests"

# ==================================================================
# [E/G/H/I/K/L] COMMIT — archivage produits A, suppression
# sous-catégorie/catégorie vides A, RÉTENTION+DÉSACTIVATION des
# peuplées, tenant B STRICTEMENT intact. Phrase EXACTE volontairement
# entourée d'espaces de bordure ("  RESET Au Lait Cru  ") -- preuve
# fonctionnelle que btrim() les ignore bien côté serveur (mandat v1.1
# §1, seule normalisation documentée/autorisée).
# ==================================================================
log "=== [E/G/H/I/K/L] COMMIT — reset réel du tenant A ==="
out=$(as_authenticated "$OPERATOR" "select products_archived, subcategories_removed, subcategories_retained, categories_removed, categories_retained, categories_active_after_reset, subcategories_active_after_reset, historical_orders_preserved, result from public.reset_merchant_catalogue('$RESTA', '  $PHRASE_A  ');")
IFS='|' read -r c_prod c_sub_rm c_sub_ret c_cat_rm c_cat_ret c_cat_active_after c_sub_active_after c_hist c_result <<< "$out"
assert_eq "[G] products_archived = 2 (Charolais + Raclette, tous deux actifs avant commit)" "2" "$c_prod"
assert_eq "[I] subcategories_removed = 1 (Sous-cat Vide A, jamais peuplée)" "1" "$c_sub_rm"
assert_eq "[J] subcategories_retained = 1 (Chevres, porte un produit même archivé)" "1" "$c_sub_ret"
assert_eq "[K] categories_removed = 1 (Categorie Vide A, jamais peuplée)" "1" "$c_cat_rm"
assert_eq "[L] categories_retained = 2 (Fromages, Boissons -- jamais supprimées physiquement, produits archivés dedans)" "2" "$c_cat_ret"
assert_eq "[v1.1] categories_active_after_reset = 0 (Fromages/Boissons désactivées, jamais supprimées)" "0" "$c_cat_active_after"
assert_eq "[v1.1] subcategories_active_after_reset = 0 (Chevres désactivée, jamais supprimée)" "0" "$c_sub_active_after"
assert_eq "[H] historical_orders_preserved = true" "t" "$c_hist"
assert_eq "[E] result = completed (première exécution, du travail réel a eu lieu)" "completed" "$c_result"
assert_eq "[v1.1] la phrase EXACTE entourée d'espaces de bordure (\"  $PHRASE_A  \") est ACCEPTÉE -- btrim() ignore bien les espaces de bordure de la SAISIE" "completed" "$c_result"

# [E] Effet réel sur les produits -- H : le produit référencé par
# commande historique est ARCHIVÉ (pas supprimé), son ID survit
# intact, la ligne order_items pointe toujours vers lui.
row=$(sql "select archived_at is not null, is_available, exists(select 1 from public.order_items where menu_item_id = '00000000-0000-0000-0000-00000000e001') from public.menu_items where id = '00000000-0000-0000-0000-00000000e001';")
assert_eq "[H] Charolais (référencé par commande historique) : archivé, is_available=false, ID intact, order_items toujours résolu" "t|f|t" "$row"

row=$(sql "select archived_at is not null from public.menu_items where id = '00000000-0000-0000-0000-00000000e002';")
assert_eq "[G] Raclette (jamais commandée) archivée elle aussi -- règle absolue, pas de branchement sur l'historique" "t" "$row"

# order_items snapshot jamais réinterprété/altéré par le reset.
row=$(sql "select item_name, unit_price, line_total from public.order_items where order_id = '00000000-0000-0000-0000-00000000f001';")
assert_eq "[H] snapshot order_items (item_name/unit_price/line_total) STRICTEMENT inchangé" "Charolais|4.50|4.50" "$row"

# [I/J] structures.
exists_subcat_vide=$(sql "select exists(select 1 from public.menu_subcategories where id = '00000000-0000-0000-0000-00000000d002');")
assert_eq "[I] Sous-cat Vide A physiquement supprimée" "f" "$exists_subcat_vide"
exists_subcat_peuplee=$(sql "select exists(select 1 from public.menu_subcategories where id = '00000000-0000-0000-0000-00000000d001');")
assert_eq "[J] Chevres (peuplée) retenue, jamais supprimée" "t" "$exists_subcat_peuplee"

# [K/L] structures catégories.
exists_cat_vide=$(sql "select exists(select 1 from public.menu_categories where id = '00000000-0000-0000-0000-00000000c003');")
assert_eq "[K] Categorie Vide A physiquement supprimée" "f" "$exists_cat_vide"
exists_cat_fromages=$(sql "select exists(select 1 from public.menu_categories where id = '00000000-0000-0000-0000-00000000c001');")
assert_eq "[L] Fromages (peuplée) retenue, jamais supprimée" "t" "$exists_cat_fromages"
exists_cat_boissons=$(sql "select exists(select 1 from public.menu_categories where id = '00000000-0000-0000-0000-00000000c002');")
assert_eq "[L] Boissons (peuplée) retenue, jamais supprimée" "t" "$exists_cat_boissons"

# [v1.1] Catégories/sous-catégorie RETENUES : DÉSACTIVÉES (is_active =
# false), jamais supprimées -- mandat v1.1 §2 "clean import must not
# accidentally reuse unwanted legacy structure".
fromages_active=$(sql "select is_active from public.menu_categories where id = '00000000-0000-0000-0000-00000000c001';")
assert_eq "[v1.1] Fromages (retenue) désactivée (is_active = false)" "f" "$fromages_active"
boissons_active=$(sql "select is_active from public.menu_categories where id = '00000000-0000-0000-0000-00000000c002';")
assert_eq "[v1.1] Boissons (retenue) désactivée (is_active = false)" "f" "$boissons_active"
chevres_active=$(sql "select is_active from public.menu_subcategories where id = '00000000-0000-0000-0000-00000000d001';")
assert_eq "[v1.1] Chevres (retenue) désactivée (is_active = false)" "f" "$chevres_active"

# [v1.1] get_merchant_catalogue expose bien category_is_active/
# subcategory_is_active à false pour ces mêmes lignes retenues
# (l'owner du restaurant A, membre de restaurant_users, reste
# autorisé à lire son propre catalogue après le reset).
gmc_fromages_active=$(as_authenticated "$OWNER_A" "select distinct category_is_active from public.get_merchant_catalogue('$RESTA', false) where category_id = '00000000-0000-0000-0000-00000000c001';")
assert_eq "[v1.1] get_merchant_catalogue.category_is_active = false pour Fromages après reset" "f" "$gmc_fromages_active"
gmc_chevres_active=$(as_authenticated "$OWNER_A" "select distinct subcategory_is_active from public.get_merchant_catalogue('$RESTA', false) where subcategory_id = '00000000-0000-0000-0000-00000000d001';")
assert_eq "[v1.1] get_merchant_catalogue.subcategory_is_active = false pour Chevres après reset" "f" "$gmc_chevres_active"

# Le produit Charolais garde bien sa catégorie/sous-catégorie
# d'origine (aucune mutation structurelle collatérale sur les lignes
# retenues).
row=$(sql "select category_id, subcategory_id from public.menu_items where id = '00000000-0000-0000-0000-00000000e001';")
assert_eq "[L] Charolais conserve exactement sa catégorie/sous-catégorie d'origine" "00000000-0000-0000-0000-00000000c001|00000000-0000-0000-0000-00000000d001" "$row"

# [F] Tenant B STRICTEMENT intact après le commit de A (mêmes noms de
# catégorie/produit, jamais confondus).
b_active_after=$(sql "select count(*) from public.menu_items mi join public.menu_categories mc on mc.id = mi.category_id where mc.restaurant_id = '$RESTB' and mi.archived_at is null;")
assert_eq "[F] tenant B : toujours 1 produit actif (jamais archivé par le reset de A)" "1" "$b_active_after"
b_cats=$(sql "select count(*) from public.menu_categories where restaurant_id = '$RESTB';")
assert_eq "[F] tenant B : toujours 2 catégories (jamais supprimées par le reset de A)" "2" "$b_cats"
b_subcats=$(sql "select count(*) from public.menu_subcategories ms join public.menu_categories mc on mc.id = ms.category_id where mc.restaurant_id = '$RESTB';")
assert_eq "[F] tenant B : toujours 1 sous-catégorie (jamais supprimée par le reset de A)" "1" "$b_subcats"
b_raclette=$(sql "select archived_at is null from public.menu_items where id = '00000000-0000-0000-0000-00000000e101';")
assert_eq "[F] tenant B : Raclette (même nom que rien côté A) reste ACTIVE, jamais archivée" "t" "$b_raclette"

# [v1.1/F] Tenant B : catégories/sous-catégorie restent ACTIVES
# (is_active = true, JAMAIS désactivées par le reset de A, malgré les
# noms identiques "Fromages"/"Chevres").
b_fromages_active=$(sql "select is_active from public.menu_categories where id = '00000000-0000-0000-0000-00000000c101';")
assert_eq "[v1.1/F] tenant B : Fromages reste ACTIVE (is_active = true), jamais désactivée par le reset de A" "t" "$b_fromages_active"
b_chevres_active=$(sql "select is_active from public.menu_subcategories where id = '00000000-0000-0000-0000-00000000d101';")
assert_eq "[v1.1/F] tenant B : Chevres reste ACTIVE (is_active = true), jamais désactivée par le reset de A" "t" "$b_chevres_active"

# [O] Audit -- une ligne 'completed' exacte écrite par le commit
# ci-dessus (filtrée par result : les 7 tentatives refusées
# [v1.1-A/B/C/D] ont déjà écrit leurs propres lignes 'rejected_
# confirmation' plus haut, sur ce même restaurant_id).
audit_row=$(sql "select restaurant_id, operator_user_id, products_archived, subcategories_removed, subcategories_retained, categories_removed, categories_retained, result from public.catalogue_reset_audit_log where restaurant_id = '$RESTA' and result = 'completed' order by created_at desc limit 1;")
assert_eq "[O] ligne d'audit 'completed' exacte écrite pour le commit du tenant A" "$RESTA|$OPERATOR|2|1|1|1|2|completed" "$audit_row"
audit_count_b=$(sql "select count(*) from public.catalogue_reset_audit_log where restaurant_id = '$RESTB';")
assert_eq "[O/F] aucune ligne d'audit pour le tenant B (jamais reseté)" "0" "$audit_count_b"

# ==================================================================
# [M] IDEMPOTENCY — second appel = zéro mutation, zéro échec.
# ==================================================================
log "=== [M] IDEMPOTENCY — second reset du tenant A ==="
out=$(as_authenticated "$OPERATOR" "select products_archived, subcategories_removed, subcategories_retained, categories_removed, categories_retained, categories_active_after_reset, subcategories_active_after_reset, result from public.reset_merchant_catalogue('$RESTA', '$PHRASE_A');")
IFS='|' read -r m_prod m_sub_rm m_sub_ret m_cat_rm m_cat_ret m_cat_active_after m_sub_active_after m_result <<< "$out"
assert_eq "[M] second reset : products_archived = 0" "0" "$m_prod"
assert_eq "[M] second reset : subcategories_removed = 0" "0" "$m_sub_rm"
assert_eq "[M] second reset : subcategories_retained inchangé = 1" "1" "$m_sub_ret"
assert_eq "[M] second reset : categories_removed = 0" "0" "$m_cat_rm"
assert_eq "[M] second reset : categories_retained inchangé = 2" "2" "$m_cat_ret"
assert_eq "[M] second reset : categories_active_after_reset = 0 (déjà désactivées par le premier reset -- rien à redésactiver)" "0" "$m_cat_active_after"
assert_eq "[M] second reset : subcategories_active_after_reset = 0" "0" "$m_sub_active_after"
assert_eq "[M] second reset : result = no_op (v1.1 : products_archived/*_removed ET *_deactivated tous à zéro)" "no_op" "$m_result"
audit_count_a_completed_or_noop_after_second=$(sql "select count(*) from public.catalogue_reset_audit_log where restaurant_id = '$RESTA' and result in ('completed', 'no_op');")
assert_eq "[M] second reset : 2 lignes d'audit 'completed'/'no_op' au total (1 commit réel + 1 no_op, traçabilité complète -- distinct des 7 lignes 'rejected_confirmation' antérieures)" "2" "$audit_count_a_completed_or_noop_after_second"

# ==================================================================
# [P] CONCURRENCY / STALE PREVIEW — un preview affiché avant un
# changement de catalogue ne peut jamais produire un commit basé sur
# des compteurs obsolètes : le commit recalcule tout depuis zéro.
# ==================================================================
log "=== [P] CONCURRENCY — nouveau produit actif ajouté APRÈS le premier reset, AVANT un second commit ==="
sql "insert into public.menu_items (id, category_id, name, price, display_order, is_available, tax_rate) values ('00000000-0000-0000-0000-00000000e004', '00000000-0000-0000-0000-00000000c001', 'Nouveau produit post-reset', 3.00, 5, true, 5.5);" >/dev/null
out=$(as_authenticated "$OPERATOR" "select products_archived, result from public.reset_merchant_catalogue('$RESTA', '$PHRASE_A');")
IFS='|' read -r p_prod p_result <<< "$out"
assert_eq "[P] un produit ajouté après le 1er reset est bien détecté et archivé au commit suivant (jamais de compteur figé)" "1" "$p_prod"
assert_eq "[P] result redevient completed (du nouveau travail réel, pas un faux no_op)" "completed" "$p_result"
new_prod_archived=$(sql "select archived_at is not null from public.menu_items where id = '00000000-0000-0000-0000-00000000e004';")
assert_eq "[P] le nouveau produit est bien archivé, pas laissé actif par erreur" "t" "$new_prod_archived"

# ==================================================================
# [N] IMPORT COMPATIBILITY — après reset, create_category/
# create_subcategory/create_product (couche déjà auditée OB-2/OB-4,
# jamais modifiée par ce lot) fonctionnent normalement sur un
# restaurant tout juste réinitialisé.
# ==================================================================
log "=== [N] IMPORT COMPATIBILITY — create_category/create_subcategory/create_product après reset ==="
out=$(as_authenticated "$OPERATOR" "select public.create_category('$RESTA', 'Nouvelle categorie post-reset', null);")
new_cat_id=$(printf '%s' "$out" | tr -d '\n')
if [ -n "$new_cat_id" ] && [ "$new_cat_id" != "" ]; then
  pass "[N] create_category fonctionne normalement après reset (nouvelle catégorie créée)"
else
  fail "[N] create_category a échoué après reset : $(sql_err)"
fi
out=$(as_authenticated "$OPERATOR" "select public.create_subcategory('$new_cat_id', 'Nouvelle sous-categorie post-reset', null);")
new_subcat_id=$(printf '%s' "$out" | tr -d '\n')
if [ -n "$new_subcat_id" ] && [ "$new_subcat_id" != "" ]; then
  pass "[N] create_subcategory fonctionne normalement après reset"
else
  fail "[N] create_subcategory a échoué après reset : $(sql_err)"
fi
out=$(as_authenticated "$OPERATOR" "select public.create_product('$new_cat_id', 'Produit post-reset', null, 2.50);")
new_prod_id=$(printf '%s' "$out" | tr -d '\n')
if [ -n "$new_prod_id" ] && [ "$new_prod_id" != "" ]; then
  pass "[N] create_product fonctionne normalement après reset (importer compatible)"
else
  fail "[N] create_product a échoué après reset : $(sql_err)"
fi
# get_merchant_catalogue reste lisible et cohérent après reset.
rc=$(as_authenticated_rc "$OPERATOR" "select count(*) from public.get_merchant_catalogue('$RESTA', false);")
assert_ok "[N] get_merchant_catalogue reste utilisable après reset" "$rc"

# ==================================================================
# [v1.1 Q/R] CLEAN REIMPORT — PREUVE FONCTIONNELLE (pas seulement le
# drapeau is_active) que la structure retenue-désactivée n'est JAMAIS
# une contrainte pour un réimport propre : create_category/
# create_subcategory acceptent un nom IDENTIQUE à celui d'une
# catégorie/sous-catégorie retenue-désactivée par le reset, sans la
# moindre violation d'unicité -- exactement le comportement que
# idx_menu_categories_unique_active_name (préexistant, migration-v66)
# et idx_menu_subcategories_unique_name (converti en index partiel par
# CE lot) sont conçus pour garantir (mandat v1.1 §3/§4, "clean import
# must not accidentally reuse unwanted legacy structure").
# ==================================================================
log "=== [v1.1 Q/R] CLEAN REIMPORT — collision de nom avec une structure retenue-désactivée acceptée sans erreur ==="
out=$(as_authenticated "$OPERATOR" "select public.create_category('$RESTA', 'Fromages', null);")
new_fromages_id=$(printf '%s' "$out" | tr -d '\n')
if [ -n "$new_fromages_id" ] && [ "$new_fromages_id" != "" ]; then
  pass "[v1.1-Q] create_category('Fromages') réussit après reset malgré la catégorie 'Fromages' retenue-désactivée (aucune violation d'unicité -- idx_menu_categories_unique_active_name, WHERE is_active = true)"
else
  fail "[v1.1-Q] create_category('Fromages') a échoué après reset : $(sql_err)"
fi
new_fromages_active=$(sql "select is_active from public.menu_categories where id = '$new_fromages_id';")
assert_eq "[v1.1-Q] la NOUVELLE catégorie 'Fromages' est ACTIVE par défaut (distincte de l'ancienne, désactivée)" "t" "$new_fromages_active"

out=$(as_authenticated "$OPERATOR" "select public.create_subcategory('$new_fromages_id', 'Chevres', null);")
new_chevres_id=$(printf '%s' "$out" | tr -d '\n')
if [ -n "$new_chevres_id" ] && [ "$new_chevres_id" != "" ]; then
  pass "[v1.1-R] create_subcategory('Chevres') réussit après reset malgré la sous-catégorie 'Chevres' retenue-désactivée (aucune violation d'unicité -- idx_menu_subcategories_unique_name reconstruit en index partiel par ce lot, WHERE is_active = true)"
else
  fail "[v1.1-R] create_subcategory('Chevres') a échoué après reset : $(sql_err)"
fi
new_chevres_active=$(sql "select is_active from public.menu_subcategories where id = '$new_chevres_id';")
assert_eq "[v1.1-R] la NOUVELLE sous-catégorie 'Chevres' est ACTIVE par défaut (distincte de l'ancienne, désactivée)" "t" "$new_chevres_active"

# La résolution d'import elle-même (lib/catalogue-import/resolution.ts,
# module TS pur) est prouvée séparément par
# tests/catalogue-reset-import-resolution.test.ts -- ce harnais prouve
# uniquement que le SCHÉMA/get_merchant_catalogue le permettent
# réellement en base, jamais simulé.

# ==================================================================
# [SAFETY] Aucune suppression physique de menu_items n'a JAMAIS été
# exécutée par ce harnais -- preuve directe (comptage brut des lignes
# menu_items jamais décru en dehors de ce que ce harnais lui-même a
# inséré/compté explicitement ci-dessus).
# ==================================================================
log "=== [SAFETY] aucune ligne menu_items physiquement perdue pour le tenant A (hors ce que ce harnais a lui-même créé) ==="
total_menu_items_a=$(sql "select count(*) from public.menu_items mi join public.menu_categories mc on mc.id = mi.category_id where mc.restaurant_id = '$RESTA';")
# 3 produits fixture + 1 [P] + 3 [N] = 7, AUCUN jamais supprimé.
assert_eq "[SAFETY] 5 lignes menu_items existent toujours pour le tenant A (3 fixture + 1 concurrency [P] + 1 import post-reset [N], ZÉRO perte)" "5" "$total_menu_items_a"

# ==================================================================
# [v1.2 RB] ROLLBACK SAFETY — mandat v1.2 §4.
#
# Scénario exact demandé, sur une base DÉDIÉE (un rollback détruit le
# lot) :
#   1. installer le candidat ;
#   2. créer catégorie / sous-catégorie / produit ;
#   3. exécuter le reset ;
#   4. vérifier la sous-catégorie retenue avec is_active = false ;
#   5. créer une NOUVELLE sous-catégorie ACTIVE de MÊME nom normalisé
#      sous la MÊME catégorie (réimport propre) ;
#   6. exécuter le rollback.
#
# Preuve attendue (Outcome B) : le rollback REFUSE avec
# SCANYM_ROLLBACK_BLOCKED AVANT toute mutation, et ZÉRO rollback
# partiel n'a eu lieu. Puis, en appliquant le recours documenté
# (renommage manuel de la ligne INACTIVE retenue), le même rollback
# s'exécute INTÉGRALEMENT et l'historique reste intact.
#
# Le rollback bloqué est exécuté DÉLIBÉRÉMENT SANS -v ON_ERROR_STOP=1
# (cas hostile) : c'est la configuration dans laquelle un contrôle
# placé avant `begin;` n'aurait PAS protégé la base, psql poursuivant
# le fichier après l'échec du contrôle. Prouver zéro mutation dans ce
# cas prouve l'atomicité indépendamment de tout drapeau client.
# ==================================================================
log "=== [v1.2 RB] ROLLBACK SAFETY — base dédiée $DB_ROLLBACK ==="

DB_MAIN="$DB"
DB="$DB_ROLLBACK"
psql -c "create database \"$DB\";" >/dev/null 2>&1
build_common_bootstrap
if ! build_chain; then
  fail "[v1.2 RB] chaîne de migrations a échoué sur la base de rollback"
  DB="$DB_MAIN"
else
  psql -d "$DB" -v ON_ERROR_STOP=1 >/tmp/scanym-catreset-fixture-$$.txt 2>&1 <<'SQL'
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000b1', 'rb-operator@scanym.test');
insert into public.scanym_operators (user_id) values ('00000000-0000-0000-0000-0000000000b1');
insert into public.restaurants (id, name, slug, is_active) values
  ('00000000-0000-0000-0000-00000000bb01', 'Rollback Test', 'rollback-test', true);
insert into public.menu_categories (id, restaurant_id, name, display_order) values
  ('00000000-0000-0000-0000-00000000cc01', '00000000-0000-0000-0000-00000000bb01', 'Fromages', 1);
insert into public.menu_subcategories (id, category_id, name, display_order) values
  ('00000000-0000-0000-0000-00000000dd01', '00000000-0000-0000-0000-00000000cc01', 'Chevres', 1);
insert into public.menu_items (id, category_id, subcategory_id, name, price, display_order, is_available, tax_rate) values
  ('00000000-0000-0000-0000-00000000ee01', '00000000-0000-0000-0000-00000000cc01', '00000000-0000-0000-0000-00000000dd01', 'Charolais', 4.50, 1, true, 5.5);
SQL
  rb_fixture_rc=$?
  assert_eq "[v1.2 RB-1/2] base dédiée installée : catégorie + sous-catégorie + produit (candidat appliqué)" "0" "$rb_fixture_rc"

  RB_OPERATOR="00000000-0000-0000-0000-0000000000b1"
  RB_REST="00000000-0000-0000-0000-00000000bb01"
  RB_CAT="00000000-0000-0000-0000-00000000cc01"
  RB_OLD_SUB="00000000-0000-0000-0000-00000000dd01"

  # ---- 3. reset réel (phrase serveur exacte) ----
  rb_reset=$(as_authenticated "$RB_OPERATOR" \
    "select result from public.reset_merchant_catalogue('$RB_REST', 'RESET Rollback Test');" | tr -d '\n')
  assert_eq "[v1.2 RB-3] reset exécuté sur la base dédiée (result = completed)" "completed" "$rb_reset"

  # ---- 4. la sous-catégorie peuplée est RETENUE et DÉSACTIVÉE ----
  rb_old_active=$(sql "select is_active from public.menu_subcategories where id = '$RB_OLD_SUB';" | tr -d '\n')
  assert_eq "[v1.2 RB-4] la sous-catégorie 'Chevres' d'origine est RETENUE (jamais supprimée) et désactivée (is_active = false)" "f" "$rb_old_active"

  # ---- 5. réimport propre : MÊME nom normalisé, MÊME catégorie ----
  out=$(as_authenticated "$RB_OPERATOR" "select public.create_subcategory('$RB_CAT', 'Chevres', null);")
  rb_new_sub=$(printf '%s' "$out" | tr -d '\n')
  if [ -n "$rb_new_sub" ]; then
    pass "[v1.2 RB-5] réimport propre : une NOUVELLE sous-catégorie 'Chevres' ACTIVE est créée sous la MÊME catégorie que la retenue-désactivée (état délibérément autorisé par l'index partiel v1.1)"
  else
    fail "[v1.2 RB-5] création de la sous-catégorie de même nom a échoué : $(sql_err)"
  fi
  rb_dupes=$(sql "select count(*) from public.menu_subcategories where category_id = '$RB_CAT' and lower(btrim(name, E' \t\n\r\f' || chr(11))) = 'chevres';" | tr -d '\n')
  assert_eq "[v1.2 RB-5] 2 lignes de MÊME nom normalisé coexistent désormais sous la même catégorie (1 active + 1 inactive) — état que l'index INCONDITIONNEL du rollback ne peut PAS représenter" "2" "$rb_dupes"

  # ---- état AVANT rollback : 5 marqueurs de schéma du lot ----
  rb_before_fn=$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname in ('reset_merchant_catalogue','preview_catalogue_reset');" | tr -d '\n')
  rb_before_audit=$(sql "select (to_regclass('public.catalogue_reset_audit_log') is not null);" | tr -d '\n')
  rb_before_col=$(sql "select count(*) from information_schema.columns where table_schema='public' and table_name='menu_subcategories' and column_name='is_active';" | tr -d '\n')
  rb_before_partial=$(sql "select (indexdef ilike '%where%') from pg_indexes where schemaname='public' and indexname='idx_menu_subcategories_unique_name';" | tr -d '\n')
  rb_before_gmc=$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_merchant_catalogue' and pg_get_function_result(p.oid) ilike '%category_is_active%';" | tr -d '\n')

  # ---- 6a. ROLLBACK, invocation DOCUMENTÉE (-v ON_ERROR_STOP=1,
  #          convention de tous les harnais de ce dépôt) ----
  psql -d "$DB" -v ON_ERROR_STOP=1 -f "$ROLLBACK_SQL" >/tmp/scanym-catreset-rbout-$$.txt 2>/tmp/scanym-catreset-rberr-$$.txt
  rb_rc=$?
  rb_err=$(cat /tmp/scanym-catreset-rberr-$$.txt 2>/dev/null)

  assert_denied "[v1.2 RB-6/B] le rollback REFUSE de s'exécuter sur cet état (sortie non nulle, invocation documentée ON_ERROR_STOP=1)" "$rb_rc"
  assert_contains "[v1.2 RB-6/B] le refus porte le sentinelle documentée SCANYM_ROLLBACK_BLOCKED" "SCANYM_ROLLBACK_BLOCKED" "$rb_err"
  assert_contains "[v1.2 RB-6/B] le message nomme explicitement la réconciliation manuelle requise" "manual reconciliation" "$rb_err"
  assert_contains "[v1.2 RB-6/B] le DETAIL liste le groupe fautif (catégorie + nom normalisé)" "chevres" "$rb_err"
  assert_contains "[v1.2 RB-6/B] le HINT documente qu'AUCUNE mutation n'a été appliquée" "AUCUNE mutation" "$rb_err"

  # ---- 6b. ROLLBACK, CAS HOSTILE : SANS ON_ERROR_STOP.
  #      Sans ce drapeau, psql N'INTERROMPT PAS le fichier après une
  #      erreur et sort même avec rc=0 : c'est précisément la
  #      configuration dans laquelle un contrôle placé AVANT `begin;`
  #      (convention migration-v66-rollback.sql) laisserait le reste
  #      du rollback s'appliquer. Ici les contrôles sont DANS la
  #      transaction : elle est avortée, toutes les instructions
  #      suivantes sont refusées, et le `commit;` final agit comme un
  #      ROLLBACK. La preuve d'atomicité qui suit est faite APRÈS
  #      cette exécution hostile -- donc dans le pire cas possible.
  psql -d "$DB" -f "$ROLLBACK_SQL" >/tmp/scanym-catreset-rbout2-$$.txt 2>/tmp/scanym-catreset-rberr2-$$.txt
  rb_err_hostile=$(cat /tmp/scanym-catreset-rberr2-$$.txt 2>/dev/null)
  assert_contains "[v1.2 RB-6/B/HOSTILE] même SANS ON_ERROR_STOP, le refus SCANYM_ROLLBACK_BLOCKED est bien émis" "SCANYM_ROLLBACK_BLOCKED" "$rb_err_hostile"
  assert_contains "[v1.2 RB-6/B/HOSTILE] la transaction est avortée : les instructions suivantes sont TOUTES refusées par PostgreSQL, jamais appliquées" "current transaction is aborted" "$rb_err_hostile"

  # ---- PREUVE D'ATOMICITÉ : zéro rollback partiel ----
  log "=== [v1.2 RB] preuve : ZÉRO rollback partiel après le refus ==="
  rb_after_fn=$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname in ('reset_merchant_catalogue','preview_catalogue_reset');" | tr -d '\n')
  rb_after_audit=$(sql "select (to_regclass('public.catalogue_reset_audit_log') is not null);" | tr -d '\n')
  rb_after_col=$(sql "select count(*) from information_schema.columns where table_schema='public' and table_name='menu_subcategories' and column_name='is_active';" | tr -d '\n')
  rb_after_partial=$(sql "select (indexdef ilike '%where%') from pg_indexes where schemaname='public' and indexname='idx_menu_subcategories_unique_name';" | tr -d '\n')
  rb_after_gmc=$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_merchant_catalogue' and pg_get_function_result(p.oid) ilike '%category_is_active%';" | tr -d '\n')

  assert_eq "[v1.2 RB/ATOMIC] les 2 RPC du lot sont TOUJOURS présentes (aucun DROP FUNCTION exécuté)" "$rb_before_fn" "$rb_after_fn"
  assert_eq "[v1.2 RB/ATOMIC] la table d'audit est TOUJOURS présente (aucun DROP TABLE exécuté)" "$rb_before_audit" "$rb_after_audit"
  assert_eq "[v1.2 RB/ATOMIC] menu_subcategories.is_active est TOUJOURS présente (aucun DROP COLUMN exécuté)" "$rb_before_col" "$rb_after_col"
  assert_eq "[v1.2 RB/ATOMIC] idx_menu_subcategories_unique_name est TOUJOURS l'index PARTIEL du lot (ni drop, ni reconstruction)" "$rb_before_partial" "$rb_after_partial"
  assert_eq "[v1.2 RB/ATOMIC] get_merchant_catalogue expose TOUJOURS category_is_active (aucune redéfinition exécutée)" "$rb_before_gmc" "$rb_after_gmc"
  assert_eq "[v1.2 RB/ATOMIC] les 2 sous-catégories homonymes sont TOUJOURS là (aucune suppression, aucune fusion, aucun renommage silencieux)" "2" "$(sql "select count(*) from public.menu_subcategories where category_id = '$RB_CAT' and lower(btrim(name, E' \t\n\r\f' || chr(11))) = 'chevres';" | tr -d '\n')"
  assert_eq "[v1.2 RB/ATOMIC] le produit archivé n'a pas bougé (toujours rattaché à sa sous-catégorie d'origine)" "$RB_OLD_SUB" "$(sql "select subcategory_id from public.menu_items where id = '00000000-0000-0000-0000-00000000ee01';" | tr -d '\n')"

  # ---- RECOURS DOCUMENTÉ (2) : renommage manuel de la ligne INACTIVE ----
  log "=== [v1.2 RB] recours documenté : renommage manuel de la sous-catégorie INACTIVE retenue, puis re-rollback ==="
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "update public.menu_subcategories set name = 'Chevres (archive 2026-09)' where id = '$RB_OLD_SUB';" >/dev/null 2>&1
  rb_recovery_rc=$?
  assert_eq "[v1.2 RB/RECOVERY] le recours documenté (renommage manuel de la ligne INACTIVE, jamais par ce script) s'applique sans erreur" "0" "$rb_recovery_rc"

  psql -d "$DB" -v ON_ERROR_STOP=1 -f "$ROLLBACK_SQL" >/tmp/scanym-catreset-rbout3-$$.txt 2>/tmp/scanym-catreset-rberr3-$$.txt
  rb_rc2=$?
  if [ "$rb_rc2" -eq 0 ]; then
    pass "[v1.2 RB/A] après réconciliation, le MÊME rollback s'exécute INTÉGRALEMENT (rc=0)"
  else
    fail "[v1.2 RB/A] après réconciliation le rollback a échoué (rc=$rb_rc2) : $(cat /tmp/scanym-catreset-rberr3-$$.txt 2>/dev/null)"
  fi

  rb2_fn=$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname in ('reset_merchant_catalogue','preview_catalogue_reset');" | tr -d '\n')
  rb2_audit=$(sql "select (to_regclass('public.catalogue_reset_audit_log') is not null);" | tr -d '\n')
  rb2_col=$(sql "select count(*) from information_schema.columns where table_schema='public' and table_name='menu_subcategories' and column_name='is_active';" | tr -d '\n')
  rb2_partial=$(sql "select (indexdef ilike '%where%') from pg_indexes where schemaname='public' and indexname='idx_menu_subcategories_unique_name';" | tr -d '\n')
  rb2_gmc_cols=$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_merchant_catalogue' and pg_get_function_result(p.oid) ilike '%category_is_active%';" | tr -d '\n')
  rb2_gmc_bypass=$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_merchant_catalogue' and pg_get_functiondef(p.oid) ilike '%is_scanym_operator%';" | tr -d '\n')

  assert_eq "[v1.2 RB/A] les 2 RPC du lot sont supprimées" "0" "$rb2_fn"
  assert_eq "[v1.2 RB/A] la table d'audit est supprimée" "f" "$rb2_audit"
  assert_eq "[v1.2 RB/A] menu_subcategories.is_active est supprimée" "0" "$rb2_col"
  assert_eq "[v1.2 RB/A] idx_menu_subcategories_unique_name est redevenu INCONDITIONNEL (plus aucun WHERE)" "f" "$rb2_partial"
  assert_eq "[v1.2 RB/A] get_merchant_catalogue n'expose plus category_is_active/subcategory_is_active" "0" "$rb2_gmc_cols"
  assert_eq "[v1.2 RB/A] get_merchant_catalogue a CONSERVÉ le bypass is_scanym_operator() d'OB-2 v1.1 (jamais restaurée à une définition antérieure)" "1" "$rb2_gmc_bypass"

  # ---- l'historique survit au rollback réussi ----
  assert_eq "[v1.2 RB/A] les 2 sous-catégories existent toujours après rollback réussi (aucune suppression de structure historique)" "2" "$(sql "select count(*) from public.menu_subcategories where category_id = '$RB_CAT';" | tr -d '\n')"
  assert_eq "[v1.2 RB/A] le produit archivé existe toujours et reste rattaché à sa sous-catégorie d'origine (historique intact)" "$RB_OLD_SUB" "$(sql "select subcategory_id from public.menu_items where id = '00000000-0000-0000-0000-00000000ee01';" | tr -d '\n')"
  assert_eq "[v1.2 RB/A] le produit archivé reste archivé (le rollback de SCHÉMA ne ressuscite jamais un catalogue remis à zéro)" "f" "$(sql "select (archived_at is null) from public.menu_items where id = '00000000-0000-0000-0000-00000000ee01';" | tr -d '\n')"

  # ---- re-rollback sur une base déjà rétrogradée : refus fail-closed ----
  psql -d "$DB" -v ON_ERROR_STOP=1 -f "$ROLLBACK_SQL" >/dev/null 2>/tmp/scanym-catreset-rberr4-$$.txt
  rb_rc3=$?
  assert_denied "[v1.2 RB/DRIFT] relancer le rollback sur une base déjà rétrogradée est refusé (fail-closed)" "$rb_rc3"
  assert_contains "[v1.2 RB/DRIFT] le refus porte la sentinelle SCANYM_ROLLBACK_DRIFT" "SCANYM_ROLLBACK_DRIFT" "$(cat /tmp/scanym-catreset-rberr4-$$.txt 2>/dev/null)"

  DB="$DB_MAIN"
fi

# ==================================================================
# RÉSUMÉ
# ==================================================================
log "=== RÉSUMÉ : PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" -gt 0 ]; then
  log "--- ÉCHECS ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
