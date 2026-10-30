import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
const React = await import("react");
const { createRoot } = await import("react-dom/client");

/** Doublure PostgREST minimale pour lib/services/dashboard.ts (aucun réseau). */
const calls: Array<{ table: string; select: string; ids?: string[] }> = [];
const behaviour = { mainRows: [] as any[], flagRows: [] as any[], flagError: null as any, flagThrows: false };
(globalThis as any).__vp = { calls, behaviour };
const mocks: Record<string, string> = {
  "@/lib/supabase": `
    function builder(table){
      const st={table,select:""};
      const b={
        select(s){st.select=s;return b},eq(){return b},order(){return b},limit(){return b},not(){return b},or(){return b},
        in(col,ids){ if(table==='orders'&&col==='id'){st.ids=ids; globalThis.__vp.calls.push({...st});
            return Promise.resolve(globalThis.__vp.behaviour.flagThrows?(()=>{throw new Error('boom')})():{data:globalThis.__vp.behaviour.flagRows,error:globalThis.__vp.behaviour.flagError});}
          return b },
        then(res,rej){ globalThis.__vp.calls.push({...st}); return Promise.resolve({data:globalThis.__vp.behaviour.mainRows,error:null}).then(res,rej)},
      };
      return b;
    }
    export const supabase={from:builder,rpc:async()=>({data:null,error:null})};`,
};
async function bundle(entry: string) {
  const out = await esbuild.build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, format: "esm", jsx: "automatic", target: "es2022", external: ["react", "react-dom", "react-dom/client"],
    plugins: [{ name: "vp", setup(build) {
      build.onResolve({ filter: /.*/ }, (a) => {
        if (mocks[a.path]) return { path: a.path, namespace: "mock" };
        if (a.path.startsWith("@/")) {
          const base = path.join(process.cwd(), a.path.slice(2));
          const r = [base, `${base}.ts`, `${base}.tsx`].find(existsSync);
          if (r) return { path: r };
        }
        return undefined;
      });
      build.onLoad({ filter: /.*/, namespace: "mock" }, (a) => ({ contents: mocks[a.path], loader: "tsx" }));
    } }],
  });
  const dir = mkdtempSync(path.join(process.cwd(), "tests", "tmp-vp-"));
  const file = path.join(dir, "m.mjs");
  writeFileSync(file, out.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  rmSync(dir, { recursive: true, force: true });
  return mod;
}
const { getDashboardOrders } = await bundle(`export { getDashboardOrders } from '@/lib/services/dashboard';`);
const { default: OrderCard } = await bundle(`export { default } from '@/components/dashboard/OrderCard';`);
const { buildCreateOrderPayload } = await bundle(`export { buildCreateOrderPayload } from '@/lib/services/order-payload';`);
const { useVacuumPackingChoice } = await bundle(`export { useVacuumPackingChoice } from '@/lib/use-vacuum-packing-choice';`);
const vp = await bundle(`export * from '@/lib/vacuum-packing';`);
const { translate } = await bundle(`export { translate } from '@/lib/i18n';`);
after(() => dom.window.close());

// ───────────── éligibilité (aucun nom en dur) ─────────────
const cats = [
  { id: "c-cheese", vacuum_packable: true },
  { id: "c-deli", vacuum_packable: true },
  { id: "c-drinks", vacuum_packable: false },
  { id: "c-legacy" },
  { id: "c-null", vacuum_packable: null },
];
const line = (category_id: string) => ({ item: { category_id } });

test("[VP-LOGIC-1] éligibilité : par indicateur de catégorie ; fromage seul, charcuterie seule, mixte, sans éligible, panier vide", () => {
  assert.equal(vp.cartHasVacuumPackable([line("c-cheese")], cats), true);
  assert.equal(vp.cartHasVacuumPackable([line("c-deli")], cats), true);
  assert.equal(vp.cartHasVacuumPackable([line("c-drinks"), line("c-cheese")], cats), true);
  assert.equal(vp.cartHasVacuumPackable([line("c-drinks"), line("c-legacy"), line("c-null")], cats), false);
  assert.equal(vp.cartHasVacuumPackable([], cats), false);
  assert.equal(vp.cartHasVacuumPackable([line("c-cheese")], []), false);
  assert.equal(vp.cartHasVacuumPackable([line("unknown")], cats), false);
});

