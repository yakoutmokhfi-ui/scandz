#!/usr/bin/env bash
# ============================================================
# Scanym — CLAUDE NOUGARO — OPERATOR BACKOFFICE — SAFE CATALOGUE
# COLLECTIONS / TAGS FOUNDATION v1 — harnais SQL réel (PostgreSQL réel, aucune simulation),
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
TAGS_ROLLBACK_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-collections-tags-foundation-v1-ROLLBACK.sql"
DB="scanym_tags_v1_$$"
# v1.2 -- base DÉDIÉE au scénario de rollback : un rollback SUPPRIME le
# lot (fonctions, table d'audit, colonne), il ne peut donc pas partager
# la base des 87 autres assertions sans les invalider.
DB_ROLLBACK="scanym_tags_rb_$$"

PASS=0
FAIL=0
FAIL_LOG="/tmp/scanym-tags-fails-$$.log"
: > "$FAIL_LOG"

log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS=$((PASS+1)); log "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); printf '%s\n' "$1" >> "$FAIL_LOG"; log "FAIL: $1"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_ROLLBACK\";" >/dev/null 2>&1 || true
  rm -f "$FAIL_LOG" /tmp/scanym-tags-*-$$.txt /tmp/scanym-tags-fixture-$$.txt /tmp/scanym-tags-chain-err-$$.txt 2>/dev/null || true
}
trap cleanup EXIT

sql() { psql -X -A -q -t -d "$DB" -c "$1" 2>/tmp/scanym-tags-err-$$.txt; }
sql_rc() { psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-tags-out-$$.txt 2>/tmp/scanym-tags-err-$$.txt; echo $?; }
sql_err() { cat /tmp/scanym-tags-err-$$.txt 2>/dev/null; }

as_authenticated() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    2>/tmp/scanym-tags-err-$$.txt
}
as_authenticated_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    >/tmp/scanym-tags-out-$$.txt 2>/tmp/scanym-tags-err-$$.txt
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
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>/tmp/scanym-tags-chain-err-$$.txt
    if [ $? -ne 0 ]; then log "FATAL applying $f: $(cat /tmp/scanym-tags-chain-err-$$.txt)"; return 1; fi
    psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  done
  for f in $REST_CHAIN; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>/tmp/scanym-tags-chain-err-$$.txt
    if [ $? -ne 0 ]; then log "FATAL applying $f: $(cat /tmp/scanym-tags-chain-err-$$.txt)"; return 1; fi
  done
  for f in "$OB2_SQL" "$OB4_SQL" "$VAT_SQL" "$RESET_SQL" "$TAGS_SQL"; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>/tmp/scanym-tags-chain-err-$$.txt
    if [ $? -ne 0 ]; then log "FATAL applying $(basename "$f"): $(cat /tmp/scanym-tags-chain-err-$$.txt)"; return 1; fi
  done
  return 0
}

log "=== [SETUP] base $DB, chaîne complète + COLLECTIONS/TAGS FOUNDATION v1 ==="
psql -c "create database \"$DB\";" >/dev/null 2>&1
build_common_bootstrap
if ! build_chain; then
  log "FATAL: chaîne de migrations a échoué"
  exit 1
fi
log "=== chaîne appliquée (schema.sql .. OB2 .. OB4 .. VAT .. RESET v1.2 .. TAGS v1) ==="

# ------------------------------------------------------------------
# FIXTURE : 2 tenants aux MÊMES noms de tag ("Bio"), pour prouver
# l'isolation (§2/§9). Tenant A publié, tenant B publié aussi.
# 1 opérateur Scanym, 1 owner A, 1 manager A, 1 owner B, 1 étranger.
# ------------------------------------------------------------------
psql -d "$DB" -v ON_ERROR_STOP=1 >/tmp/scanym-tags-fixture-$$.txt 2>&1 <<'SQL'
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1','operator@scanym.test'),
  ('00000000-0000-0000-0000-0000000000a2','owner-a@example.test'),
  ('00000000-0000-0000-0000-0000000000a3','manager-a@example.test'),
  ('00000000-0000-0000-0000-0000000000a4','owner-b@example.test'),
  ('00000000-0000-0000-0000-0000000000a5','stranger@example.test');
