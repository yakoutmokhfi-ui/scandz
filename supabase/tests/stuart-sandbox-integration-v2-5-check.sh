#!/usr/bin/env bash
# ============================================================
# Scanym — DELIVERY STREAM C — STUART SANDBOX INTEGRATION v2.5
# Harnais SQL -- FERMETURE SÉMANTIQUE FINALE
# (STUART-V21-SQL-HARNESS-RELIABILITY-01). AUCUN changement
# runtime/schéma -- Create Job/HTTP déjà fermés (v2.2).
# ============================================================

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_SQL="$SUPABASE_DIR/DRAFT-lot-stuart-sandbox-integration-v2-1.sql"
DRAFT_P1_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p1-foundation.sql"
DB="scanym_stuart_v25_check_$$"
SELFTEST="${STUART_HARNESS_SELFTEST:-}"

PASS_COUNT=0
FAIL_COUNT=0
FAIL_LOG="/tmp/scanym-stuart-v25-fails-$$.log"
: > "$FAIL_LOG"
TMPDIR_H="/tmp/scanym-v25-harness-$$"
mkdir -p "$TMPDIR_H"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }
cleanup() { psql -v ON_ERROR_STOP=1 -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true; rm -rf "$TMPDIR_H" "$FAIL_LOG" 2>/dev/null || true; }
trap cleanup EXIT

run_fatal() {
  local desc="$1"; shift
  if "$@"; then pass "SETUP (fatal-checked): $desc"; else
    local rc=$?
    log "FATAL: $desc a échoué (rc=$rc) -- arrêt immédiat"
    exit 1
  fi
}

run_sql_fatal() {
  local desc="$1" query="$2" role="${3:-}"
  local outfile="$TMPDIR_H/fatal_$RANDOM.out"
  if [ -n "$role" ]; then
    psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "set role $role; $query" > "$outfile" 2>&1
  else
    psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "$query" > "$outfile" 2>&1
  fi
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    log "FATAL: $desc a échoué (rc=$rc) -- sortie: $(cat "$outfile")"
    exit 1
  fi
  pass "SETUP (fatal-checked): $desc"
}

CAPTURED_OUTPUT=""
CAPTURED_RC=0
run_sql_capture() {
  local desc="$1" query="$2" role="${3:-}"
  local outfile="$TMPDIR_H/capture_$RANDOM.out"
  if [ -n "$role" ]; then
    psql -X -A -q -t -F'|' -v ON_ERROR_STOP=1 -d "$DB" -c "set role $role; $query" > "$outfile" 2>&1
  else
    psql -X -A -q -t -F'|' -v ON_ERROR_STOP=1 -d "$DB" -c "$query" > "$outfile" 2>&1
  fi
  CAPTURED_RC=$?
  CAPTURED_OUTPUT="$(cat "$outfile")"
  if [ "$CAPTURED_RC" -ne 0 ]; then
    log "FATAL: $desc a échoué (rc=$CAPTURED_RC) -- sortie: $CAPTURED_OUTPUT"
    exit 1
  fi
  pass "SETUP (fatal-checked, capture): $desc"
}

# expect_sql_failure SANS rôle (jamais de SET ROLE à prouver ici).
expect_sql_failure() {
  local desc="$1" query="$2" expected_marker="$3"
  local outfile="$TMPDIR_H/expectfail_$RANDOM.out"
  psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "$query" > "$outfile" 2>&1
  local rc=$?
  local output; output="$(cat "$outfile")"
  if [ "$rc" -eq 0 ]; then fail "$desc -- ATTENDU un échec, obtenu rc=0. Sortie: $output"; return; fi
  if ! echo "$output" | grep -q "$expected_marker"; then
    fail "$desc -- rc=$rc mais marqueur '$expected_marker' ABSENT. Sortie: $output"; return
  fi
  pass "$desc (rc=$rc, marqueur '$expected_marker' confirmé)"
}

ROLE_SENTINEL_PREFIX="__SCANYM_ROLE_OK__"

# ============================================================
# CORRECTIF v2.5 (mandat §2/§3, HELPER CENTRAL) : preuve EXPLICITE
# que SET ROLE a réussi AVANT d'accepter l'échec attendu de
# l'opération testée -- via une sentinelle SELECT intercalée,
# impossible à confondre avec une sortie d'erreur PostgreSQL.
#
# Séquence exacte : "SET ROLE <role>; SELECT '<sentinelle>'; <requete
# devant échouer>;" avec ON_ERROR_STOP=1 -- psql imprime la
# sentinelle (la SELECT réussit) AVANT de rencontrer l'échec de la
# DERNIÈRE instruction, qui arrête l'exécution avec rc!=0. Si SET
# ROLE lui-même échoue, l'exécution s'arrête AVANT MÊME la
# sentinelle -- elle sera alors ABSENTE de la sortie, ce que ce
# helper détecte explicitement et rejette (mandat §2, "If sentinel
# absent: FAIL").
# ============================================================
expect_sql_failure_after_role() {
  local desc="$1" role="$2" query="$3" expected_marker="$4"
  local sentinel="${ROLE_SENTINEL_PREFIX}:${role}"
  local outfile="$TMPDIR_H/roleexpectfail_$RANDOM.out"
  psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "set role $role; select '$sentinel'; $query" > "$outfile" 2>&1
  local rc=$?
  local output; output="$(cat "$outfile")"

  if ! echo "$output" | grep -qF "$sentinel"; then
    fail "$desc -- sentinelle '$sentinel' ABSENTE -- SET ROLE $role a probablement échoué AVANT l'opération testée, jamais accepté comme preuve d'ACL. Sortie: $output"
    return
  fi
  if [ "$rc" -eq 0 ]; then
    fail "$desc -- SET ROLE $role confirmé (sentinelle présente) MAIS l'opération testée a INATTENDUMENT réussi (rc=0). Sortie: $output"
    return
  fi
  if ! echo "$output" | grep -q "$expected_marker"; then
    fail "$desc -- SET ROLE $role confirmé, échec confirmé (rc=$rc), MAIS marqueur '$expected_marker' ABSENT -- échec possiblement pour une raison NON RELIÉE. Sortie: $output"
    return
  fi
  pass "$desc (SET ROLE $role PROUVÉ réussi via sentinelle, rc=$rc, marqueur '$expected_marker' confirmé)"
}

