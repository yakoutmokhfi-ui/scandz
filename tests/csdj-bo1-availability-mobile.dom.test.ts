import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  V12_AVAILABLE,
  flush,
  mount,
  teardown,
} from "./helpers/csdj-bo1-availability-harness.ts";

// ====================================================================
// CSDJ-BO-1 — MISE EN PAGE MOBILE (contrat de classes).
//
// jsdom ne met pas Tailwind en page : aucune largeur réelle n'est
// mesurable, et prétendre le contraire serait un faux test. Ce qui est
// vérifié ici est le CONTRAT DE CLASSES qui produit la mise en page
// mobile, point par point, plus les invariants observables dans le DOM
// (un seul rendu des portées à la fois, aucun défilement horizontal
// caché, barre d'enregistrement atteignable au pouce).
//
// Corrige et verrouille le point 6 de la revue R2 : la barre des huit
// onglets passait à TROIS lignes sur un téléphone de 390 px.
// ====================================================================

test("[BO1-MOB-1] barre d'onglets compactée : quatre par ligne sous « sm », classes d'origine au-dessus", async () => {
  const { container, cleanup } = mount({ role: "owner" });
  await flush();

  const tabs = Array.from(container.querySelectorAll("nav a")) as HTMLAnchorElement[];
  assert.equal(tabs.length, 8, "la barre doit porter les huit onglets");

  for (const tab of tabs) {
    const cls = tab.className;
    assert.ok(
      cls.includes("basis-[calc(25%-0.375rem)]"),
      "sous « sm », chaque onglet occupe un quart de la largeur (quatre par ligne, donc deux lignes)"
    );
    assert.ok(
      cls.includes("sm:basis-auto") && cls.includes("sm:flex-none"),
      "au-dessus de « sm », la mise en page de bureau doit reprendre à l'identique"
    );
    assert.ok(cls.includes("min-h-11"), "la cible tactile reste à 44 px malgré la compaction");
    assert.ok(
      cls.includes("text-xs") && cls.includes("sm:text-sm"),
      "le texte est réduit sur téléphone seulement"
    );
  }

  cleanup();
});

test("[BO1-MOB-2] aucun défilement horizontal caché : la barre reste dans le flux", async () => {
  const { container, cleanup } = mount({ role: "owner" });
  await flush();

  const nav = container.querySelector("nav")!;
  assert.ok(nav.className.includes("flex-wrap"), "le retour à la ligne reste le mécanisme");
  assert.ok(
    !/overflow-x|overflow-auto|overflow-scroll|overflow-hidden|snap-x/.test(nav.className),
    "aucun onglet ne doit devenir inaccessible derrière un défilement"
  );
  // Et pas davantage sur un ancêtre de la barre, jusqu'à l'en-tête.
  let node: Element | null = nav.parentElement;
  while (node && node.tagName !== "HEADER") {
    assert.ok(
      !/overflow-x|overflow-scroll/.test(node.className ?? ""),
      "aucun conteneur de la barre ne doit introduire un défilement horizontal"
    );
    node = node.parentElement;
  }

  cleanup();
});

test("[BO1-MOB-3] libellés courts sur téléphone, complets sur bureau -- et les deux sont dans le DOM", async () => {
  const { container, cleanup } = mount({ role: "owner" });
  await flush();

  const tabs = Array.from(container.querySelectorAll("nav a")) as HTMLAnchorElement[];
  const availability = tabs.find((a) => (a.getAttribute("href") ?? "").includes("/dashboard/availability"))!;
  const shortLabel = availability.querySelector(".sm\\:hidden");
  const longLabel = availability.querySelector(".hidden.sm\\:inline");
  assert.ok(shortLabel, "l'onglet doit porter un libellé court pour le téléphone");
  assert.ok(longLabel, "et son libellé complet pour le bureau");
  assert.equal(shortLabel!.textContent, "Mise à dispo.");
  assert.equal(longLabel!.textContent, "Mise à disposition");
  assert.ok(
    (availability.getAttribute("title") ?? "").length === 0 ||
      availability.getAttribute("title") === "Mise à disposition",
    "si un title existe, il porte le libellé complet"
  );

  // Les trois autres libellés longs sont traités pareil ; les courts
  // ne remplacent jamais le libellé complet pour un lecteur d'écran,
  // puisque les deux sont rendus.
  const longOnes = ["/dashboard/catalogue", "/dashboard/delivery-pricing", "/dashboard/translations"];
  for (const href of longOnes) {
    const tab = tabs.find((a) => (a.getAttribute("href") ?? "").includes(href))!;
    assert.ok(tab.querySelector(".sm\\:hidden"), `${href} doit avoir un libellé court`);
    assert.ok(tab.querySelector(".hidden.sm\\:inline"), `${href} doit garder son libellé complet`);
  }

  cleanup();
});

