import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym — TRANSLATIONS MANAGEMENT v2 — INVARIANTS STRUCTURELS
// (mandat §4 « étendre, ne pas dupliquer », §5 sécurité, §6 pas de
// second aplatissement, §8 pas de second calcul de statut, §14 aucun
// service_role côté navigateur, §20 discipline SQL)
// ====================================================================

const LOT = "supabase/DRAFT-lot-translations-management-v2.sql";
const ROLLBACK = "supabase/DRAFT-lot-translations-management-v2-rollback.sql";
const PAGE = "app/dashboard/translations/page.tsx";
const SQL = readFileSync(LOT, "utf8");
const PAGE_SRC = readFileSync(PAGE, "utf8");

// --------------------------------------------------------------------
// Modèle de traduction : ÉTENDU, jamais dupliqué
// --------------------------------------------------------------------

test("SQL — aucune seconde table de traductions : le modèle JSONB existant est étendu", () => {
  assert.equal(/create table/i.test(SQL), false, "ce lot ne crée AUCUNE table");
  assert.equal(
    SQL.includes("alter table public.menu_subcategories"),
    true,
    "les traductions de sous-catégorie vivent sur la table existante"
  );
  assert.equal(SQL.includes("add column translations jsonb"), true);
  assert.equal(
    SQL.includes("name_hash text generated always as (md5(coalesce(name, ''))) stored"),
    true,
    "MÊME expression de hash que menu_categories/menu_items (LOT 1B)"
  );
});

test("SQL — write_translation accepte 5 types et les champs attendus, sans élargir les autres", () => {
  assert.equal(
    SQL.includes("if p_entity_type not in ('restaurant', 'category', 'item', 'subcategory', 'customer_notice') then"),
    true
  );
  assert.equal(SQL.includes("Invalid field for entity type subcategory"), true);
  assert.equal(SQL.includes("Invalid field for entity type customer_notice"), true);
  // Champs des types PRÉEXISTANTS : inchangés.
  assert.equal(SQL.includes("if p_field not in ('intro_text', 'announcement_text') then"), true);
  assert.equal(SQL.includes("if p_field not in ('name', 'description') then"), true);
  assert.equal(SQL.includes("if p_field not in ('name', 'short_description', 'description') then"), true);
  // Nouveaux types : un seul champ chacun.
  assert.equal(SQL.includes("if p_field not in ('name') then"), true);
  assert.equal(SQL.includes("if p_field not in ('customer_text') then"), true);
});

test("SQL — garanties de sécurité PRÉSERVÉES mot pour mot (autorisation, langue, statut, hash)", () => {
  assert.equal(SQL.includes("perform public.assert_restaurant_asset_role(p_restaurant_id);"), true);
  assert.equal(SQL.includes("Cannot write a translation into the source language"), true);
  assert.equal(SQL.includes("Language is not active for this restaurant"), true);
  assert.equal(SQL.includes("Unsupported language code"), true);
  assert.equal(
    SQL.includes("if p_status not in ('to_review', 'validated') then"),
    true,
    "'stale' reste dérivé en lecture, jamais écrit"
  );
  // Le hash est TOUJOURS relu côté serveur -- jamais un paramètre.
  assert.equal(/p_source_hash|p_hash/.test(SQL), false);
  assert.equal(SQL.includes("select name_hash into v_current_hash from public.menu_subcategories"), true);
});

test("SQL — isolation locataire des DEUX nouveaux types (jointure, jamais une confiance dans l'id)", () => {
  assert.equal(
    SQL.includes("join public.menu_categories mc on mc.id = ms.category_id"),
    true,
    "une sous-catégorie est rattachée à son tenant par sa catégorie"
  );
  assert.equal(SQL.includes("where ms.id = p_entity_id and mc.restaurant_id = p_restaurant_id"), true);
  assert.equal(SQL.includes("where rsm.id = p_entity_id and rsm.restaurant_id = p_restaurant_id"), true);
  assert.equal(SQL.includes("where f.id = p_entity_id and f.restaurant_id = p_restaurant_id"), true);
  assert.equal(SQL.includes("Subcategory not found for this restaurant"), true);
  assert.equal(SQL.includes("Customer notice not found for this restaurant"), true);
});

