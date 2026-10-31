import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

// ====================================================================
// MERCHANT SMTP v1 R1 (audit PR #196) -- TRANSPORT SMTP.
// Prouve, sans réseau ni mock de module (couture `createSmtpTransport(io, limits)`) :
//  - le filtre SSRF (adresses publiques IPv4 uniquement, socket épinglé sur l'IP validée) ;
//  - la classification par ÉTAPE du dialogue (A196-04) ;
//  - les bornes de temps par étape ET pour toute la session (A196-05) ;
//  - qu'aucun secret n'apparaît dans un résultat d'échec ;
//  - qu'une session dépassée ne poursuit jamais le dialogue en arrière-plan.
// ====================================================================

const { createSmtpTransport, isPublicIpv4Address } = await import("../lib/server/ack-mailer.ts");

const PASSWORD = "MOT-DE-PASSE-SYNTHETIQUE-Zq7!";
const CONFIG = { host: "smtp.merchant.example", port: 465, user: "contact@merchant.example", password: PASSWORD, from: "contact@merchant.example" };
const MESSAGE = {
  config: CONFIG, to: "client@example.com", cc: null, fromName: "Au Lait Cru",
  subject: "Commande reçue", text: "Suivi", html: "<p>Suivi</p>", messageId: "<k1@mail.scanym.com>",
};
const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

interface ServerScript {
  greeting?: string | null;
  ehlo?: string | null;
  auth?: string | null;
  authUser?: string | null;
  authPass?: string | null;
  mailFrom?: string | null;
  rcpt?: string | null;
  data?: string | null;
  dataEnd?: string | null;
  /** Délai avant chaque réponse du serveur. */
  delayMs?: number;
  /** R2 : découpe de chaque réponse (octets sur le fil, CRLF compris) en fragments livrés l'un après l'autre. */
  chunker?: (wire: string) => Array<string | Buffer>;
}

class FakeSocket extends EventEmitter {
  readonly written: string[] = [];
  destroyed = false;
  private authStep = 0;
  private readonly script: ServerScript;
  constructor(script: ServerScript) { super(); this.script = script; }
  setTimeout() { return this; }
  destroy() { this.destroyed = true; return this; }
  write(chunk: string): boolean {
    if (this.destroyed) return false;
    this.written.push(chunk);
    const cmd = chunk.split("\r\n")[0] ?? "";
    let reply: string | null | undefined;
    if (this.authStep === 1) { reply = this.script.authUser ?? "334 UGFzc3dvcmQ6"; this.authStep = 2; }
    else if (this.authStep === 2) { reply = this.script.authPass ?? "235 2.7.0 Authentication successful"; this.authStep = 0; }
    else if (cmd.startsWith("EHLO")) reply = this.script.ehlo ?? "250 smtp.merchant.example";
    else if (cmd === "AUTH LOGIN") { reply = this.script.auth ?? "334 VXNlcm5hbWU6"; this.authStep = 1; }
    else if (cmd.startsWith("MAIL FROM")) reply = this.script.mailFrom ?? "250 2.1.0 Ok";
    else if (cmd.startsWith("RCPT TO")) reply = this.script.rcpt ?? "250 2.1.5 Ok";
    else if (cmd === "DATA") reply = this.script.data ?? "354 End data with <CR><LF>.<CR><LF>";
    else if (chunk.endsWith("\r\n.\r\n")) reply = this.script.dataEnd ?? "250 2.0.0 Ok: queued as ABC123";
    else return true; // QUIT, etc. : pas de réponse
    if (reply !== null && reply !== undefined) this.reply(reply);
    return true;
  }
  reply(line: string) {
    const wire = `${line}\r\n`;
    const pieces = this.script.chunker ? this.script.chunker(wire) : [wire];
    const base = this.script.delayMs ?? 0;
    pieces.forEach((piece, index) => {
      setTimeout(() => { if (!this.destroyed) this.emit("data", Buffer.from(piece)); }, base + index);
    });
  }
}

type ConnectBehaviour = "ok" | { error: { message: string; code?: string } } | "timeout" | { delayConnectMs: number };

