import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — PAYMENT P3-B5 v2 — DURABLE PROVIDER CALLBACK INBOX.
//
// v1 a reçu un verdict Work FAIL (release-blocking) : P3B5-RETRY-01
// (HIGH, aucune capacité de reprise après crash) et
// P3B5-FINGERPRINT-01 (MEDIUM, fingerprint non aligné sur la
// normalisation SQL + injection de fingerprint arbitraire possible).
// Ce fichier couvre la correction v2 :
//   - canonicalizePaymentProviderEventFields / computePaymentProviderEventFingerprint
//     (lib/server/payment-provider-event-fingerprint.ts) -- fonctions
//     PURES, aucun I/O, testées directement. Ferme P3B5-FINGERPRINT-01.
//   - recordPaymentProviderEvent (n'accepte PLUS de fingerprint fourni
//     par l'appelant -- le calcule lui-même à partir des champs
//     canonicalisés).
//   - claimPaymentProviderEvents (NOUVEAU v2, ferme P3B5-RETRY-01).
//   - updatePaymentProviderEventProcessingStatus (exige désormais
//     `claimToken`).
//
// Patron déjà établi par ce dépôt : `t.mock.method(client, "rpc", ...)`
// sur le CLIENT RÉEL construit par getServiceRoleSupabaseClient() (une
// seule construction partagée par tout ce fichier).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "p3b5-synthetic-service-role-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const {
  recordPaymentProviderEvent,
  updatePaymentProviderEventProcessingStatus,
  claimPaymentProviderEvents,
} = await import("../lib/server/payment-service.ts");
const {
  canonicalizePaymentProviderEventFields,
  computePaymentProviderEventFingerprint,
  PaymentProviderEventCanonicalizationError,
} = await import("../lib/server/payment-provider-event-fingerprint.ts");
const { PaymentServerRpcError, PaymentServerUnavailableError } = await import(
  "../lib/server/payment-errors.ts"
);

const FAKE_SQLSTATE = "P0002";
const FAKE_SECRET_IN_ERROR = "p3b5-fake-secret-in-error-DO-NOT-USE";
const FAKE_TABLE_NAME = "payment_provider_events_internal_fake";
const VALID_FINGERPRINT = "a".repeat(64);
const MALICIOUS_FINGERPRINT = "f".repeat(64);

const SUCCESS_ROW = {
  id: "evt-1",
  restaurant_id: "resto-1",
  order_id: "order-1",
  payment_transaction_id: "txn-1",
  provider_event_type: "authorized",
  processing_status: "received",
  created_at: "2026-01-01T00:00:00.000Z",
  is_new_event: true,
};

// ====================================================================
// canonicalizePaymentProviderEventFields -- fonction PURE, aucun I/O.
// Ferme P3B5-FINGERPRINT-01 : une SEULE autorité de canonicalisation.
// ====================================================================

test("canonicalize: trim provider_code/provider_reference/provider_event_type, casse PRÉSERVÉE", () => {
  const canonical = canonicalizePaymentProviderEventFields({
    providerCode: "  Monetico  ",
    providerReference: "  Ref-1  ",
    providerEventType: "  Authorized  ",
  });
  assert.equal(canonical.providerCode, "Monetico");
  assert.equal(canonical.providerReference, "Ref-1");
  assert.equal(canonical.providerEventType, "Authorized");
});

test("canonicalize: providerEventCode/authorizationReference -- undefined/absent/vide/blanc convergent tous vers null", () => {
  for (const value of [undefined, "", "   "]) {
    const canonical = canonicalizePaymentProviderEventFields({
      providerCode: "monetico",
      providerReference: "ref-1",
      providerEventType: "authorized",
      providerEventCode: value,
      authorizationReference: value,
    });
    assert.equal(canonical.providerEventCode, null, `providerEventCode pour ${JSON.stringify(value)}`);
    assert.equal(
      canonical.authorizationReference,
      null,
      `authorizationReference pour ${JSON.stringify(value)}`
    );
  }
});

test("canonicalize: providerEventCode/authorizationReference non vides sont trim() mais casse PRÉSERVÉE", () => {
  const canonical = canonicalizePaymentProviderEventFields({
    providerCode: "monetico",
    providerReference: "ref-1",
    providerEventType: "authorized",
    providerEventCode: "  Ax00  ",
    authorizationReference: "  AuthRef-1  ",
  });
  assert.equal(canonical.providerEventCode, "Ax00");
  assert.equal(canonical.authorizationReference, "AuthRef-1");
});

test("canonicalize: currency -- trim PUIS uppercase, vide/absent -> null", () => {
  assert.equal(
    canonicalizePaymentProviderEventFields({
      providerCode: "monetico",
      providerReference: "ref-1",
      providerEventType: "authorized",
      amount: "10",
      currency: "  eur  ",
    }).currency,
    "EUR"
  );
  for (const value of [undefined, "", "  "]) {
    assert.equal(
      canonicalizePaymentProviderEventFields({
        providerCode: "monetico",
        providerReference: "ref-1",
        providerEventType: "authorized",
        currency: value,
      }).currency,
      null
    );
  }
});

test("canonicalize: amount -- undefined/absent -> null", () => {
  const canonical = canonicalizePaymentProviderEventFields({
    providerCode: "monetico",
    providerReference: "ref-1",
    providerEventType: "authorized",
  });
  assert.equal(canonical.amount, null);
});

test("canonicalize: amount -- '10'/'10.0'/'10.00'/'0010.00'/'00010' convergent TOUS vers exactement '10.00' (ferme P3B5-FINGERPRINT-01 v3 -- zéros non significatifs)", () => {
  for (const raw of ["10", "10.0", "10.00", " 10.00 ", "0010.00", "00010", "000010.0"]) {
    const canonical = canonicalizePaymentProviderEventFields({
      providerCode: "monetico",
      providerReference: "ref-1",
      providerEventType: "authorized",
      amount: raw,
      currency: "EUR",
    });
    assert.equal(canonical.amount, "10.00", `amount canonique pour ${JSON.stringify(raw)}`);
  }
});

