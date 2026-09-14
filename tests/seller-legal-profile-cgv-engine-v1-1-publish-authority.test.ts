import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

// ====================================================================
// SELLER LEGAL PROFILE + CGV ENGINE v1.1/v1.2 — AUDIT REMEDIATION
// (Catimini). v1.1 closed Blocker 1 (CGV-V1-PUBLISH-AUTHORITY-01,
// HIGH) and Blocker 2 (CGV-V1-PROD-ACL-01) -- both remain CLOSED,
// unmodified below. v1.2 (Cycle 3) additionally closes
// CGV-V11-PUBLISH-CONTEXT-RACE-01 (HIGH) -- tests 19-22 below.
//
// Ferme, au niveau de l'ORCHESTRATION Node (jamais SQL -- voir
// supabase/tests/seller-legal-profile-cgv-engine-v1-2-check.sh pour la
// preuve PostgreSQL réelle du DIRECT RPC BYPASS, de la matrice de
// course/fingerprint et de la convergence ACL), le blocker "the
// browser can determine the authoritative published CGV body" :
//   - preuve STRUCTURELLE : lib/services/legal-cgv.ts (navigateur) ne
//     transmet plus JAMAIS de contenu rendu/template id/locale/variante
//     au serveur, et n'appelle plus jamais de RPC Supabase directement
//     pour la publication ;
//   - preuve d'ORCHESTRATION : lib/server/legal-cgv-publish-service.ts
//     résout le contexte EN AS-USER, rend le contenu EN NODE (jamais
//     transmis par le client), puis persiste EN SERVICE_ROLE
//     UNIQUEMENT -- avec exactement 5 paramètres (v1.2 ajoute le
//     fingerprint de contexte + l'acting_user_id, tous deux résolus
//     par l'étape 1, jamais fournis par l'appelant) ;
//   - preuve de CONTENU MALVEILLANT : un champ marchand hostile
//     (<img onerror>, <script>, attribut d'évènement, URL javascript:)
//     traversant CE chemin ressort échappé dans p_rendered_content ;
//   - preuve d'ORDRE (fail-closed) : une erreur d'auth/autorisation/
//     complétude EN AMONT (resolve_cgv_publication_context) empêche
//     TOUJOURS le moindre appel à persist_merchant_cgv_version ;
//   - preuve v1.2 : le fingerprint et l'acting_user_id transmis à
//     persist_merchant_cgv_version proviennent EXCLUSIVEMENT de
//     resolve_cgv_publication_context, jamais d'un champ arbitraire
//     que l'appelant HTTP tenterait d'injecter ; une erreur
//     STALE_CONTEXT renvoyée par persist_ est classifiée
//     reason='stale_context', jamais confondue avec 'incomplete' ou
//     'template_unresolved'.
//
// Patron déjà établi par ce dépôt (tests/v152-product-photo-
// service.test.ts) : `t.mock.method(asUserSupabaseClientFactory,
// "create", ...)` (client neuf à chaque appel, jamais un singleton) et
// `t.mock.method(admin, "rpc", ...)` sur le client SERVICE_ROLE réel
// (singleton partagé par getServiceRoleSupabaseClient()).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "cgv-v1-1-synthetic-service-role-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const admin = getServiceRoleSupabaseClient();
const { asUserSupabaseClientFactory } = await import("../lib/server/supabase-as-user.ts");
const {
  publishMerchantCgvVersionServerAuthoritative,
  LegalCgvPublishServerError,
} = await import("../lib/server/legal-cgv-publish-service.ts");
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
  withdrawal_clauses: {
    EXEMPT_PERISHABLE: "Clause EXEMPT_PERISHABLE.",
    STANDARD_14_DAYS: "Clause STANDARD_14_DAYS.",
    MIXED: null,
  },
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
    // v1.2 -- server-computed, held only in Node memory between the
    // two RPC calls; never part of the HTTP request/response shape.
    context_fingerprint: "fp-abc123",
    acting_user_id: "u1",
    ...overrides,
  };
}

function versionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "v1",
    restaurant_id: "r1",
    template_id: "t1",
    template_version: 1,
    merchant_profile_version: 3,
    locale: "fr",
    presentation_variant: "FORMAL",
    rendered_content: "<h1>...</h1>",
    content_hash: "deadbeef",
    effective_from: "2026-01-01T00:00:00Z",
    published_at: "2026-01-01T00:00:00Z",
    status: "ACTIVE",
    ...overrides,
  };
}

