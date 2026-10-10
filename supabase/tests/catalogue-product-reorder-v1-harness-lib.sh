# shellcheck shell=bash
# ============================================================
# Scanym — CATALOGUE PRODUCT REORDER v1 — bibliothèque de SÛRETÉ du
# harnais PostgreSQL (remédiation CPR-AUDIT-02).
#
# Fichier SOURCÉ, jamais exécuté. Il est partagé par :
#   - supabase/tests/catalogue-product-reorder-v1-check.sh
#       (le harnais fonctionnel et de concurrence) ;
#   - supabase/tests/catalogue-product-reorder-v1-harness-safety-check.sh
#       (les sondes HARNESS-01..08 qui prouvent ce qui suit).
#
# ------------------------------------------------------------------
# CE QUE L'AUDIT A CONSTATÉ (CPR-AUDIT-02)
# ------------------------------------------------------------------
# La première version appelait `psql`, `createdb` et
# `drop database if exists` avec la configuration de connexion AMBIANTE
# du poste : PGHOST, PGPORT, PGSERVICE, ~/.pg_service.conf ou le
# cluster par défaut décidaient de la cible. Un opérateur dont le shell
# pointait ailleurs voyait le harnais créer et DÉTRUIRE des bases sur
# un serveur qu'il ne possédait pas.
#
# ------------------------------------------------------------------
# CE QUE CETTE BIBLIOTHÈQUE GARANTIT
# ------------------------------------------------------------------
# Aucune commande PostgreSQL, a fortiori aucune opération destructive,
# ne s'exécute avant que le harnais ait PROUVÉ qu'il possède
# l'environnement jetable.
#
#   1. CONSENTEMENT EXPLICITE. SCANYM_DISPOSABLE_CLUSTER=1, exactement.
#      Toute autre valeur (absente, 0, true, yes…) est un refus.
#
#   2. AUCUNE CONFIGURATION DE CONNEXION HÉRITÉE. Une variable qui peut
#      désigner une cible (PGHOST, PGHOSTADDR, PGPORT, PGDATABASE,
#      PGUSER, PGPASSWORD, PGPASSFILE, PGSERVICE, PGSERVICEFILE,
#      PGSYSCONFDIR, PGCLUSTER, et les URL de base usuelles) est un
#      REFUS, signalé par son NOM SEUL -- jamais par sa valeur, qui
#      peut être un secret. Toute autre variable PG* héritée est
#      retirée de l'environnement.
#
#   3. UN CLUSTER CRÉÉ PAR LE HARNAIS, ET LUI SEUL. Répertoire privé
#      `mktemp -d` (0700), `initdb`, socket UNIX dans ce répertoire,
#      `listen_addresses = ''` : le serveur n'écoute sur AUCUNE adresse
#      réseau. Il n'existe pas de mode « cluster désigné » : le harnais
#      ne sait parler qu'au serveur qu'il vient de créer.
#
#   4. AUCUN DÉFAUT AMBIANT. Chaque appel passe par `hpsql`, qui lance
#      le binaire psql RÉEL (chemin absolu, jamais le `pg_wrapper` de
#      Debian, qui route par PGCLUSTER et ~/.postgresqlrc) dans un
#      environnement VIDE (`env -i`) où l'hôte, le port, l'utilisateur
#      et la base sont fixés explicitement, deux fois : par variables
#      ET par options. Une variable exportée après coup dans le shell
#      appelant n'atteint donc jamais libpq.
#
#   5. IDENTITÉ DU SERVEUR PROUVÉE AVANT TOUTE DESTRUCTION, SUR LA
#      MÊME CONNEXION. Chaque `create database` / `drop database` est
#      précédé, dans la MÊME session psql (ON_ERROR_STOP), d'un bloc
#      qui lève SCANYM_HARNESS_IDENTITY_MISMATCH si le serveur joint
#      n'est pas celui de cette exécution :
#        - un NONCE aléatoire de 128 bits, tiré par cette exécution et
#          écrit dans le postgresql.conf de SON cluster : le serveur
#          doit le rendre (current_setting) ET le relire dans SON
#          fichier de configuration (pg_file_settings, avec le chemin
#          du fichier) ;
#        - config_file et data_directory = le répertoire créé par
#          cette exécution ;
#        - connexion par socket UNIX (inet_server_addr() nul) et
#          serveur sans aucune écoute réseau.
#      Il n'y a pas de fenêtre entre la preuve et l'acte : si la preuve
#      échoue, psql s'arrête avant d'envoyer l'instruction suivante.
#
#   6. NOMS ALÉATOIRES, REGISTRE EXPLICITE. Les bases portent une
#      étiquette tirée de /dev/urandom. `harness_create_db` REFUSE un
#      nom déjà présent (il n'en serait pas le propriétaire) ;
#      `harness_drop_db` REFUSE tout nom absent du registre de cette
#      exécution. Il n'existe aucun `drop database if exists`.
#
#   7. NETTOYAGE BORNÉ À CETTE EXÉCUTION, SÛR APRÈS ÉCHEC PARTIEL. Le
#      nettoyage n'ouvre aucune connexion : il arrête le postmaster
#      dont le fichier postmaster.pid se trouve dans SON répertoire,
#      puis supprime ce répertoire -- à condition que le marqueur de
#      propriété qu'il contient porte le nonce de CETTE exécution.
#      Faute de preuve, il ne supprime rien.
#
#   8. AUCUN SECRET JOURNALISÉ. Seuls des NOMS de variables et des
#      chemins du répertoire temporaire sont écrits.
#
# Codes de retour :
#   2 = refus de sûreté (rien n'a été détruit)
#   3 = identité du serveur non prouvée (rien n'a été détruit)
# ============================================================

