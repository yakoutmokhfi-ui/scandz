#!/usr/bin/env bash
# ============================================================
# Scanym — PAYMENT P3-B MONETICO CHECKOUT RUNTIME v3 — Harnais
# reproductible pour
# supabase/DRAFT-lot-payment-p3b-monetico-checkout-runtime-v3.sql.
#
# PostgreSQL communautaire vanilla, même patron que tous les harnais
# paiement précédents (P1..P3-B6). Chaîne complète appliquée pour
# permettre une preuve de non-régression réelle sur TOUTES les
# capacités sœurs dans ce même harnais.
#
# IMPORTANT (leçon opérationnelle héritée du lot P3-B4/P3-B5) : ce
# script DOIT être invoqué en tant qu'utilisateur système `postgres`
# DIRECTEMENT (`su postgres -c "bash ..."` ou
# `sudo -u postgres bash ...`), jamais en enveloppant chaque appel
# psql individuel dans son propre `sudo -u postgres`.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/payment-p3b-monetico-checkout-runtime-v3-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_PAYMENT_P1_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p1-foundation.sql"
DRAFT_PAYMENT_P2A_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p2a-secure-config.sql"
DRAFT_PAYMENT_P2BA_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p2b-a-safe-merchant-read.sql"
DRAFT_PAYMENT_P3A0_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3a0-secure-credential-read.sql"
DRAFT_PAYMENT_P3B0_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b0-correlation-status-read.sql"
DRAFT_PAYMENT_P3B1_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b1-runtime-provider-enablement-read.sql"
DRAFT_PAYMENT_P3B2_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b2-order-payment-context-read.sql"
DRAFT_PAYMENT_P3B3_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b3-active-payment-attempt-resume-read.sql"
DRAFT_PAYMENT_P3B4_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b4-provider-runtime-mode-read.sql"
DRAFT_PAYMENT_P3B5_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b5-durable-provider-callback-inbox.sql"
DRAFT_PAYMENT_P3B6_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b6-checkout-billing-context.sql"
DRAFT_PAYMENT_V3_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b-monetico-checkout-runtime-v3.sql"
DB="scanym_payment_p3bmcr_v3_$$"
DB_DRIFT="scanym_payment_p3bmcr_v3_drift_$$"

PASS_COUNT=0
FAIL_COUNT=0
STRUCT_COUNT=0
BEHAV_COUNT=0
CONC_COUNT=0
FAIL_LOG="/tmp/scanym-payment-p3bmcr-v3-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }
struct() { STRUCT_COUNT=$((STRUCT_COUNT+1)); pass "$@"; }
behav() { BEHAV_COUNT=$((BEHAV_COUNT+1)); pass "$@"; }
conc() { CONC_COUNT=$((CONC_COUNT+1)); pass "$@"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
  rm -f "${FAIL_LOG:-}" 2>/dev/null || true
}
trap cleanup EXIT

assert_struct_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then struct "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_behav_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then behav "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_conc_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then conc "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}

sql() { psql -X -A -q -t -d "$DB" -c "$1"; }

as_service() {
  local query="$1"
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$query" 2>&1
}
as_service_rc() {
  local query="$1"
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p3bmcr-v3-out-$$.txt 2>/tmp/scanym-p3bmcr-v3-err-$$.txt
  echo $?
}
as_service_err() { cat /tmp/scanym-p3bmcr-v3-err-$$.txt; }
as_anon_rc() {
  local query="$1"
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p3bmcr-v3-out-$$.txt 2>/tmp/scanym-p3bmcr-v3-err-$$.txt
  echo $?
}
current_effective_role() {
  local role="$1"
  PGOPTIONS="-c role=$role" psql -X -A -q -t -d "$DB" -c "select current_user;"
}

