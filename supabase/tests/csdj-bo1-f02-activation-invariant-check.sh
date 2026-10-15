#!/usr/bin/env bash
# ============================================================
# Scanym — CSDJ-BO-1 — épreuves PostgreSQL de l'INVARIANT D'ACTIVATION (remédiation F-02)
# Fichier  : supabase/tests/csdj-bo1-f02-activation-invariant-check.sh
# Mandat   : DIRAC → BOULEZ, remédiation F-02 (PR #151). Aucun SQL hébergé.
#
# Ce harnais est SANS RISQUE pour tout cluster qui n'est pas le sien : il crée son
# propre cluster jetable (SCANYM_DISPOSABLE_CLUSTER=1, exécuté en utilisateur système
# non privilégié), refuse toute base préexistante, ne détruit que ce qu'il a créé.
#
# PRÉREQUIS : le moteur CSDJ v1.2 (déjà appliqué sur l'hébergé) n'est PAS dans ce
# dépôt. SCANYM_V12_SOURCE_DIR désigne un arbre qui le contient ; le fichier est
# refusé si son identité git (blob SHA-1) n'est pas l'une des identités épinglées.
#
# SORTIE : 0 = toutes les preuves tiennent ; 1 = un échec ou preuve impossible.
# ============================================================
# ============================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_DIR="$(mktemp -d)"
ERR="$TMP_DIR/err.txt"
OUT="$TMP_DIR/out.txt"
FAIL_LOG="$TMP_DIR/failures.txt"
: > "$FAIL_LOG"
PASS_COUNT=0
FAIL_COUNT=0

log()  { printf '[%s] %s\n' "$(date -u '+%H:%M:%S')" "$*"; }
pass() { PASS_COUNT=$((PASS_COUNT + 1)); log "PASS: $*"; }
# Un échec = EXACTEMENT une ligne dans le journal brut, afin que
# `wc -l` du journal soit rigoureusement égal au nombre d'échecs.
fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf '%s\n' "$(printf '%s' "$*" | tr '\n\r' '  ')" >> "$FAIL_LOG"
  log "FAIL: $*"
}
# FATAL = le harnais n'a pas pu PRODUIRE la preuve. Jamais un succès,
# jamais un « ignoré » : sortie non nulle, toujours.
fatal() { log "FATAL: $*"; log "=== BILAN : preuve IMPOSSIBLE à produire -- échec fermé ==="; exit 1; }

# ============================================================
# SÛRETÉ — FAIL CLOSED (v1.1, remédiation d'audit indépendant
# OpenAI/Codex, blocker 3 : MCC-V1-HARNESS-UNSAFE-TARGET-01 (modèle repris))
#
# CE QUE v1 FAISAIT DE FAUX, et que cette section ferme :
#   - elle n'exigeait AUCUN consentement explicite de l'opérateur ;
#   - elle n'inspectait que PGHOSTADDR/PGSERVICE/PGSERVICEFILE, laissant
#     PGPORT, PGPASSWORD, PGPASSFILE, POSTGRES_URL et SUPABASE_DB_URL
#     rediriger librement la cible ;
#   - elle JOURNALISAIT la valeur des variables suspectes -- un mot de
#     passe ou une URL de connexion pouvait donc atterrir dans un log ;
#   - elle employait des noms de base FIXES et faisait
#     `drop database if exists` dessus AVANT de rien prouver : sur un
#     poste où une base `scanym_csdj1_base` existait déjà, elle la
#     DÉTRUISAIT sans en être propriétaire ;
#   - son nettoyage détruisait ces mêmes noms fixes, qu'elle les ait
#     créés ou non.
#
# Rien de destructif (initdb, create/drop database, create/alter role,
# migration) ne s'exécute avant que TOUTES ces conditions soient
# prouvées :
#
#   1. l'opérateur a DÉCLARÉ le cluster jetable
#      (SCANYM_DISPOSABLE_CLUSTER=1) ;
#   2. aucune variable de connexion héritée ne peut rediriger
#      l'exécution : celles qui changent la CIBLE sont un REFUS (par
#      NOM uniquement, jamais par valeur -- une valeur peut être un
#      secret), celles qui n'influencent que la session sont
#      neutralisées, et toute autre PG* héritée est retirée ;
#   3. la connexion passe par un socket que LE HARNAIS possède ;
#   4. le serveur effectivement joint EST le cluster jetable de ce
#      harnais -- prouvé en SQL par son `data_directory`, pas déduit ;
#   5. l'utilisateur effectif est superutilisateur DE CE cluster ;
#   6. aucune base au nom évoquant un environnement protégé n'existe ;
#   7. les noms de base portent le PID et l'horodatage de CETTE
#      exécution ; si l'un existait déjà, le harnais REFUSE -- il ne
#      peut pas prouver qu'il en est le propriétaire, donc il n'y
#      touche pas ;
#   8. le nettoyage ne détruit QUE ce que cette exécution a créé.
#
# Une heuristique ne doit JAMAIS pouvoir approuver une cible protégée
# en silence : chaque contrôle échoue fermé, avec un message explicite
# et un code de sortie dédié (2 = cible refusée).
#
# Usage, depuis la racine du dépôt :
#   SCANYM_DISPOSABLE_CLUSTER=1 \
#     bash supabase/tests/checkout-scheduling-foundation-v1-check.sh
#
# Par défaut le harnais CRÉE son propre cluster jetable (initdb dans un
# répertoire temporaire privé) et le détruit en sortie : il n'a besoin
# d'aucun serveur préexistant et ne peut, par construction, pas en
# toucher un. `SCANYM_HARNESS_PGHOST=/chemin/socket` permet de désigner
# un AUTRE cluster local jetable ; tous les autres contrôles restent
# appliqués, et les noms de base restent propres à l'exécution.
# ============================================================
REFUSE_EXIT=2
refuse() {
  log "REFUS DE SÛRETÉ : $*"
  log "Aucune opération destructive n'a été tentée."
  exit "$REFUSE_EXIT"
}

SAFETY_LOCK_PASSED=0
APP_ROLES="anon authenticated service_role"
ROLE_SNAPSHOT_TAKEN=0
OWN_CLUSTER=0          # 1 = ce harnais a créé le cluster
CLUSTER_STARTED=0      # 1 = il l'a démarré (donc doit l'arrêter)
PGDATA_DIR=""
SOCKET_DIR=""
CREATED_DBS=""         # SEULES bases que le nettoyage peut détruire

# --- 1. Consentement explicite de l'opérateur ---------------------
if [ "${SCANYM_DISPOSABLE_CLUSTER:-}" != "1" ]; then
  refuse "SCANYM_DISPOSABLE_CLUSTER=1 est requis. Ce harnais crée/supprime des bases et modifie des rôles de cluster : il exige une déclaration EXPLICITE que la cible est jetable."
fi

# --- 2. Variables de connexion héritées ---------------------------
# Redirigent la CIBLE -> REFUS. Le nom SEUL est journalisé : une valeur
# peut être un mot de passe, une URL de connexion avec identifiants ou
# un chemin de fichier de secrets, et ne doit jamais atteindre une
# sortie, même partiellement rédigée (une structure partielle reste une
# fuite).
REDIRECTING_VARS="PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE PGSYSCONFDIR PGCLUSTER DATABASE_URL POSTGRES_URL POSTGRESQL_URL PG_URL SUPABASE_DB_URL SCANYM_DB_URL SCANYM_DATABASE_URL"
# N'influencent que la session -> neutralisées.
NEUTRALIZED_VARS="PGOPTIONS PGCONNECT_TIMEOUT PGSSLMODE PGSSLROOTCERT PGSSLCERT PGSSLKEY PGAPPNAME PGCLIENTENCODING PGTARGETSESSIONATTRS"

for v in $REDIRECTING_VARS; do
  if [ -n "${!v:-}" ]; then
    refuse "$v est définie. Cette variable pourrait faire pointer ce harnais vers un serveur non jetable. Relancez-le dans un environnement sans configuration de connexion héritée. (La valeur n'est pas journalisée : elle peut être un secret.)"
  fi
done
for v in $NEUTRALIZED_VARS; do
  if [ -n "${!v:-}" ]; then
    log "[sûreté] $v était définie -- NEUTRALISÉE pour ce harnais."
    unset "$v"
  fi
done
# Neutralisation défensive : toute autre PG* héritée est retirée.
while IFS='=' read -r name _; do
  case "$name" in
    PG*) unset "$name" 2>/dev/null || true ;;
  esac
done < <(env)

command -v psql >/dev/null 2>&1 || fatal "psql introuvable."

# --- 3. Cluster et socket POSSÉDÉS par le harnais ------------------
if [ -n "${SCANYM_HARNESS_PGHOST:-}" ]; then
  # Mode « cluster jetable désigné » : un chemin de socket ABSOLU et
  # EXISTANT, jamais un hôte TCP (qui pourrait être distant).
  case "$SCANYM_HARNESS_PGHOST" in
    /*) : ;;
    *) refuse "SCANYM_HARNESS_PGHOST doit être un chemin de socket UNIX absolu." ;;
  esac
  [ -d "$SCANYM_HARNESS_PGHOST" ] || refuse "le répertoire de socket désigné n'existe pas."
  SOCKET_DIR="$SCANYM_HARNESS_PGHOST"
  export PGHOST="$SOCKET_DIR"
  # Port du cluster DÉSIGNÉ. Distinct d'un PGPORT HÉRITÉ, qui reste
  # refusé (contrôle 2) : celui-ci est un paramètre EXPLICITE du
  # harnais, il n'a de sens qu'avec une socket désignée, et il est
  # validé -- un cluster jetable local n'écoute pas forcément sur 5432.
  if [ -n "${SCANYM_HARNESS_PGPORT:-}" ]; then
    case "$SCANYM_HARNESS_PGPORT" in
      ''|*[!0-9]*) refuse "SCANYM_HARNESS_PGPORT doit être un entier." ;;
    esac
    [ "$SCANYM_HARNESS_PGPORT" -ge 1 ] && [ "$SCANYM_HARNESS_PGPORT" -le 65535 ] \
      || refuse "SCANYM_HARNESS_PGPORT hors plage."
    export PGPORT="$SCANYM_HARNESS_PGPORT"
  fi
  log "[sûreté] cluster jetable DÉSIGNÉ par l'opérateur (socket $SOCKET_DIR${SCANYM_HARNESS_PGPORT:+, port $SCANYM_HARNESS_PGPORT})."
else
  # Mode par défaut : le harnais CRÉE son cluster. Il ne peut alors, par
  # construction, toucher aucun serveur préexistant.
  [ "$(id -u)" != "0" ] || refuse "initdb refuse de s'exécuter en root. Relancez ce harnais sous un utilisateur non privilégié (ex. : sudo -u postgres -E ...)."
  INITDB=""
  for cand in initdb /usr/lib/postgresql/*/bin/initdb; do
    if command -v "$cand" >/dev/null 2>&1; then INITDB="$cand"; break; fi
  done
  [ -n "$INITDB" ] || fatal "initdb introuvable : impossible de créer un cluster jetable."
  PG_CTL="$(dirname "$INITDB")/pg_ctl"
  [ -x "$PG_CTL" ] || PG_CTL="pg_ctl"
  command -v "$PG_CTL" >/dev/null 2>&1 || fatal "pg_ctl introuvable."

  PGDATA_DIR="$TMP_DIR/cluster"
  SOCKET_DIR="$TMP_DIR/sock"
  mkdir -p "$SOCKET_DIR"
  "$INITDB" -D "$PGDATA_DIR" -A trust -E UTF8 --locale=C >"$TMP_DIR/initdb.log" 2>&1 \
    || fatal "initdb a échoué : $(tail -3 "$TMP_DIR/initdb.log" | tr '\n' ' ')"
  OWN_CLUSTER=1
  # Port ÉPHÉMÈRE et socket privée : aucune collision possible avec un
  # serveur du poste, et `listen_addresses=''` interdit tout TCP.
  HARNESS_PORT=$(( 49152 + ($$ % 16000) ))
  "$PG_CTL" -D "$PGDATA_DIR" -l "$TMP_DIR/pg.log" \
    -o "-p $HARNESS_PORT -k $SOCKET_DIR -c listen_addresses=''" start >/dev/null 2>&1 \
    || fatal "démarrage du cluster jetable impossible : $(tail -3 "$TMP_DIR/pg.log" 2>/dev/null | tr '\n' ' ')"
  CLUSTER_STARTED=1
  export PGHOST="$SOCKET_DIR"
  export PGPORT="$HARNESS_PORT"
  log "[sûreté] cluster jetable CRÉÉ par ce harnais (données $PGDATA_DIR, socket $SOCKET_DIR, port $HARNESS_PORT)."
fi
export PGDATABASE="postgres"
export PGCONNECT_TIMEOUT=5
export PGAPPNAME="scanym-csdjbo1-harness"

# --- 4./5. Identité RÉELLE du serveur, prouvée en SQL -------------
probe() { psql -X -A -q -t -d postgres -c "$1" </dev/null 2>/dev/null | tail -1 | tr -d ' '; }

# Contrôle de CONNECTIVITÉ sans tube : `probe` passe par `tail`, dont le
# code de retour masquerait l'échec de psql -- et une connexion ratée se
# présenterait alors comme une valeur vide, c'est-à-dire comme un refus
# pour la mauvaise raison. On veut le vrai diagnostic.
if ! psql -X -A -q -t -d postgres -c "select 1" </dev/null >/dev/null 2>"$ERR"; then
  refuse "impossible de se connecter au cluster jetable via la socket « $SOCKET_DIR »${PGPORT:+ (port $PGPORT)} : $(tr '\n' ' ' < "$ERR" | cut -c1-200)"
fi

SRV_ADDR="$(probe "select coalesce(host(inet_server_addr()), 'unix-socket');")"
CUR_DB="$(probe "select current_database();")"
CUR_USER="$(probe "select current_user;")"
IS_SUPER="$(probe "select current_setting('is_superuser');")"
DATA_DIR="$(probe "select current_setting('data_directory');")"
CONFIG_FILE="$(probe "select current_setting('config_file');")"
SRV_PORT="$(probe "select current_setting('port');")"

case "$SRV_ADDR" in
  unix-socket|127.0.0.1|::1|localhost) : ;;
  *) refuse "le serveur effectif n'est pas local." ;;
esac
[ "$CUR_DB" = "postgres" ] || refuse "base de connexion initiale inattendue."
[ "$IS_SUPER" = "on" ] || refuse "le harnais exige un superutilisateur sur un cluster jetable (« $CUR_USER » ne l'est pas)."

if [ "$OWN_CLUSTER" = "1" ]; then
  # PREUVE que le serveur joint est bien CELUI que ce harnais a créé :
  # son répertoire de données est le nôtre. Un PGPORT, un PGHOST ou une
  # URL héritée ne peuvent donc pas détourner l'exécution -- et s'ils
  # sont définis, le contrôle 2 a déjà refusé.
  [ "$DATA_DIR" = "$PGDATA_DIR" ] \
    || refuse "le serveur joint n'est PAS le cluster créé par ce harnais (data_directory inattendu)."
fi

# --- 6. Aucune base au nom évoquant un environnement protégé ------
PROTECTED="$(probe "select count(*) from pg_database where datname ~* '(prod|production|live|preprod|staging|recette)';")"
[ "${PROTECTED:-1}" = "0" ] \
  || refuse "le cluster contient $PROTECTED base(s) au nom évoquant un environnement protégé. Ce harnais ne s'exécute pas sur un tel cluster."

log "[sûreté] cible validée : serveur=$SRV_ADDR base=$CUR_DB utilisateur=$CUR_USER superuser=$IS_SUPER propre_cluster=$OWN_CLUSTER"

# --- 7. Noms de base PROPRES À CETTE EXÉCUTION --------------------
# Jamais de nom FIXE : un nom fixe, c'est la base de quelqu'un d'autre
# le jour où elle existe. Le suffixe porte le PID et l'horodatage.
# INSTRUMENTATION DE TEST UNIQUEMENT — sert au harnais de sûreté
# compagnon (checkout-scheduling-foundation-v1-harness-safety-check.sh)
# à provoquer DÉLIBÉRÉMENT une collision de nom, afin de prouver que le
# harnais REFUSE au lieu de détruire. Double verrou : il faut À LA FOIS
# `SCANYM_HARNESS_SELFTEST=1` ET `SCANYM_HARNESS_RUN_TAG`. Une variable
# seule est ignorée et signalée -- un déclenchement accidentel lors
# d'une exécution normale est donc structurellement impossible, et
# l'étiquette ne peut jamais être figée par accident.
RUN_TAG="$$_$(date -u '+%Y%m%d%H%M%S')"
if [ -n "${SCANYM_HARNESS_RUN_TAG:-}" ]; then
  if [ "${SCANYM_HARNESS_SELFTEST:-0}" = "1" ]; then
    RUN_TAG="$SCANYM_HARNESS_RUN_TAG"
    log "[auto-test] étiquette d'exécution FIGÉE : $RUN_TAG"
  else
    log "[auto-test] SCANYM_HARNESS_RUN_TAG ignorée : SCANYM_HARNESS_SELFTEST=1 est requis."
  fi
fi
DB_BASE="scanym_csdjbo1_base_$RUN_TAG"   # prédécesseur SANS CSDJ-1
DB_V1="scanym_csdjbo1_v1_$RUN_TAG"       # prédécesseur + CSDJ-1 v1.10
DB_PRE="scanym_csdjbo1_pre_$RUN_TAG"     # + CSDJ v1.2 : l'état de l'hébergé AVANT ce lot
DB_NEW="scanym_csdjbo1_new_$RUN_TAG"     # + ce lot : la base des preuves
DB_ATOMIC="scanym_csdjbo1_atomic_$RUN_TAG"
DB_RB="scanym_csdjbo1_rb_$RUN_TAG"
DB_NEG="scanym_csdjbo1_neg_$RUN_TAG"     # cas négatifs du pré-vol (recréée pour chaque cas)
DB_MUT="scanym_csdjbo1_mut_$RUN_TAG"     # mutants (recréée pour chaque mutant)
DB_F02="scanym_csdjbo1_f02_$RUN_TAG"     # BO1 + invariant F-02
DB_F02B="scanym_csdjbo1_f02b_$RUN_TAG"   # v1.2 + invariant F-02 SEUL (sans le lot BO1)
DB_F02R="scanym_csdjbo1_f02r_$RUN_TAG"   # retour arrière / pré-vol
NEG_ROLES_CREATED=0                       # rôles jetables de [17] créés (nettoyage)
NEG_MEMBERSHIP=0                          # adhésion de rôle de test posée (nettoyage)

# Et si malgré tout l'un de ces noms existe déjà, le harnais REFUSE :
# il ne peut pas prouver qu'il en est le propriétaire, donc il n'y
# touche pas. Jamais un `drop database` sur une base qu'il n'a pas créée.
for d in "$DB_BASE" "$DB_V1" "$DB_PRE" "$DB_NEW" "$DB_ATOMIC" "$DB_RB" "$DB_NEG" "$DB_MUT" "$DB_F02" "$DB_F02B" "$DB_F02R"; do
  EXISTS="$(probe "select count(*) from pg_database where datname = '$d';")"
  [ "${EXISTS:-1}" = "0" ] \
    || refuse "la base « $d » existe déjà et n'a pas été créée par cette exécution. Le harnais ne peut pas prouver qu'il en est le propriétaire : il refuse plutôt que de la détruire."
done

# Création TRACÉE : seules les bases enregistrées ici seront détruites.
create_tracked_db() {
  local name="$1"; shift
  createdb "$@" "$name" 2>"$ERR" \
    || fatal "création de la base jetable « $name » impossible ($(tr '\n' ' ' < "$ERR"))."
  CREATED_DBS="$CREATED_DBS $name"
}

# ════════════════════════════════════════════════════════════════════
# CSDJ1-AUD-06 — NORMALISATION EXPLICITE DES BOOLÉENS
#
# `boolean::text` rend « true »/« false » en SQL, jamais « t »/« f » --
# c'est « t » que donne l'affichage ALIGNÉ de psql, pas la conversion.
# La version précédente capturait « true » puis comparait à « t » au
# nettoyage : la comparaison échouait toujours, et un rôle préexistant
# LOGIN+BYPASSRLS était restauré en NOLOGIN+NOBYPASSRLS. Sur un cluster
# jetable créé par le harnais c'était invisible ; sur un cluster DÉSIGNÉ
# par l'opérateur, c'était une mutation durable de ses rôles.
#
# L'instantané encode donc explicitement 1/0, et la restauration compare
# à 1/0. Aucune représentation intermédiaire n'est devinée.
# ════════════════════════════════════════════════════════════════════
role_state() {
  probe "select coalesce((select 'EXISTS|' || (case when rolcanlogin then '1' else '0' end)
                                  || '|' || (case when rolbypassrls then '1' else '0' end)
                          from pg_roles where rolname = '$1'), 'ABSENT');"
}
declare -A ROLE_SNAP=()
for r in $APP_ROLES; do
  st="$(role_state "$r")"
  case "$st" in
    ABSENT|'EXISTS|0|0'|'EXISTS|0|1'|'EXISTS|1|0'|'EXISTS|1|1') ROLE_SNAP[$r]="$st" ;;
    # Un instantané d'une autre forme serait illisible au nettoyage : on
    # refuse de muter un cluster qu'on ne saurait pas restaurer
    # EXACTEMENT (CSDJ1-AUD-06).
    *) fatal "état initial du rôle global '$r' illisible ('$st') -- refus de muter un cluster non restaurable." ;;
  esac
