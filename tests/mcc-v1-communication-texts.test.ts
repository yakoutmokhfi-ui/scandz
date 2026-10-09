import test from "node:test";
import assert from "node:assert/strict";

import {
  COMMUNICATION_TEXT_KEYS,
  COMMUNICATION_TEXT_SPEC,
  COMMUNICATION_SUBJECT_MAX_LENGTH,
  COMMUNICATION_TEXT_MAX_LENGTH,
  PUBLIC_COMMUNICATION_TEXT_KEYS,
  communicationTextMaxLength,
  isCommunicationTextKey,
  normalizeCommunicationText,
  overridesFromPublicProjection,
  sanitizeCommunicationTextOverrides,
} from "../lib/communications/text-keys.ts";
import {
  COMMUNICATION_TEMPLATE_VARIABLES,
  extractTemplatePlaceholders,
  findUnknownTemplateVariables,
  isCommunicationTemplateVariable,
  renderCommunicationTemplate,
  validateCommunicationTemplate,
} from "../lib/communications/template-variables.ts";
import {
  resolveAndRenderCommunicationText,
  resolveCommunicationText,
} from "../lib/communications/resolve.ts";
import {
  COMMUNICATION_EVENT_CODES,
  isCommunicationEventCode,
  isCommunicationEventEnabled,
  sanitizeCommunicationEventConfig,
} from "../lib/communications/events.ts";

/**
 * Scanym — MERCHANT CUSTOMER COMMUNICATIONS v1 — logique PURE.
 *
 * Couvre les catégories de test exigées par le mandat :
 *   [2] repli par défaut, [3] texte personnalisé, [4] variable
 *   manquante/inconnue, [5] contenu malveillant, et la moitié PURE de
 *   [1] isolation multi-locataires (aucune surcharge ne peut traverser
 *   la frontière de sanitisation vers un autre emplacement ni un autre
 *   locataire).
 *
 * Aucun réseau, aucune base, aucun React : ces fonctions sont les
 * uniques autorités, et c'est ici qu'on les met sous contrainte.
 */

const FR: Record<string, string> = {
  pickupNote: "Nous vous confirmons l'heure et le lieu de retrait par message.",
  deliveryNote: "Nous vous confirmons le créneau de livraison par message.",
  deliveryEligibleDefault: "Livraison possible.",
  deliveryTimingNoticeNotesHint: "Ces informations sont communiquées par le commerçant.",
  confirmTitle: "Commande envoyée avec succès !",
  confirmPickupTime: "⏱️ Nous vous confirmons l'heure et le lieu de retrait par message",
  confirmDeliveryTime: "⏱️ Nous vous confirmons le créneau par message",
  commCarrierPreparedDefault:
    "Votre commande est préparée puis remise au transporteur pour acheminement.",
};
const translate = (key: string) => FR[key] ?? key;

// ---------------------------------------------------------------------
// [CATALOGUE] Le catalogue est FERMÉ et cohérent avec lui-même.
// ---------------------------------------------------------------------

test("[CAT-1] le catalogue porte 14 emplacements distincts, tous spécifiés", () => {
  assert.equal(COMMUNICATION_TEXT_KEYS.length, 14);
  assert.equal(new Set(COMMUNICATION_TEXT_KEYS).size, 14);
  for (const key of COMMUNICATION_TEXT_KEYS) {
    const spec = COMMUNICATION_TEXT_SPEC[key];
    assert.ok(spec, `spec manquante pour ${key}`);
    assert.equal(typeof spec.publicProjection, "boolean");
    assert.ok(spec.maxLength > 0 && spec.maxLength <= COMMUNICATION_TEXT_MAX_LENGTH);
  }
});

test("[CAT-2] les 3 gabarits d'e-mail ne sont JAMAIS exposés publiquement", () => {
  assert.equal(PUBLIC_COMMUNICATION_TEXT_KEYS.length, 11);
  for (const key of [
    "email_confirmation_subject",
    "email_confirmation_body",
    "confirmation_withdrawal_request",
  ] as const) {
    assert.equal(
      COMMUNICATION_TEXT_SPEC[key].publicProjection,
      false,
      `${key} ne doit pas être exposé`
    );
    assert.equal((PUBLIC_COMMUNICATION_TEXT_KEYS as readonly string[]).includes(key), false);
  }
});

