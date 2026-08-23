import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { themeStyle, THEMES, DEFAULT_THEME } = await import("../lib/themes.ts");
const { contrastRatio } = await import("../lib/color-contrast.ts");
const { getFulfillmentToneClass } = await import("../lib/fulfillment-tone.ts");

// ====================================================================
// Scanym UI CONTRAST FIX — corrige UIFIX-01 : bg-white (fond littéral
// figé) associé à text-ink-on-bg/text-ink-on-bg-muted (calculé contre
// --sc-bg, le fond de page PERSONNALISABLE) dans 5 composants. Aucune
// nouvelle logique de contraste : réutilise exclusivement
// readableTextColor/readableAccentOnBg/mutedOnBg déjà en place et
// déjà auditées (V71 à V73). Package DISTINCT de LOT 2B.1 -- aucune
// migration, aucun RPC, aucun changement Dashboard hors les
// descriptions de couleur.
// ====================================================================

const FIXED_FILES = [
  "components/CategoryNav.tsx",
  "components/TableSelector.tsx",
  "components/OptionModal.tsx",
  "components/CartPanel.tsx",
  "components/FulfillmentSelector.tsx",
  "components/MenuItemCard.tsx",
  "components/OrderConfirmation.tsx",
  "components/ProductInfoButton.tsx",
  "components/RestaurantInfoCard.tsx",
];

/** Fichiers dont les surfaces blanches héritaient encore de la couleur
 *  du body. UIFIX v5 leur donne une couleur fixe sûre sur blanc. */
const INHERITED_COLOR_FIXED_FILES = [
  "components/InlineOptions.tsx",
  "components/PastryModal.tsx",
  "components/QuantityControl.tsx",
];

/**
 * Extrait le bloc JSX complet d'un élément, depuis la ligne contenant
 * `openingMarker` (typiquement une chaîne de classes CSS identifiant
 * l'élément ouvrant) jusqu'à sa balise fermante correspondante --
 * par équilibrage réel des balises `<nomBalise` / `</nomBalise>`,
 * jamais une simple recherche de sous-chaîne "quelque part dans le
 * fichier". Preuve structurelle de la relation parent/descendant
 * exigée par UIFIX-V2-01 (Work : "pas seulement vérifier deux classes
 * sur une même ligne").
 */
function extractJsxBlock(src: string, tagName: string, openingMarker: string): string {
  const markerIdx = src.indexOf(openingMarker);
  if (markerIdx < 0) throw new Error(`marqueur "${openingMarker}" introuvable`);

  // Remonte jusqu'au dernier "<tagName" avant le marqueur (l'ouverture
  // de CET élément précis, pas un autre du même type).
  const openTagRe = new RegExp(`<${tagName}(\\s|>)`, "g");
  let lastOpenIdx = -1;
  let m: RegExpExecArray | null;
  while ((m = openTagRe.exec(src.slice(0, markerIdx + openingMarker.length)))) {
    lastOpenIdx = m.index;
  }
  if (lastOpenIdx < 0) throw new Error(`balise ouvrante <${tagName}> introuvable avant le marqueur`);

  // Équilibrage réel : compte les ouvertures/fermetures du MÊME nom
  // de balise à partir de ce point, en ignorant les balises
  // auto-fermantes "<tagName ... />".
  let depth = 0;
  let endIdx = -1;
  const rest = src.slice(lastOpenIdx);
  const tagPattern = new RegExp(`<${tagName}(?:\\s[^>]*)?/?>|</${tagName}>`, "g");
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(rest))) {
    const token = match[0];
    if (token.endsWith("/>")) {
      // auto-fermante : ne change pas la profondeur
      continue;
    }
    if (token.startsWith(`</`)) {
      depth -= 1;
      if (depth === 0) {
        endIdx = lastOpenIdx + match.index + token.length;
        break;
      }
    } else {
      depth += 1;
    }
  }
  if (endIdx < 0) throw new Error(`balise fermante </${tagName}> non trouvée en équilibre`);

  return src.slice(lastOpenIdx, endIdx);
}

test("UIFIX-01: aucune des 5 composants ne contient plus l'anti-pattern bg-white + text-ink-on-bg(-muted) dans le CODE réel", () => {
  for (const file of FIXED_FILES) {
    const src = readFileSync(file, "utf8");
    const codeOnly = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(
      !/bg-white[^"]*text-ink-on-bg/.test(codeOnly) && !/text-ink-on-bg[^"]*bg-white/.test(codeOnly),
      `${file} contient encore l'anti-pattern bg-white + text-ink-on-bg dans le code réel`
    );
  }
});

test("UIFIX-01: les 5 composants utilisent désormais bg-crema (= var(--sc-bg)) pour l'état inactif, réalignant fond et texte sur la même source", () => {
  for (const file of FIXED_FILES) {
    const src = readFileSync(file, "utf8");
    if (file === "components/FulfillmentSelector.tsx") {
      // Extraite dans lib/fulfillment-tone.ts depuis la correction
      // BG-02 -- le composant importe la fonction, ne définit plus la
      // classe inline.
      const toneSrc = readFileSync("lib/fulfillment-tone.ts", "utf8");
      assert.ok(toneSrc.includes("bg-crema"), "lib/fulfillment-tone.ts doit utiliser bg-crema pour l'état par défaut");
      assert.ok(src.includes("getFulfillmentToneClass"), "FulfillmentSelector.tsx doit importer et utiliser la fonction extraite");
    } else {
      assert.ok(src.includes("bg-crema"), `${file} doit utiliser bg-crema pour l'état inactif corrigé`);
    }
  }
});

test("UIFIX-01: aucun nouveau fichier de logique de contraste n'a été créé -- le module existant est réutilisé tel quel", () => {
  const src = readFileSync("lib/color-contrast.ts", "utf8");
  assert.ok(src.includes("readableTextColor"));
  assert.ok(src.includes("readableAccentOnBg"));
  assert.ok(src.includes("mutedOnBg"));
});

