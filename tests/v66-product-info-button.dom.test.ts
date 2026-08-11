import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

// ====================================================================
// Tests comportementaux React réels pour ProductInfoButton (V66),
// demandés explicitement après audit indépendant (B-04) : les tests
// statiques (lecture du fichier source) ne peuvent pas détecter une
// structure HTML invalide au rendu ni un comportement clavier/focus
// incorrect à l'exécution. Ceux-ci compilent et RENDENT le vrai
// composant dans un DOM réel (jsdom), puis simulent de vraies
// interactions (clic, Échap, Tab) et vérifient l'état réel du DOM —
// pas une chaîne de caractères dans le fichier source.
//
// Le harnais de test du projet (tests/register.mjs) utilise
// --experimental-strip-types, qui retire les annotations TypeScript
// mais NE compile PAS JSX. Ce fichier compile donc le composant réel
// avec esbuild (jsx: "automatic", même mode que Next.js) avant de
// l'importer — on teste le fichier source réel, pas une
// réimplémentation manuelle de son comportement.
//
// LIMITE CONNUE ET DOCUMENTÉE : jsdom (vérifié empiriquement, version
// 30.0.1) n'implémente pas HTMLDialogElement.showModal()/close() —
// seule la propriété `open` (reflet de l'attribut) est supportée
// nativement. Un polyfill minimal est appliqué ci-dessous, fidèle au
// comportement dont dépend le composant (bascule de l'attribut
// `open`, émission de l'événement natif 'close'). Le VRAI piège de
// focus natif du navigateur et l'arrière-plan réellement inerte
// (fournis par un vrai navigateur lors de showModal()) ne sont donc
// PAS vérifiés ici : ce test couvre la logique du composant (état
// React, gestion d'événements, structure DOM), pas le comportement
// natif du navigateur lui-même, qui reste à vérifier manuellement
// dans un vrai navigateur (limite déclarée dans le compte-rendu).
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", {
  value: window.navigator,
  configurable: true,
});
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Event = window.Event;
(globalThis as any).MouseEvent = window.MouseEvent;
(globalThis as any).KeyboardEvent = window.KeyboardEvent;
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0);
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);

// Polyfill documenté ci-dessus (limite connue de jsdom 30.0.1).
const DialogProto = (window as any).HTMLDialogElement.prototype;
DialogProto.showModal = function (this: HTMLDialogElement) {
  this.setAttribute("open", "");
};
DialogProto.close = function (this: HTMLDialogElement) {
  if (!this.hasAttribute("open")) return;
  this.removeAttribute("open");
  this.dispatchEvent(new window.Event("close"));
};

const React = await import("react");
const { createRoot } = await import("react-dom/client");

// Compilation réelle du fichier source du composant (pas une copie).
const componentPath = path.join(process.cwd(), "components/ProductInfoButton.tsx");
const source = readFileSync(componentPath, "utf8");
const { code } = await esbuild.transform(source, {
  loader: "tsx",
  jsx: "automatic",
  format: "esm",
  target: "es2022",
});
const tmpDir = mkdtempSync(path.join(process.cwd(), "tests", "tmp-dom-"));
const tmpFile = path.join(tmpDir, "ProductInfoButton.mjs");
writeFileSync(tmpFile, code);
const { default: ProductInfoButton } = await import(pathToFileURL(tmpFile).href);
// Le module compilé est chargé en mémoire (cache ESM de Node) : le
// fichier temporaire n'est plus nécessaire, nettoyage immédiat.
rmSync(tmpDir, { recursive: true, force: true });

function flush(): Promise<void> {
  // Laisse les effets React (useEffect, qui appelle showModal()/close())
  // s'exécuter après le commit — React les planifie de façon
  // asynchrone (macrotask), pas synchrone avec le rendu initial.
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function renderInto(props: {
  description: string;
  triggerLabel: string;
  closeLabel: string;
}) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(ProductInfoButton, props));
  return { container, root };
}

test("ProductInfoButton (DOM réel) : structure HTML valide -- racine <div>, <dialog> comme enfant direct, jamais dans un <span>", async () => {
  const { container, root } = renderInto({
    description: "Café, jus d'orange, pain au chocolat",
    triggerLabel: "Plus d'informations sur Formule Buongiorno",
    closeLabel: "Fermer",
  });
  await flush();

  const rootEl = container.firstElementChild!;
  assert.equal(rootEl.tagName, "DIV", "la racine rendue doit être un <div>, jamais un <span>");
  const dialog = rootEl.querySelector("dialog");
  assert.ok(dialog, "un <dialog> doit être présent dans le DOM rendu");
  assert.equal(dialog!.parentElement, rootEl, "<dialog> doit être un enfant direct du <div> racine, jamais imbriqué dans un <span>");

  root.unmount();
  container.remove();
});

test("ProductInfoButton (DOM réel) : clic sur (i) ouvre réellement le dialogue (aria-expanded + attribut open)", async () => {
  const { container, root } = renderInto({
    description: "Description longue de test",
    triggerLabel: "Plus d'informations sur Produit Test",
    closeLabel: "Fermer",
  });
  await flush();

  const button = container.querySelector("button")!;
  const dialog = container.querySelector("dialog")!;

  assert.equal(button.getAttribute("aria-expanded"), "false", "fermé initialement");
  assert.equal(dialog.hasAttribute("open"), false);

  button.click();
  await flush();

  assert.equal(button.getAttribute("aria-expanded"), "true", "aria-expanded doit refléter l'ouverture réelle");
  assert.equal(dialog.hasAttribute("open"), true, "le <dialog> doit être réellement ouvert (showModal appelé)");

  root.unmount();
  container.remove();
});

