import "server-only";

/**
 * PAYMENT P3-A2 — MONETICO SERVER ADAPTER v1.
 * CONSTRUCTION DE LA CHAÎNE CANONIQUE (entrée du calcul de MAC).
 *
 * ⚠️ PROVENANCE DE CETTE RÈGLE -- À CONFIRMER PAR L'AUDIT HUMAIN.
 *
 * La documentation officielle v2.0, section 9.3 (page 80, "Calcul du
 * sceau"), n'a PAS pu être atteinte directement par l'agent via
 * l'outil de récupération web disponible dans cette session : trois
 * tentatives ciblées et indépendantes ont chacune renvoyé un contenu
 * tronqué avant la page 80 (limites observées : page 35, puis page
 * 56, puis page 56 à nouveau -- la limite exacte n'est même pas
 * reproductible, ce qui indique une limite technique du pipeline de
 * récupération face à ce PDF précis plutôt qu'une absence réelle de
 * contenu). Une quatrième source (l'ancienne version v1.0 du document)
 * A pu être atteinte pour cette section, mais décrit une construction
 * DIFFÉRENTE (valeurs positionnelles concaténées, sans "nomChamp=",
 * sans tri) -- explicitement écartée ici car (a) ce n'est pas le
 * document mandaté, (b) elle contredit la règle relayée ci-dessous, et
 * (c) elle n'a pas pu être recoupée avec le texte v2.0 réel.
 *
 * La règle implémentée ci-dessous a été communiquée par l'opérateur
 * humain comme provenant directement de la section 9.3 / page 80 du
 * document v2.0 authentique. Elle n'a PAS pu être vérifiée de façon
 * indépendante par l'agent contre le texte brut du PDF, malgré
 * plusieurs tentatives explicites en ce sens. Aucun vecteur de test
 * officiel (clé + chaîne canonique + MAC résultant attendu) n'a pu
 * être obtenu par l'agent d'aucune source, ce qui interdit toute
 * vérification numérique indépendante de cette règle précise.
 *
 * CE QUI EST FAIT POUR LIMITER LE RISQUE MALGRÉ CETTE LIMITE :
 *   - Cette fonction est un utilitaire PUR et GÉNÉRIQUE, testée pour
 *     son propre comportement interne (ordre, séparateur, casse,
 *     UTF-8, champs vides) indépendamment de toute valeur Monetico
 *     réelle -- ces propriétés structurelles sont vérifiables et
 *     vérifiées par test, MÊME SI la conformité de la règle elle-même
 *     au protocole réel de Monetico ne l'est pas encore.
 *   - Les tests MAC incluent une SECONDE implémentation de référence,
 *     écrite indépendamment (comparateur de tri manuel, boucle de
 *     concaténation manuelle plutôt que map/join), pour détecter toute
 *     erreur d'implémentation de CETTE règle -- ceci prouve la
 *     cohérence interne, PAS la conformité au protocole réel.
 *   - Aucun appel réseau réel n'est de toute façon dans le périmètre
 *     de ce lot (mandat §31) -- rien ici ne peut échouer contre un
 *     serveur Monetico réel avant qu'un futur lot de câblage ne
 *     re-valide explicitement cette règle contre un environnement
 *     Sandbox réel ou contre le PDF source consulté directement par un
 *     humain.
 *
 * RÈGLE TELLE QUE RELAYÉE (§9.3, p.80) :
 *   - Chaque champ contribue une paire "nomChamp=valeurChamp".
 *   - Les paires sont jointes par le caractère "*".
 *   - Les paires sont ORDONNÉES par tri ASCII/ordinal du NOM de champ
 *     (jamais de la valeur), SENSIBLE À LA CASSE -- donc PAS un tri
 *     alphabétique insensible à la casse : par exemple "TPE" (majuscule,
 *     code ASCII 'T'=84) trie AVANT "date" (minuscule, 'd'=100) dans un
 *     tri ordinal strict, ce qui diffère d'un tri alphabétique naïf
 *     insensible à la casse. `Array.prototype.sort()` de JavaScript,
 *     sans comparateur, trie par unité de code UTF-16 -- ce qui
 *     coïncide exactement avec un tri ASCII ordinal pour tout nom de
 *     champ ASCII (le cas de tous les noms de champ Monetico utilisés
 *     ici), et c'est donc utilisé tel quel, sans comparateur
 *     personnalisé.
 *   - Direction sortante (requête) : TOUS les paramètres reconnus par
 *     la plateforme et implémentés par ce lot sont inclus, qu'ils
 *     soient renseignés ou vides (voir request.ts -- le jeu "reconnu"
 *     pour ce lot v1 est le sous-ensemble obligatoire documenté :
 *     version/TPE/date/montant/reference/lgue/contexte_commande/
 *     societe ; aucun champ optionnel non implémenté par ce lot n'y
 *     figure).
 *   - Direction callback (vérification) : TOUS les paramètres
 *     EFFECTIVEMENT REÇUS sont inclus (à l'exclusion du champ MAC
 *     lui-même) -- voir callback.ts, qui construit cet ensemble à
 *     partir des données brutes reçues, pas d'une liste fixe.
 *   - Encodage : les caractères non-ASCII des valeurs sont encodés en
 *     UTF-8 avant hachage (voir mac.ts::computeMac, qui applique
 *     `hmac.update(canonical, "utf8")`).
 */

export function buildCanonicalString(fields: Record<string, string>): string {
  const names = Object.keys(fields).sort();
  return names.map((name) => `${name}=${fields[name]}`).join("*");
}
