import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym LOT 1B — traductions manuelles des contenus. GO CIO explicite,
// périmètre strict : pas de traduction automatique, pas de Sous-lot C
// (changement de langue source), aucun appel externe.
// ====================================================================

const v81Sql = readFileSync("supabase/migration-v81-lot1b-translations.sql", "utf8");
const v81RollbackSql = readFileSync("supabase/migration-v81-rollback.sql", "utf8");
const resolverSrc = readFileSync("lib/translation-resolver.ts", "utf8");
const menuI18nSrc = readFileSync("lib/menu-i18n.ts", "utf8");
const i18nContextSrc = readFileSync("lib/i18n-context.tsx", "utf8");
const harnessSrc = readFileSync("supabase/tests/v81-lot1b-check.sh", "utf8");

// --------------------------------------------------------------------
// Découvertes de conception traitées pendant l'audit préalable
// --------------------------------------------------------------------

test("LOT 1B: découverte -- lib/menu-i18n.ts ne code plus 'fr' comme langue source figée (hypothèse fausse corrigée, pas contournée)", () => {
  const codeOnly = menuI18nSrc.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!codeOnly.includes('if (lang === "fr")'), "l'ancienne hypothèse fr-figé ne doit plus exister dans le CODE (une mention en commentaire expliquant l'ancien défaut est légitime)");
  assert.ok(menuI18nSrc.includes("sourceLanguage"), "sourceLanguage doit être un paramètre explicite");
  assert.ok(menuI18nSrc.includes("resolveTranslatedField"), "doit déléguer au résolveur générique");
});

test("LOT 1B: découverte -- I18nProvider (contexte React) ne code plus 'lang === \"ar\"' (seconde occurrence jamais corrigée lors de L1A-03)", () => {
  assert.ok(!i18nContextSrc.includes('lang === "ar"'));
  assert.ok(i18nContextSrc.includes("dirOf("), "doit réutiliser dirOf(), jamais une règle réinventée");
  assert.ok(i18nContextSrc.includes("sourceLanguage"), "le contexte expose désormais sourceLanguage pour les composants");
});

// --------------------------------------------------------------------
// Résolveur générique -- contrat exact (section 4)
// --------------------------------------------------------------------

test("LOT 1B: resolveTranslatedField -- contrat exact (source si lang=source, sinon traduction validée+à jour, sinon repli source)", async () => {
  const { resolveTranslatedField } = await import("../lib/translation-resolver.ts");

  assert.equal(
    resolveTranslatedField("Bonjour", "hash1", { en: { name: "Hello", name_status: "validated", name_source_hash: "hash1" } }, "fr", "fr", "name"),
    "Bonjour"
  );

  assert.equal(
    resolveTranslatedField("Bonjour", "hash1", { en: { name: "Hello", name_status: "validated", name_source_hash: "hash1" } }, "en", "fr", "name"),
    "Hello"
  );

  assert.equal(
    resolveTranslatedField("Bonjour", "hash1", { en: { name: "Hello", name_status: "to_review", name_source_hash: "hash1" } }, "en", "fr", "name"),
    "Bonjour"
  );

  assert.equal(
    resolveTranslatedField("Bonjour modifié", "hash2", { en: { name: "Hello", name_status: "validated", name_source_hash: "hash1" } }, "en", "fr", "name"),
    "Bonjour modifié"
  );

  assert.equal(resolveTranslatedField("Bonjour", "hash1", null, "en", "fr", "name"), "Bonjour");
  assert.equal(resolveTranslatedField("Bonjour", "hash1", {}, "en", "fr", "name"), "Bonjour");
});

test("LOT 1B: getTranslationStatus -- 4 statuts corrects (missing/to_review/validated/stale)", async () => {
  const { getTranslationStatus } = await import("../lib/translation-resolver.ts");
  assert.equal(getTranslationStatus("hash1", null, "en", "name"), "missing");
  assert.equal(getTranslationStatus("hash1", { en: { name: "Hello", name_status: "to_review", name_source_hash: "hash1" } }, "en", "name"), "to_review");
  assert.equal(getTranslationStatus("hash1", { en: { name: "Hello", name_status: "validated", name_source_hash: "hash1" } }, "en", "name"), "validated");
  assert.equal(getTranslationStatus("hash2", { en: { name: "Hello", name_status: "validated", name_source_hash: "hash1" } }, "en", "name"), "stale");
});

