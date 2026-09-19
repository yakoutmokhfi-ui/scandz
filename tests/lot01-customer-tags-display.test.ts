import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — LOT 01 — CUSTOMER TAGS DISPLAY — chemin de données.
//
// Preuve COMPORTEMENTALE (mock supabase.from / supabase.rpc via
// t.mock.method, même patron que tests/catalogue-reset-service.test.ts)
// que la carte publique (getRestaurantBySlug) :
//   - lit les tags UNIQUEMENT via le contrat client existant
//     get_restaurant_collections (grant anon, filtrage publication/
//     tenant serveur), avec l'id du restaurant résolu par slug -- jamais
//     les RPC backoffice get_restaurant_tags / get_restaurant_product_tags ;
//   - pose les libellés sur les produits tagués, n'altère pas les
//     produits sans tag, gère plusieurs tags et supprime les doublons ;
//   - ignore tout identifiant produit étranger aux produits affichés de
//     CET établissement (aucune fuite inter-tenant) ;
//   - n'échoue jamais si la lecture des tags échoue.
// La RPC elle-même (publication, isolation tenant, établissement non
// publié) reste prouvée par supabase/tests/catalogue-collections-tags-
// v1-check.sh -- aucune modification SQL dans ce lot.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { supabase } = await import("../lib/supabase.ts");
const { getRestaurantBySlug } = await import("../lib/services/restaurant.ts");
const { getRestaurantProductTags, getRestaurantCollections } = await import(
  "../lib/services/catalogue-tags.ts"
);
const { buildCustomerProductTags, dedupeTagLabels, attachCustomerTags } = await import(
  "../lib/customer-product-tags.ts"
);

const RESTO_A = "11111111-1111-1111-1111-111111111111";
const P_TAGGED = "aaaaaaaa-0000-0000-0000-000000000001";
const P_MULTI = "aaaaaaaa-0000-0000-0000-000000000002";
const P_PLAIN = "aaaaaaaa-0000-0000-0000-000000000003";
const P_HIDDEN = "aaaaaaaa-0000-0000-0000-000000000004";
const P_FOREIGN = "bbbbbbbb-0000-0000-0000-000000000009";

function item(id: string, name: string, display_order: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    category_id: "c1",
    subcategory_id: null,
    name,
    description: null,
    short_description: null,
    price: 900,
    image_url: null,
    display_order,
    is_available: true,
    archived_at: null,
    ...overrides,
  };
}

function restaurantRow() {
  return {
    id: RESTO_A,
    name: "Au Lait Cru",
    slug: "au-lait-cru",
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    restaurant_configs: { currency: "EUR", source_language: "fr" },
    menu_categories: [
      {
        id: "c1",
        restaurant_id: RESTO_A,
        name: "Fromages",
        display_order: 1,
        is_active: true,
        menu_subcategories: [],
        menu_items: [
          item(P_TAGGED, "Comté", 1),
          item(P_MULTI, "Brie truffé", 2),
          item(P_PLAIN, "Emmental", 3),
        ],
      },
      {
        id: "c2",
        restaurant_id: RESTO_A,
        name: "Goûts (réservoir)",
        display_order: 2,
        is_active: false,
        menu_subcategories: [],
        menu_items: [item(P_HIDDEN, "Goût caché", 1, { category_id: "c2" })],
      },
    ],
    restaurant_active_languages: [],
  };
}

type Collection = { id: string; label: string; display_order: number; menu_item_ids: string[] | null };

function installMocks(
  t: any,
  collections: Collection[] | { error: string }
): { rpcCalls: { name: string; args: any }[]; eqs: [string, unknown][] } {
  const rpcCalls: { name: string; args: any }[] = [];
  const eqs: [string, unknown][] = [];
  t.mock.method(supabase, "from", (table: string) => {
    assert.equal(table, "restaurants");
    const builder: any = {
      select: () => builder,
      eq: (col: string, value: unknown) => {
        eqs.push([col, value]);
        return builder;
      },
      maybeSingle: async () => ({ data: restaurantRow(), error: null }),
    };
    return builder;
  });
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    rpcCalls.push({ name, args });
    if ("error" in collections) return { data: null, error: { message: collections.error } };
    return { data: collections, error: null };
  });
  return { rpcCalls, eqs };
}

