#!/usr/bin/env bash
# ============================================================
# Scanym — STOREFRONT PHOTO OVERLAY CONFIGURATION v1
# Harnais PostgreSQL JETABLE sur la CHAÎNE RÉELLE DU DÉPÔT
# (remédiation de l'audit indépendant : le harnais précédent
# `storefront-photo-overlay-v1-check.sh` utilisait un schéma synthétique
# minimal et ne prouve PAS la compatibilité avec le schéma réel).
#
# Ici, la chaîne de migrations/DRAFT du dépôt est rejouée dans un cluster
# créé par le harnais (même liste que le harnais MCC, lue dans ce fichier,
# jamais recopiée), jusqu'à MCC v1 inclus. Les objets exercés sont les
# VRAIS : restaurants, restaurant_configs (RLS, GRANT, contraintes),
# assert_restaurant_asset_role, is_scanym_operator, create_establishment,
# restaurant_users, scanym_operators.
#
# LIMITES ASSUMÉES (à ne pas présenter comme une preuve hébergée) :
#   - ce n'est PAS la base hébergée : seule la chaîne DU DÉPÔT est rejouée ;
#     tout objet créé hors dépôt (console, migrations non versionnées) est
#     absent ; la dérive réelle de production n'est pas couverte ;
#   - les schémas `auth` et `storage` de la plateforme Supabase sont des
#     talons minimaux (auth.users, auth.uid() simulé via `test.uid`,
#     storage.buckets/objects) ;
#   - données 100 % synthétiques, aucun réseau.
#
# Usage : (utilisateur NON root)
#   SCANYM_DISPOSABLE_CLUSTER=1 bash supabase/tests/storefront-photo-overlay-v1-repo-chain-check.sh
# Sortie : 0 = toutes les preuves produites ; 1 = au moins un échec.
# ============================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MCC_HARNESS="$SCRIPT_DIR/merchant-customer-communications-v1-check.sh"
TMP_DIR="$(mktemp -d)"
ERR="$TMP_DIR/err.txt"
PASS_COUNT=0; FAIL_COUNT=0; CLUSTER_STARTED=0

