import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ============================================================
// Scanym — PAYMENT P2B-B — DASHBOARD PAYMENT MODULE v1 — vérifications
// structurelles (même patron que tests/v106-dashboard-delivery-pricing.test.ts :
// lecture du source réel, assertions par sous-chaîne/regex, aucun
// rendu DOM -- le comportement RPC/base est déjà couvert de bout en
// bout par supabase/tests/payment-p2b-a-safe-merchant-read-check.sh,
// 61/61 (PAYMENT P2B-A v2), et n'est pas retesté ici).
//
// Ce fichier prouve que la page/service/nav/i18n livrés respectent
// STRICTEMENT le périmètre de la mission P2B-B : lecture SEULE via
// UNE SEULE RPC publiée (get_merchant_payment_provider_config),
// aucun champ secret ni structurel exposé, aucune écriture, aucune
// logique de runtime de paiement, aucun SQL nouveau.
//
// Les preuves COMPORTEMENTALES (mapping DTO réel contre une ligne RPC
// mockée malicieuse, rendu réel zéro/un/plusieurs prestataires) sont
// dans tests/v109b-dashboard-payment-service.test.ts et
// tests/v109c-dashboard-payment.dom.test.ts -- ce fichier-ci ne
// "s'appuie pas uniquement sur un grep du source" pour ces
// comportements (mission section 31/42), il les COMPLÈTE.
// ============================================================

const pagePath = "app/dashboard/payment/page.tsx";
const pageSrc = readFileSync(pagePath, "utf8");
const servicesSrc = readFileSync("lib/services/dashboard.ts", "utf8");
const typesSrc = readFileSync("lib/dashboard-types.ts", "utf8");
const navSrc = readFileSync("components/dashboard/DashboardNav.tsx", "utf8");
const i18nSrc = readFileSync("lib/i18n.ts", "utf8");

test("le composant page n'appelle jamais supabase.rpc() directement -- passe exclusivement par lib/services/dashboard.ts", () => {
  assert.ok(!pageSrc.includes("supabase.rpc"));
  assert.ok(pageSrc.includes("getMerchantPaymentProviderConfig"));
});

test("le service marchand encapsule exactement la RPC publiée get_merchant_payment_provider_config, avec p_restaurant_id", () => {
  assert.ok(servicesSrc.includes('supabase.rpc("get_merchant_payment_provider_config"'));
  const fnStart = servicesSrc.indexOf("export async function getMerchantPaymentProviderConfig");
  assert.ok(fnStart > -1, "la fonction de service doit exister");
  const fnBody = servicesSrc.slice(fnStart, fnStart + 1200);
  assert.ok(fnBody.includes("p_restaurant_id: restaurantId"));
});

test("le service ne requête JAMAIS payment_provider_configs directement (aucun .from(\"payment_provider_configs\"))", () => {
  assert.ok(!servicesSrc.includes('.from("payment_provider_configs")'));
  assert.ok(!pageSrc.includes('.from("payment_provider_configs")'));
  assert.ok(!pageSrc.includes("payment_provider_configs"));
});

test("le service n'INVOQUE JAMAIS les RPC de mutation de secret (set_payment_provider_credentials / clear_payment_provider_credentials) -- ces noms peuvent légitimement apparaître en commentaire de documentation (pourquoi ils sont hors périmètre), donc on vérifie l'ABSENCE D'APPEL réel, pas l'absence totale du texte", () => {
  for (const forbidden of ["set_payment_provider_credentials", "clear_payment_provider_credentials"]) {
    assert.ok(
      !servicesSrc.includes(`supabase.rpc("${forbidden}"`) &&
        !servicesSrc.includes(`supabase.rpc('${forbidden}'`),
      `${forbidden} ne doit jamais être invoquée via supabase.rpc(...) dans le service`
    );
    assert.ok(!pageSrc.includes(forbidden), `${forbidden} ne doit apparaître nulle part dans la page`);
  }
});

