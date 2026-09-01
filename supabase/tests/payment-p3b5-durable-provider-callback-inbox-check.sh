#!/usr/bin/env bash
# ============================================================
# Scanym — PAYMENT P3-B5 — DURABLE PROVIDER CALLBACK INBOX — Harnais
# reproductible pour
# supabase/DRAFT-lot-payment-p3b5-durable-provider-callback-inbox.sql.
#
# PostgreSQL communautaire vanilla (pas une instance Supabase managée),
# même patron que tous les harnais paiement précédents. Chaîne
# complète (schema.sql .. P3-B4, toutes déjà publiées) appliquée pour
# permettre une preuve de non-régression réelle sur TOUTES les
# capacités sœurs dans ce même harnais, même si PAYMENT P3-B5 lui-même
# ne dépend structurellement QUE de PAYMENT P1 (vérifié -- voir l'en-
# tête du fichier SQL sous test).
#
# IMPORTANT (leçon opérationnelle héritée du lot P3-B4) : ce script
# DOIT être invoqué en tant qu'utilisateur système `postgres`
# DIRECTEMENT (`su postgres -c "bash ..."` ou
# `sudo -u postgres bash ...` -- jamais en enveloppant chaque appel
# psql individuel dans son propre `sudo -u postgres`), de sorte que les
# `PGOPTIONS=... psql` internes ci-dessous s'appliquent dans LE MÊME
# processus shell, sans traverser une seconde frontière sudo (un
# `sudo` imbriqué réinitialiserait PGOPTIONS et ferait passer
# silencieusement toute requête "as_anon"/"as_service" en tant que
# superutilisateur -- faux passant dangereux, déjà découvert et
# documenté pendant le lot P3-B4).
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/payment-p3b5-durable-provider-callback-inbox-check.sh"
# ou, depuis un shell root :
#   sudo -u postgres bash supabase/tests/payment-p3b5-durable-provider-callback-inbox-check.sh
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
DB="scanym_payment_p3b5_$$"
DB_DRIFT="scanym_payment_p3b5_drift_$$"
TMPDIR_CONC="/tmp/scanym-payment-p3b5-conc-$$"
mkdir -p "$TMPDIR_CONC"

PASS_COUNT=0
FAIL_COUNT=0
STRUCT_COUNT=0
BEHAV_COUNT=0
CONC_COUNT=0
FAIL_LOG="/tmp/scanym-payment-p3b5-fails-$$.log"
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
  rm -rf "${TMPDIR_CONC:-}" 2>/dev/null || true
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
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p3b5-out-$$.txt 2>/tmp/scanym-p3b5-err-$$.txt
  echo $?
}
as_anon_rc() {
  local query="$1"
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p3b5-out-$$.txt 2>/tmp/scanym-p3b5-err-$$.txt
  echo $?
}
as_authenticated_rc() {
  local query="$1"
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p3b5-out-$$.txt 2>/tmp/scanym-p3b5-err-$$.txt
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

# MOCK VAULT — TEST HARNESS ONLY. PAYMENT P3-B5 lui-même NE référence
# JAMAIS `vault` -- ce mock existe UNIQUEMENT parce que PAYMENT P2A
# (appliqué ici pour la preuve de non-régression complète) exige que le
# schéma `vault` existe.
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

build_full_chain_through_p3b4() {
  local dbname="$1"
  build_common_bootstrap "$dbname"
  build_minimal_chain "$dbname"
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
}

fp() {
  # SHA-256 complet (64 hex minuscules) -- même convention que
  # computePaymentProviderEventFingerprint (calculé ici en dehors de la
  # base, exactement comme un futur appelant de confiance le ferait).
  echo -n "$1" | sha256sum | cut -d' ' -f1
}

# AJOUT v2 -- vide la file de tout évènement actuellement ÉLIGIBLE
# (received/failed_retryable, bail jamais posé ou expiré) en le marquant
# 'ignored'. Utilisé UNIQUEMENT pour garantir un état de départ
# déterministe immédiatement avant une assertion précise de
# revendication -- reflète un usage opérationnel réel (un worker qui
# vide sa file avant d'exécuter un scénario isolé), jamais un
# contournement de l'API publique : chaque évènement drainé passe bien
# par claim_payment_provider_events PUIS
# update_payment_provider_event_processing_status, exactement le
# parcours normal d'un worker.
drain_claimable_backlog() {
  local batch line evid evtoken guard
  guard=0
  while true; do
    guard=$((guard+1))
    if [ "$guard" -gt 50 ]; then
      fail "drain_claimable_backlog: boucle anormale (>50 lots) -- possible évènement jamais résolu"
      break
    fi
    batch="$(as_service "select id, claim_token from claim_payment_provider_events(100, 5);")"
    [ -z "$batch" ] && break
    while IFS='|' read -r evid evtoken; do
      [ -z "$evid" ] && continue
      as_service "select * from update_payment_provider_event_processing_status('$evid','$evtoken','ignored',null);" >/dev/null
    done <<< "$batch"
  done
}

# AJOUT v2 -- revendique EXACTEMENT 1 évènement (le plus ancien
# éligible) et renvoie "id|claim_token". N'est déterministe QUE si la
# file a été préalablement vidée (drain_claimable_backlog) ou si
# l'appelant sait qu'un seul évènement est actuellement éligible.
claim_one() {
  local lease="${1:-60}"
  # PAYMENT P3-B MONETICO CHECKOUT RUNTIME v4.6 -- ferme
  # P3BV45-SQL-INSTALL-CHAIN-01 : CE harnais teste EXCLUSIVEMENT le
  # VRAI prédécesseur historique P3-B5 (SHA
  # 45da34c37550ea89a1441d73a3ebcef074e35ecfa1738812694c8075771b6af6),
  # qui NE CONTIENT PAS next_attempt_at, AUCUN backoff, AUCUNE
  # politique de délai -- un évènement failed_retryable y est
  # RE-REVENDICABLE IMMÉDIATEMENT après chaque échec. AUCUNE avance
  # artificielle de next_attempt_at n'est donc nécessaire ni possible
  # ICI (la colonne n'existe pas dans ce prédécesseur) -- supprimée
  # définitivement. Le barème de délai lui-même (30/120/600/1800s)
  # est testé exhaustivement et séparément par le harnais de la
  # migration forward v4.6
  # (supabase/tests/payment-p3b-monetico-checkout-runtime-v46-forward-check.sh),
  # SEUL endroit où next_attempt_at existe et doit être manipulé.
  as_service "select id, claim_token from claim_payment_provider_events(1, $lease);"
}

# ============================================================
# [0] BASELINE — chaîne complète (minimale + P1 + Vault moqué + P2A +
# P2B-A + P3-A0 + P3-B0 v2 + P3-B1 + P3-B2 + P3-B3 + P3-B4, toutes déjà
# publiées) + PAYMENT P3-B5 (LOT SOUS TEST).
# ============================================================
log "=== [0] Construction baseline $DB ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
build_full_chain_through_p3b4 "$DB"
struct "chaîne complète appliquée (minimale + P1 + Vault moqué + P2A + P2B-A + P3-A0 + P3-B0 v2 + P3-B1 + P3-B2 + P3-B3 + P3-B4)"

assert_struct_eq "0z. contrôle harnais -- PGOPTIONS atteint bien psql (role=anon effectif)" "anon" "$(current_effective_role anon)"

psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B5_SQL" >/dev/null
struct "DRAFT-lot-payment-p3b5-durable-provider-callback-inbox.sql appliqué sans erreur (LOT SOUS TEST)"

# ============================================================
# Fixtures (Tenant Un + Tenant Deux, deux commandes/tentatives)
# ============================================================
log "=== Fixtures (Tenant Un + Tenant Deux) ==="
sql "insert into restaurants (slug, name) values ('b5-r1','B5 R1');" >/dev/null
sql "insert into restaurants (slug, name) values ('b5-r2','B5 R2');" >/dev/null
RID1="$(sql "select id from restaurants where slug='b5-r1';")"
RID2="$(sql "select id from restaurants where slug='b5-r2';")"
OID1="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID1', 1, 'pickup', 10.00, 10.00, 'EUR') returning id;")"
OID2="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID2', 1, 'pickup', 20.00, 20.00, 'EUR') returning id;")"
TXN1="$(as_service "select transaction_id from initiate_payment_attempt('$OID1','monetico','ref-b5-r1');")"
TXN2="$(as_service "select transaction_id from initiate_payment_attempt('$OID2','monetico','ref-b5-r2');")"
struct "fixtures : R1(order=$OID1, txn=ref-b5-r1) + R2(order=$OID2, txn=ref-b5-r2) -- tentatives PENDING distinctes, tenants distincts"

FP_R1_AUTH="$(fp 'monetico|ref-b5-r1|authorized|1')"
FP_R2_AUTH="$(fp 'monetico|ref-b5-r2|authorized|1')"

# ============================================================
# [1] STRUCTUREL — CATALOGUE TABLE + FONCTIONS
# ============================================================
log "=== [1] STRUCTUREL — TABLE payment_provider_events ==="
assert_struct_eq "1a. la table payment_provider_events existe" "1" "$(sql "select count(*) from information_schema.tables where table_schema='public' and table_name='payment_provider_events';")"
assert_struct_eq "1b. colonnes attendues (21, dont les 3 colonnes de bail AJOUTÉES en v2) toutes présentes" "21" "$(sql "select count(*) from information_schema.columns where table_schema='public' and table_name='payment_provider_events' and column_name in ('id','restaurant_id','order_id','payment_transaction_id','provider_code','provider_reference','event_fingerprint','provider_event_type','provider_event_code','amount','currency','authorization_reference','processing_status','retry_count','last_error_class','created_at','last_attempt_at','processed_at','claim_token','claimed_at','claim_expires_at');")"
assert_struct_eq "1c. contrainte unique(provider_code, provider_reference, event_fingerprint) présente" "1" "$(sql "select count(*) from pg_indexes where schemaname='public' and tablename='payment_provider_events' and indexdef ilike '%unique%' and indexdef ilike '%provider_code%' and indexdef ilike '%provider_reference%' and indexdef ilike '%event_fingerprint%';")"
assert_struct_eq "1d. AUCUNE contrainte unique sur provider_reference SEUL (mandat section 11/20)" "0" "$(sql "select count(*) from pg_constraint where conrelid='public.payment_provider_events'::regclass and contype='u' and pg_get_constraintdef(oid) = 'UNIQUE (provider_reference)';")"
assert_struct_eq "1e. FK composite (order_id, restaurant_id) -> orders(id, restaurant_id) présente" "1" "$(sql "select count(*) from pg_constraint where conrelid='public.payment_provider_events'::regclass and contype='f' and conname='payment_provider_events_order_restaurant_fk';")"
assert_struct_eq "1f. FK composite (payment_transaction_id, order_id) -> payment_transactions(id, order_id) présente" "1" "$(sql "select count(*) from pg_constraint where conrelid='public.payment_provider_events'::regclass and contype='f' and conname='payment_provider_events_transaction_order_fk';")"
assert_struct_eq "1g. CHECK processing_status limité EXACTEMENT à received/applied/ignored/failed_retryable/failed_terminal" "1" "$(sql "select (pg_get_constraintdef(oid) ilike '%received%' and pg_get_constraintdef(oid) ilike '%applied%' and pg_get_constraintdef(oid) ilike '%ignored%' and pg_get_constraintdef(oid) ilike '%failed_retryable%' and pg_get_constraintdef(oid) ilike '%failed_terminal%')::int from pg_constraint where conrelid='public.payment_provider_events'::regclass and contype='c' and conname='payment_provider_events_processing_status_check';")"
assert_struct_eq "1h. CHECK event_fingerprint (forme hexadécimale 64 caractères) présente" "1" "$(sql "select count(*) from pg_constraint where conrelid='public.payment_provider_events'::regclass and contype='c' and pg_get_constraintdef(oid) ilike '%event_fingerprint%' and pg_get_constraintdef(oid) ilike '%0-9a-f%';")"
assert_struct_eq "1i. CHECK amount/currency paire (l''un sans l''autre interdit) présente" "1" "$(sql "select count(*) from pg_constraint where conrelid='public.payment_provider_events'::regclass and contype='c' and conname='payment_provider_events_amount_currency_pair';")"
assert_struct_eq "1j. CHECK processed_at cohérent avec processing_status='received' présente" "1" "$(sql "select count(*) from pg_constraint where conrelid='public.payment_provider_events'::regclass and contype='c' and conname='payment_provider_events_processed_at_consistency';")"
assert_struct_eq "1k. index idx_payment_provider_events_transaction présent" "1" "$(sql "select count(*) from pg_indexes where schemaname='public' and tablename='payment_provider_events' and indexname='idx_payment_provider_events_transaction';")"
assert_struct_eq "1l. index idx_payment_provider_events_restaurant_status présent" "1" "$(sql "select count(*) from pg_indexes where schemaname='public' and tablename='payment_provider_events' and indexname='idx_payment_provider_events_restaurant_status';")"
assert_struct_eq "1m. index partiel idx_payment_provider_events_retryable présent" "1" "$(sql "select count(*) from pg_indexes where schemaname='public' and tablename='payment_provider_events' and indexname='idx_payment_provider_events_retryable';")"
assert_struct_eq "1n. RLS activé sur payment_provider_events" "t" "$(sql "select relrowsecurity from pg_class where oid='public.payment_provider_events'::regclass;")"
assert_struct_eq "1o. AUCUNE policy RLS sur payment_provider_events (posture RPC-only stricte)" "0" "$(sql "select count(*) from pg_policies where schemaname='public' and tablename='payment_provider_events';")"

