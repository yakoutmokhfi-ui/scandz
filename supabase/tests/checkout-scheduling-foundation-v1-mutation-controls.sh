#!/usr/bin/env bash
# ============================================================
# CONTRÔLES DE MUTATION — CSDJ1-AUD-06 / CSDJ1-AUD-07
#
# Un harnais vert ne prouve rien si le défaut qu'il est censé interdire
# peut être réinjecté sans qu'il échoue. Ce fichier réinjecte DIX
# défauts, chacun dans une COPIE, et exige que les harnais les voient.
# (M2 est une démonstration directe, pas une mutation.)
#
# M1  un « env -i » retiré devant un appel client
# M2  (sans objet : démonstration directe, cf. section [F] du harnais)
# M3  l'instantané de rôle en ::text comparé à « t »  (défaut d'AUD-06)
# M4  le MARQUEUR retiré du prédicat d'identité       (défaut d'AUD-07,
#     seconde passe : la preuve partielle que l'audit a trouvée)
# M5  data_directory et config_file retirés du prédicat
# M6  l'égalité EXACTE de socket remplacée par une SOUS-CHAÎNE
# M7  le parseur sensible aux guillemets remplacé par un découpage brut
# M8  la défense anti-collision des octets réservés retirée
# M9  la fuite d'état par les commentaires et les continuations
# M10 la continuation ENTRE GUILLEMETS DOUBLES, non normalisée
#     (défaut d'AUD-07, huitième passe : E1 redevient invisible)
# M11 l'ÉQUIVALENCE DES BLANCS SQL retirée
#     (défaut d'AUD-07, huitième passe : E2 et E8 redeviennent
#      invisibles, pendant que PostgreSQL, lui, les exécute)
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
DET_SRC="$TESTS_DIR/csdj1-raw-role-mutation-detector.awk"
MUT_ROLE="$TESTS_DIR/.mut-role-check.sh"
MUT_MAIN="$TESTS_DIR/.mut-main-check.sh"
MUT_LIB="$TESTS_DIR/.mut-cluster-identity.sh"
OUT="${OUT_DIR:-/tmp}/csdj1-mutation-controls.log"

for f in "$ROLE_SRC" "$MAIN_SRC" "$LIB_SRC" "$DET_SRC"; do
  [ -f "$f" ] || { printf 'source absente : %s\n' "$f"; exit 1; }
done

PASS=0
FAIL=0
say() { printf '%s\n' "$*" | tee -a "$OUT"; }
ok()  { PASS=$((PASS + 1)); say "CONTROL PASS: $*"; }
ko()  { FAIL=$((FAIL + 1)); say "CONTROL FAIL: $*"; }
clean() { rm -f "$MUT_ROLE" "$MUT_MAIN" "$MUT_LIB" "$TESTS_DIR/.mut-raw-role-detector.awk"; }
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

# ────────────────────────────────────────────────────────────
# M6 — AUD-07 (quatrième passe) : l'égalité EXACTE de socket
#      remplacée par une SOUS-CHAÎNE.
#
# C'est le défaut littéral du quatrième re-audit. Les contrôles de
# socket [H] doivent alors ACCEPTER des attendus partiels, et le rôle
# témoin du banc doit être réellement muté.
# ────────────────────────────────────────────────────────────
say "--- M6 : égalité exacte de socket remplacée par une sous-chaîne"
clean
cp "$MAIN_SRC" "$MUT_MAIN"
python3 -I - "$LIB_SRC" "$MUT_LIB" <<'PYM6'
import sys
src, dst = sys.argv[1:3]
s = open(src, encoding='utf-8').read()
# On remonte du « raise ... socket » au « if not exists ( » qui le porte,
# et on remplace tout le prédicat par l'ancienne sémantique.
needle = "SCANYM_IDENTITY_REFUS|socket';"
i = s.index(needle)
start = s.rindex("  if not ${CSDJ1_ID_SOCKET_MATCH} then", 0, i)
end = s.index("  end if;\n", i) + len("  end if;\n")
weak = (
    "  if pg_catalog.strpos(\n"
    "       coalesce(pg_catalog.current_setting('unix_socket_directories', true), ''),\n"
    "       '${CSDJ1_ID_SOCKET}') = 0 then\n"
    "    raise exception 'SCANYM_IDENTITY_REFUS|socket';\n"
    "  end if;\n"
)
s = s[:start] + weak + s[end:]
open(dst, 'w', encoding='utf-8').write(s)
PYM6
make_mut_role "$(basename "$MUT_MAIN")" "$(basename "$MUT_LIB")"
chmod 755 "$MUT_ROLE" "$MUT_MAIN"
M6_RC="$(run_mut_role /tmp/csdj1-mut-m6.log)"
if [ "$M6_RC" != "0" ] \
   && grep -q "PRÉFIXE d'une entrée — ACCEPTÉ à tort" /tmp/csdj1-mut-m6.log \
   && grep -q "reproduction d'audit : /tmp vs /tm — ACCEPTÉ à tort" /tmp/csdj1-mut-m6.log; then
  ok "M6 — la sémantique de sous-chaîne est VUE : les attendus partiels passent de nouveau (code $M6_RC)"
  grep -m4 'FAIL:' /tmp/csdj1-mut-m6.log | sed 's/^/       /' | tee -a "$OUT"