done
ROLE_SNAPSHOT_TAKEN=1

# ════════════════════════════════════════════════════════════════════
# CSDJ-V1-DESTINATION-PROOF-02 — CONTRAT D'IDENTITÉ COMPLÈTE
#
# Ferme CSDJ1-AUD-07 tel que le second re-audit delta l'a précisé : la
# preuve de destination du nettoyage ne portait que sur quatre faits
# (socket, port, utilisateur, superutilisateur). Deux clusters
# différents peuvent les satisfaire. Elle porte désormais sur HUIT, dont
# le data_directory, le config_file et un MARQUEUR en base propre à
# cette exécution -- et c'est le MÊME prédicat pour tout chemin qui
# mute, mise en place comprise.
#
# Le prédicat vit dans une bibliothèque sourcée, précisément pour qu'il
# n'existe pas deux versions subtilement différentes de lui.
# ════════════════════════════════════════════════════════════════════
IDENTITY_LIB="$SCRIPT_DIR/csdj1-cluster-identity.sh"
[ -f "$IDENTITY_LIB" ] \
  || fatal "bibliothèque d'identité absente : $IDENTITY_LIB -- aucune mutation ne peut être gardée, le harnais refuse de muter."
# shellcheck source=/dev/null
. "$IDENTITY_LIB"

# Le runner du harnais principal : la destination vient des variables
# EXPORTÉES par le verrou de sûreté, après que le contrôle 2 a refusé
# toute variable de routage héritée.
csdj1_runner_main() {
  psql -X -A -q -t -v ON_ERROR_STOP=1 -d postgres -c "$1" </dev/null 2>&1
}

IDENTITY_MARKER="scanym_csdjbo1_identity_$RUN_TAG"
IDENTITY_NONCE="csdjbo1-$RUN_TAG-$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
[ -n "${IDENTITY_NONCE#csdjbo1-$RUN_TAG-}" ] || IDENTITY_NONCE="csdjbo1-$RUN_TAG-$$"
# Contrat NOMMÉ : ce harnais n'a qu'un cluster, mais le prédicat est
# partagé avec un harnais qui en a trois. Nommer évite de sauvegarder et
# restaurer un contrat global à la main -- c'est-à-dire d'inventer un
# second chemin, ce qui est la forme même du défaut d'origine.
csdj1_identity_declare lot csdj1_runner_main \
  "$SOCKET_DIR" "$SRV_PORT" "$CUR_USER" "$DATA_DIR" "$CONFIG_FILE" \
  "$IDENTITY_MARKER" "$IDENTITY_NONCE" \
  || fatal "contrat d'identité invalide : le harnais refuse de muter."
csdj1_identity_install \
  || fatal "pose du marqueur d'identité refusée ($CSDJ1_ID_LAST) -- le harnais ne mute rien sans pouvoir lier le serveur à CETTE exécution."
log "[sûreté] identité complète établie : data_directory, config_file, socket, port, utilisateur, superutilisateur et marqueur « $IDENTITY_MARKER » (nonce propre à cette exécution)."

SAFETY_LOCK_PASSED=1
# CSDJ12-DEPLOY-01 : l'aller épingle l'exécutant « postgres » (propriétaire des
# prédécesseurs et des fonctions créées). Le superutilisateur d'amorçage d'un
# cluster jetable porte le nom de l'utilisateur système qui l'a créé.
[ "$CUR_USER" = "postgres" ] \
  || fatal "le SQL v1.2 exige l'exécutant « postgres » (CSDJ12-DEPLOY-01) ; ce harnais s'exécute sous « $CUR_USER ». Lancez-le sous l'utilisateur système postgres (sudo -u postgres -E ...) : le cluster jetable en tire son superutilisateur d'amorçage."
log "verrou de sûreté franchi : $( [ "$OWN_CLUSTER" = 1 ] && echo 'cluster créé par le harnais' || echo 'cluster jetable désigné' ), bases nommées pour cette exécution uniquement."

# ============================================================
# NETTOYAGE — UNIQUEMENT les ressources de CETTE exécution
# ============================================================
cleanup() {
  local rc=$?
  if [ "$SAFETY_LOCK_PASSED" = "1" ]; then
    # Bases : SEULES celles que `create_tracked_db` a enregistrées. Une
    # base portant un nom semblable mais non créée ici n'est jamais
    # touchée -- c'est tout l'objet de la remédiation.
    for d in $CREATED_DBS; do
      psql -X -q -d postgres -c "drop database if exists \"$d\";" </dev/null >/dev/null 2>&1
    done
    # Rôles jetables de [17]/[19] et adhésion de test : retirés par le point de
    # passage gardé, seulement si le cluster n'est PAS le nôtre.
    if [ "$OWN_CLUSTER" != "1" ] && { [ "$NEG_ROLES_CREATED" = "1" ] || [ "$NEG_MEMBERSHIP" = "1" ]; }; then
      NEG_CLEAN=""
      [ "$NEG_MEMBERSHIP" = "1" ] && NEG_CLEAN="$NEG_CLEAN
  revoke authenticated from anon;"
      [ "$NEG_ROLES_CREATED" = "1" ] && NEG_CLEAN="$NEG_CLEAN
  drop role if exists ${NEG_ROLE:-csdj12_neg_absent};
  drop role if exists ${NEG_SU:-csdj12_negsu_absent};
  drop role if exists ${NEG_PLAIN:-csdj12_negpl_absent};"
      csdj1_identity_mutate "$NEG_CLEAN" >/dev/null 2>&1 \
        || log "[sûreté] rôles jetables de test NON retirés ($CSDJ1_ID_LAST) : à retirer à la main (${NEG_ROLE:-?}, ${NEG_SU:-?}, ${NEG_PLAIN:-?}) et « revoke authenticated from anon »."
    fi
    # Rôles : seulement si le cluster n'est PAS le nôtre (sinon il
    # disparaît entier juste après, et toucher ses rôles est inutile).
    if [ "$ROLE_SNAPSHOT_TAKEN" = "1" ] && [ "$OWN_CLUSTER" != "1" ]; then
      # ══════════════════════════════════════════════════════════════
      # CSDJ-V1-DESTINATION-PROOF-02 — ferme CSDJ1-AUD-07 tel que le
      # SECOND re-audit delta l'a précisé.
      #
      # La version précédente de ce nettoyage prouvait quatre faits :
      # socket, port, utilisateur, superutilisateur. Deux clusters
      # différents peuvent les présenter -- même numéro de port, même
      # nom d'utilisateur, même motif de socket -- et la preuve ne liait
      # donc pas le serveur à CETTE exécution.
      #
      # Chaque restauration passe maintenant par le prédicat COMMUN :
      # huit faits, dont le data_directory, le config_file et le
      # marqueur en base. Preuve et mutation tiennent dans UNE session et
      # UNE transaction -- aucun intervalle entre les deux.
      #
      # Un rôle non restauré est un désagrément ; un rôle muté sur le
      # mauvais serveur est un dégât. En cas de refus : on ne restaure
      # RIEN, et on le DIT.
      # ══════════════════════════════════════════════════════════════
      RESTORE_SQL=""
      for r in $APP_ROLES; do
        case "${ROLE_SNAP[$r]}" in
          ABSENT) RESTORE_SQL="$RESTORE_SQL
  drop role if exists $r;" ;;
          EXISTS*)
            # CSDJ1-AUD-06 : l'instantané encode 1/0, la restauration
            # compare à 1/0. Toute autre valeur serait un instantané
            # illisible, et le verrou de sûreté a déjà refusé ce cas.
            login="$(printf '%s' "${ROLE_SNAP[$r]}" | cut -d'|' -f2)"
            bypass="$(printf '%s' "${ROLE_SNAP[$r]}" | cut -d'|' -f3)"
            [ "$login" = "1" ] && lk="login" || lk="nologin"
            [ "$bypass" = "1" ] && bk="bypassrls" || bk="nobypassrls"
            RESTORE_SQL="$RESTORE_SQL
  alter role $r $lk $bk;" ;;
        esac
      done
      # TOUTE la restauration en UNE transaction gardée : ou les trois
      # rôles reviennent à leur état d'origine, ou aucun ne bouge. Une
      # restauration à moitié faite serait un état que personne n'a
      # jamais décidé.
      if csdj1_identity_mutate "$RESTORE_SQL"; then
        log "[sûreté] rôles globaux restaurés à l'identique, après preuve d'identité complète."
      else
        log "[sûreté] RESTAURATION DE RÔLES ABANDONNÉE : l'identité complète du serveur n'est plus prouvable ($CSDJ1_ID_LAST). AUCUN rôle n'a été muté."
        ROLE_SNAPSHOT_TAKEN=0
      fi
    fi
    # Le marqueur disparaît en dernier, et sous la même garde : il n'est
    # retiré que du serveur qui vient de prouver qu'il est le nôtre.
    if [ "$CSDJ1_ID_INSTALLED" = "1" ]; then
      csdj1_identity_uninstall \
        || log "[sûreté] marqueur « $IDENTITY_MARKER » NON retiré ($CSDJ1_ID_LAST) : il subsiste plutôt que d'être supprimé d'un serveur non identifié."
    fi
  fi
  # Cluster : arrêté puis supprimé UNIQUEMENT si ce harnais l'a créé.
  if [ "$CLUSTER_STARTED" = "1" ]; then
    "$PG_CTL" -D "$PGDATA_DIR" stop -m immediate >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
  exit "$rc"
}
trap cleanup EXIT

# ============================================================
# Outils
# ============================================================
DB=""
apply_file() { psql -X -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$1" >/dev/null 2>"$ERR"; }
apply_path() { psql -X -d "$2" -v ON_ERROR_STOP=1 -f "$1" >"$OUT" 2>&1; }
# UNE REQUÊTE DE PREUVE QUI ÉCHOUE NE DOIT JAMAIS RESSEMBLER À UN
# ENSEMBLE VIDE : « vide » est une valeur ATTENDUE par plusieurs
# assertions ci-dessous, et confondre les deux rendrait un défaut de
# TEST indiscernable d'un comportement PRODUIT correct.
run_sql() {
  local db="$1" role="$2" uid="$3" query="$4" out rc msg
  if [ -n "$role" ] && [ -n "$uid" ]; then
    out="$(PGOPTIONS="-c role=$role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$db" \
            -c "set test.uid = '$uid';" -c "$query" 2>"$ERR")"
  elif [ -n "$role" ]; then
    out="$(PGOPTIONS="-c role=$role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$db" -c "$query" 2>"$ERR")"
  else
    out="$(psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$db" -c "$query" 2>"$ERR")"
  fi
  rc=$?
  if [ "$rc" -ne 0 ]; then
    msg="$(tr '\n\r' '  ' < "$ERR" | cut -c1-220)"
    printf '[%s] SQL-ERROR (base=%s role=%s) : %s\n' "$(date -u '+%H:%M:%S')" "$db" "${role:-<proprietaire>}" "$msg" >&2
    printf '<SQL_ERROR: %s>\n' "$msg"
    return 0
  fi
  printf '%s\n' "$out"
}
sql_value() { run_sql "$DB" '' '' "$1" | tail -1 | tr -d ' '; }
sql_raw()   { run_sql "$DB" '' '' "$1" | tail -1; }
sql_on()    { run_sql "$1" '' '' "$2" | tail -1 | tr -d ' '; }
value_as()  { run_sql "$DB" "$1" "$2" "$3" | tail -1 | tr -d ' '; }
# Variante qui PRÉSERVE les espaces : indispensable dès qu'on compare un
# TEXTE marchand (« ACCUSE ALPHA v1 ») et non un identifiant ou un
# booléen -- `tr -d ' '` les ferait coïncider à tort.
value_as_raw() { run_sql "$DB" "$1" "$2" "$3" | tail -1; }

# "OK" si l'instruction réussit, sinon le PREMIER message d'erreur
# normalisé. Sortie entièrement capturée en mémoire : aucun tube depuis
# psql, donc aucun SIGPIPE ni troncature.
outcome_as() {
  local role="$1" uid="$2" query="$3" out rc
  if [ -n "$uid" ]; then
    out="$(PGOPTIONS="-c role=$role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" \
            -c "set test.uid = '$uid';" -c "$query" 2>&1)"
  else
    out="$(PGOPTIONS="-c role=$role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "$query" 2>&1)"
  fi
  rc=$?
  if [ "$rc" -eq 0 ]; then printf 'OK\n'; return 0; fi
  out="${out#*ERROR:  }"
  out="${out%%$'\n'*}"
  printf '%s\n' "$out"
}
# Résultat d'une instruction exécutée par la connexion PROPRIÉTAIRE,
# sans endosser de rôle. `outcome_as` impose un `-c role=...` : l'appeler
# avec un rôle vide ferait échouer psql À LA CONNEXION, et un refus
# attendu passerait alors pour la bonne réponse donnée pour la MAUVAISE
# raison. Ce helper existe pour que ce faux positif soit impossible.
outcome_owner() {
  local out rc
  out="$(psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c "$1" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then printf 'OK\n'; return 0; fi
  out="${out#*ERROR:  }"
  out="${out%%$'\n'*}"
  printf '%s\n' "$out"
}
assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"
  else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
# Verdict INDÉPENDANT DE LA LOCALE : les messages produits par
# PostgreSQL lui-même sont traduits selon lc_messages, donc jamais
# comparés tels quels. Les messages qui APPARTIENNENT à Scanym
# (SCANYM_*, « Forbidden ») sont, eux, comparés littéralement.
refused() { if [ "$1" = "OK" ]; then printf 'AUTORISE\n'; else printf 'REFUSE\n'; fi; }

fn_code_fingerprint() {
  run_sql "${2:-$DB}" '' '' "
    select coalesce(md5(string_agg(
             regexp_replace(regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g'),
             '#' order by n.nspname || '.' || p.proname)), 'absent')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '$1';" | tail -1 | tr -d ' '
}
schema_counts() {
  local db="${1:-$DB}"
  printf '%s|%s|%s|%s\n' \
    "$(sql_on "$db" "select count(*) from pg_class where relnamespace='public'::regnamespace and relkind in ('r','v','m','p');")" \
    "$(sql_on "$db" "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and not t.tgisinternal;")" \
    "$(sql_on "$db" "select count(*) from pg_proc where pronamespace='public'::regnamespace;")" \
    "$(sql_on "$db" "select count(*) from information_schema.columns where table_schema='public';")"
}
# v1.1 — AUCUN `drop database` préalable : le nom est propre à cette
# exécution, et sa non-existence a déjà été PROUVÉE par le verrou de
# sûreté. Détruire « au cas où » était précisément le défaut
# MCC-V1-HARNESS-UNSAFE-TARGET-01 (modèle repris).
clone_base() {
  create_tracked_db "$1" -T "$DB_BASE"
}

# ============================================================
# Identifiants synthétiques (aucune donnée réelle).
# Convention de nommage des fixtures du dépôt : Victor Hugo.
# ============================================================
RID_A='a1111111-1111-4111-8111-111111111111'
RID_B='b2222222-2222-4222-8222-222222222222'
CAT_A='a1111111-1111-4111-8111-1111111111ca'
CAT_B='b2222222-2222-4222-8222-2222222222cb'
ITEM_A='a1111111-1111-4111-8111-1111111111e1'
ITEM_B='b2222222-2222-4222-8222-2222222222e2'
OWNER_A='51111111-1111-4111-8111-11111111000a'
MANAGER_A='51111111-1111-4111-8111-1111111100aa'
STAFF_A='51111111-1111-4111-8111-11111111005a'
OWNER_B='52222222-2222-4222-8222-22222222000b'
STRANGER='5fffffff-ffff-4fff-8fff-ffffffffffff'
NIL_RULE='00000000-0000-0000-0000-000000000000'

V1_SQL="DRAFT-lot-checkout-scheduling-foundation-v1.sql"
LOT_SQL="DRAFT-lot-csdj-bo1-save-fulfillment-configuration-v1.sql"
LOT_ROLLBACK="DRAFT-lot-csdj-bo1-save-fulfillment-configuration-v1-rollback.sql"
F02_SQL="DRAFT-lot-csdj-bo1-f02-activation-invariant-v1.sql"
F02_RB="DRAFT-lot-csdj-bo1-f02-activation-invariant-v1-rollback.sql"

# ------------------------------------------------------------------
# MOTEUR CSDJ v1.2 : ce dépôt (PR autonome) NE le contient PAS -- la v1.2 vit
# sur une autre branche (PR #146 / remédiation DEPLOY-01 + RB-02) et est déjà
# appliquée sur l'hébergé. Le harnais l'obtient d'un répertoire désigné par
# l'opérateur, et REFUSE tout fichier dont l'identité git (blob SHA-1) n'est
# pas l'une des identités épinglées. Aucune v1.2 n'est donc jamais « devinée ».
#   SCANYM_V12_SOURCE_DIR = racine d'un arbre contenant
#     supabase/DRAFT-lot-checkout-scheduling-calendars-capacity-v1-2.sql
#     (et, pour le candidat audité, tests/fixtures/csdj12-prod-predecessor-create_order.sql)
# ------------------------------------------------------------------
V12_FWD_REL="supabase/DRAFT-lot-checkout-scheduling-calendars-capacity-v1-2.sql"
V12_FIX_REL="tests/fixtures/csdj12-prod-predecessor-create_order.sql"
V12_PINS="fee1e398001dc05319f9e21501b99681da372e02=audited-remediation-10668d1 a2d17eaed9f05aa09c3bf49f9bc07b4ddaee9d01=pr146-head-11bfa548"
V12_FIX_PIN="414392b556abbdb78192d4797c835f5273753e82"
PROD_CO_MD5="c327445751333e7908d60e6d7f838eb5"
git_blob_sha() { { printf 'blob %s\0' "$(wc -c < "$1" | tr -d ' ')"; cat "$1"; } | sha1sum | cut -d' ' -f1; }
[ -n "${SCANYM_V12_SOURCE_DIR:-}" ] && [ -f "$SCANYM_V12_SOURCE_DIR/$V12_FWD_REL" ] \
  || fatal "SCANYM_V12_SOURCE_DIR doit désigner un arbre contenant $V12_FWD_REL (le moteur CSDJ v1.2, appliqué sur l'hébergé, n'est pas dans ce dépôt)."
V12_FWD_FILE="$SCANYM_V12_SOURCE_DIR/$V12_FWD_REL"
V12_FWD_SHA="$(git_blob_sha "$V12_FWD_FILE")"
V12_PIN_NAME=""
for p in $V12_PINS; do [ "${p%%=*}" = "$V12_FWD_SHA" ] && V12_PIN_NAME="${p#*=}"; done
[ -n "$V12_PIN_NAME" ] || fatal "le SQL v1.2 désigné a l'identité git $V12_FWD_SHA, qui n'est pas une identité épinglée ($V12_PINS)."
V12_FIX_FILE="$SCANYM_V12_SOURCE_DIR/$V12_FIX_REL"
if [ -f "$V12_FIX_FILE" ]; then
  [ "$(git_blob_sha "$V12_FIX_FILE")" = "$V12_FIX_PIN" ] || fatal "la fixture create_order PROD désignée n'a pas l'identité épinglée $V12_FIX_PIN."
else
  V12_FIX_FILE=""
fi
log "moteur v1.2 : $V12_FWD_SHA ($V12_PIN_NAME)${V12_FIX_FILE:+, fixture create_order PROD $V12_FIX_PIN}"

# ============================================================
# [0] Chaîne PRÉDÉCESSEUR dans une base jetable modèle.
#     MINIMAL_CHAIN / REST_CHAIN / CGV_AFTER_N1A_CHAIN / TRACKING_TAIL
#     sont repris VERBATIM de
#     supabase/tests/customer-followup-tracking-email-v1-check.sh.
#     Ce lot n'ajoute AUCUN maillon : il ne se greffe que sur le modèle
#     de modes de vente et sur l'autorité de tarification de livraison,
#     tous deux présents dans REST_CHAIN.
# ============================================================
log "=== [0] Construction du schéma PRÉDÉCESSEUR ($DB_BASE) ==="

MINIMAL_CHAIN="schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql"
REST_CHAIN="migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v76-storage-origin-config.sql migration-v71-hardening.sql migration-v72-hardening.sql migration-v73-hardening.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql migration-v82-lot2a-sale-modes.sql migration-v83-lot2a4-privilege-hardening.sql migration-v84-lot2b1-delivery-info-rpc.sql DRAFT-lot-fulfillment-routing-model.sql DRAFT-lot-fulfillment-routing-lot-b-rpc.sql DRAFT-lot-server-delivery-fulfillment-pricing.sql DRAFT-lot-payment-p3b6-checkout-billing-context.sql DRAFT-lot-customer-order-tracking-foundation.sql DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql DRAFT-lot-receipt-invoice-tax-detail-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1-1-remediation.sql DRAFT-lot-payment-p1-foundation.sql DRAFT-lot-merchant-delivery-pricing.sql DRAFT-lot-orders-service-role-select-hardening.sql"
CGV_AFTER_N1A_CHAIN="DRAFT-lot-seller-legal-profile-cgv-engine-v1-2.sql DRAFT-lot-seller-legal-profile-cgv-engine-v1-3.sql DRAFT-lot-seller-legal-profile-cgv-engine-v1-4.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-1.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-2.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-4.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-5.sql"
TRACKING_TAIL="DRAFT-lot-tracking-final-fiscal-summary-v1-1.sql DRAFT-lot-customer-tracking-capability-v3-1.sql DRAFT-lot-customer-contact-live-tracking-v1.sql"

# Le harnais refuse de démarrer si un seul maillon manque : une chaîne
# silencieusement tronquée produirait des preuves sans valeur.
for f in $MINIMAL_CHAIN $REST_CHAIN DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql \
         DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql $CGV_AFTER_N1A_CHAIN \
         DRAFT-lot-order-received-enqueue-recovery-v1.sql \
         migration-20260919000000-order-success-boundary-v1.sql $TRACKING_TAIL \
         "$V1_SQL" "$LOT_SQL" "$LOT_ROLLBACK" "$F02_SQL" "$F02_RB"; do
  [ -f "$SUPABASE_DIR/$f" ] || fatal "maillon de chaîne prédécesseur absent : supabase/$f"
done

create_tracked_db "$DB_BASE"
DB="$DB_BASE"

psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<'SQL' || fatal "amorçage (auth/roles/storage) : $(tr '\n' ' ' < "$ERR")"
create schema if not exists auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;
create extension if not exists pgcrypto;
create publication supabase_realtime;
create schema if not exists storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/'); $$;
SQL

# ════════════════════════════════════════════════════════════════════
# MUTATION DE RÔLES À LA MISE EN PLACE — même garde que le nettoyage
#
# Les rôles anon / authenticated / service_role sont des objets
# GLOBAUX du cluster, pas des objets de la base jetable. Les créer
# depuis l'amorçage d'une base, comme le faisait la version précédente,
# avait deux défauts : la mutation échappait au prédicat d'identité, et
# un marqueur vivant dans « postgres » n'est pas visible depuis une
# autre base -- la garde n'aurait donc pas pu s'y appliquer.
#
# Elle se fait donc ici, au niveau du cluster, par le point de passage
# commun. Le mandat l'exige explicitement : « setup-time role mutation »
# relève du même contrat que la restauration.
# ════════════════════════════════════════════════════════════════════
csdj1_identity_mutate "
  if not exists (select from pg_catalog.pg_roles where rolname='anon') then
    create role anon nologin;
  end if;
  if not exists (select from pg_catalog.pg_roles where rolname='authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select from pg_catalog.pg_roles where rolname='service_role') then
    create role service_role nologin;
  end if;
  alter role service_role bypassrls;
  alter role anon nobypassrls;
  alter role authenticated nobypassrls;
" || fatal "mise en place des rôles globaux REFUSÉE ($CSDJ1_ID_LAST) : l'identité complète du cluster n'est pas prouvée."

for f in $MINIMAL_CHAIN; do
  apply_file "$f" || fatal "chaîne prédécesseur, $f : $(head -3 "$ERR" | tr '\n' ' ')"
  psql -X -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
done
for f in $REST_CHAIN; do
  apply_file "$f" || fatal "chaîne prédécesseur, $f : $(head -3 "$ERR" | tr '\n' ' ')"
done
apply_file "DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql" || fatal "CGV v1.1 : $(head -3 "$ERR" | tr '\n' ' ')"
apply_file "DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql" || fatal "N1-A : $(head -3 "$ERR" | tr '\n' ' ')"
for f in $CGV_AFTER_N1A_CHAIN; do
  apply_file "$f" || fatal "chaîne CGV, $f : $(head -3 "$ERR" | tr '\n' ' ')"
done
psql -X -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
apply_file "DRAFT-lot-order-received-enqueue-recovery-v1.sql" || fatal "reprise d'enfilement : $(head -3 "$ERR" | tr '\n' ' ')"
apply_file "migration-20260919000000-order-success-boundary-v1.sql" || fatal "ORDER SUCCESS BOUNDARY v1 : $(head -3 "$ERR" | tr '\n' ' ')"
psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<'SQL' || fatal "talon order_invoice_request : $(tr '\n' ' ' < "$ERR")"
create table public.order_invoice_request (
  order_id uuid primary key references public.orders(id) on delete cascade
);
alter table public.order_invoice_request enable row level security;
revoke all on table public.order_invoice_request from public, anon, authenticated;
SQL
for f in $TRACKING_TAIL; do
  apply_file "$f" || fatal "chaîne de suivi, $f : $(head -3 "$ERR" | tr '\n' ' ')"
done
log "chaîne prédécesseur appliquée (schema .. CUSTOMER CONTACT LIVE TRACKING v1)."

# CSDJ12-DEPLOY-01 : la chaîne s'arrête à CGV v2.5 (create_order ccbff371...) ; la PRODUCTION
# porte c3274457.... Le candidat audité de la v1.2 épingle cette empreinte : la fixture
# (jamais exécutée ici) aligne la SEULE fonction qui diffère. Sans fixture (v1.2 antérieure
# à DEPLOY-01), la chaîne reste telle quelle.
if [ -n "$V12_FIX_FILE" ]; then
  psql -X -d "$DB" -v ON_ERROR_STOP=1 -q -f "$V12_FIX_FILE" >/dev/null 2>"$ERR" \
    || fatal "fixture create_order PROD : $(head -3 "$ERR" | tr '\n' ' ')"
  PROD_CO_NOW="$(sql_value "select md5(replace(prosrc, chr(13)||chr(10), chr(10))) from pg_proc where proname='create_order' and pronamespace='public'::regnamespace;")"
  [ "$PROD_CO_NOW" = "$PROD_CO_MD5" ] \
    || fatal "la fixture create_order ne reproduit pas l'empreinte PROD ($PROD_CO_NOW, attendu $PROD_CO_MD5)."
  log "create_order aligné sur le prédécesseur PRODUCTION (md5 LF $PROD_CO_MD5)."
fi

# --- Fixtures POSÉES AVANT le lot (commerçants historiques, SANS la
#     moindre planification : c'est l'état de 100 % des commerçants).
psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<SQL || fatal "fixtures : $(tr '\n' ' ' < "$ERR")"
insert into auth.users (id, email) values
  ('$OWNER_A','owner-a@csdj1.test'), ('$MANAGER_A','manager-a@csdj1.test'),
  ('$STAFF_A','staff-a@csdj1.test'), ('$OWNER_B','owner-b@csdj1.test'),
  ('$STRANGER','stranger@csdj1.test');

insert into public.restaurants (id, slug, name, is_active, status, country) values
  ('$RID_A','csdj1-alpha','Epicerie Alpha',true,'active','FR'),
  ('$RID_B','csdj1-beta','Primeur Beta',true,'active','FR');

insert into public.restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number, address)
values ('$RID_A', 5, 'EUR', '+33600000001', '3 place du Marche, 75011 Paris'),
       ('$RID_B', 5, 'EUR', '+33600000002', '9 rue Beta, 75012 Paris');

insert into public.restaurant_users (restaurant_id, user_id, role) values
  ('$RID_A','$OWNER_A','owner'), ('$RID_A','$MANAGER_A','manager'),
  ('$RID_A','$STAFF_A','staff'), ('$RID_B','$OWNER_B','owner');

insert into public.menu_categories (id, restaurant_id, name, display_order)
values ('$CAT_A','$RID_A','Frais',1), ('$CAT_B','$RID_B','Frais',1);

insert into public.menu_items (id, category_id, name, price, is_available)
values ('$ITEM_A','$CAT_A','Fromage frais',12.50,true),
       ('$ITEM_B','$CAT_B','Legumes',8.00,true);

-- Modes de vente : retrait ET livraison activés chez les deux.
insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled, display_order)
values ('$RID_A','pickup',true,1), ('$RID_A','delivery',true,2),
       ('$RID_B','pickup',true,1), ('$RID_B','delivery',true,2)
