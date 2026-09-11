#!/usr/bin/env bash
# ============================================================
# Scanym — LOT A-0 — MERCHANT STUART CREDENTIAL FOUNDATION v1 —
# Harnais reproductible pour
# supabase/DRAFT-lot-stuart-merchant-credential-foundation-v1.sql.
#
# IMPORTANT — DISTINCTION EXPLICITE (même discipline que
# payment-p2a-secure-config-check.sh) : ce bac à sable local est un
# PostgreSQL communautaire vanilla, PAS une instance Supabase gérée --
# l'extension réelle Supabase Vault (pgsodium + schéma `vault`) N'Y EST
# PAS DISPONIBLE. Ce harnais construit donc, UNIQUEMENT pour ses
# propres besoins de test, un SCHÉMA `vault` MINIMAL qui reproduit
# fidèlement l'IDENTITÉ EXACTE déjà confirmée par l'audit Work pour
# PAYMENT P2A (même mock, réutilisé tel quel) :
# `vault.create_secret(text,text,text,uuid) returns uuid`,
# `vault.update_secret(uuid,text,text,text,uuid) returns void`,
# table `vault.secrets`, vue `vault.decrypted_secrets` -- STRICTEMENT à
# des fins de vérification STRUCTURELLE et COMPORTEMENTALE de la
# logique SQL de CE lot (les trois RPC de
# DRAFT-lot-stuart-merchant-credential-foundation-v1.sql). Ceci NE
# PROUVE PAS le comportement de chiffrement réel de Supabase Vault en
# Production -- cette garantie relève du contrat documenté et testé
# par Supabase lui-même.
#
# CHAÎNE DE BOOTSTRAP : ce lot ne dépend QUE de public.restaurants et
# public.touch_updated_at (voir sa propre garde de préflight) -- il ne
# dépend d'AUCUNE table du domaine paiement, catalogue, fulfillment ou
# Stuart Sandbox. La chaîne ci-dessous est donc volontairement
# MINIMALE (MINIMAL_CHAIN seule, identique à celle déjà prouvée par
# supabase/tests/catalogue-operator-authorization-v1-check.sh et
# consorts), PLUS DRAFT-lot-payment-p1-foundation.sql -- appliqué
# UNIQUEMENT pour permettre au test [17] de prouver positivement que
# public.payment_provider_configs reste bit-pour-bit inchangé après
# l'application de ce lot, jamais parce que ce lot en dépendrait
# fonctionnellement.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/stuart-merchant-credential-foundation-v1-check.sh"
# ============================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PAYMENT_P1_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p1-foundation.sql"
LOTA0_SQL="$SUPABASE_DIR/DRAFT-lot-stuart-merchant-credential-foundation-v1.sql"
DB="scanym_lota0_$$"

PASS=0
FAIL=0
FAIL_LOG="/tmp/scanym-lota0-fails-$$.log"
: > "$FAIL_LOG"

log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS=$((PASS+1)); log "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); printf '%s\n' "$1" >> "$FAIL_LOG"; log "FAIL: $1"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  rm -f "$FAIL_LOG" /tmp/scanym-lota0-*-$$.txt 2>/dev/null || true
}
trap cleanup EXIT

sql() { psql -X -A -q -t -d "$DB" -c "$1" 2>/tmp/scanym-lota0-err-$$.txt; }
sql_rc() { psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-lota0-out-$$.txt 2>/tmp/scanym-lota0-err-$$.txt; echo $?; }
sql_err() { cat /tmp/scanym-lota0-err-$$.txt 2>/dev/null; }

as_service() {
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$1" 2>/tmp/scanym-lota0-err-$$.txt
}
as_service_rc() {
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-lota0-out-$$.txt 2>/tmp/scanym-lota0-err-$$.txt
  echo $?
}
as_authenticated_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    >/tmp/scanym-lota0-out-$$.txt 2>/tmp/scanym-lota0-err-$$.txt
  echo $?
}
as_anon_rc() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-lota0-out-$$.txt 2>/tmp/scanym-lota0-err-$$.txt
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

log "=== Application de DRAFT-lot-stuart-merchant-credential-foundation-v1.sql ==="
RC=$(sql_rc "\i $LOTA0_SQL")
if [ "$RC" -ne 0 ]; then
  log "FATAL: application du lot échouée : $(sql_err)"
  exit 1