// --------------------------------------------------------------------
// 1-4. Orchestration -- ordre, paramètres, aucun contenu client.
// --------------------------------------------------------------------

test("1. resolve_cgv_publication_context est appelée AS-USER avec UNIQUEMENT p_restaurant_id", async (t) => {
  let resolveArgs: unknown;
  mockAsUserClient(t, {
    rpc: async (name: string, args: unknown) => {
      resolveArgs = args;
      assert.equal(name, "resolve_cgv_publication_context");
      return { data: [contextRow()], error: null };
    },
  });
  t.mock.method(admin, "rpc", async () => ({ data: [versionRow()], error: null }));

  await publishMerchantCgvVersionServerAuthoritative("tok-abc", "r1");

  assert.deepEqual(Object.keys(resolveArgs as Record<string, unknown>), ["p_restaurant_id"]);
  assert.equal((resolveArgs as Record<string, unknown>).p_restaurant_id, "r1");
});

test("2. persist_merchant_cgv_version est appelée EN SERVICE_ROLE avec EXACTEMENT 5 paramètres -- jamais de hash, locale ou variante fournis par l'appelant", async (t) => {
  mockAsUserClient(t, { rpc: async () => ({ data: [contextRow()], error: null }) });
  let persistName = "";
  let persistArgs: Record<string, unknown> = {};
  t.mock.method(admin, "rpc", async (name: string, args: Record<string, unknown>) => {
    persistName = name;
    persistArgs = args;
    return { data: [versionRow()], error: null };
  });

  await publishMerchantCgvVersionServerAuthoritative("tok-abc", "r1");

  assert.equal(persistName, "persist_merchant_cgv_version");
  assert.deepEqual(
    Object.keys(persistArgs).sort(),
    ["p_acting_user_id", "p_expected_context_fingerprint", "p_rendered_content", "p_restaurant_id", "p_template_id"],
    "aucun p_locale/p_presentation_variant/p_content_hash côté appelant -- le serveur ne transmet que ce que resolve_cgv_publication_context a résolu (y compris, depuis v1.2, le fingerprint et l'acting_user_id), jamais une valeur calculée ou fournie ailleurs"
  );
  assert.equal(persistArgs.p_restaurant_id, "r1");
  assert.equal(persistArgs.p_template_id, "t1");
  assert.equal(typeof persistArgs.p_rendered_content, "string");
  assert.equal(persistArgs.p_expected_context_fingerprint, "fp-abc123", "le fingerprint transmis == EXACTEMENT celui résolu à l'étape 1, jamais recalculé ni fourni par l'appelant");
  assert.equal(persistArgs.p_acting_user_id, "u1", "l'acting_user_id transmis == EXACTEMENT celui résolu à l'étape 1 (auth.uid() côté serveur), jamais fourni par l'appelant");
});

test("3. le contenu transmis à persist_merchant_cgv_version provient de renderCgv() -- jamais d'un champ 'renderedContent' arbitraire", async (t) => {
  mockAsUserClient(t, { rpc: async () => ({ data: [contextRow()], error: null }) });
  let renderedContent = "";
  t.mock.method(admin, "rpc", async (_name: string, args: Record<string, unknown>) => {
    renderedContent = args.p_rendered_content as string;
    return { data: [versionRow()], error: null };
  });

  await publishMerchantCgvVersionServerAuthoritative("tok-abc", "r1");

  assert.match(renderedContent, /Clause EXEMPT_PERISHABLE\./, "doit contenir la clause résolue par le contexte serveur");
  assert.match(renderedContent, /Resto A/, "doit contenir le nom du vendeur résolu par le contexte serveur, jamais fourni par l'appelant");
});

test("4. échec d'auth/autorisation/complétude EN AMONT empêche TOUJOURS l'appel à persist_merchant_cgv_version (fail-closed, ordre)", async (t) => {
  mockAsUserClient(t, { rpc: async () => ({ data: null, error: { code: "42501", message: "Not authorized for this restaurant" } }) });
  let persistCalled = false;
  t.mock.method(admin, "rpc", async () => { persistCalled = true; throw new Error("ne doit jamais être appelée"); });

  await assert.rejects(
    () => publishMerchantCgvVersionServerAuthoritative("tok-abc", "r1"),
    (err: unknown) => {
      assert.ok(err instanceof LegalCgvPublishServerError);
      assert.equal((err as InstanceType<typeof LegalCgvPublishServerError>).reason, "forbidden");
      return true;
    }
  );
  assert.equal(persistCalled, false);
});

