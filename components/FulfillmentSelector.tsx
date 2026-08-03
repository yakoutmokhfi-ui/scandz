"use client";

import type { RestaurantSettings } from "@/lib/restaurants-config";
import type { DeliveryStatus } from "@/lib/delivery";
import type { CustomerInfo } from "@/lib/customer";
import { useI18n } from "@/lib/i18n-context";

export type FulfillmentType = "pickup" | "delivery";

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
    <div>
      <label htmlFor={id} className="block text-xs font-semibold text-espresso/70">
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
          "mt-1 w-full rounded-xl border bg-white p-3 text-sm outline-none focus:border-caramel " +
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
  onSelectType,
  onChangeCustomer,
}: {
  settings: RestaurantSettings;
  status: DeliveryStatus;
  type: FulfillmentType | null;
  customer: CustomerInfo;
  errors: Errors;
  showErrors: boolean;
  onSelectType: (t: FulfillmentType) => void;
  onChangeCustomer: (patch: Partial<CustomerInfo>) => void;
}) {
  const { t } = useI18n();
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
        : "bg-white text-espresso/70";

  return (
    <div className="mt-6">
      <h3 className="font-semibold">{t("yourDetails")}</h3>

      <div className="mt-3 space-y-3">
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
      </div>

      <p className="mt-2 text-xs text-espresso/55">
        {t("privacyNote")}
      </p>

      {message && (
        <p className={`mt-4 rounded-xl p-3 text-sm ${toneClass}`}>{message.text}</p>
      )}

      <h3 className="mt-5 font-semibold">
        {t("howToReceive")}
      </h3>
      <div className="mt-2 flex gap-2">
        {settings.pickup && (
          <button
            onClick={() => onSelectType("pickup")}
            aria-pressed={type === "pickup"}
            className={
              "flex-1 rounded-xl py-3 text-sm font-semibold " +
              (type === "pickup"
                ? "bg-caramel text-white"
                : "bg-white text-espresso shadow-sm")
            }
          >
            {t("pickup")}
          </button>
        )}
        <button
          onClick={() => status.eligible && onSelectType("delivery")}
          disabled={!status.eligible}
          aria-pressed={type === "delivery"}
          className={
            "flex-1 rounded-xl py-3 text-sm font-semibold " +
            (!status.eligible
              ? "cursor-not-allowed bg-espresso/10 text-espresso/40"
              : type === "delivery"
                ? "bg-caramel text-white"
                : "bg-white text-espresso shadow-sm")
          }
        >
          {t("delivery")}
        </button>
      </div>

      {type === "pickup" && (
        <p className="mt-3 text-sm text-espresso/60">
          {t("pickupNote")}
        </p>
      )}
      {type === "delivery" && status.eligible && (
        <p className="mt-3 text-sm text-espresso/60">
          {t("deliveryNote")}
        </p>
      )}
    </div>
  );
}
