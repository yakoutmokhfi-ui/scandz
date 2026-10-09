import { after, before, beforeEach, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import {
  makeBaselineDb, seed, readSql, scopeRows, scopeState, orderFingerprint, nonOrderFingerprint,
  LOT_SQL, ROLLBACK_SQL, OWNER_A, MANAGER_A, STAFF_A, OWNER_B, OPERATOR, STRANGER,
  CAT_FROMAGES, CAT_BOISSONS, CAT_B, SUB_CHEVRES, SUB_BREBIS, P,
} from "./helpers/catalogue-product-reorder-db.ts";
import {
  applyProductMove, findProductOrderScope, orderProductsForCatalogue,
} from "../lib/catalogue-product-order.ts";
import { compareMenuItemsForPublicDisplay } from "../lib/catalogue-subcategory-grouping.ts";

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
    assert.deepEqual(Object.keys(body).sort(), ["p_direction", "p_expected_order", "p_product_id"]);
    assert.ok(Array.isArray(body.p_expected_order));
    try {
      const value = await db.transaction(async (tx) => {
        await tx.exec("set local role authenticated");
        await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [user]);
        const r = await tx.query<{ position: number }>(
          "select public.move_product_order($1::uuid, $2::text, $3::uuid[]) as position",
          [body.p_product_id, body.p_direction, `{${(body.p_expected_order as string[]).join(",")}}`]
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

/** Ordre AFFICHÉ par le back-office pour un périmètre : les lignes
 *  relues en base, triées par le comparateur de production. */
async function displayedOrder(categoryId: string, subcategoryId: string | null): Promise<string[]> {
  const rows = await scopeRows(db, categoryId, subcategoryId);
  return orderProductsForCatalogue(rows.map((r) => ({ product_id: r.id, name: r.name, display_order: r.display_order }))).map(
    (p) => p.product_id
  );
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
      from pg_proc p where p.oid = 'public.move_product_order(uuid, text, uuid[])'::regprocedure`);
    assert.deepEqual(fn.rows, [{
      args: "p_product_id uuid, p_direction text, p_expected_order uuid[]", result: "integer",
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
  const position = await moveProductOrder(P.beaufort, "up", await displayedOrder(CAT_FROMAGES, null));
  assert.equal(position, 1);
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Beaufort=1|Comté=2|Abondance=3");
  assert.deepEqual(requests[0].body, {
    p_product_id: P.beaufort,
    p_direction: "up",
    p_expected_order: [P.comte, P.beaufort, P.abondance],
  });
});

test("MILIEU vers le BAS : la RPC retourne la nouvelle position et persiste l'échange (produit indisponible déplacé comme les autres)", async () => {
  const position = await moveProductOrder(P.beaufort, "down", await displayedOrder(CAT_FROMAGES, null));
  assert.equal(position, 3);
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Comté=1|Abondance=2|Beaufort=3");
});

test("le PREMIER ne peut pas monter : refus serveur typé (ProductOrderBoundaryError), aucune écriture", async () => {
  const before = await orderFingerprint(db);
  await assert.rejects(moveProductOrder(P.comte, "up", await displayedOrder(CAT_FROMAGES, null)), ProductOrderBoundaryError);
  assert.equal(await orderFingerprint(db), before);
});

test("le DERNIER ne peut pas descendre : refus serveur typé, aucune écriture", async () => {
  const before = await orderFingerprint(db);
  await assert.rejects(moveProductOrder(P.abondance, "down", await displayedOrder(CAT_FROMAGES, null)), ProductOrderBoundaryError);
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
  await moveProductOrder(P.crottin, "up", await displayedOrder(CAT_FROMAGES, SUB_CHEVRES));
  assert.equal(await scopeState(db, CAT_FROMAGES, SUB_CHEVRES), "crottin=1|Banon=2|Zeste de chèvre=3|éclat cendré=4");
  assert.deepEqual(await others(), before);
});

test("REPLI CATÉGORIE : déplacer un produit direct ne touche aucune sous-catégorie de sa catégorie", async () => {
  const subs = async () => [await scopeState(db, CAT_FROMAGES, SUB_CHEVRES), await scopeState(db, CAT_FROMAGES, SUB_BREBIS), await scopeState(db, CAT_BOISSONS, null)];
  const before = await subs();
  await moveProductOrder(P.abondance, "up", await displayedOrder(CAT_FROMAGES, null));
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
    await assert.rejects(moveProductOrder(P.beaufort, "up", expected), ProductOrderStaleError);
  }
  await assert.rejects(
    moveProductOrder(P.banon, "down", [...(await displayedOrder(CAT_FROMAGES, SUB_CHEVRES)), P.ancien]),
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
    await assert.rejects(moveProductOrder(productId, "up", [...expected]), ProductOrderStaleError);
  }
  assert.equal(await nonOrderFingerprint(db), rest);
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Comté=1|Beaufort=2|Abondance=3");
  assert.equal(await scopeState(db, CAT_FROMAGES, SUB_CHEVRES), "Banon=0|Zeste de chèvre=0|crottin=0|éclat cendré=0");
  // Puis de vrais déplacements dans trois périmètres.
  await moveProductOrder(P.beaufort, "up", direct);
  await moveProductOrder(P.roquefort, "up", await displayedOrder(CAT_FROMAGES, SUB_BREBIS));
  await moveProductOrder(P.jus, "down", await displayedOrder(CAT_BOISSONS, null));
  assert.equal(await nonOrderFingerprint(db), rest, "taxonomie, disponibilité, prix, noms, archivage : strictement inchangés");
});

// ==================================================================
// Isolation entre établissements, rôles
// ==================================================================

test("ISOLATION : le propriétaire de B, un inconnu et le staff de A ne peuvent pas réordonner un produit de A (refus serveur, jamais « périmé »), rien n'est écrit", async () => {
  const before = await orderFingerprint(db);
  const expected = await displayedOrder(CAT_FROMAGES, null);
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
  await assert.rejects(moveProductOrder(P.bUn, "up", [P.bDeux, P.bTrois, P.bUn]), /Not authorized for this product/);
  await assert.rejects(
    moveProductOrder(P.beaufort, "up", [...(await displayedOrder(CAT_FROMAGES, null)), P.bUn]),
    ProductOrderStaleError
  );
  // … ni le SUBSTITUER à l'un des siens (liste de même taille que le périmètre).
  await assert.rejects(moveProductOrder(P.beaufort, "up", [P.comte, P.beaufort, P.bUn]), ProductOrderStaleError);
  assert.equal(await orderFingerprint(db, ALL_OF_B), b);
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Comté=1|Beaufort=2|Abondance=3");
});

test("RÔLES : manager de A et opérateur Scanym (sans rattachement) sont autorisés ; le rôle anon n'a pas le droit d'exécuter la RPC", async () => {
  user = MANAGER_A;
  assert.equal(await moveProductOrder(P.beaufort, "up", await displayedOrder(CAT_FROMAGES, null)), 1);
  user = OPERATOR;
  assert.equal(await moveProductOrder(P.beaufort, "down", await displayedOrder(CAT_FROMAGES, null)), 2);
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Comté=1|Beaufort=2|Abondance=3");

  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.exec("set local role anon");
      await tx.query("select public.move_product_order($1::uuid, 'up', $2::uuid[])", [P.beaufort, `{${P.comte},${P.beaufort},${P.abondance}}`]);
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

  assert.equal(await moveProductOrder(P.zeste, "up", shown), 2);
  assert.equal(await scopeState(db, CAT_FROMAGES, SUB_CHEVRES), "Banon=1|Zeste de chèvre=2|crottin=3|éclat cendré=4");
  assert.deepEqual(await displayedOrder(CAT_FROMAGES, SUB_CHEVRES), [P.banon, P.zeste, P.crottin, P.eclat]);
});

test("l'appelant ne choisit QUE l'ordre entre ex æquo : dès que les valeurs stockées sont distinctes, un ordre qui les contredit est refusé", async () => {
  // Ex æquo : n'importe quelle permutation de départ est acceptée.
  await moveProductOrder(P.banon, "up", [P.eclat, P.zeste, P.crottin, P.banon]);
  assert.equal(await scopeState(db, CAT_FROMAGES, SUB_CHEVRES), "éclat cendré=1|Zeste de chèvre=2|Banon=3|crottin=4");
  // Valeurs désormais distinctes : seule la vue exacte est acceptée.
  await assert.rejects(moveProductOrder(P.banon, "up", [P.banon, P.crottin, P.zeste, P.eclat]), ProductOrderStaleError);
  await assert.rejects(moveProductOrder(P.banon, "up", [P.eclat, P.banon, P.zeste, P.crottin]), ProductOrderStaleError);
  assert.equal(await moveProductOrder(P.banon, "up", [P.eclat, P.zeste, P.banon, P.crottin]), 2);
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
      await assert.rejects(moveProductOrder(productId, direction, scope.orderedIds), ProductOrderBoundaryError);
      continue;
    }
    assert.equal(await moveProductOrder(productId, direction, scope.orderedIds), local.position);
    accepted++;

    // État local de l'écran == état relu en base, pour TOUT le catalogue.
    const reloaded = await loadBackOfficeCatalogue();
    const flat = (cats: any[]) =>
      Object.fromEntries(cats.flatMap((c) => [...c.products, ...c.subcategories.flatMap((s: any) => s.products)]).map((p: any) => [p.product_id, p.display_order]));
    assert.deepEqual(flat(local.categories), flat(reloaded));
    // … et l'ordre affiché après rechargement == l'ordre local.
    assert.deepEqual(findProductOrderScope(reloaded, productId)!.orderedIds, findProductOrderScope(local.categories, productId)!.orderedIds);
  }
  assert.ok(accepted >= 30, `des déplacements doivent réellement avoir lieu (${accepted})`);
  // Relire deux fois donne deux fois la même chose.
  assert.deepEqual(await displayedOrder(CAT_FROMAGES, SUB_CHEVRES), await displayedOrder(CAT_FROMAGES, SUB_CHEVRES));
});

test("LA CARTE CLIENT SUIT LE BACK-OFFICE : après réordonnancement, l'ordre lu sous le rôle anon (produits disponibles) est l'ordre du back-office, l'indisponible masqué sans changer l'ordre relatif des autres", async () => {
  await moveProductOrder(P.abondance, "up", await displayedOrder(CAT_FROMAGES, null));
  await moveProductOrder(P.abondance, "up", await displayedOrder(CAT_FROMAGES, null));
  await moveProductOrder(P.beaufort, "up", await displayedOrder(CAT_FROMAGES, null));
  await moveProductOrder(P.eclat, "up", await displayedOrder(CAT_FROMAGES, SUB_CHEVRES));
  await moveProductOrder(P.cidre, "up", await displayedOrder(CAT_BOISSONS, null));

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
  const view = await displayedOrder(CAT_FROMAGES, null);
  user = OWNER_A;
  await moveProductOrder(P.abondance, "up", view);
  user = MANAGER_A;
  await assert.rejects(moveProductOrder(P.beaufort, "up", view), ProductOrderStaleError);
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Comté=1|Abondance=2|Beaufort=3");
  // Après rechargement, le second client obtient son déplacement.
  await moveProductOrder(P.beaufort, "up", await displayedOrder(CAT_FROMAGES, null));
  assert.equal(await scopeState(db, CAT_FROMAGES, null), "Comté=1|Beaufort=2|Abondance=3");
});

test("CONCURRENCE : rejouer une requête DÉJÀ appliquée (double clic, retry réseau) est refusé -- un déplacement n'est jamais appliqué deux fois", async () => {
  const view = await displayedOrder(CAT_BOISSONS, null);
  await moveProductOrder(P.cidre, "up", view);
  await assert.rejects(moveProductOrder(P.cidre, "up", view), ProductOrderStaleError);
  assert.equal(await scopeState(db, CAT_BOISSONS, null), "Eau=1|Cidre=2|Jus=3");
});

test("CONCURRENCE : huit clients, même vue de départ, sur un groupe d'ex æquo -- exactement UN déplacement accepté, positions finales 1..N toutes distinctes", async () => {
  const view = await displayedOrder(CAT_FROMAGES, SUB_CHEVRES);
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
  const r = await db.query<{ def: string }>("select pg_get_functiondef('public.move_product_order(uuid, text, uuid[])'::regprocedure) as def");
  const def = r.rows[0].def;
  assert.ok(def.includes("pg_advisory_xact_lock(hashtextextended(v_restaurant_id::text, 2701))"));
  assert.equal((def.match(/for no key update;/g) ?? []).length, 2);
});

test("un changement de périmètre entre-temps (création, archivage) rend la vue périmée ; un produit archivé ne se réordonne pas", async () => {
  const view = await displayedOrder(CAT_BOISSONS, null);
  await db.query("insert into public.menu_items (category_id, name, display_order) values ($1, 'Limonade', 15)", [CAT_BOISSONS]);
  await assert.rejects(moveProductOrder(P.jus, "up", view), ProductOrderStaleError);

  await db.query("update public.menu_items set archived_at = now() where id = $1", [P.cidre]);
  await assert.rejects(moveProductOrder(P.cidre, "up", await displayedOrder(CAT_BOISSONS, null)), /Product not found or archived/);
  const fresh = await displayedOrder(CAT_BOISSONS, null);
  assert.equal(fresh.includes(P.cidre), false);
  await moveProductOrder(P.jus, "up", fresh);
  assert.equal(await scopeState(db, CAT_BOISSONS, null), "Jus=1|Eau=2|Limonade=3");
  const archived = await db.query<{ display_order: number }>("select display_order from public.menu_items where id = $1", [P.cidre]);
  assert.equal(archived.rows[0].display_order, 14, "la valeur d'un produit archivé n'est pas réécrite");
});

// ==================================================================
// Marchand historique, chemin numérique, rollback
// ==================================================================

test("MARCHAND HISTORIQUE jamais réordonné : après tous les déplacements de A, l'établissement B a exactement ses valeurs d'origine (trois ex æquo à 0)", async () => {
  const b = await orderFingerprint(db, ALL_OF_B);
  await moveProductOrder(P.beaufort, "up", await displayedOrder(CAT_FROMAGES, null));
  await moveProductOrder(P.zeste, "up", await displayedOrder(CAT_FROMAGES, SUB_CHEVRES));
  await moveProductOrder(P.jus, "down", await displayedOrder(CAT_BOISSONS, null));
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
  const view = await displayedOrder(CAT_FROMAGES, null);
  assert.deepEqual(view, [P.abondance, P.comte, P.beaufort]);
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
      await tx.query("select public.move_product_order($1::uuid, 'down', $2::uuid[])", [P.eau, `{${P.eau},${P.jus},${P.cidre}}`]);
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

test("ANTI-DÉRIVE : sur une base non conforme (droit UPDATE direct, surcharge de assert_product_role, colonne d'un autre type), le DRAFT refuse et ne crée rien", async () => {
  for (const drift of [
    "grant update on public.menu_items to authenticated",
    "create function public.assert_product_role(p uuid) returns uuid language sql as 'select null::uuid'",
    "alter table public.menu_items alter column display_order type bigint",
    "drop function public.set_product_order(uuid, integer)",
    "alter table public.menu_items disable row level security",
  ]) {
    const fresh = await makeBaselineDb();
    try {
      await seed(fresh);
      await fresh.exec(drift);
      const order = await orderFingerprint(fresh);
      await assert.rejects(fresh.exec(readSql(LOT_SQL)), /SCANYM_SCHEMA_DRIFT/, drift);
      await fresh.exec("rollback");
      const created = await fresh.query<{ n: number }>("select count(*)::int as n from pg_proc where proname = 'move_product_order'");
      assert.equal(created.rows[0].n, 0, drift);
      assert.equal(await orderFingerprint(fresh), order, drift);
    } finally {
      await fresh.close();
    }
  }
});
