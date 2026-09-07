#!/usr/bin/env bash
# ============================================================
# Scanym — MERCHANT LEGAL & TAX PROFILE v1.1 — harnais SQL réel
# (PostgreSQL réel, aucune simulation), exécuté en tant qu'utilisateur
# système postgres (authentification peer).
#
# Construit la chaîne de migrations RÉELLES pertinentes jusqu'au
# baseline requis c99bb22da3634bc7dae0d906fd5481b2b73898e3, puis
# applique supabase/DRAFT-lot-merchant-legal-tax-profile-v1.sql (même
# fichier que v1, réécrit en place -- v1 n'a jamais été appliquée à
# Production) et prouve chaque invariant du mandat v1, PLUS les 5
# constats de l'audit Work v1.1 (MLTP-V1-OPERATOR-READ-WRITE-01,
# MLTP-V1-DASHBOARD-STALE-WRITE-01 -- couvert côté TS/DOM, jamais SQL,
# voir tests/lot-merchant-legal-tax-profile-v1.test.ts et le nouveau
# fichier .dom.test.ts, MLTP-V1-HISTORICAL-TAX-01,
# MLTP-V1-BOOLEAN-NULL-01, MLTP-V1-TEST-COVERAGE-01). Aucun changement
# à la chaîne de migrations ci-dessous : ce lot reste ADDITIF sur
# receipt_settings/restaurants/restaurant_users/orders, jamais un
# nouveau prérequis.
#
# PÉRIMÈTRE DE LA CHAÎNE — choix documenté : ce lot ne touche QUE
# public.receipt_settings/restaurants/restaurant_users. Vérifié par
# recherche exhaustive (grep) qu'AUCUN fichier de paiement (P2A et
# suivants, qui nécessitent le schéma Supabase Vault -- hébergé
# uniquement, non reproductible localement sans un stand-in dédié
# hors périmètre de ce lot), AUCUN fichier Stuart (hors périmètre par
# mandat explicite : "Do NOT touch Stuart"), et AUCUN fichier
# currency-preflight (dépend lui-même de la chaîne Vault) ne modifie
# restaurants/restaurant_users/receipt_settings. Ces fichiers sont
# donc délibérément ABSENTS de la chaîne ci-dessous -- ce choix est
# sans incidence sur la validité des preuves apportées par ce
# harnais, qui portent exclusivement sur receipt_settings et son
# nouveau chemin d'écriture.
#
# Chaîne appliquée (dans cet ordre, chacune la version RÉELLE du
# dépôt) : schema.sql -> migration-orders.sql -> migration-orders-
# lang.sql -> migration-v29-merchant-dashboard.sql (receipt_settings)
# -> migration-v31-catalogue.sql -> migration-translations.sql ->
# migration-v39-settings.sql -> migration-v43-catalogue-i18n.sql ->
# migration-v55-updated-at.sql -> migration-v64-dashboard-auth-
# whatsapp.sql -> migration-v65-order-note.sql -> migration-v66-
# categories-descriptions.sql -> migration-v67-product-photos.sql ->
# migration-v67b-category-description-product-order.sql ->
# migration-lotd-establishment-creation.sql (is_scanym_operator,
# restaurants.country) -> migration-lotd-rls-reference-tables-fix.sql
# -> migration-v68-establishment-assets.sql (assert_restaurant_asset_role,
# le patron réutilisé ici) -> migration-v69-identity-colors-maps-
# hardening.sql -> migration-v70-identity-corrections.sql ->
# migration-v76-storage-origin-config.sql -> migration-v71-hardening.sql
# -> migration-v72-hardening.sql -> migration-v73-hardening.sql ->
# migration-v80-lot1a-identity-social-languages.sql -> migration-v81-
# lot1b-translations.sql -> migration-v82-lot2a-sale-modes.sql ->
# migration-v83-lot2a4-privilege-hardening.sql -> migration-v84-lot2b1-
# delivery-info-rpc.sql -> DRAFT-lot-fulfillment-routing-model.sql ->
# DRAFT-lot-fulfillment-routing-lot-b-rpc.sql -> DRAFT-lot-server-
# delivery-fulfillment-pricing.sql -> DRAFT-lot-payment-p3b6-checkout-
# billing-context.sql -> DRAFT-lot-customer-order-tracking-
# foundation.sql -> DRAFT-lot-catalogue-fiscal-product-measurements-
# v1.sql -> DRAFT-lot-receipt-invoice-tax-detail-v1.sql -> DRAFT-lot-
# catalogue-subcategories-backoffice-v1.sql -> DRAFT-lot-catalogue-
# subcategories-backoffice-v1-1-remediation.sql -> DRAFT-lot-payment-
# p1-foundation.sql -> DRAFT-lot-merchant-delivery-pricing.sql ->
# DRAFT-lot-orders-service-role-select-hardening.sql -> [notre lot]
# DRAFT-lot-merchant-legal-tax-profile-v1.sql.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/merchant-legal-tax-profile-v1-check.sh"
# ============================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DRAFT_SQL="$SUPABASE_DIR/DRAFT-lot-merchant-legal-tax-profile-v1.sql"
DB="scanym_legaltax_v1_$$"

