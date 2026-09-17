#!/usr/bin/env bash
# ============================================================
# Scanym — CLAUDE NOUGARO — OPERATOR BACKOFFICE — SAFE CATALOGUE
# CATALOGUE MANAGEMENT UX v1 — harnais SQL réel (PostgreSQL réel, aucune simulation),
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
TAGS_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-collections-tags-foundation-v1.sql"
CMUX_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-management-ux-v1.sql"
CMUX_ROLLBACK_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-management-ux-v1-ROLLBACK.sql"
DB="scanym_cmux_v1_$$"
# v1.2 -- base DÉDIÉE au scénario de rollback : un rollback SUPPRIME le
# lot (fonctions, table d'audit, colonne), il ne peut donc pas partager
# la base des 87 autres assertions sans les invalider.
DB_ROLLBACK="scanym_cmux_rb_$$"

PASS=0
FAIL=0
FAIL_LOG="/tmp/scanym-cmux-fails-$$.log"
: > "$FAIL_LOG"

log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS=$((PASS+1)); log "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); printf '%s\n' "$1" >> "$FAIL_LOG"; log "FAIL: $1"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_ROLLBACK\";" >/dev/null 2>&1 || true
  rm -f "$FAIL_LOG" /tmp/scanym-cmux-*-$$.txt /tmp/scanym-cmux-fixture-$$.txt /tmp/scanym-cmux-chain-err-$$.txt 2>/dev/null || true
}
trap cleanup EXIT

sql() { psql -X -A -q -t -d "$DB" -c "$1" 2>/tmp/scanym-cmux-err-$$.txt; }
sql_rc() { psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-cmux-out-$$.txt 2>/tmp/scanym-cmux-err-$$.txt; echo $?; }
sql_err() { cat /tmp/scanym-cmux-err-$$.txt 2>/dev/null; }

as_authenticated() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    2>/tmp/scanym-cmux-err-$$.txt
}
as_authenticated_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    >/tmp/scanym-cmux-out-$$.txt 2>/tmp/scanym-cmux-err-$$.txt
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
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>/tmp/scanym-cmux-chain-err-$$.txt
    if [ $? -ne 0 ]; then log "FATAL applying $f: $(cat /tmp/scanym-cmux-chain-err-$$.txt)"; return 1; fi
    psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  done
  for f in $REST_CHAIN; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>/tmp/scanym-cmux-chain-err-$$.txt
    if [ $? -ne 0 ]; then log "FATAL applying $f: $(cat /tmp/scanym-cmux-chain-err-$$.txt)"; return 1; fi
  done
  for f in "$OB2_SQL" "$OB4_SQL" "$VAT_SQL" "$RESET_SQL" "$TAGS_SQL" "$CMUX_SQL"; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>/tmp/scanym-cmux-chain-err-$$.txt
    if [ $? -ne 0 ]; then log "FATAL applying $(basename "$f"): $(cat /tmp/scanym-cmux-chain-err-$$.txt)"; return 1; fi
  done
  return 0
}

log "=== [SETUP] base $DB, chaîne + COLLECTIONS/TAGS + CATALOGUE MANAGEMENT UX v1 ==="
psql -c "create database \"$DB\";" >/dev/null 2>&1
build_common_bootstrap
if ! build_chain; then log "FATAL: chaîne de migrations a échoué"; exit 1; fi

psql -d "$DB" -v ON_ERROR_STOP=1 >/tmp/scanym-cmux-fixture-$$.txt 2>&1 <<'SQL'
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1','operator@scanym.test'),
  ('00000000-0000-0000-0000-0000000000a2','owner-a@example.test'),
  ('00000000-0000-0000-0000-0000000000a4','owner-b@example.test'),
  ('00000000-0000-0000-0000-0000000000a5','stranger@example.test');
insert into public.scanym_operators (user_id) values ('00000000-0000-0000-0000-0000000000a1');
insert into public.restaurants (id, name, slug, is_active, status) values
  ('00000000-0000-0000-0000-00000000b001','Au Lait Cru','au-lait-cru',true,'active'),
  ('00000000-0000-0000-0000-00000000b002','Hotel Royal','hotel-royal',true,'active');
insert into public.restaurant_users (user_id, restaurant_id, role) values
  ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-00000000b001','owner'),
  ('00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-00000000b002','owner');