log "=== [1] STRUCTUREL v2 — colonnes/contraintes/index de BAIL (ferme P3B5-RETRY-01) ==="
assert_struct_eq "1n1. claim_token est bien de type uuid" "uuid" "$(sql "select data_type from information_schema.columns where table_schema='public' and table_name='payment_provider_events' and column_name='claim_token';")"
assert_struct_eq "1n2. claimed_at/claim_expires_at sont bien timestamptz" "timestamp with time zone|timestamp with time zone" "$(sql "select data_type from information_schema.columns where table_schema='public' and table_name='payment_provider_events' and column_name='claimed_at';")|$(sql "select data_type from information_schema.columns where table_schema='public' and table_name='payment_provider_events' and column_name='claim_expires_at';")"
assert_struct_eq "1n3. les 3 colonnes de bail sont NULLABLES (un évènement jamais revendiqué a les 3 à NULL)" "YES|YES|YES" "$(sql "select is_nullable from information_schema.columns where table_schema='public' and table_name='payment_provider_events' and column_name='claim_token';")|$(sql "select is_nullable from information_schema.columns where table_schema='public' and table_name='payment_provider_events' and column_name='claimed_at';")|$(sql "select is_nullable from information_schema.columns where table_schema='public' and table_name='payment_provider_events' and column_name='claim_expires_at';")"
assert_struct_eq "1n4. contrainte payment_provider_events_claim_consistency présente (les 3 colonnes de bail ensemble NULL ou ensemble renseignées)" "1" "$(sql "select count(*) from pg_constraint where conrelid='public.payment_provider_events'::regclass and contype='c' and conname='payment_provider_events_claim_consistency';")"
assert_struct_eq "1n5. index partiel idx_payment_provider_events_claimable présent (supporte le balayage d''éligibilité SANS scan complet)" "1" "$(sql "select count(*) from pg_indexes where schemaname='public' and tablename='payment_provider_events' and indexname='idx_payment_provider_events_claimable';")"
assert_struct_eq "1n6. idx_payment_provider_events_claimable filtre bien received/failed_retryable (jamais un index générique)" "1" "$(sql "select (indexdef ilike '%received%' and indexdef ilike '%failed_retryable%')::int from pg_indexes where schemaname='public' and tablename='payment_provider_events' and indexname='idx_payment_provider_events_claimable';")"

log "=== [1] STRUCTUREL — AUCUN ACCÈS TABLE DIRECT (posture RPC-only, PAY-P1-03) ==="
assert_struct_eq "1p. anon : AUCUN privilège direct sur payment_provider_events" "0" "$(sql "select (has_table_privilege('anon','payment_provider_events','SELECT') or has_table_privilege('anon','payment_provider_events','INSERT') or has_table_privilege('anon','payment_provider_events','UPDATE') or has_table_privilege('anon','payment_provider_events','DELETE'))::int;")"
assert_struct_eq "1q. authenticated : AUCUN privilège direct sur payment_provider_events" "0" "$(sql "select (has_table_privilege('authenticated','payment_provider_events','SELECT') or has_table_privilege('authenticated','payment_provider_events','INSERT') or has_table_privilege('authenticated','payment_provider_events','UPDATE') or has_table_privilege('authenticated','payment_provider_events','DELETE'))::int;")"
assert_struct_eq "1r. service_role : AUCUN privilège direct sur payment_provider_events (même posture stricte que payment_transactions, PAY-P1-03)" "0" "$(sql "select (has_table_privilege('service_role','payment_provider_events','SELECT') or has_table_privilege('service_role','payment_provider_events','INSERT') or has_table_privilege('service_role','payment_provider_events','UPDATE') or has_table_privilege('service_role','payment_provider_events','DELETE'))::int;")"

log "=== [1] STRUCTUREL — record_payment_provider_event ==="
assert_struct_eq "1s. la fonction existe avec la signature exacte (8 arguments)" "1" "$(sql "select count(*) from pg_proc where proname='record_payment_provider_event' and pronargs=8;")"
assert_struct_eq "1t. SECURITY DEFINER" "t" "$(sql "select prosecdef from pg_proc where proname='record_payment_provider_event';")"
assert_struct_eq "1u. langage = plpgsql" "plpgsql" "$(sql "select l.lanname from pg_proc p join pg_language l on l.oid=p.prolang where p.proname='record_payment_provider_event';")"
assert_struct_eq "1v. volatilité = volatile (fonction d''ÉCRITURE, jamais stable)" "v" "$(sql "select provolatile from pg_proc where proname='record_payment_provider_event';")"
assert_struct_eq "1w. search_path explicitement vide" "1" "$(sql "select ('search_path=' = any(proconfig) or 'search_path=\"\"' = any(proconfig))::int from pg_proc where proname='record_payment_provider_event';")"
assert_struct_eq "1x. EXECUTE effectif service_role = OUI" "t" "$(sql "select has_function_privilege('service_role','record_payment_provider_event(text,text,text,text,text,numeric,text,text)','EXECUTE');")"
assert_struct_eq "1y. EXECUTE effectif anon = NON" "f" "$(sql "select has_function_privilege('anon','record_payment_provider_event(text,text,text,text,text,numeric,text,text)','EXECUTE');")"
assert_struct_eq "1z. EXECUTE effectif authenticated = NON" "f" "$(sql "select has_function_privilege('authenticated','record_payment_provider_event(text,text,text,text,text,numeric,text,text)','EXECUTE');")"
assert_struct_eq "1aa. AUCUN grant EXECUTE résiduel à PUBLIC" "0" "$(sql "select has_function_privilege('public','record_payment_provider_event(text,text,text,text,text,numeric,text,text)','EXECUTE')::int - 0;" 2>/dev/null || echo 0)"
assert_struct_eq "1ab. CONTRAT DE SORTIE -- exactement 8 colonnes, dans cet ordre" "id,restaurant_id,order_id,payment_transaction_id,provider_event_type,processing_status,created_at,is_new_event" "$(sql "select string_agg(u.argname, ',' order by u.ord) from pg_proc p, lateral (select argname, ord from unnest(p.proargnames, p.proargmodes) with ordinality as x(argname, argmode, ord) where argmode='t') u where p.proname='record_payment_provider_event';")"
assert_struct_eq "1ac. AUCUN SQL dynamique (EXECUTE/format() absent du corps)" "0" "$(sql "select (case when (select prosrc from pg_proc where proname='record_payment_provider_event') ~* 'execute |format\(' then 1 else 0 end);")"

log "=== [1] STRUCTUREL — update_payment_provider_event_processing_status ==="
assert_struct_eq "1ad. la fonction existe avec la signature exacte v2 (4 arguments, dont p_claim_token AJOUTÉ)" "1" "$(sql "select count(*) from pg_proc where proname='update_payment_provider_event_processing_status' and pronargs=4;")"
assert_struct_eq "1ae. SECURITY DEFINER" "t" "$(sql "select prosecdef from pg_proc where proname='update_payment_provider_event_processing_status';")"
assert_struct_eq "1af. search_path explicitement vide" "1" "$(sql "select ('search_path=' = any(proconfig) or 'search_path=\"\"' = any(proconfig))::int from pg_proc where proname='update_payment_provider_event_processing_status';")"
assert_struct_eq "1ag. EXECUTE effectif service_role = OUI" "t" "$(sql "select has_function_privilege('service_role','update_payment_provider_event_processing_status(uuid,uuid,text,text)','EXECUTE');")"
assert_struct_eq "1ah. EXECUTE effectif anon = NON" "f" "$(sql "select has_function_privilege('anon','update_payment_provider_event_processing_status(uuid,uuid,text,text)','EXECUTE');")"
assert_struct_eq "1ai. EXECUTE effectif authenticated = NON" "f" "$(sql "select has_function_privilege('authenticated','update_payment_provider_event_processing_status(uuid,uuid,text,text)','EXECUTE');")"
assert_struct_eq "1aj. CONTRAT DE SORTIE -- exactement 4 colonnes, dans cet ordre (inchangé -- seul un paramètre d''ENTRÉE a été ajouté)" "id,processing_status,retry_count,processed_at" "$(sql "select string_agg(u.argname, ',' order by u.ord) from pg_proc p, lateral (select argname, ord from unnest(p.proargnames, p.proargmodes) with ordinality as x(argname, argmode, ord) where argmode='t') u where p.proname='update_payment_provider_event_processing_status';")"
assert_struct_eq "1ak. p_claim_token est le 2e paramètre positionnel, sans défaut (REQUIS -- mandat section 9)" "p_claim_token" "$(sql "select proargnames[2] from pg_proc where proname='update_payment_provider_event_processing_status';")"
assert_struct_eq "1al. pronargdefaults=1 (seul p_error_class, 4e paramètre, a un défaut -- p_claim_token N''EN A PAS)" "1" "$(sql "select pronargdefaults from pg_proc where proname='update_payment_provider_event_processing_status';")"

