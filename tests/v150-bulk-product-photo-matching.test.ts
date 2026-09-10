import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMatchKey,
  stripFileExtension,
  buildNameIndex,
  matchFilesByName,
  applyValidationResult,
  applyManualMatch,
  resolveConflicts,
  getReadyToApply,
  countByState,
  hasExistingImageAtTarget,
  type BulkPhotoMatchProduct,
} from "../lib/services/bulk-product-photo-matching.ts";

// ====================================================================
// BULK PRODUCT PHOTOS v1 -- module d'appariement (pur, sans I/O).
// Aucun appel réseau/Supabase dans ce fichier : toutes les fonctions
// testées sont synchrones et déterministes.
// ====================================================================

function product(
  id: string,
  name: string,
  category = "Fromages",
  archived = false
): BulkPhotoMatchProduct {
  return {
    product_id: id,
    name,
    category_name: category,
    archived_at: archived ? "2026-01-01T00:00:00Z" : null,
    image_url: null,
  };
}

// --- normalizeMatchKey / stripFileExtension --------------------------

test("normalizeMatchKey : casse, espaces, tirets/underscores, accents", () => {
  assert.equal(normalizeMatchKey("Camembert Fermier"), "camembert fermier");
  assert.equal(normalizeMatchKey("  Camembert   Fermier  "), "camembert fermier");
  assert.equal(normalizeMatchKey("Camembert_Fermier"), "camembert fermier");
  assert.equal(normalizeMatchKey("Camembert-Fermier"), "camembert fermier");
  assert.equal(normalizeMatchKey("CAMEMBERT_FERMIER"), "camembert fermier");
  assert.equal(normalizeMatchKey("Crème brûlée"), "crème brûlée");
});

test("normalizeMatchKey : n'est PAS une correspondance floue -- deux clés différentes ne sont jamais rapprochées", () => {
  // Une faute de frappe change la clé normalisée -- aucune tolérance,
  // aucune notion de distance/similarité.
  assert.notEqual(normalizeMatchKey("Camembert"), normalizeMatchKey("Camenbert"));
  assert.notEqual(normalizeMatchKey("Fromage"), normalizeMatchKey("Fromages"));
});

test("stripFileExtension", () => {
  assert.equal(stripFileExtension("camembert.jpg"), "camembert");
  assert.equal(stripFileExtension("camembert.fermier.png"), "camembert.fermier");
  assert.equal(stripFileExtension("noextension"), "noextension");
  assert.equal(stripFileExtension(".hidden"), ".hidden");
});

// --- buildNameIndex ---------------------------------------------------

test("buildNameIndex : exclut les produits archivés", () => {
  const products = [
    product("p1", "Camembert"),
    product("p2", "Brie", "Fromages", true),
  ];
  const index = buildNameIndex(products);
  assert.deepEqual(index.get("camembert"), ["p1"]);
  assert.equal(index.get("brie"), undefined);
});

test("buildNameIndex : regroupe les produits qui partagent la même clé normalisée", () => {
  const products = [
    product("p1", "Camembert", "Fromages"),
    product("p2", "Camembert", "Plateaux"),
  ];
  const index = buildNameIndex(products);
  assert.deepEqual(index.get("camembert"), ["p1", "p2"]);
});

// --- matchFilesByName : happy path (déterministe, plusieurs produits) -

test("HAPPY PATH -- plusieurs photos, appariement déterministe, plusieurs produits", () => {
  const products = [
    product("p1", "Camembert"),
    product("p2", "Brie"),
    product("p3", "Reblochon"),
  ];
  const files = [
    { name: "Camembert.jpg", size: 1000 },
    { name: "brie.png", size: 2000 },
    { name: "REBLOCHON.webp", size: 3000 },
  ];
  const candidates = matchFilesByName(files, products);
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0].state, "matched");
  assert.equal(candidates[0].resolvedProductId, "p1");
  assert.equal(candidates[1].state, "matched");
  assert.equal(candidates[1].resolvedProductId, "p2");
  assert.equal(candidates[2].state, "matched");
  assert.equal(candidates[2].resolvedProductId, "p3");

  const ready = getReadyToApply(candidates, products);
  assert.equal(ready.length, 3);
});

