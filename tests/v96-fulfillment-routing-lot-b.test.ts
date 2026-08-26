import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// FULFILLMENT ROUTING LOT B — RPC additive + résolveur interne +
// types/helpers frontend PURS. Prolonge LOT A
// (supabase/DRAFT-lot-fulfillment-routing-model.sql, déjà mergé) sans
// le modifier. AUCUN runtime switch, AUCUNE activation tenant, AUCUN
// appel Stuart/Chronofresh.
//
// MIS À JOUR EN LOT B.1 (audit Work, findings FRB-B-01/FRB-B-02) :
// le test "code postal invalide" a été corrigé -- resolveDeliveryFulfillment
// ne dépend plus de isValidPostalCode (contrôle de format France-specific
// 5 chiffres) mais d'une normalisation générique (trim + vide), désormais
// identique au résolveur SQL. `matchedPrefix` a été ajouté au contrat
// (nouveaux tests dédiés ci-dessous). La preuve de déterminisme
// SQL/frontend cas par cas (FRB-B-02) vit dans un fichier séparé :
// tests/v97-fulfillment-routing-lot-b1-determinism.test.ts, consommant
// tests/fixtures/fulfillment-routing-cases.json.
//
// MIS À JOUR EN LOT B.2 (audit Work, finding FRB-B-01/HIGH restant) :
// le paramètre postalCode de resolveDeliveryFulfillment était typé
// `string` mais un `null`/`undefined` RÉEL au runtime faisait planter
// `postalCode.trim()` (TypeError). Corrigé via
// `postalCode?.trim() ?? ""` -- null/undefined/vide/espaces rendent
// désormais tous la même décision `no-postal`, jamais d'exception. Les
// tests ci-dessous ajoutent `null`/`undefined` explicitement (`""` et
// `"   "` étaient déjà couverts). `undefined` ne peut pas être
// représenté en JSON : il est donc testé ICI directement en TS, plutôt
// que dans tests/fixtures/fulfillment-routing-cases.json (qui couvre
// le cas `null`, partagé avec le résolveur SQL -- voir
// tests/v97-fulfillment-routing-lot-b1-determinism.test.ts).
//
// Ce fichier couvre le côté FRONTEND (types, resolveDeliveryFulfillment,
// getPublicDeliveryFulfillments) par tests réels (pas seulement lus en
// code source). Le côté SERVEUR (RPC, résolveur interne SQL, RLS,
// ACL, additivité) est couvert par le harnais PostgreSQL jetable
// supabase/tests/fulfillment-routing-lot-b-check.sh (hors du périmètre
// de la suite npm test -- même séparation que LOT A/2A/2B.1).
// ====================================================================

// Import de TYPE uniquement (compile-time) -- preuve d'assignabilité
// que resolveDeliveryFulfillment retourne bien DeliveryFulfillmentStatus,
// jamais un type parallèle -- même patron que
// tests/v85-lot2b2-delivery-resolver.test.ts (L2B2-01).
import type {
  DeliveryFulfillmentStatus,
  PublicDeliveryFulfillmentRule,
} from "../lib/sale-modes-types.ts";

const { resolveDeliveryFulfillment } = await import("../lib/delivery.ts");
const { getPublicDeliveryFulfillments } = await import("../lib/sale-modes-public.ts");
const { supabase } = await import("../lib/supabase.ts");

function __typeProofAssignability(): void {
  const proof: DeliveryFulfillmentStatus = resolveDeliveryFulfillment([], "75001", 5);
  void proof;
}
void __typeProofAssignability;

const deliverySrc = readFileSync("lib/delivery.ts", "utf8");
const salesModesPublicSrc = readFileSync("lib/sale-modes-public.ts", "utf8");
const typesSrc = readFileSync("lib/sale-modes-types.ts", "utf8");
const draftSql = readFileSync("supabase/DRAFT-lot-fulfillment-routing-lot-b-rpc.sql", "utf8");

