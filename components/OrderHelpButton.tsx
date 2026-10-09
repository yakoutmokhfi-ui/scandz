"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n-context";
import { resolveCommunicationText } from "@/lib/communications/resolve";
import type { CommunicationTextOverrides } from "@/lib/communications/text-keys";

/**
 * THEME & CONTENT SETTINGS v1 — bouton + fenêtre d'aide « comment
 * commander ».
 *
 * Les TROIS textes (libellé du bouton, titre, contenu) appartiennent au
 * catalogue fermé MCC (`order_help_button_label`, `order_help_title`,
 * `order_help_body`) : aucun second magasin de textes. Ils n'ont AUCUN
 * texte plateforme par défaut -> tant que le commerçant n'a pas saisi le
 * libellé ET le contenu, ce composant ne rend RIEN (rendu antérieur
 * strictement identique, mandat §F). Le titre est facultatif : il retombe
 * sur le libellé du bouton.
 *
 * Sûreté : les textes sont rendus comme NŒUDS TEXTE React (échappement
 * natif) ; aucun `dangerouslySetInnerHTML`, aucun balisage interprété. Un
 * contenu `<script>` ou `<b>` s'affiche donc littéralement, sans effet.
 * Les retours à la ligne saisis sont conservés (`whitespace-pre-line`).
 *
 * Fenêtre : <dialog> natif en mode modal (piège de focus, Échap, arrière-
 * plan inerte), même sémantique que ProductInfoButton. Surface « popup »
 * (`data-sc-surface="popup"`) : prend les jetons popup_* du commerçant
 * s'ils existent, l'apparence historique sinon.
 */
export default function OrderHelpButton({
  communicationTexts,
}: {
  communicationTexts: CommunicationTextOverrides | null | undefined;
}) {
  const identity = (k: string) => k;
  const label = resolveCommunicationText("order_help_button_label", communicationTexts, identity).text;
  const body = resolveCommunicationText("order_help_body", communicationTexts, identity).text;
  const title = resolveCommunicationText("order_help_title", communicationTexts, identity).text ?? label;

  // Fermé au repos : sans libellé ET sans contenu, aucun élément -- et,
  // volontairement, AUCUN hook (donc aucun identifiant useId consommé :
  // les identifiants des composants voisins restent ceux d'avant ce lot).
  if (!label || !body) return null;
  return <OrderHelpPanel label={label} title={title ?? label} body={body} />;
}

function OrderHelpPanel({ label, title, body }: { label: string; title: string; body: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

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
      try {
        dialog.close();
      } catch {
        dialog.removeAttribute("open");
      }
    }
  }, [open]);

  return (
    <div className="mx-4 mt-3" data-order-help="">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="min-h-11 w-full rounded-xl border border-espresso/15 bg-espresso/5 px-4 py-2.5 text-start text-sm font-semibold text-ink-on-bg"
      >
        {label}
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        data-sc-surface="popup"
        data-order-help-dialog=""
        onClose={() => {
          setOpen(false);
          triggerRef.current?.focus();
        }}
        onCancel={() => setOpen(false)}
        onClick={(e) => {
          if (e.target === dialogRef.current) dialogRef.current?.close();
        }}
        className="m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-espresso/10 bg-crema p-5 text-ink-on-bg shadow-xl backdrop:bg-espresso/40"
      >
        <h2 id={titleId} className="break-words text-xl font-bold">
          {title}
        </h2>
        <p className="mt-3 whitespace-pre-line break-words text-sm leading-relaxed" data-order-help-body="">
          {body}
        </p>
        <button
          type="button"
          autoFocus
          onClick={() => dialogRef.current?.close()}
          className="mt-5 min-h-11 w-full rounded-xl bg-caramel px-4 py-2.5 font-bold text-caramel-ink"
        >
          {t("close")}
        </button>
      </dialog>
    </div>
  );
}
