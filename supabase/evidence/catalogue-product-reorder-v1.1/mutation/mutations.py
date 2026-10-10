#!/usr/bin/env python3
"""
Scanym — CATALOGUE PRODUCT REORDER v1.1 — contrôles de MUTATION.

Fabrique une COPIE du dépôt (jamais le dépôt lui-même ; node_modules
n'est que lié) dans laquelle UNE mutation est appliquée, soit au DRAFT SQL du lot
(« sql »), soit à la bibliothèque de sûreté du harnais (« lib »).
Les suites sont ensuite exécutées sur cette copie par run-mutations.sh :
une mutation « tuée » fait échouer au moins une preuve.

Usage : mutations.py <racine du dépôt> <répertoire de travail> <sql|lib> <nom>
        mutations.py list <sql|lib>
"""
import os, shutil, subprocess, sys

SQL_FILE = "supabase/DRAFT-lot-catalogue-product-reorder-v1.sql"
LIB_FILE = "supabase/tests/catalogue-product-reorder-v1-harness-lib.sh"


def r(old, new):
    def apply(text):
        assert old in text, "motif introuvable : " + old[:70]
        return text.replace(old, new, 1)
    return apply


FRESH_NAME = """(e.item ->> 'name') collate "C" = mi.name::text collate "C","""

SQL = {
    "M00-controle-sans-mutation": lambda s: s,
    "M01-display_order-non-compare": r("             and (e.item ->> 'display_order') = mi.display_order::text\n", ""),
    "M02-name-non-compare": r("             and " + FRESH_NAME + "\n", "             and true,\n"),
    "M03-name-insensible-a-la-casse": r(FRESH_NAME, "lower(e.item ->> 'name') = lower(mi.name::text),"),
    "M04-compteur-de-fraicheur-ignore": r("     or v_fresh_count <> v_expected_count\n", ""),
    "M05-compteur-de-lignes-distinctes-ignore": r("     or v_distinct_count <> v_expected_count\n", ""),
    "M06-monotonie-ignoree": r("     or v_out_of_order\n", ""),
    "M07-sans-garde-de-taille": r("  if jsonb_array_length(p_expected_scope) <> v_scope_count then", "  if false then"),
    "M08-jointure-acceptant-les-archives": r(
        "     and mi.subcategory_id is not distinct from v_subcategory_id\n     and mi.archived_at is null\n  ) j;",
        "     and mi.subcategory_id is not distinct from v_subcategory_id\n  ) j;"),
    "M09-jointure-ignorant-la-sous-categorie": r(
        "     and mi.category_id = v_category_id\n     and mi.subcategory_id is not distinct from v_subcategory_id\n     and mi.archived_at is null\n  ) j;",
        "     and mi.category_id = v_category_id\n     and mi.archived_at is null\n  ) j;"),
    "M10-type-json-de-display_order-non-verifie": r("             and jsonb_typeof(e.item -> 'display_order') = 'number'\n", ""),
    "M11-type-json-de-name-non-verifie": r("             and jsonb_typeof(e.item -> 'name') = 'string'\n", ""),
    "M12-reecrit-les-lignes-inchangees": r("    and mi.display_order is distinct from n.new_display_order;", ";"),
    "M13-type-json-de-id-non-verifie": r("      on jsonb_typeof(e.item -> 'id') = 'string'\n     and mi.id::text", "      on mi.id::text"),
    "M14-display_order-compare-en-numerique": r(
        "(e.item ->> 'display_order') = mi.display_order::text", "(e.item ->> 'display_order')::numeric = mi.display_order"),
    "M15-name-compare-apres-rognage": r(FRESH_NAME, "btrim(e.item ->> 'name') = btrim(mi.name::text),"),
}

HPSQL = '''hpsql() {
  local db="$1"; shift
  env -i PATH="$H_BIN:/usr/bin:/bin" LC_ALL=C TZ=UTC \\
    PGHOST="$H_SOCK" PGPORT="$H_PORT" PGUSER="$H_USER" PGDATABASE="$db" \\
    PGPASSFILE="$H_EMPTY/pgpass" PGSERVICEFILE="$H_EMPTY/pg_service.conf" PGSYSCONFDIR="$H_EMPTY" \\
    PGCLIENTENCODING=UTF8 PGCONNECT_TIMEOUT=10 PGAPPNAME="scanym-$H_LOT_TAG-$H_TAG" \\
    "$H_BIN/psql"'''