assert_eq() { local desc="$1" expected="$2" actual="$3"; if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi; }

UUID_REGEX='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
REF_REGEX='^[0-9A-Za-z][0-9A-Za-z_-]*$'

check_ref_format() {
  local ref="$1"
  [ -n "$ref" ] || return 1
  [ "${#ref}" -le 10 ] || return 1
  echo "$ref" | grep -qE "$REF_REGEX"
}

# ============================================================
# CORRECTIF v2.5 (mandat §5-§9) : validateur EXHAUSTIF par nature
# exacte -- reference NON VIDE exigée pour fresh/existing/confirmed
# (jamais seulement "si non vide"), cohérence état/job_id pour
# "existing" énumérée explicitement, "confirmed" exige EXACTEMENT
# is_new_allocation=f ET collision=f (pas d'autre combinaison).
# ============================================================
validate_allocation_row() {
  local desc="$1" kind="$2" row="$3"
  local field_count; field_count=$(echo "$row" | awk -F'|' '{print NF}')
  if [ "$field_count" -ne 6 ]; then
    fail "$desc -- nombre de champs invalide, attendu 6, obtenu $field_count (ligne: '$row')"; return 1
  fi
  local id ref newalloc collision sendstate jobid
  id=$(echo "$row" | cut -d'|' -f1)
  ref=$(echo "$row" | cut -d'|' -f2)
  newalloc=$(echo "$row" | cut -d'|' -f3)
  collision=$(echo "$row" | cut -d'|' -f4)
  sendstate=$(echo "$row" | cut -d'|' -f5)
  jobid=$(echo "$row" | cut -d'|' -f6)

  if [ "$newalloc" != "t" ] && [ "$newalloc" != "f" ]; then
    fail "$desc -- is_new_allocation invalide (attendu 't'/'f', obtenu '$newalloc')"; return 1
  fi
  if [ "$collision" != "t" ] && [ "$collision" != "f" ]; then
    fail "$desc -- collision invalide (attendu 't'/'f', obtenu '$collision')"; return 1
  fi

  case "$kind" in
    fresh)
      echo "$id" | grep -qE "$UUID_REGEX" || { fail "$desc [fresh] -- id doit être un UUID valide, obtenu '$id'"; return 1; }
      check_ref_format "$ref" || { fail "$desc [fresh] -- client_reference invalide/vide (obligatoire), obtenu '$ref'"; return 1; }
      [ "$newalloc" = "t" ] || { fail "$desc [fresh] -- is_new_allocation doit être 't', obtenu '$newalloc'"; return 1; }
      [ "$collision" = "f" ] || { fail "$desc [fresh] -- collision doit être 'f', obtenu '$collision'"; return 1; }
      [ "$sendstate" = "allocated" ] || { fail "$desc [fresh] -- send_state doit être 'allocated', obtenu '$sendstate'"; return 1; }
      [ -z "$jobid" ] || { fail "$desc [fresh] -- stuart_job_id doit être vide, obtenu '$jobid'"; return 1; }
      ;;
    existing)
      echo "$id" | grep -qE "$UUID_REGEX" || { fail "$desc [existing] -- id doit être un UUID valide, obtenu '$id'"; return 1; }
      check_ref_format "$ref" || { fail "$desc [existing] -- client_reference invalide/vide (obligatoire), obtenu '$ref'"; return 1; }
      [ "$newalloc" = "f" ] || { fail "$desc [existing] -- is_new_allocation doit être 'f', obtenu '$newalloc'"; return 1; }
      [ "$collision" = "f" ] || { fail "$desc [existing] -- collision doit être 'f', obtenu '$collision'"; return 1; }
      case "$sendstate" in
        allocated|send_started|terminal_failure)
          [ -z "$jobid" ] || { fail "$desc [existing/$sendstate] -- stuart_job_id doit être vide pour cet état, obtenu '$jobid'"; return 1; }
          ;;
        send_ambiguous)
          [ -z "$jobid" ] || { fail "$desc [existing/send_ambiguous] -- stuart_job_id doit être vide (aucune réconciliation officielle confirmée dans ce lot), obtenu '$jobid'"; return 1; }
          ;;
        created_confirmed)
          [ -n "$jobid" ] || { fail "$desc [existing/created_confirmed] -- stuart_job_id DOIT être non vide, obtenu vide"; return 1; }
          ;;
        *)
          fail "$desc [existing] -- send_state hors vocabulaire exact ('$sendstate')"; return 1
          ;;
      esac
      ;;
    confirmed)
      echo "$id" | grep -qE "$UUID_REGEX" || { fail "$desc [confirmed] -- id doit être un UUID valide, obtenu '$id'"; return 1; }
      check_ref_format "$ref" || { fail "$desc [confirmed] -- client_reference invalide/vide (obligatoire), obtenu '$ref'"; return 1; }
      [ "$newalloc" = "f" ] || { fail "$desc [confirmed] -- is_new_allocation DOIT être 'f' exactement, obtenu '$newalloc'"; return 1; }
      [ "$collision" = "f" ] || { fail "$desc [confirmed] -- collision DOIT être 'f' exactement, obtenu '$collision'"; return 1; }
      [ "$sendstate" = "created_confirmed" ] || { fail "$desc [confirmed] -- send_state doit être 'created_confirmed', obtenu '$sendstate'"; return 1; }
      [ -n "$jobid" ] || { fail "$desc [confirmed] -- stuart_job_id DOIT être non vide"; return 1; }
      ;;
    collision)
      [ -z "$id" ] || { fail "$desc [collision] -- id doit être VIDE (contrat RPC), obtenu '$id'"; return 1; }
      [ -z "$ref" ] || { fail "$desc [collision] -- client_reference doit être VIDE (contrat RPC), obtenu '$ref'"; return 1; }
      [ "$newalloc" = "f" ] || { fail "$desc [collision] -- is_new_allocation doit être 'f' (contrat RPC), obtenu '$newalloc'"; return 1; }
      [ "$collision" = "t" ] || { fail "$desc [collision] -- collision doit être 't', obtenu '$collision'"; return 1; }
      [ -z "$sendstate" ] || { fail "$desc [collision] -- send_state doit être VIDE (contrat RPC), obtenu '$sendstate'"; return 1; }
      [ -z "$jobid" ] || { fail "$desc [collision] -- stuart_job_id doit être VIDE, obtenu '$jobid'"; return 1; }
      ;;
    *)
      fail "$desc -- kind inconnu: '$kind'"; return 1
      ;;
  esac
  pass "$desc -- validation sémantique exhaustive réussie (kind=$kind)"
  return 0
}

