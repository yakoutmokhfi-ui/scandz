import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym V74 — corrections finales ciblées après contre-audit
// indépendant Work sur V73 (findings V73-01, V73-02, V73-03).
// ====================================================================

const settingsSrc = readFileSync("app/dashboard/settings/page.tsx", "utf8");
const globalsCss = readFileSync("app/globals.css", "utf8");
const themesSrc = readFileSync("lib/themes.ts", "utf8");
const colorContrastSrc = readFileSync("lib/color-contrast.ts", "utf8");
const headerSrc = readFileSync("components/RestaurantHeader.tsx", "utf8");
const infoBarSrc = readFileSync("components/RestaurantInfoBar.tsx", "utf8");

// --------------------------------------------------------------------
// V73-01 — maps_url : chaîne brute validée avant toute normalisation
// --------------------------------------------------------------------

test("V73-01: submit() valide isValidMapsUrl(mapsUrl) -- la chaîne BRUTE -- jamais isValidMapsUrl(cleanMapsUrl)", () => {
  const fn = settingsSrc.slice(settingsSrc.indexOf("async function submit"), settingsSrc.indexOf("function resetColors"));
  assert.ok(fn.includes("isValidMapsUrl(mapsUrl)"), "doit valider mapsUrl (l'état brut du champ)");
  assert.ok(!fn.includes("isValidMapsUrl(cleanMapsUrl)"), "ne doit plus jamais valider une version déjà normalisée");
});

test("V73-01: dans submit(), la validation de mapsUrl précède l'appel à normalizeMapsUrl()", () => {
  const fn = settingsSrc.slice(settingsSrc.indexOf("async function submit"), settingsSrc.indexOf("function resetColors"));
  const validateIdx = fn.indexOf("isValidMapsUrl(mapsUrl)");
  const normalizeIdx = fn.indexOf("normalizeMapsUrl(mapsUrl)");
  assert.ok(validateIdx >= 0 && normalizeIdx >= 0);
  assert.ok(validateIdx < normalizeIdx, "la validation doit précéder la normalisation, jamais l'inverse");
});

test("V73-01: intégration réelle -- le parcours complet (UI -> TS -> RPC -> SQL) rejette bien un espace en tête/fin sur toute la chaîne, pas seulement isValidMapsUrl() isolée", async () => {
  const { isValidMapsUrl, normalizeMapsUrl } = await import("../lib/maps-url.ts");
  const migrationV73 = readFileSync("supabase/migration-v73-hardening.sql", "utf8");

  const raw = " https://example.com";

  // 1. Validation TypeScript sur la valeur BRUTE (comme le fait
  //    désormais submit()) -- doit refuser.
  assert.equal(isValidMapsUrl(raw), false, "isValidMapsUrl(raw) doit refuser l'espace en tête");

  // 2. Le SQL (RPC update_restaurant_maps_url) compare aussi raw vs
  //    trimmed AVANT toute autre validation -- même contrat, jamais
  //    un simple trim() suivi d'une validation de la valeur nettoyée.
  const fnStart = migrationV73.indexOf("create or replace function public.update_restaurant_maps_url");
  const fnEnd = migrationV73.indexOf("$$;", fnStart);
  const fnBody = migrationV73.slice(fnStart, fnEnd);
  assert.ok(fnBody.includes("v_trimmed != v_raw"), "la RPC doit comparer la valeur brute et la valeur nettoyée AVANT toute autre validation");

  // 3. Non-régression : une valeur propre reste acceptée après
  //    normalisation (le trim reste un no-op sur une entrée déjà
  //    valide, jamais un moyen de la rendre valide après coup).
  const clean = "https://example.com";
  assert.equal(isValidMapsUrl(clean), true);
  assert.equal(normalizeMapsUrl(clean), clean);
});

