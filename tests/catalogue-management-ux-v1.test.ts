import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — CATALOGUE MANAGEMENT UX v1 — logique PURE.
//
// Recherche / filtres / tri / export, éprouvés sur un catalogue
// réaliste de 312 produits (mandat §13), plus un ALLER-RETOUR RÉEL
// export -> lecteur d'import de production (mandat §12) : le classeur
// produit par l'export est relu par `readXlsxWorkbook` lui-même,
// jamais par un parseur de test.
//
// Le comportement d'ÉCRAN (libellés, tags, compteur, réinitialisation,
// boutons d'export) est prouvé séparément par
// tests/catalogue-management-ux-v1.dom.test.ts.
// ====================================================================

const {
  flattenCatalogue,
  applyCatalogueFilters,
  sortProducts,
  availableFilterOptions,
  normalizeForSearch,
  matchesSearch,
  isDefaultFilters,
  EMPTY_FILTERS,
  DEFAULT_SORT,
} = await import("../lib/catalogue-management/filtering.ts");

const {
  buildExportRows,
  buildCatalogueExport,
  buildCatalogueXlsx,
  catalogueExportFileName,
  EXPORT_COLUMNS,
  EXPORT_EXTRA_COLUMNS,
} = await import("../lib/catalogue-management/export.ts");

const { IMPORT_COLUMNS } = await import("../lib/catalogue-import/column-mapping.ts");
const { readXlsxWorkbook } = await import("../lib/catalogue-import/xlsx-reader.ts");

// ------------------------------------------------------------------
// Fabriques
// ------------------------------------------------------------------

function product(over: Record<string, unknown> = {}) {
  return {
    product_id: "p1",
    category_id: "c1",
    category_name: "Fromages",
    category_translations: null,
    subcategory_id: null,
    subcategory_name: null,
    name: "Tomme de brebis",
    name_hash: "h",
    short_description: null,
    short_description_hash: null,
    description: null,
    description_hash: null,
    translations: null,
    price: 9.9,
    is_available: true,
    archived_at: null,
    display_order: 1,
    is_option_source: false,
    image_url: null,
    tax_rate: 5.5,
    unit_weight_grams: 200,
    weight_is_approximate: false,
    reference_price_per_kg: 49.5,
    ...over,
  } as any;
}

function category(over: Record<string, unknown> = {}) {
  return {
    category_id: "c1",
    category_name: "Fromages",
    category_name_hash: "h",
    category_translations: null,
    category_display_order: 1,
    category_is_option_source: false,
    category_description: null,
    category_description_hash: null,
    category_is_active: true,
    products: [],
    subcategories: [],
    ...over,
  } as any;
}

/** Catalogue réaliste : 312 produits, 4 catégories, sous-catégories,
 *  plusieurs taux de TVA, tags variés (mandat §13). */
function largeCatalogue() {
  const catNames = ["Fromages", "Charcuterie", "Vins", "Épicerie"];
  const subByCat: Record<string, string[]> = {
    Fromages: ["Pâtes dures", "Pâtes molles"],
    Charcuterie: ["Sèche"],
    Vins: [],
    Épicerie: ["Conserves"],
  };
  const vats = [5.5, 10, 20];
  const cats: any[] = [];
  const tagsByProductId = new Map<string, { tagIds: string[]; tagNames: string[] }>();

  let n = 0;
  catNames.forEach((cname, ci) => {
    const subs = subByCat[cname].map((sname, si) => ({
      subcategory_id: `s${ci}-${si}`,
      subcategory_name: sname,
      subcategory_display_order: si + 1,
      subcategory_is_active: true,
      products: [] as any[],
    }));
    const direct: any[] = [];

    for (let i = 0; i < 78; i++) {
      n++;
      const id = `p${n}`;
      const p = product({
        product_id: id,
        category_id: `c${ci}`,
        category_name: cname,
        name: `${cname} ${String(i + 1).padStart(3, "0")}`,
        price: 1 + ((n * 7) % 400) / 10,
        tax_rate: vats[n % 3],
        is_available: n % 11 !== 0,
        unit_weight_grams: 100 + (n % 5) * 50,
      });
      if (n % 3 === 0) {
        tagsByProductId.set(id, { tagIds: ["t-bio"], tagNames: ["Bio"] });
      } else if (n % 7 === 0) {
        tagsByProductId.set(id, { tagIds: ["t-bio", "t-aop"], tagNames: ["Bio", "AOP"] });
      }
      if (subs.length > 0 && i % 2 === 0) {
        const s = subs[i % subs.length];
        p.subcategory_id = s.subcategory_id;
        p.subcategory_name = s.subcategory_name;
        s.products.push(p);
      } else {
        direct.push(p);
      }
    }
    cats.push(category({ category_id: `c${ci}`, category_name: cname, products: direct, subcategories: subs }));
  });

  return { cats, tagsByProductId, total: n };
}

