/**
 * Note générale de commande (V65) — normalisation et comptage partagés
 * entre l'interface (compteur, validation avant envoi) et la charge
 * transmise à la RPC create_order.
 *
 * ATTENTION — trim() natif : String.prototype.trim() en JavaScript et
 * trim() en PostgreSQL NE retirent PAS le même ensemble de caractères.
 * Vérifié explicitement (pas supposé) :
 *   - JS "\u00A0Bonjour\u00A0".trim()  -> "Bonjour"  (l'espace insécable
 *     U+00A0 est retiré : JS suit la définition Unicode "WhiteSpace" +
 *     "LineTerminator", qui inclut espace, tabulation, LF, CR, FF, VT,
 *     NBSP, BOM/ZWNBSP et les séparateurs Unicode de catégorie "Zs").
 *   - PostgreSQL trim(' Bonjour ') ne retire QUE l'espace ASCII
 *     (U+0020) par défaut ; les tabulations et sauts de ligne en
 *     bordure NE SONT PAS retirés par un trim() sans argument.
 * Les deux fonctions ne sont donc jamais présumées équivalentes ici.
 *
 * À la place, les deux côtés (ce fichier, en JavaScript avec le
 * regex EDGE_WHITESPACE ci-dessous, et la fonction SQL create_order
 * dans supabase/migration-v65-order-note.sql, avec
 * btrim(..., E' \t\n\r\f' || chr(11))) utilisent CONCEPTUELLEMENT le
 * même jeu de caractères "espace" restreint :
 *   espace (U+0020), tabulation (\t), saut de ligne (\n),
 *   retour chariot (\r), saut de page (\f), tabulation verticale
 *   (U+000B).
 *
 * ATTENTION — piège SQL déjà rencontré et corrigé : \v N'EST PAS un
 * échappement reconnu par PostgreSQL dans une chaîne E'...' (seuls
 * \b \f \n \r \t le sont ; tout le reste est pris littéralement).
 * `E'\v'` produit la lettre "v", pas U+000B — vérifié empiriquement
 * sur une instance PostgreSQL 16 réelle (`select ascii(E'\v')` → 118,
 * code de "v", pas 11). Le SQL utilise donc `chr(11)`, jamais `\v`.
 * Ce piège n'existe PAS côté JavaScript : `\v` y est un échappement
 * valide pour U+000B (utilisé sans risque dans EDGE_WHITESPACE
 * ci-dessous). Les deux syntaxes diffèrent donc volontairement ; ce
 * qui doit rester identique, c'est le JEU DE CARACTÈRES couvert, pas
 * la façon de l'écrire dans chaque langage.
 *
 * Un espace insécable ou tout autre séparateur Unicode "large" en
 * début/fin de note n'est retiré NI côté JS NI côté SQL — traité
 * comme un caractère de contenu ordinaire des deux côtés. Ce choix
 * est vérifié par des tests comportementaux JavaScript
 * (tests/v65-order-note.test.ts, ex. NBSP non retiré) et par un
 * contrôle manuel exécuté sur PostgreSQL réel (voir le bloc
 * "0bis. CONTRÔLE MANUEL" dans la migration). Un test statique
 * complémentaire vérifie seulement l'absence textuelle de `\v` dans
 * la chaîne SQL de normalisation — il ne prouve pas, à lui seul, le
 * comportement d'exécution réel de PostgreSQL.
 *
 * Comptage : PostgreSQL length()/char_length() compte des caractères
 * Unicode (un point de code = un caractère). `Array.from(str).length`
 * itère aussi par point de code (contrairement à `str.length`, qui
 * compte des unités UTF-16 et double certains emojis). Les deux
 * comptages s'alignent pour l'immense majorité des cas usuels
 * (accents, arabe, emojis simples) ; des séquences Unicode complexes
 * à plusieurs points de code pour un seul glyphe affiché (ex. familles
 * d'emojis en séquences ZWJ) peuvent compter plusieurs "caractères"
 * des deux côtés de façon cohérente entre eux, mais peuvent différer
 * du nombre de glyphes réellement affichés à l'écran. La limite de
 * 500 reste appliquée de façon stricte et cohérente entre client et
 * serveur ; en cas de doute, le serveur est la source de vérité et
 * rejette explicitement (jamais de troncature silencieuse).
 */

export const ORDER_NOTE_MAX_LENGTH = 500;

/**
 * Jeu de caractères "espace" pour le trim de bordure, côté JavaScript.
 * `\v` est ici un échappement JS légitime pour U+000B — ce jeu
 * correspond CONCEPTUELLEMENT (même caractères couverts, syntaxe
 * différente) à btrim(..., E' \t\n\r\f' || chr(11)) côté SQL (voir
 * supabase/migration-v65-order-note.sql — jamais `\v` là-bas, voir le
 * commentaire en tête de fichier). Ne pas modifier ici sans modifier
 * également le fichier SQL. Un test statique
 * (tests/v65-order-note.test.ts) vérifie uniquement l'absence
 * textuelle de `\v` côté SQL ; il ne vérifie pas l'égalité des deux
 * jeux de caractères entre les deux fichiers (aucune comparaison
 * automatique fiable n'est possible entre un regex JS et une
 * expression SQL sans les exécuter toutes les deux dans leur propre
 * moteur — voir le contrôle manuel PostgreSQL dans la migration).
 */
const EDGE_WHITESPACE = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;

/**
 * Trim explicite (ni String.prototype.trim(), ni aucune fonction
 * native) : ne retire que le jeu de caractères ci-dessus. Destiné à
 * couvrir, côté JavaScript, le même jeu de caractères que
 * btrim(coalesce(p_note, ''), E' \t\n\r\f' || chr(11)) côté
 * PostgreSQL (supabase/migration-v65-order-note.sql) — pas un miroir
 * syntaxique (`\v` n'a pas le même sens dans les deux langages), un
 * miroir sémantique du jeu de caractères couvert.
 */
function trimNoteEdges(raw: string): string {
  return raw.replace(EDGE_WHITESPACE, "");
}

export interface OrderNoteState {
  /** Valeur nettoyée (jeu de caractères ci-dessus retiré en bordure), prête à être envoyée. */
  value: string;
  /** Nombre de caractères Unicode (comptage par point de code, aligné sur PostgreSQL). */
  length: number;
  /** true si `length` ne dépasse pas la limite. */
  isValid: boolean;
  /** true si la note, une fois nettoyée, est vide. */
  isEmpty: boolean;
}

/** Normalise une saisie de note : trim explicite, puis comptage par point de code. */
export function normalizeOrderNote(raw: string | null | undefined): OrderNoteState {
  const value = trimNoteEdges(raw ?? "");
  const length = Array.from(value).length;
  return {
    value,
    length,
    isValid: length <= ORDER_NOTE_MAX_LENGTH,
    isEmpty: value.length === 0,
  };
}

/**
 * Valeur à transmettre à la RPC : `null` si vide, sinon la valeur
 * normalisée. Ne tronque jamais — si la note dépasse la limite, elle
 * est transmise telle quelle pour que le serveur la rejette
 * explicitement (voir migration-v65-order-note.sql).
 */
export function orderNotePayload(raw: string | null | undefined): string | null {
  const { value, isEmpty } = normalizeOrderNote(raw);
  return isEmpty ? null : value;
}
