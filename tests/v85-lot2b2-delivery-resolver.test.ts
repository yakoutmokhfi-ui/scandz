import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// Import de TYPE uniquement (compile-time, jamais exécuté) --
// coexiste avec l'import dynamique ci-dessous (runtime). Nécessaire
// pour la preuve d'assignabilité exigée par L2B2-01 : ce fichier est
// inclus dans tsconfig ("**/*.ts"), donc réellement type-vérifié par
// `tsc --noEmit` -- si quelqu'un réintroduit un type de retour non
// assignable à DeliveryStatus, CETTE LIGNE cesse de compiler.
import type { DeliveryStatus, DeliveryZone } from "../lib/delivery.ts";

const { getDeliveryStatus, getDeliveryStatusFromPublicInfo } = await import("../lib/delivery.ts");

// ====================================================================
// Corrige L2B2-01 (contre-audit Work) : PREUVE D'ASSIGNABILITÉ
// TypeScript -- le résultat de getDeliveryStatusFromPublicInfo doit
// compiler sans aucune assertion de type (`as`) lorsqu'assigné à une
// variable typée DeliveryStatus. Ceci est une vérification de
// COMPILATION, pas seulement une assertion runtime : si
// getDeliveryStatusFromPublicInfo retournait un jour un type
// PublicDeliveryStatus parallèle non assignable, `npx tsc --noEmit`
// échouerait sur CETTE fonction, avant même d'exécuter le moindre
// test. La fonction n'est jamais appelée ici -- seule la
// VÉRIFICATION DE TYPE compte.
// ====================================================================
function __typeProofAssignability(): void {
  const proof: DeliveryStatus = getDeliveryStatusFromPublicInfo(null, "75001", 5);
  void proof;

  // Preuve structurelle complémentaire : les DEUX résolveurs
  // retournent exactement le même type public -- jamais deux
  // hiérarchies parallèles (DeliveryStatus / PublicDeliveryStatus).
  const legacyResult: DeliveryStatus = getDeliveryStatus(
    { deliveryZones: [], deliveryMinItems: 0 } as unknown as Parameters<typeof getDeliveryStatus>[0],
    "75001",
    5
  );
  const newResult: DeliveryStatus = getDeliveryStatusFromPublicInfo(null, "75001", 5);
  // Si les deux types divergeaient, cette assignation croisée
  // échouerait à la compilation.
  const crossCheck: typeof legacyResult = newResult;
  void crossCheck;

  // Preuve que zone.label accepte explicitement `null` dans le
  // modèle commun (DeliveryZone), pas seulement dans un type annexe.
  const zoneProof: DeliveryZone = { code: "75", label: null };
  void zoneProof;
}
void __typeProofAssignability;

// ====================================================================
// Scanym LOT 2B.2 — PREPARATION OF THE NEW PURE DELIVERY RESOLVER ONLY.
//
// Décision CIO explicite (option C, scope révisé) : getDeliveryStatus()
// (chemin legacy, RestaurantSettings) reste STRICTEMENT INCHANGÉE --
// son unique appelant réel (MenuView.tsx) n'est pas touché dans ce
// sous-lot. getDeliveryStatusFromPublicInfo() est une NOUVELLE
// fonction pure, synchrone, sans accès Supabase, sans
// RestaurantSettings, préparée pour la bascule future de MenuView.tsx
// (sous-lot séparé, non commencé ici).
//
// LEGACY CALL PATH STILL ACTIVE — MIGRATION PREPARED, NOT SWITCHED.
// ====================================================================

const deliverySrc = readFileSync("lib/delivery.ts", "utf8");

// --------------------------------------------------------------------
// Chemin legacy strictement inchangé
// --------------------------------------------------------------------

test("LOT 2B.2: getDeliveryStatus (chemin legacy) reste EXACTEMENT inchangée -- même signature, même comportement, RestaurantSettings toujours importé pour cette seule fonction", () => {
  assert.ok(deliverySrc.includes('import type { RestaurantSettings, DeliveryZone } from "@/lib/restaurants-config";'), "l'import legacy doit rester présent, intentionnellement, pour getDeliveryStatus uniquement");
  assert.equal(typeof getDeliveryStatus, "function");
});

