import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// Scanym — CUSTOMER CONFIRMATION + TRACKING FINAL v1.1 — remédiation
// CCTF-V1-PAYMENT-RETURN-LANGUAGE-REACHABILITY-01 (Cat Woman, audit
// indépendant, MEDIUM, release-blocking).
//
// Couvre lib/server/payment-checkout-runtime.ts::initiateCheckout --
// section 18 (construction url_retour_ok/url_retour_err) porte
// désormais un paramètre `lang`, dérivé de `input.language` (le MÊME
// champ d'entrée déjà validé pour Monetico, jamais un second champ
// nouveau) via `resolveLangFromParam` (lib/i18n.ts, SEULE autorité
// déjà partagée par les pages de retour et par la page de suivi).
//
// GAP HONNÊTEMENT DOCUMENTÉ, PAS CONTOURNÉ (mandat : "never fake a
// test result") -- item mandaté "AR checkout produces lang=ar return
// URLs" : Monetico lui-même (monetico/request.ts::SUPPORTED_LANGUAGES
// = {"FR","EN"} UNIQUEMENT, comportement PRÉEXISTANT à ce lot,
// protégé par le verrou de flux "no Monetico activation change"/
// "Monetico adapter semantics unchanged") REJETTE structurellement
// toute valeur `language` autre que FR/EN AVANT même d'atteindre la
// construction d'URL (section 1b de initiateCheckout,
// canonicalizeMoneticoLanguage -- comportement AUDITÉ et INTENTIONNEL
// depuis PREFLIGHT-01 v4.2, voir tests/v125-payment-p3bmcr-v3-
// checkout-runtime.test.ts lignes ~373-477, NON modifié par ce lot).
// Un vrai `initiateCheckout({ language: "ar", ... })` de bout en bout
// ne peut donc JAMAIS atteindre l'issue "ready" aujourd'hui -- ce
// n'est PAS un défaut de ce correctif, c'est une limite PRÉEXISTANTE
// et ORTHOGONALE du prestataire Monetico lui-même (sa page hébergée
// n'a pas de version arabe), que ce lot n'a explicitement PAS le droit
// de changer. La reachability de `lang=ar` est donc prouvée ici par
// DEUX preuves complémentaires et honnêtes plutôt qu'un faux test de
// bout en bout :
//   1. un test STRUCTUREL (lecture directe du code source) prouvant
//      que la construction des DEUX URLs utilise bien la MÊME valeur
//      dérivée de `resolveLangFromParam(input.language)` -- donc,
//      pour TOUTE langue que `resolveLangFromParam` accepte
//      (fr/en/ar), le mécanisme de construction lui-même est
//      identique et symétrique, indépendant de la restriction
//      Monetico ;
//   2. tests/v162-tracking-final-lang-resolution.test.ts prouve déjà
//      `resolveLangFromParam("ar") === "ar"` directement (mandat item
//      "fr/en/ar accepted") ;
//   3. tests/v165-tracking-final-page-languages.dom.test.ts prouve
//      déjà que la page de retour/suivi RÉELLE affiche correctement
//      l'arabe une fois `?lang=ar` présent dans l'URL, quelle que
//      soit la façon dont ce paramètre y est arrivé.
// Ce gap (Monetico ne supporte pas l'arabe pour sa PROPRE page
// hébergée) est rapporté explicitement dans le rapport d'audit --
// jamais maquillé par un test qui ferait semblant de le contourner.
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "cctf-v1-1-synthetic-service-role-key-DO-NOT-USE";
process.env.SCANYM_PUBLIC_ORIGIN ??= "https://checkout.example.test";
process.env.PAYMENT_RETURN_RELAY_KEY_V1 ??=
  "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4";
process.env.PAYMENT_RETURN_RELAY_ACTIVE_KEY_VERSION ??= "1";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { initiateCheckout } = await import("../lib/server/payment-checkout-runtime.ts");
const { verifyReturnRelayToken } = await import("../lib/server/payment-return-relay.ts");

type InitiateCheckoutResult = Awaited<ReturnType<typeof initiateCheckout>>;
type ReadyResult = Extract<InitiateCheckoutResult, { outcome: "ready" }>;

