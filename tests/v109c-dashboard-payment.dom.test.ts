import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym — PAYMENT P2B-B — preuve comportementale RÉELLE (rendu React
// dans un vrai DOM, RPC réellement interceptées) de la page
// app/dashboard/payment/page.tsx : zéro/un/plusieurs prestataires,
// libellés de statut/mode/activation, état vide, état d'erreur sûr,
// et absence de tout contrôle interactif de mutation.
//
// Patron esbuild/jsdom/supabase déjà établi dans ce projet -- voir
// tests/v81-lot1b1-dashboardnav.dom.test.ts (mock next/navigation +
// @/lib/services/auth) et tests/v92-aulaitcru-sale-modes-runtime.dom.test.ts
// (lib/supabase.ts marqué external, RPC interceptées via t.mock.method
// pour exercer le VRAI service, pas un double du service).
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard/payment?r=r-test-1",
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
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { supabase } = await import("../lib/supabase.ts");

const REPO_ROOT = process.cwd();

(globalThis as any).__mockPathname = "/dashboard/payment";

const MOCK_NAV = `
export function usePathname() {
  return (globalThis as any).__mockPathname;
}
// Référence STABLE entre les rendus (comme le vrai next/navigation) --
// un objet littéral recréé à chaque appel casserait tout effet
// dépendant de [router] (identité d'objet différente à chaque rendu =
// re-déclenchement systématique), ce qui réinitialiserait
// silencieusement restaurantId après CHAQUE changement d'état (bascule
// de restaurant y compris). Corrigé pendant le développement des tests
// de bascule de restaurant v2 -- un défaut du harnais de test, jamais
// du code applicatif réel.
const mockRouter = { replace: () => {}, push: () => {} };
export function useRouter() {
  return mockRouter;
}
`;

const MOCK_AUTH = `
export async function getUser() {
  return { id: "u-test-1", email: "owner@test.example" };
}
export async function signOut() {}
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
};

const mockPlugin: esbuild.Plugin = {
  name: "scanym-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (mocks[args.path]) {
        return { path: args.path, namespace: "mock" };
      }
      if (args.path.startsWith("@/")) {
        const rel = args.path.slice(2);
        const base = path.join(REPO_ROOT, rel);
        if (base.endsWith(path.join("lib", "supabase"))) {
          const resolved = ["", ".ts"].map((e) => base + e).find((p) => existsSync(p)) ?? base + ".ts";
          return { path: pathToFileURL(resolved).href, external: true };
        }
        const candidate = ["", ".tsx", ".ts"]
          .map((ext) => base + ext)
          .find((p) => existsSync(p));
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

const entrySource = `
export { default as PaymentPage } from "@/app/dashboard/payment/page";
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
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"],
});
const code = buildResult.outputFiles[0].text;
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-v109c-"));
const tmpFile = path.join(tmpDir, "PaymentPage.mjs");
writeFileSync(tmpFile, code);
const { PaymentPage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// CORRECTION v3 : ce projet interagit avec le DOM via flush()/waitFor()
// ci-dessus (patron déjà établi et validé dans toute la suite
// tests/*.dom.test.ts) plutôt que via React `act()`. Le test mandaté
// "bascule IMMÉDIATE A -> B" (mission section 9/10) exige spécifiquement
// `act()` pour garantir un flush SYNCHRONE sans waitFor/timer. `act()`
// exige `globalThis.IS_REACT_ACT_ENVIRONMENT === true`, sans quoi React
// émet un avertissement de configuration ; mais laisser ce drapeau
// activé en permanence ferait au contraire émettre un avertissement
// inverse ("update ... was not wrapped in act(...)") sur CHAQUE mise à
// jour survenant via le patron flush()/waitFor() déjà validé -- un faux
// positif de configuration de test, pas un défaut de l'application.
// `actWithFlag` limite donc l'activation du drapeau à la durée stricte
// de l'appel `act()` lui-même, puis le restaure à son état d'origine
// (non défini), pour ne jamais interférer avec le reste du fichier.
async function actWithFlag(cb: () => void | Promise<void>): Promise<void> {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await (React as unknown as { act: (cb: () => void | Promise<void>) => Promise<void> }).act(cb);
  } finally {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = undefined;
  }
}

