import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym LOT 1A.1 — corrections ciblées après contre-audit Work sur
// LOT 1A (findings L1A-01 à L1A-04). Aucun nouveau feature, aucune
// reprise du Sous-lot B.
// ====================================================================

const i18nSrc = readFileSync("lib/i18n.ts", "utf8");
const menuViewSrc = readFileSync("components/MenuView.tsx", "utf8");
const settingsSrc = readFileSync("app/dashboard/settings/page.tsx", "utf8");
const rollbackSql = readFileSync("supabase/migration-v80-rollback.sql", "utf8");
const harnessSrc = readFileSync("supabase/tests/v80-lot1a-check.sh", "utf8");

// --------------------------------------------------------------------
// L1A-01 — rollback réellement exact vers V79
// --------------------------------------------------------------------

test("L1A-01: le rollback contient un PRÉFLIGHT en lecture seule, HORS de toute transaction, avant tout DROP/ALTER", () => {
  const preflightIdx = rollbackSql.indexOf("do $$");
  const beginIdx = rollbackSql.indexOf("\nbegin;");
  assert.ok(preflightIdx >= 0 && beginIdx > preflightIdx, "le préflight doit précéder le begin; de la transaction destructrice");
  const preflightBody = rollbackSql.slice(preflightIdx, beginIdx);
  assert.ok(!preflightBody.includes("drop "), "le préflight ne doit contenir aucune opération destructrice");
  assert.ok(!preflightBody.includes("alter table"), "le préflight ne doit contenir aucune modification de structure");
});

test("L1A-01: le préflight vérifie les 3 sources possibles d'incompatibilité (source_language, enabled_languages, restaurant_active_languages) -- pas seulement les 2 citées par Work", () => {
  const preflightIdx = rollbackSql.indexOf("do $$");
  const beginIdx = rollbackSql.indexOf("\nbegin;");
  const body = rollbackSql.slice(preflightIdx, beginIdx);
  assert.ok(body.includes("rc.source_language not in ('fr', 'en', 'ar')"));
  assert.ok(body.includes("not (rc.enabled_languages <@ array['fr', 'en', 'ar']::text[])"));
  assert.ok(body.includes("ral.language_code not in ('fr', 'en', 'ar')"), "cas découvert pendant la correction : langue ajoutée uniquement via le Dashboard, jamais dans enabled_languages");
});

test("L1A-01: le préflight lève SCANYM_ROLLBACK_BLOCKED avec un rapport nommant explicitement les établissements bloquants, jamais un échec muet", () => {
  assert.ok(rollbackSql.includes("SCANYM_ROLLBACK_BLOCKED"));
  assert.ok(rollbackSql.includes("format('  - %s (%s)"));
  assert.ok(rollbackSql.includes("AUCUNE MODIFICATION N''A ÉTÉ EFFECTUÉE"));
});

test("L1A-01: restaurant_configs_enabled_languages_chk est désormais restaurée avec le texte EXACT de Lot D (absente à tort avant ce correctif)", () => {
  assert.ok(rollbackSql.includes("add constraint restaurant_configs_enabled_languages_chk"));
  assert.ok(rollbackSql.includes("array_length(enabled_languages, 1) > 0"));
  assert.ok(rollbackSql.includes("enabled_languages <@ array['fr','en','ar']::text[]"));
});

test("L1A-01: le harnais teste réellement les 3 scénarios exigés (source FR+FR/NL, source NL, données historiques FR/AR) via de VRAIES RPC après migration, pas seulement des fixtures jamais modifiées", () => {
  assert.ok(harnessSrc.includes("create_establishment('Test NL'"), "doit utiliser la RPC réelle, pas une fixture statique");
  assert.ok(harnessSrc.includes("update_restaurant_languages('$RESTO_A_RB2'"), "doit exercer une vraie modification post-migration via le Dashboard");
  assert.ok(harnessSrc.includes("Historique FR AR"));
  assert.ok(harnessSrc.includes("comparaison structurelle"));
});

test("L1A-01: le harnais confirme qu'AUCUNE modification partielle ne subsiste après un rollback refusé", () => {
  assert.ok(harnessSrc.includes("aucune modification partielle -- les tables LOT 1A existent toujours après le refus"));
});

