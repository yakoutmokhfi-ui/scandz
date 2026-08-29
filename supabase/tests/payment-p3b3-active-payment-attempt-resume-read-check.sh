#!/usr/bin/env bash
# ============================================================
# Scanym — PAYMENT P3-B3 — ACTIVE PAYMENT ATTEMPT RESUME READ — Harnais
# reproductible pour
# supabase/DRAFT-lot-payment-p3b3-active-payment-attempt-resume-read.sql.
#
# PostgreSQL communautaire vanilla (pas une instance Supabase managée),
# même patron que tous les harnais paiement précédents (P1/P2A/P2B-A/
# P3-A0/P3-B0/P3-B1/P3-B2) : rôles anon/authenticated/service_role
# recréés minimalement, auth.uid() simulé via `test.uid`.
#
# Chaîne (mandat section 21, "no unpublished dependency") : chaîne
# minimale (schema.sql .. migration-v81-lot1b-translations.sql) ->
# DRAFT-lot-payment-p1-foundation.sql -> ORDERS SERVICE_ROLE SELECT
# HARDENING v1 -> LOT SOUS TEST. Ce lot ne dépend PAS de P2A/P2B-A/
# P3-A0/P3-B0/P3-B1/P3-B2 (vérifié directement : aucune de ces
# capacités n'ajoute de colonne/contrainte requise ici, la fonction
# sous test lit exclusivement orders.public_token/.payment_status/
# .current_payment_transaction_id et payment_transactions.*, posées par
# migration-orders.sql/PAYMENT P1 FOUNDATION) -- chaîne volontairement
# minimale plutôt qu'une chaîne "complète" par défaut. Le durcissement
# ORDERS SERVICE_ROLE SELECT v1 est appliqué AVANT P3-B3 afin de
# prouver que la RPC SECURITY DEFINER fonctionne sans restituer le
# SELECT direct de public.orders/public.payment_transactions à
# service_role (mandat section 20, "verify BEFORE / AFTER").
#
# assert_struct_eq / assert_behav_eq dès l'origine.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/payment-p3b3-active-payment-attempt-resume-read-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_PAYMENT_P1_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p1-foundation.sql"
DRAFT_ORDERS_HARDENING_SQL="$SUPABASE_DIR/DRAFT-lot-orders-service-role-select-hardening.sql"
DRAFT_PAYMENT_P3B3_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b3-active-payment-attempt-resume-read.sql"
DB="scanym_payment_p3b3_$$"
DB_DRIFT="scanym_payment_p3b3_drift_$$"

PASS_COUNT=0
FAIL_COUNT=0
STRUCT_COUNT=0
BEHAV_COUNT=0
FAIL_LOG="/tmp/scanym-payment-p3b3-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }
struct() { STRUCT_COUNT=$((STRUCT_COUNT+1)); pass "$@"; }
behav() { BEHAV_COUNT=$((BEHAV_COUNT+1)); pass "$@"; }

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

sql() { psql -X -A -q -t -d "$DB" -c "$1"; }

