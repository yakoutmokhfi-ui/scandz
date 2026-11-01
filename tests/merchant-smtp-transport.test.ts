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
  /** R5 : la bannière est déjà dans le tampon du lecteur quand le client appelle `read("greeting")` (livrée dans le même tour que la connexion). */
  greetingBeforeRead?: boolean;
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
    // R5 : livraison STRICTEMENT ordonnée. Avant, chaque fragment avait sa propre minuterie `setTimeout(base + index)` ;
    // sous charge (machine saturée, Windows) deux minuteries expirées ensemble pouvaient se déclencher dans le désordre,
    // le lecteur recevait alors des morceaux de réponse permutés (≈ 10 exécutions sur 25 en échec sous charge CPU) -- un
    // artefact du harnais, jamais un comportement du serveur. Chaque fragment n'est maintenant planifié qu'APRÈS la
    // livraison du précédent : l'ordre est vrai par construction, quelle que soit la vitesse de la machine.
    let index = 0;
    const deliver = () => {
      if (this.destroyed) return;
      this.emit("data", Buffer.from(pieces[index]!));
      index += 1;
      if (index < pieces.length) setImmediate(deliver);
    };
    setTimeout(deliver, base);
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
          if (greeting !== null) {
            if (opts.script?.greetingBeforeRead) socket.emit("data", Buffer.from(`${greeting}\r\n`));
            else socket.reply(greeting);
          }
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

// --------------------------------------------------------------------
// R3-04 (contre-audit de 9e38c88, P2) : « Faux succès SMTP, sans réception du corps du message ».
// Le tampon persistant de R2 gardait ce qui suivait une réponse « pour la lecture suivante » : un serveur
// qui répond AVANT d'avoir reçu la commande (« 354 … » + « 250 … queued as X » dans le même paquet) voyait
// son 250 lu comme la réponse au CORPS, avant même que le corps ait été écrit. Le dialogue est synchrone :
// tout octet non sollicité est une violation de protocole, détectée avant l'écriture suivante.
// --------------------------------------------------------------------
const bodyWritten = (written: string[]) => written.some((chunk) => chunk.includes("Content-Type: multipart/alternative") || chunk.endsWith("\r\n.\r\n"));
const commandsSeen = (written: string[]) => written.map((chunk) => chunk.split("\r\n")[0]!).filter((line) => !line.startsWith("QUIT"));

test("R3-04 REPRO : « 354 » + « 250 queued » dans le même paquet, serveur qui n'attend pas le corps => ÉCHEC (SMTP_UNSOLICITED_RESPONSE), corps JAMAIS écrit", async () => {
  const h = harness({ script: { data: "354 go ahead\r\n250 2.0.0 Ok: queued as FAUX-SUCCES", dataEnd: null } });
  const result = await createSmtpTransport(h.io, FAST).send(MESSAGE);
  assert.equal(result.ok, false, JSON.stringify(result));
  if (!result.ok) {
    assert.equal(result.error, "SMTP_UNSOLICITED_RESPONSE");
    assert.equal(result.stage, "data_end");
    assert.equal(result.status ?? null, null);
  }
  assert.equal(bodyWritten(h.sockets[0]!.written), false, "le corps n'a pas été transmis à un serveur qui a déjà « acquitté »");
  assert.equal(h.sockets[0]!.destroyed, true);
});