build_common_bootstrap() {
  local dbname="$1"
  psql -d "$dbname" >/dev/null <<'SQL'
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

build_minimal_chain() {
  local dbname="$1"
  for f in schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql; do
    psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
    psql -d "$dbname" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  done
  for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql; do
    psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  done
}

# MOCK VAULT — TEST HARNESS ONLY.
build_mock_vault() {
  local dbname="$1"
  psql -d "$dbname" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
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
returns uuid language plpgsql as $fn$
declare v_id uuid;
begin
  insert into vault.secrets (secret, name, description, key_id)
    values (new_secret, new_name, new_description, new_key_id)
    returning id into v_id;
  return v_id;
end;
$fn$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null)
returns void language plpgsql as $fn$
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

build_full_chain_through_p3b6() {
  local dbname="$1"
  build_common_bootstrap "$dbname"
  build_minimal_chain "$dbname"
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v83-lot2a4-privilege-hardening.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v84-lot2b1-delivery-info-rpc.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-model.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-lot-b-rpc.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-server-delivery-fulfillment-pricing.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P1_SQL" >/dev/null
  build_mock_vault "$dbname"
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2A_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2BA_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3A0_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B0_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B1_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B2_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B3_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B4_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B5_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B6_SQL" >/dev/null
}

fp() {
  echo -n "$1" | sha256sum | cut -d' ' -f1
}

# ============================================================
# [0] BASELINE — chaîne complète (minimale + P1 + Vault moqué + P2A +
# P2B-A + P3-A0 + P3-B0..P3-B6, toutes déjà publiées) + le LOT SOUS
# TEST (v3).
# ============================================================
log "=== [0] Construction baseline $DB ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
build_full_chain_through_p3b6 "$DB"
struct "chaîne complète appliquée (minimale + P1 + Vault moqué + P2A + P2B-A + P3-A0 + P3-B0..P3-B6)"

assert_struct_eq "0z. contrôle harnais -- PGOPTIONS atteint bien psql (role=anon effectif)" "anon" "$(current_effective_role anon)"

psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_V3_SQL" >/dev/null
struct "DRAFT-lot-payment-p3b-monetico-checkout-runtime-v3.sql appliqué sans erreur (LOT SOUS TEST)"

# ============================================================
# [D] DRIFT / ANTI-DOUBLE-APPLICATION — même chaîne, lot appliqué DEUX
# fois -> échec attendu.
# ============================================================
log "=== [D] Anti double-application ==="
psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
createdb "$DB_DRIFT"
build_full_chain_through_p3b6 "$DB_DRIFT"
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_V3_SQL" >/dev/null
if psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_V3_SQL" >/tmp/scanym-p3bmcr-v3-drift-$$.txt 2>&1; then
  fail "Da. seconde application du lot v3 aurait dû échouer (garde anti double-application) -- elle a réussi"
else
  if grep -q "SCANYM_SCHEMA_DRIFT" /tmp/scanym-p3bmcr-v3-drift-$$.txt; then
    struct "Da. seconde application du lot v3 rejetée par la garde anti double-application (SCANYM_SCHEMA_DRIFT)"
  else
    fail "Da. seconde application du lot v3 a échoué mais PAS avec SCANYM_SCHEMA_DRIFT -- $(cat /tmp/scanym-p3bmcr-v3-drift-$$.txt)"
  fi
fi
rm -f /tmp/scanym-p3bmcr-v3-drift-$$.txt

# ============================================================
# [1] STRUCTUREL — get_order_payment_status_snapshot (SEULE fonction
# de ce lot -- cancel_payment_attempt a été retirée avant application,
# voir OPEN GAP en tête du fichier SQL sous test).
# ============================================================
log "=== [1] STRUCTUREL ==="
assert_struct_eq "1z. cancel_payment_attempt N'EXISTE PAS (retirée du périmètre v3 -- OPEN GAP assumé)" "0" "$(sql "select count(*) from pg_proc where proname='cancel_payment_attempt';")"

assert_struct_eq "1g. get_order_payment_status_snapshot existe (2 arguments)" "1" "$(sql "select count(*) from pg_proc where proname='get_order_payment_status_snapshot' and pronargs=2;")"
assert_struct_eq "1h. get_order_payment_status_snapshot SECURITY DEFINER" "t" "$(sql "select prosecdef from pg_proc where proname='get_order_payment_status_snapshot';")"
assert_struct_eq "1i. get_order_payment_status_snapshot volatilité = stable (lecture pure)" "s" "$(sql "select provolatile from pg_proc where proname='get_order_payment_status_snapshot';")"
assert_struct_eq "1j. get_order_payment_status_snapshot EXECUTE service_role=OUI" "t" "$(sql "select has_function_privilege('service_role','get_order_payment_status_snapshot(uuid,uuid)','EXECUTE');")"
assert_struct_eq "1k. get_order_payment_status_snapshot EXECUTE anon=NON" "f" "$(sql "select has_function_privilege('anon','get_order_payment_status_snapshot(uuid,uuid)','EXECUTE');")"
assert_struct_eq "1l. get_order_payment_status_snapshot EXECUTE authenticated=NON" "f" "$(sql "select has_function_privilege('authenticated','get_order_payment_status_snapshot(uuid,uuid)','EXECUTE');")"

log "=== [1] NON-RÉGRESSION — AUCUN grant de table nouveau ==="
assert_struct_eq "1m. service_role toujours AUCUN privilège direct sur payment_transactions" "0" "$(sql "select (has_table_privilege('service_role','payment_transactions','SELECT') or has_table_privilege('service_role','payment_transactions','INSERT') or has_table_privilege('service_role','payment_transactions','UPDATE') or has_table_privilege('service_role','payment_transactions','DELETE'))::int;")"
assert_struct_eq "1n. service_role toujours AUCUN privilège direct sur payment_provider_events" "0" "$(sql "select (has_table_privilege('service_role','payment_provider_events','SELECT') or has_table_privilege('service_role','payment_provider_events','INSERT') or has_table_privilege('service_role','payment_provider_events','UPDATE') or has_table_privilege('service_role','payment_provider_events','DELETE'))::int;")"
assert_struct_eq "1o. service_role toujours AUCUN privilège direct sur orders" "0" "$(sql "select (has_table_privilege('service_role','orders','SELECT') or has_table_privilege('service_role','orders','INSERT') or has_table_privilege('service_role','orders','UPDATE') or has_table_privilege('service_role','orders','DELETE'))::int;")"

# ============================================================
# Fixtures
# ============================================================
log "=== Fixtures ==="
sql "insert into restaurants (slug, name) values ('v3-r1','V3 R1');" >/dev/null
RID1="$(sql "select id from restaurants where slug='v3-r1';")"
OID1="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID1', 1, 'pickup', 15.00, 15.00, 'EUR') returning id;")"
TOKEN1="$(sql "select public_token from orders where id='$OID1';")"
BADTOKEN="00000000-0000-0000-0000-000000000000"
struct "fixtures : R1(order=$OID1, token=$TOKEN1)"