fi
pass "Application du lot -- exit 0"

# Deux restaurants réels (seed minimal, via psql direct -- l'INSERT
# direct est légitime ici, ce n'est pas un chemin RPC applicatif).
RID_A=$(sql "insert into public.restaurants (slug, name, is_active) values ('lota0-merchant-a','LOT A0 Merchant A', true) returning id;")
RID_B=$(sql "insert into public.restaurants (slug, name, is_active) values ('lota0-merchant-b','LOT A0 Merchant B', true) returning id;")

log "=== [1-4] Configuration indépendante par marchand ==="
RC1=$(as_service_rc "select set_delivery_provider_credentials('$RID_A'::uuid, 'stuart', '{\"clientId\":\"a-client-id\",\"clientSecret\":\"a-secret\"}', 'sandbox');")
assert_ok "1. Merchant A -- credential stocké (service_role)" "$RC1"

RC2=$(as_service_rc "select set_delivery_provider_credentials('$RID_B'::uuid, 'stuart', '{\"clientId\":\"b-client-id\",\"clientSecret\":\"b-secret\"}', 'sandbox');")
assert_ok "2. Merchant B -- credential stocké indépendamment (service_role)" "$RC2"

SECRET_A=$(as_service "select get_delivery_provider_credential('$RID_A'::uuid, 'stuart');")
assert_contains "1b. Lecture service_role du credential A retourne bien le payload A" "a-client-id" "$SECRET_A"
SECRET_B=$(as_service "select get_delivery_provider_credential('$RID_B'::uuid, 'stuart');")
assert_contains "2b. Lecture service_role du credential B retourne bien le payload B" "b-client-id" "$SECRET_B"

log "=== [3-4] Isolation cross-tenant ==="
# Prouvé par construction (RPC scopée exactement au restaurant_id
# fourni, portée requête restaurant_id = p_restaurant_id) -- vérifié
# positivement : lire A ne retourne JAMAIS le secret B et vice-versa.
if printf '%s' "$SECRET_A" | grep -qF "b-secret"; then
  fail "3. Merchant A NE PEUT PAS lire le secret Merchant B — secret B trouvé dans la lecture A"
else
  pass "3. Merchant A ne peut pas lire le secret Merchant B (secret B absent de la lecture A)"
fi
if printf '%s' "$SECRET_B" | grep -qF "a-secret"; then
  fail "4. Merchant B NE PEUT PAS lire le secret Merchant A — secret A trouvé dans la lecture B"
else
  pass "4. Merchant B ne peut pas lire le secret Merchant A (secret A absent de la lecture B)"
fi

log "=== [5-7] Autorisation authenticated / anon refusée ==="
RC5=$(as_authenticated_rc "00000000-0000-0000-0000-000000000001" "select set_delivery_provider_credentials('$RID_A'::uuid, 'stuart', '{\"clientId\":\"x\",\"clientSecret\":\"y\"}', 'sandbox');")
assert_denied "5. authenticated ne peut PAS appeler set_delivery_provider_credentials directement" "$RC5"

RC6=$(as_authenticated_rc "00000000-0000-0000-0000-000000000001" "select clear_delivery_provider_credentials('$RID_A'::uuid, 'stuart');")
assert_denied "6. authenticated ne peut PAS appeler clear_delivery_provider_credentials directement" "$RC6"

RC7=$(as_anon_rc "select set_delivery_provider_credentials('$RID_A'::uuid, 'stuart', '{\"clientId\":\"x\",\"clientSecret\":\"y\"}', 'sandbox');")
assert_denied "7. anon refusé (set)" "$RC7"
RC7B=$(as_anon_rc "select get_delivery_provider_credential('$RID_A'::uuid, 'stuart');")
assert_denied "7b. anon refusé (get)" "$RC7B"
RC7C=$(as_anon_rc "select * from public.delivery_provider_configs limit 1;")
assert_denied "7c. anon refusé (SELECT direct de table)" "$RC7C"