async function waitFor(check: () => boolean, description: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout (${timeoutMs}ms) : ${description}`);
    }
    await flush(10);
  }
}

function mockRestaurantUsersFrom() {
  return {
    select: () => ({
      order: async () => ({
        data: [
          {
            restaurant_id: "r-test-1",
            role: "owner",
            restaurants: { id: "r-test-1", name: "Fixture Resto", slug: "fixture-resto" },
          },
        ],
        error: null,
      }),
    }),
  };
}

function render() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(PaymentPage));
  return { container, root };
}

test("P2B-B DOM: zéro configuration -> état vide sûr affiché, jamais présenté comme une erreur", async (t) => {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "restaurant_users") return mockRestaurantUsersFrom();
    throw new Error(`table inattendue : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_merchant_payment_provider_config") return { data: [], error: null };
    throw new Error(`RPC inattendue : ${name}`);
  });

  const { container, root } = render();
  await waitFor(() => container.textContent!.includes("n'est pas encore configuré"), "état vide");

  assert.ok(container.textContent!.includes("La configuration technique est gérée par Scanym."));
  assert.ok(!container.querySelector(".bg-amber-50"), "l'état vide ne doit jamais utiliser le style d'erreur");
  assert.equal(container.querySelectorAll("section").length, 0, "aucune carte prestataire ne doit être rendue");

  root.unmount();
  container.remove();
});

test("P2B-B DOM: un prestataire (monetico, live, verified, activé, vérifié) -> une carte avec tous les champs sûrs, aucune donnée interdite", async (t) => {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "restaurant_users") return mockRestaurantUsersFrom();
    throw new Error(`table inattendue : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_merchant_payment_provider_config") {
      return {
        data: [
          {
            provider_code: "monetico",
            mode: "live",
            configuration_status: "verified",
            is_enabled: true,
            last_verified_at: "2026-01-15T10:30:00Z",
            updated_at: "2026-01-15T10:30:00Z",
            // Champ malicieux -- même si la RPC (mockée ici) le
            // renvoyait par erreur, il ne doit jamais atteindre le DOM.
            credentials_ref: "11111111-1111-1111-1111-111111111111",
          },
        ],
        error: null,
      };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });

  const { container, root } = render();
  await waitFor(() => container.querySelectorAll("section").length === 1, "une carte prestataire");

  assert.ok(container.textContent!.includes("Monetico"));
  assert.ok(container.textContent!.includes("Production"), "mode live -> libellé Production");
  assert.ok(container.textContent!.includes("Vérifié"));
  assert.ok(container.textContent!.includes("Configuration activée"));
  assert.ok(
    !container.textContent!.includes("Le paiement en ligne est disponible"),
    "P2B-B ne doit JAMAIS affirmer que le paiement en ligne est disponible pour les clients (mission section 15)"
  );
  assert.ok(!container.textContent!.includes("11111111-1111-1111-1111-111111111111"), "aucun UUID Vault ne doit apparaître dans le DOM");
  assert.ok(!container.innerHTML.includes("credentials_ref"));

  root.unmount();
  container.remove();
});

test("P2B-B DOM: plusieurs prestataires (2) -> les DEUX cartes sont rendues, aucun comportement implicite de première-ligne-seulement", async (t) => {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "restaurant_users") return mockRestaurantUsersFrom();
    throw new Error(`table inattendue : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_merchant_payment_provider_config") {
      return {
        data: [
          {
            provider_code: "monetico",
            mode: "test",
            configuration_status: "not_configured",
            is_enabled: false,
            last_verified_at: null,
            updated_at: "2026-01-01T00:00:00Z",
          },
          {
            provider_code: "future_unknown_provider",
            mode: "some_future_mode",
            configuration_status: "some_future_status",
            is_enabled: false,
            last_verified_at: null,
            updated_at: "2026-01-02T00:00:00Z",
          },
        ],
        error: null,
      };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });

  const { container, root } = render();
  await waitFor(() => container.querySelectorAll("section").length === 2, "deux cartes prestataire");

  assert.ok(container.textContent!.includes("Monetico"));
  assert.ok(container.textContent!.includes("Future Unknown Provider"), "prestataire inconnu -> repli lisible généré, pas un crash");
  assert.ok(container.textContent!.includes("Non configuré"));
  assert.ok(container.textContent!.includes("Statut inconnu"), "statut futur inconnu -> repli sûr, jamais un crash");
  assert.ok(container.textContent!.includes("Mode inconnu"), "mode futur inconnu -> repli sûr, jamais un crash");
  assert.ok(container.textContent!.includes("Configuration désactivée"));
  assert.ok(container.textContent!.includes("Non vérifié"), "last_verified_at null -> repli sûr, jamais une date inventée");

  root.unmount();
  container.remove();
});