// --- MATCHING : unknown reference -------------------------------------

test("MATCHING -- unknown reference : fichier sans produit correspondant -> unmatched, jamais appliqué", () => {
  const products = [product("p1", "Camembert")];
  const files = [{ name: "produit-inconnu.jpg", size: 1000 }];
  const candidates = matchFilesByName(files, products);
  assert.equal(candidates[0].state, "unmatched");
  assert.equal(candidates[0].resolvedProductId, null);
  assert.equal(getReadyToApply(candidates, products).length, 0);
});

// --- MATCHING : duplicate reference / ambiguous match ------------------

test("MATCHING -- ambiguous match : deux produits partagent le même nom normalisé -> aucune écriture automatique", () => {
  const products = [
    product("p1", "Camembert", "Fromages"),
    product("p2", "Camembert", "Plateaux"),
  ];
  const files = [{ name: "camembert.jpg", size: 1000 }];
  const candidates = matchFilesByName(files, products);
  assert.equal(candidates[0].state, "ambiguous");
  assert.equal(candidates[0].resolvedProductId, null);
  assert.deepEqual(candidates[0].ambiguousProductIds.sort(), ["p1", "p2"]);
  assert.equal(getReadyToApply(candidates, products).length, 0);
});

test("MATCHING -- ambiguous résolu manuellement -> devient matched, prêt à appliquer", () => {
  const products = [
    product("p1", "Camembert", "Fromages"),
    product("p2", "Camembert", "Plateaux"),
  ];
  const files = [{ name: "camembert.jpg", size: 1000 }];
  let candidates = matchFilesByName(files, products);
  candidates = applyManualMatch(candidates, "f0", "p2");
  candidates = resolveConflicts(candidates);
  assert.equal(candidates[0].state, "matched");
  assert.equal(candidates[0].resolvedProductId, "p2");
  assert.deepEqual(getReadyToApply(candidates, products), [{ fileKey: "f0", productId: "p2" }]);
});

// --- MATCHING : same product twice (duplicate files) --> conflict ------

test("MATCHING -- same product twice : deux fichiers distincts ciblent le même produit -> conflict explicite, aucune application", () => {
  const products = [product("p1", "Camembert")];
  const files = [
    { name: "camembert.jpg", size: 1000 },
    { name: "camembert-v2.jpg", size: 1500 },
  ];
  // Le deuxième fichier ne matche pas automatiquement (nom différent) --
  // on force manuellement la même cible pour simuler l'opérateur qui
  // choisit deux fichiers pour le même produit.
  let candidates = matchFilesByName(files, products);
  assert.equal(candidates[0].state, "matched");
  assert.equal(candidates[1].state, "unmatched");
  candidates = applyManualMatch(candidates, "f1", "p1");
  candidates = resolveConflicts(candidates);
  assert.equal(candidates[0].state, "conflict");
  assert.equal(candidates[1].state, "conflict");
  // Aucun des deux fichiers en conflit n'est prêt à être appliqué --
  // "one file must not silently update multiple products" et
  // réciproquement un produit ne reçoit jamais deux photos sans
  // arbitrage explicite.
  assert.equal(getReadyToApply(candidates, products).length, 0);
});

test("MATCHING -- conflit résolu en excluant l'un des deux fichiers -> l'autre redevient matched", () => {
  const products = [product("p1", "Camembert")];
  const files = [
    { name: "camembert.jpg", size: 1000 },
    { name: "camembert-v2.jpg", size: 1500 },
  ];
  let candidates = matchFilesByName(files, products);
  candidates = applyManualMatch(candidates, "f1", "p1");
  candidates = resolveConflicts(candidates);
  assert.equal(candidates[0].state, "conflict");

  // L'utilisateur exclut le deuxième fichier (résout le conflit).
  candidates = applyManualMatch(candidates, "f1", null);
  candidates = resolveConflicts(candidates);
  assert.equal(candidates[0].state, "matched");
  assert.equal(candidates[1].state, "unmatched");
  assert.deepEqual(getReadyToApply(candidates, products), [{ fileKey: "f0", productId: "p1" }]);
});

