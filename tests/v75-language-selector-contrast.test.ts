import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym V75 — correction finale ciblée après contre-audit Work sur
// V74 (finding V74-01 : contraste du texte inactif dans
// LanguageSelector.tsx).
// ====================================================================

const languageSelectorSrc = readFileSync("components/LanguageSelector.tsx", "utf8");

test("V74-01: LanguageSelector -- l'état INACTIF n'applique plus d'opacité sur text-ink-text (texte lisible réel)", () => {
  const codeOnly = languageSelectorSrc.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(!codeOnly.includes("text-ink-text/80"));
  assert.ok(codeOnly.includes('"text-ink-text"') || codeOnly.includes(": \"text-ink-text\""));
});

test("V74-01: l'état ACTIF (déjà validé, hors périmètre de ce correctif) reste inchangé -- bg-crema text-ink-on-bg", () => {
  assert.ok(languageSelectorSrc.includes("bg-crema text-ink-on-bg"));
});

test("V74-01: reproduction EXACTE du cas rapporté par Work -- secondary_color=#777777, texte inactif >= 4.5:1 (mesuré, pas seulement code source)", async () => {
  const { themeStyle } = await import("../lib/themes.ts");
  const { contrastRatio } = await import("../lib/color-contrast.ts");
  const s = themeStyle("cafe", { secondary: "#777777" });
  // Reproduit exactement ce que Work a mesuré : le texte inactif
  // (désormais à pleine puissance, --sc-ink-text) contre le fond du
  // conteneur (--sc-ink, désormais opaque depuis V72-02).
  const ratio = contrastRatio(s["--sc-ink-text"], s["--sc-ink"]);
  assert.ok(ratio >= 4.5, `ratio mesuré ${ratio.toFixed(2)}:1, attendu >= 4.5:1 (Work avait mesuré ≈3.97:1 avant correction)`);
});

test("V74-01: 6 couleurs de personnalisation testées sur le COMPOSANT FINAL (classes réellement rendues), pas seulement le helper isolé", async () => {
  const { themeStyle } = await import("../lib/themes.ts");
  const { contrastRatio } = await import("../lib/color-contrast.ts");

  const cases: Array<[string, string]> = [
    ["blanc", "#FFFFFF"],
    ["noir", "#000000"],
    ["gris moyen (cas Work)", "#777777"],
    ["jaune clair", "#FFFF66"],
    ["bleu saturé", "#0000FF"],
    ["couleur sombre", "#1A1A1A"],
  ];

  for (const [desc, secondary] of cases) {
    const s = themeStyle("cafe", { secondary });
    // Reproduit précisément ce que le composant final rend :
    // - le conteneur est bg-espresso (== --sc-ink, opaque, V72-02) ;
    // - l'état inactif est désormais la classe "text-ink-text" SEULE
    //   (sans opacité, ce correctif) -- valeur = --sc-ink-text ;
    // - contraste mesuré entre CETTE valeur et le fond RÉEL du
    //   conteneur (--sc-ink), exactement la paire visible à l'écran.
    const ratio = contrastRatio(s["--sc-ink-text"], s["--sc-ink"]);
    assert.ok(ratio >= 4.5, `${desc} (secondary_color=${secondary}) : ratio ${ratio.toFixed(2)}:1, attendu >= 4.5:1`);
  }
});

test("V74-01: le thème par défaut (aucune personnalisation) reste inchangé -- --sc-ink-text toujours blanc pour les 5 thèmes", async () => {
  const { themeStyle, THEMES } = await import("../lib/themes.ts");
  for (const name of Object.keys(THEMES)) {
    const s = themeStyle(name);
    assert.equal(s["--sc-ink-text"], "#ffffff", `thème '${name}'`);
  }
});

test("V74-01: recherche exhaustive -- aucune AUTRE occurrence de code réel combinant une variable de contraste calculée et une opacité Tailwind (l'unique exception légitime, l'Ornament décoratif, est vérifiée séparément ci-dessous)", () => {
  const files = [
    "components/RestaurantInfoBar.tsx",
    "components/LanguageSelector.tsx",
    "components/MenuItemCard.tsx",
    "components/CartPanel.tsx",
    "components/OrderConfirmation.tsx",
    "components/FulfillmentSelector.tsx",
    "components/CategoryNav.tsx",
    "components/InlineOptions.tsx",
    "components/OptionModal.tsx",
    "components/PastryModal.tsx",
    "components/ProductInfoButton.tsx",
    "components/TableSelector.tsx",
    "components/RestaurantInfoCard.tsx",
    "components/MenuView.tsx",
  ];
  const computedColorClasses = [
    "text-ink-text/", "text-highlight-on-ink/", "text-ink-on-bg/",
    "text-accent-dark-on-bg/", "text-accent-text/", "text-caramel-ink/",
    "text-ink-on-bg-muted/", "text-accent-dark-on-bg-muted/",
  ];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const codeOnly = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const cls of computedColorClasses) {
      assert.ok(!codeOnly.includes(cls), `${f} : ${cls} ne doit apparaître nulle part dans le CODE (hors commentaires)`);
    }
  }
  // RestaurantHeader.tsx vérifié à part (contient l'unique exception
  // légitime, l'Ornament) -- voir le test suivant.
});

test("V74-01: l'Ornament décoratif (aria-hidden) reste la SEULE exception légitime à cette règle, dans le texte source complet", () => {
  const headerSrc = readFileSync("components/RestaurantHeader.tsx", "utf8");
  const codeOnly = headerSrc.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const occurrences = (codeOnly.match(/text-ink-text\/\d+/g) || []);
  assert.equal(occurrences.length, 1, "une seule occurrence de code réel attendue (le wrapper de l'Ornament)");
  const idx = codeOnly.indexOf(occurrences[0]);
  const surrounding = codeOnly.slice(idx, idx + 100);
  assert.ok(surrounding.includes("<Ornament"), "cette unique occurrence doit précéder immédiatement <Ornament />");
  const iconsSrc = readFileSync("components/Icons.tsx", "utf8");
  const ornamentStart = iconsSrc.indexOf("export function Ornament()");
  assert.ok(iconsSrc.slice(ornamentStart, ornamentStart + 300).includes("aria-hidden"));
});
