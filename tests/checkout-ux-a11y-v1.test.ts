import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// CHECKOUT UX/A11Y MICRO-LOT (issue #11, CIO) -- lisibilité des
// messages d'erreur (vraie couleur rouge, adaptée au fond réel de
// page -- personnalisable, LOT 1A) et signal visuel du bouton final
// ("Valider la commande" : gris net tant que la commande n'est pas
// validable, vert net dès que toutes les conditions le sont).
//
// Portée VOLONTAIREMENT LIMITÉE (voir rapport de livraison, issue
// #11) : les états "mode bloqué par le panier"/"livraison
// incomplète"/"zone hors périmètre" (amber, ailleurs dans
// CartPanel.tsx et FulfillmentSelector.tsx) restent inchangés à
// dessein -- ce ne sont pas des erreurs de VALIDATION de champ, mais
// des contraintes métier/disponibilité, hors du périmètre demandé
// ("messages d'erreur" + "état visuel du champ en erreur"). Ce fichier
// vérifie donc aussi, explicitement, que ces zones-là n'ont PAS été
// touchées par erreur.
//
// La validation "trop précoce" (point 3 de la demande CIO) N'EST PAS
// traitée ici : confirmée réelle (getCustomerErrors traite un champ
// vide exactement comme un champ invalide, showErrors est un flag
// global unique sans granularité par champ/blur), mais un vrai
// correctif nécessiterait un état "touched" par champ à travers
// FulfillmentSelector.tsx (~8 champs) et InvoiceRequestFields.tsx
// (~7 champs) -- au-delà d'un micro-ajustement visuel, signalé
// explicitement au CIO plutôt qu'élargi sans arbitrage (voir le
// rapport de livraison), conformément à la consigne littérale reçue.
// ====================================================================

const colorContrastSrc = readFileSync("lib/color-contrast.ts", "utf8");
const themesSrc = readFileSync("lib/themes.ts", "utf8");
const tailwindConfigSrc = readFileSync("tailwind.config.ts", "utf8");
const fulfillmentSelectorSrc = readFileSync("components/FulfillmentSelector.tsx", "utf8");
const invoiceRequestFieldsSrc = readFileSync("components/InvoiceRequestFields.tsx", "utf8");
const cartPanelSrc = readFileSync("components/CartPanel.tsx", "utf8");

// --------------------------------------------------------------------
// errorTextOnBg -- garantie de contraste WCAG AA (4.5:1) contre tout
// fond connu (5 thèmes par défaut, fond personnalisé sombre réel déjà
// en production -- TRACKING_SURFACE_COLORS --, extrêmes blanc/noir).
// --------------------------------------------------------------------

