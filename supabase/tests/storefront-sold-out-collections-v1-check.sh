#!/usr/bin/env bash
# ============================================================
# Scanym — STOREFRONT SOLD-OUT COLLECTIONS v1 (issue #200, correction)
# Harnais PostgreSQL JETABLE pour
#   supabase/DRAFT-lot-storefront-sold-out-collections-v1.sql
#   supabase/DRAFT-lot-storefront-sold-out-collections-v1-ROLLBACK.sql
#
# Cluster CRÉÉ par le harnais (socket privée, aucun TCP), rôles
# anon/authenticated recréés, auth simulée via `test.uid`, schéma
# MINIMAL synthétique (aucune donnée réelle, aucun réseau, aucune base
# hébergée). Le schéma synthétique ne reproduit que ce dont le lot dépend
# : restaurants, restaurant_configs, assert_restaurant_asset_role.
#
# Usage : (utilisateur NON root)
#   SCANYM_DISPOSABLE_CLUSTER=1 bash supabase/tests/storefront-sold-out-collections-v1-check.sh
# Sortie : 0 = toutes les preuves produites ; 1 = au moins un échec.
# ============================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOT="$SUPABASE_DIR/DRAFT-lot-storefront-sold-out-collections-v1.sql"
ROLLBACK="$SUPABASE_DIR/DRAFT-lot-storefront-sold-out-collections-v1-ROLLBACK.sql"
FOUNDATION="$SUPABASE_DIR/DRAFT-lot-catalogue-collections-tags-foundation-v1.sql"
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
for f in "$LOT" "$ROLLBACK" "$FOUNDATION"; do [ -f "$f" ] || fatal "fichier introuvable : $f"; done

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

# --- Schéma synthétique minimal ------------------------------------
q "create role anon nologin; create role authenticated nologin;" >/dev/null
A=00000000-0000-0000-0000-00000000000a
B=00000000-0000-0000-0000-00000000000b
q "
create table public.restaurants (id uuid primary key, slug text unique not null, is_active boolean not null default true, status text not null default 'active');
create table public.restaurant_configs (restaurant_id uuid primary key references public.restaurants(id));
create table public.menu_categories (id uuid primary key, restaurant_id uuid not null, is_active boolean not null default true);
create table public.menu_items (id uuid primary key, category_id uuid not null, name text not null, display_order int not null default 0, is_available boolean not null default true, archived_at timestamptz);
create table public.menu_tags (id uuid primary key, restaurant_id uuid not null, name text not null, display_order int not null default 0, is_active boolean not null default true, visible_on_customer_menu boolean not null default true);
create table public.menu_item_tags (menu_item_id uuid, tag_id uuid);
grant usage on schema public to anon, authenticated;
insert into public.restaurants values ('$A','a','t','active'),('$B','b','t','active');
insert into public.restaurant_configs values ('$A'),('$B');
insert into public.menu_categories values ('10000000-0000-0000-0000-00000000000a','$A',true),('10000000-0000-0000-0000-00000000000b','$B',true);
-- A : p1 dispo, p2 en rupture, p3 archivé, p4 en rupture (seul porteur du tag 'Truffe')
insert into public.menu_items values
 ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-00000000000a','p1',1,true,null),
 ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-00000000000a','p2',2,false,null),
 ('20000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-00000000000a','p3',3,true,now()),
 ('20000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-00000000000a','p4',4,false,null),
 ('20000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-00000000000b','b1',1,false,null);
insert into public.menu_tags values
 ('30000000-0000-0000-0000-000000000001','$A','Bretagne',1,true,true),
 ('30000000-0000-0000-0000-000000000002','$A','Truffe',2,true,true),
 ('30000000-0000-0000-0000-000000000003','$B','Bretagne',1,true,true);
insert into public.menu_item_tags values
 ('20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001'),
 ('20000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000001'),
 ('20000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000001'),
 ('20000000-0000-0000-0000-000000000004','30000000-0000-0000-0000-000000000002'),
 ('20000000-0000-0000-0000-000000000005','30000000-0000-0000-0000-000000000003');
" >/dev/null || fatal "schéma synthétique impossible."

# Fonction ORIGINALE, extraite telle quelle du lot COLLECTIONS / TAGS.
awk '/^create or replace function public.get_restaurant_collections/{p=1} p{print} p&&/^end \$\$;/{exit}' "$FOUNDATION" > "$TMP_DIR/orig.sql"
[ -s "$TMP_DIR/orig.sql" ] || fatal "définition d'origine introuvable."
out="$(qf "$TMP_DIR/orig.sql")"; [ $? -eq 0 ] || fatal "fonction d'origine : $out"
q "revoke all on function public.get_restaurant_collections(uuid) from public; grant execute on function public.get_restaurant_collections(uuid) to anon, authenticated;" >/dev/null
ids() { q "select coalesce(string_agg(l || ':' || n, ',' order by l), '') from (select label l, cardinality(menu_item_ids) n from public.get_restaurant_collections('$1')) s"; }

