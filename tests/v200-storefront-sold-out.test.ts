import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { supabase } = await import("../lib/supabase.ts");
const { getRestaurantBySlug } = await import("../lib/services/restaurant.ts");
const { normalizeShowUnavailableProducts, isSoldOut } = await import("../lib/storefront-sold-out.ts");
const { addToCart, cartLines } = await import("../lib/cart.ts");
const { restoreSessionCart, serializeSessionCart } = await import("../lib/cart-session.ts");
const { getChoices } = await import("../lib/restaurants-config.ts");
const { isItemUnavailableError, ItemUnavailableError } = await import("../lib/services/order-error.ts");
const { DICTS } = await import("../lib/i18n.ts");

// Issue #200 -- produits en rupture dans la vitrine (réglage par commerçant).

function raw(id: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id, category_id: "cat-1", subcategory_id: null, name, price: 10,
    is_available: true, archived_at: null, display_order: 1, translations: null,
    ...over,
  };
}

async function load(config: Record<string, unknown>, items: ReturnType<typeof raw>[], hidden: ReturnType<typeof raw>[] = [], collectionsRpc: unknown[] = []) {
  const response = {
    data: {
      id: "r1", name: "R", slug: "r", is_active: true, created_at: "2026-01-01T00:00:00.000Z",
      restaurant_configs: { id: "cfg", ...config },
      menu_categories: [
        { id: "cat-1", name: "Fromages", display_order: 1, is_active: true, menu_subcategories: [], menu_items: items },
        ...(hidden.length ? [{ id: "cat-h", name: "Goûts", display_order: 2, is_active: false, menu_subcategories: [], menu_items: hidden }] : []),
      ],
      restaurant_active_languages: [],
    },
    error: null,
  };
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) builder[m] = () => builder;
  builder.maybeSingle = async () => response;
  const of = supabase.from, or = supabase.rpc;
  (supabase as unknown as { from: unknown }).from = () => builder;
  (supabase as unknown as { rpc: unknown }).rpc = async (name: string) => ({ data: name === "get_restaurant_collections" ? collectionsRpc : [], error: null });
  try {
    return await getRestaurantBySlug("r");
  } finally {
    (supabase as unknown as { from: unknown }).from = of;
    (supabase as unknown as { rpc: unknown }).rpc = or;
  }
}

const ITEMS = () => [
  raw("a", "Disponible"),
  raw("b", "Épuisé", { is_available: false }),
  raw("c", "Archivé", { archived_at: "2026-01-01T00:00:00Z" }),
  raw("d", "Archivé et épuisé", { is_available: false, archived_at: "2026-01-01T00:00:00Z" }),
];
const names = (r: Awaited<ReturnType<typeof load>>) => r!.categories[0]!.menu_items.map((i) => i.name);

test("[200-LOAD-1] réglage absent / false / invalide : comportement historique (indisponible masqué)", async () => {
  for (const cfg of [{}, { show_unavailable_products: false }, { show_unavailable_products: null }, { show_unavailable_products: "true" }, { show_unavailable_products: 1 }]) {
    assert.deepEqual(names(await load(cfg, ITEMS())), ["Disponible"], JSON.stringify(cfg));
  }
});

test("[200-LOAD-2] réglage actif : l'indisponible est affiché (is_available=false conservé), l'archivé reste exclu", async () => {
  const r = await load({ show_unavailable_products: true }, ITEMS());
  assert.deepEqual(names(r).sort(), ["Disponible", "Épuisé"].sort());
  const sold = r!.categories[0]!.menu_items.find((i) => i.name === "Épuisé")!;
  assert.equal(sold.is_available, false);
  assert.equal(isSoldOut(sold), true);
});

test("[200-LOAD-3] multi-établissements : le réglage de A n'affecte pas B", async () => {
  const a = await load({ show_unavailable_products: true }, ITEMS());
  const b = await load({ show_unavailable_products: false }, ITEMS());
  assert.equal(names(a).includes("Épuisé"), true);
  assert.equal(names(b).includes("Épuisé"), false);
});

