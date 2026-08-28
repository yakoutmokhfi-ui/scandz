#!/usr/bin/env bash
# ============================================================
# Scanym — PAYMENT P3-A0 — SECURE SERVER PAYMENT CREDENTIAL READ
# CAPABILITY — Harnais reproductible pour
# supabase/DRAFT-lot-payment-p3a0-secure-credential-read.sql.
#
# Même distinction qu'établie par le harnais P2A (voir sa bannière) :
# ce bac à sable est un PostgreSQL communautaire vanilla, PAS une
# instance Supabase managée -- un schéma `vault` MINIMAL reproduisant
# fidèlement l'identité exacte de Supabase Vault (table `vault.secrets`,
# vue `vault.decrypted_secrets` avec la colonne réelle
# `decrypted_secret`) est construit UNIQUEMENT pour les besoins de ce
# test, jamais livré, jamais appliqué ailleurs. Ceci prouve la logique
# STRUCTURELLE et COMPORTEMENTALE de la nouvelle RPC de lecture, pas le
# comportement de chiffrement réel de Supabase Vault en Production.
#
# Ce lot n'effectue AUCUNE écriture (mandat section 12) -- il n'y a
# donc AUCUN scénario de concurrence/verrouillage à prouver ici,
# contrairement au harnais P2A (qui, lui, protège deux RPC
# d'ÉCRITURE). Le périmètre de ce harnais reste délibérément plus
# étroit, à la mesure du lot qu'il vérifie.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/payment-p3a0-secure-credential-read-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_A_SQL="$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-model.sql"
DRAFT_B_SQL="$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-lot-b-rpc.sql"
DRAFT_SADFP_SQL="$SUPABASE_DIR/DRAFT-lot-server-delivery-fulfillment-pricing.sql"
DRAFT_MERCHANT_PRICING_SQL="$SUPABASE_DIR/DRAFT-lot-merchant-delivery-pricing.sql"
DRAFT_PAYMENT_P1_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p1-foundation.sql"
DRAFT_PAYMENT_P2A_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p2a-secure-config.sql"
DRAFT_PAYMENT_P2BA_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p2b-a-safe-merchant-read.sql"
DRAFT_PAYMENT_P3A0_SQL="$SUPABASE_DIR/DRAFT-lot-payment-p3a0-secure-credential-read.sql"
DB="scanym_payment_p3a0_$$"
DB_DRIFT="scanym_payment_p3a0_drift_$$"
DB_NOVAULT="scanym_payment_p3a0_novault_$$"

PASS_COUNT=0
FAIL_COUNT=0
STRUCT_COUNT=0
BEHAV_COUNT=0
FAIL_LOG="/tmp/scanym-payment-p3a0-fails-$$.log"
CAPTURE_DIR="/tmp/scanym-payment-p3a0-capture-$$"
HARNESS_LOG="/tmp/scanym-payment-p3a0-harness-$$.log"
HARNESS_FIFO="/tmp/scanym-payment-p3a0-harness-fifo-$$"
mkdir -p "$CAPTURE_DIR"
: > "$FAIL_LOG"
: > "$HARNESS_LOG"
# PAY-P3-A0-V2-01 CORRECTION (v3, mandat sections 3-7) : la mise en
# place RÉELLE de la capture cumulative (fifo nommé + tee en
# arrière-plan à PID connu + fermeture/wait déterministe avant tout
# scan -- remplace v2's `exec > >(tee -a "$HARNESS_LOG") 2>&1`, dont
# l'extrémité d'écriture de tee ne peut être ni fermée ni attendue de
# façon fiable, ce qui produisait une fuite de synchronisation :
# reproduite indépendamment, ~1 perte / 200 exécutions sur une seule
# ligne écrite juste avant un scan immédiat) a lieu plus bas, après la
# définition d'assert_secret_eq/count_marker_hits (dont les auto-tests
# de ce mécanisme dépendent) et après ces auto-tests eux-mêmes.
# HARNESS_FIFO est déclaré ici pour rester visible dans toute la
# portée du script, y compris cleanup().

log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); echo "$1" >> "$FAIL_LOG"; log "FAIL: $1"; }
struct() { STRUCT_COUNT=$((STRUCT_COUNT+1)); pass "$1"; }
behav() { BEHAV_COUNT=$((BEHAV_COUNT+1)); pass "$1"; }

cleanup() {
  # PAY-P3-A0-V2-01 CORRECTION (v3, mandat section 7, "no self-capture
  # deadlock") : si le script s'arrête AVANT la fermeture/wait
  # déterministe normale de la section [28] (ex. un `set -e` déclenché
  # par une erreur réellement fatale plus haut), CE trap tourne encore
  # avec stdout/stderr pointant vers $HARNESS_FIFO. Il FAUT restaurer
  # stdout/stderr réels (fd 3) -- ce qui ferme notre propre extrémité
  # d'écriture du fifo -- AVANT tout `wait "$TEE_PID"` : sinon ce
  # process (celui qui exécute ce trap) garderait le fifo ouvert en
  # écriture indéfiniment, tee ne verrait jamais EOF, et `wait`
  # bloquerait pour toujours. `|| true` partout : si la fermeture/wait
  # normale a déjà eu lieu plus haut (chemin nominal), fd 3 est peut-
  # être déjà consommé et TEE_PID déjà réclamé -- jamais fatal ici.
  if [ -n "${TEE_PID:-}" ]; then
    exec >&3 2>&3 3>&- 2>/dev/null || true
    wait "$TEE_PID" 2>/dev/null || true
  fi
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
  psql -c "drop database if exists \"$DB_NOVAULT\";" >/dev/null 2>&1 || true
  rm -f "$FAIL_LOG"
  rm -rf "$CAPTURE_DIR"
  rm -f "$HARNESS_LOG"
  rm -f "$HARNESS_FIFO"
}
trap cleanup EXIT