function harness(opts: {
  script?: ServerScript;
  addresses?: Array<{ address: string; family: number }> | { error: { code: string } };
  lookupDelayMs?: number;
  connect?: ConnectBehaviour;
} = {}) {
  const sockets: FakeSocket[] = [];
  const connectCalls: Array<{ host: string; servername: string; port: number; timeout: number }> = [];
  let lookups = 0;
  const io = {
    async lookup() {
      lookups += 1;
      if (opts.lookupDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.lookupDelayMs));
      const answer = opts.addresses ?? [{ address: "93.184.216.34", family: 4 }];
      if (!Array.isArray(answer)) throw Object.assign(new Error("getaddrinfo failed"), { code: answer.error.code });
      return answer;
    },
    connect(options: { host: string; servername: string; port: number; timeout: number }, onConnect: () => void) {
      connectCalls.push(options);
      const socket = new FakeSocket(opts.script ?? {});
      sockets.push(socket);
      const behaviour = opts.connect ?? "ok";
      setImmediate(() => {
        if (behaviour === "ok") {
          onConnect();
          const greeting = opts.script?.greeting === undefined ? "220 smtp.merchant.example ESMTP" : opts.script.greeting;
          if (greeting !== null) socket.reply(greeting);
        } else if (behaviour === "timeout") {
          socket.emit("timeout");
        } else if ("error" in behaviour) {
          socket.emit("error", Object.assign(new Error(behaviour.error.message), { code: behaviour.error.code }));
        } else {
          setTimeout(() => { onConnect(); socket.reply("220 late"); }, behaviour.delayConnectMs);
        }
      });
      return socket as unknown as import("node:tls").TLSSocket;
    },
  };
  return { io, sockets, connectCalls, lookups: () => lookups };
}

const FAST = { stepTimeoutMs: 400, totalTimeoutMs: 2_000 };