insert into public.scanym_operators (user_id) values ('00000000-0000-0000-0000-0000000000a1');
insert into public.restaurants (id, name, slug, is_active, status) values
  ('00000000-0000-0000-0000-00000000b001','Au Lait Cru','au-lait-cru',true,'active'),
  ('00000000-0000-0000-0000-00000000b002','Hotel Royal','hotel-royal',true,'active'),
  ('00000000-0000-0000-0000-00000000b003','En Onboarding','en-onboarding',true,'onboarding');
insert into public.restaurant_users (user_id, restaurant_id, role) values
  ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-00000000b001','owner'),
  ('00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-00000000b001','manager'),
  ('00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-00000000b002','owner');
insert into public.menu_categories (id, restaurant_id, name, display_order) values
  ('00000000-0000-0000-0000-00000000c001','00000000-0000-0000-0000-00000000b001','Fromages',1),
  ('00000000-0000-0000-0000-00000000c101','00000000-0000-0000-0000-00000000b002','Fromages',1),
  ('00000000-0000-0000-0000-00000000c201','00000000-0000-0000-0000-00000000b003','Fromages',1);
insert into public.menu_items (id, category_id, name, price, display_order, is_available, tax_rate) values
  ('00000000-0000-0000-0000-00000000e001','00000000-0000-0000-0000-00000000c001','Charolais',4.5,1,true,5.5),
  ('00000000-0000-0000-0000-00000000e002','00000000-0000-0000-0000-00000000c001','Comte',6.0,2,true,5.5),
  ('00000000-0000-0000-0000-00000000e003','00000000-0000-0000-0000-00000000c001','Indispo',7.0,3,false,5.5),
  ('00000000-0000-0000-0000-00000000e101','00000000-0000-0000-0000-00000000c101','Raclette',9.0,1,true,5.5),
  ('00000000-0000-0000-0000-00000000e201','00000000-0000-0000-0000-00000000c201','Secret',9.0,1,true,5.5);
SQL
assert_eq "[FIXTURE] 2 tenants publiés + 1 en onboarding, opérateur, owner/manager/étranger" "0" "$?"

RESTA="00000000-0000-0000-0000-00000000b001"
RESTB="00000000-0000-0000-0000-00000000b002"
RESTC="00000000-0000-0000-0000-00000000b003"
OPERATOR="00000000-0000-0000-0000-0000000000a1"
OWNER_A="00000000-0000-0000-0000-0000000000a2"
MANAGER_A="00000000-0000-0000-0000-0000000000a3"
OWNER_B="00000000-0000-0000-0000-0000000000a4"
STRANGER="00000000-0000-0000-0000-0000000000a5"
P1="00000000-0000-0000-0000-00000000e001"
P2="00000000-0000-0000-0000-00000000e002"
P3="00000000-0000-0000-0000-00000000e003"
PB="00000000-0000-0000-0000-00000000e101"

