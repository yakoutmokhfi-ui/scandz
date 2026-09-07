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
// Scanym — MERCHANT LEGAL & TAX PROFILE — preuve comportementale
// RÉELLE (rendu React dans un vrai DOM, RPC réellement interceptées)
// de app/dashboard/settings/page.tsx, section légale/fiscale
// (public.receipt_settings).
//
// v1.2 -- ferme MLTP-V11-DASHBOARD-GUARD-ORDER-01 (contre-audit Work
// sur v1.1) : v1.1 ne prouvait que l'absence d'appel à
// update_receipt_settings lorsque la garde bloquait -- le Work a
// démontré que plusieurs RPC MUTANTES (couleurs, maps, identité,
// bg_color, réseaux sociaux, langues) pouvaient encore s'exécuter
// AVANT cette garde, la garde ne protégeant alors que l'écriture
// Legal/Tax elle-même, pas le flux de soumission entier. Ce fichier
// remplace intégralement tests/lot-merchant-legal-tax-profile-v1.1-dom.test.ts
// (renommé, plus de suffixe de version dans le nom -- le contenu suit
// désormais le lot dans son ensemble, comme les autres fichiers de ce
// lot) : chaque scénario ci-dessous piste TOUTES les RPC mutantes
// déclenchées par submit() (pas seulement update_receipt_settings) et
// prouve qu'AUCUNE ne s'exécute tant que la garde de disponibilité/
// propriété du profil légal/fiscal n'est pas satisfaite -- exactement
// les 4 scénarios A/B/C/D exigés par le mandat v1.2.
//
// Patron esbuild/jsdom/supabase déjà établi et audité dans ce projet --
// voir tests/v109c-dashboard-payment.dom.test.ts (mêmes principes,
// RPC réellement interceptées via t.mock.method pour exercer le VRAI
// service lib/services/dashboard.ts, jamais un double du service).
// Aucune assertion de ce fichier n'est affaiblie par `|| true` ou tout
// autre échappatoire équivalent (mandat, MLTP-V1-TEST-COVERAGE-01).
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard/settings?r=r-test-1",
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

(globalThis as any).__mockPathname = "/dashboard/settings";

const MOCK_NAV = `
export function usePathname() {
  return (globalThis as any).__mockPathname;
}
// Référence STABLE entre les rendus (comme le vrai next/navigation) --
// voir tests/v109c-dashboard-payment.dom.test.ts pour la justification
// complète de ce détail de harnais (pas du code applicatif réel).
const mockRouter = { replace: () => {}, push: () => {} };
export function useRouter() {
  return mockRouter;
}
`;

const MOCK_AUTH = `
export async function getUser() {
  return { id: "u-test-1", email: "operator@test.example" };
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
export { default as SettingsPage } from "@/app/dashboard/settings/page";
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-legal-"));
const tmpFile = path.join(tmpDir, "SettingsPage.mjs");
writeFileSync(tmpFile, code);
const { SettingsPage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `check()` peut légitimement lever (ex. la section légale/fiscale pas
// encore montée au tout premier passage) -- une telle levée signifie
// simplement "pas encore prêt", jamais un échec du test lui-même :
// seul le dépassement du délai imparti doit faire échouer waitFor.
async function waitFor(check: () => boolean, description: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    let ready = false;
    try {
      ready = check();
    } catch {
      ready = false;
    }
    if (ready) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout (${timeoutMs}ms) : ${description}`);
    }
    await flush(10);
  }
}

function makeDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Deux établissements, rôle 'staff' pour les DEUX -- combiné à
// is_scanym_operator() = true (mocké plus bas), cela place la page en
// isOperatorOnlyMode=true de façon STABLE pour ce fichier entier :
// canEdit=true (autorisé, posture opérateur) mais canEditFull=false
// (jamais owner/manager), ce qui exempte délibérément ces tests des
// champs WhatsApp/adresse/horaires/langue (hors périmètre de ce lot,
// portée déjà couverte par v70-02) tout en exerçant EXACTEMENT le
// profil d'autorisation "opérateur" visé par
// MLTP-V1-OPERATOR-READ-WRITE-01. Les RPC couleurs/maps/identité/
// bg_color/réseaux sociaux/langues restent, elles, TOUJOURS appelées
// (V70-02, owner/manager COMME opérateur) -- c'est précisément ce que
// MLTP-V11-DASHBOARD-GUARD-ORDER-01 exige de bloquer tant que le
// profil légal/fiscal n'est pas prêt.
function mockRestaurantUsersFromTwoStaff() {
  return {
    select: () => ({
      order: async () => ({
        data: [
          {
            restaurant_id: "r-test-1",
            role: "staff",
            restaurants: { id: "r-test-1", name: "Resto A", slug: "resto-a" },
          },
          {
            restaurant_id: "r-test-2",
            role: "staff",
            restaurants: { id: "r-test-2", name: "Resto B", slug: "resto-b" },
          },
        ],
        error: null,
      }),
    }),
  };
}

function mockRestaurantConfigsFrom() {
  return {
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: {
            staff_receipt_language: "fr",
            address: null,
            opening_hours: null,
            currency: "DZD",
            whatsapp_number: "",
            logo_url: null,
            cover_url: null,
            primary_color: null,
            secondary_color: null,
            accent_color: null,
            maps_url: null,
            display_name: null,
            intro_text: null,
            announcement_text: null,
            announcement_active: false,
            bg_color: null,
            instagram_url: null,
            tiktok_url: null,
            facebook_url: null,
            source_language: "fr",
          },
          error: null,
        }),
      }),
    }),
  };
}

function mockSupportedLanguagesFrom() {
  return {
    select: () => ({
      order: async () => ({ data: [], error: null }),
    }),
  };
}

// RPC MUTANTES déclenchées inconditionnellement par submit() (V70-02 :
// owner/manager COMME opérateur), hors du périmètre de ce lot mais
// dont l'ORDRE d'exécution relative à la garde légale/fiscale est
// exactement ce que MLTP-V11-DASHBOARD-GUARD-ORDER-01 concerne. Toute
// RPC de ce nom est enregistrée dans `mutatingCalls` par
// `installRpcMock` ci-dessous, jamais seulement update_receipt_settings.
const UNCONDITIONAL_MUTATING_RPCS = [
  "update_restaurant_colors",
  "update_restaurant_maps_url",
  "update_restaurant_identity",
  "update_restaurant_bg_color",
  "update_restaurant_social_links",
  "update_restaurant_languages",
];
const READ_ONLY_RPCS = new Set(["get_receipt_settings", "get_restaurant_active_languages", "is_scanym_operator"]);

function installFromMocks(t: any) {
  t.mock.method(supabase, "from", (table: string) => {
    if (table === "restaurant_users") return mockRestaurantUsersFromTwoStaff();
    if (table === "restaurant_configs") return mockRestaurantConfigsFrom();
    if (table === "supported_languages") return mockSupportedLanguagesFrom();
    throw new Error(`table inattendue : ${table}`);
  });
}

/** Construit le dispatcher RPC pour un test : `getReceiptSettingsImpl`
 *  pilote la réponse de lecture par restaurant (le cœur de chaque
 *  scénario) ; toute RPC MUTANTE rencontrée (la liste ci-dessus +
 *  update_receipt_settings) est enregistrée dans `mutatingCalls`,
 *  jamais seulement suivie pour update_receipt_settings -- c'est
 *  exactement la preuve exigée par le mandat v1.2 ("Tests must assert
 *  zero mutation RPCs before readiness, not only that
 *  update_receipt_settings was skipped"). */
