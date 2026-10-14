#!/usr/bin/env bash
# ============================================================
# Scanym — CSDJ-BO-1 — épreuves PostgreSQL de save_fulfillment_configuration (v1)
# Fichier  : supabase/tests/csdj-bo1-save-configuration-check.sh
# Mandat   : issue #148 [BOULEZ]. Aucun SQL hébergé, aucun déploiement.
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
NEG_ROLES_CREATED=0                       # rôles jetables de [17] créés (nettoyage)
NEG_MEMBERSHIP=0                          # adhésion de rôle de test posée (nettoyage)

# Et si malgré tout l'un de ces noms existe déjà, le harnais REFUSE :
# il ne peut pas prouver qu'il en est le propriétaire, donc il n'y
# touche pas. Jamais un `drop database` sur une base qu'il n'a pas créée.
for d in "$DB_BASE" "$DB_V1" "$DB_PRE" "$DB_NEW" "$DB_ATOMIC" "$DB_RB" "$DB_NEG" "$DB_MUT"; do
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
         "$V1_SQL" "$LOT_SQL" "$LOT_ROLLBACK"; do
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
# [2] Pré-vol, atomicité et post-vol de la MIGRATION
# ============================================================
log "=== [2] Migration : pré-vol, atomicité, post-vol ==="
neg_db() { # recrée DB_NEG depuis le modèle $1 (nom propre à cette exécution, jamais une base préexistante)
  psql -X -q -d postgres -c "drop database if exists \"$DB_NEG\";" </dev/null >/dev/null 2>&1
  createdb -T "$1" "$DB_NEG" 2>"$ERR" || fatal "neg_db($1) : $(head -2 "$ERR" | tr '\n' ' ')"
  case " $CREATED_DBS " in *" $DB_NEG "*) ;; *) CREATED_DBS="$CREATED_DBS $DB_NEG" ;; esac
}
lot_inv_equal() { # $1 base : l'inventaire est identique à la référence (aucune fonction du lot, rien d'autre)
  inventory "$1" | sort > "$TMP_DIR/inv.cmp"; diff -q "$TMP_DIR/inv.pre" "$TMP_DIR/inv.cmp" >/dev/null
}
lot_fn_n() { sql_on "$1" "select count(*) from pg_proc where proname in ('save_fulfillment_configuration','get_fulfillment_configuration','csdjbo1_persisted_configuration');"; }
mig_refused() { # <étiquette> <base> <fichier> <fragment attendu> [exécutant] [fonctions attendues après le refus]
  local label="$1" db="$2" file="$3" frag="$4" who="${5:-}" left="${6:-0}" out
  if [ -n "$who" ]; then out="$(psql -X -U "$who" -d "$db" -v ON_ERROR_STOP=1 -f "$file" 2>&1)"; else out="$(psql -X -d "$db" -v ON_ERROR_STOP=1 -f "$file" 2>&1)"; fi
  if has "$out" "$frag"; then pass "[2] $label : refus nommé « $frag »"; else fail "[2] $label : attendu « $frag », obtenu : $(printf '%s' "$out" | grep -m1 ERROR | cut -c1-200)"; fi
  assert_eq "[2] $label : nombre de fonctions du lot APRÈS le refus (aucune création partielle)" "$left" "$(lot_fn_n "$db")"
}
# P-a : sans CSDJ-1
neg_db "$DB_BASE"; mig_refused "sans CSDJ-1" "$DB_NEG" "$SUPABASE_DIR/$LOT_SQL" "CSDJ-1 n'est pas appliqué"
# P-b : CSDJ-1 mais pas la v1.2
neg_db "$DB_V1";   mig_refused "sans CSDJ v1.2" "$DB_NEG" "$SUPABASE_DIR/$LOT_SQL" "CSDJ v1.2 n'est pas appliquée"
# P-c : double application (le lot existe déjà), rien ne change
neg_db "$DB_NEW";  mig_refused "double application" "$DB_NEG" "$SUPABASE_DIR/$LOT_SQL" "ce fichier n'est pas ré-exécutable" "" 3
# P-d : une contrainte d'autorité manque
neg_db "$DB_PRE"; psql -X -q -d "$DB_NEG" -c "alter table public.restaurant_fulfillment_schedule drop constraint rfs_policy_coherent;" >/dev/null
mig_refused "contrainte rfs_policy_coherent absente" "$DB_NEG" "$SUPABASE_DIR/$LOT_SQL" "contrainte rfs_policy_coherent absente"
# P-e : une fonction d'autorisation manque
neg_db "$DB_PRE"; psql -X -q -d "$DB_NEG" -c "alter function public.is_member_of(uuid) rename to is_member_of_gone;" >/dev/null
mig_refused "dépendance d'autorisation absente" "$DB_NEG" "$SUPABASE_DIR/$LOT_SQL" "dépendance d'autorisation ou de catalogue est absente"
# P-f : un exécutant qui n'est PAS le propriétaire de l'autorité d'écriture existante
if true; then
  NEG_SU="csdjbo1_negsu_${RUN_TAG}"
  csdj1_identity_mutate "create role $NEG_SU superuser login;" >/dev/null 2>&1 && NEG_ROLES_CREATED=1
  if [ "$NEG_ROLES_CREATED" = "1" ]; then
    neg_db "$DB_PRE"
    mig_refused "exécutant ≠ propriétaire de l'autorité d'écriture" "$DB_NEG" "$SUPABASE_DIR/$LOT_SQL" "différent du propriétaire" "$NEG_SU"
    csdj1_identity_mutate "drop role if exists $NEG_SU;" >/dev/null 2>&1 && NEG_ROLES_CREATED=0
  else
    fail "[2] rôle de test non créé : le cas « exécutant ≠ propriétaire » n'a pas pu être prouvé"
  fi
fi
# A : une instruction en échec en toute fin de fichier ne laisse RIEN (atomicité de la migration)
neg_db "$DB_PRE"
python3 -I - "$SUPABASE_DIR/$LOT_SQL" "$TMP_DIR/mig_fail_end.sql" <<'PY'
import sys
s=open(sys.argv[1],encoding='utf-8').read()
i=s.rindex('\ncommit;')
open(sys.argv[2],'w',encoding='utf-8').write(s[:i]+'\nselect 1/0;'+s[i:])
PY
mig_refused "instruction en échec juste avant le COMMIT" "$DB_NEG" "$TMP_DIR/mig_fail_end.sql" "ERROR"
if lot_inv_equal "$DB_NEG"; then pass "[2] après l'échec en fin de fichier, l'inventaire est IDENTIQUE à l'état hébergé (rien ne subsiste, aucune surface touchée)"; else fail "[2] l'échec en fin de fichier a laissé une trace"; fi
# Z : un post-vol en échec ANNULE tout (ici : le lot est livré avec un droit de trop)
neg_db "$DB_PRE"
python3 -I - "$SUPABASE_DIR/$LOT_SQL" "$TMP_DIR/mig_anon.sql" <<'PY'
import sys
s=open(sys.argv[1],encoding='utf-8').read()
old="grant execute on function public.save_fulfillment_configuration(uuid,jsonb) to authenticated;"
assert s.count(old)==1
open(sys.argv[2],'w',encoding='utf-8').write(s.replace(old,old+"\ngrant execute on function public.save_fulfillment_configuration(uuid,jsonb) to anon;"))
PY
mig_refused "post-vol : droit EXECUTE accordé à anon" "$DB_NEG" "$TMP_DIR/mig_anon.sql" "bénéficiaires"
if lot_inv_equal "$DB_NEG"; then pass "[2] post-vol en échec : rien ne subsiste"; else fail "[2] post-vol en échec : une trace subsiste"; fi
# Z' : le post-vol DÉTECTE une surface existante modifiée (ici : une fonction existante redéfinie par le lot)
neg_db "$DB_PRE"
python3 -I - "$SUPABASE_DIR/$LOT_SQL" "$TMP_DIR/mig_touch.sql" <<'PY'
import sys
s=open(sys.argv[1],encoding='utf-8').read()
old="-- ============================================================\n-- §Z  POST-VOL"
assert s.count(old)==1
touch="comment on function public.has_role_in(uuid,text[]) is 'x';\ncreate or replace function public.is_scanym_operator() returns boolean language sql stable security definer set search_path = '' as $$ select true $$;\n"
open(sys.argv[2],'w',encoding='utf-8').write(s.replace(old,touch+old))
PY
mig_refused "post-vol : une fonction EXISTANTE redéfinie" "$DB_NEG" "$TMP_DIR/mig_touch.sql" "une fonction EXISTANTE a changé"
# Z'' : le post-vol DÉTECTE une ligne de configuration insérée
neg_db "$DB_PRE"
python3 -I - "$SUPABASE_DIR/$LOT_SQL" "$TMP_DIR/mig_row.sql" "$RID_B" <<'PY'
import sys
s=open(sys.argv[1],encoding='utf-8').read()
old="-- ============================================================\n-- §Z  POST-VOL"
assert s.count(old)==1
ins="insert into public.restaurant_fulfillment_schedule (restaurant_id, mode_code, timezone) values ('%s','delivery','Europe/Paris');\n"%sys.argv[3]
open(sys.argv[2],'w',encoding='utf-8').write(s.replace(old,ins+old))
PY
mig_refused "post-vol : une ligne de configuration insérée" "$DB_NEG" "$TMP_DIR/mig_row.sql" "AUCUNE ligne de configuration"

# ============================================================
# [3] PÉRIMÈTRE EXACT : trois fonctions ajoutées, rien d'autre ne bouge
# ============================================================
log "=== [3] Périmètre exact des changements ==="
inventory "$DB_NEW" | sort > "$TMP_DIR/inv.new"
diff "$TMP_DIR/inv.pre" "$TMP_DIR/inv.new" > "$TMP_DIR/inv.diff" || true
ADDED="$(grep -c '^> ' "$TMP_DIR/inv.diff" || true)"
REMOVED_OR_CHANGED="$(grep -c '^< ' "$TMP_DIR/inv.diff" || true)"
assert_eq "[3] lignes ajoutées à l'inventaire (3 fonctions)" "3" "$ADDED"
assert_eq "[3] lignes retirées ou modifiées dans l'inventaire (aucune)" "0" "$REMOVED_OR_CHANGED"
assert_eq "[3] toutes les lignes ajoutées sont des fonctions du lot" "3" "$(grep '^> F|' "$TMP_DIR/inv.diff" | grep -cE 'save_fulfillment_configuration|get_fulfillment_configuration|csdjbo1_persisted_configuration')"
assert_eq "[3] colonnes, contraintes, politiques, déclencheurs, droits de table : INCHANGÉS" "0" "$(grep -c '^[<>] [CKPTR]|' "$TMP_DIR/inv.diff" || true)"
assert_eq "[3] create_order inchangé (corps md5)" "$PRE_CO_MD5" "$(sql_on "$DB_NEW" "select md5(prosrc) from pg_proc where proname='create_order' and pronamespace='public'::regnamespace;")"
for f in validate_fulfillment_selection reserve_fulfillment_capacity release_fulfillment_capacity resolve_fulfillment_schedule resolve_fulfillment_schedule_v12 \
         mutate_merchant_fulfillment_schedule mutate_merchant_fulfillment_schedule_v12 get_merchant_fulfillment_schedules get_merchant_fulfillment_schedules_v12 \
         get_checkout_fulfillment_schedule update_order_status; do
  assert_eq "[3] $f : corps, ACL, propriétaire et SECURITY INCHANGÉS" "$(fn_code_fingerprint "$f" "$DB_PRE")" "$(fn_code_fingerprint "$f" "$DB_NEW")"
done
assert_eq "[3] données historiques de l'établissement A : INCHANGÉES (empreinte)" "$PRE_SEED_A" "$(tenant_digest "$DB_NEW" "$RID_A")"
assert_eq "[3] données historiques de l'établissement B : INCHANGÉES (empreinte)" "$PRE_SEED_B" "$(tenant_digest "$DB_NEW" "$RID_B")"

# ============================================================
# [4] POSTURE DE SÉCURITÉ des trois fonctions
# ============================================================
log "=== [4] Posture de sécurité ==="
SF="public.save_fulfillment_configuration(uuid,jsonb)"; GF="public.get_fulfillment_configuration(uuid,text,uuid)"; BF="public.csdjbo1_persisted_configuration(uuid,text,uuid)"
for fn in "$SF" "$GF" "$BF"; do
  assert_eq "[4] $fn : SECURITY DEFINER" "true" "$(sql_on "$DB" "select prosecdef::text from pg_proc where oid='$fn'::regprocedure;")"
  assert_eq "[4] $fn : search_path vide (proconfig exact)" "true" "$(sql_on "$DB" "select (proconfig = array['search_path=\"\"'])::text from pg_proc where oid='$fn'::regprocedure;")"
  assert_eq "[4] $fn : propriétaire = celui de l'autorité d'écriture existante" "$(sql_on "$DB" "select pg_get_userbyid(proowner) from pg_proc where proname='mutate_merchant_fulfillment_schedule';")" "$(sql_on "$DB" "select pg_get_userbyid(proowner) from pg_proc where oid='$fn'::regprocedure;")"
  assert_eq "[4] $fn : anon ne peut PAS l'exécuter" "false" "$(sql_on "$DB" "select has_function_privilege('anon','$fn','EXECUTE')::text;")"
  assert_eq "[4] $fn : service_role ne peut PAS l'exécuter" "false" "$(sql_on "$DB" "select has_function_privilege('service_role','$fn','EXECUTE')::text;")"
  assert_eq "[4] $fn : PUBLIC n'a aucun droit (aclexplode)" "0" "$(sql_on "$DB" "select count(*) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a where p.oid='$fn'::regprocedure and a.grantee=0;")"
done
assert_eq "[4] save : authenticated PEUT l'exécuter" "true" "$(sql_on "$DB" "select has_function_privilege('authenticated','$SF','EXECUTE')::text;")"
assert_eq "[4] get : authenticated PEUT l'exécuter" "true" "$(sql_on "$DB" "select has_function_privilege('authenticated','$GF','EXECUTE')::text;")"
assert_eq "[4] constructeur interne : authenticated ne peut PAS l'exécuter" "false" "$(sql_on "$DB" "select has_function_privilege('authenticated','$BF','EXECUTE')::text;")"
assert_eq "[4] save : VOLATILE, rend jsonb" "v|jsonb" "$(sql_on "$DB" "select provolatile::text||'|'||prorettype::regtype::text from pg_proc where oid='$SF'::regprocedure;")"
assert_eq "[4] une seule surcharge de chaque fonction" "1|1|1" "$(sql_on "$DB" "select (select count(*) from pg_proc where proname='save_fulfillment_configuration')||'|'||(select count(*) from pg_proc where proname='get_fulfillment_configuration')||'|'||(select count(*) from pg_proc where proname='csdjbo1_persisted_configuration');")"
assert_eq "[4] le corps de save ne contient ni EXECUTE dynamique ni SQL construit" "0" "$(sql_on "$DB" "select count(*) from pg_proc where oid='$SF'::regprocedure and prosrc ~* '(^|[^_a-z])execute[[:space:]]+(format|''|\\\$)';")"
assert_eq "[4] le corps de save prend le verrou de tenant (graine 1104)" "1" "$(sql_on "$DB" "select count(*) from pg_proc where oid='$SF'::regprocedure and prosrc like '%pg_advisory_xact_lock(pg_catalog.hashtextextended(p_restaurant_id::text, 1104))%';")"
assert_eq "[4] aucune table n'a reçu de droit d'écriture (INSERT/UPDATE/DELETE/TRUNCATE) pour un rôle applicatif" "0" "$(sql_on "$DB" "select count(*) from (values ('restaurant_fulfillment_schedule'),('restaurant_fulfillment_schedule_window'),('restaurant_fulfillment_schedule_slot'),('restaurant_fulfillment_schedule_closure'),('restaurant_fulfillment_prep_day'),('restaurant_fulfillment_prep_closure')) t(n), (values ('anon'),('authenticated'),('service_role')) r(r), (values ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) p(p) where has_table_privilege(r.r,'public.'||t.n,p.p);")"

# ============================================================
# [5] AUTORISATION : qui peut écrire, qui peut lire
# ============================================================
log "=== [5] Autorisation ==="
PA="$(mk_alc)"
[ -n "$PA" ] || fatal "charge ALC illisible."
R="$(call_save "$DB" authenticated "$STAFF_A" "$RID_A" "$PA")"
assert_has "[5] staff (membre) : écriture REFUSÉE CSDJ1_FORBIDDEN" "CSDJ1_FORBIDDEN" "$R"
R="$(call_save "$DB" authenticated "$OPERATOR_ID" "$RID_A" "$PA")"
assert_has "[5] opérateur Scanym (non membre) : écriture REFUSÉE (aucune dérogation opérateur)" "CSDJ1_FORBIDDEN" "$R"
R="$(call_save "$DB" authenticated "$STRANGER" "$RID_A" "$PA")"
assert_has "[5] inconnu : écriture REFUSÉE" "CSDJ1_FORBIDDEN" "$R"
R="$(call_save "$DB" authenticated "$OWNER_B" "$RID_A" "$PA")"
assert_has "[5] propriétaire d'un AUTRE établissement : écriture REFUSÉE (tenant croisé)" "CSDJ1_FORBIDDEN" "$R"
R="$(call_save "$DB" authenticated - "$RID_A" "$PA")"
assert_has "[5] sans session (auth.uid() nul) : écriture REFUSÉE CSDJ1_AUTH_REQUIRED" "CSDJ1_AUTH_REQUIRED" "$R"
R="$(call_save "$DB" anon - "$RID_A" "$PA")"
assert_has "[5] rôle anon : EXECUTE refusé (permission denied)" "permission denied" "$R"
R="$(call_save "$DB" anon "$OWNER_A" "$RID_A" "$PA")"
assert_has "[5] rôle anon avec le jeton d'un propriétaire : EXECUTE refusé" "permission denied" "$R"
R="$(call_save "$DB" service_role "$OWNER_A" "$RID_A" "$PA")"
assert_has "[5] rôle service_role : EXECUTE refusé (authenticated UNIQUEMENT)" "permission denied" "$R"
R="$(call_save "$DB" authenticated "$OWNER_A" '00000000-0000-0000-0000-0000000000ff' "$PA")"
assert_has "[5] établissement inexistant : même refus FORBIDDEN (aucune fuite d'existence)" "CSDJ1_FORBIDDEN" "$R"
assert_eq "[5] aucun de ces refus n'a écrit quoi que ce soit chez A (empreinte = données historiques)" "$PRE_SEED_A" "$(tenant_digest "$DB" "$RID_A")"
assert_eq "[5] ... ni chez B" "$PRE_SEED_B" "$(tenant_digest "$DB" "$RID_B")"
wipe_scope "$DB" "$RID_A"
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$PA")"
if is_err "$R"; then fail "[5] propriétaire : écriture refusée — $R"; else pass "[5] propriétaire de l'établissement : écriture ACCEPTÉE"; fi
wipe_scope "$DB" "$RID_A"
R="$(call_save "$DB" authenticated "$MANAGER_A" "$RID_A" "$PA")"
if is_err "$R"; then fail "[5] responsable : écriture refusée — $R"; else pass "[5] responsable (manager) : écriture ACCEPTÉE"; fi
# Lecture
R="$(call_get "$DB" authenticated "$STAFF_A" "$RID_A" pickup null)"
if is_err "$R"; then fail "[5] staff : lecture refusée — $R"; else pass "[5] staff (membre) : LECTURE autorisée"; fi
R="$(call_get "$DB" authenticated "$OPERATOR_ID" "$RID_A" pickup null)"
if is_err "$R"; then fail "[5] opérateur : lecture refusée — $R"; else pass "[5] opérateur Scanym : LECTURE autorisée (comme les lectures existantes)"; fi
R="$(call_get "$DB" authenticated "$STRANGER" "$RID_A" pickup null)"
assert_has "[5] inconnu : lecture REFUSÉE" "CSDJ1_FORBIDDEN" "$R"
R="$(call_get "$DB" authenticated "$OWNER_B" "$RID_A" pickup null)"
assert_has "[5] propriétaire d'un autre établissement : lecture REFUSÉE (tenant croisé)" "CSDJ1_FORBIDDEN" "$R"
R="$(call_get "$DB" authenticated - "$RID_A" pickup null)"
assert_has "[5] sans session : lecture REFUSÉE" "CSDJ1_AUTH_REQUIRED" "$R"
R="$(call_get "$DB" anon "$OWNER_A" "$RID_A" pickup null)"
assert_has "[5] anon : lecture REFUSÉE (permission denied)" "permission denied" "$R"
R="$(call_get "$DB" authenticated "$OWNER_A" "$RID_A" nowhere null)"
assert_has "[5] lecture : mode hors catalogue REFUSÉ" "CSDJ1_UNKNOWN_MODE" "$R"
R="$(call_get "$DB" authenticated "$OWNER_A" "$RID_A" delivery "$RULE_B")"
assert_has "[5] lecture : règle de livraison d'un AUTRE établissement REFUSÉE" "CSDJ1_FOREIGN_RULE" "$R"
R="$(call_get "$DB" authenticated "$OWNER_A" "$RID_A" delivery "$NIL_RULE")"
assert_has "[5] lecture : zéro UUID refusé (sentinelle)" "CSDJ1_RESERVED_RULE_ID" "$R"
R="$(call_get "$DB" authenticated "$OWNER_A" "$RID_A" delivery "$RULE_A")"
assert_eq "[5] lecture d'une portée sans configuration : NULL" "NULL" "$R"

