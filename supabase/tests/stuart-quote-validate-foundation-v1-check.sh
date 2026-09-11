#!/usr/bin/env bash
# ============================================================
# Scanym — STUART LOT A — QUOTE / VALIDATE / ETA / SCHEDULING
# FOUNDATION v1 — Harnais reproductible pour
# supabase/DRAFT-lot-stuart-quote-validate-foundation-v1.sql
# (public.get_delivery_provider_config_status UNIQUEMENT).
#
# MÊME DISCIPLINE que stuart-merchant-credential-foundation-v1-check.sh
# (LOT A-0) : PostgreSQL communautaire vanilla, mock Vault minimal
# (STRICTEMENT pour vérification structurelle/comportementale — pas une
# preuve du chiffrement Vault réel de Production).
#
# CHAÎNE DE BOOTSTRAP : MINIMAL_CHAIN + PAYMENT P1 (même chaîne que
# LOT A-0, réutilisée telle quelle) + DRAFT-lot-stuart-merchant-
# credential-foundation-v1.sql (LOT A-0, préalable obligatoire — la
# fonction testée ici lit la même table) + DRAFT-lot-stuart-quote-
# validate-foundation-v1.sql (STUART LOT A, ce lot).
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/stuart-quote-validate-foundation-v1-check.sh"
# ============================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PAYMENT_P1_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p1-foundation.sql"
LOTA0_SQL="$SUPABASE_DIR/DRAFT-lot-stuart-merchant-credential-foundation-v1.sql"
LOTA_SQL="$SUPABASE_DIR/DRAFT-lot-stuart-quote-validate-foundation-v1.sql"
DB="scanym_lota_qv_$$"

PASS=0
FAIL=0
FAIL_LOG="/tmp/scanym-lota-qv-fails-$$.log"
: > "$FAIL_LOG"

log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS=$((PASS+1)); log "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); printf '%s\n' "$1" >> "$FAIL_LOG"; log "FAIL: $1"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  rm -f "$FAIL_LOG" /tmp/scanym-lota-qv-*-$$.txt 2>/dev/null || true
}
trap cleanup EXIT

sql() { psql -X -A -q -t -d "$DB" -c "$1" 2>/tmp/scanym-lota-qv-err-$$.txt; }
sql_rc() { psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-lota-qv-out-$$.txt 2>/tmp/scanym-lota-qv-err-$$.txt; echo $?; }
sql_err() { cat /tmp/scanym-lota-qv-err-$$.txt 2>/dev/null; }

as_service() {
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$1" 2>/tmp/scanym-lota-qv-err-$$.txt
}
as_service_rc() {
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-lota-qv-out-$$.txt 2>/tmp/scanym-lota-qv-err-$$.txt
  echo $?
}
as_authenticated_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    >/tmp/scanym-lota-qv-out-$$.txt 2>/tmp/scanym-lota-qv-err-$$.txt
  echo $?
}
as_anon_rc() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-lota-qv-out-$$.txt 2>/tmp/scanym-lota-qv-err-$$.txt
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

build_chain() {
  for f in $MINIMAL_CHAIN; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1 || { log "FATAL: échec application $f"; return 1; }
    psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  done
  psql -d "$DB" -v ON_ERROR_STOP=1 -f "$PAYMENT_P1_SQL" >/dev/null 2>&1 || { log "FATAL: échec application payment-p1-foundation"; return 1; }
  return 0
}

build_mock_vault() {
  psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create schema vault;

create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  secret text not null,
  name text,
  description text,
  key_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function vault.create_secret(new_secret text, new_name text, new_description text, new_key_id uuid default null)
returns uuid
language plpgsql
as $fn$
declare
  v_id uuid;
begin
  insert into vault.secrets (secret, name, description, key_id)
    values (new_secret, new_name, new_description, new_key_id)
    returning id into v_id;
  return v_id;
end;
$fn$;

create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null)
returns void
language plpgsql
as $fn$
begin
  update vault.secrets
    set secret = coalesce(new_secret, secret),
        name = coalesce(new_name, name),
        description = coalesce(new_description, description),
        key_id = coalesce(new_key_id, key_id),
        updated_at = now()
    where id = secret_id;
end;
$fn$;

create view vault.decrypted_secrets as
  select id, secret as decrypted_secret, name, description, key_id, created_at, updated_at
  from vault.secrets;
SQL
}

log "=== Construction chaîne MINIMAL_CHAIN + PAYMENT P1 + mock Vault ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
psql -c "create database \"$DB\";" >/dev/null
build_common_bootstrap
build_chain || { log "FATAL: bootstrap échoué"; exit 1; }
build_mock_vault

log "=== Application de DRAFT-lot-stuart-merchant-credential-foundation-v1.sql (LOT A-0, préalable) ==="
RC0=$(sql_rc "\i $LOTA0_SQL")
if [ "$RC0" -ne 0 ]; then
  log "FATAL: application LOT A-0 échouée : $(sql_err)"
  exit 1
fi
pass "Application LOT A-0 (préalable) -- exit 0"

log "=== Application de DRAFT-lot-stuart-quote-validate-foundation-v1.sql (STUART LOT A) ==="
RC=$(sql_rc "\i $LOTA_SQL")
if [ "$RC" -ne 0 ]; then
  log "FATAL: application du lot échouée : $(sql_err)"
  exit 1
fi
pass "Application du lot -- exit 0"

