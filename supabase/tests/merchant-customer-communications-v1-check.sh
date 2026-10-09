#!/usr/bin/env bash
# ============================================================
# Scanym — MERCHANT CUSTOMER COMMUNICATIONS v1
# Harnais PostgreSQL JETABLE et reproductible pour
#   supabase/DRAFT-lot-merchant-customer-communications-v1.sql
#   supabase/DRAFT-lot-merchant-customer-communications-v1-rollback.sql
#
# Même patron que supabase/tests/customer-followup-tracking-email-v1-check.sh
# (contrat de référence du dépôt) : bases jetables, rôles
# anon/authenticated/service_role recréés minimalement, auth.uid()
# simulé via `test.uid`, aucun appel réseau, aucun prestataire, aucune
# donnée réelle. La CHAÎNE PRÉDÉCESSEUR est reprise VERBATIM de ce
# harnais-là, plus les deux maillons que ce lot exige (CFTE v1 pour
# merchant_tracking_status_text, ONLINE WITHDRAWAL FOUNDATION v1 pour
# order_items.withdrawal_eligible_at_order_time).
#
# ------------------------------------------------------------------
# CE QUE CE HARNAIS PROUVE (exécuté, jamais inspecté)
#   [1] le SQL aller s'applique sur le schéma PRÉDÉCESSEUR réel ;
#   [2] ATOMICITÉ : un post-vol qui échoue EMPÊCHE le commit -- ni
#       table, ni fonction, ni redéfinition ne subsiste ;
#   [3] tables / RLS / policies / fonctions / grants contractés ;
#   [4] ISOLATION MULTI-LOCATAIRES : un owner ne lit NI n'écrit les
#       textes d'un autre commerçant ; `anon` n'a AUCUN accès direct à
#       la table ; la projection publique est filtrée sur le restaurant
#       demandé et n'expose JAMAIS un gabarit d'e-mail ;
#   [5] ÉVÉNEMENTS FERMÉS AU REPOS : sans interrupteur, l'enfilement
#       produit 'skipped_disabled' -- jamais 'pending' ;
#   [6] LISTE BLANCHE DE VARIABLES : un jeton inconnu est REFUSÉ à
#       l'écriture (22023), y compris par la contrainte de table ;
#   [7] bornes de longueur PAR emplacement (160 sujet / 500 autres) ;
#   [8] corps vide/blanc => la LIGNE EST SUPPRIMÉE (repli générique) ;
#   [9] PREUVE D'ÉLIGIBILITÉ RÉTRACTATION : lit l'instantané existant,
#       fail-closed sur jeton erroné et sur instantané NULL, et
#       n'écrit RIEN ;
#  [10] IDEMPOTENCE : un second enfilement du même événement ne crée
#       AUCUN doublon et renvoie NULL ;
#  [11] REDÉFINITION STRICTEMENT ADDITIVE de
#       create_order_received_notification (15 clés de payload, les 10
#       d'avant intactes) ;
#  [12] le rollback s'applique, et l'état PRÉDÉCESSEUR est restauré
#       (fonction revenue à CFTE v1, CHECK revenu à 9 valeurs, comptes
#       de schéma identiques, AUCUNE commande perdue) ;
#  [13] le rollback REFUSE de s'appliquer si une ligne d'outbox porte
#       un type ajouté par ce lot -- plutôt que d'échouer à mi-parcours.
#
# CE QUE CE HARNAIS NE FAIT PAS : aucun envoi d'e-mail, aucune
# activation de prestataire, aucun appel Stuart/Chronofresh, aucune
# écriture hors des bases jetables qu'il crée lui-même.
#
# ------------------------------------------------------------------
# SÛRETÉ (v1.1) — voir la section « SÛRETÉ — FAIL CLOSED » ci-dessous
# pour le détail et pour ce que la version v1 faisait de faux. En
# résumé : consentement explicite exigé, variables de connexion
# héritées refusées par NOM (jamais par valeur), cluster jetable CRÉÉ
# par le harnais et prouvé en SQL par son `data_directory`, noms de
# base propres à l'exécution, refus si un tel nom préexiste, nettoyage
# limité aux ressources créées ici.
#
# Preuves de ces propriétés :
#   supabase/tests/merchant-customer-communications-v1-harness-safety-check.sh
#
# Usage :  SCANYM_DISPOSABLE_CLUSTER=1 \
#            bash supabase/tests/merchant-customer-communications-v1-check.sh
# Sortie :  0 = toutes les preuves produites ; 1 = au moins un échec,
#           ou preuve impossible à produire.
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
# OpenAI/Codex, blocker 3 : MCC-V1-HARNESS-UNSAFE-TARGET-01)
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
#     poste où une base `scanym_mcc_v1_base` existait déjà, elle la
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
#     bash supabase/tests/merchant-customer-communications-v1-check.sh
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
REDIRECTING_VARS="PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE DATABASE_URL POSTGRES_URL POSTGRESQL_URL PG_URL SUPABASE_DB_URL SCANYM_DB_URL SCANYM_DATABASE_URL"
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
export PGAPPNAME="scanym-mcc-v1-harness"

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
# compagnon (merchant-customer-communications-v1-harness-safety-check.sh)
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
DB_BASE="scanym_mcc_v1_base_$RUN_TAG"
DB_FWD="scanym_mcc_v1_fwd_$RUN_TAG"
DB_ATOMIC="scanym_mcc_v1_atomic_$RUN_TAG"
DB_RB="scanym_mcc_v1_rb_$RUN_TAG"

# Et si malgré tout l'un de ces noms existe déjà, le harnais REFUSE :
# il ne peut pas prouver qu'il en est le propriétaire, donc il n'y
# touche pas. Jamais un `drop database` sur une base qu'il n'a pas créée.
for d in "$DB_BASE" "$DB_FWD" "$DB_ATOMIC" "$DB_RB"; do
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

role_state() {
  probe "select coalesce((select 'EXISTS|' || rolcanlogin::text || '|' || rolbypassrls::text
                          from pg_roles where rolname = '$1'), 'ABSENT');"
}
declare -A ROLE_SNAP=()
for r in $APP_ROLES; do
  st="$(role_state "$r")"
  case "$st" in
    ABSENT|EXISTS'|'*) ROLE_SNAP[$r]="$st" ;;
    *) fatal "état initial du rôle global '$r' illisible -- refus de muter un cluster non restaurable." ;;
  esac