# ============================================================
# Outils de vérification des refus
# ============================================================
ecode() { printf '%s' "$1" | sed -n 's/^ERR|\([A-Za-z0-9_]*\):.*/\1/p'; }
edetail() { printf '%s' "$1" | awk -F'|' '{ $1=""; $2=""; sub(/^\|\|/,""); print }' | sed 's/^ *//'; }
expect_code() { # <description> <code attendu> <résultat de call_save>
  local got; got="$(ecode "$3")"
  if [ "$got" = "$2" ]; then pass "$1 → $2"; else fail "$1 — attendu $2, obtenu '${got:-<aucun code nommé>}' ($(printf '%s' "$3" | cut -c1-220))"; fi
}
# SQLSTATE d'un refus (les clients REST dérivent le statut HTTP de ce code).
sqlstate_of() { # <rid> <uid> <charge>
  local out
  out="$(PGOPTIONS="-c lc_messages=C -c role=authenticated" psql -X -A -q -t -v ON_ERROR_STOP=1 -v p="$3" -d "$DB" 2>&1 <<SQL
\set VERBOSITY verbose
set test.uid = '$2';
select public.save_fulfillment_configuration('$1'::uuid, :'p'::jsonb);
SQL
)"
  printf '%s\n' "$out" | sed -n 's/^ERROR:  \([0-9A-Z]\{5\}\):.*/\1/p' | head -1
}
set_scope() { # <charge> <mode> <règle|null> : change la portée visée par une charge
  pm "$1" "(:'b'::jsonb) || jsonb_build_object('modeCode','$2','fulfillmentRuleId',$( [ "$3" = "null" ] && echo "null::text" || echo "'$3'::text" ))"
}
cnt() { pm "$1" "jsonb_array_length((:'b'::jsonb)->'$2')"; }
cfg_of() { call_get "$DB" authenticated "$OWNER_A" "$RID_A" "$1" "${2:-null}"; }   # <mode> [règle]
sans_jetons() { pm "$1" "(:'b'::jsonb) - 'updatedAt' - 'revision'"; }

# ============================================================
# [6] CHEMINS NOMINAUX
# ============================================================
log "=== [6] Chemins nominaux ==="
SF_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$'
wipe_scope "$DB" "$RID_A"
A_EMPTY="$(tenant_digest "$DB" "$RID_A")"

# 6.1 Exemple ALC : retrait, mardi–samedi, 2 créneaux, heure limite 16 h la veille.
R1="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$PA")"
if is_err "$R1"; then fail "[6.1] l'exemple ALC est refusé : $R1"; R1='{}'; else pass "[6.1] l'exemple ALC (retrait, 2 créneaux, mardi–samedi, 16 h la veille) est enregistré"; fi
assert_eq "[6.1] méthode v1.2" "v1.2" "$(jv "$R1" '{method}')"
assert_eq "[6.1] activée" "true" "$(jv "$R1" '{enabled}')"
assert_eq "[6.1] heure limite 16:00" "16:00" "$(jv "$R1" '{policy,cutoffTime}')"
assert_eq "[6.1] 10 créneaux (5 jours × 2)" "10" "$(cnt "$R1" slots)"
assert_eq "[6.1] aucune fenêtre" "0" "$(cnt "$R1" windows)"
assert_eq "[6.1] jours de préparation lundi–vendredi" "[1, 2, 3, 4, 5]" "$(jv "$R1" '{preparation,weekdays}')"
assert_eq "[6.1] lignes écrites : 0 fenêtre, 10 créneaux, 0 fermeture, 5 jours de préparation, 0 fermeture de préparation" "0|10|0|5|0" "$(scope_counts "$DB" "$RID_A" pickup)"
assert_eq "[6.1] jeton updatedAt au format µs UTC" "1" "$(printf '%s' "$(jv "$R1" '{updatedAt}')" | grep -cE "$SF_RE")"
assert_eq "[6.1] révision = 32 caractères hexadécimaux" "1" "$(printf '%s' "$(jv "$R1" '{revision}')" | grep -cE '^[0-9a-f]{32}$')"
assert_eq "[6.1] l'établissement B n'a pas bougé d'un octet" "$PRE_SEED_B" "$(tenant_digest "$DB" "$RID_B")"
# La réponse ne porte aucun compte de capacité.
LEAK="$(printf '%s' "$R1" | grep -Eio '"[A-Za-z]*(count|used|remaining|reserved|places|left|taken|available)[A-Za-z]*"[[:space:]]*:' | sort -u | tr '\n' ' ')"
assert_eq "[6.1] aucune clé de compte de capacité, de places restantes ou de réservations dans la réponse" "" "$LEAK"
assert_eq "[6.1] ni secret, ni SQLSTATE, ni identifiant sensible : seules les clés du contrat sont rendues" \
  "capacity,closures,enabled,fulfillmentRuleId,holidays,method,modeCode,policy,preparation,revision,slots,updatedAt,windows" \
  "$(pm "$R1" "(select string_agg(k, ',' order by k) from jsonb_object_keys(:'b'::jsonb) k)")"
# 6.2 Relecture : l'écriture et la lecture rendent la même chose.
G1="$(cfg_of pickup)"
assert_eq "[6.2] get_fulfillment_configuration rend EXACTEMENT la réponse de l'écriture" "$R1" "$G1"
# 6.3 Resauvegarde avec jeton : le jeton avance strictement, le contenu (révision) ne change pas.
R2="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$PA" "$R1")")"
if is_err "$R2"; then fail "[6.3] resauvegarde avec jeton refusée : $R2"; R2='{}'; else pass "[6.3] resauvegarde avec les deux jetons : acceptée"; fi
assert_eq "[6.3] même contenu => même révision" "$(jv "$R1" '{revision}')" "$(jv "$R2" '{revision}')"
assert_eq "[6.3] le jeton updatedAt a strictement avancé" "1" "$( [[ "$(jv "$R2" '{updatedAt}')" > "$(jv "$R1" '{updatedAt}')" ]] && echo 1 || echo 0)"
# 6.4 Double soumission : rejouer la MÊME charge (ancien jeton) est refusé, sans effet.
D_BEFORE="$(tenant_digest "$DB" "$RID_A")"
R3="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$PA" "$R1")")"
expect_code "[6.4] double soumission avec l'ancien jeton" "CSDJBO1_STALE_CONFIGURATION" "$R3"
assert_has "[6.4] motif nommé" "reason=updated_at_changed" "$R3"
assert_eq "[6.4] aucune écriture" "$D_BEFORE" "$(tenant_digest "$DB" "$RID_A")"
assert_eq "[6.4] SQLSTATE 23505 (409 côté REST)" "23505" "$(sqlstate_of "$RID_A" "$OWNER_A" "$(with_token "$PA" "$R1")")"
# 6.5 Résolveur : l'horloge est injectée. Le lundi à 15:59 (Paris) la veille est encore ouverte.
res_first() { sql_on "$DB" "select coalesce(first_eligible_date::text,'-')||'/'||status from public.resolve_fulfillment_schedule_v12('$RID_A','pickup',null,'$1'::timestamptz,false);"; }
assert_eq "[6.5] lundi 15:59 (13:59Z) → premier retrait possible : mardi 2026-10-20" "2026-10-20/dates_available" "$(res_first '2026-10-19 13:59:00+00')"
assert_eq "[6.5] lundi 16:00 (14:00Z) → mercredi 2026-10-21 (l'heure limite est atteinte)" "2026-10-21/dates_available" "$(res_first '2026-10-19 14:00:00+00')"
assert_eq "[6.5] lundi 16:01 → mercredi 2026-10-21" "2026-10-21/dates_available" "$(res_first '2026-10-19 14:01:00+00')"
assert_eq "[6.5] samedi matin → mardi (dimanche et lundi fermés)" "2026-10-20/dates_available" "$(res_first '2026-10-17 08:00:00+00')"
assert_eq "[6.5] jours proposés : mardi à samedi, jamais dimanche ni lundi" "2,3,4,5,6" "$(sql_on "$DB" "select string_agg(distinct extract(dow from d)::int::text, ',' order by extract(dow from d)::int::text) from public.resolve_fulfillment_schedule_v12('$RID_A','pickup',null,'2026-10-17 08:00:00+00'::timestamptz,false) r, unnest(r.eligible_dates) d;")"
assert_eq "[6.5] deux créneaux par jour (midi 11–14, soir 16–20)" "2" "$(sql_on "$DB" "select jsonb_array_length(offers->'2026-10-20') from public.resolve_fulfillment_schedule_v12('$RID_A','pickup',null,'2026-10-17 08:00:00+00'::timestamptz,false);")"
VAL="$(sql_on "$DB" "select result||'|'||coalesce(reason,'-') from public.validate_fulfillment_selection('$RID_A','pickup',null,'2026-10-20','soir',null,'2026-10-19 13:59:00+00'::timestamptz);")"
assert_has "[6.5] validate_fulfillment_selection (CSDJ-3, inchangée) accepte mardi/soir écrit par la nouvelle RPC" "valid|" "$VAL"
VAL="$(sql_on "$DB" "select result||'|'||coalesce(reason,'-') from public.validate_fulfillment_selection('$RID_A','pickup',null,'2026-10-18','soir',null,'2026-10-14 08:00:00+00'::timestamptz);")"
assert_eq "[6.5] ... et refuse un dimanche" "1" "$([ "${VAL%%|*}" != "valid" ] && echo 1 || echo 0)"

# 6.6 Livraison v1 sur une règle du commerçant : portée INDÉPENDANTE de celle du retrait.
PICK_BEFORE="$(cfg_of pickup)"
PV1="$(mk_v1)"
PD="$(set_scope "$PV1" delivery "$RULE_A")"
RD="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$PD")"
if is_err "$RD"; then fail "[6.6] livraison v1 sur la règle A refusée : $RD"; RD='{}'; else pass "[6.6] livraison v1 (fenêtres, décalage d'heure limite, 2 fermetures) enregistrée sur la règle de A"; fi
assert_eq "[6.6] portée = règle de l'établissement" "$RULE_A" "$(jv "$RD" '{fulfillmentRuleId}')"
assert_eq "[6.6] 10 fenêtres (lundi–vendredi × 2)" "10" "$(cnt "$RD" windows)"
assert_eq "[6.6] 2 fermetures, la seconde sans libellé" "2|null" "$(cnt "$RD" closures)|$(jv "$RD" '{closures,1,label}' | sed 's/^$/null/')"
assert_eq "[6.6] décalage d'heure limite 1 jour (propre à la v1)" "1" "$(jv "$RD" '{policy,cutoffOffsetDays}')"
assert_eq "[6.6] méthode v1 : aucune section v1.2 rendue" "0" "$(pm "$RD" "((:'b'::jsonb) ? 'preparation')::int + ((:'b'::jsonb) ? 'holidays')::int + ((:'b'::jsonb) ? 'capacity')::int")"
assert_eq "[6.6] la configuration du retrait n'a PAS bougé (portées indépendantes)" "$PICK_BEFORE" "$(cfg_of pickup)"
assert_eq "[6.6] lecture de la portée livraison = réponse d'écriture" "$RD" "$(cfg_of delivery "$RULE_A")"
assert_eq "[6.6] la portée livraison sans règle n'existe pas" "NULL" "$(cfg_of delivery)"

# 6.7 Règles « manuelles » multiples d'un même commerçant : chacune sa portée (Stuart / Chronofresh indépendants).
RULE_A2="$(sql_on "$DB" "insert into public.restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, zone_prefixes, is_fallback, min_items, customer_text, display_order, enabled, pricing_mode, fixed_fee) values ('$RID_A','delivery','manual_stuart','stuart',array['94'],false,0,'Livraison express',2,true,'fixed',7.00) returning id;")"
RULE_A3="$(sql_on "$DB" "insert into public.restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, zone_prefixes, is_fallback, min_items, customer_text, display_order, enabled, pricing_mode, fixed_fee) values ('$RID_A','delivery','manual_chronofresh','chronofresh',array['69'],false,0,'Colis frais',3,true,'fixed',12.00) returning id;")"
[ -n "$RULE_A2" ] && [ -n "$RULE_A3" ] || fatal "règles de test A2/A3 non créées."
PD2="$(pm "$(set_scope "$PV1" delivery "$RULE_A2")" "jsonb_set(jsonb_set(:'b'::jsonb,'{policy,cutoffTime}','\"09:30\"'),'{policy,bookingHorizonDays}','30')")"
RD2="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$PD2")"
if is_err "$RD2"; then fail "[6.7] règle A2 refusée : $RD2"; else pass "[6.7] la règle manuelle A2 reçoit SA configuration"; fi
PD3="$(pm "$(set_scope "$PV1" delivery "$RULE_A3")" "jsonb_set(jsonb_set(:'b'::jsonb,'{policy,cutoffTime}','\"11:15\"'),'{enabled}','false')")"
RD3="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$PD3")"
if is_err "$RD3"; then fail "[6.7] règle A3 refusée : $RD3"; else pass "[6.7] la règle manuelle A3 reçoit SA configuration (brouillon)"; fi
assert_eq "[6.7] chaque règle garde son heure limite : A1 12:00 / A2 09:30 / A3 11:15" "12:00/09:30/11:15" \
  "$(jv "$(cfg_of delivery "$RULE_A")" '{policy,cutoffTime}')/$(jv "$(cfg_of delivery "$RULE_A2")" '{policy,cutoffTime}')/$(jv "$(cfg_of delivery "$RULE_A3")" '{policy,cutoffTime}')"
assert_eq "[6.7] A1 active, A2 active, A3 en brouillon : états indépendants" "true/true/false" \
  "$(jv "$(cfg_of delivery "$RULE_A")" '{enabled}')/$(jv "$(cfg_of delivery "$RULE_A2")" '{enabled}')/$(jv "$(cfg_of delivery "$RULE_A3")" '{enabled}')"
assert_eq "[6.7] le retrait est toujours inchangé" "$PICK_BEFORE" "$(cfg_of pickup)"
assert_eq "[6.7] aucune ligne de planification n'a été créée ailleurs que chez A (B : données historiques seules)" "$PRE_SEED_B" "$(tenant_digest "$DB" "$RID_B")"
assert_eq "[6.7] les règles ALC ne deviennent PAS des défauts globaux : B n'a toujours que sa portée historique" "1" "$(sql_on "$DB" "select count(*) from public.restaurant_fulfillment_schedule where restaurant_id='$RID_B';")"
assert_eq "[6.7] ... et B n'a ni préparation, ni créneau ALC" "0|0" "$(sql_on "$DB" "select (select count(*) from public.restaurant_fulfillment_prep_day where restaurant_id='$RID_B')||'|'||(select count(*) from public.restaurant_fulfillment_schedule_slot where restaurant_id='$RID_B' and slot_key in ('midi','soir'));")"
# La règle de B est refusée pour A (déjà couvert en [5]), et l'inverse :
R="$(call_save "$DB" authenticated "$OWNER_B" "$RID_B" "$(set_scope "$PV1" delivery "$RULE_A")")"
expect_code "[6.7] le propriétaire de B ne peut pas viser la règle de A" "CSDJ1_FOREIGN_RULE" "$R"
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(set_scope "$PV1" delivery "$RULE_B")")"
expect_code "[6.7] le propriétaire de A ne peut pas viser la règle de B" "CSDJ1_FOREIGN_RULE" "$R"
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(set_scope "$PV1" pickup "$RULE_A")")"
expect_code "[6.7] une règle de livraison ne peut pas servir une portée « retrait »" "CSDJ1_FOREIGN_RULE" "$R"

# 6.8 Brouillon, puis activation (complétude évaluée avant).
DR_BASE="$(pm "$PA" "jsonb_set(jsonb_set(jsonb_set(jsonb_set(:'b'::jsonb,'{enabled}','false'),'{slots}','[]'),'{preparation,weekdays}','[]'),'{policy,cutoffTime}','null')")"
wipe_scope "$DB" "$RID_A"
RDR="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$DR_BASE")"
if is_err "$RDR"; then fail "[6.8] un brouillon incomplet est refusé : $RDR"; RDR='{}'; else pass "[6.8] un BROUILLON incomplet (aucun créneau, aucune préparation) est enregistré tel quel"; fi
assert_eq "[6.8] le brouillon est persisté inactif" "false" "$(jv "$RDR" '{enabled}')"
ACT="$(pm "$DR_BASE" "jsonb_set(:'b'::jsonb,'{enabled}','true')")"
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$ACT" "$RDR")")"
expect_code "[6.8] activer l'incomplet est refusé AVANT écriture" "CSDJBO1_INCOMPLETE_CONFIGURATION" "$R"
assert_has "[6.8] bloqueurs nommés" "blockers=offer_missing,preparation_missing" "$R"
assert_eq "[6.8] le brouillon est intact (rien n'a bougé)" "$RDR" "$(cfg_of pickup)"
ACT2="$(pm "$PA" "(:'b'::jsonb)")"
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$ACT2" "$RDR")")"
if is_err "$R"; then fail "[6.8] l'activation de la configuration complète est refusée : $R"; else pass "[6.8] la configuration complétée s'active en UNE écriture"; fi
assert_eq "[6.8] activée" "true" "$(jv "$R" '{enabled}')"
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$(pm "$ACT2" "jsonb_set(:'b'::jsonb,'{enabled}','false')")" "$R")")"
if is_err "$R"; then fail "[6.8] la désactivation est refusée : $R"; else pass "[6.8] la désactivation (retour en brouillon) conserve toute la configuration"; fi
assert_eq "[6.8] ... créneaux et préparation conservés" "0|10|0|5|0" "$(scope_counts "$DB" "$RID_A" pickup)"

# 6.9 Changement de méthode : v1.2 → v1 → v1.2, sans résidu.
CUR="$(cfg_of pickup)"
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$PV1" "$CUR")")"
if is_err "$R"; then fail "[6.9] bascule v1.2 → v1 refusée : $R"; else pass "[6.9] bascule v1.2 → v1 acceptée"; fi
assert_eq "[6.9] la préparation, les créneaux ALC sont REMPLACÉS : 10 fenêtres, 0 créneau, 2 fermetures, 0 préparation" "10|0|2|0|0" "$(scope_counts "$DB" "$RID_A" pickup)"
assert_eq "[6.9] colonnes v1.2 remises à leur valeur neutre" "|open|open|false|" "$(sql_on "$DB" "select coalesce(holiday_calendar_id::text,'')||'|'||preparation_on_holidays||'|'||availability_on_holidays||'|'||capacity_enabled||'|'||coalesce(capacity_max_orders::text,'') from public.restaurant_fulfillment_schedule where restaurant_id='$RID_A' and mode_code='pickup' and rule_key='$NIL_RULE';")"
CUR="$R"
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$PA" "$CUR")")"
if is_err "$R"; then fail "[6.9] bascule v1 → v1.2 refusée : $R"; else pass "[6.9] bascule v1 → v1.2 acceptée"; fi
assert_eq "[6.9] retour à l'exemple ALC, sans résidu de fenêtres ni de fermetures v1" "0|10|0|5|0" "$(scope_counts "$DB" "$RID_A" pickup)"