sql() { psql -X -A -q -t -d "$DB" -c "$1" 2>&1; }
as_service() {
  # set +e/-e ENCADRE l'appel psql qui PEUT échouer intentionnellement
  # (rejet ACL/config attendu par le test) -- sans ceci, un appel
  # BARE (pas dans une substitution $(...)) déclencherait `set -e` sur
  # l'échec du psql AVANT que `echo $?` n'ait la moindre chance de
  # s'exécuter, tuant tout le script silencieusement au premier échec
  # attendu. Rend la fonction sûre quel que soit le style d'appel du
  # site appelant (substitution $(...) OU instruction nue).
  local query="$1" outfile="$2" rc
  set +e
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$query" >"$outfile" 2>&1
  rc=$?
  set -e
  echo "$rc"
}
as_service_out() {
  # Variante sans fichier -- capture le stdout directement (utilisée
  # pour les valeurs qu'on doit comparer, pas seulement le rc). Même
  # protection set +e/-e qu'as_service ci-dessus.
  local query="$1" out
  set +e
  out="$(PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -c "$query" 2>/dev/null)"
  set -e
  echo "$out"
}
as_user_rc() {
  local uid="$1" query="$2" outfile="$3" rc
  set +e
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$uid'; $query" >"$outfile" 2>&1
  rc=$?
  set -e
  echo "$rc"
}
as_anon_rc() {
  local query="$1" outfile="$2" rc
  set +e
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$query" >"$outfile" 2>&1
  rc=$?
  set -e
  echo "$rc"
}
assert_struct_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then struct "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_behav_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then behav "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_secret_eq() {
  # Helper SECRET-SAFE (PAY-P3-A0-01 correction, mandat v2 section 3) --
  # à utiliser pour TOUTE assertion dont "expected" ou "actual" est un
  # secret/credential déchiffré (mandat section 5). Contrairement à
  # assert_struct_eq/assert_behav_eq ci-dessus, celle-ci n'imprime
  # JAMAIS la valeur attendue, la valeur obtenue, leur longueur, ni
  # aucun hash/diagnostic dérivé -- sur succès comme sur échec. C'est
  # précisément l'absence de cette propriété dans assert_struct_eq
  # (son "(=$actual)" imprimé sur CHAQUE succès) qui a causé
  # PAY-P3-A0-01 : la valeur secrète synthétique se retrouvait
  # imprimée en clair sur stdout du harnais, capté ensuite dans
  # SQL-EXECUTION-LOG.log / FRESH-CLONE-SQL-LOG.log livrés. Incrémente
  # les mêmes compteurs que struct()/fail() directement (sans passer
  # par pass()/log() qui préfixeraient "PASS: " devant un contenu déjà
  # au format exact requis), pour produire EXACTEMENT :
  #   succès : "PASS — <description>"
  #   échec  : "FAIL — <description> — value mismatch"
  # La sécurité prime sur le diagnostic verbeux (mandat section 4) : un
  # échec ne doit jamais révéler la valeur réelle, la valeur attendue,
  # une sous-chaîne, une valeur échappée, ni une sortie de commande qui
  # contiendrait le secret -- le test peut échouer de façon générique.
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    STRUCT_COUNT=$((STRUCT_COUNT+1))
    PASS_COUNT=$((PASS_COUNT+1))
    log "PASS — $desc"
  else
    FAIL_COUNT=$((FAIL_COUNT+1))
    echo "$desc — value mismatch" >> "$FAIL_LOG"
    log "FAIL — $desc — value mismatch"
  fi
}
count_marker_hits() {
  # Compte silencieusement (jamais n'imprime la valeur elle-même) les
  # occurrences des DEUX marqueurs synthétiques dans un fichier donné,
  # sans jamais faire échouer le script sous set -e/pipefail sur le
  # cas légitime "zéro occurrence" (grep -c retourne 1 quand il ne
  # trouve rien -- neutralisé ici par `|| true` sur chaque sous-appel,
  # à l'intérieur de la substitution de commande elle-même, comme déjà
  # pratiqué ailleurs dans ce script pour LEAK_COUNT).
  local f="$1" c1 c2
  [ -f "$f" ] || { echo 0; return 0; }
  c1="$(grep -c -F -- "$SECRET_ONE" "$f" 2>/dev/null || true)"
  c2="$(grep -c -F -- "$SECRET_TWO" "$f" 2>/dev/null || true)"
  c1="${c1:-0}"; c2="${c2:-0}"
  echo $((c1+c2))
}

self_test_capture_pipeline() {
  # PAY-P3-A0-V2-01 CORRECTION (v3, mandat section 10) : contrôle
  # négatif étendu au PIPELINE DE CAPTURE lui-même, pas seulement à un
  # fichier écrit directement. Exerce EXACTEMENT le même mécanisme que
  # celui mis en place plus bas pour HARNESS_LOG (fifo nommé + tee en
  # arrière-plan + fermeture déterministe de l'extrémité d'écriture +
  # `wait` explicite sur le PID de tee -- jamais un sleep/polling), sur
  # un fifo/journal JETABLES et complètement isolés (jamais
  # $HARNESS_FIFO/$HARNESS_LOG eux-mêmes, jamais TEE_PID). Prouve que
  # stdout/stderr -> mécanisme de capture -> journal fermé -> détecteur
  # fonctionne de bout en bout AVANT de faire confiance à ce même
  # mécanisme pour le run réel.
  local suffix fifo log tpid marker found
  suffix="$(od -An -tx1 -N6 /dev/urandom 2>/dev/null | tr -d ' \n')"
  fifo="/tmp/scanym-p3a0-selftest-fifo-$$-${suffix}"
  log="/tmp/scanym-p3a0-selftest-log-$$-${suffix}"
  : > "$log"
  mkfifo "$fifo"
  marker="p3a0-selftest-marker-$$-${suffix}-DO-NOT-USE"
  # Le "mirroir live" est délibérément jeté (>/dev/null) ici -- cet
  # auto-test est une vérification interne du mécanisme, pas une
  # partie du récit de test destinée à l'opérateur ; seul le résultat
  # PASS/FAIL de l'assertion PRE-1 doit apparaître dans la transcription.
  tee -a "$log" < "$fifo" >/dev/null &
  tpid=$!
  exec 5> "$fifo"
  echo "$marker" >&5
  exec 5>&-
  wait "$tpid"
  if grep -q -F -- "$marker" "$log" 2>/dev/null; then found=1; else found=0; fi
  rm -f "$log" "$fifo"
  echo "$found"
}

race_regression_test() {
  # PAY-P3-A0-V2-01 CORRECTION (v3, mandat section 11) : preuve de
  # régression pour la synchronisation elle-même -- N écritures
  # RAPIDES (aucun sleep, aucune boucle de polling) à travers le MÊME
  # mécanisme fifo+tee+wait, puis vérifie qu'AUCUNE ligne n'a été
  # perdue. Un mécanisme racé laisserait `got` < `iterations` de façon
  # intermittente -- ce test échouerait alors de façon détectable
  # plutôt que de rester un faux positif silencieux.
  local iterations="$1" suffix fifo log tpid i got miss
  suffix="$(od -An -tx1 -N6 /dev/urandom 2>/dev/null | tr -d ' \n')"
  fifo="/tmp/scanym-p3a0-race-fifo-$$-${suffix}"
  log="/tmp/scanym-p3a0-race-log-$$-${suffix}"
  : > "$log"
  mkfifo "$fifo"
  # Mirroir live délibérément jeté (>/dev/null), comme pour
  # self_test_capture_pipeline ci-dessus -- les $iterations lignes
  # jetables n'ont aucune valeur pour l'opérateur ni pour le paquet
  # final ; seul le résultat PASS/FAIL de PRE-2 doit apparaître.
  tee -a "$log" < "$fifo" >/dev/null &
  tpid=$!
  exec 7> "$fifo"
  for ((i=1; i<=iterations; i++)); do
    echo "p3a0-race-line-$i"
  done >&7
  exec 7>&-
  wait "$tpid"
  got="$(grep -c '^p3a0-race-line-' "$log" 2>/dev/null || true)"
  got="${got:-0}"
  rm -f "$log" "$fifo"
  if [ "$got" -eq "$iterations" ]; then miss=0; else miss=$((iterations - got)); fi
  echo "$miss"
}