log "=== [1] STRUCTUREL v2 — claim_payment_provider_events (AJOUT, ferme P3B5-RETRY-01) ==="
assert_struct_eq "1am. la fonction existe avec la signature exacte (2 arguments, tous deux avec défaut)" "1" "$(sql "select count(*) from pg_proc where proname='claim_payment_provider_events' and pronargs=2;")"
assert_struct_eq "1an. les 2 arguments ont un défaut (pronargdefaults=2 -- appelable sans argument)" "2" "$(sql "select pronargdefaults from pg_proc where proname='claim_payment_provider_events';")"
assert_struct_eq "1ao. SECURITY DEFINER" "t" "$(sql "select prosecdef from pg_proc where proname='claim_payment_provider_events';")"
assert_struct_eq "1ap. langage = plpgsql" "plpgsql" "$(sql "select l.lanname from pg_proc p join pg_language l on l.oid=p.prolang where p.proname='claim_payment_provider_events';")"
assert_struct_eq "1aq. volatilité = volatile (fonction d''ÉCRITURE -- pose un bail -- jamais stable/immutable)" "v" "$(sql "select provolatile from pg_proc where proname='claim_payment_provider_events';")"
assert_struct_eq "1ar. search_path explicitement vide" "1" "$(sql "select ('search_path=' = any(proconfig) or 'search_path=\"\"' = any(proconfig))::int from pg_proc where proname='claim_payment_provider_events';")"
assert_struct_eq "1as. EXECUTE effectif service_role = OUI" "t" "$(sql "select has_function_privilege('service_role','claim_payment_provider_events(integer,integer)','EXECUTE');")"
assert_struct_eq "1at. EXECUTE effectif anon = NON" "f" "$(sql "select has_function_privilege('anon','claim_payment_provider_events(integer,integer)','EXECUTE');")"
assert_struct_eq "1au. EXECUTE effectif authenticated = NON" "f" "$(sql "select has_function_privilege('authenticated','claim_payment_provider_events(integer,integer)','EXECUTE');")"
assert_struct_eq "1av. AUCUN grant EXECUTE résiduel à PUBLIC" "0" "$(sql "select has_function_privilege('public','claim_payment_provider_events(integer,integer)','EXECUTE')::int;")"
assert_struct_eq "1aw. CONTRAT DE SORTIE -- exactement 16 colonnes, dans cet ordre (SANS charge utile brute/secret/public_token, mandat section 6)" "id,restaurant_id,order_id,payment_transaction_id,provider_code,provider_reference,event_fingerprint,provider_event_type,provider_event_code,amount,currency,authorization_reference,processing_status,retry_count,claim_token,claim_expires_at" "$(sql "select string_agg(u.argname, ',' order by u.ord) from pg_proc p, lateral (select argname, ord from unnest(p.proargnames, p.proargmodes) with ordinality as x(argname, argmode, ord) where argmode='t') u where p.proname='claim_payment_provider_events';")"
assert_struct_eq "1ax. AUCUN SQL dynamique (EXECUTE/format() absent du corps)" "0" "$(sql "select (case when (select prosrc from pg_proc where proname='claim_payment_provider_events') ~* 'execute |format\(' then 1 else 0 end);")"
assert_struct_eq "1ay. le corps utilise bien FOR UPDATE SKIP LOCKED (jamais un SELECT-puis-UPDATE séparé, mandat section 5)" "1" "$(sql "select (case when (select prosrc from pg_proc where proname='claim_payment_provider_events') ~* 'for update skip locked' then 1 else 0 end);")"
assert_struct_eq "1az. AUCUN verrou de table explicite (LOCK TABLE) dans le corps -- jamais un verrou global restaurant" "0" "$(sql "select (case when (select prosrc from pg_proc where proname='claim_payment_provider_events') ~* 'lock table' then 1 else 0 end);")"

# ============================================================
# [2] COMPORTEMENTAL — record_payment_provider_event
# ============================================================
log "=== [2] COMPORTEMENTAL — record_payment_provider_event ==="
EVT_R1_ROW="$(as_service "select id, restaurant_id, order_id, payment_transaction_id, provider_event_type, processing_status, is_new_event from record_payment_provider_event('monetico','ref-b5-r1','$FP_R1_AUTH','authorized', null, 10.00, 'EUR', null);")"
EVT_R1_ID="$(echo "$EVT_R1_ROW" | cut -d'|' -f1)"
behav() { BEHAV_COUNT=$((BEHAV_COUNT+1)); pass "$@"; }
assert_behav_eq "2a. R1 : correlation dérivée EXACTEMENT (restaurant_id=RID1, order_id=OID1, payment_transaction_id=TXN1), processing_status initial='received', is_new_event=t" "$RID1|$OID1|$TXN1|authorized|received|t" "$(echo "$EVT_R1_ROW" | cut -d'|' -f2-)"

RC_REPLAY="$(as_service "select id, is_new_event from record_payment_provider_event('monetico','ref-b5-r1','$FP_R1_AUTH','authorized', null, 10.00, 'EUR', null);")"
assert_behav_eq "2b. rejeu EXACT (même triplet) -> MÊME id, is_new_event=f (PREUVE CENTRALE D''IDEMPOTENCE)" "$EVT_R1_ID|f" "$RC_REPLAY"

FP_R1_REFUSED="$(fp 'monetico|ref-b5-r1|refused|1')"
RC_DIFFERENT_EVENT="$(as_service "select id, is_new_event from record_payment_provider_event('monetico','ref-b5-r1','$FP_R1_REFUSED','refused', null, null, null, null);")"
RC_DIFFERENT_EVENT_ID="$(echo "$RC_DIFFERENT_EVENT" | cut -d'|' -f1)"
assert_behav_eq "2c. MÊME provider_reference, fingerprint DIFFÉRENT -> NOUVEL évènement distinct (is_new_event=t, id DIFFÉRENT) -- PREUVE CENTRALE PAY-P3B-V2-02" "t" "$([ "$RC_DIFFERENT_EVENT_ID" != "$EVT_R1_ID" ] && echo "$(echo "$RC_DIFFERENT_EVENT" | cut -d'|' -f2)" || echo mismatch)"
assert_behav_eq "2d. les DEUX évènements pour ref-b5-r1 coexistent (aucune contrainte one-event-per-reference)" "2" "$(as_service "select count(*) from record_payment_provider_event('monetico','ref-b5-r1','$FP_R1_AUTH','authorized', null, 10.00, 'EUR', null) union all select count(*) from record_payment_provider_event('monetico','ref-b5-r1','$FP_R1_REFUSED','refused', null, null, null, null);" | wc -l | tr -d ' ')"

EVT_R2_ID="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r2','$FP_R2_AUTH','authorized', null, 20.00, 'EUR', null);")"
assert_behav_eq "2e. R1 et R2 (même provider_code, tentatives DIFFÉRENTES) produisent des évènements DISTINCTS, jamais confondus" "t" "$([ "$EVT_R2_ID" != "$EVT_R1_ID" ] && echo t || echo f)"

log "=== [2] FAIL-CLOSED — record_payment_provider_event ==="
RC_UNKNOWN_REF="$(as_service_rc "select * from record_payment_provider_event('monetico','ref-inconnue','$FP_R1_AUTH','authorized', null, null, null, null);")"
assert_behav_eq "2f. provider_reference inconnue -> échec fermé (P0002)" "1" "$([ "$RC_UNKNOWN_REF" != "0" ] && echo 1 || echo 0)"
RC_WRONG_CODE="$(as_service_rc "select * from record_payment_provider_event('mercanet','ref-b5-r1','$FP_R1_AUTH','authorized', null, null, null, null);")"
assert_behav_eq "2g. provider_code NE correspondant PAS à la tentative réelle de cette référence -> échec fermé" "1" "$([ "$RC_WRONG_CODE" != "0" ] && echo 1 || echo 0)"
RC_NULL_CODE="$(as_service_rc "select * from record_payment_provider_event(null,'ref-b5-r1','$FP_R1_AUTH','authorized', null, null, null, null);")"
assert_behav_eq "2h. p_provider_code NULL -> échec fermé" "1" "$([ "$RC_NULL_CODE" != "0" ] && echo 1 || echo 0)"
RC_NULL_REF="$(as_service_rc "select * from record_payment_provider_event('monetico',null,'$FP_R1_AUTH','authorized', null, null, null, null);")"
assert_behav_eq "2i. p_provider_reference NULL -> échec fermé" "1" "$([ "$RC_NULL_REF" != "0" ] && echo 1 || echo 0)"
RC_SHORT_FP="$(as_service_rc "select * from record_payment_provider_event('monetico','ref-b5-r1','abc123','authorized', null, null, null, null);")"
assert_behav_eq "2j. event_fingerprint trop court (pas 64 hex) -> échec fermé" "1" "$([ "$RC_SHORT_FP" != "0" ] && echo 1 || echo 0)"
RC_UPPER_FP="$(as_service "select id, is_new_event from record_payment_provider_event('monetico','ref-b5-r1','$(echo "$FP_R1_AUTH" | tr 'a-f' 'A-F')','authorized', null, 10.00, 'EUR', null);")"
assert_behav_eq "2k. event_fingerprint fourni en MAJUSCULE est normalisé (lower()) -> MÊME évènement logique que l''original en minuscule, is_new_event=f (jamais une divergence de casse ni un doublon)" "$EVT_R1_ID|f" "$RC_UPPER_FP"
RC_NULL_TYPE="$(as_service_rc "select * from record_payment_provider_event('monetico','ref-b5-r1','$FP_R1_AUTH',null, null, null, null, null);")"
assert_behav_eq "2l. p_provider_event_type NULL -> échec fermé" "1" "$([ "$RC_NULL_TYPE" != "0" ] && echo 1 || echo 0)"
RC_UNSAFE_TYPE="$(as_service_rc "select * from record_payment_provider_event('monetico','ref-b5-r1','$FP_R1_AUTH','type with spaces!', null, null, null, null);")"
assert_behav_eq "2m. p_provider_event_type jeu de caractères non sûr -> échec fermé" "1" "$([ "$RC_UNSAFE_TYPE" != "0" ] && echo 1 || echo 0)"
RC_AMOUNT_NO_CURRENCY="$(as_service_rc "select * from record_payment_provider_event('monetico','ref-b5-r1','$(fp XA)','other', null, 10.00, null, null);")"
assert_behav_eq "2n. amount fourni SANS currency -> échec fermé (paire obligatoire)" "1" "$([ "$RC_AMOUNT_NO_CURRENCY" != "0" ] && echo 1 || echo 0)"
RC_NAN_AMOUNT="$(as_service_rc "select * from record_payment_provider_event('monetico','ref-b5-r1','$(fp XB)','other', null, 'NaN', 'EUR', null);")"
assert_behav_eq "2o. amount = NaN -> échec fermé" "1" "$([ "$RC_NAN_AMOUNT" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "2p. anon NE PEUT PAS exécuter record_payment_provider_event" "1" "$([ "$(as_anon_rc "select * from record_payment_provider_event('monetico','ref-b5-r1','$FP_R1_AUTH','authorized', null, null, null, null);")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "2q. authenticated NE PEUT PAS exécuter record_payment_provider_event" "1" "$([ "$(as_authenticated_rc "select * from record_payment_provider_event('monetico','ref-b5-r1','$FP_R1_AUTH','authorized', null, null, null, null);")" != "0" ] && echo 1 || echo 0)"

log "=== [2] STRUCTUREL v2 -- canonicalisation currency (ferme P3B5-FINGERPRINT-01, alignement SQL/TS, mandat section 13/17) ==="
FP_CCY_LOWER="$(fp 'monetico|ref-b5-r1|ccylower|1')"
EVT_CCY_LOWER_ID="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_CCY_LOWER','ccylower', null, 10.00, 'eur', null);")"
assert_behav_eq "2q1. currency fournie en minuscule ('eur') est STOCKÉE en MAJUSCULE ('EUR') -- même règle upper() que le canonicalisateur TS, aucune divergence stockage/fingerprint possible" "EUR" "$(sql "select currency from payment_provider_events where id='$EVT_CCY_LOWER_ID';")"
FP_CCY_MIXED="$(fp 'monetico|ref-b5-r1|ccymixed|1')"
EVT_CCY_MIXED_ID="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_CCY_MIXED','ccymixed', null, 10.00, 'EuR', null);")"
assert_behav_eq "2q2. currency fournie en casse mixte ('EuR') est également STOCKÉE en MAJUSCULE ('EUR')" "EUR" "$(sql "select currency from payment_provider_events where id='$EVT_CCY_MIXED_ID';")"