test("[BO1-MOB-4] les portées : un sélecteur sur téléphone, un tableau sur bureau -- jamais les deux visibles", async () => {
  const { container, cleanup } = mount({ role: "owner" });
  await flush();

  const select = container.querySelector("#av-scope-select") as HTMLSelectElement;
  assert.ok(select, "le sélecteur de portée mobile doit exister");
  const mobileBlock = select.closest("div")!;
  assert.ok(
    mobileBlock.className.includes("sm:hidden"),
    "le sélecteur disparaît au-dessus de « sm »"
  );

  const table = container.querySelector("main table")!;
  assert.ok(
    table.className.includes("hidden") && table.className.includes("sm:table"),
    "le tableau n'apparaît qu'au-dessus de « sm »"
  );

  // Le sélecteur et le tableau décrivent la MÊME liste de portées : une
  // option par ligne, pour qu'aucune portée ne soit joignable
  // uniquement sur l'un des deux écrans.
  const rows = table.querySelectorAll("tbody tr").length;
  assert.equal(select.options.length, rows, "autant d'options que de lignes");

  cleanup();
});

test("[BO1-MOB-5] une seule colonne sur téléphone : les grilles ne se déploient qu'au-dessus de « sm »", async () => {
  const { container, cleanup } = mount({ role: "owner", v12: V12_AVAILABLE });
  await flush();

  const grids = Array.from(container.querySelectorAll("main [class*='grid-cols-']"));
  assert.ok(grids.length >= 4, `la page doit employer des grilles (vues : ${grids.length})`);
  const offenders = grids
    .filter((el) => {
      const cls = el.className;
      // Une grille multi-colonnes doit être conditionnée par un
      // préfixe de largeur ; une grille à une colonne est toujours
      // acceptable.
      const hasUnconditionalMulti = /(^|\s)grid-cols-[2-9]/.test(cls);
      return hasUnconditionalMulti;
    })
    .map((el) => el.className);
  assert.deepEqual(
    offenders,
    [],
    `grille multi-colonnes non conditionnée (illisible à 390 px) : ${offenders.join(" | ")}`
  );

  cleanup();
});

test("[BO1-MOB-6] la barre d'enregistrement reste atteignable au pouce, et n'occulte pas le contenu", async () => {
  const { container, cleanup } = mount({ role: "owner" });
  await flush();

  const save = container.querySelector("[data-write-disabled-reason]") as HTMLButtonElement;
  const bar = save.closest("div.fixed") ?? save.parentElement!.parentElement!;
  assert.ok(
    (bar.className ?? "").includes("fixed") && (bar.className ?? "").includes("bottom-0"),
    "la barre doit être collée en bas de l'écran"
  );
  assert.ok(
    (bar.className ?? "").includes("flex-wrap") ||
      (bar.firstElementChild?.className ?? "").includes("flex-wrap"),
    "sur téléphone, la raison et le bouton doivent pouvoir passer à la ligne"
  );
  const main = container.querySelector("main")!;
  assert.ok(
    /pb-2[0-9]|pb-28|pb-32/.test(main.className),
    "le contenu doit réserver la hauteur de la barre collée, sinon le dernier bloc est masqué"
  );

  cleanup();
});

test("[BO1-MOB-7] l'aperçu serveur se remplit en colonne sur téléphone", async () => {
  const { container, cleanup } = mount({
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
      eligibleDates: ["2026-10-15"],
      offers: { "2026-10-15": [{ slot_key: "matin", starts_at: "09:00", ends_at: "12:00" }] },
    },
  });
  await flush();

  const postal = container.querySelector("#av-preview-postal") as HTMLInputElement;
  assert.ok(
    postal.closest("div")!.className.includes("basis-full"),
    "le premier champ de l'aperçu prend toute la largeur sur téléphone"
  );
  const refresh = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Actualiser")
  )!;
  assert.ok(
    refresh.className.includes("basis-full") && refresh.className.includes("sm:basis-auto"),
    "le bouton d'aperçu est pleine largeur au pouce, et redevient compact sur bureau"
  );

  cleanup();
});

after(async () => {
  await teardown();
});
