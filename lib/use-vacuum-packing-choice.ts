import { useState } from "react";

/**
 * OPTION « MISE SOUS VIDE » -- état du choix du client, réellement RÉINITIALISÉ dès que
 * l'option cesse d'être proposée (plus aucun article éligible, ou mode « table »).
 *
 * Réinitialisation faite PENDANT le rendu (motif React « ajuster l'état au changement de
 * prop ») : aucun rendu intermédiaire ne montre l'ancienne valeur, et retirer puis
 * rajouter un article éligible fait revenir la case DÉCOCHÉE -- jamais un choix fantôme.
 * La valeur retournée est aussi masquée par `available`, par défense en profondeur.
 */
export function useVacuumPackingChoice(available: boolean): [boolean, (next: boolean) => void] {
  const [stored, setStored] = useState(false);
  if (!available && stored) setStored(false);
  return [available && stored, setStored];
}