log()  { printf '[%s] %s\n' "$(date -u '+%H:%M:%S')" "$*"; }
pass() { PASS_COUNT=$((PASS_COUNT + 1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); log "FAIL: $*"; }
fatal() { log "FATAL: $*"; log "=== BILAN : preuve IMPOSSIBLE à produire -- échec fermé ==="; cleanup; exit 1; }
cleanup() {
  if [ "$CLUSTER_STARTED" = "1" ]; then "$PG_CTL" -D "$TMP_DIR/cluster" -m immediate stop >/dev/null 2>&1; fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

[ "${SCANYM_DISPOSABLE_CLUSTER:-}" = "1" ] || { log "REFUS: SCANYM_DISPOSABLE_CLUSTER=1 est requis."; exit 2; }
for v in PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE DATABASE_URL POSTGRES_URL POSTGRESQL_URL PG_URL SUPABASE_DB_URL SCANYM_DB_URL SCANYM_DATABASE_URL; do
  if [ -n "${!v:-}" ]; then log "REFUS: variable de connexion héritée $v (nom seul affiché)."; exit 2; fi
done
[ "$(id -u)" != "0" ] || { log "REFUS: initdb refuse root. Relancer sous un utilisateur non privilégié."; exit 2; }
[ -f "$MCC_HARNESS" ] || fatal "harnais MCC introuvable (source de la chaîne prédécesseur)."

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
"$PG_CTL" -D "$TMP_DIR/cluster" -l "$TMP_DIR/pg.log" -o "-p $PORT -k $TMP_DIR/sock -c listen_addresses=''" start >/dev/null 2>&1 || fatal "démarrage du cluster jetable impossible."
CLUSTER_STARTED=1
export PGHOST="$TMP_DIR/sock" PGPORT="$PORT" PGDATABASE=postgres PGUSER=postgres PGCONNECT_TIMEOUT=5
DATA_DIR="$(psql -X -A -q -t -c "select current_setting('data_directory');" | tr -d ' ')"
[ "$DATA_DIR" = "$TMP_DIR/cluster" ] || fatal "le serveur joint n'est pas le cluster jetable créé ici."
log "[sûreté] cluster jetable créé par ce harnais, prouvé par data_directory."

chain() { grep -m1 "^$1=\"" "$MCC_HARNESS" | sed -E "s/^$1=\"(.*)\"\$/\1/"; }
MINIMAL_CHAIN="$(chain MINIMAL_CHAIN)"; REST_CHAIN="$(chain REST_CHAIN)"
CGV_AFTER_N1A_CHAIN="$(chain CGV_AFTER_N1A_CHAIN)"; TRACKING_TAIL="$(chain TRACKING_TAIL)"; MCC_TAIL="$(chain MCC_TAIL)"
for n in MINIMAL_CHAIN REST_CHAIN CGV_AFTER_N1A_CHAIN TRACKING_TAIL MCC_TAIL; do
  [ -n "${!n}" ] || fatal "variable de chaîne $n introuvable dans le harnais MCC."
done
LOT=DRAFT-lot-storefront-photo-overlay-v1.sql
ROLLBACK=DRAFT-lot-storefront-photo-overlay-v1-rollback.sql
DATA=DRAFT-data-storefront-photo-overlay-au-lait-cru.sql
THEME=DRAFT-lot-theme-content-settings-v1.sql
for f in $MINIMAL_CHAIN $REST_CHAIN $CGV_AFTER_N1A_CHAIN $TRACKING_TAIL $MCC_TAIL \
         DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql \
         DRAFT-lot-order-received-enqueue-recovery-v1.sql migration-20260919000000-order-success-boundary-v1.sql \
         DRAFT-lot-merchant-customer-communications-v1.sql $THEME $LOT $ROLLBACK $DATA; do
  [ -f "$SUPABASE_DIR/$f" ] || fatal "fichier absent : supabase/$f"
done

RID_A='a1111111-1111-4111-8111-111111111111'; RID_B='b2222222-2222-4222-8222-222222222222'
RID_X='c3333333-3333-4333-8333-333333333333'   # inactif
RID_ALC='d4444444-4444-4444-8444-444444444444' # fixture synthétique au slug au-lait-cru
OWNER_A='51111111-1111-4111-8111-11111111000a'; MANAGER_A='51111111-1111-4111-8111-1111111100aa'
STAFF_A='51111111-1111-4111-8111-11111111005a'; OWNER_B='52222222-2222-4222-8222-22222222000b'
OPERATOR='5a000000-0000-4000-8000-0000000000a1'
DB="ovl_base"

apply_file() { psql -X -d "$1" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$2" >/dev/null 2>"$ERR"; }
run() { # db role uid query
  local db="$1" role="$2" uid="$3" q="$4" out
  if [ -n "$role" ] && [ -n "$uid" ]; then
    out="$(PGOPTIONS="-c role=$role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$db" -c "set test.uid = '$uid';" -c "$q" 2>"$ERR")"
  elif [ -n "$role" ]; then
    out="$(PGOPTIONS="-c role=$role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$db" -c "$q" 2>"$ERR")"
  else
    out="$(psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$db" -c "$q" 2>"$ERR")"
  fi
  if [ $? -ne 0 ]; then printf '<SQL_ERROR: %s>\n' "$(tr '\n\r' '  ' < "$ERR" | cut -c1-220)"; return 0; fi
  printf '%s\n' "$out"
}
val() { run "$@" | tail -1 | tr -d ' '; }
# val() retire les espaces des sorties : la comparaison de messages d'erreur se fait donc espaces retirés des deux côtés.
expect() { local got="${2// /}" want="${3// /}"; case "$got" in *"$want"*) pass "$1";; *) fail "$1 -- attendu « $3 », obtenu « $2 »";; esac; }
expect_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 -- attendu « $3 », obtenu « $2 »"; fi; }

createdb "$DB" || fatal "createdb"
psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<'SQL' || fatal "amorçage : $(tr '\n' ' ' < "$ERR")"
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
alter role service_role bypassrls; alter role anon nobypassrls; alter role authenticated nobypassrls;
create schema if not exists storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/'); $$;
SQL

for f in $MINIMAL_CHAIN; do
  apply_file "$DB" "$f" || fatal "chaîne, $f : $(head -3 "$ERR" | tr '\n' ' ')"
  psql -X -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
done
for f in $REST_CHAIN DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql $CGV_AFTER_N1A_CHAIN; do
  apply_file "$DB" "$f" || fatal "chaîne, $f : $(head -3 "$ERR" | tr '\n' ' ')"