PASS=0
FAIL=0
FAIL_LOG="/tmp/scanym-legaltax-v1-fails-$$.log"
: > "$FAIL_LOG"

log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS=$((PASS+1)); log "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); printf '%s\n' "$1" >> "$FAIL_LOG"; log "FAIL: $1"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  rm -f "$FAIL_LOG" 2>/dev/null || true
}
trap cleanup EXIT

sql() { psql -X -A -q -t -d "$DB" -c "$1" 2>/tmp/scanym-legaltax-v1-err-$$.txt; }
sql_rc() { psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-legaltax-v1-out-$$.txt 2>/tmp/scanym-legaltax-v1-err-$$.txt; echo $?; }
sql_err() { cat /tmp/scanym-legaltax-v1-err-$$.txt 2>/dev/null; }

as_authenticated() {
  # $1 = uid, $2 = sql
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    2>/tmp/scanym-legaltax-v1-err-$$.txt
}
as_authenticated_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    >/tmp/scanym-legaltax-v1-out-$$.txt 2>/tmp/scanym-legaltax-v1-err-$$.txt
  echo $?
}
as_anon() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" 2>/tmp/scanym-legaltax-v1-err-$$.txt
}
as_anon_rc() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-legaltax-v1-out-$$.txt 2>/tmp/scanym-legaltax-v1-err-$$.txt
  echo $?
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
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

log "=== [0] Construction $DB (chaîne réelle jusqu'au baseline) ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB" || { log "FATAL: createdb a échoué"; exit 1; }
build_common_bootstrap || { log "FATAL: bootstrap commun a échoué"; exit 1; }
build_chain || { log "FATAL: chaîne de migrations a échoué"; exit 1; }
pass "Chaîne complète appliquée jusqu'au prérequis (avant le lot testé)"

RC=$(sql_rc "$(cat "$DRAFT_SQL")")
if [ "$RC" -eq 0 ]; then
  pass "Application propre de MERCHANT LEGAL & TAX PROFILE v1"
else
  fail "Application du lot a échoué (rc=$RC) : $(sql_err)"
  cat "$FAIL_LOG"
  exit 1
fi
psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1

log "=== [1] Fixtures ==="
sql "insert into public.restaurants (id, slug, name, is_active, status, country) values ('11111111-1111-1111-1111-111111111111','r1','R1 Fromagerie', true, 'active', 'FR'), ('22222222-2222-2222-2222-222222222222','r2','R2 Post-Lot-D', true, 'active', null), ('33333333-3333-3333-3333-333333333333','r3','R3 Belgique', true, 'active', null), ('44444444-4444-4444-4444-444444444444','r4','R4 Legacy Snapshot', true, 'active', null);" >/dev/null
sql "insert into public.restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number) values ('11111111-1111-1111-1111-111111111111','EUR',1,'+33600000000'), ('22222222-2222-2222-2222-222222222222','EUR',1,'+33600000001'), ('33333333-3333-3333-3333-333333333333','EUR',1,'+32600000000'), ('44444444-4444-4444-4444-444444444444','EUR',1,'+33600000002');" >/dev/null
sql "insert into auth.users (id, email) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner1@test.local'), ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','staff1@test.local'), ('cccccccc-cccc-cccc-cccc-cccccccccccc','owner2@test.local'), ('dddddddd-dddd-dddd-dddd-dddddddddddd','nomember@test.local'), ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','manager1@test.local');" >/dev/null
sql "insert into public.restaurant_users (restaurant_id, user_id, role) values ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner'), ('11111111-1111-1111-1111-111111111111','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','staff'), ('11111111-1111-1111-1111-111111111111','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','manager'), ('22222222-2222-2222-2222-222222222222','cccccccc-cccc-cccc-cccc-cccccccccccc','owner');" >/dev/null
# r1 : établissement "historique" déjà backfillé par V29 (simulé ici
# explicitement -- la ligne V29 réelle a été insérée avant la création
# de nos restaurants de test, donc absente à ce stade). paper_width_mm
# volontairement à 80 (non-défaut) pour prouver sa préservation.
sql "insert into public.receipt_settings (restaurant_id, business_name, legal_address, paper_width_mm) values ('11111111-1111-1111-1111-111111111111', 'R1 Business', '1 rue Ancienne', 80);" >/dev/null
# r2 : AUCUNE ligne receipt_settings (simule un établissement onboardé
# après V29 via create_establishment, qui n'en insère jamais).
R=$(sql "select count(*) from public.receipt_settings where restaurant_id='22222222-2222-2222-2222-222222222222';")
assert_eq "FIXTURE: r2 n'a AUCUNE ligne receipt_settings avant tout appel (simule post-V29)" "0" "$R"

