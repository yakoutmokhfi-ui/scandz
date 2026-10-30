/**
 * #181 -- le récapitulatif avant paiement ajoute UNE étape entre le bouton
 * d'envoi et `create_order`. Les parcours de bout en bout historiques
 * (WhatsApp, facture, Monetico, calendrier…) vérifient ce qui se passe
 * APRÈS l'envoi : ils doivent donc franchir l'étape, comme un client.
 *
 * Ce garde-fou observe le DOM et clique « Confirmer et continuer » dès
 * qu'il apparaît ACTIF -- jamais quand il est désactivé (CGV manquantes,
 * champ invalide…). Il ne touche à rien d'autre : aucun appel direct à
 * `onSendOrder`, aucune simulation du serveur. Les tests du récapitulatif
 * lui-même (checkout-ux-a11y-v1) n'y recourent pas : ils pilotent l'étape
 * à la main.
 */
export function autoConfirmCheckoutReview(win: any): () => void {
  const confirmed = new WeakSet<Element>();
  const tick = () => {
    const button = win.document.querySelector("[data-checkout-review-confirm]") as HTMLButtonElement | null;
    if (!button || button.disabled || confirmed.has(button)) return;
    confirmed.add(button);
    button.click();
  };
  const observer = new win.MutationObserver(tick);
  observer.observe(win.document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled"] });
  return () => observer.disconnect();
}