done
ROLE_SNAPSHOT_TAKEN=1
SAFETY_LOCK_PASSED=1
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
    # Rôles : seulement si le cluster n'est PAS le nôtre (sinon il
    # disparaît entier juste après, et toucher ses rôles est inutile).
    if [ "$ROLE_SNAPSHOT_TAKEN" = "1" ] && [ "$OWN_CLUSTER" != "1" ]; then
      for r in $APP_ROLES; do
        case "${ROLE_SNAP[$r]}" in
          ABSENT) psql -X -q -d postgres -c "drop role if exists $r;" </dev/null >/dev/null 2>&1 ;;
          EXISTS*)
            login="$(printf '%s' "${ROLE_SNAP[$r]}" | cut -d'|' -f2)"
            bypass="$(printf '%s' "${ROLE_SNAP[$r]}" | cut -d'|' -f3)"
            [ "$login" = "t" ] && lk="login" || lk="nologin"
            [ "$bypass" = "t" ] && bk="bypassrls" || bk="nobypassrls"
            psql -X -q -d postgres -c "alter role $r $lk $bk;" </dev/null >/dev/null 2>&1 ;;
        esac
      done
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
# MCC-V1-HARNESS-UNSAFE-TARGET-01.
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
ITEM_A2='a1111111-1111-4111-8111-1111111111e3'
ITEM_B='b2222222-2222-4222-8222-2222222222e2'
OWNER_A='51111111-1111-4111-8111-11111111000a'
MANAGER_A='51111111-1111-4111-8111-1111111100aa'
STAFF_A='51111111-1111-4111-8111-11111111005a'
OWNER_B='52222222-2222-4222-8222-22222222000b'

# ============================================================
# [0] Chaîne PRÉDÉCESSEUR dans une base jetable modèle.
#     MINIMAL_CHAIN / REST_CHAIN / CGV_AFTER_N1A_CHAIN / TRACKING_TAIL
#     sont repris VERBATIM de
#     supabase/tests/customer-followup-tracking-email-v1-check.sh.
# ============================================================
log "=== [0] Construction du schéma PRÉDÉCESSEUR ($DB_BASE) ==="

MINIMAL_CHAIN="schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql"
REST_CHAIN="migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v76-storage-origin-config.sql migration-v71-hardening.sql migration-v72-hardening.sql migration-v73-hardening.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql migration-v82-lot2a-sale-modes.sql migration-v83-lot2a4-privilege-hardening.sql migration-v84-lot2b1-delivery-info-rpc.sql DRAFT-lot-fulfillment-routing-model.sql DRAFT-lot-fulfillment-routing-lot-b-rpc.sql DRAFT-lot-server-delivery-fulfillment-pricing.sql DRAFT-lot-payment-p3b6-checkout-billing-context.sql DRAFT-lot-customer-order-tracking-foundation.sql DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql DRAFT-lot-receipt-invoice-tax-detail-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1-1-remediation.sql DRAFT-lot-payment-p1-foundation.sql DRAFT-lot-merchant-delivery-pricing.sql DRAFT-lot-orders-service-role-select-hardening.sql"
CGV_AFTER_N1A_CHAIN="DRAFT-lot-seller-legal-profile-cgv-engine-v1-2.sql DRAFT-lot-seller-legal-profile-cgv-engine-v1-3.sql DRAFT-lot-seller-legal-profile-cgv-engine-v1-4.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-1.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-2.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-4.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-5.sql"
TRACKING_TAIL="DRAFT-lot-tracking-final-fiscal-summary-v1-1.sql DRAFT-lot-customer-tracking-capability-v3-1.sql DRAFT-lot-customer-contact-live-tracking-v1.sql"
# Les DEUX maillons propres à CE lot : CFTE v1 crée
# merchant_tracking_status_text (pré-vol de ce lot), ONLINE WITHDRAWAL
# FOUNDATION v1 crée order_items.withdrawal_eligible_at_order_time
# (LU par ce lot, jamais modifié).
MCC_TAIL="DRAFT-lot-customer-followup-tracking-email-v1.sql DRAFT-lot-online-withdrawal-foundation-v1.sql"

# Le harnais refuse de démarrer si un seul maillon manque : une chaîne
# silencieusement tronquée produirait des preuves sans valeur.
for f in $MINIMAL_CHAIN $REST_CHAIN DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql \
         DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql $CGV_AFTER_N1A_CHAIN \
         DRAFT-lot-order-received-enqueue-recovery-v1.sql \
         migration-20260919000000-order-success-boundary-v1.sql $TRACKING_TAIL $MCC_TAIL \
         DRAFT-lot-merchant-customer-communications-v1.sql \
         DRAFT-lot-merchant-customer-communications-v1-rollback.sql; do
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

# La chaîne de SUIVI exige public.order_invoice_request (EXISTENCE seule).
# CE lot en lit également l'existence seule (variable {invoice_requested}).
psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<'SQL' || fatal "talon order_invoice_request : $(tr '\n' ' ' < "$ERR")"
create table public.order_invoice_request (
  order_id uuid primary key references public.orders(id) on delete cascade
);
alter table public.order_invoice_request enable row level security;
revoke all on table public.order_invoice_request from public, anon, authenticated;
SQL
for f in $TRACKING_TAIL $MCC_TAIL; do
  apply_file "$f" || fatal "chaîne, $f : $(head -3 "$ERR" | tr '\n' ' ')"
done
log "chaîne prédécesseur appliquée (schema .. CFTE v1 + ONLINE WITHDRAWAL FOUNDATION v1)."

# --- Fixtures POSÉES AVANT le lot (commerçants historiques).
psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<SQL || fatal "fixtures : $(tr '\n' ' ' < "$ERR")"
insert into auth.users (id, email) values
  ('$OWNER_A','owner-a@mcc.test'), ('$MANAGER_A','manager-a@mcc.test'),
  ('$STAFF_A','staff-a@mcc.test'),  ('$OWNER_B','owner-b@mcc.test');

insert into public.restaurants (id, slug, name, is_active, status, country) values
  ('$RID_A','mcc-alpha','Epicerie Alpha',true,'active','FR'),
  ('$RID_B','mcc-beta','Primeur Beta',true,'active','FR');

insert into public.restaurant_configs (restaurant_id, max_tables, currency, whatsapp_number, address, public_email, public_phone)
values ('$RID_A', 5, 'EUR', '+33600000001', '3 place du Marche, 75011 Paris', 'contact@alpha.test', '+33123456789'),
       ('$RID_B', 5, 'EUR', '+33600000002', '9 rue Beta, 75012 Paris', 'contact@beta.test', '+33123456790');

