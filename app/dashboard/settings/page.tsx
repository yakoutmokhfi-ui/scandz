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
} from "@/lib/services/dashboard";
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

export default function SettingsPage() {
  const router = useRouter();
  const [mappings, setMappings] = useState<MerchantRestaurant[]>([]);
  const [restaurantId, setRestaurantId] = useState("");
  const [lang, setLang] = useState("fr");
  const [address, setAddress] = useState("");
  const [hours, setHours] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
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
    setRestaurantId(id);
  }, [resetLegalProfileState]);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    try {
      const s = await getRestaurantSettings(id);
      setLang(s.staff_receipt_language ?? "fr");
      setUiLang((s.staff_receipt_language ?? "fr") as Lang);
      setAddress(s.address ?? "");
      setHours(s.opening_hours ?? "");
      setWhatsapp(s.whatsapp_number ?? "");
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
        // Commit ATOMIQUE (même rendu) : `legalProfileLoadedRestaurantId`
        // ne pointe JAMAIS vers `id` sans que les champs ci-dessus
        // n'aient déjà été posés pour CE MÊME restaurant.
        setLegalProfileLoadedRestaurantId(id);
        setLegalProfileReady(true);
      } catch {
        if (legalSeq !== legalRequestSeqRef.current) return;
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
      try {
        const activeLangs = await getRestaurantActiveLanguages(id);
        setActiveLanguageCodes(
          activeLangs.length > 0 ? activeLangs.map((l) => l.code) : ["fr"]
        );
      } catch {
        // Best-effort : une erreur de lecture des langues actives
        // n'empêche pas d'afficher le reste des réglages ; repli sur
        // la langue source seule, cohérent avec l'invariant "au moins
        // la langue source active".
        setActiveLanguageCodes([s.source_language ?? "fr"]);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("mcLoadFailed"));
    }
  }, []);

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
        const match = wanted
          ? next.find((m) => m.restaurant_id === wanted)
          : undefined;

        if (wanted && !match && opFlag) {
          // Opérateur Scanym consultant un établissement hors de ses
          // propres rattachements restaurant_users (F-01) : le lien
          // ?r=<id> fait foi, la protection réelle reste côté RPC
          // (assert_restaurant_asset_role côté SQL).
          setRestaurantId(wanted);
          try {
            const summary = await getEstablishmentSummary(wanted);
            setOperatorRestaurantName(summary.name);
          } catch {
            // Best-effort : un nom introuvable n'empêche pas de
            // continuer, l'ID reste affiché par défaut (voir plus bas).
          }
        } else if (next.length === 0) {
          setError(t("mcNoRestaurant"));
        } else {
          setRestaurantId((match ?? next[0]).restaurant_id);
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
      if (!isValidWhatsappNumber(cleanWhatsapp)) {
        setError(t("stWhatsappInvalid"));
        return;
      }
    }

    setSaving(true);

    // Corrige V70-02 : WhatsApp/adresse/horaires/langue ne sont
    // JAMAIS appelés en mode opérateur seul -- ni validés, ni
    // enregistrés, ni même lus comme condition de blocage. Pour
    // owner/manager (ou un opérateur qui est PAR AILLEURS
    // légitimement owner/manager de cet établissement), le
    // comportement reste EXACTEMENT celui d'avant V71 : ces RPC sont
    // appelées en premier, un échec interrompt tout le reste (même
    // raison qu'avant -- éviter qu'une partie des réglages change
    // pendant qu'une autre échoue silencieusement).
    if (!isOperatorOnlyMode) {
      const cleanWhatsapp = normalizeWhatsappNumber(whatsapp);
      try {
        await updateRestaurantWhatsapp(restaurantId, cleanWhatsapp);
        setWhatsapp(cleanWhatsapp);

        await updateRestaurantSettings(
          restaurantId,
          lang,
          address.trim() || null,
          hours.trim() || null
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : t("stSaveFailed"));
        setSaving(false);
        return;
      }
    }

    try {
      await updateRestaurantColors(
        restaurantId,
        primaryColor.trim() || null,
        secondaryColor.trim() || null,
        accentColor.trim() || null
      );
    } catch {
      setError(t("stColorsSaveError"));
      setSaving(false);
      return;
    }

    try {
      await updateRestaurantMapsUrl(restaurantId, cleanMapsUrl || null);
      setMapsUrl(cleanMapsUrl);
    } catch {
      setError(t("stMapsSaveError"));
      setSaving(false);
      return;
    }

    // LOT 1A — identité/apparence/réseaux sociaux/langues : owner,
    // manager ET opérateur Scanym (assert_restaurant_asset_role, même
    // posture que les couleurs/maps_url ci-dessus -- F-01 Super
    // Admin), jamais restreint au seul mode formulaire complet.
    try {
      await updateRestaurantIdentity(
        restaurantId,
        displayName.trim() || null,
        introText.trim() || null,
        announcementText.trim() || null,
        announcementActive
      );
    } catch {
      setError(t("stIdentitySaveError"));
      setSaving(false);
      return;
    }

    try {
      await updateRestaurantBgColor(restaurantId, bgColor.trim() || null);
    } catch {
      setError(t("stColorsSaveError"));
      setSaving(false);
      return;
    }

    try {
      await updateRestaurantSocialLinks(
        restaurantId,
        instagramUrl.trim() || null,
        tiktokUrl.trim() || null,
        facebookUrl.trim() || null
      );
    } catch {
      setError(t("stSocialSaveError"));
      setSaving(false);
      return;
    }

    try {
      await updateRestaurantLanguages(restaurantId, activeLanguageCodes);
    } catch {
      setError(t("stLanguagesSaveError"));
      setSaving(false);
      return;
    }

    // MERCHANT LEGAL & TAX PROFILE v1.2 -- la garde de disponibilité/
    // propriété (legalProfileReady / legalProfileLoadedRestaurantId)
    // vit désormais exclusivement TOUT EN HAUT de submit() (ferme
    // MLTP-V11-DASHBOARD-GUARD-ORDER-01 : elle protège maintenant le
    // flux de soumission ENTIER, pas seulement cet appel) -- jamais
    // dupliquée ici, pour ne laisser aucune ambiguïté sur la source de
    // vérité unique de cette garde.

    // MERCHANT LEGAL & TAX PROFILE v1 -- même posture que colors/
    // maps_url/identity ci-dessus (canEdit, pas seulement canEditFull) :
    // un opérateur Scanym en mode opérateur seul reste autorisé à
    // modifier ce profil (assert_receipt_settings_role accepte
    // owner/manager OU opérateur, même patron que
    // assert_restaurant_asset_role).
    try {
      await updateReceiptSettings(restaurantId, {
        businessName: legalBusinessName.trim() || null,
        legalName: legalName.trim() || null,
        legalAddress: legalAddress.trim() || null,
        phone: legalPhone.trim() || null,
        email: trimmedLegalEmail || null,
        taxIdentifier: legalTaxIdentifier.trim() || null,
        registrationNumber: legalRegistrationNumber.trim() || null,
        taxLabel: legalTaxLabel.trim(),
        defaultTaxRate: parsedTaxRate,
        pricesIncludeTax: legalPricesIncludeTax,
        footerText: legalFooterText.trim() || null,
        showTaxSummary: legalShowTaxSummary,
      });
    } catch {
      setError(t("stLegalSaveError"));
      setSaving(false);
      return;
    }

    setSaved(true);
    if (!isOperatorOnlyMode) {
      setUiLang(lang as Lang);
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
