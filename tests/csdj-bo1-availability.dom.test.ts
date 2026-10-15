import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";
import { settle } from "./helpers/dom-settle.ts";
import { CSDJ_BO1_WRITE_CONTRACT } from "../lib/availability-editor.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// CSDJ-BO-1 — RENDU RÉEL DE L'ONGLET « MISE À DISPOSITION » (jsdom).
//
// La page est rendue pour de vrai ; seuls les services sont doublés.
// Ce qui est prouvé ici :
//  - tout contrôle d'écriture et d'activation est INACTIF, avec sa
//    raison LISIBLE à côté (rôle, ou contrat d'écriture) ;
//  - aucun bouton de suppression n'existe (décision R2 n° 7) ;
//  - les contrôles CSDJ v1.2 ne sont jamais annoncés opérationnels
//    quand le serveur ne les porte pas ;
//  - le seau de capacité affiché suit la politique d'horaire, y compris
//    l'avertissement « journée entière » en heure libre ;
//  - l'aperçu affiche la réponse du serveur, motif nommé compris ;
//  - une réponse périmée d'un AUTRE établissement ne s'affiche jamais.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard/availability?r=r1",
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

const REPO_ROOT = process.cwd();

// Le vrai useRouter() de Next rend un objet STABLE entre deux rendus.
// Un double qui en fabriquerait un nouveau à chaque rendu relancerait
// l'effet de montage (dépendance [router]) et réimposerait le
// restaurant de l'URL -- un artefact de test, pas un défaut de la page.
const MOCK_NAV = `
const ROUTER = { replace: () => {}, push: () => {} };
export function usePathname() { return "/dashboard/availability"; }
export function useRouter() { return ROUTER; }
`;

const MOCK_AUTH = `
export async function getUser() { return { id: "u1" }; }
export async function signOut() {}
`;

const MOCK_DASHBOARD = `
export async function getMerchantRestaurants() { return (globalThis).__mappings; }
export async function getRestaurantSettings() { return { staff_receipt_language: "fr" }; }
`;

const MOCK_ESTABLISHMENTS = `
export async function isScanymOperator() { return (globalThis).__isOperator === true; }
export async function getEstablishmentSummary() { return { name: "Contexte opérateur" }; }
`;

