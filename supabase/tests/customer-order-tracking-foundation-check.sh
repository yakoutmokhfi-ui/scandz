#!/usr/bin/env bash
# ============================================================
# Scanym — CUSTOMER ORDER TRACKING FOUNDATION v1 — Harnais reproductible
# pour supabase/DRAFT-lot-customer-order-tracking-foundation.sql.
#
# PostgreSQL communautaire vanilla (pas une instance Supabase managée),
# même patron que les harnais paiement précédents (P1/P3-B0/P3-B2) :
# rôles anon/authenticated/service_role recréés minimalement, auth.uid()
# simulé via `test.uid`.
#
# Chaîne MINIMALE (éviter toute dépendance non nécessaire) : schema.sql
# -> migration-orders.sql -> migration-orders-lang.sql ->
# migration-v29-merchant-dashboard.sql, PUIS directement
# DRAFT-lot-customer-order-tracking-foundation.sql -- SANS PAYMENT P1/
# P3-A*/P3-B* (ce lot ne dépend d'AUCUNE table/colonne payment_*, voir
# le commentaire "INDÉPENDANCE VIS-À-VIS DU PAIEMENT" du fichier SQL
# sous test) et SANS les lots livraison/fulfillment (aucun prérequis
# pour ce lot).
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   sudo -u postgres bash supabase/tests/customer-order-tracking-foundation-check.sh
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_SQL="$SUPABASE_DIR/DRAFT-lot-customer-order-tracking-foundation.sql"
DB="scanym_order_tracking_$$"
DB_DRIFT="scanym_order_tracking_drift_$$"
DB_DRIFT_MANUALREVIEW="scanym_order_tracking_drift_mr_$$"
DB_DRIFT_X1="scanym_order_tracking_drift_x1_$$"
DB_DRIFT_RENAMED="scanym_order_tracking_drift_renamed_$$"

PASS_COUNT=0
FAIL_COUNT=0
STRUCT_COUNT=0
BEHAV_COUNT=0
FAIL_LOG="/tmp/scanym-order-tracking-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }
struct() { STRUCT_COUNT=$((STRUCT_COUNT+1)); pass "$@"; }
behav() { BEHAV_COUNT=$((BEHAV_COUNT+1)); pass "$@"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_DRIFT_MANUALREVIEW\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_DRIFT_X1\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_DRIFT_RENAMED\";" >/dev/null 2>&1 || true
  rm -f "${FAIL_LOG:-}" 2>/dev/null || true
}
trap cleanup EXIT

# assert_struct_eq : la valeur observée vient EXCLUSIVEMENT du catalogue
#   système (pg_proc/information_schema/has_*_privilege) -- aucune
#   exécution du chemin métier de la RPC sous test.
# assert_behav_eq : la valeur observée provient de l'EXÉCUTION réelle
#   d'une requête/RPC -- comportement observé, pas seulement déclaré.
assert_struct_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then struct "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_behav_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then behav "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}

sql() { psql -X -A -q -t -d "$DB" -c "$1"; }

as_user_rc() {
  local uid="$1" query="$2"
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$uid'; $query" >/tmp/scanym-ot-out-$$.txt 2>/tmp/scanym-ot-err-$$.txt
  echo $?
}
as_anon() {
  local query="$1"
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$query" 2>&1
}
as_anon_rc() {
  local query="$1"
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$query" >/tmp/scanym-ot-out-$$.txt 2>/tmp/scanym-ot-err-$$.txt
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
SQL
}

build_minimal_chain() {
  local dbname="$1"
  for f in schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql; do
    psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  done
}

# ============================================================
# 0. BASELINE — chaîne minimale (jusqu'à V29 inclus, prérequis requis de
#    la base source courante -- aucune affirmation d'état Production
#    réel n'est faite ici) + lot sous test.
# ============================================================
log "=== [0] Construction baseline $DB (chaîne minimale schema..V29) ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
build_common_bootstrap "$DB"
build_minimal_chain "$DB"
struct "chaîne minimale appliquée (schema.sql .. migration-v29-merchant-dashboard.sql, sans aucune dépendance paiement/livraison)"

