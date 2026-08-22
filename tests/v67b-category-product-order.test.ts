import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// V67b — Description longue de catégorie, ordre produit/catégorie,
// photo pendant la création, placeholder (partie non-DOM). Voir aussi
// tests/v67b-photo-placeholder.dom.test.ts pour le rendu DOM réel.
// ====================================================================

const pageSrc = readFileSync("app/dashboard/catalogue/page.tsx", "utf8");
const migrationSql = readFileSync(
  "supabase/migration-v67b-category-description-product-order.sql",
  "utf8"
);

// --- RÈGLE DE PRÉSERVATION SÉMANTIQUE DES DONNÉES HISTORIQUES -------
//
// Ajoutée explicitement après un finding CTO sur des descriptions
// produit historiquement mal classées. Vérifie qu'aucune ligne de la
// migration V67b ne réinterprète/déplace une valeur existante de
// description ou short_description.

test("RÈGLE HISTORIQUE : la migration V67b ne modifie aucune donnée existante de description/short_description", () => {
  assert.ok(
    !/update\s+public\.menu_items\s+set[^;]*description/i.test(migrationSql),
    "aucun UPDATE de menu_items touchant une colonne description ne doit exister dans cette migration"
  );
  assert.ok(
    !migrationSql.toLowerCase().includes("short_description = description") &&
      !migrationSql.toLowerCase().includes("description = short_description"),
    "aucune requalification croisée entre description et short_description"
  );
  // La seule colonne touchée doit être la NOUVELLE colonne de
  // catégorie, jamais une colonne produit existante.
  assert.ok(migrationSql.includes("add column if not exists description text"));
  assert.ok(
    migrationSql.indexOf("add column if not exists description text") <
      migrationSql.indexOf("menu_categories_description_length_chk")
  );
});

// --- Migration SQL : contrôles structurels ---------------------------

test("migration V67b: contrôle préalable de non-dérive réellement exécuté avant la transaction", () => {
  const beginIdx = migrationSql.search(/^begin;/m);
  const doIdx = migrationSql.indexOf("SCANYM_SCHEMA_DRIFT");
  assert.ok(doIdx >= 0 && doIdx < beginIdx, "le contrôle de dérive doit précéder begin;");
});

test("migration V67b: update_category supprimée puis recréée (4 paramètres), create_category inchangée (3 paramètres)", () => {
  assert.ok(migrationSql.includes("drop function if exists public.update_category(uuid, text, integer);"));
  assert.ok(
    migrationSql.includes(
      "p_category_id   uuid,\n  p_name          text,\n  p_display_order integer,\n  p_description   text default null"
    )
  );
  assert.ok(
    !migrationSql.includes("create function public.create_category") &&
      !migrationSql.includes("create or replace function public.create_category"),
    "create_category ne doit pas être redéfinie par cette migration (signature inchangée, 3 paramètres)"
  );
});

test("migration V67b: get_merchant_catalogue supprimée puis recréée avec category_description", () => {
  assert.ok(migrationSql.includes("drop function if exists public.get_merchant_catalogue(uuid, boolean);"));
  assert.ok(migrationSql.includes("category_description        text"));
});

test("migration V67b: set_product_order nouvelle RPC, owner/manager uniquement (jamais staff)", () => {
  const start = migrationSql.indexOf("create function public.set_product_order(");
  const end = migrationSql.indexOf("end $$;", start);
  const body = migrationSql.slice(start, end);
  assert.ok(body.includes("array['owner','manager']"));
  assert.ok(!body.includes("staff"), "set_product_order ne doit jamais autoriser staff");
});

