"use client";

import { useId } from "react";

/**
 * STOREFRONT UX POLISH v1 -- icônes de RÉSEAUX SOCIAUX aux couleurs de
 * leur marque (principe CIO/Noether : les icônes sociales gardent leur
 * identité propre ; les icônes FONCTIONNELLES restent sous le thème
 * marchand). SVG locaux uniquement : aucun SDK, aucun script ni
 * ressource distante. Purement décoratives (aria-hidden) : le nom
 * accessible est porté par le lien appelant (aria-label), jamais par la
 * couleur seule.
 */

/** Instagram : carré arrondi au dégradé de marque, glyphe blanc --
 *  reconnaissable aussi bien sur fond noir que sur fond clair. */
export function InstagramBrandIcon({ size = 24 }: { size?: number }) {
  // Identifiant de dégradé unique par instance : plusieurs en-têtes
  // (ou un test) ne doivent jamais partager le même id SVG.
  const gradientId = `ig-brand-${useId().replace(/:/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden data-brand-icon="instagram">
      <defs>
        <radialGradient id={gradientId} cx="0.3" cy="1.07" r="1.3">
          <stop offset="0" stopColor="#FEDA75" />
          <stop offset="0.25" stopColor="#FA7E1E" />
          <stop offset="0.5" stopColor="#D62976" />
          <stop offset="0.75" stopColor="#962FBF" />
          <stop offset="1" stopColor="#4F5BD5" />
        </radialGradient>
      </defs>
      <rect x="1" y="1" width="22" height="22" rx="6.5" fill={`url(#${gradientId})`} />
      <rect x="5.5" y="5.5" width="13" height="13" rx="4" fill="none" stroke="#FFFFFF" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="3.2" fill="none" stroke="#FFFFFF" strokeWidth="1.8" />
      <circle cx="16.3" cy="7.7" r="1" fill="#FFFFFF" />
    </svg>
  );
}

const TIKTOK_NOTE =
  "M16.5 3c.4 2.2 1.9 3.7 4 3.9v2.6c-1.4 0-2.7-.4-3.9-1.2v6.4c0 3.2-2.3 5.3-5.2 5.3-2.9 0-5.2-2.1-5.2-4.8 0-2.7 2.3-4.8 5.2-4.8.4 0 .8 0 1.2.1v2.7a2.6 2.6 0 0 0-1.2-.3c-1.4 0-2.5 1-2.5 2.3s1.1 2.3 2.5 2.3c1.5 0 2.6-1.1 2.6-2.6V3h2.5z";

/** TikTok : note blanche doublée de ses deux échos de marque (cyan
 *  #25F4EE / rouge #FE2C55), le rendu « fond sombre » officiel. */
export function TikTokBrandIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden data-brand-icon="tiktok">
      <path d={TIKTOK_NOTE} fill="#25F4EE" transform="translate(-0.9 -0.7)" />
      <path d={TIKTOK_NOTE} fill="#FE2C55" transform="translate(0.9 0.7)" />
      <path d={TIKTOK_NOTE} fill="#FFFFFF" />
    </svg>
  );
}