// Les lectures sont scriptées PAR ÉTABLISSEMENT, et peuvent être
// différées : c'est ce qui permet de rejouer une réponse périmée.
const MOCK_AVAILABILITY = `
export async function getMerchantFulfillmentSchedules(id) {
  ((globalThis).__loadedIds ??= []).push(id);
  const plan = (globalThis).__plan[id];
  if (plan && plan.deferSchedules) {
    return new Promise((resolve) => { (globalThis).__pending.push(() => resolve(plan.schedules)); });
  }
  return plan ? plan.schedules : [];
}
export async function getMerchantFulfillmentSchedulesV12(id) {
  const plan = (globalThis).__plan[id];
  return plan && plan.v12 ? plan.v12 : { status: "absent" };
}
// Lecture AUTORITAIRE (remédiation R1) : ces suites n'éprouvent pas la
// concurrence, donc le double rend __configuration -- null par
// défaut, ce qui est une réponse LÉGITIME du contrat (« portée sans
// configuration ») et laisse les jetons à null. (Aucun accent grave
// ici : ce texte vit DANS un gabarit littéral.)
export async function getFulfillmentConfiguration(id, modeCode, ruleId) {
  ((globalThis).__configurationReads ??= []).push({ id, modeCode, ruleId });
  const plan = (globalThis).__configuration;
  if (typeof plan === "function") return plan(id, modeCode, ruleId);
  return plan ?? null;
}
export class FulfillmentConfigurationShapeError extends Error {}
export class AvailabilityWriteUnavailableError extends Error {
  constructor() {
    super("CSDJ_BO1_WRITE_CONTRACT_PENDING");
    this.name = "AvailabilityWriteUnavailableError";
    this.reason = "CSDJ_BO1_WRITE_CONTRACT_PENDING";
  }
}
export async function saveFulfillmentConfiguration(id, payload) {
  ((globalThis).__saveCalls ??= []).push({ id, payload });
  const handler = (globalThis).__saveHandler;
  // Sans gestionnaire injecté, le double se comporte comme le service
  // réel aujourd'hui : il REFUSE, parce que le contrat d'écriture n'est
  // pas disponible.
  if (!handler) throw new AvailabilityWriteUnavailableError();
  return handler(id, payload);
}
export async function getCheckoutFulfillmentSchedulePreview(args) {
  (globalThis).__previewArgs = args;
  return (globalThis).__previewResult;
}
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "@/lib/services/auth": MOCK_AUTH,
  "@/lib/services/dashboard": MOCK_DASHBOARD,
  "@/lib/services/establishments": MOCK_ESTABLISHMENTS,
  "@/lib/services/availability": MOCK_AVAILABILITY,
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
    contents: `export { default as AvailabilityPage } from "@/app/dashboard/availability/page";`,
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-bo1-"));
const tmpFile = path.join(tmpDir, "AvailabilityPage.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const { AvailabilityPage } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

const SCHEDULE_FIXED_SLOTS = {
  modeCode: "pickup",
  fulfillmentRuleId: null,
  timezone: "Europe/Paris",
  enabled: true,
  dateSelectionMode: "customer_selectable",
  slotSelectionMode: "fixed_slots",
  timeGranularityMinutes: null,
  leadTimeMinutes: 0,
  minLeadDays: 2,
  cutoffTime: "12:00:00",
  cutoffOffsetDays: 0,
  bookingHorizonDays: 14,
  windows: [],
  slots: [{ weekday: 2, slotKey: "matin", startsAt: "09:00", endsAt: "12:00" }],
  closures: [{ closedOn: "2026-12-25", label: "Noël" }],
};

const SCHEDULE_FREE_TIME = {
  ...SCHEDULE_FIXED_SLOTS,
  modeCode: "delivery",
  slotSelectionMode: "time_within_window",
  timeGranularityMinutes: 30,
  slots: [],
  windows: [{ weekday: 2, startsAt: "11:00", endsAt: "14:00" }],
};

const V12_AVAILABLE = {
  status: "available",
  rows: [
    {
      modeCode: "pickup",
      fulfillmentRuleId: null,
      scheduleMethodVersion: "v1.2",
      holidayCalendarId: null,
      preparationOnHolidays: "open",
      availabilityOnHolidays: "open",
      capacityEnabled: true,
      capacityMaxOrders: 12,
      preparationWeekdays: [1, 2, 3, 4, 5],
      preparationClosures: [{ closedOn: "2026-10-14", label: "Entretien four" }],
    },
  ],
};

function setup(options: {
  role?: string;
  isOperator?: boolean;
  plan?: Record<string, unknown>;
  mappings?: unknown[];
  previewResult?: unknown;
}) {
  (globalThis as any).__mappings =
    options.mappings ??
    [
      {
        restaurant_id: "r1",
        role: options.role ?? "owner",
        restaurants: { id: "r1", name: "Au lait cru", slug: "au-lait-cru" },
      },
    ];
  (globalThis as any).__isOperator = options.isOperator === true;
  (globalThis as any).__plan = options.plan ?? {
    r1: { schedules: [SCHEDULE_FIXED_SLOTS], v12: { status: "absent" } },
  };
  (globalThis as any).__pending = [] as Array<() => void>;
  (globalThis as any).__previewResult = options.previewResult ?? null;
  (globalThis as any).__previewArgs = null;

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(AvailabilityPage, {}));
  return { container, root };
}

/** Attente de QUIESCENCE, pas de durée (remédiation F-03) : voir
 *  tests/helpers/dom-settle.ts. `ms` est accepté et ignoré. */
const flush = settle;

function text(container: Element): string {
  return container.textContent ?? "";
}

// --------------------------------------------------------------------

test("[BO1-DOM-1] propriétaire, contrat disponible : AUCUNE bannière « contrat non approuvé », et l'enregistrement dit la vraie raison (version du serveur non lue)", async () => {
  const { container, root } = setup({ role: "owner" });
  await flush();

  assert.ok(
    container.querySelector('[data-availability-page="csdj-bo1"]'),
    "la page doit être montée"
  );

  // Issue #156, constat 1 : le drapeau réel est `true`, donc la bannière
  // « contrat d'écriture non approuvé » ne doit JAMAIS être rendue. Elle
  // restait affichée sans condition, y compris une fois le lot installé.
  assert.equal(CSDJ_BO1_WRITE_CONTRACT.available, true);
  assert.equal(
    container.querySelector("[data-write-contract]"),
    null,
    "aucune bannière de contrat quand le contrat est disponible"
  );
  assert.ok(
    !text(container).includes("contrat d'écriture n'est pas encore approuvé"),
    "aucune phrase périmée sur le contrat d'écriture"
  );

  // Ici le double ne sert pas la lecture autoritaire : la page le DIT
  // (elle ne signe jamais une version qu'elle n'a pas lue).
  const save = container.querySelector("[data-write-disabled-reason]") as HTMLButtonElement;
  assert.ok(save, "la barre d'enregistrement doit exister");
  assert.equal(save.getAttribute("data-write-disabled-reason"), "authority");
  assert.equal(save.disabled, true, "le bouton d'enregistrement doit être désactivé");
  assert.equal(save.getAttribute("aria-disabled"), "true");
  assert.ok(container.querySelector('[data-unverified="true"]'), "la lecture manquante est annoncée en tête");
  assert.equal(
    container.querySelector("[data-editor-status]")?.getAttribute("data-editor-status"),
    "unverified"
  );

  const activate = container.querySelector("#av-activate") as HTMLInputElement;
  assert.ok(activate, "l'interrupteur d'activation doit être rendu");
  const describedBy = activate.getAttribute("aria-describedby");
  assert.ok(describedBy, "l'interrupteur doit renvoyer à une description");
  const help = container.querySelector(`#${describedBy}`);
  assert.ok(help && (help.textContent ?? "").length > 20, "la description doit être une phrase");
  assert.ok(
    !text(container).includes("Inactif : l'enregistrement attend le contrat"),
    "aucune raison « inactif » à côté d'un contrôle qui ne l'est pas pour cette raison"
  );
  // Un propriétaire a le rôle : aucun message de rôle.
  assert.ok(
    !text(container).includes("seuls les rôles propriétaire et responsable peuvent modifier"),
    "un propriétaire ne doit pas lire un message de rôle"
  );

  root.unmount();
  container.remove();
});