test("R3-04 : la même réponse anticipée à CHAQUE étape est refusée avant l'écriture suivante (aucune commande n'est envoyée à un serveur désynchronisé)", async () => {
  const cases: Array<{ label: string; script: ServerScript; stage: string; lastCommandSent: string; notSent: RegExp }> = [
    { label: "bannière + réponse en trop", script: { greeting: "220 smtp.merchant.example ESMTP\r\n250 trop tôt" }, stage: "ehlo", lastCommandSent: "", notSent: /^EHLO/ },
    { label: "EHLO + réponse en trop", script: { ehlo: "250 smtp.merchant.example\r\n334 VXNlcm5hbWU6" }, stage: "auth", lastCommandSent: "EHLO scanym.com", notSent: /^AUTH LOGIN/ },
    { label: "AUTH LOGIN + 235 anticipé (authentification annoncée avant l'envoi des identifiants)", script: { auth: "334 VXNlcm5hbWU6\r\n235 2.7.0 Authentication successful" }, stage: "auth", lastCommandSent: "AUTH LOGIN", notSent: new RegExp(`^${b64(CONFIG.user)}`) },
    { label: "235 + réponse en trop", script: { authPass: "235 2.7.0 Authentication successful\r\n250 2.1.0 Ok" }, stage: "mail_from", lastCommandSent: b64(PASSWORD), notSent: /^MAIL FROM/ },
    { label: "MAIL FROM + 250 anticipé pour RCPT", script: { mailFrom: "250 2.1.0 Ok\r\n250 2.1.5 Ok" }, stage: "rcpt_to", lastCommandSent: `MAIL FROM:<${CONFIG.from}>`, notSent: /^RCPT TO/ },
    { label: "RCPT TO + 354 anticipé", script: { rcpt: "250 2.1.5 Ok\r\n354 go" }, stage: "data", lastCommandSent: "RCPT TO:<client@example.com>", notSent: /^DATA/ },
  ];
  for (const c of cases) {
    const h = harness({ script: c.script });
    const result = await createSmtpTransport(h.io, FAST).send(MESSAGE);
    assert.equal(result.ok, false, c.label);
    if (!result.ok) { assert.equal(result.error, "SMTP_UNSOLICITED_RESPONSE", c.label); assert.equal(result.stage, c.stage, c.label); }
    const sent = commandsSeen(h.sockets[0]!.written);
    assert.equal(sent.some((line) => c.notSent.test(line)), false, `${c.label} : commande suivante envoyée à un serveur désynchronisé (${sent.join(" | ")})`);
    if (c.lastCommandSent) assert.equal(sent.at(-1), c.lastCommandSent, c.label);
    assert.equal(bodyWritten(h.sockets[0]!.written), false, c.label);
  }
});

test("R3-04 : octets non sollicités INCOMPLETS (pas de fin de ligne) => refusés aussi ; sauts de ligne parasites seuls => toujours tolérés", async () => {
  const partial = harness({ script: { data: "354 go ahead\r\n250 2.0.0 Ok: que", dataEnd: null } });
  const refused = await createSmtpTransport(partial.io, FAST).send(MESSAGE);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error, "SMTP_UNSOLICITED_RESPONSE");
  assert.equal(bodyWritten(partial.sockets[0]!.written), false);

  const blank = harness({ script: { data: "354 go ahead\r\n\r\n" } });
  assert.deepEqual(await createSmtpTransport(blank.io, FAST).send(MESSAGE), { ok: true, messageId: "ABC123" }, "lignes vides parasites : ignorées comme avant");
});

test("R3-04 : une réponse finale qui ARRIVE APRÈS l'écriture du corps (même découpée, même tardive) reste acceptée -- aucune régression des réponses fragmentées", async () => {
  for (const chunker of [IN_HALF, BYTE_BY_BYTE, BEFORE_CRLF, CODE_THEN_REST]) {
    const h = harness({ script: { chunker, delayMs: 5 } });
    assert.deepEqual(await createSmtpTransport(h.io, FAST).send(MESSAGE), { ok: true, messageId: "ABC123" });
    assert.equal(bodyWritten(h.sockets[0]!.written), true);
  }
});

test("R3-04 : le test de connexion applique la même règle (235 annoncé avant les identifiants => échec, jamais « connexion réussie »)", async () => {
  const h = harness({ script: { auth: "334 VXNlcm5hbWU6\r\n235 2.7.0 Authentication successful" } });
  const result = await createSmtpTransport(h.io, FAST).checkConnectivity(CONFIG);
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.error, "SMTP_UNSOLICITED_RESPONSE"); assert.equal(result.stage, "auth"); }
  assert.equal(commandsSeen(h.sockets[0]!.written).some((line) => line === b64(CONFIG.user)), false, "identifiants non transmis");
});

