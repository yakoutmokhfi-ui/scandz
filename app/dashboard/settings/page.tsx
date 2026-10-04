"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { getUser } from "@/lib/services/auth";
import {
  getMerchantRestaurants,
  getRestaurantSettings,
  updateRestaurantSettings,
  updateRestaurantWhatsapp,
  updateRestaurantColors,
  updateRestaurantMapsUrl,
  updateRestaurantIdentity,
  updateRestaurantBgColor,
  updateRestaurantSocialLinks,
  updateRestaurantLanguages,
  getSupportedLanguages,
  getRestaurantActiveLanguages,
  getReceiptSettings,
  updateReceiptSettings,
  updateRestaurantWhatsappEnabled,
  updateRestaurantPublicContact,
} from "@/lib/services/dashboard";
import { isValidPublicEmail, isValidPublicPhone } from "@/lib/customer-contact";
import {
  getMerchantTrackingStatusText,
  setMerchantTrackingStatusText,
} from "@/lib/services/tracking-status-text";
import { CANONICAL_ORDER_STATUSES, statusLabelKey } from "@/lib/tracking/status";
import {
  MERCHANT_STATUS_TEXT_MAX_LENGTH,
  statusExplanationKey,
} from "@/lib/tracking/status-text";
import { getLegalTaxFieldLabels } from "@/lib/merchant-legal-tax-labels";
import {
  addOrReplaceEstablishmentAsset,
  removeEstablishmentAsset,
  validateEstablishmentAssetFile,
  AssetUploadError,
  AssetRemoveError,
  InvalidFileTypeError,
  FileTooLargeError,
  type EstablishmentAssetKind,
} from "@/lib/services/establishment-assets";
import type { MerchantRestaurant } from "@/lib/dashboard-types";
import { moveLanguageInList } from "@/lib/types";
import { isScanymOperator, getEstablishmentSummary } from "@/lib/services/establishments";
import DashboardNav from "@/components/dashboard/DashboardNav";
import { resolveRestaurantContext } from "@/lib/dashboard-nav";
import { useRestaurantContextGuard } from "@/lib/restaurant-context-guard";
import { translate, type Lang } from "@/lib/i18n";
import { isValidWhatsappNumber, normalizeWhatsappNumber } from "@/lib/whatsapp";
import { isValidHexColor, readableTextColor } from "@/lib/color-contrast";
import { isValidMapsUrl, normalizeMapsUrl, MAPS_URL_MAX_LENGTH } from "@/lib/maps-url";
import { isValidInstagramUrl, isValidTiktokUrl, isValidFacebookUrl } from "@/lib/social-links";

const LANGUAGES = [
  { code: "fr", label: "Français" },
  { code: "en", label: "English" },
  { code: "ar", label: "العربية" },
];

/**
 * SETTINGS SAVE RELIABILITY v1.1 -- ferme SETTINGS-SAVE-RELIABILITY-
 * V1-PARTIAL-SAVE-01 (contre-audit indépendant de 7ff1176 : "the
 * page-level flow is NOT atomic -- a failure after receipt
 * persistence leaves a partial save").
 *
 * Forme NORMALISÉE (EXACTEMENT la même normalisation trim/null que
 * celle utilisée pour construire chaque payload RPC) de l'état "tel
 * que chargé" ou "tel que dernièrement persisté avec succès" pour
 * chacun des 7 groupes de mutation NON légaux/fiscaux. Comparée à la
 * valeur COURANTE (même normalisation) à submit() pour décider
 * laquelle de ces sections est réellement "dirty" -- voir
 * generalSnapshotRef dans le composant ci-dessous.
 */
type GeneralSettingsSnapshot = {
  lang: string;
  address: string | null;
  hours: string | null;
  whatsapp: string;
  whatsappEnabled: boolean;
  publicPhone: string;
  publicEmail: string;
  statusTexts: Record<string, string>;
  primaryColor: string | null;
  secondaryColor: string | null;
  accentColor: string | null;
  mapsUrl: string | null;
  displayName: string | null;
  introText: string | null;
  announcementText: string | null;
  announcementActive: boolean;
  bgColor: string | null;
  instagramUrl: string | null;
  tiktokUrl: string | null;
  facebookUrl: string | null;
  activeLanguageCodes: string[];
};

/** Même principe que GeneralSettingsSnapshot, pour le profil légal/
 *  fiscal (public.receipt_settings) -- voir legalSnapshotRef. */
type LegalTaxSnapshot = {
  legalBusinessName: string | null;
  legalName: string | null;
  legalAddress: string | null;
  legalPhone: string | null;
  legalEmail: string | null;
  legalTaxIdentifier: string | null;
  legalRegistrationNumber: string | null;
  legalTaxLabel: string;
  legalDefaultTaxRate: number;
  legalPricesIncludeTax: boolean;
  legalFooterText: string | null;
  legalShowTaxSummary: boolean;
};