build_common_bootstrap() {
  psql -v ON_ERROR_STOP=1 -d "$DB" > "$TMPDIR_H/bootstrap.out" 2>&1 <<'SQL'
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
  [ "$rc" -ne 0 ] && log "détail bootstrap: $(cat "$TMPDIR_H/bootstrap.out")"
  return $rc
}

build_minimal_chain() {
  for f in schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql; do
    if ! psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1; then
      log "FATAL: échec d'application de $f"; return 1
    fi
    if ! psql -v ON_ERROR_STOP=1 -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1; then
      log "FATAL: échec du GRANT après $f"; return 1
    fi
  done
  return 0
}

log "=== [0] Construction ==="
psql -v ON_ERROR_STOP=1 -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
run_fatal "createdb" createdb "$DB"
run_fatal "bootstrap commun" build_common_bootstrap
run_fatal "chaîne minimale" build_minimal_chain
run_fatal "prérequis PAYMENT P1" psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_P1_SQL"
run_fatal "migration Stuart" psql -v VERBOSITY=verbose -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL"

log "=== [2] Fixtures ==="
run_sql_fatal "fixture restaurant 1" "insert into restaurants (id, slug, name) values ('11111111-1111-1111-1111-111111111111', 'r1', 'R1');"
run_sql_fatal "fixture restaurant 2" "insert into restaurants (id, slug, name) values ('22222222-2222-2222-2222-222222222222', 'r2', 'R2');"
run_sql_fatal "fixture commande 1" "insert into orders (id, restaurant_id, order_number, service_mode, subtotal, total, currency, delivery_address, customer_phone) values ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 1, 'delivery', 15.00, 15.00, 'EUR', '1 rue Test, Paris', '+33600000001');"
run_sql_fatal "fixture commande 2" "insert into orders (id, restaurant_id, order_number, service_mode, subtotal, total, currency, delivery_address, customer_phone) values ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', 1, 'delivery', 20.00, 20.00, 'EUR', '2 rue Test, Paris', '+33600000002');"
run_sql_fatal "fixture commande 3" "insert into orders (id, restaurant_id, order_number, service_mode, subtotal, total, currency, delivery_address, customer_phone) values ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', 2, 'delivery', 10.00, 10.00, 'EUR', '3 rue Test, Paris', '+33600000003');"
run_sql_fatal "fixture commande 4" "insert into orders (id, restaurant_id, order_number, service_mode, subtotal, total, currency, delivery_address, customer_phone) values ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 3, 'delivery', 12.00, 12.00, 'EUR', '4 rue Test, Paris', '+33600000004');"
run_sql_fatal "fixture commande 5" "insert into orders (id, restaurant_id, order_number, service_mode, subtotal, total, currency, delivery_address, customer_phone) values ('77777777-7777-7777-7777-777777777777', '22222222-2222-2222-2222-222222222222', 4, 'delivery', 8.00, 8.00, 'EUR', 'x', '+33600000005');"
run_sql_fatal "fixture commande 6" "insert into orders (id, restaurant_id, order_number, service_mode, subtotal, total, currency, delivery_address, customer_phone) values ('88888888-8888-8888-8888-888888888888', '11111111-1111-1111-1111-111111111111', 5, 'delivery', 9.00, 9.00, 'EUR', 'x', '+33600000006');"
run_sql_fatal "fixture commande 7" "insert into orders (id, restaurant_id, order_number, service_mode, subtotal, total, currency, delivery_address, customer_phone) values ('99999999-9999-9999-9999-999999999999', '22222222-2222-2222-2222-222222222222', 6, 'delivery', 11.00, 11.00, 'EUR', 'x', '+33600000007');"

