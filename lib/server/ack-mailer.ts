import "server-only";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { lookup as dnsLookup } from "node:dns/promises";

/**
 * SCANYM — GAP-01 — TRANSPORT SMTP RÉEL DE L'ACCUSÉ DE RÉCEPTION DE
 * RÉTRACTATION (art. L221-21 / D.221-5).
 *
 * Variables d'environnement AUTORITAIRES (confirmées sur l'issue #11,
 * "RAVEL → BOULEZ — CONFIRMATION DES NOMS EXACTS DES VARIABLES SMTP") :
 * SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM. AUCUNE
 * variante `SCANYM_ACK_SMTP_*` n'est lue -- ce nommage provisoire a
 * été explicitement écarté par Ravel.
 *
 * Aucune dépendance tierce (nodemailer, etc.) : OVH SMTP/SSL sur le
 * port 465 est un protocole texte simple (EHLO, AUTH LOGIN, MAIL FROM,
 * RCPT TO, DATA), et le principe de coût du projet ("pas de
 * prestataire transactionnel tiers", CIO DECISION — GAP-01 design
 * direction) s'applique aussi au choix de ne pas ajouter une
 * dépendance npm pour ce volume (un e-mail par demande de
 * rétractation). Le client TLS est écrit ici, minimal, DERRIÈRE une
 * interface `SmtpTransport` injectable -- les tests unitaires
 * n'ouvrent JAMAIS de socket réel, ils fournissent un transport
 * simulé (voir tests/gap-01-ack-mailer.test.ts).
 *
 * SÉCURITÉ : aucun secret (SMTP_PASSWORD) n'est jamais journalisé, ni
 * inclus dans une erreur renvoyée à l'appelant -- seules les erreurs
 * SMTP elles-mêmes (code + phrase, jamais les identifiants envoyés)
 * sont propagées.
 */

// -----------------------------------------------------------------------------
// A. CONTENU — gabarit FR/EN/AR, VERSIONNÉ.
// -----------------------------------------------------------------------------
// Version incrémentée à CHAQUE changement de texte -- persistée dans
// withdrawal_requests.acknowledgement_content_version (preuve
// d'évidence : reconstituer le texte exact envoyé à une date donnée,
// même après une future révision de ce gabarit).
export const ACK_EMAIL_CONTENT_VERSION = "gap-01-ack-v1";

export interface AckEmailLine {
  itemName: string;
  optionName: string | null;
  quantity: number;
}

export interface AckEmailContentInput {
  lang: "fr" | "en" | "ar";
  orderNumber: number;
  requestedAt: string; // ISO 8601, déjà horodatage serveur.
  customerFirstName: string;
  customerLastName: string;
  lines: AckEmailLine[];
  merchantName: string;
  merchantContactEmail: string | null;
  merchantContactPhone: string | null;
}

interface AckEmailContent {
  subject: string;
  text: string;
  html: string;
}

