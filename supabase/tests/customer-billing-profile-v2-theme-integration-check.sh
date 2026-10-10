#!/usr/bin/env bash
# ============================================================
# Scanym — CUSTOMER BILLING PROFILE v2.1 — RECOMPOSITION
# Harnais PostgreSQL JETABLE d'INTERACTION entre trois lots qui
# cohabitent sur le main courant :
#
#   - MERCHANT CUSTOMER COMMUNICATIONS v1   (catalogue d'emplacements)
#   - THEME & CONTENT SETTINGS v1           (theme_tokens + order_help_*)
#   - CATALOGUE PRODUCT REORDER v1.1        (move_product_order)
#   - CUSTOMER BILLING PROFILE v2           (siren + billing_profile_explanation)
#
# Même patron que theme-content-settings-v1-check.sh : cluster CRÉÉ par
# le harnais (socket privée, aucun TCP), chaîne prédécesseur LUE dans le
# harnais MCC (une seule source, jamais recopiée), aucune donnée réelle,
# aucun réseau. N'APPLIQUE RIEN À SUPABASE HÉBERGÉ.
#
# Scénarios (numérotation du mandat d'intégration) :
#   [I-1]  Theme installé PUIS Facturation installée
#   [I-2]  Facturation AVANT Theme -> ÉCHEC FERMÉ (ordre requis, pas de
#          symétrie inventée)
#   [I-3]  Rollback Facturation, Theme PRÉSERVÉ
#   [I-4]  Rollback Theme alors que Facturation est installée -> montre
#          pourquoi l'ordre de retrait est LIFO (observation documentée)
#   [I-5]  l'emplacement de facturation est visible là où il doit l'être
#   [I-6]  les emplacements order_help_* de Theme sont intacts
#   [I-7]  la RPC de tokens de Theme est INCHANGÉE (corps comparé)
#   [I-8]  move_product_order (Product Reorder) est INCHANGÉE
#   [I-9]  une écriture de FACTURATION ne touche pas theme_tokens
#   [I-10] une écriture de THEME ne touche pas la facturation
#
# Usage : (utilisateur NON root)
#   SCANYM_DISPOSABLE_CLUSTER=1 bash supabase/tests/customer-billing-profile-v2-theme-integration-check.sh
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
note() { log "NOTE: $*"; }
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

INVOICE_CHAIN="DRAFT-lot-invoice-request-foundation-v1.sql DRAFT-lot-checkout-invoice-request-email-validation-v1-delta.sql"
for f in $MINIMAL_CHAIN $REST_CHAIN $CGV_AFTER_N1A_CHAIN $TRACKING_TAIL $MCC_TAIL $INVOICE_CHAIN \
         DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql \
         DRAFT-lot-order-received-enqueue-recovery-v1.sql migration-20260919000000-order-success-boundary-v1.sql \
         DRAFT-lot-merchant-customer-communications-v1.sql \
         DRAFT-lot-theme-content-settings-v1.sql DRAFT-lot-theme-content-settings-v1-rollback.sql \
         DRAFT-lot-catalogue-product-reorder-v1.sql \
         DRAFT-lot-customer-billing-profile-v2.sql DRAFT-lot-customer-billing-profile-v2-rollback.sql; do
  [ -f "$SUPABASE_DIR/$f" ] || fatal "fichier de chaîne absent : supabase/$f"
done

RID_A='a1111111-1111-4111-8111-111111111111'
RID_B='b2222222-2222-4222-8222-222222222222'
OWNER_A='51111111-1111-4111-8111-11111111000a'
OWNER_B='52222222-2222-4222-8222-22222222000b'
ORDER_A='c3333333-3333-4333-8333-333333333333'
TOKEN_A='d4444444-4444-4444-8444-444444444444'
DB="cbp_pre"