insert into public.menu_categories (id, restaurant_id, name, display_order) values
  ('00000000-0000-0000-0000-00000000c001','00000000-0000-0000-0000-00000000b001','Fromages',1),
  ('00000000-0000-0000-0000-00000000c101','00000000-0000-0000-0000-00000000b002','Fromages',1);
insert into public.menu_items (id, category_id, name, price, display_order, is_available, tax_rate, archived_at) values
  ('00000000-0000-0000-0000-00000000e001','00000000-0000-0000-0000-00000000c001','Comte',6.0,1,true,5.5,null),
  ('00000000-0000-0000-0000-00000000e002','00000000-0000-0000-0000-00000000c001','Indispo',7.0,2,false,5.5,null),
  ('00000000-0000-0000-0000-00000000e003','00000000-0000-0000-0000-00000000c001','Archive',8.0,3,true,5.5,now()),
  ('00000000-0000-0000-0000-00000000e101','00000000-0000-0000-0000-00000000c101','Raclette',9.0,1,true,5.5,null);
SQL
assert_eq "[FIXTURE] 2 tenants, produits disponible/indisponible/archivé" "0" "$?"

RESTA="00000000-0000-0000-0000-00000000b001"; RESTB="00000000-0000-0000-0000-00000000b002"
OPERATOR="00000000-0000-0000-0000-0000000000a1"; OWNER_A="00000000-0000-0000-0000-0000000000a2"
OWNER_B="00000000-0000-0000-0000-0000000000a4"; STRANGER="00000000-0000-0000-0000-0000000000a5"
P1="00000000-0000-0000-0000-00000000e001"; P2="00000000-0000-0000-0000-00000000e002"
P3="00000000-0000-0000-0000-00000000e003"; PB="00000000-0000-0000-0000-00000000e101"

as_authenticated "$OWNER_A" "select public.add_product_tags('$P1', array['Bio','AOP']);" >/dev/null 2>&1
as_authenticated "$OWNER_A" "select public.add_product_tags('$P2', array['Bio']);" >/dev/null 2>&1
as_authenticated "$OWNER_A" "select public.add_product_tags('$P3', array['Bio']);" >/dev/null 2>&1
as_authenticated "$OWNER_B" "select public.add_product_tags('$PB', array['Bio']);" >/dev/null 2>&1
BIO_A=$(sql "select id from public.menu_tags where restaurant_id='$RESTA' and normalized_key='bio';"|tr -d '\n')
BIO_B=$(sql "select id from public.menu_tags where restaurant_id='$RESTB' and normalized_key='bio';"|tr -d '\n')
AOP_A=$(sql "select id from public.menu_tags where restaurant_id='$RESTA' and normalized_key='aop';"|tr -d '\n')

# ==================================================================
# [READ] get_restaurant_product_tags -- vue BACKOFFICE
# ==================================================================
log "=== [READ] get_restaurant_product_tags ==="
assert_eq "[READ] une LIGNE par produit tagué, jamais produit × tag" "3" "$(as_authenticated "$OWNER_A" "select count(*) from public.get_restaurant_product_tags('$RESTA');"|tr -d '\n')"
assert_eq "[READ] les tags d'un produit sont AGRÉGÉS dans un tableau" "2" "$(as_authenticated "$OWNER_A" "select array_length(tag_ids,1) from public.get_restaurant_product_tags('$RESTA') where menu_item_id='$P1';"|tr -d '\n')"
assert_eq "[READ] un produit INDISPONIBLE est visible du marchand (contrairement au contrat client)" "1" "$(as_authenticated "$OWNER_A" "select count(*) from public.get_restaurant_product_tags('$RESTA') where menu_item_id='$P2';"|tr -d '\n')"
assert_eq "[READ] un produit ARCHIVÉ est visible du marchand (contrairement au contrat client)" "1" "$(as_authenticated "$OWNER_A" "select count(*) from public.get_restaurant_product_tags('$RESTA') where menu_item_id='$P3';"|tr -d '\n')"
assert_eq "[READ] un tag NON PUBLIÉ est bien exposé au marchand" "f" "$(sql "select visible_on_customer_menu from public.menu_tags where id='$BIO_A';"|tr -d '\n')"
assert_eq "[READ] noms de tags ordonnés déterministement" "AOP|Bio" "$(as_authenticated "$OWNER_A" "select array_to_string(tag_names,'|') from public.get_restaurant_product_tags('$RESTA') where menu_item_id='$P1';"|tr -d '\n')"
assert_eq "[READ/ISOLATION] aucun produit du tenant B dans la vue de A" "0" "$(as_authenticated "$OWNER_A" "select count(*) from public.get_restaurant_product_tags('$RESTA') where menu_item_id='$PB';"|tr -d '\n')"
rc=$(as_authenticated_rc "$OWNER_B" "select * from public.get_restaurant_product_tags('$RESTA');")
assert_denied "[READ/ISOLATION] l'owner de B ne peut pas lire la carte produit-tags de A" "$rc"
rc=$(as_authenticated_rc "$STRANGER" "select * from public.get_restaurant_product_tags('$RESTA');")
assert_denied "[READ/AUTH] un étranger est refusé" "$rc"
rc=$(sql_rc "select * from public.get_restaurant_product_tags('$RESTA');")
assert_denied "[READ/AUTH] appel non authentifié refusé" "$rc"
rc=$(as_authenticated_rc "$OPERATOR" "select * from public.get_restaurant_product_tags('$RESTA');")
assert_ok "[READ/AUTH] l'opérateur Scanym est autorisé (jamais marchand-seul)" "$rc"