test("[CAT-3] le sujet d'e-mail est borné plus court que les autres emplacements", () => {
  assert.equal(communicationTextMaxLength("email_confirmation_subject"), COMMUNICATION_SUBJECT_MAX_LENGTH);
  assert.equal(communicationTextMaxLength("order_success_body"), COMMUNICATION_TEXT_MAX_LENGTH);
  assert.ok(COMMUNICATION_SUBJECT_MAX_LENGTH < COMMUNICATION_TEXT_MAX_LENGTH);
});

test("[CAT-4] une chaîne hors catalogue n'est jamais un emplacement", () => {
  assert.equal(isCommunicationTextKey("order_success_title"), true);
  for (const bogus of ["", "ORDER_SUCCESS_TITLE", "order_success", "__proto__", "constructor", 42, null]) {
    assert.equal(isCommunicationTextKey(bogus), false, String(bogus));
  }
});

// ---------------------------------------------------------------------
// [2] REPLI PAR DÉFAUT — aucune configuration => formulation actuelle.
// ---------------------------------------------------------------------

test("[DEFAULT-1] sans aucune surcharge, chaque emplacement à base i18n rend EXACTEMENT le texte de base", () => {
  for (const key of COMMUNICATION_TEXT_KEYS) {
    const baseKey = COMMUNICATION_TEXT_SPEC[key].defaultI18nKey;
    if (baseKey === null) continue;
    const resolved = resolveCommunicationText(key, {}, translate);
    assert.equal(resolved.source, "base", key);
    assert.equal(resolved.text, translate(baseKey), key);
  }
});

test("[DEFAULT-2] un emplacement ADDITIF sans surcharge est `absent`, jamais une chaîne vide", () => {
  for (const key of ["checkout_info", "sanitary_warning"] as const) {
    const resolved = resolveCommunicationText(key, {}, translate, null);
    assert.equal(resolved.source, "absent", key);
    assert.equal(resolved.text, null, key);
  }
});

test("[DEFAULT-3] une base fournie EXPLICITEMENT par l'appelant est employée (base conditionnelle)", () => {
  // order_success_body n'a pas de clé de catalogue : sa base dépend de
  // l'activation WhatsApp, connue de l'appelant seul.
  const withWhatsapp = resolveCommunicationText(
    "order_success_body",
    {},
    translate,
    "Votre commande a été transmise à X via WhatsApp."
  );
  assert.equal(withWhatsapp.source, "base");
  assert.equal(withWhatsapp.text, "Votre commande a été transmise à X via WhatsApp.");

  const withoutWhatsapp = resolveCommunicationText(
    "order_success_body",
    {},
    translate,
    "Votre commande a bien été enregistrée et transmise à X."
  );
  assert.equal(withoutWhatsapp.text, "Votre commande a bien été enregistrée et transmise à X.");
});

test("[DEFAULT-4] surcharge vide / blanche / trop longue => repli, JAMAIS une troncature", () => {
  const tooLong = "x".repeat(COMMUNICATION_TEXT_MAX_LENGTH + 1);
  for (const value of ["", "   ", "\n\t ", tooLong, null, undefined, 42 as unknown as string]) {
    const resolved = resolveCommunicationText("order_success_title", { order_success_title: value }, translate);
    assert.equal(resolved.source, "base", JSON.stringify(value));
    assert.equal(resolved.text, FR.confirmTitle);
  }
  // Explicitement : rien n'est coupé au milieu d'une phrase.
  assert.equal(normalizeCommunicationText("order_success_title", tooLong), undefined);
});

test("[DEFAULT-5] la borne PAR emplacement est appliquée (sujet à 160, pas 500)", () => {
  const long = "s".repeat(COMMUNICATION_SUBJECT_MAX_LENGTH + 1);
  assert.equal(normalizeCommunicationText("email_confirmation_subject", long), undefined);
  // La MÊME chaîne est parfaitement valide pour un corps.
  assert.equal(normalizeCommunicationText("email_confirmation_body", long), long);
});

// ---------------------------------------------------------------------
// [3] TEXTE PERSONNALISÉ.
// ---------------------------------------------------------------------

test("[CUSTOM-1] une surcharge non vide gagne, et l'origine est tracée", () => {
  const resolved = resolveCommunicationText(
    "order_success_title",
    { order_success_title: "  Merci, c'est noté !  " },
    translate
  );
  assert.equal(resolved.source, "merchant_override");
  assert.equal(resolved.text, "Merci, c'est noté !");
  assert.equal(resolved.key, "order_success_title");
});