on conflict (restaurant_id, mode_code) do update set enabled = true;

-- Une règle de livraison par commerçant : c'est elle qui porte la
-- PORTÉE d'une planification de livraison.
insert into public.restaurant_sale_mode_fulfillments
  (restaurant_id, mode_code, fulfillment_code, provider, zone_prefixes, is_fallback,
   min_items, customer_text, display_order, enabled, pricing_mode, fixed_fee)
values ('$RID_A','delivery','local_delivery','internal',array['75'],false,
        0,'Livraison en 2 h sur Paris 11e',1,true,'fixed',4.90),
       ('$RID_B','delivery','local_delivery','internal',array['75'],false,
        0,'Livraison Beta',1,true,'fixed',3.50);
SQL
RULE_A="$(sql_value "select id from public.restaurant_sale_mode_fulfillments where restaurant_id='$RID_A' and mode_code='delivery';")"
RULE_B="$(sql_value "select id from public.restaurant_sale_mode_fulfillments where restaurant_id='$RID_B' and mode_code='delivery';")"
[ -n "$RULE_A" ] && [ -n "$RULE_B" ] || fatal "règles de livraison fixtures illisibles."

BASE_COUNTS="$(schema_counts "$DB_BASE")"
BASE_CO_FP="$(fn_code_fingerprint 'create_order' "$DB_BASE")"
BASE_RESOLVER_FP="$(fn_code_fingerprint 'resolve_delivery_fulfillment' "$DB_BASE")"
log "fixtures posées (2 commerçants, 2 règles de livraison, AUCUNE planification)."


# ============================================================
# Outils propres à ce lot
# ============================================================
OPERATOR_ID='5ccccccc-cccc-4ccc-8ccc-cccccccc0001'   # opérateur Scanym, NON membre des établissements
own_out()   { psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$1" -c "$2" 2>&1; }
outcome_on() { # "OK" ou le premier message d'erreur, pour une base désignée
  local out rc
  out="$(psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$1" -c "$2" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then printf 'OK\n'; return 0; fi
  out="${out#*ERROR:  }"; out="${out%%$'\n'*}"; printf '%s\n' "$out"
}
has() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
assert_has() {
  local desc="$1" needle="$2" got="$3"
  if has "$got" "$needle"; then pass "$desc"; else fail "$desc — attendu un message contenant '$needle', obtenu '$(printf '%s' "$got" | cut -c1-200)'"; fi
}

inventory() { # $1 = base ; fonctions, colonnes, contraintes, politiques, déclencheurs, droits de table
  local db="$1"
  psql -X -A -q -t -d "$db" -c "select 'F|' || p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|' || coalesce(p.proacl::text,'-') || '|' || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig,','),'-') || '|' || pg_get_userbyid(p.proowner) from pg_proc p where p.pronamespace='public'::regnamespace order by 1"
  psql -X -A -q -t -d "$db" -c "select 'C|' || table_name || '|' || column_name || '|' || data_type || '|' || is_nullable || '|' || coalesce(column_default,'-') from information_schema.columns where table_schema='public' order by 1"
  psql -X -A -q -t -d "$db" -c "select 'K|' || conrelid::regclass::text || '|' || conname || '|' || pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace order by 1"
  psql -X -A -q -t -d "$db" -c "select 'P|' || tablename || '|' || policyname || '|' || cmd || '|' || coalesce(qual,'-') || '|' || coalesce(with_check,'-') from pg_policies where schemaname='public' order by 1"
  psql -X -A -q -t -d "$db" -c "select 'T|' || c.relname || '|' || t.tgname || '|' || pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and not t.tgisinternal order by 1"
  psql -X -A -q -t -d "$db" -c "select 'R|' || c.relname || '|' || coalesce(c.relacl::text,'-') || '|' || c.relrowsecurity::text from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' order by 1"
}
# Un appel de l'écriture comme un client RÉEL : rôle PostgREST + utilisateur du JWT.
#   call_save <base> <rôle|-> <uid|-> <restaurant> <charge json>
# Sortie : le JSON rendu (une ligne), ou « ERR|<message>|<détail> ».
call_save() {
  local db="$1" role="$2" uid="$3" rid="$4" payload="$5" out rc opts="-c lc_messages=C"
  [ "$role" != "-" ] && opts="$opts -c role=$role"
  [ "$uid" = "-" ] && uid=""
  out="$(PGOPTIONS="$opts" psql -X -A -q -t -v ON_ERROR_STOP=1 -v p="$payload" -d "$db" 2>&1 <<SQL
set test.uid = '$uid';
${CALL_PRE:-}
select public.save_fulfillment_configuration('$rid'::uuid, :'p'::jsonb);
${CALL_POST:-}
SQL
)"; rc=$?
  if [ "$rc" -eq 0 ]; then printf '%s\n' "$out" | tail -1; return 0; fi
  local msg det
  msg="$(printf '%s\n' "$out" | grep -m1 'ERROR:' | sed 's/^.*ERROR:  //')"
  det="$(printf '%s\n' "$out" | grep -m1 'DETAIL:' | sed 's/^DETAIL:  //')"
  printf 'ERR|%s|%s\n' "$msg" "$det"
}
call_get() { # <base> <rôle|-> <uid|-> <restaurant> <mode> <règle|null>
  local db="$1" role="$2" uid="$3" rid="$4" mode="$5" rule="$6" out rc opts="-c lc_messages=C"
  [ "$role" != "-" ] && opts="$opts -c role=$role"
  [ "$uid" = "-" ] && uid=""
  local ruleq="null"; [ "$rule" != "null" ] && ruleq="'$rule'::uuid"
  out="$(PGOPTIONS="$opts" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$db" 2>&1 <<SQL
set test.uid = '$uid';
select coalesce(public.get_fulfillment_configuration('$rid'::uuid, '$mode', $ruleq)::text, 'NULL');
SQL
)"; rc=$?
  if [ "$rc" -eq 0 ]; then printf '%s\n' "$out" | tail -1; return 0; fi
  printf 'ERR|%s|\n' "$(printf '%s\n' "$out" | grep -m1 'ERROR:' | sed 's/^.*ERROR:  //')"
}
is_err() { case "$1" in ERR\|*) return 0 ;; *) return 1 ;; esac; }
# Valeur d'un chemin dans un JSON : jv <json> <chemin postgres, ex. {policy,minLeadDays}>
jv() { psql -X -A -q -t -v b="$1" -d postgres 2>/dev/null <<SQL | tail -1
select (:'b'::jsonb) #>> '$2';
SQL
}
# Transforme une charge : pm <json> <expression SQL qui utilise :'b'>
pm() { psql -X -A -q -t -v b="$1" -d postgres 2>&1 <<SQL | tail -1
select $2;
SQL
}

# --- Charges de référence --------------------------------------------------
# « ALC » = fixture de TEST seulement : retrait mardi–samedi en deux créneaux
# (11–14 / 16–20), dimanche et lundi fermés, heure limite 16 h. Elle n'existe
# que dans CE harnais et dans la documentation : le lot n'insère rien.
mk_alc() { # [rid de règle|null]
  psql -X -A -q -t -d postgres <<SQL | tail -1
select jsonb_build_object(
  'modeCode','pickup','fulfillmentRuleId',${1:-null}::text,'method','v1.2','enabled',true,
  'policy', jsonb_build_object('timezone','Europe/Paris','dateSelectionMode','customer_selectable',
    'slotSelectionMode','fixed_slots','timeGranularityMinutes',null,'leadTimeMinutes',0,'minLeadDays',1,
    'cutoffTime','16:00','cutoffOffsetDays',0,'bookingHorizonDays',14),
  'windows','[]'::jsonb,
  'slots',(select jsonb_agg(jsonb_build_object('weekday',d,'slotKey',k,'startsAt',s,'endsAt',e,'displayOrder',o) order by d,o)
           from generate_series(2,6) d, (values ('midi','11:00','14:00',0),('soir','16:00','20:00',1)) v(k,s,e,o)),
  'closures','[]'::jsonb,
  'preparation', jsonb_build_object('weekdays','[1,2,3,4,5]'::jsonb,'closures','[]'::jsonb),
  'holidays', jsonb_build_object('calendarId',null,'preparationOnHolidays','open','availabilityOnHolidays','open'),
  'capacity', jsonb_build_object('enabled',false,'maxOrders',null))
SQL
}
mk_v1() { # méthode v1 : fenêtres, décalage d'heure limite
  psql -X -A -q -t -d postgres <<SQL | tail -1
select jsonb_build_object(
  'modeCode','pickup','fulfillmentRuleId',null,'method','v1','enabled',true,
  'policy', jsonb_build_object('timezone','Europe/Paris','dateSelectionMode','customer_selectable',
    'slotSelectionMode','none','timeGranularityMinutes',null,'leadTimeMinutes',120,'minLeadDays',0,
    'cutoffTime','12:00','cutoffOffsetDays',1,'bookingHorizonDays',10),
  'windows',(select jsonb_agg(jsonb_build_object('weekday',d,'startsAt',s,'endsAt',e,'displayOrder',o) order by d,o)
             from generate_series(1,5) d, (values ('09:00','12:00',0),('14:00','18:00',1)) v(s,e,o)),
  'slots','[]'::jsonb,
  'closures','[{"closedOn":"2026-12-25","label":"Noël"},{"closedOn":"2027-01-01","label":null}]'::jsonb)
SQL
}
with_token() { # <charge> <configuration persistée rendue> -> charge portant ses deux jetons
  pm "$1" "(:'b'::jsonb) || jsonb_build_object('expectedUpdatedAt','$(jv "$2" '{updatedAt}')','expectedRevision','$(jv "$2" '{revision}')')"
}
tok_only() { # <charge> <configuration> -> seulement expectedUpdatedAt
  pm "$1" "(:'b'::jsonb) || jsonb_build_object('expectedUpdatedAt','$(jv "$2" '{updatedAt}')')"
}

# Empreinte de TOUT l'état de planification d'un établissement (6 tables) :
# sert à prouver « rien n'a bougé » après un refus, et « rien n'a bougé chez les autres ».
tenant_digest() { # <base> <restaurant>
  sql_on "$1" "select md5(
    coalesce((select string_agg(x::text, '|' order by x::text) from public.restaurant_fulfillment_schedule x where restaurant_id='$2'),'')||'#'||
    coalesce((select string_agg(x::text, '|' order by x::text) from public.restaurant_fulfillment_schedule_window x where restaurant_id='$2'),'')||'#'||
    coalesce((select string_agg(x::text, '|' order by x::text) from public.restaurant_fulfillment_schedule_slot x where restaurant_id='$2'),'')||'#'||
    coalesce((select string_agg(x::text, '|' order by x::text) from public.restaurant_fulfillment_schedule_closure x where restaurant_id='$2'),'')||'#'||
    coalesce((select string_agg(x::text, '|' order by x::text) from public.restaurant_fulfillment_prep_day x where restaurant_id='$2'),'')||'#'||
    coalesce((select string_agg(x::text, '|' order by x::text) from public.restaurant_fulfillment_prep_closure x where restaurant_id='$2'),''));"
}
scope_counts() { # <base> <restaurant> <mode> -> w|s|c|pd|pc
  sql_on "$1" "select (select count(*) from public.restaurant_fulfillment_schedule_window where restaurant_id='$2' and mode_code='$3' and rule_key='$NIL_RULE')||'|'||
    (select count(*) from public.restaurant_fulfillment_schedule_slot where restaurant_id='$2' and mode_code='$3' and rule_key='$NIL_RULE')||'|'||
    (select count(*) from public.restaurant_fulfillment_schedule_closure where restaurant_id='$2' and mode_code='$3' and rule_key='$NIL_RULE')||'|'||
    (select count(*) from public.restaurant_fulfillment_prep_day where restaurant_id='$2' and mode_code='$3' and rule_key='$NIL_RULE')||'|'||
    (select count(*) from public.restaurant_fulfillment_prep_closure where restaurant_id='$2' and mode_code='$3' and rule_key='$NIL_RULE');"
}
wipe_scope() { # <base> <restaurant> : repart de zéro (tables de planification de l'établissement)
  psql -X -d "$1" -v ON_ERROR_STOP=1 -q -c "delete from public.order_fulfillment_capacity_reservation where restaurant_id='$2'; delete from public.restaurant_fulfillment_schedule where restaurant_id='$2';" >/dev/null 2>"$ERR" \
    || fatal "wipe_scope($1,$2) : $(head -2 "$ERR" | tr '\n' ' ')"
}

# ============================================================
# [0b] État PROD : prédécesseur + CSDJ-1 v1.10
# ============================================================
log "=== [0b] État prédécesseur : CSDJ-1 v1.10 ($DB_V1) ==="
clone_base "$DB_V1"
apply_path "$SUPABASE_DIR/$V1_SQL" "$DB_V1" || fatal "CSDJ-1 v1.10 ne s'applique pas sur le prédécesseur : $(tail -3 "$OUT" | tr '\n' ' ')"

# ============================================================
# [1a] L'HÉBERGÉ AVANT CE LOT : CSDJ-1 + CSDJ v1.2 (moteur désigné, identité épinglée)
# ============================================================
log "=== [1a] État hébergé : + CSDJ v1.2 ($DB_PRE) ==="
create_tracked_db "$DB_PRE" -T "$DB_V1"
if apply_path "$V12_FWD_FILE" "$DB_PRE"; then
  pass "[1a] le moteur CSDJ v1.2 ($V12_PIN_NAME) s'applique sur CSDJ-1 : l'état de départ de ce lot est celui de l'hébergé"
else
  fatal "le moteur CSDJ v1.2 ne s'applique pas : $(tail -4 "$OUT" | tr '\n' ' ')"
fi

