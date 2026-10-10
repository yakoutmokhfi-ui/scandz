#!/usr/bin/env bash
# ============================================================
# Scanym — CATALOGUE PRODUCT REORDER v1 — SONDES DE SÛRETÉ du harnais
# PostgreSQL (remédiation CPR-AUDIT-02, « MANDATORY CPR-02 TESTS »).
#
# Ce script ne teste PAS le lot : il teste le HARNAIS
# (catalogue-product-reorder-v1-check.sh) et sa bibliothèque de sûreté
# (catalogue-product-reorder-v1-harness-lib.sh). Il prouve, par
# l'exécution, que le harnais ne peut ni viser un serveur qu'il n'a pas
# créé, ni détruire une ressource qui n'est pas la sienne.
#
#   HARNESS-01  sans consentement explicite : sortie non nulle AVANT
#               toute commande PostgreSQL ;
#   HARNESS-02  PGHOST (et PGHOSTADDR, PGPORT, PGDATABASE, PGUSER)
#               hérité pointant ailleurs : refusé avant toute commande ;
#   HARNESS-03  PGSERVICE / PGSERVICEFILE hérités : ne redirigent rien ;
#   HARNESS-04  PGPASSWORD hérité : jamais affiché, ne redirige rien ;
#   HARNESS-05  base préexistante au nom semblable : jamais supprimée ;
#   HARNESS-06  nettoyage après un échec en cours d'exécution : seules
#               les ressources de l'exécution sont retirées ;
#   HARNESS-07  identité du serveur non conforme : arrêt AVANT
#               DROP DATABASE ;
#   HARNESS-08  exécution normale isolée : toutes les preuves, dont la
#               concurrence réelle, passent toujours.
#
# ------------------------------------------------------------------
# LES TROIS INSTRUMENTS DE MESURE
# ------------------------------------------------------------------
# 1. LE TÉMOIN. Un second cluster PostgreSQL, créé par CE script dans
#    son propre répertoire temporaire. Il joue le rôle du « serveur de
#    quelqu'un d'autre » : il contient des bases dont le nom ressemble à
#    celles du harnais (y compris le schéma de nommage de la première
#    version, scanym_cpr1_tpl_<pid>), chacune avec une ligne
#    sentinelle. Il journalise chaque connexion et chaque instruction.
#    Après chaque sonde : mêmes bases (mêmes OID), mêmes sentinelles,
#    AUCUNE connexion reçue.
#
# 2. LE FIL-PIÈGE. Un répertoire de faux binaires (psql, createdb,
#    dropdb, initdb, pg_ctl, postgres…) qui consignent leur appel puis
#    échouent. Les sondes de refus s'exécutent avec ce répertoire pour
#    seuls binaires PostgreSQL : un journal vide prouve qu'AUCUNE
#    commande PostgreSQL n'a été lancée avant le refus. Un contrôle
#    positif prouve que le fil-piège se déclenche bien dès que le
#    harnais franchit son verrou.
#
# 3. L'APPÂT « EMPLACEMENT PAR DÉFAUT » (optionnel). Avec
#    SCANYM_HARNESS_DEFAULT_SOCKET_BAIT=1, et seulement si le socket
#    par défaut du poste est libre, le témoin écoute AUSSI là où un
#    `psql` sans aucun paramètre se connecterait. Une exécution normale
#    du harnais doit alors le laisser sans une seule connexion : preuve
#    directe qu'aucun défaut ambiant n'est utilisé. Sans cette option,
#    la sonde est notée SKIP (le reste ne dépend pas d'elle).
#
# Ce script applique à lui-même les règles qu'il vérifie : consentement
# explicite, environnement sans configuration de connexion, pas de
# root, nettoyage borné à ce qu'il a créé.
#
# Usage, depuis la racine du dépôt, sous un utilisateur ordinaire :
#   SCANYM_DISPOSABLE_CLUSTER=1 \
#     bash supabase/tests/catalogue-product-reorder-v1-harness-safety-check.sh
# ============================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HARNESS="$SCRIPT_DIR/catalogue-product-reorder-v1-check.sh"
LIB="$SCRIPT_DIR/catalogue-product-reorder-v1-harness-lib.sh"