log "=== [1b] v1.1 TEST : get_receipt_settings distingue \"aucune ligne\" (ensemble vide, aucune erreur) de \"erreur\" ==="
# owner2 (cccc) est membre AUTORISÉ de r2, qui n'a encore AUCUNE ligne
# receipt_settings à cet instant précis (avant TEST 9/UPSERT plus bas)
# -- exactement le cas "aucune ligne, mais lecture RÉUSSIE" que le
# mandat exige de distinguer explicitement d'une erreur (ferme
# MLTP-V1-OPERATOR-READ-WRITE-01, partie "no row vs error").
RC=$(as_authenticated_rc "cccccccc-cccc-cccc-cccc-cccccccccccc" "select count(*) from get_receipt_settings('22222222-2222-2222-2222-222222222222');")
assert_eq "TEST: get_receipt_settings(r2) par owner2 réussit (rc=0, aucune exception)" "0" "$RC"
R=$(as_authenticated "cccccccc-cccc-cccc-cccc-cccccccccccc" "select count(*) from get_receipt_settings('22222222-2222-2222-2222-222222222222');")
assert_eq "TEST: get_receipt_settings(r2) renvoie un ENSEMBLE VIDE (0 ligne) -- jamais une exception -- pour un appelant autorisé sans ligne" "0" "$R"

log "=== [2] TEST 1 : lecture par un marchand autorisé (RLS SELECT existante, inchangée) ==="
R=$(as_authenticated "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" "select business_name from public.receipt_settings where restaurant_id='11111111-1111-1111-1111-111111111111';")
assert_eq "TEST 1: owner1 lit receipt_settings de r1" "R1 Business" "$R"

log "=== [2b] v1.1 TEST 1 (RPC) : owner ET staff lisent via get_receipt_settings (jamais restreint à owner/manager côté lecture) ==="
R=$(as_authenticated "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" "select business_name from get_receipt_settings('11111111-1111-1111-1111-111111111111');")
assert_eq "TEST: owner1 lit r1 via get_receipt_settings" "R1 Business" "$R"
R=$(as_authenticated "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" "select business_name from get_receipt_settings('11111111-1111-1111-1111-111111111111');")
assert_eq "TEST: staff1 (jamais autorisé en ÉCRITURE) lit r1 via get_receipt_settings -- lecture volontairement plus large que l'écriture, même portée que la policy RLS SELECT existante" "R1 Business" "$R"
R=$(as_authenticated "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" "select restaurant_country from get_receipt_settings('11111111-1111-1111-1111-111111111111');")
assert_eq "TEST: get_receipt_settings(r1) inclut restaurant_country (FR) -- nécessaire à l'intitulé de champ présenté" "FR" "$R"

log "=== [3] TEST 2 : owner autorisé peut mettre à jour son propre profil ==="
RC=$(as_authenticated_rc "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" "select update_receipt_settings('11111111-1111-1111-1111-111111111111','R1 New Biz','R1 Legal SARL','2 rue Legal, 75001 Paris','+33100000000','contact@r1.fr','FR12345678901234','85212345600012','TVA',20,true,'Merci de votre visite',true);")
assert_eq "TEST 2: update_receipt_settings par owner1 réussit (rc=0)" "0" "$RC"
R=$(sql "select business_name from public.receipt_settings where restaurant_id='11111111-1111-1111-1111-111111111111';")
assert_eq "TEST 2: business_name effectivement mis à jour" "R1 New Biz" "$R"