test("canonicalize: amount -- '0'/'0.0'/'0.00'/'-0.00'/'-0' convergent TOUS vers le zéro canonique UNIQUE '0.00' (ferme P3B5-FINGERPRINT-01 v3 -- pas de zéro signé)", () => {
  for (const raw of ["0", "0.0", "0.00", "-0.00", "-0", "00.00", "-00.0"]) {
    const canonical = canonicalizePaymentProviderEventFields({
      providerCode: "monetico",
      providerReference: "ref-1",
      providerEventType: "authorized",
      amount: raw,
      currency: "EUR",
    });
    assert.equal(canonical.amount, "0.00", `amount canonique pour ${JSON.stringify(raw)}`);
  }
});

test("canonicalize: amount -- une valeur négative non nulle CONSERVE son signe (jamais confondue avec le zéro canonique)", () => {
  const canonical = canonicalizePaymentProviderEventFields({
    providerCode: "monetico",
    providerReference: "ref-1",
    providerEventType: "authorized",
    amount: "-0.01",
    currency: "EUR",
  });
  assert.equal(canonical.amount, "-0.01");
});

test("canonicalize: amount -- plage numeric(12,2) : 10 chiffres entiers ACCEPTÉS (borne exacte), 11 REJETÉS (vérifié empiriquement contre une vraie base PostgreSQL 16 -- voir BUILD-REPORT/FINGERPRINT-CANONICALIZATION-MATRIX)", () => {
  const atLimit = canonicalizePaymentProviderEventFields({
    providerCode: "monetico",
    providerReference: "ref-1",
    providerEventType: "authorized",
    amount: "9999999999.99",
    currency: "EUR",
  });
  assert.equal(atLimit.amount, "9999999999.99");
  assert.throws(
    () =>
      canonicalizePaymentProviderEventFields({
        providerCode: "monetico",
        providerReference: "ref-1",
        providerEventType: "authorized",
        amount: "99999999999.99",
        currency: "EUR",
      }),
    PaymentProviderEventCanonicalizationError
  );
  // Un préfixe de zéros non significatifs qui, une fois retiré, reste
  // DANS la plage doit rester ACCEPTÉ (le rejet porte sur la valeur
  // réelle après normalisation, jamais sur le nombre de caractères
  // bruts fournis).
  const paddedButInRange = canonicalizePaymentProviderEventFields({
    providerCode: "monetico",
    providerReference: "ref-1",
    providerEventType: "authorized",
    amount: "00009999999999.99",
    currency: "EUR",
  });
  assert.equal(paddedButInRange.amount, "9999999999.99");
});

test("canonicalize: amount -- distingue '10.01' de '10.10' (aucune convergence indue)", () => {
  const a = canonicalizePaymentProviderEventFields({
    providerCode: "monetico",
    providerReference: "ref-1",
    providerEventType: "authorized",
    amount: "10.01",
    currency: "EUR",
  });
  const b = canonicalizePaymentProviderEventFields({
    providerCode: "monetico",
    providerReference: "ref-1",
    providerEventType: "authorized",
    amount: "10.10",
    currency: "EUR",
  });
  assert.notEqual(a.amount, b.amount);
});

test("canonicalize: amount négatif reformaté correctement ('-5' -> '-5.00')", () => {
  const canonical = canonicalizePaymentProviderEventFields({
    providerCode: "monetico",
    providerReference: "ref-1",
    providerEventType: "authorized",
    amount: "-5",
    currency: "EUR",
  });
  assert.equal(canonical.amount, "-5.00");
});

test("canonicalize: amount -- chaîne vide/blanche -> null (jamais une exception)", () => {
  for (const raw of ["", "   "]) {
    const canonical = canonicalizePaymentProviderEventFields({
      providerCode: "monetico",
      providerReference: "ref-1",
      providerEventType: "authorized",
      amount: raw,
    });
    assert.equal(canonical.amount, null);
  }
});

test("canonicalize: amount -- plus de 2 décimales (arrondi implicite) REJETÉ (jamais un arrondi silencieux)", () => {
  assert.throws(
    () =>
      canonicalizePaymentProviderEventFields({
        providerCode: "monetico",
        providerReference: "ref-1",
        providerEventType: "authorized",
        amount: "10.005",
        currency: "EUR",
      }),
    PaymentProviderEventCanonicalizationError
  );
});

test("canonicalize: amount -- non numérique REJETÉ ('NaN', 'abc', 'Infinity')", () => {
  for (const raw of ["NaN", "abc", "Infinity", "1e10", "10,00"]) {
    assert.throws(
      () =>
        canonicalizePaymentProviderEventFields({
          providerCode: "monetico",
          providerReference: "ref-1",
          providerEventType: "authorized",
          amount: raw,
          currency: "EUR",
        }),
      PaymentProviderEventCanonicalizationError,
      `amount=${JSON.stringify(raw)} aurait dû être rejeté`
    );
  }
});

// ====================================================================
// computePaymentProviderEventFingerprint -- fonction PURE, aucun I/O.
// N'accepte QUE des champs déjà canoniques.
// ====================================================================

function canon(raw: Parameters<typeof canonicalizePaymentProviderEventFields>[0]) {
  return canonicalizePaymentProviderEventFields(raw);
}

test("computePaymentProviderEventFingerprint: renvoie exactement 64 caractères hexadécimaux minuscules (SHA-256 non tronqué)", () => {
  const fp = computePaymentProviderEventFingerprint(
    canon({ providerCode: "monetico", providerReference: "ref-1", providerEventType: "authorized" })
  );
  assert.match(fp, /^[0-9a-f]{64}$/);
});

test("computePaymentProviderEventFingerprint: déterministe -- mêmes entrées canoniques => même fingerprint, à chaque appel", () => {
  const canonical = canon({
    providerCode: "monetico",
    providerReference: "ref-1",
    providerEventType: "authorized",
    amount: "10.00",
    currency: "EUR",
  });
  const fp1 = computePaymentProviderEventFingerprint(canonical);
  const fp2 = computePaymentProviderEventFingerprint({ ...canonical });
  assert.equal(fp1, fp2);
});