test("P2B-B DOM: échec RPC -> message d'erreur marchand-sûr affiché, jamais de détail backend brut", async (t) => {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "restaurant_users") return mockRestaurantUsersFrom();
    throw new Error(`table inattendue : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_merchant_payment_provider_config") {
      return { data: null, error: { message: "42501: permission denied for restaurant abc-123" } };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });

  const { container, root } = render();
  await waitFor(() => container.textContent!.includes("Impossible de charger les informations de paiement."), "message d'erreur sûr");

  assert.ok(!container.textContent!.includes("42501"));
  assert.ok(!container.textContent!.includes("permission denied"));
  assert.ok(!container.textContent!.includes("abc-123"));

  root.unmount();
  container.remove();
});

test("P2B-B DOM: la page est strictement lecture seule -- aucun input, select, textarea ou bouton n'est rendu", async (t) => {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "restaurant_users") return mockRestaurantUsersFrom();
    throw new Error(`table inattendue : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_merchant_payment_provider_config") {
      return {
        data: [
          {
            provider_code: "monetico",
            mode: "live",
            configuration_status: "verified",
            is_enabled: true,
            last_verified_at: "2026-01-15T10:30:00Z",
            updated_at: "2026-01-15T10:30:00Z",
          },
        ],
        error: null,
      };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });

  const { container, root } = render();
  await waitFor(() => container.querySelectorAll("section").length === 1, "carte rendue");

  // La nav partagée (DashboardNav) contient légitimement un <select>
  // (sélecteur d'établissement) et un <button> (déconnexion) -- ceux-ci
  // ne sont PAS des contrôles de mutation de paiement. On isole donc
  // strictement le contenu de la page (<main>), hors nav.
  const main = container.querySelector("main");
  assert.ok(main, "la page doit avoir un conteneur <main>");
  assert.equal(main!.querySelectorAll("input").length, 0);
  assert.equal(main!.querySelectorAll("select").length, 0);
  assert.equal(main!.querySelectorAll("textarea").length, 0);
  assert.equal(main!.querySelectorAll("button").length, 0);

  root.unmount();
  container.remove();
});

// ====================================================================
// SCANYM — PAYMENT P2B-B v2 CORRECTION — preuves comportementales
// ajoutées pour fermer PAY-P2B-B-01 (bascule de restaurant / réponses
// hors-ordre), PAY-P2B-B-02 (langue réelle de la page) et PAY-P2B-B-03
// (stratégie anti-débordement mobile de la nav). Réutilise le même
// harnais DOM réel (esbuild + jsdom + RPC/table interceptées) que les
// tests ci-dessus -- ce ne sont pas de nouveaux doubles de service.
// ====================================================================

function mockTwoRestaurantsFrom() {
  return {
    select: () => ({
      order: async () => ({
        data: [
          {
            restaurant_id: "r-test-1",
            role: "owner",
            restaurants: { id: "r-test-1", name: "Resto A", slug: "resto-a" },
          },
          {
            restaurant_id: "r-test-2",
            role: "owner",
            restaurants: { id: "r-test-2", name: "Resto B", slug: "resto-b" },
          },
        ],
        error: null,
      }),
    }),
  };
}

function mockThreeRestaurantsFrom() {
  return {
    select: () => ({
      order: async () => ({
        data: [
          {
            restaurant_id: "r-test-1",
            role: "owner",
            restaurants: { id: "r-test-1", name: "Resto A", slug: "resto-a" },
          },
          {
            restaurant_id: "r-test-2",
            role: "owner",
            restaurants: { id: "r-test-2", name: "Resto B", slug: "resto-b" },
          },
          {
            restaurant_id: "r-test-3",
            role: "owner",
            restaurants: { id: "r-test-3", name: "Resto C", slug: "resto-c" },
          },
        ],
        error: null,
      }),
    }),
  };
}

function mockRestaurantConfigsFrom(staffReceiptLanguage: string) {
  return {
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: { staff_receipt_language: staffReceiptLanguage },
          error: null,
        }),
      }),
    }),
  };
}

function makeDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Simule un changement RÉEL d'établissement via le <select> de
 *  DashboardNav (le même composant partagé que toutes les pages
 *  Dashboard) -- pas un appel direct à un setter interne. */
function selectRestaurantOption(container: HTMLElement, value: string) {
  const select = container.querySelector("select") as HTMLSelectElement | null;
  assert.ok(select, "le sélecteur d'établissement doit exister (mappings.length > 1)");
  select!.value = value;
  select!.dispatchEvent(new window.Event("change", { bubbles: true }));
}