function installRpcMock(
  t: any,
  getReceiptSettingsImpl: (args: any) => Promise<{ data: unknown; error: unknown }>
): { mutatingCalls: Array<{ name: string; args: any }> } {
  const mutatingCalls: Array<{ name: string; args: any }> = [];
  t.mock.method(supabase, "rpc", async (name: string, args: any) => {
    if (name === "is_scanym_operator") return { data: true, error: null };
    if (name === "get_restaurant_active_languages") {
      return { data: [{ code: "fr", label: "Français", dir: "ltr", display_order: 0 }], error: null };
    }
    if (name === "get_receipt_settings") return getReceiptSettingsImpl(args);
    if (UNCONDITIONAL_MUTATING_RPCS.includes(name) || name === "update_receipt_settings") {
      mutatingCalls.push({ name, args });
      return { data: null, error: null };
    }
    throw new Error(`RPC inattendue : ${name}`);
  });
  return { mutatingCalls };
}

function render() {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(SettingsPage));
  return { container, root };
}

/** Localise la <section> du profil légal/fiscal via son titre (i18n
 *  fr, stLegalTitle -- lib/i18n.ts) : seul repère stable, aucun
 *  attribut id/data-testid n'existe sur cette section (contrat DOM
 *  actuel de la page, non modifié par ce lot de tests). */
function getLegalSection(container: HTMLElement): HTMLElement {
  const h3 = Array.from(container.querySelectorAll("h3")).find(
    (el) => el.textContent === "Informations légales et fiscales"
  );
  assert.ok(h3, "la section légale/fiscale (stLegalTitle) doit exister");
  const section = h3!.closest("section");
  assert.ok(section, "stLegalTitle doit être contenu dans une <section>");
  return section as HTMLElement;
}

function legalBusinessNameInput(container: HTMLElement): HTMLInputElement {
  const section = getLegalSection(container);
  const inputs = section.querySelectorAll("input");
  assert.ok(inputs.length > 0, "la section légale/fiscale doit contenir au moins un champ texte");
  return inputs[0] as HTMLInputElement;
}

function legalNameInput(container: HTMLElement): HTMLInputElement {
  const section = getLegalSection(container);
  const inputs = section.querySelectorAll("input");
  assert.ok(inputs.length > 1, "la section légale/fiscale doit contenir au moins deux champs texte");
  return inputs[1] as HTMLInputElement;
}

