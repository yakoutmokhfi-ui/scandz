#!/usr/bin/env node
// =============================================================================
// Scanym — CGV ENGINE v2.6 — SQL-HARNESS RENDER HELPER
//
// This is NOT part of the product deliverable (lib/legal/render.ts is the
// deliverable) — it is a small, test-only CLI shim used EXCLUSIVELY by
// supabase/tests/seller-legal-profile-cgv-engine-v2-6-check.sh so that the
// harness can exercise the REAL, production `renderCgv()` function against
// REAL data it just fetched from the scratch database (via
// get_merchant_legal_profile / get_merchant_cgv_profile / restaurants.name /
// the applicable cgv_template row), rather than a hand-typed paraphrase of
// the template baked into a shell string. This keeps the Au Lait Cru
// preview, the cold-chain toggle test, and the multi-tenant isolation
// render checks faithful to the actual advisory-preview code path
// (app/dashboard/legal-cgv/page.tsx's buildPreview(), which also calls
// renderCgv() directly and never touches persist_merchant_cgv_version).
//
// Usage:
//   node --experimental-strip-types seller-legal-profile-cgv-engine-v2-6-render-helper.mjs \
//     < input.json > output.html
//
// stdin: a single JSON object shaped exactly like `RenderCgvInput` from
// lib/legal/render.ts (sellerName, template, legal, business, locale,
// presentationVariant) -- the SQL harness builds this JSON directly with a
// `jsonb_build_object(...)` query against the real fixture rows, so the
// camelCase<->snake_case mapping happens in ONE place (that query),
// mirrored 1:1 against app/dashboard/legal-cgv/page.tsx's own
// buildPreview() mapping.
//
// stdout: the rendered HTML (exactly what renderCgv() returned), and
// NOTHING else -- safe to redirect straight to a preview file.
// stderr: diagnostics only.
// Exit codes: 0 = rendered successfully; 3 = ActualWeightPriceUnsupportedError
// (fail-closed, expected for weightPricingMode = ACTUAL_WEIGHT_PRICE);
// 2 = invalid JSON input; 1 = any other render error.
// =============================================================================

import { renderCgv, ActualWeightPriceUnsupportedError } from "../../lib/legal/render.ts";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`SCANYM_RENDER_HELPER: invalid JSON input: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
    return;
  }

  try {
    const html = renderCgv(input);
    process.stdout.write(html);
    process.exit(0);
  } catch (err) {
    if (err instanceof ActualWeightPriceUnsupportedError) {
      process.stderr.write("ACTUAL_WEIGHT_PRICE_UNSUPPORTED\n");
      process.exit(3);
      return;
    }
    process.stderr.write(`SCANYM_RENDER_HELPER_ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
});