test("computePaymentProviderEventFingerprint: sensible à CHAQUE champ -- changer un seul champ change le fingerprint", () => {
  const base = {
    providerCode: "monetico",
    providerReference: "ref-1",
    providerEventType: "authorized",
    providerEventCode: "00",
    amount: "10.00",
    currency: "EUR",
    authorizationReference: "auth-1",
  };
  const baseFp = computePaymentProviderEventFingerprint(canon(base));
  const variants: Array<Partial<typeof base>> = [
    { providerCode: "mercanet" },
    { providerReference: "ref-2" },
    { providerEventType: "refused" },
    { providerEventCode: "05" },
    { amount: "10.01" },
    { currency: "USD" },
    { authorizationReference: "auth-2" },
  ];
  for (const variant of variants) {
    const fp = computePaymentProviderEventFingerprint(canon({ ...base, ...variant }));
    assert.notEqual(fp, baseFp, `variant ${JSON.stringify(variant)} n'a pas changé le fingerprint`);
  }
});

test("computePaymentProviderEventFingerprint: distingue un champ ABSENT (undefined) d'un champ PRÉSENT mais VIDE (les deux canonicalisent vers null -- IDENTIQUE, comportement voulu depuis v2)", () => {
  const absentFp = computePaymentProviderEventFingerprint(
    canon({ providerCode: "monetico", providerReference: "ref-1", providerEventType: "authorized" })
  );
  const emptyFp = computePaymentProviderEventFingerprint(
    canon({
      providerCode: "monetico",
      providerReference: "ref-1",
      providerEventType: "authorized",
      providerEventCode: "",
    })
  );
  // Changement de contrat DÉLIBÉRÉ depuis v1 (ferme P3B5-FINGERPRINT-01,
  // mandat section 14) : "" et absent doivent produire la MÊME
  // représentation canonique (null), donc le MÊME fingerprint --
  // exactement ce que la RPC stocke déjà (NULLIF(...,'') dans les deux
  // cas). v1 les distinguait à tort.
  assert.equal(absentFp, emptyFp);
});

test("computePaymentProviderEventFingerprint: aucune ambiguïté de concaténation (\"AB\"+\"C\" vs \"A\"+\"BC\")", () => {
  const fpA = computePaymentProviderEventFingerprint(
    canon({ providerCode: "AB", providerReference: "C", providerEventType: "authorized" })
  );
  const fpB = computePaymentProviderEventFingerprint(
    canon({ providerCode: "A", providerReference: "BC", providerEventType: "authorized" })
  );
  assert.notEqual(fpA, fpB);
});

test("computePaymentProviderEventFingerprint: IDEMPOTENCE -- whitespace/numeric-format variants du MÊME évènement logique produisent le MÊME fingerprint (matrice mandat section 18)", () => {
  const variants: Array<Parameters<typeof canonicalizePaymentProviderEventFields>[0]> = [
    { providerCode: "monetico", providerReference: "ref-1", providerEventType: "authorized", amount: "10", currency: "EUR" },
    { providerCode: "  monetico  ", providerReference: "ref-1", providerEventType: "authorized", amount: "10.0", currency: "eur" },
    { providerCode: "monetico", providerReference: "ref-1", providerEventType: "  authorized  ", amount: "10.00", currency: "  EUR  " },
  ];
  const fingerprints = variants.map((v) => computePaymentProviderEventFingerprint(canon(v)));
  for (const fp of fingerprints) {
    assert.equal(fp, fingerprints[0]);
  }
});

test("computePaymentProviderEventFingerprint: IDEMPOTENCE v3 -- '10'/'10.0'/'10.00'/'0010.00'/'00010' produisent EXACTEMENT le MÊME fingerprint (mandat P3B5-FINGERPRINT-01 v3 section 7)", () => {
  const rawAmounts = ["10", "10.0", "10.00", "0010.00", "00010"];
  const fingerprints = rawAmounts.map((amount) =>
    computePaymentProviderEventFingerprint(
      canon({ providerCode: "monetico", providerReference: "ref-1", providerEventType: "authorized", amount, currency: "EUR" })
    )
  );
  for (const fp of fingerprints) {
    assert.equal(fp, fingerprints[0]);
  }
});

test("computePaymentProviderEventFingerprint: IDEMPOTENCE v3 -- '0'/'0.0'/'0.00'/'-0.00' produisent EXACTEMENT le MÊME fingerprint (zéro canonique unique, mandat P3B5-FINGERPRINT-01 v3 section 7)", () => {
  const rawAmounts = ["0", "0.0", "0.00", "-0.00"];
  const fingerprints = rawAmounts.map((amount) =>
    computePaymentProviderEventFingerprint(
      canon({ providerCode: "monetico", providerReference: "ref-1", providerEventType: "authorized", amount, currency: "EUR" })
    )
  );
  for (const fp of fingerprints) {
    assert.equal(fp, fingerprints[0]);
  }
});

test("computePaymentProviderEventFingerprint: '10.00' vs '10.01' DIFFÈRENT (mandat P3B5-FINGERPRINT-01 v3 section 7, cas explicite)", () => {
  const fpA = computePaymentProviderEventFingerprint(
    canon({ providerCode: "monetico", providerReference: "ref-1", providerEventType: "authorized", amount: "10.00", currency: "EUR" })
  );
  const fpB = computePaymentProviderEventFingerprint(
    canon({ providerCode: "monetico", providerReference: "ref-1", providerEventType: "authorized", amount: "10.01", currency: "EUR" })
  );
  assert.notEqual(fpA, fpB);
});

test("computePaymentProviderEventFingerprint: '0.00' vs '0.01' DIFFÈRENT (mandat P3B5-FINGERPRINT-01 v3 section 7, cas explicite -- le zéro canonique ne doit pas 'absorber' une valeur proche mais distincte)", () => {
  const fpA = computePaymentProviderEventFingerprint(
    canon({ providerCode: "monetico", providerReference: "ref-1", providerEventType: "authorized", amount: "0.00", currency: "EUR" })
  );
  const fpB = computePaymentProviderEventFingerprint(
    canon({ providerCode: "monetico", providerReference: "ref-1", providerEventType: "authorized", amount: "0.01", currency: "EUR" })
  );
  assert.notEqual(fpA, fpB);
});

