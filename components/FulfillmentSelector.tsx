"use client";

import { useState } from "react";
import type { ServiceMode } from "@/lib/restaurants-config";
import type { DeliveryStatus } from "@/lib/delivery";
import { type CustomerInfo, isValidPostalCode } from "@/lib/customer";
import type { FieldRequirementDisplayItem } from "@/lib/sale-modes-public";
import type { StructuredCustomerAddress } from "@/lib/address-types";
import { useI18n } from "@/lib/i18n-context";
import { getFulfillmentToneClass } from "@/lib/fulfillment-tone";
import AddressAutocomplete from "@/components/AddressAutocomplete";

type Errors = Partial<Record<keyof CustomerInfo, string>>;

function Field({
  id,
  label,
  value,
  error,
  placeholder,
  type = "text",
  inputMode,
  autoComplete,
  maxLength,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  error?: string;
  placeholder?: string;
  type?: string;
  inputMode?: "text" | "numeric" | "tel" | "email";
  autoComplete?: string;
  maxLength?: number;
  onChange: (v: string) => void;
}) {
  return (
    <div className="scroll-mt-4">
      <label htmlFor={id} className="block text-xs font-semibold text-ink-on-bg-muted">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        inputMode={inputMode}
        autoComplete={autoComplete}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        className={
          "mt-1 w-full max-w-full rounded-xl border bg-white p-3 text-base text-stone-900 placeholder:text-stone-500 outline-none focus:border-caramel sm:text-sm " +
          (error ? "border-amber-400" : "border-espresso/15")
        }
      />
      {error && <p className="mt-1 text-xs text-amber-700">{error}</p>}
    </div>
  );
}

/**
 * LOT 2B.4a.2 — table de rendu des champs GÉNÉRIQUES du catalogue
 * backend (get_restaurant_public_field_requirements), tels que
 * connus aujourd'hui : "customer_name", "phone", "email". Ni une
 * branche par mode de vente, ni une branche par établissement --
 * uniquement un nom de champ générique en entrée. "delivery_address"
 * est délibérément ABSENT de cette table : c'est le seul champ backend
 * qui se décompose en plusieurs sous-champs UI, rendu séparément
 * ci-dessous (renderDeliveryAddress), cas spécial documenté dans
 * lib/sale-modes-types.ts.
 *
 * Un champ générique retourné par le backend mais absent de cette
 * table (aucun cas connu avec le catalogue actuel --
 * supabase/migration-v82-lot2a-sale-modes.sql -- mais possible si une
 * future migration ajoute un champ sans mise à jour de ce fichier)
 * n'est PAS rendu (voir renderField ci-dessous, repli explicite) :
 * comportement fail-closed délibéré -- un champ "required" non rendu
 * ne peut jamais être rempli, donc validateCustomerData()
 * (lib/sale-modes-public.ts) le signale en permanence comme manquant
 * et bloque la soumission, plutôt que de risquer un rendu incorrect
 * ou une commande incomplète silencieusement acceptée.
 */
const FIELD_CONFIG: Record<
  string,
  {
    customerInfoKey: keyof CustomerInfo;
    labelKey: string;
    type?: string;
    inputMode?: "text" | "numeric" | "tel" | "email";
    autoComplete?: string;
    placeholder?: string;
  }
> = {
  customer_name: {
    customerInfoKey: "name",
    labelKey: "fieldName",
    autoComplete: "given-name",
    placeholder: "Yakout",
  },
  phone: {
    customerInfoKey: "phone",
    labelKey: "fieldPhone",
    type: "tel",
    inputMode: "tel",
    autoComplete: "tel",
    placeholder: "06 12 34 56 78",
  },
  email: {
    customerInfoKey: "email",
    labelKey: "fieldEmail",
    type: "email",
    inputMode: "email",
    autoComplete: "email",
    placeholder: "prenom@exemple.fr",
  },
};

/** Sépare un champ backend reconnu (rendu générique via FIELD_CONFIG)
 *  du cas spécial "delivery_address" et d'un champ inconnu (ignoré). */
type KnownFieldKind = "mapped" | "delivery_address" | "unknown";
function fieldKind(field: string): KnownFieldKind {
  if (field === "delivery_address") return "delivery_address";
  return FIELD_CONFIG[field] ? "mapped" : "unknown";
}