H_REFUSE_EXIT=2
H_IDENTITY_EXIT=3
H_LOT_TAG="cpr1"
H_USER="postgres"

H_GATE_PASSED=0
H_BIN=""
H_RUN_DIR=""
H_NONCE=""
H_TAG=""
H_DATA=""
H_SOCK=""
H_EMPTY=""
H_PORT=""
H_STARTED=0
H_CREATED_DBS=()

# Variables qui peuvent désigner une CIBLE -> refus (nom seul).
H_REDIRECTING_VARS="PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE PGSYSCONFDIR PGCLUSTER DATABASE_URL POSTGRES_URL POSTGRESQL_URL PG_URL SUPABASE_DB_URL SCANYM_DB_URL SCANYM_DATABASE_URL"

h_log() { echo "[$(date +%H:%M:%S)] $*"; }

# Refus AVANT toute commande PostgreSQL (verrou d'entrée).
h_refuse_gate() {
  h_log "REFUS DE SÛRETÉ : $*"
  h_log "Aucune commande PostgreSQL n'a été exécutée. Aucune opération destructive n'a été tentée."
  exit "$H_REFUSE_EXIT"
}

# ------------------------------------------------------------------
# 1 + 2. VERROU D'ENTRÉE -- consentement, environnement hérité,
#        utilisateur, binaires. N'exécute AUCUNE commande PostgreSQL.
# ------------------------------------------------------------------
harness_safety_gate() {
  local v name cand bindir found=""

  if [ "${SCANYM_DISPOSABLE_CLUSTER:-}" != "1" ]; then
    h_refuse_gate "SCANYM_DISPOSABLE_CLUSTER=1 est requis. Ce harnais crée un cluster PostgreSQL jetable, y crée et y supprime des bases : il exige une déclaration EXPLICITE de l'opérateur."
  fi

  for v in $H_REDIRECTING_VARS; do
    if [ -n "${!v:-}" ]; then
      h_refuse_gate "$v est définie dans l'environnement hérité. Cette variable peut désigner un serveur ou une base qui n'appartient pas à ce harnais. Relancez-le dans un environnement sans configuration de connexion (par exemple : env -i PATH=\"\$PATH\" SCANYM_DISPOSABLE_CLUSTER=1 bash …). La valeur n'est pas journalisée : elle peut être un secret."
    fi
  done

  # Toute autre PG* héritée (PGOPTIONS, PGSSLMODE, PGDATA, PGAPPNAME…)
  # est retirée. Les noms sont lus par `compgen -e`, jamais en
  # analysant la sortie de `env` (une valeur multi-lignes y forgerait
  # de faux noms).
  for name in $(compgen -e); do
    case "$name" in
      PG*)
        unset "$name" 2>/dev/null || true
        h_log "[sûreté] variable héritée $name retirée de l'environnement (valeur non journalisée)."
        ;;
    esac
  done

  if [ "$(id -u)" = "0" ]; then
    h_refuse_gate "ce harnais ne s'exécute pas en root (initdb le refuse, et un cluster jetable n'a besoin d'aucun privilège). Relancez-le sous un utilisateur ordinaire, par exemple : su postgres -c 'SCANYM_DISPOSABLE_CLUSTER=1 bash supabase/tests/catalogue-product-reorder-v1-check.sh'."
  fi

  # Binaires RÉELS, par chemin absolu. SCANYM_PG_BINDIR désigne un
  # répertoire d'exécutables locaux : ce n'est pas un paramètre de
  # connexion. S'il est fourni, lui SEUL est considéré (aucun repli
  # silencieux vers un autre répertoire).
  if [ -n "${SCANYM_PG_BINDIR:-}" ]; then
    set -- "$SCANYM_PG_BINDIR"
  else
    # shellcheck disable=SC2046
    set -- "$(dirname "$(command -v initdb 2>/dev/null || echo /nonexistent/initdb)")" \
           $(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -t/ -k5,5nr) \
           $(ls -d /usr/pgsql-*/bin 2>/dev/null | sort -r) \
           $(ls -d /opt/homebrew/opt/postgresql*/bin /usr/local/opt/postgresql*/bin 2>/dev/null) \
           /opt/homebrew/bin /usr/local/pgsql/bin /usr/local/bin
  fi
  for cand in "$@"; do
    [ -n "$cand" ] && [ -d "$cand" ] || continue
    bindir="$(cd "$cand" 2>/dev/null && pwd -P)" || continue
    if h_is_real_binary "$bindir/initdb" && h_is_real_binary "$bindir/pg_ctl" \
       && h_is_real_binary "$bindir/postgres" && h_is_real_binary "$bindir/psql"; then
      found="$bindir"
      break
    fi
  done
  if [ -z "$found" ]; then
    h_refuse_gate "binaires PostgreSQL introuvables (initdb, pg_ctl, postgres, psql réels dans un même répertoire). Indiquez leur répertoire avec SCANYM_PG_BINDIR=/chemin/vers/bin."
  fi
  H_BIN="$found"
  H_GATE_PASSED=1
  h_log "[sûreté] verrou d'entrée franchi : consentement explicite, aucune configuration de connexion héritée, binaires $H_BIN."
}

