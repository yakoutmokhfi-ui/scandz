#!/usr/bin/env bash
# ============================================================
# Scanym — THEME & CONTENT SETTINGS v1
# Harnais PostgreSQL JETABLE pour
#   supabase/DRAFT-lot-theme-content-settings-v1.sql
#   supabase/DRAFT-lot-theme-content-settings-v1-rollback.sql
#
# Même patron que merchant-customer-communications-v1-check.sh : cluster
# CRÉÉ par le harnais (socket privée, aucun TCP), rôles anon/authenticated/
# service_role recréés, auth.uid() simulé via `test.uid`, aucune donnée
# réelle, aucun réseau. La CHAÎNE PRÉDÉCESSEUR (jusqu'à MCC v1 inclus) est
# lue DANS le harnais MCC — une seule source, jamais recopiée.
#
# Usage : (utilisateur NON root)
#   SCANYM_DISPOSABLE_CLUSTER=1 bash supabase/tests/theme-content-settings-v1-check.sh
# Sortie : 0 = toutes les preuves produites ; 1 = au moins un échec.
# ============================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MCC_HARNESS="$SCRIPT_DIR/merchant-customer-communications-v1-check.sh"
TMP_DIR="$(mktemp -d)"
ERR="$TMP_DIR/err.txt"
PASS_COUNT=0
FAIL_COUNT=0
CLUSTER_STARTED=0

log()  { printf '[%s] %s\n' "$(date -u '+%H:%M:%S')" "$*"; }
pass() { PASS_COUNT=$((PASS_COUNT + 1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); log "FAIL: $*"; }
fatal() { log "FATAL: $*"; log "=== BILAN : preuve IMPOSSIBLE à produire -- échec fermé ==="; cleanup; exit 1; }

cleanup() {
  if [ "$CLUSTER_STARTED" = "1" ]; then
    "$PG_CTL" -D "$TMP_DIR/cluster" -m immediate stop >/dev/null 2>&1
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# --- Sûreté : consentement explicite, aucune cible héritée ------------
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
"$PG_CTL" -D "$TMP_DIR/cluster" -l "$TMP_DIR/pg.log" -o "-p $PORT -k $TMP_DIR/sock -c listen_addresses=''" start >/dev/null 2>&1 \
  || fatal "démarrage du cluster jetable impossible."
CLUSTER_STARTED=1
# La chaîne prédécesseur exige le propriétaire « postgres » (SCANYM_SCHEMA_DRIFT sinon).
export PGHOST="$TMP_DIR/sock" PGPORT="$PORT" PGDATABASE=postgres PGUSER=postgres PGCONNECT_TIMEOUT=5
DATA_DIR="$(psql -X -A -q -t -c "select current_setting('data_directory');" | tr -d ' ')"
[ "$DATA_DIR" = "$TMP_DIR/cluster" ] || fatal "le serveur joint n'est pas le cluster jetable créé ici (data_directory=$DATA_DIR)."
log "[sûreté] cluster jetable créé par ce harnais, prouvé par data_directory."

# --- Chaîne prédécesseur : lue dans le harnais MCC --------------------
chain() { grep -m1 "^$1=\"" "$MCC_HARNESS" | sed -E "s/^$1=\"(.*)\"\$/\1/"; }
MINIMAL_CHAIN="$(chain MINIMAL_CHAIN)"; REST_CHAIN="$(chain REST_CHAIN)"
CGV_AFTER_N1A_CHAIN="$(chain CGV_AFTER_N1A_CHAIN)"; TRACKING_TAIL="$(chain TRACKING_TAIL)"
MCC_TAIL="$(chain MCC_TAIL)"
for n in MINIMAL_CHAIN REST_CHAIN CGV_AFTER_N1A_CHAIN TRACKING_TAIL MCC_TAIL; do
  [ -n "${!n}" ] || fatal "variable de chaîne $n introuvable dans le harnais MCC."
done
for f in $MINIMAL_CHAIN $REST_CHAIN $CGV_AFTER_N1A_CHAIN $TRACKING_TAIL $MCC_TAIL \
         DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql \
         DRAFT-lot-order-received-enqueue-recovery-v1.sql migration-20260919000000-order-success-boundary-v1.sql \
         DRAFT-lot-merchant-customer-communications-v1.sql \
         DRAFT-lot-theme-content-settings-v1.sql DRAFT-lot-theme-content-settings-v1-rollback.sql; do
  [ -f "$SUPABASE_DIR/$f" ] || fatal "fichier de chaîne absent : supabase/$f"
done

RID_A='a1111111-1111-4111-8111-111111111111'
RID_B='b2222222-2222-4222-8222-222222222222'
OWNER_A='51111111-1111-4111-8111-11111111000a'
MANAGER_A='51111111-1111-4111-8111-1111111100aa'
STAFF_A='51111111-1111-4111-8111-11111111005a'
OWNER_B='52222222-2222-4222-8222-22222222000b'
DB="theme_base"

apply_file() { psql -X -d "$1" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$2" >/dev/null 2>"$ERR"; }
run() { # db role uid query -> valeur ou <SQL_ERROR: ...>
  local db="$1" role="$2" uid="$3" q="$4" out
  if [ -n "$role" ] && [ -n "$uid" ]; then
    out="$(PGOPTIONS="-c role=$role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$db" -c "set test.uid = '$uid';" -c "$q" 2>"$ERR")"
  elif [ -n "$role" ]; then
    out="$(PGOPTIONS="-c role=$role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$db" -c "$q" 2>"$ERR")"
  else
    out="$(psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$db" -c "$q" 2>"$ERR")"
  fi
  if [ $? -ne 0 ]; then printf '<SQL_ERROR: %s>\n' "$(tr '\n\r' '  ' < "$ERR" | cut -c1-200)"; return 0; fi
  printf '%s\n' "$out"
}
val() { run "$@" | tail -1 | tr -d ' '; }
raw() { run "$@" | tail -1; }
expect() { # description actual expected-substring
  case "$2" in *"$3"*) pass "$1";; *) fail "$1 -- attendu « $3 », obtenu « $2 »";; esac
}
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
alter role service_role bypassrls;
alter role anon nobypassrls;
alter role authenticated nobypassrls;
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
log "chaîne prédécesseur + MCC v1 appliquée."

psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<SQL || fatal "fixtures : $(tr '\n' ' ' < "$ERR")"
insert into auth.users (id, email) values
  ('$OWNER_A','owner-a@theme.test'), ('$MANAGER_A','manager-a@theme.test'),
  ('$STAFF_A','staff-a@theme.test'), ('$OWNER_B','owner-b@theme.test');
insert into public.restaurants (id, slug, name, is_active, status, country) values
  ('$RID_A','theme-alpha','Epicerie Alpha',true,'active','FR'),
  ('$RID_B','theme-beta','Primeur Beta',true,'active','FR');
insert into public.restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number, address, public_email, public_phone)
values ('$RID_A', 5, 'EUR', '+33600000001', '3 place du Marche, 75011 Paris', 'a@theme.test', '+33123456789'),
       ('$RID_B', 5, 'EUR', '+33600000002', '9 rue Beta, 75012 Paris', 'b@theme.test', '+33123456790');
insert into public.restaurant_users (restaurant_id, user_id, role) values
  ('$RID_A','$OWNER_A','owner'), ('$RID_A','$MANAGER_A','manager'),
  ('$RID_A','$STAFF_A','staff'), ('$RID_B','$OWNER_B','owner');
SQL
# Données HISTORIQUES posées avant le lot : un texte MCC existant.
psql -X -d "$DB" -c "select public.set_merchant_communication_text('$RID_A'::uuid,'checkout_info','Info historique');" >/dev/null 2>&1 \
  || psql -X -d "$DB" -c "insert into public.merchant_communication_text(restaurant_id,text_key,body) values ('$RID_A','checkout_info','Info historique');" >/dev/null 2>"$ERR" || fatal "fixture MCC"

# Clone AVANT application, pour l'anti-dérive et la double application.
psql -X -d postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$DB' and pid<>pg_backend_pid();" >/dev/null 2>&1
createdb -T "$DB" theme_drift || fatal "clone drift"
createdb -T "$DB" theme_atomic || fatal "clone atomic"

MCC_ROWS_BEFORE="$(val "$DB" '' '' "select count(*) from public.merchant_communication_text;")"
CFG_ROWS_BEFORE="$(val "$DB" '' '' "select count(*) from public.restaurant_configs;")"

