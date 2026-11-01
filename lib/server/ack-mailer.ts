import "server-only";
import { StringDecoder } from "node:string_decoder";
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

/** Taille maximale d'UNE réponse SMTP (un serveur hostile ne peut pas faire grossir le tampon sans fin). */
const MAX_REPLY_CHARS = 64 * 1024;

interface PendingRead {
  resolve: (reply: string) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  stage: SmtpFailureStage;
}

/**
 * R5 : raisons (ensemble FERMÉ, jamais un texte du serveur) pour lesquelles une réponse n'est pas une réponse SMTP valide.
 *  - line_syntax       : une ligne n'est ni « NNN-texte » (continuation) ni « NNN texte » / « NNN » (finale), ou NNN est hors
 *                        de la grammaire [2-5][0-5][0-9] (RFC 5321 §4.2) -- ligne vide, texte libre, code collé au texte...
 *  - code_mismatch     : les lignes d'une même réponse ne portent pas toutes le MÊME code (ex. « 250- » puis « 550 »).
 *  - control_character : caractère de contrôle (hors tabulation) dans le texte -- CR isolé, NUL, ESC...
 */
type SmtpMalformedReason = "line_syntax" | "code_mismatch" | "control_character";

type ReaderFailure =
  | { kind: "error"; error: unknown }
  | { kind: "overflow" }
  | { kind: "malformed"; reason: SmtpMalformedReason }
  | { kind: "closed" };

/** Ce que `takeReply` trouve dans le tampon : une réponse valide et complète, ou une violation (jamais un succès). */
type TakenReply = { kind: "reply"; text: string } | { kind: "overflow" } | { kind: "malformed"; reason: SmtpMalformedReason };

/** Une ligne de réponse (sans CRLF) : code, puis « - » (continuation) ou « SP texte » / rien (finale). */
const REPLY_LINE = /^([2-5][0-5]\d)(?:([- ])([\s\S]*))?$/;
/** Caractères de contrôle interdits dans le texte d'une réponse (la tabulation est admise). */
const REPLY_CONTROL_CHARS = /[\u0000-\u0008\u000A-\u001F\u007F]/;

/**
 * Lecteur de réponses SMTP (R2, contre-audit de 7cb60a8, défaut 1).
 *
 * TCP/TLS ne garantit aucun découpage : une réponse peut arriver en plusieurs morceaux, au
 * milieu d'une ligne, d'un code ou d'un caractère UTF-8. L'ancien lecteur démarrait avec un
 * tampon VIDE à chaque lecture (donc jetait le reste d'un fragment) et prenait une ligne
 * incomplète commençant par « 250 » pour une réponse terminée.
 *
 * Ici : UN seul abonnement par session, un tampon persistant, décodage UTF-8 avec état, et
 * une réponse n'est complète qu'à sa DERNIÈRE ligne COMPLÈTE (terminée par un saut de ligne ;
 * « 250-… » = ligne de continuation, « 250 … » ou « 250 » = dernière ligne).
 *
 * R3 (contre-audit de 9e38c88, P2 « faux succès SMTP, sans réception du corps du message ») :
 * l'ancienne règle « ce qui suit la réponse consommée reste dans le tampon pour la lecture suivante »
 * laissait un serveur répondre AVANT d'avoir reçu la commande : « 354 … » suivi, dans le même paquet,
 * d'un « 250 … queued as X » était lu comme la réponse au CORPS du message, avant même que le corps ait
 * été écrit. Le dialogue SMTP est strictement synchrone (aucune extension de pipelining n'est utilisée) :
 * tout octet arrivé que le client n'a pas sollicité est une violation de protocole. `assertNoUnsolicited`
 * est appelé AVANT chaque écriture (commande ou corps) ; une réponse ne peut donc JAMAIS précéder ce
 * qu'elle acquitte.
 *
 * R5 (contre-audit de 2431eba, A196-R2-SMTP-01) : une réponse n'est pas seulement « complète », elle doit être VALIDE.
 * `takeReply` applique la grammaire de la RFC 5321 §4.2 à CHAQUE ligne (code [2-5][0-5][0-9], puis « - », « SP texte »
 * ou rien), exige le MÊME code sur toutes les lignes, une dernière ligne finale, et aucun caractère de contrôle ; sinon
 * SMTP_MALFORMED_RESPONSE (temporaire). L'ancien lecteur clôturait la réponse sur n'importe quelle ligne qui n'était pas
 * « NNN- » (ligne vide, texte libre, « 550 … ») et `expectCode` ne lisait que le préfixe de la première ligne : « 250- »
 * suivi de « 550 EHLO refused » passait pour un 250. La borne de taille s'applique à la réponse COMPLÈTE.
 */
