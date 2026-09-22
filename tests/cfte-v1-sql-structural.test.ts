import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 — preuves STRUCTURELLES sur le
 * texte de migration (même technique que
 * tests/v1-n1a-structural-atomic-integration.test.ts).
 *
 * Ce que ce fichier PROUVE, et qui ne peut pas l'être par un test
 * applicatif :
 *
 *   1. GARDE DE NON-RÉGRESSION DE L'ENFILEMENT order_received.
 *      Le lot redéfinit create_order. La régression réellement vécue le
 *      16/09/2026 (voir DRAFT-lot-order-received-enqueue-recovery-v1.sql)
 *      est exactement celle-là : une redéfinition de create_order a fait
 *      disparaître l'enfilement, silencieusement. Depuis ORDER SUCCESS
 *      BOUNDARY v1 l'enfilement ne vit PLUS dans create_order mais dans
 *      le marqueur d'intention durable posé par
 *      `orders_record_order_received_intent_trg`. Ce lot doit donc :
 *        - REFUSER de s'appliquer si ce déclencheur/cette colonne ont
 *          disparu (pré-vol) ;
 *        - ne JAMAIS réintroduire l'appel dans create_order (post-vol) ;
 *        - ne JAMAIS supprimer le déclencheur ni la fonction d'enfilement.
 *
 *   2. CHANGEMENT MINIMAL EXACT de create_order : AUCUNE ligne de code
 *      du corps précédent (CGV ENGINE v2.5, dernière définition
 *      appliquée) n'a disparu -- comparaison ligne à ligne, multiset,
 *      jamais une relecture humaine.
 *
 *   3. PRÉCÉDENCE E-MAIL non relaxable et ABSENCE de toute colonne
 *      prénom/nom ajoutée à public.orders.
 *
 *   4. Confinement des droits (aucune écriture directe, aucune lecture
 *      anon de la configuration marchande).
 */

const SQL_URL = new URL(
  "../supabase/DRAFT-lot-customer-followup-tracking-email-v1.sql",
  import.meta.url
);
const forwardSql = readFileSync(SQL_URL, "utf8");
const rollbackSql = readFileSync(
  new URL("../supabase/DRAFT-lot-customer-followup-tracking-email-v1-rollback.sql", import.meta.url),
  "utf8"
);
const cgvV25Sql = readFileSync(
  new URL("../supabase/DRAFT-lot-seller-legal-profile-cgv-engine-v2-5.sql", import.meta.url),
  "utf8"
);
const successBoundarySql = readFileSync(
  new URL("../supabase/migration-20260919000000-order-success-boundary-v1.sql", import.meta.url),
  "utf8"
);

/** Corps de create_order tel qu'écrit dans un fichier de migration. */
function extractCreateOrderBody(sql: string): string {
  const start = sql.indexOf("create or replace function public.create_order(");
  assert.ok(start > -1, "définition de create_order introuvable");
  const end = sql.indexOf("revoke all on function public.create_order(", start);
  assert.ok(end > start, "fin de la définition de create_order introuvable");
  return sql.slice(start, end);
}

/** Lignes de CODE uniquement : sans lignes vides ni commentaires SQL. */
function codeLines(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("--"));
}