# ==================================================================
# [AUTH] §3 -- marchand ET opérateur, jamais opérateur seul.
# ==================================================================
log "=== [AUTH] §3 autorisation marchand + opérateur ==="
rc=$(as_authenticated_rc "$OWNER_A" "select public.create_tag('$RESTA','Bio');")
assert_ok "[AUTH] l'OWNER du restaurant peut créer un tag (jamais opérateur-seul)" "$rc"
rc=$(as_authenticated_rc "$MANAGER_A" "select public.create_tag('$RESTA','Truffe');")
assert_ok "[AUTH] le MANAGER du restaurant peut créer un tag" "$rc"
rc=$(as_authenticated_rc "$OPERATOR" "select public.create_tag('$RESTA','AOP');")
assert_ok "[AUTH] l'OPÉRATEUR Scanym peut créer un tag pour le compte du marchand" "$rc"
rc=$(as_authenticated_rc "$STRANGER" "select public.create_tag('$RESTA','Pirate');")
assert_denied "[AUTH] un authentifié SANS rattachement ni opérateur est refusé" "$rc"
rc=$(as_authenticated_rc "$OWNER_B" "select public.create_tag('$RESTA','Pirate');")
assert_denied "[AUTH/ISOLATION] l'owner du tenant B ne peut PAS créer un tag chez A" "$rc"
rc=$(sql_rc "select public.create_tag('$RESTA','Anonyme');")
assert_denied "[AUTH] appel non authentifié refusé" "$rc"
assert_eq "[AUTH] aucun tag parasite créé par les 3 refus" "3" "$(sql "select count(*) from public.menu_tags where restaurant_id='$RESTA';"|tr -d '\n')"

# ==================================================================
# [DEFAULT] §1 -- un tag importé/créé n'est JAMAIS publié.
# ==================================================================
log "=== [DEFAULT] §1 aucun tag n'est publié automatiquement ==="
assert_eq "[DEFAULT] les 3 tags créés valent visible_on_customer_menu = false" "0" "$(sql "select count(*) from public.menu_tags where restaurant_id='$RESTA' and visible_on_customer_menu=true;"|tr -d '\n')"

# ==================================================================
# [KEY] parité de la clé normalisée TS <-> SQL.
# ==================================================================
log "=== [KEY] clé normalisée générée ==="
assert_eq "[KEY] normalized_key = lower(btrim(name)) -- 'Bio' -> 'bio'" "bio" "$(sql "select normalized_key from public.menu_tags where restaurant_id='$RESTA' and name='Bio';"|tr -d '\n')"
rc=$(as_authenticated_rc "$OWNER_A" "select public.create_tag('$RESTA','  bio  ');")
assert_denied "[KEY] '  bio  ' collisionne avec 'Bio' (casse + bordures) -- refusé par l'index unique partiel" "$rc"
assert_contains "[KEY] le refus porte SCANYM_TAG_DUPLICATE_NAME" "SCANYM_TAG_DUPLICATE_NAME" "$(sql_err)"
assert_eq "[KEY] accents NON dépouillés : 'Cafe' et 'Café' sont 2 tags distincts" "0" "$(as_authenticated "$OWNER_A" "select public.create_tag('$RESTA','Cafe');" >/dev/null 2>&1; as_authenticated_rc "$OWNER_A" "select public.create_tag('$RESTA','Café');")"

