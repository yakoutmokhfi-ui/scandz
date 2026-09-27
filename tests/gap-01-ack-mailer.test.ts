import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// GAP-01 — ack-mailer.ts. AUCUN test ici n'ouvre de socket réel : le
// SmtpTransport est TOUJOURS une implémentation simulée injectée dans
// AckDependencies/sendWithdrawalAcknowledgement. La construction du
// contenu (buildAckEmailContent) est testée séparément, en PUR (aucun
// I/O), et readSmtpConfig() via process.env directement (restauré
// après chaque test).
// ====================================================================

const {
  buildAckEmailContent,
  readSmtpConfig,
  sendWithdrawalAcknowledgement,
  ACK_EMAIL_CONTENT_VERSION,
} = await import("../lib/server/ack-mailer.ts");

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// --------------------------------------------------------------------
// A. readSmtpConfig — noms EXACTS confirmés sur l'issue #11.
// --------------------------------------------------------------------
test("readSmtpConfig : renvoie null si UNE SEULE variable SMTP_* manque", () => {
  withEnv(
    { SMTP_HOST: "ssl0.ovh.net", SMTP_PORT: "465", SMTP_USER: "retractation@scanym.com", SMTP_PASSWORD: undefined, SMTP_FROM: "retractation@scanym.com" },
    () => {
      assert.equal(readSmtpConfig(), null);
    }
  );
});

test("readSmtpConfig : ignore les variantes SCANYM_ACK_SMTP_* (noms provisoires écartés par Ravel)", () => {
  withEnv(
    {
      SMTP_HOST: undefined,
      SMTP_PORT: undefined,
      SMTP_USER: undefined,
      SMTP_PASSWORD: undefined,
      SMTP_FROM: undefined,
      SCANYM_ACK_SMTP_HOST: "ssl0.ovh.net",
      SCANYM_ACK_SMTP_PORT: "465",
      SCANYM_ACK_SMTP_USER: "retractation@scanym.com",
      SCANYM_ACK_SMTP_PASSWORD: "secret",
      SCANYM_ACK_SMTP_FROM: "retractation@scanym.com",
    },
    () => {
      assert.equal(readSmtpConfig(), null, "SCANYM_ACK_SMTP_* ne doit JAMAIS être lu");
    }
  );
});

test("readSmtpConfig : renvoie la config quand les CINQ variables SMTP_HOST/PORT/USER/PASSWORD/FROM sont présentes", () => {
  withEnv(
    {
      SMTP_HOST: "ssl0.ovh.net",
      SMTP_PORT: "465",
      SMTP_USER: "retractation@scanym.com",
      SMTP_PASSWORD: "secret",
      SMTP_FROM: "retractation@scanym.com",
    },
    () => {
      const cfg = readSmtpConfig();
      assert.ok(cfg);
      assert.equal(cfg.host, "ssl0.ovh.net");
      assert.equal(cfg.port, 465);
      assert.equal(cfg.from, "retractation@scanym.com");
    }
  );
});

test("readSmtpConfig : SMTP_PORT non numérique -> null (jamais NaN silencieux)", () => {
  withEnv(
    { SMTP_HOST: "ssl0.ovh.net", SMTP_PORT: "abc", SMTP_USER: "u", SMTP_PASSWORD: "p", SMTP_FROM: "f@x.com" },
    () => {
      assert.equal(readSmtpConfig(), null);
    }
  );
});

// --------------------------------------------------------------------
// B. buildAckEmailContent — contenu PUR, FR/EN/AR.
// --------------------------------------------------------------------
const baseContentInput = {
  orderNumber: 42,
  requestedAt: "2026-09-27T10:15:00Z",
  customerFirstName: "Jean",
  customerLastName: "Dupont",
  lines: [{ itemName: "Plateau réutilisable", optionName: null, quantity: 2 }],
  merchantName: "Le Gap Un",
  merchantContactEmail: "contact@le-gap-un.example",
  merchantContactPhone: null,
};

test("buildAckEmailContent : FR mentionne la commande, le client, le marchand et le contenu déclaré", () => {
  const content = buildAckEmailContent({ lang: "fr", ...baseContentInput });
  assert.match(content.subject, /42/);
  assert.match(content.text, /Jean Dupont/);
  assert.match(content.text, /Le Gap Un/);
  assert.match(content.text, /Plateau réutilisable/);
  assert.match(content.text, /modalités pratiques de retour/);
});

test("buildAckEmailContent : EN et AR produisent un texte non vide et distinct du FR", () => {
  const fr = buildAckEmailContent({ lang: "fr", ...baseContentInput });
  const en = buildAckEmailContent({ lang: "en", ...baseContentInput });
  const ar = buildAckEmailContent({ lang: "ar", ...baseContentInput });
  assert.notEqual(en.text, fr.text);
  assert.notEqual(ar.text, fr.text);
  assert.match(en.subject, /42/);
  assert.match(ar.subject, /42/);
});

test("buildAckEmailContent : contenu déterministe (mêmes entrées -> même sortie)", () => {
  const a = buildAckEmailContent({ lang: "fr", ...baseContentInput });
  const b = buildAckEmailContent({ lang: "fr", ...baseContentInput });
  assert.deepEqual(a, b);
});

