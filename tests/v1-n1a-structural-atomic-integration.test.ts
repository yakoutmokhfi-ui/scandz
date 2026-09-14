import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// N1-A — preuve structurelle (inspection de source, même technique que
// l'item 13 de tests/v167-tracking-final-payment-return-language.
// test.ts) que :
//   (a) l'insertion de l'événement ORDER_RECEIVED se fait DANS create_
//       order lui-même, dans la MÊME transaction PL/pgSQL, APRÈS la
//       mise à jour finale de orders (total/delivery_fee arrêtés) et
//       AVANT le `return query` -- jamais avant, jamais dans un chemin
//       séparé/asynchrone.
//   (b) create_order ne fait JAMAIS d'appel réseau/HTTP (aucun envoi
//       d'e-mail dans le chemin de la requête de création de commande,
//       mandat §"ARCHITECTURE").
//   (c) la table/les fonctions worker (notification_outbox,
//       claim_pending_notifications, complete_notification_attempt)
//       n'ont AUCUN grant EXECUTE/SELECT accordé à anon/authenticated
//       dans le fichier de migration lui-même (double preuve texte, en
//       plus du postcheck SQL live -- voir sql-harness/).
// ====================================================================

const forwardSql = readFileSync(
  new URL("../supabase/DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql", import.meta.url),
  "utf8"
);

test("(a) create_order_received_notification est appelée APRÈS la mise à jour finale de orders et AVANT return query", () => {
  const updateIdx = forwardSql.lastIndexOf("set subtotal = v_subtotal,");
  const performIdx = forwardSql.indexOf("perform public.create_order_received_notification(v_order_id, v_restaurant.id);");
  const returnIdx = forwardSql.lastIndexOf("return query select v_order_id, v_number, v_token, v_subtotal, v_delivery_fee, v_subtotal + v_delivery_fee;");

  assert.ok(updateIdx > -1, "mise à jour finale de orders introuvable");
  assert.ok(performIdx > -1, "appel à create_order_received_notification introuvable dans create_order");
  assert.ok(returnIdx > -1, "return query introuvable");
  assert.ok(performIdx > updateIdx, "l'appel outbox doit survenir APRÈS la mise à jour finale de orders");
  assert.ok(performIdx < returnIdx, "l'appel outbox doit survenir AVANT return query");
});

test("(a) un seul appel RÉEL (hors commentaire) à create_order_received_notification existe dans tout le fichier (pas de duplication)", () => {
  // Le commentaire d'en-tête du fichier MENTIONNE la ligne ajoutée en
  // prose (pour l'audit) -- seul un appel PL/pgSQL réel (préfixé
  // `perform `, en dehors d'une ligne de commentaire SQL `--`) compte
  // ici.
  const codeOnly = forwardSql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const matches = codeOnly.match(/perform public\.create_order_received_notification/g) ?? [];
  assert.equal(matches.length, 1);
});

test("(b) create_order ne contient aucun appel réseau/HTTP -- l'e-mail n'est JAMAIS envoyé dans le chemin de création de commande", () => {
  const createOrderStart = forwardSql.indexOf("create or replace function public.create_order(");
  const createOrderEnd = forwardSql.indexOf("revoke all on function public.create_order(", createOrderStart);
  const body = forwardSql.slice(createOrderStart, createOrderEnd);

  assert.doesNotMatch(body, /fetch\(/i);
  assert.doesNotMatch(body, /http_post|net\.http|pg_net/i);
  assert.doesNotMatch(body, /send_email|smtp/i);
});

test("(c) notification_outbox / claim_pending_notifications / complete_notification_attempt n'accordent jamais EXECUTE/SELECT à anon ou authenticated dans le texte de migration", () => {
  const dangerousGrantPatterns = [
    /grant\s+(select|execute)\s+on\s+(table\s+)?public\.notification_outbox[^;]*to\s+(anon|authenticated)/i,
    /grant\s+(select|execute)\s+on\s+(table\s+)?public\.notification_delivery_attempt[^;]*to\s+(anon|authenticated)/i,
    /grant\s+execute\s+on\s+function\s+public\.claim_pending_notifications[^;]*to\s+(anon|authenticated)/i,
    /grant\s+execute\s+on\s+function\s+public\.complete_notification_attempt[^;]*to\s+(anon|authenticated)/i,
  ];
  for (const pattern of dangerousGrantPatterns) {
    assert.doesNotMatch(forwardSql, pattern);
  }
});

test("merchant_notification_profile n'accorde jamais INSERT/UPDATE direct à authenticated (écriture RPC-only)", () => {
  assert.doesNotMatch(
    forwardSql,
    /grant\s+(insert|update)\s+on\s+(table\s+)?public\.merchant_notification_profile[^;]*to\s+authenticated/i
  );
});

test("aucun secret prestataire (clé API, identifiant Resend/Postmark/SendGrid) n'apparaît dans la migration", () => {
  assert.doesNotMatch(forwardSql, /resend|postmark|sendgrid/i);
  assert.doesNotMatch(forwardSql, /api[_-]?key/i);
});
