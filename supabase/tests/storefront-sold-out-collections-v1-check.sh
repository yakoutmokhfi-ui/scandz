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

md5fn() { q "select md5(prosrc) from pg_proc where oid='public.get_restaurant_collections(uuid)'::regprocedure"; }
lotfn() { awk '/^create or replace function public.get_restaurant_collections/{p=1} p{print} p&&/^end \$\$;/{exit}' "$LOT" > "$TMP_DIR/lotfn.sql"; }
lotfn

# --- 0. Prérequis : refus tant que la colonne n'existe pas -----------
out="$(qf "$LOT")"
echo "$out" | grep -q "SCANYM_SCHEMA_DRIFT" && pass "refusé sans la colonne show_unavailable_products (ordre des lots)" || fail "pas de refus sans colonne : $out"
q "alter table public.restaurant_configs add column show_unavailable_products boolean not null default false;" >/dev/null

# --- 0b. GARDE ANTI-ÉCRASEMENT (audit TURING P2) : fonction modifiée -> REFUS ---
# Variante de l'originale portant une restriction de publication supplémentaire.
sed 's/and mc.is_active = true/and mc.is_active = true and t.display_order > 99/' "$TMP_DIR/orig.sql" > "$TMP_DIR/restricted.sql"
out="$(qf "$TMP_DIR/restricted.sql")"; [ $? -eq 0 ] || fatal "variante restreinte : $out"
before="$(md5fn)"; rbefore="$(ids $A)"
out="$(qf "$LOT")"
echo "$out" | grep -q "SCANYM_FUNCTION_DRIFT" && pass "fonction modifiée (restriction de publication) : le lot REFUSE d'écraser" || fail "écrasement non refusé : $out"
[ "$(md5fn)" = "$before" ] && [ "$(ids $A)" = "$rbefore" ] && pass "la fonction modifiée est INTACTE après le refus (même empreinte, même résultat)" || fail "fonction altérée malgré le refus"
qf "$TMP_DIR/orig.sql" >/dev/null
q "alter function public.get_restaurant_collections(uuid) security invoker" >/dev/null
out="$(qf "$LOT")"; echo "$out" | grep -q "SCANYM_FUNCTION_DRIFT" && pass "attributs modifiés (security invoker) : le lot REFUSE" || fail "attributs non contrôlés : $out"
qf "$TMP_DIR/orig.sql" >/dev/null
q "revoke all on function public.get_restaurant_collections(uuid) from public; grant execute on function public.get_restaurant_collections(uuid) to anon, authenticated;" >/dev/null
[ "$(md5fn)" = "62469954066d750857dc0153534be55d" ] && pass "empreinte de l'original = constante du lot (62469954…)" || fail "empreinte original : $(md5fn)"

# --- 1. Avant correctif : rupture exclue (comportement actuel) -------
r="$(ids $A)"
[ "$r" = "Bretagne:1" ] && pass "AVANT : A ne voit que p1 (Bretagne:1) ; Truffe absente" || fail "AVANT = '$r'"

# --- 2. Application ----------------------------------------------------
out="$(qf "$LOT")"; rc=$?
[ $rc -eq 0 ] && pass "le lot s'applique (pré-vol et post-vol inclus)" || fail "le lot échoue : $out"

[ "$(md5fn)" = "364c52f3d561593421b2e6deb034069d" ] && pass "empreinte de la définition posée = constante du rollback (364c52f3…)" || fail "empreinte posée : $(md5fn)"

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

# --- 7b. GARDE ANTI-ÉCRASEMENT du rollback : fonction modifiée depuis le lot -> REFUS ---
sed 's/and mc.is_active = true/and mc.is_active = true and t.display_order > 99/' "$TMP_DIR/lotfn.sql" > "$TMP_DIR/restricted2.sql"
out="$(qf "$TMP_DIR/restricted2.sql")"; [ $? -eq 0 ] || fatal "variante restreinte 2 : $out"
before="$(md5fn)"; rbefore="$(ids $A)"
out="$(qf "$ROLLBACK")"
echo "$out" | grep -q "SCANYM_ROLLBACK_DRIFT" && pass "rollback : fonction modifiée depuis le lot -> REFUS d'écraser" || fail "rollback a écrasé : $out"
[ "$(md5fn)" = "$before" ] && [ "$(ids $A)" = "$rbefore" ] && pass "rollback refusé : la fonction modifiée est INTACTE" || fail "fonction altérée malgré le refus du rollback"
qf "$TMP_DIR/lotfn.sql" >/dev/null
[ "$(md5fn)" = "364c52f3d561593421b2e6deb034069d" ] || fatal "restauration de la définition du lot impossible"

