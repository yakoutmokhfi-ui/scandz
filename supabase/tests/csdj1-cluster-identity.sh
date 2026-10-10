#!/usr/bin/env bash
# ====================================================================
# CSDJ-V1-DESTINATION-PROOF-02 — IDENTITÉ COMPLÈTE AVANT TOUTE MUTATION
#
# Bibliothèque SOURCÉE par les harnais de CHECKOUT SCHEDULING
# FOUNDATION v1 (CSDJ-1). Elle n'est pas exécutable seule.
#
# Pourquoi elle existe
# ====================
# Le second re-audit delta a trouvé ceci : le harnais refusait bien les
# variables de routage hostiles et isolait bien ses appels, mais le
# chemin de NETTOYAGE ne vérifiait qu'une PARTIE de l'identité du
# serveur avant de muter des rôles -- socket, port, utilisateur,
# superutilisateur. Il omettait `data_directory`, `config_file` et le
# marqueur d'exécution. Deux clusters DIFFÉRENTS peuvent satisfaire
# cette identité partielle : même numéro de port, même nom
# d'utilisateur, même motif de nommage de socket. La preuve ne liait
# donc pas le serveur à CETTE exécution.
#
# Deux prédicats d'identité subtilement différents entre la mise en
# place et le nettoyage, c'est la forme même du défaut. Il n'y a donc
# ici qu'UN prédicat, et tout chemin qui mute passe par lui.
#
# Ce qui est vérifié — les SEPT faits, plus la socket
# ===================================================
#   1. aucune destination réseau   (inet_server_addr() vaut NULL)
#   2. la socket attendue figure dans unix_socket_directories
#   3. le port attendu
#   4. l'utilisateur attendu
#   5. le statut superutilisateur
#   6. le data_directory EXACT
#   7. le config_file EXACT
#   8. un MARQUEUR d'exécution, présent dans ce cluster, portant le
#      nonce de CETTE exécution
#
# Si UN SEUL échoue : rien n'est muté.
#
# Pourquoi la preuve et la mutation ne font qu'UN appel
# =====================================================
# Prouver puis muter en deux connexions laisse un intervalle : entre la
# preuve et la mutation, la destination pourrait changer. Les deux
# tiennent donc dans UNE session PostgreSQL et UNE transaction -- un
# bloc DO unique, dont l'exception annule tout. Le marqueur est lu par
# la session même qui mutera, et non par une autre.
#
# Pourquoi le marqueur est en base, et non sur le disque
# ======================================================
# Un fichier témoin prouverait que le SYSTÈME DE FICHIERS est le bon,
# pas que le SERVEUR joint est le bon. Le marqueur est donc une table
# de ce cluster, lue en SQL : aucun autre serveur ne peut la présenter,
# quel que soit son port, son utilisateur ou le nom de sa socket.
# ====================================================================

# Contrat courant. Déclaré une fois, consulté à chaque mutation.
# Contrat ACTIF : celui que la prochaine mutation gardée emploiera.
CSDJ1_ID_CONTEXT=""
CSDJ1_ID_RUNNER=""
CSDJ1_ID_SOCKET=""
CSDJ1_ID_PORT=""
CSDJ1_ID_USER=""
CSDJ1_ID_DATADIR=""
CSDJ1_ID_CONFIG=""
CSDJ1_ID_MARKER=""
CSDJ1_ID_NONCE=""
CSDJ1_ID_DECLARED=0
CSDJ1_ID_LAST=""

# Contrats NOMMÉS. Un harnais peut avoir plusieurs clusters jetables à
# lui -- celui sous test, un témoin, un banc d'essai -- et CHACUN doit
# avoir son contrat complet. Les garder nommés, plutôt que sauvegardés
# et restaurés à la main autour de chaque usage, évite exactement ce qui
# a produit le défaut d'origine : deux prédicats presque identiques,
# divergeant sans que personne le voie.
declare -A CSDJ1_ID_CTX_RUNNER=()
declare -A CSDJ1_ID_CTX_SOCKET=()
declare -A CSDJ1_ID_CTX_PORT=()
declare -A CSDJ1_ID_CTX_USER=()
declare -A CSDJ1_ID_CTX_DATADIR=()
declare -A CSDJ1_ID_CTX_CONFIG=()
declare -A CSDJ1_ID_CTX_MARKER=()
declare -A CSDJ1_ID_CTX_NONCE=()
declare -A CSDJ1_ID_CTX_INSTALLED=()