function formatDateTime(iso: string, lang: "fr" | "en" | "ar"): string {
  try {
    const locale = lang === "fr" ? "fr-FR" : lang === "ar" ? "ar" : "en-GB";
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: "Europe/Paris",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatLines(lines: AckEmailLine[]): string {
  return lines
    .map((l) => `${l.quantity} × ${l.itemName}${l.optionName ? ` (${l.optionName})` : ""}`)
    .join("\n");
}

/**
 * Contenu PUR (aucun accès réseau) -- la même fonction produit
 * toujours exactement le même texte pour les mêmes entrées, ce qui
 * rend le hash/la version de contenu significatifs. Reprend
 * exactement les points requis par la CIO DECISION — GAP-01
 * ACKNOWLEDGEMENT RECIPIENTS (issue #11) : date/heure, référence de
 * commande, produits/quantités, identité/contact du marchand, et la
 * déclaration explicite que le marchand transmettra séparément les
 * instructions de retour.
 */
export function buildAckEmailContent(input: AckEmailContentInput): AckEmailContent {
  const when = formatDateTime(input.requestedAt, input.lang);
  const lines = formatLines(input.lines);
  const contact = [input.merchantContactEmail, input.merchantContactPhone].filter(Boolean).join(" / ") || "—";

  if (input.lang === "en") {
    return {
      subject: `Withdrawal request received — order #${input.orderNumber}`,
      text: `Hello ${input.customerFirstName} ${input.customerLastName},\n\nWe confirm receipt of your withdrawal request for order #${input.orderNumber}, submitted on ${when}.\n\nProducts concerned:\n${lines}\n\nSeller: ${input.merchantName} (${contact})\n\nThis message only acknowledges receipt of your withdrawal declaration. The seller will separately send you the practical return instructions for the products concerned.\n\n— Scanym, on behalf of ${input.merchantName}`,
      html: `<p>Hello ${input.customerFirstName} ${input.customerLastName},</p><p>We confirm receipt of your withdrawal request for order #${input.orderNumber}, submitted on ${when}.</p><p><strong>Products concerned:</strong><br>${lines.replace(/\n/g, "<br>")}</p><p><strong>Seller:</strong> ${input.merchantName} (${contact})</p><p>This message only acknowledges receipt of your withdrawal declaration. The seller will separately send you the practical return instructions for the products concerned.</p><p>— Scanym, on behalf of ${input.merchantName}</p>`,
    };
  }
  if (input.lang === "ar") {
    return {
      subject: `تأكيد استلام طلب التراجع — الطلب رقم ${input.orderNumber}`,
      text: `مرحباً ${input.customerFirstName} ${input.customerLastName}،\n\nنؤكد استلام طلب التراجع الخاص بكم عن الطلب رقم ${input.orderNumber}، المُقدَّم بتاريخ ${when}.\n\nالمنتجات المعنية:\n${lines}\n\nالبائع: ${input.merchantName} (${contact})\n\nهذه الرسالة تؤكد فقط استلام تصريح التراجع. سيرسل لكم البائع لاحقاً وبشكل منفصل تعليمات الإرجاع العملية للمنتجات المعنية.\n\n— Scanym، نيابة عن ${input.merchantName}`,
      html: `<p dir="rtl">مرحباً ${input.customerFirstName} ${input.customerLastName}،</p><p dir="rtl">نؤكد استلام طلب التراجع الخاص بكم عن الطلب رقم ${input.orderNumber}، المُقدَّم بتاريخ ${when}.</p><p dir="rtl"><strong>المنتجات المعنية:</strong><br>${lines.replace(/\n/g, "<br>")}</p><p dir="rtl"><strong>البائع:</strong> ${input.merchantName} (${contact})</p><p dir="rtl">هذه الرسالة تؤكد فقط استلام تصريح التراجع. سيرسل لكم البائع لاحقاً وبشكل منفصل تعليمات الإرجاع العملية للمنتجات المعنية.</p><p dir="rtl">— Scanym، نيابة عن ${input.merchantName}</p>`,
    };
  }
  // Français par défaut.
  return {
    subject: `Accusé de réception de votre demande de rétractation — commande n°${input.orderNumber}`,
    text: `Bonjour ${input.customerFirstName} ${input.customerLastName},\n\nNous accusons réception de votre demande de rétractation concernant la commande n°${input.orderNumber}, transmise le ${when}.\n\nProduits concernés :\n${lines}\n\nVendeur : ${input.merchantName} (${contact})\n\nLe présent message accuse uniquement réception de votre déclaration de rétractation. Le vendeur vous communiquera séparément les modalités pratiques de retour des produits concernés.\n\n— Scanym, pour le compte de ${input.merchantName}`,
    html: `<p>Bonjour ${input.customerFirstName} ${input.customerLastName},</p><p>Nous accusons réception de votre demande de rétractation concernant la commande n°${input.orderNumber}, transmise le ${when}.</p><p><strong>Produits concernés :</strong><br>${lines.replace(/\n/g, "<br>")}</p><p><strong>Vendeur :</strong> ${input.merchantName} (${contact})</p><p>Le présent message accuse uniquement réception de votre déclaration de rétractation. Le vendeur vous communiquera séparément les modalités pratiques de retour des produits concernés.</p><p>— Scanym, pour le compte de ${input.merchantName}</p>`,
  };
}

// -----------------------------------------------------------------------------
// B. CONFIGURATION — lue UNIQUEMENT au moment de l'envoi, jamais au
//    chargement du module (même discipline "lazy" que supabase-admin.ts).
// -----------------------------------------------------------------------------
export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

export class SmtpConfigMissingError extends Error {
  readonly missing: readonly string[];
  constructor(missing: readonly string[]) {
    super(`SMTP_CONFIG_MISSING: ${missing.join(", ")}`);
    this.name = "SmtpConfigMissingError";
    this.missing = missing;
  }
}

/**
 * GAP-01 remédiation round 1 (finding #3, issue #11 -- "CGV v7
 * overstates runtime guarantees") : CGV v7 (DRAFT-lot-gap-01-cgv-
 * template-v7.sql) affirme SANS CONDITION que l'accusé de réception
 * "est envoyé depuis l'adresse retractation@scanym.com". Avant cette
 * remédiation, `readSmtpConfig` faisait confiance à la valeur BRUTE
 * de la variable d'environnement SMTP_FROM -- une valeur Vercel
 * mal configurée (faute de frappe, adresse de test oubliée, etc.)
 * aurait fait mentir la CGV silencieusement, sans qu'aucun code ni
 * aucun test ne le détecte. La CGV ne doit promettre QUE ce que le
 * runtime garantit réellement -- donc c'est le runtime qui est
 * contraint pour rejoindre la CGV (option retenue par la CIO,
 * issue #11, "prefer constraining runtime to match legal promise"),
 * jamais l'inverse : la config est traitée comme ABSENTE (même
 * contrat "no-op gracieux" que les autres variables SMTP_*, jamais un
 * envoi silencieux avec un expéditeur différent) si SMTP_FROM ne vaut
 * pas EXACTEMENT cette adresse.
 */
export const REQUIRED_ACK_FROM_ADDRESS = "retractation@scanym.com";

/**
 * Lit SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD/SMTP_FROM -- noms
 * EXACTS confirmés sur l'issue #11, jamais une variante
 * `SCANYM_ACK_SMTP_*`. Renvoie `null` (jamais une exception) si une
 * seule variable manque, OU si SMTP_FROM ne vaut pas exactement
 * `REQUIRED_ACK_FROM_ADDRESS` (voir commentaire ci-dessus) : c'est le
 * contrat "no-op gracieux" -- voir `sendWithdrawalAcknowledgement`
 * ci-dessous, qui traite `null` comme "aucun envoi tenté, canal non
 * configuré", jamais comme une erreur bloquante pour la déclaration
 * de rétractation elle-même. Un SMTP_FROM erroné n'est PAS traité
 * différemment d'un SMTP_FROM absent -- dans les deux cas, aucun
 * message n'est envoyé plutôt que d'être envoyé sous une identité que
 * la CGV ne garantit pas.
 */
export function readSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST;
  const portRaw = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;
  const from = process.env.SMTP_FROM;

  const missing: string[] = [];
  if (!host) missing.push("SMTP_HOST");
  if (!portRaw) missing.push("SMTP_PORT");
  if (!user) missing.push("SMTP_USER");
  if (!password) missing.push("SMTP_PASSWORD");
  if (!from) missing.push("SMTP_FROM");
  else if (from !== REQUIRED_ACK_FROM_ADDRESS) missing.push("SMTP_FROM (invalid value)");
  if (missing.length > 0) return null;

  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  return { host: host!, port, user: user!, password: password!, from: from! };
}

// -----------------------------------------------------------------------------
// C. TRANSPORT — client SMTP minimal sur TLS implicite (port 465),
//    DERRIÈRE une interface injectable.
// -----------------------------------------------------------------------------
export interface SmtpSendInput {
  config: SmtpConfig;
  to: string;
  cc: string | null;
  fromName?: string | null;
  subject: string;
  text: string;
  html: string;
  replyTo?: string | null;
  messageId?: string | null;
}

/**
 * Étape du dialogue SMTP où un échec est survenu. Sert UNIQUEMENT à classer
 * l'échec (voir lib/server/notifications/smtp-failure-classification.ts) ;
 * jamais renvoyée au navigateur ni persistée telle quelle.
 */
export type SmtpFailureStage =
  | "dns"
  | "host_not_public"
  | "connect"
  | "greeting"
  | "ehlo"
  | "auth"
  | "mail_from"
  | "rcpt_to"
  | "data"
  | "data_end"
  | "timeout"
  | "header";

export interface SmtpFailureDetail {
  stage?: SmtpFailureStage;
  /** Code de réponse SMTP à 3 chiffres quand le serveur a répondu, sinon null. */
  status?: number | null;
  /** Code d'erreur Node (ECONNREFUSED, ERR_TLS_CERT_ALTNAME_INVALID...) quand disponible. */
  nodeCode?: string | null;
}

export type SmtpSendResult =
  | { ok: true; messageId: string }
  | ({ ok: false; error: string } & SmtpFailureDetail);

export type SmtpConnectivityResult =
  | { ok: true }
  | ({ ok: false; error: string } & SmtpFailureDetail);

export interface SmtpTransport {
  send(input: SmtpSendInput): Promise<SmtpSendResult>;
  /** Connexion + AUTH LOGIN uniquement, AUCUN message envoyé -- pour le health-check admin. */
  checkConnectivity(config: SmtpConfig): Promise<SmtpConnectivityResult>;
}

/** Erreur typée du dialogue SMTP : le message reste celui historique (aucun secret). */
export class SmtpSessionError extends Error {
  readonly stage: SmtpFailureStage;
  readonly status: number | null;
  readonly nodeCode: string | null;
  constructor(message: string, stage: SmtpFailureStage, status: number | null = null, nodeCode: string | null = null) {
    super(message);
    this.name = "SmtpSessionError";
    this.stage = stage;
    this.status = status;
    this.nodeCode = nodeCode;
  }
}

/** Entrées/sorties réseau injectables (tests) ; les valeurs par défaut sont les vraies. */
export interface SmtpIo {
  lookup(host: string): Promise<Array<{ address: string; family: number }>>;
  connect(options: { host: string; servername: string; port: number; timeout: number }, onConnect: () => void): TLSSocket;
}

export interface SmtpLimits {
  /** Délai maximal d'attente d'UNE réponse du serveur. */
  stepTimeoutMs: number;
  /** Durée maximale d'une session complète (DNS + connexion + dialogue). */
  totalTimeoutMs: number;
}

const CRLF = "\r\n";
const SMTP_TIMEOUT_MS = 15_000;
/** Borne dure d'une session : un hôte lent ne peut pas retenir le worker plus longtemps (A196-05). */
export const SMTP_SESSION_TOTAL_TIMEOUT_MS = 60_000;
const DEFAULT_LIMITS: SmtpLimits = { stepTimeoutMs: SMTP_TIMEOUT_MS, totalTimeoutMs: SMTP_SESSION_TOTAL_TIMEOUT_MS };
const DEFAULT_IO: SmtpIo = {
  lookup: (host) => dnsLookup(host, { all: true, verbatim: true }),
  connect: (options, onConnect) => tlsConnect(options, onConnect),
};

function readLine(socket: TLSSocket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      // Une réponse multi-ligne SMTP a "250-..." sur les lignes
      // intermédiaires et "250 ..." (espace) sur la dernière.
      const lines = buf.split(CRLF).filter((l) => l.length > 0);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        resolve(buf);
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("SMTP_TIMEOUT"));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    }
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

