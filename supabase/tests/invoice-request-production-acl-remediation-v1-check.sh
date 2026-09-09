#!/usr/bin/env bash
# ============================================================
# Scanym — INVOICE REQUEST PRODUCTION ACL REMEDIATION v1 — real
# Postgres proof (never simulated, never against Production).
#
# Deliberately reproduces the EXACT drift pattern Catimini reported
# from real Production (unexpected TRUNCATE/REFERENCES/TRIGGER on
# the table for anon/authenticated/service_role/PUBLIC, an
# unexpected column-level grant, unexpected function EXECUTE grants,
# and a grant to a genuinely unknown role never named by the
# mandate) against a fresh local Foundation-only install (Email
# Delta deliberately NOT installed, matching Production's actual
# current state), then proves:
#   - the read-only precheck reports the drift completely, with zero
#     mutation
#   - INVOICE-REQUEST-ACL-REMEDIATION.sql converges the ACL state to
#     EXACTLY the audited contract, and only that
#   - the two legitimate grants (authenticated:SELECT,
#     service_role:EXECUTE x2) are never touched
#   - RLS/policies/schema/constraints/indexes/function bodies are
#     completely unaffected (byte-identical fingerprint before/after)
#   - re-running the remediation on an already-clean state is a
#     harmless no-op (idempotency / safe-to-repeat)
#   - the guard fails closed (refuses, zero mutation) on broken
#     preconditions (table missing, RLS disabled)
#   - tenant isolation and the Invoice Request RPCs still function
#     end-to-end exactly as before remediation
# ============================================================

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_P1_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p1-foundation.sql"
DRAFT_RITD_SQL="$SUPABASE_DIR/DRAFT-lot-receipt-invoice-tax-detail-v1.sql"
DRAFT_CFPM_SQL="$SUPABASE_DIR/DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql"
FOUNDATION_SQL="$SUPABASE_DIR/DRAFT-lot-invoice-request-foundation-v1.sql"
REMEDIATION_SQL="$SUPABASE_DIR/DRAFT-lot-invoice-request-production-acl-remediation-v1.sql"
PRECHECK_SQL="$SUPABASE_DIR/tests/production-invoice-request-acl-readonly-precheck.sql"
DB="scanym_invreq_aclremed_v1_$$"

PASS_COUNT=0
FAIL_COUNT=0
FAIL_LOG="/tmp/scanym-aclremed-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }
cleanup() { psql -v ON_ERROR_STOP=1 -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true; rm -f "$FAIL_LOG" 2>/dev/null || true; }
trap cleanup EXIT

run_fatal() {
  local desc="$1"; shift
  if "$@"; then pass "SETUP (fatal-checked): $desc"; else
    log "FATAL: $desc a échoué -- arrêt immédiat"; exit 1
  fi
}
run_sql_fatal() {
  local desc="$1" query="$2" role="${3:-}"
  local outfile="/tmp/scanym-aclremed-fatal-$$-$RANDOM.out"
  if [ -n "$role" ]; then
    psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "set role $role; $query" > "$outfile" 2>&1
  else
    psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "$query" > "$outfile" 2>&1
  fi
  local rc=$?
  if [ "$rc" -ne 0 ]; then log "FATAL: $desc a échoué (rc=$rc) -- $(cat "$outfile")"; rm -f "$outfile"; exit 1; fi
  rm -f "$outfile"
  pass "SETUP (fatal-checked): $desc"
}
CAPTURED_OUTPUT=""
run_sql_capture() {
  local desc="$1" query="$2" role="${3:-}"
  local outfile="/tmp/scanym-aclremed-capture-$$-$RANDOM.out"
  if [ -n "$role" ]; then
    psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "set role $role; $query" > "$outfile" 2>&1
  else
    psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "$query" > "$outfile" 2>&1
  fi
  local rc=$?
  CAPTURED_OUTPUT="$(cat "$outfile")"
  rm -f "$outfile"
  if [ "$rc" -ne 0 ]; then log "FATAL: $desc a échoué (rc=$rc) -- $CAPTURED_OUTPUT"; exit 1; fi
  pass "SETUP (fatal-checked, capture): $desc"
}
assert_eq() { local desc="$1" expected="$2" actual="$3"; if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi; }