# Un exécutable qui n'est PAS le pg_wrapper de Debian (lequel choisit
# sa cible d'après PGCLUSTER, ~/.postgresqlrc et user_clusters).
h_is_real_binary() {
  local resolved
  [ -x "$1" ] && [ ! -d "$1" ] || return 1
  resolved="$(readlink -f "$1" 2>/dev/null || echo "$1")"
  case "$(basename "$resolved")" in
    pg_wrapper) return 1 ;;
  esac
  return 0
}

# ------------------------------------------------------------------
# 4. hpsql -- UNIQUE point d'accès à PostgreSQL.
#    hpsql <base> [options psql…]
#    hpsql_as <rôle> <base> [options psql…]   (émulation d'un rôle
#                                              applicatif)
#    Environnement VIDE ; cible fixée par variables ET par options.
# ------------------------------------------------------------------
hpsql() {
  local db="$1"; shift
  env -i PATH="$H_BIN:/usr/bin:/bin" LC_ALL=C TZ=UTC \
    PGHOST="$H_SOCK" PGPORT="$H_PORT" PGUSER="$H_USER" PGDATABASE="$db" \
    PGPASSFILE="$H_EMPTY/pgpass" PGSERVICEFILE="$H_EMPTY/pg_service.conf" PGSYSCONFDIR="$H_EMPTY" \
    PGCLIENTENCODING=UTF8 PGCONNECT_TIMEOUT=10 PGAPPNAME="scanym-$H_LOT_TAG-$H_TAG" \
    "$H_BIN/psql" -X -h "$H_SOCK" -p "$H_PORT" -U "$H_USER" -d "$db" "$@"
}
hpsql_as() {
  local role="$1" db="$2"; shift 2
  env -i PATH="$H_BIN:/usr/bin:/bin" LC_ALL=C TZ=UTC \
    PGHOST="$H_SOCK" PGPORT="$H_PORT" PGUSER="$H_USER" PGDATABASE="$db" \
    PGPASSFILE="$H_EMPTY/pgpass" PGSERVICEFILE="$H_EMPTY/pg_service.conf" PGSYSCONFDIR="$H_EMPTY" \
    PGCLIENTENCODING=UTF8 PGCONNECT_TIMEOUT=10 PGAPPNAME="scanym-$H_LOT_TAG-$H_TAG" \
    PGOPTIONS="-c role=$role" \
    "$H_BIN/psql" -X -h "$H_SOCK" -p "$H_PORT" -U "$H_USER" -d "$db" "$@"
}
# Binaires serveur, eux aussi dans un environnement vide.
h_server_bin() {
  local bin="$1"; shift
  env -i PATH="$H_BIN:/usr/bin:/bin" LC_ALL=C TZ=UTC "$H_BIN/$bin" "$@"
}