function selectRestaurantOption(container: HTMLElement, value: string) {
  const select = container.querySelector("select") as HTMLSelectElement | null;
  assert.ok(select, "le sélecteur d'établissement doit exister (mappings.length > 1)");
  select!.value = value;
  select!.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function getSaveButton(container: HTMLElement): HTMLButtonElement {
  const form = container.querySelector("form") as HTMLFormElement | null;
  assert.ok(form, "le formulaire doit exister");
  const button = form!.querySelector('button[type="submit"]') as HTMLButtonElement | null;
  assert.ok(button, "le bouton d'enregistrement doit exister");
  return button!;
}

/** Déclenche la soumission directement sur le <form> (jamais un simple
 *  clic sur le bouton) : un clic sur un bouton `disabled` est
 *  intercepté par le navigateur AVANT même d'atteindre le gestionnaire
 *  -- passer par le formulaire prouve que la garde EN TÊTE de submit()
 *  bloque la mutation par elle-même, en défense en profondeur, même si
 *  la soumission était déclenchée par une autre voie que ce bouton
 *  précis (clavier, resoumission programmatique, etc.). */
function submitForm(container: HTMLElement) {
  const form = container.querySelector("form") as HTMLFormElement | null;
  assert.ok(form, "le formulaire doit exister");
  form!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

// --------------------------------------------------------------------
// Scénario A -- bascule pendant que la lecture de B est encore EN VOL,
// tentative de soumission. Ferme MLTP-V11-DASHBOARD-GUARD-ORDER-01.
// --------------------------------------------------------------------

test("MLTP DOM Scénario A: A chargé, bascule vers B EN VOL (lecture non résolue), tentative de soumission -- bouton désactivé, ZÉRO RPC mutante (couleurs/maps/identité/social/langues/legal-tax), aucune mutation", async (t) => {
  installFromMocks(t);
  const deferredB = makeDeferred<{ data: unknown; error: null }>();
  const { mutatingCalls } = installRpcMock(t, async (args: any) => {
    if (args.p_restaurant_id === "r-test-1") {
      return {
        data: [
          {
            business_name: "Restaurant A Legal",
            legal_name: "A Legal SARL",
            legal_address: null, phone: null, email: null, tax_identifier: null,
            registration_number: null, tax_label: "TVA", default_tax_rate: 19,
            prices_include_tax: true, footer_text: null, show_tax_summary: false,
            paper_width_mm: 58, restaurant_country: "DZ",
          },
        ],
        error: null,
      };
    }
    if (args.p_restaurant_id === "r-test-2") return deferredB.promise;
    throw new Error(`restaurant inattendu : ${args.p_restaurant_id}`);
  });

  const { container, root } = render();
  await waitFor(() => legalBusinessNameInput(container).value === "Restaurant A Legal", "champs de A peuplés");
  assert.equal(getSaveButton(container).disabled, false, "A prêt -- le bouton doit être activé");

  selectRestaurantOption(container, "r-test-2");
  await waitFor(() => legalBusinessNameInput(container).value === "", "champs vidés immédiatement après la bascule vers B");
  assert.equal(getSaveButton(container).disabled, true, "B encore en vol -- le bouton doit être désactivé");

  submitForm(container);
  await flush(100);

  assert.equal(mutatingCalls.length, 0, "ZÉRO RPC mutante ne doit s'exécuter -- la garde bloque le flux de soumission ENTIER, pas seulement update_receipt_settings");
  assert.equal(getSaveButton(container).disabled, true, "le bouton doit rester désactivé après la tentative");
  assert.ok(
    container.textContent!.includes("Les informations légales et fiscales ne sont pas encore chargées"),
    "l'erreur dédiée stLegalNotReady doit être affichée -- la garde a bien été atteinte en tête de submit()"
  );

  root.unmount();
  container.remove();
});

// --------------------------------------------------------------------
// Scénario B -- A chargé, bascule vers B, la lecture de B ÉCHOUE,
// tentative de soumission.
// --------------------------------------------------------------------

test("MLTP DOM Scénario B: A chargé, bascule vers B, la lecture de B ÉCHOUE, tentative de soumission -- bouton désactivé, ZÉRO RPC mutante, état de A intégralement effacé, aucune fuite de A vers B", async (t) => {
  installFromMocks(t);
  const { mutatingCalls } = installRpcMock(t, async (args: any) => {
    if (args.p_restaurant_id === "r-test-1") {
      return {
        data: [
          {
            business_name: "Restaurant A Legal",
            legal_name: "A Legal SARL",
            legal_address: null, phone: null, email: null, tax_identifier: null,
            registration_number: null, tax_label: "TVA", default_tax_rate: 19,
            prices_include_tax: true, footer_text: null, show_tax_summary: false,
            paper_width_mm: 58, restaurant_country: "DZ",
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
  await waitFor(() => legalBusinessNameInput(container).value === "Restaurant A Legal", "champs de A peuplés");

  selectRestaurantOption(container, "r-test-2");
  await waitFor(
    () => container.textContent!.includes("Impossible de charger les informations légales et fiscales. Réessayez."),
    "erreur dédiée affichée pour l'échec de lecture de B"
  );

  assert.equal(legalBusinessNameInput(container).value, "", "les champs de A doivent avoir disparu intégralement");
  assert.equal(legalNameInput(container).value, "");
  assert.equal(getSaveButton(container).disabled, true, "lecture de B en échec -- le bouton doit être désactivé");
  assert.ok(!container.textContent!.includes("42501"), "aucun détail backend brut ne doit fuiter");
  assert.ok(!container.textContent!.includes("permission denied"));

  submitForm(container);
  await flush(100);

  assert.equal(mutatingCalls.length, 0, "ZÉRO RPC mutante -- ni couleurs/maps/identité/social/langues, ni update_receipt_settings");
  assert.equal(getSaveButton(container).disabled, true);
  assert.ok(
    container.textContent!.includes("Les informations légales et fiscales ne sont pas encore chargées"),
    "l'erreur dédiée stLegalNotReady doit être affichée après la tentative"
  );

  root.unmount();
  container.remove();
});

// --------------------------------------------------------------------
// Scénario C -- réponse HORS-ORDRE : A démarre, bascule vers B, B
// résout AVANT A, A résout ensuite (tardivement) -- soumission de B.
// --------------------------------------------------------------------

test("MLTP DOM Scénario C: A démarre, bascule vers B, B résout EN PREMIER, A résout ENSUITE (tardivement) -- la réponse de A est ignorée, B reste autoritaire, la soumission ne mute QUE B", async (t) => {
  installFromMocks(t);
  const deferredA = makeDeferred<{ data: unknown; error: null }>();
  const deferredB = makeDeferred<{ data: unknown; error: null }>();
  const { mutatingCalls } = installRpcMock(t, async (args: any) => {
    if (args.p_restaurant_id === "r-test-1") return deferredA.promise;
    if (args.p_restaurant_id === "r-test-2") return deferredB.promise;
    throw new Error(`restaurant inattendu : ${args.p_restaurant_id}`);
  });

  const { container, root } = render();
  // A est demandée dès le montage (?r=r-test-1) mais reste EN VOL.
  await waitFor(() => container.querySelector("select") !== null, "sélecteur d'établissement monté");
  await flush(20);
  assert.equal(legalBusinessNameInput(container).value, "", "A encore en vol -- aucun champ peuplé");

  selectRestaurantOption(container, "r-test-2");
  await flush(20);
  assert.equal(getSaveButton(container).disabled, true, "B encore en vol -- bouton désactivé");

  // B répond EN PREMIER.
  deferredB.resolve({
    data: [
      {
        business_name: "Restaurant B Legal",
        legal_name: "B Legal SARL",
        legal_address: null, phone: null, email: null, tax_identifier: null,
        registration_number: null, tax_label: "TVA", default_tax_rate: 20,
        prices_include_tax: true, footer_text: null, show_tax_summary: false,
        paper_width_mm: 58, restaurant_country: "FR",
      },
    ],
    error: null,
  });
  await waitFor(() => legalBusinessNameInput(container).value === "Restaurant B Legal", "champs de B peuplés");
  assert.equal(getSaveButton(container).disabled, false, "B prêt -- bouton activé");

  // A répond ENSUITE (tardivement), données reconnaissables -- cette
  // réponse périmée ne doit JAMAIS écraser B ni son état "prêt".
  deferredA.resolve({
    data: [
      {
        business_name: "STALE A DATA",
        legal_name: "STALE A SARL",
        legal_address: null, phone: null, email: null, tax_identifier: null,
        registration_number: null, tax_label: "TVA", default_tax_rate: 0,
        prices_include_tax: true, footer_text: null, show_tax_summary: false,
        paper_width_mm: 58, restaurant_country: "DZ",
      },
    ],
    error: null,
  });
  await flush(100);

  assert.equal(legalBusinessNameInput(container).value, "Restaurant B Legal", "B doit rester affiché, strictement inchangé");
  assert.ok(!container.textContent!.includes("STALE A DATA"), "la réponse tardive de A ne doit jamais atteindre le DOM");
  assert.equal(getSaveButton(container).disabled, false, "B reste prêt malgré la réponse tardive de A");

  submitForm(container);
  await waitFor(() => mutatingCalls.some((c) => c.name === "update_receipt_settings"), "update_receipt_settings appelée pour B");

  const legalCall = mutatingCalls.find((c) => c.name === "update_receipt_settings")!;
  assert.equal(legalCall.args.p_restaurant_id, "r-test-2", "l'écriture Legal/Tax doit cibler B, jamais A");
  assert.equal(legalCall.args.p_business_name, "Restaurant B Legal");
  assert.ok(!mutatingCalls.some((c) => c.args?.p_restaurant_id === "r-test-1"), "AUCUNE RPC mutante ne doit cibler A -- la réponse tardive de A n'a rien déclenché");
  // Les RPC mutantes inconditionnelles (couleurs/maps/identité/social/
  // langues, V70-02) doivent elles aussi cibler B exclusivement.
  for (const call of mutatingCalls) {
    assert.equal(call.args.p_restaurant_id, "r-test-2", `${call.name} doit cibler B, jamais A`);
  }

  root.unmount();
  container.remove();
});

// --------------------------------------------------------------------
// Scénario D -- bascule vers B, lecture réussie mais AUCUNE ligne
// (confirmée) -- soumission (création autorisée), aucune fuite de A.
// --------------------------------------------------------------------

test("MLTP DOM Scénario D: A chargé (ligne existante), bascule vers B, lecture réussie SANS AUCUNE ligne (confirmée) -- soumission autorisée, l'écriture cible B avec des defaults sûrs, aucune donnée de A ne fuit", async (t) => {
  installFromMocks(t);
  const { mutatingCalls } = installRpcMock(t, async (args: any) => {
    if (args.p_restaurant_id === "r-test-1") {
      return {
        data: [
          {
            business_name: "Restaurant A Legal",
            legal_name: "A Legal SARL",
            legal_address: null, phone: null, email: null, tax_identifier: null,
            registration_number: null, tax_label: "TVA", default_tax_rate: 19,
            prices_include_tax: true, footer_text: null, show_tax_summary: false,
            paper_width_mm: 58, restaurant_country: "DZ",
          },
        ],
        error: null,
      };
    }
    if (args.p_restaurant_id === "r-test-2") return { data: [], error: null };
    throw new Error(`restaurant inattendu : ${args.p_restaurant_id}`);
  });

  const { container, root } = render();
  await waitFor(() => legalBusinessNameInput(container).value === "Restaurant A Legal", "champs de A peuplés");

  selectRestaurantOption(container, "r-test-2");
  await waitFor(() => getSaveButton(container).disabled === false, "B -- \"aucune ligne\" confirmée -- bouton doit se réactiver (état prêt valide)");
  assert.equal(legalBusinessNameInput(container).value, "", "B sans aucune ligne -- defaults sûrs, jamais la donnée de A");
  assert.ok(!container.textContent!.includes("Restaurant A Legal"), "aucune trace de A ne doit rester visible");

  submitForm(container);
  await waitFor(() => mutatingCalls.some((c) => c.name === "update_receipt_settings"), "update_receipt_settings appelée -- création autorisée pour B");

  const legalCall = mutatingCalls.find((c) => c.name === "update_receipt_settings")!;
  assert.equal(legalCall.args.p_restaurant_id, "r-test-2", "l'écriture doit cibler B");
  assert.equal(legalCall.args.p_business_name, null, "defaults sûrs -- jamais la donnée de A (\"Restaurant A Legal\")");
  assert.equal(legalCall.args.p_tax_label, "TVA", "default sûr documenté");
  assert.equal(legalCall.args.p_prices_include_tax, true, "default sûr documenté");
  assert.equal(legalCall.args.p_show_tax_summary, false, "default sûr documenté");
  assert.ok(!mutatingCalls.some((c) => c.args?.p_restaurant_id === "r-test-1"), "AUCUNE RPC mutante ne doit cibler A");
  for (const call of mutatingCalls) {
    assert.equal(call.args.p_restaurant_id, "r-test-2", `${call.name} doit cibler B, jamais A`);
  }

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