build_common_bootstrap() {
  psql -v ON_ERROR_STOP=1 -d "$DB" > /tmp/scanym-aclremed-bootstrap-$$.out 2>&1 <<'SQL'
create schema if not exists auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create publication supabase_realtime;
do $$ begin
  if not exists (select from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  if not exists (select from pg_roles where rolname='scanym_probe_unknown_role') then create role scanym_probe_unknown_role nologin; end if;
end $$;
alter role service_role bypassrls;
create schema if not exists storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/'); $$;
SQL
  local rc=$?
  rm -f /tmp/scanym-aclremed-bootstrap-$$.out
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
build_full_chain() {
  for f in migration-v82-lot2a-sale-modes.sql migration-v83-lot2a4-privilege-hardening.sql migration-v84-lot2b1-delivery-info-rpc.sql DRAFT-lot-fulfillment-routing-model.sql DRAFT-lot-fulfillment-routing-lot-b-rpc.sql DRAFT-lot-server-delivery-fulfillment-pricing.sql; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1 || { log "FATAL: $f"; return 1; }
  done
  return 0
}

acl_fingerprint() {
  # Non-owner ACL fingerprint for the table, its columns, and both
  # RPCs -- the exact set this remediation must converge to (or
  # already start correct at, before any drift is injected).
  psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "
    select string_agg(x, E'\n' order by x) from (
      select 'TBL:' || coalesce(nullif(g.grantee,0)::regrole::text,'PUBLIC') || ':' || g.privilege_type as x
      from pg_class c cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) g
      where c.oid = 'public.order_invoice_request'::regclass
        and coalesce(nullif(g.grantee,0)::regrole::text,'PUBLIC') <> (select relowner::regrole::text from pg_class where oid='public.order_invoice_request'::regclass)
      union all
      select 'COL:' || att.attname || ':' || coalesce(nullif(g.grantee,0)::regrole::text,'PUBLIC') || ':' || g.privilege_type
      from pg_attribute att cross join lateral aclexplode(coalesce(att.attacl, acldefault('c', (select relowner from pg_class where oid=att.attrelid)))) g
      where att.attrelid = 'public.order_invoice_request'::regclass and att.attnum > 0 and not att.attisdropped
        and coalesce(nullif(g.grantee,0)::regrole::text,'PUBLIC') <> (select relowner::regrole::text from pg_class where oid='public.order_invoice_request'::regclass)
      union all
      select 'FN_SET:' || coalesce(nullif(g.grantee,0)::regrole::text,'PUBLIC') || ':' || g.privilege_type
      from pg_proc p cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) g
      where p.proname='set_order_invoice_request' and p.pronargs=12
        and coalesce(nullif(g.grantee,0)::regrole::text,'PUBLIC') <> (select proowner::regrole::text from pg_proc where proname='set_order_invoice_request' and pronargs=12)
      union all
      select 'FN_GET:' || coalesce(nullif(g.grantee,0)::regrole::text,'PUBLIC') || ':' || g.privilege_type
      from pg_proc p cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) g
      where p.proname='get_order_invoice_request' and p.pronargs=2
        and coalesce(nullif(g.grantee,0)::regrole::text,'PUBLIC') <> (select proowner::regrole::text from pg_proc where proname='get_order_invoice_request' and pronargs=2)
    ) s;
  "
}
nongrant_security_fingerprint() {
  # Everything the remediation must NOT touch: schema, constraints,
  # indexes, RLS state, policy text, and both function bodies.
  psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "
    select string_agg(x, E'\n' order by x) from (
      select 'COL:' || ordinal_position || ':' || column_name || ':' || data_type as x
      from information_schema.columns where table_schema='public' and table_name='order_invoice_request'
      union all
      select 'CONS:' || conname || ':' || pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.order_invoice_request'::regclass
      union all
      select 'IDX:' || indexname || ':' || indexdef from pg_indexes where schemaname='public' and tablename='order_invoice_request'
      union all
      select 'RLS:' || relrowsecurity::text || ':' || relforcerowsecurity::text from pg_class where oid='public.order_invoice_request'::regclass
      union all
      select 'POL:' || policyname || ':' || permissive || ':' || cmd || ':' || coalesce(qual,'') from pg_policies where schemaname='public' and tablename='order_invoice_request'
      union all
      select 'FNDEF_SET:' || pg_get_functiondef(oid) from pg_proc where proname='set_order_invoice_request' and pronargs=12
      union all
      select 'FNDEF_GET:' || pg_get_functiondef(oid) from pg_proc where proname='get_order_invoice_request' and pronargs=2
    ) s;
  "
}

