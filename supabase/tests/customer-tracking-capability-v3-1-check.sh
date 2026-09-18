#!/usr/bin/env bash
# ============================================================
# Scanym — CUSTOMER TRACKING v3.1 — Harnais PostgreSQL reproductible
# pour supabase/DRAFT-lot-customer-tracking-capability-v3-1.sql
# (+ -rollback.sql).
#
# PostgreSQL communautaire vanilla (>= 13, gen_random_uuid()/sha256()
# natifs), même patron que supabase/tests/customer-order-tracking-
# foundation-check.sh : rôles anon/authenticated/service_role recréés
# minimalement, auth.uid() simulé via `test.uid`.
#
# Chaîne : schema.sql -> migration-orders.sql -> migration-orders-lang.sql
# -> migration-v29-merchant-dashboard.sql -> DRAFT-lot-customer-order-
# tracking-foundation.sql -> [STUB order_invoice_request] -> DRAFT-lot-
# tracking-final-fiscal-summary-v1-1.sql -> LOT SOUS TEST.
#
# STUB DÉCLARÉ : `public.order_invoice_request(order_id)` est créée ici
# sous sa forme MINIMALE (seule la colonne order_id est lue, par
# existence, par get_order_tracking et par la lecture v3.1) au lieu
# d'appliquer toute la chaîne invoice-request, sans rapport avec ce lot.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   sudo -u postgres bash supabase/tests/customer-tracking-capability-v3-1-check.sh
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_SQL="$SUPABASE_DIR/DRAFT-lot-customer-tracking-capability-v3-1.sql"
ROLLBACK_SQL="$SUPABASE_DIR/DRAFT-lot-customer-tracking-capability-v3-1-rollback.sql"
DB="scanym_tracking_v31_$$"
DB_NOFISCAL="scanym_tracking_v31_nofiscal_$$"
TMP="$(mktemp -d "/tmp/scanym-tracking-v31-XXXXXX")"