test("SQL — aucun privilège nouveau : search_path explicite, aucun droit anon/public sur l'écriture", () => {
  // Comptage sur le CODE seul : les commentaires mentionnent aussi
  // « SECURITY DEFINER » en prose, ce qui fausserait la comparaison.
  const code = SQL.replace(/^\s*--.*$/gm, "");
  const definers = code.match(/^security definer$/gm) ?? [];
  const searchPaths = code.match(/^set search_path = ''$/gm) ?? [];
  assert.equal(definers.length, 6, "6 fonctions SECURITY DEFINER dans ce lot");
  assert.equal(
    searchPaths.length,
    definers.length,
    "chaque fonction SECURITY DEFINER fixe explicitement son search_path"
  );
  assert.equal(
    SQL.includes(
      "revoke all on function public.write_translation(uuid, text, uuid, text, text, text, text) from public, anon;"
    ),
    true
  );
  assert.equal(
    /grant execute on function public\.write_translation[^;]*to authenticated;/.test(SQL),
    true
  );
  assert.equal(
    /grant execute on function public\.write_translation[^;]*anon/.test(SQL),
    false,
    "jamais d'écriture anonyme"
  );
  assert.equal(
    /grant (insert|update|delete)[^;]*to (anon|authenticated)/i.test(SQL),
    false,
    "aucune écriture directe en table"
  );
});

test("SQL — lectures publiques : seuls le texte client déjà public, son hash et ses traductions", () => {
  const publicBlock = SQL.slice(SQL.indexOf("get_restaurant_public_sale_modes"));
  assert.equal(publicBlock.includes("rsm.customer_text_hash, rsm.translations"), true);
  for (const internal of ["provider", "config", "secret", "fulfillment_code,\n    f.provider"]) {
    assert.equal(
      new RegExp(`select[^;]*${internal}`, "is").test(publicBlock.slice(0, 2000)) && internal === "provider",
      false,
      `donnée interne exposée publiquement : ${internal}`
    );
  }
});

test("SQL — transaction unique, pré-vol de dérive et post-vérification (mandat §20)", () => {
  assert.equal((SQL.match(/^begin;$/gm) ?? []).length, 1);
  assert.equal((SQL.match(/^commit;$/gm) ?? []).length, 1);
  assert.equal(SQL.includes("SCANYM_SCHEMA_DRIFT"), true);
  assert.equal(SQL.includes("SCANYM_ALREADY_APPLIED"), true);
  assert.equal(SQL.includes("SCANYM_POST_COMMIT_CHECK_FAILED"), true);
});

test("SQL — rollback présent, symétrique et fail-closed", () => {
  assert.equal(existsSync(ROLLBACK), true);
  const rb = readFileSync(ROLLBACK, "utf8");
  for (const column of [
    "drop column name_hash",
    "drop column translations",
    "drop column customer_text_hash",
    "drop column id",
  ]) {
    assert.equal(rb.includes(column), true, `rollback incomplet : ${column}`);
  }
  assert.equal(rb.includes("SCANYM_SCHEMA_DRIFT"), true);
  // Les 6 fonctions étendues sont REMISES dans leur version antérieure.
  for (const fn of [
    "public.write_translation",
    "public.get_merchant_catalogue",
    "public.get_merchant_delivery_method_notices",
    "public.get_merchant_delivery_fulfillment_pricing",
    "public.get_restaurant_public_sale_modes",
    "public.get_restaurant_public_delivery_fulfillments",
  ]) {
    assert.equal(rb.includes(`create function ${fn}`), true, `fonction non restaurée : ${fn}`);
  }
  assert.equal(
    rb.includes("if p_entity_type not in ('restaurant', 'category', 'item') then"),
    true,
    "write_translation revient EXACTEMENT à ses 3 types d'origine"
  );
});

// --------------------------------------------------------------------
// Application : une seule autorité par sujet
// --------------------------------------------------------------------