done
psql -X -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
for f in DRAFT-lot-order-received-enqueue-recovery-v1.sql migration-20260919000000-order-success-boundary-v1.sql; do
  apply_file "$DB" "$f" || fatal "chaîne, $f : $(head -3 "$ERR" | tr '\n' ' ')"
done
psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<'SQL' || fatal "talon order_invoice_request"
create table public.order_invoice_request (order_id uuid primary key references public.orders(id) on delete cascade);
alter table public.order_invoice_request enable row level security;
revoke all on table public.order_invoice_request from public, anon, authenticated;
SQL
for f in $TRACKING_TAIL $MCC_TAIL DRAFT-lot-merchant-customer-communications-v1.sql; do
  apply_file "$DB" "$f" || fatal "chaîne, $f : $(head -3 "$ERR" | tr '\n' ' ')"
done
log "chaîne réelle du dépôt (jusqu'à MCC v1) appliquée."

psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<SQL || fatal "fixtures : $(tr '\n' ' ' < "$ERR")"
insert into auth.users (id, email) values
  ('$OWNER_A','owner-a@ovl.test'), ('$MANAGER_A','manager-a@ovl.test'), ('$STAFF_A','staff-a@ovl.test'),
  ('$OWNER_B','owner-b@ovl.test'), ('$OPERATOR','operator@ovl.test');
insert into public.scanym_operators (user_id) values ('$OPERATOR');
insert into public.restaurants (id, slug, name, is_active, status, country) values
  ('$RID_A','ovl-alpha','Epicerie Alpha',true,'active','FR'),
  ('$RID_B','ovl-beta','Primeur Beta',true,'active','FR'),
  ('$RID_X','ovl-inactif','Inactif',false,'active','FR'),
  ('$RID_ALC','au-lait-cru','FIXTURE synthetique',true,'active','FR');
insert into public.restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number, address, public_email, public_phone)
select id, 5, 'EUR', '+33600000001', '3 place du Marche, 75011 Paris', 'x@ovl.test', '+33123456789' from public.restaurants;
insert into public.restaurant_users (restaurant_id, user_id, role) values
  ('$RID_A','$OWNER_A','owner'), ('$RID_A','$MANAGER_A','manager'), ('$RID_A','$STAFF_A','staff'), ('$RID_B','$OWNER_B','owner');
SQL
# Un établissement HISTORIQUE créé par le VRAI create_establishment avant le lot.
OUT="$(run "$DB" '' '' "set test.uid = '$OPERATOR'; set role authenticated; select restaurant_id from public.create_establishment('Historique','ovl-historique','FR','Lyon','cheese_shop',null,null,'+33600000099','fr',array['fr'],'EUR',null,'hist@ovl.test',null);")"
RID_H="$(printf '%s' "$OUT" | grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
[ -n "$RID_H" ] || fatal "create_establishment (réel) a échoué avant le lot : $OUT"