function itemsById(restaurant: any): Map<string, any> {
  const map = new Map<string, any>();
  for (const c of [...restaurant.categories, ...restaurant.hiddenCategories]) {
    for (const i of c.menu_items) map.set(i.id, i);
  }
  return map;
}

// --------------------------------------------------------------------
// Chemin de données complet : getRestaurantBySlug
// --------------------------------------------------------------------

test("[TAGGED/MULTI/UNTAGGED] getRestaurantBySlug pose les tags publiés, ordonnés par display_order, et laisse un produit sans tag strictement inchangé", async (t) => {
  const { rpcCalls } = installMocks(t, [
    { id: "t-bio", label: "Bio", display_order: 1, menu_item_ids: [P_TAGGED, P_MULTI] },
    { id: "t-truffe", label: "Truffe", display_order: 2, menu_item_ids: [P_MULTI] },
  ]);
  const restaurant = await getRestaurantBySlug("au-lait-cru");
  assert.ok(restaurant);
  const items = itemsById(restaurant);

  assert.deepEqual(items.get(P_TAGGED).customer_tags, ["Bio"]);
  assert.deepEqual(items.get(P_MULTI).customer_tags, ["Bio", "Truffe"]);
  assert.equal("customer_tags" in items.get(P_PLAIN), false, "un produit sans tag ne reçoit aucune propriété");
  assert.deepEqual(items.get(P_PLAIN), { ...item(P_PLAIN, "Emmental", 3), subcategory_name: null, subcategory_display_order: null });

  assert.deepEqual(rpcCalls, [{ name: "get_restaurant_collections", args: { p_restaurant_id: RESTO_A } }]);
});

test("[DUPLICATES] une même étiquette répétée (même collection listant 2 fois le produit, ou 2 tags de même libellé à la casse près) ne s'affiche qu'une fois", async (t) => {
  installMocks(t, [
    { id: "t-bio", label: "Bio", display_order: 1, menu_item_ids: [P_MULTI, P_MULTI] },
    { id: "t-bio-2", label: " bio ", display_order: 2, menu_item_ids: [P_MULTI] },
    { id: "t-truffe", label: "Truffe", display_order: 3, menu_item_ids: [P_MULTI] },
  ]);
  const restaurant = await getRestaurantBySlug("au-lait-cru");
  assert.deepEqual(itemsById(restaurant).get(P_MULTI).customer_tags, ["Bio", "Truffe"]);
});

test("[TENANT] les tags sont lus pour le restaurant résolu par slug (publié) ; un produit d'un AUTRE établissement présent dans la réponse n'apparaît nulle part", async (t) => {
  const { rpcCalls, eqs } = installMocks(t, [
    { id: "t-bio", label: "Bio", display_order: 1, menu_item_ids: [P_TAGGED, P_FOREIGN] },
  ]);
  const restaurant = await getRestaurantBySlug("au-lait-cru");
  assert.ok(restaurant);

  // Le filtre public préexistant est conservé tel quel.
  assert.deepEqual(eqs, [["slug", "au-lait-cru"], ["is_active", true], ["status", "active"]]);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].args.p_restaurant_id, RESTO_A);

  const items = itemsById(restaurant);
  assert.equal(items.has(P_FOREIGN), false, "aucun produit étranger n'est injecté dans la carte");
  assert.equal(JSON.stringify(restaurant).includes(P_FOREIGN), false, "l'identifiant étranger ne fuit nulle part");
  assert.deepEqual(items.get(P_TAGGED).customer_tags, ["Bio"]);
});

test("[TENANT] le menu client n'appelle JAMAIS les RPC backoffice (tags non publiés) -- seul le contrat anon get_restaurant_collections est utilisé", async (t) => {
  const { rpcCalls } = installMocks(t, []);
  await getRestaurantBySlug("au-lait-cru");
  const names = rpcCalls.map((c) => c.name);
  assert.deepEqual(names, ["get_restaurant_collections"]);
  assert.ok(!names.includes("get_restaurant_tags"));
  assert.ok(!names.includes("get_restaurant_product_tags"));
});

