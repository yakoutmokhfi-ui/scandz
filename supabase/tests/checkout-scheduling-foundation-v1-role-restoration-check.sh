#!/usr/bin/env bash
# ============================================================
# Scanym — CHECKOUT SCHEDULING FOUNDATION v1 (CSDJ-1)
# Harnais de SÛRETÉ dédié : RESTAURATION EXACTE DES ATTRIBUTS DE RÔLE.
#
# Ferme CSDJ1-AUD-06.
#
# ------------------------------------------------------------------
# LE DÉFAUT QUE CE FICHIER PROUVE FERMÉ
#
# `boolean::text` rend « true »/« false » en SQL ; « t »/« f » est la
# forme de l'affichage ALIGNÉ de psql, pas celle de la conversion. Le
# harnais principal capturait donc « true » et comparait à « t » : la
# comparaison échouait TOUJOURS, et la branche de repli restaurait
# NOLOGIN NOBYPASSRLS.
#
# Sur un cluster jetable que le harnais crée lui-même, c'était
# invisible : le cluster entier disparaît juste après. Mais en mode
# CLUSTER DÉSIGNÉ par l'opérateur (SCANYM_HARNESS_PGHOST), le nettoyage
# restaure réellement les rôles du cluster de l'opérateur -- et il les
# corrompait.
#
# ------------------------------------------------------------------
# CE QUE CE HARNAIS PROUVE (exécuté, jamais inspecté)
#
# Pour les QUATRE combinaisons initiales de LOGIN × BYPASSRLS, sur les
# trois rôles applicatifs, dans un cluster DÉSIGNÉ :
#   - le harnais principal s'exécute jusqu'au bout ;
#   - après son nettoyage, CHAQUE attribut de CHAQUE rôle est
#     exactement celui d'avant l'exécution.
# Plus deux contrôles de forme :
#   - l'instantané est bien encodé en 1/0, et non en true/false ;
#   - un instantané d'une autre forme fait REFUSER l'exécution, plutôt
#     que de laisser muter un cluster non restaurable.
#
# CE QUE CE HARNAIS NE FAIT PAS : il ne touche aucun cluster qu'il n'a
# pas créé lui-même, n'accepte aucune variable de connexion héritée, et
# ne journalise aucune valeur de variable.
#
# Usage :  SCANYM_DISPOSABLE_CLUSTER=1 \
#            bash supabase/tests/checkout-scheduling-foundation-v1-role-restoration-check.sh
# ============================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="$SCRIPT_DIR/checkout-scheduling-foundation-v1-check.sh"
[ -f "$HARNESS" ] || { echo "harnais principal introuvable" >&2; exit 1; }