function expectCode(response: string, code: string, stage: SmtpFailureStage): void {
  if (!response.startsWith(code)) {
    // Ne jamais inclure la commande envoyée (peut contenir le secret
    // AUTH LOGIN encodé) dans le message d'erreur -- uniquement la
    // réponse SERVEUR, jamais ce qui a été transmis.
    const status = /^\d{3}/.test(response) ? Number(response.slice(0, 3)) : null;
    throw new SmtpSessionError(
      `SMTP_UNEXPECTED_RESPONSE: attendu ${code}, reçu: ${response.trim().slice(0, 200)}`,
      stage,
      status
    );
  }
}

/**
 * Adresse IPv4 publique (routable) ? Refuse les plages privées, de
 * boucle locale, de lien local, de partage opérateur, de documentation,
 * de test et réservées/multicast. Exportée pour être testée seule.
 */
export function isPublicIpv4Address(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts as [number, number, number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

function nodeCodeOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** Convertit toute erreur de session en résultat typé, sans jamais exposer autre chose que le message historique. */
function failureFrom(err: unknown): { ok: false; error: string } & SmtpFailureDetail {
  if (err instanceof SmtpSessionError) {
    return { ok: false, error: err.message, stage: err.stage, status: err.status, nodeCode: err.nodeCode };
  }
  const message = err instanceof Error ? err.message : "SMTP_UNKNOWN_ERROR";
  if (message === "SMTP_TIMEOUT") return { ok: false, error: message, stage: "timeout" };
  if (/^SMTP_INVALID_[A-Z-]+_HEADER$/.test(message)) return { ok: false, error: message, stage: "header" };
  return { ok: false, error: message, nodeCode: nodeCodeOf(err) };
}

async function withSmtpSession<T>(
  io: SmtpIo,
  limits: SmtpLimits,
  config: SmtpConfig,
  body: (socket: TLSSocket) => Promise<T>
): Promise<T> {
  const held: { socket: TLSSocket | null } = { socket: null };
  // Posé dès que la session est terminée (succès, échec ou délai global) : une
  // étape encore en vol (DNS, connexion) ne doit JAMAIS poursuivre le dialogue
  // en arrière-plan -- sinon un message pourrait partir après qu'on a rendu
  // « délai dépassé » à l'appelant, puis être renvoyé (doublon, A196-05).
  const state = { aborted: false };
  const abortedError = () => new SmtpSessionError("SMTP_SESSION_TIMEOUT", "timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Borne dure sur TOUTE la session (DNS, connexion, dialogue) : un hôte qui
  // répond lentement ne peut plus retenir le worker (A196-05).
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SmtpSessionError("SMTP_SESSION_TIMEOUT", "timeout")), limits.totalTimeoutMs);
  });
  const run = (async (): Promise<T> => {
    // Merchant-controlled SMTP hosts must not turn this server into an SSRF
    // proxy. Resolve once, reject private/special-use addresses, then pin the
    // socket to the validated public IPv4 while preserving hostname SNI.
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await io.lookup(config.host);
    } catch (err) {
      throw new SmtpSessionError("SMTP_DNS_FAILED", "dns", null, nodeCodeOf(err));
    }
    if (state.aborted) throw abortedError();
    const address = addresses.filter((entry) => entry.family === 4).find((entry) => isPublicIpv4Address(entry.address))?.address;
    if (!address) {
      throw new SmtpSessionError("SMTP_HOST_NOT_PUBLIC", "host_not_public");
    }
    const socket = await new Promise<TLSSocket>((resolve, reject) => {
      const s = io.connect({ host: address, servername: config.host, port: config.port, timeout: limits.stepTimeoutMs }, () => {
        s.off("timeout", onTimeout);
        s.setTimeout(0);
        resolve(s);
      });
      const onTimeout = () => {
        s.destroy();
        reject(new SmtpSessionError("SMTP_TIMEOUT", "timeout"));
      };
      s.once("timeout", onTimeout);
      s.once("error", (err) => reject(new SmtpSessionError(err instanceof Error ? err.message : "SMTP_CONNECT_FAILED", "connect", null, nodeCodeOf(err))));
    });
    held.socket = socket;
    if (state.aborted) {
      socket.destroy();
      throw abortedError();
    }

    const greeting = await readLine(socket, limits.stepTimeoutMs);
    expectCode(greeting, "220", "greeting");

    socket.write(`EHLO scanym.com${CRLF}`);
    const ehloResp = await readLine(socket, limits.stepTimeoutMs);
    expectCode(ehloResp, "250", "ehlo");

    socket.write(`AUTH LOGIN${CRLF}`);
    const authResp = await readLine(socket, limits.stepTimeoutMs);
    expectCode(authResp, "334", "auth");

    socket.write(`${Buffer.from(config.user, "utf8").toString("base64")}${CRLF}`);
    const userResp = await readLine(socket, limits.stepTimeoutMs);
    expectCode(userResp, "334", "auth");

    socket.write(`${Buffer.from(config.password, "utf8").toString("base64")}${CRLF}`);
    const passResp = await readLine(socket, limits.stepTimeoutMs);
    expectCode(passResp, "235", "auth");

    return await body(socket);
  })();
  try {
    return await Promise.race([run, deadline]);
  } finally {
    state.aborted = true;
    clearTimeout(timer);
    const socket = held.socket;
    if (socket) {
      try {
        socket.write(`QUIT${CRLF}`);
      } catch {
        // best-effort
      }
      socket.destroy();
    }
  }
}