test("[HIDDEN] un produit d'une catégorie masquée (réservoir d'options) ne reçoit jamais de tag", async (t) => {
  installMocks(t, [{ id: "t-bio", label: "Bio", display_order: 1, menu_item_ids: [P_HIDDEN] }]);
  const restaurant = await getRestaurantBySlug("au-lait-cru");
  assert.equal("customer_tags" in itemsById(restaurant).get(P_HIDDEN), false);
});

test("[RESILIENCE] une erreur de lecture des tags ne casse jamais le menu : rendu sans tag", async (t) => {
  installMocks(t, { error: "function public.get_restaurant_collections(uuid) does not exist" });
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
  const restaurant = await getRestaurantBySlug("au-lait-cru");
  assert.ok(restaurant, "le menu est toujours retourné");
  assert.equal(restaurant!.categories[0].menu_items.length, 3);
  for (const i of itemsById(restaurant).values()) assert.equal("customer_tags" in i, false);
  assert.equal(errors.length, 1);
});

// --------------------------------------------------------------------
// Logique pure
// --------------------------------------------------------------------

test("buildCustomerProductTags : ordre display_order puis libellé, même si la réponse arrive désordonnée", () => {
  const map = buildCustomerProductTags(
    [
      { id: "b", label: "Truffe", displayOrder: 2, menuItemIds: ["p1"] },
      { id: "a", label: "Bio", displayOrder: 1, menuItemIds: ["p1"] },
      { id: "c", label: "AOP", displayOrder: 2, menuItemIds: ["p1"] },
    ],
    new Set(["p1"])
  );
  assert.deepEqual(map.get("p1"), ["Bio", "AOP", "Truffe"]);
});

test("buildCustomerProductTags : produit hors de l'ensemble autorisé ignoré, liste vide -> carte vide", () => {
  assert.equal(buildCustomerProductTags([{ id: "a", label: "Bio", displayOrder: 1, menuItemIds: ["x"] }], new Set(["p1"])).size, 0);
  assert.equal(buildCustomerProductTags([], new Set(["p1"])).size, 0);
});

test("dedupeTagLabels : vides/blancs/non-chaînes écartés, doublons insensibles à la casse et à la normalisation Unicode", () => {
  assert.deepEqual(
    dedupeTagLabels(["Bio", "bio", "  ", "", null, undefined, "Café", "Café", "Truffe "]),
    ["Bio", "Café", "Truffe"]
  );
});

test("attachCustomerTags : un produit sans tag est retourné par identité (même objet)", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  const out = attachCustomerTags([a, b], new Map([["b", ["Bio"]]]));
  assert.equal(out[0], a);
  assert.deepEqual(out[1], { id: "b", customer_tags: ["Bio"] });
});

// --------------------------------------------------------------------
// Non-régression marchand/backoffice : contrats inchangés
// --------------------------------------------------------------------

test("[MERCHANT] getRestaurantProductTags (backoffice) reste inchangé : même RPC, tous les tags (publiés ou non) restent visibles du marchand", async (t) => {
  const calls: { name: string; args: any }[] = [];
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    calls.push({ name, args });
    return {
      data: [{ menu_item_id: P_MULTI, tag_ids: ["t-bio", "t-interne"], tag_names: ["Bio", "Interne"] }],
      error: null,
    };
  });
  const rows = await getRestaurantProductTags(RESTO_A);
  assert.deepEqual(calls, [{ name: "get_restaurant_product_tags", args: { p_restaurant_id: RESTO_A } }]);
  assert.deepEqual(rows, [{ menuItemId: P_MULTI, tagIds: ["t-bio", "t-interne"], tagNames: ["Bio", "Interne"] }]);
});

test("[MERCHANT] getRestaurantCollections : contrat client inchangé (RPC, paramètre, mapping, propagation d'erreur)", async (t) => {
  let mode: "ok" | "err" = "ok";
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    assert.equal(name, "get_restaurant_collections");
    assert.deepEqual(args, { p_restaurant_id: RESTO_A });
    return mode === "ok"
      ? { data: [{ id: "t", label: "Bio", display_order: 1, menu_item_ids: null }], error: null }
      : { data: null, error: { message: "boom" } };
  });
  assert.deepEqual(await getRestaurantCollections(RESTO_A), [{ id: "t", label: "Bio", displayOrder: 1, menuItemIds: [] }]);
  mode = "err";
  await assert.rejects(getRestaurantCollections(RESTO_A), /boom/);
});