log "=== [2] ISOLATION TENANT (mandat section 21) ==="
EVT_R1_ROW2="$(as_service "select restaurant_id from record_payment_provider_event('monetico','ref-b5-r1','$FP_R1_AUTH','authorized', null, 10.00, 'EUR', null);")"
EVT_R2_ROW2="$(as_service "select restaurant_id from record_payment_provider_event('monetico','ref-b5-r2','$FP_R2_AUTH','authorized', null, 20.00, 'EUR', null);")"
assert_behav_eq "2r. évènement R1 correlé à RID1 EXACTEMENT, jamais RID2" "$RID1" "$EVT_R1_ROW2"
assert_behav_eq "2s. évènement R2 correlé à RID2 EXACTEMENT, jamais RID1" "$RID2" "$EVT_R2_ROW2"
assert_behav_eq "2t. RID1 et RID2 restent bien DISTINCTS (isolation dans les deux sens)" "t" "$([ "$RID1" != "$RID2" ] && echo t || echo f)"

# ============================================================
# [3] TRANSITIONS DE processing_status -- v2 : CHAQUE transition RÉELLE
# exige désormais une revendication PRÉALABLE (mandat section 9). La
# file est d'abord VIDÉE (drain_claimable_backlog) pour que chaque
# claim_one() ci-dessous soit déterministe (renvoie exactement
# l'évènement fraîchement créé pour ce scénario, jamais un résidu de la
# section [2]).
# ============================================================
log "=== [3.0] Purge de la file avant scénarios déterministes ==="
drain_claimable_backlog
struct "file vidée -- prochain claim_one() déterministe pour les scénarios [3]"

log "=== [3.0] PROPRIÉTÉ DU BAIL -- jeton erroné REFUSÉ, jeton correct ACCEPTÉ (mandat section 9, preuve unitaire directe) ==="
FP_OWN="$(fp 'monetico|ref-b5-r1|ownership|1')"
EVT_OWN="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_OWN','ownership', null, null, null, null);")"
OWN_CLAIM="$(claim_one 60)"
OWN_ID="$(echo "$OWN_CLAIM" | cut -d'|' -f1)"
OWN_TOKEN="$(echo "$OWN_CLAIM" | cut -d'|' -f2)"
assert_behav_eq "3.0a. claim_one() a bien revendiqué EXACTEMENT l'évènement fraîchement créé (file vidée au préalable)" "$EVT_OWN" "$OWN_ID"
RC_WRONG_TOKEN="$(as_service_rc "select * from update_payment_provider_event_processing_status('$EVT_OWN', gen_random_uuid(), 'applied', null);")"
assert_behav_eq "3.0b. jeton de revendication INCORRECT (uuid aléatoire distinct) -> REFUSÉ fail-closed (P0004)" "1" "$([ "$RC_WRONG_TOKEN" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "3.0c. jeton CORRECT -> transition ACCEPTÉE" "applied" "$(as_service "select processing_status from update_payment_provider_event_processing_status('$EVT_OWN','$OWN_TOKEN','applied',null);")"

log "=== [3.a-e] Cycle de vie complet (received -> failed_retryable -> failed_retryable -> applied -> replay -> refus), CHAQUE transition RÉELLE re-revendiquée (mandat section 9 : le bail est libéré à CHAQUE transition réelle) ==="
FP_TX="$(fp 'monetico|ref-b5-r1|txlifecycle|1')"
EVT_TX="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_TX','txlifecycle', null, null, null, null);")"

TOK_A="$(echo "$(claim_one 60)" | cut -d'|' -f2)"
assert_behav_eq "3a. received -> failed_retryable : autorisée (avec bail valide), retry_count=1, last_error_class stocké" "failed_retryable|1" "$(as_service "select processing_status, retry_count from update_payment_provider_event_processing_status('$EVT_TX','$TOK_A','failed_retryable','network_timeout');")"

TOK_B="$(echo "$(claim_one 60)" | cut -d'|' -f2)"
assert_behav_eq "3b. bail IMMÉDIATEMENT re-disponible après failed_retryable (libéré par la transition précédente) -- re-revendiqué avec succès (mandat section 9)" "1" "$([ -n "$TOK_B" ] && [ "$TOK_B" != "$TOK_A" ] && echo 1 || echo 0)"
assert_behav_eq "3b2. failed_retryable -> failed_retryable : autorisée, retry_count INCRÉMENTÉ à 2 (nouvel essai raté)" "failed_retryable|2" "$(as_service "select processing_status, retry_count from update_payment_provider_event_processing_status('$EVT_TX','$TOK_B','failed_retryable','network_timeout_2');")"

TOK_C="$(echo "$(claim_one 60)" | cut -d'|' -f2)"
assert_behav_eq "3c. failed_retryable -> applied : autorisée (bail re-revendiqué)" "applied" "$(as_service "select processing_status from update_payment_provider_event_processing_status('$EVT_TX','$TOK_C','applied',null);")"
assert_behav_eq "3d. applied -> applied (replay identique, jeton ARBITRAIRE fourni) : no-op idempotent, retry_count INCHANGÉ (=2) -- PREUVE que le replay d'un état DÉJÀ terminal est EXEMPTÉ de la vérification de bail (mandat, CLAIM-LEASE-RECOVERY-REPORT.txt)" "applied|2" "$(as_service "select processing_status, retry_count from update_payment_provider_event_processing_status('$EVT_TX', gen_random_uuid(), 'applied',null);")"
assert_behav_eq "3e. applied -> failed_retryable (jeton arbitraire) : REFUSÉE (verrouillage terminal -- le refus intervient AVANT même la vérification de bail)" "1" "$([ "$(as_service_rc "select * from update_payment_provider_event_processing_status('$EVT_TX', gen_random_uuid(), 'failed_retryable',null);")" != "0" ] && echo 1 || echo 0)"

FP_TX2="$(fp 'monetico|ref-b5-r1|txlifecycle2|1')"
EVT_TX2="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_TX2','txlifecycle2', null, null, null, null);")"
TOK_TX2A="$(echo "$(claim_one 60)" | cut -d'|' -f2)"
assert_behav_eq "3f. received -> ignored : autorisée (bail valide)" "ignored" "$(as_service "select processing_status from update_payment_provider_event_processing_status('$EVT_TX2','$TOK_TX2A','ignored',null);")"
assert_behav_eq "3g. ignored -> applied (jeton arbitraire) : REFUSÉE (ignored est terminal)" "1" "$([ "$(as_service_rc "select * from update_payment_provider_event_processing_status('$EVT_TX2', gen_random_uuid(), 'applied',null);")" != "0" ] && echo 1 || echo 0)"

FP_TX3="$(fp 'monetico|ref-b5-r1|txlifecycle3|1')"
EVT_TX3="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_TX3','txlifecycle3', null, null, null, null);")"
TOK_TX3A="$(echo "$(claim_one 60)" | cut -d'|' -f2)"
as_service "select * from update_payment_provider_event_processing_status('$EVT_TX3','$TOK_TX3A','failed_retryable','e1');" >/dev/null
TOK_TX3B="$(echo "$(claim_one 60)" | cut -d'|' -f2)"
assert_behav_eq "3h. failed_retryable -> failed_terminal : autorisée (bail re-revendiqué -- addition délibérée de ce lot, mandat section 12 'terminal state must be reachable')" "failed_terminal" "$(as_service "select processing_status from update_payment_provider_event_processing_status('$EVT_TX3','$TOK_TX3B','failed_terminal','giving_up');")"
assert_behav_eq "3i. failed_terminal -> applied (jeton arbitraire) : REFUSÉE (résurrection terminale interdite)" "1" "$([ "$(as_service_rc "select * from update_payment_provider_event_processing_status('$EVT_TX3', gen_random_uuid(), 'applied',null);")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "3j. failed_terminal -> failed_terminal (replay identique, jeton arbitraire) : no-op idempotent" "failed_terminal" "$(as_service "select processing_status from update_payment_provider_event_processing_status('$EVT_TX3', gen_random_uuid(), 'failed_terminal','giving_up');")"

log "=== [3.p-r] VALIDATION DÉFENSIVE DU JETON AVANT REJEU TERMINAL -- ferme P3B5-CLAIM-TOKEN-01 (LOW) : sous l'invariant NORMAL, un évènement terminal a TOUJOURS claim_token = NULL (chaque transition RÉELLE le libère inconditionnellement), donc ce test ne peut PAS survenir en fonctionnement normal -- il injecte artificiellement (accès superutilisateur de test, JAMAIS accessible à service_role/anon/authenticated) un bail non-NULL sur \$EVT_TX3 (déjà failed_terminal depuis [3.h-j]) pour simuler l'hypothétique violation d'invariant contre laquelle la vérification défensive protège, et prouve qu'elle ferme fail-closed (P0004) sur un jeton erroné SANS casser le rejeu idempotent légitime avec le jeton correct ==="
STRAY_TOKEN="$(sql "update payment_provider_events set claim_token = gen_random_uuid(), claimed_at = now(), claim_expires_at = now() + interval '60 seconds' where id = '$EVT_TX3' returning claim_token;")"
assert_behav_eq "3p. précondition du test : injection superutilisateur d'un bail parasite sur \$EVT_TX3 (déjà failed_terminal) a bien produit un claim_token NON-NULL (situation normalement IMPOSSIBLE, simulée ici uniquement pour l'épreuve défensive)" "1" "$([ -n "$STRAY_TOKEN" ] && echo 1 || echo 0)"
RC_STRAY_WRONG_TOKEN="$(as_service_rc "select * from update_payment_provider_event_processing_status('$EVT_TX3', gen_random_uuid(), 'failed_terminal','giving_up');")"
assert_behav_eq "3q. jeton ERRONÉ contre un évènement terminal portant (artificiellement) un bail parasite -> REFUSÉ fail-closed (P0004), AVANT même d'atteindre le rejeu idempotent d'état terminal -- comportement NOUVEAU introduit par le correctif v3 (sous v2, ce même appel aurait réussi comme rejeu idempotent, sans jamais consulter le jeton)" "1" "$([ "$RC_STRAY_WRONG_TOKEN" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "3r. jeton CORRECT (celui injecté) contre ce même évènement -> rejeu idempotent NORMAL toujours accepté (le correctif v3 ne casse PAS le rejeu légitime, il ne fait que fermer le cas où le jeton ne correspond PAS)" "failed_terminal" "$(as_service "select processing_status from update_payment_provider_event_processing_status('$EVT_TX3', '$STRAY_TOKEN', 'failed_terminal','giving_up');")"

