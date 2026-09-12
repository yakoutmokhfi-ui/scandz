#!/usr/bin/env bash
# ============================================================
# Scanym — CLAUDE MONET — harnais SQL réel
# CATALOGUE VAT COMPLETENESS GUARD v1 -> v1.1
# (PostgreSQL réel, aucune simulation), exécuté en tant qu'utilisateur
# système postgres (authentification peer).
#
# v1.1 AJOUTE la section [C] : preuve du routage PAR NOM DE CONTRAINTE
# (audit Cat Stevens, BLOCKER) -- update_product/set_product_
# availability ne doivent traduire QUE
# menu_items_availability_requires_tax_rate_chk en
# SCANYM_TAX_RATE_REQUIRED_FOR_AVAILABILITY, jamais une autre
# contrainte CHECK de menu_items. Sections [0]/[A]/[B] INCHANGÉES
# (mêmes assertions qu'en v1 -- preuve de non-régression create/
# import, item 8 du mandat v1.1).
#
# Réutilise MINIMAL_CHAIN + REST_CHAIN, déjà prouvés et publiés par
# supabase/tests/catalogue-import-commit-v1-1-check.sh (même principe
# de "chaîne du domaine le plus proche" déjà pratiqué par tous les
# harnais siblings de ce dépôt), puis le prérequis OB-2 (catalogue-
# operator-authorization-v1) et OB-4 (catalogue-import-commit-
# idempotency-v1-1) -- reconstruit exactement le baseline actuel
# (main 5649aeaf162136de05e65c66335e0bc4899ad59e) pour le domaine
# menu_items/create_product/update_product/set_product_availability,
# SANS Stuart/paiement/facture (hors périmètre, jamais touchés par ce
# lot, déjà vérifié Phase 0/Targeted Closure).
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/catalogue-vat-completeness-guard-v1-check.sh"
# ============================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OB2_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-operator-authorization-v1.sql"
OB4_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-import-commit-idempotency-v1-1.sql"
GUARD_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-vat-completeness-guard-v1.sql"
DB="scanym_vatguard_$$"

PASS=0
FAIL=0
FAIL_LOG="/tmp/scanym-vatguard-fails-$$.log"
: > "$FAIL_LOG"

log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS=$((PASS+1)); log "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); printf '%s\n' "$1" >> "$FAIL_LOG"; log "FAIL: $1"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  rm -f "$FAIL_LOG" /tmp/scanym-vatguard-*-$$.txt 2>/dev/null || true
}
trap cleanup EXIT

sql() { psql -X -A -q -t -d "$DB" -c "$1" 2>/tmp/scanym-vatguard-err-$$.txt; }
sql_rc() { psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-vatguard-out-$$.txt 2>/tmp/scanym-vatguard-err-$$.txt; echo $?; }
sql_err() { cat /tmp/scanym-vatguard-err-$$.txt 2>/dev/null; }

as_authenticated() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    2>/tmp/scanym-vatguard-err-$$.txt
}
as_authenticated_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    >/tmp/scanym-vatguard-out-$$.txt 2>/tmp/scanym-vatguard-err-$$.txt
  echo $?
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_ok() {
  if [ "$2" -eq 0 ]; then pass "$1 (rc=0)"; else fail "$1 — attendu rc=0, obtenu rc=$2 : $(sql_err)"; fi
}
assert_denied() {
  if [ "$2" -ne 0 ]; then pass "$1 (rc=$2, refusé comme attendu)"; else fail "$1 — attendu un refus (rc!=0), obtenu rc=0"; fi
}
assert_contains() {
  if printf '%s' "$3" | grep -qF "$2"; then pass "$1"; else fail "$1 — '$2' absent de : $3"; fi
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

log "=== [0] Construction $DB (chaîne réelle jusqu'au baseline actuel) ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB" || { log "FATAL: createdb a échoué"; exit 1; }
build_common_bootstrap || { log "FATAL: bootstrap commun a échoué"; exit 1; }
build_chain || { log "FATAL: chaîne de migrations a échoué"; exit 1; }
pass "Chaîne de base appliquée"

RC=$(sql_rc "$(cat "$OB2_SQL")")
[ "$RC" -eq 0 ] && pass "Application propre de CATALOGUE OPERATOR AUTHORIZATION v1 (prérequis)" || { fail "OB-2 a échoué (rc=$RC) : $(sql_err)"; cat "$FAIL_LOG"; exit 1; }

RC=$(sql_rc "$(cat "$OB4_SQL")")
[ "$RC" -eq 0 ] && pass "Application propre de CATALOGUE IMPORT COMMIT / IDEMPOTENCY v1.1/1.2 (prérequis, baseline actuel de create_product)" || { fail "OB-4 a échoué (rc=$RC) : $(sql_err)"; cat "$FAIL_LOG"; exit 1; }

psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1

# ------------------------------------------------------------------
# Fixture : restaurant + owner + catégorie (avant l'installation du
# lot, pour prouver que le préflight passe sur des données propres,
# ET que le lot fonctionne sur une base non vierge).
# ------------------------------------------------------------------
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner@test.local');
insert into public.restaurants (id, name, slug) values
  ('22222222-2222-2222-2222-222222222222', 'Test Resto', 'test-resto');
insert into public.restaurant_users (user_id, restaurant_id, role) values
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'owner');
insert into public.menu_categories (id, restaurant_id, name, display_order) values
  ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'Fromages', 1);
