#!/usr/bin/env bash
# ============================================================
# Scanym — CHECKOUT SCHEDULING v1.2 (CSDJ v1.2)
# Harnais PostgreSQL 16 JETABLE pour
#   supabase/DRAFT-lot-checkout-scheduling-calendars-capacity-v1-2.sql
#   supabase/DRAFT-lot-checkout-scheduling-calendars-capacity-v1-2-rollback.sql
#
# Enveloppe de sûreté, cluster jetable, preuve d'identité, chaîne
# prédécesseur RÉELLE et fixtures : REPRISES VERBATIM du harnais CSDJ-1
# (checkout-scheduling-foundation-v1-check.sh) -- seuls les noms de bases
# changent. L'état de départ des preuves est celui de la PROD : chaîne
# prédécesseur + CSDJ-1 v1.10 appliqué, tables de configuration vides.
#
# CE QUE CE HARNAIS PROUVE (exécuté, jamais inspecté)
#   [0b] l'état PROD de référence + le comportement CSDJ-1 AVANT migration
#   [1]  la v1.2 s'applique sur l'état PROD
#   [2]  atomicité : une erreur en fin de fichier ne laisse RIEN
#        (renommage du résolveur compris)
#   [14] pré-vol : refus nommé sans CSDJ-1 ; double application refusée
#        sans rien changer
#   [15] PÉRIMÈTRE EXACT : inventaire complet (corps de fonctions par
#        md5 + droits, colonnes, contraintes, politiques, déclencheurs,
#        droits de table) avant/après -- une seule ligne disparaît (le
#        résolveur, remplacé par le répartiteur) ; create_order,
#        update_order_status, le moteur de paiement et l'autorité de
#        tarification sont INCHANGÉS ; le contrat public est inchangé
#   [3]  RLS / grants / ACL de fonctions / catalogues / absence de donnée
#   [4]  le répartiteur rend, pour toute planification v1, EXACTEMENT les
#        mêmes octets qu'avant (fixture CSDJ-1 rejouée avant/après)
#   [5]  la fixture v1.2 (oracle Python INDÉPENDANT, réponses dérivées à
#        la main) rejouée contre le SQL : cutoff exact, samedi, dimanche,
#        lundi, fermetures de préparation et de disponibilité, fériés
#        synthétiques, DST, fuseaux, capacité
#   [6]  lecture publique : dates pleines retirées, aucun compte exposé
#   [7]  écriture marchande : ACL, validations, isolation de tenant
#   [10] RLS / isolation multi-locataires
#   [8]  capacité : une commande = une unité quelle que soit la quantité,
#        seaux (date, créneau), erreurs d'usage, tenant, isolation
#   [8b] libération par le CYCLE DE VIE RÉEL (update_order_status)
#   [9]  CONCURRENCE RÉELLE : sessions psql distinctes derrière une
#        barrière de départ prouvée par pg_stat_activity ; blocage
#        observé (Lock/advisory) ; rollback ; seaux indépendants
#   [16] contrôles par mutation : chaque détecteur voit un mutant
#   [13] retour arrière : refus explicites, fidélité EXACTE à l'état
#        d'avant, aller/retour/aller convergent
#
# CE QU'IL NE FAIT PAS : aucun appel réseau, aucune base hébergée,
# aucune donnée réelle, aucun jour férié réel, aucune écriture hors des
# bases jetables qu'il crée lui-même. Il ne prouve PAS l'intégration à
# create_order (CSDJ-3, Debussy) : voir docs/scheduling/.
#
# Usage (un cluster jetable, utilisateur non root) :
#   SCANYM_DISPOSABLE_CLUSTER=1 \
#     bash supabase/tests/checkout-scheduling-v12-check.sh
# Sortie : 0 = toutes les preuves produites ; 1 = au moins un échec ;
#          2 = cible refusée (sûreté).
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
export PGAPPNAME="scanym-csdj12-harness"

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
DB_BASE="scanym_csdj12_base_$RUN_TAG"     # prédécesseur SANS CSDJ-1
DB_V1="scanym_csdj12_v1_$RUN_TAG"         # prédécesseur + CSDJ-1 v1.10 (état de la PROD)
DB_FWD="scanym_csdj12_fwd_$RUN_TAG"       # + v1.2
DB_ATOMIC="scanym_csdj12_atomic_$RUN_TAG"
DB_RB="scanym_csdj12_rb_$RUN_TAG"
DB_PRE="scanym_csdj12_pre_$RUN_TAG"       # v1.2 sur un schéma SANS CSDJ-1 (pré-vol)
DB_MUT="scanym_csdj12_mut_$RUN_TAG"       # mutants (recréée pour chaque mutant)

# Et si malgré tout l'un de ces noms existe déjà, le harnais REFUSE :
# il ne peut pas prouver qu'il en est le propriétaire, donc il n'y
# touche pas. Jamais un `drop database` sur une base qu'il n'a pas créée.
for d in "$DB_BASE" "$DB_V1" "$DB_FWD" "$DB_ATOMIC" "$DB_RB" "$DB_PRE" "$DB_MUT"; do
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

IDENTITY_MARKER="scanym_csdj12_identity_$RUN_TAG"
IDENTITY_NONCE="csdj12-$RUN_TAG-$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
[ -n "${IDENTITY_NONCE#csdj12-$RUN_TAG-}" ] || IDENTITY_NONCE="csdj12-$RUN_TAG-$$"
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

