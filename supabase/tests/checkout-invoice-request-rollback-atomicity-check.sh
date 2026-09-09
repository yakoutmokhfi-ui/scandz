#!/usr/bin/env bash
# ============================================================
# Scanym — CUSTOMER CHECKOUT — CLIENT / COMPANY INVOICE REQUEST v1.3
# TEST DE ROLLBACK RÉEL (Cat Woman INVOICE-V12-MIGRATION-ATOMICITY-01,
# HIGH).
#
# Preuve RÉELLE contre PostgreSQL (jamais une simulation) qu'un échec
# TARDIF (après la création de la table/des fonctions/des GRANT) ne
# laisse JAMAIS de fondation partiellement installée -- la
# transaction explicite BEGIN/COMMIT garantit qu'un ROLLBACK ramène
# la base EXACTEMENT à son état pré-migration.
#
# Méthode : une copie MODIFIÉE de la migration réelle, avec UNE SEULE
# ligne injectée (un `raise exception` supplémentaire juste avant le
# `commit;` final) -- jamais un fichier réécrit de zéro, pour garantir
# que TOUT le reste du contenu testé est authentiquement identique au
# candidat réel.
# ============================================================

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_P1_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p1-foundation.sql"
DRAFT_RITD_SQL="$SUPABASE_DIR/DRAFT-lot-receipt-invoice-tax-detail-v1.sql"
DRAFT_CFPM_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql"
REAL_MIGRATION="$SUPABASE_DIR/DRAFT-lot-checkout-invoice-request-v1.sql"
DB="scanym_invoice_rollback_check_$$"
FAILING_COPY="/tmp/scanym-invoice-rollback-failing-$$.sql"

PASS_COUNT=0
FAIL_COUNT=0
FAIL_LOG="/tmp/scanym-invoice-rollback-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }
cleanup() {
  psql -v ON_ERROR_STOP=1 -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  rm -f "$FAIL_LOG" "$FAILING_COPY" 2>/dev/null || true
}
trap cleanup EXIT

run_fatal() {
  local desc="$1"; shift
  if "$@"; then pass "SETUP (fatal-checked): $desc"; else
    log "FATAL: $desc a échoué -- arrêt immédiat"; exit 1
  fi
}
run_sql_capture() {
  local desc="$1" query="$2"
  local outfile="/tmp/scanym-inv-rollback-capture-$$-$RANDOM.out"
  psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "$query" > "$outfile" 2>&1
  local rc=$?
  CAPTURED_OUTPUT="$(cat "$outfile")"
  rm -f "$outfile"
  if [ "$rc" -ne 0 ]; then log "FATAL: $desc a échoué (rc=$rc) -- $CAPTURED_OUTPUT"; exit 1; fi
  pass "SETUP (fatal-checked, capture): $desc"
}
assert_eq() { local desc="$1" expected="$2" actual="$3"; if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi; }