else
  ko "M6 — l'affaiblissement du prédicat de socket passe inaperçu (code $M6_RC) : [H] ne prouve rien"
fi

# ────────────────────────────────────────────────────────────
# M7 — AUD-07 (cinquième passe) : le parseur sensible aux
#      guillemets remplacé par un DÉCOUPAGE BRUT à chaque virgule.
#
# C'est le défaut littéral du cinquième re-audit. Le banc d'essai
# configure une entrée citée contenant une virgule ; sous découpage
# brut, le FRAGMENT qui précède la virgule devient une fausse identité
# acceptée, et le rôle témoin du banc est réellement muté.
# ────────────────────────────────────────────────────────────
say "--- M7 : parseur sensible aux guillemets remplacé par un découpage brut"
clean
cp "$MAIN_SRC" "$MUT_MAIN"
python3 -I - "$LIB_SRC" "$MUT_LIB" <<'PYM7'
import sys
src, dst = sys.argv[1:3]
s = open(src, encoding='utf-8').read()
# 1) la virgule redevient un séparateur INCONDITIONNEL
old_split = "case when c.c = ',' and c.outside_quotes then pg_catalog.chr(2) else c.c end"
assert old_split in s, "ancre de decoupage introuvable"
s = s.replace(old_split, "case when c.c = ',' then pg_catalog.chr(2) else c.c end", 1)
# 2) les guillemets sont retirés des DEUX bords, comme le faisait la
#    version precedente -- c'est ce qui transforme un fragment en
#    chemin plausible.
i = s.index("csdj1_sock_unquote as (")
j = s.index("csdj1_sock_restore as (", i)
s = (s[:i]
     + "csdj1_sock_unquote as (\n"
       "    select pg_catalog.btrim(t.e, '\"') as e from csdj1_sock_trim t),\n  "
     + s[j:])
open(dst, 'w', encoding='utf-8').write(s)
PYM7
make_mut_role "$(basename "$MUT_MAIN")" "$(basename "$MUT_LIB")"
chmod 755 "$MUT_ROLE" "$MUT_MAIN"
M7_RC="$(run_mut_role /tmp/csdj1-mut-m7.log)"
if [ "$M7_RC" != "0" ] \
   && grep -q "FRAGMENT avant la virgule citée — ACCEPTÉ à tort" /tmp/csdj1-mut-m7.log \
   && grep -q "FRAGMENT avant la virgule citée — le rôle témoin a été MUTÉ" /tmp/csdj1-mut-m7.log; then
  ok "M7 — le découpage BRUT est VU : le fragment d'une entrée citée devient une fausse identité (code $M7_RC)"
  grep -m4 'FAIL:' /tmp/csdj1-mut-m7.log | sed 's/^/       /' | tee -a "$OUT"
else
  ko "M7 — le découpage brut passe inaperçu (code $M7_RC) : [H] ne prouve pas la syntaxe citée"
fi

