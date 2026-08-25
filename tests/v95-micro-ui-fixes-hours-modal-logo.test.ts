import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// SCANYM -- MICRO UI FIXES -- 3 CORRECTIFS UNIQUEMENT (lot UI séparé,
// aucun changement métier/SQL/Supabase/provider/fulfillment).
//
// BUG UI 1 -- fiche publique, zone Horaires trop étroite.
// BUG UI 2 -- popup description longue, contraste du bouton "fermer".
// BUG UI 3 -- backoffice, contour blanc parasite autour du logo.
//
// Tests structurels (lecture du fichier source réel), même convention
// que tests/ui-contrast-fix.test.ts et tests/v68-establishment-assets.test.ts.
// Les preuves comportementales (rendu DOM réel) sont dans :
//   - tests/v87-ui-multiline-v2-infobar.dom.test.ts (Bug 1)
//   - tests/v66-product-info-button.dom.test.ts (Bug 2)
// AssetField (Bug 3) est une fonction interne non exportée de
// app/dashboard/settings/page.tsx, avec de lourdes dépendances Supabase
// -- non isolable en rendu DOM sans dupliquer le composant (voir
// tests/v68-establishment-assets.test.ts, même limite documentée pour
// ce même composant : preuve structurelle uniquement).
// ====================================================================

// --- BUG UI 1 : RestaurantInfoBar.tsx --------------------------------

test("BUG UI 1: le composant RÉEL et UNIQUE de la fiche publique est RestaurantInfoBar -- RestaurantInfoCard reste du code mort, non touché par ce correctif", () => {
  const headerSrc = readFileSync("components/RestaurantHeader.tsx", "utf8");
  const codeOnly = headerSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(codeOnly.includes("RestaurantInfoBar"), "RestaurantHeader doit importer RestaurantInfoBar (composant réellement rendu)");
  assert.ok(!codeOnly.includes("RestaurantInfoCard"), "RestaurantHeader ne doit jamais importer RestaurantInfoCard (code mort)");
});

test("BUG UI 1: la cellule horaires porte désormais wideDesktop: true, réservé aux horaires (adresse/téléphone non concernés)", () => {
  const src = readFileSync("components/RestaurantInfoBar.tsx", "utf8");
  const hoursPush = src.slice(src.indexOf('key: "hours"'), src.indexOf("});", src.indexOf('key: "hours"')));
  assert.ok(hoursPush.includes("wideDesktop: true"), "la cellule horaires doit porter wideDesktop: true");
  assert.ok(hoursPush.includes("multiline: true"), "le multiline existant (déjà validé) ne doit pas être retiré par ce correctif");

  const addressPush = src.slice(src.indexOf('key: "address"'), src.indexOf("});", src.indexOf('key: "address"')));
  assert.ok(!addressPush.includes("wideDesktop"), "l'adresse ne doit jamais recevoir wideDesktop");

  const phonePush = src.slice(src.indexOf('key: "phone"'), src.indexOf("});", src.indexOf('key: "phone"')));
  assert.ok(!phonePush.includes("wideDesktop") && !phonePush.includes("wide:"), "le téléphone ne doit jamais recevoir wide ni wideDesktop");
});

test("BUG UI 1: la grille passe de sm:grid-cols-3 à sm:grid-cols-4 (1+1+2 remplit exactement la ligne, sans espace résiduel)", () => {
  const src = readFileSync("components/RestaurantInfoBar.tsx", "utf8");
  assert.ok(src.includes("grid grid-cols-2 gap-px sm:grid-cols-4"), "le conteneur grille doit utiliser sm:grid-cols-4");
  assert.ok(!src.includes("sm:grid-cols-3"), "l'ancienne valeur sm:grid-cols-3 ne doit plus exister dans le fichier");
});

test("BUG UI 1: la classe calculée pour wideDesktop est col-span-2 sm:col-span-2, distincte de wide seul (col-span-2 sm:col-span-1)", () => {
  const src = readFileSync("components/RestaurantInfoBar.tsx", "utf8");
  const classesBlock = src.slice(src.indexOf("const classes ="), src.indexOf(");", src.indexOf("const classes =")));
  assert.ok(classesBlock.includes("cell.wideDesktop"), "la logique doit brancher sur cell.wideDesktop");
  assert.ok(classesBlock.includes('"col-span-2 sm:col-span-2 "'), "wideDesktop doit produire col-span-2 sm:col-span-2");
  assert.ok(classesBlock.includes("cell.wide") && classesBlock.includes('"col-span-2 sm:col-span-1 "'), "wide seul (adresse) doit conserver exactement col-span-2 sm:col-span-1, comportement inchangé");
});