test("ProductInfoButton (DOM réel) : le bouton 'fermer' referme réellement le dialogue et restitue aria-expanded=false", async () => {
  const { container, root } = renderInto({
    description: "Description longue de test",
    triggerLabel: "Plus d'informations sur Produit Test",
    closeLabel: "Fermer",
  });
  await flush();

  const trigger = container.querySelector("button")!;
  trigger.click();
  await flush();

  const dialog = container.querySelector("dialog")!;
  assert.equal(dialog.hasAttribute("open"), true);

  const closeButton = dialog.querySelector("button")!;
  closeButton.click();
  await flush();

  assert.equal(dialog.hasAttribute("open"), false, "le dialogue doit être réellement fermé");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");

  root.unmount();
  container.remove();
});

test("ProductInfoButton (DOM réel) : le clic sur le fond (backdrop) referme le dialogue", async () => {
  const { container, root } = renderInto({
    description: "Description longue de test",
    triggerLabel: "Plus d'informations sur Produit Test",
    closeLabel: "Fermer",
  });
  await flush();

  const trigger = container.querySelector("button")!;
  trigger.click();
  await flush();

  const dialog = container.querySelector("dialog")!;
  assert.equal(dialog.hasAttribute("open"), true);

  // Un clic directement sur l'élément <dialog> (pas sur son contenu,
  // le <p> ou les boutons) simule un clic sur ::backdrop.
  dialog.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await flush();

  assert.equal(dialog.hasAttribute("open"), false, "le clic sur le fond doit refermer le dialogue");

  root.unmount();
  container.remove();
});

test("ProductInfoButton (DOM réel) : le focus revient au bouton déclencheur après fermeture", async () => {
  const { container, root } = renderInto({
    description: "Description longue de test",
    triggerLabel: "Plus d'informations sur Produit Test",
    closeLabel: "Fermer",
  });
  await flush();

  const trigger = container.querySelector("button")!;
  trigger.click();
  await flush();

  const dialog = container.querySelector("dialog")!;
  const closeButton = dialog.querySelector("button")!;
  closeButton.click();
  await flush();

  assert.equal(
    window.document.activeElement,
    trigger,
    "après fermeture, le focus doit être revenu sur le bouton (i) déclencheur"
  );

  root.unmount();
  container.remove();
});

test("ProductInfoButton (DOM réel) : le clic sur (i) ne se propage jamais à un parent (pas d'ajout au panier accidentel)", async () => {
  const parentClicks: MouseEvent[] = [];
  // Le "parent" (carte produit, dans la vraie app) doit être un
  // ANCÊTRE du conteneur où React est monté, pas le même nœud DOM :
  // stopPropagation() empêche un événement d'atteindre des nœuds
  // ancêtres pendant la phase de bulles, mais n'affecte pas d'autres
  // écouteurs déjà posés sur le nœud où l'événement a réellement lieu.
  const parent = window.document.createElement("div");
  parent.addEventListener("click", (e: Event) => parentClicks.push(e as unknown as MouseEvent));
  window.document.body.appendChild(parent);

  const mountPoint = window.document.createElement("div");
  parent.appendChild(mountPoint);

  const root = createRoot(mountPoint);
  root.render(
    React.createElement(ProductInfoButton, {
      description: "Description longue de test",
      triggerLabel: "Plus d'informations sur Produit Test",
      closeLabel: "Fermer",
    })
  );
  await flush();

  const trigger = mountPoint.querySelector("button")!;
  trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await flush();

  assert.equal(
    parentClicks.length,
    0,
    "le clic sur le bouton (i) ne doit jamais atteindre un gestionnaire de clic sur un élément ANCÊTRE (stopPropagation)"
  );

  root.unmount();
  parent.remove();
});

test("ProductInfoButton (DOM réel) : deux instances sur la même page ont des aria-controls distincts et fonctionnent indépendamment", async () => {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(
      "div",
      null,
      React.createElement(ProductInfoButton, {
        description: "Description du produit A",
        triggerLabel: "Plus d'informations sur Produit A",
        closeLabel: "Fermer",
      }),
      React.createElement(ProductInfoButton, {
        description: "Description du produit B",
        triggerLabel: "Plus d'informations sur Produit B",
        closeLabel: "Fermer",
      })
    )
  );
  await flush();

  const buttons = container.querySelectorAll("button[aria-controls]");
  assert.equal(buttons.length, 2);
  const ids = [...buttons].map((b) => b.getAttribute("aria-controls"));
  assert.notEqual(ids[0], ids[1], "les deux instances doivent avoir des aria-controls distincts (useId)");

  // Ouvrir seulement le premier ne doit pas ouvrir le second.
  (buttons[0] as HTMLElement).click();
  await flush();

  const dialogs = container.querySelectorAll("dialog");
  assert.equal(dialogs[0].hasAttribute("open"), true, "le premier dialogue doit être ouvert");
  assert.equal(dialogs[1].hasAttribute("open"), false, "le second dialogue doit rester fermé, indépendant du premier");

  root.unmount();
  container.remove();
});

test("ProductInfoButton (DOM réel) : le dialogue porte un nom accessible (aria-label non vide)", async () => {
  const { container, root } = renderInto({
    description: "Description longue de test",
    triggerLabel: "Plus d'informations sur Tiramisu",
    closeLabel: "Fermer",
  });
  await flush();

  const dialog = container.querySelector("dialog")!;
  const label = dialog.getAttribute("aria-label");
  assert.ok(label && label.length > 0, "le <dialog> doit avoir un aria-label non vide (nom accessible)");
  assert.ok(label!.includes("Tiramisu"), "le nom accessible doit identifier le produit concerné");

  root.unmount();
  container.remove();
});