/**
 * Établissements sans salle : coordonnées du client, puis retrait ou
 * livraison. Le code postal saisi et le montant du panier déterminent
 * si la livraison est proposée.
 *
 * LOT 2B.4a.2 — BASCULE RUNTIME RÉELLE : le rendu des champs client
 * est désormais entièrement piloté par `displayItems`
 * (FieldRequirementDisplayItem[], lib/sale-modes-public.ts), dérivé
 * des exigences génériques publiques (get_restaurant_public_field_requirements)
 * -- plus aucun `need("...")` ni `(keyof CustomerInfo)[]` figé lu
 * depuis settings.requiredCustomerFields (legacy, restaurants-config.ts).
 * AU LAIT CRU (sale modes) : `settings.allowedServiceModes` (legacy,
 * statique) est remplacé par `deliveryModeAvailable`, un booléen dérivé
 * de la liste RÉELLE des modes activés (get_restaurant_public_sale_modes,
 * via usePublicSaleModes dans MenuView) -- même cause racine et même
 * bascule runtime que displayItems/fieldRequirementsReady ci-dessus,
 * appliquée cette fois au message d'éligibilité livraison plutôt qu'aux
 * champs client.
 */
export default function FulfillmentSelector({
  status,
  type,
  customer,
  errors,
  showErrors,
  displayItems,
  fieldRequirementsReady,
  deliveryModeAvailable,
  onChangeCustomer,
  onSelectFulfillment,
}: {
  status: DeliveryStatus;
  type: ServiceMode | null;
  customer: CustomerInfo;
  errors: Errors;
  showErrors: boolean;
  displayItems: FieldRequirementDisplayItem[];
  fieldRequirementsReady: boolean;
  /** true seulement si "delivery" figure dans la liste RÉELLEMENT
   *  résolue des modes de vente activés pour cet établissement --
   *  jamais settings.allowedServiceModes (legacy). */
  deliveryModeAvailable: boolean;
  onChangeCustomer: (patch: Partial<CustomerInfo>) => void;
  onSelectFulfillment: (type: ServiceMode) => void;
}) {
  const { t } = useI18n();
  const err = (k: keyof CustomerInfo) =>
    showErrors && errors[k] ? t(errors[k]!) : undefined;

  // LOT ADDRESS v1 (ACTIVE CHECKOUT INTEGRATION) — état local propre au
  // câblage de l'adresse à un seul champ actif (mission §8/§9/§10/§25/
  // §26), voir renderDeliveryAddress() ci-dessous.
  //
  // `addressContext` : contexte géographique (code postal + ville) tel
  // qu'EDITÉ PAR L'ÉTAPE A (jamais mis à jour par une sélection IGN
  // elle-même, voir handleAddressSelected) — sert de `key` React pour
  // AddressAutocomplete : toute frappe de l'utilisateur dans le code
  // postal ou la ville démonte/remonte l'aide de recherche, ce qui
  // invalide proprement toute saisie/suggestion interne obsolète
  // (mission §7/§25), SANS que la sélection elle-même (qui peut
  // légitimement réécrire postalCode/city, mission §9/§26) ne
  // déclenche cette invalidation de son propre fait.
  const [addressContext, setAddressContext] = useState(
    `${customer.postalCode}|${customer.city}`
  );
  // `selectionConfirmed` : true seulement après une sélection IGN
  // réelle (jamais après une simple frappe, mission §10 — "typed ≠
  // selected"). Gate l'invalidation (§10/§25) : éditer le code postal
  // ou la ville APRÈS une sélection confirmée efface la rue (métadonnée
  // de sélection devenue obsolète) ; éditer ces mêmes champs AVANT toute
  // sélection (saisie manuelle pure, jamais de sélection IGN impliquée)
  // ne touche jamais à la rue déjà tapée — préserve exactement le
  // comportement des tests préexistants v91/v101 (saisie manuelle
  // séquentielle, sans jamais passer par une sélection IGN).
  const [selectionConfirmed, setSelectionConfirmed] = useState(false);

  const message = (() => {
    if (status.eligible) {
      // Corrige L2B2-V2-01 (contre-audit Work, re-audit) :
      // DeliveryZone.label est désormais string | null (unification
      // LOT 2B.2). Le runtime legacy actuel ne produit jamais null
      // ici, mais le futur resolver public le peut légitimement
      // (delivery_area_label = null). Jamais de texte inventé en
      // repli ("Zone inconnue", code postal, nom d'établissement) --
      // uniquement l'omission propre du segment de zone.
      //
      // CORRIGÉ (SERVER-AUTHORITATIVE DELIVERY FULFILLMENT & PRICING
      // FOUNDATION, readiness audit §8/§11) : le préfixe codé en dur
      // "Livraison offerte" (= gratuite) a été retiré -- il présumait
      // à tort qu'une règle éligible est TOUJOURS gratuite, ce qui
      // devient faux dès qu'une règle porte un frais réel (pricingMode
      // "fixed"/"free_above_threshold"). `zone.label` (= customer_text
      // configuré par la règle, jamais une invention Scanym) est
      // désormais affiché TEL QUEL, sans préfixe présumant la
      // gratuité ; en son absence, un message neutre qui ne présume
      // pas non plus de gratuité. Le frais lui-même (s'il existe) est
      // affiché séparément dans le récapitulatif du panier (voir
      // CartPanel.tsx, "Produits / Livraison / Total"), jamais dupliqué
      // ici.
      return {
        tone: "good",
        text: status.zone?.label ?? t("deliveryEligibleDefault"),
      };
    }
    switch (status.block) {
      case "below-min":
        return {
          tone: "info",
          text: t(
            (status.missing ?? 0) > 1 ? "deliveryMissingPlural" : "deliveryMissing",
            { n: status.missing ?? 0 }
          ),
        };
      case "no-postal":
        return {
          tone: "info",
          text: t("deliveryNoPostal"),
        };
      case "out-of-zone":
        // Corrige L2B3-01 (contre-audit Work) : le message hors zone
        // ne doit plus jamais dépendre des anciens champs livraison
        // de RestaurantSettings (restaurants-config.ts) -- le nouveau
        // résolveur public ne renseigne jamais status.zone pour ce
        // cas précis (aucun préfixe n'a matché, il n'y a donc
        // structurellement aucun label public disponible à afficher).
        // Message neutre déjà présent dans le produit
        // (deliveryOutOfZoneShort), jamais une zone reconstruite ou
        // inventée.
        return {
          tone: "warn",
          text: t("deliveryOutOfZoneShort"),
        };
      default:
        return null;
    }
  })();

  const toneClass = getFulfillmentToneClass(message?.tone);

  /** Rend un champ backend connu (customer_name/phone/email) via
   *  FIELD_CONFIG -- jamais de branche par mode de vente. */
  function renderMappedField(field: string, keySuffix: string) {
    const config = FIELD_CONFIG[field];
    if (!config) return null;
    const key = config.customerInfoKey;
    return (
      <Field
        key={keySuffix}
        id={field}
        label={t(config.labelKey)}
        value={customer[key]}
        error={err(key)}
        placeholder={config.placeholder}
        type={config.type}
        inputMode={config.inputMode}
        autoComplete={config.autoComplete}
        onChange={(v) => onChangeCustomer({ [key]: v } as Partial<CustomerInfo>)}
      />
    );
  }

  /**
   * Rend le cas spécial "delivery_address" : 1 champ backend, 3
   * sous-champs UI (street/postalCode/city) -- contrat documenté dans
   * lib/sale-modes-types.ts.
   *
   * LOT ADDRESS v1 -- ACTIVE CHECKOUT INTEGRATION (mission §8/§9/§10) :
   * UX EN DEUX ÉTAPES (mission §4) :
   *   - Étape A (Ville / Code postal) EN PREMIER, toujours les mêmes
   *     champs simples déjà en production (aucun changement de leur
   *     propre comportement/validation) ;
   *   - Étape B (adresse -- numéro et rue) EN SECOND, UNIQUEMENT une
   *     fois l'étape A résolue en un code postal structurellement
   *     valide (isValidPostalCode, lib/customer.ts -- même contrôle
   *     déjà utilisé partout ailleurs dans ce fichier, jamais un second
   *     contrôle de format inventé ici) : avant cela, un simple champ
   *     texte (comportement IDENTIQUE à celui déjà en production) reste
   *     disponible, pour ne jamais bloquer la saisie tant que le
   *     contexte géographique n'existe pas encore -- AddressAutocomplete
   *     n'est alors ni monté ni rendu, donc ZÉRO appel réseau IGN/BAN
   *     tant que ce contexte n'existe pas (mission §4/§24).
   *
   * UN SEUL CHAMP RUE ACTIF À LA FOIS (mission §8, correction explicite
   * du premier passage additif de ce lot -- voir le rapport de mission,
   * section ACTIVE CHECKOUT INTEGRATION) : `street` est soit un simple
   * champ texte (postal non encore valide), soit AddressAutocomplete
   * (postal valide) -- JAMAIS les deux simultanément. Le texte tapé
   * dans AddressAutocomplete reste directement utilisable comme valeur
   * `customer.street`, sans exiger de sélection formelle (mission
   * §11/§12, via `onQueryChange` -- voir handleQueryChange ci-dessous) :
   * le repli manuel n'est donc plus un second champ ni un "mode"
   * séparé, seulement la même saisie libre qu'avant ce lot, désormais
   * assistée par des suggestions IGN quand elles existent.
   *
   * SÉLECTION = AUTORITATIVE POUR street + postalCode + city (mission
   * §9/§26) : sélectionner une suggestion IGN met à jour les trois
   * champs (voir handleAddressSelected) -- IGN devient la source de
   * vérité pour le contexte géographique de CETTE adresse. `postalCode`
   * reste néanmoins la seule valeur transmise à create_order (voir
   * lib/services/order-payload.ts, SADFP-01, inchangé) : une sélection
   * ne fait qu'ÉCRIRE `customer.postalCode` comme le ferait une saisie
   * manuelle de l'étape A, elle ne contourne ni ne duplique ce chemin.
   * Si IGN renvoyait malgré la contrainte `postcode` un code postal
   * matériellement différent de celui saisi en étape A (mission §26,
   * cas limite documenté), c'est cette valeur IGN qui devient la
   * nouvelle valeur courante de `customer.postalCode` -- jamais une
   * valeur combinée ou recalculée : le client voit alors directement
   * (champ étape A mis à jour) la correction, et peut la retoucher
   * comme n'importe quelle saisie manuelle.
   *
   * INVALIDATION (mission §10/§25) : éditer le code postal OU la ville
   * APRÈS une sélection IGN CONFIRMÉE efface `street` (métadonnée de
   * sélection devenue obsolète pour le nouveau contexte) et réarme
   * `selectionConfirmed`. Éditer ces mêmes champs AVANT toute sélection
   * (saisie manuelle pure, ou simple frappe jamais suivie d'une
   * sélection) NE TOUCHE JAMAIS `street` -- c'est ce qui permet aux
   * tests préexistants tests/v91-lot2b4a2-dynamic-form.dom.test.ts et
   * tests/v101-fulfillment-routing-lot-c-menuview.dom.test.ts (saisie
   * séquentielle street puis postalCode/city, sans jamais passer par
   * une sélection IGN) de continuer à passer SANS modification.
   *
   * `key={addressContext}` sur AddressAutocomplete (jamais
   * `customer.postalCode` seul, qu'une sélection peut légitimement
   * réécrire, mission §9/§26) : `addressContext` n'est mis à jour QUE
   * par les gestionnaires de l'étape A (jamais par une sélection),
   * donc une sélection qui réécrit postalCode/city ne déclenche pas
   * son propre démontage/remontage -- seule une véritable frappe de
   * l'utilisateur dans le code postal ou la ville invalide/remonte
   * l'aide de recherche (état interne -- saisie, suggestions -- reset
   * à zéro).
   */
  function renderDeliveryAddress() {
    const postalCode = customer.postalCode;
    const postalReady = isValidPostalCode(postalCode);

    /** Étape A (postalCode/city) éditée par le client. */
    function handleStageAFieldChange(patch: Partial<CustomerInfo>) {
      if (selectionConfirmed) {
        // Mission §10/§25 : une sélection IGN confirmée devient stale
        // dès que le contexte géographique change -- efface `street`
        // plutôt que de laisser une rue sélectionnée pour un contexte
        // postal/ville qui n'est plus le contexte actuel.
        onChangeCustomer({ ...patch, street: "" });
        setSelectionConfirmed(false);
      } else {
        // Saisie manuelle pure (jamais de sélection IGN impliquée) :
        // `street` n'est jamais touché ici (préserve tests v91/v101).
        onChangeCustomer(patch);
      }
      setAddressContext(
        `${patch.postalCode ?? customer.postalCode}|${patch.city ?? customer.city}`
      );
    }

    /** Sélection IGN réelle (jamais un simple changement de texte). */
    function handleAddressSelected(structured: StructuredCustomerAddress | null) {
      if (!structured) return;
      const patch: Partial<CustomerInfo> = { street: structured.addressLine };
      // Mission §26 : IGN devient autoritatif pour postalCode/city --
      // uniquement si IGN a effectivement renseigné une valeur non
      // vide (jamais un vidage silencieux d'un champ déjà saisi par un
      // provider qui omettrait un sous-champ).
      if (structured.postalCode.trim()) patch.postalCode = structured.postalCode.trim();
      if (structured.city.trim()) patch.city = structured.city.trim();
      onChangeCustomer(patch);
      setSelectionConfirmed(true);
    }

    /** Frappe brute (mission §11/§12) : jamais une sélection formelle
     *  -- la rue tapée reste directement utilisable comme valeur
     *  manuelle, `selectionConfirmed` redevient false (une frappe
     *  après une sélection annule la confiance dans cette sélection,
     *  sans pour autant effacer le texte que le client est en train de
     *  retaper -- voir handleStageAFieldChange pour la distinction
     *  avec l'invalidation de l'étape A). */
    function handleQueryChange(text: string) {
      onChangeCustomer({ street: text });
      setSelectionConfirmed(false);
    }

    // Pré-remplit AddressAutocomplete avec la valeur `street` déjà
    // connue (tapée avant que le postal ne devienne valide, ou saisie
    // manuelle en cours) -- jamais `null` par défaut, pour ne pas
    // effacer visuellement un texte déjà tapé au moment où le postal
    // devient valide et où ce composant est monté pour la première
    // fois (mission §11/§12 : le texte tapé doit rester utilisable).
    const currentAddressValue: StructuredCustomerAddress | null = customer.street.trim()
      ? {
          addressLine: customer.street,
          postalCode: customer.postalCode,
          city: customer.city,
          countryCode: "FR",
        }
      : null;

    return (
      <div key="delivery_address" className="space-y-3">
        <div className="grid grid-cols-[7rem_1fr] gap-3">
          <Field
            id="postalCode"
            label={t("fieldPostalCode")}
            value={customer.postalCode}
            error={err("postalCode")}
            placeholder="92100"
            inputMode="numeric"
            maxLength={5}
            autoComplete="postal-code"
            onChange={(v) =>
              handleStageAFieldChange({ postalCode: v.replace(/\D/g, "").slice(0, 5) })
            }
          />
          <Field
            id="city"
            label={t("fieldCity")}
            value={customer.city}
            error={err("city")}
            placeholder={t("phCity")}
            autoComplete="address-level2"
            onChange={(v) => handleStageAFieldChange({ city: v })}
          />
        </div>
        {postalReady ? (
          // `key={addressContext}` : voir doc ci-dessus -- démonte/
          // remonte uniquement sur une véritable édition de l'étape A,
          // jamais sur une sélection qui réécrit postalCode/city.
          <AddressAutocomplete
            key={addressContext}
            value={currentAddressValue}
            onChange={handleAddressSelected}
            onQueryChange={handleQueryChange}
            postcodeContext={postalCode.trim()}
            id="delivery-street"
            labels={{
              inputLabel: t("fieldStreet"),
              placeholder: t("phStreet"),
              loading: t("addrLoading"),
              noResults: t("addrNoResults"),
              errorMessage: t("addrError"),
              manualFallbackPrompt: t("addrManualPrompt"),
              switchToManual: t("addrSwitchManual"),
              switchToSearch: t("addrSwitchSearch"),
              clear: t("addrClear"),
              manualAddressLine: t("fieldStreet"),
              manualPostalCode: t("fieldPostalCode"),
              manualCity: t("fieldCity"),
              manualCountryCode: t("addrCountryCode"),
            }}
          />
        ) : (
          // Mission §4/§24 : avant que le code postal ne soit
          // structurellement valide, UN SEUL champ texte simple --
          // comportement identique à celui déjà en production avant ce
          // lot, jamais bloqué par l'absence de contexte géographique.
          <Field
            id="street"
            label={t("fieldStreet")}
            value={customer.street}
            error={err("street")}
            placeholder={t("phStreet")}
            autoComplete="street-address"
            onChange={(v) => onChangeCustomer({ street: v })}
          />
        )}
      </div>
    );
  }

  /** Groupe one_of : chaque champ membre reconnu est rendu comme un
   *  champ normal, plus une indication générique "au moins un des
   *  suivants" -- jamais un nom de groupe (ex. "contact") affiché
   *  littéralement, uniquement les libellés déjà traduits des champs
   *  membres. */
  function renderOneOfGroup(item: Extract<FieldRequirementDisplayItem, { kind: "one_of_group" }>) {
    const groupSatisfied = item.fields.some((f) => {
      const config = FIELD_CONFIG[f.field];
      return config ? customer[config.customerInfoKey].trim() !== "" : false;
    });
    const memberLabels = item.fields
      .map((f) => (FIELD_CONFIG[f.field] ? t(FIELD_CONFIG[f.field].labelKey) : f.field))
      .join(", ");
    return (
      <div key={`group-${item.groupName}`} className="space-y-3">
        {item.fields.map((f) => renderMappedField(f.field, `${item.groupName}-${f.field}`))}
        {showErrors && !groupSatisfied && (
          <p className="text-xs text-amber-700">
            {t("fieldOneOfRequired", { fields: memberLabels })}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-6 min-w-0 max-w-full overflow-x-hidden">
      <h3 className="font-semibold">
        {t(type === "delivery" ? "deliveryDetails" : "yourDetails")}
      </h3>

      {deliveryModeAvailable && message && (
        <div
          role="status"
          aria-live="polite"
          className={`mt-3 max-w-full break-words rounded-xl p-3 text-sm ${toneClass}`}
        >
          <p>{message.text}</p>
          {type === "delivery" && status.block === "out-of-zone" && (
            <button
              type="button"
              onClick={() => onSelectFulfillment("pickup")}
              className="mt-3 w-full rounded-lg border border-amber-700/30 bg-white px-3 py-2 text-base font-semibold text-amber-900 shadow-sm sm:text-sm"
            >
              {t("choosePickupAction")}
            </button>
          )}
        </div>
      )}

      {!fieldRequirementsReady ? (
        // Fail-closed (section 11, LOT 2B.4a.1/2B.4a.2) : tant que les
        // exigences génériques ne sont pas RÉELLEMENT résolues
        // (loading ou error), aucun champ n'est rendu -- jamais un
        // formulaire vide interprété à tort comme "aucune exigence",
        // jamais un repli vers l'ancien settings.requiredCustomerFields.
        <p className="mt-3 text-sm text-ink-on-bg-muted">{t("mcLoading")}</p>
      ) : (
        <div className="mt-3 space-y-3">
          {displayItems.map((item, index) => {
            if (item.kind === "one_of_group") {
              return renderOneOfGroup(item);
            }
            const field = item.requirement.field;
            const kind = fieldKind(field);
            if (kind === "delivery_address") return renderDeliveryAddress();
            if (kind === "unknown") return null;
            return renderMappedField(field, `field-${index}-${field}`);
          })}
        </div>
      )}

      <p className="mt-2 text-xs text-ink-on-bg-muted">
        {t("privacyNote")}
      </p>

      {type === "pickup" && (
        <p className="mt-3 text-sm text-ink-on-bg-muted">
          {t("pickupNote")}
        </p>
      )}
      {type === "delivery" && status.eligible && (
        <p className="mt-3 text-sm text-ink-on-bg-muted">
          {t("deliveryNote")}
        </p>
      )}
    </div>
  );
}