log "=== [PRE] AUTO-TEST DU MÉCANISME DE CAPTURE (avant toute construction de base -- mandat v3 sections 10-11) ==="
CAPTURE_SELFTEST_RESULT="$(self_test_capture_pipeline)"
assert_struct_eq "PRE-1. contrôle négatif du PIPELINE DE CAPTURE lui-même (fifo+tee+fermeture+wait, pas un simple fichier écrit directement) détecte un marqueur émis à travers ce mécanisme" "1" "$CAPTURE_SELFTEST_RESULT"

RACE_ITERATIONS=150
RACE_MISSES="$(race_regression_test "$RACE_ITERATIONS")"
assert_struct_eq "PRE-2. régression de synchronisation : $RACE_ITERATIONS écritures rapides (aucun sleep) à travers le mécanisme fifo+tee+wait, 0 ligne perdue attendue" "0" "$RACE_MISSES"

# ------------------------------------------------------------
# PAY-P3-A0-V2-01 CORRECTION (v3, mandat sections 4-7) : mise en place
# RÉELLE de la capture cumulative pour le run de test qui suit -- fifo
# nommé (pas une substitution de processus, dont l'extrémité
# d'écriture ne peut pas être fermée/attendue de façon fiable, mandat
# section 6) + tee en arrière-plan à PID connu (TEE_PID) + fd 3
# préservant la sortie réelle en direct (aucune perte de visibilité
# console pendant le run, contrairement à une redirection directe de
# tout le corps vers un fichier). La fermeture déterministe de
# l'extrémité d'écriture et le `wait "$TEE_PID"` correspondant
# n'interviennent qu'à la section [28], juste avant le scan -- jamais
# avant que tout le corps du test n'ait fini d'écrire.
# ------------------------------------------------------------
mkfifo "$HARNESS_FIFO"
exec 3>&1
tee -a "$HARNESS_LOG" < "$HARNESS_FIFO" >&3 &
TEE_PID=$!
exec > "$HARNESS_FIFO" 2>&1

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

build_full_chain() {
  local dbname="$1"
  for f in schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql; do
    psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
    psql -d "$dbname" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  done
  for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql; do
    psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  done
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-illico-v2.sql" >/dev/null 2>&1
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-sanaa.sql" >/dev/null 2>&1
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-sirocco-demo.sql" >/dev/null 2>&1
  psql -d "$dbname" -c "update restaurants set status='active';" >/dev/null 2>&1
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v83-lot2a4-privilege-hardening.sql" >/dev/null
  psql -d "$dbname" -c "alter default privileges in schema public grant execute on functions to service_role;" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v84-lot2b1-delivery-info-rpc.sql" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_A_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_B_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_SADFP_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_MERCHANT_PRICING_SQL" >/dev/null
  psql -d "$dbname" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P1_SQL" >/dev/null
}

# ------------------------------------------------------------
# MOCK VAULT — TEST HARNESS ONLY (voir bannière en tête de fichier).
# Identique à celui du harnais P2A (identité exacte reproduite),
# colonne `decrypted_secret` incluse -- c'est précisément la colonne
# que get_payment_provider_credential lit.
# ------------------------------------------------------------
build_mock_vault() {
  local dbname="$1"
  psql -d "$dbname" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create schema vault;

create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  secret text not null,
  name text,
  description text,
  key_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function vault.create_secret(new_secret text, new_name text, new_description text, new_key_id uuid default null)
returns uuid
language plpgsql
as $fn$
declare
  v_id uuid;
begin
  insert into vault.secrets (secret, name, description, key_id)
    values (new_secret, new_name, new_description, new_key_id)
    returning id into v_id;
  return v_id;
end;
$fn$;

create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null)
returns void
language plpgsql
as $fn$
begin
  update vault.secrets
    set secret = coalesce(new_secret, secret),
        name = coalesce(new_name, name),
        description = coalesce(new_description, description),
        key_id = coalesce(new_key_id, key_id),
        updated_at = now()
    where id = secret_id;
end;
$fn$;

create view vault.decrypted_secrets as
  select id, secret as decrypted_secret, name, description, key_id, created_at, updated_at
  from vault.secrets;
SQL
}

# ============================================================
# 0. BASELINE — chaîne réelle jusqu'à P1, mock Vault (test-only),
# P2A, P2B-A (schéma exact courant tel que publié), puis P3-A0.
# ============================================================
log "=== [0] Construction baseline $DB (chaîne réelle jusqu'à P1, installée) ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
build_common_bootstrap "$DB"
build_full_chain "$DB"
struct "chaîne réelle appliquée jusqu'à DRAFT-lot-payment-p1-foundation.sql (P1, installée)"

log "=== [0] Construction du MOCK Vault (TEST HARNESS ONLY, PAS livré) ==="
build_mock_vault "$DB"
struct "mock vault (schéma vault, table secrets, vue decrypted_secrets avec colonne decrypted_secret) construit -- test-only"

log "=== [0] Application de DRAFT-lot-payment-p2a-secure-config.sql (prérequis) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2A_SQL" >/dev/null
struct "DRAFT-lot-payment-p2a-secure-config.sql appliqué sans erreur (prérequis P3-A0)"

log "=== [0] Application de DRAFT-lot-payment-p2b-a-safe-merchant-read.sql (schéma exact courant) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2BA_SQL" >/dev/null
struct "DRAFT-lot-payment-p2b-a-safe-merchant-read.sql appliqué sans erreur (aligne le bac à sable sur le schéma exact courant)"

log "=== [0] Application de DRAFT-lot-payment-p3a0-secure-credential-read.sql (LOT SOUS TEST) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3A0_SQL" >/dev/null
struct "DRAFT-lot-payment-p3a0-secure-credential-read.sql appliqué sans erreur"

# ============================================================
# FIXTURES — 2 tenants, AUCUN secret réel, marqueurs synthétiques
# distinctifs (mandat section 14/28).
# ============================================================
log "=== Fixtures (Tenant Un + Tenant Deux) ==="
OWNER_UID="30000000-0000-0000-0000-000000000001"
OTHER_OWNER_UID="40000000-0000-0000-0000-000000000001"

psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into auth.users (id, email) values
  ('$OWNER_UID', 'owner@p3a0-fixture-one.test'),
  ('$OTHER_OWNER_UID', 'owner@p3a0-fixture-two.test');

with resto as (
  insert into restaurants (name, slug, status) values ('P3A0 Fixture Tenant One', 'p3a0-fixture-tenant-one', 'active') returning id
)
insert into restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number)
select id, 0, 'EUR', '+33600000801' from resto;

with resto2 as (
  insert into restaurants (name, slug, status) values ('P3A0 Fixture Tenant Two', 'p3a0-fixture-tenant-two', 'active') returning id
)
insert into restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number)
select id, 0, 'EUR', '+33600000901' from resto2;
SQL

RID_ONE="$(sql "select id from restaurants where slug='p3a0-fixture-tenant-one';")"
RID_TWO="$(sql "select id from restaurants where slug='p3a0-fixture-tenant-two';")"

psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into restaurant_users (restaurant_id, user_id, role) values
  ('$RID_ONE', '$OWNER_UID', 'owner'),
  ('$RID_TWO', '$OTHER_OWNER_UID', 'owner');
SQL

struct "fixtures : 2 tenants, 2 owners, aucun secret réel (marqueurs synthétiques DO-NOT-USE uniquement)"

# PAY-P3-A0-01 CORRECTION (v2, mandat section 9) : préfère un marqueur
# GÉNÉRÉ À L'EXÉCUTION plutôt que codé en dur -- le préfixe reste un
# marqueur non-secret reconnaissable (permet au scan "DO-NOT-USE"
# existant de continuer à fonctionner sans modification), mais le
# suffixe ajoute une vraie entropie /dev/urandom au lieu du seul PID
# ($$, prévisible/répétable). La valeur COMPLÈTE générée n'apparaît
# jamais en texte source dans ce script -- elle n'existe qu'en mémoire
# à l'exécution, exactement comme un vrai secret le ferait.
RAND_SUFFIX_ONE="$(od -An -tx1 -N8 /dev/urandom 2>/dev/null | tr -d ' \n')"
RAND_SUFFIX_TWO="$(od -An -tx1 -N8 /dev/urandom 2>/dev/null | tr -d ' \n')"
SECRET_ONE="p3a0-marker-alpha-$$-${RAND_SUFFIX_ONE}-DO-NOT-USE"
SECRET_TWO="p3a0-marker-beta-$$-${RAND_SUFFIX_TWO}-DO-NOT-USE"

# ============================================================
# 18 : CATALOGUE DE FONCTION — signature, SECURITY DEFINER, langage,
# volatilité, search_path vide, propriétaire, privilèges EFFECTIFS
# (pas seulement information_schema).
# ============================================================
log "=== [18] CATALOGUE DE FONCTION ==="
assert_struct_eq "18a. la fonction existe avec la signature exacte (2 arguments uuid,text) retournant text" "1" "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_payment_provider_credential' and p.pronargs=2 and array(select unnest(p.proargtypes))=array['uuid','text']::regtype[]::oid[] and p.prorettype='text'::regtype;")"
assert_struct_eq "18b. SECURITY DEFINER (prosecdef=true)" "t" "$(sql "select prosecdef from pg_proc where proname='get_payment_provider_credential' and pronamespace='public'::regnamespace;")"
assert_struct_eq "18c. langage = plpgsql" "plpgsql" "$(sql "select l.lanname from pg_proc p join pg_language l on l.oid=p.prolang where p.proname='get_payment_provider_credential' and p.pronamespace='public'::regnamespace;")"
assert_struct_eq "18d. volatilité = stable (lecture pure, pas immutable ni volatile)" "s" "$(sql "select provolatile from pg_proc where proname='get_payment_provider_credential' and pronamespace='public'::regnamespace;")"
assert_struct_eq "18e. search_path explicitement vide (proconfig contient search_path=\"\")" "1" "$(sql "select count(*) from pg_proc where proname='get_payment_provider_credential' and pronamespace='public'::regnamespace and 'search_path=\"\"' = any(proconfig);")"
assert_struct_eq "18f. propriétaire = rôle ayant exécuté la migration (rôle de confiance, comme tous les lots précédents -- aucun OWNER TO explicite requis ni posé)" "$(sql "select current_user;")" "$(sql "select r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner where p.proname='get_payment_provider_credential' and p.pronamespace='public'::regnamespace;")"
assert_struct_eq "18g. EXECUTE effectif service_role = OUI (has_function_privilege)" "t" "$(sql "select has_function_privilege('service_role', 'public.get_payment_provider_credential(uuid,text)', 'execute');")"
assert_struct_eq "18h. EXECUTE effectif anon = NON (has_function_privilege)" "f" "$(sql "select has_function_privilege('anon', 'public.get_payment_provider_credential(uuid,text)', 'execute');")"
assert_struct_eq "18i. EXECUTE effectif authenticated = NON (has_function_privilege)" "f" "$(sql "select has_function_privilege('authenticated', 'public.get_payment_provider_credential(uuid,text)', 'execute');")"
assert_struct_eq "18j. AUCUN grant EXECUTE résiduel à PUBLIC dans information_schema (pas seulement has_function_privilege -- double vérification par catalogue)" "0" "$(sql "select count(*) from information_schema.role_routine_grants where routine_schema='public' and routine_name='get_payment_provider_credential' and grantee='PUBLIC';")"

# ============================================================
# 19-24 : COMPORTEMENT — config manquante / not_configured /
# configured / verified / is_enabled=false / orphelin.
# ============================================================
log "=== [19-24] COMPORTEMENT DE LECTURE ==="

OUT19="$CAPTURE_DIR/19.out"
RC19="$(as_service "select public.get_payment_provider_credential('$RID_ONE','fixture-provider-p3a0');" "$OUT19")"
assert_behav_eq "19. config totalement inexistante -> échec (fail-closed), aucun secret en sortie" "1" "$([ "$RC19" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "19b. aucun contenu de type secret dans la sortie de l'échec (juste un message d'erreur générique)" "0" "$(grep -c "DO-NOT-USE" "$OUT19" || true)"

# Provisionne une config not_configured explicite (accès superuser
# direct -- préparation de fixture, pas un chemin applicatif : aucun
# rôle applicatif n'a de grant direct sur cette table, hérité de P1).
sql "insert into payment_provider_configs (restaurant_id, provider_code) values ('$RID_ONE','fixture-provider-p3a0');" >/dev/null
CONFIG_ONE_ID="$(sql "select id from payment_provider_configs where restaurant_id='$RID_ONE' and provider_code='fixture-provider-p3a0';")"
assert_struct_eq "19c. fixture : configuration_status par défaut = not_configured" "not_configured" "$(sql "select configuration_status from payment_provider_configs where id='$CONFIG_ONE_ID';")"

