import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

// ====================================================================
// SELLER LEGAL PROFILE + CGV ENGINE v1.2 — AUDIT REMEDIATION CYCLE 3
// (Catimini, Blocker 1, CGV-V11-PUBLISH-CONTEXT-RACE-01, HIGH).
//
// Fichier dédié aux tests d'ORCHESTRATION Node de bout en bout (route
// HTTP -> lib/server/legal-cgv-publish-service.ts) pour le blocker de
// course/fingerprint -- complète, sans les dupliquer, les tests 19-22
// de tests/seller-legal-profile-cgv-engine-v1-1-publish-authority.test.ts
// (menacent la même propriété au niveau de la fonction de service
// directement) et la matrice de 12 tests + démonstration de
// verrouillage PostgreSQL réel de
// supabase/tests/seller-legal-profile-cgv-engine-v1-2-check.sh (seule
// preuve PostgreSQL authentique -- CE fichier ne mocke jamais Postgres
// lui-même, il ne prouve que l'ORCHESTRATION Node autour de lui).
//
// Scénario central : deux résolutions successives d'un MÊME
// restaurant (représentant l'état "avant" et l'état "après" une
// mutation concurrente survenue entre elles) doivent chacune produire
// un contexte cohérent qui, transmis intégralement et sans altération
// jusqu'à persist_merchant_cgv_version, réussit -- la route HTTP elle-
// même ne mélange jamais les valeurs de deux résolutions différentes
// (ce qui serait le bug exact que ce blocker corrige si la logique
// vivait dans le navigateur au lieu du serveur).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "cgv-v1-2-synthetic-service-role-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const admin = getServiceRoleSupabaseClient();
const { asUserSupabaseClientFactory } = await import("../lib/server/supabase-as-user.ts");
const { publishMerchantCgvVersionServerAuthoritative, LegalCgvPublishServerError } = await import(
  "../lib/server/legal-cgv-publish-service.ts"
);
const { POST } = await import("../app/api/dashboard/legal-cgv/publish/route.ts");

interface FakeAsUserClient {
  rpc: (name: string, args: unknown) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
}
function mockAsUserClient(t: { mock: { method: typeof import("node:test").mock.method } }, client: FakeAsUserClient) {
  t.mock.method(asUserSupabaseClientFactory, "create", () => client);
}

const CONTROLLED_SECTIONS = {
  header: "Conditions Générales de Vente",
  identity_intro: "Les présentes conditions régissent les commandes.",
  withdrawal_clauses: { EXEMPT_PERISHABLE: "Clause EXEMPT_PERISHABLE.", STANDARD_14_DAYS: "Clause STANDARD_14_DAYS.", MIXED: null },
  mediator_clause: "Médiateur :",
  preparation_clause: "Délai de préparation indicatif.",
  cancellation_clause_label: "Politique d'annulation",
  substitution_clause_label: "Politique de substitution",
  jurisdiction_clause: "Droit applicable du pays d'établissement.",
};

function contextRow(overrides: Record<string, unknown> = {}) {
  return {
    restaurant_id: "r1",
    seller_name: "Resto A",
    template_id: "t1",
    template_version: 1,
    controlled_sections: CONTROLLED_SECTIONS,
    merchant_profile_version: 3,
    locale: "fr",
    presentation_variant: "FORMAL",
    legal_form: "SARL",
    address_line1: "1 rue Test",
    address_line2: null,
    postal_code: "75001",
    city: "Paris",
    governing_country: "FR",
    customer_service_email: "contact@test.local",
    customer_service_phone: null,
    mediator_name: "Médiateur Test",
    mediator_address: "2 rue Médiation",
    mediator_website: "https://mediateur.test",
    withdrawal_regime: "EXEMPT_PERISHABLE",
    preparation_time_min: 15,
    preparation_time_max: 25,
    preparation_time_unit: "MINUTES",
    cancellation_policy_text: "Annulation possible avant préparation.",
    substitution_policy_text: "Substitution équivalente si rupture.",
    context_fingerprint: "fp-v1",
    acting_user_id: "u1",
    ...overrides,
  };
}

function versionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "v1", restaurant_id: "r1", template_id: "t1", template_version: 1, merchant_profile_version: 3,
    locale: "fr", presentation_variant: "FORMAL", rendered_content: "<h1>...</h1>", content_hash: "deadbeef",
    effective_from: "2026-01-01T00:00:00Z", published_at: "2026-01-01T00:00:00Z", status: "ACTIVE",
    ...overrides,
  };
}

