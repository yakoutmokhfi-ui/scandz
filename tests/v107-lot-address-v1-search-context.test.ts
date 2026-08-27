import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// LOT ADDRESS v1 — §5 "query context" : le service adresse doit
// transmettre le code postal déjà résolu par l'étape 1 (Ville / Code
// postal) au provider IGN/BAN via le paramètre officiel documenté
// `postcode`, UNIQUEMENT quand il est fourni par l'appelant -- jamais
// un mécanisme inventé, jamais requis (mission : "if the current
// official IGN service supports... postcode filter... use the exact
// documented mechanism if it exists").
//
// Données 100% synthétiques (mission §26 -- même discipline que
// tests/v98-b5-structured-address-foundation.test.ts).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { searchAddressSuggestions } = await import("../lib/services/address-search.ts");

function asFetch(fn: (...args: unknown[]) => unknown) {
  return fn as unknown as typeof fetch;
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

test("LOT ADDRESS v1: searchAddressSuggestions transmet options.postcode comme paramètre `postcode` de l'URL, quand fourni", async () => {
  let capturedUrl: string | undefined;
  await searchAddressSuggestions("8 bd du palais", {
    postcode: "75001",
    fetchImpl: asFetch(async (url: unknown) => {
      capturedUrl = String(url);
      return jsonResponse({ features: [] });
    }),
  });
  assert.ok(capturedUrl, "fetchImpl doit avoir été appelé");
  const parsed = new URL(capturedUrl!);
  assert.equal(parsed.searchParams.get("postcode"), "75001");
});

test("LOT ADDRESS v1: searchAddressSuggestions n'ajoute AUCUN paramètre `postcode` quand options.postcode est absent (comportement générique inchangé pour tout autre appelant)", async () => {
  let capturedUrl: string | undefined;
  await searchAddressSuggestions("8 bd du palais", {
    fetchImpl: asFetch(async (url: unknown) => {
      capturedUrl = String(url);
      return jsonResponse({ features: [] });
    }),
  });
  const parsed = new URL(capturedUrl!);
  assert.equal(parsed.searchParams.has("postcode"), false);
});

test("LOT ADDRESS v1: searchAddressSuggestions ignore un options.postcode vide/blanc après trim (pas de paramètre bruit)", async () => {
  let capturedUrl: string | undefined;
  await searchAddressSuggestions("8 bd du palais", {
    postcode: "   ",
    fetchImpl: asFetch(async (url: unknown) => {
      capturedUrl = String(url);
      return jsonResponse({ features: [] });
    }),
  });
  const parsed = new URL(capturedUrl!);
  assert.equal(parsed.searchParams.has("postcode"), false);
});