test("UIFIX-01: cas de référence bg_color=#171616 -- le texte des catégories/boutons inactifs reste RÉELLEMENT lisible contre le fond réellement affiché", () => {
  const vars = themeStyle(DEFAULT_THEME, { bg: "#171616" });
  assert.equal(vars["--sc-bg"], "#171616");

  const textColor = vars["--sc-ink-on-bg"];
  const actualBackground = vars["--sc-bg"]; // = bg-crema après correctif
  const ratio = contrastRatio(textColor, actualBackground);
  assert.ok(ratio >= 4.5, `contraste réel insuffisant (${ratio.toFixed(2)}:1) entre le texte (${textColor}) et le fond réellement affiché (${actualBackground})`);
});

test("UIFIX-01: cas de référence bg_color=#171616 -- confirme que la régression AURAIT existé avec l'ancien bg-white littéral", () => {
  const vars = themeStyle(DEFAULT_THEME, { bg: "#171616" });
  const textColor = vars["--sc-ink-on-bg"];
  const literalWhiteBackground = "#ffffff";
  const ratioBeforeFix = contrastRatio(textColor, literalWhiteBackground);
  assert.ok(ratioBeforeFix < 4.5, "confirme qu'AVANT le correctif, le texte calculé (blanc) contre le fond littéral blanc était illisible");
  assert.ok(ratioBeforeFix < 1.5, `le ratio avant correctif doit être proche de 1:1, obtenu ${ratioBeforeFix.toFixed(2)}`);
});

test("UIFIX-01: fond clair personnalisé -- texte des éléments inactifs reste lisible", () => {
  const vars = themeStyle(DEFAULT_THEME, { bg: "#FDF6E3" });
  const ratio = contrastRatio(vars["--sc-ink-on-bg"], vars["--sc-bg"]);
  assert.ok(ratio >= 4.5, `contraste insuffisant sur fond clair personnalisé (${ratio.toFixed(2)}:1)`);
});

test("UIFIX-01: fond sombre personnalisé -- texte des éléments inactifs reste lisible", () => {
  const vars = themeStyle(DEFAULT_THEME, { bg: "#0A0A0A" });
  const ratio = contrastRatio(vars["--sc-ink-on-bg"], vars["--sc-bg"]);
  assert.ok(ratio >= 4.5, `contraste insuffisant sur fond sombre personnalisé (${ratio.toFixed(2)}:1)`);
});

test("UIFIX-01: thème par défaut (aucune couleur personnalisée) -- comportement inchangé, toujours lisible", () => {
  for (const themeName of Object.keys(THEMES)) {
    const vars = themeStyle(themeName);
    const ratio = contrastRatio(vars["--sc-ink-on-bg"], vars["--sc-bg"]);
    assert.ok(ratio >= 4.5, `thème "${themeName}" : contraste insuffisant (${ratio.toFixed(2)}:1) sans personnalisation`);
  }
});

test("UIFIX-01: bouton Ajouter (bg-caramel/text-caramel-ink) est inchangé -- pas concerné par ce correctif", () => {
  const menuItemCardSrc = readFileSync("components/MenuItemCard.tsx", "utf8");
  assert.ok(menuItemCardSrc.includes("bg-caramel") && menuItemCardSrc.includes("text-caramel-ink"));
  const vars = themeStyle(DEFAULT_THEME, { primary: "#171616" });
  const ratio = contrastRatio(vars["--sc-accent-text"], vars["--sc-accent"]);
  assert.ok(ratio >= 4.5, "le bouton Ajouter reste lisible même avec une couleur principale personnalisée sombre");
});

test("UIFIX-01: CategoryNav (variante classic) inactive -- lisible sur fond sombre personnalisé", () => {
  const src = readFileSync("components/CategoryNav.tsx", "utf8");
  assert.ok(src.includes('"bg-crema text-ink-on-bg shadow-sm")'));
});

test("UIFIX-01: TableSelector inactif -- lisible sur fond sombre personnalisé", () => {
  const src = readFileSync("components/TableSelector.tsx", "utf8");
  assert.ok(src.includes('"bg-crema text-ink-on-bg shadow-sm")'));
});

test("UIFIX-01: OptionModal inactif -- lisible sur fond sombre personnalisé", () => {
  const src = readFileSync("components/OptionModal.tsx", "utf8");
  assert.ok(src.includes('"bg-crema text-ink-on-bg shadow-sm")'));
});

test("UIFIX-01: CartPanel mode inactif -- lisible sur fond sombre personnalisé", () => {
  const src = readFileSync("components/CartPanel.tsx", "utf8");
  assert.ok(src.includes('"border-transparent bg-crema text-ink-on-bg shadow-sm")'));
});

test("UIFIX-V2-01: CartPanel -- le conteneur RÉEL (le <li> de chaque ligne de panier) qui englobe text-ink-on-bg-muted ET text-accent-dark-on-bg n'a plus de fond littéral figé (preuve structurelle par équilibrage JSX, pas une simple co-occurrence de chaînes)", () => {
  const src = readFileSync("components/CartPanel.tsx", "utf8");
  const liBlock = extractJsxBlock(src, "li", "bg-crema p-3");

  assert.ok(!liBlock.includes("bg-white"), "le <li> extrait ne doit contenir aucun bg-white, ni sur lui-même ni sur un enfant direct");
  assert.ok(liBlock.includes("text-ink-on-bg-muted"), "le descendant text-ink-on-bg-muted (libellé d'option) doit être RÉELLEMENT à l'intérieur de ce <li>, pas ailleurs dans le fichier");
  assert.ok(liBlock.includes("text-accent-dark-on-bg"), "le descendant text-accent-dark-on-bg (prix) doit être RÉELLEMENT à l'intérieur de ce <li>, pas ailleurs dans le fichier");

  // Confirme que le fond RÉELLEMENT affiché de ce <li> pointe bien
  // vers --sc-bg (bg-crema), la même source que les deux calculs de
  // texte -- pas une supposition, une lecture directe de l'attribut
  // className de la balise ouvrante extraite.
  const openingTagLine = liBlock.slice(0, liBlock.indexOf(">") + 1);
  assert.ok(openingTagLine.includes("bg-crema"), "la balise ouvrante du <li> doit porter bg-crema");
});

