#!/usr/bin/env bash
# ============================================================
# Scanym — CHECKOUT SCHEDULING FOUNDATION v1 (CSDJ-1)
# Harnais PostgreSQL JETABLE et reproductible pour
#   supabase/DRAFT-lot-checkout-scheduling-foundation-v1.sql
#   supabase/DRAFT-lot-checkout-scheduling-foundation-v1-rollback.sql
#
# Même patron que supabase/tests/customer-followup-tracking-email-v1-check.sh
# (contrat de référence du dépôt) : bases jetables, rôles
# anon/authenticated/service_role recréés minimalement, auth.uid()
# simulé via `test.uid`, aucun appel réseau, aucun prestataire, aucune
# donnée réelle. La CHAÎNE PRÉDÉCESSEUR est reprise VERBATIM de ce
# harnais-là : ce lot n'exige aucun maillon supplémentaire, puisqu'il
# ne se greffe que sur le modèle de modes de vente et sur l'autorité de
# tarification de livraison, tous deux présents dans REST_CHAIN.
#
# ------------------------------------------------------------------
# CE QUE CE HARNAIS PROUVE (exécuté, jamais inspecté)
#   [1] le SQL aller s'applique sur le schéma PRÉDÉCESSEUR réel ;
#   [2] ATOMICITÉ : un post-vol qui échoue EMPÊCHE le commit -- ni
#       table, ni fonction, ni policy ne subsiste ;
#   [3] tables / RLS / policies / fonctions / grants contractés, et
#       AUCUN grant d'écriture pour aucun rôle applicatif ;
#   [4] ISOLATION MULTI-LOCATAIRES : un owner ne lit ni n'écrit la
#       planification d'un autre commerçant, une règle de livraison
#       étrangère est refusée nommément, et `anon` n'a AUCUN accès
#       direct aux quatre tables ;
#   [5] ACL D'ÉCRITURE : owner et manager écrivent, staff et étranger
#       sont refusés (42501), session anonyme refusée (28000) ;
#   [6] FIXTURE PARTAGÉE : chacun des cas de
#       tests/fixtures/checkout-scheduling-cases.json est rejoué contre
#       public.resolve_fulfillment_schedule et doit rendre EXACTEMENT
#       le statut, le motif, la première date et la liste de dates que
#       la fixture attend -- les mêmes cas que le TypeScript, les
#       attendus venant d'une troisième implémentation ;
#   [7] CSDJ-V1-SCHEDULE-ABSENT-01 : sans ligne, et avec une ligne
#       `enabled = false`, le statut est `absent` et rien d'autre ;
#   [8] CSDJ-V1-UNFULFILLABLE-EXPLICIT-01 : une planification activée
#       et infaisable rend `unfulfillable` AVEC son motif, et AUCUNE
#       date -- jamais une date de repli ;
#   [9] AUCUNE FUITE DE FOURNISSEUR : la lecture publique ne renvoie
#       ni provider, ni fulfillment_code, ni fulfillment_rule_id ;
#  [10] l'autorité de tarification EXISTANTE est appelée, et la
#       décision de zone et de tarif qu'elle rend est recopiée telle
#       quelle -- aucune seconde formule ;
#  [11] CSDJ-V1-SERVER-CLOCK-01 : la lecture publique n'accepte aucune
#       heure de l'appelant, et l'autorité qui en accepte une pour la
#       fixture n'est exécutable par AUCUN rôle applicatif ;
#  [12] validation d'écriture : fuseau inconnu, politique hors
#       catalogue, politique incohérente, fenêtres superposées, clé de
#       créneau malformée -- tous refusés ;
#  [13] le rollback s'applique, et l'état PRÉDÉCESSEUR est restauré à
#       l'identique (comptes de schéma, create_order intacte) ;
#  [14] le rollback REFUSE de passer sous une table d'instantané de
#       CSDJ-3, plutôt que de casser un historique de commandes.
#
# CE QUE CE HARNAIS NE FAIT PAS : aucun envoi d'e-mail, aucun appel
# transporteur, aucune écriture hors des bases jetables qu'il crée
# lui-même.
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
# Ce modèle de sûreté est repris VERBATIM de
# supabase/tests/merchant-customer-communications-v1-check.sh (v1.1), et
# ses 47 preuves COMPORTEMENTALES sont produites par son harnais
# compagnon déjà au dépôt :
#   supabase/tests/merchant-customer-communications-v1-harness-safety-check.sh
# Ce lot ne duplique donc pas ces preuves : il réutilise le modèle
# qu'elles couvrent, et tests/csdj1-sql-structural.test.ts vérifie que
# ce fichier-ci porte bien les mêmes garde-fous.
#
# Usage :  SCANYM_DISPOSABLE_CLUSTER=1 \
#            bash supabase/tests/checkout-scheduling-foundation-v1-check.sh
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
export PGAPPNAME="scanym-csdj1-harness"

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
DB_BASE="scanym_csdj1_base_$RUN_TAG"
DB_FWD="scanym_csdj1_fwd_$RUN_TAG"
DB_ATOMIC="scanym_csdj1_atomic_$RUN_TAG"
DB_RB="scanym_csdj1_rb_$RUN_TAG"

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