# ============================================================
# AUTO-TEST NÉGATIF : validateur sur lignes malformées (mandat §10)
# -- exercé directement, en dehors de toute exécution SQL, pour
# prouver que le validateur lui-même rejette explicitement chaque
# forme malformée listée. AUCUNE de ces lignes n'est un résultat SQL
# réel -- toutes construites à la main.
# ============================================================
if [ "$SELFTEST" = "validator_malformed_rows" ]; then
  log "=== AUTO-TEST NÉGATIF : validateur sur lignes malformées ==="
  VALID_UUID="11111111-2222-3333-4444-555555555555"
  MALFORMED_DETECTED=0
  TOTAL_CASES=10

  validate_allocation_row "A" "fresh" "$VALID_UUID||t|f|allocated|" && MALFORMED_DETECTED=$((MALFORMED_DETECTED+1)) # ref vide
  validate_allocation_row "B" "existing" "$VALID_UUID|REF0000001|f|f|created_confirmed|" && MALFORMED_DETECTED=$((MALFORMED_DETECTED+1)) # created_confirmed sans job_id
  validate_allocation_row "C" "existing" "$VALID_UUID||f|f|allocated|" && MALFORMED_DETECTED=$((MALFORMED_DETECTED+1)) # ref vide
  validate_allocation_row "D" "confirmed" "$VALID_UUID|REF0000001|t|f|created_confirmed|JOB1" && MALFORMED_DETECTED=$((MALFORMED_DETECTED+1)) # is_new_allocation=t
  validate_allocation_row "E" "confirmed" "$VALID_UUID|REF0000001|f|t|created_confirmed|JOB1" && MALFORMED_DETECTED=$((MALFORMED_DETECTED+1)) # collision=t
  validate_allocation_row "F" "confirmed" "$VALID_UUID||f|f|created_confirmed|JOB1" && MALFORMED_DETECTED=$((MALFORMED_DETECTED+1)) # ref vide
  validate_allocation_row "G" "fresh" "not-a-uuid|REF0000001|t|f|allocated|" && MALFORMED_DETECTED=$((MALFORMED_DETECTED+1)) # UUID malformé
  validate_allocation_row "H" "fresh" "$VALID_UUID|REF0000001|maybe|f|allocated|" && MALFORMED_DETECTED=$((MALFORMED_DETECTED+1)) # booléen invalide
  validate_allocation_row "I" "existing" "$VALID_UUID|REF0000001|f|f|not_a_real_state|" && MALFORMED_DETECTED=$((MALFORMED_DETECTED+1)) # send_state invalide
  validate_allocation_row "J" "collision" "$VALID_UUID||f|t||" && MALFORMED_DETECTED=$((MALFORMED_DETECTED+1)) # id non vide pour collision

  # Chaque appel ci-dessus DEVAIT retourner 1 (échec) -- $MALFORMED_DETECTED
  # ne s'incrémente QUE si validate_allocation_row retourne 0 (succès),
  # ce qui NE DOIT JAMAIS arriver ici. Le compteur FAIL_COUNT interne
  # du validateur (10 fail() attendus) est la preuve réelle.
  log "cas A-J exercés -- $FAIL_COUNT échecs de validation détectés (attendu: $TOTAL_CASES)"
  if [ "$FAIL_COUNT" -ge "$TOTAL_CASES" ] && [ "$MALFORMED_DETECTED" -eq 0 ]; then
    log "AUTO-TEST : le validateur a correctement rejeté les $TOTAL_CASES lignes malformées"
    fail "SELFTEST -- validateur a correctement détecté $FAIL_COUNT lignes malformées sur $TOTAL_CASES attendues (propagation intentionnelle vers un FAIL de harnais pour preuve d'exit != 0)"
  else
    log "ERREUR SELFTEST : le validateur n'a PAS rejeté toutes les lignes malformées attendues (FAIL_COUNT=$FAIL_COUNT, succès inattendus=$MALFORMED_DETECTED)"
    exit 1
  fi
fi

if [ "$SELFTEST" = "set_role_failure" ]; then
  log "=== AUTO-TEST NÉGATIF : SET ROLE vers un rôle inexistant ==="
  expect_sql_failure_after_role "SELFTEST -- SET ROLE vers un rôle inexistant, jamais accepté comme preuve d'ACL" "role_that_does_not_exist_intentionally" "select 1;" "does not exist\|permission denied"
  log "BILAN INTERNE SELFTEST : $PASS_COUNT PASS / $FAIL_COUNT FAIL"
  if [ "$FAIL_COUNT" -eq 0 ]; then
    log "ERREUR SELFTEST : le helper aurait dû rejeter l'absence de sentinelle"
    exit 1
  fi
  echo "--- BILAN : $PASS_COUNT PASS / $FAIL_COUNT FAIL ---"
  exit 1
fi

if [ "$SELFTEST" != "validator_malformed_rows" ]; then
log "=== [3] COMPORTEMENTAL — allocation, idempotence, collision ==="
run_sql_capture "première allocation" "select id, client_reference, is_new_allocation, collision, send_state, stuart_job_id from allocate_stuart_delivery_job('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'sandbox', 'ABCDEF1234');" "service_role"
validate_allocation_row "3a" "fresh" "$CAPTURED_OUTPUT"
ID1="$(echo "$CAPTURED_OUTPUT" | cut -d'|' -f1)"