# 6.10 Fériés, fermetures, capacité (tout en une écriture).
CAL="$(sql_on "$DB" "insert into public.public_holiday_calendar (code,label,country_code) values ('fr-bo1-test','Fériés test BO1','FR') returning id;")"
sql_on "$DB" "insert into public.public_holiday_calendar_day (calendar_id, holiday_on, label) values ('$CAL','2026-11-11','Armistice'),('$CAL','2026-12-25','Noël');" >/dev/null
FULL="$(pm "$PA" "(:'b'::jsonb) || jsonb_build_object(
   'closures','[{\"closedOn\":\"2026-11-02\",\"label\":\"Pont\"}]'::jsonb,
   'preparation',jsonb_build_object('weekdays','[1,2,3,4,5]'::jsonb,'closures','[{\"closedOn\":\"2026-12-24\",\"label\":\"Veille\"}]'::jsonb),
   'holidays',jsonb_build_object('calendarId','$CAL','preparationOnHolidays','closed','availabilityOnHolidays','closed'),
   'capacity',jsonb_build_object('enabled',true,'maxOrders',12))")"
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$FULL" "$(cfg_of pickup)")")"
if is_err "$R"; then fail "[6.10] politique complète (fériés, fermetures, capacité) refusée : $R"; R='{}'; else pass "[6.10] fériés + fermetures + préparation + capacité enregistrés en UNE écriture"; fi
assert_eq "[6.10] calendrier, politiques fériées et capacité relus" "$CAL/closed/closed/true/12" "$(jv "$R" '{holidays,calendarId}')/$(jv "$R" '{holidays,preparationOnHolidays}')/$(jv "$R" '{holidays,availabilityOnHolidays}')/$(jv "$R" '{capacity,enabled}')/$(jv "$R" '{capacity,maxOrders}')"
assert_eq "[6.10] fermetures de disponibilité et de préparation écrites" "0|10|1|5|1" "$(scope_counts "$DB" "$RID_A" pickup)"
assert_eq "[6.10] la capacité relue est la LIMITE configurée, aucun compteur" "0" "$(printf '%s' "$R" | grep -Eic '"(used|remaining|count|reserved)')"
# reserve_fulfillment_capacity (CSDJ-3, inchangée) fonctionne avec une configuration écrite par la nouvelle RPC.
O1="$(psql -X -A -q -t -d "$DB" -c "insert into public.orders (restaurant_id, order_number, service_mode, subtotal, total, currency, status, payment_status) values ('$RID_A', 901, 'pickup', 1, 1, 'EUR', 'new', 'not_required') returning id;" | head -1)"
RSV="$(sql_on "$DB" "select result||'|'||coalesce(reason,'-') from public.reserve_fulfillment_capacity('$O1','$RID_A','pickup',null,'2026-10-20','midi',null,'2026-10-19 13:59:00+00'::timestamptz);")"
assert_has "[6.10] reserve_fulfillment_capacity réserve sur une configuration écrite par la RPC" "reserved" "$RSV"
assert_eq "[6.10] ... et ne contient pas la clé « used »" "0" "$(cfg_of pickup | grep -Eic '"(used|remaining)')"

# ============================================================
# [7] VALIDATION : chaque défaut a un NOM, rien n'est écrit
# ============================================================
log "=== [7] Validation ==="
wipe_scope "$DB" "$RID_A"
A_EMPTY="$(tenant_digest "$DB" "$RID_A")"
QB=":'b'::jsonb"
# Construction de charges : S <expr> <chemin a,b> <json> remplace/ajoute ; D <expr> <clé> retire une clé de tête ;
# DP <expr> <chemin> retire un chemin. « @B@ » désigne la charge de base.
S()  { printf 'jsonb_set(%s,$p${%s}$p$,$j$%s$j$::jsonb)' "$1" "$2" "$3"; }
DP() { printf '(%s #- $p${%s}$p$)' "$1" "$2"; }
vcase() { # <libellé> <base 12|1> <expression avec @B@> <code attendu> [fragment de détail]
  local base payload R
  if [ "$2" = "12" ]; then base="$PA"; else base="$PV1"; fi
  payload="$(pm "$base" "${3//@B@/$QB}")"
  if [ -z "$payload" ] || has "$payload" "ERROR"; then fail "[7] $1 : charge de test illisible ($(printf '%s' "$payload" | cut -c1-120))"; return; fi
  R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$payload")"
  expect_code "[7] $1" "$4" "$R"
  [ -n "${5:-}" ] && assert_has "[7] $1 : détail" "$5" "$R"
  return 0
}
B='@B@'
IP=CSDJ1_INVALID_PAYLOAD
# -- forme générale
vcase "clé inconnue en tête de charge" 12 "$(S $B foo 1)" $IP
vcase "faute de frappe « enabeld »" 12 "$(S $B enabeld true)" $IP
vcase "policy absente" 12 "$(DP $B policy)" $IP
vcase "policy en tableau" 12 "$(S $B policy '[]')" $IP
vcase "clé inconnue dans policy" 12 "$(S $B policy,foo 1)" $IP
vcase "windows absent (pas de delta implicite)" 12 "$(DP $B windows)" $IP
vcase "windows en objet" 12 "$(S $B windows '{}')" $IP
vcase "slots à null" 12 "$(S $B slots null)" $IP
vcase "closures en chaîne" 12 "$(S $B closures '"x"')" $IP
vcase "enabled en chaîne" 12 "$(S $B enabled '"yes"')" $IP
vcase "enabled absent" 12 "$(DP $B enabled)" $IP
# -- mode et règle
vcase "mode absent" 12 "$(DP $B modeCode)" CSDJ1_UNKNOWN_MODE
vcase "mode hors catalogue" 12 "$(S $B modeCode '"nowhere"')" CSDJ1_UNKNOWN_MODE
vcase "mode numérique" 12 "$(S $B modeCode 7)" CSDJ1_UNKNOWN_MODE
vcase "règle non UUID" 12 "$(S $B fulfillmentRuleId '"abc"')" $IP
vcase "règle numérique" 12 "$(S $B fulfillmentRuleId 5)" $IP
vcase "règle = zéro UUID (sentinelle réservée)" 12 "$(S $B fulfillmentRuleId '"00000000-0000-0000-0000-000000000000"')" CSDJ1_RESERVED_RULE_ID
vcase "règle d'un autre établissement" 12 "$(S $(S $B modeCode '"delivery"') fulfillmentRuleId "\"$RULE_B\"")" CSDJ1_FOREIGN_RULE
vcase "règle inexistante" 12 "$(S $(S $B modeCode '"delivery"') fulfillmentRuleId '"11111111-2222-4333-8444-555555555555"')" CSDJ1_FOREIGN_RULE
# -- méthode
vcase "méthode absente" 12 "$(DP $B method)" $IP
vcase "méthode inconnue « v2 »" 12 "$(S $B method '"v2"')" $IP
vcase "méthode numérique" 12 "$(S $B method 12)" $IP
vcase "v1 portant « preparation »" 1 "$(S $B preparation '{"weekdays":[1],"closures":[]}')" CSDJBO1_METHOD_MISMATCH "sections="
vcase "v1 portant « holidays »" 1 "$(S $B holidays '{"calendarId":null,"preparationOnHolidays":"open","availabilityOnHolidays":"open"}')" CSDJBO1_METHOD_MISMATCH
vcase "v1 portant « capacity »" 1 "$(S $B capacity '{"enabled":false,"maxOrders":null}')" CSDJBO1_METHOD_MISMATCH
vcase "v1 sans décalage d'heure limite" 1 "$(DP $B policy,cutoffOffsetDays)" $IP
vcase "v1 décalage 31" 1 "$(S $B policy,cutoffOffsetDays 31)" $IP
vcase "v1 décalage -1" 1 "$(S $B policy,cutoffOffsetDays -1)" $IP
vcase "v1 décalage en chaîne" 1 "$(S $B policy,cutoffOffsetDays '"1"')" $IP
vcase "v1.2 avec décalage 1" 12 "$(S $B policy,cutoffOffsetDays 1)" CSDJBO1_METHOD_MISMATCH "field=policy.cutoffOffsetDays"
vcase "v1.2 avec décalage « 0 » en chaîne" 12 "$(S $B policy,cutoffOffsetDays '"0"')" CSDJBO1_METHOD_MISMATCH
vcase "v1.2 sans « preparation »" 12 "$(DP $B preparation)" $IP
vcase "v1.2 sans « holidays »" 12 "$(DP $B holidays)" $IP
vcase "v1.2 sans « capacity »" 12 "$(DP $B capacity)" $IP
vcase "v1.2 « preparation » en tableau" 12 "$(S $B preparation '[]')" $IP
# -- politique
for k in timezone dateSelectionMode slotSelectionMode timeGranularityMinutes leadTimeMinutes minLeadDays cutoffTime bookingHorizonDays; do
  vcase "policy.$k absent (aucun défaut côté serveur)" 12 "$(DP $B policy,$k)" $IP
done
vcase "fuseau inconnu" 12 "$(S $B policy,timezone '"Mars/Olympus"')" CSDJ1_INVALID_TIMEZONE
vcase "fuseau numérique" 12 "$(S $B policy,timezone 5)" CSDJ1_INVALID_TIMEZONE
vcase "fuseau null" 12 "$(S $B policy,timezone null)" CSDJ1_INVALID_TIMEZONE
vcase "mode de date hors catalogue" 12 "$(S $B policy,dateSelectionMode '"bogus"')" CSDJ1_INVALID_POLICY
vcase "mode de créneau hors catalogue" 12 "$(S $B policy,slotSelectionMode '"bogus"')" CSDJ1_INVALID_POLICY
vcase "mode de date numérique" 12 "$(S $B policy,dateSelectionMode 3)" CSDJ1_INVALID_POLICY
vcase "date informative + créneaux fixes (incohérent)" 12 "$(S $B policy,dateSelectionMode '"informational_only"')" CSDJ1_INVALID_POLICY
vcase "date dérivée + créneaux fixes (incohérent)" 12 "$(S $B policy,dateSelectionMode '"derived_earliest"')" CSDJ1_INVALID_POLICY
for v in -1 1.5 '"5"' null 100001; do vcase "leadTimeMinutes = $v" 12 "$(S $B policy,leadTimeMinutes "$v")" $IP; done
for v in -1 366 2.5 '"x"'; do vcase "minLeadDays = $v" 12 "$(S $B policy,minLeadDays "$v")" $IP; done
for v in -3 366 '"x"' null; do vcase "bookingHorizonDays = $v" 12 "$(S $B policy,bookingHorizonDays "$v")" $IP; done
for v in 4 241 '"x"' 7.5 -5; do vcase "timeGranularityMinutes = $v" 12 "$(S $B policy,timeGranularityMinutes "$v")" $IP; done
for v in '"25:00"' '"24:00"' '"16h"' 16 true '"16:60"' '""'; do vcase "cutoffTime = $v" 12 "$(S $B policy,cutoffTime "$v")" $IP; done
vcase "cutoffTime avec secondes" 12 "$(S $B policy,cutoffTime '"16:00:30"')" CSDJ1_SUBMINUTE_TIME
TW="$(S $(S $(S $(S $B enabled false) policy,slotSelectionMode '"time_within_window"') slots '[]') windows '[{"weekday":1,"startsAt":"09:00","endsAt":"12:00"}]')"
vcase "heure libre sans pas de grille (brouillon)" 12 "$TW" CSDJBO1_INCOMPLETE_CONFIGURATION "blockers=granularity_missing"
vcase "heure libre sans pas de grille (activation)" 12 "$(S $TW enabled true)" CSDJBO1_INCOMPLETE_CONFIGURATION "blockers=granularity_missing"
# -- fenêtres
W1='{"weekday":1,"startsAt":"09:00","endsAt":"12:00"}'
vcase "fenêtre : jour 7" 1 "$(S $B windows '[{"weekday":7,"startsAt":"09:00","endsAt":"12:00"}]')" CSDJ12_INVALID_WEEKDAY
vcase "fenêtre : jour en chaîne" 1 "$(S $B windows '[{"weekday":"1","startsAt":"09:00","endsAt":"12:00"}]')" CSDJ12_INVALID_WEEKDAY
vcase "fenêtre : jour absent" 1 "$(S $B windows '[{"startsAt":"09:00","endsAt":"12:00"}]')" CSDJ12_INVALID_WEEKDAY
vcase "fenêtre : heure illisible" 1 "$(S $B windows '[{"weekday":1,"startsAt":"9h","endsAt":"12:00"}]')" $IP
vcase "fenêtre : fin avant début" 1 "$(S $B windows '[{"weekday":1,"startsAt":"12:00","endsAt":"09:00"}]')" $IP
vcase "fenêtre : durée nulle" 1 "$(S $B windows '[{"weekday":1,"startsAt":"09:00","endsAt":"09:00"}]')" $IP
vcase "fenêtre : secondes" 1 "$(S $B windows '[{"weekday":1,"startsAt":"09:00:30","endsAt":"12:00"}]')" CSDJ1_SUBMINUTE_TIME
vcase "fenêtre : clé inconnue" 1 "$(S $B windows '[{"weekday":1,"startsAt":"09:00","endsAt":"12:00","x":1}]')" $IP
vcase "fenêtre : displayOrder négatif" 1 "$(S $B windows '[{"weekday":1,"startsAt":"09:00","endsAt":"12:00","displayOrder":-1}]')" $IP
vcase "fenêtre : displayOrder 10000" 1 "$(S $B windows '[{"weekday":1,"startsAt":"09:00","endsAt":"12:00","displayOrder":10000}]')" $IP
vcase "fenêtre : élément non objet" 1 "$(S $B windows '[5]')" $IP
vcase "fenêtres : superposition simple" 1 "$(S $B windows '[{"weekday":1,"startsAt":"09:00","endsAt":"12:00"},{"weekday":1,"startsAt":"11:00","endsAt":"13:00"}]')" CSDJ1_WINDOW_OVERLAP
vcase "fenêtres : fenêtre englobante suivie de deux fenêtres ([9-20],[10-11],[12-13])" 1 "$(S $B windows '[{"weekday":1,"startsAt":"09:00","endsAt":"20:00"},{"weekday":1,"startsAt":"10:00","endsAt":"11:00"},{"weekday":1,"startsAt":"12:00","endsAt":"13:00"}]')" CSDJ1_WINDOW_OVERLAP
vcase "fenêtres : identiques" 1 "$(S $B windows '[{"weekday":1,"startsAt":"09:00","endsAt":"12:00"},{"weekday":1,"startsAt":"09:00","endsAt":"12:00"}]')" CSDJ1_WINDOW_OVERLAP
vcase "101 fenêtres" 1 "$(S $B windows "$(python3 -I -c 'import json;print(json.dumps([{"weekday":i%7,"startsAt":"%02d:%02d"%(i//60,i%60),"endsAt":"%02d:%02d"%((i+1)//60,(i+1)%60)} for i in range(101)]))')")" $IP
# -- créneaux
SL='{"weekday":2,"slotKey":"midi","startsAt":"11:00","endsAt":"14:00"}'
vcase "créneau : jour -1" 12 "$(S $B slots '[{"weekday":-1,"slotKey":"midi","startsAt":"11:00","endsAt":"14:00"}]')" CSDJ12_INVALID_WEEKDAY
vcase "créneau : clé en majuscules et espace" 12 "$(S $B slots '[{"weekday":2,"slotKey":"A B","startsAt":"11:00","endsAt":"14:00"}]')" $IP
vcase "créneau : clé vide" 12 "$(S $B slots '[{"weekday":2,"slotKey":"","startsAt":"11:00","endsAt":"14:00"}]')" $IP
vcase "créneau : clé de 41 caractères" 12 "$(S $B slots "[{\"weekday\":2,\"slotKey\":\"$(printf 'a%.0s' $(seq 1 41))\",\"startsAt\":\"11:00\",\"endsAt\":\"14:00\"}]")" $IP
vcase "créneau : fin avant début" 12 "$(S $B slots '[{"weekday":2,"slotKey":"midi","startsAt":"14:00","endsAt":"11:00"}]')" $IP
vcase "créneau : secondes" 12 "$(S $B slots '[{"weekday":2,"slotKey":"midi","startsAt":"11:00:15","endsAt":"14:00"}]')" CSDJ1_SUBMINUTE_TIME
vcase "créneau : doublon (jour, clé)" 12 "$(S $B slots '[{"weekday":2,"slotKey":"midi","startsAt":"11:00","endsAt":"14:00"},{"weekday":2,"slotKey":"midi","startsAt":"15:00","endsAt":"16:00"}]')" $IP
vcase "créneau : clé inconnue" 12 "$(S $B slots '[{"weekday":2,"slotKey":"midi","startsAt":"11:00","endsAt":"14:00","capacity":3}]')" $IP
vcase "201 créneaux" 12 "$(S $B slots "$(python3 -I -c 'import json;print(json.dumps([{"weekday":i%7,"slotKey":"s%d"%i,"startsAt":"01:00","endsAt":"02:00"} for i in range(201)]))')")" $IP
# -- fermetures
vcase "fermeture : date en double" 12 "$(S $B closures '[{"closedOn":"2026-12-25"},{"closedOn":"2026-12-25"}]')" $IP
vcase "fermeture : 30 février" 12 "$(S $B closures '[{"closedOn":"2026-02-30"}]')" $IP
vcase "fermeture : date mal formée" 12 "$(S $B closures '[{"closedOn":"26-1-1"}]')" $IP
vcase "fermeture : libellé de 121 caractères" 12 "$(S $B closures "[{\"closedOn\":\"2026-12-25\",\"label\":\"$(printf 'x%.0s' $(seq 1 121))\"}]")" $IP
vcase "fermeture : libellé numérique" 12 "$(S $B closures '[{"closedOn":"2026-12-25","label":5}]')" $IP
vcase "fermeture : élément non objet" 12 "$(S $B closures '["2026-12-25"]')" $IP
vcase "fermeture : clé inconnue" 12 "$(S $B closures '[{"closedOn":"2026-12-25","why":"x"}]')" $IP
vcase "732 fermetures" 12 "$(S $B closures "$(python3 -I -c 'import json,datetime;d=datetime.date(2026,1,1);print(json.dumps([{"closedOn":(d+datetime.timedelta(days=i)).isoformat()} for i in range(732)]))')")" CSDJ12_TOO_MANY_CLOSURES
# -- préparation
vcase "préparation : jour 7" 12 "$(S $B preparation,weekdays '[7]')" CSDJ12_INVALID_WEEKDAY
vcase "préparation : jour en chaîne" 12 "$(S $B preparation,weekdays '["1"]')" CSDJ12_INVALID_WEEKDAY
vcase "préparation : 8 jours" 12 "$(S $B preparation,weekdays '[0,1,2,3,4,5,6,1]')" CSDJ12_INVALID_WEEKDAY
vcase "préparation : jours non tableau" 12 "$(S $B preparation,weekdays '{}')" $IP
vcase "préparation : fermeture en double" 12 "$(S $B preparation,closures '[{"closedOn":"2026-12-24"},{"closedOn":"2026-12-24"}]')" $IP
vcase "préparation : clé inconnue" 12 "$(S $B preparation,foo 1)" $IP
vcase "préparation : 732 fermetures" 12 "$(S $B preparation,closures "$(python3 -I -c 'import json,datetime;d=datetime.date(2026,1,1);print(json.dumps([{"closedOn":(d+datetime.timedelta(days=i)).isoformat()} for i in range(732)]))')")" CSDJ12_TOO_MANY_CLOSURES
# -- fériés
vcase "fériés : calendrier inconnu" 12 "$(S $B holidays,calendarId '"11111111-2222-4333-8444-555555555555"')" CSDJ12_UNKNOWN_CALENDAR
vcase "fériés : calendrier non UUID" 12 "$(S $B holidays,calendarId '"abc"')" CSDJ12_UNKNOWN_CALENDAR
vcase "fériés : « closed » sans calendrier (préparation)" 12 "$(S $B holidays,preparationOnHolidays '"closed"')" CSDJ12_HOLIDAY_POLICY_NEEDS_CALENDAR
vcase "fériés : « closed » sans calendrier (disponibilité)" 12 "$(S $B holidays,availabilityOnHolidays '"closed"')" CSDJ12_HOLIDAY_POLICY_NEEDS_CALENDAR
vcase "fériés : politique hors catalogue" 12 "$(S $B holidays,availabilityOnHolidays '"x"')" CSDJ12_INVALID_HOLIDAY_POLICY
vcase "fériés : politique numérique" 12 "$(S $B holidays,preparationOnHolidays 1)" CSDJ12_INVALID_HOLIDAY_POLICY
vcase "fériés : clé absente" 12 "$(DP $B holidays,calendarId)" $IP
vcase "fériés : clé inconnue" 12 "$(S $B holidays,foo 1)" $IP
# -- capacité
vcase "capacité : activée sans maximum (brouillon)" 12 "$(S $(S $(S $B enabled false) capacity,enabled true) capacity,maxOrders null)" CSDJ12_INVALID_CAPACITY
vcase "capacité : maximum 0 (brouillon)" 12 "$(S $(S $(S $B enabled false) capacity,enabled true) capacity,maxOrders 0)" CSDJ12_INVALID_CAPACITY
vcase "capacité : maximum 0 (désactivée)" 12 "$(S $B capacity,maxOrders 0)" CSDJ12_INVALID_CAPACITY
vcase "capacité : maximum 1 000 001" 12 "$(S $B capacity,maxOrders 1000001)" CSDJ12_INVALID_CAPACITY
vcase "capacité : maximum en chaîne" 12 "$(S $B capacity,maxOrders '"5"')" CSDJ12_INVALID_CAPACITY
vcase "capacité : maximum décimal" 12 "$(S $B capacity,maxOrders 1.5)" CSDJ12_INVALID_CAPACITY
vcase "capacité : enabled en chaîne" 12 "$(S $B capacity,enabled '"yes"')" $IP
vcase "capacité : maxOrders absent" 12 "$(DP $B capacity,maxOrders)" $IP
vcase "capacité : clé inconnue" 12 "$(S $B capacity,used 3)" $IP
INFO="$(S $(S $(S $(S $(S $B policy,dateSelectionMode '"informational_only"') policy,slotSelectionMode '"none"') slots '[]') capacity,enabled true) capacity,maxOrders 5)"
vcase "capacité sur date informative (brouillon)" 12 "$(S $INFO enabled false)" CSDJ12_CAPACITY_NEEDS_DATE
vcase "capacité sur date informative (activation)" 12 "$INFO" CSDJBO1_INCOMPLETE_CONFIGURATION "blockers=capacity_needs_date"
# -- jetons d'anti-concurrence (forme)
vcase "expectedUpdatedAt numérique" 12 "$(S $B expectedUpdatedAt 5)" $IP
vcase "expectedUpdatedAt « hier »" 12 "$(S $B expectedUpdatedAt '"yesterday"')" $IP
vcase "expectedUpdatedAt sans « Z »" 12 "$(S $B expectedUpdatedAt '"2026-10-14T10:00:00+02:00"')" $IP
vcase "expectedUpdatedAt impossible" 12 "$(S $B expectedUpdatedAt '"2026-13-45T00:00:00Z"')" $IP
vcase "expectedRevision illisible" 12 "$(S $B expectedRevision '"xyz"')" $IP
vcase "expectedRevision numérique" 12 "$(S $B expectedRevision 5)" $IP
# -- charge non objet
for pl in '[]' '"x"' '5' 'null' 'true'; do
  R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$pl")"; expect_code "[7] charge non objet $pl" "$IP" "$R"
done
R="$(PGOPTIONS="-c lc_messages=C -c role=authenticated" psql -X -A -q -t -d "$DB" 2>&1 <<SQL | grep -m1 ERROR | sed 's/^.*ERROR:  //;s/:.*//'
set test.uid = '$OWNER_A';
select public.save_fulfillment_configuration('$RID_A'::uuid, null::jsonb);
SQL
)"
assert_eq "[7] charge SQL NULL → refus nommé" "$IP" "$R"
R="$(PGOPTIONS="-c lc_messages=C -c role=authenticated" psql -X -A -q -t -d "$DB" 2>&1 <<SQL | grep -m1 ERROR | sed 's/^.*ERROR:  //;s/:.*//'
set test.uid = '$OWNER_A';
select public.save_fulfillment_configuration(null::uuid, '{}'::jsonb);
SQL
)"
assert_eq "[7] établissement NULL → CSDJ1_FORBIDDEN" "CSDJ1_FORBIDDEN" "$R"
assert_eq "[7] SQLSTATE : validation 22023 / complétude 23514" "22023/23514" \
  "$(sqlstate_of "$RID_A" "$OWNER_A" "$(pm "$PA" "(:'b'::jsonb) || \$j\${\"foo\":1}\$j\$::jsonb")")/$(sqlstate_of "$RID_A" "$OWNER_A" "$ACT")"
