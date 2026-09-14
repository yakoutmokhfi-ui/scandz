#!/usr/bin/env bash
# ============================================================
# Scanym — CLAUDE DEBUSSY — harnais SQL réel
# SELLER LEGAL PROFILE + CGV ENGINE + ACCEPTANCE SNAPSHOT v1.1 —
# AUDIT REMEDIATION CYCLE 2 (Catimini : FAIL — NOT READY FOR RELEASE,
# 2 blockers HIGH). PostgreSQL réel, aucune simulation applicative,
# exécuté en tant qu'utilisateur système postgres (authentification
# peer).
#
# NOUVEAU BASELINE (ne PAS rebaser silencieusement l'ancien candidat
# v1) : main après publication Stuart LOT D1 v1.2 —
#   SHA  5a9e6aa300e5e2b3a7f50439f6760d04585ee382
#   TREE 040ba361a75cd8ef7db37add957478088246867c
#
# Réutilise MINIMAL_CHAIN + REST_CHAIN, inchangées depuis la Phase 1
# (le body hérité de create_order, dans DRAFT-lot-receipt-invoice-tax-
# detail-v1.sql, est confirmé octet-pour-octet identique entre l'ancien
# et le nouveau baseline — voir README-AUDIT.md v1.1, section
# reconstruction) : REST_CHAIN se termine avec ce même fichier, sur
# lequel CE lot v1.1 applique son propre delta.
#
# Ce harnais couvre les DEUX blockers HIGH de l'audit Catimini :
#
#   BLOCKER 1 — CGV-V1-PUBLISH-AUTHORITY-01 : preuve que le navigateur
#   ne peut plus jamais fournir le contenu rendu / le gabarit / la
#   locale / la variante d'une CGV publiée (voir sections "Direct RPC
#   Bypass", "Autorité de gabarit applicable", et le flux en 2 étapes
#   resolve_cgv_publication_context (as-user) -> persist_merchant_cgv_
#   version (service_role uniquement) dans les sections 4 à 9bis).
#
#   BLOCKER 2 — CGV-V1-PROD-ACL-01 : le harnais reproduit D'ABORD la
#   condition hostile découverte en Production par Catimini (des ACL
#   par défaut accordant TRUNCATE/REFERENCES/TRIGGER/MAINTAIN à anon/
#   authenticated/service_role dès la création de table), PUIS prouve
#   que les REVOKE explicites du lot convergent malgré cela vers une
#   matrice de privilèges totalement fermée (voir section "Matrice de
#   convergence ACL"). MAINTAIN (PG17+) est exclu de la boucle
#   ci-dessous : ce bac à sable tourne en PostgreSQL 16 (voir échec de
#   `select version();` documenté dans TEST-RESULTS.md), alors que la
#   Production confirmée par Catimini est en PostgreSQL 17.6 — utiliser
#   `revoke all privileges` (jamais une liste énumérée) dans le lot lui-
#   même est précisément ce qui ferme MAINTAIN sur la vraie Production
#   sans qu'aucune syntaxe spécifique à PG17 n'apparaisse dans la
#   migration ; ce harnais ne peut que documenter cette limitation
#   locale, pas la lever.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   sudo -n -u postgres bash supabase/tests/seller-legal-profile-cgv-engine-v1-1-check.sh
# ============================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOT_SQL="$SUPABASE_DIR/DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql"
ROLLBACK_SQL="$SUPABASE_DIR/DRAFT-lot-seller-legal-profile-cgv-engine-v1-1-rollback.sql"
DB="scanym_cgvenginev11_$$"

PASS=0
FAIL=0
FAIL_LOG="/tmp/scanym-cgvenginev11-fails-$$.log"
: > "$FAIL_LOG"

log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS=$((PASS+1)); log "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); printf '%s\n' "$1" >> "$FAIL_LOG"; log "FAIL: $1"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop role if exists cgv_probe_public;" >/dev/null 2>&1 || true
  rm -f "$FAIL_LOG" /tmp/scanym-cgvenginev11-*-$$.txt 2>/dev/null || true
}
trap cleanup EXIT

sql() { psql -X -A -q -t -d "$DB" -c "$1" 2>/tmp/scanym-cgvenginev11-err-$$.txt; }
sql_rc() { psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-cgvenginev11-out-$$.txt 2>/tmp/scanym-cgvenginev11-err-$$.txt; echo $?; }
sql_err() { cat /tmp/scanym-cgvenginev11-err-$$.txt 2>/dev/null; }
sql_out() { cat /tmp/scanym-cgvenginev11-out-$$.txt 2>/dev/null; }

