import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Retour en développement de #221 (FAIL indépendant sur b90b48fc) :
//   P2-1  copie marchand perdue (contact invalide => « sent » sans copie)
//   P2-2  résultat d'envoi non enregistré (SMTP accepte, l'écriture échoue)
// Tests de COMPORTEMENT sur l'API publique : ils tournent tels quels sur le parent
// (rouges) et sur le correctif (verts). Aucun réseau, aucun e-mail réel.
// ====================================================================

process.env.MERCHANT_SMTP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

const mailer = await import("../lib/server/withdrawal-ack-merchant-mailer.ts");
const service = await import("../lib/server/withdrawal-ack-service.ts");
const { sendWithdrawalAcknowledgementViaMerchantMailer } = mailer;
const { createMerchantAckDependencies, dispatchWithdrawalAcknowledgement, reportedAcknowledgementStatus } = service;

const RA = "11111111-1111-4111-8111-111111111111";
const WID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function claimFor(overrides: Record<string, unknown> = {}) {
  return {
    id: WID,
    restaurantId: RA,
    orderId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    acknowledgementAddress: "client@example.test",
    customerFirstName: "Camille",
    customerLastName: "Test",
    declarationSnapshot: { order_number: 42, declared_at: "2026-11-01T10:00:00.000Z", lines: [] },
    merchantName: "Boutique A",
    merchantContactEmail: "contact-a@boutique-a.example.test",
    merchantContactPhone: null,
    merchantWithdrawalRegime: "STANDARD_14_DAYS",
    profileEmailEnabled: true,
    senderName: "Boutique A",
    senderEmail: "commandes-a@boutique-a.example.test",
    replyTo: "contact-a@boutique-a.example.test",
    ...overrides,
  };
}

function provider(result: unknown = { ok: true, providerMessageId: "<mid-1@mail.scanym.com>" }) {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    provider: { name: "merchant_smtp", async send(m: Record<string, unknown>) { sent.push(m); return result; } } as never,
  };
}

/** `record` : comportement de recordResult à chaque appel (true | false | Error à lever). */
function harness(opts: { claim: unknown; provider: unknown; record?: Array<boolean | Error> }) {
  const recorded: Array<Record<string, unknown>> = [];
  let resolved = 0;
  const script = [...(opts.record ?? [])];
  const deps = {
    async claim() { return opts.claim as never; },
    async resolveProvider() { resolved += 1; return opts.provider as never; },
    async recordResult(input: never) {
      recorded.push(input as Record<string, unknown>);
      const step = script.length > 1 ? script.shift()! : (script[0] ?? true);
      if (step instanceof Error) throw step;
      return step;
    },
    sleep: async () => {},
  };
  return { deps, recorded, resolved: () => resolved };
}

// --------------------------------------------------------------------
// P2-1 — copie marchand : deux destinataires validés AVANT l'envoi, refus explicite
// --------------------------------------------------------------------
test("P2-1 : contact marchand INVALIDE => échec explicite ACK_COPY_RECIPIENT_INVALID, aucun envoi, jamais « sent » sans copie", async () => {
  for (const bad of [
    "pas une adresse",
    "contact@",
    "@boutique.example.test",
    "contact a@boutique.example.test",
    "<contact@boutique.example.test>",
    "contact@boutique.example.test\r\nBcc: evil@example.test",
    "contact@boutique.example.test\nRCPT TO:<evil@example.test>",
    "a@b.test, c@d.test",
  ]) {
    for (const regime of ["STANDARD_14_DAYS", "MIXED", "EXEMPT", null]) {
      const p = provider();
      const h = harness({ claim: claimFor({ merchantContactEmail: bad, merchantWithdrawalRegime: regime }), provider: p.provider });
      const outcome = await sendWithdrawalAcknowledgementViaMerchantMailer(WID, h.deps);
      assert.deepEqual(outcome, { attempted: true, ok: false, error: "ACK_COPY_RECIPIENT_INVALID" }, JSON.stringify([bad, regime]));
      assert.equal(p.sent.length, 0, "aucun message n'est parti");
      assert.equal(h.resolved(), 0, "la messagerie n'est même pas résolue");
      assert.equal(h.recorded.length, 1);
      assert.equal(h.recorded[0].ok, false);
      assert.equal(h.recorded[0].error, "ACK_COPY_RECIPIENT_INVALID");
      assert.equal(h.recorded[0].cc, null);
    }
  }
});