# ---------------- [1] application ----------------
if apply_file "$DB" DRAFT-lot-theme-content-settings-v1.sql; then pass "[1] le SQL aller s'applique sur MCC v1 réel"; else fail "[1] aller : $(head -3 "$ERR" | tr '\n' ' ')"; fi

# ---------------- [2] anti-dérive / double application ----------------
if apply_file "$DB" DRAFT-lot-theme-content-settings-v1.sql; then fail "[2a] seconde application acceptée"; else expect "[2a] seconde application REFUSÉE (SCANYM_ALREADY_APPLIED)" "$(cat "$ERR")" "SCANYM_ALREADY_APPLIED"; fi
psql -X -d theme_drift -c "create or replace function public.communication_text_max_length(p_text_key text) returns integer language sql immutable set search_path='' as \$\$ select 400 \$\$;" >/dev/null 2>&1
if apply_file theme_drift DRAFT-lot-theme-content-settings-v1.sql; then fail "[2b] dérive MCC (bornes) non détectée"; else expect "[2b] dérive MCC REFUSÉE (SCANYM_SCHEMA_DRIFT)" "$(cat "$ERR")" "SCANYM_SCHEMA_DRIFT"; fi
expect_eq "[2c] la base dérivée n'a reçu AUCUNE colonne (annulé en bloc)" "$(val theme_drift '' '' "select count(*) from information_schema.columns where table_name='restaurant_configs' and column_name='theme_tokens';")" "0"

# ---------------- [3] atomicité : un post-vol qui échoue empêche le commit ----------------
sed "s/pg_catalog.cardinality(public.communication_text_keys()) <> 17/pg_catalog.cardinality(public.communication_text_keys()) <> 99/" \
  "$SUPABASE_DIR/DRAFT-lot-theme-content-settings-v1.sql" > "$TMP_DIR/forced-fail.sql"
if psql -X -d theme_atomic -v ON_ERROR_STOP=1 -f "$TMP_DIR/forced-fail.sql" >/dev/null 2>"$ERR"; then fail "[3a] post-vol forcé non déclenché"; else expect "[3a] post-vol en échec" "$(cat "$ERR")" "SCANYM_POSTCHECK"; fi
expect_eq "[3b] rien ne subsiste (colonne)" "$(val theme_atomic '' '' "select count(*) from information_schema.columns where table_name='restaurant_configs' and column_name='theme_tokens';")" "0"
expect_eq "[3c] rien ne subsiste (catalogue MCC toujours à 14)" "$(val theme_atomic '' '' "select cardinality(public.communication_text_keys());")" "14"

# ---------------- [4] défaut : aucune donnée touchée ----------------
expect_eq "[4a] toutes les lignes restaurant_configs à theme_tokens NULL" "$(val "$DB" '' '' "select count(*) from public.restaurant_configs where theme_tokens is not null;")" "0"
expect_eq "[4b] lignes restaurant_configs inchangées en nombre" "$(val "$DB" '' '' "select count(*) from public.restaurant_configs;")" "$CFG_ROWS_BEFORE"
expect_eq "[4c] textes MCC historiques intacts" "$(val "$DB" '' '' "select count(*) from public.merchant_communication_text;")" "$MCC_ROWS_BEFORE"
expect_eq "[4d] texte historique inchangé" "$(val "$DB" '' '' "select body from public.merchant_communication_text where restaurant_id='$RID_A' and text_key='checkout_info';")" "Infohistorique"

# ---------------- [5] écriture légitime + normalisation ----------------
OK_PAYLOAD="'{\"info_panel_bg\":\"#ffffff\",\"info_panel_text\":\"#000000\",\"popup_bg\":\"#FFFFFF\",\"popup_text\":\"#000000\",\"delivery_card_bg\":\"#ffffff\",\"delivery_card_text\":\"#111111\",\"surface_border\":\"#d4af37\"}'::jsonb"
expect_eq "[5a] owner A écrit sa configuration" "$(val "$DB" authenticated "$OWNER_A" "select public.update_restaurant_theme_tokens('$RID_A'::uuid, $OK_PAYLOAD);" | sed 's/^$/OK/')" "OK"
expect_eq "[5b] valeurs normalisées en MAJUSCULES" "$(val "$DB" '' '' "select (theme_tokens->>'info_panel_bg') || (theme_tokens->>'surface_border') from public.restaurant_configs where restaurant_id='$RID_A';")" "#FFFFFF#D4AF37"
expect_eq "[5c] manager A peut écrire" "$(val "$DB" authenticated "$MANAGER_A" "select public.update_restaurant_theme_tokens('$RID_A'::uuid, '{\"popup_bg\":\"#FFFFFF\",\"popup_text\":\"#000000\"}'::jsonb);" | sed 's/^$/OK/')" "OK"
expect_eq "[5d] le remplacement est TOTAL (autres clés retirées)" "$(val "$DB" '' '' "select (select count(*) from jsonb_object_keys(theme_tokens)) from public.restaurant_configs where restaurant_id='$RID_A';")" "2"