function multiset(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

// ====================================================================
// 1. Frontière de succès de commande / enfilement order_received.
// ====================================================================

test("1a. le corps de create_order n'appelle JAMAIS l'enfilement (ORDER SUCCESS BOUNDARY v1 préservée)", () => {
  const body = extractCreateOrderBody(forwardSql);
  assert.equal(
    body.includes("create_order_received_notification"),
    false,
    "create_order ne doit pas enfiler directement : l'intention durable est posée par le déclencheur"
  );
  // Et le prédécesseur lui-même l'interdisait déjà -- on vérifie qu'on
  // parle bien de la MÊME garantie, pas d'une invention de ce lot.
  assert.match(successBoundarySql, /create_order still directly invokes notification enqueue/);
});

test("1b. le PRÉ-VOL refuse de s'appliquer si le déclencheur d'intention ou sa colonne ont disparu", () => {
  assert.match(forwardSql, /order_received_notification_intent_at/);
  assert.match(forwardSql, /orders_record_order_received_intent_trg/);
  // Les deux gardes doivent lever, pas simplement journaliser.
  const preflight = forwardSql.slice(0, forwardSql.indexOf("\nbegin;"));
  assert.match(preflight, /order_received_notification_intent_at[\s\S]*?raise exception/);
  assert.match(preflight, /orders_record_order_received_intent_trg[\s\S]*?raise exception/);
});

test("1c. le POST-VOL revérifie l'absence d'appel dans create_order ET la présence du déclencheur", () => {
  const postflight = forwardSql.slice(forwardSql.lastIndexOf("commit;"));
  assert.match(postflight, /create_order_received_notification%[\s\S]*?raise exception/);
  assert.match(postflight, /orders_record_order_received_intent_trg[\s\S]*?raise exception/);
});

test("1d. le lot ne supprime JAMAIS le déclencheur, sa fonction, ni la fonction d'enfilement", () => {
  for (const forbidden of [
    /drop\s+trigger[^;]*orders_record_order_received_intent_trg/i,
    /drop\s+function[^;]*tg_orders_record_order_received_intent/i,
    /drop\s+function[^;]*create_order_received_notification/i,
    /drop\s+table[^;]*notification_outbox/i,
  ]) {
    assert.doesNotMatch(forwardSql, forbidden);
    assert.doesNotMatch(rollbackSql, forbidden);
  }
});

test("1e. create_order ne fait aucun appel réseau/HTTP (l'e-mail n'est jamais envoyé dans la transaction de commande)", () => {
  const body = extractCreateOrderBody(forwardSql);
  assert.doesNotMatch(body, /fetch\(/i);
  assert.doesNotMatch(body, /http_post|net\.http|pg_net/i);
  assert.doesNotMatch(body, /send_email|smtp/i);
});

// ====================================================================
// 2. Changement MINIMAL EXACT de create_order.
// ====================================================================

test("2a. aucune ligne de code du corps CGV v2.5 n'a disparu de create_order", () => {
  const oldCounts = multiset(codeLines(extractCreateOrderBody(cgvV25Sql)));
  const newCounts = multiset(codeLines(extractCreateOrderBody(forwardSql)));

  const missing: string[] = [];
  for (const [line, count] of oldCounts) {
    if ((newCounts.get(line) ?? 0) < count) missing.push(line);
  }
  assert.deepEqual(
    missing,
    [],
    `lignes du corps précédent perdues par la redéfinition :\n${missing.join("\n")}`
  );
});

test("2b. les lignes AJOUTÉES sont peu nombreuses et toutes attribuables à ce lot", () => {
  const oldCounts = multiset(codeLines(extractCreateOrderBody(cgvV25Sql)));
  const newLines = codeLines(extractCreateOrderBody(forwardSql));

  const remaining = new Map(oldCounts);
  const added: string[] = [];
  for (const line of newLines) {
    const left = remaining.get(line) ?? 0;
    if (left > 0) remaining.set(line, left - 1);
    else added.push(line);
  }

  const ALLOWED = /first_name|last_name|v_tracked|SCANYM_CUSTOMER_|customer_tracked_service_modes|v_name :=|^if |^end if;$/;
  for (const line of added) {
    assert.match(line, ALLOWED, `ligne ajoutée hors périmètre de ce lot : ${line}`);
  }
  // 22 lignes attendues (3 déclarations, 2 extractions, la composition
  // du nom et son `if`/`end if`, la garde des modes suivis, et les 2
  // entrées de correspondance champ -> valeur). La borne laisse une
  // marge de 2 lignes, pas davantage : un futur élargissement du corps
  // devra être justifié explicitement plutôt que passer inaperçu.
  assert.ok(
    added.length <= 24,
    `changement non minimal : ${added.length} lignes ajoutées\n${added.join("\n")}`
  );
});

test("2c. la signature et le type de retour de create_order sont INCHANGÉS", () => {
  assert.match(
    forwardSql,
    /returns table \(order_id uuid, order_number bigint, public_token uuid, subtotal numeric, delivery_fee numeric, total numeric\)/
  );
  for (const role of ["anon", "authenticated"]) {
    assert.ok(
      forwardSql.includes(
        `grant execute on function public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean) to ${role};`
      ),
      `${role} doit conserver EXECUTE sur create_order`
    );
  }
});

// ====================================================================
// 3. Précédence e-mail / prénom / nom.
// ====================================================================

test("3a. l'e-mail est forcé `required` pour les modes suivis, à la RÉSOLUTION (jamais par mutation de données)", () => {
  assert.match(forwardSql, /when t\.is_tracked and c\.field = 'email' then 'required'/);
  // Aucune écriture dans les tables de configuration tenant/catalogue.
  for (const forbidden of [
    /update\s+public\.restaurant_sale_mode_field_requirements/i,
    /insert\s+into\s+public\.restaurant_sale_mode_field_requirements/i,
    /delete\s+from\s+public\.restaurant_sale_mode_field_requirements/i,
    /update\s+public\.sale_mode_field_requirements/i,
    /insert\s+into\s+public\.sale_mode_field_requirements/i,
    /delete\s+from\s+public\.sale_mode_field_requirements/i,
  ]) {
    assert.doesNotMatch(forwardSql, forbidden, "aucune ligne tenant/catalogue ne doit être mutée");
  }
});

test("3b. create_order applique AUSSI la précédence, indépendamment du résolveur (défense en profondeur)", () => {
  const body = extractCreateOrderBody(forwardSql);
  assert.match(body, /v_tracked := p_service_mode = any \(public\.customer_tracked_service_modes\(\)\);/);
  assert.match(body, /SCANYM_CUSTOMER_EMAIL_REQUIRED/);
  assert.match(body, /SCANYM_CUSTOMER_FIRST_NAME_REQUIRED/);
  assert.match(body, /SCANYM_CUSTOMER_LAST_NAME_REQUIRED/);
});

test("3c. les modes suivis sont déclarés UNE SEULE FOIS (pickup, delivery) et jamais recopiés en dur", () => {
  assert.match(forwardSql, /select array\['pickup', 'delivery'\]::text\[\];/);
  const literalLists = forwardSql.match(/array\['pickup'/g) ?? [];
  assert.equal(literalLists.length, 1, "la liste des modes suivis ne doit exister qu'à un seul endroit");
});

test("3d. le nom de famille est required en delivery, optional en retrait", () => {
  assert.match(
    forwardSql,
    /select 'last_name',\s*\n\s*case when p_mode_code = 'delivery' then 'required' else 'optional' end/
  );
  assert.match(forwardSql, /select 'first_name', 'required', null/);
});

test("3e. AUCUNE colonne prénom/nom n'est ajoutée à public.orders", () => {
  assert.doesNotMatch(forwardSql, /alter table public\.orders[\s\S]{0,200}add column[\s\S]{0,80}(first_name|last_name)/i);
  // Le post-vol l'interdit explicitement, pour toute application future.
  assert.match(forwardSql, /une colonne prénom\/nom a été ajoutée à public\.orders/);
});

test("3f. le nom d'affichage est COMPOSÉ côté serveur et persisté dans la colonne EXISTANTE customer_name", () => {
  const body = extractCreateOrderBody(forwardSql);
  assert.match(body, /v_name := nullif\(left\(btrim\(concat_ws\(' ', v_first_name, v_last_name\)\), 120\), ''\);/);
  // La colonne alimentée reste customer_name, à la même position.
  assert.match(body, /customer_name, customer_phone, customer_email,/);
});

// ====================================================================
// 4. Surcharge de texte marchande : affichage SEUL, droits confinés.
// ====================================================================

test("4a. la table n'accepte QUE les 7 statuts canoniques", () => {
  assert.match(
    forwardSql,
    /check \(status in \('new', 'accepted', 'preparing', 'ready', 'completed', 'rejected', 'cancelled'\)\)/
  );
});

test("4b. la borne de longueur SQL correspond EXACTEMENT à la constante applicative", async () => {
  const { MERCHANT_STATUS_TEXT_MAX_LENGTH } = await import("../lib/tracking/status-text.ts");
  assert.match(
    forwardSql,
    new RegExp(
      `constraint merchant_tracking_status_text_body_length[\\s\\S]{0,160}<= ${MERCHANT_STATUS_TEXT_MAX_LENGTH}`
    )
  );
});

test("4c. aucune écriture directe ni lecture anon de la configuration marchande", () => {
  assert.match(forwardSql, /alter table public\.merchant_tracking_status_text enable row level security;/);
  assert.match(
    forwardSql,
    /revoke all on public\.merchant_tracking_status_text from public, anon, authenticated;/
  );
  assert.match(forwardSql, /grant select on public\.merchant_tracking_status_text to authenticated;/);
  assert.doesNotMatch(
    forwardSql,
    /grant\s+(insert|update|delete)\s+on\s+(table\s+)?public\.merchant_tracking_status_text/i
  );
  assert.doesNotMatch(
    forwardSql,
    /grant\s+select\s+on\s+(table\s+)?public\.merchant_tracking_status_text[^;]*anon/i
  );
});

test("4d. l'écriture est réservée owner/manager et refuse tout statut non canonique", () => {
  const start = forwardSql.indexOf("create function public.set_merchant_tracking_status_text(");
  const end = forwardSql.indexOf("comment on function public.set_merchant_tracking_status_text");
  const fn = forwardSql.slice(start, end);
  assert.match(fn, /array\['owner', 'manager'\]/);
  assert.match(fn, /SCANYM_UNKNOWN_ORDER_STATUS/);
  assert.match(fn, /Authentication required/);
  // Corps vide -> suppression de la ligne (repli base), jamais un texte vide.
  assert.match(fn, /delete from public\.merchant_tracking_status_text/);
});

test("4e. AUCUNE fonction de ce lot n'écrit dans public.orders (le moteur d'état reste intouché)", () => {
  for (const fnName of [
    "set_merchant_tracking_status_text",
    "get_order_tracking_status_text_by_capability",
    "customer_tracked_service_modes",
  ]) {
    const start = forwardSql.indexOf(`function public.${fnName}(`);
    assert.ok(start > -1, `${fnName} introuvable`);
    const end = forwardSql.indexOf("comment on function", start);
    const fn = forwardSql.slice(start, end > start ? end : start + 4000);
    assert.doesNotMatch(fn, /(update|insert into|delete from)\s+public\.orders/i);
  }
  // Et le post-vol le revérifie sur la définition réellement installée.
  assert.match(forwardSql, /une fonction de texte de statut écrit dans public\.orders/);
});

test("4f. la lecture client réutilise le prédicat de capacité v3.1 EXACT (copié, jamais affaibli)", () => {
  const cclt = readFileSync(
    new URL("../supabase/DRAFT-lot-customer-contact-live-tracking-v1.sql", import.meta.url),
    "utf8"
  );
  // Les quatre clauses qui CONSTITUENT la preuve de possession.
  const PREDICATE = [
    "c.secret_hash is not null",
    "(c.expires_at is null or c.expires_at > pg_catalog.now())",
    "pg_catalog.length(p_secret) = 64",
    "c.secret_hash = pg_catalog.sha256(pg_catalog.convert_to(p_secret, 'UTF8'))",
  ];
  for (const clause of PREDICATE) {
    assert.ok(cclt.includes(clause), `clause absente de la référence v3.1 : ${clause}`);
    assert.ok(forwardSql.includes(clause), `clause absente de la nouvelle RPC : ${clause}`);
  }
  assert.match(
    forwardSql,
    /grant execute on function public\.get_order_tracking_status_text_by_capability\(uuid, uuid, text\) to anon, authenticated;/
  );
});

// ====================================================================
// 5. Snapshot de l'e-mail de confirmation.
// ====================================================================

test("5a. le payload_snapshot gagne 4 clés ADDITIVES, aucune clé existante n'est retirée", () => {
  const start = forwardSql.indexOf("create or replace function public.create_order_received_notification(");
  const end = forwardSql.indexOf("comment on function public.create_order_received_notification", start);
  const fn = forwardSql.slice(start, end);

  for (const legacyKey of [
    "'order_number', v_order.order_number",
    "'total', v_order.total",
    "'currency', v_order.currency",
    "'service_mode', v_order.service_mode",
    "'public_token', v_order.public_token",
    "'created_at', v_order.created_at",
  ]) {
    assert.ok(fn.includes(legacyKey), `clé historique perdue : ${legacyKey}`);
  }
  for (const newKey of [
    "'order_status', v_order.status",
    "'status_text_override', v_status_override",
    "'delivery_address'",
    "'merchant_name', v_merchant_name",
  ]) {
    assert.ok(fn.includes(newKey), `clé CFTE v1 absente : ${newKey}`);
  }

  // Idempotence et garde tenant strictement préservées.
  assert.match(fn, /on conflict \(restaurant_id, order_id, notification_type\) do nothing/);
  assert.match(fn, /SCANYM_NOTIFICATION_TENANT_MISMATCH/);
  // L'adresse n'est jamais exposée hors livraison.
  assert.match(fn, /case when v_order\.service_mode = 'delivery' then v_order\.delivery_address else null end/);
});

test("5b. aucun secret prestataire ni jeton n'apparaît dans la migration", () => {
  assert.doesNotMatch(forwardSql, /resend|postmark|sendgrid/i);
  assert.doesNotMatch(forwardSql, /api[_-]?key/i);
  assert.doesNotMatch(forwardSql, /service_role_key|anon_key/i);
});

// ====================================================================
// 6. Rollback réellement inverse.
// ====================================================================

test("6. le rollback restaure les trois fonctions redéfinies et supprime les objets créés", () => {
  for (const restored of [
    "create or replace function public.effective_sale_mode_field_requirements(",
    "create or replace function public.create_order_received_notification(",
    "create or replace function public.create_order(",
  ]) {
    assert.ok(rollbackSql.includes(restored), `rollback incomplet : ${restored}`);
  }
  for (const dropped of [
    "drop function if exists public.get_order_tracking_status_text_by_capability(uuid, uuid, text);",
    "drop function if exists public.set_merchant_tracking_status_text(uuid, text, text);",
    "drop table if exists public.merchant_tracking_status_text;",
    "drop function if exists public.customer_tracked_service_modes();",
  ]) {
    assert.ok(rollbackSql.includes(dropped), `rollback incomplet : ${dropped}`);
  }
  // Le create_order restauré doit être EXACTEMENT celui de CGV v2.5.
  const restoredCounts = multiset(codeLines(extractCreateOrderBody(rollbackSql)));
  const baselineCounts = multiset(codeLines(extractCreateOrderBody(cgvV25Sql)));
  assert.deepEqual(
    [...baselineCounts].filter(([line, n]) => (restoredCounts.get(line) ?? 0) < n).map(([l]) => l),
    [],
    "le rollback ne restaure pas fidèlement le corps CGV v2.5"
  );
  assert.equal(
    extractCreateOrderBody(rollbackSql).includes("first_name"),
    false,
    "le create_order restauré ne doit plus porter de code CFTE v1"
  );
});