function rule(overrides: Partial<PublicDeliveryFulfillmentRule>): PublicDeliveryFulfillmentRule {
  return {
    fulfillmentCode: "test_rule",
    zonePrefixes: [],
    isFallback: false,
    minItems: null,
    customerText: null,
    displayOrder: 0,
    pricingMode: "free",
    fixedFee: null,
    freeThreshold: null,
    ...overrides,
  };
}

// --------------------------------------------------------------------
// resolveDeliveryFulfillment -- signature, pureté, non-branchement
// --------------------------------------------------------------------

test("LOT B: resolveDeliveryFulfillment est exportée, fonction pure, jamais async", () => {
  assert.equal(typeof resolveDeliveryFulfillment, "function");
  const result = resolveDeliveryFulfillment([], "75001", 5);
  assert.ok(!(result instanceof Promise), "jamais une Promise -- synchrone");
});

test("LOT B: aucun appel Supabase / RPC / await dans le corps de resolveDeliveryFulfillment", () => {
  const start = deliverySrc.indexOf("export function resolveDeliveryFulfillment");
  const end = deliverySrc.indexOf("\n}", start);
  const body = deliverySrc.slice(start, end);
  assert.ok(!body.includes("supabase"));
  assert.ok(!body.includes(".rpc("));
  assert.ok(!body.includes("await"));
});

test("LOT B: resolveDeliveryFulfillment n'existe dans AUCUN composant (aucun runtime switch -- reste hors de MenuView.tsx/FulfillmentSelector.tsx/CartPanel.tsx)", () => {
  for (const file of ["components/MenuView.tsx", "components/FulfillmentSelector.tsx", "components/CartPanel.tsx"]) {
    const src = readFileSync(file, "utf8");
    assert.ok(!src.includes("resolveDeliveryFulfillment"), `${file} ne doit référencer resolveDeliveryFulfillment nulle part -- LOT C, hors périmètre`);
  }
});

test("LOT B: getPublicDeliveryFulfillments n'existe dans AUCUN composant ni AUCUN hook (aucun runtime switch)", () => {
  for (const file of ["components/MenuView.tsx", "components/FulfillmentSelector.tsx", "components/CartPanel.tsx", "lib/use-public-delivery-info.ts", "lib/use-public-sale-modes.ts"]) {
    const src = readFileSync(file, "utf8");
    assert.ok(!src.includes("getPublicDeliveryFulfillments"), `${file} ne doit référencer getPublicDeliveryFulfillments nulle part -- LOT C, hors périmètre`);
  }
});

// MIS À JOUR EN LOT C (ACTIVE FRONTEND RUNTIME ROUTING) : ce test
// affirmait jusqu'ici qu'AUCUN hook usePublicDeliveryFulfillments
// n'existait -- exactement ce que ce même lot (LOT B) annonçait
// explicitement comme "non créé ici, LOT C" (voir le titre original du
// test, conservé ci-dessous dans le commentaire pour traçabilité). LOT
// C est précisément le lot qui active cette bascule : le hook existe
// désormais (lib/use-public-delivery-fulfillments.ts, voir le rapport
// de mission LOT C) -- ce n'est pas une régression silencieuse de
// l'invariant LOT B, c'est la transition que ce même invariant
// annonçait. Les deux hooks LOT 2B.1/2B.3 existants, eux, restent
// étrangers à cette bascule (aucun croisement accidentel) -- cette
// partie de l'invariant original reste vérifiée telle quelle.
test("LOT C: le hook usePublicDeliveryFulfillments existe désormais (lib/use-public-delivery-fulfillments.ts) et active la bascule runtime -- ancien titre LOT B : \"aucun nouveau hook usePublicDeliveryFulfillments n'existe -- LOT C, non créé ici\"", () => {
  const untouchedHooks = ["lib/use-public-delivery-info.ts", "lib/use-public-sale-modes.ts"];
  for (const file of untouchedHooks) {
    const src = readFileSync(file, "utf8");
    assert.ok(
      !src.includes("usePublicDeliveryFulfillments"),
      `${file} ne doit toujours pas référencer usePublicDeliveryFulfillments -- aucun croisement accidentel entre hooks`
    );
  }
  const hookSrc = readFileSync("lib/use-public-delivery-fulfillments.ts", "utf8");
  assert.ok(
    hookSrc.includes("export function usePublicDeliveryFulfillments"),
    "le nouveau hook LOT C doit être exporté sous ce nom exact"
  );
  assert.ok(
    hookSrc.includes("getPublicDeliveryFulfillments"),
    "le nouveau hook doit appeler getPublicDeliveryFulfillments (lib/sale-modes-public.ts), jamais un accès Supabase direct"
  );
  assert.ok(!hookSrc.includes("supabase.rpc("), "aucun appel RPC direct dans le hook -- toujours via lib/sale-modes-public.ts");
});

