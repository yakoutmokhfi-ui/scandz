#!/usr/bin/env bash
# ============================================================
# Scanym — TRANSLATIONS MANAGEMENT v2.3
# TESTS DE SÛRETÉ DU HARNAIS (remédiation d'audit, TEST INFRA)
#
# Le harnais `translations-management-v2-check.sh` crée/supprime une
# base et modifie des rôles PARTAGÉS du cluster. Ces tests prouvent
# qu'il :
#
#   [A] REFUSE une cible redirigée par PGHOST, avant tout SQL destructif ;
#   [B] REFUSE une cible redirigée par PGHOSTADDR ;
#   [C] REFUSE une redirection silencieuse par PGSERVICE / PGSERVICEFILE
#       (et par DATABASE_URL / PGPORT / PGUSER / PGPASSWORD) ;
#   [D] échoue FERMÉ quand l'identité RÉELLE du serveur, interrogée en
#       SQL, n'est pas celle d'un cluster jetable ;
#   [E] restaure un `service_role` PRÉEXISTANT sans BYPASSRLS ;
#   [F] restaure les attributs d'un rôle préexistant même après un
#       ÉCHEC du harnais ;
#   [G] supprime les rôles qu'il a lui-même créés ;
#   [H] supprime la base jetable après un succès ;
#   [I] supprime la base jetable après un échec.
#
# Ces tests sont COMPORTEMENTAUX : ils exécutent réellement le harnais
# et observent le cluster. Aucune assertion ne se contente de chercher
# du texte dans le script.
#
# Usage, depuis la racine du dépôt :
#   SCANYM_DISPOSABLE_CLUSTER=1 sudo -u postgres -E \
#     bash supabase/tests/translations-management-v2-harness-safety-check.sh
# ============================================================

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS="$ROOT/supabase/tests/translations-management-v2-check.sh"
TMP="$(mktemp -d /tmp/scanym-tm2-safety-XXXXXX)"