// --- VALIDATION ---------------------------------------------------------

test("VALIDATION -- invalid file type : reste exclu même avec une correspondance unique", () => {
  const products = [product("p1", "Camembert")];
  const files = [{ name: "camembert.jpg", size: 1000 }];
  let candidates = matchFilesByName(files, products);
  assert.equal(candidates[0].state, "matched");
  candidates = applyValidationResult(candidates, "f0", "invalid_type");
  assert.equal(candidates[0].state, "invalid");
  assert.equal(candidates[0].validationError, "invalid_type");
  assert.equal(getReadyToApply(candidates, products).length, 0);
});

test("VALIDATION -- oversized file : reste exclu même avec une correspondance unique", () => {
  const products = [product("p1", "Camembert")];
  const files = [{ name: "camembert.jpg", size: 999999999 }];
  let candidates = matchFilesByName(files, products);
  candidates = applyValidationResult(candidates, "f0", "too_large");
  assert.equal(candidates[0].state, "invalid");
  assert.equal(candidates[0].validationError, "too_large");
  assert.equal(getReadyToApply(candidates, products).length, 0);
});

test("VALIDATION -- fichier invalide ne peut jamais être réhabilité par un choix manuel", () => {
  const products = [product("p1", "Camembert"), product("p2", "Brie")];
  const files = [{ name: "camembert.jpg", size: 1000 }];
  let candidates = matchFilesByName(files, products);
  candidates = applyValidationResult(candidates, "f0", "invalid_type");
  candidates = applyManualMatch(candidates, "f0", "p2");
  // resolvedProductId peut être mis à jour (pour l'affichage), mais
  // l'état reste "invalid" -- jamais "matched" -- et getReadyToApply
  // continue de l'exclure.
  assert.equal(candidates[0].state, "invalid");
  assert.equal(getReadyToApply(candidates, products).length, 0);
});

test("VALIDATION -- empty selection : aucune entrée, aucun compte, rien à appliquer", () => {
  const products = [product("p1", "Camembert")];
  const candidates = matchFilesByName([], products);
  assert.equal(candidates.length, 0);
  assert.deepEqual(countByState(candidates), {
    total: 0,
    matched: 0,
    unmatched: 0,
    ambiguous: 0,
    conflict: 0,
    invalid: 0,
  });
  assert.equal(getReadyToApply(candidates, products).length, 0);
});

// --- countByState ---------------------------------------------------

test("countByState : dénombrement exact par état, utilisé par l'UI pour le résumé", () => {
  const products = [
    product("p1", "Camembert"),
    product("p2", "Brie"),
    product("p3", "Brie", "Plateaux"), // duplicate name -> ambiguous with p2
  ];
  const files = [
    { name: "camembert.jpg", size: 1000 }, // matched -> p1
    { name: "brie.jpg", size: 1000 }, // ambiguous -> p2/p3
    { name: "inconnu.jpg", size: 1000 }, // unmatched
  ];
  const candidates = matchFilesByName(files, products);
  const counts = countByState(candidates);
  assert.equal(counts.total, 3);
  assert.equal(counts.matched, 1);
  assert.equal(counts.ambiguous, 1);
  assert.equal(counts.unmatched, 1);
  assert.equal(counts.conflict, 0);
  assert.equal(counts.invalid, 0);
});

// --- one file must not silently update multiple products ---------------

test("SECURITE STRUCTURELLE -- un candidat ne référence jamais plus d'un product_id résolu à la fois", () => {
  const products = [product("p1", "Camembert"), product("p2", "Brie")];
  const files = [{ name: "camembert.jpg", size: 1000 }];
  const candidates = matchFilesByName(files, products);
  // resolvedProductId est un unique string|null par construction du
  // type -- aucune structure de données de ce module ne permet à un
  // seul fichier de cibler plusieurs produits simultanément.
  assert.equal(typeof candidates[0].resolvedProductId === "string" || candidates[0].resolvedProductId === null, true);
});

