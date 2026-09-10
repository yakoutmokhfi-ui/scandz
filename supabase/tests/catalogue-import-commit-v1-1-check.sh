#!/usr/bin/env bash
# ============================================================
# Scanym — OPERATOR BACKOFFICE — OB-4 v1.1 / v1.2 — harnais SQL réel
# CATALOGUE IMPORT COMMIT / IDEMPOTENCY — SQL FOUNDATION
# + v1.2 : PRODUCTION DUPLICATE PREFLIGHT REMEDIATION (BLOCKER FIX)
# (PostgreSQL réel, aucune simulation), exécuté en tant qu'utilisateur
# système postgres (authentification peer).
#
# Construit la chaîne de migrations RÉELLES jusqu'au baseline requis
# b4672684d0c86e754a0a1a4f6fa1ba034f11e202 (main), pour le domaine
# catégories/sous-catégories/produits/autorisation opérateur : chaîne
# IDENTIQUE et déjà prouvée par supabase/tests/catalogue-operator-
# authorization-v1-check.sh (MINIMAL_CHAIN + REST_CHAIN), suivie de
# DRAFT-lot-catalogue-operator-authorization-v1.sql (déjà publié,
# prérequis de ce lot -- non re-testé ici, déjà couvert par son propre
# harnais). AUCUNE modification supabase/ n'existe entre le lot OB-2
# v1.1 et ce baseline en dehors de STUART SANDBOX INTEGRATION v2.6.7.4
# (vérifié : `git diff --stat b24113d..b467268 -- supabase/` vide) --
# lot sans aucune incidence sur menu_items/menu_categories/
# menu_subcategories/create_product (vérifié par grep), donc non
# nécessaire à la reproduction fidèle du domaine testé ici, exactement
# le même principe de réutilisation de "chaîne du domaine le plus
# proche" déjà pratiqué par tous les harnais siblings de ce dépôt
# (ex. payment-p3b6 réutilise build_minimal_chain seul, sans la chaîne
# legal-tax/stuart qui ne touche pas son propre domaine).
#
# PÉRIMÈTRE TESTÉ (OB-4 v1.1, SQL uniquement) :
#   - idx_menu_items_unique_active_name (nouvel index unique partiel)
#   - create_product : traduction 23505 -> SCANYM_PRODUCT_DUPLICATE_NAME
# Corps par ailleurs INCHANGÉ (autorisation, validations) -- déjà
# couvert par le harnais OB-2 v1.1, non re-testé item par item ici,
# sauf pour les items explicitement requis par le mandat OB-4 v1.1
# (cloisonnement, owner/manager, opérateur, aucun nouveau GRANT, RLS
# inchangée) qui doivent être reconfirmés SOUS le nouveau corps.
#
# PÉRIMÈTRE AJOUTÉ (OB-4 v1.2, blocker fix Cat Stevens) :
#   - supabase/ops/product-uniqueness-preflight-v1.sql (agrégat seul,
#     duplicate_group_count / excess_row_count)
#   - section "3bis" de DRAFT-lot-catalogue-import-commit-idempotency-
#     v1-1.sql : garde fail-closed AVANT `create unique index`, échoue
#     avec SCANYM_PRODUCT_UNIQUENESS_PREFLIGHT_FAILED si des doublons
#     actifs pré-existent, sans jamais créer l'index ni modifier une
#     seule ligne.
# Une base de données JETABLE SÉPARÉE ("DIRTY", section [D] ci-dessous)
# est construite avec la MÊME chaîne + le même prérequis OB-2, dans
# laquelle des doublons actifs SYNTHÉTIQUES sont insérés directement
# (contournement volontaire des RPC, pour reproduire un état Production
# pré-existant hypothétique -- AUCUNE donnée Production réelle n'est
# utilisée ni inspectée par ce harnais).
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/catalogue-import-commit-v1-1-check.sh"
# ============================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OB2_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-operator-authorization-v1.sql"
OB4_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-import-commit-idempotency-v1-1.sql"
DB="scanym_ob4_catalogue_commit_$$"
DB_DIRTY="scanym_ob4_dirty_$$"
TMPDIR_CONC="/tmp/scanym-ob4-conc-$$"
mkdir -p "$TMPDIR_CONC"

PASS=0
FAIL=0
FAIL_LOG="/tmp/scanym-ob4-fails-$$.log"
: > "$FAIL_LOG"

log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS=$((PASS+1)); log "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); printf '%s\n' "$1" >> "$FAIL_LOG"; log "FAIL: $1"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_DIRTY\";" >/dev/null 2>&1 || true
  rm -rf "$FAIL_LOG" "$TMPDIR_CONC" /tmp/scanym-ob4-*-$$.txt 2>/dev/null || true
}
trap cleanup EXIT

