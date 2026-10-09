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
// Scanym — MERCHANT CUSTOMER COMMUNICATIONS v1 —
// components/OrderConfirmation.tsx, ISOLÉ de MenuView.
//
// Couvre les catégories exigées par le mandat :
//   [12] AUCUN appel à l'action « Suivre ma commande » sur l'écran de
//        confirmation finale (MCC-V1-CONTRACT-CHANGE-01) ;
//   [11] appel à l'action de rétractation UNIQUEMENT lorsqu'au moins
//        une ligne est rétractable (plomberie d'éligibilité) ;
//   [2]  repli : aucune surcharge => formulations EXACTEMENT d'avant ;
//   [3]  textes personnalisés rendus ;
//   [5]  contenu malveillant rendu comme TEXTE, jamais comme balisage.
//
// Même recette que tests/v122h-tracking-order-confirmation.dom.test.ts :
// JSDOM + esbuild, React réel, `useI18n()` fournit sa valeur par défaut
// (français) sans Provider.
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
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { translate } = await import("../lib/i18n.ts");

const REPO_ROOT = process.cwd();

const aliasPlugin: esbuild.Plugin = {
  name: "at-alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      const rel = args.path.slice(2);
      const base = path.join(REPO_ROOT, rel);
      const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p));
      return { path: candidate ?? base };
    });
  },
};

const entrySource = `
export { default as OrderConfirmation } from "@/components/OrderConfirmation";
export { I18nProvider } from "@/lib/i18n-context";
`;