// --------------------------------------------------------------------
// Filtre SSRF
// --------------------------------------------------------------------
const BLOCKED = ["0.0.0.0", "10.1.1.1", "127.0.0.1", "100.64.0.1", "100.127.255.255", "169.254.169.254", "172.16.0.1", "172.31.255.255",
  "192.0.0.1", "192.0.2.1"/* documentation : non filtré historiquement */, "192.168.1.1", "192.88.99.1", "198.18.0.1", "198.19.255.255",
  "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "255.255.255.255"];
const ALLOWED = ["8.8.8.8", "93.184.216.34", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "169.253.0.1", "198.17.0.1", "198.20.0.1"];

test("isPublicIpv4Address : plages privées, boucle, lien local, CGNAT, test, multicast refusées ; voisines publiques acceptées", () => {
  // 192.0.2.0/24 (TEST-NET-1) et 192.0.0.0/24 : la fonction refuse 192.0.x.x en bloc.
  for (const ip of BLOCKED) assert.equal(isPublicIpv4Address(ip), false, ip);
  for (const ip of ALLOWED) assert.equal(isPublicIpv4Address(ip), true, ip);
  for (const bad of ["", "1.2.3", "1.2.3.4.5", "256.1.1.1", "-1.2.3.4", "a.b.c.d", "1.2.3.04x", "::1"]) assert.equal(isPublicIpv4Address(bad), false, bad);
});

test("SSRF : adresse non publique => refus AVANT toute connexion ; aucune connexion ouverte", async () => {
  for (const ip of BLOCKED) {
    const h = harness({ addresses: [{ address: ip, family: 4 }] });
    const result = await createSmtpTransport(h.io, FAST).checkConnectivity(CONFIG);
    assert.equal(result.ok, false, ip);
    if (!result.ok) { assert.equal(result.error, "SMTP_HOST_NOT_PUBLIC", ip); assert.equal(result.stage, "host_not_public", ip); }
    assert.equal(h.connectCalls.length, 0, `connexion ouverte vers ${ip}`);
  }
});

test("SSRF : socket ÉPINGLÉ sur l'IP publique validée, SNI = nom d'hôte marchand, port 465", async () => {
  for (const ip of ALLOWED) {
    const h = harness({ addresses: [{ address: ip, family: 4 }] });
    assert.deepEqual(await createSmtpTransport(h.io, FAST).checkConnectivity(CONFIG), { ok: true });
    assert.equal(h.connectCalls.length, 1);
    assert.equal(h.connectCalls[0]!.host, ip);
    assert.equal(h.connectCalls[0]!.servername, CONFIG.host);
    assert.equal(h.connectCalls[0]!.port, 465);
    assert.equal(h.connectCalls[0]!.timeout, FAST.stepTimeoutMs);
  }
});

test("SSRF : réponse DNS mixte => seule l'IP publique est utilisée ; IPv6 seul ou vide => refus", async () => {
  const mixed = harness({ addresses: [{ address: "10.0.0.5", family: 4 }, { address: "8.8.4.4", family: 4 }] });
  await createSmtpTransport(mixed.io, FAST).checkConnectivity(CONFIG);
  assert.equal(mixed.connectCalls[0]!.host, "8.8.4.4");
  for (const answer of [[{ address: "::1", family: 6 }], [{ address: "2606:4700::1111", family: 6 }], []]) {
    const h = harness({ addresses: answer });
    const result = await createSmtpTransport(h.io, FAST).checkConnectivity(CONFIG);
    assert.equal(result.ok, false);
    assert.equal(h.connectCalls.length, 0);
  }
});

// --------------------------------------------------------------------
// Dialogue nominal
// --------------------------------------------------------------------
test("envoi nominal : séquence SMTP attendue, identifiant de message du serveur, socket fermé", async () => {
  const h = harness();
  const result = await createSmtpTransport(h.io, FAST).send(MESSAGE);
  assert.deepEqual(result, { ok: true, messageId: "ABC123" });
  const sent = h.sockets[0]!.written.map((line) => line.split("\r\n")[0]);
  assert.deepEqual(sent.slice(0, 7), [
    "EHLO scanym.com", "AUTH LOGIN", b64(CONFIG.user), b64(PASSWORD),
    `MAIL FROM:<${CONFIG.from}>`, "RCPT TO:<client@example.com>", "DATA",
  ]);
  assert.equal(sent.at(-1), "QUIT");
  assert.equal(h.sockets[0]!.destroyed, true);
});

test("test de connexion : AUTH seulement -- ni MAIL FROM, ni RCPT TO, ni DATA", async () => {
  const h = harness();
  assert.deepEqual(await createSmtpTransport(h.io, FAST).checkConnectivity(CONFIG), { ok: true });
  const sent = h.sockets[0]!.written.map((line) => line.split("\r\n")[0]!);
  assert.equal(sent.some((line) => /^(MAIL FROM|RCPT TO|DATA)/.test(line)), false);
  assert.equal(h.sockets[0]!.destroyed, true);
});

// --------------------------------------------------------------------
// Classification par étape (A196-04)
// --------------------------------------------------------------------
const STAGE_CASES: Array<{ label: string; script: ServerScript; stage: string; status: number }> = [
  { label: "bannière refusée", script: { greeting: "554 5.3.2 service unavailable" }, stage: "greeting", status: 554 },
  { label: "EHLO refusé", script: { ehlo: "550 5.5.1 no" }, stage: "ehlo", status: 550 },
  { label: "AUTH LOGIN non supporté", script: { auth: "504 5.5.4 mechanism unavailable" }, stage: "auth", status: 504 },
  { label: "identifiant refusé", script: { authUser: "535 5.7.8 bad user" }, stage: "auth", status: 535 },
  { label: "mot de passe refusé (permanent)", script: { authPass: "535 5.7.8 Authentication credentials invalid" }, stage: "auth", status: 535 },
  { label: "authentification temporairement indisponible", script: { authPass: "454 4.7.0 Temporary authentication failure" }, stage: "auth", status: 454 },
  { label: "MAIL FROM refusé", script: { mailFrom: "553 5.7.1 sender not owned" }, stage: "mail_from", status: 553 },
  { label: "destinataire inconnu", script: { rcpt: "550 5.1.1 user unknown" }, stage: "rcpt_to", status: 550 },
  { label: "DATA refusé", script: { data: "554 5.5.1 no" }, stage: "data", status: 554 },
  { label: "contenu rejeté", script: { dataEnd: "554 5.7.1 spam" }, stage: "data_end", status: 554 },
];

for (const c of STAGE_CASES) {
  test(`échec typé : ${c.label} => étape ${c.stage}, statut ${c.status}, aucun secret dans le résultat`, async () => {
    const h = harness({ script: c.script });
    const result = await createSmtpTransport(h.io, FAST).send(MESSAGE);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.stage, c.stage);
    assert.equal(result.status, c.status);
    const serialised = JSON.stringify(result);
    assert.equal(serialised.includes(PASSWORD), false, "mot de passe en clair");
    assert.equal(serialised.includes(b64(PASSWORD)), false, "mot de passe encodé");
    assert.equal(h.sockets[0]!.destroyed, true, "socket fermé");
  });
}

