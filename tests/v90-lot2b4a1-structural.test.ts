import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// ====================================================================
// LOT 2B.4a.1 -- invariants structurels :
//   1. le nouveau hook ne contient AUCUN fallback vers le chemin
//      legacy (settings.requiredCustomerFields / restaurants-config.ts) ;
//   2. le formulaire actif (FulfillmentSelector.tsx, MenuView.tsx)
//      N'A PAS basculé dans ce lot -- toujours settings.requiredCustomerFields,
//      n'importe pas le nouveau hook ;
//   3. aucun fichier interdit (section 13 de la mission) n'apparaît
//      dans le diff réel de ce lot -- vérifié par git, jamais une
//      simple relecture du patch.
// ====================================================================

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\/.*$/gm, "");
}

const hookSrc = readFileSync("lib/use-public-field-requirements.ts", "utf8");
const hookCodeOnly = stripComments(hookSrc);
const menuViewSrc = readFileSync("components/MenuView.tsx", "utf8");
const fulfillmentSrc = readFileSync("components/FulfillmentSelector.tsx", "utf8");

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

test("LOT 2B.4a.1 (preuve que le formulaire actif n'a pas encore basculé): MenuView.tsx et FulfillmentSelector.tsx n'importent PAS usePublicFieldRequirements", () => {
  assert.ok(!menuViewSrc.includes("use-public-field-requirements"));
  assert.ok(!fulfillmentSrc.includes("use-public-field-requirements"));
});

test("LOT 2B.4a.1 (preuve que le formulaire actif n'a pas encore basculé): MenuView.tsx lit toujours settings.requiredCustomerFields comme source des champs requis", () => {
  const codeOnly = stripComments(menuViewSrc);
  assert.ok(codeOnly.includes("settings.requiredCustomerFields"));
});

test("LOT 2B.4a.1 (preuve que le formulaire actif n'a pas encore basculé): FulfillmentSelector.tsx accepte toujours requiredFields: (keyof CustomerInfo)[] -- signature inchangée, pas de SaleModeFieldRequirement", () => {
  assert.ok(fulfillmentSrc.includes("requiredFields: (keyof CustomerInfo)[]"));
  assert.ok(!fulfillmentSrc.includes("SaleModeFieldRequirement"));
});

test("LOT 2B.4a.1: aucun fichier interdit (section 13) n'apparaît dans le diff réel de ce lot -- vérifié via git, pas une relecture manuelle du patch", () => {
  const FORBIDDEN_UNLESS_BLOCKING = [
    "components/FulfillmentSelector.tsx",
    "components/MenuView.tsx",
    "components/CartPanel.tsx",
    "lib/restaurants-config.ts",
  ];

  const trackedChanges = execFileSync("git", ["diff", "--name-only", "HEAD"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const untrackedFiles = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));

  const allChangedFiles = [...trackedChanges, ...untrackedFiles];

  for (const forbidden of FORBIDDEN_UNLESS_BLOCKING) {
    assert.ok(
      !allChangedFiles.includes(forbidden),
      `${forbidden} apparaît dans le diff -- interdit sauf blocage démontré et documenté (section 13 de la mission)`
    );
  }

  // Aucun fichier SQL/migration/RPC touché dans ce lot (section 15 :
  // aucun SQL attendu dans 2B.4a.1).
  const sqlChanges = allChangedFiles.filter((f) => f.startsWith("supabase/"));
  assert.deepEqual(sqlChanges, [], "aucun fichier supabase/ ne doit apparaître dans le diff -- LOT 2B.4a.1 n'implique aucun changement SQL/RPC");
});

test("LOT 2B.4a.1: les fichiers attendus de ce lot apparaissent bien dans le diff (preuve positive, complémentaire de l'exclusion ci-dessus)", () => {
  const trackedChanges = execFileSync("git", ["diff", "--name-only", "HEAD"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const untrackedFiles = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
  const allChangedFiles = [...trackedChanges, ...untrackedFiles];

  const expectedTouched = [
    "lib/use-public-field-requirements.ts",
    "lib/sale-modes-public.ts",
    "lib/sale-modes-types.ts",
    "tests/v90-lot2b4a1-l2b4a1-01-fail-closed-key-change.dom.test.ts",
  ];
  for (const f of expectedTouched) {
    assert.ok(allChangedFiles.includes(f), `${f} devrait apparaître dans le diff de ce lot`);
  }

  // lib/customer.ts audité (section 8) mais volontairement NON modifié
  // dans ce lot -- aucun besoin fonctionnel identifié (voir rapport).
  assert.ok(!allChangedFiles.includes("lib/customer.ts"), "lib/customer.ts n'a pas été modifié -- décision documentée dans le rapport");
});
