import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// Scanym — P1 CUSTOMER COLLECTIONS BY TAGS — chemin de données public +
// contrat d'écriture marchand + preuves structurelles.
//
// Même patron que tests/lot01-customer-tags-display.test.ts (mock
// supabase.from / supabase.rpc via t.mock.method).
//
// Couvre : §1 seules les collections publiées sont retournées, §2 un
// tag interne n'est découvrable ni en navigation ni en badge, §5 ordre
// du contrat serveur, §7 badges inchangés, §8 identifiant inconnu /
// inter-tenant sans effet, §9 (service) l'écriture marchand passe par
// update_tag_collection_settings, §13 aucun chemin de mutation client
// et aucune structure parallèle, §14 échec RPC -> catalogue normal sans
// collection ni tag.
//
// La suppression d'une collection PUBLIÉE mais vide est prouvée sur
// PostgreSQL réel par supabase/tests/catalogue-collections-tags-v1-
// check.sh ([P1 EMPTY]).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { supabase } = await import("../lib/supabase.ts");
const { getRestaurantBySlug } = await import("../lib/services/restaurant.ts");
const { updateTagCollectionSettings } = await import("../lib/services/catalogue-tags.ts");

const RESTO_A = "11111111-1111-1111-1111-111111111111";
const P_COMTE = "aaaaaaaa-0000-0000-0000-000000000001";
const P_RACLETTE = "aaaaaaaa-0000-0000-0000-000000000002";
const P_ROUGE = "aaaaaaaa-0000-0000-0000-000000000003";
const P_INDISPO = "aaaaaaaa-0000-0000-0000-000000000004";
const P_HIDDEN = "aaaaaaaa-0000-0000-0000-000000000005";
const P_FOREIGN = "bbbbbbbb-0000-0000-0000-000000000009";

function item(id: string, category_id: string, name: string, display_order: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    category_id,
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
        menu_subcategories: [{ id: "s-raclette", category_id: "c1", name: "Raclette", display_order: 1 }],
        menu_items: [
          item(P_COMTE, "c1", "Comté", 1),
          item(P_RACLETTE, "c1", "Raclette de Savoie", 2, { subcategory_id: "s-raclette" }),
          item(P_INDISPO, "c1", "Indispo", 3, { is_available: false }),
        ],
      },
      {
        id: "c2",
        restaurant_id: RESTO_A,
        name: "Vins",
        display_order: 2,
        is_active: true,
        menu_subcategories: [],
        menu_items: [item(P_ROUGE, "c2", "Rouge", 1)],
      },
      {
        id: "c3",
        restaurant_id: RESTO_A,
        name: "Goûts (réservoir)",
        display_order: 3,
        is_active: false,
        menu_subcategories: [],
        menu_items: [item(P_HIDDEN, "c3", "Goût caché", 1)],
      },
    ],
    restaurant_active_languages: [],
  };
}

type CollectionRow = { id: string; label: string; display_order: number; menu_item_ids: string[] | null };

function installMocks(t: any, collections: CollectionRow[] | { error: string }) {
  const rpcCalls: { name: string; args: any }[] = [];
  const fromTables: string[] = [];
  t.mock.method(supabase, "from", (table: string) => {
    fromTables.push(table);
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({ data: restaurantRow(), error: null }),
    };
    return builder;
  });
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    rpcCalls.push({ name, args });
    if ("error" in collections) return { data: null, error: { message: collections.error } };
    return { data: collections, error: null };
  });
  return { rpcCalls, fromTables };
}

function itemsById(restaurant: any): Map<string, any> {
  const map = new Map<string, any>();
  for (const c of [...restaurant.categories, ...restaurant.hiddenCategories]) {
    for (const i of c.menu_items) map.set(i.id, i);
  }
  return map;
}

// Réponse serveur : get_restaurant_collections ne renvoie QUE des tags
// publiés (la RPC filtre visible_on_customer_menu) -- un tag interne
// n'y figure donc jamais. L'ordre est celui du serveur.
const SERVER_COLLECTIONS: CollectionRow[] = [
  { id: "t-selection", label: "Sélection du chef", display_order: 1, menu_item_ids: [P_ROUGE, P_RACLETTE, P_COMTE] },
  { id: "t-bio", label: "Bio", display_order: 2, menu_item_ids: [P_COMTE, P_FOREIGN, P_HIDDEN] },
  { id: "t-etrangere", label: "Étrangère", display_order: 3, menu_item_ids: [P_FOREIGN] },
];

