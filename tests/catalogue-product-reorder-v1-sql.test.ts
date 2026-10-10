import { after, before, beforeEach, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import {
  makeBaselineDb, seed, readSql, scopeRows, scopeState, orderFingerprint, nonOrderFingerprint, uuid,
  LOT_SQL, ROLLBACK_SQL, OWNER_A, MANAGER_A, STAFF_A, OWNER_B, OPERATOR, STRANGER,
  CAT_FROMAGES, CAT_BOISSONS, CAT_B, SUB_CHEVRES, SUB_BREBIS, P,
} from "./helpers/catalogue-product-reorder-db.ts";
import {
  applyProductMove, findProductOrderScope, orderProductsForCatalogue, type ProductOrderScopeEntry,
} from "../lib/catalogue-product-order.ts";
import { compareMenuItemsForPublicDisplay } from "../lib/catalogue-subcategory-grouping.ts";
import {
  moveProductOrderModel, referenceScopeFingerprint, type RpcModelRow,
} from "./helpers/catalogue-product-reorder-rpc-model.ts";

// ====================================================================
// Scanym — CATALOGUE PRODUCT REORDER v1 — la RPC RÉELLE, de bout en bout.
//
//   vrai service (lib/services/catalogue-product-order.ts)
//     -> vraie génération de requête supabase-js
//     -> petit adaptateur PostgREST STRICT (ci-dessous)
//     -> PostgreSQL local (PGlite) exécutant le DRAFT SQL du lot tel
//        quel, sous le rôle `authenticated`, RLS active.
//
// Ce n'est pas un test d'intégration PostgREST hébergé : aucune requête
// ne quitte le processus (toute autre origine fait échouer le test).
//
// CONCURRENCE : PGlite n'offre qu'UNE connexion. Les scénarios
// ci-dessous rejouent donc les ENTRELACEMENTS que le verrou
// d'établissement rend possibles (deux clients partis de la même vue,
// l'un après l'autre). Le blocage effectif de sessions réellement
// parallèles est prouvé sur PostgreSQL réel par
// supabase/tests/catalogue-product-reorder-v1-check.sh (section 9).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "local-test-only";
const { moveProductOrder, ProductOrderStaleError, ProductOrderBoundaryError } = await import(
  "../lib/services/catalogue-product-order.ts"
);

let db: PGlite;
/** Utilisateur porté par le « JWT » de l'adaptateur ; "" = aucun. */
let user = OWNER_A;
const requests: { path: string; body: Record<string, unknown> }[] = [];

before(async () => {
  db = await makeBaselineDb();
  await seed(db);
  await db.exec(readSql(LOT_SQL));
});
after(async () => {
  await db?.close();
});
beforeEach(async (t) => {
  await seed(db);
  user = OWNER_A;
  requests.length = 0;
  (t as TestContext).mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "http://127.0.0.1:9", "aucune requête externe permise");
    assert.equal(url.pathname, "/rest/v1/rpc/move_product_order", "seule la RPC du lot est appelée");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ path: url.pathname, body });
    // Contrat exact de la RPC : ces trois paramètres, aucun autre.
    assert.deepEqual(Object.keys(body).sort(), ["p_direction", "p_expected_scope", "p_product_id"]);
    assert.ok(Array.isArray(body.p_expected_scope));
    // Chaque élément de la vue ne porte QUE les trois champs du contrat.
    for (const entry of body.p_expected_scope as Record<string, unknown>[]) {
      assert.deepEqual(Object.keys(entry).sort(), ["display_order", "id", "name"]);
    }
    try {
      const value = await db.transaction(async (tx) => {
        await tx.exec("set local role authenticated");
        await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [user]);
        // Le JSON reçu est passé TEL QUEL à PostgreSQL (texte -> jsonb),
        // comme PostgREST le fait pour un paramètre jsonb.
        const r = await tx.query<{ position: number }>(
          "select public.move_product_order($1::uuid, $2::text, $3::text::jsonb) as position",
          [body.p_product_id, body.p_direction, JSON.stringify(body.p_expected_scope)]
        );
        return r.rows[0].position;
      });
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
    } catch (error) {
      const e = error as { code?: string; message?: string };
      return new Response(JSON.stringify({ code: e.code ?? null, message: e.message ?? "", details: null, hint: null }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  });
});

type Entry = ProductOrderScopeEntry;

/** VUE affichée par le back-office pour un périmètre : les lignes
 *  relues en base, triées par le comparateur de production, réduites
 *  aux trois champs du contrat. Capturée AVANT un changement
 *  concurrent, c'est une vue PÉRIMÉE. */
async function displayedView(categoryId: string, subcategoryId: string | null): Promise<Entry[]> {
  const rows = await scopeRows(db, categoryId, subcategoryId);
  return orderProductsForCatalogue(rows.map((r) => ({ product_id: r.id, name: r.name, display_order: r.display_order }))).map(
    (p) => ({ id: p.product_id, display_order: p.display_order, name: p.name })
  );
}
/** Ordre AFFICHÉ (identifiants seuls) du même périmètre. */
async function displayedOrder(categoryId: string, subcategoryId: string | null): Promise<string[]> {
  return (await displayedView(categoryId, subcategoryId)).map((e) => e.id);
}
/** Vue FORGÉE : ces identifiants, dans CET ordre, avec les valeurs
 *  stockées COURANTES de chacun (quel que soit son périmètre, son
 *  établissement ou son archivage). */
async function viewOf(ids: ReadonlyArray<string>): Promise<Entry[]> {
  const r = await db.query<{ id: string; display_order: number; name: string }>(
    "select id, display_order, name::text as name from public.menu_items where id = any($1::uuid[])",
    [`{${[...new Set(ids)].join(",")}}`]
  );
  const byId = new Map(r.rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    assert.ok(row, `produit du jeu d'essai introuvable : ${id}`);
    return { id: row!.id, display_order: row!.display_order, name: row!.name };
  });
}
/** Instantané OCTET POUR OCTET de l'ordre de toute la base : id,
 *  display_order et version de ligne (xmin) de chaque produit. Deux
 *  instantanés égaux = aucune valeur changée, aucune ligne réécrite. */
async function orderSnapshot(): Promise<string> {
  const r = await db.query<{ snap: string }>(
    "select string_agg(id::text || '=' || display_order::text || '@' || xmin::text, ',' order by id) as snap from public.menu_items"
  );
  return r.rows[0].snap;
}
/** Un AUTRE utilisateur (le manager) écrit par les RPC historiques. */
async function otherUser(sql: string, params: unknown[] = []): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.exec("set local role authenticated");
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [MANAGER_A]);
    await tx.query(sql, params);
  });
}

/** Ordre de la CARTE CLIENT pour un périmètre : lecture sous le rôle
 *  `anon` (RLS réelle), produits disponibles, comparateur public. */
async function storefrontOrder(categoryId: string, subcategoryId: string | null): Promise<string[]> {
  const rows = await db.transaction(async (tx) => {
    await tx.exec("set local role anon");
    const r = await tx.query<{ id: string; name: string; display_order: number; subcategory_id: string | null }>(
      `select id, name::text as name, display_order, subcategory_id from public.menu_items
       where category_id = $1 and subcategory_id is not distinct from $2 and is_available and archived_at is null
       order by id desc`,
      [categoryId, subcategoryId]
    );
    return r.rows;
  });
  return rows
    .map((r) => ({ ...r, subcategory_name: "x", subcategory_display_order: 1 }))
    .sort(compareMenuItemsForPublicDisplay as any)
    .map((r) => r.id);
}

/** Catalogue de l'établissement A au format du back-office (vue non
 *  archivée), pour exercer les MÊMES fonctions que l'écran. */
async function loadBackOfficeCatalogue(): Promise<any[]> {
  const categories = [];
  for (const [categoryId, name, subs] of [
    [CAT_FROMAGES, "Fromages", [[SUB_CHEVRES, "Chèvres"], [SUB_BREBIS, "Brebis"]]],
    [CAT_BOISSONS, "Boissons", []],
  ] as const) {
    const toProducts = (rows: Awaited<ReturnType<typeof scopeRows>>) =>
      rows.map((r) => ({
        product_id: r.id, category_id: r.category_id, subcategory_id: r.subcategory_id, name: r.name,
        display_order: r.display_order, is_available: r.is_available, archived_at: r.archived_at,
      }));
    const subcategories = [];
    for (const [subId, subName] of subs) {
      subcategories.push({ subcategory_id: subId, subcategory_name: subName, products: toProducts(await scopeRows(db, categoryId, subId)) });
    }
    categories.push({ category_id: categoryId, category_name: name, products: toProducts(await scopeRows(db, categoryId, null)), subcategories });
  }
  return categories;
}