FIXTURE_V1_JSON="$SCRIPT_DIR/../../tests/fixtures/checkout-scheduling-cases.json"
FIXTURE_JSON="$SCRIPT_DIR/../../tests/fixtures/checkout-scheduling-v12-cases.json"
[ -f "$FIXTURE_V1_JSON" ] || fatal "fixture CSDJ-1 absente : tests/fixtures/checkout-scheduling-cases.json"
[ -f "$FIXTURE_JSON" ] || fatal "fixture v1.2 absente : tests/fixtures/checkout-scheduling-v12-cases.json"
REPLAY_V12_GEN="$SCRIPT_DIR/checkout-scheduling-v12-replay-gen.py"
REPLAY_V1_GEN="$SCRIPT_DIR/checkout-scheduling-v1-replay-gen.py"
[ -f "$REPLAY_V12_GEN" ] && [ -f "$REPLAY_V1_GEN" ] || fatal "générateurs de rejeu absents."
V1_SQL="DRAFT-lot-checkout-scheduling-foundation-v1.sql"
LOT_SQL="DRAFT-lot-checkout-scheduling-calendars-capacity-v1-2.sql"
LOT_ROLLBACK="DRAFT-lot-checkout-scheduling-calendars-capacity-v1-2-rollback.sql"

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
# Outils propres à la v1.2
# ============================================================
own_out()   { psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$1" -c "$2" 2>&1; }
# "OK" ou le premier message d'erreur, pour une base désignée.
outcome_on() {
  local out rc
  out="$(psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$1" -c "$2" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then printf 'OK\n'; return 0; fi
  out="${out#*ERROR:  }"; out="${out%%$'\n'*}"; printf '%s\n' "$out"
}
# Vrai si le résultat de outcome_* contient le motif littéral.
has() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
assert_has() {
  local desc="$1" needle="$2" got="$3"
  if has "$got" "$needle"; then pass "$desc"; else fail "$desc — attendu un message contenant '$needle', obtenu '$got'"; fi
}

# Fonctions internes : exécutables par le seul propriétaire (la RPC
# create_order, SECURITY DEFINER, est leur futur appelant).
CAP_NOW="2026-10-13T09:00:00+02:00"
CAP_DATE="2026-10-14"

# Planification v1.2 de test, déterministe (heure injectée, jamais l'horloge).
#   $1 base  $2 restaurant  $3 capacité (entier) ou "off"  $4 mode créneaux : none|fixed_slots
cap_reset() {
  local db="$1" rid="$2" cap="$3" slots="${4:-none}" en="true" capv="$3"
  [ "$cap" = "off" ] && { en="false"; capv="null"; }
  psql -X -d "$db" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<SQL || fatal "cap_reset($db,$rid,$cap,$slots) : $(tr '\n' ' ' < "$ERR")"
delete from public.order_fulfillment_capacity_reservation where restaurant_id = '$rid';
delete from public.orders where restaurant_id = '$rid';
delete from public.restaurant_fulfillment_schedule where restaurant_id = '$rid';
insert into public.restaurant_fulfillment_schedule
  (restaurant_id, mode_code, timezone, enabled, date_selection_mode, slot_selection_mode,
   min_lead_days, cutoff_time, cutoff_offset_days, booking_horizon_days, schedule_method_version,
   capacity_enabled, capacity_max_orders)
values ('$rid','pickup','Europe/Paris',true,'customer_selectable','$slots',1,'10:00',0,14,'v1.2',$en,$capv);
insert into public.restaurant_fulfillment_prep_day
  select '$rid','pickup','$NIL_RULE', g from generate_series(0,6) g;
insert into public.restaurant_fulfillment_schedule_window (restaurant_id, mode_code, rule_key, weekday, starts_at, ends_at)
  select '$rid','pickup','$NIL_RULE', g, '11:00','14:00' from generate_series(0,6) g where '$slots' <> 'fixed_slots';
insert into public.restaurant_fulfillment_schedule_slot (restaurant_id, mode_code, rule_key, weekday, slot_key, starts_at, ends_at)
  select '$rid','pickup','$NIL_RULE', g, k, s::time, e::time
  from generate_series(0,6) g, (values ('s1','11:00','12:30'),('s2','12:30','14:00')) v(k,s,e)
  where '$slots' = 'fixed_slots';
SQL
}
# $1 base  $2 restaurant  $3 nombre  [$4 statut]  [$5 paiement]  -> un id par ligne
mk_orders() {
  psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$1" -c "
    insert into public.orders (restaurant_id, order_number, service_mode, subtotal, total, currency, status, payment_status)
    select '$2', coalesce((select max(order_number) from public.orders where restaurant_id='$2'),0) + g,
           'pickup', 1, 1, 'EUR', '${4:-new}', '${5:-not_required}'
    from generate_series(1,$3) g returning id" 2>"$ERR"
}
# $1 base $2 commande $3 restaurant $4 date $5 créneau ('-' = aucun)  -> "résultat|motif" ou SQL_ERROR
rsv() {
  local slot="null"; [ "$5" != "-" ] && slot="'$5'"
  sql_on "$1" "select result || '|' || coalesce(reason,'-') from public.reserve_fulfillment_capacity('$2','$3','pickup',null,'$4',$slot,'$CAP_NOW'::timestamptz);"
}
used_in() { # $1 base $2 restaurant $3 date $4 créneau ('' = date entière)
  sql_on "$1" "select public.fulfillment_capacity_used('$2','pickup','$NIL_RULE','$3','$4');"
}
reservations_in() { sql_on "$1" "select count(*) from public.order_fulfillment_capacity_reservation where restaurant_id='$2';"; }

# ------------------------------------------------------------------
# CONCURRENCE RÉELLE — plusieurs SESSIONS psql, donc plusieurs backends
# PostgreSQL distincts, lancées derrière une barrière de départ.
#
# La barrière est un verrou consultatif : le maître le prend en exclusif,
# chaque session le demande en partagé et BLOQUE ; le maître ne le lâche
# que lorsque pg_stat_activity montre les N sessions en attente. Elles
# démarrent donc ensemble, et ce n'est pas un `sleep` qui le promet.
#
# conc_run <base> <secondes_de_garde> <commit|rollback>   (stdin : "commande restaurant date créneau")
# Résultat : $CONC_OUT, une ligne par session « idx|R|résultat|motif » ou « idx|ERROR... ».
# ------------------------------------------------------------------
CONC_OUT=""
conc_run() {
  local db="$1" hold="$2" final="$3" key=$((7000000 + RANDOM)) n=0 idx=0 l o r d s slot waited=0
  local -a lines=()
  while IFS= read -r l; do [ -n "$l" ] && lines+=("$l"); done
  n=${#lines[@]}
  CONC_OUT="$TMP_DIR/conc.$RANDOM.$RANDOM"; : > "$CONC_OUT"
  ( psql -X -A -q -t -d "$db" >/dev/null 2>&1 <<SQL
select pg_advisory_lock($key);
do \$\$ declare t timestamptz := clock_timestamp(); begin
  loop
    exit when (select count(*) from pg_stat_activity
               where wait_event_type = 'Lock' and wait_event = 'advisory'
                 and query like '%pg_advisory_lock_shared($key)%') >= $n
           or clock_timestamp() - t > interval '30 seconds';
    -- pg_stat_activity est figée pour la durée d'une TRANSACTION : sans
    -- cet effacement la boucle ne verrait jamais les sessions en attente.
    perform pg_stat_clear_snapshot();
    perform pg_sleep(0.02);
  end loop; end \$\$;
select pg_advisory_unlock($key);
SQL
  ) &
  # Le maître DOIT tenir la barrière avant que le premier travailleur ne parte.
  while [ "$(sql_on "$db" "select count(*) from pg_locks where locktype='advisory' and granted and mode='ExclusiveLock' and objid=$key;")" != "1" ]; do
    waited=$((waited + 1)); [ "$waited" -gt 300 ] && fatal "barrière de concurrence jamais prise."
    sleep 0.02
  done
  for l in "${lines[@]}"; do
    idx=$((idx + 1))
    read -r o r d s <<<"$l"
    slot="null"; [ "$s" != "-" ] && slot="'$s'"
    ( psql -X -A -q -t -d "$db" 2>&1 <<SQL | grep -E '^(R\||ERROR)' | sed "s/^/$idx|/" >> "$CONC_OUT"
begin;
select pg_advisory_lock_shared($key);
select pg_advisory_unlock_shared($key);
select 'R|' || result || '|' || coalesce(reason,'-') from public.reserve_fulfillment_capacity('$o','$r','pickup',null,'$d',$slot,'$CAP_NOW'::timestamptz);
select pg_sleep($hold);
$final;
SQL
    ) &
  done
  wait
}
conc_count() { grep -c "^[0-9]*|R|$1\$" "$CONC_OUT" 2>/dev/null || true; }

# ============================================================
# [0b] L'état PRÉDÉCESSEUR RÉEL : prédécesseur + CSDJ-1 v1.10
# ============================================================
log "=== [0b] État PROD : prédécesseur + CSDJ-1 v1.10 ($DB_V1) ==="
clone_base "$DB_V1"
apply_path "$SUPABASE_DIR/$V1_SQL" "$DB_V1" || fatal "CSDJ-1 v1.10 ne s'applique pas sur le prédécesseur : $(tail -3 "$OUT" | tr '\n' ' ')"
V1_COUNTS="$(schema_counts "$DB_V1")"
log "CSDJ-1 appliqué ; comptes de schéma de référence : $V1_COUNTS"

# Inventaires de référence (avant la v1.2), pour prouver qu'AUCUN objet
# préexistant n'a bougé hors du périmètre annoncé.
inventory() { # $1 = base ; fonctions, colonnes, contraintes, politiques, déclencheurs, droits de table
  local db="$1"
  psql -X -A -q -t -d "$db" -c "select 'F|' || p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|' || coalesce(p.proacl::text,'-') || '|' || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig,','),'-') from pg_proc p where p.pronamespace='public'::regnamespace order by 1"
  psql -X -A -q -t -d "$db" -c "select 'C|' || table_name || '|' || column_name || '|' || data_type || '|' || is_nullable || '|' || coalesce(column_default,'-') from information_schema.columns where table_schema='public' order by 1"
  psql -X -A -q -t -d "$db" -c "select 'K|' || conrelid::regclass::text || '|' || conname || '|' || pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace order by 1"
  psql -X -A -q -t -d "$db" -c "select 'P|' || tablename || '|' || policyname || '|' || cmd || '|' || coalesce(qual,'-') || '|' || coalesce(with_check,'-') from pg_policies where schemaname='public' order by 1"
  psql -X -A -q -t -d "$db" -c "select 'T|' || c.relname || '|' || t.tgname || '|' || pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and not t.tgisinternal order by 1"
  psql -X -A -q -t -d "$db" -c "select 'R|' || c.relname || '|' || coalesce(c.relacl::text,'-') || '|' || c.relrowsecurity::text from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' order by 1"
}
inventory "$DB_V1" | sort > "$TMP_DIR/inv.v1"
[ -s "$TMP_DIR/inv.v1" ] || fatal "inventaire de référence vide."
V1_RESOLVER_SRC="$(sql_on "$DB_V1" "select md5(prosrc) from pg_proc where proname='resolve_fulfillment_schedule' and pronamespace='public'::regnamespace;")"
V1_RESOLVER_ACL="$(sql_on "$DB_V1" "select coalesce(proacl::text,'-') from pg_proc where proname='resolve_fulfillment_schedule' and pronamespace='public'::regnamespace;")"
V1_PUBLIC_COLS="$(sql_on "$DB_V1" "select pg_get_function_result('public.get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric)'::regprocedure);")"
V1_ANON_FUNCS="$(sql_on "$DB_V1" "select string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text) from pg_proc p where p.pronamespace='public'::regnamespace and has_function_privilege('anon', p.oid, 'EXECUTE');")"

# Rejeu de la fixture CSDJ-1 (v1) AVANT la migration : la référence du
# comportement historique.
V1_FIX_SQL="$TMP_DIR/v1fix.sql"; V1_FIX_EXP="$TMP_DIR/v1fix.exp"
python3 -I "$REPLAY_V1_GEN" "$FIXTURE_V1_JSON" "$V1_FIX_SQL" "$V1_FIX_EXP" "$RID_A" "$NIL_RULE" >/dev/null || fatal "génération du rejeu CSDJ-1 impossible"
psql -X -q -d "$DB_V1" -v ON_ERROR_STOP=1 -f "$V1_FIX_SQL" 2>"$ERR" | grep -v '^$' > "$TMP_DIR/v1fix.pre" || fatal "rejeu CSDJ-1 AVANT migration impossible : $(head -3 "$ERR" | tr '\n' ' ')"
if diff -q "$V1_FIX_EXP" "$TMP_DIR/v1fix.pre" >/dev/null; then
  pass "[0b] la fixture CSDJ-1 ($(wc -l < "$V1_FIX_EXP") cas) donne AVANT la migration exactement ce que son oracle attend (référence du comportement historique)"
else
  fatal "la fixture CSDJ-1 ne passe pas sur l'état prédécesseur lui-même : le harnais ne peut pas servir de référence."
fi
psql -X -q -d "$DB_V1" -c "delete from public.restaurant_fulfillment_schedule where restaurant_id='$RID_A';" >/dev/null

# ============================================================
# [1] ALLER — la v1.2 s'applique sur l'état PROD
# ============================================================
log "=== [1] Application du SQL v1.2 ==="
create_tracked_db "$DB_FWD" -T "$DB_V1"
if apply_path "$SUPABASE_DIR/$LOT_SQL" "$DB_FWD"; then
  pass "[1] le SQL v1.2 s'applique sur le schéma PROD (prédécesseur + CSDJ-1)"
else
  fail "[1] le SQL v1.2 ÉCHOUE : $(tail -5 "$OUT" | tr '\n' ' ')"
fi
DB="$DB_FWD"

# ============================================================
# [2] ATOMICITÉ
# ============================================================
log "=== [2] Atomicité : une instruction en échec en fin de fichier ==="
create_tracked_db "$DB_ATOMIC" -T "$DB_V1"
SABOTAGE="$TMP_DIR/sabotage12.sql"
python3 - "$SUPABASE_DIR/$LOT_SQL" "$SABOTAGE" <<'PYSAB' || fatal "sabotage impossible à construire"
import sys
s = open(sys.argv[1], encoding="utf-8").read()
tail = "\ncommit;\n"
assert s.rstrip().endswith("commit;"), "le fichier ne se termine pas par commit;"
i = s.rstrip().rfind("commit;")
s = s[:i] + "do $sab$ begin raise exception 'SCANYM_SABOTAGE_TEST'; end $sab$;\n" + s[i:]
open(sys.argv[2], "w", encoding="utf-8").write(s)
PYSAB
if apply_path "$SABOTAGE" "$DB_ATOMIC"; then
  fail "[2] le fichier saboté s'est appliqué -- l'atomicité ne tient pas"
else
  pass "[2] une erreur en toute fin de fichier interrompt la transaction"
fi
assert_eq "[2a] aucune table v1.2 ne subsiste" "0" \
  "$(sql_on "$DB_ATOMIC" "select count(*) from pg_class where relnamespace='public'::regnamespace and (relname like 'public_holiday%' or relname like 'restaurant_fulfillment_prep%' or relname like 'order_fulfillment_capacity%');")"
assert_eq "[2b] aucune colonne v1.2 ne subsiste" "0" \
  "$(sql_on "$DB_ATOMIC" "select count(*) from information_schema.columns where table_name='restaurant_fulfillment_schedule' and column_name in ('holiday_calendar_id','preparation_on_holidays','availability_on_holidays','capacity_enabled','capacity_max_orders');")"
assert_eq "[2c] le RENOMMAGE du résolveur est annulé : pas de _v1, l'original est intact" "0|$V1_RESOLVER_SRC" \
  "$(sql_on "$DB_ATOMIC" "select (select count(*) from pg_proc where proname='resolve_fulfillment_schedule_v1') || '|' || (select md5(prosrc) from pg_proc where proname='resolve_fulfillment_schedule' and pronamespace='public'::regnamespace);")"
assert_eq "[2d] comptes de schéma identiques à l'état PROD" "$V1_COUNTS" "$(schema_counts "$DB_ATOMIC")"

# ============================================================
# [14] PRÉ-VOL : refus AVANT toute création d'objet
# ============================================================
log "=== [14] Pré-vol anti-dérive ==="
create_tracked_db "$DB_PRE" -T "$DB_BASE"
if apply_path "$SUPABASE_DIR/$LOT_SQL" "$DB_PRE"; then
  fail "[14a] la v1.2 s'est appliquée SANS CSDJ-1 -- le pré-vol ne protège rien"
else
  assert_has "[14a] sans CSDJ-1, le pré-vol REFUSE nommément" "SCANYM_SCHEMA_DRIFT" "$(cat "$OUT")"
fi
assert_eq "[14b] et rien n'a été créé" "0" \
  "$(sql_on "$DB_PRE" "select count(*) from pg_class where relnamespace='public'::regnamespace and (relname like 'public_holiday%' or relname like 'restaurant_fulfillment_prep%' or relname like 'order_fulfillment_capacity%');")"
inventory "$DB_FWD" | sort > "$TMP_DIR/inv.fwd.pre-reapply"
if apply_path "$SUPABASE_DIR/$LOT_SQL" "$DB_FWD"; then
  fail "[14c] la v1.2 s'est appliquée DEUX FOIS"
else
  assert_has "[14c] ré-application refusée nommément" "SCANYM_ALREADY_APPLIED" "$(cat "$OUT")"
fi
inventory "$DB_FWD" | sort > "$TMP_DIR/inv.fwd.post-reapply"
if diff -q "$TMP_DIR/inv.fwd.pre-reapply" "$TMP_DIR/inv.fwd.post-reapply" >/dev/null; then
  pass "[14d] la ré-application refusée ne change RIEN (inventaire complet identique)"
else
  fail "[14d] la ré-application refusée a modifié le schéma"
fi

# ============================================================
# [15] AUCUN OBJET PRÉEXISTANT N'A BOUGÉ — inventaire complet avant/après
# ============================================================
log "=== [15] Périmètre exact des changements (inventaire complet) ==="
inventory "$DB_FWD" | sort > "$TMP_DIR/inv.fwd"
diff "$TMP_DIR/inv.v1" "$TMP_DIR/inv.fwd" > "$TMP_DIR/inv.diff"
REMOVED_N="$(grep -c '^< ' "$TMP_DIR/inv.diff" || true)"
assert_eq "[15a] exactement UNE ligne d'inventaire disparaît (le corps du résolveur, remplacé par le répartiteur)" "1" "$REMOVED_N"
assert_has "[15b] et c'est bien resolve_fulfillment_schedule" "< F|resolve_fulfillment_schedule(uuid,text,uuid,timestamp with time zone)|" "$(grep '^< ' "$TMP_DIR/inv.diff")"
assert_eq "[15c] 13 lignes de fonction apparaissent (12 nouvelles + le répartiteur)" "13" "$(grep -c '^> F|' "$TMP_DIR/inv.diff" || true)"
assert_eq "[15d] exactement 5 colonnes apparaissent sur la planification" "5" \
  "$(grep -c '^> C|restaurant_fulfillment_schedule|' "$TMP_DIR/inv.diff" || true)"
assert_eq "[15e] aucune colonne n'apparaît sur une autre table préexistante" "0" \
  "$(grep '^> C|' "$TMP_DIR/inv.diff" | awk -F'|' '$2!="restaurant_fulfillment_schedule" && $2!="public_holiday_calendar" && $2!="public_holiday_calendar_day" && $2!="restaurant_fulfillment_prep_day" && $2!="restaurant_fulfillment_prep_closure" && $2!="order_fulfillment_capacity_reservation"' | wc -l | tr -d ' ')"
assert_eq "[15f] aucun déclencheur ajouté ni retiré (orders n'a reçu AUCUN déclencheur)" "0" "$(grep -c '[<>] T|' "$TMP_DIR/inv.diff" || true)"
assert_eq "[15g] aucune politique RLS préexistante modifiée" "0" "$(grep -c '^< P|' "$TMP_DIR/inv.diff" || true)"
assert_eq "[15h] aucun droit de table préexistant modifié (seules 5 tables NOUVELLES apparaissent)" "5|0" \
  "$(grep -c '^> R|' "$TMP_DIR/inv.diff" || true)|$(grep -c '^< R|' "$TMP_DIR/inv.diff" || true)"
PRE_TOUCHED=""
for fn in create_order update_order_status initiate_payment_attempt confirm_payment_attempt resolve_delivery_fulfillment \
          get_checkout_fulfillment_schedule mutate_merchant_fulfillment_schedule get_merchant_fulfillment_schedules \
          checkout_wall_time_instant checkout_wall_time_status; do
  a="$(sql_on "$DB_V1" "select string_agg(md5(prosrc) || coalesce(proacl::text,'-'), ',' order by oid) from pg_proc where proname='$fn' and pronamespace='public'::regnamespace;")"
  b="$(sql_on "$DB_FWD" "select string_agg(md5(prosrc) || coalesce(proacl::text,'-'), ',' order by oid) from pg_proc where proname='$fn' and pronamespace='public'::regnamespace;")"
  if [ -n "$a" ] && [ "$a" = "$b" ] && ! has "$a" "SQL_ERROR"; then pass "[15i] $fn : corps ET droits identiques avant/après"
  else fail "[15i] $fn modifiée par la v1.2 (ou introuvable)"; PRE_TOUCHED="$PRE_TOUCHED $fn"; fi
done
assert_eq "[15j] l'ancien corps du résolveur est conservé OCTET POUR OCTET sous le nom _v1" "$V1_RESOLVER_SRC" \
  "$(sql_on "$DB_FWD" "select md5(prosrc) from pg_proc where proname='resolve_fulfillment_schedule_v1' and pronamespace='public'::regnamespace;")"
assert_eq "[15k] et ses droits sont ceux d'origine" "$V1_RESOLVER_ACL" \
  "$(sql_on "$DB_FWD" "select coalesce(proacl::text,'-') from pg_proc where proname='resolve_fulfillment_schedule_v1' and pronamespace='public'::regnamespace;")"
assert_eq "[15l] le contrat de réponse publique (colonnes de get_checkout_fulfillment_schedule) est inchangé" "$V1_PUBLIC_COLS" \
  "$(sql_on "$DB_FWD" "select pg_get_function_result('public.get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric)'::regprocedure);")"
assert_eq "[15m] les colonnes de sortie du répartiteur sont celles du résolveur d'origine" \
  "$(sql_on "$DB_V1" "select pg_get_function_result('public.resolve_fulfillment_schedule(uuid,text,uuid,timestamptz)'::regprocedure);")" \
  "$(sql_on "$DB_FWD" "select pg_get_function_result('public.resolve_fulfillment_schedule(uuid,text,uuid,timestamptz)'::regprocedure);")"

# ============================================================
# [3] Structure et posture de sécurité
# ============================================================
log "=== [3] Structure et posture de sécurité ==="
NEW_TABLES="'public_holiday_calendar','public_holiday_calendar_day','restaurant_fulfillment_prep_day','restaurant_fulfillment_prep_closure','order_fulfillment_capacity_reservation'"
assert_eq "[3a] les 5 tables v1.2 existent, RLS active" "5|5" \
  "$(sql_value "select count(*) || '|' || count(*) filter (where relrowsecurity) from pg_class where relnamespace='public'::regnamespace and relname in ($NEW_TABLES);")"
assert_eq "[3b] AUCUN grant d'écriture sur les 5 tables, pour aucun rôle applicatif" "0" \
  "$(sql_value "select count(*) from (select unnest(array['anon','authenticated','service_role']) r, unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p) x, pg_class c where c.relnamespace='public'::regnamespace and c.relname in ($NEW_TABLES) and has_table_privilege(x.r, c.oid, x.p);")"
assert_eq "[3c] anon n'a AUCUN accès direct aux 5 tables" "0" \
  "$(sql_value "select count(*) from pg_class c where c.relnamespace='public'::regnamespace and c.relname in ($NEW_TABLES) and has_table_privilege('anon', c.oid, 'SELECT');")"
assert_eq "[3d] la table de réservation n'est lisible par AUCUN rôle applicatif" "0" \
  "$(sql_value "select count(*) from unnest(array['anon','authenticated','service_role']) r where has_table_privilege(r, 'public.order_fulfillment_capacity_reservation', 'SELECT');")"
assert_eq "[3e] les tables NAISSENT VIDES (aucun jour férié, aucune juridiction, aucun backfill)" "0" \
  "$(sql_value "select (select count(*) from public.public_holiday_calendar)+(select count(*) from public.public_holiday_calendar_day)+(select count(*) from public.restaurant_fulfillment_prep_day)+(select count(*) from public.restaurant_fulfillment_prep_closure)+(select count(*) from public.order_fulfillment_capacity_reservation)+(select count(*) from public.restaurant_fulfillment_schedule);")"
assert_eq "[3f] AUCUNE planification n'est activée par la migration" "0" \
  "$(sql_value "select count(*) from public.restaurant_fulfillment_schedule where schedule_method_version <> 'v1' or capacity_enabled or holiday_calendar_id is not null;")"
assert_eq "[3g] les 12 fonctions NOUVELLES fixent search_path = ''" "12" \
  "$(sql_value "select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in ('checkout_unfulfillable_reasons_v12','fulfillment_capacity_is_holding','fulfillment_capacity_used','csdj12_preparation_open','csdj12_availability_closed','checkout_schedule_day_offers_v12','resolve_fulfillment_schedule_v12','resolve_fulfillment_schedule_v1','reserve_fulfillment_capacity','release_fulfillment_capacity','mutate_merchant_fulfillment_schedule_v12','get_merchant_fulfillment_schedules_v12') and array_to_string(proconfig,',') like '%search_path=%';")"
assert_eq "[3h] le répartiteur fixe aussi search_path = ''" "1" \
  "$(sql_value "select count(*) from pg_proc where pronamespace='public'::regnamespace and proname='resolve_fulfillment_schedule' and array_to_string(proconfig,',') like '%search_path=%';")"
assert_eq "[3i] l'ensemble des fonctions exécutables par anon est IDENTIQUE à celui d'avant" "$V1_ANON_FUNCS" \
  "$(sql_value "select string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text) from pg_proc p where p.pronamespace='public'::regnamespace and has_function_privilege('anon', p.oid, 'EXECUTE');")"