test("[CUSTOM-2] une surcharge peut porter des variables de la liste blanche", () => {
  const resolved = resolveAndRenderCommunicationText(
    "email_confirmation_body",
    { email_confirmation_body: "Bonjour, {merchant_name} a reçu la commande {order_reference}." },
    translate,
    { merchant_name: "Epicerie Alpha", order_reference: "4242" }
  );
  assert.equal(resolved.source, "merchant_override");
  assert.equal(resolved.text, "Bonjour, Epicerie Alpha a reçu la commande 4242.");
});

test("[CUSTOM-3] un gabarit entièrement réduit au vide retombe sur `absent`, jamais un bloc vide", () => {
  const resolved = resolveAndRenderCommunicationText(
    "checkout_info",
    { checkout_info: "{fulfillment_slot}" },
    translate,
    { fulfillment_slot: "" },
    null
  );
  assert.equal(resolved.source, "absent");
  assert.equal(resolved.text, null);
});

// ---------------------------------------------------------------------
// [1] ISOLATION — moitié PURE : la frontière de sanitisation.
// ---------------------------------------------------------------------

test("[TENANT-1] la projection publique ne laisse JAMAIS passer un gabarit d'e-mail", () => {
  // Même si le serveur en renvoyait un (défense en profondeur côté
  // client, le filtre SQL étant l'autorité).
  const overrides = overridesFromPublicProjection([
    { text_key: "order_success_title", body: "Titre A" },
    { text_key: "email_confirmation_subject", body: "SUJET QUI NE DOIT PAS SORTIR" },
    { text_key: "email_confirmation_body", body: "CORPS QUI NE DOIT PAS SORTIR" },
    { text_key: "confirmation_withdrawal_request", body: "ACCUSE QUI NE DOIT PAS SORTIR" },
  ]);
  assert.deepEqual(Object.keys(overrides), ["order_success_title"]);
  assert.equal(overrides.order_success_title, "Titre A");
});

test("[TENANT-2] une clé hors catalogue ou héritée du prototype est IGNORÉE", () => {
  const hostile = Object.create({ order_success_title: "DEPUIS LE PROTOTYPE" }) as Record<string, unknown>;
  hostile.not_a_key = "ignoré";
  hostile.__proto__ = { order_success_title: "ENCORE DEPUIS LE PROTOTYPE" };
  const safe = sanitizeCommunicationTextOverrides(hostile);
  assert.equal(safe.order_success_title, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(safe, "not_a_key"), false);
});

test("[TENANT-3] deux configurations distinctes ne se contaminent pas, et l'entrée n'est pas mutée", () => {
  const rawA = { order_success_title: "Alpha dit bonjour" };
  const rawB = { order_success_title: "Beta dit autrement" };
  const a = sanitizeCommunicationTextOverrides(rawA);
  const b = sanitizeCommunicationTextOverrides(rawB);
  assert.equal(a.order_success_title, "Alpha dit bonjour");
  assert.equal(b.order_success_title, "Beta dit autrement");
  // Résolution avec la configuration de A : jamais le texte de B.
  assert.equal(resolveCommunicationText("order_success_title", a, translate).text, "Alpha dit bonjour");
  assert.equal(resolveCommunicationText("order_success_title", b, translate).text, "Beta dit autrement");
  // Les entrées sont intactes.
  assert.deepEqual(rawA, { order_success_title: "Alpha dit bonjour" });
  assert.deepEqual(rawB, { order_success_title: "Beta dit autrement" });
});

test("[TENANT-4] une projection non-tableau / nulle donne une configuration VIDE, jamais un héritage", () => {
  for (const bogus of [null, undefined, {} as unknown as [], "x" as unknown as []]) {
    assert.deepEqual(overridesFromPublicProjection(bogus as never), {});
  }
});

// ---------------------------------------------------------------------
// [4] VARIABLES — liste blanche et MCC-V1-UNKNOWN-VARIABLE-RULE.
// ---------------------------------------------------------------------

test("[VAR-1] la liste blanche porte exactement les 13 variables du mandat", () => {
  assert.deepEqual([...COMMUNICATION_TEMPLATE_VARIABLES], [
    "merchant_name",
    "order_reference",
    "order_total",
    "fulfillment_type",
    "fulfillment_date",
    "fulfillment_slot",
    "merchant_address",
    "merchant_email",
    "merchant_phone",
    "carrier_name",
    "invoice_requested",
    "withdrawal_link",
    "withdrawal_eligible",
  ]);
  assert.equal(new Set(COMMUNICATION_TEMPLATE_VARIABLES).size, 13);
});