# Normalise un répertoire de socket ATTENDU, du côté shell, exactement
# comme la garde normalise les entrées lues du serveur : espaces
# extérieurs retirés, guillemets retirés, barre oblique finale retirée
# -- sauf pour « / », qui est son propre répertoire.
csdj1_identity_normalize_socket() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  v="${v%\"}"; v="${v#\"}"
  while [ "${#v}" -gt 1 ] && [ "${v%/}" != "$v" ]; do v="${v%/}"; done
  printf '%s' "$v"
}

# csdj1_identity_declare <nom> <runner> <socket_dir> <port> <user> <data_dir> <config_file> <marker_table> <nonce>
#
# <runner> est le NOM d'une fonction shell qui prend UNE requête SQL,
# l'exécute sur la base « postgres » du cluster visé, écrit la sortie
# combinée sur sa sortie standard et rend le code de retour de psql.
# Chaque harnais fournit le sien : l'un passe par `env -i`, l'autre par
# son propre jeu de variables validées. Le PRÉDICAT, lui, est commun.
#
# Déclarer rend le contrat ACTIF. `csdj1_identity_use` y revient.
csdj1_identity_declare() {
  local name="$1" sock
  sock="$(csdj1_identity_normalize_socket "$3")"
  # Un répertoire attendu VIDE accepterait une entrée vide : on refuse
  # de déclarer un contrat qui ne contraindrait rien.
  case "$sock" in
    /*) : ;;
    *) printf 'csdj1_identity_declare: répertoire de socket attendu invalide (« %s »)\n' "$3" >&2
       return 1 ;;
  esac
  CSDJ1_ID_CTX_RUNNER[$name]="$2"
  CSDJ1_ID_CTX_SOCKET[$name]="$sock"
  CSDJ1_ID_CTX_PORT[$name]="$4"
  CSDJ1_ID_CTX_USER[$name]="$5"
  CSDJ1_ID_CTX_DATADIR[$name]="$6"
  CSDJ1_ID_CTX_CONFIG[$name]="$7"
  CSDJ1_ID_CTX_MARKER[$name]="$8"
  CSDJ1_ID_CTX_NONCE[$name]="$9"
  CSDJ1_ID_CTX_INSTALLED[$name]="${CSDJ1_ID_CTX_INSTALLED[$name]:-0}"
  csdj1_identity_use "$name"
}

# Rend ACTIF un contrat déjà déclaré.
csdj1_identity_use() {
  local name="$1"
  [ -n "${CSDJ1_ID_CTX_RUNNER[$name]:-}" ] || { CSDJ1_ID_LAST="contrat_inconnu"; return 1; }
  CSDJ1_ID_CONTEXT="$name"
  CSDJ1_ID_RUNNER="${CSDJ1_ID_CTX_RUNNER[$name]}"
  CSDJ1_ID_SOCKET="${CSDJ1_ID_CTX_SOCKET[$name]}"
  CSDJ1_ID_PORT="${CSDJ1_ID_CTX_PORT[$name]}"
  CSDJ1_ID_USER="${CSDJ1_ID_CTX_USER[$name]}"
  CSDJ1_ID_DATADIR="${CSDJ1_ID_CTX_DATADIR[$name]}"
  CSDJ1_ID_CONFIG="${CSDJ1_ID_CTX_CONFIG[$name]}"
  CSDJ1_ID_MARKER="${CSDJ1_ID_CTX_MARKER[$name]}"
  CSDJ1_ID_NONCE="${CSDJ1_ID_CTX_NONCE[$name]}"
  CSDJ1_ID_DECLARED=1
  CSDJ1_ID_INSTALLED="${CSDJ1_ID_CTX_INSTALLED[$name]:-0}"
  CSDJ1_ID_LAST=""
}

# Garde SQL. L'ordre n'est pas indifférent : le statut
# superutilisateur est vérifié AVANT les réglages qui exigent ce
# statut, sans quoi un défaut de privilège se présenterait comme une
# erreur de permission plutôt que comme un refus NOMMÉ.
#
# `current_setting(name, true)` ne lève pas sur un réglage absent : un
# réglage manquant doit produire un refus lisible, pas une exception
# opaque. Et `current_user` s'écrit NON qualifié : c'est un
# constructeur du parseur, pas une fonction (« pg_catalog.current_user »
# est lu comme une colonne et la requête échoue).
csdj1_identity_guard_sql() {
  cat <<SQL
  if pg_catalog.inet_server_addr() is not null then
    raise exception 'SCANYM_IDENTITY_REFUS|destination_reseau';
  end if;
  if coalesce(pg_catalog.current_setting('port', true), '') <> '${CSDJ1_ID_PORT}' then
    raise exception 'SCANYM_IDENTITY_REFUS|port';
  end if;
  if current_user <> '${CSDJ1_ID_USER}' then
    raise exception 'SCANYM_IDENTITY_REFUS|current_user';
  end if;
  if coalesce(pg_catalog.current_setting('is_superuser', true), '') <> 'on' then
    raise exception 'SCANYM_IDENTITY_REFUS|is_superuser';
  end if;
  -- SOCKET : ÉGALITÉ EXACTE avec UNE ENTRÉE COMPLÈTE de la liste.
  --
  -- La version précédente employait « strpos » -- une sémantique de
  -- SOUS-CHAÎNE. Elle acceptait donc « /tm » pour un serveur dont la
  -- socket est « /tmp », et plus généralement tout préfixe, suffixe ou
  -- fragment d'une entrée. Une identité qui accepte un fragment
  -- n'identifie rien.
  --
  -- « unix_socket_directories » est une LISTE séparée par des virgules,
  -- dont les entrées peuvent être encadrées de guillemets doubles
  -- (c'est la syntaxe que PostgreSQL accepte pour un chemin contenant
  -- une virgule ou un espace). On la découpe donc en ENTRÉES, on
  -- normalise chacune -- espaces extérieurs, guillemets, barre oblique
  -- finale -- et on exige l'égalité avec l'attendu, lui-même normalisé
  -- de la même façon côté shell. Aucun préfixe, aucun suffixe, aucun
  -- fragment.
  if not exists (
    select 1
    from pg_catalog.unnest(
           pg_catalog.string_to_array(
             coalesce(pg_catalog.current_setting('unix_socket_directories', true), ''),
             ',')) as sd(entry)
    where case
            when pg_catalog.btrim(pg_catalog.btrim(pg_catalog.btrim(sd.entry), '"')) = '/'
              then '/'
            else pg_catalog.rtrim(
                   pg_catalog.btrim(pg_catalog.btrim(pg_catalog.btrim(sd.entry), '"')),
                   '/')
          end = '${CSDJ1_ID_SOCKET}'
  ) then
    raise exception 'SCANYM_IDENTITY_REFUS|socket';
  end if;
  if coalesce(pg_catalog.current_setting('data_directory', true), '') <> '${CSDJ1_ID_DATADIR}' then
    raise exception 'SCANYM_IDENTITY_REFUS|data_directory';
  end if;
  if coalesce(pg_catalog.current_setting('config_file', true), '') <> '${CSDJ1_ID_CONFIG}' then
    raise exception 'SCANYM_IDENTITY_REFUS|config_file';
  end if;
SQL
}

# Volet MARQUEUR de la garde. Séparé parce que l'installation du
# marqueur doit, elle, être gardée par tout le reste SAUF lui-même.
csdj1_identity_marker_sql() {
  cat <<SQL
  if pg_catalog.to_regclass('public.${CSDJ1_ID_MARKER}') is null then
    raise exception 'SCANYM_IDENTITY_REFUS|marqueur_absent';
  end if;
  if not exists (select 1 from public.${CSDJ1_ID_MARKER} where nonce = '${CSDJ1_ID_NONCE}') then
    raise exception 'SCANYM_IDENTITY_REFUS|nonce';
  end if;
SQL
}

# Exécute un bloc DO = garde + corps, en UNE session et UNE
# transaction. Rend 0 si le corps a été exécuté, 1 sinon, et laisse la
# raison du refus dans CSDJ1_ID_LAST.
csdj1_identity_run_guarded() {
  local guard="$1" body="$2" out rc
  [ "$CSDJ1_ID_DECLARED" = "1" ] || { CSDJ1_ID_LAST="contrat_non_declare"; return 1; }
  out="$("$CSDJ1_ID_RUNNER" "do \$csdj1id\$
begin
${guard}
${body}
end
\$csdj1id\$;" 2>&1)"
  rc=$?
  case "$out" in
    *SCANYM_IDENTITY_REFUS\|*)
      CSDJ1_ID_LAST="$(printf '%s' "$out" | sed -n 's/.*SCANYM_IDENTITY_REFUS|\([a-z_]*\).*/\1/p' | head -1)"
      [ -n "$CSDJ1_ID_LAST" ] || CSDJ1_ID_LAST="indetermine"
      return 1 ;;
  esac
  if [ "$rc" != "0" ]; then
    CSDJ1_ID_LAST="erreur_sql: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)"
    return 1
  fi
  CSDJ1_ID_LAST="OK"
  return 0
}

