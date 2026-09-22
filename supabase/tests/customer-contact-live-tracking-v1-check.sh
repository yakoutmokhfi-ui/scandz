#!/usr/bin/env bash
# ============================================================
# Scanym — CUSTOMER CONTACT + LIVE TRACKING v1
# Harnais PostgreSQL reproductible pour
# supabase/DRAFT-lot-customer-contact-live-tracking-v1.sql
# (+ -rollback.sql).
#
# Même patron que customer-tracking-capability-v3-1-check.sh : rôles
# anon/authenticated/service_role recréés minimalement, auth.uid()
# simulé via `test.uid`.
#
# Chaîne : schema.sql -> migration-orders.sql -> migration-orders-lang.sql
# -> migration-v29-merchant-dashboard.sql -> DRAFT-lot-customer-order-
# tracking-foundation.sql -> [STUB order_invoice_request] -> DRAFT-lot-
# tracking-final-fiscal-summary-v1-1.sql -> DRAFT-lot-customer-tracking-
# capability-v3-1.sql -> LOT SOUS TEST.
#
# Aucune capture `psql ... | head` (leçon V67C) : chaque requête est
# lue en entier.
#
# Usage : depuis la racine du dépôt :
#   sudo -u postgres bash supabase/tests/customer-contact-live-tracking-v1-check.sh
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_SQL="$SUPABASE_DIR/DRAFT-lot-customer-contact-live-tracking-v1.sql"
ROLLBACK_SQL="$SUPABASE_DIR/DRAFT-lot-customer-contact-live-tracking-v1-rollback.sql"
DB="scanym_cclt_v1_$$"
DB_NOPREREQ="scanym_cclt_v1_noprereq_$$"
TMP="$(mktemp -d "/tmp/scanym-cclt-v1-XXXXXX")"

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
  psql -c "drop database if exists \"$DB_NOPREREQ\";" >/dev/null 2>&1 || true
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
as_anon() { PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" 2>&1 || true; }
as_user() {
  local uid="$1" query="$2"
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set test.uid = '$uid';" -c "$query" 2>&1 || true
}
# Renvoie "OK" si la requête réussit, sinon le premier message d'erreur
# normalisé (sans position/contexte) -- lu en entier, jamais tronqué par
# un tube.
as_user_outcome() {
  local uid="$1" query="$2" out rc
  set +e
  out="$(PGOPTIONS="-c role=authenticated" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "set test.uid = '$uid';" -c "$query" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then echo "OK"; else
    out="${out#*ERROR:  }"; out="${out%%$'\n'*}"; echo "$out"
  fi
}
as_anon_outcome() {
  local query="$1" out rc
  set +e
  out="$(PGOPTIONS="-c role=anon" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "$query" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then echo "OK"; else
    out="${out#*ERROR:  }"; out="${out%%$'\n'*}"; echo "$out"
  fi
}

fn_fingerprint() {
  psql -X -A -q -t -d "$1" -c "select coalesce(md5(string_agg(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '<null>'), '#' order by n.nspname||'.'||p.proname||'('||replace(oidvectortypes(p.proargtypes), ' ', '')||')')), 'absent') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = '$2';"
}

build_common_bootstrap() {
  psql -d "$1" >/dev/null <<'SQL'
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

build_chain_until_v31() {
  local dbname="$1" with_v31="$2"
  for f in schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v64-dashboard-auth-whatsapp.sql DRAFT-lot-customer-order-tracking-foundation.sql; do
    psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  done
  psql -d "$dbname" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create table public.order_invoice_request (
  order_id uuid primary key references public.orders(id) on delete cascade
);
alter table public.order_invoice_request enable row level security;
revoke all on table public.order_invoice_request from public, anon, authenticated;
SQL
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-tracking-final-fiscal-summary-v1-1.sql" >/dev/null 2>&1
  if [ "$with_v31" = "yes" ]; then
    psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-customer-tracking-capability-v3-1.sql" >/dev/null 2>&1
  fi
}

# ============================================================
# 0. BASELINE + application du lot.
# ============================================================
log "=== [0] Construction $DB ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
build_common_bootstrap "$DB"
build_chain_until_v31 "$DB" yes
struct "chaîne prérequise appliquée (schema .. V29 + V64 + tracking foundation + fiscal v1.1 + capability v3.1)"

FP_CREATE_ORDER="$(fn_fingerprint "$DB" create_order)"
FP_TRACK_CAP="$(fn_fingerprint "$DB" get_order_tracking_by_capability)"
FP_TRACK_LEGACY="$(fn_fingerprint "$DB" get_order_tracking)"
FP_UPGRADE="$(fn_fingerprint "$DB" upgrade_legacy_tracking_capability)"
FP_UPDATE_STATUS="$(fn_fingerprint "$DB" update_order_status)"
FP_MARK_WA="$(fn_fingerprint "$DB" mark_whatsapp_opened)"
FP_UPDATE_WA="$(fn_fingerprint "$DB" update_restaurant_whatsapp)"
assert_struct_eq "0a. pré-condition : fonctions de référence présentes" "1" "$([ "$FP_CREATE_ORDER" != absent ] && [ "$FP_TRACK_CAP" != absent ] && [ "$FP_UPDATE_WA" != absent ] && echo 1 || echo 0)"

# Fixtures AVANT le lot (commerçants historiques).
OWNER_A="50000000-0000-0000-0000-00000000000a"
MANAGER_A="50000000-0000-0000-0000-0000000000aa"
STAFF_A="50000000-0000-0000-0000-0000000000a5"
OWNER_B="50000000-0000-0000-0000-00000000000b"
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<SQL
insert into auth.users (id, email) values
  ('$OWNER_A', 'owner-a@cclt.test'), ('$MANAGER_A', 'manager-a@cclt.test'),
  ('$STAFF_A', 'staff-a@cclt.test'), ('$OWNER_B', 'owner-b@cclt.test');
with r as (insert into restaurants (name, slug) values ('Epicerie Alpha', 'cclt-alpha') returning id)
insert into restaurant_configs (restaurant_id, whatsapp_number) select id, '+33600007001' from r;
with r as (insert into restaurants (name, slug) values ('Maison Beta', 'cclt-beta') returning id)
insert into restaurant_configs (restaurant_id, whatsapp_number) select id, '+33600007002' from r;
SQL
RID_A="$(sql "select id from restaurants where slug='cclt-alpha';")"
RID_B="$(sql "select id from restaurants where slug='cclt-beta';")"
sql "insert into restaurant_users (restaurant_id, user_id, role) values ('$RID_A', '$OWNER_A', 'owner'), ('$RID_A', '$MANAGER_A', 'manager'), ('$RID_A', '$STAFF_A', 'staff'), ('$RID_B', '$OWNER_B', 'owner');" >/dev/null

schema_counts() {
  echo "$(sql "select count(*) from pg_class where relnamespace='public'::regnamespace and relkind in ('r','v','m','p');")|$(sql "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and not t.tgisinternal;")|$(sql "select count(*) from pg_proc where pronamespace='public'::regnamespace;")|$(sql "select count(*) from information_schema.columns where table_schema='public' and table_name='restaurant_configs';")|$(sql "select count(*) from information_schema.columns where table_schema='public' and table_name<>'restaurant_configs';")"
}
IFS='|' read -r TABLES_BEFORE TRIGGERS_BEFORE FUNCS_BEFORE RC_COLS_BEFORE OTHER_COLS_BEFORE <<< "$(schema_counts)"
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/dev/null
struct "DRAFT-lot-customer-contact-live-tracking-v1.sql appliqué sans erreur (LOT SOUS TEST)"

# ============================================================
# 1. CATALOGUE (struct).
# ============================================================
log "=== [1] CATALOGUE ==="
assert_struct_eq "1a. restaurant_configs.whatsapp_enabled boolean NOT NULL DEFAULT true" "boolean|NO|true" "$(sql "select data_type||'|'||is_nullable||'|'||column_default from information_schema.columns where table_schema='public' and table_name='restaurant_configs' and column_name='whatsapp_enabled';")"
assert_struct_eq "1b. public_phone/public_email text NULL" "public_email:text:YES,public_phone:text:YES" "$(sql "select string_agg(column_name||':'||data_type||':'||is_nullable, ',' order by column_name) from information_schema.columns where table_schema='public' and table_name='restaurant_configs' and column_name in ('public_phone','public_email');")"
assert_struct_eq "1c. commerçants existants : WhatsApp reste ACTIVÉ (défaut true, comportement historique)" "2|t" "$(sql "select count(*)||'|'||case when bool_and(whatsapp_enabled) then 't' else 'f' end from restaurant_configs;")"
assert_struct_eq "1d. whatsapp_number reste NOT NULL (WhatsApp jamais supprimé globalement)" "NO" "$(sql "select is_nullable from information_schema.columns where table_schema='public' and table_name='restaurant_configs' and column_name='whatsapp_number';")"
for fn in "update_restaurant_whatsapp_enabled(uuid,boolean)" "update_restaurant_public_contact(uuid,text,text)" "get_order_tracking_customer_context_by_capability(uuid,uuid,text)"; do
  name="${fn%%(*}"
  assert_struct_eq "1k. $name : SECURITY DEFINER + search_path vide" "true|1" "$(sql "select prosecdef||'|'||(select count(*) from unnest(proconfig) c where c='search_path=\"\"') from pg_proc where proname='$name';")"
  assert_struct_eq "1l. $name : aucun EXECUTE résiduel PUBLIC" "f" "$(sql "select has_function_privilege('public','public.$fn','execute');")"
done
for fn in "update_restaurant_whatsapp_enabled(uuid,boolean)" "update_restaurant_public_contact(uuid,text,text)"; do
  assert_struct_eq "1m. anon n'a PAS EXECUTE sur $fn" "f" "$(sql "select has_function_privilege('anon','public.$fn','execute');")"
  assert_struct_eq "1n. authenticated a EXECUTE sur $fn" "t" "$(sql "select has_function_privilege('authenticated','public.$fn','execute');")"
done
assert_struct_eq "1o. anon + authenticated ont EXECUTE sur le contexte de suivi" "true|true" "$(sql "select has_function_privilege('anon','public.get_order_tracking_customer_context_by_capability(uuid,uuid,text)','execute')||'|'||has_function_privilege('authenticated','public.get_order_tracking_customer_context_by_capability(uuid,uuid,text)','execute');")"
assert_struct_eq "1q. contexte de suivi : colonnes de sortie exactes (contact public uniquement, jamais WhatsApp)" "bound_order_id:uuid,restaurant_name:text,public_phone:text,public_email:text" "$(sql "select string_agg(format('%s:%s', proargnames[i], format_type(proallargtypes[i], null)), ',' order by i) from pg_proc, generate_subscripts(proargmodes, 1) i where proname='get_order_tracking_customer_context_by_capability' and proargmodes[i]='t';")"

# ============================================================
# 2. NON-DÉRIVE (struct).
# ============================================================
log "=== [2] NON-DÉRIVE ==="
assert_struct_eq "2a. create_order inchangée" "$FP_CREATE_ORDER" "$(fn_fingerprint "$DB" create_order)"
assert_struct_eq "2b. get_order_tracking_by_capability (v3.1) inchangée" "$FP_TRACK_CAP" "$(fn_fingerprint "$DB" get_order_tracking_by_capability)"
assert_struct_eq "2c. get_order_tracking inchangée" "$FP_TRACK_LEGACY" "$(fn_fingerprint "$DB" get_order_tracking)"
assert_struct_eq "2d. upgrade_legacy_tracking_capability inchangée" "$FP_UPGRADE" "$(fn_fingerprint "$DB" upgrade_legacy_tracking_capability)"
assert_struct_eq "2e. update_order_status inchangée (aucun second moteur de statut)" "$FP_UPDATE_STATUS" "$(fn_fingerprint "$DB" update_order_status)"
assert_struct_eq "2f. mark_whatsapp_opened inchangée" "$FP_MARK_WA" "$(fn_fingerprint "$DB" mark_whatsapp_opened)"
assert_struct_eq "2g. update_restaurant_whatsapp inchangée" "$FP_UPDATE_WA" "$(fn_fingerprint "$DB" update_restaurant_whatsapp)"
assert_struct_eq "2i. delta de schéma exact : 0 table, 0 trigger, +3 fonctions, +3 colonnes (restaurant_configs) -- rien d'autre" "$TABLES_BEFORE|$TRIGGERS_BEFORE|$((FUNCS_BEFORE + 3))|$((RC_COLS_BEFORE + 3))|$OTHER_COLS_BEFORE" "$(schema_counts)"
assert_struct_eq "2h. statuts de commande inchangés (7 valeurs)" "1" "$(sql "select count(*) from pg_constraint where conrelid='public.orders'::regclass and conname='orders_status_check' and pg_get_constraintdef(oid) like '%new%accepted%preparing%ready%completed%rejected%cancelled%';")"

# ============================================================
# 3. WHATSAPP OPTIONNEL (behav).
# ============================================================
log "=== [3] WHATSAPP ==="
assert_behav_eq "3a. owner A désactive WhatsApp" "OK" "$(as_user_outcome "$OWNER_A" "select public.update_restaurant_whatsapp_enabled('$RID_A', false);")"
assert_behav_eq "3b. A : whatsapp_enabled=false, numéro CONSERVÉ (jamais effacé)" "f|+33600007001" "$(sql "select case when whatsapp_enabled then 't' else 'f' end||'|'||whatsapp_number from restaurant_configs where restaurant_id='$RID_A';")"
assert_behav_eq "3c. B non affecté (toujours activé)" "t" "$(sql "select case when whatsapp_enabled then 't' else 'f' end from restaurant_configs where restaurant_id='$RID_B';")"
assert_behav_eq "3d. owner B ne peut PAS modifier A (isolation)" "Forbidden" "$(as_user_outcome "$OWNER_B" "select public.update_restaurant_whatsapp_enabled('$RID_A', true);")"
assert_behav_eq "3e. staff A ne peut PAS modifier A (owner/manager uniquement)" "Forbidden" "$(as_user_outcome "$STAFF_A" "select public.update_restaurant_whatsapp_enabled('$RID_A', true);")"
assert_behav_eq "3f. anon ne peut PAS appeler la RPC" "1" "$(as_anon_outcome "select public.update_restaurant_whatsapp_enabled('$RID_A', true);" | grep -c 'permission denied' || true)"
assert_behav_eq "3g. manager A réactive WhatsApp (numéro valide)" "OK" "$(as_user_outcome "$MANAGER_A" "select public.update_restaurant_whatsapp_enabled('$RID_A', true);")"
sql "update restaurant_configs set whatsapp_number = 'invalide' where restaurant_id='$RID_B';" >/dev/null
sql "update restaurant_configs set whatsapp_enabled = false where restaurant_id='$RID_B';" >/dev/null
assert_behav_eq "3h. réactivation REFUSÉE si le numéro stocké est invalide (jamais un WhatsApp actif inutilisable)" "SCANYM_WHATSAPP_NUMBER_REQUIRED" "$(as_user_outcome "$OWNER_B" "select public.update_restaurant_whatsapp_enabled('$RID_B', true);")"
assert_behav_eq "3i. désactivation toujours possible sans numéro valide" "OK" "$(as_user_outcome "$OWNER_B" "select public.update_restaurant_whatsapp_enabled('$RID_B', false);")"
assert_behav_eq "3j. arguments NULL refusés" "SCANYM_INVALID_ARGUMENT" "$(as_user_outcome "$OWNER_A" "select public.update_restaurant_whatsapp_enabled('$RID_A', null);")"
sql "update restaurant_configs set whatsapp_number = '+33600007002', whatsapp_enabled = true where restaurant_id='$RID_B';" >/dev/null

# ============================================================
# 4. CONTACT PUBLIC (behav).
# ============================================================
log "=== [4] CONTACT PUBLIC ==="
assert_behav_eq "4a. owner A enregistre téléphone + e-mail publics" "OK" "$(as_user_outcome "$OWNER_A" "select public.update_restaurant_public_contact('$RID_A', ' +33 1 23 45 67 89 ', ' Contact@Alpha.Example ');")"
assert_behav_eq "4b. valeurs normalisées (trim, e-mail en minuscules)" "+33 1 23 45 67 89|contact@alpha.example" "$(sql "select public_phone||'|'||public_email from restaurant_configs where restaurant_id='$RID_A';")"
assert_behav_eq "4c. téléphone invalide refusé" "SCANYM_INVALID_PUBLIC_PHONE" "$(as_user_outcome "$OWNER_A" "select public.update_restaurant_public_contact('$RID_A', 'appelez-moi', null);")"
assert_behav_eq "4d. e-mail invalide refusé" "SCANYM_INVALID_PUBLIC_EMAIL" "$(as_user_outcome "$OWNER_A" "select public.update_restaurant_public_contact('$RID_A', null, 'pas-un-email');")"
assert_behav_eq "4e. refus sans effet : valeurs précédentes intactes" "+33 1 23 45 67 89|contact@alpha.example" "$(sql "select public_phone||'|'||public_email from restaurant_configs where restaurant_id='$RID_A';")"
assert_behav_eq "4f. owner B ne peut PAS modifier le contact de A" "Forbidden" "$(as_user_outcome "$OWNER_B" "select public.update_restaurant_public_contact('$RID_A', '+33 9 99 99 99 99', 'pirate@beta.example');")"
assert_behav_eq "4g. staff A ne peut PAS modifier le contact" "Forbidden" "$(as_user_outcome "$STAFF_A" "select public.update_restaurant_public_contact('$RID_A', null, null);")"
assert_behav_eq "4h. contraintes de table : écriture directe invalide refusée même en superutilisateur" "1" "$(psql -X -A -q -t -d "$DB" -c "update restaurant_configs set public_email='x' where restaurant_id='$RID_A';" 2>&1 | grep -c 'restaurant_configs_public_email_format' || true)"
assert_behav_eq "4i. owner B enregistre son propre contact (e-mail seul)" "OK" "$(as_user_outcome "$OWNER_B" "select public.update_restaurant_public_contact('$RID_B', '', 'bonjour@beta.example');")"
assert_behav_eq "4j. B : téléphone vide -> NULL" "|bonjour@beta.example" "$(sql "select coalesce(public_phone,'')||'|'||public_email from restaurant_configs where restaurant_id='$RID_B';")"

# ============================================================
# 5. COMMANDES DE TEST (fixtures, client d'exemple MYRIAM).
# ============================================================
new_order() { sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency, customer_name, customer_phone, delivery_address) values ('$1', $2, '$3', 30, 30, 'EUR', 'MYRIAM', '+33600000999', case when '$3' = 'delivery' then '1 rue de l''Exemple' end) returning id;"; }
ORDER_A1="$(new_order "$RID_A" 1 delivery)"
ORDER_A2="$(new_order "$RID_A" 2 pickup)"
ORDER_B1="$(new_order "$RID_B" 1 pickup)"

# ============================================================
# 7. CONTEXTE DE SUIVI PAR CAPACITÉ (behav).
# ============================================================
log "=== [7] CONTEXTE DE SUIVI ==="
tok() { sql "select public_token from orders where id='$1';"; }
upgrade() { as_anon "select capability_id::text || '|' || capability_secret from public.upgrade_legacy_tracking_capability('$1', '$2');"; }
OUT_M="$(upgrade "$ORDER_A1" "$(tok "$ORDER_A1")")"; CAP_M="${OUT_M%%|*}"; SEC_M="${OUT_M#*|}"
OUT_N="$(upgrade "$ORDER_A2" "$(tok "$ORDER_A2")")"; CAP_N="${OUT_N%%|*}"; SEC_N="${OUT_N#*|}"
OUT_B="$(upgrade "$ORDER_B1" "$(tok "$ORDER_B1")")"; CAP_B="${OUT_B%%|*}"; SEC_B="${OUT_B#*|}"
assert_behav_eq "7a. capacités v3.1 émises pour les 3 commandes (chemin réel)" "1|1|1" "$([[ "$SEC_M" =~ ^[0-9a-f]{64}$ ]] && echo 1 || echo 0)|$([[ "$SEC_N" =~ ^[0-9a-f]{64}$ ]] && echo 1 || echo 0)|$([[ "$SEC_B" =~ ^[0-9a-f]{64}$ ]] && echo 1 || echo 0)"
ctx() { as_anon "select bound_order_id||'|'||restaurant_name||'|'||coalesce(public_phone,'-')||'|'||coalesce(public_email,'-') from public.get_order_tracking_customer_context_by_capability('$1', '$2', '$3');"; }
assert_behav_eq "7b. commande de A : contact PUBLIC de A, liée à CETTE commande" "$ORDER_A1|Epicerie Alpha|+33 1 23 45 67 89|contact@alpha.example" "$(ctx "$ORDER_A1" "$CAP_M" "$SEC_M")"
assert_behav_eq "7c. autre commande de A : sa propre liaison, même contact public" "$ORDER_A2|Epicerie Alpha|+33 1 23 45 67 89|contact@alpha.example" "$(ctx "$ORDER_A2" "$CAP_N" "$SEC_N")"
assert_behav_eq "7d. commande de B : contact de B, jamais celui de A" "$ORDER_B1|Maison Beta|-|bonjour@beta.example" "$(ctx "$ORDER_B1" "$CAP_B" "$SEC_B")"
assert_behav_eq "7e. mauvais secret -> ensemble vide" "" "$(ctx "$ORDER_A1" "$CAP_M" "$SEC_N")"
assert_behav_eq "7f. capacité de B présentée pour la commande de A -> ensemble vide (aucune fuite inter-commerçants)" "" "$(ctx "$ORDER_A1" "$CAP_B" "$SEC_B")"
assert_behav_eq "7g. commande de B + capacité de A -> ensemble vide" "" "$(ctx "$ORDER_B1" "$CAP_M" "$SEC_M")"
assert_behav_eq "7h. NULL -> ensemble vide" "0" "$(as_anon "select count(*) from public.get_order_tracking_customer_context_by_capability(null, null, null);")"
ORDER_RES="$(new_order "$RID_A" 3 pickup)"
RESERVED="$(sql "insert into order_tracking_capabilities (order_id) values ('$ORDER_RES') returning id;")"
assert_behav_eq "7i. réservation non réclamée -> jamais lisible" "0" "$(as_anon "select count(*) from public.get_order_tracking_customer_context_by_capability('$ORDER_RES', '$RESERVED', '$SEC_M');")"
CTX_WA_ON="$(ctx "$ORDER_A1" "$CAP_M" "$SEC_M")"
sql "update restaurant_configs set whatsapp_enabled = false where restaurant_id='$RID_A';" >/dev/null
assert_behav_eq "7j. suivi indépendant de WhatsApp : contexte identique WhatsApp OFF" "$CTX_WA_ON" "$(ctx "$ORDER_A1" "$CAP_M" "$SEC_M")"
assert_behav_eq "7k. suivi principal v3.1 toujours lisible WhatsApp OFF" "1" "$(as_anon "select count(*) from public.get_order_tracking_by_capability('$ORDER_A1', '$CAP_M', '$SEC_M');")"
sql "update restaurant_configs set whatsapp_enabled = true where restaurant_id='$RID_A';" >/dev/null
assert_behav_eq "7l. anon ne peut appeler AUCUNE écriture du lot" "0|0" "$(as_anon_outcome "select public.update_restaurant_public_contact('$RID_A', null, null);" | grep -c '^OK$' || true)|$(as_anon_outcome "select public.update_restaurant_whatsapp_enabled('$RID_A', false);" | grep -c '^OK$' || true)"

# ============================================================
# 8. GARDES DE MIGRATION + ROLLBACK (behav).
# ============================================================
log "=== [8] GARDES + ROLLBACK ==="
RC_DOUBLE="$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >"$TMP/double.out" 2>&1; echo $?)"
assert_behav_eq "8a. double application REFUSÉE (SCANYM_ALREADY_APPLIED)" "1|1" "$([ "$RC_DOUBLE" != "0" ] && echo 1 || echo 0)|$([ "$(grep -c SCANYM_ALREADY_APPLIED "$TMP/double.out" || true)" -ge 1 ] && echo 1 || echo 0)"

psql -c "drop database if exists \"$DB_NOPREREQ\";" >/dev/null 2>&1 || true
createdb "$DB_NOPREREQ"
build_common_bootstrap "$DB_NOPREREQ"
build_chain_until_v31 "$DB_NOPREREQ" no
RC_NOPRE="$(psql -d "$DB_NOPREREQ" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >"$TMP/nopre.out" 2>&1; echo $?)"
assert_behav_eq "8b. application sans capability v3.1 REFUSÉE (SCANYM_SCHEMA_DRIFT)" "1|1" "$([ "$RC_NOPRE" != "0" ] && echo 1 || echo 0)|$([ "$(grep -c SCANYM_SCHEMA_DRIFT "$TMP/nopre.out" || true)" -ge 1 ] && echo 1 || echo 0)"
assert_behav_eq "8c. aucun objet laissé après refus (transaction annulée)" "0|0" "$(psql -X -A -q -t -d "$DB_NOPREREQ" -c "select count(*) from information_schema.columns where table_name='restaurant_configs' and column_name='whatsapp_enabled';")|$(psql -X -A -q -t -d "$DB_NOPREREQ" -c "select count(*) from pg_proc where proname in ('update_restaurant_whatsapp_enabled','update_restaurant_public_contact','get_order_tracking_customer_context_by_capability');")"

RC_RB="$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$ROLLBACK_SQL" >"$TMP/rb.out" 2>&1; echo $?)"
assert_behav_eq "8d. rollback appliqué sans erreur" "0" "$RC_RB"
assert_behav_eq "8e. rollback : 3 colonnes et 3 fonctions supprimées" "0|0" "$(sql "select count(*) from information_schema.columns where table_schema='public' and table_name='restaurant_configs' and column_name in ('whatsapp_enabled','public_phone','public_email');")|$(sql "select count(*) from pg_proc where proname in ('update_restaurant_whatsapp_enabled','update_restaurant_public_contact','get_order_tracking_customer_context_by_capability');")"
assert_behav_eq "8f. rollback : fonctions de référence inchangées" "1" "$([ "$(fn_fingerprint "$DB" create_order)" = "$FP_CREATE_ORDER" ] && [ "$(fn_fingerprint "$DB" get_order_tracking_by_capability)" = "$FP_TRACK_CAP" ] && [ "$(fn_fingerprint "$DB" update_restaurant_whatsapp)" = "$FP_UPDATE_WA" ] && echo 1 || echo 0)"
assert_behav_eq "8g. rollback : suivi v3.1 toujours opérant" "1" "$(as_anon "select count(*) from public.get_order_tracking_by_capability('$ORDER_A1', '$CAP_M', '$SEC_M');")"
RC_RB2="$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$ROLLBACK_SQL" >/dev/null 2>&1; echo $?)"
assert_behav_eq "8h. second rollback REFUSÉ (lot absent)" "1" "$([ "$RC_RB2" != "0" ] && echo 1 || echo 0)"
RC_REAPPLY="$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/dev/null 2>&1; echo $?)"
assert_behav_eq "8i. ré-application après rollback acceptée ; défaut WhatsApp ACTIVÉ" "0|t" "$RC_REAPPLY|$(sql "select bool_and(whatsapp_enabled) from restaurant_configs;")"

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