const ALL_OF_B = `category_id = '${CAT_B}'`;

// ==================================================================
// Installation
// ==================================================================

test("le DRAFT s'applique sur une base conforme SANS modifier la moindre donnée (aucun backfill), et installe une RPC SECURITY DEFINER réservée à authenticated", async () => {
  const fresh = await makeBaselineDb();
  try {
    await seed(fresh);
    const orderBefore = await orderFingerprint(fresh);
    const restBefore = await nonOrderFingerprint(fresh);
    await fresh.exec(readSql(LOT_SQL));
    assert.equal(await orderFingerprint(fresh), orderBefore, "(id, display_order) de tous les produits inchangé");
    assert.equal(await nonOrderFingerprint(fresh), restBefore, "aucune autre colonne modifiée");

    const fn = await fresh.query<{ args: string; result: string; secdef: boolean; config: string[]; anon: boolean; service: boolean; auth: boolean }>(`
      select pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as result,
             p.prosecdef as secdef, p.proconfig as config,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
             has_function_privilege('service_role', p.oid, 'EXECUTE') as service,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
      from pg_proc p where p.oid = 'public.move_product_order(uuid, text, jsonb)'::regprocedure`);
    assert.deepEqual(fn.rows, [{
      args: "p_product_id uuid, p_direction text, p_expected_scope jsonb", result: "integer",
      secdef: true, config: ['search_path=""'], anon: false, service: false, auth: true,
    }]);
  } finally {
    await fresh.close();
  }
});

// ==================================================================
// Déplacements et bornes, à travers le vrai service
// ==================================================================

test("MILIEU vers le HAUT : la RPC retourne la nouvelle position et persiste l'échange", async () => {
  const position = await moveProductOrder(P.beaufort, "up", await displayedView(CAT_FROMAGES, null));
  assert.equal(position, 1);
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Beaufort=1|Comté=2|Abondance=3");
  assert.deepEqual(requests[0].body, {
    p_product_id: P.beaufort,
    p_direction: "up",
    p_expected_scope: [
      { id: P.comte, display_order: 1, name: "Comté" },
      { id: P.beaufort, display_order: 2, name: "Beaufort" },
      { id: P.abondance, display_order: 3, name: "Abondance" },
    ],
  });
});

test("MILIEU vers le BAS : la RPC retourne la nouvelle position et persiste l'échange (produit indisponible déplacé comme les autres)", async () => {
  const position = await moveProductOrder(P.beaufort, "down", await displayedView(CAT_FROMAGES, null));
  assert.equal(position, 3);
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Comté=1|Abondance=2|Beaufort=3");
});

test("le PREMIER ne peut pas monter : refus serveur typé (ProductOrderBoundaryError), aucune écriture", async () => {
  const before = await orderFingerprint(db);
  await assert.rejects(moveProductOrder(P.comte, "up", await displayedView(CAT_FROMAGES, null)), ProductOrderBoundaryError);
  assert.equal(await orderFingerprint(db), before);
});

test("le DERNIER ne peut pas descendre : refus serveur typé, aucune écriture", async () => {
  const before = await orderFingerprint(db);
  await assert.rejects(moveProductOrder(P.abondance, "down", await displayedView(CAT_FROMAGES, null)), ProductOrderBoundaryError);
  assert.equal(await orderFingerprint(db), before);
});

// ==================================================================
// Périmètres
// ==================================================================

test("PÉRIMÈTRE SOUS-CATÉGORIE : déplacer un produit de Chèvres ne touche ni les produits directs, ni Brebis, ni Boissons, ni le produit archivé du périmètre", async () => {
  const others = async () => [
    await scopeState(db, CAT_FROMAGES, null), await scopeState(db, CAT_FROMAGES, SUB_BREBIS), await scopeState(db, CAT_BOISSONS, null),
    await orderFingerprint(db, `id = '${P.ancien}'`),
  ];
  const before = await others();
  await moveProductOrder(P.crottin, "up", await displayedView(CAT_FROMAGES, SUB_CHEVRES));
  assert.equal(await scopeState(db, CAT_FROMAGES, SUB_CHEVRES), "crottin=1|Banon=2|Zeste de chèvre=3|éclat cendré=4");
  assert.deepEqual(await others(), before);
});

test("REPLI CATÉGORIE : déplacer un produit direct ne touche aucune sous-catégorie de sa catégorie", async () => {
  const subs = async () => [await scopeState(db, CAT_FROMAGES, SUB_CHEVRES), await scopeState(db, CAT_FROMAGES, SUB_BREBIS), await scopeState(db, CAT_BOISSONS, null)];
  const before = await subs();
  await moveProductOrder(P.abondance, "up", await displayedView(CAT_FROMAGES, null));
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Comté=1|Abondance=2|Beaufort=3");
  assert.deepEqual(await subs(), before);
});

test("AUCUN DÉPLACEMENT ENTRE CATÉGORIES : la RPC n'écrit jamais category_id / subcategory_id, et refuse toute liste mêlant un autre périmètre", async () => {
  const rest = await nonOrderFingerprint(db);
  const direct = await displayedOrder(CAT_FROMAGES, null);
  // Produit d'une autre catégorie, d'une sous-catégorie de la même
  // catégorie, produit archivé, liste d'un autre périmètre.
  for (const expected of [
    [...direct, P.eau],
    [...direct, P.banon],
    [P.eau, P.jus, P.cidre],
  ]) {
    await assert.rejects(moveProductOrder(P.beaufort, "up", await viewOf(expected)), ProductOrderStaleError);
  }
  await assert.rejects(
    moveProductOrder(P.banon, "down", await viewOf([...(await displayedOrder(CAT_FROMAGES, SUB_CHEVRES)), P.ancien])),
    ProductOrderStaleError
  );
  // SUBSTITUTIONS À CARDINALITÉ ÉGALE : la liste a la taille exacte du
  // périmètre, un membre est remplacé par un produit étranger -- autre
  // sous-catégorie, autre catégorie, produit direct dans une liste de
  // sous-catégorie, produit archivé du même périmètre. La taille ne
  // trahit rien : seule l'appartenance de CHAQUE élément refuse.
  for (const [productId, expected] of [
    [P.abondance, [P.comte, P.beaufort, P.banon]],
    [P.abondance, [P.beaufort, P.abondance, P.eau]],
    [P.zeste, [P.banon, P.crottin, P.zeste, P.comte]],
    [P.zeste, [P.banon, P.zeste, P.eclat, P.ancien]],
  ] as const) {
    await assert.rejects(moveProductOrder(productId, "up", await viewOf(expected)), ProductOrderStaleError);
  }
  assert.equal(await nonOrderFingerprint(db), rest);
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Comté=1|Beaufort=2|Abondance=3");
  assert.equal(await scopeState(db, CAT_FROMAGES, SUB_CHEVRES), "Banon=0|Zeste de chèvre=0|crottin=0|éclat cendré=0");
  // Puis de vrais déplacements dans trois périmètres.
  await moveProductOrder(P.beaufort, "up", await viewOf(direct));
  await moveProductOrder(P.roquefort, "up", await displayedView(CAT_FROMAGES, SUB_BREBIS));
  await moveProductOrder(P.jus, "down", await displayedView(CAT_BOISSONS, null));
  assert.equal(await nonOrderFingerprint(db), rest, "taxonomie, disponibilité, prix, noms, archivage : strictement inchangés");
});

// ==================================================================
// Isolation entre établissements, rôles
// ==================================================================

test("ISOLATION : le propriétaire de B, un inconnu et le staff de A ne peuvent pas réordonner un produit de A (refus serveur, jamais « périmé »), rien n'est écrit", async () => {
  const before = await orderFingerprint(db);
  const expected = await displayedView(CAT_FROMAGES, null);
  for (const who of [OWNER_B, STRANGER, STAFF_A]) {
    user = who;
    await assert.rejects(moveProductOrder(P.beaufort, "up", expected), (e: Error) => {
      assert.ok(!(e instanceof ProductOrderStaleError) && !(e instanceof ProductOrderBoundaryError));
      assert.match(e.message, /Not authorized for this product/);
      return true;
    });
  }
  user = "";
  await assert.rejects(moveProductOrder(P.beaufort, "up", expected), /Authentication required/);
  assert.equal(await orderFingerprint(db), before);
});