class SmtpReplyReader {
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private pending: PendingRead | null = null;
  private failure: ReaderFailure | null = null;
  private readonly socket: TLSSocket;
  private readonly stepTimeoutMs: number;
  private readonly onData: (chunk: Buffer | string) => void;
  private readonly onError: (err: unknown) => void;
  private readonly onClose: () => void;

  constructor(socket: TLSSocket, stepTimeoutMs: number) {
    this.socket = socket;
    this.stepTimeoutMs = stepTimeoutMs;
    this.onData = (chunk) => {
      this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
      if (this.pending && this.settleFromBuffer()) return;
      if (this.buffer.length > MAX_REPLY_CHARS) this.fail({ kind: "overflow" });
    };
    this.onError = (err) => this.fail({ kind: "error", error: err });
    this.onClose = () => this.fail({ kind: "closed" });
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
    socket.on("end", this.onClose);
  }

  /** Lit la prochaine réponse COMPLÈTE, bornée par le délai d'étape. */
  read(stage: SmtpFailureStage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const ready = this.takeReply();
      if (ready !== null) {
        if (ready.kind === "reply") {
          resolve(ready.text);
        } else {
          this.failure ??= ready;
          reject(this.errorFor(ready, stage));
        }
        return;
      }
      if (this.failure) {
        reject(this.errorFor(this.failure, stage));
        return;
      }
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error("SMTP_TIMEOUT"));
      }, this.stepTimeoutMs);
      this.pending = { resolve, reject, timer, stage };
    });
  }

  /**
   * À appeler avant d'écrire une commande ou le corps du message : le tampon ne doit contenir AUCUN octet
   * (hors sauts de ligne parasites, toujours tolérés) -- la réponse précédente a été consommée en entier et
   * le serveur n'a, à ce stade, rien à dire de plus.
   */
  assertNoUnsolicited(stage: SmtpFailureStage): void {
    if (/[^\r\n]/.test(this.buffer)) throw new SmtpSessionError("SMTP_UNSOLICITED_RESPONSE", stage);
  }

  /** Fin de session : plus d'abonnement aux données, mais un écouteur d'erreur reste (jamais d'exception non interceptée). */
  dispose(): void {
    this.socket.off("data", this.onData);
    this.socket.off("close", this.onClose);
    this.socket.off("end", this.onClose);
    this.socket.off("error", this.onError);
    this.socket.on("error", () => undefined);
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new SmtpSessionError("SMTP_SESSION_TIMEOUT", "timeout"));
    }
  }

  private settleFromBuffer(): boolean {
    const pending = this.pending;
    if (!pending) return false;
    const taken = this.takeReply();
    if (taken === null) return false;
    clearTimeout(pending.timer);
    this.pending = null;
    if (taken.kind === "reply") {
      pending.resolve(taken.text);
    } else {
      this.failure ??= taken;
      pending.reject(this.errorFor(taken, pending.stage));
    }
    return true;
  }

  private fail(failure: ReaderFailure): void {
    // Une réponse déjà COMPLÈTE dans le tampon reste lisible ; l'échec ne s'applique qu'à la suivante.
    if (!this.failure) this.failure = failure;
    const pending = this.pending;
    if (!pending) return;
    if (this.settleFromBuffer()) return;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.reject(this.errorFor(failure, pending.stage));
  }

  private errorFor(failure: ReaderFailure, stage: SmtpFailureStage): unknown {
    if (failure.kind === "error") return failure.error;
    if (failure.kind === "overflow") return new SmtpSessionError("SMTP_REPLY_TOO_LARGE", stage);
    if (failure.kind === "malformed") return new SmtpSessionError(`SMTP_MALFORMED_RESPONSE: ${failure.reason}`, stage);
    return new SmtpSessionError("SMTP_CONNECTION_CLOSED", "connect", null, "ECONNRESET");
  }

  /**
   * Extrait du tampon la prochaine réponse VALIDE et complète, ou null s'il en manque la fin. Dès qu'une ligne COMPLÈTE
   * viole la grammaire, la violation est rendue sans attendre la suite (jamais de succès d'étape sur une réponse invalide).
   * Ce qui suit la ligne finale reste dans le tampon : c'est un octet non sollicité (`assertNoUnsolicited`).
   */
  private takeReply(): TakenReply | null {
    let offset = 0;
    const lines: string[] = [];
    let code: string | null = null;
    for (;;) {
      const lf = this.buffer.indexOf("\n", offset);
      if (lf === -1) return null;
      const line = this.buffer.slice(offset, lf).replace(/\r$/, "");
      offset = lf + 1;
      // R5 (P3) : la borne s'applique à la réponse COMPLÈTE (tous séparateurs compris), contrôlée AVANT l'extraction.
      if (offset > MAX_REPLY_CHARS) return { kind: "overflow" };
      if (line === "" && lines.length === 0) continue; // reste de saut de ligne AVANT une réponse : ignoré, jamais une réponse
      const match = REPLY_LINE.exec(line);
      if (!match) return { kind: "malformed", reason: "line_syntax" };
      if (code !== null && match[1] !== code) return { kind: "malformed", reason: "code_mismatch" };
      if (REPLY_CONTROL_CHARS.test(match[3] ?? "")) return { kind: "malformed", reason: "control_character" };
      code = match[1]!;
      lines.push(line);
      if (match[2] !== "-") {
        this.buffer = this.buffer.slice(offset);
        return { kind: "reply", text: lines.join(CRLF) };
      }
    }
  }
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