insert into public.restaurant_users (restaurant_id, user_id, role) values
  ('$RID_A','$OWNER_A','owner'), ('$RID_A','$MANAGER_A','manager'),
  ('$RID_A','$STAFF_A','staff'), ('$RID_B','$OWNER_B','owner');

insert into public.menu_categories (id, restaurant_id, name, display_order)
values ('$CAT_A','$RID_A','Frais',1), ('$CAT_B','$RID_B','Frais',1);

insert into public.menu_items (id, category_id, name, price, is_available)
values ('$ITEM_A','$CAT_A','Fromage frais',12.50,true),
       ('$ITEM_A2','$CAT_A','Pain',3.00,true),
       ('$ITEM_B','$CAT_B','Legumes',8.00,true);

-- Une ligne RÉTRACTABLE chez A (le declencheur d'ONLINE WITHDRAWAL
-- FOUNDATION v1 recopie menu_items.withdrawal_eligible), l'autre non.
update public.menu_items set withdrawal_eligible = true  where id = '$ITEM_A';
update public.menu_items set withdrawal_eligible = false where id = '$ITEM_A2';
update public.menu_items set withdrawal_eligible = false where id = '$ITEM_B';

insert into public.merchant_notification_profile (restaurant_id, email_enabled, sender_name, sender_email)
values ('$RID_A', true, 'Commandes Alpha', 'commandes@alpha.test'),
       ('$RID_B', true, 'Commandes Beta', 'commandes@beta.test');
SQL

# Deux commandes RÉELLES, insérées directement (ce lot ne touche pas
# create_order ; on n'a donc pas besoin de l'exercer ici).
psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<SQL || fatal "commandes fixtures : $(tr '\n' ' ' < "$ERR")"
insert into public.orders (id, restaurant_id, order_number, customer_name, customer_email, customer_phone, service_mode, status, subtotal, total, currency, customer_language)
values ('c1111111-1111-4111-8111-11111111aaaa','$RID_A',1001,'Victor Hugo','victor.hugo@mcc.test','+33611223344','pickup','new',15.50,15.50,'EUR','fr'),
       ('c2222222-2222-4222-8222-22222222bbbb','$RID_B',2001,'Victor Hugo','victor.hugo@mcc.test','+33611223344','pickup','new',8.00,8.00,'EUR','fr');

insert into public.order_items (order_id, menu_item_id, item_name, unit_price, quantity, line_total)
values ('c1111111-1111-4111-8111-11111111aaaa','$ITEM_A','Fromage frais',12.50,1,12.50),
       ('c1111111-1111-4111-8111-11111111aaaa','$ITEM_A2','Pain',3.00,1,3.00),
       ('c2222222-2222-4222-8222-22222222bbbb','$ITEM_B','Legumes',8.00,1,8.00);
SQL
ORDER_A='c1111111-1111-4111-8111-11111111aaaa'
ORDER_B='c2222222-2222-4222-8222-22222222bbbb'
TOKEN_A="$(sql_value "select public_token from public.orders where id = '$ORDER_A';")"
[ -n "$TOKEN_A" ] || fatal "jeton public de la commande A illisible."

BASE_COUNTS="$(schema_counts "$DB_BASE")"
BASE_FN_CORN="$(fn_code_fingerprint 'create_order_received_notification' "$DB_BASE")"
BASE_ORDERS="$(sql_on "$DB_BASE" "select count(*) from public.orders;")"
log "fixtures posées (2 commerçants, 2 commandes, 1 ligne rétractable chez A)."

# ============================================================
# [1] ALLER — s'applique sur le prédécesseur réel.
# ============================================================
log "=== [1] Application du SQL aller ==="
clone_base "$DB_FWD"
if apply_path "$SUPABASE_DIR/DRAFT-lot-merchant-customer-communications-v1.sql" "$DB_FWD"; then
  pass "[1] le SQL aller s'applique sur le schéma prédécesseur réel"
else
  fail "[1] le SQL aller ÉCHOUE : $(grep -m1 'ERROR' "$OUT" | tr '\n' ' ')"
fi
DB="$DB_FWD"

# ============================================================
# [2] ATOMICITÉ — un post-vol qui échoue EMPÊCHE le commit.
# ============================================================
log "=== [2] Atomicité : post-vol saboté ==="
clone_base "$DB_ATOMIC"
SABOTAGE="$TMP_DIR/sabotage.sql"
# On remplace la cardinalité attendue du catalogue par une valeur fausse :
# le post-vol lève, donc le commit ne doit JAMAIS être atteint.
sed 's/cardinality(public.communication_text_keys()) <> 14/cardinality(public.communication_text_keys()) <> 999/' \
  "$SUPABASE_DIR/DRAFT-lot-merchant-customer-communications-v1.sql" > "$SABOTAGE"
if grep -q '999' "$SABOTAGE"; then
  if apply_path "$SABOTAGE" "$DB_ATOMIC"; then
    fail "[2] le lot saboté s'est appliqué -- le post-vol n'empêche PAS le commit"
  else
    pass "[2] un post-vol en échec interrompt la transaction"
  fi
  assert_eq "[2a] aucune table du lot ne subsiste après l'échec" "0" \
    "$(sql_on "$DB_ATOMIC" "select (to_regclass('public.merchant_communication_text') is not null)::int;")"
  assert_eq "[2b] aucune fonction du lot ne subsiste après l'échec" "0" \
    "$(sql_on "$DB_ATOMIC" "select (to_regprocedure('public.set_merchant_communication_text(uuid,text,text)') is not null)::int;")"
  assert_eq "[2c] create_order_received_notification est restée celle du prédécesseur" \
    "$BASE_FN_CORN" "$(fn_code_fingerprint 'create_order_received_notification' "$DB_ATOMIC")"
else
  fail "[2] sabotage impossible à injecter -- preuve d'atomicité non produite"
fi

# ============================================================
# [3] STRUCTURE — tables / RLS / policies / fonctions / grants.
# ============================================================
log "=== [3] Structure et posture de sécurité ==="
assert_eq "[3a] merchant_communication_text existe" "1" \
  "$(sql_value "select (to_regclass('public.merchant_communication_text') is not null)::int;")"
assert_eq "[3b] merchant_communication_event existe" "1" \
  "$(sql_value "select (to_regclass('public.merchant_communication_event') is not null)::int;")"
assert_eq "[3c] RLS active sur les deux tables" "2" \
  "$(sql_value "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('merchant_communication_text','merchant_communication_event') and c.relrowsecurity;")"