// ==================================================================
// C. Recherche
// ==================================================================

test("[C] recherche EXACTE du nom d'un produit", () => {
  const flat = flattenCatalogue([category({ products: [product({ name: "Tomme de brebis" }), product({ product_id: "p2", name: "Comté" })] })]);
  const out = applyCatalogueFilters(flat, { ...EMPTY_FILTERS, search: "Tomme de brebis" });
  assert.deepEqual(out.map((f) => f.product.name), ["Tomme de brebis"]);
});

test("[C] recherche PARTIELLE et INSENSIBLE À LA CASSE", () => {
  const flat = flattenCatalogue([category({ products: [product({ name: "Tomme de brebis" }), product({ product_id: "p2", name: "Comté" })] })]);
  for (const q of ["tomme", "TOMME", "BrEbIs", "de bre"]) {
    assert.deepEqual(
      applyCatalogueFilters(flat, { ...EMPTY_FILTERS, search: q }).map((f) => f.product.name),
      ["Tomme de brebis"],
      `requête « ${q} »`
    );
  }
});

test("[C] la recherche tolère les espaces de bordure, les espaces multiples et l'espace insécable (copier-coller depuis un tableur)", () => {
  const flat = flattenCatalogue([category({ products: [product({ name: "Tomme de brebis" })] })]);
  for (const q of ["  tomme  ", "tomme   de    brebis", "tomme de brebis"]) {
    assert.equal(applyCatalogueFilters(flat, { ...EMPTY_FILTERS, search: q }).length, 1, `requête « ${q} »`);
  }
});

test("[C] la recherche N'ENLÈVE PAS les accents -- « Cafe » ne trouve pas « Café », exactement comme la normalisation du catalogue partout ailleurs", () => {
  const flat = flattenCatalogue([category({ products: [product({ name: "Café" })] })]);
  assert.equal(applyCatalogueFilters(flat, { ...EMPTY_FILTERS, search: "Cafe" }).length, 0);
  assert.equal(applyCatalogueFilters(flat, { ...EMPTY_FILTERS, search: "café" }).length, 1);
});

test("[C] la recherche porte aussi sur la catégorie, la sous-catégorie et les tags (données déjà chargées, aucun appel supplémentaire)", () => {
  const sub = { subcategory_id: "s1", subcategory_name: "Pâtes dures", subcategory_display_order: 1, subcategory_is_active: true, products: [product({ product_id: "p1", name: "Abondance" })] };
  const flat = flattenCatalogue(
    [category({ products: [], subcategories: [sub] })],
    new Map([["p1", { tagIds: ["t1"], tagNames: ["Lait cru"] }]])
  );
  assert.equal(applyCatalogueFilters(flat, { ...EMPTY_FILTERS, search: "Fromages" }).length, 1, "par catégorie");
  assert.equal(applyCatalogueFilters(flat, { ...EMPTY_FILTERS, search: "pâtes dures" }).length, 1, "par sous-catégorie");
  assert.equal(applyCatalogueFilters(flat, { ...EMPTY_FILTERS, search: "lait cru" }).length, 1, "par tag");
});

test("[C] la recherche n'interroge PAS les descriptions -- sinon un mot courant noierait le résultat", () => {
  const flat = flattenCatalogue([
    category({ products: [product({ name: "Comté", description: "un fromage de montagne artisanal" })] }),
  ]);
  assert.equal(applyCatalogueFilters(flat, { ...EMPTY_FILTERS, search: "montagne" }).length, 0);
});

test("[C] état SANS RÉSULTAT : une recherche sans correspondance retourne une liste vide, jamais le catalogue entier", () => {
  const flat = flattenCatalogue([category({ products: [product({ name: "Comté" })] })]);
  assert.deepEqual(applyCatalogueFilters(flat, { ...EMPTY_FILTERS, search: "zzzz" }), []);
});

