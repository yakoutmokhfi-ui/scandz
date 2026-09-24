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
// Scanym — ONLINE WITHDRAWAL / RETRACTATION FOUNDATION v1 (Claude Monet)
// Parcours CLIENT de rétractation, rendu POUR DE VRAI (esbuild + jsdom).
//
// Ce fichier prouve les points I, J, K, L et N de la matrice du mandat,
// ainsi que l'addendum UX du CIO :
//
//   I. aucune ligne éligible  -> AUCUN point d'entrée dans le DOM ;
//   J. au moins une ligne     -> action nommée « Exercer mon droit de
//                                rétractation » (jamais « Retour »,
//                                jamais « Besoin d'aide ») ;
//   K. l'écran de sélection n'affiche QUE les lignes éligibles -- une
//      ligne non éligible n'apparaît pas, pas même désactivée ;
//   L. quantité partielle possible, bornée par le reste rétractable ;
//   N. ouvrir l'écran et sélectionner n'écrivent RIEN : seule
//      « Confirmer la rétractation » appelle l'API, et un double clic
//      ne produit qu'UN appel (même client_request_id).
//
// Fixtures : Victor / Hugo (addendum UX §I).
// ====================================================================

// React n'applique ses mises à jour de façon synchrone dans `act`
// que lorsque l'environnement se déclare comme environnement de test.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/track/11111111-1111-4111-8111-111111111111",
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-wdtrack-"));
const tmpFile = path.join(tmpDir, "WithdrawalPanel.mjs");
writeFileSync(tmpFile, built.outputFiles[0]!.text);
const { WithdrawalPanel } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

// ------------------------------------------------------------------
// Fixtures — Victor / Hugo
// ------------------------------------------------------------------

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const LINE_VICTOR = "22222222-2222-4222-8222-222222222222";
const LINE_HUGO = "33333333-3333-4333-8333-333333333333";

/**
 * Le serveur ne transmet au composant QUE des lignes éligibles : c'est
 * la RPC, sur l'instantané immuable, qui les a filtrées. Une ligne non
 * éligible n'est donc PAS « une ligne désactivée » ici -- elle n'existe
 * tout simplement pas dans la liste (point K).
 */
const OPTIONS_ELIGIBLES = [
  {
    orderItemId: LINE_VICTOR,
    itemName: "Coffret de Victor",
    optionName: null,
    orderedQuantity: 3,
    remainingQuantity: 3,
  },
  {
    orderItemId: LINE_HUGO,
    itemName: "Tomme de Hugo",
    optionName: "Affinage 6 mois",
    orderedQuantity: 1,
    remainingQuantity: 1,
  },
];

// ------------------------------------------------------------------
// Harnais
// ------------------------------------------------------------------

let fetchCalls: Array<{ url: string; body: any }> = [];
let fetchImpl: (url: string, init: any) => Promise<any> = async () => ({
  ok: true,
  json: async () => ({
    ok: true,
    withdrawalRequestId: "44444444-4444-4444-8444-444444444444",
    requestedAt: "2026-06-25T10:32:00.000Z",
    acknowledgementStatus: "unavailable_no_channel",
  }),
});

(globalThis as any).fetch = (url: any, init: any) => {
  fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
  return fetchImpl(String(url), init);
};