test("échecs avant dialogue : DNS (code Node conservé), connexion refusée, certificat TLS invalide", async () => {
  const dns = harness({ addresses: { error: { code: "ENOTFOUND" } } });
  const r1 = await createSmtpTransport(dns.io, FAST).checkConnectivity(CONFIG);
  assert.deepEqual(r1.ok ? null : [r1.stage, r1.nodeCode], ["dns", "ENOTFOUND"]);
  assert.equal(dns.connectCalls.length, 0);

  const refused = harness({ connect: { error: { message: "connect ECONNREFUSED", code: "ECONNREFUSED" } } });
  const r2 = await createSmtpTransport(refused.io, FAST).checkConnectivity(CONFIG);
  assert.deepEqual(r2.ok ? null : [r2.stage, r2.nodeCode], ["connect", "ECONNREFUSED"]);

  const tls = harness({ connect: { error: { message: "Hostname/IP does not match certificate's altnames", code: "ERR_TLS_CERT_ALTNAME_INVALID" } } });
  const r3 = await createSmtpTransport(tls.io, FAST).checkConnectivity(CONFIG);
  assert.deepEqual(r3.ok ? null : [r3.stage, r3.nodeCode], ["connect", "ERR_TLS_CERT_ALTNAME_INVALID"]);
});

test("injection d'en-tête (nom d'expéditeur) : étape header, rien n'est envoyé au serveur", async () => {
  const h = harness();
  const result = await createSmtpTransport(h.io, FAST).send({ ...MESSAGE, fromName: "Resto\r\nBcc: attaquant@example.com" });
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.stage, "header"); assert.equal(result.error, "SMTP_INVALID_FROM-NAME_HEADER"); }
  const sentData = h.sockets[0]!.written.some((chunk) => chunk.includes("Bcc: attaquant"));
  assert.equal(sentData, false);
});

// --------------------------------------------------------------------
// Bornes de temps (A196-05)
// --------------------------------------------------------------------
test("délai d'une étape : serveur muet => étape timeout, socket fermé", async () => {
  const h = harness({ script: { greeting: null } });
  const result = await createSmtpTransport(h.io, { stepTimeoutMs: 40, totalTimeoutMs: 2_000 }).checkConnectivity(CONFIG);
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.stage, "timeout"); assert.equal(result.error, "SMTP_TIMEOUT"); }
  assert.equal(h.sockets[0]!.destroyed, true);
});

test("délai de connexion : événement timeout du socket => étape timeout", async () => {
  const h = harness({ connect: "timeout" });
  const result = await createSmtpTransport(h.io, FAST).checkConnectivity(CONFIG);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.stage, "timeout");
  assert.equal(h.sockets[0]!.destroyed, true);
});