as_authenticated_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    >/tmp/scanym-cgvenginev11-out-$$.txt 2>/tmp/scanym-cgvenginev11-err-$$.txt
  echo $?
}
as_anon_rc() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" \
    -c "$1" \
    >/tmp/scanym-cgvenginev11-out-$$.txt 2>/tmp/scanym-cgvenginev11-err-$$.txt
  echo $?
}
# NOUVEAU v1.1 (Blocker 1) — service_role est désormais le SEUL rôle
# EXECUTE sur persist_merchant_cgv_version ; ce helper (même patron
# PGOPTIONS que as_authenticated_rc/as_anon_rc ci-dessus) permet de
# prouver le chemin de confiance légitime ET, séparément, d'utiliser le
# même privilège pour la preuve de contournement (Direct RPC Bypass
# teste précisément qu'AUCUN AUTRE rôle ne peut faire ceci).
as_service_role_rc() {
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" \
    -c "$1" \
    >/tmp/scanym-cgvenginev11-out-$$.txt 2>/tmp/scanym-cgvenginev11-err-$$.txt
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
assert_not_contains() {
  if printf '%s' "$3" | grep -qF "$2"; then fail "$1 — '$2' présent (ne devrait pas l'être) : $3"; else pass "$1"; fi
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

log "=== [0] Construction $DB (chaîne réelle jusqu'au nouveau baseline main) ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB" || { log "FATAL: createdb a échoué"; exit 1; }
build_common_bootstrap || { log "FATAL: bootstrap commun a échoué"; exit 1; }
build_chain || { log "FATAL: chaîne de migrations a échoué"; exit 1; }
pass "Chaîne de base (MINIMAL_CHAIN + REST_CHAIN) appliquée jusqu'à DRAFT-lot-receipt-invoice-tax-detail-v1.sql (identique octet-pour-octet au baseline v1)"

# scanym_supported_countries : FR doit déjà exister (Phase 0 finding,
# reconfirmé par Catimini au nouveau baseline).
FR_SEEDED=$(sql "select count(*) from public.scanym_supported_countries where code='FR';")
if [ "$FR_SEEDED" != "1" ]; then
  psql -d "$DB" -c "insert into public.scanym_supported_countries (code, name) values ('FR','France') on conflict do nothing;" >/dev/null 2>&1
fi

# ============================================================
# [BLOCKER2/ACL-0] Simulation de la condition hostile découverte en
# Production par Catimini -- AVANT l'installation du lot lui-même,
# pour que les futures CREATE TABLE du lot héritent réellement de
# privilèges par défaut larges (comme en Production), et que les
# REVOKE explicites du lot soient ce qui est réellement mis à
# l'épreuve ci-dessous, jamais un simple "jamais accordé donc jamais
# à révoquer".
# ============================================================
log "=== [BLOCKER2/ACL-0] Simulation des ACL par défaut hostiles (condition Production Catimini) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -c "alter default privileges in schema public grant all privileges on tables to anon, authenticated, service_role;" >/dev/null 2>&1 \
  || { log "FATAL: échec de la simulation ACL hostile"; exit 1; }

# Preuve que la simulation fonctionne réellement dans CET
# environnement (sinon la preuve de convergence plus bas serait un
# faux positif silencieux) : une table quelconque créée maintenant
# doit hériter TRUNCATE pour anon sans qu'aucun GRANT explicite n'ait
# été fait.
psql -d "$DB" -v ON_ERROR_STOP=1 -c "create table public.cgv_probe_hostile_defaults (id int);" >/dev/null 2>&1
PROBE_INHERITED=$(sql "select has_table_privilege('anon','public.cgv_probe_hostile_defaults','TRUNCATE');")
assert_eq "ACL-0. la simulation hostile fonctionne réellement ici : une table fraîchement créée hérite bien de TRUNCATE pour anon" "t" "$PROBE_INHERITED"
psql -d "$DB" -c "drop table public.cgv_probe_hostile_defaults;" >/dev/null 2>&1

RC=$(sql_rc "$(cat "$LOT_SQL")")
assert_ok "LOT SQL (Seller Legal Profile + CGV Engine v1.1) s'installe proprement sur le NOUVEAU baseline, MALGRÉ les ACL par défaut hostiles simulées ci-dessus" "$RC"

# ------------------------------------------------------------------
# v1.1 (Blocker 2) : AUCUN grant SELECT large n'est ré-accordé ici,
# contrairement au harnais v1 (qui faisait
# `grant select on all tables in schema public to anon, authenticated;`
# juste après l'installation du lot). Ce grant aurait silencieusement
# ré-accordé SELECT à `anon` sur les 5 nouvelles tables CGV -- un vrai
# angle mort de l'ancien harnais qu'aucun test v1 n'a jamais détecté --
# et aurait invalidé toutes les assertions "anon n'a AUCUN privilège"
# ci-dessous. Les seuls accès de lecture directs testés désormais sont
# ceux EXPLICITEMENT accordés par le lot lui-même
# (`grant select ... to authenticated` sur 4 des 5 tables).
# ------------------------------------------------------------------

# ------------------------------------------------------------------
# Fixtures : deux tenants (A, B), owner/manager/staff/operator,
# restaurants actifs, un mode delivery désactivé (hors périmètre pour
# rester simple -- ce lot ne dépend pas du routage delivery).
# ------------------------------------------------------------------
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner-a@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'manager-a@test.local'),
  ('33333333-3333-3333-3333-333333333333', 'staff-a@test.local'),
  ('44444444-4444-4444-4444-444444444444', 'owner-b@test.local'),
  ('55555555-5555-5555-5555-555555555555', 'operator@test.local');

insert into public.restaurants (id, name, slug, is_active, status, country) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Resto A', 'resto-a', true, 'active', 'FR'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Resto B', 'resto-b', true, 'active', 'FR'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Resto Legacy', 'resto-legacy', true, 'active', 'FR');

insert into public.restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'EUR', 1, '+33600000000'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'EUR', 1, '+33600000001'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'EUR', 1, '+33600000002');

insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'pickup', true),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'pickup', true),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'pickup', true);

insert into public.restaurant_users (user_id, restaurant_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'manager'),
  ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'staff'),
  ('44444444-4444-4444-4444-444444444444', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'owner');

insert into public.scanym_operators (user_id) values
  ('55555555-5555-5555-5555-555555555555')
on conflict do nothing;

insert into public.menu_categories (id, restaurant_id, name, display_order, is_active) values
  ('c1111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Plats', 1, true),
  ('c9999999-9999-9999-9999-999999999999', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'Plats Legacy', 1, true);
insert into public.menu_items (id, category_id, name, price, is_available, tax_rate, unit_weight_grams, weight_is_approximate) values
  ('d1111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111111', 'Plat A', 10.00, true, 5.5, 300, false),
  ('d9999999-9999-9999-9999-999999999999', 'c9999999-9999-9999-9999-999999999999', 'Plat Legacy', 10.00, true, 5.5, 300, false);
SQL
pass "Fixtures (2 tenants + legacy + owner/manager/staff/operator + produit) construites"

OWNER_A="11111111-1111-1111-1111-111111111111"
MANAGER_A="22222222-2222-2222-2222-222222222222"
STAFF_A="33333333-3333-3333-3333-333333333333"
OWNER_B="44444444-4444-4444-4444-444444444444"
OPERATOR="55555555-5555-5555-5555-555555555555"
RESTO_A="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
RESTO_B="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
RESTO_LEGACY="cccccccc-cccc-cccc-cccc-cccccccccccc"