OUT20="$CAPTURE_DIR/20.out"
RC20="$(as_service "select public.get_payment_provider_credential('$RID_ONE','fixture-provider-p3a0');" "$OUT20")"
assert_behav_eq "20. configuration_status='not_configured' -> échec (fail-closed)" "1" "$([ "$RC20" != "0" ] && echo 1 || echo 0)"

# Passe la config à 'configured' via le chemin RPC RÉEL P2A (pas un
# UPDATE direct) -- preuve que la lecture P3-A0 s'enchaîne bien sur
# l'écriture P2A existante, sans logique dupliquée.
RC_SETUP21="$(as_service "select * from public.set_payment_provider_credentials('$RID_ONE','fixture-provider-p3a0','$SECRET_ONE');" "$CAPTURE_DIR/setup21.out")"
assert_behav_eq "21z. fixture : set_payment_provider_credentials (création initiale) ACCEPTÉ" "0" "$RC_SETUP21"
assert_struct_eq "21a. fixture : configuration_status='configured' après set_payment_provider_credentials (P2A, inchangé)" "configured" "$(sql "select configuration_status from payment_provider_configs where id='$CONFIG_ONE_ID';")"

OUT21="$CAPTURE_DIR/21.out"
SECRET_READ_21="$(as_service_out "select public.get_payment_provider_credential('$RID_ONE','fixture-provider-p3a0');")"
assert_secret_eq "21. configuration_status='configured' -> succès, secret synthétique EXACT retourné (prouve que la vérification Sandbox peut lire un credential AVANT l'état 'verified')" "$SECRET_ONE" "$SECRET_READ_21"

# Passe à 'verified' (accès superuser direct -- AUCUNE RPC de ce lot
# ni de P2A ne peut jamais écrire 'verified', par construction ;
# simulation d'un futur adaptateur ayant validé le credential).
sql "update payment_provider_configs set configuration_status='verified', last_verified_at=now() where id='$CONFIG_ONE_ID';" >/dev/null
SECRET_READ_22="$(as_service_out "select public.get_payment_provider_credential('$RID_ONE','fixture-provider-p3a0');")"
assert_secret_eq "22. configuration_status='verified' -> succès, secret synthétique exact retourné" "$SECRET_ONE" "$SECRET_READ_22"

# is_enabled=false (défaut P1 déjà -- confirmé explicitement) : la
# lecture doit RÉUSSIR malgré is_enabled=false, ce lot n'est pas une
# vérification d'activation runtime.
assert_struct_eq "23a. fixture : is_enabled=false (défaut P1, jamais modifié)" "f" "$(sql "select is_enabled from payment_provider_configs where id='$CONFIG_ONE_ID';")"
SECRET_READ_23="$(as_service_out "select public.get_payment_provider_credential('$RID_ONE','fixture-provider-p3a0');")"
assert_secret_eq "23. is_enabled=false + configuration_status=verified -> lecture RÉUSSIT quand même (lecture de credential distincte de l'activation runtime, mandat section 23)" "$SECRET_ONE" "$SECRET_READ_23"

# Orphelin : supprime le secret Vault sous-jacent DIRECTEMENT
# (simulation d'une incohérence antérieure, jamais atteignable par le
# chemin RPC normal -- même patron que le test orphelin de P2A).
ORPHAN_REF="$(sql "select credentials_ref::text from payment_provider_configs where id='$CONFIG_ONE_ID';")"
sql "delete from vault.secrets where id='$ORPHAN_REF';" >/dev/null
OUT24="$CAPTURE_DIR/24.out"
RC24="$(as_service "select public.get_payment_provider_credential('$RID_ONE','fixture-provider-p3a0');" "$OUT24")"
assert_behav_eq "24. credentials_ref orphelin (secret Vault absent) -> échec fermé BRUYANT (pas un succès NULL déguisé)" "1" "$([ "$RC24" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "24b. message d'erreur mentionne SCANYM_CREDENTIAL_REFERENCE_INVALID (même identifiant que P2A pour la même classe de défaut)" "1" "$(grep -c "SCANYM_CREDENTIAL_REFERENCE_INVALID" "$OUT24" || true)"
assert_struct_eq "24c. après l'échec orphelin, configuration_status reste INCHANGÉ (verified) -- lecture pure, aucune mutation même en cas d'échec" "verified" "$(sql "select configuration_status from payment_provider_configs where id='$CONFIG_ONE_ID';")"

# Restaure un credential valide pour Tenant Un avant le test
# d'isolation. credentials_ref est actuellement ORPHELIN (test 24 a
# supprimé le secret Vault sous-jacent) -- set_payment_provider_credentials
# refuserait un REMPLACEMENT contre une référence orpheline (P2A,
# fail-closed, même comportement que son propre test "orphelin au
# remplacement"). Il faut donc d'abord clear (accepté même sur une
# référence orpheline, P2A section 15) pour repartir de
# not_configured/NULL, PUIS set (chemin création, pas remplacement).
RC_CLEAR_RESTORE="$(as_service "select * from public.clear_payment_provider_credentials('$RID_ONE','fixture-provider-p3a0');" "$CAPTURE_DIR/restore-clear.out")"
assert_behav_eq "24d. clear sur la référence orpheline de préparation ACCEPTÉ (repart de not_configured, permet la restauration -- comportement P2A déjà validé, pas un nouveau test P3-A0)" "0" "$RC_CLEAR_RESTORE"
RC_SET_RESTORE="$(as_service "select * from public.set_payment_provider_credentials('$RID_ONE','fixture-provider-p3a0','$SECRET_ONE');" "$CAPTURE_DIR/restore.out")"
assert_behav_eq "24e. set_payment_provider_credentials (création fraîche après clear) ACCEPTÉ -- Tenant Un restauré pour le test d'isolation" "0" "$RC_SET_RESTORE"
sql "update payment_provider_configs set configuration_status='verified' where id='$CONFIG_ONE_ID';" >/dev/null

# ============================================================
# 25 : ISOLATION TENANT.
# ============================================================
log "=== [25] ISOLATION TENANT ==="
RC_SETUP25="$(as_service "select * from public.set_payment_provider_credentials('$RID_TWO','fixture-provider-p3a0','$SECRET_TWO');" "$CAPTURE_DIR/setup25.out")"
assert_behav_eq "25z. fixture : set_payment_provider_credentials Tenant Deux (création initiale) ACCEPTÉ" "0" "$RC_SETUP25"
CONFIG_TWO_ID="$(sql "select id from payment_provider_configs where restaurant_id='$RID_TWO' and provider_code='fixture-provider-p3a0';")"
sql "update payment_provider_configs set configuration_status='verified' where id='$CONFIG_TWO_ID';" >/dev/null