test("[200-LOAD-4] catégorie masquée (réservoir de choix) : un choix épuisé n'est jamais proposé", async () => {
  const r = await load({ show_unavailable_products: true }, [raw("a", "Disponible")], [raw("g1", "Nature"), raw("g2", "Chocolat", { is_available: false })]);
  assert.deepEqual(r!.hiddenCategories[0]!.menu_items.map((i) => i.name), ["Nature"]);
});

test("[200-LOAD-5] la charge utile n'expose rien de plus que les champs publics habituels", async () => {
  const r = await load({ show_unavailable_products: true }, ITEMS());
  assert.ok(!JSON.stringify(r).includes("withdrawal_eligible"));
});

test("[200-HELP] normalisation stricte du réglage", () => {
  assert.equal(normalizeShowUnavailableProducts(true), true);
  for (const v of [false, null, undefined, "true", 1, 0, {}, []]) assert.equal(normalizeShowUnavailableProducts(v), false);
  assert.equal(isSoldOut({ is_available: false }), true);
  assert.equal(isSoldOut({ is_available: true }), false);
  assert.equal(isSoldOut({}), false);
});

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, price: 5, category_id: "c", description: null, short_description: null,
  image_url: null, display_order: 0, is_available: true, ...over,
}) as never;

test("[200-CART-1] addToCart refuse un produit ou une option en rupture, mais permet de retirer", () => {
  const sold = item("s", { is_available: false });
  assert.deepEqual(addToCart({}, { item: sold, quantity: 1 }), {});
  assert.deepEqual(addToCart({}, { item: item("p"), option: sold, quantity: 1 }), {});
  const cart = addToCart({}, { item: item("p"), quantity: 2 });
  assert.equal(cartLines(addToCart(cart, { item: item("p"), quantity: -1 }))[0].quantity, 1);
  assert.equal(cartLines(addToCart(cart, { item: item("p", { is_available: false }), quantity: -2 })).length, 0);
});

test("[200-CART-2] panier restauré après actualisation : l'article passé en rupture est retiré et signalé (#199)", () => {
  const product = item("p1");
  const keep = item("p2");
  const saved = serializeSessionCart(addToCart(addToCart({}, { item: product, quantity: 1 }), { item: keep, quantity: 1 }));
  const soldNow = item("p1", { is_available: false });
  const restaurant = {
    id: "shop", slug: "x",
    categories: [{ id: "c", name: "C", is_active: true, menu_items: [soldNow, keep] }],
    hiddenCategories: [],
  } as never;
  const restored = restoreSessionCart(saved, restaurant);
  assert.equal(restored.removed, true);
  assert.deepEqual(cartLines(restored.cart).map((l) => l.item.id), ["p2"]);
});

test("[200-CHOICE] getChoices ne propose jamais un choix en rupture", () => {
  const restaurant = {
    categories: [], hiddenCategories: [{ name: "Goûts cookies", menu_items: [item("g1"), item("g2", { is_available: false })] }],
  } as never;
  const ids = getChoices(restaurant, { sourceCategory: "Goûts" } as never).map((c) => c.id);
  assert.deepEqual(ids, ["g1"]);
});

test("[200-ERR] erreur serveur « article indisponible » classée (code ET message) et message client clair", () => {
  assert.equal(isItemUnavailableError({ code: "P0001", message: "Article indisponible ou étranger à ce restaurant: 123" }), true);
  assert.equal(isItemUnavailableError({ code: "P0001", message: "Article indisponible ou étranger à ce restaurant 123" }), true);
  assert.equal(isItemUnavailableError({ code: "P0001", message: "Option invalide pour Cookie" }), true);
  assert.equal(isItemUnavailableError({ code: "22001", message: "Article indisponible ou étranger à ce restaurant" }), false);
  assert.equal(isItemUnavailableError({ code: "P0001", message: "autre erreur" }), false);
  assert.equal(isItemUnavailableError(null), false);
  assert.equal(new ItemUnavailableError().name, "ItemUnavailableError");
  const src = readFileSync("components/MenuView.tsx", "utf8");
  assert.match(src, /err instanceof ItemUnavailableError\s*\?\s*t\("orderItemUnavailable"\)/);
});