test("P2B-B DOM: bascule de restaurant (A -> B) -- les données de A disparaissent IMMÉDIATEMENT, un état de chargement neutre est affiché, seules les données de B sont finalement rendues (ferme PAY-P2B-B-01)", async (t) => {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "restaurant_users") return mockTwoRestaurantsFrom();
    throw new Error(`table inattendue : ${table}`);
  });

  const deferredB = makeDeferred<{ data: unknown; error: null }>();
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    if (name !== "get_merchant_payment_provider_config") {
      throw new Error(`RPC inattendue : ${name}`);
    }
    if (args.p_restaurant_id === "r-test-1") {
      return {
        data: [
          {
            provider_code: "monetico",
            mode: "live",
            configuration_status: "verified",
            is_enabled: true,
            last_verified_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
        error: null,
      };
    }
    if (args.p_restaurant_id === "r-test-2") return deferredB.promise;
    throw new Error(`restaurant inattendu : ${args.p_restaurant_id}`);
  });

  const { container, root } = render();
  await waitFor(() => container.querySelectorAll("section").length === 1, "carte A rendue");
  assert.ok(container.textContent!.includes("Monetico"));

  selectRestaurantOption(container, "r-test-2");

  // AVANT que B ne se résolve : plus AUCUNE trace de A, un état de
  // chargement neutre est affiché à la place -- jamais une carte, un
  // état vide ou une erreur de l'établissement précédent.
  await waitFor(
    () =>
      !container.textContent!.includes("Monetico") &&
      container.querySelectorAll("section").length === 0,
    "les données de A ont disparu pendant le chargement de B"
  );
  assert.ok(!container.querySelector(".bg-amber-50"), "pas d'erreur affichée pendant le chargement de B");

  deferredB.resolve({
    data: [
      {
        provider_code: "future_unknown_provider",
        mode: "test",
        configuration_status: "not_configured",
        is_enabled: false,
        last_verified_at: null,
        updated_at: null,
      },
    ],
    error: null,
  });

  await waitFor(() => container.querySelectorAll("section").length === 1, "carte B rendue");
  assert.ok(container.textContent!.includes("Future Unknown Provider"));
  assert.ok(!container.textContent!.includes("Monetico"), "A ne doit plus jamais réapparaître une fois B affiché");

  root.unmount();
  container.remove();
});

test("P2B-B DOM: bascule de restaurant PUIS ÉCHEC du second chargement -- zéro trace de A, erreur sûre affichée pour B (ferme PAY-P2B-B-01)", async (t) => {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "restaurant_users") return mockTwoRestaurantsFrom();
    throw new Error(`table inattendue : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    if (name !== "get_merchant_payment_provider_config") {
      throw new Error(`RPC inattendue : ${name}`);
    }
    if (args.p_restaurant_id === "r-test-1") {
      return {
        data: [
          {
            provider_code: "monetico",
            mode: "live",
            configuration_status: "verified",
            is_enabled: true,
            last_verified_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
        error: null,
      };
    }
    if (args.p_restaurant_id === "r-test-2") {
      return { data: null, error: { message: "42501: permission denied for restaurant r-test-2" } };
    }
    throw new Error(`restaurant inattendu : ${args.p_restaurant_id}`);
  });

  const { container, root } = render();
  await waitFor(() => container.querySelectorAll("section").length === 1, "carte A rendue");

  selectRestaurantOption(container, "r-test-2");

  await waitFor(
    () => container.textContent!.includes("Impossible de charger les informations de paiement."),
    "erreur sûre affichée pour B"
  );

  assert.equal(
    container.querySelectorAll("section").length,
    0,
    "zéro carte -- aucune donnée de A ne doit survivre à l'échec du second chargement"
  );
  assert.ok(!container.textContent!.includes("Monetico"), "aucun texte de prestataire A ne doit rester visible");
  assert.ok(!container.textContent!.includes("Vérifié"), "aucun statut de A ne doit rester visible");
  assert.ok(!container.textContent!.includes("42501"));
  assert.ok(!container.textContent!.includes("permission denied"));
  assert.ok(!container.textContent!.includes("r-test-2"), "aucun identifiant brut ne doit fuiter dans l'erreur");

  root.unmount();
  container.remove();
});

test("P2B-B DOM: réponses HORS-ORDRE -- A (tardive) répond APRÈS B -- B reste affiché, la réponse tardive de A est intégralement ignorée (protège contre une réintroduction de la classe de bug)", async (t) => {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "restaurant_users") return mockTwoRestaurantsFrom();
    throw new Error(`table inattendue : ${table}`);
  });

  const deferredA = makeDeferred<{ data: unknown; error: null }>();
  const deferredB = makeDeferred<{ data: unknown; error: null }>();
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    if (name !== "get_merchant_payment_provider_config") {
      throw new Error(`RPC inattendue : ${name}`);
    }
    if (args.p_restaurant_id === "r-test-1") return deferredA.promise;
    if (args.p_restaurant_id === "r-test-2") return deferredB.promise;
    throw new Error(`restaurant inattendu : ${args.p_restaurant_id}`);
  });

  const { container, root } = render();
  // A est demandée dès le montage (via ?r=r-test-1) mais reste EN VOL
  // (deferredA non résolue) : bascule vers B avant même que A ait eu la
  // moindre chance de répondre.
  await flush(20);
  selectRestaurantOption(container, "r-test-2");
  await flush(20);

  // B répond EN PREMIER.
  deferredB.resolve({
    data: [
      {
        provider_code: "monetico",
        mode: "test",
        configuration_status: "configured",
        is_enabled: false,
        last_verified_at: null,
        updated_at: null,
      },
    ],
    error: null,
  });
  await waitFor(() => container.querySelectorAll("section").length === 1, "carte B rendue");
  assert.ok(container.textContent!.includes("Configuré"));

  // A répond ENSUITE (tardivement), avec des données DIFFÉRENTES et
  // reconnaissables -- cette réponse périmée ne doit JAMAIS écraser B.
  deferredA.resolve({
    data: [
      {
        provider_code: "late_stale_provider_a",
        mode: "live",
        configuration_status: "verified",
        is_enabled: true,
        last_verified_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
    error: null,
  });
  await flush(100);

  assert.equal(
    container.querySelectorAll("section").length,
    1,
    "toujours une seule carte -- la réponse tardive de A n'a rien ajouté ni remplacé"
  );
  assert.ok(
    !container.textContent!.includes("Late Stale Provider A"),
    "la réponse tardive de A ne doit jamais atteindre le DOM"
  );
  assert.ok(container.textContent!.includes("Configuré"), "B doit rester affiché, strictement inchangé");

  root.unmount();
  container.remove();
});

test("P2B-B DOM: langue commerçant FR (staff_receipt_language='fr') -> page ET onglet nav en français, cohérents (ferme PAY-P2B-B-02/09)", async (t) => {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "restaurant_users") return mockRestaurantUsersFrom();
    if (table === "restaurant_configs") return mockRestaurantConfigsFrom("fr");
    throw new Error(`table inattendue : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_merchant_payment_provider_config") {
      return {
        data: [
          {
            provider_code: "monetico",
            mode: "live",
            configuration_status: "verified",
            is_enabled: true,
            last_verified_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
        error: null,
      };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });

  const { container, root } = render();
  await waitFor(
    () => container.querySelectorAll("section").length === 1 && container.textContent!.includes("Paiement"),
    "page chargée en français"
  );

  assert.ok(container.textContent!.includes("Configuration activée"), "libellé activé en français");
  assert.ok(container.textContent!.includes("Vérifié"), "statut en français");
  const paymentTab = Array.from(container.querySelectorAll("nav a")).find((a) =>
    a.getAttribute("href")?.includes("/dashboard/payment")
  );
  assert.ok(paymentTab, "l'onglet Paiement doit exister dans la nav");
  assert.equal(paymentTab!.textContent, "Paiement", "l'onglet nav doit suivre la MÊME langue que la page (mission section 9)");

  root.unmount();
  container.remove();
});