createdb -T "$DB" ovl_theme_first 2>/dev/null || { psql -X -d postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$DB' and pid<>pg_backend_pid();" >/dev/null 2>&1; createdb -T "$DB" ovl_theme_first || fatal "clone theme_first"; }
createdb -T "$DB" ovl_atomic || fatal "clone atomic"
createdb -T "$DB" ovl_drift || fatal "clone drift"
createdb -T "$DB" ovl_rollback || fatal "clone rollback"

# Empreintes AVANT : lignes de configuration (hors colonne du lot) et définitions de fonctions.
FP_ROWS_SQL="select md5(string_agg(row_to_json(c)::jsonb::text, '|' order by restaurant_id)) from public.restaurant_configs c"
FP_FUNCS_SQL="select md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.oid::regprocedure::text)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'"
FP_COLS_SQL="select md5(string_agg(column_name||':'||data_type||':'||coalesce(column_default,'')||':'||is_nullable, '|' order by column_name)) from information_schema.columns where table_schema='public' and table_name='restaurant_configs'"
ROWS_BEFORE="$(val "$DB" '' '' "$FP_ROWS_SQL")"; FUNCS_BEFORE="$(val "$DB" '' '' "$FP_FUNCS_SQL")"; COLS_BEFORE="$(val "$DB" '' '' "$FP_COLS_SQL")"
# [2c] (correction post-contre-audit 1076a6f) : l'empreinte « avant » des fonctions EXISTANTES est prise ICI, AVANT l'application du lot.
# Version précédente : les deux empreintes étaient calculées après migration (comparaison tautologique, faux PASS possible).
FP_FUNCS_EXCL_SQL="select md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.oid::regprocedure::text)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname <> 'update_restaurant_photo_overlay'"
FUNCS_EXCL_BEFORE="$(val "$DB" '' '' "$FP_FUNCS_EXCL_SQL")"
N_FUNCS_EXCL_BEFORE="$(val "$DB" '' '' "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname <> 'update_restaurant_photo_overlay'")"
N_BEFORE="$(val "$DB" '' '' "select count(*) from public.restaurant_configs")"
BG_ACL_BEFORE="$(val "$DB" '' '' "select string_agg(r||':'||p||':'||has_column_privilege(r,'public.restaurant_configs','bg_color',p)::text, ',' order by r,p) from unnest(array['anon','authenticated','service_role']) r, unnest(array['SELECT','INSERT','UPDATE']) p")"
TBL_ACL_BEFORE="$(val "$DB" '' '' "select coalesce(relacl::text,'') from pg_class where oid='public.restaurant_configs'::regclass")"
POL_BEFORE="$(val "$DB" '' '' "select md5(string_agg(policyname||cmd||coalesce(qual,'')||coalesce(with_check,''), '|' order by policyname)) from pg_policies where tablename='restaurant_configs'")"

# ---------------- [1] application sur la chaîne réelle ----------------
if apply_file "$DB" "$LOT"; then pass "[1] le lot s'applique sur la chaîne réelle du dépôt (pré-vol et post-vol inclus)"; else fail "[1] échec : $(head -3 "$ERR" | tr '\n' ' ')"; fi

# ---------------- [2] lignes existantes = standard, rien d'autre ne bouge ----------------
expect_eq "[2a] TOUTES les lignes existantes (fixtures + create_establishment réel) valent 'standard'" "$(val "$DB" '' '' "select count(*) from public.restaurant_configs where storefront_photo_overlay = 'standard'")" "$N_BEFORE"
ROWS_AFTER="$(val "$DB" '' '' "select md5(string_agg((row_to_json(c)::jsonb - 'storefront_photo_overlay')::text, '|' order by restaurant_id)) from public.restaurant_configs c")"
expect_eq "[2b] aucune AUTRE colonne d'aucune ligne n'a changé (empreinte hors colonne du lot)" "$ROWS_AFTER" "$ROWS_BEFORE"
FUNCS_AFTER="$(val "$DB" '' '' "$FP_FUNCS_EXCL_SQL")"
if [[ "$FUNCS_EXCL_BEFORE" =~ ^[0-9a-f]{32}$ ]]; then pass "[2c0] empreinte AVANT-lot des fonctions existantes valide (prise avant l'application du lot)"; else fail "[2c0] empreinte avant-lot invalide : « $FUNCS_EXCL_BEFORE »"; fi
expect_eq "[2c] aucune fonction existante du schéma public n'est modifiée (empreinte AVANT-lot = APRÈS-lot, hors RPC du lot)" "$FUNCS_AFTER" "$FUNCS_EXCL_BEFORE"
expect_eq "[2c1] même nombre de fonctions existantes avant/après" "$(val "$DB" '' '' "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname <> 'update_restaurant_photo_overlay'")" "$N_FUNCS_EXCL_BEFORE"
# [2c-sens] sensibilité : le contrôle DOIT détecter une modification. Dans une transaction annulée d'office (RAISE), on altère le corps
# d'une fonction existante puis on recalcule l'empreinte : elle doit différer de l'empreinte avant-lot.
SENS_OUT="$(run "$DB" '' '' "do \$\$ declare d text; fp text; begin
  d := pg_get_functiondef('public.assert_restaurant_asset_role(uuid)'::regprocedure);
  execute replace(d, 'AS \$function\$', 'AS \$function\$ /*sens*/');
  select md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.oid::regprocedure::text)) into fp from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname <> 'update_restaurant_photo_overlay';
  raise exception 'SENSFP=%', fp; end \$\$;" | tr -d ' ' | grep -o 'SENSFP=[0-9a-f]*' | head -1)"