# Données HISTORIQUES posées par les mutateurs EXISTANTS (comme sur l'hébergé,
# où des commerçants ont déjà une configuration) : le lot ne doit en changer
# aucun octet. A = retrait v1.2 ; B = retrait v1 + une règle de livraison.
legacy_seed() {
  local db="$1"
  psql -X -d "$db" -v ON_ERROR_STOP=1 -q >/dev/null 2>"$ERR" <<SQL || fatal "données historiques : $(head -3 "$ERR" | tr '\n' ' ')"
set role authenticated; set test.uid = '$OWNER_A';
select public.mutate_merchant_fulfillment_schedule_v12('$RID_A','save_schedule_v12',
  '{"modeCode":"pickup","timezone":"Europe/Paris","enabled":true,"dateSelectionMode":"customer_selectable","slotSelectionMode":"none","minLeadDays":1,"cutoffTime":"10:00","bookingHorizonDays":14}'::jsonb);
select public.mutate_merchant_fulfillment_schedule('$RID_A','replace_windows','{"modeCode":"pickup","windows":[{"weekday":1,"startsAt":"11:00","endsAt":"14:00"},{"weekday":2,"startsAt":"11:00","endsAt":"14:00"}]}'::jsonb);
select public.mutate_merchant_fulfillment_schedule_v12('$RID_A','replace_prep_days','{"modeCode":"pickup","weekdays":[1,2,3,4,5]}'::jsonb);
select public.mutate_merchant_fulfillment_schedule('$RID_A','replace_closures','{"modeCode":"pickup","closures":[{"closedOn":"2026-12-25","label":"Noël"}]}'::jsonb);
reset role; set role authenticated; set test.uid = '$OWNER_B';
select public.mutate_merchant_fulfillment_schedule('$RID_B','save_schedule',
  '{"modeCode":"pickup","timezone":"Europe/Paris","enabled":true,"dateSelectionMode":"customer_selectable","slotSelectionMode":"fixed_slots","minLeadDays":0,"cutoffTime":"12:00","cutoffOffsetDays":1,"bookingHorizonDays":10}'::jsonb);
select public.mutate_merchant_fulfillment_schedule('$RID_B','replace_slots','{"modeCode":"pickup","slots":[{"weekday":3,"slotKey":"aprem","startsAt":"14:00","endsAt":"18:00"}]}'::jsonb);
SQL
}
legacy_seed "$DB_PRE"
PRE_SEED_A="$(tenant_digest "$DB_PRE" "$RID_A")"
PRE_SEED_B="$(tenant_digest "$DB_PRE" "$RID_B")"
[ "$(sql_on "$DB_PRE" "select count(*) from public.restaurant_fulfillment_schedule;")" = "2" ] || fatal "données historiques non posées."
inventory "$DB_PRE" | sort > "$TMP_DIR/inv.pre"
[ -s "$TMP_DIR/inv.pre" ] || fatal "inventaire de référence vide."
PRE_CO_MD5="$(sql_on "$DB_PRE" "select md5(prosrc) from pg_proc where proname='create_order' and pronamespace='public'::regnamespace;")"
log "données historiques posées par les mutateurs existants (2 portées, 2 établissements) ; inventaire de référence : $(wc -l < "$TMP_DIR/inv.pre") lignes."

# ============================================================
# [1] APPLICATION de ce lot sur l'état hébergé
# ============================================================
log "=== [1] Application de ce lot ($DB_NEW) ==="
create_tracked_db "$DB_NEW" -T "$DB_PRE"
if apply_path "$SUPABASE_DIR/$LOT_SQL" "$DB_NEW"; then
  pass "[1] le lot s'applique sur l'état hébergé (CSDJ-1 + v1.2 + données existantes)"
else
  fail "[1] le lot ÉCHOUE : $(tail -5 "$OUT" | tr '\n' ' ')"
  fatal "sans lot appliqué aucune autre preuve n'est possible."
fi
DB="$DB_NEW"
# Un opérateur Scanym, non membre.
psql -X -d "$DB" -v ON_ERROR_STOP=1 -q -c "insert into auth.users (id, email) values ('$OPERATOR_ID','operator@csdjbo1.test') on conflict do nothing; insert into public.scanym_operators (user_id) values ('$OPERATOR_ID') on conflict do nothing;" >/dev/null 2>"$ERR" \
  || fatal "opérateur de test : $(head -2 "$ERR" | tr '\n' ' ')"
# Copie PROPRE de la base du lot (avant toute écriture de preuve) : sert de modèle aux
# épreuves d'atomicité, de non-régression jumelée et de retour arrière.
create_tracked_db "$DB_ATOMIC" -T "$DB_NEW"
ROOT_DIR="$(cd "$SUPABASE_DIR/.." && pwd)"
BASE_NEW_TEMPLATE_DONE=1

# ============================================================
# Outils propres à F-02
# ============================================================
ecode() { printf '%s' "$1" | sed -n 's/^ERR|\([A-Za-z0-9_]*\):.*/\1/p'; }
blk_of() { printf '%s' "$1" | sed -n 's/.*blockers=\([a-z_,]*\).*/\1/p' | head -1; }
expect_code() { # <description> <code attendu> <résultat>
  local got; got="$(ecode "$3")"
  if [ "$got" = "$2" ]; then pass "$1 → $2"; else fail "$1 — attendu $2, obtenu '${got:-<aucun code nommé>}' ($(printf '%s' "$3" | cut -c1-220))"; fi
}
expect_inc() { # <description> <bloqueurs attendus> <résultat> : refus INCOMPLETE avec ces bloqueurs exacts
  local got; got="$(ecode "$3")"
  if [ "$got" = "CSDJBO1_INCOMPLETE_CONFIGURATION" ] && [ "$(blk_of "$3")" = "$2" ]; then pass "$1 → CSDJBO1_INCOMPLETE_CONFIGURATION [blockers=$2]"
  else fail "$1 — attendu CSDJBO1_INCOMPLETE_CONFIGURATION blockers=$2, obtenu '${got:-<aucun>}' blockers='$(blk_of "$3")' ($(printf '%s' "$3" | cut -c1-200))"; fi
}
# Appel d'un mutateur HISTORIQUE comme un client réel (rôle PostgREST + utilisateur du JWT).
#   call_legacy <base> <uid> <v1|v12> <restaurant> <action> <charge json>   -> « OK » ou « ERR|<message>|<détail> »
call_legacy() {
  local db="$1" uid="$2" which="$3" rid="$4" action="$5" payload="$6" out rc fn=mutate_merchant_fulfillment_schedule
  [ "$which" = "v12" ] && fn=mutate_merchant_fulfillment_schedule_v12
  [ "$uid" = "-" ] && uid=""
  out="$(PGOPTIONS="-c lc_messages=C -c role=authenticated" psql -X -A -q -t -v ON_ERROR_STOP=1 -v p="$payload" -d "$db" 2>&1 <<SQL
set test.uid = '$uid';
select public.$fn('$rid'::uuid, '$action', :'p'::jsonb);
SQL
)"; rc=$?
  if [ "$rc" -eq 0 ]; then printf 'OK\n'; return 0; fi
  printf 'ERR|%s|%s\n' "$(printf '%s\n' "$out" | grep -m1 'ERROR:' | sed 's/^.*ERROR:  //')" "$(printf '%s\n' "$out" | grep -m1 'DETAIL:' | sed 's/^DETAIL:  //')"
}
sqlstate_legacy() { # <base> <uid> <v1|v12> <rid> <action> <charge>
  local fn=mutate_merchant_fulfillment_schedule; [ "$3" = "v12" ] && fn=mutate_merchant_fulfillment_schedule_v12
  PGOPTIONS="-c lc_messages=C -c role=authenticated" psql -X -A -q -t -v ON_ERROR_STOP=1 -v p="$6" -d "$1" 2>&1 <<SQL | sed -n 's/^ERROR:  \([0-9A-Z]\{5\}\):.*/\1/p' | head -1
\set VERBOSITY verbose
set test.uid = '$2';
select public.$fn('$4'::uuid, '$5', :'p'::jsonb);
SQL
}
# État d'une portée : « activée|fenêtres|créneaux|jours de préparation » (ou « absent|0|0|0 »).
scope_state() { # <base> <restaurant> [mode=pickup]
  local m="${3:-pickup}"
  sql_on "$1" "select coalesce((select enabled::text from public.restaurant_fulfillment_schedule where restaurant_id='$2' and mode_code='$m' and rule_key='$NIL_RULE'),'absent')||'|'||
    (select count(*) from public.restaurant_fulfillment_schedule_window where restaurant_id='$2' and mode_code='$m' and rule_key='$NIL_RULE')||'|'||
    (select count(*) from public.restaurant_fulfillment_schedule_slot where restaurant_id='$2' and mode_code='$m' and rule_key='$NIL_RULE')||'|'||
    (select count(*) from public.restaurant_fulfillment_prep_day where restaurant_id='$2' and mode_code='$m' and rule_key='$NIL_RULE');"
}
# Charges de référence des mutateurs historiques.
P12_BASE='"modeCode":"pickup","timezone":"Europe/Paris","dateSelectionMode":"customer_selectable","minLeadDays":1,"cutoffTime":"16:00","bookingHorizonDays":14'
BYP12="{$P12_BASE,\"enabled\":true,\"slotSelectionMode\":\"fixed_slots\"}"     # le contournement de Cat Greco (F-02)
DRAFT12="{$P12_BASE,\"enabled\":false,\"slotSelectionMode\":\"fixed_slots\"}"
ON12_FIXED="{$P12_BASE,\"enabled\":true,\"slotSelectionMode\":\"fixed_slots\"}"
ON12_NONE="{$P12_BASE,\"enabled\":true,\"slotSelectionMode\":\"none\"}"
OFF12_NONE="{$P12_BASE,\"enabled\":false,\"slotSelectionMode\":\"none\"}"
TWW12="{$P12_BASE,\"enabled\":false,\"slotSelectionMode\":\"time_within_window\"}"
BYP1="{$P12_BASE,\"cutoffOffsetDays\":1,\"enabled\":true,\"slotSelectionMode\":\"fixed_slots\"}"
DRAFT1="{$P12_BASE,\"cutoffOffsetDays\":1,\"enabled\":false,\"slotSelectionMode\":\"fixed_slots\"}"
ON1_NONE="{$P12_BASE,\"cutoffOffsetDays\":1,\"enabled\":true,\"slotSelectionMode\":\"none\"}"
SLOTS2='{"modeCode":"pickup","slots":[{"weekday":2,"slotKey":"midi","startsAt":"11:00","endsAt":"14:00"},{"weekday":2,"slotKey":"soir","startsAt":"16:00","endsAt":"20:00"}]}'
SLOTS0='{"modeCode":"pickup","slots":[]}'
WIN1='{"modeCode":"pickup","windows":[{"weekday":2,"startsAt":"11:00","endsAt":"14:00"}]}'
WIN0='{"modeCode":"pickup","windows":[]}'
PREP23='{"modeCode":"pickup","weekdays":[2,3]}'
PREP0='{"modeCode":"pickup","weekdays":[]}'
CLOS1='{"modeCode":"pickup","closures":[{"closedOn":"2026-12-25","label":"Noël"}]}'
DEL='{"modeCode":"pickup"}'

# ============================================================
# [F1] APPLICATION de l'invariant sur l'état « BO1 appliqué » (DB_F02)
# ============================================================
log "=== [F1] Application de l'invariant F-02 ($DB_F02) ==="
create_tracked_db "$DB_F02" -T "$DB_ATOMIC"
inventory "$DB_F02" | sort > "$TMP_DIR/inv.f02.before"
F2_A_BEFORE="$(tenant_digest "$DB_F02" "$RID_A")"; F2_B_BEFORE="$(tenant_digest "$DB_F02" "$RID_B")"
assert_eq "[F1] l'état de départ est celui des données historiques (A)" "$PRE_SEED_A" "$F2_A_BEFORE"
assert_eq "[F1] l'état de départ est celui des données historiques (B)" "$PRE_SEED_B" "$F2_B_BEFORE"
if apply_path "$SUPABASE_DIR/$F02_SQL" "$DB_F02"; then pass "[F1] le lot F-02 s'applique sur l'état hébergé + BO1 (données historiques présentes)"
else fail "[F1] le lot F-02 ÉCHOUE : $(tail -5 "$OUT" | tr '\n' ' ')"; fatal "sans lot appliqué aucune autre preuve n'est possible."; fi
assert_has "[F1] le post-vol annonce zéro portée active incomplète" "LEGACY_VIOLATIONS=0" "$(cat "$OUT")"
assert_eq "[F1] les données historiques n'ont pas bougé d'un octet (A)" "$F2_A_BEFORE" "$(tenant_digest "$DB_F02" "$RID_A")"
assert_eq "[F1] ... ni (B)" "$F2_B_BEFORE" "$(tenant_digest "$DB_F02" "$RID_B")"
inventory "$DB_F02" | sort > "$TMP_DIR/inv.f02.after"
DIFFN="$(diff "$TMP_DIR/inv.f02.before" "$TMP_DIR/inv.f02.after" | grep -c '^[<>]' || true)"
DIFFADD="$(diff "$TMP_DIR/inv.f02.before" "$TMP_DIR/inv.f02.after" | grep -c '^>' || true)"
DIFFNOT="$(diff "$TMP_DIR/inv.f02.before" "$TMP_DIR/inv.f02.after" | grep '^>' | grep -vc 'csdjbo1_f02' || true)"
assert_eq "[F1] l'inventaire (fonctions, colonnes, contraintes, politiques, déclencheurs, droits) ne change que par AJOUT de 10 lignes" "10|10|0" "$DIFFN|$DIFFADD|$DIFFNOT"
assert_eq "[F1] deux fonctions et quatre déclencheurs du lot, rien d'autre" "2|4" "$(sql_on "$DB_F02" "select (select count(*) from pg_proc where proname like 'csdjbo1_f02%')||'|'||(select count(*) from pg_trigger where tgname='csdjbo1_f02_activation_invariant');")"
assert_eq "[F1] fonctions SECURITY DEFINER, search_path vide, volatilité attendue" "true|{\"search_path=\\\"\\\"\"}|v;true|{\"search_path=\\\"\\\"\"}|s" "$(sql_on "$DB_F02" "select string_agg(prosecdef::text||'|'||proconfig::text||'|'||provolatile::text, ';' order by proname) from pg_proc where proname like 'csdjbo1_f02%';")"
assert_eq "[F1] déclencheurs : contrainte, différés, par ligne, actifs (origine), bonne fonction" "4" "$(sql_on "$DB_F02" "select count(*) from pg_trigger t where tgname='csdjbo1_f02_activation_invariant' and tgconstraint<>0 and tgdeferrable and tginitdeferred and tgenabled='O' and (tgtype&1)=1 and (tgtype&2)=0 and tgfoid='public.csdjbo1_f02_enforce()'::regprocedure;")"
assert_eq "[F1] événements : schedule = INSERT+UPDATE ; window/slot/prep_day = UPDATE+DELETE" "restaurant_fulfillment_prep_day:24;restaurant_fulfillment_schedule:20;restaurant_fulfillment_schedule_slot:24;restaurant_fulfillment_schedule_window:24" "$(sql_on "$DB_F02" "select string_agg(c.relname||':'||(t.tgtype&28), ';' order by c.relname) from pg_trigger t join pg_class c on c.oid=t.tgrelid where t.tgname='csdjbo1_f02_activation_invariant';")"
assert_eq "[F1] ACL : aucun rôle applicatif ne peut exécuter les fonctions du lot" "false|false|false|false|false|false" "$(sql_on "$DB_F02" "select string_agg(has_function_privilege(r, p, 'EXECUTE')::text, '|' order by r, p) from unnest(array['anon','authenticated','service_role']) r, unnest(array['public.csdjbo1_f02_enforce()'::regprocedure,'public.csdjbo1_f02_scope_blockers(uuid,text,uuid)'::regprocedure]) p;")"
R="$(PGOPTIONS="-c lc_messages=C -c role=authenticated" psql -X -A -q -t -d "$DB_F02" -c "select public.csdjbo1_f02_scope_blockers('$RID_A'::uuid,'pickup','$NIL_RULE'::uuid);" 2>&1)"
assert_has "[F1] authenticated n'appelle pas la définition de « complète » (permission refusée)" "permission denied" "$R"
R="$(PGOPTIONS="-c lc_messages=C -c role=authenticated" psql -X -A -q -t -d "$DB_F02" -c "select public.csdjbo1_f02_enforce();" 2>&1)"
assert_has "[F1] authenticated n'appelle pas la fonction de contrôle (permission refusée)" "permission denied" "$R"
# Les portées historiques COMPLÈTES restent écrivables : une écriture sans effet sur l'offre passe.
R="$(call_legacy "$DB_F02" "$OWNER_A" v12 "$RID_A" replace_prep_closures '{"modeCode":"pickup","closures":[{"closedOn":"2026-11-11"}]}')"
assert_eq "[F1] une écriture historique sur une portée complète passe toujours" "OK" "$R"
# Inventaire des droits EXECUTE des mutateurs historiques : inchangés par le lot (preuve de non-révocation).
for fn in 'public.mutate_merchant_fulfillment_schedule(uuid,text,jsonb)' 'public.mutate_merchant_fulfillment_schedule_v12(uuid,text,jsonb)'; do
  GR="$(sql_on "$DB_F02" "select string_agg(r||'='||has_function_privilege(r,'$fn'::regprocedure,'EXECUTE')::text, ',' order by r) from unnest(array['anon','authenticated','service_role']) r;")"
  log "droits EXECUTE de ${fn%%(*} : $GR"
  has "$GR" "authenticated=true" && has "$GR" "anon=false" && pass "[F1] ${fn%%(*} : EXECUTE inchangé (authenticated oui, anon non) -- l'invariant ne révoque rien, la voie de suppression est préservée" || fail "[F1] droits inattendus sur ${fn%%(*} : $GR"
done

# ============================================================
# [F2] LE DÉFAUT F-02 : ROUGE sans le lot, VERT avec
#      (rejeu exact du contournement relevé par Cat Greco : owner, rôle authenticated,
#       mutateur historique, enabled:true, fixed_slots, ni créneau ni jour de préparation)
# ============================================================
log "=== [F2] Rejeu du contournement F-02 : sans le lot (ROUGE) puis avec le lot (VERT) ==="
# ROUGE : l'état hébergé + BO1, SANS l'invariant (DB_NEW), laisse faire.
wipe_scope "$DB_NEW" "$RID_A"
R="$(call_legacy "$DB_NEW" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$BYP12")"
assert_eq "[F2.1] ROUGE (sans le lot) : owner → mutate_..._v12 → enabled:true, fixed_slots, sans créneau ni préparation : AUCUNE erreur" "OK" "$R"
assert_eq "[F2.1] ROUGE : la portée est ACTIVE avec 0 fenêtre, 0 créneau, 0 jour de préparation" "true|0|0|0" "$(scope_state "$DB_NEW" "$RID_A")"
wipe_scope "$DB_NEW" "$RID_A"
R="$(call_legacy "$DB_NEW" "$MANAGER_A" v12 "$RID_A" save_schedule_v12 "$BYP12")"
assert_eq "[F2.1] ROUGE : même chose pour un MANAGER" "OK" "$R"
wipe_scope "$DB_NEW" "$RID_A"
R="$(call_legacy "$DB_NEW" "$OWNER_A" v1 "$RID_A" save_schedule "$BYP1")"
assert_eq "[F2.1] ROUGE : même chose par le mutateur v1 (fixed_slots, aucun créneau)" "OK" "$R"
wipe_scope "$DB_NEW" "$RID_A"

# VERT : avec l'invariant, REFUS ATOMIQUE.
wipe_scope "$DB_F02" "$RID_A"
SNAP="$(tenant_digest "$DB_F02" "$RID_A")"
for who in "owner|$OWNER_A" "manager|$MANAGER_A"; do
  role="${who%%|*}"; uid="${who#*|}"
  R="$(call_legacy "$DB_F02" "$uid" v12 "$RID_A" save_schedule_v12 "$BYP12")"
  expect_inc "[F2.2] VERT ($role, v1.2) : le contournement est refusé" "offer_missing,preparation_missing" "$R"
  assert_eq "[F2.2] ($role, v1.2) refus ATOMIQUE : aucune ligne écrite" "absent|0|0|0" "$(scope_state "$DB_F02" "$RID_A")"
  assert_eq "[F2.2] ($role, v1.2) ... l'état de l'établissement est inchangé" "$SNAP" "$(tenant_digest "$DB_F02" "$RID_A")"
  R="$(call_legacy "$DB_F02" "$uid" v1 "$RID_A" save_schedule "$BYP1")"
  expect_inc "[F2.3] VERT ($role, v1) : le contournement par le mutateur v1 est refusé" "offer_missing" "$R"
  assert_eq "[F2.3] ($role, v1) refus ATOMIQUE" "absent|0|0|0" "$(scope_state "$DB_F02" "$RID_A")"
done
assert_eq "[F2.4] SQLSTATE du refus : 23514 (check_violation), identique à la RPC" "23514" "$(sqlstate_legacy "$DB_F02" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$BYP12")"
R="$(call_legacy "$DB_F02" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$BYP12")"
assert_has "[F2.4] le DETAIL nomme la source du refus (invariant)" "source=invariant" "$R"
assert_eq "[F2.5] message sans fuite : ni compte, ni identifiant de tenant, ni nom de table" "0" "$(printf '%s' "$R" | grep -Eic "$RID_A|restaurant_fulfillment|[0-9]+ (créneau|slot|ligne)" || true)"
# Un refus ne bloque pas la suite : le même mutateur, avec une portée COMPLÈTE, passe.
R="$(call_legacy "$DB_F02" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$DRAFT12")"; assert_eq "[F2.6] brouillon (enabled:false) sans rien : accepté" "OK" "$R"
assert_eq "[F2.6] ... la portée existe, désactivée" "false|0|0|0" "$(scope_state "$DB_F02" "$RID_A")"
R="$(call_legacy "$DB_F02" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$BYP12")"
expect_inc "[F2.6] ... l'activer sans rien est refusé" "offer_missing,preparation_missing" "$R"
assert_eq "[F2.6] ... et le brouillon reste exactement comme il était" "false|0|0|0" "$(scope_state "$DB_F02" "$RID_A")"

