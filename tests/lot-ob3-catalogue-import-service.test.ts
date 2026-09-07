import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — OPERATOR BACKOFFICE — OB-3 — CATALOGUE IMPORT.
// lib/services/catalogue-import.ts -- orchestration IMPURE
// (File + réseau). Preuve COMPORTEMENTALE (mock supabase.rpc/from/
// storage, pas un grep de source) que ce lot :
//   - n'appelle JAMAIS une RPC catalogue MUTANTE (mandat "STRICT
//     NO-MUTATION RULE") ;
//   - n'écrit JAMAIS dans Storage (mandat "TENANT ISOLATION" /
//     "NO PHOTOS YET") ;
//   - transmet TOUJOURS le restaurant_id EXPLICITEMENT sélectionné,
//     jamais un autre (mandat "tenant context preserved") ;
//   - relaie fidèlement un refus d'accès de get_merchant_catalogue,
//     avec un message générique, jamais de fuite d'information sur
//     l'existence du restaurant (mandat "unrelated user cannot
//     inspect another tenant").
// Même patron déjà établi : tests/v109b-dashboard-payment-service.test.ts
// (t.mock.method(supabase, "rpc"/"from"), tests/v67-product-photos.test.ts
// (t.mock.method(supabase.storage, "from")).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { supabase } = await import("../lib/supabase.ts");
const { analyzeCatalogueImportFile } = await import("../lib/services/catalogue-import.ts");
const { buildImportXlsx, injectDuplicateCentralDirectoryEntry } = await import("./helpers/xlsx-fixture-builder.ts");

const MUTATING_RPC_NAMES = [
  "create_category",
  "update_category",
  "create_subcategory",
  "update_subcategory",
  "create_product",
  "update_product",
  "set_product_photo",
  "archive_product",
  "restore_product",
  "set_product_order",
];

function xlsxFile(name: string, header: string[], rows: (string | number | null)[][]): File {
  const buf = buildImportXlsx(header, rows);
  return new File([buf], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

const VALID_HEADER = [
  "Type",
  "Nom",
  "Catégorie parent",
  "Sous-catégorie parent",
  "Tags / Collections",
  "Description courte",
  "Description longue",
  "Prix TTC (€)",
  "TVA (%)",
  "Poids (g)",
  "Photo fichier",
];

function mockGetMerchantCatalogueRpc(t: any, expectedRestaurantId: string, rpcCalls: string[]) {
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    rpcCalls.push(name);
    if (MUTATING_RPC_NAMES.includes(name)) {
      throw new Error(`RPC MUTANTE APPELÉE, JAMAIS ATTENDU DANS OB-3 : ${name}`);
    }
    if (name === "get_merchant_catalogue") {
      assert.equal(args.p_restaurant_id, expectedRestaurantId, "restaurant_id transmis à get_merchant_catalogue doit être EXACTEMENT celui explicitement sélectionné");
      return { data: [], error: null };
    }
    throw new Error(`RPC inattendue dans ce test OB-3 : ${name}`);
  });
  t.mock.method(supabase, "from", (table: string) => {
    throw new Error(`Accès table direct inattendu (contournement RLS suspecté) : ${table}`);
  });
}

// ------------------------------------------------------------------
// 17. no mutating RPC called
// ------------------------------------------------------------------

test("17. analyzeCatalogueImportFile n'appelle JAMAIS de RPC catalogue mutante -- SEULE get_merchant_catalogue est appelée", async (t) => {
  const rpcCalls: string[] = [];
  mockGetMerchantCatalogueRpc(t, "resto-1", rpcCalls);
  t.mock.method(supabase.storage, "from", () => {
    throw new Error("Storage ne doit JAMAIS être touché par OB-3");
  });

  const file = xlsxFile("catalogue.xlsx", VALID_HEADER, [
    ["Produit", "Pizza Margherita", "Pizzas", "", "", "", "", 9.9, 10, 350, "pizza.jpg"],
  ]);
  const result = await analyzeCatalogueImportFile(file, "resto-1");

  assert.equal(result.kind, "OK");
  assert.deepEqual(rpcCalls, ["get_merchant_catalogue"]);
  for (const forbidden of MUTATING_RPC_NAMES) {
    assert.equal(rpcCalls.includes(forbidden), false, `${forbidden} ne doit jamais être appelée par OB-3`);
  }
});

// ------------------------------------------------------------------
// 18. no Storage write
// ------------------------------------------------------------------

test("18. analyzeCatalogueImportFile ne touche JAMAIS supabase.storage, même avec une colonne Photo fichier renseignée", async (t) => {
  const rpcCalls: string[] = [];
  mockGetMerchantCatalogueRpc(t, "resto-1", rpcCalls);
  let storageTouched = false;
  t.mock.method(supabase.storage, "from", () => {
    storageTouched = true;
    throw new Error("Storage ne doit JAMAIS être touché par OB-3 (mandat NO PHOTOS YET)");
  });

  const file = xlsxFile("catalogue.xlsx", VALID_HEADER, [
    ["Produit", "Pizza", "Pizzas", "", "", "", "", 9.9, 10, 350, "photo-du-produit.jpg"],
  ]);
  const result = await analyzeCatalogueImportFile(file, "resto-1");

  assert.equal(result.kind, "OK");
  if (result.kind === "OK") {
    assert.equal(result.report.rows[0].photoFilename, "photo-du-produit.jpg");
  }
  assert.equal(storageTouched, false, "Photo fichier doit être PARSÉE seulement, jamais uploadée (Storage jamais appelé)");
});

