#!/usr/bin/env bash
# ============================================================
# Scanym — LOT 02 — TRANSLATIONS OPERATOR AUTHORIZATION v1 — harnais
# SQL réel (PostgreSQL réel, aucune simulation), exécuté en tant
# qu'utilisateur système postgres (authentification peer).
#
# Construit la même chaîne de migrations RÉELLES que
# supabase/tests/catalogue-operator-authorization-v1-check.sh, prouve
# le défaut sur le baseline (opérateur refusé en lecture), applique
# supabase/DRAFT-lot-translations-operator-authorization-v1.sql, prouve
# la matrice d'autorisation du mandat LOT 02, la non-régression de
# l'écriture (write_translation inchangée), puis le rollback.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/translations-operator-authorization-v1-check.sh"
# ============================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DRAFT_SQL="$SUPABASE_DIR/DRAFT-lot-translations-operator-authorization-v1.sql"
ROLLBACK_SQL="$SUPABASE_DIR/DRAFT-lot-translations-operator-authorization-v1-rollback.sql"
DB="scanym_lot02_translations_auth_$$"

PASS=0
FAIL=0
FAIL_LOG="/tmp/scanym-lot02-fails-$$.log"
: > "$FAIL_LOG"

log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS=$((PASS+1)); log "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); printf '%s\n' "$1" >> "$FAIL_LOG"; log "FAIL: $1"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  rm -f "$FAIL_LOG" /tmp/scanym-lot02-err-$$.txt /tmp/scanym-lot02-out-$$.txt 2>/dev/null || true
}
trap cleanup EXIT

sql() { psql -X -A -q -t -d "$DB" -c "$1" 2>/tmp/scanym-lot02-err-$$.txt; }
sql_rc() { psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-lot02-out-$$.txt 2>/tmp/scanym-lot02-err-$$.txt; echo $?; }
sql_err() { cat /tmp/scanym-lot02-err-$$.txt 2>/dev/null; }