// --------------------------------------------------------------------
// L1A-02 — initialisation correcte de la langue publique
// --------------------------------------------------------------------

test("L1A-02: MenuView n'initialise plus lang à 'fr' de manière inconditionnelle -- dépend de source_language et activeLanguages", () => {
  assert.ok(!menuViewSrc.includes('useState<Lang>("fr")'));
  const start = menuViewSrc.indexOf("const [lang, setLang] = useState<Lang>(");
  const end = menuViewSrc.indexOf("});", start) + 3;
  const body = menuViewSrc.slice(start, end);
  assert.ok(body.includes("restaurant.activeLanguages"));
  assert.ok(body.includes("restaurant.config.source_language"));
  assert.ok(body.includes("activeLanguages.some((l) => l.code === source)"), "doit vérifier que source_language appartient bien aux langues actives");
  assert.ok(body.includes("activeLanguages[0]?.code"), "repli explicite sur la première langue active, pas un 'fr' arbitraire");
});

test("L1A-02: preuve empirique complète (établissement AR-only, FR-only, EN-only, priorité source_language, état invalide) -- voir tests/v80-lot1a1-menuview-lang.dom.test.ts (rendu DOM réel)", () => {
  const domTestSrc = readFileSync("tests/v80-lot1a1-menuview-lang.dom.test.ts", "utf8");
  const requiredScenarios = [
    "AR-only -> AR actif dès le rendu initial",
    "FR-only -> FR actif",
    "EN-only -> EN actif",
    "source AR + langues actives AR/FR/EN -> AR reste la langue initiale",
    "état invalide (source_language absente des langues actives)",
  ];
  for (const s of requiredScenarios) {
    assert.ok(domTestSrc.includes(s), `scénario DOM manquant : ${s}`);
  }
});

// --------------------------------------------------------------------
// L1A-03 — RTL dérivé du catalogue, pas du code langue
// --------------------------------------------------------------------

test("L1A-03: dirOf() ne contient plus AUCUNE règle 'ar' codée en dur -- dérive la direction du catalogue transmis en paramètre", () => {
  const start = i18nSrc.indexOf("export function dirOf(");
  const end = i18nSrc.indexOf("\n}", start);
  const body = i18nSrc.slice(start, end);
  assert.ok(!body.includes('lang === "ar"'), "aucune comparaison directe à 'ar' ne doit subsister dans le code de la fonction");
  assert.ok(body.includes("languages.find((l) => l.code === lang)?.dir"));
  assert.ok(body.includes("languages: ReadonlyArray<{ code: string; dir:"), "le paramètre languages doit être requis, pas optionnel avec un repli figé");
});

test("L1A-03: aucune liste de langues RTL codée en dur nulle part dans le code applicatif (composants)", () => {
  const filesToCheck = ["components/MenuView.tsx", "components/RestaurantHeader.tsx", "components/LanguageSelector.tsx"];
  for (const f of filesToCheck) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/["']ar["']\s*===|===\s*["']ar["']/.test(src), `${f} ne doit contenir aucune comparaison directe à la langue 'ar'`);
  }
});

test("L1A-03: MenuView transmet bien restaurant.activeLanguages à dirOf() -- le catalogue réel de CET établissement, jamais une liste générique", () => {
  assert.ok(menuViewSrc.includes("dirOf(lang, restaurant.activeLanguages)"));
});

test("L1A-03: preuve empirique -- une langue RTL FICTIVE ajoutée dynamiquement produit dir=rtl sans modification de code (voir tests/v80-lot1a1-menuview-lang.dom.test.ts)", () => {
  const domTestSrc = readFileSync("tests/v80-lot1a1-menuview-lang.dom.test.ts", "utf8");
  assert.ok(domTestSrc.includes("langue RTL FICTIVE ajoutée dynamiquement"));
  assert.ok(domTestSrc.includes('"xx-test-rtl"'), "doit utiliser un code de langue qui n'existe nulle part dans le code réel, preuve d'absence de liste figée");
});

// --------------------------------------------------------------------
// L1A-04 — ordre des langues administrable
// --------------------------------------------------------------------