test("[PUBLISHED][ORDER] RestaurantFull.collections conserve les collections publiées, dans l'ordre du contrat serveur, restreintes au modèle public", async (t) => {
  const { rpcCalls } = installMocks(t, SERVER_COLLECTIONS);
  const restaurant = await getRestaurantBySlug("au-lait-cru");
  assert.ok(restaurant);
  assert.deepEqual(restaurant!.collections, [
    { id: "t-selection", label: "Sélection du chef", displayOrder: 1, menuItemIds: [P_ROUGE, P_RACLETTE, P_COMTE] },
    { id: "t-bio", label: "Bio", displayOrder: 2, menuItemIds: [P_COMTE] },
  ]);
  // UN seul appel, le contrat anon existant -- jamais les RPC backoffice.
  assert.deepEqual(rpcCalls, [{ name: "get_restaurant_collections", args: { p_restaurant_id: RESTO_A } }]);
});

test("[CROSS-TENANT] un identifiant produit étranger/masqué ne fuit ni dans les collections ni dans le modèle public ; une collection sans produit public est supprimée", async (t) => {
  installMocks(t, SERVER_COLLECTIONS);
  const restaurant = await getRestaurantBySlug("au-lait-cru");
  const serialized = JSON.stringify(restaurant);
  assert.equal(serialized.includes(P_FOREIGN), false, "l'identifiant étranger ne fuit nulle part");
  assert.equal(serialized.includes("Étrangère"), false, "une collection sans produit public n'atteint pas le client");
  const allIds = restaurant!.collections!.flatMap((c) => c.menuItemIds);
  assert.equal(allIds.includes(P_HIDDEN), false, "un produit de catégorie masquée n'est jamais sélectionnable");
  assert.equal(allIds.includes(P_INDISPO), false);
});

test("[BADGES] les badges publiés existants restent posés à l'identique (mêmes libellés, même ordre)", async (t) => {
  installMocks(t, SERVER_COLLECTIONS);
  const restaurant = await getRestaurantBySlug("au-lait-cru");
  const items = itemsById(restaurant);
  assert.deepEqual(items.get(P_COMTE).customer_tags, ["Sélection du chef", "Bio"]);
  assert.deepEqual(items.get(P_ROUGE).customer_tags, ["Sélection du chef"]);
  assert.equal("customer_tags" in items.get(P_HIDDEN), false);
});

test("[INTERNAL TAG] un tag interne (absent de la réponse publique) n'apparaît ni en collection ni en badge, même s'il est porté par un produit", async (t) => {
  // Le marchand a tagué P_ROUGE « Interne » sans le publier : la RPC
  // publique ne le renvoie donc pas.
  installMocks(t, [{ id: "t-bio", label: "Bio", display_order: 1, menu_item_ids: [P_COMTE] }]);
  const restaurant = await getRestaurantBySlug("au-lait-cru");
  const serialized = JSON.stringify(restaurant);
  assert.equal(serialized.includes("Interne"), false);
  assert.deepEqual(restaurant!.collections!.map((c) => c.label), ["Bio"]);
  assert.equal("customer_tags" in itemsById(restaurant).get(P_ROUGE), false);
});

test("[SERVICE FAILURE] RPC en échec : le catalogue normal reste complet, sans collection ni tag", async (t) => {
  installMocks(t, { error: "function public.get_restaurant_collections(uuid) does not exist" });
  t.mock.method(console, "error", () => {});
  const restaurant = await getRestaurantBySlug("au-lait-cru");
  assert.ok(restaurant, "le menu est toujours retourné");
  assert.deepEqual(restaurant!.categories.map((c) => c.id), ["c1", "c2"]);
  assert.equal(restaurant!.categories[0].menu_items.length, 2);
  assert.deepEqual(restaurant!.collections, []);
  for (const i of itemsById(restaurant).values()) assert.equal("customer_tags" in i, false);
});

test("[MERCHANT WRITE] updateTagCollectionSettings appelle la RPC existante update_tag_collection_settings (visibilité + ordre entier), et propage l'échec serveur", async (t) => {
  const calls: { name: string; args: any }[] = [];
  let fail = false;
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    calls.push({ name, args });
    return fail ? { data: null, error: { message: "Forbidden" } } : { data: null, error: null };
  });
  await updateTagCollectionSettings("t-bio", true, 3);
  assert.deepEqual(calls, [
    { name: "update_tag_collection_settings", args: { p_tag_id: "t-bio", p_visible_on_customer_menu: true, p_display_order: 3 } },
  ]);
  fail = true;
  await assert.rejects(updateTagCollectionSettings("t-bio", false, 0), /Forbidden/);
});

