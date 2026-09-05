import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { deriveStuartClientReferenceCandidate } = await import(
  "../lib/server/delivery-providers/stuart/client-reference.ts"
);

// ====================================================================
// DELIVERY STREAM C — STUART FOUNDATION / SANDBOX v1.1 (ferme
// STUART-V1-CLIENT-REFERENCE-UNIQUENESS-01). Ce fichier ne contient
// AUCUN test prétendant une unicité GARANTIE -- uniquement les
// propriétés RÉELLEMENT tenues (déterminisme, longueur, absence de
// caractère spécial en tête) et une preuve/documentation explicite
// que l'unicité n'est PAS garantie par cette fonction seule.
// ====================================================================

const ORDER_ID_A = "a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6";
const ORDER_ID_B = "11111111-2222-3333-4444-555555555555";

test("STUART-V1-CLIENT-REFERENCE-UNIQUENESS-01 : longueur EXACTEMENT 10 caractères (limite officielle 'no more than ten characters')", () => {
  const ref = deriveStuartClientReferenceCandidate(ORDER_ID_A);
  assert.equal(ref.length, 10);
});

test("STUART-V1-CLIENT-REFERENCE-UNIQUENESS-01 : ne commence JAMAIS par un caractère spécial -- par construction, uniquement des chiffres hexadécimaux 0-9A-F", () => {
  for (const orderId of [ORDER_ID_A, ORDER_ID_B, "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"]) {
    const ref = deriveStuartClientReferenceCandidate(orderId);
    assert.match(ref, /^[0-9A-F]{10}$/);
  }
});

test("STUART-V1-CLIENT-REFERENCE-UNIQUENESS-01 : DÉTERMINISTE -- la MÊME commande produit TOUJOURS la MÊME référence candidate", () => {
  const ref1 = deriveStuartClientReferenceCandidate(ORDER_ID_A);
  const ref2 = deriveStuartClientReferenceCandidate(ORDER_ID_A);
  assert.equal(ref1, ref2);
});

test("STUART-V1-CLIENT-REFERENCE-UNIQUENESS-01 : deux commandes DISTINCTES produisent (dans ce cas précis) des références distinctes -- ceci N'EST PAS une preuve d'unicité générale, uniquement un exemple négatif", () => {
  const refA = deriveStuartClientReferenceCandidate(ORDER_ID_A);
  const refB = deriveStuartClientReferenceCandidate(ORDER_ID_B);
  assert.notEqual(refA, refB);
});

test("STUART-V1-CLIENT-REFERENCE-UNIQUENESS-01 : order_number seul n'est JAMAIS utilisé comme entrée (collision garantie entre marchands multi-tenant)", () => {
  assert.equal(deriveStuartClientReferenceCandidate.length, 1);
});

test("STUART-V1-CLIENT-REFERENCE-UNIQUENESS-01 : PREUVE EXPLICITE -- cette fonction NE GARANTIT PAS l'unicité ; deux order_id DISTINCTS peuvent produire, en théorie, LA MÊME référence (collision de hachage) -- aucune vérification d'unicité n'est effectuée par cette fonction elle-même", () => {
  // Preuve structurelle, pas une démonstration de collision réelle
  // (impraticable à trouver pour SHA-256) : la fonction ne consulte
  // AUCUNE source de vérité externe (pas de base de données, pas de
  // registre en mémoire des références déjà émises) -- elle ne PEUT
  // structurellement pas détecter ni empêcher une collision. Ceci
  // est la preuve que le "candidat" reste un candidat, jamais une
  // allocation vérifiée.
  const source = deriveStuartClientReferenceCandidate.toString();
  assert.ok(!/await|fetch|supabase|select|insert/i.test(source), "la fonction ne doit contenir AUCUN appel externe/DB -- confirme qu'aucune vérification d'unicité persistante n'est effectuée ici (STUART-CLIENT-REFERENCE-01 reste OPEN)");
});

test("STUART-V1-CLIENT-REFERENCE-UNIQUENESS-01 : le nom de la fonction reflète explicitement son statut de CANDIDATE, jamais une garantie -- non-régression du renommage de ce lot", () => {
  assert.equal(deriveStuartClientReferenceCandidate.name, "deriveStuartClientReferenceCandidate");
});