test("[BO1-DOM-2] aucun bouton de suppression n'existe nulle part (décision R2 n° 7)", async () => {
  const { container, root } = setup({ role: "owner", plan: { r1: { schedules: [SCHEDULE_FIXED_SLOTS, SCHEDULE_FREE_TIME] } } });
  await flush();

  const labels = Array.from(container.querySelectorAll("button, a")).map((el) =>
    (el.textContent ?? "") + " " + (el.getAttribute("aria-label") ?? "")
  );
  const destructive = labels.filter((l) => /supprim|delete|retirer la portée|✕/i.test(l));
  assert.deepEqual(destructive, [], `aucun contrôle destructif ne doit être rendu : ${destructive.join(" | ")}`);
  assert.ok(
    text(container).includes("Rien ne se supprime depuis cette page"),
    "la page doit dire que la désactivation remplace la suppression"
  );

  root.unmount();
  container.remove();
});

test("[BO1-DOM-3] membre sans rôle d'écriture : bandeau de lecture seule, et la raison devient le RÔLE", async () => {
  const { container, root } = setup({ role: "staff" });
  await flush();

  const save = container.querySelector("[data-write-disabled-reason]") as HTMLButtonElement;
  assert.equal(save.getAttribute("data-write-disabled-reason"), "role");
  assert.ok(
    text(container).includes("Lecture seule"),
    "un membre sans rôle d'écriture doit lire pourquoi"
  );

  root.unmount();
  container.remove();
});