test("P2-1 : contact marchand ABSENT (null, vide, espaces), quel que soit le régime => échec explicite ACK_COPY_RECIPIENT_MISSING", async () => {
  for (const missing of [null, "", "   ", "\t"]) {
    for (const regime of ["STANDARD_14_DAYS", "MIXED", "EXEMPT", null]) {
      const p = provider();
      const h = harness({ claim: claimFor({ merchantContactEmail: missing, merchantWithdrawalRegime: regime }), provider: p.provider });
      const outcome = await sendWithdrawalAcknowledgementViaMerchantMailer(WID, h.deps);
      assert.deepEqual(outcome, { attempted: true, ok: false, error: "ACK_COPY_RECIPIENT_MISSING" }, JSON.stringify([missing, regime]));
      assert.equal(p.sent.length, 0);
    }
  }
});

test("P2-1 : chemin nominal — un seul message, À = client, Cc = contact légal, copie enregistrée seulement avec le succès", async () => {
  const p = provider();
  const h = harness({ claim: claimFor(), provider: p.provider });
  const outcome = await sendWithdrawalAcknowledgementViaMerchantMailer(WID, h.deps);
  assert.equal(outcome.attempted && outcome.ok, true);
  assert.equal(p.sent.length, 1);
  assert.equal(p.sent[0].to, "client@example.test");
  assert.equal(p.sent[0].cc, "contact-a@boutique-a.example.test");
  assert.equal(h.recorded[0].cc, "contact-a@boutique-a.example.test");
});

test("P2-1 : contact = adresse du client => un seul destinataire (le commerçant reçoit le message en À), pas de Cc dupliqué", async () => {
  const p = provider();
  const h = harness({ claim: claimFor({ merchantContactEmail: "CLIENT@example.test" }), provider: p.provider });
  const outcome = await sendWithdrawalAcknowledgementViaMerchantMailer(WID, h.deps);
  assert.equal(outcome.attempted && outcome.ok, true);
  assert.equal(p.sent.length, 1);
  assert.equal(p.sent[0].cc, null);
});

test("P2-1 : copie refusée par le serveur SMTP (RCPT) => échec enregistré, jamais « sent »", async () => {
  const p = provider({ ok: false, retryable: false, errorClass: "INVALID_RECIPIENT" });
  const h = harness({ claim: claimFor(), provider: p.provider });
  const outcome = await sendWithdrawalAcknowledgementViaMerchantMailer(WID, h.deps);
  assert.deepEqual(outcome, { attempted: true, ok: false, error: "INVALID_RECIPIENT" });
  assert.equal(h.recorded[0].ok, false);
  assert.equal(h.recorded[0].cc, "contact-a@boutique-a.example.test", "la copie visée est tracée, l'échec aussi");
});

// --------------------------------------------------------------------
// P2-2 — résultat non enregistré : jamais présenté comme persisté
// --------------------------------------------------------------------
test("P2-2 : SMTP accepte, l'enregistrement renvoie false (ligne plus `sending`) => résultat NON persisté, jamais « sent », aucun renvoi", async () => {
  const p = provider();
  const h = harness({ claim: claimFor(), provider: p.provider, record: [false] });
  const outcome = await sendWithdrawalAcknowledgementViaMerchantMailer(WID, h.deps);
  assert.equal(outcome.attempted && outcome.ok, true, "l'acceptation SMTP est un fait");
  assert.equal((outcome as { resultPersisted?: boolean }).resultPersisted, false);
  assert.equal(reportedAcknowledgementStatus("pending", outcome), "unconfirmed");
  assert.equal(p.sent.length, 1, "pas de second envoi");
  assert.equal(h.recorded.length, 1, "false = la ligne a changé d'état : inutile de réessayer");
});

test("P2-2 : SMTP accepte, l'écriture du résultat échoue durablement (erreur RPC) => 3 tentatives bornées, puis « non confirmé », jamais « sent »", async () => {
  const p = provider();
  const h = harness({ claim: claimFor(), provider: p.provider, record: [new Error("rpc 503")] });
  const outcome = await sendWithdrawalAcknowledgementViaMerchantMailer(WID, h.deps);
  assert.equal(outcome.attempted && outcome.ok, true);
  assert.equal((outcome as { resultPersisted?: boolean }).resultPersisted, false);
  assert.equal(reportedAcknowledgementStatus("pending", outcome), "unconfirmed");
  assert.equal(h.recorded.length, 3);
  assert.equal(p.sent.length, 1, "l'échec d'écriture ne déclenche JAMAIS un second envoi");
});

