import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).HTMLDialogElement = window.HTMLDialogElement;
(globalThis as any).Event = window.Event;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });

window.HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};
window.HTMLDialogElement.prototype.close = function () {
  this.removeAttribute("open");
  this.dispatchEvent(new window.Event("close"));
};

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const REPO_ROOT = process.cwd();
const buildResult = await esbuild.build({
  stdin: {
    contents: `
      export { default as DeliveryTimingNoticeDialog } from "@/components/DeliveryTimingNoticeDialog";
      export { I18nProvider } from "@/lib/i18n-context";
    `,
    resolveDir: REPO_ROOT,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  plugins: [{
    name: "at-alias",
    setup(build) {
      build.onResolve({ filter: /^@\// }, (args) => {
        const base = path.join(REPO_ROOT, args.path.slice(2));
        const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find(existsSync);
        return { path: candidate ?? base };
      });
    },
  }],
  external: ["react", "react-dom", "react-dom/client"],
});
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-delivery-notice-"));
const tmpFile = path.join(tmpDir, "DeliveryTimingNoticeDialog.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const { DeliveryTimingNoticeDialog, I18nProvider } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });
type DialogProps = React.ComponentProps<typeof DeliveryTimingNoticeDialog>;

function flush(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, description: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 1000) throw new Error(`waitFor timeout: ${description}`);
    await flush();
  }
}

function click(element: Element) {
  element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

async function render(props: DialogProps) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(
      I18nProvider,
      {
        lang: "fr",
        sourceLanguage: "fr",
        activeLanguages: [{ code: "fr", dir: "ltr" }],
        children: React.createElement(DeliveryTimingNoticeDialog, props),
      }
    )
  );
  await flush();
  return { container, root };
}

test("popup lisible mobile/desktop, nommé, décrit, texte marchand exact et actions clavier natives", async () => {
  let confirmed = 0;
  let dismissed = 0;
  const view = await render({
    open: true,
    notice: {
      modeCode: "delivery",
      modeLabel: "Chronofresh",
      message: "Expédition mardi après 14 h.\nLivraison estimée jeudi.",
    },
    confirming: false,
    onConfirm: () => { confirmed += 1; },
    onDismiss: () => { dismissed += 1; },
  });

  const dialog = view.container.querySelector("dialog")!;
  await waitFor(() => dialog.hasAttribute("open"), "delivery timing dialog open");
  assert.ok(dialog.hasAttribute("open"));
  assert.ok(dialog.getAttribute("aria-labelledby"));
  assert.ok(dialog.getAttribute("aria-describedby"));
  assert.ok(dialog.className.includes("w-[calc(100%-2rem)]"));
  assert.ok(dialog.className.includes("max-w-md"));
  assert.ok(dialog.textContent?.includes("Chronofresh"));
  assert.ok(dialog.textContent?.includes("Expédition mardi après 14 h."));
  assert.ok(dialog.textContent?.includes("note de commande"));

  const buttons = [...dialog.querySelectorAll("button")];
  assert.equal(buttons.length, 2);
  for (const button of buttons) {
    assert.equal(button.getAttribute("type"), "button");
    assert.ok(button.className.includes("min-h-11"));
  }
  click(buttons[1]);
  assert.equal(confirmed, 1);
  assert.equal(dismissed, 0);

  view.root.unmount();
  view.container.remove();
});

test("retour ferme sans confirmer et conserve le contrôle au checkout appelant", async () => {
  let confirmed = 0;
  let dismissed = 0;
  const view = await render({
    open: true,
    notice: { modeCode: "pickup", modeLabel: "Click & Collect", message: "Prêt sous 2 h." },
    confirming: false,
    onConfirm: () => { confirmed += 1; },
    onDismiss: () => { dismissed += 1; },
  });
  // v1.1 (déterminisme) : attendre que le dialogue soit RÉELLEMENT ouvert
  // avant de cliquer « retour ». Sans cette précondition, sous charge,
  // le clic pouvait précéder l'effet showModal() -- le dialogue s'ouvrait
  // alors APRÈS le clic et l'assertion « fermé » échouait (faux négatif).
  const openedDialog = view.container.querySelector("dialog")!;
  await waitFor(() => openedDialog.hasAttribute("open"), "pickup dialog open before dismiss");
  const back = view.container.querySelector("dialog button")!;
  click(back);
  await flush();
  assert.equal(confirmed, 0);
  assert.ok(dismissed >= 1);
  assert.equal(view.container.querySelector("dialog")!.hasAttribute("open"), false);
  view.root.unmount();
  view.container.remove();
});

test("message absent : le dialogue ne s'ouvre pas", async () => {
  const view = await render({
    open: true,
    notice: null,
    confirming: false,
    onConfirm: () => {},
    onDismiss: () => {},
  });
  assert.equal(view.container.querySelector("dialog")!.hasAttribute("open"), false);
  view.root.unmount();
  view.container.remove();
});

after(() => {
  dom.window.close();
});
