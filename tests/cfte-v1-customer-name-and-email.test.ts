import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_CUSTOMER,
  formatCustomerDisplayName,
  genericFieldFormatError,
  getCustomerErrors,
  type CustomerInfo,
} from "../lib/customer.ts";
import { buildCreateOrderPayload } from "../lib/services/order-payload.ts";
import { validateCustomerData } from "../lib/sale-modes-public.ts";
import type { SaleModeFieldRequirement } from "../lib/sale-modes-types.ts";
import { DICTS, translate } from "../lib/i18n.ts";

/**
 * CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 — prénom/nom séparés, e-mail
 * obligatoire pour les modes suivis, côté CLIENT.
 *
 * Tout ce fichier est PUR : aucun DOM, aucun réseau, aucune base.
 *
 * Invariants couverts :
 *   - le nom d'affichage est COMPOSÉ, jamais persisté en deux champs ;
 *   - aucune clé de payload ne désigne une colonne inexistante ;
 *   - le chemin HISTORIQUE (nom en un seul champ, modes non suivis)
 *     reste rigoureusement inchangé ;
 *   - la validation client suit les exigences EFFECTIVES reçues du
 *     serveur -- elle ne décide jamais elle-même quels champs sont
 *     requis pour un mode.
 */

const customer = (patch: Partial<CustomerInfo> = {}): CustomerInfo => ({
  ...EMPTY_CUSTOMER,
  ...patch,
});

// ---------------------------------------------------------------
// 1. Composition du nom d'affichage.
// ---------------------------------------------------------------

test("1a. prénom + nom -> « Prénom Nom »", () => {
  assert.equal(
    formatCustomerDisplayName(customer({ firstName: "Myriam", lastName: "Benali" })),
    "Myriam Benali"
  );
});

test("1b. prénom seul (retrait : le nom de famille est optionnel) -> le prénom seul", () => {
  assert.equal(formatCustomerDisplayName(customer({ firstName: "Myriam" })), "Myriam");
});

test("1c. blancs de bordure et espaces internes normalisés, jamais d'espace orphelin", () => {
  assert.equal(
    formatCustomerDisplayName(customer({ firstName: "  Myriam  ", lastName: "  Benali " })),
    "Myriam Benali"
  );
  assert.equal(formatCustomerDisplayName(customer({ firstName: "  ", lastName: "Benali" })), "Benali");
});

test("1d. CHEMIN HISTORIQUE : aucun prénom/nom saisi -> repli sur `name`, inchangé", () => {
  assert.equal(formatCustomerDisplayName(customer({ name: "Illico Client" })), "Illico Client");
  assert.equal(formatCustomerDisplayName(customer()), "");
});

test("1e. prénom/nom saisis -> ils l'emportent sur `name` (le serveur recompose de la même façon)", () => {
  assert.equal(
    formatCustomerDisplayName(customer({ name: "ignoré", firstName: "A", lastName: "B" })),
    "A B"
  );
});

test("1f. borne de 120 caractères -- MIROIR du left(..., 120) de create_order", () => {
  const long = formatCustomerDisplayName(
    customer({ firstName: "x".repeat(100), lastName: "y".repeat(100) })
  );
  assert.equal(long.length, 120);
});

/**
 * 1g/1h -- CONTRAT DE COMPATIBILITÉ (remédiation) : un objet client
 * HISTORIQUE, construit SANS `firstName`/`lastName`, reste un
 * `CustomerInfo` valide.
 *
 * Ces deux tests sont volontairement écrits SANS transtypage
 * (`as unknown as CustomerInfo`) : c'est l'annotation `: CustomerInfo`
 * ci-dessous qui porte l'assertion. Si `firstName`/`lastName`
 * redevenaient un jour obligatoires dans l'interface, ce fichier
 * cesserait de compiler -- le contrat est donc verrouillé par le
 * typecheck, pas seulement par une exécution.
 */