test("[C] recherche + filtre se COMBINENT en ET", () => {
  const flat = flattenCatalogue([
    category({ category_id: "c1", category_name: "Fromages", products: [product({ product_id: "p1", name: "Bio Comté", category_id: "c1" })] }),
    category({ category_id: "c2", category_name: "Vins", products: [product({ product_id: "p2", name: "Bio Rouge", category_id: "c2", category_name: "Vins" })] }),
  ]);
  const out = applyCatalogueFilters(flat, { ...EMPTY_FILTERS, search: "bio", categoryId: "c2" });
  assert.deepEqual(out.map((f) => f.product.name), ["Bio Rouge"]);
});

test("normalizeForSearch / matchesSearch : une requête vide ne filtre rien", () => {
  assert.equal(normalizeForSearch("  A  B  "), "a b");
  const flat = flattenCatalogue([category({ products: [product()] })]);
  assert.equal(matchesSearch(flat[0], ""), true);
  assert.equal(matchesSearch(flat[0], "   "), true);
});

// ==================================================================
// D. Filtres
// ==================================================================

test("[D] filtre par CATÉGORIE", () => {
  const flat = flattenCatalogue([
    category({ category_id: "c1", products: [product({ product_id: "p1", category_id: "c1" })] }),
    category({ category_id: "c2", category_name: "Vins", products: [product({ product_id: "p2", category_id: "c2", category_name: "Vins" })] }),
  ]);
  assert.deepEqual(applyCatalogueFilters(flat, { ...EMPTY_FILTERS, categoryId: "c2" }).map((f) => f.product.product_id), ["p2"]);
});

test("[D] filtre par SOUS-CATÉGORIE", () => {
  const sub = { subcategory_id: "s1", subcategory_name: "Pâtes dures", subcategory_display_order: 1, subcategory_is_active: true, products: [product({ product_id: "p2" })] };
  const flat = flattenCatalogue([category({ products: [product({ product_id: "p1" })], subcategories: [sub] })]);
  assert.deepEqual(applyCatalogueFilters(flat, { ...EMPTY_FILTERS, subcategoryId: "s1" }).map((f) => f.product.product_id), ["p2"]);
});

test("[D] filtre par TAG", () => {
  const flat = flattenCatalogue(
    [category({ products: [product({ product_id: "p1" }), product({ product_id: "p2", name: "Comté" })] })],
    new Map([["p2", { tagIds: ["t-bio"], tagNames: ["Bio"] }]])
  );
  assert.deepEqual(applyCatalogueFilters(flat, { ...EMPTY_FILTERS, tagId: "t-bio" }).map((f) => f.product.product_id), ["p2"]);
});

test("[D] filtre par DISPONIBILITÉ, dans les deux sens", () => {
  const flat = flattenCatalogue([
    category({ products: [product({ product_id: "p1", is_available: true }), product({ product_id: "p2", name: "Comté", is_available: false })] }),
  ]);
  assert.deepEqual(applyCatalogueFilters(flat, { ...EMPTY_FILTERS, available: true }).map((f) => f.product.product_id), ["p1"]);
  assert.deepEqual(applyCatalogueFilters(flat, { ...EMPTY_FILTERS, available: false }).map((f) => f.product.product_id), ["p2"]);
  assert.equal(applyCatalogueFilters(flat, { ...EMPTY_FILTERS, available: null }).length, 2, "null = indifférent");
});

test("[D] plusieurs filtres COMBINÉS s'appliquent en ET -- l'exemple exact du mandat", () => {
  const sub = { subcategory_id: "s-raclette", subcategory_name: "Raclette", subcategory_display_order: 1, subcategory_is_active: true, products: [
    product({ product_id: "ok", name: "Raclette bleue", is_available: true }),
    product({ product_id: "ko-indispo", name: "Raclette grise", is_available: false }),
  ] };
  const flat = flattenCatalogue(
    [category({ category_id: "c-fromages", category_name: "Fromages", subcategories: [sub] })],
    new Map([
      ["ok", { tagIds: ["t-bleu"], tagNames: ["Bleu"] }],
      ["ko-indispo", { tagIds: ["t-bleu"], tagNames: ["Bleu"] }],
    ])
  );
  const out = applyCatalogueFilters(flat, {
    ...EMPTY_FILTERS,
    categoryId: "c-fromages",
    subcategoryId: "s-raclette",
    tagId: "t-bleu",
    available: true,
  });
  assert.deepEqual(out.map((f) => f.product.product_id), ["ok"]);
});