async function mount(options: unknown[]) {
  fetchCalls = [];
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(WithdrawalPanel, {
        orderId: ORDER_ID,
        orderNumber: 1842,
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

/**
 * React remplace le setter natif de `value` : pour qu'un changement
 * simulé atteigne bien l'état du composant, on écrit par le setter du
 * prototype puis on émet l'évènement d'input, comme le ferait un
 * vrai navigateur.
 */
async function setInputValue(el: Element | null, value: string) {
  assert.ok(el, "champ attendu");
  const input = el as HTMLInputElement;
  const proto = input.type === "checkbox" ? window.HTMLInputElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
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

// ==================================================================
// I. Aucune ligne éligible -> rien dans le DOM
// ==================================================================
test("I — sans ligne éligible, aucun point d'entrée n'existe dans le DOM", async () => {
  const { container } = await mount([]);
  assert.equal(container.textContent!.trim(), "", "le bloc n'est pas rendu du tout");
  assert.equal(q(container, '[data-withdrawal-action="open"]'), null);
  // Ni rendu ni masqué : la chaîne n'apparaît nulle part.
  assert.ok(!container.innerHTML.includes("rétractation"));
  assert.equal(fetchCalls.length, 0, "aucun appel réseau");
});

// ==================================================================
// J. Au moins une ligne éligible -> action statutaire nommée
// ==================================================================
test("J — avec une ligne éligible, l'action porte le libellé statutaire exact", async () => {
  const { container } = await mount(OPTIONS_ELIGIBLES);
  const entry = q(container, '[data-withdrawal-action="open"]');
  assert.ok(entry, "point d'entrée présent");
  assert.equal(entry!.textContent!.trim(), "Exercer mon droit de rétractation");
  // Addendum UX : jamais un libellé générique de service après-vente.
  const label = entry!.textContent!.toLowerCase();
  assert.ok(!/^retour/.test(label.trim()), "jamais « Retour » seul");
  assert.ok(!label.includes("besoin d'aide"), "jamais « Besoin d'aide »");
  assert.equal(fetchCalls.length, 0, "afficher l'entrée n'écrit rien");
});

// ==================================================================
// K. L'écran de sélection n'affiche QUE les lignes éligibles
// ==================================================================
test("K — la sélection liste exactement les lignes éligibles, et la référence de commande", async () => {
  const { container } = await mount(OPTIONS_ELIGIBLES);
  await click(q(container, '[data-withdrawal-action="open"]'));

  assert.ok(q(container, '[data-withdrawal-step="selection"]'), "écran de sélection ouvert");
  const lines = container.querySelectorAll("[data-withdrawal-line]");
  assert.equal(lines.length, 2, "une ligne par option éligible, pas une de plus");
  const ids = [...lines].map((li) => li.getAttribute("data-withdrawal-line"));
  assert.deepEqual(ids, [LINE_VICTOR, LINE_HUGO]);

  const text = container.textContent!;
  assert.ok(text.includes("Coffret de Victor"));
  assert.ok(text.includes("Tomme de Hugo"));
  // Addendum UX : la référence de commande est rappelée au client.
  assert.ok(/1842/.test(text), "référence de commande affichée");
  // Aucune ligne non éligible : le composant ne reçoit et n'affiche
  // rien d'autre -- aucune case désactivée « pour information ».
  const disabledCheckboxes = [...container.querySelectorAll('input[type="checkbox"]')].filter(
    (input) => (input as HTMLInputElement).disabled
  );
  assert.equal(disabledCheckboxes.length, 0, "aucune ligne non éligible affichée, même grisée");
  assert.equal(fetchCalls.length, 0, "ouvrir la sélection n'écrit rien");
});

// ==================================================================
// L. Quantité partielle
// ==================================================================
test("L — la quantité est partielle et bornée par le reste rétractable", async () => {
  const { container } = await mount(OPTIONS_ELIGIBLES);
  await click(q(container, '[data-withdrawal-action="open"]'));

  const line = q(container, `[data-withdrawal-line="${LINE_VICTOR}"]`)!;
  const checkbox = q<HTMLInputElement>(line, 'input[type="checkbox"]');
  const quantity = q<HTMLInputElement>(container, `[data-withdrawal-quantity="${LINE_VICTOR}"]`);
  assert.ok(quantity, "champ quantité présent");
  assert.equal(quantity!.disabled, true, "quantité inerte tant que la ligne n'est pas choisie");
  assert.equal(quantity!.getAttribute("max"), "3", "borne = reste rétractable de la ligne");

  await check(checkbox, true);
  assert.equal(q<HTMLInputElement>(container, `[data-withdrawal-quantity="${LINE_VICTOR}"]`)!.disabled, false);

  // 2 sur 3 : rétractation PARTIELLE.
  await setInputValue(q(container, `[data-withdrawal-quantity="${LINE_VICTOR}"]`), "2");
  assert.equal(q<HTMLInputElement>(container, `[data-withdrawal-quantity="${LINE_VICTOR}"]`)!.value, "2");

  // Au-delà du reste : borné, jamais accepté tel quel.
  await setInputValue(q(container, `[data-withdrawal-quantity="${LINE_VICTOR}"]`), "9");
  assert.equal(
    q<HTMLInputElement>(container, `[data-withdrawal-quantity="${LINE_VICTOR}"]`)!.value,
    "3",
    "la quantité est ramenée au reste rétractable"
  );
  assert.equal(fetchCalls.length, 0, "choisir une quantité n'écrit rien");
});

// ==================================================================
// N. Confirmation explicite, et une seule écriture
// ==================================================================
test("N — rien n'est écrit avant « Confirmer la rétractation »", async () => {
  const { container } = await mount(OPTIONS_ELIGIBLES);

  await click(q(container, '[data-withdrawal-action="open"]'));
  await check(q(container, `[data-withdrawal-line="${LINE_VICTOR}"] input[type="checkbox"]`), true);
  await setInputValue(q(container, `[data-withdrawal-quantity="${LINE_VICTOR}"]`), "2");
  await click(q(container, '[data-withdrawal-action="continue"]'));

  assert.ok(q(container, '[data-withdrawal-step="review"]'), "récapitulatif atteint");
  assert.equal(fetchCalls.length, 0, "ni l'ouverture, ni la sélection, ni le récapitulatif n'écrivent");

  // Le récapitulatif rappelle EXACTEMENT la ligne et la quantité.
  const reviewLine = q(container, `[data-withdrawal-review-line="${LINE_VICTOR}"]`);
  assert.ok(reviewLine, "ligne rappelée au récapitulatif");
  assert.ok(/2\s*×\s*Coffret de Victor/.test(reviewLine!.textContent!));

  // D.221-5 : identité et moyen électronique de réception de l'accusé.
  const confirmButton = q<HTMLButtonElement>(container, '[data-withdrawal-action="confirm"]');
  assert.ok(confirmButton, "bouton de confirmation présent");
  assert.equal(confirmButton!.textContent!.trim(), "Confirmer la rétractation");
  assert.equal(confirmButton!.disabled, true, "confirmation impossible sans identité ni adresse");

  await setInputValue(q(container, '[data-withdrawal-field="firstName"]'), "Victor");
  await setInputValue(q(container, '[data-withdrawal-field="lastName"]'), "Hugo");
  await setInputValue(q(container, '[data-withdrawal-field="ackAddress"]'), "victor.hugo@example.org");
  assert.equal(
    q<HTMLButtonElement>(container, '[data-withdrawal-action="confirm"]')!.disabled,
    false,
    "confirmation possible une fois D.221-5 satisfait"
  );
  assert.equal(fetchCalls.length, 0, "saisir son identité n'écrit toujours rien");

  await click(q(container, '[data-withdrawal-action="confirm"]'));

  assert.equal(fetchCalls.length, 1, "UNE écriture, déclenchée par la confirmation explicite");
  assert.equal(fetchCalls[0]!.url, "/api/track/withdrawal");
  const body = fetchCalls[0]!.body;
  assert.equal(body.orderId, ORDER_ID);
  assert.equal(body.firstName, "Victor");
  assert.equal(body.lastName, "Hugo");
  assert.equal(body.acknowledgementAddress, "victor.hugo@example.org");
  assert.deepEqual(body.items, [{ orderItemId: LINE_VICTOR, quantity: 2 }]);
  // L'éligibilité n'est JAMAIS transmise par le navigateur : seuls
  // l'identifiant de ligne et la quantité voyagent.
  assert.ok(!JSON.stringify(body).includes("eligible"), "aucune éligibilité côté client");
  // Ni capacité, ni secret, ni jeton dans le corps : l'autorité est le
  // cookie de session de suivi, déjà audité.
  for (const forbidden of ["capabilityId", "capability_id", "secret", "token"]) {
    assert.ok(!Object.keys(body).includes(forbidden), `le corps ne transporte pas ${forbidden}`);
  }
});

test("N — un double clic sur la confirmation ne produit qu'une seule demande", async () => {
  let resolveFetch: ((v: any) => void) | null = null;
  fetchImpl = () =>
    new Promise((resolve) => {
      resolveFetch = resolve;
    });

  const { container } = await mount(OPTIONS_ELIGIBLES);
  await click(q(container, '[data-withdrawal-action="open"]'));
  await check(q(container, `[data-withdrawal-line="${LINE_HUGO}"] input[type="checkbox"]`), true);
  await click(q(container, '[data-withdrawal-action="continue"]'));
  await setInputValue(q(container, '[data-withdrawal-field="firstName"]'), "Victor");
  await setInputValue(q(container, '[data-withdrawal-field="lastName"]'), "Hugo");
  await setInputValue(q(container, '[data-withdrawal-field="ackAddress"]'), "victor.hugo@example.org");

  const button = q(container, '[data-withdrawal-action="confirm"]')!;
  await click(button);
  await click(button);
  await click(button);
  assert.equal(fetchCalls.length, 1, "un seul appel malgré trois clics");

  await act(async () => {
    resolveFetch!({
      ok: true,
      json: async () => ({
        ok: true,
        withdrawalRequestId: "44444444-4444-4444-8444-444444444444",
        requestedAt: "2026-06-25T10:32:00.000Z",
        acknowledgementStatus: "unavailable_no_channel",
      }),
    });
  });

  // Écran de succès : référence de demande, référence de commande,
  // produits, date, heure, et statut HONNÊTE de l'accusé.
  const done = q(container, '[data-withdrawal-step="done"]');
  assert.ok(done, "écran de succès atteint");
  assert.ok(
    q(done!, '[data-withdrawal-reference="44444444-4444-4444-8444-444444444444"]'),
    "référence de la demande affichée"
  );
  const doneText = done!.textContent!;
  assert.ok(doneText.includes("1842"), "référence de commande rappelée");
  assert.ok(doneText.includes("Tomme de Hugo"), "produit rappelé");
  assert.ok(/25\/06\/2026/.test(doneText), "date de la déclaration affichée");
  assert.ok(/\d{2}:\d{2}/.test(doneText), "heure de la déclaration affichée");

  // L'accusé n'est JAMAIS annoncé comme envoyé : aujourd'hui aucun
  // canal opérationnel n'existe (voir rapport, ACCUSÉ DE RÉCEPTION).
  const ack = q(done!, "[data-withdrawal-ack]")!;
  assert.equal(ack.getAttribute("data-withdrawal-ack"), "unavailable_no_channel");
  assert.ok(!/envoyé/i.test(ack.textContent!), "aucun « envoyé » mensonger");

  fetchImpl = async () => ({
    ok: true,
    json: async () => ({ ok: true, withdrawalRequestId: "x", requestedAt: "2026-06-25T10:32:00.000Z" }),
  });
});

// ==================================================================
// Garde de page : le point d'entrée dépend des lignes ÉLIGIBLES
// ==================================================================
test("I/J — la page de suivi ne monte le parcours que s'il existe une ligne éligible", () => {
  const page = readFileSync(path.join(REPO_ROOT, "app", "track", "[orderId]", "page.tsx"), "utf8");
  const flat = page.replace(/\s+/g, " ");
  assert.match(flat, /\{withdrawal\.options\.length > 0 && \( <WithdrawalPanel/, "rendu conditionnel réel");
  // Les options sont lues avec la capacité DÉJÀ vérifiée de la session,
  // jamais avec l'identifiant de commande seul.
  assert.match(flat, /getWithdrawalOptions\(\{ orderId: session\.orderId, capabilityId: session\.capabilityId, secret: session\.secret, \}\)/);
  // Échec fermé : une lecture impossible retire l'entrée, elle ne
  // dégrade jamais la page ni n'affiche un parcours inopérant.
  assert.match(flat, /catch \{ withdrawal = \{ orderNumber: tracking\.orderNumber, options: \[\] \}; \}/);
});
