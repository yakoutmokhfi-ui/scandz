#!/usr/bin/env python3
"""
Scanym — CSDJ v1.2 / CSDJ-3 — comparaison d'un corps de fonction PROD avec
les définitions candidates du dépôt.

USAGE (lecture seule, aucun accès réseau, aucune base) :
    python3 -I supabase/tests/prod-predecessor-compare.py <fonction> <fichier-prosrc> [--refs]

  <fonction>      create_order | update_order_status
  <fichier-prosrc> texte EXACT de `pg_proc.prosrc` relevé sur PROD
                   (psql -Atc "select prosrc from pg_proc where oid =
                   'public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)'::regprocedure"
                   > prod-create_order.prosrc)
  --refs          cherche aussi dans TOUTES les branches distantes connues
                  (git), et pas seulement dans l'arbre de travail.

EXPRESSION DE HACHAGE CANONIQUE (la même des deux côtés) :
    md5(replace(prosrc, E'\\r\\n', E'\\n'))        -- fins de ligne normalisées en LF
La valeur brute md5(prosrc) est aussi affichée : un écart brut avec un
accord normalisé = fins de ligne seulement (cas constaté pour
update_order_status : PROD stocke le corps en CRLF).

SORTIE : égalité exacte (brute / normalisée), sinon les 3 candidats les
plus proches (rapport difflib) et le diff unifié du plus proche.
"""
import difflib
import hashlib
import re
import subprocess
import sys

PAT = re.compile(
    r"function\s+(?:public\.)?(create_order|update_order_status)\s*\(.*?\bas\s+(\$[A-Za-z0-9_]*\$)(.*?)\2",
    re.S | re.I,
)


def md5(text: str) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def lf(text: str) -> str:
    return text.replace("\r\n", "\n")


def git(*args: str) -> str:
    return subprocess.run(["git", *args], capture_output=True, text=True, errors="replace").stdout


def candidates(fn: str, use_refs: bool):
    seen = {}
    if use_refs:
        refs = git("for-each-ref", "--format=%(refname)", "refs/remotes").split()
        for r in refs:
            for line in git("grep", "-l", "-E", rf"function +(public\.)?{fn} *\(", r, "--", ".").split("\n"):
                if ":" not in line:
                    continue
                ref, path = line.split(":", 1)
                blob = git("rev-parse", f"{ref}:{path}").strip()
                seen.setdefault(blob, (ref.replace("refs/remotes/origin/", ""), path))
        for blob, (ref, path) in seen.items():
            text = git("cat-file", "-p", blob)
            for m in PAT.finditer(text):
                if m.group(1).lower() == fn:
                    yield f"{ref}:{path}", m.group(3)
    else:
        import glob

        for path in sorted(glob.glob("supabase/*.sql")):
            text = open(path, encoding="utf-8", errors="replace").read()
            for m in PAT.finditer(text):
                if m.group(1).lower() == fn:
                    yield path, m.group(3)


def main() -> int:
    if len(sys.argv) < 3 or sys.argv[1] not in ("create_order", "update_order_status"):
        print(__doc__)
        return 2
    fn, prod_path = sys.argv[1], sys.argv[2]
    prod = open(prod_path, encoding="utf-8", errors="replace", newline="").read()
    print(f"PROD {fn}: {len(prod)} octets, {prod.count(chr(10))} lignes, "
          f"CRLF={'oui' if chr(13)+chr(10) in prod else 'non'}")
    print(f"  md5(prosrc)                         = {md5(prod)}")
    print(f"  md5(replace(prosrc, CRLF, LF))      = {md5(lf(prod))}")
    best = []
    exact = False
    for where, body in candidates(fn, "--refs" in sys.argv):
        raw_eq = md5(body) == md5(prod)
        lf_eq = md5(lf(body)) == md5(lf(prod))
        if raw_eq or lf_eq:
            exact = True
            print(f"  ÉGALITÉ {'brute' if raw_eq else 'après normalisation des fins de ligne'} : {where}")
        ratio = difflib.SequenceMatcher(None, lf(prod).split("\n"), lf(body).split("\n"), autojunk=False).ratio()
        best.append((ratio, where, body))
    if exact:
        return 0
    best.sort(key=lambda t: -t[0])
    print("AUCUNE égalité. Candidats les plus proches (ratio de lignes) :")
    for ratio, where, _ in best[:3]:
        print(f"  {ratio:.4f}  {where}")
    if best:
        _, where, body = best[0]
        print(f"--- diff unifié PROD -> {where} (fins de ligne normalisées) ---")
        for l in difflib.unified_diff(lf(prod).split("\n"), lf(body).split("\n"), "PROD", where, lineterm="", n=2):
            print(l)
    return 1


if __name__ == "__main__":
    sys.exit(main())
