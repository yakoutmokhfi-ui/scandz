"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * Bouton (i) — description longue (V66).
 *
 * N'est jamais rendu si `description` est vide : c'est à l'appelant
 * de conditionner son rendu (voir MenuItemCard.tsx), pas à ce
 * composant de le déduire d'une valeur qu'il pourrait recevoir vide
 * par erreur.
 *
 * CORRIGÉ après audit indépendant (deux défauts réels, pas de faux
 * positifs) :
 *
 * 1. HTML invalide : la version précédente retournait un <span>
 *    racine contenant, une fois ouvert, un <div role="dialog">. Un
 *    <span> n'accepte que du contenu de phrasé ; un <div> (ou un
 *    <dialog>) n'en est jamais un descendant valide, quel que soit
 *    l'état d'ouverture. Corrigé en utilisant l'élément HTML natif
 *    <dialog> comme racine du panneau, rendu par le navigateur en
 *    "top layer" (hors du flux normal du DOM parent) : le problème
 *    d'imbrication ne se pose plus.
 *
 * 2. Sémantique modale incohérente : la version précédente combinait
 *    un rôle "dialog" non nommé (ni aria-label ni aria-labelledby)
 *    avec un fond plein écran qui bloquait tous les clics — un
 *    comportement visuellement et fonctionnellement modal sans les
 *    garanties d'accessibilité d'un vrai modal (piège de focus,
 *    arrière-plan inerte). Corrigé en choisissant explicitement la
 *    sémantique MODALE et en utilisant dialog.showModal() : le
 *    navigateur gère alors nativement le piège de focus, l'arrière-
 *    plan devient réellement inerte, et ::backdrop fournit un fond
 *    visuel sans code JS supplémentaire. Le nom accessible du
 *    dialogue est fourni via aria-label.
 *
 * Accessibilité (le reste, déjà conforme, inchangé) :
 * - <button> natif pour le déclencheur (clavier : Entrée/Espace
 *   ouvrent, Tab l'atteint normalement).
 * - aria-controls pointe vers un id unique par instance (useId()) :
 *   avec plusieurs produits ayant une description longue sur la même
 *   page, chaque bouton (i) a son propre id de panneau.
 * - aria-expanded reflète l'état réel (synchronisé sur l'état React
 *   `open`, lui-même synchronisé sur l'état réel du <dialog> natif
 *   via l'événement 'close').
 * - Fermeture par Échap : gérée nativement par <dialog> en mode
 *   modal (déclenche l'événement 'close'), pas besoin d'écouteur
 *   keydown manuel — élimine aussi tout risque de fuite d'écouteur.
 * - Focus : dialog.showModal() déplace nativement le focus dans le
 *   panneau (sur le bouton "fermer", premier élément focusable) ; à
 *   la fermeture — quel que soit le chemin (Échap, clic sur le fond
 *   via ::backdrop, bouton "fermer") — le focus est explicitement
 *   restitué au bouton (i) déclencheur dans le gestionnaire
 *   `onClose`, source unique de vérité pour "le dialogue est fermé".
 * - stopPropagation sur le déclencheur, pour ne jamais déclencher un
 *   clic parent (ajout au panier).
 */
export default function ProductInfoButton({
  description,
  triggerLabel,
  closeLabel,
}: {
  description: string;
  /** Libellé accessible complet du déclencheur, ex. "Plus d'informations sur Tiramisu". Réutilisé comme nom accessible du dialogue lui-même. */
  triggerLabel: string;
  closeLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Synchronise l'état réel du <dialog> natif avec l'état React.
  // showModal()/close() sont des méthodes impératives du DOM, pas des
  // props déclaratives : ce useEffect est le seul endroit qui les
  // appelle, en réaction à `open`.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <div className="relative inline-flex shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={triggerLabel}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-espresso/30 text-xs font-bold text-espresso/70"
      >
        i
      </button>

      <dialog
        id={panelId}
        ref={dialogRef}
        aria-label={triggerLabel}
        onClose={() => {
          // Source UNIQUE de vérité pour "le dialogue est fermé", quel
          // que soit le déclencheur (Échap natif, clic sur ::backdrop,
          // bouton "fermer") : les trois passent par dialog.close(),
          // qui émet toujours cet événement. Le focus natif du
          // navigateur n'est pas garanti fiable entre implémentations :
          // restitution explicite ici, dans tous les cas, une seule
          // fois.
          setOpen(false);
          triggerRef.current?.focus();
        }}
        onClick={(e) => {
          // Un clic directement sur l'élément <dialog> lui-même (pas
          // sur son contenu, qui a sa propre boîte) correspond à un
          // clic sur le ::backdrop natif en mode showModal().
          if (e.target === dialogRef.current) {
            dialogRef.current?.close();
          }
        }}
        className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-espresso/10 bg-white p-4 shadow-lg backdrop:bg-espresso/20"
      >
        <p className="whitespace-pre-line text-sm text-espresso/80">
          {description}
        </p>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            dialogRef.current?.close();
          }}
          className="mt-3 rounded-xl border border-stone-300 px-3 py-1.5 text-xs font-semibold"
        >
          {closeLabel}
        </button>
      </dialog>
    </div>
  );
}