test("UIFIX-V2-01: CartPanel -- cas de référence bg_color=#171616 -- contraste réel >=4.5:1 pour les DEUX descendants du même conteneur (libellé d'option ET prix)", () => {
  const vars = themeStyle(DEFAULT_THEME, { bg: "#171616" });
  const actualBackground = vars["--sc-bg"]; // = bg-crema, le fond RÉELLEMENT affiché par le <li> après correctif

  const ratioLabel = contrastRatio(vars["--sc-ink-on-bg-muted"], actualBackground);
  assert.ok(ratioLabel >= 4.5, `libellé d'option (text-ink-on-bg-muted) insuffisamment contrasté (${ratioLabel.toFixed(2)}:1) contre le fond réellement affiché`);

  const ratioPrice = contrastRatio(vars["--sc-accent-dark-on-bg"], actualBackground);
  assert.ok(ratioPrice >= 4.5, `prix (text-accent-dark-on-bg) insuffisamment contrasté (${ratioPrice.toFixed(2)}:1) contre le fond réellement affiché`);
});

test("UIFIX-V2-01: CartPanel -- confirme que la régression AURAIT existé avec l'ancien bg-white littéral pour le prix (ratio proche de 1:1, litteralement invisible)", () => {
  const vars = themeStyle(DEFAULT_THEME, { bg: "#171616" });
  const ratioBeforeFix = contrastRatio(vars["--sc-accent-dark-on-bg"], "#ffffff");
  assert.ok(ratioBeforeFix < 1.5, `le prix contre l'ancien bg-white littéral devait être quasi invisible, obtenu ${ratioBeforeFix.toFixed(2)}:1`);
});

test("UIFIX-V2-01: OptionModal -- le conteneur RÉEL (le compteur total) qui englobe text-accent-dark-on-bg n'a plus de fond littéral figé (preuve structurelle par équilibrage JSX)", () => {
  const src = readFileSync("components/OptionModal.tsx", "utf8");
  const divBlock = extractJsxBlock(src, "div", "bg-crema p-3");

  assert.ok(!divBlock.includes("bg-white"), "le <div> extrait ne doit contenir aucun bg-white");
  assert.ok(divBlock.includes("text-accent-dark-on-bg"), "le descendant text-accent-dark-on-bg (total) doit être RÉELLEMENT à l'intérieur de ce <div>, pas ailleurs dans le fichier");

  const openingTagLine = divBlock.slice(0, divBlock.indexOf(">") + 1);
  assert.ok(openingTagLine.includes("bg-crema"), "la balise ouvrante du <div> doit porter bg-crema");
});

test("UIFIX-V2-01: OptionModal -- le SECOND text-accent-dark-on-bg (section 'Étape 2 — répartition') n'est PAS dans ce même conteneur -- confirme que seul le total était concerné, jamais un renommage global aveugle", () => {
  const src = readFileSync("components/OptionModal.tsx", "utf8");
  const divBlock = extractJsxBlock(src, "div", "bg-crema p-3");
  const occurrencesInBlock = (divBlock.match(/text-accent-dark-on-bg/g) || []).length;
  assert.equal(occurrencesInBlock, 1, "un seul descendant text-accent-dark-on-bg doit être dans ce conteneur précis (le total) -- l'autre occurrence (répartition) est ailleurs, à raison");
});

test("UIFIX-V2-01: OptionModal -- cas de référence bg_color=#171616 -- contraste réel >=4.5:1 pour le total", () => {
  const vars = themeStyle(DEFAULT_THEME, { bg: "#171616" });
  const actualBackground = vars["--sc-bg"];
  const ratioTotal = contrastRatio(vars["--sc-accent-dark-on-bg"], actualBackground);
  assert.ok(ratioTotal >= 4.5, `total (text-accent-dark-on-bg) insuffisamment contrasté (${ratioTotal.toFixed(2)}:1) contre le fond réellement affiché`);
});

test("UIFIX-V2-01: recherche exhaustive finale -- dans les 5 composants corrigés, AUCUNE occurrence de bg-white n'englobe structurellement text-ink-on-bg, text-ink-on-bg-muted ou text-accent-dark-on-bg (vérifié par équilibrage JSX sur chaque occurrence restante, pas seulement par ligne)", () => {
  const patterns = ["text-ink-on-bg", "text-ink-on-bg-muted", "text-accent-dark-on-bg"];
  for (const file of FIXED_FILES) {
    const src = readFileSync(file, "utf8");
    // Repère chaque occurrence RESTANTE de bg-white dans ce fichier et
    // vérifie qu'aucune ne provient d'un bloc JSX qui engloberait
    // aussi l'un des 3 patterns.
    const bgWhiteLines = src.split("\n").filter((l) => l.includes("bg-white"));
    for (const line of bgWhiteLines) {
      for (const pattern of patterns) {
        assert.ok(!line.includes(pattern), `${file} : une ligne combine encore bg-white et ${pattern} directement : "${line.trim()}"`);
      }
    }
  }
});

test("UIFIX-01: FulfillmentSelector mode inactif -- lisible sur fond sombre personnalisé (variante -muted)", () => {
  const src = readFileSync("lib/fulfillment-tone.ts", "utf8");
  assert.ok(src.includes('"bg-crema text-ink-on-bg-muted"'));
  const vars = themeStyle(DEFAULT_THEME, { bg: "#171616" });
  const ratio = contrastRatio(vars["--sc-ink-on-bg-muted"], vars["--sc-bg"]);
  assert.ok(ratio >= 4.5, `texte atténué (muted) insuffisamment contrasté (${ratio.toFixed(2)}:1)`);
});