const buildResult = await esbuild.build({
  stdin: { contents: entrySource, resolveDir: REPO_ROOT, loader: "tsx" },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  plugins: [aliasPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const code = buildResult.outputFiles[0].text;
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-mcc-v1-"));
const tmpFile = path.join(tmpDir, "OrderConfirmation.mjs");
writeFileSync(tmpFile, code);
const { OrderConfirmation } = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

/**
 * Absence d'un élément, assertée SANS sérialiser l'élément trouvé.
 *
 * `assert.equal(el, null)` paraît équivalent, mais lorsque l'assertion
 * ÉCHOUE, node:test sérialise la valeur observée : un nœud JSDOM est un
 * graphe cyclique volumineux, et la construction du message d'erreur
 * épuise la mémoire du processus (SIGKILL par l'OOM killer). Le test
 * devient alors indiscernable d'un plantage d'infrastructure -- piège
 * rencontré en écrivant ce fichier. On n'asserte donc qu'un BOOLÉEN, et
 * le message nomme le sélecteur fautif.
 */
function assertAbsent(container: Element, selector: string, why: string) {
  const found = container.querySelector(selector);
  assert.equal(found === null, true, `${why} (sélecteur trouvé : ${selector})`);
}

const RESTAURANT = {
  id: "r-alpha-test",
  name: "Epicerie Alpha (test)",
  slug: "epicerie-alpha",
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
  config: {
    restaurant_id: "r-alpha-test",
    max_tables: 10,
    currency: "EUR",
    whatsapp_number: "+33600000000",
    whatsapp_enabled: true,
    address: null,
    latitude: null,
    longitude: null,
    logo_url: null,
    cover_url: null,
    opening_hours: null,
    source_language: "fr",
  },
  categories: [],
  hiddenCategories: [],
  activeLanguages: [{ code: "fr", label: "Français", dir: "ltr", display_order: 1 }],
};

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";
const TRACKING_PATH = `/track/${ORDER_ID}#${TOKEN}`;

/** Fixture client — convention de nommage du dépôt : Victor Hugo. */
const PICKUP_CONTEXT = {
  mode: "pickup" as const,
  customer: {
    firstName: "Victor",
    lastName: "Hugo",
    name: "Victor Hugo",
    phone: "+33611223344",
    email: "victor.hugo@example.test",
    addressLine1: "",
    addressLine2: "",
    postalCode: "",
    city: "",
    country: "FR",
  },
};

interface RenderProps {
  trackingPath?: string | null;
  orderNumber?: number | null;
  totalAmount?: number | null;
  invoiceRequested?: boolean;
  communicationTexts?: Record<string, string> | null;
  withdrawalEligible?: boolean;
  context?: unknown;
}

/** React 19 rend de façon ASYNCHRONE : sans ce vidage de file, le
 *  conteneur est encore vide et une assertion d'ABSENCE passerait
 *  trivialement -- exactement le faux positif à éviter sur un lot dont
 *  le contrat est « ce bouton ne doit plus exister ». */
function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function render(props: RenderProps = {}) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(OrderConfirmation, {
      restaurant: RESTAURANT,
      context: props.context ?? null,
      orderNumber: props.orderNumber ?? 42,
      trackingPath: props.trackingPath === undefined ? TRACKING_PATH : props.trackingPath,
      totalAmount: props.totalAmount,
      invoiceRequested: props.invoiceRequested,
      communicationTexts: props.communicationTexts ?? null,
      withdrawalEligible: props.withdrawalEligible,
      onBackToMenu: () => {},
      onNewOrder: () => {},
    })
  );
  await flush();
  return { container, root };
}

// ====================================================================
// [12] AUCUN « Suivre ma commande » — MCC-V1-CONTRACT-CHANGE-01.
// ====================================================================

test("[NO-TRACKING-1] le libellé « Suivre ma commande » n'apparaît NULLE PART, même avec un trackingPath fourni", async () => {
  const { container, root } = await render({ trackingPath: TRACKING_PATH });
  assert.equal(container.textContent?.includes(translate("fr", "trackYourOrder")), false);
  assert.equal(container.textContent?.includes("Suivre ma commande"), false);
  root.unmount();
});

test("[NO-TRACKING-2] l'ancien point d'accroche data-order-confirmation-tracking a DISPARU", async () => {
  const { container, root } = await render({ trackingPath: TRACKING_PATH });
  assertAbsent(container, "[data-order-confirmation-tracking]", "l'ancien point d'accroche du suivi doit avoir disparu");
  root.unmount();
});

test("[NO-TRACKING-3] sans ligne rétractable, l'écran ne rend AUCUN lien vers /track/ -- le chemin reste inexploité", async () => {
  const { container, root } = await render({ trackingPath: TRACKING_PATH, withdrawalEligible: false });
  const trackLinks = [...container.querySelectorAll("a")].filter((a) =>
    a.getAttribute("href")?.startsWith("/track/")
  );
  assert.equal(trackLinks.length, 0);
  root.unmount();
});

test("[NO-TRACKING-4] « Retour au menu » devient l'action PRINCIPALE (bouton plein) en l'absence de CTA de rétractation", async () => {
  const { container, root } = await render({ trackingPath: TRACKING_PATH, withdrawalEligible: false });
  const back = container.querySelector<HTMLButtonElement>("[data-order-confirmation-back-to-menu]");
  assert.ok(back, "le bouton de retour au menu doit exister");
  assert.equal(back!.textContent, translate("fr", "backToMenu"));
  assert.ok(back!.className.includes("bg-caramel"), "bouton PLEIN (action principale)");
  root.unmount();
});

// ====================================================================
// [11] CTA DE RÉTRACTATION — uniquement sur preuve.
// ====================================================================

test("[WITHDRAWAL-1] FERMÉ AU REPOS : prop absente => aucun CTA de rétractation", async () => {
  const { container, root } = await render({});
  assertAbsent(container, "[data-order-confirmation-withdrawal]", "aucun CTA de rétractation ne doit être rendu");
  assert.equal(container.textContent?.includes(translate("fr", "confirmWithdrawalCta")), false);
  root.unmount();
});

test("[WITHDRAWAL-2] `false` => aucun CTA", async () => {
  const { container, root } = await render({ withdrawalEligible: false });
  assertAbsent(container, "[data-order-confirmation-withdrawal]", "aucun CTA de rétractation ne doit être rendu");
  root.unmount();
});

test("[WITHDRAWAL-3] `true` + chemin disponible => CTA rendu, pointant EXACTEMENT le chemin transmis", async () => {
  const { container, root } = await render({ withdrawalEligible: true, trackingPath: TRACKING_PATH });
  const cta = container.querySelector<HTMLAnchorElement>("[data-order-confirmation-withdrawal]");
  assert.ok(cta, "le CTA de rétractation doit être rendu");
  assert.equal(cta!.getAttribute("href"), TRACKING_PATH);
  assert.equal(cta!.textContent, translate("fr", "confirmWithdrawalCta"));
  // Le jeton ne voyage QUE dans le fragment -- contrat §6/§7 préservé.
  assert.equal(cta!.getAttribute("href")!.includes(`/${TOKEN}`), false);
  assert.equal(cta!.getAttribute("href")!.includes("?"), false);
  root.unmount();
});

test("[WITHDRAWAL-4] `true` SANS chemin (commande non créée) => aucun CTA, jamais un lien mort", async () => {
  const { container, root } = await render({ withdrawalEligible: true, trackingPath: null });
  assertAbsent(container, "[data-order-confirmation-withdrawal]", "aucun CTA de rétractation ne doit être rendu");
  root.unmount();
});

test("[WITHDRAWAL-5] une valeur non strictement booléenne `true` n'ouvre pas le CTA", async () => {
  for (const bogus of ["true", 1, {}]) {
    const { container, root } = await render({ withdrawalEligible: bogus as unknown as boolean });
    assertAbsent(
      container,
      "[data-order-confirmation-withdrawal]",
      `valeur non booléenne ${JSON.stringify(bogus)}`
    );
    root.unmount();
  }
});

test("[WITHDRAWAL-6] avec CTA de rétractation, « Retour au menu » passe en action SECONDAIRE (contour)", async () => {
  const { container, root } = await render({ withdrawalEligible: true });
  const back = container.querySelector<HTMLButtonElement>("[data-order-confirmation-back-to-menu]");
  assert.ok(back!.className.includes("border-caramel"));
  assert.equal(back!.className.includes("bg-caramel"), false);
  root.unmount();
});

// ====================================================================
// [2] REPLI — aucune surcharge => formulations d'AVANT ce lot.
// ====================================================================

test("[DEFAULT-1] sans surcharge, titre et corps sont EXACTEMENT ceux d'avant le lot", async () => {
  const { container, root } = await render({});
  const title = container.querySelector("[data-order-confirmation-title]");
  const body = container.querySelector("[data-order-confirmation-body]");
  assert.equal(title!.textContent, translate("fr", "confirmTitle"));
  assert.equal(
    body!.textContent,
    translate("fr", "confirmSubtitle", { name: RESTAURANT.name })
  );
  root.unmount();
});

test("[DEFAULT-2] WhatsApp désactivé : la variante SANS WhatsApp est préservée (base conditionnelle)", async () => {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(OrderConfirmation, {
      restaurant: {
        ...RESTAURANT,
        config: { ...RESTAURANT.config, whatsapp_enabled: false },
      },
      context: null,
      orderNumber: 42,
      trackingPath: TRACKING_PATH,
      onBackToMenu: () => {},
      onNewOrder: () => {},
    })
  );
  await flush();
  assert.equal(
    container.querySelector("[data-order-confirmation-body]")!.textContent,
    translate("fr", "confirmSubtitleNoWhatsapp", { name: RESTAURANT.name })
  );
  root.unmount();
});