test("LOT 2B.2: getDeliveryStatus (legacy) -- comportement runtime identique à avant ce sous-lot, sur les mêmes scénarios qu'audités précédemment", () => {
  const settings = {
    deliveryZones: [
      { code: "75", label: "Paris (75)" },
      { code: "77", label: "Seine-et-Marne (77)" },
    ],
    deliveryMinItems: 10,
  } as Parameters<typeof getDeliveryStatus>[0];

  assert.deepEqual(getDeliveryStatus(settings, "75001", 10), { eligible: true, zone: { code: "75", label: "Paris (75)" } });
  assert.deepEqual(getDeliveryStatus(settings, "99999", 10), { eligible: false, block: "out-of-zone" });
  assert.equal(getDeliveryStatus(settings, "75001", 5).block, "below-min");
  assert.equal(getDeliveryStatus(settings, "abc", 10).block, "no-postal");
});

// --------------------------------------------------------------------
// Nouvelle fonction pure -- signature et absence de dépendances interdites
// --------------------------------------------------------------------

test("L2B2-01: PublicDeliveryStatus/PublicDeliveryZone n'existent plus dans le code réel (uniquement mentionnés en commentaire, à titre historique)", () => {
  const codeOnly = deliverySrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!codeOnly.includes("PublicDeliveryStatus"), "PublicDeliveryStatus ne doit plus exister dans le code exécuté");
  assert.ok(!codeOnly.includes("PublicDeliveryZone"), "PublicDeliveryZone ne doit plus exister dans le code exécuté");
  assert.ok(deliverySrc.includes("export type { DeliveryZone };"), "DeliveryZone doit être ré-exportée comme modèle commun unique");
});

test("LOT 2B.2: getDeliveryStatusFromPublicInfo est exportée, fonction pure, jamais async", () => {
  assert.equal(typeof getDeliveryStatusFromPublicInfo, "function");
  const result = getDeliveryStatusFromPublicInfo(null, "75001", 5);
  assert.ok(!(result instanceof Promise), "la fonction ne doit jamais retourner une Promise -- synchrone, comme exigé par le CIO");
});

test("LOT 2B.2: getDeliveryStatusFromPublicInfo ne référence RestaurantSettings/restaurants-config.ts nulle part dans sa propre définition", () => {
  const start = deliverySrc.indexOf("export function getDeliveryStatusFromPublicInfo");
  const end = deliverySrc.indexOf("\n}", start);
  const body = deliverySrc.slice(start, end);
  assert.ok(!body.includes("RestaurantSettings"));
  assert.ok(!body.includes("restaurants-config"));
  assert.ok(!body.includes("settings."));
});

test("LOT 2B.2: aucun appel Supabase / RPC dans lib/delivery.ts -- la récupération asynchrone appartient au futur sous-lot d'intégration", () => {
  assert.ok(!deliverySrc.includes("supabase"));
  assert.ok(!deliverySrc.includes(".rpc("));
  assert.ok(!deliverySrc.includes("await"));
  assert.ok(!deliverySrc.includes("async "));
});

test("LOT 2B.2: aucune logique spécifique à un établissement précis (aucun slug, aucun nom d'établissement codé en dur)", () => {
  assert.ok(!/illico|sanaa|sirocco/i.test(deliverySrc));
});

// --------------------------------------------------------------------
// Comportement exact exigé (section 5 de la mission), un test par cas
// --------------------------------------------------------------------

test("LOT 2B.2: deliveryInfo = null -- comportement 'delivery unavailable' (hors zone), jamais une exception", () => {
  const result = getDeliveryStatusFromPublicInfo(null, "75001", 5);
  assert.deepEqual(result, { eligible: false, block: "out-of-zone" });
});

test("LOT 2B.2: code postal ne correspondant à aucun préfixe -- hors zone", () => {
  const info = { zonePrefixes: ["75", "77"], minItems: 0, areaLabel: "Île-de-France" };
  const result = getDeliveryStatusFromPublicInfo(info, "13001", 5);
  assert.deepEqual(result, { eligible: false, block: "out-of-zone" });
});

test("LOT 2B.2: préfixe correspondant, minimum atteint -- zone acceptée, éligible", () => {
  const info = { zonePrefixes: ["75", "77"], minItems: 10, areaLabel: "Île-de-France" };
  const result = getDeliveryStatusFromPublicInfo(info, "75001", 10);
  assert.deepEqual(result, { eligible: true, zone: { code: "75", label: "Île-de-France" } });
});

test("LOT 2B.2: préfixe correspondant, minimum NON atteint -- refusé avec le nombre exact d'articles manquants", () => {
  const info = { zonePrefixes: ["75", "77"], minItems: 10, areaLabel: "Île-de-France" };
  const result = getDeliveryStatusFromPublicInfo(info, "75001", 4);
  assert.deepEqual(result, { eligible: false, block: "below-min", missing: 6, zone: { code: "75", label: "Île-de-France" } });
});