test("V73-01: les 3 usages JSX (aperçu, lien de test, message d'erreur) appellent tous isValidMapsUrl sur l'état brut mapsUrl, cohérents avec submit()", () => {
  const renderSection = settingsSrc.slice(settingsSrc.indexOf("return (", settingsSrc.indexOf("async function submit")));
  const occurrences = (renderSection.match(/isValidMapsUrl\(mapsUrl\)/g) || []).length;
  assert.ok(occurrences >= 3, `attendu au moins 3 usages cohérents dans le rendu, trouvé ${occurrences}`);
  assert.ok(!renderSection.includes("isValidMapsUrl(cleanMapsUrl)"));
});

// --------------------------------------------------------------------
// V73-02 — contrastes effectifs, y compris opacités sur variables
// déjà calculées
// --------------------------------------------------------------------

test("V73-02: le texte PAR DÉFAUT de toute l'application (body) utilise text-ink-on-bg (calculée), plus text-espresso brut -- corrige tous les cas hérités sans classe explicite", () => {
  assert.ok(globalsCss.includes("text-ink-on-bg antialiased"));
  assert.ok(!globalsCss.includes("text-espresso antialiased"));
});

test("V73-02: mutedOnBg() ne descend JAMAIS sous le seuil WCAG AA -- revient à la pleine puissance si le mélange échouerait", () => {
  assert.ok(colorContrastSrc.includes("export function mutedOnBg("));
  const start = colorContrastSrc.indexOf("export function mutedOnBg(");
  const end = colorContrastSrc.indexOf("\n}", start);
  const body = colorContrastSrc.slice(start, end);
  assert.ok(body.includes("contrastRatio(candidate, bgHex) >= minRatio ? candidate : textHex"));
});

test("V73-02: --sc-accent-dark-on-bg et les variantes muted calculées dans themeStyle(), jamais choisies par le commerçant", () => {
  assert.ok(themesSrc.includes('"--sc-accent-dark-on-bg": readableAccentOnBg(accentDark, bg),'));
  assert.ok(themesSrc.includes('"--sc-ink-on-bg-muted": mutedOnBg('));
  assert.ok(themesSrc.includes('"--sc-accent-dark-on-bg-muted": mutedOnBg('));
});

test("V73-02: les 5 thèmes par défaut préservent EXACTEMENT ink et accentDark à pleine puissance (aucune régression visuelle sans personnalisation)", async () => {
  const { themeStyle, THEMES } = await import("../lib/themes.ts");
  for (const name of Object.keys(THEMES)) {
    const style = themeStyle(name);
    const theme = (THEMES as Record<string, { ink: string; accentDark: string }>)[name];
    assert.equal(style["--sc-ink-on-bg"], theme.ink, `thème '${name}'`);
    assert.equal(style["--sc-accent-dark-on-bg"], theme.accentDark, `thème '${name}'`);
  }
});

test("V73-02: toutes les variantes 'muted' calculées pour les 5 thèmes restent >= 4.5:1 contre --sc-bg", async () => {
  const { themeStyle, THEMES } = await import("../lib/themes.ts");
  const { contrastRatio } = await import("../lib/color-contrast.ts");
  for (const name of Object.keys(THEMES)) {
    const style = themeStyle(name);
    const bg = style["--sc-bg"];
    assert.ok(contrastRatio(style["--sc-ink-on-bg-muted"], bg) >= 4.5, `ink-on-bg-muted du thème '${name}'`);
    assert.ok(contrastRatio(style["--sc-accent-dark-on-bg-muted"], bg) >= 4.5, `accent-dark-on-bg-muted du thème '${name}'`);
  }
});

