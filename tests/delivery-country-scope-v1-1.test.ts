import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type DeliveryCountryOption,
  countryValidationInput,
  effectiveCountry,
  postalCodeErrorKeyFor,
  resolveDeliveryCountry,
} from "@/lib/delivery-country";
import { getCustomerErrors, EMPTY_CUSTOMER } from "@/lib/customer";
import { translate } from "@/lib/i18n";

// ====================================================================
// Scanym — DELIVERY COUNTRY SCOPE v1.1 — remédiation DCS-COUNTRY-UI-02
// (logique pure).
//
// Prouve que l'entrée de validation client est DÉRIVÉE du pays résolu
// (donc recalculée à chaque changement de pays), et qu'un pays manquant
// en livraison échoue FERMÉ : jamais de repli silencieux sur les règles
// françaises historiques.
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

const ADDR: (keyof typeof EMPTY_CUSTOMER)[] = ["street", "postalCode", "city"];

/** Même chaîne que MenuView : options -> résolution -> pays -> validation. */
function errorsFor(
  options: DeliveryCountryOption[],
  selected: string | null,
  customer: Partial<typeof EMPTY_CUSTOMER>,
  isDelivery = true
) {
  const country = effectiveCountry(resolveDeliveryCountry(options, selected));
  const v = countryValidationInput(isDelivery, country);
  return {
    v,
    errors: getCustomerErrors({ ...EMPTY_CUSTOMER, ...customer }, ADDR, {
      postalCodePattern: v.postalCodePattern,
      phonePattern: v.phonePattern,
      deliveryCountryMissing: v.countryMissing,
      postalCodeErrorKey: v.postalCodeErrorKey,
    }),
  };
}

const PARIS = { street: "12 rue Ordener", postalCode: "75018", city: "Paris" };
const BXL = { street: "Rue de la Loi 16", postalCode: "1000", city: "Bruxelles" };

test("[UI-02/SWITCH] FR -> BE : le MÊME code postal saisi est revalidé pour le nouveau pays", () => {
  const avant = errorsFor([FR, BE], "FR", PARIS);
  assert.equal(avant.errors.postalCode, undefined, "75018 valide en France");
  const apres = errorsFor([FR, BE], "BE", PARIS);
  assert.equal(apres.v.postalCodePattern, BE.postalCodePattern, "le motif suit le pays choisi");
  assert.equal(apres.errors.postalCode, "errPostalCode_BE", "75018 invalide en Belgique -- message BELGE");
});

test("[UI-02/SWITCH] BE -> FR : le MÊME code postal saisi est revalidé pour le nouveau pays", () => {
  const avant = errorsFor([FR, BE], "BE", BXL);
  assert.equal(avant.errors.postalCode, undefined, "1000 valide en Belgique");
  const apres = errorsFor([FR, BE], "FR", BXL);
  assert.equal(apres.v.postalCodePattern, FR.postalCodePattern);
  assert.equal(apres.errors.postalCode, "errPostalCode_FR", "1000 invalide en France -- message FRANÇAIS");
});

test("[UI-02/MISSING] multi-pays sans choix : pays MANQUANT, code postal refusé (aucun repli FR)", () => {
  // En v1, ce cas retombait sur ^\d{5}$ : 75018 passait sans pays.
  const r = errorsFor([FR, BE], null, PARIS);
  assert.equal(r.v.countryMissing, true);
  assert.equal(r.v.postalCodePattern, null);
  assert.equal(r.errors.postalCode, "errDeliveryCountryRequired");
});

test("[UI-02/MISSING] aucun pays (ou chargement) : pays MANQUANT, code postal refusé", () => {
  const r = errorsFor([], null, PARIS);
  assert.equal(r.v.countryMissing, true);
  assert.equal(r.errors.postalCode, "errDeliveryCountryRequired");
});

test("[UI-02/MISSING] un code pays sélectionné mais NON autorisé ne vaut pas pays résolu", () => {
  const r = errorsFor([FR, BE], "DE", PARIS);
  assert.equal(r.v.countryMissing, true);
  assert.equal(r.errors.postalCode, "errDeliveryCountryRequired");
});

test("[UI-02/SCOPE] hors livraison, aucun pays n'est exigé (pickup/table inchangés)", () => {
  assert.deepEqual(countryValidationInput(false, null), {
    postalCodePattern: null,
    phonePattern: null,
    countryMissing: false,
    postalCodeErrorKey: null,
  });
  assert.deepEqual(countryValidationInput(false, FR), {
    postalCodePattern: null,
    phonePattern: null,
    countryMissing: false,
    postalCodeErrorKey: null,
  });
});

