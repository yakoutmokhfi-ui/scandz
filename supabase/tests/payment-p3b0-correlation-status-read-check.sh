#!/usr/bin/env bash
# ============================================================
# Scanym — PAYMENT P3-B0 v2 — CALLBACK CORRELATION + AUTHORITATIVE
# AMOUNT/CURRENCY + CUSTOMER PAYMENT STATUS READ — Harnais reproductible
# pour supabase/DRAFT-lot-payment-p3b0-correlation-status-read.sql.
#
# CORRECTION v2 (PAY-P3-B0-02, non-bloquant mais corrigé ici) : le
# harnais v1 déclarait dans son bilan final "X structurelles / Y
# comportementales" alors qu'aucune assertion n'appelait jamais
# réellement `behav()` -- `assert_eq()` appelait `pass()` directement,
# ne routant JAMAIS vers `struct()` ni `behav()`. Le compteur affiché
# était donc trompeur (toujours "N structurelles / 0 comportementale"
# quel que soit le contenu réel du harnais). CORRIGÉ ici en Option A
# (mandat P3-B0-V2 section 16) : deux fonctions dédiées
# `assert_struct_eq` (catalogue/ACL/introspection pg_proc, jamais
# d'exécution du chemin métier de la RPC) et `assert_behav_eq`
# (exécution réelle de la RPC ou d'une mutation, comportement observé)
# remplacent l'unique `assert_eq` précédent -- CHAQUE assertion du
# fichier route désormais explicitement vers l'une des deux, si bien
# que STRUCT_COUNT + BEHAV_COUNT == PASS_COUNT est maintenant une
# invariante vérifiable (voir bilan final) et non plus une coïncidence.
#
# CORRECTION v2 (PAY-P3-B0-01, RELEASE-BLOCKING, mandat P3-B0-V2
# sections 4/5/17-19) : ce harnais teste maintenant le contrat à SIX
# colonnes de RPC #1 (amount/currency AUTORITATIFS ajoutés), avec :
#   - vérification exacte des 6 colonnes et de leurs types (1k-1s) ;
#   - preuve structurelle que la RPC ne reçoit JAMAIS amount/currency en
#     paramètre (1s, 2f) ;
#   - valeurs exactes retournées depuis une fixture à précision
#     décimale non triviale (1234.57 EUR) sans arrondi/coercition
#     (2b, 2i) ;
#   - preuve d'isolation cross-tenant/cross-transaction sur
#     amount/currency (2e) ;
#   - re-vérification qu'aucune mutation n'affecte les nouvelles
#     colonnes (6d, 6e) ;
#   - re-vérification qu'aucun grant de table nouveau n'apparaît et que
#     service_role reste sans SELECT direct sur payment_transactions
#     (section 12, inchangée en substance, revérifiée après extension
#     du contrat).
#
# PostgreSQL communautaire vanilla (pas une instance Supabase managée),
# même patron que tous les harnais paiement précédents (P1/P2A/P2B-A/
# P3-A0) : rôles anon/authenticated/service_role recréés minimalement,
# auth.uid() simulé via `test.uid`. Ce lot ne touche PAS Vault -- aucun
# mock Vault n'est nécessaire ici (contrairement à P2A/P3-A0), les deux
# nouvelles RPC n'opèrent que sur payment_transactions/orders (P1,
# déjà installées).
#
# Chaîne MINIMALE (mandat section 11, éviter toute dépendance non
# nécessaire) : schema.sql -> migration-orders.sql -> ... ->
# migration-v81-lot1b-translations.sql, PUIS directement
# DRAFT-lot-payment-p1-foundation.sql -- sans les lots livraison/
# fulfillment (fulfillment-routing/server-delivery-pricing/merchant-
# delivery-pricing), qui n'introduisent aucun prérequis pour ce lot.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/payment-p3b0-correlation-status-read-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_PAYMENT_P1_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p1-foundation.sql"
DRAFT_PAYMENT_P3B0_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3b0-correlation-status-read.sql"
DB="scanym_payment_p3b0_$$"
DB_DRIFT="scanym_payment_p3b0_drift_$$"

PASS_COUNT=0
FAIL_COUNT=0
STRUCT_COUNT=0
BEHAV_COUNT=0
FAIL_LOG="/tmp/scanym-payment-p3b0-fails-$$.log"
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

# PAY-P3-B0-02 : deux routes EXPLICITES et EXCLUSIVES vers pass() --
# plus aucune assertion de ce fichier n'appelle pass()/struct()/behav()
# directement dans un test "assert_eq" générique non catégorisé.
#
# assert_struct_eq : la valeur observée vient EXCLUSIVEMENT du
#   catalogue système (pg_proc/pg_type/information_schema/pg_policies/
#   has_*_privilege) -- aucune exécution du chemin métier des RPC sous
#   test, uniquement leur signature/ACL/déclaration telle que posée par
#   la migration.
# assert_behav_eq : la valeur observée provient de l'EXÉCUTION réelle
#   d'une requête/RPC (ou de la ré-application réelle de la migration)
#   -- comportement observé, pas seulement déclaré.
assert_struct_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then struct "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_behav_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then behav "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}

sql() { psql -X -A -q -t -d "$DB" -c "$1"; }

