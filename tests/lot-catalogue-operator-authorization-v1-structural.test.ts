import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// Scanym — OPERATOR BACKOFFICE OB-2 — CATALOGUE RPC OPERATOR
// AUTHORIZATION v1 (+ v1.1 READ-PATH COMPLETION) — tests structurels.
//
// Mandat OB-2 : "narrowly scoped". Ce fichier prouve, statiquement,
// sur le texte SOURCE du lot (jamais sur une base vivante -- voir
// supabase/tests/catalogue-operator-authorization-v1-check.sh pour le
// comportement RÉEL en base), que :
//   1. exactement les 6 fonctions attendues sont modifiées (CREATE OR
//      REPLACE) -- les 5 de v1 (mutation) + get_merchant_catalogue
//      (v1.1, lecture) -- chacune référençant is_scanym_operator() ;
//   2. aucune AUTRE RPC catalogue n'est touchée par ce lot (elles
//      héritent du bypass de façon PUREMENT transitive, via les
//      fonctions partagées assert_category_role/assert_product_role/
//      assert_subcategory_role -- jamais par une modification
//      directe de leur propre corps) ;
//   3. aucune référence à Stuart/Monetico/paiement/tracking/tags/
//      import n'apparaît dans ce lot (hors périmètre, mandat OB-2) ;
//   4. aucun GRANT élargi à anon/public n'apparaît dans ce lot.
// ====================================================================

const SQL_PATH = "supabase/DRAFT-lot-catalogue-operator-authorization-v1.sql";
const SQL = readFileSync(SQL_PATH, "utf8");

const TARGET_FUNCTIONS = [
  "assert_category_role",
  "assert_product_role",
  "assert_subcategory_role",
  "create_category",
  "create_product",
  "get_merchant_catalogue",
];

// Fonctions catalogue qui NE DOIVENT PAS être directement modifiées
// par ce lot (elles héritent du bypass opérateur uniquement parce
// qu'elles APPELLENT une des fonctions ci-dessus -- non-régression
// explicite du périmètre "narrowly scoped"). get_merchant_catalogue
// est RETIRÉE de cette liste en v1.1 : elle est désormais ELLE-MÊME
// une cible directe (READ-PATH COMPLETION), pas un bénéficiaire
// transitif.
const UNTOUCHED_CATALOGUE_FUNCTIONS = [
  "update_category",
  "update_product",
  "create_subcategory",
  "update_subcategory",
  "set_product_availability",
  "archive_product",
  "restore_product",
  "set_product_order",
  "set_product_photo",
];