# ==================================================================
# [IMPORT] §5/§8 -- add_product_tags : résout-ou-crée + associe,
# idempotent, additif, dédup insensible à la casse dans l'appel.
# ==================================================================
log "=== [IMPORT] §5/§8 add_product_tags ==="
n=$(as_authenticated "$OPERATOR" "select public.add_product_tags('$P1', array['Bio','Truffe','Nouveau']);"|tr -d '\n')
assert_eq "[IMPORT] 3 associations créées (2 tags existants réutilisés + 1 tag créé)" "3" "$n"
assert_eq "[IMPORT] 'Nouveau' a bien été créé comme tag du tenant A" "1" "$(sql "select count(*) from public.menu_tags where restaurant_id='$RESTA' and normalized_key='nouveau';"|tr -d '\n')"
assert_eq "[IMPORT/§1] le tag créé PAR IMPORT n'est PAS publié" "f" "$(sql "select visible_on_customer_menu from public.menu_tags where restaurant_id='$RESTA' and normalized_key='nouveau';"|tr -d '\n')"
n=$(as_authenticated "$OPERATOR" "select public.add_product_tags('$P1', array['Bio','Truffe','Nouveau']);"|tr -d '\n')
assert_eq "[IMPORT/§8] RÉIMPORT IDENTIQUE : 0 nouvelle association (convergence)" "0" "$n"
assert_eq "[IMPORT/§8] toujours exactement 3 associations pour ce produit" "3" "$(sql "select count(*) from public.menu_item_tags where menu_item_id='$P1';"|tr -d '\n')"
assert_eq "[IMPORT/§8] aucun tag dupliqué dans le tenant A" "0" "$(sql "select count(*) from (select normalized_key from public.menu_tags where restaurant_id='$RESTA' and is_active group by normalized_key having count(*)>1) d;"|tr -d '\n')"
n=$(as_authenticated "$OPERATOR" "select public.add_product_tags('$P1', array['bio','BIO','  Bio  ']);"|tr -d '\n')
assert_eq "[IMPORT] 'bio'/'BIO'/'  Bio  ' dans le MÊME appel -> 0 ajout (dédup insensible à la casse + tag déjà associé)" "0" "$n"
assert_eq "[IMPORT] toujours 3 associations (aucune variante de casse n'a créé de doublon)" "3" "$(sql "select count(*) from public.menu_item_tags where menu_item_id='$P1';"|tr -d '\n')"
n=$(as_authenticated "$OPERATOR" "select public.add_product_tags('$P1', array['AOP']);"|tr -d '\n')
assert_eq "[IMPORT] ADDITIF : ajouter 'AOP' n'enlève aucune association existante" "1" "$n"
assert_eq "[IMPORT] le produit porte désormais 4 tags (3 précédents CONSERVÉS + AOP)" "4" "$(sql "select count(*) from public.menu_item_tags where menu_item_id='$P1';"|tr -d '\n')"
n=$(as_authenticated "$OPERATOR" "select public.add_product_tags('$P1', array['','   ',null]);"|tr -d '\n')
assert_eq "[IMPORT] valeurs vides/blanches/NULL ignorées silencieusement" "0" "$n"
rc=$(as_authenticated_rc "$STRANGER" "select public.add_product_tags('$P1', array['Pirate']);")
assert_denied "[IMPORT/AUTH] un étranger ne peut pas taguer un produit" "$rc"
rc=$(as_authenticated_rc "$OWNER_B" "select public.add_product_tags('$P1', array['Pirate']);")
assert_denied "[IMPORT/ISOLATION] l'owner de B ne peut pas taguer un produit de A" "$rc"
assert_eq "[IMPORT] aucun tag 'Pirate' n'existe nulle part après les refus" "0" "$(sql "select count(*) from public.menu_tags where normalized_key='pirate';"|tr -d '\n')"

# ==================================================================
# [v1.1 A] CONSTAT A -- associer des tags à un produit dont AUCUN
# champ catalogue n'est modifié (cas d'une ligne d'import SKIP).
# Prouve, au niveau BASE, que l'association ne dépend d'aucune
# mutation préalable du produit : la correction v1.1 côté
# orchestration s'appuie sur cette propriété serveur.
# ==================================================================
log "=== [v1.1 A] association sur un produit non modifié (ligne SKIP) ==="
p2_before=$(sql "select name||'|'||price||'|'||coalesce(archived_at::text,'-') from public.menu_items where id='$P2';"|tr -d '\n')
n=$(as_authenticated "$OPERATOR" "select public.add_product_tags('$P2', array['Truffe']);"|tr -d '\n')
assert_eq "[v1.1-A] un tag est associé à un produit SANS qu'aucune RPC de mutation produit ne soit appelée" "1" "$n"
assert_eq "[v1.1-A] le produit lui-même est rigoureusement INCHANGÉ (nom, prix, archivage)" "$p2_before" "$(sql "select name||'|'||price||'|'||coalesce(archived_at::text,'-') from public.menu_items where id='$P2';"|tr -d '\n')"
n=$(as_authenticated "$OPERATOR" "select public.add_product_tags('$P2', array['Truffe']);"|tr -d '\n')
assert_eq "[v1.1-A] ré-associer le même tag au même produit non modifié : 0 ajout (convergence, aucun doublon)" "0" "$n"

