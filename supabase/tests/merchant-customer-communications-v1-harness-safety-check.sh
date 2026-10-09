#!/usr/bin/env bash
# ============================================================
# Scanym — MERCHANT CUSTOMER COMMUNICATIONS v1.1
# PREUVES DE SÛRETÉ du harnais
#   supabase/tests/merchant-customer-communications-v1-check.sh
#
# Ferme MCC-V1-HARNESS-UNSAFE-TARGET-01 (audit indépendant
# OpenAI/Codex, blocker 3). Même patron et même philosophie que
# supabase/tests/translations-management-v2-harness-safety-check.sh,
# le harnais de sûreté de référence du dépôt.
#
# Un harnais qui AFFIRME être sûr sans le prouver ne vaut pas mieux
# qu'un harnais dangereux : ce fichier exécute RÉELLEMENT le harnais
# dans des environnements hostiles et vérifie qu'il REFUSE.
#
# CE QU'IL PROUVE (exécuté, jamais inspecté) :
#   [A] un PGPORT hérité ne peut pas rediriger l'exécution ;
#   [B] un mot de passe, un passfile ou une URL de base hérités ne
#       peuvent pas rediriger l'exécution ;
#   [C] sans SCANYM_DISPOSABLE_CLUSTER=1, le harnais refuse ;
#   [D] une base PORTANT DÉJÀ un nom de test provoque un REFUS, et
#       cette base EXISTE TOUJOURS après -- jamais un DROP ;
#   [E] sur un cluster jetable que le harnais possède, il PASSE ;
#   [F] le nettoyage ne touche QUE les ressources de l'exécution : une
#       base témoin créée à côté survit, les bases du harnais non ;
#   [G] aucune VALEUR de variable sensible n'apparaît dans la sortie --
#       seul son NOM ;
#   [H] un cluster portant une base au nom protégé (prod/live/preprod)
#       est refusé ;
#   [I] une socket désignée inexistante, ou un hôte TCP, est refusée.
#
# Usage, depuis la racine du dépôt :
#   SCANYM_DISPOSABLE_CLUSTER=1 \
#     bash supabase/tests/merchant-customer-communications-v1-harness-safety-check.sh
#
# Sortie : 0 = toutes les preuves produites ; 1 = au moins un échec.
# ============================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="$SCRIPT_DIR/merchant-customer-communications-v1-check.sh"
[ -f "$HARNESS" ] || { echo "FATAL : harnais introuvable ($HARNESS)" >&2; exit 1; }

PASS=0
FAIL=0
log()  { printf '[%s] %s\n' "$(date -u '+%H:%M:%S')" "$*"; }
pass() { PASS=$((PASS+1)); log "PASS: $*"; }
fail() { FAIL=$((FAIL+1)); log "FAIL: $*"; }

if [ "${SCANYM_DISPOSABLE_CLUSTER:-}" != "1" ]; then
  echo "REFUS : SCANYM_DISPOSABLE_CLUSTER=1 requis (ce fichier démarre lui aussi des clusters jetables)." >&2
  exit 2
fi
[ "$(id -u)" != "0" ] || { echo "REFUS : initdb ne s'exécute pas en root. Relancez sous un utilisateur non privilégié." >&2; exit 2; }

TMP="$(mktemp -d)"
OUT="$TMP/out.txt"
REFUSE_EXIT=2