log "=== [4] TEST 3 : restaurant non autorisé (staff) rejeté ==="
RC=$(as_authenticated_rc "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" "select update_receipt_settings('11111111-1111-1111-1111-111111111111','Hacked','','','','','','','TVA',20,true,'',false);")
if [ "$RC" -ne 0 ] && grep -q "Not authorized" /tmp/scanym-legaltax-v1-err-$$.txt; then
  pass "TEST 3: staff rejeté avec message 'Not authorized' (rc=$RC)"
else
  fail "TEST 3: staff aurait dû être rejeté (rc=$RC) — $(sql_err)"
fi
R=$(sql "select business_name from public.receipt_settings where restaurant_id='11111111-1111-1111-1111-111111111111';")
assert_eq "TEST 3: business_name inchangé après tentative staff" "R1 New Biz" "$R"

log "=== [5] TEST 4 : cross-tenant impossible (owner2 sur r1) ==="
RC=$(as_authenticated_rc "cccccccc-cccc-cccc-cccc-cccccccccccc" "select update_receipt_settings('11111111-1111-1111-1111-111111111111','Hacked','','','','','','','TVA',20,true,'',false);")
if [ "$RC" -ne 0 ] && grep -q "Not authorized" /tmp/scanym-legaltax-v1-err-$$.txt; then
  pass "TEST 4: cross-tenant (owner2 -> r1) rejeté (rc=$RC)"
else
  fail "TEST 4: cross-tenant aurait dû être rejeté (rc=$RC) — $(sql_err)"
fi

log "=== [5b] v1.1 TEST 4 (RPC) : cross-tenant impossible en LECTURE aussi (owner2 sur r1) ==="
RC=$(as_authenticated_rc "cccccccc-cccc-cccc-cccc-cccccccccccc" "select * from get_receipt_settings('11111111-1111-1111-1111-111111111111');")
if [ "$RC" -ne 0 ] && grep -q "Not authorized" /tmp/scanym-legaltax-v1-err-$$.txt; then
  pass "TEST: get_receipt_settings cross-tenant (owner2 -> r1) rejeté (rc=$RC)"
else
  fail "TEST: get_receipt_settings cross-tenant aurait dû être rejeté (rc=$RC) — $(sql_err)"
fi

log "=== [6] TEST 5 : anon ne peut pas appeler la RPC du tout ==="
RC=$(as_anon_rc "select update_receipt_settings('11111111-1111-1111-1111-111111111111','Hacked','','','','','','','TVA',20,true,'',false);")
if [ "$RC" -ne 0 ] && grep -qi "permission denied" /tmp/scanym-legaltax-v1-err-$$.txt; then
  pass "TEST 5: anon rejeté par absence de EXECUTE (rc=$RC)"
else
  fail "TEST 5: anon aurait dû être rejeté par permission (rc=$RC) — $(sql_err)"
fi

log "=== [6b] v1.1 TEST 5 (RPC) : anon ne peut pas non plus LIRE via get_receipt_settings ==="
RC=$(as_anon_rc "select * from get_receipt_settings('11111111-1111-1111-1111-111111111111');")
if [ "$RC" -ne 0 ] && grep -qi "permission denied" /tmp/scanym-legaltax-v1-err-$$.txt; then
  pass "TEST: anon rejeté sur get_receipt_settings par absence de EXECUTE (rc=$RC)"
else
  fail "TEST: anon aurait dû être rejeté sur get_receipt_settings (rc=$RC) — $(sql_err)"
fi

log "=== [7] TEST 6 : authenticated non-membre rejeté ==="
RC=$(as_authenticated_rc "dddddddd-dddd-dddd-dddd-dddddddddddd" "select update_receipt_settings('11111111-1111-1111-1111-111111111111','Hacked','','','','','','','TVA',20,true,'',false);")
if [ "$RC" -ne 0 ] && grep -q "Not authorized" /tmp/scanym-legaltax-v1-err-$$.txt; then
  pass "TEST 6: authenticated non-membre rejeté (rc=$RC)"
else
  fail "TEST 6: authenticated non-membre aurait dû être rejeté (rc=$RC) — $(sql_err)"
fi