function assertReady(result: InitiateCheckoutResult): asserts result is ReadyResult {
  assert.equal(result.outcome, "ready", `attendu "ready", obtenu "${result.outcome}"`);
}

const CREDENTIAL_JSON = JSON.stringify({
  tpe: "1234567",
  societe: "cctfv11societe",
  securityKey: "0123456789abcdef0123456789abcdef01234567",
});

type RpcHandler = (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown;

function routeRpc(t: { mock: { method: Function } }, handlers: Record<string, RpcHandler>) {
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    const handler = handlers[name];
    if (!handler) {
      throw new Error(`RPC inattendue dans ce scénario de test : ${name}`);
    }
    return handler(name, args);
  });
}

const ok = (row: unknown) => ({ data: [row], error: null });

async function withEnabledKillSwitch<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.PAYMENT_CHECKOUT_RUNTIME_ENABLED;
  process.env.PAYMENT_CHECKOUT_RUNTIME_ENABLED = "true";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PAYMENT_CHECKOUT_RUNTIME_ENABLED;
    else process.env.PAYMENT_CHECKOUT_RUNTIME_ENABLED = previous;
  }
}

/** Même gabarit "ready" minimal que tests/v125 (chemin FRAIS, pickup,
 *  facturation manuelle -- rien de spécifique à la langue). */
function freshReadyHandlers(overrides: Partial<Record<string, RpcHandler>> = {}) {
  return {
    get_order_payment_context: () => ok({ restaurant_id: "resto-1", payment_status: "pending" }),
    get_order_currency_preflight: () => ok({ currency: "EUR" }),
    get_payment_runtime_provider_environment: () =>
      ok({ provider_code: "monetico", is_enabled: true, configuration_status: "verified", mode: "test" }),
    get_order_active_payment_attempt: () => ({ data: [], error: null }),
    get_payment_provider_credential: () => ({ data: CREDENTIAL_JSON, error: null }),
    get_order_billing_context: () =>
      ok({
        source: "manual",
        address_line_1: "1 rue de Test",
        address_line_2: null,
        city: "Paris",
        postal_code: "75001",
        country: "FR",
        state_or_province: null,
        customer_name: "Test Client",
        customer_email: null,
        customer_phone: null,
      }),
    get_order_service_mode: () => ok({ service_mode: "pickup" }),
    initiate_payment_attempt: () => ok({ transaction_id: "txn-1", amount: 10, currency: "EUR" }),
    ...overrides,
  };
}

// ============================================================
// mandat item 11 : FR checkout produces lang=fr return URLs.
// ============================================================
test("mandat item 11 « FR checkout produces lang=fr return URLs » : language omise (défaut produit préexistant FR, INCHANGÉ) -- url_retour_ok/url_retour_err portent lang=fr", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(t, freshReadyHandlers());
    const result = await initiateCheckout({ orderId: "order-fr-1", publicToken: "tok-fr-1" });
    assertReady(result);

    const urlOk = new URL(result.fields.url_retour_ok!);
    const urlErr = new URL(result.fields.url_retour_err!);
    assert.equal(urlOk.searchParams.get("lang"), "fr");
    assert.equal(urlErr.searchParams.get("lang"), "fr");
  }));

test("mandat item 11 (variante explicite) : language=\"fr\" -- url_retour_ok/url_retour_err portent lang=fr", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(t, freshReadyHandlers());
    const result = await initiateCheckout({ orderId: "order-fr-2", publicToken: "tok-fr-2", language: "fr" });
    assertReady(result);

    assert.equal(new URL(result.fields.url_retour_ok!).searchParams.get("lang"), "fr");
    assert.equal(new URL(result.fields.url_retour_err!).searchParams.get("lang"), "fr");
  }));