test("LOT B: aucune logique spécifique à un établissement précis (aucun slug, aucun nom d'établissement codé en dur) dans resolveDeliveryFulfillment/getPublicDeliveryFulfillments", () => {
  const start = deliverySrc.indexOf("export function resolveDeliveryFulfillment");
  assert.ok(!/illico|sanaa|sirocco|au lait cru/i.test(deliverySrc.slice(start)));
  assert.ok(!/illico|sanaa|sirocco|au lait cru/i.test(salesModesPublicSrc));
});

test("LOT B: `provider` n'est JAMAIS lu ni exposé côté frontend -- ni dans le type de la règle, ni dans le mapping RPC, ni dans le résolveur", () => {
  assert.ok(!/provider/i.test(typesSrc.slice(typesSrc.indexOf("PublicDeliveryFulfillmentRule"), typesSrc.indexOf("PublicDeliveryFulfillmentRule") + 1200)), "PublicDeliveryFulfillmentRule ne doit jamais porter de champ provider");
  const fnStart = salesModesPublicSrc.indexOf("export async function getPublicDeliveryFulfillments");
  const fnEnd = salesModesPublicSrc.indexOf("\n}", fnStart);
  assert.ok(!salesModesPublicSrc.slice(fnStart, fnEnd).includes("provider"));
  const resolverStart = deliverySrc.indexOf("export function resolveDeliveryFulfillment");
  const resolverEnd = deliverySrc.indexOf("\n}", resolverStart);
  assert.ok(!deliverySrc.slice(resolverStart, resolverEnd).includes("provider"));
});

// --------------------------------------------------------------------
// Comportement -- un test par scénario, miroir des scénarios du
// harnais SQL (supabase/tests/fulfillment-routing-lot-b-check.sh)
// --------------------------------------------------------------------

test("LOT B: aucune règle -- hors zone (jamais une exception)", () => {
  const result = resolveDeliveryFulfillment([], "75001", 5);
  assert.deepEqual(result, { eligible: false, block: "out-of-zone" });
});

test("LOT B.1: code postal absent (vide après trim) -- refusé avec block='no-postal', avant même de consulter les règles -- MÊME AVEC un fallback par ailleurs éligible (corrigé FRB-B-01, voir tests/fixtures/fulfillment-routing-cases.json)", () => {
  const rules = [
    rule({ zonePrefixes: ["75"] }),
    rule({ fulfillmentCode: "wide_shipping", isFallback: true, zonePrefixes: [], minItems: 0 }),
  ];
  assert.deepEqual(resolveDeliveryFulfillment(rules, "", 5), { eligible: false, block: "no-postal" });
  assert.deepEqual(resolveDeliveryFulfillment(rules, "   ", 5), { eligible: false, block: "no-postal" });
});