// --------------------------------------------------------------------
// Preuves structurelles (§13) : aucune mutation client, aucune
// seconde source de vérité.
// --------------------------------------------------------------------

function codeOnly(src: string): string {
  return src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const CUSTOMER_FILES = ["components/CollectionNav.tsx", "lib/customer-collections.ts", "components/MenuView.tsx"];

test("[NO CUSTOMER MUTATION] la navigation client n'importe aucun service de tags/collections et n'appelle aucune RPC ni table", () => {
  for (const f of ["components/CollectionNav.tsx", "lib/customer-collections.ts"]) {
    const src = codeOnly(readFileSync(f, "utf8"));
    assert.equal(/supabase|\.rpc\(|\.from\(|fetch\(/.test(src), false, `${f} ne doit faire aucun accès réseau`);
    assert.equal(src.includes("catalogue-tags"), false, `${f} ne doit pas importer le service de tags`);
  }
  for (const f of CUSTOMER_FILES) {
    const src = codeOnly(readFileSync(f, "utf8"));
    assert.equal(src.includes("updateTagCollectionSettings"), false, `${f} ne doit exposer aucune écriture`);
    assert.equal(src.includes("update_tag_collection_settings"), false);
    assert.equal(/menu_tags|menu_item_tags/.test(src), false, `${f} ne doit jamais lire les tables de tags`);
  }
});

test("[SINGLE SOURCE] le modèle public lit les collections UNIQUEMENT via getRestaurantCollections (une seule lecture, réutilisée pour badges ET navigation)", () => {
  const src = codeOnly(readFileSync("lib/services/restaurant.ts", "utf8"));
  assert.equal((src.match(/getRestaurantCollections\(/g) ?? []).length, 1);
  assert.equal((src.match(/loadCustomerTagSources\(/g) ?? []).length, 2, "1 définition + 1 appel");
  assert.ok(src.includes("buildCustomerProductTags(tagSources, displayedItemIds)"));
  assert.ok(src.includes("buildCustomerCollections(tagSources, displayedItemIds)"));
  assert.equal(/get_restaurant_tags|get_restaurant_product_tags|menu_tags|menu_item_tags/.test(src), false);
});

test("[I18N] les libellés client et marchand existent dans les 3 dictionnaires (fr/en/ar), non vides", async () => {
  const { DICTS } = await import("../lib/i18n.ts");
  const keys = [
    "collectionsNavLabel",
    "collectionsShowAll",
    "mcCollectionsTitle",
    "mcCollectionsHint",
    "mcCollectionsNone",
    "mcCollectionVisible",
    "mcCollectionOrder",
    "mcCollectionSave",
    "mcCollectionSaveFor",
    "mcCollectionPublic",
    "mcCollectionPrivate",
    "mcCollectionProducts",
    "mcCollectionOrderInvalid",
    "mcCollectionSaveFailed",
  ];
  for (const lang of ["fr", "en", "ar"]) {
    for (const key of keys) {
      const value = DICTS[lang]?.[key];
      assert.ok(typeof value === "string" && value.trim().length > 0, `${lang}.${key} manquant`);
    }
  }
});

test("[SINGLE SOURCE] aucune nouvelle table/RPC/relation de collection : aucun SQL produit n'appelle ni ne définit d'autre modèle", () => {
  const svc = codeOnly(readFileSync("lib/services/catalogue-tags.ts", "utf8"));
  const rpcs = [...svc.matchAll(/supabase\.rpc\("([a-z_]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(rpcs, [
    "add_product_tags",
    "create_tag",
    "get_restaurant_collections",
    "get_restaurant_product_tags",
    "get_restaurant_tags",
    "remove_product_tag",
    "update_tag_collection_settings",
  ]);
  const page = codeOnly(readFileSync("app/dashboard/catalogue/page.tsx", "utf8"));
  assert.equal(/\.from\(\s*["']menu_tags|\.from\(\s*["']menu_item_tags|supabase\.rpc\(/.test(page), false, "la page marchand passe uniquement par le service existant");
  assert.ok(page.includes("updateTagCollectionSettings(tag.id, visible, Number(order.trim()))"));
});