assert_eq "[3d] une policy SELECT par table, et AUCUNE policy d'écriture" "2|0" \
  "$(sql_value "select count(*) filter (where cmd='SELECT') || '|' || count(*) filter (where cmd <> 'SELECT') from pg_policies where schemaname='public' and tablename in ('merchant_communication_text','merchant_communication_event');")"
assert_eq "[3e] les 11 fonctions du lot existent" "11" \
  "$(sql_value "select (
     (to_regprocedure('public.communication_text_keys()') is not null)::int
   + (to_regprocedure('public.public_communication_text_keys()') is not null)::int
   + (to_regprocedure('public.communication_template_variables()') is not null)::int
   + (to_regprocedure('public.communication_event_codes()') is not null)::int
   + (to_regprocedure('public.communication_text_max_length(text)') is not null)::int
   + (to_regprocedure('public.communication_template_unknown_variables(text)') is not null)::int
   + (to_regprocedure('public.merchant_communication_contact(uuid)') is not null)::int
   + (to_regprocedure('public.set_merchant_communication_text(uuid,text,text)') is not null)::int
   + (to_regprocedure('public.set_merchant_communication_event_enabled(uuid,text,boolean)') is not null)::int
   + (to_regprocedure('public.get_restaurant_public_communication_texts(uuid)') is not null)::int
   + (to_regprocedure('public.order_has_withdrawal_eligible_line(uuid,uuid)') is not null)::int);")"
assert_eq "[3f] anon n'a AUCUN SELECT direct sur la table de textes (gabarits d'e-mail)" "f" \
  "$(sql_value "select has_table_privilege('anon','public.merchant_communication_text','SELECT');")"
assert_eq "[3g] authenticated a le SELECT (lecture back-office)" "t" \
  "$(sql_value "select has_table_privilege('authenticated','public.merchant_communication_text','SELECT');")"
assert_eq "[3h] AUCUN privilège d'écriture de table pour anon/authenticated" "0" \
  "$(sql_value "select count(*) from (values ('merchant_communication_text'),('merchant_communication_event')) t(n)
     cross join (values ('anon'),('authenticated')) r(n)
     cross join (values ('INSERT'),('UPDATE'),('DELETE')) p(n)
     where has_table_privilege(r.n, 'public.'||t.n, p.n);")"
assert_eq "[3i] la projection publique est exécutable par anon" "t" \
  "$(sql_value "select has_function_privilege('anon','public.get_restaurant_public_communication_texts(uuid)','EXECUTE');")"
# CFTE-V1-HARNESS-BOOL-RENDER-01 : un booléen transtypé `::text` rend la
# forme canonique SQL 'true'/'false' (et non 't'/'f', qui est le rendu de
# COLONNE employé par les assertions has_table_privilege ci-dessus).
assert_eq "[3j] la preuve d'éligibilité rétractation est réservée à service_role" "false|false|true" \
  "$(sql_value "select has_function_privilege('anon','public.order_has_withdrawal_eligible_line(uuid,uuid)','EXECUTE')::text || '|' ||
                       has_function_privilege('authenticated','public.order_has_withdrawal_eligible_line(uuid,uuid)','EXECUTE')::text || '|' ||
                       has_function_privilege('service_role','public.order_has_withdrawal_eligible_line(uuid,uuid)','EXECUTE')::text;")"
assert_eq "[3k] l'enfilement est réservé à service_role" "false|false|true" \
  "$(sql_value "select has_function_privilege('anon','public.create_order_communication_notification(uuid,uuid,text)','EXECUTE')::text || '|' ||
                       has_function_privilege('authenticated','public.create_order_communication_notification(uuid,uuid,text)','EXECUTE')::text || '|' ||
                       has_function_privilege('service_role','public.create_order_communication_notification(uuid,uuid,text)','EXECUTE')::text;")"
assert_eq "[3l] le CHECK de notification_type porte 12 valeurs, en UN exemplaire" "1" \
  "$(sql_value "select count(*) from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relname='notification_outbox' and con.contype='c' and pg_get_constraintdef(con.oid) like '%notification_type%';")"

# ============================================================
# [4] ISOLATION MULTI-LOCATAIRES.
# ============================================================
log "=== [4] Isolation multi-locataires ==="
assert_eq "[4a] owner A écrit son propre texte" "OK" \
  "$(outcome_as authenticated "$OWNER_A" "select public.set_merchant_communication_text('$RID_A','order_success_title','Merci Alpha !');")"
assert_eq "[4b] manager A écrit aussi" "OK" \
  "$(outcome_as authenticated "$MANAGER_A" "select public.set_merchant_communication_text('$RID_A','checkout_info','Retrait en boutique du mardi au samedi.');")"
assert_eq "[4c] owner B écrit son propre texte" "OK" \
  "$(outcome_as authenticated "$OWNER_B" "select public.set_merchant_communication_text('$RID_B','order_success_title','Merci Beta !');")"
assert_eq "[4d] owner B ne peut PAS écrire chez A" "Forbidden" \
  "$(outcome_as authenticated "$OWNER_B" "select public.set_merchant_communication_text('$RID_A','order_success_title','DETOURNE PAR B');")"
assert_eq "[4e] staff A (rôle insuffisant) ne peut PAS écrire" "Forbidden" \
  "$(outcome_as authenticated "$STAFF_A" "select public.set_merchant_communication_text('$RID_A','order_success_title','DETOURNE PAR STAFF');")"
assert_eq "[4f] anon ne peut PAS écrire" "REFUSE" \
  "$(refused "$(outcome_as anon '' "select public.set_merchant_communication_text('$RID_A','order_success_title','DETOURNE PAR ANON');")")"
assert_eq "[4g] owner A ne LIT que ses propres lignes (RLS)" "2" \
  "$(value_as authenticated "$OWNER_A" "select count(*) from public.merchant_communication_text;")"
assert_eq "[4h] owner B ne LIT que la sienne (RLS)" "1" \
  "$(value_as authenticated "$OWNER_B" "select count(*) from public.merchant_communication_text;")"
assert_eq "[4i] le texte de A n'a PAS été altéré par les tentatives de B et du staff" "MerciAlpha!" \
  "$(value_as authenticated "$OWNER_A" "select body from public.merchant_communication_text where restaurant_id='$RID_A' and text_key='order_success_title';")"
assert_eq "[4j] la projection publique de A ne renvoie QUE les lignes de A" "2" \
  "$(value_as anon '' "select count(*) from public.get_restaurant_public_communication_texts('$RID_A');")"
assert_eq "[4k] la projection publique de A ne contient JAMAIS le texte de B" "0" \
  "$(value_as anon '' "select count(*) from public.get_restaurant_public_communication_texts('$RID_A') where body like '%Beta%';")"