# --- 7c. SCÉNARIO TURING (2e P2) : fonction passée en SECURITY INVOKER après le lot ---
# Avec RLS actif et aucune policy pour anon, un INVOKER ne voit rien ; si le
# rollback « réparait » en rétablissant SECURITY DEFINER, anon verrait la collection.
attrs() { q "select format('%s|%s|%s|%s|%s|%s|%s|%s', p.prosecdef, p.provolatile, p.proisstrict, p.proleakproof, p.proparallel, l.lanname, coalesce(p.proconfig::text,''), pg_get_function_result(p.oid)) from pg_proc p join pg_language l on l.oid=p.prolang where p.oid='public.get_restaurant_collections(uuid)'::regprocedure"; }
q "grant select on all tables in schema public to anon, authenticated; alter table public.restaurants enable row level security; alter table public.restaurant_configs enable row level security; alter table public.menu_categories enable row level security; alter table public.menu_items enable row level security; alter table public.menu_tags enable row level security; alter table public.menu_item_tags enable row level security;" >/dev/null
q "alter function public.get_restaurant_collections(uuid) security invoker" >/dev/null
b_attrs="$(attrs)"; b_md5="$(md5fn)"; b_anon="$(as_anon "select count(*) from public.get_restaurant_collections('$A')")"
[ "$b_anon" = "0" ] && pass "préparation : INVOKER + RLS => anon ne voit aucune collection" || fail "préparation Turing : anon voit '$b_anon'"
out="$(qf "$ROLLBACK")"
echo "$out" | grep -q "SCANYM_ROLLBACK_DRIFT" && pass "TURING : rollback REFUSE une fonction passée en SECURITY INVOKER" || fail "rollback a accepté INVOKER : $out"
[ "$(attrs)" = "$b_attrs" ] && [ "$(md5fn)" = "$b_md5" ] && pass "TURING : refus SANS MUTATION (attributs et corps identiques)" || fail "mutation malgré le refus : $(attrs)"
[ "$(as_anon "select count(*) from public.get_restaurant_collections('$A')")" = "0" ] && pass "TURING : anon ne voit toujours aucune collection (aucune exposition créée)" || fail "exposition anonyme créée"
q "alter function public.get_restaurant_collections(uuid) security definer" >/dev/null
for variant in "set search_path = public" "volatile" "leakproof" "strict" "parallel safe"; do
  q "alter function public.get_restaurant_collections(uuid) $variant" >/dev/null
  b_attrs="$(attrs)"
  out="$(qf "$ROLLBACK")"
  echo "$out" | grep -q "SCANYM_ROLLBACK_DRIFT" && [ "$(attrs)" = "$b_attrs" ] && [ "$(md5fn)" = "364c52f3d561593421b2e6deb034069d" ] && pass "rollback refusé sans mutation : attribut modifié ($variant)" || fail "attribut ($variant) non contrôlé : $out"
  qf "$TMP_DIR/lotfn.sql" >/dev/null   # create or replace : rétablit TOUS les attributs de la définition du lot
done
q "alter table public.restaurants disable row level security; alter table public.restaurant_configs disable row level security; alter table public.menu_categories disable row level security; alter table public.menu_items disable row level security; alter table public.menu_tags disable row level security; alter table public.menu_item_tags disable row level security;" >/dev/null
[ "$(attrs)" = "t|s|f|f|u|plpgsql|{\"search_path=\\\"\\\"\"}|TABLE(id uuid, label text, display_order integer, menu_item_ids uuid[])" ] && pass "attributs nominaux rétablis pour la suite du scénario" || fail "attributs nominaux : $(attrs)"

# --- 8. Double application / rollback / réapplication ------------------
out="$(qf "$LOT")"; echo "$out" | grep -q "SCANYM_ALREADY_APPLIED" && pass "second passage refusé" || fail "double application : $out"
out="$(qf "$ROLLBACK")"; rc=$?
[ $rc -eq 0 ] && pass "le rollback s'applique" || fail "rollback : $out"
r="$(ids $A)"; [ "$r" = "Bretagne:1" ] && pass "APRÈS rollback : ruptures de nouveau exclues, même avec réglage true" || fail "après rollback : '$r'"
out="$(qf "$ROLLBACK")"; echo "$out" | grep -q "SCANYM_ROLLBACK_DRIFT" && pass "second rollback refusé" || fail "double rollback : $out"
out="$(qf "$LOT")"; [ $? -eq 0 ] && pass "le lot se réapplique après rollback" || fail "réapplication : $out"

log "=== BILAN : $PASS_COUNT PASS, $FAIL_COUNT FAIL ==="
[ "$FAIL_COUNT" = "0" ] && exit 0 || exit 1
