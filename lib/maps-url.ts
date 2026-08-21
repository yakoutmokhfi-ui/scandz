// ------------------------------------------------------------------
// Lien de localisation/itinéraire configurable (V69, corrigé F-02/V70,
// durci V71/V72/V73) — validation partagée entre l'interface
// (validation immédiate, avant tout appel RPC) et le SQL (revalidation
// défensive dans update_restaurant_maps_url). Mêmes principes que
// lib/whatsapp.ts pour le numéro WhatsApp : un seul point de vérité
// pour la règle de validation, appliquée aux deux endroits.
//
// PROVIDER-NEUTRAL PAR CONCEPTION (F-02) : un simple lien externe
// fourni par le commerçant, jamais une intégration à un fournisseur
// précis (pas d'API Key, pas de géocodage, pas de restriction à un
// domaine Google/OSM/Apple/RNA — un raccourcisseur de lien comme
// maps.app.goo.gl doit rester accepté, de même qu'un futur lien RNA).
//
// CORRIGE V71-03 (contre-audit Work) : `new URL()` seul s'est révélé
// TROP PERMISSIF -- `new URL("https:///path")` est accepté par le
// moteur WHATWG (host normalisé en "path"), vérifié empiriquement,
// alors que le contrat de sécurité exige explicitement ce refus.
// La conclusion n'est PAS d'aligner le SQL sur ce comportement trop
// permissif, mais de DURCIR les deux côtés vers un sous-ensemble
// HTTPS strict et volontairement plus étroit que la grammaire WHATWG
// complète -- jamais une tentative de réimplémenter cette grammaire
// en SQL. `new URL()` n'est plus utilisée comme portail
// d'acceptation : MAPS_URL_STRICT_RE ci-dessous est la seule source
// de vérité, réplique caractère pour caractère côté SQL
// (migration-v73-hardening.sql) -- la preuve de parité n'est jamais
// "ces deux regex se ressemblent", mais l'exécution de la MÊME
// matrice de cas sur les deux côtés (voir
// tests/maps-url-shared-matrix.tsv, consommée à l'identique par
// tests/v73-hardening.test.ts et supabase/tests/v68-storage-policy-check.sh).
//
// CORRIGE V72-06 (contre-audit Work, 3e tour) : la chaîne brute doit
// être validée TELLE QU'ELLE EST REÇUE, jamais après un trim()
// silencieux qui accepterait ensuite une valeur nettoyée. Un espace
// ou retour ligne en tête/fin de la valeur non-vide est désormais
// REFUSÉ, pas simplement ignoré -- seule une valeur ENTIÈREMENT
// blanche (espaces/retours ligne uniquement) reste traitée comme un
// champ vidé (NULL), une préoccupation distincte de la grammaire
// stricte (voir tests/maps-url-shared-matrix.tsv).
//
// CORRIGE V72-07 (contre-audit Work, 3e tour) : le port explicite
// (":NNNN") doit être compris entre 1 et 65535 -- refuse désormais
// ":0", ":65536", ":99999", plage vérifiée exhaustivement côté
// TypeScript ET SQL avant intégration (voir le rapport de livraison).
// ------------------------------------------------------------------

/** Doit rester synchronisé avec la contrainte CHECK sur maps_url dans migration-v70-*.sql. */
export const MAPS_URL_MAX_LENGTH = 500;

/**
 * Port TCP valide : 1 à 65535, sans zéro non significatif superflu
 * (mais "0" lui-même explicitement exclu). Motif canonique par
 * tranches, vérifié exhaustivement (0, 1, 9, 10, 99, 100, 999, 1000,
 * 9999, 10000, 59999, 60000, 65535, 65536, 99999) avant intégration,
 * identique caractère pour caractère côté SQL.
 */
const PORT_1_TO_65535 = "(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3})";

/**
 * Sous-ensemble HTTPS strict et commun (TypeScript ET SQL) :
 *   - schéma "https://" minuscule, strictement obligatoire ;
 *   - host non vide, débutant par un caractère alphanumérique --
 *     jamais par "/", "?", "#", ":" ni la fin de chaîne (exclut
 *     explicitement "https:///path", "https://", "https://?x",
 *     "https://#x", "https://:443") ;
 *   - libellés de host séparés par des points, motif de nom d'hôte
 *     standard (lettres/chiffres/tirets, jamais de tiret en tête/fin
 *     de libellé) ;
 *   - port optionnel (":" suivi d'un nombre 1-65535 STRICTEMENT --
 *     corrige V72-07, ":0"/":65536"/":99999" refusés) ;
 *   - chemin optionnel après "/", sans aucun espace ni retour ligne ;
 *   - aucun espace ni retour ligne nulle part ailleurs dans la valeur
 *     (la classe de caractères du host/chemin les exclut par
 *     construction, pas seulement par un test séparé).
 *
 * Ne vérifie jamais que le lien pointe réellement vers un fournisseur
 * de cartographie précis : c'est un lien public fourni par le
 * commerçant, pas une ressource validée côté serveur (voir
 * non-objectifs : pas de Places API, pas de géocodage, pas de RNA
 * dans ce lot).
 */
export const MAPS_URL_STRICT_RE = new RegExp(
  "^https://[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(:" +
    PORT_1_TO_65535 +
    ")?(/\\S*)?$"
);

export function normalizeMapsUrl(raw: string): string {
  return raw.trim();
}

/**
 * Valide la chaîne BRUTE reçue, telle quelle -- corrige V72-06.
 *
 * Distingue deux préoccupations volontairement séparées :
 *   1. une valeur ENTIÈREMENT blanche (vide ou espaces/retours ligne
 *      uniquement) signifie "champ vidé" -- toujours acceptée,
 *      équivalente à NULL côté RPC (nullif(btrim(...), '')) ;
 *   2. une valeur NON VIDE mais entourée d'espace/retour ligne est
 *      désormais REFUSÉE explicitement -- jamais nettoyée
 *      silencieusement puis validée comme si elle avait été propre.
 */
export function isValidMapsUrl(raw: string): boolean {
  if (raw.length > MAPS_URL_MAX_LENGTH) return false;
  const trimmed = raw.trim();
  if (trimmed === "") return false; // champ vidé : pas une "URL valide" en tant que telle, voir normalizeMapsUrl/RPC
  if (trimmed !== raw) return false; // corrige V72-06 : espace/retour ligne en tête/fin explicitement refusé
  return MAPS_URL_STRICT_RE.test(raw);
}