function publishReq(body: unknown, headers: Record<string, string> = { Authorization: "Bearer tok-abc" }) {
  return new NextRequest("https://internal.example.test/api/dashboard/legal-cgv/publish", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("1. deux publications successives (deux resolves distincts, ex: cancellation_policy_text changé entre les deux) réussissent CHACUNE avec SON PROPRE fingerprint résolu, jamais celui de l'appel précédent", async (t) => {
  let callCount = 0;
  const seenFingerprints: string[] = [];
  mockAsUserClient(t, {
    rpc: async () => {
      callCount += 1;
      return {
        data: [contextRow({
          context_fingerprint: callCount === 1 ? "fp-round-1" : "fp-round-2",
          cancellation_policy_text: callCount === 1 ? "Politique initiale" : "Politique modifiée (mutation concurrente simulée)",
        })],
        error: null,
      };
    },
  });
  t.mock.method(admin, "rpc", async (_name: string, args: Record<string, unknown>) => {
    seenFingerprints.push(args.p_expected_context_fingerprint as string);
    return { data: [versionRow()], error: null };
  });

  await publishMerchantCgvVersionServerAuthoritative("tok-abc", "r1");
  await publishMerchantCgvVersionServerAuthoritative("tok-abc", "r1");

  assert.deepEqual(seenFingerprints, ["fp-round-1", "fp-round-2"], "chaque appel transmet EXACTEMENT le fingerprint résolu par SA PROPRE résolution, jamais un mélange/une réutilisation de l'appel précédent");
});

test("2. route HTTP -- deux requêtes concurrentes (deux restaurants DIFFÉRENTS) ne mélangent jamais leurs contextes respectifs (isolation par requête, aucun état partagé)", async (t) => {
  const persistCalls: Record<string, unknown>[] = [];
  mockAsUserClient(t, {
    rpc: async (_name: string, args: unknown) => {
      const restaurantId = (args as { p_restaurant_id: string }).p_restaurant_id;
      return {
        data: [contextRow({
          restaurant_id: restaurantId,
          context_fingerprint: `fp-${restaurantId}`,
          acting_user_id: `u-${restaurantId}`,
        })],
        error: null,
      };
    },
  });
  t.mock.method(admin, "rpc", async (_name: string, args: Record<string, unknown>) => {
    persistCalls.push(args);
    return { data: [versionRow({ restaurant_id: args.p_restaurant_id })], error: null };
  });

  await Promise.all([
    POST(publishReq({ restaurantId: "resto-x" })),
    POST(publishReq({ restaurantId: "resto-y" })),
  ]);

  const forX = persistCalls.find((c) => c.p_restaurant_id === "resto-x");
  const forY = persistCalls.find((c) => c.p_restaurant_id === "resto-y");
  assert.ok(forX && forY, "les deux appels de persistance ont bien eu lieu");
  assert.equal(forX!.p_expected_context_fingerprint, "fp-resto-x");
  assert.equal(forX!.p_acting_user_id, "u-resto-x");
  assert.equal(forY!.p_expected_context_fingerprint, "fp-resto-y");
  assert.equal(forY!.p_acting_user_id, "u-resto-y");
});

test("3. STALE_CONTEXT est retriable de bout en bout : un premier appel échoue 409/stale_context, un second appel (nouvelle résolution) réussit 200/ok", async (t) => {
  let attempt = 0;
  mockAsUserClient(t, { rpc: async () => ({ data: [contextRow({ context_fingerprint: attempt === 0 ? "fp-stale" : "fp-fresh" })], error: null }) });
  t.mock.method(admin, "rpc", async (_name: string, args: Record<string, unknown>) => {
    attempt += 1;
    if (args.p_expected_context_fingerprint === "fp-stale") {
      return { data: null, error: { code: "P0001", message: "STALE_CONTEXT" } };
    }
    return { data: [versionRow()], error: null };
  });

  const first = await POST(publishReq({ restaurantId: "r1" }));
  assert.equal(first.status, 409);
  assert.equal((await first.json()).outcome, "stale_context");

  const second = await POST(publishReq({ restaurantId: "r1" }));
  assert.equal(second.status, 200);
  assert.equal((await second.json()).outcome, "ok");
});

test("4. l'objet LegalCgvPublishServerError('stale_context') ne contient jamais le fingerprint ni l'acting_user_id dans son message exposé", async (t) => {
  mockAsUserClient(t, { rpc: async () => ({ data: [contextRow({ context_fingerprint: "fp-should-never-leak", acting_user_id: "u-should-never-leak" })], error: null }) });
  t.mock.method(admin, "rpc", async () => ({ data: null, error: { code: "P0001", message: "STALE_CONTEXT" } }));

  await assert.rejects(
    () => publishMerchantCgvVersionServerAuthoritative("tok-abc", "r1"),
    (err: unknown) => {
      assert.ok(err instanceof LegalCgvPublishServerError);
      const msg = (err as Error).message;
      assert.ok(!msg.includes("fp-should-never-leak"));
      assert.ok(!msg.includes("u-should-never-leak"));
      return true;
    }
  );
});
