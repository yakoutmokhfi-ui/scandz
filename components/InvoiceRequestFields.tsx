"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n-context";
import {
  INVOICE_FIELD_MAX_LENGTHS,
  deriveInvoiceAddressFromCustomer,
  type InvoiceRequestInfo,
  type InvoiceRequestErrors,
  type InvoiceType,
} from "@/lib/invoice-request";
import type { ServiceMode } from "@/lib/restaurants-config";
import type { CustomerInfo } from "@/lib/customer";

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
 *
 * INVOICE BACKOFFICE VISIBILITY + BILLING ADDRESS v1 (Claude Monet) :
 * en mode LIVRAISON uniquement, ajoute une case "Adresse de
 * facturation différente de l'adresse de livraison ?" (décochée par
 * défaut). Décochée (défaut) : les champs d'adresse de facturation
 * manuels sont masqués et l'adresse de facturation est dérivée en
 * continu de `customer` (adresse de livraison courante) via
 * `deriveInvoiceAddressFromCustomer` (lib/invoice-request.ts), sans
 * jamais exiger de saisie manuelle. Cochée : les champs manuels
 * réapparaissent, EXACTEMENT comme aujourd'hui (obligatoires,
 * inchangés). Ce booléen ("réutiliser l'adresse de livraison ?") est
 * un état d'INTERFACE local à ce composant uniquement -- jamais
 * transmis à `onChange`, jamais persisté (mandat, littéral : "Do not
 * persist a separate reuse flag. The flag is checkout UI state
 * only."). En mode retrait ("pickup") ou sans mode de service connu,
 * ce toggle n'apparaît pas du tout et le comportement reste celui
 * d'avant ce lot (champs manuels toujours obligatoires).
 *
 * Ce même lot ferme aussi un écart d'interface préexistant : les
 * champs `contactName`/`contactEmail` n'étaient rendus que pour la
 * facture SOCIÉTÉ, alors que `lib/invoice-request.ts` les définit
 * comme des champs génériques (aucune contrainte SQL ne les réserve
 * à un type de facture). Ils sont désormais rendus dès que
 * `wantsInvoice` est vrai, quel que soit `invoiceType` -- seul le
 * champ TVA (`vatNumber`) reste réservé à la facture SOCIÉTÉ.
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
  serviceMode,
  customer,
}: {
  info: InvoiceRequestInfo;
  errors: InvoiceRequestErrors;
  onChange: (next: InvoiceRequestInfo) => void;
  serviceMode?: ServiceMode | null;
  customer?: CustomerInfo;
}) {
  const { t } = useI18n();
  // "Adresse de facturation différente de l'adresse de livraison ?"
  // -- décochée par défaut (mandat, littéral : "defaulting to NO").
  // État d'INTERFACE local uniquement -- jamais transmis à `onChange`,
  // jamais persisté (voir le commentaire de tête du fichier).
  const [billingAddressDiffers, setBillingAddressDiffers] = useState(false);

  const isDeliveryReuseEligible = serviceMode === "delivery" && !!customer;
  const showManualAddressFields = !isDeliveryReuseEligible || billingAddressDiffers;

  /**
   * L'adresse de livraison n'est "connue" que lorsque ses TROIS
   * composantes sont effectivement saisies -- une commande en mode
   * livraison peut, selon les exigences de champs propres à
   * l'établissement (get_restaurant_public_field_requirements),
   * n'avoir PAS encore collecté `street`/`postalCode`/`city` à
   * l'instant où ce composant se rend (ex. juste après une bascule de
   * mode). Dans ce cas, la synchronisation ci-dessous NE DOIT PAS
   * s'exécuter -- sans cette garde, un client ayant déjà saisi une
   * adresse de facturation manuelle (ou une valeur par défaut) la
   * verrait ÉCRASÉE par une adresse VIDE dès le passage en mode
   * livraison, un cas exactement du type "SILENT INVOICE LOSS" que
   * cette suite de tests existe pour prévenir (voir
   * tests/checkout-invoice-request-reliability.dom.test.ts,
   * scénario FULFILLMENT-FREEZE).
   */
  const hasKnownDeliveryAddress =
    isDeliveryReuseEligible &&
    customer!.street.trim().length > 0 &&
    customer!.postalCode.trim().length > 0 &&
    customer!.city.trim().length > 0;

  // Tant que le client n'a pas coché "adresse différente" (mode
  // livraison) ET que son adresse de livraison est effectivement
  // connue, synchronise en continu l'adresse de facturation sur
  // l'adresse de livraison courante -- ne s'exécute que lorsque
  // pertinent (facture demandée, mode livraison, toggle décoché,
  // adresse de livraison non vide) ; fonction PURE, aucun appel
  // réseau, aucune persistance d'un indicateur de réutilisation
  // quelconque.
  useEffect(() => {
    if (!info.wantsInvoice || !hasKnownDeliveryAddress || billingAddressDiffers) {
      return;
    }
    const derived = deriveInvoiceAddressFromCustomer(customer!);
    onChange({ ...info, ...derived });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    info.wantsInvoice,
    hasKnownDeliveryAddress,
    billingAddressDiffers,
    customer?.street,
    customer?.postalCode,
    customer?.city,
  ]);

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

          {isDeliveryReuseEligible && (
            <label className="flex items-center gap-2 text-sm text-ink-on-bg">
              <input
                id="invoice-billing-address-differs"
                type="checkbox"
                checked={billingAddressDiffers}
                onChange={(e) => setBillingAddressDiffers(e.target.checked)}
                className="h-4 w-4 rounded border-espresso/30"
              />
              {t("invBillingAddressDiffers")}
            </label>
          )}

          {showManualAddressFields && (
            <>
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
            </>
          )}

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

          {info.invoiceType === "company" && (
            <Field
              id="invoice-vat-number"
              label={t("invVatNumber")}
              value={info.vatNumber}
              error={errors.vatNumber ? t(errors.vatNumber) : undefined}
              onChange={(v) => set("vatNumber", v)}
              maxLength={INVOICE_FIELD_MAX_LENGTHS.vatNumber}
            />
          )}
        </div>
      )}
    </div>
  );
}