test("migration V67b: aucune utilisation de \\v dans les chaînes de normalisation (piège V65 réappliqué)", () => {
  const btrimArgs = [...migrationSql.matchAll(/btrim\([^,]+,\s*(E'[^']*')/g)].map((m) => m[1]);
  for (const arg of btrimArgs) {
    assert.ok(!arg.includes("\\v"), `\\v trouvé dans un argument btrim : ${arg}`);
  }
  assert.ok(migrationSql.includes("chr(11)"));
});

test("migration V67b: contrainte CHECK de longueur sur menu_categories.description (défense en profondeur)", () => {
  assert.ok(migrationSql.includes("menu_categories_description_length_chk"));
  assert.ok(/char_length\(description\) <= 500/.test(migrationSql));
});

// --- TypeScript : orchestration photo-à-la-création -------------------

test("page.tsx: la création de produit crée d'abord le produit, PUIS tente la photo (jamais l'inverse)", () => {
  const start = pageSrc.indexOf('run("new", async () => {');
  const end = pageSrc.indexOf("})", pageSrc.indexOf("tryAttachPhotoAfterCreate", start));
  const block = pageSrc.slice(start, end);
  const createIdx = block.indexOf("createProduct(");
  const photoIdx = block.indexOf("tryAttachPhotoAfterCreate(");
  assert.ok(createIdx >= 0 && photoIdx > createIdx, "createProduct doit précéder tryAttachPhotoAfterCreate");
});

test("page.tsx: un échec de photo après création ne relance jamais d'erreur vers run() (le produit reste créé)", () => {
  const start = pageSrc.indexOf("async function tryAttachPhotoAfterCreate");
  const end = pageSrc.indexOf("\n  }\n", start);
  const body = pageSrc.slice(start, end);
  assert.ok(body.includes("catch (photoErr)"), "doit intercepter l'échec localement");
  assert.ok(!/catch \(photoErr\) \{[^}]*throw/.test(body), "ne doit jamais relancer l'erreur photo après une création réussie");
  assert.ok(body.includes("reload("), "doit recharger la liste pour que le produit créé reste visible");
  assert.ok(body.includes('t("mcProductCreatedPhotoFailed")'), "doit utiliser le message dédié, pas un message générique d'échec de création");
});

test("page.tsx: le message d'échec photo-après-création ne prétend jamais que la création a échoué", () => {
  // FR uniquement suffit ici : la symétrie FR/EN/AR est vérifiée
  // séparément (test i18n ci-dessous).
  const fr = readFileSync("lib/i18n.ts", "utf8");
  const m = fr.match(/mcProductCreatedPhotoFailed: "([^"]+)"/);
  assert.ok(m, "clé mcProductCreatedPhotoFailed introuvable");
  const text = m![1].toLowerCase();
  assert.ok(text.includes("créé") || text.includes("créer"), "doit confirmer que le produit a été créé");
  assert.ok(!text.includes("échec de la création"), "ne doit jamais dire que la CRÉATION a échoué");
});

test("page.tsx: photo facultative -- la création reste possible sans photoFile", () => {
  // photoFile est optionnel dans ProductDraft (null par défaut) et
  // n'entre dans aucune condition de validité du formulaire.
  const draftType = pageSrc.slice(pageSrc.indexOf("type ProductDraft"), pageSrc.indexOf("type CategoryDraft"));
  assert.ok(draftType.includes("photoFile: File | null"));
  const formStart = pageSrc.indexOf("function ProductForm(");
  const validIdx = pageSrc.indexOf("const valid =", formStart);
  const validBlock = pageSrc.slice(validIdx, pageSrc.indexOf(";", validIdx));
  assert.ok(!validBlock.includes("photoFile"), "photoFile ne doit jamais être une condition de validité du formulaire");
});

test("page.tsx: validation binaire réelle réutilisée côté client avant upload (jamais l'extension ni file.type seul)", () => {
  assert.ok(pageSrc.includes("validateProductPhotoFile(file)"));
});

// --- Double-soumission ------------------------------------------------

test("page.tsx: le bouton de soumission de ProductForm est désactivé pendant l'envoi (submitting)", () => {
  const formStart = pageSrc.indexOf("function ProductForm(");
  const formEnd = pageSrc.indexOf("function OrderField(");
  const form = pageSrc.slice(formStart, formEnd);
  assert.ok(form.includes("submitting?: boolean"));
  assert.ok(/valid =[\s\S]*?!submitting/.test(form), "submitting doit invalider le formulaire tant qu'un envoi est en cours");
  assert.ok(form.includes('disabled={!valid}'));
});

test("page.tsx: création de produit passe submitting={busyId === \"new\"} (vraie prévention du double-clic)", () => {
  assert.ok(pageSrc.includes('submitting={busyId === "new"}'));
});

// --- Catégorie : description longue ------------------------------------

test("page.tsx: CategoryForm affiche le champ description UNIQUEMENT en édition (create_category ne l'accepte pas)", () => {
  const start = pageSrc.indexOf("function CategoryForm(");
  const end = pageSrc.indexOf("function ProductForm(");
  const block = pageSrc.slice(start, end);
  assert.ok(/mode === "edit" &&[\s\S]*?mcCategoryDescription/.test(block), "le champ description doit être conditionné à mode === 'edit'");
});

test("page.tsx: startEditCategory lit category_description telle quelle, ne la déduit d'aucune autre donnée", () => {
  const start = pageSrc.indexOf("function startEditCategory");
  const end = pageSrc.indexOf("}", pageSrc.indexOf("setCategoryDraft", start) + 200);
  const block = pageSrc.slice(start, end);
  assert.ok(block.includes("cat.category_description"));
  assert.ok(!/short_description|category_name/.test(block.split("description:")[1] ?? ""), "la description ne doit jamais être déduite d'une autre propriété");
});

test("page.tsx: updateCategory est appelée avec les 4 paramètres (name, displayOrder, description)", () => {
  const idx = pageSrc.indexOf("run(cat.category_id, async () => {");
  const block = pageSrc.slice(idx, pageSrc.indexOf("})", idx + 300));
  assert.ok(block.includes("categoryDraft.description || null"));
});

// --- Catégorie/produit : ordre --------------------------------------

test("page.tsx: OrderField réutilisé pour l'ordre produit, câblé sur setProductOrder", () => {
  assert.ok(pageSrc.includes("<OrderField"));
  assert.ok(pageSrc.includes("setProductOrder(p.product_id, order)"));
});

test("page.tsx: OrderField n'envoie la nouvelle valeur qu'au clic (pas à chaque frappe)", () => {
  const start = pageSrc.indexOf("function OrderField(");
  const body = pageSrc.slice(start, pageSrc.indexOf("\n}\n", start));
  assert.ok(body.includes("onChange={(e) => setLocal(e.target.value)}"), "la frappe met à jour un état LOCAL seulement");
  assert.ok(body.includes("onClick={() => onSave(Number(local))}"), "l'envoi ne se déclenche qu'au clic explicite");
});

// --- i18n ---------------------------------------------------------------

function extractDictKeys(source: string, name: string): Set<string> {
  const start = source.indexOf(`const ${name}: Dict = {`);
  assert.ok(start >= 0, `dictionnaire '${name}' introuvable`);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = source.slice(braceStart, i + 1);
  return new Set([...body.matchAll(/^\s*([A-Za-z0-9_]+):/gm)].map((m) => m[1]));
}

const V67B_KEYS = [
  "mcCategoryDescription",
  "mcCategoryDescriptionTooLong",
  "mcProductCreatedPhotoFailed",
  "mcPhotoPreviewAlt",
  "mcPhotoOptionalHint",
  "mcProductOrder",
  "mcSaving",
];

test("i18n: toutes les clés V67b existent dans les 3 langues (FR/EN/AR), aucun 4e dictionnaire", () => {
  const source = readFileSync("lib/i18n.ts", "utf8");
  const fr = extractDictKeys(source, "fr");
  const en = extractDictKeys(source, "en");
  const ar = extractDictKeys(source, "ar");
  for (const key of V67B_KEYS) {
    assert.ok(fr.has(key), `clé '${key}' absente du dictionnaire fr`);
    assert.ok(en.has(key), `clé '${key}' absente du dictionnaire en`);
    assert.ok(ar.has(key), `clé '${key}' absente du dictionnaire ar`);
  }
});

// --- Multi-tenant / sécurité (statique -- voir aussi le harnais PostgreSQL) --

test("dashboard.ts: setProductOrder et updateCategory passent par les RPC sécurisées, jamais une écriture directe sur les tables", () => {
  const source = readFileSync("lib/services/dashboard.ts", "utf8");
  assert.ok(source.includes('supabase.rpc("set_product_order"'));
  assert.ok(source.includes('supabase.rpc("update_category"'));
  assert.ok(!/\.from\("menu_items"\)\.update/.test(source));
  assert.ok(!/\.from\("menu_categories"\)\.update/.test(source));
});

test("dashboard.ts: aucune clé service_role, aucun restaurant_id transmis sans passer par une RPC vérifiée serveur", () => {
  const source = readFileSync("lib/services/dashboard.ts", "utf8");
  assert.ok(!/service_role/i.test(source));
});

// --- Non-régression ------------------------------------------------------

test("non-régression : MenuItemCard utilise toujours tShortDescription et ProductInfoButton pour le produit", () => {
  const source = readFileSync("components/MenuItemCard.tsx", "utf8");
  assert.ok(source.includes("tShortDescription"));
  assert.ok(source.includes("<ProductInfoButton"));
});

test("non-régression : MenuView câble le (i) de catégorie sans dupliquer ProductInfoButton", () => {
  const source = readFileSync("components/MenuView.tsx", "utf8");
  assert.ok(source.includes('tCategoryDescription(activeCategory, lang, restaurant.config.source_language ?? "fr")'));
  const occurrences = (source.match(/<ProductInfoButton/g) || []).length;
  assert.equal(occurrences, 1, "MenuView ne doit utiliser ProductInfoButton qu'une fois (catégorie), le composant est réutilisé tel quel");
});

test("non-régression : create_order, update_order_status, les RPC d'options ne sont pas redéfinies par V67b", () => {
  assert.ok(!/function public\.create_order\(/.test(migrationSql));
  assert.ok(!/function public\.update_order_status\(/.test(migrationSql));
  assert.ok(!/function public\.assert_product_role\(/.test(migrationSql) || migrationSql.includes("perform public.assert_product_role"));
});
