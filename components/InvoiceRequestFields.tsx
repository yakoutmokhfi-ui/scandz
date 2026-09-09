"use client";

import { useI18n } from "@/lib/i18n-context";
import {
  INVOICE_FIELD_MAX_LENGTHS,
  type InvoiceRequestInfo,
  type InvoiceRequestErrors,
  type InvoiceType,
} from "@/lib/invoice-request";

/**
 * SCANYM CUSTOMER CHECKOUT — CLIENT / COMPANY INVOICE REQUEST v1.4.
 *
 * "Do not clutter checkout when invoice is not requested" (mandat,
 * littéral) : par défaut, seule la case à cocher est visible. Les
 * champs conditionnels n'apparaissent qu'une fois la case cochée, et
 * les champs SOCIÉTÉ uniquement lorsque ce type est sélectionné.
 *
 * CORRECTIF v1.4 (Cat Woman INVOICE-V13-RETRY-CORRECTION-01,
 * "DETERMINISTIC CLIENT VALIDATION") : chaque champ reçoit désormais
 * l'attribut HTML `maxLength` correspondant EXACTEMENT à la
 * contrainte SQL réelle (`INVOICE_FIELD_MAX_LENGTHS`, extraite
 * textuellement de la migration -- jamais un chiffre différent) --
 * empêche physiquement la saisie au-delà de la limite serveur, en
 * complément du message de validation. Tous les champs affichent
 * désormais leur erreur (auparavant, seuls certains champs
 * obligatoires l'affichaient -- les champs optionnels pouvaient
 * dépasser silencieusement la limite sans retour visuel avant l'appel
 * réseau).
 */

function Field({
  id,
  label,
  value,
  error,
  onChange,
  type = "text",
  autoComplete,
  maxLength,
}: {
  id: string;
  label: string;
  value: string;
  error?: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  maxLength?: number;
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
        autoComplete={autoComplete}
        maxLength={maxLength}
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

export default function InvoiceRequestFields({
  info,
  errors,
  onChange,
}: {
  info: InvoiceRequestInfo;
  errors: InvoiceRequestErrors;
  onChange: (next: InvoiceRequestInfo) => void;
}) {
  const { t } = useI18n();

  function set<K extends keyof InvoiceRequestInfo>(key: K, value: InvoiceRequestInfo[K]) {
    onChange({ ...info, [key]: value });
  }

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm font-semibold text-ink-on-bg">
        <input
          type="checkbox"
          checked={info.wantsInvoice}
          onChange={(e) => set("wantsInvoice", e.target.checked)}
          className="h-4 w-4 rounded border-espresso/30"
        />
        {t("invNeedInvoice")}
      </label>

      {info.wantsInvoice && (
        <div className="space-y-3 rounded-xl border border-espresso/10 bg-white/50 p-3">
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="invoiceType"
                checked={info.invoiceType === "individual"}
                onChange={() => set("invoiceType", "individual" as InvoiceType)}
              />
              {t("invTypeIndividual")}
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="invoiceType"
                checked={info.invoiceType === "company"}
                onChange={() => set("invoiceType", "company" as InvoiceType)}
              />
              {t("invTypeCompany")}
            </label>
          </div>

          {info.invoiceType === "company" && (
            <Field
              id="invoice-company-legal-name"
              label={t("invCompanyLegalName")}
              value={info.companyLegalName}
              error={errors.companyLegalName ? t(errors.companyLegalName) : undefined}
              onChange={(v) => set("companyLegalName", v)}
              maxLength={INVOICE_FIELD_MAX_LENGTHS.companyLegalName}
            />
          )}

          <Field
            id="invoice-address-line-1"
            label={t("invAddressLine1")}
            value={info.addressLine1}
            error={errors.addressLine1 ? t(errors.addressLine1) : undefined}
            onChange={(v) => set("addressLine1", v)}
            autoComplete="address-line1"
            maxLength={INVOICE_FIELD_MAX_LENGTHS.addressLine1}
          />
          <Field
            id="invoice-address-line-2"
            label={t("invAddressLine2")}
            value={info.addressLine2}
            error={errors.addressLine2 ? t(errors.addressLine2) : undefined}
            onChange={(v) => set("addressLine2", v)}
            autoComplete="address-line2"
            maxLength={INVOICE_FIELD_MAX_LENGTHS.addressLine2}
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              id="invoice-postal-code"
              label={t("invPostalCode")}
              value={info.postalCode}
              error={errors.postalCode ? t(errors.postalCode) : undefined}
              onChange={(v) => set("postalCode", v)}
              autoComplete="postal-code"
              maxLength={INVOICE_FIELD_MAX_LENGTHS.postalCode}
            />
            <Field
              id="invoice-city"
              label={t("invCity")}
              value={info.city}
              error={errors.city ? t(errors.city) : undefined}
              onChange={(v) => set("city", v)}
              autoComplete="address-level2"
              maxLength={INVOICE_FIELD_MAX_LENGTHS.city}
            />
          </div>
          <Field
            id="invoice-country"
            label={t("invCountry")}
            value={info.country}
            error={errors.country ? t(errors.country) : undefined}
            onChange={(v) => set("country", v.toUpperCase().slice(0, 2))}
            autoComplete="country"
            maxLength={2}
          />

          {info.invoiceType === "company" && (
            <>
              <Field
                id="invoice-vat-number"
                label={t("invVatNumber")}
                value={info.vatNumber}
                error={errors.vatNumber ? t(errors.vatNumber) : undefined}
                onChange={(v) => set("vatNumber", v)}
                maxLength={INVOICE_FIELD_MAX_LENGTHS.vatNumber}
              />
              <Field
                id="invoice-contact-name"
                label={t("invContactName")}
                value={info.contactName}
                error={errors.contactName ? t(errors.contactName) : undefined}
                onChange={(v) => set("contactName", v)}
                autoComplete="name"
                maxLength={INVOICE_FIELD_MAX_LENGTHS.contactName}
              />
              <Field
                id="invoice-contact-email"
                label={t("invContactEmail")}
                value={info.contactEmail}
                error={errors.contactEmail ? t(errors.contactEmail) : undefined}
                onChange={(v) => set("contactEmail", v)}
                type="email"
                autoComplete="email"
                maxLength={INVOICE_FIELD_MAX_LENGTHS.contactEmail}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
