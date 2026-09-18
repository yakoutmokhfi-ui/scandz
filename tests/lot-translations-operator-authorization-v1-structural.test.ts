import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// Scanym — LOT 02 — TRANSLATIONS OPERATOR AUTHORIZATION v1 — tests
// structurels (texte SOURCE du lot ; le comportement RÉEL en base est
// prouvé par supabase/tests/translations-operator-authorization-v1-check.sh).
// ====================================================================

const SQL_PATH = "supabase/DRAFT-lot-translations-operator-authorization-v1.sql";
const ROLLBACK_PATH = "supabase/DRAFT-lot-translations-operator-authorization-v1-rollback.sql";
const SQL = readFileSync(SQL_PATH, "utf8");
const ROLLBACK = readFileSync(ROLLBACK_PATH, "utf8");
const V81 = readFileSync("supabase/migration-v81-lot1b-translations.sql", "utf8");

const codeOnly = (s: string) =>
  s
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n");

const fnBody = (src: string, fn: string, kw = "create or replace function") =>
  src.match(new RegExp(`${kw} public\\.${fn}\\s*\\([\\s\\S]*?\\nend \\$\\$;`, "m"))?.[0];

test("LOT 02: le lot modifie EXACTEMENT une fonction : get_restaurant_translation_settings", () => {
  const matches = [...SQL.matchAll(/create or replace function public\.(\w+)\s*\(/g)].map((m) => m[1]);
  assert.deepEqual(matches, ["get_restaurant_translation_settings"]);
});

test("LOT 02: aucune RPC d'écriture ni helper d'autorisation n'est déclaré (écriture inchangée)", () => {
  for (const fn of ["write_translation", "assert_restaurant_asset_role", "is_scanym_operator", "get_merchant_catalogue", "get_restaurant_active_languages"]) {
    assert.doesNotMatch(
      codeOnly(SQL),
      new RegExp(`(create( or replace)? function|drop function)\\s+public\\.${fn}\\s*\\(`, "i"),
      `${fn} ne doit pas être touchée par ce lot`
    );
  }
});

test("LOT 02: patron bypass exact — membership préservée ET opérateur ajouté, une seule occurrence", () => {
  const code = codeOnly(SQL);
  const occurrences = [...code.matchAll(/\) and not public\.is_scanym_operator\(\) then/g)];
  assert.equal(occurrences.length, 1);
  const body = fnBody(SQL, "get_restaurant_translation_settings");
  assert.ok(body, "corps introuvable");
  assert.ok(
    codeOnly(body!).includes(
      "if not exists (\n    select 1 from public.restaurant_users ru\n    where ru.user_id = auth.uid() and ru.restaurant_id = p_restaurant_id\n  ) and not public.is_scanym_operator() then"
    ),
    "la condition membership d'origine doit être préservée à l'identique, bypass accolé"
  );
});

test("LOT 02: corps identique à v81 hormis le seul bypass opérateur et ses commentaires", () => {
  const original = fnBody(V81, "get_restaurant_translation_settings", "create function");
  const patched = fnBody(SQL, "get_restaurant_translation_settings");
  assert.ok(original && patched);
  const normalize = (s: string) =>
    codeOnly(s)
      .replace(/^create (or replace )?function/, "create function")
      .replace(" and not public.is_scanym_operator() then", " then")
      .replace(/\n\s*\n/g, "\n");
  assert.equal(normalize(patched!), normalize(original!));
});

test("LOT 02: refus explicite préservé (28000 / 42501, messages inchangés — jamais un résultat vide silencieux)", () => {
  const body = codeOnly(fnBody(SQL, "get_restaurant_translation_settings")!);
  assert.match(body, /errcode = '28000', message = 'Authentication required'/);
  assert.match(body, /errcode = '42501',\s*message = 'Not authorized for this restaurant'/);
  assert.match(body, /security definer\nset search_path = ''/);
});

test("LOT 02: aucun GRANT/REVOKE, aucune table/policy/colonne touchée", () => {
  const code = codeOnly(SQL);
  assert.doesNotMatch(code, /^\s*(grant|revoke)\s/im);
  assert.doesNotMatch(code, /\b(create|alter|drop) (table|policy)\b/i);
  assert.doesNotMatch(code, /restaurant_users\s*\(|insert into/i, "aucune ligne restaurant_users factice");
});

test("LOT 02: rollback restaure exactement le corps v81 (sans bypass)", () => {
  const original = fnBody(V81, "get_restaurant_translation_settings", "create function");
  const rolled = fnBody(ROLLBACK, "get_restaurant_translation_settings");
  assert.ok(original && rolled);
  assert.equal(
    rolled!.replace(/^create or replace function/, "create function"),
    original
  );
  assert.doesNotMatch(codeOnly(rolled!), /is_scanym_operator/);
});

test("LOT 02: le service remonte l'erreur RPC (aucun repli silencieux) et la page ne commite pas de contenu en cas d'échec", () => {
  const svc = readFileSync("lib/services/dashboard.ts", "utf8");
  const fn = svc.match(/export async function getRestaurantTranslationSettings[\s\S]*?\n}\n/)?.[0];
  assert.ok(fn, "getRestaurantTranslationSettings introuvable");
  assert.match(fn!, /if \(error\) throw new Error\(error\.message\);/);

  const page = readFileSync("app/dashboard/translations/page.tsx", "utf8");
  const load = page.match(/const load = useCallback\(async[\s\S]*?\}, \[guard\]\);/)?.[0];
  assert.ok(load, "load() introuvable");
  const [tryPart, catchPart] = load!.split("} catch (e) {");
  assert.ok(tryPart.includes("getRestaurantTranslationSettings(id)"));
  assert.ok(catchPart, "catch introuvable");
  assert.match(catchPart, /setError\(/);
  assert.doesNotMatch(catchPart, /setSettings|setContentLoadedRestaurantId\(id\)/);
});