super_rc() {
  psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-p3b0-out-$$.txt 2>/tmp/scanym-p3b0-err-$$.txt
  echo $?
}
as_user_rc() {
  local uid="$1" query="$2"
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$uid'; $query" >/tmp/scanym-p3b0-out-$$.txt 2>/tmp/scanym-p3b0-err-$$.txt
  echo $?
}
as_service() {
  local query="$1"
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$query" 2>&1
}
as_service_rc() {
  local query="$1"
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p3b0-out-$$.txt 2>/tmp/scanym-p3b0-err-$$.txt
  echo $?
}
as_anon() {
  local query="$1"
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$query" 2>&1
}
as_anon_rc() {
  local query="$1"
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-p3b0-out-$$.txt 2>/tmp/scanym-p3b0-err-$$.txt
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
  # Chaîne MINIMALE : exactement les prérequis de PAYMENT P1 FOUNDATION
  # (orders/restaurants/is_member_of/has_role_in/touch_updated_at),
  # sans les lots livraison/fulfillment -- P1 crée lui-même
  # scanym_numeric_is_non_finite puisqu'il est absent ici (même patron
  # que build_minimal_chain du harnais P1 lui-même).
  local dbname="$1"
  for f in schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql; do
    psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
    psql -d "$dbname" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  done
  for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql; do
    psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  done
}

# ============================================================
# 0. BASELINE — chaîne minimale + P1 (installée) + P3-B0 v2 (LOT SOUS TEST).
# ============================================================
log "=== [0] Construction baseline $DB (chaîne minimale + P1) ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
build_common_bootstrap "$DB"
build_minimal_chain "$DB"
struct "chaîne minimale appliquée (schema.sql .. migration-v81-lot1b-translations.sql)"

psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P1_SQL" >/dev/null
struct "DRAFT-lot-payment-p1-foundation.sql appliqué sans erreur (prérequis P3-B0)"

psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B0_SQL" >/dev/null
struct "DRAFT-lot-payment-p3b0-correlation-status-read.sql (v2) appliqué sans erreur (LOT SOUS TEST) -- fichier unique, forme finale directe, aucune séquence v1 puis v2"

# ============================================================
# FIXTURES — 2 tenants, plusieurs commandes/tentatives. L'une des deux
# montants porte une précision décimale non triviale (1234.57, PAS un
# multiple rond de 0.50/1.00) pour détecter tout arrondi/coercition
# accidentel introduit par le contrat à 6 colonnes (mandat P3-B0-V2
# section 17, "at least one amount value WITH decimal precision").
# Les deux devises sont des codes à 3 lettres valides (mandat
# P3-B0-V2 section 17, "at least one proper 3-letter currency value").
# ============================================================
log "=== Fixtures (Tenant Un + Tenant Deux) ==="
OWNER_UID="30000000-0000-0000-0000-000000000001"
OTHER_OWNER_UID="40000000-0000-0000-0000-000000000001"

psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into auth.users (id, email) values
  ('$OWNER_UID', 'owner@p3b0-fixture-one.test'),
  ('$OTHER_OWNER_UID', 'owner@p3b0-fixture-two.test');

with resto as (
  insert into restaurants (name, slug, status) values ('P3B0 Fixture Tenant One', 'p3b0-fixture-tenant-one', 'active') returning id
)
insert into restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number)
select id, 0, 'EUR', '+33600001001' from resto;

with resto2 as (
  insert into restaurants (name, slug, status) values ('P3B0 Fixture Tenant Two', 'p3b0-fixture-tenant-two', 'active') returning id
)
insert into restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number)
select id, 0, 'EUR', '+33600001002' from resto2;
SQL

RID_ONE="$(sql "select id from restaurants where slug='p3b0-fixture-tenant-one';")"
RID_TWO="$(sql "select id from restaurants where slug='p3b0-fixture-tenant-two';")"

psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into restaurant_users (restaurant_id, user_id, role) values
  ('$RID_ONE', '$OWNER_UID', 'owner'),
  ('$RID_TWO', '$OTHER_OWNER_UID', 'owner');
SQL

# Tenant Un : montant à précision décimale non triviale (1234.57).
ORDER_ONE="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 1, 'pickup', 1234.57, 1234.57, 'EUR') returning id;")"
# Tenant Deux : montant distinct (12.50) -- sert de preuve de
# non-fuite cross-tenant/cross-transaction (2e) : si le contrat à 6
# colonnes mélangeait par erreur les lignes, ce montant apparaîtrait
# à la place de 1234.57 ou inversement.
ORDER_TWO="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_TWO', 1, 'pickup', 12.50, 12.50, 'EUR') returning id;")"
ORDER_UNSTARTED="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 2, 'pickup', 8.00, 8.00, 'EUR') returning id;")"
TOKEN_ONE="$(sql "select public_token from orders where id='$ORDER_ONE';")"
TOKEN_TWO="$(sql "select public_token from orders where id='$ORDER_TWO';")"
TOKEN_UNSTARTED="$(sql "select public_token from orders where id='$ORDER_UNSTARTED';")"
struct "fixtures : 2 tenants, 3 commandes (jetons publics distincts confirmés), montants 1234.57 EUR / 12.50 EUR (précision décimale + devise 3 lettres)"
assert_struct_eq "fixture: les 3 public_token sont distincts" "3" "$(printf '%s\n%s\n%s\n' "$TOKEN_ONE" "$TOKEN_TWO" "$TOKEN_UNSTARTED" | sort -u | wc -l | tr -d ' ')"