log "=== [7b] v1.1 TEST 6 (RPC) : authenticated non-membre rejeté en LECTURE aussi (avant de devenir opérateur plus bas) ==="
RC=$(as_authenticated_rc "dddddddd-dddd-dddd-dddd-dddddddddddd" "select * from get_receipt_settings('11111111-1111-1111-1111-111111111111');")
if [ "$RC" -ne 0 ] && grep -q "Not authorized" /tmp/scanym-legaltax-v1-err-$$.txt; then
  pass "TEST: get_receipt_settings authenticated non-membre rejeté (rc=$RC)"
else
  fail "TEST: get_receipt_settings authenticated non-membre aurait dû être rejeté (rc=$RC) — $(sql_err)"
fi

log "=== [8] TEST 7 : champs hors-périmètre (paper_width_mm) intacts après update ==="
R=$(sql "select paper_width_mm from public.receipt_settings where restaurant_id='11111111-1111-1111-1111-111111111111';")
assert_eq "TEST 7: paper_width_mm reste 80 après update_receipt_settings (jamais dans sa liste de colonnes)" "80" "$R"

log "=== [9] TEST 8 : champ email — nouveau, persiste/relit correctement ==="
R=$(sql "select email from public.receipt_settings where restaurant_id='11111111-1111-1111-1111-111111111111';")
assert_eq "TEST 8: email persisté par TEST 2 se relit correctement" "contact@r1.fr" "$R"
RC=$(as_authenticated_rc "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" "select update_receipt_settings('11111111-1111-1111-1111-111111111111','R1 New Biz','R1 Legal SARL','2 rue Legal, 75001 Paris','+33100000000','not-an-email','FR12345678901234','85212345600012','TVA',20,true,'Merci de votre visite',true);")
if [ "$RC" -ne 0 ] && grep -q "Invalid email" /tmp/scanym-legaltax-v1-err-$$.txt; then
  pass "TEST 8: email invalide rejeté par la RPC"
else
  fail "TEST 8: email invalide aurait dû être rejeté (rc=$RC) — $(sql_err)"
fi

log "=== [10] TEST : manager (pas seulement owner) autorisé ==="
RC=$(as_authenticated_rc "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" "select update_receipt_settings('11111111-1111-1111-1111-111111111111','R1 By Manager','','','','','','','TVA',20,true,'',false);")
assert_eq "TEST: manager peut aussi mettre à jour (rc=0)" "0" "$RC"

log "=== [11] TEST : taux de taxe hors bornes rejeté ==="
RC=$(as_authenticated_rc "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" "select update_receipt_settings('11111111-1111-1111-1111-111111111111','X','','','','','','','TVA',150,true,'',false);")
if [ "$RC" -ne 0 ] && grep -q "Invalid tax rate" /tmp/scanym-legaltax-v1-err-$$.txt; then
  pass "TEST: default_tax_rate=150 rejeté"
else
  fail "TEST: default_tax_rate=150 aurait dû être rejeté (rc=$RC) — $(sql_err)"
fi

log "=== [12] TEST : tax_label vide rejeté (colonne NOT NULL préservée) ==="
RC=$(as_authenticated_rc "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" "select update_receipt_settings('11111111-1111-1111-1111-111111111111','X','','','','','','','',20,true,'',false);")
if [ "$RC" -ne 0 ] && grep -q "Tax label is required" /tmp/scanym-legaltax-v1-err-$$.txt; then
  pass "TEST: tax_label vide rejeté"
else
  fail "TEST: tax_label vide aurait dû être rejeté (rc=$RC) — $(sql_err)"
fi

log "=== [12b] v1.1 TEST : NULL explicitement rejeté pour prices_include_tax/show_tax_summary (ferme MLTP-V1-BOOLEAN-NULL-01) ==="
RC=$(as_authenticated_rc "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" "select update_receipt_settings('11111111-1111-1111-1111-111111111111','X','','','','','','','TVA',20,null,'',false);")
if [ "$RC" -ne 0 ] && grep -q "prices_include_tax is required" /tmp/scanym-legaltax-v1-err-$$.txt; then
  pass "TEST: prices_include_tax=NULL rejeté explicitement (jamais un défaut silencieux)"
else
  fail "TEST: prices_include_tax=NULL aurait dû être rejeté (rc=$RC) — $(sql_err)"
fi
RC=$(as_authenticated_rc "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" "select update_receipt_settings('11111111-1111-1111-1111-111111111111','X','','','','','','','TVA',20,true,'',null);")
if [ "$RC" -ne 0 ] && grep -q "show_tax_summary is required" /tmp/scanym-legaltax-v1-err-$$.txt; then
  pass "TEST: show_tax_summary=NULL rejeté explicitement (jamais un défaut silencieux)"
