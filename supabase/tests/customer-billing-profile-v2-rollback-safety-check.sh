#!/usr/bin/env bash
# =====================================================================
# Scanym — CUSTOMER BILLING PROFILE v2.1 — CBP-02
# Banc d'essai PostgreSQL RÉEL de la sûreté transactionnelle du
# rollback. Prouve des COMPORTEMENTS, pas des chaînes de caractères.
#
# Quatre scénarios exigés par le mandat de remédiation :
#
#   ROLLBACK-SAFETY-01  un SIREN existe -> le rollback échoue, la
#                       colonne ET la donnée restent intactes.
#   ROLLBACK-SAFETY-02  exécuteur SANS ON_ERROR_STOP -> la garde
#                       échoue et la destruction n'a TOUJOURS PAS lieu.
#                       La sûreté vient de la transaction, pas du shell.
#   ROLLBACK-SAFETY-03  écrivain concurrent -> il ne peut pas écrire un
#                       SIREN dans la fenêtre entre la garde et la
#                       destruction ; l'issue finale reste sûre.
#   ROLLBACK-SAFETY-04  sans SIREN, le rollback réussit et restaure le
#                       schéma d'avant le lot.
#
# N'APPLIQUE RIEN À SUPABASE HÉBERGÉ : base locale jetable uniquement.
# =====================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS="${HARNESS_DIR:-/var/lib/postgresql/harness/billing}"
DB="${DB_NAME:-cbp02}"
PSQL="psql -X -q -v ON_ERROR_STOP=1 -d ${DB}"
FAILURES=0

say()  { printf '\n=== %s\n' "$*"; }
ok()   { printf '  OK   %s\n' "$*"; }
bad()  { printf '  FAIL %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

q() { psql -X -At -q -d "${DB}" -c "$1"; }

# ---------------------------------------------------------------------
# Remise à neuf : schéma de banc d'essai + prérequis du dépôt + lot.
# Les prérequis sont EXTRAITS des fichiers du dépôt, jamais réécrits.
# ---------------------------------------------------------------------
reset_db() {
  dropdb --if-exists "${DB}" >/dev/null 2>&1
  createdb "${DB}"
  ${PSQL} -f "${HARNESS}/schema.sql"   >/dev/null
  ${PSQL} -f "${HARNESS}/prereq.sql"   >/dev/null
  ${PSQL} -f "${HARNESS}/prereq2.sql"  >/dev/null
  ${PSQL} -f "${REPO_ROOT}/supabase/DRAFT-lot-customer-billing-profile-v2.sql" >/dev/null
  ${PSQL} -c "insert into public.restaurants(id, name) values ('a0000000-0000-0000-0000-00000000000a','Banc d''essai');" >/dev/null
  ${PSQL} -c "insert into public.orders(id, restaurant_id, public_token) values ('b0000000-0000-0000-0000-00000000000b','a0000000-0000-0000-0000-00000000000a','c0000000-0000-0000-0000-00000000000c');" >/dev/null
}

seed_invoice_with_siren() {
  ${PSQL} -c "select public.set_order_invoice_request(
      'b0000000-0000-0000-0000-00000000000b','c0000000-0000-0000-0000-00000000000c',
      'company','1 rue du Test','Paris','75001','FR', null, 'ACME SARL', null, null, null, '123456789');" >/dev/null
}

seed_invoice_without_siren() {
  ${PSQL} -c "select public.set_order_invoice_request(
      'b0000000-0000-0000-0000-00000000000b','c0000000-0000-0000-0000-00000000000c',
      'individual','1 rue du Test','Paris','75001','FR');" >/dev/null
}

siren_column_exists() {
  [ "$(q "select exists (select 1 from information_schema.columns where table_schema='public' and table_name='order_invoice_request' and column_name='siren')")" = "t" ]
}

# =====================================================================
say "ROLLBACK-SAFETY-01 — un SIREN saisi par un client bloque le rollback"
# =====================================================================
reset_db
seed_invoice_with_siren
BEFORE="$(q "select siren from public.order_invoice_request")"
OUT="$(psql -X -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${REPO_ROOT}/supabase/DRAFT-lot-customer-billing-profile-v2-rollback.sql" 2>&1)"
RC=$?
if [ "${RC}" -ne 0 ]; then ok "le rollback échoue (code ${RC})"; else bad "le rollback a réussi alors qu'un SIREN existe"; fi
if printf '%s' "${OUT}" | grep -q "SCANYM_ROLLBACK_BLOCKED"; then ok "garde SCANYM_ROLLBACK_BLOCKED déclenchée"; else bad "garde de données non déclenchée : ${OUT}"; fi
if siren_column_exists; then ok "la colonne siren existe toujours"; else bad "la colonne siren a été détruite"; fi
AFTER="$(q "select siren from public.order_invoice_request")"
if [ "${AFTER}" = "${BEFORE}" ] && [ "${AFTER}" = "123456789" ]; then ok "la donnée est intacte (${AFTER})"; else bad "donnée altérée : « ${BEFORE} » -> « ${AFTER} »"; fi

