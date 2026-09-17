import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";
import {
  renderCgv,
  type CgvTemplateControlledSections,
  type LegalProfileForRender,
  type CgvBusinessConditionsForRender,
} from "../lib/legal/render.ts";
// NOTE : le composant est un .tsx -- `--experimental-strip-types` de
// Node retire les types mais ne transforme PAS le JSX, donc on ne peut
// pas l'importer directement ici. On le récupère du bundle esbuild
// construit plus bas (patron déjà utilisé par les autres tests DOM du
// dépôt), ce qui a l'avantage de tester le MÊME artefact que celui
// rendu dans le DOM, pas une seconde copie.

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym — STANDARD COMMERCIAL TERMS UX v1.
//
// Ce lot n'ajoute AUCUNE table, AUCUNE colonne, AUCUNE migration et ne
// modifie AUCUN texte juridique. Il rend explicite, côté marchand, une
// sémantique de stockage qui existait déjà :
//
//     NULL / vide   => texte standard Scanym
//     non-vide      => texte personnalisé du marchand
//
// Le risque central de ce lot n'est donc pas fonctionnel mais un
// MENSONGE D'INTERFACE : que l'UI affiche "personnalisé" alors que le
// moteur publierait le texte standard, ou l'inverse. La partie 1
// ci-dessous verrouille précisément cela, en comparant le prédicat de
// l'UI au COMPORTEMENT RÉEL de renderCgv() sur les mêmes entrées.
//
// v1.1 -- REMÉDIATION CIBLÉE, clôture de deux constats d'audit :
//
//   CGV-UX-V1-PERSONALISE-STATE-01 (HIGH). En v1, cliquer
//   « Personnaliser » appelait onChange(standardText) : le repli du
//   gabarit était recopié dans la VALEUR MÉTIER, le badge basculait
//   aussitôt en "personnalisé", et un Enregistrer pouvait figer un
//   override que le marchand n'avait jamais écrit. v1.1 sépare le
//   BROUILLON d'éditeur (état local, éphémère) de la VALEUR PERSISTÉE :
//   ouvrir l'éditeur ne touche plus au profil.
//
//   CGV-UX-V1-TYPESCRIPT-02 (MAJOR). Le fixture RenderCgvInput omettait
//   `presentationVariant`, pourtant requis. Corrigé dans le TEST seul --
//   aucun type de production n'a été assoupli.
//
// Couverture des 15 scénarios exigés en v1.1 :
//   1,2   -> état initial standard (annulation, substitution)
//   3     -> « Personnaliser » ouvre un brouillon pré-rempli
//   4     -> le clic seul n'appelle JAMAIS onChange(standardText)
//   5     -> le clic seul laisse la valeur stockée à NULL
//   6     -> le clic seul laisse le badge STANDARD
//   7     -> le clic seul laisse l'aperçu sur le texte standard
//   8     -> une saisie authentique bascule en PERSONNALISÉ
//   9     -> espaces seuls => STANDARD
//   10    -> Rétablir / Annuler préserve le texte personnalisé
//   11    -> Rétablir / Confirmer remet NULL
//   12    -> lecture seule : aucune action d'écriture
//   13    -> aucun libellé d'interface dans les CGV générées
//   14    -> le prédicat d'UI colle toujours à celui de renderCgv
//   15    -> fixture TypeScript valide (presentationVariant)
//
// Restent des propriétés SQL/serveur, NON re-testées ici car déjà
// prouvées par supabase/tests/seller-legal-profile-cgv-engine-v2-*-
// check.sh (publication, garde-fous juridiques, immuabilité des CGV
// publiées), ré-exécutés en régression avec ce lot. Ce lot ne touche ni
// SQL, ni service de publication, ni renderCgv.
// ====================================================================

const TEMPLATE: CgvTemplateControlledSections = {
  header: "Conditions Générales de Vente",
  identity_intro: "Les présentes conditions régissent les commandes.",
  withdrawal_clauses: {
    EXEMPT_PERISHABLE: "Clause EXEMPT_PERISHABLE.",
    STANDARD_14_DAYS: "Clause STANDARD_14_DAYS.",
    MIXED: null,
  },
  mediator_clause: "Médiateur :",
  preparation_clause: "Délai de préparation indicatif.",
  cancellation_clause_label: "Politique d'annulation",
  substitution_clause_label: "Politique de substitution",
  jurisdiction_clause: "Clause de juridiction.",
  cancellation_clause_intro: "Intro annulation.",
  cancellation_clause_fallback: "TEXTE-STANDARD-ANNULATION faisant autorité.",
  substitution_clause_intro: "Intro substitution.",
  substitution_clause_fallback: "TEXTE-STANDARD-SUBSTITUTION faisant autorité.",
};