test("LOT B.2 (FRB-B-01, HIGH): code postal null (valeur RÉELLE null, pas la chaîne vide) -- NE PLANTE PLUS, refusé avec block='no-postal', AUCUNE règle retenue -- même avec un fallback par ailleurs éligible. Reproduit et corrigé : `postalCode.trim()` levait auparavant `TypeError: Cannot read properties of null (reading 'trim')`.", () => {
  const rules = [
    rule({ zonePrefixes: ["75"] }),
    rule({ fulfillmentCode: "wide_shipping", isFallback: true, zonePrefixes: [], minItems: 0 }),
  ];
  let result: ReturnType<typeof resolveDeliveryFulfillment> | undefined;
  assert.doesNotThrow(() => {
    result = resolveDeliveryFulfillment(rules, null, 5);
  }, "un postalCode null ne doit jamais lever d'exception");
  assert.deepEqual(result, { eligible: false, block: "no-postal" });
});

test("LOT B.2 (FRB-B-01, HIGH): code postal undefined -- NE PLANTE PLUS, même décision no-postal que null/''/'   ' (undefined n'est pas représentable en JSON, donc testé ici directement plutôt que dans la fixture partagée)", () => {
  const rules = [
    rule({ zonePrefixes: ["75"] }),
    rule({ fulfillmentCode: "wide_shipping", isFallback: true, zonePrefixes: [], minItems: 0 }),
  ];
  let result: ReturnType<typeof resolveDeliveryFulfillment> | undefined;
  assert.doesNotThrow(() => {
    result = resolveDeliveryFulfillment(rules, undefined, 5);
  }, "un postalCode undefined ne doit jamais lever d'exception");
  assert.deepEqual(result, { eligible: false, block: "no-postal" });
});

test("LOT B.2 (FRB-B-01): la signature de resolveDeliveryFulfillment accepte explicitement `string | null | undefined` pour postalCode (pas seulement `string`) -- preuve textuelle que le typage a bien été élargi, pas seulement contourné au runtime", () => {
  const sigStart = deliverySrc.indexOf("export function resolveDeliveryFulfillment");
  const sigEnd = deliverySrc.indexOf(")", deliverySrc.indexOf("totalCount", sigStart));
  const signature = deliverySrc.slice(sigStart, sigEnd);
  assert.ok(
    /postalCode\s*:\s*string\s*\|\s*null\s*\|\s*undefined/.test(signature),
    "la signature doit typer postalCode comme string | null | undefined"
  );
});

test("LOT B.1: code postal de format non standard ('abc') n'est PAS traité comme invalide -- moteur GÉNÉRIQUE, aucune validation de format France-specific (corrigé FRB-B-01 : cette fonction ne dépend plus de isValidPostalCode) -- ne matche simplement aucun préfixe, retombe sur le fallback normalement", () => {
  const rules = [
    rule({ zonePrefixes: ["75"] }),
    rule({ fulfillmentCode: "wide_shipping", isFallback: true, zonePrefixes: [], minItems: 0 }),
  ];
  const result = resolveDeliveryFulfillment(rules, "abc", 5);
  assert.equal(result.eligible, true);
  assert.equal(result.fulfillmentCode, "wide_shipping");
  assert.equal(result.matchedPrefix, undefined, "un fallback n'a jamais de matchedPrefix");
});

test("LOT B.1: resolveDeliveryFulfillment n'APPELLE plus isValidPostalCode dans sa propre définition (découplage explicite du contrôle de format France-specific, FRB-B-01) -- le nom peut légitimement apparaître dans un commentaire expliquant pourquoi il n'est plus utilisé (exactement comme ce test le fait lui-même), ce qui est interdit c'est un APPEL réel, `isValidPostalCode(`", () => {
  const start = deliverySrc.indexOf("export function resolveDeliveryFulfillment");
  const end = deliverySrc.indexOf("\n}", start);
  const body = deliverySrc.slice(start, end);
  const executableBody = body
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.ok(!executableBody.includes("isValidPostalCode("));
});

test("LOT B.1: matchedPrefix porte le préfixe précis retenu (non-fallback) et vaut undefined pour un fallback -- comparable directement à la colonne matched_prefix du résolveur SQL (FRB-B-02)", () => {
  const rules = [
    rule({ fulfillmentCode: "specific_first", zonePrefixes: ["750"], displayOrder: 0 }),
    rule({ fulfillmentCode: "generic_second", zonePrefixes: ["75"], displayOrder: 1 }),
  ];
  const result = resolveDeliveryFulfillment(rules, "75012", 0);
  assert.equal(result.matchedPrefix, "750");
});