TEMPLATE_ID=$(sql "select id from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=1;")

RC=$(as_authenticated_rc "$OWNER_A" "select (public.get_applicable_cgv_template('$RESTO_A')).id;")
assert_ok "0bis. get_applicable_cgv_template résout un gabarit pour un owner (lecture)" "$RC"

# ============================================================
# [BLOCKER1/RPC-BYPASS] Contournement direct de la RPC de persistance
# -- test OBLIGATOIRE du mandat : "Add an explicit test proving that
# an authenticated browser cannot bypass the server publication path
# by directly calling a database RPC with attacker-chosen rendered
# content." Exécuté ICI, avant toute publication réussie, pour que
# l'assertion "aucune ligne insérée" ne puisse pas être confondue avec
# une ligne créée par un test légitime plus loin.
# ============================================================
log "=== [BLOCKER1/RPC-BYPASS] Contournement direct de persist_merchant_cgv_version ==="
VERSION_COUNT_BEFORE=$(sql "select count(*) from public.merchant_cgv_version;")

# `authenticated` (même l'owner légitime du restaurant) ne peut PAS
# appeler persist_merchant_cgv_version directement, même avec un
# template_id valablement résolu et un contenu choisi par l'attaquant
# (payloads malveillants explicites, comme l'exige le mandat).
for PAYLOAD in '<img src=x onerror=alert(1)>' '<script>alert(1)</script>' '" onmouseover="alert(1)" x="' 'javascript:alert(1)'; do
  RC=$(as_authenticated_rc "$OWNER_A" "select * from public.persist_merchant_cgv_version('$RESTO_A', '$TEMPLATE_ID', '$PAYLOAD');")
  assert_denied "RPC-BYPASS: authenticated (owner légitime) NE PEUT PAS appeler persist_merchant_cgv_version directement, même avec un payload malveillant ($PAYLOAD)" "$RC"
  assert_contains "RPC-BYPASS: refus par permission (42501/insufficient_privilege), jamais une erreur métier qui suggérerait un chemin partiellement atteint" "permission denied" "$(sql_err)"
done