# ---------------- [6] isolation multi-locataires ----------------
expect_eq "[6a] la configuration de A n'a PAS touché B" "$(val "$DB" '' '' "select coalesce(theme_tokens::text,'NULL') from public.restaurant_configs where restaurant_id='$RID_B';")" "NULL"
expect "[6b] owner B ne peut pas écrire sur A (Forbidden)" "$(val "$DB" authenticated "$OWNER_B" "select public.update_restaurant_theme_tokens('$RID_A'::uuid, '{}'::jsonb);")" "SQL_ERROR"
expect "[6c] staff A ne peut pas écrire" "$(val "$DB" authenticated "$STAFF_A" "select public.update_restaurant_theme_tokens('$RID_A'::uuid, '{}'::jsonb);")" "SQL_ERROR"
expect "[6d] anon ne peut pas exécuter le RPC" "$(val "$DB" anon '' "select public.update_restaurant_theme_tokens('$RID_A'::uuid, '{}'::jsonb);")" "permissiondenied"
expect_eq "[6e] la configuration de A est intacte après ces refus" "$(val "$DB" '' '' "select theme_tokens->>'popup_bg' from public.restaurant_configs where restaurant_id='$RID_A';")" "#FFFFFF"
expect "[6f] écriture directe refusée à authenticated" "$(val "$DB" authenticated "$OWNER_A" "update public.restaurant_configs set theme_tokens='{}'::jsonb where restaurant_id='$RID_A';")" "permissiondenied"
expect "[6g] écriture directe refusée à anon" "$(val "$DB" anon '' "update public.restaurant_configs set theme_tokens='{}'::jsonb where restaurant_id='$RID_A';")" "permissiondenied"
expect_eq "[6h] lecture : une ligne par restaurant, jamais la configuration de A dans B" "$(val "$DB" '' '' "select count(*) from public.restaurant_configs where theme_tokens is not null and restaurant_id='$RID_B';")" "0"

# ---------------- [7] valeurs invalides REFUSÉES ----------------
bad() { # description payload expected-code
  expect "[7] $1" "$(val "$DB" authenticated "$OWNER_A" "select public.update_restaurant_theme_tokens('$RID_A'::uuid, '$2'::jsonb);")" "$3"
}
bad "couleur invalide (nom CSS)" '{"surface_border":"red"}' "INVALID_COLOR"
bad "couleur invalide (forme courte)" '{"surface_border":"#FFF"}' "INVALID_COLOR"
bad "couleur invalide (url())" '{"popup_bg":"url(javascript:alert(1))","popup_text":"#000000"}' "INVALID_COLOR"
bad "couleur invalide (rgb())" '{"surface_border":"rgb(0,0,0)"}' "INVALID_COLOR"
bad "couleur invalide (injection </style>)" '{"surface_border":"#000000;}</style><script>"}' "INVALID_COLOR"
bad "valeur non chaîne" '{"surface_border":12}' "INVALID_COLOR"
bad "clé inconnue (css)" '{"css":"#000000"}' "UNKNOWN_KEY"
bad "clé inconnue (script)" '{"script":"alert(1)"}' "UNKNOWN_KEY"
bad "paire incomplète (fond seul)" '{"popup_bg":"#FFFFFF"}' "PAIR_INCOMPLETE"
bad "paire incomplète (texte seul)" '{"popup_text":"#000000"}' "PAIR_INCOMPLETE"
bad "contraste insuffisant" '{"popup_bg":"#FFFFFF","popup_text":"#EEEEEE"}' "LOW_CONTRAST"
bad "non-objet (tableau)" '[]' "NOT_AN_OBJECT"
bad "non-objet (chaîne)" '"#FFFFFF"' "NOT_AN_OBJECT"
expect_eq "[7z] aucune de ces tentatives n'a modifié la configuration" "$(val "$DB" '' '' "select count(*) from jsonb_object_keys((select theme_tokens from public.restaurant_configs where restaurant_id='$RID_A'));")" "2"