const LEGACY_CUSTOMER: CustomerInfo = {
  name: "Ancien Contexte",
  street: "",
  postalCode: "",
  city: "",
  phone: "0612345678",
  email: "",
};

test("1g. lecture défensive : un objet sans firstName/lastName ne lève jamais", () => {
  assert.doesNotThrow(() => formatCustomerDisplayName(LEGACY_CUSTOMER));
  assert.equal(formatCustomerDisplayName(LEGACY_CUSTOMER), "Ancien Contexte");
});

test("1h. ÉCHEC FERMÉ : une clé ABSENTE est signalée exactement comme une valeur vide", () => {
  // La règle produit (prénom requis en retrait/livraison suivis, nom de
  // famille requis en livraison) n'est PAS portée par le type -- elle
  // est portée par les exigences effectives du serveur. L'optionalité
  // de `firstName`/`lastName` ne doit donc rien relâcher : dès que
  // l'appelant demande de les vérifier, leur absence est une erreur.
  const errors = getCustomerErrors(LEGACY_CUSTOMER, ["firstName", "lastName"]);
  assert.equal(errors.firstName, "errFirstName");
  assert.equal(errors.lastName, "errLastName");

  // Les champs historiques, eux, restent validés à l'identique.
  assert.deepEqual(getCustomerErrors(LEGACY_CUSTOMER, ["name", "phone"]), {});
});

test("1i. l'état INITIAL du formulaire porte bien les deux clés -- les champs restent contrôlés", () => {
  // Corollaire de l'optionalité : elle décrit les appelants HORS
  // formulaire. Le checkout, lui, part toujours de EMPTY_CUSTOMER, qui
  // DOIT continuer d'initialiser les deux clés à "" -- sinon les deux
  // <input> basculeraient de non contrôlés à contrôlés à la première
  // frappe (avertissement React et curseur qui saute).
  assert.equal(EMPTY_CUSTOMER.firstName, "");
  assert.equal(EMPTY_CUSTOMER.lastName, "");
  assert.ok(Object.prototype.hasOwnProperty.call(EMPTY_CUSTOMER, "firstName"));
  assert.ok(Object.prototype.hasOwnProperty.call(EMPTY_CUSTOMER, "lastName"));
});

// ---------------------------------------------------------------
// 2. Charge create_order.
// ---------------------------------------------------------------

const LINES = [
  { item: { id: "11111111-1111-4111-8111-111111111111" }, quantity: 1, option: null },
] as unknown as Parameters<typeof buildCreateOrderPayload>[0]["lines"];

function pickupPayload(patch: Partial<CustomerInfo>) {
  return buildCreateOrderPayload({
    slug: "aulaitcru",
    context: { mode: "pickup", customer: customer(patch) },
    lines: LINES,
    lang: "fr",
  });
}

test("2a-bis. COMPATIBILITÉ : un client HISTORIQUE (aucune clé prénom/nom) produit la charge d'AVANT ce lot", () => {
  const c = buildCreateOrderPayload({
    slug: "aulaitcru",
    context: { mode: "pickup", customer: LEGACY_CUSTOMER },
    lines: LINES,
    lang: "fr",
  }).p_customer as Record<string, unknown>;
  assert.equal(c.name, "Ancien Contexte", "`name` doit rester rigoureusement inchangé");
  assert.equal(c.first_name, null);
  assert.equal(c.last_name, null);
});

test("2a. prénom/nom transmis SÉPARÉMENT pour la validation serveur, et le nom COMPOSÉ dans `name`", () => {
  const p = pickupPayload({ firstName: "Myriam", lastName: "Benali", email: "m@example.fr" });
  const c = p.p_customer as Record<string, unknown>;
  assert.equal(c.first_name, "Myriam");
  assert.equal(c.last_name, "Benali");
  assert.equal(c.name, "Myriam Benali");
  assert.equal(c.email, "m@example.fr");
});

