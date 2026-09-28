import type { MenuItem } from "@/lib/types";
import type { ServiceMode } from "@/lib/restaurants-config";

/**
 * PRODUCT SERVICE MODES v1 -- utilitaires PURS partagés entre la carte
 * publique (badge de restriction, MenuItemCard.tsx) et le panier
 * (blocage panier mixte, CartPanel.tsx/MenuView.tsx). Aucun appel
 * réseau ici : tout part de `item.allowed_sale_modes`, déjà résolu par
 * lib/services/restaurant.ts (sémantique ALL-par-absence -- null/[] =
 * ALL, jamais un tableau vide en pratique côté base : create_product/
 * update_product le refusent explicitement -- voir
 * DRAFT-lot-product-service-modes-v1.sql, SCANYM_SERVICE_MODES_EMPTY_RESTRICTION).
 *
 * Indépendant de `withdrawal_eligible` (droit de rétractation) --
 * aucune lecture de cet attribut ici, conformément à l'exigence CIO
 * (aucun couplage, aucune inférence croisée entre les deux attributs).
 *
 * Purement informatif/présentation côté client : `create_order`
 * (serveur) reste la SEULE autorité qui compte (contrôle par ligne,
 * voir DRAFT-lot-product-service-modes-v1.sql section F) -- rien ici
 * ne remplace ce contrôle, qui s'applique même si un appelant
 * contournait entièrement cette UI.
 */

const FRONTEND_SUPPORTED_MODES: ServiceMode[] = ["table", "pickup", "delivery"];

/**
 * Sous-ensemble des modes frontend-connus auquel CE produit est
 * restreint, ou `null` UNIQUEMENT si le produit est disponible pour
 * TOUS les modes de l'établissement (aucune restriction -- `raw`
 * absent/null/[]).
 *
 * CORRECTIF (audit indépendant CHATEAUBRIAND, issue #11) : une
 * restriction serveur EXPLICITE et non vide (`raw.length > 0`) N'EST
 * JAMAIS traitée comme "Tous", même quand elle est composée en tout
 * ou partie de codes que le frontend ne sait pas encore rendre
 * individuellement (ex. `room_service`, `click_collect`, ou tout
 * futur mode). Dans ce cas, cette fonction retourne le sous-ensemble
 * des modes frontend-connus explicitement autorisés -- qui peut être
 * un tableau VIDE (`[]`, distinct de `null`) quand AUCUN mode
 * frontend-connu n'est autorisé (ex. `["room_service"]` seul) :
 * `create_order` (serveur, seule autorité qui compte) rejettera une
 * commande `table`/`pickup`/`delivery` pour cet article, donc le
 * client doit refléter EXACTEMENT le même refus -- jamais l'inverse
 * (désaccord client/serveur = régression fonctionnelle confirmée,
 * corrigée ici). `[]` étant "truthy" en JS (`![] === false`), tous
 * les appelants qui testent `if (!restricted) // ALL` continuent de
 * fonctionner sans modification : seul `null` signifie "aucune
 * restriction", `[]` signifie "restreint, à rien de frontend-connu".
 */
export function frontendRestrictedModes(item: MenuItem): ServiceMode[] | null {
  const raw = item.allowed_sale_modes;
  if (!raw || raw.length === 0) return null;
  return raw.filter((m): m is ServiceMode =>
    (FRONTEND_SUPPORTED_MODES as string[]).includes(m)
  );
}

/** Clé i18n du libellé d'un mode -- même convention déjà utilisée par
 *  la rangée "howToReceive" (CartPanel.tsx) et FulfillmentChoiceModal :
 *  `t(mode === "table" ? "modeTable" : mode)`. Centralisée ici pour
 *  n'avoir jamais un second jeu de libellés pour le même mode. */
export function serviceModeNameKey(mode: ServiceMode): string {
  return mode === "table" ? "modeTable" : mode;
}

/**
 * Panier mixte -- pour chaque mode frontend-connu, les PRODUITS DU
 * PANIER (dédoublonnés par id, dans leur ordre d'apparition) dont la
 * restriction EXCLUT ce mode. Un mode absent du résultat n'est bloqué
 * par AUCUN produit du panier actuel -- jamais l'inverse (un produit
 * sans restriction, ou dont la restriction couvre déjà ce mode, ne
 * bloque jamais ce mode).
 */
export function blockingItemsByMode(
  items: MenuItem[]
): Partial<Record<ServiceMode, MenuItem[]>> {
  const out: Partial<Record<ServiceMode, MenuItem[]>> = {};
  for (const mode of FRONTEND_SUPPORTED_MODES) {
    const seen = new Set<string>();
    const blockers: MenuItem[] = [];
    for (const item of items) {
      const restricted = frontendRestrictedModes(item);
      if (!restricted) continue; // `null` uniquement = ALL (vraiment non restreint) -- ne bloque jamais rien
      // `restricted` peut être `[]` (restriction explicite composée
      // uniquement de codes non reconnus par le frontend) : `mode`
      // (toujours frontend-connu ici) n'y est alors jamais inclus,
      // donc l'item bloque bien CE mode -- comportement voulu (accord
      // client/serveur, voir frontendRestrictedModes ci-dessus).
      if (restricted.includes(mode)) continue;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      blockers.push(item);
    }
    if (blockers.length > 0) out[mode] = blockers;
  }
  return out;
}