const LEGAL: LegalProfileForRender = {
  legalForm: "SARL",
  addressLine1: "114 rue Ordener",
  addressLine2: null,
  postalCode: "75018",
  city: "Paris",
  governingCountry: "FR",
  customerServiceEmail: "contact@test.local",
  customerServicePhone: null,
  mediatorName: "CM2C",
  mediatorAddress: "49 rue de Ponthieu, 75008 Paris, France",
  mediatorWebsite: "https://www.cm2c.net/declarer-un-litige.php",
};

function businessWith(
  cancellationPolicyText: string | null,
  substitutionPolicyText: string | null
): CgvBusinessConditionsForRender {
  return {
    withdrawalRegime: "EXEMPT_PERISHABLE",
    preparationTimeMin: 15,
    preparationTimeMax: 25,
    preparationTimeUnit: "MINUTES",
    cancellationPolicyText,
    substitutionPolicyText,
  };
}

function render(cancellation: string | null, substitution: string | null): string {
  return renderCgv({
    sellerName: "Au lait cru",
    template: TEMPLATE,
    legal: LEGAL,
    business: businessWith(cancellation, substitution),
    locale: "fr",
    // CGV-UX-V1-TYPESCRIPT-02 : `presentationVariant` est REQUIS par
    // RenderCgvInput (lib/legal/render.ts). Il manquait au fixture v1,
    // ce qui faisait échouer `tsc --noEmit`. On utilise une valeur
    // réellement supportée par le contrat de rendu actuel
    // (PresentationVariant = "FORMAL" | "WARM" | "PREMIUM" | "SIMPLE") --
    // le type de production n'est PAS modifié pour faire compiler le test.
    presentationVariant: "FORMAL",
  });
}

// ====================================================================
// PARTIE 0 — AMORÇAGE DOM + BUNDLE.
// Doit précéder toute déclaration de test : node:test démarre les
// premiers sous-tests AVANT la fin du top-level await du module, donc
// un bundle construit plus bas serait encore en zone morte (TDZ) au
// moment où la partie 1 s'exécute.
// ====================================================================

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/dashboard/legal-cgv",
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

async function bundle(entrySource: string, name: string) {
  const result = await esbuild.build({
    stdin: { contents: entrySource, resolveDir: REPO_ROOT, loader: "tsx" },
    bundle: true,
    write: false,
    format: "esm",
    jsx: "automatic",
    target: "es2022",
    plugins: [aliasPlugin],
    external: ["react", "react-dom", "react-dom/client"],
  });
  const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", `tmp-dom-${name}-`));
  const tmpFile = path.join(tmpDir, `${name}.mjs`);
  writeFileSync(tmpFile, result.outputFiles[0].text);
  const mod = await import(pathToFileURL(tmpFile).href);
  rmSync(tmpDir, { recursive: true, force: true });
  return mod;
}

const { default: CommercialTermsField, isCustomCommercialTerms, commitCommercialTerms } = await bundle(
  `export { default, isCustomCommercialTerms, commitCommercialTerms } from "@/components/dashboard/CommercialTermsField";`,
  "CommercialTermsField"
);

// ====================================================================
// PARTIE 1 — LE PRÉDICAT DE L'UI NE DOIT JAMAIS MENTIR SUR LE RENDU.
// ====================================================================

const PREDICATE_CASES: Array<{ label: string; value: string | null; expectCustom: boolean }> = [
  { label: "null", value: null, expectCustom: false },
  { label: "chaîne vide", value: "", expectCustom: false },
  { label: "espaces seuls", value: "   ", expectCustom: false },
  { label: "tabulations/retours seuls", value: "\n\t  \n", expectCustom: false },
  { label: "texte réel", value: "Annulation sous 24 h.", expectCustom: true },
  { label: "texte entouré d'espaces", value: "  Annulation sous 24 h.  ", expectCustom: true },
];