assert_eq "[3j] seules les 2 RPC marchandes v1.2 sont exécutables par authenticated parmi les objets nouveaux" "2" \
  "$(sql_value "select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('checkout_unfulfillable_reasons_v12','fulfillment_capacity_is_holding','fulfillment_capacity_used','csdj12_preparation_open','csdj12_availability_closed','checkout_schedule_day_offers_v12','resolve_fulfillment_schedule_v12','resolve_fulfillment_schedule_v1','resolve_fulfillment_schedule','reserve_fulfillment_capacity','release_fulfillment_capacity','mutate_merchant_fulfillment_schedule_v12','get_merchant_fulfillment_schedules_v12') and has_function_privilege('authenticated', p.oid, 'EXECUTE');")"
assert_eq "[3k] service_role n'exécute AUCUNE fonction de capacité (create_order, SECURITY DEFINER, sera l'appelant)" "0" \
  "$(sql_value "select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('reserve_fulfillment_capacity','release_fulfillment_capacity','fulfillment_capacity_used','fulfillment_capacity_is_holding','resolve_fulfillment_schedule_v12','resolve_fulfillment_schedule') and has_function_privilege('service_role', p.oid, 'EXECUTE');")"
assert_eq "[3l] catalogue de motifs v1.2 = les 5 motifs CSDJ-1 puis les 4 nouveaux" "no_offer_configured|granularity_missing|all_dates_closed|horizon_exhausted|no_offer_in_horizon|preparation_calendar_missing|no_preparation_day_in_horizon|cutoff_unresolvable|capacity_exhausted" \
  "$(sql_value "select array_to_string(public.checkout_unfulfillable_reasons_v12(), '|');")"
assert_eq "[3m] le catalogue CSDJ-1 des motifs n'a pas bougé" "no_offer_configured|granularity_missing|all_dates_closed|horizon_exhausted|no_offer_in_horizon" \
  "$(sql_value "select array_to_string(public.checkout_unfulfillable_reasons(), '|');")"
assert_eq "[3n] la graine de verrou 1204 n'est utilisée par AUCUN autre fichier SQL du dépôt" "0" \
  "$(grep -l ', 1204)' "$SUPABASE_DIR"/*.sql 2>/dev/null | grep -v "$LOT_SQL" | wc -l | tr -d ' ')"
assert_eq "[3o] aucune règle métier d'un commerçant précis dans le SQL v1.2 (« No hardcoded Au Lait Cru »)" "0" \
  "$(grep -ciE 'au[ -_]*lait|lait[ -_]*cru|alc-|ALC_' "$SUPABASE_DIR/$LOT_SQL" || true)"
assert_eq "[3p] aucun jeu de données de jours fériés ni juridiction dans le SQL v1.2" "0" \
  "$(grep -cE "insert into public\.public_holiday|'FR'|'DZ'|'France'|'Algérie'" "$SUPABASE_DIR/$LOT_SQL" || true)"

# ============================================================
# [4] RÉPARTITEUR — le comportement v1 est inchangé, cas par cas
# ============================================================
log "=== [4] Différentiel du répartiteur : CSDJ-1 avant / après ==="
psql -X -q -d "$DB_FWD" -v ON_ERROR_STOP=1 -f "$V1_FIX_SQL" 2>"$ERR" | grep -v '^$' > "$TMP_DIR/v1fix.post" \
  || fail "[4] rejeu CSDJ-1 APRÈS migration impossible : $(head -3 "$ERR" | tr '\n' ' ')"
if cmp -s "$TMP_DIR/v1fix.pre" "$TMP_DIR/v1fix.post"; then
  pass "[4a] les $(wc -l < "$V1_FIX_EXP") cas de la fixture CSDJ-1 rendent APRÈS la migration exactement les mêmes octets qu'AVANT"
else
  fail "[4a] le comportement v1 a changé : $(diff "$TMP_DIR/v1fix.pre" "$TMP_DIR/v1fix.post" | head -6 | tr '\n' ' ')"
fi
if diff -q "$V1_FIX_EXP" "$TMP_DIR/v1fix.post" >/dev/null; then
  pass "[4b] et ils sont conformes à l'oracle CSDJ-1 indépendant"
else
  fail "[4b] écart à l'oracle CSDJ-1 après migration"
fi
psql -X -q -d "$DB_FWD" -c "delete from public.restaurant_fulfillment_schedule where restaurant_id='$RID_A';" >/dev/null

# ============================================================
# [5] FIXTURE v1.2 rejouée contre l'autorité SQL (oracle Python indépendant)
# ============================================================
log "=== [5] Fixture v1.2 : SQL contre l'oracle Python ==="
replay_v12() { # $1 base $2 fonction ; code 0 = identique
  local db="$1" fn="${2:-public.resolve_fulfillment_schedule}"
  python3 -I "$REPLAY_V12_GEN" "$FIXTURE_JSON" "$TMP_DIR/v12fix.sql" "$TMP_DIR/v12fix.exp" "$RID_A" "$fn" >/dev/null || return 3
  psql -X -q -d "$db" -v ON_ERROR_STOP=1 -f "$TMP_DIR/v12fix.sql" 2>"$TMP_DIR/v12fix.err" | grep -v '^$' > "$TMP_DIR/v12fix.got"
  [ "${PIPESTATUS[0]}" -eq 0 ] || return 4
  diff -u "$TMP_DIR/v12fix.exp" "$TMP_DIR/v12fix.got" > "$TMP_DIR/v12fix.diff"
}
if replay_v12 "$DB_FWD"; then
  pass "[5a] les $(wc -l < "$TMP_DIR/v12fix.exp") cas de la fixture v1.2 donnent, par le répartiteur, EXACTEMENT ce que l'oracle attend"