# =====================================================================
say "ROLLBACK-SAFETY-02 — exécuteur SANS ON_ERROR_STOP : aucune destruction"
# =====================================================================
reset_db
seed_invoice_with_siren
# psql SANS -v ON_ERROR_STOP : par défaut, il POURSUIT après une erreur.
OUT="$(psql -X -q -d "${DB}" -f "${REPO_ROOT}/supabase/DRAFT-lot-customer-billing-profile-v2-rollback.sql" 2>&1)"
if printf '%s' "${OUT}" | grep -q "SCANYM_ROLLBACK_BLOCKED"; then ok "la garde a bien levé"; else bad "garde non déclenchée"; fi
if printf '%s' "${OUT}" | grep -q "current transaction is aborted"; then
  ok "les instructions suivantes sont refusées (transaction abandonnée)"
else
  bad "aucune preuve que la suite du fichier a été refusée"
fi
if siren_column_exists; then ok "la colonne siren existe toujours, SANS ON_ERROR_STOP"; else bad "DESTRUCTION malgré la garde (sûreté dépendante du shell)"; fi
if [ "$(q "select siren from public.order_invoice_request")" = "123456789" ]; then ok "la donnée est intacte"; else bad "donnée détruite"; fi
# La forme du lot est toujours en place : rien n'a été à moitié restauré.
if [ "$(q "select to_regprocedure('public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text,text)') is not null")" = "t" ]; then
  ok "aucune restauration partielle (RPC 13 arguments intacte)"
else
  bad "restauration partielle : la RPC du lot a disparu"
fi

# =====================================================================
say "ROLLBACK-SAFETY-03 — écrivain concurrent dans la fenêtre critique"
# =====================================================================
reset_db
seed_invoice_without_siren

# Les instructions de verrouillage ne sont PAS réécrites ici : elles
# sont EXTRAITES du fichier de rollback. Si le fichier descendait à un
# niveau ornemental (ACCESS SHARE, ROW SHARE…), c'est ce niveau-là qui
# serait rejoué, et l'écrivain concurrent passerait : le scénario
# échouerait par COMPORTEMENT, pas par inspection de chaîne.
LOCKS="$(grep -E '^lock table .*;$' "${REPO_ROOT}/supabase/DRAFT-lot-customer-billing-profile-v2-rollback.sql")"
if [ -z "${LOCKS}" ]; then bad "aucune instruction de verrouillage dans le fichier de rollback"; fi
printf '  — verrous extraits du fichier :\n%s\n' "$(printf '%s' "${LOCKS}" | sed 's/^/      /')"

# CONTRÔLE DE L'INSTRUMENT : sans verrou, l'écrivain B DOIT réussir.
# Sans cette contre-épreuve, un « délai dépassé » pourrait venir de
# n'importe quelle autre cause et le scénario serait complaisant.
WITNESS_FIFO="$(mktemp -u)"; mkfifo "${WITNESS_FIFO}"
psql -X -q -d "${DB}" -f "${WITNESS_FIFO}" > /tmp/cbp02-witness.log 2>&1 &
W_PID=$!
exec 4> "${WITNESS_FIFO}"
printf 'begin;\n' >&4
printf "select count(*) from public.order_invoice_request where siren is not null;\n" >&4
sleep 1
W_OUT="$(psql -X -q -d "${DB}" -c "set statement_timeout = '2s';" \
  -c "update public.order_invoice_request set siren = '888888888';" 2>&1)"
if [ -z "${W_OUT}" ] && [ "$(q "select siren from public.order_invoice_request")" = "888888888" ]; then
  ok "instrument valide : SANS verrou, l'écrivain concurrent aboutit"
else
  bad "instrument invalide : l'écrivain échoue même sans verrou : ${W_OUT}"
fi
printf 'rollback;\n' >&4
exec 4>&-
wait "${W_PID}" 2>/dev/null
rm -f "${WITNESS_FIFO}"
${PSQL} -c "update public.order_invoice_request set siren = null;" >/dev/null

# Transaction A : ouvre, rejoue LES VERROUS DU FICHIER, puis constate
# l'état -- exactement la séquence du fichier, maintenue ouverte pour
# matérialiser la fenêtre critique entre la garde et la destruction.
A_FIFO="$(mktemp -u)"; mkfifo "${A_FIFO}"
psql -X -q -d "${DB}" -f "${A_FIFO}" > /tmp/cbp02-A.log 2>&1 &
A_PID=$!
exec 3> "${A_FIFO}"
printf 'begin;\n' >&3
printf '%s\n' "${LOCKS}" >&3
printf "select count(*) as sirens_vus from public.order_invoice_request where siren is not null;\n" >&3
sleep 1

# Transaction B : tente d'écrire un SIREN PENDANT la fenêtre. Son
# statement_timeout borne l'attente : si le verrou protège vraiment,
# B ne peut pas aboutir.
B_OUT="$(psql -X -q -d "${DB}" -c "set statement_timeout = '2s';" \
  -c "update public.order_invoice_request set siren = '999999999';" 2>&1)"