test("computePaymentProviderEventFingerprint: DIFFÉRENCES SIGNIFICATIVES produisent des fingerprints DIFFÉRENTS (contrepartie de la matrice d'idempotence)", () => {
  const reference = computePaymentProviderEventFingerprint(
    canon({
      providerCode: "monetico",
      providerReference: "ref-1",
      providerEventType: "authorized",
      amount: "10.00",
      currency: "EUR",
    })
  );
  const differentReference = computePaymentProviderEventFingerprint(
    canon({
      providerCode: "monetico",
      providerReference: "ref-2",
      providerEventType: "authorized",
      amount: "10.00",
      currency: "EUR",
    })
  );
  const differentType = computePaymentProviderEventFingerprint(
    canon({
      providerCode: "monetico",
      providerReference: "ref-1",
      providerEventType: "refused",
      amount: "10.00",
      currency: "EUR",
    })
  );
  const differentAmount = computePaymentProviderEventFingerprint(
    canon({
      providerCode: "monetico",
      providerReference: "ref-1",
      providerEventType: "authorized",
      amount: "10.01",
      currency: "EUR",
    })
  );
  assert.notEqual(reference, differentReference);
  assert.notEqual(reference, differentType);
  assert.notEqual(reference, differentAmount);
});

// ====================================================================
// recordPaymentProviderEvent
// ====================================================================

test("recordPaymentProviderEvent: appelle EXACTEMENT record_payment_provider_event avec les 8 arguments attendus, rien d'autre", async (t) => {
  const calls: Array<{ name: string; args: unknown }> = [];
  t.mock.method(client, "rpc", async (name: string, args: unknown) => {
    calls.push({ name, args });
    return { data: [SUCCESS_ROW], error: null };
  });

  await recordPaymentProviderEvent({
    providerCode: "monetico",
    providerReference: "ref-1",
    providerEventType: "authorized",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "record_payment_provider_event");
  assert.deepEqual(Object.keys(calls[0]!.args as object).sort(), [
    "p_amount",
    "p_authorization_reference",
    "p_currency",
    "p_event_fingerprint",
    "p_provider_code",
    "p_provider_event_code",
    "p_provider_event_type",
    "p_provider_reference",
  ]);
  const args = calls[0]!.args as Record<string, unknown>;
  assert.equal(args.p_provider_code, "monetico");
  assert.equal(args.p_provider_reference, "ref-1");
  assert.match(String(args.p_event_fingerprint), /^[0-9a-f]{64}$/);
  assert.equal(args.p_provider_event_type, "authorized");
  assert.equal(args.p_provider_event_code, null);
  assert.equal(args.p_amount, null);
  assert.equal(args.p_currency, null);
  assert.equal(args.p_authorization_reference, null);
});

test("recordPaymentProviderEvent: le fingerprint envoyé à la RPC est EXACTEMENT computePaymentProviderEventFingerprint des champs canonicalisés -- jamais une valeur arbitraire (ferme P3B5-FINGERPRINT-01)", async (t) => {
  let sentArgs: Record<string, unknown> | undefined;
  t.mock.method(client, "rpc", async (_name: string, args: unknown) => {
    sentArgs = args as Record<string, unknown>;
    return { data: [SUCCESS_ROW], error: null };
  });

  await recordPaymentProviderEvent({
    providerCode: "  Monetico  ",
    providerReference: "ref-1",
    providerEventType: "authorized",
    amount: "10.0",
    currency: "eur",
  });

  const expectedFingerprint = computePaymentProviderEventFingerprint(
    canonicalizePaymentProviderEventFields({
      providerCode: "  Monetico  ",
      providerReference: "ref-1",
      providerEventType: "authorized",
      amount: "10.0",
      currency: "eur",
    })
  );
  assert.ok(sentArgs);
  assert.equal(sentArgs.p_event_fingerprint, expectedFingerprint);
  // Et les champs envoyés sont bien les valeurs CANONIQUES, pas les brutes.
  assert.equal(sentArgs.p_provider_code, "Monetico");
  assert.equal(sentArgs.p_amount, "10.00");
  assert.equal(sentArgs.p_currency, "EUR");
});

test("recordPaymentProviderEvent: l'API publique N'ACCEPTE PLUS de fingerprint fourni par l'appelant -- un champ eventFingerprint injecté (cast, contournement du typage) est IGNORÉ, jamais transmis à la RPC (ferme P3B5-FINGERPRINT-01/mandat section 19)", async (t) => {
  let sentArgs: Record<string, unknown> | undefined;
  t.mock.method(client, "rpc", async (_name: string, args: unknown) => {
    sentArgs = args as Record<string, unknown>;
    return { data: [SUCCESS_ROW], error: null };
  });

  const maliciousInput = {
    providerCode: "monetico",
    providerReference: "ref-1",
    providerEventType: "authorized",
    // N'existe plus dans RecordPaymentProviderEventInput -- simule un
    // appelant qui contournerait le typage pour injecter un fingerprint
    // sans rapport avec les champs réellement envoyés.
    eventFingerprint: MALICIOUS_FINGERPRINT,
  };
  await recordPaymentProviderEvent(
    maliciousInput as unknown as Parameters<typeof recordPaymentProviderEvent>[0]
  );

  assert.ok(sentArgs);
  assert.notEqual(sentArgs.p_event_fingerprint, MALICIOUS_FINGERPRINT);
  const expectedFingerprint = computePaymentProviderEventFingerprint(
    canonicalizePaymentProviderEventFields({
      providerCode: "monetico",
      providerReference: "ref-1",
      providerEventType: "authorized",
    })
  );
  assert.equal(sentArgs.p_event_fingerprint, expectedFingerprint);
});

test("recordPaymentProviderEvent: un amount malformé rejette AVANT tout appel RPC (erreur de canonicalisation locale, jamais une erreur RPC)", async (t) => {
  let rpcCalled = false;
  t.mock.method(client, "rpc", async () => {
    rpcCalled = true;
    return { data: [SUCCESS_ROW], error: null };
  });

  await assert.rejects(
    () =>
      recordPaymentProviderEvent({
        providerCode: "monetico",
        providerReference: "ref-1",
        providerEventType: "authorized",
        amount: "not-a-number",
        currency: "EUR",
      }),
    PaymentProviderEventCanonicalizationError
  );
  assert.equal(rpcCalled, false, "la RPC ne doit jamais être appelée si la canonicalisation échoue");
});

test("recordPaymentProviderEvent: un restaurantId/orderId/paymentTransactionId fourni artificiellement par l'appelant (cast) n'est jamais transmis à la RPC", async (t) => {
  let sentArgs: Record<string, unknown> | undefined;
  t.mock.method(client, "rpc", async (_name: string, args: unknown) => {
    sentArgs = args as Record<string, unknown>;
    return { data: [SUCCESS_ROW], error: null };
  });

  const maliciousInput = {
    providerCode: "monetico",
    providerReference: "ref-1",
    providerEventType: "authorized",
    // Champs qui n'existent PAS dans RecordPaymentProviderEventInput --
    // simule un appelant qui tenterait de forcer une corrélation
    // plutôt que de la faire dériver par la RPC elle-même.
    restaurantId: "should-never-be-sent",
    orderId: "should-never-be-sent",
    paymentTransactionId: "should-never-be-sent",
    processingStatus: "should-never-be-sent",
  };
  await recordPaymentProviderEvent(
    maliciousInput as unknown as Parameters<typeof recordPaymentProviderEvent>[0]
  );

  assert.ok(sentArgs);
  assert.deepEqual(Object.keys(sentArgs).sort(), [
    "p_amount",
    "p_authorization_reference",
    "p_currency",
    "p_event_fingerprint",
    "p_provider_code",
    "p_provider_event_code",
    "p_provider_event_type",
    "p_provider_reference",
  ]);
  const serialized = JSON.stringify(sentArgs);
  assert.ok(!serialized.includes("should-never-be-sent"));
});

test("recordPaymentProviderEvent: mapping succès -> les HUIT champs exacts, isNewEvent booléen préservé", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: [SUCCESS_ROW], error: null }));

  const result = await recordPaymentProviderEvent({
    providerCode: "monetico",
    providerReference: "ref-1",
    providerEventType: "authorized",
  });
  assert.deepEqual(result, {
    id: "evt-1",
    restaurantId: "resto-1",
    orderId: "order-1",
    paymentTransactionId: "txn-1",
    providerEventType: "authorized",
    processingStatus: "received",
    createdAt: "2026-01-01T00:00:00.000Z",
    isNewEvent: true,
  });
});

