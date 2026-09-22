// SCANYM — MOBILE STICKY + DELIVERY DELAY NOTICE v1.1
// Hardening C: customer-facing wording of the pre-order notice dialog.
//   - a Click & Collect (pickup) notice is never titled "delivery";
//   - the hint is neutral: information supplied by the merchant; special
//     timing requests go in the order note; a note is a request, not a
//     guaranteed slot; no "the merchant will confirm" promise.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).HTMLDialogElement = window.HTMLDialogElement;
(globalThis as any).Event = window.Event;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
window.HTMLDialogElement.prototype.close = function () {
  this.removeAttribute("open");
  this.dispatchEvent(new window.Event("close"));
};

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const REPO_ROOT = process.cwd();
const built = await esbuild.build({
  stdin: {
    contents: `
      export { default as DeliveryTimingNoticeDialog } from "@/components/DeliveryTimingNoticeDialog";
      export { I18nProvider } from "@/lib/i18n-context";
      export { translate } from "@/lib/i18n";
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-notice-wording-"));
const tmpFile = path.join(tmpDir, "dialog.mjs");
writeFileSync(tmpFile, built.outputFiles[0].text);
const { DeliveryTimingNoticeDialog, I18nProvider, translate } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await tick(5);
  }
  throw new Error(`timeout: ${label}`);
}

async function renderNotice(modeCode: "pickup" | "delivery", lang: "fr" | "en" | "ar" = "fr") {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(I18nProvider, {
      lang,
      sourceLanguage: "fr",
      activeLanguages: [{ code: lang, dir: lang === "ar" ? "rtl" : "ltr" }],
      children: React.createElement(DeliveryTimingNoticeDialog, {
        open: true,
        notice: { modeCode, modeLabel: modeCode === "pickup" ? "Click & Collect" : "Chronofresh", message: "Texte du commerçant." },
        confirming: false,
        onConfirm: () => {},
        onDismiss: () => {},
      }),
    })
  );
  const dialog = () => container.querySelector("dialog") as HTMLDialogElement;
  await waitFor(() => !!dialog() && dialog().hasAttribute("open"), "dialog open");
  const titleId = dialog().getAttribute("aria-labelledby")!;
  const title = window.document.getElementById(titleId)?.textContent?.trim() ?? "";
  return { container, root, dialog: dialog(), title };
}

test("FR: a pickup (Click & Collect) notice is titled as pickup, never as delivery", async () => {
  const v = await renderNotice("pickup");
  try {
    assert.equal(v.title, "Délai et informations de retrait");
    assert.equal(/livraison/i.test(v.title), false);
  } finally {
    v.root.unmount();
    v.container.remove();
  }
});

test("FR: a delivery notice keeps the delivery title", async () => {
  const v = await renderNotice("delivery");
  try {
    assert.equal(v.title, "Délai et informations de livraison");
  } finally {
    v.root.unmount();
    v.container.remove();
  }
});

test("FR: neutral hint — merchant information, request via the order note, no guaranteed slot, no confirmation promise", async () => {
  for (const mode of ["pickup", "delivery"] as const) {
    const v = await renderNotice(mode);
    try {
      const text = v.dialog.textContent ?? "";
      assert.ok(text.includes("communiquées par le commerçant"), mode);
      assert.ok(text.includes("note de commande"), mode);
      assert.ok(text.includes("pas un créneau garanti"), mode);
      assert.equal(/confirmera|garantie? de livraison|demain/i.test(text), false, `${mode}: no promise wording`);
      assert.ok(text.includes("Texte du commerçant."), `${mode}: merchant text still shown verbatim`);
    } finally {
      v.root.unmount();
      v.container.remove();
    }
  }
});

test("EN and AR: pickup titles exist and hints carry no confirmation promise", async () => {
  const en = await renderNotice("pickup", "en");
  try {
    assert.equal(en.title, "Pickup timing and information");
    assert.equal(/will confirm/i.test(en.dialog.textContent ?? ""), false);
    assert.ok((en.dialog.textContent ?? "").includes("not a guaranteed slot"));
  } finally {
    en.root.unmount();
    en.container.remove();
  }
  const ar = await renderNotice("pickup", "ar");
  try {
    assert.equal(ar.title, "موعد ومعلومات الاستلام");
    assert.equal((ar.dialog.textContent ?? "").includes("سيؤكد التاجر"), false);
  } finally {
    ar.root.unmount();
    ar.container.remove();
  }
});

test("dictionary: the new pickup title key resolves in fr/en/ar (no fallback to the raw key)", () => {
  for (const lang of ["fr", "en", "ar"]) {
    const v = translate(lang, "pickupTimingNoticeTitle");
    assert.ok(v && v !== "pickupTimingNoticeTitle", lang);
  }
});