LIB = {
    "L00-controle-sans-mutation": lambda s: s,
    "L01-PGHOST-non-refuse": r('H_REDIRECTING_VARS="PGHOST PGHOSTADDR', 'H_REDIRECTING_VARS="PGHOSTADDR'),
    "L02-preuve-d-identite-neutralisee": r("    raise exception 'SCANYM_HARNESS_IDENTITY_MISMATCH';", "    null;"),
    "L03-suppression-hors-registre": r(
        '  if ! h_is_tracked "$name"; then\n    h_log "REFUS DE SÛRETÉ : la base « $name » n\'a pas été créée par cette exécution. Elle n\'est PAS supprimée."',
        '  if false; then\n    h_log "x"'),
    "L04-nettoyage-sans-preuve-de-propriete": r("h_owns_run_dir() {\n", "h_owns_run_dir() {\n  return 0\n"),
    "L05-hpsql-herite-de-l-environnement": r(HPSQL, 'hpsql() {\n  local db="$1"; shift\n  LC_ALL=C PGCLIENTENCODING=UTF8 \\\n    "$H_BIN/psql"'),
    "L06-sans-consentement": r('if [ "${SCANYM_DISPOSABLE_CLUSTER:-}" != "1" ]; then', "if false; then"),
    "L07-creation-sans-controle-d-existence": r('  if [ "$exists" != "0" ]; then', "  if false; then"),
    "L08-PGPASSWORD-non-refuse": r(" PGPASSWORD PGPASSFILE PGSERVICE", " PGSERVICE"),
    "L09-PGSERVICE-non-refuse": r(" PGSERVICE PGSERVICEFILE PGSYSCONFDIR", " "),
    "L10-le-refus-affiche-la-valeur": r(
        "h_refuse_gate \"$v est définie dans l'environnement hérité.", "h_refuse_gate \"$v est définie dans l'environnement hérité (${!v})."),
    "L11-preuve-sans-nonce": r(
        "  if pg_catalog.current_setting('scanym.harness_run_nonce', true) is distinct from '$H_NONCE'\n"
        "     or not exists (\n"
        "       select 1 from pg_catalog.pg_file_settings f\n"
        "       where f.name = 'scanym.harness_run_nonce'\n"
        "         and f.setting = '$H_NONCE'\n"
        "         and f.sourcefile = '$H_DATA/postgresql.conf'\n"
        "     )\n"
        "     or pg_catalog.current_setting('config_file')",
        "  if pg_catalog.current_setting('config_file')"),
    "L12-preuve-sans-repertoire-de-donnees": r(
        "         and f.sourcefile = '$H_DATA/postgresql.conf'\n"
        "     )\n"
        "     or pg_catalog.current_setting('config_file') is distinct from '$H_DATA/postgresql.conf'\n"
        "     or pg_catalog.current_setting('data_directory') is distinct from '$H_DATA'\n",
        "     )\n"),
    "L13-drop-sans-preuve": r(
        '  h_guarded_sql "drop database \\"$name\\";" >/dev/null', '  hpsql postgres -q -c "drop database \\"$name\\";" >/dev/null 2>&1'),
    "L14-ecoute-reseau": r(
        "listen_addresses = ''\nunix_socket_directories = '$H_SOCK'", "listen_addresses = 'localhost'\nunix_socket_directories = '$H_SOCK'"),
}


def main():
    if sys.argv[1] == "list":
        print("\n".join((SQL if sys.argv[2] == "sql" else LIB).keys()))
        return
    src, work, kind, name = sys.argv[1:5]
    dst = os.path.join(work, name)
    if os.path.exists(dst):
        shutil.rmtree(dst)
    os.makedirs(dst)
    for entry in os.listdir(src):
        if entry in (".git", ".next"):
            continue
        if entry == "node_modules":
            # Jamais copié ni modifié : simple lien vers l'original.
            os.symlink(os.path.join(src, entry), os.path.join(dst, entry))
            continue
        subprocess.check_call(["cp", "-a", os.path.join(src, entry), dst + "/"])
    rel = SQL_FILE if kind == "sql" else LIB_FILE
    path = os.path.join(dst, rel)
    text = open(path, encoding="utf-8").read()
    mutated = (SQL if kind == "sql" else LIB)[name](text)
    if "controle-sans-mutation" not in name:
        assert mutated != text, "la mutation n'a rien changé"
    if kind == "sql":
        # Le contrôle post-application du lot exige les comparaisons de
        # fraîcheur dans le corps installé : il refuserait d'installer
        # la plupart de ces mutants. On le neutralise pour mesurer les
        # preuves COMPORTEMENTALES, pas seulement ce contrôle.
        a = mutated.index("  if v_def not like '%(e.item ->> ''display_order'') = mi.display_order::text%'")
        b = mutated.index("then", a)
        mutated = mutated[:a] + "  if false " + mutated[b:]
    os.remove(path)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(mutated)
    if kind == "lib":
        os.chmod(path, 0o644)


main()
