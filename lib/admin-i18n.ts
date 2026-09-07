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
  configureIdentity: "Configurer l'identité visuelle (logo, couleurs, localisation)",

  // ==================================================================
  // OB-1 — OPERATOR COCKPIT FOUNDATION (répertoire + fiche opérateur).
  // Additif uniquement : aucune clé existante ci-dessus modifiée.
  // ==================================================================

  backToDirectory: "← Répertoire opérateur",
  newEstablishmentLink: "+ Nouvel établissement",

  dirTitle: "Répertoire des établissements",
  dirSubtitle: "Outil interne Scanym — réservé aux opérateurs autorisés",
  dirSearchPlaceholder: "Rechercher par nom ou slug…",
  dirFilterCountry: "Pays",
  dirFilterStatus: "Statut",
  dirFilterAllCountries: "Tous les pays",
  dirFilterAllStatuses: "Tous les statuts",
  dirColName: "Établissement",
  dirColSlug: "Slug",
  dirColCountry: "Pays",
  dirColStatus: "Statut",
  dirColId: "ID",
  dirColAction: "Action",
  dirOpenCockpit: "Ouvrir la fiche opérateur",
  dirEmpty: "Aucun établissement ne correspond à cette recherche.",
  dirLoadError: "Impossible de charger le répertoire des établissements.",
  dirLoading: "Chargement du répertoire…",
  dirCount: "{count} établissement(s)",

  statusOnboarding: "onboarding",
  statusActive: "active",
  statusSuspended: "suspended",
  statusInactive: "inactive",

  cockpitBack: "← Répertoire",
  cockpitLoading: "Chargement de la fiche opérateur…",
  cockpitMissingId: "Aucun établissement sélectionné. Retournez au répertoire pour en choisir un.",
  cockpitLoadError: "Impossible de charger cet établissement.",
  cockpitEstablishmentIdLabel: "ID établissement :",

  badgeReady: "PRÊT",
  badgeIncomplete: "INCOMPLET",
  badgeUnavailable: "INDISPONIBLE",
  badgeNotYetImplemented: "À VENIR",

  secMerchantTitle: "1. Établissement",
  secMerchantLink: "Ouvrir les paramètres de l'établissement",
  secMerchantOwnerLinked: "Propriétaire rattaché : {email}",
  secMerchantOwnerPending: "Invitation propriétaire en attente : {email}",
  secMerchantOwnerNone: "Aucune invitation propriétaire enregistrée.",

  secLegalTitle: "2. Légal / Fiscal",
  secLegalLink: "Ouvrir le profil légal et fiscal",
  secLegalReady: "Profil légal/fiscal renseigné (raison sociale et adresse légale présentes).",
  secLegalIncomplete: "Profil légal/fiscal incomplet ou non renseigné pour le moment.",

  // v1.1 — CATALOGUE lecture opérateur publiée par OB-2 v1.1
  // (get_merchant_catalogue). Les clés ci-dessous remplacent
  // secCatalogueUnavailable/secPhotosUnavailable (v1), qui décrivaient
  // un état qui n'est plus vrai depuis cette publication.
  secCatalogueTitle: "3. Catalogue",
  secCatalogueLink: "Ouvrir le catalogue marchand (édition)",
  secCatalogueSummary: "{categories} catégorie(s), {products} produit(s) actif(s).",
  secCatalogueEmpty: "Aucune catégorie ou aucun produit actif pour le moment.",

  // v1.1 — PHOTOS : dérivé du même résumé catalogue déjà chargé
  // (aucune lecture Storage). L'upload/remplacement reste hors
  // périmètre (Storage RLS operator non publiée par OB-2 v1.1).
  secPhotosTitle: "4. Photos",
  secPhotosLink: "Ouvrir la gestion des photos produits",
  secPhotosSummary: "{withPhoto} / {total} produit(s) actif(s) avec photo.",
  secPhotosNoProducts: "Aucun produit actif pour évaluer la couverture photo.",
  secPhotosUploadNote:
    "Lecture seule : l'ajout ou le remplacement de photo reste hors périmètre (policy Storage opérateur du bucket product-photos non encore publiée).",

  secPaymentTitle: "5. Paiement",
  secPaymentLink: "Ouvrir la configuration paiement",
  secPaymentUnavailable:
    "Payment provider status unavailable until operator payment read access is published.",

  secDeliveryTitle: "6. Livraison",
  secDeliveryLink: "Ouvrir la tarification de livraison",
  secDeliveryUnavailable:
    "Delivery status unavailable until operator delivery read access is published.",

  // v1.1 — rappel honnête affiché sous chaque lien vers un écran
  // marchand existant (settings/catalogue/payment/delivery-pricing) :
  // ces écrans résolvent encore l'établissement via restaurant_users
  // (getMerchantRestaurants, lib/services/dashboard.ts, INCHANGÉ par
  // OB-1/OB-2) — un opérateur qui n'est pas AUSSI membre peut y voir
  // "non lié à un restaurant" malgré une autorisation backend déjà
  // valide. Lacune documentée (voir OB1-V1.1-SETTINGS-CONTEXT-GAP.md
  // du paquet livré), jamais contournée en créant une fausse
  // appartenance restaurant_users.
  secExistingScreenCaveat:
    "Cet écran marchand existant peut afficher « non lié à un restaurant » pour un opérateur sans rattachement restaurant_users, même quand l'accès backend est déjà valide (lacune documentée, non corrigée par ce lot).",

  secQrTitle: "7. QR / Domaine",
  secQrLink: "Ouvrir la carte publique",
  secQrDesc: "URL publique du menu, dérivée du slug de l'établissement.",
  secQrNoSlug: "Aucun slug exploitable pour cet établissement.",

  secHealthTitle: "8. Contrôles de santé",
  secHealthDesc:
    "L'agrégation de préparation à la publication n'est pas encore implémentée (prévue par un lot ultérieur, OB-9).",

  secPublishTitle: "9. Prêt à publier",
  secPublishDesc:
    "Statut actuel de l'établissement. Aucune action de publication n'est proposée par cet écran (portée d'un lot ultérieur, OB-11).",
  secPublishReady: "L'établissement est actif.",
  secPublishIncomplete: "L'établissement n'est pas (encore) actif.",
  secPublishStatusLabel: "Statut restaurant : {status}",
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