as_service() {
  local query="$1"
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$query" 2>&1
}
as_service_rc() {
  local query="$1"
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p3b3-out-$$.txt 2>/tmp/scanym-p3b3-err-$$.txt
  echo $?
}
as_anon_rc() {
  local query="$1"
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p3b3-out-$$.txt 2>/tmp/scanym-p3b3-err-$$.txt
  echo $?
}
as_user_rc() {
  local uid="$1" query="$2"
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$uid'; $query" >/tmp/scanym-p3b3-out-$$.txt 2>/tmp/scanym-p3b3-err-$$.txt
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

build_full_chain() {
  local dbname="$1"
  build_common_bootstrap "$dbname"
  build_minimal_chain "$dbname"
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P1_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_ORDERS_HARDENING_SQL" >/dev/null
}

# ============================================================
# 0. BASELINE — chaîne minimale + P1 + ORDERS SERVICE_ROLE SELECT
# HARDENING v1 (toutes déjà publiées/en l'état actuel) + P3-B3 (LOT
# SOUS TEST).
# ============================================================
log "=== [0] Construction baseline $DB ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
build_full_chain "$DB"
struct "chaîne complète appliquée (minimale + P1 + ORDERS SERVICE_ROLE SELECT HARDENING v1)"

# ------------------------------------------------------------
# §20 — VÉRIFICATION AVANT P3-B3 : service_role n'a AUCUN SELECT direct
# sur orders ni payment_transactions (état hérité, revérifié ici avant
# d'appliquer ce lot).
# ------------------------------------------------------------
assert_struct_eq "0a. AVANT P3-B3 -- service_role SELECT direct orders = NON" "f" "$(sql "select has_table_privilege('service_role','orders','SELECT');")"
assert_struct_eq "0b. AVANT P3-B3 -- service_role SELECT direct payment_transactions = NON" "f" "$(sql "select has_table_privilege('service_role','payment_transactions','SELECT');")"

psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B3_SQL" >/dev/null
struct "DRAFT-lot-payment-p3b3-active-payment-attempt-resume-read.sql appliqué sans erreur (LOT SOUS TEST) -- fichier unique, forme finale directe"

# ------------------------------------------------------------
# §20 — VÉRIFICATION APRÈS P3-B3 : toujours aucun SELECT direct, aucun
# élargissement d'ACL.
# ------------------------------------------------------------
assert_struct_eq "0c. APRÈS P3-B3 -- service_role SELECT direct orders TOUJOURS NON" "f" "$(sql "select has_table_privilege('service_role','orders','SELECT');")"
assert_struct_eq "0d. APRÈS P3-B3 -- service_role SELECT direct payment_transactions TOUJOURS NON" "f" "$(sql "select has_table_privilege('service_role','payment_transactions','SELECT');")"

# ============================================================
# FIXTURES — 2 tenants, plusieurs commandes/tentatives, pour couvrir
# possession valide/invalide, isolation cross-tenant/cross-order,
# tous les statuts terminaux, et le scénario de reprise (mandat
# section 18).
# ============================================================
log "=== Fixtures (Tenant Un + Tenant Deux) ==="
OWNER_UID="30000000-0000-0000-0000-000000000001"
psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into auth.users (id, email) values ('$OWNER_UID', 'owner@p3b3-fixture-one.test');
insert into restaurants (name, slug, status) values
  ('P3B3 Fixture Tenant One', 'p3b3-fixture-tenant-one', 'active'),
  ('P3B3 Fixture Tenant Two', 'p3b3-fixture-tenant-two', 'active');
SQL
RID_ONE="$(sql "select id from restaurants where slug='p3b3-fixture-tenant-one';")"
RID_TWO="$(sql "select id from restaurants where slug='p3b3-fixture-tenant-two';")"
psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into restaurant_users (restaurant_id, user_id, role) values ('$RID_ONE','$OWNER_UID','owner');" >/dev/null

# ORDER_PENDING : tentative active (LE CAS SOUS TEST PRINCIPAL).
# ORDER_NONE : jamais engagée (payment_status='not_required', défaut P1).
# ORDER_PAID / ORDER_FAILED / ORDER_CANCELLED : tentative terminale, ne
#   doivent jamais être renvoyées.
# ORDER_OTHER_TENANT : pending, tenant Deux (isolation cross-tenant).
ORDER_PENDING="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 1, 'pickup', 12.50, 12.50, 'EUR') returning id;")"
ORDER_NONE="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 2, 'pickup', 8.00, 8.00, 'EUR') returning id;")"
ORDER_PAID="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 3, 'pickup', 20.00, 20.00, 'EUR') returning id;")"
ORDER_FAILED="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 4, 'pickup', 22.00, 22.00, 'EUR') returning id;")"
ORDER_CANCELLED="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 5, 'pickup', 24.00, 24.00, 'EUR') returning id;")"
ORDER_OTHER_TENANT="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_TWO', 1, 'pickup', 30.00, 30.00, 'EUR') returning id;")"

TOKEN_PENDING="$(sql "select public_token from orders where id='$ORDER_PENDING';")"
TOKEN_NONE="$(sql "select public_token from orders where id='$ORDER_NONE';")"
TOKEN_PAID="$(sql "select public_token from orders where id='$ORDER_PAID';")"
TOKEN_FAILED="$(sql "select public_token from orders where id='$ORDER_FAILED';")"
TOKEN_CANCELLED="$(sql "select public_token from orders where id='$ORDER_CANCELLED';")"
TOKEN_OTHER_TENANT="$(sql "select public_token from orders where id='$ORDER_OTHER_TENANT';")"