test("délai GLOBAL : un serveur qui répond lentement à chaque étape est coupé à la borne de session", async () => {
  // Chaque réponse prend 60 ms (< délai d'étape 400 ms) ; la session totale (>= 12 étapes) dépasse 200 ms.
  const h = harness({ script: { delayMs: 60 } });
  const started = Date.now();
  const result = await createSmtpTransport(h.io, { stepTimeoutMs: 400, totalTimeoutMs: 200 }).send(MESSAGE);
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.stage, "timeout"); assert.equal(result.error, "SMTP_SESSION_TIMEOUT"); }
  assert.ok(elapsed < 380, `session non bornée : ${elapsed} ms`);
  assert.equal(h.sockets[0]!.destroyed, true);
  // Aucun message ne doit avoir été transmis (DATA jamais atteint dans la borne).
  assert.equal(h.sockets[0]!.written.some((chunk) => chunk.includes("Subject:")), false);
});

test("délai global pendant la résolution DNS : la connexion n'est JAMAIS ouverte ensuite", async () => {
  const h = harness({ lookupDelayMs: 120 });
  const result = await createSmtpTransport(h.io, { stepTimeoutMs: 400, totalTimeoutMs: 40 }).send(MESSAGE);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "SMTP_SESSION_TIMEOUT");
  await new Promise((resolve) => setTimeout(resolve, 200)); // laisse la résolution tardive se terminer
  assert.equal(h.lookups(), 1);
  assert.equal(h.connectCalls.length, 0, "connexion ouverte après l'expiration de la session");
});

test("délai global pendant la connexion : le socket tardif est détruit et AUCUNE commande n'est écrite", async () => {
  const h = harness({ connect: { delayConnectMs: 120 } });
  const result = await createSmtpTransport(h.io, { stepTimeoutMs: 400, totalTimeoutMs: 40 }).send(MESSAGE);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "SMTP_SESSION_TIMEOUT");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const socket = h.sockets[0]!;
  assert.equal(socket.destroyed, true);
  assert.deepEqual(socket.written.filter((chunk) => !chunk.startsWith("QUIT")), [], "dialogue poursuivi en arrière-plan");
});

// --------------------------------------------------------------------
// R2 (contre-audit de 7cb60a8, défaut 1) : réponses SMTP reçues en plusieurs morceaux.
// TCP/TLS ne garantit AUCUN découpage : une réponse peut arriver en fragments, y compris
// au milieu d'une ligne, d'un code ou d'un caractère UTF-8. Une réponse n'est complète
// qu'à sa dernière ligne COMPLÈTE (terminée par CRLF) et le reste du tampon appartient à
// la réponse SUIVANTE.
// --------------------------------------------------------------------
const BYTE_BY_BYTE = (wire: string) => Array.from(Buffer.from(wire, "utf8")).map((byte) => Buffer.from([byte]));
const IN_HALF = (wire: string) => [wire.slice(0, Math.ceil(wire.length / 2)), wire.slice(Math.ceil(wire.length / 2))];
const BEFORE_CRLF = (wire: string) => [wire.slice(0, -2), wire.slice(-2)];
const CODE_THEN_REST = (wire: string) => [wire.slice(0, 3), wire.slice(3)];

for (const [label, chunker] of [
  ["au milieu de chaque réponse", IN_HALF],
  ["juste avant le CRLF final", BEFORE_CRLF],
  ["entre le code et le texte", CODE_THEN_REST],
  ["octet par octet", BYTE_BY_BYTE],
] as const) {
  test(`R2 réponses fragmentées (${label}) : l'envoi complet réussit et l'identifiant du serveur est lu`, async () => {
    const h = harness({ script: { chunker } });
    const result = await createSmtpTransport(h.io, FAST).send(MESSAGE);
    assert.deepEqual(result, { ok: true, messageId: "ABC123" });
    const sent = h.sockets[0]!.written.map((line) => line.split("\r\n")[0]);
    assert.deepEqual(sent.slice(0, 7), [
      "EHLO scanym.com", "AUTH LOGIN", b64(CONFIG.user), b64(PASSWORD),
      `MAIL FROM:<${CONFIG.from}>`, "RCPT TO:<client@example.com>", "DATA",
    ]);
  });

  test(`R2 réponses fragmentées (${label}) : le test de connexion réussit`, async () => {
    const h = harness({ script: { chunker } });
    assert.deepEqual(await createSmtpTransport(h.io, FAST).checkConnectivity(CONFIG), { ok: true });
  });
}