test("errorTextOnBg : reste rouge ET lisible (>= 4.5:1) sur les 5 thèmes par défaut", async () => {
  const { errorTextOnBg, contrastRatio } = await import("../lib/color-contrast.ts");
  const { THEMES } = await import("../lib/themes.ts");
  for (const [name, theme] of Object.entries(THEMES)) {
    const color = errorTextOnBg((theme as { bg: string }).bg);
    const ratio = contrastRatio(color, (theme as { bg: string }).bg);
    assert.ok(ratio >= 4.5, `thème '${name}': contraste insuffisant (${ratio.toFixed(2)}:1) pour ${color} sur ${(theme as { bg: string }).bg}`);
    // Doit rester identifiable comme "rouge" sur ces fonds clairs
    // historiques -- jamais un repli noir/blanc pour un cas aussi
    // courant (voir le commentaire de errorTextOnBg).
    assert.ok(/^#(99|F8)/i.test(color), `thème '${name}': devrait rester une teinte rouge, pas un repli noir/blanc (${color})`);
  }
});

test("errorTextOnBg : reste lisible (>= 4.5:1) sur le fond sombre réel déjà en production (tracking, #0F0F10)", async () => {
  const { errorTextOnBg, contrastRatio } = await import("../lib/color-contrast.ts");
  const { TRACKING_SURFACE_COLORS } = await import("../lib/themes.ts");
  const bg = TRACKING_SURFACE_COLORS.bg as string;
  const color = errorTextOnBg(bg);
  const ratio = contrastRatio(color, bg);
  assert.ok(ratio >= 4.5, `contraste insuffisant (${ratio.toFixed(2)}:1) pour ${color} sur ${bg}`);
});

test("errorTextOnBg : cas Au Lait Cru (bg=#000000, même cas que LOT 1A) -- rouge clair choisi, contraste réel vérifié", async () => {
  const { errorTextOnBg, contrastRatio } = await import("../lib/color-contrast.ts");
  const color = errorTextOnBg("#000000");
  assert.ok(contrastRatio(color, "#000000") >= 4.5);
});

test("errorTextOnBg : extrêmes blanc et noir purs, toujours >= 4.5:1", async () => {
  const { errorTextOnBg, contrastRatio } = await import("../lib/color-contrast.ts");
  for (const bg of ["#FFFFFF", "#000000"]) {
    const color = errorTextOnBg(bg);
    assert.ok(contrastRatio(color, bg) >= 4.5, `${bg}: ${contrastRatio(color, bg).toFixed(2)}:1`);
  }
});

test("errorTextOnBg : fond gris moyen adversarial -- ne sacrifie jamais la lisibilité pour garder le rouge (repli noir/blanc du garde-fou)", async () => {
  const { errorTextOnBg, contrastRatio, readableTextColor } = await import("../lib/color-contrast.ts");
  const bg = "#808080";
  const color = errorTextOnBg(bg);
  // Aucun des deux rouges ne peut atteindre 4.5:1 sur un gris moyen --
  // le garde-fou doit alors reprendre la main (noir/blanc), jamais
  // renvoyer un rouge illisible en silence.
  assert.equal(color, readableTextColor(bg));
  assert.ok(contrastRatio(color, bg) >= 4.5);
});

// --------------------------------------------------------------------
// themeStyle() -- --sc-error posée pour tout thème, calculée (jamais
// une valeur littérale indépendante du bg réel), même mécanisme que
// --sc-ink-on-bg / --sc-accent-dark-on-bg déjà en place.
// --------------------------------------------------------------------

test("themeStyle() : --sc-error posée et égale à errorTextOnBg(bg réellement utilisé), avec et sans surcharge", async () => {
  const { themeStyle } = await import("../lib/themes.ts");
  const { errorTextOnBg } = await import("../lib/color-contrast.ts");

  const defaultStyle = themeStyle("cafe");
  assert.equal(defaultStyle["--sc-error"], errorTextOnBg(defaultStyle["--sc-bg"]));

  const overridden = themeStyle("cafe", { bg: "#0F0F10" });
  assert.equal(overridden["--sc-bg"], "#0F0F10");
  assert.equal(overridden["--sc-error"], errorTextOnBg("#0F0F10"));
  // Doit réellement changer par rapport au défaut (preuve que la
  // valeur dépend bien du fond réel, pas une constante gelée).
  assert.notEqual(overridden["--sc-error"], defaultStyle["--sc-error"]);
});

test("tailwind.config.ts : la couleur 'error' est mappée sur var(--sc-error, ...)", () => {
  assert.match(tailwindConfigSrc, /error:\s*"var\(--sc-error,\s*#[0-9A-Fa-f]{6}\)"/);
});

// --------------------------------------------------------------------
// Champs de formulaire (FulfillmentSelector / InvoiceRequestFields) --
// bordure rouge FIXE (le champ reste toujours sur bg-white, quel que
// soit le thème -- voir le commentaire dans les composants), message
// d'erreur en text-error (adaptatif, rendu sur le fond de PAGE
// personnalisable).
// --------------------------------------------------------------------

for (const [label, src] of [
  ["FulfillmentSelector.tsx", fulfillmentSelectorSrc],
  ["InvoiceRequestFields.tsx", invoiceRequestFieldsSrc],
] as const) {
  test(`${label} : le composant Field n'utilise plus text-amber-700/border-amber-400 pour l'état d'erreur`, () => {
    assert.ok(!src.includes('"border-amber-400"'), `${label}: border-amber-400 résiduel`);
    assert.ok(!/text-amber-700">\{error\}/.test(src), `${label}: text-amber-700 résiduel sur le message d'erreur`);
  });

  test(`${label} : bordure d'erreur fixe (red-600, contraste vérifié >= 4.5:1 sur bg-white) et message adaptatif (text-error)`, () => {
    assert.ok(src.includes('"border-red-600"'), `${label}: border-red-600 attendu`);
    assert.ok(/text-error">\{error\}/.test(src), `${label}: text-error attendu sur le message d'erreur`);
  });
}

test("FulfillmentSelector.tsx : sélecteur de ville (cas one-off, hors composant Field) aligné lui aussi", () => {
  assert.ok(fulfillmentSelectorSrc.includes('err("city") ? "border-red-600"'));
  assert.ok(fulfillmentSelectorSrc.includes('text-error">{err("city")}'));
});

test("FulfillmentSelector.tsx : message du groupe one_of (fieldOneOfRequired) en text-error", () => {
  const idx = fulfillmentSelectorSrc.indexOf("fieldOneOfRequired");
  assert.ok(idx >= 0, "clé fieldOneOfRequired introuvable");
  const before = fulfillmentSelectorSrc.slice(Math.max(0, idx - 120), idx);
  assert.ok(before.includes("text-error"), "le message one_of doit utiliser text-error");
  assert.ok(!before.includes("text-amber-700"), "le message one_of ne doit plus utiliser text-amber-700");
});

test("FulfillmentSelector.tsx : les zones HORS PÉRIMÈTRE (statut livraison/mode bloqué par le panier, pas des erreurs de champ) restent intactes -- amber inchangé", () => {
  // "Choisir le retrait à la place" (bouton à l'intérieur du bandeau
  // de statut livraison, piloté par getFulfillmentToneClass -- pas une
  // erreur de validation de champ) : volontairement laissé tel quel.
  assert.ok(fulfillmentSelectorSrc.includes("border-amber-700/30 bg-white px-3 py-2 text-base font-semibold text-amber-900"));
});

test("CartPanel.tsx : les zones HORS PÉRIMÈTRE (mode bloqué par le panier / livraison incomplète, pas des erreurs de champ) restent intactes -- amber inchangé", () => {
  assert.ok(cartPanelSrc.includes('cursor-not-allowed border-amber-200 bg-amber-50/60 text-amber-900/70'), "bouton de mode bloqué par le panier : amber inchangé (hors périmètre)");
  assert.ok(cartPanelSrc.includes('border-amber-500 bg-amber-50 text-amber-900'), "bouton de mode 'livraison incomplète' : amber inchangé (hors périmètre)");
  assert.ok(cartPanelSrc.includes('bg-amber-50 p-2.5 text-xs text-amber-900'), "bandeau 'mode bloqué par le panier' : amber inchangé (hors périmètre)");
});

// --------------------------------------------------------------------
// CartPanel.tsx -- note de commande (pastille opaque, auto-suffisante,
// couple fixe red-500/red-50, PAS var(--sc-error) -- le fond réel de
// cette pastille est bg-red-50, pas --sc-bg).
// --------------------------------------------------------------------

test("CartPanel.tsx : note de commande invalide -- pastille rouge fixe (border-red-500/bg-red-50), compteur en text-error (fond de page ambiant)", () => {
  assert.ok(cartPanelSrc.includes('"border-red-500 bg-red-50"'));
  assert.ok(cartPanelSrc.includes('font-semibold text-error'));
  // Vérifie précisément que c'est bien le BLOC DU TEXTAREA (noteState)
  // qui a changé -- une recherche large de "border-amber-500
  // bg-amber-50" collision­nerait avec le bouton "livraison
  // incomplète" (hors périmètre, ligne ~666, qui commence par la même
  // sous-chaîne suivie de " text-amber-900").
  assert.ok(
    !cartPanelSrc.includes('noteState.isValid\n                      ? "border-espresso/10"\n                      : "border-amber-500 bg-amber-50"'),
    "ancienne pastille amber du textarea résiduelle"
  );
});

// --------------------------------------------------------------------
// CartPanel.tsx -- bandeaux d'erreur de soumission (pastilles opaques
// fixes, remplacent amber par une vraie couleur d'erreur).
// --------------------------------------------------------------------

test("CartPanel.tsx : bandeaux submitError / invoiceRequestError -- vraie couleur d'erreur (bg-red-50/text-red-800), plus amber", () => {
  const occurrences = [...cartPanelSrc.matchAll(/bg-red-50 p-3 text-sm text-red-800/g)].length;
  assert.equal(occurrences, 2, "submitError et invoiceRequestError doivent tous deux utiliser la même pastille rouge fixe");
  assert.ok(!cartPanelSrc.includes('bg-amber-50 p-3 text-sm text-amber-900'), "ancien bandeau amber résiduel");
});

// --------------------------------------------------------------------
// CartPanel.tsx -- bouton "Valider la commande" : gris net tant que
// non validable, vert net (générique, jamais la couleur de marque
// WhatsApp) dès que toutes les conditions sont réunies.
// --------------------------------------------------------------------

function submitButtonWindow(): string {
  const anchor = cartPanelSrc.indexOf("onClick={requestOrderSubmission}");
  assert.ok(anchor >= 0, "bouton de soumission introuvable");
  const start = cartPanelSrc.lastIndexOf("<button", anchor);
  const end = cartPanelSrc.indexOf("</button>", anchor);
  assert.ok(start >= 0 && end > start);
  return cartPanelSrc.slice(start, end);
}

test("CartPanel.tsx : le bouton 'Valider la commande' devient vert (green-700) uniquement quand isSubmitting est faux ET (CGV non exigées OU acceptées)", () => {
  const win = submitButtonWindow();
  assert.ok(win.includes("disabled={isSubmitting || (cgvEnforced && !cgvAccepted)}"), "condition disabled inchangée (CGV + soumission en cours)");
  assert.ok(win.includes("bg-green-700"), "vert attendu à l'état validable");
  assert.ok(win.includes("bg-stone-300"), "gris net attendu à l'état non validable");
  // Vérifie précisément que c'est la branche "non validable" (même
  // condition que `disabled`) qui produit le gris, et la branche
  // opposée qui produit le vert -- pas l'inverse.
  assert.ok(
    win.includes('(isSubmitting || (cgvEnforced && !cgvAccepted)\n                      ? "cursor-not-allowed bg-stone-300 text-stone-700"\n                      : "bg-green-700 text-white")'),
    "la condition non-validable doit produire le gris, la condition validable le vert"
  );
});

test("CartPanel.tsx : le bouton 'Valider la commande' ne référence plus la couleur de marque WhatsApp (#25D366) -- mandat 'aucune mention WhatsApp -- couleur' préservé pour le canal désactivé", () => {
  const win = submitButtonWindow();
  // Recherche la classe Tailwind LITTÉRALE (avec crochets), pas une
  // sous-chaîne "25D366" nue -- le commentaire au-dessus de ce même
  // bouton mentionne volontairement "(#25D366)" en PROSE pour
  // expliquer pourquoi cette teinte n'est plus utilisée ici ; chercher
  // la classe réelle évite toute fausse collision avec ce commentaire.
  assert.ok(!win.includes("bg-[#25D366]"), "le bouton final ne doit plus dépendre de la classe de couleur de marque WhatsApp");
  assert.ok(!win.includes('"bg-espresso"') && !win.includes("bg-espresso/60"), "le bouton final ne doit plus utiliser la couleur de marque établissement pour son état validable");
});

test("CartPanel.tsx : le bouton de reprise de facture (action DIFFÉRENTE, hors périmètre demandé) garde sa couleur existante -- non touché", () => {
  const anchor = cartPanelSrc.indexOf("onRetryInvoiceRequest}");
  assert.ok(anchor >= 0, "bouton de reprise de facture introuvable");
  const start = cartPanelSrc.lastIndexOf("<button", anchor);
  const end = cartPanelSrc.indexOf("</button>", anchor);
  const win = cartPanelSrc.slice(start, end);
  assert.ok(win.includes("bg-[#25D366]") || win.includes("bg-espresso"), "le bouton de reprise de facture doit garder son style de marque existant, inchangé par ce lot");
});

test("CartPanel.tsx : whatsappNotice reste affiché avant le bouton (non-régression V64, structure inchangée)", () => {
  const noticeIndex = cartPanelSrc.indexOf('t("whatsappNotice")');
  const buttonIndex = cartPanelSrc.indexOf("onClick={requestOrderSubmission}");
  assert.ok(noticeIndex >= 0 && buttonIndex >= 0);
  assert.ok(noticeIndex < buttonIndex, "le message doit toujours précéder le bouton dans le JSX");
});