# Après TOUTE la matrice : rien n'a été écrit, nulle part.
assert_eq "[7] après toute la matrice de refus, l'état de A est celui de départ (aucune écriture partielle)" "$A_EMPTY" "$(tenant_digest "$DB" "$RID_A")"
assert_eq "[7] ... et B est inchangé" "$PRE_SEED_B" "$(tenant_digest "$DB" "$RID_B")"
# Acceptations limites : ce qui est valide NE doit PAS être refusé.
vok() { # <libellé> <base> <expression> : accepté (puis la portée est effacée)
  local base payload R
  if [ "$2" = "12" ]; then base="$PA"; else base="$PV1"; fi
  payload="$(pm "$base" "${3//@B@/$QB}")"
  R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$payload")"
  if is_err "$R"; then fail "[7+] $1 — refusé à tort : $(printf '%s' "$R" | cut -c1-200)"; else pass "[7+] $1 : accepté"; fi
  wipe_scope "$DB" "$RID_A"
}
vok "fenêtres au contact (fin = début)" 1 "$(S $B windows '[{"weekday":1,"startsAt":"09:00","endsAt":"12:00"},{"weekday":1,"startsAt":"12:00","endsAt":"14:00"}]')"
vok "même plage sur deux jours différents" 1 "$(S $B windows '[{"weekday":1,"startsAt":"09:00","endsAt":"12:00"},{"weekday":2,"startsAt":"09:00","endsAt":"12:00"}]')"
vok "v1.2 avec décalage explicite 0" 12 "$(S $B policy,cutoffOffsetDays 0)"
vok "heure limite null" 12 "$(S $B policy,cutoffTime null)"
vok "heure limite 00:00 et 23:59" 12 "$(S $B policy,cutoffTime '"23:59"')"
vok "préparation avec doublons de jours (dédoublonnés)" 12 "$(S $B preparation,weekdays '[1,1,2,2]')"
vok "date informative sans offre (aucun créneau requis)" 12 "$(S $(S $(S $B policy,dateSelectionMode '"informational_only"') policy,slotSelectionMode '"none"') slots '[]')"
vok "date dérivée avec fenêtres" 12 "$(S $(S $(S $B policy,dateSelectionMode '"derived_earliest"') policy,slotSelectionMode '"none"') windows '[{"weekday":2,"startsAt":"11:00","endsAt":"14:00"}]')"
vok "heure libre avec pas de 15 minutes et une fenêtre" 12 "$(S $(S $(S $(S $B policy,slotSelectionMode '"time_within_window"') policy,timeGranularityMinutes 15) slots '[]') windows '[{"weekday":2,"startsAt":"11:00","endsAt":"14:00"}]')"
vok "dimanche (jour 0) et samedi (jour 6)" 12 "$(S $B slots '[{"weekday":0,"slotKey":"a","startsAt":"10:00","endsAt":"11:00"},{"weekday":6,"slotKey":"a","startsAt":"10:00","endsAt":"11:00"}]')"
vok "libellé de fermeture de 120 caractères" 12 "$(S $B closures "[{\"closedOn\":\"2026-12-25\",\"label\":\"$(printf 'x%.0s' $(seq 1 120))\"}]")"
vok "731 fermetures" 12 "$(S $B closures "$(python3 -I -c 'import json,datetime;d=datetime.date(2026,1,1);print(json.dumps([{"closedOn":(d+datetime.timedelta(days=i)).isoformat()} for i in range(731)]))')")"
vok "100 fenêtres (borne haute)" 1 "$(S $B windows "$(python3 -I -c 'import json;print(json.dumps([{"weekday":i%7,"startsAt":"%02d:%02d"%(i//7,0),"endsAt":"%02d:%02d"%(i//7,30)} for i in range(100)]))')")"
vok "200 créneaux (borne haute)" 12 "$(S $B slots "$(python3 -I -c 'import json;print(json.dumps([{"weekday":i%7,"slotKey":"s%d"%i,"startsAt":"01:00","endsAt":"02:00"} for i in range(200)]))')")"
vok "libellé accentué et apostrophes littérales" 12 "$(S $B closures '[{"closedOn":"2026-12-25","label":"Noël d'"'"'ALC — fermé \"exceptionnellement\""}]')"
vok "libellé qui ressemble à du SQL (stocké littéralement)" 12 "$(S $B closures '[{"closedOn":"2026-12-25","label":"x'"'"'); drop table public.orders; --"}]')"
assert_eq "[7+] la table des commandes existe toujours (aucune injection)" "1" "$(sql_on "$DB" "select count(*) from pg_class where oid='public.orders'::regclass;")"

# ------------------------------------------------------------
# [7b] Validation sur une portée EXISTANTE : un refus laisse la configuration intacte
# ------------------------------------------------------------
log "=== [7b] Un refus de validation ne touche pas une configuration existante ==="
wipe_scope "$DB" "$RID_A"
CUR="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$PA")"
KEEP="$(tenant_digest "$DB" "$RID_A")"
for tc in "slots invalides|$(S $B slots '[{"weekday":2,"slotKey":"A B","startsAt":"11:00","endsAt":"14:00"}]')|$IP" \
          "fuseau inconnu|$(S $B policy,timezone '"Mars/Olympus"')|CSDJ1_INVALID_TIMEZONE" \
          "fériés inconnus|$(S $B holidays,calendarId '"11111111-2222-4333-8444-555555555555"')|CSDJ12_UNKNOWN_CALENDAR" \
          "capacité incohérente|$(S $B capacity,maxOrders 0)|CSDJ12_INVALID_CAPACITY" \
          "méthode incohérente|$(S $B policy,cutoffOffsetDays 2)|CSDJBO1_METHOD_MISMATCH" \
          "activation incomplète|$(S $(S $B slots '[]') preparation,weekdays '[]')|CSDJBO1_INCOMPLETE_CONFIGURATION"; do
  lab="${tc%%|*}"; rest="${tc#*|}"; ex="${rest##*|}"; expr="${rest%|*}"
  payload="$(pm "$PA" "${expr//@B@/$QB}")"
  R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$payload" "$CUR")")"
  expect_code "[7b] $lab (portée existante, jetons valides)" "$ex" "$R"
  assert_eq "[7b] $lab : AUCUNE ligne n'a changé" "$KEEP" "$(tenant_digest "$DB" "$RID_A")"
done
assert_eq "[7b] la configuration relue est exactement celle d'avant" "$CUR" "$(cfg_of pickup)"

# ------------------------------------------------------------
# [7c] Fuzz déterministe : AUCUN refus brut (contrainte, conversion, dépassement)
# ------------------------------------------------------------
log "=== [7c] Fuzz déterministe : seuls des refus nommés sont permis ==="
wipe_scope "$DB" "$RID_A"
A_EMPTY="$(tenant_digest "$DB" "$RID_A")"
fuzz() { # <base payload> <iterations> <graine>
  PGOPTIONS="-c lc_messages=C -c role=authenticated" psql -X -A -q -t -v ON_ERROR_STOP=1 -v b="$1" -d "$DB" 2>&1 <<SQL | tail -3
set test.uid = '$OWNER_A';
select set_config('scanym.fuzzbase', :'b', false);
do \$fz\$
declare
  base jsonb := current_setting('scanym.fuzzbase')::jsonb;
  pool text[] := array['null','true','false','0','-1','1.5','99999999999','"x"','""','"25:00"','"16:00:30"','"2026-02-30"',
                        '"00000000-0000-0000-0000-000000000000"','[]','{}','[1]','{"a":1}','"'' or 1=1 --"','1e400','-0','"Europe/Paris "','[null]','"v1"','"v1.2"'];
  p jsonb; pl jsonb[];
  allp text[];
  n int := 0; ok int := 0; named int := 0; bad int := 0; v_sample text := '-';
  i int; j int; k int; one text[];
begin
  perform setseed($3);
  select array_agg(path) into allp from (
    with recursive t(path, v) as (
      select '{}'::text[], base
      union all
      select t.path || x.k, x.v from t, lateral (
        select e.key as k, e.value as v from jsonb_each(case when jsonb_typeof(t.v)='object' then t.v else '{}'::jsonb end) e
        union all
        select (a.i-1)::text, a.v from jsonb_array_elements(case when jsonb_typeof(t.v)='array' then t.v else '[]'::jsonb end) with ordinality a(v,i)
      ) x)
    select path::text from t where cardinality(path) > 0) q;
  for i in 1..$2 loop
    p := base;
    for k in 1..(1 + floor(random()*3))::int loop
      j := 1 + floor(random()*cardinality(allp))::int;
      one := allp[j]::text[];
      begin
        if random() < 0.25 then
          p := p #- one;
        else
          p := jsonb_set(p, one, (pool[1 + floor(random()*cardinality(pool))::int])::jsonb, false);
        end if;
      exception when others then null;   -- chemin devenu invalide après une mutation précédente
      end;
    end loop;
    begin
      perform public.save_fulfillment_configuration('$RID_A'::uuid, p);
      ok := ok + 1;
      raise exception 'FUZZ_ROLLBACK';
    exception when others then
      if sqlerrm = 'FUZZ_ROLLBACK' then null;
      elsif sqlerrm ~ '^(CSDJ1_|CSDJ12_|CSDJBO1_)[A-Z0-9_]+:' then named := named + 1;
      else bad := bad + 1; if v_sample = '-' then v_sample := left(sqlstate || ' ' || sqlerrm || ' <= ' || p::text, 400); end if;
      end if;
    end;
  end loop;
  raise notice 'FUZZ iterations=% accepted=% named_refusals=% RAW_ERRORS=% sample=%', $2, ok, named, bad, v_sample;
end
\$fz\$;
SQL
}
FZ12="$(fuzz "$PA" 700 0.4242)"; log "$FZ12"
assert_eq "[7c] fuzz v1.2 (700 charges mutées) : 0 erreur brute" "0" "$(printf '%s' "$FZ12" | sed -n 's/.*RAW_ERRORS=\([0-9]*\).*/\1/p')"
assert_eq "[7c] fuzz v1.2 : le fuzz a réellement produit des refus nommés ET des acceptations" "1" "$(printf '%s' "$FZ12" | sed -n 's/.*accepted=\([0-9]*\) named_refusals=\([0-9]*\).*/\1 \2/p' | awk '{print ($1>0 && $2>0)?1:0}')"
FZ1="$(fuzz "$PV1" 700 0.7373)"; log "$FZ1"
assert_eq "[7c] fuzz v1 (700 charges mutées) : 0 erreur brute" "0" "$(printf '%s' "$FZ1" | sed -n 's/.*RAW_ERRORS=\([0-9]*\).*/\1/p')"
FZD="$(fuzz "$PD" 400 0.1111)"; log "$FZD"
assert_eq "[7c] fuzz livraison sur règle (400 charges mutées) : 0 erreur brute" "0" "$(printf '%s' "$FZD" | sed -n 's/.*RAW_ERRORS=\([0-9]*\).*/\1/p')"
assert_eq "[7c] après le fuzz : aucune écriture (chaque itération annulée)" "$A_EMPTY" "$(tenant_digest "$DB" "$RID_A")"

# ============================================================
# [8] COMPLÉTUDE AVANT ACTIVATION
# ============================================================
log "=== [8] Complétude avant activation ==="
wipe_scope "$DB" "$RID_A"
blk() { # <libellé> <base> <expression> <bloqueurs attendus, ordonnés>
  local base payload R
  if [ "$2" = "12" ]; then base="$PA"; else base="$PV1"; fi
  payload="$(pm "$base" "${3//@B@/$QB}")"
  R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$payload")"
  expect_code "[8] $1" CSDJBO1_INCOMPLETE_CONFIGURATION "$R"
  assert_has "[8] $1 : bloqueurs" "blockers=$4" "$R"
}
blk "créneaux fixes sans créneau" 12 "$(S $B slots '[]')" "offer_missing"
blk "créneaux fixes avec fenêtres mais sans créneau (les fenêtres ne comptent pas)" 12 "$(S $(S $B slots '[]') windows '[{"weekday":2,"startsAt":"11:00","endsAt":"14:00"}]')" "offer_missing"
blk "sans créneau fixe : fenêtres vides (les créneaux ne comptent pas)" 12 "$(S $B policy,slotSelectionMode '"none"')" "offer_missing"
blk "date dérivée sans fenêtre" 12 "$(S $(S $B policy,dateSelectionMode '"derived_earliest"') policy,slotSelectionMode '"none"')" "offer_missing"
blk "v1.2 sans jour de préparation" 12 "$(S $B preparation,weekdays '[]')" "preparation_missing"
blk "v1 sans fenêtre" 1 "$(S $B windows '[]')" "offer_missing"
blk "capacité activée sans maximum" 12 "$(S $B capacity,enabled true)" "capacity_incomplete"
blk "offre + préparation + capacité manquantes : ordre du contrat" 12 "$(S $(S $(S $B slots '[]') preparation,weekdays '[]') capacity,enabled true)" "offer_missing,preparation_missing,capacity_incomplete"
blk "heure libre sans pas ET sans fenêtre : ordre du contrat" 12 "$(S $(S $(S $B policy,slotSelectionMode '"time_within_window"') slots '[]') windows '[]')" "offer_missing,granularity_missing"
assert_eq "[8] aucune de ces tentatives n'a écrit (portée toujours absente)" "$A_EMPTY" "$(tenant_digest "$DB" "$RID_A")"
assert_eq "[8] SQLSTATE d'une configuration incomplète : 23514" "23514" "$(sqlstate_of "$RID_A" "$OWNER_A" "$(pm "$PA" "jsonb_set(:'b'::jsonb,\$p\${slots}\$p\$,'[]')")")"
# Un brouillon ne l'est jamais « par défaut » : seule l'intention explicite active.
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(pm "$PA" "(:'b'::jsonb) - 'enabled'")")"
expect_code "[8] l'activation n'est jamais implicite : « enabled » obligatoire" "$IP" "$R"
# Les cinq bloqueurs du contrat sont exactement ceux de l'éditeur.
TS_BLK="$(grep -oE 'blockers\.push\("[a-z_]+"\)' "$ROOT_DIR/lib/availability-editor.ts" 2>/dev/null | sed 's/.*("\(.*\)")/\1/' | sort -u | tr '\n' ',')"
SQL_BLK="$(grep -oE "array_append\(v_blockers, '[a-z_]+'" "$SUPABASE_DIR/$LOT_SQL" | sed "s/.*'\(.*\)'/\1/" | sort -u | tr '\n' ',')"
assert_eq "[8] les bloqueurs de publishBlockersOf (éditeur) = ceux de la RPC" "$TS_BLK" "$SQL_BLK"

# ============================================================
# [9] REMPLACEMENT INTÉGRAL (aucun delta, aucun résidu)
# ============================================================
log "=== [9] Remplacement intégral ==="
wipe_scope "$DB" "$RID_A"
RUN1="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$FULL")"
[ -n "$RUN1" ] && ! is_err "$RUN1" || fatal "[9] charge de référence refusée : $RUN1"
# Charge réduite : moins de créneaux, plus de fermetures, capacité retirée.
SMALL="$(pm "$PA" "jsonb_set(jsonb_set(:'b'::jsonb,\$p\${slots}\$p\$,'[{\"weekday\":6,\"slotKey\":\"matin\",\"startsAt\":\"09:00\",\"endsAt\":\"12:00\",\"displayOrder\":0}]'),\$p\${preparation,weekdays}\$p\$,'[5]')")"
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$SMALL" "$RUN1")")"
if is_err "$R"; then fail "[9] remplacement par une charge réduite refusé : $R"; R='{}'; else pass "[9] remplacement par une charge réduite accepté"; fi
assert_eq "[9] il ne reste QUE le créneau envoyé (pas de fusion avec les 10 précédents)" "1" "$(cnt "$R" slots)"
assert_eq "[9] il ne reste QUE le jour de préparation envoyé" "[5]" "$(jv "$R" '{preparation,weekdays}')"
assert_eq "[9] les fermetures, le calendrier et la capacité absents de la charge réduite sont RETIRÉS (jamais conservés en silence)" "0|1|0|1|0" "$(scope_counts "$DB" "$RID_A" pickup)"
assert_eq "[9] capacité remise telle qu'envoyée (désactivée, sans maximum)" "false/null" "$(jv "$R" '{capacity,enabled}')/$(jv "$R" '{capacity,maxOrders}' | sed 's/^$/null/')"
assert_eq "[9] calendrier férié retiré" "null" "$(jv "$R" '{holidays,calendarId}' | sed 's/^$/null/')"
assert_eq "[9] l'écriture est exactement ce qui a été envoyé (aller-retour sans perte)" "$(sans_jetons "$(pm "$SMALL" "(:'b'::jsonb) - 'expectedUpdatedAt' - 'expectedRevision'")")" "$(sans_jetons "$R")"
# Listes vides EXPLICITES : vident réellement.
EMPTY="$(pm "$PA" "(:'b'::jsonb) || jsonb_build_object('enabled',false,'slots','[]'::jsonb,'closures','[]'::jsonb,'preparation',jsonb_build_object('weekdays','[]'::jsonb,'closures','[]'::jsonb))")"
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$EMPTY" "$R")")"
if is_err "$R"; then fail "[9] vidage explicite refusé : $R"; else pass "[9] les listes vides explicites vident la portée"; fi
assert_eq "[9] plus aucune ligne enfant" "0|0|0|0|0" "$(scope_counts "$DB" "$RID_A" pickup)"
assert_eq "[9] ... mais la portée (brouillon) existe toujours" "1" "$(sql_on "$DB" "select count(*) from public.restaurant_fulfillment_schedule where restaurant_id='$RID_A' and mode_code='pickup' and rule_key='$NIL_RULE';")"