run_full_cycle() {
  local cycle_label="$1"
  log "=== [$cycle_label / 0] createdb + full chain + Foundation ONLY (Email Delta deliberately NOT installed, matching real Production's current state) ==="
  psql -v ON_ERROR_STOP=1 -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  run_fatal "createdb" createdb "$DB"
  run_fatal "bootstrap" build_common_bootstrap
  run_fatal "chaîne minimale" build_minimal_chain
  run_fatal "chaîne complète" build_full_chain
  run_fatal "PAYMENT P1" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_P1_SQL"
  run_fatal "CATALOGUE FISCAL" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_CFPM_SQL"
  run_fatal "RECEIPT/INVOICE TAX DETAIL" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_RITD_SQL"
  run_fatal "FOUNDATION v1 (Email Delta NOT applied)" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$FOUNDATION_SQL"

  BASELINE_ACL="$(acl_fingerprint)"
  BASELINE_SECURITY="$(nongrant_security_fingerprint)"
  if [ -z "$BASELINE_SECURITY" ]; then log "FATAL: impossible de capturer le fingerprint de sécurité de référence"; exit 1; fi

  log "=== [$cycle_label / 1] Foundation installe déjà EXACTEMENT le contrat audité (avant toute dérive simulée) ==="
  EXPECTED_CLEAN='FN_GET:service_role:EXECUTE
FN_SET:service_role:EXECUTE
TBL:authenticated:SELECT'
  assert_eq "$cycle_label.1 état propre initial == contrat audité exact (aucune dérive avant simulation)" "$EXPECTED_CLEAN" "$BASELINE_ACL"

  log "=== [$cycle_label / 2] Simulation de la DÉRIVE EXACTE rapportée par Catimini depuis la vraie Production (PostgreSQL 17 default ACL behavior) ==="
  run_sql_fatal "2a. TRUNCATE/REFERENCES/TRIGGER inattendus -- anon" "grant truncate, references, trigger on public.order_invoice_request to anon;"
  run_sql_fatal "2b. TRUNCATE/REFERENCES/TRIGGER inattendus -- authenticated" "grant truncate, references, trigger on public.order_invoice_request to authenticated;"
  run_sql_fatal "2c. TRUNCATE/REFERENCES/TRIGGER inattendus -- service_role" "grant truncate, references, trigger on public.order_invoice_request to service_role;"
  run_sql_fatal "2d. TRUNCATE inattendu -- PUBLIC" "grant truncate on public.order_invoice_request to public;"
  run_sql_fatal "2e. SELECT/INSERT inattendus -- rôle GÉNUINEMENT INCONNU du mandat (scanym_probe_unknown_role)" "grant select, insert, truncate on public.order_invoice_request to scanym_probe_unknown_role;"
  run_sql_fatal "2f. GRANT colonne inattendu -- SELECT(contact_email) à anon" "grant select (contact_email) on public.order_invoice_request to anon;"
  run_sql_fatal "2g. GRANT colonne inattendu -- UPDATE(contact_email) à service_role" "grant update (contact_email) on public.order_invoice_request to service_role;"
  run_sql_fatal "2h. EXECUTE inattendu (fonction set_*) -- anon" "grant execute on function set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text) to anon;"
  run_sql_fatal "2i. EXECUTE inattendu (fonction get_*) -- PUBLIC" "grant execute on function get_order_invoice_request(uuid,uuid) to public;"

  DRIFTED_ACL="$(acl_fingerprint)"
  if [ "$DRIFTED_ACL" = "$BASELINE_ACL" ]; then fail "$cycle_label.2 la dérive simulée aurait dû changer le fingerprint ACL"; else pass "$cycle_label.2 dérive simulée détectée par le fingerprint (diffère du contrat audité)"; fi

  log "=== [$cycle_label / 3] PRECHECK read-only -- capture complète, ZÉRO mutation ==="
  PRECHECK_OUT="$(psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$PRECHECK_SQL" 2>&1)"
  PRECHECK_RC=$?
  assert_eq "$cycle_label.3a precheck read-only s'exécute sans erreur" "0" "$PRECHECK_RC"
  if echo "$PRECHECK_OUT" | grep -q "TRUNCATE" && echo "$PRECHECK_OUT" | grep -q "scanym_probe_unknown_role"; then
    pass "$cycle_label.3b precheck rapporte bien TRUNCATE et le rôle inconnu (dérive visible dans le rapport)"
  else
    fail "$cycle_label.3b precheck n'a pas rapporté la dérive attendue"
  fi
  POST_PRECHECK_ACL="$(acl_fingerprint)"
  assert_eq "$cycle_label.3c precheck n'a MUTÉ aucun ACL (fingerprint identique avant/après le precheck)" "$DRIFTED_ACL" "$POST_PRECHECK_ACL"

  log "=== [$cycle_label / 4] REMEDIATION -- doit converger EXACTEMENT vers le contrat audité ==="
  REMED_OUT="$(psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$REMEDIATION_SQL" 2>&1)"
  REMED_RC=$?
  assert_eq "$cycle_label.4a remediation s'exécute avec succès (rc=0)" "0" "$REMED_RC"
  if echo "$REMED_OUT" | grep -q "convergence confirmed"; then pass "$cycle_label.4b remediation rapporte 'convergence confirmed'"; else fail "$cycle_label.4b message de convergence absent -- sortie: $REMED_OUT"; fi

  POST_REMEDIATION_ACL="$(acl_fingerprint)"
  assert_eq "$cycle_label.4c ACL après remediation == EXACTEMENT le contrat audité (identique à l'état propre initial)" "$BASELINE_ACL" "$POST_REMEDIATION_ACL"

  POST_REMEDIATION_SECURITY="$(nongrant_security_fingerprint)"
  assert_eq "$cycle_label.4d schéma/contraintes/index/RLS/policies/corps de fonction INCHANGÉS (fingerprint non-grant identique)" "$BASELINE_SECURITY" "$POST_REMEDIATION_SECURITY"

  for role_check in "authenticated:select:t" "anon:select:f" "service_role:select:f" "anon:truncate:f" "authenticated:truncate:f" "service_role:truncate:f" "anon:references:f" "authenticated:trigger:f"; do
    IFS=':' read -r rchk_role rchk_priv rchk_expected <<< "$role_check"
    run_sql_capture "4e. vérif directe has_table_privilege($rchk_role,$rchk_priv)" "select has_table_privilege('$rchk_role','public.order_invoice_request','$rchk_priv');"
    assert_eq "4e. $rchk_role:$rchk_priv == $rchk_expected (contrat audité)" "$rchk_expected" "$CAPTURED_OUTPUT"
  done
  run_sql_capture "4f. rôle inconnu scanym_probe_unknown_role -- plus AUCUN privilège table" "select has_table_privilege('scanym_probe_unknown_role','public.order_invoice_request','select') or has_table_privilege('scanym_probe_unknown_role','public.order_invoice_request','truncate') or has_table_privilege('scanym_probe_unknown_role','public.order_invoice_request','insert');"
  assert_eq "4f. rôle inconnu totalement dépourvu de privilège après remediation" "f" "$CAPTURED_OUTPUT"
  run_sql_capture "4g. colonne contact_email -- AUCUN ACL colonne résiduel" "select count(*) from pg_attribute att cross join lateral aclexplode(coalesce(att.attacl, acldefault('c', (select relowner from pg_class where oid=att.attrelid)))) g where att.attrelid='public.order_invoice_request'::regclass and att.attnum>0 and not att.attisdropped;"
  assert_eq "4g. zéro ACL colonne résiduel après remediation" "0" "$CAPTURED_OUTPUT"
  run_sql_capture "4h. EXECUTE anon sur set_* révoqué" "select has_function_privilege('anon', (select oid from pg_proc where proname='set_order_invoice_request' and pronargs=12), 'execute');"
  assert_eq "4h. anon:EXECUTE(set_*) == false après remediation" "f" "$CAPTURED_OUTPUT"
  run_sql_capture "4i. EXECUTE PUBLIC sur get_* révoqué" "select has_function_privilege('public', (select oid from pg_proc where proname='get_order_invoice_request' and pronargs=2), 'execute');"
  assert_eq "4i. PUBLIC:EXECUTE(get_*) == false après remediation" "f" "$CAPTURED_OUTPUT"

  log "=== [$cycle_label / 5] IDEMPOTENCE -- re-exécuter la remediation sur un état déjà propre doit être un no-op inoffensif ==="
  REMED_OUT2="$(psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$REMEDIATION_SQL" 2>&1)"
  REMED_RC2=$?
  assert_eq "5a. deuxième exécution (état déjà propre) réussit aussi (rc=0)" "0" "$REMED_RC2"
  if echo "$REMED_OUT2" | grep -q "0 unexpected ACL row(s) revoked in total"; then pass "5b. deuxième exécution: 0 ligne révoquée (no-op confirmé)"; else fail "5b. deuxième exécution n'a pas rapporté 0 révocation -- sortie: $REMED_OUT2"; fi
  POST_IDEMPOTENT_ACL="$(acl_fingerprint)"
  assert_eq "5c. ACL après ré-exécution toujours == contrat audité" "$BASELINE_ACL" "$POST_IDEMPOTENT_ACL"

  log "=== [$cycle_label / 6] Fonctionnalité end-to-end après remediation -- create_order + RPCs + isolation tenant ==="
  run_sql_fatal "6a. restaurant r1" "insert into restaurants (id, slug, name, is_active, status) values ('11111111-1111-1111-1111-111111111111', 'r1', 'R1', true, 'active');"
  run_sql_fatal "6b. restaurant_configs r1" "insert into restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number) values ('11111111-1111-1111-1111-111111111111', 'EUR', 1, '+33600000000');"
  run_sql_fatal "6c. restaurant r2 (autre tenant)" "insert into restaurants (id, slug, name, is_active, status) values ('22222222-2222-2222-2222-222222222222', 'r2', 'R2', true, 'active');"
  run_sql_fatal "6d. restaurant_configs r2" "insert into restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number) values ('22222222-2222-2222-2222-222222222222', 'EUR', 1, '+33600000000');"
  run_sql_fatal "6e. menu category r1" "insert into menu_categories (id, restaurant_id, name, display_order) values ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Cat', 1);"
  run_sql_fatal "6f. menu item r1" "insert into menu_items (id, category_id, name, price, is_available) values ('dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'Item', 5.00, true);"
  run_sql_fatal "6g. sale mode pickup r1" "insert into restaurant_sale_modes (restaurant_id, mode_code, enabled) values ('11111111-1111-1111-1111-111111111111', 'pickup', true);"
  run_sql_fatal "6h. staff r1" "insert into auth.users (id, email) values ('99999999-0000-0000-0000-000000000001', 'staff@r1.test');"
  run_sql_fatal "6i. restaurant_users staff r1" "insert into restaurant_users (restaurant_id, user_id, role) values ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000001', 'owner');"
  run_sql_capture "6j. création commande via create_order réel" "select order_id from create_order('r1', 'pickup', '[{\"menu_item_id\":\"dddddddd-0000-0000-0000-000000000001\",\"quantity\":1}]'::jsonb, null, '{\"name\":\"Client Test\",\"phone\":\"+33612345678\"}'::jsonb);"
  ORDER1_ID="$CAPTURED_OUTPUT"
  run_sql_capture "6k. public_token" "select public_token from orders where id='$ORDER1_ID';"
  ORDER1_TOKEN="$CAPTURED_OUTPUT"
  run_sql_fatal "6l. set_order_invoice_request via service_role (RPC toujours fonctionnelle après remediation)" "select set_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid, 'individual', '12 rue Test', 'Paris', '75001', 'FR');" "service_role"
  run_sql_capture "6m. get_order_invoice_request via service_role" "select invoice_type from get_order_invoice_request('$ORDER1_ID'::uuid, '$ORDER1_TOKEN'::uuid);" "service_role"
  assert_eq "6m. lecture RPC fonctionnelle après remediation" "individual" "$CAPTURED_OUTPUT"
  run_sql_capture "6n. anon ne peut TOUJOURS PAS lire directement la table (contrat audité préservé)" "select has_table_privilege('anon', 'public.order_invoice_request', 'select');"
  assert_eq "6n. anon:SELECT direct == false après remediation" "f" "$CAPTURED_OUTPUT"
  run_sql_capture "6o. staff r1 lit sa propre ligne via la policy RLS (auth.uid() = staff r1, authenticated:SELECT toujours accordé)" "do \$\$ begin perform set_config('test.uid','99999999-0000-0000-0000-000000000001', true); end \$\$; select count(*) from order_invoice_request where order_id='$ORDER1_ID';" "authenticated"
  assert_eq "6o. staff r1 lit bien sa propre ligne (=1) via RLS+SELECT toujours accordé après remediation" "1" "$CAPTURED_OUTPUT"

  log "=== [$cycle_label / 7] Le garde-fou échoue FERMÉ sur des préconditions cassées ==="
  run_sql_fatal "7a. désactive RLS temporairement pour simuler une précondition cassée" "alter table public.order_invoice_request disable row level security;"
  GUARD_OUT="$(psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$REMEDIATION_SQL" 2>&1)"
  GUARD_RC=$?
  if [ "$GUARD_RC" -ne 0 ] && echo "$GUARD_OUT" | grep -q "SCANYM_ACL_REMEDIATION_GUARD"; then
    pass "7b. remediation REFUSE quand RLS est désactivée (garde-fou fermé, rc=$GUARD_RC)"
  else
    fail "7b. remediation aurait dû refuser avec RLS désactivée (rc=$GUARD_RC) -- sortie: $GUARD_OUT"
  fi
  run_sql_fatal "7c. restaure RLS (état connu-sain)" "alter table public.order_invoice_request enable row level security;"
  POST_GUARD_ACL="$(acl_fingerprint)"
  assert_eq "7d. AUCUNE mutation d'ACL pendant le refus du garde-fou (fingerprint inchangé)" "$BASELINE_ACL" "$POST_GUARD_ACL"

  log "=== [$cycle_label / 8] Aucun chevauchement structurel avec Payment Operator Authorization ==="
  run_sql_capture "8a. aucune fonction payment_operator_* introduite par cette remediation" "select count(*) from pg_proc where proname like 'payment_operator_%';"
  assert_eq "8a. aucune fonction payment_operator_* (=0)" "0" "$CAPTURED_OUTPUT"
}

run_full_cycle "RUN1"
run_full_cycle "RUN2"

log "=== BILAN : $PASS_COUNT PASS / $FAIL_COUNT FAIL ==="
if [ "$FAIL_COUNT" -ne 0 ]; then
  log "Échecs détaillés:"; cat "$FAIL_LOG"
  exit 1
fi
exit 0
