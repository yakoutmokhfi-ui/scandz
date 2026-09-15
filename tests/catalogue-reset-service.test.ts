import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — CLAUDE NOUGARO — OPERATOR BACKOFFICE — SAFE CATALOGUE
// RESET v1.1 — couche service pure (lib/services/catalogue-reset.ts).
//
// Preuve COMPORTEMENTALE (mock supabase.rpc via t.mock.method, même
// patron établi que tests/lot-ob4-catalogue-import-commit.test.ts et
// tests/lot-ob3-catalogue-import-service.test.ts -- jamais un module
// loader personnalisé) du CONTRAT exact entre la couche TS et les RPC
// PostgreSQL (preview_catalogue_reset/reset_merchant_catalogue) : nom
// de RPC exact, nom de paramètre exact (p_restaurant_id,
// p_confirmation_phrase -- v1.1), mapping snake_case -> camelCase
// fidèle, propagation d'erreur non réinterprétée, traduction
// `result = 'rejected_confirmation'` -> erreur levée (v1.1).
//
// La preuve que les RPC elles-mêmes se comportent correctement
// (autorisation operator-only, confirmation SERVEUR, isolation tenant,
// archivage vs suppression vs désactivation, idempotency, concurrence,
// audit) est apportée SÉPARÉMENT par un harnais PostgreSQL RÉEL
// (aucune simulation) : supabase/tests/operator-catalogue-reset-v1-
// check.sh (87/87 assertions vertes) -- jamais dupliquée ici.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { supabase } = await import("../lib/supabase.ts");
const {
  previewCatalogueReset,
  resetMerchantCatalogue,
  buildCatalogueResetConfirmationPhrase,
  isCatalogueResetConfirmationPhraseValid,
  CatalogueResetConfirmationMismatchError,
} = await import("../lib/services/catalogue-reset.ts");

type RpcCall = { name: string; args: unknown };

function installMock(
  t: any,
  respond: (name: string, args: any) => { data: unknown; error: { message: string } | null }
): RpcCall[] {
  const calls: RpcCall[] = [];
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    calls.push({ name, args });
    return respond(name, args);
  });
  return calls;
}

// --------------------------------------------------------------------
// buildCatalogueResetConfirmationPhrase / isCatalogueResetConfirmationPhraseValid
// -- purs, AUCUN appel réseau. v1.1 : PLUS de mise en majuscule (voir
// en-tête de catalogue-reset.ts pour le rationale -- risque de
// divergence PostgreSQL upper() / JS toLocaleUpperCase("fr-FR") sur
// des caractères accentués).
// --------------------------------------------------------------------

test("buildCatalogueResetConfirmationPhrase : 'Au Lait Cru' -> 'RESET Au Lait Cru' (casse du marchand PRÉSERVÉE, v1.1)", () => {
  assert.equal(buildCatalogueResetConfirmationPhrase("Au Lait Cru"), "RESET Au Lait Cru");
});

test("buildCatalogueResetConfirmationPhrase : accents préservés, jamais translittérés ni changés de casse", () => {
  assert.equal(buildCatalogueResetConfirmationPhrase("Café Léa"), "RESET Café Léa");
});

test("buildCatalogueResetConfirmationPhrase : espaces de bordure du nom marchand ignorés", () => {
  assert.equal(buildCatalogueResetConfirmationPhrase("  Au Lait Cru  "), "RESET Au Lait Cru");
});

test("isCatalogueResetConfirmationPhraseValid : phrase exacte -> valide", () => {
  assert.equal(isCatalogueResetConfirmationPhraseValid("RESET Au Lait Cru", "Au Lait Cru"), true);
});

test("isCatalogueResetConfirmationPhraseValid : espaces de bordure de la SAISIE ignorés (jamais ceux de la phrase attendue)", () => {
  assert.equal(isCatalogueResetConfirmationPhraseValid("  RESET Au Lait Cru  ", "Au Lait Cru"), true);
});

test("[v1.1-D] isCatalogueResetConfirmationPhraseValid : casse différente -> INVALIDE (comparaison stricte, jamais insensible à la casse)", () => {
  assert.equal(isCatalogueResetConfirmationPhraseValid("reset au lait cru", "Au Lait Cru"), false);
});

test("[v1.1-D] isCatalogueResetConfirmationPhraseValid : l'ancienne phrase TOUT-MAJUSCULES v1 ('RESET AU LAIT CRU') est désormais INVALIDE -- preuve que la transformation de casse a bien été retirée", () => {
  assert.equal(isCatalogueResetConfirmationPhraseValid("RESET AU LAIT CRU", "Au Lait Cru"), false);
});

test("[v1.1-D] isCatalogueResetConfirmationPhraseValid : espace interne double -> INVALIDE (seuls les espaces de BORDURE de la saisie sont ignorés)", () => {
  assert.equal(isCatalogueResetConfirmationPhraseValid("RESET  Au Lait Cru", "Au Lait Cru"), false);
});

