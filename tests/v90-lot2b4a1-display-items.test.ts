import { test } from "node:test";
import assert from "node:assert/strict";

// Import dynamique obligatoire (patron déjà établi,
// tests/v84-lot2b1.test.ts) : les variables d'environnement doivent
// être définies AVANT que lib/supabase.ts ne soit chargé (importé
// transitivement par lib/sale-modes-public.ts et
// lib/use-public-field-requirements.ts) ; un import statique serait
// hoisté avant ce code.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { buildFieldRequirementDisplayItems, groupFieldRequirements, validateCustomerData } =
  await import("../lib/sale-modes-public.ts");
const { canAttemptSubmit } = await import("../lib/use-public-field-requirements.ts");

// ====================================================================
// LOT 2B.4a.1 -- tests unitaires purs (aucun DOM, aucun réseau) des
// fondations génériques : helper d'affichage one_of
// (buildFieldRequirementDisplayItems), contrat fail-closed
// (canAttemptSubmit), et preuve de RÉUTILISATION (pas de seconde
// implémentation) de validateCustomerData/groupFieldRequirements
// (LOT 2B.1) avec le vrai catalogue backend
// (migration-v82-lot2a-sale-modes.sql : pickup, delivery).
// ====================================================================

test("LOT 2B.4a.1 (requirements required): un champ required isolé devient un élément 'field'", () => {
  const items = buildFieldRequirementDisplayItems([
    { field: "customer_name", requirement: "required", oneOfGroup: null },
  ]);
  assert.deepEqual(items, [
    { kind: "field", requirement: { field: "customer_name", requirement: "required", oneOfGroup: null } },
  ]);
});

test("LOT 2B.4a.1 (requirements optional): un champ optional isolé devient un élément 'field', jamais confondu avec required", () => {
  const items = buildFieldRequirementDisplayItems([
    { field: "email", requirement: "optional", oneOfGroup: null },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "field");
  assert.equal((items[0] as any).requirement.requirement, "optional");
});

test("LOT 2B.4a.1 (one_of, nom de groupe arbitraire): un groupe one_of totalement inédit est fusionné en UN SEUL élément, jamais un nom supposé à l'avance", () => {
  const items = buildFieldRequirementDisplayItems([
    { field: "carrier_pigeon_id", requirement: "one_of", oneOfGroup: "avian_delivery_proof_of_concept" },
    { field: "carrier_pigeon_ring_number", requirement: "one_of", oneOfGroup: "avian_delivery_proof_of_concept" },
  ]);
  assert.equal(items.length, 1, "les 2 champs du même groupe ne doivent produire qu'UN SEUL élément, jamais un par champ");
  assert.deepEqual(items[0], {
    kind: "one_of_group",
    groupName: "avian_delivery_proof_of_concept",
    fields: [
      { field: "carrier_pigeon_id", requirement: "one_of", oneOfGroup: "avian_delivery_proof_of_concept" },
      { field: "carrier_pigeon_ring_number", requirement: "one_of", oneOfGroup: "avian_delivery_proof_of_concept" },
    ],
  });
});

test("LOT 2B.4a.1: ordre d'affichage préservé -- un groupe one_of apparaît au rang de sa PREMIÈRE occurrence, mélangé avec des champs isolés, avec DEUX groupes distincts (click & collect: contact ; reachability)", () => {
  const requirements = [
    { field: "customer_name", requirement: "required" as const, oneOfGroup: null },
    { field: "phone", requirement: "one_of" as const, oneOfGroup: "contact" },
    { field: "room_number", requirement: "one_of" as const, oneOfGroup: "reachability" },
    { field: "email", requirement: "one_of" as const, oneOfGroup: "contact" },
    { field: "notes", requirement: "optional" as const, oneOfGroup: null },
  ];
  const items = buildFieldRequirementDisplayItems(requirements);
  assert.equal(items.length, 4, "5 exigences -> 4 éléments d'affichage (le groupe contact fusionne 2 champs en 1)");
  assert.deepEqual(
    items.map((i) => (i.kind === "field" ? i.requirement.field : `group:${i.groupName}`)),
    ["customer_name", "group:contact", "group:reachability", "notes"]
  );
  const contactGroup = items[1] as any;
  assert.deepEqual(contactGroup.fields.map((f: any) => f.field), ["phone", "email"], "les 2 membres du groupe contact, dans leur ordre d'apparition d'origine");
});

test("LOT 2B.4a.1: tableau vide -- aucun élément, jamais une exception", () => {
  assert.deepEqual(buildFieldRequirementDisplayItems([]), []);
});

test("LOT 2B.4a.1 (catalogue réel 'delivery'): customer_name/delivery_address/phone required, email optional, aucun groupe one_of -- 4 éléments 'field' distincts", () => {
  const requirements = [
    { field: "customer_name", requirement: "required" as const, oneOfGroup: null },
    { field: "delivery_address", requirement: "required" as const, oneOfGroup: null },
    { field: "phone", requirement: "required" as const, oneOfGroup: null },
    { field: "email", requirement: "optional" as const, oneOfGroup: null },
  ];
  const items = buildFieldRequirementDisplayItems(requirements);
  assert.equal(items.length, 4);
  assert.ok(items.every((i) => i.kind === "field"));
});

test("LOT 2B.4a.1 (catalogue réel 'pickup'/'click_collect'): customer_name required + groupe one_of 'contact' (phone/email) -- 2 éléments", () => {
  const requirements = [
    { field: "customer_name", requirement: "required" as const, oneOfGroup: null },
    { field: "phone", requirement: "one_of" as const, oneOfGroup: "contact" },
    { field: "email", requirement: "one_of" as const, oneOfGroup: "contact" },
  ];
  const items = buildFieldRequirementDisplayItems(requirements);
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, "field");
  assert.equal(items[1].kind, "one_of_group");
});