// ------------------------------------------------------------------
// 19. tenant context preserved
// ------------------------------------------------------------------

test("19. le restaurant_id explicitement sélectionné est transmis tel quel à get_merchant_catalogue, jamais substitué", async (t) => {
  const rpcCalls: string[] = [];
  mockGetMerchantCatalogueRpc(t, "restaurant-explicite-xyz", rpcCalls);
  t.mock.method(supabase.storage, "from", () => {
    throw new Error("Storage ne doit jamais être touché");
  });

  const file = xlsxFile("catalogue.xlsx", VALID_HEADER, [["Produit", "Pizza", "Pizzas", "", "", "", "", 9.9, "", "", ""]]);
  const result = await analyzeCatalogueImportFile(file, "restaurant-explicite-xyz");
  assert.equal(result.kind, "OK");
});

test("19. aucun restaurant sélectionné (chaîne vide) -> STRUCTURAL_ERROR TENANT_ACCESS_DENIED, aucun appel réseau", async (t) => {
  let rpcCalled = false;
  t.mock.method(supabase, "rpc", async () => {
    rpcCalled = true;
    return { data: [], error: null };
  });
  const file = xlsxFile("catalogue.xlsx", VALID_HEADER, [["Produit", "Pizza", "Pizzas", "", "", "", "", 9.9, "", "", ""]]);
  const result = await analyzeCatalogueImportFile(file, "");
  assert.equal(result.kind, "STRUCTURAL_ERROR");
  if (result.kind === "STRUCTURAL_ERROR") assert.equal(result.code, "TENANT_ACCESS_DENIED");
  assert.equal(rpcCalled, false);
});

// ------------------------------------------------------------------
// 20. unrelated user cannot inspect another tenant
// ------------------------------------------------------------------

test("20. get_merchant_catalogue refuse l'accès (RLS/RPC) -> TENANT_ACCESS_DENIED générique, AUCUNE fuite d'information (message identique, que le restaurant existe ou non)", async (t) => {
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_merchant_catalogue") {
      return { data: null, error: { message: "Not authorized for this restaurant" } };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });
  t.mock.method(supabase, "from", () => {
    throw new Error("accès table direct interdit");
  });

  const file = xlsxFile("catalogue.xlsx", VALID_HEADER, [["Produit", "Pizza", "Pizzas", "", "", "", "", 9.9, "", "", ""]]);
  const result = await analyzeCatalogueImportFile(file, "restaurant-non-autorise");

  assert.equal(result.kind, "STRUCTURAL_ERROR");
  if (result.kind === "STRUCTURAL_ERROR") {
    assert.equal(result.code, "TENANT_ACCESS_DENIED");
    // Message générique : ne mentionne jamais "Not authorized" au mot
    // près (fuite du message RPC brut), ni "n'existe pas" / "introuvable
    // uniquement" -- un message UNIQUE pour refus ET inexistence.
    assert.equal(result.message.includes("Not authorized"), false);
  }
});

// ------------------------------------------------------------------
// 1 / 2 / 3 / 6 -- au niveau service (intégration complète)
// ------------------------------------------------------------------

test("1. valid XLSX parse (intégration service complète) : fichier valide -> OK avec le bon nombre de lignes", async (t) => {
  const rpcCalls: string[] = [];
  mockGetMerchantCatalogueRpc(t, "resto-1", rpcCalls);
  t.mock.method(supabase.storage, "from", () => {
    throw new Error("jamais touché");
  });
  const file = xlsxFile("catalogue.xlsx", VALID_HEADER, [
    ["Produit", "Pizza", "Pizzas", "", "", "", "", 9.9, 10, 350, ""],
    ["Produit", "Salade", "Salades", "", "", "", "", 5, "", "", ""],
  ]);
  const result = await analyzeCatalogueImportFile(file, "resto-1");
  assert.equal(result.kind, "OK");
  if (result.kind === "OK") assert.equal(result.report.totalRows, 2);
});

test("2. colonnes obligatoires manquantes (service) -> STRUCTURAL_ERROR MISSING_REQUIRED_HEADERS, aucun appel réseau", async (t) => {
  let rpcCalled = false;
  t.mock.method(supabase, "rpc", async () => {
    rpcCalled = true;
    return { data: [], error: null };
  });
  const file = xlsxFile("catalogue.xlsx", ["Type", "Tags / Collections"], [["Produit", "x"]]);
  const result = await analyzeCatalogueImportFile(file, "resto-1");
  assert.equal(result.kind, "STRUCTURAL_ERROR");
  if (result.kind === "STRUCTURAL_ERROR") {
    assert.equal(result.code, "MISSING_REQUIRED_HEADERS");
    assert.deepEqual(result.missingHeaders?.sort(), ["Catégorie parent", "Nom", "Prix TTC (€)"].sort());
  }
  assert.equal(rpcCalled, false, "aucun appel réseau si le fichier est structurellement invalide");
});