else
  fail "[5a] divergence SQL / oracle v1.2 : $(head -12 "$TMP_DIR/v12fix.diff" 2>/dev/null | tr '\n' ' ') $(head -3 "$TMP_DIR/v12fix.err" 2>/dev/null | tr '\n' ' ')"
fi
while IFS= read -r line; do
  cid="${line%%|*}"
  if grep -qxF "$line" "$TMP_DIR/v12fix.got"; then pass "[5] cas « $cid »"
  else fail "[5] cas « $cid » — attendu '$line', obtenu '$(grep "^$cid|" "$TMP_DIR/v12fix.got" | head -1 || echo '<absent>')'"; fi
done < "$TMP_DIR/v12fix.exp"
if replay_v12 "$DB_FWD" "public.resolve_fulfillment_schedule_v12"; then
  pass "[5b] la fonction v1.2 appelée DIRECTEMENT (capacité appliquée) rend les mêmes résultats que par le répartiteur"
else
  fail "[5b] appel direct de resolve_fulfillment_schedule_v12 divergent"
fi
if [ -s "$TMP_DIR/v12fix.exp.refusals" ]; then
  while IFS= read -r cid; do
    [ -n "$cid" ] || continue
    if apply_path "$TMP_DIR/refusal-$cid.sql" "$DB_FWD"; then fail "[5r] « $cid » : la contrainte de table a ACCEPTÉ un état censé être impossible"
    else pass "[5r] « $cid » : la contrainte de table REFUSE cet état (inatteignable, donc jamais mal calculé)"; fi
  done < "$TMP_DIR/v12fix.exp.refusals"
fi
sql_on "$DB_FWD" "delete from public.order_fulfillment_capacity_reservation where restaurant_id='$RID_A'; delete from public.orders where restaurant_id='$RID_A'; delete from public.restaurant_fulfillment_schedule where restaurant_id='$RID_A'; delete from public.public_holiday_calendar;" >/dev/null
assert_eq "[5c] la méthode v1.2 appelée sur une planification v1 est REFUSÉE (pas de repli silencieux)" "REFUS" \
  "$(psql -X -q -d "$DB_FWD" -v ON_ERROR_STOP=1 -c "insert into public.restaurant_fulfillment_schedule (restaurant_id, mode_code, timezone, enabled, date_selection_mode, slot_selection_mode) values ('$RID_A','pickup','Europe/Paris',true,'customer_selectable','none');" -c "select * from public.resolve_fulfillment_schedule_v12('$RID_A','pickup',null,now(),true);" 2>&1 | grep -q 'CSDJ12_WRONG_METHOD' && echo REFUS || echo AUTORISE)"
sql_on "$DB_FWD" "delete from public.restaurant_fulfillment_schedule where restaurant_id='$RID_A';" >/dev/null

# ============================================================
# [6] LECTURE PUBLIQUE — filtrée, sans compte, sans fournisseur
# ============================================================
log "=== [6] Lecture publique : disponibilités filtrées par la capacité ==="
DB="$DB_FWD"
cap_reset "$DB_FWD" "$RID_A" 1 none
sql_on "$DB_FWD" "update public.restaurant_fulfillment_schedule set cutoff_time = null where restaurant_id='$RID_A';" >/dev/null
PUBQ="select schedule_status || '|' || coalesce(first_eligible_date::text,'-') || '|' || coalesce(array_to_string(eligible_dates,','),'-') from public.get_checkout_fulfillment_schedule('$RID_A','pickup',null,1,null);"
PUB1="$(value_as anon '' "$PUBQ")"
D1="$(printf '%s' "$PUB1" | cut -d'|' -f2)"
assert_has "[6a] anon lit une planification v1.2 : dates disponibles" "dates_available|" "$PUB1"
O1="$(mk_orders "$DB_FWD" "$RID_A" 1 | head -1)"
RES1="$(sql_on "$DB_FWD" "select result || '|' || coalesce(reason,'-') from public.reserve_fulfillment_capacity('$O1','$RID_A','pickup',null,'$D1',null);")"
assert_eq "[6b] la première date est réservée (capacité 1)" "reserved|-" "$RES1"
PUB2="$(value_as anon '' "$PUBQ")"
D2="$(printf '%s' "$PUB2" | cut -d'|' -f2)"
if [ -n "$D1" ] && [ "$D1" != "-" ] && [ "$D2" != "$D1" ] && ! has "$(printf '%s' "$PUB2" | cut -d'|' -f3)" "$D1"; then
  pass "[6c] une fois la date pleine, anon ne la voit PLUS ($D1 retirée, première date = $D2)"
else
  fail "[6c] la date pleine reste proposée : avant='$PUB1' après='$PUB2'"
fi
assert_eq "[6d] le client ne voit JAMAIS de compte : aucune colonne de la lecture publique ne parle de capacité" "0" \
  "$(sql_value "select count(*) from unnest(string_to_array(pg_get_function_result('public.get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric)'::regprocedure), ',')) c where c ~* '(capac|remain|reserv|places|count|quota|restant)';")"
assert_eq "[6e] la ligne publique ne contient aucune clé de capacité" "0" \
  "$(value_as anon '' "select count(*) from public.get_checkout_fulfillment_schedule('$RID_A','pickup',null,1,null) g where to_jsonb(g)::text ~* '(capac|remain|reserv|quota|max_orders)';")"
for forbidden in provider fulfillment_code fulfillment_rule_id zone_prefixes; do
  case "$(sql_value "select pg_get_function_result('public.get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric)'::regprocedure);")" in
    *"$forbidden"*) fail "[6f] la lecture publique exposerait « $forbidden »" ;;
    *) pass "[6f] la lecture publique n'expose pas « $forbidden »" ;;
  esac
done
assert_eq "[6g] la lecture publique n'accepte AUCUN paramètre temporel (horloge serveur)" "0" \
  "$(sql_value "select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname='get_checkout_fulfillment_schedule' and (pg_get_function_arguments(p.oid) like '%timestamp%' or pg_get_function_arguments(p.oid) like '%date%');")"
assert_eq "[6h] les entrées de la v1.2 acceptant une heure ne sont exécutables par AUCUN rôle applicatif" "0" \
  "$(sql_value "select count(*) from pg_proc p, unnest(array['anon','authenticated','service_role']) r where p.pronamespace='public'::regnamespace and p.proname in ('resolve_fulfillment_schedule_v12','resolve_fulfillment_schedule','reserve_fulfillment_capacity') and has_function_privilege(r, p.oid, 'EXECUTE');")"
# Le tarif de livraison reste celui de l'autorité EXISTANTE (aucune formule recopiée).
assert_eq "[6i] la lecture publique de LIVRAISON rend toujours le tarif de l'autorité de tarification" "4.90" \
  "$(sql_value "select delivery_fee from public.get_checkout_fulfillment_schedule('$RID_A','delivery','75011',1,20.00);")"

# ============================================================
# [7] ÉCRITURE MARCHANDE v1.2 : ACL, validation, isolation
# ============================================================
log "=== [7] Écriture marchande v1.2 ==="
DB="$DB_FWD"
sql_on "$DB_FWD" "delete from public.order_fulfillment_capacity_reservation; delete from public.orders where restaurant_id in ('$RID_A','$RID_B'); delete from public.restaurant_fulfillment_schedule; delete from public.public_holiday_calendar;" >/dev/null
pj() { printf '{"modeCode":"pickup","timezone":"Europe/Paris","enabled":true,"dateSelectionMode":"customer_selectable","slotSelectionMode":"none","minLeadDays":1,"cutoffTime":"10:00","bookingHorizonDays":14%s}' "$1"; }
mut() { printf "select public.mutate_merchant_fulfillment_schedule_v12('%s','%s','%s'::jsonb);" "$1" "$2" "$3"; }
assert_eq "[7a] owner enregistre une planification v1.2" "OK" "$(outcome_as authenticated "$OWNER_A" "$(mut "$RID_A" save_schedule_v12 "$(pj '')")")"
assert_eq "[7b] manager l'enregistre aussi" "OK" "$(outcome_as authenticated "$MANAGER_A" "$(mut "$RID_A" save_schedule_v12 "$(pj '')")")"
assert_has "[7c] staff refusé" "CSDJ12_FORBIDDEN" "$(outcome_as authenticated "$STAFF_A" "$(mut "$RID_A" save_schedule_v12 "$(pj '')")")"
assert_has "[7d] étranger refusé" "CSDJ12_FORBIDDEN" "$(outcome_as authenticated "$STRANGER" "$(mut "$RID_A" save_schedule_v12 "$(pj '')")")"
assert_has "[7e] owner d'un AUTRE commerçant refusé" "CSDJ12_FORBIDDEN" "$(outcome_as authenticated "$OWNER_B" "$(mut "$RID_A" save_schedule_v12 "$(pj '')")")"
assert_has "[7f] session anonyme (rôle anon) : pas d'EXECUTE" "permission denied" "$(outcome_as anon '' "$(mut "$RID_A" save_schedule_v12 "$(pj '')")")"
assert_has "[7g] authentifié sans identité de session refusé" "CSDJ12_AUTH_REQUIRED" "$(outcome_as authenticated '' "$(mut "$RID_A" save_schedule_v12 "$(pj '')")")"
assert_has "[7h] règle de livraison d'un AUTRE commerçant refusée" "CSDJ12_FOREIGN_RULE" "$(outcome_as authenticated "$OWNER_A" "$(mut "$RID_A" save_schedule_v12 "$(pj ",\"modeCode\":\"delivery\",\"fulfillmentRuleId\":\"$RULE_B\"" | sed 's/"modeCode":"pickup",//')")")"
assert_has "[7i] le zéro UUID est une sentinelle réservée" "CSDJ12_RESERVED_RULE_ID" "$(outcome_as authenticated "$OWNER_A" "$(mut "$RID_A" save_schedule_v12 "$(pj ",\"fulfillmentRuleId\":\"$NIL_RULE\"")")")"
assert_has "[7j] fuseau inconnu refusé" "CSDJ12_INVALID_TIMEZONE" "$(outcome_as authenticated "$OWNER_A" "$(mut "$RID_A" save_schedule_v12 "$(pj '' | sed 's#Europe/Paris#Mars/Olympus#')")")"
assert_has "[7k] calendrier férié inconnu refusé" "CSDJ12_UNKNOWN_CALENDAR" "$(outcome_as authenticated "$OWNER_A" "$(mut "$RID_A" save_schedule_v12 "$(pj ',"holidayCalendarId":"11111111-1111-4111-8111-111111111111"')")")"
assert_has "[7l] politique « closed » SANS calendrier refusée (elle n'aurait rien fermé)" "CSDJ12_HOLIDAY_POLICY_NEEDS_CALENDAR" "$(outcome_as authenticated "$OWNER_A" "$(mut "$RID_A" save_schedule_v12 "$(pj ',"preparationOnHolidays":"closed"')")")"
assert_has "[7m] politique fériée hors catalogue refusée" "CSDJ12_INVALID_HOLIDAY_POLICY" "$(outcome_as authenticated "$OWNER_A" "$(mut "$RID_A" save_schedule_v12 "$(pj ',"availabilityOnHolidays":"maybe"')")")"
assert_has "[7n] capacité activée SANS maximum refusée" "CSDJ12_INVALID_CAPACITY" "$(outcome_as authenticated "$OWNER_A" "$(mut "$RID_A" save_schedule_v12 "$(pj ',"capacityEnabled":true')")")"
assert_has "[7o] capacité activée avec maximum 0 refusée (strictement positif)" "CSDJ12_INVALID_CAPACITY" "$(outcome_as authenticated "$OWNER_A" "$(mut "$RID_A" save_schedule_v12 "$(pj ',"capacityEnabled":true,"capacityMaxOrders":0')")")"
assert_has "[7p] capacité activée avec maximum négatif refusée" "CSDJ12_INVALID_CAPACITY" "$(outcome_as authenticated "$OWNER_A" "$(mut "$RID_A" save_schedule_v12 "$(pj ',"capacityEnabled":true,"capacityMaxOrders":-3')")")"
assert_has "[7q] capacité sur une politique purement informative refusée" "CSDJ12_CAPACITY_NEEDS_DATE" "$(outcome_as authenticated "$OWNER_A" "$(mut "$RID_A" save_schedule_v12 "$(pj ',"capacityEnabled":true,"capacityMaxOrders":5' | sed 's/customer_selectable/informational_only/')")")"
assert_has "[7r] heure limite sous-minute refusée" "CSDJ12_SUBMINUTE_TIME" "$(outcome_as authenticated "$OWNER_A" "$(mut "$RID_A" save_schedule_v12 "$(pj '' | sed 's/"cutoffTime":"10:00"/"cutoffTime":"10:00:30"/')")")"
assert_has "[7s] décalage d'heure limite non nul REFUSÉ (jamais ignoré en silence)" "CSDJ12_CUTOFF_OFFSET_REMOVED" "$(outcome_as authenticated "$OWNER_A" "$(mut "$RID_A" save_schedule_v12 "$(pj ',"cutoffOffsetDays":1')")")"
assert_has "[7t] action inconnue refusée" "CSDJ12_UNKNOWN_ACTION" "$(outcome_as authenticated "$OWNER_A" "$(mut "$RID_A" delete_everything "$(pj '')")")"
assert_has "[7u] jour de semaine hors 0..6 refusé" "CSDJ12_INVALID_WEEKDAY" "$(outcome_as authenticated "$OWNER_A" "$(mut "$RID_A" replace_prep_days '{"modeCode":"pickup","weekdays":[1,7]}')")"
assert_eq "[7v] et le remplacement refusé n'a RIEN laissé (transaction annulée)" "0" "$(sql_on "$DB_FWD" "select count(*) from public.restaurant_fulfillment_prep_day where restaurant_id='$RID_A';")"
assert_eq "[7w] owner enregistre les jours de préparation" "OK" "$(outcome_as authenticated "$OWNER_A" "$(mut "$RID_A" replace_prep_days '{"modeCode":"pickup","weekdays":[1,2,3,4,5,6]}')")"
assert_eq "[7x] owner enregistre une fermeture de préparation" "OK" "$(outcome_as authenticated "$OWNER_A" "$(mut "$RID_A" replace_prep_closures '{"modeCode":"pickup","closures":[{"closedOn":"2026-12-24","label":"Inventaire"}]}')")"
assert_eq "[7y] la relecture marchande rend exactement ce qui a été écrit" '[1,2,3,4,5,6]|[{"label":"Inventaire","closedOn":"2026-12-24"}]' \
  "$(value_as authenticated "$OWNER_A" "select preparation_weekdays::text || '|' || preparation_closures::text from public.get_merchant_fulfillment_schedules_v12('$RID_A');")"