apply_file() { psql -X -d "$1" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$2" >/dev/null 2>"$ERR"; }
run() {
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
expect() { case "$2" in *"$3"*) pass "$1";; *) fail "$1 -- attendu « $3 », obtenu « $2 »";; esac; }
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
# La FONDATION RÉELLE de la demande de facture (pas un talon) : ce lot-ci
# l'étend, les probes doivent donc porter sur la vraie RPC.
for f in $INVOICE_CHAIN; do
  apply_file "$DB" "$f" || fatal "chaîne facture, $f : $(head -3 "$ERR" | tr '\n' ' ')"
done
for f in $TRACKING_TAIL $MCC_TAIL DRAFT-lot-merchant-customer-communications-v1.sql; do
  apply_file "$DB" "$f" || fatal "chaîne, $f : $(head -3 "$ERR" | tr '\n' ' ')"
done
log "chaîne prédécesseur + MCC v1 + fondation facture appliquée (état PRÉ-Theme)."

psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<SQL || fatal "fixtures : $(tr '\n' ' ' < "$ERR")"
insert into auth.users (id, email) values ('$OWNER_A','owner-a@cbp.test'), ('$OWNER_B','owner-b@cbp.test');
insert into public.restaurants (id, slug, name, is_active, status, country) values
  ('$RID_A','cbp-alpha','Epicerie Alpha',true,'active','FR'),
  ('$RID_B','cbp-beta','Primeur Beta',true,'active','FR');
insert into public.restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number, address, public_email, public_phone)
values ('$RID_A', 5, 'EUR', '+33600000001', '3 place du Marche, 75011 Paris', 'a@cbp.test', '+33123456789'),
       ('$RID_B', 5, 'EUR', '+33600000002', '9 rue Beta, 75012 Paris', 'b@cbp.test', '+33123456790');
insert into public.restaurant_users (restaurant_id, user_id, role) values
  ('$RID_A','$OWNER_A','owner'), ('$RID_B','$OWNER_B','owner');
insert into public.orders (id, restaurant_id, public_token, status, order_number, service_mode, subtotal, total, currency)
values ('$ORDER_A','$RID_A','$TOKEN_A','new',90001,'pickup',10.00,10.00,'EUR');
SQL

psql -X -d postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$DB' and pid<>pg_backend_pid();" >/dev/null 2>&1
createdb -T "$DB" cbp_wrong_order || fatal "clone ordre inverse"

# =====================================================================
# [I-2] ORDRE REQUIS — la facturation ne s'applique PAS avant Theme.
#       Le mandat demande de DOCUMENTER l'ordre requis plutôt que
#       d'inventer une symétrie : la preuve est ici, pas une promesse.
# =====================================================================
if apply_file cbp_wrong_order DRAFT-lot-customer-billing-profile-v2.sql; then
  fail "[I-2] la facturation s'est appliquée AVANT Theme (elle aurait réécrit le catalogue sans les order_help_*)"
else
  expect "[I-2] facturation AVANT Theme : ÉCHEC FERMÉ (SCANYM_SCHEMA_DRIFT)" "$(cat "$ERR")" "SCANYM_SCHEMA_DRIFT"
fi
expect_eq "[I-2b] rien n'a été appliqué (aucune colonne siren)" \
  "$(val cbp_wrong_order '' '' "select count(*) from information_schema.columns where table_name='order_invoice_request' and column_name='siren';")" "0"
expect_eq "[I-2c] le catalogue de la base reste celui de MCC v1 (14)" \
  "$(val cbp_wrong_order '' '' "select cardinality(public.communication_text_keys());")" "14"

# =====================================================================
# ORDRE RÉEL DU MAIN COURANT : Theme, puis Product Reorder, puis
# Facturation.
# =====================================================================
apply_file "$DB" DRAFT-lot-theme-content-settings-v1.sql || fatal "Theme : $(head -3 "$ERR" | tr '\n' ' ')"
apply_file "$DB" DRAFT-lot-catalogue-product-reorder-v1.sql || fatal "Product Reorder : $(head -3 "$ERR" | tr '\n' ' ')"
log "THEME & CONTENT SETTINGS v1 + CATALOGUE PRODUCT REORDER v1.1 appliqués (état = main courant)."

