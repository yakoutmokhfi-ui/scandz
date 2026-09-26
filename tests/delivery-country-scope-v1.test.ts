import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  type DeliveryCountryOption,
  effectiveCountry,
  isValidPhoneFor,
  isValidPostalCodeFor,
  resolveDeliveryCountry,
  selectAddressProvider,
  supportsAutocomplete,
} from "@/lib/delivery-country";
import { getCustomerErrors, EMPTY_CUSTOMER } from "@/lib/customer";
import { buildCreateOrderPayload } from "@/lib/services/order-payload";

// ====================================================================
// Scanym — DELIVERY COUNTRY SCOPE v1 — logique pure.
//
// Ces tests ne connaissent AUCUN établissement : ils fournissent des
// configurations et vérifient les décisions. C'est le point : la règle
// « Au Lait Cru livre en France uniquement » doit émerger de la
// DONNÉE, et rien de ce fichier ne mentionne un slug.
// ====================================================================

const FR: DeliveryCountryOption = {
  countryCode: "FR",
  countryName: "France",
  postalCodePattern: "^[0-9]{5}$",
  phonePattern: "^(?:0[0-9]{9}|\\+33[0-9]{9})$",
  addressProvider: "ban_ign",
  addressLineOrder: "number_first",
};
const BE: DeliveryCountryOption = {
  countryCode: "BE",
  countryName: "Belgique",
  postalCodePattern: "^[0-9]{4}$",
  phonePattern: "^(?:0[0-9]{8,9}|\\+32[0-9]{8,9})$",
  addressProvider: "manual",
  addressLineOrder: "street_first",
};

// ==================================================================
// Q15 — résolution du pays
// ==================================================================

test("[Q15] zéro pays autorisé => livraison INDISPONIBLE (fail-closed)", () => {
  assert.deepEqual(resolveDeliveryCountry([]), { kind: "unavailable" });
  assert.equal(effectiveCountry(resolveDeliveryCountry([])), null);
});

test("[Q15] un seul pays => RÉSOLU automatiquement, et NON sélectionnable", () => {
  const r = resolveDeliveryCountry([FR]);
  assert.equal(r.kind, "resolved");
  assert.equal(r.kind === "resolved" && r.selectable, false);
  assert.equal(effectiveCountry(r)?.countryCode, "FR");
});

test("[Q15] plusieurs pays => choix EXPLICITE exigé, aucun défaut implicite", () => {
  const r = resolveDeliveryCountry([FR, BE]);
  assert.equal(r.kind, "pending");
  assert.equal(effectiveCountry(r), null, "aucun pays ne doit être retenu sans choix du client");
});

test("[Q15] plusieurs pays + choix du client => ce choix, exactement", () => {
  const r = resolveDeliveryCountry([FR, BE], "BE");
  assert.equal(r.kind, "selected");
  assert.equal(effectiveCountry(r)?.countryCode, "BE");
  assert.equal(r.kind === "selected" && r.selectable, true);
});

test("[Q15] un choix invalide ne retient RIEN — jamais un repli silencieux", () => {
  assert.equal(resolveDeliveryCountry([FR, BE], "ZZ").kind, "pending");
  assert.equal(effectiveCountry(resolveDeliveryCountry([FR, BE], "ZZ")), null);
});

test("[Q15] le pays n'est JAMAIS déduit du code postal", () => {
  // « 1000 » est un code postal belge valide. Avec FR et BE autorisés,
  // le résoudre à BE parce que le format correspond serait exactement
  // l'inférence que la décision CIO interdit.
  const r = resolveDeliveryCountry([FR, BE], null);
  assert.equal(r.kind, "pending");
  // Et la signature n'accepte AUCUN code postal : les seuls paramètres
  // sont la liste des pays autorisés et le choix explicite du client.
  const signature = resolveDeliveryCountry.toString().slice(0, 200);
  assert.equal(/postal/i.test(signature), false, "aucun paramètre de code postal");
});

// ==================================================================
// Validation paramétrée par le pays
// ==================================================================

test("[VALID] le code postal est validé selon LE PAYS, pas selon la France", () => {
  assert.equal(isValidPostalCodeFor(FR, "75018"), true);
  assert.equal(isValidPostalCodeFor(FR, "1000"), false, "4 chiffres invalides en France");
  assert.equal(isValidPostalCodeFor(BE, "1000"), true, "4 chiffres VALIDES en Belgique");
  assert.equal(isValidPostalCodeFor(BE, "75018"), false, "5 chiffres invalides en Belgique");
});