test("le type marchand MerchantPaymentProviderConfig expose EXACTEMENT les 6 champs sûrs attendus, rien de plus", () => {
  const typeBlockStart = typesSrc.indexOf("interface MerchantPaymentProviderConfig");
  assert.ok(typeBlockStart > -1);
  const typeBlockEnd = typesSrc.indexOf("}", typeBlockStart);
  const typeBlock = typesSrc.slice(typeBlockStart, typeBlockEnd);
  const expectedFields = [
    "providerCode",
    "mode",
    "configurationStatus",
    "isEnabled",
    "lastVerifiedAt",
    "updatedAt",
  ];
  for (const field of expectedFields) {
    assert.ok(typeBlock.includes(field), `le champ "${field}" doit être présent`);
  }
  // Compte de champs déclarés (heuristique : une ligne par champ,
  // format "nom: type;") -- doit correspondre exactement aux 6 champs
  // attendus, ni plus ni moins.
  const fieldLines = typeBlock
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[a-zA-Z]+[?]?:\s*/.test(l));
  assert.equal(fieldLines.length, 6, `attendu exactement 6 champs déclarés, trouvé ${fieldLines.length}: ${fieldLines.join(" | ")}`);
});

test("AUCUN champ secret/structurel (id, restaurant_id, credentials_ref, credentialsRef, secret, password, vault, mac, tpe, token, signing) n'apparaît dans le type marchand, le service, ni la page", () => {
  const forbidden = [
    "credentials_ref",
    "credentialsRef",
    "restaurant_id",
    "secret",
    "password",
    "vault",
    "mac",
    "tpe",
    "token",
    "signing",
  ];
  const typeBlockStart = typesSrc.indexOf("interface MerchantPaymentProviderConfig");
  const typeBlockEnd = typesSrc.indexOf("}", typeBlockStart);
  const typeBlock = typesSrc.slice(typeBlockStart, typeBlockEnd).toLowerCase();
  // Le service : on isole la fonction getMerchantPaymentProviderConfig
  // uniquement (pas tout le fichier, qui contient d'autres fonctions
  // légitimes utilisant des mots comme "token" ailleurs sans rapport).
  const svcStart = servicesSrc.indexOf("export async function getMerchantPaymentProviderConfig");
  const svcEnd = servicesSrc.indexOf("\n}\n", svcStart);
  const svcBlock = servicesSrc.slice(svcStart, svcEnd).toLowerCase();
  // Comme pour svcBlock ci-dessus, on isole le CODE de la page (à partir du
  // composant React lui-même) en excluant le commentaire JSDoc d'en-tête du
  // fichier, qui décrit la mission en langage naturel (ex. "NO SECRET
  // EXPOSURE — ... AUCUNE écriture, AUCUN champ secret") -- ce texte
  // explicatif contient légitimement le mot "secret" sans qu'aucun champ,
  // variable ou UI secrète n'existe réellement dans le code.
  const pageCodeStart = pageSrc.indexOf("export default function PaymentPage");
  assert.ok(pageCodeStart > -1, "le composant PaymentPage doit exister");
  const pageBlock = pageSrc.slice(pageCodeStart).toLowerCase();
  // "restaurant_id" est un cas particulier avec DEUX sources légitimes de
  // faux positifs, ni l'une ni l'autre liée au DTO de paiement :
  //  1. Le PARAMÈTRE D'ENTRÉE légitime et obligatoire de la RPC s'appelle
  //     "p_restaurant_id" (supabase.rpc("get_merchant_payment_provider_config",
  //     { p_restaurant_id: ... })) -- l'identifiant du restaurant appelant,
  //     déjà connu du marchand authentifié, jamais une donnée renvoyée par
  //     la RPC de paiement.
  //  2. La page réutilise le type EXISTANT `MerchantRestaurant` (pattern du
  //     Dashboard déjà en place, ex. delivery-pricing) pour la sélection du
  //     restaurant courant -- `mappings`/`mapping`/`m.restaurant_id`
  //     (mission section 21 : "use currently selected/authenticated
  //     restaurant exactly as existing Dashboard modules do"). Ce champ
  //     n'appartient PAS au DTO de paiement `MerchantPaymentProviderConfig`
  //     et n'est jamais lu depuis une ligne renvoyée par
  //     get_merchant_payment_provider_config.
  // On retire donc ces deux formes légitimes avant de vérifier l'absence de
  // "restaurant_id" dans le service/la page, tout en gardant la
  // vérification stricte et SANS exception dans le type DTO (typeBlock), où
  // AUCUNE forme de "restaurant_id" n'a de raison légitime d'apparaître.
  const svcBlockNoLegitParam = svcBlock.split("p_restaurant_id").join("");
  const pageBlockNoLegitParam = pageBlock
    .split("p_restaurant_id")
    .join("")
    .split(".restaurant_id")
    .join("");
  // Ceinture ET bretelles : même après avoir retiré ces formes légitimes,
  // on vérifie explicitement que la variable de boucle du DTO de paiement
  // ("config", cf. rows.map((config) => ...)) n'accède JAMAIS à un champ
  // restaurant_id/restaurantId -- ce serait, lui, un vrai défaut.
  assert.ok(!pageBlock.includes("config.restaurant_id"), "le DTO de paiement affiché (config) ne doit jamais exposer restaurant_id");
  assert.ok(!pageBlock.includes("config.restaurantid"), "le DTO de paiement affiché (config) ne doit jamais exposer restaurantId");
  for (const field of forbidden) {
    const needle = field.toLowerCase();
    assert.ok(!typeBlock.includes(needle), `"${field}" ne doit pas apparaître dans le type marchand`);
    if (needle === "restaurant_id") {
      assert.ok(
        !svcBlockNoLegitParam.includes(needle),
        `"${field}" ne doit apparaître dans le service que via le paramètre légitime p_restaurant_id`
      );
      assert.ok(
        !pageBlockNoLegitParam.includes(needle),
        `"${field}" ne doit apparaître dans la page que via le paramètre légitime p_restaurant_id`
      );
    } else {
      assert.ok(!svcBlock.includes(needle), `"${field}" ne doit pas apparaître dans le service de lecture paiement`);
      assert.ok(!pageBlock.includes(needle), `"${field}" ne doit pas apparaître dans la page`);
    }
  }
  // "id" seul (pas "providerCode"/"configurationStatus" etc. qui le
  // contiennent en sous-chaîne) -- recherche par mot entier dans le
  // bloc de type uniquement, où une simple sous-chaîne suffirait à
  // trahir un champ `id` littéral.
  assert.ok(!/\bid\s*:/.test(typeBlock), "aucun champ 'id' littéral ne doit être déclaré");
});