else
  fail "TEST: show_tax_summary=NULL aurait dû être rejeté (rc=$RC) — $(sql_err)"
fi
# Non-régression : les deux rejets ci-dessus n'ont écrit AUCUNE valeur
# -- le profil de r1 reste exactement celui posé par le dernier appel
# réussi (TEST manager, section [10]).
R=$(sql "select business_name from public.receipt_settings where restaurant_id='11111111-1111-1111-1111-111111111111';")
assert_eq "TEST: business_name de r1 inchangé après les deux tentatives NULL rejetées" "R1 By Manager" "$R"

log "=== [13] TEST 9 (UPSERT) : owner2 crée le profil de r2, qui n'avait AUCUNE ligne ==="
RC=$(as_authenticated_rc "cccccccc-cccc-cccc-cccc-cccccccccccc" "select update_receipt_settings('22222222-2222-2222-2222-222222222222','R2 Biz','R2 Legal','Rue R2','+32100000000','contact@r2.be','BE0999999999','BCE-0999-999-999','TVA',21,false,'Footer R2',true);")
assert_eq "TEST 9: UPSERT réussit pour un restaurant sans ligne préexistante (rc=0)" "0" "$RC"
R=$(sql "select business_name, paper_width_mm from public.receipt_settings where restaurant_id='22222222-2222-2222-2222-222222222222';" | tr -d ' ')
assert_eq "TEST 9: ligne créée avec les bonnes valeurs, paper_width_mm au DEFAULT (58)" "R2Biz|58" "$R"

log "=== [14] TEST : opérateur Scanym peut administrer N'IMPORTE QUEL établissement (F-01) ==="
sql "insert into public.scanym_operators (user_id) values ('dddddddd-dddd-dddd-dddd-dddddddddddd') on conflict do nothing;" >/dev/null 2>&1 || true
R_HASTABLE=$(sql "select to_regclass('public.scanym_operators') is not null;")
if [ "$R_HASTABLE" = "t" ]; then
  RC=$(as_authenticated_rc "dddddddd-dddd-dddd-dddd-dddddddddddd" "select update_receipt_settings('33333333-3333-3333-3333-333333333333','R3 By Operator','','','','','','','TVA',21,true,'',false);")
  assert_eq "TEST: opérateur Scanym peut mettre à jour un établissement sans y être rattaché (rc=0)" "0" "$RC"

  # v1.1 -- LE constat central de MLTP-V1-OPERATOR-READ-WRITE-01 : le
  # MÊME opérateur (dddddddd), TOUJOURS SANS AUCUN rattachement
  # restaurant_users pour r3, doit maintenant pouvoir RELIRE ce qu'il
  # vient d'écrire -- AVANT v1.1, get_receipt_settings n'existait pas
  # et la seule policy RLS SELECT (V29) l'aurait rejeté (aucun membre
  # restaurant_users) : un opérateur pouvait écrire à l'aveugle, sans
  # jamais pouvoir confirmer/relire son propre changement, exactement
  # le risque décrit par le mandat ("could load an empty/default form
  # and overwrite an existing merchant profile").
  R=$(as_authenticated "dddddddd-dddd-dddd-dddd-dddddddddddd" "select business_name from get_receipt_settings('33333333-3333-3333-3333-333333333333');")
  assert_eq "TEST: opérateur Scanym peut aussi RELIRE ce qu'il vient d'écrire pour r3, sans y être rattaché (ferme MLTP-V1-OPERATOR-READ-WRITE-01)" "R3 By Operator" "$R"
else
  fail "TEST: table scanym_operators introuvable -- impossible de prouver le chemin opérateur F-01"
fi