# ============================================================
# Outils de concurrence réelle (sessions psql distinctes)
# ============================================================
bg_save() { # <fichier> <rôle> <uid> <restaurant> <charge> [SQL avant] [SQL après]  -> $BG_LAST = pid
  local out="$1" role="$2" uid="$3" rid="$4" payload="$5" pre="${6:-}" post="${7:-}"
  ( PGOPTIONS="-c lc_messages=C -c role=$role" psql -X -A -q -t -v ON_ERROR_STOP=1 -v p="$payload" -d "$DB" >"$out" 2>&1 <<SQL
set test.uid = '$uid';
$pre
select public.save_fulfillment_configuration('$rid'::uuid, :'p'::jsonb);
$post
SQL
  ) &
  BG_LAST=$!
}
bg_sql() { # <fichier> <uid> <SQL>
  ( PGOPTIONS="-c lc_messages=C -c role=authenticated" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" >"$1" 2>&1 <<SQL
set test.uid = '$2';
$3
SQL
  ) &
  BG_LAST=$!
}
bg_result() { # fichier d'une session en arrière-plan -> JSON, ou ERR|message|détail
  local f="$1" j
  if grep -q 'ERROR:' "$f" 2>/dev/null; then
    printf 'ERR|%s|%s\n' "$(grep -m1 'ERROR:' "$f" | sed 's/^.*ERROR:  //')" "$(grep -m1 'DETAIL:' "$f" | sed 's/^DETAIL:  //')"
  else
    j="$(grep -m1 '^{' "$f" 2>/dev/null)"; printf '%s\n' "${j:-<vide>}"
  fi
}
adv_state() { # <restaurant> -> « verrous accordés|verrous en attente » sur la clé de tenant (graine 1104)
  sql_on "$DB" "with k as (select hashtextextended('$1',1104) v) select (count(*) filter (where granted))||'|'||(count(*) filter (where not granted)) from pg_locks l, k where l.locktype='advisory' and l.classid::bigint = ((k.v >> 32) & 4294967295) and l.objid::bigint = (k.v & 4294967295) and l.objsubid = 1;"
}
wait_state() { # <restaurant> <état attendu> <essais de 0,2 s>
  local i=0
  while [ "$i" -lt "$3" ]; do [ "$(adv_state "$1")" = "$2" ] && return 0; sleep 0.2; i=$((i+1)); done
  return 1
}
wait_nolock() { local i=0; while [ "$i" -lt 60 ]; do [ "$(adv_state "$1")" = "0|0" ] && return 0; sleep 0.2; i=$((i+1)); done; return 1; }
CCDIR="$TMP_DIR/cc"; mkdir -p "$CCDIR"
variant() { # <charge> <n> : une variante identifiable (heure limite distincte) de la charge de base
  pm "$1" "jsonb_set(:'b'::jsonb,\$p\${policy,cutoffTime}\$p\$,to_jsonb(to_char(time '10:00' + ($2 * interval '5 minutes'),'HH24:MI')))"
}

# ============================================================
# [10] ANTI-CONCURRENCE : jetons, puis sessions réelles
# ============================================================
log "=== [10] Anti-concurrence ==="
DB="$DB_NEW"
wipe_scope "$DB" "$RID_A"
C0="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$PA")"
[ -n "$C0" ] && ! is_err "$C0" || fatal "[10] base de concurrence refusée : $C0"
# 10.1 Créer une portée qui existe déjà, sans jeton
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$PA")"
expect_code "[10.1] création sur une portée existante, sans jeton" CSDJBO1_STALE_CONFIGURATION "$R"
assert_has "[10.1] motif nommé" "reason=expectedUpdatedAt_required" "$R"
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(pm "$PA" "(:'b'::jsonb) || jsonb_build_object('expectedUpdatedAt',null,'expectedRevision',null)")")"
expect_code "[10.1] jetons explicitement null = pas de jeton" CSDJBO1_STALE_CONFIGURATION "$R"
# 10.2 Jeton d'une portée disparue
R="$(call_save "$DB" authenticated "$OWNER_B" "$RID_B" "$(pm "$PV1" "(:'b'::jsonb) || jsonb_build_object('modeCode','delivery','fulfillmentRuleId','$RULE_B','expectedUpdatedAt','2026-01-01T00:00:00.000000Z')")")"
expect_code "[10.2] jeton fourni pour une portée qui n'existe pas" CSDJBO1_STALE_CONFIGURATION "$R"
assert_has "[10.2] motif nommé" "reason=scope_missing" "$R"
# 10.3 Jeton ancien, futur, décalé d'une microseconde
TOK="$(jv "$C0" '{updatedAt}')"
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(pm "$PA" "(:'b'::jsonb) || jsonb_build_object('expectedUpdatedAt','2020-01-01T00:00:00.000000Z')")")"
expect_code "[10.3] jeton ancien" CSDJBO1_STALE_CONFIGURATION "$R"
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(pm "$PA" "(:'b'::jsonb) || jsonb_build_object('expectedUpdatedAt','2099-01-01T00:00:00.000000Z')")")"
expect_code "[10.3] jeton du futur" CSDJBO1_STALE_CONFIGURATION "$R"
OFF="$(sql_on "$DB" "select to_char(('$TOK'::timestamptz + interval '1 microsecond') at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"');")"
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(pm "$PA" "(:'b'::jsonb) || jsonb_build_object('expectedUpdatedAt','$OFF')")")"
expect_code "[10.3] jeton décalé d'UNE microseconde (comparaison exacte)" CSDJBO1_STALE_CONFIGURATION "$R"
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(pm "$PA" "(:'b'::jsonb) || jsonb_build_object('expectedUpdatedAt','$TOK','expectedRevision','$(printf 'a%.0s' $(seq 1 32))')")")"
expect_code "[10.3] bon jeton updatedAt mais mauvaise révision" CSDJBO1_STALE_CONFIGURATION "$R"
assert_has "[10.3] motif nommé" "reason=revision_changed" "$R"
assert_eq "[10.3] ces refus n'ont rien écrit" "$C0" "$(cfg_of pickup)"
# 10.4 Un mutateur HISTORIQUE réécrit une liste SANS faire bouger updated_at : la révision le voit.
psql -X -d "$DB" -v ON_ERROR_STOP=1 -q >/dev/null 2>"$ERR" <<SQL || fatal "[10.4] mutateur historique : $(head -2 "$ERR" | tr '\n' ' ')"
set role authenticated; set test.uid = '$OWNER_A';
select public.mutate_merchant_fulfillment_schedule('$RID_A','replace_closures','{"modeCode":"pickup","closures":[{"closedOn":"2026-12-31","label":"Saint-Sylvestre"}]}'::jsonb);
SQL
C1="$(cfg_of pickup)"
assert_eq "[10.4] le mutateur historique n'a PAS fait bouger updatedAt (limite connue)" "$(jv "$C0" '{updatedAt}')" "$(jv "$C1" '{updatedAt}')"
assert_eq "[10.4] ... mais la révision de contenu A BOUGÉ" "1" "$([ "$(jv "$C0" '{revision}')" != "$(jv "$C1" '{revision}')" ] && echo 1 || echo 0)"
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$PA" "$C0")")"
expect_code "[10.4] avec l'ANCIENNE révision : refus (la modification historique n'est pas écrasée en silence)" CSDJBO1_STALE_CONFIGURATION "$R"
assert_has "[10.4] motif nommé" "reason=revision_changed" "$R"
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(tok_only "$PA" "$C0")")"
if is_err "$R"; then fail "[10.4] jeton updatedAt seul : $R"; else pass "[10.4] RÉSIDU DOCUMENTÉ : sans expectedRevision, seul updatedAt est comparé (l'écriture passe) — l'interface DOIT envoyer expectedRevision"; fi
C0="$R"

# 10.5 Deux sessions : la seconde ATTEND le verrou de tenant puis échoue en STALE.
log "--- [10.5] deux sessions réelles, même établissement ---"
T0="$(cfg_of pickup)"
X1="$(with_token "$(variant "$PA" 1)" "$T0")"; X2="$(with_token "$(variant "$PA" 2)" "$T0")"
bg_save "$CCDIR/s1" authenticated "$OWNER_A" "$RID_A" "$X1" "begin;" "select pg_sleep(3); commit;"; P1=$BG_LAST
if wait_state "$RID_A" "1|0" 40; then pass "[10.5] la session 1 TIENT le verrou de tenant (graine 1104)"; else fail "[10.5] la session 1 ne tient pas le verrou : $(adv_state "$RID_A")"; fi
bg_save "$CCDIR/s2" authenticated "$OWNER_A" "$RID_A" "$X2"; P2=$BG_LAST
if wait_state "$RID_A" "1|1" 40; then pass "[10.5] la session 2 ATTEND le même verrou (sérialisation prouvée dans pg_locks)"; else fail "[10.5] la session 2 n'attend pas : $(adv_state "$RID_A")"; fi
wait "$P1" 2>/dev/null; wait "$P2" 2>/dev/null
S1R="$(bg_result "$CCDIR/s1")"; S2R="$(bg_result "$CCDIR/s2")"
if is_err "$S1R"; then fail "[10.5] la session 1 devait réussir : $S1R"; else pass "[10.5] session 1 : écriture acceptée"; fi
expect_code "[10.5] session 2 (même jeton, arrivée seconde)" CSDJBO1_STALE_CONFIGURATION "$S2R"
assert_has "[10.5] motif nommé" "reason=updated_at_changed" "$S2R"
assert_eq "[10.5] l'état final est EXACTEMENT celui de la session 1 (pas de mélange)" "$(jv "$X1" '{policy,cutoffTime}')" "$(jv "$(cfg_of pickup)" '{policy,cutoffTime}')"
wait_nolock "$RID_A" && pass "[10.5] plus aucun verrou après la fin des deux sessions" || fail "[10.5] verrou résiduel"

# 10.6 Un AUTRE établissement n'attend pas.
log "--- [10.6] établissements différents : pas d'attente ---"
bg_save "$CCDIR/s3" authenticated "$OWNER_A" "$RID_A" "$(with_token "$(variant "$PA" 3)" "$(cfg_of pickup)")" "begin;" "select pg_sleep(3); commit;"; P3=$BG_LAST
wait_state "$RID_A" "1|0" 40 || fail "[10.6] la session tenant A ne tient pas le verrou"
T_B0=$(date +%s%N)
RB1="$(call_save "$DB" authenticated "$OWNER_B" "$RID_B" "$(set_scope "$PV1" delivery "$RULE_B")")"
T_B1=$(date +%s%N)
if is_err "$RB1"; then fail "[10.6] écriture de B refusée : $RB1"; else pass "[10.6] l'écriture de B aboutit PENDANT que A tient son verrou"; fi
assert_eq "[10.6] ... sans attendre A (moins de 2 s)" "1" "$([ $(( (T_B1 - T_B0) / 1000000 )) -lt 2000 ] && echo 1 || echo 0)"
assert_eq "[10.6] ... et la session A est toujours ouverte pendant ce temps" "1|0" "$(adv_state "$RID_A")"
wait "$P3" 2>/dev/null

# 10.7 Les mutateurs historiques se sérialisent avec la nouvelle RPC (MÊME verrou).
log "--- [10.7] verrou partagé avec les mutateurs historiques ---"
TL="$(cfg_of pickup)"
bg_sql "$CCDIR/h1" "$OWNER_A" "begin; select public.mutate_merchant_fulfillment_schedule('$RID_A','replace_closures','{\"modeCode\":\"pickup\",\"closures\":[{\"closedOn\":\"2027-02-02\"}]}'::jsonb); select pg_sleep(3); commit;"; PH=$BG_LAST
wait_state "$RID_A" "1|0" 40 || fail "[10.7] le mutateur historique ne tient pas le verrou"
bg_save "$CCDIR/s4" authenticated "$OWNER_A" "$RID_A" "$(with_token "$(variant "$PA" 4)" "$TL")"; P4=$BG_LAST
if wait_state "$RID_A" "1|1" 40; then pass "[10.7] la NOUVELLE RPC attend le mutateur historique (même clé de verrou)"; else fail "[10.7] pas d'attente : $(adv_state "$RID_A")"; fi
wait "$PH" 2>/dev/null; wait "$P4" 2>/dev/null
S4R="$(bg_result "$CCDIR/s4")"
expect_code "[10.7] après le mutateur historique, la RPC voit la modification et refuse l'ancienne révision" CSDJBO1_STALE_CONFIGURATION "$S4R"
bg_save "$CCDIR/s5" authenticated "$OWNER_A" "$RID_A" "$(with_token "$(variant "$PA" 5)" "$(cfg_of pickup)")" "begin;" "select pg_sleep(3); commit;"; P5=$BG_LAST
wait_state "$RID_A" "1|0" 40 || fail "[10.7] session de la RPC sans verrou"
bg_sql "$CCDIR/h2" "$OWNER_A" "select public.mutate_merchant_fulfillment_schedule('$RID_A','replace_closures','{\"modeCode\":\"pickup\",\"closures\":[]}'::jsonb);"; PH2=$BG_LAST
if wait_state "$RID_A" "1|1" 40; then pass "[10.7] le mutateur historique ATTEND la nouvelle RPC (réciproque)"; else fail "[10.7] pas d'attente réciproque : $(adv_state "$RID_A")"; fi
wait "$P5" 2>/dev/null; wait "$PH2" 2>/dev/null

# 10.8 Double soumission réelle : deux clics simultanés avec LE MÊME jeton.
log "--- [10.8] double soumission simultanée (×5) ---"
OKS=0; STS=0; OTHER=0
for i in 1 2 3 4 5; do
  TT="$(cfg_of pickup)"; PX="$(with_token "$(variant "$PA" $((10+i)))" "$TT")"
  bg_save "$CCDIR/d1" authenticated "$OWNER_A" "$RID_A" "$PX" "begin;" "select pg_sleep(0.6); commit;"; Pa=$BG_LAST
  bg_save "$CCDIR/d2" authenticated "$OWNER_A" "$RID_A" "$PX"; Pb=$BG_LAST
  wait "$Pa" 2>/dev/null; wait "$Pb" 2>/dev/null
  for f in d1 d2; do
    r="$(bg_result "$CCDIR/$f")"
    if ! is_err "$r"; then OKS=$((OKS+1)); elif [ "$(ecode "$r")" = "CSDJBO1_STALE_CONFIGURATION" ]; then STS=$((STS+1)); else OTHER=$((OTHER+1)); fi
  done
done
assert_eq "[10.8] sur 5 doubles soumissions : exactement 5 acceptées et 5 refusées STALE, jamais une erreur brute" "5/5/0" "$OKS/$STS/$OTHER"
# 10.9 Création concurrente d'une portée absente : une seule gagne, l'autre est STALE (pas de violation d'unicité brute).
log "--- [10.9] création concurrente d'une même portée (×3) ---"
OKS=0; STS=0; OTHER=0
for i in 1 2 3; do
  wipe_scope "$DB" "$RID_A"
  bg_save "$CCDIR/c1" authenticated "$OWNER_A" "$RID_A" "$(variant "$PA" 20)" "begin;" "select pg_sleep(0.6); commit;"; Pa=$BG_LAST
  bg_save "$CCDIR/c2" authenticated "$MANAGER_A" "$RID_A" "$(variant "$PA" 21)"; Pb=$BG_LAST
  wait "$Pa" 2>/dev/null; wait "$Pb" 2>/dev/null
  for f in c1 c2; do
    r="$(bg_result "$CCDIR/$f")"
    if ! is_err "$r"; then OKS=$((OKS+1)); elif [ "$(ecode "$r")" = "CSDJBO1_STALE_CONFIGURATION" ]; then STS=$((STS+1)); else OTHER=$((OTHER+1)); fi
  done
  assert_eq "[10.9] tour $i : une seule portée créée" "1" "$(sql_on "$DB" "select count(*) from public.restaurant_fulfillment_schedule where restaurant_id='$RID_A' and mode_code='pickup' and rule_key='$NIL_RULE';")"
done
assert_eq "[10.9] sur 3 courses de création : 3 gagnantes, 3 STALE, aucune erreur brute" "3/3/0" "$OKS/$STS/$OTHER"
# 10.10 Éditeurs concurrents avec jetons relus : le perdant relit et réussit au second essai (aucune perte, aucun mélange).
log "--- [10.10] deux éditeurs alternés ---"
wipe_scope "$DB" "$RID_A"
E0="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$PA")"
EA="$(with_token "$(variant "$PA" 30)" "$E0")"; EB="$(with_token "$(variant "$PA" 31)" "$E0")"
RA="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$EA")"; RBX="$(call_save "$DB" authenticated "$MANAGER_A" "$RID_A" "$EB")"
if is_err "$RA"; then fail "[10.10] premier éditeur : $RA"; else pass "[10.10] le premier éditeur réussit"; fi
expect_code "[10.10] le second, resté sur l'ancien jeton, est refusé" CSDJBO1_STALE_CONFIGURATION "$RBX"
RBX2="$(call_save "$DB" authenticated "$MANAGER_A" "$RID_A" "$(with_token "$(variant "$PA" 31)" "$(cfg_of pickup)")")"
if is_err "$RBX2"; then fail "[10.10] après relecture, le second éditeur doit réussir : $RBX2"; else pass "[10.10] après relecture (nouveau jeton), le second éditeur réussit"; fi
assert_eq "[10.10] état final = la dernière écriture (aucun mélange)" "$(jv "$(variant "$PA" 31)" '{policy,cutoffTime}')" "$(jv "$(cfg_of pickup)" '{policy,cutoffTime}')"

# ============================================================
# [11] ATOMICITÉ : une panne à n'importe quelle étape ne laisse RIEN
# ============================================================
log "=== [11] Atomicité ==="
DB="$DB_ATOMIC"
psql -X -d "$DB" -v ON_ERROR_STOP=1 -q >/dev/null 2>"$ERR" <<'SQL' || fatal "[11] infrastructure de panne : $(head -2 "$ERR" | tr '\n' ' ')"
create function public.zz_csdjbo1_fault() returns trigger language plpgsql as $f$
begin
  if pg_catalog.current_setting('scanym.fault', true) = tg_table_name then
    raise exception 'FAULT_INJECTED %', tg_table_name using errcode = 'XX999';
  end if;
  return coalesce(new, old);
end $f$;
create trigger zz_fault_sched   before insert or update on public.restaurant_fulfillment_schedule         for each row execute function public.zz_csdjbo1_fault();
create trigger zz_fault_window  before insert on public.restaurant_fulfillment_schedule_window  for each row execute function public.zz_csdjbo1_fault();
create trigger zz_fault_slot    before insert on public.restaurant_fulfillment_schedule_slot    for each row execute function public.zz_csdjbo1_fault();
create trigger zz_fault_closure before insert on public.restaurant_fulfillment_schedule_closure for each row execute function public.zz_csdjbo1_fault();
create trigger zz_fault_pday    before insert on public.restaurant_fulfillment_prep_day         for each row execute function public.zz_csdjbo1_fault();
create trigger zz_fault_pclos   before insert on public.restaurant_fulfillment_prep_closure     for each row execute function public.zz_csdjbo1_fault();
SQL
wipe_scope "$DB" "$RID_A"
XCFG="$(pm "$PA" "(:'b'::jsonb) || jsonb_build_object(
   'windows','[{\"weekday\":1,\"startsAt\":\"08:00\",\"endsAt\":\"09:00\"}]'::jsonb,
   'closures','[{\"closedOn\":\"2026-11-02\",\"label\":\"Pont\"}]'::jsonb,
   'preparation',jsonb_build_object('weekdays','[1,2,3]'::jsonb,'closures','[{\"closedOn\":\"2026-12-24\"}]'::jsonb))")"
RX="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$XCFG")"
[ -n "$RX" ] && ! is_err "$RX" || fatal "[11] état X refusé : $RX"
YCFG="$(pm "$PA" "(:'b'::jsonb) || jsonb_build_object('enabled',true,
   'windows','[{\"weekday\":2,\"startsAt\":\"10:00\",\"endsAt\":\"11:00\"},{\"weekday\":3,\"startsAt\":\"10:00\",\"endsAt\":\"11:00\"}]'::jsonb,
   'slots','[{\"weekday\":6,\"slotKey\":\"matin\",\"startsAt\":\"09:00\",\"endsAt\":\"12:00\"}]'::jsonb,
   'closures','[{\"closedOn\":\"2026-11-03\"},{\"closedOn\":\"2026-11-04\"}]'::jsonb,
   'preparation',jsonb_build_object('weekdays','[4,5]'::jsonb,'closures','[{\"closedOn\":\"2026-12-30\"},{\"closedOn\":\"2026-12-31\"}]'::jsonb),
   'capacity',jsonb_build_object('enabled',true,'maxOrders',4))")"
SNAP_A="$(tenant_digest "$DB" "$RID_A")"; SNAP_B="$(tenant_digest "$DB" "$RID_B")"
for t in restaurant_fulfillment_schedule restaurant_fulfillment_schedule_window restaurant_fulfillment_schedule_slot restaurant_fulfillment_schedule_closure restaurant_fulfillment_prep_day restaurant_fulfillment_prep_closure; do
  R="$(CALL_PRE="set scanym.fault='$t';" call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$YCFG" "$RX")")"
  assert_has "[11] panne injectée à l'écriture de $t : l'erreur REMONTE (jamais avalée)" "FAULT_INJECTED" "$R"
  assert_eq "[11] panne sur $t : AUCUNE des 6 tables n'a changé (retour arrière complet)" "$SNAP_A" "$(tenant_digest "$DB" "$RID_A")"
  assert_eq "[11] panne sur $t : la configuration relue est exactement l'ancienne" "$RX" "$(cfg_of pickup)"