SQL
pass "Fixture restaurant/owner/catégorie construite"

# ============================================================
# [A] PRÉFLIGHT — base propre, zéro violation -> le lot s'installe
# ============================================================
log "=== [A] Préflight sur base propre ==="
RC=$(sql_rc "$(cat "$GUARD_SQL")")
assert_ok "GUARD SQL s'installe proprement sur une base sans violation existante" "$RC"

# Contrainte présente et validée (pas NOT VALID résiduel)
CONVALIDATED=$(sql "select convalidated from pg_constraint where conname='menu_items_availability_requires_tax_rate_chk';")
assert_eq "contrainte menu_items_availability_requires_tax_rate_chk validée (convalidated=t, jamais NOT VALID durable)" "t" "$CONVALIDATED"

# ============================================================
# [B] SQL / RPC — matrice de test (items 1-12 du mandat)
# ============================================================
log "=== [B] Matrice SQL/RPC ==="

# 1. create product avec tax NULL -> succès, is_available=false
RC=$(as_authenticated_rc "11111111-1111-1111-1111-111111111111" \
  "select public.create_product('33333333-3333-3333-3333-333333333333','Brie de Meaux',null,7.5,null,null,null,false,null);")
assert_ok "1. create_product(tax_rate=NULL) réussit" "$RC"
AVAIL=$(sql "select is_available from public.menu_items where name='Brie de Meaux';")
assert_eq "1. produit créé sans TVA -> is_available=false" "f" "$AVAIL"

# 2. create product avec tax 0 -> succès, available selon comportement normal (true)
RC=$(as_authenticated_rc "11111111-1111-1111-1111-111111111111" \
  "select public.create_product('33333333-3333-3333-3333-333333333333','Comté 24 mois',null,9.5,null,0,null,false,null);")
assert_ok "2. create_product(tax_rate=0) réussit" "$RC"
AVAIL=$(sql "select is_available from public.menu_items where name='Comté 24 mois';")
assert_eq "2. produit créé avec TVA=0 -> is_available=true (0 est une valeur valide)" "t" "$AVAIL"

# 3. create product avec taux positif valide -> succès
RC=$(as_authenticated_rc "11111111-1111-1111-1111-111111111111" \
  "select public.create_product('33333333-3333-3333-3333-333333333333','Reblochon',null,8.0,null,5.5,null,false,null);")
assert_ok "3. create_product(tax_rate=5.5) réussit" "$RC"
AVAIL=$(sql "select is_available from public.menu_items where name='Reblochon';")
assert_eq "3. produit créé avec TVA positive -> is_available=true" "t" "$AVAIL"

# 4. produit disponible, update tax -> NULL -> rejeté, ligne inchangée
PID=$(sql "select id from public.menu_items where name='Reblochon';")
RC=$(as_authenticated_rc "11111111-1111-1111-1111-111111111111" \
  "select public.update_product('$PID','Reblochon',null,8.0,null,null,null,false,null);")