test("ISOLATION : le propriétaire de A ne peut ni viser un produit de B, ni glisser un produit de B dans sa liste ; l'établissement B reste intact", async () => {
  const b = await orderFingerprint(db, ALL_OF_B);
  await assert.rejects(moveProductOrder(P.bUn, "up", await viewOf([P.bDeux, P.bTrois, P.bUn])), /Not authorized for this product/);
  await assert.rejects(
    moveProductOrder(P.beaufort, "up", await viewOf([...(await displayedOrder(CAT_FROMAGES, null)), P.bUn])),
    ProductOrderStaleError
  );
  // … ni le SUBSTITUER à l'un des siens (liste de même taille que le
  // périmètre), même en fournissant les VRAIES valeurs du produit de B.
  await assert.rejects(moveProductOrder(P.beaufort, "up", await viewOf([P.comte, P.beaufort, P.bUn])), ProductOrderStaleError);
  // AUCUN ORACLE : le refus est le même pour un produit de B bien
  // décrit, mal décrit, ou un identifiant qui n'existe nulle part.
  const ghost = "00000000-0000-0000-0000-00000000dead";
  for (const foreign of [
    { id: P.bUn, display_order: 0, name: "B-Un" },
    { id: P.bUn, display_order: 7, name: "inventé" },
    { id: ghost, display_order: 0, name: "B-Un" },
  ]) {
    const forged = [...(await viewOf([P.comte, P.beaufort])), foreign];
    await assert.rejects(moveProductOrder(P.beaufort, "up", forged), ProductOrderStaleError);
  }
  assert.equal(await orderFingerprint(db, ALL_OF_B), b);
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Comté=1|Beaufort=2|Abondance=3");
});

test("RÔLES : manager de A et opérateur Scanym (sans rattachement) sont autorisés ; le rôle anon n'a pas le droit d'exécuter la RPC", async () => {
  user = MANAGER_A;
  assert.equal(await moveProductOrder(P.beaufort, "up", await displayedView(CAT_FROMAGES, null)), 1);
  user = OPERATOR;
  assert.equal(await moveProductOrder(P.beaufort, "down", await displayedView(CAT_FROMAGES, null)), 2);
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Comté=1|Beaufort=2|Abondance=3");

  const direct = await displayedView(CAT_FROMAGES, null);
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.exec("set local role anon");
      await tx.query("select public.move_product_order($1::uuid, 'up', $2::text::jsonb)", [P.beaufort, JSON.stringify(direct)]);
    }),
    /permission denied/
  );
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.exec("set local role authenticated");
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [OWNER_A]);
      await tx.query("update public.menu_items set display_order = 99 where id = $1", [P.beaufort]);
    }),
    /permission denied/,
    "le propriétaire lui-même ne peut pas écrire display_order en direct : seule la RPC écrit"
  );
});

// ==================================================================
// Catalogue historique : le comparateur de production fait foi
// ==================================================================

test("CATALOGUE HISTORIQUE (ex æquo) : l'ordre calculé par le comparateur de PRODUCTION est accepté par la RPC, qui matérialise exactement cet ordre + le seul échange demandé", async () => {
  const shown = await displayedOrder(CAT_FROMAGES, SUB_CHEVRES);
  assert.deepEqual(shown, [P.banon, P.crottin, P.zeste, P.eclat], "ordre affiché avant tout geste (é après z : ordinal)");
  assert.deepEqual(await storefrontOrder(CAT_FROMAGES, SUB_CHEVRES), shown, "… et c'est l'ordre de la carte client");

  assert.equal(await moveProductOrder(P.zeste, "up", await displayedView(CAT_FROMAGES, SUB_CHEVRES)), 2);
  assert.equal(await scopeState(db, CAT_FROMAGES, SUB_CHEVRES), "Banon=1|Zeste de chèvre=2|crottin=3|éclat cendré=4");
  assert.deepEqual(await displayedOrder(CAT_FROMAGES, SUB_CHEVRES), [P.banon, P.zeste, P.crottin, P.eclat]);
});

test("ex æquo d'un état FRAIS : l'ordre affiché est celui de l'appelant ; dès que les valeurs stockées sont distinctes, un ordre qui les contredit est refusé même avec des valeurs fraîches", async () => {
  // État frais (les quatre display_order à 0, noms à jour) : la base
  // ne départage pas les ex æquo, l'ordre AFFICHÉ fait foi.
  await moveProductOrder(P.banon, "up", await viewOf([P.eclat, P.zeste, P.crottin, P.banon]));
  assert.equal(await scopeState(db, CAT_FROMAGES, SUB_CHEVRES), "éclat cendré=1|Zeste de chèvre=2|Banon=3|crottin=4");
  // Valeurs désormais distinctes : même avec les valeurs COURANTES de
  // chaque produit, un ordre qui contredit la base est refusé.
  const before = await orderSnapshot();
  await assert.rejects(moveProductOrder(P.banon, "up", await viewOf([P.banon, P.crottin, P.zeste, P.eclat])), ProductOrderStaleError);
  await assert.rejects(moveProductOrder(P.banon, "up", await viewOf([P.eclat, P.banon, P.zeste, P.crottin])), ProductOrderStaleError);
  assert.equal(await orderSnapshot(), before);
  assert.equal(await moveProductOrder(P.banon, "up", await viewOf([P.eclat, P.zeste, P.banon, P.crottin])), 2);
});

// ==================================================================
// Écran <-> serveur : même résultat, déterministe après rechargement
// ==================================================================

test("ORDRE DÉTERMINISTE APRÈS RECHARGEMENT : après chaque déplacement accepté, l'état que l'écran applique localement (applyProductMove) est EXACTEMENT celui relu en base", async () => {
  const ids = [P.comte, P.beaufort, P.abondance, P.zeste, P.eclat, P.banon, P.crottin, P.ossau, P.roquefort, P.eau, P.jus, P.cidre];
  let a = 4242;
  const rand = (n: number) => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return Math.floor((a / 4294967296) * n);
  };
  let accepted = 0;
  for (let i = 0; i < 80; i++) {
    const productId = ids[rand(ids.length)];
    const direction = rand(2) === 0 ? "up" : "down";
    const catalogue = await loadBackOfficeCatalogue();
    const scope = findProductOrderScope(catalogue, productId)!;
    const local = applyProductMove(catalogue, productId, direction);
    if (!local) {
      // Borne côté écran -> le serveur refuse lui aussi.
      await assert.rejects(moveProductOrder(productId, direction, scope.expected), ProductOrderBoundaryError);
      continue;
    }
    assert.equal(await moveProductOrder(productId, direction, scope.expected), local.position);
    accepted++;

    // État local de l'écran == état relu en base, pour TOUT le catalogue.
    const reloaded = await loadBackOfficeCatalogue();
    const flat = (cats: any[]) =>
      Object.fromEntries(cats.flatMap((c) => [...c.products, ...c.subcategories.flatMap((s: any) => s.products)]).map((p: any) => [p.product_id, p.display_order]));
    assert.deepEqual(flat(local.categories), flat(reloaded));
    // … et l'ordre affiché après rechargement == l'ordre local.
    assert.deepEqual(findProductOrderScope(reloaded, productId)!.orderedIds, findProductOrderScope(local.categories, productId)!.orderedIds);
    // … et la VUE que l'écran transmettrait au prochain geste est déjà
    // la vue fraîche : enchaîner des déplacements sans recharger ne
    // produit jamais de faux « périmé ».
    assert.deepEqual(findProductOrderScope(local.categories, productId)!.expected, findProductOrderScope(reloaded, productId)!.expected);
  }
  assert.ok(accepted >= 30, `des déplacements doivent réellement avoir lieu (${accepted})`);
  // Relire deux fois donne deux fois la même chose.
  assert.deepEqual(await displayedOrder(CAT_FROMAGES, SUB_CHEVRES), await displayedOrder(CAT_FROMAGES, SUB_CHEVRES));
});

test("LA CARTE CLIENT SUIT LE BACK-OFFICE : après réordonnancement, l'ordre lu sous le rôle anon (produits disponibles) est l'ordre du back-office, l'indisponible masqué sans changer l'ordre relatif des autres", async () => {
  await moveProductOrder(P.abondance, "up", await displayedView(CAT_FROMAGES, null));
  await moveProductOrder(P.abondance, "up", await displayedView(CAT_FROMAGES, null));
  await moveProductOrder(P.beaufort, "up", await displayedView(CAT_FROMAGES, null));
  await moveProductOrder(P.eclat, "up", await displayedView(CAT_FROMAGES, SUB_CHEVRES));
  await moveProductOrder(P.cidre, "up", await displayedView(CAT_BOISSONS, null));

  assert.deepEqual(await displayedOrder(CAT_FROMAGES, null), [P.abondance, P.beaufort, P.comte]);
  assert.deepEqual(await storefrontOrder(CAT_FROMAGES, null), [P.beaufort, P.comte], "Abondance (indisponible) n'apparaît pas");
  for (const [categoryId, subId] of [[CAT_FROMAGES, SUB_CHEVRES], [CAT_FROMAGES, SUB_BREBIS], [CAT_BOISSONS, null]] as const) {
    assert.deepEqual(await storefrontOrder(categoryId, subId), await displayedOrder(categoryId, subId));
  }
});