# Installe le marqueur de CETTE exécution. Gardé par les sept autres
# faits : on ne pose pas un marqueur dans un serveur qu'on n'a pas
# identifié. REFUSE si une table de ce nom existe déjà -- on ne peut
# pas prouver qu'on en est le propriétaire, donc on n'y touche pas.
csdj1_identity_install() {
  csdj1_identity_run_guarded "$(csdj1_identity_guard_sql)" "
  if pg_catalog.to_regclass('public.${CSDJ1_ID_MARKER}') is not null then
    raise exception 'SCANYM_IDENTITY_REFUS|marqueur_preexistant';
  end if;
  create table public.${CSDJ1_ID_MARKER} (nonce text primary key);
  insert into public.${CSDJ1_ID_MARKER} values ('${CSDJ1_ID_NONCE}');
" || return 1
  CSDJ1_ID_INSTALLED=1
  CSDJ1_ID_CTX_INSTALLED[$CSDJ1_ID_CONTEXT]=1
  return 0
}

# LE point de passage. Toute mutation d'état PostgreSQL d'un harnais
# CSDJ-1 -- mise en place, restauration, nettoyage, repli -- passe par
# ici, et par le MÊME prédicat.
csdj1_identity_mutate() {
  csdj1_identity_run_guarded \
    "$(csdj1_identity_guard_sql)
$(csdj1_identity_marker_sql)" "$1"
}

# Retire le marqueur. Gardé comme tout le reste : le marqueur n'est
# supprimé que du serveur qui vient de prouver qu'il est bien le nôtre.
csdj1_identity_uninstall() {
  [ "$CSDJ1_ID_INSTALLED" = "1" ] || return 0
  csdj1_identity_mutate "
  drop table if exists public.${CSDJ1_ID_MARKER};
" && { CSDJ1_ID_INSTALLED=0; CSDJ1_ID_CTX_INSTALLED[$CSDJ1_ID_CONTEXT]=0; }
}

# Preuve SEULE, sans mutation : pour journaliser ou assertionner. Le
# corps est une instruction sans effet, de sorte que le chemin exercé
# soit exactement celui d'une mutation.
csdj1_identity_prove() {
  csdj1_identity_mutate "  perform 1;"
}