/**
 * Ce que le corps d'une session peut faire : UN échange = écrire une commande (ou le corps du message), puis lire SA
 * réponse complète. Un échange échoue (SMTP_UNSOLICITED_RESPONSE) si le serveur a envoyé quoi que ce soit que le
 * client n'avait pas sollicité avant l'écriture (R3).
 */
interface SmtpDialogue {
  exchange(stage: SmtpFailureStage, payload: string): Promise<string>;
}

async function withSmtpSession<T>(
  io: SmtpIo,
  limits: SmtpLimits,
  config: SmtpConfig,
  body: (session: SmtpDialogue) => Promise<T>
): Promise<T> {
  const held: { socket: TLSSocket | null; reader: SmtpReplyReader | null } = { socket: null, reader: null };
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
    const connected = await new Promise<{ socket: TLSSocket; reader: SmtpReplyReader }>((resolve, reject) => {
      const s = io.connect({ host: address, servername: config.host, port: config.port, timeout: limits.stepTimeoutMs }, () => {
        s.off("timeout", onTimeout);
        s.setTimeout(0);
        // Le lecteur s'abonne DÈS la connexion : aucune octet de la bannière ne peut être perdu.
        resolve({ socket: s, reader: new SmtpReplyReader(s, limits.stepTimeoutMs) });
      });
      const onTimeout = () => {
        s.destroy();
        reject(new SmtpSessionError("SMTP_TIMEOUT", "timeout"));
      };
      s.once("timeout", onTimeout);
      s.once("error", (err) => reject(new SmtpSessionError(err instanceof Error ? err.message : "SMTP_CONNECT_FAILED", "connect", null, nodeCodeOf(err))));
    });
    const { socket, reader } = connected;
    held.socket = socket;
    held.reader = reader;
    if (state.aborted) {
      reader.dispose();
      socket.destroy();
      throw abortedError();
    }

    // Un seul chemin d'écriture : vérification « rien de non sollicité », écriture, lecture de SA réponse.
    const exchange = (stage: SmtpFailureStage, payload: string): Promise<string> => {
      try {
        reader.assertNoUnsolicited(stage);
      } catch (err) {
        return Promise.reject(err);
      }
      socket.write(payload);
      return reader.read(stage);
    };

    const greeting = await reader.read("greeting");
    expectCode(greeting, "220", "greeting");

    const ehloResp = await exchange("ehlo", `EHLO scanym.com${CRLF}`);
    expectCode(ehloResp, "250", "ehlo");

    const authResp = await exchange("auth", `AUTH LOGIN${CRLF}`);
    expectCode(authResp, "334", "auth");

    const userResp = await exchange("auth", `${Buffer.from(config.user, "utf8").toString("base64")}${CRLF}`);
    expectCode(userResp, "334", "auth");

    const passResp = await exchange("auth", `${Buffer.from(config.password, "utf8").toString("base64")}${CRLF}`);
    expectCode(passResp, "235", "auth");

    return await body({ exchange });
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
      held.reader?.dispose();
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
        const messageId = await withSmtpSession(io, limits, input.config, async ({ exchange }) => {
          expectCode(await exchange("mail_from", `MAIL FROM:<${input.config.from}>${CRLF}`), "250", "mail_from");

          expectCode(await exchange("rcpt_to", `RCPT TO:<${input.to}>${CRLF}`), "250", "rcpt_to");

          if (input.cc) {
            expectCode(await exchange("rcpt_to", `RCPT TO:<${input.cc}>${CRLF}`), "250", "rcpt_to");
          }

          expectCode(await exchange("data", `DATA${CRLF}`), "354", "data");

          // Le corps n'est écrit que si le serveur n'a rien dit de plus que « 354 » (assertNoUnsolicited), et la réponse
          // finale lue est celle qui SUIT cette écriture : jamais une réponse arrivée avant le corps (R3).
          const message = escapeDotStuffing(buildSmtpMimeMessage(input));
          const dataResp = await exchange("data_end", `${message}${CRLF}.${CRLF}`);
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
