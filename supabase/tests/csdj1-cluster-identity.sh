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
# Nom du rôle du chemin BRUT, par contrat, quand la frontière d'exécution
# y est posée. Vide = pas de frontière sur ce cluster (bancs d'essai).
declare -A CSDJ1_ID_CTX_BOUNDARY=()

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
  # Les valeurs du contrat sont interpolées dans des littéraux SQL entre
  # apostrophes. Une apostrophe dans l'une d'elles briserait la garde --
  # c'est-à-dire la désarmerait. On refuse de déclarer un tel contrat
  # plutôt que d'échapper à la main ce qui ne devrait jamais survenir
  # sur un cluster jetable.
  local f
  for f in "$sock" "$4" "$5" "$6" "$7" "$8" "$9"; do
    case "$f" in
      *\'*) printf "csdj1_identity_declare: apostrophe interdite dans une valeur du contrat\n" >&2
            return 1 ;;
    esac
  done
  # Les deux octets que l'encodage du parseur se réserve sont refusés
  # dans l'ATTENDU comme dans la liste lue du serveur : accepter d'un
  # côté ce qu'on refuse de l'autre serait une asymétrie, donc une
  # faille (CSDJ1-AUD-07-SOCKET-SENTINEL-01).
  case "$sock" in
    *$'\001'*|*$'\002'*)
      printf "csdj1_identity_declare: octet de controle reserve (chr(1)/chr(2)) dans le repertoire de socket attendu\n" >&2
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
# ────────────────────────────────────────────────────────────
# PARSEUR DE unix_socket_directories — UNIQUE ET DÉTERMINISTE
# CSDJ1-AUD-07-SOCKET-CSV-01
#
# Le quatrième re-audit avait fait remplacer une comparaison par
# SOUS-CHAÎNE par une égalité d'entrée. Le cinquième a montré que le
# DÉCOUPAGE restait faux : `string_to_array(liste, ',')` coupe à CHAQUE
# virgule, y compris celles qui sont DANS une entrée citée.
#
# Ce que PostgreSQL rend réellement, vérifié empiriquement sur un
# serveur de ce poste :
#
#   configuration  "<rép>/foo,bar",<rép>/plain
#   SHOW rend      "<rép>/foo,bar",<rép>/plain       (guillemets CONSERVÉS)
#
# Un découpage brut en tire trois fragments -- «"<rép>/foo», «bar"» et
# «<rép>/plain» -- et, les guillemets retirés, ACCEPTE «<rép>/foo» qui
# n'est pas un répertoire configuré, tout en REFUSANT «<rép>/foo,bar»
# qui en est un. Les deux erreurs sont graves, et la première est une
# fausse identité.
#
# Faits établis empiriquement (voir socket-csv-syntax.txt du paquet de
# preuves) :
#   - SHOW conserve les guillemets des entrées qui en ont besoin ;
#   - une virgule DANS une entrée citée est une donnée ;
#   - un guillemet DOUBLÉ («""») à l'intérieur d'une entrée citée vaut
#     un guillemet littéral, et SHOW le ré-encode doublé ;
#   - les espaces autour des virgules sont conservés par SHOW ;
#   - les espaces À L'INTÉRIEUR des guillemets font partie du nom ;
#   - une syntaxe MAL FORMÉE (guillemet non fermé) empêche le serveur de
#     DÉMARRER (« invalid list syntax in parameter »), elle ne peut donc
#     pas sortir de SHOW. On la refuse malgré tout : une hypothèse qu'on
#     ne vérifie pas est une hypothèse qu'on finit par violer.
#
# Le parseur ne découpe donc PAS aveuglément. Il remplace d'abord les
# guillemets doublés par une sentinelle, puis ne coupe qu'aux virgules
# dont le nombre de guillemets qui précèdent est PAIR -- c'est-à-dire
# celles qui sont hors citation. La parité suffit : après la
# substitution des guillemets doublés, les guillemets restants sont
# exactement les délimiteurs, et ils alternent.
#
# Il n'existe qu'UNE définition de ce parseur. La garde et la
# démonstration de nocivité du harnais emploient la MÊME.
# ────────────────────────────────────────────────────────────
csdj1_identity_socket_cte() {
  cat <<'SQLCTE'
csdj1_sock_raw as (
    select coalesce(pg_catalog.current_setting('unix_socket_directories', true), '') as raw),
  csdj1_sock_esc as (
    select pg_catalog.replace(r.raw, '""', pg_catalog.chr(1)) as t from csdj1_sock_raw r),
  csdj1_sock_chars as (
    select g.i,
           pg_catalog.substr(e.t, g.i, 1) as c,
           (pg_catalog.length(pg_catalog.substr(e.t, 1, g.i - 1))
            - pg_catalog.length(
                pg_catalog.replace(pg_catalog.substr(e.t, 1, g.i - 1), '"', ''))) % 2 = 0
             as outside_quotes
    from csdj1_sock_esc e, pg_catalog.generate_series(1, pg_catalog.length(e.t)) as g(i)),
  csdj1_sock_marked as (
    select pg_catalog.string_agg(
             case when c.c = ',' and c.outside_quotes then pg_catalog.chr(2) else c.c end,
             '' order by c.i) as t
    from csdj1_sock_chars c),
  csdj1_sock_split as (
    select pg_catalog.unnest(
             pg_catalog.string_to_array(coalesce(m.t, ''), pg_catalog.chr(2))) as e
    from csdj1_sock_marked m),
  csdj1_sock_trim as (select pg_catalog.btrim(s.e) as e from csdj1_sock_split s),
  csdj1_sock_unquote as (
    select case
             when pg_catalog.length(t.e) >= 2
                  and pg_catalog.left(t.e, 1) = '"'
                  and pg_catalog.right(t.e, 1) = '"'
               then pg_catalog.substr(t.e, 2, pg_catalog.length(t.e) - 2)
             else t.e
           end as e
    from csdj1_sock_trim t),
  csdj1_sock_restore as (
    select pg_catalog.replace(u.e, pg_catalog.chr(1), '"') as e from csdj1_sock_unquote u),
  csdj1_sock_norm as (
    select case when r.e = '/' then '/' else pg_catalog.rtrim(r.e, '/') end as entry
    from csdj1_sock_restore r)
SQLCTE
}