function normStr(v: string): string {
  return v.trim();
}
function normStrOrNull(v: string): string | null {
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}
function stringArraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// SETTINGS SAVE RELIABILITY v1.1 -- un comparateur PUR et DÉDIÉ par
// GROUPE de mutation (jamais un seul "tout ou rien"), exactement
// aligné sur le découpage RPC existant -- c'est CE découpage, pas un
// nouveau, qui détermine quelles sections sont indépendamment
// "dirty".
//
// SETTINGS SAVE RELIABILITY v1.2 -- ferme SETTINGS-SAVE-RELIABILITY-
// V1-CONTACT-BUNDLE-ATOMICITY-01 (contre-audit indépendant, Blocker
// 2) : le lot contact public/WhatsApp/réglages restaurant/textes de
// suivi (owner/manager uniquement) contient QUATRE RPC
// INDÉPENDANTES. v1.1 les traitait comme un seul groupe "dirty" avec
// un seul try/catch -- un `try/catch` ne rend pas des écritures
// séparées atomiques, et un échec sur l'UNE d'elles (ex. WhatsApp)
// après qu'une AUTRE ait déjà réussi (ex. contact public) rapportait
// "zéro succès" alors que le contact public avait bel et bien été
// persisté. v1.2 remplace ce groupe UNIQUE par QUATRE comparateurs
// indépendants -- un par RPC -- exactement comme les 7 groupes
// généraux ci-dessous ; chacun est tenté et son résultat consigné
// séparément dans submit() (voir plus bas), avec un SEUL message
// visuel pour la section contact (mandat : "you may keep one visual
// error message for the contact section ... but the internal dirty
// state must be field/subgroup accurate").
function publicContactSubDirty(a: GeneralSettingsSnapshot, b: GeneralSettingsSnapshot): boolean {
  return a.publicPhone !== b.publicPhone || a.publicEmail !== b.publicEmail;
}
// SETTINGS SAVE RELIABILITY v1.3 -- ferme SETTINGS-SAVE-RELIABILITY-
// V1-WHATSAPP-SUBWRITE-01 (3e contre-audit indépendant, Blocker 2A) :
// v1.2 traitait numéro ET état d'activation comme UN SEUL sous-groupe
// "dirty" (lecture littérale du mandat v1.2, "WhatsApp number /
// enabled state" sur une seule puce). Le contre-audit a montré que
// l'implémentation exécute en réalité DEUX RPC séparées
// (updateRestaurantWhatsapp / updateRestaurantWhatsappEnabled), donc
// un seul sous-groupe masquait exactement le même genre de
// persistance partielle cachée que Blocker 2 visait à l'origine : si
// le numéro réussissait puis l'activation échouait, l'instantané ne
// pouvait pas avancer du tout (le comparateur combiné restait "sale"
// sur les DEUX champs), et un retry réécrivait inutilement le numéro
// déjà persisté. Numéro et activation sont donc maintenant DEUX
// comparateurs indépendants -- la dépendance SQL (activer exige un
// numéro déjà valide) est préservée dans submit() lui-même (voir le
// commentaire au-dessus du bloc WhatsApp plus bas), jamais ici.
function whatsappNumberSubDirty(a: GeneralSettingsSnapshot, b: GeneralSettingsSnapshot): boolean {
  return a.whatsapp !== b.whatsapp;
}
function whatsappEnabledSubDirty(a: GeneralSettingsSnapshot, b: GeneralSettingsSnapshot): boolean {
  return a.whatsappEnabled !== b.whatsappEnabled;
}
function restaurantSettingsSubDirty(a: GeneralSettingsSnapshot, b: GeneralSettingsSnapshot): boolean {
  return a.lang !== b.lang || a.address !== b.address || a.hours !== b.hours;
}
// SETTINGS SAVE RELIABILITY v1.3 -- ferme SETTINGS-SAVE-RELIABILITY-
// V1-TRACKING-TEXT-SUBWRITE-01 (Blocker 2B) :
// setAllMerchantTrackingStatusText() exécute en réalité UNE RPC PAR
// statut canonique (boucle séquentielle, lib/services/tracking-status-
// text.ts) -- ce n'était donc déjà pas une écriture atomique, même
// utilisée comme telle par ce lot. `trackingTextSubDirty` (comparateur
// combiné, tout-ou-rien sur les 7 statuts) est remplacé par
// `trackingStatusDirty`, un comparateur PAR STATUT -- la boucle de
// dirty-check se fait maintenant dans submit() lui-même (voir plus
// bas), pour produire une liste des statuts RÉELLEMENT modifiés,
// chacun ensuite tenté et comptabilisé indépendamment.
function trackingStatusDirty(a: Record<string, string>, b: Record<string, string>, status: string): boolean {
  return (a[status] ?? "") !== (b[status] ?? "");
}
function colorsGroupDirty(a: GeneralSettingsSnapshot, b: GeneralSettingsSnapshot): boolean {
  return a.primaryColor !== b.primaryColor || a.secondaryColor !== b.secondaryColor || a.accentColor !== b.accentColor;
}
function mapsUrlGroupDirty(a: GeneralSettingsSnapshot, b: GeneralSettingsSnapshot): boolean {
  return a.mapsUrl !== b.mapsUrl;
}
function identityGroupDirty(a: GeneralSettingsSnapshot, b: GeneralSettingsSnapshot): boolean {
  return (
    a.displayName !== b.displayName ||
    a.introText !== b.introText ||
    a.announcementText !== b.announcementText ||
    a.announcementActive !== b.announcementActive
  );
}
function bgColorGroupDirty(a: GeneralSettingsSnapshot, b: GeneralSettingsSnapshot): boolean {
  return a.bgColor !== b.bgColor;
}
function socialGroupDirty(a: GeneralSettingsSnapshot, b: GeneralSettingsSnapshot): boolean {
  return a.instagramUrl !== b.instagramUrl || a.tiktokUrl !== b.tiktokUrl || a.facebookUrl !== b.facebookUrl;
}
function languagesGroupDirty(a: GeneralSettingsSnapshot, b: GeneralSettingsSnapshot): boolean {
  return !stringArraysEqual(a.activeLanguageCodes, b.activeLanguageCodes);
}
function legalGroupDirty(a: LegalTaxSnapshot, b: LegalTaxSnapshot): boolean {
  return (
    a.legalBusinessName !== b.legalBusinessName ||
    a.legalName !== b.legalName ||
    a.legalAddress !== b.legalAddress ||
    a.legalPhone !== b.legalPhone ||
    a.legalEmail !== b.legalEmail ||
    a.legalTaxIdentifier !== b.legalTaxIdentifier ||
    a.legalRegistrationNumber !== b.legalRegistrationNumber ||
    a.legalTaxLabel !== b.legalTaxLabel ||
    a.legalDefaultTaxRate !== b.legalDefaultTaxRate ||
    a.legalPricesIncludeTax !== b.legalPricesIncludeTax ||
    a.legalFooterText !== b.legalFooterText ||
    a.legalShowTaxSummary !== b.legalShowTaxSummary
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const [mappings, setMappings] = useState<MerchantRestaurant[]>([]);
  const [restaurantId, setRestaurantId] = useState("");
  const [lang, setLang] = useState("fr");
  const [address, setAddress] = useState("");
  const [hours, setHours] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  // CUSTOMER CONTACT + LIVE TRACKING v1 -- WhatsApp optionnel + contact
  // commercial public (owner/manager uniquement, même section).
  const [whatsappEnabled, setWhatsappEnabled] = useState(true);
  const [publicPhone, setPublicPhone] = useState("");
  const [publicEmail, setPublicEmail] = useState("");
  // CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 — surcharge de TEXTE par
  // statut canonique. Chaîne vide = « pas de surcharge » (repli sur le
  // texte Scanym de base), jamais « afficher un texte vide » : c'est
  // exactement la sémantique appliquée par le SQL, qui supprime alors
  // la ligne. Aucune notion d'état/transition ici -- purement de
  // l'affichage.
  const [statusTexts, setStatusTexts] = useState<Record<string, string>>({});
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  // Couleurs personnalisées + lien de localisation/itinéraire (V69).
  // Champ vide ("") = pas de valeur (NULL en base) : distinct d'une
  // couleur/URL invalide, qui bloque l'enregistrement (voir submit()).
  const [primaryColor, setPrimaryColor] = useState("");
  const [secondaryColor, setSecondaryColor] = useState("");
  const [accentColor, setAccentColor] = useState("");
  const [mapsUrl, setMapsUrl] = useState("");
  // LOT 1A — identité, apparence, réseaux sociaux, langues.
  const [displayName, setDisplayName] = useState("");
  const [introText, setIntroText] = useState("");
  const [announcementText, setAnnouncementText] = useState("");
  const [announcementActive, setAnnouncementActive] = useState(false);
  const [bgColor, setBgColor] = useState("");
  const [instagramUrl, setInstagramUrl] = useState("");
  const [tiktokUrl, setTiktokUrl] = useState("");
  const [facebookUrl, setFacebookUrl] = useState("");
  const [sourceLanguage, setSourceLanguage] = useState("fr");
  const [supportedLanguages, setSupportedLanguages] = useState<
    Array<{ code: string; label: string; dir: "ltr" | "rtl" }>
  >([]);
  const [activeLanguageCodes, setActiveLanguageCodes] = useState<string[]>(["fr"]);
  // MERCHANT LEGAL & TAX PROFILE v1 — profil légal/fiscal marchand
  // (public.receipt_settings), jusqu'ici en lecture seule (V29).
  // legalCountry est LU (restaurants.country, via getReceiptSettings)
  // pour piloter l'intitulé de registrationNumber/taxIdentifier
  // (lib/merchant-legal-tax-labels.ts) mais n'est JAMAIS modifié par
  // cette page -- ce champ appartient à l'établissement (Lot D), hors
  // périmètre de ce lot.
  const [legalCountry, setLegalCountry] = useState<string | null>(null);
  const [legalBusinessName, setLegalBusinessName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [legalAddress, setLegalAddress] = useState("");
  const [legalPhone, setLegalPhone] = useState("");
  const [legalEmail, setLegalEmail] = useState("");
  const [legalTaxIdentifier, setLegalTaxIdentifier] = useState("");
  const [legalRegistrationNumber, setLegalRegistrationNumber] = useState("");
  const [legalTaxLabel, setLegalTaxLabel] = useState("TVA");
  const [legalDefaultTaxRate, setLegalDefaultTaxRate] = useState("0");
  const [legalPricesIncludeTax, setLegalPricesIncludeTax] = useState(true);
  const [legalFooterText, setLegalFooterText] = useState("");
  const [legalShowTaxSummary, setLegalShowTaxSummary] = useState(false);
  // MERCHANT LEGAL & TAX PROFILE v1.1 -- ferme
  // MLTP-V1-DASHBOARD-STALE-WRITE-01. Même patron, déjà audité et
  // validé par le Work, que app/dashboard/payment/page.tsx (v3,
  // `loadedRestaurantId`/`requestSeqRef`/réinitialisation SYNCHRONE
  // dans le gestionnaire de sélection) -- appliqué ICI uniquement à la
  // section légale/fiscale, jamais au reste de cette page (portée du
  // mandat v1.1, "targeted fix only").
  //
  // `legalProfileReady` : true UNIQUEMENT une fois la lecture de CE
  // restaurant terminée avec succès (ligne trouvée OU "aucune ligne"
  // confirmée) -- reste false pendant le chargement ET après un échec
  // de lecture (un échec n'équivaut JAMAIS à "aucune ligne", mandat).
  // `legalProfileLoadedRestaurantId` : le restaurant auquel les champs
  // légaux/fiscaux actuellement en état appartiennent RÉELLEMENT --
  // submit() n'appelle updateReceiptSettings() QUE si cette valeur est
  // strictement égale à `restaurantId` ET que `legalProfileReady` est
  // vrai (garde-fou de PROPRIÉTÉ des données, pas seulement de
  // timing).
  const [legalProfileReady, setLegalProfileReady] = useState(false);
  const [legalProfileLoadedRestaurantId, setLegalProfileLoadedRestaurantId] = useState<string | null>(null);
  const [legalProfileError, setLegalProfileError] = useState<string | null>(null);
  // Garde anti-réponse-hors-ordre (asynchrone) -- incrémentée à chaque
  // nouvelle tentative de lecture du profil légal/fiscal (bascule de
  // restaurant OU premier montage), permet d'ignorer toute réponse qui
  // arriverait APRÈS qu'un changement plus récent l'a déjà invalidée.
  const legalRequestSeqRef = useRef(0);
  /**
   * SETTINGS SAVE RELIABILITY v1.1 -- instantanés "tel que chargé"/
   * "tel que dernièrement persisté avec succès", NORMALISÉS (même
   * nettoyage que les payloads RPC), capturés par load() et rafraîchis
   * après chaque groupe dont la mutation vient de réussir. Technique
   * DÉRIVÉE (pas de dirty-tracking par frappe -- aucun gestionnaire
   * onChange n'est modifié) : à submit(), un groupe n'est candidat à
   * une mutation QUE si sa valeur ACTUELLE (même normalisation) diffère
   * de cet instantané -- voir les comparateurs `*GroupDirty` ci-dessus
   * et leur usage dans submit(). `null` tant qu'aucun chargement
   * (initial ou après bascule de restaurant) n'a encore réussi pour
   * CE restaurant -- jamais lu avant que la garde de provenance
   * correspondante (legalProfileReady / settingsLoadedRestaurantId) ne
   * soit elle-même vraie.
   */
  const generalSnapshotRef = useRef<GeneralSettingsSnapshot | null>(null);
  const legalSnapshotRef = useRef<LegalTaxSnapshot | null>(null);
  /**
   * CONTEXT HARDENING v1.1 -- PROVENANCE explicite des réglages
   * GÉNÉRAUX (adresse, horaires, identité, couleurs, langues actives).
   *
   * v1.1 de MERCHANT LEGAL & TAX PROFILE avait protégé la section
   * LÉGALE/FISCALE (legalRequestSeqRef / legalProfileLoadedRestaurantId
   * ci-dessus), mais PAS le reste de load() : une réponse
   * `getRestaurantSettings()` de l'établissement précédent, résolue en
   * retard, écrasait donc encore l'adresse, le nom affiché et les
   * couleurs de l'établissement courant (constat d'audit
   * CTXHARD-V1-STALE-RESPONSE-01). Cette provenance ferme ce trou avec
   * exactement le même contrat, désormais partagé.
   */
  const [settingsLoadedRestaurantId, setSettingsLoadedRestaurantId] = useState<string | null>(null);
  /** CONTEXT HARDENING v1.1 -- contrat anti-réponse-périmée partagé. */
  const guard = useRestaurantContextGuard();
  /** CONTEXT HARDENING v1 (§4.B) -- `?r=` explicite non résoluble. */
  const [unavailableContextId, setUnavailableContextId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Accès Super Admin (F-01) : un opérateur Scanym (scanym_operators)
  // n'a généralement AUCUNE ligne dans restaurant_users -- il consulte
  // et modifie un établissement via un lien direct (?r=<restaurant_id>,
  // ex. depuis la page de création d'établissement), pas via le
  // sélecteur "mes établissements" ci-dessous. isScanymOperator()
  // réutilise exactement le même service que app/admin/establishments/new
  // (aucune logique dupliquée) ; get_establishment_summary de même.
  const [isOperator, setIsOperator] = useState(false);
  const [operatorRestaurantName, setOperatorRestaurantName] = useState<string | null>(null);

  const mapping = mappings.find((m) => m.restaurant_id === restaurantId);
  // Corrige V71-06 (contre-audit Work, 2e tour) : le mode d'édition
  // doit se fonder sur les PERMISSIONS EFFECTIVES (le rôle réel
  // restaurant_users), jamais sur la seule présence/absence d'un
  // rattachement quelconque. Un opérateur ÉGALEMENT présent dans
  // restaurant_users avec le rôle 'staff' n'obtient PAS le formulaire
  // complet : mapping existe, mais son rôle n'autorise pas
  // WhatsApp/adresse/horaires/langue (canEditFull = false pour staff,
  // exactement comme pour un opérateur sans aucun rattachement). Les
  // droits SQL du staff ne sont jamais élargis par ce correctif --
  // seul le comportement d'AFFICHAGE et d'APPEL RPC change côté
  // interface, pour rester cohérent avec ce que le staff pouvait déjà
  // faire (ou pas) avant même l'existence du statut opérateur.
  const canEditFull = mapping?.role === "owner" || mapping?.role === "manager";
  // Un opérateur peut modifier N'IMPORTE QUEL établissement pour les
  // champs logo/cover/couleurs/maps_url (assert_restaurant_asset_role
  // côté SQL, voir migration-v70), MÊME sans rôle owner/manager réel.
  const canEdit = isOperator || canEditFull;
  // Mode opérateur restreint : opérateur ET rôle réel n'autorisant PAS
  // le formulaire complet -- couvre à la fois "aucun rattachement" et
  // "rattachement staff", les deux cas où canEditFull est faux. Un
  // opérateur qui est PAR AILLEURS légitimement owner/manager
  // (canEditFull=true) garde le formulaire complet : ce n'est pas son
  // statut d'opérateur qui l'autorise alors, mais son rôle réel.
  const isOperatorOnlyMode = isOperator && !canEditFull;
  // Les réglages s'affichent dans la langue enregistrée, pas dans
  // celle en cours d'édition : le libellé ne saute pas pendant le
  // choix, il suit après enregistrement.
  const [uiLang, setUiLang] = useState<Lang>("fr");
  const t = (k: string, p?: Record<string, string | number>) =>
    translate(uiLang, k, p);
  // MERCHANT LEGAL & TAX PROFILE v1 -- intitulés de champ adaptés au
  // pays du restaurant (lib/merchant-legal-tax-labels.ts), jamais un
  // nouveau moteur de juridiction : simple lookup pur, recalculé à
  // chaque rendu (aucun appel réseau).
  const legalLabels = getLegalTaxFieldLabels(legalCountry);

  // MERCHANT LEGAL & TAX PROFILE v1.1 -- réinitialisation SYNCHRONE et
  // COMPLÈTE de la section légale/fiscale, jamais du reste de la page
  // (portée strictement scopée du mandat v1.1). Invoquée (a) au tout
  // début de load() (couvre le premier montage, qui ne passe jamais
  // par handleSelectRestaurant ci-dessous) et (b) DANS handleSelectRestaurant,
  // dans le MÊME gestionnaire d'événement que setRestaurantId(id) --
  // React regroupe ces deux mises à jour en un seul rendu, il ne peut
  // donc jamais exister de rendu intermédiaire où `restaurantId` a
  // déjà changé mais où les champs légaux/fiscaux appartiennent
  // encore à l'ancien restaurant (même garantie, même patron déjà
  // audité par le Work sur app/dashboard/payment/page.tsx v3).
  const resetLegalProfileState = useCallback(() => {
    legalRequestSeqRef.current += 1;
    // SETTINGS SAVE RELIABILITY v1.1 -- l'instantané légal/fiscal
    // appartient à un restaurant précis ; jamais comparé contre l'état
    // d'un AUTRE restaurant pendant la fenêtre de rechargement.
    legalSnapshotRef.current = null;
    setLegalProfileReady(false);
    setLegalProfileLoadedRestaurantId(null);
    setLegalProfileError(null);
    setLegalCountry(null);
    setLegalBusinessName("");
    setLegalName("");
    setLegalAddress("");
    setLegalPhone("");
    setLegalEmail("");
    setLegalTaxIdentifier("");
    setLegalRegistrationNumber("");
    setLegalTaxLabel("TVA");
    setLegalDefaultTaxRate("0");
    setLegalPricesIncludeTax(true);
    setLegalFooterText("");
    setLegalShowTaxSummary(false);
  }, []);

  // Sélecteur de restaurant (DashboardNav) -- remplace le
  // `setRestaurantId` direct utilisé jusqu'ici : réinitialise D'ABORD,
  // de façon synchrone, la section légale/fiscale, PUIS change
  // `restaurantId`, dans le MÊME gestionnaire (React 18/19 regroupe
  // les deux en un seul rendu). Le reste de la page (adresse,
  // couleurs, langues, etc.) continue de se réinitialiser exclusivement
  // via load() comme avant v1.1 -- inchangé, hors périmètre de ce
  // correctif.
  const handleSelectRestaurant = useCallback((id: string) => {
    resetLegalProfileState();
    // CONTEXT HARDENING v1.1 -- invalidation de la provenance GÉNÉRALE
    // dans le MÊME gestionnaire que le changement de restaurant : React
    // regroupe ces mises à jour en un seul rendu, il ne peut donc
    // exister aucun rendu où l'entête affiche B pendant que le
    // formulaire montre encore les réglages de A.
    guard.enterContext(id);
    setSettingsLoadedRestaurantId(null);
    // SETTINGS SAVE RELIABILITY v1.1 -- même raison que
    // legalSnapshotRef ci-dessus, pour l'instantané des réglages
    // généraux.
    generalSnapshotRef.current = null;
    // SETTINGS SAVE RELIABILITY v1.2 -- ferme un verrou mort introduit
    // par les gardes de péremption `token.isCurrent()` de submit()
    // (Blocker 1) : une sauvegarde laissée en vol pour l'ANCIEN
    // restaurant abandonne désormais silencieusement sa continuation
    // (`return` avant d'atteindre `setSaving(false)` en bas de
    // submit()) dès qu'elle détecte la bascule -- `saving` resterait
    // sinon bloqué à `true` POUR TOUJOURS après un changement de
    // restaurant pendant un enregistrement, désactivant le bouton
    // Enregistrer du NOUVEAU restaurant sans qu'aucune sauvegarde ne
    // soit jamais réellement en cours pour lui. Remise à `false` ICI,
    // synchrone, dans le même geste que les autres réinitialisations de
    // provenance ci-dessus : le nouveau contexte démarre toujours
    // disponible pour un Enregistrer, jamais hérité de l'état `saving`
    // d'un contexte qui n'est plus affiché.
    setSaving(false);
    setRestaurantId(id);
  }, [resetLegalProfileState, guard]);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    // CONTEXT HARDENING v1.1 -- contrat partagé : la réponse devra
    // prouver, au retour, qu'elle appartient toujours au restaurant
    // actif ET à la génération courante.
    const token = guard.beginRequest(id);
    // §5 -- invalidation IMMÉDIATE de la provenance générale.
    setSettingsLoadedRestaurantId(null);
    // SETTINGS SAVE RELIABILITY v1.1 -- même provenance que
    // settingsLoadedRestaurantId : un instantané ne doit jamais
    // survivre à une nouvelle tentative de chargement (même restaurant
    // rechargé, ou bascule) tant que celle-ci n'a pas elle-même réussi.
    generalSnapshotRef.current = null;
    try {
      const s = await getRestaurantSettings(id);
      // Réponse PÉRIMÉE -> ABANDONNÉE intégralement : aucun des
      // ~20 champs ci-dessous n'est écrit avec les données d'un
      // établissement qui n'est plus celui affiché.
      if (!token.isCurrent()) return;
      setLang(s.staff_receipt_language ?? "fr");
      setUiLang((s.staff_receipt_language ?? "fr") as Lang);
      setAddress(s.address ?? "");
      setHours(s.opening_hours ?? "");
      setWhatsapp(s.whatsapp_number ?? "");
      setWhatsappEnabled(s.whatsapp_enabled !== false);
      setPublicPhone(s.public_phone ?? "");
      setPublicEmail(s.public_email ?? "");
      setLogoUrl(s.logo_url ?? null);
      setCoverUrl(s.cover_url ?? null);
      setPrimaryColor(s.primary_color ?? "");
      setSecondaryColor(s.secondary_color ?? "");
      setAccentColor(s.accent_color ?? "");
      setMapsUrl(s.maps_url ?? "");
      setDisplayName(s.display_name ?? "");
      setIntroText(s.intro_text ?? "");
      setAnnouncementText(s.announcement_text ?? "");
      setAnnouncementActive(s.announcement_active ?? false);
      setBgColor(s.bg_color ?? "");
      setInstagramUrl(s.instagram_url ?? "");
      setTiktokUrl(s.tiktok_url ?? "");
      setFacebookUrl(s.facebook_url ?? "");
      setSourceLanguage(s.source_language ?? "fr");
      // SETTINGS SAVE RELIABILITY v1.1 -- instantané NORMALISÉ (même
      // nettoyage que les payloads RPC) de l'état tel que chargé.
      // `statusTexts`/`activeLanguageCodes` sont chargés PLUS BAS, de
      // façon indépendante : complétés par leurs propres blocs
      // try/catch respectifs une fois résolus, jamais lus avant.
      generalSnapshotRef.current = {
        lang: s.staff_receipt_language ?? "fr",
        address: normStrOrNull(s.address ?? ""),
        hours: normStrOrNull(s.opening_hours ?? ""),
        whatsapp: normalizeWhatsappNumber(s.whatsapp_number ?? ""),
        whatsappEnabled: s.whatsapp_enabled !== false,
        publicPhone: normStr(s.public_phone ?? ""),
        publicEmail: normStr(s.public_email ?? ""),
        primaryColor: normStrOrNull(s.primary_color ?? ""),
        secondaryColor: normStrOrNull(s.secondary_color ?? ""),
        accentColor: normStrOrNull(s.accent_color ?? ""),
        mapsUrl: normalizeMapsUrl(s.maps_url ?? "") || null,
        displayName: normStrOrNull(s.display_name ?? ""),
        introText: normStrOrNull(s.intro_text ?? ""),
        announcementText: normStrOrNull(s.announcement_text ?? ""),
        announcementActive: s.announcement_active ?? false,
        bgColor: normStrOrNull(s.bg_color ?? ""),
        instagramUrl: normStrOrNull(s.instagram_url ?? ""),
        tiktokUrl: normStrOrNull(s.tiktok_url ?? ""),
        facebookUrl: normStrOrNull(s.facebook_url ?? ""),
        statusTexts: {},
        activeLanguageCodes: [],
      };
      // Commit ATOMIQUE de la provenance générale, dans la même passe
      // de rendu que les champs ci-dessus.
      setSettingsLoadedRestaurantId(id);
      // MERCHANT LEGAL & TAX PROFILE v1.1 -- ferme
      // MLTP-V1-DASHBOARD-STALE-WRITE-01. Réinitialisation SYNCHRONE
      // (couvre le premier montage -- handleSelectRestaurant couvre
      // déjà toute bascule pilotée par l'utilisateur, mais load() reste
      // le SEUL point de réinitialisation pour ce cas-là) + garde de
      // séquence anti-réponse-hors-ordre, même patron que
      // app/dashboard/payment/page.tsx (v3).
      //
      // Distinction EXPLICITE, jamais confondue (mandat : "A read
      // error is NOT equivalent to 'no row'") :
      //   - getReceiptSettings(id) résout à `null` -- aucune ligne
      //     receipt_settings pour ce restaurant (onboardé après V29),
      //     mais la lecture elle-même a RÉUSSI (autorisation
      //     confirmée par get_receipt_settings, voir
      //     supabase/DRAFT-lot-merchant-legal-tax-profile-v1.sql
      //     section 4) -- defaults sûrs affichés, `legalProfileReady`
      //     passe à `true` : enregistrer est autorisé (un formulaire
      //     vide légitime, l'UPSERT créera la ligne).
      //   - getReceiptSettings(id) lève une exception -- échec RÉEL
      //     (RPC rejetée, réseau, etc.) -- tous les champs légaux/
      //     fiscaux sont réinitialisés/vidés, `legalProfileReady`
      //     reste `false`, une erreur DÉDIÉE est affichée
      //     (legalProfileError, jamais confondue avec le formulaire
      //     "vide légitime" ci-dessus) : enregistrer reste refusé
      //     (voir submit()).
      const legalSeq = ++legalRequestSeqRef.current;
      setLegalProfileReady(false);
      setLegalProfileLoadedRestaurantId(null);
      setLegalProfileError(null);
      try {
        const receipt = await getReceiptSettings(id);
        // Garde anti-réponse-hors-ordre : si une bascule de restaurant
        // plus récente a déjà invalidé cette requête, cette réponse
        // est PÉRIMÉE -- ignorée intégralement, jamais appliquée à
        // l'état d'un restaurant qui n'est plus celui sélectionné.
        if (legalSeq !== legalRequestSeqRef.current) return;
        setLegalCountry(receipt?.restaurant_country ?? null);
        setLegalBusinessName(receipt?.business_name ?? "");
        setLegalName(receipt?.legal_name ?? "");
        setLegalAddress(receipt?.legal_address ?? "");
        setLegalPhone(receipt?.phone ?? "");
        setLegalEmail(receipt?.email ?? "");
        setLegalTaxIdentifier(receipt?.tax_identifier ?? "");
        setLegalRegistrationNumber(receipt?.registration_number ?? "");
        setLegalTaxLabel(receipt?.tax_label ?? "TVA");
        setLegalDefaultTaxRate(String(receipt?.default_tax_rate ?? 0));
        setLegalPricesIncludeTax(receipt?.prices_include_tax ?? true);
        setLegalFooterText(receipt?.footer_text ?? "");
        setLegalShowTaxSummary(receipt?.show_tax_summary ?? false);
        // SETTINGS SAVE RELIABILITY v1.1 -- instantané NORMALISÉ (même
        // nettoyage que le payload updateReceiptSettings), capturé que
        // la ligne existe ou non (un formulaire vide légitime pour un
        // nouvel établissement n'est pas "dirty" tant qu'il reste vide).
        legalSnapshotRef.current = {
          legalBusinessName: normStrOrNull(receipt?.business_name ?? ""),
          legalName: normStrOrNull(receipt?.legal_name ?? ""),
          legalAddress: normStrOrNull(receipt?.legal_address ?? ""),
          legalPhone: normStrOrNull(receipt?.phone ?? ""),
          legalEmail: normStrOrNull(receipt?.email ?? ""),
          legalTaxIdentifier: normStrOrNull(receipt?.tax_identifier ?? ""),
          legalRegistrationNumber: normStrOrNull(receipt?.registration_number ?? ""),
          legalTaxLabel: (receipt?.tax_label ?? "TVA").trim(),
          legalDefaultTaxRate: Number(receipt?.default_tax_rate ?? 0),
          legalPricesIncludeTax: receipt?.prices_include_tax ?? true,
          legalFooterText: normStrOrNull(receipt?.footer_text ?? ""),
          legalShowTaxSummary: receipt?.show_tax_summary ?? false,
        };
        // Commit ATOMIQUE (même rendu) : `legalProfileLoadedRestaurantId`
        // ne pointe JAMAIS vers `id` sans que les champs ci-dessus
        // n'aient déjà été posés pour CE MÊME restaurant.
        setLegalProfileLoadedRestaurantId(id);
        setLegalProfileReady(true);
      } catch {
        if (legalSeq !== legalRequestSeqRef.current) return;
        // Échec RÉEL : aucun instantané valide pour ce restaurant --
        // submit() reste de toute façon bloqué par legalProfileReady.
        legalSnapshotRef.current = null;
        // Échec RÉEL (pas "aucune ligne") : vide tous les champs --
        // jamais laisser un ancien restaurant visible/enregistrable --
        // et surface une erreur dédiée. `legalProfileReady` reste
        // `false` : submit() refuse d'enregistrer (voir plus bas).
        setLegalCountry(null);
        setLegalBusinessName("");
        setLegalName("");
        setLegalAddress("");
        setLegalPhone("");
        setLegalEmail("");
        setLegalTaxIdentifier("");
        setLegalRegistrationNumber("");
        setLegalTaxLabel("TVA");
        setLegalDefaultTaxRate("0");
        setLegalPricesIncludeTax(true);
        setLegalFooterText("");
        setLegalShowTaxSummary(false);
        setLegalProfileLoadedRestaurantId(null);
        setLegalProfileReady(false);
        setLegalProfileError(t("stLegalLoadFailed"));
      }
      // CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 — surcharges de texte de
      // suivi. Même garde de provenance (`token.isCurrent()`) que tout
      // le reste de cette page : une réponse périmée n'écrit jamais les
      // messages d'un autre établissement. Best-effort : un échec de
      // lecture laisse la grille vide (donc « textes de base »), ce qui
      // est toujours un état affichable correct -- jamais les messages
      // de l'établissement précédent.
      try {
        const overrides = await getMerchantTrackingStatusText(id);
        if (!token.isCurrent()) return;
        const next: Record<string, string> = {};
        for (const status of CANONICAL_ORDER_STATUSES) {
          next[status] = overrides[status] ?? "";
        }
        setStatusTexts(next);
        if (generalSnapshotRef.current) {
          generalSnapshotRef.current = { ...generalSnapshotRef.current, statusTexts: next };
        }
      } catch {
        if (!token.isCurrent()) return;
        setStatusTexts({});
        if (generalSnapshotRef.current) {
          generalSnapshotRef.current = { ...generalSnapshotRef.current, statusTexts: {} };
        }
      }

      try {
        const activeLangs = await getRestaurantActiveLanguages(id);
        if (!token.isCurrent()) return;
        const codes = activeLangs.length > 0 ? activeLangs.map((l) => l.code) : ["fr"];
        setActiveLanguageCodes(codes);
        if (generalSnapshotRef.current) {
          generalSnapshotRef.current = { ...generalSnapshotRef.current, activeLanguageCodes: codes };
        }
      } catch {
        if (!token.isCurrent()) return;
        // Best-effort : une erreur de lecture des langues actives
        // n'empêche pas d'afficher le reste des réglages ; repli sur
        // la langue source seule, cohérent avec l'invariant "au moins
        // la langue source active".
        const codes = [s.source_language ?? "fr"];
        setActiveLanguageCodes(codes);
        if (generalSnapshotRef.current) {
          generalSnapshotRef.current = { ...generalSnapshotRef.current, activeLanguageCodes: codes };
        }
      }
      setError(null);
    } catch (e) {
      if (!token.isCurrent()) return;
      setError(e instanceof Error ? e.message : t("mcLoadFailed"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guard]);

  useEffect(() => {
    (async () => {
      const user = await getUser();
      if (!user) {
        router.replace("/dashboard/login");
        return;
      }
      try {
        const [next, opFlag] = await Promise.all([
          getMerchantRestaurants(),
          isScanymOperator(),
        ]);
        setIsOperator(opFlag);
        setMappings(next);

        const wanted = new URLSearchParams(window.location.search).get("r");
        // CONTEXT HARDENING v1 -- résolution UNIQUE et partagée : plus
        // aucun `match ?? next[0]`, donc plus de bascule silencieuse.
        // L'autorité opérateur vient toujours d'isScanymOperator(),
        // jamais de l'URL (mandat §11).
        const resolution = resolveRestaurantContext({
          requestedId: wanted,
          mappings: next,
          isOperator: opFlag,
        });

        if (resolution.kind === "unavailable") {
          setUnavailableContextId(resolution.requestedId);
        } else if (resolution.kind === "none") {
          setError(t("mcNoRestaurant"));
        } else {
          setUnavailableContextId(null);
          guard.enterContext(resolution.restaurantId);
          setRestaurantId(resolution.restaurantId);
          if (resolution.source === "operator") {
            // Opérateur Scanym consultant un établissement hors de ses
            // propres rattachements restaurant_users (F-01) : la
            // protection réelle reste côté RPC
            // (assert_restaurant_asset_role côté SQL).
            try {
              const summary = await getEstablishmentSummary(resolution.restaurantId);
              setOperatorRestaurantName(summary.name);
            } catch {
              // Best-effort : un nom introuvable n'empêche pas de
              // continuer, l'ID reste affiché par défaut.
            }
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : t("mcLoadFailed"));
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  useEffect(() => {
    void load(restaurantId);
  }, [restaurantId, load]);

  // LOT 1A — catalogue des langues supportées par Scanym : chargé une
  // seule fois, indépendant de l'établissement sélectionné (distinct
  // des langues ACTIVES de CET établissement, chargées dans load()).
  useEffect(() => {
    (async () => {
      try {
        setSupportedLanguages(await getSupportedLanguages());
      } catch {
        // Best-effort : sans catalogue, le sélecteur de langues actives
        // reste simplement vide plutôt que de bloquer toute la page.
      }
    })();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);

    // MERCHANT LEGAL & TAX PROFILE v1.2 -- ferme
    // MLTP-V11-DASHBOARD-GUARD-ORDER-01 (contre-audit Work sur v1.1) :
    // la garde de disponibilité/propriété du profil légal/fiscal
    // s'exécutait auparavant juste avant l'appel à
    // updateReceiptSettings, APRÈS que plusieurs RPC MUTANTES
    // (couleurs, maps, identité, bg_color, réseaux sociaux, langues,
    // WhatsApp/adresse/horaires) aient déjà pu s'exécuter. Une bascule
    // A -> B suivie d'un enregistrement avant la fin du chargement du
    // profil légal/fiscal de B pouvait donc déjà muter B (couleurs,
    // identité, etc.) avant que la garde ne rejette finalement
    // l'écriture Legal/Tax elle-même -- une mutation partielle, jamais
    // acceptable (mandat : "the guard must protect the entire settings
    // submission transaction flow", pas seulement update_receipt_settings).
    //
    // La garde est donc désormais la TOUTE PREMIÈRE instruction de
    // submit() -- avant la moindre validation cliente et avant le
    // moindre appel RPC mutant. Invariant exigé : AUCUNE RPC mutante ne
    // s'exécute tant que (1) le chargement autoritaire du profil légal
    // du restaurant COURANT n'est pas terminé, (2) legalProfileReady
    // n'est pas strictement true, (3) legalProfileLoadedRestaurantId ne
    // correspond pas exactement à restaurantId (donc que la sélection
    // de restaurant n'a pas changé depuis ce chargement -- la
    // réinitialisation SYNCHRONE de handleSelectRestaurant garantit
    // qu'un changement de restaurant invalide immédiatement ces deux
    // conditions, sans fenêtre de rendu intermédiaire).
    //
    // Un "aucune ligne" CONFIRMÉ reste un état PRÊT valide (création du
    // profil du restaurant courant autorisée) -- seul un chargement
    // encore en vol, un échec de lecture, ou une réponse appartenant à
    // un autre restaurant bloque désormais TOUTE la soumission, pas
    // seulement l'écriture Legal/Tax elle-même.
    if (!legalProfileReady || legalProfileLoadedRestaurantId !== restaurantId) {
      setError(t("stLegalNotReady"));
      return;
    }

    // Couleurs et lien de localisation/itinéraire : toujours validés
    // et enregistrés, pour owner/manager COMME pour un opérateur
    // Scanym en mode opérateur seul (V70-02) -- ce sont exactement
    // les champs qu'il est autorisé à modifier.
    for (const c of [primaryColor, secondaryColor, accentColor]) {
      if (c.trim() !== "" && !isValidHexColor(c.trim())) {
        setError(t("stColorInvalid"));
        return;
      }
    }
    // Corrige V73-01 (contre-audit Work, 4e tour) : la chaîne BRUTE
    // (`mapsUrl`, l'état du champ tel que saisi) est validée EN
    // PREMIER, jamais une version déjà nettoyée par normalizeMapsUrl.
    // L'ordre précédent (normaliser PUIS valider la valeur normalisée)
    // laissait passer un espace/retour ligne en tête ou fin -- la
    // normalisation les aurait silencieusement effacés avant même que
    // isValidMapsUrl() ne les voie, alors que sa propre grammaire
    // stricte est conçue pour les refuser explicitement (voir
    // lib/maps-url.ts, corrige V72-06). Si la valeur brute est
    // vide/blanche uniquement, c'est un champ vidé (traité comme
    // NULL) ; sinon, elle doit passer isValidMapsUrl() TELLE QUELLE.
    if (mapsUrl.trim() !== "" && !isValidMapsUrl(mapsUrl)) {
      setError(t("stMapsInvalid"));
      return;
    }

    // LOT 1A — validation client (retour immédiat), même contrat que
    // la validation SQL réelle -- jamais une confiance exclusive dans
    // ce contrôle frontend.
    if (bgColor.trim() !== "" && !isValidHexColor(bgColor.trim())) {
      setError(t("stColorInvalid"));
      return;
    }
    if (instagramUrl.trim() !== "" && !isValidInstagramUrl(instagramUrl.trim())) {
      setError(t("stInstagramInvalid"));
      return;
    }
    if (tiktokUrl.trim() !== "" && !isValidTiktokUrl(tiktokUrl.trim())) {
      setError(t("stTiktokInvalid"));
      return;
    }
    if (facebookUrl.trim() !== "" && !isValidFacebookUrl(facebookUrl.trim())) {
      setError(t("stFacebookInvalid"));
      return;
    }
    if (displayName.trim().length > 255) {
      setError(t("stDisplayNameTooLong"));
      return;
    }
    if (introText.length > 2000) {
      setError(t("stIntroTooLong"));
      return;
    }
    if (announcementText.length > 500) {
      setError(t("stAnnouncementTooLong"));
      return;
    }
    if (!activeLanguageCodes.includes(sourceLanguage)) {
      setError(t("stSourceLanguageNotActive"));
      return;
    }

    // MERCHANT LEGAL & TAX PROFILE v1 -- validation client, même
    // contrat que la validation RPC réelle (voir
    // supabase/DRAFT-lot-merchant-legal-tax-profile-v1.sql,
    // update_receipt_settings) -- jamais une confiance exclusive dans
    // ce contrôle frontend.
    const trimmedLegalEmail = legalEmail.trim();
    if (trimmedLegalEmail !== "" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmedLegalEmail)) {
      setError(t("stLegalEmailInvalid"));
      return;
    }
    const parsedTaxRate = Number(legalDefaultTaxRate);
    if (!Number.isFinite(parsedTaxRate) || parsedTaxRate < 0 || parsedTaxRate > 100) {
      setError(t("stLegalTaxRateInvalid"));
      return;
    }
    if (legalTaxLabel.trim() === "") {
      setError(t("stLegalTaxLabelRequired"));
      return;
    }
    // À ce stade, mapsUrl est soit vide/blanc (champ vidé), soit une
    // valeur qui a déjà passé la validation SUR SA FORME BRUTE -- par
    // construction, une valeur non vide qui valide n'a AUCUN espace
    // périphérique (la grammaire stricte l'exclut), donc ce
    // normalizeMapsUrl() ci-dessous ne fait plus qu'un trim
    // strictement sans effet sur une valeur déjà validée -- jamais un
    // moyen de transformer une entrée invalide en entrée valide.
    const cleanMapsUrl = normalizeMapsUrl(mapsUrl);

    // Validation effective côté interface, avant tout appel réseau :
    // le SQL revalide de la même façon, mais on évite ici un
    // aller-retour serveur pour une saisie manifestement invalide,
    // et on affiche un message explicite plutôt que l'erreur brute
    // renvoyée par la RPC. UNIQUEMENT pour owner/manager (V70-02) :
    // un opérateur en mode opérateur seul ne touche jamais à ces
    // champs, valider une valeur qu'il n'a pas pu modifier n'aurait
    // aucun sens et bloquerait inutilement l'enregistrement de ses
    // propres champs autorisés.
    if (!isOperatorOnlyMode) {
      const cleanWhatsapp = normalizeWhatsappNumber(whatsapp);
      // CUSTOMER CONTACT v1 : le numéro n'est exigé QUE si WhatsApp
      // reste activé -- un commerçant sans WhatsApp n'a jamais à
      // saisir de numéro.
      if (whatsappEnabled) {
        if (!isValidWhatsappNumber(cleanWhatsapp)) {
          setError(t("stWhatsappInvalid"));
          return;
        }
      }
      if (!isValidPublicPhone(publicPhone)) {
        setError(t("stPublicPhoneInvalid"));
        return;
      }
      if (!isValidPublicEmail(publicEmail)) {
        setError(t("stPublicEmailInvalid"));
        return;
      }
      // CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 — borne de longueur,
      // MIROIR de la contrainte SQL (le serveur reste l'autorité ;
      // cette vérification évite seulement un aller-retour et affiche
      // un message explicite plutôt que l'erreur brute de la RPC).
      if (
        Object.values(statusTexts).some(
          (body) => body.trim().length > MERCHANT_STATUS_TEXT_MAX_LENGTH
        )
      ) {
        setError(t("stTrackingStatusTooLong"));
        return;
      }
    }

    setSaving(true);

    // SETTINGS SAVE RELIABILITY v1.2 -- ferme SETTINGS-SAVE-
    // RELIABILITY-V1-STALE-SAVE-CONCURRENCY-01 (contre-audit
    // indépendant, Blocker 1) : réutilise le MÊME contrat de
    // provenance que load() (lib/restaurant-context-guard.ts, déjà
    // audité -- "reuse a smaller existing mechanism", jamais un
    // nouveau système de jetons inventé). Capturé ICI, avant toute
    // RPC mutante, `token` doit être revérifié (`token.isCurrent()`)
    // après CHAQUE `await` ci-dessous, AVANT de toucher un instantané
    // (`*SnapshotRef.current = ...`), un état React `set*`, un
    // compteur de succès, ou l'issue finale présentée à l'utilisateur
    // (`setSaved`/`setError`). Une bascule de restaurant pendant que
    // cette sauvegarde est en vol (`guard.enterContext` appelé par
    // `handleSelectRestaurant`) invalide IMMÉDIATEMENT ce jeton (même
    // génération, même restaurant requis) -- toute continuation
    // ultérieure de CETTE sauvegarde est alors silencieusement
    // abandonnée (`return`, jamais de `setError`/`setSaved` pour un
    // restaurant qui n'est plus affiché, jamais d'écrasement d'un
    // instantané qui appartient désormais à un AUTRE restaurant).
    const token = guard.beginRequest(restaurantId);

    // SETTINGS SAVE RELIABILITY v1.1 -- ferme SETTINGS-SAVE-
    // RELIABILITY-V1-PARTIAL-SAVE-01 (contre-audit indépendant de
    // 7ff1176 sur v1 : "the page-level flow is NOT atomic -- a
    // failure after receipt persistence leaves a partial save").
    //
    // v1 (SETTINGS-SAVE-RELIABILITY-V1-ORDER-01) avait seulement
    // réordonné les RPC (légal/fiscal en premier) en gardant le
    // principe "soumettre INCONDITIONNELLEMENT toutes les sections à
    // chaque clic" -- ce qui pouvait PERSISTER le légal/fiscal puis
    // échouer sur une section sans rapport, tout en affichant un
    // message d'échec global qui, lui, ne disait jamais que le
    // légal/fiscal avait pourtant réussi. C'est exactement
    // l'ambiguïté que le mandat interdit ("never claim global success
    // if one fails" ET "never leave an already-persisted section
    // looking unsaved" sont les DEUX faces du même interdit).
    //
    // v1.1 sépare explicitement QUELLES sections sont réellement
    // modifiées ("dirty", dérivé par comparaison à un instantané
    // normalisé -- voir generalSnapshotRef/legalSnapshotRef et les
    // comparateurs `*GroupDirty` en tête de fichier) de QUELLES
    // sections sont soumises : SEULES les sections dirty sont
    // candidates à une mutation. Une édition "légal uniquement"
    // n'appelle donc plus JAMAIS colors/mapsUrl/identity/bgColor/
    // social/languages ni le lot contact/WhatsApp/réglages/textes de
    // suivi -- et réciproquement (une édition "couleurs uniquement"
    // n'appelle plus jamais updateReceiptSettings).
    //
    // Chaque section dirty est TENTÉE indépendamment (jamais de
    // transaction inventée entre RPC sans rapport, mandat explicite :
    // "Do NOT invent a DB-wide transaction across unrelated RPCs") ;
    // le résultat de CHAQUE tentative est collecté, puis l'issue est
    // rapportée SANS AMBIGUÏTÉ :
    //   - toutes les sections dirty réussissent (ou aucune n'était
    //     dirty) -> succès affiché ;
    //   - AUCUNE section dirty tentée ne réussit -> le(s) message(s)
    //     d'échec, directement, sans ambiguïté possible (rien n'a été
    //     persisté, donc rien à cacher) ;
    //   - état MIXTE (au moins une réussite, au moins un échec) -> un
    //     préfixe EXPLICITE ("certaines modifications ont été
    //     enregistrées, d'autres ont échoué") précède le(s) message(s)
    //     d'échec -- jamais un message d'échec générique qui
    //     masquerait la réussite partielle.
    //
    // Le lot contact public/WhatsApp/réglages restaurant/textes de
    // suivi (owner/manager uniquement, V70-02/V71) reste un SEUL
    // groupe "dirty" (comme avant v1) : son atomicité INTERNE (un
    // échec y interrompt le reste du groupe) est INCHANGÉE -- seule la
    // décision de l'ATTEINDRE ou non devient conditionnée par son
    // état dirty global (mandat : "reuse a smaller existing mechanism
    // rather than a broad refactor", "keep this narrow").
    //
    // Validation INCHANGÉE (décision explicite, hors périmètre du
    // mandat) : toutes les validations ci-dessus continuent de
    // s'exécuter INCONDITIONNELLEMENT (pas seulement pour les
    // sections dirty) -- un champ laissé invalide ailleurs sur le
    // formulaire bloque toujours Enregistrer, exactement comme avant
    // cette remédiation. Seul l'ensemble des RPC MUTANTES réellement
    // appelées est désormais conditionné par l'état dirty.
    const currentGeneral: GeneralSettingsSnapshot = {
      lang,
      address: normStrOrNull(address),
      hours: normStrOrNull(hours),
      // Recalculée ici (même fonction PURE normalizeWhatsappNumber que
      // dans la validation ci-dessus, jamais une forme différente) --
      // la variable `cleanWhatsapp` elle-même reste scopée à
      // l'intérieur du bloc `if (!isOperatorOnlyMode)` (ferme
      // MLTP-V1-TEST-COVERAGE-01 : un test structurel préexistant,
      // déjà présent sur main avant cette remédiation, vérifie
      // explicitement que ce bloc commence par `const cleanWhatsapp`).
      whatsapp: normalizeWhatsappNumber(whatsapp),
      whatsappEnabled,
      publicPhone: normStr(publicPhone),
      publicEmail: normStr(publicEmail),
      statusTexts,
      primaryColor: normStrOrNull(primaryColor),
      secondaryColor: normStrOrNull(secondaryColor),
      accentColor: normStrOrNull(accentColor),
      mapsUrl: cleanMapsUrl || null,
      displayName: normStrOrNull(displayName),
      introText: normStrOrNull(introText),
      announcementText: normStrOrNull(announcementText),
      announcementActive,
      bgColor: normStrOrNull(bgColor),
      instagramUrl: normStrOrNull(instagramUrl),
      tiktokUrl: normStrOrNull(tiktokUrl),
      facebookUrl: normStrOrNull(facebookUrl),
      activeLanguageCodes,
    };
    const currentLegal: LegalTaxSnapshot = {
      legalBusinessName: normStrOrNull(legalBusinessName),
      legalName: normStrOrNull(legalName),
      legalAddress: normStrOrNull(legalAddress),
      legalPhone: normStrOrNull(legalPhone),
      legalEmail: trimmedLegalEmail || null,
      legalTaxIdentifier: normStrOrNull(legalTaxIdentifier),
      legalRegistrationNumber: normStrOrNull(legalRegistrationNumber),
      legalTaxLabel: legalTaxLabel.trim(),
      legalDefaultTaxRate: parsedTaxRate,
      legalPricesIncludeTax: legalPricesIncludeTax,
      legalFooterText: normStrOrNull(legalFooterText),
      legalShowTaxSummary: legalShowTaxSummary,
    };

    // Défensif (jamais réellement atteint hors d'un chargement en
    // échec -- la garde tout en haut de submit() bloque déjà ce cas
    // pour la section légale, et settingsLoadedRestaurantId masque le
    // formulaire entier tant que generalSnapshotRef n'est pas posé) :
    // un instantané absent est traité comme "dirty" -- jamais comme
    // "propre" -- pour ne jamais risquer de masquer silencieusement
    // une vraie modification.
    const legalDirty = !legalSnapshotRef.current || legalGroupDirty(legalSnapshotRef.current, currentLegal);
    const generalSnap = generalSnapshotRef.current;
    // SETTINGS SAVE RELIABILITY v1.2 -- QUATRE sous-groupes
    // indépendants (Blocker 2), chacun gardé par `!isOperatorOnlyMode`
    // (owner/manager uniquement, inchangé) -- remplace l'ancien
    // `contactDirty` unique, qui masquait quelle RPC précise était
    // réellement en cause.
    const publicContactDirty = !isOperatorOnlyMode && (!generalSnap || publicContactSubDirty(generalSnap, currentGeneral));
    // SETTINGS SAVE RELIABILITY v1.3 -- numéro et activation WhatsApp :
    // DEUX drapeaux "dirty" indépendants (Blocker 2A), remplaçant
    // l'ancien `whatsappDirty` combiné.
    const whatsappNumberDirty = !isOperatorOnlyMode && (!generalSnap || whatsappNumberSubDirty(generalSnap, currentGeneral));
    const whatsappEnabledDirty = !isOperatorOnlyMode && (!generalSnap || whatsappEnabledSubDirty(generalSnap, currentGeneral));
    const restaurantSettingsDirty = !isOperatorOnlyMode && (!generalSnap || restaurantSettingsSubDirty(generalSnap, currentGeneral));
    // SETTINGS SAVE RELIABILITY v1.3 -- ferme Blocker 2B : la liste des
    // statuts canoniques RÉELLEMENT modifiés (jamais les 7 d'un bloc),
    // calculée une fois ici comme toutes les autres sections, puis
    // tentée statut par statut dans submit() (voir plus bas). Un
    // instantané absent (généralSnap null) traite TOUS les statuts
    // comme dirty -- même règle défensive que pour les autres sections.
    const trackingTextDirtyStatuses = isOperatorOnlyMode
      ? []
      : CANONICAL_ORDER_STATUSES.filter(
          (status) => !generalSnap || trackingStatusDirty(generalSnap.statusTexts, currentGeneral.statusTexts, status)
        );
    const colorsDirty = !generalSnap || colorsGroupDirty(generalSnap, currentGeneral);
    const mapsUrlDirty = !generalSnap || mapsUrlGroupDirty(generalSnap, currentGeneral);
    const identityDirty = !generalSnap || identityGroupDirty(generalSnap, currentGeneral);
    const bgColorDirty = !generalSnap || bgColorGroupDirty(generalSnap, currentGeneral);
    const socialDirty = !generalSnap || socialGroupDirty(generalSnap, currentGeneral);
    const languagesDirty = !generalSnap || languagesGroupDirty(generalSnap, currentGeneral);

    const failedKeys: string[] = [];
    let attemptedCount = 0;
    let succeededCount = 0;

    if (legalDirty) {
      attemptedCount++;
      try {
        await updateReceiptSettings(restaurantId, {
          businessName: currentLegal.legalBusinessName,
          legalName: currentLegal.legalName,
          legalAddress: currentLegal.legalAddress,
          phone: currentLegal.legalPhone,
          email: currentLegal.legalEmail,
          taxIdentifier: currentLegal.legalTaxIdentifier,
          registrationNumber: currentLegal.legalRegistrationNumber,
          taxLabel: currentLegal.legalTaxLabel,
          defaultTaxRate: currentLegal.legalDefaultTaxRate,
          pricesIncludeTax: currentLegal.legalPricesIncludeTax,
          footerText: currentLegal.legalFooterText,
          showTaxSummary: currentLegal.legalShowTaxSummary,
        });
        // SETTINGS SAVE RELIABILITY v1.2 -- revérifié APRÈS cet await,
        // AVANT de toucher `legalSnapshotRef`/`succeededCount` : une
        // bascule de restaurant pendant que cet appel était en vol a
        // déjà invalidé `token` (voir sa déclaration ci-dessus) --
        // abandon silencieux, jamais d'écriture dans l'instantané d'un
        // AUTRE restaurant désormais affiché.
        if (!token.isCurrent()) return;
        legalSnapshotRef.current = currentLegal;
        succeededCount++;
      } catch {
        if (!token.isCurrent()) return;
        failedKeys.push("stLegalSaveError");
      }
    }

    // SETTINGS SAVE RELIABILITY v1.2 -- ferme SETTINGS-SAVE-
    // RELIABILITY-V1-CONTACT-BUNDLE-ATOMICITY-01 (contre-audit
    // indépendant, Blocker 2) : les QUATRE RPC de ce lot (contact
    // public, WhatsApp numéro+activation, réglages restaurant,
    // textes de suivi) sont désormais des sous-écritures INDÉPENDANTES
    // -- chacune avec son propre instantané/dirty-check, sa propre
    // tentative, et son propre succès/échec consigné séparément. Un
    // `try/catch` unique les traitait auparavant comme un seul bloc
    // "tout ou rien" : l'échec de l'UNE (ex. WhatsApp) après le succès
    // d'une AUTRE (ex. contact public) rapportait "zéro succès" alors
    // que le contact public avait bel et bien été persisté -- la même
    // ambiguïté de sauvegarde partielle que Blocker 1, mais À
    // L'INTÉRIEUR d'un seul groupe UI.
    //
    // Mandat : "Keep the existing RPCs. NO new DB-wide transaction. NO
    // SQL unless absolutely unavoidable." -- aucune RPC ajoutée/retirée/
    // fusionnée, aucune transaction SQL inventée ; seul le découpage
    // CÔTÉ INTERFACE de "une section dirty" en "quatre sous-sections
    // dirty" change, le reste de la mécanique (snapshot-diff,
    // `succeededCount`/`failedKeys`, issue à trois voies) est RÉUTILISÉ
    // tel quel (mandat v1.1, inchangé) -- pas un nouveau mécanisme.
    //
    // K5 (mandat) -- comportement EXPLICITE si la PREMIÈRE sous-écriture
    // échoue : les sous-écritures SUIVANTES sont tout de même TENTÉES
    // (jamais interrompues par l'échec d'une précédente), pour
    // persister le plus possible de ce que le marchand a réellement
    // modifié ; la véracité du rapport final (succès/échec/mixte) ne
    // dépend que des SOUS-RÉSULTATS réels, jamais d'un arrêt précoce.
    //
    // Ordre INCHANGÉ (contact public, puis WhatsApp, puis réglages
    // restaurant, puis textes de suivi) -- seule la portée du
    // try/catch change, de "tout le lot" à "une seule RPC".
    if (publicContactDirty) {
      attemptedCount++;
      try {
        await updateRestaurantPublicContact(restaurantId, currentGeneral.publicPhone, currentGeneral.publicEmail);
        if (!token.isCurrent()) return;
        if (generalSnapshotRef.current) {
          generalSnapshotRef.current = {
            ...generalSnapshotRef.current,
            publicPhone: currentGeneral.publicPhone,
            publicEmail: currentGeneral.publicEmail,
          };
        }
        succeededCount++;
      } catch {
        if (!token.isCurrent()) return;
        // SETTINGS SAVE RELIABILITY v1 -- ferme la fuite de message
        // serveur brut (invariant explicite : aucune erreur serveur
        // brute ne doit atteindre le marchand) -- UN SEUL message
        // visuel partagé par les quatre sous-écritures de ce lot
        // (mandat : "you may keep one visual error message for the
        // contact section"), jamais le texte PostgREST/SQL brut.
        failedKeys.push("stContactSaveError");
      }
    }

    // SETTINGS SAVE RELIABILITY v1.3 -- ferme SETTINGS-SAVE-
    // RELIABILITY-V1-WHATSAPP-SUBWRITE-01 (Blocker 2A, 3e contre-audit
    // indépendant) : numéro et activation sont maintenant DEUX
    // sous-écritures indépendamment comptabilisées (chacune son propre
    // attemptedCount/try-catch/avancée d'instantané) -- plus un seul
    // bloc "tout ou rien" comme en v1.2. La dépendance SQL réelle
    // (CUSTOMER CONTACT v1 : activer WhatsApp exige un numéro déjà
    // valide en base) est préservée explicitement ci-dessous : si ce
    // submit() vient LUI-MÊME de tenter de ré-soumettre un numéro dirty
    // et que cette tentative a échoué, l'activation n'est PAS tentée du
    // tout quand on cherche à ACTIVER (jamais de fausse réussite
    // rapportée pour elle -- elle reste dirty, retentée au prochain
    // Save, une fois le numéro réellement persisté). Désactiver, ou
    // activer avec un numéro déjà propre (non dirty ce tour-ci, donc
    // déjà persisté précédemment), n'a aucune dépendance et est tenté
    // indépendamment, que le numéro soit dirty ou non ce tour-ci
    // (W3/W4).
    // Contrat PRÉEXISTANT préservé (CUSTOMER CONTACT v1, inchangé) :
    // "désactivé -> le numéro stocké n'est ni exigé ni modifié" -- la
    // sous-écriture NUMÉRO n'est tentée QUE si WhatsApp est
    // actuellement activé, même si le champ (visible seulement quand
    // activé) avait été modifié avant une désactivation ultérieure
    // dans ce même submit(). Un numéro resté dirty mais non tenté ici
    // n'avance PAS dans l'instantané -- il sera retenté dès que
    // l'utilisateur réactive, jamais silencieusement perdu.
    let whatsappNumberFailedThisSubmit = false;
    if (whatsappNumberDirty && currentGeneral.whatsappEnabled) {
      attemptedCount++;
      try {
        await updateRestaurantWhatsapp(restaurantId, currentGeneral.whatsapp);
        if (!token.isCurrent()) return;
        // SETTINGS SAVE RELIABILITY v1.2 -- ferme SETTINGS-SAVE-
        // RELIABILITY-V1-STALE-SAVE-CONCURRENCY-01 (Blocker 1, volet
        // "newer edit") : `setWhatsapp(currentGeneral.whatsapp)` était
        // auparavant appelé SANS CONDITION après ce succès, écrasant
        // silencieusement une saisie plus récente (`Y`) par la valeur
        // SOUMISE (`X`) si l'utilisateur avait retapé le champ pendant
        // que cette RPC était en vol. Ne réécrit l'état live QUE si le
        // champ affiche encore EXACTEMENT la valeur BRUTE soumise
        // (`whatsapp`, capturée par fermeture au tout début de ce
        // submit()) -- sinon, l'édition plus récente reste affichée
        // TELLE QUELLE, et restera "dirty" au prochain Enregistrer
        // (comparée à l'instantané, qui lui avance bien à `X` plus
        // bas) : c'est exactement le comportement requis par le
        // mandat ("DB persisted X, snapshot may advance to X, UI
        // remains Y, Y therefore remains dirty, next Save attempts Y").
        // Toujours vrai en v1.3, inchangé -- seul le sous-groupe qui le
        // porte a changé (numéro seul, plus numéro+activation).
        setWhatsapp((live) => (live === whatsapp ? currentGeneral.whatsapp : live));
        if (generalSnapshotRef.current) {
          generalSnapshotRef.current = { ...generalSnapshotRef.current, whatsapp: currentGeneral.whatsapp };
        }
        succeededCount++;
      } catch {
        if (!token.isCurrent()) return;
        whatsappNumberFailedThisSubmit = true;
        failedKeys.push("stContactSaveError");
      }
    }

    // Dépendance SQL (CUSTOMER CONTACT v1, inchangée) : n'ACTIVE
    // jamais sur la base d'un numéro qui vient tout juste d'échouer à
    // se persister DANS CE MÊME submit(). Ne s'applique qu'à
    // l'ACTIVATION (whatsappEnabled -> true) -- désactiver n'a jamais
    // dépendu du numéro (CUSTOMER CONTACT v1 : "désactivé -> le numéro
    // stocké n'est ni exigé ni modifié").
    const whatsappEnabledBlockedByNumberDependency =
      currentGeneral.whatsappEnabled && whatsappNumberDirty && whatsappNumberFailedThisSubmit;
    if (whatsappEnabledDirty && !whatsappEnabledBlockedByNumberDependency) {
      attemptedCount++;
      try {
        await updateRestaurantWhatsappEnabled(restaurantId, currentGeneral.whatsappEnabled);
        if (!token.isCurrent()) return;
        if (generalSnapshotRef.current) {
          generalSnapshotRef.current = { ...generalSnapshotRef.current, whatsappEnabled: currentGeneral.whatsappEnabled };
        }
        succeededCount++;
      } catch {
        if (!token.isCurrent()) return;
        failedKeys.push("stContactSaveError");
      }
    }
    // Si bloquée par la dépendance : AUCUNE RPC, AUCUN compteur touché
    // -- `whatsappEnabled` reste simplement dirty (jamais une fausse
    // réussite, jamais un échec supplémentaire redondant au-dessus de
    // celui déjà poussé par le numéro ci-dessus), retentée seule une
    // fois le numéro réellement persisté (W2).

    if (restaurantSettingsDirty) {
      attemptedCount++;
      try {
        await updateRestaurantSettings(restaurantId, currentGeneral.lang, currentGeneral.address, currentGeneral.hours);
        if (!token.isCurrent()) return;
        if (generalSnapshotRef.current) {
          generalSnapshotRef.current = {
            ...generalSnapshotRef.current,
            lang: currentGeneral.lang,
            address: currentGeneral.address,
            hours: currentGeneral.hours,
          };
        }
        succeededCount++;
      } catch {
        if (!token.isCurrent()) return;
        failedKeys.push("stContactSaveError");
      }
    }

    // CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 / SETTINGS SAVE
    // RELIABILITY v1.3 — ferme SETTINGS-SAVE-RELIABILITY-V1-TRACKING-
    // TEXT-SUBWRITE-01 (Blocker 2B) : setAllMerchantTrackingStatusText
    // exécute EN RÉALITÉ une RPC PAR statut canonique (boucle
    // séquentielle, lib/services/tracking-status-text.ts) -- ce
    // n'était donc déjà pas une écriture atomique, même utilisée comme
    // telle par v1/v1.1/v1.2. Chaque statut de `trackingTextDirtyStatuses`
    // (calculée plus haut -- les seuls statuts RÉELLEMENT modifiés) est
    // maintenant tenté INDÉPENDAMMENT via l'appel UNITAIRE
    // setMerchantTrackingStatusText (déjà existant, inchangé, RPC
    // set_merchant_tracking_status_text -- tests/cfte-v1-merchant-
    // status-text-write.test.ts "2a") -- jamais
    // setAllMerchantTrackingStatusText, qui reste dans le dépôt pour
    // d'éventuels autres appelants mais n'est plus utilisée ici comme
    // la "transaction" de ce flux (mandat : "the dashboard save flow
    // must NOT use it as if it were one atomic write"). Politique
    // CONTINUE (mandat, préférée explicitement) : l'échec d'un statut
    // n'interrompt JAMAIS la tentative des statuts suivants -- tous les
    // statuts dirty sont tentés, chacun son propre succès/échec, son
    // propre avancement d'instantané PAR STATUT (jamais la grille
    // entière). Un champ laissé vide EFFACE la surcharge et rétablit le
    // texte de base -- jamais un texte vide affiché, inchangé.
    for (const status of trackingTextDirtyStatuses) {
      attemptedCount++;
      try {
        await setMerchantTrackingStatusText(restaurantId, status, currentGeneral.statusTexts[status] ?? "");
        if (!token.isCurrent()) return;
        if (generalSnapshotRef.current) {
          generalSnapshotRef.current = {
            ...generalSnapshotRef.current,
            statusTexts: { ...generalSnapshotRef.current.statusTexts, [status]: currentGeneral.statusTexts[status] ?? "" },
          };
        }
        succeededCount++;
      } catch {
        if (!token.isCurrent()) return;
        failedKeys.push("stContactSaveError");
      }
    }

    if (colorsDirty) {
      attemptedCount++;
      try {
        await updateRestaurantColors(restaurantId, currentGeneral.primaryColor, currentGeneral.secondaryColor, currentGeneral.accentColor);
        // SETTINGS-SAVE-RELIABILITY-V1-STALE-SAVE-CONCURRENCY-01 : garde
        // de péremption après l'await, avant toute écriture de snapshot
        // ou de compteur de succès -- un switch de restaurant pendant ce
        // RPC ne doit jamais faire muter l'état/snapshot du NOUVEAU
        // contexte avec le résultat tardif de l'ANCIEN.
        if (!token.isCurrent()) return;
        if (generalSnapshotRef.current) {
          generalSnapshotRef.current = {
            ...generalSnapshotRef.current,
            primaryColor: currentGeneral.primaryColor,
            secondaryColor: currentGeneral.secondaryColor,
            accentColor: currentGeneral.accentColor,
          };
        }
        succeededCount++;
      } catch {
        if (!token.isCurrent()) return;
        failedKeys.push("stColorsSaveError");
      }
    }

    if (mapsUrlDirty) {
      attemptedCount++;
      try {
        await updateRestaurantMapsUrl(restaurantId, currentGeneral.mapsUrl);
        if (!token.isCurrent()) return;
        // SETTINGS-SAVE-RELIABILITY-V1-STALE-SAVE-CONCURRENCY-01 : cas
        // cité nommément par le mandat ("DO NOT call setMapsUrl(X)
        // unconditionally after the await"). On ne réécrit la valeur
        // locale QUE si elle est encore strictement égale à la valeur
        // brute capturée par closure au début de submit() (= aucune
        // nouvelle frappe de l'utilisateur pendant l'attente du RPC).
        // Si l'utilisateur a tapé Y pendant que X était en vol, la
        // fonction updater lit l'état RÉEL courant (jamais une
        // fermeture périmée) et préserve Y intact : X est persisté en
        // base et le snapshot peut avancer à X, mais l'UI reste Y, donc
        // Y reste "dirty" et sera soumis au prochain Save (exactement
        // le résultat requis par le mandat, section "NEWER USER EDIT
        // DURING SAVE").
        setMapsUrl((live) => (live === mapsUrl ? (currentGeneral.mapsUrl ?? "") : live));
        if (generalSnapshotRef.current) {
          generalSnapshotRef.current = { ...generalSnapshotRef.current, mapsUrl: currentGeneral.mapsUrl };
        }
        succeededCount++;
      } catch {
        if (!token.isCurrent()) return;
        failedKeys.push("stMapsSaveError");
      }
    }

    // LOT 1A — identité/apparence/réseaux sociaux/langues : owner,
    // manager ET opérateur Scanym (assert_restaurant_asset_role, même
    // posture que les couleurs/maps_url ci-dessus -- F-01 Super
    // Admin), jamais restreint au seul mode formulaire complet.
    if (identityDirty) {
      attemptedCount++;
      try {
        await updateRestaurantIdentity(
          restaurantId,
          currentGeneral.displayName,
          currentGeneral.introText,
          currentGeneral.announcementText,
          currentGeneral.announcementActive
        );
        if (!token.isCurrent()) return;
        if (generalSnapshotRef.current) {
          generalSnapshotRef.current = {
            ...generalSnapshotRef.current,
            displayName: currentGeneral.displayName,
            introText: currentGeneral.introText,
            announcementText: currentGeneral.announcementText,
            announcementActive: currentGeneral.announcementActive,
          };
        }
        succeededCount++;
      } catch {
        if (!token.isCurrent()) return;
        failedKeys.push("stIdentitySaveError");
      }
    }

    if (bgColorDirty) {
      attemptedCount++;
      try {
        await updateRestaurantBgColor(restaurantId, currentGeneral.bgColor);
        if (!token.isCurrent()) return;
        if (generalSnapshotRef.current) {
          generalSnapshotRef.current = { ...generalSnapshotRef.current, bgColor: currentGeneral.bgColor };
        }
        succeededCount++;
      } catch {
        if (!token.isCurrent()) return;
        failedKeys.push("stColorsSaveError");
      }
    }

    if (socialDirty) {
      attemptedCount++;
      try {
        await updateRestaurantSocialLinks(restaurantId, currentGeneral.instagramUrl, currentGeneral.tiktokUrl, currentGeneral.facebookUrl);
        if (!token.isCurrent()) return;
        if (generalSnapshotRef.current) {
          generalSnapshotRef.current = {
            ...generalSnapshotRef.current,
            instagramUrl: currentGeneral.instagramUrl,
            tiktokUrl: currentGeneral.tiktokUrl,
            facebookUrl: currentGeneral.facebookUrl,
          };
        }
        succeededCount++;
      } catch {
        if (!token.isCurrent()) return;
        failedKeys.push("stSocialSaveError");
      }
    }

    if (languagesDirty) {
      attemptedCount++;
      try {
        await updateRestaurantLanguages(restaurantId, currentGeneral.activeLanguageCodes);
        if (!token.isCurrent()) return;
        if (generalSnapshotRef.current) {
          generalSnapshotRef.current = { ...generalSnapshotRef.current, activeLanguageCodes: currentGeneral.activeLanguageCodes };
        }
        succeededCount++;
      } catch {
        if (!token.isCurrent()) return;
        failedKeys.push("stLanguagesSaveError");
      }
    }

    // MERCHANT LEGAL & TAX PROFILE v1.2 -- la garde de disponibilité/
    // propriété (legalProfileReady / legalProfileLoadedRestaurantId)
    // vit désormais exclusivement TOUT EN HAUT de submit() (ferme
    // MLTP-V11-DASHBOARD-GUARD-ORDER-01 : elle protège maintenant le
    // flux de soumission ENTIER, pas seulement cet appel) -- jamais
    // dupliquée ici, pour ne laisser aucune ambiguïté sur la source de
    // vérité unique de cette garde.

    void attemptedCount; // conservé pour lisibilité/débogage, pas utilisé dans la décision ci-dessous

    // SETTINGS-SAVE-RELIABILITY-V1-STALE-SAVE-CONCURRENCY-01 : garde
    // défensive finale avant de PRÉSENTER le résultat (setSaved/setError)
    // -- techniquement déjà inatteignable si une garde précédente a
    // renvoyé tôt, mais le mandat exige explicitement de protéger aussi
    // "presenting save outcome tied to that context", donc on le rend
    // explicite plutôt que de compter implicitement sur l'ordre du code.
    if (!token.isCurrent()) return;

    if (failedKeys.length === 0) {
      // Soit toutes les sections dirty ont réussi, soit AUCUNE section
      // n'était dirty (S10 : formulaire inchangé -- zéro RPC mutante,
      // mais zéro échec aussi, donc jamais confondu avec une erreur).
      setSaved(true);
      if (!isOperatorOnlyMode) {
        setUiLang(lang as Lang);
      }
    } else if (succeededCount === 0) {
      // Aucune section tentée n'a réussi -- message(s) direct(s),
      // AUCUNE ambiguïté possible : rien n'a été persisté, donc rien à
      // cacher.
      const uniqueKeys = Array.from(new Set(failedKeys));
      setError(uniqueKeys.map((k) => t(k)).join(" "));
    } else {
      // ÉTAT MIXTE -- au moins une section a été persistée AVANT
      // qu'une autre échoue : JAMAIS prétendre un échec global (cela
      // masquerait la réussite partielle, l'interdiction explicite du
      // mandat), toujours nommer précisément ce qui a échoué.
      const uniqueKeys = Array.from(new Set(failedKeys));
      setError(t("stPartialSaveError") + " " + uniqueKeys.map((k) => t(k)).join(" "));
    }
    setSaving(false);
  }

  function resetColors() {
    setPrimaryColor("");
    setSecondaryColor("");
    setAccentColor("");
  }

  // Corrige L1A-04 (contre-audit Work, tour 1A.1) : réordonnancement
  // simple (↑/↓), suffisant pour le MVP -- pas de drag & drop.
  // L'ordre du tableau activeLanguageCodes lui-même EST l'ordre
  // sauvegardé (voir submit() -> updateRestaurantLanguages).
  // Corrige L1A-04 (contre-audit Work, tour 1A.1) : réordonnancement
  // simple (↑/↓), suffisant pour le MVP -- pas de drag & drop. La
  // logique pure est factorisée dans lib/types.ts (moveLanguageInList),
  // testable indépendamment de ce composant. L'ordre du tableau
  // activeLanguageCodes lui-même EST l'ordre sauvegardé (voir
  // submit() -> updateRestaurantLanguages).
  function moveActiveLanguage(code: string, direction: -1 | 1) {
    setActiveLanguageCodes((prev) => moveLanguageInList(prev, code, direction));
  }

  // CONTEXT HARDENING v1 (§4.B) -- `?r=` explicite non résoluble :
  // état dédié, aucun établissement sélectionné, aucune donnée chargée.
  if (!loading && unavailableContextId) {
    return (
      <main className="p-6">
        <div
          role="alert"
          data-context-unavailable={unavailableContextId}
          className="mx-auto max-w-2xl rounded-2xl bg-white p-6 text-sm font-semibold text-red-700 shadow-sm"
        >
          {t("dsContextUnavailable")}
        </div>
      </main>
    );
  }

  if (loading) {
    return <main className="p-6 text-sm text-stone-500">{t("mcLoading")}</main>;
  }

  return (
    <>
      <DashboardNav
        restaurantName={mapping?.restaurants?.name ?? operatorRestaurantName ?? t("stTitle")}
        restaurantId={restaurantId}
        mappings={mappings}
        staffLanguage={uiLang}
        onSelectRestaurant={handleSelectRestaurant}
      />

      <main
        dir={uiLang === "ar" ? "rtl" : "ltr"}
        className="mx-auto max-w-2xl px-4 py-6"
      >
        <a
          href={restaurantId ? `/dashboard?r=${restaurantId}` : "/dashboard"}
          className="mb-4 inline-flex items-center gap-2 rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm font-bold text-stone-800"
        >
          &larr; {t("dsBackToOrders")}
        </a>

        <h2 className="text-xl font-black text-stone-900">{t("stTitle")}</h2>

        {!canEdit && (
          <p className="mt-3 rounded-xl bg-stone-100 p-3 text-sm text-stone-600">
            {t("stStaffOnly")}
          </p>
        )}

        {canEdit && isOperatorOnlyMode && (
          <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
            {t("stOperatorOnlyMode")}
          </p>
        )}

        {error && (
          <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
            {error}
          </p>
        )}

        {/* CONTEXT HARDENING v1.1 (§5) -- PORTE DE PROVENANCE. Le
            formulaire, entièrement dérivé du locataire, n'est rendu que
            si les réglages en mémoire ont été chargés pour
            l'établissement ACTUELLEMENT affiché. Sans cette porte, un
            rendu intermédiaire montrerait l'adresse et l'identité de
            l'établissement précédent sous l'entête du nouveau. */}
        {settingsLoadedRestaurantId !== restaurantId ? (
          <p data-context-loading="1" className="rounded-xl bg-stone-100 p-3 text-sm text-stone-500">
            {t("mcLoading")}
          </p>
        ) : (
        <form onSubmit={submit}>
        {!isOperatorOnlyMode && (
        <section className="mt-5 rounded-2xl border border-stone-200 bg-white p-4">
          <h3 className="font-bold text-stone-900">{t("stLangTitle")}</h3>
          <p className="mt-1 text-sm text-stone-500">
            {t("stLangHint")}
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            {LANGUAGES.map((l) => (
              <button
                key={l.code}
                type="button"
                onClick={() => canEdit && setLang(l.code)}
                disabled={!canEdit}
                aria-pressed={lang === l.code}
                className={
                  "flex-1 rounded-xl px-4 py-3 text-sm font-bold " +
                  (lang === l.code
                    ? "bg-stone-900 text-white"
                    : "border border-stone-300 bg-white text-stone-800") +
                  (canEdit ? "" : " opacity-60")
                }
              >
                {l.label}
              </button>
            ))}
          </div>
        </section>
        )}

        {!isOperatorOnlyMode && (
        <section className="mt-4 rounded-2xl border border-stone-200 bg-white p-4">
          <h3 className="font-bold text-stone-900">{t("stInfoTitle")}</h3>
          <p className="mt-1 text-sm text-stone-500">
            {t("stInfoHint")}
          </p>

          <label className="mt-3 block text-xs font-semibold text-stone-600">
            {t("stAddress")}
          </label>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            disabled={!canEdit}
            maxLength={300}
            className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
          />

          <label className="mt-3 block text-xs font-semibold text-stone-600">
            {t("stHours")}
          </label>
          {/* Corrige UI MULTILINE FIX v2 (root cause réelle confirmée
              en Production) : <input> simple ligne remplacé par
              <textarea> -- un marchand n'avait auparavant AUCUN moyen
              de saisir de véritables retours à la ligne (Enter n'a
              aucun effet dans un <input> HTML). value/onChange/
              maxLength/disabled fonctionnent à l'identique pour un
              <textarea> contrôlé -- aucune autre logique de
              validation/sauvegarde modifiée (hours.trim() || null
              préserve déjà les \n internes, seuls les bords sont
              retirés). Aucun parsing sémantique des horaires, aucun
              formatage automatique, aucun remplacement d'espaces par
              des retours à la ligne. */}
          <textarea
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            disabled={!canEdit}
            maxLength={120}
            rows={4}
            placeholder="07:00 - 23:00"
            className="mt-1 w-full resize-y rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
          />
          <p className="mt-1 text-xs text-stone-500">
            {t("stHoursHint")}
          </p>
        </section>
        )}

        {/* Corrige V70-02 : maps_url a sa PROPRE section, distincte
            d'adresse/horaires -- c'est un champ autorisé pour un
            opérateur Scanym en mode opérateur seul, donc toujours
            rendu quand canEdit, indépendamment de isOperatorOnlyMode. */}
        <section className="mt-4 rounded-2xl border border-stone-200 bg-white p-4">
          <h3 className="font-bold text-stone-900">{t("stMapsTitle")}</h3>
          <div className="mt-1 flex items-center gap-2">
            <input
              value={mapsUrl}
              onChange={(e) => setMapsUrl(e.target.value)}
              disabled={!canEdit}
              maxLength={MAPS_URL_MAX_LENGTH}
              placeholder="https://maps.app.goo.gl/…"
              dir="ltr"
              className={
                "min-w-0 flex-1 rounded-xl border p-2.5 text-sm disabled:bg-stone-50 " +
                (mapsUrl.trim() === "" || isValidMapsUrl(mapsUrl)
                  ? "border-stone-300"
                  : "border-amber-500 bg-amber-50")
              }
            />
            {mapsUrl.trim() !== "" && isValidMapsUrl(mapsUrl) && (
              <a
                href={normalizeMapsUrl(mapsUrl)}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 rounded-xl border border-stone-300 px-3 py-2.5 text-xs font-semibold text-stone-700"
              >
                {t("stMapsTest")}
              </a>
            )}
          </div>
          <p className="mt-1 text-xs text-stone-500">{t("stMapsHint")}</p>
          {mapsUrl.trim() !== "" && !isValidMapsUrl(mapsUrl) && (
            <p className="mt-1 text-xs font-semibold text-amber-700">{t("stMapsInvalid")}</p>
          )}
        </section>

        {!isOperatorOnlyMode && (
        <section className="mt-4 rounded-2xl border border-stone-200 bg-white p-4">
          <h3 className="font-bold text-stone-900">{t("stWhatsappTitle")}</h3>
          <p className="mt-1 text-sm text-stone-500">{t("stWhatsappHint")}</p>

          <label className="mt-3 flex items-start gap-2 text-sm text-stone-800">
            <input
              type="checkbox"
              data-settings-whatsapp-enabled=""
              checked={whatsappEnabled}
              onChange={(e) => setWhatsappEnabled(e.target.checked)}
              disabled={!canEdit}
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <span>
              <span className="font-semibold">{t("stWhatsappEnabledLabel")}</span>
              <span className="mt-0.5 block text-xs text-stone-500">{t("stWhatsappEnabledHint")}</span>
            </span>
          </label>

          {whatsappEnabled && (
          <input
            value={whatsapp}
            onChange={(e) => setWhatsapp(e.target.value)}
            disabled={!canEdit}
            required
            maxLength={50}
            pattern="^\+?[0-9 \-]{6,50}$"
            title={t("stWhatsappInvalid")}
            placeholder="+213 550 00 00 00"
            dir="ltr"
            className="mt-3 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
          />
          )}
        </section>
        )}

        {!isOperatorOnlyMode && (
        <section className="mt-4 rounded-2xl border border-stone-200 bg-white p-4" data-settings-public-contact="">
          <h3 className="font-bold text-stone-900">{t("stPublicContactTitle")}</h3>
          <p className="mt-1 text-sm text-stone-500">{t("stPublicContactHint")}</p>
          <label className="mt-3 block text-xs font-semibold text-stone-600">{t("stPublicPhoneLabel")}</label>
          <input
            type="tel"
            value={publicPhone}
            onChange={(e) => setPublicPhone(e.target.value)}
            disabled={!canEdit}
            maxLength={31}
            dir="ltr"
            className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
          />
          {!isValidPublicPhone(publicPhone) && (
            <p className="mt-1 text-xs font-semibold text-amber-700">{t("stPublicPhoneInvalid")}</p>
          )}
          <label className="mt-3 block text-xs font-semibold text-stone-600">{t("stPublicEmailLabel")}</label>
          <input
            type="email"
            value={publicEmail}
            onChange={(e) => setPublicEmail(e.target.value)}
            disabled={!canEdit}
            maxLength={254}
            dir="ltr"
            className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
          />
          {!isValidPublicEmail(publicEmail) && (
            <p className="mt-1 text-xs font-semibold text-amber-700">{t("stPublicEmailInvalid")}</p>
          )}
        </section>
        )}

        {/* CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 — surcharge de TEXTE
            par statut CANONIQUE. La grille est dérivée de
            CANONICAL_ORDER_STATUSES (lib/tracking/status.ts, SEULE
            autorité) : aucune liste de statuts n'est recopiée ici, et
            aucun statut supplémentaire ne peut donc apparaître dans ce
            formulaire. Le libellé de chaque ligne est le libellé COURT
            déjà utilisé côté client ; le placeholder est le texte de
            BASE réel, pour que le commerçant voie exactement ce qui
            s'affichera s'il laisse le champ vide. */}
        {!isOperatorOnlyMode && (
        <section
          className="mt-4 rounded-2xl border border-stone-200 bg-white p-4"
          data-settings-tracking-status-text=""
        >
          <h3 className="font-bold text-stone-900">{t("stTrackingStatusTitle")}</h3>
          <p className="mt-1 text-sm text-stone-500">{t("stTrackingStatusHint")}</p>
          {CANONICAL_ORDER_STATUSES.map((status) => (
            <div key={status} className="mt-3">
              <label
                htmlFor={`tracking-status-text-${status}`}
                className="block text-xs font-semibold text-stone-600"
              >
                {t(statusLabelKey(status))}
              </label>
              <textarea
                id={`tracking-status-text-${status}`}
                value={statusTexts[status] ?? ""}
                onChange={(e) =>
                  setStatusTexts((prev) => ({ ...prev, [status]: e.target.value }))
                }
                disabled={!canEdit}
                rows={2}
                maxLength={MERCHANT_STATUS_TEXT_MAX_LENGTH}
                placeholder={t(statusExplanationKey(status))}
                className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
              />
            </div>
          ))}
        </section>
        )}

        <section className="mt-4 rounded-2xl border border-stone-200 bg-white p-4">
          <h3 className="font-bold text-stone-900">{t("stIdentityTitle")}</h3>
          <p className="mt-1 text-sm text-stone-500">{t("stIdentityHint")}</p>

          <div className="mt-3">
            <p className="mb-1.5 text-xs font-semibold text-stone-600">{t("stLogoTitle")}</p>
            <AssetField
              kind="logo"
              restaurantId={restaurantId}
              currentUrl={logoUrl}
              disabled={!canEdit}
              t={t}
              onChanged={setLogoUrl}
            />
          </div>

          <div className="mt-4">
            <p className="mb-1.5 text-xs font-semibold text-stone-600">{t("stCoverTitle")}</p>
            <AssetField
              kind="cover"
              restaurantId={restaurantId}
              currentUrl={coverUrl}
              disabled={!canEdit}
              t={t}
              onChanged={setCoverUrl}
            />
          </div>

          <div className="mt-5 border-t border-stone-100 pt-4">
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-stone-900">{t("stColorsTitle")}</h4>
              {(primaryColor || secondaryColor || accentColor) && (
                <button
                  type="button"
                  onClick={resetColors}
                  disabled={!canEdit}
                  className="text-xs font-semibold text-stone-500 underline disabled:opacity-40"
                >
                  {t("stColorsReset")}
                </button>
              )}
            </div>
            <p className="mt-1 text-sm text-stone-500">{t("stColorsHint")}</p>

            <ColorField
              label={t("stPrimaryColor")}
              helpText={t("stPrimaryColorHelp")}
              value={primaryColor}
              onChange={setPrimaryColor}
              disabled={!canEdit}
              t={t}
            />
            <ColorField
              label={t("stSecondaryColor")}
              helpText={t("stSecondaryColorHelp")}
              value={secondaryColor}
              onChange={setSecondaryColor}
              disabled={!canEdit}
              t={t}
            />
            <ColorField
              label={t("stAccentColor")}
              helpText={t("stAccentColorHelp")}
              value={accentColor}
              onChange={setAccentColor}
              disabled={!canEdit}
              t={t}
            />
            <ColorField
              label={t("stBgColorLabel")}
              helpText={t("stBgColorHelp")}
              value={bgColor}
              onChange={setBgColor}
              disabled={!canEdit}
              t={t}
            />
          </div>
        </section>

        {/* LOT 1A — identité et présentation : nom affiché, texte
            d'introduction, message temporaire. Section distincte de
            "Identité visuelle" (logo/couleurs) ci-dessus, pour éviter
            une fiche à trop de champs simultanés (conception validée
            Design First). */}
        <section className="mt-4 rounded-2xl border border-stone-200 bg-white p-4">
          <h3 className="font-bold text-stone-900">{t("stIdentityContentTitle")}</h3>

          <div className="mt-3">
            <label className="block text-xs font-semibold text-stone-600">
              {t("stDisplayName")}
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={!canEdit}
              maxLength={255}
              className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
            />
            <p className="mt-1 text-xs text-stone-400">{t("stDisplayNameHelp")}</p>
          </div>

          <div className="mt-4">
            <label className="block text-xs font-semibold text-stone-600">
              {t("stIntroText")}
            </label>
            <textarea
              value={introText}
              onChange={(e) => setIntroText(e.target.value)}
              disabled={!canEdit}
              maxLength={2000}
              rows={4}
              className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
            />
          </div>

          <div className="mt-4 border-t border-stone-100 pt-4">
            <label className="block text-xs font-semibold text-stone-600">
              {t("stAnnouncementText")}
            </label>
            <textarea
              value={announcementText}
              onChange={(e) => setAnnouncementText(e.target.value)}
              disabled={!canEdit}
              maxLength={500}
              rows={2}
              className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
            />
            <label className="mt-2 flex items-center gap-2 text-sm text-stone-700">
              <input
                type="checkbox"
                checked={announcementActive}
                onChange={(e) => setAnnouncementActive(e.target.checked)}
                disabled={!canEdit}
              />
              {t("stAnnouncementActive")}
            </label>
          </div>
        </section>

        {/* LOT 1A — réseaux sociaux : un champ par réseau, validés
            serveur (HTTPS strict, domaine exact). Champ vide = icône
            non affichée sur la carte publique. */}
        <section className="mt-4 rounded-2xl border border-stone-200 bg-white p-4">
          <h3 className="font-bold text-stone-900">{t("stSocialTitle")}</h3>

          <div className="mt-3">
            <label className="block text-xs font-semibold text-stone-600">Instagram</label>
            <input
              type="text"
              inputMode="url"
              dir="ltr"
              value={instagramUrl}
              onChange={(e) => setInstagramUrl(e.target.value)}
              disabled={!canEdit}
              placeholder="https://instagram.com/..."
              className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
            />
          </div>
          <div className="mt-3">
            <label className="block text-xs font-semibold text-stone-600">TikTok</label>
            <input
              type="text"
              inputMode="url"
              dir="ltr"
              value={tiktokUrl}
              onChange={(e) => setTiktokUrl(e.target.value)}
              disabled={!canEdit}
              placeholder="https://tiktok.com/@..."
              className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
            />
          </div>
          <div className="mt-3">
            <label className="block text-xs font-semibold text-stone-600">Facebook</label>
            <input
              type="text"
              inputMode="url"
              dir="ltr"
              value={facebookUrl}
              onChange={(e) => setFacebookUrl(e.target.value)}
              disabled={!canEdit}
              placeholder="https://facebook.com/..."
              className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
            />
          </div>
        </section>

        {/* LOT 1A — langues : supportedLanguages est le catalogue
            Scanym (jamais spécifique à cet établissement) ;
            activeLanguageCodes est ce que CET établissement a choisi
            -- les deux notions ne sont jamais confondues (voir
            lib/types.ts). La langue source ne peut pas être décochée
            (invariant appliqué aussi côté SQL).
            Corrige L1A-04 (contre-audit Work, tour 1A.1) : l'ordre
            (display_order) est désormais réellement administrable --
            boutons ↑/↓ simples (pas de drag & drop, suffisant pour le
            MVP), l'ordre du tableau activeLanguageCodes lui-même EST
            l'ordre sauvegardé (voir submit() -> updateRestaurantLanguages,
            qui pose display_order = position dans ce tableau). */}
        <section className="mt-4 rounded-2xl border border-stone-200 bg-white p-4">
          <h3 className="font-bold text-stone-900">{t("stLanguagesTitle")}</h3>
          <p className="mt-1 text-sm text-stone-500">{t("stLanguagesHelp")}</p>

          <div className="mt-3 space-y-2">
            {activeLanguageCodes.map((code, index) => {
              const l = supportedLanguages.find((sl) => sl.code === code);
              if (!l) return null;
              const isSource = code === sourceLanguage;
              return (
                <div
                  key={l.code}
                  className="flex items-center justify-between rounded-xl border border-stone-200 p-2.5 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <span className="flex flex-col">
                      <button
                        type="button"
                        aria-label={t("stMoveLanguageUp")}
                        disabled={!canEdit || index === 0}
                        onClick={() => moveActiveLanguage(code, -1)}
                        className="leading-none text-stone-500 disabled:opacity-30"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        aria-label={t("stMoveLanguageDown")}
                        disabled={!canEdit || index === activeLanguageCodes.length - 1}
                        onClick={() => moveActiveLanguage(code, 1)}
                        className="leading-none text-stone-500 disabled:opacity-30"
                      >
                        ▼
                      </button>
                    </span>
                    {l.label}
                  </span>
                  <span className="flex items-center gap-2">
                    {isSource ? (
                      <span className="text-xs font-semibold text-stone-400">
                        {t("stSourceLanguage")}
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={!canEdit}
                        onClick={() =>
                          setActiveLanguageCodes((prev) => prev.filter((c) => c !== code))
                        }
                        className="text-xs font-semibold text-stone-500 underline disabled:opacity-40"
                      >
                        {t("stRemoveLanguage")}
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>

          {supportedLanguages.some((l) => !activeLanguageCodes.includes(l.code)) && (
            <div className="mt-4 border-t border-stone-100 pt-3">
              <p className="mb-1.5 text-xs font-semibold text-stone-600">
                {t("stAddLanguage")}
              </p>
              <div className="flex flex-wrap gap-2">
                {supportedLanguages
                  .filter((l) => !activeLanguageCodes.includes(l.code))
                  .map((l) => (
                    <button
                      key={l.code}
                      type="button"
                      disabled={!canEdit}
                      onClick={() => setActiveLanguageCodes((prev) => [...prev, l.code])}
                      className="rounded-full border border-stone-300 px-3 py-1 text-xs font-semibold text-stone-700 disabled:opacity-40"
                    >
                      + {l.label}
                    </button>
                  ))}
              </div>
            </div>
          )}
        </section>

        {/* MERCHANT LEGAL & TAX PROFILE v1 — complète public.receipt_settings
            (V29), jusqu'ici en lecture seule. Même posture que
            colors/maps_url/identity ci-dessus : rendu dès que canEdit
            (owner, manager, OU opérateur Scanym en mode opérateur seul),
            jamais restreint à canEditFull -- assert_receipt_settings_role
            (côté SQL) accepte exactement les mêmes trois profils. */}
        <section className="mt-4 rounded-2xl border border-stone-200 bg-white p-4">
          <h3 className="font-bold text-stone-900">{t("stLegalTitle")}</h3>
          <p className="mt-1 text-sm text-stone-500">{t("stLegalHint")}</p>
          {/* MERCHANT LEGAL & TAX PROFILE v1.1 -- ferme
              MLTP-V1-DASHBOARD-STALE-WRITE-01 : erreur DÉDIÉE à cette
              section (distincte du bandeau d'erreur global de la
              page), affichée UNIQUEMENT quand la lecture du profil
              légal/fiscal du restaurant COURANT a réellement échoué
              (jamais pour "aucune ligne", un cas légitime -- voir
              load()). Tant que cette erreur est affichée,
              `legalProfileReady` reste false et submit() refuse
              d'enregistrer cette section. */}
          {legalProfileError && (
            <p className="mt-2 rounded-xl bg-red-50 p-2.5 text-sm font-semibold text-red-700">
              {legalProfileError}
            </p>
          )}

          <label className="mt-3 block text-xs font-semibold text-stone-600">
            {t("stLegalBusinessName")}
          </label>
          <input
            value={legalBusinessName}
            onChange={(e) => setLegalBusinessName(e.target.value)}
            disabled={!canEdit}
            maxLength={255}
            className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
          />

          <label className="mt-3 block text-xs font-semibold text-stone-600">
            {t("stLegalName")}
          </label>
          <input
            value={legalName}
            onChange={(e) => setLegalName(e.target.value)}
            disabled={!canEdit}
            maxLength={255}
            className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
          />

          <label className="mt-3 block text-xs font-semibold text-stone-600">
            {t("stLegalAddress")}
          </label>
          <textarea
            value={legalAddress}
            onChange={(e) => setLegalAddress(e.target.value)}
            disabled={!canEdit}
            maxLength={500}
            rows={2}
            className="mt-1 w-full resize-y rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
          />

          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-semibold text-stone-600">
                {t("stLegalPhone")}
              </label>
              <input
                value={legalPhone}
                onChange={(e) => setLegalPhone(e.target.value)}
                disabled={!canEdit}
                maxLength={50}
                dir="ltr"
                className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-stone-600">
                {t("stLegalEmail")}
              </label>
              <input
                type="text"
                inputMode="email"
                value={legalEmail}
                onChange={(e) => setLegalEmail(e.target.value)}
                disabled={!canEdit}
                maxLength={255}
                dir="ltr"
                className={
                  "mt-1 w-full rounded-xl border p-2.5 text-sm disabled:bg-stone-50 " +
                  (legalEmail.trim() === "" ||
                  /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(legalEmail.trim())
                    ? "border-stone-300"
                    : "border-amber-500 bg-amber-50")
                }
              />
            </div>
          </div>

          {/* Intitulés country-aware (lib/merchant-legal-tax-labels.ts) :
              la DONNÉE stockée reste générique (tax_identifier,
              registration_number) -- seul le LIBELLÉ affiché varie
              selon restaurants.country. */}
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-semibold text-stone-600">
                {legalLabels.registrationNumberLabel}
              </label>
              <input
                value={legalRegistrationNumber}
                onChange={(e) => setLegalRegistrationNumber(e.target.value)}
                disabled={!canEdit}
                maxLength={100}
                dir="ltr"
                className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-stone-600">
                {legalLabels.taxIdentifierLabel}
              </label>
              <input
                value={legalTaxIdentifier}
                onChange={(e) => setLegalTaxIdentifier(e.target.value)}
                disabled={!canEdit}
                maxLength={100}
                dir="ltr"
                className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
              />
            </div>
          </div>

          <div className="mt-4 border-t border-stone-100 pt-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-semibold text-stone-600">
                  {t("stLegalTaxLabel")}
                </label>
                <input
                  value={legalTaxLabel}
                  onChange={(e) => setLegalTaxLabel(e.target.value)}
                  disabled={!canEdit}
                  maxLength={40}
                  dir="ltr"
                  className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
                />
                <p className="mt-1 text-xs text-stone-400">{t("stLegalTaxLabelHelp")}</p>
              </div>
              <div>
                <label className="block text-xs font-semibold text-stone-600">
                  {t("stLegalDefaultTaxRate")}
                </label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  value={legalDefaultTaxRate}
                  onChange={(e) => setLegalDefaultTaxRate(e.target.value)}
                  disabled={!canEdit}
                  dir="ltr"
                  className="mt-1 w-full rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
                />
              </div>
            </div>

            <label className="mt-3 flex items-center gap-2 text-sm text-stone-700">
              <input
                type="checkbox"
                checked={legalPricesIncludeTax}
                onChange={(e) => setLegalPricesIncludeTax(e.target.checked)}
                disabled={!canEdit}
              />
              {t("stLegalPricesIncludeTax")}
            </label>
            <label className="mt-2 flex items-center gap-2 text-sm text-stone-700">
              <input
                type="checkbox"
                checked={legalShowTaxSummary}
                onChange={(e) => setLegalShowTaxSummary(e.target.checked)}
                disabled={!canEdit}
              />
              {t("stLegalShowTaxSummary")}
            </label>
          </div>

          <div className="mt-4 border-t border-stone-100 pt-4">
            <label className="block text-xs font-semibold text-stone-600">
              {t("stLegalFooterText")}
            </label>
            <textarea
              value={legalFooterText}
              onChange={(e) => setLegalFooterText(e.target.value)}
              disabled={!canEdit}
              maxLength={1000}
              rows={2}
              className="mt-1 w-full resize-y rounded-xl border border-stone-300 p-2.5 text-sm disabled:bg-stone-50"
            />
          </div>
        </section>

        {canEdit && (
          <div className="mt-5 flex items-center gap-3">
            {/* MERCHANT LEGAL & TAX PROFILE v1.2 -- ferme
                MLTP-V11-DASHBOARD-GUARD-ORDER-01 : le bouton n'était
                auparavant désactivé que par `saving`, jamais par l'état
                du profil légal/fiscal du restaurant COURANT -- un clic
                pendant un chargement en vol, un échec de lecture, ou
                juste après une bascule de restaurant restait possible
                (la garde en tête de submit() bloquait alors la
                mutation, mais seulement APRÈS le clic). Le bouton
                reflète désormais la MÊME condition que la garde :
                désactivé tant que le profil légal/fiscal du restaurant
                courant n'est pas chargé, a échoué, est périmé, ou
                appartient encore à un autre restaurant -- jamais
                seulement pendant `saving`. */}
            <button
              type="submit"
              disabled={saving || !legalProfileReady || legalProfileLoadedRestaurantId !== restaurantId}
              className="rounded-xl bg-stone-900 px-6 py-3 text-sm font-bold text-white disabled:opacity-50"
            >
              {saving ? t("stSaving") : t("mcSave")}
            </button>
            {saved && (
              <span className="text-sm font-semibold text-green-700">
                {t("stSaved")}
              </span>
            )}
          </div>
        )}
        </form>
        )}
      </main>
    </>
  );
}

/**
 * Bloc logo OU cover (V68) — un seul composant générique paramétré par
 * `kind`, réutilisé deux fois par SettingsPage. Flux : sélection d'un
 * fichier -> validation immédiate côté client (taille, signature
 * binaire réelle, la même que lib/services/establishment-assets.ts) ->
 * aperçu local (URL.createObjectURL) AVANT tout appel réseau ->
 * confirmation explicite ("Enregistrer") déclenche l'upload réel ;
 * "Annuler" abandonne la sélection sans rien envoyer. Aucun appel
 * réseau tant que l'utilisateur n'a pas confirmé.
 */
function AssetField({
  kind,
  restaurantId,
  currentUrl,
  disabled,
  t,
  onChanged,
}: {
  kind: EstablishmentAssetKind;
  restaurantId: string;
  currentUrl: string | null;
  disabled: boolean;
  t: (k: string, p?: Record<string, string | number>) => string;
  onChanged: (url: string | null) => void;
}) {
  const inputId = `establishment-asset-${kind}`;
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  useEffect(() => {
    previewUrlRef.current = previewUrl;
  }, [previewUrl]);

  // Révoque l'aperçu local en quittant la page, pour ne pas fuir
  // d'URL objet créée mais jamais confirmée ni annulée.
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  function clearPending() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingFile(null);
    setPreviewUrl(null);
  }

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // permet de re-choisir le même fichier ensuite
    if (!file) return;
    setLocalError(null);
    try {
      await validateEstablishmentAssetFile(file);
    } catch (err) {
      if (err instanceof InvalidFileTypeError) setLocalError(t("stAssetInvalidType"));
      else if (err instanceof FileTooLargeError) setLocalError(t("stAssetTooLarge"));
      else setLocalError(t("stAssetUploadError"));
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingFile(file);
    setPreviewUrl(URL.createObjectURL(file));
  }

  async function confirmUpload() {
    if (!pendingFile) return;
    setBusy(true);
    setLocalError(null);
    try {
      const newUrl = await addOrReplaceEstablishmentAsset(
        restaurantId,
        kind,
        pendingFile,
        currentUrl
      );
      clearPending();
      onChanged(newUrl);
    } catch (err) {
      if (err instanceof AssetUploadError) {
        console.error(`Establishment ${kind} upload failed:`, err.cause);
        setLocalError(t("stAssetUploadError"));
      } else if (err instanceof InvalidFileTypeError) {
        setLocalError(t("stAssetInvalidType"));
      } else if (err instanceof FileTooLargeError) {
        setLocalError(t("stAssetTooLarge"));
      } else {
        setLocalError(t("stAssetUploadError"));
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    // Confirmation avant suppression : geste irréversible (le fichier
    // Storage est ensuite nettoyé), même précédent qu'ailleurs dans le
    // dashboard (window.confirm natif, aucun composant de dialogue
    // dédié dans le projet à ce jour).
    if (!window.confirm(deleteConfirmLabel)) return;
    setBusy(true);
    setLocalError(null);
    try {
      await removeEstablishmentAsset(restaurantId, kind, currentUrl);
      onChanged(null);
    } catch (err) {
      if (err instanceof AssetRemoveError) {
        console.error(`Establishment ${kind} remove failed:`, err.cause);
      }
      setLocalError(t("stAssetRemoveError"));
    } finally {
      setBusy(false);
    }
  }

  const label = kind === "logo" ? t("stLogoTitle") : t("stCoverTitle");
  const noneLabel = kind === "logo" ? t("stLogoNone") : t("stCoverNone");
  const changeLabel = kind === "logo" ? t("stLogoChange") : t("stCoverChange");
  const deleteConfirmLabel =
    kind === "logo" ? t("stAssetDeleteLogoConfirm") : t("stAssetDeleteCoverConfirm");
  const displayUrl = previewUrl ?? currentUrl;

  return (
    // Corrige BUG UI 3 (backoffice, contour blanc parasite autour du
    // logo) : ce wrapper (bg-stone-50, quasi-blanc) est imbriqué dans
    // la section parente "Identité visuelle" (bg-white), elle-même
    // quasi-blanche. L'écart de teinte entre les deux, combiné au
    // padding (p-2.5) autour d'un aperçu circulaire (rounded-full),
    // produit un liseré/contour visible spécifiquement autour du
    // logo -- bien moins perceptible sur la couverture rectangulaire
    // (kind === "cover"), dont le contraste avec son fond n'est pas
    // aussi proche. Rien n'est appliqué directement sur l'élément
    // image lui-même (ni fond blanc, ni bordure, ni anneau, ni
    // contour, ni ombre) : la cause est cette imbrication de fonds
    // quasi-identiques, pas le fichier logo. Le fond du wrapper est
    // neutralisé (transparent) uniquement pour kind === "logo", pour
    // hériter directement du fond blanc de la section parente ;
    // kind === "cover" garde bg-stone-50 inchangé, comportement et
    // bordure identiques dans les deux cas.
    <div
      className={
        "rounded-xl border border-stone-200 p-2.5 " +
        (kind === "logo" ? "bg-white" : "bg-stone-50")
      }
    >
      <div className="flex items-center gap-3">
        {displayUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={displayUrl}
            alt={t("stAssetPreviewAlt", { label })}
            className={
              kind === "logo"
                ? "h-14 w-14 shrink-0 rounded-full object-cover"
                : "h-14 w-24 shrink-0 rounded-lg object-cover"
            }
          />
        ) : (
          <div
            className={
              "flex shrink-0 items-center justify-center rounded-lg border border-dashed border-stone-300 text-[10px] text-stone-400 " +
              (kind === "logo" ? "h-14 w-14 rounded-full" : "h-14 w-24")
            }
          >
            {noneLabel}
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {!pendingFile && (
            <>
              <label
                htmlFor={inputId}
                aria-disabled={disabled || busy}
                className={
                  "cursor-pointer rounded-xl border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold " +
                  (disabled || busy ? "pointer-events-none opacity-40" : "")
                }
              >
                {changeLabel}
              </label>
              <input
                id={inputId}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                disabled={disabled || busy}
                onChange={handleFileChange}
              />
              {currentUrl && (
                <button
                  type="button"
                  onClick={handleRemove}
                  disabled={disabled || busy}
                  className="rounded-xl border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-700 disabled:opacity-40"
                >
                  {t("stAssetRemove")}
                </button>
              )}
            </>
          )}

          {pendingFile && (
            <>
              <button
                type="button"
                onClick={confirmUpload}
                disabled={busy}
                className="rounded-xl bg-stone-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              >
                {busy ? t("stAssetSaving") : t("mcSave")}
              </button>
              <button
                type="button"
                onClick={clearPending}
                disabled={busy}
                className="rounded-xl border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-700 disabled:opacity-40"
              >
                {t("mcCancel")}
              </button>
            </>
          )}
        </div>
      </div>

      {localError && (
        <p className="mt-2 text-xs font-semibold text-amber-700">{localError}</p>
      )}
    </div>
  );
}

/**
 * Un champ couleur personnalisée (V69) : color picker HTML natif
 * synchronisé avec un champ texte #RRGGBB (les deux modifient le
 * même état, aucune divergence possible), plus un aperçu ("Aa") qui
 * réutilise EXACTEMENT readableTextColor (lib/color-contrast.ts) — la
 * même fonction qui déterminera la couleur du texte réellement rendue
 * sur la carte publique, pas une approximation visuelle séparée.
 * Vide = pas de personnalisation (thème Scanym par défaut).
 */
function ColorField({
  label,
  helpText,
  value,
  onChange,
  disabled,
  t,
}: {
  label: string;
  helpText?: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  t: (k: string, p?: Record<string, string | number>) => string;
}) {
  const trimmed = value.trim();
  const valid = trimmed === "" || isValidHexColor(trimmed);
  const pickerValue = valid && trimmed !== "" ? trimmed : "#ffffff";

  return (
    <div className="mt-3">
      <label className="block text-xs font-semibold text-stone-600">{label}</label>
      {helpText && <p className="mt-0.5 text-xs text-stone-400">{helpText}</p>}
      <div className="mt-1 flex items-center gap-2">
        <input
          type="color"
          value={pickerValue}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          className="h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-stone-300 disabled:cursor-not-allowed disabled:opacity-40"
        />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          maxLength={7}
          placeholder="#RRGGBB"
          dir="ltr"
          className={
            "w-28 rounded-xl border p-2 text-sm disabled:bg-stone-50 " +
            (valid ? "border-stone-300" : "border-amber-500 bg-amber-50")
          }
        />
        {trimmed !== "" && valid && (
          <span
            aria-hidden="true"
            className="rounded-lg px-2.5 py-1.5 text-xs font-bold"
            style={{ backgroundColor: trimmed, color: readableTextColor(trimmed) }}
          >
            Aa
          </span>
        )}
      </div>
      {!valid && (
        <p className="mt-1 text-xs font-semibold text-amber-700">{t("stColorInvalid")}</p>
      )}
    </div>
  );
}