# ============================================================
# [2] BEHAVIORAL — get_order_payment_status_snapshot (aucune tentative encore)
# ============================================================
log "=== [2] SNAPSHOT — aucune tentative jamais initiée ==="
ROW="$(as_service "select payment_status, coalesce(provider_code,'<null>'), has_observed_refusal from get_order_payment_status_snapshot('$OID1','$TOKEN1');")"
assert_behav_eq "2a. snapshot sans tentative -- payment_status=not_required, provider_code NULL, refusal=f" "not_required|<null>|f" "$ROW"

ROWBAD="$(as_service "select count(*) from get_order_payment_status_snapshot('$OID1','$BADTOKEN');")"
assert_behav_eq "2b. snapshot avec jeton incorrect -- ensemble de résultats vide" "0" "$ROWBAD"

ROWBADORDER="$(as_service "select count(*) from get_order_payment_status_snapshot('00000000-0000-0000-0000-000000000000','$TOKEN1');")"
assert_behav_eq "2c. snapshot avec order_id incorrect -- ensemble de résultats vide" "0" "$ROWBADORDER"

# ============================================================
# [3] BEHAVIORAL — V2-02 : refus enregistré N'ANNULE JAMAIS la
# tentative, un paiement accepté POSTÉRIEUR sur la MÊME référence
# réussit ensuite normalement.
# ============================================================
log "=== [3] V2-02 — refus PUIS paiement accepté tardif sur la MÊME référence ==="
TXN1="$(as_service "select transaction_id from initiate_payment_attempt('$OID1','monetico','ref-v3-r1');")"
struct "3a. tentative pending initiée (txn=$TXN1)"

