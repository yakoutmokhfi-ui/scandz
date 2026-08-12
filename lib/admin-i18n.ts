/**
 * i18n de l'outil interne Scanym (Lot D — création d'établissement).
 *
 * Volontairement séparé de lib/i18n.ts (FR/EN/AR, commerçants) :
 * cet outil est réservé aux opérateurs Scanym, FR uniquement, comme
 * demandé explicitement. Le fusionner dans le dictionnaire principal
 * casserait la symétrie FR/EN/AR déjà vérifiée par les tests
 * existants pour rien (aucun commerçant ne voit jamais ces textes).
 */

const dict = {
  adminTitle: "Créer un établissement",
  adminSubtitle: "Outil interne Scanym — réservé aux opérateurs autorisés",
  adminNotOperator: "Accès réservé aux opérateurs Scanym.",
  adminLoading: "Chargement…",

  sectionIdentity: "Établissement",
  sectionLocation: "Localisation",
  sectionContact: "Contact",
  sectionConfig: "Configuration",
  sectionOwner: "Compte commerçant",
  sectionCategory: "Carte initiale (facultatif)",

  fieldName: "Nom de l'établissement",
  fieldSlug: "Slug (URL publique)",
  fieldSlugHint: "URL publique : /r/{slug} — suggéré depuis le nom, modifiable",
  fieldCommerceType: "Type de commerce",
  fieldStatus: "Statut",
  fieldStatusOnboarding: "En cours d'intégration (onboarding)",
  fieldCountry: "Pays (code ISO, ex. FR, DZ)",
  fieldCountryPlaceholder: "— Sélectionner un pays —",
  fieldCity: "Ville",
  fieldAddress: "Adresse (facultatif)",
  fieldPhone: "Téléphone (facultatif)",
  fieldWhatsapp: "Numéro WhatsApp (format international, ex. +213550000000)",
  fieldSourceLanguage: "Langue source (langue de saisie du contenu)",
  fieldEnabledLanguages: "Langues activées côté client",
  fieldCurrency: "Devise (code ISO, ex. EUR, DZD)",
  fieldCurrencyPlaceholder: "— Sélectionner une devise —",
  fieldOpeningHours: "Horaires d'ouverture (facultatif)",
  fieldOwnerEmail: "E-mail du propriétaire",
  fieldOwnerEmailHint:
    "Le compte n'est pas créé automatiquement — voir l'étape de rattachement après création.",
  fieldCategoryName: "Nom de la première catégorie (facultatif)",

  commerceTypeRestaurant: "Restaurant",
  commerceTypeCafe: "Café",
  commerceTypeCheeseShop: "Fromagerie",
  commerceTypeBakery: "Boulangerie",
  commerceTypePastryShop: "Pâtisserie",
  commerceTypeHotel: "Hôtel",
  commerceTypeBar: "Bar",
  commerceTypeOther: "Autre",

  langFr: "Français",
  langEn: "Anglais",
  langAr: "Arabe",

  submit: "Créer l'établissement",
  submitting: "Création en cours…",
  cancel: "Annuler",

  errRequired: "Ce champ est obligatoire.",
  errInvalidSlug:
    "Slug invalide : minuscules, chiffres et tirets simples uniquement (ex. mon-etablissement).",
  errSlugTaken: "Ce slug est déjà utilisé par un autre établissement.",
  errInvalidCountry: "Code pays invalide : 2 lettres majuscules (ex. FR, DZ, US).",
  errInvalidCurrency: "Code devise invalide : 3 lettres majuscules (ex. EUR, DZD, USD).",
  errInvalidCommerceType: "Type de commerce invalide.",
  errInvalidWhatsapp:
    "Numéro WhatsApp invalide : indicatif international (+) suivi de 8 à 15 chiffres, sans lettres ni parenthèses.",
  errInvalidOwnerEmail: "Adresse e-mail invalide.",
  errSourceLanguageNotEnabled: "La langue source doit faire partie des langues activées.",
  errEnabledLanguagesEmpty: "Au moins une langue activée est requise.",
  errNotOperator: "Vous n'êtes pas autorisé à créer un établissement.",
  errGeneric: "La création a échoué. Réessayez ou contactez le support technique.",

  successTitle: "Établissement créé",
  successSlugLabel: "URL publique :",
  successStatusLabel: "Statut :",
  successOwnerPendingTitle: "Rattachement du propriétaire — action requise",
  successOwnerPendingBody:
    "Aucun compte n'a été créé automatiquement. Créez un compte Supabase Auth pour {email} via le tableau de bord Supabase, puis cliquez sur \"Vérifier et rattacher\" ci-dessous.",
  successOwnerLinkedBody: "Le propriétaire ({email}) est rattaché. L'établissement est actif.",
  linkOwnerButton: "Vérifier et rattacher le propriétaire",
  linkOwnerChecking: "Vérification…",
  linkOwnerNotFoundYet:
    "Aucun compte trouvé pour {email} pour l'instant. Créez-le dans Supabase, puis retentez.",
  linkOwnerSuccess: "Propriétaire rattaché avec succès. Établissement actif.",
  createAnother: "Créer un autre établissement",
  viewPublicMenu: "Voir la carte publique",
} as const;

export type AdminDictKey = keyof typeof dict;

export function tAdmin(key: AdminDictKey, params?: Record<string, string | number>): string {
  let text: string = dict[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(`{${k}}`, String(v));
    }
  }
  return text;
}