// ==================================================================
// Concurrence (entrelacements)
// ==================================================================

test("CONCURRENCE : deux clients partis de la MÊME vue -- le premier est appliqué, le second est refusé comme périmé ; jamais d'écriture par-dessus, jamais de position dupliquée", async () => {
  const view = await displayedView(CAT_FROMAGES, null);
  user = OWNER_A;
  await moveProductOrder(P.abondance, "up", view);
  user = MANAGER_A;
  await assert.rejects(moveProductOrder(P.beaufort, "up", view), ProductOrderStaleError);
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Comté=1|Abondance=2|Beaufort=3");
  // Après rechargement, le second client obtient son déplacement.
  await moveProductOrder(P.beaufort, "up", await displayedView(CAT_FROMAGES, null));
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Comté=1|Beaufort=2|Abondance=3");
});

test("CONCURRENCE : rejouer une requête DÉJÀ appliquée (double clic, retry réseau) est refusé -- un déplacement n'est jamais appliqué deux fois", async () => {
  const view = await displayedView(CAT_BOISSONS, null);
  await moveProductOrder(P.cidre, "up", view);
  await assert.rejects(moveProductOrder(P.cidre, "up", view), ProductOrderStaleError);
  assert.equal(await scopeState(db, CAT_BOISSONS, null), "Eau=1|Cidre=2|Jus=3");
});

test("CONCURRENCE : huit clients, même vue de départ, sur un groupe d'ex æquo -- exactement UN déplacement accepté, positions finales 1..N toutes distinctes", async () => {
  const view = await displayedView(CAT_FROMAGES, SUB_CHEVRES);
  const outcomes = await Promise.allSettled(
    [P.zeste, P.crottin, P.eclat, P.banon, P.zeste, P.eclat, P.crottin, P.zeste].map((id, i) =>
      moveProductOrder(id, i % 2 === 0 ? "up" : "down", view)
    )
  );
  const accepted = outcomes.filter((o) => o.status === "fulfilled");
  const stale = outcomes.filter((o) => o.status === "rejected" && o.reason instanceof ProductOrderStaleError);
  assert.equal(accepted.length, 1);
  assert.equal(stale.length, 7);
  const rows = await scopeRows(db, CAT_FROMAGES, SUB_CHEVRES);
  assert.deepEqual(rows.map((r) => r.display_order).sort(), [1, 2, 3, 4]);
});

test("CONCURRENCE : la fonction installée prend le verrou transactionnel d'établissement puis verrouille les lignes du périmètre (FOR NO KEY UPDATE)", async () => {
  const r = await db.query<{ def: string }>("select pg_get_functiondef('public.move_product_order(uuid, text, jsonb)'::regprocedure) as def");
  const def = r.rows[0].def;
  assert.ok(def.includes("pg_advisory_xact_lock(hashtextextended(v_restaurant_id::text, 2701))"));
  assert.equal((def.match(/for no key update;/g) ?? []).length, 2);
});

test("un changement de périmètre entre-temps (création, archivage) rend la vue périmée ; un produit archivé ne se réordonne pas", async () => {
  const view = await displayedView(CAT_BOISSONS, null);
  await db.query("insert into public.menu_items (category_id, name, display_order) values ($1, 'Limonade', 15)", [CAT_BOISSONS]);
  await assert.rejects(moveProductOrder(P.jus, "up", view), ProductOrderStaleError);

  await db.query("update public.menu_items set archived_at = now() where id = $1", [P.cidre]);
  await assert.rejects(moveProductOrder(P.cidre, "up", await displayedView(CAT_BOISSONS, null)), /Product not found or archived/);
  const fresh = await displayedView(CAT_BOISSONS, null);
  assert.equal(fresh.some((e) => e.id === P.cidre), false);
  await moveProductOrder(P.jus, "up", fresh);
  assert.equal(await scopeState(db, CAT_BOISSONS, null), "Jus=1|Eau=2|Limonade=3");
  const archived = await db.query<{ display_order: number }>("select display_order from public.menu_items where id = $1", [P.cidre]);
  assert.equal(archived.rows[0].display_order, 14, "la valeur d'un produit archivé n'est pas réécrite");
});

// ==================================================================
// [CPR-01] FRAÎCHEUR DE LA VUE -- remédiation CPR-AUDIT-01
//
// Les dix cas du mandat, à travers le VRAI service et le VRAI SQL.
// Patron : le client charge sa vue ; un AUTRE utilisateur modifie
// l'état ; le client périmé demande un déplacement avec SA vue.
// Attendu : ProductOrderStaleError, et la base identique OCTET POUR
// OCTET (valeurs et versions de ligne de TOUS les produits).
// ==================================================================

async function assertStaleNoWrite(productId: string, direction: "up" | "down", staleView: Entry[], label: string) {
  const before = await orderSnapshot();
  const rest = await nonOrderFingerprint(db);
  const sent = requests.length;
  await assert.rejects(moveProductOrder(productId, direction, staleView), ProductOrderStaleError, `${label} : vue périmée refusée`);
  // La vue périmée est bien partie TELLE QUELLE sur le réseau (le refus
  // vient du serveur, pas d'un filtrage côté client).
  assert.equal(requests.length, sent + 1, label);
  assert.deepEqual(requests[sent].body.p_expected_scope, staleView, label);
  assert.equal(await orderSnapshot(), before, `${label} : aucun display_order modifié, aucune ligne réécrite`);
  assert.equal(await nonOrderFingerprint(db), rest, `${label} : aucune autre colonne modifiée`);
}

test("[CPR-01] 1. REPRODUCTION EXACTE DE L'AUDIT : Comté=1 Beaufort=2 Abondance=3 ; un autre utilisateur passe Comté à 2 ; le client périmé [Comté, Beaufort, Abondance] demande « Abondance UP » -> VUE PÉRIMÉE REFUSÉE, AUCUNE ÉCRITURE", async () => {
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Comté=1|Beaufort=2|Abondance=3");
  const stale = await displayedView(CAT_FROMAGES, null);
  assert.deepEqual(stale, [
    { id: P.comte, display_order: 1, name: "Comté" },
    { id: P.beaufort, display_order: 2, name: "Beaufort" },
    { id: P.abondance, display_order: 3, name: "Abondance" },
  ]);

  await otherUser("select public.set_product_order($1::uuid, 2)", [P.comte]);
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Beaufort=2|Comté=2|Abondance=3");
  // L'ordre VISIBLE qui fait autorité est devenu Beaufort, Comté, Abondance.
  assert.deepEqual(await displayedOrder(CAT_FROMAGES, null), [P.beaufort, P.comte, P.abondance]);
  assert.deepEqual(await storefrontOrder(CAT_FROMAGES, null), [P.beaufort, P.comte], "carte client (Abondance indisponible)");

  // Ce que la première version vérifiait PASSE toujours sur cette vue
  // périmée : mêmes identifiants, display_order stockés non
  // décroissants le long de la liste (2, 2, 3). C'est pourquoi elle
  // l'acceptait.
  const storedAlongStaleList = (await viewOf(stale.map((e) => e.id))).map((e) => e.display_order);
  assert.deepEqual(storedAlongStaleList, [2, 2, 3]);

  await assertStaleNoWrite(P.abondance, "up", stale, "audit");
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Beaufort=2|Comté=2|Abondance=3", "le changement validé par l'autre utilisateur n'est pas écrasé");

  // Après rechargement, le même geste s'applique à l'ordre RÉEL.
  assert.equal(await moveProductOrder(P.abondance, "up", await displayedView(CAT_FROMAGES, null)), 2);
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Beaufort=1|Abondance=2|Comté=3");
});