for (const c of PREDICATE_CASES) {
  test(`UX-v1 accord UI/rendu — ${c.label} : le badge et le texte publié disent la MÊME chose`, () => {
    assert.equal(
      isCustomCommercialTerms(c.value),
      c.expectCustom,
      `prédicat UI inattendu pour ${c.label}`
    );

    // Vérité du moteur : le repli standard est-il réellement rendu ?
    const html = render(c.value, c.value);
    const standardIsRendered = html.includes("TEXTE-STANDARD-ANNULATION");

    assert.equal(
      isCustomCommercialTerms(c.value),
      !standardIsRendered,
      `MENSONGE D'INTERFACE pour ${c.label} : l'UI dirait ${
        isCustomCommercialTerms(c.value) ? "personnalisé" : "standard"
      } alors que le moteur rend ${standardIsRendered ? "le standard" : "le texte marchand"}`
    );
  });
}

// ====================================================================
// PARTIE 2 — SCÉNARIOS 7 ET 8 : CE QUI EST RÉELLEMENT RENDU.
// ====================================================================

test("UX-v1 scénario 7 — état standard : le repli du gabarit faisant autorité est rendu, inchangé", () => {
  const html = render(null, null);
  assert.ok(html.includes("TEXTE-STANDARD-ANNULATION"), "repli d'annulation absent");
  assert.ok(html.includes("TEXTE-STANDARD-SUBSTITUTION"), "repli de substitution absent");
});

test("UX-v1 scénario 8 — état personnalisé : le texte du marchand est rendu à la place du repli", () => {
  const html = render("MON-TEXTE-ANNULATION", "MON-TEXTE-SUBSTITUTION");
  assert.ok(html.includes("MON-TEXTE-ANNULATION"));
  assert.ok(html.includes("MON-TEXTE-SUBSTITUTION"));
  assert.ok(!html.includes("TEXTE-STANDARD-ANNULATION"), "le repli ne doit plus apparaître");
  assert.ok(!html.includes("TEXTE-STANDARD-SUBSTITUTION"), "le repli ne doit plus apparaître");
});

test("UX-v1 — ce lot ne modifie AUCUN texte juridique : sortie identique avant/après à entrées égales", () => {
  // Le rendu ne dépend que du gabarit + du profil ; l'UI n'y injecte
  // rien. Deux rendus successifs aux mêmes entrées sont identiques, et
  // surtout : aucun libellé d'interface ("standard", "personnalisé")
  // ne fuit dans le document juridique.
  const html = render(null, null);
  assert.equal(html, render(null, null));
  for (const uiLabel of [
    "Conditions commerciales standard Scanym",
    "Conditions personnalisées",
    "Personnaliser",
    "Rétablir le texte standard",
    "Aperçu du texte standard",
  ]) {
    assert.ok(!html.includes(uiLabel), `libellé d'interface "${uiLabel}" fuité dans les CGV rendues`);
  }
});

// ====================================================================
// PARTIE 3 — DOM RÉEL (React rendu dans jsdom), scénarios 1-6 et 9.
// ====================================================================



const FR = (k: string) => {
  const dict: Record<string, string> = {
    legalCgvTermsStandardBadge: "Conditions commerciales standard Scanym",
    legalCgvTermsCustomBadge: "Conditions personnalisées",
    legalCgvTermsStandardPreviewLabel: "Aperçu du texte standard",
    legalCgvTermsCustomise: "Personnaliser",
    legalCgvTermsRestore: "Rétablir le texte standard",
    legalCgvTermsRestoreQuestion: "Rétablir le texte standard ? Votre texte personnalisé sera définitivement supprimé.",
    legalCgvTermsRestoreConfirm: "Confirmer",
    legalCgvTermsRestoreCancel: "Annuler",
    legalCgvTermsNoStandard: "Aucun texte standard n'est disponible pour cette section.",
  };
  return dict[k] ?? k;
};

const STANDARD_CANCELLATION = "TEXTE-STANDARD-ANNULATION faisant autorité.";

type Harness = {
  container: HTMLElement;
  changes: Array<string | null>;
  editing: boolean[];
  restoreRequested: number;
  restoreCancelled: number;
  set: (patch: Record<string, unknown>) => Promise<void>;
  unmount: () => void;
};