assert_has "[7z] un owner étranger ne relit PAS la configuration" "CSDJ12_FORBIDDEN" "$(outcome_as authenticated "$OWNER_B" "select * from public.get_merchant_fulfillment_schedules_v12('$RID_A');")"
assert_has "[7za] staff relit (membre) -- lecture seule" "OK" "$(outcome_as authenticated "$STAFF_A" "select * from public.get_merchant_fulfillment_schedules_v12('$RID_A');")"
assert_has "[7zb] remplacement de jours sur une planification v1 refusé" "CSDJ12_NOT_V12" "$( sql_on "$DB_FWD" "insert into public.restaurant_fulfillment_schedule (restaurant_id, mode_code, timezone, enabled) values ('$RID_B','pickup','Europe/Paris',true);" >/dev/null; outcome_as authenticated "$OWNER_B" "$(mut "$RID_B" replace_prep_days '{"modeCode":"pickup","weekdays":[1]}')")"
assert_has "[7zc] la v1 'save_schedule' avec son décalage par défaut sur une ligne v1.2 est REFUSÉE par contrainte (fail-closed)" "rfs_v12_no_cutoff_offset" \
  "$(outcome_as authenticated "$OWNER_A" "select public.mutate_merchant_fulfillment_schedule('$RID_A','save_schedule','{\"modeCode\":\"pickup\",\"timezone\":\"Europe/Paris\",\"enabled\":true}'::jsonb);")"
assert_eq "[7zd] une règle de livraison PROPRE s'accepte (portée règle ≠ portée mode)" "OK" \
  "$(outcome_as authenticated "$OWNER_A" "$(mut "$RID_A" save_schedule_v12 "$(pj ",\"fulfillmentRuleId\":\"$RULE_A\"" | sed 's/"modeCode":"pickup"/"modeCode":"delivery"/')")")"
assert_eq "[7ze] elle est rangée sous la clé de règle, pas la sentinelle" "$RULE_A" \
  "$(sql_on "$DB_FWD" "select rule_key from public.restaurant_fulfillment_schedule where restaurant_id='$RID_A' and mode_code='delivery';")"
sql_on "$DB_FWD" "delete from public.restaurant_fulfillment_schedule;" >/dev/null

# ============================================================
# [10] ISOLATION MULTI-LOCATAIRES (RLS)
# ============================================================
log "=== [10] Isolation multi-locataires v1.2 ==="
cap_reset "$DB_FWD" "$RID_A" 2 none
cap_reset "$DB_FWD" "$RID_B" 2 none
OA="$(mk_orders "$DB_FWD" "$RID_A" 1 | head -1)"
rsv "$DB_FWD" "$OA" "$RID_A" "$CAP_DATE" - >/dev/null
assert_eq "[10a] owner A voit ses 7 jours de préparation" "7" "$(value_as authenticated "$OWNER_A" "select count(*) from public.restaurant_fulfillment_prep_day where restaurant_id='$RID_A';")"
assert_eq "[10b] owner B ne voit AUCUN jour de préparation du commerçant A (RLS)" "0" "$(value_as authenticated "$OWNER_B" "select count(*) from public.restaurant_fulfillment_prep_day where restaurant_id='$RID_A';")"
assert_eq "[10c] owner B ne voit AUCUNE fermeture de préparation du commerçant A" "0" "$(value_as authenticated "$OWNER_B" "select count(*) from public.restaurant_fulfillment_prep_closure where restaurant_id='$RID_A';")"
assert_eq "[10d] un étranger ne voit rien des jours de préparation" "0" "$(value_as authenticated "$STRANGER" "select count(*) from public.restaurant_fulfillment_prep_day;")"
assert_has "[10e] aucun rôle applicatif n'écrit un jour de préparation" "permission denied" "$(outcome_as authenticated "$OWNER_A" "insert into public.restaurant_fulfillment_prep_day values ('$RID_A','pickup','$NIL_RULE',0);")"
assert_has "[10f] ni ne supprime" "permission denied" "$(outcome_as authenticated "$OWNER_A" "delete from public.restaurant_fulfillment_prep_day where restaurant_id='$RID_A';")"
assert_has "[10g] authenticated ne LIT pas la table de réservation" "permission denied" "$(outcome_as authenticated "$OWNER_A" "select count(*) from public.order_fulfillment_capacity_reservation;")"
assert_has "[10h] anon ne la lit pas" "permission denied" "$(outcome_as anon '' "select count(*) from public.order_fulfillment_capacity_reservation;")"
assert_has "[10i] service_role ne la lit pas (seule l'autorité transactionnelle y écrit)" "permission denied" "$(outcome_as service_role '' "select count(*) from public.order_fulfillment_capacity_reservation;")"
assert_has "[10j] service_role n'y écrit pas non plus" "permission denied" "$(outcome_as service_role '' "insert into public.order_fulfillment_capacity_reservation (order_id, restaurant_id, mode_code, rule_key, fulfillment_date) values ('$OA','$RID_A','pickup','$NIL_RULE','2026-10-14');")"
assert_has "[10k] aucun rôle applicatif n'exécute la réservation" "permission denied" "$(outcome_as service_role '' "select * from public.reserve_fulfillment_capacity('$OA','$RID_A','pickup',null,'2026-10-14');")"
assert_has "[10l] authenticated non plus" "permission denied" "$(outcome_as authenticated "$OWNER_A" "select * from public.reserve_fulfillment_capacity('$OA','$RID_A','pickup',null,'2026-10-14');")"
assert_has "[10m] ni la libération" "permission denied" "$(outcome_as authenticated "$OWNER_A" "select public.release_fulfillment_capacity('$OA');")"
assert_has "[10n] anon n'écrit aucun calendrier férié" "permission denied" "$(outcome_as anon '' "insert into public.public_holiday_calendar (code,label) values ('x','x');")"
assert_has "[10o] authenticated n'écrit pas non plus un calendrier férié" "permission denied" "$(outcome_as authenticated "$OWNER_A" "insert into public.public_holiday_calendar (code,label) values ('x','x');")"
assert_has "[10p] anon ne lit pas les calendriers fériés" "permission denied" "$(outcome_as anon '' "select count(*) from public.public_holiday_calendar;")"