# Expression SQL booléenne : la liste BRUTE est-elle exempte des octets
# que l'encodage du parseur se RÉSERVE ?
#
# CSDJ1-AUD-07-SOCKET-SENTINEL-01. Le parseur emploie chr(1) et chr(2)
# comme sentinelles internes : chr(1) remplace temporairement un
# guillemet doublé, chr(2) marque une virgule hors citation. Ces deux
# octets ne sont réservés par AUCUNE syntaxe PostgreSQL -- un nom de
# répertoire peut les contenir, Linux n'interdit que « / » et l'octet
# nul, et un serveur démarre parfaitement sur un tel répertoire
# (vérifié empiriquement).
#
# La collision se produit donc, et dans les DEUX sens :
#   - un chr(2) dans un nom est pris pour un séparateur, et le fragment
#     qui le précède devient une entrée -- une FAUSSE IDENTITÉ acceptée ;
#   - un chr(1) dans un nom est restitué en guillemet, ce qui FABRIQUE
#     un chemin qui n'existe pas et REFUSE l'entrée réelle.
#
# On refuse donc la liste AVANT toute substitution. C'est le choix
# fermé : le harnais préfère ne pas s'exécuter sur un tel cluster plutôt
# que d'en parler de façon ambiguë. Un cluster jetable n'a jamais besoin
# d'un répertoire de socket contenant un octet de contrôle, et si
# quelqu'un en rencontrait un, le refus NOMMÉ lui dirait exactement
# pourquoi -- là où une acceptation silencieuse lui aurait menti.
csdj1_identity_socket_reserved_expr() {
  printf '(pg_catalog.strpos(coalesce(pg_catalog.current_setting(%s, true), %s), pg_catalog.chr(1)) = 0 and pg_catalog.strpos(coalesce(pg_catalog.current_setting(%s, true), %s), pg_catalog.chr(2)) = 0)' \
    "'unix_socket_directories'" "''" "'unix_socket_directories'" "''"
}

# Expression SQL booléenne : « l'attendu est-il une entrée COMPLÈTE ? »
# Employée par la garde ET par la démonstration de nocivité du harnais,
# afin qu'il n'existe pas deux parseurs.
csdj1_identity_socket_match_expr() {
  printf 'exists (with %s select 1 from csdj1_sock_norm where entry = %s)' \
    "$(csdj1_identity_socket_cte)" "'$1'"
}

