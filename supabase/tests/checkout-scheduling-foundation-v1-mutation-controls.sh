#!/usr/bin/env bash
# ============================================================
# CONTRÔLES DE MUTATION — CSDJ1-AUD-06 / CSDJ1-AUD-07
#
# Un harnais vert ne prouve rien si le défaut qu'il est censé interdire
# peut être réinjecté sans qu'il échoue. Ce fichier réinjecte TROIS
# défauts (M1, M3, M4 ; M2 relève d'une démonstration directe, cf. infra),
# chacun dans une COPIE, et exige que le harnais les voie.
#
# Ce fichier est VERSIONNÉ pour que l'audit puisse rejouer les contrôles.
# Il crée ses copies mutées dans ce répertoire et les SUPPRIME en sortie
# (trap EXIT) : il ne laisse aucun fichier derrière lui.
# ============================================================
set -u

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROLE_SRC="$TESTS_DIR/checkout-scheduling-foundation-v1-role-restoration-check.sh"
MAIN_SRC="$TESTS_DIR/checkout-scheduling-foundation-v1-check.sh"
MUT_ROLE="$TESTS_DIR/.mut-role-check.sh"
MUT_MAIN="$TESTS_DIR/.mut-main-check.sh"
OUT="${OUT_DIR:-/tmp}/csdj1-mutation-controls.log"

PASS=0
FAIL=0
say()  { printf '%s\n' "$*" | tee -a "$OUT"; }
ok()   { PASS=$((PASS + 1)); say "CONTROL PASS: $*"; }
ko()   { FAIL=$((FAIL + 1)); say "CONTROL FAIL: $*"; }
clean() { rm -f "$MUT_ROLE" "$MUT_MAIN"; }
trap clean EXIT

: > "$OUT"
say "=== CONTRÔLES DE MUTATION CSDJ-1 (AUD-06 / AUD-07) ==="

run_mut_role() {
  # Exécution de la COPIE mutée, dans un environnement vide.
  timeout 2400 sudo -u postgres \
    env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      HOME=/tmp SCANYM_DISPOSABLE_CLUSTER=1 \
      bash "$MUT_ROLE" >"$1" 2>&1
  printf '%s\n' "$?"
}

# ────────────────────────────────────────────────────────────
# M1 — AUD-07 : un appel client qui hérite de l'environnement
# ────────────────────────────────────────────────────────────
say "--- M1 : retrait d'un « env -i » devant un appel psql"
clean
cp "$MAIN_SRC" "$MUT_MAIN"
python3 - "$ROLE_SRC" "$MUT_ROLE" "$(basename "$MUT_MAIN")" <<'PY'
import sys, re
src, dst, main_name = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(src, encoding='utf-8').read()
s = s.replace('HARNESS="$SCRIPT_DIR/checkout-scheduling-foundation-v1-check.sh"',
              'HARNESS="$SCRIPT_DIR/%s"' % main_name)
# Retrait de l'isolation sur l'appel de q() UNIQUEMENT.
s = s.replace(
    'q() {\n  env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \\\n    "$PSQL"',
    'q() {\n    "$PSQL"', 1)
assert 'q() {\n    "$PSQL"' in s, "mutation M1 non appliquée"
open(dst, 'w', encoding='utf-8').write(s)
PY
chmod 755 "$MUT_ROLE" "$MUT_MAIN"
M1_RC="$(run_mut_role /tmp/csdj1-mut-m1.log)"
if [ "$M1_RC" != "0" ] && grep -q 'appel non isolé' /tmp/csdj1-mut-m1.log; then
  ok "M1 — le harnais DÉTECTE un appel client non isolé (code $M1_RC)"
  say "       $(grep -m1 'appel non isolé' /tmp/csdj1-mut-m1.log)"
else
  ko "M1 — l'appel non isolé passe inaperçu (code $M1_RC) : [E] ne prouve rien"
fi

# ────────────────────────────────────────────────────────────
# M2 — SANS OBJET ICI.
# La « nocivité » de PGHOSTADDR (le fait qu'il l'emporte sur un -h
# explicite et aboutisse réellement au témoin) n'est pas prouvée par
# mutation mais par DÉMONSTRATION DIRECTE, en lecture seule, dans la
# section [F] du harnais lui-même. Une mutation récursive du harnais
# aurait supprimé son propre garde-fou de récursion et prouvé moins.
# ────────────────────────────────────────────────────────────
# ────────────────────────────────────────────────────────────
# M3 — AUD-06 : instantané ::text + comparaison à 't'
# ────────────────────────────────────────────────────────────
say "--- M3 : réinjection du défaut d'instantané de rôle (::text / 't')"
clean
python3 - "$MAIN_SRC" "$MUT_MAIN" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding='utf-8').read()
old = """  probe "select coalesce((select 'EXISTS|' || (case when rolcanlogin then '1' else '0' end)
                                  || '|' || (case when rolbypassrls then '1' else '0' end)
                          from pg_roles where rolname = '$1'), 'ABSENT');\""""
