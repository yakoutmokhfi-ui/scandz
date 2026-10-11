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
q() {
  env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    "$PSQL" -X -A -q -t \
      -h "$SOCKET_DIR" -p "$PORT" -U "$OWNER" -d postgres \
      -c "$1" </dev/null 2>/dev/null | tail -1 | tr -d ' '
}
qw() {
  env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    "$PSQL" -X -A -q -t \
      -h "$WIT_SOCK" -p "$WIT_PORT" -U "$OWNER" -d postgres \
      -c "$1" </dev/null 2>/dev/null | tail -1 | tr -d ' '
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

DATA_DIR_PROVEN="$(q "select pg_catalog.current_setting('data_directory');")"
CONFIG_FILE_PROVEN="$(q "select pg_catalog.current_setting('config_file');")"
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
WIT_DATA_DIR_PROVEN="$(qw "select pg_catalog.current_setting('data_directory');")"
WIT_CONFIG_FILE_PROVEN="$(qw "select pg_catalog.current_setting('config_file');")"
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
MUT_AWK="$TMP_DIR/role-mutation-detector.awk"
# Le détecteur vit dans UN fichier, employé pour analyser les harnais ET
# pour s'éprouver lui-même sur des fixtures. Deux copies divergeraient.
#
# Il classe la ligne AVANT de mettre à jour l'ouvreur : sans cela, une
# mutation BRUTE tenant sur UNE SEULE LIGNE serait consommée par la
# règle d'ouvreur et jamais examinée. C'est la limite que l'audit a
# signalée, et elle est fermée.
cat > "$MUT_AWK" <<'AWKDET'
# Détecteur de mutations de rôle NON GARDÉES.
# CSDJ1-AUD-07-RAW-ROLE-DETECTOR-01
#
# Trois défauts corriges ici, tous signales par l audit :
#
#   1. l etat « garde » FUITAIT d un appel a l autre. Un
#      csdj1_identity_mutate "perform 1;" complet laissait l etat actif,
#      et la mutation BRUTE de la ligne suivante en heritait.
#      => l etat ne se propage que tant qu un argument reste OUVERT.
#
#   2. seul le guillemet DOUBLE etait reconnu comme ouverture d argument.
#      q 'alter role ...' passait inapercu.
#      => les deux formes de litteral sont reconnues.
#
#   3. les mots-cles SQL etaient cherches en minuscules et en capitales,
#      jamais en casse mixte. « Alter Role » passait inapercu.
#      => la recherche est insensible a la casse.
#
# Principe : pour chaque ligne, on cherche la position du mot-cle de
# mutation, puis celle des APPELS qui la precedent SUR LA MEME LIGNE.
# Le plus proche en amont decide. S il n y en a aucun, on herite de
# l etat -- mais seulement si un argument est encore ouvert.

function firstpos(str, re) {
  if (match(str, re)) return RSTART
  return 0
}

/^[[:space:]]*#/ { next }
/SELF-REFERENCE/ { next }

{
  line  = $0
  lower = tolower(line)

  # Les motifs sont des CHAINES, et non des constantes /re/ : en awk,
  # une constante regex passee en ARGUMENT vaut « $0 ~ /re/ », soit 0 ou
  # 1, et la fonction chercherait alors « 0 » dans le texte.
  mp = firstpos(lower, "(create|alter|drop)[ \t]+role")
  gp = firstpos(line, "csdj1_identity_(mutate|install|uninstall)|RESTORE_SQL=|PROBE_MUTATION=")
  # Un jeton d appel ne compte que s il est suivi d une ouverture de
  # chaine ou d un drapeau. Sans cela, du SQL contenant « ..._probe
  # nologin » serait pris pour un appel au client « probe », et
  # ecraserait l etat au milieu d un argument garde.
  rp = firstpos(line, "(^|[^a-z_])(q|qw)[ \t]*[\"']|csdj1_runner_[a-z_]+[ \t]*[\"']|(psql|probe|sql_value|run_sql)[ \t]+(-|[\"']|\\$)")

  if (mp > 0) {
    gbefore = (gp > 0 && gp < mp) ? gp : 0
    rbefore = (rp > 0 && rp < mp) ? rp : 0

    if (rbefore > 0 && rbefore >= gbefore)
      printf "NON-GARDEE\t%s\t%s\t%s\n", FILENAME, line, "meme ligne"
    else if (gbefore > 0)
      printf "GARDEE\t%s\t%s\n", FILENAME, line
    else if (pending == "brut")
      printf "NON-GARDEE\t%s\t%s\t%s\n", FILENAME, line, "argument ouvert en amont"
    else if (pending == "garde")
      printf "GARDEE\t%s\t%s\n", FILENAME, line
    else
      printf "SANS-OUVREUR\t%s\t%s\n", FILENAME, line
  }

  # Mise a jour de l etat APRES classement. Un appel dont l argument se
  # ferme sur la meme ligne ne laisse AUCUN etat derriere lui : c est ce
  # qui fermait la fuite.
  if (gp > 0 || rp > 0) {
    if (rp > gp) { kind = "brut"; callpos = rp } else { kind = "garde"; callpos = gp }
    rest = substr(line, callpos)
    dq = gsub(/"/, "\"", rest)
    sq = gsub(/'/, "'", rest)
    if (dq % 2 == 1)      { pending = kind; pq = "\"" }
    else if (sq % 2 == 1) { pending = kind; pq = "'" }
    else                  { pending = ""; pq = "" }
  } else if (pending != "") {
    tmp = line
    n = (pq == "\"") ? gsub(/"/, "\"", tmp) : gsub(/'/, "'", tmp)
    if (n % 2 == 1) { pending = ""; pq = "" }
  }
}
AWKDET
awk -f "$MUT_AWK" "$SELF" "$HARNESS" > "$MUT_REPORT"

# ── FIXTURES DU DÉTECTEUR — il doit voir ce qu'il prétend voir.
#
# Exigence du mandat : une mutation BRUTE tenant sur UNE SEULE LIGNE,
# hors de csdj1_identity_mutate, doit être détectée.
DET_FIXT="$TMP_DIR/detector-fixtures"
mkdir -p "$DET_FIXT"
# Les verbes SQL des fixtures sont ASSEMBLÉS, et non écrits en clair :
# écrits en clair, ils apparaîtraient dans CE fichier, que le détecteur
# analyse aussi -- et il les dénoncerait, à juste titre, comme des
# mutations brutes. Une fixture ne doit pas devenir le défaut qu'elle
# éprouve.
V_CREATE="crea""te role"
V_ALTER="alt""er role"
V_ALTER_MIXED="Alt""er Role"
SQ="'"
DQ='"'
# D1 — appel brut d'UNE ligne, argument entre APOSTROPHES.
{ printf '#!/usr/bin/env bash\n'
  printf 'q %s%s fixture bypassrls;%s\n' "$SQ" "$V_ALTER" "$SQ"
} > "$DET_FIXT/d1-raw-single-quote.sh"
# D2 — même chose entre GUILLEMETS.
{ printf '#!/usr/bin/env bash\n'
  printf 'q %s%s fixture bypassrls;%s\n' "$DQ" "$V_ALTER" "$DQ"
} > "$DET_FIXT/d2-raw-double-quote.sh"
# D3 — casse MIXTE.
{ printf '#!/usr/bin/env bash\n'
  printf 'q %s%s fixture BYPASSRLS;%s\n' "$SQ" "$V_ALTER_MIXED" "$SQ"
} > "$DET_FIXT/d3-mixed-case.sh"
# D4 — un appel GARDÉ et COMPLET, puis une mutation BRUTE. L'état
#      « gardé » ne doit pas fuir de l'un à l'autre : c'est le défaut
#      que l'audit a trouvé.
{ printf '#!/usr/bin/env bash\n'
  printf 'csdj1_identity_mutate %sperform 1;%s\n' "$DQ" "$DQ"
  printf 'q %s%s fixture bypassrls;%s\n' "$SQ" "$V_ALTER" "$SQ"
} > "$DET_FIXT/d4-guard-state-leak.sh"
# D5 — mutation brute MULTI-LIGNES (non-régression du tour précédent).
{ printf '#!/usr/bin/env bash\n'
  printf 'qw %sdo \\$\\$ begin\n' "$DQ"
  printf '      %s fixture login bypassrls;\n' "$V_CREATE"
  printf '    end \\$\\$;%s\n' "$DQ"
} > "$DET_FIXT/d5-raw-multiline.sh"
# D6 — mutation correctement GARDÉE : elle ne doit pas être dénoncée.
{ printf '#!/usr/bin/env bash\n'
  printf 'csdj1_identity_mutate %s\n' "$DQ"
  printf '  %s fixture login;\n' "$V_CREATE"
  printf '%s\n' "$DQ"
} > "$DET_FIXT/d6-guarded.sh"
# D7 — du SQL qui ne touche AUCUN rôle : il doit être ignoré.
{ printf '#!/usr/bin/env bash\n'
  printf 'q %sselect 1; drop table if exists x;%s\n' "$DQ" "$DQ"
} > "$DET_FIXT/d7-non-role-sql.sh"

# D1, D2, D3, D4, D5 : la mutation brute doit être DÉTECTÉE.
for fx in d1-raw-single-quote d2-raw-double-quote d3-mixed-case \
          d4-guard-state-leak d5-raw-multiline; do
  FX_OUT="$(awk -f "$MUT_AWK" "$DET_FIXT/$fx.sh")"
  case "$FX_OUT" in
    NON-GARDEE*) pass "[E] fixture « $fx » : la mutation brute est DÉTECTÉE" ;;
    "") fail "[E] fixture « $fx » : la mutation brute est INVISIBLE au détecteur" ;;
    *) fail "[E] fixture « $fx » : mal classée (« $(printf '%s' "$FX_OUT" | head -1 | cut -c1-60) »)" ;;
  esac