test("LOT B: préfixe correspondant (non-fallback), minimum atteint -- éligible, fulfillmentCode/customerText renseignés", () => {
  const rules = [rule({ fulfillmentCode: "local_delivery_75", zonePrefixes: ["75"], minItems: 5, customerText: "Livraison locale le jour même", displayOrder: 0 })];
  const result = resolveDeliveryFulfillment(rules, "75001", 5);
  assert.equal(result.eligible, true);
  assert.equal(result.fulfillmentCode, "local_delivery_75");
  assert.equal(result.customerText, "Livraison locale le jour même");
  assert.equal(result.matchedRule?.fulfillmentCode, "local_delivery_75");
});

test("LOT B: préfixe correspondant, minimum NON atteint -- refusé, missing exact, mais fulfillmentCode/matchedRule restent renseignés (contrairement à DeliveryStatus.zone-only)", () => {
  const rules = [rule({ fulfillmentCode: "local_delivery_75", zonePrefixes: ["75"], minItems: 10 })];
  const result = resolveDeliveryFulfillment(rules, "75001", 4);
  assert.equal(result.eligible, false);
  assert.equal(result.block, "below-min");
  assert.equal(result.missing, 6);
  assert.equal(result.fulfillmentCode, "local_delivery_75", "le fulfillmentCode de la règle presque-éligible doit rester exposé");
});

test("LOT B: minItems = null -- traité comme aucun minimum (0), toute quantité positive est éligible", () => {
  const rules = [rule({ fulfillmentCode: "x", zonePrefixes: ["75"], minItems: null })];
  const result = resolveDeliveryFulfillment(rules, "75001", 1);
  assert.equal(result.eligible, true);
});

test("LOT B: aucune règle non-fallback ne matche -- retombe sur le fallback", () => {
  const rules = [
    rule({ fulfillmentCode: "local_delivery_75", zonePrefixes: ["75"], displayOrder: 0 }),
    rule({ fulfillmentCode: "wide_shipping", isFallback: true, zonePrefixes: [], minItems: 10, displayOrder: 1 }),
  ];
  const result = resolveDeliveryFulfillment(rules, "13001", 10);
  assert.equal(result.eligible, true);
  assert.equal(result.fulfillmentCode, "wide_shipping");
});

test("LOT B: aucune règle non-fallback ne matche, AUCUN fallback -- hors zone, mode non éligible", () => {
  const rules = [rule({ fulfillmentCode: "local_delivery_75", zonePrefixes: ["75"], displayOrder: 0 })];
  const result = resolveDeliveryFulfillment(rules, "13001", 10);
  assert.deepEqual(result, { eligible: false, block: "out-of-zone" });
});

test("LOT B: ordre piloté EXPLICITEMENT par displayOrder -- pas par la longueur/spécificité du préfixe (75 et 750 chevauchants, display_order=0 gagne)", () => {
  const rules = [
    rule({ fulfillmentCode: "specific_first", zonePrefixes: ["750"], displayOrder: 0 }),
    rule({ fulfillmentCode: "generic_second", zonePrefixes: ["75"], displayOrder: 1 }),
  ];
  const result = resolveDeliveryFulfillment(rules, "75012", 0);
  assert.equal(result.fulfillmentCode, "specific_first");
});

test("LOT B: ordre piloté par displayOrder -- INDÉPENDANT de l'ordre du tableau reçu (tri explicite, jamais l'ordre d'insertion supposé)", () => {
  const rules = [
    rule({ fulfillmentCode: "generic_second", zonePrefixes: ["75"], displayOrder: 1 }),
    rule({ fulfillmentCode: "specific_first", zonePrefixes: ["750"], displayOrder: 0 }),
  ];
  const result = resolveDeliveryFulfillment(rules, "75012", 0);
  assert.equal(result.fulfillmentCode, "specific_first", "le tableau est reçu dans le désordre -- la fonction doit trier elle-même par displayOrder, jamais faire confiance à l'ordre reçu");
});