test("MATCHING -- getReadyToApply ne renvoie jamais un product_id hors du catalogue fourni", () => {
  const products = [product("p1", "Camembert"), product("p2", "Brie")];
  const files = [
    { name: "camembert.jpg", size: 1000 },
    { name: "brie.jpg", size: 1000 },
  ];
  const candidates = matchFilesByName(files, products);
  const ready = getReadyToApply(candidates, products);
  const knownIds = new Set(products.map((p) => p.product_id));
  for (const r of ready) {
    assert.ok(knownIds.has(r.productId), `product_id ${r.productId} absent du catalogue fourni`);
  }
});

// ====================================================================
// BULK PRODUCT PHOTOS v2.2 -- FINAL SIMPLIFICATION (décision CIO qui
// ANNULE ET REMPLACE le modèle "drapeau global" v2.1, lui-même
// remplaçant du modèle "skip par défaut + override par ligne" v2.0).
// CONFIRMER LE LOT BULK LUI-MÊME autorise le remplacement de TOUT
// produit correctement apparié -- il n'existe PLUS aucun paramètre de
// remplacement, ni global ni par ligne. `getReadyToApply` redevient
// une garde PURE à 2 paramètres : matched + cible résolue + pas
// d'erreur de validation -> prêt, qu'il y ait ou non déjà une photo.
// ====================================================================

function productWithPhoto(
  id: string,
  name: string,
  category = "Fromages"
): BulkPhotoMatchProduct {
  return {
    product_id: id,
    name,
    category_name: category,
    archived_at: null,
    image_url: `https://cdn.example/${id}.jpg`,
  };
}

test("v2.2 -- matched, produit SANS photo existante -> prêt à appliquer", () => {
  const products = [product("p1", "Camembert")]; // image_url: null
  const candidates = matchFilesByName([{ name: "camembert.jpg", size: 1000 }], products);
  assert.equal(candidates[0].state, "matched");
  assert.deepEqual(getReadyToApply(candidates, products), [{ fileKey: "f0", productId: "p1" }]);
});

test("v2.2 -- matched, produit AVEC photo existante -> AUSSI prêt à appliquer (INCHANGÉ, plus aucune exclusion)", () => {
  const products = [productWithPhoto("p1", "Camembert")];
  const candidates = matchFilesByName([{ name: "camembert.jpg", size: 1000 }], products);
  assert.equal(candidates[0].state, "matched"); // l'appariement lui-même est inchangé
  assert.equal(hasExistingImageAtTarget(candidates[0], products), true);
  // v2.1 aurait exclu cette ligne par défaut -- v2.2 l'inclut TOUJOURS :
  // confirmer le lot vaut déjà autorisation de remplacement.
  assert.deepEqual(getReadyToApply(candidates, products), [{ fileKey: "f0", productId: "p1" }]);
});

test("v2.2 -- getReadyToApply n'a plus de 3e paramètre : les deux arguments (candidates, products) suffisent, aucune signature à 3 arguments n'existe plus", () => {
  const products = [productWithPhoto("p1", "Camembert")];
  const candidates = matchFilesByName([{ name: "camembert.jpg", size: 1000 }], products);
  // getReadyToApply.length est l'arité DÉCLARÉE de la fonction (nombre
  // de paramètres sans valeur par défaut) -- preuve structurelle,
  // jamais seulement comportementale, qu'aucun drapeau n'existe plus.
  assert.equal(getReadyToApply.length, 2);
  assert.deepEqual(getReadyToApply(candidates, products), [{ fileKey: "f0", productId: "p1" }]);
});