as_authenticated() {
  # $1 = uid, $2 = sql
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    2>/tmp/scanym-lot02-err-$$.txt
}
as_authenticated_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    >/tmp/scanym-lot02-out-$$.txt 2>/tmp/scanym-lot02-err-$$.txt
  echo $?
}
as_anon_rc() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-lot02-out-$$.txt 2>/tmp/scanym-lot02-err-$$.txt
  echo $?
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_ok() { # $1=desc $2=rc, attend 0
  if [ "$2" -eq 0 ]; then pass "$1 (rc=0)"; else fail "$1 — attendu rc=0, obtenu rc=$2 : $(sql_err)"; fi
}
assert_denied_msg() { # $1=desc $2=rc $3=motif attendu dans stderr
  if [ "$2" -ne 0 ] && grep -q -- "$3" /tmp/scanym-lot02-err-$$.txt; then
    pass "$1 (rc=$2, '$3')"
  else
    fail "$1 — attendu un refus explicite '$3', obtenu rc=$2 : $(sql_err)"
  fi
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

# Chaîne identique à supabase/tests/catalogue-operator-authorization-v1-check.sh.
MINIMAL_CHAIN="schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql"
REST_CHAIN="migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v76-storage-origin-config.sql migration-v71-hardening.sql migration-v72-hardening.sql migration-v73-hardening.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql migration-v82-lot2a-sale-modes.sql migration-v83-lot2a4-privilege-hardening.sql migration-v84-lot2b1-delivery-info-rpc.sql DRAFT-lot-fulfillment-routing-model.sql DRAFT-lot-fulfillment-routing-lot-b-rpc.sql DRAFT-lot-server-delivery-fulfillment-pricing.sql DRAFT-lot-payment-p3b6-checkout-billing-context.sql DRAFT-lot-customer-order-tracking-foundation.sql DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql DRAFT-lot-receipt-invoice-tax-detail-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1-1-remediation.sql DRAFT-lot-payment-p1-foundation.sql DRAFT-lot-merchant-delivery-pricing.sql DRAFT-lot-orders-service-role-select-hardening.sql DRAFT-lot-catalogue-operator-authorization-v1.sql"

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
pass "P0 chaîne complète appliquée jusqu'au baseline (avant le lot testé)"
psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1

log "=== [1] Fixtures ==="
RESTO_A="11111111-1111-1111-1111-111111111111"
RESTO_B="22222222-2222-2222-2222-222222222222"
RESTO_UNKNOWN="99999999-9999-9999-9999-999999999999"
UID_OWNER_A="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
UID_MANAGER_A="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
UID_STAFF_A="cccccccc-cccc-cccc-cccc-cccccccccccc"
UID_UNRELATED="dddddddd-dddd-dddd-dddd-dddddddddddd"
UID_OWNER_B="eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"
UID_OPERATOR="ffffffff-ffff-ffff-ffff-ffffffffffff"

sql "insert into public.restaurants (id, slug, name, is_active, status, country) values ('$RESTO_A','ra','Restaurant A', true, 'active', 'FR'), ('$RESTO_B','rb','Restaurant B', true, 'active', 'FR');" >/dev/null
sql "insert into public.restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number, source_language, intro_text, announcement_text) values ('$RESTO_A','EUR',1,'+33600000000','fr','Bienvenue A','Annonce A'), ('$RESTO_B','EUR',1,'+33600000001','fr','Bienvenue B','Annonce B');" >/dev/null
sql "insert into public.restaurant_active_languages (restaurant_id, language_code, display_order) values ('$RESTO_A','fr',0), ('$RESTO_A','en',1), ('$RESTO_B','fr',0), ('$RESTO_B','en',1);" >/dev/null
sql "insert into auth.users (id, email) values
  ('$UID_OWNER_A','owner-a@test.local'), ('$UID_MANAGER_A','manager-a@test.local'),
  ('$UID_STAFF_A','staff-a@test.local'), ('$UID_UNRELATED','unrelated@test.local'),
  ('$UID_OWNER_B','owner-b@test.local'), ('$UID_OPERATOR','operator@test.local');" >/dev/null
sql "insert into public.restaurant_users (restaurant_id, user_id, role) values
  ('$RESTO_A','$UID_OWNER_A','owner'), ('$RESTO_A','$UID_MANAGER_A','manager'),
  ('$RESTO_A','$UID_STAFF_A','staff'), ('$RESTO_B','$UID_OWNER_B','owner');" >/dev/null
# Opérateur global : ligne scanym_operators, AUCUNE ligne restaurant_users.
sql "insert into public.scanym_operators (user_id) values ('$UID_OPERATOR');" >/dev/null
R=$(sql "select count(*) from public.restaurant_users where user_id='$UID_OPERATOR';")
assert_eq "P1 fixture : opérateur sans aucune ligne restaurant_users" "0" "$R"

READ_A="select row(t.*)::text from public.get_restaurant_translation_settings('$RESTO_A') t;"
READ_B="select row(t.*)::text from public.get_restaurant_translation_settings('$RESTO_B') t;"

log "=== [2] Baseline : reproduction du défaut (avant application) ==="
RC=$(as_authenticated_rc "$UID_OPERATOR" "$READ_A")
assert_denied_msg "B1 BASELINE : opérateur sans membership -> refusé en lecture (défaut reproduit)" "$RC" "Not authorized for this restaurant"
RC=$(as_authenticated_rc "$UID_OWNER_A" "$READ_A")
assert_ok "B2 BASELINE : owner de A -> autorisé en lecture" "$RC"
BASELINE_OWNER_ROW=$(as_authenticated "$UID_OWNER_A" "$READ_A")

log "=== [3] Application du lot ==="
RC=$(sql_rc "$(cat "$DRAFT_SQL")")
if [ "$RC" -eq 0 ]; then
  pass "L1 application propre de TRANSLATIONS OPERATOR AUTHORIZATION v1"
else
  fail "L1 application du lot a échoué (rc=$RC) : $(sql_err)"
  cat "$FAIL_LOG"
  exit 1
fi
RC=$(sql_rc "$(cat "$DRAFT_SQL")")
assert_denied_msg "L2 double application refusée (garde anti-dérive, aucune modification)" "$RC" "SCANYM_SCHEMA_DRIFT"

log "=== [4] Lecture — membres (non-régression) ==="
RC=$(as_authenticated_rc "$UID_OWNER_A" "$READ_A")
assert_ok "R1 owner de A -> ALLOWED" "$RC"
RC=$(as_authenticated_rc "$UID_MANAGER_A" "$READ_A")
assert_ok "R2 manager de A -> ALLOWED" "$RC"
RC=$(as_authenticated_rc "$UID_STAFF_A" "$READ_A")
assert_ok "R3 staff de A -> ALLOWED (contrat pré-existant sans filtre de rôle, inchangé)" "$RC"
R=$(as_authenticated "$UID_OWNER_A" "$READ_A")
assert_eq "R4 owner de A : données retournées identiques au baseline" "$BASELINE_OWNER_ROW" "$R"

log "=== [5] Lecture — opérateur (correctif) ==="
RC=$(as_authenticated_rc "$UID_OPERATOR" "$READ_A")
assert_ok "O1 opérateur SANS membership -> ALLOWED sur A" "$RC"
R=$(as_authenticated "$UID_OPERATOR" "$READ_A")
assert_eq "O2 opérateur voit EXACTEMENT la même ligne que l'owner de A (aucun repli dégradé)" "$BASELINE_OWNER_ROW" "$R"
R=$(as_authenticated "$UID_OPERATOR" "select count(*) from public.get_restaurant_translation_settings('$RESTO_A');")
assert_eq "O3 opérateur : exactement 1 ligne pour A" "1" "$R"
R=$(as_authenticated "$UID_OPERATOR" "select intro_text from public.get_restaurant_translation_settings('$RESTO_B');")
assert_eq "O4 opérateur -> ALLOWED sur B, données de B uniquement (contexte sélectionné respecté)" "Bienvenue B" "$R"
R=$(as_authenticated "$UID_OPERATOR" "select count(*) from public.get_restaurant_translation_settings('$RESTO_UNKNOWN');")
assert_eq "O5 opérateur, restaurant inconnu -> 0 ligne (aucune donnée fantôme)" "0" "$R"

log "=== [6] Lecture — refus (isolation) ==="
RC=$(as_authenticated_rc "$UID_UNRELATED" "$READ_A")
assert_denied_msg "D1 utilisateur authentifié non-lié -> DENIED (42501 explicite)" "$RC" "Not authorized for this restaurant"
RC=$(as_authenticated_rc "$UID_OWNER_B" "$READ_A")
assert_denied_msg "D2 owner de B -> DENIED sur A (cross-tenant)" "$RC" "Not authorized for this restaurant"
RC=$(as_authenticated_rc "$UID_OWNER_A" "$READ_B")
assert_denied_msg "D3 owner de A -> DENIED sur B (cross-tenant inverse)" "$RC" "Not authorized for this restaurant"
RC=$(as_authenticated_rc "$UID_UNRELATED" "select * from public.get_restaurant_translation_settings('$RESTO_UNKNOWN');")
assert_denied_msg "D4 non-lié, restaurant inconnu -> DENIED" "$RC" "Not authorized for this restaurant"
RC=$(as_anon_rc "$READ_A")
assert_denied_msg "D5 anon -> DENIED (aucun EXECUTE)" "$RC" "permission denied"
RC=$(as_authenticated_rc "" "$READ_A")
assert_denied_msg "D6 authenticated sans auth.uid() -> DENIED (28000)" "$RC" "Authentication required"

log "=== [7] Écriture — inchangée (write_translation) ==="
WRITE_A="select public.write_translation('$RESTO_A','restaurant',null,'intro_text','en','Welcome A','to_review');"
RC=$(as_authenticated_rc "$UID_OWNER_A" "$WRITE_A")
assert_ok "W1 owner de A -> write ALLOWED" "$RC"
RC=$(as_authenticated_rc "$UID_MANAGER_A" "$WRITE_A")
assert_ok "W2 manager de A -> write ALLOWED" "$RC"
RC=$(as_authenticated_rc "$UID_OPERATOR" "$WRITE_A")
assert_ok "W3 opérateur -> write ALLOWED (pré-existant via assert_restaurant_asset_role, inchangé)" "$RC"
RC=$(as_authenticated_rc "$UID_STAFF_A" "$WRITE_A")
assert_denied_msg "W4 staff de A -> write DENIED (inchangé : lecture staff n'implique pas écriture)" "$RC" "Not authorized for this restaurant"
RC=$(as_authenticated_rc "$UID_UNRELATED" "$WRITE_A")
assert_denied_msg "W5 non-lié -> write DENIED" "$RC" "Not authorized for this restaurant"
RC=$(as_authenticated_rc "$UID_OWNER_B" "$WRITE_A")
assert_denied_msg "W6 owner de B -> write DENIED sur A (cross-tenant)" "$RC" "Not authorized for this restaurant"
RC=$(as_anon_rc "$WRITE_A")
assert_denied_msg "W7 anon -> write DENIED" "$RC" "permission denied"
R=$(as_authenticated "$UID_OPERATOR" "select translations->'en'->>'intro_text' from public.get_restaurant_translation_settings('$RESTO_A');")
assert_eq "W8 l'opérateur relit sa propre écriture via la lecture corrigée" "Welcome A" "$R"
R=$(sql "select translations is null from public.restaurant_configs where restaurant_id='$RESTO_B';")
assert_eq "W9 aucune écriture n'a fui sur B" "t" "$R"

log "=== [8] Non-régression structurelle ==="
R=$(sql "select p.prosecdef::text || '|' || array_to_string(p.proconfig, ',') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_restaurant_translation_settings';")
assert_eq "S1 SECURITY DEFINER + search_path='' préservés" 'true|search_path=""' "$R"
R=$(sql "select pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_restaurant_translation_settings';")
assert_eq "S2 forme de retour inchangée (6 colonnes)" "TABLE(source_language text, intro_text text, intro_text_hash text, announcement_text text, announcement_text_hash text, translations jsonb)" "$R"
R=$(sql "select has_function_privilege('anon','public.get_restaurant_translation_settings(uuid)','EXECUTE')::text || '|' || has_function_privilege('authenticated','public.get_restaurant_translation_settings(uuid)','EXECUTE')::text;")
assert_eq "S3 GRANT inchangés (anon sans EXECUTE, authenticated avec)" "false|true" "$R"
R=$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('write_translation','assert_restaurant_asset_role') and pg_get_functiondef(p.oid) ilike '%get_restaurant_translation_settings%';")
assert_eq "S4 write_translation / assert_restaurant_asset_role non couplés au lot" "0" "$R"

log "=== [9] Rollback ==="
RC=$(sql_rc "$(cat "$ROLLBACK_SQL")")
assert_ok "K1 rollback appliqué proprement" "$RC"
RC=$(as_authenticated_rc "$UID_OPERATOR" "$READ_A")
assert_denied_msg "K2 après rollback : opérateur de nouveau refusé (comportement baseline restauré)" "$RC" "Not authorized for this restaurant"
RC=$(as_authenticated_rc "$UID_OWNER_A" "$READ_A")
assert_ok "K3 après rollback : owner toujours autorisé" "$RC"
RC=$(sql_rc "$(cat "$DRAFT_SQL")")
assert_ok "K4 ré-application du lot après rollback" "$RC"

log ""
log "=== RÉSUMÉ === PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  log "--- Échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