run_sql_capture "idempotence" "select id, client_reference, is_new_allocation, collision, send_state, stuart_job_id from allocate_stuart_delivery_job('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'sandbox', 'ZZZZZZ9999');" "service_role"
validate_allocation_row "3b" "existing" "$CAPTURED_OUTPUT"
assert_eq "3b. idempotence -- MÊME id" "$ID1" "$(echo "$CAPTURED_OUTPUT" | cut -d'|' -f1)"

log "=== [3b] COLLISION ==="
run_sql_capture "collision réelle" "select id, client_reference, is_new_allocation, collision, send_state, stuart_job_id from allocate_stuart_delivery_job('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', 'sandbox', 'ABCDEF1234');" "service_role"
validate_allocation_row "3c" "collision" "$CAPTURED_OUTPUT"
run_sql_capture "seconde tentative" "select id, client_reference, is_new_allocation, collision, send_state, stuart_job_id from allocate_stuart_delivery_job('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', 'sandbox', 'DIFFERENT1');" "service_role"
validate_allocation_row "3e" "fresh" "$CAPTURED_OUTPUT"

log "=== [4] SÉCURITÉ — RLS + ACL avec preuve de SET ROLE (mandat §17/§18) ==="
run_sql_capture "relrowsecurity" "select relrowsecurity from pg_class where relname='stuart_delivery_jobs';"
assert_eq "4a. RLS activée" "t" "$CAPTURED_OUTPUT"
for role in public anon authenticated service_role; do
  for priv in select insert update delete; do
    run_sql_capture "has_table_privilege($role,$priv)" "select has_table_privilege('$role', 'public.stuart_delivery_jobs', '$priv');"
    assert_eq "4b. has_table_privilege($role, $priv) = false" "f" "$CAPTURED_OUTPUT"
  done
done

for sig in "allocate_stuart_delivery_job(uuid,uuid,text,text)" "mark_stuart_delivery_job_send_started(uuid,uuid,uuid)" "mark_stuart_delivery_job_ambiguous(uuid,uuid,uuid)" "confirm_stuart_delivery_job_created(uuid,uuid,uuid,text)" "mark_stuart_delivery_job_terminal_failure(uuid,uuid,uuid)" "update_stuart_delivery_job_status(uuid,uuid,uuid,text,text,text)"; do
  for role in public anon authenticated; do
    run_sql_capture "EXECUTE($role, $sig)" "select has_function_privilege('$role', 'public.$sig', 'execute');"
    assert_eq "4c. EXECUTE($role, $sig) = false" "f" "$CAPTURED_OUTPUT"
  done
  run_sql_capture "EXECUTE(service_role, $sig)" "select has_function_privilege('service_role', 'public.$sig', 'execute');"
  assert_eq "4c. EXECUTE(service_role, $sig) = true" "t" "$CAPTURED_OUTPUT"
done

for role in anon authenticated; do
  expect_sql_failure_after_role "4d. $role -- EXECUTE refusé (SET ROLE prouvé)" "$role" "select * from allocate_stuart_delivery_job('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'sandbox', 'NNNNNNNNNN');" "permission denied"
  expect_sql_failure_after_role "4e. $role -- accès direct table refusé (SET ROLE prouvé)" "$role" "select * from stuart_delivery_jobs limit 1;" "permission denied"
done
expect_sql_failure_after_role "4f. service_role -- accès direct table refusé MALGRÉ bypassrls (SET ROLE prouvé)" "service_role" "select * from stuart_delivery_jobs limit 1;" "permission denied"

log "=== [5] IMMUTABILITÉ stuart_job_id ==="
run_sql_fatal "send_started" "select mark_stuart_delivery_job_send_started('$ID1', '33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111');" "service_role"
run_sql_fatal "confirm JOB123" "select confirm_stuart_delivery_job_created('$ID1', '33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'JOB123');" "service_role"
run_sql_capture "état après confirmation" "select send_state, stuart_job_id from stuart_delivery_jobs where id='$ID1';"
assert_eq "5a. NULL -> JOB123" "created_confirmed|JOB123" "$CAPTURED_OUTPUT"
run_sql_fatal "rejeu idempotent" "select confirm_stuart_delivery_job_created('$ID1', '33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'JOB123');" "service_role"
run_sql_capture "état après rejeu" "select send_state, stuart_job_id from stuart_delivery_jobs where id='$ID1';"
assert_eq "5b. rejeu -- INCHANGÉ" "created_confirmed|JOB123" "$CAPTURED_OUTPUT"
expect_sql_failure_after_role "5c. JOB456 -- REJETÉ (immutabilité, SET ROLE prouvé)" "service_role" "select confirm_stuart_delivery_job_created('$ID1', '33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'JOB456');" "immuable"