FIXTURE_JSON="$SCRIPT_DIR/../../tests/fixtures/checkout-scheduling-cases.json"
[ -f "$FIXTURE_JSON" ] || fatal "fixture partagée absente : tests/fixtures/checkout-scheduling-cases.json"
LOT_SQL="DRAFT-lot-checkout-scheduling-foundation-v1.sql"
LOT_ROLLBACK="DRAFT-lot-checkout-scheduling-foundation-v1-rollback.sql"

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
         "$LOT_SQL" "$LOT_ROLLBACK"; do
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
# [1] ALLER — s'applique sur le prédécesseur réel.
# ============================================================
log "=== [1] Application du SQL aller ==="
clone_base "$DB_FWD"
if apply_path "$SUPABASE_DIR/$LOT_SQL" "$DB_FWD"; then
  pass "[1] le SQL aller s'applique sur le schéma prédécesseur réel"
else
  fail "[1] le SQL aller ÉCHOUE : $(tail -5 "$OUT" | tr '\n' ' ')"
fi
DB="$DB_FWD"

# ============================================================
# [2] ATOMICITÉ — un post-vol en échec empêche le commit.
# ============================================================
log "=== [2] Atomicité : post-vol saboté ==="
clone_base "$DB_ATOMIC"
SABOTAGE="$TMP_DIR/sabotage.sql"
# On remplace la première assertion du post-vol par une assertion
# toujours fausse : si l'atomicité tient, RIEN ne subsiste.
sed "s/raise exception 'SCANYM_POSTCHECK: table % absente.', v_t;/raise exception 'SCANYM_POSTCHECK_SABOTAGE';/" \
  "$SUPABASE_DIR/$LOT_SQL" > "$SABOTAGE"
sed -i "s/if pg_catalog.to_regclass('public.' || v_t) is null then/if true then/" "$SABOTAGE"
if grep -q 'SCANYM_POSTCHECK_SABOTAGE' "$SABOTAGE"; then
  if apply_path "$SABOTAGE" "$DB_ATOMIC"; then
    fail "[2] le fichier saboté s'est appliqué -- l'atomicité ne tient pas"
  else
    pass "[2] un post-vol en échec interrompt la transaction"
  fi
  assert_eq "[2a] aucune table du lot ne subsiste après l'échec" "0" \
    "$(sql_on "$DB_ATOMIC" "select count(*) from pg_class where relnamespace='public'::regnamespace and relname like 'restaurant_fulfillment_schedule%';")"
  assert_eq "[2b] aucune fonction du lot ne subsiste après l'échec" "0" \
    "$(sql_on "$DB_ATOMIC" "select count(*) from pg_proc where pronamespace='public'::regnamespace and (proname like 'checkout_%' or proname like '%fulfillment_schedule%');")"
else
  fail "[2] sabotage impossible à injecter -- preuve d'atomicité non produite"
fi

# ============================================================
# [3] Structure et posture de sécurité
# ============================================================
log "=== [3] Structure et posture de sécurité ==="
assert_eq "[3a] les 4 tables du lot existent" "4" \
  "$(sql_value "select count(*) from pg_class where relnamespace='public'::regnamespace and relkind='r' and relname like 'restaurant_fulfillment_schedule%';")"
assert_eq "[3b] RLS active sur les 4 tables" "4" \
  "$(sql_value "select count(*) from pg_class where relnamespace='public'::regnamespace and relname like 'restaurant_fulfillment_schedule%' and relrowsecurity;")"
assert_eq "[3c] une policy SELECT par table, et AUCUNE policy d'écriture" "4|0" \
  "$(sql_value "select count(*) filter (where cmd='SELECT') || '|' || count(*) filter (where cmd <> 'SELECT') from pg_policies where schemaname='public' and tablename like 'restaurant_fulfillment_schedule%';")"
assert_eq "[3d] les 8 fonctions du lot existent, une surcharge chacune" "8" \
  "$(sql_value "select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in ('checkout_date_selection_modes','checkout_slot_selection_modes','checkout_schedule_statuses','checkout_unfulfillable_reasons','resolve_fulfillment_schedule','get_checkout_fulfillment_schedule','get_merchant_fulfillment_schedules','mutate_merchant_fulfillment_schedule');")"
assert_eq "[3e] AUCUN grant d'écriture sur les 4 tables, pour aucun rôle" "0" \
  "$(sql_value "select count(*) from (select unnest(array['anon','authenticated','service_role']) r, unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p) x, pg_class c where c.relnamespace='public'::regnamespace and c.relname like 'restaurant_fulfillment_schedule%' and has_table_privilege(x.r, c.oid, x.p);")"
assert_eq "[3f] anon n'a AUCUN SELECT direct sur les 4 tables" "0" \
  "$(sql_value "select count(*) from pg_class c where c.relnamespace='public'::regnamespace and c.relname like 'restaurant_fulfillment_schedule%' and has_table_privilege('anon', c.oid, 'SELECT');")"
assert_eq "[3g] authenticated a SELECT sur les 4 tables" "4" \
  "$(sql_value "select count(*) from pg_class c where c.relnamespace='public'::regnamespace and c.relname like 'restaurant_fulfillment_schedule%' and has_table_privilege('authenticated', c.oid, 'SELECT');")"
assert_eq "[3h] les 4 tables NAISSENT VIDES (aucun backfill)" "0" \
  "$(sql_value "select (select count(*) from public.restaurant_fulfillment_schedule) + (select count(*) from public.restaurant_fulfillment_schedule_window) + (select count(*) from public.restaurant_fulfillment_schedule_slot) + (select count(*) from public.restaurant_fulfillment_schedule_closure);")"