SECRET_READ_A="$(as_service_out "select public.get_payment_provider_credential('$RID_ONE','fixture-provider-p3a0');")"
SECRET_READ_B="$(as_service_out "select public.get_payment_provider_credential('$RID_TWO','fixture-provider-p3a0');")"
assert_secret_eq "25a. lecture Tenant Un renvoie EXACTEMENT le secret de Un, jamais celui de Deux" "$SECRET_ONE" "$SECRET_READ_A"
assert_secret_eq "25b. lecture Tenant Deux renvoie EXACTEMENT le secret de Deux, jamais celui de Un" "$SECRET_TWO" "$SECRET_READ_B"
assert_struct_eq "25c. les deux secrets lus sont bien DISTINCTS (substitution cross-tenant structurellement impossible)" "1" "$([ "$SECRET_READ_A" != "$SECRET_READ_B" ] && echo 1 || echo 0)"

# ============================================================
# 26 : ACL PAR RÔLE (comportemental, confirmation directe).
# ============================================================
log "=== [26] ACL PAR RÔLE ==="
RC_AUTH="$(as_user_rc "$OWNER_UID" "select public.get_payment_provider_credential('$RID_ONE','fixture-provider-p3a0');" "$CAPTURE_DIR/26auth.out")"
assert_behav_eq "26a. authenticated (marchand ordinaire, y compris propriétaire du restaurant lui-même) NE PEUT PAS exécuter get_payment_provider_credential" "1" "$([ "$RC_AUTH" != "0" ] && echo 1 || echo 0)"
RC_ANON="$(as_anon_rc "select public.get_payment_provider_credential('$RID_ONE','fixture-provider-p3a0');" "$CAPTURE_DIR/26anon.out")"
assert_behav_eq "26b. anon NE PEUT PAS exécuter get_payment_provider_credential" "1" "$([ "$RC_ANON" != "0" ] && echo 1 || echo 0)"
RC_SVC="$(as_service "select public.get_payment_provider_credential('$RID_ONE','fixture-provider-p3a0');" "$CAPTURE_DIR/26svc.out")"
assert_behav_eq "26c. service_role PEUT exécuter get_payment_provider_credential (chemin de confiance)" "0" "$RC_SVC"
assert_struct_eq "26d. le secret de Tenant Un n'apparaît PAS dans la sortie d'échec authenticated (fuite impossible même par un message d'erreur)" "0" "$(grep -c "$SECRET_ONE" "$CAPTURE_DIR/26auth.out" || true)"
assert_struct_eq "26e. le secret de Tenant Un n'apparaît PAS dans la sortie d'échec anon" "0" "$(grep -c "$SECRET_ONE" "$CAPTURE_DIR/26anon.out" || true)"

# ============================================================
# 27 : AUCUN ACCÈS DIRECT VAULT AJOUTÉ (reconfirmation post-P3-A0).
# ============================================================
log "=== [27] AUCUN ACCÈS DIRECT VAULT AJOUTÉ ==="
RC_ANON_VS="$(as_anon_rc "select count(*) from vault.secrets;" "$CAPTURE_DIR/27a.out")"
assert_behav_eq "27a. anon NE PEUT toujours PAS lire vault.secrets après P3-A0" "1" "$([ "$RC_ANON_VS" != "0" ] && echo 1 || echo 0)"
RC_ANON_VDS="$(as_anon_rc "select count(*) from vault.decrypted_secrets;" "$CAPTURE_DIR/27b.out")"
assert_behav_eq "27b. anon NE PEUT toujours PAS lire vault.decrypted_secrets après P3-A0" "1" "$([ "$RC_ANON_VDS" != "0" ] && echo 1 || echo 0)"
RC_AUTH_VS="$(as_user_rc "$OWNER_UID" "select count(*) from vault.secrets;" "$CAPTURE_DIR/27c.out")"
assert_behav_eq "27c. authenticated NE PEUT toujours PAS lire vault.secrets après P3-A0" "1" "$([ "$RC_AUTH_VS" != "0" ] && echo 1 || echo 0)"
RC_AUTH_VDS="$(as_user_rc "$OWNER_UID" "select count(*) from vault.decrypted_secrets;" "$CAPTURE_DIR/27d.out")"
assert_behav_eq "27d. authenticated NE PEUT toujours PAS lire vault.decrypted_secrets après P3-A0" "1" "$([ "$RC_AUTH_VDS" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "27e. AUCUN grant direct sur vault.secrets à anon/authenticated dans information_schema (P3-A0 n'a ajouté aucun grant Vault)" "0" "$(sql "select count(*) from information_schema.role_table_grants where table_schema='vault' and table_name='secrets' and grantee in ('anon','authenticated','PUBLIC');")"
assert_struct_eq "27f. AUCUN grant direct sur vault.decrypted_secrets à anon/authenticated dans information_schema" "0" "$(sql "select count(*) from information_schema.role_table_grants where table_schema='vault' and table_name='decrypted_secrets' and grantee in ('anon','authenticated','PUBLIC');")"

# ============================================================
# NON-RÉGRESSION P2A (mandat section 17) — les deux RPC d'écriture,
# l'unicité credentials_ref, la cohérence configuration_status, et le
# refus marchand restent inchangés APRÈS ajout de P3-A0.
# ============================================================
log "=== NON-RÉGRESSION P2A ==="
RC_MERCH_SET="$(as_user_rc "$OWNER_UID" "select * from public.set_payment_provider_credentials('$RID_ONE','fixture-provider-p3a0','x');" "$CAPTURE_DIR/nonreg1.out")"
assert_behav_eq "P2A-a. authenticated NE PEUT toujours PAS exécuter set_payment_provider_credentials après P3-A0" "1" "$([ "$RC_MERCH_SET" != "0" ] && echo 1 || echo 0)"
RC_MERCH_CLEAR="$(as_user_rc "$OWNER_UID" "select * from public.clear_payment_provider_credentials('$RID_ONE','fixture-provider-p3a0');" "$CAPTURE_DIR/nonreg2.out")"
assert_behav_eq "P2A-b. authenticated NE PEUT toujours PAS exécuter clear_payment_provider_credentials après P3-A0" "1" "$([ "$RC_MERCH_CLEAR" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "P2A-c. index unique partiel credentials_ref (PAY-P2A-04) toujours présent après P3-A0" "1" "$(sql "select count(*) from pg_indexes where schemaname='public' and tablename='payment_provider_configs' and indexname='payment_provider_configs_credentials_ref_unique';")"
assert_struct_eq "P2A-d. contrainte de cohérence configuration_status/credentials_ref toujours présente après P3-A0" "1" "$(sql "select count(*) from pg_constraint where conname='payment_provider_configs_credentials_consistency' and conrelid='public.payment_provider_configs'::regclass and contype='c';")"

# ============================================================
# NON-RÉGRESSION P2B-A (lecture marchande sûre, distincte, toujours
# metadata-only -- mandat section 16).
# ============================================================
log "=== NON-RÉGRESSION P2B-A ==="
MERCH_READ="$(as_user_rc "$OWNER_UID" "select * from public.get_merchant_payment_provider_config('$RID_ONE');" "$CAPTURE_DIR/p2ba.out")"
assert_behav_eq "P2B-A-a. get_merchant_payment_provider_config reste appelable par authenticated (inchangé, P3-A0 ne l'a pas altérée)" "0" "$MERCH_READ"
assert_struct_eq "P2B-A-b. get_merchant_payment_provider_config ne retourne AUCUNE colonne credentials_ref/secret (metadata-only, toujours distincte de P3-A0)" "0" "$(grep -c "credentials_ref\|$SECRET_ONE\|$SECRET_TWO" "$CAPTURE_DIR/p2ba.out" || true)"

# ============================================================
# GARDES ANTI-DÉRIVE.
# ============================================================
log "=== GARDES ANTI-DÉRIVE ==="
OUT_DOUBLE="$CAPTURE_DIR/double.out"
RC_DOUBLE_APPLY="$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3A0_SQL" >"$OUT_DOUBLE" 2>&1; echo $?)"
assert_behav_eq "D1. double application du lot REFUSÉE (SCANYM_SCHEMA_DRIFT)" "1" "$([ "$RC_DOUBLE_APPLY" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "D2. message de double application mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" "$OUT_DOUBLE" || true)"