test("[BO1-DOM-4] opérateur Scanym : lecture complète, mais l'écriture reste refusée -- et le bandeau le dit", async () => {
  const { container, root } = setup({
    role: undefined,
    isOperator: true,
    mappings: [],
    plan: { r1: { schedules: [SCHEDULE_FIXED_SLOTS] } },
  });
  await flush();

  assert.ok(
    text(container).includes("Lecture opérateur Scanym"),
    "l'opérateur doit lire que l'écriture exige le rôle de l'établissement, sans dérogation"
  );
  const save = container.querySelector("[data-write-disabled-reason]") as HTMLButtonElement;
  assert.equal(save.getAttribute("data-write-disabled-reason"), "role");
  // La portée est bien chargée : l'opérateur LIT tout.
  assert.ok(text(container).includes("pickup"), "la portée doit être affichée pour l'opérateur");

  root.unmount();
  container.remove();
});

test("[BO1-DOM-5] CSDJ v1.2 absent du serveur : annoncé non actif, jamais présenté comme opérationnel", async () => {
  const { container, root } = setup({ role: "owner" });
  await flush();

  assert.ok(
    text(container).includes("pas encore actifs sur ce serveur"),
    "l'absence de la PR #146 doit être dite explicitement"
  );
  // Méthode v1 déduite de l'absence d'extension : le champ de décalage
  // d'heure limite n'existe qu'en v1, il doit donc être présent ici.
  const method = container.querySelector("[data-schedule-method]");
  assert.equal(method!.getAttribute("data-schedule-method"), "v1");
  assert.ok(container.querySelector("#av-cutoff-offset"), "le décalage existe en méthode v1");
  // Issue #156, constat 4 : en v1 le calendrier de préparation n'existe
  // pas. La page ne demande donc AUCUN jour de préparation, n'affiche
  // pas « Aucun jour de préparation enregistré » comme un manque, et
  // dit une seule fois que ces options relèvent de la méthode v1.2.
  assert.ok(
    !text(container).includes("Aucun jour de préparation enregistré"),
    "un champ indisponible ne doit pas être présenté comme un oubli"
  );
  assert.equal(container.querySelector("[data-prep-weekday]"), null, "aucun jour de préparation en v1");
  assert.equal(container.querySelector("[data-add-row='prep-closure']"), null, "aucune fermeture d'atelier en v1");
  assert.equal(container.querySelector("[data-holiday-calendar]"), null, "aucun calendrier férié en v1");
  assert.equal(container.querySelector("#av-capacity-max"), null, "aucune capacité en v1");
  assert.ok(container.querySelector('[data-v12-only="true"]'), "la raison est écrite une fois");

  root.unmount();
  container.remove();
});