test("[UI-02/COMPAT] un seul pays : résolu, validé selon SA donnée (FR et BE, même code)", () => {
  assert.equal(errorsFor([FR], null, PARIS).errors.postalCode, undefined);
  assert.equal(errorsFor([BE], null, BXL).errors.postalCode, undefined);
  assert.equal(errorsFor([BE], null, PARIS).errors.postalCode, "errPostalCode_BE");
});

test("[UI-02/COMPAT] getCustomerErrors sans le drapeau v1.1 : comportement v1 strictement identique", () => {
  const ko = { ...EMPTY_CUSTOMER, postalCode: "7501" };
  assert.deepEqual(getCustomerErrors(ko, ["postalCode"]), { postalCode: "errPostalCode" });
  assert.deepEqual(getCustomerErrors(ko, ["postalCode"], { deliveryCountryMissing: false }), {
    postalCode: "errPostalCode",
  });
});

test("[UI-02/WIRING] MenuView : le mémo de validation DÉPEND du pays, et la soumission exige un pays", () => {
  const src = readFileSync(path.join(process.cwd(), "components", "MenuView.tsx"), "utf8");
  const memo = src.slice(src.indexOf("const customerErrors = useMemo("));
  const deps = memo.slice(memo.indexOf("["), memo.indexOf(");"));
  for (const dep of [
    "countryValidation.postalCodePattern",
    "countryValidation.phonePattern",
    "countryValidation.countryMissing",
  ]) {
    assert.ok(deps.includes(dep), `dépendance manquante du mémo de validation : ${dep}`);
  }
  const valid = src.slice(src.indexOf("const customerValid ="), src.indexOf("const customerValid =") + 600);
  assert.ok(valid.includes("!countryValidation.countryMissing"), "customerValid doit exiger un pays en livraison");
});

test("[UI-02/I18N] le message « pays requis » existe dans chaque dictionnaire", () => {
  const src = readFileSync(path.join(process.cwd(), "lib", "i18n.ts"), "utf8");
  assert.equal(src.split("errDeliveryCountryRequired:").length - 1, 3, "fr, en, ar");
});

// ==================================================================
// v1.1 -- message de format postal SELON LE PAYS
// ==================================================================

const OTHER: DeliveryCountryOption = {
  countryCode: "LU",
  countryName: "Luxembourg",
  postalCodePattern: "^[0-9]{4}$",
  phonePattern: null,
  addressProvider: "manual",
  addressLineOrder: "street_first",
};

test("[MSG] la clé du message postal est dérivée du pays : FR, BE, générique pour tout autre pays", () => {
  assert.equal(postalCodeErrorKeyFor(FR), "errPostalCode_FR");
  assert.equal(postalCodeErrorKeyFor(BE), "errPostalCode_BE");
  assert.equal(postalCodeErrorKeyFor(OTHER), "errPostalCodeCountry");
  assert.equal(postalCodeErrorKeyFor(null), null);
  // Jamais la chaîne de prototypes (un code pays hostile ne produit pas une clé héritée).
  assert.equal(postalCodeErrorKeyFor({ ...OTHER, countryCode: "__proto__" }), "errPostalCodeCountry");
});

test("[MSG/BE] un code postal belge invalide affiche « 4 chiffres » (fr), « 4 digits » (en), arabe", () => {
  const key = errorsFor([BE], null, PARIS).errors.postalCode!;
  assert.equal(translate("fr", key), "4 chiffres");
  assert.equal(translate("en", key), "4 digits");
  assert.equal(translate("ar", key), "أربعة أرقام");
});

test("[MSG/FR] le message français est STRICTEMENT inchangé (fr/en/ar identiques à errPostalCode)", () => {
  const key = errorsFor([FR], null, BXL).errors.postalCode!;
  for (const lang of ["fr", "en", "ar"]) {
    assert.equal(translate(lang, key), translate(lang, "errPostalCode"), `langue ${lang}`);
  }
  assert.equal(translate("fr", key), "5 chiffres");
});

test("[MSG/AUTRE] tout autre pays reçoit le message générique, dans les trois langues", () => {
  const key = errorsFor([OTHER], null, PARIS).errors.postalCode!;
  assert.equal(key, "errPostalCodeCountry");
  assert.equal(translate("fr", key), "Code postal invalide pour ce pays");
  assert.equal(translate("en", key), "Invalid postcode for this country");
  assert.equal(translate("ar", key), "رمز بريدي غير صالح لهذا البلد");
});

test("[MSG/COMPAT] sans clé fournie (appelant historique), la clé reste errPostalCode", () => {
  const ko = { ...EMPTY_CUSTOMER, postalCode: "7501" };
  assert.deepEqual(getCustomerErrors(ko, ["postalCode"]), { postalCode: "errPostalCode" });
  assert.deepEqual(getCustomerErrors(ko, ["postalCode"], { postalCodePattern: "^[0-9]{5}$" }), {
    postalCode: "errPostalCode",
  });
});