# ============================================================
# [F3] MATRICE DES MUTATEURS HISTORIQUES (DB_F02) : ce qui passe, ce qui est refusé, et
#      ce qui reste possible (suppression, désactivation, flux légitimes)
# ============================================================
log "=== [F3] Matrice des mutateurs historiques sous l'invariant ==="
wipe_scope "$DB_F02" "$RID_A"
# --- F3.1 Flux LÉGITIME v1.2 : brouillon → créneaux → préparation → activation (chaque appel = une transaction).
R="$(call_legacy "$DB_F02" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$DRAFT12")"; assert_eq "[F3.1] 1/4 brouillon" "OK" "$R"
R="$(call_legacy "$DB_F02" "$OWNER_A" v1 "$RID_A" replace_slots "$SLOTS2")";        assert_eq "[F3.1] 2/4 créneaux" "OK" "$R"
R="$(call_legacy "$DB_F02" "$OWNER_A" v12 "$RID_A" replace_prep_days "$PREP23")";   assert_eq "[F3.1] 3/4 jours de préparation" "OK" "$R"
R="$(call_legacy "$DB_F02" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$ON12_FIXED")"; assert_eq "[F3.1] 4/4 activation d'une portée COMPLÈTE : acceptée" "OK" "$R"
assert_eq "[F3.1] la portée est active et complète" "true|0|2|2" "$(scope_state "$DB_F02" "$RID_A")"
LEG_DONE="$(tenant_digest "$DB_F02" "$RID_A")"

# --- F3.2 Écritures qui APPAUVRIRAIENT une portée ACTIVE : refusées, état strictement inchangé.
refuse_keep() { # <description> <bloqueurs> <v1|v12> <action> <charge>
  local before after R
  before="$(tenant_digest "$DB_F02" "$RID_A")"
  R="$(call_legacy "$DB_F02" "$OWNER_A" "$3" "$RID_A" "$4" "$5")"
  expect_inc "$1" "$2" "$R"
  after="$(tenant_digest "$DB_F02" "$RID_A")"
  assert_eq "$1 : état strictement inchangé" "$before" "$after"
}
refuse_keep "[F3.2] vider les créneaux d'une portée active (fixed_slots)" "offer_missing" v1 replace_slots "$SLOTS0"
refuse_keep "[F3.2] vider les jours de préparation d'une portée active (v1.2)" "preparation_missing" v12 replace_prep_days "$PREP0"
refuse_keep "[F3.2] passer en politique « sans créneau » sans fenêtre, restant active" "offer_missing" v12 save_schedule_v12 "$ON12_NONE"
assert_eq "[F3.2] aucun de ces refus n'a rien changé à la portée" "$LEG_DONE" "$(tenant_digest "$DB_F02" "$RID_A")"
# La contrainte de table historique (grille) reste, elle aussi, première à refuser.
R="$(call_legacy "$DB_F02" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$(printf '%s' "$TWW12" | sed 's/"enabled":false/"enabled":true/')")"
assert_has "[F3.2] « heure libre » sans pas de grille : la contrainte de table historique refuse (rfs_granularity_required)" "rfs_granularity_required" "$R"
assert_eq "[F3.2] ... et la portée n'a pas bougé" "$LEG_DONE" "$(tenant_digest "$DB_F02" "$RID_A")"

# --- F3.3 Écritures qui NE TOUCHENT PAS l'offre d'une portée active : toujours permises.
R="$(call_legacy "$DB_F02" "$OWNER_A" v1 "$RID_A" replace_windows "$WIN0")"
assert_eq "[F3.3] vider les fenêtres d'une portée en créneaux nommés (fenêtres ignorées) : permis" "OK" "$R"
R="$(call_legacy "$DB_F02" "$OWNER_A" v1 "$RID_A" replace_closures "$CLOS1")";           assert_eq "[F3.3] remplacer les fermetures : permis" "OK" "$R"
R="$(call_legacy "$DB_F02" "$OWNER_A" v12 "$RID_A" replace_prep_closures '{"modeCode":"pickup","closures":[]}')"; assert_eq "[F3.3] remplacer les fermetures de préparation : permis" "OK" "$R"
R="$(call_legacy "$DB_F02" "$OWNER_A" v12 "$RID_A" replace_prep_days '{"modeCode":"pickup","weekdays":[4]}')"; assert_eq "[F3.3] REMPLACER (non vider) les jours de préparation d'une portée active : permis" "OK" "$R"
R="$(call_legacy "$DB_F02" "$OWNER_A" v1 "$RID_A" replace_slots '{"modeCode":"pickup","slots":[{"weekday":3,"slotKey":"aprem","startsAt":"14:00","endsAt":"18:00"}]}')"
assert_eq "[F3.3] REMPLACER (non vider) les créneaux d'une portée active : permis" "OK" "$R"
assert_eq "[F3.3] la portée est toujours active et complète" "true|0|1|1" "$(scope_state "$DB_F02" "$RID_A")"

# --- F3.4 Désactiver reste possible ; un brouillon peut être vidé ; ré-activer le vide est refusé.
R="$(call_legacy "$DB_F02" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$DRAFT12")"; assert_eq "[F3.4] désactiver (enabled:false) : permis" "OK" "$R"
R="$(call_legacy "$DB_F02" "$OWNER_A" v1 "$RID_A" replace_slots "$SLOTS0")";         assert_eq "[F3.4] vider les créneaux d'un BROUILLON : permis" "OK" "$R"
R="$(call_legacy "$DB_F02" "$OWNER_A" v12 "$RID_A" replace_prep_days "$PREP0")";     assert_eq "[F3.4] vider la préparation d'un BROUILLON : permis" "OK" "$R"
assert_eq "[F3.4] le brouillon est vide" "false|0|0|0" "$(scope_state "$DB_F02" "$RID_A")"
R="$(call_legacy "$DB_F02" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$ON12_FIXED")"
expect_inc "[F3.4] ré-activer ce brouillon vide : refusé" "offer_missing,preparation_missing" "$R"
assert_eq "[F3.4] ... il reste un brouillon vide" "false|0|0|0" "$(scope_state "$DB_F02" "$RID_A")"

# --- F3.5 SUPPRESSION : delete_schedule (seule porte de suppression) fonctionne sur une portée ACTIVE.
R="$(call_legacy "$DB_F02" "$OWNER_A" v1 "$RID_A" replace_slots "$SLOTS2")"; R2="$(call_legacy "$DB_F02" "$OWNER_A" v12 "$RID_A" replace_prep_days "$PREP23")"
R3="$(call_legacy "$DB_F02" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$ON12_FIXED")"
assert_eq "[F3.5] portée active reconstruite" "OK|OK|OK|true|0|2|2" "$R|$R2|$R3|$(scope_state "$DB_F02" "$RID_A")"
R="$(call_legacy "$DB_F02" "$OWNER_A" v1 "$RID_A" delete_schedule "$DEL")"
assert_eq "[F3.5] delete_schedule sur une portée ACTIVE : permis" "OK" "$R"
assert_eq "[F3.5] ... la portée et ses enfants ont disparu (cascade)" "absent|0|0|0" "$(scope_state "$DB_F02" "$RID_A")"
R="$(call_legacy "$DB_F02" "$MANAGER_A" v1 "$RID_A" delete_schedule "$DEL")"
assert_eq "[F3.5] supprimer ce qui n'existe pas : idempotent, comportement historique inchangé (OK)" "OK" "$R"

# --- F3.6 Méthode v1 : fenêtres (aucune préparation exigée).
R="$(call_legacy "$DB_F02" "$OWNER_A" v1 "$RID_A" save_schedule "$ON1_NONE")"
expect_inc "[F3.6] v1 : activer en fenêtres sans aucune fenêtre : refusé" "offer_missing" "$R"
R="$(call_legacy "$DB_F02" "$OWNER_A" v1 "$RID_A" save_schedule "$(printf '%s' "$ON1_NONE" | sed 's/"enabled":true/"enabled":false/')")"; assert_eq "[F3.6] v1 : brouillon" "OK" "$R"
R="$(call_legacy "$DB_F02" "$OWNER_A" v1 "$RID_A" replace_windows "$WIN1")"; assert_eq "[F3.6] v1 : une fenêtre" "OK" "$R"
R="$(call_legacy "$DB_F02" "$OWNER_A" v1 "$RID_A" save_schedule "$ON1_NONE")"; assert_eq "[F3.6] v1 : activation avec fenêtre (aucune préparation exigée en v1) : permis" "OK" "$R"
assert_eq "[F3.6] v1 : active, une fenêtre" "true|1|0|0" "$(scope_state "$DB_F02" "$RID_A")"
refuse_keep "[F3.6] v1 : vider les fenêtres d'une portée active" "offer_missing" v1 replace_windows "$WIN0"
R="$(call_legacy "$DB_F02" "$OWNER_A" v1 "$RID_A" delete_schedule "$DEL")"; assert_eq "[F3.6] v1 : suppression" "OK" "$R"

# --- F3.7 Autorisations historiques INCHANGÉES (l'invariant n'ouvre rien).
R="$(call_legacy "$DB_F02" "$STAFF_A" v12 "$RID_A" save_schedule_v12 "$DRAFT12")"; assert_has "[F3.7] staff : refus historique CSDJ12_FORBIDDEN" "CSDJ12_FORBIDDEN" "$R"
R="$(call_legacy "$DB_F02" "$STRANGER" v12 "$RID_A" save_schedule_v12 "$DRAFT12")"; assert_has "[F3.7] étranger : refus historique CSDJ12_FORBIDDEN" "CSDJ12_FORBIDDEN" "$R"
R="$(call_legacy "$DB_F02" "$OWNER_B" v12 "$RID_A" save_schedule_v12 "$DRAFT12")"; assert_has "[F3.7] owner d'un AUTRE tenant : refus historique CSDJ12_FORBIDDEN" "CSDJ12_FORBIDDEN" "$R"
R="$(call_legacy "$DB_F02" "-" v12 "$RID_A" save_schedule_v12 "$DRAFT12")";        assert_has "[F3.7] sans session : refus historique CSDJ12_AUTH_REQUIRED" "CSDJ12_AUTH_REQUIRED" "$R"
assert_eq "[F3.7] aucun de ces refus n'a écrit" "absent|0|0|0" "$(scope_state "$DB_F02" "$RID_A")"

# ============================================================
# [F4] LE POINT D'AUTORITÉ COMMUN : l'invariant tient pour TOUT écrivain, y compris le SQL direct d'un
#      rôle propriétaire ; sémantique transactionnelle (différée, état final) ; aucun contournement par un rôle applicatif
# ============================================================
log "=== [F4] Invariant au point d'autorité commun (écritures directes, transactions) ==="
sqltry() { # <base> <SQL> [rôle|-] -> OK | ERR|message|détail
  local opts="-c lc_messages=C" out rc
  [ "${3:--}" != "-" ] && opts="$opts -c role=$3"
  out="$(PGOPTIONS="$opts" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$1" 2>&1 <<SQL
$2
SQL
)"; rc=$?
  if [ "$rc" -eq 0 ]; then printf 'OK\n'; return 0; fi
  printf 'ERR|%s|%s\n' "$(printf '%s\n' "$out" | grep -m1 -E 'ERROR:' | sed 's/^.*ERROR:  //')" "$(printf '%s\n' "$out" | grep -m1 'DETAIL:' | sed 's/^DETAIL:  //')"
}
INS_SCHED="insert into public.restaurant_fulfillment_schedule (restaurant_id, mode_code, timezone, enabled, date_selection_mode, slot_selection_mode, cutoff_offset_days, schedule_method_version) values ('$RID_A','pickup','Europe/Paris',true,'customer_selectable','fixed_slots',0,'v1.2');"
INS_SLOT="insert into public.restaurant_fulfillment_schedule_slot (restaurant_id, mode_code, rule_key, weekday, slot_key, starts_at, ends_at) values ('$RID_A','pickup','$NIL_RULE',2,'midi','11:00','14:00');"
INS_PREP="insert into public.restaurant_fulfillment_prep_day (restaurant_id, mode_code, rule_key, weekday) values ('$RID_A','pickup','$NIL_RULE',2);"
wipe_scope "$DB_F02" "$RID_A"

R="$(sqltry "$DB_F02" "begin; $INS_SCHED $INS_SLOT $INS_PREP commit;")"
assert_eq "[F4.1] SQL direct (propriétaire) : portée active + créneau + préparation dans UNE transaction, ordre libre : accepté (contrôle différé, état FINAL)" "OK" "$R"
assert_eq "[F4.1] ... posée" "true|0|1|1" "$(scope_state "$DB_F02" "$RID_A")"
wipe_scope "$DB_F02" "$RID_A"
R="$(sqltry "$DB_F02" "begin; $INS_PREP $INS_SLOT commit;" )"
assert_has "[F4.2] enfants avant le parent : refusés par la clé étrangère historique (ordre parent d'abord)" "violates foreign key" "$R"
R="$(sqltry "$DB_F02" "begin; $INS_SCHED commit;")"
expect_inc "[F4.3] SQL direct : portée active SANS rien : refusée" "offer_missing,preparation_missing" "$R"
assert_eq "[F4.3] ... transaction entière annulée" "absent|0|0|0" "$(scope_state "$DB_F02" "$RID_A")"
R="$(sqltry "$DB_F02" "begin; $INS_SCHED $INS_SLOT commit;")"
expect_inc "[F4.4] SQL direct : créneau mais pas de préparation (v1.2) : refusée" "preparation_missing" "$R"
R="$(sqltry "$DB_F02" "begin; $INS_SCHED $INS_PREP commit;")"
expect_inc "[F4.4] SQL direct : préparation mais pas de créneau : refusée" "offer_missing" "$R"
assert_eq "[F4.4] ... rien d'écrit" "absent|0|0|0" "$(scope_state "$DB_F02" "$RID_A")"
R="$(sqltry "$DB_F02" "$INS_SCHED")"
expect_inc "[F4.5] SQL direct en AUTOCOMMIT (une instruction) : refusée aussi" "offer_missing,preparation_missing" "$R"
# Pas de contournement par SET CONSTRAINTS : IMMEDIATE ne fait que contrôler plus tôt ; DEFERRED est déjà le mode.
R="$(sqltry "$DB_F02" "begin; set constraints all immediate; $INS_SCHED commit;")"
expect_inc "[F4.6] SET CONSTRAINTS ALL IMMEDIATE : contrôle plus tôt, même refus" "offer_missing,preparation_missing" "$R"
R="$(sqltry "$DB_F02" "begin; set constraints all deferred; $INS_SCHED commit;")"
expect_inc "[F4.6] SET CONSTRAINTS ALL DEFERRED : toujours évalué AVANT le COMMIT" "offer_missing,preparation_missing" "$R"
R="$(sqltry "$DB_F02" "begin; $INS_SCHED savepoint s; $INS_SLOT $INS_PREP release s; commit;")"
assert_eq "[F4.7] points de sauvegarde : l'état final décide" "OK" "$R"

# --- Modifications d'une portée active (SQL direct) : retirer une offre est refusé, la remplacer ou désactiver non.
assert_eq "[F4.8] portée active de départ" "true|0|1|1" "$(scope_state "$DB_F02" "$RID_A")"
R="$(sqltry "$DB_F02" "delete from public.restaurant_fulfillment_schedule_slot where restaurant_id='$RID_A' and mode_code='pickup';")"
expect_inc "[F4.8] supprimer le dernier créneau d'une portée active : refusé" "offer_missing" "$R"
R="$(sqltry "$DB_F02" "delete from public.restaurant_fulfillment_prep_day where restaurant_id='$RID_A' and mode_code='pickup';")"
expect_inc "[F4.8] supprimer le dernier jour de préparation d'une portée active : refusé" "preparation_missing" "$R"
R="$(sqltry "$DB_F02" "begin; delete from public.restaurant_fulfillment_schedule_slot where restaurant_id='$RID_A' and mode_code='pickup'; insert into public.restaurant_fulfillment_schedule_slot (restaurant_id, mode_code, rule_key, weekday, slot_key, starts_at, ends_at) values ('$RID_A','pickup','$NIL_RULE',4,'aprem','14:00','18:00'); commit;")"
assert_eq "[F4.9] supprimer ET remplacer dans la même transaction : accepté" "OK" "$R"
R="$(sqltry "$DB_F02" "update public.restaurant_fulfillment_schedule_slot set weekday = 5 where restaurant_id='$RID_A' and mode_code='pickup';")"
assert_eq "[F4.9] déplacer le créneau d'un jour à l'autre (reste une offre) : accepté" "OK" "$R"
R="$(sqltry "$DB_F02" "begin; update public.restaurant_fulfillment_schedule set enabled=false where restaurant_id='$RID_A' and mode_code='pickup'; delete from public.restaurant_fulfillment_schedule_slot where restaurant_id='$RID_A' and mode_code='pickup'; commit;")"
assert_eq "[F4.10] désactiver ET vider dans la même transaction : accepté" "OK" "$R"
assert_eq "[F4.10] ... brouillon vidé" "false|0|0|1" "$(scope_state "$DB_F02" "$RID_A")"
R="$(sqltry "$DB_F02" "update public.restaurant_fulfillment_schedule set enabled=true where restaurant_id='$RID_A' and mode_code='pickup';")"
expect_inc "[F4.10] ré-activer : refusé tant que l'offre manque" "offer_missing" "$R"
R="$(sqltry "$DB_F02" "begin; $INS_SLOT update public.restaurant_fulfillment_schedule set enabled=true where restaurant_id='$RID_A' and mode_code='pickup'; commit;")"
assert_eq "[F4.10] ré-activer en rétablissant l'offre dans la même transaction : accepté" "OK" "$R"

# --- Un enfant qui CHANGE DE PORTÉE appauvrit l'ancienne.
R="$(sqltry "$DB_F02" "insert into public.restaurant_fulfillment_schedule (restaurant_id, mode_code, timezone, enabled, date_selection_mode, slot_selection_mode, cutoff_offset_days, schedule_method_version) values ('$RID_A','delivery','Europe/Paris',false,'customer_selectable','fixed_slots',0,'v1.2');")"
assert_eq "[F4.11] seconde portée (brouillon) créée pour le déplacement" "OK" "$R"
R="$(sqltry "$DB_F02" "update public.restaurant_fulfillment_schedule_slot set mode_code='delivery' where restaurant_id='$RID_A' and mode_code='pickup';")"
expect_inc "[F4.11] déplacer le créneau vers une AUTRE portée vide la portée active d'origine : refusé" "offer_missing" "$R"
assert_eq "[F4.11] ... rien n'a bougé" "true|0|1|1" "$(scope_state "$DB_F02" "$RID_A")"
# Cascade : supprimer la portée active n'est jamais une activation incomplète.
R="$(sqltry "$DB_F02" "delete from public.restaurant_fulfillment_schedule where restaurant_id='$RID_A';")"
assert_eq "[F4.12] supprimer une portée active (cascade sur ses enfants) : accepté" "OK" "$R"
assert_eq "[F4.12] ... disparue" "absent|0|0|0" "$(scope_state "$DB_F02" "$RID_A")"

# --- Aucun contournement par un rôle applicatif.
for role in authenticated anon service_role; do
  R="$(sqltry "$DB_F02" "$INS_SCHED" "$role")"
  assert_has "[F4.13] $role : écriture DIRECTE dans la table refusée (aucun droit de table)" "permission denied" "$R"
  R="$(sqltry "$DB_F02" "set session_replication_role = replica;" "$role")"
  assert_has "[F4.13] $role : session_replication_role = replica (désactive les déclencheurs) refusé" "permission denied" "$R"
  R="$(sqltry "$DB_F02" "alter table public.restaurant_fulfillment_schedule disable trigger csdjbo1_f02_activation_invariant;" "$role")"
  assert_has "[F4.13] $role : DISABLE TRIGGER refusé" "must be owner" "$R"
  R="$(sqltry "$DB_F02" "drop trigger csdjbo1_f02_activation_invariant on public.restaurant_fulfillment_schedule;" "$role")"
  assert_has "[F4.13] $role : DROP TRIGGER refusé" "must be owner" "$R"
  R="$(sqltry "$DB_F02" "truncate public.restaurant_fulfillment_schedule cascade;" "$role")"
  assert_has "[F4.13] $role : TRUNCATE refusé (seule limite connue de l'invariant, fermée aux rôles applicatifs)" "permission denied" "$R"
  R="$(sqltry "$DB_F02" "create or replace function public.csdjbo1_f02_enforce() returns trigger language plpgsql as \$f\$ begin return null; end \$f\$;" "$role")"
  assert_has "[F4.13] $role : remplacer la fonction de contrôle refusé" "permission denied" "$R"
done
# Les 4 déclencheurs sont toujours là et actifs après toutes ces tentatives.
assert_eq "[F4.14] les 4 déclencheurs sont intacts après les tentatives de désactivation" "4" "$(sql_on "$DB_F02" "select count(*) from pg_trigger where tgname='csdjbo1_f02_activation_invariant' and tgenabled='O';")"