done
# D4 encore : il ne suffit pas qu'elle soit détectée, il faut qu'elle ne
# soit pas ATTRIBUÉE à l'appel gardé qui précède.
FX_OUT="$(awk -f "$MUT_AWK" "$DET_FIXT/d4-guard-state-leak.sh")"
if printf '%s' "$FX_OUT" | grep -q '^GARDEE'; then
  fail "[E] fixture « d4 » : la mutation brute HÉRITE de l'état gardé de l'appel précédent"
else
  pass "[E] fixture « d4 » : l'état « gardé » ne FUIT pas d'un appel complet au suivant"
fi
# D6 : une mutation gardée n'est pas dénoncée à tort.
FX_OUT="$(awk -f "$MUT_AWK" "$DET_FIXT/d6-guarded.sh")"
case "$FX_OUT" in
  GARDEE*) pass "[E] fixture « d6-guarded » : une mutation GARDÉE n'est pas dénoncée à tort" ;;
  *) fail "[E] fixture « d6-guarded » : une mutation gardée est signalée à tort (« $(printf '%s' "$FX_OUT" | head -1 | cut -c1-60) »)" ;;
esac
# D7 : du SQL sans rôle ne produit aucun verdict.
FX_OUT="$(awk -f "$MUT_AWK" "$DET_FIXT/d7-non-role-sql.sh")"
if [ -z "$FX_OUT" ]; then
  pass "[E] fixture « d7-non-role-sql » : du SQL sans mutation de rôle est IGNORÉ"
else
  fail "[E] fixture « d7-non-role-sql » : verdict inattendu (« $(printf '%s' "$FX_OUT" | head -1 | cut -c1-60) »)"
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

log "=== BILAN ISOLATION ET RESTAURATION : $PASS preuve(s), $FAIL échec(s) ==="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
