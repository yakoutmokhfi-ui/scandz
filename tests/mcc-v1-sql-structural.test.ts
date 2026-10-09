import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

import {
  COMMUNICATION_TEXT_KEYS,
  COMMUNICATION_SUBJECT_MAX_LENGTH,
  COMMUNICATION_TEXT_MAX_LENGTH,
  PUBLIC_COMMUNICATION_TEXT_KEYS,
} from "../lib/communications/text-keys.ts";
import { COMMUNICATION_TEMPLATE_VARIABLES } from "../lib/communications/template-variables.ts";
import {
  COMMUNICATION_EVENT_CODES,
  COMMUNICATION_EVENT_BODY_TEXT_KEY,
} from "../lib/communications/events.ts";

/**
 * Scanym — MERCHANT CUSTOMER COMMUNICATIONS v1 — garde STRUCTURELLE.
 *
 * Ce fichier ne teste pas un comportement : il vérifie que deux
 * AUTORITÉS qui doivent dire la même chose la disent effectivement, et
 * que les engagements du mandat qu'on ne peut prouver qu'en lisant le
 * code sont tenus.
 *
 * Il existe parce que la dérive entre un catalogue SQL et son miroir
 * TypeScript est silencieuse : rien ne casse, un texte cesse simplement
 * d'être configurable, ou une variable cesse d'être refusée. Mieux vaut
 * un test qui compare les deux listes caractère par caractère qu'une
 * relecture attentive.
 */

const SQL_PATH = "supabase/DRAFT-lot-merchant-customer-communications-v1.sql";
const ROLLBACK_PATH = "supabase/DRAFT-lot-merchant-customer-communications-v1-rollback.sql";
const HARNESS_PATH = "supabase/tests/merchant-customer-communications-v1-check.sh";
const SAFETY_PATH =
  "supabase/tests/merchant-customer-communications-v1-harness-safety-check.sh";

const sql = readFileSync(SQL_PATH, "utf8");
const rollback = readFileSync(ROLLBACK_PATH, "utf8");

/** Code SQL EXÉCUTABLE seul : les commentaires `--` sont retirés. La
 *  documentation peut légitimement nommer ce que le code ne doit pas
 *  faire ; les confondre produit des faux positifs (leçon du garde
 *  NO-HARDCODE du lot précédent). */
function executableSql(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i < 0 ? line : line.slice(0, i);
    })
    .join("\n");
}
const execSql = executableSql(sql);

/** Les littéraux d'un tableau SQL `array[ 'a', 'b' ]` nommé par une
 *  fonction de catalogue, dans l'ordre du fichier. */