PASS_COUNT=0
FAIL_COUNT=0
STRUCT_COUNT=0
BEHAV_COUNT=0
FAIL_LOG="$TMP/fails.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }
struct() { STRUCT_COUNT=$((STRUCT_COUNT+1)); pass "$@"; }
behav() { BEHAV_COUNT=$((BEHAV_COUNT+1)); pass "$@"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_NOFISCAL\";" >/dev/null 2>&1 || true
  rm -rf "$TMP" 2>/dev/null || true
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
as_anon() { PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" 2>&1; }
as_anon_rc() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" >"$TMP/out.txt" 2>"$TMP/err.txt"
  echo $?
}
as_user() {
  local uid="$1" query="$2"
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$uid'; $query" 2>&1
}

# upgrade_q ORDER TOKEN -> requête renvoyant "capability_id|secret" (ou rien)
upgrade_q() { echo "select capability_id::text || '|' || capability_secret from public.upgrade_legacy_tracking_capability($1, $2);"; }
read_q() { echo "select count(*) from public.get_order_tracking_by_capability($1, $2, $3);"; }

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

build_chain_until_tracking_foundation() {
  local dbname="$1"
  for f in schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql DRAFT-lot-customer-order-tracking-foundation.sql; do
    psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  done
  psql -d "$dbname" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create table public.order_invoice_request (
  order_id uuid primary key references public.orders(id) on delete cascade
);
alter table public.order_invoice_request enable row level security;
revoke all on table public.order_invoice_request from public, anon, authenticated;
SQL
}

apply_fiscal_v1_1() {
  psql -d "$1" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-tracking-final-fiscal-summary-v1-1.sql" >/dev/null 2>&1
}

# Empreinte (définition + ACL) de toutes les surcharges d'une fonction.
fn_fingerprint() {
  psql -X -A -q -t -d "$1" -c "select coalesce(md5(string_agg(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '<null>'), '#' order by n.nspname||'.'||p.proname||'('||replace(oidvectortypes(p.proargtypes), ' ', '')||')')), 'absent') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = '$2';"
}

# ============================================================
# 0. BASELINE + application du lot.
# ============================================================
log "=== [0] Construction $DB ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
build_common_bootstrap "$DB"
build_chain_until_tracking_foundation "$DB"
apply_fiscal_v1_1 "$DB"
struct "chaîne prérequise appliquée (schema .. V29 + tracking foundation + stub order_invoice_request + fiscal v1.1)"

FP_CREATE_ORDER_BEFORE="$(fn_fingerprint "$DB" create_order)"
FP_GET_TRACKING_BEFORE="$(fn_fingerprint "$DB" get_order_tracking)"
FP_MARK_WA_BEFORE="$(fn_fingerprint "$DB" mark_whatsapp_opened)"
FP_UPDATE_STATUS_BEFORE="$(fn_fingerprint "$DB" update_order_status)"
ORDERS_ACL_BEFORE="$(sql "select coalesce(relacl::text,'<null>') from pg_class where oid='public.orders'::regclass;")"
assert_struct_eq "pré-condition : create_order existe (empreinte non vide)" "1" "$([ "$FP_CREATE_ORDER_BEFORE" != "absent" ] && echo 1 || echo 0)"

psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/dev/null
struct "DRAFT-lot-customer-tracking-capability-v3-1.sql appliqué sans erreur (LOT SOUS TEST)"

# ============================================================
# FIXTURES — 2 tenants, 6 commandes.
# ============================================================
OWNER_UID="30000000-0000-0000-0000-000000000001"
OTHER_OWNER_UID="40000000-0000-0000-0000-000000000001"
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<SQL
insert into auth.users (id, email) values ('$OWNER_UID', 'owner@v31-one.test'), ('$OTHER_OWNER_UID', 'owner@v31-two.test');
with r as (insert into restaurants (name, slug) values ('V31 Tenant One', 'v31-tenant-one') returning id)
insert into restaurant_configs (restaurant_id, whatsapp_number) select id, '+33600003001' from r;
with r as (insert into restaurants (name, slug) values ('V31 Tenant Two', 'v31-tenant-two') returning id)
insert into restaurant_configs (restaurant_id, whatsapp_number) select id, '+33600003002' from r;
SQL
RID_ONE="$(sql "select id from restaurants where slug='v31-tenant-one';")"
RID_TWO="$(sql "select id from restaurants where slug='v31-tenant-two';")"
sql "insert into restaurant_users (restaurant_id, user_id, role) values ('$RID_ONE', '$OWNER_UID', 'owner'), ('$RID_TWO', '$OTHER_OWNER_UID', 'owner');" >/dev/null

new_order() { sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$1', $2, 'pickup', 12.50, 12.50, 'EUR') returning id;"; }
ORDER_A="$(new_order "$RID_ONE" 1)"
ORDER_B="$(new_order "$RID_TWO" 1)"
ORDER_C="$(new_order "$RID_ONE" 2)"
ORDER_D="$(new_order "$RID_ONE" 3)"
ORDER_E="$(new_order "$RID_ONE" 4)"
ORDER_F="$(new_order "$RID_TWO" 2)"
tok() { sql "select public_token from orders where id='$1';"; }
TOKEN_A="$(tok "$ORDER_A")"; TOKEN_B="$(tok "$ORDER_B")"; TOKEN_C="$(tok "$ORDER_C")"
TOKEN_D="$(tok "$ORDER_D")"; TOKEN_E="$(tok "$ORDER_E")"; TOKEN_F="$(tok "$ORDER_F")"
sql "insert into order_invoice_request (order_id) values ('$ORDER_A');" >/dev/null
PGOPTIONS="-c role=authenticated" psql -X -q -d "$DB" -c "set test.uid = '$OWNER_UID'; select public.update_order_status('$ORDER_A','accepted'); select public.update_order_status('$ORDER_A','preparing');" >/dev/null
assert_struct_eq "fixture : commande A 'preparing' via le vrai chemin marchand" "preparing" "$(sql "select status from orders where id='$ORDER_A';")"

# ============================================================
# 1. CATALOGUE (struct).
# ============================================================
log "=== [1] CATALOGUE ==="
assert_struct_eq "1a. table order_tracking_capabilities existe" "1" "$(sql "select count(*) from pg_class where oid = to_regclass('public.order_tracking_capabilities');")"
assert_struct_eq "1b. RLS activée sur la table" "t" "$(sql "select relrowsecurity from pg_class where oid='public.order_tracking_capabilities'::regclass;")"
assert_struct_eq "1c. index unique partiel (order_id) WHERE kind='legacy_upgrade' -- une capacité legacy par commande" "1" "$(sql "select count(*) from pg_indexes where schemaname='public' and indexname='order_tracking_capabilities_one_legacy_per_order' and indexdef like 'CREATE UNIQUE INDEX %(order_id) WHERE (kind = ''legacy_upgrade''::text)';")"
assert_struct_eq "1d. contrainte claim atomique (secret_hash NULL <=> claimed_at NULL)" "1" "$(sql "select count(*) from pg_constraint where conrelid='public.order_tracking_capabilities'::regclass and conname='order_tracking_capabilities_claim_atomic';")"
assert_struct_eq "1e. aucune colonne ne stocke le secret en clair (colonnes exactes)" "id,order_id,kind,secret_hash,created_at,claimed_at,expires_at" "$(sql "select string_agg(attname, ',' order by attnum) from pg_attribute where attrelid='public.order_tracking_capabilities'::regclass and attnum > 0 and not attisdropped;")"
assert_struct_eq "1e2. issue_order_email_tracking_capability(uuid) : SECURITY DEFINER, volatile, search_path vide" "t|v|1" "$(sql "select prosecdef, provolatile, (select count(*) from unnest(proconfig) c where c='search_path=\"\"') from pg_proc where proname='issue_order_email_tracking_capability';")"
for role in public anon authenticated; do
  assert_struct_eq "1e3. $role n'a PAS EXECUTE sur issue_order_email_tracking_capability" "f" "$(sql "select has_function_privilege('$role','public.issue_order_email_tracking_capability(uuid)','execute');")"
done
assert_struct_eq "1e4. service_role a EXECUTE sur issue_order_email_tracking_capability" "t" "$(sql "select has_function_privilege('service_role','public.issue_order_email_tracking_capability(uuid)','execute');")"
for role in anon authenticated service_role; do
  for priv in SELECT INSERT UPDATE DELETE; do
    assert_struct_eq "1f. $role n'a PAS $priv sur order_tracking_capabilities" "f" "$(sql "select has_table_privilege('$role','public.order_tracking_capabilities','$priv');")"
  done
done
assert_struct_eq "1g. lecture : UNE seule surcharge get_order_tracking_by_capability(uuid, uuid, text)" "public.get_order_tracking_by_capability(uuid,uuid,text)" "$(sql "select string_agg(n.nspname||'.'||p.proname||'('||replace(oidvectortypes(p.proargtypes), ' ', '')||')', ';') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_order_tracking_by_capability';")"
assert_struct_eq "1h. lecture : noms d'arguments d'entrée p_order_id,p_capability_id,p_secret" "p_order_id,p_capability_id,p_secret" "$(sql "select array_to_string(proargnames[1:3], ',') from pg_proc where proname='get_order_tracking_by_capability';")"
assert_struct_eq "1i. lecture : SECURITY DEFINER, stable, search_path vide" "t|s|1" "$(sql "select prosecdef, provolatile, (select count(*) from unnest(proconfig) c where c='search_path=\"\"') from pg_proc where proname='get_order_tracking_by_capability';")"
assert_struct_eq "1j. AUCUNE fonction publique n'accepte p_capability_id sans p_order_id (pas de variante non liée)" "0" "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and 'p_capability_id' = any(p.proargnames) and not ('p_order_id' = any(p.proargnames));")"
assert_struct_eq "1k. upgrade : signature exacte upgrade_legacy_tracking_capability(uuid, uuid)" "public.upgrade_legacy_tracking_capability(uuid,uuid)" "$(sql "select string_agg(n.nspname||'.'||p.proname||'('||replace(oidvectortypes(p.proargtypes), ' ', '')||')', ';') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='upgrade_legacy_tracking_capability';")"
assert_struct_eq "1l. upgrade : SECURITY DEFINER, volatile, search_path vide" "t|v|1" "$(sql "select prosecdef, provolatile, (select count(*) from unnest(proconfig) c where c='search_path=\"\"') from pg_proc where proname='upgrade_legacy_tracking_capability';")"
for fn in "get_order_tracking_by_capability(uuid,uuid,text)" "upgrade_legacy_tracking_capability(uuid,uuid)"; do
  assert_struct_eq "1m. EXECUTE anon sur $fn" "t" "$(sql "select has_function_privilege('anon','public.$fn','execute');")"
  assert_struct_eq "1n. EXECUTE authenticated sur $fn" "t" "$(sql "select has_function_privilege('authenticated','public.$fn','execute');")"
  assert_struct_eq "1o. AUCUN EXECUTE résiduel PUBLIC sur $fn" "f" "$(sql "select has_function_privilege('public','public.$fn','execute');")"
done
LEGACY_COLS="$(sql "select string_agg(format('%s:%s', proargnames[i], format_type(proallargtypes[i], null)), ',' order by i) from pg_proc, generate_subscripts(proargmodes, 1) i where proname='get_order_tracking' and proargmodes[i]='t';")"
V31_COLS="$(sql "select string_agg(format('%s:%s', proargnames[i], format_type(proallargtypes[i], null)), ',' order by i) from pg_proc, generate_subscripts(proargmodes, 1) i where proname='get_order_tracking_by_capability' and proargmodes[i]='t';")"
assert_struct_eq "1p. sortie v3.1 = bound_order_id:uuid + EXACTEMENT les 13 colonnes (noms+types) de get_order_tracking" "bound_order_id:uuid,$LEGACY_COLS" "$V31_COLS"

# ============================================================
# 2. NON-DÉRIVE (struct).
# ============================================================
log "=== [2] NON-DÉRIVE ==="
assert_struct_eq "2a. create_order : définition + ACL inchangées" "$FP_CREATE_ORDER_BEFORE" "$(fn_fingerprint "$DB" create_order)"
assert_struct_eq "2b. get_order_tracking : définition + ACL inchangées" "$FP_GET_TRACKING_BEFORE" "$(fn_fingerprint "$DB" get_order_tracking)"
assert_struct_eq "2c. mark_whatsapp_opened : inchangée" "$FP_MARK_WA_BEFORE" "$(fn_fingerprint "$DB" mark_whatsapp_opened)"
assert_struct_eq "2d. update_order_status : inchangée" "$FP_UPDATE_STATUS_BEFORE" "$(fn_fingerprint "$DB" update_order_status)"
assert_struct_eq "2e. ACL de la table orders inchangée" "$ORDERS_ACL_BEFORE" "$(sql "select coalesce(relacl::text,'<null>') from pg_class where oid='public.orders'::regclass;")"

# ============================================================
# 3. UPGRADE ONE-SHOT (behav).
# ============================================================
log "=== [3] UPGRADE ONE-SHOT ==="
OUT_A="$(as_anon "$(upgrade_q "'$ORDER_A'" "'$TOKEN_A'")")"
CAP_A="${OUT_A%%|*}"; SECRET_A="${OUT_A#*|}"
assert_behav_eq "3a. premier upgrade (paire valide) -> une capacité émise" "1" "$(printf '%s\n' "$OUT_A" | grep -c '|' || true)"
assert_behav_eq "3b. secret = 64 hex minuscules" "1" "$([[ "$SECRET_A" =~ ^[0-9a-f]{64}$ ]] && echo 1 || echo 0)"
assert_behav_eq "3c. capacité réclamée, liée à A, hash = sha256(secret), claimed_at posé" "$ORDER_A|t|t" "$(sql "select order_id, secret_hash = sha256(convert_to('$SECRET_A','UTF8')), claimed_at is not null from order_tracking_capabilities where id='$CAP_A';")"
assert_behav_eq "3d. le secret n'est stocké nulle part en clair" "0" "$(sql "select count(*) from order_tracking_capabilities where encode(secret_hash,'hex') = '$SECRET_A' or id::text = '$SECRET_A';")"
STATE_A_BEFORE="$(sql "select encode(secret_hash,'hex') || claimed_at::text from order_tracking_capabilities where order_id='$ORDER_A';")"
OUT_A_REPLAY="$(as_anon "$(upgrade_q "'$ORDER_A'" "'$TOKEN_A'")")"
assert_behav_eq "3e. REJEU du même upgrade -> ensemble VIDE (aucune réémission)" "" "$OUT_A_REPLAY"
OUT_A_REPLAY2="$(as_anon "$(upgrade_q "'$ORDER_A'" "'$TOKEN_A'")")"
assert_behav_eq "3f. second rejeu -> toujours VIDE" "" "$OUT_A_REPLAY2"
assert_behav_eq "3g. aucune rotation : secret_hash/claimed_at inchangés après rejeux" "$STATE_A_BEFORE" "$(sql "select encode(secret_hash,'hex') || claimed_at::text from order_tracking_capabilities where order_id='$ORDER_A';")"
assert_behav_eq "3h. toujours UNE seule capacité pour A" "1" "$(sql "select count(*) from order_tracking_capabilities where order_id='$ORDER_A';")"

OUT_B="$(as_anon "$(upgrade_q "'$ORDER_B'" "'$TOKEN_B'")")"
CAP_B="${OUT_B%%|*}"; SECRET_B="${OUT_B#*|}"
assert_behav_eq "3i. upgrade B (autre tenant) -> capacité distincte" "1" "$([ -n "$CAP_B" ] && [ "$CAP_B" != "$CAP_A" ] && [ "$SECRET_B" != "$SECRET_A" ] && echo 1 || echo 0)"

assert_behav_eq "3j. mauvaise paire (jeton de B sur A) -> VIDE" "" "$(as_anon "$(upgrade_q "'$ORDER_C'" "'$TOKEN_B'")")"
assert_behav_eq "3k. commande inexistante + jeton valide -> VIDE" "" "$(as_anon "$(upgrade_q "'00000000-0000-0000-0000-000000000000'" "'$TOKEN_C'")")"
assert_behav_eq "3l. NULL/NULL -> VIDE" "" "$(as_anon "$(upgrade_q null null)")"
assert_behav_eq "3m. commande valide + jeton NULL -> VIDE" "" "$(as_anon "$(upgrade_q "'$ORDER_C'" null)")"
assert_behav_eq "3n. échecs de paire : AUCUNE réservation créée pour C" "0" "$(sql "select count(*) from order_tracking_capabilities where order_id='$ORDER_C';")"
RC_BAD="$(as_anon_rc "$(upgrade_q "'$ORDER_C'" "'$TOKEN_B'")")"
RC_REPLAY="$(as_anon_rc "$(upgrade_q "'$ORDER_A'" "'$TOKEN_A'")")"
assert_behav_eq "3o. code de sortie identique (0) mauvaise paire vs rejeu -- indistinguables" "0|0" "$RC_BAD|$RC_REPLAY"
OUT_AUTH="$(as_user "$OWNER_UID" "$(upgrade_q "'$ORDER_F'" "'$TOKEN_F'")")"
assert_behav_eq "3p. authenticated peut aussi effectuer l'upgrade (même posture que anon)" "1" "$(printf '%s\n' "$OUT_AUTH" | grep -c '|' || true)"

# ============================================================
# 4. RÉSERVATION SANS SECRET réutilisée.
# ============================================================
log "=== [4] RÉSERVATION ==="
RESERVED_C="$(sql "insert into order_tracking_capabilities (order_id) values ('$ORDER_C') returning id;")"
assert_behav_eq "4a. réservation non réclamée -> jamais lisible (secret quelconque)" "0" "$(as_anon "$(read_q "'$ORDER_C'" "'$RESERVED_C'" "'$SECRET_A'")")"
assert_behav_eq "4b. réservation non réclamée -> jamais lisible (secret NULL)" "0" "$(as_anon "$(read_q "'$ORDER_C'" "'$RESERVED_C'" null)")"
OUT_C="$(as_anon "$(upgrade_q "'$ORDER_C'" "'$TOKEN_C'")")"
CAP_C="${OUT_C%%|*}"; SECRET_C="${OUT_C#*|}"
assert_behav_eq "4c. upgrade RÉUTILISE la réservation existante (même capability_id)" "$RESERVED_C" "$CAP_C"
assert_behav_eq "4d. toujours UNE seule ligne pour C après claim" "1" "$(sql "select count(*) from order_tracking_capabilities where order_id='$ORDER_C';")"
assert_behav_eq "4e. capacité C lisible après claim" "1" "$(as_anon "$(read_q "'$ORDER_C'" "'$CAP_C'" "'$SECRET_C'")")"
RC_DUP="$(psql -X -q -d "$DB" -c "insert into order_tracking_capabilities (order_id) values ('$ORDER_C');" >/dev/null 2>&1; echo $?)"
assert_behav_eq "4f. une seconde capacité pour la même commande est structurellement impossible (unique)" "1" "$([ "$RC_DUP" != "0" ] && echo 1 || echo 0)"
RC_HALF="$(psql -X -q -d "$DB" -c "update order_tracking_capabilities set claimed_at = null where id='$CAP_C';" >/dev/null 2>&1; echo $?)"
assert_behav_eq "4g. claim partiel impossible (claimed_at sans secret_hash refusé)" "1" "$([ "$RC_HALF" != "0" ] && echo 1 || echo 0)"

# ============================================================
# 5. LECTURE LIÉE (behav).
# ============================================================
log "=== [5] LECTURE LIÉE ==="
V31_ROW="$(as_anon "select bound_order_id, order_status, service_mode, order_number, created_at, accepted_at, preparing_at, ready_at, completed_at, rejected_at, cancelled_at, order_total, order_currency, invoice_requested from public.get_order_tracking_by_capability('$ORDER_A','$CAP_A','$SECRET_A');")"
LEGACY_ROW="$(as_anon "select '$ORDER_A'::uuid, * from public.get_order_tracking('$ORDER_A','$TOKEN_A');")"
assert_behav_eq "5a. triplet valide -> ligne IDENTIQUE à get_order_tracking, précédée de bound_order_id = commande demandée" "$LEGACY_ROW" "$V31_ROW"
assert_behav_eq "5b. valeurs réelles : bound_order_id, statut, total, facture" "$ORDER_A|preparing|12.50|EUR|t" "$(as_anon "select bound_order_id, order_status, order_total, order_currency, invoice_requested from public.get_order_tracking_by_capability('$ORDER_A','$CAP_A','$SECRET_A');")"
assert_behav_eq "5c. lecture toujours valide APRÈS les rejeux d'upgrade (aucune rotation)" "1" "$(as_anon "$(read_q "'$ORDER_A'" "'$CAP_A'" "'$SECRET_A'")")"
assert_behav_eq "5d. capacité A + secret A présentés pour la commande B -> VIDE (liaison commande)" "0" "$(as_anon "$(read_q "'$ORDER_B'" "'$CAP_A'" "'$SECRET_A'")")"
assert_behav_eq "5e. capacité A + secret A présentés pour une commande inexistante -> VIDE" "0" "$(as_anon "$(read_q "'00000000-0000-0000-0000-000000000000'" "'$CAP_A'" "'$SECRET_A'")")"
assert_behav_eq "5f. capacité B + secret A pour la commande A -> VIDE" "0" "$(as_anon "$(read_q "'$ORDER_A'" "'$CAP_B'" "'$SECRET_A'")")"
assert_behav_eq "5g. capacité A + secret B pour la commande A -> VIDE" "0" "$(as_anon "$(read_q "'$ORDER_A'" "'$CAP_A'" "'$SECRET_B'")")"
assert_behav_eq "5h. capacité B + secret B pour la commande A (croisé tenant) -> VIDE" "0" "$(as_anon "$(read_q "'$ORDER_A'" "'$CAP_B'" "'$SECRET_B'")")"
assert_behav_eq "5i. secret en MAJUSCULES -> VIDE (comparaison exacte)" "0" "$(as_anon "$(read_q "'$ORDER_A'" "'$CAP_A'" "upper('$SECRET_A')")")"
assert_behav_eq "5j. secret tronqué -> VIDE" "0" "$(as_anon "$(read_q "'$ORDER_A'" "'$CAP_A'" "left('$SECRET_A', 63)")")"
assert_behav_eq "5k. public_token legacy utilisé comme secret -> VIDE" "0" "$(as_anon "$(read_q "'$ORDER_A'" "'$CAP_A'" "'$TOKEN_A'")")"
assert_behav_eq "5l. capability_id aléatoire -> VIDE" "0" "$(as_anon "$(read_q "'$ORDER_A'" "'00000000-0000-0000-0000-000000000000'" "'$SECRET_A'")")"
assert_behav_eq "5m. order NULL -> VIDE" "0" "$(as_anon "$(read_q null "'$CAP_A'" "'$SECRET_A'")")"
assert_behav_eq "5n. capability NULL -> VIDE" "0" "$(as_anon "$(read_q "'$ORDER_A'" null "'$SECRET_A'")")"
assert_behav_eq "5o. secret NULL -> VIDE" "0" "$(as_anon "$(read_q "'$ORDER_A'" "'$CAP_A'" null)")"
RC_WRONG_SECRET="$(as_anon_rc "select * from public.get_order_tracking_by_capability('$ORDER_A','$CAP_A','$SECRET_B');")"
OUT_WRONG_SECRET="$(cat "$TMP/out.txt" "$TMP/err.txt")"
RC_WRONG_ORDER="$(as_anon_rc "select * from public.get_order_tracking_by_capability('$ORDER_B','$CAP_A','$SECRET_A');")"
OUT_WRONG_ORDER="$(cat "$TMP/out.txt" "$TMP/err.txt")"
assert_behav_eq "5p. mauvais secret vs mauvaise commande : même code (0) et même sortie (vide)" "0||0|" "$RC_WRONG_SECRET|$OUT_WRONG_SECRET|$RC_WRONG_ORDER|$OUT_WRONG_ORDER"
assert_behav_eq "5q. authenticated peut aussi lire par capacité" "1" "$(as_user "$OWNER_UID" "$(read_q "'$ORDER_A'" "'$CAP_A'" "'$SECRET_A'")")"
RC_ANON_TABLE="$(as_anon_rc "select count(*) from public.order_tracking_capabilities;")"
assert_behav_eq "5r. anon ne peut PAS lire la table de capacités directement" "1" "$([ "$RC_ANON_TABLE" != "0" ] && echo 1 || echo 0)"
RC_ANON_INSERT="$(as_anon_rc "insert into public.order_tracking_capabilities (order_id) values ('$ORDER_D');")"
assert_behav_eq "5s. anon ne peut PAS créer de capacité directement" "1" "$([ "$RC_ANON_INSERT" != "0" ] && echo 1 || echo 0)"
UPD_BEFORE="$(sql "select updated_at from orders where id='$ORDER_A';")"
as_anon "select * from public.get_order_tracking_by_capability('$ORDER_A','$CAP_A','$SECRET_A');" >/dev/null
assert_behav_eq "5t. lecture pure : orders.updated_at inchangé" "$UPD_BEFORE" "$(sql "select updated_at from orders where id='$ORDER_A';")"
PGOPTIONS="-c role=authenticated" psql -X -q -d "$DB" -c "set test.uid = '$OWNER_UID'; select public.update_order_status('$ORDER_A','ready');" >/dev/null
assert_behav_eq "5u. la lecture reflète la transition marchande suivante" "ready" "$(as_anon "select order_status from public.get_order_tracking_by_capability('$ORDER_A','$CAP_A','$SECRET_A');")"

# ============================================================
# 6. CONCURRENCE (behav).
# ============================================================
log "=== [6] CONCURRENCE ==="
# 6a-c : une transaction détient le verrou de la commande D pendant 3 s ;
# un second upgrade concurrent doit ATTENDRE puis ne rien recevoir.
PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -v ON_ERROR_STOP=1 >"$TMP/c1.out" 2>&1 <<SQL &
begin;
$(upgrade_q "'$ORDER_D'" "'$TOKEN_D'")
select pg_sleep(3);
commit;
SQL
PID_HOLDER=$!
sleep 1
T0="$(date +%s%N)"
as_anon "$(upgrade_q "'$ORDER_D'" "'$TOKEN_D'")" >"$TMP/c2.out"
T1="$(date +%s%N)"
wait "$PID_HOLDER"
ELAPSED_MS=$(( (T1 - T0) / 1000000 ))
assert_behav_eq "6a. le détenteur du verrou reçoit la capacité" "1" "$(grep -c '|' "$TMP/c1.out" || true)"
assert_behav_eq "6b. l'upgrade concurrent a ATTENDU le verrou commande (>= 1500 ms) puis reçu un ensemble VIDE" "1|0" "$([ "$ELAPSED_MS" -ge 1500 ] && echo 1 || echo 0)|$(grep -c '|' "$TMP/c2.out" || true)"
assert_behav_eq "6c. UNE seule capacité pour D" "1" "$(sql "select count(*) from order_tracking_capabilities where order_id='$ORDER_D';")"
# 6d-f : rafale de 10 upgrades parallèles sur E.
for i in $(seq 1 10); do
  (PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$(upgrade_q "'$ORDER_E'" "'$TOKEN_E'")" >"$TMP/burst-$i.out" 2>"$TMP/burst-$i.err") &
done
wait
assert_behav_eq "6d. rafale de 10 upgrades parallèles : EXACTEMENT un secret émis" "1" "$(cat "$TMP"/burst-*.out | grep -c '|' || true)"
assert_behav_eq "6e. rafale : aucune erreur (pas de violation unique ni d'interblocage)" "0" "$(cat "$TMP"/burst-*.err | grep -c . || true)"
assert_behav_eq "6f. rafale : UNE seule capacité pour E" "1" "$(sql "select count(*) from order_tracking_capabilities where order_id='$ORDER_E';")"
SECRET_E="$(cat "$TMP"/burst-*.out | grep '|' | cut -d'|' -f2)"
CAP_E="$(cat "$TMP"/burst-*.out | grep '|' | cut -d'|' -f1)"
assert_behav_eq "6g. le secret unique émis par la rafale est lisible" "1" "$(as_anon "$(read_q "'$ORDER_E'" "'$CAP_E'" "'$SECRET_E'")")"

# ============================================================
# 6bis. IDENTIFIANT E-MAIL RÉUTILISABLE (behav) -- scénarios A..L
# côté SQL.
# ============================================================
log "=== [6bis] E-MAIL RÉUTILISABLE ==="
as_service() { PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$1" 2>&1; }
issue_q() { echo "select capability_id::text || '|' || capability_secret from public.issue_order_email_tracking_capability($1);"; }
ORDER_G="$(new_order "$RID_ONE" 5)"; TOKEN_G="$(tok "$ORDER_G")"
ORDER_H="$(new_order "$RID_TWO" 3)"
RC_ANON_ISSUE="$(as_anon_rc "$(issue_q "'$ORDER_G'")")"
assert_behav_eq "8a. anon ne peut PAS émettre d'identifiant e-mail" "1" "$([ "$RC_ANON_ISSUE" != "0" ] && echo 1 || echo 0)"
RC_AUTH_ISSUE="$(PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "$(issue_q "'$ORDER_G'")" >/dev/null 2>&1; echo $?)"
assert_behav_eq "8b. authenticated ne peut PAS émettre d'identifiant e-mail" "1" "$([ "$RC_AUTH_ISSUE" != "0" ] && echo 1 || echo 0)"
OUT_G="$(as_service "$(issue_q "'$ORDER_G'")")"
CAP_G="${OUT_G%%|*}"; SECRET_G="${OUT_G#*|}"
assert_behav_eq "8c. service_role émet un identifiant e-mail (64 hex)" "1" "$([[ "$SECRET_G" =~ ^[0-9a-f]{64}$ ]] && echo 1 || echo 0)"
assert_behav_eq "8d. né réclamé, kind=email, hash seul, expiration ~30 j" "email|t|t|t" "$(sql "select kind, secret_hash = sha256(convert_to('$SECRET_G','UTF8')), claimed_at is not null, expires_at between now() + interval '29 days 23 hours' and now() + interval '30 days 1 hour' from order_tracking_capabilities where id='$CAP_G';")"
assert_behav_eq "8e. le secret e-mail n'est stocké nulle part en clair" "0" "$(sql "select count(*) from order_tracking_capabilities where encode(secret_hash,'hex') = '$SECRET_G';")"
STATE_G="$(sql "select encode(secret_hash,'hex') || claimed_at::text || expires_at::text from order_tracking_capabilities where id='$CAP_G';")"
for i in 1 2 3 4 5; do
  assert_behav_eq "8f. [A/B/C/D] ouverture #$i (même lien, n'importe quel navigateur) -> lisible" "1" "$(as_anon "$(read_q "'$ORDER_G'" "'$CAP_G'" "'$SECRET_G'")")"
done
assert_behav_eq "8g. lectures répétées : aucune rotation/invalidation de l'identifiant e-mail" "$STATE_G" "$(sql "select encode(secret_hash,'hex') || claimed_at::text || expires_at::text from order_tracking_capabilities where id='$CAP_G';")"
assert_behav_eq "8h. [F] identifiant de G présenté pour H (autre tenant) -> VIDE" "0" "$(as_anon "$(read_q "'$ORDER_H'" "'$CAP_G'" "'$SECRET_G'")")"
assert_behav_eq "8i. [F] identifiant de G présenté pour A (même tenant) -> VIDE" "0" "$(as_anon "$(read_q "'$ORDER_A'" "'$CAP_G'" "'$SECRET_G'")")"
assert_behav_eq "8j. [G] mauvais secret -> VIDE" "0" "$(as_anon "$(read_q "'$ORDER_G'" "'$CAP_G'" "'$SECRET_A'")")"
assert_behav_eq "8k. [G] public_token de G utilisé comme secret -> VIDE" "0" "$(as_anon "$(read_q "'$ORDER_G'" "'$CAP_G'" "'$TOKEN_G'")")"
OUT_G_LEGACY="$(as_anon "$(upgrade_q "'$ORDER_G'" "'$TOKEN_G'")")"
assert_behav_eq "8l. [H] l'identifiant e-mail ne bloque PAS le premier upgrade legacy de G" "1" "$(printf '%s\n' "$OUT_G_LEGACY" | grep -c '|' || true)"
assert_behav_eq "8m. [I] rejeu legacy de G -> VIDE, aucune réémission" "" "$(as_anon "$(upgrade_q "'$ORDER_G'" "'$TOKEN_G'")")"
assert_behav_eq "8n. identifiant e-mail toujours lisible après upgrade + rejeu legacy" "1" "$(as_anon "$(read_q "'$ORDER_G'" "'$CAP_G'" "'$SECRET_G'")")"
assert_behav_eq "8o. une capacité legacy + une e-mail pour G" "email:1,legacy_upgrade:1" "$(sql "select string_agg(kind || ':' || n, ',' order by kind) from (select kind, count(*) n from order_tracking_capabilities where order_id='$ORDER_G' group by kind) s;")"
OUT_G2="$(as_service "$(issue_q "'$ORDER_G'")")"
CAP_G2="${OUT_G2%%|*}"; SECRET_G2="${OUT_G2#*|}"
assert_behav_eq "8p. seconde émission (réessai) : NOUVEL identifiant, l'ancien reste valide" "1|1" "$(as_anon "$(read_q "'$ORDER_G'" "'$CAP_G'" "'$SECRET_G'")")|$(as_anon "$(read_q "'$ORDER_G'" "'$CAP_G2'" "'$SECRET_G2'")")"
sql "update order_tracking_capabilities set expires_at = now() - interval '1 second' where id='$CAP_G2';" >/dev/null
assert_behav_eq "8q. identifiant e-mail EXPIRÉ -> VIDE (même issue qu'un faux)" "0" "$(as_anon "$(read_q "'$ORDER_G'" "'$CAP_G2'" "'$SECRET_G2'")")"
RC_BAD_EMAIL="$(psql -X -q -d "$DB" -c "insert into order_tracking_capabilities (order_id, kind) values ('$ORDER_G', 'email');" >/dev/null 2>&1; echo $?)"
assert_behav_eq "8r. capacité e-mail sans secret ni expiration structurellement impossible" "1" "$([ "$RC_BAD_EMAIL" != "0" ] && echo 1 || echo 0)"
for i in $(seq 3 16); do as_service "$(issue_q "'$ORDER_G'")" >/dev/null; done
assert_behav_eq "8s. plafond : 17e émission pour G -> VIDE" "" "$(as_service "$(issue_q "'$ORDER_G'")")"
assert_behav_eq "8t. commande inexistante / NULL -> VIDE" "|" "$(as_service "$(issue_q "'00000000-0000-0000-0000-000000000000'")")|$(as_service "$(issue_q null)")"

# ============================================================
# 7. GARDES DE MIGRATION + ROLLBACK (behav).
# ============================================================
log "=== [7] GARDES + ROLLBACK ==="
RC_DOUBLE="$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >"$TMP/double.out" 2>&1; echo $?)"
assert_behav_eq "7a. double application REFUSÉE" "1" "$([ "$RC_DOUBLE" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "7b. message SCANYM_SCHEMA_DRIFT" "1" "$([ "$(grep -c SCANYM_SCHEMA_DRIFT "$TMP/double.out" || true)" -ge 1 ] && echo 1 || echo 0)"

psql -c "drop database if exists \"$DB_NOFISCAL\";" >/dev/null 2>&1 || true
createdb "$DB_NOFISCAL"
build_common_bootstrap "$DB_NOFISCAL"
build_chain_until_tracking_foundation "$DB_NOFISCAL"
RC_NOFISCAL="$(psql -d "$DB_NOFISCAL" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >"$TMP/nofiscal.out" 2>&1; echo $?)"
assert_behav_eq "7c. application sans fiscal v1.1 (get_order_tracking à 10 colonnes) REFUSÉE" "1" "$([ "$RC_NOFISCAL" != "0" ] && echo 1 || echo 0)"
assert_behav_eq "7d. aucun objet v3.1 laissé après refus (transaction annulée)" "0" "$(psql -X -A -q -t -d "$DB_NOFISCAL" -c "select count(*) from pg_proc where proname in ('get_order_tracking_by_capability','upgrade_legacy_tracking_capability','issue_order_email_tracking_capability');")"

RC_RB="$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$ROLLBACK_SQL" >"$TMP/rb.out" 2>&1; echo $?)"
assert_behav_eq "7e. rollback appliqué sans erreur" "0" "$RC_RB"
assert_behav_eq "7f. rollback : table + 3 fonctions v3.1 supprimées" "0|0" "$(sql "select count(*) from pg_class where oid = to_regclass('public.order_tracking_capabilities');")|$(sql "select count(*) from pg_proc where proname in ('get_order_tracking_by_capability','upgrade_legacy_tracking_capability','issue_order_email_tracking_capability');")"
assert_behav_eq "7g. rollback : create_order inchangée" "$FP_CREATE_ORDER_BEFORE" "$(fn_fingerprint "$DB" create_order)"
assert_behav_eq "7h. rollback : get_order_tracking inchangée et toujours opérante" "$FP_GET_TRACKING_BEFORE|1" "$(fn_fingerprint "$DB" get_order_tracking)|$(as_anon "select count(*) from public.get_order_tracking('$ORDER_A','$TOKEN_A');")"
RC_RB2="$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$ROLLBACK_SQL" >/dev/null 2>&1; echo $?)"
assert_behav_eq "7i. second rollback REFUSÉ (v3.1 absent)" "1" "$([ "$RC_RB2" != "0" ] && echo 1 || echo 0)"
RC_REAPPLY="$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/dev/null 2>&1; echo $?)"
assert_behav_eq "7j. ré-application après rollback acceptée" "0" "$RC_REAPPLY"

# ============================================================
# BILAN
# ============================================================
log "=== BILAN : $PASS_COUNT PASS / $FAIL_COUNT FAIL (dont $STRUCT_COUNT structurelles, $BEHAV_COUNT comportementales) ==="
if [ "$((STRUCT_COUNT + BEHAV_COUNT))" -ne "$PASS_COUNT" ]; then
  log "FAIL: invariante cassée -- STRUCT_COUNT + BEHAV_COUNT != PASS_COUNT"
  FAIL_COUNT=$((FAIL_COUNT+1))
fi
if [ "$FAIL_COUNT" -gt 0 ]; then
  log "--- Détail des échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