test("v2.2 -- lot mixte : TOUTES les lignes matched sont prêtes ensemble, avec ou sans photo existante, sans distinction", () => {
  const products = [
    product("p1", "Camembert"), // sans photo
    productWithPhoto("p2", "Brie"), // avec photo
    productWithPhoto("p3", "Reblochon"), // avec photo
  ];
  const files = [
    { name: "camembert.jpg", size: 1000 },
    { name: "brie.jpg", size: 1000 },
    { name: "reblochon.jpg", size: 1000 },
  ];
  const candidates = matchFilesByName(files, products);
  const ready = getReadyToApply(candidates, products);
  assert.deepEqual(ready.map((r) => r.productId).sort(), ["p1", "p2", "p3"]);
});

test("v2.2 -- réassignation manuelle vers une nouvelle cible avec photo existante -> reste prête, aucun état par-ligne à gérer", () => {
  const products = [productWithPhoto("p1", "Camembert"), productWithPhoto("p2", "Brie")];
  let candidates = matchFilesByName([{ name: "camembert.jpg", size: 1000 }], products);
  assert.deepEqual(getReadyToApply(candidates, products), [{ fileKey: "f0", productId: "p1" }]);

  candidates = applyManualMatch(candidates, "f0", "p2");
  candidates = resolveConflicts(candidates);
  assert.equal(candidates[0].resolvedProductId, "p2");
  assert.deepEqual(getReadyToApply(candidates, products), [{ fileKey: "f0", productId: "p2" }]);
});

test("v2.2 -- hasExistingImageAtTarget : CONSERVÉE (indicateur passif uniquement), false si aucune cible résolue (ambiguous/unmatched)", () => {
  const products = [
    productWithPhoto("p1", "Camembert"),
    productWithPhoto("p2", "Camembert", "Plateaux"),
  ];
  const candidates = matchFilesByName([{ name: "camembert.jpg", size: 1000 }], products);
  assert.equal(candidates[0].state, "ambiguous");
  assert.equal(candidates[0].resolvedProductId, null);
  assert.equal(hasExistingImageAtTarget(candidates[0], products), false);
  // Un candidat ambigu reste exclu -- hasExistingImageAtTarget n'a
  // jamais gouverné cette exclusion, ni en v2.1 ni en v2.2 : c'est
  // l'état "ambiguous" lui-même qui exclut, indépendamment de la photo.
  assert.deepEqual(getReadyToApply(candidates, products), []);
});

test("v2.2 -- unmatched/ambiguous/conflict/invalid restent TOUJOURS exclus, qu'ils aient ou non une photo existante à la cible", () => {
  const products = [
    product("p1", "Camembert"), // sans photo
    productWithPhoto("p2", "Brie"), // avec photo
    productWithPhoto("p3", "Brie", "Plateaux"), // duplicate name with p2 -> ambiguous
  ];
  const files = [
    { name: "camembert.jpg", size: 1000 }, // matched, sans photo
    { name: "brie.jpg", size: 1000 }, // ambiguous (p2/p3)
    { name: "inconnu.jpg", size: 1000 }, // unmatched
  ];
  let candidates = matchFilesByName(files, products);
  assert.equal(candidates[0].state, "matched");
  assert.equal(candidates[1].state, "ambiguous"); // comportement v1 préservé
  assert.equal(candidates[2].state, "unmatched"); // comportement v1 préservé

  // conflict : forcer f2 (unmatched) vers le même produit p2 que f1
  // une fois résolu -- comportement de conflit v1 préservé à l'identique.
  candidates = applyManualMatch(candidates, "f1", "p2");
  candidates = applyManualMatch(candidates, "f2", "p2");
  candidates = resolveConflicts(candidates);
  assert.equal(candidates[1].state, "conflict");
  assert.equal(candidates[2].state, "conflict");
  assert.equal(
    getReadyToApply(candidates, products).some((r) => r.fileKey === "f1" || r.fileKey === "f2"),
    false
  ); // jamais inclus, même si p2 a déjà une photo existante

  // invalid : un fichier invalide reste "invalid" quel que soit l'état
  // de sa cible -- priorité inchangée.
  candidates = applyValidationResult(candidates, "f0", "invalid_type");
  assert.equal(
    getReadyToApply(candidates, products).some((r) => r.fileKey === "f0"),
    false
  );
});