test("R2 réponse EHLO multi-ligne fragmentée à l'intérieur d'une ligne de continuation : réussite", async () => {
  const ehlo = "250-smtp.merchant.example\r\n250-SIZE 35882577\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME";
  for (const chunker of [IN_HALF, BYTE_BY_BYTE, (wire: string) => [wire.slice(0, 30), wire.slice(30, 41), wire.slice(41)]]) {
    const h = harness({ script: { ehlo, chunker } });
    assert.deepEqual(await createSmtpTransport(h.io, FAST).checkConnectivity(CONFIG), { ok: true });
  }
});

test("R2 refus fragmenté : le code et l'étape restent exacts (535 à l'AUTH, 550 au RCPT)", async () => {
  const h1 = harness({ script: { authPass: "535 5.7.8 Authentication credentials invalid", chunker: BYTE_BY_BYTE } });
  const r1 = await createSmtpTransport(h1.io, FAST).send(MESSAGE);
  assert.deepEqual(r1.ok ? null : [r1.stage, r1.status], ["auth", 535]);
  const h2 = harness({ script: { rcpt: "550 5.1.1 user unknown", chunker: IN_HALF } });
  const r2 = await createSmtpTransport(h2.io, FAST).send(MESSAGE);
  assert.deepEqual(r2.ok ? null : [r2.stage, r2.status], ["rcpt_to", 550]);
});

test("R2 caractère UTF-8 multi-octets coupé entre deux fragments : la réponse reste lisible", async () => {
  const h = harness({ script: { dataEnd: "250 2.0.0 Ok: queued as ÉTÉ-123 ✓", chunker: BYTE_BY_BYTE } });
  const result = await createSmtpTransport(h.io, FAST).send(MESSAGE);
  assert.deepEqual(result, { ok: true, messageId: "ÉTÉ-123" });
});

test("R2 connexion fermée par le serveur au milieu d'une réponse : échec IMMÉDIAT (pas d'attente du délai d'étape), étape connect", async () => {
  const h = harness({ script: { greeting: null } });
  const transport = createSmtpTransport(h.io, { stepTimeoutMs: 1_500, totalTimeoutMs: 3_000 });
  const started = Date.now();
  const pending = transport.checkConnectivity(CONFIG);
  setTimeout(() => { h.sockets[0]!.emit("data", Buffer.from("220 smtp.mer")); h.sockets[0]!.emit("close"); }, 20);
  const result = await pending;
  assert.ok(Date.now() - started < 600, "attente du délai d'étape au lieu d'échouer à la fermeture");
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.stage, "connect"); assert.equal(result.nodeCode, "ECONNRESET"); }
  assert.equal(h.sockets[0]!.destroyed, true);
});

test("R2 réponse démesurée (serveur hostile qui diffuse sans fin) : coupée à la borne, sans mémoire non bornée", async () => {
  const h = harness({ script: { greeting: null } });
  const transport = createSmtpTransport(h.io, { stepTimeoutMs: 1_500, totalTimeoutMs: 3_000 });
  const pending = transport.checkConnectivity(CONFIG);
  setTimeout(() => {
    const flood = Buffer.alloc(70 * 1024, "a"); // aucune fin de ligne
    h.sockets[0]!.emit("data", flood);
  }, 20);
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.error, "SMTP_REPLY_TOO_LARGE"); assert.equal(result.stage, "greeting"); }
  assert.equal(h.sockets[0]!.destroyed, true);
});

test("R2 réponse lue une seule fois : un fragment tardif de la réponse précédente ne pollue pas la suivante", async () => {
  // Le serveur envoie "250 2.1.0 Ok" en deux fragments très espacés : la réponse n'est complète qu'au CRLF.
  const h = harness({ script: { mailFrom: "250 2.1.0 Ok", chunker: (wire: string) => (wire.startsWith("250 2.1.0") ? [wire.slice(0, 9), wire.slice(9)] : [wire]) } });
  const result = await createSmtpTransport(h.io, FAST).send(MESSAGE);
  assert.deepEqual(result, { ok: true, messageId: "ABC123" });
});
