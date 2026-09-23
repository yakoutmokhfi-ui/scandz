#!/usr/bin/env bash
# ============================================================
# Scanym — CUSTOMER FOLLOW-UP + TRACKING EMAIL v1
# Harnais PostgreSQL JETABLE et reproductible pour
#   supabase/DRAFT-lot-customer-followup-tracking-email-v1.sql
#   supabase/DRAFT-lot-customer-followup-tracking-email-v1-rollback.sql
#
# Même patron que supabase/tests/order-success-boundary-v1-check.sh et
# supabase/tests/customer-contact-live-tracking-v1-check.sh : bases
# jetables, rôles anon/authenticated/service_role recréés minimalement,
# auth.uid() simulé via `test.uid`, aucun appel réseau, aucun
# prestataire, aucune donnée réelle.
#
# ------------------------------------------------------------------
# CE QUE CE HARNAIS PROUVE (exécuté, jamais inspecté)
#   [1] le SQL aller s'applique sur le schéma PRÉDÉCESSEUR réel
#       (chaîne de migrations du dépôt jusqu'à main cb56f0c) ;
#   [2] ATOMICITÉ (CFTE-V1-SQL-ATOMICITY-01) : un post-vol qui échoue
#       EMPÊCHE le commit -- ni table, ni fonction, ni redéfinition de
#       create_order ne subsiste. Idem dans le sens retour ;
#   [3] table / RLS / policy / fonctions / grants contractés existent ;
#   [4] accès non autorisé et inter-locataires REFUSÉS là où c'est
#       contracté (anon, staff, owner d'un autre commerçant, capacité
#       de suivi d'une autre commande) ;
#   [5] create_order fonctionne toujours -- modes suivis ET modes non
#       suivis (table/room_service traversent le résolveur inchangés) ;
#   [6] le comportement outbox order_received fonctionne toujours
#       (intention durable, reprise, idempotence, garde tenant croisé,
#       payload ADDITIF) ;
#   [7] le rollback s'applique ;
#   [8] l'état PRÉDÉCESSEUR est restauré suffisamment pour prouver la
#       réversibilité : empreintes de fonctions identiques, résolution
#       d'exigences revenue au catalogue, create_order réaccepte le
#       contrat HISTORIQUE (nom seul, sans e-mail), payload outbox
#       revenu à ses 6 clés, comptes de schéma identiques, et AUCUNE
#       commande perdue.
#
# CE QUE CE HARNAIS NE FAIT PAS : aucun envoi d'e-mail, aucune
# activation de prestataire, aucun travail retrait/paiement/Monetico,
# aucune écriture hors des bases jetables qu'il crée lui-même.
#
# ------------------------------------------------------------------
# SÛRETÉ — NE PEUT PAS VISER PREPROD NI PRODUCTION
#   - refuse de démarrer si DATABASE_URL / PGHOST / PGDATABASE /
#     PGSERVICE / ... désignent un hôte distant ou portent un nom de
#     PREPROD/Production ;
#   - refuse de démarrer si PGHOSTADDR, PGSERVICE ou PGSERVICEFILE sont
#     seulement DÉFINIES (CFTE-V1-HARNESS-CONN-LOCAL-01) : ces trois
#     variables redirigent libpq SANS passer par PGHOST -- PGHOSTADDR
#     court-circuite l'hôte examiné ci-dessus, et PGSERVICE/
#     PGSERVICEFILE font lire hôte, port et base dans un fichier de
#     service que ce harnais ne peut pas auditer ;
#   - ne se contente pas d'inspecter l'ENVIRONNEMENT : il interroge le
#     SERVEUR EFFECTIVEMENT JOINT et refuse d'aller plus loin si la
#     connexion n'est pas une socket UNIX locale ou la boucle locale,
#     AVANT toute opération destructrice ;
#   - refuse de démarrer sur un cluster géré Supabase (rôles
#     supabase_admin/supabase_auth_admin/supabase_storage_admin) ;
#   - ne se connecte qu'aux bases jetables `scanym_cfte_v1_*` qu'il
#     crée lui-même, et les détruit en sortie ;
#   - N'ÉMET AUCUNE instruction de cluster tant que ce verrou n'est pas
#     FRANCHI (CFTE-V1-HARNESS-CONN-LOCAL-02) -- y compris depuis le
#     trap EXIT : un refus déclenché par PGHOSTADDR/PGSERVICE ne doit
#     pas, en se « nettoyant », envoyer des `drop database` vers le
#     serveur non vérifié qu'il vient précisément de refuser ;
#   - ÉCHOUE FERMÉ (sortie non nulle) si aucune base de test n'est
#     disponible : l'absence d'un PostgreSQL de test n'est JAMAIS
#     rapportée comme un succès ni comme un test ignoré.
#
# ------------------------------------------------------------------
# HYGIÈNE DES RÔLES GLOBAUX (CFTE-V1-HARNESS-ROLE-HYGIENE-01)
# Les bases sont jetables, mais les rôles anon / authenticated /
# service_role sont des objets GLOBAUX du cluster : les créer, et
# surtout poser BYPASSRLS sur service_role, DÉBORDE des bases jetables
# et SURVIT au harnais. Ce harnais ne laisse donc plus aucune trace :
#   - il PHOTOGRAPHIE, avant toute mutation, l'existence et les
#     attributs de chacun des trois rôles ;
#   - en sortie -- succès COMME échec, via trap EXIT -- il SUPPRIME les
#     rôles qu'il a lui-même créés et RESTAURE les attributs d'origine
#     de ceux qui préexistaient ; les bases jetables sont détruites
#     D'ABORD, connexions résiduelles coupées, pour qu'aucun privilège
#     ne retienne un `drop role` ;
#   - il RELIT ensuite l'état et le compare à la photographie :
#     si la remise en état a échoué, le harnais le DIT et sort en
#     échec, plutôt que de laisser un cluster silencieusement modifié.
#
# ------------------------------------------------------------------
# MÉCANIQUE DES PREUVES — trois invariants du HARNAIS lui-même, acquis
# après une exécution PostgreSQL réelle (107 PASS / 17 FAIL) dont les 17
# échecs se sont tous révélés être des défauts de TEST, aucun de PRODUIT.
#
#   CFTE-V1-HARNESS-BOOL-RENDER-01 — les booléens de catalogue sont
#   rendus en COLONNES SÉPARÉES (psql -A, séparateur '|'), jamais
#   concaténés via `::text`. `boolean::text` rend 'true'/'false' là où
#   le contrat du dépôt -- et supabase/tests/customer-tracking-
#   capability-v3-1-check.sh -- s'écrit 't'/'f'. Même règle pour les
#   colonnes de type "char" (provolatile), dont la concaténation avec du
#   text rend la requête de preuve inexploitable.
#
#   CFTE-V1-HARNESS-FIXTURE-REAL-PATH-01 — une fixture emprunte le
#   chemin RÉEL et respecte le contrat du lot PRÉDÉCESSEUR. Le jeton
#   legacy est résolu hors bande (RLS de public.orders : aucune policy
#   SELECT pour anon), et seule une capacité kind='email' peut porter un
#   expires_at (contrainte v3.1 order_tracking_capabilities_email_
#   bounded). Une fixture qui contredit le produit ne prouve rien.
#
#   CFTE-V1-HARNESS-QUERY-VISIBLE-01 — aucune erreur de requête de
#   preuve n'est réduite au silence : « vide » est une valeur ATTENDUE
#   par ce harnais, donc une erreur qui se déguise en chaîne vide rend un
#   défaut de TEST indiscernable d'un comportement PRODUIT. Toute requête
#   passe par run_sql, qui imprime l'erreur et rend `<SQL_ERROR: …>`.
#
# ------------------------------------------------------------------
# COMPTE D'ÉVIDENCE (CFTE-V1-EVIDENCE-COUNT-01)
# Le BILAN ci-dessous ne fait PAS confiance à un compteur incrémenté à
# la main : le nombre d'échecs qui fait foi est LU depuis le journal
# brut des échecs (une ligne par échec). Si le compteur et le journal
# divergent -- exactement la forme de défaut signalée par l'audit
# (« total résumé = 1 » alors que l'ensemble brut en contenait 14) --
# le harnais le signale et échoue, plutôt que de publier un résumé plus
# rassurant que ses propres preuves. Voir aussi la note d'attribution
# en fin de fichier.
#
# ------------------------------------------------------------------
# USAGE (depuis la racine du dépôt, sur une machine de développement
# avec un PostgreSQL LOCAL ; PostgreSQL >= 14) :
#
#   sudo -u postgres bash supabase/tests/customer-followup-tracking-email-v1-check.sh
#
# Prérequis : bash, psql, createdb, dropdb ; droit de CREATE DATABASE ;
# le dépôt complet (le harnais rejoue les fichiers de supabase/).
# Sortie 0 = tout est prouvé ; sortie != 0 = au moins une preuve
# manque ou a échoué (le détail brut est imprimé).
# ============================================================

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
FORWARD_SQL="$SUPABASE_DIR/DRAFT-lot-customer-followup-tracking-email-v1.sql"
ROLLBACK_SQL="$SUPABASE_DIR/DRAFT-lot-customer-followup-tracking-email-v1-rollback.sql"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/scanym-cfte-v1-XXXXXX")" || {
  echo "FATAL: impossible de créer un répertoire temporaire." >&2
  exit 1
}
ERR="$TMP/err.txt"
OUT="$TMP/out.txt"
FAIL_LOG="$TMP/fails.log"
: > "$FAIL_LOG"

DB_BASE="scanym_cfte_v1_base_$$"
DB_MAIN="scanym_cfte_v1_main_$$"
DB_NOPREREQ="scanym_cfte_v1_noprereq_$$"
DB_ATOMIC_FWD="scanym_cfte_v1_atomic_fwd_$$"
DB_ATOMIC_RB="scanym_cfte_v1_atomic_rb_$$"
ALL_DBS="$DB_MAIN $DB_NOPREREQ $DB_ATOMIC_FWD $DB_ATOMIC_RB $DB_BASE"

PASS_COUNT=0
FAIL_COUNT=0

log()  { printf '[%s] %s\n' "$(date -u '+%H:%M:%S')" "$*"; }
pass() { PASS_COUNT=$((PASS_COUNT + 1)); log "PASS: $*"; }
# Un échec = EXACTEMENT une ligne dans le journal brut (les retours à la
# ligne d'une valeur observée sont aplatis) : c'est ce qui rend
# `wc -l` du journal rigoureusement égal au nombre d'échecs, et donc
# l'auto-test du BILAN exact plutôt qu'approximatif.
fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf '%s\n' "$(printf '%s' "$*" | tr '\n\r' '  ')" >> "$FAIL_LOG"
  log "FAIL: $*"
}

# FATAL = le harnais n'a pas pu PRODUIRE la preuve. Jamais un succès,
# jamais un « ignoré » : sortie non nulle, toujours.
fatal() { log "FATAL: $*"; log "=== BILAN : preuve IMPOSSIBLE à produire -- échec fermé ==="; exit 1; }

# ============================================================
# HYGIÈNE DES RÔLES GLOBAUX — CFTE-V1-HARNESS-ROLE-HYGIENE-01
#
# anon / authenticated / service_role sont CLUSTER-GLOBAUX. L'amorçage
# de [0] les crée s'ils manquent et pose/retire BYPASSRLS : deux
# mutations qui, sans ce bloc, SURVIVRAIENT au harnais et modifieraient
# un cluster de développement partagé. On photographie donc l'état
# AVANT toute mutation, et on le rend EXACTEMENT en sortie.
# ============================================================
APP_ROLES="anon authenticated service_role"
ROLE_SNAPSHOT_TAKEN=0   # 1 dès que la photographie est prise (et donc
                        # dès que la restauration devient obligatoire)