test("[VAR-2] extraction : ordre d'apparition, doublons retirés, non-emplacements ignorés", () => {
  assert.deepEqual(
    extractTemplatePlaceholders("{merchant_name} {order_reference} {merchant_name} { y } {Z} {a-b} {} {1+1}"),
    ["merchant_name", "order_reference"]
  );
  assert.deepEqual(extractTemplatePlaceholders(""), []);
  assert.deepEqual(extractTemplatePlaceholders(null), []);
});

test("[VAR-3] ÉCRITURE : un jeton hors liste blanche fait ÉCHOUER la validation", () => {
  const bad = validateCommunicationTemplate("Bonjour {pirate} et {merchant_name}");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual([...bad.unknownVariables], ["pirate"]);

  assert.deepEqual(findUnknownTemplateVariables("{merchant_name}{order_total}"), []);
  assert.equal(validateCommunicationTemplate("{merchant_name}").ok, true);
  // Un gabarit sans aucune variable est valide.
  assert.equal(validateCommunicationTemplate("Texte simple").ok, true);
  assert.equal(validateCommunicationTemplate(null).ok, true);
});

test("[VAR-4] RENDU : un jeton inconnu est IGNORÉ sans bruit (chaîne vide), jamais recraché", () => {
  const rendered = renderCommunicationTemplate("A{pirate}B{merchant_name}C", { merchant_name: "Alpha" });
  assert.equal(rendered, "ABAlphaC");
  assert.equal(rendered.includes("pirate"), false);
  assert.equal(rendered.includes("{"), false);
});

test("[VAR-5] RENDU : une variable CONNUE sans valeur vaut la chaîne vide, jamais 'undefined'", () => {
  const rendered = renderCommunicationTemplate(
    "Créneau : [{fulfillment_slot}] Date : [{fulfillment_date}]",
    { merchant_name: "Alpha" }
  );
  assert.equal(rendered, "Créneau : [] Date : []");
  assert.equal(rendered.includes("undefined"), false);
  assert.equal(rendered.includes("null"), false);
});

test("[VAR-6] RENDU : une valeur non-chaîne ou héritée du prototype vaut la chaîne vide", () => {
  const hostile = Object.create({ merchant_name: "DEPUIS LE PROTOTYPE" }) as Record<string, unknown>;
  assert.equal(renderCommunicationTemplate("[{merchant_name}]", hostile as never), "[]");
  assert.equal(
    renderCommunicationTemplate("[{merchant_name}]", { merchant_name: 42 as unknown as string }),
    "[]"
  );
});

test("[VAR-7] la substitution n'est PAS récursive : une valeur portant un jeton n'est pas re-développée", () => {
  const rendered = renderCommunicationTemplate("{merchant_name}", {
    merchant_name: "{order_reference}",
    order_reference: "4242",
  });
  assert.equal(rendered, "{order_reference}");
  assert.equal(rendered.includes("4242"), false);
});

test("[VAR-8] `{{x}}` porte bien l'emplacement `{x}` -- contrat explicite, pas un accident", () => {
  assert.deepEqual(extractTemplatePlaceholders("{{x}}"), ["x"]);
  assert.equal(validateCommunicationTemplate("{{x}}").ok, false);
  assert.deepEqual(extractTemplatePlaceholders("{{merchant_name}}"), ["merchant_name"]);
  assert.equal(renderCommunicationTemplate("{{merchant_name}}", { merchant_name: "Alpha" }), "{Alpha}");
});

test("[VAR-9] aucune variable ne peut désigner une propriété de prototype", () => {
  // Deux défenses distinctes, et ce test vérifie les deux :
  //  a) un nom en minuscules atteint bien le filtre de liste blanche,
  //     qui le déclare INCONNU (donc refusé à l'écriture, ignoré au
  //     rendu) -- il n'est jamais lu comme une propriété ;
  //  b) un nom portant une majuscule (`toString`) n'est même pas un
  //     emplacement pour la grammaire : il traverse le gabarit intact.
  for (const name of ["__proto__", "constructor", "prototype"]) {
    assert.equal(isCommunicationTemplateVariable(name), false, name);
    assert.deepEqual(findUnknownTemplateVariables(`{${name}}`), [name], name);
    assert.equal(renderCommunicationTemplate(`[{${name}}]`, {}), "[]", name);
  }
  assert.equal(isCommunicationTemplateVariable("toString"), false);
  assert.deepEqual(findUnknownTemplateVariables("{toString}"), []);
  assert.equal(renderCommunicationTemplate("[{toString}]", {}), "[{toString}]");
});