# Tentatives créées via l'API service_role SECURITY DEFINER existante
# (initiate_payment_attempt/confirm_payment_attempt), JAMAIS par INSERT
# direct -- même discipline que tous les harnais précédents.
REF_PENDING="p3b3-ref-pending-$$"
REF_PAID="p3b3-ref-paid-$$"
REF_FAILED="p3b3-ref-failed-$$"
REF_CANCELLED="p3b3-ref-cancelled-$$"
REF_OTHER_TENANT="p3b3-ref-other-tenant-$$"

as_service "select * from public.initiate_payment_attempt('$ORDER_PENDING','monetico','$REF_PENDING');" >/dev/null
as_service "select * from public.initiate_payment_attempt('$ORDER_PAID','monetico','$REF_PAID');" >/dev/null
as_service "select * from public.confirm_payment_attempt('monetico','$REF_PAID','paid');" >/dev/null
as_service "select * from public.initiate_payment_attempt('$ORDER_FAILED','monetico','$REF_FAILED');" >/dev/null
as_service "select * from public.confirm_payment_attempt('monetico','$REF_FAILED','failed');" >/dev/null
as_service "select * from public.initiate_payment_attempt('$ORDER_CANCELLED','monetico','$REF_CANCELLED');" >/dev/null
as_service "select * from public.confirm_payment_attempt('monetico','$REF_CANCELLED','cancelled');" >/dev/null
as_service "select * from public.initiate_payment_attempt('$ORDER_OTHER_TENANT','monetico','$REF_OTHER_TENANT');" >/dev/null

struct "fixtures : 6 commandes créées, tentatives initiées via initiate_payment_attempt/confirm_payment_attempt (jamais d'INSERT direct)"

EXPECTED_AMOUNT="12.50"
EXPECTED_CURRENCY="EUR"

