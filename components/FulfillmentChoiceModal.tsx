"use client";

import { useEffect, useId, useRef } from "react";
import { useI18n } from "@/lib/i18n-context";
import type { ServiceMode } from "@/lib/restaurants-config";

/** Même repli défensif que l'effet d'ouverture ci-dessous (voir sa
 *  documentation) -- factorisé ici car appelé depuis 3 endroits
 *  (clic sur le fond, clic sur un mode, effet de fermeture). */
function closeDialog(dialog: HTMLDialogElement) {
  try {
    dialog.close();
  } catch {
    dialog.removeAttribute("open");
  }
}

/**
 * SCANYM — CUSTOMER ORDERING UX — FULFILLMENT CHOICE POPUP v1
 * (À emporter / Livraison — pilote Emmanuel).
 *
 * Réutilise intégralement l'infrastructure EXISTANTE, déjà auditée --
 * aucune nouvelle config, aucune nouvelle table/colonne/RPC, aucune
 * config Emmanuel codée en dur dans ce composant partagé :
 *
 *  - `modes` est exactement `availableServiceModes` tel que déjà
 *    résolu par CartPanel.tsx (lui-même dérivé de
 *    get_restaurant_public_sale_modes / usePublicSaleModes, voir
 *    MenuView.tsx) -- SEULS les modes réellement activés pour CE
 *    restaurant peuvent apparaître comme bouton ici. Un mode non
 *    activé n'a simplement aucun bouton rendu : ce n'est jamais un
 *    bouton visuellement masqué mais encore sélectionnable
 *    (garde-fou réel, pas seulement visuel).
 *  - `onSelect` est EXACTEMENT `onSelectFulfillment` déjà câblé par
 *    MenuView.tsx (setServiceMode + setShowErrors(true)) -- même
 *    chemin, même état, que la rangée "howToReceive" déjà existante
 *    juste en dessous dans le panier (CartPanel.tsx) -- jamais un
 *    second état de sélection parallèle. Choisir un mode ici ne fait
 *    rien d'autre que cela : aucun appel Stuart, aucun appel
 *    paiement/Monetico, aucune création de commande (create_order
 *    n'est appelé qu'au clic sur "Envoyer", bien plus tard dans le
 *    flux, via CartPanel -> onSendOrder).
 *
 * Convention modale : <dialog> natif + showModal()/close(), même
 * patron déjà audité que components/ProductInfoButton.tsx (piège de
 * focus natif, fond ::backdrop, fermeture Échap native, aucun nouveau
 * pattern d'accessibilité inventé). Repli défensif try/catch autour de
 * showModal()/close() : tout navigateur réel les implémente ; le
 * repli (attribut "open" posé/retiré directement) ne change jamais le
 * comportement en production, il évite seulement un crash dans un
 * moteur DOM qui ne les implémente pas encore (ex. jsdom -- voir
 * tests/*.dom.test.ts, qui montent réellement CartPanel/MenuView avec
 * des fixtures multi-modes où ce popup s'ouvre automatiquement).
 *
 * Fermable (Échap / clic sur le fond) SANS avoir choisi : ce popup
 * est une présentation proéminente d'un choix qui reste, de toute
 * façon, déjà porté par la rangée "howToReceive" (toujours visible
 * juste en dessous, jamais masquée par ce popup). Fermer sans choisir
 * laisse simplement `serviceMode` à `null` -- état déjà géré de façon
 * fail-closed par CartPanel (bouton d'envoi désactivé, message
 * "missingFulfillment" déjà existant, jamais un défaut silencieux
 * vers un mode). CartPanel est démonté/remonté par MenuView à chaque
 * fermeture/réouverture du panier (voir MenuView.tsx, `isCartOpen`) :
 * rouvrir réaffiche ce popup tant qu'aucun choix n'a été fait, sans
 * jamais introduire d'état de blocage résiduel.
 */
export default function FulfillmentChoiceModal({
  open,
  modes,
  onSelect,
}: {
  /** true UNIQUEMENT quand un choix explicite est réellement requis
   *  (plus d'un mode disponible pour ce restaurant, aucun encore
   *  choisi) -- calculé par l'appelant (CartPanel), jamais recalculé
   *  ici : ce composant ne décide jamais lui-même s'il doit
   *  apparaître. */
  open: boolean;
  modes: ServiceMode[];
  onSelect: (mode: ServiceMode) => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);

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

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClick={(e) => {
        // Un clic directement sur l'élément <dialog> (pas sur son
        // contenu, qui a sa propre boîte) correspond au ::backdrop
        // natif en mode showModal() -- même patron que
        // ProductInfoButton.tsx.
        if (e.target === dialogRef.current) {
          closeDialog(dialogRef.current);
        }
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-espresso/10 bg-crema p-4 shadow-lg backdrop:bg-espresso/20"
    >
      <h2 id={titleId} className="text-base font-bold text-ink-on-bg">
        {t("fulfillmentChoicePopupTitle")}
      </h2>
      <div className="mt-3 flex gap-2">
        {modes.map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => {
              onSelect(mode);
              // La sélection ferme immédiatement le popup -- pas
              // besoin d'attendre un second rendu où `open` (dérivé
              // de serviceMode côté appelant) redeviendrait false :
              // cohérent avec le focus restitué nativement par
              // dialog.close() dans le conteneur du panier.
              if (dialogRef.current) closeDialog(dialogRef.current);
            }}
            className="min-w-0 flex-1 rounded-xl border border-transparent bg-caramel px-3 py-3 text-sm font-semibold text-caramel-ink"
          >
            {t(mode === "table" ? "modeTable" : mode)}
          </button>
        ))}
      </div>
    </dialog>
  );
}