FP_REFUSAL="$(fp 'monetico|ref-v3-r1|refused|1')"
as_service "select * from record_payment_provider_event('monetico','ref-v3-r1','$FP_REFUSAL','refused','60','15.00','EUR',null);" >/dev/null
STATUS_AFTER_REFUSAL="$(sql "select status from payment_transactions where provider_reference='ref-v3-r1';")"
assert_behav_eq "3b. après enregistrement d'un refus (P3-B5), la tentative reste PENDING (JAMAIS confirm_payment_attempt('failed'))" "pending" "$STATUS_AFTER_REFUSAL"

SNAP_AFTER_REFUSAL="$(as_service "select payment_status, has_observed_refusal from get_order_payment_status_snapshot('$OID1','$TOKEN1');")"
assert_behav_eq "3c. snapshot après refus -- payment_status toujours pending, has_observed_refusal=t" "pending|t" "$SNAP_AFTER_REFUSAL"

CONFIRM_PAID="$(as_service "select status from confirm_payment_attempt('monetico','ref-v3-r1','paid');")"
assert_behav_eq "3d. V2-02 CENTRAL -- paiement accepté POSTÉRIEUR sur la même référence après un refus RÉUSSIT (aucune redéfinition de confirm_payment_attempt requise)" "paid" "$CONFIRM_PAID"

SNAP_AFTER_PAID="$(as_service "select payment_status, has_observed_refusal from get_order_payment_status_snapshot('$OID1','$TOKEN1');")"
assert_behav_eq "3e. snapshot après paiement accepté -- payment_status=paid, has_observed_refusal reste t (historique préservé)" "paid|t" "$SNAP_AFTER_PAID"

# ============================================================
# [4] BEHAVIORAL — OPEN GAP : aucune capacité de sortie d'une
# tentative 'pending' n'existe dans ce lot. On prouve explicitement le
# comportement ASSUMÉ (une tentative bloquée empêche une nouvelle
# tentative, MAIS reste capable d'accepter un paiement accepté tardif,
# MÊME après un ou plusieurs refus observés -- aucune action
# navigateur/cliente ne peut jamais fermer cette porte).
# ============================================================
log "=== [4] OPEN GAP — comportement assumé d'une tentative pending bloquée ==="
sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID1', 2, 'pickup', 22.00, 22.00, 'EUR') returning id;" >/dev/null
OID2="$(sql "select id from orders where restaurant_id='$RID1' and order_number=2;")"
TOKEN2="$(sql "select public_token from orders where id='$OID2';")"
as_service "select transaction_id from initiate_payment_attempt('$OID2','monetico','ref-v3-r1-stuck');" >/dev/null

RETRY_RC="$(as_service_rc "select transaction_id from initiate_payment_attempt('$OID2','monetico','ref-v3-r1-stuck-retry');")"
assert_behav_eq "4a. OPEN GAP CONFIRMÉ -- tant qu'une tentative reste pending, initiate_payment_attempt refuse une nouvelle tentative pour la même commande (P1 inchangé, aucune capacité de sortie ajoutée)" "1" "$RETRY_RC"
if grep -q "tentative active existe déjà" /tmp/scanym-p3bmcr-v3-err-$$.txt; then
  behav "4b. message de refus de P1 inchangé, comportement conforme à l'OPEN GAP documenté"
else
  fail "4b. message de refus inattendu -- $(as_service_err)"
fi