# Cliché AVANT application du lot -- nécessaire pour prouver, APRÈS
# application, que `authenticated` ne gagne aucun privilège de table
# SELECT supplémentaire sur `orders` (comparaison avant/après, pas une
# simple assertion "false" sur un rôle non concerné -- voir assertion 1m).
AUTH_ORDERS_SELECT_BEFORE="$(sql "select has_table_privilege('authenticated','orders','SELECT');")"

psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/dev/null
struct "DRAFT-lot-customer-order-tracking-foundation.sql appliqué sans erreur (LOT SOUS TEST)"

# ============================================================
# FIXTURES — 2 tenants, plusieurs commandes à des étapes de cycle
# différentes (pour prouver que chaque état/horodatage réel est bien
# restitué, pas une valeur figée).
# ============================================================
log "=== Fixtures (Tenant Un + Tenant Deux) ==="
OWNER_UID="30000000-0000-0000-0000-000000000001"
OTHER_OWNER_UID="40000000-0000-0000-0000-000000000001"

psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into auth.users (id, email) values
  ('$OWNER_UID', 'owner@ot-fixture-one.test'),
  ('$OTHER_OWNER_UID', 'owner@ot-fixture-two.test');

with resto as (
  insert into restaurants (name, slug) values ('OT Fixture Tenant One', 'ot-fixture-tenant-one') returning id
)
insert into restaurant_configs (restaurant_id, whatsapp_number)
select id, '+33600002001' from resto;

with resto2 as (
  insert into restaurants (name, slug) values ('OT Fixture Tenant Two', 'ot-fixture-tenant-two') returning id
)
insert into restaurant_configs (restaurant_id, whatsapp_number)
select id, '+33600002002' from resto2;
SQL

RID_ONE="$(sql "select id from restaurants where slug='ot-fixture-tenant-one';")"
RID_TWO="$(sql "select id from restaurants where slug='ot-fixture-tenant-two';")"

psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into restaurant_users (restaurant_id, user_id, role) values
  ('$RID_ONE', '$OWNER_UID', 'owner'),
  ('$RID_TWO', '$OTHER_OWNER_UID', 'owner');
SQL

# Commande Un (Tenant Un) : jamais touchée -> reste 'new', tous les
# horodatages de transition NULL. Sert de témoin "état initial".
ORDER_NEW="$(sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_ONE', 1, 'pickup', 10.00, 10.00, 'EUR') returning id;")"
# Commande Deux (Tenant Un) : avancée jusqu'à 'ready' via update_order_status
# (chemin marchand réel, pas une écriture directe) -- prouve que
# get_order_tracking restitue un état RÉELLEMENT atteint par transition.
ORDER_READY="$(sql "insert into orders (restaurant_id, order_number, service_mode, table_number, subtotal, total, currency) values ('$RID_ONE', 2, 'table', 7, 25.50, 25.50, 'EUR') returning id;")"
# Commande Trois (Tenant Deux) : rejetée -- exception du cycle.
ORDER_REJECTED="$(sql "insert into orders (restaurant_id, order_number, service_mode, delivery_address, customer_phone, subtotal, total, currency) values ('$RID_TWO', 1, 'delivery', '1 Rue de Test 75001', '+33600000000', 5.00, 5.00, 'EUR') returning id;")"

TOKEN_NEW="$(sql "select public_token from orders where id='$ORDER_NEW';")"
TOKEN_READY="$(sql "select public_token from orders where id='$ORDER_READY';")"
TOKEN_REJECTED="$(sql "select public_token from orders where id='$ORDER_REJECTED';")"
struct "fixtures : 2 tenants, 3 commandes (jetons publics distincts confirmés)"
assert_struct_eq "fixture: les 3 public_token sont distincts" "3" "$(printf '%s\n%s\n%s\n' "$TOKEN_NEW" "$TOKEN_READY" "$TOKEN_REJECTED" | sort -u | wc -l | tr -d ' ')"