test("P2-2 : erreur transitoire de l'écriture puis succès => résultat persisté, « sent », un seul envoi", async () => {
  const p = provider();
  const h = harness({ claim: claimFor(), provider: p.provider, record: [new Error("rpc timeout"), true] });
  const outcome = await sendWithdrawalAcknowledgementViaMerchantMailer(WID, h.deps);
  assert.equal(outcome.attempted && outcome.ok, true);
  assert.notEqual((outcome as { resultPersisted?: boolean }).resultPersisted, false);
  assert.equal(reportedAcknowledgementStatus("pending", outcome), "sent");
  assert.equal(h.recorded.length, 2);
  assert.equal(p.sent.length, 1);
});

test("P2-2 : échec SMTP + écriture impossible => échec observé rapporté « failed », résultat marqué non persisté, aucune exception", async () => {
  const p = provider({ ok: false, retryable: true, errorClass: "PROVIDER_TIMEOUT" });
  const h = harness({ claim: claimFor(), provider: p.provider, record: [new Error("rpc 503")] });
  const outcome = await sendWithdrawalAcknowledgementViaMerchantMailer(WID, h.deps);
  assert.equal(outcome.attempted && !outcome.ok && outcome.error, "PROVIDER_TIMEOUT");
  assert.equal((outcome as { resultPersisted?: boolean }).resultPersisted, false);
  assert.equal(reportedAcknowledgementStatus("pending", outcome), "failed");
});

test("P2-2 : le dispatch ne transforme pas une écriture en échec après un envoi accepté en « failed » (pas de faux échec, pas de rejet)", async () => {
  const p = provider();
  const h = harness({ claim: claimFor(), provider: p.provider, record: [new Error("rpc 503")] });
  const outcome = await dispatchWithdrawalAcknowledgement(WID, "fr", {
    isMerchantMailerActivated: async () => true,
    merchant: h.deps as never,
    legacy: { transport: {}, claim: async () => null, recordResult: async () => {} } as never,
  });
  assert.equal(outcome.attempted && outcome.ok, true);
  assert.equal(reportedAcknowledgementStatus("pending", outcome), "unconfirmed");
});

test("P2-2 : deux envois concurrents de la même demande => UN seul message (revendication unique)", async () => {
  const p = provider();
  let granted = false;
  const h = harness({ claim: null, provider: p.provider });
  const deps = {
    ...h.deps,
    async claim() {
      if (granted) return null;
      granted = true;
      await new Promise((r) => setTimeout(r, 10));
      return claimFor() as never;
    },
  };
  const [a, b] = await Promise.all([
    sendWithdrawalAcknowledgementViaMerchantMailer(WID, deps),
    sendWithdrawalAcknowledgementViaMerchantMailer(WID, deps),
  ]);
  assert.equal(p.sent.length, 1);
  const results = [a, b].map((o) => (o.attempted ? "attempted" : o.reason)).sort();
  assert.deepEqual(results, ["already_claimed_elsewhere", "attempted"]);
});

test("P2-2 : reportedAcknowledgementStatus — « unconfirmed » seulement pour un succès SMTP non persisté ; sinon inchangé", () => {
  assert.equal(reportedAcknowledgementStatus("pending", { attempted: true, ok: true, messageId: "m", resultPersisted: false } as never), "unconfirmed");
  assert.equal(reportedAcknowledgementStatus("pending", { attempted: true, ok: true, messageId: "m", resultPersisted: true } as never), "sent");
  assert.equal(reportedAcknowledgementStatus("pending", { attempted: true, ok: true, messageId: "m" }), "sent");
  assert.equal(reportedAcknowledgementStatus("pending", { attempted: true, ok: false, error: "X", resultPersisted: false } as never), "failed");
  assert.equal(reportedAcknowledgementStatus("pending", null), "pending");
});

test("P2-2 : l'adaptateur RPC PROPAGE l'erreur réelle de la finalisation (jamais avalée) et distingue false de l'erreur", async () => {
  const input = { withdrawalRequestId: WID, ok: true, to: "t", cc: "c", messageId: "m", contentVersion: "v", error: null, sender: "s" };
  const mk = (r: unknown) => createMerchantAckDependencies({ client: { rpc: async () => r } as never });
  assert.equal(await mk({ data: true, error: null }).recordResult(input), true);
  assert.equal(await mk({ data: false, error: null }).recordResult(input), false);
  await assert.rejects(() => mk({ data: null, error: { message: "permission denied" } }).recordResult(input), /permission denied|RPC/);
  await assert.rejects(() => createMerchantAckDependencies({ client: { rpc: async () => { throw new Error("network"); } } as never }).recordResult(input));
});