# ============================================================
# [8] CAPACITÉ — sémantique séquentielle
# ============================================================
log "=== [8] Capacité : une commande = une unité ==="
cap_reset "$DB_FWD" "$RID_A" 1 none
read -r O1 O2 < <(mk_orders "$DB_FWD" "$RID_A" 2 | tr '\n' ' ')
assert_eq "[8a] première commande : réservée" "reserved|-" "$(rsv "$DB_FWD" "$O1" "$RID_A" "$CAP_DATE" -)"
assert_eq "[8b] elle consomme exactement UNE unité" "1" "$(used_in "$DB_FWD" "$RID_A" "$CAP_DATE" '')"
assert_eq "[8c] seconde commande, même date, capacité 1 : refusée, motif nommé" "unavailable|capacity_full" "$(rsv "$DB_FWD" "$O2" "$RID_A" "$CAP_DATE" -)"
assert_eq "[8d] le refus ne consomme rien" "1" "$(reservations_in "$DB_FWD" "$RID_A")"
cap_reset "$DB_FWD" "$RID_A" 3 none
O3="$(mk_orders "$DB_FWD" "$RID_A" 1 | head -1)"
sql_on "$DB_FWD" "insert into public.order_items (order_id, item_name, quantity, unit_price, line_total) select '$O3', 'Article ' || g, 5, 2, 10 from generate_series(1,3) g;" >/dev/null
assert_eq "[8e] la commande compte 3 lignes de quantité 5 (15 unités de produit)" "3|15" "$(sql_on "$DB_FWD" "select count(*) || '|' || sum(quantity) from public.order_items where order_id='$O3';")"
assert_eq "[8f] elle est réservée" "reserved|-" "$(rsv "$DB_FWD" "$O3" "$RID_A" "$CAP_DATE" -)"
assert_eq "[8g] et ne consomme QU'UNE unité, quelle que soit la quantité de produits" "1" "$(used_in "$DB_FWD" "$RID_A" "$CAP_DATE" '')"
assert_has "[8h] une seconde réservation de la MÊME commande est une erreur d'usage" "CSDJ12_ALREADY_RESERVED" "$(rsv "$DB_FWD" "$O3" "$RID_A" "$CAP_DATE" -)"
assert_eq "[8i] et n'a rien consommé de plus" "1" "$(used_in "$DB_FWD" "$RID_A" "$CAP_DATE" '')"
# not_required
cap_reset "$DB_FWD" "$RID_A" off none
O4="$(mk_orders "$DB_FWD" "$RID_A" 1 | head -1)"
assert_eq "[8j] capacité désactivée : not_required, rien n'est réservé" "not_required|-|0" "$(rsv "$DB_FWD" "$O4" "$RID_A" "$CAP_DATE" -)|$(reservations_in "$DB_FWD" "$RID_A")"
sql_on "$DB_FWD" "delete from public.restaurant_fulfillment_schedule where restaurant_id='$RID_A'; insert into public.restaurant_fulfillment_schedule (restaurant_id, mode_code, timezone, enabled, date_selection_mode, slot_selection_mode) values ('$RID_A','pickup','Europe/Paris',true,'customer_selectable','none');" >/dev/null
assert_eq "[8k] planification v1 : not_required (le parcours historique ne réserve rien)" "not_required|-" "$(rsv "$DB_FWD" "$O4" "$RID_A" "$CAP_DATE" -)"
sql_on "$DB_FWD" "delete from public.restaurant_fulfillment_schedule where restaurant_id='$RID_A';" >/dev/null
assert_eq "[8l] aucune planification : not_required" "not_required|-" "$(rsv "$DB_FWD" "$O4" "$RID_A" "$CAP_DATE" -)"
# Dates / créneaux non offerts
cap_reset "$DB_FWD" "$RID_A" 2 none
O5="$(mk_orders "$DB_FWD" "$RID_A" 1 | head -1)"
assert_eq "[8m] date non offerte (avant la cible J+1) : date_not_offered" "unavailable|date_not_offered" "$(rsv "$DB_FWD" "$O5" "$RID_A" "2026-10-13" -)"
assert_eq "[8n] date au-delà de l'horizon : date_not_offered" "unavailable|date_not_offered" "$(rsv "$DB_FWD" "$O5" "$RID_A" "2027-06-01" -)"
assert_eq "[8o] créneau fourni alors que la planification n'en a pas : slot_not_offered" "unavailable|slot_not_offered" "$(rsv "$DB_FWD" "$O5" "$RID_A" "$CAP_DATE" s1)"
assert_eq "[8p] rien n'a été réservé par ces refus" "0" "$(reservations_in "$DB_FWD" "$RID_A")"
cap_reset "$DB_FWD" "$RID_A" 1 fixed_slots
read -r P1 P2 P3 < <(mk_orders "$DB_FWD" "$RID_A" 3 | tr '\n' ' ')
assert_eq "[8q] créneaux fixes : créneau manquant refusé" "unavailable|slot_not_offered" "$(rsv "$DB_FWD" "$P1" "$RID_A" "$CAP_DATE" -)"
assert_eq "[8r] créneau inconnu refusé" "unavailable|slot_not_offered" "$(rsv "$DB_FWD" "$P1" "$RID_A" "$CAP_DATE" s9)"
assert_eq "[8s] créneau s1 réservé" "reserved|-" "$(rsv "$DB_FWD" "$P1" "$RID_A" "$CAP_DATE" s1)"
assert_eq "[8t] s1 est plein pour la commande suivante" "unavailable|capacity_full" "$(rsv "$DB_FWD" "$P2" "$RID_A" "$CAP_DATE" s1)"
assert_eq "[8u] s2 est un AUTRE seau : réservé" "reserved|-" "$(rsv "$DB_FWD" "$P2" "$RID_A" "$CAP_DATE" s2)"
assert_eq "[8v] la même date, un autre jour, est un autre seau" "reserved|-" "$(rsv "$DB_FWD" "$P3" "$RID_A" "2026-10-15" s1)"
assert_eq "[8w] comptes par seau : s1/14=1, s2/14=1, s1/15=1" "1|1|1" "$(used_in "$DB_FWD" "$RID_A" "$CAP_DATE" s1)|$(used_in "$DB_FWD" "$RID_A" "$CAP_DATE" s2)|$(used_in "$DB_FWD" "$RID_A" 2026-10-15 s1)"
# Planification infaisable
cap_reset "$DB_FWD" "$RID_A" 1 none
sql_on "$DB_FWD" "delete from public.restaurant_fulfillment_schedule_window where restaurant_id='$RID_A';" >/dev/null
O6="$(mk_orders "$DB_FWD" "$RID_A" 1 | head -1)"
assert_eq "[8x] planification configurée mais infaisable : schedule_not_fulfillable, aucune réservation" "unavailable|schedule_not_fulfillable|0" "$(rsv "$DB_FWD" "$O6" "$RID_A" "$CAP_DATE" -)|$(reservations_in "$DB_FWD" "$RID_A")"
# Erreurs d'usage
cap_reset "$DB_FWD" "$RID_A" 1 none
O7="$(mk_orders "$DB_FWD" "$RID_A" 1 | head -1)"
assert_has "[8y] commande inconnue : erreur" "CSDJ12_ORDER_NOT_FOUND" "$(rsv "$DB_FWD" "11111111-1111-4111-8111-111111111111" "$RID_A" "$CAP_DATE" -)"
assert_has "[8z] date nulle : erreur" "CSDJ12_INVALID_ARGUMENTS" "$(sql_on "$DB_FWD" "select * from public.reserve_fulfillment_capacity('$O7','$RID_A','pickup',null,null);")"
assert_has "[8za] clé de créneau malformée : erreur" "CSDJ12_INVALID_ARGUMENTS" "$(rsv "$DB_FWD" "$O7" "$RID_A" "$CAP_DATE" 'S 1;--')"
assert_has "[8zb] zéro UUID comme règle : erreur" "CSDJ12_RESERVED_RULE_ID" "$(sql_on "$DB_FWD" "select * from public.reserve_fulfillment_capacity('$O7','$RID_A','pickup','$NIL_RULE','$CAP_DATE');")"
OB="$(mk_orders "$DB_FWD" "$RID_B" 1 | head -1)"
assert_has "[8zc] TENANT : une commande d'un autre établissement ne réserve pas pour celui-ci" "CSDJ12_FOREIGN_ORDER" "$(rsv "$DB_FWD" "$OB" "$RID_A" "$CAP_DATE" -)"
assert_eq "[8zd] et rien n'a été réservé" "0" "$(reservations_in "$DB_FWD" "$RID_A")"
OR="$(mk_orders "$DB_FWD" "$RID_A" 1 rejected | head -1)"; OC="$(mk_orders "$DB_FWD" "$RID_A" 1 cancelled | head -1)"
assert_has "[8ze] une commande refusée ne peut pas réserver" "CSDJ12_ORDER_NOT_ACTIVE" "$(rsv "$DB_FWD" "$OR" "$RID_A" "$CAP_DATE" -)"
assert_has "[8zf] ni une commande annulée" "CSDJ12_ORDER_NOT_ACTIVE" "$(rsv "$DB_FWD" "$OC" "$RID_A" "$CAP_DATE" -)"
RR_OUT="$(psql -X -A -q -t -d "$DB_FWD" 2>&1 <<SQL
begin transaction isolation level repeatable read;
select * from public.reserve_fulfillment_capacity('$O7','$RID_A','pickup',null,'$CAP_DATE');
rollback;
SQL
)"
assert_has "[8zg] hors READ COMMITTED la réservation REFUSE (le verrou de seau repose sur un instantané frais)" "CSDJ12_ISOLATION_REQUIRED" "$RR_OUT"
RR2_OUT="$(psql -X -A -q -t -d "$DB_FWD" 2>&1 <<SQL
begin transaction isolation level serializable;
select * from public.reserve_fulfillment_capacity('$O7','$RID_A','pickup',null,'$CAP_DATE');
rollback;
SQL
)"
assert_has "[8zh] ni en SERIALIZABLE" "CSDJ12_ISOLATION_REQUIRED" "$RR2_OUT"
assert_eq "[8zi] la transaction du refus d'isolation n'a rien laissé" "0" "$(reservations_in "$DB_FWD" "$RID_A")"
# Date dérivée : la date est choisie par le serveur.
cap_reset "$DB_FWD" "$RID_A" 1 none
sql_on "$DB_FWD" "update public.restaurant_fulfillment_schedule set date_selection_mode='derived_earliest' where restaurant_id='$RID_A';" >/dev/null
read -r Q1 Q2 Q3 < <(mk_orders "$DB_FWD" "$RID_A" 3 | tr '\n' ' ')
assert_eq "[8zj] date dérivée : une date PLUS TARDIVE tant que la première a de la place est refusée" "unavailable|date_not_offered" "$(rsv "$DB_FWD" "$Q1" "$RID_A" "2026-10-16" -)"
assert_eq "[8zk] la première date est réservée" "reserved|-" "$(rsv "$DB_FWD" "$Q1" "$RID_A" "$CAP_DATE" -)"
assert_eq "[8zl] elle est pleine : la même date est refusée (capacity_full)" "unavailable|capacity_full" "$(rsv "$DB_FWD" "$Q2" "$RID_A" "$CAP_DATE" -)"
assert_eq "[8zm] la date que le serveur propose désormais (jeudi 15) est réservable" "reserved|-" "$(rsv "$DB_FWD" "$Q2" "$RID_A" "2026-10-15" -)"
assert_eq "[8zn] jeudi 15 plein, vendredi 16 libre : samedi 17 reste refusé tant que vendredi 16 a de la place" "unavailable|date_not_offered|0" \
  "$(rsv "$DB_FWD" "$Q3" "$RID_A" "2026-10-17" -)|$(used_in "$DB_FWD" "$RID_A" 2026-10-16 '')"

# ============================================================
# [8b] LIBÉRATION — par le CYCLE DE VIE RÉEL des commandes
# ============================================================
log "=== [8b] Libération par update_order_status réel ==="
cap_reset "$DB_FWD" "$RID_A" 1 none
read -r L1 L2 L3 < <(mk_orders "$DB_FWD" "$RID_A" 3 | tr '\n' ' ')
rsv "$DB_FWD" "$L1" "$RID_A" "$CAP_DATE" - >/dev/null
assert_eq "[8b-a] L1 tient la place, L2 est refusée" "unavailable|capacity_full" "$(rsv "$DB_FWD" "$L2" "$RID_A" "$CAP_DATE" -)"
RJ="$(outcome_as authenticated "$OWNER_A" "select * from public.update_order_status('$L1','rejected');")"
assert_eq "[8b-b] le commerçant REFUSE L1 par la vraie RPC update_order_status" "OK" "$RJ"
assert_eq "[8b-c] la place est rendue (aucune écriture de libération : dérivée du statut)" "0" "$(used_in "$DB_FWD" "$RID_A" "$CAP_DATE" '')"
assert_eq "[8b-d] L2 prend la place" "reserved|-" "$(rsv "$DB_FWD" "$L2" "$RID_A" "$CAP_DATE" -)"
assert_eq "[8b-e] la ligne de L1 existe toujours (historique), mais ne compte plus" "2|1" "$(reservations_in "$DB_FWD" "$RID_A")|$(used_in "$DB_FWD" "$RID_A" "$CAP_DATE" '')"
assert_eq "[8b-f] L2 annulée (new -> cancelled) rend la place" "OK|0" "$(outcome_as authenticated "$OWNER_A" "select * from public.update_order_status('$L2','cancelled');")|$(used_in "$DB_FWD" "$RID_A" "$CAP_DATE" '')"
assert_eq "[8b-g] L3 prend la place libérée" "reserved|-" "$(rsv "$DB_FWD" "$L3" "$RID_A" "$CAP_DATE" -)"
outcome_as authenticated "$OWNER_A" "select * from public.update_order_status('$L3','accepted');" >/dev/null
outcome_as authenticated "$OWNER_A" "select * from public.update_order_status('$L3','preparing');" >/dev/null
assert_eq "[8b-h] une commande acceptée puis en préparation TIENT toujours sa place" "1" "$(used_in "$DB_FWD" "$RID_A" "$CAP_DATE" '')"
outcome_as authenticated "$OWNER_A" "select * from public.update_order_status('$L3','cancelled');" >/dev/null
assert_eq "[8b-i] annulée depuis « preparing » : place rendue" "0" "$(used_in "$DB_FWD" "$RID_A" "$CAP_DATE" '')"
Z1="$(mk_orders "$DB_FWD" "$RID_A" 1 | head -1)"
assert_has "[8b-j] le cycle de vie reste borné par tenant : owner B ne peut pas annuler une commande de A" "Not authorized" "$(outcome_as authenticated "$OWNER_B" "select * from public.update_order_status('$Z1','cancelled');")"
# Paiement en ligne
cap_reset "$DB_FWD" "$RID_A" 1 none
read -r M1 M2 M3 < <(mk_orders "$DB_FWD" "$RID_A" 3 new pending | tr '\n' ' ')
assert_eq "[8b-k] paiement « pending » : la commande TIENT sa place (aucune expiration inventée)" "reserved|-" "$(rsv "$DB_FWD" "$M1" "$RID_A" "$CAP_DATE" -)"
assert_eq "[8b-l] une autre commande est refusée tant qu'elle tient" "unavailable|capacity_full" "$(rsv "$DB_FWD" "$M2" "$RID_A" "$CAP_DATE" -)"
sql_on "$DB_FWD" "update public.orders set payment_status='failed' where id='$M1';" >/dev/null
assert_eq "[8b-m] paiement « failed » : la place reste TENUE (une reprise de paiement est possible -- décision CTO)" "1" "$(used_in "$DB_FWD" "$RID_A" "$CAP_DATE" '')"
sql_on "$DB_FWD" "update public.orders set payment_status='cancelled' where id='$M1';" >/dev/null
assert_eq "[8b-n] paiement « cancelled » : idem" "1" "$(used_in "$DB_FWD" "$RID_A" "$CAP_DATE" '')"
assert_eq "[8b-o] libération explicite coordonnée (primitif) : une unité rendue" "t" "$(sql_on "$DB_FWD" "select public.release_fulfillment_capacity('$M1');")"
assert_eq "[8b-p] la libération est idempotente" "f" "$(sql_on "$DB_FWD" "select public.release_fulfillment_capacity('$M1');")"
assert_eq "[8b-q] une autre commande prend la place rendue" "reserved|-" "$(rsv "$DB_FWD" "$M2" "$RID_A" "$CAP_DATE" -)"
assert_eq "[8b-r] la REPRISE du paiement de M1 ne peut pas reprendre sa place : capacity_full (pas de surréservation)" "unavailable|capacity_full" "$(rsv "$DB_FWD" "$M1" "$RID_A" "$CAP_DATE" -)"
assert_eq "[8b-s] le créneau n'est jamais surréservé : 1 unité tenue pour une capacité de 1" "1" "$(used_in "$DB_FWD" "$RID_A" "$CAP_DATE" '')"