PASS=0
FAIL=0
log()  { printf '[%s] %s\n' "$(date -u '+%H:%M:%S')" "$*"; }
pass() { PASS=$((PASS + 1)); log "PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); log "FAIL: $*"; }
fatal() { log "FATAL: $*"; exit 1; }

# Ce fichier démarre lui aussi un cluster jetable : il exige le même
# consentement explicite que le harnais qu'il met à l'épreuve.
if [ "${SCANYM_DISPOSABLE_CLUSTER:-}" != "1" ]; then
  log "REFUS : SCANYM_DISPOSABLE_CLUSTER=1 requis (ce fichier démarre un cluster jetable)."
  exit 2
fi
[ "$(id -u)" != "0" ] || fatal "initdb refuse de s'exécuter en root."

TMP_DIR="$(mktemp -d)"
PGDATA_DIR="$TMP_DIR/cluster"
SOCKET_DIR="$TMP_DIR/sock"
PORT=$(( 49152 + ($$ % 15000) ))
CLUSTER_UP=0

cleanup() {
  local rc=$?
  [ "$CLUSTER_UP" = "1" ] && "$PG_CTL" -D "$PGDATA_DIR" stop -m immediate >/dev/null 2>&1
  rm -rf "$TMP_DIR"
  exit "$rc"
}
trap cleanup EXIT

INITDB=""
for cand in initdb /usr/lib/postgresql/*/bin/initdb; do
  if command -v "$cand" >/dev/null 2>&1; then INITDB="$cand"; break; fi
done
[ -n "$INITDB" ] || fatal "initdb introuvable."
PG_CTL="$(dirname "$INITDB")/pg_ctl"
[ -x "$PG_CTL" ] || PG_CTL="pg_ctl"

mkdir -p "$SOCKET_DIR"
"$INITDB" -D "$PGDATA_DIR" -A trust -E UTF8 --locale=C >"$TMP_DIR/initdb.log" 2>&1 \
  || fatal "initdb a échoué : $(tail -3 "$TMP_DIR/initdb.log" | tr '\n' ' ')"
"$PG_CTL" -D "$PGDATA_DIR" -l "$TMP_DIR/pg.log" \
  -o "-p $PORT -k $SOCKET_DIR -c listen_addresses=''" start >/dev/null 2>&1 \
  || fatal "démarrage impossible : $(tail -3 "$TMP_DIR/pg.log" 2>/dev/null | tr '\n' ' ')"
CLUSTER_UP=1
log "cluster TÉMOIN créé par CE fichier (socket $SOCKET_DIR, port $PORT)."

q() { psql -X -A -q -t -h "$SOCKET_DIR" -p "$PORT" -d postgres -c "$1" </dev/null 2>/dev/null | tail -1 | tr -d ' '; }

# État d'un rôle sous une forme COMPARABLE, indépendante de toute
# convention d'affichage.
role_attrs() {
  q "select coalesce((select (case when rolcanlogin then 'LOGIN' else 'NOLOGIN' end)
                           || '+' ||
                             (case when rolbypassrls then 'BYPASSRLS' else 'NOBYPASSRLS' end)
                      from pg_roles where rolname = '$1'), 'ABSENT');"
}

APP_ROLES="anon authenticated service_role"

run_main_harness() {
  # `env -i` : on part d'un environnement VIDE et on n'injecte QUE le
  # consentement et la désignation du cluster. Aucune variable héritée
  # ne peut donc influencer l'exécution.
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" \
    SCANYM_DISPOSABLE_CLUSTER=1 \
    SCANYM_HARNESS_PGHOST="$SOCKET_DIR" \
    SCANYM_HARNESS_PGPORT="$PORT" \
    bash "$HARNESS" >"$TMP_DIR/main.log" 2>&1
  return $?
}

# ------------------------------------------------------------------
# [A] Les QUATRE combinaisons initiales
# ------------------------------------------------------------------
for combo in "NOLOGIN NOBYPASSRLS" "LOGIN NOBYPASSRLS" "NOLOGIN BYPASSRLS" "LOGIN BYPASSRLS"; do
  set -- $combo
  LK="$1"; BK="$2"
  log "=== [A] état initial des rôles : $LK + $BK ==="

  for r in $APP_ROLES; do
    q "do \$\$ begin
         if not exists (select 1 from pg_roles where rolname='$r') then
           execute 'create role $r $LK $BK';
         else
           execute 'alter role $r $LK $BK';
         end if;
       end \$\$;" >/dev/null
  done

  declare -A BEFORE=()
  for r in $APP_ROLES; do BEFORE[$r]="$(role_attrs "$r")"; done
  log "  avant : $(for r in $APP_ROLES; do printf '%s=%s ' "$r" "${BEFORE[$r]}"; done)"

  if run_main_harness; then
    pass "[A] $LK+$BK — le harnais principal s'exécute jusqu'au bout sur le cluster désigné"
  else
    fail "[A] $LK+$BK — le harnais principal a échoué : $(tail -3 "$TMP_DIR/main.log" | tr '\n' ' ')"
  fi

  for r in $APP_ROLES; do
    after="$(role_attrs "$r")"
    if [ "$after" = "${BEFORE[$r]}" ]; then
      pass "[A] $LK+$BK — '$r' restauré EXACTEMENT ($after)"
    else
      fail "[A] $LK+$BK — '$r' corrompu : avant '${BEFORE[$r]}', après '$after'"
    fi
  done
done

# ------------------------------------------------------------------
# [B] Forme de l'instantané : 1/0, jamais true/false ni t/f
# ------------------------------------------------------------------
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

# ------------------------------------------------------------------
# [C] Un rôle ABSENT avant l'exécution est RETIRÉ après
# ------------------------------------------------------------------
log "=== [C] un rôle absent avant doit être absent après ==="
q "drop role if exists service_role;" >/dev/null
BEFORE_ABSENT="$(role_attrs service_role)"
if [ "$BEFORE_ABSENT" = "ABSENT" ]; then
  if run_main_harness; then
    pass "[C] le harnais principal s'exécute avec un rôle initialement absent"
  else
    fail "[C] le harnais principal a échoué : $(tail -3 "$TMP_DIR/main.log" | tr '\n' ' ')"
  fi
  after="$(role_attrs service_role)"
  if [ "$after" = "ABSENT" ]; then
    pass "[C] 'service_role', absent avant, est bien absent après"
  else
    fail "[C] 'service_role' subsiste après l'exécution ($after) — le cluster de l'opérateur a été muté"
  fi
else
  fail "[C] impossible de préparer l'état « rôle absent »"
fi

log "=== BILAN RESTAURATION DE RÔLES : $PASS preuve(s), $FAIL échec(s) ==="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