test("P2B-B DOM: langue commerçant EN (staff_receipt_language='en') -> page ET onglet nav en anglais, cohérents (ferme PAY-P2B-B-02/09)", async (t) => {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "restaurant_users") return mockRestaurantUsersFrom();
    if (table === "restaurant_configs") return mockRestaurantConfigsFrom("en");
    throw new Error(`table inattendue : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_merchant_payment_provider_config") {
      return {
        data: [
          {
            provider_code: "monetico",
            mode: "live",
            configuration_status: "verified",
            is_enabled: true,
            last_verified_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
        error: null,
      };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });

  const { container, root } = render();
  await waitFor(
    () => container.querySelectorAll("section").length === 1 && container.textContent!.includes("Payment"),
    "page chargée en anglais"
  );

  assert.ok(container.textContent!.includes("Configuration enabled"), "libellé activé en anglais");
  assert.ok(container.textContent!.includes("Verified"), "statut en anglais");
  const paymentTab = Array.from(container.querySelectorAll("nav a")).find((a) =>
    a.getAttribute("href")?.includes("/dashboard/payment")
  );
  assert.ok(paymentTab, "l'onglet Paiement doit exister dans la nav");
  assert.equal(paymentTab!.textContent, "Payment", "l'onglet nav doit suivre la MÊME langue que la page (mission section 9)");

  root.unmount();
  container.remove();
});

test("P2B-B DOM: langue commerçant AR (staff_receipt_language='ar') -> page ET onglet nav en arabe, RTL appliqué, cohérents (ferme PAY-P2B-B-02/09/11)", async (t) => {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "restaurant_users") return mockRestaurantUsersFrom();
    if (table === "restaurant_configs") return mockRestaurantConfigsFrom("ar");
    throw new Error(`table inattendue : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_merchant_payment_provider_config") {
      return {
        data: [
          {
            provider_code: "monetico",
            mode: "live",
            configuration_status: "verified",
            is_enabled: true,
            last_verified_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
        error: null,
      };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });

  const { container, root } = render();
  await waitFor(
    () => container.querySelectorAll("section").length === 1 && container.textContent!.includes("الدفع"),
    "page chargée en arabe"
  );

  assert.ok(container.textContent!.includes("الإعداد مُفعّل"), "libellé activé en arabe");
  assert.ok(container.textContent!.includes("تم التحقق"), "statut en arabe");
  const mainEl = container.querySelector("main");
  assert.equal(mainEl?.getAttribute("dir"), "rtl", "la page doit passer en RTL pour l'arabe (mission section 11)");
  const paymentTab = Array.from(container.querySelectorAll("nav a")).find((a) =>
    a.getAttribute("href")?.includes("/dashboard/payment")
  );
  assert.ok(paymentTab, "l'onglet Paiement doit exister dans la nav");
  assert.equal(paymentTab!.textContent, "الدفع", "l'onglet nav doit suivre la MÊME langue que la page (mission section 9)");

  root.unmount();
  container.remove();
});