test("[VALID] sans pays résolu, rien n'est validé (fail-closed)", () => {
  assert.equal(isValidPostalCodeFor(null, "75018"), false);
  assert.equal(isValidPhoneFor(null, "0612345678"), false);
});

test("[VALID] le téléphone suit le même principe", () => {
  assert.equal(isValidPhoneFor(FR, "06 12 34 56 78"), true);
  assert.equal(isValidPhoneFor(BE, "0470 12 34 56"), true);
  assert.equal(isValidPhoneFor(FR, "+32470123456"), false);
});

test("[VALID] un motif corrompu ne bloque pas le client — le serveur tranchera", () => {
  const broken: DeliveryCountryOption = { ...FR, postalCodePattern: "^[0-9" };
  assert.equal(isValidPostalCodeFor(broken, "75018"), true);
});

test("[VALID] getCustomerErrors applique les motifs du pays fourni", () => {
  const belge = { ...EMPTY_CUSTOMER, postalCode: "1000", city: "Bruxelles", street: "Rue de la Loi 16" };
  const sansMotif = getCustomerErrors(belge, ["postalCode"]);
  assert.equal(sansMotif.postalCode, "errPostalCode", "sans motif : règle française historique");
  const avecMotif = getCustomerErrors(belge, ["postalCode"], { postalCodePattern: "^[0-9]{4}$" });
  assert.equal(avecMotif.postalCode, undefined, "avec le motif belge : accepté");
});

test("[COMPAT] getCustomerErrors sans motifs se comporte EXACTEMENT comme avant", () => {
  const fr = { ...EMPTY_CUSTOMER, postalCode: "75018", phone: "0612345678" };
  assert.deepEqual(getCustomerErrors(fr, ["postalCode", "phone"]), {});
  const ko = { ...EMPTY_CUSTOMER, postalCode: "7501", phone: "12" };
  assert.deepEqual(getCustomerErrors(ko, ["postalCode", "phone"]), {
    postalCode: "errPostalCode",
    phone: "errPhone",
  });
});

// ==================================================================
// Isolation du fournisseur d'adresse
// ==================================================================

test("[PROVIDER] le fournisseur est DÉRIVÉ du pays, jamais choisi", () => {
  assert.equal(selectAddressProvider(FR), "ban_ign");
  assert.equal(selectAddressProvider(BE), "manual");
});

test("[PROVIDER] aucun pays résolu => manual, jamais le fournisseur d'un autre pays", () => {
  assert.equal(selectAddressProvider(null), "manual");
  assert.equal(supportsAutocomplete(null), false);
});

test("[PROVIDER] la Belgique n'obtient PAS l'autocomplétion française", () => {
  // Fondement factuel : le 2026-09-24, la BAN interrogée sur « Rue de
  // la Loi 16 Bruxelles » a retourné trois rues FRANÇAISES. Un repli
  // inter-pays ne produirait donc pas « aucun résultat » mais une
  // mauvaise adresse d'apparence normale.
  assert.equal(supportsAutocomplete(BE), false);
  assert.notEqual(selectAddressProvider(BE), "ban_ign");
});

// ==================================================================
// Charge utile
// ==================================================================

const LINES = [
  { item: { id: "i1", name: "Comté", price: 10 }, quantity: 1, option: null },
] as never[];

function ctx(country: Record<string, string>) {
  return {
    mode: "delivery" as const,
    customer: {
      ...EMPTY_CUSTOMER,
      name: "Victor Hugo",
      firstName: "Victor",
      lastName: "Hugo",
      phone: "0612345678",
      email: "victor.hugo@example.test",
      street: "12 rue Ordener",
      postalCode: "75018",
      city: "Paris",
      ...country,
    },
  };
}

test("[PAYLOAD] le pays résolu est transmis explicitement", () => {
  const p = buildCreateOrderPayload({
    slug: "s",
    context: ctx({}) as never,
    lines: LINES,
    lang: "fr",
    deliveryCountryCode: "FR",
  });
  assert.equal((p.p_customer as Record<string, unknown>).country, "FR");
});