# Cluster TÉMOIN, créé et détruit PAR CE FICHIER : il sert aux
# scénarios [D], [F] et [H], qui exigent un cluster préexistant du
# point de vue du harnais testé.
INITDB=""
for cand in initdb /usr/lib/postgresql/*/bin/initdb; do
  if command -v "$cand" >/dev/null 2>&1; then INITDB="$cand"; break; fi
done
[ -n "$INITDB" ] || { echo "FATAL : initdb introuvable." >&2; exit 1; }
PG_CTL="$(dirname "$INITDB")/pg_ctl"; [ -x "$PG_CTL" ] || PG_CTL="pg_ctl"

WITNESS_DATA="$TMP/witness/data"
WITNESS_SOCK="$TMP/witness/sock"
WITNESS_PORT=$(( 49152 + (($$ + 7777) % 16000) ))
WITNESS_UP=0

start_witness() {
  mkdir -p "$WITNESS_SOCK"
  "$INITDB" -D "$WITNESS_DATA" -A trust -E UTF8 --locale=C >"$TMP/witness-initdb.log" 2>&1 \
    || { echo "FATAL : initdb témoin a échoué." >&2; exit 1; }
  "$PG_CTL" -D "$WITNESS_DATA" -l "$TMP/witness.log" \
    -o "-p $WITNESS_PORT -k $WITNESS_SOCK -c listen_addresses=''" start >/dev/null 2>&1 \
    || { echo "FATAL : démarrage du cluster témoin impossible." >&2; exit 1; }
  WITNESS_UP=1
}
witness_sql() {
  PGHOST="$WITNESS_SOCK" PGPORT="$WITNESS_PORT" PGDATABASE=postgres \
    psql -X -A -q -t -c "$1" </dev/null 2>/dev/null | tail -1 | tr -d ' '
}
witness_db_exists() { [ "$(witness_sql "select count(*) from pg_database where datname='$1';")" = "1" ]; }

cleanup() {
  local rc=$?
  [ "$WITNESS_UP" = "1" ] && "$PG_CTL" -D "$WITNESS_DATA" stop -m immediate >/dev/null 2>&1
  rm -rf "$TMP"
  exit "$rc"
}
trap cleanup EXIT

# `env -i` : on part d'un environnement VIDE et on n'injecte QUE ce que
# le scénario veut tester. Sans cela, l'environnement de l'opérateur
# polluerait la preuve.
run_harness() {
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" "$@" bash "$HARNESS" >"$OUT" 2>&1
  printf '%s' "$?"
}

expect_refusal() {
  local label="$1"; shift
  local rc; rc="$(run_harness "$@")"
  if [ "$rc" = "$REFUSE_EXIT" ] && grep -q "REFUS DE SÛRETÉ" "$OUT"; then
    pass "$label — refusé (code $rc), avec un message explicite"
  else
    fail "$label — attendu un refus (code $REFUSE_EXIT + « REFUS DE SÛRETÉ »), obtenu code $rc : $(grep -m1 -E 'REFUS|FATAL|BILAN' "$OUT" | tr -d '\n')"
  fi
  # Et le refus doit être ANTÉRIEUR à toute opération destructrice.
  if grep -q "Aucune opération destructive n'a été tentée" "$OUT"; then
    pass "$label — le refus précède toute opération destructive"
  else
    fail "$label — le refus ne garantit pas l'absence d'opération destructive"
  fi
}

# ============================================================
# [A] Un PGPORT hérité ne peut pas rediriger l'exécution.
# ============================================================
log "=== [A] PGPORT hérité ==="
expect_refusal "[A] PGPORT hérité" SCANYM_DISPOSABLE_CLUSTER=1 PGPORT=6543

# ============================================================
# [B] Mot de passe, passfile et URLs de base hérités.
# ============================================================
log "=== [B] identifiants et URLs hérités ==="
PASSFILE="$TMP/pgpass"
printf 'db.prod.example.com:5432:app:app:SENTINEL_PASSWORD\n' > "$PASSFILE"
chmod 600 "$PASSFILE"
expect_refusal "[B] PGPASSWORD hérité"    SCANYM_DISPOSABLE_CLUSTER=1 PGPASSWORD=SENTINEL_PASSWORD
expect_refusal "[B] PGPASSFILE hérité"    SCANYM_DISPOSABLE_CLUSTER=1 PGPASSFILE="$PASSFILE"
expect_refusal "[B] DATABASE_URL hérité"  SCANYM_DISPOSABLE_CLUSTER=1 DATABASE_URL="postgres://u:SENTINEL_PASSWORD@db.prod.example.com:5432/app"
expect_refusal "[B] POSTGRES_URL hérité"  SCANYM_DISPOSABLE_CLUSTER=1 POSTGRES_URL="postgres://u:SENTINEL_PASSWORD@db.prod.example.com:5432/app"
expect_refusal "[B] SUPABASE_DB_URL hérité" SCANYM_DISPOSABLE_CLUSTER=1 SUPABASE_DB_URL="postgres://u:SENTINEL_PASSWORD@db.prod.example.com:5432/app"
expect_refusal "[B] PGHOST hérité"        SCANYM_DISPOSABLE_CLUSTER=1 PGHOST=db.production.example.com
expect_refusal "[B] PGUSER hérité"        SCANYM_DISPOSABLE_CLUSTER=1 PGUSER=app
expect_refusal "[B] PGDATABASE hérité"    SCANYM_DISPOSABLE_CLUSTER=1 PGDATABASE=scanym_production
expect_refusal "[B] PGSERVICE hérité"     SCANYM_DISPOSABLE_CLUSTER=1 PGSERVICE=production
expect_refusal "[B] PGSERVICEFILE hérité" SCANYM_DISPOSABLE_CLUSTER=1 PGSERVICEFILE="$TMP/pgservice.conf"
expect_refusal "[B] PGHOSTADDR hérité"    SCANYM_DISPOSABLE_CLUSTER=1 PGHOSTADDR=203.0.113.10

# ============================================================
# [C] Sans consentement explicite, refus.
# ============================================================
log "=== [C] consentement explicite ==="
RC="$(run_harness)"
if [ "$RC" = "$REFUSE_EXIT" ] && grep -q "SCANYM_DISPOSABLE_CLUSTER=1 est requis" "$OUT"; then
  pass "[C] sans SCANYM_DISPOSABLE_CLUSTER=1 — refusé, et le message dit quoi faire"
else
  fail "[C] sans consentement, attendu un refus (code $REFUSE_EXIT), obtenu $RC"
fi
RC="$(run_harness SCANYM_DISPOSABLE_CLUSTER=0)"
[ "$RC" = "$REFUSE_EXIT" ] && pass "[C] SCANYM_DISPOSABLE_CLUSTER=0 — refusé aussi" \
  || fail "[C] SCANYM_DISPOSABLE_CLUSTER=0 devrait être refusé (obtenu $RC)"
RC="$(run_harness SCANYM_DISPOSABLE_CLUSTER=true)"
[ "$RC" = "$REFUSE_EXIT" ] && pass "[C] une valeur autre que « 1 » — refusée (égalité STRICTE)" \
  || fail "[C] seule la valeur « 1 » devrait consentir (obtenu $RC)"

# ============================================================
# [I] Socket désignée invalide.
# ============================================================
log "=== [I] socket désignée invalide ==="
expect_refusal "[I] socket désignée inexistante" SCANYM_DISPOSABLE_CLUSTER=1 SCANYM_HARNESS_PGHOST="$TMP/aucune-socket"
expect_refusal "[I] hôte TCP au lieu d'une socket" SCANYM_DISPOSABLE_CLUSTER=1 SCANYM_HARNESS_PGHOST="db.prod.example.com"

# ============================================================
# Cluster témoin, pour [D], [F] et [H].
# ============================================================
log "=== démarrage du cluster témoin (créé et détruit par CE fichier) ==="
start_witness
pass "cluster témoin démarré (socket $WITNESS_SOCK)"

# ============================================================
# [D] Une base portant déjà un nom de test => REFUS, jamais un DROP.
# ============================================================
log "=== [D] collision de nom : refus, pas destruction ==="
COLLIDE_TAG="selftest_collision"
COLLIDE_DB="scanym_mcc_v1_base_$COLLIDE_TAG"
PGHOST="$WITNESS_SOCK" PGPORT="$WITNESS_PORT" createdb "$COLLIDE_DB" 2>/dev/null \
  || fail "[D] impossible de créer la base de collision témoin"
# Un marqueur DANS la base : s'il survit, la base n'a pas été recréée.
PGHOST="$WITNESS_SOCK" PGPORT="$WITNESS_PORT" psql -X -q -d "$COLLIDE_DB" \
  -c "create table ne_pas_detruire (preuve text); insert into ne_pas_detruire values ('intacte');" >/dev/null 2>&1

RC="$(run_harness SCANYM_DISPOSABLE_CLUSTER=1 SCANYM_HARNESS_PGHOST="$WITNESS_SOCK" SCANYM_HARNESS_PGPORT="$WITNESS_PORT" \
      SCANYM_HARNESS_SELFTEST=1 SCANYM_HARNESS_RUN_TAG="$COLLIDE_TAG")"
if [ "$RC" = "$REFUSE_EXIT" ] && grep -q "existe déjà et n'a pas été créée par cette exécution" "$OUT"; then
  pass "[D] collision de nom — refusée, en nommant la cause"
else
  fail "[D] collision de nom — attendu un refus (code $REFUSE_EXIT), obtenu $RC : $(grep -m1 -E 'REFUS|FATAL' "$OUT" | tr -d '\n')"
fi
if witness_db_exists "$COLLIDE_DB"; then
  pass "[D] la base préexistante EXISTE TOUJOURS — aucun DROP"
else
  fail "[D] LA BASE PRÉEXISTANTE A ÉTÉ DÉTRUITE — c'est exactement le défaut à fermer"
fi
MARKER="$(PGHOST="$WITNESS_SOCK" PGPORT="$WITNESS_PORT" psql -X -A -q -t -d "$COLLIDE_DB" \
  -c "select preuve from ne_pas_detruire;" </dev/null 2>/dev/null | tail -1 | tr -d ' ')"
[ "$MARKER" = "intacte" ] && pass "[D] son CONTENU est intact (ni recréée, ni vidée)" \
  || fail "[D] le contenu de la base préexistante a été altéré (obtenu « $MARKER »)"

# ============================================================
# [E]/[F] Exécution RÉUSSIE sur cluster jetable, puis nettoyage
#         limité aux ressources de l'exécution.
# ============================================================
log "=== [E] exécution réussie / [F] nettoyage limité ==="
SENTINEL_DB="scanym_temoin_a_ne_pas_toucher_$$"
PGHOST="$WITNESS_SOCK" PGPORT="$WITNESS_PORT" createdb "$SENTINEL_DB" 2>/dev/null \
  || fail "[F] impossible de créer la base témoin"

DBS_BEFORE="$(witness_sql "select count(*) from pg_database;")"
RC="$(run_harness SCANYM_DISPOSABLE_CLUSTER=1 SCANYM_HARNESS_PGHOST="$WITNESS_SOCK" SCANYM_HARNESS_PGPORT="$WITNESS_PORT")"
if [ "$RC" = "0" ] && grep -q "0 échec" "$OUT"; then
  pass "[E] sur un cluster jetable désigné — le harnais PASSE (code 0, 0 échec)"
else
  fail "[E] attendu une exécution réussie, obtenu code $RC : $(grep -m1 'BILAN' "$OUT" | tr -d '\n')"
fi
if grep -q "verrou de sûreté franchi" "$OUT"; then
  pass "[E] le verrou de sûreté a bien été FRANCHI (et non contourné)"
else
  fail "[E] aucune trace du franchissement du verrou de sûreté"
fi

if witness_db_exists "$SENTINEL_DB"; then
  pass "[F] la base témoin voisine a SURVÉCU au nettoyage"
else
  fail "[F] LE NETTOYAGE A DÉTRUIT UNE BASE QUI N'APPARTENAIT PAS AU HARNAIS"
fi
if witness_db_exists "$COLLIDE_DB"; then
  pass "[F] la base de collision de [D] a survécu elle aussi"
else
  fail "[F] la base de collision a été détruite par une exécution ultérieure"
fi
LEFTOVER="$(witness_sql "select count(*) from pg_database where datname like 'scanym_mcc_v1_%';")"
# Seule la base de collision de [D] doit subsister (c'est CE FICHIER qui
# l'a créée, pas le harnais).
if [ "$LEFTOVER" = "1" ]; then
  pass "[F] aucune base du harnais ne subsiste (seule la base de collision de ce fichier reste)"
else
  fail "[F] $LEFTOVER base(s) « scanym_mcc_v1_% » subsistent, attendu 1"
fi
DBS_AFTER="$(witness_sql "select count(*) from pg_database;")"
[ "$DBS_BEFORE" = "$DBS_AFTER" ] \
  && pass "[F] le nombre de bases du cluster est INCHANGÉ ($DBS_AFTER)" \
  || fail "[F] le cluster est passé de $DBS_BEFORE à $DBS_AFTER bases"

# ============================================================
# [G] Aucune VALEUR sensible dans la sortie — seul le NOM.
# ============================================================
log "=== [G] aucune valeur sensible journalisée ==="
check_no_secret() {
  local label="$1" varname="$2" secret="$3"; shift 3
  run_harness "$@" >/dev/null 2>&1 || true
  if grep -q "$secret" "$OUT"; then
    fail "$label — LA VALEUR a fuité dans la sortie"
  elif grep -q "$varname" "$OUT"; then
    pass "$label — le NOM est signalé, la valeur jamais"
  else
    fail "$label — la variable n'est même pas signalée par son nom"
  fi
}
check_no_secret "[G] PGPASSWORD" "PGPASSWORD" "SENTINEL_PASSWORD" \
  SCANYM_DISPOSABLE_CLUSTER=1 PGPASSWORD="SENTINEL_PASSWORD"
check_no_secret "[G] DATABASE_URL" "DATABASE_URL" "SENTINEL_PASSWORD" \
  SCANYM_DISPOSABLE_CLUSTER=1 DATABASE_URL="postgres://u:SENTINEL_PASSWORD@db.prod.example.com:5432/app"
check_no_secret "[G] SUPABASE_DB_URL" "SUPABASE_DB_URL" "SENTINEL_PASSWORD" \
  SCANYM_DISPOSABLE_CLUSTER=1 SUPABASE_DB_URL="postgres://u:SENTINEL_PASSWORD@db.prod.example.com:5432/app"
check_no_secret "[G] PGPASSFILE" "PGPASSFILE" "$PASSFILE" \
  SCANYM_DISPOSABLE_CLUSTER=1 PGPASSFILE="$PASSFILE"

# ============================================================
# [H] Un cluster portant une base au nom PROTÉGÉ est refusé.
# ============================================================
log "=== [H] nom d'environnement protégé ==="
PGHOST="$WITNESS_SOCK" PGPORT="$WITNESS_PORT" createdb "scanym_production_$$" 2>/dev/null \
  || fail "[H] impossible de créer la base au nom protégé"
RC="$(run_harness SCANYM_DISPOSABLE_CLUSTER=1 SCANYM_HARNESS_PGHOST="$WITNESS_SOCK" SCANYM_HARNESS_PGPORT="$WITNESS_PORT")"
if [ "$RC" = "$REFUSE_EXIT" ] && grep -q "nom évoquant un environnement protégé" "$OUT"; then
  pass "[H] cluster portant une base « production » — refusé, fermé"
else
  fail "[H] attendu un refus (code $REFUSE_EXIT), obtenu $RC"
fi
if witness_db_exists "scanym_production_$$"; then
  pass "[H] et la base protégée n'a PAS été touchée"
else
  fail "[H] LA BASE AU NOM PROTÉGÉ A ÉTÉ DÉTRUITE"
fi

# ============================================================
# BILAN
# ============================================================
log "=== BILAN SÛRETÉ : $PASS preuve(s), $FAIL échec(s) ==="
[ "$FAIL" -eq 0 ] || exit 1
[ "$PASS" -gt 0 ] || { log "FATAL : aucune preuve produite."; exit 1; }
exit 0