test("P2B-B DOM: navigation Dashboard -- stratégie explicite anti-débordement mobile (flex-wrap), les 6 onglets restent tous dans le flux normal, aucun n'est masqué/inatteignable (ferme PAY-P2B-B-03). Note honnête (mission section 12) : ce harnais (jsdom) ne calcule pas de mise en page CSS réelle -- cette preuve est structurelle/DOM (classe flex-wrap appliquée + absence de tout onglet caché), PAS une capture visuelle à largeur réduite dans un navigateur réel, qui n'est pas disponible dans cet environnement.", async (t) => {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "restaurant_users") return mockRestaurantUsersFrom();
    throw new Error(`table inattendue : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_merchant_payment_provider_config") return { data: [], error: null };
    throw new Error(`RPC inattendue : ${name}`);
  });

  const { container, root } = render();
  await waitFor(() => container.textContent!.includes("n'est pas encore configuré"), "page chargée");

  const navEl = container.querySelector("nav");
  assert.ok(navEl, "la nav du Dashboard doit exister");
  assert.ok(
    navEl!.className.includes("flex-wrap"),
    "la nav doit porter la classe flex-wrap (stratégie anti-débordement mobile)"
  );

  const tabs = Array.from(navEl!.querySelectorAll("a"));
  assert.equal(tabs.length, 6, "les 6 onglets doivent tous être présents dans le DOM");
  for (const tabEl of tabs) {
    assert.notEqual((tabEl as HTMLElement).hidden, true, "aucun onglet ne doit être masqué (hidden)");
    assert.notEqual(tabEl.getAttribute("aria-hidden"), "true", "aucun onglet ne doit être aria-hidden");
    assert.ok(
      !(tabEl as HTMLElement).className.split(/\s+/).includes("hidden"),
      "aucun onglet ne doit porter une classe utilitaire 'hidden'"
    );
  }

  root.unmount();
  container.remove();
});

test("P2B-B DOM: sur /dashboard/payment, l'onglet Paiement est actif ET l'onglet Commandes ne l'est JAMAIS (reconfirmation non-régression L1B-02, mission section 13)", async (t) => {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "restaurant_users") return mockRestaurantUsersFrom();
    throw new Error(`table inattendue : ${table}`);
  });
  t.mock.method(supabase, "rpc", async (name: string) => {
    if (name === "get_merchant_payment_provider_config") return { data: [], error: null };
    throw new Error(`RPC inattendue : ${name}`);
  });

  const { container, root } = render();
  await waitFor(() => container.textContent!.includes("n'est pas encore configuré"), "page chargée");

  const navEl = container.querySelector("nav")!;
  const links = Array.from(navEl.querySelectorAll("a"));
  const paymentTab = links.find((a) => a.getAttribute("href")?.includes("/dashboard/payment"));
  const ordersTab = links.find((a) => a.getAttribute("href") === "/dashboard?r=r-test-1");

  assert.ok(paymentTab, "onglet Paiement introuvable");
  assert.ok(ordersTab, "onglet Commandes introuvable");
  assert.ok(paymentTab!.className.includes("bg-stone-900"), "l'onglet Paiement doit être actif sur /dashboard/payment");
  assert.ok(
    !ordersTab!.className.includes("bg-stone-900"),
    "l'onglet Commandes ne doit JAMAIS être actif sur /dashboard/payment (L1B-02)"
  );

  root.unmount();
  container.remove();
});

// ====================================================================
// SCANYM — PAYMENT P2B-B v3 CORRECTION — ferme la partie restante de
// PAY-P2B-B-01 : le Work a prouvé qu'un unique rendu React pouvait
// encore afficher `restaurantId = B` avec les `rows` de A (écart de
// rendu SYNCHRONE, pas seulement une réponse RPC tardive). Le test
// principal ci-dessous (l'assertion d'audit immédiate) n'utilise
// délibérément AUCUN waitFor/setTimeout/flush -- il inspecte le tout
// premier état React observable après l'événement de sélection,
// pendant que la requête RPC de B reste volontairement NON résolue.
// ====================================================================

test("P2B-B DOM: bascule IMMÉDIATE A -> B -- au tout premier état React observable après l'événement de sélection (SANS waitFor, SANS attendre B, la RPC de B restant délibérément NON résolue), AUCUNE donnée de A n'est visible (garantie de PROPRIÉTÉ des données -- ferme le reste de PAY-P2B-B-01, mission v3 section 9/10/11)", async (t) => {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "restaurant_users") return mockTwoRestaurantsFrom();
    throw new Error(`table inattendue : ${table}`);
  });

  // La RPC pour B reste délibérément non résolue pendant tout ce test
  // (mission v3 section 11 : "keep B RPC deliberately unresolved while
  // checking the DOM" -- prouve que l'absence de A ne dépend PAS d'une
  // réponse de B, mais de l'invalidation synchrone elle-même).
  const deferredB = makeDeferred<{ data: unknown; error: null }>();
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    if (name !== "get_merchant_payment_provider_config") {
      throw new Error(`RPC inattendue : ${name}`);
    }
    if (args.p_restaurant_id === "r-test-1") {
      return {
        data: [
          {
            provider_code: "monetico",
            mode: "live",
            configuration_status: "verified",
            is_enabled: true,
            last_verified_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
        error: null,
      };
    }
    if (args.p_restaurant_id === "r-test-2") return deferredB.promise;
    throw new Error(`restaurant inattendu : ${args.p_restaurant_id}`);
  });

  const { container, root } = render();
  await waitFor(() => container.querySelectorAll("section").length === 1, "carte A rendue (préparation, pas la mesure elle-même)");
  assert.ok(container.textContent!.includes("Monetico"));
  assert.ok(container.textContent!.includes("Vérifié"));
  assert.ok(container.textContent!.includes("Production"));

  const select = container.querySelector("select") as HTMLSelectElement | null;
  assert.ok(select, "le sélecteur d'établissement doit exister (mappings.length > 1)");

  // React.act garantit que TOUT le travail synchrone déclenché par cet
  // événement (setState groupés + rendu + commit) est appliqué AVANT
  // que cet appel ne retourne -- c'est la seule primitive utilisée ici
  // (mission section 10 : "Use proper React Testing Library event
  // semantics / act handling only as required by React itself"), PAS
  // un waitFor, PAS un délai arbitraire, et deferredB reste NON résolu
  // pendant toute la durée de cet appel.
  await actWithFlag(() => {
    select!.value = "r-test-2";
    select!.dispatchEvent(new window.Event("change", { bubbles: true }));
  });

  // ASSERTION PRINCIPALE (mission v3 section 9) -- immédiatement après
  // le retour de act(), SANS attente supplémentaire d'aucune sorte :
  assert.equal(select!.value, "r-test-2", "le sélecteur doit refléter B immédiatement");
  assert.equal(
    container.querySelectorAll("section").length,
    0,
    "AUCUNE carte ne doit être visible immédiatement après la sélection de B, alors même que la RPC de B n'a pas encore répondu"
  );
  assert.ok(
    !container.textContent!.includes("Monetico"),
    "le prestataire de A ne doit plus apparaître immédiatement après la sélection de B"
  );
  assert.ok(
    !container.textContent!.includes("Vérifié"),
    "le statut de A ne doit plus apparaître immédiatement après la sélection de B"
  );
  assert.ok(
    !container.textContent!.includes("Configuration activée"),
    "l'état activé de A ne doit plus apparaître immédiatement après la sélection de B"
  );
  assert.ok(!container.querySelector(".bg-amber-50"), "aucune erreur ne doit apparaître pendant ce chargement encore en vol");

  root.unmount();
  container.remove();
});

test("P2B-B DOM: réponses HORS-ORDRE -- ÉCHEC tardif de A après SUCCÈS de B -- B reste affiché inchangé, l'échec tardif de A est intégralement ignoré (mission v3 section 13, complète la couverture out-of-order déjà présente pour le succès tardif)", async (t) => {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "restaurant_users") return mockTwoRestaurantsFrom();
    throw new Error(`table inattendue : ${table}`);
  });

  let rejectA!: (err: unknown) => void;
  const deferredAFail = new Promise<never>((_res, rej) => {
    rejectA = rej;
  });
  const deferredB = makeDeferred<{ data: unknown; error: null }>();
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    if (name !== "get_merchant_payment_provider_config") {
      throw new Error(`RPC inattendue : ${name}`);
    }
    if (args.p_restaurant_id === "r-test-1") return deferredAFail;
    if (args.p_restaurant_id === "r-test-2") return deferredB.promise;
    throw new Error(`restaurant inattendu : ${args.p_restaurant_id}`);
  });

  const { container, root } = render();
  await flush(20);
  await actWithFlag(() => {
    selectRestaurantOption(container, "r-test-2");
  });
  await flush(20);

  deferredB.resolve({
    data: [
      {
        provider_code: "monetico",
        mode: "test",
        configuration_status: "configured",
        is_enabled: false,
        last_verified_at: null,
        updated_at: null,
      },
    ],
    error: null,
  });
  await waitFor(() => container.querySelectorAll("section").length === 1, "carte B rendue");
  assert.ok(container.textContent!.includes("Configuré"));

  // A échoue TARDIVEMENT, une fois B déjà courant -- catch() interne
  // évite tout rejet non intercepté (le mock lui-même reste une
  // promesse standard, aucun handler global requis).
  rejectA(new Error("42501: permission denied for restaurant r-test-1 (réponse tardive)"));
  await flush(100);

  assert.equal(
    container.querySelectorAll("section").length,
    1,
    "B doit rester affiché, l'échec tardif de A ne doit ni le retirer ni le remplacer par une erreur"
  );
  assert.ok(container.textContent!.includes("Configuré"), "B doit rester strictement inchangé");
  assert.ok(
    !container.querySelector(".bg-amber-50"),
    "l'échec tardif de A ne doit JAMAIS déclencher l'affichage d'une erreur à la place de B"
  );
  assert.ok(!container.textContent!.includes("42501"));
  assert.ok(!container.textContent!.includes("permission denied"));

  root.unmount();
  container.remove();
});

test("P2B-B DOM: bascule RAPIDE A -> B -> C -- seul C peut finalement s'afficher, aucune configuration transitoire de A ou B ne doit jamais apparaître sous C (régression multi-bascule, mission v3 section 14)", async (t) => {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "restaurant_users") return mockThreeRestaurantsFrom();
    throw new Error(`table inattendue : ${table}`);
  });

  const deferredB = makeDeferred<{ data: unknown; error: null }>();
  const deferredC = makeDeferred<{ data: unknown; error: null }>();
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    if (name !== "get_merchant_payment_provider_config") {
      throw new Error(`RPC inattendue : ${name}`);
    }
    if (args.p_restaurant_id === "r-test-1") {
      return {
        data: [
          {
            provider_code: "monetico",
            mode: "live",
            configuration_status: "verified",
            is_enabled: true,
            last_verified_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
        error: null,
      };
    }
    if (args.p_restaurant_id === "r-test-2") return deferredB.promise;
    if (args.p_restaurant_id === "r-test-3") return deferredC.promise;
    throw new Error(`restaurant inattendu : ${args.p_restaurant_id}`);
  });

  const { container, root } = render();
  await waitFor(() => container.querySelectorAll("section").length === 1, "carte A rendue");

  await actWithFlag(() => {
    selectRestaurantOption(container, "r-test-2");
  });
  await actWithFlag(() => {
    selectRestaurantOption(container, "r-test-3");
  });

  // Ni A ni B ne doivent être visibles pendant que C est encore en vol
  // (B et C restent tous deux non résolus à ce stade).
  assert.equal(container.querySelectorAll("section").length, 0);
  assert.ok(!container.textContent!.includes("Monetico"));

  deferredC.resolve({
    data: [
      {
        provider_code: "future_unknown_provider",
        mode: "test",
        configuration_status: "configured",
        is_enabled: false,
        last_verified_at: null,
        updated_at: null,
      },
    ],
    error: null,
  });
  await waitFor(() => container.querySelectorAll("section").length === 1, "carte C rendue");
  assert.ok(container.textContent!.includes("Future Unknown Provider"));

  // B répond tardivement, après C -- ne doit RIEN changer.
  deferredB.resolve({
    data: [
      {
        provider_code: "late_stale_provider_b",
        mode: "live",
        configuration_status: "verified",
        is_enabled: true,
        last_verified_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
    error: null,
  });
  await flush(100);

  assert.equal(
    container.querySelectorAll("section").length,
    1,
    "toujours une seule carte -- la réponse tardive de B (après C) n'a rien ajouté ni remplacé"
  );
  assert.ok(!container.textContent!.includes("Late Stale Provider B"), "B tardif ne doit jamais atteindre le DOM une fois C courant");
  assert.ok(container.textContent!.includes("Future Unknown Provider"), "C doit rester affiché, strictement inchangé");

  root.unmount();
  container.remove();
});

after(async () => {
  await new Promise((r) => setTimeout(r, 50));
  window.close();
  await esbuild.stop();
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    if (typeof h.unref === "function") h.unref();
  }
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  delete (globalThis as any).navigator;
  delete (globalThis as any).HTMLElement;
  delete (globalThis as any).Event;
  delete (globalThis as any).requestAnimationFrame;
  delete (globalThis as any).cancelAnimationFrame;
  delete (globalThis as any).__mockPathname;
});