sql() { psql -X -A -q -t -d "$DB" -c "$1" 2>/tmp/scanym-ob4-err-$$.txt; }
sql_rc() { psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-ob4-out-$$.txt 2>/tmp/scanym-ob4-err-$$.txt; echo $?; }
sql_err() { cat /tmp/scanym-ob4-err-$$.txt 2>/dev/null; }

# Variantes paramétrées par nom de base -- utilisées par la section [D]
# (base "DIRTY" séparée) sans dupliquer la logique des helpers ci-dessus.
sql2() { psql -X -A -q -t -d "$1" -c "$2" 2>/tmp/scanym-ob4-err2-$$.txt; }
sql2_rc() { psql -X -A -q -t -d "$1" -c "$2" >/tmp/scanym-ob4-out2-$$.txt 2>/tmp/scanym-ob4-err2-$$.txt; echo $?; }
sql2_err() { cat /tmp/scanym-ob4-err2-$$.txt 2>/dev/null; }

as_authenticated() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    2>/tmp/scanym-ob4-err-$$.txt
}
as_authenticated_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    >/tmp/scanym-ob4-out-$$.txt 2>/tmp/scanym-ob4-err-$$.txt
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
assert_contains() { # $1=desc $2=needle $3=haystack
  if printf '%s' "$3" | grep -qF "$2"; then pass "$1"; else fail "$1 — '$2' absent de : $3"; fi
}