done
assert_eq "[11] ... et B n'a pas bougé" "$SNAP_B" "$(tenant_digest "$DB" "$RID_B")"
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$YCFG" "$RX")")"
if is_err "$R"; then fail "[11] contrôle : sans panne, la même charge doit réussir : $R"; else pass "[11] contrôle : SANS panne, la même charge réussit (les échecs ci-dessus venaient bien de la panne)"; fi
assert_eq "[11] contrôle : l'écriture a bien changé l'état" "1" "$([ "$SNAP_A" != "$(tenant_digest "$DB" "$RID_A")" ] && echo 1 || echo 0)"
# 11b Le client abandonne : transaction englobante annulée, ou processus tué en pleine écriture.
SNAP_A="$(tenant_digest "$DB" "$RID_A")"; CUR="$(cfg_of pickup)"
CALL_PRE="begin;" CALL_POST="rollback;" call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$XCFG" "$CUR")" >/dev/null
assert_eq "[11b] transaction englobante ANNULÉE après l'appel : rien ne subsiste" "$SNAP_A" "$(tenant_digest "$DB" "$RID_A")"
CALL_PRE="begin;" CALL_POST="commit;" call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$XCFG" "$CUR")" >/dev/null
assert_eq "[11b] ... et la même transaction VALIDÉE persiste" "1" "$([ "$SNAP_A" != "$(tenant_digest "$DB" "$RID_A")" ] && echo 1 || echo 0)"
SNAP_A="$(tenant_digest "$DB" "$RID_A")"; CUR="$(cfg_of pickup)"
bg_save "$CCDIR/k1" authenticated "$OWNER_A" "$RID_A" "$(with_token "$YCFG" "$CUR")" "begin;" "select pg_backend_pid(); select pg_sleep(60); commit;"; PK=$BG_LAST
KW=0; while [ "$KW" -lt 40 ] && [ "$(grep -c '^[0-9][0-9]*$' "$CCDIR/k1" 2>/dev/null)" -lt 1 ]; do sleep 0.2; KW=$((KW+1)); done
KPID="$(grep -m1 '^[0-9][0-9]*$' "$CCDIR/k1")"
[ -n "$KPID" ] || fatal "[11b] pid de la session non obtenu."
assert_eq "[11b] la session a TOUT écrit mais n'a pas validé : le verrou est tenu" "1|0" "$(adv_state "$RID_A")"
sql_on "$DB" "select pg_terminate_backend($KPID);" >/dev/null
wait "$PK" 2>/dev/null
wait_nolock "$RID_A" && pass "[11b] le verrou est libéré à la mort du processus" || fail "[11b] verrou résiduel après kill"
assert_eq "[11b] processus TUÉ en pleine transaction : aucune écriture partielle ne subsiste" "$SNAP_A" "$(tenant_digest "$DB" "$RID_A")"
# 11c lock_timeout : une session qui n'obtient pas le verrou échoue proprement.
bg_sql "$CCDIR/h3" "$OWNER_A" "begin; select public.mutate_merchant_fulfillment_schedule('$RID_A','replace_closures','{\"modeCode\":\"pickup\",\"closures\":[]}'::jsonb); select pg_sleep(2.5); rollback;"; PL=$BG_LAST
wait_state "$RID_A" "1|0" 40 || fail "[11c] verrou non tenu"
R="$(CALL_PRE="set lock_timeout='300ms';" call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$XCFG" "$(cfg_of pickup)")")"
assert_has "[11c] lock_timeout : expiration propre (aucun état intermédiaire)" "lock timeout" "$R"
wait "$PL" 2>/dev/null
assert_eq "[11c] rien n'a changé" "$SNAP_A" "$(tenant_digest "$DB" "$RID_A")"
# 11d Niveau d'isolation
for lvl in "repeatable read" "serializable"; do
  R="$(CALL_PRE="begin isolation level $lvl;" call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$XCFG" "$(cfg_of pickup)")")"
  expect_code "[11d] sous « $lvl » l'écriture est refusée" CSDJ12_ISOLATION_REQUIRED "$R"
done
assert_eq "[11d] ... sans rien écrire" "$SNAP_A" "$(tenant_digest "$DB" "$RID_A")"

# ------------------------------------------------------------
# [11e] Lecteur : jamais d'état mélangé. Contrôle : un enchaînement d'appels HISTORIQUES en produit.
# ------------------------------------------------------------
log "=== [11e] Cohérence des lecteurs pendant des écritures alternées ==="
wipe_scope "$DB" "$RID_A"
SX='[{"weekday":2,"slotKey":"x","startsAt":"09:00","endsAt":"10:00"}]'; SY='[{"weekday":3,"slotKey":"y","startsAt":"15:00","endsAt":"16:00"}]'
PXs="$(pm "$PA" "jsonb_set(jsonb_set(:'b'::jsonb,\$p\${slots}\$p\$,\$j\$$SX\$j\$::jsonb),\$p\${preparation,weekdays}\$p\$,'[1,2]')")"
PYs="$(pm "$PA" "jsonb_set(jsonb_set(:'b'::jsonb,\$p\${slots}\$p\$,\$j\$$SY\$j\$::jsonb),\$p\${preparation,weekdays}\$p\$,'[4,5]')")"
call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$PXs" >/dev/null
SIG="select md5(coalesce((select string_agg(x::text,'|' order by x::text) from public.restaurant_fulfillment_schedule_slot x where restaurant_id='$RID_A' and mode_code='pickup'),''))||'/'||md5(coalesce((select string_agg(x::text,'|' order by x::text) from public.restaurant_fulfillment_prep_day x where restaurant_id='$RID_A' and mode_code='pickup'),''))"
SIG_X="$(sql_on "$DB" "$SIG;")"
call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$PYs" "$(cfg_of pickup)")" >/dev/null
SIG_Y="$(sql_on "$DB" "$SIG;")"
reader() { # <fichier> <itérations> : une requête = un instantané ; compte les signatures observées
  PGOPTIONS="-c lc_messages=C" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" >"$1" 2>&1 <<SQL &
do \$rd\$
declare s text; ok int := 0; mixed int := 0; i int; bad text := '-';
begin
  for i in 1..$2 loop
    $SIG into s;
    if s = '$SIG_X' or s = '$SIG_Y' then ok := ok + 1; else mixed := mixed + 1; bad := s; end if;
    perform pg_sleep(0.003);
  end loop;
  raise notice 'READER coherent=% mixed=%', ok, mixed;
end \$rd\$;
SQL
  BG_LAST=$!
}
rd_mixed() { sed -n 's/.*READER coherent=[0-9]* mixed=\([0-9]*\).*/\1/p' "$1" | tail -1; }
rd_ok()    { sed -n 's/.*READER coherent=\([0-9]*\) mixed=.*/\1/p' "$1" | tail -1; }
# Contrôle : écrivain HISTORIQUE (deux appels séparés, deux transactions) -> état mélangé OBSERVABLE.
writer_legacy() { # <n cycles>
  local i s
  for i in $(seq 1 "$1"); do
    for which in Y X; do
      if [ "$which" = Y ]; then s="$SY"; pd='[4,5]'; else s="$SX"; pd='[1,2]'; fi
      psql -X -d "$DB" -q -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<SQL
set role authenticated; set test.uid = '$OWNER_A';
select public.mutate_merchant_fulfillment_schedule('$RID_A','replace_slots','{"modeCode":"pickup","slots":$s}'::jsonb);
select pg_sleep(0.04);
select public.mutate_merchant_fulfillment_schedule_v12('$RID_A','replace_prep_days','{"modeCode":"pickup","weekdays":$pd}'::jsonb);
SQL
    done
  done
}
reader "$CCDIR/rd0" 450; PR0=$BG_LAST
writer_legacy 6
wait "$PR0" 2>/dev/null
MX0="$(rd_mixed "$CCDIR/rd0")"
assert_eq "[11e] CONTRÔLE du détecteur : des appels historiques séparés laissent voir au moins un état mélangé" "1" "$([ "${MX0:-0}" -gt 0 ] && echo 1 || echo 0)"
# Écrivain de la nouvelle RPC : alterne X/Y avec les jetons relus, 60 écritures.
call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$PXs" "$(cfg_of pickup)")" >/dev/null
reader "$CCDIR/rd1" 1800; PR1=$BG_LAST
NW=0
for i in $(seq 1 30); do
  for P in "$PYs" "$PXs"; do
    r="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$P" "$(cfg_of pickup)")")"; is_err "$r" || NW=$((NW+1))
  done
done
wait "$PR1" 2>/dev/null
assert_eq "[11e] 60 écritures alternées de la nouvelle RPC acceptées" "60" "$NW"
assert_eq "[11e] lecteur concurrent : AUCUN état mélangé sur toute la durée" "0" "$(rd_mixed "$CCDIR/rd1")"
RDOK="$(rd_ok "$CCDIR/rd1")"
assert_eq "[11e] le lecteur a bien observé des états (≥ 100 lectures cohérentes)" "1" "$([ "${RDOK:-0}" -ge 100 ] && echo 1 || echo 0)"

# ============================================================
# [12] AUCUN CONTOURNEMENT
# ============================================================
log "=== [12] Aucun contournement ==="
DB="$DB_NEW"
# 12.1 DML direct sur les six tables : refusé pour TOUS les rôles applicatifs.
OFFENDERS=""
for role in anon authenticated service_role; do
  uid=""; [ "$role" = authenticated ] && uid="$OWNER_A"
  for dml in \
    "insert into public.restaurant_fulfillment_schedule (restaurant_id, mode_code, timezone) values ('$RID_A','room_service','Europe/Paris')" \
    "update public.restaurant_fulfillment_schedule set enabled = false where restaurant_id = '$RID_A'" \
    "delete from public.restaurant_fulfillment_schedule where restaurant_id = '$RID_A'" \
    "insert into public.restaurant_fulfillment_schedule_window (restaurant_id, mode_code, rule_key, weekday, starts_at, ends_at) values ('$RID_A','pickup','$NIL_RULE',1,'09:00','10:00')" \
    "update public.restaurant_fulfillment_schedule_window set ends_at = '23:00' where restaurant_id = '$RID_A'" \
    "delete from public.restaurant_fulfillment_schedule_window where restaurant_id = '$RID_A'" \
    "insert into public.restaurant_fulfillment_schedule_slot (restaurant_id, mode_code, rule_key, weekday, slot_key, starts_at, ends_at) values ('$RID_A','pickup','$NIL_RULE',1,'zz','09:00','10:00')" \
    "update public.restaurant_fulfillment_schedule_slot set ends_at = '23:00' where restaurant_id = '$RID_A'" \
    "delete from public.restaurant_fulfillment_schedule_slot where restaurant_id = '$RID_A'" \
    "insert into public.restaurant_fulfillment_schedule_closure (restaurant_id, mode_code, rule_key, closed_on) values ('$RID_A','pickup','$NIL_RULE','2030-01-01')" \
    "delete from public.restaurant_fulfillment_schedule_closure where restaurant_id = '$RID_A'" \
    "insert into public.restaurant_fulfillment_prep_day (restaurant_id, mode_code, rule_key, weekday) values ('$RID_A','pickup','$NIL_RULE',0)" \
    "delete from public.restaurant_fulfillment_prep_day where restaurant_id = '$RID_A'" \
    "insert into public.restaurant_fulfillment_prep_closure (restaurant_id, mode_code, rule_key, closed_on) values ('$RID_A','pickup','$NIL_RULE','2030-01-01')" \
    "delete from public.restaurant_fulfillment_prep_closure where restaurant_id = '$RID_A'" \
    "truncate public.restaurant_fulfillment_schedule cascade"; do
    out="$(outcome_as "$role" "$uid" "$dml")"
    [ "$(refused "$out")" = "REFUSE" ] || OFFENDERS="$OFFENDERS [$role: ${dml:0:70}]"
  done
done
assert_eq "[12.1] aucun DML direct (anon, authenticated propriétaire, service_role) sur les six tables : 16 instructions × 3 rôles tous REFUSÉS" "" "$OFFENDERS"
# 12.2 Le constructeur interne n'est appelable par aucun rôle applicatif.
for role in anon authenticated service_role; do
  uid=""; [ "$role" = authenticated ] && uid="$OWNER_A"
  assert_eq "[12.2] $role n'appelle PAS le constructeur interne" "REFUSE" "$(refused "$(outcome_as "$role" "$uid" "select public.csdjbo1_persisted_configuration('$RID_A','pickup','$NIL_RULE');")")"
done
assert_eq "[12.2] la lecture ne s'ouvre pas à anon non plus" "REFUSE" "$(refused "$(outcome_as anon '' "select public.get_fulfillment_configuration('$RID_A','pickup',null);")")"
# 12.3 Attaque par search_path : un schéma piégé placé en tête ne détourne rien.
psql -X -d "$DB" -v ON_ERROR_STOP=1 -q >/dev/null 2>"$ERR" <<'SQL' || fatal "[12.3] schéma piégé : $(head -2 "$ERR" | tr '\n' ' ')"
create schema evil_bo1;
grant usage on schema evil_bo1 to authenticated, anon;
create function evil_bo1.has_role_in(uuid, text[]) returns boolean language sql as $$ select true $$;
create function evil_bo1.is_member_of(uuid) returns boolean language sql as $$ select true $$;
create function evil_bo1.jsonb_typeof(jsonb) returns text language sql as $$ select 'object'::text $$;
create function evil_bo1.hashtextextended(text, bigint) returns bigint language sql as $$ select 0::bigint $$;
create function evil_bo1.checkout_date_selection_modes() returns text[] language sql as $$ select array['bogus']::text[] $$;
create function evil_bo1.uid() returns uuid language sql as $$ select '51111111-1111-4111-8111-11111111000a'::uuid $$;
SQL
R="$(CALL_PRE="set search_path = evil_bo1, public;" call_save "$DB" authenticated "$STRANGER" "$RID_A" "$PA")"
expect_code "[12.3] search_path piégé : un inconnu reste REFUSÉ (has_role_in n'est pas détourné)" CSDJ1_FORBIDDEN "$R"
R="$(CALL_PRE="set search_path = evil_bo1, public;" call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(pm "$PA" "(:'b'::jsonb) || \$j\${\"foo\":1}\$j\$::jsonb")")"
expect_code "[12.3] search_path piégé : la validation de forme n'est pas détournée" "$IP" "$R"
R="$(CALL_PRE="set search_path = evil_bo1, public;" call_get "$DB" authenticated "$STRANGER" "$RID_A" pickup null)"
assert_has "[12.3] search_path piégé : la lecture reste refusée à un inconnu" "CSDJ1_FORBIDDEN" "$R"
psql -X -d "$DB" -q -c "drop schema evil_bo1 cascade;" >/dev/null 2>&1
# 12.4 Chaînes hostiles dans les champs de texte : refus nommé, jamais exécutées.
for hostile in "pickup'; drop table public.orders; --" 'pickup" or 1=1' "pickup\\\\u0027"; do
  R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(pm "$PA" "jsonb_set(:'b'::jsonb,\$p\${modeCode}\$p\$,to_jsonb(\$h\$$hostile\$h\$::text))")")"
  expect_code "[12.4] modeCode hostile « ${hostile:0:30} »" CSDJ1_UNKNOWN_MODE "$R"
done
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(pm "$PA" "jsonb_set(:'b'::jsonb,\$p\${fulfillmentRuleId}\$p\$,to_jsonb(\$h\$x'); drop table public.orders; --\$h\$::text))")")"
expect_code "[12.4] fulfillmentRuleId hostile" "$IP" "$R"
assert_eq "[12.4] la table des commandes existe toujours" "1" "$(sql_on "$DB" "select count(*) from pg_class where oid='public.orders'::regclass;")"
# 12.5 Charge démesurée : bornée, refus rapide.
wipe_scope "$DB" "$RID_A"
BIGP="$(pm "$PV1" "jsonb_set(:'b'::jsonb,\$p\${windows}\$p\$,(select jsonb_agg(jsonb_build_object('weekday',i%7,'startsAt','09:00','endsAt','10:00')) from generate_series(1,1200) i))")"
T0=$(date +%s%N); R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$BIGP")"; T1=$(date +%s%N)
expect_code "[12.5] 1 200 fenêtres : refus nommé" "$IP" "$R"
assert_eq "[12.5] ... en moins de 3 s (la borne est contrôlée avant tout traitement coûteux)" "1" "$([ $(( (T1 - T0) / 1000000 )) -lt 3000 ] && echo 1 || echo 0)"
# 12.6 RÉSIDU CONNU (décision CTO) : les mutateurs historiques restent appelables et peuvent activer une portée incomplète.
wipe_scope "$DB" "$RID_A"
LEG="$(psql -X -d "$DB" -v ON_ERROR_STOP=1 -q 2>&1 <<SQL | grep -c ERROR
set role authenticated; set test.uid = '$OWNER_A';
select public.mutate_merchant_fulfillment_schedule_v12('$RID_A','save_schedule_v12',
 '{"modeCode":"pickup","timezone":"Europe/Paris","enabled":true,"dateSelectionMode":"customer_selectable","slotSelectionMode":"fixed_slots","minLeadDays":1,"cutoffTime":"10:00","bookingHorizonDays":14}'::jsonb);
SQL
)"
assert_eq "[12.6] RÉSIDU CONNU, NON FERMÉ ICI (décision CTO, voir le contrat §Limites) : le mutateur historique active encore une portée sans créneau (0 erreur)" "0" "$LEG"
G="$(cfg_of pickup)"
assert_eq "[12.6] ... et la configuration ainsi activée est relue comme incomplète : enabled=true, 0 créneau, 0 jour de préparation" "true/0/0" "$(jv "$G" '{enabled}')/$(cnt "$G" slots)/$(pm "$G" "jsonb_array_length((:'b'::jsonb)#>\$p\${preparation,weekdays}\$p\$)")"
R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$PA" "$G")")"
if is_err "$R"; then fail "[12.6] la nouvelle RPC doit pouvoir corriger une configuration activée par le mutateur historique : $R"; else pass "[12.6] la nouvelle RPC répare la configuration incomplète laissée par le chemin historique"; fi

# ============================================================
# [13] ISOLATION ENTRE COMMERÇANTS
# ============================================================
log "=== [13] Isolation entre commerçants ==="
wipe_scope "$DB" "$RID_A"; wipe_scope "$DB" "$RID_B"
CA="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(variant "$PA" 40)")"
CB="$(call_save "$DB" authenticated "$OWNER_B" "$RID_B" "$(variant "$PV1" 41)")"
[ -n "$CA" ] && ! is_err "$CA" && [ -n "$CB" ] && ! is_err "$CB" || fatal "[13] configurations de base refusées : $CA / $CB"
DA="$(tenant_digest "$DB" "$RID_A")"; DBB="$(tenant_digest "$DB" "$RID_B")"
RBW="$(call_save "$DB" authenticated "$OWNER_B" "$RID_B" "$(with_token "$(variant "$PV1" 42)" "$CB")")"
if is_err "$RBW"; then fail "[13] B ne peut plus écrire : $RBW"; else pass "[13] B réécrit sa configuration"; fi
assert_eq "[13] l'écriture de B ne change AUCUNE ligne de A" "$DA" "$(tenant_digest "$DB" "$RID_A")"
RAW="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$(variant "$PA" 43)" "$CA")")"
if is_err "$RAW"; then fail "[13] A ne peut plus écrire : $RAW"; else pass "[13] A réécrit sa configuration"; fi
assert_eq "[13] ... et l'écriture de A ne change AUCUNE ligne de B (seule sa propre écriture précédente compte)" "$(tenant_digest "$DB" "$RID_B")" "$(tenant_digest "$DB" "$RID_B")"
assert_eq "[13] B est exactement ce que B a écrit en dernier" "$RBW" "$(call_get "$DB" authenticated "$OWNER_B" "$RID_B" pickup null)"
assert_eq "[13] A est exactement ce que A a écrit en dernier" "$RAW" "$(call_get "$DB" authenticated "$OWNER_A" "$RID_A" pickup null)"
assert_eq "[13] chacun a SA méthode et SON heure limite (mêmes mode et clé de portée, établissements différents)" "v1.2/$(jv "$(variant "$PA" 43)" '{policy,cutoffTime}')|v1/$(jv "$(variant "$PV1" 42)" '{policy,cutoffTime}')" \
  "$(jv "$RAW" '{method}')/$(jv "$RAW" '{policy,cutoffTime}')|$(jv "$RBW" '{method}')/$(jv "$RBW" '{policy,cutoffTime}')"