# ============================================================
# [F5] DIFFÉRENTIEL : la RPC (BO1, étape 11) et l'invariant (état stocké) rendent le MÊME verdict
#      sur toute la grille de configurations -- une seule définition de « complète », deux implémentations.
# ============================================================
log "=== [F5] Différentiel RPC / invariant sur la grille des configurations ==="
diff_sql() { # <mode: rpc|inv>
cat <<SQL
create temp table dres (k text primary key, v text);
do \$d\$
declare
  v_dm text; v_sm text; v_g integer; v_meth text; v_w integer; v_s integer; v_p integer; v_cap integer;
  v_payload jsonb; v_verdict text; v_det text; v_msg text; v_k text;
  v_rid uuid := '$RID_A'; v_mode text := '$1';
begin
  perform set_config('test.uid', '$OWNER_A', true);
  for v_dm in select unnest(public.checkout_date_selection_modes()) loop
   for v_sm in select unnest(public.checkout_slot_selection_modes()) loop
    for v_g in select unnest(array[0,15]) loop
     for v_meth in select unnest(array['v1','v1.2']) loop
      for v_w in 0..1 loop for v_s in 0..1 loop for v_p in 0..1 loop for v_cap in 0..1 loop
        v_k := v_dm||'/'||v_sm||'/g'||v_g||'/'||v_meth||'/w'||v_w||'/s'||v_s||'/p'||v_p||'/c'||v_cap;
        if v_meth = 'v1' and (v_p = 1 or v_cap = 1) then
          insert into dres values (v_k, 'SKIP'); continue;
        end if;
        v_verdict := null; v_det := null;
        begin
          if v_mode = 'rpc' then
            v_payload := jsonb_build_object('modeCode','pickup','fulfillmentRuleId',null,'method',v_meth,'enabled',true,
              'policy', jsonb_build_object('timezone','Europe/Paris','dateSelectionMode',v_dm,'slotSelectionMode',v_sm,
                 'timeGranularityMinutes', case when v_g = 0 then null else v_g end,'leadTimeMinutes',0,'minLeadDays',1,
                 'cutoffTime','16:00','cutoffOffsetDays', case when v_meth = 'v1.2' then 0 else 1 end,'bookingHorizonDays',14),
              'windows', case when v_w = 1 then '[{"weekday":2,"startsAt":"11:00","endsAt":"14:00","displayOrder":0}]'::jsonb else '[]'::jsonb end,
              'slots', case when v_s = 1 then '[{"weekday":2,"slotKey":"midi","startsAt":"11:00","endsAt":"14:00","displayOrder":0}]'::jsonb else '[]'::jsonb end,
              'closures','[]'::jsonb);
            if v_meth = 'v1.2' then
              v_payload := v_payload || jsonb_build_object(
                'preparation', jsonb_build_object('weekdays', case when v_p = 1 then '[2]'::jsonb else '[]'::jsonb end,'closures','[]'::jsonb),
                'holidays', jsonb_build_object('calendarId',null,'preparationOnHolidays','open','availabilityOnHolidays','open'),
                'capacity', jsonb_build_object('enabled', v_cap = 1,'maxOrders', case when v_cap = 1 then 10 else null end));
            end if;
            perform public.save_fulfillment_configuration(v_rid, v_payload);
          else
            insert into public.restaurant_fulfillment_schedule (restaurant_id, mode_code, timezone, enabled, date_selection_mode, slot_selection_mode,
                time_granularity_minutes, cutoff_time, cutoff_offset_days, schedule_method_version, capacity_enabled, capacity_max_orders)
            values (v_rid,'pickup','Europe/Paris',true,v_dm,v_sm, case when v_g = 0 then null else v_g end,'16:00',
                case when v_meth = 'v1.2' then 0 else 1 end, v_meth, v_cap = 1, case when v_cap = 1 then 10 else null end);
            if v_w = 1 then insert into public.restaurant_fulfillment_schedule_window (restaurant_id, mode_code, rule_key, weekday, starts_at, ends_at)
              values (v_rid,'pickup','$NIL_RULE',2,'11:00','14:00'); end if;
            if v_s = 1 then insert into public.restaurant_fulfillment_schedule_slot (restaurant_id, mode_code, rule_key, weekday, slot_key, starts_at, ends_at)
              values (v_rid,'pickup','$NIL_RULE',2,'midi','11:00','14:00'); end if;
            if v_p = 1 then insert into public.restaurant_fulfillment_prep_day (restaurant_id, mode_code, rule_key, weekday)
              values (v_rid,'pickup','$NIL_RULE',2); end if;
            set constraints all immediate;
          end if;
          v_verdict := 'OK';
          raise exception 'ROLLBACK_SENTINEL';
        exception when others then
          get stacked diagnostics v_det = pg_exception_detail;
          v_msg := sqlerrm;
          if v_msg <> 'ROLLBACK_SENTINEL' then
            if v_msg like 'CSDJBO1_INCOMPLETE_CONFIGURATION%' then
              v_verdict := 'INC:' || coalesce(substring(v_det from 'blockers=([a-z_,]+)'), '?');
            else
              v_verdict := 'REJECT';
            end if;
          end if;
        end;
        insert into dres values (v_k, v_verdict);
      end loop; end loop; end loop; end loop;
     end loop;
    end loop;
   end loop;
  end loop;
end \$d\$;
select k || '=' || v from dres order by k;
SQL
}
run_diff() { # <base> <mode> <sortie>
  diff_sql "$2" | psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$1" > "$3" 2>"$TMP_DIR/diff.err" || fatal "[F5] différentiel ($1/$2) : $(head -3 "$TMP_DIR/diff.err" | tr '\n' ' ')"
}
wipe_scope "$DB_NEW" "$RID_A"; wipe_scope "$DB_F02" "$RID_A"
run_diff "$DB_NEW" rpc "$TMP_DIR/diff.rpc.new"
run_diff "$DB_F02" rpc "$TMP_DIR/diff.rpc.f02"
run_diff "$DB_F02" inv "$TMP_DIR/diff.inv.f02"
run_diff "$DB_NEW" inv "$TMP_DIR/diff.inv.new"
N_ALL="$(wc -l < "$TMP_DIR/diff.rpc.new" | tr -d ' ')"
N_OK="$(grep -c '=OK$' "$TMP_DIR/diff.rpc.new" || true)"; N_INC="$(grep -c '=INC:' "$TMP_DIR/diff.rpc.new" || true)"
N_REJ="$(grep -c '=REJECT$' "$TMP_DIR/diff.rpc.new" || true)"; N_SKIP="$(grep -c '=SKIP$' "$TMP_DIR/diff.rpc.new" || true)"
log "grille : $N_ALL configurations — acceptées $N_OK, incomplètes $N_INC, rejetées par validation $N_REJ, hors méthode $N_SKIP"
[ "$N_OK" -ge 40 ] && [ "$N_INC" -ge 60 ] && pass "[F5.1] la grille n'est pas triviale (≥ 40 acceptées, ≥ 60 incomplètes : $N_OK / $N_INC)" || fail "[F5.1] grille trop pauvre ($N_OK acceptées, $N_INC incomplètes)"
cmp -s "$TMP_DIR/diff.rpc.new" "$TMP_DIR/diff.rpc.f02" && pass "[F5.2] la RPC rend le MÊME verdict sur la grille avec et sans l'invariant ($N_ALL configurations)" || { fail "[F5.2] la RPC change de verdict sous l'invariant"; diff "$TMP_DIR/diff.rpc.new" "$TMP_DIR/diff.rpc.f02" | head -5 | while IFS= read -r l; do log "   $l"; done; }
# Pour toute configuration que la RPC juge (OK / INC), l'invariant rend EXACTEMENT le même verdict, bloqueurs compris.
# Les configurations SANS granularité (rfs_granularity_required) ou à capacité incomplète (rfs_capacity_complete,
# rfs_capacity_needs_date) sont aussi incomplètes pour la RPC, mais la contrainte de TABLE les refuse EN PREMIER en
# écriture directe : le blocage est alors porté par la table, pas par l'invariant (défense en profondeur). Elles sont jugées à part en [F5.8].
grep -E '=(OK|INC:)' "$TMP_DIR/diff.rpc.new" | grep -vE 'granularity_missing|capacity_incomplete|capacity_needs_date' > "$TMP_DIR/diff.judged"
grep -E '=INC:.*(granularity_missing|capacity_incomplete|capacity_needs_date)' "$TMP_DIR/diff.rpc.new" > "$TMP_DIR/diff.gran" || true
GRAN_N="$(wc -l < "$TMP_DIR/diff.gran" | tr -d ' ')"
grep -E '=(OK|INC:)' "$TMP_DIR/diff.inv.f02" > "$TMP_DIR/diff.inv.judged" || true
JUD_N="$(wc -l < "$TMP_DIR/diff.judged" | tr -d ' ')"
{ cut -d= -f1 "$TMP_DIR/diff.judged"; } > "$TMP_DIR/diff.judged.keys"
grep -F -f <(sed 's/$/=/' "$TMP_DIR/diff.judged.keys") "$TMP_DIR/diff.inv.f02" > "$TMP_DIR/diff.inv.onjudged"
cmp -s "$TMP_DIR/diff.judged" "$TMP_DIR/diff.inv.onjudged" && pass "[F5.3] DIFFÉRENTIEL : sur les $JUD_N configurations jugées par la RPC, l'invariant rend le même verdict ET les mêmes bloqueurs" || { fail "[F5.3] verdicts divergents RPC / invariant"; diff "$TMP_DIR/diff.judged" "$TMP_DIR/diff.inv.onjudged" | head -8 | while IFS= read -r l; do log "   $l"; done; }
# L'invariant ne refuse JAMAIS ce que la RPC accepte, ne laisse JAMAIS passer ce qu'elle refuse comme incomplet.
assert_eq "[F5.4] aucune configuration acceptée par la RPC n'est refusée par l'invariant" "0" "$(LC_ALL=C join -t= <(LC_ALL=C sort "$TMP_DIR/diff.rpc.new") <(LC_ALL=C sort "$TMP_DIR/diff.inv.f02") | awk -F= '$2=="OK" && $3 ~ /^INC/' | wc -l | tr -d ' ')"
assert_eq "[F5.4] aucune configuration INCOMPLÈTE pour la RPC n'est acceptée par l'invariant" "0" "$(LC_ALL=C join -t= <(LC_ALL=C sort "$TMP_DIR/diff.rpc.new") <(LC_ALL=C sort "$TMP_DIR/diff.inv.f02") | awk -F= '$2 ~ /^INC/ && $3=="OK"' | wc -l | tr -d ' ')"
# ROUGE : sans l'invariant (DB_NEW), la même écriture directe accepte les configurations incomplètes.
INV_NEW_INC="$(grep -c '=INC:' "$TMP_DIR/diff.inv.new" || true)"; INV_F02_INC="$(grep -c '=INC:' "$TMP_DIR/diff.inv.f02" || true)"
assert_eq "[F5.5] ROUGE : sans l'invariant, l'écriture directe n'oppose aucun refus d'incomplétude" "0" "$INV_NEW_INC"
assert_eq "[F5.5] VERT : avec l'invariant, elle en oppose autant que la RPC (hors bloqueurs portés d'abord par les CHECK de table)" "$((N_INC - GRAN_N))" "$INV_F02_INC"
assert_eq "[F5.6] tout ce que les contraintes de TABLE rejettent en écriture directe est aussi rejeté par la RPC (qui écrit les mêmes tables)" "0" "$(LC_ALL=C join -t= <(LC_ALL=C sort "$TMP_DIR/diff.rpc.new") <(LC_ALL=C sort "$TMP_DIR/diff.inv.f02") | awk -F= '$3=="REJECT" && $2!="REJECT" && $2!="SKIP" && $2 !~ /(granularity_missing|capacity_incomplete|capacity_needs_date)/' | wc -l | tr -d ' ')"
[ "$GRAN_N" -ge 10 ] && pass "[F5.8a] la grille contient $GRAN_N configurations dont un bloqueur est déjà porté par un CHECK de table (granularité, capacité)" || fail "[F5.8a] trop peu de configurations sans granularité ($GRAN_N)"
assert_eq "[F5.8] granularité / capacité incomplètes : l'écriture directe est REFUSÉE par les CHECK de table (jamais acceptée), avec et sans l'invariant" "00" "$(LC_ALL=C join -t= <(LC_ALL=C sort "$TMP_DIR/diff.gran") <(LC_ALL=C sort "$TMP_DIR/diff.inv.f02") | awk -F= '$3!="REJECT"' | wc -l | tr -d ' ')$(LC_ALL=C join -t= <(LC_ALL=C sort "$TMP_DIR/diff.gran") <(LC_ALL=C sort "$TMP_DIR/diff.inv.new") | awk -F= '$3!="REJECT"' | wc -l | tr -d ' ')"
assert_eq "[F5.7] la base n'a pas été modifiée par le différentiel (transactions annulées)" "absent|0|0|0" "$(scope_state "$DB_F02" "$RID_A")"

# ============================================================
# [F6] CONCURRENCE RÉELLE (sessions psql distinctes) : le contrôle est au COMMIT, sous le verrou de tenant
# ============================================================
log "=== [F6] Concurrence réelle ==="
DB="$DB_F02"
CCDIR="$TMP_DIR/cc"; mkdir -p "$CCDIR"
adv_state() { # <restaurant> -> « verrous accordés|verrous en attente » sur la clé de tenant (graine 1104)
  sql_on "$DB" "with k as (select hashtextextended('$1',1104) v) select (count(*) filter (where granted))||'|'||(count(*) filter (where not granted)) from pg_locks l, k where l.locktype='advisory' and l.classid::bigint = ((k.v >> 32) & 4294967295) and l.objid::bigint = (k.v & 4294967295) and l.objsubid = 1;"
}
wait_state() { local i=0; while [ "$i" -lt "$3" ]; do [ "$(adv_state "$1")" = "$2" ] && return 0; sleep 0.2; i=$((i+1)); done; return 1; }
bgx() { # <fichier> <SQL> [rôle] : session en arrière-plan (propriétaire des tables par défaut), PID dans BG_LAST
  local opts="-c lc_messages=C"; [ -n "${3:-}" ] && opts="$opts -c role=$3"
  ( PGOPTIONS="$opts" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" >"$1" 2>&1 <<SQL
$2
SQL
  ) &
  BG_LAST=$!
}
bg_err() { grep -m1 'ERROR:' "$1" 2>/dev/null | sed 's/^.*ERROR:  //'; }
mk_active_two() { # portée ACTIVE complète avec DEUX créneaux (jours 2 et 3) et un jour de préparation
  wipe_scope "$DB" "$RID_A"
  sqltry "$DB" "begin; $INS_SCHED $INS_SLOT insert into public.restaurant_fulfillment_schedule_slot (restaurant_id, mode_code, rule_key, weekday, slot_key, starts_at, ends_at) values ('$RID_A','pickup','$NIL_RULE',3,'midi','11:00','14:00'); $INS_PREP commit;" >/dev/null
}

# F6.1 Écriture « de biais » : deux écrivains SANS verrou, chacun valide SEUL (il reste un créneau), ne peuvent
#      pas laisser la portée vide. Sans contrôle au COMMIT sous verrou, les deux passeraient.
mk_active_two
assert_eq "[F6.1] départ : active, 2 créneaux, 1 jour de préparation" "true|0|2|1" "$(scope_state "$DB" "$RID_A")"
bgx "$CCDIR/s1" "begin; delete from public.restaurant_fulfillment_schedule_slot where restaurant_id='$RID_A' and mode_code='pickup' and weekday=2; select pg_sleep(1.6); commit;"; P1=$BG_LAST
sleep 0.5
R2="$(sqltry "$DB" "begin; delete from public.restaurant_fulfillment_schedule_slot where restaurant_id='$RID_A' and mode_code='pickup' and weekday=3; commit;")"
wait "$P1" 2>/dev/null
E1="$(bg_err "$CCDIR/s1")"
assert_eq "[F6.1] l'écrivain rapide (le jour 3) est accepté : il reste, à ses yeux, un créneau" "OK" "$R2"
assert_has "[F6.1] l'écrivain LENT (le jour 2) est refusé au COMMIT, sur l'état validé des autres" "CSDJBO1_INCOMPLETE_CONFIGURATION" "$E1"
assert_eq "[F6.1] la portée reste active ET complète : un seul créneau a disparu, pas les deux" "true|0|1|1" "$(scope_state "$DB" "$RID_A")"

# F6.2 Un écrivain SANS verrou est sérialisé derrière un mutateur historique qui tient le verrou de tenant.
mk_active_two
bgx "$CCDIR/m" "set test.uid = '$OWNER_A'; begin; select public.mutate_merchant_fulfillment_schedule_v12('$RID_A'::uuid,'replace_prep_days','{\"modeCode\":\"pickup\",\"weekdays\":[2,3]}'::jsonb); select pg_sleep(2.2); commit;" authenticated; PM=$BG_LAST
if wait_state "$RID_A" "1|0" 20; then
  pass "[F6.2] le mutateur historique tient le verrou de tenant (graine 1104)"
  bgx "$CCDIR/w" "begin; delete from public.restaurant_fulfillment_schedule_slot where restaurant_id='$RID_A' and mode_code='pickup' and weekday=2; commit;"; PW=$BG_LAST
  if wait_state "$RID_A" "1|1" 20; then pass "[F6.2] l'écrivain direct ATTEND le verrou de tenant au moment du contrôle (1 accordé, 1 en attente)"
  else fail "[F6.2] l'écrivain direct n'attend pas le verrou de tenant (état « $(adv_state "$RID_A") »)"; fi
  wait "$PM" 2>/dev/null; wait "$PW" 2>/dev/null
  assert_eq "[F6.2] les deux transactions ont abouti, dans l'ordre (mutateur puis écrivain direct)" "|" "$(bg_err "$CCDIR/m")|$(bg_err "$CCDIR/w")"
  assert_eq "[F6.2] état final : un créneau en moins, toujours complète" "true|0|1|2" "$(scope_state "$DB" "$RID_A")"
else
  fail "[F6.2] le mutateur historique ne tient pas le verrou (état « $(adv_state "$RID_A") »)"; wait "$PM" 2>/dev/null
fi

# F6.3 Deux mutateurs historiques SIMULTANÉS, chacun retirant une moitié de l'offre : le second voit le premier.
mk_active_two
sqltry "$DB" "delete from public.restaurant_fulfillment_schedule_slot where restaurant_id='$RID_A' and mode_code='pickup' and weekday=3;" >/dev/null
assert_eq "[F6.3] départ : active, 1 créneau" "true|0|1|1" "$(scope_state "$DB" "$RID_A")"
bgx "$CCDIR/a" "set test.uid = '$OWNER_A'; select public.mutate_merchant_fulfillment_schedule('$RID_A'::uuid,'replace_slots','{\"modeCode\":\"pickup\",\"slots\":[]}'::jsonb);" authenticated; PA1=$BG_LAST
bgx "$CCDIR/b" "set test.uid = '$OWNER_A'; select public.mutate_merchant_fulfillment_schedule_v12('$RID_A'::uuid,'replace_prep_days','{\"modeCode\":\"pickup\",\"weekdays\":[]}'::jsonb);" authenticated; PB1=$BG_LAST
wait "$PA1" 2>/dev/null; wait "$PB1" 2>/dev/null
assert_has "[F6.3] vider les créneaux (simultané) : refusé" "CSDJBO1_INCOMPLETE_CONFIGURATION" "$(bg_err "$CCDIR/a")"
assert_has "[F6.3] vider la préparation (simultané) : refusé" "CSDJBO1_INCOMPLETE_CONFIGURATION" "$(bg_err "$CCDIR/b")"
assert_eq "[F6.3] la portée active est intacte" "true|0|1|1" "$(scope_state "$DB" "$RID_A")"

# F6.4 Double soumission SIMULTANÉE du contournement F-02 (×5) : cinq refus, aucune écriture, aucun verrou resté.
wipe_scope "$DB" "$RID_A"; SNAP="$(tenant_digest "$DB" "$RID_A")"
PIDS=""
for n in 1 2 3 4 5; do
  bgx "$CCDIR/d$n" "set test.uid = '$OWNER_A'; select public.mutate_merchant_fulfillment_schedule_v12('$RID_A'::uuid,'save_schedule_v12','$BYP12'::jsonb);" authenticated; PIDS="$PIDS $BG_LAST"
done
for p in $PIDS; do wait "$p" 2>/dev/null; done
REF=0; for n in 1 2 3 4 5; do bg_err "$CCDIR/d$n" | grep -q CSDJBO1_INCOMPLETE_CONFIGURATION && REF=$((REF+1)); done
assert_eq "[F6.4] cinq soumissions simultanées du contournement : cinq refus nommés" "5" "$REF"
assert_eq "[F6.4] ... aucune écriture" "$SNAP" "$(tenant_digest "$DB" "$RID_A")"
assert_eq "[F6.4] ... aucun verrou ne reste" "0|0" "$(adv_state "$RID_A")"