if printf '%s' "${B_OUT}" | grep -qi "timeout"; then
  ok "l'écrivain concurrent est BLOQUÉ par le verrou DU FICHIER (délai dépassé)"
else
  bad "l'écrivain concurrent n'a pas été bloqué : ${B_OUT}"
fi
if [ "$(q "select count(*) from public.order_invoice_request where siren is not null")" = "0" ]; then
  ok "aucun SIREN n'a pu être validé dans la fenêtre"
else
  bad "un SIREN a été écrit pendant la fenêtre critique"
fi

# A se termine ; la fenêtre se referme.
printf 'rollback;\n' >&3
exec 3>&-
wait "${A_PID}" 2>/dev/null
rm -f "${A_FIFO}"

# Issue finale : le rollback complet, joué maintenant, est sûr.
OUT="$(psql -X -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${REPO_ROOT}/supabase/DRAFT-lot-customer-billing-profile-v2-rollback.sql" 2>&1)"
RC=$?
if [ "${RC}" -eq 0 ] && ! siren_column_exists; then
  ok "issue finale sûre : rollback complet réussi, colonne retirée"
else
  bad "issue finale incorrecte (code ${RC}) : ${OUT}"
fi

# Ancrage documentaire SECONDAIRE : le comportement ci-dessus est la
# preuve ; cette ligne ne sert qu'à nommer le niveau attendu dans le
# journal, pour que l'auditeur n'ait pas à le déduire.
if printf '%s' "${LOCKS}" | grep -qE '^lock table public\.order_invoice_request in share mode;$'; then
  ok "niveau déclaré : SHARE (en conflit avec ROW EXCLUSIVE) — cohérent avec le comportement observé"
else
  bad "le niveau de verrou du fichier a changé : ${LOCKS}"
fi

# =====================================================================
say "ROLLBACK-SAFETY-04 — sans SIREN, le rollback restaure le schéma d'avant le lot"
# =====================================================================
reset_db
seed_invoice_without_siren
OUT="$(psql -X -q -v ON_ERROR_STOP=1 -d "${DB}" -f "${REPO_ROOT}/supabase/DRAFT-lot-customer-billing-profile-v2-rollback.sql" 2>&1)"
RC=$?
if [ "${RC}" -eq 0 ]; then ok "le rollback réussit"; else bad "le rollback a échoué : ${OUT}"; fi
if ! siren_column_exists; then ok "colonne siren retirée"; else bad "colonne siren subsistante"; fi
# v2.1 (RECOMPOSITION) -- l'état à retrouver est celui du main COURANT
# (MCC v1 + THEME & CONTENT SETTINGS v1), PAS l'état pré-Theme : un
# rollback de facturation ne désinstalle pas Theme au passage.
[ "$(q "select cardinality(public.communication_text_keys())")" = "17" ] && ok "catalogue restauré à l'état du main courant (17)" || bad "catalogue non restauré"
[ "$(q "select cardinality(public.public_communication_text_keys())")" = "14" ] && ok "projection publique restaurée (14)" || bad "projection publique non restaurée"
[ "$(q "select count(*) from unnest(public.communication_text_keys()) k where k like 'order_help%'")" = "3" ] && ok "THEME PRÉSERVÉ : les 3 emplacements order_help_* survivent" || bad "un emplacement de Theme a été emporté"
[ "$(q "select 'billing_profile_explanation' = any(public.communication_text_keys())")" = "f" ] && ok "l'emplacement de facturation est parti, et lui seul" || bad "l'emplacement de facturation subsiste"
[ "$(q "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='set_order_invoice_request'")" = "1" ] && ok "une seule surcharge d'écriture" || bad "surcharges résiduelles"
[ "$(q "select to_regprocedure('public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text)') is not null")" = "t" ] && ok "forme 12 arguments restaurée" || bad "forme 12 arguments absente"
[ "$(q "select has_function_privilege('service_role','public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text)','execute')")" = "t" ] && ok "service_role conserve EXECUTE" || bad "privilège perdu"
[ "$(q "select has_function_privilege('anon','public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text)','execute')")" = "f" ] && ok "anon toujours sans EXECUTE" || bad "privilège élargi"
# La commande d'essai, elle, est intacte : un rollback de schéma ne
# touche pas aux données qu'il n'a pas à détruire.
[ "$(q "select count(*) from public.order_invoice_request")" = "1" ] && ok "la demande de facture est conservée" || bad "donnée perdue"

# =====================================================================
printf '\n'
if [ "${FAILURES}" -eq 0 ]; then
  printf 'CBP-02 : TOUS LES SCÉNARIOS DE SÛRETÉ SONT CONFORMES\n'
  exit 0
fi
printf 'CBP-02 : %s CONTRÔLE(S) EN ÉCHEC\n' "${FAILURES}"
exit 1
