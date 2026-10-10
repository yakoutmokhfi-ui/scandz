import { expect } from '@playwright/test';
import { test, openStorefront } from './browser-fixtures.spec';

test('E1/E2 storefront loads without fatal runtime errors', async ({ page }) => {
  await openStorefront(page);
  await expect(page.getByRole('main').getByText('Produit 1', { exact: true })).toBeVisible();
});

test('E5 delivery information opens and closes without mutation', async ({ page }) => {
  await openStorefront(page);
  await page.getByRole('button', { name: 'Modes et tarifs de livraison', exact: true }).click();
  const dialog = page.locator('dialog[data-delivery-dialog="conditions"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-delivery-rule-card]')).toHaveCount(1);
  await expect(dialog).toContainText('Livraison de demonstration');
  await dialog.getByRole('button', { name: 'Fermer', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

test('E9 public legal document renders read-only', async ({ page }) => {
  const response = await page.goto('/legal/e2e-classic', { waitUntil: 'load' });
  expect(response?.status()).toBe(200);
  await expect(page.locator('article.cgv-document')).toContainText('Document synthetique de test.');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Conditions de vente E2E');
});