CLEANUP_DIRTY=0         # 1 si le cluster n'a PAS pu être rendu intact
RESTORE_RETRY=0         # 1 si une première passe de remise en état a
                        # divergé et qu'une seconde passe est requise

# CFTE-V1-HARNESS-CONN-LOCAL-02 — LE NETTOYAGE EST LUI AUSSI DESTRUCTEUR.
# Tant que le verrou de sûreté n'a pas été FRANCHI (environnement audité
# ET connexion effective prouvée locale), le trap EXIT ne doit émettre
# AUCUNE instruction de cluster : sinon un `fatal` déclenché par
# PGHOSTADDR/PGSERVICE -- donc précisément parce que la cible est
# potentiellement PREPROD/Production -- ferait quand même partir cinq
# `drop database if exists` vers ce serveur non vérifié. Avant le
# franchissement, rien n'a été créé : le nettoyage n'a donc rien à faire
# hors du répertoire temporaire.
SAFETY_LOCK_PASSED=0

# État capturé : existence + TOUS les attributs booléens de pg_roles +
# la limite de connexions. C'est une sur-couverture délibérée des seuls
# attributs que ce harnais touche réellement (LOGIN à la création,
# BYPASSRLS ensuite) : restaurer un attribut qui n'a pas bougé est un
# no-op, alors qu'en oublier un laisserait une dérive invisible.
role_state() {
  psql -X -A -q -t -d postgres -c "
    select coalesce((select 'EXISTS|' || rolsuper::text
                            || '|' || rolinherit::text
                            || '|' || rolcreaterole::text
                            || '|' || rolcreatedb::text
                            || '|' || rolcanlogin::text
                            || '|' || rolreplication::text
                            || '|' || rolbypassrls::text
                            || '|' || rolconnlimit::text
                     from pg_roles where rolname = '$1'), 'ABSENT');" \
    </dev/null 2>/dev/null | tail -1 | tr -d ' '
}

# Photographie. Si l'état d'un seul rôle est ILLISIBLE, on refuse de
# muter : on ne touche pas à un cluster qu'on ne saurait pas remettre
# en état.
snapshot_roles() {
  local r state
  for r in $APP_ROLES; do
    state="$(role_state "$r")"
    case "$state" in
      ABSENT | EXISTS'|'*) : ;;
      *) fatal "état initial du rôle global '$r' illisible -- refus de muter un cluster dont l'état ne pourrait pas être restauré." ;;
    esac
    printf -v "ROLE_SNAP_$r" '%s' "$state"
  done
  ROLE_SNAPSHOT_TAKEN=1
}

# 't'/'f' -> mot-clé ALTER ROLE, ou sa négation.
role_attr() { if [ "$1" = "t" ]; then printf '%s' "$2"; else printf 'no%s' "$2"; fi; }

# Remise en état. Appelée par le trap EXIT : elle s'exécute donc sur
# SUCCÈS COMME SUR ÉCHEC, y compris après un `fatal`.
#
# $1 = 'quiet'  -> première passe : une divergence arme RESTORE_RETRY
#                  plutôt que de condamner tout de suite ;
#      'report' -> passe FINALE : une divergence rend le cluster SALE et
#                  fait sortir le harnais en échec.
restore_roles() {
  [ "$ROLE_SNAPSHOT_TAKEN" = "1" ] || return 0
  local mode="${1:-report}"
  local r var state tag sup inh crole cdb login repl bypass climit after
  for r in $APP_ROLES; do
    var="ROLE_SNAP_$r"
    state="${!var:-}"
    case "$state" in
      ABSENT)
        # Rôle CRÉÉ par ce harnais : il ne doit pas lui survivre. Les
        # bases jetables ont déjà été détruites, donc plus aucun
        # privilège ne le retient.
        psql -X -q -d postgres -c "drop role if exists \"$r\";" </dev/null >/dev/null 2>&1 || true
        ;;
      EXISTS'|'*)
        # Rôle PRÉEXISTANT : on lui rend ses attributs d'origine.
        IFS='|' read -r tag sup inh crole cdb login repl bypass climit <<<"$state"
        case "$climit" in ''|*[!0-9-]*) climit='-1' ;; esac
        psql -X -q -d postgres -c "alter role \"$r\" \
          $(role_attr "$sup" superuser) \
          $(role_attr "$inh" inherit) \
          $(role_attr "$crole" createrole) \
          $(role_attr "$cdb" createdb) \
          $(role_attr "$login" login) \
          $(role_attr "$repl" replication) \
          $(role_attr "$bypass" bypassrls) \
          connection limit $climit;" </dev/null >/dev/null 2>&1 || true
        ;;
      *) continue ;;
    esac
    # AUTO-TEST DE LA REMISE EN ÉTAT : l'état RELU doit être exactement
    # celui d'avant. Un harnais qui salit le cluster ne doit jamais
    # sortir 0 -- même posture que l'auto-test du BILAN.
    after="$(role_state "$r")"
    if [ "$after" != "$state" ]; then
      if [ "$mode" = "quiet" ]; then
        RESTORE_RETRY=1
      else
        CLEANUP_DIRTY=1
        printf '[cleanup] rôle global %s NON restauré (avant=%s / après=%s).\n' "$r" "$state" "$after" >&2
      fi
    fi
  done
}

cleanup() {
  CLEANUP_RC=$?
  local db list
  # CFTE-V1-HARNESS-CONN-LOCAL-02 — aucune instruction de cluster tant
  # que le verrou de sûreté n'a pas été franchi : à ce stade le harnais
  # n'a créé NI base NI rôle, il n'y a donc rien à défaire, et émettre
  # des `drop database` vers un serveur que l'on vient justement de
  # refuser serait l'exact contraire d'un échec fermé.
  if [ "$SAFETY_LOCK_PASSED" = "1" ]; then
    # Une session encore ouverte sur une base jetable ferait échouer son
    # `drop database`, puis -- par ricochet, via les privilèges que cette
    # base porte encore -- le `drop role` du nettoyage : on coupe donc
    # d'abord les connexions, et UNIQUEMENT celles des bases jetables que
    # ce harnais a lui-même créées.
    list=""
    for db in $ALL_DBS; do list="$list${list:+,}'$db'"; done
    psql -X -q -d postgres -c \
      "select pg_terminate_backend(pid) from pg_stat_activity where datname in ($list) and pid <> pg_backend_pid();" \
      </dev/null >/dev/null 2>&1 || true
    for db in $ALL_DBS; do
      psql -X -q -d postgres -c "drop database if exists \"$db\";" </dev/null >/dev/null 2>&1 || true
    done
    # Les bases jetables partent AVANT les rôles : sinon `drop role`
    # buterait sur les privilèges que ces bases leur portent encore.
    # Première passe SILENCIEUSE ; si elle diverge (verrou momentané,
    # connexion résiduelle), une seconde passe tranche pour de bon.
    RESTORE_RETRY=0
    restore_roles quiet
    [ "$RESTORE_RETRY" = "0" ] || restore_roles report
  fi
  rm -rf "$TMP" 2>/dev/null || true
  if [ "$CLEANUP_DIRTY" != "0" ]; then
    printf '[cleanup] FATAL: le cluster ne retrouve PAS son état initial (rôles globaux) -- échec fermé.\n' >&2
    exit 1
  fi
  exit "$CLEANUP_RC"
}
trap cleanup EXIT
# Un signal ne doit pas court-circuiter la remise en état du cluster :
# ces traps se contentent de PROVOQUER une sortie, et c'est le trap
# EXIT -- donc `cleanup`, donc `restore_roles` -- qui s'exécute ensuite,
# une fois et une seule.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# ============================================================
# SÛRETÉ — verrou anti-PREPROD / anti-Production, AVANT toute connexion
# ============================================================
log "=== [S] Verrou de sûreté ==="

# Motifs d'environnement interdits. Les mots sont bornés (`[^a-z]`) pour
# qu'un chemin de socket anodin (…/oliver/…) ne déclenche pas un faux
# refus, tandis que les formes d'hébergement géré restent attrapées.
FORBIDDEN_RE='(^|[^a-z])(prod|preprod|pre-prod|production|staging|recette|live)([^a-z]|$)|supabase\.(co|in)|pooler\.|\.rds\.|\.azure|amazonaws'
for v in DATABASE_URL POSTGRES_URL POSTGRES_URL_NON_POOLING SUPABASE_DB_URL SUPABASE_URL PGURI PGHOST PGDATABASE PGSERVICE; do
  value="${!v:-}"
  if [ -n "$value" ] && printf '%s' "$value" | grep -Eiq "$FORBIDDEN_RE"; then
    fatal "$v désigne un environnement interdit ('$value'). Ce harnais ne vise QUE des bases jetables locales."
  fi
done