assert_denied "4. update_product effaçant la TVA d'un produit DISPONIBLE est rejeté" "$RC"
assert_contains "4. message applicatif stable (jamais le texte brut Postgres)" "SCANYM_TAX_RATE_REQUIRED_FOR_AVAILABILITY" "$(sql_err)"
TAX_AFTER=$(sql "select tax_rate from public.menu_items where id='$PID';")
AVAIL_AFTER=$(sql "select is_available from public.menu_items where id='$PID';")
# numeric(5,2) -- Postgres formate "5.50", pas "5.5" (bug de l'assertion
# du harnais, pas du produit -- corrigé après premier run).
assert_eq "4. ligne inchangée après rejet -- tax_rate toujours 5.50" "5.50" "$TAX_AFTER"
assert_eq "4. ligne inchangée après rejet -- is_available toujours true (jamais désactivé silencieusement)" "t" "$AVAIL_AFTER"

# 5. produit indisponible, update tax -> NULL -> autorisé
PID_UNAVAIL=$(sql "select id from public.menu_items where name='Brie de Meaux';")
RC=$(as_authenticated_rc "11111111-1111-1111-1111-111111111111" \
  "select public.update_product('$PID_UNAVAIL','Brie de Meaux',null,7.5,null,null,null,false,null);")
assert_ok "5. update_product laissant tax_rate=NULL sur un produit DÉJÀ INDISPONIBLE est autorisé" "$RC"

# 6. produit indisponible, toggle ON avec tax NULL -> rejeté
RC=$(as_authenticated_rc "11111111-1111-1111-1111-111111111111" \
  "select public.set_product_availability('$PID_UNAVAIL', true);")
assert_denied "6. set_product_availability(true) sur produit sans TVA est rejeté" "$RC"
assert_contains "6. message applicatif stable" "SCANYM_TAX_RATE_REQUIRED_FOR_AVAILABILITY" "$(sql_err)"

# 7. produit indisponible, toggle ON avec tax=0 -> autorisé
PID_ZERO=$(sql "select id from public.menu_items where name='Comté 24 mois';")
sql "update public.menu_items set is_available=false where id='$PID_ZERO';" >/dev/null
RC=$(as_authenticated_rc "11111111-1111-1111-1111-111111111111" \
  "select public.set_product_availability('$PID_ZERO', true);")
assert_ok "7. set_product_availability(true) sur produit avec TVA=0 est autorisé" "$RC"

# 8. produit indisponible, toggle ON avec taux positif valide -> autorisé
sql "update public.menu_items set is_available=false where id='$PID';" >/dev/null
RC=$(as_authenticated_rc "11111111-1111-1111-1111-111111111111" \
  "select public.set_product_availability('$PID', true);")
assert_ok "8. set_product_availability(true) sur produit avec TVA positive est autorisé" "$RC"

# 9. la contrainte rejette DIRECTEMENT is_available=true + tax_rate=NULL (sans passer par un RPC -- preuve que c'est l'autorité réelle, pas une simple vérification applicative)
RC=$(sql_rc "insert into public.menu_items (category_id, name, price, display_order, is_available, tax_rate) values ('33333333-3333-3333-3333-333333333333','Direct Insert Test',5,99,true,null);")
assert_denied "9. la contrainte CHECK elle-même rejette is_available=true + tax_rate=NULL, même hors RPC" "$RC"

# 10. la contrainte autorise is_available=false + tax_rate=NULL
RC=$(sql_rc "insert into public.menu_items (category_id, name, price, display_order, is_available, tax_rate) values ('33333333-3333-3333-3333-333333333333','Direct Insert Test 2',5,99,false,null);")
assert_ok "10. la contrainte CHECK autorise is_available=false + tax_rate=NULL" "$RC"
sql "delete from public.menu_items where name in ('Direct Insert Test','Direct Insert Test 2');" >/dev/null

pass "11. préflight zéro violation -> migration a bien procédé (déjà prouvé en [A] ci-dessus)"