# Un gabarit d'e-mail chez A, puis on vérifie qu'il ne sort PAS.
# Écriture via une SESSION AUTHENTIFIÉE : le RPC exige auth.uid() non nul
# (28000 sinon), exactement comme en production.
EMAIL_TPL_WRITE="$(outcome_as authenticated "$OWNER_A" "select public.set_merchant_communication_text('$RID_A','email_confirmation_subject','SUJET INTERNE ALPHA');")"
assert_eq "[4l-bis] l'écriture du gabarit d'e-mail réussit" "OK" "$EMAIL_TPL_WRITE"
assert_eq "[4l] le gabarit d'e-mail est bien stocké" "SUJETINTERNEALPHA" \
  "$(value_as authenticated "$OWNER_A" "select body from public.merchant_communication_text where restaurant_id='$RID_A' and text_key='email_confirmation_subject';")"
assert_eq "[4m] la projection publique n'expose JAMAIS un gabarit d'e-mail" "0" \
  "$(value_as anon '' "select count(*) from public.get_restaurant_public_communication_texts('$RID_A') where text_key like 'email_%' or text_key = 'confirmation_withdrawal_request';")"
assert_eq "[4n] anon ne peut pas lire la table directement (seule la projection filtrée)" "REFUSE" \
  "$(refused "$(outcome_as anon '' "select count(*) from public.merchant_communication_text;")")"

# ============================================================
# [6]/[7]/[8] LISTE BLANCHE, BORNES, EFFACEMENT.
# ============================================================
log "=== [6][7][8] Liste blanche de variables, bornes, effacement ==="
assert_eq "[6a] un gabarit à variable AUTORISÉE est accepté" "OK" \
  "$(outcome_as authenticated "$OWNER_A" "select public.set_merchant_communication_text('$RID_A','email_confirmation_body','Bonjour, {merchant_name} a recu la commande {order_reference}.');")"
UNKNOWN="$(outcome_as authenticated "$OWNER_A" "select public.set_merchant_communication_text('$RID_A','email_confirmation_body','Bonjour {pirate}.');")"
case "$UNKNOWN" in
  SCANYM_COMMUNICATION_UNKNOWN_VARIABLE*) pass "[6b] une variable HORS liste blanche est refusée à l'écriture" ;;
  *) fail "[6b] variable inconnue non refusée — obtenu '$UNKNOWN'" ;;
esac
assert_eq "[6c] le gabarit refusé n'a RIEN écrasé" "1" \
  "$(value_as authenticated "$OWNER_A" "select (body like '%{merchant_name}%')::int from public.merchant_communication_text where restaurant_id='$RID_A' and text_key='email_confirmation_body';")"
assert_eq "[6d] même service_role ne peut pas insérer un gabarit à jeton inconnu (contrainte de TABLE)" "REFUSE" \
  "$(refused "$(outcome_as service_role '' "insert into public.merchant_communication_text (restaurant_id, text_key, body) values ('$RID_A','slot_warning','{pirate}');")")"
UNKNOWN_KEY="$(outcome_as authenticated "$OWNER_A" "select public.set_merchant_communication_text('$RID_A','pirate_key','x');")"
case "$UNKNOWN_KEY" in
  SCANYM_COMMUNICATION_UNKNOWN_TEXT_KEY*) pass "[6e] un emplacement hors catalogue est refusé" ;;
  *) fail "[6e] emplacement inconnu non refusé — obtenu '$UNKNOWN_KEY'" ;;
esac
TOO_LONG="$(outcome_as authenticated "$OWNER_A" "select public.set_merchant_communication_text('$RID_A','email_confirmation_subject', repeat('s', 161));")"
case "$TOO_LONG" in
  SCANYM_COMMUNICATION_TEXT_TOO_LONG*) pass "[7a] un SUJET de 161 caractères est refusé (borne 160)" ;;
  *) fail "[7a] sujet trop long non refusé — obtenu '$TOO_LONG'" ;;
esac
assert_eq "[7b] la MÊME longueur est valide pour un CORPS (borne 500)" "OK" \
  "$(outcome_as authenticated "$OWNER_A" "select public.set_merchant_communication_text('$RID_A','order_success_body', repeat('b', 161));")"
TOO_LONG2="$(outcome_as authenticated "$OWNER_A" "select public.set_merchant_communication_text('$RID_A','order_success_body', repeat('b', 501));")"
case "$TOO_LONG2" in
  SCANYM_COMMUNICATION_TEXT_TOO_LONG*) pass "[7c] un corps de 501 caractères est refusé (borne 500)" ;;
  *) fail "[7c] corps trop long non refusé — obtenu '$TOO_LONG2'" ;;
esac
# DEUX instructions séparées, et non une sous-requête du même ordre SQL :
# l'effet d'une fonction volatile n'est pas visible par les autres parties
# de l'ordre qui l'appelle (même instantané de lecture). Les confondre
# ferait lire l'état d'AVANT et conclure à tort.
assert_eq "[8a-bis] l'effacement par corps BLANC est accepté" "OK" \
  "$(outcome_as authenticated "$OWNER_A" "select public.set_merchant_communication_text('$RID_A','order_success_body','   ');")"
assert_eq "[8a] un corps BLANC supprime la ligne (repli générique)" "0" \
  "$(value_as authenticated "$OWNER_A" "select count(*) from public.merchant_communication_text where restaurant_id='$RID_A' and text_key='order_success_body';")"
assert_eq "[8b-bis] l'effacement par corps NULL est accepté" "OK" \
  "$(outcome_as authenticated "$OWNER_A" "select public.set_merchant_communication_text('$RID_A','checkout_info',null);")"
assert_eq "[8b] un corps NULL supprime aussi la ligne" "0" \
  "$(value_as authenticated "$OWNER_A" "select count(*) from public.merchant_communication_text where restaurant_id='$RID_A' and text_key='checkout_info';")"

# ============================================================
# [9] PREUVE D'ÉLIGIBILITÉ RÉTRACTATION — lecture seule, fail-closed.
# ============================================================
log "=== [9] Éligibilité à la rétractation ==="
assert_eq "[9a] l'instantané par ligne existe bien (1 ligne rétractable chez A)" "1" \
  "$(sql_value "select count(*) from public.order_items where order_id='$ORDER_A' and withdrawal_eligible_at_order_time is true;")"
assert_eq "[9b] couple (commande, jeton) VALIDE => true" "t" \
  "$(value_as service_role '' "select public.order_has_withdrawal_eligible_line('$ORDER_A','$TOKEN_A');")"
