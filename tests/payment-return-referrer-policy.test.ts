import test from "node:test";
import assert from "node:assert/strict";
import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server.js";
import nextConfig from "../next.config.mjs";

// Synthetic URLs only: never use a real order or relay token in this fixture.
for (const route of ["ok", "err"]) {
  test(`payment return ${route}: suppress the Referer even on same-origin navigation`, async () => {
    const response = await unstable_getResponseFromNextConfig({
      url: `https://shop.example/checkout/return/${route}?token=synthetic-private-relay&lang=fr`,
      nextConfig,
    });
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  });
}

test("payment return policy preserves tracking protection and remains scoped", async () => {
  for (const path of ["/track/synthetic-order", "/api/track/exchange"]) {
    const response = await unstable_getResponseFromNextConfig({ url: `https://shop.example${path}`, nextConfig });
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer", path);
    assert.match(response.headers.get("Cache-Control") ?? "", /no-store/, path);
  }
  for (const path of ["/r/boutique-b", "/api/payments/monetico/callback"]) {
    const response = await unstable_getResponseFromNextConfig({ url: `https://shop.example${path}`, nextConfig });
    assert.equal(response.headers.get("Referrer-Policy"), null, path);
  }
});
