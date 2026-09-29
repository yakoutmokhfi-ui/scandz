import { test, expect } from "@playwright/test";

/**
 * SCANYM E2E AUTOMATION FOUNDATION v1 (issue #11, comments `5886339688`,
 * `5894999069`, `5896211327`) -- scénario 1/2 v1 : fumée du storefront
 * public.
 *
 * LECTURE SEULE, aucune mutation : cette page (`app/r/[slug]/page.tsx`)
 * est un Server Component qui ne fait que LIRE via `getRestaurantBySlug`
 * -- ce test n'ajoute rien au panier, ne soumet aucun formulaire, ne
 * déclenche aucun appel réseau d'écriture.
 *
 * Tenant utilisé : `au-lait-cru`, un marchand RÉEL (pas un tenant de
 * test dédié -- aucun n'existe encore dans ce dépôt, voir la conception
 * approuvée, section "ce qui reste pour v2"). Choisi parce qu'il est
 * déjà celui utilisé pour la vérification manuelle post-release de ce
 * même lot (issue #11) -- changer de tenant pour ce fichier n'a de sens
 * que lorsqu'un tenant de test dédié existe.
 *
 * Les erreurs console/requêtes réseau échouées sont CAPTURÉES et jointes
 * au rapport (`test.info().attach`) mais ne font PAS échouer ce test à
 * elles seules en v1 : un défaut connu et déjà signalé (image produit
 * "Rond cendré" cassée, probablement un upload manquant côté marchand,
 * sans rapport avec aucun des lots livrés) rendrait ce test rouge en
 * permanence pour une raison hors du périmètre de ce qui est livré ici.
 * Une fois un tenant de test dédié et entièrement propre existe, ce
 * comportement pourra devenir une assertion dure.
 */

const STOREFRONT_PATH = "/r/au-lait-cru";

test("le storefront public charge et affiche le contenu essentiel", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("requestfailed", (req) => {
    failedRequests.push(`${req.method()} ${req.url()} -- ${req.failure()?.errorText ?? "unknown"}`);
  });

  const response = await page.goto(STOREFRONT_PATH, { waitUntil: "domcontentloaded" });
  expect(response, "la navigation doit produire une réponse HTTP").not.toBeNull();
  expect(response!.status(), "le storefront doit répondre 200, jamais une erreur serveur").toBe(200);

  // <h1> réel (components/RestaurantHeader.tsx:127) -- nom du marchand,
  // jamais vide, jamais un texte générique inventé.
  const heading = page.locator("h1");
  await expect(heading, "le nom du marchand doit être visible").toBeVisible();
  await expect
    .poll(async () => (await heading.textContent())?.trim().length ?? 0, {
      message: "le <h1> ne doit jamais être vide",
    })
    .toBeGreaterThan(0);

  // Navigation par catégories réelle (components/CategoryNav.tsx) --
  // sélecteur basé sur l'attribut data- réel du composant, jamais une
  // classe CSS fragile.
  const categoryNav = page.locator('nav[data-category-navigation="true"]');
  await expect(categoryNav, "la navigation par catégories doit être rendue").toBeVisible();

  // Preuve informationnelle jointe au rapport -- jamais un échec dur en
  // v1 pour les raisons documentées en tête de fichier.
  await testInfo.attach("console-errors.json", {
    body: JSON.stringify(consoleErrors, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach("failed-requests.json", {
    body: JSON.stringify(failedRequests, null, 2),
    contentType: "application/json",
  });
  if (consoleErrors.length > 0 || failedRequests.length > 0) {
    testInfo.annotations.push({
      type: "info",
      description: `${consoleErrors.length} erreur(s) console, ${failedRequests.length} requête(s) réseau échouée(s) -- voir les pièces jointes. Non bloquant en v1 (voir commentaire de tête).`,
    });
  }
});