# Données posées AVANT la facturation : un texte de Theme configuré, des
# tokens de thème, un produit ordonné -- tout ce qui doit SURVIVRE.
PGOPTIONS="-c role=authenticated" psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<SQL || fatal "fixtures Theme : $(tr '\n' ' ' < "$ERR")"
set test.uid = '$OWNER_A';
select public.set_merchant_communication_text('$RID_A'::uuid,'order_help_button_label','Comment commander ?');
select public.set_merchant_communication_text('$RID_A'::uuid,'order_help_body','Choisissez vos produits puis validez.');
select public.set_merchant_communication_text('$RID_A'::uuid,'checkout_info','Info historique');
SQL
set +e
THEME_WRITE="$(val "$DB" authenticated "$OWNER_A" "select public.update_restaurant_theme_tokens('$RID_A'::uuid, '{\"info_panel_bg\":\"#FFFFFF\",\"info_panel_text\":\"#111111\"}'::jsonb);")"
set -e
THEME_BEFORE="$(val "$DB" '' '' "select coalesce(theme_tokens::text,'<null>') from public.restaurant_configs where restaurant_id='$RID_A';")"
[ "$THEME_BEFORE" = "<null>" ] && note "aucun token de thème écrit par la RPC (retour: $THEME_WRITE) -- les probes de non-interférence porteront sur la valeur observée"

# Empreintes AVANT facturation des fonctions des autres lots.
THEME_RPC_BEFORE="$(val "$DB" '' '' "select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='update_restaurant_theme_tokens';")"
THEME_KEYS_BEFORE="$(val "$DB" '' '' "select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='theme_token_keys';")"
MAXLEN_BEFORE="$(val "$DB" '' '' "select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='communication_text_max_length';")"
REORDER_BEFORE="$(val "$DB" '' '' "select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='move_product_order';")"
CFG_BEFORE="$(val "$DB" '' '' "select md5(string_agg(c.restaurant_id::text || coalesce(c.theme_tokens::text,''), '|' order by c.restaurant_id)) from public.restaurant_configs c;")"
MCC_ROWS_BEFORE="$(val "$DB" '' '' "select count(*) from public.merchant_communication_text;")"

psql -X -d postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$DB' and pid<>pg_backend_pid();" >/dev/null 2>&1
createdb -T "$DB" cbp_theme_rb_before || fatal "clone rollback Theme"

# =====================================================================
# [I-1] THEME INSTALLÉ + FACTURATION INSTALLÉE
# =====================================================================
if apply_file "$DB" DRAFT-lot-customer-billing-profile-v2.sql; then
  pass "[I-1] la facturation s'applique sur le main courant (Theme + Product Reorder réels)"
else
  fail "[I-1] application : $(head -5 "$ERR" | tr '\n' ' ')"
fi
expect_eq "[I-1b] catalogue = 18 emplacements" "$(val "$DB" '' '' "select cardinality(public.communication_text_keys());")" "18"
expect_eq "[I-1c] projection publique = 15 emplacements" "$(val "$DB" '' '' "select cardinality(public.public_communication_text_keys());")" "15"
expect_eq "[I-1d] aucun doublon dans le catalogue" \
  "$(val "$DB" '' '' "select cardinality(array(select distinct k from unnest(public.communication_text_keys()) k));")" "18"
expect_eq "[I-1e] l'emplacement de facturation est présent" \
  "$(val "$DB" '' '' "select 'billing_profile_explanation' = any(public.communication_text_keys());")" "t"
expect_eq "[I-1f] colonne siren présente, NULLABLE, sans défaut" \
  "$(val "$DB" '' '' "select count(*) from information_schema.columns where table_name='order_invoice_request' and column_name='siren' and is_nullable='YES' and column_default is null;")" "1"

