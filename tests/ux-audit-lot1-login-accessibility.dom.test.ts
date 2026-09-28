import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// UX AUDIT LOT 1 — constat A : ACCESSIBILITÉ DE LA CONNEXION MARCHAND.
//
// Constat de l'audit indépendant (Chateaulatour) : sur
// /dashboard/login, les libellés visibles « E-mail » et « Mot de passe »
// existent, mais les champs n'ont AUCUN nom accessible dans l'arbre
// d'accessibilité -- les <label> étaient de simples frères des <input>,
// sans htmlFor, et les <input> n'avaient ni id ni aria-label.
//
// Ce fichier rend le VRAI composant de page dans un vrai DOM (même
// patron esbuild/jsdom que tous les *.dom.test.ts du dépôt) et calcule
// le nom accessible comme le ferait une technologie d'assistance pour
// ce cas simple : association label[for] -> input[id], puis repli sur
// aria-label / aria-labelledby.
//
// Il échoue sur la baseline 4dea63ad359d6b6d5bec4e2d4eacb4e17e027bc0
// et passe avec la correction -- c'est le point de la mesure.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard/login",
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
const { act } = React as any;
const REPO_ROOT = process.cwd();

(globalThis as any).__mockSession = null;
(globalThis as any).__mockSignInCalls = [] as Array<{ email: string; password: string }>;
(globalThis as any).__mockReplaceCalls = [] as string[];

const MOCK_NAV = `
const _router = {
  replace: (href) => { (globalThis).__mockReplaceCalls.push(href); },
  push: () => {},
};
export function useRouter() { return _router; }
`;

const MOCK_AUTH = `
export async function getSession() { return (globalThis).__mockSession; }
export async function signIn(email, password) {
  (globalThis).__mockSignInCalls.push({ email, password });
  return { user: { id: "u1" } };
}
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
};

const mockPlugin: esbuild.Plugin = {
  name: "scanym-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (mocks[args.path]) return { path: args.path, namespace: "mock" };
      if (args.path.startsWith("@/")) {
        const rel = args.path.slice(2);
        const base = path.join(REPO_ROOT, rel);
        const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p));
        return { path: candidate ?? base };
      }
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
      contents: mocks[args.path],
      loader: "ts",
    }));
  },
};

const buildResult = await esbuild.build({
  stdin: {
    contents: `export { default as LoginPage } from "@/app/dashboard/login/page.tsx";`,
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-login-a11y-"));
const tmpFile = path.join(tmpDir, "LoginPage.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const { LoginPage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

async function renderLogin() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(LoginPage));
  });
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/**
 * Nom accessible d'un contrôle de formulaire, dans l'ordre de priorité
 * qui s'applique à ce cas : aria-labelledby, puis aria-label, puis le
 * <label for=...> associé, puis un <label> ancêtre englobant.
 * Volontairement limité aux mécanismes réellement en jeu ici -- ce
 * n'est pas une réimplémentation complète de l'algorithme accname.
 */
function accessibleName(el: Element | null): string {
  if (!el) return "";
  const doc = el.ownerDocument!;
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    if (text) return text;
  }
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
  const id = el.getAttribute("id");
  if (id) {
    const label = doc.querySelector(`label[for="${id}"]`);
    if (label?.textContent?.trim()) return label.textContent.trim();
  }
  const ancestor = el.closest("label");
  if (ancestor?.textContent?.trim()) return ancestor.textContent.trim();
  return "";
}

test("A — le champ e-mail de connexion a un nom accessible non vide", async () => {
  const { container, cleanup } = await renderLogin();
  const email = container.querySelector('input[type="email"]');
  assert.ok(email, "champ e-mail introuvable");
  const name = accessibleName(email);
  assert.notEqual(name, "", "le champ e-mail n'a AUCUN nom accessible (constat A)");
  assert.match(name, /mail/i, `nom accessible inattendu pour le champ e-mail : "${name}"`);
  cleanup();
});

test("A — le champ mot de passe de connexion a un nom accessible non vide", async () => {
  const { container, cleanup } = await renderLogin();
  const password = container.querySelector('input[type="password"]');
  assert.ok(password, "champ mot de passe introuvable");
  const name = accessibleName(password);
  assert.notEqual(name, "", "le champ mot de passe n'a AUCUN nom accessible (constat A)");
  assert.match(name, /passe|password/i, `nom accessible inattendu : "${name}"`);
  cleanup();
});

test("A — le nom accessible vient d'un <label> ASSOCIÉ, pas d'un aria-label de remplacement", async () => {
  const { container, cleanup } = await renderLogin();
  for (const selector of ['input[type="email"]', 'input[type="password"]']) {
    const input = container.querySelector(selector)!;
    const id = input.getAttribute("id");
    assert.ok(id, `${selector} n'a pas d'id -- l'association htmlFor/id est le mécanisme retenu`);
    const label = container.querySelector(`label[for="${id}"]`);
    assert.ok(label, `aucun <label for="${id}"> associé à ${selector}`);
    assert.equal(
      input.getAttribute("aria-label"),
      null,
      `${selector} utilise un aria-label alors qu'un libellé visible associé suffit`
    );
  }
  cleanup();
});

test("A — les libellés visibles restent affichés et inchangés", async () => {
  const { container, cleanup } = await renderLogin();
  const labels = Array.from(container.querySelectorAll("label")).map((l) => l.textContent?.trim());
  assert.equal(labels.length, 2, "les deux libellés visibles doivent rester présents");
  assert.ok(
    labels.every((text) => !!text && text.length > 0),
    "un libellé visible est devenu vide"
  );
  // Les classes de style d'origine ne doivent pas avoir été touchées.
  for (const label of Array.from(container.querySelectorAll("label"))) {
    assert.match(
      label.getAttribute("class") ?? "",
      /text-sm font-semibold text-stone-700/,
      "le style visible du libellé a changé -- hors périmètre de cette correction"
    );
  }
  cleanup();
});

test("A — le comportement de connexion est préservé (signIn reçoit les valeurs saisies)", async () => {
  (globalThis as any).__mockSignInCalls = [];
  const { container, cleanup } = await renderLogin();

  const email = container.querySelector('input[type="email"]') as HTMLInputElement;
  const password = container.querySelector('input[type="password"]') as HTMLInputElement;
  const setValue = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(
      (window as any).HTMLInputElement.prototype,
      "value"
    )!.set!;
    setter.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  };

  await act(async () => {
    setValue(email, "merchant@etys-it.local");
    setValue(password, "s3cret");
  });

  const form = container.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });

  const calls = (globalThis as any).__mockSignInCalls as Array<{ email: string; password: string }>;
  assert.equal(calls.length, 1, "signIn doit être appelé exactement une fois");
  assert.equal(calls[0].email, "merchant@etys-it.local");
  assert.equal(calls[0].password, "s3cret");
  cleanup();
});