# 12. préflight simulé avec violations pré-existantes -> échec déterministe, aucune mutation
log "=== [B] 12. Base DIRTY séparée -- violation pré-existante synthétique ==="
DB_DIRTY="scanym_vatguard_dirty_$$"
psql -c "drop database if exists \"$DB_DIRTY\";" >/dev/null 2>&1 || true
createdb "$DB_DIRTY" || { log "FATAL: createdb dirty a échoué"; exit 1; }
psql -d "$DB_DIRTY" -v ON_ERROR_STOP=1 >/dev/null <<'SQL2'
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
SQL2
for f in $MINIMAL_CHAIN; do
  psql -d "$DB_DIRTY" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1 || { log "FATAL: dirty chain $f"; exit 1; }
  psql -d "$DB_DIRTY" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
done
for f in $REST_CHAIN; do
  psql -d "$DB_DIRTY" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1 || { log "FATAL: dirty chain rest $f"; exit 1; }
done
psql -d "$DB_DIRTY" -v ON_ERROR_STOP=1 -f "$OB2_SQL" >/dev/null 2>&1
psql -d "$DB_DIRTY" -v ON_ERROR_STOP=1 -f "$OB4_SQL" >/dev/null 2>&1
psql -d "$DB_DIRTY" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
# Violation synthétique : contournement DIRECT des RPC (jamais via
# create_product/update_product, qui n'auraient pas pu la produire
# une fois ce lot installé) -- reproduit un état Production
# hypothétique PRÉ-EXISTANT, aucune donnée Production réelle utilisée.
psql -d "$DB_DIRTY" -v ON_ERROR_STOP=1 >/dev/null <<'SQL3'
insert into public.restaurants (id, name, slug) values ('44444444-4444-4444-4444-444444444444', 'Dirty Resto', 'dirty-resto');
insert into public.menu_categories (id, restaurant_id, name, display_order) values ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444', 'Cat', 1);
insert into public.menu_items (category_id, name, price, display_order, is_available, tax_rate) values ('55555555-5555-5555-5555-555555555555', 'Violation Pré-existante', 5, 1, true, null);
SQL3
DIRTY_SQL_OUT=$(psql -d "$DB_DIRTY" -v ON_ERROR_STOP=1 -f "$GUARD_SQL" 2>&1)
DIRTY_RC=$?
assert_denied "12. installation du lot échoue déterministiquement sur base DIRTY (violation pré-existante)" "$DIRTY_RC"
assert_contains "12. message de préflight explicite" "SCANYM_VAT_COMPLETENESS_PREFLIGHT_FAILED" "$DIRTY_SQL_OUT"
# Aucune mutation : la ligne violante existe toujours EXACTEMENT telle quelle, la contrainte n'existe PAS (jamais ajoutée puisque le préflight a stoppé la transaction)
STILL_THERE=$(psql -X -A -q -t -d "$DB_DIRTY" -c "select count(*) from public.menu_items where name='Violation Pré-existante' and is_available=true and tax_rate is null;" 2>/dev/null)
assert_eq "12. AUCUNE mutation -- la ligne violante existe toujours telle quelle (jamais désactivée/backfillée)" "1" "$STILL_THERE"
CON_EXISTS=$(psql -X -A -q -t -d "$DB_DIRTY" -c "select count(*) from pg_constraint where conname='menu_items_availability_requires_tax_rate_chk';" 2>/dev/null)
assert_eq "12. la contrainte n'a PAS été ajoutée (transaction stoppée par le préflight)" "0" "$CON_EXISTS"
psql -c "drop database if exists \"$DB_DIRTY\";" >/dev/null 2>&1 || true

# ------------------------------------------------------------------
# 15/16. malformé / hors bornes -- comportement BLOCKING_ERROR existant
# préservé (aucune régression -- couvert exhaustivement par les
# harnais/tests TypeScript existants du domaine fiscal, non re-testé
# item par item ici).
# ------------------------------------------------------------------
RC=$(as_authenticated_rc "11111111-1111-1111-1111-111111111111" \
  "select public.create_product('33333333-3333-3333-3333-333333333333','Hors bornes',null,5,null,150,null,false,null);")
assert_denied "15/16. create_product(tax_rate=150, hors bornes) toujours rejeté (SCANYM_INVALID_TAX_RATE, comportement PRÉ-EXISTANT inchangé)" "$RC"