async function mountField(initial: Record<string, unknown> = {}): Promise<Harness> {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  const h: Harness = {
    container,
    changes: [],
    editing: [],
    restoreRequested: 0,
    restoreCancelled: 0,
    set: async () => {},
    unmount: () => {},
  };
  let props: Record<string, unknown> = {
    sectionKey: "cancellation",
    label: "Politique d'annulation",
    standardText: STANDARD_CANCELLATION,
    value: null,
    canEdit: true,
    editing: false,
    confirmingRestore: false,
    t: FR,
    onChange: (next: string | null) => h.changes.push(next),
    onEditingChange: (open: boolean) => h.editing.push(open),
    onRequestRestore: () => {
      h.restoreRequested += 1;
    },
    onCancelRestore: () => {
      h.restoreCancelled += 1;
    },
    ...initial,
  };
  const draw = async () => {
    await act(async () => {
      root.render(React.createElement(CommercialTermsField, props as any));
    });
  };
  h.set = async (patch) => {
    props = { ...props, ...patch };
    await draw();
  };
  h.unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  await draw();
  return h;
}

function q(h: Harness, testid: string) {
  return h.container.querySelector(`[data-testid="${testid}"]`);
}
/**
 * Saisie RÉELLE dans une zone de texte contrôlée par React.
 *
 * React 18 mémorise la dernière valeur qu'il a lui-même écrite dans le
 * nœud ; une affectation directe `el.value = x` suivie d'un événement
 * "input" est donc silencieusement ignorée (le tracker croit que rien
 * n'a changé) et `onChange` n'est jamais appelé. On passe par le
 * setter natif du prototype pour contourner ce tracker -- c'est ce qui
 * simule une frappe authentique du marchand, et non une manipulation
 * artificielle de l'état du composant.
 */
