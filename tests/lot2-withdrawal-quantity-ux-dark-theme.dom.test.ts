import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// LOT 2 -- WITHDRAWAL QUANTITY UX + DARK-THEME "RETOUR" CONTRAST FIX.
// Issue #11, mandat CIO/Ravel #5873108024, points 4/5/8. Voir l'en-tête
// de components/WithdrawalPanel.tsx pour le détail du correctif.
//
// Fichier AUTONOME (même convention que tests/lot1-withdrawal-cookie-
// path-fix.test.ts) : ses propres fixtures, son propre harnais esbuild
// + jsdom, aucune dépendance vers tests/online-withdrawal-tracking-v1-
// dom.test.ts (dont les 7 tests existants restent, eux, inchangés et
// verts -- vérifié séparément).
//
// Couverture :
//   [QTY-1]      remainingQuantity === 1 -> AUCUN sélecteur de quantité
//                rendu ; cocher la ligne suffit, signifie 1/1 (point 4).
//   [QTY-N-EDIT] remainingQuantity > 1 -> vider le champ puis retaper
//                une nouvelle valeur ne désactive JAMAIS le champ en
//                cours de frappe (reproduction exacte du défaut corrigé,
//                point 5).
//   [QTY-N-CLAMP] une saisie dépassant le reste rétractable est bornée.
//   [QTY-N-UNCHECK] décocher une ligne éditée remet sa quantité à 0 ;
//                la recocher repart de 1 (jamais un résidu de saisie).
//   [QTY-N-ZERO]  RÉGRESSION (audit Chateaubriand/Ravel, commentaires
//                5876097341/5876134468) : taper "0" (valeur VALIDÉE,
//                jamais un état de saisie intermédiaire) dans le champ
//                de quantité désélectionne la ligne -- règle approuvée
//                mandat #5873108024, littéral « 0 = unselected » --
//                exactement comme décocher la case, et la ligne est
//                omise du récapitulatif/de l'envoi.
//   [DARK-RETOUR] les deux boutons « Retour » (sélection et
//                récapitulatif) portent explicitement text-ink-on-bg
//                (point 8), comme le bouton d'entrée déjà correct.
// ====================================================================

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/track/55555555-5555-4555-8555-555555555555",
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Event = window.Event;
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const REPO_ROOT = process.cwd();

const resolvePlugin: esbuild.Plugin = {
  name: "scanym-alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      const base = path.join(REPO_ROOT, args.path.slice(2));
      const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p));
      return { path: candidate ?? base };
    });
  },
};