test("isCatalogueResetConfirmationPhraseValid : phrase partielle -> INVALIDE", () => {
  assert.equal(isCatalogueResetConfirmationPhraseValid("RESET Au Lait", "Au Lait Cru"), false);
});

test("[v1.1-C] isCatalogueResetConfirmationPhraseValid : phrase exacte d'un AUTRE marchand -> INVALIDE (jamais un faux positif entre deux marchands)", () => {
  assert.equal(isCatalogueResetConfirmationPhraseValid("RESET Au Lait Cru", "Hotel Royal"), false);
});

test("[v1.1-B] isCatalogueResetConfirmationPhraseValid : chaîne vide -> INVALIDE", () => {
  assert.equal(isCatalogueResetConfirmationPhraseValid("", "Au Lait Cru"), false);
});

// --------------------------------------------------------------------
// previewCatalogueReset -- contrat RPC exact, LECTURE SEULE.
// --------------------------------------------------------------------

test("previewCatalogueReset : appelle EXACTEMENT preview_catalogue_reset avec p_restaurant_id, mappe chaque champ snake_case -> camelCase (v1.1 : + categoriesActiveAfterReset/subcategoriesActiveAfterReset)", async (t) => {
  const calls = installMock(t, () => ({
    data: [
      {
        restaurant_id: "r1",
        active_products_count: 12,
        archived_products_count: 3,
        subcategories_total: 2,
        subcategories_removable: 1,
        subcategories_retained: 1,
        categories_total: 7,
        categories_removable: 5,
        categories_retained: 2,
        products_with_order_history: 4,
        categories_active_after_reset: 0,
        subcategories_active_after_reset: 0,
      },
    ],
    error: null,
  }));

  const result = await previewCatalogueReset("r1");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "preview_catalogue_reset");
  assert.deepEqual(calls[0].args, { p_restaurant_id: "r1" });

  assert.deepEqual(result, {
    restaurantId: "r1",
    activeProductsCount: 12,
    archivedProductsCount: 3,
    subcategoriesTotal: 2,
    subcategoriesRemovable: 1,
    subcategoriesRetained: 1,
    categoriesTotal: 7,
    categoriesRemovable: 5,
    categoriesRetained: 2,
    productsWithOrderHistory: 4,
    categoriesActiveAfterReset: 0,
    subcategoriesActiveAfterReset: 0,
  });
});

test("[D] previewCatalogueReset : une erreur RPC (ex. 42501 non-opérateur) est propagée telle quelle, jamais avalée ni réinterprétée en catalogue vide", async (t) => {
  installMock(t, () => ({ data: null, error: { message: "Not authorized: Scanym operator required" } }));

  await assert.rejects(() => previewCatalogueReset("r1"), /Not authorized: Scanym operator required/);
});

test("previewCatalogueReset : scopé au restaurantId passé, jamais un autre (isolation tenant côté contrat TS)", async (t) => {
  const calls = installMock(t, (_name, args) => ({
    data: [
      {
        restaurant_id: args.p_restaurant_id,
        active_products_count: 0,
        archived_products_count: 0,
        subcategories_total: 0,
        subcategories_removable: 0,
        subcategories_retained: 0,
        categories_total: 0,
        categories_removable: 0,
        categories_retained: 0,
        products_with_order_history: 0,
        categories_active_after_reset: 0,
        subcategories_active_after_reset: 0,
      },
    ],
    error: null,
  }));

  const a = await previewCatalogueReset("tenant-a");
  const b = await previewCatalogueReset("tenant-b");
  assert.equal(a.restaurantId, "tenant-a");
  assert.equal(b.restaurantId, "tenant-b");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, { p_restaurant_id: "tenant-a" });
  assert.deepEqual(calls[1].args, { p_restaurant_id: "tenant-b" });
});

test("previewCatalogueReset : résultat vide (aucune ligne renvoyée) -> erreur explicite, jamais un objet undefined silencieux", async (t) => {
  installMock(t, () => ({ data: [], error: null }));
  await assert.rejects(() => previewCatalogueReset("r1"), /Empty preview result/);
});

// --------------------------------------------------------------------
// resetMerchantCatalogue -- contrat RPC exact, MUTATION. v1.1 : exige
// désormais `confirmationPhrase` (2e argument), transmis TEL QUEL en
// `p_confirmation_phrase` -- jamais transformé/recalculé ici (le
// serveur est la seule autorité, voir en-tête de catalogue-reset.ts).
// --------------------------------------------------------------------

