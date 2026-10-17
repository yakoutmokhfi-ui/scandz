import { test, after } from "node:test";
import assert from "node:assert/strict";
import { contrastRatio } from "../lib/color-contrast.ts";
import {
  V12_AVAILABLE,
  flush,
  mount,
  teardown,
  window,
} from "./helpers/csdj-bo1-availability-harness.ts";

// ====================================================================
// CSDJ-BO-1 — ACCESSIBILITÉ, SUR LE RENDU RÉEL.
//
// Pas de balayage automatique (le dépôt n'embarque pas axe-core) :
// des assertions écrites à la main sur le DOM rendu, exactement comme
// les suites d'accessibilité existantes (checkout-ux-a11y-v1).
//
// La règle de la maison, et c'est elle qui structure ce fichier : un
// état ne doit JAMAIS être porté par la couleur seule. Dans cette page,
// chaque contrôle inactif est accompagné de la PHRASE qui dit pourquoi.
// ====================================================================

test("[BO1-A11Y-1] tout champ a une étiquette associée, ou un nom accessible explicite", async () => {
  const { container, cleanup } = mount({ role: "owner", v12: V12_AVAILABLE });
  await flush();

  const fields = Array.from(
    container.querySelectorAll("input, select, textarea")
  ) as HTMLInputElement[];
  assert.ok(fields.length > 10, `la page doit rendre ses champs (vus : ${fields.length})`);

  const unlabelled: string[] = [];
  for (const field of fields) {
    if (field.type === "hidden") continue;
    const id = field.getAttribute("id");
    const hasLabelFor = id ? !!container.querySelector(`label[for="${id}"]`) : false;
    const wrapped = field.closest("label") !== null;
    const ariaLabel = (field.getAttribute("aria-label") ?? "").trim() !== "";
    if (!hasLabelFor && !wrapped && !ariaLabel) {
      unlabelled.push(
        `${field.tagName.toLowerCase()}${id ? "#" + id : ""}[type=${field.getAttribute("type") ?? "—"}]`
      );
    }
  }
  assert.deepEqual(unlabelled, [], `champs sans nom accessible : ${unlabelled.join(", ")}`);

  cleanup();
});

test("[BO1-A11Y-2] aucun faux contrôle : pas de role=button sur un div ou un span", async () => {
  const { container, cleanup } = mount({ role: "owner", v12: V12_AVAILABLE });
  await flush();

  const fake = Array.from(container.querySelectorAll('[role="button"], [role="checkbox"], [role="link"]'))
    .filter((el) => !["BUTTON", "A", "INPUT"].includes(el.tagName))
    .map((el) => el.tagName.toLowerCase());
  assert.deepEqual(fake, [], `éléments non focalisables déguisés en contrôles : ${fake.join(", ")}`);

  // Tout bouton porte un texte visible : aucun bouton-icône muet.
  const nameless = Array.from(container.querySelectorAll("button")).filter(
    (b) => (b.textContent ?? "").trim() === "" && !(b.getAttribute("aria-label") ?? "").trim()
  );
  assert.equal(nameless.length, 0, "un bouton sans texte doit porter un aria-label");

  cleanup();
});

test("[BO1-A11Y-3] l'inactivité n'est jamais portée par la couleur seule : chaque contrôle inactif a sa phrase", async () => {
  const { container, cleanup } = mount({ role: "owner", v12: V12_AVAILABLE });
  await flush();

  const save = container.querySelector("[data-write-disabled-reason]") as HTMLButtonElement;
  assert.equal(save.disabled, true);
  assert.equal(save.getAttribute("aria-disabled"), "true");
  // La barre d'enregistrement porte la raison en texte, dans le même
  // conteneur que le bouton : lisible sans voir la couleur du bouton.
  const bar = save.parentElement!;
  const barText = (bar.textContent ?? "").replace(save.textContent ?? "", "");
  assert.ok(
    barText.trim().length > 60,
    "la raison de l'inactivité doit être une phrase, pas une nuance de gris"
  );

  const activate = container.querySelector("#av-activate") as HTMLInputElement;
  const describedBy = activate.getAttribute("aria-describedby")!;
  const description = container.querySelector(`#${describedBy}`);
  assert.ok(description, "aria-describedby doit désigner un élément qui existe");
  assert.ok((description!.textContent ?? "").trim().length > 40);

  cleanup();
});