// --------------------------------------------------------------------
// C. sendWithdrawalAcknowledgement — orchestration, transport simulé.
// --------------------------------------------------------------------
function fakeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const sent: unknown[] = [];
  const recorded: unknown[] = [];
  const claimCalls: string[] = [];

  return {
    sent,
    recorded,
    claimCalls,
    deps: {
      transport: {
        async send(input: unknown) {
          sent.push(input);
          return { ok: true, messageId: "<test-message-id@example.com>" };
        },
        async checkConnectivity() {
          return { ok: true };
        },
        ...(overrides.transport as object ?? {}),
      },
      async claim(id: string) {
        claimCalls.push(id);
        if (overrides.claim) return (overrides.claim as (id: string) => unknown)(id);
        return {
          id,
          restaurantId: "11111111-1111-4111-8111-111111111111",
          orderId: "22222222-2222-4222-8222-222222222222",
          acknowledgementAddress: "client@example.com",
          customerFirstName: "Jean",
          customerLastName: "Dupont",
          declarationSnapshot: {
            order_number: 42,
            declared_at: "2026-09-27T10:15:00Z",
            lines: [{ item_name: "Plateau réutilisable", option_name: null, quantity: 2 }],
          },
          merchantName: "Le Gap Un",
          merchantContactEmail: "contact@le-gap-un.example",
          merchantContactPhone: null,
        };
      },
      async recordResult(input: unknown) {
        recorded.push(input);
      },
    },
  };
}

test("sendWithdrawalAcknowledgement : SMTP non configuré -> aucun envoi tenté (no-op gracieux), aucun claim", () => {
  return withEnv(
    { SMTP_HOST: undefined, SMTP_PORT: undefined, SMTP_USER: undefined, SMTP_PASSWORD: undefined, SMTP_FROM: undefined },
    async () => {
      const { deps, sent, claimCalls, recorded } = fakeDeps();
      const outcome = await sendWithdrawalAcknowledgement("wr-1", deps as never, "fr");
      assert.equal(outcome.attempted, false);
      assert.equal((outcome as { reason: string }).reason, "no_channel");
      assert.equal(sent.length, 0);
      assert.equal(claimCalls.length, 0);
      assert.equal(recorded.length, 0);
    }
  ) as unknown as void;
});

const SMTP_ENV = {
  SMTP_HOST: "ssl0.ovh.net",
  SMTP_PORT: "465",
  SMTP_USER: "retractation@scanym.com",
  SMTP_PASSWORD: "secret",
  SMTP_FROM: "retractation@scanym.com",
};

test("sendWithdrawalAcknowledgement : envoi réussi -- To=client, CC=contact marchand, enregistre le résultat", async () => {
  await withEnvAsync(SMTP_ENV, async () => {
    const { deps, sent, recorded } = fakeDeps();
    const outcome = await sendWithdrawalAcknowledgement("wr-1", deps as never, "fr");
    assert.equal(outcome.attempted, true);
    assert.equal((outcome as { ok: boolean }).ok, true);

    assert.equal(sent.length, 1);
    const sentMessage = sent[0] as { to: string; cc: string | null; subject: string };
    assert.equal(sentMessage.to, "client@example.com");
    assert.equal(sentMessage.cc, "contact@le-gap-un.example");

    assert.equal(recorded.length, 1);
    const rec = recorded[0] as { ok: boolean; to: string; cc: string | null; messageId: string | null; contentVersion: string | null };
    assert.equal(rec.ok, true);
    assert.equal(rec.to, "client@example.com");
    assert.equal(rec.cc, "contact@le-gap-un.example");
    assert.equal(rec.messageId, "<test-message-id@example.com>");
    assert.equal(rec.contentVersion, ACK_EMAIL_CONTENT_VERSION);
  });
});

test("sendWithdrawalAcknowledgement : claim refusé (déjà pris ailleurs) -> aucun envoi, aucun enregistrement", async () => {
  await withEnvAsync(SMTP_ENV, async () => {
    const { deps, sent, recorded } = fakeDeps({ claim: async () => null });
    const outcome = await sendWithdrawalAcknowledgement("wr-1", deps as never, "fr");
    assert.equal(outcome.attempted, false);
    assert.equal((outcome as { reason: string }).reason, "already_claimed_elsewhere");
    assert.equal(sent.length, 0);
    assert.equal(recorded.length, 0);
  });
});

test("sendWithdrawalAcknowledgement : échec SMTP -- enregistre TOUJOURS le résultat (preuve d'évidence même en échec), ok=false", async () => {
  await withEnvAsync(SMTP_ENV, async () => {
    const { deps, recorded } = fakeDeps({
      transport: {
        async send() {
          return { ok: false, error: "ECONNREFUSED" };
        },
      },
    });
    const outcome = await sendWithdrawalAcknowledgement("wr-1", deps as never, "fr");
    assert.equal(outcome.attempted, true);
    assert.equal((outcome as { ok: boolean }).ok, false);
    assert.equal((outcome as { error: string }).error, "ECONNREFUSED");

    assert.equal(recorded.length, 1);
    const rec = recorded[0] as { ok: boolean; messageId: string | null; error: string | null };
    assert.equal(rec.ok, false);
    assert.equal(rec.messageId, null);
    assert.equal(rec.error, "ECONNREFUSED");
  });
});

test("sendWithdrawalAcknowledgement : n'expose jamais d'exception -- une dépendance qui lève est capturée par l'appelant (contrat documenté, testé ici sur claim)", async () => {
  await withEnvAsync(SMTP_ENV, async () => {
    const { deps } = fakeDeps({
      claim: async () => {
        throw new Error("boom");
      },
    });
    await assert.rejects(() => sendWithdrawalAcknowledgement("wr-1", deps as never, "fr"));
    // Documente le contrat : sendWithdrawalAcknowledgement lui-même
    // peut lever si une DÉPENDANCE lève -- c'est
    // tryDispatchWithdrawalAcknowledgement (withdrawal-ack-service.ts)
    // qui porte la garantie "jamais d'exception exposée à la route
    // HTTP", testée séparément.
  });
});

async function withEnvAsync(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