# Expression SQL booléenne : la liste est-elle bien formée ? Un nombre
# IMPAIR de guillemets (après substitution des guillemets doublés)
# signale une citation non fermée. PostgreSQL refuse de démarrer sur une
# telle liste, donc SHOW ne peut pas la produire -- on le vérifie quand
# même, et on refuse plutôt que de deviner.
csdj1_identity_socket_balanced_expr() {
  printf '(select (pg_catalog.length(e.t) - pg_catalog.length(pg_catalog.replace(e.t, %s, %s))) %% 2 = 0 from (with %s select t from csdj1_sock_esc) e)' \
    "'\"'" "''" "$(csdj1_identity_socket_cte)"
}

csdj1_identity_guard_sql() {
  local CSDJ1_ID_SOCKET_MATCH CSDJ1_ID_SOCKET_BALANCED CSDJ1_ID_SOCKET_RESERVED
  CSDJ1_ID_SOCKET_MATCH="$(csdj1_identity_socket_match_expr "$CSDJ1_ID_SOCKET")"
  CSDJ1_ID_SOCKET_BALANCED="$(csdj1_identity_socket_balanced_expr)"
  CSDJ1_ID_SOCKET_RESERVED="$(csdj1_identity_socket_reserved_expr)"
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
  -- SOCKET : ÉGALITÉ EXACTE avec UNE ENTRÉE COMPLÈTE de la liste,
  -- celle-ci étant analysée par le parseur UNIQUE défini plus haut --
  -- sensible aux guillemets, donc aux virgules qu'ils protègent.
  --
  -- Historique du défaut, en deux temps : la comparaison était d'abord
  -- une SOUS-CHAÎNE (« /tm » acceptait « /tmp ») ; corrigée en égalité,
  -- elle reposait encore sur un découpage à CHAQUE virgule, qui
  -- fabriquait des fragments à partir d'une entrée citée. Une identité
  -- qui accepte un fragment n'identifie rien.
  if not ${CSDJ1_ID_SOCKET_RESERVED} then
    raise exception 'SCANYM_IDENTITY_REFUS|socket_octets_reserves';
  end if;
  if not ${CSDJ1_ID_SOCKET_BALANCED} then
    raise exception 'SCANYM_IDENTITY_REFUS|socket_liste_malformee';
  end if;
  if not ${CSDJ1_ID_SOCKET_MATCH} then
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

# ────────────────────────────────────────────────────────────
# FRONTIÈRE DE MUTATION IMPOSÉE À L'EXÉCUTION
# CSDJ1-AUD-07-RUNTIME-ROLE-BOUNDARY-01
#
# Huit tours de suite, la preuve que « aucune mutation de rôle ne passe
# hors garde » reposait sur la LECTURE DU TEXTE SOURCE des harnais. À
# chaque tour, un audit a trouvé une orthographe que le lecteur ne
# voyait pas : la casse, la forme du littéral, la fuite d'état,
# l'apostrophe d'un commentaire, la continuation entre guillemets, le
# saut de ligne comme blanc SQL. Le neuvième mandat tire la conclusion :
# on arrête de lire du texte.
#
# La preuve porte désormais sur le CHEMIN D'EXÉCUTION, et elle est
# établie par PostgreSQL lui-même. Deux mécanismes, indépendants.
#
#   1. LE PRIVILÈGE. Le chemin BRUT (les enveloppes génériques d'un
#      harnais) se connecte avec un rôle NOSUPERUSER NOCREATEROLE. Une
#      mutation d'attribut de rôle y est IMPOSSIBLE : PostgreSQL la
#      refuse avant de l'appliquer, quelle que soit son orthographe --
#      commentaires entre mots-clés, DO $$ ... $$, E'...', multiligne,
#      casse, tabulations, continuations, citations du shell. Aucun
#      analyseur n'intervient. Le chemin GARDÉ, lui, exige
#      « is_superuser » : les deux chemins sont donc disjoints PAR
#      CONSTRUCTION, et c'est le serveur qui l'impose.
#
#   2. L'EMPREINTE. Le catalogue de rôles -- attributs, options de
#      connexion, mots de passe, réglages par rôle, appartenances -- est
#      condensé par une fonction SECURITY DEFINER, et son empreinte est
#      stockée dans une table que SEUL le chemin gardé rafraîchit, DANS
#      LA MÊME TRANSACTION que la mutation. Après chaque exécution
#      brute, l'enveloppe demande au serveur si l'empreinte correspond
#      encore. Si elle ne correspond pas, une mutation de rôle a eu lieu
#      hors garde -- et on l'apprend du CATALOGUE, pas d'une expression
#      régulière appliquée au SQL.
#
# Le premier mécanisme REJETTE. Le second DÉTECTE, y compris ce que le
# premier autoriserait (un rôle peut modifier ses propres réglages par
# « ALTER ROLE ... SET », que NOCREATEROLE n'interdit pas) et y compris
# si le premier était désarmé. Le mandat demande « rejeté OU détecté » :
# ici, les deux.
#
# Les noms des objets sont FIXES, et non dérivés du marqueur : ce que
# l'empreinte décrit, c'est le catalogue de rôles DU CLUSTER, et non
# l'état vu par un contrat. Un même cluster peut porter plusieurs
# contrats -- le harnais de rôles y lance le harnais du lot, qui a le
# sien -- et TOUS doivent maintenir la MÊME empreinte attendue, sans
# quoi la mutation gardée de l'un rendrait l'empreinte de l'autre
# périmée. (v1.10 : c'était le cas, les noms étant dérivés du marqueur.)
#
# Un cluster sans frontière -- banc d'essai de sockets, cluster de
# sentinelles, cluster du harnais du lot lancé seul -- ne porte pas ces
# objets : « to_regclass » rend NULL, et tout ce qui suit est sans effet.
CSDJ1_BND_TABLE="scanym_csdj1_role_boundary"
CSDJ1_BND_DIGEST="scanym_csdj1_role_digest"
CSDJ1_BND_CHECK="scanym_csdj1_role_boundary_check"
csdj1_identity_boundary_table()  { printf '%s' "$CSDJ1_BND_TABLE"; }
csdj1_identity_boundary_digest() { printf '%s' "$CSDJ1_BND_DIGEST"; }
csdj1_identity_boundary_check()  { printf '%s' "$CSDJ1_BND_CHECK"; }

# ────────────────────────────────────────────────────────────
# LE VERROU — CSDJ1-AUD-07-RUNTIME-ROLE-BOUNDARY-02 (observation O1)
#
# Les lectures de CATALOGUE ne suivent pas l'instantané de la
# transaction : chaque commande en prend un nouveau. Deux lectures de
# pg_authid dans UNE transaction peuvent donc rendre des résultats
# DIFFÉRENTS si un COMMIT concurrent s'est glissé entre elles (vérifié
# empiriquement : voir runtime-role-boundary.txt, O1).
#
# Conséquence, et c'était la course signalée : entre la mutation gardée
# et le rafraîchissement de l'empreinte, une mutation BRUTE concurrente
# pouvait s'intercaler, et le rafraîchissement -- qui recalcule l'état
# COURANT -- la BÉNISSAIT.
#
# On ferme la fenêtre là où elle est : un verrou SHARE sur les TROIS
# catalogues de rôles, pris AVANT la première lecture et tenu jusqu'au
# COMMIT.
#
# POURQUOI « SHARE » ET NON « ACCESS EXCLUSIVE ». Le mode SHARE entre en
# conflit avec ROW EXCLUSIVE -- le mode que prend « ALTER ROLE » -- et
# PAS avec ACCESS SHARE, le mode d'une simple lecture. La portée est donc
# exactement celle qu'il faut : les ÉCRITURES d'état de rôle attendent,
# les LECTURES ne sont pas gênées, et l'AUTHENTIFICATION -- qui lit
# pg_authid -- n'est pas gênée non plus. Mesuré sur PostgreSQL 16.15 :
# une mutation brute concurrente attend 3011 ms derrière une transaction
# gardée de 3 s, tandis qu'une connexion neuve suivie d'une lecture
# aboutit en 10 ms. Une mutation gardée NOMINALE tient le verrou 9 ms.
# ACCESS EXCLUSIVE aurait bloqué les connexions, et rien ne l'exigeait.
#
# Une mutation brute concurrente ATTEND, puis s'applique APRÈS le commit
# gardé : elle n'est donc pas bénie, et la première exécution brute
# suivante la dénonce.
#
# « lock_timeout » est posé LOCAL : une attente anormale devient un
# refus nommé, pas un gel.
# ────────────────────────────────────────────────────────────
csdj1_identity_boundary_lock_sql() {
  cat <<'SQL'
    perform pg_catalog.set_config('lock_timeout', '30s', true);
    lock table pg_catalog.pg_authid,
               pg_catalog.pg_db_role_setting,
               pg_catalog.pg_auth_members in share mode;
SQL
}

# LE PROLOGUE — l'état ANTÉRIEUR doit être celui qu'on croit.
#
# Seconde moitié de la correction d'O1 : si l'empreinte attendue ne
# correspond PLUS au catalogue au moment où la mutation gardée commence,
# c'est qu'une mutation est survenue hors garde. La mutation gardée
# REFUSE alors -- elle ne l'absorbe pas. Le refus est nommé
# « empreinte_desaccord », comme tous les autres.
#
# Remettre volontairement l'empreinte en accord est une opération
# DISTINCTE et bruyamment nommée : csdj1_identity_boundary_resync. Les
# démonstrations de nocivité du harnais -- qui mutent exprès hors garde --
# sont les seules à l'employer.
csdj1_identity_boundary_prologue_sql() {
  local t d
  t="$(csdj1_identity_boundary_table)"
  d="$(csdj1_identity_boundary_digest)"
  cat <<SQL
  if pg_catalog.to_regclass('public.${t}') is not null then
$(csdj1_identity_boundary_lock_sql)
    if exists (select 1 from public.${t})
       and (select g.digest from public.${t} g) <> public.${d}() then
      raise exception 'SCANYM_IDENTITY_REFUS|empreinte_desaccord';
    end if;
  end if;
SQL
}

# Le RAFRAÎCHISSEMENT, appendu au corps de CHAQUE mutation gardée. Il
# est conditionnel : les clusters sans frontière ne la portent pas, et
# « to_regclass » rend NULL sans lever.
#
# Il est DANS la transaction de la mutation : une mutation gardée et son
# empreinte ne peuvent pas diverger, puisqu'une exception annule les
# deux. C'est ce qui rend l'empreinte une autorité et non un indice.
csdj1_identity_boundary_refresh_sql() {
  local t d
  t="$(csdj1_identity_boundary_table)"
  d="$(csdj1_identity_boundary_digest)"
  cat <<SQL
  if pg_catalog.to_regclass('public.${t}') is not null then
    delete from public.${t};
    insert into public.${t} select public.${d}();
  end if;
SQL
}

# LE point de passage. Toute mutation d'état PostgreSQL d'un harnais
# CSDJ-1 -- mise en place, restauration, nettoyage, repli -- passe par
# ici, et par le MÊME prédicat. Et c'est ici, et nulle part ailleurs,
# que l'empreinte des rôles est rafraîchie.
#
# L'ordre dans la transaction : verrou, état antérieur VÉRIFIÉ, corps,
# état postérieur ENREGISTRÉ. Rien ne s'intercale.
csdj1_identity_mutate() {
  csdj1_identity_run_guarded \
    "$(csdj1_identity_guard_sql)
$(csdj1_identity_marker_sql)" "$(csdj1_identity_boundary_prologue_sql)
$1
$(csdj1_identity_boundary_refresh_sql)"
}

# REMISE EN ACCORD DÉLIBÉRÉE. Elle n'existe que pour les sections du
# harnais qui mutent EXPRÈS hors garde afin d'en démontrer la nocivité :
# elles ont causé le désaccord, elles l'assument. Elle prend le verrou,
# ne vérifie PAS l'état antérieur, et enregistre l'état courant.
#
# Tout autre emploi réintroduirait le trou qu'elle sert à refermer : ses
# appelants sont donc comptés par un test structurel.
csdj1_identity_boundary_resync() {
  csdj1_identity_run_guarded \
    "$(csdj1_identity_guard_sql)
$(csdj1_identity_marker_sql)" "  if pg_catalog.to_regclass('public.$(csdj1_identity_boundary_table)') is not null then
$(csdj1_identity_boundary_lock_sql)
  end if;
$(csdj1_identity_boundary_refresh_sql)"
}

# Pose la frontière sur le cluster du contrat ACTIF, PAR LE CHEMIN
# GARDÉ -- la frontière elle-même ne s'installe donc pas hors garde.
#
#   $1  le rôle du chemin BRUT : créé NOSUPERUSER NOCREATEROLE
#       NOCREATEDB NOBYPASSRLS NOREPLICATION, autorisé à se connecter et
#       à appeler la seule fonction de vérification.
csdj1_identity_boundary_install() {
  local raw="$1" t d c
  case "$raw" in
    [A-Za-z_]*) : ;;
    *) CSDJ1_ID_LAST="role_brut_invalide"; return 1 ;;
  esac
  case "$raw" in
    *[^A-Za-z0-9_]*) CSDJ1_ID_LAST="role_brut_invalide"; return 1 ;;
  esac
  t="$(csdj1_identity_boundary_table)"
  d="$(csdj1_identity_boundary_digest)"
  c="$(csdj1_identity_boundary_check)"
  csdj1_identity_mutate "
  if not exists (select 1 from pg_catalog.pg_roles where rolname = '${raw}') then
    create role ${raw} login nosuperuser nocreaterole nocreatedb nobypassrls noreplication inherit;
  else
    alter role ${raw} login nosuperuser nocreaterole nocreatedb nobypassrls noreplication inherit;
  end if;
  create table public.${t} (digest text primary key);
  -- L'EMPREINTE. Elle couvre ce que « ALTER ROLE » peut changer :
  -- les attributs, la limite de connexions, la date de validité, le
  -- mot de passe, les réglages par rôle (« ALTER ROLE ... SET ... »)
  -- et les appartenances (« GRANT role TO role »). Lire pg_authid
  -- demande le privilège : la fonction est donc SECURITY DEFINER, et
  -- son exécution est RETIRÉE à PUBLIC.
  create function public.${d}() returns text
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as \$csdj1dig\$
    select pg_catalog.md5(coalesce(pg_catalog.string_agg(x, '|' order by x), ''))
      from (
        -- ATTRIBUTS. « format(%L) » cite et échappe chaque champ : un
        -- nom de rôle contenant « : » ne peut pas se faire passer pour
        -- la frontière entre deux champs.
        select pg_catalog.format('R:%L:%L:%L:%L:%L',
                 r.rolname,
                 r.rolsuper::text || r.rolinherit::text || r.rolcreaterole::text
                   || r.rolcreatedb::text || r.rolcanlogin::text
                   || r.rolreplication::text || r.rolbypassrls::text,
                 r.rolconnlimit::text,
                 coalesce(r.rolvaliduntil::text, ''),
                 coalesce(r.rolpassword, '')) as x
          from pg_catalog.pg_authid r
        union all
        -- RÉGLAGES PAR RÔLE ET PAR BASE.
        --
        -- CSDJ1-AUD-07-RUNTIME-ROLE-BOUNDARY-02, défaut F1 : condenser
        -- le seul TEXTE du réglage laissait passer, SANS RIEN CHANGER à
        -- l'empreinte,
        --     alter role R in database db1 reset work_mem;
        --     alter role R in database db2 set   work_mem='1MB';
        -- deux instructions que PostgreSQL accepte et qui déplacent le
        -- réglage d'une base à l'autre. L'IDENTITÉ DE LA BASE fait donc
        -- partie de l'empreinte.
        --
        -- « setdatabase = 0 » signifie « toutes les bases » et
        -- « setrole = 0 » « tous les rôles » : les deux cas sont
        -- CONSERVÉS (jointures EXTERNES -- une jointure interne les
        -- perdait, ce qui rendait « alter database ... set ... »
        -- invisible), et le DRAPEAU précède le nom, de sorte qu'aucune
        -- base réellement nommée ne puisse se confondre avec « toutes ».
        select pg_catalog.format('S:%s:%L:%s:%L:%L',
                 (s.setdatabase = 0)::text,
                 coalesce(d.datname, ''),
                 (s.setrole = 0)::text,
                 coalesce(r.rolname, ''),
                 coalesce(pg_catalog.array_to_string(s.setconfig, ','), '')) as x
          from pg_catalog.pg_db_role_setting s
          left join pg_catalog.pg_database d on d.oid = s.setdatabase
          left join pg_catalog.pg_authid   r on r.oid = s.setrole
        union all
        -- APPARTENANCES.
        select pg_catalog.format('M:%L:%L:%L',
                 a.rolname, b.rolname, m.admin_option::text) as x
          from pg_catalog.pg_auth_members m
          join pg_catalog.pg_authid a on a.oid = m.roleid
          join pg_catalog.pg_authid b on b.oid = m.member
      ) t(x)
  \$csdj1dig\$;
  -- LA VÉRIFICATION, seule fonction accessible au chemin brut. Elle ne
  -- rend qu'un verdict : ni l'empreinte, ni le catalogue.
  create function public.${c}() returns text
  language sql stable security definer
  set search_path = pg_catalog, pg_temp
  as \$csdj1chk\$
    select case
      when (select pg_catalog.count(*) from public.${t}) <> 1 then 'FRONTIERE-NON-ARMEE'
      when (select g.digest from public.${t} g) = public.${d}() then 'OK'
      else 'MUTATION-BRUTE'
    end
  \$csdj1chk\$;
  revoke all on function public.${d}() from public;
  revoke all on function public.${c}() from public;
  grant execute on function public.${c}() to ${raw};