test("recordPaymentProviderEvent: isNewEvent=false (rejeu d'un évènement déjà enregistré) préservé EXACTEMENT, jamais forcé à true", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [{ ...SUCCESS_ROW, is_new_event: false }],
    error: null,
  }));
  const result = await recordPaymentProviderEvent({
    providerCode: "monetico",
    providerReference: "ref-1",
    providerEventType: "authorized",
  });
  assert.equal(result.isNewEvent, false);
  assert.equal(typeof result.isNewEvent, "boolean");
});

test("recordPaymentProviderEvent: transmet amount/currency/providerEventCode/authorizationReference optionnels, CANONICALISÉS", async (t) => {
  let sentArgs: Record<string, unknown> | undefined;
  t.mock.method(client, "rpc", async (_name: string, args: unknown) => {
    sentArgs = args as Record<string, unknown>;
    return { data: [SUCCESS_ROW], error: null };
  });

  await recordPaymentProviderEvent({
    providerCode: "monetico",
    providerReference: "ref-1",
    providerEventType: "authorized",
    providerEventCode: "  00  ",
    amount: "10",
    currency: "eur",
    authorizationReference: "  auth-1  ",
  });

  assert.ok(sentArgs);
  assert.equal(sentArgs.p_provider_event_code, "00");
  assert.equal(sentArgs.p_amount, "10.00");
  assert.equal(sentArgs.p_currency, "EUR");
  assert.equal(sentArgs.p_authorization_reference, "auth-1");
});

test("recordPaymentProviderEvent: le résultat ne contient JAMAIS de champ credential/Vault/secret/MAC, même si la RPC en renvoyait un (cast, dérive future du SQL simulée)", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [
      {
        ...SUCCESS_ROW,
        credentials_ref: "should-never-be-sent",
        mac: "should-never-be-sent",
        vault_secret: "should-never-be-sent",
        raw_payload: "should-never-be-sent",
      },
    ],
    error: null,
  }));

  const result = await recordPaymentProviderEvent({
    providerCode: "monetico",
    providerReference: "ref-1",
    providerEventType: "authorized",
  });
  assert.deepEqual(Object.keys(result).sort(), [
    "createdAt",
    "id",
    "isNewEvent",
    "orderId",
    "paymentTransactionId",
    "processingStatus",
    "providerEventType",
    "restaurantId",
  ]);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("should-never-be-sent"));
});

test("recordPaymentProviderEvent: erreur RPC (corrélation absente/ambiguë, SQLSTATE/secret factices) -> PaymentServerRpcError générique, AUCUN marqueur brut ne fuit", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: {
      code: FAKE_SQLSTATE,
      message: `no row found in "${FAKE_TABLE_NAME}", secret=${FAKE_SECRET_IN_ERROR}`,
      details: FAKE_SECRET_IN_ERROR,
      hint: FAKE_TABLE_NAME,
    },
  }));

  await assert.rejects(
    () =>
      recordPaymentProviderEvent({
        providerCode: "monetico",
        providerReference: "ref-unknown",
        providerEventType: "authorized",
      }),
    (err: unknown) => {
      assert.ok(err instanceof PaymentServerRpcError);
      const serialized = String(err.message) + String(err.stack ?? "");
      assert.ok(!serialized.includes(FAKE_SQLSTATE));
      assert.ok(!serialized.includes(FAKE_SECRET_IN_ERROR));
      assert.ok(!serialized.includes(FAKE_TABLE_NAME));
      return true;
    }
  );
});

