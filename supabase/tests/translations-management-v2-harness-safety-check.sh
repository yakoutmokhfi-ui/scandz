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
