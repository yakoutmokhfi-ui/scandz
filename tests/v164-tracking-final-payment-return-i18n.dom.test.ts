import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

// ====================================================================
// Scanym — CUSTOMER CONFIRMATION + TRACKING FINAL v1 (mandat,
// "payment-return experience" / "FR/EN/AR i18n").
//
// components/PaymentReturnStatus.tsx : couvre le gap de Phase 0
// ("zero test coverage" pour PaymentReturnStatusView/
// resolvePaymentReturnStatus) pour la part testable SANS réseau/SQL --
// ce composant reste un Server Component PUR (aucun hook, aucun accès
// réseau) : il prend `status`/`lang` déjà résolus et se contente de
// traduire/afficher, exactement comme app/track/[orderId]/page.tsx.
//
// `next/link` est mocké en simple passe-plat vers <a> (même principe
// que tests/v123a-tracking-page-existing-session-fragment.dom.test.ts)
// -- aucune bibliothèque Next.js réelle n'est jamais bundlée par ce
// harnais, qui n'externalise QUE react/react-dom.
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

const React = await import("react");
const { createRoot } = await import("react-dom/client");

const REPO_ROOT = process.cwd();

const MOCK_LINK = `
import { createElement } from "react";
export default function Link(props) {
  const { href, children, ...rest } = props;
  return createElement("a", { href, ...rest }, children);
}
`;

const mockPlugin: esbuild.Plugin = {
  name: "scanym-mocks",
  setup(build) {
    build.onResolve({ filter: /^next\/link$/ }, () => ({
      path: "next/link",
      namespace: "mock",
    }));
    build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
      contents: MOCK_LINK,
      loader: "ts",
    }));
    build.onResolve({ filter: /^@\// }, (args) => {
      const rel = args.path.slice(2);
      const base = path.join(REPO_ROOT, rel);
      const candidate = ["", ".tsx", ".ts"]
        .map((ext) => base + ext)
        .find((p) => existsSync(p));
      return { path: candidate ?? base };
    });
  },
};

const entrySource = `
export { default as PaymentReturnStatusView } from "@/components/PaymentReturnStatus";
`;

const buildResult = await esbuild.build({
  stdin: {
    contents: entrySource,
    resolveDir: REPO_ROOT,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  plugins: [mockPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const code = buildResult.outputFiles[0].text;
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v164-"));
const tmpFile = path.join(tmpDir, "PaymentReturnStatus.mjs");
writeFileSync(tmpFile, code);
const { PaymentReturnStatusView } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const TRACKING_PATH = "/track/11111111-1111-4111-8111-111111111111#22222222-2222-4222-8222-222222222222";

function render(status: any, lang: "fr" | "en" | "ar" = "fr") {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(PaymentReturnStatusView, { status, lang }));
  return { container, root };
}

function findTrackingAnchor(container: Element): HTMLAnchorElement | undefined {
  return [...container.querySelectorAll("a")].find((a) => a.getAttribute("href")?.startsWith("/track/"));
}

test("mandat « payment-return experience » : kind=paid (fr) -- titre/texte traduits, lien de suivi présent et EXACT", async () => {
  const { container, root } = render({ kind: "paid", trackingPath: TRACKING_PATH });
  await flush();

  assert.ok(container.textContent?.includes("Paiement confirmé"));
  const anchor = findTrackingAnchor(container);
  assert.ok(anchor, "un lien de suivi doit être rendu pour un statut RÉSOLU");
  assert.equal(anchor!.getAttribute("href"), TRACKING_PATH, "jamais reconstruit -- exactement ce que shared.ts a transmis");

  root.unmount();
  container.remove();
});

test("mandat « FR/EN/AR i18n » : kind=paid (en) -- texte anglais, jamais le français", async () => {
  const { container, root } = render({ kind: "paid", trackingPath: TRACKING_PATH }, "en");
  await flush();

  assert.ok(container.textContent?.includes("Payment confirmed"));
  assert.equal(container.textContent?.includes("Paiement confirmé"), false);

  root.unmount();
  container.remove();
});

test("mandat « FR/EN/AR i18n » : kind=paid (ar) -- texte arabe rendu", async () => {
  const { container, root } = render({ kind: "paid", trackingPath: TRACKING_PATH }, "ar");
  await flush();

  assert.ok(container.textContent?.includes("تم تأكيد الدفع"));

  root.unmount();
  container.remove();
});

test("kind=pending -- texte de traitement en cours, lien de suivi présent", async () => {
  const { container, root } = render({ kind: "pending", trackingPath: TRACKING_PATH });
  await flush();

  assert.ok(container.textContent?.includes("Paiement en cours de traitement"));
  assert.ok(findTrackingAnchor(container));

  root.unmount();
  container.remove();
});

test("kind=not_required -- texte dédié, lien de suivi présent", async () => {
  const { container, root } = render({ kind: "not_required", trackingPath: TRACKING_PATH });
  await flush();

  assert.ok(container.textContent?.includes("Aucun paiement requis"));
  assert.ok(findTrackingAnchor(container));

  root.unmount();
  container.remove();
});

test("kind=failed_or_cancelled -- texte d'échec, lien de suivi présent (le client peut revenir à sa commande)", async () => {
  const { container, root } = render({ kind: "failed_or_cancelled", trackingPath: TRACKING_PATH });
  await flush();

  assert.ok(container.textContent?.includes("Paiement non abouti"));
  assert.ok(findTrackingAnchor(container));

  root.unmount();
  container.remove();
});

test("kind=unavailable -- texte générique, JAMAIS de lien de suivi (aucun publicToken vérifié à cet endroit -- posture anti-fuite)", async () => {
  const { container, root } = render({ kind: "unavailable" });
  await flush();

  assert.ok(container.textContent?.includes("Statut indisponible"));
  assert.equal(findTrackingAnchor(container), undefined);

  root.unmount();
  container.remove();
});

test("le lien « retour à l'accueil » est toujours présent et traduit, quel que soit le statut", async () => {
  const { container, root } = render({ kind: "unavailable" });
  await flush();

  const homeAnchor = [...container.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/");
  assert.ok(homeAnchor);
  assert.equal(homeAnchor!.textContent, "Retour à l'accueil");

  root.unmount();
  container.remove();
});

after(async () => {
  window.close();
  await esbuild.stop();
  await new Promise((r) => setTimeout(r, 50));
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") {
      h.unref();
    }
  }
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  delete (globalThis as any).navigator;
  delete (globalThis as any).HTMLElement;
  delete (globalThis as any).Event;
});
