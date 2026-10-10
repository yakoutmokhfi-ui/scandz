#!/usr/bin/env bash
# ============================================================
# CONTRÔLES DE MUTATION — CSDJ1-AUD-06 / CSDJ1-AUD-07
#
# Un harnais vert ne prouve rien si le défaut qu'il est censé interdire
# peut être réinjecté sans qu'il échoue. Ce fichier réinjecte QUATRE
# défauts, chacun dans une COPIE, et exige que les harnais les voient.
#
# M1  un « env -i » retiré devant un appel client
# M2  (sans objet : démonstration directe, cf. section [F] du harnais)
# M3  l'instantané de rôle en ::text comparé à « t »  (défaut d'AUD-06)
# M4  le MARQUEUR retiré du prédicat d'identité       (défaut d'AUD-07,
#     seconde passe : la preuve partielle que l'audit a trouvée)
# M5  data_directory et config_file retirés du prédicat
#
# Ce fichier est VERSIONNÉ pour que l'audit puisse rejouer les contrôles.
# Il crée ses copies mutées dans ce répertoire et les SUPPRIME en sortie
# (trap EXIT) : il ne laisse aucun fichier derrière lui.
# ============================================================
set -u

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROLE_SRC="$TESTS_DIR/checkout-scheduling-foundation-v1-role-restoration-check.sh"
MAIN_SRC="$TESTS_DIR/checkout-scheduling-foundation-v1-check.sh"
LIB_SRC="$TESTS_DIR/csdj1-cluster-identity.sh"
MUT_ROLE="$TESTS_DIR/.mut-role-check.sh"
MUT_MAIN="$TESTS_DIR/.mut-main-check.sh"
MUT_LIB="$TESTS_DIR/.mut-cluster-identity.sh"
OUT="${OUT_DIR:-/tmp}/csdj1-mutation-controls.log"

for f in "$ROLE_SRC" "$MAIN_SRC" "$LIB_SRC"; do
  [ -f "$f" ] || { printf 'source absente : %s\n' "$f"; exit 1; }
done

PASS=0
FAIL=0
say() { printf '%s\n' "$*" | tee -a "$OUT"; }
ok()  { PASS=$((PASS + 1)); say "CONTROL PASS: $*"; }
ko()  { FAIL=$((FAIL + 1)); say "CONTROL FAIL: $*"; }
clean() { rm -f "$MUT_ROLE" "$MUT_MAIN" "$MUT_LIB"; }
trap clean EXIT

: > "$OUT"
say "=== CONTRÔLES DE MUTATION CSDJ-1 (AUD-06 / AUD-07) ==="

# Copie du harnais de rôles, redirigée vers les copies mutées.
# `main_name` est le harnais principal que la copie lancera ;
# `lib_name`, la bibliothèque d'identité qu'elle sourcera.
make_mut_role() {
  local main_name="$1" lib_name="$2"
  python3 -I - "$ROLE_SRC" "$MUT_ROLE" "$main_name" "$lib_name" "${3:-}" <<'PY'
import sys
src, dst, main_name, lib_name, strip_isolation = sys.argv[1:6]
s = open(src, encoding='utf-8').read()
s = s.replace('HARNESS="$SCRIPT_DIR/checkout-scheduling-foundation-v1-check.sh"',
              'HARNESS="$SCRIPT_DIR/%s"' % main_name, 1)
s = s.replace('IDENTITY_LIB="$SCRIPT_DIR/csdj1-cluster-identity.sh"',
              'IDENTITY_LIB="$SCRIPT_DIR/%s"' % lib_name, 1)
# La vérification structurelle de [E] lit le fichier COURANT ; on lui
# conserve le nom réel de la bibliothèque pour qu'elle juge la copie
# comme elle jugerait l'original.
if strip_isolation == 'strip-env-i':
    old = ('csdj1_runner_test() {\n'
           '  env -i PATH="$SAFE_PATH" HOME="$SAFE_HOME" \\\n'
           '    "$PSQL"')
    new = 'csdj1_runner_test() {\n    "$PSQL"'
    assert old in s, "ancre d'isolation introuvable"
    s = s.replace(old, new, 1)
open(dst, 'w', encoding='utf-8').write(s)
PY
}