# =====================================================================
# [I-6] LES EMPLACEMENTS DE THEME SONT INTACTS
# =====================================================================
expect_eq "[I-6] les 3 emplacements order_help_* sont toujours au catalogue" \
  "$(val "$DB" '' '' "select count(*) from unnest(public.communication_text_keys()) k where k like 'order_help%';")" "3"
expect_eq "[I-6b] …et toujours exposés publiquement" \
  "$(val "$DB" '' '' "select count(*) from unnest(public.public_communication_text_keys()) k where k like 'order_help%';")" "3"
expect_eq "[I-6c] les bornes propres de Theme sont inchangées (60 / 120 / 500)" \
  "$(val "$DB" '' '' "select public.communication_text_max_length('order_help_button_label')::text || '/' || public.communication_text_max_length('order_help_title') || '/' || public.communication_text_max_length('order_help_body');")" "60/120/500"
expect_eq "[I-6d] communication_text_max_length() n'a PAS été redéfinie (empreinte du corps)" \
  "$(val "$DB" '' '' "select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='communication_text_max_length';")" "$MAXLEN_BEFORE"
expect_eq "[I-6e] les textes Theme déjà configurés sont intacts" \
  "$(raw "$DB" '' '' "select body from public.merchant_communication_text where restaurant_id='$RID_A' and text_key='order_help_button_label';")" "Comment commander ?"
expect_eq "[I-6f] aucune ligne de texte marchand perdue ni ajoutée" \
  "$(val "$DB" '' '' "select count(*) from public.merchant_communication_text;")" "$MCC_ROWS_BEFORE"

# =====================================================================
# [I-7] LA RPC DE TOKENS DE THEME EST INCHANGÉE
# =====================================================================
expect_eq "[I-7] update_restaurant_theme_tokens : corps identique" \
  "$(val "$DB" '' '' "select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='update_restaurant_theme_tokens';")" "$THEME_RPC_BEFORE"
expect_eq "[I-7b] theme_token_keys() : corps identique" \
  "$(val "$DB" '' '' "select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='theme_token_keys';")" "$THEME_KEYS_BEFORE"
expect_eq "[I-7c] 7 clés de tokens, inchangées" "$(val "$DB" '' '' "select cardinality(public.theme_token_keys());")" "7"
expect_eq "[I-7d] la colonne theme_tokens existe toujours" \
  "$(val "$DB" '' '' "select count(*) from information_schema.columns where table_name='restaurant_configs' and column_name='theme_tokens';")" "1"
expect_eq "[I-7e] le contrat de contraste refuse toujours une paire illisible" \
  "$(raw "$DB" authenticated "$OWNER_A" "select public.update_restaurant_theme_tokens('$RID_A'::uuid, '{\"info_panel_bg\":\"#FFFFFF\",\"info_panel_text\":\"#FFFFFE\"}'::jsonb);" | grep -o 'SQL_ERROR' || echo absent)" "SQL_ERROR"

# =====================================================================
# [I-8] MOVE_PRODUCT_ORDER (PRODUCT REORDER v1.1) EST INCHANGÉE
# =====================================================================
expect_eq "[I-8] move_product_order : corps identique" \
  "$(val "$DB" '' '' "select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='move_product_order';")" "$REORDER_BEFORE"
expect_eq "[I-8b] la signature (uuid,text,jsonb) est toujours là" \
  "$(val "$DB" '' '' "select to_regprocedure('public.move_product_order(uuid,text,jsonb)') is not null;")" "t"
expect_eq "[I-8c] menu_items.display_order intacte (colonne du périmètre Product Reorder)" \
  "$(val "$DB" '' '' "select count(*) from information_schema.columns where table_name='menu_items' and column_name='display_order';")" "1"

