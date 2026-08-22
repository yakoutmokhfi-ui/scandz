import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym LOT 1A.2 — corrections ciblées après contre-audit Work sur
// LOT 1A.1 (findings L1A1-01 et L1A1-02 uniquement). Les findings
// L1A-01 à L1A-04 sont déjà validés, non retouchés ici.
// ====================================================================

const packageJson = readFileSync("package.json", "utf8");
const domTestSrc = readFileSync("tests/v80-lot1a1-menuview-lang.dom.test.ts", "utf8");
const rollbackSql = readFileSync("supabase/migration-v80-rollback.sql", "utf8");
const lotdSql = readFileSync("supabase/migration-lotd-establishment-creation.sql", "utf8");
const harnessSrc = readFileSync("supabase/tests/v80-lot1a-check.sh", "utf8");

// --------------------------------------------------------------------
// L1A1-01 — cycle de vie du test DOM corrigé à la racine, pas contourné
// --------------------------------------------------------------------

test("L1A1-01: --test-force-exit est complètement retiré de package.json", () => {
  const testScript = JSON.parse(packageJson).scripts.test;
  assert.ok(!testScript.includes("--test-force-exit"), "aucun mécanisme de terminaison forcée ne doit subsister");
});

test("L1A1-01: aucun autre mécanisme équivalent de terminaison forcée n'a été introduit (process.exit forcé, timer artificiel, etc.)", () => {
  assert.ok(!domTestSrc.includes("process.exit("));
  // Les délais présents (setTimeout dans flush()/après esbuild.stop())
  // sont des attentes de résolution normale, jamais un minuteur destiné
  // à FORCER la fin du processus -- vérifié qu'aucun setTimeout de ce
  // fichier n'appelle process.exit ou n'existe dans ce seul but.
  assert.ok(!domTestSrc.includes("setTimeout(() => process"));
});

test("L1A1-01: la cause racine (polyfill RAF déconnecté de JSDOM) est corrigée -- requestAnimationFrame/cancelAnimationFrame réutilisent ceux de JSDOM (pretendToBeVisual), plus de setTimeout brut", () => {
  assert.ok(!domTestSrc.includes("setTimeout(() => cb(Date.now())"), "l'ancien polyfill maison ne doit plus exister");
  assert.ok(domTestSrc.includes("window.requestAnimationFrame.bind(window)"));
  assert.ok(domTestSrc.includes("window.cancelAnimationFrame.bind(window)"));
});

test("L1A1-01: window.close() est appelé une seule fois dans le CODE (hors commentaires), dans un hook after() -- pas répété par test, pas oublié", () => {
  const codeOnly = domTestSrc.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const closeOccurrences = (codeOnly.match(/window\.close\(\);/g) || []).length;
  assert.equal(closeOccurrences, 1, "window.close() doit être appelé exactement une fois dans le code réel (hors commentaires explicatifs), jamais par test individuel");
  const afterIdx = domTestSrc.indexOf("after(async () => {");
  const closeIdx = domTestSrc.indexOf("window.close();", afterIdx);
  assert.ok(afterIdx >= 0 && closeIdx > afterIdx, "window.close() doit se trouver À L'INTÉRIEUR du hook after()");
});

test("L1A1-01: esbuild.stop() est appelé -- le service persistant d'esbuild (sockets natifs) est explicitement fermé", () => {
  assert.ok(domTestSrc.includes("await esbuild.stop();"));
});

test("L1A1-01: les globals modifiés (window, document, navigator, HTMLElement, Event, RAF) sont explicitement restaurés après les tests", () => {
  const afterIdx = domTestSrc.indexOf("after(async () => {");
  const afterBody = domTestSrc.slice(afterIdx);
  for (const g of ["window", "document", "navigator", "HTMLElement", "Event", "requestAnimationFrame", "cancelAnimationFrame"]) {
    assert.ok(afterBody.includes(`delete (globalThis as any).${g}`), `${g} doit être restauré (delete) dans after()`);
  }
});

test("L1A1-01: chaque root React est démontée (unmount) ET son conteneur retiré du DOM après chaque test -- aucune fuite par test individuel", () => {
  const unmountCount = (domTestSrc.match(/root\.unmount\(\);/g) || []).length;
  const removeCount = (domTestSrc.match(/container\.remove\(\);/g) || []).length;
  const testCount = (domTestSrc.match(/^test\(/gm) || []).length;
  assert.equal(unmountCount, testCount, "un root.unmount() par test");
  assert.equal(removeCount, testCount, "un container.remove() par test");
});

// --------------------------------------------------------------------
// L1A1-02 — rollback restaure l'ABSENCE de commentaire (état V79 exact)
// --------------------------------------------------------------------

test("L1A1-02: V79/Lot D ne définit AUCUN commentaire sur source_language ni enabled_languages (confirmé par inspection directe)", () => {
  assert.ok(!lotdSql.includes("comment on column public.restaurant_configs.source_language"));
  assert.ok(!lotdSql.includes("comment on column public.restaurant_configs.enabled_languages"));
});

test("L1A1-02: le rollback restaure explicitement ces 2 commentaires à NULL, jamais un texte de remplacement", () => {
  assert.ok(rollbackSql.includes("comment on column public.restaurant_configs.source_language is null;"));
  assert.ok(rollbackSql.includes("comment on column public.restaurant_configs.enabled_languages is null;"));
});

test("L1A1-02: aucun COMMENTAIRE résiduel (comment on column ... is '...') ne référence restaurant_active_languages après la restauration des commentaires -- le DROP TABLE de cette même table reste légitime et attendu, distinct d'une référence en commentaire", () => {
  const nullCommentIdx = rollbackSql.indexOf("comment on column public.restaurant_configs.source_language is null;");
  const afterNullComments = rollbackSql.slice(nullCommentIdx);
  const staleCommentPattern = /comment on column[^;]*restaurant_active_languages[^;]*;/;
  assert.ok(!staleCommentPattern.test(afterNullComments), "aucune instruction COMMENT ON ne doit référencer restaurant_active_languages après ce point");
});

test("L1A1-02: le harnais vérifie empiriquement (PostgreSQL réel) que les commentaires sont bien NULL après rollback, pas seulement le texte SQL", () => {
  assert.ok(harnessSrc.includes("commentaire sur source_language réellement NULL après rollback"));
  assert.ok(harnessSrc.includes("commentaire sur enabled_languages réellement NULL après rollback"));
  assert.ok(harnessSrc.includes("col_description("));
});

// --------------------------------------------------------------------
// Portée stricte -- L1A-01 à L1A-04 non retouchés
// --------------------------------------------------------------------

test("Portée LOT 1A.2: les corrections L1A-01 à L1A-04 déjà validées ne sont pas modifiées (préflight rollback, initialisation langue, RTL catalogue, réordonnancement toujours présents)", () => {
  assert.ok(rollbackSql.includes("SCANYM_ROLLBACK_BLOCKED"));
  assert.ok(rollbackSql.includes("ral.language_code not in ('fr', 'en', 'ar')"));
  const menuViewSrc = readFileSync("components/MenuView.tsx", "utf8");
  assert.ok(menuViewSrc.includes("restaurant.activeLanguages"));
  const i18nSrc = readFileSync("lib/i18n.ts", "utf8");
  assert.ok(i18nSrc.includes("languages.find((l) => l.code === lang)?.dir"));
  const settingsSrc = readFileSync("app/dashboard/settings/page.tsx", "utf8");
  assert.ok(settingsSrc.includes("moveLanguageInList"));
});