assert_eq "[9c] jeton ERRONÉ => false (fail-closed, et aucune erreur révélatrice)" "f" \
  "$(value_as service_role '' "select public.order_has_withdrawal_eligible_line('$ORDER_A','00000000-0000-4000-8000-000000000000');")"
assert_eq "[9d] commande INCONNUE => false" "f" \
  "$(value_as service_role '' "select public.order_has_withdrawal_eligible_line('00000000-0000-4000-8000-0000000000ff','$TOKEN_A');")"
TOKEN_B="$(sql_value "select public_token from public.orders where id = '$ORDER_B';")"
assert_eq "[9e] commande B (aucune ligne rétractable) => false" "f" \
  "$(value_as service_role '' "select public.order_has_withdrawal_eligible_line('$ORDER_B','$TOKEN_B');")"
# La fixture est posée par la connexion PROPRIÉTAIRE du harnais :
# service_role contourne la RLS mais n'a AUCUN grant de table sur
# order_items -- ce qui est la posture voulue, pas un obstacle.
psql -X -d "$DB" -c "update public.order_items set withdrawal_eligible_at_order_time = null where order_id='$ORDER_A';" >/dev/null 2>&1
assert_eq "[9f] un instantané NULL ne vaut PAS éligible" "f" \
  "$(value_as service_role '' "select public.order_has_withdrawal_eligible_line('$ORDER_A','$TOKEN_A');")"
# Remise en état de la fixture pour la suite.
psql -X -d "$DB" -c "update public.order_items set withdrawal_eligible_at_order_time = true where order_id='$ORDER_A' and menu_item_id='$ITEM_A';" >/dev/null 2>&1
assert_eq "[9g] la fonction n'écrit RIEN (elle est déclarée STABLE, pas VOLATILE)" "s" \
  "$(sql_value "select provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='order_has_withdrawal_eligible_line';")"

# ============================================================
# [5] ÉVÉNEMENTS FERMÉS AU REPOS + [10] IDEMPOTENCE.
# ============================================================
log "=== [5] Événements fermés au repos / [10] idempotence ==="
# notification_outbox est RPC-only : AUCUN grant de table, pas même pour
# service_role. L'enfilement se fait donc sous service_role (qui a
# l'EXECUTE), et la LECTURE de preuve sous la connexion propriétaire du
# harnais -- jamais en élargissant un grant pour la commodité du test.
assert_eq "[5a-bis] l'enfilement sans interrupteur réussit" "OK" \
  "$(outcome_as service_role '' "select public.create_order_communication_notification('$ORDER_A','$RID_A','carrier_handoff');")"
assert_eq "[5a] sans interrupteur, l'enfilement produit 'skipped_disabled'" "skipped_disabled" \
  "$(sql_value "select status from public.notification_outbox where order_id='$ORDER_A' and notification_type='carrier_handoff';")"
assert_eq "[5b] un événement hors catalogue est refusé" "REFUSE" \
  "$(refused "$(outcome_as service_role '' "select public.create_order_communication_notification('$ORDER_A','$RID_A','pirate_event');")")"
assert_eq "[5c] substitution tenant croisée refusée" "REFUSE" \
  "$(refused "$(outcome_as service_role '' "select public.create_order_communication_notification('$ORDER_B','$RID_A','carrier_handoff');")")"
assert_eq "[5d] owner A active l'événement" "OK" \
  "$(outcome_as authenticated "$OWNER_A" "select public.set_merchant_communication_event_enabled('$RID_A','local_delivery_handoff',true);")"
assert_eq "[5e-bis] l'enfilement de l'événement activé réussit" "OK" \
  "$(outcome_as service_role '' "select public.create_order_communication_notification('$ORDER_A','$RID_A','local_delivery_handoff');")"
assert_eq "[5e] événement ACTIVÉ => 'pending'" "pending" \
  "$(sql_value "select status from public.notification_outbox where order_id='$ORDER_A' and notification_type='local_delivery_handoff';")"
assert_eq "[5f-bis] la désactivation est acceptée" "OK" \
  "$(outcome_as authenticated "$OWNER_A" "select public.set_merchant_communication_event_enabled('$RID_A','local_delivery_handoff',false);")"
assert_eq "[5f] désactiver SUPPRIME la ligne (« absent » et « désactivé » sont un seul état)" "0" \
  "$(value_as authenticated "$OWNER_A" "select count(*) from public.merchant_communication_event where restaurant_id='$RID_A' and event_code='local_delivery_handoff';")"
assert_eq "[10a] un second enfilement du MÊME événement renvoie NULL (rejeu idempotent)" "" \
  "$(value_as service_role '' "select coalesce(public.create_order_communication_notification('$ORDER_A','$RID_A','local_delivery_handoff')::text,'');")"
assert_eq "[10b] et ne crée AUCUN doublon en file" "1" \
  "$(sql_value "select count(*) from public.notification_outbox where order_id='$ORDER_A' and notification_type='local_delivery_handoff';")"
assert_eq "[10c] l'unicité logique qui porte l'idempotence est toujours là" "1" \
  "$(sql_value "select count(*) from pg_constraint where conname='notification_outbox_logical_uniqueness';")"
# v1.1 — ferme MCC-V1-WITHDRAWAL-TEMPLATE-UNUSED-01 : l'instantané d'un
# événement additionnel porte LE gabarit de CET événement, et AUCUNE des
# clés génériques de l'e-mail de confirmation de commande.
assert_eq "[10d] l'instantané porte le gabarit propre à l'événement" "1" \
  "$(sql_value "select (payload_snapshot ? 'event_body_template')::int from public.notification_outbox where order_id='$ORDER_A' and notification_type='local_delivery_handoff';")"
assert_eq "[10d-bis] et AUCUNE clé générique ni clé morte" "0|0|0" \
  "$(sql_value "select (payload_snapshot ? 'subject_template')::int || '|' ||
                       (payload_snapshot ? 'body_template')::int || '|' ||
                       (payload_snapshot ? 'withdrawal_template')::int
                from public.notification_outbox where order_id='$ORDER_A' and notification_type='local_delivery_handoff';")"
assert_eq "[10e] l'éligibilité rétractation est figée dans l'instantané (true chez A)" "true" \
  "$(sql_value "select payload_snapshot->>'withdrawal_eligible' from public.notification_outbox where order_id='$ORDER_A' and notification_type='local_delivery_handoff';")"
assert_eq "[10f] les coordonnées PUBLIQUES du commerçant sont figées, jamais l'identité d'expédition" "contact@alpha.test" \
  "$(sql_value "select payload_snapshot->>'merchant_email' from public.notification_outbox where order_id='$ORDER_A' and notification_type='local_delivery_handoff';")"