test("[200-SRV] SERVEUR : toutes les versions de create_order refusent un produit ET une option indisponibles", () => {
  const files = readdirSync("supabase").filter((f) => f.endsWith(".sql") && !/rollback/i.test(f));
  const code = (f: string) => readFileSync(`supabase/${f}`, "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const defs = files.filter((f) => /function public\.create_order\(/i.test(code(f)));
  assert.ok(defs.length >= 5, `definitions trouvées: ${defs.length}`);
  for (const f of defs) {
    const sql = code(f);
    const body = sql.slice(sql.search(/function public\.create_order\(/i));
    assert.ok((body.match(/mi\.is_available = true/g) ?? []).length >= 2, `${f}: produit ET option doivent exiger is_available = true`);
    assert.match(body, /Article indisponible ou étranger à ce restaurant/, f);
  }
});

test("[200-SQL] le lot SQL est DRAFT, additif, défaut false, sans toucher create_order ni les données", () => {
  const sql = readFileSync("supabase/DRAFT-lot-storefront-sold-out-visibility-v1.sql", "utf8");
  assert.match(sql, /NOT APPLIED IN PRODUCTION/);
  assert.match(sql, /add column show_unavailable_products boolean not null default false/);
  assert.match(sql, /assert_restaurant_asset_role/);
  assert.match(sql, /revoke all on function public\.update_restaurant_show_unavailable\(uuid, boolean\) from public, anon;/);
  assert.doesNotMatch(sql, /create (or replace )?function public\.create_order/i);
  assert.doesNotMatch(sql, /update public\.menu_items|delete from|insert into/i);
  const rb = readFileSync("supabase/DRAFT-lot-storefront-sold-out-visibility-v1-ROLLBACK.sql", "utf8");
  assert.match(rb, /drop column show_unavailable_products/);
  assert.match(rb, /drop function public\.update_restaurant_show_unavailable/);
});

test("[200-I18N] « En rupture » et message de commande en FR/EN/AR/NL ; réglage en FR/EN/AR", () => {
  for (const l of ["fr", "en", "ar", "nl"] as const) {
    assert.ok(DICTS[l].soldOutBadge?.length > 0, `${l}.soldOutBadge`);
    assert.ok(DICTS[l].orderItemUnavailable?.length > 0, `${l}.orderItemUnavailable`);
  }
  assert.equal(DICTS.fr.soldOutBadge, "En rupture");
  for (const l of ["fr", "en", "ar"] as const) {
    for (const k of ["stSoldOutTitle", "stSoldOutHint", "stSoldOutLabel", "stSoldOutUnavailable", "stSoldOutSaveError"]) {
      assert.ok(DICTS[l][k]?.length > 0, `${l}.${k}`);
    }
  }
});

test("[200-DASH] l'écriture passe par la seule RPC et la lecture est indépendante", async () => {
  const { updateRestaurantShowUnavailable, getRestaurantShowUnavailable } = await import("../lib/services/dashboard.ts");
  const calls: unknown[] = [];
  const orig = supabase.rpc;
  (supabase as unknown as { rpc: unknown }).rpc = async (name: string, args: unknown) => { calls.push([name, args]); return { error: null }; };
  try {
    await updateRestaurantShowUnavailable("r1", true);
  } finally {
    (supabase as unknown as { rpc: unknown }).rpc = orig;
  }
  assert.deepEqual(calls, [["update_restaurant_show_unavailable", { p_restaurant_id: "r1", p_show: true }]]);
  const of = supabase.from;
  const mk = (data: unknown) => { const b: Record<string, unknown> = {}; for (const m of ["select", "eq"]) b[m] = () => b; b.maybeSingle = async () => ({ data, error: null }); return b; };
  (supabase as unknown as { from: unknown }).from = () => mk({ show_unavailable_products: true });
  assert.equal(await getRestaurantShowUnavailable("r1"), true);
  (supabase as unknown as { from: unknown }).from = () => mk({});
  await assert.rejects(() => getRestaurantShowUnavailable("r1"));
  (supabase as unknown as { from: unknown }).from = of;
});

// --- Correction #200 : un produit en rupture affiché garde ses tags et ses collections ---
const COLLS = [
  { id: "t-bretagne", label: "Bretagne", display_order: 1, menu_item_ids: ["a", "b"] },
  { id: "t-truffe", label: "Truffe", display_order: 2, menu_item_ids: ["b"] },
];

test("[200-TAGS-1] réglage actif : le produit en rupture garde ses tags et reste dans ses collections", async () => {
  const r = await load({ show_unavailable_products: true }, ITEMS(), [], COLLS);
  const sold = r!.categories[0]!.menu_items.find((i) => i.name === "Épuisé") as unknown as { customer_tags?: string[] };
  assert.deepEqual(sold.customer_tags, ["Bretagne", "Truffe"]);
  assert.deepEqual(r!.collections!.map((c) => [c.label, c.menuItemIds]), [["Bretagne", ["a", "b"]], ["Truffe", ["b"]]]);
});

test("[200-TAGS-2] la collection dont le seul porteur est en rupture n'est pas vidée", async () => {
  const r = await load({ show_unavailable_products: true }, ITEMS(), [], COLLS);
  assert.ok(r!.collections!.some((c) => c.label === "Truffe" && c.menuItemIds.includes("b")));
});

test("[200-TAGS-3] réglage désactivé : la rupture n'est pas affichée, donc ni tag ni collection fantôme", async () => {
  const r = await load({ show_unavailable_products: false }, ITEMS(), [], COLLS);
  assert.deepEqual(r!.collections!.map((c) => [c.label, c.menuItemIds]), [["Bretagne", ["a"]]]);
  assert.ok(!JSON.stringify(r!.categories).includes("Truffe"));
});

test("[200-TAGS-4] défense en profondeur : un identifiant archivé renvoyé par le serveur n'apparaît jamais", async () => {
  const withArchived = [{ id: "t-x", label: "Archive", display_order: 1, menu_item_ids: ["c", "d"] }];
  const r = await load({ show_unavailable_products: true }, ITEMS(), [], withArchived);
  assert.deepEqual(r!.collections ?? [], []);
  assert.ok(!JSON.stringify(r!.categories).includes("Archive"));
});

test("[200-TAGS-5] collection ouverte : l'article en rupture est rendu par renderMenuItem (donc sans ajout au panier)", () => {
  const src = readFileSync("components/MenuView.tsx", "utf8");
  assert.match(src, /\{activeCollectionItems\.map\(renderMenuItem\)\}/);
  assert.match(src, /function handleAdd\(item: MenuItem\) \{\s*\/\/ Issue #200[^\n]*\n\s*if \(isSoldOut\(item\)\) return;/);
});

test("[200-SQL-COLL] le lot SQL des collections est DRAFT, ne change ni signature ni droits ni archivé, et est annulable", () => {
  const sql = readFileSync("supabase/DRAFT-lot-storefront-sold-out-collections-v1.sql", "utf8");
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.match(sql, /NOT APPLIED IN PRODUCTION/);
  assert.match(code, /create or replace function public\.get_restaurant_collections\(p_restaurant_id uuid\)/);
  assert.match(code, /and mi\.archived_at is null/);
  assert.match(code, /rc\.restaurant_id = p_restaurant_id/);
  assert.doesNotMatch(code, /grant |revoke |alter table|insert into|update public|delete from/i);
  const rb = readFileSync("supabase/DRAFT-lot-storefront-sold-out-collections-v1-ROLLBACK.sql", "utf8");
  const orig = readFileSync("supabase/DRAFT-lot-catalogue-collections-tags-foundation-v1.sql", "utf8");
  const origFn = orig.slice(orig.indexOf("create or replace function public.get_restaurant_collections"), orig.indexOf("end $$;", orig.indexOf("create or replace function public.get_restaurant_collections")) + 7);
  assert.ok(rb.includes(origFn), "le rollback restaure la définition d'origine à l'identique");
});

// --- Audit TURING (P2) : jamais d'écrasement silencieux d'une fonction modifiée ---
const ORIG_MD5 = "62469954066d750857dc0153534be55d";
const NEW_MD5 = "364c52f3d561593421b2e6deb034069d";
const bodyMd5 = (sql: string, from: number): string => {
  // prosrc = texte entre les délimiteurs $$ de la première fonction trouvée à partir de `from`.
  const open = sql.indexOf("as $$", from) + "as $$".length;
  const close = sql.indexOf("end $$;", open) + "end ".length;
  return createHash("md5").update(sql.slice(open, close)).digest("hex");
};

test("[200-SQL-DRIFT-1] les empreintes codées dans le lot et le rollback sont celles des vrais corps de fonction", () => {
  const fnStart = (sql: string) => sql.indexOf("create or replace function public.get_restaurant_collections");
  const foundation = readFileSync("supabase/DRAFT-lot-catalogue-collections-tags-foundation-v1.sql", "utf8");
  const lot = readFileSync("supabase/DRAFT-lot-storefront-sold-out-collections-v1.sql", "utf8");
  const rb = readFileSync("supabase/DRAFT-lot-storefront-sold-out-collections-v1-ROLLBACK.sql", "utf8");
  assert.equal(bodyMd5(foundation, fnStart(foundation)), ORIG_MD5, "original (lot Collections/Tags)");
  assert.equal(bodyMd5(lot, fnStart(lot)), NEW_MD5, "définition posée par le lot");
  assert.equal(bodyMd5(rb, fnStart(rb)), ORIG_MD5, "définition restaurée par le rollback");
});

test("[200-SQL-DRIFT-2] pré-vol du lot : refuse toute définition différente de l'original ; rollback : refuse toute définition différente de la nôtre", () => {
  const exec = (f: string) => readFileSync(f, "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const lot = exec("supabase/DRAFT-lot-storefront-sold-out-collections-v1.sql");
  const rb = exec("supabase/DRAFT-lot-storefront-sold-out-collections-v1-ROLLBACK.sql");
  const createAt = lot.indexOf("create or replace function");
  const pre = lot.slice(0, createAt);
  assert.match(pre, new RegExp(`v_md5 is distinct from '${ORIG_MD5}'`));
  assert.match(pre, /SCANYM_FUNCTION_DRIFT/);
  assert.match(pre, /prosecdef/);
  assert.match(pre, new RegExp(`v_md5 = '${NEW_MD5}'[\\s\\S]*SCANYM_ALREADY_APPLIED`));
  const rbPre = rb.slice(0, rb.indexOf("create or replace function"));
  assert.match(rbPre, new RegExp(`v_md5 is distinct from '${NEW_MD5}'`));
  assert.match(rbPre, /SCANYM_ROLLBACK_DRIFT/);
  const lotPost = lot.slice(createAt);
  assert.match(lotPost, new RegExp(`is distinct from '${NEW_MD5}'`));
  assert.match(rb.slice(rb.indexOf("create or replace function")), new RegExp(`is distinct from '${ORIG_MD5}'`));
});
