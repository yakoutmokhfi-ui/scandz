"use client";

import { useEffect, useId, useRef } from "react";
import type { DeliveryCustomerNotice } from "@/lib/delivery-customer-notice";
import type { CommunicationTextOverrides } from "@/lib/communications/text-keys";
import { resolveCommunicationText } from "@/lib/communications/resolve";
import { useI18n } from "@/lib/i18n-context";

function closeDialog(dialog: HTMLDialogElement) {
  try {
    dialog.close();
  } catch {
    dialog.removeAttribute("open");
  }
}

export default function DeliveryTimingNoticeDialog({
  open,
  notice,
  confirming,
  onConfirm,
  onDismiss,
  communicationTexts = null,
}: {
  open: boolean;
  notice: DeliveryCustomerNotice | null;
  confirming: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
  /**
   * MERCHANT CUSTOMER COMMUNICATIONS v1 — surcharges de texte du
   * commerçant. `null`/absent : l'avertissement de créneau reste
   * EXACTEMENT celui d'avant ce lot (`deliveryTimingNoticeNotesHint`).
   */
  communicationTexts?: CommunicationTextOverrides | null;
}) {
  const { t } = useI18n();

  // MERCHANT CUSTOMER COMMUNICATIONS v1 — l'avertissement « c'est une
  // demande, pas un créneau garanti » devient configurable : c'est lui
  // qui porte la seule réserve faite au client sur l'horaire, et il
  // était figé dans le dictionnaire plateforme.
  //
  // Il reste DISTINCT de `notice.message` juste au-dessus, qui est le
  // `customer_text` de la règle appariée : deux sources, deux rôles, et
  // ce lot ne les confond pas (sans quoi une surcharge d'avertissement
  // pourrait masquer les conditions réelles de la règle).
  const slotWarning =
    resolveCommunicationText("slot_warning", communicationTexts, (k) => t(k)).text ??
    t("deliveryTimingNoticeNotesHint");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && notice && !dialog.open) {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute("open", "");
      }
    } else if ((!open || !notice) && dialog.open) {
      closeDialog(dialog);
    }
  }, [open, notice]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-delivery-timing-notice="true"
      onClose={onDismiss}
      onCancel={onDismiss}
      onClick={(event) => {
        if (event.target === dialogRef.current) {
          closeDialog(dialogRef.current);
          onDismiss();
        }
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-espresso/10 bg-crema p-5 text-ink-on-bg shadow-lg backdrop:bg-espresso/30"
    >
      <h2 id={titleId} className="text-lg font-bold">
        {/* v1.1 — un avis de retrait (Click & Collect) ne doit jamais
            être intitulé « livraison ». */}
        {notice?.modeCode === "pickup"
          ? t("pickupTimingNoticeTitle")
          : t("deliveryTimingNoticeTitle")}
      </h2>
      {notice && (
        <div id={descriptionId} className="mt-3 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-on-bg-muted">
            {notice.modeLabel}
          </p>
          <p className="whitespace-pre-wrap break-words rounded-xl bg-espresso/5 p-3 text-sm leading-relaxed">
            {notice.message}
          </p>
          <p
            className="whitespace-pre-wrap break-words text-sm text-ink-on-bg-muted"
            data-delivery-slot-warning=""
          >
            {slotWarning}
          </p>
        </div>
      )}
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={() => {
            if (dialogRef.current) closeDialog(dialogRef.current);
            onDismiss();
          }}
          className="min-h-11 rounded-xl border border-espresso/15 px-4 py-2.5 text-sm font-semibold"
        >
          {t("deliveryTimingNoticeBack")}
        </button>
        <button
          type="button"
          disabled={confirming}
          aria-busy={confirming}
          onClick={onConfirm}
          className="min-h-11 rounded-xl bg-caramel px-4 py-2.5 text-sm font-bold text-caramel-ink disabled:opacity-60"
        >
          {confirming ? t("sending") : t("deliveryTimingNoticeConfirm")}
        </button>
      </div>
    </dialog>
  );
}
