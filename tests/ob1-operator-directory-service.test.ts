import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// OB-1 — lib/services/operator-directory.ts, inspection statique du
// code source (même technique que tests/lotd-establishment-creation.test.ts
// pour lib/services/establishments.ts) : preuve que ce module ne fait
// QUE lire public.restaurants, sans jamais introduire de nouvelle RPC,
// de service_role côté navigateur, ou d'écriture.
// ====================================================================

const src = readFileSync("lib/services/operator-directory.ts", "utf8");
const v70Sql = readFileSync("supabase/migration-v70-identity-corrections.sql", "utf8");

test("operator-directory.ts: lecture directe sur public.restaurants uniquement, aucune RPC appelée", () => {
  assert.ok(src.includes('.from("restaurants")'), "doit lire restaurants via le client Supabase");
  assert.ok(!src.includes(".rpc("), "aucun appel RPC -- lecture RLS pure, aucune nouvelle fonction serveur");
});

test("operator-directory.ts: aucune trace de service_role/clé privilégiée côté navigateur", () => {
  assert.ok(!/service_role/i.test(src));
  assert.ok(!/SUPABASE_SERVICE/i.test(src));
});

test("operator-directory.ts: aucune méthode d'écriture Supabase (insert/update/upsert/delete)", () => {
  for (const method of [".insert(", ".update(", ".upsert(", ".delete("]) {
    assert.ok(!src.includes(method), `${method} ne doit jamais apparaître dans ce module en lecture seule`);
  }
});

test("operator-directory.ts: colonnes sélectionnées strictement limitées (aucune donnée financière/credential)", () => {
  const selectMatch = src.match(/\.select\("([^"]+)"\)/);
  assert.ok(selectMatch, "un .select(...) doit exister");
  const columns = selectMatch![1].split(",").map((c) => c.trim());
  assert.deepEqual(columns.sort(), ["country", "id", "name", "slug", "status"].sort());
});

test("le module dépend réellement de la policy RLS opérateur déjà publiée (V70), jamais d'une nouvelle policy", () => {
  assert.ok(
    src.includes("lecture operateur restaurants"),
    "le module doit référencer explicitement la policy RLS existante dont il dépend"
  );
  // La policy elle-même existe bien dans la migration V70 déjà publiée
  // (baseline), et n'est pas réintroduite ici.
  assert.ok(v70Sql.includes('create policy "lecture operateur restaurants"'));
  assert.ok(v70Sql.includes("using (public.is_scanym_operator())"));
});

test("aucune nouvelle policy/fonction SQL n'est introduite par ce lot : le fichier de migration V70 référencé n'est pas modifié par OB-1 (pas de bloc create policy \"lecture operateur restaurants\" en dehors de celui déjà publié)", () => {
  const occurrences = v70Sql.split('create policy "lecture operateur restaurants"').length - 1;
  assert.equal(occurrences, 1, "la policy ne doit apparaître qu'une seule fois (celle déjà publiée)");
});
