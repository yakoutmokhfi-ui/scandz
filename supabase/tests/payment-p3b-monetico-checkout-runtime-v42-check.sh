#!/usr/bin/env bash
# ============================================================
# Scanym — PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.2 — Harnais
# reproductible pour la correction de P3BV41-RECOVERY-STARVATION-01
# (audit de travail v4.1 indépendant, blocage HIGH).
#
# Ce lot NE crée AUCUN nouveau fichier SQL de migration -- il exerce la
# correction appliquée EN PLACE (mandat, précédent déjà établi par
# PAYMENT P3-B5 v1->v2) dans :
#   - supabase/DRAFT-lot-payment-p3b5-durable-provider-callback-inbox.sql
#     (colonne next_attempt_at, éligibilité de claim_payment_provider_
#     events, backoff/plafond/escalade dans
#     update_payment_provider_event_processing_status)
#   - supabase/DRAFT-lot-payment-p3b-monetico-checkout-runtime-v4.sql
#     (éligibilité IDENTIQUE dans claim_payment_provider_event_by_id)
#
# MÊME PostgreSQL communautaire vanilla, MÊME chaîne complète que
# payment-p3b-monetico-checkout-runtime-v4-check.sh (minimale + P1 +
# Vault moqué + P2A + P2B-A + P3-A0 + P3-B0..P3-B6 + PAYMENT P3-B
# MONETICO CHECKOUT RUNTIME v3 + v4) -- toutes DÉJÀ publiées, y compris
# la correction v4.2 elle-même (appliquée en place dans P3-B5/v4, pas
# un fichier séparé) -- ce harnais exerce donc le COMPORTEMENT NOUVEAU
# sur la chaîne réellement appliquée par tout autre harnais.
#
# PREUVE OBLIGATOIRE, NON NÉGOCIABLE (mandat P3BV41-RECOVERY-STARVATION-01,
# section [5] ci-dessous) : >=20 évènements "poison" (échec permanent,
# plus anciens) + 1 évènement authentique payé (plus récent), batch_size
# 20 -- preuve que les évènements poison ne monopolisent JAMAIS
# indéfiniment chaque lot et que l'évènement authentique plus récent
# devient revendicable et est traité avec succès.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/payment-p3b-monetico-checkout-runtime-v42-check.sh"
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
DRAFT_PAYMENT_V4_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b-monetico-checkout-runtime-v4.sql"
DRAFT_PAYMENT_V46_FORWARD_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b-monetico-checkout-runtime-v46-forward.sql"
DB="scanym_payment_p3bmcr_v42_$$"

