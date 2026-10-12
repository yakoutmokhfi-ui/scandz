#!/usr/bin/env bash
# ============================================================
# Scanym — CHECKOUT SCHEDULING FOUNDATION v1 (CSDJ-1)
# Harnais de SÛRETÉ dédié : RESTAURATION EXACTE DES ATTRIBUTS DE RÔLE,
# et ISOLATION D'ENVIRONNEMENT.
#
# Ferme CSDJ1-AUD-06 et CSDJ1-AUD-07.
#
# ------------------------------------------------------------------
# LES DEUX DÉFAUTS QUE CE FICHIER PROUVE FERMÉS
#
# CSDJ1-AUD-06 — `boolean::text` rend « true »/« false » ; « t »/« f »
# est la forme de l'affichage ALIGNÉ de psql, pas celle de la
# conversion. Le harnais principal capturait « true » et comparait à
# « t » : la comparaison échouait TOUJOURS, et la branche de repli
# restaurait NOLOGIN NOBYPASSRLS. Invisible sur un cluster jetable
# détruit juste après ; DURABLE sur un cluster désigné par l'opérateur.
#
# CSDJ1-AUD-07 — les appels psql de ce fichier héritaient de
# l'environnement. `PGHOSTADDR` l'emporte sur `host` dans libpq : avec
# `-h /une/socket/privee` ET `PGHOSTADDR=10.0.0.1`, libpq se connecte en
# TCP à 10.0.0.1. Les mutations de rôle pouvaient donc viser un AUTRE
# serveur que celui que le harnais croyait toucher.
#
# ------------------------------------------------------------------
# CE QUE CE HARNAIS PROUVE (exécuté, jamais inspecté)
#
# [A] Pour les QUATRE combinaisons initiales de LOGIN x BYPASSRLS, sur
#     les trois rôles applicatifs, dans un cluster DÉSIGNÉ : le harnais
#     principal s'exécute, et après son nettoyage chaque attribut de
#     chaque rôle est EXACTEMENT celui d'avant.
# [B] Forme de l'instantané : encodage 1/0, et non true/false ni t/f.
# [C] Un rôle ABSENT avant l'exécution est ABSENT après.
# [D] ENVIRONNEMENT HOSTILE : pour chacune des neuf variables de routage
#     libpq, ce harnais REFUSE de s'exécuter, nomme la variable, et un
#     cluster TÉMOIN qui écoute en TCP ne subit AUCUNE mutation.
# [E] PREUVE D'IDENTITÉ DE DESTINATION : la preuve échoue si l'on change
#     ce qu'elle vérifie, et elle précède toute mutation.
#
# ------------------------------------------------------------------
# ISOLATION — CSDJ-V1-HARNESS-CLEAN-ENV-01
#
# Aucun appel client PostgreSQL de ce fichier n'hérite de
# l'environnement : chacun passe par `env -i`, avec un PATH explicite,
# un HOME jetable, le binaire désigné par son chemin ABSOLU, et les
# quatre paramètres de connexion donnés en clair -- socket privée, port
# possédé, utilisateur possédé, base possédée. Aucun état de routage
# ambiant ne survit.
#
# ------------------------------------------------------------------
# CE QUE CE HARNAIS NE FAIT PAS : il ne touche aucun cluster qu'il n'a
# pas créé lui-même, n'accepte aucune variable de connexion héritée, et
# ne journalise aucune VALEUR de variable -- seulement son NOM.
#
# Usage :  SCANYM_DISPOSABLE_CLUSTER=1 \
#            bash supabase/tests/checkout-scheduling-foundation-v1-role-restoration-check.sh
# Sortie :  0 = toutes les preuves produites ; 1 = au moins un échec ;
#           2 = REFUS de sûreté.
# ============================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="$SCRIPT_DIR/checkout-scheduling-foundation-v1-check.sh"

PASS=0
FAIL=0
log()  { printf '[%s] %s\n' "$(date -u '+%H:%M:%S')" "$*"; }
pass() { PASS=$((PASS + 1)); log "PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); log "FAIL: $*"; }
fatal() { log "FATAL: $*"; exit 1; }
refuse() { log "REFUS DE SÛRETÉ : $*"; log "Aucune mutation n'a été tentée."; exit 2; }

# ============================================================
# §1  CONSENTEMENT EXPLICITE
# ============================================================
if [ "${SCANYM_DISPOSABLE_CLUSTER:-}" != "1" ]; then
  refuse "SCANYM_DISPOSABLE_CLUSTER=1 est requis. Ce fichier crée des clusters et mute des rôles : il exige une déclaration EXPLICITE que la cible est jetable."
fi

# ============================================================
# §2  VARIABLES DE ROUTAGE HÉRITÉES — REFUS PAR LEUR NOM
#
# CSDJ1-AUD-07. `PGHOSTADDR` l'emporte sur `host` dans libpq : un `-h`
# pointant vers une socket privée ne protège de rien. Toutes ces
# variables sont donc refusées PAR LEUR NOM, et jamais par leur valeur
# -- une valeur peut être un mot de passe, une URL porteuse
# d'identifiants ou un chemin de fichier de secrets, et ne doit atteindre
# aucune sortie, même partiellement rédigée.
# ============================================================
ROUTING_VARS="PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE PGSYSCONFDIR PGCLUSTER PGREQUIRESSL PGSSLMODE PGSSLROOTCERT PGSSLCERT PGSSLKEY PGOPTIONS PGCONNECT_TIMEOUT PGTARGETSESSIONATTRS PGDATA DATABASE_URL POSTGRES_URL POSTGRESQL_URL PG_URL SUPABASE_DB_URL SCANYM_DB_URL SCANYM_DATABASE_URL"
for v in $ROUTING_VARS; do
  if [ -n "${!v:-}" ]; then
    refuse "$v est définie. Cette variable peut faire pointer un client PostgreSQL vers un autre serveur -- PGHOSTADDR l'emporte même sur un -h explicite. Relancez ce harnais dans un environnement sans configuration de connexion héritée. (La valeur n'est pas journalisée : elle peut être un secret.)"
  fi
done
# Neutralisation défensive : toute autre PG* héritée est retirée, pour
# qu'aucune variable que la liste ci-dessus aurait oubliée ne subsiste.
while IFS='=' read -r name _; do
  case "$name" in
    PG*) unset "$name" 2>/dev/null || true ;;
  esac
done < <(env)

[ "$(id -u)" != "0" ] || refuse "initdb refuse de s'exécuter en root. Relancez sous un utilisateur non privilégié."
[ -f "$HARNESS" ] || fatal "harnais principal introuvable : $HARNESS"