" || return 1
  CSDJ1_ID_CTX_BOUNDARY[$CSDJ1_ID_CONTEXT]="$raw"
  return 0
}

# Retire la frontière, par le chemin gardé. Le rôle brut est conservé :
# il n'a aucun privilège, et le harnais le supprime avec ses autres
# rôles de sonde.
csdj1_identity_boundary_uninstall() {
  local t d c
  [ -n "${CSDJ1_ID_CTX_BOUNDARY[$CSDJ1_ID_CONTEXT]:-}" ] || return 0
  t="$(csdj1_identity_boundary_table)"
  d="$(csdj1_identity_boundary_digest)"
  c="$(csdj1_identity_boundary_check)"
  csdj1_identity_mutate "
  drop function if exists public.${c}();
  drop function if exists public.${d}();
  drop table if exists public.${t};
" && CSDJ1_ID_CTX_BOUNDARY[$CSDJ1_ID_CONTEXT]=""
}

# Retire le marqueur. Gardé comme tout le reste : le marqueur n'est
# supprimé que du serveur qui vient de prouver qu'il est bien le nôtre.
#
# La frontière part DANS LA MÊME instruction gardée : la retirer après
# le marqueur serait impossible -- la garde exige le marqueur -- et la
# retirer avant, dans un appel séparé, laisserait un ordre à respecter,
# donc un ordre à oublier.
csdj1_identity_uninstall() {
  local extra="" t d c
  [ "$CSDJ1_ID_INSTALLED" = "1" ] || return 0
  # La frontière ne part AVEC le marqueur que si c'est CE contrat qui l'a
  # posée. Les objets de la frontière portent un nom FIXE et sont donc
  # partagés par tous les contrats du même cluster : un contrat qui ne
  # les a pas installés ne doit pas les retirer sous les pieds des
  # autres. (v1.10 : il le faisait, et le harnais du lot, lancé par le
  # harnais de rôles sur le MÊME cluster, emportait la frontière à son
  # nettoyage -- le chemin brut se retrouvait alors sans vérification.)
  if [ -n "${CSDJ1_ID_CTX_BOUNDARY[$CSDJ1_ID_CONTEXT]:-}" ]; then
    t="$(csdj1_identity_boundary_table)"
    d="$(csdj1_identity_boundary_digest)"
    c="$(csdj1_identity_boundary_check)"
    extra="  drop function if exists public.${c}();
  drop function if exists public.${d}();
  drop table if exists public.${t};"
  fi
  csdj1_identity_mutate "${extra}
  drop table if exists public.${CSDJ1_ID_MARKER};
" && { CSDJ1_ID_INSTALLED=0; CSDJ1_ID_CTX_INSTALLED[$CSDJ1_ID_CONTEXT]=0
       CSDJ1_ID_CTX_BOUNDARY[$CSDJ1_ID_CONTEXT]=""; }
}

# Preuve SEULE, sans mutation : pour journaliser ou assertionner. Le
# corps est une instruction sans effet, de sorte que le chemin exercé
# soit exactement celui d'une mutation.
csdj1_identity_prove() {
  csdj1_identity_mutate "  perform 1;"
}