test("recordPaymentProviderEvent: résultat vide/absent -> PaymentServerRpcError générique (jamais un undefined silencieusement propagé)", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: [], error: null }));
  await assert.rejects(
    () =>
      recordPaymentProviderEvent({
        providerCode: "monetico",
        providerReference: "ref-1",
        providerEventType: "authorized",
      }),
    PaymentServerRpcError
  );
});

test("recordPaymentProviderEvent: la RPC lève (indisponibilité réseau/transport) -> PaymentServerUnavailableError", async (t) => {
  t.mock.method(client, "rpc", async () => {
    throw new Error("fetch failed");
  });
  await assert.rejects(
    () =>
      recordPaymentProviderEvent({
        providerCode: "monetico",
        providerReference: "ref-1",
        providerEventType: "authorized",
      }),
    PaymentServerUnavailableError
  );
});

test("recordPaymentProviderEvent: aucune valeur ne fuit jamais dans console.log/error/warn", async (t) => {
  const seen: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => seen.push(args.map(String).join(" ")));
  t.mock.method(console, "error", (...args: unknown[]) => seen.push(args.map(String).join(" ")));
  t.mock.method(console, "warn", (...args: unknown[]) => seen.push(args.map(String).join(" ")));

  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: { code: FAKE_SQLSTATE, message: `secret=${FAKE_SECRET_IN_ERROR}`, details: null, hint: null },
  }));
  await assert.rejects(() =>
    recordPaymentProviderEvent({
      providerCode: "monetico",
      providerReference: "ref-1",
      providerEventType: "authorized",
    })
  );

  const combined = seen.join("\n");
  assert.ok(!combined.includes(FAKE_SECRET_IN_ERROR), "un marqueur factice est apparu dans une sortie console");
});

test("recordPaymentProviderEvent: aucun accès table direct -- appelle EXCLUSIVEMENT client.rpc(), jamais client.from(...)", async (t) => {
  let fromCalled = false;
  t.mock.method(client, "from", (...args: unknown[]) => {
    fromCalled = true;
    throw new Error(`client.from(${JSON.stringify(args)}) ne devrait jamais être appelé par ce wrapper`);
  });
  t.mock.method(client, "rpc", async () => ({ data: [SUCCESS_ROW], error: null }));

  await recordPaymentProviderEvent({
    providerCode: "monetico",
    providerReference: "ref-1",
    providerEventType: "authorized",
  });
  assert.equal(fromCalled, false, "recordPaymentProviderEvent ne doit jamais interroger une table directement");
});

// ====================================================================
// claimPaymentProviderEvents -- AJOUT v2, ferme P3B5-RETRY-01.
// ====================================================================

const CLAIMED_ROW = {
  id: "evt-1",
  restaurant_id: "resto-1",
  order_id: "order-1",
  payment_transaction_id: "txn-1",
  provider_code: "monetico",
  provider_reference: "ref-1",
  event_fingerprint: VALID_FINGERPRINT,
  provider_event_type: "authorized",
  provider_event_code: null,
  amount: "10.00",
  currency: "EUR",
  authorization_reference: null,
  processing_status: "received",
  retry_count: 0,
  claim_token: "claim-token-1",
  claim_expires_at: "2026-01-01T00:01:00.000Z",
};

test("claimPaymentProviderEvents: appelle EXACTEMENT claim_payment_provider_events avec les 2 arguments attendus", async (t) => {
  const calls: Array<{ name: string; args: unknown }> = [];
  t.mock.method(client, "rpc", async (name: string, args: unknown) => {
    calls.push({ name, args });
    return { data: [CLAIMED_ROW], error: null };
  });

  await claimPaymentProviderEvents({ batchSize: 5, leaseSeconds: 30 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "claim_payment_provider_events");
  assert.deepEqual(Object.keys(calls[0]!.args as object).sort(), ["p_batch_size", "p_lease_seconds"]);
  const args = calls[0]!.args as Record<string, unknown>;
  assert.equal(args.p_batch_size, 5);
  assert.equal(args.p_lease_seconds, 30);
});

test("claimPaymentProviderEvents: appelé SANS argument -> envoie null pour les deux paramètres (la RPC applique ses propres défauts)", async (t) => {
  let sentArgs: Record<string, unknown> | undefined;
  t.mock.method(client, "rpc", async (_name: string, args: unknown) => {
    sentArgs = args as Record<string, unknown>;
    return { data: [], error: null };
  });

  await claimPaymentProviderEvents();

  assert.ok(sentArgs);
  assert.equal(sentArgs.p_batch_size, null);
  assert.equal(sentArgs.p_lease_seconds, null);
});

test("claimPaymentProviderEvents: aucun évènement éligible -> tableau VIDE, jamais une erreur", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: [], error: null }));
  const result = await claimPaymentProviderEvents();
  assert.deepEqual(result, []);
});

test("claimPaymentProviderEvents: mapping complet de TOUS les champs, claimToken/claimExpiresAt inclus", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: [CLAIMED_ROW], error: null }));
  const result = await claimPaymentProviderEvents();
  assert.deepEqual(result, [
    {
      id: "evt-1",
      restaurantId: "resto-1",
      orderId: "order-1",
      paymentTransactionId: "txn-1",
      providerCode: "monetico",
      providerReference: "ref-1",
      eventFingerprint: VALID_FINGERPRINT,
      providerEventType: "authorized",
      providerEventCode: null,
      amount: "10.00",
      currency: "EUR",
      authorizationReference: null,
      processingStatus: "received",
      retryCount: 0,
      claimToken: "claim-token-1",
      claimExpiresAt: "2026-01-01T00:01:00.000Z",
    },
  ]);
});

test("claimPaymentProviderEvents: plusieurs évènements revendiqués -> tous mappés, dans l'ordre renvoyé par la RPC", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [CLAIMED_ROW, { ...CLAIMED_ROW, id: "evt-2", claim_token: "claim-token-2" }],
    error: null,
  }));
  const result = await claimPaymentProviderEvents({ batchSize: 10 });
  assert.equal(result.length, 2);
  assert.equal(result[0]!.id, "evt-1");
  assert.equal(result[1]!.id, "evt-2");
  assert.notEqual(result[0]!.claimToken, result[1]!.claimToken);
});

