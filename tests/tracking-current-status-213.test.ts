import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { trackingCurrentStatus } from "./browser/tracking-current-status.mjs";

// Adaptateur de lecture DOM uniquement : ne prétend pas piloter un vrai navigateur.
// Le lecteur de statut est le même que celui des scénarios Playwright B/C/D/D2.
function fixture(markup: string) {
  const dom = new JSDOM(markup);
  const page = {
    locator(selector: string) {
      const all = () => dom.window.document.querySelectorAll<HTMLElement>(selector);
      return {
        async count() { return all().length; },
        async isVisible() { return !all()[0]!.hidden; },
        async innerText() { return all()[0]!.textContent ?? ""; },
      };
    },
  };
  return { dom, page };
}

test("#213 : une frise complète ne valide pas une mise à jour du badge figé", async () => {
  const { dom, page } = fixture(`<main>
    <p aria-live="polite">Commande reçue</p>
    <ol><li>Commande acceptée</li><li>En préparation</li><li>Prête pour le retrait</li></ol>
  </main>`);
  try {
    const previousWholePageRead = dom.window.document.body.textContent ?? "";
    assert.match(previousWholePageRead, /accept/i, "contre-exemple : l'ancienne assertion passe à tort");
    assert.match(previousWholePageRead, /pr[ée]par/i, "la préparation figure déjà dans la frise");
    assert.match(previousWholePageRead, /pr[êe]te/i, "le retrait figure déjà dans la frise");
    assert.equal(await trackingCurrentStatus(page), "Commande reçue");
    assert.notEqual(await trackingCurrentStatus(page), "Commande acceptée");
    assert.notEqual(await trackingCurrentStatus(page), "En préparation");
    assert.notEqual(await trackingCurrentStatus(page), "Prête pour le retrait");
    const badge = dom.window.document.querySelector('p[aria-live="polite"]')!;
    badge.textContent = "Commande acceptée";
    assert.equal(await trackingCurrentStatus(page), "Commande acceptée");
    badge.textContent = "En préparation";
    assert.equal(await trackingCurrentStatus(page), "En préparation");
  } finally { dom.window.close(); }
});

test("#213 : aucun badge courant ne peut être remplacé par la frise", async () => {
  const { dom, page } = fixture("<main><ol><li>Commande acceptée</li></ol></main>");
  try { assert.equal(await trackingCurrentStatus(page), ""); }
  finally { dom.window.close(); }
});

test("#213 : un badge caché ou ambigu ne valide pas le statut", async () => {
  const { dom, page } = fixture('<main><p aria-live="polite" hidden>Commande acceptée</p></main>');
  try {
    assert.equal(await trackingCurrentStatus(page), "");
    dom.window.document.querySelector("p")!.removeAttribute("hidden");
    dom.window.document.querySelector("main")!.insertAdjacentHTML("beforeend", '<p aria-live="polite">En préparation</p>');
    assert.equal(await trackingCurrentStatus(page), "");
  } finally { dom.window.close(); }
});
