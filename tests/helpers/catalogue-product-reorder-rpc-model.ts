/**
 * Scanym — CATALOGUE PRODUCT REORDER v1 — MODÈLE DU CONTRAT RPC
 * (jamais du code de production).
 *
 * Transcription, en TypeScript pur, de ce que fait
 * `public.move_product_order(uuid, text, jsonb)`
 * (supabase/DRAFT-lot-catalogue-product-reorder-v1.sql) UNE FOIS
 * l'appelant autorisé : mêmes étapes, dans le même ordre, mêmes refus.
 *
 * POURQUOI CE FICHIER EXISTE (audit, CPR-AUDIT-01) : le « serveur »
 * simulé des tests DOM de la première version comparait la liste
 * d'identifiants reçue à l'ordre courant, c'est-à-dire qu'il était
 * PLUS STRICT que le SQL de production -- il refusait la vue périmée
 * que le vrai SQL acceptait, et masquait ainsi la faille. Un faux
 * serveur ne doit être ni plus strict ni plus laxiste que le vrai.
 *
 * Ce modèle est donc PROUVÉ ÉQUIVALENT au SQL réel par un test
 * différentiel (tests/catalogue-product-reorder-v1-sql.test.ts,
 * « [MODÈLE] ») : sur des centaines de scénarios tirés au hasard
 * (vues fraîches, périmées, mal formées), le SQL exécuté dans
 * PostgreSQL et ce modèle rendent la même décision et laissent les
 * mêmes display_order. C'est CE modèle, et rien d'autre, que le faux
 * serveur des tests DOM exécute.
 *
 * HORS MODÈLE (délibérément) : l'autorisation (assert_product_role :
 * authentification, rôle owner/manager, opérateur). Elle précède tout
 * le reste dans la fonction et ne dépend pas de la vue transmise ;
 * elle est prouvée sur le SQL réel. Le modèle décrit ce qui arrive à
 * un appelant AUTORISÉ.
 *
 * TRANSPORT : `expectedScope` est une valeur JavaScript telle que
 * JSON.stringify la transmettrait. Pour toute valeur que JSON sait
 * porter jusqu'à un `jsonb`, la décision du modèle est celle du SQL.
 * (Une chaîne contenant U+0000 ou un demi-codet isolé n'atteint jamais
 * la fonction : PostgreSQL refuse le JSON lui-même, sans écriture.)
 */

/** Une ligne de `menu_items`, réduite aux colonnes que la RPC lit. */
export interface RpcModelRow {
  id: string;
  category_id: string;
  subcategory_id: string | null;
  name: string;
  display_order: number;
  archived_at: string | null;
}

export type RpcModelOutcome =
  /** Déplacement appliqué. `writes` : id -> nouveau display_order, pour
   *  les SEULES lignes dont la valeur change. */
  | { kind: "moved"; position: number; writes: Record<string, number> }
  /** P0001 SCANYM_PRODUCT_ORDER_STALE -- aucune écriture. */
  | { kind: "stale" }
  /** 22023 SCANYM_PRODUCT_ORDER_BOUNDARY -- aucune écriture. */
  | { kind: "boundary" }
  /** 22023 SCANYM_PRODUCT_ORDER_INVALID_DIRECTION -- aucune écriture. */
  | { kind: "invalid_direction" }
  /** P0002 « Product not found » / « Product not found or archived ». */
  | { kind: "not_found" };

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Décision de `move_product_order` pour un appelant autorisé.
 * Ne mute rien : les écritures sont RENDUES, à appliquer par l'appelant.
 */
export function moveProductOrderModel(
  rows: ReadonlyArray<RpcModelRow>,
  productId: string,
  direction: unknown,
  expectedScope: unknown
): RpcModelOutcome {
  // assert_product_role : produit inconnu -> P0002.
  const product = rows.find((r) => r.id === productId);
  if (!product) return { kind: "not_found" };

  // Direction.
  if (direction !== "up" && direction !== "down") return { kind: "invalid_direction" };

  // Étape 3 : produit archivé -> P0002.
  if (product.archived_at !== null) return { kind: "not_found" };

  // Étape 4 : périmètre = lignes NON ARCHIVÉES de même catégorie et de
  // même sous-catégorie (nulle = produits directs).
  const scope = rows.filter(
    (r) =>
      r.category_id === product.category_id &&
      r.subcategory_id === product.subcategory_id &&
      r.archived_at === null
  );

  // Gardes de forme et de taille.
  if (!Array.isArray(expectedScope)) return { kind: "stale" };
  if (expectedScope.length !== scope.length) return { kind: "stale" };

  // Étape 5 : contrôle de fraîcheur.
  const byId = new Map(scope.map((r) => [r.id, r]));
  const seen = new Set<string>();
  let previous: number | null = null;
  let position: number | null = null;
  let fresh = true;
  let outOfOrder = false;

  for (let index = 0; index < expectedScope.length; index++) {
    const item: unknown = expectedScope[index];
    const id = isJsonObject(item) && typeof item.id === "string" ? item.id : null;
    const row = id === null ? undefined : byId.get(id);
    if (!row) {
      // Élément qui ne désigne aucune ligne du périmètre.
      fresh = false;
      previous = null;
      continue;
    }
    // (a) aucune ligne désignée deux fois.
    if (seen.has(row.id)) fresh = false;
    seen.add(row.id);
    const entry = item as Record<string, unknown>;
    // (b) display_order reçu = display_order stocké.
    if (typeof entry.display_order !== "number" || entry.display_order !== row.display_order) fresh = false;
    // (c) name reçu = name stocké, à l'identique.
    if (typeof entry.name !== "string" || entry.name !== row.name) fresh = false;
    // (d) display_order stocké non décroissant le long de la liste.
    if (previous !== null && row.display_order < previous) outOfOrder = true;
    previous = row.display_order;
    if (row.id === productId) position = index + 1;
  }

  if (scope.length === 0 || seen.size !== scope.length || !fresh || outOfOrder || position === null) {
    return { kind: "stale" };
  }

  // Étape 6 : bornes.
  const at: number = position;
  if (direction === "up" && at <= 1) return { kind: "boundary" };
  if (direction === "down" && at >= scope.length) return { kind: "boundary" };
  const target = direction === "up" ? at - 1 : at + 1;

  // Étape 7 : échange des deux voisins, renumérotation dense 1..N,
  // seules les lignes dont la valeur change sont écrites.
  const writes: Record<string, number> = {};
  for (let index = 0; index < expectedScope.length; index++) {
    const ord = index + 1;
    const next = ord === at ? target : ord === target ? at : ord;
    const row = byId.get((expectedScope[index] as { id: string }).id) as RpcModelRow;
    if (row.display_order !== next) writes[row.id] = next;
  }
  return { kind: "moved", position: target, writes };
}

/**
 * EMPREINTE DE RÉFÉRENCE d'un périmètre (« scope fingerprint ») : la
 * sérialisation canonique, triée par identifiant, des triplets
 * (id, display_order, name). Elle n'est PAS utilisée par la RPC : elle
 * sert, dans les tests, à démontrer que la décision de fraîcheur de la
 * RPC est exactement « empreinte de la vue = empreinte de l'état
 * stocké » -- sans que ni le client ni le serveur n'aient à produire
 * la même sérialisation.
 */
export function referenceScopeFingerprint(
  entries: ReadonlyArray<{ id: string; display_order: number; name: string }>
): string {
  return JSON.stringify(
    [...entries]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((e) => [e.id, e.display_order, e.name])
  );
}