# ────────────────────────────────────────────────────────────
# M8 — AUD-07 (sixième passe) : la défense anti-collision retirée.
#
# Le parseur se réserve chr(1) et chr(2) comme sentinelles internes, et
# PostgreSQL autorise ces octets dans un nom de répertoire. La défense
# refuse donc la liste AVANT toute substitution. M8 la neutralise : les
# contrôles [H] S1 et S2 doivent alors ACCEPTER une fausse identité, et
# le rôle témoin du cluster à sentinelles doit être RÉELLEMENT muté.
# ────────────────────────────────────────────────────────────
say "--- M8 : défense anti-collision des octets réservés retirée"
clean
cp "$MAIN_SRC" "$MUT_MAIN"
python3 -I - "$LIB_SRC" "$MUT_LIB" <<'PYM8'
import sys
src, dst = sys.argv[1:3]
s = open(src, encoding='utf-8').read()
# L expression de defense rend desormais « true » quoi qu il arrive :
# la liste n est plus examinee avant substitution.
start = s.index("csdj1_identity_socket_reserved_expr() {")
end = s.index("\n}\n", start) + len("\n}\n")
s = (s[:start]
     + "csdj1_identity_socket_reserved_expr() {\n  printf 'true'\n}\n"
     + s[end:])
open(dst, 'w', encoding='utf-8').write(s)
PYM8
make_mut_role "$(basename "$MUT_MAIN")" "$(basename "$MUT_LIB")"
chmod 755 "$MUT_ROLE" "$MUT_MAIN"
M8_RC="$(run_mut_role /tmp/csdj1-mut-m8.log)"
if [ "$M8_RC" != "0" ] \
   && grep -q "la mutation a été ACCEPTÉE : .* est une fausse identité fabriquée par la collision" /tmp/csdj1-mut-m8.log \
   && grep -q "empreinte de rôle MODIFIÉE" /tmp/csdj1-mut-m8.log; then
  ok "M8 — la collision de sentinelle est VUE : la fausse identité passe et le rôle témoin est muté (code $M8_RC)"
  grep -m4 'FAIL:' /tmp/csdj1-mut-m8.log | sed 's/^/       /' | tee -a "$OUT"
else
  ko "M8 — le retrait de la défense anti-collision passe inaperçu (code $M8_RC) : [H] S1/S2 ne prouvent rien"
fi

# ────────────────────────────────────────────────────────────
# M9 — AUD-07 (septième passe) : la fuite d'état par les
#      COMMENTAIRES et les CONTINUATIONS, réinjectée.
#
# C'est le défaut littéral du sixième re-audit. Le détecteur ne doit
# plus laisser une apostrophe de COMMENTAIRE ouvrir une citation, ni
# ignorer une continuation par barre oblique inverse. On lui retire
# les deux règles.
#
# CE QUE LA HUITIÈME REMÉDIATION A CHANGÉ ICI, ET POURQUOI L'ATTENDU
# N'EST PLUS LE MÊME : au septième tour, la réinjection faisait classer
# R1 « GARDÉE » -- un MENSONGE, l'état gardé de la commande précédente
# survivant à une commande terminée. Le détecteur classe désormais
# chaque commande sur SON texte verbatim, où l'appel brut « q ' » est
# visible : l'héritage de garde a disparu PAR CONSTRUCTION, et ce
# mensonge-là n'est plus produisible. La même réinjection produit donc
# le défaut restant, qui est le pire des deux : le SILENCE. R3 -- un
# commentaire portant un GUILLEMET -- redevient « AUCUNE », et [J]
# montre, dans la même exécution, PostgreSQL exécuter la mutation.
# ────────────────────────────────────────────────────────────
say "--- M9 : fuite d'état par les commentaires et les continuations"
clean
cp "$MAIN_SRC" "$MUT_MAIN"
cp "$LIB_SRC" "$MUT_LIB"
MUT_DET="$TESTS_DIR/.mut-raw-role-detector.awk"