function sqlArrayLiterals(functionName: string): string[] {
  const start = execSql.indexOf(`create function public.${functionName}()`);
  assert.ok(start > 0, `${functionName}() doit être déclarée dans le SQL`);
  const body = execSql.slice(start, execSql.indexOf("$$;", start));
  const open = body.indexOf("array[");
  assert.ok(open > 0, `${functionName}() doit renvoyer un array[...] littéral`);
  const close = body.indexOf("]", open);
  return [...body.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------
// MIROIRS SQL <-> TypeScript.
// ---------------------------------------------------------------------

test("[MIRROR-1] communication_text_keys() est le MIROIR EXACT de COMMUNICATION_TEXT_KEYS", () => {
  assert.deepEqual(sqlArrayLiterals("communication_text_keys"), [...COMMUNICATION_TEXT_KEYS]);
});

test("[MIRROR-2] public_communication_text_keys() est le MIROIR EXACT de PUBLIC_COMMUNICATION_TEXT_KEYS", () => {
  assert.deepEqual(
    sqlArrayLiterals("public_communication_text_keys"),
    [...PUBLIC_COMMUNICATION_TEXT_KEYS]
  );
});

test("[MIRROR-3] communication_template_variables() est le MIROIR EXACT de la liste blanche TS", () => {
  assert.deepEqual(
    sqlArrayLiterals("communication_template_variables"),
    [...COMMUNICATION_TEMPLATE_VARIABLES]
  );
});

test("[MIRROR-4] communication_event_codes() est le MIROIR EXACT de COMMUNICATION_EVENT_CODES", () => {
  assert.deepEqual(sqlArrayLiterals("communication_event_codes"), [...COMMUNICATION_EVENT_CODES]);
});

test("[MIRROR-5] les bornes de longueur SQL et TS coïncident", () => {
  assert.ok(
    execSql.includes(
      `select case when p_text_key = 'email_confirmation_subject' then ${COMMUNICATION_SUBJECT_MAX_LENGTH} else ${COMMUNICATION_TEXT_MAX_LENGTH} end`
    ),
    "communication_text_max_length() doit porter exactement les deux bornes TS"
  );
  assert.ok(
    execSql.includes(`pg_catalog.length(pg_catalog.btrim(body)) <= ${COMMUNICATION_TEXT_MAX_LENGTH}`),
    "la contrainte de table doit porter la borne générale TS"
  );
});

test("[MIRROR-6] la classe de caractères des emplacements est la MÊME des deux côtés", () => {
  // SQL : '\{([a-z0-9_]+)\}' ; TS : /\{([a-z0-9_]+)\}/g.
  assert.ok(
    execSql.includes("'\\{([a-z0-9_]+)\\}'"),
    "le SQL doit employer la même classe de caractères que PLACEHOLDER_PATTERN"
  );
  const tsSource = readFileSync("lib/communications/template-variables.ts", "utf8");
  assert.ok(tsSource.includes("/\\{([a-z0-9_]+)\\}/g"));
});

test("[MIRROR-7] communication_event_body_text_key() est le MIROIR EXACT de COMMUNICATION_EVENT_BODY_TEXT_KEY", () => {
  // Ferme MCC-V1-WITHDRAWAL-TEMPLATE-UNUSED-01 : deux autorités qui
  // divergeraient feraient à nouveau d'un gabarit configuré un gabarit
  // mort, en silence.
  const start = execSql.indexOf("create function public.communication_event_body_text_key(");
  assert.ok(start > 0, "la cartographie doit être déclarée dans le SQL");
  const body = execSql.slice(start, execSql.indexOf("$$;", start));
  const sqlMap = Object.fromEntries(
    [...body.matchAll(/when\s+'([a-z_]+)'\s+then\s+'([a-z_]+)'/g)].map((m) => [m[1], m[2]])
  );
  assert.deepEqual(sqlMap, { ...COMMUNICATION_EVENT_BODY_TEXT_KEY });
  // Totale : un événement du catalogue sans entrée serait un e-mail dont
  // la formulation marchande ne partirait jamais.
  for (const code of COMMUNICATION_EVENT_CODES) {
    assert.ok(sqlMap[code], `${code} doit avoir un gabarit de corps`);
  }
  // Et la branche par défaut est bien NULL (fermée au repos).
  assert.ok(body.includes("else null"), "un code non couvert ne doit avoir AUCUN gabarit");
});

test("[MIRROR-8] le worker lit `event_body_template` pour un événement et `body_template` pour order_received -- jamais l'inverse", () => {
  const code = executableTs(readFileSync("lib/server/notifications/notification-worker.ts", "utf8"));
  // Espaces normalisés : c'est la STRUCTURE de l'aiguillage qui est
  // vérifiée, pas sa mise en page.
  const flat = code.replace(/\s+/g, " ");
  assert.ok(
    flat.includes(
      'isCommunicationEvent ? templateField("event_body_template") : templateField("body_template")'
    ),
    "l'aiguillage de corps doit être explicite et conditionné au domaine"
  );
  // Un événement additionnel n'a pas de sujet marchand : le sujet
  // plateforme s'applique (aucune clé de sujet d'événement au catalogue).
  assert.ok(
    flat.includes('const merchantSubject = isCommunicationEvent ? ""'),
    "le sujet d'un événement additionnel doit rester celui de la plateforme"
  );
  // `withdrawal_template` -- la clé morte de v1, persistée puis jamais
  // lue -- ne doit plus exister d'aucun côté.
  assert.equal(code.includes("withdrawal_template"), false, "la clé morte ne doit plus être lue");
  // Dans le SQL on cherche la clé telle qu'elle serait POSÉE dans un
  // `jsonb_build_object` (`'withdrawal_template',`) -- et non sa simple
  // mention, puisque le POST-VOL du lot contient précisément un garde
  // qui vérifie son absence (avec des quotes doublées) et dont la
  // présence est souhaitable.
  assert.equal(
    execSql.includes("'withdrawal_template',"),
    false,
    "le SQL ne doit plus POSER la clé morte dans un instantané"
  );
  assert.ok(
    execSql.includes("''withdrawal_template''"),
    "le post-vol doit continuer de vérifier que la clé morte n'est pas posée"
  );
});

// ---------------------------------------------------------------------
// AUCUN SECOND SYSTÈME DE NOTIFICATION (mandat, littéral).
// ---------------------------------------------------------------------

test("[NO-SECOND-SYSTEM-1] le lot ne crée AUCUNE table ressemblant à une file d'envoi", () => {
  const created = [...execSql.matchAll(/create table public\.([a-z_]+)/g)].map((m) => m[1]);
  assert.deepEqual(created.sort(), ["merchant_communication_event", "merchant_communication_text"]);
  for (const forbidden of ["outbox", "queue", "notification_attempt", "delivery_attempt", "mail"]) {
    assert.equal(
      created.some((t) => t.includes(forbidden)),
      false,
      `aucune table créée ne doit évoquer « ${forbidden} »`
    );
  }
});

test("[NO-SECOND-SYSTEM-2] l'enfilement écrit dans la file EXISTANTE, avec SON unicité logique", () => {
  assert.ok(execSql.includes("insert into public.notification_outbox"));
  assert.ok(
    execSql.includes("on conflict (restaurant_id, order_id, notification_type) do nothing"),
    "la MÊME clé d'unicité logique porte l'idempotence -- aucun nouveau mécanisme"
  );
  // Et le post-vol vérifie que cette contrainte existe toujours.
  assert.ok(sql.includes("notification_outbox_logical_uniqueness"));
});

test("[NO-SECOND-SYSTEM-3] le worker reste UNIQUE : un seul module appelle provider.send()", () => {
  const senders = [
    "lib/server/notifications/notification-worker.ts",
    "lib/server/notifications/communication-event-template.ts",
    "lib/server/notifications/communication-template-values.ts",
  ].filter((f) => readFileSync(f, "utf8").includes("provider.send("));
  assert.deepEqual(senders, ["lib/server/notifications/notification-worker.ts"]);
});

test("[NO-SECOND-SYSTEM-4] la clé d'idempotence reste celle de N1-A, dérivée du seul outbox_id", () => {
  const provider = readFileSync("lib/server/notifications/email-provider.ts", "utf8");
  assert.ok(provider.includes("`scanym:notification:${outboxId}`"));
  const worker = readFileSync("lib/server/notifications/notification-worker.ts", "utf8");
  // Une SEULE construction de clé dans le worker, et c'est l'autorité
  // existante -- jamais une seconde dérivation propre à ce lot.
  assert.equal(
    (worker.match(/buildNotificationIdempotencyKey\(/g) ?? []).length,
    1
  );
  assert.equal(worker.includes("scanym:communication:"), false);
});

test("[NO-SECOND-SYSTEM-5] le gabarit d'événement RÉUTILISE le type de sortie existant", () => {
  const tpl = readFileSync("lib/server/notifications/communication-event-template.ts", "utf8");
  assert.ok(
    tpl.includes('import type { RenderedEmail } from "@/lib/server/notifications/order-received-template"'),
    "RenderedEmail est importé, jamais redéclaré"
  );
  assert.equal(tpl.includes("interface RenderedEmail"), false);
});

test("[NO-SECOND-SYSTEM-6] aucun transport d'e-mail n'est ajouté (ni SMTP, ni client réseau)", () => {
  for (const file of [
    "lib/server/notifications/communication-event-template.ts",
    "lib/server/notifications/communication-template-values.ts",
    "lib/communications/text-keys.ts",
    "lib/communications/template-variables.ts",
    "lib/communications/events.ts",
    "lib/communications/resolve.ts",
  ]) {
    const code = readFileSync(file, "utf8");
    for (const forbidden of ["node:tls", "node:net", "nodemailer", "SMTP_HOST", "fetch("]) {
      assert.equal(code.includes(forbidden), false, `${file} ne doit pas porter « ${forbidden} »`);
    }
  }
});

// ---------------------------------------------------------------------
// AUCUN APPEL FOURNISSEUR (mandat, littéral).
// ---------------------------------------------------------------------

test("[NO-PROVIDER-1] le SQL du lot ne nomme AUCUN transporteur en code exécutable", () => {
  for (const forbidden of ["stuart", "chronofresh"]) {
    assert.equal(
      execSql.toLowerCase().includes(forbidden),
      false,
      `le SQL exécutable ne doit pas nommer « ${forbidden} »`
    );
  }
});

test("[NO-PROVIDER-2] le lot ne touche à AUCUNE table ni fonction de prestataire", () => {
  for (const forbidden of [
    "stuart_provider_events",
    "stuart_merchant_credential",
    "restaurant_sale_mode_fulfillments",
    "resolve_delivery_fulfillment",
  ]) {
    assert.equal(execSql.includes(forbidden), false, `le SQL ne doit pas référencer ${forbidden}`);
  }
});

// ---------------------------------------------------------------------
// AUCUNE RÈGLE DE RÉTRACTATION MODIFIÉE (mandat, littéral).
// ---------------------------------------------------------------------

test("[WITHDRAWAL-UNTOUCHED-1] le lot ne fait que LIRE l'instantané d'éligibilité", () => {
  // Aucun ordre d'écriture sur order_items / menu_items /
  // withdrawal_requests dans tout le SQL exécutable.
  for (const table of ["order_items", "menu_items", "withdrawal_requests", "withdrawal_request_items"]) {
    for (const verb of ["update public." + table, "insert into public." + table, "delete from public." + table, "alter table public." + table]) {
      assert.equal(execSql.includes(verb), false, `le lot ne doit jamais exécuter « ${verb} »`);
    }
  }
  // Et il lit bien la colonne d'instantané, en `is true` (fail-closed).
  assert.ok(execSql.includes("oi.withdrawal_eligible_at_order_time is true"));
  assert.equal(execSql.includes("withdrawal_eligible_at_order_time = true"), false);
});

test("[WITHDRAWAL-UNTOUCHED-2] aucun déclencheur ni fonction d'éligibilité n'est redéfini", () => {
  for (const forbidden of [
    "snapshot_order_item_withdrawal_eligibility",
    "get_withdrawal_options_by_capability",
    "submit_withdrawal_request_by_capability",
  ]) {
    assert.equal(execSql.includes(forbidden), false, `le lot ne doit pas toucher ${forbidden}`);
  }
});

// ---------------------------------------------------------------------
// UNE SEULE FONCTION PRÉEXISTANTE REDÉFINIE, ET ADDITIVEMENT.
// ---------------------------------------------------------------------

test("[ADDITIVE-1] une SEULE `create or replace function` de fonction préexistante", () => {
  const replaced = [...execSql.matchAll(/create or replace function public\.([a-z_]+)/g)].map((m) => m[1]);
  assert.deepEqual(replaced, ["create_order_received_notification"]);
});

test("[ADDITIVE-2] la redéfinition conserve la garde tenant, l'idempotence et les 10 clés antérieures", () => {
  const start = execSql.indexOf("create or replace function public.create_order_received_notification");
  const body = execSql.slice(start);
  for (const probe of [
    "SCANYM_NOTIFICATION_TENANT_MISMATCH",
    "on conflict (restaurant_id, order_id, notification_type) do nothing",
    "'order_number', v_order.order_number",
    "'total', v_order.total",
    "'currency', v_order.currency",
    "'service_mode', v_order.service_mode",
    "'public_token', v_order.public_token",
    "'created_at', v_order.created_at",
    "'order_status', v_order.status",
    "'status_text_override', v_status_override",
    "'delivery_address'",
    "'merchant_name', v_merchant_name",
  ]) {
    assert.ok(body.includes(probe), `la redéfinition doit conserver ${probe}`);
  }
});

test("[ADDITIVE-3] le pré-vol REFUSE de remplacer une version inconnue, et le post-vol vérifie l'additivité", () => {
  // Les apostrophes SQL sont doublées dans un littéral : on cherche la
  // forme telle qu'elle est écrite dans le fichier.
  assert.ok(sql.includes("n''est pas la version CFTE v1 attendue"));
  assert.ok(sql.includes("n''est pas strictement additive"));
});

test("[ADDITIVE-4] le rollback REMET la fonction dans son état CFTE v1, AVANT toute suppression", () => {
  const restore = rollback.indexOf("create or replace function public.create_order_received_notification");
  const dropTable = rollback.indexOf("drop table if exists public.merchant_communication_text");
  const dropFn = rollback.indexOf("drop function if exists public.merchant_communication_contact");
  assert.ok(restore > 0, "le rollback doit réécrire la fonction");
  assert.ok(restore < dropTable, "la réécriture doit précéder la suppression des tables");
  assert.ok(restore < dropFn, "la réécriture doit précéder la suppression des fonctions");
  // La version restaurée ne doit plus référencer aucun objet du lot.
  const restored = rollback.slice(restore, rollback.indexOf("end $$;", restore));
  for (const forbidden of [
    "merchant_communication_text",
    "merchant_communication_contact",
    "subject_template",
    "body_template",
  ]) {
    assert.equal(restored.includes(forbidden), false, `la version restaurée ne doit pas porter ${forbidden}`);
  }
});

test("[ADDITIVE-5] le rollback supprime EXACTEMENT ce que l'aller a créé", () => {
  const createdTables = [...execSql.matchAll(/create table public\.([a-z_]+)/g)].map((m) => m[1]);
  const createdFns = [...execSql.matchAll(/create function public\.([a-z_]+)\(/g)].map((m) => m[1]);
  for (const t of createdTables) {
    assert.ok(rollback.includes(`drop table if exists public.${t}`), `le rollback doit supprimer ${t}`);
  }
  for (const f of createdFns) {
    assert.ok(rollback.includes(`drop function if exists public.${f}(`), `le rollback doit supprimer ${f}()`);
  }
});

// ---------------------------------------------------------------------
// POSTURE DE SÉCURITÉ DÉCLARÉE DANS LE FICHIER.
// ---------------------------------------------------------------------

test("[SECURITY-1] toutes les fonctions du lot fixent search_path = ''", () => {
  const declarations = [...execSql.matchAll(/create (?:or replace )?function public\.[a-z_]+\([^)]*\)[\s\S]*?as \$\$/g)];
  assert.ok(declarations.length >= 11, `au moins 11 fonctions attendues, vu ${declarations.length}`);
  for (const d of declarations) {
    assert.ok(d[0].includes("set search_path = ''"), `une fonction sans search_path='' : ${d[0].slice(0, 90)}`);
  }
});

test("[SECURITY-2] les deux tables activent la RLS et révoquent tout avant de donner le SELECT", () => {
  for (const t of ["merchant_communication_text", "merchant_communication_event"]) {
    assert.ok(execSql.includes(`alter table public.${t} enable row level security`));
    assert.ok(execSql.includes(`revoke all on public.${t} from public, anon, authenticated`));
    assert.ok(execSql.includes(`grant select on public.${t} to authenticated`));
    // AUCUN grant d'écriture de table, pour personne.
    for (const priv of ["insert", "update", "delete"]) {
      assert.equal(
        new RegExp(`grant[^;]*\\b${priv}\\b[^;]*on public\\.${t}`, "i").test(execSql),
        false,
        `aucun GRANT ${priv.toUpperCase()} ne doit exister sur ${t}`
      );
    }
  }
});

test("[SECURITY-3] la preuve d'éligibilité et l'enfilement sont réservés à service_role", () => {
  for (const fn of [
    "public.order_has_withdrawal_eligible_line(uuid, uuid)",
    "public.create_order_communication_notification(uuid, uuid, text)",
  ]) {
    assert.ok(
      execSql.includes(`revoke all on function ${fn} from public, anon, authenticated`),
      `${fn} doit être révoquée pour anon/authenticated`
    );
    assert.ok(
      execSql.includes(`grant execute on function ${fn} to service_role`),
      `${fn} doit être accordée à service_role seul`
    );
  }
});

test("[SECURITY-4] la projection publique est la SEULE fonction accordée à anon", () => {
  const anonGrants = [...execSql.matchAll(/grant execute on function (public\.[a-z_]+\([^)]*\)) to ([^;]+);/g)]
    .filter((m) => m[2].includes("anon"))
    .map((m) => m[1]);
  assert.deepEqual(anonGrants, ["public.get_restaurant_public_communication_texts(uuid)"]);
});

test("[SECURITY-5] atomicité : une seule transaction, `commit;` en dernière instruction", () => {
  for (const source of [sql, rollback]) {
    assert.equal((source.match(/^begin;$/gm) ?? []).length, 1);
    assert.equal((source.match(/^commit;$/gm) ?? []).length, 1);
    const executable = source
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.trim().startsWith("--"));
    assert.equal(executable[executable.length - 1]!.trim(), "commit;");
  }
});

// ---------------------------------------------------------------------
// AUCUN TEXTE CODÉ EN DUR PROPRE À UN COMMERÇANT (mandat, littéral :
// « NO HARDCODED AU LAIT CRU TEXT »).
// ---------------------------------------------------------------------

/** Code TypeScript EXÉCUTABLE seul. Les commentaires peuvent nommer un
 *  commerçant pour expliquer une décision ; le code non. */
function executableTs(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const LOT_FILES = [
  "lib/communications/text-keys.ts",
  "lib/communications/template-variables.ts",
  "lib/communications/events.ts",
  "lib/communications/resolve.ts",
  "lib/services/merchant-communications.ts",
  "lib/server/notifications/communication-event-template.ts",
  "lib/server/notifications/communication-template-values.ts",
  "lib/server/withdrawal-eligibility-service.ts",
  "app/api/checkout/withdrawal-eligibility/route.ts",
  "components/OrderConfirmation.tsx",
];

test("[NO-HARDCODE-1] aucun nom de commerçant, aucun slug tenant en code exécutable", () => {
  const forbidden = ["au lait cru", "aulaitcru", "au-lait-cru", "epicerie alpha", "sanaa"];
  for (const file of [...LOT_FILES, SQL_PATH, ROLLBACK_PATH]) {
    const code = file.endsWith(".sql") ? executableSql(readFileSync(file, "utf8")) : executableTs(readFileSync(file, "utf8"));
    const lower = code.toLowerCase();
    for (const needle of forbidden) {
      assert.equal(lower.includes(needle), false, `${file} ne doit pas porter « ${needle} » en code exécutable`);
    }
    // Aucune comparaison de slug, quelle qu'elle soit.
    assert.equal(/\.slug\s*===\s*["'][^"']+["']/.test(code), false, `${file} ne doit comparer aucun slug littéral`);
  }
});

test("[NO-HARDCODE-2] les modules du lot ne contiennent AUCUNE phrase customer-facing", () => {
  // Une phrase customer-facing = un littéral de plus de 25 caractères
  // contenant une espace. Les modules du lot ne doivent nommer que des
  // CLÉS i18n et des identifiants : tout texte vit dans lib/i18n.ts.
  for (const file of [
    "lib/communications/text-keys.ts",
    "lib/communications/template-variables.ts",
    "lib/communications/events.ts",
    "lib/communications/resolve.ts",
  ]) {
    const code = executableTs(readFileSync(file, "utf8"));
    // Extraction PRUDENTE : un littéral de chaîne, sans échappement,
    // contenant une espace ET au moins trois lettres, et ne portant
    // AUCUN caractère d'opérateur. Sans ces deux dernières gardes, la
    // regex capture l'intervalle de code SÉPARANT deux littéraux (par
    // exemple `" && x.trim() !== "`) et signale une phrase qui n'existe
    // pas -- faux positif déjà rencontré sur le garde NO-HARDCODE du lot
    // précédent.
    const sentences = [...code.matchAll(/"([^"\\\n]{26,})"/g)]
      .map((m) => m[1])
      .filter(
        (s) =>
          s.includes(" ") &&
          (s.match(/[A-Za-zÀ-ÿ]/g) ?? []).length >= 3 &&
          !/[=!&|;(){}<>]/.test(s)
      );
    assert.deepEqual(sentences, [], `${file} ne doit porter aucune phrase littérale`);
  }
});

test("[NO-HARDCODE-3] chaque clé i18n ajoutée par le lot existe dans LES TROIS dictionnaires", () => {
  const i18n = readFileSync("lib/i18n.ts", "utf8");
  const added = [
    "commCarrierPreparedDefault",
    "emailCarrierLabel",
    "emailCarrierHandoffSubject",
    "emailCarrierHandoffHeading",
    "emailCarrierHandoffIntro",
    "emailLocalDeliveryHandoffSubject",
    "emailLocalDeliveryHandoffHeading",
    "emailLocalDeliveryHandoffIntro",
    "emailWithdrawalRequestSubject",
    "emailWithdrawalRequestHeading",
    "emailWithdrawalRequestIntro",
    "confirmWithdrawalCta",
    "commFlagYes",
    "commFlagNo",
    "stCommTextTitle",
    "stCommTextHint",
    "stCommVariablesHint",
    "stCommTextTooLong",
    "stCommUnknownVariable",
    "stCommSaveError",
    "stCommEventTitle",
    "stCommEventHint",
    "stCommEventSaveError",
  ];
  for (const key of added) {
    const occurrences = (i18n.match(new RegExp(`^\\s{2}${key}:`, "gm")) ?? []).length;
    assert.equal(occurrences, 3, `${key} doit être défini dans fr, en et ar (vu ${occurrences})`);
  }
  // Un libellé par emplacement et par événement, dans les 3 langues.
  for (const key of COMMUNICATION_TEXT_KEYS) {
    const occurrences = (i18n.match(new RegExp(`^\\s{2}stCommKey_${key}:`, "gm")) ?? []).length;
    assert.equal(occurrences, 3, `stCommKey_${key} doit être défini dans les 3 langues`);
  }
  for (const code of COMMUNICATION_EVENT_CODES) {
    const occurrences = (i18n.match(new RegExp(`^\\s{2}stCommEvent_${code}:`, "gm")) ?? []).length;
    assert.equal(occurrences, 3, `stCommEvent_${code} doit être défini dans les 3 langues`);
  }
});

// ---------------------------------------------------------------------
// §B — CONTRAT DE L'ÉCRAN DE CONFIRMATION, vérifié sur la SOURCE.
// ---------------------------------------------------------------------

test("[CONFIRM-CONTRACT-1] OrderConfirmation ne rend plus AUCUN appel à l'action de suivi", () => {
  const code = executableTs(readFileSync("components/OrderConfirmation.tsx", "utf8"));
  assert.equal(code.includes("trackYourOrder"), false, "la clé du libellé de suivi ne doit plus être employée");
  assert.equal(code.includes("data-order-confirmation-tracking"), false, "l'ancien point d'accroche doit avoir disparu");
});

test("[CONFIRM-CONTRACT-2] le CTA de rétractation exige une preuve STRICTEMENT booléenne", () => {
  const code = readFileSync("components/OrderConfirmation.tsx", "utf8");
  assert.ok(
    code.includes("withdrawalEligible === true && trackingPath !== null"),
    "fermé au repos : ni coercition, ni lien mort"
  );
});

test("[CONFIRM-CONTRACT-3] aucun dangerouslySetInnerHTML dans les composants touchés", () => {
  for (const file of [
    "components/OrderConfirmation.tsx",
    "components/FulfillmentSelector.tsx",
    "components/DeliveryTimingNoticeDialog.tsx",
    "components/CartPanel.tsx",
    "components/MenuView.tsx",
  ]) {
    // Code EXÉCUTABLE seul : un commentaire a parfaitement le droit
    // d'expliquer pourquoi `dangerouslySetInnerHTML` n'est PAS employé.
    assert.equal(
      executableTs(readFileSync(file, "utf8")).includes("dangerouslySetInnerHTML"),
      false,
      `${file} doit rendre le texte marchand en nœud texte`
    );
  }
});

// ---------------------------------------------------------------------
// LE HARNAIS SQL EXISTE ET VISE LE BON FICHIER.
// ---------------------------------------------------------------------

test("[HARNESS-1] le harnais PostgreSQL du lot existe et exerce l'aller ET le retour", () => {
  assert.ok(existsSync(HARNESS_PATH), "le harnais SQL doit être livré avec le lot");
  const harness = readFileSync(HARNESS_PATH, "utf8");
  assert.ok(harness.includes("DRAFT-lot-merchant-customer-communications-v1.sql"));
  assert.ok(harness.includes("DRAFT-lot-merchant-customer-communications-v1-rollback.sql"));
});

// ---------------------------------------------------------------------
// SÛRETÉ DU HARNAIS (v1.1) — ferme MCC-V1-HARNESS-UNSAFE-TARGET-01.
//
// Les PREUVES comportementales sont dans
// supabase/tests/merchant-customer-communications-v1-harness-safety-check.sh
// (47 preuves, exécutées sur de vrais clusters). Ce qui est vérifié ici,
// c'est que les MÉCANISMES n'ont pas été retirés du harnais — un garde
// supprimé ne se remarque pas autrement.
// ---------------------------------------------------------------------

test("[HARNESS-2] le harnais exige un consentement EXPLICITE et refuse toute variable de connexion héritée", () => {
  const harness = readFileSync(HARNESS_PATH, "utf8");
  assert.ok(
    harness.includes('"${SCANYM_DISPOSABLE_CLUSTER:-}" != "1"'),
    "égalité STRICTE à « 1 » : ni 0, ni true, ni une chaîne vide"
  );
  // Toutes les variables que le mandat de remédiation énumère, plus les
  // URLs propres au projet.
  for (const v of [
    "PGHOST", "PGHOSTADDR", "PGPORT", "PGUSER", "PGPASSWORD", "PGPASSFILE",
    "PGDATABASE", "PGSERVICE", "PGSERVICEFILE",
    "DATABASE_URL", "POSTGRES_URL", "POSTGRESQL_URL", "PG_URL",
    "SUPABASE_DB_URL", "SCANYM_DB_URL", "SCANYM_DATABASE_URL",
  ]) {
    assert.ok(
      new RegExp(`REDIRECTING_VARS="[^"]*\\b${v}\\b`).test(harness),
      `${v} doit figurer parmi les variables REFUSÉES`
    );
  }
  // Neutralisation défensive de toute autre PG* héritée.
  assert.ok(harness.includes("PG*) unset"), "toute autre PG* héritée doit être retirée");
});

test("[HARNESS-3] une valeur de variable sensible n'est JAMAIS journalisée -- seul le nom", () => {
  const harness = readFileSync(HARNESS_PATH, "utf8");
  const start = harness.indexOf("for v in $REDIRECTING_VARS; do");
  const block = harness.slice(start, harness.indexOf("done", start));
  // Le message de refus doit interpoler `$v` (le NOM) et jamais
  // `${!v}` (la VALEUR) -- c'est tout l'écart entre un diagnostic et
  // une fuite de mot de passe dans un journal.
  assert.ok(block.includes('refuse "$v est définie'), "le refus doit nommer la variable");
  assert.equal(block.includes("${!v}"), false, "la VALEUR ne doit jamais être interpolée dans le message");
});

test("[HARNESS-4] le cluster est POSSÉDÉ par le harnais, et cette possession est PROUVÉE en SQL", () => {
  const harness = readFileSync(HARNESS_PATH, "utf8");
  assert.ok(harness.includes("initdb"), "le harnais doit pouvoir créer son propre cluster");
  assert.ok(harness.includes("listen_addresses=''"), "le cluster créé ne doit écouter aucun TCP");
  assert.ok(
    harness.includes(`current_setting('data_directory')`),
    "l'identité du cluster doit être prouvée en SQL"
  );
  assert.ok(
    harness.includes('[ "$DATA_DIR" = "$PGDATA_DIR" ]'),
    "le serveur joint doit être CELUI que le harnais a créé"
  );
  assert.ok(harness.includes(`current_setting('is_superuser')`), "l'utilisateur effectif doit être vérifié");
  assert.ok(
    harness.includes("(prod|production|live|preprod|staging|recette)"),
    "les noms d'environnement protégés doivent être refusés"
  );
});

test("[HARNESS-5] aucun nom de base FIXE, et une collision provoque un REFUS -- jamais un DROP", () => {
  const harness = readFileSync(HARNESS_PATH, "utf8");
  // Les noms portent l'étiquette d'exécution.
  for (const name of ["DB_BASE", "DB_FWD", "DB_ATOMIC", "DB_RB"]) {
    assert.ok(
      new RegExp(`${name}="scanym_mcc_v1_[a-z]+_\\$RUN_TAG"`).test(harness),
      `${name} doit porter l'étiquette d'exécution, jamais un nom fixe`
    );
  }
  assert.ok(
    harness.includes("existe déjà et n'a pas été créée par cette exécution"),
    "une collision de nom doit être un REFUS explicite"
  );
  // Et surtout : plus aucun `drop database` préventif avant preuve.
  // Code EXÉCUTABLE seul -- l'en-tête du harnais DÉCRIT le défaut fermé
  // (« elle faisait `drop database if exists` dessus AVANT de rien
  // prouver »), et cette documentation doit rester.
  const shellCode = harness
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
  const drops = [...shellCode.matchAll(/drop database if exists[^\n]*/g)].map((m) => m[0]);
  assert.equal(
    drops.length,
    1,
    `un seul \`drop database if exists\` doit subsister (celui du nettoyage tracé), vu ${drops.length}`
  );
  assert.ok(
    harness.includes("for d in $CREATED_DBS; do"),
    "le nettoyage ne doit parcourir QUE les bases créées par cette exécution"
  );
  assert.ok(
    harness.includes("CREATED_DBS=\"$CREATED_DBS $name\""),
    "la création doit être TRACÉE"
  );
});

test("[HARNESS-6] l'instrumentation de test est DOUBLEMENT verrouillée", () => {
  const harness = readFileSync(HARNESS_PATH, "utf8");
  // Figer l'étiquette d'exécution sert au harnais de sûreté à provoquer
  // une collision. Une seule variable ne doit JAMAIS suffire.
  const start = harness.indexOf('if [ -n "${SCANYM_HARNESS_RUN_TAG:-}" ]; then');
  assert.ok(start > 0, "l'instrumentation doit exister");
  const block = harness.slice(start, start + 600);
  assert.ok(block.includes('"${SCANYM_HARNESS_SELFTEST:-0}" = "1"'), "second verrou requis");
  assert.ok(block.includes("ignorée"), "une variable seule doit être ignorée ET signalée");
});

test("[HARNESS-7] le harnais de SÛRETÉ compagnon existe et couvre les six scénarios exigés", () => {
  assert.ok(existsSync(SAFETY_PATH), "le harnais de sûreté doit être livré avec le lot");
  const safety = readFileSync(SAFETY_PATH, "utf8");
  for (const [label, probe] of [
    ["PGPORT hérité", "PGPORT=6543"],
    ["identifiants/URLs hérités", "SUPABASE_DB_URL"],
    ["consentement manquant", "sans SCANYM_DISPOSABLE_CLUSTER=1"],
    ["collision de nom", "aucun DROP"],
    ["cluster jetable => PASS", "le harnais PASSE"],
    ["nettoyage limité", "a SURVÉCU au nettoyage"],
  ] as const) {
    assert.ok(safety.includes(probe), `le scénario « ${label} » doit être couvert`);
  }
  // Il doit viser LE harnais du lot, et partir d'un environnement vide.
  assert.ok(safety.includes("merchant-customer-communications-v1-check.sh"));
  assert.ok(safety.includes("env -i"), "chaque scénario doit partir d'un environnement VIDE");
});