log "=== [15] Non-régression : aucun droit d'écriture direct, RLS active, aucun droit anon sur la RPC ==="
R=$(sql "select has_function_privilege('anon', 'public.update_receipt_settings(uuid, text, text, text, text, text, text, text, text, numeric, boolean, text, boolean)', 'EXECUTE');")
assert_eq "anon SANS EXECUTE sur update_receipt_settings" "f" "$R"
R=$(sql "select has_function_privilege('authenticated', 'public.update_receipt_settings(uuid, text, text, text, text, text, text, text, text, numeric, boolean, text, boolean)', 'EXECUTE');")
assert_eq "authenticated AVEC EXECUTE sur update_receipt_settings" "t" "$R"
R=$(sql "select has_table_privilege('authenticated', 'public.receipt_settings', 'UPDATE');")
assert_eq "authenticated SANS UPDATE direct sur receipt_settings (écriture RPC seule)" "f" "$R"
R=$(sql "select relrowsecurity from pg_class where relname='receipt_settings';")
assert_eq "RLS toujours active sur receipt_settings" "t" "$R"
R=$(sql "select has_function_privilege('anon', 'public.get_receipt_settings(uuid)', 'EXECUTE');")
assert_eq "anon SANS EXECUTE sur get_receipt_settings" "f" "$R"
R=$(sql "select has_function_privilege('authenticated', 'public.get_receipt_settings(uuid)', 'EXECUTE');")
assert_eq "authenticated AVEC EXECUTE sur get_receipt_settings" "t" "$R"

log "=== [16] v1.1 TEST : instantané fiscal figé par commande (ferme MLTP-V1-HISTORICAL-TAX-01) ==="
# r1 a, à cet instant, default_tax_rate=20 / prices_include_tax=true /
# tax_label='TVA' / show_tax_summary=false (dernier update réussi,
# TEST manager section [10]) -- insertion DIRECTE dans orders (postgres,
# contourne RLS, exactement comme create_order le ferait en pratique :
# le déclencheur BEFORE INSERT s'exécute pour TOUTE insertion, quel que
# soit le chemin) pour prouver le mécanisme lui-même, indépendamment de
# la complexité de create_order (menu_items/sale_modes non nécessaires
# ici -- hors périmètre de ce lot, jamais touché).
sql "insert into public.orders (id, restaurant_id, order_number, service_mode, subtotal, total, currency) values ('a0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111', 9001, 'pickup', 10.00, 10.00, 'EUR');" >/dev/null
R=$(sql "select tax_settings_snapshot_default_tax_rate, tax_settings_snapshot_prices_include_tax, tax_settings_snapshot_tax_label, tax_settings_snapshot_show_tax_summary from public.orders where id='a0000000-0000-0000-0000-000000000001';" | tr -d ' ')
assert_eq "TEST: commande r1 #9001 reçoit l'instantané fiscal EXACT des réglages courants au moment de l'INSERT" "20.00|t|TVA|f" "$R"

# Le marchand change ENSUITE son taux (20 -> 5.5) -- l'instantané de la
# commande #9001, déjà figé, ne doit JAMAIS changer rétroactivement.
RC=$(as_authenticated_rc "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" "select update_receipt_settings('11111111-1111-1111-1111-111111111111','R1 New Rate','','','','','','','TVA Réduite',5.5,true,'',true);")
assert_eq "TEST: changement ultérieur de default_tax_rate/tax_label/show_tax_summary réussit (rc=0)" "0" "$RC"
R=$(sql "select tax_settings_snapshot_default_tax_rate, tax_settings_snapshot_tax_label, tax_settings_snapshot_show_tax_summary from public.orders where id='a0000000-0000-0000-0000-000000000001';" | tr -d ' ')
assert_eq "TEST: l'instantané de la commande #9001 (déjà passée) reste EXACTEMENT 20.00|TVA|f après le changement de réglages -- jamais recalculé rétroactivement (ferme MLTP-V1-HISTORICAL-TAX-01)" "20.00|TVA|f" "$R"

# Une NOUVELLE commande insérée APRÈS ce changement doit, elle, recevoir
# le NOUVEL instantané -- l'immuabilité ne s'applique qu'aux commandes
# déjà passées, jamais un gel permanent du mécanisme lui-même.
sql "insert into public.orders (id, restaurant_id, order_number, service_mode, subtotal, total, currency) values ('a0000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111', 9002, 'pickup', 10.00, 10.00, 'EUR');" >/dev/null
R=$(sql "select tax_settings_snapshot_default_tax_rate, tax_settings_snapshot_tax_label, tax_settings_snapshot_show_tax_summary from public.orders where id='a0000000-0000-0000-0000-000000000002';")
assert_eq "TEST: une commande créée APRÈS le changement reçoit le NOUVEL instantané (5.50|TVA Réduite|t)" "5.50|TVA Réduite|t" "$R"

