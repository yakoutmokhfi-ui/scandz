/**
 * Scanym — TRANSLATIONS BULK VALIDATION v1.
 * Sélection et exécution BORNÉE d'une validation en masse.
 * PUR -- aucun accès réseau, aucun DOM, aucun état global : l'écriture
 * est injectée par l'appelant (l'écran passe la RPC existante
 * `write_translation`).
 *
 * ------------------------------------------------------------------
 * POURQUOI AUCUNE NOUVELLE SQL, AUCUNE RPC EN MASSE (mandat §6)
 * ------------------------------------------------------------------
 * Valider une traduction, c'est EXACTEMENT ce que fait déjà le bouton
 * « Valider » d'une ligne : réécrire la valeur DÉJÀ STOCKÉE avec
 * `status = 'validated'`, sous la précondition de hash source. La
 * validation en masse n'est donc qu'une répétition bornée de cet appel
 * autoritatif -- elle hérite TELLES QUELLES de toutes les garanties
 * serveur (isolation locataire, rôle, langue active, langue source
 * interdite, verrou de ligne, comparaison de hash sous verrou). Une RPC
 * d'import/validation en masse aurait au contraire dupliqué ces
 * contrôles côté serveur : une seconde autorité à maintenir, donc une
 * occasion de divergence. AUCUNE SQL n'est ajoutée par ce lot.
 *
 * ------------------------------------------------------------------
 * PIÈGE CENTRAL : « à relire » NE VEUT PAS DIRE « à jour »
 * ------------------------------------------------------------------
 * `getTranslationStatus` renvoie `to_review` dès que le statut stocké
 * n'est pas `validated` -- SANS regarder le hash (le statut `stale`
 * n'est dérivé que pour une traduction DÉJÀ validée). Une traduction
 * enregistrée « à relire » contre un texte source qui a changé depuis
 * est donc affichée « À relire », alors que son contenu ne correspond
 * plus à la source actuelle.
 *
 * La valider en réécrivant le hash source ACTUEL la rendrait PUBLIQUE
 * (statut validé + hash concordant) alors qu'elle traduit un texte qui
 * n'existe plus. C'est précisément ce que ce module refuse : une ligne
 * n'est retenue QUE si le hash source stocké à côté de la traduction
 * est encore IDENTIQUE au hash source actuel. Les autres sont comptées
 * et signalées au commerçant, jamais validées en silence.
 *
 * Le contrôle serveur reste malgré tout la frontière réelle : le hash
 * courant est transmis en précondition (`p_expected_source_hash`), donc
 * un changement de source ENTRE l'écran et l'écriture fait refuser la
 * ligne par la base (SQLSTATE 40001), jamais accepter.
 */
import { getTranslationStatus } from "@/lib/translation-resolver";
import {
  isTranslatableField,
  rowStoredTranslation,
  type TranslationEntityType,
  type TranslationRow,
} from "@/lib/translations-management/rows";

/** Une ligne RETENUE pour validation. La valeur est la traduction DÉJÀ
 *  stockée, réécrite à l'identique : la validation en masse ne fabrique
 *  aucun contenu, elle ne change QUE le statut. */
export interface BulkValidationCandidate {
  entityType: TranslationEntityType;
  entityId: string;
  field: string;
  /** Traduction actuellement stockée -- réécrite sans modification. */
  value: string;
  /** Hash source ACTUEL, transmis comme précondition de concurrence. */
  sourceHash: string;
}

export interface BulkValidationSelection {
  candidates: BulkValidationCandidate[];
  /** Lignes « à relire » DÉLIBÉRÉMENT écartées faute de pouvoir prouver
   *  qu'elles correspondent encore au texte source actuel (hash stocké
   *  différent, ou hash source indisponible). Affichées au commerçant,
   *  jamais validées. */
  skippedStale: number;
}

/** Phrase d'explication de la confirmation -- texte imposé par le
 *  mandat §3, gardé ici pour être vérifiable par les tests. */
export const BULK_VALIDATION_EXPLANATION =
  "Seules les traductions à relire et toujours à jour seront validées.";

/**
 * Sélectionne les traductions validables en masse.
 *
 * PÉRIMÈTRE (mandat §2) -- restreint par construction :
 *   - établissement courant : `rows` ne contient QUE ses lignes ;
 *   - langue cible courante : le statut et la traduction sont lus pour
 *     `targetLang` seule, et c'est cette langue qui sera écrite ;
 *   - statut d'affichage `to_review` STRICTEMENT (donc jamais
 *     `missing`, jamais `validated`, jamais `stale`) ;
 *   - hash source stocké ENCORE identique au hash source actuel ;
 *   - couple (type d'entité, champ) réellement traduisible.
 *
 * Écrire dans la langue source est interdit côté serveur : la sélection
 * est vide dans ce cas, avant tout appel.
 */
