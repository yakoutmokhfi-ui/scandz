import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { supabase } = await import("../lib/supabase.ts");
const { commitCatalogueImport } = await import("../lib/services/catalogue-import-commit.ts");
const { buildImportXlsx } = await import("./helpers/xlsx-fixture-builder.ts");

// ====================================================================
// Scanym — COLLECTIONS / TAGS FOUNDATION v1.1 — REMÉDIATION CIBLÉE.
//
// CONSTAT A (Cat Stevens 2) : une ligne classée SKIP n'appellerait pas
// associateTags(). Conséquence potentielle : un produit dont les
// champs catalogue sont DÉJÀ identiques ne recevrait jamais les tags
// nouvellement importés, parce que la mutation produit est sautée et
// que l'association de tags est sautée avec elle.
//
// Ces tests exercent le VRAI `commitCatalogueImport` (aucune
// réimplémentation) contre des RPC Supabase mockées, exactement comme
// tests/lot-ob4-catalogue-import-commit.test.ts -- ils ont d'abord été
// exécutés contre le code v1 pour REPRODUIRE le défaut avant toute
// correction (voir TEST-RESULTS.md, preuve de reproduction).
//
// Règle métier exigée par le mandat, et vérifiée ici :
//   - le produit PEUT rester SKIP / inchangé ;
//   - les tags manquants doivent malgré tout être résolus/créés ;
//   - les associations produit-tag manquantes doivent être créées ;
//   - les associations manuelles existantes doivent survivre ;
//   - aucune association en double ;
//   - un réimport converge.
// Jamais en transformant un produit identique en FAUX UPDATE.
// ====================================================================