# Le RECÂBLAGE du harnais de rôles vers le détecteur abîmé est le même
# pour M9, M10 et M11 : il est écrit une fois.
wire_role_to_mut_det() {
  python3 -I - "$ROLE_SRC" "$MUT_ROLE" "$(basename "$MUT_MAIN")" "$(basename "$MUT_LIB")" <<'PYWIRE'
import sys
src, dst, main_name, lib_name = sys.argv[1:5]
s = open(src, encoding='utf-8').read()
s = s.replace('HARNESS="$SCRIPT_DIR/checkout-scheduling-foundation-v1-check.sh"',
              'HARNESS="$SCRIPT_DIR/%s"' % main_name, 1)
s = s.replace('IDENTITY_LIB="$SCRIPT_DIR/csdj1-cluster-identity.sh"',
              'IDENTITY_LIB="$SCRIPT_DIR/%s"' % lib_name, 1)
s = s.replace('MUT_AWK="$SCRIPT_DIR/csdj1-raw-role-mutation-detector.awk"',
              'MUT_AWK="$SCRIPT_DIR/.mut-raw-role-detector.awk"', 1)
open(dst, 'w', encoding='utf-8').write(s)
PYWIRE
  chmod 755 "$MUT_ROLE" "$MUT_MAIN"
}

python3 -I - "$DET_SRC" "$MUT_DET" <<'PYM9'
import sys
src, dst = sys.argv[1:3]
s = open(src, encoding='utf-8').read()
# 1) un « # » hors citation ne termine plus la ligne : son contenu
#    redevient du shell, et une apostrophe y ouvre une citation.
needle = 'if (c == "#" && (cmdraw == "" || substr(cmdraw, length(cmdraw), 1) ~ /[ \\t\\n;&|(]/)) break'
assert needle in s, "ancre de commentaire introuvable"
s = s.replace(needle, 'if (0) break', 1)
# 2) la continuation par barre oblique inverse, HORS citation, n est
#    plus reconnue. C est la ligne qui porte le commentaire.
lines = s.split('\n')
idx = [k for k, l in enumerate(lines) if 'cont = 1' in l and '# continuation' in l]
assert len(idx) == 1, "ancre de continuation hors citation introuvable"
lines[idx[0]] = lines[idx[0]].replace('cont = 1; ', '')
open(dst, 'w', encoding='utf-8').write('\n'.join(lines))
PYM9
wire_role_to_mut_det
M9_RC="$(run_mut_role /tmp/csdj1-mut-m9.log)"
if [ "$M9_RC" != "0" ] \
   && grep -q "fixture « r3 » : AUCUNE au lieu de NON-GARDEE" /tmp/csdj1-mut-m9.log \
   && grep -q "alors que PostgreSQL a muté" /tmp/csdj1-mut-m9.log; then
  ok "M9 — la fuite d'état est VUE : R3 redevient invisible, et [J] montre la mutation RÉELLEMENT appliquée (code $M9_RC)"
  grep -m4 'FAIL:' /tmp/csdj1-mut-m9.log | sed 's/^/       /' | tee -a "$OUT"
  if grep -q "\\[I\\] NOCIF" /tmp/csdj1-mut-m9.log; then
    say "       (et [I] montre, dans la même exécution, la mutation de la séquence de l'audit)"
  fi
  # L'héritage de garde, lui, a disparu par construction : R1 reste
  # NON-GARDEE même avec les deux règles retirées. On le CONSTATE, pour
  # que l'auditeur n'ait pas à le déduire.
  if grep -q "fixture « r1 » : NON-GARDEE (attendu)" /tmp/csdj1-mut-m9.log; then
    say "       (et R1 reste NON-GARDEE : l'héritage de garde n'est plus produisible)"
  fi
else
  ko "M9 — la fuite d'état passe inaperçue (code $M9_RC) : R3 ne prouve rien"
fi
rm -f "$MUT_DET"