assert_eq "[3i] toutes les fonctions du lot fixent search_path = ''" "8" \
  "$(sql_value "select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in ('checkout_date_selection_modes','checkout_slot_selection_modes','checkout_schedule_statuses','checkout_unfulfillable_reasons','resolve_fulfillment_schedule','get_checkout_fulfillment_schedule','get_merchant_fulfillment_schedules','mutate_merchant_fulfillment_schedule') and array_to_string(proconfig,',') like '%search_path=%';")"
assert_eq "[3j] SEULE la lecture publique est exécutable par anon" "1" \
  "$(sql_value "select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and (p.proname like 'checkout_%' or p.proname like '%fulfillment_schedule%') and has_function_privilege('anon', p.oid, 'EXECUTE');")"
assert_eq "[3k] l'autorité d'éligibilité n'est exécutable par AUCUN rôle applicatif" "0" \
  "$(sql_value "select count(*) from (select unnest(array['anon','authenticated','service_role']) r) x, pg_proc p where p.pronamespace='public'::regnamespace and p.proname='resolve_fulfillment_schedule' and has_function_privilege(x.r, p.oid, 'EXECUTE');")"
assert_eq "[3l] les 4 catalogues ne sont exécutables par AUCUN rôle applicatif" "0" \
  "$(sql_value "select count(*) from (select unnest(array['anon','authenticated','service_role']) r) x, pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('checkout_date_selection_modes','checkout_slot_selection_modes','checkout_schedule_statuses','checkout_unfulfillable_reasons') and has_function_privilege(x.r, p.oid, 'EXECUTE');")"

# Les catalogues disent exactement ce que le TypeScript dit.
assert_eq "[3m] catalogue des politiques de date" "customer_selectable|derived_earliest|informational_only" \
  "$(sql_value "select array_to_string(public.checkout_date_selection_modes(), '|');")"
assert_eq "[3n] catalogue des politiques d'horaire" "none|time_within_window|fixed_slots" \
  "$(sql_value "select array_to_string(public.checkout_slot_selection_modes(), '|');")"
assert_eq "[3o] catalogue des statuts" "absent|blocked_upstream|informational_only|dates_available|unfulfillable" \
  "$(sql_value "select array_to_string(public.checkout_schedule_statuses(), '|');")"
assert_eq "[3p] catalogue des motifs d'infaisabilité" "no_offer_configured|granularity_missing|all_dates_closed|horizon_exhausted" \
  "$(sql_value "select array_to_string(public.checkout_unfulfillable_reasons(), '|');")"

# ============================================================
# [9] AUCUNE FUITE DE FOURNISSEUR
# ============================================================
log "=== [9] Aucune fuite de fournisseur ni de code interne ==="
PUBLIC_RESULT="$(sql_value "select pg_get_function_result('public.get_checkout_fulfillment_schedule(uuid,text,text,integer,numeric)'::regprocedure);")"
for forbidden in provider fulfillment_code fulfillment_rule_id zone_prefixes; do
  case "$PUBLIC_RESULT" in
    *"$forbidden"*) fail "[9] la lecture publique exposerait « $forbidden »" ;;
    *) pass "[9] la lecture publique n'expose pas « $forbidden »" ;;
  esac
done

# ============================================================
# [10] L'AUTORITÉ DE TARIFICATION EXISTANTE EST RÉUTILISÉE
# ============================================================
log "=== [10] Autorité de tarification réutilisée, jamais réécrite ==="
assert_eq "[10a] resolve_delivery_fulfillment est INCHANGÉE par le lot" "$BASE_RESOLVER_FP" \
  "$(fn_code_fingerprint 'resolve_delivery_fulfillment')"
assert_eq "[10b] create_order est INCHANGÉE par le lot" "$BASE_CO_FP" \
  "$(fn_code_fingerprint 'create_order')"
assert_eq "[10c] create_order n'a toujours qu'une surcharge" "1" \
  "$(sql_value "select count(*) from pg_proc where pronamespace='public'::regnamespace and proname='create_order';")"
assert_eq "[10d] la lecture publique APPELLE bien l'autorité de tarification" "1" \
  "$(sql_value "select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname='get_checkout_fulfillment_schedule' and pg_get_functiondef(p.oid) like '%public.resolve_delivery_fulfillment(%';")"
# Le tarif rendu par la lecture publique est CELUI de l'autorité, au
# centime : comparé directement à ce que l'autorité renvoie.
EXPECTED_FEE="$(sql_value "select delivery_fee from public.resolve_delivery_fulfillment('$RID_A','delivery','75011',1,20.00);")"
PUBLIC_FEE="$(sql_value "select delivery_fee from public.get_checkout_fulfillment_schedule('$RID_A','delivery','75011',1,20.00);")"
assert_eq "[10e] le tarif public est au centime celui de l'autorité" "$EXPECTED_FEE" "$PUBLIC_FEE"

# ============================================================
# [7] CSDJ-V1-SCHEDULE-ABSENT-01
# ============================================================
log "=== [7] Absence et désactivation : le parcours d'avant le lot ==="
assert_eq "[7a] aucune planification pour le retrait => 'absent'" "absent" \
  "$(sql_value "select schedule_status from public.get_checkout_fulfillment_schedule('$RID_A','pickup',null,1,null);")"
assert_eq "[7b] une absence ne révèle NI fuseau, NI politique, NI date" "||||" \
  "$(sql_value "select coalesce(schedule_timezone,'') || '|' || coalesce(date_selection_mode,'') || '|' || coalesce(slot_selection_mode,'') || '|' || coalesce(first_eligible_date::text,'') || '|' || coalesce(array_to_string(eligible_dates,','),'') from public.get_checkout_fulfillment_schedule('$RID_A','pickup',null,1,null);")"
psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<SQL || fatal "planification désactivée : $(tr '\n' ' ' < "$ERR")"
insert into public.restaurant_fulfillment_schedule
  (restaurant_id, mode_code, fulfillment_rule_id, timezone, enabled,
   date_selection_mode, slot_selection_mode, time_granularity_minutes)
values ('$RID_A','pickup',null,'Europe/Paris',false,'customer_selectable','time_within_window',15);
insert into public.restaurant_fulfillment_schedule_window
  (restaurant_id, mode_code, rule_key, weekday, starts_at, ends_at)
values ('$RID_A','pickup','$NIL_RULE',2,'11:00','14:00');
SQL
assert_eq "[7c] une planification COMPLÈTE mais désactivée => 'absent'" "absent" \
  "$(sql_value "select schedule_status from public.get_checkout_fulfillment_schedule('$RID_A','pickup',null,1,null);")"
assert_eq "[7d] désactivée, elle ne révèle rien de plus qu'une absence" "||||" \
  "$(sql_value "select coalesce(schedule_timezone,'') || '|' || coalesce(date_selection_mode,'') || '|' || coalesce(slot_selection_mode,'') || '|' || coalesce(first_eligible_date::text,'') || '|' || coalesce(array_to_string(eligible_dates,','),'') from public.get_checkout_fulfillment_schedule('$RID_A','pickup',null,1,null);")"
sql_value "delete from public.restaurant_fulfillment_schedule where restaurant_id='$RID_A';" >/dev/null

# ============================================================
# [6] FIXTURE PARTAGÉE — le cœur de la preuve croisée
# ============================================================
log "=== [6] Fixture partagée rejouée contre l'autorité SQL ==="
FIXTURE_SQL="$TMP_DIR/fixture.sql"
FIXTURE_EXPECTED="$TMP_DIR/fixture.expected"
python3 - "$FIXTURE_JSON" "$FIXTURE_SQL" "$FIXTURE_EXPECTED" "$RID_A" "$NIL_RULE" <<'PYGEN' || fatal "génération des assertions de fixture impossible"
import json, sys

fixture_path, sql_path, expected_path, rid, nil_rule = sys.argv[1:6]
data = json.load(open(fixture_path, encoding="utf-8"))

def q(v):
    return "null" if v is None else "'" + str(v).replace("'", "''") + "'"

sql_lines = ["\\pset tuples_only on", "\\pset format unaligned"]
expected_lines = []

refusal_lines = []

for c in data["cases"]:
    cid = c["id"]
    cfg = c["config"]
    if c.get("sqlConstraintRefusal"):
        # État que les CONTRAINTES DE TABLE rendent impossible : on
        # prouve le REFUS d'insertion, pas un résultat de calcul.
        refusal_lines.append("|".join([
            cid, cfg["dateSelectionMode"], cfg["slotSelectionMode"],
            "null" if cfg.get("timeGranularityMinutes") is None
            else str(cfg["timeGranularityMinutes"]),
        ]))
        continue
    sql_lines.append(f"-- {cid}")
    sql_lines.append(
        f"delete from public.restaurant_fulfillment_schedule where restaurant_id = '{rid}';")
    if cfg is not None:
        sql_lines.append(
            "insert into public.restaurant_fulfillment_schedule "
            "(restaurant_id, mode_code, fulfillment_rule_id, timezone, enabled, "
            "date_selection_mode, slot_selection_mode, time_granularity_minutes, "
            "lead_time_minutes, min_lead_days, cutoff_time, cutoff_offset_days, "
            "booking_horizon_days) values ("
            f"'{rid}', 'pickup', null, {q(cfg['timezone'])}, {str(cfg['enabled']).lower()}, "
            f"{q(cfg['dateSelectionMode'])}, {q(cfg['slotSelectionMode'])}, "
            f"{q(cfg['timeGranularityMinutes'])}, {cfg['leadTimeMinutes']}, "
            f"{cfg['minLeadDays']}, {q(cfg['cutoffTime'])}, {cfg['cutoffOffsetDays']}, "
            f"{cfg['bookingHorizonDays']});")
        for w in c["windows"]:
            sql_lines.append(
                "insert into public.restaurant_fulfillment_schedule_window "
                "(restaurant_id, mode_code, rule_key, weekday, starts_at, ends_at) values ("
                f"'{rid}', 'pickup', '{nil_rule}', {w['weekday']}, "
                f"{q(w['startsAt'])}, {q(w['endsAt'])});")
        for s in c["slots"]:
            sql_lines.append(
                "insert into public.restaurant_fulfillment_schedule_slot "
                "(restaurant_id, mode_code, rule_key, weekday, slot_key, starts_at, ends_at) values ("
                f"'{rid}', 'pickup', '{nil_rule}', {s['weekday']}, {q(s['slotKey'])}, "
                f"{q(s['startsAt'])}, {q(s['endsAt'])});")
        for cl in c["closures"]:
            sql_lines.append(
                "insert into public.restaurant_fulfillment_schedule_closure "
                "(restaurant_id, mode_code, rule_key, closed_on) values ("
                f"'{rid}', 'pickup', '{nil_rule}', {q(cl['closedOn'])});")
    # La sortie est canonicalisée pour être comparable au texte près :
    # statut | motif | première date | dates | offres.
    sql_lines.append(
        f"select '{cid}|' || coalesce(status,'-') || '|' || "
        "coalesce(unfulfillable_reason,'-') || '|' || "
        "coalesce(first_eligible_date::text,'-') || '|' || "
        "coalesce(array_to_string(eligible_dates, ','),'-') || '|' || "
        "coalesce((select string_agg(d || '=' || ("
        "  select string_agg(coalesce(o->>'slot_key','*') || '@' || (o->>'starts_at') "
        "    || '-' || (o->>'ends_at'), ';' order by (o->>'starts_at'), coalesce(o->>'slot_key','')) "
        "  from jsonb_array_elements(offers -> d) o), ' ' order by d) "
        " from jsonb_object_keys(coalesce(offers,'{}'::jsonb)) d), '-') "
        f"from public.resolve_fulfillment_schedule('{rid}', 'pickup', null, {q(c['nowIso'])}::timestamptz);")

    exp = c["expected"]
    dates = ",".join(d["date"] for d in exp["dates"]) or "-"
    offers = (
        " ".join(
            d["date"] + "=" + ";".join(
                (o["slotKey"] or "*") + "@" + o["startsAt"] + "-" + o["endsAt"]
                for o in sorted(d["offers"], key=lambda o: (o["startsAt"], o["slotKey"] or ""))
            )
            for d in exp["dates"]
        )
        or "-"
    )
    expected_lines.append(
        "|".join([
            cid,
            exp["status"],
            exp["reason"] or "-",
            exp["firstEligibleDate"] or "-",
            dates,
            offers,
        ])
    )