function escapeDotStuffing(body: string): string {
  // RFC 5321 §4.5.2 : toute ligne commençant par un point doit être
  // doublée, sinon le serveur l'interprète comme la fin de DATA.
  return body
    .split(CRLF)
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join(CRLF);
}

function smtpHeaderValue(value: string, field: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`SMTP_INVALID_${field.toUpperCase()}_HEADER`);
  return value;
}

export function buildSmtpMimeMessage(input: SmtpSendInput): string {
  const boundary = `scanym-gap01-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const encodedSubject = Buffer.from(smtpHeaderValue(input.subject, "subject"), "utf8").toString("base64");
  const fromName = smtpHeaderValue(input.fromName?.trim() || "Scanym", "from-name");
  const encodedFromName = Buffer.from(fromName, "utf8").toString("base64");
  const headers = [
    `From: =?UTF-8?B?${encodedFromName}?= <${smtpHeaderValue(input.config.from, "from")}>`,
    `To: ${smtpHeaderValue(input.to, "to")}`,
    ...(input.replyTo ? [`Reply-To: ${smtpHeaderValue(input.replyTo, "reply-to")}`] : []),
    ...(input.cc ? [`Cc: ${smtpHeaderValue(input.cc, "cc")}`] : []),
    ...(input.messageId ? [`Message-ID: ${smtpHeaderValue(input.messageId, "message-id")}`] : []),
    `Subject: =?UTF-8?B?${encodedSubject}?=`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join(CRLF);
  const body = [
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    input.text,
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    ``,
    input.html,
    `--${boundary}--`,
  ].join(CRLF);
  return `${headers}${CRLF}${CRLF}${body}`;
}

/**
 * Implémentation RÉELLE (OVH SMTP/SSL, port 465, tel que confirmé sur
 * l'issue #11 : ssl0.ovh.net). Jamais utilisée directement par les
 * tests unitaires -- injectée par défaut uniquement dans
 * `sendWithdrawalAcknowledgement`/le endpoint de health-check.
 */
export function createSmtpTransport(io: SmtpIo = DEFAULT_IO, limits: SmtpLimits = DEFAULT_LIMITS): SmtpTransport {
  return {
    async send(input) {
      try {
        const messageId = await withSmtpSession(io, limits, input.config, async (socket) => {
          socket.write(`MAIL FROM:<${input.config.from}>${CRLF}`);
          expectCode(await readLine(socket, limits.stepTimeoutMs), "250", "mail_from");

          socket.write(`RCPT TO:<${input.to}>${CRLF}`);
          expectCode(await readLine(socket, limits.stepTimeoutMs), "250", "rcpt_to");

          if (input.cc) {
            socket.write(`RCPT TO:<${input.cc}>${CRLF}`);
            expectCode(await readLine(socket, limits.stepTimeoutMs), "250", "rcpt_to");
          }

          socket.write(`DATA${CRLF}`);
          expectCode(await readLine(socket, limits.stepTimeoutMs), "354", "data");

          const message = escapeDotStuffing(buildSmtpMimeMessage(input));
          socket.write(`${message}${CRLF}.${CRLF}`);
          const dataResp = await readLine(socket, limits.stepTimeoutMs);
          expectCode(dataResp, "250", "data_end");

          // Le message id du prestataire, quand il en renvoie un, se
          // trouve dans la réponse 250 (ex. "250 2.0.0 Ok: queued as
          // <id>"). À défaut, un identifiant local est construit --
          // toujours PRÉFIXÉ pour rester distinguable d'un id fourni
          // par le serveur dans les preuves d'audit.
          const match = dataResp.match(/queued as ([^\s]+)/i);
          return match?.[1] ?? `scanym-local-${Date.now()}`;
        });
        return { ok: true, messageId };
      } catch (err) {
        return failureFrom(err);
      }
    },

    async checkConnectivity(config) {
      try {
        await withSmtpSession(io, limits, config, async () => undefined);
        return { ok: true };
      } catch (err) {
        return failureFrom(err);
      }
    },
  };
}

export const realSmtpTransport: SmtpTransport = createSmtpTransport();

// -----------------------------------------------------------------------------
// D. ORCHESTRATION — appelée depuis la route API de soumission,
//    BEST-EFFORT/NON-BLOQUANT vis-à-vis du succès de la déclaration.
// -----------------------------------------------------------------------------
export interface AckDependencies {
  transport: SmtpTransport;
  /**
   * Exécute claim_withdrawal_acknowledgement_send (service_role) et
   * renvoie, dans le MÊME appel, l'identité/contact marchand (jointure
   * interne restaurants + merchant_legal_profile, lue sous SECURITY
   * DEFINER côté SQL) : service_role n'a par ailleurs aucun privilège
   * de table direct sur ces deux tables, donc un second aller-retour
   * "resolveMerchantContact" séparé échouerait en production -- ce
   * contrat évite ce piège par construction.
   */
  claim(withdrawalRequestId: string): Promise<{
    id: string;
    restaurantId: string;
    orderId: string;
    acknowledgementAddress: string;
    customerFirstName: string;
    customerLastName: string;
    declarationSnapshot: unknown;
    merchantName: string;
    merchantContactEmail: string | null;
    merchantContactPhone: string | null;
    /**
     * GAP-01 remédiation (issue #11, e-mail marchand obligatoire pour
     * STANDARD_14_DAYS/MIXED) -- `merchant_cgv_profile.withdrawal_regime`,
     * lu dans le MÊME appel SECURITY DEFINER que le reste (voir
     * `claim_withdrawal_acknowledgement_send`, DRAFT-lot-gap-01-
     * mandatory-merchant-email-v1.sql). `null` si le profil CGV est
     * absent ou le régime non renseigné -- traité comme "hors
     * périmètre applicable" par la garde défensive ci-dessous, jamais
     * comme une erreur bloquante en soi (cohérent avec
     * `cgv_completeness_errors`, qui a de toute façon déjà refusé la
     * publication d'une CGV pour un profil incomplet).
     */
    merchantWithdrawalRegime: string | null;
  } | null>;
  /** Exécute record_withdrawal_acknowledgement_result (service_role). */
  recordResult(input: {
    withdrawalRequestId: string;
    ok: boolean;
    to: string;
    cc: string | null;
    messageId: string | null;
    contentVersion: string | null;
    error: string | null;
  }): Promise<void>;
}

export type SendAckOutcome =
  | { attempted: false; reason: "no_channel" | "already_claimed_elsewhere" }
  | { attempted: true; ok: true; messageId: string }
  | { attempted: true; ok: false; error: string };

/**
 * GAP-01 remédiation (issue #11) -- même périmètre régime que le gate
 * SQL `cgv_completeness_errors` (DRAFT-lot-gap-01-mandatory-merchant-
 * email-v1.sql) et que l'UI (`app/dashboard/legal-cgv/page.tsx`) :
 * l'e-mail marchand n'est obligatoire QUE sous ces deux régimes, car
 * l'accusé de réception D.221-5 n'est transporté QUE par e-mail.
 */
const APPLICABLE_WITHDRAWAL_REGIMES = new Set(["STANDARD_14_DAYS", "MIXED"]);

/** Code d'erreur stable de la garde défensive ci-dessous -- distinct de
 * tout code de transport SMTP réel (jamais confondu avec ECONNREFUSED
 * et consorts dans les journaux/évidences d'audit). */
const MERCHANT_EMAIL_MISSING_FOR_APPLICABLE_REGIME_ERROR =
  "MERCHANT_CONTACT_EMAIL_MISSING_FOR_APPLICABLE_REGIME";

/**
 * BEST-EFFORT / NON-BLOQUANT : l'appelant (route de soumission de
 * rétractation) doit TOUJOURS traiter cette fonction comme pouvant
 * échouer sans faire échouer la déclaration elle-même déjà enregistrée
 * (voir app/track/[orderId]/withdrawal/route.ts) -- cette fonction n'expose
 * donc aucune exception à son appelant : toute erreur est capturée et
 * renvoyée dans `SendAckOutcome`, et `record_withdrawal_acknowledgement_
 * result` est appelée dans TOUS les cas (succès ou échec réel), jamais
 * quand le canal est simplement absent (rien à tenter, rien à
 * enregistrer de plus que l'état déjà honnête posé à la création :
 * `unavailable_no_channel`).
 */
export async function sendWithdrawalAcknowledgement(
  withdrawalRequestId: string,
  deps: AckDependencies,
  lang: "fr" | "en" | "ar" = "fr"
): Promise<SendAckOutcome> {
  const config = readSmtpConfig();
  if (!config) {
    return { attempted: false, reason: "no_channel" };
  }

  const claimed = await deps.claim(withdrawalRequestId);
  if (!claimed) {
    return { attempted: false, reason: "already_claimed_elsewhere" };
  }

  const merchant = {
    merchantName: claimed.merchantName,
    contactEmail: claimed.merchantContactEmail,
    contactPhone: claimed.merchantContactPhone,
  };
  const snapshot = claimed.declarationSnapshot as {
    order_number?: number;
    lines?: Array<{ item_name: string; option_name: string | null; quantity: number }>;
    declared_at?: string;
  } | null;

  const content = buildAckEmailContent({
    lang,
    orderNumber: snapshot?.order_number ?? 0,
    requestedAt: snapshot?.declared_at ?? new Date().toISOString(),
    customerFirstName: claimed.customerFirstName,
    customerLastName: claimed.customerLastName,
    lines: (snapshot?.lines ?? []).map((l) => ({
      itemName: l.item_name,
      optionName: l.option_name,
      quantity: l.quantity,
    })),
    merchantName: merchant.merchantName,
    merchantContactEmail: merchant.contactEmail,
    merchantContactPhone: merchant.contactPhone,
  });

  // GAP-01 remédiation (issue #11) -- garde défensive, DÉFENSE EN
  // PROFONDEUR : le gate SQL (`cgv_completeness_errors`) refuse déjà
  // toute NOUVELLE publication de CGV STANDARD_14_DAYS/MIXED sans
  // e-mail marchand, mais ne réécrit (et ne DOIT PAS réécrire --
  // décision CIO, aucun backfill) aucune donnée déjà publiée avant ce
  // gate. Un marchand résiduel, publié avant le gate, téléphone-seul,
  // sous un régime applicable, ne doit JAMAIS déclencher un envoi
  // silencieux avec `cc: null` comme si `ok:true` -- le résultat est
  // consigné en échec EXPLICITE via le même chemin d'évidence que tout
  // échec de transport réel, et AUCUNE tentative d'envoi n'est faite.
  if (
    merchant.contactEmail === null &&
    claimed.merchantWithdrawalRegime !== null &&
    APPLICABLE_WITHDRAWAL_REGIMES.has(claimed.merchantWithdrawalRegime)
  ) {
    await deps.recordResult({
      withdrawalRequestId,
      ok: false,
      to: claimed.acknowledgementAddress,
      cc: null,
      messageId: null,
      contentVersion: ACK_EMAIL_CONTENT_VERSION,
      error: MERCHANT_EMAIL_MISSING_FOR_APPLICABLE_REGIME_ERROR,
    });
    return { attempted: true, ok: false, error: MERCHANT_EMAIL_MISSING_FOR_APPLICABLE_REGIME_ERROR };
  }

  const result = await deps.transport.send({
    config,
    to: claimed.acknowledgementAddress,
    cc: merchant.contactEmail,
    subject: content.subject,
    text: content.text,
    html: content.html,
  });

  await deps.recordResult({
    withdrawalRequestId,
    ok: result.ok,
    to: claimed.acknowledgementAddress,
    cc: merchant.contactEmail,
    messageId: result.ok ? result.messageId : null,
    contentVersion: ACK_EMAIL_CONTENT_VERSION,
    error: result.ok ? null : result.error,
  });

  return result.ok
    ? { attempted: true, ok: true, messageId: result.messageId }
    : { attempted: true, ok: false, error: result.error };
}