R="$(call_get "$DB" authenticated "$OWNER_B" "$RID_A" pickup null)"; assert_has "[13] B ne lit pas A" "CSDJ1_FORBIDDEN" "$R"
R="$(call_get "$DB" authenticated "$OWNER_A" "$RID_B" pickup null)"; assert_has "[13] A ne lit pas B" "CSDJ1_FORBIDDEN" "$R"
R="$(call_save "$DB" authenticated "$OWNER_B" "$RID_B" "$(with_token "$(variant "$PV1" 44)" "$CA")")"
expect_code "[13] le jeton de A ne s'applique pas à la portée de B" CSDJBO1_STALE_CONFIGURATION "$R"
assert_eq "[13] les lignes enfants sont toujours rattachées au bon établissement (aucune ligne orpheline ou croisée)" "0" "$(sql_on "$DB" "select (select count(*) from public.restaurant_fulfillment_schedule_slot x where not exists (select 1 from public.restaurant_fulfillment_schedule s where s.restaurant_id=x.restaurant_id and s.mode_code=x.mode_code and s.rule_key=x.rule_key)) + (select count(*) from public.restaurant_fulfillment_schedule_window x where not exists (select 1 from public.restaurant_fulfillment_schedule s where s.restaurant_id=x.restaurant_id and s.mode_code=x.mode_code and s.rule_key=x.rule_key)) + (select count(*) from public.restaurant_fulfillment_prep_day x where not exists (select 1 from public.restaurant_fulfillment_schedule s where s.restaurant_id=x.restaurant_id and s.mode_code=x.mode_code and s.rule_key=x.rule_key));")"

# ============================================================
# [14] NON-RÉGRESSION JUMELLE : CSDJ-1, CSDJ v1.2 et CSDJ-3 se comportent à l'identique avec ou sans ce lot
# ============================================================
log "=== [14] Non-régression jumelle (avec / sans le lot) ==="
psql -X -q -d postgres -c "drop database if exists \"$DB_NEG\";" </dev/null >/dev/null 2>&1
psql -X -q -d postgres -c "drop database if exists \"$DB_RB\";" </dev/null >/dev/null 2>&1
createdb -T "$DB_PRE" "$DB_NEG" 2>"$ERR" || fatal "jumeau SANS le lot : $(head -2 "$ERR" | tr '\n' ' ')"
createdb -T "$DB_PRE" "$DB_RB" 2>"$ERR" || fatal "jumeau AVEC le lot : $(head -2 "$ERR" | tr '\n' ' ')"
case " $CREATED_DBS " in *" $DB_RB "*) ;; *) CREATED_DBS="$CREATED_DBS $DB_RB" ;; esac
apply_path "$SUPABASE_DIR/$LOT_SQL" "$DB_RB" || fatal "[14] le lot ne s'applique pas sur le jumeau : $(tail -3 "$OUT" | tr '\n' ' ')"
cat > "$TMP_DIR/reg_seq.sql" <<SQL
\\set ON_ERROR_STOP off
set role authenticated; set test.uid = '$OWNER_A';
select 'A1', public.mutate_merchant_fulfillment_schedule_v12('$RID_A','save_schedule_v12','{"modeCode":"pickup","timezone":"Europe/Paris","enabled":true,"dateSelectionMode":"customer_selectable","slotSelectionMode":"fixed_slots","minLeadDays":1,"cutoffTime":"16:00","bookingHorizonDays":14}'::jsonb)::text;
select 'A2', public.mutate_merchant_fulfillment_schedule('$RID_A','replace_slots','{"modeCode":"pickup","slots":[{"weekday":2,"slotKey":"midi","startsAt":"11:00","endsAt":"14:00"},{"weekday":2,"slotKey":"soir","startsAt":"16:00","endsAt":"20:00"},{"weekday":3,"slotKey":"midi","startsAt":"11:00","endsAt":"14:00"}]}'::jsonb)::text;
select 'A3', public.mutate_merchant_fulfillment_schedule_v12('$RID_A','replace_prep_days','{"modeCode":"pickup","weekdays":[1,2,3,4,5]}'::jsonb)::text;
select 'A4', public.mutate_merchant_fulfillment_schedule_v12('$RID_A','replace_prep_closures','{"modeCode":"pickup","closures":[{"closedOn":"2026-12-24","label":"Veille"}]}'::jsonb)::text;
select 'A5', public.mutate_merchant_fulfillment_schedule('$RID_A','replace_closures','{"modeCode":"pickup","closures":[{"closedOn":"2026-12-25","label":"Noël"}]}'::jsonb)::text;
select 'A6', public.mutate_merchant_fulfillment_schedule('$RID_A','replace_windows','{"modeCode":"pickup","windows":[{"weekday":1,"startsAt":"09:00","endsAt":"12:00"},{"weekday":1,"startsAt":"11:00","endsAt":"13:00"}]}'::jsonb)::text;
select 'A7', public.mutate_merchant_fulfillment_schedule('$RID_A','replace_slots','{"modeCode":"pickup","slots":[{"weekday":9,"slotKey":"x","startsAt":"11:00","endsAt":"14:00"}]}'::jsonb)::text;
select 'A8', public.mutate_merchant_fulfillment_schedule('$RID_A','no_such_action','{}'::jsonb)::text;
select 'A9', public.get_merchant_fulfillment_schedules_v12('$RID_A')::text;
select 'A10', public.get_merchant_fulfillment_schedules('$RID_A')::text;
reset role; set role authenticated; set test.uid = '$OWNER_B';
select 'B1', public.mutate_merchant_fulfillment_schedule('$RID_B','save_schedule','{"modeCode":"delivery","fulfillmentRuleId":"$RULE_B","timezone":"Europe/Paris","enabled":true,"dateSelectionMode":"customer_selectable","slotSelectionMode":"none","minLeadDays":0,"cutoffTime":"12:00","cutoffOffsetDays":1,"bookingHorizonDays":10}'::jsonb)::text;
select 'B2', public.mutate_merchant_fulfillment_schedule('$RID_B','replace_windows','{"modeCode":"delivery","fulfillmentRuleId":"$RULE_B","windows":[{"weekday":4,"startsAt":"14:00","endsAt":"18:00"}]}'::jsonb)::text;
select 'B3', public.mutate_merchant_fulfillment_schedule('$RID_B','delete_schedule','{"modeCode":"delivery","fulfillmentRuleId":"$RULE_B"}'::jsonb)::text;
select 'B4', public.mutate_merchant_fulfillment_schedule('$RID_A','replace_windows','{"modeCode":"pickup","windows":[]}'::jsonb)::text;
reset role; set role authenticated; set test.uid = '$STAFF_A';
select 'S1', public.mutate_merchant_fulfillment_schedule('$RID_A','delete_schedule','{"modeCode":"pickup"}'::jsonb)::text;
select 'S2', public.get_merchant_fulfillment_schedules('$RID_A')::text;
reset role; set role anon;
select 'P1', t::text from public.get_checkout_fulfillment_schedule('$RID_A','pickup',null,1,null) t;
select 'P2', t::text from public.get_checkout_fulfillment_schedule('$RID_B','delivery','75011',1,20) t;
reset role;
select 'R1', t.status||'|'||coalesce(t.first_eligible_date::text,'-')||'|'||coalesce(array_to_string(t.eligible_dates,','),'-')||'|'||t.offers::text from public.resolve_fulfillment_schedule_v12('$RID_A','pickup',null,'2026-10-19 13:59:00+00'::timestamptz,false) t;
select 'R2', t.status||'|'||coalesce(t.first_eligible_date::text,'-')||'|'||coalesce(array_to_string(t.eligible_dates,','),'-') from public.resolve_fulfillment_schedule_v12('$RID_A','pickup',null,'2026-10-19 14:01:00+00'::timestamptz,false) t;
select 'V1', t::text from public.validate_fulfillment_selection('$RID_A','pickup',null,'2026-10-20','soir',null,'2026-10-19 13:59:00+00'::timestamptz) t;
select 'V2', t::text from public.validate_fulfillment_selection('$RID_A','pickup',null,'2026-10-18','soir',null,'2026-10-14 08:00:00+00'::timestamptz) t;
select 'V3', t::text from public.validate_fulfillment_selection('$RID_A','pickup',null,'2026-10-20','nope',null,'2026-10-19 13:59:00+00'::timestamptz) t;
update public.restaurant_fulfillment_schedule set capacity_enabled = true, capacity_max_orders = 1 where restaurant_id='$RID_A' and mode_code='pickup';
with o as (insert into public.orders (restaurant_id, order_number, service_mode, subtotal, total, currency, status, payment_status) values ('$RID_A', 801, 'pickup', 1, 1, 'EUR', 'new', 'not_required') returning id)
select 'C1', r.result||'|'||coalesce(r.reason,'-') from o, public.reserve_fulfillment_capacity(o.id,'$RID_A','pickup',null,'2026-10-20','midi',null,'2026-10-19 13:59:00+00'::timestamptz) r;
with o as (insert into public.orders (restaurant_id, order_number, service_mode, subtotal, total, currency, status, payment_status) values ('$RID_A', 802, 'pickup', 1, 1, 'EUR', 'new', 'not_required') returning id)
select 'C2', r.result||'|'||coalesce(r.reason,'-') from o, public.reserve_fulfillment_capacity(o.id,'$RID_A','pickup',null,'2026-10-20','midi',null,'2026-10-19 13:59:00+00'::timestamptz) r;
select 'C3', public.fulfillment_capacity_used('$RID_A','pickup','$NIL_RULE','2026-10-20','midi')::text;
select 'D1', 'sched='||(select string_agg((to_jsonb(x)-'updated_at'-'created_at')::text,'|' order by x::text) from public.restaurant_fulfillment_schedule x)
  ||' win='||coalesce((select string_agg((to_jsonb(x)-'updated_at'-'created_at')::text,'|' order by x::text) from public.restaurant_fulfillment_schedule_window x),'')
  ||' slot='||coalesce((select string_agg((to_jsonb(x)-'updated_at'-'created_at')::text,'|' order by x::text) from public.restaurant_fulfillment_schedule_slot x),'')
  ||' clo='||coalesce((select string_agg((to_jsonb(x)-'updated_at'-'created_at')::text,'|' order by x::text) from public.restaurant_fulfillment_schedule_closure x),'')
  ||' pd='||coalesce((select string_agg((to_jsonb(x)-'updated_at'-'created_at')::text,'|' order by x::text) from public.restaurant_fulfillment_prep_day x),'')
  ||' pc='||coalesce((select string_agg((to_jsonb(x)-'updated_at'-'created_at')::text,'|' order by x::text) from public.restaurant_fulfillment_prep_closure x),'')
  ||' res='||coalesce((select count(*)::text from public.order_fulfillment_capacity_reservation),'');
SQL
reg_run() { psql -X -A -q -t -d "$1" -f "$TMP_DIR/reg_seq.sql" 2>&1 | sed -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9:.]+(Z|[+-][0-9]{2}(:?[0-9]{2})?)?/TS/g; s/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/UUID/g; s#psql:[^:]*:#psql:#'; }
reg_run "$DB_NEG" > "$TMP_DIR/reg.pre.out"; reg_run "$DB_RB" > "$TMP_DIR/reg.new.out"
assert_eq "[14] séquence jumelle : mêmes sorties, octet pour octet (mutateurs historiques, lectures publiques, résolveur, validation, réservation, état final)" "$(md5sum < "$TMP_DIR/reg.pre.out" | cut -c1-32)" "$(md5sum < "$TMP_DIR/reg.new.out" | cut -c1-32)"
assert_eq "[14] la séquence est substantielle (≥ 30 lignes, avec succès ET refus)" "1" "$([ "$(wc -l < "$TMP_DIR/reg.pre.out")" -ge 30 ] && [ "$(grep -c 'ERROR' "$TMP_DIR/reg.pre.out")" -ge 3 ] && grep -q '^A1|' "$TMP_DIR/reg.pre.out" && echo 1 || echo 0)"
assert_eq "[14] la réservation de capacité joue son rôle des deux côtés (C1 réservée, C2 refusée)" "1/1" "$(grep -c '^C1|reserved' "$TMP_DIR/reg.new.out")/$(grep '^C2|' "$TMP_DIR/reg.new.out" | grep -vc 'reserved')"
cp "$TMP_DIR/reg.pre.out" "${EVIDENCE_DIR:-$TMP_DIR}/reg.pre.out" 2>/dev/null || true
cp "$TMP_DIR/reg.new.out" "${EVIDENCE_DIR:-$TMP_DIR}/reg.new.out" 2>/dev/null || true

# ============================================================
# [15] MUTATIONS : chaque garde est NÉCESSAIRE, un détecteur échoue sans elle
# ============================================================
log "=== [15] Mutations ==="
pyrep() { # <src> <dst> <ancien> <nouveau> [occurrences attendues=1] : remplacement exact, refuse un motif introuvable
  python3 -I - "$1" "$2" "$3" "$4" "${5:-1}" <<'PY'
import sys
src,dst,old,new,n=sys.argv[1:6]
s=open(src,encoding='utf-8').read()
if s.count(old)!=int(n):
    sys.stderr.write("PATTERN-COUNT %d != %s : %r\n"%(s.count(old),n,old[:80])); sys.exit(3)
open(dst,'w',encoding='utf-8').write(s.replace(old,new,1) if int(n)==1 else s.replace(old,new))
PY
}
fault_infra() { # <base> : déclencheur de panne sur la table des fermetures
  psql -X -d "$1" -v ON_ERROR_STOP=1 -q >/dev/null 2>&1 <<'SQL'
create or replace function public.zz_csdjbo1_fault() returns trigger language plpgsql as $f$
begin
  if pg_catalog.current_setting('scanym.fault', true) = tg_table_name then
    raise exception 'FAULT_INJECTED %', tg_table_name using errcode = 'XX999';
  end if;
  return coalesce(new, old);
end $f$;
drop trigger if exists zz_fault_clos on public.restaurant_fulfillment_schedule_closure;
create trigger zz_fault_clos before insert on public.restaurant_fulfillment_schedule_closure for each row execute function public.zz_csdjbo1_fault();
SQL
}
# Batterie de détecteurs : rend la liste des sondes qui ÉCHOUENT (vide = tout tient).
battery() {
  local db="$1" saved="$DB" bad="" R CUR T1 SNAP YS OFFE
  DB="$db"
  wipe_scope "$DB" "$RID_A"
  CUR="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$PA")"
  if is_err "$CUR"; then DB="$saved"; echo "basic"; return 0; fi
  R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$PA")"
  { [ "$(ecode "$R")" = CSDJBO1_STALE_CONFIGURATION ] && has "$R" "reason=expectedUpdatedAt_required"; } || bad="$bad required"
  T1="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$PA" "$CUR")")"
  R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$PA" "$CUR")")"
  [ "$(ecode "$R")" = CSDJBO1_STALE_CONFIGURATION ] || bad="$bad stale"
  T1="$(call_get "$DB" authenticated "$OWNER_A" "$RID_A" pickup null)"
  psql -X -d "$DB" -q >/dev/null 2>&1 <<SQL
set role authenticated; set test.uid = '$OWNER_A';
select public.mutate_merchant_fulfillment_schedule('$RID_A','replace_closures','{"modeCode":"pickup","closures":[{"closedOn":"2027-03-03"}]}'::jsonb);
SQL
  R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$PA" "$T1")")"
  [ "$(ecode "$R")" = CSDJBO1_STALE_CONFIGURATION ] || bad="$bad rev"
  CUR="$(call_get "$DB" authenticated "$OWNER_A" "$RID_A" pickup null)"
  R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(pm "$(set_scope "$PV1" delivery "$RULE_A")" "(:'b'::jsonb) || jsonb_build_object('expectedUpdatedAt','2026-01-01T00:00:00.000000Z')")")"
  [ "$(ecode "$R")" = CSDJBO1_STALE_CONFIGURATION ] || bad="$bad scopemissing"
  R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$(pm "$PA" "jsonb_set(:'b'::jsonb,\$p\${slots}\$p\$,'[]')")" "$CUR")")"
  [ "$(ecode "$R")" = CSDJBO1_INCOMPLETE_CONFIGURATION ] || bad="$bad incomplete"
  R="$(call_save "$DB" authenticated "$STAFF_A" "$RID_A" "$PA")";    [ "$(ecode "$R")" = CSDJ1_FORBIDDEN ] || bad="$bad staff"
  R="$(call_save "$DB" authenticated "$OPERATOR_ID" "$RID_A" "$PA")"; [ "$(ecode "$R")" = CSDJ1_FORBIDDEN ] || bad="$bad operator"
  R="$(call_save "$DB" authenticated "$STRANGER" "$RID_A" "$PA")";    [ "$(ecode "$R")" = CSDJ1_FORBIDDEN ] || bad="$bad stranger"
  R="$(call_save "$DB" authenticated - "$RID_A" "$PA")";              [ "$(ecode "$R")" = CSDJ1_AUTH_REQUIRED ] || bad="$bad noauth"
  R="$(call_save "$DB" anon "$OWNER_A" "$RID_A" "$PA")";              is_err "$R" || bad="$bad anon"
  R="$(CALL_PRE="begin isolation level repeatable read;" call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$PA" "$CUR")")"
  [ "$(ecode "$R")" = CSDJ12_ISOLATION_REQUIRED ] || bad="$bad isolation"
  R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$(pm "$PA" "(:'b'::jsonb) || \$j\${\"foo\":1}\$j\$::jsonb")" "$CUR")")"
  [ "$(ecode "$R")" = CSDJ1_INVALID_PAYLOAD ] || bad="$bad strict"
  R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$(pm "$PV1" "(:'b'::jsonb) || \$j\${\"preparation\":{\"weekdays\":[1],\"closures\":[]}}\$j\$::jsonb")" "$CUR")")"
  [ "$(ecode "$R")" = CSDJBO1_METHOD_MISMATCH ] || bad="$bad mismatch"
  R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$(pm "$PV1" "jsonb_set(:'b'::jsonb,\$p\${windows}\$p\$,\$j\$[{\"weekday\":1,\"startsAt\":\"09:00\",\"endsAt\":\"20:00\"},{\"weekday\":1,\"startsAt\":\"10:00\",\"endsAt\":\"11:00\"},{\"weekday\":1,\"startsAt\":\"12:00\",\"endsAt\":\"13:00\"}]\$j\$::jsonb)")" "$CUR")")"
  [ "$(ecode "$R")" = CSDJ1_WINDOW_OVERLAP ] || bad="$bad overlap"
  R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(set_scope "$PV1" delivery "$RULE_B")")"
  [ "$(ecode "$R")" = CSDJ1_FOREIGN_RULE ] || bad="$bad foreign"
  R="$(call_get "$DB" authenticated "$STRANGER" "$RID_A" pickup null)"; has "$R" CSDJ1_FORBIDDEN || bad="$bad getauth"
  # remplacement intégral : une charge réduite ne laisse QUE ce qu'elle porte
  CUR="$(call_get "$DB" authenticated "$OWNER_A" "$RID_A" pickup null)"
  R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$(with_token "$(pm "$PA" "jsonb_set(:'b'::jsonb,\$p\${slots}\$p\$,'[{\"weekday\":6,\"slotKey\":\"m\",\"startsAt\":\"09:00\",\"endsAt\":\"12:00\"}]')")" "$CUR")")"
  if is_err "$R"; then bad="$bad replace_err"; else [ "$(cnt "$R" slots)" = "1" ] || bad="$bad replace"; fi
  # pas de compte de capacité dans la réponse
  printf '%s' "$R" | grep -Eiq '"[A-Za-z]*(count|used|remaining|reserved)[A-Za-z]*"[[:space:]]*:' && bad="$bad leak"
  # atomicité : une panne à l'écriture des fermetures doit TOUT annuler
  fault_infra "$DB"
  CUR="$(call_get "$DB" authenticated "$OWNER_A" "$RID_A" pickup null)"; SNAP="$(tenant_digest "$DB" "$RID_A")"
  YS="$(with_token "$(pm "$PA" "jsonb_set(jsonb_set(:'b'::jsonb,\$p\${closures}\$p\$,'[{\"closedOn\":\"2026-11-03\"}]'),\$p\${preparation,weekdays}\$p\$,'[4]')")" "$CUR")"
  R="$(CALL_PRE="set scanym.fault='restaurant_fulfillment_schedule_closure';" call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$YS")"
  { has "$R" FAULT_INJECTED && [ "$SNAP" = "$(tenant_digest "$DB" "$RID_A")" ]; } || bad="$bad atomic"
  # sérialisation : la seconde session ATTEND le verrou de tenant
  CUR="$(call_get "$DB" authenticated "$OWNER_A" "$RID_A" pickup null)"
  bg_save "$CCDIR/m1" authenticated "$OWNER_A" "$RID_A" "$(with_token "$(variant "$PA" 50)" "$CUR")" "begin;" "select pg_sleep(1.8); commit;"; local P1=$BG_LAST
  if wait_state "$RID_A" "1|0" 12; then
    bg_save "$CCDIR/m2" authenticated "$OWNER_A" "$RID_A" "$(with_token "$(variant "$PA" 51)" "$CUR")"; local P2=$BG_LAST
    wait_state "$RID_A" "1|1" 8 || bad="$bad lock"
    wait "$P2" 2>/dev/null
  else
    bad="$bad lock"
  fi
  wait "$P1" 2>/dev/null
  DB="$saved"
  echo "${bad# }"
}
mut_db() { # <fichier SQL du lot> -> 0 si appliqué
  psql -X -q -d postgres -c "drop database if exists \"$DB_MUT\";" </dev/null >/dev/null 2>&1
  createdb -T "$DB_PRE" "$DB_MUT" 2>"$ERR" || fatal "mut_db : $(head -2 "$ERR" | tr '\n' ' ')"
  case " $CREATED_DBS " in *" $DB_MUT "*) ;; *) CREATED_DBS="$CREATED_DBS $DB_MUT" ;; esac
  psql -X -d "$DB_MUT" -v ON_ERROR_STOP=1 -q -c "insert into auth.users (id, email) values ('$OPERATOR_ID','operator@csdjbo1.test') on conflict do nothing; insert into public.scanym_operators (user_id) values ('$OPERATOR_ID') on conflict do nothing;" >/dev/null 2>&1
  apply_path "$1" "$DB_MUT"
}
LOTF="$SUPABASE_DIR/$LOT_SQL"
# Contrôle : le lot NON modifié passe TOUTES les sondes (sinon les détecteurs ne prouveraient rien).
mut_db "$LOTF" || fatal "[15] le lot non modifié ne s'applique pas sur la base de mutation."
CTRL="$(battery "$DB_MUT")"
assert_eq "[15] CONTRÔLE : le lot non modifié passe toutes les sondes de la batterie" "" "$CTRL"
mutant() { # <nom> <ancien> <nouveau> <sondes attendues séparées par des espaces | APPLY> [occurrences]
  local name="$1" old="$2" new="$3" want="$4" n="${5:-1}" f="$TMP_DIR/mut_$1.sql" got w ok
  if ! pyrep "$LOTF" "$f" "$old" "$new" "$n" 2>"$TMP_DIR/pyrep.err"; then fail "[15] mutant « $name » : motif introuvable ($(head -1 "$TMP_DIR/pyrep.err"))"; return; fi
  if [ "$want" = "APPLY" ]; then
    if mut_db "$f"; then fail "[15] mutant « $name » NON DÉTECTÉ : le post-vol aurait dû refuser son application"
    else pass "[15] mutant « $name » DÉTECTÉ : le lot muté est REFUSÉ à l'application (post-vol)"; fi
    return
  fi
  if ! mut_db "$f"; then fail "[15] mutant « $name » : ne s'applique pas ($(tail -2 "$OUT" | tr '\n' ' '))"; return; fi
  got="$(battery "$DB_MUT")"
  ok=1; for w in $want; do case " $got " in *" $w "*) ;; *) ok=0 ;; esac; done
  if [ "$ok" = 1 ]; then pass "[15] mutant « $name » DÉTECTÉ par la sonde « $want » (sondes en échec : $got)"
  else fail "[15] mutant « $name » NON DÉTECTÉ : attendu « $want », sondes en échec : « ${got:-aucune} »"; fi
}
mutant "complétude retirée" "if pg_catalog.cardinality(v_blockers) > 0 then" "if false then" incomplete
mutant "comparaison d'updatedAt retirée" "if v_exp_ts is distinct from v_exist.updated_at then" "if false then" stale
mutant "comparaison de révision retirée" "if v_exp_rev is not null
       and v_exp_rev is distinct from" "if false and v_exp_rev is distinct from" rev