test("[D] RÉINITIALISATION : les filtres par défaut rendent l'intégralité du catalogue, et isDefaultFilters les reconnaît", () => {
  const { cats, tagsByProductId, total } = largeCatalogue();
  const flat = flattenCatalogue(cats, tagsByProductId);
  assert.equal(applyCatalogueFilters(flat, EMPTY_FILTERS).length, total);
  assert.equal(isDefaultFilters(EMPTY_FILTERS), true);
  assert.equal(isDefaultFilters({ ...EMPTY_FILTERS, search: "x" }), false);
  assert.equal(isDefaultFilters({ ...EMPTY_FILTERS, tagId: "t" }), false);
  assert.equal(isDefaultFilters({ ...EMPTY_FILTERS, sort: "price-desc" }), false);
  assert.equal(isDefaultFilters({ ...EMPTY_FILTERS, search: "   " }), true, "une recherche blanche n'est pas un filtre actif");
});

test("[D] les options de filtre sont DÉRIVÉES des données chargées -- jamais une option sans produit correspondant", () => {
  const { cats, tagsByProductId } = largeCatalogue();
  const flat = flattenCatalogue(cats, tagsByProductId);
  const opts = availableFilterOptions(flat);
  assert.deepEqual(opts.categories.map((c) => c.name), ["Charcuterie", "Épicerie", "Fromages", "Vins"]);
  assert.deepEqual(opts.tags.map((t) => t.name), ["AOP", "Bio"]);
  for (const c of opts.categories) {
    assert.ok(applyCatalogueFilters(flat, { ...EMPTY_FILTERS, categoryId: c.id }).length > 0, `catégorie ${c.name} sans produit`);
  }
  for (const t of opts.tags) {
    assert.ok(applyCatalogueFilters(flat, { ...EMPTY_FILTERS, tagId: t.id }).length > 0, `tag ${t.name} sans produit`);
  }
});

// ==================================================================
// E. Tri
// ==================================================================

test("[E] tri A→Z et Z→A sur le nom", () => {
  const flat = flattenCatalogue([
    category({ products: [product({ product_id: "b", name: "Brie" }), product({ product_id: "a", name: "Abondance" }), product({ product_id: "c", name: "Comté" })] }),
  ]);
  assert.deepEqual(sortProducts(flat, "name-asc").map((f) => f.product.name), ["Abondance", "Brie", "Comté"]);
  assert.deepEqual(sortProducts(flat, "name-desc").map((f) => f.product.name), ["Comté", "Brie", "Abondance"]);
});

test("[E] tri par prix croissant et décroissant", () => {
  const flat = flattenCatalogue([
    category({ products: [product({ product_id: "a", name: "A", price: 12 }), product({ product_id: "b", name: "B", price: 3.5 }), product({ product_id: "c", name: "C", price: 7 })] }),
  ]);
  assert.deepEqual(sortProducts(flat, "price-asc").map((f) => f.product.price), [3.5, 7, 12]);
  assert.deepEqual(sortProducts(flat, "price-desc").map((f) => f.product.price), [12, 7, 3.5]);
});

test("[E] à prix ÉGAL le nom départage -- le tri est stable, basculer croissant/décroissant puis revenir redonne la même liste", () => {
  const flat = flattenCatalogue([
    category({ products: [product({ product_id: "z", name: "Zeta", price: 5 }), product({ product_id: "a", name: "Alpha", price: 5 })] }),
  ]);
  assert.deepEqual(sortProducts(flat, "price-asc").map((f) => f.product.name), ["Alpha", "Zeta"]);
  const aller = sortProducts(flat, "price-asc").map((f) => f.product.product_id);
  sortProducts(flat, "price-desc");
  assert.deepEqual(sortProducts(flat, "price-asc").map((f) => f.product.product_id), aller);
});

test("[E] le tri ne MUTE JAMAIS la liste reçue", () => {
  const flat = flattenCatalogue([
    category({ products: [product({ product_id: "b", name: "Brie" }), product({ product_id: "a", name: "Abondance" })] }),
  ]);
  const avant = flat.map((f) => f.product.product_id);
  sortProducts(flat, "name-asc");
  sortProducts(flat, "price-desc");
  assert.deepEqual(flat.map((f) => f.product.product_id), avant, "la liste source est intacte");
});

// ==================================================================
// F. Export
// ==================================================================

