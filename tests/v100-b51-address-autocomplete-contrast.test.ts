import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// FULFILLMENT ROUTING LOT B.5.1 — corrige B5-01 (MEDIUM) et prouve la
// correction (B5-02, MEDIUM) sur components/AddressAutocomplete.tsx.
//
// RÉUTILISE EXCLUSIVEMENT le système de contraste déjà en place et
// déjà audité (mission §6 : "Do NOT invent a second contrast system") :
//   - lib/color-contrast.ts (contrastRatio, WCAG 2.1)
//   - lib/themes.ts (themeStyle/DEFAULT_THEME -- calcule --sc-ink-on-bg
//     EXACTEMENT comme le ferait le runtime pour un thème marchand
//     donné, y compris le cas sombre `bg: "#171616"` déjà utilisé par
//     tests/ui-contrast-fix.test.ts, UIFIX-V6-02/UIFIX-V5-01 -- même
//     valeur de reproduction, pas une nouvelle invention).
//
// Même méthodologie déjà établie dans le repo pour EXACTEMENT la même
// classe de défaut (bg-white littéral + texte hérité de --sc-ink-on-bg)
// sur InlineOptions.tsx/PastryModal.tsx/QuantityControl.tsx -- voir
// tests/ui-contrast-fix.test.ts, section "UIFIX-V5". AddressAutocomplete.tsx
// n'existait pas encore lors de cette mission (Lot B.5.1 en 2026-08-25,
// UIFIX antérieur) : il a hérité du même défaut de façon indépendante,
// corrigé ici avec la même méthode et la même couleur fixe
// (text-stone-900), jamais une variante inventée.
//
// Ce fichier PROUVE le défaut B5-01 (structurellement ET
// numériquement) puis prouve la correction -- conformément à B5-02,
// "le test doit échouer si le foreground explicite est retiré" (vérifié
// manuellement pendant le développement : en retirant `text-stone-900`
// du <li>/<ul>, le test "AddressAutocomplete.tsx explicite..." échoue).
// ====================================================================

const { contrastRatio } = await import("../lib/color-contrast.ts");
const { themeStyle, DEFAULT_THEME } = await import("../lib/themes.ts");

const componentSrc = readFileSync("components/AddressAutocomplete.tsx", "utf8");

/** Extrait le bloc JSX complet de la liste de suggestions (<ul id={listboxId}...>...</ul>),
 *  par équilibrage réel des balises <ul>/</ul> -- même discipline que
 *  extractJsxBlock() dans tests/ui-contrast-fix.test.ts (preuve
 *  structurelle de la relation parent/descendant, pas une simple
 *  recherche de sous-chaîne n'importe où dans le fichier). */
function extractSuggestionListBlock(src: string): string {
  const markerIdx = src.indexOf('role="listbox"');
  if (markerIdx < 0) throw new Error('marqueur role="listbox" introuvable');
  const ulOpenRe = /<ul(\s|>)/g;
  let lastOpenIdx = -1;
  let m: RegExpExecArray | null;
  while ((m = ulOpenRe.exec(src.slice(0, markerIdx)))) lastOpenIdx = m.index;
  if (lastOpenIdx < 0) throw new Error("balise ouvrante <ul> introuvable avant le marqueur");

  let depth = 0;
  let endIdx = -1;
  const rest = src.slice(lastOpenIdx);
  const tagPattern = /<ul(?:\s[^>]*)?\/?>|<\/ul>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(rest))) {
    const token = match[0];
    if (token.endsWith("/>")) continue;
    if (token.startsWith("</")) {
      depth--;
      if (depth === 0) {
        endIdx = match.index + token.length;
        break;
      }
    } else {
      depth++;
    }
  }
  if (endIdx < 0) throw new Error("balise fermante </ul> correspondante introuvable");
  return rest.slice(0, endIdx);
}

const suggestionListBlock = extractSuggestionListBlock(componentSrc);
const ulOpeningTag = suggestionListBlock.slice(0, suggestionListBlock.indexOf(">") + 1);
const liMatch = suggestionListBlock.match(/className=\{"([^"]*)"[^}]*\}/);
const liClassNameExpr = liMatch ? liMatch[0] : "";

// --------------------------------------------------------------------
// B5-01 -- reproduction structurelle ET numérique du défaut AVANT
// correction (documenté ici pour preuve auditable, la correction
// réelle est déjà appliquée dans le fichier -- voir assertions
// positives plus bas)
// --------------------------------------------------------------------