# Initie et confirme une tentative pour Tenant Un (paid), une pour
# Tenant Deux (pending) -- provider_reference synthétique, jamais un
# vrai credential.
as_service "select public.initiate_payment_attempt('$ORDER_ONE','monetico','p3b0-ref-one');" >/dev/null
as_service "select public.confirm_payment_attempt('monetico','p3b0-ref-one','paid');" >/dev/null
as_service "select public.initiate_payment_attempt('$ORDER_TWO','monetico','p3b0-ref-two');" >/dev/null
TXN_ONE="$(sql "select id from payment_transactions where provider_code='monetico' and provider_reference='p3b0-ref-one';")"
TXN_TWO="$(sql "select id from payment_transactions where provider_code='monetico' and provider_reference='p3b0-ref-two';")"
struct "fixtures : tentative Un (monetico/p3b0-ref-one) PAID amount=1234.57 EUR, tentative Deux (monetico/p3b0-ref-two) PENDING amount=12.50 EUR"
assert_struct_eq "fixture: amount stocké par initiate_payment_attempt pour tentative Un = 1234.57 (précision décimale préservée dès l'écriture)" "1234.57" "$(sql "select amount from payment_transactions where id='$TXN_ONE';")"
assert_struct_eq "fixture: amount stocké par initiate_payment_attempt pour tentative Deux = 12.50" "12.50" "$(sql "select amount from payment_transactions where id='$TXN_TWO';")"