test("[F] les 11 premières colonnes d'export sont EXACTEMENT celles de l'import, dans le même ordre (réutilisées, jamais recopiées)", () => {
  assert.deepEqual(EXPORT_COLUMNS.slice(0, IMPORT_COLUMNS.length), [...IMPORT_COLUMNS]);
  assert.deepEqual(EXPORT_COLUMNS.slice(IMPORT_COLUMNS.length), [...EXPORT_EXTRA_COLUMNS]);
});

test("[F] une ligne d'export reprend les champs marchands attendus, tags inclus", () => {
  const flat = flattenCatalogue(
    [category({ subcategories: [{ subcategory_id: "s1", subcategory_name: "Pâtes dures", subcategory_display_order: 1, subcategory_is_active: true, products: [product({ name: "Comté", price: 12.5, tax_rate: 5.5, unit_weight_grams: 250, reference_price_per_kg: 50, is_available: true, short_description: "Affiné 12 mois" })] }] })],
    new Map([["p1", { tagIds: ["t1", "t2"], tagNames: ["Bio", "AOP"] }]])
  );
  const [row] = buildExportRows(flat);
  assert.deepEqual(row, [
    "Produit", "Comté", "Fromages", "Pâtes dures", "Bio ; AOP",
    "Affiné 12 mois", "", 12.5, 5.5, 250, "", "Oui", 50,
  ]);
});

test("[F] un produit INDISPONIBLE est exporté « Non » -- le statut est une donnée, jamais une omission", () => {
  const flat = flattenCatalogue([category({ products: [product({ is_available: false })] })]);
  assert.equal(buildExportRows(flat)[0][11], "Non");
});

test("[F/SÉCURITÉ] l'export ne contient AUCUN identifiant interne", () => {
  const flat = flattenCatalogue(
    [category({ category_id: "cat-secret", products: [product({ product_id: "prod-secret", subcategory_id: "sub-secret" })] })],
    new Map([["prod-secret", { tagIds: ["tag-secret"], tagNames: ["Bio"] }]])
  );
  const serialized = JSON.stringify(buildExportRows(flat));
  for (const id of ["prod-secret", "cat-secret", "sub-secret", "tag-secret"]) {
    assert.equal(serialized.includes(id), false, `identifiant ${id} exporté`);
  }
});

test("[F] le nombre de lignes exportées correspond EXACTEMENT à la sélection : catalogue complet vs résultat filtré", () => {
  const { cats, tagsByProductId, total } = largeCatalogue();
  const flat = flattenCatalogue(cats, tagsByProductId);
  assert.equal(buildExportRows(flat).length, total, "export complet");

  const filtre = applyCatalogueFilters(flat, { ...EMPTY_FILTERS, tagId: "t-aop" });
  assert.ok(filtre.length > 0 && filtre.length < total);
  assert.equal(buildExportRows(filtre).length, filtre.length, "export du résultat filtré");
});

test("[F] les noms de fichier distinguent explicitement l'export complet de l'export filtré", () => {
  const d = new Date("2026-09-16T10:00:00Z");
  assert.equal(catalogueExportFileName("complet", d), "catalogue-complet-2026-09-16.xlsx");
  assert.equal(catalogueExportFileName("filtre", d), "catalogue-resultats-2026-09-16.xlsx");
});

// ==================================================================
// §12 — ALLER-RETOUR RÉEL export -> lecteur d'import de production
// ==================================================================

test("[§12] le classeur exporté est relu SANS ERREUR par readXlsxWorkbook, le lecteur d'import de PRODUCTION", () => {
  const flat = flattenCatalogue(
    [category({ products: [product({ name: "Comté", price: 12.5 })] })],
    new Map([["p1", { tagIds: ["t1"], tagNames: ["Bio"] }]])
  );
  const bytes = buildCatalogueExport(flat);
  const sheet = readXlsxWorkbook(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);

  assert.equal(sheet.rows.length, 2, "en-tête + 1 produit");
  assert.deepEqual(sheet.rows[0], [...EXPORT_COLUMNS], "en-tête relu à l'identique");
  assert.equal(sheet.rows[1][1], "Comté");
  assert.equal(sheet.rows[1][4], "Bio", "les tags survivent à l'aller-retour");
  assert.equal(sheet.rows[1][7], "12.5", "le prix survit à l'aller-retour");
});