# ------------------------------------------------------------------
# 3. Cluster jetable CRÉÉ par cette exécution.
# ------------------------------------------------------------------
harness_start_cluster() {
  local base
  [ "$H_GATE_PASSED" = "1" ] || { h_log "REFUS DE SÛRETÉ : harness_start_cluster avant le verrou d'entrée."; return "$H_REFUSE_EXIT"; }
  [ -z "$H_RUN_DIR" ] || { h_log "REFUS DE SÛRETÉ : un cluster a déjà été créé par cette exécution."; return "$H_REFUSE_EXIT"; }

  base="${TMPDIR:-/tmp}"
  H_RUN_DIR="$(mktemp -d "$base/scanym-$H_LOT_TAG.XXXXXXXXXX")" || { H_RUN_DIR=""; h_log "FATAL: mktemp -d impossible sous $base."; return 1; }
  H_RUN_DIR="$(cd "$H_RUN_DIR" && pwd -P)"
  case "$H_RUN_DIR" in
    *[!A-Za-z0-9_./-]*)
      h_log "REFUS DE SÛRETÉ : le répertoire temporaire contient un caractère inattendu ; choisissez un TMPDIR simple."
      rmdir "$H_RUN_DIR" 2>/dev/null; H_RUN_DIR=""
      return "$H_REFUSE_EXIT" ;;
  esac

  H_NONCE="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  if [ "${#H_NONCE}" -ne 32 ]; then
    h_log "FATAL: tirage du nonce impossible (/dev/urandom)."
    rmdir "$H_RUN_DIR" 2>/dev/null; H_RUN_DIR=""; H_NONCE=""
    return 1
  fi
  # Marqueur de propriété : seul un répertoire qui le porte, avec CE
  # nonce, pourra être supprimé par le nettoyage.
  printf '%s\n' "$H_NONCE" > "$H_RUN_DIR/.scanym-harness-owner"
  H_TAG="${H_NONCE:0:12}"
  H_DATA="$H_RUN_DIR/data"
  H_SOCK="$H_RUN_DIR/sock"
  H_EMPTY="$H_RUN_DIR/empty"
  mkdir -m 700 "$H_SOCK" "$H_EMPTY" "$H_RUN_DIR/tmp" || return 1
  # Fichiers de mots de passe et de services VIDES, propres à cette
  # exécution : libpq ne consulte ni ~/.pgpass ni ~/.pg_service.conf.
  : > "$H_EMPTY/pgpass" && chmod 600 "$H_EMPTY/pgpass" || return 1
  : > "$H_EMPTY/pg_service.conf" || return 1
  # Le « port » ne sert qu'à nommer le fichier de socket : le serveur
  # n'écoute sur aucune adresse réseau.
  H_PORT=$(( 20000 + ( 16#${H_NONCE:12:4} % 40000 ) ))
  if [ $(( ${#H_SOCK} + 18 )) -gt 103 ]; then
    h_log "REFUS DE SÛRETÉ : chemin de socket trop long pour un socket UNIX ; choisissez un TMPDIR plus court."
    return "$H_REFUSE_EXIT"
  fi

  if ! h_server_bin initdb -D "$H_DATA" -U "$H_USER" -A trust -E UTF8 --locale=C -N >"$H_RUN_DIR/initdb.log" 2>&1; then
    h_log "FATAL: initdb a échoué : $(tail -3 "$H_RUN_DIR/initdb.log" 2>/dev/null | tr '\n' ' ')"
    return 1
  fi
  cat >> "$H_DATA/postgresql.conf" <<CONF

# --- Scanym : cluster JETABLE de l'exécution $H_TAG ---
listen_addresses = ''
unix_socket_directories = '$H_SOCK'
unix_socket_permissions = 0700
port = $H_PORT
max_connections = 120
fsync = off
synchronous_commit = off
full_page_writes = off
scanym.harness_run_nonce = '$H_NONCE'
CONF

  H_STARTED=1
  if ! h_server_bin pg_ctl -D "$H_DATA" -l "$H_RUN_DIR/postmaster.log" -w -t 90 start >"$H_RUN_DIR/pg_ctl.log" 2>&1; then
    h_log "FATAL: démarrage du cluster jetable impossible : $(tail -3 "$H_RUN_DIR/postmaster.log" 2>/dev/null | tr '\n' ' ')"
    return 1
  fi
  h_log "[sûreté] cluster jetable CRÉÉ par cette exécution : $H_RUN_DIR (socket privé, aucune écoute réseau, étiquette $H_TAG)."
  return 0
}

# ------------------------------------------------------------------
# 5. Preuve d'identité du serveur joint.
# ------------------------------------------------------------------
h_identity_sql() {
  cat <<SQL
do \$scanym_proof\$
begin
  if pg_catalog.current_setting('scanym.harness_run_nonce', true) is distinct from '$H_NONCE'
     or not exists (
       select 1 from pg_catalog.pg_file_settings f
       where f.name = 'scanym.harness_run_nonce'
         and f.setting = '$H_NONCE'
         and f.sourcefile = '$H_DATA/postgresql.conf'
     )
     or pg_catalog.current_setting('config_file') is distinct from '$H_DATA/postgresql.conf'
     or pg_catalog.current_setting('data_directory') is distinct from '$H_DATA'
     or pg_catalog.inet_server_addr() is not null
     or pg_catalog.current_setting('listen_addresses') is distinct from ''
     or pg_catalog.current_setting('is_superuser') is distinct from 'on'
  then
    raise exception 'SCANYM_HARNESS_IDENTITY_MISMATCH';
  end if;
end \$scanym_proof\$;
SQL
}

# h_guarded_sql <instructions SQL>
#   Exécute, sur UNE connexion : la preuve d'identité, puis les
#   instructions. Si la preuve échoue, psql s'arrête (ON_ERROR_STOP)
#   avant d'envoyer la suite. Sortie standard = résultat des
#   instructions ; le diagnostic d'un échec est lu par h_last_err.
#   Retour : 0 ; 3 = identité non prouvée ; 1 = autre échec.
h_last_err() { tr '\n' ' ' < "$H_RUN_DIR/tmp/guard.err" 2>/dev/null | cut -c1-300; }
h_guarded_sql() {
  local out rc err
  if [ "$H_STARTED" != "1" ] || [ -z "$H_NONCE" ] || [ -z "$H_DATA" ] || [ -z "$H_SOCK" ] || [ ! -d "$H_RUN_DIR/tmp" ]; then
    return "$H_IDENTITY_EXIT"
  fi
  out="$( { h_identity_sql; printf '%s\n' "$1"; } | hpsql postgres -v ON_ERROR_STOP=1 -q -A -t -f - 2>"$H_RUN_DIR/tmp/guard.err" )"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    err="$(h_last_err)"
    case "$err" in
      *SCANYM_HARNESS_IDENTITY_MISMATCH*) return "$H_IDENTITY_EXIT" ;;
      # Serveur injoignable par NOTRE socket : son identité n'est pas
      # prouvée non plus.
      *"connection to server"*|*"could not connect"*) return "$H_IDENTITY_EXIT" ;;
    esac
    return 1
  fi
  printf '%s' "$out"
  return 0
}

harness_prove_identity() {
  local rc
  h_guarded_sql "select 1;" >/dev/null
  rc=$?
  if [ "$rc" -ne 0 ]; then
    h_log "REFUS DE SÛRETÉ : le serveur joint n'est PAS prouvé comme le cluster jetable de cette exécution. Aucune opération destructive n'a été tentée."
    return "$H_IDENTITY_EXIT"
  fi
  return 0
}

# ------------------------------------------------------------------
# 6. Bases : noms validés, création TRACÉE, suppression RESTREINTE au
#    registre.
# ------------------------------------------------------------------
h_valid_db_name() {
  case "$1" in
    ''|*[!a-z0-9_]*) return 1 ;;
  esac
  return 0
}
h_is_tracked() {
  local d
  for d in ${H_CREATED_DBS[@]+"${H_CREATED_DBS[@]}"}; do
    [ "$d" = "$1" ] && return 0
  done
  return 1
}

# harness_create_db <nom> [modèle]
harness_create_db() {
  local name="$1" tpl="${2:-}" exists rc
  h_valid_db_name "$name" || { h_log "REFUS DE SÛRETÉ : nom de base invalide."; return "$H_REFUSE_EXIT"; }
  if [ -n "$tpl" ]; then
    h_valid_db_name "$tpl" || { h_log "REFUS DE SÛRETÉ : nom de modèle invalide."; return "$H_REFUSE_EXIT"; }
    h_is_tracked "$tpl" || { h_log "REFUS DE SÛRETÉ : le modèle « $tpl » n'a pas été créé par cette exécution."; return "$H_REFUSE_EXIT"; }
  fi
  exists="$(h_guarded_sql "select count(*) from pg_catalog.pg_database where datname = '$name';")"
  rc=$?
  if [ "$rc" -eq "$H_IDENTITY_EXIT" ]; then
    h_log "REFUS DE SÛRETÉ : identité du serveur non prouvée -- la base « $name » n'est PAS créée."
    return "$H_IDENTITY_EXIT"
  fi
  [ "$rc" -eq 0 ] || { h_log "FATAL: lecture de pg_database impossible : $(h_last_err)"; return 1; }
  if [ "$exists" != "0" ]; then
    if h_is_tracked "$name"; then
      h_log "REFUS DE SÛRETÉ : la base « $name » existe déjà (créée par cette exécution) : elle n'est pas remplacée. Supprimez-la d'abord par harness_drop_db."
    else
      h_log "REFUS DE SÛRETÉ : la base « $name » existe déjà et n'a PAS été créée par cette exécution. Elle n'est ni remplacée ni supprimée."
    fi
    return "$H_REFUSE_EXIT"
  fi
  h_guarded_sql "create database \"$name\"${tpl:+ template \"$tpl\"};" >/dev/null
  rc=$?
  if [ "$rc" -eq "$H_IDENTITY_EXIT" ]; then
    h_log "REFUS DE SÛRETÉ : identité du serveur non prouvée -- la base « $name » n'est PAS créée."
    return "$H_IDENTITY_EXIT"
  fi
  [ "$rc" -eq 0 ] || { h_log "FATAL: création de la base « $name » impossible : $(h_last_err)"; return 1; }
  H_CREATED_DBS+=("$name")
  return 0
}

# harness_drop_db <nom> -- uniquement une base du registre, uniquement
# sur le serveur prouvé.
harness_drop_db() {
  local name="$1" rc d kept=()
  h_valid_db_name "$name" || { h_log "REFUS DE SÛRETÉ : nom de base invalide."; return "$H_REFUSE_EXIT"; }
  if ! h_is_tracked "$name"; then
    h_log "REFUS DE SÛRETÉ : la base « $name » n'a pas été créée par cette exécution. Elle n'est PAS supprimée."
    return "$H_REFUSE_EXIT"
  fi
  h_guarded_sql "drop database \"$name\";" >/dev/null
  rc=$?
  if [ "$rc" -eq "$H_IDENTITY_EXIT" ]; then
    h_log "REFUS DE SÛRETÉ : identité du serveur non prouvée -- DROP DATABASE « $name » N'A PAS été envoyé."
    return "$H_IDENTITY_EXIT"
  fi
  [ "$rc" -eq 0 ] || { h_log "FATAL: suppression de la base « $name » impossible : $(h_last_err)"; return 1; }
  for d in ${H_CREATED_DBS[@]+"${H_CREATED_DBS[@]}"}; do
    [ "$d" = "$name" ] || kept+=("$d")
  done
  H_CREATED_DBS=(${kept[@]+"${kept[@]}"})
  return 0
}

# ------------------------------------------------------------------
# 7. Nettoyage -- borné à CETTE exécution, sûr après échec partiel.
#    N'ouvre aucune connexion PostgreSQL.
# ------------------------------------------------------------------
h_owns_run_dir() {
  [ -n "$H_RUN_DIR" ] && [ -n "$H_NONCE" ] || return 1
  [ -d "$H_RUN_DIR" ] && [ ! -L "$H_RUN_DIR" ] || return 1
  case "$(basename "$H_RUN_DIR")" in
    "scanym-$H_LOT_TAG."??????????) : ;;
    *) return 1 ;;
  esac
  [ -f "$H_RUN_DIR/.scanym-harness-owner" ] || return 1
  [ "$(cat "$H_RUN_DIR/.scanym-harness-owner" 2>/dev/null)" = "$H_NONCE" ] || return 1
  return 0
}

harness_cleanup() {
  local pid cmd
  [ -n "$H_RUN_DIR" ] || return 0
  if ! h_owns_run_dir; then
    h_log "[sûreté] nettoyage REFUSÉ : « $H_RUN_DIR » n'est pas prouvé comme le répertoire de cette exécution (marqueur absent ou d'une autre exécution). Rien n'est supprimé."
    return 0
  fi
  # Postmaster : uniquement celui dont le fichier pid se trouve dans
  # NOTRE répertoire de données, et dont la ligne de commande désigne
  # ce même répertoire.
  if [ -f "$H_DATA/postmaster.pid" ]; then
    pid="$(head -1 "$H_DATA/postmaster.pid" 2>/dev/null | tr -cd '0-9')"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
      case "$cmd" in
        *"$H_DATA"*)
          h_server_bin pg_ctl -D "$H_DATA" -m immediate -w -t 30 stop >/dev/null 2>&1 || true
          # Si pg_ctl n'a pas suffi : même processus, même preuve.
          if kill -0 "$pid" 2>/dev/null; then
            cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
            case "$cmd" in
              *"$H_DATA"*) kill -9 "$pid" 2>/dev/null || true ;;
            esac
          fi
          ;;
        *)
          h_log "[sûreté] le processus $pid ne désigne pas le répertoire de cette exécution : il n'est PAS arrêté."
          ;;
      esac
    fi
  fi
  rm -rf -- "$H_RUN_DIR"
  H_STARTED=0
  H_RUN_DIR=""
  return 0
}