# ============================================================
# [11] REDÉFINITION STRICTEMENT ADDITIVE.
# ============================================================
log "=== [11] create_order_received_notification : additive ==="
psql -X -d "$DB" -c "delete from public.notification_outbox where order_id='$ORDER_A' and notification_type='order_received';" >/dev/null 2>&1
OUTBOX_ID="$(value_as service_role '' "select public.create_order_received_notification('$ORDER_A','$RID_A');")"
case "$OUTBOX_ID" in
  *-*) pass "[11a] l'enfilement order_received fonctionne toujours" ;;
  *) fail "[11a] enfilement order_received cassé — obtenu '$OUTBOX_ID'" ;;
esac
assert_eq "[11b] le payload porte 17 clés (les 10 d'avant + les 7 de ce lot)" "17" \
  "$(sql_value "select count(*) from jsonb_object_keys((select payload_snapshot from public.notification_outbox where order_id='$ORDER_A' and notification_type='order_received')) k;")"
assert_eq "[11c] les 10 clés N1-A/CFTE sont TOUTES encore là" "10" \
  "$(sql_value "select count(*) from jsonb_object_keys((select payload_snapshot from public.notification_outbox where order_id='$ORDER_A' and notification_type='order_received')) k
     where k in ('order_number','total','currency','service_mode','public_token','created_at','order_status','status_text_override','delivery_address','merchant_name');")"
assert_eq "[11d] les 7 clés de CE lot sont là" "7" \
  "$(sql_value "select count(*) from jsonb_object_keys((select payload_snapshot from public.notification_outbox where order_id='$ORDER_A' and notification_type='order_received')) k
     where k in ('subject_template','body_template','merchant_address','merchant_email','merchant_phone','invoice_requested','withdrawal_eligible');")"
assert_eq "[11e] le gabarit marchand FIGÉ est bien celui du commerçant A" "SUJET INTERNE ALPHA" \
  "$(sql_raw "select payload_snapshot->>'subject_template' from public.notification_outbox where order_id='$ORDER_A' and notification_type='order_received';")"
assert_eq "[11f] le rejeu renvoie NULL (rejeu idempotent)" "" \
  "$(value_as service_role '' "select coalesce(public.create_order_received_notification('$ORDER_A','$RID_A')::text,'');")"
assert_eq "[11f-bis] et ne crée AUCUN doublon" "1" \
  "$(sql_value "select count(*) from public.notification_outbox where order_id='$ORDER_A' and notification_type='order_received';")"
assert_eq "[11g] la substitution tenant croisée reste refusée" "REFUSE" \
  "$(refused "$(outcome_as service_role '' "select public.create_order_received_notification('$ORDER_B','$RID_A');")")"
assert_eq "[11h-bis] l'enfilement chez B (aucun gabarit configuré) réussit" "OK" \
  "$(outcome_as service_role '' "select public.create_order_received_notification('$ORDER_B','$RID_B');")"
assert_eq "[11h] un commerçant SANS gabarit reçoit un instantané à gabarits NULS (repli générique)" "||false" \
  "$(sql_value "select coalesce(payload_snapshot->>'subject_template','') || '|' || coalesce(payload_snapshot->>'body_template','') || '|' ||
                       coalesce(payload_snapshot->>'withdrawal_eligible','')
                from public.notification_outbox where order_id='$ORDER_B' and notification_type='order_received';")"

# ============================================================
# [14] CARTOGRAPHIE ÉVÉNEMENT -> GABARIT, ET INSTANTANÉ FIGÉ.
#      Ferme MCC-V1-WITHDRAWAL-TEMPLATE-UNUSED-01 (blocker 2).
# ============================================================
log "=== [14] Cartographie événement -> gabarit / instantané figé ==="
assert_eq "[14a] la cartographie est TOTALE sur les 3 événements" "3" \
  "$(sql_value "select count(*) from unnest(public.communication_event_codes()) e
                where public.communication_event_body_text_key(e) is not null;")"
assert_eq "[14b] elle désigne les emplacements ATTENDUS, et eux seuls" \
  "carrier_handoff=confirmation_delivery_carrier,local_delivery_handoff=confirmation_delivery_local,withdrawal_request_received=confirmation_withdrawal_request" \
  "$(sql_value "select string_agg(e || '=' || public.communication_event_body_text_key(e), ',' order by e)
                from unnest(public.communication_event_codes()) e;")"
assert_eq "[14c] elle n'emprunte JAMAIS les clés de l'e-mail de confirmation de commande" "0" \
  "$(sql_value "select count(*) from unnest(public.communication_event_codes()) e
                where public.communication_event_body_text_key(e) in ('email_confirmation_subject','email_confirmation_body');")"
assert_eq "[14d] un code hors catalogue n'a AUCUN gabarit (fermé au repos)" "0" \
  "$(sql_value "select count(*) from (values ('order_received'),('pirate_event'),(null)) v(c)
                where public.communication_event_body_text_key(v.c) is not null;")"

# L'accusé de rétractation du commerçant est RÉELLEMENT figé pour son
# propre événement -- c'est le cœur du blocker 2.
psql -X -d "$DB" -c "select public.set_merchant_communication_text('$RID_A','confirmation_withdrawal_request','ACCUSE ALPHA v1');" >/dev/null 2>&1   || true
assert_eq "[14e] le commerçant enregistre son accusé de rétractation" "OK" \
  "$(outcome_as authenticated "$OWNER_A" "select public.set_merchant_communication_text('$RID_A','confirmation_withdrawal_request','ACCUSE ALPHA v1');")"
assert_eq "[14f] activer l'événement de rétractation" "OK" \
  "$(outcome_as authenticated "$OWNER_A" "select public.set_merchant_communication_event_enabled('$RID_A','withdrawal_request_received',true);")"
assert_eq "[14g] l'enfilement réussit" "OK" \
  "$(outcome_as service_role '' "select public.create_order_communication_notification('$ORDER_A','$RID_A','withdrawal_request_received');")"
assert_eq "[14h] l'instantané porte l'accusé de rétractation DU COMMERÇANT" "ACCUSE ALPHA v1" \
  "$(sql_raw "select payload_snapshot->>'event_body_template' from public.notification_outbox where order_id='$ORDER_A' and notification_type='withdrawal_request_received';")"

