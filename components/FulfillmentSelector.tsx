"use client";

import type { ServiceMode } from "@/lib/restaurants-config";
import type { DeliveryStatus } from "@/lib/delivery";
import type { CustomerInfo } from "@/lib/customer";
import type { FieldRequirementDisplayItem } from "@/lib/sale-modes-public";
import { useI18n } from "@/lib/i18n-context";
import { getFulfillmentToneClass } from "@/lib/fulfillment-tone";

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

  const message = (() => {
    if (status.eligible) {
      // Corrige L2B2-V2-01 (contre-audit Work, re-audit) :
      // DeliveryZone.label est désormais string | null (unification
      // LOT 2B.2). Le runtime legacy actuel ne produit jamais null
      // ici, mais le futur resolver public le peut légitimement
      // (delivery_area_label = null). Jamais de texte inventé en
      // repli ("Zone inconnue", code postal, nom d'établissement) --
      // uniquement l'omission propre du segment de zone.
      return {
        tone: "good",
        text: status.zone?.label
          ? `Livraison offerte — ${status.zone.label}.`
          : `Livraison offerte.`,
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

  /** Rend le cas spécial "delivery_address" : 1 champ backend, 3
   *  sous-champs UI (street/postalCode/city) -- contrat documenté dans
   *  lib/sale-modes-types.ts, comportement IDENTIQUE à celui déjà en
   *  production avant ce lot (aucun changement de markup/UX). */
  function renderDeliveryAddress() {
    return (
      <div key="delivery_address" className="space-y-3">
        <Field
          id="street"
          label={t("fieldStreet")}
          value={customer.street}
          error={err("street")}
          placeholder={t("phStreet")}
          autoComplete="street-address"
          onChange={(v) => onChangeCustomer({ street: v })}
        />
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
              onChangeCustomer({ postalCode: v.replace(/\D/g, "").slice(0, 5) })
            }
          />
          <Field
            id="city"
            label={t("fieldCity")}
            value={customer.city}
            error={err("city")}
            placeholder={t("phCity")}
            autoComplete="address-level2"
            onChange={(v) => onChangeCustomer({ city: v })}
          />
        </div>
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