log "=== [6] UNICITÉ (environment, stuart_job_id) ==="
run_sql_capture "allocation commande 5" "select id, client_reference, is_new_allocation, collision, send_state, stuart_job_id from allocate_stuart_delivery_job('77777777-7777-7777-7777-777777777777', '22222222-2222-2222-2222-222222222222', 'sandbox', 'UNIQTEST01');" "service_role"
validate_allocation_row "6-alloc" "fresh" "$CAPTURED_OUTPUT"
ID_OTHER="$(echo "$CAPTURED_OUTPUT" | cut -d'|' -f1)"
run_sql_fatal "send_started commande 5" "select mark_stuart_delivery_job_send_started('$ID_OTHER', '77777777-7777-7777-7777-777777777777', '22222222-2222-2222-2222-222222222222');" "service_role"
expect_sql_failure_after_role "6a. réutilisation JOB123 -- REJETÉE (SET ROLE prouvé)" "service_role" "select confirm_stuart_delivery_job_created('$ID_OTHER', '77777777-7777-7777-7777-777777777777', '22222222-2222-2222-2222-222222222222', 'JOB123');" "duplicate key\|unique"

log "=== [7] CYCLE DE VIE D'ENVOI ==="
run_sql_capture "allocation ambiguïté" "select id, client_reference, is_new_allocation, collision, send_state, stuart_job_id from allocate_stuart_delivery_job('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', 'sandbox', 'AMBIGTEST1');" "service_role"
validate_allocation_row "7-alloc" "fresh" "$CAPTURED_OUTPUT"
ID_AMB="$(echo "$CAPTURED_OUTPUT" | cut -d'|' -f1)"
run_sql_fatal "send_started ambiguïté" "select mark_stuart_delivery_job_send_started('$ID_AMB', '55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111');" "service_role"
run_sql_fatal "mark_ambiguous" "select mark_stuart_delivery_job_ambiguous('$ID_AMB', '55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111');" "service_role"
run_sql_capture "état send_ambiguous" "select send_state, stuart_job_id from stuart_delivery_jobs where id='$ID_AMB';"
assert_eq "7a. send_started -> send_ambiguous persisté" "send_ambiguous|" "$CAPTURED_OUTPUT"
expect_sql_failure_after_role "7b. reprise auto -- REJETÉ (SET ROLE prouvé)" "service_role" "select mark_stuart_delivery_job_send_started('$ID_AMB', '55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111');" "transition invalide"
run_sql_fatal "résolution manuelle" "select confirm_stuart_delivery_job_created('$ID_AMB', '55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', 'JOB789');" "service_role"
run_sql_capture "état après résolution" "select send_state, stuart_job_id from stuart_delivery_jobs where id='$ID_AMB';"
assert_eq "7c. send_ambiguous -> created_confirmed" "created_confirmed|JOB789" "$CAPTURED_OUTPUT"

log "=== [8] STATUTS RAW/KNOWN ==="
run_sql_fatal "update statut connu" "select update_stuart_delivery_job_status('$ID1', '33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'in_progress', null, null);" "service_role"
run_sql_capture "lecture statut connu" "select job_status_raw, job_status_known from stuart_delivery_jobs where id='$ID1';"
assert_eq "8a. statut connu" "in_progress|in_progress" "$CAPTURED_OUTPUT"
run_sql_fatal "update statut futur inconnu" "select update_stuart_delivery_job_status('$ID1', '33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'a_future_unknown_status', null, null);" "service_role"
run_sql_capture "lecture statut futur inconnu" "select job_status_raw, coalesce(job_status_known,'') from stuart_delivery_jobs where id='$ID1';"
assert_eq "8b. statut futur inconnu" "a_future_unknown_status|" "$CAPTURED_OUTPUT"

log "=== [9] POSSESSION ==="
expect_sql_failure_after_role "9a. restaurant_id incorrect -- REJETÉE (SET ROLE prouvé)" "service_role" "select update_stuart_delivery_job_status('$ID1', '33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'finished', null, null);" "possession invalide\|introuvable"

log "=== [10] CROSS-ENVIRONMENT ==="
expect_sql_failure_after_role "10a. cross-environment -- REJETÉE (SET ROLE prouvé)" "service_role" "select * from allocate_stuart_delivery_job('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'production', 'PPPPPPPPPP');" "autre environnement"
run_sql_capture "compte lignes actives commande 1" "select count(*) from stuart_delivery_jobs where order_id='33333333-3333-3333-3333-333333333333' and is_active;"
assert_eq "10b. toujours 1 ligne active" "1" "$CAPTURED_OUTPUT"