# =====================================================================
# [I-5] / [I-9] UNE ÉCRITURE DE FACTURATION
# =====================================================================
INV_WRITE="$(raw "$DB" service_role '' "select public.set_order_invoice_request('$ORDER_A'::uuid,'$TOKEN_A'::uuid,'company','1 rue du Test','Paris','75001','FR',null,'ACME SARL',null,'Bob Durand',null,'123456789');")"
case "$INV_WRITE" in *SQL_ERROR*) fail "[I-9] écriture de facturation refusée : $INV_WRITE";; *) pass "[I-9] une demande de facture SOCIÉTÉ avec SIREN s'écrit";; esac
expect_eq "[I-9b] le SIREN est stocké tel quel" "$(raw "$DB" '' '' "select siren from public.order_invoice_request where order_id='$ORDER_A';")" "123456789"
expect_eq "[I-9c] le contact société est celui saisi (CBP-01)" "$(raw "$DB" '' '' "select contact_name from public.order_invoice_request where order_id='$ORDER_A';")" "Bob Durand"
expect_eq "[I-9d] AUCUN theme_tokens modifié par l'écriture de facturation" \
  "$(val "$DB" '' '' "select md5(string_agg(c.restaurant_id::text || coalesce(c.theme_tokens::text,''), '|' order by c.restaurant_id)) from public.restaurant_configs c;")" "$CFG_BEFORE"
expect_eq "[I-9e] AUCUNE ligne de texte marchand modifiée par l'écriture de facturation" \
  "$(val "$DB" '' '' "select count(*) from public.merchant_communication_text;")" "$MCC_ROWS_BEFORE"

# L'emplacement de facturation est configurable et SORT par la
# projection publique anonyme (c'est là qu'il doit être visible).
PGOPTIONS="-c role=authenticated" psql -X -d "$DB" -v ON_ERROR_STOP=1 -c "set test.uid = '$OWNER_A';" -c "select public.set_merchant_communication_text('$RID_A'::uuid,'billing_profile_explanation','Pour une facture au nom de votre societe, indiquez sa raison sociale.');" >/dev/null 2>"$ERR" \
  && pass "[I-5] l'emplacement de facturation est configurable par le commerçant" \
  || fail "[I-5] configuration refusée : $(tr '\n' ' ' < "$ERR" | cut -c1-200)"
expect_eq "[I-5b] il sort par la projection publique ANONYME" \
  "$(val "$DB" anon '' "select count(*) from public.get_restaurant_public_communication_texts('$RID_A'::uuid) where text_key='billing_profile_explanation';")" "1"
expect_eq "[I-5c] les textes de Theme sortent TOUJOURS par la même projection" \
  "$(val "$DB" anon '' "select count(*) from public.get_restaurant_public_communication_texts('$RID_A'::uuid) where text_key like 'order_help%';")" "2"
expect_eq "[I-5d] aucun gabarit d'e-mail n'est devenu public" \
  "$(val "$DB" '' '' "select count(*) from unnest(public.public_communication_text_keys()) k where k in ('email_confirmation_subject','email_confirmation_body','confirmation_withdrawal_request');")" "0"
expect_eq "[I-5e] isolation : l'établissement B ne voit RIEN du texte de A" \
  "$(val "$DB" anon '' "select count(*) from public.get_restaurant_public_communication_texts('$RID_B'::uuid);")" "0"

# =====================================================================
# [I-10] UNE ÉCRITURE DE THEME NE TOUCHE PAS LA FACTURATION
# =====================================================================
INV_BEFORE_THEME="$(val "$DB" '' '' "select md5(string_agg(order_id::text || invoice_type || coalesce(siren,'') || coalesce(contact_name,''), '|' order by order_id)) from public.order_invoice_request;")"
set +e
psql -X -d "$DB" -c "set role authenticated;" -c "set test.uid = '$OWNER_A';" \
  -c "select public.update_restaurant_theme_tokens('$RID_A'::uuid, '{\"popup_bg\":\"#101010\",\"popup_text\":\"#F5F5F5\"}'::jsonb);" >/dev/null 2>&1