# Reprise (P3-B3, déjà publiée, INCHANGÉE) reste la SEULE voie -- même
# référence, même montant, même devise -- jamais une nouvelle référence.
RESUME_ROW="$(as_service "select provider_reference, amount, currency from get_order_active_payment_attempt('$OID2','$TOKEN2','monetico');")"
assert_behav_eq "4c. la SEULE voie disponible pour une tentative bloquée est la reprise (P3-B3) -- même référence, même montant/devise" "ref-v3-r1-stuck|22.00|EUR" "$RESUME_ROW"

# La tentative bloquée reste 'pending' -- un ou plusieurs refus
# observés ensuite ne la ferment PAS -- puis un paiement accepté
# TARDIF sur cette MÊME référence, potentiellement APRÈS que le client
# ait cru abandonner, doit rester applicable AUTOMATIQUEMENT.
FP_STUCK_REFUSAL_1="$(fp 'monetico|ref-v3-r1-stuck|refused|1')"
as_service "select * from record_payment_provider_event('monetico','ref-v3-r1-stuck','$FP_STUCK_REFUSAL_1','refused','60','22.00','EUR',null);" >/dev/null
FP_STUCK_REFUSAL_2="$(fp 'monetico|ref-v3-r1-stuck|refused|2')"
as_service "select * from record_payment_provider_event('monetico','ref-v3-r1-stuck','$FP_STUCK_REFUSAL_2','refused','61','22.00','EUR',null);" >/dev/null
STATUS_AFTER_TWO_REFUSALS="$(sql "select status from payment_transactions where provider_reference='ref-v3-r1-stuck';")"
assert_behav_eq "4d. DEUX refus successifs observés (simulant un client qui abandonne après échecs répétés) -- la tentative reste PENDING, aucune action navigateur/refus n'a pu la fermer" "pending" "$STATUS_AFTER_TWO_REFUSALS"

LATE_PAID_STUCK_RC="$(as_service_rc "select status from confirm_payment_attempt('monetico','ref-v3-r1-stuck','paid');")"
assert_behav_eq "4e. INVARIANT CONTRAIGNANT -- un paiement accepté TARDIF sur cette référence bloquée/apparemment abandonnée s'applique AUTOMATIQUEMENT (rc=0), sans AUCUNE réconciliation manuelle" "0" "$LATE_PAID_STUCK_RC"
LATE_PAID_STUCK_STATUS="$(sql "select status from payment_transactions where provider_reference='ref-v3-r1-stuck';")"
assert_behav_eq "4f. état final de la tentative apparemment abandonnée = paid (le navigateur n'a JAMAIS eu le pouvoir de bloquer cette application)" "paid" "$LATE_PAID_STUCK_STATUS"

# Une fois ce paiement appliqué, la commande n'est plus "bloquée" au
# sens du gap -- une nouvelle tentative est refusée pour la BONNE
# raison (déjà payée), jamais pour un verrou orphelin.
POST_RESOLUTION_RC="$(as_service_rc "select transaction_id from initiate_payment_attempt('$OID2','monetico','ref-v3-r1-after-resolution-2');")"
assert_behav_eq "4g. après résolution authentique (paid), une nouvelle tentative sur la commande est refusée pour la BONNE raison (commande déjà payée, pas un verrou orphelin) -- confirme qu'aucun état zombie ne subsiste" "1" "$POST_RESOLUTION_RC"
if grep -q "déjà payée" /tmp/scanym-p3bmcr-v3-err-$$.txt; then
  behav "4h. refus motivé par 'déjà payée' (P1 inchangé), pas par un verrou résiduel du gap"
else
  fail "4h. message de refus inattendu -- $(as_service_err)"
fi

# ============================================================
# [5] CONCURRENCE — Scénario A : deux confirmations 'paid' concurrentes
# sur la MÊME référence (callback dupliqué/rejoué par deux workers --
# vraies sessions psql, pas une simulation). Doit être idempotent :
# les deux réussissent avec le MÊME statut cible, jamais de corruption.
# ============================================================
log "=== [5] CONCURRENCE — Scénario A : double confirmation 'paid' concurrente (callback dupliqué) ==="
sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID1', 3, 'pickup', 9.00, 9.00, 'EUR') returning id;" >/dev/null
OID3="$(sql "select id from orders where restaurant_id='$RID1' and order_number=3;")"
as_service "select transaction_id from initiate_payment_attempt('$OID3','monetico','ref-v3-r1-conc-a');" >/dev/null