test("[CPR-01] 2. EX ÆQUO INTRODUIT par un autre utilisateur après le chargement -> refusé, aucune écriture", async () => {
  const stale = await displayedView(CAT_BOISSONS, null);
  await otherUser("select public.set_product_order($1::uuid, 9)", [P.cidre]);
  assert.equal(await scopeState(db, CAT_BOISSONS, null), "Eau=5|Cidre=9|Jus=9");
  assert.deepEqual(await displayedOrder(CAT_BOISSONS, null), [P.eau, P.cidre, P.jus], "l'ordre visible a changé (Cidre avant Jus)");
  for (const [productId, direction] of [[P.jus, "up"], [P.cidre, "up"], [P.eau, "down"]] as const) {
    await assertStaleNoWrite(productId, direction, stale, "ex æquo introduit");
  }
});

test("[CPR-01] 3. EX ÆQUO SUPPRIMÉ par un autre utilisateur après le chargement -> refusé, aucune écriture (que l'ordre visible change ou non)", async () => {
  // a) Banon quitte l'ex æquo et passe de premier à dernier.
  let stale = await displayedView(CAT_FROMAGES, SUB_CHEVRES);
  await otherUser("select public.set_product_order($1::uuid, 7)", [P.banon]);
  assert.deepEqual(await displayedOrder(CAT_FROMAGES, SUB_CHEVRES), [P.crottin, P.zeste, P.eclat, P.banon]);
  await assertStaleNoWrite(P.crottin, "up", stale, "ex æquo supprimé (ordre changé)");

  // b) Banon quitte l'ex æquo SANS changer de place (0 -> -1 : toujours
  //    premier). La vue périmée reste « monotone » : la première
  //    version l'acceptait. L'état, lui, n'est plus celui de la vue.
  await seed(db);
  stale = await displayedView(CAT_FROMAGES, SUB_CHEVRES);
  await otherUser("select public.set_product_order($1::uuid, -1)", [P.banon]);
  assert.deepEqual(await displayedOrder(CAT_FROMAGES, SUB_CHEVRES), stale.map((e) => e.id), "même ordre visible");
  await assertStaleNoWrite(P.zeste, "up", stale, "ex æquo supprimé (ordre inchangé)");
});

test("[CPR-01] 4. CHAMP DE DÉPARTAGE modifié alors que TOUS les display_order sont identiques -> refusé, aucune écriture", async () => {
  const stale = await displayedView(CAT_FROMAGES, SUB_CHEVRES);
  assert.deepEqual(stale.map((e) => e.id), [P.banon, P.crottin, P.zeste, P.eclat]);
  const orderBefore = await orderFingerprint(db);
  // Un autre utilisateur renomme Banon : aucun display_order ne bouge,
  // mais le départage par nom le fait passer de premier à troisième.
  await db.query("update public.menu_items set name = 'Tomme de Banon' where id = $1", [P.banon]);
  assert.equal(await orderFingerprint(db), orderBefore, "(id, display_order) strictement inchangé");
  assert.deepEqual(await displayedOrder(CAT_FROMAGES, SUB_CHEVRES), [P.crottin, P.banon, P.zeste, P.eclat], "l'ordre visible a changé");
  for (const [productId, direction] of [[P.crottin, "up"], [P.zeste, "up"], [P.banon, "down"], [P.eclat, "up"]] as const) {
    await assertStaleNoWrite(productId, direction, stale, "départage modifié");
  }
});

test("[CPR-01] 5. PRODUIT INSÉRÉ dans le périmètre après le chargement -> refusé, aucune écriture (y compris à cardinalité égale)", async () => {
  let stale = await displayedView(CAT_BOISSONS, null);
  await db.query("insert into public.menu_items (category_id, name, display_order) values ($1, 'Limonade', 15)", [CAT_BOISSONS]);
  await assertStaleNoWrite(P.jus, "up", stale, "produit inséré");

  // Même TAILLE de périmètre : un produit en sort, un autre y entre.
  await seed(db);
  stale = await displayedView(CAT_BOISSONS, null);
  await db.query("update public.menu_items set archived_at = now() where id = $1", [P.cidre]);
  await db.query("insert into public.menu_items (category_id, name, display_order) values ($1, 'Limonade', 14)", [CAT_BOISSONS]);
  assert.equal((await scopeRows(db, CAT_BOISSONS, null)).length, stale.length, "même cardinalité");
  await assertStaleNoWrite(P.jus, "up", stale, "produit remplacé (même cardinalité)");
});

test("[CPR-01] 6. PRODUIT ARCHIVÉ ou RETIRÉ du périmètre après le chargement -> refusé, aucune écriture", async () => {
  let stale = await displayedView(CAT_BOISSONS, null);
  await db.query("update public.menu_items set archived_at = now() where id = $1", [P.cidre]);
  await assertStaleNoWrite(P.jus, "up", stale, "produit archivé");

  // Changement de sous-catégorie : le produit quitte son périmètre.
  await seed(db);
  stale = await displayedView(CAT_FROMAGES, SUB_BREBIS);
  const destination = await displayedView(CAT_FROMAGES, SUB_CHEVRES);
  await db.query("update public.menu_items set subcategory_id = $2 where id = $1", [P.ossau, SUB_CHEVRES]);
  await assertStaleNoWrite(P.roquefort, "up", stale, "produit sorti (celui qui reste)");
  await assertStaleNoWrite(P.ossau, "down", stale, "produit sorti (celui qui part, vue de son ancien périmètre)");
  // … et la vue du périmètre d'ARRIVÉE, chargée avant, est périmée aussi.
  await assertStaleNoWrite(P.crottin, "up", destination, "produit entré (périmètre d'arrivée)");
});

test("[CPR-01] 7. PRODUIT RENOMMÉ après le chargement (le nom participe au départage) -> refusé, aucune écriture ; la comparaison est faite octet pour octet", async () => {
  // Périmètre DENSE : le renommage ne change pas l'ordre visible. La
  // vue n'en est pas moins périmée -- l'état n'est plus celui chargé.
  const stale = await displayedView(CAT_FROMAGES, null);
  await db.query("update public.menu_items set name = $2 where id = $1", [P.beaufort, "Beaufort d'alpage"]);
  await assertStaleNoWrite(P.abondance, "up", stale, "renommé");
  assert.equal(await moveProductOrder(P.abondance, "up", await displayedView(CAT_FROMAGES, null)), 2, "vue rechargée (apostrophe comprise) : acceptée");

  // Renommages que seule une comparaison OCTET POUR OCTET distingue :
  // casse, espace finale, forme Unicode décomposée (même rendu à
  // l'écran, autres octets).
  for (const renamed of ["comté", "Comté ", "Comté", "COMTÉ"]) {
    await seed(db);
    const view = await displayedView(CAT_FROMAGES, null);
    assert.equal(view[0].name, "Comté");
    await db.query("update public.menu_items set name = $2 where id = $1", [P.comte, renamed]);
    await assertStaleNoWrite(P.beaufort, "down", view, `renommé en ${JSON.stringify(renamed)}`);
    // … et la vue rechargée, qui porte EXACTEMENT ce nom, est acceptée.
    const reloaded = await displayedView(CAT_FROMAGES, null);
    assert.ok(reloaded.some((e) => e.id === P.comte && e.name === renamed));
    await moveProductOrder(P.beaufort, "down", reloaded);
  }
});

test("[CPR-01] 8. LA VUE FRAÎCHE AUTORISE LE DÉPLACEMENT : périmètre dense, ex æquo historiques, et état modifié par un autre utilisateur puis rechargé", async () => {
  assert.equal(await moveProductOrder(P.abondance, "up", await displayedView(CAT_FROMAGES, null)), 2);
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Comté=1|Abondance=2|Beaufort=3");

  assert.equal(await moveProductOrder(P.crottin, "up", await displayedView(CAT_FROMAGES, SUB_CHEVRES)), 1);
  assert.equal(await scopeState(db, CAT_FROMAGES, SUB_CHEVRES), "crottin=1|Banon=2|Zeste de chèvre=3|éclat cendré=4");

  // Un ex æquo créé par un autre utilisateur n'empêche pas de
  // travailler : après rechargement, la vue fraîche est acceptée.
  await otherUser("select public.set_product_order($1::uuid, 5)", [P.jus]);
  const fresh = await displayedView(CAT_BOISSONS, null);
  assert.deepEqual(fresh.map((e) => [e.name, e.display_order]), [["Eau", 5], ["Jus", 5], ["Cidre", 14]]);
  assert.equal(await moveProductOrder(P.cidre, "up", fresh), 2);
  assert.equal(await scopeState(db, CAT_BOISSONS, null), "Eau=1|Cidre=2|Jus=3");

  // Une vue fraîche le reste tant que rien ne change : la relire sans
  // rien toucher donne la même vue, toujours acceptée.
  const again = await displayedView(CAT_BOISSONS, null);
  assert.deepEqual(again, await displayedView(CAT_BOISSONS, null));
  assert.equal(await moveProductOrder(P.cidre, "down", again), 3);
});