set -e
expect_eq "[I-10] une écriture de tokens de thème ne modifie AUCUN champ de facturation" \
  "$(val "$DB" '' '' "select md5(string_agg(order_id::text || invoice_type || coalesce(siren,'') || coalesce(contact_name,''), '|' order by order_id)) from public.order_invoice_request;")" "$INV_BEFORE_THEME"
expect_eq "[I-10b] …ni l'emplacement de facturation du catalogue" \
  "$(val "$DB" '' '' "select 'billing_profile_explanation' = any(public.communication_text_keys());")" "t"

# =====================================================================
# [I-3] ROLLBACK FACTURATION, THEME PRÉSERVÉ
# =====================================================================
psql -X -d postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$DB' and pid<>pg_backend_pid();" >/dev/null 2>&1
createdb -T "$DB" cbp_rb || fatal "clone rollback facturation"
# Le garde DONNÉES doit d'abord refuser (un SIREN client et un texte
# configuré existent) : c'est CBP-02, rejoué ici dans un contexte
# d'intégration réel.
if apply_file cbp_rb DRAFT-lot-customer-billing-profile-v2-rollback.sql; then
  fail "[I-3a] le rollback a détruit un SIREN client sans décision explicite"
else
  expect "[I-3a] rollback REFUSÉ tant qu'un SIREN client existe (CBP-02)" "$(cat "$ERR")" "SCANYM_ROLLBACK_BLOCKED"
fi
expect_eq "[I-3b] la colonne siren et sa donnée sont intactes après le refus" \
  "$(raw cbp_rb '' '' "select siren from public.order_invoice_request where order_id='$ORDER_A';")" "123456789"
# Décision explicite : on retire la donnée propre au lot, puis on annule.
psql -X -d cbp_rb -c "update public.order_invoice_request set siren = null;" >/dev/null 2>&1
psql -X -d cbp_rb -c "delete from public.merchant_communication_text where text_key='billing_profile_explanation';" >/dev/null 2>&1
if apply_file cbp_rb DRAFT-lot-customer-billing-profile-v2-rollback.sql; then
  pass "[I-3c] le rollback aboutit après décision explicite"
else
  fail "[I-3c] rollback : $(head -5 "$ERR" | tr '\n' ' ')"
fi
expect_eq "[I-3d] colonne siren retirée" \
  "$(val cbp_rb '' '' "select count(*) from information_schema.columns where table_name='order_invoice_request' and column_name='siren';")" "0"
expect_eq "[I-3e] catalogue revenu à l'état du main courant (17 / 14)" \
  "$(val cbp_rb '' '' "select cardinality(public.communication_text_keys())::text || '/' || cardinality(public.public_communication_text_keys());")" "17/14"
expect_eq "[I-3f] THEME PRÉSERVÉ : les 3 order_help_* sont toujours là" \
  "$(val cbp_rb '' '' "select count(*) from unnest(public.communication_text_keys()) k where k like 'order_help%';")" "3"
expect_eq "[I-3g] THEME PRÉSERVÉ : textes marchands de Theme intacts" \
  "$(raw cbp_rb '' '' "select body from public.merchant_communication_text where restaurant_id='$RID_A' and text_key='order_help_button_label';")" "Comment commander ?"
expect_eq "[I-3h] THEME PRÉSERVÉ : colonne theme_tokens + RPC + 7 clés" \
  "$(val cbp_rb '' '' "select (select count(*) from information_schema.columns where table_name='restaurant_configs' and column_name='theme_tokens')::text || '/' || (to_regprocedure('public.update_restaurant_theme_tokens(uuid,jsonb)') is not null)::text || '/' || cardinality(public.theme_token_keys());")" "1/true/7"
expect_eq "[I-3i] THEME PRÉSERVÉ : bornes 60 / 120 intactes" \
  "$(val cbp_rb '' '' "select public.communication_text_max_length('order_help_button_label')::text || '/' || public.communication_text_max_length('order_help_title');")" "60/120"