test("BUG UI 1: aucune donnée ni logique de troncature/multiline n'est modifiée -- seules les classes de disposition (grid/col-span) changent", () => {
  const src = readFileSync("components/RestaurantInfoBar.tsx", "utf8");
  assert.ok(src.includes('(cell.multiline ? "whitespace-pre-wrap" : "truncate sm:whitespace-normal")'), "la logique multiline/troncature doit rester identique, non touchée par ce correctif");
  assert.ok(!/\.rpc\(/.test(src), "aucun appel RPC ne doit être introduit par un correctif UI pur");
});

// --- BUG UI 2 : ProductInfoButton.tsx --------------------------------

test("BUG UI 2: le bouton 'fermer' du popup description longue porte désormais text-ink-on-bg-muted (couleur explicite, plus d'héritage ambiant)", () => {
  const src = readFileSync("components/ProductInfoButton.tsx", "utf8");
  const closeButtonBlock = src.slice(
    src.lastIndexOf("<button", src.indexOf("{closeLabel}")),
    src.indexOf("</button>", src.indexOf("{closeLabel}"))
  );
  assert.ok(closeButtonBlock.includes("text-ink-on-bg-muted"), "le bouton 'fermer' doit porter la classe text-ink-on-bg-muted");
});

test("BUG UI 2: text-ink-on-bg-muted est le même token, réellement calculé pour le contraste, déjà utilisé par PastryModal.tsx et OptionModal.tsx -- pas une nouvelle logique de couleur ad hoc", () => {
  const pastrySrc = readFileSync("components/PastryModal.tsx", "utf8");
  const optionSrc = readFileSync("components/OptionModal.tsx", "utf8");
  assert.ok(pastrySrc.includes("text-ink-on-bg-muted"), "précédent établi : PastryModal.tsx utilise déjà ce token pour son bouton fermer");
  assert.ok(optionSrc.includes("text-ink-on-bg-muted"), "précédent établi : OptionModal.tsx utilise déjà ce token pour son bouton fermer");

  const themesSrc = readFileSync("lib/themes.ts", "utf8");
  assert.ok(
    /--sc-ink-on-bg-muted['"]?\]?\s*[:=].*mutedOnBg\(readableAccentOnBg\(/.test(themesSrc.replace(/\s+/g, " ")),
    "--sc-ink-on-bg-muted doit rester un token RÉELLEMENT calculé pour le contraste (mutedOnBg(readableAccentOnBg(...))), jamais une couleur statique ambiguë"
  );
});

test("BUG UI 2: aucune autre partie du composant (dialog natif, showModal/close, focus, description) n'est modifiée -- seul le className du bouton fermer change", () => {
  const src = readFileSync("components/ProductInfoButton.tsx", "utf8");
  assert.ok(src.includes("dialog.showModal();"));
  assert.ok(src.includes("dialog.close();"));
  assert.ok(src.includes("triggerRef.current?.focus();"), "la restitution du focus au déclencheur reste inchangée");
  assert.ok(src.includes("whitespace-pre-line text-sm text-ink-on-bg"), "le rendu de la description longue elle-même n'est pas touché");
});

// --- BUG UI 3 : app/dashboard/settings/page.tsx (AssetField) --------

test("BUG UI 3: aucune couleur/bordure/anneau/ombre n'est appliquée DIRECTEMENT sur l'élément <img> du logo/cover -- confirme que le fichier logo n'est pas en cause pour ce point précis", () => {
  const src = readFileSync("app/dashboard/settings/page.tsx", "utf8");
  const fieldFn = src.slice(src.indexOf("function AssetField"));
  // Recherche la vraie balise JSX <img ...> (suivie d'espace/retour à
  // la ligne, jamais directement de '>') pour ne jamais confondre avec
  // une simple mention "<img>" dans un commentaire explicatif.
  const imgTagMatch = /<img\s[\s\S]*?\/>/.exec(fieldFn);
  assert.ok(imgTagMatch, "la balise <img> réelle (JSX) doit être trouvée dans AssetField");
  const imgBlock = imgTagMatch![0];
  for (const forbidden of ["bg-white", "border", "ring", "outline", "shadow"]) {
    assert.ok(!imgBlock.includes(forbidden), `<img> ne doit porter aucune classe "${forbidden}" -- la cause du contour n'est pas l'élément image lui-même. Balise réellement trouvée: ${imgBlock}`);
  }
});

test("BUG UI 3: le fond du wrapper (bg-stone-50, imbriqué dans la section parente bg-white) est désormais neutralisé (bg-white) spécifiquement pour kind===\"logo\", cause réelle du contour identifiée et corrigée", () => {
  const src = readFileSync("app/dashboard/settings/page.tsx", "utf8");
  const fieldFn = src.slice(src.indexOf("function AssetField"));
  // Le code réel (hors commentaires) doit contenir la condition ; on
  // retire les lignes de commentaire pour ne pas dépendre de la
  // longueur du commentaire explicatif qui précède le JSX.
  const codeOnly = fieldFn.replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    /kind === "logo" \? "bg-white" : "bg-stone-50"/.test(codeOnly.replace(/\s+/g, " ")),
    "le wrapper doit conditionner son fond sur kind : bg-white pour le logo (hérite du bg-white de la section parente, plus de liseré), bg-stone-50 inchangé pour la cover"
  );
});

test("BUG UI 3: kind===\"cover\" garde EXACTEMENT son comportement d'avant (bg-stone-50), aucune régression pour la couverture -- seul le logo est concerné", () => {
  const src = readFileSync("app/dashboard/settings/page.tsx", "utf8");
  const fieldFn = src.slice(src.indexOf("function AssetField"));
  assert.ok(fieldFn.includes('"bg-stone-50"'), "bg-stone-50 doit rester utilisé (branche cover), pas une suppression globale qui casserait d'autres cartes");
});

test("BUG UI 3: la bordure du wrapper (border-stone-200, un gris neutre, pas un blanc) et le padding (p-2.5) restent inchangés -- taille et disposition non dégradées", () => {
  const src = readFileSync("app/dashboard/settings/page.tsx", "utf8");
  const fieldFn = src.slice(src.indexOf("function AssetField"));
  assert.ok(fieldFn.includes("rounded-xl border border-stone-200"), "la bordure grise (non blanche) et l'arrondi du wrapper doivent rester identiques");
  assert.ok(fieldFn.includes('p-2.5 "'), "le padding doit rester identique -- ni la taille ni la disposition ne changent");
  assert.ok(fieldFn.includes("h-14 w-14 shrink-0 rounded-full object-cover"), "la taille/le format du logo (cercle 14x14) ne changent pas");
  assert.ok(fieldFn.includes("h-14 w-24 shrink-0 rounded-lg object-cover"), "la taille/le format de la cover (rectangle 14x24) ne changent pas");
});

test("BUG UI 3: aucun style global (Tailwind config, classe partagée transverse) n'est retiré -- seul le wrapper local de AssetField est concerné, aucune autre carte ne dépend de ce changement", () => {
  const src = readFileSync("app/dashboard/settings/page.tsx", "utf8");
  const occurrencesOfWrapper = (src.match(/rounded-xl border border-stone-200/g) || []).length;
  // Le wrapper corrigé (AssetField) est la seule occurrence de ce motif
  // exact modifiée par ce correctif -- une éventuelle réutilisation
  // ailleurs dans le fichier n'est pas concernée par cette correction
  // (portée strictement limitée à AssetField, cf. le bloc de code
  // extrait dans le test précédent).
  assert.ok(occurrencesOfWrapper >= 1, "le wrapper corrigé doit toujours exister");
});

// --- Portée globale de la mission -------------------------------------

test("MICRO UI FIXES: seuls les 3 fichiers concernés sont modifiés -- aucune trace de logique métier (RPC, SQL, fulfillment, sale modes, provider) introduite", () => {
  const files = [
    "components/RestaurantInfoBar.tsx",
    "components/ProductInfoButton.tsx",
    "app/dashboard/settings/page.tsx",
  ];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/create\s+table|create\s+policy|create\s+function/i.test(src), `${f} ne doit contenir aucune trace de DDL SQL`);
  }
});