// ============================================================
// mandat item 12 : EN checkout produces lang=en return URLs.
// ============================================================
test("mandat item 12 « EN checkout produces lang=en return URLs » : language=\"en\" -- url_retour_ok/url_retour_err portent RÉELLEMENT lang=en, de bout en bout (Monetico accepte aussi EN -- chemin RÉELLEMENT atteignable, pas seulement structurel)", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(t, freshReadyHandlers());
    const result = await initiateCheckout({ orderId: "order-en-1", publicToken: "tok-en-1", language: "en" });
    assertReady(result);

    const urlOk = new URL(result.fields.url_retour_ok!);
    const urlErr = new URL(result.fields.url_retour_err!);
    assert.equal(urlOk.searchParams.get("lang"), "en");
    assert.equal(urlErr.searchParams.get("lang"), "en");
    // Non-régression : la langue Monetico (page hébergée, espace DISTINCT
    // et INDÉPENDANT -- voir l'en-tête de fichier) reste "EN" en
    // majuscules dans les champs Monetico eux-mêmes, jamais confondue
    // avec le paramètre `lang` de nos propres pages de retour.
    assert.equal(result.fields.lgue, "EN");
  }));

// ============================================================
// mandat item 14 : unsupported language falls back safely --
// preuve RÉELLE de bout en bout (pas seulement structurelle) :
// "EN" (majuscules) est accepté par Monetico (SUPPORTED_LANGUAGES
// est insensible... non, il uppercase déjà -- "EN" passe tel quel),
// mais n'est PAS une clé PROPRE reconnue par resolveLangFromParam
// (DICTS n'a que des clés minuscules) -- repli sûr sur "fr" pour NOS
// propres pages de retour, sans jamais faire échouer le checkout
// lui-même.
// ============================================================
test("mandat item 14 « unsupported language falls back safely » : language=\"EN\" (majuscules -- accepté par Monetico, mais PAS une clé propre de DICTS) -- checkout RÉUSSIT (ready), et lang=fr (repli sûr) sur les DEUX URLs de retour, jamais une erreur ni une langue inventée", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(t, freshReadyHandlers());
    const result = await initiateCheckout({ orderId: "order-fallback-1", publicToken: "tok-fallback-1", language: "EN" });
    assertReady(result);

    assert.equal(new URL(result.fields.url_retour_ok!).searchParams.get("lang"), "fr");
    assert.equal(new URL(result.fields.url_retour_err!).searchParams.get("lang"), "fr");
    // Monetico, lui, a bien accepté "EN" tel quel pour SA PROPRE page --
    // les deux espaces de langue restent bien INDÉPENDANTS.
    assert.equal(result.fields.lgue, "EN");
  }));

// ============================================================
// mandat item 15/16 : success/error return preserve the relay token
// (non-régression explicite -- ce lot est PUREMENT additif sur ces
// URLs, le jeton de relais ne doit jamais être affecté par l'ajout de
// `lang`).
// ============================================================
test("mandat item 15/16 « relay token preserved » : orderId/token restent décodables et liés à orderId sur les DEUX URLs, `lang` n'affecte JAMAIS le jeton de relais", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(t, freshReadyHandlers());
    const result = await initiateCheckout({ orderId: "order-relay-1", publicToken: "secret-tok-relay-1", language: "en" });
    assertReady(result);

    const urlOk = new URL(result.fields.url_retour_ok!);
    const urlErr = new URL(result.fields.url_retour_err!);

    assert.equal(urlOk.searchParams.get("orderId"), "order-relay-1");
    assert.equal(urlErr.searchParams.get("orderId"), "order-relay-1");
    assert.ok(!result.fields.url_retour_ok!.includes("secret-tok-relay-1"));
    assert.ok(!result.fields.url_retour_err!.includes("secret-tok-relay-1"));

    const decodedOk = verifyReturnRelayToken(urlOk.searchParams.get("token")!, "order-relay-1");
    assert.equal(decodedOk.orderId, "order-relay-1");
    assert.equal(decodedOk.publicToken, "secret-tok-relay-1");

    const decodedErr = verifyReturnRelayToken(urlErr.searchParams.get("token")!, "order-relay-1");
    assert.equal(decodedErr.orderId, "order-relay-1");
    assert.equal(decodedErr.publicToken, "secret-tok-relay-1");

    // `lang` est un paramètre SUPPLÉMENTAIRE, jamais encodé DANS le
    // jeton lui-même (le jeton reste orderId+publicToken+ttl SEULS --
    // voir lib/server/payment-return-relay.ts, INCHANGÉ par ce lot).
    assert.equal(urlOk.searchParams.get("lang"), "en");
    assert.equal(urlErr.searchParams.get("lang"), "en");
  }));