build_common_bootstrap() {
  psql -v ON_ERROR_STOP=1 -d "$DB" > /tmp/scanym-inv-rollback-bootstrap-$$.out 2>&1 <<'SQL'
create schema if not exists auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create publication supabase_realtime;
do $$ begin
  if not exists (select from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
alter role service_role bypassrls;
create schema if not exists storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/'); $$;
SQL
  local rc=$?
  rm -f /tmp/scanym-inv-rollback-bootstrap-$$.out
  return $rc
}
build_minimal_chain() {
  for f in schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1 || { log "FATAL: $f"; return 1; }
    psql -v ON_ERROR_STOP=1 -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1 || { log "FATAL: GRANT après $f"; return 1; }
  done
  for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1 || { log "FATAL: $f"; return 1; }
  done
  return 0
}
build_full_chain_through_sibling_delivery_pricing() {
  for f in migration-v82-lot2a-sale-modes.sql migration-v83-lot2a4-privilege-hardening.sql migration-v84-lot2b1-delivery-info-rpc.sql DRAFT-lot-fulfillment-routing-model.sql DRAFT-lot-fulfillment-routing-lot-b-rpc.sql DRAFT-lot-server-delivery-fulfillment-pricing.sql; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1 || { log "FATAL: $f (chaîne fidèle sibling)"; return 1; }
  done
  return 0
}

log "=== [0] Construction du baseline authoritative (jusqu'AVANT la migration invoice) ==="
psql -v ON_ERROR_STOP=1 -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
run_fatal "createdb" createdb "$DB"
run_fatal "bootstrap" build_common_bootstrap
run_fatal "chaîne minimale (v66)" build_minimal_chain
run_fatal "chaîne jusqu'à create_order courant" build_full_chain_through_sibling_delivery_pricing
run_fatal "PAYMENT P1" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_P1_SQL"
run_fatal "CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1.3" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_CFPM_SQL"
run_fatal "RECEIPT/INVOICE TAX DETAIL v1.1" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_RITD_SQL"

log "=== [1] Capture de l'état PRÉ-MIGRATION exact (pour comparaison post-rollback) ==="
run_sql_capture "hachage des objets pg_class/pg_proc AVANT toute tentative" \
  "select md5(string_agg(oid::text, ',' order by oid)) from (select oid from pg_class where relname like '%invoice%' union select oid from pg_proc where proname like '%invoice%') s;"
PRE_MIGRATION_HASH="$CAPTURED_OUTPUT"
log "hachage pré-migration (attendu vide/constant) : '$PRE_MIGRATION_HASH'"

log "=== [2] Construction d'une copie EN ÉCHEC (injection d'un raise exception juste avant le commit final) ==="
cp "$REAL_MIGRATION" "$FAILING_COPY"
# Injecte l'échec EXACTEMENT avant la ligne 'commit;' finale -- après
# la création de la table, des politiques RLS, des fonctions, des
# GRANT/REVOKE, et même après les postchecks de sécurité réels (qui,
# eux, réussissent) -- le point d'échec le plus TARDIF possible.
python3 -c "
import sys
path = '$FAILING_COPY'
with open(path, encoding='utf-8') as f:
    content = f.read()
marker = 'commit;'
idx = content.rfind(marker)
assert idx != -1, 'marqueur commit; introuvable'
injection = \"\ndo \$\$ begin raise exception 'SCANYM_ROLLBACK_TEST_INJECTED_FAILURE'; end \$\$;\n\n\"
content = content[:idx] + injection + content[idx:]
with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
"
pass "copie en échec construite (échec injecté juste avant le commit final)"

log "=== [3] Application de la copie EN ÉCHEC -- DOIT échouer ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$FAILING_COPY" > /tmp/scanym-inv-rollback-attempt-$$.out 2>&1
FAILING_RC=$?
if [ "$FAILING_RC" -eq 0 ]; then
  fail "la copie en échec aurait dû échouer, mais a réussi (rc=0) -- l'injection n'a pas fonctionné"
else
  pass "la copie en échec a bien échoué comme attendu (rc=$FAILING_RC)"
fi
rm -f /tmp/scanym-inv-rollback-attempt-$$.out

log "=== [4] Vérification EXHAUSTIVE : AUCUN objet partiel ne subsiste ==="
run_sql_capture "table order_invoice_request ABSENTE après rollback" \
  "select to_regclass('public.order_invoice_request') is null;"
assert_eq "table absente après rollback" "t" "$CAPTURED_OUTPUT"

run_sql_capture "fonction set_order_invoice_request ABSENTE après rollback" \
  "select not exists (select 1 from pg_proc where proname = 'set_order_invoice_request');"
assert_eq "fonction set_ absente après rollback" "t" "$CAPTURED_OUTPUT"

run_sql_capture "fonction get_order_invoice_request ABSENTE après rollback" \
  "select not exists (select 1 from pg_proc where proname = 'get_order_invoice_request');"
assert_eq "fonction get_ absente après rollback" "t" "$CAPTURED_OUTPUT"

run_sql_capture "AUCUNE policy RLS résiduelle liée à invoice_request" \
  "select not exists (select 1 from pg_policies where tablename = 'order_invoice_request');"
assert_eq "aucune policy résiduelle" "t" "$CAPTURED_OUTPUT"

run_sql_capture "AUCUN GRANT résiduel sur order_invoice_request (table absente -> aucun privilège possible)" \
  "select not exists (select 1 from information_schema.table_privileges where table_name = 'order_invoice_request');"
assert_eq "aucun GRANT résiduel" "t" "$CAPTURED_OUTPUT"

run_sql_capture "hachage des objets pg_class/pg_proc APRÈS l'échec -- DOIT être identique au pré-migration" \
  "select md5(string_agg(oid::text, ',' order by oid)) from (select oid from pg_class where relname like '%invoice%' union select oid from pg_proc where proname like '%invoice%') s;"
POST_FAILURE_HASH="$CAPTURED_OUTPUT"
assert_eq "état post-échec IDENTIQUE à l'état pré-migration (aucun objet fantôme, même vide)" "$PRE_MIGRATION_HASH" "$POST_FAILURE_HASH"

log "=== [5] Ré-application de la VRAIE migration (non modifiée) -- DOIT réussir ==="
psql -v VERBOSITY=verbose -d "$DB" -v ON_ERROR_STOP=1 -f "$REAL_MIGRATION" > /tmp/scanym-inv-rollback-real-$$.out 2>&1
REAL_RC=$?
if [ "$REAL_RC" -eq 0 ]; then
  pass "la VRAIE migration s'applique proprement après l'échec précédent (rc=0)"
else
  fail "la VRAIE migration a échoué de façon inattendue -- $(cat /tmp/scanym-inv-rollback-real-$$.out)"
fi
rm -f /tmp/scanym-inv-rollback-real-$$.out

run_sql_capture "table order_invoice_request PRÉSENTE après la vraie migration réussie" \
  "select to_regclass('public.order_invoice_request') is not null;"
assert_eq "table présente après succès réel" "t" "$CAPTURED_OUTPUT"

log "=== BILAN : $PASS_COUNT PASS / $FAIL_COUNT FAIL ==="
if [ "$FAIL_COUNT" -gt 0 ]; then echo "--- ÉCHECS ---"; cat "$FAIL_LOG"; exit 1; fi
exit 0