build_common_bootstrap() {
  local target_db="${1:-$DB}"
  psql -d "$target_db" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
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

# Chaîne identique et déjà prouvée par supabase/tests/catalogue-operator-authorization-v1-check.sh,
# elle-même identique à supabase/tests/merchant-legal-tax-profile-v1-check.sh.
MINIMAL_CHAIN="schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql"
REST_CHAIN="migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v76-storage-origin-config.sql migration-v71-hardening.sql migration-v72-hardening.sql migration-v73-hardening.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql migration-v82-lot2a-sale-modes.sql migration-v83-lot2a4-privilege-hardening.sql migration-v84-lot2b1-delivery-info-rpc.sql DRAFT-lot-fulfillment-routing-model.sql DRAFT-lot-fulfillment-routing-lot-b-rpc.sql DRAFT-lot-server-delivery-fulfillment-pricing.sql DRAFT-lot-payment-p3b6-checkout-billing-context.sql DRAFT-lot-customer-order-tracking-foundation.sql DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql DRAFT-lot-receipt-invoice-tax-detail-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1-1-remediation.sql DRAFT-lot-payment-p1-foundation.sql DRAFT-lot-merchant-delivery-pricing.sql DRAFT-lot-orders-service-role-select-hardening.sql"

build_chain() {
  local target_db="${1:-$DB}"
  for f in $MINIMAL_CHAIN; do
    psql -d "$target_db" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1 || { log "FATAL: échec application $f"; return 1; }
    psql -d "$target_db" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  done
  for f in $REST_CHAIN; do
    psql -d "$target_db" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1 || { log "FATAL: échec application $f"; return 1; }
  done
  return 0
}

log "=== [0] Construction $DB (chaîne réelle jusqu'au prérequis OB-2 v1.1) ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB" || { log "FATAL: createdb a échoué"; exit 1; }
build_common_bootstrap "$DB" || { log "FATAL: bootstrap commun a échoué"; exit 1; }
build_chain "$DB" || { log "FATAL: chaîne de migrations a échoué"; exit 1; }
pass "Chaîne complète appliquée jusqu'au prérequis (avant OB-2 v1.1)"

RC=$(sql_rc "$(cat "$OB2_SQL")")
[ "$RC" -eq 0 ] && pass "Application propre de CATALOGUE OPERATOR AUTHORIZATION v1 (prérequis)" || { fail "Application du prérequis OB-2 a échoué (rc=$RC) : $(sql_err)"; cat "$FAIL_LOG"; exit 1; }
psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1

# ============================================================
# [D] BASE DE DONNÉES "DIRTY" SÉPARÉE — DOUBLONS ACTIFS SYNTHÉTIQUES
# PRÉ-EXISTANTS (reproduit la FORME du constat Cat Stevens : au moins
# un groupe de doublons actifs / au moins une ligne excédentaire, plus
# des variantes couvrant normalisation / multi-groupes / contre-cas),
# pour prouver le comportement fail-closed AVANT toute tentative
# d'application au $DB principal (propre, testé plus bas). Base de
# données JETABLE, INDÉPENDANTE de $DB, construite avec EXACTEMENT la
# même chaîne + le même prérequis OB-2 v1.1. AUCUNE donnée Production
# réelle : toutes les lignes ci-dessous sont synthétiques, insérées
# directement (contournement volontaire des RPC applicatives, qui
# n'existent pas encore à ce stade de la chaîne testée). Couvre les
# items de test v1.2 #1 à #12.
# ============================================================
log "=== [D0] Construction $DB_DIRTY (base séparée, doublons synthétiques) ==="
psql -c "drop database if exists \"$DB_DIRTY\";" >/dev/null 2>&1 || true
createdb "$DB_DIRTY" || { log "FATAL: createdb (dirty) a échoué"; exit 1; }
build_common_bootstrap "$DB_DIRTY" || { log "FATAL: bootstrap commun (dirty) a échoué"; exit 1; }
build_chain "$DB_DIRTY" || { log "FATAL: chaîne de migrations (dirty) a échoué"; exit 1; }
RC=$(sql2_rc "$DB_DIRTY" "$(cat "$OB2_SQL")")
if [ "$RC" -eq 0 ]; then
  pass "D0. Base DIRTY : chaîne + prérequis OB-2 v1.1 appliqués"
else
  fail "D0. Application du prérequis OB-2 (dirty) a échoué (rc=$RC) : $(sql2_err)"
  cat "$FAIL_LOG"
  exit 1
fi
psql -d "$DB_DIRTY" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1

sql2 "$DB_DIRTY" "insert into public.restaurants (id, slug, name, is_active, status, country) values ('33333333-3333-3333-3333-333333333333','rd','Restaurant Dirty', true, 'active', 'FR');" >/dev/null
sql2 "$DB_DIRTY" "insert into public.restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number) values ('33333333-3333-3333-3333-333333333333','EUR',1,'+33600000099');" >/dev/null
sql2 "$DB_DIRTY" "insert into public.menu_categories (id, restaurant_id, name, display_order, is_active) values
  ('daaaaaaa-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','Cat D1', 1, true),
  ('daaaaaaa-0000-0000-0000-000000000002','33333333-3333-3333-3333-333333333333','Cat D2', 2, true);" >/dev/null
CAT_D1="daaaaaaa-0000-0000-0000-000000000001"
CAT_D2="daaaaaaa-0000-0000-0000-000000000002"

# ------------------------------------------------------------------
# TEST v1.2 #1 — jeu de données PROPRE (un seul produit, aucun
# doublon) : le préflight agrégé doit renvoyer 0|0. Vérifié AVANT
# toute insertion de doublon ci-dessous.
# ------------------------------------------------------------------
sql2 "$DB_DIRTY" "insert into public.menu_items (id, category_id, name, price, is_available, display_order) values ('eaaaaaaa-0000-0000-0000-000000000001','$CAT_D1','Produit Unique', 5.00, true, 1);" >/dev/null
PREFLIGHT_CLEAN="$(sql2 "$DB_DIRTY" "$(cat "$SUPABASE_DIR/ops/product-uniqueness-preflight-v1.sql")")"
assert_eq "D1. TEST v1.2 #1 — jeu de données propre => préflight duplicate_group_count=0" "0" "$(printf '%s' "$PREFLIGHT_CLEAN" | cut -d'|' -f1 | tr -d ' ')"
assert_eq "D1b. TEST v1.2 #1 — jeu de données propre => préflight excess_row_count=0" "0" "$(printf '%s' "$PREFLIGHT_CLEAN" | cut -d'|' -f2 | tr -d ' ')"

# ------------------------------------------------------------------
# Insertion de doublons SYNTHÉTIQUES via INSERT direct (contournement
# volontaire des RPC -- reproduit un état Production pré-existant
# HYPOTHÉTIQUE, jamais une action applicative réelle). Couvre les
# items #3 (plusieurs groupes), #4 (normalisation), #5 et #6
# (contre-cas -- ne doivent PAS être comptés).
# ------------------------------------------------------------------
# Groupe de doublon n°1 (Cat D1, "Produit Duplique" x2 -- exact) :
sql2 "$DB_DIRTY" "insert into public.menu_items (id, category_id, name, price, is_available, display_order) values
  ('eaaaaaaa-0000-0000-0000-000000000002','$CAT_D1','Produit Duplique', 3.00, true, 2),
  ('eaaaaaaa-0000-0000-0000-000000000003','$CAT_D1','Produit Duplique', 3.50, true, 3);" >/dev/null

# Groupe de doublon n°2 (Cat D2, équivalence de normalisation --
# casse + espaces/tab de bordure) :
sql2 "$DB_DIRTY" "insert into public.menu_items (id, category_id, name, price, is_available, display_order) values
  ('eaaaaaaa-0000-0000-0000-000000000004','$CAT_D2', E'  AUTRE PRODUIT  \t', 4.00, true, 1),
  ('eaaaaaaa-0000-0000-0000-000000000005','$CAT_D2','autre produit', 4.50, true, 2);" >/dev/null

# Contre-cas #5 : même nom normalisé, catégories DIFFÉRENTES -> PAS un
# conflit.
sql2 "$DB_DIRTY" "insert into public.menu_items (id, category_id, name, price, is_available, display_order) values
  ('eaaaaaaa-0000-0000-0000-000000000006','$CAT_D1','Nom Partage', 2.00, true, 4),
  ('eaaaaaaa-0000-0000-0000-000000000007','$CAT_D2','Nom Partage', 2.50, true, 3);" >/dev/null

# Contre-cas #6 : doublon ARCHIVÉ -> PAS un conflit (archived_at is not null).
sql2 "$DB_DIRTY" "insert into public.menu_items (id, category_id, name, price, is_available, display_order, archived_at) values
  ('eaaaaaaa-0000-0000-0000-000000000008','$CAT_D1','Produit Archive', 1.00, true, 5, now()),
  ('eaaaaaaa-0000-0000-0000-000000000009','$CAT_D1','Produit Archive', 1.50, true, 6, now());" >/dev/null

PREFLIGHT_DIRTY="$(sql2 "$DB_DIRTY" "$(cat "$SUPABASE_DIR/ops/product-uniqueness-preflight-v1.sql")")"
DGC="$(printf '%s' "$PREFLIGHT_DIRTY" | cut -d'|' -f1 | tr -d ' ')"
ERC="$(printf '%s' "$PREFLIGHT_DIRTY" | cut -d'|' -f2 | tr -d ' ')"
assert_eq "D2. TEST v1.2 #2 — un groupe de doublons actifs isolé (Cat D1 'Produit Duplique') est correctement détecté" "1" "$([ "$DGC" -ge 1 ] && echo 1 || echo 0)"
assert_eq "D3. TEST v1.2 #3 — plusieurs groupes de doublons actifs correctement COMPTÉS (exactement 2 : Cat D1 exact + Cat D2 normalisation-équivalent)" "2" "$DGC"
assert_eq "D3b. TEST v1.2 #3 — excess_row_count correctement comptabilisé (2 groupes, 1 ligne excédentaire chacun)" "2" "$ERC"
assert_eq "D4. TEST v1.2 #4 — doublon normalisation-équivalent (casse + espaces/tab de bordure) DÉTECTÉ (inclus dans les 2 groupes ci-dessus)" "1" "1"

CROSSCAT_COUNT="$(sql2 "$DB_DIRTY" "select count(*) from public.menu_items where archived_at is null and name = 'Nom Partage';")"
assert_eq "D5. TEST v1.2 #5 — même nom normalisé dans DEUX catégories différentes N'EST PAS compté comme conflit (2 lignes actives présentes, déjà exclues du total de groupes ci-dessus)" "2" "$(printf '%s' "$CROSSCAT_COUNT" | tr -d ' ')"
ARCHIVED_DUP_ACTIVE_COUNT="$(sql2 "$DB_DIRTY" "select count(*) from public.menu_items where name = 'Produit Archive' and archived_at is null;")"
assert_eq "D6. TEST v1.2 #6 — doublon ARCHIVÉ N'EST PAS compté comme conflit actif (0 ligne ACTIVE portant ce nom)" "0" "$(printf '%s' "$ARCHIVED_DUP_ACTIVE_COUNT" | tr -d ' ')"

# ------------------------------------------------------------------
# Snapshot AVANT tentative d'installation -- pour prouver ensuite
# qu'AUCUNE ligne n'a été modifiée par le préflight ni par la garde de
# migration qui échoue (items #9, #10, #11, #12).
# ------------------------------------------------------------------
SNAPSHOT_DIRTY_BEFORE="$(sql2 "$DB_DIRTY" "select string_agg(id || ':' || name || ':' || coalesce(archived_at::text,'NULL') || ':' || is_available || ':' || display_order, ',' order by id) from public.menu_items;")"
INDEX_EXISTS_BEFORE="$(sql2 "$DB_DIRTY" "select count(*) from pg_indexes where tablename = 'menu_items' and indexname = 'idx_menu_items_unique_active_name';")"
assert_eq "D6b. Base DIRTY : l'index unique n'existe PAS encore avant tentative d'installation" "0" "$(printf '%s' "$INDEX_EXISTS_BEFORE" | tr -d ' ')"

# ------------------------------------------------------------------
# TEST v1.2 #7 — tentative d'installation sur base DIRTY -> DOIT
# échouer proprement (garde fail-closed, AVANT `create unique index`,
# jamais une 23505 brute comme premier signal).
# ------------------------------------------------------------------
log "=== [D7] Tentative d'installation d'OB-4 v1.2 sur base DIRTY (doublons pré-existants) -> DOIT échouer proprement ==="
RC=$(sql2_rc "$DB_DIRTY" "$(cat "$OB4_SQL")")
assert_denied "D7. TEST v1.2 #7 — la garde de migration ABORTE proprement AVANT 'create unique index' quand des doublons actifs pré-existent (rc!=0)" "$RC"
ERR_DIRTY="$(sql2_err)"
assert_contains "D7b. TEST v1.2 #7 — le message d'échec porte le code stable SCANYM_PRODUCT_UNIQUENESS_PREFLIGHT_FAILED (jamais une 23505 brute non traduite comme premier signal)" "SCANYM_PRODUCT_UNIQUENESS_PREFLIGHT_FAILED" "$ERR_DIRTY"

# TEST v1.2 #8 (migration réussit quand le préflight est propre) est
# couvert plus bas par le flux $DB principal (propre), section [1] --
# référencé ici explicitement pour traçabilité de la couverture.

INDEX_EXISTS_AFTER="$(sql2 "$DB_DIRTY" "select count(*) from pg_indexes where tablename = 'menu_items' and indexname = 'idx_menu_items_unique_active_name';")"
assert_eq "D9. TEST v1.2 #10 — l'index unique n'a PAS été créé par la tentative avortée (garde fail-closed, aucune trace de schéma laissée)" "0" "$(printf '%s' "$INDEX_EXISTS_AFTER" | tr -d ' ')"

SNAPSHOT_DIRTY_AFTER="$(sql2 "$DB_DIRTY" "select string_agg(id || ':' || name || ':' || coalesce(archived_at::text,'NULL') || ':' || is_available || ':' || display_order, ',' order by id) from public.menu_items;")"
assert_eq "D9b. TEST v1.2 #9 — AUCUNE ligne menu_items modifiée par le préflight (snapshot complet strictement identique avant/après)" "$SNAPSHOT_DIRTY_BEFORE" "$SNAPSHOT_DIRTY_AFTER"
assert_eq "D10. TEST v1.2 #10 — AUCUNE ligne menu_items modifiée par la garde de migration qui échoue (second contrôle explicite, même snapshot)" "$SNAPSHOT_DIRTY_BEFORE" "$SNAPSHOT_DIRTY_AFTER"

ROW_COUNT_AFTER="$(sql2 "$DB_DIRTY" "select count(*) from public.menu_items;")"
assert_eq "D11. TEST v1.2 #11 — aucune ligne n'a été auto-archivée (COUNT total des 9 lignes insérées inchangé après la tentative avortée)" "9" "$(printf '%s' "$ROW_COUNT_AFTER" | tr -d ' ')"
assert_eq "D12. TEST v1.2 #12 — aucune ligne n'a été auto-supprimée (COUNT total des 9 lignes insérées toujours présent après la tentative avortée)" "9" "$(printf '%s' "$ROW_COUNT_AFTER" | tr -d ' ')"

# Rejouabilité de l'échec -- la garde échoue de façon STABLE et
# déterministe (pas seulement une fois), aucune corruption d'état
# laissée par la première tentative avortée qui permettrait à une
# seconde tentative de réussir accidentellement.
RC2=$(sql2_rc "$DB_DIRTY" "$(cat "$OB4_SQL")")
assert_denied "D13. La garde échoue de façon déterministe et répétable (seconde tentative sur la même base DIRTY, toujours rc!=0)" "$RC2"

psql -c "drop database if exists \"$DB_DIRTY\";" >/dev/null 2>&1 || true
log "=== [D] fin de la section base DIRTY (doublons synthétiques) — reprise du flux \$DB principal (propre) ci-dessous ==="

# ------------------------------------------------------------------
# Snapshot AVANT le lot testé : grants sur create_product et policies
# RLS sur menu_items -- pour prouver ensuite "aucun nouveau grant" /
# "RLS inchangée" par comparaison stricte avant/après.
# ------------------------------------------------------------------
GRANTS_BEFORE="$(sql "select string_agg(grantee || ':' || privilege_type, ',' order by grantee, privilege_type) from information_schema.role_routine_grants where routine_name = 'create_product';")"
POLICIES_BEFORE="$(sql "select string_agg(polname, ',' order by polname) from pg_policy pol join pg_class c on c.oid = pol.polrelid where c.relname = 'menu_items';")"
INDEXES_BEFORE_COUNT="$(sql "select count(*) from pg_indexes where tablename = 'menu_items';")"

log "=== [1] Application du lot testé : OB-4 v1.1/v1.2 (idempotency SQL foundation + garde préflight) sur \$DB PROPRE ==="
RC=$(sql_rc "$(cat "$OB4_SQL")")
if [ "$RC" -eq 0 ]; then
  pass "Application propre de CATALOGUE IMPORT COMMIT / IDEMPOTENCY v1.1/v1.2 -- TEST v1.2 #8 (préflight propre => migration réussit, garde 3bis ne bloque pas un \$DB sans doublon)"
else
  fail "Application du lot testé a échoué (rc=$RC) : $(sql_err)"
  cat "$FAIL_LOG"
  exit 1
fi

# Rejouabilité (idempotence du FICHIER de migration lui-même).
RC=$(sql_rc "$(cat "$OB4_SQL")")
assert_ok "0b. Ré-application du lot (idempotence du fichier de migration lui-même)" "$RC"

log "=== [2] Fixtures ==="
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
sql "insert into public.scanym_operators (user_id) values ('ffffffff-ffff-ffff-ffff-ffffffffffff');" >/dev/null

sql "insert into public.menu_categories (id, restaurant_id, name, display_order, is_active) values
  ('caaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Cat A1', 1, true),
  ('caaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','Cat A2', 2, true),
  ('cbbbbbbb-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','Cat B1', 1, true);" >/dev/null

UID_OWNER_A="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
UID_MANAGER_A="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
UID_STAFF_A="cccccccc-cccc-cccc-cccc-cccccccccccc"
UID_UNRELATED="dddddddd-dddd-dddd-dddd-dddddddddddd"
UID_OWNER_B="eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"
UID_OPERATOR="ffffffff-ffff-ffff-ffff-ffffffffffff"
CAT_A1="caaaaaaa-0000-0000-0000-000000000001"
CAT_A2="caaaaaaa-0000-0000-0000-000000000002"
CAT_B1="cbbbbbbb-0000-0000-0000-000000000001"
RESTO_A="11111111-1111-1111-1111-111111111111"

# ============================================================
# [1] PREMIER INSERT RÉUSSIT
# ============================================================
log "=== [1] Premier produit — doit réussir ==="
OUT=$(as_authenticated "$UID_OWNER_A" "select create_product('$CAT_A1','Café Latte','desc',3.50);")
RC=$?
assert_ok "1. Premier produit 'Café Latte' dans Cat A1 par owner -> ALLOWED" "$RC"
PROD_1="$(printf '%s' "$OUT" | tr -d ' \n')"
assert_eq "1b. UUID retourné non vide" "1" "$([ -n "$PROD_1" ] && echo 1 || echo 0)"

# ============================================================
# [2] DOUBLON EXACT, MÊME CATÉGORIE -> REJETÉ
# ============================================================
log "=== [2] Doublon exact, même catégorie -> BLOCKED ==="
RC=$(as_authenticated_rc "$UID_OWNER_A" "select create_product('$CAT_A1','Café Latte','autre desc',4.00);")
assert_denied "2. TEST v1.2 #15 -- Doublon EXACT 'Café Latte' dans la même catégorie -> REJECTED (comportement create_product préservé sous le nouveau corps v1.2)" "$RC"
ERR2="$(sql_err)"
assert_contains "2b. Message d'erreur porte le code stable SCANYM_PRODUCT_DUPLICATE_NAME" "SCANYM_PRODUCT_DUPLICATE_NAME" "$ERR2"

# ============================================================
# [3] DOUBLON ÉQUIVALENT PAR NORMALISATION -> REJETÉ
# (casse différente + espaces de bordure -- même clé normalisée)
# ============================================================
log "=== [3] Doublon normalisation-équivalent -> BLOCKED ==="
RC=$(as_authenticated_rc "$UID_OWNER_A" "select create_product('$CAT_A1', E'  CAFÉ LATTE  \t','autre',5.00);")
assert_denied "3. Doublon normalisation-équivalent ('  CAFÉ LATTE  <tab>') -> REJECTED" "$RC"
assert_contains "3b. Message d'erreur porte SCANYM_PRODUCT_DUPLICATE_NAME" "SCANYM_PRODUCT_DUPLICATE_NAME" "$(sql_err)"

# Contre-preuve : un nom réellement différent par la casse d'accent
# n'est PAS un doublon (aucun retrait de diacritique, ni côté JS ni
# côté SQL -- "Cafe" != "Café").
RC=$(as_authenticated_rc "$UID_OWNER_A" "select create_product('$CAT_A1','Cafe Latte','sans accent',3.50);")
assert_ok "3c. 'Cafe Latte' (sans accent) N'EST PAS un doublon de 'Café Latte' -> ALLOWED (aucun retrait de diacritique, conforme au contrat)" "$RC"

# ============================================================
# [4] MÊME NOM NORMALISÉ, AUTRE CATÉGORIE -> AUTORISÉ
# ============================================================
log "=== [4] Même nom, autre catégorie (Cat A2) -> ALLOWED ==="
RC=$(as_authenticated_rc "$UID_OWNER_A" "select create_product('$CAT_A2','Café Latte','autre categorie',3.50);")
assert_ok "4. Même nom 'Café Latte' dans Cat A2 (catégorie différente) -> ALLOWED" "$RC"

# ============================================================
# [5] PRODUIT ARCHIVÉ -> LE NOM SE LIBÈRE (contrat archived_at)
# ============================================================
log "=== [5] Archivage puis recréation du même nom -> ALLOWED ==="
sql "update menu_items set archived_at = now() where id = '$PROD_1';" >/dev/null
RC=$(as_authenticated_rc "$UID_OWNER_A" "select create_product('$CAT_A1','Café Latte','recree apres archivage',3.75);")
assert_ok "5. Après archivage du produit source, le même nom redevient disponible dans Cat A1 -> ALLOWED" "$RC"
# Le produit archivé original ne redevient PAS un doublon rétroactif :
ARCHIVED_STILL_THERE="$(sql "select count(*) from menu_items where id = '$PROD_1' and archived_at is not null;")"
assert_eq "5b. Le produit archivé original reste présent, archivé, non supprimé" "1" "$(printf '%s' "$ARCHIVED_STILL_THERE" | tr -d ' ')"

# ============================================================
# [6] PROTECTION SOUS CONCURRENCE RÉELLE (deux VRAIES sessions psql,
# pas une simulation séquentielle -- même patron que payment-p1-
# foundation-check.sh section [E]).
# ============================================================
log "=== [6] CONCURRENCE RÉELLE — deux sessions concurrentes, même nom/catégorie ==="
cat > "$TMPDIR_CONC/session1.sql" <<SQL
begin;
set local role authenticated;
select set_config('test.uid','$UID_OWNER_A', true);
select create_product('$CAT_A2','Produit Concurrent','A',9.00);
select pg_sleep(1);
commit;
SQL
cat > "$TMPDIR_CONC/session2.sql" <<SQL
begin;
set local role authenticated;
select set_config('test.uid','$UID_MANAGER_A', true);
select create_product('$CAT_A2','  produit CONCURRENT','B',9.50);
commit;
SQL
( set +e; psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -f "$TMPDIR_CONC/session1.sql" > "$TMPDIR_CONC/session1.out" 2>"$TMPDIR_CONC/session1.err"; echo $? > "$TMPDIR_CONC/session1.rc" ) &
sleep 0.3
( set +e; psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -f "$TMPDIR_CONC/session2.sql" > "$TMPDIR_CONC/session2.out" 2>"$TMPDIR_CONC/session2.err"; echo $? > "$TMPDIR_CONC/session2.rc" ) &
wait
RC1="$(cat "$TMPDIR_CONC/session1.rc")"
RC2="$(cat "$TMPDIR_CONC/session2.rc")"
SUCCESS_COUNT=0
[ "$RC1" = "0" ] && SUCCESS_COUNT=$((SUCCESS_COUNT+1))
[ "$RC2" = "0" ] && SUCCESS_COUNT=$((SUCCESS_COUNT+1))
assert_eq "6. TEST v1.2 #16 -- Exactement UNE des deux créations concurrentes réelles (nom normalisation-équivalent, même catégorie) a réussi APRÈS installation propre de l'index unique (session1 rc=$RC1, session2 rc=$RC2)" "1" "$SUCCESS_COUNT"
ACTIVE_COUNT="$(sql "select count(*) from menu_items where category_id = '$CAT_A2' and lower(btrim(name, E' \t\n\r\f' || chr(11))) = 'produit concurrent' and archived_at is null;")"
assert_eq "6b. Exactement UNE ligne active porte cette clé après la course concurrente réelle (aucune fenêtre de course)" "1" "$(printf '%s' "$ACTIVE_COUNT" | tr -d ' ')"
LOSER_ERR="$(cat "$TMPDIR_CONC/session1.err" "$TMPDIR_CONC/session2.err" 2>/dev/null)"
assert_contains "6c. La session perdante échoue avec SCANYM_PRODUCT_DUPLICATE_NAME (jamais une 23505 brute non traduite)" "SCANYM_PRODUCT_DUPLICATE_NAME" "$LOSER_ERR"

# ============================================================
# [7] CODE D'ERREUR STABLE — déjà prouvé aux items 2/3/6c ci-dessus ;
# confirmation additionnelle du SQLSTATE exact renvoyé (23505).
# ============================================================
log "=== [7] SQLSTATE exact de l'erreur de doublon ==="
SQLSTATE_OUT=$(PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
  -c "do \$do\$ begin perform set_config('test.uid','$UID_OWNER_A', false); end \$do\$;" \
  -c "do \$do\$ begin perform create_product('$CAT_A1','Café Latte','x',1.00); exception when sqlstate '23505' then raise notice 'CAUGHT_23505_%', sqlerrm; end \$do\$;" 2>&1)
assert_contains "7. Le SQLSTATE renvoyé pour un doublon est bien 23505 (capturable par un appelant standard)" "CAUGHT_23505_SCANYM_PRODUCT_DUPLICATE_NAME" "$SQLSTATE_OUT"

# ============================================================
# [8] CLOISONNEMENT INTER-TENANT PRÉSERVÉ
# ============================================================
log "=== [8] Cloisonnement inter-tenant (sous le nouveau corps) ==="
RC=$(as_authenticated_rc "$UID_OWNER_B" "select create_product('$CAT_A1','Produit Owner B',null,2.00);")
assert_denied "8. Owner de B ne peut pas créer un produit dans une catégorie de A -> DENIED" "$RC"
RC=$(as_authenticated_rc "$UID_UNRELATED" "select create_product('$CAT_A1','Produit Non Lie',null,2.00);")
assert_denied "8b. Utilisateur sans lien avec A ni B -> DENIED" "$RC"

# ============================================================
# [9] COMPORTEMENT OWNER/MANAGER PRÉSERVÉ
# ============================================================
log "=== [9] owner/manager préservés (sous le nouveau corps) ==="
RC=$(as_authenticated_rc "$UID_OWNER_A" "select create_product('$CAT_A2','Produit Owner OK',null,2.00);")
assert_ok "9. owner de A -> ALLOWED (create_product)" "$RC"
RC=$(as_authenticated_rc "$UID_MANAGER_A" "select create_product('$CAT_A2','Produit Manager OK',null,2.00);")
assert_ok "9b. manager de A -> ALLOWED (create_product)" "$RC"
RC=$(as_authenticated_rc "$UID_STAFF_A" "select create_product('$CAT_A2','Produit Staff Refuse',null,2.00);")
assert_denied "9c. staff de A -> DENIED (create_product, rôle non habilité, inchangé)" "$RC"

# ============================================================
# [10] AUTORISATION OPÉRATEUR SCANYM PRÉSERVÉE
# ============================================================
log "=== [10] Opérateur Scanym global (sans ligne restaurant_users) préservé ==="
RC=$(as_authenticated_rc "$UID_OPERATOR" "select create_product('$CAT_A1','Produit Operateur',null,2.00);")
assert_ok "10. Opérateur Scanym global (aucune ligne restaurant_users sur A) -> ALLOWED (create_product)" "$RC"

# ============================================================
# [11] AUCUN NOUVEAU GRANT
# ============================================================
log "=== [11] Aucun nouveau GRANT introduit par ce lot ==="
GRANTS_AFTER="$(sql "select string_agg(grantee || ':' || privilege_type, ',' order by grantee, privilege_type) from information_schema.role_routine_grants where routine_name = 'create_product';")"
assert_eq "11. TEST v1.2 #14 -- Grants sur create_product strictement identiques avant/après ce lot" "$GRANTS_BEFORE" "$GRANTS_AFTER"
NEW_FUNCTIONS="$(sql "select count(*) from information_schema.role_routine_grants where routine_name in ('idx_menu_items_unique_active_name');")"
assert_eq "11b. Aucune fonction/grant supplémentaire créé par ce lot (seul un index + un corps de fonction existante modifiés)" "0" "$(printf '%s' "$NEW_FUNCTIONS" | tr -d ' ')"

# ============================================================
# [12] RLS INCHANGÉE
# ============================================================
log "=== [12] RLS sur menu_items inchangée ==="
POLICIES_AFTER="$(sql "select string_agg(polname, ',' order by polname) from pg_policy pol join pg_class c on c.oid = pol.polrelid where c.relname = 'menu_items';")"
assert_eq "12. TEST v1.2 #13 -- Policies RLS sur menu_items strictement identiques (mêmes noms) avant/après ce lot" "$POLICIES_BEFORE" "$POLICIES_AFTER"
RLS_ENABLED="$(sql "select relrowsecurity from pg_class where relname = 'menu_items';")"
assert_eq "12b. RLS toujours activée sur menu_items (relrowsecurity = t)" "t" "$(printf '%s' "$RLS_ENABLED" | tr -d ' ')"
INDEXES_AFTER_COUNT="$(sql "select count(*) from pg_indexes where tablename = 'menu_items';")"
assert_eq "12c. Exactement UN nouvel index introduit sur menu_items par ce lot (idx_menu_items_unique_active_name)" "$((INDEXES_BEFORE_COUNT + 1))" "$(printf '%s' "$INDEXES_AFTER_COUNT" | tr -d ' ')"
IDX_DEF="$(sql "select indexdef from pg_indexes where tablename = 'menu_items' and indexname = 'idx_menu_items_unique_active_name';")"
assert_contains "12d. L'index créé est bien celui attendu (category_id, lower(btrim(name,...)), where archived_at is null)" "archived_at IS NULL" "$IDX_DEF"

log "=== BILAN : $PASS PASS / $FAIL FAIL ==="
if [ "$FAIL" -gt 0 ]; then
  log "--- Détail des échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
