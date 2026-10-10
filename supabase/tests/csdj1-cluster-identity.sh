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
CSDJ1_ID_RUNNER=""
CSDJ1_ID_SOCKET=""
CSDJ1_ID_PORT=""
CSDJ1_ID_USER=""
CSDJ1_ID_DATADIR=""
CSDJ1_ID_CONFIG=""
CSDJ1_ID_MARKER=""
CSDJ1_ID_NONCE=""
CSDJ1_ID_DECLARED=0
CSDJ1_ID_INSTALLED=0
CSDJ1_ID_LAST=""

# csdj1_identity_declare <runner> <socket_dir> <port> <user> <data_dir> <config_file> <marker_table> <nonce>
#
# <runner> est le NOM d'une fonction shell qui prend UNE requête SQL,
# l'exécute sur la base « postgres » du cluster visé, écrit la sortie
# combinée sur sa sortie standard et rend le code de retour de psql.
# Chaque harnais fournit le sien : l'un passe par `env -i`, l'autre par
# son propre jeu de variables validées. Le PRÉDICAT, lui, est commun.
csdj1_identity_declare() {
  CSDJ1_ID_RUNNER="$1"
  CSDJ1_ID_SOCKET="$2"
  CSDJ1_ID_PORT="$3"
  CSDJ1_ID_USER="$4"
  CSDJ1_ID_DATADIR="$5"
  CSDJ1_ID_CONFIG="$6"
  CSDJ1_ID_MARKER="$7"
  CSDJ1_ID_NONCE="$8"
  CSDJ1_ID_DECLARED=1
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
  if pg_catalog.strpos(
       coalesce(pg_catalog.current_setting('unix_socket_directories', true), ''),
       '${CSDJ1_ID_SOCKET}') = 0 then
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
" && CSDJ1_ID_INSTALLED=0
}

# Preuve SEULE, sans mutation : pour journaliser ou assertionner. Le
# corps est une instruction sans effet, de sorte que le chemin exercé
# soit exactement celui d'une mutation.
csdj1_identity_prove() {
  csdj1_identity_mutate "  perform 1;"
}