run_mut_role() {
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
cp "$LIB_SRC" "$MUT_LIB"
make_mut_role "$(basename "$MUT_MAIN")" "$(basename "$MUT_LIB")" strip-env-i
chmod 755 "$MUT_ROLE" "$MUT_MAIN"
M1_RC="$(run_mut_role /tmp/csdj1-mut-m1.log)"
if [ "$M1_RC" != "0" ] && grep -q 'appel non isolé' /tmp/csdj1-mut-m1.log; then
  ok "M1 — le harnais DÉTECTE un appel client non isolé (code $M1_RC)"
  say "       $(grep -m1 'appel non isolé' /tmp/csdj1-mut-m1.log | cut -c1-120)"
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
cp "$LIB_SRC" "$MUT_LIB"
python3 -I - "$MAIN_SRC" "$MUT_MAIN" <<'PY'
import sys
src, dst = sys.argv[1:3]
s = open(src, encoding='utf-8').read()
old = """  probe "select coalesce((select 'EXISTS|' || (case when rolcanlogin then '1' else '0' end)
                                  || '|' || (case when rolbypassrls then '1' else '0' end)
                          from pg_roles where rolname = '$1'), 'ABSENT');\""""
new = """  probe "select coalesce((select 'EXISTS|' || rolcanlogin::text
                                  || '|' || rolbypassrls::text
                          from pg_roles where rolname = '$1'), 'ABSENT');\""""
assert old in s, "ancre role_state() introuvable"
s = s.replace(old, new, 1)
s = s.replace("ABSENT|'EXISTS|0|0'|'EXISTS|0|1'|'EXISTS|1|0'|'EXISTS|1|1')",
              "ABSENT|'EXISTS|'*)", 1)
s = s.replace('[ "$login" = "1" ]', '[ "$login" = "t" ]', 1)
s = s.replace('[ "$bypass" = "1" ]', '[ "$bypass" = "t" ]', 1)
open(dst, 'w', encoding='utf-8').write(s)
PY
make_mut_role "$(basename "$MUT_MAIN")" "$(basename "$MUT_LIB")"
chmod 755 "$MUT_ROLE" "$MUT_MAIN"
M3_RC="$(run_mut_role /tmp/csdj1-mut-m3.log)"
M3_FAILS="$(grep -c 'FAIL:' /tmp/csdj1-mut-m3.log || true)"
if [ "$M3_RC" != "0" ] && [ "$M3_FAILS" -gt 0 ]; then
  ok "M3 — le défaut d'instantané est VU : $M3_FAILS échec(s), code $M3_RC"
  grep -m4 'FAIL:' /tmp/csdj1-mut-m3.log | sed 's/^/       /' | tee -a "$OUT"
else
  ko "M3 — le défaut d'instantané passe inaperçu (code $M3_RC) : AUD-06 n'est pas prouvé"
fi

# ────────────────────────────────────────────────────────────
# M4 — AUD-07 (seconde passe) : le MARQUEUR retiré du prédicat
#
# C'est LA preuve partielle que l'audit a trouvée : une identité sans
# marqueur reste satisfaite quand le marqueur est changé ou retiré.
# Les contrôles négatifs [G] doivent le voir.
# ────────────────────────────────────────────────────────────
say "--- M4 : marqueur/nonce retiré du prédicat d'identité"
clean
cp "$MAIN_SRC" "$MUT_MAIN"
python3 -I - "$LIB_SRC" "$MUT_LIB" <<'PY'
import sys
src, dst = sys.argv[1:3]
s = open(src, encoding='utf-8').read()
# Le volet MARQUEUR ne vérifie plus rien : identité PARTIELLE.
# La fin de la fonction est la première ligne valant exactement « } »
# en début de ligne : le corps est un heredoc, dont le texte contient
# lui-même des accolades.
start = s.index('csdj1_identity_marker_sql() {')
end = s.index('\n}\n', start) + len('\n}\n')
s = s[:start] + 'csdj1_identity_marker_sql() {\n  printf "%s" ""\n}\n' + s[end:]
open(dst, 'w', encoding='utf-8').write(s)
PY
make_mut_role "$(basename "$MUT_MAIN")" "$(basename "$MUT_LIB")"
chmod 755 "$MUT_ROLE" "$MUT_MAIN"
M4_RC="$(run_mut_role /tmp/csdj1-mut-m4.log)"
if [ "$M4_RC" != "0" ] \
   && grep -q 'marqueur RETIRÉ — la mutation a été ACCEPTÉE' /tmp/csdj1-mut-m4.log; then
  ok "M4 — l'identité PARTIELLE est VUE : le marqueur retiré n'arrête plus la mutation (code $M4_RC)"
  grep -m4 'FAIL:' /tmp/csdj1-mut-m4.log | sed 's/^/       /' | tee -a "$OUT"
else
  ko "M4 — l'identité partielle passe inaperçue (code $M4_RC) : [G] ne prouve pas le marqueur"
fi

# ────────────────────────────────────────────────────────────
# M5 — AUD-07 (seconde passe) : data_directory et config_file retirés
# ────────────────────────────────────────────────────────────
say "--- M5 : data_directory et config_file retirés du prédicat"
clean
cp "$MAIN_SRC" "$MUT_MAIN"
python3 -I - "$LIB_SRC" "$MUT_LIB" <<'PY'
import sys, re
src, dst = sys.argv[1:3]
s = open(src, encoding='utf-8').read()
for field in ('data_directory', 'config_file'):
    pat = re.compile(
        r"  if coalesce\(pg_catalog\.current_setting\('%s', true\), ''\)[^\n]*\n"
        r"    raise exception 'SCANYM_IDENTITY_REFUS\|%s';\n  end if;\n" % (field, field))
    s2 = pat.sub("", s)
    assert s2 != s, "ancre %s introuvable" % field
    s = s2
open(dst, 'w', encoding='utf-8').write(s)
PY
make_mut_role "$(basename "$MUT_MAIN")" "$(basename "$MUT_LIB")"
chmod 755 "$MUT_ROLE" "$MUT_MAIN"
M5_RC="$(run_mut_role /tmp/csdj1-mut-m5.log)"
if [ "$M5_RC" != "0" ] \
   && grep -q 'data_directory faux — la mutation a été ACCEPTÉE' /tmp/csdj1-mut-m5.log \
   && grep -q 'config_file faux — la mutation a été ACCEPTÉE' /tmp/csdj1-mut-m5.log; then
  ok "M5 — les deux champs retirés sont VUS : data_directory et config_file (code $M5_RC)"
  grep -m4 'FAIL:' /tmp/csdj1-mut-m5.log | sed 's/^/       /' | tee -a "$OUT"
else
  ko "M5 — le retrait de data_directory/config_file passe inaperçu (code $M5_RC)"
fi

clean
say "=== BILAN CONTRÔLES DE MUTATION : $PASS contrôle(s) concluant(s), $FAIL manquant(s) ==="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