test("UIFIX-01: la variante 'editorial' de CategoryNav n'a jamais eu ce défaut et reste inchangée", () => {
  const src = readFileSync("components/CategoryNav.tsx", "utf8");
  const classicBlockEnd = src.indexOf("\n  }\n\n  return (");
  const editorialSection = src.slice(classicBlockEnd);
  assert.ok(editorialSection.length > 0, "la section editorial doit être trouvée");
  assert.ok(!editorialSection.includes("bg-white"), "la variante editorial ne doit jamais contenir bg-white");
});

test("UIFIX-V5: InlineOptions/PastryModal/QuantityControl ne dépendent plus de la couleur héritée du body sur leurs surfaces blanches", () => {
  for (const file of INHERITED_COLOR_FIXED_FILES) {
    const src = readFileSync(file, "utf8");
    assert.ok(src.includes("text-stone-900") || src.includes("text-stone-600"), `${file} doit expliciter une couleur sûre sur blanc`);
  }
});

test("UIFIX-01: aucun fichier SQL, migration, RPC ou RLS n'est concerné -- strictement frontend", () => {
  const fixedComponentsSrc = FIXED_FILES.map((f) => readFileSync(f, "utf8")).join("\n");
  assert.ok(!fixedComponentsSrc.includes(".rpc("), "aucun de ces 5 composants ne doit gagner un nouvel appel RPC par ce correctif");
});

test("UIFIX-01 (Back Office): les 4 textes d'aide correspondent exactement au comportement réel audité, dans les 3 langues", () => {
  const i18nSrc = readFileSync("lib/i18n.ts", "utf8");
  for (const key of ["stPrimaryColorHelp", "stSecondaryColorHelp", "stAccentColorHelp", "stBgColorHelp"]) {
    const occurrences = (i18nSrc.match(new RegExp(`${key}:`, "g")) || []).length;
    assert.equal(occurrences, 3, `${key} doit exister dans les 3 dictionnaires (fr/en/ar)`);
  }
  assert.ok(i18nSrc.includes("Boutons principaux, catégories actives et actions importantes."));
  assert.ok(i18nSrc.includes("Texte général et texte des éléments inactifs."));
  assert.ok(i18nSrc.includes("Filets, indicateurs actifs et détails visuels."));
  assert.ok(i18nSrc.includes("Fond général de la carte et fond des éléments inactifs."));
});

test("UIFIX-01 (Back Office): ColorField affiche le texte d'aide sous le champ, aucune autre logique Dashboard modifiée", () => {
  const src = readFileSync("app/dashboard/settings/page.tsx", "utf8");
  assert.ok(src.includes("helpText?: string"));
  assert.ok(src.includes("{helpText && <p"));
  assert.ok(src.includes('helpText={t("stPrimaryColorHelp")}'));
  assert.ok(src.includes('helpText={t("stSecondaryColorHelp")}'));
  assert.ok(src.includes('helpText={t("stAccentColorHelp")}'));
  assert.ok(src.includes('helpText={t("stBgColorHelp")}'));
});

// ====================================================================
// Findings Work (2e tour) -- BG-01 et BG-02, corrigés et prouvés
// ====================================================================

test("BG-01: aucune trace du littéral 'bg-white' ne subsiste, même en commentaire, dans CategoryNav.tsx et TableSelector.tsx (recherche BRUTE, sans filtrage)", () => {
  // Recherche volontairement NON filtrée (contrairement au test
  // 'code réel' plus haut) : Work a signalé qu'un grep direct
  // trouvait encore le token, y compris dans un commentaire
  // explicatif -- corrigé en reformulant ces commentaires pour ne
  // plus contenir la chaîne "bg-white" du tout, éliminant toute
  // ambiguïté pour une recherche simple.
  for (const file of ["components/CategoryNav.tsx", "components/TableSelector.tsx"]) {
    const src = readFileSync(file, "utf8");
    assert.ok(!src.includes("bg-white"), `${file} ne doit plus contenir la chaîne "bg-white" nulle part, y compris en commentaire`);
  }
});

test("BG-01: les occurrences légitimes et non liées de 'bg-white' dans OptionModal.tsx/CartPanel.tsx/FulfillmentSelector.tsx ne sont JAMAIS associées à text-ink-on-bg(-muted) -- confirmé hors du périmètre exact de l'anti-pattern", () => {
  for (const file of ["components/OptionModal.tsx", "components/CartPanel.tsx", "components/FulfillmentSelector.tsx"]) {
    const src = readFileSync(file, "utf8");
    // Chaque occurrence restante de bg-white doit être sur une ligne
    // qui ne mentionne PAS text-ink-on-bg dans la même expression --
    // vérifié ligne par ligne, pas seulement globalement.
    const lines = src.split("\n");
    for (const line of lines) {
      if (line.includes("bg-white")) {
        assert.ok(!line.includes("text-ink-on-bg"), `${file} : ligne "${line.trim()}" associe encore bg-white à text-ink-on-bg`);
      }
    }
  }
});

test("BG-02: getFulfillmentToneClass préserve EXACTEMENT les 3 branches d'origine (good/warn/défaut), preuve empirique plutôt qu'inspection visuelle du diff", () => {
  assert.equal(getFulfillmentToneClass("good"), "bg-green-50 text-green-800");
  assert.equal(getFulfillmentToneClass("warn"), "bg-amber-50 text-amber-900");
  // Corrige une lacune trouvée pendant CETTE vérification même :
  // "info" (utilisé par les cas below-min/no-postal) tombe bien sur
  // la branche par défaut, comme AVANT toute modification -- jamais
  // testé isolément avant ce tour.
  assert.equal(getFulfillmentToneClass("info"), "bg-crema text-ink-on-bg-muted");
  assert.equal(getFulfillmentToneClass(null), "bg-crema text-ink-on-bg-muted");
  assert.equal(getFulfillmentToneClass(undefined), "bg-crema text-ink-on-bg-muted");
  assert.equal(getFulfillmentToneClass("valeur-jamais-anticipee"), "bg-crema text-ink-on-bg-muted");
});