# ==================================================================
# [REMOVE] remove_product_tag
# ==================================================================
log "=== [REMOVE] remove_product_tag ==="
tags_before=$(sql "select count(*) from public.menu_tags where restaurant_id='$RESTA';"|tr -d '\n')
n=$(as_authenticated "$OWNER_A" "select public.remove_product_tag('$P1','$AOP_A');"|tr -d '\n')
assert_eq "[REMOVE] retire exactement UNE association" "1" "$n"
assert_eq "[REMOVE] le produit ne porte plus que Bio" "Bio" "$(as_authenticated "$OWNER_A" "select array_to_string(tag_names,'|') from public.get_restaurant_product_tags('$RESTA') where menu_item_id='$P1';"|tr -d '\n')"
assert_eq "[REMOVE/§5] le TAG lui-même n'est JAMAIS supprimé" "$tags_before" "$(sql "select count(*) from public.menu_tags where restaurant_id='$RESTA';"|tr -d '\n')"
assert_eq "[REMOVE/§5] le tag retiré reste disponible pour le tenant" "1" "$(sql "select count(*) from public.menu_tags where id='$AOP_A';"|tr -d '\n')"
n=$(as_authenticated "$OWNER_A" "select public.remove_product_tag('$P1','$AOP_A');"|tr -d '\n')
assert_eq "[REMOVE] IDEMPOTENTE : retirer une association déjà absente retourne 0 sans erreur" "0" "$n"
assert_eq "[REMOVE] aucun autre produit n'est affecté (Bio toujours sur P2)" "1" "$(sql "select count(*) from public.menu_item_tags where menu_item_id='$P2' and tag_id='$BIO_A';"|tr -d '\n')"
n=$(as_authenticated "$OWNER_A" "select public.remove_product_tag('$P1','$BIO_B');"|tr -d '\n')
assert_eq "[REMOVE/ISOLATION] un tag d'un AUTRE tenant ne retire rien, et ne révèle pas son existence" "0" "$n"
assert_eq "[REMOVE/ISOLATION] l'association du tenant B est intacte" "1" "$(sql "select count(*) from public.menu_item_tags where menu_item_id='$PB' and tag_id='$BIO_B';"|tr -d '\n')"
rc=$(as_authenticated_rc "$OWNER_B" "select public.remove_product_tag('$P1','$BIO_A');")
assert_denied "[REMOVE/ISOLATION] l'owner de B ne peut pas retirer un tag d'un produit de A" "$rc"
rc=$(as_authenticated_rc "$STRANGER" "select public.remove_product_tag('$P1','$BIO_A');")
assert_denied "[REMOVE/AUTH] un étranger est refusé" "$rc"
rc=$(sql_rc "select public.remove_product_tag('$P1','$BIO_A');")
assert_denied "[REMOVE/AUTH] appel non authentifié refusé" "$rc"
assert_eq "[REMOVE] après les 3 refus, l'association Bio de P1 est toujours là" "1" "$(sql "select count(*) from public.menu_item_tags where menu_item_id='$P1' and tag_id='$BIO_A';"|tr -d '\n')"
rc=$(as_authenticated_rc "$OPERATOR" "select public.remove_product_tag('$P1','$BIO_A');")
assert_ok "[REMOVE/AUTH] l'opérateur Scanym est autorisé" "$rc"