test("le mapping du service est EXPLICITE champ par champ -- pas de spread générique ({ ...row }) ni de sérialiseur générique", () => {
  const svcStart = servicesSrc.indexOf("export async function getMerchantPaymentProviderConfig");
  const svcEnd = servicesSrc.indexOf("\n}\n", svcStart);
  const svcBlock = servicesSrc.slice(svcStart, svcEnd);
  assert.ok(!svcBlock.includes("...row"), "aucun spread générique du row brut ne doit être utilisé");
  assert.ok(!svcBlock.includes("...data"));
  // Les 6 mappings explicites snake_case -> camelCase doivent être présents.
  const expectedMappings = [
    "providerCode: row.provider_code",
    "mode: row.mode",
    "configurationStatus: row.configuration_status",
    "isEnabled: row.is_enabled",
    "lastVerifiedAt: row.last_verified_at",
    "updatedAt: row.updated_at",
  ];
  for (const m of expectedMappings) {
    assert.ok(svcBlock.includes(m), `mapping explicite manquant : "${m}"`);
  }
});

test("aucun élément d'interaction de mutation (input/select/toggle/save/edit/enable/disable/create/delete provider) sur la page -- lecture SEULE (mission section 18)", () => {
  assert.ok(!pageSrc.includes("<input"));
  assert.ok(!pageSrc.includes("<select"));
  assert.ok(!pageSrc.includes("<textarea"));
  assert.ok(!pageSrc.includes("<button"));
  assert.ok(!pageSrc.toLowerCase().includes("onclick"));
  assert.ok(!pageSrc.toLowerCase().includes("onchange"));
  assert.ok(!pageSrc.toLowerCase().includes("onsubmit"));
});

test("aucune UI de secret (champ credential, secret masqué, mot de passe, TPE, MAC, clé API, référence Vault, bouton copier-secret)", () => {
  const lower = pageSrc.toLowerCase();
  for (const forbidden of [
    "credential",
    "password",
    "masked",
    "tpe",
    "mac",
    "api key",
    "apikey",
    "vault",
    "copy-secret",
    "copysecret",
  ]) {
    assert.ok(!lower.includes(forbidden), `"${forbidden}" ne doit apparaître nulle part sur la page`);
  }
});