// --------------------------------------------------------------------
// P2-3 — rollback : empreintes liées au lot, vérifications AVANT toute mutation (structurel ;
// le comportement réel est démontré par supabase/tests/withdrawal-ack-merchant-mailer-v1-check.sh)
// --------------------------------------------------------------------
const { readFileSync } = await import("node:fs");
const { createHash } = await import("node:crypto");
const readRepo = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const LOT = "supabase/DRAFT-lot-withdrawal-ack-merchant-mailer-v1.sql";
const ROLLBACK = "supabase/DRAFT-lot-withdrawal-ack-merchant-mailer-v1-ROLLBACK.sql";
const sha256LF = (body: string) => createHash("sha256").update(body.replace(/\r\n/g, "\n"), "utf8").digest("hex");

function lotFunctionBodies(sql: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /create function (public\.[a-z_0-9]+)\(([^)]*)\)(?:[\s\S]*?)as \$\$([\s\S]*?)\$\$;/g;
  for (let m = re.exec(sql); m; m = re.exec(sql)) out[m[1]] = m[3];
  return out;
}

test("P2-3/R2-2 : les empreintes SHA-256 du rollback sont celles des corps du lot, en LF comme en CRLF (copie Windows), normalisation STRICTE", () => {
  const rollback = readRepo(ROLLBACK);
  const lot = readRepo(LOT);
  const bodies = lotFunctionBodies(lot);
  assert.deepEqual(Object.keys(bodies).sort(), [
    "public._scanym_ack_pending_when_merchant_mailer_ready",
    "public._scanym_merchant_ack_channel_ready",
    "public.claim_withdrawal_acknowledgement_send_v2",
    "public.record_withdrawal_acknowledgement_result_v2",
    "public.scanym_ack_merchant_mailer_enabled",
  ]);
  const crlfBodies = lotFunctionBodies(lot.replace(/\r?\n/g, "\r\n"));
  for (const [name, body] of Object.entries(bodies)) {
    const digest = sha256LF(body);
    assert.ok(rollback.includes(`'${digest}'`), `empreinte de ${name} (${digest}) absente du rollback : recalculer après toute modification du lot`);
    assert.equal(sha256LF(crlfBodies[name]), digest, `${name} : la normalisation CRLF -> LF donne la même empreinte`);
    assert.notEqual(createHash("sha256").update(crlfBodies[name], "utf8").digest("hex"), digest, "sans normalisation, CRLF donnerait une autre empreinte (le test est réel)");
    // R2-2 : normalisation STRICTE -- un CR isolé n'est PAS une fin de ligne et change l'empreinte.
    assert.notEqual(sha256LF(body.replace(/\n/, " \r")), digest, `${name} : un CR isolé doit changer l'empreinte`);
  }
});

test("P2-3 : rollback — verrou puis TOUS les contrôles avant la première mutation, aucun « IF EXISTS » sur les suppressions", () => {
  const sql = readRepo(ROLLBACK).replace(/--.*$/gm, "");
  const lockAt = sql.search(/lock table public\.withdrawal_requests in access exclusive mode/i);
  const lastCheck = sql.lastIndexOf("SCANYM_ROLLBACK_REFUSED");
  const firstDrop = sql.search(/\bdrop (trigger|function|table)\b|\balter table public\.withdrawal_requests drop\b/i);
  assert.ok(lockAt >= 0 && lockAt < sql.search(/\bdo \$\$/i), "verrou posé avant le bloc de contrôles");
  assert.ok(firstDrop > lastCheck, "la première mutation vient après le dernier contrôle de refus");
  assert.equal(/drop (trigger|function|table|column|constraint) if exists/i.test(sql), false, "pas de IF EXISTS : un objet manquant annule la transaction");
  for (const needle of [
    "pg_get_function_identity_arguments", "pg_get_function_result", "prosecdef", "proconfig", "proowner", "proacl",
    "aclexplode", "sha256", "replace(v_p.prosrc, E'\\r\\n', E'\\n')", "pg_depend", "tgtype", "tgenabled", "relrowsecurity",
    "_ackmm_rb_snapshot", "procost", "prorows", "prosupport", "prosqlbody", "attacl", "stxkeys", "tgattr", "pg_inherits", "~*",
    "SCANYM_ROLLBACK_DATA_LOSS", "SCANYM_ROLLBACK_NOT_APPLICABLE", "pending', 'sending",
  ]) {
    assert.ok(sql.includes(needle), `contrôle attendu dans le rollback : ${needle}`);
  }
});

