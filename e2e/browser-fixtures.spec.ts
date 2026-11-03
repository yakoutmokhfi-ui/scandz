import { test as base, expect } from '@playwright/test';

const publicReads = new Set([
  'get_restaurant_collections', 'get_restaurant_public_sale_modes',
  'get_restaurant_public_field_requirements', 'get_restaurant_public_delivery_countries',
  'get_restaurant_public_delivery_info', 'get_restaurant_public_delivery_fulfillments',
  'get_restaurant_public_cgv',
]);

// Every scenario inherits E2/E6/E7: fail on runtime errors and unexpected
// requests, including attempted writes. POST is allowed only for exact read RPCs.
export const test = base.extend<{ readOnly: void }>({
  readOnly: [async ({ context, page, request }, use, testInfo) => {
    const errors: string[] = [];
    const blocked: string[] = [];
    const before = await (await request.get('http://127.0.0.1:3101/audit')).json();
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const req = route.request();
      const url = new URL(req.url());
      const appRead = url.origin === 'http://127.0.0.1:3100' && req.method() === 'GET' &&
        (/^\/(_next\/|r\/|legal\/)/.test(url.pathname) || /\.(svg|png|jpe?g|ico|webp)$/.test(url.pathname));
      const dataRead = url.origin === 'http://127.0.0.1:3101' && (
        (req.method() === 'GET' && url.pathname === '/rest/v1/sale_mode_catalog') ||
        (req.method() === 'POST' && publicReads.has(url.pathname.replace(/^\/rest\/v1\/rpc\//, ''))));
      if (appRead || dataRead) await route.continue();
      else { blocked.push(`${req.method()} ${url.origin}${url.pathname}`); await route.abort('blockedbyclient'); }
    });
    await use();
    const after = await (await request.get('http://127.0.0.1:3101/audit')).json();
    const audit = after.audit.slice(before.audit.length);
    await testInfo.attach('read-only-evidence.json', { contentType: 'application/json',
      body: JSON.stringify({ errors, blocked, audit, before: before.fingerprint, after: after.fingerprint }, null, 2) });
    expect(errors, 'E2: no fatal client runtime errors').toEqual([]);
    expect(blocked, 'E6/E7: no unexpected requests or write attempts').toEqual([]);
    expect(audit.filter((entry: { allowed: boolean }) => !entry.allowed), 'SSR/client data reads only').toEqual([]);
    expect(after.fingerprint, 'synthetic catalogue/settings remain unchanged').toBe(before.fingerprint);
  }, { auto: true }],
});

export async function openStorefront(page: import('@playwright/test').Page, slug = 'e2e-classic') {
  // Client-only public response proves hydration progressed; not a fixed sleep.
  const ready = page.waitForResponse(r => r.url().endsWith('/rpc/get_restaurant_public_delivery_fulfillments') && r.status() === 200);
  const response = await page.goto(`/r/${slug}`, { waitUntil: 'load' });
  expect(response?.status()).toBe(200);
  await ready;
  await expect(page.locator('h1')).toHaveText('Boutique E2E');
  await expect(page.locator('nav[data-category-navigation="true"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Modes et tarifs de livraison', exact: true })).toBeVisible();
}