# ============================================================
# [9] CONCURRENCE RÉELLE — plusieurs sessions PostgreSQL
# ============================================================
log "=== [9] Concurrence : sessions réelles, barrière de départ ==="
det_conc() { # $1 base ; 0 = exactement la capacité réservée, aucune surréservation
  local db="$1" ids o spec="" r_ok r_full r_err res
  cap_reset "$db" "$RID_A" 3 none
  ids="$(mk_orders "$db" "$RID_A" 8)"
  for o in $ids; do spec="$spec$o $RID_A $CAP_DATE -"$'\n'; done
  conc_run "$db" 0.4 commit < <(printf '%s' "$spec")
  r_ok="$(conc_count 'reserved|-')"; r_full="$(conc_count 'unavailable|capacity_full')"; r_err="$(grep -c 'ERROR' "$CONC_OUT" || true)"
  res="$(reservations_in "$db" "$RID_A")"
  CONC_LAST="8 sessions, capacité 3 : reserved=$r_ok capacity_full=$r_full erreurs=$r_err lignes=$res"
  [ "$r_ok" = "3" ] && [ "$r_full" = "5" ] && [ "$r_err" = "0" ] && [ "$res" = "3" ]
}
for round in 1 2 3; do
  if det_conc "$DB_FWD"; then pass "[9a.$round] $CONC_LAST -- EXACTEMENT la capacité, jamais plus"
  else fail "[9a.$round] SURRÉSERVATION ou perte : $CONC_LAST"; fi
done
assert_eq "[9b] le décompte autoritaire est 3 pour 3 de capacité" "3" "$(used_in "$DB_FWD" "$RID_A" "$CAP_DATE" '')"

det_conc_slots() { # deux créneaux, capacité 1 chacun, 6 sessions chacun
  local db="$1" ids o spec="" k=0 ok1 ok2 res
  cap_reset "$db" "$RID_A" 1 fixed_slots
  ids="$(mk_orders "$db" "$RID_A" 12)"
  for o in $ids; do k=$((k+1)); spec="$spec$o $RID_A $CAP_DATE $( [ $k -le 6 ] && echo s1 || echo s2 )"$'\n'; done
  conc_run "$db" 0.4 commit < <(printf '%s' "$spec")
  ok1="$(awk -F'|' '$1>=1 && $1<=6 && $2=="R" && $3=="reserved"' "$CONC_OUT" | wc -l | tr -d ' ')"
  ok2="$(awk -F'|' '$1>=7 && $1<=12 && $2=="R" && $3=="reserved"' "$CONC_OUT" | wc -l | tr -d ' ')"
  res="$(reservations_in "$db" "$RID_A")"
  CONC_LAST="12 sessions, 2 créneaux de capacité 1 : s1=$ok1 s2=$ok2 lignes=$res"
  [ "$ok1" = "1" ] && [ "$ok2" = "1" ] && [ "$res" = "2" ]
}
if det_conc_slots "$DB_FWD"; then pass "[9c] $CONC_LAST -- un seul par créneau, les deux créneaux avancent en parallèle"
else fail "[9c] $CONC_LAST"; fi

# Preuve de BLOCAGE : la seconde session ATTEND le verrou de seau tant que la
# première n'a pas terminé, puis rejuge sur l'état validé.
# probe_hold <base> <commit|rollback> <specA> <specB>  (spec = "commande restaurant date créneau")
PROBE_BLOCKED=""; PROBE_B=""; PROBE_B_BEFORE=""; PROBE_A_ALIVE=""
probe_hold() {
  local db="$1" final="$2" a_spec="$3" b_spec="$4" ao ar ad as bo br bd bs aslot bslot n i apid bpid
  read -r ao ar ad as <<<"$a_spec"; read -r bo br bd bs <<<"$b_spec"
  aslot="null"; [ "$as" != "-" ] && aslot="'$as'"; bslot="null"; [ "$bs" != "-" ] && bslot="'$bs'"
  local aout="$TMP_DIR/probeA.$RANDOM" bout="$TMP_DIR/probeB.$RANDOM"; : > "$aout"; : > "$bout"
  ( psql -X -A -q -t -d "$db" >"$aout" 2>&1 <<SQL
begin;
select 'R|' || result || '|' || coalesce(reason,'-') from public.reserve_fulfillment_capacity('$ao','$ar','pickup',null,'$ad',$aslot,'$CAP_NOW'::timestamptz);
select pg_sleep(4);
$final;
SQL
  ) & apid=$!
  i=0; while [ "$(sql_on "$db" "select count(*) from pg_stat_activity where datname='$db' and query like '%pg_sleep(4)%' and query not like '%pg_stat_activity%';")" != "1" ]; do
    i=$((i+1)); [ $i -gt 200 ] && fatal "la session A n'a jamais atteint son point d'attente."; sleep 0.02
  done
  ( psql -X -A -q -t -d "$db" >"$bout" 2>&1 <<SQL
select 'R|' || result || '|' || coalesce(reason,'-') from public.reserve_fulfillment_capacity('$bo','$br','pickup',null,'$bd',$bslot,'$CAP_NOW'::timestamptz);
SQL
  ) & bpid=$!
  PROBE_BLOCKED=0; i=0
  while [ $i -lt 40 ]; do
    n="$(sql_on "$db" "select count(*) from pg_stat_activity where datname='$db' and wait_event_type='Lock' and wait_event='advisory' and query like '%reserve_fulfillment_capacity%';")"
    if [ "$n" = "1" ]; then PROBE_BLOCKED=1; break; fi
    if ! kill -0 "$bpid" 2>/dev/null; then break; fi
    i=$((i+1)); sleep 0.05
  done
  PROBE_B_BEFORE="$(grep -c '^R|' "$bout" || true)"
  PROBE_A_ALIVE=0; kill -0 "$apid" 2>/dev/null && PROBE_A_ALIVE=1
  wait "$apid" "$bpid"
  PROBE_B="$(grep '^R|' "$bout" | head -1)"
}
det_block() { # $1 base ; 0 = la seconde session ATTEND puis juge sur l'état validé
  local db="$1" a b
  cap_reset "$db" "$RID_A" 1 none
  read -r a b < <(mk_orders "$db" "$RID_A" 2 | tr '\n' ' ')
  probe_hold "$db" commit "$a $RID_A $CAP_DATE -" "$b $RID_A $CAP_DATE -"
  CONC_LAST="bloquée=$PROBE_BLOCKED résultat_avant_fin_de_A=$PROBE_B_BEFORE résultat_final=$PROBE_B lignes=$(reservations_in "$db" "$RID_A")"
  [ "$PROBE_BLOCKED" = "1" ] && [ "$PROBE_B_BEFORE" = "0" ] && [ "$PROBE_B" = "R|unavailable|capacity_full" ] && [ "$(reservations_in "$db" "$RID_A")" = "1" ]
}
if det_block "$DB_FWD"; then pass "[9d] la 2e session ATTEND le verrou (pg_stat_activity : Lock/advisory), n'obtient rien tant que A n'a pas validé, puis voit capacity_full ($CONC_LAST)"
else fail "[9d] pas de sérialisation observée : $CONC_LAST"; fi

cap_reset "$DB_FWD" "$RID_A" 1 none
read -r A2 B2 < <(mk_orders "$DB_FWD" "$RID_A" 2 | tr '\n' ' ')
probe_hold "$DB_FWD" rollback "$A2 $RID_A $CAP_DATE -" "$B2 $RID_A $CAP_DATE -"
if [ "$PROBE_BLOCKED" = "1" ] && [ "$PROBE_B" = "R|reserved|-" ] && [ "$(reservations_in "$DB_FWD" "$RID_A")" = "1" ]; then
  pass "[9e] A annule (ROLLBACK) : la session en attente PREND la place libérée (aucune place perdue)"
else fail "[9e] après ROLLBACK de A : bloquée=$PROBE_BLOCKED résultat=$PROBE_B lignes=$(reservations_in "$DB_FWD" "$RID_A")"; fi

cap_reset "$DB_FWD" "$RID_A" 1 none
read -r A3 B3 < <(mk_orders "$DB_FWD" "$RID_A" 2 | tr '\n' ' ')
probe_hold "$DB_FWD" commit "$A3 $RID_A $CAP_DATE -" "$B3 $RID_A 2026-10-15 -"
if [ "$PROBE_BLOCKED" = "0" ] && [ "$PROBE_B" = "R|reserved|-" ] && [ "$PROBE_A_ALIVE" = "1" ]; then
  pass "[9f] un AUTRE seau (autre date) n'attend pas : B termine pendant que A tient son verrou"
else fail "[9f] seaux indépendants : bloquée=$PROBE_BLOCKED résultat=$PROBE_B A_vivante=$PROBE_A_ALIVE"; fi

cap_reset "$DB_FWD" "$RID_A" 1 none
cap_reset "$DB_FWD" "$RID_B" 1 none
A4="$(mk_orders "$DB_FWD" "$RID_A" 1 | head -1)"; B4="$(mk_orders "$DB_FWD" "$RID_B" 1 | head -1)"
probe_hold "$DB_FWD" commit "$A4 $RID_A $CAP_DATE -" "$B4 $RID_B $CAP_DATE -"
if [ "$PROBE_BLOCKED" = "0" ] && [ "$PROBE_B" = "R|reserved|-" ] && [ "$PROBE_A_ALIVE" = "1" ]; then
  pass "[9g] un AUTRE établissement, même date, n'attend pas : le verrou est borné par tenant"
else fail "[9g] tenants indépendants : bloquée=$PROBE_BLOCKED résultat=$PROBE_B A_vivante=$PROBE_A_ALIVE"; fi

# ============================================================
# [16] CONTRÔLES PAR MUTATION — le harnais sait-il VOIR une régression ?
#
# Chaque détecteur est d'abord exécuté sur la migration RÉELLE (il doit
# la déclarer saine), puis sur des mutants : la même migration avec UNE
# modification ciblée. Un mutant que le détecteur ne distingue pas de la
# migration saine prouve que le test ne prouve rien.
# ============================================================
log "=== [16] Contrôles par mutation ==="
det_fixture() { replay_v12 "$1" >/dev/null 2>&1; }
det_seq() { # capacité 2 : réservé, réservé, plein ; un refus par la RPC réelle rend la place
  local db="$1" a b c d r1 r2 r3 r4 rj
  cap_reset "$db" "$RID_A" 2 none
  read -r a b c d < <(mk_orders "$db" "$RID_A" 4 | tr '\n' ' ')
  r1="$(rsv "$db" "$a" "$RID_A" "$CAP_DATE" -)"; r2="$(rsv "$db" "$b" "$RID_A" "$CAP_DATE" -)"; r3="$(rsv "$db" "$c" "$RID_A" "$CAP_DATE" -)"
  rj="$(run_sql "$db" authenticated "$OWNER_A" "select new_status from public.update_order_status('$a','rejected');" | tail -1 | tr -d ' ')"
  r4="$(rsv "$db" "$d" "$RID_A" "$CAP_DATE" -)"
  CONC_LAST="$r1 / $r2 / $r3 / refus=$rj / $r4 / tenues=$(used_in "$db" "$RID_A" "$CAP_DATE" '')"
  [ "$r1" = "reserved|-" ] && [ "$r2" = "reserved|-" ] && [ "$r3" = "unavailable|capacity_full" ] \
    && [ "$rj" = "rejected" ] && [ "$r4" = "reserved|-" ] && [ "$(used_in "$db" "$RID_A" "$CAP_DATE" '')" = "2" ]
}
det_tenant() {
  local db="$1" ob r
  cap_reset "$db" "$RID_A" 2 none; cap_reset "$db" "$RID_B" 2 none
  ob="$(mk_orders "$db" "$RID_B" 1 | head -1)"
  r="$(rsv "$db" "$ob" "$RID_A" "$CAP_DATE" -)"
  CONC_LAST="$r / lignes A=$(reservations_in "$db" "$RID_A")"
  has "$r" "CSDJ12_FOREIGN_ORDER" && [ "$(reservations_in "$db" "$RID_A")" = "0" ]
}