// ============================================================
// mandat item 17 : payment authority remains server-side -- `lang`
// n'apparaît dans AUCUN champ transmis à Monetico lui-même (contexte
// signé), et ne peut donc jamais influencer la vérification de
// paiement -- seule la lecture serveur (get_order_payment_status, VIA
// le jeton de relais) fait autorité, jamais un paramètre de requête.
// ============================================================
test("mandat item 17 « payment authority remains server-side » : `lang` n'apparaît QUE dans url_retour_ok/url_retour_err -- jamais dans contexte_commande, référence, ou tout autre champ transmis à Monetico", async (t) =>
  withEnabledKillSwitch(async () => {
    routeRpc(t, freshReadyHandlers());
    const result = await initiateCheckout({ orderId: "order-authority-1", publicToken: "tok-authority-1", language: "en" });
    assertReady(result);

    const contexteDecoded = Buffer.from(result.fields.contexte_commande, "base64").toString("utf8");
    assert.equal(contexteDecoded.includes("\"lang\""), false, "contexte_commande signé ne doit jamais porter `lang`");
    assert.equal(String(result.fields.reference).includes("en"), false);
  }));

// ============================================================
// mandat item 13 « AR checkout produces lang=ar return URLs » --
// preuve STRUCTURELLE (voir le GAP documenté en en-tête de fichier :
// Monetico lui-même, INCHANGÉ, ne supporte que FR/EN pour SA PROPRE
// page, ce qui rend un `initiateCheckout({language:"ar"})` de bout en
// bout structurellement irréalisable SANS toucher Monetico -- interdit
// par le verrou de flux). Ce test lit le code source RÉEL et prouve
// que la construction des DEUX URLs utilise la MÊME variable dérivée
// de `resolveLangFromParam(input.language)`, donc que le MÉCANISME
// lui-même traiterait "ar" identiquement à "fr"/"en" s'il l'atteignait
// -- exactement ce que tests/v162 prouve déjà pour la fonction pure
// elle-même, et ce que tests/v165 prouve déjà pour la page de retour
// RÉELLE une fois `lang=ar` présent dans l'URL.
// ============================================================
test("mandat item 13 (preuve structurelle, voir GAP documenté en en-tête) : payment-checkout-runtime.ts dérive `lang` via resolveLangFromParam(input.language) et l'applique IDENTIQUEMENT aux DEUX URLs de retour", () => {
  const src = readFileSync("lib/server/payment-checkout-runtime.ts", "utf8");

  assert.ok(
    /import\s*\{\s*resolveLangFromParam\s*\}\s*from\s*["']@\/lib\/i18n["']/.test(src),
    "payment-checkout-runtime.ts doit importer resolveLangFromParam depuis lib/i18n.ts (SEULE autorité, jamais une seconde liste dupliquée)"
  );
  assert.ok(
    /resolveLangFromParam\(\s*input\.language\s*\)/.test(src),
    "la langue de retour doit être dérivée de input.language -- le MÊME champ d'entrée déjà validé, jamais un second champ nouveau"
  );

  const setOkMatch = src.match(/urlOk\.searchParams\.set\(\s*"lang"\s*,\s*(\w+)\s*\)/);
  const setErrMatch = src.match(/urlErr\.searchParams\.set\(\s*"lang"\s*,\s*(\w+)\s*\)/);
  assert.ok(setOkMatch, "urlOk.searchParams.set(\"lang\", ...) introuvable");
  assert.ok(setErrMatch, "urlErr.searchParams.set(\"lang\", ...) introuvable");
  assert.equal(
    setOkMatch![1],
    setErrMatch![1],
    "url_retour_ok et url_retour_err doivent recevoir EXACTEMENT la même variable de langue -- jamais une divergence entre succès et échec"
  );
});