SENS_FP="${SENS_OUT#SENSFP=}"
if [ -n "$SENS_FP" ] && [ "$SENS_FP" != "$FUNCS_EXCL_BEFORE" ]; then pass "[2c-sens] l'empreinte DÉTECTE une fonction existante modifiée (contrôle non tautologique)"; else fail "[2c-sens] l'empreinte n'a pas détecté la modification simulée (sens=« $SENS_FP »)"; fi
expect_eq "[2c-sens2] la modification simulée a été annulée (empreinte inchangée après)" "$(val "$DB" '' '' "$FP_FUNCS_EXCL_SQL")" "$FUNCS_EXCL_BEFORE"
expect_eq "[2d] seule la colonne du lot est ajoutée à restaurant_configs" "$(val "$DB" '' '' "select count(*) from information_schema.columns where table_schema='public' and table_name='restaurant_configs'")" "$(val ovl_theme_first '' '' "select count(*)+1 from information_schema.columns where table_schema='public' and table_name='restaurant_configs'")"
expect_eq "[2e] les policies RLS de restaurant_configs sont inchangées" "$(val "$DB" '' '' "select md5(string_agg(policyname||cmd||coalesce(qual,'')||coalesce(with_check,''), '|' order by policyname)) from pg_policies where tablename='restaurant_configs'")" "$POL_BEFORE"
expect_eq "[2f] l'ACL de TABLE de restaurant_configs est inchangée (aucun GRANT ajouté)" "$(val "$DB" '' '' "select coalesce(relacl::text,'') from pg_class where oid='public.restaurant_configs'::regclass")" "$TBL_ACL_BEFORE"
for r in anon authenticated service_role; do
  for p in SELECT INSERT UPDATE; do
    A="$(val "$DB" '' '' "select has_column_privilege('$r','public.restaurant_configs','storefront_photo_overlay','$p')")"
    B="$(val "$DB" '' '' "select has_column_privilege('$r','public.restaurant_configs','bg_color','$p')")"
    expect_eq "[2g] privilège $p de $r sur la nouvelle colonne = celui de bg_color ($B)" "$A" "$B"
  done
done

# ---------------- [3] nouveau marchand (VRAI create_establishment) = none ----------------
OUT="$(run "$DB" '' '' "set test.uid = '$OPERATOR'; set role authenticated; select restaurant_id from public.create_establishment('Nouveau','ovl-nouveau','FR','Paris','cheese_shop',null,null,'+33600000098','fr',array['fr'],'EUR',null,'new@ovl.test',null);")"
RID_N="$(printf '%s' "$OUT" | grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
if [ -n "$RID_N" ]; then
  expect_eq "[3a] un établissement créé APRÈS le lot par le vrai create_establishment reçoit 'none'" "$(val "$DB" '' '' "select storefront_photo_overlay from public.restaurant_configs where restaurant_id='$RID_N'")" "none"
else fail "[3a] create_establishment après le lot : $OUT"; fi
expect_eq "[3b] l'établissement historique (créé avant) reste 'standard'" "$(val "$DB" '' '' "select storefront_photo_overlay from public.restaurant_configs where restaurant_id='$RID_H'")" "standard"
expect "[3c] l'INSERT direct sans la colonne (chemin des seeds) reçoit 'none'" "$(run "$DB" '' '' "insert into public.restaurants (id,slug,name,is_active,status,country) values ('e5555555-5555-4555-8555-555555555555','ovl-seed','Seed',true,'active','FR'); insert into public.restaurant_configs (restaurant_id,max_tables,currency,whatsapp_number,address) values ('e5555555-5555-4555-8555-555555555555',1,'EUR','+33600000097','x'); select storefront_photo_overlay from public.restaurant_configs where restaurant_id='e5555555-5555-4555-8555-555555555555';")" "none"

