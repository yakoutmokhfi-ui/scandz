import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterEstablishments,
  deriveCatalogueStatus,
  deriveLegalTaxStatus,
  derivePhotosStatus,
  deriveReadyToPublishStatus,
  deriveMerchantStatus,
  summarizeCatalogue,
  SECTION_KEYS,
  type OperatorEstablishmentListItem,
} from "../lib/operator-cockpit.ts";

// ====================================================================
// OB-1 — OPERATOR COCKPIT FOUNDATION.
// Logique pure (lib/operator-cockpit.ts) : aucune dépendance Supabase,
// import direct sans variable d'environnement (même convention que
// lib/establishment-text.ts).
// ====================================================================

const SAMPLE: OperatorEstablishmentListItem[] = [
  { restaurantId: "r1", name: "Au Lait Cru", slug: "au-lait-cru", country: "FR", status: "active" },
  { restaurantId: "r2", name: "Sanaa Cookies", slug: "sanaa-cookies", country: "DZ", status: "onboarding" },
  { restaurantId: "r3", name: "Café Léa", slug: "cafe-lea", country: "FR", status: "suspended" },
];

test("SECTION_KEYS: exactement les 9 sections mandatées, dans l'ordre du mandat", () => {
  assert.deepEqual(SECTION_KEYS, [
    "merchant",
    "legalTax",
    "catalogue",
    "photos",
    "payment",
    "delivery",
    "qrDomain",
    "healthChecks",
    "readyToPublish",
  ]);
});

test("filterEstablishments: sans filtre, renvoie la liste complète inchangée", () => {
  assert.deepEqual(filterEstablishments(SAMPLE, {}), SAMPLE);
});

test("filterEstablishments: query filtre par nom, insensible à la casse", () => {
  const result = filterEstablishments(SAMPLE, { query: "lait" });
  assert.equal(result.length, 1);
  assert.equal(result[0].restaurantId, "r1");
});

test("filterEstablishments: query filtre aussi par slug", () => {
  const result = filterEstablishments(SAMPLE, { query: "sanaa-cook" });
  assert.equal(result.length, 1);
  assert.equal(result[0].restaurantId, "r2");
});

test("filterEstablishments: country exige une correspondance exacte (pas une sous-chaîne)", () => {
  const result = filterEstablishments(SAMPLE, { country: "FR" });
  assert.deepEqual(result.map((r) => r.restaurantId).sort(), ["r1", "r3"]);
});

test("filterEstablishments: status filtre exactement", () => {
  const result = filterEstablishments(SAMPLE, { status: "onboarding" });
  assert.equal(result.length, 1);
  assert.equal(result[0].restaurantId, "r2");
});

test("filterEstablishments: combinaison query + country + status, déterministe", () => {
  const result = filterEstablishments(SAMPLE, { query: "caf", country: "fr", status: "suspended" });
  assert.equal(result.length, 1);
  assert.equal(result[0].restaurantId, "r3");
});

test("filterEstablishments: aucune correspondance -> tableau vide, jamais une exception", () => {
  assert.deepEqual(filterEstablishments(SAMPLE, { query: "inexistant-xyz" }), []);
});

test("deriveLegalTaxStatus: null (aucune ligne receipt_settings) -> incomplete, jamais ready", () => {
  assert.equal(deriveLegalTaxStatus(null), "incomplete");
});

test("deriveLegalTaxStatus: raison sociale ET adresse légale présentes -> ready", () => {
  assert.equal(
    deriveLegalTaxStatus({ legal_name: "SARL Test", legal_address: "1 rue Test, Paris" }),
    "ready"
  );
});

test("deriveLegalTaxStatus: un seul des deux champs -> incomplete", () => {
  assert.equal(deriveLegalTaxStatus({ legal_name: "SARL Test", legal_address: null }), "incomplete");
  assert.equal(deriveLegalTaxStatus({ legal_name: null, legal_address: "1 rue Test" }), "incomplete");
});

test("deriveLegalTaxStatus: chaînes blanches traitées comme absentes", () => {
  assert.equal(deriveLegalTaxStatus({ legal_name: "   ", legal_address: "1 rue Test" }), "incomplete");
});

test("deriveReadyToPublishStatus: 'active' -> ready", () => {
  assert.equal(deriveReadyToPublishStatus("active"), "ready");
});