test("[CPR-01] 9. UN REFUS NE CHANGE AUCUN display_order, octet pour octet : rafale de vues périmées dans quatre périmètres contre un état modifié par un autre utilisateur", async () => {
  const views = {
    direct: await displayedView(CAT_FROMAGES, null),
    boissons: await displayedView(CAT_BOISSONS, null),
    chevres: await displayedView(CAT_FROMAGES, SUB_CHEVRES),
    brebis: await displayedView(CAT_FROMAGES, SUB_BREBIS),
  };
  await otherUser("select public.set_product_order($1::uuid, 2)", [P.comte]);
  await otherUser("select public.set_product_order($1::uuid, 9)", [P.cidre]);
  await otherUser("select public.set_product_order($1::uuid, -1)", [P.banon]);
  await otherUser("select public.set_product_order($1::uuid, 4)", [P.roquefort]);

  const raw = async () =>
    (await db.query<{ v: string }>("select string_agg(id::text || '=' || display_order::text, ',' order by id) as v from public.menu_items")).rows[0].v;
  const before = await raw();
  const snapshot = await orderSnapshot();
  const attempts: [string, "up" | "down", Entry[]][] = [
    [P.abondance, "up", views.direct], [P.beaufort, "up", views.direct], [P.comte, "down", views.direct],
    [P.jus, "up", views.boissons], [P.cidre, "up", views.boissons], [P.eau, "down", views.boissons],
    [P.crottin, "up", views.chevres], [P.zeste, "down", views.chevres], [P.eclat, "up", views.chevres],
    [P.roquefort, "up", views.brebis], [P.ossau, "down", views.brebis],
  ];
  for (const [productId, direction, view] of attempts) {
    await assert.rejects(moveProductOrder(productId, direction, view), ProductOrderStaleError);
  }
  assert.equal(await raw(), before, "chaque display_order de la base est inchangé");
  assert.equal(await orderSnapshot(), snapshot, "aucune ligne n'a été réécrite, pas même avec la même valeur");
});