PASS=0
FAIL=0
SKIP=0
log()  { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS=$((PASS+1)); log "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); log "FAIL: $1"; }
skip() { SKIP=$((SKIP+1)); log "SKIP: $1"; }
fatal() { log "FATAL: $*"; exit 1; }
check() { # check <libellé> <commande…> : PASS si la commande réussit
  local label="$1"; shift
  if "$@"; then pass "$label"; else fail "$label"; fi
}
eq() { [ "$1" = "$2" ]; }

# ------------------------------------------------------------------
# Ce script crée lui aussi un cluster : mêmes règles d'entrée.
# ------------------------------------------------------------------
# shellcheck source=catalogue-product-reorder-v1-harness-lib.sh
. "$LIB"
harness_safety_gate
REAL_BIN="$H_BIN"

BAIT_REQUESTED="${SCANYM_HARNESS_DEFAULT_SOCKET_BAIT:-0}"

P_DIR="$(mktemp -d "${TMPDIR:-/tmp}/scanym-cpr1-probe.XXXXXXXXXX")" || fatal "mktemp"
P_DIR="$(cd "$P_DIR" && pwd -P)"
P_MARK="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s\n' "$P_MARK" > "$P_DIR/.scanym-probe-owner"

W_DATA="$P_DIR/witness/data"
W_SOCK="$P_DIR/witness/sock"
W_LOG="$P_DIR/witness/postmaster.log"
W_PORT=$(( 20000 + ( 16#${P_MARK:0:4} % 40000 ) ))
W_STARTED=0
DEFAULT_BAIT=0
DEFAULT_SOCKET_DIR="/var/run/postgresql"

probe_cleanup() {
  local pid cmd
  [ -n "${P_DIR:-}" ] && [ -f "$P_DIR/.scanym-probe-owner" ] \
    && [ "$(cat "$P_DIR/.scanym-probe-owner" 2>/dev/null)" = "$P_MARK" ] || return 0
  if [ -f "$W_DATA/postmaster.pid" ]; then
    pid="$(head -1 "$W_DATA/postmaster.pid" 2>/dev/null | tr -cd '0-9')"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
      case "$cmd" in
        *"$W_DATA"*) env -i PATH="$REAL_BIN:/usr/bin:/bin" LC_ALL=C "$REAL_BIN/pg_ctl" -D "$W_DATA" -m immediate -w -t 30 stop >/dev/null 2>&1 || true ;;
      esac
    fi
  fi
  # Tout cluster de sonde encore vivant sous NOTRE répertoire.
  for pidfile in "$P_DIR"/*/scanym-cpr1.*/data/postmaster.pid "$P_DIR"/*/*/scanym-cpr1.*/data/postmaster.pid; do
    [ -f "$pidfile" ] || continue
    pid="$(head -1 "$pidfile" 2>/dev/null | tr -cd '0-9')"
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || continue
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    case "$cmd" in *"$P_DIR"*) kill -9 "$pid" 2>/dev/null || true ;; esac
  done
  rm -rf -- "$P_DIR"
}
trap probe_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# psql RÉEL vers le TÉMOIN, cible explicite, environnement vide.
wpsql() {
  local db="$1"; shift
  env -i PATH="$REAL_BIN:/usr/bin:/bin" LC_ALL=C PGCLIENTENCODING=UTF8 \
    "$REAL_BIN/psql" -X -h "$W_SOCK" -p "$W_PORT" -U postgres -d "$db" "$@"
}

# ============================================================
log "=== Préparation : cluster TÉMOIN, fil-piège, faux répertoire d'une autre exécution ==="
mkdir -p "$P_DIR/witness" && mkdir -m 700 "$W_SOCK" || fatal "répertoire témoin"
env -i PATH="$REAL_BIN:/usr/bin:/bin" LC_ALL=C "$REAL_BIN/initdb" -D "$W_DATA" -U postgres -A trust -E UTF8 --locale=C -N >"$P_DIR/witness/initdb.log" 2>&1 \
  || fatal "initdb du témoin : $(tail -2 "$P_DIR/witness/initdb.log" | tr '\n' ' ')"

W_SOCKETS="$W_SOCK"
if [ "$BAIT_REQUESTED" = "1" ]; then
  if [ -d "$DEFAULT_SOCKET_DIR" ] && [ -w "$DEFAULT_SOCKET_DIR" ] \
     && [ ! -e "$DEFAULT_SOCKET_DIR/.s.PGSQL.5432" ] && [ ! -e "$DEFAULT_SOCKET_DIR/.s.PGSQL.5432.lock" ]; then
    W_PORT=5432
    W_SOCKETS="$W_SOCK, $DEFAULT_SOCKET_DIR"
    DEFAULT_BAIT=1
  else
    log "appât « emplacement par défaut » demandé mais indisponible ($DEFAULT_SOCKET_DIR absent, non inscriptible ou déjà occupé) : sonde notée SKIP."
  fi
fi
cat >> "$W_DATA/postgresql.conf" <<CONF

# --- Scanym : cluster TÉMOIN des sondes de sûreté ---
listen_addresses = ''
unix_socket_directories = '$W_SOCKETS'
port = $W_PORT
log_connections = on
log_statement = 'all'
fsync = off
scanym.witness = '$P_MARK'
CONF
env -i PATH="$REAL_BIN:/usr/bin:/bin" LC_ALL=C "$REAL_BIN/pg_ctl" -D "$W_DATA" -l "$W_LOG" -w -t 60 start >"$P_DIR/witness/pg_ctl.log" 2>&1 \
  || fatal "démarrage du témoin : $(tail -3 "$W_LOG" 2>/dev/null | tr '\n' ' ')"
W_STARTED=1

# Bases « de quelqu'un d'autre », aux noms semblables à ceux du harnais.
LOOKALIKES="scanym_cpr1_tpl_4242 scanym_cpr1_4242 scanym_cpr1_scratch_4242 scanym_cpr1_main_0123456789ab scanym_cpr1_tpl_0123456789ab"
for d in $LOOKALIKES; do
  wpsql postgres -q -c "create database \"$d\";" || fatal "création témoin $d"
  wpsql "$d" -q -c "create table public.sentinel (v text); insert into public.sentinel values ('$d:$P_MARK');" || fatal "sentinelle $d"
done

# État complet du témoin : chaque base, son OID (une base supprimée
# puis recréée change d'OID) et sa sentinelle.
witness_state() {
  local d out
  out="$(wpsql postgres -A -t -q -c "select string_agg(datname || ':' || oid, ',' order by datname) from pg_database;" 2>/dev/null)"
  for d in $LOOKALIKES; do
    out="$out|$(wpsql "$d" -A -t -q -c "select v from public.sentinel;" 2>/dev/null)"
  done
  printf '%s' "$out"
}
# Connexions REÇUES par le témoin (chaque lecture ci-dessus en ajoute :
# toujours relever le compteur AVANT de lire l'état).
witness_connections() { grep -c "connection received" "$W_LOG" 2>/dev/null || true; }
witness_statements() { grep -ci "statement: \(drop\|create\|alter\) database" "$W_LOG" 2>/dev/null || true; }

W_STATE="$(witness_state)"
[ -n "$W_STATE" ] || fatal "état du témoin illisible"
log "témoin prêt : $(echo $LOOKALIKES | wc -w) bases au nom semblable, socket $W_SOCK, port $W_PORT$( [ "$DEFAULT_BAIT" = 1 ] && echo " + emplacement par défaut $DEFAULT_SOCKET_DIR" )."

# Fil-piège : faux binaires PostgreSQL.
SHIM="$P_DIR/shim"
TRIPWIRE="$P_DIR/tripwire.log"
mkdir "$SHIM"
for b in psql createdb dropdb createuser dropuser initdb pg_ctl postgres pg_dump pg_dumpall pg_restore pg_isready pg_basebackup vacuumdb reindexdb clusterdb; do
  printf '#!/bin/sh\necho "%s" >> "%s"\nexit 97\n' "$b" "$TRIPWIRE" > "$SHIM/$b"
  chmod 755 "$SHIM/$b"
done
: > "$TRIPWIRE"

# Répertoire d'une AUTRE exécution du harnais (même forme de nom, autre
# nonce) : ne doit jamais être supprimé par un nettoyage.
plant_foreign_dir() { # $1 = TMPDIR d'une sonde
  mkdir -p "$1/scanym-cpr1.FOREIGNRUN" || return 1
  printf '%s\n' "00000000000000000000000000000000" > "$1/scanym-cpr1.FOREIGNRUN/.scanym-harness-owner"
  printf 'données d une autre exécution\n' > "$1/scanym-cpr1.FOREIGNRUN/keep.txt"
}
foreign_dir_intact() {
  [ -f "$1/scanym-cpr1.FOREIGNRUN/keep.txt" ] && [ -f "$1/scanym-cpr1.FOREIGNRUN/.scanym-harness-owner" ]
}
# Le TMPDIR d'une sonde ne contient plus que le répertoire étranger.
only_foreign_left() {
  local left
  left="$(ls -A "$1" 2>/dev/null | tr '\n' ' ')"
  [ "$left" = "scanym-cpr1.FOREIGNRUN " ] || { log "      contenu inattendu de $1 : $left"; return 1; }
}
# Un processus RÉELLEMENT en cours : ni absent, ni zombie (un
# postmaster terminé peut rester « defunct » tant que son parent ne l'a
# pas récolté ; `kill -0` le verrait encore).
pid_running() {
  local st
  st="$(ps -o stat= -p "$1" 2>/dev/null | tr -d ' ')"
  [ -n "$st" ] || return 1
  case "$st" in Z*) return 1 ;; esac
  return 0
}
no_harness_postmaster_under() { ! ps -eo command= 2>/dev/null | grep -F -- "$1/scanym-cpr1." | grep -v grep | grep -q postgres; }

# run_refusal <fichier de sortie> <TMPDIR> [VAR=valeur…]
#   Lance le harnais avec le FIL-PIÈGE pour seuls binaires PostgreSQL.
run_refusal() {
  local out="$1" tmp="$2"; shift 2
  mkdir -p "$tmp"
  env -i PATH="$SHIM:/usr/bin:/bin" HOME="$P_DIR/home" TMPDIR="$tmp" SCANYM_PG_BINDIR="$SHIM" "$@" \
    bash "$HARNESS" >"$out" 2>&1
}

# expect_refusal <sonde> <libellé> <rc> <sortie> <TMPDIR> <connexions avant> <fil-piège avant> [nom de variable attendu]
expect_refusal() {
  local id="$1" label="$2" rc="$3" out="$4" tmp="$5" c0="$6" t0="$7" var="${8:-}"
  local c1 t1 ok=1 why=""
  c1="$(witness_connections)"
  t1="$(wc -l < "$TRIPWIRE" | tr -d ' ')"
  [ "$rc" = "2" ] || { ok=0; why="$why code de sortie $rc (attendu 2) ;"; }
  grep -q "REFUS DE SÛRETÉ" "$out" || { ok=0; why="$why pas de message de refus ;"; }
  grep -q "Aucune commande PostgreSQL n'a été exécutée" "$out" || { ok=0; why="$why pas d'attestation « aucune commande » ;"; }
  if [ -n "$var" ]; then grep -q "REFUS DE SÛRETÉ : $var est définie" "$out" || { ok=0; why="$why la variable $var n'est pas nommée ;"; }; fi
  [ "$t1" = "$t0" ] || { ok=0; why="$why $((t1 - t0)) commande(s) PostgreSQL lancée(s) avant le refus : $(tail -n "$((t1 - t0))" "$TRIPWIRE" | tr '\n' ' ') ;"; }
  [ -z "$(ls -A "$tmp" 2>/dev/null)" ] || { ok=0; why="$why des fichiers ont été créés ($(ls -A "$tmp" | tr '\n' ' ')) ;"; }
  [ "$c1" = "$c0" ] || { ok=0; why="$why le témoin a reçu $((c1 - c0)) connexion(s) ;"; }
  ! grep -q "PASS:" "$out" || { ok=0; why="$why des preuves fonctionnelles ont été exécutées ;"; }
  [ "$(witness_state)" = "$W_STATE" ] || { ok=0; why="$why l'état du témoin a changé ;"; }
  if [ "$ok" = "1" ]; then
    pass "$id — $label : refusé (code 2) AVANT toute commande PostgreSQL (fil-piège muet, aucun fichier créé, témoin sans connexion et intact)"
  else
    fail "$id — $label :$why sortie : $(tr '\n' ' ' < "$out" | cut -c1-240)"
  fi
}

mkdir -p "$P_DIR/home"
# next_tmp : un TMPDIR NEUF par sonde, rendu dans $T. (Appelée
# directement, jamais par substitution de commande : le compteur doit
# survivre.)
N=0
T=""
next_tmp() { N=$((N+1)); T="$P_DIR/t$N"; }

# ============================================================
log "=== HARNESS-01 — sans consentement explicite ==="
for variant in "" "SCANYM_DISPOSABLE_CLUSTER=0" "SCANYM_DISPOSABLE_CLUSTER=true" "SCANYM_DISPOSABLE_CLUSTER=yes" "SCANYM_DISPOSABLE_CLUSTER=" "SCANYM_DISPOSABLE_CLUSTER=11"; do
  next_tmp; C0="$(witness_connections)"; T0="$(wc -l < "$TRIPWIRE" | tr -d ' ')"
  if [ -n "$variant" ]; then run_refusal "$P_DIR/out.txt" "$T" "$variant"; else run_refusal "$P_DIR/out.txt" "$T"; fi
  expect_refusal "HARNESS-01" "consentement « ${variant:-absent} »" "$?" "$P_DIR/out.txt" "$T" "$C0" "$T0"
done

# Contrôle POSITIF du fil-piège : dès que le verrou d'entrée est
# franchi (consentement donné, environnement propre), la première
# commande PostgreSQL (initdb) EST interceptée. Les sondes ci-dessus et
# ci-dessous mesurent donc bien quelque chose.
next_tmp; T0="$(wc -l < "$TRIPWIRE" | tr -d ' ')"
run_refusal "$P_DIR/out.txt" "$T" "SCANYM_DISPOSABLE_CLUSTER=1"
RC=$?
T1="$(wc -l < "$TRIPWIRE" | tr -d ' ')"
if [ "$T1" -gt "$T0" ] && [ "$(sed -n "$((T0+1))p" "$TRIPWIRE")" = "initdb" ] && grep -q "verrou d'entrée franchi" "$P_DIR/out.txt"; then
  pass "HARNESS-01 — contrôle positif : avec le consentement, la première commande PostgreSQL (initdb) déclenche bien le fil-piège"
else
  fail "HARNESS-01 — contrôle positif du fil-piège (rc=$RC, fil-piège $T0 -> $T1) : $(tr '\n' ' ' < "$P_DIR/out.txt" | cut -c1-240)"
fi
# … et cet échec d'initdb est déjà un « échec partiel » : rien ne reste.
if [ "$RC" -ne 0 ] && [ -z "$(ls -A "$T" 2>/dev/null)" ]; then
  pass "HARNESS-06 — échec d'initdb (avant même l'existence du cluster) : sortie non nulle, le répertoire de l'exécution est retiré, rien d'autre n'est touché"
else
  fail "HARNESS-06 — échec d'initdb : rc=$RC, restes : $(ls -A "$T" 2>/dev/null | tr '\n' ' ')"
fi

# ============================================================
log "=== HARNESS-02 — variables de connexion héritées pointant ailleurs ==="
next_tmp; C0="$(witness_connections)"; T0="$(wc -l < "$TRIPWIRE" | tr -d ' ')"
run_refusal "$P_DIR/out.txt" "$T" "SCANYM_DISPOSABLE_CLUSTER=1" "PGHOST=$W_SOCK" "PGPORT=$W_PORT"
expect_refusal "HARNESS-02" "PGHOST + PGPORT hérités pointant sur le TÉMOIN" "$?" "$P_DIR/out.txt" "$T" "$C0" "$T0" "PGHOST"
for pair in "PGHOST=db.exemple-heberge.invalid" "PGHOSTADDR=203.0.113.7" "PGPORT=$W_PORT" "PGDATABASE=scanym_cpr1_tpl_4242" "PGUSER=postgres" "PGCLUSTER=16/main"; do
  next_tmp; C0="$(witness_connections)"; T0="$(wc -l < "$TRIPWIRE" | tr -d ' ')"
  run_refusal "$P_DIR/out.txt" "$T" "SCANYM_DISPOSABLE_CLUSTER=1" "$pair"
  expect_refusal "HARNESS-02" "${pair%%=*} hérité seul" "$?" "$P_DIR/out.txt" "$T" "$C0" "$T0" "${pair%%=*}"
done

# ============================================================
log "=== HARNESS-03 — PGSERVICE / PGSERVICEFILE hérités ==="
SERVICE_FILE="$P_DIR/pg_service.conf"
cat > "$SERVICE_FILE" <<CONF
[ailleurs]
host=$W_SOCK
port=$W_PORT
user=postgres
dbname=scanym_cpr1_tpl_4242
CONF
mkdir -p "$P_DIR/sysconf" && cp "$SERVICE_FILE" "$P_DIR/sysconf/pg_service.conf"
# Contrôle positif : ce fichier de service ROUTE bien un psql ordinaire
# vers le témoin (sinon les sondes ne prouveraient rien).
ROUTED="$(env -i PATH="$REAL_BIN:/usr/bin:/bin" LC_ALL=C PGSERVICE=ailleurs PGSERVICEFILE="$SERVICE_FILE" "$REAL_BIN/psql" -X -A -t -q -c "select current_setting('scanym.witness', true) || '/' || current_database();" 2>/dev/null)"
check "HARNESS-03 — contrôle positif : PGSERVICE + PGSERVICEFILE routent bien un psql ordinaire vers le témoin" eq "$ROUTED" "$P_MARK/scanym_cpr1_tpl_4242"

next_tmp; C0="$(witness_connections)"; T0="$(wc -l < "$TRIPWIRE" | tr -d ' ')"
run_refusal "$P_DIR/out.txt" "$T" "SCANYM_DISPOSABLE_CLUSTER=1" "PGSERVICE=ailleurs" "PGSERVICEFILE=$SERVICE_FILE"
expect_refusal "HARNESS-03" "PGSERVICE + PGSERVICEFILE hérités" "$?" "$P_DIR/out.txt" "$T" "$C0" "$T0" "PGSERVICE"
for pair in "PGSERVICE=ailleurs" "PGSERVICEFILE=$SERVICE_FILE" "PGSYSCONFDIR=$P_DIR/sysconf"; do
  next_tmp; C0="$(witness_connections)"; T0="$(wc -l < "$TRIPWIRE" | tr -d ' ')"
  run_refusal "$P_DIR/out.txt" "$T" "SCANYM_DISPOSABLE_CLUSTER=1" "$pair"
  expect_refusal "HARNESS-03" "${pair%%=*} hérité seul" "$?" "$P_DIR/out.txt" "$T" "$C0" "$T0" "${pair%%=*}"
done

# ============================================================
log "=== HARNESS-04 — PGPASSWORD hérité : jamais affiché, ne redirige rien ==="
SECRET="s3cr3t-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
PASSFILE="$P_DIR/pgpass"
printf '%s:%s:*:postgres:%s\n' "$W_SOCK" "$W_PORT" "$SECRET" > "$PASSFILE"; chmod 600 "$PASSFILE"
: > "$P_DIR/all-outputs.txt"
for pair in "PGPASSWORD=$SECRET" "PGPASSFILE=$PASSFILE" "DATABASE_URL=postgres://postgres:$SECRET@db.exemple-heberge.invalid:5432/postgres" "SUPABASE_DB_URL=postgresql://postgres:$SECRET@db.exemple-heberge.invalid:6543/postgres"; do
  next_tmp; C0="$(witness_connections)"; T0="$(wc -l < "$TRIPWIRE" | tr -d ' ')"
  run_refusal "$P_DIR/out.txt" "$T" "SCANYM_DISPOSABLE_CLUSTER=1" "$pair"
  RC=$?
  cat "$P_DIR/out.txt" >> "$P_DIR/all-outputs.txt"
  expect_refusal "HARNESS-04" "${pair%%=*} hérité" "$RC" "$P_DIR/out.txt" "$T" "$C0" "$T0" "${pair%%=*}"
done
# Mot de passe accompagné d'une cible : toujours refusé, toujours muet.
next_tmp; C0="$(witness_connections)"; T0="$(wc -l < "$TRIPWIRE" | tr -d ' ')"
run_refusal "$P_DIR/out.txt" "$T" "SCANYM_DISPOSABLE_CLUSTER=1" "PGPASSWORD=$SECRET" "PGHOST=$W_SOCK" "PGPORT=$W_PORT" "PGUSER=postgres"
RC=$?
cat "$P_DIR/out.txt" >> "$P_DIR/all-outputs.txt"
expect_refusal "HARNESS-04" "PGPASSWORD + PGHOST + PGPORT + PGUSER hérités (cible : le témoin)" "$RC" "$P_DIR/out.txt" "$T" "$C0" "$T0"
if ! grep -qF -- "$SECRET" "$P_DIR/all-outputs.txt" && ! grep -qF -- "exemple-heberge" "$P_DIR/all-outputs.txt" && ! grep -qF -- "$PASSFILE" "$P_DIR/all-outputs.txt"; then
  pass "HARNESS-04 — le secret, l'URL de connexion et le chemin du fichier de mots de passe n'apparaissent dans AUCUNE sortie (seuls des NOMS de variables sont journalisés)"
else
  fail "HARNESS-04 — une valeur héritée apparaît dans une sortie du harnais"
fi

# ============================================================
log "=== HARNESS-02/03/04 (seconde barrière) — au-delà du verrou, aucune variable n'atteint libpq ==="
# Le verrou d'entrée REFUSE ces variables. On prouve ici, en plus, que
# même une variable apparue APRÈS le verrou ne peut rien rediriger :
# chaque appel passe par `hpsql` (environnement vide, cible explicite).
next_tmp; mkdir -p "$T"
C0="$(witness_connections)"
(
  export TMPDIR="$T"
  . "$LIB"
  harness_safety_gate >/dev/null
  trap harness_cleanup EXIT
  harness_start_cluster >/dev/null || exit 90
  # Variables hostiles, exportées APRÈS le verrou : toutes vers le témoin.
  export PGHOST="$W_SOCK" PGPORT="$W_PORT" PGUSER="postgres" PGDATABASE="scanym_cpr1_tpl_4242"
  export PGSERVICE="ailleurs" PGSERVICEFILE="$SERVICE_FILE" PGSYSCONFDIR="$P_DIR/sysconf"
  export PGPASSWORD="$SECRET" PGPASSFILE="$PASSFILE" PGOPTIONS="-c role=nobody_such_role"
  {
    echo "nonce=$(hpsql postgres -A -t -q -c "select current_setting('scanym.harness_run_nonce', true);")"
    echo "expected=$H_NONCE"
    echo "witness=$(hpsql postgres -A -t -q -c "select coalesce(current_setting('scanym.witness', true), 'aucun');")"
    echo "datadir=$(hpsql postgres -A -t -q -c "select current_setting('data_directory');")"
    echo "expected_datadir=$H_DATA"
    harness_prove_identity; echo "identity_rc=$?"
    harness_create_db "scanym_cpr1_tpl_4242"; echo "create_rc=$?"
    echo "own_has=$(hpsql postgres -A -t -q -c "select count(*) from pg_database where datname = 'scanym_cpr1_tpl_4242';")"
    echo "own_sentinel=$(hpsql scanym_cpr1_tpl_4242 -A -t -q -c "select count(*) from pg_tables where tablename = 'sentinel';")"
    harness_drop_db "scanym_cpr1_tpl_4242"; echo "drop_rc=$?"
    # Une commande en ÉCHEC ne doit pas davantage révéler de secret.
    hpsql base_inexistante -c "select 1" 2>&1; echo "fail_rc=$?"
  } > "$P_DIR/layer2.txt" 2>&1
)
C1="$(witness_connections)"
L2="$P_DIR/layer2.txt"
check "seconde barrière — le serveur joint malgré PGHOST/PGPORT/PGSERVICE hostiles est le cluster de l'exécution (nonce, data_directory)" \
  eq "$(grep '^nonce=' "$L2" | cut -d= -f2)|$(grep '^datadir=' "$L2" | cut -d= -f2)" "$(grep '^expected=' "$L2" | cut -d= -f2)|$(grep '^expected_datadir=' "$L2" | cut -d= -f2)"
check "seconde barrière — … et non le témoin (aucun marqueur du témoin sur le serveur joint)" eq "$(grep '^witness=' "$L2" | cut -d= -f2)" "aucun"
check "seconde barrière — preuve d'identité, création puis suppression d'une base au nom IDENTIQUE à une base du témoin : tout s'exécute sur le cluster de l'exécution (0 / 0 / 0)" \
  eq "$(grep -E '^(identity|create|drop)_rc=' "$L2" | cut -d= -f2 | tr '\n' '/')" "0/0/0/"
check "seconde barrière — la base créée est une base NEUVE du cluster de l'exécution (sans la sentinelle du témoin)" \
  eq "$(grep '^own_has=' "$L2" | cut -d= -f2)/$(grep '^own_sentinel=' "$L2" | cut -d= -f2)" "1/0"
check "seconde barrière — PGOPTIONS hostile ignoré (aucune erreur de rôle), PGPASSWORD jamais affiché, y compris sur une commande en échec" \
  bash -c "! grep -qF -- '$SECRET' '$L2' && ! grep -q 'nobody_such_role' '$L2' && grep -q '^fail_rc=2' '$L2'"
check "seconde barrière — le témoin n'a reçu AUCUNE connexion" eq "$C1" "$C0"
check "seconde barrière — le témoin est intact (mêmes bases, mêmes OID, mêmes sentinelles)" eq "$(witness_state)" "$W_STATE"
check "seconde barrière — le cluster de cette sonde a été arrêté et retiré" bash -c "[ -z \"\$(ls -A '$T' 2>/dev/null)\" ]"

# ============================================================
log "=== HARNESS-05 — base préexistante au nom semblable : jamais supprimée ==="
next_tmp; mkdir -p "$T"
C0="$(witness_connections)"
(
  export TMPDIR="$T"
  . "$LIB"
  harness_safety_gate >/dev/null
  trap harness_cleanup EXIT
  harness_start_cluster >/dev/null || exit 90
  # La base porte EXACTEMENT le nom que le harnais s'apprête à utiliser
  # pour sa base modèle, mais elle a été créée HORS du registre : pour
  # le harnais, c'est la base de quelqu'un d'autre.
  NAME="scanym_cpr1_tpl_$H_TAG"
  hpsql postgres -q -c "create database \"$NAME\";"
  hpsql "$NAME" -q -c "create table public.sentinel (v text); insert into public.sentinel values ('préexistante');"
  {
    echo "oid_before=$(hpsql postgres -A -t -q -c "select oid from pg_database where datname = '$NAME';")"
    harness_create_db "$NAME"; echo "create_rc=$?"
    harness_drop_db "$NAME"; echo "drop_rc=$?"
    harness_create_db "scanym_cpr1_main_$H_TAG" "$NAME"; echo "clone_from_untracked_rc=$?"
    echo "oid_after=$(hpsql postgres -A -t -q -c "select oid from pg_database where datname = '$NAME';")"
    echo "sentinel=$(hpsql "$NAME" -A -t -q -c "select v from public.sentinel;")"
    echo "tracked=${#H_CREATED_DBS[@]}"
    # Une base du REGISTRE, elle, se supprime -- et seulement elle.
    harness_create_db "scanym_cpr1_scratch_$H_TAG"; echo "own_create_rc=$?"
    harness_drop_db "scanym_cpr1_scratch_$H_TAG"; echo "own_drop_rc=$?"
    harness_drop_db "scanym_cpr1_scratch_$H_TAG"; echo "second_drop_rc=$?"
    harness_drop_db "postgres"; echo "drop_postgres_rc=$?"
    harness_drop_db "template1"; echo "drop_template1_rc=$?"
    harness_drop_db 'x"; drop database postgres; --'; echo "drop_injection_rc=$?"
    echo "dbs=$(hpsql postgres -A -t -q -c "select string_agg(datname, ',' order by datname) from pg_database;")"
    echo "expected_dbs=postgres,$NAME,template0,template1"
  } > "$P_DIR/h5.txt" 2>&1
)
H5="$P_DIR/h5.txt"
v() { grep "^$1=" "$2" | head -1 | cut -d= -f2-; }
check "HARNESS-05 — création sur un nom DÉJÀ PRIS par une base non créée par l'exécution : refusée (code 2), la base n'est ni remplacée ni supprimée" eq "$(v create_rc "$H5")" "2"
check "HARNESS-05 — suppression d'une base préexistante au nom du harnais : REFUSÉE (code 2, hors registre)" eq "$(v drop_rc "$H5")" "2"
check "HARNESS-05 — une base hors registre ne peut pas non plus servir de modèle (code 2)" eq "$(v clone_from_untracked_rc "$H5")" "2"
check "HARNESS-05 — la base préexistante est INTACTE : même OID (jamais supprimée puis recréée), sentinelle présente" \
  eq "$(v oid_before "$H5")|$(v sentinel "$H5")" "$(v oid_after "$H5")|préexistante"
check "HARNESS-05 — elle n'est jamais entrée dans le registre des ressources de l'exécution" eq "$(v tracked "$H5")" "0"
check "HARNESS-05 — une base du registre se crée et se supprime (0 / 0), puis n'est plus supprimable une seconde fois (2)" \
  eq "$(v own_create_rc "$H5")/$(v own_drop_rc "$H5")/$(v second_drop_rc "$H5")" "0/0/2"
check "HARNESS-05 — postgres, template1 et un nom forgé (injection) : suppression refusée (2 / 2 / 2)" \
  eq "$(v drop_postgres_rc "$H5")/$(v drop_template1_rc "$H5")/$(v drop_injection_rc "$H5")" "2/2/2"
check "HARNESS-05 — bases présentes à la fin : exactement celles d'origine + la préexistante" eq "$(v dbs "$H5")" "$(v expected_dbs "$H5")"
check "HARNESS-05 — le témoin (bases au nom semblable, sur un autre serveur) n'a reçu aucune connexion" eq "$(witness_connections)" "$C0"
check "HARNESS-05 — … et il est intact" eq "$(witness_state)" "$W_STATE"

# ============================================================
log "=== HARNESS-07 — identité du serveur non conforme : arrêt AVANT DROP DATABASE ==="
next_tmp; mkdir -p "$T"
S0="$(witness_statements)"
(
  export TMPDIR="$T"
  . "$LIB"
  harness_safety_gate >/dev/null
  trap harness_cleanup EXIT
  harness_start_cluster >/dev/null || exit 90
  # Une base du registre porte le MÊME nom qu'une base du témoin.
  NAME="scanym_cpr1_tpl_4242"
  {
    harness_create_db "$NAME"; echo "own_create_rc=$?"
    OWN_SOCK="$H_SOCK"; OWN_PORT="$H_PORT"; OWN_NONCE="$H_NONCE"; OWN_DATA="$H_DATA"

    # (a) La connexion aboutit à un AUTRE serveur (le témoin).
    H_SOCK="$W_SOCK"; H_PORT="$W_PORT"
    harness_prove_identity; echo "a_identity_rc=$?"
    harness_drop_db "$NAME"; echo "a_drop_rc=$?"
    harness_create_db "scanym_cpr1_intrus_$H_TAG"; echo "a_create_rc=$?"
    echo "a_tracked_still=$(h_is_tracked "$NAME" && echo oui || echo non)"
    H_SOCK="$OWN_SOCK"; H_PORT="$OWN_PORT"

    # (b) Bon serveur, mais le nonce attendu n'est pas le sien (cluster
    #     d'une autre exécution, même répertoire réutilisé…).
    H_NONCE="ffffffffffffffffffffffffffffffff"
    harness_prove_identity; echo "b_identity_rc=$?"
    harness_drop_db "$NAME"; echo "b_drop_rc=$?"
    H_NONCE="$OWN_NONCE"

    # (c) Bon serveur, mais le répertoire de données attendu diffère.
    H_DATA="$OWN_DATA-autre"
    harness_drop_db "$NAME"; echo "c_drop_rc=$?"
    H_DATA="$OWN_DATA"

    echo "own_still_there=$(hpsql postgres -A -t -q -c "select count(*) from pg_database where datname = '$NAME';")"

    # (d) Identité rétablie : la même suppression est acceptée.
    harness_prove_identity; echo "d_identity_rc=$?"
    harness_drop_db "$NAME"; echo "d_drop_rc=$?"
    echo "own_gone=$(hpsql postgres -A -t -q -c "select count(*) from pg_database where datname = '$NAME';")"

    # (e) Serveur injoignable par NOTRE socket : identité non prouvée.
    harness_create_db "scanym_cpr1_x_$H_TAG" >/dev/null
    env -i PATH="$H_BIN:/usr/bin:/bin" LC_ALL=C "$H_BIN/pg_ctl" -D "$H_DATA" -m fast -w stop >/dev/null 2>&1
    harness_drop_db "scanym_cpr1_x_$H_TAG"; echo "e_drop_rc=$?"
  } > "$P_DIR/h7.txt" 2>&1
)
H7="$P_DIR/h7.txt"
S1="$(witness_statements)"
check "HARNESS-07 — (a) connexion aboutissant à un AUTRE serveur : preuve d'identité refusée (code 3)" eq "$(v a_identity_rc "$H7")" "3"
check "HARNESS-07 — (a) DROP DATABASE d'une base du registre vers cet autre serveur : ABANDONNÉ (code 3)" eq "$(v a_drop_rc "$H7")" "3"
check "HARNESS-07 — (a) CREATE DATABASE vers cet autre serveur : abandonné (code 3)" eq "$(v a_create_rc "$H7")" "3"
check "HARNESS-07 — (a) le serveur tiers n'a reçu AUCUNE instruction DROP / CREATE / ALTER DATABASE (journal d'instructions)" eq "$S1" "$S0"
check "HARNESS-07 — (a) la base homonyme du serveur tiers est intacte (même OID, sentinelle présente)" eq "$(witness_state)" "$W_STATE"
check "HARNESS-07 — (a) le message dit explicitement que DROP DATABASE n'a pas été envoyé" grep -q "DROP DATABASE « scanym_cpr1_tpl_4242 » N'A PAS été envoyé" "$H7"
check "HARNESS-07 — (a) la base reste au registre (rien n'a été supprimé)" eq "$(v a_tracked_still "$H7")" "oui"
check "HARNESS-07 — (b) nonce d'exécution non conforme : preuve refusée, DROP abandonné (3 / 3)" eq "$(v b_identity_rc "$H7")/$(v b_drop_rc "$H7")" "3/3"
check "HARNESS-07 — (c) data_directory non conforme : DROP abandonné (3)" eq "$(v c_drop_rc "$H7")" "3"
check "HARNESS-07 — après ces trois refus, la base de l'exécution existe toujours" eq "$(v own_still_there "$H7")" "1"
check "HARNESS-07 — (d) identité rétablie : preuve acceptée, DROP exécuté (0 / 0), base supprimée" eq "$(v d_identity_rc "$H7")/$(v d_drop_rc "$H7")/$(v own_gone "$H7")" "0/0/0"
check "HARNESS-07 — (e) serveur injoignable : identité non prouvée, DROP abandonné (3)" eq "$(v e_drop_rc "$H7")" "3"

# ============================================================
log "=== HARNESS-06 — nettoyage après un échec en cours d'exécution ==="
# (i) Garde du nettoyage : il ne supprime QUE le répertoire qui porte
#     le marqueur de l'exécution.
next_tmp; mkdir -p "$T"; plant_foreign_dir "$T"
(
  . "$LIB"
  H_NONCE="11111111111111111111111111111111"
  H_RUN_DIR="$T/scanym-cpr1.FOREIGNRUN"; H_DATA="$H_RUN_DIR/data"
  harness_cleanup
  mkdir -p "$T/scanym-cpr1.NOMARKER00" && touch "$T/scanym-cpr1.NOMARKER00/keep.txt"
  H_RUN_DIR="$T/scanym-cpr1.NOMARKER00"; H_DATA="$H_RUN_DIR/data"
  harness_cleanup
  mkdir -p "$T/pas-un-repertoire-du-harnais" && printf '%s\n' "$H_NONCE" > "$T/pas-un-repertoire-du-harnais/.scanym-harness-owner"
  H_RUN_DIR="$T/pas-un-repertoire-du-harnais"; H_DATA="$H_RUN_DIR/data"
  harness_cleanup
) > "$P_DIR/h6-guard.txt" 2>&1
if foreign_dir_intact "$T" && [ -f "$T/scanym-cpr1.NOMARKER00/keep.txt" ] && [ -d "$T/pas-un-repertoire-du-harnais" ] \
   && [ "$(grep -c "nettoyage REFUSÉ" "$P_DIR/h6-guard.txt")" = "3" ]; then
  pass "HARNESS-06 — (i) le nettoyage REFUSE de supprimer un répertoire d'une autre exécution (autre nonce), un répertoire sans marqueur et un répertoire au nom non conforme"
else
  fail "HARNESS-06 — (i) garde du nettoyage : $(tr '\n' ' ' < "$P_DIR/h6-guard.txt" | cut -c1-240) ; contenu : $(ls -A "$T" | tr '\n' ' ')"
fi

# (ii) ÉCHEC RÉEL en cours d'exécution : la chaîne de migrations casse
#      alors que le cluster tourne et que des bases existent déjà.
#      Copie du dépôt SQL, dont un maillon est rendu fautif (le harnais
#      et le dépôt d'origine ne sont pas modifiés).
next_tmp; mkdir -p "$T"; plant_foreign_dir "$T"
BROKEN="$P_DIR/broken-repo"
mkdir -p "$BROKEN/supabase/tests"
cp "$REPO_ROOT"/supabase/*.sql "$BROKEN/supabase/" || fatal "copie du dépôt SQL"
cp "$HARNESS" "$LIB" "$BROKEN/supabase/tests/"
printf '\nselect 1/0 as panne_provoquee_par_la_sonde;\n' >> "$BROKEN/supabase/migration-v67-product-photos.sql"
C0="$(witness_connections)"
env -i PATH="/usr/bin:/bin" HOME="$P_DIR/home" TMPDIR="$T" SCANYM_PG_BINDIR="$REAL_BIN" SCANYM_DISPOSABLE_CLUSTER=1 \
  bash "$BROKEN/supabase/tests/catalogue-product-reorder-v1-check.sh" >"$P_DIR/h6-broken.txt" 2>&1
RC=$?
C1="$(witness_connections)"
check "HARNESS-06 — (ii) échec de la chaîne en cours d'exécution : sortie non nulle" bash -c "[ '$RC' -ne 0 ]"
check "HARNESS-06 — (ii) l'échec est bien survenu APRÈS la création du cluster et d'une base (échec partiel réel)" \
  bash -c "grep -q 'cluster jetable CRÉÉ par cette exécution' '$P_DIR/h6-broken.txt' && grep -q 'FATAL: chaîne, migration-v67-product-photos.sql' '$P_DIR/h6-broken.txt'"
check "HARNESS-06 — (ii) le répertoire de l'exécution est retiré ; il ne reste QUE le répertoire de l'autre exécution" only_foreign_left "$T"
check "HARNESS-06 — (ii) le répertoire de l'autre exécution est intact" foreign_dir_intact "$T"
check "HARNESS-06 — (ii) le postmaster de l'exécution est arrêté" no_harness_postmaster_under "$T"
check "HARNESS-06 — (ii) le témoin n'a reçu aucune connexion" eq "$C1" "$C0"
check "HARNESS-06 — (ii) le témoin est intact" eq "$(witness_state)" "$W_STATE"

# (iii) SIGNAL en cours d'exécution (SIGTERM pendant la construction
#       de la chaîne).
next_tmp; mkdir -p "$T"; plant_foreign_dir "$T"
C0="$(witness_connections)"
env -i PATH="/usr/bin:/bin" HOME="$P_DIR/home" TMPDIR="$T" SCANYM_PG_BINDIR="$REAL_BIN" SCANYM_DISPOSABLE_CLUSTER=1 \
  bash "$HARNESS" >"$P_DIR/h6-term.txt" 2>&1 &
H_PID=$!
WAITED=0
until grep -q "=== \[0\] Base modèle" "$P_DIR/h6-term.txt" 2>/dev/null && ls "$T"/scanym-cpr1.*/data/postmaster.pid >/dev/null 2>&1; do
  sleep 0.2; WAITED=$((WAITED+1))
  [ "$WAITED" -lt 300 ] || break
  kill -0 "$H_PID" 2>/dev/null || break
done
RUN_DIR_SEEN="$(ls -d "$T"/scanym-cpr1.* 2>/dev/null | grep -v FOREIGNRUN | head -1)"
PM_PID="$(head -1 "$RUN_DIR_SEEN/data/postmaster.pid" 2>/dev/null | tr -cd '0-9')"
sleep 1.5
kill -TERM "$H_PID" 2>/dev/null
wait "$H_PID"; RC=$?
C1="$(witness_connections)"
check "HARNESS-06 — (iii) le harnais était bien EN COURS (cluster démarré, chaîne en construction) quand le signal est arrivé" \
  bash -c "[ -n '$RUN_DIR_SEEN' ] && [ -n '$PM_PID' ] && ! grep -q 'RÉSUMÉ' '$P_DIR/h6-term.txt'"
check "HARNESS-06 — (iii) SIGTERM : sortie 143" eq "$RC" "143"
check "HARNESS-06 — (iii) le répertoire de l'exécution est retiré ; il ne reste QUE le répertoire de l'autre exécution" only_foreign_left "$T"
check "HARNESS-06 — (iii) le répertoire de l'autre exécution est intact" foreign_dir_intact "$T"
if [ -n "$PM_PID" ] && ! pid_running "$PM_PID"; then
  pass "HARNESS-06 — (iii) le postmaster de l'exécution (pid $PM_PID) est arrêté"
else
  fail "HARNESS-06 — (iii) le postmaster de l'exécution (pid ${PM_PID:-inconnu}) tourne encore"
fi
check "HARNESS-06 — (iii) aucun postmaster de l'exécution ne subsiste" no_harness_postmaster_under "$T"
check "HARNESS-06 — (iii) le témoin n'a reçu aucune connexion" eq "$C1" "$C0"
check "HARNESS-06 — (iii) le témoin est intact et toujours en service" eq "$(witness_state)" "$W_STATE"

# ============================================================
log "=== HARNESS-08 — exécution normale isolée : toutes les preuves passent ==="
if [ "$DEFAULT_BAIT" = "1" ]; then
  # Contrôle positif de l'appât : un psql SANS AUCUN paramètre arrive
  # bien sur le témoin. C'est là qu'aboutissait la première version.
  AMBIENT="$(env -i PATH="$REAL_BIN:/usr/bin:/bin" LC_ALL=C "$REAL_BIN/psql" -X -A -t -q -d postgres -c "select current_setting('scanym.witness', true);" 2>/dev/null)"
  if [ "$AMBIENT" = "$P_MARK" ]; then
    pass "HARNESS-08 — contrôle positif de l'appât : un psql sans aucun paramètre de connexion aboutit bien au TÉMOIN (emplacement par défaut du poste)"
  else
    DEFAULT_BAIT=0
    log "appât : le psql de ce poste n'utilise pas $DEFAULT_SOCKET_DIR par défaut -- sonde notée SKIP."
  fi
fi
next_tmp; mkdir -p "$T"; plant_foreign_dir "$T"
C0="$(witness_connections)"
env -i PATH="/usr/bin:/bin" HOME="$P_DIR/home" TMPDIR="$T" SCANYM_PG_BINDIR="$REAL_BIN" SCANYM_DISPOSABLE_CLUSTER=1 \
  bash "$HARNESS" >"$P_DIR/h8.txt" 2>&1
RC=$?
C1="$(witness_connections)"
H8="$P_DIR/h8.txt"
SUMMARY="$(grep 'RÉSUMÉ' "$H8" | tail -1 | sed 's/^\[[0-9:]*\] //')"
check "HARNESS-08 — le harnais complet se termine avec succès (code 0)" eq "$RC" "0"
check "HARNESS-08 — aucune preuve en échec ($SUMMARY)" bash -c "grep -q 'RÉSUMÉ : PASS=[0-9]* FAIL=0 ===' '$H8' && ! grep -q 'FAIL:' '$H8'"
check "HARNESS-08 — au moins 250 preuves exécutées ($(grep -c 'PASS:' "$H8") PASS)" bash -c "[ \"\$(grep -c 'PASS:' '$H8')\" -ge 250 ]"
for section in "9A-" "9B-" "9C-" "9C-bis-" "9D-" "9E-" "8F-10"; do
  check "HARNESS-08 — concurrence réelle, section $section : $(grep -c "PASS: $section" "$H8") preuve(s), aucune en échec" \
    bash -c "[ \"\$(grep -c 'PASS: $section' '$H8')\" -ge 3 ] && ! grep -q 'FAIL: $section' '$H8'"
done
check "HARNESS-08 — fraîcheur de la vue (CPR-AUDIT-01), section 8F : $(grep -c 'PASS: 8F-' "$H8") preuves, aucune en échec" \
  bash -c "[ \"\$(grep -c 'PASS: 8F-' '$H8')\" -ge 50 ] && ! grep -q 'FAIL: 8F-' '$H8'"
check "HARNESS-08 — le cluster de l'exécution a été arrêté et retiré ; le répertoire de l'autre exécution est intact" \
  bash -c "[ \"\$(ls -A '$T' | tr '\n' ' ')\" = 'scanym-cpr1.FOREIGNRUN ' ] && [ -f '$T/scanym-cpr1.FOREIGNRUN/keep.txt' ]"
check "HARNESS-08 — aucun postmaster de l'exécution ne subsiste" no_harness_postmaster_under "$T"
check "HARNESS-08 — le témoin (bases au nom semblable) n'a reçu AUCUNE connexion pendant toute l'exécution" eq "$C1" "$C0"
check "HARNESS-08 — le témoin est intact" eq "$(witness_state)" "$W_STATE"
check "HARNESS-08 — aucun secret ni aucune valeur de variable de connexion dans la sortie" bash -c "! grep -qF -- '$SECRET' '$H8'"
if [ "$DEFAULT_BAIT" = "1" ]; then
  check "HARNESS-08 — AUCUN DÉFAUT AMBIANT : le témoin écoutait à l'emplacement par défaut du poste pendant toute l'exécution, et n'a reçu aucune connexion du harnais" eq "$C1" "$C0"
else
  skip "HARNESS-08 — appât « emplacement par défaut » non actif (SCANYM_HARNESS_DEFAULT_SOCKET_BAIT=1 non fourni, ou socket par défaut indisponible) ; l'absence de défaut ambiant reste prouvée par la seconde barrière et par le fil-piège"
fi

# ============================================================
# Le témoin a-t-il VRAIMENT été laissé seul ? Bilan sur tout le script.
TOTAL_STATEMENTS="$(witness_statements)"
EXPECTED_STATEMENTS="$(echo $LOOKALIKES | wc -w | tr -d ' ')"
check "BILAN — sur l'ensemble des sondes, les seules instructions CREATE/DROP/ALTER DATABASE reçues par le témoin sont les $EXPECTED_STATEMENTS créations faites par CE script" \
  eq "$TOTAL_STATEMENTS" "$EXPECTED_STATEMENTS"
check "BILAN — aucune instruction DROP DATABASE n'a jamais atteint le témoin" bash -c "! grep -qi 'statement: drop database' '$W_LOG'"

log "=== RÉSUMÉ DES SONDES : PASS=$PASS FAIL=$FAIL SKIP=$SKIP ==="
[ "$FAIL" -eq 0 ]