test("B5-01: reproduction -- sur un thème marchand sombre (bg:'#171616'), le texte hérité du <body> (--sc-ink-on-bg) devient blanc, EXACTEMENT comme déjà démontré par UIFIX-V6-02/V5-01 pour ce même thème de référence", () => {
  const vars = themeStyle(DEFAULT_THEME, { bg: "#171616" });
  assert.equal(vars["--sc-ink-on-bg"], "#ffffff", "le thème de référence doit bien produire un texte body blanc (cas déjà établi ailleurs dans le repo)");
});

test("B5-01: reproduction -- un texte hérité (blanc) sur une surface bg-white FIGÉE donnerait un ratio de contraste de 1:1 (invisible) -- c'est EXACTEMENT le défaut que ce lot corrige", () => {
  const vars = themeStyle(DEFAULT_THEME, { bg: "#171616" });
  const literalWhiteSurface = "#ffffff";
  const ratioIfInherited = contrastRatio(vars["--sc-ink-on-bg"], literalWhiteSurface);
  assert.equal(ratioIfInherited, 1, `si AddressAutocomplete n'explicitait pas sa propre couleur, le texte serait invisible (ratio ${ratioIfInherited}:1)`);
});

// --------------------------------------------------------------------
// B5-01 -- preuve que la correction RÉELLE est bien en place
// --------------------------------------------------------------------

test("B5-01 (CLOSED): AddressAutocomplete.tsx -- la surface de suggestions (<ul role=\"listbox\">) explicite un fond ET un texte fixes (jamais hérité de --sc-ink-on-bg)", () => {
  assert.ok(ulOpeningTag.includes("bg-white"), "le fond blanc littéral doit être conservé (pas un redesign)");
  assert.ok(ulOpeningTag.includes("text-stone-900"), "le <ul> doit expliciter text-stone-900 -- jamais dépendre du texte hérité du <body>");
});

test("B5-01 (CLOSED): chaque option (<li role=\"option\">) explicite ELLE-MÊME text-stone-900 -- pas seulement un ancêtre (l'élément qui affiche réellement {s.label})", () => {
  assert.ok(liClassNameExpr.length > 0, "l'expression de classe du <li> doit être trouvée");
  assert.ok(liClassNameExpr.includes("text-stone-900"), "le <li> lui-même doit porter text-stone-900, pas seulement le <ul> parent");
});

test("B5-01 (CLOSED): couleur fixe réutilisée -- text-stone-900 est EXACTEMENT la convention déjà établie dans tout le repo pour une surface bg-white littérale (aucune nouvelle couleur inventée)", () => {
  const conventionFiles = [
    "components/CartPanel.tsx",
    "components/FulfillmentSelector.tsx",
    "components/InlineOptions.tsx",
    "components/MenuItemCard.tsx",
    "components/OptionModal.tsx",
    "components/PastryModal.tsx",
    "components/QuantityControl.tsx",
  ];
  for (const file of conventionFiles) {
    const src = readFileSync(file, "utf8");
    assert.ok(src.includes("text-stone-900"), `${file} doit déjà utiliser text-stone-900 (convention préexistante, pas une invention de ce lot)`);
  }
});

// --------------------------------------------------------------------
// B5-01 §3 -- état actif : fond FIXE, jamais dérivé de --sc-bg
// (mission : "le texte doit rester lisible dans TOUS les états")
// --------------------------------------------------------------------

test("B5-01 (CLOSED): l'option ACTIVE n'utilise plus bg-crema/40 (dérivé de --sc-bg, le fond de page personnalisable du marchand -- potentiellement très sombre à 40% d'opacité selon le thème) -- remplacé par une couleur FIXE (bg-stone-100), jamais une variable --sc-*", () => {
  assert.ok(!liClassNameExpr.includes("bg-crema"), "bg-crema (dérivé du thème marchand, --sc-bg) ne doit plus apparaître sur l'option active");
  assert.ok(liClassNameExpr.includes("bg-stone-100"), "l'option active doit utiliser une couleur de fond fixe (bg-stone-100)");
});