test("[CPR-01] 10. DEUX DÉPLACEURS CONCURRENTS partis de la même vue : le premier est ACCEPTÉ, le second -- calculé sur un état qui n'existe plus -- est REFUSÉ comme périmé", async () => {
  const view = await displayedView(CAT_FROMAGES, null);
  const [first, second] = await Promise.allSettled([
    moveProductOrder(P.abondance, "up", view),
    moveProductOrder(P.beaufort, "up", view),
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.ok((second as PromiseRejectedResult).reason instanceof ProductOrderStaleError);
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Comté=1|Abondance=2|Beaufort=3", "seul le premier déplacement est appliqué");

  // Symétrique -- l'« autre utilisateur » de l'audit valide juste avant
  // le déplaceur : même refus.
  await seed(db);
  const auditView = await displayedView(CAT_FROMAGES, null);
  const outcomes = await Promise.allSettled([
    otherUser("select public.set_product_order($1::uuid, 2)", [P.comte]),
    moveProductOrder(P.abondance, "up", auditView),
  ]);
  assert.equal(outcomes[0].status, "fulfilled");
  assert.ok(outcomes[1].status === "rejected" && outcomes[1].reason instanceof ProductOrderStaleError);
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Beaufort=2|Comté=2|Abondance=3");
});

test("[CPR-01] la vue doit être CELLE REÇUE, type JSON compris : une valeur d'un autre type qui « s'écrit pareil » (name 7 pour « 7 », true pour « true », display_order \"3\" ou 3.0 pour 3) est refusée, sans erreur de conversion et sans écriture", async () => {
  /** Appel SQL direct avec une charge JSON donnée TELLE QUELLE (texte). */
  const rawCall = async (productId: string, direction: string, json: string) => {
    try {
      await db.transaction(async (tx) => {
        await tx.exec("set local role authenticated");
        await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [OWNER_A]);
        await tx.query("select public.move_product_order($1::uuid, $2::text, $3::text::jsonb)", [productId, direction, json]);
      });
      return "moved";
    } catch (error) {
      const e = error as { code?: string; message?: string };
      return `${e.code}:${e.message}`;
    }
  };
  const STALE = "P0001:SCANYM_PRODUCT_ORDER_STALE";

  // Des produits dont le NOM est le texte d'un nombre ou d'un booléen.
  await db.query("update public.menu_items set name = '7' where id = $1", [P.eau]);
  await db.query("update public.menu_items set name = 'true' where id = $1", [P.jus]);
  const view = await viewOf([P.eau, P.jus, P.cidre]);
  assert.deepEqual(view.map((e) => e.name), ["7", "true", "Cidre"]);
  const before = await orderSnapshot();
  const json = (mutate: (v: any[]) => void) => {
    const copy = JSON.parse(JSON.stringify(view));
    mutate(copy);
    return JSON.stringify(copy);
  };

  assert.equal(await rawCall(P.jus, "down", json((v) => { v[0].name = 7; })), STALE, "name : nombre 7 au lieu de la chaîne « 7 »");
  assert.equal(await rawCall(P.jus, "down", json((v) => { v[1].name = true; })), STALE, "name : booléen true au lieu de la chaîne « true »");
  assert.equal(await rawCall(P.jus, "down", json((v) => { v[0].display_order = "5"; })), STALE, "display_order : chaîne « 5 » au lieu du nombre 5");
  assert.equal(await rawCall(P.jus, "down", json((v) => { v[2].id = [v[2].id]; })), STALE, "id : tableau contenant l'identifiant");
  // Même valeur numérique, autre écriture que celle du serveur.
  assert.equal(await rawCall(P.jus, "down", JSON.stringify(view).replace('"display_order":5', '"display_order":5.0')), STALE, "display_order 5.0");
  assert.equal(await rawCall(P.jus, "down", JSON.stringify(view).replace('"display_order":14', '"display_order":14.00')), STALE, "display_order 14.00");
  assert.equal(await orderSnapshot(), before, "aucune écriture");

  // La vue reçue, inchangée, est acceptée.
  assert.equal(await rawCall(P.jus, "down", JSON.stringify(view)), "moved");
});

test("[CPR-01] un déplacement accepté ne réécrit QUE les lignes dont la valeur change : dans un périmètre déjà dense, la ligne non concernée garde sa version", async () => {
  const xmin = async (id: string) =>
    (await db.query<{ x: string }>("select xmin::text as x from public.menu_items where id = $1", [id])).rows[0].x;
  const abondance = await xmin(P.abondance);
  const others = await orderSnapshot();
  assert.equal(await moveProductOrder(P.beaufort, "up", await displayedView(CAT_FROMAGES, null)), 1);
  assert.equal(await xmin(P.abondance), abondance, "Abondance (position 3 avant et après) n'est pas réécrite");
  assert.notEqual(await orderSnapshot(), others);
  assert.notEqual(await xmin(P.beaufort), abondance);
});

// ==================================================================
// [MODÈLE] Le faux serveur des tests DOM exécute le VRAI contrat
// ==================================================================

/** Générateur déterministe (mulberry32). */
function prng(seedValue: number) {
  let a = seedValue >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

async function allRows(): Promise<RpcModelRow[]> {
  const r = await db.query<RpcModelRow>(
    "select id, category_id, subcategory_id, name::text as name, display_order, archived_at::text as archived_at from public.menu_items order by id"
  );
  return r.rows;
}

/** Appel SQL DIRECT (charge arbitraire, y compris non conforme), en
 *  tant qu'opérateur : autorisé sur tous les produits, de sorte que
 *  seule la partie modélisée de la fonction décide. `undefined` =
 *  paramètre SQL NULL. */
async function callRpcRaw(productId: string, direction: unknown, payload: unknown): Promise<{ kind: string; position?: number }> {
  try {
    const position = await db.transaction(async (tx) => {
      await tx.exec("set local role authenticated");
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [OPERATOR]);
      const r = await tx.query<{ position: number }>(
        "select public.move_product_order($1::uuid, $2::text, $3::text::jsonb) as position",
        [productId, direction, payload === undefined ? null : JSON.stringify(payload)]
      );
      return r.rows[0].position;
    });
    return { kind: "moved", position };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    const message = e.message ?? "";
    if (e.code === "P0001" && message.includes("SCANYM_PRODUCT_ORDER_STALE")) return { kind: "stale" };
    if (e.code === "22023" && message.includes("SCANYM_PRODUCT_ORDER_BOUNDARY")) return { kind: "boundary" };
    if (e.code === "22023" && message.includes("SCANYM_PRODUCT_ORDER_INVALID_DIRECTION")) return { kind: "invalid_direction" };
    if (e.code === "P0002" && message.includes("Product not found")) return { kind: "not_found" };
    // Toute autre erreur (conversion, contrainte…) est une divergence.
    return { kind: `error:${e.code}:${message}` };
  }
}

const wellFormed = (payload: unknown): payload is Entry[] =>
  Array.isArray(payload) &&
  payload.every(
    (e) =>
      typeof e === "object" && e !== null && !Array.isArray(e) &&
      typeof (e as Entry).id === "string" && typeof (e as Entry).display_order === "number" && typeof (e as Entry).name === "string"
  );

test("[MODÈLE] le modèle TypeScript du contrat RPC -- celui qu'exécute le faux serveur des tests DOM -- rend, scénario par scénario, la MÊME décision et laisse les MÊMES display_order que le SQL réel : ni plus strict, ni plus laxiste ; et la décision de fraîcheur du SQL est exactement « empreinte de la vue = empreinte de l'état stocké »", async (t) => {
  const rand = prng(20261010);
  const pick = <T,>(items: ReadonlyArray<T>): T => items[rand(items.length)];
  const counts: Record<string, number> = { moved: 0, stale: 0, boundary: 0, invalid_direction: 0, not_found: 0 };
  let acceptedWithTies = 0;
  let staleButSameIds = 0;
  let inserted = 0;
  const GHOST = "00000000-0000-0000-0000-00000000dead";
  const subsOf: Record<string, (string | null)[]> = {
    [CAT_FROMAGES]: [null, SUB_CHEVRES, SUB_BREBIS],
    [CAT_BOISSONS]: [null],
    [CAT_B]: [null],
  };
  const viewOfScope = (rows: RpcModelRow[], target: RpcModelRow): Entry[] =>
    orderProductsForCatalogue(
      rows
        .filter((r) => r.category_id === target.category_id && r.subcategory_id === target.subcategory_id && r.archived_at === null)
        .map((r) => ({ product_id: r.id, name: r.name, display_order: r.display_order }))
    ).map((p) => ({ id: p.product_id, display_order: p.display_order, name: p.name }));

  const SCENARIOS = 600;
  for (let i = 0; i < SCENARIOS; i++) {
    if (i % 20 === 0) await seed(db);

    // 1. Le client charge la vue du périmètre d'un produit.
    let rows = await allRows();
    const target = pick(rows);
    const loaded = viewOfScope(rows, target);

    // 2. Un autre utilisateur modifie (ou non) l'état.
    //    (Le plus souvent dans le périmètre même du produit visé :
    //    c'est là qu'une vue devient périmée.)
    const sameScope = rows.filter((r) => r.category_id === target.category_id && r.subcategory_id === target.subcategory_id);
    const changes = rand(5) === 0 ? 0 : 1 + rand(2);
    for (let c = 0; c < changes; c++) {
      const victim = rand(3) === 0 ? pick(rows) : pick(sameScope);
      switch (rand(6)) {
        case 0:
        case 1:
          await db.query("update public.menu_items set display_order = $2 where id = $1", [victim.id, rand(5) - 1]);
          break;
        case 2:
          await db.query("update public.menu_items set name = $2 where id = $1", [
            victim.id,
            pick([victim.name + " bis", victim.name.toUpperCase(), victim.name + " ", "A " + victim.name, victim.name.normalize("NFD")]),
          ]);
          break;
        case 3:
          await db.query("update public.menu_items set archived_at = case when archived_at is null then now() else null end where id = $1", [victim.id]);
          break;
        case 4:
          // Identifiant DÉTERMINISTE : le tirage reste reproductible.
          await db.query("insert into public.menu_items (id, category_id, subcategory_id, name, display_order) values ($1, $2, $3, $4, $5)", [
            uuid(900000 + i * 10 + c), victim.category_id, victim.subcategory_id, `Nouveau ${i}-${c}`, rand(5) - 1,
          ]);
          inserted++;
          break;
        default:
          await db.query("update public.menu_items set subcategory_id = $2 where id = $1", [victim.id, pick(subsOf[victim.category_id])]);
      }
    }

    // 3. État qui fait autorité au moment de l'appel.
    rows = await allRows();
    const current = rows.find((r) => r.id === target.id)!;
    const fresh = viewOfScope(rows, current);

    // 4. Charge transmise.
    let payload: unknown;
    const shape = rand(10);
    if (shape <= 2) payload = fresh;
    else if (shape <= 5) payload = loaded;
    else if (shape === 6) {
      // Valeurs fraîches, ordre quelconque (ex æquo permutés ou non).
      const shuffled = [...fresh];
      for (let k = shuffled.length - 1; k > 0; k--) {
        const j = rand(k + 1);
        [shuffled[k], shuffled[j]] = [shuffled[j], shuffled[k]];
      }
      payload = shuffled;
    } else if (shape === 7) {
      // Vue fraîche d'un AUTRE périmètre.
      payload = viewOfScope(rows, pick(rows));
    } else {
      // Vue fraîche altérée.
      const forged: unknown[] = fresh.map((e) => ({ ...e }));
      const at = forged.length ? rand(forged.length) : 0;
      const other = pick(rows);
      const entry = (forged[at] ?? {}) as Record<string, unknown>;
      switch (rand(22)) {
        case 0: forged.splice(at, 1); break;
        case 1: forged.push({ id: other.id, display_order: other.display_order, name: other.name }); break;
        case 2: if (forged.length > 1) forged[at] = { ...(forged[(at + 1) % forged.length] as object) }; break;
        case 3: forged[at] = { id: other.id, display_order: other.display_order, name: other.name }; break;
        case 4: forged[at] = { ...entry, id: GHOST }; break;
        case 5: forged[at] = { ...entry, id: String(entry.id).toUpperCase() }; break;
        case 6: forged[at] = { ...entry, display_order: Number(entry.display_order) + 1 }; break;
        case 7: forged[at] = { ...entry, display_order: String(entry.display_order) }; break;
        case 8: forged[at] = { ...entry, display_order: Number(entry.display_order) + 0.5 }; break;
        case 9: forged[at] = { ...entry, display_order: null }; break;
        case 10: forged[at] = { id: entry.id, name: entry.name }; break;
        case 11: forged[at] = { ...entry, name: entry.name + "x" }; break;
        case 12: forged[at] = { ...entry, name: String(entry.name).toLowerCase() }; break;
        case 13: forged[at] = { ...entry, name: 7 }; break;
        case 14: forged[at] = { id: entry.id, display_order: entry.display_order }; break;
        case 15: forged[at] = { ...entry, price: 12, is_available: false }; break; // clés en plus : ignorées
        case 16: forged[at] = null; break;
        case 17: forged[at] = entry.id; break; // identifiant nu (ancien contrat)
        case 18: forged[at] = [entry.id, entry.display_order, entry.name]; break;
        case 19: forged[at] = { ...entry, id: 12 }; break;
        case 20: forged[at] = { ...entry, display_order: 1e30 }; break;
        default: forged[at] = { ...entry, name: null };
      }
      payload = rand(12) === 0 ? pick([null, undefined, {}, "x", 42, true, { 0: fresh[0] }]) : forged;
    }
    const direction = rand(14) === 0 ? pick(["left", "UP", "", null]) : pick(["up", "down"]);
    const productId = rand(30) === 0 ? GHOST : target.id;

    // 5. Décision du modèle, sur l'état d'AVANT l'appel.
    const model = moveProductOrderModel(rows, productId, direction, payload);
    const expectedAfter = new Map(rows.map((r) => [r.id, r.display_order]));
    if (model.kind === "moved") for (const [id, value] of Object.entries(model.writes)) expectedAfter.set(id, value);

    // 6. Décision du SQL réel.
    const real = await callRpcRaw(productId, direction, payload);
    const after = await allRows();

    const context = `scénario ${i} : ${JSON.stringify({ productId, direction, payload, model, real })}`;
    assert.equal(real.kind, model.kind, context);
    if (model.kind === "moved") assert.equal(real.position, model.position, context);
    assert.deepEqual(new Map(after.map((r) => [r.id, r.display_order])), expectedAfter, context);
    // Rien d'autre que display_order ne change jamais.
    assert.deepEqual(after.map(({ display_order: _ignored, ...rest }) => rest), rows.map(({ display_order: _ignored, ...rest }) => rest), context);
    if (model.kind !== "moved") assert.deepEqual(after, rows, context);
    counts[real.kind] = (counts[real.kind] ?? 0) + 1;

    // 7. ÉQUIVALENCE AVEC UNE EMPREINTE DE PÉRIMÈTRE. Pour une charge
    //    bien formée et une demande recevable :
    //      acceptée (déplacée ou borne)  =>  empreinte(vue) = empreinte(état) ;
    //      empreinte égale ET liste non décroissante  =>  jamais « périmé ».
    if (wellFormed(payload) && productId !== GHOST && (direction === "up" || direction === "down") && current.archived_at === null) {
      const sameFingerprint = referenceScopeFingerprint(payload) === referenceScopeFingerprint(fresh);
      const storedOf = new Map(fresh.map((e) => [e.id, e.display_order]));
      const nonDecreasing = payload.every((e, k) => k === 0 || (storedOf.get(payload[k - 1].id) ?? 0) <= (storedOf.get(e.id) ?? 0));
      if (real.kind === "moved" || real.kind === "boundary") {
        assert.ok(sameFingerprint, `accepté SANS égalité d'empreinte -- ${context}`);
      }
      if (sameFingerprint && nonDecreasing) {
        assert.notEqual(real.kind, "stale", `vue fraîche refusée -- ${context}`);
      }
      if (!sameFingerprint) {
        assert.equal(real.kind, "stale", `empreinte différente non refusée -- ${context}`);
        const sameIds = JSON.stringify(payload.map((e) => e.id).sort()) === JSON.stringify(fresh.map((e) => e.id).sort());
        if (sameIds) staleButSameIds++;
      }
      if (real.kind === "moved" && new Set(fresh.map((e) => e.display_order)).size < fresh.length) acceptedWithTies++;
    }
  }

  // Le tirage a réellement exercé chaque issue, et les cas qui comptent.
  t.diagnostic(`scénarios comparés (SQL réel == modèle) : ${SCENARIOS} -- ${JSON.stringify({ ...counts, acceptedWithTies, staleButSameIds, inserted })}`);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), SCENARIOS);
  assert.ok(counts.moved >= 100, `déplacements acceptés : ${counts.moved}`);
  assert.ok(counts.stale >= 150, `refus « périmé » : ${counts.stale}`);
  assert.ok(counts.boundary >= 40, `bornes : ${counts.boundary}`);
  assert.ok(counts.invalid_direction >= 20, `directions invalides : ${counts.invalid_direction}`);
  assert.ok(counts.not_found >= 40, `produits introuvables / archivés : ${counts.not_found}`);
  assert.ok(acceptedWithTies >= 40, `déplacements acceptés sur un périmètre contenant des ex æquo : ${acceptedWithTies}`);
  assert.ok(
    staleButSameIds >= 40,
    `vues périmées portant EXACTEMENT les bons identifiants (ce que la première version ne distinguait que par la monotonie) : ${staleButSameIds}`
  );
  assert.ok(inserted >= 50, `produits insérés par l'autre utilisateur : ${inserted}`);
});