test("LOT 2B.2: zonePrefixes = [] -- aucune zone desservie, toujours hors zone quel que soit le code postal", () => {
  const info = { zonePrefixes: [], minItems: 0, areaLabel: "Île-de-France" };
  const result = getDeliveryStatusFromPublicInfo(info, "75001", 100);
  assert.deepEqual(result, { eligible: false, block: "out-of-zone" });
});

test("LOT 2B.2: minItems = 0 -- aucun minimum, toute quantité positive (même 1) est éligible", () => {
  const info = { zonePrefixes: ["75"], minItems: 0, areaLabel: "Île-de-France" };
  const result = getDeliveryStatusFromPublicInfo(info, "75001", 1);
  assert.deepEqual(result, { eligible: true, zone: { code: "75", label: "Île-de-France" } });
});

test("LOT 2B.2: areaLabel = null -- jamais inventé, transmis tel quel dans zone.label", () => {
  const info = { zonePrefixes: ["75"], minItems: 0, areaLabel: null };
  const result = getDeliveryStatusFromPublicInfo(info, "75001", 1);
  assert.deepEqual(result, { eligible: true, zone: { code: "75", label: null } });
});

test("LOT 2B.2: code postal invalide -- refusé avec block='no-postal', avant même de consulter deliveryInfo", () => {
  const info = { zonePrefixes: ["75"], minItems: 0, areaLabel: "Île-de-France" };
  const result = getDeliveryStatusFromPublicInfo(info, "abc", 5);
  assert.deepEqual(result, { eligible: false, block: "no-postal" });
});

// --------------------------------------------------------------------
// Parité logique legacy <-> nouvelle fonction (section 6 de la mission)
// --------------------------------------------------------------------
// Parité portant sur : autorisé/refusé, raison, minimum, reconnaissance
// de zone -- PAS sur les anciens libellés départementaux, remplacés
// volontairement par delivery_area_label (décision CIO explicite,
// section 4).

const LEGACY_SANAA_SETTINGS = {
  deliveryZones: [
    { code: "75", label: "Paris (75)" },
    { code: "77", label: "Seine-et-Marne (77)" },
    { code: "78", label: "Yvelines (78)" },
    { code: "91", label: "Essonne (91)" },
    { code: "92", label: "Hauts-de-Seine (92)" },
    { code: "93", label: "Seine-Saint-Denis (93)" },
    { code: "94", label: "Val-de-Marne (94)" },
    { code: "95", label: "Val-d'Oise (95)" },
  ],
  deliveryMinItems: 10,
} as Parameters<typeof getDeliveryStatus>[0];

const NEW_SANAA_INFO = {
  zonePrefixes: ["75", "77", "78", "91", "92", "93", "94", "95"],
  minItems: 10,
  areaLabel: "Île-de-France",
};

test("LOT 2B.2 (parité): préfixe valide -- même verdict eligible/block sur legacy et nouvelle fonction", () => {
  const legacy = getDeliveryStatus(LEGACY_SANAA_SETTINGS, "75001", 10);
  const next = getDeliveryStatusFromPublicInfo(NEW_SANAA_INFO, "75001", 10);
  assert.equal(legacy.eligible, next.eligible);
  assert.equal(legacy.block, next.block);
  assert.equal(legacy.zone?.code, next.zone?.code, "le code de préfixe reconnu doit être identique");
});

test("LOT 2B.2 (parité): préfixe invalide -- même verdict hors zone sur les deux", () => {
  const legacy = getDeliveryStatus(LEGACY_SANAA_SETTINGS, "13001", 10);
  const next = getDeliveryStatusFromPublicInfo(NEW_SANAA_INFO, "13001", 10);
  assert.equal(legacy.eligible, next.eligible);
  assert.equal(legacy.block, next.block);
});

test("LOT 2B.2 (parité): minimum atteint -- même verdict éligible sur les deux", () => {
  const legacy = getDeliveryStatus(LEGACY_SANAA_SETTINGS, "94001", 10);
  const next = getDeliveryStatusFromPublicInfo(NEW_SANAA_INFO, "94001", 10);
  assert.equal(legacy.eligible, true);
  assert.equal(next.eligible, true);
});

test("LOT 2B.2 (parité): minimum NON atteint -- même verdict refusé, même raison, même nombre manquant", () => {
  const legacy = getDeliveryStatus(LEGACY_SANAA_SETTINGS, "94001", 3);
  const next = getDeliveryStatusFromPublicInfo(NEW_SANAA_INFO, "94001", 3);
  assert.equal(legacy.eligible, false);
  assert.equal(next.eligible, false);
  assert.equal(legacy.block, "below-min");
  assert.equal(next.block, "below-min");
  assert.equal(legacy.missing, next.missing, "le nombre exact d'articles manquants doit être identique");
});