# Fait avancer ORDER_READY jusqu'à 'ready' via le VRAI chemin marchand
# (update_order_status, V29, authenticated + appartenance restaurant_users)
# -- jamais une écriture directe sur orders.status.
as_user_rc "$OWNER_UID" "select public.update_order_status('$ORDER_READY','accepted');" >/dev/null
as_user_rc "$OWNER_UID" "select public.update_order_status('$ORDER_READY','preparing');" >/dev/null
as_user_rc "$OWNER_UID" "select public.update_order_status('$ORDER_READY','ready');" >/dev/null
STATUS_READY_CHECK="$(sql "select status from orders where id='$ORDER_READY';")"
assert_struct_eq "fixture: commande Deux effectivement 'ready' après le chemin marchand réel (update_order_status x3)" "ready" "$STATUS_READY_CHECK"

# Fait rejeter ORDER_REJECTED via le même chemin marchand réel.
OTHER_UID_FOR_REJECT="$OTHER_OWNER_UID"
as_user_rc "$OTHER_UID_FOR_REJECT" "select public.update_order_status('$ORDER_REJECTED','rejected');" >/dev/null
STATUS_REJECTED_CHECK="$(sql "select status from orders where id='$ORDER_REJECTED';")"
assert_struct_eq "fixture: commande Trois effectivement 'rejected' après le chemin marchand réel" "rejected" "$STATUS_REJECTED_CHECK"