test("BG-02: FulfillmentSelector.tsx importe getFulfillmentToneClass depuis lib/fulfillment-tone.ts (fonction pure extraite), ne redéfinit plus la logique inline", () => {
  const src = readFileSync("components/FulfillmentSelector.tsx", "utf8");
  assert.ok(src.includes('import { getFulfillmentToneClass } from "@/lib/fulfillment-tone";'));
  assert.ok(src.includes("const toneClass = getFulfillmentToneClass(message?.tone);"));
  assert.ok(!src.includes('message?.tone === "good"'), "l'ancienne logique inline ne doit plus exister dans le composant");
});

test("BG-02: lib/fulfillment-tone.ts est un fichier .ts pur, sans JSX ni directive 'use client' -- testable directement sans rendu DOM", () => {
  const src = readFileSync("lib/fulfillment-tone.ts", "utf8");
  assert.ok(!src.includes("use client"));
  assert.ok(!src.includes("<"), "aucune syntaxe JSX ne doit apparaître dans ce fichier utilitaire pur");
});

// ====================================================================
// UIFIX-V3-01 (contre-audit Work, 4e tour) -- 4 nouveaux composants
// confirmés BUG par audit structurel exhaustif (parent/descendant réel,
// jamais une co-occurrence de ligne). InlineOptions/PastryModal/
// QuantityControl audités et confirmés COHÉRENTS -- documentés,
// jamais corrigés à tort.
// ====================================================================

test("UIFIX-V3-01: MenuItemCard.tsx -- cardClasses (bg-crema) englobe RÉELLEMENT text-ink-on-bg-muted, text-accent-dark-on-bg et text-ink-on-bg dans les DEUX branches de rendu (inline et standard)", () => {
  const src = readFileSync("components/MenuItemCard.tsx", "utf8");
  // bg-white légitime et isolé sur le petit bouton "−" (aucune classe
  // *-on-bg dessus, même patron que InlineOptions/OptionModal) --
  // vérifié qu'il ne combine jamais bg-white avec l'une des classes
  // signalées, pas qu'il ait totalement disparu du fichier.
  const codeOnly = src.replace(/\/\/.*$/gm, "");
  for (const line of codeOnly.split("\n")) {
    if (line.includes("bg-white")) {
      for (const pattern of ["text-ink-on-bg", "text-accent-dark-on-bg"]) {
        assert.ok(!line.includes(pattern), `MenuItemCard.tsx : "${line.trim()}" combine bg-white et ${pattern}`);
      }
    }
  }

  // Branche inline (article, isInline === true)
  const inlineArticle = extractJsxBlock(src, "article", "text-ink-on-bg\"");
  assert.ok(inlineArticle.includes("text-ink-on-bg-muted"));
  assert.ok(inlineArticle.includes("text-accent-dark-on-bg"));
  assert.ok(inlineArticle.includes("text-ink-on-bg\""));

  // Les deux valeurs de cardClasses utilisent bg-crema
  assert.ok(src.includes('"rounded-lg border border-gold/20 bg-crema p-3'));
  assert.ok(src.includes('"rounded-2xl bg-crema p-3'));
});

test("UIFIX-V3-01: OrderConfirmation.tsx -- le conteneur du récapitulatif (bg-crema) englobe RÉELLEMENT text-ink-on-bg et text-ink-on-bg-muted, jamais les éléments HORS de ce conteneur (sous-titre, remerciements) qui étaient déjà cohérents", () => {
  const src = readFileSync("components/OrderConfirmation.tsx", "utf8");
  const summaryBlock = extractJsxBlock(src, "div", "space-y-2 rounded-2xl bg-crema p-4");

  assert.ok(!summaryBlock.includes("bg-white"));
  assert.ok(summaryBlock.includes("text-ink-on-bg\""));
  assert.ok(summaryBlock.includes("text-ink-on-bg-muted"));

  // "confirmThanks" (texte) et "newOrder" (bouton), tous deux
  // text-accent-dark-on-bg, sont HORS de ce conteneur, déjà
  // correctement affichés contre le fond global bg-crema -- jamais
  // touchés. Confirmé : exactement 2 occurrences dans TOUT le
  // fichier, aucune à l'intérieur de ce bloc précis.
  const totalAccentDark = (src.match(/text-accent-dark-on-bg/g) || []).length;
  assert.equal(totalAccentDark, 2);
  assert.ok(!summaryBlock.includes("text-accent-dark-on-bg"), "ni confirmThanks ni newOrder ne doivent être dans le conteneur corrigé, à raison");
});

test("UIFIX-V3-01: ProductInfoButton.tsx -- le <dialog> (bg-crema) englobe RÉELLEMENT text-ink-on-bg", () => {
  const src = readFileSync("components/ProductInfoButton.tsx", "utf8");
  const dialogBlock = extractJsxBlock(src, "dialog", "bg-crema p-4");

  assert.ok(!dialogBlock.includes("bg-white"));
  assert.ok(dialogBlock.includes("text-ink-on-bg"));

  // Le bouton déclencheur (text-ink-on-bg-muted, la petite icône "i")
  // n'a pas son propre fond -- il hérite du fond de son emplacement
  // réel (la carte produit, déjà corrigée séparément dans MenuItemCard).
  const triggerButtonBlock = extractJsxBlock(src, "button", "text-ink-on-bg-muted");
  assert.ok(!triggerButtonBlock.includes("bg-white"), "le bouton déclencheur n'a jamais eu de fond propre à corriger");
});

test("UIFIX-V3-01: RestaurantInfoCard.tsx -- le conteneur de la fiche (bg-crema) englobe RÉELLEMENT les 3 classes signalées, y compris le lien téléphone (text-accent-dark-on-bg) rendu via row.content", () => {
  const src = readFileSync("components/RestaurantInfoCard.tsx", "utf8");
  const cardBlock = extractJsxBlock(src, "div", "divide-y divide-espresso/5 rounded-2xl bg-crema");

  assert.ok(!cardBlock.includes("bg-white"));
  assert.ok(cardBlock.includes("text-ink-on-bg-muted"));
  assert.ok(cardBlock.includes("text-ink-on-bg\""));
  // Le lien téléphone (text-accent-dark-on-bg) est défini plus haut
  // dans `rows`, mais rendu via {row.content} À L'INTÉRIEUR de ce même
  // conteneur -- confirmé structurellement par la présence de la
  // définition ET du point de rendu {row.content} dans le fichier.
  assert.ok(src.includes("text-accent-dark-on-bg"));
  assert.ok(cardBlock.includes("{row.content}"), "row.content (qui peut contenir le lien téléphone) est bien rendu à l'intérieur de ce conteneur");
});