# ---------------- [4] RPC : autorité RÉELLE (assert_restaurant_asset_role) ----------------
rpc() { val "$DB" authenticated "$1" "select public.update_restaurant_photo_overlay('$2','$3')"; }
get() { val "$DB" '' '' "select storefront_photo_overlay from public.restaurant_configs where restaurant_id='$1'"; }
rpc "$OWNER_A" "$RID_A" none >/dev/null;   expect_eq "[4a] owner de A passe A à 'none'" "$(get $RID_A)" "none"
rpc "$MANAGER_A" "$RID_A" light >/dev/null; expect_eq "[4b] manager de A passe A à 'light'" "$(get $RID_A)" "light"
expect "[4c] staff de A REFUSÉ" "$(rpc "$STAFF_A" "$RID_A" none)" "Not authorized"
expect_eq "[4c'] A inchangé après le refus staff" "$(get $RID_A)" "light"
expect "[4d] owner de B ne peut PAS écrire sur A" "$(rpc "$OWNER_B" "$RID_A" none)" "Not authorized"
expect_eq "[4e] AUCUNE fuite : B reste 'standard' après les écritures sur A" "$(get $RID_B)" "standard"
rpc "$OPERATOR" "$RID_B" none >/dev/null;  expect_eq "[4f] opérateur Scanym (is_scanym_operator) peut écrire sur B" "$(get $RID_B)" "none"
expect "[4g] utilisateur authentifié SANS rattachement refusé" "$(rpc '99999999-9999-4999-8999-999999999999' "$RID_A" none)" "Not authorized"
expect "[4h] anon ne peut pas exécuter le RPC" "$(val "$DB" anon '' "select public.update_restaurant_photo_overlay('$RID_A','none')")" "permission denied"
expect "[4i] authenticated sans auth.uid() refusé (Authentication required)" "$(val "$DB" authenticated '' "select public.update_restaurant_photo_overlay('$RID_A','none')")" "Authentication required"
for bad in dark " none" None NONE "none " ""; do
  expect "[4j] valeur refusée par le RPC réel : '$bad'" "$(rpc "$OWNER_A" "$RID_A" "$bad")" "Invalid storefront photo overlay"
done
expect "[4k] NULL refusé" "$(val "$DB" authenticated "$OWNER_A" "select public.update_restaurant_photo_overlay('$RID_A', null)")" "Invalid storefront photo overlay"
expect "[4l] écriture DIRECTE d'une valeur hors jeu fermé refusée par le CHECK (service_role)" "$(val "$DB" '' '' "update public.restaurant_configs set storefront_photo_overlay='dark' where restaurant_id='$RID_A'")" "restaurant_configs_storefront_photo_overlay_check"
expect "[4m] authenticated ne peut pas écrire la colonne en DIRECT (même posture que bg_color)" "$(val "$DB" authenticated "$OWNER_A" "update public.restaurant_configs set storefront_photo_overlay='none' where restaurant_id='$RID_A'")" "permission denied"

# ---------------- [5] lecture PUBLIQUE (RLS réelle) ----------------
set_ov() { psql -X -d "$DB" -c "update public.restaurant_configs set storefront_photo_overlay='$2' where restaurant_id='$1'" >/dev/null 2>&1; }
set_ov "$RID_A" none; set_ov "$RID_B" standard
expect_eq "[5a] anon lit le réglage d'un restaurant ACTIF (même chemin que restaurant_configs(*))" "$(val "$DB" anon '' "select storefront_photo_overlay from public.restaurant_configs where restaurant_id='$RID_A'")" "none"
expect_eq "[5b] anon lit B = standard : pas de fuite entre marchands" "$(val "$DB" anon '' "select storefront_photo_overlay from public.restaurant_configs where restaurant_id='$RID_B'")" "standard"
expect_eq "[5c] anon ne voit PAS la configuration d'un restaurant inactif" "$(val "$DB" anon '' "select count(*) from public.restaurant_configs where restaurant_id='$RID_X'")" "0"
expect_eq "[5d] anon: select * ne renvoie jamais une valeur hors jeu fermé" "$(val "$DB" anon '' "select count(*) from public.restaurant_configs where storefront_photo_overlay not in ('none','light','standard')")" "0"

# ---------------- [6] donnée Au Lait Cru ----------------
psql -X -d "$DB" -c "update public.restaurant_configs set storefront_photo_overlay='standard'" >/dev/null 2>&1
if apply_file "$DB" "$DATA"; then pass "[6a] le script de donnée s'applique"; else fail "[6a] script de donnée : $(head -3 "$ERR" | tr '\n' ' ')"; fi
expect_eq "[6b] seule la ligne du slug au-lait-cru passe à 'none'" "$(val "$DB" '' '' "select string_agg(r.slug, ',' order by r.slug) from public.restaurant_configs c join public.restaurants r on r.id=c.restaurant_id where c.storefront_photo_overlay='none'")" "au-lait-cru"

