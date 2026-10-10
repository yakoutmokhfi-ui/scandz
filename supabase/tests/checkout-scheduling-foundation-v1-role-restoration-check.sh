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
# Runner du TÉMOIN : il n'existe que pour les CONTRÔLES NÉGATIFS, afin
# de prouver qu'une destination réseau est refusée AVANT toute mutation.
csdj1_runner_witness() {
  env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \
    "$PSQL" -X -A -q -t -v ON_ERROR_STOP=1 \
      -h 127.0.0.1 -p "$WIT_PORT" -U "$OWNER" -d postgres \
      -c "$1" </dev/null 2>&1
}

DATA_DIR_PROVEN="$(q "select pg_catalog.current_setting('data_directory');")"
CONFIG_FILE_PROVEN="$(q "select pg_catalog.current_setting('config_file');")"
IDENTITY_MARKER="scanym_csdj1_identity_$$"

csdj1_identity_declare csdj1_runner_test \
  "$SOCKET_DIR" "$PORT" "$OWNER" "$DATA_DIR_PROVEN" "$CONFIG_FILE_PROVEN" \
  "$IDENTITY_MARKER" "$NONCE"
csdj1_identity_install \
  || fatal "[E] pose du marqueur d'identité REFUSÉE ($CSDJ1_ID_LAST) -- aucune mutation tentée."

if csdj1_identity_prove; then
  pass "[E] l'identité COMPLÈTE (8 faits) passe sur le cluster créé ici"
else
  fatal "[E] la preuve d'identité complète ÉCHOUE avant toute mutation ($CSDJ1_ID_LAST) -- aucune mutation tentée."
fi

# La preuve doit DISCRIMINER : adressée au témoin, elle doit échouer --
# et échouer sur le PREMIER fait, la destination réseau.
CSDJ1_ID_RUNNER=csdj1_runner_witness
if csdj1_identity_prove; then
  fail "[E] la preuve d'identité ne distingue pas deux clusters"
else
  pass "[E] la preuve DISCRIMINE : adressée au témoin elle refuse ($CSDJ1_ID_LAST)"
fi
CSDJ1_ID_RUNNER=csdj1_runner_test

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
for r in $APP_ROLES; do
  qw "do \$\$ begin
        if not exists (select 1 from pg_roles where rolname='$r') then
          execute 'create role $r LOGIN BYPASSRLS';
        else
          execute 'alter role $r LOGIN BYPASSRLS';
        end if;
      end \$\$;" >/dev/null
done
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
  local saved_runner="$CSDJ1_ID_RUNNER"
  local saved_socket="$CSDJ1_ID_SOCKET" saved_port="$CSDJ1_ID_PORT"
  local saved_user="$CSDJ1_ID_USER" saved_dd="$CSDJ1_ID_DATADIR"
  local saved_cf="$CSDJ1_ID_CONFIG" saved_nonce="$CSDJ1_ID_NONCE"

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

  if csdj1_identity_mutate "$PROBE_MUTATION"; then
    fail "[G] $label — la mutation a été ACCEPTÉE malgré une identité fausse"
  elif [ "$CSDJ1_ID_LAST" = "$expect" ]; then
    pass "[G] $label — REFUS, raison « $CSDJ1_ID_LAST »"
  else
    fail "[G] $label — refus pour la MAUVAISE raison : « $CSDJ1_ID_LAST » au lieu de « $expect »"
  fi

  # Remise en état du contrat, puis du cluster si le contrôle l'a touché.
  CSDJ1_ID_RUNNER="$saved_runner"
  CSDJ1_ID_SOCKET="$saved_socket"; CSDJ1_ID_PORT="$saved_port"
  CSDJ1_ID_USER="$saved_user"; CSDJ1_ID_DATADIR="$saved_dd"
  CSDJ1_ID_CONFIG="$saved_cf"; CSDJ1_ID_NONCE="$saved_nonce"
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
negative_control "destination RÉSEAU (témoin)" runner csdj1_runner_witness     "destination_reseau"
negative_control "socket attendue fausse" socket "/var/run/postgresql-inexistant" "socket"

# Le fait « superutilisateur » s'éprouve en changeant d'utilisateur ET
# d'attente : sans cela, c'est `current_user` qui refuserait d'abord, et
# le contrôle prouverait autre chose que ce qu'il annonce.
NC_SAVED_USER="$CSDJ1_ID_USER"
CSDJ1_ID_USER="scanym_csdj1_plain"
negative_control "non superutilisateur" runner csdj1_runner_plain "is_superuser"
CSDJ1_ID_USER="$NC_SAVED_USER"

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