# ============================================================
# RPC — CATALOGUE DE FONCTION (structure/ACL -- struct() exclusivement,
# aucune exécution du chemin métier dans ce bloc).
# ============================================================
log "=== [RPC] CATALOGUE DE FONCTION ==="
assert_struct_eq "1a. la fonction existe avec la signature exacte (3 arguments uuid,uuid,text)" "1" "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_order_active_payment_attempt' and p.pronargs=3 and array(select unnest(p.proargtypes))=array['uuid','uuid','text']::regtype[]::oid[];")"
assert_struct_eq "1b. SECURITY DEFINER (prosecdef=true)" "t" "$(sql "select prosecdef from pg_proc where proname='get_order_active_payment_attempt' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1c. langage = sql" "sql" "$(sql "select l.lanname from pg_proc p join pg_language l on l.oid=p.prolang where p.proname='get_order_active_payment_attempt' and p.pronamespace='public'::regnamespace;")"
assert_struct_eq "1d. volatilité = stable" "s" "$(sql "select provolatile from pg_proc where proname='get_order_active_payment_attempt' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1e. search_path explicitement vide" "1" "$(sql "select count(*) from pg_proc where proname='get_order_active_payment_attempt' and pronamespace='public'::regnamespace and 'search_path=\"\"' = any(proconfig);")"
assert_struct_eq "1f. propriétaire = rôle ayant exécuté la migration (aucun OWNER TO explicite requis)" "$(sql "select current_user;")" "$(sql "select r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner where p.proname='get_order_active_payment_attempt' and p.pronamespace='public'::regnamespace;")"
assert_struct_eq "1g. EXECUTE effectif service_role = OUI" "t" "$(sql "select has_function_privilege('service_role', 'public.get_order_active_payment_attempt(uuid,uuid,text)', 'execute');")"
assert_struct_eq "1h. EXECUTE effectif anon = NON" "f" "$(sql "select has_function_privilege('anon', 'public.get_order_active_payment_attempt(uuid,uuid,text)', 'execute');")"
assert_struct_eq "1i. EXECUTE effectif authenticated = NON" "f" "$(sql "select has_function_privilege('authenticated', 'public.get_order_active_payment_attempt(uuid,uuid,text)', 'execute');")"
assert_struct_eq "1j. AUCUN grant EXECUTE résiduel à PUBLIC" "0" "$(sql "select count(*) from information_schema.role_routine_grants where routine_schema='public' and routine_name='get_order_active_payment_attempt' and grantee='PUBLIC';")"
assert_struct_eq "1k. CONTRAT -- retourne EXACTEMENT 3 colonnes, dans cet ordre : provider_reference,amount,currency" "provider_reference,amount,currency" "$(sql "select array_to_string(proargnames[array_position(proargmodes,'t'::\"char\"):array_length(proargmodes,1)], ',') from pg_proc where proname='get_order_active_payment_attempt' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1l. type de sortie 'provider_reference' = text" "text" "$(sql "select proallargtypes[array_position(proargmodes,'t'::\"char\")]::regtype::text from pg_proc where proname='get_order_active_payment_attempt' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1m. type de sortie 'amount' = numeric" "numeric" "$(sql "select proallargtypes[array_position(proargmodes,'t'::\"char\")+1]::regtype::text from pg_proc where proname='get_order_active_payment_attempt' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1n. type de sortie 'currency' = text" "text" "$(sql "select proallargtypes[array_position(proargmodes,'t'::\"char\")+2]::regtype::text from pg_proc where proname='get_order_active_payment_attempt' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1o. PREUVE STRUCTURELLE -- les 3 SEULS arguments IN sont p_order_id,p_public_token,p_provider_code" "p_order_id,p_public_token,p_provider_code" "$(sql "select array_to_string(proargnames[1:array_position(proargmodes,'t'::\"char\")-1], ',') from pg_proc where proname='get_order_active_payment_attempt' and pronamespace='public'::regnamespace;")"

log "=== AUCUNE DONNÉE EN TROP (contrat de colonnes, mandat section 3) ==="
NO_EXTRA_COLS="$(sql "select count(*) from unnest(string_to_array((select array_to_string(proargnames[array_position(proargmodes,'t'::\"char\"):array_length(proargmodes,1)], ',') from pg_proc where proname='get_order_active_payment_attempt' and pronamespace='public'::regnamespace), ',')) col where col ilike '%credential%' or col ilike '%secret%' or col ilike '%vault%' or col ilike '%token%' or col in ('transaction_id','restaurant_id','order_number','customer_name','customer_phone','customer_email','delivery_address','created_at','updated_at','authorization_reference');")"
assert_struct_eq "1p. AUCUNE colonne de sortie ne contient credential/secret/vault/token, ni transaction_id/restaurant_id/order_number/customer_*/timestamps/authorization_reference (contrat minimal)" "0" "$NO_EXTRA_COLS"

# ============================================================
# RPC — COMPORTEMENT (exécution réelle -- behav() exclusivement).
# ============================================================
log "=== [RPC] COMPORTEMENT — VALIDE (tentative pending courante) ==="
OUT_PENDING="$(as_service "select provider_reference, amount, currency from public.get_order_active_payment_attempt('$ORDER_PENDING','$TOKEN_PENDING','monetico');")"
assert_behav_eq "2a. commande pending, possession valide, provider correspondant -> exactement une ligne, valeurs exactes" "${REF_PENDING}|${EXPECTED_AMOUNT}|${EXPECTED_CURRENCY}" "$OUT_PENDING"
ROWCOUNT_PENDING="$(as_service "select count(*) from public.get_order_active_payment_attempt('$ORDER_PENDING','$TOKEN_PENDING','monetico');")"
assert_behav_eq "2b. exactement UNE ligne (jamais plus)" "1" "$ROWCOUNT_PENDING"

log "=== [RPC] COMPORTEMENT — REPRISE IDEMPOTENTE (mandat section 18, preuve centrale) ==="
OUT_RESUME_1="$(as_service "select provider_reference, amount, currency from public.get_order_active_payment_attempt('$ORDER_PENDING','$TOKEN_PENDING','monetico');")"
OUT_RESUME_2="$(as_service "select provider_reference, amount, currency from public.get_order_active_payment_attempt('$ORDER_PENDING','$TOKEN_PENDING','monetico');")"
OUT_RESUME_3="$(as_service "select provider_reference, amount, currency from public.get_order_active_payment_attempt('$ORDER_PENDING','$TOKEN_PENDING','monetico');")"
assert_behav_eq "3a. premier appel (simule navigateur abandonné) -> référence/montant/devise obtenus" "${REF_PENDING}|${EXPECTED_AMOUNT}|${EXPECTED_CURRENCY}" "$OUT_RESUME_1"
assert_behav_eq "3b. deuxième appel -> EXACTEMENT les mêmes valeurs (même provider_reference)" "$OUT_RESUME_1" "$OUT_RESUME_2"
assert_behav_eq "3c. troisième appel -> EXACTEMENT les mêmes valeurs encore" "$OUT_RESUME_1" "$OUT_RESUME_3"
TXN_COUNT_FOR_ORDER="$(sql "select count(*) from payment_transactions where order_id='$ORDER_PENDING';")"
assert_behav_eq "3d. AUCUNE seconde payment_transactions créée par les 3 appels de reprise -- une seule ligne existe toujours pour cette commande" "1" "$TXN_COUNT_FOR_ORDER"

log "=== [RPC] COMPORTEMENT — ISOLATION CROSS-TENANT / CROSS-ORDER ==="
OUT_OTHER_TENANT="$(as_service "select provider_reference from public.get_order_active_payment_attempt('$ORDER_OTHER_TENANT','$TOKEN_OTHER_TENANT','monetico');")"
assert_behav_eq "4a. commande du tenant Deux -> sa PROPRE référence, jamais celle du tenant Un" "$REF_OTHER_TENANT" "$OUT_OTHER_TENANT"
ROWCOUNT_CROSS_ORDER_TOKEN="$(as_service "select count(*) from public.get_order_active_payment_attempt('$ORDER_PENDING','$TOKEN_OTHER_TENANT','monetico');")"
assert_behav_eq "4b. jeton d'une AUTRE commande sur cette commande -> AUCUNE ligne" "0" "$ROWCOUNT_CROSS_ORDER_TOKEN"

log "=== [RPC] COMPORTEMENT — ÉCHEC FERMÉ, POSSESSION (mandat section 17) ==="
RANDOM_ORDER_ID="00000000-0000-0000-0000-000000000000"
RANDOM_TOKEN="00000000-0000-0000-0000-000000000000"
assert_behav_eq "5a. mauvais jeton (jeton d'une autre commande) -> AUCUNE ligne" "0" "$(as_service "select count(*) from public.get_order_active_payment_attempt('$ORDER_PENDING','$RANDOM_TOKEN','monetico');")"
assert_behav_eq "5b. order_id inconnu -> AUCUNE ligne" "0" "$(as_service "select count(*) from public.get_order_active_payment_attempt('$RANDOM_ORDER_ID','$TOKEN_PENDING','monetico');")"
assert_behav_eq "5c. p_order_id NULL -> AUCUNE ligne" "0" "$(as_service "select count(*) from public.get_order_active_payment_attempt(null,'$TOKEN_PENDING','monetico');")"
assert_behav_eq "5d. p_public_token NULL -> AUCUNE ligne" "0" "$(as_service "select count(*) from public.get_order_active_payment_attempt('$ORDER_PENDING',null,'monetico');")"
assert_behav_eq "5e. order_id et public_token tous deux NULL -> AUCUNE ligne" "0" "$(as_service "select count(*) from public.get_order_active_payment_attempt(null,null,'monetico');")"

RC_WRONG_TOKEN="$(as_service_rc "select * from public.get_order_active_payment_attempt('$ORDER_PENDING','$RANDOM_TOKEN','monetico');")"
RC_WRONG_ORDER="$(as_service_rc "select * from public.get_order_active_payment_attempt('$RANDOM_ORDER_ID','$TOKEN_PENDING','monetico');")"
assert_behav_eq "5f. code de sortie identique (0, pas d'erreur) pour mauvais jeton et mauvaise commande (confidentialité de possession)" "$RC_WRONG_TOKEN" "$RC_WRONG_ORDER"
assert_behav_eq "5g. ce code de sortie commun est bien 0 (SELECT vide, jamais une exception distinctive)" "0" "$RC_WRONG_TOKEN"

log "=== [RPC] COMPORTEMENT — PRÉDICAT TENTATIVE COURANTE (mandat section 5) ==="
assert_behav_eq "6a. tentative PAYÉE (terminale) -> AUCUNE ligne (jamais renvoyée)" "0" "$(as_service "select count(*) from public.get_order_active_payment_attempt('$ORDER_PAID','$TOKEN_PAID','monetico');")"
assert_behav_eq "6b. tentative FAILED (terminale) -> AUCUNE ligne" "0" "$(as_service "select count(*) from public.get_order_active_payment_attempt('$ORDER_FAILED','$TOKEN_FAILED','monetico');")"
assert_behav_eq "6c. tentative CANCELLED (terminale) -> AUCUNE ligne" "0" "$(as_service "select count(*) from public.get_order_active_payment_attempt('$ORDER_CANCELLED','$TOKEN_CANCELLED','monetico');")"
assert_behav_eq "6d. commande jamais engagée (payment_status='not_required', aucune tentative) -> AUCUNE ligne" "0" "$(as_service "select count(*) from public.get_order_active_payment_attempt('$ORDER_NONE','$TOKEN_NONE','monetico');")"

log "=== [RPC] COMPORTEMENT — PROVIDER (mandat section 6/17) ==="
assert_behav_eq "7a. provider_code différent ('other_provider') -> AUCUNE ligne" "0" "$(as_service "select count(*) from public.get_order_active_payment_attempt('$ORDER_PENDING','$TOKEN_PENDING','other_provider');")"
assert_behav_eq "7b. provider_code vide ('') -> AUCUNE ligne (échec fermé, jamais une exception distincte)" "0" "$(as_service "select count(*) from public.get_order_active_payment_attempt('$ORDER_PENDING','$TOKEN_PENDING','');")"
assert_behav_eq "7c. provider_code NULL -> AUCUNE ligne" "0" "$(as_service "select count(*) from public.get_order_active_payment_attempt('$ORDER_PENDING','$TOKEN_PENDING',null);")"
assert_behav_eq "7d. provider_code avec espaces superflus ('  monetico  ') -> normalisé (btrim), même ligne retrouvée (convention P1)" "${REF_PENDING}|${EXPECTED_AMOUNT}|${EXPECTED_CURRENCY}" "$(as_service "select provider_reference, amount, currency from public.get_order_active_payment_attempt('$ORDER_PENDING','$TOKEN_PENDING','  monetico  ');")"

log "=== [RPC] COMPORTEMENT — MODÈLE D'EXÉCUTION (anon/authenticated refusés) ==="
RC_ANON="$(as_anon_rc "select * from public.get_order_active_payment_attempt('$ORDER_PENDING','$TOKEN_PENDING','monetico');")"
assert_behav_eq "8a. anon EXECUTE refusé (permission denied, RC != 0) même avec possession valide" "1" "$([ "$RC_ANON" != "0" ] && echo 1 || echo 0)"
RC_AUTH="$(as_user_rc "$OWNER_UID" "select * from public.get_order_active_payment_attempt('$ORDER_PENDING','$TOKEN_PENDING','monetico');")"
assert_behav_eq "8b. authenticated (même personnel du restaurant concerné) EXECUTE refusé (permission denied, RC != 0)" "1" "$([ "$RC_AUTH" != "0" ] && echo 1 || echo 0)"

log "=== [RPC] COMPORTEMENT — AUCUNE MUTATION (mandat section 7) ==="
ORDER_STATUS_BEFORE="$(sql "select payment_status from orders where id='$ORDER_PENDING';")"
TXN_STATUS_BEFORE="$(sql "select status from payment_transactions where order_id='$ORDER_PENDING';")"
POINTER_BEFORE="$(sql "select current_payment_transaction_id from orders where id='$ORDER_PENDING';")"
as_service "select * from public.get_order_active_payment_attempt('$ORDER_PENDING','$TOKEN_PENDING','monetico');" >/dev/null
as_service "select * from public.get_order_active_payment_attempt('$ORDER_PENDING','$RANDOM_TOKEN','monetico');" >/dev/null
as_service "select * from public.get_order_active_payment_attempt('$ORDER_PENDING','$TOKEN_PENDING','monetico');" >/dev/null
ORDER_STATUS_AFTER="$(sql "select payment_status from orders where id='$ORDER_PENDING';")"
TXN_STATUS_AFTER="$(sql "select status from payment_transactions where order_id='$ORDER_PENDING';")"
POINTER_AFTER="$(sql "select current_payment_transaction_id from orders where id='$ORDER_PENDING';")"
assert_behav_eq "9a. orders.payment_status inchangé après appels répétés (valides et invalides)" "$ORDER_STATUS_BEFORE" "$ORDER_STATUS_AFTER"
assert_behav_eq "9b. payment_transactions.status inchangé" "$TXN_STATUS_BEFORE" "$TXN_STATUS_AFTER"
assert_behav_eq "9c. orders.current_payment_transaction_id inchangé (pointeur non modifié)" "$POINTER_BEFORE" "$POINTER_AFTER"

# ============================================================
# NON-RÉGRESSION (mandat sections 15/16/19) — P1 INCHANGÉ, P3-B2
# INCHANGÉ, ACL de table préservée.
# ============================================================
log "=== NON-RÉGRESSION (P1 / ACL DE TABLE) ==="
assert_struct_eq "10a. orders : RLS toujours active" "t" "$(sql "select relrowsecurity from pg_class where relname='orders' and relnamespace='public'::regnamespace;")"
assert_struct_eq "10b. payment_transactions : AUCUN grant de table nouveau à service_role (RPC-ONLY AUTHORITY préservée, PAY-P1-03)" "f" "$(sql "select has_table_privilege('service_role','payment_transactions','SELECT');")"
assert_struct_eq "10c. orders : AUCUN grant de table nouveau à service_role" "f" "$(sql "select has_table_privilege('service_role','orders','SELECT');")"

RC_INITIATE_STILL_WORKS="$(as_service_rc "select * from public.initiate_payment_attempt('$ORDER_NONE','monetico','p3b3-nonreg-init-ref');")"
assert_behav_eq "11a. initiate_payment_attempt toujours réellement fonctionnelle (signature à 3 arguments inchangée)" "0" "$RC_INITIATE_STILL_WORKS"
NONE_STATUS_AFTER_INIT="$(sql "select payment_status from orders where id='$ORDER_NONE';")"
assert_behav_eq "11b. initiate_payment_attempt a bien produit son effet attendu (payment_status='pending') -- fonction non cassée par ce lot" "pending" "$NONE_STATUS_AFTER_INIT"

RC_CONFIRM_STILL_WORKS="$(as_service_rc "select * from public.confirm_payment_attempt('monetico','p3b3-nonreg-init-ref','paid');")"
assert_behav_eq "12. confirm_payment_attempt toujours réellement fonctionnelle (fonction non cassée par ce lot)" "0" "$RC_CONFIRM_STILL_WORKS"

# Nouvelle capacité de reprise reflète bien l'effet de confirm_payment_attempt :
# une tentative désormais 'paid' ne doit plus être renvoyée par P3-B3.
assert_behav_eq "13. après confirmation 'paid' de la tentative non-régression, get_order_active_payment_attempt ne la renvoie plus (AUCUNE ligne)" "0" "$(as_service "select count(*) from public.get_order_active_payment_attempt('$ORDER_NONE','$TOKEN_NONE','monetico');")"

# ============================================================
# D. GARDES PRÉFLIGHT (double application + dérive schéma).
# ============================================================
log "=== [D] GARDES PRÉFLIGHT ==="
RC_DOUBLE_APPLY="$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B3_SQL" >/tmp/scanym-p3b3-double-$$.txt 2>&1; echo $?)"
assert_behav_eq "D1. double-application refusée (RC != 0)" "1" "$([ "$RC_DOUBLE_APPLY" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "D2. message SCANYM_SCHEMA_DRIFT présent dans le refus de double-application" "1" "$(grep -c 'SCANYM_SCHEMA_DRIFT' /tmp/scanym-p3b3-double-$$.txt || true)"
rm -f /tmp/scanym-p3b3-double-$$.txt

log "=== [D] DÉRIVE — orders sans PAYMENT P1 (current_payment_transaction_id absent) ==="
psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
createdb "$DB_DRIFT"
build_common_bootstrap "$DB_DRIFT"
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/schema.sql" >/dev/null
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-orders.sql" >/dev/null
RC_DRIFT_NO_P1="$(psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B3_SQL" >/tmp/scanym-p3b3-drift-$$.txt 2>&1; echo $?)"
assert_behav_eq "D3. application refusée sur schéma sans PAYMENT P1 (payment_transactions/current_payment_transaction_id absents) -- RC != 0" "1" "$([ "$RC_DRIFT_NO_P1" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "D4. message SCANYM_SCHEMA_DRIFT présent dans le refus (prérequis manquant)" "1" "$(grep -c 'SCANYM_SCHEMA_DRIFT' /tmp/scanym-p3b3-drift-$$.txt || true)"
rm -f /tmp/scanym-p3b3-drift-$$.txt
psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true

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