case "${PGHOST:-}" in
  "" | localhost | 127.0.0.1 | ::1 | /*) : ;;
  *) fatal "PGHOST='$PGHOST' n'est ni une socket locale ni la boucle locale -- refus." ;;
esac

# ------------------------------------------------------------------
# CFTE-V1-HARNESS-CONN-LOCAL-01 — variables qui CONTOURNENT PGHOST
#
# Le contrôle PGHOST ci-dessus ne suffit pas : libpq offre trois voies
# de redirection qui ne passent pas par lui.
#   - PGHOSTADDR fournit l'adresse IP du serveur et PRIME sur PGHOST :
#     un PGHOST='localhost' rassurant peut ainsi joindre une machine
#     distante ;
#   - PGSERVICE désigne une entrée d'un fichier de service qui porte
#     ses propres host/hostaddr/port/dbname ;
#   - PGSERVICEFILE déplace ce fichier de service vers un chemin
#     arbitraire.
# Aucune des trois n'est nécessaire à ce harnais, qui ne se connecte
# qu'en local. Leur seule PRÉSENCE dans l'environnement -- même vide --
# fait donc échouer fermé : on refuse plutôt que de tenter d'auditer un
# fichier de service dont on ne contrôle ni le contenu ni la résolution.
if [ -n "${PGHOSTADDR+defini}" ]; then
  fatal "PGHOSTADDR est définie ('${PGHOSTADDR}') : elle PRIME sur PGHOST et peut envoyer la connexion hors de cette machine. Retirez-la de l'environnement (unset PGHOSTADDR) avant de lancer ce harnais."
fi
if [ -n "${PGSERVICE+defini}" ]; then
  fatal "PGSERVICE est définie ('${PGSERVICE}') : l'hôte, le port et la base viendraient d'un fichier de service non auditable. Retirez-la de l'environnement (unset PGSERVICE) avant de lancer ce harnais."
fi
if [ -n "${PGSERVICEFILE+defini}" ]; then
  fatal "PGSERVICEFILE est définie ('${PGSERVICEFILE}') : elle désigne un fichier de service non auditable. Retirez-la de l'environnement (unset PGSERVICEFILE) avant de lancer ce harnais."
fi

# Une base par défaut héritée de l'environnement ne doit JAMAIS devenir
# la cible implicite d'une commande de ce harnais.
unset PGDATABASE

command -v psql      >/dev/null 2>&1 || fatal "psql introuvable -- aucune base de test disponible."
command -v createdb  >/dev/null 2>&1 || fatal "createdb introuvable -- aucune base de test disponible."

psql -X -q -d postgres -c 'select 1;' >/dev/null 2>"$ERR" \
  || fatal "aucun serveur PostgreSQL de test joignable ($(tr '\n' ' ' < "$ERR"))."

# ------------------------------------------------------------------
# CFTE-V1-HARNESS-CONN-LOCAL-01 — vérification de la connexion EFFECTIVE
#
# Tout ce qui précède n'inspecte que l'ENVIRONNEMENT. Ici on demande au
# SERVEUR LUI-MÊME d'où il répond et d'où il nous voit, AVANT la
# moindre opération destructrice (createdb / drop database / create
# role). inet_server_addr() et inet_client_addr() valent NULL sur une
# socket UNIX locale ; sur TCP elles doivent être la boucle locale.
# Toute autre valeur -- ou une valeur illisible -- fait échouer fermé.
SERVER_ADDR="$(psql -X -A -q -t -d postgres -c "select coalesce(host(inet_server_addr()), 'unix-socket');" 2>/dev/null | tail -1 | tr -d ' ')"
case "$SERVER_ADDR" in
  unix-socket | 127.* | ::1 | 0:0:0:0:0:0:0:1) : ;;
  "") fatal "impossible de déterminer l'adresse du serveur PostgreSQL joint -- refus de muter un cluster non identifié." ;;
  *)  fatal "le serveur PostgreSQL joint répond depuis '$SERVER_ADDR' : ce n'est ni une socket locale ni la boucle locale. Refus catégorique." ;;
esac

CLIENT_ADDR="$(psql -X -A -q -t -d postgres -c "select coalesce(host(inet_client_addr()), 'unix-socket');" 2>/dev/null | tail -1 | tr -d ' ')"
case "$CLIENT_ADDR" in
  unix-socket | 127.* | ::1 | 0:0:0:0:0:0:0:1) : ;;
  "") fatal "impossible de déterminer l'adresse client vue par le serveur PostgreSQL -- refus de muter un cluster non identifié." ;;
  *)  fatal "le serveur PostgreSQL nous voit arriver depuis '$CLIENT_ADDR' : la connexion n'est pas locale. Refus catégorique." ;;
esac
log "connexion effective vérifiée côté SERVEUR : serveur=$SERVER_ADDR, client=$CLIENT_ADDR (local/boucle locale)."

MANAGED="$(psql -X -A -q -t -d postgres -c "select count(*) from pg_roles where rolname in ('supabase_admin','supabase_auth_admin','supabase_storage_admin');" 2>/dev/null | tr -d ' ')"
[ "$MANAGED" = "0" ] || fatal "ce cluster porte des rôles Supabase gérés -- il ressemble à PREPROD/Production. Refus catégorique."

# VERROU FRANCHI. Toutes les preuves de localité sont acquises :
# environnement audité, connexion EFFECTIVE prouvée locale des DEUX
# côtés, cluster non géré. C'est SEULEMENT à partir d'ici que le trap
# EXIT s'autorise à émettre des instructions de cluster -- et c'est
# aussi à partir d'ici, et pas avant, que le harnais mute quoi que ce
# soit (photographie des rôles, puis création des bases jetables).
SAFETY_LOCK_PASSED=1

for f in "$FORWARD_SQL" "$ROLLBACK_SQL"; do
  [ -f "$f" ] || fatal "fichier du lot introuvable : $f"
done

# ------------------------------------------------------------------
# CFTE-V1-HARNESS-ROLE-HYGIENE-01 — photographie des rôles GLOBAUX,
# prise ICI parce que la première mutation de rôle a lieu plus bas,
# dans l'amorçage de [0]. Tant que cette photographie n'est pas prise,
# le trap EXIT ne touche à aucun rôle (rien n'a encore été modifié).
snapshot_roles
ROLES_PREEXISTING=""
ROLES_CREATED_HERE=""
for r in $APP_ROLES; do
  snap_var="ROLE_SNAP_$r"
  case "${!snap_var}" in
    ABSENT) ROLES_CREATED_HERE="$ROLES_CREATED_HERE $r" ;;
    *)      ROLES_PREEXISTING="$ROLES_PREEXISTING $r" ;;
  esac
done
log "rôles globaux photographiés -- préexistants (attributs RESTAURÉS en sortie) :${ROLES_PREEXISTING:- aucun} ; à créer par le harnais (SUPPRIMÉS en sortie) :${ROLES_CREATED_HERE:- aucun}"

log "verrou de sûreté franchi : cluster local non géré, bases jetables uniquement."

# ============================================================
# Outils
# ============================================================
DB=""   # base courante ciblée par les helpers

apply_file() { psql -X -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$1" >/dev/null 2>"$ERR"; }
apply_path() { psql -X -d "$2" -v ON_ERROR_STOP=1 -f "$1" >"$OUT" 2>&1; }

# ------------------------------------------------------------------
# CFTE-V1-HARNESS-QUERY-VISIBLE-01 — UNE REQUÊTE DE PREUVE QUI ÉCHOUE
# NE DOIT JAMAIS RESSEMBLER À UN ENSEMBLE VIDE.
#
# « Vide » est une valeur ATTENDUE par plusieurs assertions de ce harnais
# (les ensembles vides de la section [7] : capacité croisée, secret
# erroné, capacité expirée). Si une erreur SQL -- signature absente,
# argument invalide, privilège manquant -- est réduite à la même chaîne
# vide, alors un défaut de TEST devient rigoureusement indiscernable d'un
# comportement PRODUIT correct, et le diagnostic est perdu.
#
# Toute requête de preuve passe donc par ce lanceur unique :
#   - psql réussit  -> la sortie est rendue TELLE QUELLE (stderr, donc
#     les NOTICE, reste à l'écart : la valeur n'est jamais polluée) ;
#   - psql échoue   -> le message est imprimé sur la sortie d'erreur ET
#     la valeur rendue devient le marqueur `<SQL_ERROR: …>`.
# Le harnais reste FERMÉ : ce marqueur n'est égal à AUCUNE valeur
# attendue, donc l'assertion échoue -- mais en DISANT pourquoi.
#
# $1 = base, $2 = rôle applicatif ('' = connexion propriétaire du
# harnais), $3 = auth.uid() simulé ('' = aucun), $4 = requête.
run_sql() {
  local db="$1" role="$2" uid="$3" query="$4" out rc msg
  if [ -n "$role" ] && [ -n "$uid" ]; then
    out="$(PGOPTIONS="-c role=$role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$db" \
            -c "set test.uid = '$uid';" -c "$query" 2>"$ERR")"
  elif [ -n "$role" ]; then
    out="$(PGOPTIONS="-c role=$role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$db" \
            -c "$query" 2>"$ERR")"
  else
    out="$(psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$db" -c "$query" 2>"$ERR")"
  fi
  rc=$?
  if [ "$rc" -ne 0 ]; then
    msg="$(tr '\n\r' '  ' < "$ERR" | cut -c1-220)"
    printf '[%s] SQL-ERROR (base=%s role=%s) : %s\n' \
      "$(date -u '+%H:%M:%S')" "$db" "${role:-<proprietaire>}" "$msg" >&2
    printf '<SQL_ERROR: %s>\n' "$msg"
    return 0
  fi
  printf '%s\n' "$out"
}

sql()       { run_sql "$DB" '' '' "$1"; }
sql_value() { sql "$1" | tail -1 | tr -d ' '; }
sql_raw()   { sql "$1" | tail -1; }
sql_on()    { run_sql "$1" '' '' "$2" | tail -1 | tr -d ' '; }

# Valeur lue sous un rôle applicatif donné (auth.uid() simulé).
value_as() {
  local role="$1" uid="$2" query="$3"
  run_sql "$DB" "$role" "$uid" "$query" | tail -1 | tr -d ' '
}

# "OK" si l'instruction réussit, sinon le PREMIER message d'erreur
# normalisé. La sortie est entièrement capturée en mémoire : aucun tube
# depuis psql, donc aucun SIGPIPE ni troncature (leçon V67C/V71-01).
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

# Verdict INDÉPENDANT DE LA LOCALE du serveur : les messages produits par
# PostgreSQL lui-même (« permission denied … ») sont traduits selon
# lc_messages, donc jamais comparés tels quels. Les messages qui
# APPARTIENNENT à Scanym (SCANYM_*, « Forbidden », « Authentication
# required ») sont, eux, comparés littéralement : ils font partie du
# contrat et ne sont pas traduits.
refused() { if [ "$1" = "OK" ]; then printf 'AUTORISE\n'; else printf 'REFUSE\n'; fi; }

# ------------------------------------------------------------------
# CFTE-V1-HARNESS-BOOL-RENDER-01 — RENDU DES BOOLÉENS DE CATALOGUE
#
# PostgreSQL dispose de DEUX rendus textuels du type boolean, et ils ne
# coïncident pas :
#   - la fonction de sortie du type, employée par psql pour une COLONNE
#     de résultat            -> 't' / 'f' ;
#   - le transtypage `::text`, qui rend la forme canonique SQL
#                            -> 'true' / 'false'.
# Les assertions d'ACL/RLS de ce harnais sont écrites -- comme celles de
# supabase/tests/customer-tracking-capability-v3-1-check.sh, contrat de
# référence du dépôt -- dans la forme 't'/'f'. Une requête de preuve ne
# doit donc JAMAIS concaténer des booléens avec `::text || '|' || …` :
# elle produirait 'true|false' et ferait échouer une assertion dont la
# SÉMANTIQUE est pourtant satisfaite.
#
# Règle tenue partout ci-dessous : les valeurs composées sont rendues en
# COLONNES SÉPARÉES, et c'est `psql -A` (séparateur '|') qui les joint.
# Trois bénéfices, pas un seul :
#   1. les booléens gardent le rendu contracté 't'/'f' ;
#   2. les types non-text (`provolatile`, de type "char") ne passent plus
#      par un opérateur `||` dont la résolution avec `text` est ambiguë
#      -- une erreur SQL qui, elle, rendait la valeur VIDE ;
#   3. un NULL isolé reste un champ vide LOCALISÉ, au lieu d'annuler
#      toute la concaténation et de faire disparaître les autres preuves.
# ------------------------------------------------------------------

# Empreinte STRICTE : définition COMPLÈTE (commentaires du corps inclus)
# + ACL. Deux empreintes égales = fonction bit-à-bit identique. Sert à
# prouver qu'une fonction n'a PAS ÉTÉ TOUCHÉE DU TOUT.
fn_fingerprint() {
  run_sql "${2:-$DB}" '' '' "
    select coalesce(md5(string_agg(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '<null>'), '#'
             order by n.nspname || '.' || p.proname || '(' || replace(oidvectortypes(p.proargtypes), ' ', '') || ')')), 'absent')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '$1';" | tail -1 | tr -d ' '
}

# Empreinte du CODE SEUL : commentaires de ligne retirés, espaces
# normalisés, ACL exclues. Sert au sens RETOUR : le rollback réécrit le
# corps d'origine SANS recopier la prose de commentaires du fichier
# source -- attendu et sans conséquence, car ce qui doit revenir à
# l'identique est le CODE EXÉCUTÉ, pas la documentation qui l'entourait.
# Les privilèges sont vérifiés séparément (3n/3o et 10c-bis).
fn_code_fingerprint() {
  run_sql "${2:-$DB}" '' '' "
    select coalesce(md5(string_agg(
             regexp_replace(regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g'), '[[:space:]]+', ' ', 'g'),
             '#' order by n.nspname || '.' || p.proname || '(' || replace(oidvectortypes(p.proargtypes), ' ', '') || ')')), 'absent')
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

cfte_footprint() {
  local db="$1"
  printf '%s|%s|%s|%s|%s\n' \
    "$(sql_on "$db" "select (to_regclass('public.merchant_tracking_status_text') is not null)::int;")" \
    "$(sql_on "$db" "select (to_regprocedure('public.customer_tracked_service_modes()') is not null)::int;")" \
    "$(sql_on "$db" "select (to_regprocedure('public.set_merchant_tracking_status_text(uuid,text,text)') is not null)::int;")" \
    "$(sql_on "$db" "select (to_regprocedure('public.get_order_tracking_status_text_by_capability(uuid,uuid,text)') is not null)::int;")" \
    "$(sql_on "$db" "select (pg_get_functiondef(p.oid) like '%customer_tracked_service_modes%')::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_order';")"
}

clone_base() {
  local target="$1"
  psql -X -q -d postgres -c "drop database if exists \"$target\";" >/dev/null 2>&1
  createdb -T "$DB_BASE" "$target" 2>"$ERR" \
    || fatal "clonage de la base prédécesseur vers $target impossible ($(tr '\n' ' ' < "$ERR"))."
}

# ============================================================
# Identifiants synthétiques (aucune donnée réelle)
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

# ============================================================
# [0] Chaîne PRÉDÉCESSEUR (main cb56f0c) dans une base jetable modèle
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
         migration-20260919000000-order-success-boundary-v1.sql $TRACKING_TAIL; do
  [ -f "$SUPABASE_DIR/$f" ] || fatal "maillon de chaîne prédécesseur absent : supabase/$f"
done

psql -X -q -d postgres -c "drop database if exists \"$DB_BASE\";" >/dev/null 2>&1
createdb "$DB_BASE" 2>"$ERR" || fatal "création de la base jetable impossible ($(tr '\n' ' ' < "$ERR"))."
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

# N1-A exige le create_order 8 arguments introduit par CGV v1.1 ; les
# remplacements CGV ultérieurs retirent ensuite l'enfilement direct.
apply_file "DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql" || fatal "CGV v1.1 : $(head -3 "$ERR" | tr '\n' ' ')"
apply_file "DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql" || fatal "N1-A : $(head -3 "$ERR" | tr '\n' ' ')"
for f in $CGV_AFTER_N1A_CHAIN; do
  apply_file "$f" || fatal "chaîne CGV, $f : $(head -3 "$ERR" | tr '\n' ' ')"
done
psql -X -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
apply_file "DRAFT-lot-order-received-enqueue-recovery-v1.sql" || fatal "reprise d'enfilement : $(head -3 "$ERR" | tr '\n' ' ')"
apply_file "migration-20260919000000-order-success-boundary-v1.sql" || fatal "ORDER SUCCESS BOUNDARY v1 : $(head -3 "$ERR" | tr '\n' ' ')"

# La chaîne de SUIVI exige public.order_invoice_request (existence
# SEULE -- TRACKING FISCAL SUMMARY v1.1 n'en lit jamais le contenu).
# Même talon que supabase/tests/customer-contact-live-tracking-v1-check.sh.
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

log "chaîne prédécesseur appliquée (schema .. ORDER SUCCESS BOUNDARY v1 + suivi v3.1 + CCLT v1)."

# --- Fixtures synthétiques, POSÉES AVANT le lot (commerçants historiques)
psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<SQL || fatal "fixtures : $(tr '\n' ' ' < "$ERR")"
insert into auth.users (id, email) values
  ('$OWNER_A','owner-a@cfte.test'), ('$MANAGER_A','manager-a@cfte.test'),
  ('$STAFF_A','staff-a@cfte.test'),  ('$OWNER_B','owner-b@cfte.test');

insert into public.restaurants (id, slug, name, is_active, status, country) values
  ('$RID_A','cfte-alpha','Epicerie Alpha',true,'active','FR'),
  ('$RID_B','cfte-beta','Maison Beta',true,'active','FR');
insert into public.restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number) values
  ('$RID_A','EUR',1,'+33600007001'), ('$RID_B','EUR',1,'+33600007002');
insert into public.restaurant_users (restaurant_id, user_id, role) values
  ('$RID_A','$OWNER_A','owner'), ('$RID_A','$MANAGER_A','manager'),
  ('$RID_A','$STAFF_A','staff'), ('$RID_B','$OWNER_B','owner');

insert into public.menu_categories (id, restaurant_id, name, display_order, is_active) values
  ('$CAT_A','$RID_A','Cat A',1,true), ('$CAT_B','$RID_B','Cat B',1,true);
insert into public.menu_items (id, category_id, name, price, is_available, tax_rate) values
  ('$ITEM_A','$CAT_A','Item A',10.00,true,5.5), ('$ITEM_B','$CAT_B','Item B',11.00,true,5.5);

-- Modes de vente : A porte un mode SUIVI (pickup, delivery) ET un mode
-- NON suivi (table) -- le second sert de témoin de non-régression.
insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled) values
  ('$RID_A','pickup',true), ('$RID_A','table',true), ('$RID_B','pickup',true);
insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled, config) values
  ('$RID_A','delivery',true,'{"delivery_zone_prefixes":["75"],"delivery_min_items":0}'::jsonb);

insert into public.merchant_notification_profile
  (restaurant_id, email_enabled, sender_name, sender_email, reply_to, default_locale) values
  ('$RID_A',true,'Epicerie Alpha','sender-a@cfte.test','reply-a@cfte.test','fr'),
  ('$RID_B',true,'Maison Beta','sender-b@cfte.test','reply-b@cfte.test','fr');
SQL

# Commande HISTORIQUE créée sous le contrat PRÉDÉCESSEUR (nom seul +
# téléphone, AUCUN e-mail) : elle doit survivre au lot et au rollback.
LEGACY_ORDER="$(PGOPTIONS='-c role=anon' psql -X -A -q -t -d "$DB" -v ON_ERROR_STOP=1 -c \
  "select order_id from public.create_order('cfte-alpha','pickup','[{\"menu_item_id\":\"$ITEM_A\",\"quantity\":1,\"option_item_id\":null}]'::jsonb,null,'{\"name\":\"Client Historique\",\"phone\":\"0600000000\"}'::jsonb,null,'fr',false);" \
  2>"$ERR" | tail -1 | tr -d ' ')"
[ "${#LEGACY_ORDER}" -eq 36 ] || fatal "le contrat PRÉDÉCESSEUR de create_order ne fonctionne pas : $(head -3 "$ERR" | tr '\n' ' ')"

log "=== [0b] Contrat PRÉDÉCESSEUR mesuré (référence de réversibilité) ==="
REQS_PICKUP_BEFORE="$(sql_raw "select coalesce(string_agg(field||':'||requirement||':'||coalesce(one_of_group,'-'), ',' order by field),'<vide>') from public.effective_sale_mode_field_requirements('$RID_A','pickup');")"
REQS_DELIVERY_BEFORE="$(sql_raw "select coalesce(string_agg(field||':'||requirement||':'||coalesce(one_of_group,'-'), ',' order by field),'<vide>') from public.effective_sale_mode_field_requirements('$RID_A','delivery');")"
REQS_TABLE_BEFORE="$(sql_raw "select coalesce(string_agg(field||':'||requirement||':'||coalesce(one_of_group,'-'), ',' order by field),'<vide>') from public.effective_sale_mode_field_requirements('$RID_A','table');")"
assert_eq "0b1. PRÉDÉCESSEUR — pickup suit le catalogue LOT 2A" \
  "customer_name:required:-,email:one_of:contact,phone:one_of:contact" "$REQS_PICKUP_BEFORE"
assert_eq "0b2. PRÉDÉCESSEUR — delivery suit le catalogue LOT 2A (e-mail OPTIONNEL)" \
  "customer_name:required:-,delivery_address:required:-,email:optional:-,phone:required:-" "$REQS_DELIVERY_BEFORE"
assert_eq "0b3. PRÉDÉCESSEUR — table (mode NON suivi)" "table_number:required:-" "$REQS_TABLE_BEFORE"

FP_CREATE_ORDER_BEFORE="$(fn_fingerprint create_order)"
FP_RESOLVER_BEFORE="$(fn_fingerprint effective_sale_mode_field_requirements)"
FP_NOTIF_BEFORE="$(fn_fingerprint create_order_received_notification)"
FP_UPDATE_STATUS_BEFORE="$(fn_fingerprint update_order_status)"
FP_TRACK_CAP_BEFORE="$(fn_fingerprint get_order_tracking_by_capability)"
# Empreintes de CODE (commentaires exclus) : référence du sens RETOUR.
FPC_CREATE_ORDER_BEFORE="$(fn_code_fingerprint create_order)"
FPC_RESOLVER_BEFORE="$(fn_code_fingerprint effective_sale_mode_field_requirements)"
FPC_NOTIF_BEFORE="$(fn_code_fingerprint create_order_received_notification)"
ACL_BEFORE="$(sql_raw "select coalesce(string_agg(p.proname || '=' || coalesce(p.proacl::text,'<null>'), ';' order by p.proname),'-') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('create_order','effective_sale_mode_field_requirements','create_order_received_notification');")"
COUNTS_BEFORE="$(schema_counts "$DB")"
assert_eq "0b4. empreintes prédécesseur capturées (create_order, résolveur, enfilement)" "1" \
  "$([ "$FP_CREATE_ORDER_BEFORE" != absent ] && [ "$FP_RESOLVER_BEFORE" != absent ] && [ "$FP_NOTIF_BEFORE" != absent ] && echo 1 || echo 0)"
assert_eq "0b5. PRÉDÉCESSEUR — le lot CFTE v1 est bien ABSENT" "0|0|0|0|0" "$(cfte_footprint "$DB")"

# Comportement outbox order_received AVANT le lot (payload de référence).
# Passe par run_sql : une reprise qui échouerait ne doit pas laisser la
# preuve suivante lire un outbox vide sans qu'on sache pourquoi.
run_sql "$DB" service_role '' \
  "select 1 from public.recover_missing_order_received_notifications('$RID_A',100);" >/dev/null
PAYLOAD_KEYS_BEFORE="$(sql_raw "select coalesce(string_agg(k, ',' order by k),'<vide>') from public.notification_outbox o, jsonb_object_keys(o.payload_snapshot) k where o.order_id='$LEGACY_ORDER';")"
assert_eq "0b6. PRÉDÉCESSEUR — payload order_received = 6 clés historiques" \
  "created_at,currency,order_number,public_token,service_mode,total" "$PAYLOAD_KEYS_BEFORE"

ORDERS_BEFORE="$(sql_value "select count(*) from public.orders;")"
ITEMS_BEFORE="$(sql_value "select count(*) from public.order_items;")"
# Lignes de RÈGLES avant le lot : la précédence doit être appliquée à la
# RÉSOLUTION seule, donc aucune de ces deux tables ne doit bouger.
RULE_ROWS_BEFORE="$(sql_raw "select (select count(*) from public.sale_mode_field_requirements)::text||'|'||(select count(*) from public.restaurant_sale_mode_field_requirements)::text;")"

# ============================================================
# [1] ATOMICITÉ — sens ALLER : un post-vol qui échoue empêche le commit
# ============================================================
log "=== [1] ATOMICITÉ (aller) — CFTE-V1-SQL-ATOMICITY-01 ==="

clone_base "$DB_ATOMIC_FWD"
# On fabrique un échec de POST-VOL, et LUI SEUL : anon perd EXECUTE sur
# get_restaurant_public_field_requirements. Le PRÉ-VOL ne regarde pas ce
# privilège (donc le lot démarre et crée réellement ses objets) ; le
# POST-VOL, lui, lève SCANYM_REGRESSION. Avant la remédiation, ce
# post-vol s'exécutait APRÈS `commit;` : la base restait modifiée.
psql -X -d "$DB_ATOMIC_FWD" -v ON_ERROR_STOP=1 \
  -c "revoke execute on function public.get_restaurant_public_field_requirements(uuid,text) from anon;" \
  >/dev/null 2>"$ERR" || fatal "préparation du scénario d'atomicité aller : $(tr '\n' ' ' < "$ERR")"

apply_path "$FORWARD_SQL" "$DB_ATOMIC_FWD"; RC_ATOMIC_FWD=$?
assert_eq "1a. aller — le SQL ÉCHOUE quand un post-vol n'est pas satisfait" "1" \
  "$([ "$RC_ATOMIC_FWD" -ne 0 ] && echo 1 || echo 0)"
assert_eq "1b. aller — l'échec est bien celui du POST-VOL (SCANYM_REGRESSION), pas du pré-vol" "1|0" \
  "$([ "$(grep -c 'SCANYM_REGRESSION' "$OUT" | tr -d ' ')" -ge 1 ] && echo 1 || echo 0)|$([ "$(grep -c 'SCANYM_SCHEMA_DRIFT\|SCANYM_ALREADY_APPLIED' "$OUT" | tr -d ' ')" -ge 1 ] && echo 1 || echo 0)"
assert_eq "1c. aller — ATOMICITÉ : AUCUN objet du lot ne subsiste, create_order NON redéfinie" \
  "0|0|0|0|0" "$(cfte_footprint "$DB_ATOMIC_FWD")"
assert_eq "1d. aller — ATOMICITÉ : create_order bit-à-bit identique au prédécesseur" \
  "$FP_CREATE_ORDER_BEFORE" "$(fn_fingerprint create_order "$DB_ATOMIC_FWD")"
assert_eq "1e. aller — ATOMICITÉ : le résolveur d'exigences n'a pas été redéfini" \
  "$FP_RESOLVER_BEFORE" "$(fn_fingerprint effective_sale_mode_field_requirements "$DB_ATOMIC_FWD")"
assert_eq "1f. aller — ATOMICITÉ : l'enfilement order_received n'a pas été redéfini" \
  "$FP_NOTIF_BEFORE" "$(fn_fingerprint create_order_received_notification "$DB_ATOMIC_FWD")"
assert_eq "1g. aller — ATOMICITÉ : le schéma est exactement celui d'avant la tentative" \
  "$COUNTS_BEFORE" "$(schema_counts "$DB_ATOMIC_FWD")"

# Pré-vol : refus si la frontière de succès de commande a disparu.
clone_base "$DB_NOPREREQ"
psql -X -d "$DB_NOPREREQ" -v ON_ERROR_STOP=1 \
  -c "drop trigger orders_record_order_received_intent_trg on public.orders;" \
  >/dev/null 2>"$ERR" || fatal "préparation du scénario sans prérequis : $(tr '\n' ' ' < "$ERR")"
apply_path "$FORWARD_SQL" "$DB_NOPREREQ"; RC_NOPREREQ=$?
assert_eq "1h. aller — REFUS si le déclencheur d'intention order_received a disparu" "1|1" \
  "$([ "$RC_NOPREREQ" -ne 0 ] && echo 1 || echo 0)|$([ "$(grep -c 'SCANYM_SCHEMA_DRIFT' "$OUT" | tr -d ' ')" -ge 1 ] && echo 1 || echo 0)"
assert_eq "1i. aller — refus de pré-vol : rien n'est laissé derrière" "0|0|0|0|0" "$(cfte_footprint "$DB_NOPREREQ")"

# ============================================================
# [2] APPLICATION RÉELLE DU SQL ALLER
# ============================================================
log "=== [2] Application du SQL aller sur le schéma prédécesseur ==="
clone_base "$DB_MAIN"
DB="$DB_MAIN"

apply_path "$FORWARD_SQL" "$DB_MAIN"; RC_FWD=$?
assert_eq "2a. le SQL aller s'applique sans erreur sur le PRÉDÉCESSEUR" "0" "$RC_FWD"
[ "$RC_FWD" -eq 0 ] || fatal "le lot ne s'applique pas -- preuves suivantes impossibles : $(head -5 "$OUT" | tr '\n' ' ')"

apply_path "$FORWARD_SQL" "$DB_MAIN"; RC_DOUBLE=$?
assert_eq "2b. double application REFUSÉE (SCANYM_ALREADY_APPLIED)" "1|1" \
  "$([ "$RC_DOUBLE" -ne 0 ] && echo 1 || echo 0)|$([ "$(grep -c 'SCANYM_ALREADY_APPLIED' "$OUT" | tr -d ' ')" -ge 1 ] && echo 1 || echo 0)"

# ============================================================
# [3] OBJETS, RLS, POLICY, FONCTIONS, GRANTS CONTRACTÉS
# ============================================================
log "=== [3] Table / RLS / policy / fonctions / grants ==="

assert_eq "3a. merchant_tracking_status_text existe, RLS ACTIVE" "t|t" \
  "$(sql_value "select to_regclass('public.merchant_tracking_status_text') is not null, (select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.merchant_tracking_status_text'));")"
assert_eq "3b. la policy de lecture tenant existe, et elle seule" "merchant_tracking_status_text_select_member|1" \
  "$(sql_raw "select coalesce(string_agg(policyname, ',' order by policyname),'-') || '|' || count(*) from pg_policies where schemaname='public' and tablename='merchant_tracking_status_text';")"
assert_eq "3c. clé primaire (restaurant_id, status)" "restaurant_id,status" \
  "$(sql_raw "select string_agg(a.attname, ',' order by array_position(c.conkey, a.attnum)) from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey) where c.conrelid='public.merchant_tracking_status_text'::regclass and c.contype='p';")"
assert_eq "3d. SEULS les 7 statuts canoniques sont acceptés (aucun 8e par configuration)" "1" \
  "$(sql_value "select count(*) from pg_constraint where conrelid='public.merchant_tracking_status_text'::regclass and conname='merchant_tracking_status_text_status_check' and pg_get_constraintdef(oid) like '%new%accepted%preparing%ready%completed%rejected%cancelled%';")"
assert_eq "3e. borne de longueur du corps présente" "1" \
  "$(sql_value "select count(*) from pg_constraint where conrelid='public.merchant_tracking_status_text'::regclass and conname='merchant_tracking_status_text_body_length';")"

for fn in "customer_tracked_service_modes()" "set_merchant_tracking_status_text(uuid,text,text)" "get_order_tracking_status_text_by_capability(uuid,uuid,text)" "effective_sale_mode_field_requirements(uuid,text)" "create_order_received_notification(uuid,uuid)"; do
  name="${fn%%(*}"
  assert_eq "3f. $name : présente et search_path VIDE (aucune capture de schéma)" "1" \
    "$(sql_value "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='$name' and (select count(*) from unnest(p.proconfig) c where c='search_path=\"\"')=1;")"
  assert_eq "3g. $name : aucun EXECUTE résiduel pour PUBLIC" "f" \
    "$(sql_value "select has_function_privilege('public','public.$fn','execute');")"
done
# customer_tracked_service_modes est volontairement SANS SECURITY
# DEFINER (fonction pure, aucune lecture de données) ; les trois autres
# le sont.
for name in set_merchant_tracking_status_text get_order_tracking_status_text_by_capability effective_sale_mode_field_requirements; do
  assert_eq "3f-bis. $name : SECURITY DEFINER" "t" \
    "$(sql_value "select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='$name';")"
done
# provolatile est de type "char" : le concaténer à du text (`… ::text ||
# '|' || provolatile`) fait échouer la résolution de l'opérateur `||`, et
# la requête de preuve rendait alors une valeur VIDE. Colonnes séparées.
assert_eq "3f-ter. customer_tracked_service_modes : fonction PURE, immutable, sans SECURITY DEFINER" "f|i" \
  "$(sql_value "select p.prosecdef, p.provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='customer_tracked_service_modes';")"
assert_eq "3h. customer_tracked_service_modes : strictement interne (ni anon ni authenticated)" "f|f" \
  "$(sql_value "select has_function_privilege('anon','public.customer_tracked_service_modes()','execute'), has_function_privilege('authenticated','public.customer_tracked_service_modes()','execute');")"
assert_eq "3i. résolveur d'exigences : toujours strictement interne" "f|f" \
  "$(sql_value "select has_function_privilege('anon','public.effective_sale_mode_field_requirements(uuid,text)','execute'), has_function_privilege('authenticated','public.effective_sale_mode_field_requirements(uuid,text)','execute');")"
assert_eq "3j. projection publique du checkout TOUJOURS ouverte à anon (non-régression)" "t" \
  "$(sql_value "select has_function_privilege('anon','public.get_restaurant_public_field_requirements(uuid,text)','execute');")"
assert_eq "3k. écriture du texte : authenticated OUI, anon NON" "t|f" \
  "$(sql_value "select has_function_privilege('authenticated','public.set_merchant_tracking_status_text(uuid,text,text)','execute'), has_function_privilege('anon','public.set_merchant_tracking_status_text(uuid,text,text)','execute');")"
assert_eq "3l. lecture client par capacité : anon ET authenticated" "t|t" \
  "$(sql_value "select has_function_privilege('anon','public.get_order_tracking_status_text_by_capability(uuid,uuid,text)','execute'), has_function_privilege('authenticated','public.get_order_tracking_status_text_by_capability(uuid,uuid,text)','execute');")"
assert_eq "3m. table : anon ne peut PAS lire ; authenticated lit (sous RLS) et n'écrit JAMAIS en direct" "f|t|f|f|f" \
  "$(sql_value "select has_table_privilege('anon','public.merchant_tracking_status_text','select'), has_table_privilege('authenticated','public.merchant_tracking_status_text','select'), has_table_privilege('authenticated','public.merchant_tracking_status_text','insert'), has_table_privilege('authenticated','public.merchant_tracking_status_text','update'), has_table_privilege('authenticated','public.merchant_tracking_status_text','delete');")"
assert_eq "3n. create_order conserve EXACTEMENT ses droits (anon + authenticated, jamais PUBLIC)" "t|t|f" \
  "$(sql_value "select has_function_privilege('anon','public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)','execute'), has_function_privilege('authenticated','public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)','execute'), has_function_privilege('public','public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)','execute');")"
assert_eq "3o. enfilement order_received : service_role SEUL" "t|f|f" \
  "$(sql_value "select has_function_privilege('service_role','public.create_order_received_notification(uuid,uuid)','execute'), has_function_privilege('anon','public.create_order_received_notification(uuid,uuid)','execute'), has_function_privilege('authenticated','public.create_order_received_notification(uuid,uuid)','execute');")"
assert_eq "3p. AUCUNE colonne prénom/nom ajoutée à public.orders" "0" \
  "$(sql_value "select count(*) from information_schema.columns where table_schema='public' and table_name='orders' and column_name in ('first_name','last_name','customer_first_name','customer_last_name');")"
# Le lot CRÉE 3 fonctions (customer_tracked_service_modes,
# set_merchant_tracking_status_text,
# get_order_tracking_status_text_by_capability) et REDÉFINIT les trois
# autres (create or replace, donc sans effet sur le compte). Il ajoute
# une table et AUCUN déclencheur.
assert_eq "3q. delta de schéma EXACT : +1 table, +0 déclencheur, +3 fonctions -- rien d'autre" \
  "$(echo "$COUNTS_BEFORE" | awk -F'|' '{printf "%d|%d|%d", $1+1, $2, $3+3}')" \
  "$(schema_counts "$DB_MAIN" | awk -F'|' '{printf "%d|%d|%d", $1, $2, $3}')"
assert_eq "3r. moteur d'état INTOUCHÉ : update_order_status bit-à-bit identique" \
  "$FP_UPDATE_STATUS_BEFORE" "$(fn_fingerprint update_order_status)"
assert_eq "3s. suivi v3.1 INTOUCHÉ : get_order_tracking_by_capability bit-à-bit identique" \
  "$FP_TRACK_CAP_BEFORE" "$(fn_fingerprint get_order_tracking_by_capability)"

# ============================================================
# [4] RÉSOLUTION DES EXIGENCES — précédence e-mail + prénom/nom
# ============================================================
log "=== [4] Précédence e-mail / prénom / nom (résolution seule) ==="

assert_eq "4a. pickup (mode SUIVI) — e-mail FORCÉ required, groupe one_of dissous, prénom/nom" \
  "email:required:-,first_name:required:-,last_name:optional:-,phone:optional:-" \
  "$(sql_raw "select coalesce(string_agg(field||':'||requirement||':'||coalesce(one_of_group,'-'), ',' order by field),'<vide>') from public.effective_sale_mode_field_requirements('$RID_A','pickup');")"
assert_eq "4b. delivery (mode SUIVI) — e-mail required (catalogue: optional), nom de famille required" \
  "delivery_address:required:-,email:required:-,first_name:required:-,last_name:required:-,phone:required:-" \
  "$(sql_raw "select coalesce(string_agg(field||':'||requirement||':'||coalesce(one_of_group,'-'), ',' order by field),'<vide>') from public.effective_sale_mode_field_requirements('$RID_A','delivery');")"
assert_eq "4c. table (mode NON suivi) — traverse le résolveur INCHANGÉ" \
  "$REQS_TABLE_BEFORE" \
  "$(sql_raw "select coalesce(string_agg(field||':'||requirement||':'||coalesce(one_of_group,'-'), ',' order by field),'<vide>') from public.effective_sale_mode_field_requirements('$RID_A','table');")"
assert_eq "4d. room_service (mode NON suivi) — traverse le résolveur INCHANGÉ" \
  "customer_name:required:-,room_number:required:-" \
  "$(sql_raw "select coalesce(string_agg(field||':'||requirement||':'||coalesce(one_of_group,'-'), ',' order by field),'<vide>') from public.effective_sale_mode_field_requirements('$RID_A','room_service');")"
assert_eq "4e. AUCUNE ligne de configuration tenant/catalogue n'a été mutée" "$RULE_ROWS_BEFORE" \
  "$(sql_raw "select (select count(*) from public.sale_mode_field_requirements)::text||'|'||(select count(*) from public.restaurant_sale_mode_field_requirements)::text;")"

# Surcharge tenant tentant de RELAXER l'e-mail : la précédence doit tenir.
sql "insert into public.restaurant_sale_mode_field_requirements (restaurant_id, mode_code, field, requirement, one_of_group) values ('$RID_A','pickup','email','optional',null);" >/dev/null
assert_eq "4f. une surcharge tenant 'email optional' NE PEUT PAS relaxer la précédence" "required" \
  "$(sql_value "select requirement from public.effective_sale_mode_field_requirements('$RID_A','pickup') where field='email';")"
sql "delete from public.restaurant_sale_mode_field_requirements where restaurant_id='$RID_A' and mode_code='pickup' and field='email';" >/dev/null

# ============================================================
# [5] create_order FONCTIONNE TOUJOURS
# ============================================================
log "=== [5] create_order ==="

# $1 = mode, $2 = json client, $3 = table_number (ou 'null')
# Les assertions qui suivent ne mesurent que la LONGUEUR de l'identifiant
# rendu : sans la ligne de diagnostic ci-dessous, un refus de create_order
# se présenterait comme « obtenu 0 » sans jamais dire lequel.
place_order() {
  local out rc
  out="$(PGOPTIONS='-c role=anon' psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -c \
    "select order_id from public.create_order('cfte-alpha','$1','[{\"menu_item_id\":\"$ITEM_A\",\"quantity\":1,\"option_item_id\":null}]'::jsonb,$3,'$2'::jsonb,null,'fr',false);" \
    2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '[%s] CREATE-ORDER-ERROR (mode=%s) : %s\n' "$(date -u '+%H:%M:%S')" "$1" \
      "$(printf '%s' "$out" | tr '\n\r' '  ' | cut -c1-220)" >&2
  fi
  printf '%s\n' "$(printf '%s' "$out" | tail -1 | tr -d ' ')"
}
place_order_outcome() {
  outcome_as anon "" \
    "select order_id from public.create_order('cfte-alpha','$1','[{\"menu_item_id\":\"$ITEM_A\",\"quantity\":1,\"option_item_id\":null}]'::jsonb,$3,'$2'::jsonb,null,'fr',false);"
}

ORDER_PICKUP="$(place_order pickup '{"first_name":"Myriam","last_name":"Benali","email":"myriam@cfte.test","phone":"0600000000","name":"NOM-DU-NAVIGATEUR"}' null)"
assert_eq "5a. pickup (mode suivi) avec e-mail + prénom : commande CRÉÉE" "36" "${#ORDER_PICKUP}"
assert_eq "5b. le nom d'affichage est COMPOSÉ côté serveur, jamais celui envoyé par le navigateur" "Myriam Benali" \
  "$(sql_raw "select customer_name from public.orders where id='$ORDER_PICKUP';")"
assert_eq "5c. l'e-mail est persisté dans la colonne EXISTANTE customer_email" "myriam@cfte.test" \
  "$(sql_raw "select customer_email from public.orders where id='$ORDER_PICKUP';")"

assert_eq "5d. pickup SANS e-mail : REFUSÉ (précédence non relaxable, garde serveur)" "SCANYM_CUSTOMER_EMAIL_REQUIRED" \
  "$(place_order_outcome pickup '{"first_name":"Myriam","last_name":"Benali","phone":"0600000000"}' null)"
assert_eq "5e. pickup SANS prénom : REFUSÉ" "SCANYM_CUSTOMER_FIRST_NAME_REQUIRED" \
  "$(place_order_outcome pickup '{"last_name":"Benali","email":"myriam@cfte.test"}' null)"
assert_eq "5f. delivery SANS nom de famille : REFUSÉ" "SCANYM_CUSTOMER_LAST_NAME_REQUIRED" \
  "$(place_order_outcome delivery '{"first_name":"Myriam","email":"myriam@cfte.test","phone":"0600000000","address":"12 rue Synthetic, 75001 Paris"}' null)"

ORDER_DELIVERY="$(place_order delivery '{"first_name":"Myriam","last_name":"Benali","email":"myriam@cfte.test","phone":"0600000000","address":"12 rue Synthetic, 75001 Paris"}' null)"
assert_eq "5g. delivery complète : commande CRÉÉE" "36" "${#ORDER_DELIVERY}"
assert_eq "5h. delivery : adresse et zone toujours persistées comme avant" "12 rue Synthetic, 75001 Paris|75001" \
  "$(sql_raw "select delivery_address||'|'||delivery_zone from public.orders where id='$ORDER_DELIVERY';")"

ORDER_TABLE="$(place_order table '{}' 7)"
assert_eq "5i. table (mode NON suivi) : ni e-mail ni prénom exigés -- comportement INCHANGÉ" "36" "${#ORDER_TABLE}"
assert_eq "5j. table : numéro de table persisté, aucun e-mail inventé" "7|" \
  "$(sql_raw "select table_number::text||'|'||coalesce(customer_email,'') from public.orders where id='$ORDER_TABLE';")"
assert_eq "5k. la commande HISTORIQUE (créée avant le lot) est INTACTE" "Client Historique|" \
  "$(sql_raw "select customer_name||'|'||coalesce(customer_email,'') from public.orders where id='$LEGACY_ORDER';")"

# ============================================================
# [6] TEXTE DE STATUT MARCHAND — écriture, RLS, inter-locataires
# ============================================================
log "=== [6] Texte de statut : autorisation et isolation ==="

assert_eq "6a. owner A enregistre un texte pour un statut canonique" "OK" \
  "$(outcome_as authenticated "$OWNER_A" "select public.set_merchant_tracking_status_text('$RID_A','new','Nous avons bien recu votre commande.');")"
assert_eq "6b. manager A peut aussi écrire" "OK" \
  "$(outcome_as authenticated "$MANAGER_A" "select public.set_merchant_tracking_status_text('$RID_A','ready','Votre commande vous attend.');")"
assert_eq "6c. staff A NE PEUT PAS écrire (owner/manager uniquement)" "Forbidden" \
  "$(outcome_as authenticated "$STAFF_A" "select public.set_merchant_tracking_status_text('$RID_A','new','texte pirate');")"
assert_eq "6d. owner B NE PEUT PAS écrire chez A (isolation inter-locataires)" "Forbidden" \
  "$(outcome_as authenticated "$OWNER_B" "select public.set_merchant_tracking_status_text('$RID_A','new','texte pirate');")"
assert_eq "6e. le refus inter-locataires est SANS EFFET : le texte de A est intact" "Nous avons bien recu votre commande." \
  "$(sql_raw "select body from public.merchant_tracking_status_text where restaurant_id='$RID_A' and status='new';")"
assert_eq "6f. anon NE PEUT PAS appeler la RPC d'écriture" "REFUSE" \
  "$(refused "$(outcome_as anon "" "select public.set_merchant_tracking_status_text('$RID_A','new','texte anonyme');")")"
assert_eq "6g. un statut NON canonique est REFUSÉ explicitement (jamais un 8e statut)" "SCANYM_UNKNOWN_ORDER_STATUS" \
  "$(outcome_as authenticated "$OWNER_A" "select public.set_merchant_tracking_status_text('$RID_A','en_livraison','statut invente');")"
assert_eq "6h. un corps trop long est REFUSÉ" "SCANYM_TRACKING_STATUS_TEXT_TOO_LONG" \
  "$(outcome_as authenticated "$OWNER_A" "select public.set_merchant_tracking_status_text('$RID_A','accepted', repeat('x', 401));")"
assert_eq "6i. authentification requise (aucun auth.uid())" "Authentication required" \
  "$(outcome_as authenticated "" "select public.set_merchant_tracking_status_text('$RID_A','new','sans identite');")"

assert_eq "6j. owner B enregistre SON propre texte" "OK" \
  "$(outcome_as authenticated "$OWNER_B" "select public.set_merchant_tracking_status_text('$RID_B','new','Merci pour votre commande chez Beta.');")"
assert_eq "6k. RLS : A ne voit QUE ses propres lignes" "2" \
  "$(value_as authenticated "$OWNER_A" "select count(*) from public.merchant_tracking_status_text;")"
assert_eq "6l. RLS : B ne voit QUE les siennes, jamais celles de A" "1" \
  "$(value_as authenticated "$OWNER_B" "select count(*) from public.merchant_tracking_status_text;")"
assert_eq "6m. RLS : B ne peut pas cibler les lignes de A" "0" \
  "$(value_as authenticated "$OWNER_B" "select count(*) from public.merchant_tracking_status_text where restaurant_id='$RID_A';")"

assert_eq "6n. corps vidé = SUPPRESSION de la ligne (repli sur le texte de base)" "OK|0" \
  "$(outcome_as authenticated "$OWNER_A" "select public.set_merchant_tracking_status_text('$RID_A','ready','   ');")|$(sql_value "select count(*) from public.merchant_tracking_status_text where restaurant_id='$RID_A' and status='ready';")"

STATUSES_AFTER_WRITES="$(sql_raw "select coalesce(string_agg(distinct status, ',' order by status),'-') from public.orders;")"
assert_eq "6o. AUCUNE écriture de statut de commande : orders.status intouché" "new" "$STATUSES_AFTER_WRITES"

# ============================================================
# [7] LECTURE CLIENT PAR CAPACITÉ — preuve v3.1, inter-commandes
# ============================================================
log "=== [7] Lecture client par capacité de suivi ==="

# ------------------------------------------------------------------
# FIXTURE DE CAPACITÉ — MÊME MÉCANIQUE QUE LE CONTRAT v3.1
#
# Le jeton legacy (`orders.public_token`) est résolu HORS BANDE, par la
# connexion propriétaire du harnais, puis passé en LITTÉRAL à l'appel
# anon -- exactement comme le fait
# supabase/tests/customer-tracking-capability-v3-1-check.sh (`tok()`).
#
# Le résoudre par une SOUS-REQUÊTE À L'INTÉRIEUR de l'appel anon serait
# un contresens de fixture : `public.orders` porte RLS et sa seule policy
# SELECT est `to authenticated` (migration-v29), donc sous le rôle anon
# la sous-requête ne voit AUCUNE ligne et rend NULL. Or
# upgrade_legacy_tracking_capability(commande, NULL) rend, PAR CONTRAT
# v3.1, l'ensemble VIDE : aucune capacité n'est alors émise, et toute la
# section [7] s'effondre sans qu'aucun défaut produit n'existe. Le client
# réel ne lit d'ailleurs jamais ce jeton dans la table : il le reçoit
# dans son lien de suivi. La fixture reproduit donc bien le chemin réel.
order_public_token() { sql_value "select public_token from public.orders where id='$1';"; }

mint_capability() {
  local order_id="$1" token
  token="$(order_public_token "$order_id")"
  case "$token" in
    ????????-????-????-????-????????????) : ;;
    *) printf 'FIXTURE_ERROR(jeton legacy illisible pour %s : %s)\n' \
         "$order_id" "${token:-<vide>}"; return 0 ;;
  esac
  run_sql "$DB" anon '' \
    "select capability_id::text || '|' || capability_secret from public.upgrade_legacy_tracking_capability('$order_id','$token');" \
    | tail -1 | tr -d ' '
}

# 1 si le secret est bien 64 hexadécimaux minuscules ; sinon 0, ET la
# valeur brute est journalisée : un échec d'ÉMISSION ne doit jamais se
# présenter au lecteur comme un simple « 0 » sans cause. Le diagnostic
# part sur la SORTIE D'ERREUR : cette fonction est appelée dans une
# substitution de commande, et tout ce qu'elle écrirait sur la sortie
# standard serait avalé dans la valeur comparée.
hex64() {
  if [[ "$1" =~ ^[0-9a-f]{64}$ ]]; then printf '1'
  else
    printf '[%s] [evidence] secret de capacité INATTENDU : %s\n' \
      "$(date -u '+%H:%M:%S')" "${1:-<vide>}" >&2
    printf '0'
  fi
}

ORDER_B1="$(sql_value "insert into public.orders (restaurant_id, order_number, service_mode, subtotal, total, currency, customer_name) values ('$RID_B', 991, 'pickup', 10, 10, 'EUR', 'Client Beta') returning id;")"

CAP_A="$(mint_capability "$ORDER_PICKUP")"; CAP_A_ID="${CAP_A%%|*}"; CAP_A_SECRET="${CAP_A#*|}"
CAP_B="$(mint_capability "$ORDER_B1")";     CAP_B_ID="${CAP_B%%|*}"; CAP_B_SECRET="${CAP_B#*|}"
assert_eq "7a. capacités de suivi v3.1 émises par le chemin réel (secrets 64 hex)" "1|1" \
  "$(hex64 "$CAP_A_SECRET")|$(hex64 "$CAP_B_SECRET")"

read_status_text() {
  run_sql "$DB" anon '' \
    "select coalesce(string_agg(status||'='||body, ',' order by status),'<vide>') from public.get_order_tracking_status_text_by_capability('$1','$2','$3');" \
    | tail -1
}
assert_eq "7b. capacité VALIDE : le client lit les surcharges de SON commerçant" "new=Nous avons bien recu votre commande." \
  "$(read_status_text "$ORDER_PICKUP" "$CAP_A_ID" "$CAP_A_SECRET")"
assert_eq "7c. commande de A + capacité de B : ensemble VIDE (aucune fuite inter-locataires)" "<vide>" \
  "$(read_status_text "$ORDER_PICKUP" "$CAP_B_ID" "$CAP_B_SECRET")"
assert_eq "7d. commande de B + capacité de A : ensemble VIDE" "<vide>" \
  "$(read_status_text "$ORDER_B1" "$CAP_A_ID" "$CAP_A_SECRET")"
assert_eq "7e. commande de B avec SA capacité : le texte de B, JAMAIS celui de A" "new=Merci pour votre commande chez Beta." \
  "$(read_status_text "$ORDER_B1" "$CAP_B_ID" "$CAP_B_SECRET")"
assert_eq "7f. secret ERRONÉ : ensemble VIDE" "<vide>" \
  "$(read_status_text "$ORDER_PICKUP" "$CAP_A_ID" "$CAP_B_SECRET")"
assert_eq "7g. secret de longueur invalide : ensemble VIDE" "<vide>" \
  "$(read_status_text "$ORDER_PICKUP" "$CAP_A_ID" "deadbeef")"
assert_eq "7h. arguments NULL : ensemble VIDE (aucune erreur exploitable)" "0" \
  "$(run_sql "$DB" anon '' "select count(*) from public.get_order_tracking_status_text_by_capability(null,null,null);" | tail -1 | tr -d ' ')"
assert_eq "7i. anon ne peut PAS contourner la RPC en lisant la table" "REFUSE" \
  "$(refused "$(outcome_as anon "" "select count(*) from public.merchant_tracking_status_text;")")"
# EXPIRATION — la capacité qui expire est celle du type 'email', JAMAIS
# la capacité legacy.
#
# Le contrat v3.1 l'impose structurellement, par la contrainte
# `order_tracking_capabilities_email_bounded` :
#     (kind='email'          and secret_hash is not null and expires_at is not null)
#  or (kind='legacy_upgrade' and expires_at is null)
# Poser un expires_at sur une capacité legacy_upgrade VIOLE donc cette
# contrainte : la fixture échouait en silence (stdout jeté), la capacité
# restait valide, et l'assertion lisait le texte au lieu de l'ensemble
# vide. On emprunte la même voie que
# supabase/tests/customer-tracking-capability-v3-1-check.sh (8q) : une
# capacité kind='email' est émise par le chemin réel service_role, puis
# vieillie. L'assertion -- « une capacité expirée ne lit rien » -- est
# inchangée ; seule la capacité sur laquelle elle porte devient celle que
# le produit autorise effectivement à expirer.
CAP_MAIL="$(run_sql "$DB" service_role '' \
  "select capability_id::text || '|' || capability_secret from public.issue_order_email_tracking_capability('$ORDER_PICKUP');" \
  | tail -1 | tr -d ' ')"
CAP_MAIL_ID="${CAP_MAIL%%|*}"; CAP_MAIL_SECRET="${CAP_MAIL#*|}"
assert_eq "7j-pre. capacité e-mail v3.1 émise par service_role (secret 64 hex)" "1" \
  "$(hex64 "$CAP_MAIL_SECRET")"
assert_eq "7j-bis. capacité e-mail VALIDE : le client lit les mêmes surcharges" "new=Nous avons bien recu votre commande." \
  "$(read_status_text "$ORDER_PICKUP" "$CAP_MAIL_ID" "$CAP_MAIL_SECRET")"
sql "update public.order_tracking_capabilities set expires_at = pg_catalog.now() - interval '1 hour' where id='$CAP_MAIL_ID';" >/dev/null
assert_eq "7j. capacité EXPIRÉE : ensemble VIDE" "<vide>" \
  "$(read_status_text "$ORDER_PICKUP" "$CAP_MAIL_ID" "$CAP_MAIL_SECRET")"
# La fixture de vieillissement ne doit pas pouvoir échouer sans le dire :
# une expiration non appliquée rendrait l'assertion ci-dessus vide de sens.
assert_eq "7j-ter. la fixture d'expiration a bien été APPLIQUÉE (aucune erreur avalée)" "1" \
  "$(sql_value "select count(*) from public.order_tracking_capabilities where id='$CAP_MAIL_ID' and expires_at < pg_catalog.now();")"
assert_eq "7j-quater. la capacité LEGACY, elle, n'a pas expiré et reste lisible" "new=Nous avons bien recu votre commande." \
  "$(read_status_text "$ORDER_PICKUP" "$CAP_A_ID" "$CAP_A_SECRET")"

# ============================================================
# [8] OUTBOX order_received — intention durable, reprise, payload
# ============================================================
log "=== [8] Comportement outbox order_received ==="

assert_eq "8a. create_order n'écrit AUCUNE ligne outbox de façon synchrone" "0" \
  "$(sql_value "select count(*) from public.notification_outbox where order_id='$ORDER_PICKUP';")"
assert_eq "8b. l'INTENTION durable est bien posée (ORDER SUCCESS BOUNDARY v1)" "1" \
  "$(sql_value "select count(*) from public.orders where id='$ORDER_PICKUP' and order_received_notification_intent_at is not null;")"

run_sql "$DB" service_role '' \
  "select 1 from public.recover_missing_order_received_notifications('$RID_A',100);" >/dev/null
assert_eq "8c. la reprise crée EXACTEMENT une ligne order_received pour la commande" "1" \
  "$(sql_value "select count(*) from public.notification_outbox where order_id='$ORDER_PICKUP' and notification_type='order_received';")"
assert_eq "8d. payload : les 6 clés historiques + les 4 clés CFTE v1 (strictement ADDITIF)" \
  "created_at,currency,delivery_address,merchant_name,order_number,order_status,public_token,service_mode,status_text_override,total" \
  "$(sql_raw "select coalesce(string_agg(k, ',' order by k),'<vide>') from public.notification_outbox o, jsonb_object_keys(o.payload_snapshot) k where o.order_id='$ORDER_PICKUP';")"
assert_eq "8e. payload : statut, surcharge marchande applicable, nom du commerçant" \
  "new|Nous avons bien recu votre commande.|Epicerie Alpha" \
  "$(sql_raw "select (payload_snapshot->>'order_status')||'|'||(payload_snapshot->>'status_text_override')||'|'||(payload_snapshot->>'merchant_name') from public.notification_outbox where order_id='$ORDER_PICKUP';")"
assert_eq "8f. payload : PAS d'adresse de livraison hors mode delivery" "" \
  "$(sql_raw "select coalesce(payload_snapshot->>'delivery_address','') from public.notification_outbox where order_id='$ORDER_PICKUP';")"
assert_eq "8g. payload : adresse PRÉSENTE en mode delivery" "12 rue Synthetic, 75001 Paris" \
  "$(sql_raw "select payload_snapshot->>'delivery_address' from public.notification_outbox where order_id='$ORDER_DELIVERY';")"
assert_eq "8h. ligne 'pending' (profil marchand activé), destinataire = e-mail client" "pending|myriam@cfte.test" \
  "$(sql_raw "select status||'|'||recipient_email from public.notification_outbox where order_id='$ORDER_PICKUP';")"

run_sql "$DB" service_role '' \
  "select 1 from public.recover_missing_order_received_notifications('$RID_A',100);" >/dev/null
assert_eq "8i. IDEMPOTENCE : une seconde reprise ne duplique rien" "1" \
  "$(sql_value "select count(*) from public.notification_outbox where order_id='$ORDER_PICKUP';")"
assert_eq "8j. substitution TENANT CROISÉE refusée structurellement (jamais un simple ensemble vide)" "1" \
  "$([ "$(outcome_as service_role "" "select public.create_order_received_notification('$ORDER_PICKUP','$RID_B');" | grep -c 'SCANYM_NOTIFICATION_TENANT_MISMATCH' | tr -d ' ')" -ge 1 ] && echo 1 || echo 0)"
assert_eq "8k. commande sans e-mail (mode non suivi) : ligne 'skipped_no_email', jamais absente" "skipped_no_email" \
  "$(run_sql "$DB" service_role '' "select public.create_order_received_notification('$ORDER_TABLE','$RID_A');" >/dev/null; sql_value "select status from public.notification_outbox where order_id='$ORDER_TABLE';")"
assert_eq "8l. AUCUN envoi réseau : aucune ligne n'est passée à 'sent' par ce lot" "0" \
  "$(sql_value "select count(*) from public.notification_outbox where status = 'sent';")"

# ============================================================
# [9] ATOMICITÉ — sens RETOUR
# ============================================================
log "=== [9] ATOMICITÉ (retour) ==="

clone_base "$DB_ATOMIC_RB"
apply_path "$FORWARD_SQL" "$DB_ATOMIC_RB" || fatal "préparation du scénario d'atomicité retour (aller) : $(head -3 "$OUT" | tr '\n' ' ')"
psql -X -d "$DB_ATOMIC_RB" -v ON_ERROR_STOP=1 \
  -c "drop trigger orders_record_order_received_intent_trg on public.orders;" >/dev/null 2>"$ERR" \
  || fatal "préparation du scénario d'atomicité retour : $(tr '\n' ' ' < "$ERR")"

apply_path "$ROLLBACK_SQL" "$DB_ATOMIC_RB"; RC_ATOMIC_RB=$?
assert_eq "9a. retour — le rollback ÉCHOUE quand son post-vol n'est pas satisfait" "1" \
  "$([ "$RC_ATOMIC_RB" -ne 0 ] && echo 1 || echo 0)"
assert_eq "9b. retour — l'échec est bien celui du post-vol (SCANYM_ROLLBACK_FAILED)" "1" \
  "$([ "$(grep -c 'SCANYM_ROLLBACK_FAILED' "$OUT" | tr -d ' ')" -ge 1 ] && echo 1 || echo 0)"
assert_eq "9c. retour — ATOMICITÉ : aucun rollback PARTIEL publié (le lot est encore entièrement là)" \
  "1|1|1|1|1" "$(cfte_footprint "$DB_ATOMIC_RB")"

# ============================================================
# [10] ROLLBACK RÉEL + RÉVERSIBILITÉ
# ============================================================
log "=== [10] Rollback et restauration de l'état PRÉDÉCESSEUR ==="
DB="$DB_MAIN"

apply_path "$ROLLBACK_SQL" "$DB_MAIN"; RC_RB=$?
assert_eq "10a. le rollback s'applique sans erreur" "0" "$RC_RB"

assert_eq "10b. tous les objets créés par le lot ont DISPARU, create_order nettoyée" "0|0|0|0|0" "$(cfte_footprint "$DB_MAIN")"
assert_eq "10c. RÉVERSIBILITÉ — create_order : CODE EXÉCUTÉ identique au prédécesseur" \
  "$FPC_CREATE_ORDER_BEFORE" "$(fn_code_fingerprint create_order)"
assert_eq "10d. RÉVERSIBILITÉ — résolveur d'exigences : CODE EXÉCUTÉ identique au prédécesseur" \
  "$FPC_RESOLVER_BEFORE" "$(fn_code_fingerprint effective_sale_mode_field_requirements)"
assert_eq "10e. RÉVERSIBILITÉ — enfilement order_received : CODE EXÉCUTÉ identique au prédécesseur" \
  "$FPC_NOTIF_BEFORE" "$(fn_code_fingerprint create_order_received_notification)"
assert_eq "10c-bis. RÉVERSIBILITÉ — privilèges des trois fonctions redéfinies identiques au prédécesseur" \
  "$ACL_BEFORE" \
  "$(sql_raw "select coalesce(string_agg(p.proname || '=' || coalesce(p.proacl::text,'<null>'), ';' order by p.proname),'-') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('create_order','effective_sale_mode_field_requirements','create_order_received_notification');")"
assert_eq "10f. RÉVERSIBILITÉ — pickup revient au catalogue LOT 2A" "$REQS_PICKUP_BEFORE" \
  "$(sql_raw "select coalesce(string_agg(field||':'||requirement||':'||coalesce(one_of_group,'-'), ',' order by field),'<vide>') from public.effective_sale_mode_field_requirements('$RID_A','pickup');")"
assert_eq "10g. RÉVERSIBILITÉ — delivery revient au catalogue LOT 2A (e-mail de nouveau OPTIONNEL)" "$REQS_DELIVERY_BEFORE" \
  "$(sql_raw "select coalesce(string_agg(field||':'||requirement||':'||coalesce(one_of_group,'-'), ',' order by field),'<vide>') from public.effective_sale_mode_field_requirements('$RID_A','delivery');")"

# La preuve de réversibilité qui compte vraiment : le contrat CLIENT
# historique refonctionne (nom seul + téléphone, aucun e-mail).
ORDER_AFTER_RB="$(place_order pickup '{"name":"Client Post-Rollback","phone":"0600000000"}' null)"
assert_eq "10h. RÉVERSIBILITÉ — create_order réaccepte le contrat HISTORIQUE (sans e-mail)" "36" "${#ORDER_AFTER_RB}"
assert_eq "10i. RÉVERSIBILITÉ — le nom reçu du navigateur redevient la source du nom affiché" "Client Post-Rollback" \
  "$(sql_raw "select customer_name from public.orders where id='$ORDER_AFTER_RB';")"

# L'enfilement est appelé DIRECTEMENT (et non via la reprise) pour que
# cette preuve porte sur la fonction RESTAURÉE elle-même, sans dépendre
# des critères de sélection de recover_missing_order_received_notifications.
run_sql "$DB" service_role '' \
  "select public.create_order_received_notification('$ORDER_AFTER_RB','$RID_A');" >/dev/null
assert_eq "10j. RÉVERSIBILITÉ — payload order_received revenu à ses 6 clés historiques" \
  "created_at,currency,order_number,public_token,service_mode,total" \
  "$(sql_raw "select coalesce(string_agg(k, ',' order by k),'<vide>') from public.notification_outbox o, jsonb_object_keys(o.payload_snapshot) k where o.order_id='$ORDER_AFTER_RB';")"
assert_eq "10k. RÉVERSIBILITÉ — le déclencheur d'intention order_received est TOUJOURS là" "1" \
  "$(sql_value "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='orders' and t.tgname='orders_record_order_received_intent_trg' and not t.tgisinternal;")"
assert_eq "10l. RÉVERSIBILITÉ — AUCUNE commande ni ligne de commande perdue" "1|1" \
  "$([ "$(sql_value "select count(*) from public.orders;")" -ge "$ORDERS_BEFORE" ] && echo 1 || echo 0)|$([ "$(sql_value "select count(*) from public.order_items;")" -ge "$ITEMS_BEFORE" ] && echo 1 || echo 0)"
assert_eq "10m. RÉVERSIBILITÉ — la commande HISTORIQUE est toujours intacte" "Client Historique" \
  "$(sql_raw "select customer_name from public.orders where id='$LEGACY_ORDER';")"
assert_eq "10n. RÉVERSIBILITÉ — comptes de schéma identiques au prédécesseur" \
  "$(echo "$COUNTS_BEFORE" | awk -F'|' '{printf "%s|%s|%s", $1, $2, $3}')" \
  "$(schema_counts "$DB_MAIN" | awk -F'|' '{printf "%s|%s|%s", $1, $2, $3}')"

# Le rollback CFTE v1 est une RESTAURATION d'état connu, pas une
# migration versionnée : il ne porte pas de garde anti-double-exécution
# et le rejouer est donc légal. Ce qui est exigé, et vérifié ici, c'est
# qu'un second passage soit IDEMPOTENT -- ni erreur, ni dérive.
apply_path "$ROLLBACK_SQL" "$DB_MAIN"; RC_RB2=$?
assert_eq "10o. second rollback IDEMPOTENT : réussit et ne dérive pas" "0|0|0|0|0|0" \
  "$RC_RB2|$(cfte_footprint "$DB_MAIN")"
assert_eq "10o-bis. second rollback : create_order toujours celle du prédécesseur" \
  "$FPC_CREATE_ORDER_BEFORE" "$(fn_code_fingerprint create_order)"

apply_path "$FORWARD_SQL" "$DB_MAIN"; RC_REAPPLY=$?
assert_eq "10p. ré-application après rollback ACCEPTÉE (aller/retour rejouable)" "0" "$RC_REAPPLY"
assert_eq "10q. ré-application : la précédence e-mail est de nouveau effective" "required" \
  "$(sql_value "select requirement from public.effective_sale_mode_field_requirements('$RID_A','pickup') where field='email';")"

# ============================================================
# BILAN — le compte qui fait foi est LU depuis le journal brut
# (CFTE-V1-EVIDENCE-COUNT-01).
# ============================================================
RAW_FAILURES="$(wc -l < "$FAIL_LOG" | tr -d ' ')"
log "=== BILAN : $PASS_COUNT PASS / $RAW_FAILURES FAIL (journal brut faisant foi) ==="

if [ "$RAW_FAILURES" != "$FAIL_COUNT" ]; then
  log "FAIL: AUTO-TEST DU HARNAIS -- le compteur ($FAIL_COUNT) diverge du journal brut ($RAW_FAILURES)."
  log "      Le résumé ne doit JAMAIS être plus rassurant que l'ensemble brut des échecs."
  RAW_FAILURES=$((RAW_FAILURES + 1))
fi

if [ "$RAW_FAILURES" -gt 0 ]; then
  log "--- ENSEMBLE BRUT DES ÉCHECS ($RAW_FAILURES) ---"
  cat "$FAIL_LOG"
  exit 1
fi

log "toutes les preuves sont produites."
exit 0

# ============================================================
# NOTE D'ATTRIBUTION — CFTE-V1-EVIDENCE-COUNT-01
#
# L'audit a relevé un résumé annonçant « 1 » là où l'ensemble brut
# contenait 14 échecs PAR SENS (aller et retour). Inventaire complet de
# l'outillage de test DU DÉPÔT PRODUIT :
#
#   1. `npm test` -> node:test (tests/*.test.ts). Le décompte affiché
#      (`# fail N`) est produit par le lanceur lui-même à partir de
#      l'ensemble des tests échoués : il n'existe aucune étape de
#      résumé distincte qui pourrait diverger de ses propres données.
#   2. supabase/tests/*-check.sh. Chaque harnais imprime son BILAN à
#      partir du MÊME compteur qu'il incrémente à chaque `fail`, et
#      imprime intégralement son journal d'échecs.
#   3. .github/workflows/restaurant-context-critical-regression-gate.yml
#      ne propage qu'un code de sortie, sans agrégation.
#
# Surtout : AUCUN harnais PostgreSQL CFTE v1 n'existait dans le dépôt
# produit au moment de l'audit -- c'est précisément la constatation
# tenue en HOLD par ailleurs, et à laquelle ce fichier répond. Un
# ensemble brut « 14 par sens » ne peut donc pas avoir été produit ici.
# L'écart appartient à l'outillage d'orchestration, hors du dépôt
# produit : conformément au mandat, AUCUN code produit n'a été modifié
# pour lui.
#
# Ce qui a été fait ici, en revanche, est de rendre la classe entière de
# défaut IMPOSSIBLE dans le nouveau livrable : le BILAN ci-dessus ne
# publie pas un compteur, il publie `wc -l` du journal brut, et l'AUTO-
# TEST DU HARNAIS échoue explicitement si les deux divergent -- même
# posture que la leçon V72-01 déjà acquise dans ce dépôt (« le script
# échoue si le journal de FAIL indépendant contient une seule ligne,
# MÊME si FAIL_COUNT affiche 0 »).
# ============================================================