log "=== GARDE — base SANS payment_provider_configs (prérequis P1 manquant) ==="
psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
createdb "$DB_DRIFT"
build_common_bootstrap "$DB_DRIFT"
OUT_DRIFT="$CAPTURE_DIR/drift.out"
RC_MISSING_PREREQ="$(psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3A0_SQL" >"$OUT_DRIFT" 2>&1; echo $?)"
assert_behav_eq "D3. application sur base SANS payment_provider_configs REFUSÉE dès la garde préflight" "1" "$([ "$RC_MISSING_PREREQ" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "D4. message mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" "$OUT_DRIFT" || true)"

log "=== GARDE — Vault ABSENT (base sans mock, reproduit l'environnement réel sans l'extension) ==="
psql -c "drop database if exists \"$DB_NOVAULT\";" >/dev/null 2>&1 || true
createdb "$DB_NOVAULT"
build_common_bootstrap "$DB_NOVAULT"
build_full_chain "$DB_NOVAULT"
psql -d "$DB_NOVAULT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P2A_SQL" >/dev/null 2>&1 || true
OUT_NOVAULT="$CAPTURE_DIR/novault.out"
# Note : DRAFT_PAYMENT_P2A_SQL lui-même échoue déjà sans Vault (sa
# propre garde) -- pour isoler la garde D'ARCHITECTURE de P3-A0
# spécifiquement, ce scénario retire le schéma vault QUE le mock aurait
# construit, en s'assurant qu'aucun schéma vault n'existe du tout, PUIS
# applique directement P3-A0 sur une base qui a néanmoins les colonnes
# P2A requises (construites manuellement, sans passer par P2A réel,
# uniquement pour isoler CETTE garde précise).
psql -d "$DB_NOVAULT" -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL' || true
alter table public.payment_provider_configs
  add column if not exists credentials_ref uuid,
  add column if not exists configuration_status text not null default 'not_configured';
SQL
RC_NO_VAULT="$(psql -d "$DB_NOVAULT" -v ON_ERROR_STOP=1 -f "$DRAFT_PAYMENT_P3A0_SQL" >"$OUT_NOVAULT" 2>&1; echo $?)"
assert_behav_eq "D5. application SANS schéma vault disponible REFUSÉE dès la garde préflight de P3-A0 (fail loud)" "1" "$([ "$RC_NO_VAULT" != "0" ] && echo 1 || echo 0)"
assert_struct_eq "D6. message de garde d'architecture Vault mentionne SCANYM_SCHEMA_DRIFT" "1" "$(grep -c "SCANYM_SCHEMA_DRIFT" "$OUT_NOVAULT" || true)"

# ============================================================
# 28 : ABSENCE DE FUITE DE SECRET — recherche négative explicite sur
# TOUT le matériel de test capturé, AVANT nettoyage.
# ============================================================
log "=== [28] ABSENCE DE FUITE DE SECRET ==="

# ------------------------------------------------------------
# PAY-P3-A0-V2-01 CORRECTION (v3, mandat sections 4/8) : FERMETURE
# DÉTERMINISTE du pipeline de capture AVANT tout scan de $HARNESS_LOG.
# `exec >&3 2>&3` restaure stdout/stderr réels -- ce qui ferme notre
# unique extrémité d'écriture du fifo (aucun autre écrivain en
# arrière-plan n'existe dans ce script : le seul job d'arrière-plan est
# tee lui-même, dont l'entrée est le côté LECTURE du fifo, jamais
# écriture). `wait "$TEE_PID"` bloque ensuite jusqu'à ce que tee ait lu
# EOF, terminé d'écrire tout ce qui restait bufferisé dans
# $HARNESS_LOG, et se soit effectivement terminé -- une preuve de
# complétude déterministe (l'achèvement d'un process), jamais un
# sleep, une boucle de polling, ou un espoir que tee ait eu le temps
# d'écrire. C'est précisément l'absence de cette étape en v2 qui
# causait PAY-P3-A0-V2-01 (reproduit indépendamment : ~1 perte / 200
# exécutions sur un scan immédiatement après une seule écriture).
exec >&3 2>&3
wait "$TEE_PID"
log "=== [28] pipeline de capture fermé et vidé de façon déterministe -- HARNESS_LOG désormais complet ==="

# ------------------------------------------------------------
# 28-neg : CONTRÔLE NÉGATIF DIRECT (PAY-P3-A0-01 correction, mandat v2
# section 12) -- prouve que le mécanisme de détection n'est pas
# vacuum : plante délibérément un marqueur synthétique dans un fichier
# TEMPORAIRE, HORS $CAPTURE_DIR, confirme que la détection (grep -q
# silencieux -- jamais grep sans -q, pour ne jamais imprimer la ligne
# correspondante) le trouve, PUIS supprime ce fichier AVANT le scan
# réel ci-dessous. Ce fichier ne fait jamais partie du paquet livré.
# ------------------------------------------------------------
NEG_CONTROL_FILE="$(mktemp /tmp/scanym-p3a0-negctrl-XXXXXX)"
printf 'unrelated-prefix %s unrelated-suffix\n' "$SECRET_ONE" > "$NEG_CONTROL_FILE"
if grep -q -F -- "$SECRET_ONE" "$NEG_CONTROL_FILE" 2>/dev/null; then
  NEG_DETECTED=1