test("LOT B: règle désactivée exclue AVANT l'appel -- resolveDeliveryFulfillment ne reçoit que des règles déjà filtrées enabled=true (contrat de la RPC), jamais de filtrage enabled ici", () => {
  const start = deliverySrc.indexOf("export function resolveDeliveryFulfillment");
  const end = deliverySrc.indexOf("\n}", start);
  assert.ok(!deliverySrc.slice(start, end).includes(".enabled"), "aucun champ 'enabled' n'existe sur PublicDeliveryFulfillmentRule -- la RPC (get_restaurant_public_delivery_fulfillments) a déjà filtré, comme pour PublicDeliveryInfo");
});

test("LOT B: deux règles non-fallback, la seconde matche seule -- résolue correctement (pas seulement la première testée)", () => {
  const rules = [
    rule({ fulfillmentCode: "local_delivery_75", zonePrefixes: ["75"], displayOrder: 0 }),
    rule({ fulfillmentCode: "local_delivery_92", zonePrefixes: ["92", "93"], displayOrder: 1 }),
  ];
  const result = resolveDeliveryFulfillment(rules, "92100", 0);
  assert.equal(result.fulfillmentCode, "local_delivery_92");
});

test("LOT B: mutation defense -- resolveDeliveryFulfillment ne mute jamais le tableau `rules` reçu (tri sur une copie)", () => {
  const rules = [
    rule({ fulfillmentCode: "b", displayOrder: 1 }),
    rule({ fulfillmentCode: "a", displayOrder: 0 }),
  ];
  const before = rules.map((r) => r.fulfillmentCode);
  resolveDeliveryFulfillment(rules, "75001", 0);
  assert.deepEqual(rules.map((r) => r.fulfillmentCode), before, "le tableau reçu ne doit jamais être réordonné en place");
});

// --------------------------------------------------------------------
// getPublicDeliveryFulfillments -- service wrapper additif
// --------------------------------------------------------------------

test("LOT B: getPublicDeliveryFulfillments appelle bien get_restaurant_public_delivery_fulfillments avec p_restaurant_id, mappe camelCase, jamais provider", async (t) => {
  const rpcCalls: { name: string; params: unknown }[] = [];
  t.mock.method(supabase, "rpc", async (name: string, params: unknown) => {
    rpcCalls.push({ name, params });
    return {
      data: [
        {
          fulfillment_code: "local_delivery_75",
          zone_prefixes: ["75"],
          is_fallback: false,
          min_items: 5,
          customer_text: "texte",
          display_order: 0,
          pricing_mode: "free",
          fixed_fee: null,
          free_threshold: null,
        },
      ],
      error: null,
    };
  });

  const result = await getPublicDeliveryFulfillments("r1");

  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, "get_restaurant_public_delivery_fulfillments");
  assert.deepEqual(rpcCalls[0].params, { p_restaurant_id: "r1" });
  assert.deepEqual(result, [
    {
      fulfillmentCode: "local_delivery_75",
      zonePrefixes: ["75"],
      isFallback: false,
      minItems: 5,
      customerText: "texte",
      displayOrder: 0,
      pricingMode: "free",
      fixedFee: null,
      freeThreshold: null,
    },
  ]);
  assert.ok(!("provider" in (result[0] as object)), "le résultat mappé ne doit jamais porter de champ provider");
});

test("LOT B: getPublicDeliveryFulfillments -- data null/absent -- tableau vide, jamais une exception", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: null, error: null }));
  const result = await getPublicDeliveryFulfillments("r1");
  assert.deepEqual(result, []);
});

test("LOT B: getPublicDeliveryFulfillments -- erreur RPC -- rejette avec le message d'erreur, jamais silencieux", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: null, error: { message: "permission denied" } }));
  await assert.rejects(() => getPublicDeliveryFulfillments("r1"), /permission denied/);
});