test("resetMerchantCatalogue : appelle EXACTEMENT reset_merchant_catalogue avec p_restaurant_id ET p_confirmation_phrase (v1.1), mappe chaque champ, historicalOrdersPreserved toujours true", async (t) => {
  const calls = installMock(t, () => ({
    data: [
      {
        restaurant_id: "r1",
        products_archived: 12,
        subcategories_removed: 0,
        subcategories_retained: 1,
        categories_removed: 5,
        categories_retained: 2,
        categories_active_after_reset: 0,
        subcategories_active_after_reset: 0,
        historical_orders_preserved: true,
        result: "completed",
      },
    ],
    error: null,
  }));

  const result = await resetMerchantCatalogue("r1", "RESET Au Lait Cru");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "reset_merchant_catalogue");
  assert.deepEqual(calls[0].args, { p_restaurant_id: "r1", p_confirmation_phrase: "RESET Au Lait Cru" });

  assert.deepEqual(result, {
    restaurantId: "r1",
    productsArchived: 12,
    subcategoriesRemoved: 0,
    subcategoriesRetained: 1,
    categoriesRemoved: 5,
    categoriesRetained: 2,
    categoriesActiveAfterReset: 0,
    subcategoriesActiveAfterReset: 0,
    historicalOrdersPreserved: true,
    result: "completed",
  });
});

test("[v1.1] resetMerchantCatalogue : transmet la phrase de confirmation TELLE QUELLE (non trimée/transformée) -- le serveur seul décide", async (t) => {
  const calls = installMock(t, () => ({
    data: [
      {
        restaurant_id: "r1",
        products_archived: 0,
        subcategories_removed: 0,
        subcategories_retained: 0,
        categories_removed: 0,
        categories_retained: 0,
        categories_active_after_reset: 0,
        subcategories_active_after_reset: 0,
        historical_orders_preserved: true,
        result: "no_op",
      },
    ],
    error: null,
  }));

  await resetMerchantCatalogue("r1", "  RESET Au Lait Cru  ");
  assert.deepEqual(calls[0].args, {
    p_restaurant_id: "r1",
    p_confirmation_phrase: "  RESET Au Lait Cru  ",
  });
});

test("[M] resetMerchantCatalogue : result='no_op' propagé fidèlement (reset répété, idempotency)", async (t) => {
  installMock(t, () => ({
    data: [
      {
        restaurant_id: "r1",
        products_archived: 0,
        subcategories_removed: 0,
        subcategories_retained: 1,
        categories_removed: 0,
        categories_retained: 2,
        categories_active_after_reset: 0,
        subcategories_active_after_reset: 0,
        historical_orders_preserved: true,
        result: "no_op",
      },
    ],
    error: null,
  }));

  const result = await resetMerchantCatalogue("r1", "RESET Au Lait Cru");
  assert.equal(result.result, "no_op");
  assert.equal(result.productsArchived, 0);
});

test("[D] resetMerchantCatalogue : une erreur RPC (ex. owner non-opérateur) est propagée telle quelle, AUCUNE mutation locale supposée réussie", async (t) => {
  installMock(t, () => ({ data: null, error: { message: "Not authorized: Scanym operator required" } }));

  await assert.rejects(() => resetMerchantCatalogue("r1", "RESET Au Lait Cru"), /Not authorized: Scanym operator required/);
});

test("[v1.1-A/B/C/D/F] resetMerchantCatalogue : result='rejected_confirmation' lève TOUJOURS CatalogueResetConfirmationMismatchError -- jamais confondu avec un succès", async (t) => {
  installMock(t, () => ({
    data: [
      {
        restaurant_id: "r1",
        products_archived: 0,
        subcategories_removed: 0,
        subcategories_retained: 0,
        categories_removed: 0,
        categories_retained: 0,
        categories_active_after_reset: 3,
        subcategories_active_after_reset: 1,
        historical_orders_preserved: true,
        result: "rejected_confirmation",
      },
    ],
    error: null,
  }));

  await assert.rejects(
    () => resetMerchantCatalogue("r1", "phrase erronée"),
    (err: unknown) => err instanceof CatalogueResetConfirmationMismatchError
  );
});

test("resetMerchantCatalogue : ne transmet JAMAIS de compteurs déjà affichés (SEULS p_restaurant_id/p_confirmation_phrase existent dans le contrat, v1.1)", async (t) => {
  const calls = installMock(t, () => ({
    data: [
      {
        restaurant_id: "r1",
        products_archived: 1,
        subcategories_removed: 0,
        subcategories_retained: 0,
        categories_removed: 0,
        categories_retained: 0,
        categories_active_after_reset: 0,
        subcategories_active_after_reset: 0,
        historical_orders_preserved: true,
        result: "completed",
      },
    ],
    error: null,
  }));

  await resetMerchantCatalogue("r1", "RESET Au Lait Cru");
  const args = calls[0].args as Record<string, unknown>;
  assert.deepEqual(Object.keys(args).sort(), ["p_confirmation_phrase", "p_restaurant_id"]);
});

test("resetMerchantCatalogue : résultat vide (aucune ligne renvoyée) -> erreur explicite, jamais un objet undefined silencieux", async (t) => {
  installMock(t, () => ({ data: [], error: null }));
  await assert.rejects(() => resetMerchantCatalogue("r1", "RESET Au Lait Cru"), /Empty reset result/);
});