test("[BO1-DOM-6] CSDJ v1.2 présent : méthode v1.2, décalage d'heure limite retiré, capacité par créneau nommé", async () => {
  const { container, root } = setup({
    role: "owner",
    plan: { r1: { schedules: [SCHEDULE_FIXED_SLOTS], v12: V12_AVAILABLE } },
  });
  await flush();

  const method = container.querySelector("[data-schedule-method]");
  assert.equal(method!.getAttribute("data-schedule-method"), "v1.2");
  assert.equal(
    container.querySelector("#av-cutoff-offset"),
    null,
    "en v1.2 le décalage d'heure limite n'existe plus : il ne doit pas être affiché du tout"
  );

  const bucket = container.querySelector("[data-capacity-bucket]");
  assert.equal(bucket!.getAttribute("data-capacity-bucket"), "named_slot");
  const max = container.querySelector("#av-capacity-max") as HTMLInputElement;
  assert.equal(max.value, "12");
  // Mis à jour par l'issue #149 : la capacité est ÉDITABLE (brouillon
  // local) en méthode v1.2 pour un rôle d'écriture ; ce qui reste
  // verrouillé est l'ENREGISTREMENT. Les deux sont vérifiés ensemble,
  // parce que c'est leur combinaison qui est la propriété voulue :
  // « on peut tout régler, on ne peut rien publier ».
  assert.equal(max.disabled, false, "la capacité est éditable en méthode v1.2");
  const save = container.querySelector("[data-write-disabled-reason]") as HTMLButtonElement;
  assert.equal(save.disabled, true, "mais l'enregistrement reste fermé (rien n'est modifié, version du serveur non lue)");
  assert.equal(save.getAttribute("data-write-disabled-reason"), "authority");
  // Depuis l'issue #149, les fermetures sont des CHAMPS : leur contenu
  // vit dans `value`, pas dans le texte du document.
  const prepLabels = (
    Array.from(container.querySelectorAll('input[type="text"]')) as HTMLInputElement[]
  ).map((input) => input.value);
  assert.ok(
    prepLabels.includes("Entretien four"),
    `les fermetures d'atelier lues doivent être affichées (vues : ${prepLabels.join(" | ")})`
  );
  // Le remplissage est inaffichable par construction (le service
  // n'appelle que trois lectures, voir [BO1-NOWRITE-4]) ; ce qui est
  // vérifié ici, c'est que la page le DIT au commerçant au lieu de le
  // laisser chercher un compteur qui n'existera pas.
  assert.ok(
    text(container).includes("le compteur de remplissage n'est accordé à aucun rôle applicatif"),
    "la page doit expliquer qu'aucun remplissage ne peut être affiché"
  );
  assert.equal(
    container.querySelector("[data-capacity-used], [data-capacity-remaining]"),
    null,
    "aucun élément de remplissage ne doit exister dans le DOM"
  );

  root.unmount();
  container.remove();
});

test("[BO1-DOM-7] heure libre : le seau de capacité est la JOURNÉE ENTIÈRE, et l'avertissement est affiché", async () => {
  const { container, root } = setup({
    role: "owner",
    plan: {
      r1: {
        schedules: [SCHEDULE_FREE_TIME],
        v12: {
          status: "available",
          rows: [{ ...V12_AVAILABLE.rows[0], modeCode: "delivery" }],
        },
      },
    },
  });
  await flush();

  const bucket = container.querySelector("[data-capacity-bucket]");
  assert.equal(
    bucket!.getAttribute("data-capacity-bucket"),
    "whole_day",
    "sans créneau nommé, la limite porte sur la journée"
  );
  assert.ok(
    text(container).includes("douze commandes ce jour-là"),
    "l'avertissement de R2 (limite journalière, pas par demi-heure) doit être affiché"
  );
  // La politique « heure libre » exige un pas de grille : il est montré.
  const granularity = container.querySelector("#av-granularity") as HTMLInputElement;
  assert.equal(granularity.value, "30");

  root.unmount();
  container.remove();
});

test("[BO1-DOM-8] l'aperçu affiche la réponse du serveur, motif nommé compris", async () => {
  const { container, root } = setup({
    role: "owner",
    previewResult: {
      deliveryApplicable: false,
      deliveryEligible: false,
      deliveryBlock: null,
      deliveryCustomerText: null,
      scheduleStatus: "unfulfillable",
      unfulfillableReason: "preparation_calendar_missing",
      scheduleTimezone: "Europe/Paris",
      dateSelectionMode: "customer_selectable",
      slotSelectionMode: "fixed_slots",
      timeGranularityMinutes: null,
      firstEligibleDate: null,
      eligibleDates: [],
      offers: null,
    },
  });
  await flush();

  const buttons = Array.from(container.querySelectorAll("button"));
  const refresh = buttons.find((b) => (b.textContent ?? "").includes("Actualiser"));
  assert.ok(refresh, "le bouton d'aperçu doit exister");
  refresh!.dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush(90);

  const panel = container.querySelector("[data-preview-status]");
  assert.ok(panel, "le panneau d'aperçu doit être rendu après l'appel");
  assert.equal(panel!.getAttribute("data-preview-status"), "unfulfillable");
  const reasonNode = container.querySelector("[data-preview-reason]");
  assert.equal(reasonNode!.getAttribute("data-preview-reason"), "preparation_calendar_missing");
  assert.ok(
    text(container).includes("Aucun jour de préparation n'est coché"),
    "le motif serveur doit être traduit en phrase, jamais affiché brut"
  );

  // L'appel est parti avec le mode de la portée et AUCUNE heure.
  const args = (globalThis as any).__previewArgs as Record<string, unknown>;
  assert.equal(args.modeCode, "pickup");
  assert.ok(!Object.keys(args).some((k) => /now|clock/i.test(k)));

  root.unmount();
  container.remove();
});