# F6.5 Interblocage possible entre un écrivain direct (verrous de ligne AVANT le verrou de tenant) et un mutateur :
#      PostgreSQL le détecte et annule l'un des deux ; rien ne reste suspendu, rien n'est incohérent.
mk_active_two
bgx "$CCDIR/x1" "begin; update public.restaurant_fulfillment_schedule set updated_at = now() where restaurant_id='$RID_A' and mode_code='pickup'; select pg_sleep(1.2); delete from public.restaurant_fulfillment_schedule_slot where restaurant_id='$RID_A' and mode_code='pickup' and weekday=2; commit;"; PX=$BG_LAST
sleep 0.4
bgx "$CCDIR/x2" "set test.uid = '$OWNER_A'; select public.mutate_merchant_fulfillment_schedule('$RID_A'::uuid,'replace_closures','{\"modeCode\":\"pickup\",\"closures\":[]}'::jsonb);" authenticated; PY=$BG_LAST
for _ in $(seq 1 60); do kill -0 "$PX" 2>/dev/null || kill -0 "$PY" 2>/dev/null || break; sleep 0.25; done
if kill -0 "$PX" 2>/dev/null || kill -0 "$PY" 2>/dev/null; then fail "[F6.5] une session est restée suspendue (>15 s)"; kill "$PX" "$PY" 2>/dev/null; else pass "[F6.5] aucune session n'est restée suspendue"; fi
wait "$PX" 2>/dev/null; wait "$PY" 2>/dev/null
EX="$(bg_err "$CCDIR/x1")$(bg_err "$CCDIR/x2")"
case "$EX" in ""|*"deadlock detected"*) pass "[F6.5] issue : $( [ -z "$EX" ] && echo 'les deux ont abouti' || echo 'interblocage détecté par PostgreSQL, une transaction annulée')" ;; *) fail "[F6.5] issue inattendue : $EX" ;; esac
assert_eq "[F6.5] la portée active reste complète (au moins un créneau et un jour de préparation)" "1" "$(sql_on "$DB" "select (s.enabled and exists(select 1 from public.restaurant_fulfillment_schedule_slot x where x.restaurant_id=s.restaurant_id and x.mode_code=s.mode_code) and exists(select 1 from public.restaurant_fulfillment_prep_day x where x.restaurant_id=s.restaurant_id and x.mode_code=s.mode_code))::int from public.restaurant_fulfillment_schedule s where s.restaurant_id='$RID_A' and s.mode_code='pickup';")"
assert_eq "[F6.5] aucun verrou ne reste" "0|0" "$(adv_state "$RID_A")"
wipe_scope "$DB" "$RID_A"

# ============================================================
# [F7] NON-RÉGRESSION JUMELÉE : mêmes opérations, avec et sans l'invariant, sur des configurations COMPLÈTES
#      -> mêmes résultats, mêmes données, mêmes réponses de la RPC BO1, même résolveur ; le moteur CSDJ-1 / v1.2 /
#      CSDJ-3 n'a pas changé d'un octet (digests de fonctions déjà prouvés en [F1]).
# ============================================================
log "=== [F7] Non-régression jumelée (sans / avec l'invariant) ==="
content_digest() { # <base> <restaurant> : contenu de la planification SANS horodatages
  sql_on "$1" "select md5(
    coalesce((select string_agg((to_jsonb(x) - 'created_at' - 'updated_at')::text, '|' order by (to_jsonb(x) - 'created_at' - 'updated_at')::text) from public.restaurant_fulfillment_schedule x where restaurant_id='$2'),'')||'#'||
    coalesce((select string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text) from public.restaurant_fulfillment_schedule_window x where restaurant_id='$2'),'')||'#'||
    coalesce((select string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text) from public.restaurant_fulfillment_schedule_slot x where restaurant_id='$2'),'')||'#'||
    coalesce((select string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text) from public.restaurant_fulfillment_schedule_closure x where restaurant_id='$2'),'')||'#'||
    coalesce((select string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text) from public.restaurant_fulfillment_prep_day x where restaurant_id='$2'),'')||'#'||
    coalesce((select string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text) from public.restaurant_fulfillment_prep_closure x where restaurant_id='$2'),''));"
}
res_first() { sql_on "$DB" "select coalesce(first_eligible_date::text,'-')||'/'||status from public.resolve_fulfillment_schedule_v12('$RID_A','pickup',null,'$1'::timestamptz,false);"; }
sans_jetons() { pm "$1" "(:'b'::jsonb) - 'updatedAt' - 'revision'"; }
PA="$(mk_alc)"; PV1="$(mk_v1)"
[ -n "$PA" ] && [ -n "$PV1" ] || fatal "[F7] charges de référence illisibles."
twin_run() { # <base> <fichier de sortie>
  local db="$1" out="$2" R
  DB="$db"
  wipe_scope "$db" "$RID_A"; wipe_scope "$db" "$RID_B"
  {
    echo "L1|$(call_legacy "$db" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$DRAFT12")"
    echo "L2|$(call_legacy "$db" "$OWNER_A" v1 "$RID_A" replace_slots "$SLOTS2")"
    echo "L3|$(call_legacy "$db" "$MANAGER_A" v12 "$RID_A" replace_prep_days "$PREP23")"
    echo "L4|$(call_legacy "$db" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$ON12_FIXED")"
    echo "L5|$(call_legacy "$db" "$OWNER_A" v1 "$RID_A" replace_closures "$CLOS1")"
    echo "L6|$(call_legacy "$db" "$OWNER_A" v12 "$RID_A" replace_prep_closures '{"modeCode":"pickup","closures":[{"closedOn":"2026-11-11","label":"x"}]}')"
    echo "L7|$(call_legacy "$db" "$STAFF_A" v12 "$RID_A" save_schedule_v12 "$DRAFT12" | cut -d: -f1)"
    echo "L8|$(call_legacy "$db" "$OWNER_B" v12 "$RID_A" save_schedule_v12 "$DRAFT12" | cut -d: -f1)"
    echo "LD|$(content_digest "$db" "$RID_A")"
    echo "LS|$(scope_state "$db" "$RID_A")"
    echo "LR1|$(res_first '2026-10-19T10:00:00Z')"
    echo "LR2|$(res_first '2026-10-19T13:59:00Z')"
    echo "LR3|$(res_first '2026-10-19T14:01:00Z')"
    echo "LD2|$(call_legacy "$db" "$OWNER_A" v1 "$RID_A" delete_schedule "$DEL")"
    echo "LD3|$(scope_state "$db" "$RID_A")"
    R="$(call_save "$db" authenticated "$OWNER_A" "$RID_A" "$PA")";  echo "S1|$(is_err "$R" && echo "$R" || sans_jetons "$R")"
    echo "G1|$(sans_jetons "$(call_get "$db" authenticated "$OWNER_A" "$RID_A" pickup null)")"
    echo "SD|$(content_digest "$db" "$RID_A")"
    echo "SR1|$(res_first '2026-10-19T10:00:00Z')"
    echo "SR2|$(res_first '2026-10-19T13:59:00Z')"
    echo "SR3|$(res_first '2026-10-19T14:01:00Z')"
    R="$(call_save "$db" authenticated "$OWNER_B" "$RID_B" "$PV1")"; echo "S2|$(is_err "$R" && echo "$R" || sans_jetons "$R")"
    echo "S2D|$(content_digest "$db" "$RID_B")"
    R="$(call_save "$db" authenticated "$OWNER_A" "$RID_A" "$PA")"; echo "S3|$(ecode "$R")"          # double création sans jeton
    R="$(call_save "$db" authenticated "$OWNER_A" "$RID_A" "$(pm "$PA" "jsonb_set(:'b'::jsonb,\$p\${slots}\$p\$,'[]')")")"; echo "S4|$(ecode "$R")"
    R="$(call_save "$db" authenticated "$STAFF_A" "$RID_A" "$PA")"; echo "S5|$(ecode "$R")"
    echo "SZ|$(content_digest "$db" "$RID_A")"
  } > "$out"
}
create_tracked_db "$DB_NEG" -T "$DB_ATOMIC"
create_tracked_db "$DB_RB" -T "$DB_ATOMIC"
apply_path "$SUPABASE_DIR/$F02_SQL" "$DB_RB" || fatal "[F7] le lot F-02 ne s'applique pas sur le jumeau : $(tail -3 "$OUT" | tr '\n' ' ')"
twin_run "$DB_NEG" "$TMP_DIR/twin.pre"
twin_run "$DB_RB" "$TMP_DIR/twin.f02"
TW_N="$(wc -l < "$TMP_DIR/twin.pre" | tr -d ' ')"
if cmp -s "$TMP_DIR/twin.pre" "$TMP_DIR/twin.f02"; then pass "[F7.1] $TW_N relevés identiques (flux historique complet, RPC BO1, lectures, résolveur, refus d'autorisation) avec et sans l'invariant"
else fail "[F7.1] le jumeau avec l'invariant diffère"; diff "$TMP_DIR/twin.pre" "$TMP_DIR/twin.f02" | head -10 | while IFS= read -r l; do log "   $l"; done; fi
for k in L1 L2 L3 L4 L5 L6 S1; do
  v="$(grep "^$k|" "$TMP_DIR/twin.f02" | head -1 | cut -d'|' -f2- | cut -c1-30)"
  case "$k" in S1) [ -n "$v" ] && [ "${v#ERR}" = "$v" ] && pass "[F7.2] $k : la RPC BO1 enregistre l'exemple ALC sous l'invariant" || fail "[F7.2] $k : $v" ;; *) assert_eq "[F7.2] $k : accepté sous l'invariant" "OK" "$v" ;; esac
