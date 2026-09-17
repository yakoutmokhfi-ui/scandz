"use client";

import { useEffect, useMemo, useRef } from "react";

/**
 * SCANYM — RESTAURANT CONTEXT HARDENING v1.1
 * Remédiation du blocage CTXHARD-V1-STALE-RESPONSE-01.
 *
 * POURQUOI CE MODULE EXISTE
 * -------------------------
 * L'audit indépendant a conclu que le résolveur SYNCHRONE de contexte
 * (`resolveRestaurantContext`, lib/dashboard-nav.ts) était correct,
 * mais que le chemin ASYNCHRONE ne l'était pas. Séquence reproduite :
 *
 *     A courant -> requête A part -> bascule vers B -> requête B part
 *     -> B se résout et s'affiche -> la VIEILLE requête A se résout en
 *        RETARD et écrase l'interface de B.
 *
 * Résultat : entête et contexte disent "B", données affichées viennent
 * de "A". C'est interdit sans condition -- une réponse périmée ne doit
 * JAMAIS devenir visible ni actionnable.
 *
 * LA RÈGLE, EN UNE PHRASE
 * -----------------------
 * Toute réponse asynchrone doit PROUVER, au moment où elle revient,
 * qu'elle appartient (A) au restaurant actuellement actif ET (B) à la
 * génération de requête courante. Si l'une des deux conditions manque,
 * la réponse est ABANDONNÉE : aucun `setState`, aucun effet de bord.
 *
 * Les deux contrôles sont nécessaires et aucun ne suffit seul :
 *   - la GÉNÉRATION seule laisserait passer une réponse concernant un
 *     autre restaurant si, par malchance, aucune requête plus récente
 *     n'avait encore été émise (ex. bascule vers un contexte qui ne
 *     déclenche pas immédiatement de chargement) ;
 *   - le RESTAURANT seul laisserait passer une réponse périmée dans une
 *     séquence A -> B -> A : la vieille réponse de A désigne bien le
 *     restaurant redevenu actif, mais elle porte un état ANCIEN qui
 *     écraserait la réponse courante.
 * La condition « toujours monté » s'y ajoute pour ne jamais écrire dans
 * un composant démonté.
 *
 * POURQUOI PAS D'AbortController ICI
 * ----------------------------------
 * Le mandat l'autorise « where useful ». Ici, il ne le serait pas, et
 * l'ajouter serait trompeur : TOUTES les lectures locataires passent
 * par `supabase.rpc(...)` (lib/services/*.ts), qui n'expose aucun
 * signal d'annulation -- un `AbortController` branché là n'annulerait
 * RIEN et donnerait une fausse impression de protection. Les seuls
 * `fetch()` du code sont des MUTATIONS (publication CGV, photo produit,
 * demande de facture), qui n'écrasent pas l'affichage locataire. La
 * protection retenue est donc entièrement DÉTERMINISTE côté réception,
 * ce qui est strictement plus sûr qu'une annulation « best effort » :
 * même une requête réellement annulée peut avoir déjà résolu.
 *
 * AUCUNE HYPOTHÈSE DE TEMPS n'est faite, nulle part : ni délai, ni
 * ordre d'arrivée supposé. C'est une exigence explicite du mandat.
 */

export interface RestaurantRequestToken {
  /** Restaurant pour lequel cette requête a été émise. */
  readonly restaurantId: string;
  /**
   * `true` seulement si les TROIS conditions tiennent encore :
   * composant monté, génération courante, restaurant actif inchangé.
   * À tester APRÈS chaque `await`, avant tout `setState`.
   */
  isCurrent(): boolean;
}

export interface RestaurantContextGuard {
  /**
   * Adopte `restaurantId` comme contexte actif et INVALIDE
   * immédiatement toute requête encore en vol.
   *
   * À appeler dans le MÊME gestionnaire d'événement que le changement
   * de restaurant sélectionné (React regroupe les mises à jour d'un
   * même gestionnaire en un seul rendu) : il ne peut alors jamais
   * exister de rendu où le contexte a déjà changé mais où une réponse
   * de l'ancien restaurant serait encore acceptable.
   */
  enterContext(restaurantId: string): void;
  /**
   * Ouvre une requête pour `restaurantId` et retourne son jeton.
   *
   * Émettre une requête pour un restaurant différent du contexte actif
   * signifie que le contexte a bougé : le jeton adopte donc ce
   * restaurant et invalide les requêtes précédentes. Cela couvre le
   * TOUT PREMIER chargement, qui ne passe par aucun gestionnaire de
   * sélection.
   */
  beginRequest(restaurantId: string): RestaurantRequestToken;
  /**
   * Restaurant actif, lisible depuis une continuation asynchrone sans
   * risque de fermeture périmée (une variable capturée dans une closure
   * vaut celle du rendu où la requête est partie, pas celle du moment
   * où la réponse arrive).
   */
  currentRestaurantId(): string;
}

export function useRestaurantContextGuard(): RestaurantContextGuard {
  const currentRef = useRef("");
  const seqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Toute requête encore en vol au démontage est définitivement
      // périmée : l'incrément suffit à les neutraliser toutes.
      seqRef.current += 1;
    };
  }, []);

  return useMemo<RestaurantContextGuard>(() => {
    const enterContext = (restaurantId: string) => {
      currentRef.current = restaurantId;
      seqRef.current += 1;
    };
    return {
      enterContext,
      currentRestaurantId: () => currentRef.current,
      beginRequest: (restaurantId: string): RestaurantRequestToken => {
        if (restaurantId !== currentRef.current) currentRef.current = restaurantId;
        const seq = ++seqRef.current;
        return {
          restaurantId,
          isCurrent: () =>
            mountedRef.current &&
            seq === seqRef.current &&
            restaurantId === currentRef.current,
        };
      },
    };
  }, []);
}