const built = await esbuild.build({
  stdin: {
    contents: `export { default as WithdrawalPanel } from "@/components/WithdrawalPanel.tsx";`,
    resolveDir: REPO_ROOT,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  plugins: [resolvePlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-lot2wd-"));
const tmpFile = path.join(tmpDir, "WithdrawalPanel.mjs");
writeFileSync(tmpFile, built.outputFiles[0]!.text);
const { WithdrawalPanel } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------

const ORDER_ID = "55555555-5555-4555-8555-555555555555";
const LINE_SINGLE = "66666666-6666-4666-8666-666666666666"; // remainingQuantity === 1
const LINE_MULTI = "77777777-7777-4777-8777-777777777777"; // remainingQuantity === 12, ordered === 15

const OPTIONS = [
  {
    orderItemId: LINE_SINGLE,
    itemName: "Faisselle de la ferme",
    optionName: null,
    orderedQuantity: 1,
    remainingQuantity: 1,
  },
  {
    orderItemId: LINE_MULTI,
    itemName: "Yaourt nature",
    optionName: null,
    orderedQuantity: 15,
    remainingQuantity: 12,
  },
];

// ------------------------------------------------------------------
// Harnais
// ------------------------------------------------------------------

let fetchCalls: Array<{ url: string; body: any }> = [];
(globalThis as any).fetch = (url: any, init: any) => {
  fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
  return Promise.resolve({
    ok: true,
    json: async () => ({
      ok: true,
      withdrawalRequestId: "88888888-8888-4888-8888-888888888888",
      requestedAt: "2026-09-28T10:00:00.000Z",
      acknowledgementStatus: "unavailable_no_channel",
    }),
  });
};

async function mount(options: unknown[] = OPTIONS) {
  fetchCalls = [];
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(WithdrawalPanel, {
        orderId: ORDER_ID,
        orderNumber: 4102,
        options,
        lang: "fr",
      })
    );
  });
  return { container, root };
}

function q<T extends Element = Element>(container: Element, selector: string): T | null {
  return container.querySelector(selector) as T | null;
}

async function click(el: Element | null) {
  assert.ok(el, "élément cliquable attendu");
  await act(async () => {
    (el as any).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

async function check(el: Element | null, checked: boolean) {
  assert.ok(el, "case à cocher attendue");
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked")!.set!;
  await act(async () => {
    setter.call(input, checked);
    input.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
}

async function setInputValue(el: Element | null, value: string) {
  assert.ok(el, "champ attendu");
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

// ==================================================================
// [QTY-1] Une seule unité rétractable -> aucun sélecteur de quantité
// ==================================================================
test("[QTY-1] remainingQuantity === 1 : aucun input numérique, cocher suffit, signifie 1/1", async () => {
  const { container } = await mount();
  await click(q(container, '[data-withdrawal-action="open"]'));

  // Aucun sélecteur de quantité pour la ligne à unité unique.
  assert.equal(q(container, `[data-withdrawal-quantity="${LINE_SINGLE}"]`), null);

  const line = q(container, `[data-withdrawal-line="${LINE_SINGLE}"]`)!;
  assert.ok(line, "la ligne existe");
  // Ni "Quantité", ni "/ 1" ne doivent apparaître pour cette ligne.
  assert.ok(!line.textContent!.includes("/ 1"));

  await check(q(line, 'input[type="checkbox"]'), true);
  await click(q(container, '[data-withdrawal-action="continue"]'));

  // Récapitulatif : 1 × Faisselle de la ferme.
  const reviewLine = q(container, `[data-withdrawal-review-line="${LINE_SINGLE}"]`);
  assert.ok(reviewLine, "ligne de récapitulatif présente");
  assert.equal(reviewLine!.textContent!.trim(), "1 × Faisselle de la ferme");
});

// ==================================================================
// [QTY-N-EDIT] Vider puis retaper ne désactive jamais le champ
// ==================================================================
test("[QTY-N-EDIT] vider le champ pour retaper une nouvelle valeur ne bloque jamais la saisie", async () => {
  const { container } = await mount();
  await click(q(container, '[data-withdrawal-action="open"]'));

  const line = q(container, `[data-withdrawal-line="${LINE_MULTI}"]`)!;
  await check(q(line, 'input[type="checkbox"]'), true);

  const qtyInput = () => q<HTMLInputElement>(container, `[data-withdrawal-quantity="${LINE_MULTI}"]`)!;
  assert.equal(qtyInput().value, "1");
  assert.equal(qtyInput().disabled, false);

  // Défaut AVANT correctif : vider le champ (backspace complet) faisait
  // passer la quantité RETENUE à 0, ce qui désactivait le champ
  // instantanément -- impossible de taper le chiffre suivant. Reproduit
  // ici : vider, puis vérifier qu'on peut ENCORE taper.
  await setInputValue(qtyInput(), "");
  assert.equal(qtyInput().disabled, false, "le champ ne doit jamais se désactiver pendant la frappe");
  // La case reste cochée : la quantité RETENUE n'a pas été touchée par
  // le champ vide, seule la case à cocher peut désélectionner.
  assert.equal(q<HTMLInputElement>(line, 'input[type="checkbox"]')!.checked, true);

  // On tape maintenant "9" puis "12" (double chiffre) dans le champ
  // laissé vide -- doit aboutir à la valeur tapée, bornée si besoin.
  await setInputValue(qtyInput(), "9");
  assert.equal(qtyInput().value, "9");
  await setInputValue(qtyInput(), "12");
  assert.equal(qtyInput().value, "12");

  await click(q(container, '[data-withdrawal-action="continue"]'));
  const reviewLine = q(container, `[data-withdrawal-review-line="${LINE_MULTI}"]`);
  assert.equal(reviewLine!.textContent!.trim(), "12 × Yaourt nature");
});

// ==================================================================
// [QTY-N-CLAMP] Une saisie au-delà du reste rétractable est bornée
// ==================================================================
test("[QTY-N-CLAMP] une quantité saisie au-delà du reste rétractable est bornée au reste", async () => {
  const { container } = await mount();
  await click(q(container, '[data-withdrawal-action="open"]'));
  const line = q(container, `[data-withdrawal-line="${LINE_MULTI}"]`)!;
  await check(q(line, 'input[type="checkbox"]'), true);

  const qtyInput = q<HTMLInputElement>(container, `[data-withdrawal-quantity="${LINE_MULTI}"]`)!;
  // remainingQuantity = 12 ; on tape 99.
  await setInputValue(qtyInput, "99");
  assert.equal(qtyInput.value, "12", "bornée au reste rétractable, jamais la valeur brute tapée");
});

// ==================================================================
// [QTY-N-UNCHECK] Décocher réinitialise, recocher repart de 1
// ==================================================================
test("[QTY-N-UNCHECK] décocher une ligne éditée remet la quantité à 0 ; recocher repart de 1", async () => {
  const { container } = await mount();
  await click(q(container, '[data-withdrawal-action="open"]'));
  const line = q(container, `[data-withdrawal-line="${LINE_MULTI}"]`)!;
  const checkbox = q<HTMLInputElement>(line, 'input[type="checkbox"]')!;

  await check(checkbox, true);
  await setInputValue(q(container, `[data-withdrawal-quantity="${LINE_MULTI}"]`), "7");
  assert.equal(q<HTMLInputElement>(container, `[data-withdrawal-quantity="${LINE_MULTI}"]`)!.value, "7");

  await check(checkbox, false);
  assert.equal(checkbox.checked, false);

  await check(checkbox, true);
  assert.equal(
    q<HTMLInputElement>(container, `[data-withdrawal-quantity="${LINE_MULTI}"]`)!.value,
    "1",
    "aucun résidu de la précédente saisie après un cycle décocher/recocher"
  );
});

// ==================================================================
// [QTY-N-ZERO] Taper "0" (valeur validée) désélectionne la ligne --
// RÉGRESSION mandat #5873108024 « 0 = unselected » (audit
// Chateaubriand/Ravel, commentaires 5876097341/5876134468).
// ==================================================================
test("[QTY-N-ZERO] taper 0 dans le champ de quantité désélectionne la ligne et l'omet du récapitulatif", async () => {
  const { container } = await mount();
  await click(q(container, '[data-withdrawal-action="open"]'));

  // Deux lignes sélectionnées : LINE_SINGLE (sans sélecteur de
  // quantité) reste sélectionnée tout du long, ce qui permet de
  // vérifier que SEULE la ligne LINE_MULTI est désélectionnée par la
  // saisie de "0", jamais un effet de bord sur l'autre ligne ni sur le
  // bouton "Continuer" (qui resterait activé grâce à LINE_SINGLE).
  await check(q(container, `[data-withdrawal-line="${LINE_SINGLE}"] input[type="checkbox"]`), true);
  const multiLine = q(container, `[data-withdrawal-line="${LINE_MULTI}"]`)!;
  const multiCheckbox = q<HTMLInputElement>(multiLine, 'input[type="checkbox"]')!;
  await check(multiCheckbox, true);

  const qtyInput = () => q<HTMLInputElement>(container, `[data-withdrawal-quantity="${LINE_MULTI}"]`)!;
  assert.equal(qtyInput().value, "1");

  // Valeur VALIDÉE (jamais un état de saisie intermédiaire -- "0" est
  // un nombre fini dès la première frappe, contrairement à "" qui
  // passe par le tampon de saisie brute) : doit désélectionner la
  // ligne exactement comme décocher la case.
  await setInputValue(qtyInput(), "0");

  assert.equal(multiCheckbox.checked, false, "la case se décoche quand la quantité validée tombe à 0");
  assert.equal(qtyInput().disabled, true, "le champ se désactive, comme pour toute ligne désélectionnée");

  // LINE_SINGLE reste sélectionnée -> le bouton "Continuer" reste actif
  // et seule LINE_SINGLE doit apparaître au récapitulatif.
  await click(q(container, '[data-withdrawal-action="continue"]'));
  assert.ok(q(container, `[data-withdrawal-review-line="${LINE_SINGLE}"]`), "LINE_SINGLE reste au récapitulatif");
  assert.equal(
    q(container, `[data-withdrawal-review-line="${LINE_MULTI}"]`),
    null,
    "LINE_MULTI, désélectionnée par la saisie de 0, est omise du récapitulatif"
  );
});

// ==================================================================
// [DARK-RETOUR] Contraste du bouton « Retour » en thème sombre
// ==================================================================
test("[DARK-RETOUR] les boutons « Retour » (sélection et récapitulatif) portent text-ink-on-bg", async () => {
  const { container } = await mount();
  await click(q(container, '[data-withdrawal-action="open"]'));

  const backButtons = [...container.querySelectorAll("button")].filter(
    (b) => b.textContent!.trim() === "Retour"
  );
  assert.equal(backButtons.length, 1, "un seul bouton « Retour » visible à l'étape sélection");
  assert.ok(
    backButtons[0]!.className.includes("text-ink-on-bg"),
    "le bouton « Retour » (sélection) doit fixer explicitement sa couleur de texte"
  );

  await check(q(container, `[data-withdrawal-line="${LINE_SINGLE}"] input[type="checkbox"]`), true);
  await click(q(container, '[data-withdrawal-action="continue"]'));

  const reviewBackButtons = [...container.querySelectorAll("button")].filter(
    (b) => b.textContent!.trim() === "Retour"
  );
  assert.equal(reviewBackButtons.length, 1, "un seul bouton « Retour » visible à l'étape récapitulatif");
  assert.ok(
    reviewBackButtons[0]!.className.includes("text-ink-on-bg"),
    "le bouton « Retour » (récapitulatif) doit fixer explicitement sa couleur de texte"
  );
});