async function typeInto(el: Element | null, text: string) {
  assert.ok(el, "zone de saisie introuvable");
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  )!.set!;
  await act(async () => {
    setter.call(el, text);
    el!.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

function click(el: Element | null) {
  assert.ok(el, "élément cliquable introuvable");
  el!.dispatchEvent(new window.Event("click", { bubbles: true }));
}

test("UX-v1 scénario 1 — annulation sur le standard : badge standard, texte standard visible, pas d'éditeur", async () => {
  const h = await mountField({ sectionKey: "cancellation", value: null });
  assert.equal(q(h, "commercial-terms-cancellation")?.getAttribute("data-terms-state"), "standard");
  assert.equal(q(h, "commercial-terms-badge-cancellation")?.textContent, "Conditions commerciales standard Scanym");
  assert.equal(q(h, "commercial-terms-standard-text-cancellation")?.textContent, STANDARD_CANCELLATION);
  assert.equal(q(h, "commercial-terms-textarea-cancellation"), null, "aucun éditeur ne doit être ouvert");
  assert.ok(q(h, "commercial-terms-customise-cancellation"), "le bouton Personnaliser doit être proposé");
  h.unmount();
});

test("UX-v1 scénario 2 — substitution sur le standard : même comportement, section indépendante", async () => {
  const h = await mountField({
    sectionKey: "substitution",
    label: "Politique de substitution",
    standardText: "TEXTE-STANDARD-SUBSTITUTION faisant autorité.",
    value: null,
  });
  assert.equal(q(h, "commercial-terms-substitution")?.getAttribute("data-terms-state"), "standard");
  assert.equal(
    q(h, "commercial-terms-standard-text-substitution")?.textContent,
    "TEXTE-STANDARD-SUBSTITUTION faisant autorité."
  );
  assert.equal(q(h, "commercial-terms-textarea-substitution"), null);
  h.unmount();
});

test("UX-v1.1 scénarios 3+4+5+6 — « Personnaliser » OUVRE un brouillon pré-rempli SANS toucher à la valeur métier", async () => {
  const h = await mountField({ value: null });
  click(q(h, "commercial-terms-customise-cancellation"));

  // Scénario 3 : l'éditeur s'ouvre.
  assert.deepEqual(h.editing, [true], "l'éditeur doit s'ouvrir");
  // Scénario 4 : AUCUN onChange n'est émis -- c'est le défaut
  // CGV-UX-V1-PERSONALISE-STATE-01 qui est ici verrouillé.
  assert.deepEqual(
    h.changes,
    [],
    "ouvrir l'éditeur ne doit JAMAIS écrire dans le profil marchand (ni le texte standard, ni quoi que ce soit)"
  );

  // Scénario 5 : la valeur stockée reste NULL (le parent n'a rien reçu,
  // donc rien à propager) ; on re-rend avec editing=true, value INCHANGÉE.
  await h.set({ editing: true });

  // Scénario 3 (suite) : le brouillon est bien pré-rempli du standard.
  const ta = q(h, "commercial-terms-textarea-cancellation") as HTMLTextAreaElement | null;
  assert.ok(ta, "l'éditeur doit être affiché");
  assert.equal(ta!.value, STANDARD_CANCELLATION, "le brouillon doit partir du texte standard");

  // Scénario 6 : le badge reste STANDARD.
  assert.equal(q(h, "commercial-terms-cancellation")?.getAttribute("data-terms-state"), "standard");
  assert.equal(
    q(h, "commercial-terms-badge-cancellation")?.textContent,
    "Conditions commerciales standard Scanym"
  );
  h.unmount();
});

test("UX-v1.1 scénario 7 — clic seul : l'aperçu publie TOUJOURS le texte standard", () => {
  // La valeur métier après un simple clic est NULL (scénario 4/5
  // ci-dessus). Ce que le moteur publierait pour NULL est le repli du
  // gabarit -- preuve de bout en bout, pas seulement d'interface.
  const html = render(null, null);
  assert.ok(html.includes("TEXTE-STANDARD-ANNULATION"), "l'aperçu doit rester sur le texte standard");
});

test("UX-v1.1 scénario 8 — une personnalisation AUTHENTIQUE bascule bien en personnalisé", async () => {
  const h = await mountField({ value: null, editing: true });
  await typeInto(q(h, "commercial-terms-textarea-cancellation"), "Annulation possible jusqu'à 2 h avant le retrait.");

  assert.deepEqual(
    h.changes,
    ["Annulation possible jusqu'à 2 h avant le retrait."],
    "une vraie saisie doit créer la valeur métier"
  );

  await h.set({ value: "Annulation possible jusqu'à 2 h avant le retrait." });
  assert.equal(q(h, "commercial-terms-cancellation")?.getAttribute("data-terms-state"), "custom");
  assert.equal(q(h, "commercial-terms-badge-cancellation")?.textContent, "Conditions personnalisées");

  // Et l'aperçu suit la valeur métier.
  const html = render("Annulation possible jusqu'à 2 h avant le retrait.", null);
  assert.ok(html.includes("Annulation possible jusqu&#39;à 2 h avant le retrait."));
  assert.ok(!html.includes("TEXTE-STANDARD-ANNULATION"));
  h.unmount();
});

test("UX-v1.1 — brouillon laissé STRICTEMENT identique au standard : reste NULL/standard", async () => {
  const h = await mountField({ value: null, editing: true });
  // Le marchand touche puis remet exactement le texte standard.
  await typeInto(q(h, "commercial-terms-textarea-cancellation"), STANDARD_CANCELLATION + " ajout");
  await typeInto(q(h, "commercial-terms-textarea-cancellation"), STANDARD_CANCELLATION);

  assert.deepEqual(
    h.changes,
    [STANDARD_CANCELLATION + " ajout", null],
    "revenir exactement au texte standard doit REDEVENIR NULL, jamais figer une copie du gabarit"
  );
  h.unmount();
});

test("UX-v1.1 — commitCommercialTerms : sémantique brouillon -> valeur métier", () => {
  assert.equal(commitCommercialTerms("", "STD"), null, "brouillon vide => standard");
  assert.equal(commitCommercialTerms("   ", "STD"), null, "espaces seuls => standard");
  assert.equal(commitCommercialTerms("STD", "STD"), null, "standard non modifié => standard");
  assert.equal(commitCommercialTerms("STD modifié", "STD"), "STD modifié", "vraie saisie => personnalisé");
  assert.equal(commitCommercialTerms("texte", undefined), "texte", "sans standard connu, toute saisie compte");
  assert.equal(commitCommercialTerms(" STD ", "STD"), " STD ", "un écart réel, même d'espacement, reste une saisie");
});

test("UX-v1 scénario 6 — « Rétablir » N'EFFACE RIEN sans confirmation explicite", async () => {
  const h = await mountField({ value: "MON TEXTE", editing: true });
  assert.equal(q(h, "commercial-terms-cancellation")?.getAttribute("data-terms-state"), "custom");

  click(q(h, "commercial-terms-restore-cancellation"));
  assert.equal(h.restoreRequested, 1, "la confirmation doit être demandée");
  assert.deepEqual(h.changes, [], "AUCUNE suppression ne doit avoir lieu à ce stade");

  await h.set({ confirmingRestore: true });
  assert.ok(q(h, "commercial-terms-restore-confirm-cancellation"), "le bloc de confirmation doit s'afficher");

  // Annuler => toujours aucune destruction, l'état reste personnalisé.
  click(q(h, "commercial-terms-restore-no-cancellation"));
  assert.equal(h.restoreCancelled, 1);
  assert.deepEqual(h.changes, [], "annuler ne doit jamais effacer le texte du marchand");
  assert.equal(q(h, "commercial-terms-cancellation")?.getAttribute("data-terms-state"), "custom");
  h.unmount();
});

test("UX-v1 scénario 5 — « Confirmer » rétablit le standard en remettant la valeur à NULL", async () => {
  const h = await mountField({ value: "MON TEXTE", editing: true, confirmingRestore: true });
  click(q(h, "commercial-terms-restore-yes-cancellation"));
  assert.deepEqual(h.changes, [null], "le rétablissement doit écrire NULL, jamais une chaîne vide");
  assert.deepEqual(h.editing, [false], "l'éditeur doit se refermer");
  assert.equal(h.restoreCancelled, 1, "la confirmation doit être refermée");

  await h.set({ value: null, editing: false, confirmingRestore: false });
  assert.equal(q(h, "commercial-terms-cancellation")?.getAttribute("data-terms-state"), "standard");
  assert.equal(q(h, "commercial-terms-standard-text-cancellation")?.textContent, STANDARD_CANCELLATION);
  h.unmount();
});

test("UX-v1 scénario 9 — le badge reflète TOUJOURS ce qui sera publié, pas l'ouverture de l'éditeur", async () => {
  // Éditeur ouvert mais valeur encore vide : ce qui publierait est le
  // STANDARD -- le badge doit donc dire "standard", sans complaisance.
  const h = await mountField({ value: "", editing: true });
  assert.equal(q(h, "commercial-terms-cancellation")?.getAttribute("data-terms-state"), "standard");
  assert.equal(q(h, "commercial-terms-badge-cancellation")?.textContent, "Conditions commerciales standard Scanym");

  await h.set({ value: "   " });
  assert.equal(
    q(h, "commercial-terms-cancellation")?.getAttribute("data-terms-state"),
    "standard",
    "des espaces seuls publient le standard : le badge doit le dire"
  );

  await h.set({ value: "Vraiment personnalisé" });
  assert.equal(q(h, "commercial-terms-cancellation")?.getAttribute("data-terms-state"), "custom");
  assert.equal(q(h, "commercial-terms-badge-cancellation")?.textContent, "Conditions personnalisées");
  h.unmount();
});

test("UX-v1 — lecture seule : aucune action d'écriture n'est proposée", async () => {
  const h = await mountField({ value: null, canEdit: false });
  assert.equal(q(h, "commercial-terms-customise-cancellation"), null);
  assert.ok(q(h, "commercial-terms-standard-text-cancellation"), "le texte standard reste consultable");
  h.unmount();
});

test("UX-v1 — gabarit sans texte standard : l'UI le dit, sans inventer de clause", async () => {
  const h = await mountField({ value: null, standardText: undefined });
  assert.equal(
    q(h, "commercial-terms-standard-text-cancellation")?.textContent,
    "Aucun texte standard n'est disponible pour cette section."
  );
  click(q(h, "commercial-terms-customise-cancellation"));
  assert.deepEqual(h.editing, [true], "l'éditeur doit tout de même pouvoir s'ouvrir");
  assert.deepEqual(h.changes, [], "aucun texte ne doit être fabriqué comme brouillon");
  h.unmount();
});

after(() => {
  window.close();
});
