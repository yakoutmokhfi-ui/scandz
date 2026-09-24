import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym — TRANSLATIONS MANAGEMENT v2 — EXCEL (mandat §11, §12, §13,
// §19.D, §19.E)
//
// L'aller-retour est RÉEL : le classeur produit par l'export est relu
// par `readXlsxWorkbook`, le lecteur d'import DE PRODUCTION (celui de
// l'import catalogue), jamais par un parseur d'essai.
//
// L'import est prouvé EN DEUX TEMPS : `buildTranslationImportPreview`
// est une fonction PURE qui ne peut structurellement rien écrire (elle
// ne reçoit aucun client, aucune RPC), et seules les lignes
// `applicable` sont candidates à l'écriture.
// ====================================================================

const {
  buildTranslationExport,
  buildTranslationExportRows,
  translationExportFileName,
  TRANSLATION_EXPORT_COLUMNS,
} = await import("../lib/translations-management/export.ts");
const {
  buildTranslationImportPreview,
  applicableImportRows,
  parseTranslationWorkbook,
  REQUIRED_IMPORT_COLUMNS,
} = await import("../lib/translations-management/import.ts");
const { buildTranslationRows } = await import("../lib/translations-management/rows.ts");
const { readXlsxWorkbook } = await import("../lib/catalogue-import/xlsx-reader.ts");

const H = {
  tomme: "h-tomme",
  crottin: "h-crottin",
  sub: "h-sub",
  intro: "h-intro",
  pickup: "h-pickup",
};

function product(over: Record<string, unknown> = {}) {
  return {
    product_id: "p-tomme",
    category_id: "c-fromages",
    category_name: "Fromages",
    category_translations: null,
    subcategory_id: null,
    subcategory_name: null,
    name: "Tomme de brebis",
    name_hash: H.tomme,
    short_description: null,
    short_description_hash: null,
    description: null,
    description_hash: null,
    translations: null,
    price: 12,
    is_available: true,
    archived_at: null,
    display_order: 1,
    is_option_source: false,
    image_url: null,
    tax_rate: null,
    unit_weight_grams: null,
    weight_is_approximate: false,
    reference_price_per_kg: null,
    ...over,
  };
}

/** Catalogue de référence : un produit direct, un produit SOUS
 *  SOUS-CATÉGORIE (couverture exigée), une sous-catégorie traduisible. */
function catalogue(productOverrides: Record<string, unknown> = {}) {
  return [
    {
      category_id: "c-fromages",
      category_name: "Fromages",
      category_name_hash: "h-cat",
      category_translations: null,
      category_display_order: 1,
      category_is_option_source: false,
      category_description: null,
      category_description_hash: null,
      category_is_active: true,
      products: [product(productOverrides)],
      subcategories: [
        {
          subcategory_id: "s-chevres",
          subcategory_name: "Chèvres",
          subcategory_display_order: 1,
          subcategory_is_active: true,
          subcategory_name_hash: H.sub,
          subcategory_translations: null,
          products: [
            product({
              product_id: "p-crottin",
              subcategory_id: "s-chevres",
              subcategory_name: "Chèvres",
              name: "جبن الماعز",
              name_hash: H.crottin,
              price: 6,
            }),
          ],
        },
      ],
    },
  ] as never;
}

function rows(productOverrides: Record<string, unknown> = {}) {
  return buildTranslationRows({
    restaurant: {
      restaurantId: "r-1",
      restaurantName: "Au lait cru",
      introText: "Fromagerie artisanale",
      introTextHash: H.intro,
      announcementText: null,
      announcementTextHash: null,
      translations: null,
    },
    categories: catalogue(productOverrides),
    methodNotices: [
      {
        modeCode: "pickup",
        modeLabel: "À emporter",
        customerText: "Retrait sous 2 h.",
        saleModeId: "sm-pickup",
        customerTextHash: H.pickup,
        translations: null,
      },
    ],
  });
}

// --------------------------------------------------------------------
// D. EXPORT
// --------------------------------------------------------------------

test("D — schéma d'export exact et déterministe (mandat §11)", () => {
  assert.deepEqual(
    [...TRANSLATION_EXPORT_COLUMNS],
    [
      "entity_type",
      "entity_id",
      "category",
      "subcategory",
      "field",
      "source_text",
      "source_hash",
      "target_language",
      "translation",
      "status",
    ]
  );
});

test("D — lignes complètes : identifiants STABLES, hash source, langue cible, statut", () => {
  const exported = buildTranslationExportRows(rows(), "en");
  const byId = new Map(exported.map((r) => [`${r[0]}:${r[1]}:${r[4]}`, r]));

  const tomme = byId.get("item:p-tomme:name")!;
  assert.deepEqual(tomme, [
    "item",
    "p-tomme",
    "Fromages",
    "",
    "name",
    "Tomme de brebis",
    H.tomme,
    "en",
    "",
    "missing",
  ]);

  // Produit SOUS SOUS-CATÉGORIE : présent, avec son contexte lisible.
  const crottin = byId.get("item:p-crottin:name")!;
  assert.equal(crottin[2], "Fromages");
  assert.equal(crottin[3], "Chèvres");

  // Sous-catégorie, texte d'établissement, message client : présents.
  assert.equal(byId.has("subcategory:s-chevres:name"), true);
  assert.equal(byId.has("restaurant:r-1:intro_text"), true);
  assert.equal(byId.has("customer_notice:sm-pickup:customer_text"), true);
});

test("D — statut exporté : reflète la traduction réellement stockée", () => {
  const exported = buildTranslationExportRows(
    rows({
      translations: {
        en: { name: "Sheep tomme", name_status: "validated", name_source_hash: H.tomme },
      },
    }),
    "en"
  );
  const tomme = exported.find((r) => r[1] === "p-tomme")!;
  assert.equal(tomme[8], "Sheep tomme");
  assert.equal(tomme[9], "validated");

  const stale = buildTranslationExportRows(
    rows({
      translations: {
        en: { name: "Sheep tomme", name_status: "validated", name_source_hash: "vieux-hash" },
      },
    }),
    "en"
  );
  assert.equal(stale.find((r) => r[1] === "p-tomme")![9], "stale");
});

test("D — aucun secret, aucune métadonnée d'autorisation dans l'export", () => {
  const flat = JSON.stringify(buildTranslationExportRows(rows(), "en")).toLowerCase();
  for (const forbidden of ["secret", "token", "role", "service_role", "auth", "password", "anon_key"]) {
    assert.equal(flat.includes(forbidden), false, `terme interdit exporté : ${forbidden}`);
  }
});

test("D — ALLER-RETOUR RÉEL : le classeur exporté est relu par le lecteur d'import de production (arabe inclus)", () => {
  const bytes = buildTranslationExport(rows(), "ar");
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const sheet = readXlsxWorkbook(ab);

  assert.deepEqual(sheet.rows[0], [...TRANSLATION_EXPORT_COLUMNS]);
  const crottin = sheet.rows.find((r) => r[1] === "p-crottin");
  assert.equal(crottin?.[5], "جبن الماعز", "le texte arabe survit à l'aller-retour XLSX");
  assert.equal(crottin?.[7], "ar");
  assert.equal(sheet.rows.some((r) => r[0] === "subcategory"), true);
  assert.equal(sheet.rows.some((r) => r[0] === "customer_notice"), true);
});

test("D — nom de fichier : portée et langue explicites", () => {
  const d = new Date("2026-09-23T10:00:00Z");
  assert.equal(translationExportFileName("complet", "en", d), "traductions-en-completes-2026-09-23.xlsx");
  assert.equal(translationExportFileName("filtre", "ar", d), "traductions-ar-resultats-2026-09-23.xlsx");
});

// --------------------------------------------------------------------
// E. IMPORT
// --------------------------------------------------------------------

const CONTEXT_BASE = {
  sourceLanguage: "fr",
  activeLanguages: ["fr", "en"],
  targetLanguage: "en",
};

function sheetFrom(rowsOut: (string | number | null)[][]) {
  return {
    header: [...TRANSLATION_EXPORT_COLUMNS],
    rows: rowsOut.map((r) => r.map((c) => String(c ?? ""))),
    rowNumbers: rowsOut.map((_, i) => i + 2),
  };
}

function line(over: Partial<Record<string, string>> = {}) {
  const base: Record<string, string> = {
    entity_type: "item",
    entity_id: "p-tomme",
    category: "Fromages",
    subcategory: "",
    field: "name",
    source_text: "Tomme de brebis",
    source_hash: H.tomme,
    target_language: "en",
    translation: "Sheep tomme",
    status: "to_review",
    ...over,
  };
  return TRANSLATION_EXPORT_COLUMNS.map((c) => base[c] ?? "");
}

test("E — PHASE 1 : l'aperçu est PUR -- il ne peut structurellement rien écrire", () => {
  const src = buildTranslationImportPreview.toString();
  for (const forbidden of ["supabase", "rpc(", "fetch(", "writeTranslation"]) {
    assert.equal(src.includes(forbidden), false, `l'aperçu ne doit pas référencer ${forbidden}`);
  }
  // v2.1 : `source_hash` est OBLIGATOIRE -- sans lui, aucune ligne ne
  // pourrait porter la précondition de concurrence jusqu'au serveur.
  assert.deepEqual(
    [...REQUIRED_IMPORT_COLUMNS],
    ["entity_type", "entity_id", "field", "source_hash", "target_language", "translation"]
  );
});

test("E — ligne valide : applicable, statut par défaut prudent (à relire)", () => {
  const preview = buildTranslationImportPreview(sheetFrom([line()]), {
    ...CONTEXT_BASE,
    rows: rows(),
  });
  assert.equal(preview.applicableRows, 1);
  assert.equal(preview.rows[0].verdict, "applicable");
  assert.equal(preview.rows[0].status, "to_review");
  assert.equal(preview.rows[0].label, "Tomme de brebis");

  const noStatus = buildTranslationImportPreview(sheetFrom([line({ status: "" })]), {
    ...CONTEXT_BASE,
    rows: rows(),
  });
  assert.equal(noStatus.rows[0].status, "to_review", "vide ne vaut JAMAIS `validated`");

  const validated = buildTranslationImportPreview(sheetFrom([line({ status: "validated" })]), {
    ...CONTEXT_BASE,
    rows: rows(),
  });
  assert.equal(validated.rows[0].status, "validated");
});

test("E — produit de SOUS-CATÉGORIE et sous-catégorie elle-même : importables", () => {
  const preview = buildTranslationImportPreview(
    sheetFrom([
      line({ entity_id: "p-crottin", source_hash: H.crottin, source_text: "جبن الماعز", subcategory: "Chèvres" }),
      line({ entity_type: "subcategory", entity_id: "s-chevres", source_hash: H.sub, translation: "Goat cheeses" }),
    ]),
    { ...CONTEXT_BASE, rows: rows() }
  );
  assert.equal(preview.applicableRows, 2);
});

test("E — identifiant inconnu et entité d'un AUTRE établissement : même refus (aucune fuite)", () => {
  const preview = buildTranslationImportPreview(
    sheetFrom([line({ entity_id: "p-inconnu" }), line({ entity_id: "p-du-voisin" })]),
    { ...CONTEXT_BASE, rows: rows() }
  );
  assert.equal(preview.counts.unknown_entity, 2);
  assert.equal(preview.applicableRows, 0);
  assert.equal(preview.rows.every((r) => r.label === null), true);
});

test("E — type d'entité et champ invalides refusés", () => {
  const preview = buildTranslationImportPreview(
    sheetFrom([
      line({ entity_type: "menu", entity_id: "x" }),
      line({ field: "price" }),
      line({ entity_type: "subcategory", entity_id: "s-chevres", field: "description" }),
    ]),
    { ...CONTEXT_BASE, rows: rows() }
  );
  assert.equal(preview.counts.unsupported_entity_type, 1);
  assert.equal(preview.counts.invalid_field, 2);
  assert.equal(preview.applicableRows, 0);
});

test("E — langue source refusée, langue inactive ou différente de la cible refusée", () => {
  const preview = buildTranslationImportPreview(
    sheetFrom([
      line({ target_language: "fr" }),
      line({ target_language: "de" }),
      line({ target_language: "ar" }),
    ]),
    { ...CONTEXT_BASE, rows: rows() }
  );
  assert.equal(preview.counts.source_language, 1);
  assert.equal(preview.counts.wrong_language, 2);
  assert.equal(preview.applicableRows, 0);
});

test("E — doublons : la première ligne passe, les suivantes sont signalées", () => {
  const preview = buildTranslationImportPreview(sheetFrom([line(), line(), line()]), {
    ...CONTEXT_BASE,
    rows: rows(),
  });
  assert.equal(preview.applicableRows, 1);
  assert.equal(preview.counts.duplicate, 2);
  assert.deepEqual(preview.rows.map((r) => r.verdict), ["applicable", "duplicate", "duplicate"]);
});

test("E — hash source PÉRIMÉ : jamais écrit, classé conflit (mandat §13)", () => {
  const preview = buildTranslationImportPreview(
    sheetFrom([line({ source_hash: "hash-de-l-export-precedent", status: "validated" })]),
    { ...CONTEXT_BASE, rows: rows() }
  );
  assert.equal(preview.counts.stale_source, 1);
  assert.equal(preview.applicableRows, 0);
  assert.equal(applicableImportRows(preview).length, 0);
});

test("E — traduction vide et statut invalide refusés", () => {
  const preview = buildTranslationImportPreview(
    sheetFrom([line({ translation: "" }), line({ status: "publie" })]),
    { ...CONTEXT_BASE, rows: rows() }
  );
  assert.equal(preview.counts.empty_translation, 1);
  assert.equal(preview.counts.invalid_status, 1);
  assert.equal(preview.applicableRows, 0);

  // Les statuts DÉRIVÉS écrits par notre propre export (missing/stale)
  // valent « à relire » -- un fichier exporté puis complété doit se
  // réimporter sans piège, mais ne peut jamais VALIDER implicitement.
  for (const derived of ["missing", "stale", "to_review"]) {
    const tolerated = buildTranslationImportPreview(sheetFrom([line({ status: derived })]), {
      ...CONTEXT_BASE,
      rows: rows(),
    });
    assert.equal(tolerated.applicableRows, 1, `statut ${derived} attendu toléré`);
    assert.equal(tolerated.rows[0].status, "to_review");
  }
});

test("E — écrasement d'une traduction VALIDÉE : refusé par défaut, visible, et seulement sur consentement explicite", () => {
  const withValidated = rows({
    translations: {
      en: { name: "Sheep tomme", name_status: "validated", name_source_hash: H.tomme },
    },
  });

  const refused = buildTranslationImportPreview(
    sheetFrom([line({ translation: "Ewe tomme" })]),
    { ...CONTEXT_BASE, rows: withValidated }
  );
  assert.equal(refused.counts.overwrites_validated, 1);
  assert.equal(refused.applicableRows, 0, "jamais d'écrasement silencieux");

  const allowed = buildTranslationImportPreview(
    sheetFrom([line({ translation: "Ewe tomme" })]),
    { ...CONTEXT_BASE, rows: withValidated, allowOverwriteValidated: true }
  );
  assert.equal(allowed.applicableRows, 1, "écrasement possible UNIQUEMENT après consentement explicite");

  // Une ligne IDENTIQUE à la traduction validée n'est pas un écrasement.
  const identical = buildTranslationImportPreview(
    sheetFrom([line({ translation: "Sheep tomme" })]),
    { ...CONTEXT_BASE, rows: withValidated }
  );
  assert.equal(identical.applicableRows, 1);
});

test("E — fichier sans les colonnes obligatoires : refus de STRUCTURE, aucune ligne applicable", () => {
  const preview = buildTranslationImportPreview(
    { header: ["nom", "traduction"], rows: [["Tomme", "Sheep tomme"]], rowNumbers: [2] },
    { ...CONTEXT_BASE, rows: rows() }
  );
  assert.equal(preview.fileError !== null, true);
  assert.equal(preview.applicableRows, 0);
  assert.equal(preview.rows.length, 0);
});

test("E — numéros de ligne Excel conservés (le commerçant retrouve la ligne fautive)", () => {
  const preview = buildTranslationImportPreview(sheetFrom([line(), line({ entity_id: "p-inconnu" })]), {
    ...CONTEXT_BASE,
    rows: rows(),
  });
  assert.deepEqual(preview.rows.map((r) => r.excelRow), [2, 3]);
});

test("E — ALLER-RETOUR COMPLET : exporter, remplir, réimporter", () => {
  const bytes = buildTranslationExport(rows(), "en");
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const parsed = parseTranslationWorkbook(ab);

  // Le commerçant remplit la colonne `translation` de chaque ligne.
  const translationIdx = parsed.header.indexOf("translation");
  const filled = parsed.rows.map((r) => {
    const copy = [...r];
    copy[translationIdx] = "Traduit";
    return copy;
  });

  const preview = buildTranslationImportPreview(
    { header: parsed.header, rows: filled, rowNumbers: parsed.rowNumbers },
    { ...CONTEXT_BASE, rows: rows() }
  );
  assert.equal(preview.fileError, null);
  assert.equal(preview.applicableRows, preview.totalRows);
  assert.equal(preview.totalRows > 4, true, "toutes les entités du fichier sont réimportables");
});