# ==================================================================
# [SCOPE] la fondation et le catalogue restent intacts
# ==================================================================
log "=== [SCOPE] aucun impact sur l'existant ==="
assert_eq "[SCOPE] les 6 RPC de la fondation COLLECTIONS/TAGS sont intactes" "6" "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('assert_tag_admin','create_tag','add_product_tags','update_tag_collection_settings','get_restaurant_tags','get_restaurant_collections');"|tr -d '\n')"
assert_eq "[SCOPE] get_merchant_catalogue n'expose toujours AUCUNE colonne tag" "0" "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_merchant_catalogue' and pg_get_function_result(p.oid) ilike '%tag%';"|tr -d '\n')"
assert_eq "[SCOPE] menu_tags (9 colonnes) + menu_item_tags (3) : structure de la fondation INCHANGÉE par ce lot" "12" "$(sql "select (select count(*) from information_schema.columns where table_schema='public' and table_name='menu_tags') + (select count(*) from information_schema.columns where table_schema='public' and table_name='menu_item_tags');"|tr -d '\n')"
assert_eq "[SCOPE] aucun ALTER TABLE sur les tables de tags dans le fichier du lot" "0" "$(grep -ci 'alter table public.menu_tags\|alter table public.menu_item_tags' "$CMUX_SQL" || true)"
assert_eq "[SCOPE] aucun produit supprimé par ce lot" "4" "$(sql "select count(*) from public.menu_items;"|tr -d '\n')"
assert_eq "[SCOPE] le contrat CLIENT reste restreint aux collections publiées (0 ici, aucune n'est publiée)" "0" "$(sql "select count(*) from public.get_restaurant_collections('$RESTA');"|tr -d '\n')"

# ==================================================================
# [ROLLBACK]
# ==================================================================
log "=== [ROLLBACK] ==="
DB_MAIN="$DB"; DB="$DB_ROLLBACK"
psql -c "create database \"$DB\";" >/dev/null 2>&1
build_common_bootstrap
if ! build_chain; then fail "[ROLLBACK] chaîne échouée sur la base dédiée"; else
  psql -d "$DB" -v ON_ERROR_STOP=1 -f "$CMUX_ROLLBACK_SQL" >/dev/null 2>/tmp/scanym-cmux-rberr-$$.txt
  assert_ok "[ROLLBACK] s'exécute intégralement" "$?"
  assert_eq "[ROLLBACK] les 2 RPC du lot sont supprimées" "0" "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('remove_product_tag','get_restaurant_product_tags');"|tr -d '\n')"
  assert_eq "[ROLLBACK] la fondation COLLECTIONS/TAGS est INTACTE (6 RPC)" "6" "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('assert_tag_admin','create_tag','add_product_tags','update_tag_collection_settings','get_restaurant_tags','get_restaurant_collections');"|tr -d '\n')"
  assert_eq "[ROLLBACK] les tables de tags existent toujours (aucune donnée perdue)" "2" "$(sql "select count(*) from pg_class where relname in ('menu_tags','menu_item_tags') and relnamespace='public'::regnamespace;"|tr -d '\n')"
  psql -d "$DB" -v ON_ERROR_STOP=1 -f "$CMUX_ROLLBACK_SQL" >/dev/null 2>/tmp/scanym-cmux-rberr2-$$.txt
  assert_denied "[ROLLBACK] relancer sur une base déjà rétrogradée est refusé (fail-closed)" "$?"
  assert_contains "[ROLLBACK] le refus porte SCANYM_ROLLBACK_DRIFT" "SCANYM_ROLLBACK_DRIFT" "$(cat /tmp/scanym-cmux-rberr2-$$.txt 2>/dev/null)"
fi
DB="$DB_MAIN"

log "=== RÉSUMÉ : PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" -gt 0 ]; then log "--- ÉCHECS ---"; cat "$FAIL_LOG"; exit 1; fi
exit 0