mutant "jeton exigé retiré (création sur l'existant)" "if v_exp_ts is null then
      raise exception 'CSDJBO1_STALE_CONFIGURATION: cette portée existe déjà" "if false then
      raise exception 'CSDJBO1_STALE_CONFIGURATION: cette portée existe déjà" required
mutant "portée disparue non détectée" "if v_exp_ts is not null or v_exp_rev is not null then
      raise exception" "if false then
      raise exception" scopemissing
mutant "rôle élargi aux membres (staff)" "if not public.has_role_in(p_restaurant_id, array['owner','manager']) then" "if not public.is_member_of(p_restaurant_id) then" staff
mutant "dérogation opérateur à l'écriture" "if not public.has_role_in(p_restaurant_id, array['owner','manager']) then" "if not public.has_role_in(p_restaurant_id, array['owner','manager']) and not public.is_scanym_operator() then" operator
mutant "tout le monde est autorisé" "if not public.has_role_in(p_restaurant_id, array['owner','manager']) then" "if false then" "staff operator stranger"
mutant "session exigée retirée" "if auth.uid() is null then
    raise exception 'CSDJ1_AUTH_REQUIRED: session authentifiée requise.' using errcode = '28000';
  end if;
  if not public.has_role_in" "if not public.has_role_in" noauth
mutant "READ COMMITTED non exigé" "if pg_catalog.current_setting('transaction_isolation') is distinct from 'read committed' then" "if false then" isolation
mutant "verrou de tenant retiré" "perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_restaurant_id::text, 1104));" "perform 1;" lock
mutant "verrou de tenant : autre graine" "perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_restaurant_id::text, 1104));" "perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_restaurant_id::text, 1105));" lock
mutant "clés inconnues tolérées" "if v_k <> all(array['modeCode','fulfillmentRuleId','expectedUpdatedAt','expectedRevision','method'," "if false and v_k <> all(array['modeCode','fulfillmentRuleId','expectedUpdatedAt','expectedRevision','method'," strict
mutant "créneaux fusionnés au lieu d'être remplacés" "  delete from public.restaurant_fulfillment_schedule_slot x
  where x.restaurant_id = p_restaurant_id and x.mode_code = v_mode and x.rule_key = v_rule_key;" "" replace
mutant "sections d'une autre méthode tolérées" "if p_payload ? 'preparation' or p_payload ? 'holidays' or p_payload ? 'capacity' then" "if false then" mismatch
mutant "contrôle de chevauchement retiré" "where q.prev_max_end > q.s" "where false" overlap
mutant "règle d'un autre établissement acceptée" "where f.id = v_rule and f.restaurant_id = p_restaurant_id and f.mode_code = v_mode" "where f.id = v_rule and f.mode_code = v_mode" foreign
mutant "lecture ouverte à tous" "if not public.is_member_of(p_restaurant_id) and not public.is_scanym_operator() then" "if false then" getauth
mutant "compte de capacité divulgué" "'maxOrders', s.capacity_max_orders));" "'maxOrders', s.capacity_max_orders, 'used', (select pg_catalog.count(*) from public.order_fulfillment_capacity_reservation r where r.restaurant_id = s.restaurant_id)));" leak
mutant "erreur d'écriture des fermetures avalée" "  insert into public.restaurant_fulfillment_schedule_closure
    (restaurant_id, mode_code, rule_key, closed_on, label)
  select p_restaurant_id, v_mode, v_rule_key,
         (e->>'closedOn')::date, nullif(pg_catalog.btrim(coalesce(e->>'label', '')), '')
  from pg_catalog.jsonb_array_elements(v_closures) e;" "  begin
  insert into public.restaurant_fulfillment_schedule_closure
    (restaurant_id, mode_code, rule_key, closed_on, label)
  select p_restaurant_id, v_mode, v_rule_key,
         (e->>'closedOn')::date, nullif(pg_catalog.btrim(coalesce(e->>'label', '')), '')
  from pg_catalog.jsonb_array_elements(v_closures) e;
  exception when others then null;
  end;" atomic
mutant "droit EXECUTE accordé à anon" "grant execute on function public.get_fulfillment_configuration(uuid,text,uuid) to authenticated;" "grant execute on function public.get_fulfillment_configuration(uuid,text,uuid) to authenticated, anon;" APPLY
mutant "droit EXECUTE accordé à service_role" "grant execute on function public.save_fulfillment_configuration(uuid,jsonb) to authenticated;" "grant execute on function public.save_fulfillment_configuration(uuid,jsonb) to authenticated, service_role;" APPLY
mutant "constructeur interne ouvert à authenticated" "revoke all on function public.csdjbo1_persisted_configuration(uuid,text,uuid) from public, anon, authenticated, service_role;" "grant execute on function public.csdjbo1_persisted_configuration(uuid,text,uuid) to authenticated;" APPLY
mutant "search_path de l'écriture non vide" "set search_path = ''
as \$csdjbo1_save\$" "set search_path = public
as \$csdjbo1_save\$" APPLY
mutant "écriture sans SECURITY DEFINER" "volatile
security definer
set search_path = ''
as \$csdjbo1_save\$" "volatile
set search_path = ''
as \$csdjbo1_save\$" APPLY
mutant "une fonction existante est redéfinie" "-- ============================================================
-- §Z  POST-VOL" "create or replace function public.checkout_wall_time_statuses() returns text[] language sql immutable set search_path = '' as \$\$ select array['x']::text[] \$\$;
-- ============================================================
-- §Z  POST-VOL" APPLY
mutant "le lot insère une ligne de configuration" "-- ============================================================
-- §Z  POST-VOL" "insert into public.restaurant_fulfillment_schedule (restaurant_id, mode_code, timezone) values ('$RID_B','room_service','Europe/Paris');
-- ============================================================
-- §Z  POST-VOL" APPLY
psql -X -q -d postgres -c "drop database if exists \"$DB_MUT\";" </dev/null >/dev/null 2>&1

# ============================================================
# [16] RETOUR ARRIÈRE
# ============================================================
log "=== [16] Retour arrière ==="
ROLLF="$SUPABASE_DIR/$LOT_ROLLBACK"
rb_db() { # <modèle> : (re)crée DB_RB depuis un modèle
  psql -X -q -d postgres -c "drop database if exists \"$DB_RB\";" </dev/null >/dev/null 2>&1
  createdb -T "$1" "$DB_RB" 2>"$ERR" || fatal "rb_db($1) : $(head -2 "$ERR" | tr '\n' ' ')"
  case " $CREATED_DBS " in *" $DB_RB "*) ;; *) CREATED_DBS="$CREATED_DBS $DB_RB" ;; esac
}
rb_apply() { psql -X -d "$DB_RB" -v ON_ERROR_STOP=1 -f "$ROLLF" 2>&1; }
rb_refused() { # <étiquette> <fragment> : refus nommé, rien ne change
  local out; out="$(rb_apply)"
  if has "$out" "$2"; then pass "[16] $1 : retour REFUSÉ ($2)"; else fail "[16] $1 : attendu « $2 », obtenu : $(printf '%s' "$out" | grep -m1 ERROR | cut -c1-200)"; fi
}
DB="$DB_RB"
# 16.1 Sur l'état d'AVANT le lot : sans objet.
rb_db "$DB_PRE"; rb_refused "état d'avant le lot" "[NOT_APPLICABLE]"
# 16.2 Lot appliqué + une configuration écrite par la RPC chez A et chez B.
rb_db "$DB_PRE"; apply_path "$SUPABASE_DIR/$LOT_SQL" "$DB_RB" || fatal "[16] lot non appliqué sur DB_RB"
psql -X -d "$DB_RB" -v ON_ERROR_STOP=1 -q -c "insert into auth.users (id, email) values ('$OPERATOR_ID','operator@csdjbo1.test') on conflict do nothing;" >/dev/null 2>&1
wipe_scope "$DB_RB" "$RID_A"; wipe_scope "$DB_RB" "$RID_B"
RB_A="$(call_save "$DB_RB" authenticated "$OWNER_A" "$RID_A" "$PA")"; RB_B="$(call_save "$DB_RB" authenticated "$OWNER_B" "$RID_B" "$(set_scope "$PV1" delivery "$RULE_B")")"
{ ! is_err "$RB_A" && ! is_err "$RB_B"; } || fatal "[16] configurations de départ refusées : $RB_A / $RB_B"
RB_DA="$(tenant_digest "$DB_RB" "$RID_A")"; RB_DB="$(tenant_digest "$DB_RB" "$RID_B")"
# 16.3 Un appelant le cite (texte) : refus. Une dépendance enregistrée : refus.
psql -X -d "$DB_RB" -v ON_ERROR_STOP=1 -q -c "create function public.zz_caller() returns jsonb language plpgsql as \$\$ begin return public.save_fulfillment_configuration(null::uuid, '{}'::jsonb); end \$\$;" >/dev/null 2>&1
rb_refused "une routine appelle la RPC" "[CALLER]"
psql -X -d "$DB_RB" -q -c "drop function public.zz_caller();" >/dev/null 2>&1
psql -X -d "$DB_RB" -v ON_ERROR_STOP=1 -q -c "create function public.zz_dep() returns jsonb language sql begin atomic select public.get_fulfillment_configuration('$RID_A'::uuid,'pickup',null::uuid); end;" >/dev/null 2>&1
rb_refused "une fonction SQL dépend de la lecture (dépendance enregistrée)" "[DEPENDENT]"
psql -X -d "$DB_RB" -q -c "drop function public.zz_dep();" >/dev/null 2>&1
assert_eq "[16] les refus n'ont rien supprimé (3 fonctions présentes)" "3" "$(lot_fn_n "$DB_RB")"
assert_eq "[16] ... ni touché aux données" "$RB_DA|$RB_DB" "$(tenant_digest "$DB_RB" "$RID_A")|$(tenant_digest "$DB_RB" "$RID_B")"
# 16.4 Retour arrière effectif.
OUTRB="$(rb_apply)"
if has "$OUTRB" "ERROR"; then fail "[16] le retour arrière échoue : $(printf '%s' "$OUTRB" | grep -m1 ERROR)"; else pass "[16] le retour arrière s'applique (3 fonctions supprimées)"; fi
assert_eq "[16] plus aucune fonction du lot" "0" "$(lot_fn_n "$DB_RB")"
assert_eq "[16] les données de A sont intactes (empreinte)" "$RB_DA" "$(tenant_digest "$DB_RB" "$RID_A")"
assert_eq "[16] les données de B sont intactes (empreinte)" "$RB_DB" "$(tenant_digest "$DB_RB" "$RID_B")"
lot_inv_equal "$DB_RB" && pass "[16] l'inventaire (fonctions, colonnes, contraintes, politiques, déclencheurs, droits) est IDENTIQUE à l'état d'avant le lot" || fail "[16] l'inventaire après retour diffère de l'état d'avant le lot"
LEGR="$(psql -X -A -q -t -d "$DB_RB" 2>&1 <<SQL | tail -1
set role authenticated; set test.uid = '$OWNER_A';
select ((select count(*) from public.get_merchant_fulfillment_schedules('$RID_A') x where x.slots::text like '%midi%') = 1
    and (select count(*) from public.get_merchant_fulfillment_schedules_v12('$RID_A')) >= 1)::text;
SQL
)"
assert_eq "[16] la configuration écrite par la RPC reste LISIBLE par les lectures historiques après le retour" "true" "$LEGR"
LEGW="$(psql -X -A -q -t -d "$DB_RB" 2>&1 <<SQL | grep -c ERROR
set role authenticated; set test.uid = '$OWNER_A';
select public.mutate_merchant_fulfillment_schedule('$RID_A','replace_closures','{"modeCode":"pickup","closures":[{"closedOn":"2027-05-05"}]}'::jsonb);
SQL
)"
assert_eq "[16] ... et MODIFIABLE par les mutateurs historiques (0 erreur)" "0" "$LEGW"
# 16.5 Second retour : sans objet.
rb_refused "retour rejoué" "[NOT_APPLICABLE]"
# 16.6 Ré-application : le lot converge vers le même état.
psql -X -d "$DB_RB" -v ON_ERROR_STOP=1 -q -c "update public.restaurant_fulfillment_schedule set updated_at = updated_at where restaurant_id='$RID_A';" >/dev/null 2>&1
if apply_path "$SUPABASE_DIR/$LOT_SQL" "$DB_RB"; then pass "[16] le lot se RÉ-APPLIQUE après un retour (aller-retour-aller)"; else fail "[16] ré-application refusée : $(tail -2 "$OUT" | tr '\n' ' ')"; fi
inventory "$DB_RB" | sort > "$TMP_DIR/inv.rb2"
diff -q "$TMP_DIR/inv.new" "$TMP_DIR/inv.rb2" >/dev/null && pass "[16] après ré-application, l'inventaire est IDENTIQUE à celui du lot appliqué" || fail "[16] après ré-application l'inventaire diffère"
assert_eq "[16] la lecture par la RPC rend toujours la configuration d'A (modification historique incluse)" "1" "$(call_get "$DB_RB" authenticated "$OWNER_A" "$RID_A" pickup null | grep -c '2027-05-05')"
# 16.7 État partiel du lot : refusé plutôt que deviné.
psql -X -d "$DB_RB" -q -c "drop function public.get_fulfillment_configuration(uuid,text,uuid);" >/dev/null 2>&1
rb_refused "état partiel (une des trois fonctions manque)" "[NOT_APPLICABLE]"
assert_eq "[16] ... et les deux autres fonctions n'ont pas été supprimées" "2" "$(lot_fn_n "$DB_RB")"
psql -X -q -d postgres -c "drop database if exists \"$DB_RB\";" </dev/null >/dev/null 2>&1

# ============================================================
# [17] DOCUMENTATION : l'exemple du contrat est EXÉCUTÉ, et le contrat ne promet que ce que le SQL tient
# ============================================================
log "=== [17] Documentation ==="
DOCF="$ROOT_DIR/docs/scheduling/csdj-bo1-save-fulfillment-configuration-contract.md"
if [ -f "$DOCF" ]; then
  python3 -I - "$DOCF" "$TMP_DIR/doc_example.json" <<'PY'
import sys,re,json
s=open(sys.argv[1],encoding='utf-8').read()
m=re.search(r'<!-- example:alc-pickup:begin -->\s*```json\s*(.*?)\s*```\s*<!-- example:alc-pickup:end -->',s,re.S)
if not m: sys.exit(3)
json.loads(m.group(1))
open(sys.argv[2],'w',encoding='utf-8').write(json.dumps(json.loads(m.group(1))))
PY
  if [ -s "$TMP_DIR/doc_example.json" ]; then
    DB="$DB_NEW"; wipe_scope "$DB" "$RID_A"
    DEX="$(cat "$TMP_DIR/doc_example.json")"
    R="$(call_save "$DB" authenticated "$OWNER_A" "$RID_A" "$DEX")"
    if is_err "$R"; then fail "[17] l'exemple du contrat est refusé par la RPC : $R"; else pass "[17] l'exemple du contrat (retrait, 2 créneaux, mardi–samedi, 16 h la veille) est ACCEPTÉ tel quel"; fi
    assert_eq "[17] l'exemple relu = l'exemple envoyé (mêmes 10 créneaux, mêmes jours de préparation, même heure limite)" "$(pm "$DEX" "(:'b'::jsonb)")" "$(sans_jetons "$R")"
    assert_eq "[17] l'exemple du contrat = la charge ALC du harnais (une seule définition)" "$(pm "$PA" "(:'b'::jsonb)")" "$(pm "$DEX" "(:'b'::jsonb)")"
    assert_eq "[17] exemple : lundi 15:59 → mardi ; lundi 16:00 → mercredi (annoncé dans le contrat)" "2026-10-20/dates_available|2026-10-21/dates_available" "$(res_first '2026-10-19 13:59:00+00')|$(res_first '2026-10-19 14:00:00+00')"
    assert_eq "[17] exemple : aucun autre établissement ne reçoit l'exemple (B inchangé, A seul)" "1" "$(sql_on "$DB" "select count(distinct restaurant_id) from public.restaurant_fulfillment_schedule_slot where slot_key in ('midi','soir') and restaurant_id <> '$RID_B';" )"
    DOC_KEYS="$(pm "$DEX" "(select string_agg(k, ',' order by k) from jsonb_object_keys(:'b'::jsonb) k)")"
    assert_eq "[17] clés de l'exemple = clés du contrat (charge)" "capacity,closures,enabled,fulfillmentRuleId,holidays,method,modeCode,policy,preparation,slots,windows" "$DOC_KEYS"
  else
    fail "[17] exemple du contrat illisible ou balises absentes"
  fi
  MISSING=""
  for code in $(grep -oE '`(CSDJ1|CSDJ12|CSDJBO1|SCANYM_CSDJBO1)_[A-Z0-9_]+`' "$DOCF" | tr -d '`' | sort -u); do
    grep -q "$code" "$SUPABASE_DIR/$LOT_SQL" || MISSING="$MISSING $code"
  done
  assert_eq "[17] chaque code cité dans le contrat existe dans le SQL (rien n'est promis sans être levé)" "" "$MISSING"
  UNDOC=""
  for code in $(grep -oE "'(CSDJ1|CSDJ12|CSDJBO1)_[A-Z0-9_]+:" "$SUPABASE_DIR/$LOT_SQL" | tr -d "':" | sort -u); do
    grep -q "$code" "$DOCF" || UNDOC="$UNDOC $code"
  done
  assert_eq "[17] chaque refus levé par le SQL est documenté dans le contrat" "" "$UNDOC"
  assert_eq "[17] le contrat dit que CSDJ_BO1_WRITE_CONTRACT.available reste false" "1" "$(grep -c 'available. \*\*reste `false`\*\*' "$DOCF")"
else
  fail "[17] contrat de documentation absent : $DOCF"
fi

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