test("UIFIX-V3-01: cas de référence bg_color=#171616 -- les 3 types de texte concernés (ink-on-bg, ink-on-bg-muted, accent-dark-on-bg) dépassent tous 4.5:1 contre le fond réellement affiché après correctif", () => {
  const vars = themeStyle(DEFAULT_THEME, { bg: "#171616" });
  const realBg = vars["--sc-bg"];
  const cases: [string, string][] = [
    ["--sc-ink-on-bg", vars["--sc-ink-on-bg"]],
    ["--sc-ink-on-bg-muted", vars["--sc-ink-on-bg-muted"]],
    ["--sc-accent-dark-on-bg", vars["--sc-accent-dark-on-bg"]],
  ];
  for (const [name, value] of cases) {
    const ratio = contrastRatio(value, realBg);
    assert.ok(ratio >= 4.5, `${name} (${value}) insuffisamment contrasté contre le fond réel (${ratio.toFixed(2)}:1)`);
  }
});

test("UIFIX-V3-01: preuve de régression AVANT correctif -- les 3 types de texte étaient illisibles contre l'ancien bg-white littéral (ratio <=1.96:1, sous le seuil WCAG 4.5:1)", () => {
  const vars = themeStyle(DEFAULT_THEME, { bg: "#171616" });
  const literalWhite = "#ffffff";
  const cases: [string, string, number][] = [
    ["--sc-ink-on-bg", vars["--sc-ink-on-bg"], 1.5],
    ["--sc-ink-on-bg-muted", vars["--sc-ink-on-bg-muted"], 2.5],
    ["--sc-accent-dark-on-bg", vars["--sc-accent-dark-on-bg"], 1.5],
  ];
  for (const [name, value, maxRatio] of cases) {
    const ratio = contrastRatio(value, literalWhite);
    assert.ok(ratio < 4.5, `${name} devait être sous le seuil WCAG contre l'ancien fond littéral (obtenu ${ratio.toFixed(2)}:1)`);
    assert.ok(ratio <= maxRatio, `${name} : ratio avant correctif plus élevé qu'attendu (${ratio.toFixed(2)}:1)`);
  }
});

test("UIFIX-V3-01: thèmes de non-régression -- fond clair personnalisé, fond sombre personnalisé, et les 5 thèmes par défaut restent tous lisibles pour les 3 classes de texte concernées", () => {
  const bgCases = ["#FDF6E3", "#0A0A0A"];
  for (const bg of bgCases) {
    const vars = themeStyle(DEFAULT_THEME, { bg });
    for (const cls of ["--sc-ink-on-bg", "--sc-ink-on-bg-muted", "--sc-accent-dark-on-bg"]) {
      const ratio = contrastRatio(vars[cls], vars["--sc-bg"]);
      assert.ok(ratio >= 4.5, `${cls} insuffisant pour bg=${bg} (${ratio.toFixed(2)}:1)`);
    }
  }
  for (const themeName of Object.keys(THEMES)) {
    const vars = themeStyle(themeName);
    for (const cls of ["--sc-ink-on-bg", "--sc-ink-on-bg-muted", "--sc-accent-dark-on-bg"]) {
      const ratio = contrastRatio(vars[cls], vars["--sc-bg"]);
      assert.ok(ratio >= 4.5, `thème "${themeName}" : ${cls} insuffisant sans personnalisation (${ratio.toFixed(2)}:1)`);
    }
  }
});

test("UIFIX-V5: InlineOptions/PastryModal/QuantityControl conservent leurs surfaces blanches intentionnelles, désormais durcies contre l'héritage", () => {
  for (const file of INHERITED_COLOR_FIXED_FILES) {
    const src = readFileSync(file, "utf8");
    assert.ok(src.includes("bg-white"), `${file} doit conserver sa surface blanche intentionnelle`);
    assert.ok(/text-stone-(900|600)/.test(src), `${file} doit expliciter une couleur non héritée adaptée au blanc`);
  }
});

test("UIFIX-V3-01: recherche exhaustive finale sur l'ENSEMBLE du frontend public (19 composants) -- aucune association bg-white + classe *-on-bg calculée ne subsiste, même par ligne", () => {
  const ALL_PUBLIC_COMPONENTS = [
    "Bidi", "CartPanel", "CategoryNav", "FulfillmentSelector", "Icons",
    "InlineOptions", "LanguageSelector", "MenuItemCard", "MenuView",
    "OptionModal", "OrderConfirmation", "PastryModal", "ProductInfoButton",
    "ProductPhotoPlaceholder", "QuantityControl", "RestaurantHeader",
    "RestaurantInfoBar", "RestaurantInfoCard", "TableSelector",
  ];
  const patterns = ["text-ink-on-bg", "text-ink-on-bg-muted", "text-accent-dark-on-bg", "text-highlight-on-ink"];
  for (const name of ALL_PUBLIC_COMPONENTS) {
    const src = readFileSync(`components/${name}.tsx`, "utf8");
    const lines = src.split("\n");
    for (const line of lines) {
      if (line.includes("bg-white")) {
        for (const pattern of patterns) {
          assert.ok(!line.includes(pattern), `components/${name}.tsx : "${line.trim()}" combine bg-white et ${pattern}`);
        }
      }
    }
  }
});