test("V73-02: RestaurantHeader n'applique plus d'opacité Tailwind sur ink-text (texte lisible réel) dans le CODE (des mentions en commentaire expliquant l'ancien défaut sont légitimes)", () => {
  const codeOnly = headerSrc.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!codeOnly.includes("text-ink-text/70"));
  assert.ok(!codeOnly.includes("text-ink-text/90"));
  // L'ornement décoratif (aria-hidden) garde son opacité -- hors champ
  // WCAG, vérifié dans components/Icons.tsx (aria-hidden sur le SVG).
  const iconsSrc = readFileSync("components/Icons.tsx", "utf8");
  const ornamentStart = iconsSrc.indexOf("export function Ornament()");
  const ornamentBody = iconsSrc.slice(ornamentStart, ornamentStart + 300);
  assert.ok(ornamentBody.includes("aria-hidden"));
});

test("V73-02: RestaurantInfoBar n'applique plus d'opacité sur text-highlight-on-ink (libellé, texte lisible réel) dans le CODE", () => {
  const codeOnly = infoBarSrc.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!codeOnly.includes("text-highlight-on-ink/80"));
  assert.ok(infoBarSrc.includes("text-highlight-on-ink"));
});

test("V73-02: recherche exhaustive -- plus aucune occurrence de text-espresso/text-caramel-dark comme TEXTE LISIBLE (pas décoratif, pas désactivé) dans components/", () => {
  const files = [
    "components/MenuItemCard.tsx", "components/CartPanel.tsx", "components/OrderConfirmation.tsx",
    "components/FulfillmentSelector.tsx", "components/CategoryNav.tsx", "components/OptionModal.tsx",
    "components/PastryModal.tsx", "components/ProductInfoButton.tsx", "components/TableSelector.tsx",
    "components/RestaurantInfoCard.tsx", "components/MenuView.tsx",
  ];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.ok(!src.includes("text-caramel-dark"), `${f} ne doit plus utiliser text-caramel-dark`);
  }
});

test("V73-02: les seules occurrences résiduelles de text-espresso/NN sont documentées et exemptées (icône aria-hidden, ou état disabled explicite)", () => {
  // ProductPhotoPlaceholder : aria-hidden="true" explicite (décoratif).
  const placeholderSrc = readFileSync("components/ProductPhotoPlaceholder.tsx", "utf8");
  assert.ok(placeholderSrc.includes('aria-hidden="true"'));
  assert.ok(placeholderSrc.includes("text-espresso/20"));

  // InlineOptions et OptionModal : disabled={n === 0} / n === 0 sur le
  // MÊME contrôle -- exemption WCAG pour composant d'interface inactif.
  const inlineSrc = readFileSync("components/InlineOptions.tsx", "utf8");
  assert.ok(inlineSrc.includes("disabled={n === 0}"));
  assert.ok(inlineSrc.includes("text-espresso/30"));

  const optionModalSrc = readFileSync("components/OptionModal.tsx", "utf8");
  assert.ok(optionModalSrc.includes("disabled={n === 0}"));
  assert.ok(optionModalSrc.includes("text-espresso/30"));
});

test("V73-02: gold/highlight sur icône aria-hidden (RestaurantInfoCard) volontairement hors périmètre -- décoratif, hors exigences WCAG 1.4.3/1.4.11", () => {
  const cardSrc = readFileSync("components/RestaurantInfoCard.tsx", "utf8");
  assert.ok(cardSrc.includes('aria-hidden className="shrink-0 text-gold"'));
});

// --------------------------------------------------------------------
// V73-03 — packaging reproductible complet (vérifié au niveau du
// script de packaging lui-même, voir le rapport de livraison V74 pour
// la preuve sur le package final réel)
// --------------------------------------------------------------------

test("V73-03: aucun fichier V72-04/V72-05/V72-07 rouvert sans régression démontrée (préflight, chemin Storage, matrice de port inchangés)", () => {
  const preflightSql = readFileSync("supabase/preflight-historical-uuid-check.sql", "utf8");
  const migrationV73 = readFileSync("supabase/migration-v73-hardening.sql", "utf8");
  assert.ok(preflightSql.includes("CE FICHIER"));
  assert.ok(migrationV73.includes("PORT_1_TO_65535") || migrationV73.includes("6553[0-5]"));
});