test("[DEFAULT-3] les avertissements ADDITIFS sont ABSENTS par défaut -- aucun bloc vide", async () => {
  const { container, root } = await render({});
  assertAbsent(container, "[data-order-confirmation-slot-warning]", "aucun avertissement de créneau par défaut");
  assertAbsent(container, "[data-order-confirmation-sanitary-warning]", "aucun avertissement sanitaire par défaut");
  root.unmount();
});

test("[DEFAULT-4] le récapitulatif de retrait garde sa ligne de délai plateforme sans surcharge", async () => {
  const { container, root } = await render({ context: PICKUP_CONTEXT });
  const recap = container.querySelector("[data-order-confirmation-recap]")!;
  assert.ok(recap.textContent!.includes(translate("fr", "confirmPickup")));
  assert.ok(recap.textContent!.includes(translate("fr", "confirmPickupTime")));
  // La ligne FACTUELLE (téléphone) n'est jamais configurable.
  assert.ok(recap.textContent!.includes("+33611223344"));
  root.unmount();
});

// ====================================================================
// [3] TEXTES PERSONNALISÉS.
// ====================================================================

test("[CUSTOM-1] un titre et un corps marchands remplacent les textes plateforme", async () => {
  const { container, root } = await render({
    communicationTexts: {
      order_success_title: "C'est noté, merci !",
      order_success_body: "Nous préparons votre commande chez {merchant_name}.",
    },
  });
  assert.equal(
    container.querySelector("[data-order-confirmation-title]")!.textContent,
    "C'est noté, merci !"
  );
  // Le composant ne substitue PAS les variables (il n'a pas les valeurs
  // de commande) : le texte est rendu tel que configuré. La substitution
  // est le domaine de l'e-mail, où le snapshot fournit les valeurs.
  assert.equal(
    container.querySelector("[data-order-confirmation-body]")!.textContent,
    "Nous préparons votre commande chez {merchant_name}."
  );
  assert.equal(
    container.textContent?.includes(translate("fr", "confirmTitle")),
    false,
    "le titre plateforme ne doit pas coexister"
  );
  root.unmount();
});

test("[CUSTOM-2] la ligne de délai de retrait est remplaçable, la ligne factuelle ne l'est pas", async () => {
  const { container, root } = await render({
    context: PICKUP_CONTEXT,
    communicationTexts: { confirmation_pickup: "Retrait possible dès 17 h, boutique ouverte jusqu'à 20 h." },
  });
  const recap = container.querySelector("[data-order-confirmation-recap]")!;
  assert.ok(recap.textContent!.includes("Retrait possible dès 17 h"));
  assert.equal(recap.textContent!.includes(translate("fr", "confirmPickupTime")), false);
  // Le téléphone du client reste rendu : il n'est pas configurable.
  assert.ok(recap.textContent!.includes("+33611223344"));
  root.unmount();
});