# INSTANTANÉ FIGÉ : changer le gabarit APRÈS l'enfilement ne doit pas
# changer le message déjà en file (mandat : « changing the merchant
# template after enqueue does not change the queued message »).
assert_eq "[14i] le commerçant change son accusé APRÈS l'enfilement" "OK" \
  "$(outcome_as authenticated "$OWNER_A" "select public.set_merchant_communication_text('$RID_A','confirmation_withdrawal_request','ACCUSE ALPHA MODIFIE APRES COUP');")"
assert_eq "[14j] la ligne EN FILE porte toujours l'ancien texte -- instantané FIGÉ" "ACCUSE ALPHA v1" \
  "$(sql_raw "select payload_snapshot->>'event_body_template' from public.notification_outbox where order_id='$ORDER_A' and notification_type='withdrawal_request_received';")"
assert_eq "[14k] et la configuration courante, elle, a bien changé" "ACCUSE ALPHA MODIFIE APRES COUP" \
  "$(value_as_raw authenticated "$OWNER_A" "select body from public.merchant_communication_text where restaurant_id='$RID_A' and text_key='confirmation_withdrawal_request';")"

# Un événement de LIVRAISON ne reçoit PAS l'accusé de rétractation.
assert_eq "[14l] carrier_handoff ne reçoit PAS l'accusé de rétractation" "1" \
  "$(sql_value "select (coalesce(payload_snapshot->>'event_body_template','') <> 'ACCUSE ALPHA v1')::int
                from public.notification_outbox where order_id='$ORDER_A' and notification_type='carrier_handoff';")"
# Et l'e-mail de confirmation de commande n'en reçoit pas non plus : son
# instantané ne porte même pas la clé d'événement.
assert_eq "[14m] order_received ne porte AUCUN gabarit d'événement" "0" \
  "$(sql_value "select (payload_snapshot ? 'event_body_template')::int
                from public.notification_outbox where order_id='$ORDER_A' and notification_type='order_received';")"

# ============================================================
# [13] LE ROLLBACK REFUSE PLUTÔT QUE D'ÉCHOUER À MI-PARCOURS.
# ============================================================
log "=== [13] Rollback bloqué par une ligne d'un type ajouté ==="
if apply_path "$SUPABASE_DIR/DRAFT-lot-merchant-customer-communications-v1-rollback.sql" "$DB_FWD"; then
  fail "[13] le rollback s'est appliqué alors qu'une ligne 'local_delivery_handoff' existe"
else
  if grep -q 'SCANYM_ROLLBACK_BLOCKED' "$OUT"; then
    pass "[13] le rollback REFUSE explicitement, en nommant la cause"
  else
    fail "[13] le rollback a échoué sans message SCANYM_ROLLBACK_BLOCKED : $(grep -m1 ERROR "$OUT" | tr '\n' ' ')"
  fi
fi
assert_eq "[13a] et il n'a RIEN retiré au passage" "1" \
  "$(sql_value "select (to_regclass('public.merchant_communication_text') is not null)::int;")"

# ============================================================
# [12] ROLLBACK — s'applique et restaure.
# ============================================================
log "=== [12] Rollback et réversibilité ==="
clone_base "$DB_RB"
apply_path "$SUPABASE_DIR/DRAFT-lot-merchant-customer-communications-v1.sql" "$DB_RB" \
  || fatal "aller sur $DB_RB impossible : $(grep -m1 ERROR "$OUT" | tr '\n' ' ')"
# Quelques lignes de configuration, pour prouver que le retour les
# emporte VOLONTAIREMENT (perte assumée et documentée).
psql -X -d "$DB_RB" -c "select public.set_merchant_communication_text('$RID_A','order_success_title','Merci Alpha !');" >/dev/null 2>&1
psql -X -d "$DB_RB" -c "select public.set_merchant_communication_event_enabled('$RID_A','carrier_handoff',true);" >/dev/null 2>&1
if apply_path "$SUPABASE_DIR/DRAFT-lot-merchant-customer-communications-v1-rollback.sql" "$DB_RB"; then
  pass "[12] le rollback s'applique"
else
  fail "[12] le rollback ÉCHOUE : $(grep -m1 ERROR "$OUT" | tr '\n' ' ')"
fi
assert_eq "[12a] create_order_received_notification est revenue à l'EMPREINTE CFTE v1" \
  "$BASE_FN_CORN" "$(fn_code_fingerprint 'create_order_received_notification' "$DB_RB")"
assert_eq "[12b] les comptes de schéma sont identiques au prédécesseur" "$BASE_COUNTS" "$(schema_counts "$DB_RB")"
assert_eq "[12c] le CHECK de notification_type refuse de nouveau les 3 types ajoutés" "0" \
  "$(sql_on "$DB_RB" "select count(*) from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relname='notification_outbox' and con.conname='notification_outbox_notification_type_check'
       and pg_get_constraintdef(con.oid) like '%carrier_handoff%';")"
assert_eq "[12d] AUCUNE commande perdue" "$BASE_ORDERS" "$(sql_on "$DB_RB" "select count(*) from public.orders;")"
assert_eq "[12d-bis] la cartographie événement -> gabarit a disparu" "0" \
  "$(sql_on "$DB_RB" "select (to_regprocedure('public.communication_event_body_text_key(text)') is not null)::int;")"
assert_eq "[12e] merchant_tracking_status_text (préexistante) est intacte" "1" \
  "$(sql_on "$DB_RB" "select (to_regclass('public.merchant_tracking_status_text') is not null)::int;")"
assert_eq "[12f] withdrawal_requests (préexistante) est intacte" "1" \
  "$(sql_on "$DB_RB" "select (to_regclass('public.withdrawal_requests') is not null)::int;")"
assert_eq "[12g] l'instantané d'éligibilité par ligne est intact" "1" \
  "$(sql_on "$DB_RB" "select count(*) from public.order_items where order_id='$ORDER_A' and withdrawal_eligible_at_order_time is true;")"

# ============================================================
# BILAN
# ============================================================
LOGGED_FAILURES="$(wc -l < "$FAIL_LOG" | tr -d ' ')"
log "=== BILAN : $PASS_COUNT preuve(s) produite(s), $FAIL_COUNT échec(s) ==="
if [ "$LOGGED_FAILURES" != "$FAIL_COUNT" ]; then
  log "FATAL: journal d'échecs incohérent ($LOGGED_FAILURES lignes pour $FAIL_COUNT échecs) -- bilan non fiable."
  exit 1
fi
if [ "$FAIL_COUNT" -ne 0 ]; then
  log "--- échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
[ "$PASS_COUNT" -gt 0 ] || { log "FATAL: aucune preuve produite."; exit 1; }
exit 0