test("[BO1-A11Y-4] les régions vivantes sont correctement typées : état du lot en « status », erreur en « alert »", async () => {
  const ok = mount({ role: "owner" });
  await flush();
  // Issue #156 : la bannière du contrat n'existe plus quand le contrat
  // est disponible ; l'état de la configuration, lui, est toujours
  // annoncé, et ce n'est pas une avarie : « status », pas « alert ».
  assert.equal(ok.container.querySelector("[data-write-contract]"), null);
  const banner = ok.container.querySelector("[data-editor-status]")!;
  assert.equal(
    banner.getAttribute("role"),
    "status",
    "l'état de la configuration n'est pas une avarie : « status », pas « alert »"
  );
  ok.cleanup();

  const failed = mount({ role: "owner", schedulesThrow: "CSDJ1_FORBIDDEN: accès refusé." });
  await flush();
  const alert = failed.container.querySelector('[role="alert"]');
  assert.ok(alert, "un échec de lecture doit être annoncé en « alert »");
  const message = (alert!.textContent ?? "").trim();
  assert.ok(message.length > 20, "l'alerte doit porter une phrase");
  assert.ok(
    !/CSDJ1_|SQLSTATE|public\.|rpc|[0-9a-f]{8}-[0-9a-f]{4}/.test(message),
    `le message ne doit laisser fuir ni code serveur ni identifiant : « ${message} »`
  );
  failed.cleanup();
});

test("[BO1-A11Y-5] la hiérarchie de titres ne saute aucun niveau", async () => {
  const { container, cleanup } = mount({ role: "owner", v12: V12_AVAILABLE });
  await flush();

  const levels = Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((h) =>
    Number(h.tagName.slice(1))
  );
  assert.ok(levels.length > 5, "la page doit être structurée par des titres");
  assert.equal(levels[0], 1, "le premier titre est celui de l'en-tête commerçant");
  assert.equal(
    container.querySelectorAll("main h2").length,
    1,
    "un seul titre de page dans le contenu principal"
  );
  for (let i = 1; i < levels.length; i += 1) {
    assert.ok(
      levels[i] <= levels[i - 1] + 1,
      `saut de niveau interdit : h${levels[i - 1]} suivi de h${levels[i]}`
    );
  }

  cleanup();
});

test("[BO1-A11Y-6] la direction d'écriture est posée sur le contenu, pas devinée", async () => {
  const { container, cleanup } = mount({ role: "owner" });
  await flush();
  const main = container.querySelector("main")!;
  assert.ok(["ltr", "rtl"].includes(main.getAttribute("dir") ?? ""), "main doit porter dir");
  cleanup();
});

test("[BO1-A11Y-7] cibles tactiles : tout contrôle interactif garde au moins 44 px de hauteur", async () => {
  const { container, cleanup } = mount({ role: "owner", v12: V12_AVAILABLE });
  await flush();

  // jsdom ne met pas Tailwind en page : c'est donc le CONTRAT DE
  // CLASSES qui est vérifié -- `min-h-11` vaut 2.75rem, soit 44 px.
  //
  // Périmètre : les contrôles de CETTE page, plus les onglets de la
  // barre de navigation, qui sont compactés par ce lot. Les deux
  // boutons de l'en-tête commerçant (« Voir le menu », « Déconnexion »)
  // sont antérieurs et partagés par les huit onglets : ce lot ne les
  // modifie pas, et les remettre en cause relève d'une revue de la
  // barre, pas d'une page.
  const interactive = [
    ...Array.from(
      container.querySelectorAll(
        "main button, main select, main input[type=text], main input[type=number], main input[type=time]"
      )
    ),
    ...Array.from(container.querySelectorAll("nav a")),
    // La barre d'enregistrement est hors de <main> (collée en bas).
    ...Array.from(container.querySelectorAll("[data-write-disabled-reason]")),
  ];
  const tooSmall = interactive
    .filter((el) => {
      const cls = el.className ?? "";
      return !/min-h-11|h-11|py-2\.5|py-3/.test(cls);
    })
    .map((el) => `${el.tagName.toLowerCase()}${el.getAttribute("id") ? "#" + el.getAttribute("id") : ""}`);
  assert.deepEqual(tooSmall, [], `cibles tactiles trop petites : ${tooSmall.join(", ")}`);

  cleanup();
});