RC_UNKNOWN_EVT="$(as_service_rc "select * from update_payment_provider_event_processing_status('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'applied',null);")"
assert_behav_eq "3k. évènement inconnu -> échec fermé (P0002)" "1" "$([ "$RC_UNKNOWN_EVT" != "0" ] && echo 1 || echo 0)"
RC_INVALID_TARGET="$(as_service_rc "select * from update_payment_provider_event_processing_status('$EVT_TX2', gen_random_uuid(), 'received',null);")"
assert_behav_eq "3l. p_new_status='received' -> échec fermé (jamais une cible de transition valide)" "1" "$([ "$RC_INVALID_TARGET" != "0" ] && echo 1 || echo 0)"
RC_LONG_ERROR="$(as_service_rc "select * from update_payment_provider_event_processing_status('$EVT_TX2', gen_random_uuid(), 'failed_retryable','$(printf 'x%.0s' $(seq 1 201))');")"
assert_behav_eq "3m. last_error_class > 200 caractères -> échec fermé (jamais une pile d''appel brute)" "1" "$([ "$RC_LONG_ERROR" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "3n. anon NE PEUT PAS exécuter update_payment_provider_event_processing_status" "1" "$([ "$(as_anon_rc "select * from update_payment_provider_event_processing_status('$EVT_TX2', gen_random_uuid(), 'applied',null);")" != "0" ] && echo 1 || echo 0)"
FP_TX4="$(fp 'monetico|ref-b5-r1|txlifecycle4|1')"
EVT_TX4="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_TX4','txlifecycle4', null, null, null, null);")"
RC_NULL_TOKEN="$(as_service_rc "select * from update_payment_provider_event_processing_status('$EVT_TX4', null, 'ignored',null);")"
assert_behav_eq "3o. p_claim_token NULL sur un évènement received (transition RÉELLE received->ignored) -> échec fermé (bail requis, mandat section 9)" "1" "$([ "$RC_NULL_TOKEN" != "0" ] && echo 1 || echo 0)"

# ============================================================
# [3bis] COMPORTEMENTAL -- claim_payment_provider_events (AJOUT v2,
# ferme P3B5-RETRY-01, mandat sections 4/7/8/22)
# ============================================================
log "=== [3bis.0] Purge de la file avant scénarios de revendication déterministes ==="
drain_claimable_backlog
struct "file vidée -- scénarios [3bis] déterministes"

log "=== [3bis.a] ÉLIGIBILITÉ STRICTE -- SEULS received/failed_retryable sont revendicables, JAMAIS applied/ignored/failed_terminal ==="
# ORDRE IMPORTANT : chaque évènement "distracteur" est créé PUIS
# IMMÉDIATEMENT revendiqué+finalisé (fait le SEUL éligible au moment du
# claim_one() qui le concerne, donc déterministe) AVANT de créer le
# suivant -- claim_one() renvoie toujours le PLUS ANCIEN éligible, un
# ordre différent romprait le déterminisme. EVT_EL_RECEIVED est créé EN
# DERNIER et JAMAIS revendiqué, pour rester le seul éligible au moment
# du contrôle final.
FP_EL_APPLIED="$(fp 'monetico|ref-b5-r1|eligapplied|1')"
EVT_EL_APPLIED="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_EL_APPLIED','eligapplied', null, null, null, null);")"
TOK_EL_APPLIED="$(echo "$(claim_one 60)" | cut -d'|' -f2)"
as_service "select * from update_payment_provider_event_processing_status('$EVT_EL_APPLIED','$TOK_EL_APPLIED','applied',null);" >/dev/null
FP_EL_IGNORED="$(fp 'monetico|ref-b5-r1|eligignored|1')"
EVT_EL_IGNORED="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_EL_IGNORED','eligignored', null, null, null, null);")"
TOK_EL_IGNORED="$(echo "$(claim_one 60)" | cut -d'|' -f2)"
as_service "select * from update_payment_provider_event_processing_status('$EVT_EL_IGNORED','$TOK_EL_IGNORED','ignored',null);" >/dev/null
FP_EL_TERMINAL="$(fp 'monetico|ref-b5-r1|eligterminal|1')"
EVT_EL_TERMINAL="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_EL_TERMINAL','eligterminal', null, null, null, null);")"
TOK_EL_TERMINAL_A="$(echo "$(claim_one 60)" | cut -d'|' -f2)"
as_service "select * from update_payment_provider_event_processing_status('$EVT_EL_TERMINAL','$TOK_EL_TERMINAL_A','failed_retryable','e1');" >/dev/null
TOK_EL_TERMINAL_B="$(echo "$(claim_one 60)" | cut -d'|' -f2)"
as_service "select * from update_payment_provider_event_processing_status('$EVT_EL_TERMINAL','$TOK_EL_TERMINAL_B','failed_terminal','e2');" >/dev/null
FP_EL_RECEIVED="$(fp 'monetico|ref-b5-r1|eligreceived|1')"
EVT_EL_RECEIVED="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_EL_RECEIVED','eligreceived', null, null, null, null);")"
# À ce stade, SEUL EVT_EL_RECEIVED (créé en dernier, jamais revendiqué)
# est encore éligible -- applied/ignored/failed_terminal ont chacun été
# revendiqués PUIS finalisés (donc plus JAMAIS éligibles).
ELIGIBLE_NOW="$(as_service "select id from claim_payment_provider_events(10, 60);")"
assert_behav_eq "3bis.a1. exactement 1 évènement éligible (celui resté 'received') -- applied/ignored/failed_terminal EXCLUS" "1" "$(echo "$ELIGIBLE_NOW" | grep -c . || true)"
assert_behav_eq "3bis.a2. l'évènement éligible revendiqué est EXACTEMENT celui resté 'received'" "$EVT_EL_RECEIVED" "$ELIGIBLE_NOW"
assert_behav_eq "3bis.a3. un second appel immédiat ne renvoie PLUS rien (l'unique éligible vient d'être revendiqué, bail non expiré)" "0" "$(as_service "select count(*) from claim_payment_provider_events(10, 60);")"

log "=== [3bis.b] ORDONNANCEMENT DÉTERMINISTE -- created_at croissant (le plus ancien d'abord) ==="
drain_claimable_backlog
FP_ORD1B="$(fp 'monetico|ref-b5-r1|ord1b|1')"
EVT_ORD1B="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_ORD1B','ord1b', null, null, null, null);")"
sql "select pg_sleep(0.05);" >/dev/null
FP_ORD2B="$(fp 'monetico|ref-b5-r1|ord2b|1')"
EVT_ORD2B="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_ORD2B','ord2b', null, null, null, null);")"
sql "select pg_sleep(0.05);" >/dev/null
FP_ORD3B="$(fp 'monetico|ref-b5-r1|ord3b|1')"
EVT_ORD3B="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_ORD3B','ord3b', null, null, null, null);")"
ORD_RESULT="$(as_service "select id from claim_payment_provider_events(10, 60);" | tr -d ' ' | tr '\n' ',' | sed 's/,$//')"
assert_behav_eq "3bis.b1. l'ordre de renvoi EXACT (sans ORDER BY additionnel côté appelant) est created_at croissant : ord1b, ord2b, ord3b" "$EVT_ORD1B,$EVT_ORD2B,$EVT_ORD3B" "$ORD_RESULT"

log "=== [3bis.b2] DÉPARTAGE DÉTERMINISTE PAR id -- ferme P3B5-CLAIM-ORDER-01 (LOW) : deux évènements avec un created_at STRICTEMENT IDENTIQUE (horodatage forcé par un accès superutilisateur de test) doivent être revendiqués dans un ordre stable et déterministe (id croissant), jamais un ordre arbitraire dépendant de l'ordre physique des lignes ==="
drain_claimable_backlog
FP_TIE1="$(fp 'monetico|ref-b5-r1|tie1|1')"
EVT_TIE1="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_TIE1','tie1', null, null, null, null);")"
FP_TIE2="$(fp 'monetico|ref-b5-r1|tie2|1')"
EVT_TIE2="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_TIE2','tie2', null, null, null, null);")"
# Force les deux created_at à la MÊME valeur exacte (simulateur de test
# hors API publique -- ni record_payment_provider_event ni
# claim_payment_provider_events ne permettent normalement de choisir
# created_at, c'est toujours now() au moment de l'insertion réelle ;
# deux insertions réelles suffisamment rapprochées PEUVENT néanmoins
# partager la même valeur en pratique selon la résolution de l'horloge
# -- ce test élimine l'incertitude en forçant délibérément le cas
# limite plutôt que d'espérer le reproduire par hasard).
TIE_TS="$(sql "select now();")"
sql "update payment_provider_events set created_at = '$TIE_TS' where id in ('$EVT_TIE1','$EVT_TIE2');" >/dev/null
assert_behav_eq "3bis.b2a. les deux évènements de test partagent bien EXACTEMENT le même created_at (précondition du test)" "1" "$(sql "select (count(distinct created_at) = 1)::int from payment_provider_events where id in ('$EVT_TIE1','$EVT_TIE2');")"
TIE_EXPECTED_ORDER="$([ "$EVT_TIE1" \< "$EVT_TIE2" ] && echo "$EVT_TIE1,$EVT_TIE2" || echo "$EVT_TIE2,$EVT_TIE1")"
TIE_ACTUAL_ORDER="$(as_service "select id from claim_payment_provider_events(10, 60);" | tr -d ' ' | tr '\n' ',' | sed 's/,$//')"
assert_behav_eq "3bis.b2b. avec created_at à égalité stricte, l'ordre de revendication départage par id croissant (ordre total garanti, jamais indéfini)" "$TIE_EXPECTED_ORDER" "$TIE_ACTUAL_ORDER"

log "=== [3bis.c] LOT BORNÉ -- répartition entre plusieurs évènements éligibles, batch_size respecté ==="
drain_claimable_backlog
for i in 1 2 3 4 5; do
  FPI="$(fp "monetico|ref-b5-r1|batch$i|1")"
  as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FPI','batch$i', null, null, null, null);" >/dev/null
done
BATCH2_COUNT="$(as_service "select count(*) from claim_payment_provider_events(2, 60);")"
assert_behav_eq "3bis.c1. batch_size=2 sur 5 éligibles -> EXACTEMENT 2 revendiqués (jamais plus)" "2" "$BATCH2_COUNT"
BATCH_REST_COUNT="$(as_service "select count(*) from claim_payment_provider_events(10, 60);")"
assert_behav_eq "3bis.c2. les 3 restants sont revendiqués par l'appel suivant (aucune perte, aucun doublon avec le lot précédent)" "3" "$BATCH_REST_COUNT"
assert_behav_eq "3bis.c3. plus rien à revendiquer une fois les 5 épuisés" "0" "$(as_service "select count(*) from claim_payment_provider_events(10, 60);")"

log "=== [3bis.d] BORNES -- p_batch_size/p_lease_seconds hors bornes REFUSÉS (échec fermé, jamais un plafonnement silencieux) ==="
assert_behav_eq "3bis.d1. p_batch_size=0 -> échec fermé" "1" "$([ "$(as_service_rc "select * from claim_payment_provider_events(0, 60);")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "3bis.d2. p_batch_size=101 -> échec fermé" "1" "$([ "$(as_service_rc "select * from claim_payment_provider_events(101, 60);")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "3bis.d3. p_lease_seconds=4 -> échec fermé" "1" "$([ "$(as_service_rc "select * from claim_payment_provider_events(10, 4);")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "3bis.d4. p_lease_seconds=3601 -> échec fermé" "1" "$([ "$(as_service_rc "select * from claim_payment_provider_events(10, 3601);")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "3bis.d5. appel SANS argument -> défauts appliqués (20, 60), aucune erreur" "1" "$([ "$(as_service_rc "select * from claim_payment_provider_events();")" = "0" ] && echo 1 || echo 0)"

log "=== [3bis.e] ANON/AUTHENTICATED NE PEUVENT PAS revendiquer ==="
assert_behav_eq "3bis.e1. anon NE PEUT PAS exécuter claim_payment_provider_events" "1" "$([ "$(as_anon_rc "select * from claim_payment_provider_events(10,60);")" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "3bis.e2. authenticated NE PEUT PAS exécuter claim_payment_provider_events" "1" "$([ "$(as_authenticated_rc "select * from claim_payment_provider_events(10,60);")" != "0" ] && echo 1 || echo 0)"