open(sql_path, "w", encoding="utf-8").write("\n".join(sql_lines) + "\n")
open(expected_path, "w", encoding="utf-8").write("\n".join(expected_lines) + "\n")
open(expected_path + ".refusals", "w", encoding="utf-8").write(
    ("\n".join(refusal_lines) + "\n") if refusal_lines else "")
print(f"{len(expected_lines)} cas rejoués + {len(refusal_lines)} cas refusés par contrainte")
PYGEN

FIXTURE_GOT="$TMP_DIR/fixture.got"
if psql -X -q -d "$DB" -v ON_ERROR_STOP=1 -f "$FIXTURE_SQL" > "$FIXTURE_GOT" 2>"$ERR"; then
  grep -v '^$' "$FIXTURE_GOT" > "$TMP_DIR/fixture.got.clean" || true
  FIXTURE_N="$(wc -l < "$FIXTURE_EXPECTED")"
  if diff -u "$FIXTURE_EXPECTED" "$TMP_DIR/fixture.got.clean" > "$TMP_DIR/fixture.diff" 2>&1; then
    pass "[6] les $FIXTURE_N cas de la fixture partagée donnent en SQL EXACTEMENT ce que la fixture attend"
  else
    fail "[6] divergence SQL / fixture partagée : $(head -20 "$TMP_DIR/fixture.diff" | tr '\n' ' ')"
  fi
  # Chaque cas est aussi compté individuellement : un diff global
  # masquerait combien de cas passent réellement.
  while IFS= read -r line; do
    cid="${line%%|*}"
    if grep -qxF "$line" "$TMP_DIR/fixture.got.clean"; then
      pass "[6] fixture « $cid »"
    else
      fail "[6] fixture « $cid » — attendu '$line', obtenu '$(grep "^$cid|" "$TMP_DIR/fixture.got.clean" || echo '<absent>')'"
    fi
  done < "$FIXTURE_EXPECTED"
else
  fail "[6] la fixture n'a pas pu être rejouée : $(head -5 "$ERR" | tr '\n' ' ')"
fi

# Les cas que les CONTRAINTES DE TABLE rendent impossibles : on prouve
# que l'INSERTION est refusée. C'est une preuve plus forte qu'un calcul
# qui refuse -- l'état n'est pas mal calculé, il est inatteignable.
if [ -s "$FIXTURE_EXPECTED.refusals" ]; then
  while IFS='|' read -r cid dmode smode gran; do
    [ -n "$cid" ] || continue
    sql_value "delete from public.restaurant_fulfillment_schedule where restaurant_id='$RID_A';" >/dev/null
    assert_eq "[6r] fixture « $cid » : la contrainte de table REFUSE cet état" "REFUSE" \
      "$(refused "$(outcome_as '' '' "insert into public.restaurant_fulfillment_schedule (restaurant_id, mode_code, fulfillment_rule_id, timezone, enabled, date_selection_mode, slot_selection_mode, time_granularity_minutes) values ('$RID_A','pickup',null,'Europe/Paris',true,'$dmode','$smode',$gran);")")"
  done < "$FIXTURE_EXPECTED.refusals"
fi
sql_value "delete from public.restaurant_fulfillment_schedule where restaurant_id='$RID_A';" >/dev/null

# ============================================================
# [8] CSDJ-V1-UNFULFILLABLE-EXPLICIT-01 vu de la LECTURE PUBLIQUE
# ============================================================
log "=== [8] Configuré mais infaisable : échec explicite ==="
psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<SQL || fatal "planification infaisable : $(tr '\n' ' ' < "$ERR")"
insert into public.restaurant_fulfillment_schedule
  (restaurant_id, mode_code, fulfillment_rule_id, timezone, enabled,
   date_selection_mode, slot_selection_mode)