log "=== [11] CONCURRENCE RÉELLE — MÊME commande ==="
cat > "$TMPDIR_H/session-a.sql" << SQL
set role service_role;
begin;
select pg_advisory_xact_lock(hashtext('66666666-6666-6666-6666-666666666666'));
select pg_sleep(2);
select * from allocate_stuart_delivery_job('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 'sandbox', 'CONCURR_A');
commit;
SQL
psql -X -A -F'|' -v ON_ERROR_STOP=1 -d "$DB" -f "$TMPDIR_H/session-a.sql" > "$TMPDIR_H/session-a.out" 2>&1 &
PID_A=$!
sleep 0.3
T_B_START=$(date +%s%N)
if [ "$SELFTEST" = "foreground_concurrent_failure" ]; then
  psql -X -A -F'|' -v ON_ERROR_STOP=1 -d "$DB" -c "set role service_role; select this_function_does_not_exist_intentionally();" > "$TMPDIR_H/session-b.out" 2>&1
else
  psql -X -A -F'|' -v ON_ERROR_STOP=1 -d "$DB" -c "set role service_role; select * from allocate_stuart_delivery_job('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 'sandbox', 'CONCURR_B');" > "$TMPDIR_H/session-b.out" 2>&1
fi
RC_B=$?
T_B_END=$(date +%s%N)
wait "$PID_A"
RC_A=$?

if [ "$SELFTEST" = "foreground_concurrent_failure" ]; then
  if [ "$RC_B" -ne 0 ]; then
    log "AUTO-TEST NÉGATIF : session B invalide échouée comme attendu (rc=$RC_B)"
    fail "SELFTEST -- session concurrente de PREMIER PLAN invalide détectée (rc=$RC_B)"
  else
    log "ERREUR SELFTEST : rc=0 inattendu"; exit 1
  fi
else
  if [ "$RC_A" -ne 0 ]; then fail "11-rc. session A échouée (rc=$RC_A)"
  elif [ "$RC_B" -ne 0 ]; then fail "11-rc. session B échouée (rc=$RC_B)"
  else
    pass "11-rc. sessions A/B rc=0 vérifié"
    B_DURATION_MS=$(( (T_B_END - T_B_START) / 1000000 ))
    if [ "$B_DURATION_MS" -gt 1000 ]; then pass "11a. B a bloqué (${B_DURATION_MS}ms)"; else fail "11a. B n'a pas bloqué"; fi
    ROW_A_FINAL=$(grep -A1 "^id|" "$TMPDIR_H/session-a.out" | tail -1)
    ROW_B_FINAL=$(grep -A1 "^id|" "$TMPDIR_H/session-b.out" | tail -1)
    if validate_allocation_row "11-a" "fresh" "$ROW_A_FINAL" && validate_allocation_row "11-b" "existing" "$ROW_B_FINAL"; then
      assert_eq "11b. MÊME id" "$(echo "$ROW_A_FINAL" | cut -d'|' -f1)" "$(echo "$ROW_B_FINAL" | cut -d'|' -f1)"
      assert_eq "11c. référence de A" "CONCURR_A" "$(echo "$ROW_B_FINAL" | cut -d'|' -f2)"
    fi
    run_sql_capture "compte lignes actives concurrence" "select count(*) from stuart_delivery_jobs where order_id='66666666-6666-6666-6666-666666666666' and is_active;"
    assert_eq "11d. 1 ligne active" "1" "$CAPTURED_OUTPUT"
  fi
fi

if [ "$SELFTEST" != "foreground_concurrent_failure" ] && [ "$SELFTEST" != "wrapper_sql_failure" ]; then
log "=== [12] CONCURRENCE RÉELLE — gagnant/perdant EXACT + preuve durable (mandat §11-§16) ==="
cat > "$TMPDIR_H/session-c.sql" << SQL
set role service_role;
begin;
select pg_sleep(1);
select * from allocate_stuart_delivery_job('88888888-8888-8888-8888-888888888888', '11111111-1111-1111-1111-111111111111', 'sandbox', 'SHARED0001');
commit;
SQL
psql -X -A -F'|' -v ON_ERROR_STOP=1 -d "$DB" -f "$TMPDIR_H/session-c.sql" > "$TMPDIR_H/session-c.out" 2>&1 &
PID_C=$!
sleep 0.2
psql -X -A -F'|' -v ON_ERROR_STOP=1 -d "$DB" -c "set role service_role; select * from allocate_stuart_delivery_job('99999999-9999-9999-9999-999999999999', '22222222-2222-2222-2222-222222222222', 'sandbox', 'SHARED0001');" > "$TMPDIR_H/session-d.out" 2>&1
RC_D=$?
wait "$PID_C"
RC_C=$?

if [ "$RC_C" -ne 0 ]; then fail "12-rc. session C échouée (rc=$RC_C)"
elif [ "$RC_D" -ne 0 ]; then fail "12-rc. session D échouée (rc=$RC_D)"
else
  pass "12-rc. sessions C/D rc=0 vérifié"
  ROW_C_FINAL=$(grep -A1 "^id|" "$TMPDIR_H/session-c.out" | tail -1)
  ROW_D_FINAL=$(grep -A1 "^id|" "$TMPDIR_H/session-d.out" | tail -1)

  WINNER_COUNT=0; LOSER_COUNT=0; ROW_WINNER=""; ROW_LOSER=""
  WINNER_ORDER_ID=""; LOSER_ORDER_ID=""; WINNER_RESTAURANT_ID=""
  ORDER_C="88888888-8888-8888-8888-888888888888"; RESTAURANT_C="11111111-1111-1111-1111-111111111111"
  ORDER_D="99999999-9999-9999-9999-999999999999"; RESTAURANT_D="22222222-2222-2222-2222-222222222222"

  COLLISION_C=$(echo "$ROW_C_FINAL" | cut -d'|' -f4)
  COLLISION_D=$(echo "$ROW_D_FINAL" | cut -d'|' -f4)
  if [ "$COLLISION_C" = "f" ]; then WINNER_COUNT=$((WINNER_COUNT+1)); ROW_WINNER="$ROW_C_FINAL"; WINNER_ORDER_ID="$ORDER_C"; WINNER_RESTAURANT_ID="$RESTAURANT_C"; fi
  if [ "$COLLISION_D" = "f" ]; then WINNER_COUNT=$((WINNER_COUNT+1)); ROW_WINNER="$ROW_D_FINAL"; WINNER_ORDER_ID="$ORDER_D"; WINNER_RESTAURANT_ID="$RESTAURANT_D"; fi
  if [ "$COLLISION_C" = "t" ]; then LOSER_COUNT=$((LOSER_COUNT+1)); ROW_LOSER="$ROW_C_FINAL"; LOSER_ORDER_ID="$ORDER_C"; fi
  if [ "$COLLISION_D" = "t" ]; then LOSER_COUNT=$((LOSER_COUNT+1)); ROW_LOSER="$ROW_D_FINAL"; LOSER_ORDER_ID="$ORDER_D"; fi

  assert_eq "16. exactement UN gagnant" "1" "$WINNER_COUNT"
  assert_eq "16. exactement UN perdant" "1" "$LOSER_COUNT"

  if [ "$WINNER_COUNT" = "1" ] && [ "$LOSER_COUNT" = "1" ]; then
    validate_allocation_row "14-winner" "fresh" "$ROW_WINNER"
    assert_eq "15. gagnant -- référence EXACTE SHARED0001" "SHARED0001" "$(echo "$ROW_WINNER" | cut -d'|' -f2)"
    validate_allocation_row "15-loser" "collision" "$ROW_LOSER"
    WINNER_ID=$(echo "$ROW_WINNER" | cut -d'|' -f1)

    # CORRECTIF v2.5 (mandat §11-§12) : vérification DURABLE exacte --
    # id/order_id/restaurant_id/client_reference de la ligne persistée
    # DOIVENT correspondre EXACTEMENT au gagnant retourné par la RPC.
    run_sql_capture "12-durable. ligne durable pour SHARED0001 active" "select id, order_id, restaurant_id, client_reference from stuart_delivery_jobs where client_reference='SHARED0001' and is_active;"
    DURABLE_ID=$(echo "$CAPTURED_OUTPUT" | cut -d'|' -f1)
    DURABLE_ORDER=$(echo "$CAPTURED_OUTPUT" | cut -d'|' -f2)
    DURABLE_RESTAURANT=$(echo "$CAPTURED_OUTPUT" | cut -d'|' -f3)
    DURABLE_REF=$(echo "$CAPTURED_OUTPUT" | cut -d'|' -f4)
    assert_eq "12. id durable == id gagnant RPC" "$WINNER_ID" "$DURABLE_ID"
    assert_eq "12. order_id durable == commande gagnante" "$WINNER_ORDER_ID" "$DURABLE_ORDER"
    assert_eq "12. restaurant_id durable == restaurant gagnant" "$WINNER_RESTAURANT_ID" "$DURABLE_RESTAURANT"
    assert_eq "12. client_reference durable == SHARED0001" "SHARED0001" "$DURABLE_REF"

    # CORRECTIF v2.5 (mandat §13-§14) : le perdant ne doit avoir
    # STRICTEMENT AUCUNE ligne active -- jamais une référence de
    # repli substituée silencieusement.
    run_sql_capture "13. compte lignes actives pour la commande PERDANTE" "select count(*) from stuart_delivery_jobs where order_id='$LOSER_ORDER_ID' and is_active;"
    assert_eq "13. ZÉRO ligne active pour la commande perdante" "0" "$CAPTURED_OUTPUT"

    run_sql_capture "17. compte EXACT de lignes actives SHARED0001 au total" "select count(*) from stuart_delivery_jobs where client_reference='SHARED0001' and is_active;"
    assert_eq "17. EXACTEMENT 1 ligne active SHARED0001" "1" "$CAPTURED_OUTPUT"
  else
    fail "16. contrat gagnant/perdant EXACT non respecté (gagnants=$WINNER_COUNT, perdants=$LOSER_COUNT)"
  fi
fi
fi
fi

log "=== [13] pgcrypto absent ==="
if grep -q "digest(" "$DRAFT_SQL"; then fail "13a. digest()/pgcrypto ne doit jamais réapparaître"; else pass "13a. aucune dépendance pgcrypto"; fi

if [ "$SELFTEST" = "assertion_failure" ]; then
  log "=== AUTO-TEST NÉGATIF : échec d'assertion intentionnel ==="
  assert_eq "SELFTEST -- assertion intentionnellement fausse" "expected_value" "actual_value_deliberately_wrong"
fi

if [ "$SELFTEST" = "concurrent_failure" ]; then
  log "=== AUTO-TEST NÉGATIF : session d'arrière-plan invalide ==="
  cat > "$TMPDIR_H/session-selftest.sql" << 'SQL'
set role service_role;
select this_function_does_not_exist_intentionally();
SQL
  psql -X -A -v ON_ERROR_STOP=1 -d "$DB" -f "$TMPDIR_H/session-selftest.sql" > "$TMPDIR_H/session-selftest.out" 2>&1 &
  PID_SELFTEST=$!
  wait "$PID_SELFTEST"
  RC_SELFTEST=$?
  if [ "$RC_SELFTEST" -ne 0 ]; then
    log "AUTO-TEST : session invalide échouée (rc=$RC_SELFTEST)"
    fail "SELFTEST -- session d'arrière-plan invalide détectée (rc=$RC_SELFTEST)"
  else
    log "ERREUR SELFTEST : rc=0 inattendu"; exit 1
  fi
fi

if [ "$SELFTEST" = "wrapper_sql_failure" ]; then
  log "=== AUTO-TEST NÉGATIF : échec SQL via wrapper multi-commandes ==="
  run_sql_capture "SELFTEST -- requete invalide après SET ROLE" "select this_function_does_not_exist_intentionally();" "service_role"
  log "ERREUR SELFTEST : run_sql_capture aurait dû quitter avant cette ligne"
  exit 1
fi

log "=== BILAN : $PASS_COUNT PASS / $FAIL_COUNT FAIL ==="
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "--- ÉCHECS ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