test("UIFIX-V3-01: aucune logique métier panier/commande/produit n'a changé -- seules les classes de fond ont été modifiées dans les 4 fichiers", () => {
  for (const file of ["components/MenuItemCard.tsx", "components/OrderConfirmation.tsx", "components/ProductInfoButton.tsx", "components/RestaurantInfoCard.tsx"]) {
    const src = readFileSync(file, "utf8");
    assert.ok(!src.includes(".rpc("), `${file} ne doit gagner aucun nouvel appel RPC`);
  }
  // onAdd/onRemove/onChangeChoice restent les seuls points d'entrée
  // métier de MenuItemCard, inchangés en nombre et en nom.
  const menuItemCardSrc = readFileSync("components/MenuItemCard.tsx", "utf8");
  for (const handler of ["onAdd", "onRemove", "onChangeChoice"]) {
    assert.ok(menuItemCardSrc.includes(handler), `${handler} doit toujours exister, inchangé`);
  }
});

// ====================================================================
// UIFIX v5 -- durcissement de la couleur HÉRITÉE sur les surfaces
// blanches. Le body porte text-ink-on-bg ; Tailwind Preflight impose
// color: inherit aux contrôles. Une surface bg-white sans couleur
// explicite pouvait donc afficher du blanc sur blanc lorsque
// bg_color=#171616.
// ====================================================================

const ALL_PUBLIC_COMPONENTS = [
  "Bidi", "CartPanel", "CategoryNav", "FulfillmentSelector", "Icons",
  "InlineOptions", "LanguageSelector", "MenuItemCard", "MenuView",
  "OptionModal", "OrderConfirmation", "PastryModal", "ProductInfoButton",
  "ProductPhotoPlaceholder", "QuantityControl", "RestaurantHeader",
  "RestaurantInfoBar", "RestaurantInfoCard", "TableSelector",
];

type JsxOpeningTag = { tagName: string; opening: string; offset: number };

/**
 * Collecte les vraies balises ouvrantes JSX, même lorsque className est
 * réparti sur plusieurs lignes ou construit dans une expression. Le
 * scanner ne considère `>` comme la fin de la balise qu'en dehors des
 * chaînes et des accolades : une flèche `(e) => ...` dans un handler ne
 * tronque donc pas artificiellement le contrôle.
 */
function scanJsxOpeningTags(src: string): JsxOpeningTag[] {
  const tags: JsxOpeningTag[] = [];
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] !== "<" || !/[A-Za-z]/.test(src[i + 1] ?? "")) continue;
    const nameMatch = src.slice(i + 1).match(/^[A-Za-z][A-Za-z0-9.]*/);
    if (!nameMatch) continue;

    let quote: "'" | '"' | "`" | null = null;
    let braceDepth = 0;
    let end = -1;
    for (let j = i + 1 + nameMatch[0].length; j < src.length; j += 1) {
      const ch = src[j];
      const prev = src[j - 1];
      if (quote) {
        if (ch === quote && prev !== "\\") quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "{") braceDepth += 1;
      else if (ch === "}") braceDepth -= 1;
      else if (ch === ">" && braceDepth === 0) {
        end = j + 1;
        break;
      }
    }
    if (end > 0) {
      tags.push({ tagName: nameMatch[0], opening: src.slice(i, end), offset: i });
      i = end - 1;
    }
  }
  return tags;
}

const SAFE_ON_WHITE_CLASSES = [
  "text-stone-900",
  "text-stone-600",
  "text-amber-900",
];

test("UIFIX-V5-01: le mécanisme causal est couvert -- body hérite text-ink-on-bg et Tailwind Preflight transmet réellement color aux contrôles", () => {
  const globals = readFileSync("app/globals.css", "utf8");
  assert.match(globals, /body\s*\{[\s\S]*text-ink-on-bg[\s\S]*\}/);

  const preflight = readFileSync("node_modules/tailwindcss/src/css/preflight.css", "utf8");
  for (const control of ["button", "input", "select", "textarea"]) {
    assert.ok(preflight.includes(control), `Tailwind Preflight doit couvrir ${control}`);
  }
  assert.match(preflight, /button,[\s\S]*input,[\s\S]*select,[\s\S]*textarea[\s\S]*color:\s*inherit;/);
});

test("UIFIX-V5-01: inventaire exhaustif -- les 9 surfaces blanches publiques ont une couleur sûre sur la surface ou sur chacun de leurs contenus directs", () => {
  const expectedCounts: Record<string, number> = {
    CartPanel: 1,
    FulfillmentSelector: 2,
    InlineOptions: 1,
    MenuItemCard: 1,
    OptionModal: 2,
    PastryModal: 1,
    QuantityControl: 1,
  };
  let total = 0;

  for (const name of ALL_PUBLIC_COMPONENTS) {
    const src = readFileSync(`components/${name}.tsx`, "utf8");
    const whiteSurfaces = scanJsxOpeningTags(src).filter((tag) => tag.opening.includes("bg-white"));
    assert.equal(
      whiteSurfaces.length,
      expectedCounts[name] ?? 0,
      `${name}: nombre de surfaces blanches différent de l'inventaire audité`
    );
    total += whiteSurfaces.length;

    for (const surface of whiteSurfaces) {
      // La ligne d'option est une surface composite : son libellé est
      // réellement sur blanc, mais son compteur remplace ce fond par
      // bg-crema. Sa couleur ne doit donc surtout pas être fixée au
      // niveau du <li>. Le test structurel dédié ci-dessous vérifie les
      // deux sous-surfaces et leur héritage effectif.
      const isCompositeOptionRow = name === "OptionModal" && surface.tagName === "li";
      if (isCompositeOptionRow) {
        assert.ok(
          !SAFE_ON_WHITE_CLASSES.some((safeClass) => surface.opening.includes(safeClass)),
          "OptionModal <li>: une couleur fixe sur le parent traverserait le changement de fond bg-crema"
        );
        continue;
      }
      assert.ok(
        SAFE_ON_WHITE_CLASSES.some((safeClass) => surface.opening.includes(safeClass)),
        `${name} <${surface.tagName}> @${surface.offset}: bg-white dépend encore d'une couleur héritée ou thémée`
      );
      for (const unsafeClass of [
        "text-ink-on-bg",
        "text-ink-on-bg-muted",
        "text-accent-dark-on-bg",
        "text-caramel ",
      ]) {
        assert.ok(
          !surface.opening.includes(unsafeClass),
          `${name} <${surface.tagName}> @${surface.offset}: ${unsafeClass.trim()} n'est pas garantie sur blanc`
        );
      }
    }
  }
  assert.equal(total, 9, "l'inventaire public v5 doit couvrir exactement 9 surfaces blanches");
});