new = """  probe "select coalesce((select 'EXISTS|' || rolcanlogin::text
                                  || '|' || rolbypassrls::text
                          from pg_roles where rolname = '$1'), 'ABSENT');\""""
assert old in s, "ancre role_state() introuvable"
s = s.replace(old, new, 1)
# Le verrou de sûreté accepte la forme dégradée, sinon il refuserait tôt.
s = s.replace("ABSENT|'EXISTS|0|0'|'EXISTS|0|1'|'EXISTS|1|0'|'EXISTS|1|1')",
              "ABSENT|'EXISTS|'*)", 1)
# La restauration compare à 't' (forme d'affichage aligné de psql).
s = s.replace('[ "$login" = "1" ]', '[ "$login" = "t" ]', 1)
s = s.replace('[ "$bypass" = "1" ]', '[ "$bypass" = "t" ]', 1)
open(dst, 'w', encoding='utf-8').write(s)
PY
python3 - "$ROLE_SRC" "$MUT_ROLE" "$(basename "$MUT_MAIN")" <<'PY'
import sys
src, dst, main_name = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(src, encoding='utf-8').read()
s = s.replace('HARNESS="$SCRIPT_DIR/checkout-scheduling-foundation-v1-check.sh"',
              'HARNESS="$SCRIPT_DIR/%s"' % main_name)
open(dst, 'w', encoding='utf-8').write(s)
PY
chmod 755 "$MUT_ROLE" "$MUT_MAIN"
M3_RC="$(run_mut_role /tmp/csdj1-mut-m3.log)"
M3_FAILS="$(grep -c 'FAIL:' /tmp/csdj1-mut-m3.log || true)"
if [ "$M3_RC" != "0" ] && [ "$M3_FAILS" -gt 0 ]; then
  ok "M3 — le défaut d'instantané est VU : $M3_FAILS échec(s), code $M3_RC"
  grep -m6 'FAIL:' /tmp/csdj1-mut-m3.log | sed 's/^/       /' | tee -a "$OUT"
else
  ko "M3 — le défaut d'instantané passe inaperçu (code $M3_RC) : AUD-06 n'est pas prouvé"
fi

# ────────────────────────────────────────────────────────────
# M4 — AUD-07 : preuve d'identité CASSÉE côté harnais principal
#      Une preuve qui échoue doit abandonner la restauration, et une
#      exécution nominale qui l'abandonne doit être DÉNONCÉE par [A].
# ────────────────────────────────────────────────────────────
say "--- M4 : preuve d'identité tardive cassée dans le harnais principal"
clean
python3 - "$MAIN_SRC" "$MUT_MAIN" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding='utf-8').read()
old = 'DEST_WANT="unix-socket|${PGPORT}|${CUR_USER}|on"'
assert old in s, "ancre DEST_WANT introuvable"
s = s.replace(old, 'DEST_WANT="unix-socket|${PGPORT}|${CUR_USER}|on|CASSE"', 1)
open(dst, 'w', encoding='utf-8').write(s)
PY
python3 - "$ROLE_SRC" "$MUT_ROLE" "$(basename "$MUT_MAIN")" <<'PY'
import sys
src, dst, main_name = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(src, encoding='utf-8').read()
s = s.replace('HARNESS="$SCRIPT_DIR/checkout-scheduling-foundation-v1-check.sh"',
              'HARNESS="$SCRIPT_DIR/%s"' % main_name)
open(dst, 'w', encoding='utf-8').write(s)
PY
chmod 755 "$MUT_ROLE" "$MUT_MAIN"
M4_RC="$(run_mut_role /tmp/csdj1-mut-m4.log)"
if [ "$M4_RC" != "0" ] && grep -q "ABANDONNÉE" /tmp/csdj1-mut-m4.log; then
  ok "M4 — une preuve d'identité cassée est DÉNONCÉE au lieu d'être subie (code $M4_RC)"
  grep -m3 'FAIL:' /tmp/csdj1-mut-m4.log | sed 's/^/       /' | tee -a "$OUT"
else
  ko "M4 — une preuve d'identité cassée désactive silencieusement la restauration (code $M4_RC)"
fi

clean
say "=== BILAN CONTRÔLES DE MUTATION : $PASS contrôle(s) concluant(s), $FAIL manquant(s) ==="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