PASS_COUNT=0
FAIL_COUNT=0
STRUCT_COUNT=0
BEHAV_COUNT=0
FAIL_LOG="/tmp/scanym-payment-p3bmcr-v42-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }
struct() { STRUCT_COUNT=$((STRUCT_COUNT+1)); pass "$@"; }
behav() { BEHAV_COUNT=$((BEHAV_COUNT+1)); pass "$@"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
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
assert_behav_true() {
  local desc="$1" cond="$2"
  if [ "$cond" = "1" ] || [ "$cond" = "t" ]; then behav "$desc"; else fail "$desc — condition fausse (obtenu '$cond')"; fi
}

sql() { psql -X -A -q -t -d "$DB" -c "$1"; }
sql_super() { psql -d "$DB" -v ON_ERROR_STOP=1 -c "$1" >/dev/null; }

as_service() {
  local query="$1"
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$query" 2>&1
}
as_service_rc() {
  local query="$1"
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p3bmcr-v42-out-$$.txt 2>/tmp/scanym-p3bmcr-v42-err-$$.txt
  echo $?
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

build_full_chain_through_v4() {
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
  # PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.6 -- ferme
  # P3BV45-SQL-INSTALL-CHAIN-01 : SÉQUENCE UNIQUE ET AUTORITAIRE
  # (mandat §4) -- le VRAI P3-B5 historique (SHA
  # 45da34c37550ea89a1441d73a3ebcef074e35ecfa1738812694c8075771b6af6,
  # sans next_attempt_at) est installé CI-DESSUS, PUIS la migration
  # forward v4.6 est appliquée ICI -- avant P3-B6/v3/v4, exactement
  # dans l'ordre imposé par les dépendances réelles (v3/v4 référencent
  # déjà des fonctions dont le corps suppose next_attempt_at existant,
  # via claim_payment_provider_event_by_id notamment).
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_V46_FORWARD_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B6_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_V3_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_V4_SQL" >/dev/null
}

fp() {
  echo -n "$1" | sha256sum | cut -d' ' -f1
}

# ============================================================
# [0] BASELINE — chaîne complète jusqu'à v4 (VRAI prédécesseur
# historique P3-B5 SANS next_attempt_at, PUIS la migration forward
# v4.6 appliquée explicitement -- ferme P3BV45-SQL-INSTALL-CHAIN-01,
# JAMAIS "P3-B5 enrichi en place").
# ============================================================
log "=== [0] Construction baseline $DB ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
build_full_chain_through_v4 "$DB"
struct "chaîne complète appliquée (minimale + P1 + Vault moqué + P2A + P2B-A + P3-A0 + P3-B0..P3-B5 + migration forward v4.6 + P3-B6 + v3 + v4)"

OWNER_UID="50000000-0000-0000-0000-000000000001"
psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into auth.users (id, email) values ('$OWNER_UID', 'owner@p3bmcr-v42-fixture.test');
insert into restaurants (name, slug, status) values ('P3BMCR v4.2 Fixture Tenant', 'p3bmcr-v42-fixture-tenant', 'active');
SQL
RID="$(sql "select id from restaurants where slug='p3bmcr-v42-fixture-tenant';")"
psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into restaurant_users (restaurant_id, user_id, role) values ('$RID','$OWNER_UID','owner');" >/dev/null

make_event() {
  # $1 = numéro de commande (unique), $2 = suffixe de référence.
  local n="$1" suffix="$2"
  local oid ref fpv evt
  oid="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID', $n, 'pickup', 10.00, 10.00, 'EUR') returning id;")"
  ref="ref-p3bmcr-v42-$suffix"
  as_service "select * from initiate_payment_attempt('$oid','monetico','$ref');" >/dev/null
  fpv="$(fp "monetico|$ref|$suffix")"
  evt="$(as_service "select id from record_payment_provider_event('monetico','$ref','$fpv','paid','paiement',10.00,'EUR',null);")"
  echo "$evt"
}

# ============================================================
# [1] STRUCTUREL — next_attempt_at (colonne + éligibilité partagée).
# ============================================================
log "=== [1] STRUCTUREL — next_attempt_at ==="
assert_struct_eq "1a. colonne next_attempt_at existe sur payment_provider_events" "1" "$(sql "select count(*) from information_schema.columns where table_schema='public' and table_name='payment_provider_events' and column_name='next_attempt_at';")"
assert_struct_eq "1b. next_attempt_at est timestamptz" "timestamp with time zone" "$(sql "select data_type from information_schema.columns where table_schema='public' and table_name='payment_provider_events' and column_name='next_attempt_at';")"
assert_struct_eq "1c. next_attempt_at est NULLABLE (NULL = immédiatement éligible)" "YES" "$(sql "select is_nullable from information_schema.columns where table_schema='public' and table_name='payment_provider_events' and column_name='next_attempt_at';")"
assert_struct_eq "1d. processing_status accepte failed_terminal (contrainte check)" "1" "$(sql "select (case when exists (select 1 from pg_constraint where conrelid='public.payment_provider_events'::regclass and contype='c' and pg_get_constraintdef(oid) ilike '%failed_terminal%') then 1 else 0 end);")"
assert_struct_eq "1e. claim_payment_provider_events (corps) filtre sur next_attempt_at" "1" "$(sql "select (case when (select prosrc from pg_proc where proname='claim_payment_provider_events') ilike '%next_attempt_at%' then 1 else 0 end);")"
assert_struct_eq "1f. claim_payment_provider_event_by_id (corps) filtre sur next_attempt_at (MÊME politique partagée)" "1" "$(sql "select (case when (select prosrc from pg_proc where proname='claim_payment_provider_event_by_id') ilike '%next_attempt_at%' then 1 else 0 end);")"
assert_struct_eq "1g. update_payment_provider_event_processing_status (corps) calcule un backoff" "1" "$(sql "select (case when (select prosrc from pg_proc where proname='update_payment_provider_event_processing_status') ilike '%next_attempt_at%' then 1 else 0 end);")"

# ============================================================
# [2] COMPORTEMENTAL — premier échec : délai posé, non revendicable
# immédiatement, revendicable après écoulement simulé du délai.
# ============================================================
log "=== [2] COMPORTEMENTAL — premier échec / délai ==="
EVT_A="$(make_event 1 a)"
CLAIM_A="$(as_service "select claim_token from claim_payment_provider_event_by_id('$EVT_A', 60);")"
as_service "select * from update_payment_provider_event_processing_status('$EVT_A', '$CLAIM_A', 'failed_retryable', 'SIMULATED_TRANSIENT');" >/dev/null

RC_A_COUNT="$(sql "select retry_count from payment_provider_events where id='$EVT_A';")"
assert_behav_eq "2a. retry_count = 1 après le premier échec" "1" "$RC_A_COUNT"
NEXT_A_SET="$(sql "select (next_attempt_at is not null)::int from payment_provider_events where id='$EVT_A';")"
assert_behav_eq "2b. next_attempt_at RENSEIGNÉ après failed_retryable" "1" "$NEXT_A_SET"

GAP_A="$(sql "select round(extract(epoch from (next_attempt_at - processed_at)))::int from payment_provider_events where id='$EVT_A';")"
assert_behav_eq "2c. délai de la 1re tentative ratée = 30s (barème EXPLICITE, croissant, plafonné)" "30" "$GAP_A"

ROWCOUNT_IMMEDIATE_RECLAIM="$(as_service "select count(*) from claim_payment_provider_event_by_id('$EVT_A', 60);")"
assert_behav_eq "2d. NON revendicable immédiatement après failed_retryable (next_attempt_at dans le futur) -- ferme P3BV41-RECOVERY-STARVATION-01" "0" "$ROWCOUNT_IMMEDIATE_RECLAIM"
ROWCOUNT_IMMEDIATE_BATCH="$(as_service "select count(*) from claim_payment_provider_events(20, 60) where id='$EVT_A';")"
assert_behav_eq "2e. NON revendicable immédiatement par le lot générique non plus" "0" "$ROWCOUNT_IMMEDIATE_BATCH"

sql_super "update payment_provider_events set next_attempt_at = now() - interval '1 second' where id='$EVT_A';"
CLAIM_A2="$(as_service "select claim_token from claim_payment_provider_event_by_id('$EVT_A', 60);")"
assert_behav_true "2f. délai écoulé (simulé) -> revendicable de nouveau, claim_token NON vide retourné" "$([ -n "$CLAIM_A2" ] && echo 1 || echo 0)"
as_service "select * from update_payment_provider_event_processing_status('$EVT_A', '$CLAIM_A2', 'applied', null);" >/dev/null
FINAL_STATUS_A="$(sql "select processing_status from payment_provider_events where id='$EVT_A';")"
assert_behav_eq "2g. traitement APRÈS reprise réussit normalement (RÉCUPÉRATION TRANSITOIRE complète)" "applied" "$FINAL_STATUS_A"

# ============================================================
# [3] COMPORTEMENTAL — barème de délai croissant (30s/120s/600s/1800s).
# ============================================================
log "=== [3] COMPORTEMENTAL — barème de délai croissant ==="
EVT_B="$(make_event 2 b)"
declare -a EXPECTED_GAPS=(30 120 600 1800 1800)
for i in 1 2 3 4 5; do
  CLAIM_B="$(as_service "select claim_token from claim_payment_provider_event_by_id('$EVT_B', 60);")"
  if [ -z "$CLAIM_B" ]; then
    fail "3.$i. échec de revendication de EVT_B avant la tentative ratée #$i (délai précédent non correctement écoulé dans le harnais)"
    break
  fi
  as_service "select * from update_payment_provider_event_processing_status('$EVT_B', '$CLAIM_B', 'failed_retryable', 'SIMULATED_TRANSIENT');" >/dev/null
  GAP_B="$(sql "select round(extract(epoch from (next_attempt_at - processed_at)))::int from payment_provider_events where id='$EVT_B';")"
  assert_behav_eq "3.$i. tentative ratée #$i -> délai = ${EXPECTED_GAPS[$((i-1))]}s" "${EXPECTED_GAPS[$((i-1))]}" "$GAP_B"
  STATUS_B="$(sql "select processing_status from payment_provider_events where id='$EVT_B';")"
  if [ "$i" -le 4 ]; then
    assert_behav_eq "3.$i. après tentative ratée #$i (<= plafond 5) -- reste failed_retryable" "failed_retryable" "$STATUS_B"
  fi
  sql_super "update payment_provider_events set next_attempt_at = now() - interval '1 second' where id='$EVT_B';"
done

# ============================================================
# [4] COMPORTEMENTAL — plafond de tentatives : escalade AUTORITAIRE vers
# failed_terminal (mandat "bounded maximum retry count").
# ============================================================
log "=== [4] COMPORTEMENTAL — plafond / escalade failed_terminal ==="
RC_B_AFTER_5="$(sql "select retry_count from payment_provider_events where id='$EVT_B';")"
assert_behav_eq "4a. retry_count = 5 après 5 tentatives ratées (le lot [3] ci-dessus)" "5" "$RC_B_AFTER_5"

CLAIM_B6="$(as_service "select claim_token from claim_payment_provider_event_by_id('$EVT_B', 60);")"
assert_behav_true "4b. EVT_B (retry_count=5) reste revendicable (délai écoulé, PAS encore terminal)" "$([ -n "$CLAIM_B6" ] && echo 1 || echo 0)"
as_service "select * from update_payment_provider_event_processing_status('$EVT_B', '$CLAIM_B6', 'failed_retryable', 'SIMULATED_TRANSIENT_6TH');" >/dev/null
STATUS_B_AFTER_6="$(sql "select processing_status from payment_provider_events where id='$EVT_B';")"
assert_behav_eq "4c. 6e demande de failed_retryable AVEC retry_count déjà au plafond -> ESCALADE AUTORITAIRE vers failed_terminal (SQL, jamais laissé à l'appelant)" "failed_terminal" "$STATUS_B_AFTER_6"
NEXT_ATTEMPT_B_TERMINAL="$(sql "select (next_attempt_at is null)::int from payment_provider_events where id='$EVT_B';")"
assert_behav_eq "4d. next_attempt_at redevient NULL pour un évènement failed_terminal (plus jamais éligible, sans objet)" "1" "$NEXT_ATTEMPT_B_TERMINAL"

ROWCOUNT_TERMINAL_RECLAIM="$(as_service "select count(*) from claim_payment_provider_event_by_id('$EVT_B', 60);")"
assert_behav_eq "4e. failed_terminal N'EST PLUS JAMAIS revendicable (par id)" "0" "$ROWCOUNT_TERMINAL_RECLAIM"
ROWCOUNT_TERMINAL_BATCH="$(as_service "select count(*) from claim_payment_provider_events(20, 60) where id='$EVT_B';")"
assert_behav_eq "4f. failed_terminal N'EST PLUS JAMAIS revendicable (par lot)" "0" "$ROWCOUNT_TERMINAL_BATCH"

RC_TERMINAL_REPLAY="$(as_service_rc "select * from update_payment_provider_event_processing_status('$EVT_B', '00000000-0000-0000-0000-000000000000', 'failed_terminal', null);")"
assert_behav_eq "4g. rejeu idempotent failed_terminal->failed_terminal accepté MÊME avec un jeton incorrect (no-op terminal exempté, INCHANGÉ v2)" "0" "$RC_TERMINAL_REPLAY"
RC_TERMINAL_TO_APPLIED="$(as_service_rc "select * from update_payment_provider_event_processing_status('$EVT_B', '00000000-0000-0000-0000-000000000000', 'applied', null);")"
assert_behav_eq "4h. transition failed_terminal->applied (RÉELLE, différente) refusée (verrouillage terminal INCHANGÉ)" "1" "$([ "$RC_TERMINAL_TO_APPLIED" != "0" ] && echo 1 || echo 0)"

# Défense en profondeur -- un évènement qui atteint DÉJÀ le plafond au
# moment de la revendication (p.ex. requalifié après une reprise
# manuelle) reste correctement bloqué EN LECTURE côté RPC de transition
# elle-même (jamais uniquement côté client TypeScript) -- vérifié
# directement au niveau SQL ici (voir aussi tests/v132-...test.ts côté
# TypeScript pour la défense-en-profondeur AVANT même l'appel RPC).
EVT_CAP="$(make_event 3 cap)"
for i in 1 2 3 4 5; do
  CLAIM_CAP="$(as_service "select claim_token from claim_payment_provider_event_by_id('$EVT_CAP', 60);")"
  as_service "select * from update_payment_provider_event_processing_status('$EVT_CAP', '$CLAIM_CAP', 'failed_retryable', 'SIMULATED_TRANSIENT');" >/dev/null
  sql_super "update payment_provider_events set next_attempt_at = now() - interval '1 second' where id='$EVT_CAP';"
done
STATUS_CAP="$(sql "select processing_status from payment_provider_events where id='$EVT_CAP';")"
assert_behav_eq "4i. après 5 échecs successifs, EVT_CAP reste failed_retryable (le plafond escalade à la 6e DEMANDE, pas automatiquement au 5e échec lui-même)" "failed_retryable" "$STATUS_CAP"
# EVT_CAP a été délibérément laissé avec next_attempt_at DANS LE PASSÉ
# par la boucle ci-dessus (pour pouvoir enchaîner les 5 tentatives sans
# attente réelle) -- il resterait donc FAUSSEMENT éligible pour la
# section [5] (preuve de privation) ci-dessous si on ne le finalisait
# pas ici. Consommé proprement (terminal) pour ne pas fausser le compte
# de la preuve de privation, qui doit porter EXCLUSIVEMENT sur les 20
# poison + 1 authentique qu'elle crée elle-même.
CLAIM_CAP_CLEANUP="$(as_service "select claim_token from claim_payment_provider_event_by_id('$EVT_CAP', 60);")"
as_service "select * from update_payment_provider_event_processing_status('$EVT_CAP', '$CLAIM_CAP_CLEANUP', 'failed_terminal', 'TEST_CLEANUP');" >/dev/null

# ============================================================
# [5] PREUVE DE PRIVATION (STARVATION) — MANDAT NON NÉGOCIABLE,
# P3BV41-RECOVERY-STARVATION-01. >=20 évènements "poison" (échec
# permanent, PLUS ANCIENS) + 1 évènement authentique payé (PLUS
# RÉCENT), batch_size=20 -- preuve que les évènements poison ne
# monopolisent JAMAIS indéfiniment chaque lot et que l'évènement
# authentique plus récent devient revendicable et EST TRAITÉ AVEC
# SUCCÈS.
# ============================================================
log "=== [5] PREUVE DE PRIVATION (STARVATION) -- OBLIGATOIRE ==="
POISON_IDS=()
for i in $(seq 1 20); do
  EVT_P="$(make_event $((100 + i)) "poison-$i")"
  CLAIM_P="$(as_service "select claim_token from claim_payment_provider_event_by_id('$EVT_P', 60);")"
  as_service "select * from update_payment_provider_event_processing_status('$EVT_P', '$CLAIM_P', 'failed_retryable', 'SIMULATED_POISON');" >/dev/null
  POISON_IDS+=("$EVT_P")
done
POISON_COUNT="${#POISON_IDS[@]}"
assert_behav_eq "5a. 20 évènements poison créés et marqués failed_retryable (next_attempt_at dans le futur, +30s)" "20" "$POISON_COUNT"

# Pause délibérément ABSENTE ici -- le point de la preuve est que les
# évènements poison restent NON éligibles (next_attempt_at futur) alors
# que l'évènement authentique, créé APRÈS eux (donc plus récent, FIFO
# les placerait derrière eux SANS la correction), n'a JAMAIS échoué et
# est donc immédiatement éligible.
EVT_VALID="$(make_event 200 valid-paid)"

ROWCOUNT_BATCH_DURING_POISON="$(as_service "select count(*) from claim_payment_provider_events(20, 60);")"
assert_behav_eq "5b. lot de taille 20 (== nombre d'évènements poison) pendant leur fenêtre d'inéligibilité -> EXACTEMENT 1 ligne revendiquée (l'évènement authentique, PAS un seul poison)" "1" "$ROWCOUNT_BATCH_DURING_POISON"
ROWCOUNT_BATCH_IS_VALID="$(as_service "select count(*) from claim_payment_provider_events(20, 60) where id='$EVT_VALID';")"
# NOTE : l'appel précédent a DÉJÀ revendiqué EVT_VALID (bail 60s) --
# celui-ci doit donc renvoyer 0 lignes désormais (déjà revendiqué),
# jamais un second appel accidentel qui reclaimerait un poison.
assert_behav_eq "5c. second appel immédiat -> 0 ligne (EVT_VALID déjà sous bail depuis 5b, AUCUN poison n'est devenu éligible entre-temps)" "0" "$ROWCOUNT_BATCH_IS_VALID"

# Le bail de 5b a revendiqué EVT_VALID (implicitement, prouvé par 5b/5c)
# -- on le retrouve pour finaliser et prouver qu'il est traité avec
# SUCCÈS malgré les 20 poison plus anciens toujours en attente.
CLAIM_VALID_TOKEN="$(sql "select claim_token from payment_provider_events where id='$EVT_VALID';")"
assert_behav_true "5d. EVT_VALID porte bien un claim_token (revendiqué par l'appel 5b, PAS orphelin)" "$([ -n "$CLAIM_VALID_TOKEN" ] && [ "$CLAIM_VALID_TOKEN" != "" ] && echo 1 || echo 0)"
as_service "select * from update_payment_provider_event_processing_status('$EVT_VALID', '$CLAIM_VALID_TOKEN', 'applied', null);" >/dev/null
STATUS_VALID="$(sql "select processing_status from payment_provider_events where id='$EVT_VALID';")"
assert_behav_eq "5e. PREUVE DE CLÔTURE — l'évènement authentique plus récent est TRAITÉ AVEC SUCCÈS (applied) malgré 20 évènements poison plus anciens jamais résolus" "applied" "$STATUS_VALID"

# Les 20 poison restent, EUX, encore failed_retryable (pas perdus, pas
# supprimés, pas silencieusement escaladés prématurément) -- prouve que
# la correction n'est pas "ignorer les poison" mais "les DIFFÉRER".
POISON_STILL_RETRYABLE="$(sql "select count(*) from payment_provider_events where processing_status='failed_retryable' and id = any(array['${POISON_IDS[0]}'$(printf ",'%s'" "${POISON_IDS[@]:1}")]::uuid[]);")"
assert_behav_eq "5f. les 20 évènements poison restent TOUS failed_retryable (DIFFÉRÉS, jamais perdus/supprimés/escaladés prématurément)" "20" "$POISON_STILL_RETRYABLE"

# Puis, le délai écoulé (simulé), les poison redeviennent EUX AUSSI
# éligibles -- la privation est BORNÉE (délai), jamais une exclusion
# permanente déguisée.
sql_super "update payment_provider_events set next_attempt_at = now() - interval '1 second' where processing_status = 'failed_retryable';"
ROWCOUNT_POISON_AFTER_DELAY="$(as_service "select count(*) from claim_payment_provider_events(20, 60);")"
assert_behav_eq "5g. délai écoulé (simulé) pour TOUS -> les 20 poison redeviennent éligibles et sont revendiqués (privation BORNÉE, PAS une exclusion permanente)" "20" "$ROWCOUNT_POISON_AFTER_DELAY"

# ============================================================
# [6] NON-RÉGRESSION — bail/lease (claim_expires_at) toujours
# fonctionnel EN PRÉSENCE de next_attempt_at (les deux colonnes sont
# INDÉPENDANTES, ni l'une ni l'autre ne doit casser l'autre).
# ============================================================
log "=== [6] NON-RÉGRESSION — bail/lease avec next_attempt_at présent ==="
EVT_LEASE="$(make_event 300 lease)"
as_service "select id from claim_payment_provider_event_by_id('$EVT_LEASE', 60);" >/dev/null
sql_super "update payment_provider_events set claim_expires_at = now() - interval '1 second' where id='$EVT_LEASE';"
ROWCOUNT_LEASE_RECOVERY="$(as_service "select count(*) from claim_payment_provider_event_by_id('$EVT_LEASE', 60);")"
assert_behav_eq "6a. reprise après expiration de bail toujours fonctionnelle (received, jamais encore échoué, next_attempt_at NULL n'interfère pas)" "1" "$ROWCOUNT_LEASE_RECOVERY"

EVT_STALE="$(make_event 301 stale)"
CLAIM_STALE_1="$(as_service "select claim_token from claim_payment_provider_event_by_id('$EVT_STALE', 60);")"
sql_super "update payment_provider_events set claim_expires_at = now() - interval '1 second' where id='$EVT_STALE';"
CLAIM_STALE_2="$(as_service "select claim_token from claim_payment_provider_event_by_id('$EVT_STALE', 60);")"
RC_STALE_CLAIMANT="$(as_service_rc "select * from update_payment_provider_event_processing_status('$EVT_STALE', '$CLAIM_STALE_1', 'applied', null);")"
assert_behav_eq "6b. réclamant PÉRIMÉ (ancien jeton, un nouveau claimant a déjà repris) -- REJETÉ (fail-closed, INCHANGÉ)" "1" "$([ "$RC_STALE_CLAIMANT" != "0" ] && echo 1 || echo 0)"
as_service "select * from update_payment_provider_event_processing_status('$EVT_STALE', '$CLAIM_STALE_2', 'applied', null);" >/dev/null
STATUS_STALE="$(sql "select processing_status from payment_provider_events where id='$EVT_STALE';")"
assert_behav_eq "6c. le claimant ACTUEL (jeton le plus récent) finalise correctement" "applied" "$STATUS_STALE"

# ============================================================
# [7] NON-RÉGRESSION — capacités sœurs P1..v4 toujours réellement
# fonctionnelles.
# ============================================================
log "=== [7] NON-RÉGRESSION — chaîne P1..v4 ==="
RC_CLAIM_BATCH_STILL_WORKS="$(as_service_rc "select * from claim_payment_provider_events(5, 60);")"
assert_behav_eq "7a. claim_payment_provider_events (P3-B5 v2/v3) toujours réellement fonctionnelle" "0" "$RC_CLAIM_BATCH_STILL_WORKS"
assert_struct_eq "7b. payment_provider_events : AUCUN grant de table nouveau à service_role (RPC-only préservé)" "f" "$(sql "select has_table_privilege('service_role','payment_provider_events','SELECT');")"
RC_RECORD_STILL_WORKS="$(as_service_rc "select * from record_payment_provider_event('monetico','ref-p3bmcr-v42-nonreg','$(fp nonreg)','paid','paiement',1.00,'EUR',null);")"
# Pas de corrélation existante pour cette référence -> échec ATTENDU
# (échec fermé), preuve que record_payment_provider_event reste
# INCHANGÉE dans sa posture de corrélation stricte.
assert_behav_eq "7c. record_payment_provider_event toujours en échec fermé sans corrélation préalable (INCHANGÉ)" "1" "$([ "$RC_RECORD_STILL_WORKS" != "0" ] && echo 1 || echo 0)"

# ============================================================
# INVARIANT FINAL DU HARNAIS.
# ============================================================
log "=== [FIN] BILAN ==="
log "PASS=$PASS_COUNT (struct=$STRUCT_COUNT, behav=$BEHAV_COUNT) FAIL=$FAIL_COUNT"
if [ "$((STRUCT_COUNT + BEHAV_COUNT))" -ne "$PASS_COUNT" ]; then
  echo "HARNAIS INCOHÉRENT : STRUCT_COUNT+BEHAV_COUNT != PASS_COUNT" >&2
  exit 1
fi
if [ "$FAIL_COUNT" -ne 0 ]; then
  echo "----- ÉCHECS -----"
  cat "$FAIL_LOG"
  exit 1
fi
echo "TOUS LES TESTS ONT RÉUSSI : $PASS_COUNT/$PASS_COUNT ($STRUCT_COUNT structurels + $BEHAV_COUNT comportementaux)"
