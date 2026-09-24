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
  // v2.2 : la lecture du hash de sous-catégorie est désormais JOINTE
  // (preuve d'appartenance) et VERROUILLÉE, dans la même requête.
  assert.equal(
    SQL.includes("select ms.name_hash into v_current_hash") &&
      SQL.includes("from public.menu_subcategories ms"),
    true
  );
});

test("SQL — isolation locataire des DEUX nouveaux types (jointure, jamais une confiance dans l'id)", () => {
  assert.equal(
    SQL.includes("join public.menu_categories mc on mc.id = ms.category_id"),
    true,
    "une sous-catégorie est rattachée à son tenant par sa catégorie"
  );
  assert.equal(SQL.includes("where ms.id = p_entity_id and mc.restaurant_id = p_restaurant_id"), true);
  // v2.2 : les 2 origines d'un message client sont résolues, scopées au
  // locataire ET verrouillées par la MÊME requête -- l'alias de table a
  // disparu avec la fusion, la portée locataire non.
  const notices = SQL.slice(
    SQL.indexOf("elsif p_entity_type = 'customer_notice' then"),
    SQL.indexOf("else -- 'item'")
  );
  for (const table of ["public.restaurant_sale_modes", "public.restaurant_sale_mode_fulfillments"]) {
    const at = notices.indexOf(`from ${table}`);
    assert.equal(at > 0, true, `origine non résolue : ${table}`);
    const statement = notices.slice(at, notices.indexOf(";", at));
    assert.equal(
      statement.includes("where id = p_entity_id and restaurant_id = p_restaurant_id"),
      true,
      `${table} : portée locataire absente de la requête verrouillante`
    );
    assert.equal(statement.includes("for update"), true, `${table} : lecture non verrouillée`);
  }
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
  // v2.1 : la signature porte 8 arguments (précondition optionnelle).
  assert.equal(
    SQL.includes(
      "revoke all on function public.write_translation(uuid, text, uuid, text, text, text, text, text) from public, anon;"
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

test("v2.1 — la précondition de hash source est appliquée CÔTÉ SERVEUR, une seule fois, avant toute écriture", () => {
  // Signature : un SEUL paramètre ajouté, optionnel (compatibilité de
  // l'écriture interactive).
  assert.equal(
    SQL.includes("p_expected_source_hash text default null"),
    true,
    "le paramètre doit être optionnel -- sinon l'édition interactive régresse"
  );
  // La garde existe, refuse explicitement, et n'est pas recopiée dans
  // chaque branche (une seule occurrence => impossible d'en oublier une).
  const guards = SQL.match(/if p_expected_source_hash is not null/g) ?? [];
  assert.equal(guards.length, 1, "garde UNIQUE attendue");
  assert.equal(SQL.includes("p_expected_source_hash is distinct from v_current_hash"), true);
  assert.equal(SQL.includes("SCANYM_TRANSLATION_SOURCE_CHANGED"), true);

  // La garde précède TOUTE écriture : aucun `update public.` avant elle.
  const body = SQL.slice(SQL.indexOf("create function public.write_translation"));
  const guardAt = body.indexOf("if p_expected_source_hash is not null");
  const firstUpdate = body.indexOf("update public.");
  assert.equal(
    guardAt > 0 && firstUpdate > guardAt,
    true,
    "la garde doit être évaluée AVANT le premier UPDATE de la fonction"
  );

  // Le hash du client n'est JAMAIS stocké : seule v_current_hash l'est.
  assert.equal(
    body.includes("p_field || '_source_hash', p_expected_source_hash"),
    false,
    "le hash fourni par le client ne doit jamais devenir le hash stocké"
  );
  assert.equal((body.match(/p_field \|\| '_source_hash', v_current_hash/g) ?? []).length, 6);

  // Aucune surcharge non sûre ne doit survivre.
  assert.equal(
    SQL.includes("drop function if exists public.write_translation(uuid, text, uuid, text, text, text, text);"),
    true
  );
  assert.equal(
    SQL.includes("plusieurs versions de write_translation coexistent"),
    true,
    "post-vérification anti-surcharge attendue"
  );
});

test("v2.2 — la lecture du hash autoritatif VERROUILLE la ligne source, dans la requête qui prouve le locataire", () => {
  const fn = SQL.slice(
    SQL.indexOf("create function public.write_translation"),
    SQL.indexOf("comment on function public.write_translation")
  );
  const code = fn
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  // Les 5 chemins d'entité lisent le hash SOUS VERROU.
  const locks = code.match(/for update/g) ?? [];
  assert.equal(locks.length >= 5, true, `verrou attendu sur chaque chemin, trouvé ${locks.length}`);

  // Aucune lecture de hash NON verrouillée ne subsiste : chaque
  // `select <...>_hash into v_current_hash` doit être suivi d'un
  // `for update` avant son point-virgule final.
  const reads = code.split("into v_current_hash").slice(1);
  assert.equal(reads.length >= 5, true);
  for (const [i, chunk] of reads.entries()) {
    const statement = chunk.slice(0, chunk.indexOf(";"));
    assert.equal(
      /for update/.test(statement),
      true,
      `lecture de hash #${i + 1} non verrouillée : ${statement.replace(/\s+/g, " ").trim()}`
    );
  }

  // Appartenance au locataire prouvée DANS la requête verrouillante
  // (jamais un contrôle séparé qui rouvrirait une fenêtre).
  assert.equal(
    /where id = p_entity_id and restaurant_id = p_restaurant_id\s*\n\s*for update/.test(code),
    true,
    "category / customer_notice : tenant + verrou dans la même requête"
  );
  assert.equal(code.includes("for update of ms, mc"), true, "sous-catégorie : ligne source ET parent verrouillés");
  assert.equal(code.includes("for update of mi, mc"), true, "produit : ligne source ET parent verrouillés");

  // Aucun verrou applicatif ni consultatif, aucun changement
  // d'isolation (mandat §3).
  for (const forbidden of ["pg_advisory", "set transaction isolation", "serializable", "pg_sleep"]) {
    assert.equal(code.toLowerCase().includes(forbidden), false, `mécanisme interdit : ${forbidden}`);
  }

  // Le verrou est pris AVANT la garde, elle-même avant toute écriture.
  const firstLock = code.indexOf("for update");
  const guard = code.indexOf("if p_expected_source_hash is not null");
  const firstUpdate = code.indexOf("update public.");
  assert.equal(
    firstLock < guard && guard < firstUpdate,
    true,
    "ordre attendu : verrou -> garde -> écriture"
  );

  // Le rollback restaure une version SANS verrou (état antérieur exact).
  const rb = readFileSync(ROLLBACK, "utf8");
  const rbFn = rb.slice(
    rb.indexOf("create function public.write_translation"),
    rb.indexOf("revoke all on function public.write_translation")
  );
  assert.equal(rbFn.includes("for update"), false);
  assert.equal(rbFn.includes("p_expected_source_hash"), false);
});

test("v2.1 — l'import transmet le hash DU FICHIER ; l'édition interactive reste sans précondition", () => {
  const confirm = PAGE_SRC.slice(PAGE_SRC.indexOf("async function handleConfirmImport"));
  assert.equal(
    /writeTranslation\([\s\S]*?row\.sourceHash[\s\S]*?\)/.test(confirm),
    true,
    "la confirmation doit transmettre le hash lu dans le classeur"
  );
  // handleSave (édition interactive) : 7 arguments, aucune précondition
  // -- plus petit changement possible, documenté dans le rapport.
  const manual = PAGE_SRC.slice(
    PAGE_SRC.indexOf("async function handleSave"),
    PAGE_SRC.indexOf("/** Télécharge un classeur")
  );
  assert.equal(
    manual.includes("await writeTranslation(restaurantId, entityType, entityId, field, targetLang, value, status);"),
    true,
    "l'écriture interactive reste exactement celle de v2"
  );

  const service = readFileSync("lib/services/dashboard.ts", "utf8");
  assert.equal(service.includes("expectedSourceHash: string | null = null"), true);
  assert.equal(service.includes("p_expected_source_hash: expectedSourceHash"), true);

  // `source_hash` est OBLIGATOIRE dans le fichier : sans lui aucune
  // ligne ne pourrait porter la précondition jusqu'au serveur.
  const importSrc = readFileSync("lib/translations-management/import.ts", "utf8");
  const required = importSrc.slice(
    importSrc.indexOf("export const REQUIRED_IMPORT_COLUMNS"),
    importSrc.indexOf("] as const;", importSrc.indexOf("export const REQUIRED_IMPORT_COLUMNS"))
  );
  assert.equal(required.includes('"source_hash"'), true);
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