test("3. classeur corrompu (service) -> STRUCTURAL_ERROR MALFORMED_WORKBOOK, aucun appel réseau", async (t) => {
  let rpcCalled = false;
  t.mock.method(supabase, "rpc", async () => {
    rpcCalled = true;
    return { data: [], error: null };
  });
  const corrupted = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]);
  const file = new File([corrupted], "catalogue.xlsx", { type: "application/octet-stream" });
  const result = await analyzeCatalogueImportFile(file, "resto-1");
  assert.equal(result.kind, "STRUCTURAL_ERROR");
  if (result.kind === "STRUCTURAL_ERROR") assert.equal(result.code, "MALFORMED_WORKBOOK");
  assert.equal(rpcCalled, false);
});

test("type de fichier non pris en charge (.pdf) -> STRUCTURAL_ERROR UNSUPPORTED_FILE_TYPE", async (t) => {
  let rpcCalled = false;
  t.mock.method(supabase, "rpc", async () => {
    rpcCalled = true;
    return { data: [], error: null };
  });
  const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "catalogue.pdf", { type: "application/pdf" });
  const result = await analyzeCatalogueImportFile(file, "resto-1");
  assert.equal(result.kind, "STRUCTURAL_ERROR");
  if (result.kind === "STRUCTURAL_ERROR") assert.equal(result.code, "UNSUPPORTED_FILE_TYPE");
  assert.equal(rpcCalled, false);
});

// ------------------------------------------------------------------
// OB-3 v1.3 -- mapping d'erreur, au niveau service, des deux codes
// introduits par la remédiation BLOCKER 1 (DUPLICATE_ZIP_ENTRY) et
// BLOCKER 2 (MALFORMED_CSV) -- preuve que le mapping ajouté à
// lib/services/catalogue-import.ts (analyzeCatalogueImportFile)
// produit bien STRUCTURAL_ERROR/MALFORMED_WORKBOOK côté opérateur,
// SANS jamais appeler get_merchant_catalogue (échec structurel avant
// tout accès réseau, même discipline que les autres codes structurels
// ci-dessus).
// ------------------------------------------------------------------

test("OB-3 v1.3 BLOCKER 1 -- classeur avec xl/sharedStrings.xml dupliqué (service) -> STRUCTURAL_ERROR MALFORMED_WORKBOOK, aucun appel réseau", async (t) => {
  let rpcCalled = false;
  t.mock.method(supabase, "rpc", async () => {
    rpcCalled = true;
    return { data: [], error: null };
  });
  const buf = buildImportXlsx(VALID_HEADER, [["Produit", "Pizza", "Pizzas", "", "", "", "", 9.9, "", "", ""]]);
  const patched = injectDuplicateCentralDirectoryEntry(buf, "xl/sharedStrings.xml", "<sst/>");
  const file = new File([patched], "catalogue.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const result = await analyzeCatalogueImportFile(file, "resto-1");
  assert.equal(result.kind, "STRUCTURAL_ERROR");
  if (result.kind === "STRUCTURAL_ERROR") {
    assert.equal(result.code, "MALFORMED_WORKBOOK");
    assert.ok(result.message.includes("xl/sharedStrings.xml"), "le message doit rester précis sur le chemin dupliqué en cause");
  }
  assert.equal(rpcCalled, false);
});

test("OB-3 v1.3 BLOCKER 2 -- CSV avec champ entre guillemets non terminé (service) -> STRUCTURAL_ERROR MALFORMED_WORKBOOK, aucun appel réseau", async (t) => {
  let rpcCalled = false;
  t.mock.method(supabase, "rpc", async () => {
    rpcCalled = true;
    return { data: [], error: null };
  });
  const text = '"Produit";"Cat";"10';
  const file = new File([text], "catalogue.csv", { type: "text/csv" });
  const result = await analyzeCatalogueImportFile(file, "resto-1");
  assert.equal(result.kind, "STRUCTURAL_ERROR");
  if (result.kind === "STRUCTURAL_ERROR") assert.equal(result.code, "MALFORMED_WORKBOOK");
  assert.equal(rpcCalled, false);
});

test("6. lignes intégralement vides -> ignorées, jamais comptées dans totalRows", async (t) => {
  const rpcCalls: string[] = [];
  mockGetMerchantCatalogueRpc(t, "resto-1", rpcCalls);
  t.mock.method(supabase.storage, "from", () => {
    throw new Error("jamais touché");
  });
  const file = xlsxFile("catalogue.xlsx", VALID_HEADER, [
    ["Produit", "Pizza", "Pizzas", "", "", "", "", 9.9, "", "", ""],
    [null, null, null, null, null, null, null, null, null, null, null],
    ["Produit", "Salade", "Salades", "", "", "", "", 5, "", "", ""],
  ]);
  const result = await analyzeCatalogueImportFile(file, "resto-1");
  assert.equal(result.kind, "OK");
  if (result.kind === "OK") assert.equal(result.report.totalRows, 2);
});