# ---------------- [8] CHECK de colonne : même service_role ----------------
expect "[8a] aucun écrivain (même superutilisateur) ne peut stocker un jeton hors catalogue" "$(val "$DB" '' '' "update public.restaurant_configs set theme_tokens='{\"css\":\"#000000\"}'::jsonb where restaurant_id='$RID_A';")" "restaurant_configs_theme_tokens_valid"
expect "[8b] aucun écrivain ne peut stocker un contraste insuffisant" "$(val "$DB" '' '' "update public.restaurant_configs set theme_tokens='{\"popup_bg\":\"#FFFFFF\",\"popup_text\":\"#EEEEEE\"}'::jsonb where restaurant_id='$RID_A';")" "restaurant_configs_theme_tokens_valid"
expect "[8c] aucun écrivain ne peut stocker une minuscule" "$(val "$DB" '' '' "update public.restaurant_configs set theme_tokens='{\"surface_border\":\"#abcdef\"}'::jsonb where restaurant_id='$RID_A';")" "restaurant_configs_theme_tokens_valid"

# ---------------- [9] réinitialisation ----------------
expect_eq "[9a] {} remet la colonne à NULL" "$(val "$DB" authenticated "$OWNER_A" "select public.update_restaurant_theme_tokens('$RID_A'::uuid, '{}'::jsonb);" | sed 's/^$/OK/')" "OK"
expect_eq "[9b] colonne NULL" "$(val "$DB" '' '' "select coalesce(theme_tokens::text,'NULL') from public.restaurant_configs where restaurant_id='$RID_A';")" "NULL"
val "$DB" authenticated "$OWNER_A" "select public.update_restaurant_theme_tokens('$RID_A'::uuid, '{\"surface_border\":\"#112233\"}'::jsonb);" >/dev/null
expect_eq "[9c] valeurs vides retirées (chaîne vide / null JSON) => NULL" "$(val "$DB" authenticated "$OWNER_A" "select public.update_restaurant_theme_tokens('$RID_A'::uuid, '{\"surface_border\":\"\",\"popup_bg\":null,\"popup_text\":\"\"}'::jsonb);" | sed 's/^$/OK/')" "OK"
expect_eq "[9d] colonne NULL après remise à vide" "$(val "$DB" '' '' "select coalesce(theme_tokens::text,'NULL') from public.restaurant_configs where restaurant_id='$RID_A';")" "NULL"
expect_eq "[9e] NULL SQL remet aussi à NULL" "$(val "$DB" authenticated "$OWNER_A" "select public.update_restaurant_theme_tokens('$RID_A'::uuid, null);" | sed 's/^$/OK/')" "OK"