values ('$RID_A','pickup',null,'Europe/Paris',true,'customer_selectable','none');
SQL
assert_eq "[8a] activée, aucune fenêtre => 'unfulfillable' avec motif" "unfulfillable|no_offer_configured" \
  "$(sql_value "select schedule_status || '|' || unfulfillable_reason from public.get_checkout_fulfillment_schedule('$RID_A','pickup',null,1,null);")"
assert_eq "[8b] et AUCUNE date n'est rendue -- jamais une date de repli" "|" \
  "$(sql_value "select coalesce(first_eligible_date::text,'') || '|' || coalesce(array_to_string(eligible_dates,','),'') from public.get_checkout_fulfillment_schedule('$RID_A','pickup',null,1,null);")"
assert_eq "[8c] un motif appartient TOUJOURS au catalogue fermé" "true" \
  "$(sql_value "select (unfulfillable_reason = any(public.checkout_unfulfillable_reasons()))::text from public.get_checkout_fulfillment_schedule('$RID_A','pickup',null,1,null);")"
sql_value "delete from public.restaurant_fulfillment_schedule where restaurant_id='$RID_A';" >/dev/null

# ============================================================
# [11] CSDJ-V1-SERVER-CLOCK-01
# ============================================================
log "=== [11] L'horloge est celle du serveur ==="
assert_eq "[11a] la lecture publique n'accepte AUCUN paramètre temporel" "0" \
  "$(sql_value "select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname='get_checkout_fulfillment_schedule' and (pg_get_function_arguments(p.oid) like '%timestamp%' or pg_get_function_arguments(p.oid) like '%date%');")"
assert_eq "[11b] l'autorité interne a bien un p_now, mais par défaut now()" "1" \
  "$(sql_value "select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname='resolve_fulfillment_schedule' and pg_get_function_arguments(p.oid) like '%p_now timestamp with time zone DEFAULT%' and pg_get_functiondef(p.oid) like '%now()%';")"

# ============================================================
# [4] ISOLATION MULTI-LOCATAIRES
# ============================================================
log "=== [4] Isolation multi-locataires ==="
psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<SQL || fatal "planifications des deux tenants : $(tr '\n' ' ' < "$ERR")"
insert into public.restaurant_fulfillment_schedule
  (restaurant_id, mode_code, fulfillment_rule_id, timezone, enabled,
   date_selection_mode, slot_selection_mode)
values ('$RID_A','delivery','$RULE_A','Europe/Paris',true,'customer_selectable','none'),
       ('$RID_B','delivery','$RULE_B','Europe/Lisbon',true,'customer_selectable','none');
insert into public.restaurant_fulfillment_schedule_window
  (restaurant_id, mode_code, rule_key, weekday, starts_at, ends_at)
select '$RID_A','delivery','$RULE_A', g, '09:00','18:00' from generate_series(0,6) g;
insert into public.restaurant_fulfillment_schedule_window
  (restaurant_id, mode_code, rule_key, weekday, starts_at, ends_at)
select '$RID_B','delivery','$RULE_B', g, '10:00','11:00' from generate_series(0,6) g;
SQL
assert_eq "[4a] l'owner de A lit la planification de A" "1" \
  "$(run_sql "$DB" authenticated "$OWNER_A" "select count(*) from public.restaurant_fulfillment_schedule;")"
assert_eq "[4b] l'owner de A ne lit JAMAIS celle de B" "0" \
  "$(run_sql "$DB" authenticated "$OWNER_A" "select count(*) from public.restaurant_fulfillment_schedule where restaurant_id = '$RID_B';")"
assert_eq "[4c] l'owner de B ne lit JAMAIS celle de A" "0" \
  "$(run_sql "$DB" authenticated "$OWNER_B" "select count(*) from public.restaurant_fulfillment_schedule where restaurant_id = '$RID_A';")"
assert_eq "[4d] un étranger ne lit AUCUNE planification" "0" \
  "$(run_sql "$DB" authenticated "$STRANGER" "select count(*) from public.restaurant_fulfillment_schedule;")"
assert_eq "[4e] les fenêtres suivent la même isolation" "7" \
  "$(run_sql "$DB" authenticated "$OWNER_A" "select count(*) from public.restaurant_fulfillment_schedule_window;")"
assert_eq "[4f] la lecture back-office de A ne renvoie que A" "1" \
  "$(run_sql "$DB" authenticated "$OWNER_A" "select count(*) from public.get_merchant_fulfillment_schedules('$RID_A');")"
assert_eq "[4g] l'owner de A ne peut PAS lire le back-office de B" "REFUSE" \
  "$(refused "$(outcome_as authenticated "$OWNER_A" "select count(*) from public.get_merchant_fulfillment_schedules('$RID_B');")")"
# Le fuseau de A ne doit jamais s'appliquer à B : deux portées, deux
# fuseaux, et c'est celui de la LIGNE qui décide.
assert_eq "[4h] chaque portée calcule dans SON fuseau" "Europe/Paris|Europe/Lisbon" \
  "$(sql_value "select (select schedule_timezone from public.get_checkout_fulfillment_schedule('$RID_A','delivery','75011',1,20.00)) || '|' || (select schedule_timezone from public.get_checkout_fulfillment_schedule('$RID_B','delivery','75011',1,20.00));")"

# ============================================================
# [5] ACL D'ÉCRITURE
# ============================================================
log "=== [5] ACL d'écriture : owner/manager seulement ==="
PAYLOAD_OK='{"modeCode":"pickup","timezone":"Europe/Paris","enabled":true,"dateSelectionMode":"customer_selectable","slotSelectionMode":"none","bookingHorizonDays":7}'
assert_eq "[5a] owner écrit" "OK" \
  "$(outcome_as authenticated "$OWNER_A" "select public.mutate_merchant_fulfillment_schedule('$RID_A','save_schedule','$PAYLOAD_OK'::jsonb);")"