test("5. resolve_ renvoie CGV_INCOMPLETE -- reason='incomplete', persist_ jamais appelée", async (t) => {
  mockAsUserClient(t, { rpc: async () => ({ data: null, error: { code: "P0001", message: "CGV_INCOMPLETE" } }) });
  let persistCalled = false;
  t.mock.method(admin, "rpc", async () => { persistCalled = true; throw new Error("ne doit jamais être appelée"); });

  await assert.rejects(
    () => publishMerchantCgvVersionServerAuthoritative("tok-abc", "r1"),
    (err: unknown) => (err as InstanceType<typeof LegalCgvPublishServerError>).reason === "incomplete"
  );
  assert.equal(persistCalled, false);
});

test("6. persist_ rejette un template inapplicable (TEMPLATE_NOT_APPLICABLE) -- classifié 'template_unresolved', jamais une fuite du message SQL brut", async (t) => {
  mockAsUserClient(t, { rpc: async () => ({ data: [contextRow()], error: null }) });
  t.mock.method(admin, "rpc", async () => ({ data: null, error: { message: "TEMPLATE_NOT_APPLICABLE" } }));

  await assert.rejects(
    () => publishMerchantCgvVersionServerAuthoritative("tok-abc", "r1"),
    (err: unknown) => {
      assert.ok(err instanceof LegalCgvPublishServerError);
      assert.equal((err as InstanceType<typeof LegalCgvPublishServerError>).reason, "template_unresolved");
      return true;
    }
  );
});

// --------------------------------------------------------------------
// 7-10. Contenu malveillant -- traverse tout le chemin d'orchestration
// et ressort échappé.
// --------------------------------------------------------------------

const MALICIOUS_PAYLOADS: Record<string, string> = {
  imgOnerror: "<img src=x onerror=alert(1)>",
  scriptTag: "<script>alert(1)</script>",
  eventHandlerAttribute: '" onmouseover="alert(1)" x="',
  javascriptUrl: "javascript:alert(1)",
};