# ────────────────────────────────────────────────────────────
# M10 — AUD-07 (huitième passe) : la continuation ENTRE GUILLEMETS
#       DOUBLES, réinjectée telle qu'elle était avant.
#
# Avant cette remédiation, le détecteur gardait la barre oblique
# inverse comme un caractère ordinaire : l'argument reconstitué
# contenait « alter \ » puis un saut de ligne, et aucune normalisation
# ne les rapprochait. Bash, lui, retire les deux et transmet
# « alter role ». On remet cette lecture-là, et deux faits doivent
# apparaître DANS LA MÊME EXÉCUTION : E1 n'est plus vue, et [J] montre
# PostgreSQL muter réellement le rôle sonde.
# ────────────────────────────────────────────────────────────
say "--- M10 : la continuation entre guillemets doubles, non normalisée"
clean
cp "$MAIN_SRC" "$MUT_MAIN"
cp "$LIB_SRC" "$MUT_LIB"
python3 -I - "$DET_SRC" "$MUT_DET" <<'PYM10'
import sys
src, dst = sys.argv[1:3]
s = open(src, encoding='utf-8').read()
lines = s.split('\n')
# La ligne SANS le commentaire est celle de l etat « guillemet double ».
idx = [k for k, l in enumerate(lines) if 'cont = 1' in l and '# continuation' not in l]
assert len(idx) == 1, "ancre de continuation entre guillemets introuvable"
indent = lines[idx[0]][:len(lines[idx[0]]) - len(lines[idx[0]].lstrip())]
lines[idx[0]] = indent + 'if (i == n) { cmdraw = cmdraw "\\\\"; cmdexp = cmdexp "\\\\"; i++; continue }'
open(dst, 'w', encoding='utf-8').write('\n'.join(lines))
PYM10
wire_role_to_mut_det
M10_RC="$(run_mut_role /tmp/csdj1-mut-m10.log)"
if [ "$M10_RC" != "0" ] \
   && grep -q "fixture « e1 » : AUCUNE au lieu de NON-GARDEE" /tmp/csdj1-mut-m10.log \
   && grep -q "alors que PostgreSQL a muté" /tmp/csdj1-mut-m10.log; then
  ok "M10 — E1 redevient invisible, et [J] montre la mutation RÉELLEMENT appliquée (code $M10_RC)"
  grep -m4 'FAIL:' /tmp/csdj1-mut-m10.log | sed 's/^/       /' | tee -a "$OUT"
else
  ko "M10 — la continuation non normalisée passe inaperçue (code $M10_RC) : E1 ne prouve rien"
fi
rm -f "$MUT_DET"

# ────────────────────────────────────────────────────────────
# M11 — AUD-07 (huitième passe) : l'ÉQUIVALENCE DES BLANCS SQL,
#       réinjectée telle qu'elle était avant.
#
# PostgreSQL lit l'espace, la tabulation, le retour chariot et le saut
# de ligne comme un seul et même blanc. On rend la normalisation
# aveugle à tout ce qui n'est pas l'espace : E2 et E8 -- le verbe coupé
# par un saut de ligne -- redeviennent invisibles, pendant que [J]
# montre PostgreSQL les exécuter.
# ────────────────────────────────────────────────────────────
say "--- M11 : l'équivalence des blancs SQL, retirée"
clean
cp "$MAIN_SRC" "$MUT_MAIN"
cp "$LIB_SRC" "$MUT_LIB"
python3 -I - "$DET_SRC" "$MUT_DET" <<'PYM11'
import sys
src, dst = sys.argv[1:3]
s = open(src, encoding='utf-8').read()
needle = 'gsub(/[ \\t\\r\\n\\013\\f]+/, " ", out)'
assert needle in s, "ancre de normalisation des blancs introuvable"
s = s.replace(needle, 'gsub(/[ ]+/, " ", out)', 1)
open(dst, 'w', encoding='utf-8').write(s)
PYM11
wire_role_to_mut_det
M11_RC="$(run_mut_role /tmp/csdj1-mut-m11.log)"
if [ "$M11_RC" != "0" ] \
   && grep -q "fixture « e2 » : AUCUNE au lieu de NON-GARDEE" /tmp/csdj1-mut-m11.log \
   && grep -q "fixture « e8 » : AUCUNE au lieu de NON-GARDEE" /tmp/csdj1-mut-m11.log \
   && grep -q "alors que PostgreSQL a muté" /tmp/csdj1-mut-m11.log; then
  ok "M11 — E2 et E8 redeviennent invisibles, et [J] montre la mutation RÉELLEMENT appliquée (code $M11_RC)"
  grep -m4 'FAIL:' /tmp/csdj1-mut-m11.log | sed 's/^/       /' | tee -a "$OUT"
else
  ko "M11 — l'équivalence des blancs retirée passe inaperçue (code $M11_RC) : E2 et E8 ne prouvent rien"
fi
rm -f "$MUT_DET"

clean
say "=== BILAN CONTRÔLES DE MUTATION : $PASS contrôle(s) concluant(s), $FAIL manquant(s) ==="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
