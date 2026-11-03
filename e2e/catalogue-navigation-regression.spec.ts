import { expect } from '@playwright/test';
import { test, openStorefront } from './browser-fixtures.spec';

test('E3 categories select their own content', async ({ page }) => {
  await openStorefront(page);
  const nav = page.locator('nav[data-category-navigation="true"]');
  for (const [name, product] of [['Boissons', 'Produit 3'], ['Desserts', 'Produit 2'], ['Fromages', 'Produit 1']]) {
    const button = nav.getByRole('button', { name, exact: true });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('main').getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByText(product, { exact: true })).toBeVisible();
  }
});

test('E4 collection filters products; category exits collection', async ({ page }) => {
  await openStorefront(page);
  const collection = page.locator('[data-customer-collection-option="collection"]');
  await collection.click();
  await expect(collection).toHaveAttribute('aria-pressed', 'true');
  const view = page.locator('[data-customer-collection-view="true"]');
  await expect(view.getByRole('heading', { name: 'Selection E2E' })).toBeVisible();
  await expect(view.getByText('Produit 1', { exact: true })).toBeVisible();
  await expect(view.getByText('Produit 3', { exact: true })).toBeVisible();
  await expect(view.getByText('Produit 2', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Tout le catalogue', { exact: true })).toHaveCount(0);
  await page.locator('[data-category-navigation]').getByRole('button', { name: 'Desserts', exact: true }).click();
  await expect(view).toHaveCount(0);
  await expect(collection).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('main').getByText('Produit 2', { exact: true })).toBeVisible();
});

test('E8 classic categories fit viewport without horizontal scrolling', async ({ page }) => {
  await openStorefront(page);
  const nav = page.locator('[data-category-navigation]');
  const dimensions = await nav.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth,
    viewport: innerWidth, buttons: [...el.querySelectorAll('button')].map(b => ({ left: b.getBoundingClientRect().left, right: b.getBoundingClientRect().right })) }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
  for (const button of dimensions.buttons) {
    expect(button.left).toBeGreaterThanOrEqual(0);
    expect(button.right).toBeLessThanOrEqual(dimensions.viewport + 1);
  }
});

test('E8 editorial navigation remains usable with its existing scroll behavior', async ({ page }) => {
  await openStorefront(page, 'le-sirocco');
  const last = page.locator('[data-category-navigation]').getByRole('button', { name: 'Epicerie', exact: true });
  await last.click();
  await expect(last).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('main').getByText('Produit 5', { exact: true })).toBeVisible();
});