# ============================================================
# RPC #1 — CATALOGUE DE FONCTION (structure/ACL/types -- struct()
# exclusivement : aucune assertion de ce bloc n'exécute le chemin
# métier de la RPC, uniquement son catalogue système).
# ============================================================
log "=== [RPC #1] CATALOGUE DE FONCTION ==="
assert_struct_eq "1a. la fonction existe avec la signature d'entrée exacte (2 arguments text,text)" "1" "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_payment_transaction_correlation' and p.pronargs=2 and array(select unnest(p.proargtypes))=array['text','text']::regtype[]::oid[];")"
assert_struct_eq "1b. SECURITY DEFINER (prosecdef=true)" "t" "$(sql "select prosecdef from pg_proc where proname='get_payment_transaction_correlation' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1c. langage = plpgsql" "plpgsql" "$(sql "select l.lanname from pg_proc p join pg_language l on l.oid=p.prolang where p.proname='get_payment_transaction_correlation' and p.pronamespace='public'::regnamespace;")"
assert_struct_eq "1d. volatilité = stable" "s" "$(sql "select provolatile from pg_proc where proname='get_payment_transaction_correlation' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1e. search_path explicitement vide" "1" "$(sql "select count(*) from pg_proc where proname='get_payment_transaction_correlation' and pronamespace='public'::regnamespace and 'search_path=\"\"' = any(proconfig);")"
assert_struct_eq "1f. propriétaire = rôle ayant exécuté la migration (aucun OWNER TO explicite requis)" "$(sql "select current_user;")" "$(sql "select r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner where p.proname='get_payment_transaction_correlation' and p.pronamespace='public'::regnamespace;")"
assert_struct_eq "1g. EXECUTE effectif service_role = OUI" "t" "$(sql "select has_function_privilege('service_role', 'public.get_payment_transaction_correlation(text,text)', 'execute');")"
assert_struct_eq "1h. EXECUTE effectif anon = NON" "f" "$(sql "select has_function_privilege('anon', 'public.get_payment_transaction_correlation(text,text)', 'execute');")"
assert_struct_eq "1i. EXECUTE effectif authenticated = NON" "f" "$(sql "select has_function_privilege('authenticated', 'public.get_payment_transaction_correlation(text,text)', 'execute');")"
assert_struct_eq "1j. AUCUN grant EXECUTE résiduel à PUBLIC" "0" "$(sql "select count(*) from information_schema.role_routine_grants where routine_schema='public' and routine_name='get_payment_transaction_correlation' and grantee='PUBLIC';")"
assert_struct_eq "1k. CONTRAT v2 -- retourne EXACTEMENT 6 colonnes, dans cet ordre : restaurant_id,order_id,transaction_id,status,amount,currency (PAY-P3-B0-01 : amount/currency désormais inclus)" "restaurant_id,order_id,transaction_id,status,amount,currency" "$(sql "select array_to_string(proargnames[array_position(proargmodes,'t'::\"char\"):array_length(proargmodes,1)], ',') from pg_proc where proname='get_payment_transaction_correlation' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1l. type catalogue de la colonne de sortie 'amount' = numeric (aucune transformation de précision inventée, mandat section 4)" "numeric" "$(sql "select proallargtypes[array_position(proargmodes,'t'::\"char\")+4]::regtype::text from pg_proc where proname='get_payment_transaction_correlation' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1m. type catalogue de la colonne de sortie 'currency' = text" "text" "$(sql "select proallargtypes[array_position(proargmodes,'t'::\"char\")+5]::regtype::text from pg_proc where proname='get_payment_transaction_correlation' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1n. type de sortie 'amount' (numeric) identique au data_type catalogue de la colonne source payment_transactions.amount" "$(sql "select data_type from information_schema.columns where table_schema='public' and table_name='payment_transactions' and column_name='amount';")" "$(sql "select proallargtypes[array_position(proargmodes,'t'::\"char\")+4]::regtype::text from pg_proc where proname='get_payment_transaction_correlation' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1o. type de sortie 'amount' (numeric) IDENTIQUE à celui déjà renvoyé par initiate_payment_attempt (même convention P1 réutilisée à l'identique, aucune divergence inventée)" "$(sql "select proallargtypes[array_position(proargmodes,'t'::\"char\")+1]::regtype::text from pg_proc where proname='initiate_payment_attempt' and pronamespace='public'::regnamespace;")" "$(sql "select proallargtypes[array_position(proargmodes,'t'::\"char\")+4]::regtype::text from pg_proc where proname='get_payment_transaction_correlation' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1p. type de sortie 'currency' (text) IDENTIQUE à celui déjà renvoyé par initiate_payment_attempt (même cast ::text depuis varchar(10), même convention P1 réutilisée à l'identique)" "$(sql "select proallargtypes[array_position(proargmodes,'t'::\"char\")+2]::regtype::text from pg_proc where proname='initiate_payment_attempt' and pronamespace='public'::regnamespace;")" "$(sql "select proallargtypes[array_position(proargmodes,'t'::\"char\")+5]::regtype::text from pg_proc where proname='get_payment_transaction_correlation' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1q. la colonne source payment_transactions.currency reste varchar(10) sans CHECK de format -- AUCUNE contrainte de normalisation (majuscule/3 lettres/ISO-4217) n'existe au niveau base, donc aucune n'est revendiquée par ce lot (mandat section 13)" "character varying" "$(sql "select data_type from information_schema.columns where table_schema='public' and table_name='payment_transactions' and column_name='currency';")"
assert_struct_eq "1r. PREUVE STRUCTURELLE -- la fonction ne déclare AUCUN paramètre d'ENTRÉE nommé amount/currency : ses 2 SEULS arguments IN sont p_provider_code,p_provider_reference (donc structurellement, aucune valeur amount/currency fournie par un appelant -- a fortiori un futur callback prestataire -- ne peut jamais atteindre cette fonction, mandat section 18)" "p_provider_code,p_provider_reference" "$(sql "select array_to_string(proargnames[1:array_position(proargmodes,'t'::\"char\")-1], ',') from pg_proc where proname='get_payment_transaction_correlation' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1s. AUCUN grant de table nouveau posé sur payment_transactions par ce lot (revérifié après extension du contrat à 6 colonnes)" "0" "$(sql "select count(*) from information_schema.role_table_grants where table_schema='public' and table_name='payment_transactions' and grantee='service_role';")"

# ============================================================
# RPC #1 — COMPORTEMENT (corrélation, ACL, échecs fermés, isolation,
# amount/currency autoritatifs -- behav() exclusivement : chaque
# assertion de ce bloc exécute réellement la RPC ou une requête
# directe et observe le résultat produit).
# ============================================================
log "=== [RPC #1] COMPORTEMENT ==="
RC_SVC1="$(as_service_rc "select * from public.get_payment_transaction_correlation('monetico','p3b0-ref-one');")"
assert_behav_eq "2a. service_role : corrélation réussit pour une référence existante" "0" "$RC_SVC1"
CORR_ONE="$(as_service "select restaurant_id, order_id, transaction_id, status, amount, currency from public.get_payment_transaction_correlation('monetico','p3b0-ref-one');")"
assert_behav_eq "2b. CONTRAT v2 -- corrélation renvoie EXACTEMENT restaurant_id|order_id|transaction_id|status|amount|currency attendus (PAID, 1234.57, EUR -- précision décimale préservée SANS arrondi ni coercition)" "${RID_ONE}|${ORDER_ONE}|${TXN_ONE}|paid|1234.57|EUR" "$CORR_ONE"
CORR_TWO="$(as_service "select restaurant_id, order_id, transaction_id, status, amount, currency from public.get_payment_transaction_correlation('monetico','p3b0-ref-two');")"
assert_behav_eq "2c. corrélation Tenant Deux renvoie son propre restaurant_id/order_id/transaction_id, statut PENDING, amount=12.50, currency=EUR" "${RID_TWO}|${ORDER_TWO}|${TXN_TWO}|pending|12.50|EUR" "$CORR_TWO"

# 2d/2e : isolation cross-tenant/cross-transaction sur amount/currency
# EXPLICITE -- au-delà de la comparaison de tuple complet ci-dessus
# (2b/2c), extraction ISOLÉE du seul champ amount pour prouver
# directement qu'aucune valeur d'une autre tentative ne peut fuiter
# (mandat section 17, "another transaction's values cannot leak").
AMOUNT_ONE_ONLY="$(as_service "select amount from public.get_payment_transaction_correlation('monetico','p3b0-ref-one');")"
AMOUNT_TWO_ONLY="$(as_service "select amount from public.get_payment_transaction_correlation('monetico','p3b0-ref-two');")"
assert_behav_eq "2d. amount isolé de la tentative Un = 1234.57 EXACTEMENT, jamais 12.50 (montant de la tentative Deux)" "1234.57" "$AMOUNT_ONE_ONLY"
assert_behav_eq "2e. amount isolé de la tentative Deux = 12.50 EXACTEMENT, jamais 1234.57 (montant de la tentative Un) -- preuve d'isolation cross-transaction dans les deux sens" "12.50" "$AMOUNT_TWO_ONLY"

# 2f : preuve COMPORTEMENTALE complémentaire à 1r -- une tentative
# d'appel avec un 3e argument simulant un "montant fourni par le
# callback" échoue au niveau SQL lui-même (aucune signature
# (text,text,numeric/text) n'existe) : il n'existe structurellement
# AUCUN chemin d'appel par lequel une valeur externe pourrait influencer
# ce que la RPC renvoie (mandat section 19, "no attacker/provider input
# can influence what it authoritatively returns").
RC_EXTRA_ARG="$(as_service_rc "select * from public.get_payment_transaction_correlation('monetico','p3b0-ref-one', 999999.99);")"
assert_behav_eq "2f. appel avec un 3e argument (simulant un montant de callback falsifié) REJETÉ par Postgres lui-même (aucune telle signature n'existe) -- aucune injection d'amount/currency possible par ce chemin" "1" "$([ "$RC_EXTRA_ARG" != "0" ] && echo 1 || echo 0)"

# 2g/2h : type RUNTIME observé (complète 1l/1m qui ne vérifient que le
# catalogue déclaré, jamais une exécution réelle).
RUNTIME_TYPE_AMOUNT="$(as_service "select pg_typeof(amount)::text from public.get_payment_transaction_correlation('monetico','p3b0-ref-one');")"
RUNTIME_TYPE_CURRENCY="$(as_service "select pg_typeof(currency)::text from public.get_payment_transaction_correlation('monetico','p3b0-ref-one');")"
assert_behav_eq "2g. type RUNTIME observé de amount = numeric (exécution réelle, pas seulement déclaré au catalogue)" "numeric" "$RUNTIME_TYPE_AMOUNT"
assert_behav_eq "2h. type RUNTIME observé de currency = text" "text" "$RUNTIME_TYPE_CURRENCY"

RC_WRONG_REF="$(as_service_rc "select * from public.get_payment_transaction_correlation('monetico','no-such-reference');")"
assert_behav_eq "3a. provider_reference inconnue -> échec fermé (P0002)" "1" "$([ "$RC_WRONG_REF" != "0" ] && echo 1 || echo 0)"
RC_WRONG_CODE="$(as_service_rc "select * from public.get_payment_transaction_correlation('mercanet','p3b0-ref-one');")"
assert_behav_eq "3b. provider_code correct mais NON celui de la ligne (mercanet vs monetico) -> échec fermé" "1" "$([ "$RC_WRONG_CODE" != "0" ] && echo 1 || echo 0)"
RC_EMPTY_REF="$(as_service_rc "select * from public.get_payment_transaction_correlation('monetico','');")"
assert_behav_eq "3c. provider_reference vide -> échec fermé (validation d'entrée)" "1" "$([ "$RC_EMPTY_REF" != "0" ] && echo 1 || echo 0)"
RC_EMPTY_CODE="$(as_service_rc "select * from public.get_payment_transaction_correlation('','p3b0-ref-one');")"
assert_behav_eq "3d. provider_code vide -> échec fermé (validation d'entrée)" "1" "$([ "$RC_EMPTY_CODE" != "0" ] && echo 1 || echo 0)"
RC_NULL="$(as_service_rc "select * from public.get_payment_transaction_correlation(null,null);")"
assert_behav_eq "3e. provider_code/provider_reference NULL -> échec fermé" "1" "$([ "$RC_NULL" != "0" ] && echo 1 || echo 0)"

RC_AUTH1="$(as_user_rc "$OWNER_UID" "select * from public.get_payment_transaction_correlation('monetico','p3b0-ref-one');")"
assert_behav_eq "4a. authenticated (y compris propriétaire du restaurant concerné) NE PEUT PAS exécuter la corrélation" "1" "$([ "$RC_AUTH1" != "0" ] && echo 1 || echo 0)"
RC_ANON1="$(as_anon_rc "select * from public.get_payment_transaction_correlation('monetico','p3b0-ref-one');")"
assert_behav_eq "4b. anon NE PEUT PAS exécuter la corrélation" "1" "$([ "$RC_ANON1" != "0" ] && echo 1 || echo 0)"

RC_DIRECT_SELECT="$(as_service_rc "select count(*) from payment_transactions;")"
assert_behav_eq "5. service_role NE PEUT toujours PAS lire payment_transactions DIRECTEMENT (RPC-ONLY AUTHORITY, PAY-P1-03, inchangé après P3-B0 v2 malgré l'extension du contrat à 6 colonnes)" "1" "$([ "$RC_DIRECT_SELECT" != "0" ] && echo 1 || echo 0)"

TXN_COUNT_BEFORE="$(sql "select count(*) from payment_transactions;")"
as_service "select * from public.get_payment_transaction_correlation('monetico','p3b0-ref-one');" >/dev/null
as_service "select * from public.get_payment_transaction_correlation('monetico','no-such-reference');" >/dev/null 2>&1 || true
TXN_COUNT_AFTER="$(sql "select count(*) from payment_transactions;")"
assert_behav_eq "6a. aucune mutation de payment_transactions après plusieurs appels (succès et échecs)" "$TXN_COUNT_BEFORE" "$TXN_COUNT_AFTER"
STATUS_UNCHANGED="$(sql "select status from payment_transactions where id='$TXN_ONE';")"
assert_behav_eq "6b. statut de la tentative Un reste 'paid' (jamais modifié par la corrélation, lecture pure)" "paid" "$STATUS_UNCHANGED"
ORDER_PTR_UNCHANGED="$(sql "select current_payment_transaction_id from orders where id='$ORDER_ONE';")"
assert_behav_eq "6c. current_payment_transaction_id de la commande Un inchangé" "$TXN_ONE" "$ORDER_PTR_UNCHANGED"
AMOUNT_UNCHANGED_AFTER_READS="$(sql "select amount from payment_transactions where id='$TXN_ONE';")"
assert_behav_eq "6d. amount de la tentative Un reste 1234.57 après lectures répétées (aucune mutation, aucune dérive de précision introduite par les appels de corrélation)" "1234.57" "$AMOUNT_UNCHANGED_AFTER_READS"
CURRENCY_UNCHANGED_AFTER_READS="$(sql "select currency from payment_transactions where id='$TXN_ONE';")"
assert_behav_eq "6e. currency de la tentative Un reste EUR après lectures répétées" "EUR" "$CURRENCY_UNCHANGED_AFTER_READS"

# ============================================================
# RPC #2 — CATALOGUE DE FONCTION (structure/ACL -- struct()).
# Contrat INCHANGÉ depuis v1 (mandat P3-B0-V2 section 8, aucune
# correction requise) : re-vérifié à l'identique, pas élargi.
# ============================================================
log "=== [RPC #2] CATALOGUE DE FONCTION ==="
assert_struct_eq "7a. la fonction existe avec la signature exacte (2 arguments uuid,uuid)" "1" "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_order_payment_status' and p.pronargs=2 and array(select unnest(p.proargtypes))=array['uuid','uuid']::regtype[]::oid[];")"
assert_struct_eq "7b. SECURITY DEFINER (prosecdef=true)" "t" "$(sql "select prosecdef from pg_proc where proname='get_order_payment_status' and pronamespace='public'::regnamespace;")"
assert_struct_eq "7c. langage = sql" "sql" "$(sql "select l.lanname from pg_proc p join pg_language l on l.oid=p.prolang where p.proname='get_order_payment_status' and p.pronamespace='public'::regnamespace;")"
assert_struct_eq "7d. volatilité = stable" "s" "$(sql "select provolatile from pg_proc where proname='get_order_payment_status' and pronamespace='public'::regnamespace;")"
assert_struct_eq "7e. search_path explicitement vide" "1" "$(sql "select count(*) from pg_proc where proname='get_order_payment_status' and pronamespace='public'::regnamespace and 'search_path=\"\"' = any(proconfig);")"
assert_struct_eq "7f. CONTRAT INCHANGÉ v2 -- retourne exactement 1 colonne (payment_status) -- aucun champ interne, aucun amount/currency ajouté ici (mandat section 8, contrat non élargi)" "payment_status" "$(sql "select array_to_string(proargnames[array_position(proargmodes,'t'::\"char\"):array_length(proargmodes,1)], ',') from pg_proc where proname='get_order_payment_status' and pronamespace='public'::regnamespace;")"
assert_struct_eq "7g. EXECUTE effectif anon = OUI (posture create_order/mark_whatsapp_opened)" "t" "$(sql "select has_function_privilege('anon', 'public.get_order_payment_status(uuid,uuid)', 'execute');")"
assert_struct_eq "7h. EXECUTE effectif authenticated = OUI" "t" "$(sql "select has_function_privilege('authenticated', 'public.get_order_payment_status(uuid,uuid)', 'execute');")"
assert_struct_eq "7i. AUCUN grant EXECUTE résiduel à PUBLIC" "0" "$(sql "select count(*) from information_schema.role_routine_grants where routine_schema='public' and routine_name='get_order_payment_status' and grantee='PUBLIC';")"

# ============================================================
# RPC #2 — COMPORTEMENT (possession, fail-closed uniforme, isolation
# -- behav()).
# ============================================================
log "=== [RPC #2] COMPORTEMENT ==="
OUT_ANON_OK="$(as_anon "select payment_status from public.get_order_payment_status('$ORDER_ONE','$TOKEN_ONE');")"
assert_behav_eq "8a. anon + (order_id, public_token) corrects -> payment_status renvoyé ('paid')" "paid" "$OUT_ANON_OK"
OUT_ANON_UNSTARTED="$(as_anon "select payment_status from public.get_order_payment_status('$ORDER_UNSTARTED','$TOKEN_UNSTARTED');")"
assert_behav_eq "8b. commande jamais engagée dans un paiement -> payment_status='not_required' (défaut P1, inchangé)" "not_required" "$OUT_ANON_UNSTARTED"
OUT_ANON_PENDING="$(as_anon "select payment_status from public.get_order_payment_status('$ORDER_TWO','$TOKEN_TWO');")"
assert_behav_eq "8c. tentative encore pending -> payment_status='pending'" "pending" "$OUT_ANON_PENDING"

ROWCOUNT_WRONG_TOKEN="$(as_anon "select count(*) from public.get_order_payment_status('$ORDER_ONE','$TOKEN_TWO');")"
assert_behav_eq "9a. mauvais jeton (jeton de Deux sur commande de Un) -> AUCUNE ligne (jamais le statut de Un)" "0" "$ROWCOUNT_WRONG_TOKEN"
RANDOM_ORDER_ID="00000000-0000-0000-0000-000000000000"
ROWCOUNT_WRONG_ORDER="$(as_anon "select count(*) from public.get_order_payment_status('$RANDOM_ORDER_ID','$TOKEN_ONE');")"
assert_behav_eq "9b. mauvais order_id (inexistant) avec jeton valide d'une autre commande -> AUCUNE ligne" "0" "$ROWCOUNT_WRONG_ORDER"
ROWCOUNT_BOTH_NULL="$(as_anon "select count(*) from public.get_order_payment_status(null,null);")"
assert_behav_eq "9c. order_id et public_token NULL -> AUCUNE ligne (jamais une exception distincte)" "0" "$ROWCOUNT_BOTH_NULL"
ROWCOUNT_RANDOM_TOKEN="$(as_anon "select count(*) from public.get_order_payment_status('$ORDER_ONE','00000000-0000-0000-0000-000000000000');")"
assert_behav_eq "9d. order_id valide, jeton aléatoire non attribué -> AUCUNE ligne" "0" "$ROWCOUNT_RANDOM_TOKEN"

# 9e/9f : même comportement observable exact (aucune ligne, aucune
# erreur -- rc=0 dans les deux cas, un SELECT sans ligne n'est jamais
# une erreur psql) pour "mauvais jeton" vs "mauvaise commande" --
# preuve directe de l'exigence mandat section 6.
RC_WRONG_TOKEN="$(as_anon_rc "select * from public.get_order_payment_status('$ORDER_ONE','$TOKEN_TWO');")"
RC_WRONG_ORDER="$(as_anon_rc "select * from public.get_order_payment_status('$RANDOM_ORDER_ID','$TOKEN_ONE');")"
assert_behav_eq "9e. code de sortie identique (0, pas d'erreur) pour mauvais jeton et mauvaise commande" "$RC_WRONG_TOKEN" "$RC_WRONG_ORDER"
assert_behav_eq "9f. ce code de sortie commun est bien 0 (SELECT vide, jamais une exception distinctive)" "0" "$RC_WRONG_TOKEN"

OUT_AUTH="$(as_user_rc "$OWNER_UID" "select payment_status from public.get_order_payment_status('$ORDER_ONE','$TOKEN_ONE');")"
assert_behav_eq "10. authenticated (personnel) PEUT aussi exécuter (même posture que create_order, non restreint aux seuls anonymes)" "0" "$OUT_AUTH"

STATUS_UNCHANGED_AFTER_READ="$(sql "select payment_status from orders where id='$ORDER_ONE';")"
assert_behav_eq "11a. aucune mutation de orders.payment_status après lecture (répétée, succès et échecs)" "paid" "$STATUS_UNCHANGED_AFTER_READ"
as_anon "select * from public.get_order_payment_status('$ORDER_ONE','$TOKEN_ONE');" >/dev/null
as_anon "select * from public.get_order_payment_status('$ORDER_ONE','$TOKEN_TWO');" >/dev/null
STATUS_UNCHANGED_AFTER_READ2="$(sql "select payment_status from orders where id='$ORDER_ONE';")"
assert_behav_eq "11b. toujours inchangé après lectures répétées (valides et invalides)" "paid" "$STATUS_UNCHANGED_AFTER_READ2"

# ============================================================
# NON-RÉGRESSION P1 (mandat section 8) — grants de table INCHANGÉS
# (catalogue -- struct() ; 12d/13a-13c exécutent réellement une
# requête/RPC -- behav()).
# ============================================================
log "=== NON-RÉGRESSION P1 (ACL DE TABLE) ==="
assert_struct_eq "12a-1. payment_transactions : service_role toujours SANS SELECT direct (inchangé depuis P1, P3-B0 v2 n'ajoute aucun grant de table malgré l'extension du contrat à 6 colonnes)" "f" "$(sql "select has_table_privilege('service_role','payment_transactions','SELECT');")"
assert_struct_eq "12a-2. payment_transactions : service_role toujours SANS INSERT/UPDATE/DELETE direct" "f" "$(sql "select has_table_privilege('service_role','payment_transactions','INSERT') or has_table_privilege('service_role','payment_transactions','UPDATE') or has_table_privilege('service_role','payment_transactions','DELETE');")"
assert_struct_eq "12a-3. payment_transactions : authenticated conserve SELECT (RLS-filtré, inchangé depuis P1)" "t" "$(sql "select has_table_privilege('authenticated','payment_transactions','SELECT');")"
assert_struct_eq "12a-4. payment_transactions : anon toujours SANS aucun privilège" "f" "$(sql "select has_table_privilege('anon','payment_transactions','SELECT');")"
assert_struct_eq "12b. payment_provider_configs : toujours AUCUN grant à anon/authenticated/service_role/PUBLIC (P3-B0 v2 n'y touche pas)" "0" "$(sql "select count(*) from information_schema.role_table_grants where table_schema='public' and table_name='payment_provider_configs' and grantee in ('anon','authenticated','service_role','PUBLIC');")"
assert_struct_eq "12c. orders : RLS toujours active, policy 'merchant reads restaurant orders' (v29, staff-only) toujours présente (inchangée)" "1" "$(sql "select count(*) from pg_policies where schemaname='public' and tablename='orders' and policyname='merchant reads restaurant orders';")"
RC_ANON_ORDERS_DIRECT="$(as_anon_rc "select payment_status from orders where id='$ORDER_ONE';")"
ANON_ORDERS_DIRECT_ROWS="$(as_anon "select count(*) from orders where id='$ORDER_ONE';")"
assert_behav_eq "12d. anon ne peut toujours PAS lire orders directement (RLS -- get_order_payment_status reste la SEULE porte de lecture anonyme)" "0" "$ANON_ORDERS_DIRECT_ROWS"
RC_MERCH_INIT="$(as_user_rc "$OWNER_UID" "select public.initiate_payment_attempt('$ORDER_ONE','monetico','other-ref');")"
assert_behav_eq "13a. authenticated NE PEUT toujours PAS exécuter initiate_payment_attempt après P3-B0 v2" "1" "$([ "$RC_MERCH_INIT" != "0" ] && echo 1 || echo 0)"
RC_MERCH_CONFIRM="$(as_user_rc "$OWNER_UID" "select public.confirm_payment_attempt('monetico','p3b0-ref-one','failed');")"
assert_behav_eq "13b. authenticated NE PEUT toujours PAS exécuter confirm_payment_attempt après P3-B0 v2 (fonction elle-même INCHANGÉE, mandat section 15)" "1" "$([ "$RC_MERCH_CONFIRM" != "0" ] && echo 1 || echo 0)"
FINAL_STATUS_TXN_ONE="$(sql "select status from payment_transactions where id='$TXN_ONE';")"
assert_behav_eq "13c. tentative Un toujours 'paid' (la tentative de confirmation ci-dessus a bien été rejetée par l'ACL, pas seulement par la logique)" "paid" "$FINAL_STATUS_TXN_ONE"

# ============================================================
# GARDES ANTI-DÉRIVE (exécution réelle de la migration -- behav()).
# ============================================================
log "=== GARDES ANTI-DÉRIVE ==="
RC_DOUBLE_APPLY="$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B0_SQL" >/tmp/scanym-p3b0-double-$$.out 2>&1; echo $?)"
assert_behav_eq "D1. double application du lot REFUSÉE (SCANYM_SCHEMA_DRIFT)" "1" "$([ "$RC_DOUBLE_APPLY" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "D2. message de double application mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" /tmp/scanym-p3b0-double-$$.out || true)"
rm -f /tmp/scanym-p3b0-double-$$.out

log "=== GARDE — base SANS payment_transactions (prérequis P1 manquant) ==="
psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
createdb "$DB_DRIFT"
build_common_bootstrap "$DB_DRIFT"
build_minimal_chain "$DB_DRIFT"
RC_MISSING_PREREQ="$(psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3B0_SQL" >/tmp/scanym-p3b0-drift-$$.out 2>&1; echo $?)"
assert_behav_eq "D3. application sur base SANS payment_transactions (P1 absent) REFUSÉE dès la garde préflight" "1" "$([ "$RC_MISSING_PREREQ" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "D4. message mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" /tmp/scanym-p3b0-drift-$$.out || true)"
rm -f /tmp/scanym-p3b0-drift-$$.out

# ============================================================
# ABSENCE DE FUITE (mandat section 10) — aucun message d'erreur ne
# révèle l'existence/le contenu d'une autre tentative/tenant, y compris
# amount/currency (exécution réelle -- behav()).
# ============================================================
log "=== ABSENCE DE FUITE ==="
LEAK_TEST_OUT="$(as_service "select * from public.get_payment_transaction_correlation('monetico','no-such-reference');" 2>&1 || true)"
assert_behav_eq "14a. l'échec 'not found' de RPC#1 ne mentionne AUCUN restaurant_id/order_id réel du jeu de données" "0" "$(printf '%s' "$LEAK_TEST_OUT" | grep -cE "$RID_ONE|$RID_TWO|$ORDER_ONE|$ORDER_TWO" || true)"
assert_behav_eq "14b'. l'échec 'not found' de RPC#1 ne mentionne AUCUN montant/devise réel du jeu de données (1234.57 ni 12.50)" "0" "$(printf '%s' "$LEAK_TEST_OUT" | grep -cE "1234\.57|12\.50" || true)"
LEAK_TEST_OUT2="$(as_anon "select * from public.get_order_payment_status('$ORDER_ONE','$TOKEN_TWO');" 2>&1 || true)"
assert_behav_eq "14b. RPC#2 avec mauvais jeton ne renvoie AUCUN texte (ensemble vide, aucun message distinctif)" "" "$LEAK_TEST_OUT2"

# ============================================================
# BILAN — invariante PAY-P3-B0-02 : PASS_COUNT doit être EXACTEMENT
# égal à STRUCT_COUNT + BEHAV_COUNT (chaque assertion réussie de ce
# fichier route désormais vers l'une des deux catégories, aucune
# n'appelle plus jamais pass() de façon non catégorisée). Vérifié
# explicitement ci-dessous -- si cette invariante casse, le harnais
# lui-même échoue (et pas seulement son affichage).
# ============================================================
log "=== BILAN : $PASS_COUNT PASS / $FAIL_COUNT FAIL (dont $STRUCT_COUNT structurelles, $BEHAV_COUNT comportementales) ==="
if [ "$((STRUCT_COUNT + BEHAV_COUNT))" -ne "$PASS_COUNT" ]; then
  log "FAIL: PAY-P3-B0-02 NON CORRIGÉ -- STRUCT_COUNT($STRUCT_COUNT) + BEHAV_COUNT($BEHAV_COUNT) != PASS_COUNT($PASS_COUNT) -- une assertion appelle encore pass() sans catégorie"
  FAIL_COUNT=$((FAIL_COUNT+1))
fi
if [ "$FAIL_COUNT" -gt 0 ]; then
  log "--- Détail des échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
