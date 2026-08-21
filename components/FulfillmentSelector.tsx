"use client";

import type { RestaurantSettings, ServiceMode } from "@/lib/restaurants-config";
import type { DeliveryStatus } from "@/lib/delivery";
import type { CustomerInfo } from "@/lib/customer";
import { useI18n } from "@/lib/i18n-context";

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
  id: keyof CustomerInfo;
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
          "mt-1 w-full max-w-full rounded-xl border bg-white p-3 text-base outline-none focus:border-caramel sm:text-sm " +
          (error ? "border-amber-400" : "border-espresso/15")
        }
      />
      {error && <p className="mt-1 text-xs text-amber-700">{error}</p>}
    </div>
  );
}

/**
 * Établissements sans salle : coordonnées du client, puis retrait ou
 * livraison. Le code postal saisi et le montant du panier déterminent
 * si la livraison est proposée.
 */
export default function FulfillmentSelector({
  settings,
  status,
  type,
  customer,
  errors,
  showErrors,
  requiredFields,
  onChangeCustomer,
  onSelectFulfillment,
}: {
  settings: RestaurantSettings;
  status: DeliveryStatus;
  type: ServiceMode | null;
  customer: CustomerInfo;
  errors: Errors;
  showErrors: boolean;
  requiredFields: (keyof CustomerInfo)[];
  onChangeCustomer: (patch: Partial<CustomerInfo>) => void;
  onSelectFulfillment: (type: ServiceMode) => void;
}) {
  const { t } = useI18n();
  const need = (f: keyof CustomerInfo) => requiredFields.includes(f);
  const err = (k: keyof CustomerInfo) =>
    showErrors && errors[k] ? t(errors[k]!) : undefined;

  const areaLabel =
    settings.deliveryAreaLabel ??
    (settings.deliveryZones ?? []).map((z) => z.label).join(" et ");

  const message = (() => {
    if (status.eligible) {
      return {
        tone: "good",
        text: `Livraison offerte — ${status.zone!.label}.`,
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
        return {
          tone: "warn",
          text: t("deliveryOutOfZone", { area: areaLabel }),
        };
      default:
        return null;
    }
  })();

  const toneClass =
    message?.tone === "good"
      ? "bg-green-50 text-green-800"
      : message?.tone === "warn"
        ? "bg-amber-50 text-amber-900"
        : "bg-white text-ink-on-bg-muted";

  return (
    <div className="mt-6 min-w-0 max-w-full overflow-x-hidden">
      <h3 className="font-semibold">
        {t(type === "delivery" ? "deliveryDetails" : "yourDetails")}
      </h3>

      {settings.allowedServiceModes.includes("delivery") && message && (
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

      <div className="mt-3 space-y-3">
        {need("name") && (
          <Field
            id="name"
            label={t("fieldName")}
            value={customer.name}
            error={err("name")}
            placeholder="Yakout"
            autoComplete="given-name"
            onChange={(v) => onChangeCustomer({ name: v })}
          />
        )}

        {need("street") && (
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

        {need("postalCode") && (
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
        )}

        {need("phone") && (
        <Field
          id="phone"
          label={t("fieldPhone")}
          value={customer.phone}
          error={err("phone")}
          placeholder="06 12 34 56 78"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          onChange={(v) => onChangeCustomer({ phone: v })}
        />
        )}

        {need("email") && (
        <Field
          id="email"
          label={t("fieldEmail")}
          value={customer.email}
          error={err("email")}
          placeholder="prenom@exemple.fr"
          type="email"
          inputMode="email"
          autoComplete="email"
          onChange={(v) => onChangeCustomer({ email: v })}
        />
        )}
      </div>

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
