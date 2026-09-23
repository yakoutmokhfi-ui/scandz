import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym — TRANSLATIONS MANAGEMENT v2 — RUNTIME PUBLIC (mandat §16,
// §17, §19.F)
//
// - une sous-catégorie traduite et VALIDÉE s'affiche dans la langue du
//   client ; périmée / manquante / langue source -> texte SOURCE ;
// - le texte client configurable par le commerçant suit les MÊMES
//   règles ; la SÉLECTION de sa source (règle de livraison prioritaire)
//   reste INCHANGÉE ;
// - les libellés d'INTERFACE de la popup continuent de venir des
//   dictionnaires Scanym (lib/i18n.ts), jamais du commerçant.
// ====================================================================

const { tSubcategoryName, tCustomerNoticeText } = await import("../lib/menu-i18n.ts");
const { groupMenuItemsBySubcategory, deriveSubcategoryFilterOptions, translateSubcategoryFilterOptions } =
  await import("../lib/catalogue-subcategory-grouping.ts");
const { resolveDeliveryCustomerNotice } = await import("../lib/delivery-customer-notice.ts");
const { translate } = await import("../lib/i18n.ts");

const SUB_HASH = "hash-chevres";

const SUB = {
  name: "Chèvres",
  name_hash: SUB_HASH,
  translations: {
    en: { name: "Goat cheeses", name_status: "validated", name_source_hash: SUB_HASH },
    ar: { name: "أجبان الماعز", name_status: "validated", name_source_hash: "ancien" },
    es: { name: "Quesos de cabra", name_status: "to_review", name_source_hash: SUB_HASH },
  },
};

test("F — sous-catégorie : traduction VALIDÉE et à jour affichée dans la langue du client", () => {
  assert.equal(tSubcategoryName(SUB, "en" as never, "fr" as never), "Goat cheeses");
});

test("F — sous-catégorie : traduction PÉRIMÉE -> repli sur la source (jamais un texte faux)", () => {
  assert.equal(tSubcategoryName(SUB, "ar" as never, "fr" as never), "Chèvres");
});

test("F — sous-catégorie : traduction à relire (non validée) -> repli sur la source", () => {
  assert.equal(tSubcategoryName(SUB, "es" as never, "fr" as never), "Chèvres");
});

test("F — sous-catégorie : langue manquante et LANGUE SOURCE -> source", () => {
  assert.equal(tSubcategoryName(SUB, "de" as never, "fr" as never), "Chèvres");
  assert.equal(tSubcategoryName(SUB, "fr" as never, "fr" as never), "Chèvres");
  // Langue source ARABE (jamais « fr » supposé) : la source s'impose.
  assert.equal(
    tSubcategoryName({ ...SUB, name: "أجبان" }, "ar" as never, "ar" as never),
    "أجبان"
  );
});

test("F — sous-catégorie sans hash (base non migrée) : affichage source, jamais une erreur", () => {
  assert.equal(
    tSubcategoryName({ name: "Chèvres", name_hash: null, translations: null }, "en" as never, "fr" as never),
    "Chèvres"
  );
});

test("F — le regroupement public porte hash et traductions, sans changer les groupes", () => {
  const items = [
    { id: "i1", subcategory_id: null, subcategory_name: null } as never,
    {
      id: "i2",
      subcategory_id: "s1",
      subcategory_name: "Chèvres",
      subcategory_name_hash: SUB_HASH,
      subcategory_translations: SUB.translations,
    } as never,
  ];
  const groups = groupMenuItemsBySubcategory(items);
  assert.deepEqual(groups.map((g) => g.subcategoryId), [null, "s1"]);
  assert.equal(groups[1].subcategoryNameHash, SUB_HASH);

  const options = deriveSubcategoryFilterOptions(groups);
  const translated = translateSubcategoryFilterOptions(options, groups, (group) =>
    tSubcategoryName(
      {
        name: group.subcategoryName ?? "",
        name_hash: group.subcategoryNameHash,
        translations: group.subcategoryTranslations,
      },
      "en" as never,
      "fr" as never
    )
  );
  assert.deepEqual(
    translated.map((o) => [o.id, o.name]),
    [["s1", "Goat cheeses"]],
    "même option, même identité : seul le libellé change"
  );
  assert.deepEqual(options.map((o) => o.id), translated.map((o) => o.id));
});

// --------------------------------------------------------------------
// Textes client configurables
// --------------------------------------------------------------------

const PICKUP = {
  code: "pickup",
  label: "À emporter",
  category: "pickup",
  customerText: "Retrait sous 2 h.",
  customerTextHash: "h-pickup",
  translations: {
    en: {
      customer_text: "Pickup within 2 hours.",
      customer_text_status: "validated",
      customer_text_source_hash: "h-pickup",
    },
  },
  pricingMode: "free" as const,
  fixedFee: null,
  freeThreshold: null,
  delayValue: null,
  delayUnit: null,
};

test("F — message client : traduction validée affichée, repli source si périmée/absente", () => {
  assert.equal(
    tCustomerNoticeText(PICKUP, "en" as never, "fr" as never),
    "Pickup within 2 hours."
  );
  assert.equal(tCustomerNoticeText(PICKUP, "ar" as never, "fr" as never), "Retrait sous 2 h.");
  assert.equal(
    tCustomerNoticeText({ ...PICKUP, customerTextHash: "autre" }, "en" as never, "fr" as never),
    "Retrait sous 2 h.",
    "hash différent = périmé -> source"
  );
  assert.equal(tCustomerNoticeText({ customerText: null }, "en" as never, "fr" as never), null);
});

test("F — notice de retrait : traduite pour le client, sans changer la notice elle-même", () => {
  const notice = resolveDeliveryCustomerNotice("pickup", [PICKUP], { eligible: true } as never, false, {
    lang: "en" as never,
    sourceLanguage: "fr" as never,
  });
  assert.deepEqual(notice, {
    modeCode: "pickup",
    modeLabel: "À emporter",
    message: "Pickup within 2 hours.",
  });
});

test("F — SANS contexte de langue : comportement STRICTEMENT identique à avant ce lot", () => {
  assert.deepEqual(resolveDeliveryCustomerNotice("pickup", [PICKUP], { eligible: true } as never, false), {
    modeCode: "pickup",
    modeLabel: "À emporter",
    message: "Retrait sous 2 h.",
  });
});

test("F — la PRIORITÉ de source est inchangée : la règle de livraison l'emporte, et c'est ELLE qui est traduite", () => {
  const delivery = {
    ...PICKUP,
    code: "delivery",
    label: "Livraison",
    customerText: "Délai générique.",
    customerTextHash: "h-generique",
    translations: {
      en: {
        customer_text: "Generic delay.",
        customer_text_status: "validated",
        customer_text_source_hash: "h-generique",
      },
    },
  };
  const status = {
    eligible: true,
    customerNotice: "Coursier sous 2 h.",
    customerNoticeHash: "h-regle",
    customerNoticeTranslations: {
      en: {
        customer_text: "Courier within 2 hours.",
        customer_text_status: "validated",
        customer_text_source_hash: "h-regle",
      },
    },
  } as never;

  assert.equal(
    resolveDeliveryCustomerNotice("delivery", [delivery], status, true, {
      lang: "en" as never,
      sourceLanguage: "fr" as never,
    })?.message,
    "Courier within 2 hours."
  );
  // Sans moteur de règles : le texte générique du mode, traduit.
  assert.equal(
    resolveDeliveryCustomerNotice("delivery", [delivery], status, false, {
      lang: "en" as never,
      sourceLanguage: "fr" as never,
    })?.message,
    "Generic delay."
  );
});

test("F — texte et traductions ne peuvent jamais être DÉPAREILLÉS entre les deux sources", () => {
  // La règle fournit le TEXTE ; seules SES traductions peuvent le
  // traduire. Les traductions du mode générique, même validées, ne
  // doivent jamais s'appliquer au texte de la règle (elles diraient
  // autre chose, avec l'autorité d'une traduction « validée »).
  const mode = {
    ...PICKUP,
    code: "delivery",
    label: "Livraison",
    customerText: "Délai générique.",
    customerTextHash: "h-generique",
    translations: {
      en: {
        customer_text: "Generic delay.",
        customer_text_status: "validated",
        customer_text_source_hash: "h-generique",
      },
    },
  };
  const ruleWithoutTranslation = {
    eligible: true,
    customerNotice: "Coursier sous 2 h.",
    customerNoticeHash: "h-regle",
    customerNoticeTranslations: null,
  } as never;

  assert.equal(
    resolveDeliveryCustomerNotice("delivery", [mode], ruleWithoutTranslation, true, {
      lang: "en" as never,
      sourceLanguage: "fr" as never,
    })?.message,
    "Coursier sous 2 h.",
    "texte de la règle non traduit -> source de la règle, JAMAIS la traduction du mode"
  );

  // Inversement : sans moteur de règles, le texte du mode ne peut pas
  // être traduit par les traductions d'une règle.
  const modeWithoutTranslation = { ...mode, translations: null };
  assert.equal(
    resolveDeliveryCustomerNotice(
      "delivery",
      [modeWithoutTranslation],
      {
        eligible: true,
        customerNotice: "Coursier sous 2 h.",
        customerNoticeHash: "h-regle",
        customerNoticeTranslations: {
          en: {
            customer_text: "Courier within 2 hours.",
            customer_text_status: "validated",
            customer_text_source_hash: "h-regle",
          },
        },
      } as never,
      false,
      { lang: "en" as never, sourceLanguage: "fr" as never }
    )?.message,
    "Délai générique."
  );
});

test("F — une traduction ne peut JAMAIS faire apparaître une notice absente", () => {
  const silent = { ...PICKUP, customerText: null };
  assert.equal(
    resolveDeliveryCustomerNotice("pickup", [silent], { eligible: true } as never, false, {
      lang: "en" as never,
      sourceLanguage: "fr" as never,
    }),
    null
  );
});

test("F — les libellés d'INTERFACE de la popup restent dans les dictionnaires Scanym", () => {
  const dialog = readFileSync("components/DeliveryTimingNoticeDialog.tsx", "utf8");
  assert.equal(dialog.includes("notice.message"), true, "le message marchand reste le seul texte marchand");
  // Les libellés fixes viennent de t(...), jamais d'une source marchand.
  assert.equal(/t\(\s*"/.test(dialog), true);
  // Et ces clés existent réellement dans le dictionnaire.
  for (const lang of ["fr", "en", "ar"]) {
    assert.equal(typeof translate(lang as never, "deliveryTimingNoticeTitle"), "string");
  }
});