test("[BO1-A11Y-8] les couleurs de texte employées par la page passent 4,5:1 sur leur fond", async () => {
  // Les paires effectivement utilisées dans la page (classes Tailwind
  // traduites en hexadécimal). Le texte secondaire est volontairement
  // stone-600 et non stone-400/500 : ces deux-là échouent, et c'est
  // précisément la leçon de checkout-ux-a11y-v1.
  const pairs: Array<[string, string, string]> = [
    ["texte courant stone-900 sur blanc", "#1C1917", "#FFFFFF"],
    ["texte secondaire stone-600 sur blanc", "#57534E", "#FFFFFF"],
    ["texte secondaire stone-600 sur stone-50", "#57534E", "#FAFAF9"],
    ["avertissement amber-900 sur amber-50", "#78350F", "#FFFBEB"],
    ["information blue-900 sur blue-50", "#1E3A8A", "#EFF6FF"],
    ["refus red-900 sur red-50", "#7F1D1D", "#FEF2F2"],
    ["succès emerald-900 sur emerald-50", "#064E3B", "#ECFDF5"],
    ["onglet actif blanc sur stone-900", "#FFFFFF", "#1C1917"],
  ];
  for (const [label, fg, bg] of pairs) {
    const ratio = contrastRatio(fg, bg);
    assert.ok(ratio >= 4.5, `${label} : contraste ${ratio.toFixed(2)}:1, minimum 4,5:1`);
  }

  // Et la preuve que le garde-fou mord : stone-400 sur blanc échoue,
  // donc la page ne doit pas s'en servir pour du texte.
  assert.ok(contrastRatio("#A8A29E", "#FFFFFF") < 4.5);
});

test("[BO1-A11Y-9] un groupe désactivé est annoncé comme tel, et porte une légende", async () => {
  const { container, cleanup } = mount({ role: "owner", v12: V12_AVAILABLE });
  await flush();

  const fieldsets = Array.from(container.querySelectorAll("fieldset")) as HTMLFieldSetElement[];
  assert.ok(fieldsets.length >= 2, "les réglages v1.2 sont regroupés dans des fieldsets");
  for (const fs of fieldsets) {
    const legend = fs.querySelector("legend");
    assert.ok(
      legend && (legend.textContent ?? "").trim().length > 2,
      "chaque groupe doit porter une légende"
    );
  }

  // Mis à jour par l'issue #149 : l'ÉDITION est désormais réelle, donc
  // les groupes de réglages ne sont plus désactivés en bloc. Ce qui
  // reste verrouillé, et ce qui est vérifié ici, c'est
  // l'ENREGISTREMENT -- la seule chose qui touche un client.
  const save = container.querySelector("[data-write-disabled-reason]") as HTMLButtonElement;
  assert.equal(save.disabled, true, "l'enregistrement reste verrouillé");
  assert.equal(save.getAttribute("data-write-disabled-reason"), "authority");

  // En revanche, un groupe qui ne s'applique PAS à la méthode de la
  // portée doit rester désactivé : proposer un réglage que le serveur
  // n'a pas de table pour recevoir serait mentir. Ici la portée est en
  // méthode v1.2, donc ses groupes sont actionnables ; la vérification
  // du cas v1 est faite dans la suite DOM.
  assert.equal(
    container.querySelector("[data-schedule-method]")!.getAttribute("data-schedule-method"),
    "v1.2"
  );

  cleanup();
});

test("[BO1-A11Y-10] le tableau des portées est un vrai tableau, avec des en-têtes de colonne", async () => {
  const { container, cleanup } = mount({ role: "owner" });
  await flush();

  const table = container.querySelector("main table");
  assert.ok(table, "les portées sont présentées dans un tableau de données");
  const headers = Array.from(table!.querySelectorAll("thead th"));
  assert.ok(headers.length >= 3, "le tableau doit déclarer ses colonnes");
  for (const th of headers) {
    assert.equal(th.getAttribute("scope"), "col", "chaque en-tête doit porter scope=col");
  }
  // La colonne d'action n'a pas de libellé visible : elle doit en avoir
  // un pour les lecteurs d'écran.
  const srOnly = table!.querySelector("thead .sr-only");
  assert.ok(srOnly && (srOnly.textContent ?? "").trim().length > 0);

  cleanup();
});

after(async () => {
  void window;
  await teardown();
});
