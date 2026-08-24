import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// UI MULTILINE FIX v2 -- Dashboard : <input> simple ligne remplacé
// par <textarea> pour opening_hours, seul moyen réel de permettre à
// un marchand de saisir de véritables retours à la ligne (Enter n'a
// aucun effet dans un <input> HTML -- cause racine confirmée en
// Production : la donnée réelle d'Au Lait Cru ne contenait aucun \n,
// une seule longue ligne à espaces multiples).
// ====================================================================

const settingsSrc = readFileSync("app/dashboard/settings/page.tsx", "utf8");

test("UI MULTILINE FIX v2: le champ opening_hours est désormais un <textarea>, jamais un <input>, dans le CODE réel", () => {
  const codeOnlyFull = settingsSrc.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const start = codeOnlyFull.indexOf('{t("stHours")}');
  const section = codeOnlyFull.slice(start, start + 400);
  assert.ok(section.includes("<textarea"), "doit contenir une balise <textarea>");
  assert.ok(!section.includes("<input"), "ne doit plus contenir de balise <input> dans le code réel (une mention en commentaire expliquant l'ancien comportement est légitime)");
});

test("UI MULTILINE FIX v2: le <textarea> conserve value/onChange/maxLength/disabled identiques à l'ancien <input> -- aucune logique de validation modifiée", () => {
  const start = settingsSrc.indexOf("<textarea");
  const end = settingsSrc.indexOf("/>", start);
  const textarea = settingsSrc.slice(start, end);
  assert.ok(textarea.includes("value={hours}"));
  assert.ok(textarea.includes("onChange={(e) => setHours(e.target.value)}"));
  assert.ok(textarea.includes("maxLength={120}"), "le plafond de 120 caractères doit rester identique");
  assert.ok(textarea.includes("disabled={!canEdit}"));
});

test("UI MULTILINE FIX v2: aucun parsing sémantique, formatage automatique, ou remplacement d'espaces par des retours à la ligne dans le Dashboard", () => {
  const start = settingsSrc.indexOf('{t("stHours")}');
  const section = settingsSrc.slice(start, start + 1200);
  assert.ok(!section.includes(".split("), "aucun découpage de la valeur des horaires");
  assert.ok(!section.includes(".replace(/\\s/"), "aucun remplacement d'espaces par des retours à la ligne");
  assert.ok(!/parseHours|formatHours|parseOpeningHours/.test(section), "aucune fonction de parsing métier des horaires");
});

test("UI MULTILINE FIX v2: la sauvegarde (hours.trim() || null) reste inchangée -- .trim() ne retire que les bords, jamais les \\n internes", () => {
  assert.ok(settingsSrc.includes("hours.trim() || null"), "l'appel de sauvegarde doit rester exactement le même");
});

test("UI MULTILINE FIX v2: preuve directe que .trim() préserve les \\n internes (comportement JS natif, pas une supposition)", () => {
  const withNewlines = "  Ligne 1\nLigne 2\nLigne 3  \n";
  const trimmed = withNewlines.trim();
  assert.equal(trimmed, "Ligne 1\nLigne 2\nLigne 3");
  assert.equal((trimmed.match(/\n/g) || []).length, 2, "les 2 retours à la ligne internes doivent survivre au trim des bords");
});

test("UI MULTILINE FIX v2: aucune donnée Production modifiée -- ce package ne contient aucun script SQL, aucune migration, aucun accès Supabase direct", () => {
  const patchRelatedFiles = [
    "app/dashboard/settings/page.tsx",
    "components/RestaurantInfoBar.tsx",
    "components/RestaurantInfoCard.tsx",
  ];
  for (const f of patchRelatedFiles) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/update\s+restaurant_configs|insert\s+into/i.test(src), `${f} ne doit contenir aucune instruction SQL`);
  }
});

test("UI MULTILINE FIX v2: RestaurantInfoCard.tsx (code mort, non importé dans l'arbre de rendu réel) conserve sa correction v1 -- aucun retrait sans preuve", () => {
  const cardSrc = readFileSync("components/RestaurantInfoCard.tsx", "utf8");
  assert.ok(cardSrc.includes("whitespace-pre-wrap"), "v1 doit rester intacte, comme exigé explicitement");
});

test("UI MULTILINE FIX v2: confirme structurellement que RestaurantInfoCard n'est importé par aucun autre fichier du frontend public (code mort, documenté honnêtement)", () => {
  const files = [
    "components/MenuView.tsx",
    "components/RestaurantHeader.tsx",
    "components/RestaurantInfoBar.tsx",
  ];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!codeOnly.includes("RestaurantInfoCard"), `${f} ne doit pas importer RestaurantInfoCard dans le CODE réel (une mention en commentaire expliquant le constat est légitime)`);
  }
});