function xlsxFile(name: string, header: string[], rows: (string | number | null)[][]): File {
  const buf = buildImportXlsx(header, rows);
  return new File([buf], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
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

/** Catalogue existant : UN produit « Pizza Margherita » à 9,90 €, dont
 *  les champs sont EXACTEMENT ceux de la ligne importée -> SKIP. */
function existingIdenticalProductRows() {
  return [
    {
      product_id: "prod-1",
      category_id: "cat-1",
      category_name: "Pizzas",
      category_name_hash: "h",
      category_translations: null,
      category_display_order: 1,
      category_is_option_source: false,
      category_description: null,
      category_description_hash: null,
      category_is_active: true,
      subcategory_id: null,
      subcategory_name: null,
      subcategory_display_order: null,
      subcategory_is_active: null,
      name: "Pizza Margherita",
      name_hash: "h2",
      short_description: null,
      description: null,
      translations: null,
      price: 9.9,
      is_available: true,
      archived_at: null,
      display_order: 1,
      is_option_source: false,
      image_url: null,
      tax_rate: null,
      unit_weight_grams: null,
      weight_is_approximate: false,
      reference_price_per_kg: null,
    },
  ];
}

interface TagHarness {
  rpcCalls: { name: string; args: any }[];
  /** Tags canoniques déjà existants pour le tenant. */
  existingTags: { id: string; name: string; normalized_key: string; visible_on_customer_menu: boolean; display_order: number; product_count: number }[];
  /** Associations produit -> ensemble d'ids de tags, état "base". */
  associations: Map<string, Set<string>>;
  tagCounter: { n: number };
  /** Force add_product_tags à échouer (test A4). */
  failAddProductTags?: boolean;
}

function freshTagHarness(): TagHarness {
  return {
    rpcCalls: [],
    existingTags: [],
    associations: new Map(),
    tagCounter: { n: 0 },
  };
}

function normKey(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Mock de `add_product_tags` reproduisant fidèlement la sémantique
 * SERVEUR prouvée par le harnais PostgreSQL réel : résout-ou-crée les
 * tags canoniques du tenant, associe de façon IDEMPOTENTE
 * (`on conflict do nothing`), STRICTEMENT ADDITIF (n'enlève jamais une
 * association existante), et retourne le nombre d'associations
 * RÉELLEMENT ajoutées.
 */
function installTagMocks(t: any, h: TagHarness) {
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    h.rpcCalls.push({ name, args });

    if (name === "get_merchant_catalogue") {
      return { data: existingIdenticalProductRows(), error: null };
    }

    if (name === "get_restaurant_tags") {
      return { data: h.existingTags, error: null };
    }

    if (name === "add_product_tags") {
      if (h.failAddProductTags) {
        return { data: null, error: { message: "Not authorized for this restaurant" } };
      }
      const productId: string = args.p_menu_item_id;
      const names: string[] = args.p_tag_names ?? [];
      let added = 0;
      const seen = new Set<string>();
      for (const raw of names) {
        const name2 = raw.trim();
        if (name2 === "") continue;
        const key = normKey(name2);
        if (seen.has(key)) continue; // dédup intra-appel
        seen.add(key);

        let tag = h.existingTags.find((x) => x.normalized_key === key);
        if (!tag) {
          h.tagCounter.n++;
          tag = {
            id: `tag-${h.tagCounter.n}`,
            name: name2,
            normalized_key: key,
            visible_on_customer_menu: false, // jamais publié par un import
            display_order: 0,
            product_count: 0,
          };
          h.existingTags.push(tag);
        }

        let set = h.associations.get(productId);
        if (!set) {
          set = new Set<string>();
          h.associations.set(productId, set);
        }
        if (!set.has(tag.id)) {
          set.add(tag.id);
          added++; // on conflict do nothing : seules les nouvelles comptent
        }
      }
      return { data: added, error: null };
    }

    throw new Error(`RPC inattendue dans ce test : ${name}`);
  });

  t.mock.method(supabase, "from", (table: string) => {
    throw new Error(`Accès table direct inattendu : ${table}`);
  });
}

/** Ligne PRODUIT strictement identique au catalogue existant, portant
 *  la colonne « Tags / Collections » indiquée. */
function identicalRowWithTags(tags: string) {
  return xlsxFile("c.xlsx", VALID_HEADER, [
    ["Produit", "Pizza Margherita", "Pizzas", "", tags, "", "", 9.9, "", "", ""],
  ]);
}

function tagNamesOf(h: TagHarness, productId: string): string[] {
  const ids = [...(h.associations.get(productId) ?? [])];
  return ids
    .map((id) => h.existingTags.find((t) => t.id === id)!.name)
    .sort();
}

// ------------------------------------------------------------------
// A1 — produit identique + tag importé MANQUANT
// ------------------------------------------------------------------
test("[A1] produit existant IDENTIQUE + tag importé non encore associé -> le produit reste SKIP (jamais un faux UPDATE) ET l'association manquante est créée", async (t) => {
  const h = freshTagHarness();
  installTagMocks(t, h);

  const result = await commitCatalogueImport(identicalRowWithTags("Bio"), "resto-1");
  assert.equal(result.kind, "COMMITTED");
  if (result.kind !== "COMMITTED") return;

  // Le produit lui-même n'est PAS muté.
  assert.equal(result.productsSkipped, 1, "le produit doit rester SKIP");
  assert.equal(result.productsUpdated, 0, "aucun faux UPDATE ne doit être fabriqué pour faire passer les tags");
  assert.equal(result.productsCreated, 0);
  assert.equal(result.rows[0].outcome, "SKIPPED");
  assert.equal(
    h.rpcCalls.some((c) => c.name === "update_product" || c.name === "create_product"),
    false,
    "aucune RPC de mutation produit ne doit être appelée"
  );

  // ...mais le tag est bien résolu/créé et associé.
  assert.equal(result.tagsAssociated, 1, "l'association manquante doit être créée");
  assert.equal(result.tagAssociationFailures, 0);
  assert.deepEqual(tagNamesOf(h, "prod-1"), ["Bio"]);
  assert.equal(h.existingTags.length, 1, "le tag canonique doit avoir été créé");
  assert.equal(
    h.existingTags[0].visible_on_customer_menu,
    false,
    "un tag créé par import ne doit jamais être publié comme collection"
  );
});

// ------------------------------------------------------------------
// A2 — convergence : réimport identique
// ------------------------------------------------------------------
test("[A2] produit identique + tag DÉJÀ associé -> aucune association en double, et un réimport répété converge (0 ajout)", async (t) => {
  const h = freshTagHarness();
  h.existingTags.push({
    id: "tag-bio",
    name: "Bio",
    normalized_key: "bio",
    visible_on_customer_menu: true,
    display_order: 1,
    product_count: 1,
  });
  h.associations.set("prod-1", new Set(["tag-bio"]));
  installTagMocks(t, h);

  const first = await commitCatalogueImport(identicalRowWithTags("Bio"), "resto-1");
  assert.equal(first.kind, "COMMITTED");
  if (first.kind !== "COMMITTED") return;
  assert.equal(first.productsSkipped, 1);
  assert.equal(first.tagsAssociated, 0, "déjà associé : aucune nouvelle association");
  assert.equal(first.tagAssociationFailures, 0);
  assert.deepEqual(tagNamesOf(h, "prod-1"), ["Bio"]);

  // Réimport : convergence stricte.
  const second = await commitCatalogueImport(identicalRowWithTags("Bio"), "resto-1");
  assert.equal(second.kind, "COMMITTED");
  if (second.kind !== "COMMITTED") return;
  assert.equal(second.tagsAssociated, 0);
  assert.deepEqual(tagNamesOf(h, "prod-1"), ["Bio"], "toujours exactement un tag, jamais dupliqué");
  assert.equal(h.existingTags.length, 1, "aucun tag canonique dupliqué");
  assert.equal(
    h.existingTags[0].visible_on_customer_menu,
    true,
    "un réimport ne doit JAMAIS dépublier une collection déjà publiée"
  );
});

// ------------------------------------------------------------------
// A3 — une association manuelle non listée dans le fichier survit
// ------------------------------------------------------------------
test("[A3] produit identique + tag MANUEL sans rapport déjà associé -> le tag manuel survit à l'import, le tag importé s'ajoute", async (t) => {
  const h = freshTagHarness();
  h.existingTags.push({
    id: "tag-manuel",
    name: "Coup de coeur",
    normalized_key: "coup de coeur",
    visible_on_customer_menu: true,
    display_order: 1,
    product_count: 1,
  });
  h.associations.set("prod-1", new Set(["tag-manuel"]));
  installTagMocks(t, h);

  const result = await commitCatalogueImport(identicalRowWithTags("Bio"), "resto-1");
  assert.equal(result.kind, "COMMITTED");
  if (result.kind !== "COMMITTED") return;

  assert.equal(result.productsSkipped, 1);
  assert.equal(result.tagsAssociated, 1);
  assert.deepEqual(
    tagNamesOf(h, "prod-1"),
    ["Bio", "Coup de coeur"],
    "l'import est STRICTEMENT ADDITIF : il n'enlève jamais une association posée à la main"
  );
});

// ------------------------------------------------------------------
// A4 — échec d'association sur une ligne SKIP
// ------------------------------------------------------------------
test("[A4] l'association échoue sur une ligne SKIP -> le produit reste correctement rapporté SKIPPED (jamais FAILED) et l'échec d'association est COMPTÉ", async (t) => {
  const h = freshTagHarness();
  h.failAddProductTags = true;
  installTagMocks(t, h);

  const result = await commitCatalogueImport(identicalRowWithTags("Bio"), "resto-1");
  assert.equal(result.kind, "COMMITTED");
  if (result.kind !== "COMMITTED") return;

  // Le produit est valide : il n'a jamais eu besoin d'être écrit.
  assert.equal(result.productsSkipped, 1);
  assert.equal(result.productsFailed, 0, "un échec de TAG ne doit jamais être compté comme un échec PRODUIT");
  assert.equal(result.rows[0].outcome, "SKIPPED");

  // ...mais l'échec est visible, jamais avalé.
  assert.equal(result.tagAssociationFailures, 1, "l'échec d'association doit être compté");
  assert.equal(result.tagsAssociated, 0);
});

// ------------------------------------------------------------------
// Non-régression : une ligne SANS tag n'appelle jamais add_product_tags
// ------------------------------------------------------------------
test("[A/non-régression] une ligne SKIP SANS colonne Tags n'appelle PAS add_product_tags (aucun appel réseau inutile)", async (t) => {
  const h = freshTagHarness();
  installTagMocks(t, h);

  const result = await commitCatalogueImport(identicalRowWithTags(""), "resto-1");
  assert.equal(result.kind, "COMMITTED");
  if (result.kind !== "COMMITTED") return;
  assert.equal(result.productsSkipped, 1);
  assert.equal(result.tagsAssociated, 0);
  assert.equal(result.tagAssociationFailures, 0);
  assert.equal(
    h.rpcCalls.some((c) => c.name === "add_product_tags"),
    false,
    "aucun tag dans le fichier = aucun appel d'association"
  );
});