test("[§12] les 11 colonnes d'import sont reconnues à la réimportation ; les 2 colonnes supplémentaires sont IGNORÉES en INFO, jamais bloquantes -- différence documentée, pas silencieuse", async () => {
  const { resolveColumnMap } = await import("../lib/catalogue-import/column-mapping.ts");
  const map = resolveColumnMap([...EXPORT_COLUMNS]);

  // Les 11 colonnes d'import sont toutes localisées.
  for (const c of IMPORT_COLUMNS) {
    assert.ok(map.indexOf[c] !== undefined && map.indexOf[c] >= 0, `colonne d'import « ${c} » non reconnue`);
  }
  // Aucune colonne REQUISE ne manque -> le fichier exporté est
  // réimportable sans erreur structurelle.
  assert.deepEqual(map.missingRequired, [], "aucune colonne requise manquante");
  // Seules les 2 colonnes supplémentaires sont non reconnues, et le
  // service d'import les traite en INFO (jamais bloquant) -- c'est la
  // différence exacte à documenter au titre du §12.
  assert.deepEqual(map.unrecognizedHeaders, [...EXPORT_EXTRA_COLUMNS]);
});

test("[§12] un aller-retour complet 312 produits produit un classeur relisible dont chaque ligne correspond", () => {
  const { cats, tagsByProductId, total } = largeCatalogue();
  const flat = applyCatalogueFilters(flattenCatalogue(cats, tagsByProductId), EMPTY_FILTERS);
  const bytes = buildCatalogueExport(flat);
  const sheet = readXlsxWorkbook(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);

  assert.equal(sheet.rows.length, total + 1, "312 produits + en-tête");
  assert.deepEqual(sheet.rows[0], [...EXPORT_COLUMNS]);
  assert.equal(sheet.rows[1][1], flat[0].product.name, "première ligne cohérente avec l'ordre affiché");
  assert.equal(sheet.rows[total][1], flat[total - 1].product.name, "dernière ligne cohérente");
});

test("[§12] caractères spéciaux (guillemets, &, <, accents) survivent à l'aller-retour sans casser le XML", () => {
  const flat = flattenCatalogue([
    category({ category_name: "Épicerie & Cie", products: [product({ name: 'Confiture "maison" <bio>' })] }),
  ]);
  const bytes = buildCatalogueXlsx(EXPORT_COLUMNS, buildExportRows(flat));
  const sheet = readXlsxWorkbook(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  assert.equal(sheet.rows[1][1], 'Confiture "maison" <bio>');
  assert.equal(sheet.rows[1][2], "Épicerie & Cie");
});

// ==================================================================
// G. Volume
// ==================================================================

test("[G] catalogue de 312 produits, 4 catégories, 3 taux de TVA, tags multiples : aplatissement complet et cohérent", () => {
  const { cats, tagsByProductId, total } = largeCatalogue();
  assert.equal(total, 312, "fixture volumétrique conforme au mandat (300+)");
  const flat = flattenCatalogue(cats, tagsByProductId);
  assert.equal(flat.length, total, "aucun produit perdu par l'aplatissement");
  assert.equal(new Set(flat.map((f) => f.product.product_id)).size, total, "aucun doublon");
  assert.ok(flat.some((f) => f.subcategoryId !== null), "des produits en sous-catégorie");
  assert.ok(flat.some((f) => f.subcategoryId === null), "des produits directement en catégorie");
  assert.equal(new Set(flat.map((f) => f.product.tax_rate)).size, 3, "3 taux de TVA");
});

test("[G] sur 312 produits, recherche + filtres + tri restent cohérents et le compteur correspond au nombre réellement rendu", () => {
  const { cats, tagsByProductId, total } = largeCatalogue();
  const flat = flattenCatalogue(cats, tagsByProductId);

  const out = applyCatalogueFilters(flat, {
    ...EMPTY_FILTERS,
    search: "fromages",
    tagId: "t-bio",
    available: true,
    sort: "price-desc",
  });
  assert.ok(out.length > 0 && out.length < total);
  // Chaque élément satisfait TOUS les critères simultanément.
  for (const fp of out) {
    assert.ok(fp.categoryName.toLowerCase().includes("fromages"));
    assert.ok(fp.tagIds.includes("t-bio"));
    assert.equal(fp.product.is_available, true);
  }
  // L'ordre est bien décroissant.
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i - 1].product.price >= out[i].product.price, "ordre décroissant rompu");
  }
  assert.equal(buildExportRows(out).length, out.length, "l'export du résultat filtré correspond au compteur");
});