# ==================================================================
# [ISOLATION] §2/§9 -- 'Bio' chez A et chez B = 2 lignes distinctes.
# ==================================================================
log "=== [ISOLATION] §2/§9 tags locaux au tenant ==="
as_authenticated "$OWNER_B" "select public.add_product_tags('$PB', array['Bio']);" >/dev/null 2>&1
assert_eq "[ISOLATION] 'Bio' existe une fois chez A et une fois chez B -- 2 lignes indépendantes" "2" "$(sql "select count(*) from public.menu_tags where normalized_key='bio';"|tr -d '\n')"
assert_eq "[ISOLATION] le 'Bio' de A et celui de B ont des id DIFFÉRENTS" "2" "$(sql "select count(distinct id) from public.menu_tags where normalized_key='bio';"|tr -d '\n')"
rc=$(as_authenticated_rc "$OWNER_B" "select * from public.get_restaurant_tags('$RESTA');")
assert_denied "[ISOLATION] l'owner de B ne peut pas LIRE la configuration de tags de A" "$rc"
rc=$(as_authenticated_rc "$STRANGER" "select * from public.get_restaurant_tags('$RESTA');")
assert_denied "[ISOLATION] un étranger ne peut pas lire la configuration de tags de A" "$rc"

# ==================================================================
# [CONFIG] §6 -- activer/désactiver/ordonner, sans rien supprimer.
# ==================================================================
log "=== [CONFIG] §6 configuration des collections ==="
BIO_A=$(sql "select id from public.menu_tags where restaurant_id='$RESTA' and normalized_key='bio';"|tr -d '\n')
TRUFFE_A=$(sql "select id from public.menu_tags where restaurant_id='$RESTA' and normalized_key='truffe';"|tr -d '\n')
rc=$(as_authenticated_rc "$OWNER_A" "select public.update_tag_collection_settings('$BIO_A', true, 1);")
assert_ok "[CONFIG] le MARCHAND publie 'Bio' comme collection (ordre 1)" "$rc"
rc=$(as_authenticated_rc "$OPERATOR" "select public.update_tag_collection_settings('$TRUFFE_A', true, 2);")
assert_ok "[CONFIG] l'OPÉRATEUR publie 'Truffe' pour le compte du marchand (ordre 2)" "$rc"
rc=$(as_authenticated_rc "$OWNER_B" "select public.update_tag_collection_settings('$BIO_A', false, null);")
assert_denied "[CONFIG/ISOLATION] l'owner de B ne peut pas configurer une collection de A" "$rc"
assert_eq "[CONFIG] 'Bio' est publié, ordre 1" "true|1" "$(sql "select visible_on_customer_menu||'|'||display_order from public.menu_tags where id='$BIO_A';"|tr -d '\n')"

tags_before=$(sql "select count(*) from public.menu_tags where restaurant_id='$RESTA';"|tr -d '\n')
assoc_before=$(sql "select count(*) from public.menu_item_tags;"|tr -d '\n')
items_before=$(sql "select count(*) from public.menu_items;"|tr -d '\n')
cats_before=$(sql "select count(*) from public.menu_categories;"|tr -d '\n')
as_authenticated "$OWNER_A" "select public.update_tag_collection_settings('$BIO_A', false, null);" >/dev/null 2>&1
assert_eq "[CONFIG/§6] DÉSACTIVER une collection ne supprime AUCUN tag" "$tags_before" "$(sql "select count(*) from public.menu_tags where restaurant_id='$RESTA';"|tr -d '\n')"
assert_eq "[CONFIG/§6] DÉSACTIVER ne supprime AUCUNE association produit/tag" "$assoc_before" "$(sql "select count(*) from public.menu_item_tags;"|tr -d '\n')"
assert_eq "[CONFIG/§6] DÉSACTIVER ne touche AUCUN produit" "$items_before" "$(sql "select count(*) from public.menu_items;"|tr -d '\n')"
assert_eq "[CONFIG/§6] DÉSACTIVER ne touche AUCUNE catégorie" "$cats_before" "$(sql "select count(*) from public.menu_categories;"|tr -d '\n')"
assert_eq "[CONFIG/§6] l'ordre est CONSERVÉ quand p_display_order est null" "1" "$(sql "select display_order from public.menu_tags where id='$BIO_A';"|tr -d '\n')"
as_authenticated "$OWNER_A" "select public.update_tag_collection_settings('$BIO_A', true, 1);" >/dev/null 2>&1