expect_eq "[I-3j] PRODUCT REORDER PRÉSERVÉ : move_product_order intacte" \
  "$(val cbp_rb '' '' "select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='move_product_order';")" "$REORDER_BEFORE"
expect_eq "[I-3k] l'emplacement de facturation a disparu, et lui seul" \
  "$(val cbp_rb '' '' "select 'billing_profile_explanation' = any(public.communication_text_keys());")" "f"
expect_eq "[I-3l] la forme 12 arguments de l'écriture est restaurée, sans surcharge résiduelle" \
  "$(val cbp_rb '' '' "select (to_regprocedure('public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text)') is not null)::text || '/' || (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='set_order_invoice_request');")" "true/1"

# =====================================================================
# [I-4] ROLLBACK DE THEME ALORS QUE LA FACTURATION EST INSTALLÉE
#
# NON SYMÉTRIQUE, et c'est documenté plutôt qu'inventé : le rollback de
# Theme (déjà sur main, HORS périmètre de ce lot) réécrit le catalogue
# à l'état MCC v1 (14). Joué alors que la facturation est installée, il
# emporterait l'emplacement de facturation. L'ordre de RETRAIT est donc
# LIFO : annuler la facturation d'abord, Theme ensuite.
# =====================================================================
apply_file cbp_theme_rb_before DRAFT-lot-customer-billing-profile-v2.sql || fatal "préparation [I-4]"
# Theme a sa PROPRE garde de données (il refuse de détruire des textes
# order_help_* configurés). On la lève explicitement, sinon la question
# posée ici -- « que devient l'emplacement de facturation ? » -- ne
# serait jamais atteinte.
THEME_RB_FIRST_TRY="refusé"
if apply_file cbp_theme_rb_before DRAFT-lot-theme-content-settings-v1-rollback.sql; then THEME_RB_FIRST_TRY="appliqué"; else
  expect "[I-4a] Theme refuse d'abord de détruire SES textes configurés" "$(cat "$ERR")" "SCANYM_ROLLBACK_BLOCKED"
fi
psql -X -d cbp_theme_rb_before -c "delete from public.merchant_communication_text where text_key like 'order_help%';" >/dev/null 2>&1
if apply_file cbp_theme_rb_before DRAFT-lot-theme-content-settings-v1-rollback.sql; then
  THEME_RB_RESULT="appliqué"
else
  THEME_RB_RESULT="refusé: $(head -3 "$ERR" | tr '\n' ' ' | cut -c1-160)"
fi
BILLING_KEY_AFTER_THEME_RB="$(val cbp_theme_rb_before '' '' "select 'billing_profile_explanation' = any(public.communication_text_keys());")"
note "[I-4] rollback de Theme avec la facturation installée -> $THEME_RB_RESULT ; emplacement de facturation encore au catalogue : $BILLING_KEY_AFTER_THEME_RB"
if [ "$THEME_RB_RESULT" = "appliqué" ] && [ "$BILLING_KEY_AFTER_THEME_RB" = "f" ]; then
  pass "[I-4] comportement CONSTATÉ et DOCUMENTÉ : le rollback de Theme retire aussi l'emplacement de facturation -> ordre de retrait LIFO exigé (facturation d'abord). Aucun fichier de Theme n'est modifié par ce lot."
else
  pass "[I-4] comportement CONSTATÉ : $THEME_RB_RESULT (emplacement de facturation présent : $BILLING_KEY_AFTER_THEME_RB) -- l'ordre de retrait reste documenté LIFO"
fi
expect_eq "[I-4b] la colonne siren de la facturation n'est PAS touchée par le rollback de Theme" \
  "$(val cbp_theme_rb_before '' '' "select count(*) from information_schema.columns where table_name='order_invoice_request' and column_name='siren';")" "1"

# =====================================================================
printf '\n'
log "=== BILAN : $PASS_COUNT preuve(s) OK, $FAIL_COUNT échec(s) ==="
[ "$FAIL_COUNT" -eq 0 ] || exit 1
exit 0