# ============================================================
# CATALOGUE DE FONCTION (structure/ACL -- struct() exclusivement).
# ============================================================
log "=== CATALOGUE DE FONCTION ==="
assert_struct_eq "1a. la fonction existe avec la signature exacte (2 arguments uuid,uuid)" "1" "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_order_tracking' and p.pronargs=2 and array(select unnest(p.proargtypes))=array['uuid','uuid']::regtype[]::oid[];")"
assert_struct_eq "1b. SECURITY DEFINER (prosecdef=true)" "t" "$(sql "select prosecdef from pg_proc where proname='get_order_tracking' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1c. langage = sql" "sql" "$(sql "select l.lanname from pg_proc p join pg_language l on l.oid=p.prolang where p.proname='get_order_tracking' and p.pronamespace='public'::regnamespace;")"
assert_struct_eq "1d. volatilité = stable" "s" "$(sql "select provolatile from pg_proc where proname='get_order_tracking' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1e. search_path explicitement vide" "1" "$(sql "select count(*) from pg_proc where proname='get_order_tracking' and pronamespace='public'::regnamespace and 'search_path=\"\"' = any(proconfig);")"
assert_struct_eq "1f. propriétaire = rôle ayant exécuté la migration (aucun OWNER TO explicite requis)" "$(sql "select current_user;")" "$(sql "select r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner where p.proname='get_order_tracking' and p.pronamespace='public'::regnamespace;")"
assert_struct_eq "1g. CONTRAT -- retourne EXACTEMENT 10 colonnes, dans cet ordre : order_status,service_mode,order_number,created_at,accepted_at,preparing_at,ready_at,completed_at,rejected_at,cancelled_at" "order_status,service_mode,order_number,created_at,accepted_at,preparing_at,ready_at,completed_at,rejected_at,cancelled_at" "$(sql "select array_to_string(proargnames[array_position(proargmodes,'t'::\"char\"):array_length(proargmodes,1)], ',') from pg_proc where proname='get_order_tracking' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1h. le contrat ne contient JAMAIS payment_status (indépendance paiement, vérifiée sur le catalogue)" "0" "$(sql "select (array_to_string(proargnames, ',') like '%payment%')::int from pg_proc where proname='get_order_tracking' and pronamespace='public'::regnamespace;")"
assert_struct_eq "1i. EXECUTE effectif anon = OUI" "t" "$(sql "select has_function_privilege('anon', 'public.get_order_tracking(uuid,uuid)', 'execute');")"
assert_struct_eq "1j. EXECUTE effectif authenticated = OUI" "t" "$(sql "select has_function_privilege('authenticated', 'public.get_order_tracking(uuid,uuid)', 'execute');")"
assert_struct_eq "1k. EXECUTE effectif service_role = NON (aucune orchestration serveur ne consomme cette RPC -- lecture client directe uniquement)" "f" "$(sql "select has_function_privilege('service_role', 'public.get_order_tracking(uuid,uuid)', 'execute');")"
assert_struct_eq "1l. AUCUN grant EXECUTE résiduel à PUBLIC" "0" "$(sql "select count(*) from information_schema.role_routine_grants where routine_schema='public' and routine_name='get_order_tracking' and grantee='PUBLIC';")"
assert_struct_eq "1m. anon n'a toujours PAS de privilège de table SELECT direct sur orders (aucun grant de table nouveau posé par ce lot pour anon)" "f" "$(sql "select has_table_privilege('anon','orders','SELECT');")"
assert_struct_eq "1m-bis. authenticated ne gagne AUCUN privilège de table SELECT supplémentaire sur orders par ce lot (comparaison stricte avant/après application de la migration, pas une simple vérification isolée)" "$AUTH_ORDERS_SELECT_BEFORE" "$(sql "select has_table_privilege('authenticated','orders','SELECT');")"
assert_struct_eq "1n. CONTRAT -- types structurels exacts des 10 colonnes de retour (catalogue pg_proc/proallargtypes, indépendant de 1g qui ne vérifie que noms/ordre et de 2d qui ne vérifie qu'un seul type RUNTIME)" "text,text,bigint,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone" "$(sql "with f as (select proallargtypes, proargmodes from pg_proc where proname='get_order_tracking' and pronamespace='public'::regnamespace) select string_agg(format_type(a.t, null), ',' order by a.ord) from f, unnest(f.proallargtypes) with ordinality as a(t, ord) join unnest(f.proargmodes) with ordinality as m(md, ord2) on a.ord = m.ord2 where m.md = 't';")"

# ============================================================
# COMPORTEMENT (possession, cycle réel, fail-closed uniforme, isolation
# -- behav() exclusivement).
# ============================================================
log "=== COMPORTEMENT ==="
OUT_NEW="$(as_anon "select order_status, service_mode, order_number, accepted_at is null, preparing_at is null, ready_at is null, completed_at is null, rejected_at is null, cancelled_at is null from public.get_order_tracking('$ORDER_NEW','$TOKEN_NEW');")"
assert_behav_eq "2a. commande jamais touchée -> order_status='new', TOUS les horodatages de transition NULL" "new|pickup|1|t|t|t|t|t|t" "$OUT_NEW"

OUT_READY="$(as_anon "select order_status, service_mode, order_number, accepted_at is not null, preparing_at is not null, ready_at is not null, completed_at is null, rejected_at is null, cancelled_at is null from public.get_order_tracking('$ORDER_READY','$TOKEN_READY');")"
assert_behav_eq "2b. commande avancée par le VRAI chemin marchand -> order_status='ready', accepted_at/preparing_at/ready_at renseignés, completed/rejected/cancelled NULL" "ready|table|2|t|t|t|t|t|t" "$OUT_READY"

OUT_REJECTED="$(as_anon "select order_status, rejected_at is not null, accepted_at is null from public.get_order_tracking('$ORDER_REJECTED','$TOKEN_REJECTED');")"
assert_behav_eq "2c. commande rejetée -> order_status='rejected', rejected_at renseigné, accepted_at NULL (jamais acceptée)" "rejected|t|t" "$OUT_REJECTED"

OUT_ORDER_NUMBER_TYPE="$(as_anon "select pg_typeof(order_number)::text from public.get_order_tracking('$ORDER_NEW','$TOKEN_NEW');")"
assert_behav_eq "2d. type RUNTIME de order_number = bigint (identique à orders.order_number, aucune coercition)" "bigint" "$OUT_ORDER_NUMBER_TYPE"

ROWCOUNT_WRONG_TOKEN="$(as_anon "select count(*) from public.get_order_tracking('$ORDER_NEW','$TOKEN_READY');")"
assert_behav_eq "3a. mauvais jeton (jeton d'une autre commande) -> AUCUNE ligne" "0" "$ROWCOUNT_WRONG_TOKEN"
RANDOM_ORDER_ID="00000000-0000-0000-0000-000000000000"
ROWCOUNT_WRONG_ORDER="$(as_anon "select count(*) from public.get_order_tracking('$RANDOM_ORDER_ID','$TOKEN_NEW');")"
assert_behav_eq "3b. mauvais order_id (inexistant) avec jeton valide d'une autre commande -> AUCUNE ligne" "0" "$ROWCOUNT_WRONG_ORDER"
ROWCOUNT_BOTH_NULL="$(as_anon "select count(*) from public.get_order_tracking(null,null);")"
assert_behav_eq "3c. order_id et public_token NULL -> AUCUNE ligne (jamais une exception distincte)" "0" "$ROWCOUNT_BOTH_NULL"
ROWCOUNT_RANDOM_TOKEN="$(as_anon "select count(*) from public.get_order_tracking('$ORDER_NEW','00000000-0000-0000-0000-000000000000');")"
assert_behav_eq "3d. order_id valide, jeton aléatoire non attribué -> AUCUNE ligne" "0" "$ROWCOUNT_RANDOM_TOKEN"
ROWCOUNT_NULL_ORDER_VALID_TOKEN="$(as_anon "select count(*) from public.get_order_tracking(null,'$TOKEN_NEW');")"
assert_behav_eq "3d-bis. order_id NULL, public_token VALIDE d'une commande existante -> AUCUNE ligne (moitié NULL isolée, distincte du cas NULL+NULL déjà couvert par 3c)" "0" "$ROWCOUNT_NULL_ORDER_VALID_TOKEN"
ROWCOUNT_VALID_ORDER_NULL_TOKEN="$(as_anon "select count(*) from public.get_order_tracking('$ORDER_NEW',null);")"
assert_behav_eq "3d-ter. order_id VALIDE (commande existante), public_token NULL -> AUCUNE ligne (moitié NULL isolée, distincte du cas NULL+NULL déjà couvert par 3c)" "0" "$ROWCOUNT_VALID_ORDER_NULL_TOKEN"

RC_WRONG_TOKEN="$(as_anon_rc "select * from public.get_order_tracking('$ORDER_NEW','$TOKEN_READY');")"
RC_WRONG_ORDER="$(as_anon_rc "select * from public.get_order_tracking('$RANDOM_ORDER_ID','$TOKEN_NEW');")"
assert_behav_eq "3e. code de sortie identique (0, pas d'erreur) pour mauvais jeton et mauvaise commande -- aucune distinction observable" "$RC_WRONG_TOKEN" "$RC_WRONG_ORDER"
assert_behav_eq "3f. ce code de sortie commun est bien 0 (SELECT vide, jamais une exception distinctive)" "0" "$RC_WRONG_TOKEN"

LEAK_TEST_OUT="$(as_anon "select * from public.get_order_tracking('$ORDER_NEW','$TOKEN_READY');" 2>&1 || true)"
assert_behav_eq "3g. aucune fuite : la lecture avec mauvais jeton ne renvoie AUCUN texte (ensemble vide, aucun message distinctif)" "" "$LEAK_TEST_OUT"

OUT_AUTH="$(as_user_rc "$OWNER_UID" "select order_status from public.get_order_tracking('$ORDER_NEW','$TOKEN_NEW');")"
assert_behav_eq "4. authenticated (personnel) PEUT aussi exécuter (même posture que create_order/get_order_payment_status, non restreint aux seuls anonymes)" "0" "$OUT_AUTH"

# Isolation cross-tenant : le jeton de Tenant Deux (ORDER_REJECTED) ne
# permet jamais de lire ORDER_NEW (Tenant Un), même order_id erroné mis
# à part -- combinaison croisée explicite.
ROWCOUNT_CROSS_TENANT="$(as_anon "select count(*) from public.get_order_tracking('$ORDER_NEW','$TOKEN_REJECTED');")"
assert_behav_eq "5. isolation cross-tenant : jeton de Tenant Deux sur commande de Tenant Un -> AUCUNE ligne" "0" "$ROWCOUNT_CROSS_TENANT"

RC_ANON_ORDERS_DIRECT="$(as_anon_rc "select count(*) from orders where id='$ORDER_NEW';")"
assert_behav_eq "6. anon ne peut toujours PAS lire orders directement (aucun privilège de table -- RLS V29 + ACL inchangés -- get_order_tracking/get_order_payment_status restent les SEULES portes de lecture anonyme)" "1" "$([ "$RC_ANON_ORDERS_DIRECT" != "0" ] && echo 1 || echo 0)"

# Aucune mutation : plusieurs lectures (succès et échecs) ne changent
# jamais orders.status ni ses horodatages -- lecture pure, donc
# trivialement idempotente.
STATUS_BEFORE="$(sql "select status from orders where id='$ORDER_READY';")"
UPDATED_AT_BEFORE="$(sql "select updated_at from orders where id='$ORDER_READY';")"
as_anon "select * from public.get_order_tracking('$ORDER_READY','$TOKEN_READY');" >/dev/null
as_anon "select * from public.get_order_tracking('$ORDER_READY','$TOKEN_NEW');" >/dev/null 2>&1 || true
as_anon "select * from public.get_order_tracking('$ORDER_READY','$TOKEN_READY');" >/dev/null
STATUS_AFTER="$(sql "select status from orders where id='$ORDER_READY';")"
UPDATED_AT_AFTER="$(sql "select updated_at from orders where id='$ORDER_READY';")"
assert_behav_eq "7a. aucune mutation de orders.status après plusieurs lectures (succès et échecs)" "$STATUS_BEFORE" "$STATUS_AFTER"
assert_behav_eq "7b. aucune mutation de orders.updated_at après plusieurs lectures (lecture pure, aucun verrou, idempotence triviale)" "$UPDATED_AT_BEFORE" "$UPDATED_AT_AFTER"
READ_ONE="$(as_anon "select order_status,ready_at from public.get_order_tracking('$ORDER_READY','$TOKEN_READY');")"
READ_TWO="$(as_anon "select order_status,ready_at from public.get_order_tracking('$ORDER_READY','$TOKEN_READY');")"
assert_behav_eq "7c. deux lectures consécutives renvoient EXACTEMENT le même résultat (idempotence comportementale)" "$READ_ONE" "$READ_TWO"

# ============================================================
# NON-RÉGRESSION — le chemin marchand existant (V29) reste inchangé et
# opérant après application de ce lot.
# ============================================================
log "=== NON-RÉGRESSION (chemin marchand V29) ==="
RC_MERCHANT_STILL_WORKS="$(as_user_rc "$OWNER_UID" "select public.update_order_status('$ORDER_READY','completed');")"
assert_behav_eq "8a. update_order_status (V29) toujours opérant après ce lot (ready -> completed accepté)" "0" "$RC_MERCHANT_STILL_WORKS"
FINAL_STATUS="$(sql "select status from orders where id='$ORDER_READY';")"
assert_behav_eq "8b. commande Deux effectivement 'completed'" "completed" "$FINAL_STATUS"
TRACKING_AFTER_COMPLETE="$(as_anon "select order_status, completed_at is not null from public.get_order_tracking('$ORDER_READY','$TOKEN_READY');")"
assert_behav_eq "8c. get_order_tracking reflète immédiatement la transition marchande la plus récente (order_status='completed', completed_at renseigné)" "completed|t" "$TRACKING_AFTER_COMPLETE"
RC_OTHER_TENANT_FORBIDDEN="$(as_user_rc "$OWNER_UID" "select public.update_order_status('$ORDER_REJECTED','accepted');")"
assert_behav_eq "8d. isolation tenant marchande inchangée : propriétaire de Tenant Un ne peut pas transitionner une commande de Tenant Deux" "1" "$([ "$RC_OTHER_TENANT_FORBIDDEN" != "0" ] && echo 1 || echo 0)"

# ============================================================
# GARDES ANTI-DÉRIVE (exécution réelle de la migration -- behav()).
# ============================================================
log "=== GARDES ANTI-DÉRIVE ==="
RC_DOUBLE_APPLY="$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/tmp/scanym-ot-double-$$.out 2>&1; echo $?)"
assert_behav_eq "D1. double application du lot REFUSÉE (SCANYM_SCHEMA_DRIFT)" "1" "$([ "$RC_DOUBLE_APPLY" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "D2. message de double application mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" /tmp/scanym-ot-double-$$.out || true)"
rm -f /tmp/scanym-ot-double-$$.out

log "=== GARDE — base PRÉ-V29 (modèle de statut différent : pas de completed/rejected) ==="
psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
createdb "$DB_DRIFT"
build_common_bootstrap "$DB_DRIFT"
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/schema.sql" >/dev/null 2>&1
psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-orders.sql" >/dev/null 2>&1
RC_MISSING_PREREQ="$(psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/tmp/scanym-ot-drift-$$.out 2>&1; echo $?)"
assert_behav_eq "D3. application sur base PRÉ-V29 (colonnes completed_at/rejected_at absentes) REFUSÉE dès la garde préflight" "1" "$([ "$RC_MISSING_PREREQ" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "D4. message mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" /tmp/scanym-ot-drift-$$.out || true)"
rm -f /tmp/scanym-ot-drift-$$.out

# ------------------------------------------------------------
# TRACK-V1-DRIFT-GUARD (v3, durcissement résiduel LOW de l'audit Work) :
# preuve directe, sur PostgreSQL réel, que la garde structurelle prouve
# désormais l'ENSEMBLE EXACT des valeurs autorisées -- pas seulement la
# présence des 7 valeurs canoniques -- via les 5 cas explicitement
# mandatés : ensemble canonique seul -> PASS (déjà couvert ci-dessus par
# l'application réussie sur $DB) ; ensemble canonique + valeur
# supplémentaire hors [a-z_] -> FAIL (deux variantes : trait d'union,
# majuscule+chiffre) ; contrainte renommée mais sémantiquement identique
# -> PASS ; base pré-V29 -> FAIL (D3/D4 ci-dessus).
# ------------------------------------------------------------
log "=== GARDE — contrainte élargie avec valeur supplémentaire 'manual-review' (hors [a-z_], D5/D6) ==="
psql -c "drop database if exists \"$DB_DRIFT_MANUALREVIEW\";" >/dev/null 2>&1 || true
createdb "$DB_DRIFT_MANUALREVIEW"
build_common_bootstrap "$DB_DRIFT_MANUALREVIEW"
build_minimal_chain "$DB_DRIFT_MANUALREVIEW"
psql -d "$DB_DRIFT_MANUALREVIEW" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
alter table public.orders drop constraint orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('new','accepted','preparing','ready','completed','rejected','cancelled','manual-review'));
SQL
RC_MANUALREVIEW="$(psql -d "$DB_DRIFT_MANUALREVIEW" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/tmp/scanym-ot-mr-$$.out 2>&1; echo $?)"
assert_behav_eq "D5. contrainte élargie avec la valeur supplémentaire 'manual-review' (trait d'union, hors [a-z_]) -> application REFUSÉE (ferme le gap TRACK-V1-DRIFT-GUARD : v2 ignorait silencieusement cette valeur)" "1" "$([ "$RC_MANUALREVIEW" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "D6. message D5 mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" /tmp/scanym-ot-mr-$$.out || true)"
rm -f /tmp/scanym-ot-mr-$$.out

log "=== GARDE — contrainte élargie avec valeur supplémentaire 'X1' (majuscule+chiffre, hors [a-z_], D7/D8) ==="
psql -c "drop database if exists \"$DB_DRIFT_X1\";" >/dev/null 2>&1 || true
createdb "$DB_DRIFT_X1"
build_common_bootstrap "$DB_DRIFT_X1"
build_minimal_chain "$DB_DRIFT_X1"
psql -d "$DB_DRIFT_X1" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
alter table public.orders drop constraint orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('new','accepted','preparing','ready','completed','rejected','cancelled','X1'));
SQL
RC_X1="$(psql -d "$DB_DRIFT_X1" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/tmp/scanym-ot-x1-$$.out 2>&1; echo $?)"
assert_behav_eq "D7. contrainte élargie avec la valeur supplémentaire 'X1' (majuscule+chiffre, hors [a-z_]) -> application REFUSÉE" "1" "$([ "$RC_X1" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "D8. message D7 mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" /tmp/scanym-ot-x1-$$.out || true)"
rm -f /tmp/scanym-ot-x1-$$.out

log "=== GARDE — contrainte RENOMMÉE mais sémantiquement identique (D9/D10) ==="
psql -c "drop database if exists \"$DB_DRIFT_RENAMED\";" >/dev/null 2>&1 || true
createdb "$DB_DRIFT_RENAMED"
build_common_bootstrap "$DB_DRIFT_RENAMED"
build_minimal_chain "$DB_DRIFT_RENAMED"
psql -d "$DB_DRIFT_RENAMED" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
alter table public.orders drop constraint orders_status_check;
alter table public.orders add constraint orders_status_allowed_values_check
  check (status in ('new','accepted','preparing','ready','completed','rejected','cancelled'));
SQL
RC_RENAMED="$(psql -d "$DB_DRIFT_RENAMED" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/tmp/scanym-ot-renamed-$$.out 2>&1; echo $?)"
assert_behav_eq "D9. contrainte RENOMMÉE (orders_status_allowed_values_check) mais sémantiquement identique aux 7 valeurs canoniques -> application ACCEPTÉE (la garde ne dépend jamais du nom de la contrainte)" "0" "$RC_RENAMED"
assert_struct_eq "D10. get_order_tracking effectivement créée dans la base à contrainte renommée (preuve positive, pas seulement l'absence d'échec)" "1" "$(psql -X -A -q -t -d "$DB_DRIFT_RENAMED" -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_order_tracking';")"
rm -f /tmp/scanym-ot-renamed-$$.out

# ============================================================
# BILAN — invariante : PASS_COUNT doit être EXACTEMENT égal à
# STRUCT_COUNT + BEHAV_COUNT (chaque assertion réussie route
# explicitement vers l'une des deux catégories).
# ============================================================
log "=== BILAN : $PASS_COUNT PASS / $FAIL_COUNT FAIL (dont $STRUCT_COUNT structurelles, $BEHAV_COUNT comportementales) ==="
if [ "$((STRUCT_COUNT + BEHAV_COUNT))" -ne "$PASS_COUNT" ]; then
  log "FAIL: invariante cassée -- STRUCT_COUNT($STRUCT_COUNT) + BEHAV_COUNT($BEHAV_COUNT) != PASS_COUNT($PASS_COUNT)"
  FAIL_COUNT=$((FAIL_COUNT+1))
fi
if [ "$FAIL_COUNT" -gt 0 ]; then
  log "--- Détail des échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