test("[PAYLOAD/COMPAT] un appelant historique n'envoie AUCUN pays — le serveur résoudra", () => {
  const p = buildCreateOrderPayload({
    slug: "s",
    context: ctx({}) as never,
    lines: LINES,
    lang: "fr",
  });
  assert.equal((p.p_customer as Record<string, unknown>).country, null);
});

test("[PAYLOAD] hors livraison, aucun pays n'est transmis", () => {
  const p = buildCreateOrderPayload({
    slug: "s",
    context: { mode: "pickup", customer: ctx({}).customer } as never,
    lines: LINES,
    lang: "fr",
    deliveryCountryCode: "FR",
  });
  // Hors livraison, le champ est présent mais NUL : même discipline que
  // `address`, `street` et `city`, qui sont déjà nuls dans ce mode.
  assert.equal((p.p_customer as Record<string, unknown>).country, null);
});

test("[PAYLOAD] la structure reste STRUCTURÉE — aucun reparsing", () => {
  const p = buildCreateOrderPayload({
    slug: "s",
    context: ctx({}) as never,
    lines: LINES,
    lang: "fr",
    deliveryCountryCode: "FR",
  });
  const c = p.p_customer as Record<string, unknown>;
  assert.equal(c.postalCode, "75018");
  assert.equal(c.street, "12 rue Ordener");
  assert.equal(c.city, "Paris");
});

// ==================================================================
// INTERDICTION DE CODAGE EN DUR (exigence CIO)
// ==================================================================

function sourceFiles(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry);
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
  };
  for (const d of dirs) walk(path.join(process.cwd(), d));
  return out;
}

const APP_SOURCES = sourceFiles(["lib", "components", "app"]).filter(
  (f) => !f.includes("/tests/")
);

/** Code EXÉCUTABLE seul : les commentaires peuvent légitimement citer un
 *  établissement (documentation d'incident, exemple). Ce qui est
 *  proscrit, c'est une BRANCHE métier portant un nom de marchand. */
function executableCode(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ");
}

test("[NO-HARDCODE] aucune BRANCHE applicative ne porte un nom d'établissement", () => {
  const offenders = APP_SOURCES.filter((f) => /au[-_ ]?lait[-_ ]?cru/i.test(executableCode(f)));
  assert.deepEqual(offenders, [], `règle métier codée en dur dans : ${offenders.join(", ")}`);
});

test("[NO-HARDCODE] aucune comparaison de slug ne pilote la livraison", () => {
  const offenders = APP_SOURCES.filter((f) => {
    const code = executableCode(f);
    // Comparaison d'un slug à un littéral NON VIDE : `slug === ""` est
    // un contrôle de vacuité légitime, pas une règle métier.
    return /slug\s*===\s*["\'`][^"\'`]+["\'`]/.test(code) && /country|delivery/i.test(code);
  });
  assert.deepEqual(offenders, [], `comparaison de slug pilotant la livraison : ${offenders.join(", ")}`);
});

test("[NO-HARDCODE] le parcours d'adresse ne contient plus de pays littéral", () => {
  // `FulfillmentSelector` portait `countryCode: "FR"` en dur ; il doit
  // désormais lire le pays résolu.
  const sel = readFileSync(path.join(process.cwd(), "components/FulfillmentSelector.tsx"), "utf8");
  assert.equal(/countryCode:\s*"FR"/.test(sel), false, "FulfillmentSelector ne doit plus figer FR");
  assert.ok(sel.includes("deliveryCountry"), "il doit consommer le pays résolu");
});

test("[NO-HARDCODE] le module de décision ne connaît aucun pays ni aucun motif", () => {
  const mod = readFileSync(path.join(process.cwd(), "lib/delivery-country.ts"), "utf8");
  const code = mod.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const forbidden of ['"FR"', "'FR'", '"BE"', "'BE'", "\\d{5}", "\\d{4}"]) {
    assert.equal(
      code.includes(forbidden),
      false,
      `le module de décision ne doit pas contenir ${forbidden}`
    );
  }
});

test("[NO-HARDCODE] la validation client n'impose plus un format unique au monde entier", () => {
  const cust = readFileSync(path.join(process.cwd(), "lib/customer.ts"), "utf8");
  assert.ok(
    cust.includes("CustomerValidationPatterns"),
    "getCustomerErrors doit accepter des motifs par pays"
  );
});