test("claimPaymentProviderEvents: retryCount numérique préservé exactement (jamais une chaîne)", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [{ ...CLAIMED_ROW, processing_status: "failed_retryable", retry_count: 2 }],
    error: null,
  }));
  const [result] = await claimPaymentProviderEvents();
  assert.equal(result!.retryCount, 2);
  assert.equal(typeof result!.retryCount, "number");
});

test("claimPaymentProviderEvents: un batchSize/leaseSeconds fourni artificiellement (cast) au-delà des deux champs attendus n'est jamais transmis à la RPC", async (t) => {
  let sentArgs: Record<string, unknown> | undefined;
  t.mock.method(client, "rpc", async (_name: string, args: unknown) => {
    sentArgs = args as Record<string, unknown>;
    return { data: [], error: null };
  });

  const maliciousInput = { batchSize: 5, leaseSeconds: 30, workerId: "should-never-be-sent" };
  await claimPaymentProviderEvents(
    maliciousInput as unknown as Parameters<typeof claimPaymentProviderEvents>[0]
  );

  assert.ok(sentArgs);
  assert.deepEqual(Object.keys(sentArgs).sort(), ["p_batch_size", "p_lease_seconds"]);
  assert.ok(!JSON.stringify(sentArgs).includes("should-never-be-sent"));
});

test("claimPaymentProviderEvents: le résultat ne contient JAMAIS de charge utile brute/secret/public_token, même si la RPC en renvoyait un (cast)", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [
      {
        ...CLAIMED_ROW,
        raw_payload: "should-never-be-sent",
        mac: "should-never-be-sent",
        public_token: "should-never-be-sent",
      },
    ],
    error: null,
  }));
  const [result] = await claimPaymentProviderEvents();
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("should-never-be-sent"));
});

test("claimPaymentProviderEvents: erreur RPC (bornes de lot invalides, SQLSTATE/secret factices) -> PaymentServerRpcError générique, AUCUN marqueur brut ne fuit", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: {
      code: "22023",
      message: `batch size out of range, secret=${FAKE_SECRET_IN_ERROR}`,
      details: FAKE_SECRET_IN_ERROR,
      hint: FAKE_TABLE_NAME,
    },
  }));

  await assert.rejects(
    () => claimPaymentProviderEvents({ batchSize: 99999 }),
    (err: unknown) => {
      assert.ok(err instanceof PaymentServerRpcError);
      const serialized = String(err.message) + String(err.stack ?? "");
      assert.ok(!serialized.includes(FAKE_SECRET_IN_ERROR));
      assert.ok(!serialized.includes(FAKE_TABLE_NAME));
      return true;
    }
  );
});

test("claimPaymentProviderEvents: la RPC lève (indisponibilité réseau/transport) -> PaymentServerUnavailableError", async (t) => {
  t.mock.method(client, "rpc", async () => {
    throw new Error("fetch failed");
  });
  await assert.rejects(() => claimPaymentProviderEvents(), PaymentServerUnavailableError);
});

test("claimPaymentProviderEvents: aucune valeur ne fuit jamais dans console.log/error/warn", async (t) => {
  const seen: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => seen.push(args.map(String).join(" ")));
  t.mock.method(console, "error", (...args: unknown[]) => seen.push(args.map(String).join(" ")));
  t.mock.method(console, "warn", (...args: unknown[]) => seen.push(args.map(String).join(" ")));

  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: { code: "22023", message: `secret=${FAKE_SECRET_IN_ERROR}`, details: null, hint: null },
  }));
  await assert.rejects(() => claimPaymentProviderEvents());

  const combined = seen.join("\n");
  assert.ok(!combined.includes(FAKE_SECRET_IN_ERROR), "un marqueur factice est apparu dans une sortie console");
});

test("claimPaymentProviderEvents: aucun accès table direct -- appelle EXCLUSIVEMENT client.rpc(), jamais client.from(...)", async (t) => {
  let fromCalled = false;
  t.mock.method(client, "from", (...args: unknown[]) => {
    fromCalled = true;
    throw new Error(`client.from(${JSON.stringify(args)}) ne devrait jamais être appelé par ce wrapper`);
  });
  t.mock.method(client, "rpc", async () => ({ data: [CLAIMED_ROW], error: null }));

  await claimPaymentProviderEvents();
  assert.equal(fromCalled, false, "claimPaymentProviderEvents ne doit jamais interroger une table directement");
});

// ====================================================================
// updatePaymentProviderEventProcessingStatus
// AJOUT v2 (ferme P3B5-RETRY-01) : `claimToken` désormais REQUIS.
// ====================================================================

const PROCESSING_SUCCESS_ROW = {
  id: "evt-1",
  processing_status: "applied",
  retry_count: 0,
  processed_at: "2026-01-01T00:01:00.000Z",
};

test("updatePaymentProviderEventProcessingStatus: appelle EXACTEMENT update_payment_provider_event_processing_status avec les 4 arguments attendus", async (t) => {
  const calls: Array<{ name: string; args: unknown }> = [];
  t.mock.method(client, "rpc", async (name: string, args: unknown) => {
    calls.push({ name, args });
    return { data: [PROCESSING_SUCCESS_ROW], error: null };
  });

  await updatePaymentProviderEventProcessingStatus({
    eventId: "evt-1",
    claimToken: "claim-token-1",
    newStatus: "applied",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "update_payment_provider_event_processing_status");
  assert.deepEqual(Object.keys(calls[0]!.args as object).sort(), [
    "p_claim_token",
    "p_error_class",
    "p_event_id",
    "p_new_status",
  ]);
  const args = calls[0]!.args as Record<string, unknown>;
  assert.equal(args.p_event_id, "evt-1");
  assert.equal(args.p_claim_token, "claim-token-1");
  assert.equal(args.p_new_status, "applied");
  assert.equal(args.p_error_class, null);
});

for (const status of ["applied", "ignored", "failed_retryable", "failed_terminal"] as const) {
  test(`updatePaymentProviderEventProcessingStatus: newStatus="${status}" transmis exactement, résultat mappé fidèlement`, async (t) => {
    t.mock.method(client, "rpc", async () => ({
      data: [{ ...PROCESSING_SUCCESS_ROW, processing_status: status }],
      error: null,
    }));
    const result = await updatePaymentProviderEventProcessingStatus({
      eventId: "evt-1",
      claimToken: "claim-token-1",
      newStatus: status,
      errorClass: status.startsWith("failed") ? "network_timeout" : undefined,
    });
    assert.equal(result.processingStatus, status);
  });
}

test("updatePaymentProviderEventProcessingStatus: retryCount numérique préservé exactement (jamais une chaîne)", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: [{ ...PROCESSING_SUCCESS_ROW, processing_status: "failed_retryable", retry_count: 3 }],
    error: null,
  }));
  const result = await updatePaymentProviderEventProcessingStatus({
    eventId: "evt-1",
    claimToken: "claim-token-1",
    newStatus: "failed_retryable",
    errorClass: "network_timeout",
  });
  assert.equal(result.retryCount, 3);
  assert.equal(typeof result.retryCount, "number");
});