RID_A=$(sql "insert into public.restaurants (slug, name, is_active) values ('lota-qv-merchant-a','STUART LOT A Merchant A', true) returning id;")
RID_B=$(sql "insert into public.restaurants (slug, name, is_active) values ('lota-qv-merchant-b','STUART LOT A Merchant B', true) returning id;")
RID_NOCFG=$(sql "insert into public.restaurants (slug, name, is_active) values ('lota-qv-merchant-nocfg','STUART LOT A Merchant No Config', true) returning id;")

as_service "select set_delivery_provider_credentials('$RID_A'::uuid, 'stuart', '{\"clientId\":\"a-client-id\",\"clientSecret\":\"a-secret\"}', 'sandbox');" >/dev/null
as_service "select set_delivery_provider_credentials('$RID_B'::uuid, 'stuart', '{\"clientId\":\"b-client-id\",\"clientSecret\":\"b-secret\"}', 'production');" >/dev/null

log "=== [1-2] Lecture correcte des métadonnées (mode + statut), par restaurant ==="
ROW_A=$(as_service "select config_id, provider_code, mode, configuration_status from get_delivery_provider_config_status('$RID_A'::uuid, 'stuart');")
assert_contains "1. Merchant A -- mode sandbox retourné" "sandbox" "$ROW_A"
assert_contains "1b. Merchant A -- provider_code stuart retourné" "stuart" "$ROW_A"

ROW_B=$(as_service "select config_id, provider_code, mode, configuration_status from get_delivery_provider_config_status('$RID_B'::uuid, 'stuart');")
assert_contains "2. Merchant B -- mode production retourné" "production" "$ROW_B"

log "=== [3] Aucun secret dans la valeur retournée ==="
if printf '%s' "$ROW_A" | grep -qF "a-secret"; then
  fail "3. get_delivery_provider_config_status expose le secret Merchant A -- FUITE"
else
  pass "3. get_delivery_provider_config_status ne retourne jamais le secret (Merchant A)"
fi

log "=== [4] Isolation cross-tenant -- portée strictement au restaurant fourni ==="
if printf '%s' "$ROW_A" | grep -qF "production"; then
  fail "4. La lecture Merchant A retourne le mode Merchant B (production) -- fuite cross-tenant"
else
  pass "4. La lecture Merchant A ne retourne jamais le mode Merchant B (isolation cross-tenant confirmée)"
fi

log "=== [5] Configuration introuvable -- échec fermé P0002 ==="
RC5=$(as_service_rc "select * from get_delivery_provider_config_status('00000000-0000-0000-0000-000000000099'::uuid, 'stuart');")
assert_denied "5. Restaurant sans AUCUNE ligne de config -- échec fermé (P0002)" "$RC5"
assert_contains "5b. Message d'erreur déterministe (configuration introuvable), jamais un secret" "SCANYM_DELIVERY_PROVIDER_CONFIG_STATUS" "$(sql_err)"

log "=== [6] Autorisation authenticated / anon refusée ==="
RC6=$(as_authenticated_rc "00000000-0000-0000-0000-000000000001" "select * from get_delivery_provider_config_status('$RID_A'::uuid, 'stuart');")
assert_denied "6. authenticated ne peut PAS appeler get_delivery_provider_config_status directement" "$RC6"

RC7=$(as_anon_rc "select * from get_delivery_provider_config_status('$RID_A'::uuid, 'stuart');")
assert_denied "7. anon ne peut PAS appeler get_delivery_provider_config_status directement" "$RC7"

log "=== [8] service_role autorisé ==="
assert_ok "8. service_role peut appeler get_delivery_provider_config_status" "$(as_service_rc "select * from get_delivery_provider_config_status('$RID_A'::uuid, 'stuart');")"

log "=== [9] Ne touche JAMAIS Vault -- structure de la fonction ==="
FN_DEF=$(sql "select pg_get_functiondef(oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='get_delivery_provider_config_status';")
if printf '%s' "$FN_DEF" | grep -qiE "vault\.|credentials_ref"; then
  fail "9. get_delivery_provider_config_status référence vault.* ou credentials_ref -- ne devrait JAMAIS toucher au secret"
else
  pass "9. get_delivery_provider_config_status ne référence ni vault.* ni credentials_ref (structurellement incapable d'exposer un secret)"
fi

log "=== [10] configuration_status reflète l'état réel (pas de gate sur not_configured) ==="
ROW_NOCFG_RC=$(as_service_rc "select * from get_delivery_provider_config_status('$RID_NOCFG'::uuid, 'stuart');")
assert_denied "10a. Restaurant AUCUNE ligne (jamais configuré) -- échec fermé P0002 (pas de ligne du tout, distinct de not_configured avec ligne)" "$ROW_NOCFG_RC"

log "=== [11] LOT A-0 -- les trois RPC existantes restent inchangées après application de ce lot ==="
LOTA0_FUNCS=$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('set_delivery_provider_credentials','clear_delivery_provider_credentials','get_delivery_provider_credential');")
assert_eq "11. Les 3 RPC LOT A-0 sont toujours présentes après application de STUART LOT A" "3" "$LOTA0_FUNCS"
RESOLVED_A=$(as_service "select get_delivery_provider_credential('$RID_A'::uuid, 'stuart');")
assert_contains "11b. get_delivery_provider_credential (LOT A-0) fonctionne toujours identiquement après ce lot" "a-client-id" "$RESOLVED_A"

echo ""
log "=== BILAN : $PASS PASS / $FAIL FAIL ==="
if [ "$FAIL" -gt 0 ]; then
  echo "--- Échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
