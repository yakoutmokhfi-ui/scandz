import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// ====================================================================
// LOT 2B.4a.1 -- invariants structurels PERMANENTS du hook
// usePublicFieldRequirements lui-même (lib/use-public-field-requirements.ts) :
//   1. aucun fallback vers le chemin legacy
//      (settings.requiredCustomerFields / restaurants-config.ts) ;
//   2. documentation du statut de fondation et du correctif L2B4A1-01.
//
// Retiré ici (LOT 2B.4a.2) -- documentation, pas un simple oubli :
// ce fichier contenait à l'origine 3 tests supplémentaires prouvant
// que "le formulaire actif (FulfillmentSelector.tsx, MenuView.tsx)
// N'A PAS basculé" (LOT 2B.4a.1, scope volontairement limité aux
// fondations) et 1 test excluant précisément ces 3 fichiers d'un
// diff "interdit sauf blocage" -- exactement le périmètre que LOT
// 2B.4a.2 est explicitement mandaté à changer (bascule runtime
// réelle du formulaire actif, CIO GO). Ces 4 tests décrivaient un
// état TRANSITOIRE du dépôt (celui produit par LOT 2B.4a.1), jamais
// une propriété durable de l'architecture -- les conserver aurait
// fait échouer la suite en permanence dès la bascule autorisée,
// exactement le même écueil déjà rencontré et documenté ci-dessous
// pour la preuve positive de versionnage (`git diff` contre une
// baseline devenue propre après merge). Les invariants RÉELLEMENT
// permanents de LOT 2B.4a.1 (le hook lui-même, ses 4 tests
// ci-dessous, plus la preuve de versionnage) restent inchangés. Les
// nouveaux invariants structurels de LOT 2B.4a.2 (bascule
// effectivement réalisée, fichiers hors périmètre toujours absents
// du diff) sont couverts par tests/v91-lot2b4a2-structural.test.ts.
// ====================================================================

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\/.*$/gm, "");
}

const hookSrc = readFileSync("lib/use-public-field-requirements.ts", "utf8");
const hookCodeOnly = stripComments(hookSrc);

test("LOT 2B.4a.1: usePublicFieldRequirements n'importe ni RestaurantSettings ni restaurants-config.ts dans le code réel", () => {
  assert.ok(!hookCodeOnly.includes("RestaurantSettings"));
  assert.ok(!hookCodeOnly.includes("restaurants-config"));
});

test("LOT 2B.4a.1: usePublicFieldRequirements ne référence jamais settings.requiredCustomerFields (aucun fallback legacy)", () => {
  assert.ok(!hookCodeOnly.includes("requiredCustomerFields"));
});

test("LOT 2B.4a.1: usePublicFieldRequirements n'appelle jamais supabase.rpc/supabase.from directement -- passe exclusivement par getPublicFieldRequirements()", () => {
  assert.ok(!hookCodeOnly.includes("supabase.rpc"));
  assert.ok(!hookCodeOnly.includes("supabase.from"));
  assert.ok(hookCodeOnly.includes('import { getPublicFieldRequirements } from "@/lib/sale-modes-public"'));
});

test("LOT 2B.4a.1: statut de fondation documenté explicitement dans le code (GENERIC CUSTOMER REQUIREMENTS FOUNDATION READY — ACTIVE FORM STILL LEGACY)", () => {
  // Le marqueur est réparti sur 2 lignes de commentaire dans la
  // source (habillage à ~72 caractères, patron déjà en vigueur dans
  // ce fichier) -- comparaison sur une version où la décoration de
  // commentaire ("\n * ") et les espaces sont normalisés, jamais sur
  // une simple sous-chaîne contiguë supposée à tort.
  const normalized = hookSrc.replace(/\*/g, " ").replace(/\s+/g, " ");
  assert.ok(normalized.includes("GENERIC CUSTOMER REQUIREMENTS FOUNDATION READY — ACTIVE FORM STILL LEGACY"));
});

test("L2B4A1-01 (audit Work, HIGH): la correction fail-closed est documentée dans le code, et la réinitialisation de clé se fait PENDANT le rendu, jamais dans useEffect", () => {
  assert.ok(hookSrc.includes("Corrige L2B4A1-01"), "le correctif doit être documenté explicitement dans le code");

  // Preuve structurelle complémentaire de la preuve comportementale
  // (tests/v90-lot2b4a1-l2b4a1-01-fail-closed-key-change.dom.test.ts) :
  // le `if (stateKey !== key)` -- la réinitialisation pendant le rendu
  // -- doit apparaître AVANT le useEffect dans le code source, jamais
  // à l'intérieur de celui-ci (ce qui reproduirait exactement le bug).
  const keyCheckIndex = hookCodeOnly.indexOf("if (stateKey !== key)");
  const useEffectIndex = hookCodeOnly.indexOf("useEffect(() => {");
  assert.ok(keyCheckIndex > 0, "la comparaison de clé doit exister dans le code réel");
  assert.ok(useEffectIndex > 0, "useEffect doit toujours exister (résolution asynchrone réelle)");
  assert.ok(
    keyCheckIndex < useEffectIndex,
    "la réinitialisation de clé doit être positionnée AVANT useEffect dans le code -- une réinitialisation à l'intérieur de useEffect reproduirait L2B4A1-01"
  );
});

test("LOT 2B.4a.1: les fichiers attendus de ce lot sont bien versionnés (preuve positive, complémentaire de l'exclusion ci-dessus)", () => {
  // Historique : à l'origine (avant le merge de LOT 2B.4a.1 v2), cette
  // preuve positive comparait à `git diff --name-only HEAD` +
  // `git status --porcelain` -- valide UNIQUEMENT pendant le
  // développement du lot, contre sa propre baseline non committée.
  // Une fois le lot mergé (LOT 2B.4a.2, baseline 70d6991), l'arbre de
  // travail est propre par construction : `git diff HEAD` est
  // TOUJOURS vide, donc cette assertion échouait à tort en
  // permanence -- constaté au tout début de LOT 2B.4a.2, avant toute
  // modification fonctionnelle, en rejouant la suite complète sur la
  // nouvelle baseline (section 15 de la mission 2B.4a.2). Corrigé ici
  // pour rester vrai QUELLE QUE SOIT l'ancienneté du lot : `git
  // ls-files` prouve que ces fichiers sont bien versionnés dans le
  // dépôt (donc réellement livrés), invariant durable après un merge
  // -- contrairement à `git diff`, qui ne l'est pas.
  const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

  const expectedTouched = [
    "lib/use-public-field-requirements.ts",
    "lib/sale-modes-public.ts",
    "lib/sale-modes-types.ts",
    "tests/v90-lot2b4a1-l2b4a1-01-fail-closed-key-change.dom.test.ts",
  ];
  for (const f of expectedTouched) {
    assert.ok(trackedFiles.includes(f), `${f} devrait être versionné (livré) par ce lot`);
  }
});