# ============================================================
# §3  BINAIRES PAR CHEMIN ABSOLU
#
# Un binaire résolu par le PATH est un binaire que le PATH peut
# remplacer. On les fixe une fois, et on ne s'en sert que par ce chemin.
# ============================================================
resolve_bin() {
  local name="$1" cand
  for cand in "/usr/lib/postgresql"/*/bin/"$name" "/usr/bin/$name" "/usr/local/bin/$name"; do
    [ -x "$cand" ] && { printf '%s\n' "$cand"; return 0; }
  done
  command -v "$name" >/dev/null 2>&1 && { command -v "$name"; return 0; }
  return 1
}
INITDB="$(resolve_bin initdb)" || fatal "initdb introuvable."
PG_CTL="$(resolve_bin pg_ctl)" || fatal "pg_ctl introuvable."
PSQL="$(resolve_bin psql)"     || fatal "psql introuvable."
SAFE_PATH="$(dirname "$INITDB"):/usr/bin:/bin"

TMP_DIR="$(mktemp -d)"
SAFE_HOME="$TMP_DIR/home"
mkdir -p "$SAFE_HOME"
OWNER="$(id -un)"

# Cluster SOUS TEST (socket privée, aucun TCP) et cluster TÉMOIN (TCP,
# pour que la redirection soit réellement possible et son absence
# réellement prouvable).
PGDATA_DIR="$TMP_DIR/cluster"
SOCKET_DIR="$TMP_DIR/sock"
PORT=$(( 49152 + ($$ % 7000) ))
WIT_DATA="$TMP_DIR/witness"
WIT_SOCK="$TMP_DIR/witness-sock"
# Le TÉMOIN écoute en TCP sur 127.0.0.1 au MÊME NUMÉRO DE PORT que le
# cluster sous test. Ce n'est pas un conflit : le cluster sous test
# n'écoute AUCUN TCP (listen_addresses=''), il n'occupe que sa socket
# privée. C'est précisément la configuration qui rend la menace de
# l'audit reproductible : avec « -h <socket privée> -p <port> » explicite
# et PGHOSTADDR=127.0.0.1, libpq ignore l'hôte et aboutit au TÉMOIN.
WIT_PORT="$PORT"
# Port LEURRE : aucun serveur ne l'écoute. Il sert de valeur aux vecteurs
# hostiles dont l'enjeu est le REFUS PAR NOM (PGPORT, DATABASE_URL), et
# non la destination effective.
DECOY_PORT=$(( PORT + 7001 ))
NONCE="csdj1-$$-$(date -u '+%Y%m%d%H%M%S')"
CLUSTER_UP=0
WITNESS_UP=0

cleanup() {
  local rc=$?
  [ "$CLUSTER_UP" = "1" ] && env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    "$PG_CTL" -D "$PGDATA_DIR" stop -m immediate >/dev/null 2>&1
  [ "$WITNESS_UP" = "1" ] && env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    "$PG_CTL" -D "$WIT_DATA" stop -m immediate >/dev/null 2>&1
  [ "${LAB_UP:-0}" = "1" ] && env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    "$PG_CTL" -D "$LAB_DATA" stop -m immediate >/dev/null 2>&1
  [ "${SENT_UP:-0}" = "1" ] && env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    "$PG_CTL" -D "$SENT_DATA" stop -m immediate >/dev/null 2>&1
  rm -rf "$TMP_DIR"
  exit "$rc"
}
trap cleanup EXIT

# ────────────────────────────────────────────────────────────
# CSDJ-V1-HARNESS-CLEAN-ENV-01 — UN SEUL chemin d'accès au SQL.
#
# `env -i` : environnement VIDE, puis PATH et HOME explicites. Binaire
# ABSOLU. Les quatre paramètres de connexion en clair. Aucun état de
# routage ambiant ne peut survivre à cela.
# ────────────────────────────────────────────────────────────
# ────────────────────────────────────────────────────────────
# LE CHEMIN BRUT — UNE SEULE ENVELOPPE, ET UNE FRONTIÈRE IMPOSÉE PAR
# POSTGRESQL
# CSDJ1-AUD-07-RUNTIME-ROLE-BOUNDARY-01
#
# Huit tours de suite, la preuve que « rien ne mute hors garde »
# reposait sur la lecture du TEXTE SOURCE de ce fichier, et huit fois un
# audit a trouvé une orthographe que le lecteur ne voyait pas. On
# arrête. La preuve porte maintenant sur le CHEMIN D'EXÉCUTION.
#
# `q` et `qw` ne sont plus deux commandes : ce sont deux vues d'UNE
# enveloppe, `csdj1_raw_exec`, et cette enveloppe
#
#   - se connecte avec $RAW_ROLE, qui est NOSUPERUSER NOCREATEROLE :
#     PostgreSQL REFUSE toute mutation d'attribut de rôle, quelle qu'en
#     soit l'orthographe. Aucun analyseur n'intervient ;
#   - demande au serveur, APRÈS chaque exécution, si l'empreinte du
#     catalogue de rôles correspond encore à celle que SEUL le chemin
#     gardé rafraîchit. La vérification voyage dans la MÊME invocation
#     de psql, en seconde instruction : elle ne coûte pas un appel de
#     plus, et elle ne peut pas être oubliée ;
#   - NOMME ce qu'elle observe, dans des fichiers que les sections
#     suivantes relisent : tentative, refus de privilège, brèche.
#
# `$RAW_ROLE` n'est PAS le propriétaire du cluster. Le chemin gardé,
# lui, exige « is_superuser » dans son prédicat. Les deux chemins sont
# donc disjoints par construction, et c'est le SERVEUR qui l'impose.
# ────────────────────────────────────────────────────────────
RAW_ROLE="scanym_csdj1_raw"
RAW_ARMED=0
# ────────────────────────────────────────────────────────────
# LE CONTRAT D'INVOCATION — CSDJ1-AUD-07-RUNTIME-ROLE-BOUNDARY-02,
# défaut F2 : l'ÉCHAPPEMENT PAR MÉTA-COMMANDE psql.
#
# `psql -c` n'est pas un canal SQL : c'est un canal CLIENT. Vérifié
# empiriquement sur PostgreSQL 16.15 (voir runtime-role-boundary.txt) :
#
#   psql -c '\! touch /tmp/x'              => LE SHELL S'EXÉCUTE
#   psql -c '\! touch /tmp/x <LF> select 1' => LE SHELL S'EXÉCUTE
#   psql -c 'select 1; \! touch /tmp/x'    => ERROR: syntax error at «\»
#   psql -c 'select 1 where false; \! …'   => ERROR: syntax error at «\»
#
# La règle de psql est exactement celle-ci : si la chaîne COMMENCE par
# une commande à barre oblique inverse, elle est interprétée par le
# CLIENT ; sinon la chaîne ENTIÈRE part au serveur, et toute barre
# oblique inverse qui s'y trouve n'est plus qu'une erreur de syntaxe
# SQL -- côté SERVEUR.
#
# On ne lit donc PAS l'entrée, on ne cherche PAS « \! », on n'énumère
# AUCUNE commande : on garantit que la chaîne ne commence JAMAIS par une
# barre oblique inverse, en la faisant commencer par une instruction SQL
# fixe. Le contrat vaut pour toute commande psql, connue ou non, par
# CONSTRUCTION.
#
# L'instruction choisie est sans sortie et sans effet -- « select 1 where
# false; » -- de sorte que ni la valeur rendue par `q` ni l'état du
# serveur n'en dépendent.
#
# Conséquence assumée : la chaîne devient multi-instructions, donc une
# transaction implicite. Les instructions qui refusent un bloc
# transactionnel (CREATE DATABASE, VACUUM, ALTER SYSTEM) ne passent plus
# par le chemin brut -- il ne leur a jamais servi, et aucune d'elles
# n'est une mutation de rôle.
# ────────────────────────────────────────────────────────────
RAW_SQL_PREFIX='select 1 where false; '
BND_CHECK_TEST=""
BND_CHECK_WIT=""
RAW_ERR="$TMP_DIR/raw-stderr.txt"
RAW_ATTEMPTS="$TMP_DIR/raw-attempts.txt"
RAW_BREACHES="$TMP_DIR/raw-breaches.txt"
RAW_REFUSALS="$TMP_DIR/raw-refusals.txt"
: > "$RAW_ATTEMPTS"; : > "$RAW_BREACHES"; : > "$RAW_REFUSALS"; : > "$RAW_ERR"

csdj1_raw_exec() {
  local target="$1" sql="$2" host port chk out rc verdict
  case "$target" in
    test)   host="$SOCKET_DIR"; port="$PORT";     chk="$BND_CHECK_TEST" ;;
    temoin) host="$WIT_SOCK";   port="$WIT_PORT"; chk="$BND_CHECK_WIT" ;;
    *) printf 'csdj1_raw_exec: cible inconnue\n' >&2; return 9 ;;
  esac
  if [ "$RAW_ARMED" = "1" ] && [ -n "$chk" ]; then
    # DEUX instructions, UNE connexion : le SQL demandé, puis le verdict
    # de la frontière. Sans « ON_ERROR_STOP », le verdict est rendu même
    # quand le SQL demandé a été REFUSÉ -- c'est précisément le cas qui
    # nous intéresse.
    out="$(env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
      "$PSQL" -X -A -q -t \
        -h "$host" -p "$port" -U "$RAW_ROLE" -d postgres \
        -c "$RAW_SQL_PREFIX$sql" -c "select public.$chk();" </dev/null 2>"$RAW_ERR")"
    rc=$?
    verdict="$(printf '%s\n' "$out" | tail -1 | tr -d ' ')"
    # Le verdict appartient à un ENSEMBLE FERMÉ. S'il n'en fait pas
    # partie, la vérification n'a pas eu lieu -- fonction absente,
    # connexion refusée, sortie inattendue -- et c'est une anomalie, non
    # un silence : on la nomme, on la compte comme une brèche, et on ne
    # retire AUCUNE ligne de la sortie rendue à l'appelant.
    case "$verdict" in
      OK|MUTATION-BRUTE|FRONTIERE-NON-ARMEE)
        out="$(printf '%s\n' "$out" | head -n -1)" ;;
      *) verdict="FRONTIERE-INDISPONIBLE" ;;
    esac
    printf '%s\t%s\t%s\n' "$target" "$verdict" "$rc" >> "$RAW_ATTEMPTS"
    case "$verdict" in
      OK) : ;;
      *) printf '%s\t%s\t%s\n' "$target" "$verdict" \
           "$(printf '%s' "$sql" | tr '\n\t' '  ' | cut -c1-120)" >> "$RAW_BREACHES" ;;
    esac
    if grep -qiE 'permission denied|must be superuser|must have (createrole|superuser)|droit' "$RAW_ERR" 2>/dev/null; then
      printf '%s\t%s\n' "$target" \
        "$(tr '\n' ' ' < "$RAW_ERR" | cut -c1-160)" >> "$RAW_REFUSALS"
    fi
  else
    out="$(env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
      "$PSQL" -X -A -q -t \
        -h "$host" -p "$port" -U "$RAW_ROLE" -d postgres \
        -c "$RAW_SQL_PREFIX$sql" </dev/null 2>"$RAW_ERR")"
    rc=$?
  fi
  printf '%s\n' "$out"
  return "$rc"
}
q()  { csdj1_raw_exec test   "$1" | tail -1 | tr -d ' '; }
qw() { csdj1_raw_exec temoin "$1" | tail -1 | tr -d ' '; }

# LECTURE D'AMORÇAGE — privilégiée, et qui n'est PAS un chemin brut.
#
# Le contrat d'identité se construit avec le data_directory et le
# config_file du serveur : il faut donc les LIRE avant que la frontière
# puisse exister. Cette enveloppe ne prend pas du SQL : elle prend un
# NOM DE RÉGLAGE, et fabrique elle-même la requête. Aucune mutation de
# rôle ne s'exprime comme un nom de réglage -- ce n'est donc pas un
# chemin de mutation, et [K] vérifie qu'elle n'est employée que pour
# cela.
csdj1_bootstrap_setting() {
  local target="$1" setting="$2" host port
  case "$setting" in
    data_directory|config_file) : ;;
    *) printf 'csdj1_bootstrap_setting: réglage non autorisé\n' >&2; return 9 ;;
  esac
  case "$target" in
    test)   host="$SOCKET_DIR"; port="$PORT" ;;
    temoin) host="$WIT_SOCK";   port="$WIT_PORT" ;;
    *) printf 'csdj1_bootstrap_setting: cible inconnue\n' >&2; return 9 ;;
  esac
  env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    "$PSQL" -X -A -q -t \
      -h "$host" -p "$port" -U "$OWNER" -d postgres \
      -c "select pg_catalog.current_setting('$setting');" </dev/null 2>/dev/null \
    | tail -1 | tr -d ' '
}

start_cluster() {
  local data="$1" sock="$2" port="$3" listen="$4"
  mkdir -p "$sock"
  env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    "$INITDB" -D "$data" -A trust -E UTF8 --locale=C >"$TMP_DIR/initdb.log" 2>&1 \
    || fatal "initdb a échoué : $(tail -3 "$TMP_DIR/initdb.log" | tr '\n' ' ')"
  env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    "$PG_CTL" -D "$data" -l "$data.log" \
      -o "-p $port -k $sock -c listen_addresses='$listen'" start >/dev/null 2>&1 \
    || fatal "démarrage impossible : $(tail -3 "$data.log" 2>/dev/null | tr '\n' ' ')"
}

start_cluster "$PGDATA_DIR" "$SOCKET_DIR" "$PORT" ""
CLUSTER_UP=1
log "cluster SOUS TEST créé par CE fichier (socket $SOCKET_DIR, port $PORT, aucun TCP)."

start_cluster "$WIT_DATA" "$WIT_SOCK" "$WIT_PORT" "127.0.0.1"
WITNESS_UP=1
log "cluster TÉMOIN créé par CE fichier (TCP 127.0.0.1:$WIT_PORT -- MÊME port que le cluster sous test, qui n'écoute aucun TCP) : cible réelle d'une redirection."

# ────────────────────────────────────────────────────────────
# BANC D'ESSAI DE SOCKETS — un cluster à DEUX répertoires
#
# `unix_socket_directories` est une LISTE. Un prédicat qui compare la
# liste entière par sous-chaîne accepte n'importe quel fragment ; un
# prédicat correct exige l'égalité avec UNE ENTRÉE COMPLÈTE. On ne peut
# le prouver qu'avec un serveur qui en a réellement plusieurs.
# ────────────────────────────────────────────────────────────
LAB_DATA="$TMP_DIR/sockets"
# Quatre répertoires, dont trois EXIGENT des guillemets dans la
# configuration : un nom contenant une VIRGULE, un nom contenant un
# ESPACE, un nom contenant un GUILLEMET (doublé dans la configuration).
# C'est la seule façon d'éprouver un parseur sensible aux guillemets :
# sur une liste sans guillemets, un découpage brut et un parseur correct
# sont indiscernables.
LAB_SOCK_A="$TMP_DIR/lab-a"
LAB_SOCK_B="$TMP_DIR/lab-b"
LAB_SOCK_C="$TMP_DIR/foo,bar"
LAB_SOCK_D="$TMP_DIR/lab d"
LAB_SOCK_E="$TMP_DIR/tr,ail"
LAB_PORT=$(( PORT + 1 ))
LAB_UP=0
mkdir -p "$LAB_SOCK_A" "$LAB_SOCK_B" "$LAB_SOCK_C" "$LAB_SOCK_D" "$LAB_SOCK_E"
env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
  "$INITDB" -D "$LAB_DATA" -A trust -E UTF8 --locale=C >"$TMP_DIR/initdb-lab.log" 2>&1 \
  || fatal "initdb du banc de sockets a échoué : $(tail -3 "$TMP_DIR/initdb-lab.log" | tr '\n' ' ')"
env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
  "$PG_CTL" -D "$LAB_DATA" -l "$LAB_DATA.log" \
    -o "-p $LAB_PORT -c unix_socket_directories='\"$LAB_SOCK_C\",$LAB_SOCK_A , $LAB_SOCK_B,\"$LAB_SOCK_D\",\"$LAB_SOCK_E/\"' -c listen_addresses=''" start \
    >/dev/null 2>&1 \
  || fatal "démarrage du banc de sockets impossible : $(tail -3 "$LAB_DATA.log" 2>/dev/null | tr '\n' ' ')"
LAB_UP=1
log "cluster BANC DE SOCKETS créé par CE fichier (cinq répertoires, dont un à VIRGULE, un à ESPACE et un à barre oblique finale, tous trois CITÉS dans la configuration ; aucun TCP)."

csdj1_runner_lab() {
  env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    "$PSQL" -X -A -q -t -v ON_ERROR_STOP=1 \
      -h "$LAB_SOCK_A" -p "$LAB_PORT" -U "$OWNER" -d postgres \
      -c "$1" </dev/null 2>&1
}
log "   liste telle que le serveur la rend : $(csdj1_runner_lab "show unix_socket_directories;" | tail -1)"

# ============================================================
# §4  CONTRAT D'IDENTITÉ COMPLÈTE — CSDJ-V1-DESTINATION-PROOF-02
#
# Le second re-audit delta a précisé le reproche : la preuve d'identité
# du NETTOYAGE ne portait que sur quatre faits -- socket, port,
# utilisateur, superutilisateur. Deux clusters différents peuvent les
# présenter. La preuve ne liait donc pas le serveur à CETTE exécution.
#
# Le prédicat est désormais UNIQUE, défini dans une bibliothèque
# sourcée, et porte sur HUIT faits dont le data_directory, le
# config_file et un marqueur en base. Les deux harnais l'emploient :
# il n'existe pas deux versions de lui.
#
# Preuve et mutation tiennent dans UNE session et UNE transaction. Un
# marqueur de fichier prouverait que le système de fichiers est le bon ;
# un marqueur en base prouve que le SERVEUR joint est le bon.
# ============================================================
IDENTITY_LIB="$SCRIPT_DIR/csdj1-cluster-identity.sh"
[ -f "$IDENTITY_LIB" ] \
  || fatal "bibliothèque d'identité absente : $IDENTITY_LIB -- aucune mutation ne peut être gardée."
# shellcheck source=/dev/null
. "$IDENTITY_LIB"

# Runner du cluster SOUS TEST : environnement vidé, binaire absolu,
# destination entièrement explicite. C'est le seul chemin d'accès.
csdj1_runner_test() {
  env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    "$PSQL" -X -A -q -t -v ON_ERROR_STOP=1 \
      -h "$SOCKET_DIR" -p "$PORT" -U "$OWNER" -d postgres \
      -c "$1" </dev/null 2>&1
}
# Runner du TÉMOIN par sa SOCKET : c'est par là que ses rôles sont
# initialisés, sous garde, comme ceux de tout cluster que ce fichier
# possède.
csdj1_runner_witness() {
  env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    "$PSQL" -X -A -q -t -v ON_ERROR_STOP=1 \
      -h "$WIT_SOCK" -p "$WIT_PORT" -U "$OWNER" -d postgres \
      -c "$1" </dev/null 2>&1
}
# Runner du témoin par TCP : il n'existe que pour le CONTRÔLE NÉGATIF de
# destination réseau, qui doit être refusé avant toute mutation.
csdj1_runner_witness_tcp() {
  env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    "$PSQL" -X -A -q -t -v ON_ERROR_STOP=1 \
      -h 127.0.0.1 -p "$WIT_PORT" -U "$OWNER" -d postgres \
      -c "$1" </dev/null 2>&1
}

DATA_DIR_PROVEN="$(csdj1_bootstrap_setting test data_directory)"
CONFIG_FILE_PROVEN="$(csdj1_bootstrap_setting test config_file)"
IDENTITY_MARKER="scanym_csdj1_identity_$$"

# ────────────────────────────────────────────────────────────
# TROIS clusters, TROIS contrats COMPLETS.
#
# Le re-audit précédent avait raison sur un point qu'on peut résumer
# ainsi : un cluster que ce fichier possède et dont il mute les rôles
# est un cluster qu'il doit IDENTIFIER, témoin compris. Le témoin
# recevait ses attributs par un appel brut, hors garde. Il a donc
# maintenant son contrat : sa socket, son port, son utilisateur, son
# data_directory, son config_file, son nonce et son marqueur.
#
# Les contrats sont NOMMÉS plutôt que sauvegardés et restaurés autour de
# chaque usage : inventer un second chemin de mutation est précisément
# ce qui a produit le défaut d'origine.
# ────────────────────────────────────────────────────────────
WIT_DATA_DIR_PROVEN="$(csdj1_bootstrap_setting temoin data_directory)"
WIT_CONFIG_FILE_PROVEN="$(csdj1_bootstrap_setting temoin config_file)"
WIT_NONCE="csdj1-temoin-$$-$(date -u '+%Y%m%d%H%M%S')"
WIT_MARKER="scanym_csdj1_identity_temoin_$$"

csdj1_identity_declare temoin csdj1_runner_witness \
  "$WIT_SOCK" "$WIT_PORT" "$OWNER" "$WIT_DATA_DIR_PROVEN" "$WIT_CONFIG_FILE_PROVEN" \
  "$WIT_MARKER" "$WIT_NONCE" \
  || fatal "contrat d'identité du TÉMOIN invalide -- aucune mutation tentée."
csdj1_identity_install \
  || fatal "[E] pose du marqueur d'identité du TÉMOIN REFUSÉE ($CSDJ1_ID_LAST)."

csdj1_identity_declare test csdj1_runner_test \
  "$SOCKET_DIR" "$PORT" "$OWNER" "$DATA_DIR_PROVEN" "$CONFIG_FILE_PROVEN" \
  "$IDENTITY_MARKER" "$NONCE" \
  || fatal "contrat d'identité du cluster sous test invalide -- aucune mutation tentée."
csdj1_identity_install \
  || fatal "[E] pose du marqueur d'identité REFUSÉE ($CSDJ1_ID_LAST) -- aucune mutation tentée."

# ────────────────────────────────────────────────────────────
# ARMEMENT DE LA FRONTIÈRE D'EXÉCUTION.
#
# Elle est posée PAR LE CHEMIN GARDÉ, sur les DEUX clusters que `q` et
# `qw` atteignent. À partir de la ligne « RAW_ARMED=1 », aucune
# exécution brute de ce fichier n'est privilégiée, et chacune rend un
# verdict de frontière.
# ────────────────────────────────────────────────────────────
csdj1_identity_use temoin || fatal "contrat du témoin indisponible."
csdj1_identity_boundary_install "$RAW_ROLE" \
  || fatal "[K] pose de la frontière d'exécution sur le TÉMOIN refusée ($CSDJ1_ID_LAST)."
BND_CHECK_WIT="$(csdj1_identity_boundary_check)"
csdj1_identity_use test || fatal "contrat du cluster sous test indisponible."
csdj1_identity_boundary_install "$RAW_ROLE" \
  || fatal "[K] pose de la frontière d'exécution refusée ($CSDJ1_ID_LAST)."
BND_CHECK_TEST="$(csdj1_identity_boundary_check)"
BND_TABLE_TEST="$(csdj1_identity_boundary_table)"
BND_DIGEST_TEST="$(csdj1_identity_boundary_digest)"
RAW_ARMED=1
log "frontière d'exécution ARMÉE : le chemin brut se connecte avec « $RAW_ROLE » (NOSUPERUSER NOCREATEROLE), et chaque exécution brute rend un verdict de frontière."

if csdj1_identity_prove; then
  pass "[E] l'identité COMPLÈTE (8 faits) passe sur le cluster créé ici"
else
  fatal "[E] la preuve d'identité complète ÉCHOUE avant toute mutation ($CSDJ1_ID_LAST) -- aucune mutation tentée."
fi

# La preuve doit DISCRIMINER : adressée au témoin, elle doit échouer --
# et échouer sur le PREMIER fait, la destination réseau.
CSDJ1_ID_RUNNER=csdj1_runner_witness_tcp
if csdj1_identity_prove; then
  fail "[E] la preuve d'identité ne distingue pas deux clusters"
else
  pass "[E] la preuve DISCRIMINE : adressée au témoin elle refuse ($CSDJ1_ID_LAST)"
fi
csdj1_identity_use test || fatal "contrat du cluster sous test indisponible."

# Et le marqueur n'existe que dans le cluster sous test.
if [ "$(qw "select count(*) from pg_tables where tablename = '$IDENTITY_MARKER';")" = "0" ]; then
  pass "[E] le marqueur d'identité n'existe QUE dans le cluster sous test"
else
  fail "[E] le témoin porte le marqueur -- il ne prouve rien"
fi

# ============================================================
# §5  OUTILLAGE DE RÔLES
# ============================================================
APP_ROLES="anon authenticated service_role"

role_attrs() {
  local target="$1" name="$2"
  if [ "$target" = "witness" ]; then
    qw "select coalesce((select (case when rolcanlogin then 'LOGIN' else 'NOLOGIN' end)
                             || '+' ||
                               (case when rolbypassrls then 'BYPASSRLS' else 'NOBYPASSRLS' end)
                        from pg_roles where rolname = '$name'), 'ABSENT');"
  else
    q "select coalesce((select (case when rolcanlogin then 'LOGIN' else 'NOLOGIN' end)
                            || '+' ||
                              (case when rolbypassrls then 'BYPASSRLS' else 'NOBYPASSRLS' end)
                       from pg_roles where rolname = '$name'), 'ABSENT');"
  fi
}

# TOUTE mutation de rôle passe par le prédicat COMMUN : preuve des huit
# faits et mutation dans la MÊME session, la MÊME transaction. En cas de
# refus, `fatal` -- on n'essaie pas « autrement », il n'y a pas de
# chemin de repli plus faible.
set_role_attrs() {
  csdj1_identity_mutate "
  if not exists (select 1 from pg_catalog.pg_roles where rolname='$1') then
    execute 'create role $1 $2 $3';
  else
    execute 'alter role $1 $2 $3';
  end if;
" || fatal "mutation ABANDONNÉE : l'identité complète du serveur n'est plus prouvable ($CSDJ1_ID_LAST)."
}

# Le TÉMOIN reçoit des attributs distinctifs : si une redirection
# aboutissait, le harnais principal les écraserait en NOLOGIN
# NOBYPASSRLS -- et c'est précisément cela que [D] surveille.
#
# Cette initialisation passe par la MÊME garde que toutes les autres
# mutations de rôle. Elle employait auparavant un appel brut : un
# cluster dont on mute les rôles est un cluster qu'il faut identifier,
# même quand il ne sert que de témoin. Un appel brut qui « ne compte
# pas » est un appel brut qui compte le jour où la destination n'est
# plus celle qu'on croit.
csdj1_identity_use temoin || fatal "contrat du témoin indisponible."
for r in $APP_ROLES; do
  csdj1_identity_mutate "
  if not exists (select 1 from pg_catalog.pg_roles where rolname='$r') then
    execute 'create role $r LOGIN BYPASSRLS';
  else
    execute 'alter role $r LOGIN BYPASSRLS';
  end if;
" || fatal "initialisation du rôle « $r » du TÉMOIN ABANDONNÉE ($CSDJ1_ID_LAST)."
done
csdj1_identity_use test || fatal "contrat du cluster sous test indisponible."
declare -A WITNESS_BEFORE=()
for r in $APP_ROLES; do WITNESS_BEFORE[$r]="$(role_attrs witness "$r")"; done
log "témoin préparé : $(for r in $APP_ROLES; do printf '%s=%s ' "$r" "${WITNESS_BEFORE[$r]}"; done)"

witness_untouched() {
  local r after bad=0
  for r in $APP_ROLES; do
    after="$(role_attrs witness "$r")"
    [ "$after" = "${WITNESS_BEFORE[$r]}" ] || bad=$((bad + 1))
  done
  printf '%s\n' "$bad"
}

run_main_harness() {
  # Le harnais principal est lancé lui aussi dans un environnement VIDE,
  # avec pour seules variables le consentement et la DÉSIGNATION du
  # cluster sous test.
  env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    SCANYM_DISPOSABLE_CLUSTER=1 \
    SCANYM_HARNESS_PGHOST="$SOCKET_DIR" \
    SCANYM_HARNESS_PGPORT="$PORT" \
    bash "$HARNESS" >"$TMP_DIR/main.log" 2>&1
  return $?
}

# ============================================================
# [A] Les QUATRE combinaisons initiales — CSDJ1-AUD-06
# ============================================================
for combo in "NOLOGIN NOBYPASSRLS" "LOGIN NOBYPASSRLS" "NOLOGIN BYPASSRLS" "LOGIN BYPASSRLS"; do
  set -- $combo
  LK="$1"; BK="$2"
  log "=== [A] état initial des rôles : $LK + $BK ==="

  for r in $APP_ROLES; do set_role_attrs "$r" "$LK" "$BK"; done

  declare -A BEFORE=()
  for r in $APP_ROLES; do BEFORE[$r]="$(role_attrs test "$r")"; done

  if run_main_harness; then
    pass "[A] $LK+$BK — le harnais principal s'exécute jusqu'au bout sur le cluster désigné"
  else
    fail "[A] $LK+$BK — le harnais principal a échoué : $(tail -3 "$TMP_DIR/main.log" | tr '\n' ' ')"
  fi

  # CONTRÔLE POSITIF de la preuve d'identité tardive.
  # Une preuve d'identité CASSÉE (requête en erreur, résultat vide) se
  # comporte comme une preuve ÉCHOUÉE : elle abandonne la restauration.
  # C'est fermé, mais muet. On exige donc qu'une exécution NOMINALE sur
  # le cluster désigné n'abandonne JAMAIS la restauration : sans cela,
  # le chemin de restauration pourrait être mort sans que rien ne le dise.
  if grep -q 'RESTAURATION DE RÔLES ABANDONNÉE' "$TMP_DIR/main.log"; then
    fail "[A] $LK+$BK — la restauration a été ABANDONNÉE sur le cluster désigné : la preuve d'identité ne passe pas en nominal (preuve cassée, non pas destination hostile)"
  else
    pass "[A] $LK+$BK — la preuve d'identité tardive PASSE en nominal (la restauration n'est pas silencieusement morte)"
  fi

  for r in $APP_ROLES; do
    after="$(role_attrs test "$r")"
    if [ "$after" = "${BEFORE[$r]}" ]; then
      pass "[A] $LK+$BK — '$r' restauré EXACTEMENT ($after)"
    else
      fail "[A] $LK+$BK — '$r' corrompu : avant '${BEFORE[$r]}', après '$after'"
    fi
  done
done

# ============================================================
# [B] Forme de l'instantané — CSDJ1-AUD-06
# ============================================================
log "=== [B] forme de l'instantané de rôle ==="
SNAP_EXPR="$(grep -A3 '^role_state()' "$HARNESS" | tr -d '\n')"
case "$SNAP_EXPR" in
  *"then '1' else '0'"*) pass "[B] l'instantané encode explicitement 1/0" ;;
  *) fail "[B] l'instantané n'encode pas 1/0 — la comparaison du nettoyage redeviendrait fragile" ;;
esac
case "$SNAP_EXPR" in
  *"rolcanlogin::text"*) fail "[B] l'instantané emploie encore ::text, dont la forme est 'true'/'false'" ;;
  *) pass "[B] l'instantané n'emploie plus ::text sur un booléen" ;;
esac
if grep -q '\[ "\$login" = "1" \]' "$HARNESS" && grep -q '\[ "\$bypass" = "1" \]' "$HARNESS"; then
  pass "[B] la restauration compare bien à 1, et non à 't'"
else
  fail "[B] la restauration ne compare pas à 1 — l'écart entre capture et comparaison subsiste"
fi
if grep -q "'EXISTS|1|1'" "$HARNESS"; then
  pass "[B] le verrou de sûreté n'accepte que les quatre instantanés bien formés"
else
  fail "[B] le verrou de sûreté n'énumère pas les instantanés admissibles"
fi
# CSDJ1-AUD-07 côté harnais principal : il doit refuser PGHOSTADDR par
# son nom, et prouver sa destination avant de restaurer.
if grep -q 'PGHOSTADDR' "$HARNESS"; then
  pass "[B] le harnais principal refuse PGHOSTADDR par son nom"
else
  fail "[B] le harnais principal ne nomme pas PGHOSTADDR dans ses refus"
fi
if grep -q 'RESTAURATION DE RÔLES ABANDONNÉE' "$HARNESS"; then
  pass "[B] le harnais principal prouve sa destination AVANT de restaurer des rôles"
else
  fail "[B] le harnais principal restaure des rôles sans preuve de destination tardive"
fi

# ============================================================
# [C] Un rôle ABSENT avant doit être ABSENT après
# ============================================================
log "=== [C] un rôle absent avant doit être absent après ==="
csdj1_identity_prove || fatal "[C] preuve d'identité perdue : $CSDJ1_ID_LAST"
csdj1_identity_mutate "  drop role if exists service_role;" \
  || fatal "[C] suppression du rôle ABANDONNÉE ($CSDJ1_ID_LAST)."
if [ "$(role_attrs test service_role)" = "ABSENT" ]; then
  if run_main_harness; then
    pass "[C] le harnais principal s'exécute avec un rôle initialement absent"
  else
    fail "[C] le harnais principal a échoué : $(tail -3 "$TMP_DIR/main.log" | tr '\n' ' ')"
  fi
  after="$(role_attrs test service_role)"
  if [ "$after" = "ABSENT" ]; then
    pass "[C] 'service_role', absent avant, est bien absent après"
  else
    fail "[C] 'service_role' subsiste après l'exécution ($after) — le cluster a été muté"
  fi
else
  fail "[C] impossible de préparer l'état « rôle absent »"
fi

# ============================================================
# [D] ENVIRONNEMENT HOSTILE — CSDJ1-AUD-07
#
# Pour chaque variable de routage, ce harnais est relancé en enfant avec
# la variable pointant vers le cluster TÉMOIN. Trois exigences :
#   - l'enfant REFUSE (code 2) ;
#   - le refus NOMME la variable ;
#   - le témoin ne subit AUCUNE mutation.
# Le refus survenant avant toute création de cluster, l'enfant ne peut
# pas récurser.
# ============================================================
log "=== [D] environnement hostile : neuf variables de routage ==="

hostile() {
  local label="$1" varname="$2" value="$3" rc out
  out="$TMP_DIR/hostile-$varname.log"
  env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    SCANYM_DISPOSABLE_CLUSTER=1 "$varname=$value" \
    bash "${BASH_SOURCE[0]}" >"$out" 2>&1
  rc=$?
  if [ "$rc" -eq 2 ]; then
    pass "[D] $label — REFUS (code 2)"
  else
    fail "[D] $label — code $rc au lieu de 2 : la variable n'a pas été refusée"
  fi
  if grep -q "$varname est définie" "$out"; then
    pass "[D] $label — le refus NOMME la variable"
  else
    fail "[D] $label — le refus ne nomme pas $varname : $(head -2 "$out" | tr '\n' ' ')"
  fi
  if ! grep -q "$value" "$out"; then
    pass "[D] $label — la VALEUR n'est pas journalisée"
  else
    fail "[D] $label — la valeur de $varname a fuité dans la sortie"
  fi
  local bad; bad="$(witness_untouched)"
  if [ "$bad" = "0" ]; then
    pass "[D] $label — le TÉMOIN n'a subi AUCUNE mutation"
  else
    fail "[D] $label — $bad rôle(s) du témoin muté(s)"
  fi
}

# La reproduction exigée : PGHOSTADDR seul, puis PGHOSTADDR avec le port
# du témoin -- le vecteur complet, où libpq routerait réellement vers le
# témoin si rien ne l'en empêchait.
hostile "PGHOSTADDR seul" PGHOSTADDR "127.0.0.1"
hostile "PGHOST" PGHOST "$WIT_SOCK"
hostile "PGPORT" PGPORT "$DECOY_PORT"
hostile "PGDATABASE" PGDATABASE "postgres"
hostile "PGUSER" PGUSER "postgres"
hostile "PGSERVICE" PGSERVICE "temoin"
hostile "PGSERVICEFILE" PGSERVICEFILE "$TMP_DIR/pg_service.conf"
hostile "PGPASSWORD" PGPASSWORD "ne-doit-jamais-paraitre-en-sortie"
hostile "PGPASSFILE" PGPASSFILE "$TMP_DIR/pgpass"
hostile "PGSYSCONFDIR" PGSYSCONFDIR "$TMP_DIR"
hostile "DATABASE_URL" DATABASE_URL "postgresql://u:p@127.0.0.1:$DECOY_PORT/postgres"

# Le vecteur COMPLET : adresse ET port du témoin ensemble. Sans
# protection, libpq aboutirait au témoin et le harnais principal y
# écraserait ses rôles.
log "=== [D] vecteur complet PGHOSTADDR + PGPORT vers le témoin ==="
env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
  SCANYM_DISPOSABLE_CLUSTER=1 PGHOSTADDR=127.0.0.1 PGPORT="$WIT_PORT" \
  bash "${BASH_SOURCE[0]}" >"$TMP_DIR/hostile-full.log" 2>&1
RC_FULL=$?
if [ "$RC_FULL" -eq 2 ]; then
  pass "[D] vecteur complet — REFUS (code 2)"
else
  fail "[D] vecteur complet — code $RC_FULL au lieu de 2"
fi
if [ "$(witness_untouched)" = "0" ]; then
  pass "[D] vecteur complet — le témoin n'a subi AUCUNE mutation"
else
  fail "[D] vecteur complet — le témoin a été muté : la redirection a abouti"
fi

# Contrôle POSITIF : sans aucune variable hostile, l'enfant ne refuse pas
# pour cette raison. Sans ce contrôle, un harnais qui refuserait TOUT
# passerait pour un harnais protégé.
log "=== [D] contrôle positif : un environnement propre ne déclenche pas ce refus ==="
env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" SCANYM_DISPOSABLE_CLUSTER=1 \
  bash -c "grep -q 'est définie' /dev/null; exit 0" >/dev/null 2>&1
CLEAN_LOG="$TMP_DIR/clean-probe.log"
env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
  "$PSQL" -X -A -q -t -h "$SOCKET_DIR" -p "$PORT" -U "$OWNER" -d postgres \
  -c "select 'connexion-propre-ok';" </dev/null >"$CLEAN_LOG" 2>&1
if grep -q 'connexion-propre-ok' "$CLEAN_LOG"; then
  pass "[D] contrôle positif — un environnement propre atteint bien le cluster sous test"
else
  fail "[D] contrôle positif — l'environnement propre ne se connecte pas : $(head -2 "$CLEAN_LOG" | tr '\n' ' ')"
fi

# ============================================================
# [G] CONTRÔLES NÉGATIFS DE L'IDENTITÉ COMPLÈTE
#     CSDJ-V1-DESTINATION-PROOF-02
#
# Le second re-audit delta a trouvé que la preuve du nettoyage restait
# satisfaite alors que le marqueur avait été changé ou retiré : elle ne
# le regardait pas. Un prédicat qu'on ne peut pas faire échouer n'est
# pas un prédicat.
#
# On fausse donc UN SEUL fait à la fois -- les huit, l'un après
# l'autre -- et on exige, pour chacun :
#
#   - le refus, avec la RAISON attendue et pas une autre ;
#   - ZÉRO mutation : le rôle témoin ne bouge pas d'un attribut.
#
# Le rôle témoin `scanym_csdj1_probe` existe pour cela : NOLOGIN
# NOBYPASSRLS au départ, et la mutation tentée voudrait le passer
# BYPASSRLS. S'il basculait une seule fois, un contrôle aurait laissé
# passer une mutation.
# ============================================================
log "=== [G] contrôles négatifs : chaque fait de l'identité, faussé à son tour ==="
PROBE_ROLE="scanym_csdj1_probe"
set_role_attrs "$PROBE_ROLE" "NOLOGIN" "NOBYPASSRLS"
PROBE_BEFORE="$(role_attrs test "$PROBE_ROLE")"
if [ "$PROBE_BEFORE" = "NOLOGIN+NOBYPASSRLS" ]; then
  pass "[G] rôle témoin posé ($PROBE_BEFORE) par le chemin NOMINAL -- le prédicat laisse passer ce qui est légitime"
else
  fatal "[G] impossible de poser le rôle témoin (vu « $PROBE_BEFORE »)."
fi

# La mutation tentée par chaque contrôle. Observable, et réversible.
PROBE_MUTATION="  alter role $PROBE_ROLE bypassrls;"

# Fausse UN champ du contrat, tente la mutation, restaure le contrat.
# `expect` est la raison de refus ATTENDUE : exiger la BONNE raison
# interdit qu'un contrôle passe pour la mauvaise cause -- par exemple un
# refus de connexion qu'on prendrait pour un refus d'identité.
negative_control() {
  local label="$1" field="$2" value="$3" expect="$4"
  # Le contrat est NOMMÉ : on le fausse, puis on y revient par son nom.
  # Six variables sauvegardées à la main en seraient une septième à
  # oublier un jour.
  csdj1_identity_use "${5:-test}" || fatal "[G] contrat indisponible."

  case "$field" in
    runner)   CSDJ1_ID_RUNNER="$value" ;;
    socket)   CSDJ1_ID_SOCKET="$value" ;;
    port)     CSDJ1_ID_PORT="$value" ;;
    user)     CSDJ1_ID_USER="$value" ;;
    datadir)  CSDJ1_ID_DATADIR="$value" ;;
    config)   CSDJ1_ID_CONFIG="$value" ;;
    nonce)    CSDJ1_ID_NONCE="$value" ;;
    marker_dropped)
      # Le marqueur est RETIRÉ du cluster, hors garde : c'est la
      # reproduction littérale du constat de l'audit.
      csdj1_runner_test "drop table if exists public.$IDENTITY_MARKER;" >/dev/null 2>&1 ;;
    marker_changed)
      csdj1_runner_test "update public.$IDENTITY_MARKER set nonce = 'nonce-etranger';" >/dev/null 2>&1 ;;
  esac

  local accepted=0 reason
  if csdj1_identity_mutate "$PROBE_MUTATION"; then accepted=1; fi
  reason="$CSDJ1_ID_LAST"
  if [ "$accepted" = "1" ]; then
    fail "[G] $label — la mutation a été ACCEPTÉE malgré une identité fausse"
  elif [ "$reason" = "$expect" ]; then
    pass "[G] $label — REFUS, raison « $reason »"
  else
    fail "[G] $label — refus pour la MAUVAISE raison : « $reason » au lieu de « $expect »"
  fi

  # Remise en état du contrat, puis du cluster si le contrôle l'a touché.
  csdj1_identity_use "${5:-test}" || fatal "[G] contrat indisponible."
  case "$field" in
    marker_dropped)
      csdj1_runner_test "create table public.$IDENTITY_MARKER (nonce text primary key);" >/dev/null 2>&1
      csdj1_runner_test "insert into public.$IDENTITY_MARKER values ('$NONCE');" >/dev/null 2>&1 ;;
    marker_changed)
      csdj1_runner_test "update public.$IDENTITY_MARKER set nonce = '$NONCE';" >/dev/null 2>&1 ;;
  esac

  # ZÉRO MUTATION : l'exigence du mandat, vérifiée après CHAQUE contrôle.
  local after; after="$(role_attrs test "$PROBE_ROLE")"
  if [ "$after" = "$PROBE_BEFORE" ]; then
    pass "[G] $label — ZÉRO mutation (le rôle témoin est resté $after)"
  else
    fail "[G] $label — le rôle témoin a été MUTÉ : $PROBE_BEFORE -> $after"
  fi
}

# Un utilisateur NON superutilisateur, pour éprouver ce fait-là seul.
csdj1_identity_mutate "
  if not exists (select 1 from pg_catalog.pg_roles where rolname='scanym_csdj1_plain') then
    create role scanym_csdj1_plain login nosuperuser;
  end if;
" || fatal "[G] impossible de créer le rôle non privilégié de contrôle."
csdj1_runner_plain() {
  env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    "$PSQL" -X -A -q -t -v ON_ERROR_STOP=1 \
      -h "$SOCKET_DIR" -p "$PORT" -U scanym_csdj1_plain -d postgres \
      -c "$1" </dev/null 2>&1
}

negative_control "data_directory faux"  datadir "$DATA_DIR_PROVEN-faux"        "data_directory"
negative_control "config_file faux"     config  "$CONFIG_FILE_PROVEN.faux"     "config_file"
negative_control "marqueur RETIRÉ"      marker_dropped ""                      "marqueur_absent"
negative_control "marqueur CHANGÉ"      marker_changed ""                      "nonce"
negative_control "nonce attendu faux"   nonce   "nonce-qui-n-a-jamais-existe"  "nonce"
negative_control "port faux"            port    "$DECOY_PORT"                  "port"
negative_control "utilisateur faux"     user    "quelqu-un-d-autre"            "current_user"
negative_control "destination RÉSEAU (témoin)" runner csdj1_runner_witness_tcp "destination_reseau"
negative_control "socket attendue fausse" socket "/var/run/postgresql-inexistant" "socket"

# Le fait « superutilisateur » s'éprouve en changeant d'utilisateur ET
# d'attente : sans cela, c'est `current_user` qui refuserait d'abord, et
# le contrôle prouverait autre chose que ce qu'il annonce.
# Le fait « superutilisateur » s'éprouve par un CONTRAT à part : tout y
# est exact -- socket, port, utilisateur, data_directory, config_file,
# marqueur -- sauf que la connexion n'est pas privilégiée. Perturber un
# champ ne suffirait pas : la remise en état par le NOM du contrat
# écraserait la perturbation.
csdj1_identity_declare test_sans_privilege csdj1_runner_plain \
  "$SOCKET_DIR" "$PORT" "scanym_csdj1_plain" "$DATA_DIR_PROVEN" "$CONFIG_FILE_PROVEN" \
  "$IDENTITY_MARKER" "$NONCE" \
  || fatal "[G] contrat non privilégié invalide."
negative_control "non superutilisateur" aucun "" "is_superuser" test_sans_privilege
csdj1_identity_use test || fatal "[G] contrat du cluster sous test indisponible."

# Et le CHEMIN NOMINAL fonctionne toujours : un prédicat qui refuserait
# désormais tout aurait l'air parfait dans les dix contrôles ci-dessus.
# C'est l'exigence explicite du mandat : « A harness that always aborts
# is not a PASS. »
if csdj1_identity_mutate "  alter role $PROBE_ROLE bypassrls;"; then
  if [ "$(role_attrs test "$PROBE_ROLE")" = "NOLOGIN+BYPASSRLS" ]; then
    pass "[G] CONTRÔLE POSITIF — le chemin nominal MUTE toujours (le prédicat n'est pas devenu un refus universel)"
  else
    fail "[G] CONTRÔLE POSITIF — mutation acceptée mais sans effet observable"
  fi
else
  fail "[G] CONTRÔLE POSITIF — le prédicat refuse le chemin NOMINAL ($CSDJ1_ID_LAST) : il refuse tout, il ne prouve rien"
fi
csdj1_identity_mutate "  drop role if exists $PROBE_ROLE;" >/dev/null
csdj1_identity_mutate "  drop role if exists scanym_csdj1_plain;" >/dev/null

# ============================================================
# [H] LE RÉPERTOIRE DE SOCKET SE COMPARE À L'ÉGALITÉ EXACTE
#
# Défaut relevé par le quatrième re-audit : la validation employait
# `strpos`, une sémantique de SOUS-CHAÎNE. Un serveur dont la socket est
# « /tmp » satisfaisait un attendu « /tm ». Une identité qui accepte un
# fragment n'identifie rien -- et, sur un poste où plusieurs clusters
# jetables vivent côte à côte sous /tmp, le fragment est la règle et non
# l'exception.
#
# Le banc d'essai a DEUX répertoires de socket : on éprouve donc aussi
# ce que vaut la comparaison sur une vraie LISTE.
# ============================================================
log "=== [H] égalité exacte du répertoire de socket ==="

LAB_DD="$(csdj1_runner_lab "select pg_catalog.current_setting('data_directory');" | tail -1 | tr -d ' ')"
LAB_CF="$(csdj1_runner_lab "select pg_catalog.current_setting('config_file');" | tail -1 | tr -d ' ')"
LAB_NONCE="csdj1-banc-$$-$(date -u '+%Y%m%d%H%M%S')"
LAB_MARKER="scanym_csdj1_identity_banc_$$"

csdj1_identity_declare banc csdj1_runner_lab \
  "$LAB_SOCK_A" "$LAB_PORT" "$OWNER" "$LAB_DD" "$LAB_CF" \
  "$LAB_MARKER" "$LAB_NONCE" \
  || fatal "[H] contrat d'identité du banc invalide."
csdj1_identity_install || fatal "[H] pose du marqueur du banc REFUSÉE ($CSDJ1_ID_LAST)."

LAB_PROBE="scanym_csdj1_banc_probe"
csdj1_identity_mutate "
  if not exists (select 1 from pg_catalog.pg_roles where rolname='$LAB_PROBE') then
    create role $LAB_PROBE nologin nobypassrls;
  else
    alter role $LAB_PROBE nologin nobypassrls;
  end if;
" || fatal "[H] impossible de poser le rôle témoin du banc ($CSDJ1_ID_LAST)."

lab_probe_state() {
  csdj1_runner_lab "select (case when rolbypassrls then 'BYPASSRLS' else 'NOBYPASSRLS' end)
                    from pg_catalog.pg_roles where rolname = '$LAB_PROBE';" \
    | tail -1 | tr -d ' '
}
LAB_PROBE_BEFORE="$(lab_probe_state)"
[ "$LAB_PROBE_BEFORE" = "NOBYPASSRLS" ] \
  || fatal "[H] rôle témoin du banc dans un état inattendu (« $LAB_PROBE_BEFORE »)."

# Un attendu faux, une mutation tentée, et deux exigences : le REFUS
# pour la raison « socket », et ZÉRO mutation.
socket_control() {
  local label="$1" expected="$2" want="$3"
  csdj1_identity_use banc || fatal "[H] contrat du banc indisponible."
  CSDJ1_ID_SOCKET="$(csdj1_identity_normalize_socket "$expected")"
  local accepted=0 reason
  if csdj1_identity_mutate "  alter role $LAB_PROBE bypassrls;"; then accepted=1; fi
  # La RAISON se lit AVANT toute autre mutation : la remise en état
  # ci-dessous écraserait CSDJ1_ID_LAST avec son propre « OK ».
  reason="$CSDJ1_ID_LAST"
  local after; after="$(lab_probe_state)"
  csdj1_identity_use banc || fatal "[H] contrat du banc indisponible."
  # Remise en état, par le chemin gardé et nominal.
  csdj1_identity_mutate "  alter role $LAB_PROBE nobypassrls;" >/dev/null

  if [ "$want" = "accept" ]; then
    if [ "$accepted" = "1" ]; then
      pass "[H] $label — ACCEPTÉ (attendu « $expected »)"
    else
      fail "[H] $label — refusé à tort ($reason) : le prédicat refuserait l'entrée légitime"
    fi
    return
  fi
  if [ "$accepted" = "1" ]; then
    fail "[H] $label — ACCEPTÉ à tort : « $expected » n'est pas une entrée complète de la liste"
  elif [ "$reason" = "socket" ]; then
    pass "[H] $label — REFUS, raison « socket »"
  else
    fail "[H] $label — refus pour la MAUVAISE raison : « $reason » au lieu de « socket »"
  fi
  if [ "$after" = "$LAB_PROBE_BEFORE" ]; then
    pass "[H] $label — ZÉRO mutation (le rôle témoin est resté $after)"
  else
    fail "[H] $label — le rôle témoin a été MUTÉ : $LAB_PROBE_BEFORE -> $after"
  fi
}

# ── Entrées SIMPLES, sans guillemets (déjà closes au tour précédent,
#    rejouées en régression).
socket_control "entrée EXACTE (membre simple)"   "$LAB_SOCK_A"            accept
socket_control "entrée EXACTE (autre membre)"    "$LAB_SOCK_B"            accept
socket_control "barre oblique finale, même répertoire" "$LAB_SOCK_A/"     accept
socket_control "PRÉFIXE d'une entrée"            "${LAB_SOCK_A%?}"        reject
socket_control "entrée + un caractère"           "${LAB_SOCK_A}x"         reject
socket_control "répertoire PARENT"               "$TMP_DIR"               reject
socket_control "SOUS-répertoire d'une entrée"    "$LAB_SOCK_A/sous"       reject
socket_control "SUFFIXE d'une entrée"            "/lab-a"                 reject
socket_control "reproduction d'audit : /tmp vs /tm" "/tm"                 reject
socket_control "reproduction d'audit : /tmp vs /tmpx" "/tmpx"             reject

# ── Entrées CITÉES — CSDJ1-AUD-07-SOCKET-CSV-01.
#
# Le défaut : un découpage à CHAQUE virgule fabrique des fragments à
# partir de « "<rép>/foo,bar" ». Il ACCEPTE « <rép>/foo », qui n'est pas
# un répertoire configuré, et REFUSE « <rép>/foo,bar », qui en est un.
socket_control "membre CITÉ à virgule, exact"    "$LAB_SOCK_C"            accept
socket_control "membre simple, liste contenant une entrée citée" "$LAB_SOCK_A" accept
socket_control "FRAGMENT avant la virgule citée" "${LAB_SOCK_C%%,*}"      reject
socket_control "FRAGMENT après la virgule citée" "${LAB_SOCK_C##*,}"      reject
socket_control "membre CITÉ à ESPACE, exact"     "$LAB_SOCK_D"            accept
socket_control "membre CITÉ, barre oblique finale dans la configuration" "$LAB_SOCK_E" accept
socket_control "membre CITÉ, attendu avec barre oblique" "$LAB_SOCK_E/"   accept

# La LISTE ENTIÈRE, telle que le serveur la rend : une fausse identité.
LAB_WHOLE_LIST="$(csdj1_runner_lab "show unix_socket_directories;" | tail -1)"
socket_control "la LISTE ENTIÈRE rendue par SHOW" "$LAB_WHOLE_LIST"       reject

# Un guillemet DOUBLÉ dans la configuration vaut un guillemet littéral
# dans le nom : vérifié empiriquement sur ce serveur. On ne l'éprouve
# que si le serveur a réellement accepté une telle entrée -- la
# configuration de ce banc n'en contient pas, et inventer un cas que le
# serveur ne produit pas ne prouverait rien.
if printf '%s' "$LAB_WHOLE_LIST" | grep -q '""'; then
  pass "[H] la liste rendue contient un guillemet doublé : le cas est éprouvé en conditions réelles"
else
  log "   (aucun guillemet doublé dans la liste de ce banc : le parseur le traite, le banc ne l'exerce pas)"
fi

# ── DÉMONSTRATION DE NOCIVITÉ, par le parseur PARTAGÉ.
#
# Le verdict « nouveau » est produit par l'EXPRESSION QUE LA GARDE
# EMPLOIE -- la même fonction d'émission, pas une copie. Sans cela, la
# démonstration prouverait la justesse d'un second parseur, et non celle
# du premier.
csdj1_identity_use banc || fatal "[H] contrat du banc indisponible."
for bad in "${LAB_SOCK_A%?}" "/tm" "$TMP_DIR" "${LAB_SOCK_C%%,*}" "${LAB_SOCK_C##*,}"; do
  OLD_SUBSTR="$(csdj1_runner_lab "select pg_catalog.strpos(
      coalesce(pg_catalog.current_setting('unix_socket_directories', true), ''),
      '$bad') <> 0;" | tail -1 | tr -d ' ')"
  OLD_SPLIT="$(csdj1_runner_lab "select exists (
      select 1 from pg_catalog.unnest(pg_catalog.string_to_array(
        coalesce(pg_catalog.current_setting('unix_socket_directories', true), ''), ',')) as sd(entry)
      where case
              when pg_catalog.btrim(pg_catalog.btrim(pg_catalog.btrim(sd.entry), '\"')) = '/' then '/'
              else pg_catalog.rtrim(pg_catalog.btrim(pg_catalog.btrim(pg_catalog.btrim(sd.entry), '\"')), '/')
            end = '$bad');" | tail -1 | tr -d ' ')"
  NEW_VERDICT="$(csdj1_runner_lab "select $(csdj1_identity_socket_match_expr "$bad");" | tail -1 | tr -d ' ')"
  if [ "$NEW_VERDICT" != "f" ]; then
    fail "[H] « $bad » : le parseur PARTAGÉ l'accepte -- ce n'est pas une entrée complète"
  elif [ "$OLD_SUBSTR" = "t" ] || [ "$OLD_SPLIT" = "t" ]; then
    pass "[H] « $bad » : accepté par au moins un ancien prédicat (sous-chaîne=$OLD_SUBSTR, découpage brut=$OLD_SPLIT), REFUSÉ par le parseur partagé"
  else
    fail "[H] « $bad » : aucun ancien prédicat ne l'acceptait -- ce cas ne distingue rien"
  fi
done

# Et les entrées LÉGITIMES que le découpage brut REFUSAIT : l'erreur
# allait dans les deux sens, et la seconde aurait rendu le harnais
# inutilisable sur un serveur à entrée citée.
for good in "$LAB_SOCK_C" "$LAB_SOCK_D" "$LAB_SOCK_E"; do
  OLD_SPLIT="$(csdj1_runner_lab "select exists (
      select 1 from pg_catalog.unnest(pg_catalog.string_to_array(
        coalesce(pg_catalog.current_setting('unix_socket_directories', true), ''), ',')) as sd(entry)
      where case
              when pg_catalog.btrim(pg_catalog.btrim(pg_catalog.btrim(sd.entry), '\"')) = '/' then '/'
              else pg_catalog.rtrim(pg_catalog.btrim(pg_catalog.btrim(pg_catalog.btrim(sd.entry), '\"')), '/')
            end = '$good');" | tail -1 | tr -d ' ')"
  NEW_VERDICT="$(csdj1_runner_lab "select $(csdj1_identity_socket_match_expr "$good");" | tail -1 | tr -d ' ')"
  if [ "$NEW_VERDICT" = "t" ] && [ "$OLD_SPLIT" = "f" ]; then
    pass "[H] « $good » : entrée RÉELLE que le découpage brut refusait, acceptée par le parseur partagé"
  elif [ "$NEW_VERDICT" != "t" ]; then
    fail "[H] « $good » : le parseur partagé refuse une entrée RÉELLE"
  else
    pass "[H] « $good » : entrée réelle acceptée (le découpage brut l'acceptait aussi)"
  fi
done

# ── OCTETS RÉSERVÉS PAR L'ENCODAGE DU PARSEUR
#    CSDJ1-AUD-07-SOCKET-SENTINEL-01
#
# Le parseur emploie chr(1) et chr(2) comme sentinelles internes. Ces
# octets ne sont réservés par AUCUNE syntaxe PostgreSQL : un nom de
# répertoire peut les contenir -- Linux n'interdit que « / » et l'octet
# nul -- et un serveur démarre parfaitement sur un tel répertoire.
#
# La collision se produit, et dans les DEUX sens :
#   chr(2) dans un nom est pris pour un séparateur => le fragment qui le
#          précède devient une entrée, donc une FAUSSE IDENTITÉ ;
#   chr(1) dans un nom est restitué en guillemet => un chemin qui
#          N'EXISTE PAS est accepté, et l'entrée réelle refusée.
#
# On l'éprouve sur de VRAIS clusters portant ces octets, et non sur une
# chaîne fabriquée : le défaut n'existe que parce que PostgreSQL rend
# réellement ces octets.
log "=== [H] octets réservés par l'encodage du parseur (chr(1), chr(2)) ==="

SENT_DATA="$TMP_DIR/sentinelles"
SENT_PORT=$(( PORT + 2 ))
SENT_PLAIN="$TMP_DIR/sent-plain"
SENT_UP=0
SENT_MARKER="scanym_csdj1_identity_sent_$$"
SENT_NONCE="csdj1-sent-$$-$(date -u '+%Y%m%d%H%M%S')"
SENT_MARKER_DONE=0
SENT_B1="$TMP_DIR/foo$(printf '\001')bar"
SENT_B2="$TMP_DIR/foo$(printf '\002')bar"
mkdir -p "$SENT_PLAIN" "$SENT_B1" "$SENT_B2"
env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
  "$INITDB" -D "$SENT_DATA" -A trust -E UTF8 --locale=C >"$TMP_DIR/initdb-sent.log" 2>&1 \
  || fatal "[H] initdb du cluster à sentinelles a échoué."

csdj1_runner_sent() {
  env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    "$PSQL" -X -A -q -t -v ON_ERROR_STOP=1 \
      -h "$SENT_PLAIN" -p "$SENT_PORT" -U "$OWNER" -d postgres \
      -c "$1" </dev/null 2>&1
}

# Un contrôle par octet. Le cluster est démarré avec un répertoire de
# socket PORTANT l'octet, l'attendu est la fausse identité que la
# collision fabrique, et l'on exige : refus NOMMÉ, et empreinte de rôle
# INCHANGÉE.
sentinel_control() {
  local label="$1" badsock="$2" expected="$3"

  # ── 1. Le cluster démarre avec une liste de sockets ORDINAIRE.
  #    Tout le reste de l'identité est ainsi LÉGITIME -- marqueur
  #    compris -- et le seul fait qui clochera à l'étape 4 sera l'octet
  #    réservé. Sans cela, le refus pourrait venir du marqueur absent,
  #    et le contrôle prouverait autre chose que ce qu'il annonce.
  env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    "$PG_CTL" -D "$SENT_DATA" -l "$SENT_DATA.log" \
      -o "-p $SENT_PORT -c unix_socket_directories='$SENT_PLAIN' -c listen_addresses=''" \
      start >/dev/null 2>&1
  if [ $? -ne 0 ]; then
    fail "[H] $label — le cluster à sentinelles n'a pas démarré"
    return
  fi
  SENT_UP=1

  csdj1_identity_declare sentinelles csdj1_runner_sent \
    "$SENT_PLAIN" "$SENT_PORT" "$OWNER" \
    "$(csdj1_runner_sent "select pg_catalog.current_setting('data_directory');" | tail -1 | tr -d ' ')" \
    "$(csdj1_runner_sent "select pg_catalog.current_setting('config_file');" | tail -1 | tr -d ' ')" \
    "$SENT_MARKER" "$SENT_NONCE" \
    || fatal "[H] contrat du cluster à sentinelles invalide."
  if [ "${SENT_MARKER_DONE:-0}" != "1" ]; then
    csdj1_identity_install || fatal "[H] pose du marqueur sur le cluster à sentinelles REFUSÉE ($CSDJ1_ID_LAST)."
    SENT_MARKER_DONE=1
  fi
  csdj1_identity_mutate "
  if not exists (select 1 from pg_catalog.pg_roles where rolname='scanym_csdj1_sent_probe') then
    create role scanym_csdj1_sent_probe nologin nobypassrls;
  else
    alter role scanym_csdj1_sent_probe nologin nobypassrls;
  end if;
" || fatal "[H] impossible de poser le rôle témoin du cluster à sentinelles ($CSDJ1_ID_LAST)."

  sent_fingerprint() {
    csdj1_runner_sent "select coalesce(pg_catalog.string_agg(
        r.rolname || ':' || (case when r.rolcanlogin then '1' else '0' end)
                  || (case when r.rolbypassrls then '1' else '0' end), ',' order by r.rolname), 'AUCUN')
      from pg_catalog.pg_roles r where r.rolname = 'scanym_csdj1_sent_probe';" | tail -1 | tr -d ' '
  }
  local before after reason collides
  before="$(sent_fingerprint)"
  if [ "$before" != "scanym_csdj1_sent_probe:00" ]; then
    fail "[H] $label — rôle témoin dans un état inattendu (« $before »)"
    env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" "$PG_CTL" -D "$SENT_DATA" stop -m immediate >/dev/null 2>&1
    SENT_UP=0
    csdj1_identity_use test
    return
  fi

  # ── 2. Le cluster est RECONFIGURÉ avec un répertoire de socket
  #    portant l'octet réservé, et redémarré. Rien d'autre ne change :
  #    même data_directory, même config_file, même port, même
  #    utilisateur, même marqueur.
  env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    "$PG_CTL" -D "$SENT_DATA" stop -m immediate >/dev/null 2>&1
  SENT_UP=0
  env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    "$PG_CTL" -D "$SENT_DATA" -l "$SENT_DATA.log" \
      -o "-p $SENT_PORT -c unix_socket_directories='$badsock,$SENT_PLAIN' -c listen_addresses=''" \
      start >/dev/null 2>&1
  if [ $? -ne 0 ]; then
    fail "[H] $label — le cluster n'a pas redémarré avec l'octet réservé : le cas ne peut pas être éprouvé"
    csdj1_identity_use test
    return
  fi
  SENT_UP=1

  # ── 3. La collision est-elle RÉELLE ? Le parseur SEUL -- sans la
  #    défense -- accepte-t-il la fausse identité ?
  collides="$(csdj1_runner_sent "select $(csdj1_identity_socket_match_expr "$(csdj1_identity_normalize_socket "$expected")");" | tail -1 | tr -d ' ')"

  # ── 4. La mutation est tentée avec l'attendu FABRIQUÉ par la collision.
  csdj1_identity_use sentinelles || fatal "[H] contrat des sentinelles indisponible."
  CSDJ1_ID_SOCKET="$(csdj1_identity_normalize_socket "$expected")"
  local accepted=0
  if csdj1_identity_mutate "  alter role scanym_csdj1_sent_probe bypassrls;"; then accepted=1; fi
  reason="$CSDJ1_ID_LAST"
  after="$(sent_fingerprint)"

  if [ "$accepted" = "1" ]; then
    fail "[H] $label — la mutation a été ACCEPTÉE : « $expected » est une fausse identité fabriquée par la collision"
  elif [ "$reason" = "socket_octets_reserves" ]; then
    pass "[H] $label — REFUS, raison « $reason »"
  else
    fail "[H] $label — refus pour la MAUVAISE raison : « $reason » au lieu de « socket_octets_reserves »"
  fi
  if [ "$after" = "$before" ]; then
    pass "[H] $label — empreinte de rôle INCHANGÉE ($after)"
  else
    fail "[H] $label — empreinte de rôle MODIFIÉE : « $before » -> « $after »"
  fi
  if [ "$collides" = "t" ]; then
    pass "[H] $label — la collision est RÉELLE : le parseur seul accepte l'attendu, c'est la défense qui l'arrête"
  else
    fail "[H] $label — le parseur n'accepte pas l'attendu : ce cas ne démontre aucune collision"
  fi

  env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    "$PG_CTL" -D "$SENT_DATA" stop -m immediate >/dev/null 2>&1
  SENT_UP=0
  csdj1_identity_use test || fatal "[H] contrat du cluster sous test indisponible."
}

# S2 : chr(2) dans le nom => le fragment avant l'octet devient une entrée.
sentinel_control "S2 chr(2), fausse identité « \$TMP_DIR/foo »" "$SENT_B2" "$TMP_DIR/foo"
# S1 : chr(1) dans le nom => un chemin à guillemet, qui n'existe pas.
sentinel_control "S1 chr(1), chemin FABRIQUÉ « \$TMP_DIR/foo\"bar »" "$SENT_B1" "$TMP_DIR/foo\"bar"

# Un cluster ORDINAIRE n'est pas refusé pour autant : la défense ne doit
# pas rendre le harnais inutilisable là où rien ne cloche.
env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
  "$PG_CTL" -D "$SENT_DATA" -l "$SENT_DATA.log" \
    -o "-p $SENT_PORT -k $SENT_PLAIN -c unix_socket_directories='$SENT_PLAIN' -c listen_addresses=''" \
    start >/dev/null 2>&1
if [ $? -eq 0 ]; then
  SENT_UP=1
  SENT_OK="$(csdj1_runner_sent "select $(csdj1_identity_socket_reserved_expr);" | tail -1 | tr -d ' ')"
  SENT_MATCH="$(csdj1_runner_sent "select $(csdj1_identity_socket_match_expr "$SENT_PLAIN");" | tail -1 | tr -d ' ')"
  if [ "$SENT_OK" = "t" ] && [ "$SENT_MATCH" = "t" ]; then
    pass "[H] CONTRÔLE POSITIF — un chemin ORDINAIRE passe toujours (aucun octet réservé, appartenance exacte)"
  else
    fail "[H] CONTRÔLE POSITIF — un chemin ordinaire est refusé (réservés=$SENT_OK, appartenance=$SENT_MATCH)"
  fi
  env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    "$PG_CTL" -D "$SENT_DATA" stop -m immediate >/dev/null 2>&1
  SENT_UP=0
else
  fail "[H] CONTRÔLE POSITIF — le cluster ordinaire n'a pas démarré"
fi
csdj1_identity_use test || fatal "[H] contrat du cluster sous test indisponible."

# Une liste MAL FORMÉE ne peut pas sortir de SHOW -- PostgreSQL refuse de
# démarrer dessus (« invalid list syntax in parameter »). On vérifie
# néanmoins que la garde porte le refus correspondant : une hypothèse
# qu'on ne vérifie pas est une hypothèse qu'on finit par violer.
if grep -q 'socket_liste_malformee' "$SCRIPT_DIR/csdj1-cluster-identity.sh"; then
  pass "[H] la garde refuse explicitement une liste mal formée (citation non fermée)"
else
  fail "[H] aucune garde contre une liste de sockets mal formée"
fi

csdj1_identity_mutate "  drop role if exists $LAB_PROBE;" >/dev/null
csdj1_identity_use test || fatal "[H] contrat du cluster sous test indisponible."

# ============================================================
# [F] CONTRÔLE DE NOCIVITÉ — la menace est RÉELLE
#
# [D] prouve que le harnais refuse PGHOSTADDR. Cela ne vaut que si
# PGHOSTADDR pouvait réellement détourner la connexion : un refus qui
# protège d'un danger inexistant ne prouve rien.
#
# On le démontre donc en clair, et EN LECTURE SEULE : un appel psql
# DÉLIBÉRÉMENT non isolé, avec « -h <socket privée> » explicite et
# PGHOSTADDR/PGPORT pointant vers le témoin, doit aboutir AU TÉMOIN.
# C'est exactement la reproduction exigée par l'audit.
#
# Aucun ALTER ROLE, aucun CREATE : un seul SELECT de diagnostic.
# ============================================================
log "=== [F] contrôle de nocivité : PGHOSTADDR l'emporte-t-il sur -h ? ==="
DIAG="select pg_catalog.current_setting('data_directory');"

# (a) Appel NON isolé, environnement hostile : où aboutit-il ?
#     Le binaire est désigné par un alias au nom explicite : le
#     détecteur d'isolation de [E] doit pouvoir distinguer cet unique
#     appel non isolé DÉLIBÉRÉ des appels de travail, sans pour autant
#     cesser de les surveiller.
PSQL_UNISOLATED_ON_PURPOSE="$PSQL"
HOSTILE_DEST="$(PGHOSTADDR=127.0.0.1 PGPORT="$WIT_PORT" \
  "$PSQL_UNISOLATED_ON_PURPOSE" -X -A -q -t -h "$SOCKET_DIR" -p "$PORT" -U "$OWNER" -d postgres \
  -c "$DIAG" </dev/null 2>/dev/null | tail -1 | tr -d ' ')"
if [ "$HOSTILE_DEST" = "$WIT_DATA" ]; then
  pass "[F] NOCIF : sans isolation, PGHOSTADDR l'emporte sur « -h » et la connexion aboutit AU TÉMOIN ($WIT_DATA)"
elif [ "$HOSTILE_DEST" = "$PGDATA_DIR" ]; then
  fail "[F] la menace n'est pas reproduite ici (la connexion reste sur le cluster sous test) : [D] ne prouve donc rien sur cette plateforme"
else
  fail "[F] destination hostile inattendue : « $HOSTILE_DEST »"
fi

# (b) Le MÊME appel sous env -i, même environnement hostile au départ :
#     il doit aboutir au cluster SOUS TEST. C'est l'isolation qui agit,
#     et rien d'autre.
ISOLATED_DEST="$(PGHOSTADDR=127.0.0.1 PGPORT="$WIT_PORT" \
  env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
  "$PSQL" -X -A -q -t -h "$SOCKET_DIR" -p "$PORT" -U "$OWNER" -d postgres \
  -c "$DIAG" </dev/null 2>/dev/null | tail -1 | tr -d ' ')"
if [ "$ISOLATED_DEST" = "$PGDATA_DIR" ]; then
  pass "[F] NEUTRALISÉ : le même appel sous « env -i » aboutit au cluster SOUS TEST ($PGDATA_DIR)"
else
  fail "[F] l'isolation n'a pas neutralisé la redirection : destination « $ISOLATED_DEST »"
fi

# (c) Et le témoin n'a toujours rien subi : [F] ne lit que.
if [ "$(witness_untouched)" = "0" ]; then
  pass "[F] le contrôle de nocivité n'a muté AUCUN rôle du témoin"
else
  fail "[F] le contrôle de nocivité a muté le témoin -- il devait être en lecture seule"
fi

# ============================================================
# [E] L'isolation est STRUCTURELLE, pas seulement documentée
# ============================================================
log "=== [E] isolation structurelle des appels clients ==="
SELF="${BASH_SOURCE[0]}"
# Tout appel aux binaires clients de ce fichier doit être précédé
# d'`env -i`. La vérification raisonne sur des COMMANDES, pas sur des
# lignes de texte : `env -i PATH=… \` suivi de `"$PSQL" …` est UNE seule
# commande, et un contrôle ligne par ligne la déclarerait faussement non
# isolée. On reconstitue donc les lignes logiques (continuations `\`
# recollées, lignes de commentaire pur écartées) avant d'exiger `env -i`.
LOGICAL="$TMP_DIR/logical-lines.txt"
awk '
  /^[[:space:]]*#/ { next }
  { line = line $0 }
  /\\[[:space:]]*$/ { sub(/\\[[:space:]]*$/, " ", line); next }
  { print line; line = "" }
' "$SELF" > "$LOGICAL"

# Les motifs sont CONSTRUITS à l'exécution : écrits en clair, ils
# apparaîtraient dans le fichier et le détecteur se signalerait lui-même.
DQ='"'
NEEDLE_PSQL="${DQ}\$PSQL${DQ}"
NEEDLE_PGCTL="${DQ}\$PG_CTL${DQ}"
NEEDLE_INITDB="${DQ}\$INITDB${DQ}"

BAD_CALLS=0
CHECKED_CALLS=0
while IFS= read -r line; do
  case "$line" in
    *"$NEEDLE_PSQL"*|*"$NEEDLE_PGCTL"*|*"$NEEDLE_INITDB"*) : ;;
    *) continue ;;
  esac
  # Les AFFECTATIONS résolvent le binaire, elles ne l'appellent pas.
  case "$line" in
    *resolve_bin*|SAFE_PATH=*|*'dirname '*) continue ;;
    # [F] comporte UN appel non isolé délibéré, en lecture seule, dont
    # le rôle est de prouver que la menace est réelle. Il est nommé pour
    # être reconnaissable, et il est le seul à l'être.
    *UNISOLATED_ON_PURPOSE*) continue ;;
  esac
  CHECKED_CALLS=$((CHECKED_CALLS + 1))
  case "$line" in
    *'env -i'*) : ;;
    *) BAD_CALLS=$((BAD_CALLS + 1)); log "   appel non isolé : $(printf '%s' "$line" | cut -c1-110)" ;;
  esac
done < "$LOGICAL"

# Un détecteur qui ne trouve AUCUN appel à vérifier passerait pour vert.
if [ "$CHECKED_CALLS" -ge 6 ]; then
  pass "[E] le détecteur d'isolation examine bien les appels clients ($CHECKED_CALLS commandes)"
else
  fail "[E] le détecteur d'isolation n'a examiné que $CHECKED_CALLS commande(s) : il ne prouve rien"
fi
# L'échappatoire de [F] ne doit pas devenir une porte : on exige qu'elle
# soit utilisée UNE SEULE FOIS, et pour un appel de LECTURE.
#
# Les lignes de ce bloc portent le marqueur SELF-REFERENCE et sont
# écartées du comptage : un détecteur qui se compte lui-même mesure son
# propre texte, pas le fichier. (Le marqueur écarte aussi la ligne qui
# l'applique, ce qui est correct : elle fait partie du détecteur.)
ON_PURPOSE_CALLS="$(grep 'PSQL_UNISOLATED_ON_PURPOSE" -X' "$SELF" | grep -vc 'SELF-REFERENCE')"  # SELF-REFERENCE
if [ "$ON_PURPOSE_CALLS" = "1" ]; then
  pass "[E] l'unique appel non isolé délibéré est bien unique"
else
  fail "[E] $ON_PURPOSE_CALLS appel(s) non isolé(s) délibéré(s) : l'exception de [F] est devenue une porte"
fi
# Et il est en LECTURE SEULE : on inspecte la requête réellement passée,
# pas le texte du fichier -- aucune auto-référence possible.
case "$DIAG" in
  select*)
    if printf '%s' "$DIAG" | grep -qiE 'alter|create|drop|insert|update|delete|grant|revoke'; then
      fail "[E] la requête de l'appel non isolé délibéré n'est pas une lecture : « $DIAG »"
    else
      pass "[E] l'appel non isolé délibéré ne passe qu'une requête de lecture"
    fi ;;
  *) fail "[E] la requête de l'appel non isolé délibéré n'est pas un SELECT : « $DIAG »" ;;
esac
if [ "$BAD_CALLS" = "0" ]; then
  pass "[E] tous les appels clients de ce fichier passent par env -i"
else
  fail "[E] $BAD_CALLS appel(s) client(s) héritent de l'environnement"
fi
if grep -q 'ROUTING_VARS=' "$SELF" && grep -q 'PGHOSTADDR' "$SELF"; then
  pass "[E] la liste des variables refusées nomme PGHOSTADDR"
else
  fail "[E] PGHOSTADDR n'est pas dans la liste des variables refusées"
fi
# Le prédicat doit être le PARTAGÉ, et non une copie locale : c'est
# l'existence de deux prédicats subtilement différents qui a produit le
# défaut, pas la faiblesse de l'un des deux.
if grep -q 'csdj1_identity_mutate' "$SELF" && grep -q 'csdj1-cluster-identity.sh' "$SELF"; then
  pass "[E] les mutations passent par le prédicat d'identité PARTAGÉ"
else
  fail "[E] ce fichier n'emploie pas le prédicat partagé : deux prédicats divergeraient de nouveau"
fi
if grep 'prove_destination' "$SELF" | grep -vq 'SELF-REFERENCE'; then   # SELF-REFERENCE
  fail "[E] un prédicat d'identité LOCAL subsiste à côté du partagé"
else
  pass "[E] aucun prédicat d'identité local ne subsiste"
fi
# AUCUNE mutation de rôle ne doit subsister hors de la garde.
#
# Le défaut relevé par le quatrième re-audit était exactement celui-là :
# l'initialisation des rôles du TÉMOIN passait par un appel brut, parce
# qu'un cluster « qui ne sert que de témoin » paraissait ne pas compter.
#
# La vérification raisonne par COMMANDE ENGLOBANTE. Une instruction de
# mutation vit presque toujours à l'intérieur d'un argument sur
# plusieurs lignes ; ce qui compte n'est donc pas sa ligne mais l'appel
# qui la porte. On suit l'ouvreur de commande le plus proche en amont,
# et on exige qu'il soit gardé.
MUT_REPORT="$TMP_DIR/role-mutations.txt"
# Le détecteur vit dans SON PROPRE FICHIER, et non dans celui qu'il
# analyse : un détecteur logé dans le fichier qu'il scrute se dénonce
# lui-même, et l'on finit par lui ajouter des exceptions -- lesquelles
# sont autant de trous. Il reconstitue les COMMANDES du shell
# (citations, commentaires, continuations, documents en ligne) au lieu
# de compter des guillemets ligne par ligne : trois audits ont trouvé
# trois façons de tromper ce comptage.
MUT_AWK="$SCRIPT_DIR/csdj1-raw-role-mutation-detector.awk"
[ -f "$MUT_AWK" ] || fatal "détecteur de mutations de rôle absent : $MUT_AWK"
awk -f "$MUT_AWK" "$SELF" "$HARNESS" > "$MUT_REPORT"

# ── FIXTURES DU DÉTECTEUR — il doit voir ce qu'il prétend voir, et ne
#    pas dénoncer ce qui est correct.
#
# Les verbes SQL sont ASSEMBLÉS, et non écrits en clair : écrits en
# clair, ils apparaîtraient dans CE fichier, que le détecteur analyse
# aussi. Une fixture ne doit pas devenir le défaut qu'elle éprouve.
DET_FIXT="$TMP_DIR/detector-fixtures"
mkdir -p "$DET_FIXT"
#
# Les verbes sont assemblés EN DEUX TEMPS, et non « crea""te role » d'un
# seul tenant : le détecteur de cette remédiation modélise la
# CONCATÉNATION des citations du shell, donc « crea""te role » lui est
# désormais un verbe adjacent -- et ce fichier serait son propre
# signalement. Deux variables, jamais adjacentes, ne le sont pas.
V_W_CREATE="crea""te"
V_W_ALTER="alt""er"
V_W_ALTER_MIXED="Alt""er"
V_W_ALTER_UPPER="ALT""ER"
V_W_ROLE="ro""le"
V_W_ROLE_MIXED="Ro""le"
V_W_ROLE_UPPER="RO""LE"
V_CREATE="$V_W_CREATE $V_W_ROLE"
V_ALTER="$V_W_ALTER $V_W_ROLE"
V_ALTER_MIXED="$V_W_ALTER_MIXED $V_W_ROLE_MIXED"
V_ALTER_UPPER="$V_W_ALTER_UPPER $V_W_ROLE_UPPER"
SQ="'"
DQ='"'
TAB="$(printf '\t')"
CR="$(printf '\r')"

# D1 .. D7 — acquis des tours précédents, rejoués en non-régression.
printf '#!/usr/bin/env bash\nq %s%s fixture bypassrls;%s\n' "$SQ" "$V_ALTER" "$SQ" > "$DET_FIXT/d1.sh"
printf '#!/usr/bin/env bash\nq %s%s fixture bypassrls;%s\n' "$DQ" "$V_ALTER" "$DQ" > "$DET_FIXT/d2.sh"
printf '#!/usr/bin/env bash\nq %s%s fixture BYPASSRLS;%s\n' "$SQ" "$V_ALTER_MIXED" "$SQ" > "$DET_FIXT/d3.sh"
{ printf '#!/usr/bin/env bash\n'
  printf 'csdj1_identity_mutate %sperform 1;%s\n' "$DQ" "$DQ"
  printf 'q %s%s fixture bypassrls;%s\n' "$SQ" "$V_ALTER" "$SQ"
} > "$DET_FIXT/d4.sh"
{ printf '#!/usr/bin/env bash\n'
  printf 'qw %sdo \\$\\$ begin\n' "$DQ"
  printf '      %s fixture login bypassrls;\n' "$V_CREATE"
  printf '    end \\$\\$;%s\n' "$DQ"
} > "$DET_FIXT/d5.sh"
{ printf '#!/usr/bin/env bash\n'
  printf 'csdj1_identity_mutate %s\n' "$DQ"
  printf '  %s fixture login;\n' "$V_CREATE"
  printf '%s\n' "$DQ"
} > "$DET_FIXT/d6.sh"
printf '#!/usr/bin/env bash\nq %sselect 1; drop table if exists x;%s\n' "$DQ" "$DQ" > "$DET_FIXT/d7.sh"

# R1 — LA REPRODUCTION DE L'AUDIT, mot pour mot. Une apostrophe dans un
#      COMMENTAIRE, puis une continuation par barre oblique inverse.
{ printf '#!/usr/bin/env bash\n'
  printf 'csdj1_identity_mutate %sperform 1;%s # l%sinitialisation est terminee\n' "$DQ" "$DQ" "$SQ"
  printf 'q \\\n'
  printf '%s%s fixture bypassrls;%s\n' "$SQ" "$V_ALTER" "$SQ"
} > "$DET_FIXT/r1.sh"
# R2 — commentaire contenant une APOSTROPHE.
{ printf '#!/usr/bin/env bash\n'
  printf 'csdj1_identity_mutate %sperform 1;%s # commentaire avec apostrophe %s\n' "$DQ" "$DQ" "$SQ"
  printf 'q %s%s fixture bypassrls;%s\n' "$SQ" "$V_ALTER" "$SQ"
} > "$DET_FIXT/r2.sh"
# R3 — commentaire contenant un GUILLEMET.
{ printf '#!/usr/bin/env bash\n'
  printf 'csdj1_identity_mutate %sperform 1;%s # commentaire avec guillemet %s\n' "$DQ" "$DQ" "$DQ"
  printf 'q %s%s fixture bypassrls;%s\n' "$SQ" "$V_ALTER" "$SQ"
} > "$DET_FIXT/r3.sh"
# R4 — commentaire contenant LES DEUX, et mutation en casse mixte.
{ printf '#!/usr/bin/env bash\n'
  printf 'csdj1_identity_mutate %sperform 1;%s # commentaire avec %s et %s\n' "$DQ" "$DQ" "$SQ" "$DQ"
  printf 'q %s%s fixture BYPASSRLS;%s\n' "$SQ" "$V_ALTER_MIXED" "$SQ"
} > "$DET_FIXT/r4.sh"
# R5 — un « # » À L'INTÉRIEUR de l'argument SQL n'est PAS un
#      commentaire : la mutation doit rester visible.
{ printf '#!/usr/bin/env bash\n'
  printf 'q %sselect %s%s#%s%s; %s fixture bypassrls;%s\n' \
    "$SQ" "$SQ" "$SQ" "$SQ" "$SQ" "$V_ALTER" "$SQ"
} > "$DET_FIXT/r5.sh"

# C1 .. C5 — continuations par barre oblique inverse.
{ printf '#!/usr/bin/env bash\nq \\\n'; printf '%s%s fixture bypassrls;%s\n' "$SQ" "$V_ALTER" "$SQ"; } > "$DET_FIXT/c1.sh"
{ printf '#!/usr/bin/env bash\nqw \\\n'; printf '%s%s fixture bypassrls;%s\n' "$DQ" "$V_ALTER" "$DQ"; } > "$DET_FIXT/c2.sh"
{ printf '#!/usr/bin/env bash\nq \\\n'; printf '%s%s fixture BYPASSRLS;%s\n' "$SQ" "$V_ALTER_MIXED" "$SQ"; } > "$DET_FIXT/c3.sh"
{ printf '#!/usr/bin/env bash\ncsdj1_identity_mutate \\\n'; printf '%s%s fixture bypassrls;%s\n' "$DQ" "$V_ALTER" "$DQ"; } > "$DET_FIXT/c4.sh"
{ printf '#!/usr/bin/env bash\nq \\\n'; printf '%sselect 1;%s\n' "$SQ" "$SQ"; } > "$DET_FIXT/c5.sh"

# ── E1 .. E10 — LA CLASSE visée par la huitième remédiation : les
#    blancs et les continuations À L'INTÉRIEUR de l'argument SQL.
#
# Ce ne sont pas dix orthographes à rattraper une à une : ce sont dix
# points d'une même équivalence. Bash retire « barre oblique inverse +
# saut de ligne » jusque DANS les guillemets doubles ; PostgreSQL lit
# l'espace, la tabulation, le retour chariot et le saut de ligne comme
# un seul et même blanc. Le détecteur normalise les deux, puis juge.
H='#!/usr/bin/env bash'
# E1 — la reproduction du huitième audit : continuation entre guillemets.
{ printf '%s\nq %s%s \\\n' "$H" "$DQ" "$V_W_ALTER"
  printf '%s fixture bypassrls;%s\n' "$V_W_ROLE" "$DQ"; } > "$DET_FIXT/e1.sh"
# E2 — la seconde reproduction : un simple saut de ligne.
{ printf '%s\nq %s%s\n' "$H" "$DQ" "$V_W_ALTER"
  printf '%s fixture bypassrls;%s\n' "$V_W_ROLE" "$DQ"; } > "$DET_FIXT/e2.sh"
# E3 — tabulation pour séparateur.
printf '%s\nq %s%s%s%s fixture bypassrls;%s\n' \
  "$H" "$DQ" "$V_W_ALTER" "$TAB" "$V_W_ROLE" "$DQ" > "$DET_FIXT/e3.sh"
# E4 — plusieurs espaces.
printf '%s\nq %s%s    %s fixture bypassrls;%s\n' \
  "$H" "$DQ" "$V_W_ALTER" "$V_W_ROLE" "$DQ" > "$DET_FIXT/e4.sh"
# E5 — L'ÉQUIVALENT GARDÉ de E1 : même forme, appel gardé. Sans ce
#      point, « tout classer NON-GARDEE » passerait pour une réussite.
{ printf '%s\ncsdj1_identity_mutate %s%s \\\n' "$H" "$DQ" "$V_W_ALTER"
  printf '%s fixture bypassrls;%s\n' "$V_W_ROLE" "$DQ"; } > "$DET_FIXT/e5.sh"
# E6 — la même mécanique SANS mutation : rien à signaler.
{ printf '%s\nq %sselect \\\n' "$H" "$DQ"; printf ' 1;%s\n' "$DQ"; } > "$DET_FIXT/e6.sh"
# E7 — CREATE ROLE coupé par une continuation.
{ printf '%s\nq %s%s \\\n' "$H" "$DQ" "$V_W_CREATE"
  printf '%s fixture login;%s\n' "$V_W_ROLE" "$DQ"; } > "$DET_FIXT/e7.sh"
# E8 — CREATE ROLE coupé par un saut de ligne, puis tabulation.
{ printf '%s\nqw %s%s\n' "$H" "$DQ" "$V_W_CREATE"
  printf '%s%sfixture login;%s\n' "$V_W_ROLE" "$TAB" "$DQ"; } > "$DET_FIXT/e8.sh"
# E9 — apostrophes, saut de ligne, MAJUSCULES.
{ printf '%s\nq %s%s\n' "$H" "$SQ" "$V_W_ALTER_UPPER"
  printf '%s fixture bypassrls;%s\n' "$V_W_ROLE_UPPER" "$SQ"; } > "$DET_FIXT/e9.sh"
# E10 — casse mixte, retour chariot PUIS saut de ligne.
{ printf '%s\nqw %s%s%s\n' "$H" "$DQ" "$V_W_ALTER_MIXED" "$CR"
  printf '%s fixture bypassrls;%s\n' "$V_W_ROLE_MIXED" "$DQ"; } > "$DET_FIXT/e10.sh"

# ── F1 .. F6 — formes COMBINÉES : là où deux règles se rencontrent.
# F1 — appel gardé, commentaire avec apostrophe, puis mutation brute
#      coupée par une continuation entre guillemets.
{ printf '%s\n' "$H"
  printf 'csdj1_identity_mutate %sperform 1;%s # l%setat est reinitialise\n' "$DQ" "$DQ" "$SQ"
  printf 'q %s%s \\\n' "$DQ" "$V_W_ALTER"
  printf '%s fixture bypassrls;%s\n' "$V_W_ROLE" "$DQ"; } > "$DET_FIXT/f1.sh"
# F2 — un COMMENTAIRE qui contient le verbe ne déclenche rien ; la
#      mutation brute qui le suit, elle, est vue.
{ printf '%s\n' "$H"
  printf '# ce commentaire parle de %s et ne doit rien declencher\n' "$V_ALTER"
  printf 'q %s%s%s%s fixture bypassrls;%s\n' "$DQ" "$V_W_ALTER" "$TAB" "$V_W_ROLE" "$DQ"; } > "$DET_FIXT/f2.sh"
# F3 — document en ligne : la mutation s'étend sur deux lignes du corps.
#      Un corps analysé ligne à ligne la manquerait.
{ printf '%s\n' "$H"
  printf 'q %sEOSQL\n' '<<'
  printf '  %s\n' "$V_W_ALTER"
  printf '  %s fixture bypassrls;\n' "$V_W_ROLE"
  printf 'EOSQL\n'; } > "$DET_FIXT/f3.sh"
# F4 — appel GARDÉ dont l'argument court sur trois lignes.
{ printf '%s\n' "$H"
  printf 'csdj1_identity_mutate %s%s \\\n' "$DQ" "$V_W_ALTER"
  printf '  %s \\\n' "$V_W_ROLE"
  printf '  fixture bypassrls;%s\n' "$DQ"; } > "$DET_FIXT/f4.sh"
# F5 — un « # » dans un littéral SQL reste du SQL, et la mutation qui
#      le suit, coupée par un saut de ligne, est vue.
{ printf '%s\nq %sselect %s#%s; %s\n' "$H" "$DQ" "$SQ" "$SQ" "$V_W_ALTER"
  printf '%s fixture bypassrls;%s\n' "$V_W_ROLE" "$DQ"; } > "$DET_FIXT/f5.sh"
# F6 — le verbe DANS un littéral de données n'est PAS exécutable.
printf '%s\nq %sselect %s%s%s;%s\n' \
  "$H" "$DQ" "$SQ" "$V_ALTER_UPPER" "$SQ" "$DQ" > "$DET_FIXT/f6.sh"

# ── P1 .. P3 — contrôles de FAUX POSITIF exigés par le mandat.
printf '%s\nq %sselect %s%s foo%s;%s\n' \
  "$H" "$DQ" "$SQ" "$V_ALTER_UPPER" "$SQ" "$DQ" > "$DET_FIXT/p1.sh"
printf '%s\nq %sselect 1; -- %s foo%s\n' \
  "$H" "$DQ" "$V_ALTER_UPPER" "$DQ" > "$DET_FIXT/p2.sh"
printf '%s\nq %sselect %s%s foo%s;%s\n' \
  "$H" "$DQ" "$SQ" "$(printf '%s %s' "$V_W_CREATE" "$V_W_ROLE" | tr 'a-z' 'A-Z')" "$SQ" "$DQ" > "$DET_FIXT/p3.sh"

# Chaque fixture est d'abord vérifiée SYNTAXIQUEMENT par bash : une
# fixture que le shell lui-même n'accepterait pas ne prouverait rien sur
# la « réalité lexicale de Bash » que le mandat invoque.
detector_fixture() {
  local fx="$1" want="$2" out
  if ! bash -n "$DET_FIXT/$fx.sh" 2>/dev/null; then
    fail "[E] fixture « $fx » : bash la refuse -- elle ne représente aucune réalité"
    return
  fi
  out="$(awk -f "$MUT_AWK" "$DET_FIXT/$fx.sh" | head -1 | cut -d"$(printf '\t')" -f1)"
  [ -n "$out" ] || out="AUCUNE"
  if [ "$out" = "$want" ]; then
    pass "[E] fixture « $fx » : $out (attendu)"
  else
    fail "[E] fixture « $fx » : $out au lieu de $want"
  fi
}

detector_fixture d1 NON-GARDEE
detector_fixture d2 NON-GARDEE
detector_fixture d3 NON-GARDEE
detector_fixture d4 NON-GARDEE
detector_fixture d5 NON-GARDEE
detector_fixture d6 GARDEE
detector_fixture d7 AUCUNE
detector_fixture r1 NON-GARDEE
detector_fixture r2 NON-GARDEE
detector_fixture r3 NON-GARDEE
detector_fixture r4 NON-GARDEE
detector_fixture r5 NON-GARDEE
detector_fixture c1 NON-GARDEE
detector_fixture c2 NON-GARDEE
detector_fixture c3 NON-GARDEE
detector_fixture c4 GARDEE
detector_fixture c5 AUCUNE
detector_fixture e1 NON-GARDEE
detector_fixture e2 NON-GARDEE
detector_fixture e3 NON-GARDEE
detector_fixture e4 NON-GARDEE
detector_fixture e5 GARDEE
detector_fixture e6 AUCUNE
detector_fixture e7 NON-GARDEE
detector_fixture e8 NON-GARDEE
detector_fixture e9 NON-GARDEE
detector_fixture e10 NON-GARDEE
detector_fixture f1 NON-GARDEE
detector_fixture f2 NON-GARDEE
detector_fixture f3 NON-GARDEE
detector_fixture f4 GARDEE
detector_fixture f5 NON-GARDEE
detector_fixture f6 AUCUNE
detector_fixture p1 AUCUNE
detector_fixture p2 AUCUNE
detector_fixture p3 AUCUNE

# R1 mérite un mot de plus : ce n'est pas seulement qu'elle est
# détectée, c'est qu'elle n'est plus ATTRIBUÉE à l'appel gardé qui la
# précède. Le détecteur du tour précédent la déclarait GARDÉE.
if awk -f "$MUT_AWK" "$DET_FIXT/r1.sh" | grep -q '^GARDEE'; then
  fail "[E] R1 — la mutation brute est encore attribuée à l'appel gardé précédent"
else
  pass "[E] R1 — l'apostrophe d'un COMMENTAIRE ne fait plus survivre l'état gardé"
fi

MUT_SEEN="$(wc -l < "$MUT_REPORT")"
MUT_BAD="$(grep -c '^NON-GARDEE' "$MUT_REPORT" || true)"
MUT_ORPHAN="$(grep -c '^SANS-OUVREUR' "$MUT_REPORT" || true)"
if [ "$MUT_SEEN" -ge 10 ]; then
  pass "[E] le détecteur de mutations de rôle examine bien les deux harnais ($MUT_SEEN instructions)"
else
  fail "[E] le détecteur n'a examiné que $MUT_SEEN instruction(s) de mutation : il ne prouve rien"
fi
if [ "$MUT_BAD" = "0" ] && [ "$MUT_ORPHAN" = "0" ]; then
  pass "[E] TOUTE mutation de rôle est portée par une commande gardée, témoin compris"
else
  fail "[E] $MUT_BAD mutation(s) hors garde, $MUT_ORPHAN sans commande identifiable"
  grep -E '^(NON-GARDEE|SANS-OUVREUR)' "$MUT_REPORT" | head -8 \
    | while IFS="$(printf '\t')" read -r k f l o; do
        log "   $k : $(printf '%s' "$l" | cut -c1-80) [porté par : $(printf '%s' "$o" | cut -c1-40)]"
      done
fi
# Les variables qui accumulent du SQL de mutation ne doivent être
# consommées QUE par une mutation gardée.
for v in RESTORE_SQL PROBE_MUTATION; do
  USES="$(grep -n "\$$v" "$SELF" "$HARNESS" 2>/dev/null \
            | grep -v "$v=" | grep -v 'SELF-REFERENCE' || true)"   # SELF-REFERENCE
  if [ -z "$USES" ]; then
    pass "[E] « $v » n'est consommée nulle part hors de sa construction"
  elif printf '%s\n' "$USES" | grep -qv 'csdj1_identity_mutate'; then
    fail "[E] « $v » est consommée hors d'une mutation gardée : $(printf '%s' "$USES" | head -1 | cut -c1-100)"
  else
    pass "[E] « $v » n'est consommée que par une mutation gardée"
  fi
done

# Le répertoire de socket se compare à l'ÉGALITÉ EXACTE, pas par
# sous-chaîne : c'est le second défaut du quatrième re-audit. On juge le
# code EXÉCUTABLE : un commentaire a le droit de nommer `strpos` pour
# dire précisément qu'on ne l'emploie plus.
LIB_EXEC="$TMP_DIR/identity-exec.sh"
sed 's/[[:space:]]*--.*$//; /^[[:space:]]*#/d' "$SCRIPT_DIR/csdj1-cluster-identity.sh" > "$LIB_EXEC"
# L'interdiction de `strpos` porte sur la COMPARAISON D'APPARTENANCE.
# La défense anti-collision l'emploie légitimement pour CHERCHER un
# octet réservé : y voir un défaut serait confondre « chercher un octet
# interdit » et « comparer un chemin par sous-chaîne ».
MATCH_EXPR_BODY="$(sed -n '/^csdj1_identity_socket_match_expr()/,/^}/p' "$LIB_EXEC")"
if printf '%s' "$MATCH_EXPR_BODY" | grep -q 'strpos'; then
  fail "[E] la comparaison d'appartenance emploie strpos : sémantique de sous-chaîne"
else
  pass "[E] la comparaison d'appartenance n'emploie pas strpos"
fi
STRPOS_TOTAL="$(grep -c 'strpos' "$LIB_EXEC" || true)"
STRPOS_RESERVED="$(sed -n '/^csdj1_identity_socket_reserved_expr()/,/^}/p' "$LIB_EXEC" | grep -c 'strpos' || true)"
if [ "$STRPOS_TOTAL" = "$STRPOS_RESERVED" ]; then
  pass "[E] les seuls emplois de strpos sont dans la défense anti-collision ($STRPOS_RESERVED)"
else
  fail "[E] $((STRPOS_TOTAL - STRPOS_RESERVED)) emploi(s) de strpos hors de la défense anti-collision"
fi
if grep -q 'csdj1_sock_norm where entry = ' "$LIB_EXEC"; then
  pass "[E] la liste de sockets est comparée à l'ÉGALITÉ d'une entrée analysée"
else
  fail "[E] la comparaison de socket n'est pas une égalité d'entrée complète"
fi
# Le découpage ne doit PAS être brut : couper à chaque virgule fabrique
# des fragments à partir d'une entrée citée (CSDJ1-AUD-07-SOCKET-CSV-01).
if grep -q "string_to_array(coalesce(pg_catalog.current_setting('unix_socket_directories'" "$LIB_EXEC"; then
  fail "[E] la liste de sockets est encore découpée BRUTALEMENT à chaque virgule"
else
  pass "[E] la liste de sockets n'est plus découpée brutalement à chaque virgule"
fi
if grep -q "replace(r.raw, '\"\"', pg_catalog.chr(1))" "$LIB_EXEC" \
   && grep -q 'outside_quotes' "$LIB_EXEC"; then
  pass "[E] le parseur est SENSIBLE AUX GUILLEMETS (doublés traités, virgules citées protégées)"
else
  fail "[E] le parseur n'est pas sensible aux guillemets"
fi
# UN SEUL parseur : la garde et la démonstration de nocivité doivent
# passer par la MÊME fonction d'émission.
PARSER_DEFS="$(grep -c '^csdj1_identity_socket_cte()' "$SCRIPT_DIR/csdj1-cluster-identity.sh")"
if [ "$PARSER_DEFS" = "1" ]; then
  pass "[E] le parseur de sockets est défini UNE SEULE FOIS"
else
  fail "[E] $PARSER_DEFS définition(s) du parseur de sockets : un second parseur divergerait"
fi
if grep -q 'csdj1_identity_socket_match_expr' "$SELF"; then
  pass "[E] la démonstration de nocivité emploie l'expression de la GARDE, pas une copie"
else
  fail "[E] la démonstration de nocivité emploie son propre prédicat"
fi

# Et le harnais PRINCIPAL emploie le même, pour le même motif.
if grep -q 'csdj1_identity_mutate' "$HARNESS" && grep -q 'csdj1-cluster-identity.sh' "$HARNESS"; then
  pass "[E] le harnais principal emploie le MÊME prédicat partagé"
else
  fail "[E] le harnais principal a son propre prédicat d'identité"
fi
# Les huit faits doivent tous figurer dans le prédicat partagé.
for ifact in destination_reseau port current_user is_superuser socket data_directory config_file marqueur_absent nonce; do
  if grep -q "SCANYM_IDENTITY_REFUS|$ifact" "$SCRIPT_DIR/csdj1-cluster-identity.sh"; then
    pass "[E] le prédicat partagé vérifie « $ifact »"
  else
    fail "[E] le prédicat partagé ne vérifie PAS « $ifact »"
  fi
done

# ============================================================
# [I] CONTRÔLE DE NOCIVITÉ DU DÉTECTEUR
#     CSDJ1-AUD-07-RAW-ROLE-DETECTOR-01
#
# Le détecteur du tour précédent déclarait GARDÉE la séquence de
# l'audit. Dire qu'il se trompait ne suffit pas : il faut montrer que ce
# qu'il couvrait d'un label rassurant MUTE RÉELLEMENT un rôle.
#
# On exécute donc la séquence, pour de vrai, sur le cluster jetable de
# ce fichier. La mutation vit dans un fichier GÉNÉRÉ -- verbe assemblé,
# comme les fixtures -- afin que ce fichier-ci n'en contienne jamais le
# texte : il serait sinon dénoncé, à juste titre, par le détecteur qui
# l'analyse.
#
# Le rôle témoin est posé et restauré par le chemin GARDÉ. Seule la
# mutation que l'on démontre nocive passe en brut.
# ============================================================
# Les sections [I] et [J] mutent des rôles DÉLIBÉRÉMENT, par des
# scripts engendrés qui portent leur propre connexion PRIVILÉGIÉE :
# c'est tout leur objet, démontrer que les formes en question sont de
# vraies mutations. La frontière d'exécution les DÉNONCE, et c'est une
# preuve de plus -- mais ces dénonciations-là sont attendues. Elles sont
# donc enregistrées À PART, pour que le bilan global de [K17] reste
# celui d'une exécution propre.
DEMO_BREACHES="$TMP_DIR/raw-breaches-demo.txt"
: > "$DEMO_BREACHES"
RAW_BREACHES_CLEAN="$RAW_BREACHES"
RAW_BREACHES="$DEMO_BREACHES"
RAW_ATTEMPTS_CLEAN="$RAW_ATTEMPTS"
RAW_ATTEMPTS="$TMP_DIR/raw-attempts-demo.txt"
: > "$RAW_ATTEMPTS"

log "=== [I] la séquence de l'audit mute-t-elle réellement un rôle ? ==="
R1_PROBE="scanym_csdj1_r1_probe"
csdj1_identity_use test || fatal "[I] contrat du cluster sous test indisponible."
csdj1_identity_mutate "
  if not exists (select 1 from pg_catalog.pg_roles where rolname='$R1_PROBE') then
    create role $R1_PROBE nologin nobypassrls;
  else
    alter role $R1_PROBE nologin nobypassrls;
  end if;
" || fatal "[I] impossible de poser le rôle témoin ($CSDJ1_ID_LAST)."

r1_probe_state() {
  q "select (case when rolbypassrls then 'BYPASSRLS' else 'NOBYPASSRLS' end)
     from pg_catalog.pg_roles where rolname = '$R1_PROBE';"
}
R1_BEFORE="$(r1_probe_state)"

R1_LIVE="$TMP_DIR/r1-live.sh"
{ printf '#!/usr/bin/env bash\n'
  # `q` est le VRAI client brut, celui que le harnais emploie. Écrit
  # sur UNE ligne : le détecteur d'isolation de [E] analyse ce
  # fichier-ci, et une ligne de `printf` portant « "$PSQL" » sans
  # « env -i » y passerait pour un appel client non isolé.
  printf 'q() { env -i PATH=%s HOME=%s "%s" -X -A -q -t -v ON_ERROR_STOP=1 -h %s -p %s -U %s -d postgres -c "$1" </dev/null 2>&1; }\n' \
    "$SAFE_PATH" "$SAFE_HOME" "$PSQL" "$SOCKET_DIR" "$PORT" "$OWNER"
  # Un appel gardé FACTICE, sans effet : seul son TEXTE compte ici,
  # puisque c'est lui que l'ancien détecteur prenait pour couverture.
  printf 'csdj1_identity_mutate() { :; }\n'
  printf 'csdj1_identity_mutate %sperform 1;%s # l%sinitialisation est terminee\n' "$DQ" "$DQ" "$SQ"
  printf 'q \\\n'
  printf '%s%s %s bypassrls;%s\n' "$SQ" "$V_ALTER" "$R1_PROBE" "$SQ"
} > "$R1_LIVE"

if ! bash -n "$R1_LIVE" 2>/dev/null; then
  fail "[I] la séquence générée n'est pas du shell valide : elle ne démontre rien"
else
  # La destination est ÉCRITE dans le fichier généré : rien ne transite
  # par l'environnement, et la séquence est exactement celle de l'audit.
  bash "$R1_LIVE" >/dev/null 2>&1
  R1_AFTER="$(r1_probe_state)"
  if [ "$R1_BEFORE" = "NOBYPASSRLS" ] && [ "$R1_AFTER" = "BYPASSRLS" ]; then
    pass "[I] NOCIF : la séquence de l'audit a RÉELLEMENT muté le rôle ($R1_BEFORE -> $R1_AFTER)"
  else
    fail "[I] la séquence n'a pas muté le rôle ($R1_BEFORE -> $R1_AFTER) : le cas ne démontre aucune nocivité"
  fi
  # Et le détecteur, lui, la voit.
  if awk -f "$MUT_AWK" "$R1_LIVE" | grep -q '^NON-GARDEE'; then
    pass "[I] et le détecteur la classe NON-GARDEE : le label correspond enfin au fait"
  else
    fail "[I] le détecteur ne classe pas NON-GARDEE une mutation qui vient de s'exécuter"
  fi
  # ET LA FRONTIÈRE D'EXÉCUTION, elle, l'a dénoncée sans lire une seule
  # ligne de SQL : l'empreinte du catalogue de rôles ne correspondait
  # plus. C'est la preuve que la nouvelle autorité ne dépend pas du
  # détecteur.
  if grep -q 'MUTATION-BRUTE' "$DEMO_BREACHES"; then
    pass "[I] et la FRONTIÈRE D'EXÉCUTION la dénonce (MUTATION-BRUTE) : l'empreinte du catalogue, pas le texte du SQL"
  else
    fail "[I] la frontière d'exécution n'a pas dénoncé une mutation qui vient de s'exécuter"
  fi
fi

# REMISE EN ACCORD DÉLIBÉRÉE. [I] vient de muter un rôle HORS GARDE :
# l'empreinte attendue est donc, à juste titre, en désaccord, et toute
# mutation gardée la REFUSERAIT désormais (« empreinte_desaccord »).
# C'est [I] qui a causé le désaccord, c'est [I] qui l'assume.
csdj1_identity_boundary_resync >/dev/null

# Remise en état par le chemin GARDÉ, puis suppression du rôle témoin.
csdj1_identity_mutate "  alter role $R1_PROBE nologin nobypassrls;" >/dev/null
csdj1_identity_mutate "  drop role if exists $R1_PROBE;" >/dev/null

# ============================================================
# [J] CONTRE-ÉPREUVE ADVERSARIALE DU DÉTECTEUR
#     CSDJ1-AUD-07-RAW-ROLE-DETECTOR-01 (huitième remédiation)
#
# Sept tours de suite, un audit a trouvé une orthographe que le
# détecteur ne voyait pas. Montrer qu'il voit E1 et E2 ne vaut donc
# rien : ce qu'il faut montrer, c'est qu'on a CHERCHÉ À LE TROMPER, et
# comment.
#
# On engendre donc une MATRICE de formes sémantiquement équivalentes --
# verbe, casse, séparateur, forme de citation, forme d'appel,
# commentaire -- et, pour chacune, on établit quatre faits :
#
#   1. bash l'accepte            (« bash -n »)
#   2. l'argument RÉELLEMENT transmis est relevé, en faisant jouer à
#      bash lui-même le rôle d'oracle : la forme est exécutée avec un
#      « q » factice qui n'imprime que son premier argument ;
#   3. PostgreSQL l'exécute, et le rôle sonde CHANGE pour de vrai --
#      c'est PostgreSQL, et non une expression régulière, qui dit que
#      la forme est bien un CREATE ROLE ou un ALTER ROLE ;
#   4. le détecteur la classe NON-GARDEE.
#
# Et symétriquement, des formes qui CONTIENNENT le verbe sans
# l'exécuter : elles ne doivent produire aucun signalement.
#
# Dans les fichiers engendrés, « q » ET « qw » visent le cluster
# JETABLE de ce fichier : la démonstration porte sur le verdict et sur
# l'acceptation par PostgreSQL, non sur la destination -- le témoin,
# lui, reste intact, comme [D] et [F] l'exigent.
# ============================================================
log "=== [J] contre-épreuve adversariale : a-t-on cherché à tromper le détecteur ? ==="
ADV="$TMP_DIR/adversarial"
mkdir -p "$ADV"
ADV_PROBE="scanym_csdj1_adv_probe"
ADV_LOG="$TMP_DIR/adversarial-cases.txt"
: > "$ADV_LOG"
csdj1_identity_use test || fatal "[J] contrat du cluster sous test indisponible."
csdj1_identity_mutate "
  if not exists (select 1 from pg_catalog.pg_roles where rolname='$ADV_PROBE') then
    create role $ADV_PROBE nologin nobypassrls;
  else
    alter role $ADV_PROBE nologin nobypassrls;
  end if;
" || fatal "[J] impossible de poser le rôle sonde ($CSDJ1_ID_LAST)."

adv_probe_state() {
  q "select (case when rolbypassrls then 'BYPASSRLS' else 'NOBYPASSRLS' end)
     from pg_catalog.pg_roles where rolname = '$ADV_PROBE';"
}
adv_role_exists() {
  q "select count(*) from pg_catalog.pg_roles where rolname = '$1';"
}
# L'en-tête d'un fichier EXÉCUTABLE : les deux enveloppes brutes, avec
# la destination ÉCRITE DEDANS. Une seule ligne par définition, pour la
# même raison qu'en [I] : le détecteur d'isolation analyse CE
# fichier-ci, pas celui qu'on engendre.
adv_header() {
  printf 'q() { env -i PATH=%s HOME=%s "%s" -X -A -q -t -v ON_ERROR_STOP=1 -h %s -p %s -U %s -d postgres -c "$1" </dev/null 2>&1; }\n' \
    "$SAFE_PATH" "$SAFE_HOME" "$PSQL" "$SOCKET_DIR" "$PORT" "$OWNER"
  printf 'qw() { q "$1"; }\n'
  printf 'csdj1_identity_mutate() { :; }\n'
}
# L'ARGUMENT, dans la forme voulue. C'est ici, et nulle part ailleurs,
# que vivent les équivalences : séparateur et forme de citation.
#   $1 citation : dq | sq | cat     $2 séparateur : sp|spn|tab|lf|crlf|bsl
#   $3 premier mot   $4 second mot   $5 fin de l'instruction
adv_arg() {
  local qk="$1" sk="$2" w1="$3" w2="$4" tail="$5" open body
  case "$qk" in
    dq)  open="$DQ"; body="$w1" ;;
    sq)  open="$SQ"; body="$w1" ;;
    cat) open="$DQ"; body="${w1:0:3}$DQ$DQ${w1:3}" ;;   # concaténation du shell
  esac
  case "$sk" in
    sp)   printf '%s%s %s %s%s'       "$open" "$body" "$w2" "$tail" "$open" ;;
    spn)  printf '%s%s    %s %s%s'    "$open" "$body" "$w2" "$tail" "$open" ;;
    tab)  printf '%s%s%s%s %s%s'      "$open" "$body" "$TAB" "$w2" "$tail" "$open" ;;
    lf)   printf '%s%s\n%s %s%s'      "$open" "$body" "$w2" "$tail" "$open" ;;
    crlf) printf '%s%s%s\n%s %s%s'    "$open" "$body" "$CR" "$w2" "$tail" "$open" ;;
    bsl)  printf '%s%s \\\n%s %s%s'   "$open" "$body" "$w2" "$tail" "$open" ;;
  esac
}
# Un cas : on écrit l'APPEL une seule fois, et on le réemploie pour les
# deux fichiers. Le fichier jugé par le détecteur et le fichier exécuté
# portent ainsi, par construction, le même texte d'appel.
adv_build() {
  local id="$1" call="$2" prefix="$3" arg="$4"
  { [ -n "$prefix" ] && printf '%s\n' "$prefix"
    printf '%s %s\n' "$call" "$arg"; } > "$ADV/call-$id.txt"
  { printf '#!/usr/bin/env bash\n'; cat "$ADV/call-$id.txt"; } > "$ADV/case-$id.sh"
  { printf '#!/usr/bin/env bash\n'; adv_header; cat "$ADV/call-$id.txt"; } > "$ADV/exec-$id.sh"
}
adv_verdict() {
  local out
  out="$(awk -f "$MUT_AWK" "$ADV/case-$1.sh" | head -1 | cut -d"$TAB" -f1)"
  [ -n "$out" ] || out="AUCUNE"
  printf '%s' "$out"
}
# L'argument réellement transmis : c'est BASH qui le dit.
adv_derive() {
  bash --norc --noprofile -c \
    'q() { printf "%s" "$1"; }; qw() { printf "%s" "$1"; }; csdj1_identity_mutate() { :; }; . "$1"' \
    _ "$ADV/case-$1.sh" 2>/dev/null
}

ADV_SEPS="sp spn tab lf crlf bsl"
ADV_QUOTES="dq sq cat"
ADV_MUT_OK=0
ADV_MUT_TOTAL=0
ADV_CASES=0
adv_case_n=0
for adv_verb in alter create; do
  for adv_q in $ADV_QUOTES; do
    for adv_s in $ADV_SEPS; do
      # Entre APOSTROPHES, « barre oblique inverse + saut de ligne »
      # n'est PAS une continuation : bash les transmet tels quels et
      # PostgreSQL refuse l'instruction. Ce n'est donc pas une mutation
      # équivalente, et ce cas est traité à part (X2).
      [ "$adv_q" = "sq" ] && [ "$adv_s" = "bsl" ] && continue
      adv_case_n=$((adv_case_n + 1))
      case $((adv_case_n % 3)) in
        0) adv_w1="$V_W_ALTER";       adv_w2="$V_W_ROLE";       adv_c1="$V_W_CREATE" ;;
        1) adv_w1="$V_W_ALTER_UPPER"; adv_w2="$V_W_ROLE_UPPER"; adv_c1="$(printf '%s' "$V_W_CREATE" | tr 'a-z' 'A-Z')" ;;
        2) adv_w1="$V_W_ALTER_MIXED"; adv_w2="$V_W_ROLE_MIXED";  adv_c1="$(printf '%s' "$V_W_CREATE" | sed 's/^./\U&/')" ;;
      esac
      if [ $((adv_case_n % 2)) -eq 0 ]; then adv_call="q"; else adv_call="qw"; fi
      # Un cas sur quatre est précédé d'un appel GARDÉ et d'un
      # commentaire contenant une apostrophe : la fuite d'état du
      # septième tour, rejouée dans chaque famille.
      adv_prefix=""
      if [ $((adv_case_n % 4)) -eq 0 ]; then
        adv_prefix="$(printf 'csdj1_identity_mutate %sperform 1;%s # l%setat est pose' "$DQ" "$DQ" "$SQ")"
      fi
      if [ "$adv_verb" = "alter" ]; then
        adv_id="m$adv_case_n"
        adv_build "$adv_id" "$adv_call" "$adv_prefix" \
          "$(adv_arg "$adv_q" "$adv_s" "$adv_w1" "$adv_w2" "$ADV_PROBE bypassrls;")"
        adv_expect_role="$ADV_PROBE"
        adv_mode="alter"
      else
        adv_id="c$adv_case_n"
        adv_expect_role="scanym_csdj1_adv_$adv_case_n"
        adv_build "$adv_id" "$adv_call" "$adv_prefix" \
          "$(adv_arg "$adv_q" "$adv_s" "$adv_c1" "$adv_w2" "$adv_expect_role nologin nobypassrls;")"
        adv_mode="create"
      fi

      ADV_MUT_TOTAL=$((ADV_MUT_TOTAL + 1))
      adv_why=""
      if ! bash -n "$ADV/case-$adv_id.sh" 2>/dev/null; then
        adv_why="bash refuse la forme"
      else
        adv_sql="$(adv_derive "$adv_id")"
        adv_verd="$(adv_verdict "$adv_id")"
        if [ "$adv_mode" = "alter" ]; then
          csdj1_identity_mutate "  alter role $ADV_PROBE nologin nobypassrls;" >/dev/null \
            || adv_why="remise à zéro du rôle sonde impossible"
          adv_before="$(adv_probe_state)"
          bash "$ADV/exec-$adv_id.sh" >/dev/null 2>&1
          adv_after="$(adv_probe_state)"
          # La forme vient de muter un rôle HORS GARDE : on assume le
          # désaccord qu'on a causé, sans quoi la mutation gardée
          # suivante refuserait (« empreinte_desaccord »).
          csdj1_identity_boundary_resync >/dev/null
          [ -n "$adv_why" ] || [ "$adv_before$adv_after" = "NOBYPASSRLSBYPASSRLS" ] \
            || adv_why="PostgreSQL ne l'a pas exécutée comme une mutation ($adv_before -> $adv_after)"
        else
          adv_before="$(adv_role_exists "$adv_expect_role")"
          bash "$ADV/exec-$adv_id.sh" >/dev/null 2>&1
          adv_after="$(adv_role_exists "$adv_expect_role")"
          csdj1_identity_boundary_resync >/dev/null
          [ -n "$adv_why" ] || [ "$adv_before$adv_after" = "01" ] \
            || adv_why="PostgreSQL n'a pas créé le rôle ($adv_before -> $adv_after)"
          csdj1_identity_mutate "  drop role if exists $adv_expect_role;" >/dev/null
        fi
        # L'ORDRE compte : l'exécution est éprouvée AVANT le verdict.
        # Un échec portant sur le verdict signifie donc que PostgreSQL,
        # lui, a bien muté -- c'est la paire qui discrimine.
        [ -n "$adv_why" ] || [ "$adv_verd" = "NON-GARDEE" ] \
          || adv_why="le détecteur rend $adv_verd alors que PostgreSQL a muté ($adv_before -> $adv_after)"
        printf '%-5s %-6s %-5s %-4s %-11s %s\n' \
          "$adv_id" "$adv_q" "$adv_s" "$adv_call" "$adv_verd" "$(printf '%s' "$adv_sql" | tr '\r\n\t' '   ')" >> "$ADV_LOG"
      fi
      if [ -z "$adv_why" ]; then
        ADV_MUT_OK=$((ADV_MUT_OK + 1))
      else
        fail "[J] cas « $adv_id » ($adv_q/$adv_s/$adv_call) : $adv_why"
      fi
    done
  done
done
csdj1_identity_mutate "  alter role $ADV_PROBE nologin nobypassrls;" >/dev/null

if [ "$ADV_MUT_TOTAL" -ge 20 ] && [ "$ADV_MUT_OK" = "$ADV_MUT_TOTAL" ]; then
  pass "[J] $ADV_MUT_TOTAL formes équivalentes engendrées : bash les accepte, PostgreSQL les exécute, le détecteur les voit toutes"
else
  fail "[J] $ADV_MUT_OK/$ADV_MUT_TOTAL formes seulement (il en faut au moins 20, toutes vues)"
fi

# ── Et le revers : des formes qui CONTIENNENT le verbe sans l'exécuter.
#    Un détecteur qui signale tout ne signale rien.
ADV_NEG_OK=0
ADV_NEG_TOTAL=0
adv_negative() {
  local id="$1" arg="$2"
  ADV_NEG_TOTAL=$((ADV_NEG_TOTAL + 1))
  adv_build "n$id" "q" "" "$arg"
  local verd sql before after why=""
  if ! bash -n "$ADV/case-n$id.sh" 2>/dev/null; then
    why="bash refuse la forme"
  else
    sql="$(adv_derive "n$id")"
    verd="$(adv_verdict "n$id")"
    # Le piège doit être PRÉSENT : une forme qui ne contient pas le
    # verbe ne contrôlerait aucun faux positif.
    printf '%s' "$sql" | tr -d ' \t\r\n' | tr 'A-Z' 'a-z' \
      | grep -q "$(printf '%s%s' "$V_W_ALTER" "$V_W_ROLE")\|$(printf '%s%s' "$V_W_CREATE" "$V_W_ROLE")" \
      || why="le piège est absent : cette forme ne contient pas le verbe"
    before="$(adv_probe_state)"
    bash "$ADV/exec-n$id.sh" >/dev/null 2>&1
    after="$(adv_probe_state)"
    [ -n "$why" ] || [ "$before" = "$after" ] || why="le rôle sonde a changé ($before -> $after)"
    [ -n "$why" ] || [ "$verd" = "AUCUNE" ] || why="le détecteur rend $verd"
    printf '%-5s %-6s %-5s %-4s %-11s %s\n' "n$id" "-" "-" "q" "$verd" \
      "$(printf '%s' "$sql" | tr '\r\n\t' '   ')" >> "$ADV_LOG"
  fi
  if [ -z "$why" ]; then ADV_NEG_OK=$((ADV_NEG_OK + 1))
  else fail "[J] non-mutation « n$id » : $why"; fi
}
adv_negative 1  "$(printf '%sselect %s%s foo%s;%s' "$DQ" "$SQ" "$V_ALTER_UPPER" "$SQ" "$DQ")"
adv_negative 2  "$(printf '%sselect 1; -- %s foo%s' "$DQ" "$V_ALTER_UPPER" "$DQ")"
adv_negative 3  "$(printf '%sselect %s%s foo%s;%s' "$DQ" "$SQ" "$(printf '%s %s' "$V_W_CREATE" "$V_W_ROLE" | tr 'a-z' 'A-Z')" "$SQ" "$DQ")"
adv_negative 4  "$(printf '%sselect %s%s foo%s;%s' "$DQ" "$SQ" "$V_ALTER" "$SQ" "$DQ")"
adv_negative 5  "$(printf '%sselect /* %s foo */ 1;%s' "$DQ" "$V_ALTER" "$DQ")"
adv_negative 6  "$(printf '%sselect %s%s%s || %sx%s;%s' "$DQ" "$SQ" "$V_ALTER_UPPER" "$SQ" "$SQ" "$SQ" "$DQ")"
adv_negative 7  "$(printf '%sselect %s%s\n foo%s;%s' "$DQ" "$SQ" "$V_ALTER" "$SQ" "$DQ")"
adv_negative 8  "$(printf '%sselect 1; -- %s%s%s foo%s' "$DQ" "$V_W_ALTER" "$TAB" "$V_W_ROLE" "$DQ")"
adv_negative 9  "$(printf '%sselect %s%s foo%s as x, %s%s bar%s as y;%s' \
                    "$DQ" "$SQ" "$V_ALTER" "$SQ" "$SQ" "$V_CREATE" "$SQ" "$DQ")"
adv_negative 10 "$(printf '%sselect 1 where %sx%s = %s%s%s;%s' "$DQ" "$SQ" "$SQ" "$SQ" "$V_ALTER_UPPER" "$SQ" "$DQ")"
adv_negative 11 "$(printf '%sselect %s%s%s::text;%s' "$DQ" "$SQ" "$V_ALTER_MIXED" "$SQ" "$DQ")"
adv_negative 12 "$(printf '%sselect %sdo not run: %s foo%s;%s' "$DQ" "$SQ" "$V_CREATE" "$SQ" "$DQ")"

if [ "$ADV_NEG_TOTAL" -ge 10 ] && [ "$ADV_NEG_OK" = "$ADV_NEG_TOTAL" ]; then
  pass "[J] $ADV_NEG_TOTAL formes contenant le verbe SANS l'exécuter : aucune n'est signalée, et le rôle sonde n'a pas bougé"
else
  fail "[J] $ADV_NEG_OK/$ADV_NEG_TOTAL non-mutations seulement (il en faut au moins 10)"
fi

# ── X1, X2 — les deux cas que le détecteur assume : il FERME.
# X1 : une AFFECTATION qui porte le verbe. Le détecteur modélise les
#      citations du shell, donc il voit le verbe ; il ne modélise pas
#      l'expansion des paramètres, donc il ne sait pas où ce texte sera
#      exécuté. Il ferme : SANS-OUVREUR.
adv_build "x1" "ADV_NOTE=" "" "$(printf '%s%s foo;%s' "$DQ" "$V_ALTER" "$DQ")"
X1_V="$(adv_verdict x1)"
if [ "$X1_V" = "SANS-OUVREUR" ]; then
  pass "[J] X1 — une affectation portant le verbe FERME ($X1_V) : l'expansion n'est pas modélisée, donc rien n'est présumé"
else
  fail "[J] X1 — une affectation portant le verbe rend $X1_V au lieu de SANS-OUVREUR"
fi
# X2 : entre APOSTROPHES, « \ » suivi d'un saut de ligne n'est pas une
#      continuation : PostgreSQL REFUSE l'instruction. Ce n'est donc pas
#      une mutation, et le détecteur ne la signale pas -- les deux
#      moitiés du fait sont vérifiées, pas seulement l'étiquette.
adv_build "x2" "q" "" "$(adv_arg sq bsl "$V_W_ALTER" "$V_W_ROLE" "$ADV_PROBE bypassrls;")"
X2_V="$(adv_verdict x2)"
X2_BEFORE="$(adv_probe_state)"
bash "$ADV/exec-x2.sh" >/dev/null 2>&1
X2_AFTER="$(adv_probe_state)"
if [ "$X2_BEFORE" = "$X2_AFTER" ] && [ "$X2_V" = "AUCUNE" ]; then
  pass "[J] X2 — « \\ » + saut de ligne entre apostrophes : PostgreSQL refuse, le rôle ne bouge pas, rien n'est signalé"
else
  fail "[J] X2 — verdict $X2_V, rôle $X2_BEFORE -> $X2_AFTER : l'un des deux faits ne tient pas"
fi

csdj1_identity_mutate "  alter role $ADV_PROBE nologin nobypassrls;" >/dev/null
csdj1_identity_mutate "  drop role if exists $ADV_PROBE;" >/dev/null

# ── ET LA FRONTIÈRE D'EXÉCUTION, sur les mêmes trente-quatre formes.
#
# Chaque forme a été exécutée pour de vrai par un script engendré qui
# porte sa propre connexion PRIVILÉGIÉE -- c'est ainsi qu'on établit
# qu'il s'agit bien de mutations. La lecture brute qui suit chaque
# exécution a demandé au serveur si l'empreinte du catalogue de rôles
# tenait encore. Trente-quatre fois, elle ne tenait plus.
ADV_DENOUNCED="$(grep -c 'MUTATION-BRUTE' "$DEMO_BREACHES" || true)"
if [ "$ADV_DENOUNCED" -ge "$ADV_MUT_TOTAL" ]; then
  pass "[J] et la FRONTIÈRE D'EXÉCUTION dénonce les $ADV_MUT_TOTAL formes ($ADV_DENOUNCED dénonciations) sans lire une ligne de SQL"
else
  fail "[J] la frontière d'exécution n'a dénoncé que $ADV_DENOUNCED des $ADV_MUT_TOTAL mutations réellement appliquées"
fi
RAW_BREACHES="$RAW_BREACHES_CLEAN"
RAW_ATTEMPTS="$RAW_ATTEMPTS_CLEAN"
# La matrice est RECOPIÉE dans la sortie du harnais : le répertoire
# temporaire disparaît au nettoyage, et le mandat demande que le
# résumé des cas engendrés figure dans les preuves.
log "--- [J] matrice adversariale : cas | citation | separateur | appel | verdict | SQL transmis"
while IFS= read -r adv_line; do log "    $adv_line"; done < "$ADV_LOG"

# ============================================================
# [K] LA FRONTIÈRE DE MUTATION IMPOSÉE À L'EXÉCUTION
#     CSDJ1-AUD-07-RUNTIME-ROLE-BOUNDARY-01
#
# Huit tours, huit orthographes. Les sections [E], [I] et [J]
# établissaient la preuve en LISANT le texte source ; elles restent, en
# non-régression, mais elles ne sont plus l'autorité. L'autorité, ici,
# c'est PostgreSQL.
#
# Ce que cette section établit, pour chaque forme :
#   - par le chemin BRUT : la mutation est REFUSÉE AVANT d'être
#     appliquée, le refus est NOMMÉ, et le rôle sonde n'a PAS bougé ;
#   - par le chemin GARDÉ : la MÊME forme est autorisée, et le rôle
#     change RÉELLEMENT. Sans cette moitié, « tout refuser » passerait
#     pour une réussite.
#
# Aucune de ces deux moitiés ne regarde le texte du SQL.
# ============================================================
log "=== [K] la frontière d'exécution : le serveur refuse-t-il la mutation brute ? ==="
K_PROBE="scanym_csdj1_k_probe"
csdj1_identity_use test || fatal "[K] contrat du cluster sous test indisponible."
csdj1_identity_mutate "
  if not exists (select 1 from pg_catalog.pg_roles where rolname='$K_PROBE') then
    ${V_W_CREATE} ${V_W_ROLE} $K_PROBE nologin nobypassrls;
  else
    ${V_W_ALTER} ${V_W_ROLE} $K_PROBE nologin nobypassrls;
  end if;
" || fatal "[K] impossible de poser le rôle sonde ($CSDJ1_ID_LAST)."

k_probe_state() {
  q "select (case when rolbypassrls then 'BYPASSRLS' else 'NOBYPASSRLS' end)
     from pg_catalog.pg_roles where rolname = '$K_PROBE';"
}
k_reset_probe() {
  csdj1_identity_use test >/dev/null
  csdj1_identity_mutate "  ${V_W_ALTER} ${V_W_ROLE} $K_PROBE nologin nobypassrls;" >/dev/null
}

# UNE tentative par le chemin brut. Trois faits exigés, et le troisième
# est celui qui compte : le rôle n'a pas changé.
k_raw_blocked() {
  local label="$1" sql="$2" before after rb ra
  k_reset_probe
  before="$(k_probe_state)"
  rb="$(wc -l < "$RAW_REFUSALS")"
  q "$sql" >/dev/null 2>&1
  after="$(k_probe_state)"
  ra="$(wc -l < "$RAW_REFUSALS")"
  if [ "$before" = "NOBYPASSRLS" ] && [ "$after" = "NOBYPASSRLS" ] && [ "$ra" -gt "$rb" ]; then
    pass "[K] $label — BLOQUÉE AVANT MUTATION : le serveur a refusé, le rôle n'a pas bougé ($after)"
  else
    fail "[K] $label — rôle $before -> $after, refus nommés : $((ra - rb)) (une mutation brute a pu passer)"
  fi
}

# La MÊME forme, par le chemin gardé : elle doit être AUTORISÉE, et
# muter pour de vrai. Le corps est celui d'un bloc DO, puisque c'est
# ainsi que la garde exécute.
k_guarded_allowed() {
  local label="$1" body="$2" before after
  k_reset_probe
  before="$(k_probe_state)"
  csdj1_identity_use test >/dev/null
  csdj1_identity_mutate "$body" >/dev/null
  after="$(k_probe_state)"
  if [ "$before" = "NOBYPASSRLS" ] && [ "$after" = "BYPASSRLS" ]; then
    pass "[K] $label — AUTORISÉE par le chemin gardé, et le rôle change réellement ($before -> $after)"
  else
    fail "[K] $label — le chemin gardé n'a pas muté le rôle ($before -> $after) : la frontière refuse tout, elle ne distingue rien"
  fi
}

# ── K1/K2 — les deux chemins sont DISJOINTS, et c'est le serveur qui le dit.
K_RAW_IDENT="$(q "select current_user || ':' || (select rolsuper::text || rolcreaterole::text
                  from pg_catalog.pg_roles where rolname = current_user);")"
if [ "$K_RAW_IDENT" = "$RAW_ROLE:falsefalse" ]; then
  pass "[K1] le chemin brut est « $RAW_ROLE », NOSUPERUSER et NOCREATEROLE (lu sur le serveur)"
else
  fail "[K1] le chemin brut se présente comme « $K_RAW_IDENT » : la frontière n'est pas celle qu'on croit"
fi
if [ "$RAW_ROLE" != "$OWNER" ] && [ "$CSDJ1_ID_USER" = "$OWNER" ] \
   && grep -q "SCANYM_IDENTITY_REFUS|is_superuser" "$IDENTITY_LIB"; then
  pass "[K2] le chemin gardé exige « is_superuser » et emploie « $OWNER » : les deux chemins ne se recouvrent pas"
else
  fail "[K2] les deux chemins ne sont pas démontrablement disjoints"
fi

# ── K3/K4 — REPRODUCTION 1 DU MANDAT : commentaire entre les mots-clés,
#    dans un bloc DO.
K_DO1="do \$\$ begin ${V_W_ALTER}/* commentaire */${V_W_ROLE} $K_PROBE bypassrls; end \$\$;"
k_raw_blocked  "K3 reproduction 1 (DO \$\$ + commentaire entre les mots-clés)" "$K_DO1"
k_guarded_allowed "K4 reproduction 1 gardée" "  ${V_W_ALTER}/* commentaire */${V_W_ROLE} $K_PROBE bypassrls;"

# ── K5/K6 — REPRODUCTION 2 DU MANDAT : littéral E'...' avec apostrophe
#    échappée, puis la mutation, dans la même instruction.
K_E2="select E'it\\'s'; ${V_W_ALTER} ${V_W_ROLE} $K_PROBE bypassrls;"
k_raw_blocked  "K5 reproduction 2 (E'...' échappé + mutation)" "$K_E2"
k_guarded_allowed "K6 reproduction 2 gardée" "  perform (select E'it\\'s'); ${V_W_ALTER} ${V_W_ROLE} $K_PROBE bypassrls;"

# ── K7..K12 — LA CLASSE, et non deux exemples. Chaque forme est une
#    orthographe différente de la même mutation ; la frontière ne les
#    distingue pas, parce qu'elle ne les lit pas.
k_raw_blocked "K7 commentaire de fin de ligne entre les mots-clés" \
  "${V_W_ALTER} -- commentaire
${V_W_ROLE} $K_PROBE bypassrls;"
k_raw_blocked "K8 casse mixte" \
  "${V_W_ALTER_MIXED} ${V_W_ROLE_MIXED} $K_PROBE bypassrls;"
k_raw_blocked "K9 tabulation et sauts de ligne" \
  "$(printf '%s\t\n\n%s %s bypassrls;' "$V_W_ALTER" "$V_W_ROLE" "$K_PROBE")"
k_raw_blocked "K10 corps à dollars étiqueté" \
  "do \$tag\$ begin ${V_W_ALTER} ${V_W_ROLE} $K_PROBE bypassrls; end \$tag\$;"
k_raw_blocked "K11 EXECUTE d'un littéral assemblé" \
  "do \$\$ begin execute '${V_W_ALTER}' || ' ' || '${V_W_ROLE} $K_PROBE bypassrls'; end \$\$;"
# K12 — CONTINUATION DU SHELL dans un argument entre guillemets : la
# forme même du huitième audit (E1), portée cette fois à la frontière
# d'exécution. Bash retire la barre oblique inverse et le saut de ligne.
k_raw_blocked "K12 continuation du shell dans un argument cité" \
  "${V_W_ALTER} \
${V_W_ROLE} $K_PROBE bypassrls;"

# ── K13 — CONTRÔLE POSITIF. Une frontière qui casse le harnais ne
#    prouverait rien : le chemin brut doit continuer à LIRE.
if [ "$(q "select 42;")" = "42" ] && [ "$(k_probe_state)" = "NOBYPASSRLS" ]; then
  pass "[K13] CONTRÔLE POSITIF — le chemin brut lit toujours : la frontière n'a pas rendu le harnais inutilisable"
else
  fail "[K13] le chemin brut ne peut plus lire : la frontière est trop large"
fi

# ── K14 — la frontière ne fait pas que REFUSER : elle DÉTECTE.
#
# On mute par le niveau INFÉRIEUR -- « run_guarded », qui prouve
# l'identité mais ne rafraîchit pas l'empreinte. Du point de vue de la
# frontière, c'est exactement une mutation non autorisée. La première
# exécution brute qui suit doit la DÉNONCER.
#
# La brèche délibérée est enregistrée dans un fichier À PART : le bilan
# global de K15 doit rester celui d'une exécution propre.
K_BREACH_SAVE="$RAW_BREACHES"
K_ATT_SAVE="$RAW_ATTEMPTS"
RAW_BREACHES="$TMP_DIR/raw-breaches-k14.txt"
RAW_ATTEMPTS="$TMP_DIR/raw-attempts-k14.txt"
: > "$RAW_BREACHES"; : > "$RAW_ATTEMPTS"
k_reset_probe
csdj1_identity_use test >/dev/null
csdj1_identity_run_guarded "$(csdj1_identity_guard_sql)
$(csdj1_identity_marker_sql)" "  ${V_W_ALTER} ${V_W_ROLE} $K_PROBE bypassrls;" >/dev/null
K14_STATE="$(k_probe_state)"
if [ "$K14_STATE" = "BYPASSRLS" ] && grep -q 'MUTATION-BRUTE' "$RAW_BREACHES"; then
  pass "[K14] la frontière DÉTECTE : une mutation appliquée sans rafraîchir l'empreinte est dénoncée (MUTATION-BRUTE) par la première exécution brute"
else
  fail "[K14] état $K14_STATE, dénonciations : $(wc -l < "$RAW_BREACHES") -- l'empreinte ne discrimine pas"
fi
RAW_BREACHES="$K_BREACH_SAVE"
RAW_ATTEMPTS="$K_ATT_SAVE"
# K14 a muté par le niveau inférieur : le désaccord est voulu, et c'est
# la remise en accord DÉLIBÉRÉE qui le lève -- pas une mutation gardée
# ordinaire, qui refuserait.
csdj1_identity_boundary_resync >/dev/null
k_reset_probe
if [ "$(k_probe_state)" = "NOBYPASSRLS" ] && [ "$(q "select public.$BND_CHECK_TEST();")" = "OK" ]; then
  pass "[K14] et le chemin gardé la REMET en accord : l'empreinte redevient OK"
else
  fail "[K14] l'empreinte ne revient pas en accord après une mutation gardée"
fi

# ── K15 — MOINDRE PRIVILÈGE. Le chemin brut apprend le VERDICT, il ne
#    peut ni lire l'empreinte, ni la réécrire, ni calculer le condensé.
K15_OK=1
q "select count(*) from public.$BND_TABLE_TEST;" >/dev/null 2>&1
grep -qi 'permission denied' "$RAW_ERR" || K15_OK=0
q "insert into public.$BND_TABLE_TEST values ('forge');" >/dev/null 2>&1
grep -qi 'permission denied' "$RAW_ERR" || K15_OK=0
q "select public.$BND_DIGEST_TEST();" >/dev/null 2>&1
grep -qi 'permission denied' "$RAW_ERR" || K15_OK=0
if [ "$K15_OK" = "1" ]; then
  pass "[K15] MOINDRE PRIVILÈGE — le chemin brut ne peut ni lire, ni réécrire, ni recalculer l'empreinte : il n'en obtient que le verdict"
else
  fail "[K15] le chemin brut atteint l'empreinte elle-même : il pourrait la forger"
fi

# ── K16 — l'enveloppe d'AMORÇAGE n'est pas un chemin de mutation : elle
#    ne prend pas du SQL, elle prend un NOM DE RÉGLAGE.
if csdj1_bootstrap_setting test "${V_W_ALTER} ${V_W_ROLE} $K_PROBE bypassrls" >/dev/null 2>&1; then
  fail "[K16] l'enveloppe d'amorçage accepte autre chose qu'un nom de réglage"
else
  pass "[K16] l'enveloppe d'amorçage REFUSE tout ce qui n'est pas « data_directory » ou « config_file »"
fi
K16_USES="$(grep -c 'csdj1_bootstrap_setting [a-z]* [a-z_]*)' "$SELF")"
if [ "$K16_USES" = "4" ]; then
  pass "[K16] et elle n'est employée que 4 fois : data_directory et config_file, sur les deux clusters"
else
  fail "[K16] l'enveloppe d'amorçage est employée $K16_USES fois au lieu de 4"
fi

# ── K17 — LE BILAN DE L'EXÉCUTION ENTIÈRE. Chaque exécution brute de ce
#    fichier, depuis l'armement, a rendu un verdict de frontière.
K_ATT="$(wc -l < "$RAW_ATTEMPTS")"
K_VERDICTS="$(cut -f2 "$RAW_ATTEMPTS" | sort -u | tr '\n' ',' | sed 's/,$//')"
K_BRE="$(wc -l < "$RAW_BREACHES")"
if [ "$K_ATT" -ge 50 ] && [ "$K_VERDICTS" = "OK" ] && [ "$K_BRE" = "0" ]; then
  pass "[K17] $K_ATT exécutions brutes, TOUTES avec le verdict « OK », zéro brèche sur l'exécution entière"
else
  fail "[K17] $K_ATT exécutions brutes, verdicts « $K_VERDICTS », $K_BRE brèche(s)"
fi
K_REF="$(wc -l < "$RAW_REFUSALS")"
if [ "$K_REF" -ge 9 ]; then
  pass "[K17] et $K_REF refus de privilège NOMMÉS : la frontière a réellement été éprouvée"
else
  fail "[K17] seulement $K_REF refus nommés : les tentatives n'ont pas atteint le serveur"
fi

csdj1_identity_use test >/dev/null
csdj1_identity_mutate "  drop role if exists $K_PROBE;" >/dev/null

# ============================================================
# [L] L'EMPREINTE DISTINGUE L'IDENTITÉ DE LA BASE
#     CSDJ1-AUD-07-RUNTIME-ROLE-BOUNDARY-02, défaut F1
#
# Le micro-audit d'exécution a trouvé ceci : l'empreinte condensait le
# TEXTE des réglages par rôle, sans l'identité de la BASE. Deux
# instructions que PostgreSQL accepte, et que le rôle brut peut exécuter
# SUR LUI-MÊME sans aucun privilège,
#
#     alter role <brut> in database db1 reset work_mem;
#     alter role <brut> in database db2 set   work_mem='1MB';
#
# déplaçaient donc un réglage d'une base à l'autre SANS CHANGER
# l'empreinte. Le verdict restait « OK ». C'était une mutation d'état de
# rôle SILENCIEUSE.
#
# Deux bases suffisent à l'éprouver, et le cluster en a deux dès
# « initdb » : « postgres » et « template1 ». Aucune base n'est créée --
# CREATE DATABASE n'est pas transactionnel, et le chemin gardé est une
# transaction.
# ============================================================
log "=== [L] l'empreinte distingue-t-elle la BASE d'un réglage de rôle ? ==="
L_DB_A="postgres"
L_DB_B="template1"
l_digest()  { csdj1_runner_test "select public.$BND_DIGEST_TEST();" | tail -1 | tr -d ' '; }
l_verdict() { q "select public.$BND_CHECK_TEST();"; }
l_clear() {
  # Remise à zéro de TOUS les réglages éprouvés, par le chemin gardé --
  # qui rafraîchit l'empreinte, de sorte que chaque mesure part d'un
  # état en accord.
  csdj1_identity_use test >/dev/null
  csdj1_identity_mutate "
  ${V_W_ALTER} ${V_W_ROLE} $RAW_ROLE reset all;
  ${V_W_ALTER} ${V_W_ROLE} $RAW_ROLE in database $L_DB_A reset all;
  ${V_W_ALTER} ${V_W_ROLE} $RAW_ROLE in database $L_DB_B reset all;
  alter database $L_DB_A reset work_mem;
" >/dev/null
}

l_clear
L_D0="$(l_digest)"
if [ "$(l_verdict)" = "OK" ]; then
  pass "[L0] point de départ : empreinte en accord"
else
  fail "[L0] l'empreinte n'est pas en accord au départ : la suite ne prouverait rien"
fi

# ── L1 — le réglage posé dans la PREMIÈRE base change l'empreinte, et
#    la mutation brute est DÉNONCÉE.
q "${V_W_ALTER} ${V_W_ROLE} $RAW_ROLE in database $L_DB_A set work_mem='1MB';" >/dev/null 2>&1
L_D1="$(l_digest)"
L_V1="$(l_verdict)"
if [ "$L_D1" != "$L_D0" ] && [ "$L_V1" = "MUTATION-BRUTE" ]; then
  pass "[L1] un réglage par rôle ET par base change l'empreinte, et il est DÉNONCÉ ($L_V1)"
else
  fail "[L1] empreinte ${L_D0:0:8} -> ${L_D1:0:8}, verdict $L_V1"
fi

# ── L2 — LA RÉSYNCHRONISATION GARDÉE remet en accord. C'est la seule
#    façon légitime, et elle est bruyamment nommée.
csdj1_identity_boundary_resync >/dev/null
if [ "$(l_verdict)" = "OK" ]; then
  pass "[L2] la resynchronisation GARDÉE remet l'empreinte en accord (OK)"
else
  fail "[L2] la resynchronisation gardée ne remet pas l'empreinte en accord"
fi

# ── L3 — LA REPRODUCTION DU MANDAT : le MÊME réglage, le MÊME rôle,
#    déplacé de la première base à la seconde. Le texte du réglage est
#    IDENTIQUE ; seule la base change.
q "${V_W_ALTER} ${V_W_ROLE} $RAW_ROLE in database $L_DB_A reset work_mem;
${V_W_ALTER} ${V_W_ROLE} $RAW_ROLE in database $L_DB_B set work_mem='1MB';" >/dev/null 2>&1
L_D2="$(l_digest)"
L_V2="$(l_verdict)"
L_ROWS="$(csdj1_runner_test "select coalesce(pg_catalog.string_agg(coalesce(d.datname,'*') || '=' || pg_catalog.array_to_string(s.setconfig, ','), ' '), 'aucun')
  from pg_catalog.pg_db_role_setting s
  left join pg_catalog.pg_database d on d.oid = s.setdatabase
  left join pg_catalog.pg_authid r on r.oid = s.setrole
  where r.rolname = '$RAW_ROLE';" | tail -1)"
if [ "$L_D2" != "$L_D1" ] && [ "$L_V2" = "MUTATION-BRUTE" ]; then
  pass "[L3] REPRODUCTION F1 : le même réglage déplacé de « $L_DB_A » à « $L_DB_B » change l'empreinte et est DÉNONCÉ ($L_V2 ; état : $L_ROWS)"
else
  fail "[L3] empreinte ${L_D1:0:8} -> ${L_D2:0:8}, verdict $L_V2 (état : $L_ROWS) -- la mutation est SILENCIEUSE"
fi
csdj1_identity_boundary_resync >/dev/null

# ── L4 — QUATRE FORMES, QUATRE EMPREINTES. base+rôle, base+rôle (autre
#    base), rôle pour TOUTES les bases, base pour TOUS les rôles : aucune
#    paire ne doit se confondre.
l_measure() {
  local label="$1" sql="$2"
  l_clear
  csdj1_identity_use test >/dev/null
  csdj1_identity_mutate "$sql" >/dev/null || { fail "[L4] mise en place « $label » refusée ($CSDJ1_ID_LAST)"; printf 'KO'; return; }
  l_digest
}
L_A="$(l_measure "rôle dans $L_DB_A"  "  ${V_W_ALTER} ${V_W_ROLE} $RAW_ROLE in database $L_DB_A set work_mem='1MB';")"
L_B="$(l_measure "rôle dans $L_DB_B"  "  ${V_W_ALTER} ${V_W_ROLE} $RAW_ROLE in database $L_DB_B set work_mem='1MB';")"
L_C="$(l_measure "rôle, toutes bases" "  ${V_W_ALTER} ${V_W_ROLE} $RAW_ROLE set work_mem='1MB';")"
L_D="$(l_measure "base, tous rôles"   "  alter database $L_DB_A set work_mem='1MB';")"
L_DISTINCT="$(printf '%s\n%s\n%s\n%s\n' "$L_A" "$L_B" "$L_C" "$L_D" | sort -u | grep -c .)"
if [ "$L_DISTINCT" = "4" ]; then
  pass "[L4] les quatre formes rendent QUATRE empreintes distinctes : rôle+base, rôle+autre base, rôle toutes bases, base tous rôles"
else
  fail "[L4] seulement $L_DISTINCT empreinte(s) distincte(s) sur 4 : ${L_A:0:8} ${L_B:0:8} ${L_C:0:8} ${L_D:0:8}"
fi

# ── L5 — DÉTERMINISME. À état constant, le condensé ne bouge pas.
L_R1="$(l_digest)"; L_R2="$(l_digest)"; L_R3="$(l_digest)"
if [ "$L_R1" = "$L_R2" ] && [ "$L_R2" = "$L_R3" ] && [ -n "$L_R1" ]; then
  pass "[L5] le condensé est DÉTERMINISTE : trois lectures d'un état constant rendent la même empreinte"
else
  fail "[L5] le condensé varie à état constant : ${L_R1:0:8} ${L_R2:0:8} ${L_R3:0:8}"
fi
l_clear
if [ "$(l_verdict)" = "OK" ] && [ "$(l_digest)" = "$L_D0" ]; then
  pass "[L5] et l'état initial est EXACTEMENT retrouvé après les quatre formes"
else
  fail "[L5] l'état initial n'est pas retrouvé : la section a laissé des traces"
fi

# ============================================================
# [M] LE CHEMIN BRUT N'ACCEPTE QUE DU SQL
#     CSDJ1-AUD-07-RUNTIME-ROLE-BOUNDARY-02, défaut F2
#
# Le micro-audit a montré que « psql -c » n'est pas un canal SQL mais un
# canal CLIENT : une chaîne qui COMMENCE par une commande à barre
# oblique inverse est interprétée par psql, et « \! » exécute le shell.
# L'auditeur a démontré un chemin complet : le shell se reconnecte avec
# le compte propriétaire, mute un rôle, rafraîchit l'empreinte attendue,
# et laisse le verdict final à « OK ».
#
# La correction est un CONTRAT D'INVOCATION, et non une liste noire :
# l'enveloppe fait commencer la chaîne par une instruction SQL fixe, de
# sorte que psql ne puisse JAMAIS y voir une commande client. Toute
# barre oblique inverse qui suit n'est plus qu'une erreur de syntaxe
# SQL -- côté SERVEUR. Le contrat vaut pour toute commande psql, connue
# ou non, par CONSTRUCTION : rien n'est lu, rien n'est énuméré.
# ============================================================
log "=== [M] le chemin brut n'accepte-t-il que du SQL ? ==="
M_WIT="$TMP_DIR/f2-witness"
mkdir -p "$M_WIT"
m_side_effects() { find "$M_WIT" -mindepth 1 | grep -c . || true; }

# ── M1..M5 — LE SQL ORDINAIRE PASSE TOUJOURS. Une protection qui casse
#    le chemin brut ne protège rien.
[ "$(q "select 42;")" = "42" ] \
  && pass "[M1] SQL ordinaire : « select 42 » rend 42" \
  || fail "[M1] le SQL ordinaire ne passe plus"
[ "$(qw "select 7;")" = "7" ] \
  && pass "[M1] et sur le témoin : « select 7 » rend 7" \
  || fail "[M1] le SQL ordinaire ne passe plus sur le témoin"
[ "$(q "do \$\$ begin perform 1; end \$\$; select 'bloc-do';")" = "bloc-do" ] \
  && pass "[M2] un bloc DO passe toujours" \
  || fail "[M2] un bloc DO ne passe plus"
[ "$(q "select \$tag\$corps-a-dollars\$tag\$;")" = "corps-a-dollars" ] \
  && pass "[M3] un corps à dollars étiqueté passe toujours" \
  || fail "[M3] un corps à dollars ne passe plus"
[ "$(q "do \$\$ begin execute 'select 1'; end \$\$; select 'execute-dynamique';")" = "execute-dynamique" ] \
  && pass "[M4] l'EXECUTE dynamique passe toujours" \
  || fail "[M4] l'EXECUTE dynamique ne passe plus"
M_BS="$(q "select 'a\b';")"
M_ES="$(q "select E'it\\'s';")"
M_DS="$(q "select \$bs\$c:\\chemin\$bs\$;")"
if [ "$M_BS" = 'a\b' ] && [ "$M_ES" = "it's" ] && [ "$M_DS" = 'c:\chemin' ]; then
  pass "[M5] les littéraux à barre oblique inverse passent toujours (« $M_BS », « $M_ES », « $M_DS »)"
else
  fail "[M5] un littéral à barre oblique inverse est cassé (« $M_BS », « $M_ES », « $M_DS »)"
fi

# ── M6..M9 — LES MÉTA-COMMANDES NE S'EXÉCUTENT PAS.
m_meta_blocked() {
  local label="$1" sql="$2" before after
  before="$(m_side_effects)"
  : > "$RAW_ERR"
  q "$sql" >/dev/null 2>&1
  after="$(m_side_effects)"
  if [ "$before" = "$after" ] && grep -q 'syntax error' "$RAW_ERR"; then
    pass "[M] $label — REFUSÉE PAR LE SERVEUR (erreur de syntaxe SQL), aucun effet de bord"
  else
    fail "[M] $label — effets de bord $before -> $after ; le serveur a-t-il refusé ? $(head -1 "$RAW_ERR" | cut -c1-80)"
  fi
}
m_meta_blocked "M6 une méta-commande en tête (\\!)" \
  "\\! touch $M_WIT/m6"
m_meta_blocked "M7 deux méta-commandes" \
  "\\! touch $M_WIT/m7a
\\! touch $M_WIT/m7b"
m_meta_blocked "M8 méta-commande PUIS du SQL valide" \
  "\\! touch $M_WIT/m8
select 1;"
m_meta_blocked "M9 du SQL valide PUIS une méta-commande" \
  "select 1; \\! touch $M_WIT/m9"

# ── M10 — TOUTES les commandes psql nommées par le mandat, et pas une
#    liste noire : chacune est refusée par le SERVEUR, parce que la
#    chaîne ne commence jamais par une barre oblique inverse.
M_BLOCKED=0
M_TOTAL=0
for mc in "\\! touch $M_WIT/mc-bang" \
          "\\connect $L_DB_B" \
          "\\copy (select 1) to '$M_WIT/mc-copy'" \
          "\\g $M_WIT/mc-g" \
          "\\gexec" \
          "\\gset mc_" \
          "\\include $M_WIT/mc-include" \
          "\\ir $M_WIT/mc-ir" \
          "\\set mc_x 1" \
          "\\unset mc_x" \
          "\\o $M_WIT/mc-o" \
          "\\w $M_WIT/mc-w" \
          "\\watch 1" \
          "\\password $RAW_ROLE" \
          "\\lo_import /etc/hostname" \
          "\\setenv PATH /tmp" \
          "\\cd /tmp" \
          "\\s $M_WIT/mc-s"; do
  M_TOTAL=$((M_TOTAL + 1))
  : > "$RAW_ERR"
  q "$mc" >/dev/null 2>&1
  grep -q 'syntax error' "$RAW_ERR" && M_BLOCKED=$((M_BLOCKED + 1))
done
M_SIDE="$(m_side_effects)"
if [ "$M_BLOCKED" = "$M_TOTAL" ] && [ "$M_SIDE" = "0" ]; then
  pass "[M10] les $M_TOTAL commandes psql éprouvées sont TOUTES refusées par le serveur, et AUCUN fichier n'a été créé"
else
  fail "[M10] $M_BLOCKED/$M_TOTAL refusées, $M_SIDE effet(s) de bord"
fi

# ── M11 — AUCUN EFFET DE BORD SYSTÈME sur l'exécution entière de la
#    section, et le rôle sonde n'a pas bougé.
if [ "$(m_side_effects)" = "0" ] && [ "$(l_verdict)" = "OK" ]; then
  pass "[M11] aucun effet de bord système, et l'empreinte reste en accord : rien n'a muté"
else
  fail "[M11] des effets de bord subsistent, ou l'empreinte n'est plus en accord"
fi

# ── M12 — LE CONTRAT est bien celui qu'on croit : la chaîne transmise
#    commence par du SQL. On le LIT sur la définition, pas sur une
#    intention.
if [ "${RAW_SQL_PREFIX#select }" != "$RAW_SQL_PREFIX" ] \
   && [ "${RAW_SQL_PREFIX%; }" != "$RAW_SQL_PREFIX" ] \
   && [ -z "$(q "$RAW_SQL_PREFIX")" ]; then
  pass "[M12] le préfixe du contrat est une instruction SQL sans sortie ni effet"
else
  fail "[M12] le préfixe du contrat n'est pas une instruction SQL inerte"
fi

# ============================================================
# [N] LA COURSE ENTRE MUTATION GARDÉE ET RAFRAÎCHISSEMENT
#     CSDJ1-AUD-07-RUNTIME-ROLE-BOUNDARY-02, observation O1
#
# L'auditeur a signalé, sans le classer comme échec, que le
# rafraîchissement de l'empreinte -- qui recalcule l'état COURANT --
# pouvait BÉNIR une mutation brute survenue pendant la transaction
# gardée. La course est RÉELLE : les lectures de catalogue ne suivent
# pas l'instantané de la transaction, chaque commande en prend un
# nouveau (vérifié : deux lectures de l'empreinte dans UNE transaction
# rendent des résultats différents de part et d'autre d'un COMMIT
# concurrent).
#
# Elle est CORRIGÉE, en deux temps :
#
#   N1  l'état ANTÉRIEUR est vérifié. Si l'empreinte attendue ne
#       correspond plus au catalogue quand la mutation gardée commence,
#       la mutation gardée REFUSE -- elle n'absorbe pas.
#   N2  la FENÊTRE est fermée. Un verrou SHARE sur les trois catalogues
#       de rôles, pris avant la première lecture et tenu jusqu'au commit,
#       fait ATTENDRE toute écriture d'état de rôle concurrente -- qui
#       s'applique donc APRÈS, et se fait dénoncer.
# ============================================================
log "=== [N] la course O1 : un rafraîchissement gardé peut-il bénir une mutation brute ? ==="
l_clear
# ── N1 — une mutation brute ANTÉRIEURE fait ÉCHOUER l'opération gardée.
q "${V_W_ALTER} ${V_W_ROLE} $RAW_ROLE set work_mem='1MB';" >/dev/null 2>&1
N1_VERDICT="$(l_verdict)"
csdj1_identity_use test >/dev/null
if csdj1_identity_mutate "  perform 1;" >/dev/null 2>&1; then
  fail "[N1] l'opération gardée a ABSORBÉ une mutation brute antérieure"
else
  N1_REASON="$CSDJ1_ID_LAST"
  if [ "$N1_VERDICT" = "MUTATION-BRUTE" ] && [ "$N1_REASON" = "empreinte_desaccord" ]; then
    pass "[N1] une mutation brute ANTÉRIEURE fait REFUSER l'opération gardée, et le refus est NOMMÉ ($N1_REASON)"
  else
    fail "[N1] verdict « $N1_VERDICT », refus « $N1_REASON » : la paire ne discrimine pas"
  fi
fi
csdj1_identity_boundary_resync >/dev/null
l_clear

# ── N2 — une mutation brute CONCURRENTE n'est PAS bénie.
#
# On ouvre une transaction gardée qui tient le verrou trois secondes,
# et on tente la mutation brute pendant ce temps. Elle doit ATTENDRE,
# s'appliquer APRÈS le commit, et être DÉNONCÉE ensuite.
N2_GUARD_LOG="$TMP_DIR/n2-guard.log"
( csdj1_identity_use test >/dev/null
  csdj1_identity_mutate "  perform pg_catalog.pg_sleep(3);" >"$N2_GUARD_LOG" 2>&1 ) &
N2_PID=$!
sleep 1
N2_T0="$(date +%s%N)"
q "${V_W_ALTER} ${V_W_ROLE} $RAW_ROLE set work_mem='2MB';" >/dev/null 2>&1
N2_T1="$(date +%s%N)"
wait "$N2_PID"
N2_WAIT_MS=$(( (N2_T1 - N2_T0) / 1000000 ))
N2_VERDICT="$(l_verdict)"
N2_SETTING="$(csdj1_runner_test "select coalesce((select pg_catalog.array_to_string(s.setconfig, ',')
  from pg_catalog.pg_db_role_setting s
  join pg_catalog.pg_authid r on r.oid = s.setrole
  where r.rolname = '$RAW_ROLE' and s.setdatabase = 0), 'aucun');" | tail -1 | tr -d ' ')"
if [ "$N2_WAIT_MS" -ge 1000 ] && [ "$N2_VERDICT" = "MUTATION-BRUTE" ] && [ "$N2_SETTING" = "work_mem=2MB" ]; then
  pass "[N2] la mutation brute concurrente a ATTENDU ${N2_WAIT_MS} ms, s'est appliquée APRÈS le commit gardé, et est DÉNONCÉE ($N2_VERDICT) : elle n'est pas bénie"
else
  fail "[N2] attente ${N2_WAIT_MS} ms, verdict « $N2_VERDICT », réglage « $N2_SETTING » : la course reste ouverte"
fi
csdj1_identity_boundary_resync >/dev/null
l_clear

# ── N3 — LE VERROU EST SCOPÉ. Il fait attendre les ÉCRITURES d'état de
#    rôle, et PAS les lectures : une connexion neuve, donc une
#    authentification, aboutit pendant qu'il est tenu.
N3_GUARD_LOG="$TMP_DIR/n3-guard.log"
( csdj1_identity_use test >/dev/null
  csdj1_identity_mutate "  perform pg_catalog.pg_sleep(3);" >"$N3_GUARD_LOG" 2>&1 ) &
N3_PID=$!
sleep 1
N3_T0="$(date +%s%N)"
N3_READ="$(q "select 4242;")"
N3_T1="$(date +%s%N)"
wait "$N3_PID"
N3_MS=$(( (N3_T1 - N3_T0) / 1000000 ))
if [ "$N3_READ" = "4242" ] && [ "$N3_MS" -lt 1500 ]; then
  pass "[N3] le verrou est SCOPÉ : une connexion neuve et une lecture aboutissent en ${N3_MS} ms pendant qu'il est tenu"
else
  fail "[N3] la lecture a pris ${N3_MS} ms et rendu « $N3_READ » : le verrou est trop large"
fi

# ── N4 — LE VERROU EST BREF en nominal : la fenêtre est bornée.
N4_T0="$(date +%s%N)"
csdj1_identity_use test >/dev/null
csdj1_identity_mutate "  perform 1;" >/dev/null 2>&1
N4_T1="$(date +%s%N)"
N4_MS=$(( (N4_T1 - N4_T0) / 1000000 ))
if [ "$N4_MS" -lt 1000 ]; then
  pass "[N4] une mutation gardée NOMINALE tient le verrou ${N4_MS} ms : la sérialisation est bornée"
else
  fail "[N4] une mutation gardée nominale dure ${N4_MS} ms : la sérialisation n'est pas bornée"
fi

# ── N5 — les clusters SANS frontière ne sont pas verrouillés du tout :
#    le banc d'essai de sockets et le cluster de sentinelles ont muté
#    leurs rôles dans cette même exécution, et [H] l'a prouvé.
if [ "$(csdj1_runner_lab "select pg_catalog.to_regclass('public.$BND_TABLE_TEST') is null;" | tail -1 | tr -d ' ')" = "t" ]; then
  pass "[N5] le banc d'essai de sockets ne porte AUCUNE frontière : ni verrou, ni empreinte, ni vérification"
else
  fail "[N5] le banc d'essai porte une frontière qu'on ne lui a pas posée"
fi
l_clear

log "=== BILAN ISOLATION ET RESTAURATION : $PASS preuve(s), $FAIL échec(s) ==="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