// ---------------------------------------------------------------------
// [5] CONTENU MALVEILLANT — le texte reste du texte.
// ---------------------------------------------------------------------

const HOSTILE = `<script>alert('xss')</script><img src=x onerror="alert(1)">`;

test("[MALICIOUS-1] un corps hostile traverse la résolution TEL QUEL, sans exécution ni transformation", () => {
  const resolved = resolveCommunicationText(
    "order_success_body",
    { order_success_body: HOSTILE },
    translate,
    "base"
  );
  assert.equal(resolved.source, "merchant_override");
  // Texte brut EN SORTIE : l'échappement appartient à la frontière de
  // rendu (HTML d'e-mail) ou à React (nœud texte). Ce module ne doit NI
  // échapper (double échappement dans la variante texte de l'e-mail),
  // NI interpréter.
  assert.equal(resolved.text, HOSTILE);
});

test("[MALICIOUS-2] un gabarit hostile n'acquiert aucun pouvoir par la substitution", () => {
  const rendered = renderCommunicationTemplate(`<script>{merchant_name}</script>`, {
    merchant_name: `</script><script>alert(1)</script>`,
  });
  // Rien n'est exécuté, rien n'est réécrit : c'est une chaîne.
  assert.equal(rendered, `<script></script><script>alert(1)</script></script>`);
  assert.equal(typeof rendered, "string");
});

test("[MALICIOUS-3] une valeur hostile ne peut pas introduire un emplacement supplémentaire", () => {
  const rendered = renderCommunicationTemplate("{merchant_name}{merchant_email}", {
    merchant_name: "{merchant_email}",
    merchant_email: "contact@alpha.test",
  });
  // Le premier jeton rend littéralement `{merchant_email}` (non
  // re-développé) ; le second rend l'adresse. Aucune cascade.
  assert.equal(rendered, "{merchant_email}contact@alpha.test");
});

test("[MALICIOUS-4] un corps hostile dépassant la borne est traité comme ABSENT (repli), jamais tronqué", () => {
  const hostileLong = HOSTILE + "y".repeat(COMMUNICATION_TEXT_MAX_LENGTH);
  const resolved = resolveCommunicationText(
    "order_success_title",
    { order_success_title: hostileLong },
    translate
  );
  assert.equal(resolved.source, "base");
  assert.equal(resolved.text, FR.confirmTitle);
});

// ---------------------------------------------------------------------
// [10] ÉVÉNEMENTS — fermés au repos (moitié PURE).
// ---------------------------------------------------------------------

test("[EVENT-1] le catalogue d'événements porte 3 codes, et PAS order_received", () => {
  assert.deepEqual([...COMMUNICATION_EVENT_CODES], [
    "carrier_handoff",
    "local_delivery_handoff",
    "withdrawal_request_received",
  ]);
  assert.equal(isCommunicationEventCode("order_received"), false);
});

test("[EVENT-2] MCC-V1-FAIL-CLOSED-EVENTS : seul le booléen `true` propre autorise l'émission", () => {
  for (const event of COMMUNICATION_EVENT_CODES) {
    assert.equal(isCommunicationEventEnabled({}, event), false);
    assert.equal(isCommunicationEventEnabled(null, event), false);
    assert.equal(isCommunicationEventEnabled(undefined, event), false);
    assert.equal(isCommunicationEventEnabled({ [event]: undefined }, event), false);
    assert.equal(isCommunicationEventEnabled({ [event]: "true" }, event), false);
    assert.equal(isCommunicationEventEnabled({ [event]: 1 }, event), false);
    assert.equal(isCommunicationEventEnabled({ [event]: {} }, event), false);
    assert.equal(isCommunicationEventEnabled({ [event]: true }, event), true);
  }
  // Une valeur héritée du prototype n'autorise rien.
  const hostile = Object.create({ carrier_handoff: true }) as Record<string, unknown>;
  assert.equal(isCommunicationEventEnabled(hostile, "carrier_handoff"), false);
});

test("[EVENT-3] la sanitisation ignore les codes inconnus et n'invente aucune activation", () => {
  const config = sanitizeCommunicationEventConfig([
    { event_code: "carrier_handoff", enabled: true },
    { event_code: "local_delivery_handoff", enabled: null },
    { event_code: "pirate_event", enabled: true },
  ]);
  assert.deepEqual(config, { carrier_handoff: true, local_delivery_handoff: false });
  assert.deepEqual(sanitizeCommunicationEventConfig(null), {});
});