test("[BO1-DOM-9] l'aperçu rend les dates et les créneaux proposés par le serveur", async () => {
  const { container, root } = setup({
    role: "owner",
    previewResult: {
      deliveryApplicable: false,
      deliveryEligible: false,
      deliveryBlock: null,
      deliveryCustomerText: null,
      scheduleStatus: "dates_available",
      unfulfillableReason: null,
      scheduleTimezone: "Europe/Paris",
      dateSelectionMode: "customer_selectable",
      slotSelectionMode: "fixed_slots",
      timeGranularityMinutes: null,
      firstEligibleDate: "2026-10-15",
      eligibleDates: ["2026-10-15", "2026-10-16"],
      offers: {
        "2026-10-15": [{ slot_key: "matin", starts_at: "09:00", ends_at: "12:00" }],
        "2026-10-16": [],
      },
    },
  });
  await flush();

  const refresh = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Actualiser")
  );
  refresh!.dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush(90);

  const body = text(container);
  assert.ok(body.includes("2026-10-15") && body.includes("2026-10-16"));
  assert.ok(body.includes("matin"), "le créneau proposé doit être affiché");
  assert.ok(body.includes("09:00"), "les heures du serveur doivent être affichées telles quelles");
  assert.ok(
    body.includes("Aucune offre pour cette date"),
    "une date éligible sans offre doit être dite, pas masquée"
  );

  root.unmount();
  container.remove();
});

test("[BO1-DOM-10] isolation locataire : une réponse périmée d'un AUTRE établissement ne s'affiche jamais", async () => {
  // r1 répond en RETARD, r2 répond tout de suite. Séquence : charger
  // r1, basculer sur r2, puis laisser la vieille réponse de r1 arriver.
  const { container, root } = setup({
    role: "owner",
    mappings: [
      { restaurant_id: "r1", role: "owner", restaurants: { id: "r1", name: "Au lait cru", slug: "a" } },
      { restaurant_id: "r2", role: "owner", restaurants: { id: "r2", name: "Sanaa", slug: "b" } },
    ],
    plan: {
      r1: {
        deferSchedules: true,
        schedules: [{ ...SCHEDULE_FIXED_SLOTS, modeCode: "mode_de_r1" }],
      },
      r2: { schedules: [{ ...SCHEDULE_FIXED_SLOTS, modeCode: "mode_de_r2" }] },
    },
  });
  await flush();

  const selector = ([...container.querySelectorAll("select")] as HTMLSelectElement[]).find((s) =>
    [...s.options].some((o) => o.value === "r2")
  );
  assert.ok(selector, "le sélecteur d'établissement doit être rendu avec deux rattachements");
  // Un <select> contrôlé par React n'enregistre le changement que si la
  // valeur passe par le setter natif : c'est la technique déjà employée
  // par les suites de non-régression locataire de ce dépôt.
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(selector, "r2");
  selector!.dispatchEvent(new window.Event("change", { bubbles: true }));
  await flush(90);

  await flush();
  assert.ok(text(container).includes("mode_de_r2"), "les données de r2 doivent être affichées");

  // La vieille réponse de r1 arrive maintenant : elle doit être
  // ABANDONNÉE, pas affichée sous l'en-tête de r2.
  for (const release of (globalThis as any).__pending as Array<() => void>) release();
  await flush(90);

  assert.ok(
    !text(container).includes("mode_de_r1"),
    "une réponse périmée ne doit JAMAIS devenir visible (patron de garde de contexte)"
  );
  assert.ok(text(container).includes("mode_de_r2"), "les données courantes doivent rester affichées");

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
});