// --------------------------------------------------------------------
// canAttemptSubmit -- contrat fail-closed (section 11 de la mission)
// --------------------------------------------------------------------

test("LOT 2B.4a.1 (fail-closed): loading -- soumission impossible", () => {
  assert.equal(canAttemptSubmit({ status: "loading" }), false);
});

test("LOT 2B.4a.1 (fail-closed): error -- soumission impossible", () => {
  assert.equal(canAttemptSubmit({ status: "error" }), false);
});

test("LOT 2B.4a.1 (fail-closed): loaded([]) -- réponse métier valide, soumission AUTORISÉE (aucune exigence pour ce mode)", () => {
  assert.equal(canAttemptSubmit({ status: "loaded", data: [] }), true);
});

test("LOT 2B.4a.1 (fail-closed): loaded([...]) -- soumission autorisée (la validation fine des champs reste séparée, via validateCustomerData)", () => {
  assert.equal(
    canAttemptSubmit({ status: "loaded", data: [{ field: "customer_name", requirement: "required", oneOfGroup: null }] }),
    true
  );
});

test("LOT 2B.4a.1 (fail-closed): loading et loaded([]) ne sont jamais confondus par égalité structurelle", () => {
  assert.notDeepEqual({ status: "loading" }, { status: "loaded", data: [] });
});

// --------------------------------------------------------------------
// Réutilisation de validateCustomerData/groupFieldRequirements (LOT
// 2B.1) avec le vrai catalogue backend -- AUCUNE seconde
// implémentation écrite pour ce lot (section 8 de la mission).
// --------------------------------------------------------------------

test("LOT 2B.4a.1: validateCustomerData rejouée avec le vrai catalogue 'delivery' (customer_name/delivery_address/phone required, email optional)", () => {
  const requirements = [
    { field: "customer_name", requirement: "required" as const, oneOfGroup: null },
    { field: "delivery_address", requirement: "required" as const, oneOfGroup: null },
    { field: "phone", requirement: "required" as const, oneOfGroup: null },
    { field: "email", requirement: "optional" as const, oneOfGroup: null },
  ];

  const empty = validateCustomerData(requirements, {});
  assert.deepEqual(empty.missingRequired.sort(), ["customer_name", "delivery_address", "phone"]);
  assert.deepEqual(empty.unsatisfiedGroups, []);

  const partial = validateCustomerData(requirements, { customer_name: "Sam", delivery_address: "12 rue des Lilas, 92100 Boulogne" });
  assert.deepEqual(partial.missingRequired, ["phone"]);

  const complete = validateCustomerData(requirements, {
    customer_name: "Sam",
    delivery_address: "12 rue des Lilas, 92100 Boulogne",
    phone: "0600000000",
  });
  assert.deepEqual(complete.missingRequired, []);
  assert.deepEqual(complete.unsatisfiedGroups, []);
});

test("LOT 2B.4a.1: validateCustomerData rejouée avec le vrai catalogue 'pickup'/'click_collect' (groupe one_of 'contact' phone/email)", () => {
  const requirements = [
    { field: "customer_name", requirement: "required" as const, oneOfGroup: null },
    { field: "phone", requirement: "one_of" as const, oneOfGroup: "contact" },
    { field: "email", requirement: "one_of" as const, oneOfGroup: "contact" },
  ];

  const noContact = validateCustomerData(requirements, { customer_name: "Sam" });
  assert.deepEqual(noContact.unsatisfiedGroups, ["contact"]);

  const withPhoneOnly = validateCustomerData(requirements, { customer_name: "Sam", phone: "0600000000" });
  assert.deepEqual(withPhoneOnly.missingRequired, []);
  assert.deepEqual(withPhoneOnly.unsatisfiedGroups, []);

  const withEmailOnly = validateCustomerData(requirements, { customer_name: "Sam", email: "sam@exemple.fr" });
  assert.deepEqual(withEmailOnly.unsatisfiedGroups, []);
});

test("LOT 2B.4a.1: groupFieldRequirements (LOT 2B.1) reste directement réutilisable tel quel sur le catalogue 'delivery' -- aucun required n'est classé à tort en optional ou en groupe", () => {
  const requirements = [
    { field: "customer_name", requirement: "required" as const, oneOfGroup: null },
    { field: "delivery_address", requirement: "required" as const, oneOfGroup: null },
    { field: "phone", requirement: "required" as const, oneOfGroup: null },
    { field: "email", requirement: "optional" as const, oneOfGroup: null },
  ];
  const { required, optional, oneOfGroups } = groupFieldRequirements(requirements);
  assert.deepEqual(required.map((r) => r.field).sort(), ["customer_name", "delivery_address", "phone"]);
  assert.deepEqual(optional.map((r) => r.field), ["email"]);
  assert.equal(oneOfGroups.size, 0);
});