test("2b. chemin HISTORIQUE : nom en un seul champ -> first_name/last_name valent null, `name` inchangé", () => {
  const c = pickupPayload({ name: "Illico Client" }).p_customer as Record<string, unknown>;
  assert.equal(c.name, "Illico Client");
  assert.equal(c.first_name, null);
  assert.equal(c.last_name, null);
});

test("2c. le payload ne porte AUCUNE clé suggérant une colonne persistante prénom/nom", () => {
  const c = pickupPayload({ firstName: "A", lastName: "B" }).p_customer as Record<string, unknown>;
  for (const forbidden of ["customer_first_name", "customer_last_name", "firstName", "lastName"]) {
    assert.equal(forbidden in c, false, `${forbidden} ne doit jamais être transmis`);
  }
});

test("2d. mode table : p_customer reste STRICTEMENT vide (aucune donnée client, aucune régression)", () => {
  const p = buildCreateOrderPayload({
    slug: "aulaitcru",
    context: { mode: "table", tableNumber: 4 },
    lines: LINES,
    lang: "fr",
  });
  assert.deepEqual(p.p_customer, {});
});

test("2e. les clés de premier niveau de la charge sont INCHANGÉES", () => {
  const p = pickupPayload({ firstName: "A" });
  assert.deepEqual(Object.keys(p).sort(), [
    "p_cgv_accepted",
    "p_customer",
    "p_items",
    "p_language",
    "p_note",
    "p_service_mode",
    "p_slug",
    "p_table_number",
  ]);
});

// ---------------------------------------------------------------
// 3. Validation client pilotée par les exigences EFFECTIVES.
// ---------------------------------------------------------------

/** Ce que le résolveur SQL renvoie DÉSORMAIS pour un mode suivi :
 *  plus de `customer_name`, un `first_name` requis, un `last_name`
 *  requis en livraison, et un `email` requis NON RELAXABLE. */
const DELIVERY_REQS: SaleModeFieldRequirement[] = [
  { field: "first_name", requirement: "required", oneOfGroup: null },
  { field: "last_name", requirement: "required", oneOfGroup: null },
  { field: "delivery_address", requirement: "required", oneOfGroup: null },
  { field: "phone", requirement: "required", oneOfGroup: null },
  { field: "email", requirement: "required", oneOfGroup: null },
];

const PICKUP_REQS: SaleModeFieldRequirement[] = [
  { field: "first_name", requirement: "required", oneOfGroup: null },
  { field: "last_name", requirement: "optional", oneOfGroup: null },
  { field: "phone", requirement: "optional", oneOfGroup: null },
  { field: "email", requirement: "required", oneOfGroup: null },
];

function customerData(c: CustomerInfo): Record<string, string> {
  return {
    customer_name: c.name,
    // MIROIR de components/MenuView.tsx (customerData) : une clé
    // optionnelle absente devient "" dans CustomerData, donc "non
    // saisie" pour validateCustomerData().
    first_name: c.firstName ?? "",
    last_name: c.lastName ?? "",
    phone: c.phone,
    email: c.email,
    delivery_address:
      c.street.trim() !== "" && c.postalCode.trim() !== "" && c.city.trim() !== ""
        ? `${c.street.trim()}, ${c.postalCode.trim()} ${c.city.trim()}`
        : "",
  };
}

test("3a. retrait : e-mail manquant -> soumission bloquée (l'e-mail n'est plus jamais un simple `one_of`)", () => {
  const { missingRequired, unsatisfiedGroups } = validateCustomerData(
    PICKUP_REQS,
    customerData(customer({ firstName: "Myriam", phone: "0612345678" }))
  );
  assert.deepEqual(missingRequired, ["email"]);
  assert.deepEqual(unsatisfiedGroups, []);
});

test("3b. retrait : prénom obligatoire, nom de famille NON obligatoire", () => {
  const withoutLast = validateCustomerData(
    PICKUP_REQS,
    customerData(customer({ firstName: "Myriam", email: "m@example.fr" }))
  );
  assert.deepEqual(withoutLast.missingRequired, [], "le nom de famille n'est pas exigé au retrait");

  const withoutFirst = validateCustomerData(
    PICKUP_REQS,
    customerData(customer({ lastName: "Benali", email: "m@example.fr" }))
  );
  assert.deepEqual(withoutFirst.missingRequired, ["first_name"]);
});