assert_eq "[5b] manager écrit" "OK" \
  "$(outcome_as authenticated "$MANAGER_A" "select public.mutate_merchant_fulfillment_schedule('$RID_A','save_schedule','$PAYLOAD_OK'::jsonb);")"
assert_eq "[5c] staff est REFUSÉ" "REFUSE" \
  "$(refused "$(outcome_as authenticated "$STAFF_A" "select public.mutate_merchant_fulfillment_schedule('$RID_A','save_schedule','$PAYLOAD_OK'::jsonb);")")"
assert_eq "[5d] l'owner d'un AUTRE commerçant est REFUSÉ" "REFUSE" \
  "$(refused "$(outcome_as authenticated "$OWNER_B" "select public.mutate_merchant_fulfillment_schedule('$RID_A','save_schedule','$PAYLOAD_OK'::jsonb);")")"
assert_eq "[5e] anon ne peut même pas exécuter la RPC d'écriture" "REFUSE" \
  "$(refused "$(outcome_as anon "" "select public.mutate_merchant_fulfillment_schedule('$RID_A','save_schedule','$PAYLOAD_OK'::jsonb);")")"
assert_eq "[5f] une session authentifiée SANS identité est refusée (28000)" "REFUSE" \
  "$(refused "$(outcome_as authenticated "" "select public.mutate_merchant_fulfillment_schedule('$RID_A','save_schedule','$PAYLOAD_OK'::jsonb);")")"

# ============================================================
# [12] VALIDATION D'ÉCRITURE
# ============================================================
log "=== [12] Validation d'écriture : refuser plutôt que deviner ==="
assert_eq "[12a] fuseau inconnu du serveur => refusé" "REFUSE" \
  "$(refused "$(outcome_as authenticated "$OWNER_A" "select public.mutate_merchant_fulfillment_schedule('$RID_A','save_schedule','{\"modeCode\":\"pickup\",\"timezone\":\"Mars/Olympus\",\"enabled\":true}'::jsonb);")")"
assert_eq "[12b] politique hors catalogue => refusée" "REFUSE" \
  "$(refused "$(outcome_as authenticated "$OWNER_A" "select public.mutate_merchant_fulfillment_schedule('$RID_A','save_schedule','{\"modeCode\":\"pickup\",\"timezone\":\"Europe/Paris\",\"dateSelectionMode\":\"asap\"}'::jsonb);")")"
assert_eq "[12c] politique INCOHÉRENTE (heure sans date) => refusée" "REFUSE" \
  "$(refused "$(outcome_as authenticated "$OWNER_A" "select public.mutate_merchant_fulfillment_schedule('$RID_A','save_schedule','{\"modeCode\":\"pickup\",\"timezone\":\"Europe/Paris\",\"dateSelectionMode\":\"derived_earliest\",\"slotSelectionMode\":\"fixed_slots\"}'::jsonb);")")"
assert_eq "[12d] mode de vente hors catalogue => refusé" "REFUSE" \
  "$(refused "$(outcome_as authenticated "$OWNER_A" "select public.mutate_merchant_fulfillment_schedule('$RID_A','save_schedule','{\"modeCode\":\"teleportation\",\"timezone\":\"Europe/Paris\"}'::jsonb);")")"
assert_eq "[12e] action inconnue => refusée" "REFUSE" \
  "$(refused "$(outcome_as authenticated "$OWNER_A" "select public.mutate_merchant_fulfillment_schedule('$RID_A','truncate_everything','$PAYLOAD_OK'::jsonb);")")"
# Une règle de livraison d'un AUTRE commerçant ne peut pas être
# empruntée comme portée.
assert_eq "[12f] règle de livraison ÉTRANGÈRE => refusée nommément" "REFUSE" \
  "$(refused "$(outcome_as authenticated "$OWNER_A" "select public.mutate_merchant_fulfillment_schedule('$RID_A','save_schedule','{\"modeCode\":\"delivery\",\"timezone\":\"Europe/Paris\",\"fulfillmentRuleId\":\"$RULE_B\"}'::jsonb);")")"
# Fenêtres superposées : refus APRÈS insertion, donc dans la
# transaction -- rien ne subsiste.
assert_eq "[12g] fenêtres superposées du même jour => refusées" "REFUSE" \
  "$(refused "$(outcome_as authenticated "$OWNER_A" "select public.mutate_merchant_fulfillment_schedule('$RID_A','replace_windows','{\"modeCode\":\"pickup\",\"windows\":[{\"weekday\":2,\"startsAt\":\"11:00\",\"endsAt\":\"15:00\"},{\"weekday\":2,\"startsAt\":\"14:00\",\"endsAt\":\"20:00\"}]}'::jsonb);")")"
assert_eq "[12h] après ce refus, AUCUNE fenêtre de retrait ne subsiste" "0" \
  "$(sql_value "select count(*) from public.restaurant_fulfillment_schedule_window where restaurant_id='$RID_A' and mode_code='pickup';")"
assert_eq "[12i] fenêtres NON superposées => acceptées" "OK" \
  "$(outcome_as authenticated "$OWNER_A" "select public.mutate_merchant_fulfillment_schedule('$RID_A','replace_windows','{\"modeCode\":\"pickup\",\"windows\":[{\"weekday\":2,\"startsAt\":\"11:00\",\"endsAt\":\"14:00\"},{\"weekday\":2,\"startsAt\":\"16:00\",\"endsAt\":\"20:00\"}]}'::jsonb);")"