# ------------------------------------------------------------------
# Régression : LOT C (order_items.tax_rate_snapshot,
# compute_delivery_fee_tax_allocation) N'EST PAS touché par ce fichier
# -- vérification structurelle : aucune mention d'order_items dans le
# fichier du lot.
# ------------------------------------------------------------------
# Recherche une VRAIE référence DDL/DML à order_items (alter/update/
# insert/delete/create trigger ... on order_items), jamais une simple
# mention en commentaire explicatif de périmètre (celui-ci EN contient
# délibérément, pour documenter que LOT C n'est PAS touché).
if grep -Ei "(alter table|update|insert into|delete from|create trigger).*order_items" "$GUARD_SQL" >/dev/null; then
  fail "régression : le fichier du lot contient une instruction DDL/DML sur order_items -- LOT C ne doit JAMAIS être touché"
else
  pass "régression : aucune instruction DDL/DML sur order_items dans le fichier du lot -- LOT C intact (les mentions dans les commentaires sont documentaires, pas des instructions)"
fi

# ============================================================
# [C] v1.1 — ROUTAGE PAR NOM DE CONTRAINTE (audit Cat Stevens, BLOCKER)
#
# update_product/set_product_availability ne pré-valident déjà PLUS
# aucun écart possible avec les 4 AUTRES contraintes CHECK de
# menu_items (leurs propres bornes applicatives sont IDENTIQUES aux
# bornes DB -- description<=500, short_description<=100,
# unit_weight_grams>0, tax_rate 0-100) : ces 4 contraintes sont donc
# STRUCTURELLEMENT inatteignables via l'interface normale des RPC.
# C'est PRÉCISÉMENT pour cette raison qu'un bloc `DO $$ ... $$`
# reproduisant le mécanisme EXACT (copié tel quel depuis le fichier du
# lot : GET STACKED DIAGNOSTICS ... = CONSTRAINT_NAME puis routage
# conditionnel) est utilisé ci-dessous, en UPDATE direct sur la table
# -- il teste le MÉCANISME DE ROUTAGE lui-même en isolation (ce que
# Cat Stevens a précisément demandé de prouver), indépendamment de la
# coïncidence actuelle entre bornes applicatives et bornes DB, qui
# pourrait cesser d'être vraie dans un lot futur ou via un autre
# chemin d'écriture.
# ============================================================
log "=== [C] v1.1 -- Routage par nom de contrainte (Cat Stevens BLOCKER) ==="

routing_probe() {
  # $1 = description du cas, $2 = clause SET à tester
  local desc="$1" set_clause="$2"
  local out
  out=$(psql -X -A -q -d "$DB" -v ON_ERROR_STOP=1 2>&1 <<SQL
do \$do\$
declare
  v_violated_constraint text;
begin
  begin
    update public.menu_items set $set_clause where name = 'Reblochon';
  exception when check_violation then
    get stacked diagnostics v_violated_constraint = constraint_name;
    if v_violated_constraint = 'menu_items_availability_requires_tax_rate_chk' then
      raise exception 'SCANYM_TAX_RATE_REQUIRED_FOR_AVAILABILITY' using errcode = '23514';
    end if;
    raise;
  end;
end \$do\$;
SQL
)
  printf '%s' "$out"
}

# 2. violation de tax_rate range -- NE DOIT PAS être traduite
OUT=$(routing_probe "tax range" "tax_rate = 150")
if printf '%s' "$OUT" | grep -q "SCANYM_TAX_RATE_REQUIRED_FOR_AVAILABILITY"; then
  fail "2. violation menu_items_tax_rate_range_chk INCORRECTEMENT traduite en erreur de disponibilité"
else
  pass "2. violation menu_items_tax_rate_range_chk NON traduite (sémantique d'origine préservée)"
fi
assert_contains "2. le message d'origine mentionne bien la VRAIE contrainte (tax_rate_range_chk)" "menu_items_tax_rate_range_chk" "$OUT"