test("3c. livraison : prénom ET nom obligatoires, e-mail obligatoire", () => {
  const complete = customer({
    firstName: "Myriam",
    lastName: "Benali",
    phone: "0612345678",
    email: "m@example.fr",
    street: "12 rue des Lilas",
    postalCode: "75001",
    city: "Paris",
  });
  assert.deepEqual(validateCustomerData(DELIVERY_REQS, customerData(complete)).missingRequired, []);

  assert.deepEqual(
    validateCustomerData(DELIVERY_REQS, customerData({ ...complete, lastName: "" })).missingRequired,
    ["last_name"]
  );
  assert.deepEqual(
    validateCustomerData(DELIVERY_REQS, customerData({ ...complete, email: "" })).missingRequired,
    ["email"]
  );
});

test("3d. les modes NON suivis restent pilotés par `customer_name` -- aucun changement", () => {
  const ROOM_SERVICE_REQS: SaleModeFieldRequirement[] = [
    { field: "room_number", requirement: "required", oneOfGroup: null },
    { field: "customer_name", requirement: "required", oneOfGroup: null },
  ];
  const data = { ...customerData(customer({ name: "Client Chambre" })), room_number: "12" };
  assert.deepEqual(validateCustomerData(ROOM_SERVICE_REQS, data).missingRequired, []);
  assert.deepEqual(
    validateCustomerData(ROOM_SERVICE_REQS, { ...data, customer_name: "" }).missingRequired,
    ["customer_name"]
  );
});

// ---------------------------------------------------------------
// 4. Erreurs de FORMAT des deux nouveaux champs.
// ---------------------------------------------------------------

test("4a. genericFieldFormatError couvre first_name / last_name avec la MÊME règle que customer_name", () => {
  assert.equal(genericFieldFormatError("first_name", "M"), "errFirstName");
  assert.equal(genericFieldFormatError("first_name", "Myriam"), undefined);
  assert.equal(genericFieldFormatError("last_name", " "), "errLastName");
  assert.equal(genericFieldFormatError("last_name", "Benali"), undefined);
  // Règle identique à celle du champ historique (aucune règle inventée).
  assert.equal(genericFieldFormatError("customer_name", "M"), "errName");
});

test("4b. getCustomerErrors sait signaler firstName/lastName", () => {
  const errors = getCustomerErrors(customer({ firstName: "M", lastName: "" }), [
    "firstName",
    "lastName",
  ]);
  assert.equal(errors.firstName, "errFirstName");
  assert.equal(errors.lastName, "errLastName");
});

// (Le câblage RÉEL de ces règles dans le formulaire actif -- rendu des
//  deux champs, erreurs affichées, aucune saisie perdue -- est prouvé
//  dans un vrai DOM par tests/cfte-v1-checkout-name-fields.dom.test.ts,
//  jamais par lecture de source.)

// ---------------------------------------------------------------
// 5. i18n : parité stricte des nouvelles clés.
// ---------------------------------------------------------------

test("5. les libellés/erreurs des deux champs existent dans fr/en/ar", () => {
  for (const lang of ["fr", "en", "ar"] as const) {
    for (const key of ["fieldName", "fieldLastName", "errFirstName", "errLastName"]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(DICTS[lang], key),
        `clé ${key} absente du dictionnaire ${lang}`
      );
      assert.notEqual(translate(lang, key), key, `${lang}/${key} non traduite`);
    }
    // Deux champs DISTINCTS doivent porter deux libellés DISTINCTS.
    assert.notEqual(
      translate(lang, "fieldName"),
      translate(lang, "fieldLastName"),
      `${lang} : prénom et nom ne doivent pas partager le même libellé`
    );
  }
});