# ---------------- [10] MCC étendu : bornes, isolation, projection ----------------
expect_eq "[10a] catalogue 17" "$(val "$DB" '' '' "select cardinality(public.communication_text_keys());")" "17"
expect_eq "[10b] projection publique 14" "$(val "$DB" '' '' "select cardinality(public.public_communication_text_keys());")" "14"
L60="$(printf 'a%.0s' $(seq 1 60))"; L61="$(printf 'a%.0s' $(seq 1 61))"
L120="$(printf 'b%.0s' $(seq 1 120))"; L121="$(printf 'b%.0s' $(seq 1 121))"
L500="$(printf 'c%.0s' $(seq 1 500))"; L501="$(printf 'c%.0s' $(seq 1 501))"
setmcc() { val "$DB" authenticated "$OWNER_A" "select public.set_merchant_communication_text('$RID_A'::uuid, '$1', '$2');"; }
expect_eq "[10c] libellé de 60 caractères accepté" "$(setmcc order_help_button_label "$L60" | sed 's/^$/OK/')" "OK"
expect "[10d] libellé de 61 caractères refusé (22001)" "$(setmcc order_help_button_label "$L61")" "SCANYM_COMMUNICATION_TEXT_TOO_LONG"
expect_eq "[10e] titre de 120 accepté" "$(setmcc order_help_title "$L120" | sed 's/^$/OK/')" "OK"
expect "[10f] titre de 121 refusé" "$(setmcc order_help_title "$L121")" "SCANYM_COMMUNICATION_TEXT_TOO_LONG"
expect_eq "[10g] corps de 500 accepté" "$(setmcc order_help_body "$L500" | sed 's/^$/OK/')" "OK"
expect "[10h] corps de 501 refusé" "$(setmcc order_help_body "$L501")" "SCANYM_COMMUNICATION_TEXT_TOO_LONG"
expect "[10i] emplacement inconnu toujours refusé" "$(setmcc order_help_pirate "x")" "SCANYM_COMMUNICATION_UNKNOWN_TEXT_KEY"
expect "[10j] variable inconnue toujours refusée dans le nouveau corps" "$(setmcc order_help_body 'Bonjour {pirate}')" "SCANYM_COMMUNICATION_UNKNOWN_VARIABLE"
expect_eq "[10k] la projection publique de A porte les 3 emplacements d'aide" "$(val "$DB" anon '' "select count(*) from public.get_restaurant_public_communication_texts('$RID_A'::uuid) where text_key like 'order_help_%';")" "3"
expect_eq "[10l] la projection publique de B n'en porte AUCUN (isolation)" "$(val "$DB" anon '' "select count(*) from public.get_restaurant_public_communication_texts('$RID_B'::uuid) where text_key like 'order_help_%';")" "0"
expect_eq "[10m] aucun gabarit d'e-mail dans la projection publique" "$(val "$DB" anon '' "select count(*) from public.get_restaurant_public_communication_texts('$RID_A'::uuid) where text_key in ('email_confirmation_subject','email_confirmation_body','confirmation_withdrawal_request');")" "0"
expect_eq "[10n] owner B ne lit pas les textes d'aide de A" "$(val "$DB" authenticated "$OWNER_B" "select count(*) from public.merchant_communication_text where restaurant_id='$RID_A';")" "0"
expect_eq "[10o] corps vide => la ligne est supprimée (repli = bouton absent)" "$(setmcc order_help_body '' | sed 's/^$/OK/')" "OK"
expect_eq "[10p] ligne supprimée" "$(val "$DB" '' '' "select count(*) from public.merchant_communication_text where restaurant_id='$RID_A' and text_key='order_help_body';")" "0"
# Contenu hostile : stocké comme TEXTE inerte (le rendu l'échappe, voir tests DOM).
HOSTILE='<script>alert(1)</script><img src=x onerror=alert(1)>'
expect_eq "[10q] contenu HTML hostile accepté comme texte brut (borné) ou refusé, jamais interprété" "$(val "$DB" authenticated "$OWNER_A" "select public.set_merchant_communication_text('$RID_A'::uuid, 'order_help_body', '$HOSTILE');" | sed 's/^$/OK/')" "OK"
expect_eq "[10r] stocké tel quel (texte)" "$(raw "$DB" '' '' "select body from public.merchant_communication_text where restaurant_id='$RID_A' and text_key='order_help_body';")" "$HOSTILE"

# ---------------- [11] le CHECK de clé MCC suit le catalogue étendu ----------------
expect "[11] aucun écrivain ne peut insérer un emplacement hors catalogue" "$(val "$DB" '' '' "insert into public.merchant_communication_text(restaurant_id,text_key,body) values ('$RID_A','order_help_pirate','x');")" "merchant_communication_text_key_check"

# ---------------- [13] MIROIR TS <-> SQL du contraste (exécuté, pas déclaré) ----------------
command -v node >/dev/null 2>&1 || fatal "node introuvable (preuve de miroir TS/SQL)."
( cd "$SUPABASE_DIR/.." && node --experimental-strip-types --import ./tests/register.mjs supabase/tests/theme-tokens-mirror-cases.mjs ) > "$TMP_DIR/mirror.csv" 2>"$ERR" \
  || fatal "génération des cas de miroir : $(head -3 "$ERR" | tr '\n' ' ')"