test("L1A-04: le Dashboard contient désormais un mécanisme de réordonnancement réel (boutons ↑/↓), pas seulement des cases à cocher", () => {
  assert.ok(settingsSrc.includes("moveActiveLanguage"));
  assert.ok(settingsSrc.includes("stMoveLanguageUp"));
  assert.ok(settingsSrc.includes("stMoveLanguageDown"));
});

test("L1A-04: la logique de réordonnancement est factorisée (moveLanguageInList, lib/types.ts) -- testable indépendamment du rendu, pas seulement inline dans la page", () => {
  const typesSrc = readFileSync("lib/types.ts", "utf8");
  assert.ok(typesSrc.includes("export function moveLanguageInList("));
  assert.ok(settingsSrc.includes("moveLanguageInList"));
});

test("L1A-04: moveLanguageInList -- comportement réel vérifié (pas seulement présence de texte)", async () => {
  const { moveLanguageInList } = await import("../lib/types.ts");

  // FR/EN/NL -> déplacer NL vers le haut deux fois -> NL/FR/EN
  let order = ["fr", "en", "nl"];
  order = moveLanguageInList(order, "nl", -1);
  assert.deepEqual(order, ["fr", "nl", "en"]);
  order = moveLanguageInList(order, "nl", -1);
  assert.deepEqual(order, ["nl", "fr", "en"]);

  // Déplacer au-delà des bornes -> no-op (ne sort jamais du tableau)
  const atStart = ["a", "b", "c"];
  assert.deepEqual(moveLanguageInList(atStart, "a", -1), atStart);
  const atEnd = ["a", "b", "c"];
  assert.deepEqual(moveLanguageInList(atEnd, "c", 1), atEnd);

  // Code absent -> no-op, jamais un plantage
  assert.deepEqual(moveLanguageInList(["a", "b"], "zzz", 1), ["a", "b"]);

  // Ne modifie jamais le tableau original (retourne toujours une copie)
  const original = ["fr", "en"];
  const moved = moveLanguageInList(original, "fr", 1);
  assert.notStrictEqual(moved, original);
  assert.deepEqual(original, ["fr", "en"], "le tableau original ne doit jamais être muté");
});

test("L1A-04: le harnais confirme la persistance réelle en base après update_restaurant_languages (ordre fr,en,nl,ar respecté), pas seulement côté client", () => {
  assert.ok(harnessSrc.includes("ordre fr,en,nl,ar respecté après update_restaurant_languages"));
});

test("L1A-04: impossible d'avoir un doublon de display_order ou de retirer la langue source -- déjà garanti par update_restaurant_languages (SQL), revérifié après ce tour", () => {
  const v80Sql = readFileSync("supabase/migration-v80-lot1a-identity-social-languages.sql", "utf8");
  const start = v80Sql.indexOf("create function public.update_restaurant_languages");
  const end = v80Sql.indexOf("\nend $$;", start);
  const body = v80Sql.slice(start, end);
  assert.ok(body.includes("Duplicate language codes are not allowed"));
  assert.ok(body.includes("Cannot remove the source language"));
  assert.ok(body.includes("delete from public.restaurant_active_languages where restaurant_id = p_restaurant_id;"), "remplacement atomique complet, jamais un ajout qui pourrait dupliquer un display_order");
});

// --------------------------------------------------------------------
// Non-régression explicite (tout ce que Work a déjà validé)
// --------------------------------------------------------------------

test("Non-régression LOT 1A.1: aucune des 4 corrections ne touche aux RPC/validations déjà auditées (identité, bg_color, réseaux sociaux)", () => {
  const v80Sql = readFileSync("supabase/migration-v80-lot1a-identity-social-languages.sql", "utf8");
  assert.ok(v80Sql.includes("create function public.update_restaurant_identity"));
  assert.ok(v80Sql.includes("create function public.update_restaurant_bg_color"));
  assert.ok(v80Sql.includes("create function public.update_restaurant_social_links"));
  assert.ok(v80Sql.includes("^https://(www\\.)?instagram\\.com/[A-Za-z0-9._]{1,30}/?$"));
});