PASS=0
FAIL=0
FAIL_LOG="$TMP/fails.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS=$((PASS+1)); log "PASS: $*"; }
fail() { FAIL=$((FAIL+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }

# Ces tests manipulent eux-mêmes des rôles du cluster : ils exigent le
# même consentement explicite que le harnais qu'ils vérifient.
if [ "${SCANYM_DISPOSABLE_CLUSTER:-}" != "1" ]; then
  echo "REFUS : SCANYM_DISPOSABLE_CLUSTER=1 requis (cluster jetable)." >&2
  exit 2
fi
for v in PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE DATABASE_URL; do
  if [ -n "${!v:-}" ]; then
    echo "REFUS : $v est définie dans l'environnement de test." >&2
    exit 2
  fi
done
export PGHOST="/var/run/postgresql"
export PGDATABASE="postgres"

q() { psql -X -A -q -t -d postgres -c "$1" 2>/dev/null; }
q -c >/dev/null 2>&1 || true
if ! q "select 1" >/dev/null; then
  echo "REFUS : cluster local injoignable." >&2
  exit 2
fi

cleanup() {
  psql -X -q -d postgres -c "drop database if exists scanym_prod_lookalike;" >/dev/null 2>&1 || true
  rm -rf "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

db_count() { q "select count(*) from pg_database where datname ~ '^scanym_tm2_[0-9]+$';"; }
role_exists() { q "select count(*) from pg_roles where rolname = '$1';"; }
role_bypassrls() { q "select rolbypassrls::text from pg_roles where rolname = '$1';"; }
role_connlimit() { q "select rolconnlimit::text from pg_roles where rolname = '$1';"; }
role_canlogin() { q "select rolcanlogin::text from pg_roles where rolname = '$1';"; }

run_harness() {
  # Exécute le harnais dans un environnement CONTRÔLÉ, en lui passant
  # exactement les variables demandées par le cas de test.
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" "$@" bash "$HARNESS" \
    >"$TMP/out.txt" 2>"$TMP/err.txt"
  echo $?
}

# ------------------------------------------------------------------
# [A] [B] [C] -- redirections externes REFUSÉES avant tout SQL
# ------------------------------------------------------------------
DB_BEFORE="$(db_count)"

check_refusal() {
  local label="$1"; shift
  local rc
  rc="$(run_harness "$@")"
  local out; out="$(cat "$TMP/err.txt" "$TMP/out.txt" 2>/dev/null)"
  if [ "$rc" = "2" ] && printf '%s' "$out" | grep -q "REFUS DE SÛRETÉ"; then
    pass "$label (refus explicite, code 2)"
  else
    fail "$label — attendu un refus (code 2), obtenu rc=$rc : $(printf '%s' "$out" | tail -2)"
  fi
  # Aucune opération destructive ne doit avoir eu lieu.
  if [ "$(db_count)" = "$DB_BEFORE" ]; then
    pass "$label : aucune base jetable créée"
  else
    fail "$label : une base a été créée malgré le refus"
  fi
}

check_refusal "[A] PGHOST externe" SCANYM_DISPOSABLE_CLUSTER=1 PGHOST=db.production.example.com
check_refusal "[B] PGHOSTADDR externe" SCANYM_DISPOSABLE_CLUSTER=1 PGHOSTADDR=203.0.113.10
check_refusal "[C] PGSERVICE" SCANYM_DISPOSABLE_CLUSTER=1 PGSERVICE=production
check_refusal "[C] PGSERVICEFILE" SCANYM_DISPOSABLE_CLUSTER=1 PGSERVICEFILE=/tmp/pgservice.conf
check_refusal "[C] DATABASE_URL" SCANYM_DISPOSABLE_CLUSTER=1 DATABASE_URL=postgres://u:p@db.prod.example.com:5432/app
check_refusal "[C] PGPORT / PGUSER / PGPASSWORD" SCANYM_DISPOSABLE_CLUSTER=1 PGPORT=6543 PGUSER=app PGPASSWORD=secret
check_refusal "[C] PGDATABASE" SCANYM_DISPOSABLE_CLUSTER=1 PGDATABASE=scanym_production
check_refusal "[D] consentement jetable ABSENT" PGAPPNAME=x
check_refusal "[D] socket désignée inexistante" SCANYM_DISPOSABLE_CLUSTER=1 SCANYM_HARNESS_PGHOST=/nonexistent/socket
check_refusal "[D] socket désignée non absolue (hôte TCP)" SCANYM_DISPOSABLE_CLUSTER=1 SCANYM_HARNESS_PGHOST=db.prod.example.com

# [D] identité EFFECTIVE du serveur jugée non jetable, prouvée en SQL :
# le cluster porte une base au nom évoquant la production.
psql -X -q -d postgres -c "create database scanym_prod_lookalike;" >/dev/null 2>&1
check_refusal "[D] cluster portant une base « production » -> fail closed" SCANYM_DISPOSABLE_CLUSTER=1
psql -X -q -d postgres -c "drop database if exists scanym_prod_lookalike;" >/dev/null 2>&1

# ------------------------------------------------------------------
# [E] [H] -- exécution RÉUSSIE : rôles préexistants restaurés, base
#            jetable supprimée.
# ------------------------------------------------------------------
log "=== [E]/[H] exécution complète du harnais ==="
# Pré-état contrôlé : service_role PRÉEXISTANT et SANS BYPASSRLS ;
# authenticated PRÉEXISTANT avec une limite de connexions distinctive.
psql -X -q -d postgres >/dev/null 2>&1 <<'SQL'
do $$ begin
  if not exists (select from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end $$;
alter role service_role nobypassrls;
alter role authenticated nologin connection limit 7;
SQL
# `anon` est volontairement ABSENT : le harnais devra le créer, puis le
# retirer ([G]).
psql -X -q -d postgres -c "drop owned by anon;" >/dev/null 2>&1 || true
psql -X -q -d postgres -c "drop role if exists anon;" >/dev/null 2>&1 || true

RC_OK="$(run_harness SCANYM_DISPOSABLE_CLUSTER=1)"
if [ "$RC_OK" = "0" ]; then
  pass "[H] le harnais durci s'exécute et réussit sur un cluster jetable"
else
  fail "[H] le harnais durci a échoué (rc=$RC_OK) : $(tail -3 "$TMP/out.txt")"
fi
if [ "$(db_count)" = "0" ]; then
  pass "[H] la base jetable est supprimée après un SUCCÈS"
else
  fail "[H] une base jetable subsiste après un succès"
fi
if [ "$(role_bypassrls service_role)" = "false" ]; then
  pass "[E] un service_role PRÉEXISTANT sans BYPASSRLS est restauré sans BYPASSRLS"
else
  fail "[E] service_role reste avec BYPASSRLS=$(role_bypassrls service_role) après le harnais"
fi
if [ "$(role_connlimit authenticated)" = "7" ] && [ "$(role_canlogin authenticated)" = "false" ]; then
  pass "[E] les attributs d'un rôle préexistant (connlimit/login) sont restaurés"
else
  fail "[E] attributs du role authenticated non restaures (connlimit=$(role_connlimit authenticated), login=$(role_canlogin authenticated))"
fi
if [ "$(role_exists anon)" = "0" ]; then
  pass "[G] un rôle CRÉÉ par le harnais est supprimé au nettoyage"
else
  fail "[G] le rôle anon créé par le harnais subsiste"
fi

# ------------------------------------------------------------------
# [F] [I] -- ÉCHEC du harnais : restauration et suppression malgré tout
# ------------------------------------------------------------------
log "=== [F]/[I] exécution interrompue par un échec ==="
psql -X -q -d postgres >/dev/null 2>&1 <<'SQL'
do $$ begin
  if not exists (select from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
alter role service_role nobypassrls connection limit 3;
SQL
psql -X -q -d postgres -c "drop owned by anon;" >/dev/null 2>&1 || true
psql -X -q -d postgres -c "drop role if exists anon;" >/dev/null 2>&1 || true

RC_FAIL="$(run_harness SCANYM_DISPOSABLE_CLUSTER=1 SCANYM_HARNESS_FORCE_FAIL=1)"
if [ "$RC_FAIL" != "0" ]; then
  pass "[F] l'échec forcé fait bien échouer le harnais (rc=$RC_FAIL)"
else
  fail "[F] l'échec forcé n'a pas fait échouer le harnais"
fi
if [ "$(db_count)" = "0" ]; then
  pass "[I] la base jetable est supprimée après un ÉCHEC"
else
  fail "[I] une base jetable subsiste après un échec"
fi
if [ "$(role_bypassrls service_role)" = "false" ] && [ "$(role_connlimit service_role)" = "3" ]; then
  pass "[F] les attributs d'un rôle préexistant sont restaurés APRÈS un échec"
else
  fail "[F] service_role non restauré après échec (bypassrls=$(role_bypassrls service_role), connlimit=$(role_connlimit service_role))"
fi
if [ "$(role_exists anon)" = "0" ]; then
  pass "[G] un rôle créé par le harnais est supprimé même après un échec"
else
  fail "[G] le rôle anon subsiste après un échec"
fi

# ------------------------------------------------------------------
# [J] v2.4 -- NON-DIVULGATION DES SECRETS (TMV23-SECRET-LOGGING-02)
#
# Le chemin de REFUS journalisait la VALEUR de la variable interdite.
# Ces tests injectent une sentinelle dans des variables réellement
# porteuses de secrets et vérifient qu'elle n'apparaît NULLE PART :
# ni stdout, ni stderr, ni aucun fichier de journal produit.
# ------------------------------------------------------------------
log "=== [J] non-divulgation des secrets ==="
SENTINEL="SCANYM_SECRET_SHOULD_NEVER_APPEAR"
LOGDIR="$TMP/logs"

check_no_secret() {
  local label="$1" varname="$2"; shift 2
  rm -rf "$LOGDIR"; mkdir -p "$LOGDIR"
  local rc
  rc="$(run_harness "$@")"
  local out err
  out="$(cat "$TMP/out.txt" 2>/dev/null)"
  err="$(cat "$TMP/err.txt" 2>/dev/null)"

  if [ "$rc" = "2" ]; then
    pass "$label : refus de sûreté (code 2)"
  else
    fail "$label : attendu un refus (code 2), obtenu rc=$rc"
  fi
  if printf '%s' "$err" | grep -q "$varname"; then
    pass "$label : le NOM de la variable est bien signalé"
  else
    fail "$label : le nom « $varname » devrait apparaître dans le diagnostic"
  fi
  if printf '%s%s' "$out" "$err" | grep -q "$SENTINEL"; then
    fail "$label : FUITE — la valeur secrète apparaît dans la sortie"
  else
    pass "$label : la valeur secrète n'apparaît ni sur stdout ni sur stderr"
  fi
  if grep -rq "$SENTINEL" "$LOGDIR" 2>/dev/null; then
    fail "$label : FUITE — la valeur secrète apparaît dans un journal généré"
  else
    pass "$label : aucune trace de la valeur secrète dans les journaux générés"
  fi
}

check_no_secret "[J] PGPASSWORD" "PGPASSWORD" \
  SCANYM_DISPOSABLE_CLUSTER=1 PGPASSWORD="$SENTINEL"
check_no_secret "[J] DATABASE_URL" "DATABASE_URL" \
  SCANYM_DISPOSABLE_CLUSTER=1 DATABASE_URL="postgres://user:$SENTINEL@db.prod.example.com:5432/app"
check_no_secret "[J] POSTGRES_URL" "POSTGRES_URL" \
  SCANYM_DISPOSABLE_CLUSTER=1 POSTGRES_URL="postgres://user:$SENTINEL@db.prod.example.com:5432/app"
check_no_secret "[J] SUPABASE_DB_URL" "SUPABASE_DB_URL" \
  SCANYM_DISPOSABLE_CLUSTER=1 SUPABASE_DB_URL="postgres://user:$SENTINEL@db.prod.example.com:5432/app"
# Variable de type FICHIER : ni le chemin (qui peut nommer un coffre),
# ni a fortiori son contenu, ne doivent être divulgués.
# La sentinelle est placée À LA FOIS dans le CHEMIN et dans le CONTENU :
# le premier prouve que la VALEUR de la variable n'est pas journalisée
# (un chemin peut nommer un coffre ou un projet), le second qu'aucun
# contenu de fichier de secrets n'est lu ni affiché.
PGPASS_SENTINEL_FILE="$TMP/pgpass-$SENTINEL"
printf 'db.prod.example.com:5432:app:user:%s\n' "$SENTINEL" > "$PGPASS_SENTINEL_FILE"
chmod 600 "$PGPASS_SENTINEL_FILE"
check_no_secret "[J] PGPASSFILE" "PGPASSFILE" \
  SCANYM_DISPOSABLE_CLUSTER=1 PGPASSFILE="$PGPASS_SENTINEL_FILE"

# ------------------------------------------------------------------
# [K] v2.4 -- NETTOYAGE FAIL-CLOSED (TMV23-CLEANUP-FAIL-CLOSED-01)
#
# Pannes de nettoyage INJECTÉES de façon déterministe (double verrou
# SCANYM_HARNESS_SELFTEST=1 + SCANYM_HARNESS_FAULT, infra de test
# uniquement). Chaque scénario doit : faire échouer le harnais, nommer
# l'objet en cause, et être détecté par la VÉRIFICATION FINALE relue
# dans PostgreSQL -- jamais par le seul code retour d'un DROP.
# ------------------------------------------------------------------
log "=== [K] pannes de nettoyage injectées ==="

reset_role_fixture() {
  psql -X -q -d postgres >/dev/null 2>&1 <<'SQL'
do $$ begin
  if not exists (select from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end $$;
alter role service_role nobypassrls nologin connection limit 5;
alter role authenticated nobypassrls nologin connection limit -1;
SQL
  psql -X -q -d postgres -c "drop owned by anon;" >/dev/null 2>&1 || true
  psql -X -q -d postgres -c "drop role if exists anon;" >/dev/null 2>&1 || true
}

# La panne est IGNORÉE sans le second verrou : impossible à déclencher
# par accident lors d'une exécution normale.
reset_role_fixture
RC_GUARD="$(run_harness SCANYM_DISPOSABLE_CLUSTER=1 SCANYM_HARNESS_FAULT=drop_database)"
if [ "$RC_GUARD" = "0" ] && [ "$(db_count)" = "0" ]; then
  pass "[K] l'injection de panne est IGNORÉE sans SCANYM_HARNESS_SELFTEST=1 (nettoyage normal)"
else
  fail "[K] l'injection de panne s'est déclenchée sans le second verrou (rc=$RC_GUARD, bases=$(db_count))"
fi

# --- A. Échec de DROP DATABASE -----------------------------------
reset_role_fixture
RC_A="$(run_harness SCANYM_DISPOSABLE_CLUSTER=1 SCANYM_HARNESS_SELFTEST=1 SCANYM_HARNESS_FAULT=drop_database)"
ERR_A="$(cat "$TMP/err.txt" 2>/dev/null)"
if [ "$RC_A" != "0" ]; then
  pass "[K.A] DROP DATABASE en échec -> le harnais sort en erreur (rc=$RC_A)"
else
  fail "[K.A] le harnais a annoncé un succès global malgré un nettoyage raté"
fi
if printf '%s' "$ERR_A" | grep -q "VÉRIFICATION FINALE.*database"; then
  pass "[K.A] la vérification finale relit pg_database et signale la base résiduelle"
else
  fail "[K.A] aucune vérification finale de la base : $(printf '%s' "$ERR_A" | tail -2)"
fi
if printf '%s' "$ERR_A" | grep -q "ÉTAT FINAL NON CONFORME"; then
  pass "[K.A] l'échec de nettoyage est explicitement rapporté"
else
  fail "[K.A] l'échec de nettoyage n'est pas rapporté"
fi
# Réparation par le test lui-même (le harnais, lui, a bien échoué).
for d in $(q "select datname from pg_database where datname ~ '^scanym_tm2_[0-9]+$';"); do
  psql -X -q -d postgres -c "drop database if exists \"$d\" with (force);" >/dev/null 2>&1
done
if [ "$(db_count)" = "0" ]; then
  pass "[K.A] état remis en ordre par le test après la panne injectée"
else
  fail "[K.A] base résiduelle non nettoyable"
fi

# --- B. Échec de DROP ROLE ---------------------------------------
reset_role_fixture
RC_B="$(run_harness SCANYM_DISPOSABLE_CLUSTER=1 SCANYM_HARNESS_SELFTEST=1 SCANYM_HARNESS_FAULT=drop_role)"
ERR_B="$(cat "$TMP/err.txt" 2>/dev/null)"
if [ "$RC_B" != "0" ]; then
  pass "[K.B] DROP ROLE en échec -> le harnais sort en erreur (rc=$RC_B)"
else
  fail "[K.B] le harnais a annoncé un succès malgré un rôle résiduel"
fi
if printf '%s' "$ERR_B" | grep -q "VÉRIFICATION FINALE.*role.*anon"; then
  pass "[K.B] la vérification post-nettoyage relit pg_roles et détecte le rôle résiduel"
else
  fail "[K.B] rôle résiduel non détecté : $(printf '%s' "$ERR_B" | tail -2)"
fi
if [ "$(role_exists anon)" = "1" ]; then
  pass "[K.B] le rôle créé par le harnais est bien resté (panne fidèlement simulée)"
else
  fail "[K.B] la panne n'a pas laissé le rôle en place"
fi
psql -X -q -d postgres -c "drop owned by anon;" >/dev/null 2>&1 || true
psql -X -q -d postgres -c "drop role if exists anon;" >/dev/null 2>&1 || true
[ "$(role_exists anon)" = "0" ] && pass "[K.B] état remis en ordre par le test" \
  || fail "[K.B] rôle résiduel non nettoyable"

# --- C. Échec de restauration ALTER ROLE -------------------------
reset_role_fixture
RC_C="$(run_harness SCANYM_DISPOSABLE_CLUSTER=1 SCANYM_HARNESS_SELFTEST=1 SCANYM_HARNESS_FAULT=alter_role)"
ERR_C="$(cat "$TMP/err.txt" 2>/dev/null)"
if [ "$RC_C" != "0" ]; then
  pass "[K.C] ALTER ROLE non restauré -> le harnais sort en erreur (rc=$RC_C)"
else
  fail "[K.C] le harnais a annoncé un succès malgré des attributs de rôle non restaurés"
fi
if printf '%s' "$ERR_C" | grep -q "attributs différents de l'instantané"; then
  pass "[K.C] l'écart avec l'instantané de rôles est détecté par relecture"
else
  fail "[K.C] écart d'attributs non détecté : $(printf '%s' "$ERR_C" | tail -2)"
fi
# La panne laisse service_role tel que le harnais l'avait mis
# (BYPASSRLS) : c'est EXACTEMENT le risque signalé par l'audit v2.3.
if [ "$(role_bypassrls service_role)" = "true" ]; then
  pass "[K.C] la panne reproduit le risque réel (service_role reste avec BYPASSRLS)"
else
  pass "[K.C] la panne a laissé un état non conforme, détecté par la vérification finale"
fi
reset_role_fixture
if [ "$(role_bypassrls service_role)" = "false" ]; then
  pass "[K.C] état remis en ordre par le test"
else
  fail "[K.C] service_role toujours avec BYPASSRLS après remise en ordre"
fi

# --- Vérifications post-nettoyage en exécution NOMINALE ------------
reset_role_fixture
RC_OK2="$(run_harness SCANYM_DISPOSABLE_CLUSTER=1)"
ERR_OK2="$(cat "$TMP/err.txt" 2>/dev/null)"
if [ "$RC_OK2" = "0" ]; then
  pass "[K] exécution nominale : code de sortie 0"
else
  fail "[K] exécution nominale en échec (rc=$RC_OK2)"
fi
if printf '%s' "$ERR_OK2" | grep -q "état final vérifié"; then
  pass "[K] l'état final est vérifié et annoncé même en cas de succès"
else
  fail "[K] aucune vérification d'état final en exécution nominale"
fi
[ "$(db_count)" = "0" ] && pass "[K] vérification post-nettoyage : aucune base jetable" \
  || fail "[K] base jetable résiduelle après exécution nominale"
[ "$(role_exists anon)" = "0" ] && pass "[K] vérification post-nettoyage : aucun rôle créé résiduel" \
  || fail "[K] rôle anon résiduel après exécution nominale"
if [ "$(role_bypassrls service_role)" = "false" ] && [ "$(role_connlimit service_role)" = "5" ]; then
  pass "[K] vérification post-nettoyage : rôle préexistant identique à l'instantané"
else
  fail "[K] service_role non restauré (bypassrls=$(role_bypassrls service_role), connlimit=$(role_connlimit service_role))"
fi

# Remise de l'état de départ le plus neutre possible pour ce cluster.
psql -X -q -d postgres -c "alter role service_role connection limit -1;" >/dev/null 2>&1 || true
psql -X -q -d postgres -c "alter role authenticated connection limit -1;" >/dev/null 2>&1 || true

echo
log "================= RÉSULTAT SÛRETÉ ================="
log "PASS: $PASS   FAIL: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  log "--- échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