test("LOT B: getPublicDeliveryFulfillments -- min_items NULL préservé tel quel (jamais coalescé à 0 côté wrapper -- c'est resolveDeliveryFulfillment qui applique le repli, pas ce mapping)", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: [{ fulfillment_code: "x", zone_prefixes: [], is_fallback: true, min_items: null, customer_text: null, display_order: 0 }],
    error: null,
  }));
  const result = await getPublicDeliveryFulfillments("r1");
  assert.equal(result[0].minItems, null);
});

// --------------------------------------------------------------------
// Portée du lot -- aucune activation tenant, aucun changement SQL
// existant, aucun appel Stuart/Chronofresh
// --------------------------------------------------------------------

test("LOT B: le DRAFT SQL n'insère STRICTEMENT AUCUNE donnée tenant (aucun INSERT INTO)", () => {
  assert.ok(!/insert\s+into/i.test(draftSql));
});

test("LOT B: le DRAFT SQL ne modifie AUCUN objet de LOT A (aucun ALTER TABLE/DROP sur restaurant_sale_mode_fulfillments)", () => {
  assert.ok(!/alter\s+table\s+public\.restaurant_sale_mode_fulfillments/i.test(draftSql));
  assert.ok(!/drop\s+table/i.test(draftSql));
});

test("LOT B: le DRAFT SQL n'appelle jamais Stuart/Chronofresh (aucune URL, aucune extension réseau http/pg_net)", () => {
  assert.ok(!/https?:\/\//i.test(draftSql));
  assert.ok(!/pg_net|http_post|http_get/i.test(draftSql));
  // Le NOM des prestataires peut légitimement apparaître dans un
  // commentaire de documentation (ex. rappel de portée "AUCUN appel
  // Stuart/Chronofresh"), exactement comme le fait ce test lui-même et
  // la mission qui l'a demandé -- ce qui est STRICTEMENT interdit,
  // c'est une référence dans une ligne de SQL EXÉCUTABLE (hors
  // commentaires "--") : un littéral CHECK, une valeur codée en dur,
  // un nom d'extension, etc. `provider` reste le CHECK générique
  // hérité de LOT A (non modifié par ce DRAFT), jamais un prestataire
  // nommé en dur dans le code SQL réel de ce lot.
  const executableSql = draftSql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.ok(
    !/stuart|chronofresh/i.test(executableSql),
    "aucune ligne de SQL EXÉCUTABLE (hors commentaires) ne doit référencer ces prestataires en dur"
  );
});

test("LOT B: le DRAFT SQL documente explicitement l'avertissement 'NE JAMAIS EXÉCUTER SUR SUPABASE PRODUCTION'", () => {
  assert.ok(draftSql.includes("NE JAMAIS EXÉCUTER SUR SUPABASE PRODUCTION"));
});

test("LOT B: le DRAFT SQL révoque explicitement resolve_delivery_fulfillment de public/anon/authenticated (REVOKE avant tout GRANT, jamais l'inverse)", () => {
  const revokeIdx = draftSql.indexOf("revoke all on function public.resolve_delivery_fulfillment");
  assert.ok(revokeIdx > 0, "le REVOKE doit exister");
  assert.ok(!draftSql.includes("grant execute on function public.resolve_delivery_fulfillment"), "aucun GRANT ne doit jamais exister pour le résolveur interne -- aucun appelant direct dans ce lot");
});

test("LOT B: le DRAFT SQL révoque AVANT de accorder EXECUTE sur la RPC publique (ordre textuel réel, pas seulement documenté)", () => {
  const revokeIdx = draftSql.indexOf("revoke all on function public.get_restaurant_public_delivery_fulfillments");
  const grantIdx = draftSql.indexOf("grant execute on function public.get_restaurant_public_delivery_fulfillments");
  assert.ok(revokeIdx > 0 && grantIdx > revokeIdx, "REVOKE doit précéder GRANT dans le texte réel du fichier");
});