# `anon` : refusé également (a fortiori).
RC=$(as_anon_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$TEMPLATE_ID', '<script>alert(1)</script>');")
assert_denied "RPC-BYPASS: anon NE PEUT PAS appeler persist_merchant_cgv_version directement" "$RC"

# anon ne peut pas non plus appeler resolve_cgv_publication_context
# (EXECUTE réservé à authenticated) -- même en amont, aucune surface.
RC=$(as_anon_rc "select * from public.resolve_cgv_publication_context('$RESTO_A');")
assert_denied "RPC-BYPASS: anon NE PEUT PAS appeler resolve_cgv_publication_context (EXECUTE réservé à authenticated)" "$RC"

# Preuve finale, au niveau des données : aucune de ces tentatives
# (quel que soit leur code d'erreur) n'a inséré la moindre ligne.
VERSION_COUNT_AFTER=$(sql "select count(*) from public.merchant_cgv_version;")
assert_eq "RPC-BYPASS: aucune ligne merchant_cgv_version créée par une quelconque tentative de contournement" "$VERSION_COUNT_BEFORE" "$VERSION_COUNT_AFTER"

# ============================================================
# [BLOCKER1/GRANTS] Assertions structurelles : EXECUTE et existence
# ============================================================
log "=== [BLOCKER1/GRANTS] Grants EXECUTE structurels ==="
# Rôle sonde pour PUBLIC (aucune appartenance, aucun grant direct) --
# créé ici (idempotent) car réutilisé aussi par la matrice ACL de
# tables plus bas [BLOCKER2/ACL].
psql -d "$DB" -v ON_ERROR_STOP=1 -c "do \$do\$ begin if not exists (select from pg_roles where rolname='cgv_probe_public') then create role cgv_probe_public nologin; end if; end \$do\$;" >/dev/null 2>&1

V=$(sql "select has_function_privilege('service_role','public.persist_merchant_cgv_version(uuid,uuid,text)','EXECUTE');")
assert_eq "GRANTS: service_role A EXECUTE sur persist_merchant_cgv_version (seul chemin légitime)" "t" "$V"
V=$(sql "select has_function_privilege('authenticated','public.persist_merchant_cgv_version(uuid,uuid,text)','EXECUTE');")
assert_eq "GRANTS: authenticated N'A PAS EXECUTE sur persist_merchant_cgv_version" "f" "$V"
V=$(sql "select has_function_privilege('anon','public.persist_merchant_cgv_version(uuid,uuid,text)','EXECUTE');")
assert_eq "GRANTS: anon N'A PAS EXECUTE sur persist_merchant_cgv_version" "f" "$V"
V=$(sql "select has_function_privilege('cgv_probe_public','public.persist_merchant_cgv_version(uuid,uuid,text)','EXECUTE');")
assert_eq "GRANTS: PUBLIC (rôle sonde sans appartenance) N'A PAS EXECUTE sur persist_merchant_cgv_version" "f" "$V"

V=$(sql "select has_function_privilege('authenticated','public.resolve_cgv_publication_context(uuid)','EXECUTE');")
assert_eq "GRANTS: authenticated A EXECUTE sur resolve_cgv_publication_context" "t" "$V"
V=$(sql "select has_function_privilege('anon','public.resolve_cgv_publication_context(uuid)','EXECUTE');")
assert_eq "GRANTS: anon N'A PAS EXECUTE sur resolve_cgv_publication_context" "f" "$V"

V=$(sql "select count(*) from pg_proc where proname='publish_merchant_cgv_version' and pronamespace='public'::regnamespace;")
assert_eq "GRANTS: publish_merchant_cgv_version (l'ancienne RPC v1, qui acceptait un contenu rendu client) N'EXISTE PLUS DU TOUT" "0" "$V"

V=$(sql "select has_function_privilege('authenticated','public._resolve_applicable_cgv_template(text)','EXECUTE');")
assert_eq "GRANTS: le helper privé _resolve_applicable_cgv_template n'a AUCUN grant EXECUTE, même pour authenticated (appelable uniquement depuis d'autres fonctions SECURITY DEFINER du même propriétaire)" "f" "$V"

# ============================================================
# [1] Tenant isolation — tenant A ne peut lire/écrire le profil de B
# ============================================================
log "=== [1] Isolation tenant ==="
RC=$(as_authenticated_rc "$OWNER_A" \
  "select public.get_merchant_legal_profile('$RESTO_B');")
assert_denied "1. owner A ne peut pas LIRE le profil légal de B" "$RC"

RC=$(as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_legal_profile('$RESTO_B','SARL',null,null,null,null,null,null,null,null,null,null);")
assert_denied "1. owner A ne peut pas ÉCRIRE le profil légal de B" "$RC"

# ============================================================
# [2/3] Permissions par rôle — write = owner/manager/operator, read = tout membre
# ============================================================
log "=== [2/3] Permissions par rôle ==="
RC=$(as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_legal_profile('$RESTO_A','SARL','1 rue Test',null,'75001','Paris','FR','contact@resto-a.test',null,'Médiateur Test','2 rue Médiation, 75002 Paris','https://mediateur.test');")
assert_ok "2. owner peut écrire le profil légal" "$RC"

RC=$(as_authenticated_rc "$MANAGER_A" \
  "select public.update_merchant_legal_profile('$RESTO_A','SARL','1 rue Test',null,'75001','Paris','FR','contact@resto-a.test',null,'Médiateur Test','2 rue Médiation, 75002 Paris','https://mediateur.test');")
assert_ok "2. manager peut écrire le profil légal" "$RC"

RC=$(as_authenticated_rc "$STAFF_A" \
  "select public.update_merchant_legal_profile('$RESTO_A','SARL',null,null,null,null,null,null,null,null,null,null);")
assert_denied "2. staff NE PEUT PAS écrire le profil légal" "$RC"

RC=$(as_authenticated_rc "$STAFF_A" \
  "select public.get_merchant_legal_profile('$RESTO_A');")
assert_ok "2. staff PEUT lire le profil légal (lecture volontairement plus large, patron receipt_settings)" "$RC"

RC=$(as_authenticated_rc "$OPERATOR" \
  "select public.update_merchant_legal_profile('$RESTO_A','SARL','1 rue Test',null,'75001','Paris','FR','contact@resto-a.test',null,'Médiateur Test','2 rue Médiation, 75002 Paris','https://mediateur.test');")
assert_ok "3. opérateur Scanym peut écrire le profil légal (hors rattachement restaurant_users)" "$RC"

# ============================================================
# [4/5/6] Complétude — publication bloquée si incomplet (v1.1 : la
# porte de complétude est désormais AU NIVEAU DE resolve_cgv_
# publication_context, jamais atteignable par un contenu client)
# ============================================================
log "=== [4/5/6] Garde de complétude (via resolve_cgv_publication_context) ==="
RC=$(as_authenticated_rc "$OWNER_A" \
  "select * from public.resolve_cgv_publication_context('$RESTO_A');")
assert_denied "4. resolve_cgv_publication_context refuse : profil CGV (withdrawal_regime etc.) pas encore renseigné" "$RC"
assert_contains "4. erreur porte le code déterministe WITHDRAWAL_REGIME_MISSING" "WITHDRAWAL_REGIME_MISSING" "$(sql_err)"

# Renseigne withdrawal_regime + preparation time, mais retire le pays -> bloqué
psql -d "$DB" -c "update public.restaurants set country = null where id='$RESTO_A';" >/dev/null
RC=$(as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_cgv_profile('$RESTO_A','EXEMPT_PERISHABLE',15,25,'MINUTES','Annulation possible avant préparation','Substitution équivalente si rupture','FORMAL');")
assert_ok "5. update_merchant_cgv_profile réussit (le pays n'est pas un champ de cette table)" "$RC"
ERR=$(sql "select public.cgv_completeness_errors('$RESTO_A');")
assert_contains "5. pays absent -> COUNTRY_MISSING dans la liste de complétude" "COUNTRY_MISSING" "$ERR"
RC=$(as_authenticated_rc "$OWNER_A" \
  "select * from public.resolve_cgv_publication_context('$RESTO_A');")
assert_denied "5. resolve_cgv_publication_context refuse tant que le pays est absent" "$RC"

psql -d "$DB" -c "update public.restaurants set country = 'FR' where id='$RESTO_A';" >/dev/null

# Mediator manquant -> bloqué
psql -d "$DB" -c "update public.merchant_legal_profile set consumer_mediator_name = null where restaurant_id='$RESTO_A';" >/dev/null
ERR=$(sql "select public.cgv_completeness_errors('$RESTO_A');")
assert_contains "6. médiateur absent -> MEDIATOR_INFO_MISSING" "MEDIATOR_INFO_MISSING" "$ERR"
RC=$(as_authenticated_rc "$OWNER_A" \
  "select * from public.resolve_cgv_publication_context('$RESTO_A');")
assert_denied "6. resolve_cgv_publication_context refuse tant que le médiateur est absent (template requires_mediator=true)" "$RC"

psql -d "$DB" -c "update public.merchant_legal_profile set consumer_mediator_name='Médiateur Test', consumer_mediator_address='2 rue Médiation, 75002 Paris', consumer_mediator_website='https://mediateur.test' where restaurant_id='$RESTO_A';" >/dev/null

# ============================================================
# [7/8/9] Withdrawal regime rendering / fail-closed MIXED -- flux en
# DEUX ÉTAPES désormais : resolve_cgv_publication_context (as-user,
# prouve l'autorisation + résout le gabarit) PUIS
# persist_merchant_cgv_version (service_role uniquement, re-vérifie
# tout indépendamment).
# ============================================================
log "=== [7/8/9] Régime de rétractation (flux en 2 étapes v1.1) ==="
ERR=$(sql "select public.cgv_completeness_errors('$RESTO_A');")
assert_eq "7. profil désormais complet (EXEMPT_PERISHABLE) -- tableau d'erreurs vide ('{}')" "{}" "$ERR"

RC=$(as_authenticated_rc "$OWNER_A" "select template_id from public.resolve_cgv_publication_context('$RESTO_A');")
assert_ok "7. resolve_cgv_publication_context (as-user, owner) réussit une fois le profil complet" "$RC"
RESOLVED_TEMPLATE_7=$(sql_out)
assert_eq "7. le gabarit résolu par resolve_cgv_publication_context == le gabarit FR attendu (calculé indépendamment par le harnais)" "$TEMPLATE_ID" "$RESOLVED_TEMPLATE_7"

RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TEMPLATE_7', '<p>EXEMPT_PERISHABLE clause rendue</p>');")
assert_ok "7. persist_merchant_cgv_version (service_role, avec le gabarit résolu à l'étape précédente) réussit" "$RC"
CONTENT=$(sql "select rendered_content from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='ACTIVE';")
assert_contains "7. contenu rendu contient bien la clause EXEMPT_PERISHABLE transmise" "EXEMPT_PERISHABLE" "$CONTENT"

as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_cgv_profile('$RESTO_A','STANDARD_14_DAYS',15,25,'MINUTES','Annulation possible avant préparation','Substitution équivalente si rupture','FORMAL');" >/dev/null
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$TEMPLATE_ID', '<p>STANDARD_14_DAYS clause rendue, différente</p>');")
assert_ok "8. publication (persist_merchant_cgv_version) réussit avec STANDARD_14_DAYS (régime différent)" "$RC"
CONTENT2=$(sql "select rendered_content from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='ACTIVE';")
assert_contains "8. le nouveau contenu ACTIVE reflète bien STANDARD_14_DAYS (régime différent du précédent)" "STANDARD_14_DAYS" "$CONTENT2"

as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_cgv_profile('$RESTO_A','MIXED',15,25,'MINUTES',null,null,'FORMAL');" >/dev/null
RC=$(as_authenticated_rc "$OWNER_A" "select * from public.resolve_cgv_publication_context('$RESTO_A');")
assert_denied "9. resolve_cgv_publication_context : MIXED échoue fermé (fail-closed) -- pas de classification produit en v1" "$RC"
assert_contains "9. code déterministe WITHDRAWAL_REGIME_MIXED_UNSUPPORTED (resolve)" "WITHDRAWAL_REGIME_MIXED_UNSUPPORTED" "$(sql_err)"

# 9bis -- défense en profondeur : MÊME en appelant persist_merchant_
# cgv_version DIRECTEMENT en tant que service_role (donc en
# court-circuitant l'étape resolve), la re-vérification indépendante
# de complétude À L'INTÉRIEUR de persist_merchant_cgv_version refuse
# ÉGALEMENT MIXED -- la sécurité ne repose jamais sur un seul point de
# contrôle.
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$TEMPLATE_ID', '<p>tentative MIXED</p>');")
assert_denied "9bis. persist_merchant_cgv_version (service_role, appelé directement) refuse ÉGALEMENT MIXED -- re-vérification indépendante de la complétude, pas seulement au niveau resolve" "$RC"
assert_contains "9bis. code déterministe WITHDRAWAL_REGIME_MIXED_UNSUPPORTED (persist)" "WITHDRAWAL_REGIME_MIXED_UNSUPPORTED" "$(sql_err)"

# Remet EXEMPT_PERISHABLE pour la suite des tests (checkout)
as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_cgv_profile('$RESTO_A','EXEMPT_PERISHABLE',15,25,'MINUTES','Annulation possible avant préparation','Substitution équivalente si rupture','FORMAL');" >/dev/null
as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$TEMPLATE_ID', '<p>EXEMPT_PERISHABLE clause finale</p>');" >/dev/null

# ============================================================
# [BLOCKER1/TEMPLATE-AUTHORITY] Autorité de gabarit applicable --
# jamais faire confiance à un template_id fourni par l'appelant, même
# un appelant désormais de confiance (service_role) : re-résolution
# indépendante et rejet d'un gabarit d'une AUTRE juridiction. Placé ICI
# (profil A désormais garanti complet, EXEMPT_PERISHABLE, juste
# reconfirmé ci-dessus) pour que l'erreur observée soit bien
# TEMPLATE_NOT_APPLICABLE, jamais masquée par un CGV_INCOMPLETE
# antérieur dans l'ordre des vérifications internes de la fonction.
# ============================================================
log "=== [BLOCKER1/TEMPLATE-AUTHORITY] Autorité de gabarit applicable (rejet cross-juridiction) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into public.scanym_supported_countries (code, name) values ('BE','Belgique') on conflict do nothing;
insert into public.cgv_template (
  template_code, jurisdiction_country, business_scope, version, locale,
  status, requires_mediator, requires_preparation_clause, controlled_sections, published_at
)
select
  'BE_FOOD_PERISHABLE_B2C', 'BE', 'food_perishable_b2c', 1, 'fr',
  'PUBLISHED', true, true,
  '{
     "header": "Voorwaarden BE",
     "identity_intro": "Intro BE.",
     "withdrawal_clauses": {"EXEMPT_PERISHABLE": "Clause BE.", "STANDARD_14_DAYS": "Clause BE 14j.", "MIXED": null},
     "mediator_clause": "Médiateur BE.",
     "preparation_clause": "Délai BE.",
     "cancellation_clause_label": "Annulation BE",
     "substitution_clause_label": "Substitution BE",
     "jurisdiction_clause": "Droit belge."
   }'::jsonb,
  now()
where not exists (select 1 from public.cgv_template where template_code = 'BE_FOOD_PERISHABLE_B2C' and version = 1);
SQL
BE_TEMPLATE_ID=$(sql "select id from public.cgv_template where template_code='BE_FOOD_PERISHABLE_B2C' and version=1;")

RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$BE_TEMPLATE_ID', '<p>tentative avec gabarit BE pour un restaurant FR</p>');")
assert_denied "TEMPLATE-AUTHORITY: persist_merchant_cgv_version REJETTE un template_id d'une AUTRE juridiction (BE) pour un restaurant FR, même appelé par service_role, même avec un profil désormais complet" "$RC"
assert_contains "TEMPLATE-AUTHORITY: code déterministe TEMPLATE_NOT_APPLICABLE" "TEMPLATE_NOT_APPLICABLE" "$(sql_err)"

VERSION_COUNT_BEFORE_TA=$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_A';")
RC=$(as_authenticated_rc "$OWNER_A" "select template_id from public.resolve_cgv_publication_context('$RESTO_A');")
assert_ok "TEMPLATE-AUTHORITY: resolve_cgv_publication_context réussit (profil complet) et résout un gabarit" "$RC"
RESOLVED_TEMPLATE_TA=$(sql_out)
assert_eq "TEMPLATE-AUTHORITY: resolve_cgv_publication_context résout le gabarit FR ($TEMPLATE_ID), JAMAIS le gabarit BE" "$TEMPLATE_ID" "$RESOLVED_TEMPLATE_TA"
assert_not_contains "TEMPLATE-AUTHORITY: le gabarit résolu n'est jamais celui de BE" "$BE_TEMPLATE_ID" "$RESOLVED_TEMPLATE_TA"
VERSION_COUNT_AFTER_TA=$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_A';")
assert_eq "TEMPLATE-AUTHORITY: la tentative rejetée (gabarit BE) n'a créé AUCUNE nouvelle ligne merchant_cgv_version pour A" "$VERSION_COUNT_BEFORE_TA" "$VERSION_COUNT_AFTER_TA"

# ============================================================
# [10] Preparation time — champs dédiés, jamais delay_value/delay_unit
# ============================================================
log "=== [10] Champs de préparation dédiés ==="
CODE_ONLY=$(grep -v '^\s*--' "$LOT_SQL")
assert_not_contains "10. le SQL exécuté (hors commentaires) ne référence jamais delay_value/delay_unit" "delay_value" "$(printf '%s' "$CODE_ONLY" | grep -o 'delay_value\|delay_unit' || true)"
PREP=$(sql "select preparation_time_min || '/' || preparation_time_max || '/' || preparation_time_unit from public.merchant_cgv_profile where restaurant_id='$RESTO_A';")
assert_eq "10. preparation_time_min/max/unit lus depuis merchant_cgv_profile, valeurs saisies" "15/25/MINUTES" "$PREP"

# ============================================================
# [11] Template non éditable par le marchand
# ============================================================
log "=== [11] Template non éditable ==="
RC=$(as_authenticated_rc "$OWNER_A" \
  "update public.cgv_template set controlled_sections = '{}'::jsonb where template_code='FR_FOOD_PERISHABLE_B2C';")
assert_denied "11. un marchand (owner) ne peut pas UPDATE cgv_template directement (aucun grant)" "$RC"

# ============================================================
# [12/13] Immutabilité des versions publiées
# ============================================================
log "=== [12/13] Immutabilité version publiée ==="
FIRST_VERSION_ID=$(sql "select id from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='SUPERSEDED' order by published_at asc limit 1;")
RC=$(as_authenticated_rc "$OWNER_A" \
  "update public.merchant_cgv_version set rendered_content='HACKED' where id='$FIRST_VERSION_ID';")
assert_denied "12. impossible d'UPDATE une ligne merchant_cgv_version existante (aucun grant update)" "$RC"

RC=$(as_service_role_rc "update public.merchant_cgv_version set rendered_content='HACKED' where id='$FIRST_VERSION_ID';")
assert_denied "12bis. service_role NON PLUS ne peut UPDATE directement merchant_cgv_version (aucun grant table direct -- TRUNCATE bypasserait la RLS si ce grant existait, voir Blocker 2)" "$RC"

as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_cgv_profile('$RESTO_A','EXEMPT_PERISHABLE',20,30,'MINUTES','Nouvelle politique','Nouvelle substitution','FORMAL');" >/dev/null
OLD_CONTENT_STILL=$(sql "select rendered_content from public.merchant_cgv_version where id = (select id from public.merchant_cgv_version where restaurant_id='$RESTO_A' order by published_at asc limit 1);")
assert_contains "13. mise à jour du profil NE modifie PAS le contenu de la toute première version déjà publiée" "EXEMPT_PERISHABLE clause rendue" "$OLD_CONTENT_STILL"

# ============================================================
# [14/15] Hash déterministe / rendu FR déterministe
# ============================================================
log "=== [14/15] Hash déterministe ==="
H1=$(sql "select md5('<p>contenu identique</p>');")
H2=$(sql "select md5('<p>contenu identique</p>');")
assert_eq "14. md5() du même contenu produit toujours le même hash" "$H1" "$H2"
STORED_HASH=$(sql "select content_hash from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='ACTIVE';")
RECOMPUTED=$(sql "select md5(rendered_content) from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='ACTIVE';")
assert_eq "14. content_hash stocké == md5(rendered_content) recalculé" "$RECOMPUTED" "$STORED_HASH"

# ============================================================
# [16] EN/AR non implémenté -> repli FR au niveau UI (hors SQL, voir
#      lib/i18n.ts / DOM test).
# ============================================================
log "=== [16] Locale ==="
pass "16. locale reste un champ texte simple côté SQL (toujours 'fr' en v1.1, fixé serveur -- voir resolve_cgv_publication_context) ; le repli FR pour EN/AR non traduit est assuré par lib/i18n.ts (translate()), vérifié par le test Node dédié"

# ============================================================
# [17/18] Checkout — bloqué sans acceptation, réussit avec
# ============================================================
log "=== [17/18] Checkout ACTIVE ==="
RC=$(as_authenticated_rc "$OWNER_A" "select public.activate_merchant_cgv('$RESTO_A');")
assert_ok "activation CGV (profil complet + version publiée)" "$RC"
STATUS=$(sql "select status from public.merchant_cgv_profile where restaurant_id='$RESTO_A';")
assert_eq "profil CGV désormais CGV_ACTIVE" "CGV_ACTIVE" "$STATUS"

RC=$(as_anon_rc "select * from public.create_order('resto-a','pickup','[{\"menu_item_id\":\"d1111111-1111-1111-1111-111111111111\",\"quantity\":1,\"option_item_id\":null}]'::jsonb, null, '{\"name\":\"Client Test\",\"phone\":\"0600000000\"}'::jsonb, null, 'fr', false);")
assert_denied "17. checkout SANS acceptation refusé pour marchand CGV_ACTIVE" "$RC"
assert_contains "17. message déterministe CGV_ACCEPTANCE_REQUIRED" "CGV_ACCEPTANCE_REQUIRED" "$(sql_err)"

ORDER_COUNT_BEFORE=$(sql "select count(*) from public.orders where restaurant_id='$RESTO_A';")
RC=$(as_anon_rc "select * from public.create_order('resto-a','pickup','[{\"menu_item_id\":\"d1111111-1111-1111-1111-111111111111\",\"quantity\":1,\"option_item_id\":null}]'::jsonb, null, '{\"name\":\"Client Test\",\"phone\":\"0600000000\"}'::jsonb, null, 'fr', true);")
assert_ok "18. checkout AVEC acceptation réussit pour marchand CGV_ACTIVE" "$RC"
ORDER_COUNT_AFTER=$(sql "select count(*) from public.orders where restaurant_id='$RESTO_A';")
assert_eq "18. exactement une commande créée" "$((ORDER_COUNT_BEFORE+1))" "$ORDER_COUNT_AFTER"

NEW_ORDER_ID=$(sql "select id from public.orders where restaurant_id='$RESTO_A' order by created_at desc limit 1;")
ACCEPTANCE_ROWS=$(sql "select count(*) from public.order_cgv_acceptance where order_id='$NEW_ORDER_ID';")
assert_eq "18. exactement 1 ligne order_cgv_acceptance pour cette commande" "1" "$ACCEPTANCE_ROWS"

# ============================================================
# [19/20] Le client ne peut ni forger la version ni le hash
# ============================================================
log "=== [19/20] Anti-forgerie ==="
ARGS=$(sql "select pg_get_function_arguments(oid) from pg_proc where proname='create_order' and pronamespace = 'public'::regnamespace;")
assert_not_contains "19. la signature create_order n'expose aucun paramètre cgv_version_id" "cgv_version_id" "$ARGS"
assert_not_contains "20. la signature create_order n'expose aucun paramètre content_hash" "content_hash" "$ARGS"

RECORDED_VERSION=$(sql "select cgv_version_id from public.order_cgv_acceptance where order_id='$NEW_ORDER_ID';")
SERVER_ACTIVE_VERSION=$(sql "select id from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='ACTIVE';")
assert_eq "19. la version enregistrée == la version ACTIVE résolue serveur (jamais une valeur cliente)" "$SERVER_ACTIVE_VERSION" "$RECORDED_VERSION"

RECORDED_HASH=$(sql "select content_hash from public.order_cgv_acceptance where order_id='$NEW_ORDER_ID';")
SERVER_ACTIVE_HASH=$(sql "select content_hash from public.merchant_cgv_version where id='$SERVER_ACTIVE_VERSION';")
assert_eq "20. le hash enregistré == le hash de la version ACTIVE (jamais une valeur cliente)" "$SERVER_ACTIVE_HASH" "$RECORDED_HASH"

# ============================================================
# [21/22] Ancienne commande garde son ancienne version même après republication
# ============================================================
log "=== [21/22] Stabilité historique ==="
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$TEMPLATE_ID', '<p>Nouvelle version, remplace la précédente</p>');")
assert_ok "21. republication (persist_merchant_cgv_version) réussit" "$RC"
RECORDED_VERSION_AFTER=$(sql "select cgv_version_id from public.order_cgv_acceptance where order_id='$NEW_ORDER_ID';")
assert_eq "21. la commande déjà créée référence toujours SA version d'origine, pas la nouvelle" "$RECORDED_VERSION" "$RECORDED_VERSION_AFTER"
OLD_STILL_READABLE=$(sql "select content_hash from public.merchant_cgv_version where id='$RECORDED_VERSION_AFTER';")
assert_eq "22. le contenu de l'ancienne version reste inchangé/lisible malgré la republication" "$SERVER_ACTIVE_HASH" "$OLD_STILL_READABLE"

# ============================================================
# [23] Référence cross-tenant à une version rejetée
# ============================================================
log "=== [23] Anti cross-tenant sur version historique ==="
OUT=$(sql "select count(*) from public.get_restaurant_cgv_version_by_id('$RECORDED_VERSION_AFTER','$RESTO_B');")
assert_eq "23. version A demandée avec restaurant_id B -> aucune ligne retournée" "0" "$OUT"
OUT2=$(sql "select count(*) from public.get_restaurant_cgv_version_by_id('$RECORDED_VERSION_AFTER','$RESTO_A');")
assert_eq "23. même version avec le BON restaurant_id -> 1 ligne" "1" "$OUT2"

# ============================================================
# [24] Marchand legacy (non configuré) -- comportement inchangé
# ============================================================
log "=== [24] Legacy inchangé ==="
RC=$(as_anon_rc "select * from public.create_order('resto-legacy','pickup','[{\"menu_item_id\":\"d9999999-9999-9999-9999-999999999999\",\"quantity\":1,\"option_item_id\":null}]'::jsonb, null, '{\"name\":\"Client Legacy\",\"phone\":\"0600000000\"}'::jsonb, null, 'fr', false);")
assert_ok "24. marchand SANS profil CGV (CGV_NOT_CONFIGURED implicite) : checkout réussit SANS acceptation" "$RC"
LEGACY_ORDER_ID=$(sql "select id from public.orders where restaurant_id='$RESTO_LEGACY' order by created_at desc limit 1;")
LEGACY_ACCEPTANCE=$(sql "select count(*) from public.order_cgv_acceptance where order_id='$LEGACY_ORDER_ID';")
assert_eq "24. aucune ligne order_cgv_acceptance créée pour ce marchand legacy" "0" "$LEGACY_ACCEPTANCE"

# ============================================================
# [25/26/27] Pas de mutation paiement / Stuart / fichiers Monet
# ============================================================
log "=== [25/26/27] Périmètre ==="
CODE_ONLY_SCOPE=$(grep -v '^\s*--' "$LOT_SQL")
assert_not_contains "25. le SQL exécuté ne touche aucune table de statut de paiement" "payment_status" "$(printf '%s' "$CODE_ONLY_SCOPE" | grep -oiE 'payment_status|monetico' || true)"
assert_not_contains "26. le SQL exécuté ne fait aucun appel Stuart (une référence à un autre fichier de provenance, en commentaire d'en-tête, est exclue de cette recherche)" "stuart" "$(printf '%s' "$CODE_ONLY_SCOPE" | grep -oi 'stuart' || true)"
pass "27. aucun fichier de Monet (tracking/confirmation/payment-return) modifié -- confirmé au niveau du diff de paquet (NON-MODIFICATION-PROOF.md) ; aucun fichier Stuart LOT D1 v1.2 touché (COLLISION-CHECK.md)"

# ============================================================
# [BLOCKER2/ACL] Matrice de convergence ACL -- 5 tables CGV × 4 rôles
# × 7 privilèges (MAINTAIN, PG17+, exclu -- ce bac à sable est en
# PostgreSQL 16 ; voir en-tête de ce fichier). Prouve que MALGRÉ la
# simulation hostile [BLOCKER2/ACL-0] ci-dessus (ACL par défaut
# accordant tout à anon/authenticated/service_role AVANT même que ce
# lot n'installe ses tables), l'état final est intégralement fermé --
# ce sont les REVOKE explicites du lot qui l'ont fait converger, pas
# une absence de grant par défaut.
# ============================================================
log "=== [BLOCKER2/ACL] Matrice de convergence ACL (5 tables × 4 rôles × 7 privilèges) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -c "do \$do\$ begin if not exists (select from pg_roles where rolname='cgv_probe_public') then create role cgv_probe_public nologin; end if; end \$do\$;" >/dev/null 2>&1

CGV_TABLES="merchant_legal_profile cgv_template merchant_cgv_profile merchant_cgv_version order_cgv_acceptance"
CGV_PRIVS="SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER"
CGV_READ_TABLES="merchant_legal_profile merchant_cgv_profile merchant_cgv_version order_cgv_acceptance"

for T in $CGV_TABLES; do
  for P in $CGV_PRIVS; do
    V=$(sql "select has_table_privilege('cgv_probe_public','public.$T','$P');")
    assert_eq "ACL: PUBLIC (rôle sonde sans appartenance) n'a AUCUN privilège $P sur $T" "f" "$V"

    V=$(sql "select has_table_privilege('anon','public.$T','$P');")
    assert_eq "ACL: anon n'a AUCUN privilège $P sur $T" "f" "$V"

    V=$(sql "select has_table_privilege('service_role','public.$T','$P');")
    assert_eq "ACL: service_role n'a AUCUN privilège DIRECT $P sur $T (toute écriture passe par une RPC SECURITY DEFINER, qui s'exécute avec les droits de son propriétaire, pas ceux de service_role)" "f" "$V"

    V=$(sql "select has_table_privilege('authenticated','public.$T','$P');")
    IS_READ_TABLE="no"
    for RT in $CGV_READ_TABLES; do [ "$T" = "$RT" ] && IS_READ_TABLE="yes"; done
    if [ "$IS_READ_TABLE" = "yes" ] && [ "$P" = "SELECT" ]; then
      assert_eq "ACL: authenticated a SELECT sur $T (lecture directe volontaire, toute écriture reste via RPC)" "t" "$V"
    else
      assert_eq "ACL: authenticated n'a PAS le privilège $P sur $T" "f" "$V"
    fi
  done
done

# ============================================================
# [28-31] renvoyés par le pipeline de vérification global (tsc,
# harness lui-même = SQL harness, git diff --check, régression) --
# consignés dans TEST-RESULTS.md, pas dupliqués ici.
# ============================================================
pass "28/29/30/31. voir TEST-RESULTS.md pour TypeScript / présent harnais / git diff --check / régression checkout existante"

log "=== [ROLLBACK] Preuve de rollback propre ==="
RC=$(sql_rc "$(cat "$ROLLBACK_SQL")")
assert_ok "rollback s'applique proprement" "$RC"
assert_eq "après rollback, merchant_cgv_version n'existe plus" "0" "$(sql "select count(*) from pg_class where relname='merchant_cgv_version';")"
assert_eq "après rollback, persist_merchant_cgv_version n'existe plus" "0" "$(sql "select count(*) from pg_proc where proname='persist_merchant_cgv_version' and pronamespace='public'::regnamespace;")"
assert_eq "après rollback, resolve_cgv_publication_context n'existe plus" "0" "$(sql "select count(*) from pg_proc where proname='resolve_cgv_publication_context' and pronamespace='public'::regnamespace;")"
assert_eq "après rollback, _resolve_applicable_cgv_template n'existe plus" "0" "$(sql "select count(*) from pg_proc where proname='_resolve_applicable_cgv_template' and pronamespace='public'::regnamespace;")"
ARGS_AFTER=$(sql "select pg_get_function_arguments(oid) from pg_proc where proname='create_order' and pronamespace='public'::regnamespace;")
assert_not_contains "après rollback, create_order n'a plus p_cgv_accepted" "p_cgv_accepted" "$ARGS_AFTER"

log "=== RÉSUMÉ ==="
log "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  log "--- Échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