N_CASES="$(wc -l < "$TMP_DIR/mirror.csv" | tr -d ' ')"
psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<SQL || fatal "table de miroir : $(head -3 "$ERR" | tr '\n' ' ')"
create table public.zz_mirror (bg text, tx text, ts_ok boolean, ts_ratio double precision);
\copy public.zz_mirror from '$TMP_DIR/mirror.csv' with (format csv)
SQL
expect_eq "[13a] nombre de cas de miroir chargés" "$(val "$DB" '' '' "select count(*) from public.zz_mirror;")" "$N_CASES"
expect_eq "[13b] décision d'acceptation SQL == TS sur tous les cas" "$(val "$DB" '' '' "select count(*) from public.zz_mirror where public.theme_tokens_valid(jsonb_build_object('popup_bg',bg,'popup_text',tx)) <> ts_ok;")" "0"
expect_eq "[13c] ratio SQL == ratio TS (écart < 1e-9) sur tous les cas" "$(val "$DB" '' '' "select count(*) from public.zz_mirror where abs(public.theme_token_contrast(bg,tx) - ts_ratio) > 1e-9;")" "0"
expect "[13d] le jeu couvre les deux issues (acceptés ET refusés)" "$(val "$DB" '' '' "select (count(*) filter (where ts_ok))>100 and (count(*) filter (where not ts_ok))>100 from public.zz_mirror;")" "t"
psql -X -d "$DB" -c "drop table public.zz_mirror;" >/dev/null 2>&1

# ---------------- [12] rollback ----------------
RB="theme_rb"
psql -X -d postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$DB' and pid<>pg_backend_pid();" >/dev/null 2>&1
createdb -T "$DB" "$RB" || fatal "clone rollback"
if apply_file "$RB" DRAFT-lot-theme-content-settings-v1-rollback.sql; then fail "[12a] rollback accepté alors que des textes order_help_* existent"; else expect "[12a] rollback REFUSÉ tant que des emplacements ajoutés portent des données (SCANYM_ROLLBACK_BLOCKED)" "$(cat "$ERR")" "SCANYM_ROLLBACK_BLOCKED"; fi
expect_eq "[12b] refus sans effet : colonne toujours présente" "$(val "$RB" '' '' "select count(*) from information_schema.columns where table_name='restaurant_configs' and column_name='theme_tokens';")" "1"
psql -X -d "$RB" -c "delete from public.merchant_communication_text where text_key like 'order_help_%';" >/dev/null 2>&1
if apply_file "$RB" DRAFT-lot-theme-content-settings-v1-rollback.sql; then pass "[12c] rollback s'applique une fois les textes ajoutés retirés"; else fail "[12c] rollback : $(head -3 "$ERR" | tr '\n' ' ')"; fi
expect_eq "[12d] colonne supprimée" "$(val "$RB" '' '' "select count(*) from information_schema.columns where table_name='restaurant_configs' and column_name='theme_tokens';")" "0"
expect_eq "[12e] catalogue MCC revenu à 14/11" "$(val "$RB" '' '' "select cardinality(public.communication_text_keys())||'/'||cardinality(public.public_communication_text_keys());")" "14/11"
expect_eq "[12f] bornes MCC revenues (titre d'aide: 500)" "$(val "$RB" '' '' "select public.communication_text_max_length('order_help_title');")" "500"
expect_eq "[12g] texte historique MCC préservé par le rollback" "$(val "$RB" '' '' "select body from public.merchant_communication_text where restaurant_id='$RID_A' and text_key='checkout_info';")" "Infohistorique"
expect_eq "[12h] fonctions du lot supprimées" "$(val "$RB" '' '' "select count(*) from pg_proc where proname in ('theme_token_keys','theme_token_luminance','theme_token_contrast','theme_tokens_valid','update_restaurant_theme_tokens');")" "0"
expect_eq "[12i] lignes restaurant_configs conservées" "$(val "$RB" '' '' "select count(*) from public.restaurant_configs;")" "$CFG_ROWS_BEFORE"
# Aller APRÈS rollback : réversible.
if apply_file "$RB" DRAFT-lot-theme-content-settings-v1.sql; then pass "[12j] le lot se réapplique après rollback"; else fail "[12j] réapplication : $(head -3 "$ERR" | tr '\n' ' ')"; fi

log "=== BILAN : $PASS_COUNT preuves OK, $FAIL_COUNT échec(s) ==="
[ "$FAIL_COUNT" -eq 0 ]