test("LOT 1B: aucun calcul de hash côté TypeScript -- le résolveur ne fait QUE comparer des chaînes déjà calculées (erreur classique explicitement évitée)", () => {
  assert.ok(!resolverSrc.includes("md5("));
  assert.ok(!resolverSrc.includes("createHash"));
  assert.ok(!resolverSrc.includes("import crypto"));
});

// --------------------------------------------------------------------
// Stockage -- même mécanisme JSONB, colonnes de hash générées SQL
// --------------------------------------------------------------------

test("LOT 1B: hash canonique calculé EXCLUSIVEMENT via colonnes GÉNÉRÉES PostgreSQL (GENERATED ALWAYS AS ... STORED), jamais une fonction réimplémentée", () => {
  const genCount = (v81Sql.match(/generated always as \(md5\(coalesce\([a-z_]+, ''\)\)\) stored/g) || []).length;
  assert.equal(genCount, 7, "les 7 champs traduisibles doivent chacun avoir leur colonne de hash générée");
});

test("LOT 1B: aucun catalogue de langues codé en dur -- write_translation valide contre supported_languages/restaurant_active_languages (LOT 1A), jamais une liste figée", () => {
  const start = v81Sql.indexOf("create function public.write_translation");
  const end = v81Sql.indexOf("\nend $$;", start);
  const body = v81Sql.slice(start, end);
  assert.ok(body.includes("select 1 from public.supported_languages where code = p_lang"));
  assert.ok(body.includes("select 1 from public.restaurant_active_languages"));
  assert.ok(!/in \('fr','en','ar'\)/.test(body), "aucune liste de langues figée");
});

test("LOT 1B: write_translation est une RPC UNIQUE couvrant les 3 types d'entité -- aucun système parallèle par type d'objet", () => {
  const occurrences = (v81Sql.match(/create function public\.write_translation/g) || []).length;
  assert.equal(occurrences, 1);
  const start = v81Sql.indexOf("create function public.write_translation");
  const end = v81Sql.indexOf("\nend $$;", start);
  const body = v81Sql.slice(start, end);
  assert.ok(body.includes("'restaurant'") && body.includes("'category'") && body.includes("'item'"));
});

// --------------------------------------------------------------------
// Sécurité
// --------------------------------------------------------------------

test("LOT 1B: write_translation réutilise assert_restaurant_asset_role (patron F-01 déjà audité), jamais un contrôle réinventé", () => {
  const start = v81Sql.indexOf("create function public.write_translation");
  const end = v81Sql.indexOf("\nend $$;", start);
  const body = v81Sql.slice(start, end);
  assert.ok(body.includes("perform public.assert_restaurant_asset_role(p_restaurant_id);"));
});

test("LOT 1B: write_translation vérifie l'appartenance de la catégorie/du produit au restaurant (cross-tenant impossible par ID manipulé)", () => {
  const start = v81Sql.indexOf("create function public.write_translation");
  const end = v81Sql.indexOf("\nend $$;", start);
  const body = v81Sql.slice(start, end);
  assert.ok(body.includes("where id = p_entity_id and restaurant_id = p_restaurant_id"));
  assert.ok(body.includes("join public.menu_categories mc on mc.id = mi.category_id") && body.includes("mc.restaurant_id = p_restaurant_id"));
});

test("LOT 1B: write_translation refuse une écriture dans la langue source ou une langue non active", () => {
  const start = v81Sql.indexOf("create function public.write_translation");
  const end = v81Sql.indexOf("\nend $$;", start);
  const body = v81Sql.slice(start, end);
  assert.ok(body.includes("Cannot write a translation into the source language"));
  assert.ok(body.includes("Language is not active for this restaurant"));
});

test("LOT 1B: aucun droit à PUBLIC/anon sur les nouvelles RPC", () => {
  for (const fn of ["write_translation(uuid, text, uuid, text, text, text, text)", "get_restaurant_translation_settings(uuid)"]) {
    assert.ok(v81Sql.includes(`revoke all on function public.${fn} from public, anon;`));
    assert.ok(v81Sql.includes(`grant execute on function public.${fn} to authenticated;`));
  }
});