done
assert_eq "[F7.3] moteur v1.2 / CSDJ-1 / create_order : corps INCHANGÉ (empreinte create_order de l'état hébergé)" "$PRE_CO_MD5" "$(sql_on "$DB_RB" "select md5(prosrc) from pg_proc where proname='create_order' and pronamespace='public'::regnamespace;")"
T4="$(grep -E '^SR2\||^SR3\|' "$TMP_DIR/twin.f02" | cut -d'|' -f2 | paste -sd'|')"
case "$T4" in 2026-10-20/*\|2026-10-21/*) pass "[F7.4] résolveur ALC sous l'invariant : lundi 15:59 Paris -> mardi 2026-10-20, 16:01 Paris -> mercredi 2026-10-21 ($T4)" ;; *) fail "[F7.4] résolveur ALC inattendu : $T4" ;; esac

# ============================================================
# [F8] PRÉ-VOL, DONNÉES HISTORIQUES INCOMPLÈTES, INDÉPENDANCE, RETOUR ARRIÈRE
# ============================================================
log "=== [F8] Pré-vol, données historiques, retour arrière ==="
fresh() { # <nom de base> <modèle> : base jetable recréée
  psql -X -q -d postgres -c "drop database if exists \"$1\";" </dev/null >/dev/null 2>&1
  createdb -T "$2" "$1" 2>"$ERR" || fatal "fresh($1) : $(head -2 "$ERR" | tr '\n' ' ')"
  case " $CREATED_DBS " in *" $1 "*) ;; *) CREATED_DBS="$CREATED_DBS $1" ;; esac
}
apply_out() { apply_path "$1" "$2" && echo APPLIED || echo "REFUSED $(grep -m1 -E 'ERROR:|SCANYM_' "$OUT" | sed 's/^.*ERROR:  //' | cut -c1-260)"; }
fn_n() { sql_on "$1" "select count(*) from pg_proc where proname like 'csdjbo1_f02%';"; }
tg_n() { sql_on "$1" "select count(*) from pg_trigger where tgname='csdjbo1_f02_activation_invariant';"; }

# --- F8.1 Pas deux fois.
R="$(apply_out "$SUPABASE_DIR/$F02_SQL" "$DB_F02")"
assert_has "[F8.1] ré-application sur une base qui a déjà le lot : refusée" "REFUSED" "$R"
assert_has "[F8.1] ... avec le motif nommé" "SCANYM_CSDJBO1_F02_PREFLIGHT" "$R"
assert_eq "[F8.1] ... et sans rien modifier (2 fonctions, 4 déclencheurs)" "2|4" "$(fn_n "$DB_F02")|$(tg_n "$DB_F02")"

# --- F8.2 Prérequis : pas de CSDJ-1, pas de v1.2.
fresh "$DB_F02R" "$DB_BASE"
R="$(apply_out "$SUPABASE_DIR/$F02_SQL" "$DB_F02R")"
assert_has "[F8.2] sans CSDJ-1 : refusé (pré-vol)" "SCANYM_CSDJBO1_F02_PREFLIGHT" "$R"
fresh "$DB_F02R" "$DB_V1"
R="$(apply_out "$SUPABASE_DIR/$F02_SQL" "$DB_F02R")"
assert_has "[F8.2] CSDJ-1 sans v1.2 : refusé (le lot ne réapplique pas la v1.2)" "CSDJ v1.2 n'est pas appliqué" "$R"
assert_eq "[F8.2] ... aucune fonction créée" "0|0" "$(fn_n "$DB_F02R")|$(tg_n "$DB_F02R")"

# --- F8.3 Mauvais exécutant (le propriétaire de l'autorité d'écriture existante est exigé).
fresh "$DB_F02R" "$DB_PRE"
psql -X -q -d postgres -c "create role f02_other superuser;" >/dev/null 2>&1 || true
OUTO="$(PGOPTIONS="-c role=f02_other" psql -X -d "$DB_F02R" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$F02_SQL" 2>&1 | grep -m1 -E 'ERROR:' || true)"
assert_has "[F8.3] exécutant ≠ propriétaire de mutate_merchant_fulfillment_schedule : refusé" "différent du propriétaire" "$OUTO"
assert_eq "[F8.3] ... rien créé" "0|0" "$(fn_n "$DB_F02R")|$(tg_n "$DB_F02R")"
psql -X -q -d postgres -c "drop role if exists f02_other;" >/dev/null 2>&1 || true

# --- F8.4 État partiel : un déclencheur du même nom existe déjà.
fresh "$DB_F02R" "$DB_PRE"
psql -X -d "$DB_F02R" -q -c "create function public.zz_noop() returns trigger language plpgsql as \$f\$ begin return null; end \$f\$; create constraint trigger csdjbo1_f02_activation_invariant after update on public.restaurant_fulfillment_schedule_closure deferrable initially deferred for each row execute function public.zz_noop();" >/dev/null 2>&1 || fatal "[F8.4] amorce"
R="$(apply_out "$SUPABASE_DIR/$F02_SQL" "$DB_F02R")"
assert_has "[F8.4] un déclencheur du lot préexiste : refusé" "SCANYM_CSDJBO1_F02_PREFLIGHT" "$R"

# --- F8.5 Données HISTORIQUES : portées déjà actives et incomplètes (créées AVANT le lot, par le contournement).
fresh "$DB_F02R" "$DB_ATOMIC"
wipe_scope "$DB_F02R" "$RID_A"
R1="$(call_legacy "$DB_F02R" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$BYP12")"
assert_eq "[F8.5] (avant lot) le contournement a créé une portée active vide" "OK|true|0|0|0" "$R1|$(scope_state "$DB_F02R" "$RID_A")"
DIRTY_B="$(tenant_digest "$DB_F02R" "$RID_B")"
DIRTY_A="$(content_digest "$DB_F02R" "$RID_A")"
OUTD="$(apply_out "$SUPABASE_DIR/$F02_SQL" "$DB_F02R")"
assert_eq "[F8.5] le lot s'applique malgré tout (mode par défaut)" "APPLIED" "$OUTD"
assert_has "[F8.5] ... et SIGNALE la portée incomplète (WARNING avec son compte)" "LEGACY_VIOLATIONS=1" "$(cat "$OUT")"
assert_has "[F8.5] ... en la désignant (établissement/mode/clé)" "$RID_A/pickup/$NIL_RULE" "$(cat "$OUT")"
assert_eq "[F8.5] ... sans la corriger : ses données n'ont pas bougé" "$DIRTY_A" "$(content_digest "$DB_F02R" "$RID_A")"
assert_eq "[F8.5] ... ni celles des autres établissements" "$DIRTY_B" "$(tenant_digest "$DB_F02R" "$RID_B")"
assert_eq "[F8.5] elle reste active et vide jusqu'à sa prochaine écriture" "true|0|0|0" "$(scope_state "$DB_F02R" "$RID_A")"
R="$(call_legacy "$DB_F02R" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$BYP12")"
expect_inc "[F8.5] la TOUCHER (même écriture) exige désormais qu'elle soit complète ou désactivée" "offer_missing,preparation_missing" "$R"
R="$(call_legacy "$DB_F02R" "$OWNER_A" v1 "$RID_A" replace_closures "$CLOS1")"
assert_eq "[F8.5] une écriture qui ne touche pas l'offre (fermetures) reste permise" "OK" "$R"
R="$(call_legacy "$DB_F02R" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$DRAFT12")"
assert_eq "[F8.5] la désactiver est permis" "OK" "$R"
R="$(call_legacy "$DB_F02R" "$OWNER_A" v1 "$RID_A" replace_slots "$SLOTS2")"; R="$R|$(call_legacy "$DB_F02R" "$OWNER_A" v12 "$RID_A" replace_prep_days "$PREP23")"; R="$R|$(call_legacy "$DB_F02R" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$ON12_FIXED")"
assert_eq "[F8.5] la compléter puis l'activer est permis" "OK|OK|OK" "$R"
# Exiger une base propre.
fresh "$DB_F02R" "$DB_ATOMIC"; wipe_scope "$DB_F02R" "$RID_A"
call_legacy "$DB_F02R" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$BYP12" >/dev/null
OUTC="$(PGOPTIONS="-c scanym.csdjbo1.f02_require_clean=on" apply_out "$SUPABASE_DIR/$F02_SQL" "$DB_F02R")"
assert_has "[F8.6] f02_require_clean = on avec une portée incomplète : refusé [DIRTY]" "[DIRTY]" "$OUTC"
assert_eq "[F8.6] ... rien créé" "0|0" "$(fn_n "$DB_F02R")|$(tg_n "$DB_F02R")"
fresh "$DB_F02R" "$DB_ATOMIC"
OUTC="$(PGOPTIONS="-c scanym.csdjbo1.f02_require_clean=on" apply_out "$SUPABASE_DIR/$F02_SQL" "$DB_F02R")"
assert_eq "[F8.6] f02_require_clean = on sur une base propre : appliqué" "APPLIED" "$OUTC"

# --- F8.7 INDÉPENDANCE : l'invariant s'applique SANS le lot BO1 (état hébergé = CSDJ-1 + v1.2 seulement).
fresh "$DB_F02B" "$DB_PRE"
OUTB="$(apply_out "$SUPABASE_DIR/$F02_SQL" "$DB_F02B")"
assert_eq "[F8.7] le lot F-02 s'applique sur CSDJ-1 + v1.2 SANS le lot BO1" "APPLIED" "$OUTB"
wipe_scope "$DB_F02B" "$RID_A"
R="$(call_legacy "$DB_F02B" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$BYP12")"
expect_inc "[F8.7] ... et ferme le contournement sans la nouvelle RPC" "offer_missing,preparation_missing" "$R"
assert_eq "[F8.7] aucune fonction du lot BO1 n'a été créée" "0" "$(sql_on "$DB_F02B" "select count(*) from pg_proc where proname in ('save_fulfillment_configuration','get_fulfillment_configuration','csdjbo1_persisted_configuration');")"

# --- F8.8 RETOUR ARRIÈRE.
fresh "$DB_F02R" "$DB_ATOMIC"
R="$(apply_out "$SUPABASE_DIR/$F02_RB" "$DB_F02R")"
assert_has "[F8.8] retour arrière d'un lot non appliqué : refusé [NOT_APPLICABLE]" "[NOT_APPLICABLE]" "$R"
apply_path "$SUPABASE_DIR/$F02_SQL" "$DB_F02R" || fatal "[F8.8] amorce"
psql -X -d "$DB_F02R" -q -c "drop trigger csdjbo1_f02_activation_invariant on public.restaurant_fulfillment_schedule_slot;" >/dev/null 2>&1
R="$(apply_out "$SUPABASE_DIR/$F02_RB" "$DB_F02R")"
assert_has "[F8.8] état PARTIEL (un déclencheur manque) : refusé [NOT_APPLICABLE]" "[NOT_APPLICABLE]" "$R"
assert_eq "[F8.8] ... rien supprimé" "2|3" "$(fn_n "$DB_F02R")|$(tg_n "$DB_F02R")"
fresh "$DB_F02R" "$DB_ATOMIC"; apply_path "$SUPABASE_DIR/$F02_SQL" "$DB_F02R" || fatal "[F8.8] amorce 2"
psql -X -d "$DB_F02R" -q -c "create function public.zz_f02_caller() returns void language plpgsql as \$f\$ begin perform public.csdjbo1_f02_scope_blockers(null,null,null); end \$f\$;" >/dev/null 2>&1
R="$(apply_out "$SUPABASE_DIR/$F02_RB" "$DB_F02R")"
assert_has "[F8.8] une routine cite une fonction du lot : refusé [CALLER]" "[CALLER]" "$R"
psql -X -d "$DB_F02R" -q -c "drop function public.zz_f02_caller(); create function public.zz_f02_dep() returns text[] language sql begin atomic select public.csdjbo1_f02_scope_blockers('$RID_A'::uuid,'pickup','$NIL_RULE'::uuid); end;" >/dev/null 2>&1
R="$(apply_out "$SUPABASE_DIR/$F02_RB" "$DB_F02R")"
assert_has "[F8.8] une fonction SQL dépend (dépendance enregistrée) : refusé [DEPENDENT]" "[DEPENDENT]" "$R"
assert_eq "[F8.8] ... rien supprimé (2 fonctions, 4 déclencheurs)" "2|4" "$(fn_n "$DB_F02R")|$(tg_n "$DB_F02R")"
psql -X -d "$DB_F02R" -q -c "drop function public.zz_f02_dep();" >/dev/null 2>&1
# Retour arrière effectif : sur la base des preuves après sa vie (données modifiées), puis inventaire identique à l'avant-lot.
wipe_scope "$DB_F02" "$RID_A"
call_legacy "$DB_F02" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$DRAFT12" >/dev/null   # une donnée de plus, écrite SOUS l'invariant
RB_A="$(tenant_digest "$DB_F02" "$RID_A")"; RB_B="$(tenant_digest "$DB_F02" "$RID_B")"
R="$(apply_out "$SUPABASE_DIR/$F02_RB" "$DB_F02")"
assert_eq "[F8.9] le retour arrière s'applique" "APPLIED" "$R"
assert_eq "[F8.9] plus aucune fonction ni aucun déclencheur du lot" "0|0" "$(fn_n "$DB_F02")|$(tg_n "$DB_F02")"
assert_eq "[F8.9] les données sont intactes (A)" "$RB_A" "$(tenant_digest "$DB_F02" "$RID_A")"
assert_eq "[F8.9] ... (B)" "$RB_B" "$(tenant_digest "$DB_F02" "$RID_B")"
inventory "$DB_F02" | sort > "$TMP_DIR/inv.f02.rb"
cmp -s "$TMP_DIR/inv.f02.before" "$TMP_DIR/inv.f02.rb" && pass "[F8.9] l'inventaire (fonctions, colonnes, contraintes, politiques, déclencheurs, droits) est IDENTIQUE à l'état d'avant le lot" || { fail "[F8.9] l'inventaire après retour diffère de l'état d'avant le lot"; diff "$TMP_DIR/inv.f02.before" "$TMP_DIR/inv.f02.rb" | head -5 | while IFS= read -r l; do log "   $l"; done; }
wipe_scope "$DB_F02" "$RID_A"
R="$(call_legacy "$DB_F02" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$BYP12")"
assert_eq "[F8.9] après le retour, F-02 est de nouveau OUVERT (c'est l'effet documenté du retour)" "OK" "$R"
wipe_scope "$DB_F02" "$RID_A"
R="$(apply_out "$SUPABASE_DIR/$F02_SQL" "$DB_F02")"
assert_eq "[F8.10] réapplication après retour arrière : possible" "APPLIED" "$R"
R="$(call_legacy "$DB_F02" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$BYP12")"
expect_inc "[F8.10] ... et le contournement est de nouveau refusé" "offer_missing,preparation_missing" "$R"

# --- F8.11 INDÉPENDANCE des retours arrière : celui de BO1 ne touche pas F-02, et réciproquement.
fresh "$DB_F02R" "$DB_ATOMIC"; apply_path "$SUPABASE_DIR/$F02_SQL" "$DB_F02R" || fatal "[F8.11] amorce"
R="$(apply_out "$SUPABASE_DIR/$LOT_ROLLBACK" "$DB_F02R")"
assert_eq "[F8.11] le retour arrière de BO1 s'applique avec F-02 présent" "APPLIED" "$R"
assert_eq "[F8.11] ... BO1 retiré, F-02 intact" "0|2|4" "$(sql_on "$DB_F02R" "select count(*) from pg_proc where proname in ('save_fulfillment_configuration','get_fulfillment_configuration','csdjbo1_persisted_configuration');")|$(fn_n "$DB_F02R")|$(tg_n "$DB_F02R")"
R="$(apply_out "$SUPABASE_DIR/$F02_RB" "$DB_F02R")"
assert_eq "[F8.11] puis le retour arrière de F-02 s'applique" "APPLIED" "$R"

# ============================================================
# [F9] MUTATIONS : chaque garde du lot F-02 est NÉCESSAIRE -- un détecteur échoue sans elle
# ============================================================
log "=== [F9] Mutations de l'invariant ==="
pyrep() { # <src> <dst> <ancien> <nouveau> [occurrences attendues=1] : remplacement exact, refuse un motif introuvable
  python3 -I - "$1" "$2" "$3" "$4" "${5:-1}" <<'PY'
import sys
src,dst,old,new,n=sys.argv[1:6]
s=open(src,encoding='utf-8').read()
if s.count(old)!=int(n):
    sys.stderr.write("PATTERN-COUNT %d != %s : %r\n"%(s.count(old),n,old[:80])); sys.exit(3)
open(dst,'w',encoding='utf-8').write(s.replace(old,new))
PY
}
INFO1="{\"modeCode\":\"pickup\",\"timezone\":\"Europe/Paris\",\"cutoffOffsetDays\":1,\"enabled\":true,\"dateSelectionMode\":\"informational_only\",\"slotSelectionMode\":\"none\"}"
OFF1_NONE="{$P12_BASE,\"cutoffOffsetDays\":1,\"enabled\":false,\"slotSelectionMode\":\"none\"}"
# Batterie de détecteurs : rend la liste des sondes qui ÉCHOUENT (vide = tout tient).
f02_battery() {
  local db="$1" saved="$DB" bad="" R P1 PM PW E1
  DB="$db"
  # -- le contournement F-02 et ses variantes
  wipe_scope "$db" "$RID_A"
  R="$(call_legacy "$db" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$BYP12")"
  { [ "$(ecode "$R")" = CSDJBO1_INCOMPLETE_CONFIGURATION ] && [ "$(blk_of "$R")" = "offer_missing,preparation_missing" ]; } || bad="$bad bypass"
  [ "$(scope_state "$db" "$RID_A")" = "absent|0|0|0" ] || bad="$bad atomic"
  [ "$(sqlstate_legacy "$db" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$BYP12")" = "23514" ] || bad="$bad sqlstate"
  R="$(call_legacy "$db" "$MANAGER_A" v1 "$RID_A" save_schedule "$BYP1")"
  { [ "$(ecode "$R")" = CSDJBO1_INCOMPLETE_CONFIGURATION ] && [ "$(blk_of "$R")" = "offer_missing" ]; } || bad="$bad bypass_v1"
  R="$(call_legacy "$db" "$OWNER_A" v1 "$RID_A" save_schedule "$ON1_NONE")"
  { [ "$(ecode "$R")" = CSDJBO1_INCOMPLETE_CONFIGURATION ] && [ "$(blk_of "$R")" = "offer_missing" ]; } || bad="$bad nowindow"
  # -- ce qui doit PASSER : brouillon, politique informative, flux complet
  R="$(call_legacy "$db" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$DRAFT12")"; [ "$R" = OK ] || bad="$bad draft"
  wipe_scope "$db" "$RID_A"
  R="$(call_legacy "$db" "$OWNER_A" v1 "$RID_A" save_schedule "$INFO1")"; [ "$R" = OK ] || bad="$bad informational"
  wipe_scope "$db" "$RID_A"
  R="$(call_legacy "$db" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$DRAFT12")$(call_legacy "$db" "$OWNER_A" v1 "$RID_A" replace_slots "$SLOTS2")$(call_legacy "$db" "$OWNER_A" v12 "$RID_A" replace_prep_days "$PREP23")$(call_legacy "$db" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$ON12_FIXED")"
  { [ "$R" = OKOKOKOK ] && [ "$(scope_state "$db" "$RID_A")" = "true|0|2|2" ]; } || bad="$bad legit"
  # -- ce qui doit être REFUSÉ sur une portée active
  R="$(call_legacy "$db" "$OWNER_A" v1 "$RID_A" replace_slots "$SLOTS0")";   { [ "$(ecode "$R")" = CSDJBO1_INCOMPLETE_CONFIGURATION ] && [ "$(blk_of "$R")" = "offer_missing" ]; } || bad="$bad emptyslots"
  R="$(call_legacy "$db" "$OWNER_A" v12 "$RID_A" replace_prep_days "$PREP0")"; { [ "$(ecode "$R")" = CSDJBO1_INCOMPLETE_CONFIGURATION ] && [ "$(blk_of "$R")" = "preparation_missing" ]; } || bad="$bad emptyprep"
  [ "$(scope_state "$db" "$RID_A")" = "true|0|2|2" ] || bad="$bad keep"
  # -- ce qui doit PASSER sur une portée active : désactiver, supprimer
  R="$(call_legacy "$db" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$DRAFT12")"; [ "$R" = OK ] || bad="$bad disable"
  call_legacy "$db" "$OWNER_A" v12 "$RID_A" save_schedule_v12 "$ON12_FIXED" >/dev/null
  R="$(call_legacy "$db" "$OWNER_A" v1 "$RID_A" delete_schedule "$DEL")"; { [ "$R" = OK ] && [ "$(scope_state "$db" "$RID_A")" = "absent|0|0|0" ]; } || bad="$bad delete"
  # -- méthode v1 : fenêtres
  R="$(call_legacy "$db" "$OWNER_A" v1 "$RID_A" save_schedule "$OFF1_NONE")$(call_legacy "$db" "$OWNER_A" v1 "$RID_A" replace_windows "$WIN1")$(call_legacy "$db" "$OWNER_A" v1 "$RID_A" save_schedule "$ON1_NONE")"
  [ "$R" = OKOKOK ] || bad="$bad legit_v1"
  R="$(call_legacy "$db" "$OWNER_A" v1 "$RID_A" replace_windows "$WIN0")"; { [ "$(ecode "$R")" = CSDJBO1_INCOMPLETE_CONFIGURATION ] && [ "$(blk_of "$R")" = "offer_missing" ]; } || bad="$bad emptywin"
  # -- SQL direct : le contrôle est DIFFÉRÉ (ordre libre dans la transaction)
  wipe_scope "$db" "$RID_A"
  R="$(sqltry "$db" "begin; $INS_SCHED $INS_SLOT $INS_PREP commit;")"; [ "$R" = OK ] || bad="$bad deferred"
  # -- un enfant qui change de portée vide l'ancienne
  sqltry "$db" "insert into public.restaurant_fulfillment_schedule (restaurant_id, mode_code, timezone, enabled, date_selection_mode, slot_selection_mode, cutoff_offset_days, schedule_method_version) values ('$RID_A','delivery','Europe/Paris',false,'customer_selectable','fixed_slots',0,'v1.2');" >/dev/null
  R="$(sqltry "$db" "update public.restaurant_fulfillment_schedule_slot set mode_code='delivery' where restaurant_id='$RID_A' and mode_code='pickup';")"
  [ "$(ecode "$R")" = CSDJBO1_INCOMPLETE_CONFIGURATION ] || bad="$bad rowmove"
  # -- concurrence : écriture de biais, puis sérialisation derrière le verrou de tenant
  mk_active_two
  bgx "$CCDIR/mb1" "begin; delete from public.restaurant_fulfillment_schedule_slot where restaurant_id='$RID_A' and mode_code='pickup' and weekday=2; select pg_sleep(1.4); commit;"; P1=$BG_LAST
  sleep 0.4
  sqltry "$db" "begin; delete from public.restaurant_fulfillment_schedule_slot where restaurant_id='$RID_A' and mode_code='pickup' and weekday=3; commit;" >/dev/null
  wait "$P1" 2>/dev/null
  [ "$(scope_state "$db" "$RID_A")" = "true|0|1|1" ] || bad="$bad skew"
  mk_active_two
  bgx "$CCDIR/mm" "set test.uid = '$OWNER_A'; begin; select public.mutate_merchant_fulfillment_schedule_v12('$RID_A'::uuid,'replace_prep_days','{\"modeCode\":\"pickup\",\"weekdays\":[2,3]}'::jsonb); select pg_sleep(1.8); commit;" authenticated; PM=$BG_LAST
  if wait_state "$RID_A" "1|0" 20; then
    bgx "$CCDIR/mw" "begin; delete from public.restaurant_fulfillment_schedule_slot where restaurant_id='$RID_A' and mode_code='pickup' and weekday=2; commit;"; PW=$BG_LAST
    wait_state "$RID_A" "1|1" 15 || bad="$bad lockwait"
    wait "$PW" 2>/dev/null
  else
    bad="$bad lockwait"
  fi
  wait "$PM" 2>/dev/null
  DB="$saved"
  echo "${bad# }"
}
mut_db() { # <fichier SQL du lot> -> 0 si appliqué
  psql -X -q -d postgres -c "drop database if exists \"$DB_MUT\";" </dev/null >/dev/null 2>&1
  createdb -T "$DB_ATOMIC" "$DB_MUT" 2>"$ERR" || fatal "mut_db : $(head -2 "$ERR" | tr '\n' ' ')"
  case " $CREATED_DBS " in *" $DB_MUT "*) ;; *) CREATED_DBS="$CREATED_DBS $DB_MUT" ;; esac
  apply_path "$1" "$DB_MUT"
}
LOTF="$SUPABASE_DIR/$F02_SQL"
mut_db "$LOTF" || fatal "[F9] le lot non modifié ne s'applique pas sur la base de mutation."
CTRL="$(f02_battery "$DB_MUT")"
assert_eq "[F9] CONTRÔLE : le lot non modifié passe toutes les sondes de la batterie" "" "$CTRL"
mutant() { # <nom> <ancien> <nouveau> <sondes attendues séparées par des espaces | APPLY> [occurrences]
  local name="$1" old="$2" new="$3" want="$4" n="${5:-1}" f="$TMP_DIR/mutf_$(printf '%s' "$1" | tr -c 'A-Za-z0-9' _ | cut -c1-40).sql" got w ok
  if ! pyrep "$LOTF" "$f" "$old" "$new" "$n" 2>"$TMP_DIR/pyrep.err"; then fail "[F9] mutant « $name » : motif introuvable ($(head -1 "$TMP_DIR/pyrep.err"))"; return; fi
  if [ "$want" = "APPLY" ]; then
    if mut_db "$f"; then fail "[F9] mutant « $name » NON DÉTECTÉ : le post-vol aurait dû refuser son application"
    else pass "[F9] mutant « $name » DÉTECTÉ : le lot muté est REFUSÉ à l'application (post-vol)"; fi
    return
  fi
  if ! mut_db "$f"; then fail "[F9] mutant « $name » : ne s'applique pas ($(grep -m1 -E 'ERROR:' "$OUT" | cut -c1-200))"; return; fi
  got="$(f02_battery "$DB_MUT")"
  ok=1; for w in $want; do case " $got " in *" $w "*) ;; *) ok=0 ;; esac; done
  if [ "$ok" = 1 ]; then pass "[F9] mutant « $name » DÉTECTÉ par la sonde « $want » (sondes en échec : $got)"
  else fail "[F9] mutant « $name » NON DÉTECTÉ : attendu « $want », sondes en échec : « ${got:-aucune} »"; fi
}
mutant "offre : contrôle des créneaux retiré" "if s.slot_selection_mode = 'fixed_slots' then
      if not exists (select 1" "if s.slot_selection_mode = 'fixed_slots' then
      if false and not exists (select 1" "bypass emptyslots"
mutant "offre : contrôle des fenêtres retiré" "elsif not exists (select 1 from public.restaurant_fulfillment_schedule_window x" "elsif false and not exists (select 1 from public.restaurant_fulfillment_schedule_window x" "nowindow emptywin"
mutant "préparation : contrôle retiré" "if s.schedule_method_version = 'v1.2'
     and not exists" "if false and s.schedule_method_version = 'v1.2'
     and not exists" "bypass emptyprep"
mutant "préparation exigée aussi en v1 (sur-blocage)" "if s.schedule_method_version = 'v1.2'
     and not exists" "if true
     and not exists" "APPLY"
mutant "politique informative non exemptée (sur-blocage)" "if s.date_selection_mode <> 'informational_only' then
    if s.slot_selection_mode = 'fixed_slots' then" "if true then
    if s.slot_selection_mode = 'fixed_slots' then" "informational"
mutant "brouillons contrôlés comme des portées actives (sur-blocage)" "if not found or not v_enabled then" "if not found then" "draft"
mutant "retrait d'une ligne enfant non contrôlé (DELETE/UPDATE : ancienne portée)" "if tg_op in ('UPDATE', 'DELETE') then" "if false then" "emptyslots emptyprep emptywin"
mutant "changement de portée d'un enfant : ancienne portée non contrôlée" "or old.mode_code is distinct from new.mode_code" "or false" "rowmove"
mutant "verrou de tenant retiré" "perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_rid[i]::text, 1104));" "perform 1;" "lockwait"
mutant "verrou de tenant : autre graine" "perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_rid[i]::text, 1104));" "perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_rid[i]::text, 1105));" "lockwait"
mutant "SQLSTATE du refus changé" "errcode = '23514',
              detail" "errcode = '22023',
              detail" "sqlstate"
mutant "déclencheur sur la planification retiré" "create constraint trigger csdjbo1_f02_activation_invariant
  after insert or update on public.restaurant_fulfillment_schedule
  deferrable initially deferred
  for each row execute function public.csdjbo1_f02_enforce();" "" APPLY
mutant "déclencheur sur les fenêtres retiré" "create constraint trigger csdjbo1_f02_activation_invariant
  after update or delete on public.restaurant_fulfillment_schedule_window
  deferrable initially deferred
  for each row execute function public.csdjbo1_f02_enforce();" "" APPLY
mutant "déclencheur sur les créneaux retiré" "create constraint trigger csdjbo1_f02_activation_invariant
  after update or delete on public.restaurant_fulfillment_schedule_slot
  deferrable initially deferred
  for each row execute function public.csdjbo1_f02_enforce();" "" APPLY
mutant "déclencheur sur les jours de préparation retiré" "create constraint trigger csdjbo1_f02_activation_invariant
  after update or delete on public.restaurant_fulfillment_prep_day
  deferrable initially deferred
  for each row execute function public.csdjbo1_f02_enforce();" "" APPLY
mutant "déclencheurs différés remplacés par des déclencheurs immédiats (post-vol laissé en l'état)" "deferrable initially deferred
  for each row" "deferrable initially immediate
  for each row" APPLY 4
mutant "fonction de contrôle sans SECURITY DEFINER" "language plpgsql
volatile
security definer" "language plpgsql
volatile" APPLY
mutant "droits d'exécution du contrôle laissés ouverts" "revoke all on function public.csdjbo1_f02_enforce() from public, anon, authenticated, service_role;" "-- (retiré)" APPLY
mutant "le lot écrit une donnée" "revoke all on function public.csdjbo1_f02_scope_blockers(uuid,text,uuid) from public, anon, authenticated, service_role;" "revoke all on function public.csdjbo1_f02_scope_blockers(uuid,text,uuid) from public, anon, authenticated, service_role;
update public.restaurant_fulfillment_schedule set updated_at = pg_catalog.now();" APPLY
# Mutant composé : déclencheurs IMMÉDIATS ET post-vol assoupli -> seules les SONDES peuvent encore le voir.
if pyrep "$LOTF" "$TMP_DIR/mutf_imm1.sql" "deferrable initially deferred
  for each row" "for each row" 4 2>"$TMP_DIR/pyrep.err" \
   && pyrep "$TMP_DIR/mutf_imm1.sql" "$TMP_DIR/mutf_imm.sql" " and t.tgdeferrable and t.tginitdeferred" "" 1 2>>"$TMP_DIR/pyrep.err"; then
  if mut_db "$TMP_DIR/mutf_imm.sql"; then
    got="$(f02_battery "$DB_MUT")"
    case " $got " in *" deferred "*" skew "*|*" skew "*" deferred "*) pass "[F9] mutant « déclencheurs IMMÉDIATS, post-vol assoupli » DÉTECTÉ par les sondes « deferred skew » (sondes en échec : $got)" ;; *) fail "[F9] mutant « déclencheurs IMMÉDIATS » NON DÉTECTÉ : sondes en échec « ${got:-aucune} »" ;; esac
  else fail "[F9] mutant composé : ne s'applique pas ($(grep -m1 -E 'ERROR:' "$OUT" | cut -c1-200))"; fi
else fail "[F9] mutant composé : motif introuvable ($(head -1 "$TMP_DIR/pyrep.err"))"; fi

# ============================================================
# [F10] DOCUMENT et posture du dépôt : le document F-02 dit ce que le lot fait (et ce qu'il ne fait pas)
# ============================================================
log "=== [F10] Document F-02 ==="
DOCF="$SUPABASE_DIR/../docs/scheduling/csdj-bo1-f02-activation-invariant.md"
if [ -f "$DOCF" ]; then
  pass "[F10] le document de remédiation existe"
  for needle in "F-02" "csdjbo1_f02_activation_invariant" "CSDJBO1_INCOMPLETE_CONFIGURATION" "delete_schedule" "TRUNCATE" "f02_require_clean" "CSDJ_BO1_WRITE_CONTRACT.available" "Retour arrière" "Limites"; do
    grep -qF -- "$needle" "$DOCF" && pass "[F10] le document mentionne « $needle »" || fail "[F10] le document ne mentionne pas « $needle »"
  done
else
  fail "[F10] docs/scheduling/csdj-bo1-f02-activation-invariant.md absent"
fi
# Le lot ne touche aucun objet audité : aucun CREATE/ALTER/DROP/REPLACE sur autre chose que ses propres objets.
CODE_F02="$(grep -v '^[[:space:]]*--' "$SUPABASE_DIR/$F02_SQL")"
assert_eq "[F10] le lot ne crée ni ne remplace que ses 2 fonctions et ses 4 déclencheurs" "6" "$(printf '%s\n' "$CODE_F02" | grep -Ec '^create (or replace )?(function|constraint trigger) ')"
assert_eq "[F10] le lot ne contient aucun ALTER, DROP, DELETE, TRUNCATE, GRANT" "0" "$(printf '%s\n' "$CODE_F02" | grep -Eic '^[[:space:]]*(alter |drop |delete |truncate |grant )')"

# ============================================================
# Nettoyage final et bilan
# ============================================================
psql -X -q -d postgres -c "drop database if exists \"$DB_NEG\";" </dev/null >/dev/null 2>&1
log "=== BILAN : $PASS_COUNT preuve(s) produite(s), $FAIL_COUNT échec(s) ==="
if [ "$FAIL_COUNT" -ne 0 ]; then
  log "--- échecs ---"; cat "$FAIL_LOG" | while IFS= read -r l; do log "FAIL> $l"; done
  exit 1
fi
exit 0