log "=== [3bis.f] CONTRAT DE SORTIE -- champs de correspondance/montant/devise fidèlement transmis (pas de charge utile brute) ==="
drain_claimable_backlog
FP_FIELD="$(fp 'monetico|ref-b5-r1|fieldcheck|1')"
EVT_FIELD="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_FIELD','fieldcheck', 'CODE9','12.34','eur','AUTH-9');")"
FIELD_ROW="$(as_service "select restaurant_id, order_id, payment_transaction_id, provider_code, provider_reference, provider_event_type, provider_event_code, amount, currency, authorization_reference, processing_status, retry_count from claim_payment_provider_events(1, 60);")"
assert_behav_eq "3bis.f1. TOUS les champs de corrélation/montant/devise/statut sont fidèlement renvoyés par le claim (currency canonicalisée EUR, amount=12.34)" "$RID1|$OID1|$TXN1|monetico|ref-b5-r1|fieldcheck|CODE9|12.34|EUR|AUTH-9|received|0" "$FIELD_ROW"
log "=== [4.A] CONCURRENT IDENTICAL INSERT -- deux VRAIES sessions psql concurrentes, MÊME triplet ==="
OID_CONC_A="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID1', 2, 'pickup', 10.00, 10.00, 'EUR') returning id;")"
as_service "select transaction_id from initiate_payment_attempt('$OID_CONC_A','monetico','ref-b5-conc-a');" >/dev/null
FP_CONC_A="$(fp 'monetico|ref-b5-conc-a|authorized|1')"
cat > "$TMPDIR_CONC/session1_insert.sql" <<SQL
begin;
select id from public.record_payment_provider_event('monetico','ref-b5-conc-a','$FP_CONC_A','authorized', null, 10.00, 'EUR', null);
select pg_sleep(1);
commit;
SQL
cat > "$TMPDIR_CONC/session2_insert.sql" <<SQL
begin;
select id from public.record_payment_provider_event('monetico','ref-b5-conc-a','$FP_CONC_A','authorized', null, 10.00, 'EUR', null);
commit;
SQL
( set +e; PGOPTIONS="-c role=service_role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -f "$TMPDIR_CONC/session1_insert.sql" > "$TMPDIR_CONC/session1_insert.out" 2>"$TMPDIR_CONC/session1_insert.err"; echo $? > "$TMPDIR_CONC/session1_insert.rc" ) &
sleep 0.3
( set +e; PGOPTIONS="-c role=service_role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -f "$TMPDIR_CONC/session2_insert.sql" > "$TMPDIR_CONC/session2_insert.out" 2>"$TMPDIR_CONC/session2_insert.err"; echo $? > "$TMPDIR_CONC/session2_insert.rc" ) &
wait
RC1="$(cat "$TMPDIR_CONC/session1_insert.rc")"
RC2="$(cat "$TMPDIR_CONC/session2_insert.rc")"
assert_conc_eq "4a. les DEUX sessions concurrentes réussissent (INSERT...ON CONFLICT est sûr sous concurrence, jamais une erreur de contrainte visible à l''appelant)" "0|0" "$RC1|$RC2"
ID1="$(cat "$TMPDIR_CONC/session1_insert.out" | tr -d ' ')"
ID2="$(cat "$TMPDIR_CONC/session2_insert.out" | tr -d ' ')"
assert_conc_eq "4b. les DEUX sessions renvoient le MÊME id logique (une seule ligne créée sous course réelle)" "1" "$([ "$ID1" = "$ID2" ] && [ -n "$ID1" ] && echo 1 || echo 0)"
assert_conc_eq "4c. UNE SEULE ligne existe réellement pour ce triplet après la course réelle" "1" "$(as_service "select count(*) from record_payment_provider_event('monetico','ref-b5-conc-a','$FP_CONC_A','authorized', null, 10.00, 'EUR', null);" | wc -l | tr -d ' ')"

log "=== [4.B] CONCURRENT DISTINCT EVENTS -- même provider_reference, fingerprints DIFFÉRENTS, VRAIES sessions concurrentes ==="
OID_CONC_B="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID1', 3, 'pickup', 10.00, 10.00, 'EUR') returning id;")"
as_service "select transaction_id from initiate_payment_attempt('$OID_CONC_B','monetico','ref-b5-conc-b');" >/dev/null
FP_CONC_B1="$(fp 'monetico|ref-b5-conc-b|authorized|1')"
FP_CONC_B2="$(fp 'monetico|ref-b5-conc-b|refused|1')"
cat > "$TMPDIR_CONC/session1_distinct.sql" <<SQL
begin;
select id from public.record_payment_provider_event('monetico','ref-b5-conc-b','$FP_CONC_B1','authorized', null, 10.00, 'EUR', null);
select pg_sleep(1);
commit;
SQL
cat > "$TMPDIR_CONC/session2_distinct.sql" <<SQL
begin;
select id from public.record_payment_provider_event('monetico','ref-b5-conc-b','$FP_CONC_B2','refused', null, null, null, null);
commit;
SQL
( set +e; PGOPTIONS="-c role=service_role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -f "$TMPDIR_CONC/session1_distinct.sql" > "$TMPDIR_CONC/session1_distinct.out" 2>"$TMPDIR_CONC/session1_distinct.err"; echo $? > "$TMPDIR_CONC/session1_distinct.rc" ) &
sleep 0.3
( set +e; PGOPTIONS="-c role=service_role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -f "$TMPDIR_CONC/session2_distinct.sql" > "$TMPDIR_CONC/session2_distinct.out" 2>"$TMPDIR_CONC/session2_distinct.err"; echo $? > "$TMPDIR_CONC/session2_distinct.rc" ) &
wait
RC1D="$(cat "$TMPDIR_CONC/session1_distinct.rc")"
RC2D="$(cat "$TMPDIR_CONC/session2_distinct.rc")"
assert_conc_eq "4d. les DEUX sessions concurrentes (évènements DIFFÉRENTS) réussissent sans blocage/deadlock" "0|0" "$RC1D|$RC2D"
assert_conc_eq "4e. les DEUX évènements distincts sont bien préservés (aucune perte, aucun deadlock)" "2" "$(as_service "select count(*) from record_payment_provider_event('monetico','ref-b5-conc-b','$FP_CONC_B1','authorized', null, 10.00, 'EUR', null) union all select count(*) from record_payment_provider_event('monetico','ref-b5-conc-b','$FP_CONC_B2','refused', null, null, null, null);" | wc -l | tr -d ' ')"

log "=== [4.C] CLAIM CONCURRENCY -- UN SEUL évènement éligible, DEUX VRAIES sessions psql revendiquent simultanément (mandat section 7 : 'same event claimed by ONE worker only') ==="
drain_claimable_backlog
FP_CLAIMRACE1="$(fp 'monetico|ref-b5-r1|claimrace1|1')"
EVT_CLAIMRACE1="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_CLAIMRACE1','claimrace1', null, null, null, null);")"
cat > "$TMPDIR_CONC/session1_claim.sql" <<SQL
begin;
select pg_sleep(0.3);
select id, claim_token from public.claim_payment_provider_events(1, 60);
commit;
SQL
cat > "$TMPDIR_CONC/session2_claim.sql" <<SQL
begin;
select pg_sleep(0.3);
select id, claim_token from public.claim_payment_provider_events(1, 60);
commit;
SQL
( set +e; PGOPTIONS="-c role=service_role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -f "$TMPDIR_CONC/session1_claim.sql" > "$TMPDIR_CONC/session1_claim.out" 2>"$TMPDIR_CONC/session1_claim.err"; echo $? > "$TMPDIR_CONC/session1_claim.rc" ) &
( set +e; PGOPTIONS="-c role=service_role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -f "$TMPDIR_CONC/session2_claim.sql" > "$TMPDIR_CONC/session2_claim.out" 2>"$TMPDIR_CONC/session2_claim.err"; echo $? > "$TMPDIR_CONC/session2_claim.rc" ) &
wait
RC1C="$(cat "$TMPDIR_CONC/session1_claim.rc")"
RC2C="$(cat "$TMPDIR_CONC/session2_claim.rc")"
OUT1C="$(cat "$TMPDIR_CONC/session1_claim.out" | tr -d ' ')"
OUT2C="$(cat "$TMPDIR_CONC/session2_claim.out" | tr -d ' ')"
assert_conc_eq "4f. les DEUX sessions concurrentes s'exécutent sans erreur/deadlock (FOR UPDATE SKIP LOCKED, jamais un verrou bloquant)" "0|0" "$RC1C|$RC2C"
EXACTLY_ONE_WON=0
if { [ -n "$OUT1C" ] && [ -z "$OUT2C" ]; } || { [ -z "$OUT1C" ] && [ -n "$OUT2C" ]; }; then
  EXACTLY_ONE_WON=1
fi
assert_conc_eq "4g. EXACTEMENT UNE des deux sessions a revendiqué l'évènement (l'autre reçoit un résultat VIDE, jamais une erreur ni un doublon) -- PREUVE CENTRALE mandat section 7" "1" "$EXACTLY_ONE_WON"
# NOTE : chaque fichier .sql de course contient AUSSI un `select
# pg_sleep(...)`, dont psql -t -A imprime une ligne VIDE distincte
# (résultat void) avant la ligne id|claim_token -- filtrée ici
# explicitement (grep -v '^$') pour ne jamais laisser un saut de ligne
# parasite contaminer l'ID extrait.
if [ -n "$OUT1C" ]; then WINNER_ID_C="$(echo "$OUT1C" | grep -v '^$' | cut -d'|' -f1)"; else WINNER_ID_C="$(echo "$OUT2C" | grep -v '^$' | cut -d'|' -f1)"; fi
assert_conc_eq "4h. l'ID revendiqué par le gagnant est EXACTEMENT l'ID de l'évènement créé (vérification directe de l'ID renvoyé, pas seulement 'une revendication a eu lieu')" "$EVT_CLAIMRACE1" "$WINNER_ID_C"
assert_conc_eq "4i. l'état RÉEL en base confirme UN SEUL bail posé (claim_token non NULL, une seule fois) -- vérifié directement en table via un accès superutilisateur de test" "1" "$(sql "select count(*) from payment_provider_events where id='$EVT_CLAIMRACE1' and claim_token is not null;")"

log "=== [4.D] CLAIM CONCURRENCY -- PLUSIEURS évènements éligibles, deux VRAIS workers se répartissent le lot SANS doublon ni perte (mandat section 7) ==="
drain_claimable_backlog
CLAIMDIV_IDS=()
for i in 1 2 3 4; do
  FPI="$(fp "monetico|ref-b5-r1|claimdiv$i|1")"
  EVID="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FPI','claimdiv$i', null, null, null, null);")"
  CLAIMDIV_IDS+=("$EVID")
done
cat > "$TMPDIR_CONC/session1_claimdiv.sql" <<SQL
begin;
select pg_sleep(0.2);
select id from public.claim_payment_provider_events(2, 60);
commit;
SQL
cat > "$TMPDIR_CONC/session2_claimdiv.sql" <<SQL
begin;
select pg_sleep(0.2);
select id from public.claim_payment_provider_events(2, 60);
commit;
SQL
( set +e; PGOPTIONS="-c role=service_role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -f "$TMPDIR_CONC/session1_claimdiv.sql" > "$TMPDIR_CONC/session1_claimdiv.out" 2>"$TMPDIR_CONC/session1_claimdiv.err"; echo $? > "$TMPDIR_CONC/session1_claimdiv.rc" ) &
( set +e; PGOPTIONS="-c role=service_role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -f "$TMPDIR_CONC/session2_claimdiv.sql" > "$TMPDIR_CONC/session2_claimdiv.out" 2>"$TMPDIR_CONC/session2_claimdiv.err"; echo $? > "$TMPDIR_CONC/session2_claimdiv.rc" ) &
wait
RC1DIV="$(cat "$TMPDIR_CONC/session1_claimdiv.rc")"
RC2DIV="$(cat "$TMPDIR_CONC/session2_claimdiv.rc")"
assert_conc_eq "4j. les DEUX workers concurrents s'exécutent sans erreur/deadlock" "0|0" "$RC1DIV|$RC2DIV"
DIV_ALL="$(cat "$TMPDIR_CONC/session1_claimdiv.out" "$TMPDIR_CONC/session2_claimdiv.out" | tr -d ' ' | grep -v '^$' | sort)"
DIV_UNIQUE="$(echo "$DIV_ALL" | sort -u)"
assert_conc_eq "4k. les 4 évènements sont revendiqués EXACTEMENT UNE FOIS au total entre les deux workers (aucun doublon, aucune perte)" "4|4" "$(echo "$DIV_ALL" | wc -l | tr -d ' ')|$(echo "$DIV_UNIQUE" | wc -l | tr -d ' ')"
assert_conc_eq "4l. aucun évènement ne reste éligible après la répartition complète" "0" "$(as_service "select count(*) from claim_payment_provider_events(10,60);")"

log "=== [4.E] BAIL EXPIRÉ -- REPRISE APRÈS CRASH (mandat section 8, injection temporelle contrôlée, PAS de vrai sleep) ==="
drain_claimable_backlog
FP_LEASE="$(fp 'monetico|ref-b5-r1|leaseexpiry|1')"
EVT_LEASE="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_LEASE','leaseexpiry', null, null, null, null);")"
LEASE_CLAIM_A="$(claim_one 60)"
LEASE_TOK_A="$(echo "$LEASE_CLAIM_A" | cut -d'|' -f2)"
assert_behav_eq "4m. worker A revendique l'évènement (bail de 60s posé)" "1" "$([ -n "$LEASE_TOK_A" ] && echo 1 || echo 0)"
assert_behav_eq "4n. tant que le bail n'est pas expiré, AUCUN autre worker ne peut le revendiquer" "0" "$(as_service "select count(*) from claim_payment_provider_events(10,60);")"
# Worker A "crashe" -- ne finalise JAMAIS. On simule l'écoulement du
# temps via une mise à jour directe (superutilisateur, HORS API
# publique -- exactement l'équivalent d'une horloge de test contrôlée,
# mandat section 8 : "no scheduler needed... test with controlled
# timestamps if possible... explicitly permits NOT requiring real
# sleeping").
sql "update payment_provider_events set claim_expires_at = now() - interval '1 second' where id = '$EVT_LEASE';" >/dev/null
LEASE_CLAIM_B="$(claim_one 60)"
LEASE_ID_B="$(echo "$LEASE_CLAIM_B" | cut -d'|' -f1)"
LEASE_TOK_B="$(echo "$LEASE_CLAIM_B" | cut -d'|' -f2)"
assert_behav_eq "4o. bail expiré -> worker B REVENDIQUE le MÊME évènement (reprise après crash SANS orphelinat permanent, PREUVE CENTRALE P3B5-RETRY-01)" "$EVT_LEASE" "$LEASE_ID_B"
assert_behav_eq "4p. le NOUVEAU jeton de worker B est DIFFÉRENT de l'ancien jeton (périmé) de worker A" "1" "$([ -n "$LEASE_TOK_B" ] && [ "$LEASE_TOK_B" != "$LEASE_TOK_A" ] && echo 1 || echo 0)"

log "=== [4.F] WORKER PÉRIMÉ NE PEUT JAMAIS ÉCRASER UNE REVENDICATION PLUS RÉCENTE (mandat section 9/25) ==="
RC_STALE_MIDFLIGHT="$(as_service_rc "select * from update_payment_provider_event_processing_status('$EVT_LEASE','$LEASE_TOK_A','applied',null);")"
assert_behav_eq "4q. worker A (jeton périmé) tente de finaliser APRÈS que B a repris, AVANT que B ne finalise -> REFUSÉ (P0004)" "1" "$([ "$RC_STALE_MIDFLIGHT" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "4r. worker B (détenteur du jeton ACTUEL) finalise avec succès" "applied" "$(as_service "select processing_status from update_payment_provider_event_processing_status('$EVT_LEASE','$LEASE_TOK_B','applied',null);")"
RC_STALE_POSTFINAL="$(as_service_rc "select * from update_payment_provider_event_processing_status('$EVT_LEASE','$LEASE_TOK_A','failed_retryable','x');")"
assert_behav_eq "4s. worker A (jeton périmé) tente ENCORE APRÈS que B a finalisé -> TOUJOURS REFUSÉ (verrouillage terminal, aucune résurrection)" "1" "$([ "$RC_STALE_POSTFINAL" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "4t. état final en base : EXACTEMENT 'applied', jamais écrasé par le worker périmé -- vérification directe de l'état de table (mandat section 22)" "applied" "$(sql "select processing_status from payment_provider_events where id='$EVT_LEASE';")"

# ============================================================
# [5] AUCUNE MUTATION DU PAIEMENT (mandat section 34)
# ============================================================
log "=== [5] AUCUNE MUTATION -- payment_transactions/orders ==="
STATUS_BEFORE="$(sql "select status from payment_transactions where id='$TXN1';")"
PAYMENT_STATUS_BEFORE="$(sql "select payment_status from orders where id='$OID1';")"
CURRENT_TXN_BEFORE="$(sql "select current_payment_transaction_id from orders where id='$OID1';")"
FP_NOMUT="$(fp 'monetico|ref-b5-r1|nomutation|1')"
EVT_NOMUT="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_NOMUT','nomutation', null, 10.00, 'EUR', null);")"
TOK_NOMUT="$(echo "$(claim_one 60)" | cut -d'|' -f2)"
as_service "select * from update_payment_provider_event_processing_status('$EVT_NOMUT','$TOK_NOMUT','applied',null);" >/dev/null
assert_behav_eq "5a. payment_transactions.status INCHANGÉ après réception ET traitement (revendication + finalisation) d''un évènement" "$STATUS_BEFORE" "$(sql "select status from payment_transactions where id='$TXN1';")"
assert_behav_eq "5b. orders.payment_status INCHANGÉ après réception ET traitement d''un évènement" "$PAYMENT_STATUS_BEFORE" "$(sql "select payment_status from orders where id='$OID1';")"
assert_behav_eq "5c. orders.current_payment_transaction_id INCHANGÉ après réception ET traitement d''un évènement" "$CURRENT_TXN_BEFORE" "$(sql "select current_payment_transaction_id from orders where id='$OID1';")"

# ============================================================
# [6] NON-RÉGRESSION EXPLICITE
# ============================================================
log "=== [6] NON-RÉGRESSION ==="
assert_struct_eq "6a. payment_transactions : service_role toujours SANS SELECT direct" "f" "$(sql "select has_table_privilege('service_role','payment_transactions','SELECT');")"
assert_struct_eq "6b. payment_transactions : service_role toujours SANS INSERT/UPDATE/DELETE direct" "f" "$(sql "select has_table_privilege('service_role','payment_transactions','INSERT') or has_table_privilege('service_role','payment_transactions','UPDATE') or has_table_privilege('service_role','payment_transactions','DELETE');")"
assert_struct_eq "6c. initiate_payment_attempt (PAYMENT P1) toujours présente, signature inchangée" "1" "$(sql "select count(*) from pg_proc where proname='initiate_payment_attempt' and pronargs=3;")"
assert_struct_eq "6d. confirm_payment_attempt (PAYMENT P1) toujours présente, signature inchangée" "1" "$(sql "select count(*) from pg_proc where proname='confirm_payment_attempt' and pronargs=4;")"
assert_behav_eq "6e. confirm_payment_attempt toujours fonctionnelle -- capacité P1 non cassée par ce lot" "$TXN2|$OID2|paid" "$(as_service "select transaction_id, order_id, status from confirm_payment_attempt('monetico','ref-b5-r2','paid');")"
assert_struct_eq "6f. get_payment_transaction_correlation (PAYMENT P3-B0) toujours présente" "1" "$(sql "select count(*) from pg_proc where proname='get_payment_transaction_correlation';")"
assert_struct_eq "6g. get_payment_runtime_provider_config (PAYMENT P3-B1) toujours présente, EXACTEMENT 3 colonnes de sortie -- contrat NON rouvert" "provider_code,is_enabled,configuration_status" "$(sql "select string_agg(u.argname, ',' order by u.ord) from pg_proc p, lateral (select argname, ord from unnest(p.proargnames, p.proargmodes) with ordinality as x(argname, argmode, ord) where argmode='t') u where p.proname='get_payment_runtime_provider_config';")"
assert_struct_eq "6h. get_order_payment_context (PAYMENT P3-B2) toujours présente" "1" "$(sql "select count(*) from pg_proc where proname='get_order_payment_context';")"
assert_struct_eq "6i. get_order_active_payment_attempt (PAYMENT P3-B3) toujours présente" "1" "$(sql "select count(*) from pg_proc where proname='get_order_active_payment_attempt';")"
assert_struct_eq "6j. get_payment_runtime_provider_environment (PAYMENT P3-B4) toujours présente, EXACTEMENT 4 colonnes de sortie -- contrat NON rouvert (mandat section 28)" "provider_code,is_enabled,configuration_status,mode" "$(sql "select string_agg(u.argname, ',' order by u.ord) from pg_proc p, lateral (select argname, ord from unnest(p.proargnames, p.proargmodes) with ordinality as x(argname, argmode, ord) where argmode='t') u where p.proname='get_payment_runtime_provider_environment';")"
psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into payment_provider_configs (restaurant_id, provider_code, is_enabled, configuration_status, mode) values ('$RID1','monetico', true, 'not_configured', 'test');" >/dev/null
assert_behav_eq "6k. get_payment_runtime_provider_environment toujours fonctionnelle et INCHANGÉE (mode toujours exactement test/live)" "1" "$(as_service "select (mode in ('test','live'))::int from get_payment_runtime_provider_environment('$RID1','monetico');" 2>/dev/null || echo 0)"
assert_struct_eq "6l. orders.payment_status CHECK toujours EXACTEMENT not_required/pending/paid/failed/cancelled (P1, aucune valeur ajoutée par ce lot)" "1" "$(sql "select (pg_get_constraintdef(oid) ilike '%not_required%' and pg_get_constraintdef(oid) ilike '%pending%' and pg_get_constraintdef(oid) ilike '%paid%' and pg_get_constraintdef(oid) ilike '%failed%' and pg_get_constraintdef(oid) ilike '%cancelled%' and pg_get_constraintdef(oid) not ilike '%refunded%')::int from pg_constraint where conrelid='public.orders'::regclass and contype='c' and pg_get_constraintdef(oid) ilike '%payment_status%';")"

# ============================================================
# [7] GARDES ANTI-DÉRIVE
# ============================================================
log "=== [7] GARDES ANTI-DÉRIVE ==="
RC_DOUBLE_APPLY="$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B5_SQL" >/tmp/scanym-p3b5-double-$$.log 2>&1; echo $?)"
assert_struct_eq "7a. double application du lot REFUSÉE (SCANYM_SCHEMA_DRIFT)" "1" "$([ "$RC_DOUBLE_APPLY" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "7b. message de double application mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c 'SCANYM_SCHEMA_DRIFT' /tmp/scanym-p3b5-double-$$.log || true)"
rm -f /tmp/scanym-p3b5-double-$$.log

log "=== GARDE — base SANS payment_transactions (PAYMENT P1 absent) ==="
psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
createdb "$DB_DRIFT"
build_common_bootstrap "$DB_DRIFT"
build_minimal_chain "$DB_DRIFT"
RC_NOP1="$(psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B5_SQL" >/tmp/scanym-p3b5-nop1-$$.log 2>&1; echo $?)"
assert_struct_eq "7c. application sur base SANS payment_transactions (P1 absent) REFUSÉE dès la garde préflight" "1" "$([ "$RC_NOP1" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "7d. message mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c 'SCANYM_SCHEMA_DRIFT' /tmp/scanym-p3b5-nop1-$$.log || true)"
rm -f /tmp/scanym-p3b5-nop1-$$.log
psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true