# --- 0. Prérequis : refus tant que la colonne n'existe pas -----------
out="$(qf "$LOT")"
echo "$out" | grep -q "SCANYM_SCHEMA_DRIFT" && pass "refusé sans la colonne show_unavailable_products (ordre des lots)" || fail "pas de refus sans colonne : $out"
q "alter table public.restaurant_configs add column show_unavailable_products boolean not null default false;" >/dev/null

# --- 1. Avant correctif : rupture exclue (comportement actuel) -------
r="$(ids $A)"
[ "$r" = "Bretagne:1" ] && pass "AVANT : A ne voit que p1 (Bretagne:1) ; Truffe absente" || fail "AVANT = '$r'"

# --- 2. Application ----------------------------------------------------
out="$(qf "$LOT")"; rc=$?
[ $rc -eq 0 ] && pass "le lot s'applique (pré-vol et post-vol inclus)" || fail "le lot échoue : $out"

# --- 3. Réglage false : résultat IDENTIQUE à avant ------------------
r="$(ids $A)"
[ "$r" = "Bretagne:1" ] && pass "réglage false : résultat identique (p2/p4 en rupture toujours exclus)" || fail "false = '$r'"

# --- 4. Réglage true : ruptures incluses, archivé exclu --------------
q "update public.restaurant_configs set show_unavailable_products = true where restaurant_id='$A'" >/dev/null
r="$(ids $A)"
[ "$r" = "Bretagne:2,Truffe:1" ] && pass "réglage true : p2 rejoint Bretagne, Truffe (porteur p4 en rupture) revient ; p3 ARCHIVÉ reste exclu" || fail "true = '$r'"
n="$(q "select count(*) from public.get_restaurant_collections('$A') c where '20000000-0000-0000-0000-000000000003' = any(c.menu_item_ids)")"
[ "$n" = "0" ] && pass "le produit archivé n'apparaît dans aucune collection" || fail "archivé présent : $n"

# --- 5. Isolation entre établissements --------------------------------
r="$(ids $B)"
[ "$r" = "" ] && pass "B (réglage false) : son produit en rupture reste exclu — le réglage de A ne déborde pas" || fail "B = '$r'"
q "update public.restaurant_configs set show_unavailable_products = true where restaurant_id='$B'" >/dev/null
r="$(ids $B)"
[ "$r" = "Bretagne:1" ] && pass "B (réglage true) : voit uniquement SON produit, jamais ceux de A" || fail "B true = '$r'"
q "update public.restaurant_configs set show_unavailable_products = false where restaurant_id='$B'" >/dev/null

# --- 6. Garde-fous conservés ------------------------------------------
q "update public.menu_tags set visible_on_customer_menu=false where name='Truffe' and restaurant_id='$A'" >/dev/null
r="$(ids $A)"; [ "$r" = "Bretagne:2" ] && pass "tag non publié toujours exclu" || fail "tag non publié : '$r'"
q "update public.menu_tags set visible_on_customer_menu=true where name='Truffe' and restaurant_id='$A'; update public.restaurants set status='suspended' where id='$A'" >/dev/null
r="$(ids $A)"; [ "$r" = "" ] && pass "établissement non publié : aucune collection" || fail "non publié : '$r'"
q "update public.restaurants set status='active' where id='$A'; delete from public.restaurant_configs where restaurant_id='$A'" >/dev/null
r="$(ids $A)"; [ "$r" = "Bretagne:1" ] && pass "ligne de configuration absente : traité comme false" || fail "config absente : '$r'"
q "insert into public.restaurant_configs (restaurant_id, show_unavailable_products) values ('$A', true)" >/dev/null

# --- 7. Droits ----------------------------------------------------------
out="$(as_anon "select count(*) from public.get_restaurant_collections('$A')")"
[ "$out" = "2" ] && pass "anon peut toujours lire le contrat client" || fail "anon : $out"

# --- 8. Double application / rollback / réapplication ------------------
out="$(qf "$LOT")"; echo "$out" | grep -q "SCANYM_ALREADY_APPLIED" && pass "second passage refusé" || fail "double application : $out"
out="$(qf "$ROLLBACK")"; rc=$?
[ $rc -eq 0 ] && pass "le rollback s'applique" || fail "rollback : $out"
r="$(ids $A)"; [ "$r" = "Bretagne:1" ] && pass "APRÈS rollback : ruptures de nouveau exclues, même avec réglage true" || fail "après rollback : '$r'"
out="$(qf "$ROLLBACK")"; echo "$out" | grep -q "SCANYM_ROLLBACK_DRIFT" && pass "second rollback refusé" || fail "double rollback : $out"
out="$(qf "$LOT")"; [ $? -eq 0 ] && pass "le lot se réapplique après rollback" || fail "réapplication : $out"

log "=== BILAN : $PASS_COUNT PASS, $FAIL_COUNT FAIL ==="
[ "$FAIL_COUNT" = "0" ] && exit 0 || exit 1