# r4 n'a JAMAIS eu la moindre ligne receipt_settings -- une commande
# insérée pour r4 doit recevoir un instantané intégralement NULL
# ("LEGACY ORDER -- FISCAL SNAPSHOT UNAVAILABLE"), jamais une valeur
# fabriquée (0/false/'TVA' inventés).
R=$(sql "select count(*) from public.receipt_settings where restaurant_id='44444444-4444-4444-4444-444444444444';")
assert_eq "FIXTURE: r4 n'a AUCUNE ligne receipt_settings" "0" "$R"
sql "insert into public.orders (id, restaurant_id, order_number, service_mode, subtotal, total, currency) values ('a0000000-0000-0000-0000-000000000003','44444444-4444-4444-4444-444444444444', 1, 'pickup', 10.00, 10.00, 'EUR');" >/dev/null
R=$(sql "select tax_settings_snapshot_default_tax_rate is null, tax_settings_snapshot_prices_include_tax is null, tax_settings_snapshot_tax_label is null, tax_settings_snapshot_show_tax_summary is null from public.orders where id='a0000000-0000-0000-0000-000000000003';" | tr -d ' ')
assert_eq "TEST: commande pour un restaurant SANS receipt_settings reçoit un instantané intégralement NULL (repli sûr -- lib/receipt.ts n'affichera aucune décomposition fabriquée)" "t|t|t|t" "$R"

# Non-régression : le déclencheur ne touche jamais subtotal/total/currency.
R=$(sql "select subtotal, total, currency from public.orders where id='a0000000-0000-0000-0000-000000000001';" | tr -d ' ')
assert_eq "TEST: subtotal/total/currency de la commande #9001 intacts (jamais touchés par le déclencheur fiscal)" "10.00|10.00|EUR" "$R"

log "=== [17] Non-régression : aucune modification de menu_items/order_items, aucune modification de create_order, aucune table paiement/Stuart touchée ==="
# orders est désormais LÉGITIMEMENT modifié par CE lot (section 5,
# instantané fiscal additif -- voir ci-dessus) : le garde-fou porte
# donc sur order_items/menu_items (jamais touchés) et sur l'ABSENCE de
# toute redéfinition de create_order (signature/corps/contrat de
# retour), jamais sur une simple présence de "alter table ... orders"
# qui est maintenant un changement ATTENDU et scopé.
if grep -qE "alter table public\.(order_items|menu_items)\b" "$DRAFT_SQL"; then
  fail "NON-RÉGRESSION: le lot modifie order_items/menu_items -- HORS PÉRIMÈTRE"
else
  pass "NON-RÉGRESSION: aucune modification de order_items/menu_items dans le lot"
fi
if grep -qE "create (or replace )?function public\.create_order\b" "$DRAFT_SQL"; then
  fail "NON-RÉGRESSION: le lot redéfinit create_order -- HORS PÉRIMÈTRE (l'instantané fiscal doit passer par un déclencheur, jamais une modification de create_order)"
else
  pass "NON-RÉGRESSION: create_order n'est jamais redéfini par ce lot (instantané fiscal via déclencheur BEFORE INSERT uniquement)"
fi
# L'instantané fiscal doit rester ADDITIF sur orders : aucune des
# colonnes financières existantes (subtotal/total/delivery_fee/
# currency) ne doit apparaître dans une clause ALTER COLUMN/DROP
# COLUMN/RENAME de ce fichier.
if grep -qE "(alter|drop) column public\.orders\.(subtotal|total|delivery_fee|currency)\b" "$DRAFT_SQL"; then
  fail "NON-RÉGRESSION: le lot modifie une colonne financière existante de orders -- HORS PÉRIMÈTRE"
else
  pass "NON-RÉGRESSION: aucune colonne financière existante de orders (subtotal/total/delivery_fee/currency) n'est modifiée par ce lot"
fi
# Seules les lignes de commentaire SQL ("--") peuvent mentionner
# Stuart/Monetico (pour documenter l'exclusion explicite du
# périmètre) -- aucune ligne de CODE SQL réel ne doit les référencer.
if grep -v '^\s*--' "$DRAFT_SQL" | grep -qiE "stuart|monetico"; then
  fail "NON-RÉGRESSION: du CODE SQL (hors commentaire) référence Stuart/Monetico -- HORS PÉRIMÈTRE"
else
  pass "NON-RÉGRESSION: aucun CODE SQL (hors commentaire documentant l'exclusion) ne référence Stuart/Monetico"
fi

log ""
log "=== RÉSUMÉ ==="
log "PASS: $PASS"
log "FAIL: $FAIL"
if [ "$FAIL" -ne 0 ]; then
  log "Détail des échecs :"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