# ==================================================================
# [READ] §4 -- contrat de lecture, AUCUNE multiplication de lignes.
# ==================================================================
log "=== [READ] §4 contrat de lecture ==="
as_authenticated "$OPERATOR" "select public.add_product_tags('$P2', array['Bio']);" >/dev/null 2>&1
as_authenticated "$OPERATOR" "select public.add_product_tags('$P3', array['Bio']);" >/dev/null 2>&1
assert_eq "[READ] get_restaurant_collections : 2 collections visibles (Bio, Truffe) -- une LIGNE par collection, jamais produit × tag" "2" "$(sql "select count(*) from public.get_restaurant_collections('$RESTA');"|tr -d '\n')"
assert_eq "[READ] ordonnées par display_order : Bio(1) puis Truffe(2)" "Bio|Truffe" "$(sql "select string_agg(label,'|' order by display_order) from public.get_restaurant_collections('$RESTA');"|tr -d '\n')"
assert_eq "[READ] 'Bio' agrège 2 produits (Charolais + Comte) -- l'INDISPONIBLE est exclu" "2" "$(sql "select array_length(menu_item_ids,1) from public.get_restaurant_collections('$RESTA') where label='Bio';"|tr -d '\n')"
assert_eq "[READ] les tags NON publiés (AOP, Nouveau, Cafe, Café) n'apparaissent jamais" "0" "$(sql "select count(*) from public.get_restaurant_collections('$RESTA') where label in ('AOP','Nouveau','Cafe','Café');"|tr -d '\n')"
assert_eq "[READ/ISOLATION] les collections de A ne contiennent AUCUN produit de B" "0" "$(sql "select count(*) from public.get_restaurant_collections('$RESTA') c where '$PB' = any(c.menu_item_ids);"|tr -d '\n')"
assert_eq "[READ] un établissement en onboarding n'expose AUCUNE collection, même id connu" "0" "$(sql "select count(*) from public.get_restaurant_collections('$RESTC');"|tr -d '\n')"
assert_eq "[READ] get_restaurant_tags (backoffice) liste les 6 tags actifs de A" "6" "$(as_authenticated "$OWNER_A" "select count(*) from public.get_restaurant_tags('$RESTA');"|tr -d '\n')"
assert_eq "[READ] get_restaurant_tags expose le nombre de produits par tag (Bio=3, archivés exclus)" "3" "$(as_authenticated "$OWNER_A" "select product_count from public.get_restaurant_tags('$RESTA') where name='Bio';"|tr -d '\n')"

# ==================================================================
# [SCOPE] §7/§10 -- get_merchant_catalogue INTACTE, hiérarchie intacte.
# ==================================================================
log "=== [SCOPE] §7/§10 aucun impact sur l'existant ==="
assert_eq "[SCOPE/§4] get_merchant_catalogue n'expose AUCUNE colonne tag" "0" "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_merchant_catalogue' and pg_get_function_result(p.oid) ilike '%tag%';"|tr -d '\n')"
assert_eq "[SCOPE/§7] menu_items ne reçoit AUCUNE colonne tag (pas de 3e niveau de hiérarchie)" "0" "$(sql "select count(*) from information_schema.columns where table_schema='public' and table_name='menu_items' and column_name ilike '%tag%';"|tr -d '\n')"
assert_eq "[SCOPE/§7] un produit garde 1 catégorie et 0..N tags" "1|4" "$(sql "select (select count(distinct category_id) from public.menu_items where id='$P1')||'|'||(select count(*) from public.menu_item_tags where menu_item_id='$P1');"|tr -d '\n')"
assert_eq "[SCOPE] get_merchant_catalogue reste appelable par l'opérateur après ce lot" "0" "$(as_authenticated_rc "$OPERATOR" "select count(*) from public.get_merchant_catalogue('$RESTA', false);")"