export function selectBulkValidationCandidates(
  rows: ReadonlyArray<TranslationRow>,
  targetLang: string,
  sourceLanguage: string | null | undefined
): BulkValidationSelection {
  const candidates: BulkValidationCandidate[] = [];
  let skippedStale = 0;

  if (!targetLang || targetLang === sourceLanguage) return { candidates, skippedStale };

  const seen = new Set<string>();
  for (const row of rows) {
    // Défense en profondeur : jamais un couple hors table de vérité,
    // même si une ligne malformée apparaissait en amont.
    if (!isTranslatableField(row.entityType, row.field)) continue;

    const status = getTranslationStatus(row.sourceHash, row.translations, targetLang, row.field);
    if (status !== "to_review") continue;

    const value = rowStoredTranslation(row, targetLang);
    if (!value) continue; // « à relire » implique une valeur ; garde-fou

    const currentHash = row.sourceHash ?? "";
    const storedHash = row.translations?.[targetLang]?.[`${row.field}_source_hash`] ?? "";
    if (currentHash === "" || storedHash !== currentHash) {
      // Traduction écrite contre un AUTRE texte source : la valider
      // publierait une traduction qui ne correspond plus.
      skippedStale += 1;
      continue;
    }

    const key = `${row.entityType}\u0000${row.entityId}\u0000${row.field}`;
    if (seen.has(key)) continue; // jamais deux écritures pour la même cible
    seen.add(key);

    candidates.push({
      entityType: row.entityType,
      entityId: row.entityId,
      field: row.field,
      value,
      sourceHash: currentHash,
    });
  }

  return { candidates, skippedStale };
}

/** Question de confirmation, avec le compte EXACT (mandat §3). */
export function bulkValidationConfirmationQuestion(
  count: number,
  languageLabel: string
): string {
  const label = (languageLabel || "").toLocaleLowerCase("fr");
  const noun = count === 1 ? "traduction" : "traductions";
  return label
    ? `Valider ${count} ${noun} en ${label} ?`
    : `Valider ${count} ${noun} ?`;
}

export interface BulkValidationOutcome {
  validated: number;
  failed: number;
  /** Sous-ensemble de `failed` : lignes refusées par le SERVEUR parce
   *  que le texte source a changé entre l'écran et l'écriture. */
  staleRejectedByServer: number;
}

/** Contrat d'erreur de la RPC (SQLSTATE 40001) -- reconnu au même
 *  endroit par l'import et par la validation en masse, jamais dupliqué
 *  sous deux formes qui pourraient diverger. */
export function isSourceChangedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("SCANYM_TRANSLATION_SOURCE_CHANGED");
}

/** Nombre d'écritures simultanées. Borné : un établissement de plus de
 *  300 traductions ne doit jamais ouvrir 300 requêtes d'un coup. */
export const BULK_VALIDATION_CONCURRENCY = 4;
/** Rend la main à la boucle d'événements toutes les N écritures --
 *  c'est ce qui garantit que l'interface reste repeinte et cliquable
 *  pendant un traitement long (mandat §6). */
export const BULK_VALIDATION_YIELD_EVERY = 20;

const defaultYield = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Exécute les écritures avec une CONCURRENCE BORNÉE et une reprise de
 * main périodique. Générique et pur : `write` est injectée, donc la
 * politique de traitement est testable sans réseau ni DOM.
 *
 * Un échec ne fait JAMAIS échouer le lot : il est compté et rapporté
 * (même politique ligne par ligne que l'import confirmé).
 */
export async function runBulkValidation<T>(
  candidates: ReadonlyArray<T>,
  write: (candidate: T) => Promise<void>,
  options: {
    concurrency?: number;
    yieldEvery?: number;
    onProgress?: (done: number, total: number) => void;
    yieldToEventLoop?: () => Promise<void>;
  } = {}
): Promise<BulkValidationOutcome> {
  const total = candidates.length;
  const outcome: BulkValidationOutcome = { validated: 0, failed: 0, staleRejectedByServer: 0 };
  if (total === 0) return outcome;

  const concurrency = Math.max(1, Math.min(options.concurrency ?? BULK_VALIDATION_CONCURRENCY, total));
  const yieldEvery = Math.max(1, options.yieldEvery ?? BULK_VALIDATION_YIELD_EVERY);
  const yieldToEventLoop = options.yieldToEventLoop ?? defaultYield;

  let cursor = 0;
  let done = 0;
  let sinceYield = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= total) return;
      try {
        await write(candidates[index]);
        outcome.validated += 1;
      } catch (error) {
        outcome.failed += 1;
        if (isSourceChangedError(error)) outcome.staleRejectedByServer += 1;
      }
      done += 1;
      options.onProgress?.(done, total);
      sinceYield += 1;
      if (sinceYield >= yieldEvery) {
        sinceYield = 0;
        await yieldToEventLoop();
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return outcome;
}

/** Compte rendu final -- les TROIS nombres exigés par le mandat §3. */
export function bulkValidationResultMessage(
  outcome: BulkValidationOutcome,
  skippedStale: number
): string {
  const parts = [
    `${outcome.validated} traduction(s) validée(s)`,
    `${skippedStale} ignorée(s) (texte source modifié)`,
    `${outcome.failed} échec(s)`,
  ];
  let message = `${parts.join(", ")}.`;
  if (outcome.staleRejectedByServer > 0) {
    message += ` Dont ${outcome.staleRejectedByServer} refusée(s) par le serveur parce que le texte source a changé pendant la validation.`;
  }
  return message;
}