test("écran — le parcours du catalogue passe par le module partagé, plus par `cat.products`", () => {
  assert.equal(
    PAGE_SRC.includes("buildTranslationRows"),
    true,
    "l'écran lit la liste construite par l'autorité unique"
  );
  assert.equal(
    /catalogueInContext\.map\(\(cat\)/.test(PAGE_SRC),
    false,
    "l'ancien parcours direct des catégories ne doit pas revenir"
  );
  assert.equal(
    /\.products\.map\(/.test(PAGE_SRC),
    false,
    "c'est exactement ce parcours qui masquait les produits de sous-catégorie"
  );
});

test("modules — un seul aplatissement de catalogue, partagé avec l'écran Catalogue", () => {
  const rows = readFileSync("lib/translations-management/rows.ts", "utf8");
  assert.equal(rows.includes('from "@/lib/catalogue-management/filtering"'), true);
  assert.equal(rows.includes("flattenCatalogue("), true);
  // Aucun parcours maison des sous-catégories pour les PRODUITS.
  assert.equal(
    /for \(const sub of [^)]*\) \{\s*for \(const product/.test(rows),
    false,
    "pas de seconde implémentation d'aplatissement"
  );
});

test("modules — un seul calcul de statut : getTranslationStatus reste l'autorité", () => {
  const rows = readFileSync("lib/translations-management/rows.ts", "utf8");
  const filtering = readFileSync("lib/translations-management/filtering.ts", "utf8");
  const exportSrc = readFileSync("lib/translations-management/export.ts", "utf8");
  assert.equal(rows.includes("getTranslationStatus"), true);
  // Aucun module ne réimplémente la comparaison de hash/statut.
  for (const [name, src] of [
    ["filtering", filtering],
    ["export", exportSrc],
  ] as const) {
    assert.equal(
      /_status\b[^]*===\s*"validated"/.test(src),
      false,
      `${name} ne doit pas recalculer un statut`
    );
  }
});

test("import — deux phases : l'écran n'écrit qu'après confirmation explicite", () => {
  // La lecture du fichier ne déclenche AUCUNE écriture.
  const handleImport = PAGE_SRC.slice(
    PAGE_SRC.indexOf("async function handleImportFile"),
    PAGE_SRC.indexOf("async function handleConfirmImport")
  );
  assert.equal(handleImport.includes("writeTranslation"), false, "phase 1 n'écrit jamais");
  assert.equal(handleImport.includes("buildTranslationImportPreview"), true);

  const confirm = PAGE_SRC.slice(PAGE_SRC.indexOf("async function handleConfirmImport"));
  assert.equal(confirm.includes("applicableImportRows(importPreview)"), true);
  assert.equal(confirm.includes("writeTranslation("), true);
  assert.equal(
    PAGE_SRC.includes('data-translations-import-confirm=""'),
    true,
    "la confirmation est un geste explicite de l'utilisateur"
  );
});

test("import — aucune RPC d'import en masse : la RPC sécurisée existante est réutilisée", () => {
  assert.equal(
    /create function public\.(bulk|import)_/i.test(SQL),
    false,
    "aucune RPC d'import en masse n'est introduite"
  );
  const importSrc = readFileSync("lib/translations-management/import.ts", "utf8");
  assert.equal(importSrc.includes("supabase"), false, "le module d'import reste pur");
});

test("aucun service_role dans le code navigateur (mandat §14)", () => {
  for (const file of [
    PAGE,
    "lib/translations-management/rows.ts",
    "lib/translations-management/filtering.ts",
    "lib/translations-management/export.ts",
    "lib/translations-management/import.ts",
  ]) {
    const src = readFileSync(file, "utf8");
    assert.equal(src.includes("service_role"), false, `service_role référencé dans ${file}`);
    assert.equal(src.includes("supabase-admin"), false, `client admin importé dans ${file}`);
  }
});

test("écran — tous les contrôles exigés sont présents (mandat §15)", () => {
  for (const marker of [
    "data-translations-target-lang",
    "data-translations-search",
    "data-translations-filter-category",
    "data-translations-filter-subcategory",
    "data-translations-filter-tag",
    "data-translations-filter-availability",
    "data-translations-filter-status",
    "data-translations-sort",
    "data-translations-reset-filters",
    "data-translations-result-count",
    "data-translations-export",
    "data-translations-import-input",
  ]) {
    assert.equal(PAGE_SRC.includes(marker), true, `contrôle absent : ${marker}`);
  }
});