TMPCONC="/tmp/scanym-p3bmcr-v3-conc-$$"
mkdir -p "$TMPCONC"
(
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "
    begin;
    select pg_sleep(0.2);
    select status from confirm_payment_attempt('monetico','ref-v3-r1-conc-a','paid');
    commit;
  " > "$TMPCONC/a.out" 2>"$TMPCONC/a.err"
) &
PID_A=$!
(
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "
    begin;
    select pg_sleep(0.2);
    select status from confirm_payment_attempt('monetico','ref-v3-r1-conc-a','paid');
    commit;
  " > "$TMPCONC/b.out" 2>"$TMPCONC/b.err"
) &
PID_B=$!
wait "$PID_A" "$PID_B" || true

RESULT_A="$(tr -d ' \n' < "$TMPCONC/a.out")"
RESULT_B="$(tr -d ' \n' < "$TMPCONC/b.out")"
if [ "$RESULT_A" = "paid" ] && [ "$RESULT_B" = "paid" ]; then
  conc "5a. Scénario A -- deux callbacks 'paid' dupliqués concurrents aboutissent TOUS DEUX à 'paid' (idempotence de replay de confirm_payment_attempt, P1 inchangé) — a='$RESULT_A' b='$RESULT_B'"
else
  fail "5a. Scénario A -- résultat inattendu (a='$RESULT_A' err_a='$(cat "$TMPCONC/a.err")' b='$RESULT_B' err_b='$(cat "$TMPCONC/b.err")')"
fi
FINAL_STATUS_CONC_A="$(sql "select status from payment_transactions where provider_reference='ref-v3-r1-conc-a';")"
assert_conc_eq "5b. Scénario A -- état final déterministe = paid (une seule ligne, aucune corruption, aucune double comptabilisation)" "paid" "$FINAL_STATUS_CONC_A"

# ============================================================
# [5] CONCURRENCE — Scénario B : enregistrement d'un refus (P3-B5)
# CONCURRENT à un callback 'paid' légitime sur la MÊME référence.
# INVARIANT TESTÉ : quel que soit l'ordre d'arrivée, le paiement
# accepté doit TOUJOURS pouvoir s'appliquer -- l'enregistrement d'un
# refus ne pose AUCUN verrou sur payment_transactions (il écrit
# uniquement payment_provider_events), donc ne peut structurellement
# jamais faire échouer la confirmation concurrente.
# ============================================================
log "=== [5] CONCURRENCE — Scénario B : refus (P3-B5) concurrent à un paid callback légitime ==="
sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID1', 4, 'pickup', 11.00, 11.00, 'EUR') returning id;" >/dev/null
OID4="$(sql "select id from orders where restaurant_id='$RID1' and order_number=4;")"
as_service "select transaction_id from initiate_payment_attempt('$OID4','monetico','ref-v3-r1-conc-b');" >/dev/null
FP_CONC_B="$(fp 'monetico|ref-v3-r1-conc-b|refused|concurrent')"

(
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "
    begin;
    select pg_sleep(0.2);
    select provider_event_type from record_payment_provider_event('monetico','ref-v3-r1-conc-b','$FP_CONC_B','refused','60','11.00','EUR',null);
    commit;
  " > "$TMPCONC/c.out" 2>"$TMPCONC/c.err"
) &
PID_C=$!
(
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "
    begin;
    select pg_sleep(0.2);
    select status from confirm_payment_attempt('monetico','ref-v3-r1-conc-b','paid');
    commit;
  " > "$TMPCONC/d.out" 2>"$TMPCONC/d.err"
) &
PID_D=$!
wait "$PID_C" "$PID_D" || true

