/**
 * ATTENTE DÉTERMINISTE DES SUITES DOM — remédiation F-03.
 *
 * LE DÉFAUT QU'ELLE CORRIGE
 * -------------------------
 * Les suites DOM attendaient la page par un DÉLAI FIXE
 * (`setTimeout(resolve, 90)`). C'est un pari sur la vitesse de la
 * machine : sous charge -- dix suites jsdom lancées en parallèle par le
 * lanceur de tests, chacune compilant puis rendant une page de 2 400
 * lignes -- le rendu et les effets de la page ne tiennent plus dans
 * 90 ms, et un test observe une page encore vide. Symptôme rapporté par
 * l'audit : `[BO1-A11Y-1]` voit ZÉRO champ de formulaire quand les
 * suites tournent ensemble, et 10/10 quand elle tourne seule.
 *
 * Ce n'est pas une interférence d'état entre suites : le lanceur
 * exécute chaque fichier dans son propre processus (aucun `window`, aucun
 * mock, aucun fichier temporaire n'est partagé -- les dossiers
 * temporaires sont créés par `mkdtemp`, donc uniques). C'est la
 * dépendance au TEMPS MUR. Reproduction : `--test-concurrency=10` fait
 * échouer des dizaines de tests de la candidate R1 sur une machine à
 * deux cœurs, et plus aucun avec cette attente.
 *
 * LA RÈGLE
 * --------
 * On n'attend jamais une DURÉE, on attend une QUIESCENCE : tant que le
 * moteur de rendu ou la page ont du travail planifié (un `setImmediate`
 * de l'ordonnanceur de React, un minuteur court), la page n'est pas
 * stable. Les doubles d'E/S des suites ne rendent leurs réponses que par
 * des promesses (microtâches), qui se vident à chaque tour : quand rien
 * n'est plus planifié pendant plusieurs tours consécutifs, plus rien ne
 * peut changer. Le résultat ne dépend pas de la charge machine : la
 * charge ralentit les tours, elle n'en change ni le nombre ni l'ordre.
 *
 * Ce module DOIT être importé AVANT `react-dom` : l'ordonnanceur de React
 * capture `setImmediate` à son chargement. Un import statique en tête de
 * fichier suffit, car les imports statiques s'évaluent avant le corps.
 */

const realSetImmediate = globalThis.setImmediate.bind(globalThis);
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);

let pendingImmediates = 0;
const pendingTimers = new Set<unknown>();

/** Minuteurs plus longs que ça ne sont pas du « travail de rendu ». */
const SHORT_TIMER_MS = 1000;

const globals = globalThis as unknown as Record<string, unknown> & {
  __domSettleInstalled?: boolean;
};

if (!globals.__domSettleInstalled) {
  globals.__domSettleInstalled = true;

  globals.setImmediate = ((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
    pendingImmediates += 1;
    return realSetImmediate((...inner: unknown[]) => {
      pendingImmediates -= 1;
      callback(...inner);
    }, ...(args as []));
  }) as unknown as typeof setImmediate;

  globals.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    const handle: unknown = realSetTimeout(
      (...inner: unknown[]) => {
        pendingTimers.delete(handle);
        callback(...inner);
      },
      delay,
      ...(args as [])
    );
    if ((delay ?? 0) <= SHORT_TIMER_MS) pendingTimers.add(handle);
    return handle;
  }) as unknown as typeof setTimeout;

  globals.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    pendingTimers.delete(handle);
    realClearTimeout(handle);
  }) as unknown as typeof clearTimeout;
}

/** Nombre de tours consécutifs sans aucun travail planifié, pour conclure. */
const QUIET_TURNS = 4;
/** Garde-fou : une page qui ne se stabilise jamais est un défaut, pas une attente. */
const MAX_TURNS = 50_000;

/**
 * Rend la main jusqu'à ce que la page soit STABLE : plus aucun travail de
 * rendu planifié pendant `QUIET_TURNS` tours consécutifs. Le paramètre
 * `ms` n'existe que pour garder la signature des anciens appels
 * (`flush(150)`) : il est IGNORÉ -- aucune durée n'est jamais attendue.
 */
export async function settle(_ms?: number): Promise<void> {
  let quiet = 0;
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    await new Promise<void>((resolve) => realSetImmediate(resolve));
    quiet = pendingImmediates === 0 && pendingTimers.size === 0 ? quiet + 1 : 0;
    if (quiet >= QUIET_TURNS) return;
  }
  throw new Error("settle : la page ne se stabilise pas (travail planifié sans fin)");
}

/**
 * Attend qu'une condition devienne vraie, en laissant la page se
 * stabiliser entre deux vérifications. Pour les cas où l'on sait CE qu'on
 * attend : échoue avec un message qui nomme la condition, au lieu de
 * laisser l'assertion suivante échouer de façon obscure.
 */
export async function waitFor(
  condition: () => unknown,
  description: string,
  attempts = 200
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (condition()) return;
    await settle();
  }
  throw new Error(`waitFor : condition jamais atteinte — ${description}`);
}