test("OB-2 (+v1.1): le lot modifie EXACTEMENT 6 fonctions (create or replace function), ni plus ni moins", () => {
  const matches = [...SQL.matchAll(/create or replace function public\.(\w+)\s*\(/g)].map((m) => m[1]);
  assert.deepEqual(
    matches.sort(),
    [...TARGET_FUNCTIONS].sort(),
    `fonctions modifiées inattendues : ${matches.join(", ")}`
  );
});

for (const fn of TARGET_FUNCTIONS) {
  test(`OB-2: ${fn} référence is_scanym_operator() dans son corps modifié`, () => {
    const re = new RegExp(
      `create or replace function public\\.${fn}\\s*\\([\\s\\S]*?\\nend \\$\\$;`,
      "m"
    );
    const body = SQL.match(re)?.[0];
    assert.ok(body, `corps de ${fn} introuvable dans ${SQL_PATH}`);
    assert.ok(
      body!.includes("public.is_scanym_operator()"),
      `${fn} ne référence pas public.is_scanym_operator() dans son corps modifié`
    );
  });
}

test("OB-2: aucune des RPC catalogue NON ciblées n'est déclarée (create/replace/drop) dans ce lot -- bypass strictement transitif", () => {
  const offenders: string[] = [];
  for (const fn of UNTOUCHED_CATALOGUE_FUNCTIONS) {
    const declRe = new RegExp(
      `(create( or replace)? function|drop function)\\s+public\\.${fn}\\s*\\(`,
      "i"
    );
    if (declRe.test(SQL)) offenders.push(fn);
  }
  assert.deepEqual(
    offenders,
    [],
    `fonction(s) catalogue hors périmètre déclarée(s) directement par ce lot : ${offenders.join(", ")}`
  );
});

test("OB-2 (+v1.1): aucune signature de fonction n'est modifiée (6 identités de paramètres inchangées)", () => {
  const expectedSignatures: Record<string, string> = {
    assert_category_role: "p_category_id uuid,\n  p_roles       text[]",
    assert_product_role: "p_product_id uuid,\n  p_roles      text[]",
    assert_subcategory_role: "p_subcategory_id uuid,\n  p_roles          text[]",
    create_category: "p_restaurant_id  uuid,\n  p_name           text,\n  p_display_order  integer default null",
    create_product:
      "p_category_id             uuid,\n  p_name                    text,\n  p_description             text,\n  p_price                   numeric,\n  p_short_description       text default null,\n  p_tax_rate                numeric default null,\n  p_unit_weight_grams       integer default null,\n  p_weight_is_approximate   boolean default false,\n  p_subcategory_id          uuid default null",
    get_merchant_catalogue: "p_restaurant_id uuid,\n  p_archived      boolean default false",
  };
  for (const [fn, sig] of Object.entries(expectedSignatures)) {
    assert.ok(
      SQL.includes(sig),
      `signature attendue introuvable pour ${fn} -- ce lot ne doit modifier AUCUNE signature (mandat "existing RPC signatures unless strictly necessary")`
    );
  }
});

test("OB-2 v1.1: la forme de retour (29 colonnes) de get_merchant_catalogue n'est pas modifiée", () => {
  const returnShape =
    "returns table (\n  product_id                 uuid,\n  category_id                uuid,\n  category_name               text,\n  category_name_hash          text,\n  category_translations       jsonb,\n  category_display_order      integer,\n  category_is_option_source   boolean,\n  category_description        text,\n  category_description_hash   text,\n  subcategory_id               uuid,\n  subcategory_name             text,\n  subcategory_display_order    integer,\n  name                        text,\n  name_hash                   text,\n  short_description            text,\n  short_description_hash       text,\n  description                  text,\n  description_hash             text,\n  translations                 jsonb,\n  price                        numeric,\n  is_available                 boolean,\n  archived_at                  timestamptz,\n  display_order                integer,\n  is_option_source             boolean,\n  image_url                    text,\n  tax_rate                     numeric,\n  unit_weight_grams            integer,\n  weight_is_approximate        boolean,\n  reference_price_per_kg       numeric\n)";
  assert.ok(
    SQL.includes(returnShape),
    "forme de retour de get_merchant_catalogue introuvable ou modifiée -- ce lot ne doit JAMAIS changer la forme des données retournées (mandat v1.1: \"Do NOT: ... change returned data shape\")"
  );
});

test("OB-2: aucun GRANT élargi à anon/public dans ce lot", () => {
  const grantLines = SQL.split("\n").filter((l) => /^\s*grant\s/i.test(l));
  const offenders = grantLines.filter((l) => /\bto\s+(public|anon)\b/i.test(l));
  assert.deepEqual(offenders, [], `GRANT vers anon/public trouvé, jamais attendu : ${offenders.join(" | ")}`);
});

test("OB-2: hors périmètre respecté -- aucune référence Stuart/Monetico/paiement/tracking/tags/import dans ce lot", () => {
  const forbidden = /stuart|monetico|payment_provider|tax_settings_snapshot|tracking_session|product_tags|restaurant_tags|catalogue_import/i;
  const offendingLines = SQL.split("\n")
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => forbidden.test(line) && !/^\s*--/.test(line));
  assert.deepEqual(
    offendingLines.map((o) => `L${o.i + 1}: ${o.line.trim()}`),
    [],
    "référence hors périmètre trouvée en dehors d'un commentaire"
  );
});

test("OB-2: aucune nouvelle table ni colonne créée par ce lot (create table / alter table absents)", () => {
  assert.doesNotMatch(SQL, /\bcreate table\b/i, "ce lot ne doit créer AUCUNE nouvelle table");
  assert.doesNotMatch(SQL, /\balter table\b/i, "ce lot ne doit modifier AUCUNE table existante (colonnes)");
});

test("OB-2 (+v1.1): le patron réutilisé est exactement celui de assert_restaurant_asset_role (bypass INCONDITIONNEL, jamais restreint par p_roles)", () => {
  // Le bypass doit toujours être "and not public.is_scanym_operator()"
  // accolé à la condition d'échec existante -- jamais une nouvelle
  // condition indépendante qui pourrait, par erreur d'ordre, être
  // évaluée AVANT la validation "not found" (mandat #9, "unknown
  // restaurant/category/product ID -> fail safely"). v1.1 ajoute la
  // 6e occurrence pour get_merchant_catalogue, même patron exact.
  const codeOnly = SQL.split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n");
  const occurrences = [...codeOnly.matchAll(/\) and not public\.is_scanym_operator\(\) then/g)];
  assert.equal(
    occurrences.length,
    6,
    `attendu exactement 6 occurrences du patron bypass (une par fonction ciblée, 5 v1 + 1 v1.1), trouvé ${occurrences.length}`
  );
});
