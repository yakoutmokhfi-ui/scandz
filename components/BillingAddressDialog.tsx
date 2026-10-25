"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n-context";

/**
 * PAYMENT P4-A — ADRESSE DE FACTURATION (paiement en ligne).
 *
 * Affiché UNIQUEMENT quand le serveur a répondu `billing_required` à la
 * demande de paiement (Monetico, annexe 9.5 : rue, code postal, ville,
 * pays obligatoires pour l'authentification 3-D Secure) -- jamais à
 * l'avance, jamais pour un établissement sans paiement en ligne. La
 * commande est DÉJÀ créée à ce stade : ce dialogue ne modifie ni le
 * panier, ni le mode, ni le montant ; il collecte une adresse que le
 * serveur validera (set_order_billing_context) avant de signer le
 * formulaire Monetico.
 *
 * Pré-rempli avec ce que le client a déjà saisi (nom, e-mail,
 * téléphone, et l'adresse si elle existe). Pays : code ISO à 2 lettres,
 * par défaut celui de la commande.
 */
export interface BillingAddressValues {
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  country: string;
}

function closeDialog(dialog: HTMLDialogElement) {
  try {
    dialog.close();
  } catch {
    dialog.removeAttribute("open");
  }
}

const COUNTRY_RE = /^[A-Za-z]{2}$/;

export default function BillingAddressDialog({
  open,
  initial,
  error,
  busy,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  initial: BillingAddressValues;
  /** Message d'erreur serveur (adresse refusée), ou null. */
  error: string | null;
  busy: boolean;
  onSubmit: (values: BillingAddressValues) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const helpId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [values, setValues] = useState<BillingAddressValues>(initial);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setValues(initial);
      setTouched(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute("open", "");
      }
    } else if (!open && dialog.open) {
      closeDialog(dialog);
    }
  }, [open]);

  const missing = {
    addressLine1: values.addressLine1.trim().length === 0,
    postalCode: values.postalCode.trim().length === 0,
    city: values.city.trim().length === 0,
    country: !COUNTRY_RE.test(values.country.trim()),
  };
  const valid = !missing.addressLine1 && !missing.postalCode && !missing.city && !missing.country;

  function field(
    key: keyof BillingAddressValues,
    label: string,
    opts: { required?: boolean; autoComplete?: string; maxLength?: number; placeholder?: string } = {}
  ) {
    const invalid = touched && opts.required && (missing as Record<string, boolean>)[key];
    return (
      <label className="block text-sm">
        <span className="font-semibold text-ink-on-bg">{label}</span>
        <input
          type="text"
          name={`billing-${key}`}
          data-billing-field={key}
          value={values[key]}
          maxLength={opts.maxLength}
          autoComplete={opts.autoComplete}
          placeholder={opts.placeholder}
          aria-invalid={invalid || undefined}
          onChange={(e) =>
            setValues((v) => ({
              ...v,
              [key]: key === "country" ? e.target.value.toUpperCase() : e.target.value,
            }))
          }
          className={
            "mt-1 w-full rounded-xl border bg-white p-3 text-sm text-stone-900 placeholder:text-stone-500 " +
            (invalid ? "border-red-500 bg-red-50" : "border-espresso/10")
          }
        />
      </label>
    );
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={helpId}
      data-billing-dialog=""
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-espresso/10 bg-crema p-4 shadow-lg backdrop:bg-espresso/20"
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!valid || busy) return;
          onSubmit({
            addressLine1: values.addressLine1.trim(),
            addressLine2: values.addressLine2.trim(),
            postalCode: values.postalCode.trim(),
            city: values.city.trim(),
            country: values.country.trim().toUpperCase(),
          });
        }}
      >
        <h2 id={titleId} className="text-base font-bold text-ink-on-bg">
          {t("paymentBillingTitle")}
        </h2>
        <p id={helpId} className="mt-1 text-xs text-ink-on-bg-muted">
          {t("paymentBillingHelp")}
        </p>

        <div className="mt-3 space-y-2">
          {field("addressLine1", t("invAddressLine1"), { required: true, autoComplete: "billing street-address", maxLength: 50, placeholder: t("phStreet") })}
          {field("addressLine2", t("invAddressLine2"), { autoComplete: "billing address-line2", maxLength: 50 })}
          <div className="grid grid-cols-2 gap-2">
            {field("postalCode", t("invPostalCode"), { required: true, autoComplete: "billing postal-code", maxLength: 10 })}
            {field("city", t("invCity"), { required: true, autoComplete: "billing address-level2", maxLength: 50 })}
          </div>
          {field("country", t("invCountry"), { required: true, autoComplete: "billing country", maxLength: 2, placeholder: "FR" })}
        </div>

        {error ? (
          <p role="alert" data-billing-error="" className="mt-3 rounded-xl bg-red-50 p-2.5 text-xs font-semibold text-red-700">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            data-billing-action="cancel"
            disabled={busy}
            onClick={onCancel}
            className="min-h-11 rounded-xl border border-ink-on-bg/30 px-4 py-2 text-sm font-semibold text-ink-on-bg disabled:opacity-40"
          >
            {t("paymentBillingCancel")}
          </button>
          <button
            type="submit"
            data-billing-action="continue"
            disabled={busy}
            aria-busy={busy}
            className="min-h-11 flex-1 rounded-xl bg-caramel px-4 py-2 text-sm font-bold text-caramel-ink disabled:opacity-40"
          >
            {busy ? t("paymentRedirecting") : t("paymentBillingContinue")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