else
  NEG_DETECTED=0
fi
rm -f "$NEG_CONTROL_FILE"
assert_struct_eq "28-neg. contrôle négatif : le détecteur de fuite détecte bien un marqueur planté dans un fichier jetable (preuve de non-vacuité), fichier supprimé avant le scan réel" "1" "$NEG_DETECTED"

LEAK_COUNT="$(grep -rl "DO-NOT-USE" "$CAPTURE_DIR" 2>/dev/null | xargs -r grep -l "$SECRET_ONE\|$SECRET_TWO" 2>/dev/null | grep -vE "/(21|22|23|25a|25b|26svc)\.out$|setup21\.out$|setup25\.out$|restore\.out$" | wc -l || true)"
# `|| true` final : sous `pipefail`, quand AUCUNE ligne ne survit au
# filtrage `grep -vE` (le cas ATTENDU -- zéro fuite), ce `grep`
# retourne lui-même le code 1 ("aucune correspondance"), ce qui, sous
# `pipefail`, ferait remonter 1 comme statut de TOUT le pipeline même
# si `wc -l` a correctement imprimé "0" -- `set -e` tuerait alors le
# script sur ce résultat pourtant correct. `|| true` neutralise ce
# faux échec sans jamais masquer la valeur elle-même (capturée avant).
# Note : 21/22/23/25a/25b/26svc/setup21/setup25/restore sont les
# captures de SUCCÈS ATTENDU (le secret DOIT y apparaître -- c'est la
# valeur de retour légitime de la RPC vers service_role, jamais une
# fuite -- 26svc est précisément le test "service_role PEUT exécuter",
# dont la sortie contient légitimement le secret retourné). Tous les
# AUTRES fichiers capturés (échecs, ACL refusés, gardes, non-
# régression) ne doivent JAMAIS contenir la moindre valeur secrète.
assert_struct_eq "28a. aucun secret synthétique n'apparaît dans un fichier de capture autre que les succès attendus de service_role" "0" "$LEAK_COUNT"
assert_struct_eq "28b. aucun secret synthétique n'apparaît dans le journal PostgreSQL (pg_log / stderr serveur, si accessible)" "0" "$(sudo test -d /var/log/postgresql 2>/dev/null && sudo grep -rl "DO-NOT-USE" /var/log/postgresql/ 2>/dev/null | wc -l || echo 0)"
# 28e (PAY-P3-A0-01 correction, mandat v2 sections 6/8) : couvre le
# canal EXACT par lequel la fuite v1 s'est produite -- la sortie
# CUMULATIVE stdout/stderr du harnais lui-même (HARNESS_LOG), pas
# seulement $CAPTURE_DIR. Comptage silencieux via count_marker_hits
# (jamais grep sans -c/-q) -- après le correctif, AUCUNE occurrence
# n'est attendue nulle part dans ce flux, sans exception (contrairement
# à 28a, aucun fichier "succès service_role" légitime n'existe ici :
# la valeur de retour du RPC ne transite jamais par stdout du harnais,
# seulement par des variables shell ou par des fichiers sous
# $CAPTURE_DIR déjà couverts par 28a).
assert_struct_eq "28e. aucun secret synthétique n'apparaît dans la capture cumulative complète stdout/stderr du harnais (HARNESS_LOG, désormais fermé/vidé de façon déterministe ci-dessus) -- comble le point aveugle exact à l'origine de PAY-P3-A0-01" "0" "$(count_marker_hits "$HARNESS_LOG")"
# 28e2 (mandat v3 section 9, "old (=<secret>) signature") : garde de
# non-régression EXPLICITE contre la classe de défaut exacte de
# PAY-P3-A0-01 -- recherche littéralement la forme "(=...DO-NOT-USE...)"
# (celle qu'imprimait assert_struct_eq/assert_behav_eq sur PASS avant
# le correctif v2) dans HARNESS_LOG, indépendamment de toute valeur de
# secret précise. Plus stricte que 28e sur la FORME, en complément (pas
# en remplacement) de 28e qui est plus stricte sur le CONTENU.
assert_struct_eq "28e2. aucune occurrence de l'ancienne signature de fuite \"(=...DO-NOT-USE...)\" dans HARNESS_LOG (garde de non-régression contre la classe de défaut PAY-P3-A0-01, indépendante de la valeur exacte du secret)" "0" "$(grep -cE '\(=[^)]*DO-NOT-USE[^)]*\)' "$HARNESS_LOG" 2>/dev/null || true)"
# 28f : les artefacts source destinés au paquet (le fichier SQL du lot
# et ce script de test lui-même) ne contiennent, eux non plus, aucune
# occurrence littérale du marqueur généré à l'exécution (mandat
# section 8, "package source artifacts") -- preuve exécutable plutôt
# que supposition, bien que structurellement garanti par construction
# puisque SECRET_ONE/SECRET_TWO ne sont jamais codés en dur (section 9).
assert_struct_eq "28f. aucune occurrence du marqueur synthétique dans le fichier SQL du lot ni dans le script de test lui-même (artefacts source du paquet)" "0" "$(( $(count_marker_hits "$DRAFT_PAYMENT_P3A0_SQL") + $(count_marker_hits "$0") ))"
# Exclut toute ligne qui CONSTRUIT elle-même ce motif de recherche
# (celle-ci -- 28c -- et 28d juste en dessous, qui référence le même
# motif littéral pour scanner le fichier SQL du lot) -- sinon le
# script se détecterait lui-même comme un faux positif de forme.
assert_struct_eq "28c. AUCUNE valeur de secret réel plausible (préfixes sk_live/pk_live, bloc PEM) dans le texte de ce script de test lui-même" "0" "$(grep -v 'grep -c "sk_live' "$0" | grep -c "sk_live\|pk_live\|-----BEGIN" || true)"
assert_struct_eq "28d. le fichier SQL du lot lui-même (DRAFT-lot-payment-p3a0-secure-credential-read.sql) ne contient aucun littéral secret" "0" "$(grep -c "sk_live\|pk_live\|-----BEGIN" "$DRAFT_PAYMENT_P3A0_SQL" || true)"

# ============================================================
# BILAN
# ============================================================
log "=== BILAN : $PASS_COUNT PASS / $FAIL_COUNT FAIL (dont $STRUCT_COUNT structurelles, $BEHAV_COUNT comportementales) ==="
if [ "$FAIL_COUNT" -gt 0 ]; then
  log "--- Détail des échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