test("UIFIX-V6-01: OptionModal sépare réellement la couleur du libellé sur blanc et celle du compteur sur bg-crema", () => {
  const src = readFileSync("components/OptionModal.tsx", "utf8");
  const row = extractJsxBlock(src, "li", "flex items-center justify-between gap-3 rounded-xl p-3 ");
  const rowOpening = scanJsxOpeningTags(row)[0]?.opening ?? "";

  assert.ok(rowOpening.includes("bg-white"), "la ligne reste une surface blanche intentionnelle");
  assert.ok(!rowOpening.includes("text-stone-900"), "la couleur fixe ne doit pas être héritée par le sous-fond bg-crema");
  assert.ok(
    row.includes('className="min-w-0 text-sm font-semibold leading-snug text-stone-900"'),
    "le libellé réellement affiché sur blanc doit porter sa couleur fixe"
  );

  const counter = extractJsxBlock(row, "div", "rounded-full bg-crema px-2 py-1 text-ink-on-bg");
  const counterOpening = scanJsxOpeningTags(counter)[0]?.opening ?? "";
  assert.ok(counterOpening.includes("bg-crema"), "le compteur doit conserver le fond marchand");
  assert.ok(counterOpening.includes("text-ink-on-bg"), "le compteur doit recalculer sa couleur contre --sc-bg");
  assert.ok(counter.includes('{n}</span>'), "le nombre doit être structurellement descendant de ce conteneur corrigé");
});

test("UIFIX-V6-02: OptionModal #171616 -- le changement de fond imbriqué réinitialise l'héritage et rend le compteur >= 4.5:1", () => {
  const vars = themeStyle(DEFAULT_THEME, { bg: "#171616" });
  const inheritedFromWhiteParent = "#1c1917";
  const brokenRatio = contrastRatio(inheritedFromWhiteParent, vars["--sc-bg"]);
  assert.ok(brokenRatio < 1.1, `la régression auditée doit être reproduite, ratio obtenu ${brokenRatio.toFixed(2)}:1`);

  const fixedRatio = contrastRatio(vars["--sc-ink-on-bg"], vars["--sc-bg"]);
  assert.ok(fixedRatio >= 4.5, `le compteur corrigé reste insuffisant : ${fixedRatio.toFixed(2)}:1`);
});

test("UIFIX-V5-01: les inputs/textarea blancs explicitent texte saisi ET placeholder sûrs", () => {
  const cart = readFileSync("components/CartPanel.tsx", "utf8");
  const fulfillment = readFileSync("components/FulfillmentSelector.tsx", "utf8");
  for (const [name, src] of [["CartPanel", cart], ["FulfillmentSelector", fulfillment]] as const) {
    assert.ok(src.includes("bg-white"));
    assert.ok(src.includes("text-stone-900"), `${name}: couleur de valeur saisie manquante`);
    assert.ok(src.includes("placeholder:text-stone-500"), `${name}: couleur de placeholder manquante`);
  }
});

test("UIFIX-V5-01: les noms de pâtisserie et leur indicateur sélectionné ne réintroduisent aucune couleur marchande sur blanc", () => {
  const src = readFileSync("components/PastryModal.tsx", "utf8");
  assert.ok(src.includes("bg-white text-left text-stone-900"));
  assert.ok(src.includes('<span className="text-stone-900">✓</span>'));
  assert.ok(!src.includes('<span className="text-caramel">✓</span>'));
});

test("UIFIX-V5-01: cas #171616 -- texte normal, désactivé et placeholder dépassent tous 4.5:1 sur blanc", () => {
  const fixedWhite = "#ffffff";
  const fixedColors: Record<string, string> = {
    "text-stone-900": "#1c1917",
    "text-stone-600": "#57534e",
    "placeholder:text-stone-500": "#78716c",
    "text-amber-900": "#78350f",
  };
  const vars = themeStyle(DEFAULT_THEME, { bg: "#171616" });
  assert.equal(vars["--sc-ink-on-bg"], "#ffffff", "le cas de référence doit bien produire un texte body blanc");
  assert.equal(contrastRatio(vars["--sc-ink-on-bg"], fixedWhite), 1, "la couleur héritée aurait été blanc sur blanc");

  for (const [name, color] of Object.entries(fixedColors)) {
    const ratio = contrastRatio(color, fixedWhite);
    assert.ok(ratio >= 4.5, `${name} (${color}) insuffisant sur blanc : ${ratio.toFixed(2)}:1`);
  }
});

test("UIFIX-V5-01: thème clair, sombre, #171616 et thèmes par défaut ne changent jamais les couleurs fixes des surfaces blanches", () => {
  const themeCases = [
    themeStyle(DEFAULT_THEME),
    themeStyle(DEFAULT_THEME, { bg: "#FDF6E3" }),
    themeStyle(DEFAULT_THEME, { bg: "#0A0A0A" }),
    themeStyle(DEFAULT_THEME, { bg: "#171616" }),
    ...Object.keys(THEMES).map((themeName) => themeStyle(themeName)),
  ];
  for (const vars of themeCases) {
    assert.ok(vars["--sc-bg"], "chaque thème doit continuer à produire son fond marchand");
    assert.ok(contrastRatio("#1c1917", "#ffffff") >= 4.5);
    assert.ok(contrastRatio("#57534e", "#ffffff") >= 4.5);
    assert.ok(contrastRatio("#78716c", "#ffffff") >= 4.5);
  }
});
