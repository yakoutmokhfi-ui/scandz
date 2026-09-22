/**
 * CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 — mandat §2.
 *
 * Couvre les invariants du texte explicatif customer-facing :
 *   - les 7 statuts canoniques sont INCHANGÉS (aucun ajout/retrait) ;
 *   - un texte de base existe pour CHACUN d'eux, dans les 3 langues,
 *     SANS aucune configuration commerçant ;
 *   - une surcharge marchande remplace le texte, jamais le statut ;
 *   - une surcharge VIDE retombe sur le texte de base ;
 *   - une surcharge ne peut jamais introduire un statut non canonique
 *     (aucun statut de livreur/prestataire inventable par configuration).
 *
 * Test PUR : aucun DOM, aucun réseau, aucune base.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CANONICAL_ORDER_STATUSES,
  type OrderStatus,
} from "@/lib/tracking/status";
import {
  MERCHANT_STATUS_TEXT_MAX_LENGTH,
  normalizeMerchantStatusText,
  resolveStatusText,
  sanitizeMerchantStatusTextOverrides,
  statusExplanationKey,
} from "@/lib/tracking/status-text";
import { DICTS, translate, type Lang } from "@/lib/i18n";

const LANGS: Lang[] = ["fr", "en", "ar"];

// ---------------------------------------------------------------
// 1. Les 7 statuts canoniques restent EXACTEMENT ceux du mandat.
// ---------------------------------------------------------------
test("1. les statuts canoniques sont inchangés, dans l'ordre exact du mandat", () => {
  assert.deepEqual(
    [...CANONICAL_ORDER_STATUSES],
    ["new", "accepted", "preparing", "ready", "completed", "rejected", "cancelled"]
  );
  assert.equal(CANONICAL_ORDER_STATUSES.length, 7);
});

// ---------------------------------------------------------------
// 2. Texte de base pour CHAQUE statut, dans CHAQUE langue,
//    sans aucune configuration commerçant.
// ---------------------------------------------------------------
test("2a. un texte de base existe pour chaque statut canonique dans fr/en/ar", () => {
  for (const lang of LANGS) {
    for (const status of CANONICAL_ORDER_STATUSES) {
      const key = statusExplanationKey(status);
      const text = translate(lang, key);
      assert.notEqual(text, key, `${lang}/${status} : clé non traduite (repli sur la clé brute)`);
      assert.ok(text.trim().length > 0, `${lang}/${status} : texte vide`);
      // Un texte EXPLICATIF, pas un simple libellé de badge recopié.
      assert.notEqual(
        text,
        translate(lang, `trackingStatus_${status}`),
        `${lang}/${status} : le texte explicatif ne doit pas dupliquer le libellé court`
      );
    }
  }
});

test("2b. parité de clés stricte entre les 3 dictionnaires (aucun repli silencieux vers le français)", () => {
  for (const status of CANONICAL_ORDER_STATUSES) {
    const key = statusExplanationKey(status);
    for (const lang of LANGS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(DICTS[lang], key),
        `clé ${key} absente du dictionnaire ${lang}`
      );
    }
  }
});

test("2c. resolveStatusText sans AUCUNE configuration marchande renvoie le texte de base", () => {
  for (const status of CANONICAL_ORDER_STATUSES) {
    for (const overrides of [undefined, null, {}]) {
      const r = resolveStatusText(status, overrides, (k) => translate("fr", k));
      assert.equal(r.source, "base");
      assert.equal(r.status, status);
      assert.equal(r.text, translate("fr", statusExplanationKey(status)));
    }
  }
});

// ---------------------------------------------------------------
// 3. Surcharge marchande : remplace le TEXTE, jamais le STATUT.
// ---------------------------------------------------------------
test("3a. une surcharge non vide remplace le texte de base", () => {
  const r = resolveStatusText(
    "preparing",
    { preparing: "Nos fromagers préparent votre plateau." },
    (k) => translate("fr", k)
  );
  assert.equal(r.text, "Nos fromagers préparent votre plateau.");
  assert.equal(r.source, "merchant_override");
  assert.equal(r.status, "preparing");
});

test("3b. la surcharge ne change JAMAIS le statut renvoyé, pour aucun statut", () => {
  for (const status of CANONICAL_ORDER_STATUSES) {
    const r = resolveStatusText(status, { [status]: "Texte commerçant." }, (k) =>
      translate("fr", k)
    );
    assert.equal(r.status, status, "le statut canonique doit traverser la résolution intact");
    assert.equal(r.text, "Texte commerçant.");
  }
});

test("3c. surcharger un statut n'affecte aucun autre statut", () => {
  const overrides = { ready: "Votre commande vous attend au comptoir." };
  const ready = resolveStatusText("ready", overrides, (k) => translate("fr", k));
  assert.equal(ready.source, "merchant_override");
  for (const status of CANONICAL_ORDER_STATUSES) {
    if (status === "ready") continue;
    const other = resolveStatusText(status, overrides, (k) => translate("fr", k));
    assert.equal(other.source, "base", `${status} ne doit pas être affecté`);
  }
});

// ---------------------------------------------------------------
// 4. Surcharge VIDE -> repli sur le texte de base (mandat §2).
// ---------------------------------------------------------------
test("4a. une surcharge vide / blanche / nulle / absente retombe sur le texte de base", () => {
  const empties: Array<string | null | undefined> = ["", "   ", "\t\n  ", null, undefined];
  for (const empty of empties) {
    for (const status of CANONICAL_ORDER_STATUSES) {
      const r = resolveStatusText(status, { [status]: empty }, (k) => translate("fr", k));
      assert.equal(
        r.source,
        "base",
        `surcharge ${JSON.stringify(empty)} pour ${status} : repli base attendu`
      );
      assert.equal(r.text, translate("fr", statusExplanationKey(status)));
      assert.ok(r.text.trim().length > 0, "le repli ne doit jamais produire un texte vide");
    }
  }
});

test("4b. normalizeMerchantStatusText : contrat de normalisation", () => {
  assert.equal(normalizeMerchantStatusText("  Bonjour  "), "Bonjour");
  assert.equal(normalizeMerchantStatusText(""), undefined);
  assert.equal(normalizeMerchantStatusText("   "), undefined);
  assert.equal(normalizeMerchantStatusText(null), undefined);
  assert.equal(normalizeMerchantStatusText(undefined), undefined);
  // Type inattendu (donnée corrompue) -> traité comme absent, jamais coercé.
  assert.equal(normalizeMerchantStatusText(42 as unknown as string), undefined);
  // Trop long -> repli base plutôt qu'une troncature au milieu d'une phrase.
  const tooLong = "x".repeat(MERCHANT_STATUS_TEXT_MAX_LENGTH + 1);
  assert.equal(normalizeMerchantStatusText(tooLong), undefined);
  const atLimit = "y".repeat(MERCHANT_STATUS_TEXT_MAX_LENGTH);
  assert.equal(normalizeMerchantStatusText(atLimit), atLimit);
});

// ---------------------------------------------------------------
// 5. Aucune surcharge ne peut introduire un statut non canonique.
// ---------------------------------------------------------------
test("5a. sanitize ignore toute clé non canonique (aucun statut livreur inventable)", () => {
  const raw = {
    preparing: "Texte légitime.",
    // Statuts de livraison/coursier explicitement HORS mandat.
    out_for_delivery: "En route vers vous",
    driver_assigned: "Livreur assigné",
    delivered: "Livré",
    // Bruit divers.
    "": "vide",
    NEW: "casse différente",
  } as Record<string, unknown>;

  const safe = sanitizeMerchantStatusTextOverrides(raw);
  assert.deepEqual(Object.keys(safe), ["preparing"]);
  assert.equal(safe.preparing, "Texte légitime.");

  for (const forbidden of ["out_for_delivery", "driver_assigned", "delivered", "NEW"]) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(safe, forbidden),
      `${forbidden} ne doit jamais survivre à l'assainissement`
    );
  }
});

test("5b. sanitize n'hérite jamais d'une valeur de la chaîne de prototypes", () => {
  // `toString`/`constructor` existent sur Object.prototype : un
  // `in`/lookup naïf les accepterait. Aucun n'est canonique, mais on
  // vérifie surtout qu'un objet SANS surcharge propre ne produit rien.
  const safe = sanitizeMerchantStatusTextOverrides({});
  assert.deepEqual(safe, {});
  assert.equal(Object.keys(safe).length, 0);
});

test("5c. sanitize applique le repli vide et la borne de longueur", () => {
  const safe = sanitizeMerchantStatusTextOverrides({
    new: "   ",
    accepted: "",
    preparing: "  Texte utile.  ",
    ready: "z".repeat(MERCHANT_STATUS_TEXT_MAX_LENGTH + 1),
  });
  assert.deepEqual(Object.keys(safe), ["preparing"]);
  assert.equal(safe.preparing, "Texte utile.");
});

test("5d. sanitize tolère null/undefined/valeur non-objet sans lever", () => {
  for (const input of [null, undefined, 42, "texte", true]) {
    assert.deepEqual(
      sanitizeMerchantStatusTextOverrides(input as unknown as Record<string, unknown>),
      {}
    );
  }
});

test("5e. sanitize ne modifie jamais l'objet reçu", () => {
  const raw: Record<string, unknown> = { preparing: "  A  ", bogus: "B" };
  const snapshot = JSON.stringify(raw);
  sanitizeMerchantStatusTextOverrides(raw);
  assert.equal(JSON.stringify(raw), snapshot);
});

// ---------------------------------------------------------------
// 6. Chaîne complète : configuration brute -> texte affiché.
// ---------------------------------------------------------------
test("6. bout en bout -- une configuration marchande partielle et bruitée produit un affichage complet et correct", () => {
  const rawTenantConfig = {
    accepted: "Commande validée par notre équipe.",
    ready: "   ", // vide -> base
    out_for_delivery: "jamais affiché", // non canonique -> ignoré
  } as Record<string, unknown>;

  const overrides = sanitizeMerchantStatusTextOverrides(rawTenantConfig);

  for (const status of CANONICAL_ORDER_STATUSES) {
    const r = resolveStatusText(status, overrides, (k) => translate("fr", k));
    assert.equal(r.status, status);
    assert.ok(r.text.trim().length > 0, `${status} : un texte est toujours affiché`);
    if (status === "accepted") {
      assert.equal(r.source, "merchant_override");
      assert.equal(r.text, "Commande validée par notre équipe.");
    } else {
      assert.equal(r.source, "base", `${status} : repli base attendu`);
      assert.equal(r.text, translate("fr", statusExplanationKey(status)));
    }
  }
});

// ---------------------------------------------------------------
// 7. Isolation inter-tenants (logique pure : deux configurations
//    distinctes ne peuvent pas se contaminer).
// ---------------------------------------------------------------
test("7. deux configurations tenant distinctes restent indépendantes", () => {
  const tenantA = sanitizeMerchantStatusTextOverrides({ preparing: "Chez A." });
  const tenantB = sanitizeMerchantStatusTextOverrides({ preparing: "Chez B." });

  const a = resolveStatusText("preparing", tenantA, (k) => translate("fr", k));
  const b = resolveStatusText("preparing", tenantB, (k) => translate("fr", k));
  assert.equal(a.text, "Chez A.");
  assert.equal(b.text, "Chez B.");

  // Un tenant SANS surcharge n'hérite jamais de celle d'un autre.
  const tenantC = sanitizeMerchantStatusTextOverrides({});
  const c = resolveStatusText("preparing", tenantC, (k) => translate("fr", k));
  assert.equal(c.source, "base");
  assert.equal(c.text, translate("fr", statusExplanationKey("preparing")));
});

// ---------------------------------------------------------------
// 8. Nommage des clés : aucune collision avec les libellés courts.
// ---------------------------------------------------------------
test("8. statusExplanationKey ne collisionne jamais avec trackingStatus_*", () => {
  const seen = new Set<string>();
  for (const status of CANONICAL_ORDER_STATUSES) {
    const key = statusExplanationKey(status);
    assert.equal(key, `trackingStatusExplain_${status}`);
    assert.ok(!seen.has(key), "clé dupliquée");
    seen.add(key);
    assert.notEqual(key, `trackingStatus_${status}`);
  }
  assert.equal(seen.size, 7);

  // Aucune clé d'explication ne doit exister pour une variante de
  // `ready` par mode de service -- celles-ci restent des libellés courts.
  for (const lang of LANGS) {
    for (const suffix of ["pickup", "delivery", "table", "room_service"]) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(
          DICTS[lang],
          `trackingStatusExplain_ready_${suffix}`
        ),
        `aucune clé d'explication par mode ne doit exister (${lang}/${suffix})`
      );
    }
  }
});

// ---------------------------------------------------------------
// 9. Typage : la surface publique n'accepte que des statuts canoniques.
// ---------------------------------------------------------------
test("9. resolveStatusText traverse tous les statuts canoniques sans exception", () => {
  for (const status of CANONICAL_ORDER_STATUSES) {
    const typed: OrderStatus = status;
    assert.doesNotThrow(() => resolveStatusText(typed, {}, (k) => translate("en", k)));
  }
});
