#!/usr/bin/env bash
# ============================================================
# Scanym — STOREFRONT SOLD-OUT VISIBILITY v1 (issue #200)
# Harnais PostgreSQL JETABLE pour
#   supabase/DRAFT-lot-storefront-sold-out-visibility-v1.sql
#   supabase/DRAFT-lot-storefront-sold-out-visibility-v1-ROLLBACK.sql
#
# Cluster CRÉÉ par le harnais (socket privée, aucun TCP), rôles
# anon/authenticated recréés, auth simulée via `test.uid`, schéma
# MINIMAL synthétique (aucune donnée réelle, aucun réseau, aucune base
# hébergée). Le schéma synthétique ne reproduit que ce dont le lot dépend
# : restaurants, restaurant_configs, assert_restaurant_asset_role.
#
# Usage : (utilisateur NON root)
#   SCANYM_DISPOSABLE_CLUSTER=1 bash supabase/tests/storefront-sold-out-visibility-v1-check.sh
# Sortie : 0 = toutes les preuves produites ; 1 = au moins un échec.
# ============================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOT="$SUPABASE_DIR/DRAFT-lot-storefront-sold-out-visibility-v1.sql"
ROLLBACK="$SUPABASE_DIR/DRAFT-lot-storefront-sold-out-visibility-v1-ROLLBACK.sql"
TMP_DIR="$(mktemp -d)"
PASS_COUNT=0
FAIL_COUNT=0
CLUSTER_STARTED=0