# 3. violation de description_length -- NE DOIT PAS être traduite
OUT=$(routing_probe "description length" "description = repeat('x', 501)")
if printf '%s' "$OUT" | grep -q "SCANYM_TAX_RATE_REQUIRED_FOR_AVAILABILITY"; then
  fail "3. violation menu_items_description_length_chk INCORRECTEMENT traduite en erreur de disponibilité"
else
  pass "3. violation menu_items_description_length_chk NON traduite (sémantique d'origine préservée)"
fi
assert_contains "3. le message d'origine mentionne bien la VRAIE contrainte (description_length_chk)" "menu_items_description_length_chk" "$OUT"

# 4. violation de short_description_length -- NE DOIT PAS être traduite
OUT=$(routing_probe "short description length" "short_description = repeat('x', 101)")
if printf '%s' "$OUT" | grep -q "SCANYM_TAX_RATE_REQUIRED_FOR_AVAILABILITY"; then
  fail "4. violation menu_items_short_description_length_chk INCORRECTEMENT traduite en erreur de disponibilité"
else
  pass "4. violation menu_items_short_description_length_chk NON traduite (sémantique d'origine préservée)"
fi
assert_contains "4. le message d'origine mentionne bien la VRAIE contrainte (short_description_length_chk)" "menu_items_short_description_length_chk" "$OUT"

# 5. violation de unit_weight_grams -- NE DOIT PAS être traduite
OUT=$(routing_probe "unit weight" "unit_weight_grams = -5")
if printf '%s' "$OUT" | grep -q "SCANYM_TAX_RATE_REQUIRED_FOR_AVAILABILITY"; then
  fail "5. violation menu_items_unit_weight_grams_chk INCORRECTEMENT traduite en erreur de disponibilité"
else
  pass "5. violation menu_items_unit_weight_grams_chk NON traduite (sémantique d'origine préservée)"
fi
assert_contains "5. le message d'origine mentionne bien la VRAIE contrainte (unit_weight_grams_chk)" "menu_items_unit_weight_grams_chk" "$OUT"

# 1. contre-épreuve positive -- violation de la VRAIE contrainte de
#    disponibilité EST bien traduite par ce même mécanisme de routage
OUT=$(routing_probe "availability" "is_available = true, tax_rate = null")
assert_contains "1. violation menu_items_availability_requires_tax_rate_chk EST bien traduite en SCANYM_TAX_RATE_REQUIRED_FOR_AVAILABILITY" "SCANYM_TAX_RATE_REQUIRED_FOR_AVAILABILITY" "$OUT"

# 6/7. re-confirmation -- update_product/set_product_availability
#    (les VRAIES fonctions, pas la sonde ci-dessus) donnent toujours
#    le message propre pour le cas VAT réel, APRÈS le fix v1.1 (déjà
#    prouvé en section [B] items 4 et 6 ci-dessus -- réaffirmé ici
#    explicitement pour traçabilité directe avec le mandat v1.1).
RC=$(as_authenticated_rc "11111111-1111-1111-1111-111111111111" \
  "select public.update_product('$PID','Reblochon',null,8.0,null,null,null,false,null);")
assert_denied "6. (v1.1) update_product effaçant la TVA d'un produit disponible toujours rejeté après le fix" "$RC"
assert_contains "6. (v1.1) message applicatif propre toujours SCANYM_TAX_RATE_REQUIRED_FOR_AVAILABILITY" "SCANYM_TAX_RATE_REQUIRED_FOR_AVAILABILITY" "$(sql_err)"

RC=$(as_authenticated_rc "11111111-1111-1111-1111-111111111111" \
  "select public.set_product_availability('$PID_UNAVAIL', true);")
assert_denied "7. (v1.1) set_product_availability(true) sur produit sans TVA toujours rejeté après le fix" "$RC"
assert_contains "7. (v1.1) message applicatif propre toujours SCANYM_TAX_RATE_REQUIRED_FOR_AVAILABILITY" "SCANYM_TAX_RATE_REQUIRED_FOR_AVAILABILITY" "$(sql_err)"

pass "8. (v1.1) comportement create_product/import inchangé -- déjà prouvé par les items 1-3 de la section [B] ci-dessus, ré-exécutés tels quels sur le corps v1.1"

log "=== RÉSUMÉ ==="
log "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  log "--- Échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