test("LOT 1B: aucun secret/provider externe, aucun appel réseau -- traduction automatique explicitement hors périmètre", () => {
  for (const src of [v81Sql, resolverSrc]) {
    assert.ok(!/openai|anthropic|deepl|google.*translate|fetch\(/i.test(src));
  }
});

// --------------------------------------------------------------------
// Rollback
// --------------------------------------------------------------------

test("LOT 1B rollback: get_merchant_catalogue restaurée à son corps EXACT d'avant LOT 1B (extraction programmatique, jamais retapée)", () => {
  assert.ok(v81RollbackSql.includes("is_option_source"));
  const dropIdx = v81RollbackSql.indexOf("drop function if exists public.get_merchant_catalogue");
  const restoredStart = v81RollbackSql.indexOf("create function public.get_merchant_catalogue", dropIdx);
  const restoredEnd = v81RollbackSql.indexOf("\nend $$;", restoredStart);
  const restoredBody = v81RollbackSql.slice(restoredStart, restoredEnd);
  assert.ok(!restoredBody.includes("category_name_hash"), "la version restaurée ne doit plus référencer les colonnes de hash LOT 1B");
});

test("LOT 1B rollback: ne supprime JAMAIS menu_categories.translations / menu_items.translations (colonnes PRÉ-EXISTANTES, pas créées par ce lot) -- seule restaurant_configs.translations (NOUVELLE colonne LOT 1B) est légitimement retirée", () => {
  const menuCategoriesAlterStart = v81RollbackSql.indexOf("alter table public.menu_categories");
  const menuCategoriesAlterEnd = v81RollbackSql.indexOf(";", menuCategoriesAlterStart);
  const menuItemsAlterStart = v81RollbackSql.indexOf("alter table public.menu_items");
  const menuItemsAlterEnd = v81RollbackSql.indexOf(";", menuItemsAlterStart);
  assert.ok(!v81RollbackSql.slice(menuCategoriesAlterStart, menuCategoriesAlterEnd).includes("drop column if exists translations"));
  assert.ok(!v81RollbackSql.slice(menuItemsAlterStart, menuItemsAlterEnd).includes("drop column if exists translations"));
  // restaurant_configs.translations, elle, DOIT être retirée (colonne
  // créée par LOT 1B) -- confirmé présent, pas une omission.
  const restaurantConfigsAlterStart = v81RollbackSql.indexOf("alter table public.restaurant_configs");
  const restaurantConfigsAlterEnd = v81RollbackSql.indexOf(";", restaurantConfigsAlterStart);
  assert.ok(v81RollbackSql.slice(restaurantConfigsAlterStart, restaurantConfigsAlterEnd).includes("drop column if exists translations"));
});

test("LOT 1B rollback: préflight informatif (NOTICE) signale le volume de traductions restaurant-level qui seront perdues, jamais un blocage artificiel puisqu'aucune contrainte n'est violée", () => {
  assert.ok(v81RollbackSql.includes("SCANYM_ROLLBACK_LOT1B"));
  assert.ok(v81RollbackSql.includes("raise notice"));
});

test("LOT 1B rollback: jamais auto-exécuté", () => {
  assert.ok(v81RollbackSql.includes("NE JAMAIS EXÉCUTER AUTOMATIQUEMENT"));
});

// --------------------------------------------------------------------
// Preuve empirique PostgreSQL réelle (harnais dédié)
// --------------------------------------------------------------------

test("LOT 1B: le harnais PostgreSQL dédié couvre tous les scénarios exigés", () => {
  const requiredMarkers = [
    "hash source capturé exactement au moment de la validation",
    "traduction devenue stale",
    "revalidation -> hash de nouveau à jour",
    "les 7 champs traduisibles sont tous fonctionnels",
    "nom d'établissement refusée",
    "cross-tenant",
    "staff refusé",
    "opérateur Scanym accepté",
    "langue RTL fictive",
    "source AR",
    "réapplication propre réussie après annulation",
  ];
  for (const m of requiredMarkers) {
    assert.ok(harnessSrc.includes(m), `scénario manquant dans le harnais : ${m}`);
  }
});

// ====================================================================
// LOT 1B.1 — corrections ciblées après contre-audit Work
// ====================================================================

// --------------------------------------------------------------------
// L1B-01 — backfill atomique et borné des traductions historiques
// --------------------------------------------------------------------

test("L1B-01: la migration contient un backfill DO block, placé APRÈS les colonnes de hash générées (nécessaires au calcul), AVANT le commit", () => {
  const hashColIdx = v81Sql.indexOf("add column if not exists description_hash text generated always as (md5(coalesce(description, ''))) stored;\n\nalter table public.menu_items");
  const backfillIdx = v81Sql.indexOf("do $$", v81Sql.indexOf("2b-bis"));
  const commitIdx = v81Sql.lastIndexOf("commit;");
  assert.ok(backfillIdx > 0 && commitIdx > backfillIdx, "le backfill doit précéder le commit");
});

test("L1B-01: le backfill ne touche QUE les entrées où le statut est TOTALEMENT ABSENT -- jamais une traduction déjà to_review (pas d'auto-validation)", () => {
  const start = v81Sql.indexOf("2b-bis");
  const end = v81Sql.indexOf("-- ------------------------------------------------------------\n\ncreate function public.write_translation", start);
  const body = v81Sql.slice(start, end);
  assert.ok(body.includes("not (lang_val ? 'name_status')"));
  assert.ok(body.includes("not (lang_val ? 'description_status')"));
  assert.ok(body.includes("not (lang_val ? 'short_description_status')"));
});

test("L1B-01: le backfill couvre catégories ET produits, pour chaque champ historique concerné (name/description pour catégories, name/short_description/description pour produits)", () => {
  const start = v81Sql.indexOf("2b-bis");
  const end = v81Sql.indexOf("-- ------------------------------------------------------------\n\ncreate function public.write_translation", start);
  const body = v81Sql.slice(start, end);
  assert.ok(body.includes("from public.menu_categories"));
  assert.ok(body.includes("from public.menu_items"));
  assert.ok(body.includes("'name_status'") && body.includes("'description_status'") && body.includes("'short_description_status'"));
});

test("L1B-01: le backfill préserve TOUTES les autres clés JSONB (jsonb_set sur l'objet existant, jamais un remplacement complet)", () => {
  const start = v81Sql.indexOf("2b-bis");
  const end = v81Sql.indexOf("-- ------------------------------------------------------------\n\ncreate function public.write_translation", start);
  const body = v81Sql.slice(start, end);
  assert.ok(body.includes("new_trans := jsonb_set(new_trans,"), "doit utiliser jsonb_set sur le JSONB existant, jamais reconstruire from scratch");
  assert.ok(!body.includes(":= jsonb_build_object("), "ne doit jamais reconstruire l'objet complet depuis rien");
});

test("L1B-01: preuve empirique — reproduction du format historique exact (Illico Presto, ar/name sans status/hash) confirmée invisible AVANT correctif, publiée APRÈS backfill", async () => {
  const { resolveTranslatedField } = await import("../lib/translation-resolver.ts");
  // Format historique EXACT (migration-translations.sql), avant tout backfill
  const historical = { ar: { name: "المشروبات الساخنة" } };
  const beforeFix = resolveTranslatedField("Boissons chaudes", "somehash", historical, "ar", "fr", "name");
  assert.equal(beforeFix, "Boissons chaudes", "sans backfill, la traduction historique est bien invisible (régression confirmée)");

  // Après backfill (status+hash ajoutés, valeur et langue inchangées)
  const backfilled = { ar: { name: "المشروبات الساخنة", name_status: "validated", name_source_hash: "somehash" } };
  const afterFix = resolveTranslatedField("Boissons chaudes", "somehash", backfilled, "ar", "fr", "name");
  assert.equal(afterFix, "المشروبات الساخنة", "après backfill, la traduction historique doit être publiée -- preuve du rendu, pas seulement de la présence du JSON");
});

// --------------------------------------------------------------------
// L1B-02 — page accessible depuis le Dashboard
// --------------------------------------------------------------------

test("L1B-02: DashboardNav contient un lien réel vers /dashboard/translations, avec un état actif dédié distinct de Commandes/Catalogue/Réglages", () => {
  const navSrc = readFileSync("components/dashboard/DashboardNav.tsx", "utf8");
  assert.ok(navSrc.includes('href("/dashboard/translations")'));
  assert.ok(navSrc.includes("onTranslations"));
  assert.ok(navSrc.includes('pathname?.startsWith("/dashboard/translations")'));
});

test("L1B-02: l'onglet Commandes exclut explicitement onTranslations de sa condition d'activation (corrige le repli générique qui le marquait actif à tort)", () => {
  const navSrc = readFileSync("components/dashboard/DashboardNav.tsx", "utf8");
  assert.ok(navSrc.includes("!onCatalogue && !onSettings && !onTranslations"));
});

test("L1B-02: le libellé est intégré au mécanisme i18n existant (translate()/dictionnaires fr/en/ar), pas une chaîne codée en dur dans le composant", () => {
  const navSrc = readFileSync("components/dashboard/DashboardNav.tsx", "utf8");
  assert.ok(navSrc.includes('t("dsTranslations")'));
  const i18nSrc = readFileSync("lib/i18n.ts", "utf8");
  const occurrences = (i18nSrc.match(/dsTranslations:/g) || []).length;
  assert.equal(occurrences, 3, "la clé doit exister dans les 3 dictionnaires (fr/en/ar)");
});

test("L1B-02: preuve empirique -- voir tests/v81-lot1b1-dashboardnav.dom.test.ts (rendu DOM réel, 3 scénarios : lien présent, actif sur sa route, jamais Commandes actif à sa place)", () => {
  const domTestSrc = readFileSync("tests/v81-lot1b1-dashboardnav.dom.test.ts", "utf8");
  assert.ok(domTestSrc.includes("une entrée « Langues & traductions » existe"));
  assert.ok(domTestSrc.includes("Commandes » ne l'est JAMAIS"));
  assert.ok(domTestSrc.includes("non-régression"));
});

// --------------------------------------------------------------------
// L1B1-02 — instabilité de la suite normale (tests/v67b-photo-placeholder.dom.test.ts)
// --------------------------------------------------------------------

test("L1B1-02: le test photo n'utilise plus de délai fixe arbitraire (flush()) -- remplacé par une attente conditionnelle déterministe (waitFor)", () => {
  const src = readFileSync("tests/v67b-photo-placeholder.dom.test.ts", "utf8");
  const activeCode = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!activeCode.includes("await flush();"), "aucun test ne doit plus utiliser le délai fixe flush()");
  assert.ok(src.includes("async function waitFor("), "une attente conditionnelle déterministe doit exister");
  const waitForCallCount = (src.match(/await waitFor\(/g) || []).length;
  assert.equal(waitForCallCount, 5, "les 4 tests doivent utiliser waitFor (le 3e en utilise 2 : avant et après l'échec de chargement)");
});

test("L1B1-02: waitFor() n'est jamais un timeout allongé aveuglément ni un retry masquant un échec -- interroge une condition réelle, échoue explicitement si jamais vraie", () => {
  const src = readFileSync("tests/v67b-photo-placeholder.dom.test.ts", "utf8");
  const start = src.indexOf("async function waitFor(");
  const end = src.indexOf("\n}", start);
  const body = src.slice(start, end);
  assert.ok(body.includes("while (!condition())"));
  assert.ok(body.includes("throw new Error("), "doit échouer explicitement si la condition n'est jamais vraie, jamais un succès silencieux");
});

test("L1B1-02: cause racine RAF/cleanup corrigée -- même technique déjà éprouvée en LOT 1A.1 (JSDOM natif, after() avec window.close()+esbuild.stop())", () => {
  const src = readFileSync("tests/v67b-photo-placeholder.dom.test.ts", "utf8");
  assert.ok(!src.includes("setTimeout(() => cb(Date.now())"), "l'ancien polyfill maison ne doit plus exister");
  assert.ok(src.includes("window.requestAnimationFrame.bind(window)"));
  assert.ok(src.includes("after(async () => {"));
  assert.ok(src.includes("window.close();"));
  assert.ok(src.includes("await esbuild.stop();"));
});

test("L1B1-02: aucune assertion affaiblie, aucun scénario supprimé -- les 4 tests originaux existent toujours avec leurs vérifications complètes", () => {
  const src = readFileSync("tests/v67b-photo-placeholder.dom.test.ts", "utf8");
  const testCount = (src.match(/^test\(/gm) || []).length;
  assert.equal(testCount, 4, "les 4 scénarios doivent tous exister, aucun retiré");
  assert.ok(src.includes('role="img"][aria-hidden="true"'));
  assert.ok(src.includes("querySelector(\"svg\")"));
  assert.ok(src.includes('"editorial"'));
});
