/**
 * Scanym — CATALOGUE — COLLECTIONS / TAGS FOUNDATION v1.
 * Résolution des tags d'un import. PURE (aucun accès réseau, aucune
 * écriture) -- même discipline que lib/catalogue-import/resolution.ts,
 * dont ce module reprend exactement le vocabulaire (EXISTING /
 * WOULD_CREATE) et la clé de correspondance (`normalizedKey`).
 *
 * RÔLE EXACT, ET SES LIMITES : ce module sert l'AFFICHAGE de la
 * preview (« ce tag existe déjà » vs « ce tag sera créé »). Il n'est
 * JAMAIS l'autorité de ce qui est réellement écrit : au commit, c'est
 * la RPC `add_product_tags` qui re-résout côté serveur, dans la même
 * transaction que l'association. C'est la même séparation que pour
 * les catégories (preview résout pour montrer, le serveur tranche pour
 * écrire) -- un objet de preview conservé en mémoire navigateur n'a
 * donc aucune influence sur la persistance.
 *
 * AMBIGUOUS n'existe pas ici, contrairement aux catégories : l'index
 * unique partiel (restaurant_id, normalized_key) where is_active rend
 * structurellement impossible l'existence de deux tags actifs de même
 * clé pour un même établissement. Deux candidats ne peuvent donc pas
 * collisionner.
 */
import { normalizedKey } from "@/lib/catalogue-import/normalization";

export type TagResolutionState = "EXISTING" | "WOULD_CREATE";

export interface TagResolution {
  state: TagResolutionState;
  /** Nom affiché : le nom EXISTANT tel qu'enregistré si EXISTING (la
   *  casse en base fait foi, jamais celle du fichier), sinon la valeur
   *  du fichier telle que saisie. */
  displayName: string;
  /** Présent uniquement si state === "EXISTING". */
  existingId?: string;
}

/** Forme minimale attendue d'un tag existant -- volontairement réduite
 *  aux deux champs nécessaires, pour que ce module ne dépende pas du
 *  type complet de la couche service. */
export interface ExistingTagLike {
  id: string;
  name: string;
}

/**
 * Résout les tags d'UNE ligne contre les tags actifs existants.
 *
 * Déduplication insensible à la casse À L'INTÉRIEUR de la ligne, dans
 * l'ordre de première apparition -- même règle que `splitTagsColumn`
 * (qui l'a déjà appliquée en amont) et que la RPC serveur, pour que
 * les trois couches comptent exactement la même chose.
 */
export function resolveTagsForRow(
  existingTags: ReadonlyArray<ExistingTagLike>,
  tagNames: ReadonlyArray<string>
): TagResolution[] {
  const byKey = new Map<string, ExistingTagLike>();
  for (const tag of existingTags) {
    const key = normalizedKey(tag.name);
    if (key === "") continue;
    // Premier gagnant : l'index unique partiel garantit qu'il n'y a de
    // toute façon jamais deux tags ACTIFS de même clé.
    if (!byKey.has(key)) byKey.set(key, tag);
  }

  const seen = new Set<string>();
  const out: TagResolution[] = [];
  for (const raw of tagNames) {
    const key = normalizedKey(raw);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);

    const existing = byKey.get(key);
    out.push(
      existing
        ? { state: "EXISTING", displayName: existing.name, existingId: existing.id }
        : { state: "WOULD_CREATE", displayName: raw.trim() }
    );
  }
  return out;
}

/** Nombre de tags que cet import créerait réellement, toutes lignes
 *  confondues -- dédupliqué entre lignes (vingt produits « Bio » ne
 *  créent qu'un seul tag, exactement comme pour les catégories). */
export function countTagsToCreate(
  resolutionsByRow: ReadonlyMap<number, TagResolution[]>
): number {
  const keys = new Set<string>();
  for (const resolutions of resolutionsByRow.values()) {
    for (const r of resolutions) {
      if (r.state === "WOULD_CREATE") keys.add(normalizedKey(r.displayName));
    }
  }
  return keys.size;
}