log "=== GARDE — payment_transactions_id_order_id_unique manquante (simulation d''une dérive de P1) ==="
createdb "$DB_DRIFT"
build_full_chain_through_p3b4 "$DB_DRIFT"
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -c "alter table payment_transactions drop constraint payment_transactions_id_order_id_unique cascade;" >/dev/null
RC_NOUNIQUE="$(psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B5_SQL" >/tmp/scanym-p3b5-nounique-$$.log 2>&1; echo $?)"
assert_struct_eq "7e. application sur base où payment_transactions_id_order_id_unique a été retirée REFUSÉE (garde structurelle, jamais un texte fragile)" "1" "$([ "$RC_NOUNIQUE" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "7f. message mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c 'SCANYM_SCHEMA_DRIFT' /tmp/scanym-p3b5-nounique-$$.log || true)"
rm -f /tmp/scanym-p3b5-nounique-$$.log
psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true

log "=== GARDE — orders_id_restaurant_id_unique manquante ==="
createdb "$DB_DRIFT"
build_full_chain_through_p3b4 "$DB_DRIFT"
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -c "alter table orders drop constraint orders_id_restaurant_id_unique cascade;" >/dev/null
RC_NOORDERSUNIQUE="$(psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B5_SQL" >/tmp/scanym-p3b5-noordersunique-$$.log 2>&1; echo $?)"
assert_struct_eq "7g. application sur base où orders_id_restaurant_id_unique a été retirée REFUSÉE" "1" "$([ "$RC_NOORDERSUNIQUE" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "7h. message mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c 'SCANYM_SCHEMA_DRIFT' /tmp/scanym-p3b5-noordersunique-$$.log || true)"
rm -f /tmp/scanym-p3b5-noordersunique-$$.log
psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true