log()  { printf '[%s] %s\n' "$(date -u '+%H:%M:%S')" "$*"; }
pass() { PASS_COUNT=$((PASS_COUNT + 1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); log "FAIL: $*"; }
fatal() { log "FATAL: $*"; cleanup; exit 1; }
cleanup() {
  if [ "$CLUSTER_STARTED" = "1" ]; then "$PG_CTL" -D "$TMP_DIR/cluster" -m immediate stop >/dev/null 2>&1; fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

[ "${SCANYM_DISPOSABLE_CLUSTER:-}" = "1" ] || { log "REFUS: SCANYM_DISPOSABLE_CLUSTER=1 est requis."; exit 2; }
for v in PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE DATABASE_URL POSTGRES_URL SUPABASE_DB_URL SCANYM_DB_URL; do
  if [ -n "${!v:-}" ]; then log "REFUS: variable de connexion héritée $v (nom seul affiché)."; exit 2; fi
done
[ "$(id -u)" != "0" ] || { log "REFUS: initdb refuse root. Relancer sous un utilisateur non privilégié."; exit 2; }
for f in "$LOT" "$ROLLBACK"; do [ -f "$f" ] || fatal "fichier introuvable : $f"; done

INITDB=""
for cand in initdb /usr/lib/postgresql/*/bin/initdb; do
  if command -v "$cand" >/dev/null 2>&1; then INITDB="$cand"; break; fi
done
[ -n "$INITDB" ] || fatal "initdb introuvable."
PG_CTL="$(dirname "$INITDB")/pg_ctl"; [ -x "$PG_CTL" ] || PG_CTL="pg_ctl"
command -v psql >/dev/null 2>&1 || fatal "psql introuvable."

"$INITDB" -D "$TMP_DIR/cluster" -U postgres -A trust -E UTF8 --locale=C >"$TMP_DIR/initdb.log" 2>&1 || fatal "initdb a échoué."
mkdir -p "$TMP_DIR/sock"
PORT=$(( 49152 + ($$ % 16000) ))
"$PG_CTL" -D "$TMP_DIR/cluster" -o "-c listen_addresses='' -c unix_socket_directories='$TMP_DIR/sock' -c port=$PORT" -w -l "$TMP_DIR/pg.log" start >/dev/null 2>&1 || fatal "démarrage du cluster impossible."
CLUSTER_STARTED=1

q()  { psql -X -q -t -A -v ON_ERROR_STOP=1 -h "$TMP_DIR/sock" -p "$PORT" -U postgres -d postgres -c "$1" 2>&1; }
qf() { psql -X -q -t -A -v ON_ERROR_STOP=1 -h "$TMP_DIR/sock" -p "$PORT" -U postgres -d postgres -f "$1" 2>&1; }
# Exécute en tant que `authenticated` avec l'identité simulée $1.
as_user() { psql -X -q -t -A -v ON_ERROR_STOP=1 -h "$TMP_DIR/sock" -p "$PORT" -U postgres -d postgres -c "set role authenticated; select set_config('test.uid','$1',false); $2" 2>&1; }
as_anon() { psql -X -q -t -A -v ON_ERROR_STOP=1 -h "$TMP_DIR/sock" -p "$PORT" -U postgres -d postgres -c "set role anon; $1" 2>&1; }

# --- Schéma synthétique minimal -----------------------------------
q "create role anon nologin; create role authenticated nologin;" >/dev/null
q "
create table public.restaurants (id uuid primary key, slug text unique not null);
create table public.restaurant_configs (restaurant_id uuid primary key references public.restaurants(id), bg_color text);
create table public.members (user_id text, restaurant_id uuid);
grant usage on schema public to anon, authenticated;
grant select on all tables in schema public to anon, authenticated;
create function public.assert_restaurant_asset_role(p_restaurant_id uuid) returns void
  language plpgsql security definer set search_path = '' as \$f\$
begin
  if not exists (select 1 from public.members m
                 where m.user_id = current_setting('test.uid', true) and m.restaurant_id = p_restaurant_id) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
end \$f\$;
insert into public.restaurants values
  ('00000000-0000-0000-0000-00000000000a','au-lait-cru'),
  ('00000000-0000-0000-0000-00000000000b','autre-marchand'),
  ('00000000-0000-0000-0000-00000000000c','troisieme-marchand');
insert into public.restaurant_configs (restaurant_id) select id from public.restaurants;
insert into public.members values ('ownerA','00000000-0000-0000-0000-00000000000a'),('ownerB','00000000-0000-0000-0000-00000000000b');
" >/dev/null || fatal "schéma synthétique impossible."
A=00000000-0000-0000-0000-00000000000a
B=00000000-0000-0000-0000-00000000000b
C=00000000-0000-0000-0000-00000000000c

# --- 1. Le lot s'applique ; lignes existantes = false -------------
out="$(qf "$LOT")" ; rc=$?
[ $rc -eq 0 ] && pass "le lot s'applique (pré-vol et post-vol inclus)" || fail "le lot échoue : $out"
n="$(q "select count(*) from public.restaurant_configs where show_unavailable_products = false")"
[ "$n" = "3" ] && pass "les 3 lignes EXISTANTES valent false (comportement inchangé)" || fail "lignes existantes à false : $n/3"

# --- 2. Nouvelle ligne = false -------------------------------------
q "insert into public.restaurants values ('00000000-0000-0000-0000-00000000000d','nouveau'); insert into public.restaurant_configs (restaurant_id) values ('00000000-0000-0000-0000-00000000000d');" >/dev/null
v="$(q "select show_unavailable_products from public.restaurant_configs where restaurant_id='00000000-0000-0000-0000-00000000000d'")"
[ "$v" = "f" ] && pass "une NOUVELLE ligne reçoit false par défaut" || fail "défaut nouvelle ligne = '$v'"
out="$(q "update public.restaurant_configs set show_unavailable_products=null where restaurant_id='$A'")"
echo "$out" | grep -qi "not-null\|null value" && pass "NOT NULL : NULL refusé en écriture directe" || fail "NULL accepté : $out"

# --- 3. RPC : propriétaire, isolation ------------------------------
out="$(as_user ownerA "select public.update_restaurant_show_unavailable('$A', true)")"; rc=$?
[ $rc -eq 0 ] && pass "le propriétaire de A active l'option pour A" || fail "RPC propriétaire : $out"
va="$(q "select show_unavailable_products from public.restaurant_configs where restaurant_id='$A'")"
vb="$(q "select show_unavailable_products from public.restaurant_configs where restaurant_id='$B'")"
vc="$(q "select show_unavailable_products from public.restaurant_configs where restaurant_id='$C'")"
[ "$va" = "t" ] && [ "$vb" = "f" ] && [ "$vc" = "f" ] && pass "AUCUNE fuite : A=true, B=false, C=false" || fail "fuite entre marchands : A=$va B=$vb C=$vc"

out="$(as_user ownerA "select public.update_restaurant_show_unavailable('$B', true)")"
echo "$out" | grep -q "forbidden" && pass "le propriétaire de A ne peut PAS écrire sur B" || fail "écriture inter-marchands non refusée : $out"
vb="$(q "select show_unavailable_products from public.restaurant_configs where restaurant_id='$B'")"
[ "$vb" = "f" ] && pass "B inchangé après la tentative refusée" || fail "B modifié : $vb"

out="$(as_anon "select public.update_restaurant_show_unavailable('$A', true)")"
echo "$out" | grep -qi "permission denied" && pass "anon ne peut pas exécuter le RPC" || fail "anon a exécuté : $out"

out="$(as_user ownerA "select public.update_restaurant_show_unavailable('$A', null)")"
echo "$out" | grep -q "Invalid show_unavailable_products" && pass "NULL refusé par le RPC" || fail "NULL non refusé : $out"

out="$(as_user ownerA "select public.update_restaurant_show_unavailable('$A', false)")"; rc=$?
v="$(q "select show_unavailable_products from public.restaurant_configs where restaurant_id='$A'")"
[ $rc -eq 0 ] && [ "$v" = "f" ] && pass "retour à false persisté" || fail "retour à false : rc=$rc v=$v $out"

q "insert into public.members values ('ghost','00000000-0000-0000-0000-0000000000ff')" >/dev/null
out="$(as_user ghost "select public.update_restaurant_show_unavailable('00000000-0000-0000-0000-0000000000ff', true)")"
echo "$out" | grep -q "Restaurant not found" && pass "établissement sans configuration : erreur explicite" || fail "not found non signalé : $out"

# --- 4. Anti-double-application ------------------------------------
out="$(qf "$LOT")"
echo "$out" | grep -q "SCANYM_ALREADY_APPLIED" && pass "second passage refusé (anti-double-application)" || fail "double application non refusée : $out"

# --- 5. Rollback + réapplication -----------------------------------
out="$(qf "$ROLLBACK")"; rc=$?
[ $rc -eq 0 ] && pass "le rollback s'applique" || fail "rollback : $out"
n="$(q "select count(*) from pg_attribute a join pg_class c on c.oid=a.attrelid where c.relname='restaurant_configs' and a.attname='show_unavailable_products' and not a.attisdropped")"
f="$(q "select to_regprocedure('public.update_restaurant_show_unavailable(uuid,boolean)') is null")"
[ "$n" = "0" ] && [ "$f" = "t" ] && pass "colonne et RPC supprimés" || fail "restes après rollback : col=$n fn_absente=$f"
out="$(qf "$ROLLBACK")"
echo "$out" | grep -q "SCANYM_ROLLBACK_DRIFT" && pass "second rollback refusé (rien à annuler)" || fail "double rollback : $out"
out="$(qf "$LOT")"; rc=$?
[ $rc -eq 0 ] && pass "le lot se réapplique après rollback" || fail "réapplication : $out"

log "=== BILAN : $PASS_COUNT PASS, $FAIL_COUNT FAIL ==="
[ "$FAIL_COUNT" = "0" ] && exit 0 || exit 1