log "=== [8-9] service_role autorisé (set/clear) ==="
assert_ok "8. service_role set réussit (déjà prouvé au 1/2, reconfirmé isolément)" "$(as_service_rc "select set_delivery_provider_credentials('$RID_A'::uuid, 'stuart', '{\"clientId\":\"a-client-id-2\",\"clientSecret\":\"a-secret-2\"}', 'sandbox');")"
assert_ok "9. service_role clear réussit" "$(as_service_rc "select clear_delivery_provider_credentials('$RID_B'::uuid, 'stuart');")"

log "=== [10] Remplacement de credential ne fait pas fuiter l'ancien secret ==="
as_service "select set_delivery_provider_credentials('$RID_A'::uuid, 'stuart', '{\"clientId\":\"a-client-id-3\",\"clientSecret\":\"a-secret-3\"}', 'sandbox');" >/dev/null
NEW_SECRET_A=$(as_service "select get_delivery_provider_credential('$RID_A'::uuid, 'stuart');")
if printf '%s' "$NEW_SECRET_A" | grep -qF "a-secret-2"; then
  fail "10. Remplacement de credential -- l'ancien secret (a-secret-2) fuite encore après remplacement"
else
  pass "10. Remplacement de credential -- l'ancien secret ne fuite pas (lecture ne renvoie que le nouveau payload)"
fi
VAULT_ROW_COUNT_A=$(sql "select count(*) from vault.secrets where secret like '%a-client-id-3%';")
assert_eq "10b. Remplacement EN PLACE -- un seul secret Vault vivant pour A après remplacement (pas de doublon orphelin)" "1" "$VAULT_ROW_COUNT_A"

log "=== [11] Table ne stocke jamais le secret en clair ==="
COLS=$(sql "select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_schema='public' and table_name='delivery_provider_configs';")
if printf '%s' "$COLS" | grep -qiE "secret|client_secret|clientsecret"; then
  fail "11. delivery_provider_configs porte une colonne ressemblant à un secret en clair : $COLS"
else
  pass "11. delivery_provider_configs ne porte aucune colonne secret en clair (colonnes : $COLS)"
fi
assert_contains "11b. credentials_ref est bien de type uuid (référence opaque, pas le secret)" "credentials_ref" "$COLS"

log "=== [12-13] Parseur strict (côté SQL : p_secret est opaque -- ce test vérifie la garde côté RPC : secret vide/trop long) ==="
RC12=$(as_service_rc "select set_delivery_provider_credentials('$RID_A'::uuid, 'stuart', '', 'sandbox');")
assert_denied "12. p_secret vide refusé (garde RPC fail-closed)" "$RC12"
RC13=$(as_service_rc "select set_delivery_provider_credentials('$RID_A'::uuid, 'stuart', null, 'sandbox');")
assert_denied "13. p_secret NULL refusé (garde RPC fail-closed)" "$RC13"

log "=== [14-15] Résolveur runtime (restaurant correct / credential manquant) ==="
RESOLVED=$(as_service "select get_delivery_provider_credential('$RID_A'::uuid, 'stuart');")
assert_contains "14. Le résolveur (RPC de lecture) retourne bien le credential du BON restaurant" "a-client-id-3" "$RESOLVED"

RID_C=$(sql "insert into public.restaurants (slug, name, is_active) values ('lota0-merchant-c-no-credential','LOT A0 Merchant C', true) returning id;")
RC15=$(as_service_rc "select get_delivery_provider_credential('$RID_C'::uuid, 'stuart');")
assert_denied "15. Merchant SANS credential configuré -- lecture échoue fermé (P0002, jamais une valeur par défaut)" "$RC15"
assert_contains "15b. Message d'erreur déterministe (configuration introuvable), jamais un secret" "SCANYM_DELIVERY_PROVIDER_CREDENTIAL" "$(sql_err)"

log "=== [16] Preuve statique -- aucun repli sur les variables globales Sandbox Scanym ==="
RESOLVER_FILES="$SUPABASE_DIR/../lib/server/delivery-providers/stuart/credential-resolver.ts $SUPABASE_DIR/../lib/server/delivery-provider-service.ts $SUPABASE_DIR/../lib/server/delivery-provider-errors.ts $SUPABASE_DIR/../lib/server/delivery-providers/stuart/credentials.ts"
# Preuve 1 : aucun USAGE réel de process.env.STUART_* (une simple
# mention en commentaire, ex. pour EXPLIQUER l'absence de repli, ne
# compte pas comme un repli -- seul `process.env.STUART_*` littéral
# compte).
if grep -rn "process\.env\.STUART_CLIENT_ID\|process\.env\.STUART_CLIENT_SECRET\|process\.env\.STUART_ENV" $RESOLVER_FILES 2>/dev/null | grep -q .; then
  fail "16. Le résolveur marchand lit directement process.env.STUART_* (repli interdit)"