test("R3-04 : la violation de protocole est classée « temporaire / réessayable » (rien n'a été écrit après elle), sans suspendre le fournisseur ni exposer de texte serveur", async () => {
  const { classifySmtpFailure } = await import("../lib/server/notifications/smtp-failure-classification.ts");
  const h = harness({ script: { data: "354 go ahead\r\n250 2.0.0 Ok: queued as FAUX-SUCCES", dataEnd: null } });
  const result = await createSmtpTransport(h.io, FAST).send(MESSAGE);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(classifySmtpFailure(result), { errorClass: "PROVIDER_TEMPORARY_UNAVAILABLE", retryable: true, disableProvider: false });
    assert.equal(JSON.stringify(result).includes("FAUX-SUCCES"), false, "le texte du serveur n'est pas repris");
    assert.equal(JSON.stringify(result).includes(PASSWORD), false);
  }
});

test("R3-04 : un seul chemin d'écriture dans le dialogue (exchange) -- aucune écriture directe sur le socket hors QUIT", async () => {
  const src = (await import("node:fs")).readFileSync("lib/server/ack-mailer.ts", "utf8");
  const writes = [...src.matchAll(/socket\.write\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(writes, ["payload", "`QUIT${CRLF}`"], "toute commande et le corps passent par exchange() ; seule la fin de session écrit QUIT");
  assert.equal((src.match(/assertNoUnsolicited\(/g) ?? []).length, 2, "définition + un seul appel, dans exchange()");
});

// ====================================================================
// R5 (contre-audit de 2431eba, Maxwell, A196-R2-SMTP-01 -- P2) : « une réponse multiligne invalide ou terminée
// par 550 ne doit pas être acceptée comme un succès ».
//
// Avant R5, `takeReply` clôturait une réponse dès qu'une ligne n'était pas de la forme « NNN- » (donc aussi une
// ligne vide ou du texte libre), et `expectCode` ne regardait que le préfixe de la PREMIÈRE ligne :
//   « 250-continue » + « NOT A STATUS LINE »      => lu comme un 250 valide ;
//   « 250-capability » + « 550 EHLO refused »      => lu comme un 250 (le refus final était ignoré) ;
//   « 250-capability » + ligne vide                => lu comme un 250 ;
// et le client poursuivait AUTH / MAIL / RCPT / DATA, jusqu'à « {ok:true} ».
// Grammaire appliquée (RFC 5321 §4.2) : chaque ligne = code [2-5][0-5][0-9], puis « - » (continuation) ou
// « SP texte » / rien (ligne finale) ; TOUTES les lignes portent le MÊME code ; la dernière est une ligne finale ;
// aucun caractère de contrôle (hors tabulation) dans le texte. Toute violation => SMTP_MALFORMED_RESPONSE
// (temporaire, jamais un succès, jamais un statut permanent déduit d'une réponse incohérente).
// ====================================================================
const MALFORMED = /^SMTP_MALFORMED_RESPONSE: (line_syntax|code_mismatch|control_character)$/;

test("R5 REPRO de Maxwell : les trois réponses EHLO multilignes invalides sont REFUSÉES avant AUTH (envoi ET test de connexion), le corps n'est jamais écrit", async () => {
  const cases: Array<{ label: string; ehlo: string; reason: string }> = [
    { label: "ligne qui n'est pas une ligne d'état après une continuation", ehlo: "250-continue\r\nNOT A STATUS LINE", reason: "line_syntax" },
    { label: "continuation « 250- » terminée par « 550 EHLO refused »", ehlo: "250-capability\r\n550 EHLO refused", reason: "code_mismatch" },
    { label: "ligne vide dans une continuation", ehlo: "250-capability\r\n", reason: "line_syntax" },
  ];
  for (const c of cases) {
    const sendH = harness({ script: { ehlo: c.ehlo } });
    const sent = await createSmtpTransport(sendH.io, FAST).send(MESSAGE);
    assert.equal(sent.ok, false, `${c.label} : accepté comme un succès (${JSON.stringify(sent)})`);
    if (!sent.ok) {
      assert.match(sent.error, MALFORMED, c.label);
      assert.equal(sent.error, `SMTP_MALFORMED_RESPONSE: ${c.reason}`, c.label);
      assert.equal(sent.stage, "ehlo", c.label);
      assert.equal(sent.status ?? null, null, `${c.label} : aucun statut déduit d'une réponse incohérente`);
    }
    assert.deepEqual(commandsSeen(sendH.sockets[0]!.written), ["EHLO scanym.com"], `${c.label} : le dialogue a continué après une réponse invalide`);
    assert.equal(bodyWritten(sendH.sockets[0]!.written), false, c.label);
    assert.equal(sendH.sockets[0]!.destroyed, true, c.label);

    const checkH = harness({ script: { ehlo: c.ehlo } });
    const checked = await createSmtpTransport(checkH.io, FAST).checkConnectivity(CONFIG);
    assert.equal(checked.ok, false, `${c.label} : « connexion réussie » sur une réponse invalide`);
    if (!checked.ok) { assert.equal(checked.error, `SMTP_MALFORMED_RESPONSE: ${c.reason}`, c.label); assert.equal(checked.stage, "ehlo", c.label); }
    assert.deepEqual(commandsSeen(checkH.sockets[0]!.written), ["EHLO scanym.com"], c.label);
  }
});

type StageCase = { key: keyof ServerScript; stage: string; code: string; refusal: string; notSent: (sent: string[]) => boolean; viaCheck: boolean };
const R5_STAGES: StageCase[] = [
  { key: "greeting", stage: "greeting", code: "220", refusal: "554", notSent: (s) => s.length === 0, viaCheck: true },
  { key: "ehlo", stage: "ehlo", code: "250", refusal: "550", notSent: (s) => !s.some((l) => l === "AUTH LOGIN"), viaCheck: true },
  { key: "auth", stage: "auth", code: "334", refusal: "504", notSent: (s) => !s.includes(b64(CONFIG.user)), viaCheck: true },
  { key: "authUser", stage: "auth", code: "334", refusal: "535", notSent: (s) => !s.includes(b64(PASSWORD)), viaCheck: true },
  { key: "authPass", stage: "auth", code: "235", refusal: "535", notSent: (s) => !s.some((l) => l.startsWith("MAIL FROM")), viaCheck: true },
  { key: "mailFrom", stage: "mail_from", code: "250", refusal: "550", notSent: (s) => !s.some((l) => l.startsWith("RCPT TO")), viaCheck: false },
  { key: "rcpt", stage: "rcpt_to", code: "250", refusal: "550", notSent: (s) => !s.some((l) => l === "DATA"), viaCheck: false },
  { key: "data", stage: "data", code: "354", refusal: "554", notSent: () => true, viaCheck: false },
  { key: "dataEnd", stage: "data_end", code: "250", refusal: "550", notSent: () => true, viaCheck: false },
];

test("R5 : à CHAQUE étape, une continuation suivie de texte libre, d'un refus ou d'une ligne vide est refusée -- jamais un succès d'étape, jamais la commande suivante", async () => {
  for (const s of R5_STAGES) {
    const bad: Array<[string, string]> = [
      ["texte libre", `${s.code}-x\r\nNOT A STATUS LINE`],
      [`terminée par ${s.refusal}`, `${s.code}-x\r\n${s.refusal} refused`],
      ["ligne vide", `${s.code}-x\r\n`],
    ];
    for (const [label, reply] of bad) {
      const h = harness({ script: { [s.key]: reply } as ServerScript });
      const result = await createSmtpTransport(h.io, FAST).send(MESSAGE);
      assert.equal(result.ok, false, `${s.key} / ${label} : accepté (${JSON.stringify(result)})`);
      if (!result.ok) { assert.match(result.error, MALFORMED, `${s.key} / ${label}`); assert.equal(result.stage, s.stage, `${s.key} / ${label}`); assert.equal(result.status ?? null, null, `${s.key} / ${label}`); }
      const sent = commandsSeen(h.sockets[0]!.written);
      assert.equal(s.notSent(sent), true, `${s.key} / ${label} : commande suivante envoyée après une réponse invalide (${sent.join(" | ")})`);
      if (s.key !== "dataEnd") assert.equal(bodyWritten(h.sockets[0]!.written), false, `${s.key} / ${label} : corps écrit`);
      assert.equal(h.sockets[0]!.destroyed, true, `${s.key} / ${label}`);
      if (s.viaCheck) {
        const hc = harness({ script: { [s.key]: reply } as ServerScript });
        const checked = await createSmtpTransport(hc.io, FAST).checkConnectivity(CONFIG);
        assert.equal(checked.ok, false, `${s.key} / ${label} : test de connexion réussi sur une réponse invalide`);
        if (!checked.ok) assert.match(checked.error, MALFORMED, `${s.key} / ${label}`);
      }
    }
  }
});

test("R5 grammaire : chaque variante invalide d'une réponse EHLO est refusée (jamais lue comme un 250), le dialogue s'arrête après EHLO", async () => {
  const invalid: Array<[string, string, string]> = [
    // [libellé, réponse EHLO, raison attendue]
    ["code collé au texte (finale)", "250-a\r\n250ok", "line_syntax"],
    ["lettre après le code (finale)", "250-a\r\n250x done", "line_syntax"],
    ["espace avant le code", "250-a\r\n 250 done", "line_syntax"],
    ["code à deux chiffres", "250-a\r\n25 done", "line_syntax"],
    ["code à quatre chiffres", "250-a\r\n2500 done", "line_syntax"],
    ["tabulation comme séparateur", "250-a\r\n250\tdone", "line_syntax"],
    ["autre code de succès en dernière ligne", "250-a\r\n251 done", "code_mismatch"],
    ["autre classe de code en dernière ligne", "250-a\r\n354 done", "code_mismatch"],
    ["continuation d'un autre code au milieu", "250-a\r\n251-b\r\n250 done", "code_mismatch"],
    ["texte libre au milieu, finale valide ensuite", "250-a\r\nNOT A STATUS LINE\r\n250 done", "line_syntax"],
    ["ligne vide au milieu, finale valide ensuite", "250-a\r\n\r\n250 done", "line_syntax"],
    ["CR isolé dans le texte", "250-a\r\n250 done\rextra", "control_character"],
    ["octet NUL dans le texte", "250-a\u0000b\r\n250 done", "control_character"],
    ["caractère de contrôle (ESC) dans une continuation", "250-a\u001bb\r\n250 done", "control_character"],
    ["caractère DEL (0x7F) dans le texte", "250-a\u007fb\r\n250 done", "control_character"],
    ["une ligne : caractère DEL (0x7F)", "250 a\u007fb", "control_character"],
    // réponses d'UNE seule ligne qui passaient la vérification de préfixe
    ["une ligne : code collé au texte", "250ok", "line_syntax"],
    ["une ligne : quatre chiffres", "2500 done", "line_syntax"],
    ["une ligne : tabulation", "250\tdone", "line_syntax"],
    ["une ligne : CR isolé", "250 done\rextra", "control_character"],
    ["une ligne : pas un code d'état", "NOT A STATUS LINE", "line_syntax"],
    ["une ligne : code hors grammaire (2e chiffre > 5)", "260 hors grammaire", "line_syntax"],
    ["une ligne : code hors grammaire (classe 6)", "650 hors grammaire", "line_syntax"],
  ];
  for (const [label, ehlo, reason] of invalid) {
    const h = harness({ script: { ehlo } });
    const result = await createSmtpTransport(h.io, FAST).send(MESSAGE);
    assert.equal(result.ok, false, `${label} : accepté (${JSON.stringify(result)})`);
    if (!result.ok) { assert.equal(result.error, `SMTP_MALFORMED_RESPONSE: ${reason}`, label); assert.equal(result.stage, "ehlo", label); }
    assert.deepEqual(commandsSeen(h.sockets[0]!.written), ["EHLO scanym.com"], `${label} : dialogue poursuivi`);
  }
});

test("R5 TÉMOINS : les réponses multilignes VALIDES sont acceptées, à chaque étape, sous tous les découpages (octet par octet, avant le CRLF, entre CR et LF...)", async () => {
  const splitCrLf = (wire: string) => wire.replaceAll("\r\n", "\r|\n").split("|");
  const multi: ServerScript = {
    greeting: "220-smtp.merchant.example ESMTP\r\n220 prêt",
    ehlo: "250-smtp.merchant.example\r\n250-SIZE 35882577\r\n250-AUTH LOGIN PLAIN\r\n250-8BITMIME\r\n250 SMTPUTF8",
    auth: "334-VXNlcm5hbWU6\r\n334 ",
    authUser: "334-UGFzc3dvcmQ6\r\n334",
    authPass: "235-2.7.0 ok\r\n235 2.7.0 Authentication successful",
    mailFrom: "250-2.1.0\r\n250 2.1.0 Ok",
    rcpt: "250-2.1.5\r\n250 2.1.5 Ok",
    data: "354-go\r\n354 End data with <CR><LF>.<CR><LF>",
    dataEnd: "250-2.0.0 Ok\r\n250 2.0.0 Ok: queued as MULTI-1",
  };
  for (const [label, chunker] of [["entier", undefined], ["en deux", IN_HALF], ["avant le CRLF final", BEFORE_CRLF], ["entre code et texte", CODE_THEN_REST], ["octet par octet", BYTE_BY_BYTE], ["entre CR et LF", splitCrLf]] as const) {
    const h = harness({ script: { ...multi, ...(chunker ? { chunker } : {}) } });
    assert.deepEqual(await createSmtpTransport(h.io, FAST).send(MESSAGE), { ok: true, messageId: "MULTI-1" }, label);
    assert.equal(bodyWritten(h.sockets[0]!.written), true, label);
    const hc = harness({ script: { ...multi, ...(chunker ? { chunker } : {}) } });
    assert.deepEqual(await createSmtpTransport(hc.io, FAST).checkConnectivity(CONFIG), { ok: true }, label);
  }
  // Continuations vides, ligne finale sans texte, tabulation et UTF-8 dans le texte : valides.
  for (const ehlo of ["250-\r\n250-PIPELINING\r\n250", "250-a\tb\r\n250 c\td", "250-é\r\n250 ✓", "250 seule ligne finale", "250"]) {
    for (const chunker of [IN_HALF, BYTE_BY_BYTE]) {
      const h = harness({ script: { ehlo, chunker } });
      assert.deepEqual(await createSmtpTransport(h.io, FAST).checkConnectivity(CONFIG), { ok: true }, JSON.stringify(ehlo));
    }
  }
});

test("R5 : un refus multiligne VALIDE (même code sur toutes les lignes) garde son statut et son étape -- ce n'est pas une réponse malformée", async () => {
  const { classifySmtpFailure } = await import("../lib/server/notifications/smtp-failure-classification.ts");
  const rcpt = harness({ script: { rcpt: "550-5.1.1 user unknown\r\n550 5.1.1 really unknown" } });
  const refused = await createSmtpTransport(rcpt.io, FAST).send(MESSAGE);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.match(refused.error, /^SMTP_UNEXPECTED_RESPONSE: attendu 250/);
    assert.deepEqual([refused.stage, refused.status], ["rcpt_to", 550]);
    assert.equal(classifySmtpFailure(refused).errorClass, "INVALID_RECIPIENT");
  }
  const greeting = harness({ script: { greeting: "421-4.7.0 try later\r\n421 4.7.0 service unavailable" } });
  const busy = await createSmtpTransport(greeting.io, FAST).checkConnectivity(CONFIG);
  assert.equal(busy.ok, false);
  if (!busy.ok) { assert.deepEqual([busy.stage, busy.status], ["greeting", 421]); assert.deepEqual(classifySmtpFailure(busy), { errorClass: "PROVIDER_TEMPORARY_UNAVAILABLE", retryable: true, disableProvider: false }); }
});

test("R5 : une réponse malformée est TEMPORAIRE et réessayable à toute étape (jamais un succès, jamais une suspension du fournisseur, jamais de texte serveur conservé)", async () => {
  const { classifySmtpFailure } = await import("../lib/server/notifications/smtp-failure-classification.ts");
  for (const s of R5_STAGES) {
    const h = harness({ script: { [s.key]: `${s.code}-x\r\n${s.refusal} SECRET-DU-SERVEUR` } as ServerScript });
    const result = await createSmtpTransport(h.io, FAST).send(MESSAGE);
    assert.equal(result.ok, false, s.key);
    if (result.ok) continue;
    assert.deepEqual(classifySmtpFailure(result), { errorClass: "PROVIDER_TEMPORARY_UNAVAILABLE", retryable: true, disableProvider: false }, `${s.key} (${s.stage})`);
    assert.equal(JSON.stringify(result).includes("SECRET-DU-SERVEUR"), false, `${s.key} : le texte du serveur n'est pas repris`);
    assert.equal(JSON.stringify(result).includes(PASSWORD), false, s.key);
  }
});

// R5 (observation P3 du même rapport) : la borne de taille était contrôlée APRÈS l'extraction d'une réponse
// complète -- une bannière ASCII de 70 Kio terminée par CRLF était acceptée. La borne s'applique maintenant à la
// réponse complète (lignes, séparateurs et sauts de ligne parasites compris).
test("R5 borne : une réponse COMPLÈTE de plus de 64 Kio est refusée (ligne unique, très nombreuses continuations, sauts de ligne parasites) ; juste en dessous, elle passe", async () => {
  const oversize: Array<[string, ServerScript]> = [
    ["bannière ASCII de 70 Kio terminée par CRLF", { greeting: `220 ${"a".repeat(70 * 1024)}` }],
    ["bannière en continuations (10 000 lignes)", { greeting: `${Array.from({ length: 10_000 }, () => "220-xxxxxxxx").join("\r\n")}\r\n220 fin` }],
    ["EHLO en continuations (10 000 lignes)", { ehlo: `${Array.from({ length: 10_000 }, () => "250-xxxxxxxx").join("\r\n")}\r\n250 fin` }],
    ["sauts de ligne parasites avant la bannière", { greeting: `${"\r\n".repeat(40_000)}220 prêt` }],
  ];
  for (const [label, script] of oversize) {
    const h = harness({ script });
    const result = await createSmtpTransport(h.io, FAST).checkConnectivity(CONFIG);
    assert.equal(result.ok, false, `${label} : accepté`);
    if (!result.ok) assert.equal(result.error, "SMTP_REPLY_TOO_LARGE", label);
    assert.equal(h.sockets[0]!.destroyed, true, label);
    assert.equal(commandsSeen(h.sockets[0]!.written).some((l) => l === "AUTH LOGIN" || l === b64(CONFIG.user)), false, label);
  }
  const justUnder = harness({ script: { greeting: `220 ${"a".repeat(60 * 1024)}` } });
  assert.deepEqual(await createSmtpTransport(justUnder.io, FAST).checkConnectivity(CONFIG), { ok: true }, "60 Kio : sous la borne");
});

test("R5 : un seul analyseur de réponses -- chaque `expectCode` porte sur une réponse déjà validée par le lecteur (aucune lecture brute du socket)", async () => {
  const src = (await import("node:fs")).readFileSync("lib/server/ack-mailer.ts", "utf8");
  const reads = [...src.matchAll(/reader\.read\(/g)].length;
  assert.equal(reads, 2, "bannière + exchange() : seules lectures, toutes via SmtpReplyReader.takeReply");
  assert.equal((src.match(/socket\.on\("data"/g) ?? []).length, 1, "un seul abonnement aux données du socket (le lecteur)");
});

test("R5 bannière DÉJÀ dans le tampon quand le client lit : une bannière invalide ou démesurée est refusée comme les autres (chemin de lecture immédiate), une valide passe", async () => {
  const invalid: Array<[string, string, string]> = [
    ["texte libre après une continuation", "220-bonjour\r\nNOT A STATUS LINE", "SMTP_MALFORMED_RESPONSE: line_syntax"],
    ["continuation puis refus", "220-bonjour\r\n554 service unavailable", "SMTP_MALFORMED_RESPONSE: code_mismatch"],
    ["ligne vide dans la réponse", "220-bonjour\r\n", "SMTP_MALFORMED_RESPONSE: line_syntax"],
    ["caractère de contrôle", "220 bon\u0000jour", "SMTP_MALFORMED_RESPONSE: control_character"],
    ["70 Kio complets", `220 ${"a".repeat(70 * 1024)}`, "SMTP_REPLY_TOO_LARGE"],
  ];
  for (const [label, greeting, error] of invalid) {
    const h = harness({ script: { greeting, greetingBeforeRead: true } });
    const result = await createSmtpTransport(h.io, FAST).send(MESSAGE);
    assert.equal(result.ok, false, `${label} : accepté (${JSON.stringify(result)})`);
    if (!result.ok) { assert.equal(result.error, error, label); assert.equal(result.stage, "greeting", label); }
    assert.deepEqual(commandsSeen(h.sockets[0]!.written), [], `${label} : une commande a été écrite après une bannière invalide`);
  }
  const valid = harness({ script: { greeting: "220-smtp.merchant.example ESMTP\r\n220 prêt", greetingBeforeRead: true } });
  const ok = await createSmtpTransport(valid.io, FAST).send(MESSAGE);
  assert.equal(ok.ok, true, JSON.stringify(ok));
});