det_ctl_fail=0
for det in det_fixture det_seq det_tenant det_conc det_block; do
  if "$det" "$DB_FWD"; then pass "[16-ctl] détecteur $det : la migration RÉELLE est déclarée saine"
  else fail "[16-ctl] détecteur $det : la migration RÉELLE est déclarée défaillante ($CONC_LAST)"; det_ctl_fail=1; fi
done

mutant() { # $1 nom ; $2.. détecteurs qui DOIVENT le voir
  local name="$1"; shift
  psql -X -q -d postgres -c "drop database if exists \"$DB_MUT\";" >/dev/null 2>&1
  create_tracked_db "$DB_MUT" -T "$DB_V1"
  if ! python3 - "$SUPABASE_DIR/$LOT_SQL" "$TMP_DIR/mut.sql" "$name" <<'PYMUT'
import re, sys
s = open(sys.argv[1], encoding="utf-8").read()
M = {
  "no-lock": (r"perform pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(\n\s+p_restaurant_id::text.*?1204\)\);", "null;"),
  "capacity-gt": (r"if v_used >= v_s\.capacity_max_orders then", "if v_used > v_s.capacity_max_orders then"),
  "holding-always": (r"select p_status is distinct from 'rejected'\n\s+and p_status is distinct from 'cancelled';", "select true;"),
  "cutoff-gt": (r"v_cut_reached := \(p_now >= v_cut_at\);", "v_cut_reached := (p_now > v_cut_at);"),
  "dispatch-v1": (r"if v_method = 'v1\.2' then", "if false then"),
  "capacity-filter-off": (r"if p_apply_capacity and v_s\.capacity_enabled then", "if false then"),
  "tenant-check-off": (r"if v_o\.restaurant_id is distinct from p_restaurant_id then", "if false then"),
  "holiday-prep-ignored": (r"and not \(\n(\s+)p_s\.preparation_on_holidays = 'closed'", r"and not (\n\1false and p_s.preparation_on_holidays = 'closed'"),
  "avail-closure-ignored": (r"c\.rule_key = p_s\.rule_key and c\.closed_on = p_date\)\n(\s+)or \(p_s\.availability_on_holidays", r"c.rule_key = p_s.rule_key and c.closed_on = p_date and false)\n\1or (p_s.availability_on_holidays"),
}
pat, rep = M[sys.argv[3]]
new, n = re.subn(pat, rep, s, flags=re.S)
if n != 1:
    sys.exit(f"le mutant {sys.argv[3]} s'applique {n} fois (1 attendue)")
open(sys.argv[2], "w", encoding="utf-8").write(new)
PYMUT
  then fail "[16] mutant « $name » : motif introuvable dans la migration (le contrôle ne contrôle rien)"; return; fi
  if ! apply_path "$TMP_DIR/mut.sql" "$DB_MUT"; then fail "[16] mutant « $name » : ne s'applique pas ($(tail -2 "$OUT" | tr '\n' ' '))"; return; fi
  local det
  for det in "$@"; do
    if "$det" "$DB_MUT"; then fail "[16] mutant « $name » NON DÉTECTÉ par $det -- ce détecteur ne prouve pas ce qu'il prétend"
    else pass "[16] mutant « $name » DÉTECTÉ par $det"; fi
  done
}
mutant no-lock             det_conc det_block
mutant capacity-gt         det_seq
mutant holding-always      det_seq
mutant cutoff-gt           det_fixture
mutant dispatch-v1         det_fixture
mutant capacity-filter-off det_fixture
mutant tenant-check-off    det_tenant
mutant holiday-prep-ignored det_fixture
mutant avail-closure-ignored det_fixture
psql -X -q -d postgres -c "drop database if exists \"$DB_MUT\";" >/dev/null 2>&1

# ============================================================
# [13] RETOUR ARRIÈRE — fidélité exacte et refus explicites
# ============================================================
log "=== [13] Retour arrière ==="
create_tracked_db "$DB_RB" -T "$DB_V1"
apply_path "$SUPABASE_DIR/$LOT_SQL" "$DB_RB" || fatal "aller sur la base de rollback : $(tail -3 "$OUT" | tr '\n' ' ')"
RB_BASE="$TMP_DIR/inv.rb.afterfwd"; inventory "$DB_RB" | sort > "$RB_BASE"
if cmp -s "$RB_BASE" "$TMP_DIR/inv.fwd"; then pass "[13-0] l'aller rejoué sur un clone propre donne l'inventaire de référence de la section [15]"
else fail "[13-0] l'aller n'est pas reproductible (inventaires différents)"; fi

rb_refuses() { # $1 étiquette ; $2 SQL de mise en place ; $3 SQL de nettoyage ; $4 fragment attendu
  [ "$(outcome_on "$DB_RB" "$2")" = "OK" ] || fatal "mise en place du cas de refus « $1 » impossible : le test ne testerait rien."
  if apply_path "$SUPABASE_DIR/$LOT_ROLLBACK" "$DB_RB"; then
    fail "[13r] retour appliqué malgré : $1 -- donnée v1.2 perdue en silence"
  else
    if grep -q 'SCANYM_ROLLBACK_REFUSED' "$OUT" && grep -q "$4" "$OUT"; then pass "[13r] le retour REFUSE nommément devant : $1"
    else fail "[13r] refus pour la mauvaise raison devant $1 : $(tail -2 "$OUT" | tr '\n' ' ')"; fi
  fi
  inventory "$DB_RB" | sort > "$TMP_DIR/inv.rb.now"
  if cmp -s "$TMP_DIR/inv.rb.now" "$RB_BASE"; then pass "[13r] et le refus ne change RIEN au schéma ($1)"
  else fail "[13r] le refus a modifié le schéma ($1)"; fi
  sql_on "$DB_RB" "$3" >/dev/null
}
CLEAN_RB="delete from public.order_fulfillment_capacity_reservation; delete from public.orders where restaurant_id in ('$RID_A','$RID_B'); delete from public.restaurant_fulfillment_schedule; delete from public.public_holiday_calendar;"
V1_ROW="insert into public.restaurant_fulfillment_schedule (restaurant_id, mode_code, timezone, enabled, date_selection_mode, slot_selection_mode) values ('$RID_A','pickup','Europe/Paris',false,'customer_selectable','none')"
rb_refuses "une planification de méthode v1.2" \
  "insert into public.restaurant_fulfillment_schedule (restaurant_id, mode_code, timezone, enabled, schedule_method_version, cutoff_offset_days) values ('$RID_A','pickup','Europe/Paris',false,'v1.2',0);" "$CLEAN_RB" "planification(s) de méthode v1.2"
rb_refuses "un jour de préparation" \
  "$V1_ROW; insert into public.restaurant_fulfillment_prep_day values ('$RID_A','pickup','$NIL_RULE',1);" "$CLEAN_RB" "jour(s) de préparation"
rb_refuses "une fermeture de préparation" \
  "$V1_ROW; insert into public.restaurant_fulfillment_prep_closure (restaurant_id, mode_code, rule_key, closed_on) values ('$RID_A','pickup','$NIL_RULE','2026-12-25');" "$CLEAN_RB" "fermeture(s) de préparation"
rb_refuses "un calendrier férié" \
  "insert into public.public_holiday_calendar (code,label) values ('t','t');" "$CLEAN_RB" "calendrier(s) férié(s)"
rb_refuses "une réservation de capacité" \
  "with o as (insert into public.orders (restaurant_id, order_number, service_mode, subtotal, total, currency) values ('$RID_A', 1, 'pickup', 1, 1, 'EUR') returning id) insert into public.order_fulfillment_capacity_reservation (order_id, restaurant_id, mode_code, rule_key, fulfillment_date) select id, '$RID_A', 'pickup', '$NIL_RULE', '2026-10-14' from o;" "$CLEAN_RB" "réservation(s) de capacité"

# Données v1 : elles doivent traverser le retour INTACTES.
sql_on "$DB_RB" "$V1_ROW; insert into public.restaurant_fulfillment_schedule_window (restaurant_id, mode_code, rule_key, weekday, starts_at, ends_at) values ('$RID_A','pickup','$NIL_RULE',2,'11:00','14:00'); insert into public.restaurant_fulfillment_schedule_closure (restaurant_id, mode_code, rule_key, closed_on) values ('$RID_A','pickup','$NIL_RULE','2026-12-25');" >/dev/null
V1DATA_SQL="select md5(coalesce((select string_agg(concat_ws('|',restaurant_id,mode_code,rule_key,timezone,enabled,date_selection_mode,slot_selection_mode,lead_time_minutes,min_lead_days,cutoff_time,cutoff_offset_days,booking_horizon_days,schedule_method_version), ';' order by restaurant_id, mode_code, rule_key) from public.restaurant_fulfillment_schedule),'') || (select coalesce(string_agg(concat_ws('|',weekday,starts_at,ends_at), ';' order by weekday, starts_at), '') from public.restaurant_fulfillment_schedule_window) || (select coalesce(string_agg(closed_on::text, ';' order by closed_on), '') from public.restaurant_fulfillment_schedule_closure));"
V1DATA_BEFORE="$(sql_on "$DB_RB" "$V1DATA_SQL")"
if apply_path "$SUPABASE_DIR/$LOT_ROLLBACK" "$DB_RB"; then pass "[13] le retour s'applique (aucune donnée v1.2)"
else fail "[13] le retour ÉCHOUE : $(tail -5 "$OUT" | tr '\n' ' ')"; fi
assert_eq "[13a] la configuration v1 (planification, fenêtres, fermetures) traverse le retour INTACTE" "$V1DATA_BEFORE" "$(sql_on "$DB_RB" "$V1DATA_SQL")"
sql_on "$DB_RB" "delete from public.restaurant_fulfillment_schedule;" >/dev/null
inventory "$DB_RB" | sort > "$TMP_DIR/inv.rb.after"
if cmp -s "$TMP_DIR/inv.rb.after" "$TMP_DIR/inv.v1"; then
  pass "[13b] APRÈS le retour, l'inventaire COMPLET (fonctions par corps et droits, colonnes, contraintes, politiques, déclencheurs, droits de table) est IDENTIQUE à l'état PROD d'avant la v1.2"
else
  fail "[13b] le retour ne restaure pas l'état d'avant : $(diff "$TMP_DIR/inv.v1" "$TMP_DIR/inv.rb.after" | head -6 | tr '\n' ' ')"
fi
assert_eq "[13c] comptes de schéma identiques à l'état PROD" "$V1_COUNTS" "$(schema_counts "$DB_RB")"
assert_eq "[13d] le résolveur d'origine est de retour OCTET POUR OCTET, droits compris" "$V1_RESOLVER_SRC|$V1_RESOLVER_ACL" \
  "$(sql_on "$DB_RB" "select md5(prosrc) || '|' || coalesce(proacl::text,'-') from pg_proc where proname='resolve_fulfillment_schedule' and pronamespace='public'::regnamespace;")"
psql -X -q -d "$DB_RB" -v ON_ERROR_STOP=1 -f "$V1_FIX_SQL" 2>"$ERR" | grep -v '^$' > "$TMP_DIR/v1fix.rb" || fail "[13e] rejeu CSDJ-1 après retour impossible"
if cmp -s "$TMP_DIR/v1fix.pre" "$TMP_DIR/v1fix.rb"; then pass "[13e] la fixture CSDJ-1 donne APRÈS le retour les mêmes octets qu'AVANT la v1.2"
else fail "[13e] le comportement v1 diffère après retour"; fi
if apply_path "$SUPABASE_DIR/$LOT_ROLLBACK" "$DB_RB"; then fail "[13f] un second retour s'est appliqué"
else assert_has "[13f] un second retour est REFUSÉ nommément" "SCANYM_ROLLBACK_NOT_APPLICABLE" "$(cat "$OUT")"; fi
if apply_path "$SUPABASE_DIR/$LOT_SQL" "$DB_RB"; then pass "[13g] la v1.2 se RÉ-APPLIQUE après un retour (cycle complet)"
else fail "[13g] ré-application après retour impossible : $(tail -3 "$OUT" | tr '\n' ' ')"; fi
inventory "$DB_RB" | sort > "$TMP_DIR/inv.rb.reapplied"
if cmp -s "$TMP_DIR/inv.rb.reapplied" "$TMP_DIR/inv.fwd"; then pass "[13h] et l'état obtenu est IDENTIQUE à celui de la première application"
else fail "[13h] aller / retour / aller ne converge pas"; fi

log "=== BILAN : $PASS_COUNT preuve(s) produite(s), $FAIL_COUNT échec(s) ==="
[ "$FAIL_COUNT" -eq 0 ] || exit 1
exit 0