test("updatePaymentProviderEventProcessingStatus: un processingStatus/retryCount fourni artificiellement par l'appelant (cast) n'est jamais transmis à la RPC", async (t) => {
  let sentArgs: Record<string, unknown> | undefined;
  t.mock.method(client, "rpc", async (_name: string, args: unknown) => {
    sentArgs = args as Record<string, unknown>;
    return { data: [PROCESSING_SUCCESS_ROW], error: null };
  });

  const maliciousInput = {
    eventId: "evt-1",
    claimToken: "claim-token-1",
    newStatus: "applied",
    processingStatus: "should-never-be-sent",
    retryCount: 999,
  };
  await updatePaymentProviderEventProcessingStatus(
    maliciousInput as unknown as Parameters<typeof updatePaymentProviderEventProcessingStatus>[0]
  );

  assert.ok(sentArgs);
  assert.deepEqual(Object.keys(sentArgs).sort(), [
    "p_claim_token",
    "p_error_class",
    "p_event_id",
    "p_new_status",
  ]);
  const serialized = JSON.stringify(sentArgs);
  assert.ok(!serialized.includes("should-never-be-sent"));
  assert.ok(!serialized.includes("999"));
});

test("updatePaymentProviderEventProcessingStatus: erreur RPC (jeton de revendication invalide/bail expiré, SQLSTATE/secret factices) -> PaymentServerRpcError générique, AUCUN marqueur brut ne fuit", async (t) => {
  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: {
      code: "P0004",
      message: `stale claim token, secret=${FAKE_SECRET_IN_ERROR}`,
      details: FAKE_SECRET_IN_ERROR,
      hint: FAKE_TABLE_NAME,
    },
  }));

  await assert.rejects(
    () =>
      updatePaymentProviderEventProcessingStatus({
        eventId: "evt-1",
        claimToken: "stale-token",
        newStatus: "failed_retryable",
      }),
    (err: unknown) => {
      assert.ok(err instanceof PaymentServerRpcError);
      const serialized = String(err.message) + String(err.stack ?? "");
      assert.ok(!serialized.includes(FAKE_SECRET_IN_ERROR));
      assert.ok(!serialized.includes(FAKE_TABLE_NAME));
      return true;
    }
  );
});

test("updatePaymentProviderEventProcessingStatus: résultat vide/absent -> PaymentServerRpcError générique", async (t) => {
  t.mock.method(client, "rpc", async () => ({ data: [], error: null }));
  await assert.rejects(
    () =>
      updatePaymentProviderEventProcessingStatus({
        eventId: "evt-unknown",
        claimToken: "claim-token-1",
        newStatus: "applied",
      }),
    PaymentServerRpcError
  );
});

test("updatePaymentProviderEventProcessingStatus: la RPC lève (indisponibilité réseau/transport) -> PaymentServerUnavailableError", async (t) => {
  t.mock.method(client, "rpc", async () => {
    throw new Error("fetch failed");
  });
  await assert.rejects(
    () =>
      updatePaymentProviderEventProcessingStatus({
        eventId: "evt-1",
        claimToken: "claim-token-1",
        newStatus: "applied",
      }),
    PaymentServerUnavailableError
  );
});

test("updatePaymentProviderEventProcessingStatus: aucune valeur ne fuit jamais dans console.log/error/warn", async (t) => {
  const seen: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => seen.push(args.map(String).join(" ")));
  t.mock.method(console, "error", (...args: unknown[]) => seen.push(args.map(String).join(" ")));
  t.mock.method(console, "warn", (...args: unknown[]) => seen.push(args.map(String).join(" ")));

  t.mock.method(client, "rpc", async () => ({
    data: null,
    error: { code: "P0004", message: `secret=${FAKE_SECRET_IN_ERROR}`, details: null, hint: null },
  }));
  await assert.rejects(() =>
    updatePaymentProviderEventProcessingStatus({
      eventId: "evt-1",
      claimToken: "claim-token-1",
      newStatus: "applied",
    })
  );

  const combined = seen.join("\n");
  assert.ok(!combined.includes(FAKE_SECRET_IN_ERROR), "un marqueur factice est apparu dans une sortie console");
});

test("updatePaymentProviderEventProcessingStatus: aucun accès table direct -- appelle EXCLUSIVEMENT client.rpc(), jamais client.from(...)", async (t) => {
  let fromCalled = false;
  t.mock.method(client, "from", (...args: unknown[]) => {
    fromCalled = true;
    throw new Error(`client.from(${JSON.stringify(args)}) ne devrait jamais être appelé par ce wrapper`);
  });
  t.mock.method(client, "rpc", async () => ({ data: [PROCESSING_SUCCESS_ROW], error: null }));

  await updatePaymentProviderEventProcessingStatus({
    eventId: "evt-1",
    claimToken: "claim-token-1",
    newStatus: "applied",
  });
  assert.equal(
    fromCalled,
    false,
    "updatePaymentProviderEventProcessingStatus ne doit jamais interroger une table directement"
  );
});