assert_eq "[12j] clé de créneau MALFORMÉE => refusée par la contrainte" "REFUSE" \
  "$(refused "$(outcome_as authenticated "$OWNER_A" "select public.mutate_merchant_fulfillment_schedule('$RID_A','save_schedule','{\"modeCode\":\"pickup\",\"timezone\":\"Europe/Paris\",\"dateSelectionMode\":\"customer_selectable\",\"slotSelectionMode\":\"fixed_slots\"}'::jsonb), public.mutate_merchant_fulfillment_schedule('$RID_A','replace_slots','{\"modeCode\":\"pickup\",\"slots\":[{\"weekday\":2,\"slotKey\":\"Matin 11h\",\"startsAt\":\"11:00\",\"endsAt\":\"14:00\"}]}'::jsonb);")")"
assert_eq "[12k] remplacer des fenêtres SANS planification => refusé" "REFUSE" \
  "$(refused "$(outcome_as authenticated "$OWNER_B" "select public.mutate_merchant_fulfillment_schedule('$RID_B','replace_windows','{\"modeCode\":\"pickup\",\"windows\":[]}'::jsonb);")")"

# ============================================================
# [13][14] ROLLBACK
# ============================================================
log "=== [13][14] Retour arrière ==="
clone_base "$DB_RB"
apply_path "$SUPABASE_DIR/$LOT_SQL" "$DB_RB" >/dev/null 2>&1 || fatal "aller sur la base de rollback"
RB_AFTER_FWD="$(schema_counts "$DB_RB")"
# [14] d'abord : avec une table d'instantané de CSDJ-3 présente, le
# retour doit REFUSER plutôt que casser un historique.
sql_on "$DB_RB" "create table public.order_fulfillment_schedule_snapshot (order_id uuid primary key);" >/dev/null
if apply_path "$SUPABASE_DIR/$LOT_ROLLBACK" "$DB_RB"; then
  fail "[14] le retour s'est appliqué malgré un instantané de CSDJ-3 présent"
else
  if grep -q 'SCANYM_ROLLBACK_REFUSED' "$OUT"; then
    pass "[14] le retour REFUSE de passer sous un instantané de CSDJ-3, en nommant la cause"
  else
    fail "[14] le retour a échoué, mais pas pour la bonne raison : $(tail -3 "$OUT" | tr '\n' ' ')"
  fi
fi
assert_eq "[14a] et les tables du lot sont TOUJOURS là après ce refus" "4" \
  "$(sql_on "$DB_RB" "select count(*) from pg_class where relnamespace='public'::regnamespace and relkind='r' and relname like 'restaurant_fulfillment_schedule%';")"
sql_on "$DB_RB" "drop table public.order_fulfillment_schedule_snapshot;" >/dev/null
# [13] ensuite : le retour nominal.
if apply_path "$SUPABASE_DIR/$LOT_ROLLBACK" "$DB_RB"; then
  pass "[13] le retour s'applique"
else
  fail "[13] le retour ÉCHOUE : $(tail -5 "$OUT" | tr '\n' ' ')"
fi
assert_eq "[13a] aucune table du lot ne subsiste" "0" \
  "$(sql_on "$DB_RB" "select count(*) from pg_class where relnamespace='public'::regnamespace and relname like 'restaurant_fulfillment_schedule%';")"
assert_eq "[13b] aucune fonction du lot ne subsiste" "0" \
  "$(sql_on "$DB_RB" "select count(*) from pg_proc where pronamespace='public'::regnamespace and (proname like 'checkout_date%' or proname like 'checkout_slot%' or proname like 'checkout_schedule%' or proname like 'checkout_unfulfillable%' or proname like '%fulfillment_schedule%');")"
assert_eq "[13c] l'état PRÉDÉCESSEUR est restauré à l'identique" "$BASE_COUNTS" \
  "$(schema_counts "$DB_RB")"
assert_eq "[13d] create_order est intacte après le retour" "$BASE_CO_FP" \
  "$(fn_code_fingerprint 'create_order' "$DB_RB")"
assert_eq "[13e] l'autorité de tarification est intacte après le retour" "$BASE_RESOLVER_FP" \
  "$(fn_code_fingerprint 'resolve_delivery_fulfillment' "$DB_RB")"
assert_eq "[13f] un second retour est REFUSÉ, il ne réussit pas en silence" "REFUSE" \
  "$(if apply_path "$SUPABASE_DIR/$LOT_ROLLBACK" "$DB_RB"; then echo AUTORISE; else grep -q 'SCANYM_ALREADY_REVERTED' "$OUT" && echo REFUSE || echo "ECHEC_AUTRE"; fi)"
# Une seconde application de l'ALLER est refusée elle aussi.
assert_eq "[13g] une seconde application de l'aller est REFUSÉE" "REFUSE" \
  "$(if apply_path "$SUPABASE_DIR/$LOT_SQL" "$DB_FWD"; then echo AUTORISE; else grep -q 'SCANYM_ALREADY_APPLIED' "$OUT" && echo REFUSE || echo "ECHEC_AUTRE"; fi)"

log "=== BILAN : $PASS_COUNT preuve(s) produite(s), $FAIL_COUNT échec(s) ==="
[ "$FAIL_COUNT" -eq 0 ] || exit 1
exit 0
