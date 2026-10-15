#!/usr/bin/env bash
# ============================================================
# Scanym — CSDJ-BO-1 — COMPATIBILITÉ D'INTÉGRATION : éditeur Nougaro (F-01/F-03) ↔ RPC Boulez (#151) + invariant F-02 (#152)
# Fichier  : supabase/tests/csdj-bo1-integration-compat-check.sh
# Mandat   : DIRAC → BOULEZ, intégration finale (PR #153). Aucun SQL hébergé.
#
# Le VRAI code de l'éditeur (lib/availability-payload.ts) est exécuté contre les VRAIES RPC
# save_fulfillment_configuration / get_fulfillment_configuration, dans une grappe PostgreSQL
# JETABLE (SCANYM_DISPOSABLE_CLUSTER=1, utilisateur système non privilégié) où le moteur v1.2
# (SCANYM_V12_SOURCE_DIR, blob épinglé), le lot BO1 et l'invariant F-02 sont appliqués.
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
# [I] ÉDITEUR NOUGARO ↔ RPC BOULEZ (code réel, base réelle)
# ============================================================
log "=== [I] Intégration : code de l'éditeur contre les RPC réelles ($DB_F02) ==="
IC_DIR="$TMP_DIR/ic"; mkdir -p "$IC_DIR"
mk_alc > "$IC_DIR/pa.json"; mk_alc "'$RULE_A'" > "$IC_DIR/par.json"; mk_v1 > "$IC_DIR/pv1.json"
for f in pa par pv1; do [ -s "$IC_DIR/$f.json" ] || fatal "[I] charge de référence $f illisible."; done
REPO_ROOT="$(cd "$SUPABASE_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || fatal "[I] node introuvable."
[ -f "$SUPABASE_DIR/tests/csdj-bo1-integration-compat-driver.ts" ] || fatal "[I] pilote introuvable."
IC_OUT="$TMP_DIR/ic.out"
( cd "$REPO_ROOT" && IC_DB="$DB_F02" IC_RID_A="$RID_A" IC_RID_B="$RID_B" IC_OWNER_A="$OWNER_A" IC_OWNER_B="$OWNER_B" IC_RULE_A="$RULE_A" \
  IC_PA="$IC_DIR/pa.json" IC_PAR="$IC_DIR/par.json" IC_PV1="$IC_DIR/pv1.json" \
  node --experimental-strip-types --no-warnings --import ./tests/register.mjs supabase/tests/csdj-bo1-integration-compat-driver.ts > "$IC_OUT" 2> "$TMP_DIR/ic.err" ) || true
IC_OK=0; IC_KO=0
while IFS='|' read -r tag name detail; do
  case "$tag" in
    OK) pass "[I] $name"; IC_OK=$((IC_OK+1)) ;;
    KO) fail "[I] $name — $detail"; IC_KO=$((IC_KO+1)) ;;
    I8-GRID) log "grille éditeur/serveur : $name configurations, $detail divergence(s)" ;;
  esac
done < "$IC_OUT"
[ "$IC_OK" -ge 30 ] || fail "[I] trop peu de preuves produites par le pilote ($IC_OK) : $(head -3 "$TMP_DIR/ic.err" | tr '\n' ' ')"
[ "$IC_KO" -eq 0 ] || log "pilote : $IC_KO échec(s)"
[ -s "$TMP_DIR/ic.err" ] && log "stderr du pilote : $(head -3 "$TMP_DIR/ic.err" | tr '\n' ' ')"

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