test("R2-1/R2-2 : le rollback n'utilise plus MD5, exclut NOTRE contrainte par OID, et contrôle les objets tiers avant ET après", () => {
  const raw = readRepo(ROLLBACK);
  const sql = raw.replace(/--.*$/gm, "");
  assert.equal(/\bmd5\b/i.test(sql), false, "plus d'empreinte MD5 (collisions)");
  assert.equal(/replace\(v_p\.prosrc, E'\\r'/.test(sql), false, "plus de suppression de TOUS les CR");
  assert.match(sql, /d\.objid = v_cons/, "la seule dépendance tolérée est NOTRE contrainte, identifiée par son OID");
  assert.equal(/classid <> 'pg_catalog\.pg_constraint'::regclass/.test(sql), false, "plus d'exclusion de TOUTES les contraintes du scan des dépendances");
  const firstDrop = sql.search(/\bdrop (trigger|function|table)\b/i);
  assert.ok(sql.indexOf("insert into _ackmm_rb_snapshot") > 0 && sql.indexOf("insert into _ackmm_rb_snapshot") < firstDrop, "inventaire des objets tiers AVANT la première suppression");
  assert.ok(sql.lastIndexOf("_ackmm_rb_snapshot") > firstDrop, "inventaire relu APRÈS les suppressions (annulation si un objet tiers a disparu)");
  assert.match(sql, /lock table public\.scanym_ack_merchant_mailer_activation in access exclusive mode/i);
});

test("R3 : le rollback refuse les fonctions tierces à corps texte qui lisent une colonne de preuve (sans dépendance enregistrée)", () => {
  const sql = readRepo(ROLLBACK).replace(/--.*$/gm, "");
  const scan = sql.indexOf("acknowledgement_sender|acknowledgement_transport");
  assert.ok(scan > 0, "recherche du nom des colonnes de preuve dans pg_proc.prosrc");
  assert.match(sql.slice(scan - 400, scan + 100), /prosrc ~\*/, "insensible à la casse");
  assert.ok(scan < sql.search(/\bdrop (trigger|function|table)\b/i), "avant la première mutation");
  assert.match(sql, /p\.oid <> all \(v_fn_oids\)/, "les fonctions du lot sont exclues");
});

test("R3 : le harnais SQL ne peut plus produire un faux « aucune mutation » (empreinte en erreur = échec, contrôles négatifs)", () => {
  const h = readRepo("supabase/tests/withdrawal-ack-merchant-mailer-v1-check.sh");
  assert.match(h, /\^\[0-9a-f\]\{64\}\$/, "l'empreinte doit être 64 caractères hexadécimaux");
  assert.match(h, /FP_ERROR/);
  assert.match(h, /fp_error/);
  assert.match(h, /tgenabled::text/, "le « char » est converti en text (l'ancienne empreinte levait « operator is not unique »)");
  assert.match(h, /contrôle négatif : une mutation persistée malgré le refus est DÉTECTÉE/);
  assert.match(h, /mutation persistée \+ empreinte en ERREUR -> fp_error/);
  assert.equal(/before=\$\(fp "\$cp"\)\n\s*psql/.test(h), false);
});

test("P2-2/P2-3 : le lot ne reprend plus un `sending` (aucun paramètre de péremption) et lie l'enregistrement au canal marchand", () => {
  const lot = readRepo(LOT).replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
  const claim = lot.slice(lot.indexOf("create function public.claim_withdrawal_acknowledgement_send_v2"), lot.indexOf("create function public.record_withdrawal_acknowledgement_result_v2"));
  assert.equal(/p_stale_after_seconds|make_interval|wr\.acknowledgement_status = 'sending'/.test(claim), false, "aucune reprise de sending");
  assert.match(claim, /wr\.acknowledgement_status = 'pending'/);
  const record = lot.slice(lot.indexOf("create function public.record_withdrawal_acknowledgement_result_v2"));
  assert.match(record, /wr\.acknowledgement_status = 'sending'/);
  assert.match(record, /wr\.acknowledgement_transport = 'merchant_smtp'/);
});

test("P2-2 : l'adaptateur ne contient plus de catch qui avale l'erreur de finalisation", () => {
  const src = readRepo("lib/server/withdrawal-ack-service.ts");
  const adapter = src.slice(src.indexOf("export function createMerchantAckDependencies"), src.indexOf("export interface AckDispatchWiring"));
  assert.equal(/catch\s*\{\s*return false/.test(adapter), false);
  assert.match(adapter, /RECORD_RPC_FAILED/);
});