// ==================================================================
// Marchand historique, chemin numérique, rollback
// ==================================================================

test("MARCHAND HISTORIQUE jamais réordonné : après tous les déplacements de A, l'établissement B a exactement ses valeurs d'origine (trois ex æquo à 0)", async () => {
  const b = await orderFingerprint(db, ALL_OF_B);
  await moveProductOrder(P.beaufort, "up", await displayedView(CAT_FROMAGES, null));
  await moveProductOrder(P.zeste, "up", await displayedView(CAT_FROMAGES, SUB_CHEVRES));
  await moveProductOrder(P.jus, "down", await displayedView(CAT_BOISSONS, null));
  assert.equal(await orderFingerprint(db, ALL_OF_B), b);
  assert.equal(await scopeState(db, CAT_B, null), "B-Deux=0|B-Trois=0|B-Un=0");
  // … et son ordre client est toujours celui du départage historique.
  assert.deepEqual(await storefrontOrder(CAT_B, null), [P.bDeux, P.bTrois, P.bUn]);
});

test("le champ numérique historique (set_product_order, V67b) fonctionne toujours et cohabite : un ex æquo qu'il crée est résolu par le prochain déplacement", async () => {
  await db.transaction(async (tx) => {
    await tx.exec("set local role authenticated");
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [OWNER_A]);
    await tx.query("select public.set_product_order($1::uuid, 1)", [P.abondance]);
  });
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Abondance=1|Comté=1|Beaufort=2");
  const view = await displayedView(CAT_FROMAGES, null);
  assert.deepEqual(view.map((e) => e.id), [P.abondance, P.comte, P.beaufort]);
  await moveProductOrder(P.beaufort, "up", view);
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Abondance=1|Beaufort=2|Comté=3");
});

test("ANTI-DÉRIVE et ROLLBACK : double application refusée ; le rollback retire la RPC en conservant les ordres enregistrés ; le lot se réinstalle", async () => {
  const fresh = await makeBaselineDb();
  try {
    await seed(fresh);
    await fresh.exec(readSql(LOT_SQL));
    await assert.rejects(fresh.exec(readSql(LOT_SQL)), /SCANYM_SCHEMA_DRIFT/);
    // Le contrôle de dérive avorte la transaction ouverte par le
    // fichier : on la referme, comme le fait son `commit;` final
    // lorsqu'il est exécuté instruction par instruction (psql).
    await fresh.exec("rollback");

    // Un ordre enregistré par un marchand.
    await fresh.transaction(async (tx) => {
      await tx.exec("set local role authenticated");
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [OWNER_A]);
      await tx.query("select public.move_product_order($1::uuid, 'down', $2::text::jsonb)", [
        P.eau,
        JSON.stringify([
          { id: P.eau, display_order: 5, name: "Eau" },
          { id: P.jus, display_order: 9, name: "Jus" },
          { id: P.cidre, display_order: 14, name: "Cidre" },
        ]),
      ]);
    });
    const order = await orderFingerprint(fresh);
    const rest = await nonOrderFingerprint(fresh);

    await fresh.exec(readSql(ROLLBACK_SQL));
    const gone = await fresh.query<{ n: number }>("select count(*)::int as n from pg_proc where proname = 'move_product_order'");
    assert.equal(gone.rows[0].n, 0);
    assert.equal(await orderFingerprint(fresh), order, "les ordres enregistrés sont conservés");
    assert.equal(await nonOrderFingerprint(fresh), rest);
    assert.equal(await scopeState(fresh, CAT_BOISSONS, null), "Jus=1|Eau=2|Cidre=3");
    const legacy = await fresh.query<{ n: number }>("select count(*)::int as n from pg_proc where proname in ('set_product_order', 'assert_product_role')");
    assert.equal(legacy.rows[0].n, 2);

    await assert.rejects(fresh.exec(readSql(ROLLBACK_SQL)), /SCANYM_ROLLBACK_DRIFT/);
    await fresh.exec("rollback");
    await fresh.exec(readSql(LOT_SQL));
    assert.equal(await orderFingerprint(fresh), order, "réinstaller ne modifie aucune donnée non plus");
  } finally {
    await fresh.close();
  }
});

test("ANTI-DÉRIVE : sur une base non conforme (droit UPDATE direct, surcharge de assert_product_role, colonne d'un autre type, name nullable, ancienne signature du lot), le DRAFT refuse et ne crée rien", async () => {
  for (const drift of [
    "grant update on public.menu_items to authenticated",
    "create function public.assert_product_role(p uuid) returns uuid language sql as 'select null::uuid'",
    "alter table public.menu_items alter column display_order type bigint",
    "drop function public.set_product_order(uuid, integer)",
    "alter table public.menu_items disable row level security",
    "alter table public.menu_items alter column name drop not null",
    "create function public.move_product_order(p_product_id uuid, p_direction text, p_expected_order uuid[]) returns integer language sql as 'select 1'",
  ]) {
    const fresh = await makeBaselineDb();
    try {
      await seed(fresh);
      await fresh.exec(drift);
      const order = await orderFingerprint(fresh);
      await assert.rejects(fresh.exec(readSql(LOT_SQL)), /SCANYM_SCHEMA_DRIFT/, drift);
      await fresh.exec("rollback");
      const created = await fresh.query<{ n: number }>(
        "select count(*)::int as n from pg_proc p where p.oid = to_regprocedure('public.move_product_order(uuid, text, jsonb)')"
      );
      assert.equal(created.rows[0].n, 0, drift);
      assert.equal(await orderFingerprint(fresh), order, drift);
    } finally {
      await fresh.close();
    }
  }
});