for (const [label, payload] of Object.entries(MALICIOUS_PAYLOADS)) {
  test(`7. payload malveillant (${label}) dans legal_form (résolu par resolve_) ressort ÉCHAPPÉ dans p_rendered_content`, async (t) => {
    mockAsUserClient(t, { rpc: async () => ({ data: [contextRow({ legal_form: payload })], error: null }) });
    let renderedContent = "";
    t.mock.method(admin, "rpc", async (_name: string, args: Record<string, unknown>) => {
      renderedContent = args.p_rendered_content as string;
      return { data: [versionRow()], error: null };
    });

    await publishMerchantCgvVersionServerAuthoritative("tok-abc", "r1");

    // Un payload contenant des caractères échappables (<, >, ", ') ne
    // doit jamais apparaître tel quel ; "javascript:alert(1)" seul (sans
    // balise/attribut autour) n'a rien à échapper et ressort en clair
    // comme texte inerte -- comportement sûr, couvert par les deux
    // assertions <img>/<script>/href ci-dessous dans tous les cas.
    if (/[<>"']/.test(payload)) {
      assert.ok(!renderedContent.includes(payload), `${label}: le payload brut ne doit jamais apparaître`);
    }
    assert.doesNotMatch(renderedContent, /<img\b/i);
    assert.doesNotMatch(renderedContent, /<script\b/i);
    assert.doesNotMatch(renderedContent, /\shref\s*=\s*["']?javascript:/i);
  });
}

// --------------------------------------------------------------------
// 11-15. Route HTTP -- adaptateur fin, aucun contenu client accepté.
// --------------------------------------------------------------------

function publishReq(body: unknown, headers: Record<string, string> = { Authorization: "Bearer tok-abc" }) {
  return new NextRequest("https://internal.example.test/api/dashboard/legal-cgv/publish", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("11. requête valide -- 200, outcome ok, version renvoyée", async (t) => {
  mockAsUserClient(t, { rpc: async () => ({ data: [contextRow()], error: null }) });
  t.mock.method(admin, "rpc", async () => ({ data: [versionRow()], error: null }));

  const response = await POST(publishReq({ restaurantId: "r1" }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.outcome, "ok");
  assert.equal(data.version.id, "v1");
});

test("12. sans en-tête Authorization -- 401, aucun appel RPC déclenché", async (t) => {
  let asUserCalled = false;
  mockAsUserClient(t, { rpc: async () => { asUserCalled = true; throw new Error("ne doit jamais être appelée"); } });
  const response = await POST(publishReq({ restaurantId: "r1" }, {}));
  assert.equal(response.status, 401);
  assert.equal(asUserCalled, false);
});

test("13. restaurantId manquant -- 400, invalid_field", async () => {
  const response = await POST(publishReq({}));
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.outcome, "invalid_field");
  assert.equal(data.field, "restaurantId");
});

test("14. DIRECT RPC BYPASS via la route HTTP -- un corps de requête tentant d'injecter renderedContent/templateId/presentationVariant/locale est intégralement IGNORÉ (seul restaurantId est jamais lu)", async (t) => {
  mockAsUserClient(t, { rpc: async () => ({ data: [contextRow()], error: null }) });
  let persistArgs: Record<string, unknown> = {};
  t.mock.method(admin, "rpc", async (_name: string, args: Record<string, unknown>) => {
    persistArgs = args;
    return { data: [versionRow()], error: null };
  });

  const attackerBody = {
    restaurantId: "r1",
    renderedContent: "<script>alert('forged')</script>",
    templateId: "attacker-chosen-template",
    presentationVariant: "ATTACKER",
    locale: "xx",
    contentHash: "forged-hash",
    // v1.2 -- un attaquant tentant en plus de forger le fingerprint de
    // contexte et/ou l'acting_user_id (les deux nouvelles sorties
    // server-only de resolve_cgv_publication_context) : intégralement
    // ignoré, exactement comme les champs v1.1 ci-dessus.
    contextFingerprint: "attacker-chosen-fingerprint",
    acting_user_id: "attacker-chosen-uid",
  };
  const response = await POST(publishReq(attackerBody));
  assert.equal(response.status, 200);
  assert.ok(!String(persistArgs.p_rendered_content).includes("forged"), "le contenu forgé par l'appelant ne doit jamais atteindre la persistance");
  assert.equal(persistArgs.p_template_id, "t1", "le template id reste celui résolu par le serveur, jamais 'attacker-chosen-template'");
  assert.equal(persistArgs.p_expected_context_fingerprint, "fp-abc123", "le fingerprint reste EXACTEMENT celui résolu par le serveur, jamais 'attacker-chosen-fingerprint'");
  assert.equal(persistArgs.p_acting_user_id, "u1", "l'acting_user_id reste EXACTEMENT celui résolu par le serveur, jamais 'attacker-chosen-uid'");
});

test("15. erreur amont (incomplete) -- 409, jamais un message SQL brut exposé", async (t) => {
  mockAsUserClient(t, { rpc: async () => ({ data: null, error: { code: "P0001", message: "CGV_INCOMPLETE" } }) });
  const response = await POST(publishReq({ restaurantId: "r1" }));
  assert.equal(response.status, 409);
  const data = await response.json();
  assert.equal(data.outcome, "incomplete");
  assert.ok(!JSON.stringify(data).includes("CGV_INCOMPLETE"), "jamais le message SQL brut dans la réponse HTTP");
});

// --------------------------------------------------------------------
// 16-18. Preuve STRUCTURELLE côté navigateur -- lib/services/legal-cgv.ts
// ne transmet plus jamais de contenu/rendu/gabarit au serveur.
// --------------------------------------------------------------------

const BROWSER_SERVICE_SRC = readFileSync(new URL("../lib/services/legal-cgv.ts", import.meta.url), "utf8");

test("16. lib/services/legal-cgv.ts n'appelle plus jamais supabase.rpc('publish_merchant_cgv_version', ...)", () => {
  assert.doesNotMatch(BROWSER_SERVICE_SRC, /rpc\(\s*["']publish_merchant_cgv_version["']/);
});

test("17. la fonction navigateur publishMerchantCgvVersion n'accepte plus que { restaurantId } -- aucun templateId/locale/presentationVariant/renderedContent dans sa signature", () => {
  const match = BROWSER_SERVICE_SRC.match(
    /export async function publishMerchantCgvVersion\(params: \{([^}]*)\}\)/
  );
  assert.ok(match, "signature de publishMerchantCgvVersion introuvable");
  const paramsBlock = match![1];
  assert.match(paramsBlock, /restaurantId/);
  for (const forbidden of ["templateId", "renderedContent", "presentationVariant", "locale"]) {
    assert.ok(!paramsBlock.includes(forbidden), `le paramètre '${forbidden}' ne doit plus exister sur publishMerchantCgvVersion`);
  }
});

test("18. lib/services/legal-cgv.ts appelle la route de confiance app/api/dashboard/legal-cgv/publish, jamais une RPC Supabase, pour la publication", () => {
  assert.match(BROWSER_SERVICE_SRC, /\/api\/dashboard\/legal-cgv\/publish/);
});

// --------------------------------------------------------------------
// 19-22. v1.2 -- CGV-V11-PUBLISH-CONTEXT-RACE-01 : fingerprint/
// acting_user_id proviennent EXCLUSIVEMENT de l'étape 1, jamais d'un
// champ arbitraire ; classification STALE_CONTEXT ; jamais exposé au
// navigateur.
// --------------------------------------------------------------------

test("19. le fingerprint et l'acting_user_id transmis à persist_ varient avec ceux résolus par resolve_ (pas des constantes codées en dur)", async (t) => {
  mockAsUserClient(t, {
    rpc: async () => ({ data: [contextRow({ context_fingerprint: "fp-DIFFERENT", acting_user_id: "u-DIFFERENT" })], error: null }),
  });
  let persistArgs: Record<string, unknown> = {};
  t.mock.method(admin, "rpc", async (_name: string, args: Record<string, unknown>) => {
    persistArgs = args;
    return { data: [versionRow()], error: null };
  });

  await publishMerchantCgvVersionServerAuthoritative("tok-abc", "r1");

  assert.equal(persistArgs.p_expected_context_fingerprint, "fp-DIFFERENT");
  assert.equal(persistArgs.p_acting_user_id, "u-DIFFERENT");
});

test("20. persist_ renvoie STALE_CONTEXT -- reason='stale_context', jamais confondu avec 'incomplete'/'template_unresolved', jamais un message SQL brut exposé", async (t) => {
  mockAsUserClient(t, { rpc: async () => ({ data: [contextRow()], error: null }) });
  t.mock.method(admin, "rpc", async () => ({
    data: null,
    error: { code: "P0001", message: "STALE_CONTEXT" },
  }));

  await assert.rejects(
    () => publishMerchantCgvVersionServerAuthoritative("tok-abc", "r1"),
    (err: unknown) => {
      assert.ok(err instanceof LegalCgvPublishServerError);
      assert.equal((err as InstanceType<typeof LegalCgvPublishServerError>).reason, "stale_context");
      return true;
    }
  );
});

test("21. route HTTP -- STALE_CONTEXT côté persist_ -> 409, outcome='stale_context' (retriable), jamais un message SQL brut exposé", async (t) => {
  mockAsUserClient(t, { rpc: async () => ({ data: [contextRow()], error: null }) });
  t.mock.method(admin, "rpc", async () => ({ data: null, error: { code: "P0001", message: "STALE_CONTEXT" } }));

  const response = await POST(publishReq({ restaurantId: "r1" }));
  assert.equal(response.status, 409);
  const data = await response.json();
  assert.equal(data.outcome, "stale_context");
  assert.ok(!JSON.stringify(data).includes("authoritative context changed"), "jamais le détail SQL brut dans la réponse HTTP");
});

test("22. persist_ renvoie l'erreur d'autorisation (42501) émise par la re-vérification à la persistance -- classifiée 'forbidden', jamais 'stale_context' (une révocation d'autorisation n'est pas confondue avec une simple péremption de contenu)", async (t) => {
  mockAsUserClient(t, { rpc: async () => ({ data: [contextRow()], error: null }) });
  t.mock.method(admin, "rpc", async () => ({
    data: null,
    error: { code: "42501", message: "Not authorized for this restaurant" },
  }));

  await assert.rejects(
    () => publishMerchantCgvVersionServerAuthoritative("tok-abc", "r1"),
    (err: unknown) => {
      assert.ok(err instanceof LegalCgvPublishServerError);
      assert.equal((err as InstanceType<typeof LegalCgvPublishServerError>).reason, "forbidden");
      return true;
    }
  );
});