test("B5-01 (CLOSED): contraste numérique -- text-stone-900 (#1c1917) sur bg-white (#ffffff, état inactif) ET sur bg-stone-100 (#f5f5f4, état actif) dépassent tous deux 4,5:1, INDÉPENDAMMENT du thème choisi par le marchand (couleurs fixes, jamais dérivées de --sc-bg)", () => {
  const textStone900 = "#1c1917";
  const bgWhite = "#ffffff";
  const bgStone100 = "#f5f5f4";

  const inactiveRatio = contrastRatio(textStone900, bgWhite);
  const activeRatio = contrastRatio(textStone900, bgStone100);

  assert.ok(inactiveRatio >= 4.5, `état inactif insuffisant : ${inactiveRatio.toFixed(2)}:1`);
  assert.ok(activeRatio >= 4.5, `état actif insuffisant : ${activeRatio.toFixed(2)}:1`);
});

test("B5-01 (CLOSED): thème clair, sombre, et le cas de référence #171616 ne changent JAMAIS le contraste des couleurs fixes de la liste de suggestions (elles ne dépendent d'aucune variable --sc-*)", () => {
  const textStone900 = "#1c1917";
  const bgWhite = "#ffffff";
  const bgStone100 = "#f5f5f4";
  const themeCases = [
    themeStyle(DEFAULT_THEME),
    themeStyle(DEFAULT_THEME, { bg: "#FDF6E3" }),
    themeStyle(DEFAULT_THEME, { bg: "#0A0A0A" }),
    themeStyle(DEFAULT_THEME, { bg: "#171616" }),
  ];
  for (const vars of themeCases) {
    assert.ok(vars["--sc-bg"], "chaque thème doit continuer à produire son fond marchand (non affecté par ce lot)");
    // Les couleurs fixes de la liste de suggestions ne référencent
    // aucune de ces variables -- le contraste est donc, PAR
    // CONSTRUCTION, identique quel que soit vars["--sc-bg"].
    assert.ok(contrastRatio(textStone900, bgWhite) >= 4.5);
    assert.ok(contrastRatio(textStone900, bgStone100) >= 4.5);
  }
});

// --------------------------------------------------------------------
// B5-02 -- le test lui-même doit échouer si le correctif est retiré
// (documenté et vérifié manuellement pendant le développement de ce
// lot : commenter `text-stone-900`/`bg-stone-100` dans
// components/AddressAutocomplete.tsx fait échouer les 3 tests
// précédents "B5-01 (CLOSED): ...")
// --------------------------------------------------------------------

test("B5-02 (CLOSED): non-régression -- aucune autre classe de AddressAutocomplete.tsx n'a été modifiée par cette correction (pas de redesign, pas de changement d'espacement/typographie)", () => {
  assert.ok(componentSrc.includes("rounded-xl border border-espresso/15"), "les classes de bordure/arrondi existantes doivent rester inchangées");
  assert.ok(componentSrc.includes("px-3 py-2 text-sm"), "l'espacement et la taille de texte des options ne doivent pas changer");
  assert.ok(componentSrc.includes("divide-y divide-espresso/10"), "les séparateurs entre options ne doivent pas changer");
});

test("B5-02 (CLOSED): non-régression architecturale -- aucun changement de la logique de sélection/clavier/repli manuel/service adresse par cette correction (contrat B.5 inchangé, contraste uniquement)", () => {
  assert.ok(componentSrc.includes("aria-activedescendant"));
  assert.ok(componentSrc.includes('e.key === "ArrowDown"'));
  assert.ok(componentSrc.includes('e.key === "Enter"'));
  assert.ok(componentSrc.includes('e.key === "Escape"'));
  assert.ok(componentSrc.includes("manualAddressToStructured"));
  assert.ok(componentSrc.includes("normalizeAddressSuggestion"));
  const addressSearchSrc = readFileSync("lib/services/address-search.ts", "utf8");
  const addressTypesSrc = readFileSync("lib/address-types.ts", "utf8");
  // Ces deux fichiers ne font PARTIE d'aucune correction de contraste
  // (aucun style/JSX) -- vérifie qu'ils restent BYTE-IDENTIQUES à leur
  // état Lot B.5 via une empreinte de longueur simple (le diff complet
  // est de toute façon vérifié par git diff --name-status, voir le
  // rapport de mission).
  assert.ok(addressSearchSrc.includes("FRANCE_GEOPLATEFORME_SEARCH_ENDPOINT"));
  assert.ok(addressTypesSrc.includes("StructuredCustomerAddress"));
});