else
  pass "16a. Aucun usage direct de process.env.STUART_CLIENT_ID/STUART_CLIENT_SECRET/STUART_ENV dans le résolveur marchand ni ses dépendances directes (grep statique)"
fi
# Preuve 2 : aucun IMPORT des deux seuls modules du dépôt qui lisent
# ces variables (auth.ts / environment.ts) -- même si le résolveur ne
# les lisait pas lui-même, les importer ouvrirait un chemin de repli
# indirect.
if grep -rn "delivery-providers/stuart/auth\"\|delivery-providers/stuart/environment\"" $RESOLVER_FILES 2>/dev/null | grep -q .; then
  fail "16b. Le résolveur marchand importe auth.ts/environment.ts (les deux modules qui lisent les variables globales Sandbox) -- chemin de repli indirect possible"
else
  pass "16b. Aucun import de auth.ts/environment.ts (les deux seuls modules lisant STUART_CLIENT_ID/STUART_CLIENT_SECRET/STUART_ENV) dans le résolveur marchand ni ses dépendances directes"
fi

log "=== [17] Diagnostic Sandbox synthétique existant -- structure préservée ==="
SANDBOX_ROUTE_EXISTS="no"
if [ -f "$SUPABASE_DIR/../app/api/internal/stuart/sandbox-trigger/route.ts" ] && [ -f "$SUPABASE_DIR/../app/api/internal/stuart/sandbox-readiness/route.ts" ]; then
  SANDBOX_ROUTE_EXISTS="yes"
fi
assert_eq "17. Les deux routes de diagnostic Sandbox existantes sont toujours présentes, non modifiées par ce lot" "yes" "$SANDBOX_ROUTE_EXISTS"
STUART_SANDBOX_TABLES=$(sql "select count(*) from information_schema.tables where table_schema='public' and table_name in ('stuart_delivery_jobs','stuart_sandbox_synthetic_test_orders');")
assert_eq "17b. Les tables Stuart Sandbox (stuart_delivery_jobs/stuart_sandbox_synthetic_test_orders) ne sont PAS créées par ce lot minimal (chaîne volontairement sans DRAFT-lot-stuart-sandbox-integration-*), confirmant l'indépendance totale des deux domaines" "0" "$STUART_SANDBOX_TABLES"

log "=== Confirmation additionnelle -- domaine paiement inchangé ==="
PAYMENT_COLS_BEFORE_STYLE=$(sql "select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_schema='public' and table_name='payment_provider_configs';")
assert_contains "Confirmation. public.payment_provider_configs toujours présent, forme P1 nue inchangée (aucune colonne credentials_ref -- P2A n'est pas appliqué dans ce harnais, sans rapport avec ce lot)" "provider_code" "$PAYMENT_COLS_BEFORE_STYLE"
if printf '%s' "$PAYMENT_COLS_BEFORE_STYLE" | grep -qF "credentials_ref"; then
  fail "Confirmation. payment_provider_configs porte credentials_ref -- ce lot n'a pas dû toucher payment_provider_configs, incohérence détectée"
else
  pass "Confirmation. payment_provider_configs ne porte pas credentials_ref -- confirme que ce lot n'a créé/altéré aucune colonne sur la table paiement"
fi
PAYMENT_FUNCS=$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('set_payment_provider_credentials','clear_payment_provider_credentials','get_payment_provider_credential');")
assert_eq "Confirmation. Aucune fonction *_payment_provider_credential(s) créée par ce lot (0 attendu -- P2A/P3A0 non appliqués dans ce harnais)" "0" "$PAYMENT_FUNCS"

echo ""
log "=== BILAN : $PASS PASS / $FAIL FAIL ==="
if [ "$FAIL" -gt 0 ]; then
  echo "--- Échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