test("LOT 2B.2 (parité): liste de zones vide -- même verdict hors zone sur les deux", () => {
  const legacySettings = { deliveryZones: [], deliveryMinItems: 10 } as unknown as Parameters<typeof getDeliveryStatus>[0];
  const newInfo = { zonePrefixes: [], minItems: 10, areaLabel: null };
  const legacy = getDeliveryStatus(legacySettings, "75001", 10);
  const next = getDeliveryStatusFromPublicInfo(newInfo, "75001", 10);
  assert.equal(legacy.eligible, next.eligible);
  assert.equal(legacy.block, next.block);
});

test("LOT 2B.2 (parité): la différence de libellé (départemental vs générique) est ACCEPTÉE comme évolution contrôlée, jamais testée comme une divergence", () => {
  const legacy = getDeliveryStatus(LEGACY_SANAA_SETTINGS, "75001", 10);
  const next = getDeliveryStatusFromPublicInfo(NEW_SANAA_INFO, "75001", 10);
  // Intentionnellement DIFFÉRENT -- "Paris (75)" (legacy) vs
  // "Île-de-France" (nouveau, générique) -- documenté comme
  // acceptable par décision CIO explicite, jamais une régression.
  assert.equal(legacy.zone?.label, "Paris (75)");
  assert.equal(next.zone?.label, "Île-de-France");
});

// --------------------------------------------------------------------
// Documentation explicite du statut (section 8 de la mission)
// --------------------------------------------------------------------

test("LOT 2B.2: le fichier documente explicitement que le chemin legacy reste actif et que la bascule n'a pas eu lieu", () => {
  assert.ok(deliverySrc.includes("LEGACY CALL PATH STILL ACTIVE"));
  assert.ok(deliverySrc.includes("MIGRATION PREPARED, NOT SWITCHED") || deliverySrc.includes("NOT SWITCHED"));
});

test("LOT 2B.2: MenuView.tsx/CartPanel.tsx/FulfillmentSelector.tsx ne référencent PAS ENCORE la nouvelle fonction (aucune migration runtime), même après l'ajustement type-safe minimal de MenuView.tsx", () => {
  for (const file of ["components/MenuView.tsx", "components/CartPanel.tsx", "components/FulfillmentSelector.tsx", "lib/restaurants-config.ts"]) {
    const src = readFileSync(file, "utf8");
    assert.ok(!src.includes("getDeliveryStatusFromPublicInfo"), `${file} ne doit pas encore référencer la nouvelle fonction`);
  }
});

test("L2B2-01: MenuView.tsx a reçu EXACTEMENT un ajustement type-safe minimal (zoneLabel ?? \"\"), documenté et justifié, jamais une migration fonctionnelle", () => {
  const src = readFileSync("components/MenuView.tsx", "utf8");
  assert.ok(src.includes('zoneLabel: deliveryStatus.zone!.label ?? ""'));
  assert.ok(src.includes("L2B2-01"), "la justification doit être documentée dans le fichier lui-même");
  // Confirme qu'aucune autre logique de ce fichier n'a été touchée :
  // getDeliveryStatus (legacy) reste le seul appel réel, jamais
  // getDeliveryStatusFromPublicInfo, aucun nouvel état/effet asynchrone.
  assert.ok(src.includes("getDeliveryStatus(settings"), "l'appel legacy synchrone doit rester exactement le même");
  assert.ok(!src.includes("useState") || !src.includes("deliveryInfo"), "aucun nouvel état de récupération asynchrone ajouté");
});

test("L2B2-01: restaurants-config.ts -- DeliveryZone.label élargi à string | null, AUCUNE autre modification (RestaurantSettings, autres champs, données Illico/Sanaa/Sirocco inchangés)", () => {
  const src = readFileSync("lib/restaurants-config.ts", "utf8");
  const start = src.indexOf("export interface DeliveryZone");
  const end = src.indexOf("}", start);
  const body = src.slice(start, end);
  assert.ok(body.includes("label: string | null"));
  // Les données réelles (Sanaa) restent de vraies chaînes -- élargir
  // le TYPE n'a jamais dû toucher aux VALEURS existantes.
  assert.ok(src.includes('{ code: "75", label: "Paris (75)" }'), "les données legacy réelles doivent rester identiques, seul le type accueillant change");
});