test("deriveReadyToPublishStatus: onboarding/suspended/inactive -> incomplete (jamais ready)", () => {
  for (const status of ["onboarding", "suspended", "inactive"]) {
    assert.equal(deriveReadyToPublishStatus(status), "incomplete");
  }
});

test("deriveMerchantStatus: résumé chargé -> ready, absent -> unavailable", () => {
  assert.equal(deriveMerchantStatus(true), "ready");
  assert.equal(deriveMerchantStatus(false), "unavailable");
});

// ====================================================================
// OB-1 v1.1 — summarizeCatalogue / deriveCatalogueStatus /
// derivePhotosStatus (CATALOGUE + PHOTOS après publication OB-2 v1.1).
// ====================================================================

function product(overrides: Partial<{ archived_at: string | null; image_url: string | null }> = {}) {
  return { archived_at: null, image_url: null, ...overrides };
}

test("summarizeCatalogue: catalogue vide -> tous les compteurs à zéro", () => {
  assert.deepEqual(summarizeCatalogue([]), { categoryCount: 0, productCount: 0, productsWithPhotoCount: 0 });
});

test("summarizeCatalogue: catégorie vide (LEFT JOIN, aucun produit) -> comptée dans categoryCount, aucun produit", () => {
  assert.deepEqual(summarizeCatalogue([{ products: [], subcategories: [] }]), {
    categoryCount: 1,
    productCount: 0,
    productsWithPhotoCount: 0,
  });
});

test("summarizeCatalogue: les produits archivés ne comptent JAMAIS, ni dans productCount ni dans productsWithPhotoCount", () => {
  const summary = summarizeCatalogue([
    {
      products: [
        product({ image_url: "https://x/a.jpg" }),
        product({ archived_at: "2025-01-01T00:00:00Z", image_url: "https://x/archived.jpg" }),
      ],
      subcategories: [],
    },
  ]);
  assert.deepEqual(summary, { categoryCount: 1, productCount: 1, productsWithPhotoCount: 1 });
});

test("summarizeCatalogue: agrège aussi les produits des sous-catégories (pas seulement products direct)", () => {
  const summary = summarizeCatalogue([
    {
      products: [product({ image_url: "https://x/a.jpg" })],
      subcategories: [
        { products: [product(), product({ image_url: "https://x/b.jpg" })] },
      ],
    },
  ]);
  assert.deepEqual(summary, { categoryCount: 1, productCount: 3, productsWithPhotoCount: 2 });
});

test("deriveCatalogueStatus: catégories et produits présents -> ready", () => {
  assert.equal(deriveCatalogueStatus({ categoryCount: 1, productCount: 2, productsWithPhotoCount: 1 }), "ready");
});

test("deriveCatalogueStatus: aucune catégorie -> incomplete, jamais ready (établissement tout juste onboardé)", () => {
  assert.equal(deriveCatalogueStatus({ categoryCount: 0, productCount: 0, productsWithPhotoCount: 0 }), "incomplete");
});

test("deriveCatalogueStatus: catégorie présente mais sans aucun produit actif -> incomplete", () => {
  assert.equal(deriveCatalogueStatus({ categoryCount: 1, productCount: 0, productsWithPhotoCount: 0 }), "incomplete");
});

test("deriveCatalogueStatus: ne renvoie jamais 'unavailable' -- réservé à un échec réel de lecture, géré par la page, pas par cette fonction pure", () => {
  for (const summary of [
    { categoryCount: 0, productCount: 0, productsWithPhotoCount: 0 },
    { categoryCount: 3, productCount: 10, productsWithPhotoCount: 10 },
  ]) {
    assert.notEqual(deriveCatalogueStatus(summary), "unavailable");
  }
});

test("derivePhotosStatus: tous les produits actifs ont une photo -> ready", () => {
  assert.equal(derivePhotosStatus({ categoryCount: 1, productCount: 2, productsWithPhotoCount: 2 }), "ready");
});

test("derivePhotosStatus: au moins un produit actif sans photo -> incomplete", () => {
  assert.equal(derivePhotosStatus({ categoryCount: 1, productCount: 2, productsWithPhotoCount: 1 }), "incomplete");
});

test("derivePhotosStatus: aucun produit actif -> incomplete (rien à évaluer, jamais ready par défaut)", () => {
  assert.equal(derivePhotosStatus({ categoryCount: 0, productCount: 0, productsWithPhotoCount: 0 }), "incomplete");
});