test("[CUSTOM-3] les avertissements créneau et sanitaire apparaissent dès qu'ils sont configurés", async () => {
  const { container, root } = await render({
    communicationTexts: {
      slot_warning: "Les créneaux sont confirmés la veille par SMS.",
      sanitary_warning: "Produits frais : à conserver entre 0 et 4 °C.",
    },
  });
  assert.equal(
    container.querySelector("[data-order-confirmation-slot-warning]")!.textContent,
    "Les créneaux sont confirmés la veille par SMS."
  );
  assert.equal(
    container.querySelector("[data-order-confirmation-sanitary-warning]")!.textContent,
    "Produits frais : à conserver entre 0 et 4 °C."
  );
  root.unmount();
});

test("[CUSTOM-4] une surcharge vide / trop longue retombe sur la formulation plateforme", async () => {
  const { container, root } = await render({
    communicationTexts: {
      order_success_title: "   ",
      slot_warning: "z".repeat(501),
    },
  });
  assert.equal(
    container.querySelector("[data-order-confirmation-title]")!.textContent,
    translate("fr", "confirmTitle")
  );
  // Trop long => traité comme absent, et un emplacement additif absent
  // ne rend RIEN (jamais une version tronquée).
  assertAbsent(container, "[data-order-confirmation-slot-warning]", "aucun avertissement de créneau par défaut");
  root.unmount();
});

// ====================================================================
// [5] CONTENU MALVEILLANT — rendu comme TEXTE, jamais comme balisage.
// ====================================================================

test("[MALICIOUS-1] un titre hostile est rendu en NŒUD TEXTE : aucun élément injecté", async () => {
  const { container, root } = await render({
    communicationTexts: {
      order_success_title: `<script>window.__mccPwned = true;</script><img src=x onerror="window.__mccPwned=true">`,
    },
  });
  assert.equal(container.querySelectorAll("script").length, 0, "aucun <script> injecté");
  assert.equal(container.querySelectorAll("img").length, 0, "aucun <img> injecté");
  assert.equal((window as any).__mccPwned, undefined, "aucun code exécuté");
  // Le texte brut EST visible : le commerçant voit sa propre saisie.
  assert.ok(container.textContent!.includes("<script>"));
  root.unmount();
});

test("[MALICIOUS-2] un avertissement hostile n'introduit ni élément ni attribut", async () => {
  const { container, root } = await render({
    communicationTexts: {
      sanitary_warning: `</p><a href="https://pirate.example">cliquez</a><iframe src="x"></iframe>`,
    },
  });
  const warning = container.querySelector("[data-order-confirmation-sanitary-warning]")!;
  assert.equal(warning.querySelectorAll("*").length, 0, "aucun descendant élément");
  assert.equal(container.querySelectorAll("iframe").length, 0);
  assert.equal(
    [...container.querySelectorAll("a")].some((a) =>
      a.getAttribute("href")?.includes("pirate.example")
    ),
    false,
    "aucun lien hostile"
  );
  assert.ok(warning.textContent!.includes("pirate.example"), "visible comme TEXTE");
  root.unmount();
});

test("[MALICIOUS-3] une surcharge ne peut pas supprimer le récapitulatif détenu par la plateforme", async () => {
  const { container, root } = await render({
    context: PICKUP_CONTEXT,
    totalAmount: 19.9,
    invoiceRequested: true,
    communicationTexts: { order_success_body: "</div></div>" },
  });
  // Montant, numéro, remerciement et boutons sont toujours là.
  assert.ok(container.textContent!.includes(translate("fr", "confirmTotalLabel")));
  assert.ok(container.textContent!.includes(translate("fr", "orderNumber", { n: 42 })));
  assert.ok(container.textContent!.includes(translate("fr", "confirmInvoiceRequested")));
  assert.ok(container.querySelector("[data-order-confirmation-back-to-menu]"));
  root.unmount();
});

/**
 * Teardown repris MOT POUR MOT de
 * tests/v122h-tracking-order-confirmation.dom.test.ts : sans lui, la
 * fenêtre JSDOM (`pretendToBeVisual`) et le service esbuild gardent la
 * boucle d'évènements vivante, le processus de test ne rend jamais la
 * main, et le lanceur finit par l'abattre (SIGKILL) -- ce qui ressemble
 * à un échec de test alors que toutes les assertions ont passé.
 */
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
  delete (globalThis as any).requestAnimationFrame;
  delete (globalThis as any).cancelAnimationFrame;
});