RESULT_C="$(tr -d ' \n' < "$TMPCONC/c.out")"
RESULT_D="$(tr -d ' \n' < "$TMPCONC/d.out")"
assert_conc_eq "5c. Scénario B -- enregistrement du refus réussit (n'écrit que payment_provider_events, aucun verrou sur payment_transactions)" "refused" "$RESULT_C"
assert_conc_eq "5d. Scénario B INVARIANT CENTRAL -- le paiement accepté concurrent réussit TOUJOURS ('paid'), quel que soit l'ordre d'exécution -- un refus concurrent ne peut structurellement jamais bloquer un paiement légitime" "paid" "$RESULT_D"
FINAL_STATUS_CONC_B="$(sql "select status from payment_transactions where provider_reference='ref-v3-r1-conc-b';")"
assert_conc_eq "5e. Scénario B -- état final déterministe = paid" "paid" "$FINAL_STATUS_CONC_B"

# ============================================================
# [5] CONCURRENCE — Scénario C : deux initiate_payment_attempt
# concurrents pour LA MÊME commande sans tentative préalable --
# reconfirme sous charge concurrente réelle l'invariant "au plus une
# tentative active par commande" (P1, inchangé) qui SOUS-TEND l'OPEN
# GAP documenté (section 4) : exactement un des deux appelants doit
# réussir, l'autre doit être rejeté proprement, jamais les deux
# tentatives actives simultanément.
# ============================================================
log "=== [5] CONCURRENCE — Scénario C : double initiation concurrente (fonde l'OPEN GAP sous charge réelle) ==="
sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID1', 5, 'pickup', 7.00, 7.00, 'EUR') returning id;" >/dev/null
OID5="$(sql "select id from orders where restaurant_id='$RID1' and order_number=5;")"

(
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "
    begin;
    select pg_sleep(0.2);
    select transaction_id from initiate_payment_attempt('$OID5','monetico','ref-v3-r1-conc-c-e');
    commit;
  " > "$TMPCONC/e.out" 2>"$TMPCONC/e.err"
) &
PID_E=$!
(
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "
    begin;
    select pg_sleep(0.2);
    select transaction_id from initiate_payment_attempt('$OID5','monetico','ref-v3-r1-conc-c-f');
    commit;
  " > "$TMPCONC/f.out" 2>"$TMPCONC/f.err"
) &
PID_F=$!
wait "$PID_E" "$PID_F" || true

RESULT_E="$(tr -d ' \n' < "$TMPCONC/e.out")"
RESULT_F="$(tr -d ' \n' < "$TMPCONC/f.out")"
E_NONEMPTY=0; F_NONEMPTY=0
[ -n "$RESULT_E" ] && E_NONEMPTY=1
[ -n "$RESULT_F" ] && F_NONEMPTY=1
WINNERS=$((E_NONEMPTY + F_NONEMPTY))
assert_conc_eq "5f. Scénario C -- exactement UN des deux initiate_payment_attempt concurrents réussit (index unique partiel + verrou commande, P1 inchangé)" "1" "$WINNERS"
PENDING_COUNT_OID5="$(sql "select count(*) from payment_transactions where order_id='$OID5' and status='pending';")"
assert_conc_eq "5g. Scénario C -- au plus une tentative pending pour la commande, même sous course réelle (fonde empiriquement pourquoi l'OPEN GAP existe : ce même verrou empêche aussi tout retry tant qu'aucune capacité de sortie n'existe)" "1" "$PENDING_COUNT_OID5"
rm -rf "$TMPCONC"

# ============================================================
# RÉSUMÉ
# ============================================================
log "=== RÉSUMÉ ==="
log "STRUCTUREL=$STRUCT_COUNT COMPORTEMENTAL=$BEHAV_COUNT CONCURRENCE=$CONC_COUNT PASS_TOTAL=$PASS_COUNT FAIL=$FAIL_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  log "ÉCHECS :"
  cat "$FAIL_LOG"
  exit 1
fi
log "TOUS LES TESTS SONT PASSÉS ($PASS_COUNT/$PASS_COUNT)."