test("aucun chemin de code n'invoque de runtime de paiement (Monetico/CIC adapter, initiate/confirm payment, redirect/callback/webhook, MAC generation)", () => {
  const forbidden = [
    "initiate_payment_attempt",
    "confirm_payment_attempt",
    "monetico_adapter",
    "cic_adapter",
    "payment_redirect",
    "payment_callback",
    "webhook",
    "generateMac",
    "hosted_payment_page",
  ];
  for (const f of forbidden) {
    assert.ok(!pageSrc.toLowerCase().includes(f.toLowerCase()));
    assert.ok(!servicesSrc.toLowerCase().includes(f.toLowerCase()));
  }
});

test("le rendu de plusieurs prestataires n'est jamais borné à 1 -- aucun slice(0,1)/[0] isolé/LIMIT-like sur les rows avant .map()", () => {
  assert.ok(!pageSrc.includes("rows[0]"));
  assert.ok(!pageSrc.includes("rows.slice(0, 1)"));
  assert.ok(!pageSrc.includes("rows.slice(0,1)"));
  assert.ok(pageSrc.includes("rows.map("), "toutes les lignes retournées doivent être rendues via .map()");
});

test("le rendu utilise l'ordre RPC tel que livré (aucun tri/inversion frontend ajouté)", () => {
  assert.ok(!pageSrc.includes(".sort("), "aucun tri frontend ne doit être appliqué -- l'ordre du RPC (order by provider_code) est déjà déterministe");
});

test("aucun message d'erreur brut (SQLSTATE, détail Supabase, nom de table/fonction, UUID) n'est affiché -- seul un message marchand-sûr (payLoadFailed) est utilisé", () => {
  assert.ok(pageSrc.includes('t("payLoadFailed")'));
  assert.ok(!pageSrc.includes("e.message"));
  assert.ok(!pageSrc.includes("err.message"));
  assert.ok(!pageSrc.includes("error.message"));
});

test("l'onglet de navigation 'Paiement' est ajouté sans casser l'exclusion déjà corrigée (L1B-02) de l'onglet Commandes", () => {
  assert.ok(navSrc.includes("onPayment"));
  assert.ok(navSrc.includes("!onPayment"));
  assert.ok(navSrc.includes('href("/dashboard/payment")'));
});

test("les clés i18n pay* et dsPayment existent dans les 3 dictionnaires (fr/en/ar)", () => {
  const requiredKeys = [
    "dsPayment",
    "payTitle",
    "payHint",
    "payTechnicalNote",
    "payEmpty",
    "payEmptyHint",
    "payLoadFailed",
    "payProviderLabel",
    "payEnvironmentLabel",
    "payStatusLabel",
    "payEnabledLabel",
    "payDisabledLabel",
    "payLastVerifiedLabel",
    "payNotVerified",
    "payStatusNotConfigured",
    "payStatusConfigured",
    "payStatusVerified",
    "payStatusUnknown",
    "payModeTest",
    "payModeLive",
    "payModeUnknown",
    "payUpdatedLabel",
  ];
  for (const key of requiredKeys) {
    const occurrences = i18nSrc.split(`${key}:`).length - 1;
    assert.ok(
      occurrences >= 3,
      `la clé "${key}" doit apparaître au moins 3 fois (fr + en + ar), trouvé ${occurrences}`
    );
  }
});

test("aucun fichier DRAFT SQL / migration n'est modifié ou créé par cette mission (P2B-B est application-only)", () => {
  // Preuve indirecte mais utile en CI : le service référence le nom
  // de RPC publié P2B-A, jamais un nom de fichier SQL DRAFT nouveau.
  assert.ok(!servicesSrc.includes("DRAFT-lot-payment-p2b-b"));
  assert.ok(!pageSrc.includes("DRAFT-lot-payment-p2b-b"));
});

test("le texte d'état vide reprend exactement le libellé produit attendu par la mission (mission section 9)", () => {
  assert.equal(
    i18nSrc.split("payEmpty:")[1].split("\n")[0].trim(),
    '"Le paiement en ligne n\'est pas encore configuré pour cet établissement.",'
  );
});