# ==================================================================
# [RLS] §9 -- aucun accès direct aux tables.
# ==================================================================
log "=== [RLS] §9 ==="
assert_eq "[RLS] RLS activée sur menu_tags ET menu_item_tags" "2" "$(sql "select count(*) from pg_class where oid in ('public.menu_tags'::regclass,'public.menu_item_tags'::regclass) and relrowsecurity;"|tr -d '\n')"
rc=$(as_authenticated_rc "$OWNER_A" "insert into public.menu_tags (restaurant_id, name) values ('$RESTA','Direct');")
assert_denied "[RLS] écriture DIRECTE dans menu_tags refusée (même pour l'owner) -- tout passe par les RPC" "$rc"
rc=$(as_authenticated_rc "$OWNER_A" "delete from public.menu_item_tags where menu_item_id='$P1';")
assert_denied "[RLS] suppression DIRECTE d'associations refusée" "$rc"

# ==================================================================
# [ROLLBACK] additif -> retrait symétrique, atomique.
# ==================================================================
log "=== [ROLLBACK] ==="
DB_MAIN="$DB"; DB="$DB_ROLLBACK"
psql -c "create database \"$DB\";" >/dev/null 2>&1
build_common_bootstrap
if ! build_chain; then
  fail "[ROLLBACK] chaîne de migrations a échoué sur la base dédiée"
else
  psql -d "$DB" -v ON_ERROR_STOP=1 -f "$TAGS_ROLLBACK_SQL" >/dev/null 2>/tmp/scanym-tags-rberr-$$.txt
  assert_ok "[ROLLBACK] s'exécute intégralement sur une base ayant reçu le lot" "$?"
  assert_eq "[ROLLBACK] menu_tags et menu_item_tags supprimées" "0" "$(sql "select count(*) from pg_class where relname in ('menu_tags','menu_item_tags') and relnamespace='public'::regnamespace;"|tr -d '\n')"
  assert_eq "[ROLLBACK] les 6 RPC du lot sont supprimées" "0" "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('create_tag','add_product_tags','update_tag_collection_settings','get_restaurant_tags','get_restaurant_collections','assert_tag_admin');"|tr -d '\n')"
  assert_eq "[ROLLBACK] le catalogue préexistant est INTACT (menu_items/categories/subcategories)" "3" "$(sql "select count(*) from pg_class where relname in ('menu_items','menu_categories','menu_subcategories') and relnamespace='public'::regnamespace;"|tr -d '\n')"
  assert_eq "[ROLLBACK] get_merchant_catalogue toujours présente et inchangée" "1" "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_merchant_catalogue';"|tr -d '\n')"
  psql -d "$DB" -v ON_ERROR_STOP=1 -f "$TAGS_ROLLBACK_SQL" >/dev/null 2>/tmp/scanym-tags-rberr2-$$.txt
  assert_denied "[ROLLBACK] relancer sur une base déjà rétrogradée est refusé (fail-closed)" "$?"
  assert_contains "[ROLLBACK] le refus porte SCANYM_ROLLBACK_DRIFT" "SCANYM_ROLLBACK_DRIFT" "$(cat /tmp/scanym-tags-rberr2-$$.txt 2>/dev/null)"
fi
DB="$DB_MAIN"

log "=== RÉSUMÉ : PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" -gt 0 ]; then log "--- ÉCHECS ---"; cat "$FAIL_LOG"; exit 1; fi
exit 0