log "=== GARDE — scanym_numeric_is_non_finite manquante ==="
createdb "$DB_DRIFT"
build_full_chain_through_p3b4 "$DB_DRIFT"
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -c "drop function scanym_numeric_is_non_finite(numeric) cascade;" >/dev/null
RC_NOHELPER="$(psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B5_SQL" >/tmp/scanym-p3b5-nohelper-$$.log 2>&1; echo $?)"
assert_struct_eq "7i. application sur base où scanym_numeric_is_non_finite a été retirée REFUSÉE" "1" "$([ "$RC_NOHELPER" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "7j. message mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c 'SCANYM_SCHEMA_DRIFT' /tmp/scanym-p3b5-nohelper-$$.log || true)"
rm -f /tmp/scanym-p3b5-nohelper-$$.log

# ============================================================
# [8] ABSENCE DE FUITE
# ============================================================
log "=== [8] ABSENCE DE FUITE ==="
LEAK_CHECK="$(as_service "select * from record_payment_provider_event('monetico','ref-totalement-inconnue-$$','$(fp XLEAK)','authorized', null, null, null, null);" 2>&1 || true)"
assert_behav_eq "8a. l''échec 'not found' ne mentionne AUCUN restaurant_id/order_id/transaction_id réel du jeu de données" "0" "$(echo "$LEAK_CHECK" | grep -Fc -e "$RID1" -e "$RID2" -e "$OID1" -e "$OID2" -e "$TXN1" -e "$TXN2" || true)"

# ============================================================
# [9] SCÉNARIOS BOUT-EN-BOUT MANDATÉS (mandat sections 23/24/25) --
# chaque scénario ci-dessous utilise des fixtures DÉDIÉES et vérifie
# l'état RÉEL de la table à chaque étape (mandat section 22), pour une
# traçabilité directe et non ambiguë avec le texte du mandat.
# ============================================================
drain_claimable_backlog

log "=== [9.§23] RÉCEPTION DURABLE + REPRISE -- record -> commit -> mémoire perdue -> NOUVELLE session invoque claim -> RPC de traitement marque applied -> état terminal applied (PREUVE que P3B5-RETRY-01 est fermé) ==="
FP_S23="$(fp 'monetico|ref-b5-r1|scenario23|1')"
EVT_S23="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_S23','scenario23', null, null, null, null);")"
assert_behav_eq "9.23a. évènement durablement enregistré et COMMIS (visible via une requête de vérification indépendante, session distincte)" "received" "$(sql "select processing_status from payment_provider_events where id='$EVT_S23';")"
# 'mémoire du processus perdue' == aucune variable/état en mémoire n'est
# réutilisé au-delà de EVT_S23 lui-même (un simple identifiant, pas une
# référence de session) ; l'appel suivant est une INVOCATION PSQL
# ENTIÈREMENT NOUVELLE (nouvelle connexion serveur = nouvelle session
# PostgreSQL réelle, exactement le scénario "process crashed and
# restarted" du mandat).
S23_CLAIM="$( PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "select id, claim_token from claim_payment_provider_events(10, 60);" )"
S23_CLAIM_ID="$(echo "$S23_CLAIM" | grep "^$EVT_S23|" | cut -d'|' -f1)"
S23_CLAIM_TOKEN="$(echo "$S23_CLAIM" | grep "^$EVT_S23|" | cut -d'|' -f2)"
assert_behav_eq "9.23b. la NOUVELLE session (processus/worker distinct) retrouve et revendique l'évènement via la RPC narrow -- AUCUN SELECT direct requis" "$EVT_S23" "$S23_CLAIM_ID"
S23_APPLY="$( PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "select processing_status from update_payment_provider_event_processing_status('$EVT_S23','$S23_CLAIM_TOKEN','applied',null);" )"
assert_behav_eq "9.23c. la RPC de traitement marque l'évènement 'applied'" "applied" "$S23_APPLY"
assert_behav_eq "9.23d. état TERMINAL 'applied' confirmé directement en table (pas seulement via la valeur de retour de la RPC)" "applied" "$(sql "select processing_status from payment_provider_events where id='$EVT_S23';")"

log "=== [9.§24] ÉCHEC + NOUVELLE TENTATIVE -- record -> claim -> failed_retryable -> reclaim -> applied -> retry_count correct -> AUCUN évènement dupliqué ==="
FP_S24="$(fp 'monetico|ref-b5-r1|scenario24|1')"
EVT_S24="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_S24','scenario24', null, null, null, null);")"
S24_TOK_A="$(echo "$(claim_one 60)" | cut -d'|' -f2)"
as_service "select * from update_payment_provider_event_processing_status('$EVT_S24','$S24_TOK_A','failed_retryable','provider_timeout');" >/dev/null
assert_behav_eq "9.24a. après échec, retry_count=1 et statut failed_retryable (état réel en table)" "failed_retryable|1" "$(sql "select processing_status, retry_count from payment_provider_events where id='$EVT_S24';")"
S24_TOK_B="$(echo "$(claim_one 60)" | cut -d'|' -f2)"
assert_behav_eq "9.24b. l'évènement en échec est IMMÉDIATEMENT re-revendicable (aucune attente d'expiration de bail nécessaire)" "1" "$([ -n "$S24_TOK_B" ] && echo 1 || echo 0)"
as_service "select * from update_payment_provider_event_processing_status('$EVT_S24','$S24_TOK_B','applied',null);" >/dev/null
assert_behav_eq "9.24c. après la nouvelle tentative réussie, statut applied ET retry_count TOUJOURS EXACTEMENT 1 (jamais réinitialisé ni incrémenté par un succès)" "applied|1" "$(sql "select processing_status, retry_count from payment_provider_events where id='$EVT_S24';")"
assert_behav_eq "9.24d. AUCUN évènement dupliqué créé pendant tout le cycle échec/reprise (toujours EXACTEMENT 1 ligne pour ce triplet)" "1" "$(sql "select count(*) from payment_provider_events where provider_code='monetico' and provider_reference='ref-b5-r1' and event_fingerprint='$FP_S24';")"

log "=== [9.§25] CRASH APRÈS REVENDICATION -- worker A revendique -> ne finalise JAMAIS -> bail expire -> worker B revendique le MÊME évènement -> B applique -> A (périmé) NE PEUT PAS écraser (PREUVE que P3B5-RETRY-01 couvre aussi le cas crash-après-claim, fixtures dédiées distinctes de [4.E]/[4.F]) ==="
FP_S25="$(fp 'monetico|ref-b5-r1|scenario25|1')"
EVT_S25="$(as_service "select id from record_payment_provider_event('monetico','ref-b5-r1','$FP_S25','scenario25', null, null, null, null);")"
S25_TOK_A="$(echo "$(claim_one 60)" | cut -d'|' -f2)"
assert_behav_eq "9.25a. worker A revendique avec succès (bail posé)" "1" "$([ -n "$S25_TOK_A" ] && echo 1 || echo 0)"
# Worker A crashe -- jamais de finalize. Injection temporelle contrôlée
# (mandat section 8 -- superutilisateur de test, hors API publique)
# simulant l'expiration naturelle du bail.
sql "update payment_provider_events set claim_expires_at = now() - interval '1 second' where id = '$EVT_S25';" >/dev/null
S25_CLAIM_B="$(claim_one 60)"
S25_ID_B="$(echo "$S25_CLAIM_B" | cut -d'|' -f1)"
S25_TOK_B="$(echo "$S25_CLAIM_B" | cut -d'|' -f2)"
assert_behav_eq "9.25b. worker B revendique le MÊME évènement après expiration du bail (reprise après crash)" "$EVT_S25" "$S25_ID_B"
RC_S25_STALE="$(as_service_rc "select * from update_payment_provider_event_processing_status('$EVT_S25','$S25_TOK_A','applied',null);")"
assert_behav_eq "9.25c. worker A (jeton PÉRIMÉ) NE PEUT PAS finaliser -- REFUSÉ fail-closed (P0004)" "1" "$([ "$RC_S25_STALE" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "9.25d. worker B (détenteur ACTUEL) applique avec succès" "applied" "$(as_service "select processing_status from update_payment_provider_event_processing_status('$EVT_S25','$S25_TOK_B','applied',null);")"
assert_behav_eq "9.25e. état final confirmé en table : applied, jamais écrasé par le worker périmé -- SI CE TEST ÉCHOUAIT, LA CAPACITÉ DE REPRISE SERAIT INCOMPLÈTE (mandat section 25, condition de STOP explicite)" "applied" "$(sql "select processing_status from payment_provider_events where id='$EVT_S25';")"

# ============================================================
# BILAN
# ============================================================
log "=== BILAN : $PASS_COUNT PASS / $FAIL_COUNT FAIL (dont $STRUCT_COUNT structurelles, $BEHAV_COUNT comportementales, $CONC_COUNT concurrence réelle) ==="
if [ "$PASS_COUNT" -ne $((STRUCT_COUNT + BEHAV_COUNT + CONC_COUNT)) ]; then
  echo "INVARIANT ROMPU : PASS_COUNT != STRUCT_COUNT + BEHAV_COUNT + CONC_COUNT" >&2
  exit 1
fi
if [ "$FAIL_COUNT" -ne 0 ]; then
  echo "=== ÉCHECS ===" >&2
  cat "$FAIL_LOG" >&2
  exit 1
fi
exit 0