test("[VP-LOGIC-2] le choix ne survit pas à la perte d'éligibilité", () => {
  assert.equal(vp.effectiveVacuumPacking(true, true), true);
  assert.equal(vp.effectiveVacuumPacking(true, false), false);
  assert.equal(vp.effectiveVacuumPacking(false, true), false);
  assert.equal(vp.effectiveVacuumPacking(false, false), false);
});

test("[VP-LOGIC-3] aucun nom de catégorie/produit codé en dur dans la règle", () => {
  const src = readFileSync("lib/vacuum-packing.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(src, /fromage|charcuterie|cheese|deli|\.name\b/i);
});

// ───────────── payload ─────────────
const ctx = (mode: string) => ({ mode, tableNumber: mode === "table" ? 4 : null, customer: { firstName: "A", lastName: "B", phone: "1", email: "a@b.c", street: "", postalCode: "", city: "" } });
const base = (mode: string, extra: Record<string, unknown> = {}) => ({
  slug: "au-lait-cru", context: ctx(mode), lang: "fr",
  lines: [{ item: { id: "i1", category_id: "c-cheese" }, quantity: 1 }], ...extra,
});

test("[VP-LOGIC-4] payload : absent/false => identique à l'historique (aucune clé) ; true => p_customer.vacuum_packing = true", () => {
  const historic = buildCreateOrderPayload(base("pickup"));
  const falsy = buildCreateOrderPayload(base("pickup", { vacuumPacking: false }));
  assert.deepEqual(falsy, historic, "false = octet pour octet l'historique");
  assert.equal("vacuum_packing" in historic.p_customer, false);
  const yes = buildCreateOrderPayload(base("pickup", { vacuumPacking: true }));
  assert.equal(yes.p_customer.vacuum_packing, true);
  assert.deepEqual({ ...yes.p_customer, vacuum_packing: undefined }, { ...historic.p_customer, vacuum_packing: undefined }, "rien d'autre ne change");
  assert.deepEqual({ ...yes, p_customer: null }, { ...historic, p_customer: null });
  const delivery = buildCreateOrderPayload(base("delivery", { vacuumPacking: true }));
  assert.equal(delivery.p_customer.vacuum_packing, true);
});

test("[VP-LOGIC-5] payload : jamais en mode table", () => {
  const t = buildCreateOrderPayload(base("table", { vacuumPacking: true }));
  assert.deepEqual(t.p_customer, {});
});

test("[VP-LOGIC-6] MenuView transmet le choix sur le panier GELÉ, via effectiveVacuumPacking, sans appel réseau supplémentaire", () => {
  const src = readFileSync("components/MenuView.tsx", "utf8");
  assert.match(src, /vacuumPacking:\s*\n?\s*frozenOrderContext\.mode !== "table" &&\s*effectiveVacuumPacking\(\s*vacuumPacking,\s*cartHasVacuumPackable\(frozenLines, restaurant\.categories\)/);
  assert.match(src, /setVacuumPacking\(false\);\s*\n\s*setPendingInvoiceCompletion\(null\)/, "remis à zéro avec le formulaire");
  assert.equal((src.match(/set_category_vacuum_packable|vacuum_packing_requested/g) ?? []).length, 0, "le client n'écrit jamais la persistance lui-même");
});

// ───────────── back-office : lecture ─────────────
const row = (id: string) => ({ id, restaurant_id: "r", order_number: 1, status: "new" });

test("[VP-LOGIC-7] lecture : la colonne est lue à part ; true/false posés ; absent de la requête principale", async () => {
  calls.length = 0;
  behaviour.mainRows = [row("o1"), row("o2"), row("o3")];
  behaviour.flagRows = [{ id: "o1", vacuum_packing_requested: true }, { id: "o2", vacuum_packing_requested: false }];
  behaviour.flagError = null; behaviour.flagThrows = false;
  const out = await getDashboardOrders("r", false);
  assert.deepEqual(out.map((o: any) => [o.id, o.vacuum_packing_requested]), [["o1", true], ["o2", false], ["o3", undefined]]);
  const main = calls.find((c) => c.table === "orders" && !c.ids)!;
  assert.doesNotMatch(main.select, /vacuum_packing_requested/, "la liste existante n'est pas touchée");
  const flags = calls.find((c) => c.ids)!;
  assert.deepEqual(flags.ids, ["o1", "o2", "o3"]);
});

test("[VP-LOGIC-8] lecture : SEULE la colonne absente (lot non appliqué) est tolérée ; toute autre erreur est PROPAGÉE (PLANCK190-03)", async () => {
  behaviour.mainRows = [row("o1")];
  behaviour.flagThrows = false;
  // Colonne absente, sous ses trois formes : la liste s'affiche, valeur INCONNUE.
  for (const err of [
    { code: "42703", message: 'column "vacuum_packing_requested" does not exist' },
    { code: "42703", message: "column orders.vacuum_packing_requested does not exist" },
    { message: 'column "vacuum_packing_requested" does not exist' },
    { code: "PGRST204", message: "Could not find the 'vacuum_packing_requested' column of 'orders' in the schema cache" },
  ]) {
    behaviour.flagRows = null as any; behaviour.flagError = err;
    const out = await getDashboardOrders("r", false);
    assert.equal(out.length, 1);
    assert.equal("vacuum_packing_requested" in out[0], false, "jamais « non demandé » fabriqué");
  }
  // Toute autre erreur : la consigne ne disparaît JAMAIS en silence -- l'appelant voit l'échec.
  for (const err of [
    { code: "57014", message: "canceling statement due to statement timeout" },
    { code: "42501", message: "permission denied for table orders" },
    { message: "FetchError: network down" },
    { message: 'column "other" does not exist' },
    // PLANCK190-03 : un 42703 visant UNE AUTRE colonne ne doit JAMAIS être pris pour l'absence de la nôtre.
    { code: "42703", message: "column orders.other_column does not exist" },
    { code: "42703", message: "x" },
    { code: "42703", message: 'column "vacuum_packing_requested_backup" does not exist' },
    { message: "column orders.vacuum_packing_requested_backup does not exist" },
    { message: "column orders.xvacuum_packing_requested does not exist" },
    { code: "42703", message: "column menu_categories.vacuum_packing_requested does not exist" },
    { code: "PGRST204", message: "Could not find the 'vacuum_packing_requested_backup' column of 'orders' in the schema cache" },
    { code: "PGRST204", message: "Could not find the 'vacuum_packing_requested' column of 'menu_categories' in the schema cache" },
    { code: "42703" },
    // PLANCK190-03 (casse) : un identifiant entre guillemets est sensible à la casse en PostgreSQL.
    { code: "42703", message: 'column "VACUUM_PACKING_REQUESTED" does not exist' },
    { code: "42703", message: 'column orders."VACUUM_PACKING_REQUESTED" does not exist' },
    { code: "42703", message: 'column "Vacuum_Packing_Requested" does not exist' },
    { code: "42703", message: 'column "Orders".vacuum_packing_requested does not exist' },
    { code: "42703", message: "column ORDERS.vacuum_packing_requested does not exist" },
    { code: "42703", message: 'column "ORDERS"."vacuum_packing_requested" does not exist' },
    // PostgREST : variantes de colonne et de table
    { code: "PGRST204", message: "Could not find the 'VACUUM_PACKING_REQUESTED' column of 'orders' in the schema cache" },
    { code: "PGRST204", message: "Could not find the 'vacuum_packing_requested' column of 'ORDERS' in the schema cache" },
    { code: "PGRST204", message: "Could not find the 'vacuum_packing_requested' column of 'Orders' in the schema cache" },
    { code: "PGRST204", message: "Could not find the 'vacuum_packing_requested' column of 'order_items' in the schema cache" },
    { code: "PGRST204", message: "could not find the 'vacuum_packing_requested' column of 'orders' in the schema cache" },
    // texte parasite autour : ce n'est plus l'absence exacte
    { code: "42703", message: "error: column orders.vacuum_packing_requested does not exist" },
    { code: "42703", message: "column orders.vacuum_packing_requested does not exist (and more)" },
    { code: "42703", message: "column foo.orders.vacuum_packing_requested does not exist" },
  ]) {
    behaviour.flagRows = null as any; behaviour.flagError = err;
    await assert.rejects(getDashboardOrders("r", false), (e: Error) => e.message === (err.message ?? ""), `propagée : ${err.code ?? ""} ${err.message}`);
  }
  behaviour.flagError = null; behaviour.flagThrows = true;
  await assert.rejects(getDashboardOrders("r", false), /boom/, "exception propagée");
  behaviour.flagThrows = false;
  behaviour.flagError = null; behaviour.flagRows = "illisible" as any;
  await assert.rejects(getDashboardOrders("r", false), /illisible/);
  behaviour.flagRows = [];
});

test("[VP-LOGIC-9] liste vide : aucune requête supplémentaire", async () => {
  calls.length = 0; behaviour.mainRows = [];
  assert.deepEqual(await getDashboardOrders("r", false), []);
  assert.equal(calls.some((c) => c.ids), false);
});

// ───────────── back-office : affichage ─────────────
function order(extra: Record<string, unknown>) {
  return {
    id: "00000000-0000-0000-0000-000000000001", restaurant_id: "a", order_number: 7, status: "new", payment_status: "paid",
    service_mode: "pickup", table_number: null, customer_name: "Client", customer_phone: null, customer_email: null,
    delivery_address: null, delivery_zone: null, customer_note: null, customer_language: "fr", subtotal: 10, total: 10, currency: "EUR",
    created_at: "2026-10-01T12:00:00.000Z", updated_at: "2026-10-01T12:00:00.000Z",
    order_items: [{ id: "x", item_name: "Comté", option_name: null, quantity: 1, unit_price: 10, line_total: 10, menu_item_id: "i", option_item_id: null, tax_rate_snapshot: null }],
    order_delivery_tax_allocations: [], order_invoice_request: null,
    tax_settings_snapshot_default_tax_rate: null, tax_settings_snapshot_prices_include_tax: null, tax_settings_snapshot_tax_label: null, tax_settings_snapshot_show_tax_summary: null,
    ...extra,
  };
}
function mount(o: any, lang = "fr") {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  root.render(React.createElement(OrderCard, { order: o, restaurantName: "Resto", receiptSettings: null, onStatus: async () => {}, busy: false, staffLanguage: lang }));
  return { container, dispose: () => { root.unmount(); container.remove(); } };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

test("[VP-LOGIC-10] fiche commande : bandeau + pastille quand demandé, y compris payée ; rien si faux ou inconnu", async () => {
  for (const [flag, shown] of [[true, true], [false, false], [undefined, false]] as const) {
    for (const ps of ["not_required", "paid"]) {
      const m = mount(order({ vacuum_packing_requested: flag, payment_status: ps }));
      await tick();
      assert.equal(m.container.querySelector("[data-order-vacuum-detail]") !== null, shown, `détail flag=${flag} ps=${ps}`);
      assert.equal(m.container.querySelector("[data-order-vacuum-badge]") !== null, shown, `pastille flag=${flag} ps=${ps}`);
      if (shown) {
        assert.equal(m.container.querySelector("[data-order-vacuum-detail]")!.textContent, translate("fr", "dsVacuumPackingDetail"));
        assert.match(m.container.querySelector("[data-order-vacuum-detail]")!.textContent!, /mise sous vide/i);
      }
      m.dispose();
    }
  }
});

test("[VP-LOGIC-11] textes validés FR/EN exacts ; clés présentes en FR/EN/AR/NL", () => {
  assert.equal(translate("fr", "vacuumPackingLabel"), "Mettre mes fromages et charcuteries sous vide");
  assert.equal(translate("en", "vacuumPackingLabel"), "Vacuum-pack my cheeses and deli meats");
  assert.equal(translate("fr", "vacuumPackingInfo"), "La mise sous vide aide à protéger les fromages et les charcuteries et à préserver leur qualité pendant le transport.");
  assert.equal(translate("en", "vacuumPackingInfo"), "Vacuum packing helps protect the cheeses and deli meats and preserve their quality during transport.");
  for (const lang of ["fr", "en", "ar", "nl"]) {
    for (const key of ["vacuumPackingLabel", "vacuumPackingInfoButton", "vacuumPackingInfo", "vacuumPackingReviewTitle", "vacuumPackingReviewValue"]) {
      assert.notEqual(translate(lang, key), key, `${lang}.${key}`);
    }
  }
  for (const lang of ["fr", "en", "ar"]) {
    for (const key of ["dsVacuumPackingBadge", "dsVacuumPackingDetail", "mcCategoryVacuumPackable", "mcCategoryVacuumPackableHint"]) {
      assert.notEqual(translate(lang, key), key, `${lang}.${key}`);
    }
  }
});

test("[VP-LOGIC-12] aucune trace WhatsApp : le choix ne touche ni lib/whatsapp ni l'envoi", () => {
  for (const f of ["lib/whatsapp.ts", "lib/customer-contact.ts"]) {
    assert.doesNotMatch(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""), /vacuum|sous vide/i, f);
  }
});

test("[VP-LOGIC-13] éditeur de catégorie : case réservée à l'édition, masquée si l'information est indisponible, écriture seulement si changée", () => {
  const src = readFileSync("app/dashboard/catalogue/page.tsx", "utf8");
  assert.match(src, /mode === "edit" && vacuumOptionAvailable && \(/);
  assert.match(src, /vacuumOptionAvailable=\{cat\.category_vacuum_packable !== undefined\}/);
  assert.match(src, /cat\.category_vacuum_packable !== undefined &&\s*categoryDraft\.vacuumPackable !== cat\.category_vacuum_packable/);
  const svc = readFileSync("lib/services/dashboard.ts", "utf8");
  assert.match(svc, /rpc\("set_category_vacuum_packable"/);
  assert.doesNotMatch(svc, /\.from\("menu_categories"\)\s*\.(update|insert|upsert|delete)/, "aucune écriture directe : uniquement la RPC contrôlée");
});

test("[VP-LOGIC-14] AUD190-01 : cocher, retirer le dernier article éligible, le rajouter => case DÉCOCHÉE (état réellement réinitialisé)", async () => {
  let api!: { available: (b: boolean) => void; value: () => boolean; set: (b: boolean) => void };
  function Harness() {
    const [available, setAvailable] = React.useState(true);
    const [value, set] = useVacuumPackingChoice(available);
    api = { available: setAvailable, value: () => value, set };
    return React.createElement("span", { "data-v": String(value) });
  }
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const { act } = React as any;
  const run = async (fn: () => void) => { fn(); await tick(); };
  root.render(React.createElement(Harness)); await tick();
  const shown = () => container.querySelector("[data-v]")!.getAttribute("data-v");
  assert.equal(shown(), "false", "décochée au départ");
  await run(() => api.set(true));
  assert.equal(shown(), "true");
  await run(() => api.available(false));
  assert.equal(shown(), "false", "plus proposée => faux");
  await run(() => api.available(true));
  assert.equal(shown(), "false", "reproposée => DÉCOCHÉE, aucun choix fantôme");
  await run(() => api.set(true));
  assert.equal(shown(), "true", "un nouveau choix explicite fonctionne");
  root.unmount(); container.remove(); void act;
  const mv = readFileSync("components/MenuView.tsx", "utf8");
  assert.match(mv, /useVacuumPackingChoice\(vacuumPackingAvailable\)/);
  assert.match(mv, /serviceMode !== "table" && cartHasVacuumPackable\(lines, restaurant\.categories\)/);
});
