import { test, expect } from "@playwright/test";

/**
 * SCANYM E2E AUTOMATION FOUNDATION v1 (issue #11, comments `5886339688`,
 * `5894999069`, `5896211327`) -- scénario 2/2 v1 : régression PR #115
 * (navigation catalogue -- collections/tags au-dessus des catégories,
 * suppression de la pastille "Tout le catalogue").
 *
 * LIMITE HONNÊTE, documentée explicitement dans la conception approuvée
 * (comment `5896211327`, section 1) : le tenant utilisé ici
 * (`au-lait-cru`, seul marchand réel disponible pour ce v1) N'A PAS de
 * collections configurées -- ce fichier ne peut donc PAS vérifier
 * l'ordre "collections au-dessus des catégories" lui-même. Il vérifie
 * uniquement ce qui EST déterministe sur ce tenant : l'absence de la
 * pastille "Tout le catalogue" (retirée par PR #115, voir
 * components/CollectionNav.tsx) et le rendu correct de la navigation
 * par catégories. Le scénario complet "collections avant catégories"
 * reste À FAIRE en v2, une fois un tenant de test avec des collections
 * actives existe (voir la conception approuvée, "ce qui reste pour
 * v2") -- ce fichier ne PRÉTEND PAS couvrir ce cas, conformément à la
 * consigne CIO "Do not force a scenario that cannot be made
 * deterministic."
 */

const STOREFRONT_PATH = "/r/au-lait-cru";

test("aucune pastille « Tout le catalogue » n'est présente (PR #115)", async ({ page }) => {
  await page.goto(STOREFRONT_PATH, { waitUntil: "domcontentloaded" });

  // Texte français par défaut (lib/i18n.ts, clé `collectionsShowAll`,
  // RETIRÉE par PR #115) -- ce texte ne doit plus jamais apparaître
  // nulle part sur la page, quel que soit l'état de navigation.
  await expect(
    page.getByText("Tout le catalogue", { exact: false }),
    "la pastille « Tout le catalogue » a été retirée par PR #115 et ne doit jamais réapparaître"
  ).toHaveCount(0);
});

test("la navigation par catégories se rend avec au moins une entrée", async ({ page }) => {
  await page.goto(STOREFRONT_PATH, { waitUntil: "domcontentloaded" });

  const categoryNav = page.locator('nav[data-category-navigation="true"]');
  await expect(categoryNav).toBeVisible();

  const categoryLinks = categoryNav.locator("button, a");
  await expect
    .poll(async () => categoryLinks.count(), {
      message: "la navigation par catégories doit contenir au moins une entrée",
    })
    .toBeGreaterThan(0);

  // Ce tenant n'a pas de collections publiées -- confirmé par preuve
  // manuelle (issue #11) -- donc `nav[data-customer-collections-nav]`
  // est légitimement ABSENTE ici (voir CollectionNav.tsx :
  // `if (collections.length === 0) return null`). Ce n'est PAS un
  // signal de régression sur ce tenant précis ; documenté, pas vérifié
  // dans ce test.
});