# ---------------- [7] double application, dérive, atomicité ----------------
if apply_file "$DB" "$LOT"; then fail "[7a] seconde application acceptée"; else expect "[7a] seconde application REFUSÉE" "$(cat "$ERR")" "SCANYM_ALREADY_APPLIED"; fi
psql -X -d ovl_drift -c "drop function public.assert_restaurant_asset_role(uuid) cascade;" >/dev/null 2>&1
if apply_file ovl_drift "$LOT"; then fail "[7b] dérive (assert_restaurant_asset_role absente) non détectée"; else expect "[7b] dérive REFUSÉE (SCANYM_SCHEMA_DRIFT)" "$(cat "$ERR")" "SCANYM_SCHEMA_DRIFT"; fi
expect_eq "[7c] la base dérivée n'a reçu AUCUNE colonne" "$(val ovl_drift '' '' "select count(*) from information_schema.columns where table_name='restaurant_configs' and column_name='storefront_photo_overlay'")" "0"
sed "s/v_def not like '''none''%'/v_def not like '''zzz''%'/" "$SUPABASE_DIR/$LOT" > "$TMP_DIR/forced-fail.sql"
if psql -X -d ovl_atomic -v ON_ERROR_STOP=1 -f "$TMP_DIR/forced-fail.sql" >/dev/null 2>"$ERR"; then fail "[7d] post-vol forcé non déclenché"; else expect "[7d] post-vol en échec" "$(cat "$ERR")" "SCANYM_POSTFLIGHT"; fi
expect_eq "[7e] rien ne subsiste après l'échec du post-vol (colonne)" "$(val ovl_atomic '' '' "select count(*) from information_schema.columns where table_name='restaurant_configs' and column_name='storefront_photo_overlay'")" "0"
expect_eq "[7f] rien ne subsiste après l'échec du post-vol (RPC)" "$(val ovl_atomic '' '' "select to_regprocedure('public.update_restaurant_photo_overlay(uuid,text)') is null")" "t"

# ---------------- [8] rollback : retour EXACT à l'état d'avant ----------------
apply_file ovl_rollback "$LOT" || fatal "[8] application avant rollback : $(head -3 "$ERR" | tr '\n' ' ')"
if apply_file ovl_rollback "$ROLLBACK"; then pass "[8a] le rollback s'applique sur la chaîne réelle"; else fail "[8a] rollback : $(head -3 "$ERR" | tr '\n' ' ')"; fi
expect_eq "[8b] structure de restaurant_configs identique à l'avant-lot" "$(val ovl_rollback '' '' "$FP_COLS_SQL")" "$COLS_BEFORE"
expect_eq "[8c] fonctions du schéma public identiques à l'avant-lot" "$(val ovl_rollback '' '' "$FP_FUNCS_SQL")" "$FUNCS_BEFORE"
expect_eq "[8d] lignes de configuration identiques à l'avant-lot" "$(val ovl_rollback '' '' "$FP_ROWS_SQL")" "$ROWS_BEFORE"
if apply_file ovl_rollback "$LOT"; then pass "[8e] le lot se réapplique après rollback"; else fail "[8e] réapplication : $(head -3 "$ERR" | tr '\n' ' ')"; fi

# ---------------- [9] coexistence avec THEME & CONTENT SETTINGS v1 (autre DRAFT sur restaurant_configs) ----------------
if apply_file ovl_theme_first "$THEME" && apply_file ovl_theme_first "$LOT"; then pass "[9a] THEME v1 puis ce lot : les deux s'appliquent"; else fail "[9a] theme puis lot : $(head -3 "$ERR" | tr '\n' ' ')"; fi
expect_eq "[9b] les deux colonnes coexistent" "$(val ovl_theme_first '' '' "select count(*) from information_schema.columns where table_name='restaurant_configs' and column_name in ('theme_tokens','storefront_photo_overlay')")" "2"
createdb -T ovl_atomic ovl_lot_then_theme 2>/dev/null
if apply_file ovl_lot_then_theme "$LOT" && apply_file ovl_lot_then_theme "$THEME"; then pass "[9c] ce lot puis THEME v1 : les deux s'appliquent (ordre indifférent)"; else fail "[9c] lot puis theme : $(head -3 "$ERR" | tr '\n' ' ')"; fi

log "=== BILAN : $PASS_COUNT PASS, $FAIL_COUNT FAIL ==="
[ "$FAIL_COUNT" = "0" ] && exit 0 || exit 1
