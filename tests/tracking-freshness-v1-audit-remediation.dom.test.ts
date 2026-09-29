import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym — TRACKING FRESHNESS v1 — AUDIT REMEDIATION, ROUND 2 (issue
// #11, comment `5885210667`, Chateau Margaux re-audit relayed by
// Ravel), volet COMPOSANT :
//
//   BLOCKER A REOUVERT après Round 1 (commit `bee21b2`) : le verrou
//   partagé de Round 1 (`attemptGatedRefresh`) relâchait le verrou en
//   inspectant la valeur de retour de `refresh()` pour un thenable --
//   INERTE en production réelle (`router.refresh()` y renvoie
//   toujours `void`) -- donc le verrou ne protégeait plus rien en
//   production. Contre-preuve littérale de Margaux :
//   `{"calls":2,"contract":"refresh returns void"}`. Second écart :
//   aucune protection contre un lancer (throw) synchrone.
//
//   ROUND 2 (voir components/TrackingAutoRefresh.tsx et
//   lib/tracking/refresh-lock.ts pour le mécanisme complet) : la
//   garde mono-vol revient dans TrackingAutoRefresh, gardée par le
//   VRAI `isPending` de `useTransition()`, JAMAIS par la valeur de
//   retour de `refresh()`, renforcée par une garde synchrone
//   même-tick (`busyRef`) et un `try`/`catch` À L'INTÉRIEUR du
//   callback de `startTransition`.
//
// Ce fichier vérifie les 7 scénarios OBLIGATOIRES du re-audit
// Margaux (comment `5885210667`), section [V] ci-dessous -- CHACUN
// avec `router.refresh()` renvoyant littéralement `undefined` (le
// VRAI contrat de production) comme preuve PRINCIPALE, jamais une
// promesse modélisant `refresh()` lui-même :
//   V1. `router.refresh` renvoie `void` -- et referme BLOCKER A.
//   V2. focus PUIS manuel en succession immédiate -> un seul
//       déclenchement.
//   V3. manuel PUIS minuteur -> un seul déclenchement.
//   V4. rafale focus+manuel+minuteur -> un seul déclenchement.
//   V5. un rafraîchissement SUIVANT redevient possible après le cycle
//       de vie de la garde/coalescence prévu.
//   V6. un lancer (throw) synchrone -> l'état se rétablit.
//   V7. un focus PENDANT que l'onglet est caché reste ignoré.
//
// La section [E] (héritée de Round 1, RENOMMÉE ci-dessous) reste
// utile pour vérifier le cycle de vie de coalescence de façon
// déterministe via un double de test à résolution contrôlée -- mais
// AUCUN de ces tests ne prétend, à lui seul, refermer BLOCKER A :
// c'est la section [V], au contrat `void` littéral, qui le referme.
// La section [F] (repli sans JavaScript) est inchangée.
//
// Même harnais que tests/tracking-freshness-v1.dom.test.ts (esbuild +
// JSDOM + mock de next/navigation), étendu pour monter les DEUX
// composants ensemble. Le volet BLOCKER B (app/track/[orderId]/
// page.tsx, branches d'erreur) vit dans un fichier SÉPARÉ,
// tests/tracking-freshness-v1-audit-remediation-page.dom.test.ts --
// jamais dans le même fichier qu'un harnais composant (voir ce
// fichier pour la raison, inchangée depuis Round 1).
// ====================================================================

function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  check: () => boolean,
  description: string,
  timeoutMs = 3000,
  intervalMs = 10
): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout (${timeoutMs}ms) : ${description}`);
    }
    await flush(intervalMs);
  }
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// --------------------------------------------------------------------
// Harnais COMPOSANT : TrackingAutoRefresh + TrackingManualRefreshLink
// montés ensemble, comme ils le sont réellement sur
// app/track/[orderId]/page.tsx (deux enfants directs de la même page,
// ni parent ni enfant l'un de l'autre).
// --------------------------------------------------------------------

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/track/11111111-1111-4111-8111-111111111111",
  pretendToBeVisual: true,
});
const { window } = dom;
(globalThis as any).window = window;
(globalThis as any).document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
(globalThis as any).HTMLElement = window.HTMLElement;
(globalThis as any).Event = window.Event;
(globalThis as any).MouseEvent = window.MouseEvent;
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const REPO_ROOT = process.cwd();

(globalThis as any).__mockRouterRefresh = undefined;

const MOCK_NAV = `
export function useRouter() {
  return {
    refresh: (...args) => {
      const fn = (globalThis).__mockRouterRefresh;
      return fn ? fn(...args) : undefined;
    },
    replace: () => {},
    push: () => {},
  };
}
`;

const MOCK_LINK = `
import { createElement } from "react";
export default function Link(props) {
  const { href, children, ...rest } = props;
  return createElement("a", { href, ...rest }, children);
}
`;

const mocks: Record<string, string> = {
  "next/navigation": MOCK_NAV,
  "next/link": MOCK_LINK,
};

const mockPlugin: esbuild.Plugin = {
  name: "scanym-remediation-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (mocks[args.path]) return { path: args.path, namespace: "mock" };
      if (args.path.startsWith("@/")) {
        const rel = args.path.slice(2);
        const base = path.join(REPO_ROOT, rel);
        const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p));
        return { path: candidate ?? base };
      }
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
      contents: mocks[args.path] ?? "export {};",
      loader: "ts",
    }));
  },
};

const entrySource = `
export { default as TrackingAutoRefresh } from "@/components/TrackingAutoRefresh";
export { default as TrackingManualRefreshLink } from "@/components/TrackingManualRefreshLink";
export { __resetTrackingRefreshRegistryForTests } from "@/lib/tracking/refresh-lock";
`;

const buildResult = await esbuild.build({
  stdin: { contents: entrySource, resolveDir: REPO_ROOT, loader: "tsx" },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  target: "es2022",
  plugins: [mockPlugin],
  external: ["react", "react-dom", "react-dom/client"],
});
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-dom-trackfresh-remediation-"));
const tmpFile = path.join(tmpDir, "components.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const { TrackingAutoRefresh, TrackingManualRefreshLink, __resetTrackingRefreshRegistryForTests } = await import(
  pathToFileURL(tmpFile).href
);
rmSync(tmpDir, { recursive: true, force: true });

const CLEAN_HREF = "/track/11111111-1111-4111-8111-111111111111";
const REFRESH_LABEL = "Actualiser le suivi";

function renderBoth(props: { enabled: boolean; intervalMs?: number }) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(TrackingAutoRefresh, props),
      React.createElement(TrackingManualRefreshLink, { href: CLEAN_HREF, label: REFRESH_LABEL })
    )
  );
  return { container, root };
}

/**
 * ROUND 4 : renvoie désormais `event.defaultPrevented` -- les
 * appelants PRÉ-Round-4 ignorent simplement cette valeur de retour
 * (aucun n'est modifié par ce changement), tandis que les nouveaux
 * scénarios [T1]-[T5] Round 4 ci-dessous l'utilisent pour vérifier
 * QUAND la navigation par défaut est empêchée -- exactement le
 * comportement qui vient de devenir CONDITIONNEL dans
 * `TrackingManualRefreshLink.tsx`.
 */
function clickManualLink(container: Element): boolean {
  const anchor = container.querySelector("a")!;
  assert.ok(anchor, "le lien de rafraîchissement manuel doit être rendu");
  const event = new window.MouseEvent("click", { bubbles: true, cancelable: true });
  anchor.dispatchEvent(event);
  return event.defaultPrevented;
}

/**
 * Attend que le montage soit RÉELLEMENT prêt pour un test de rafale
 * SYNCHRONE (écouteur `focus` attaché, déclencheur enregistré) via un
 * signal OBSERVABLE (un premier déclenchement réussi), plutôt qu'un
 * simple délai fixe -- un `flush(20)` s'est révélé occasionnellement
 * insuffisant sous charge (JSDOM/esbuild à froid pour le tout premier
 * test du fichier), ce qui est un artefact du HARNAIS de test, pas du
 * mécanisme lui-même : sans ce signal, un test de rafale lirait
 * parfois `callCount === 0` au lieu de `1` juste parce que les
 * gestionnaires n'étaient pas encore attachés au moment du
 * déclenchement, jamais parce que la garde aurait laissé passer deux
 * appels. Laisse ensuite le cycle `isPending` de ce déclenchement de
 * réchauffement se refermer avant de renvoyer `callCount`, pour que
 * la rafale du test lui-même parte d'un état propre (`busyRef`
 * relâché).
 */
async function waitForMountReady(getCallCount: () => number): Promise<number> {
  const before = getCallCount();
  window.dispatchEvent(new window.Event("focus"));
  // Marge généreuse (8s, contre les 3s par défaut de `waitFor`) :
  // purement défensif contre une machine de CI chargée/contendue --
  // le mécanisme lui-même répond en pratique en quelques
  // millisecondes (voir TrackingAutoRefresh.tsx), jamais des
  // secondes ; une régression réelle finirait donc encore par faire
  // expirer ce délai, seulement plus tard.
  await waitFor(() => getCallCount() > before, "montage prêt : le déclenchement de réchauffement (focus) doit réussir avant le test de rafale", 8000, 20);
  await flush(50);
  return getCallCount();
}

// ====================================================================
// [V] SCÉNARIOS OBLIGATOIRES DU RE-AUDIT MARGAUX (comment
//     `5885210667`) -- contrat `void` LITTÉRAL (`router.refresh()`
//     renvoie `undefined`, JAMAIS une promesse) : c'est CETTE section
//     qui referme BLOCKER A.
// ====================================================================

test("[V1] BLOCKER A (contrat void) : deux déclenchements SYNCHRONES (focus + clic manuel, sans attente entre eux) sur un `router.refresh()` qui renvoie littéralement `undefined` ne produisent qu'UN SEUL appel -- réfute directement la contre-preuve Round 1 ({\"calls\":2,\"contract\":\"refresh returns void\"})", async () => {
  __resetTrackingRefreshRegistryForTests();
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return undefined; // le VRAI contrat de production -- jamais une promesse ici.
  };

  const { container, root } = renderBoth({ enabled: true, intervalMs: 5000 });
  try {
    await flush(20);
    const baseline = await waitForMountReady(() => callCount);

    // Déclenchement SYNCHRONE : focus puis clic manuel dans la MÊME
    // exécution de script, sans `await` entre les deux -- exactement
    // le cas que le verrou Round 1 (relâchement basé sur la valeur de
    // retour de `refresh()`) échouait à protéger : avec un `refresh`
    // renvoyant `void`, Round 1 relâchait son verrou immédiatement
    // après le PREMIER appel, laissant passer le second.
    window.dispatchEvent(new window.Event("focus"));
    clickManualLink(container);

    // Lu immédiatement, AVANT tout flush -- si le second déclenchement
    // avait été accepté de façon synchrone, callCount serait déjà
    // baseline + 2 ici.
    assert.equal(callCount, baseline + 1, "un seul appel synchrone -- la garde même-tick (busyRef) a bloqué le second déclenchement AVANT tout appel à startTransition");

    await flush(30);
    assert.equal(callCount, baseline + 1, "toujours un seul appel après un court délai -- aucun empilement différé non plus");

    // Un déclenchement SUIVANT, après que le cycle isPending du
    // premier se soit refermé, doit réussir normalement -- le verrou
    // ne reste pas bloqué indéfiniment (contrat void : la garde se
    // relâche même sans jamais observer de promesse).
    window.dispatchEvent(new window.Event("focus"));
    await waitFor(() => callCount === baseline + 2, "un déclenchement après le cycle du premier doit réussir normalement");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[V2] focus PUIS clic manuel en succession immédiate (contrat void) -> un seul déclenchement", async () => {
  __resetTrackingRefreshRegistryForTests();
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return undefined;
  };

  const { container, root } = renderBoth({ enabled: true, intervalMs: 5000 });
  try {
    await flush(20);
    const baseline = await waitForMountReady(() => callCount);

    window.dispatchEvent(new window.Event("focus"));
    clickManualLink(container);

    assert.equal(callCount, baseline + 1, "focus puis clic manuel immédiat -> un seul appel");
    await flush(30);
    assert.equal(callCount, baseline + 1, "toujours un seul appel");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[V3] clic manuel PUIS tic(s) de minuteur pendant que le premier reste en attente -> un seul déclenchement (fenêtre déterministe, voir note ci-dessous)", async () => {
  __resetTrackingRefreshRegistryForTests();
  let callCount = 0;
  const deferred = createDeferred<void>();
  // NOTE : une fenêtre "en attente" pilotée par un double de test
  // (comme [E1]-[E4]) est nécessaire ici pour observer de façon
  // FIABLE un tic de minuteur atterrissant PENDANT le cycle
  // `isPending` -- ce dernier, au contrat `void` réel, ne dure que
  // quelques millisecondes (voir [V1]/[V2] ci-dessus, qui prouvent le
  // contrat `void` littéral lui-même sur une paire SYNCHRONE) ; faire
  // coïncider un `setInterval` réel avec une fenêtre de 2ms serait
  // intrinsèquement instable. Le MÉCANISME observé (garde
  // `busyRef`/`isPending`) reste rigoureusement le même dans les deux
  // cas -- seule la DURÉE de la fenêtre est contrôlée pour que ce
  // test soit déterministe plutôt que dépendant du minutage réel du
  // moteur JS.
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return deferred.promise;
  };

  const { container, root } = renderBoth({ enabled: true, intervalMs: 30 });
  try {
    await flush(20);

    clickManualLink(container);
    await waitFor(() => callCount === 1, "le clic manuel doit déclencher un premier rafraîchissement");

    // Laisse largement le temps à au moins deux tics du minuteur
    // (30ms) de se produire pendant que le rafraîchissement manuel
    // reste en attente -- aucun ne doit s'empiler.
    await flush(90);
    assert.equal(callCount, 1, "aucun tic de minuteur ne s'empile pendant un rafraîchissement manuel en attente");

    deferred.resolve();
    await waitFor(() => callCount === 2, "le prochain tic APRÈS résolution doit déclencher normalement", 3000, 10);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[V4] rafale focus + clic manuel SYNCHRONES (contrat void), PUIS un VRAI tic de minuteur atterrissant pendant que ce cycle est encore en attente -> un seul déclenchement sur toute la fenêtre", async () => {
  __resetTrackingRefreshRegistryForTests();
  let callCount = 0;
  const deferred = createDeferred<void>();
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return deferred.promise;
  };

  // Cadence de minuteur choisie pour atterrir PENDANT la fenêtre
  // "en attente" (contrôlée par `deferred` ci-dessus, donc aussi
  // longue que nécessaire pour que ce test reste déterministe) --
  // mais assez longue pour ne JAMAIS tiquer pendant le
  // `flush(20)` de stabilisation du montage ci-dessous (20ms < 150ms).
  const { container, root } = renderBoth({ enabled: true, intervalMs: 150 });
  try {
    await flush(20);

    // Rafale SYNCHRONE : focus puis clic manuel dans la MÊME
    // exécution de script, sans `await` entre les deux -- exactement
    // le cas que [V1]/[V2] prouvent déjà au contrat `void` réel. Ici,
    // le PREMIER rafraîchissement qu'ils déclenchent ensemble reste
    // délibérément en attente (`deferred`), pour qu'un troisième
    // déclencheur -- un VRAI tic de `setInterval`, une vraie
    // macro-tâche, jamais simulé -- puisse atterrir PENDANT cette
    // même fenêtre et être observé comme ignoré lui aussi.
    window.dispatchEvent(new window.Event("focus"));
    clickManualLink(container);
    assert.equal(callCount, 1, "focus+manuel synchrones -> un seul appel avant tout tic de minuteur");

    // Le tic de minuteur (150ms) atterrit ici, PENDANT que le premier
    // rafraîchissement (focus+manuel) reste en attente -- doit être
    // ignoré, comme tout déclencheur pendant un cycle en cours.
    await flush(220);
    assert.equal(callCount, 1, "le tic de minuteur qui atterrit pendant la fenêtre en attente est ignoré -- un seul appel au total pour focus+manuel+minuteur");

    // Le mécanisme se rétablit normalement une fois le cycle refermé.
    deferred.resolve();
    window.dispatchEvent(new window.Event("focus"));
    await waitFor(() => callCount === 2, "un déclenchement après résolution doit réussir normalement");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[V5] un rafraîchissement SUIVANT redevient possible après le cycle de garde/coalescence complet, de façon répétée", async () => {
  __resetTrackingRefreshRegistryForTests();
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return undefined;
  };

  const { container, root } = renderBoth({ enabled: true, intervalMs: 5000 });
  try {
    await flush(20);

    for (let i = 1; i <= 3; i++) {
      clickManualLink(container);
      await waitFor(() => callCount === i, `déclenchement #${i} doit réussir après que le précédent se soit refermé`);
      // Un second déclenchement immédiat (même tick) pendant que
      // celui-ci referme son propre cycle est ignoré -- vérifie que
      // CHAQUE cycle, pas seulement le premier, protège correctement.
      clickManualLink(container);
      await flush(15);
    }
    assert.equal(callCount, 3, "trois cycles complets, chacun suivi d'un déclenchement immédiat ignoré -- jamais d'empilement, jamais de blocage permanent");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[V6] un lancer (throw) SYNCHRONE dans `router.refresh()` -- l'état se rétablit, jamais de verrou permanent", async () => {
  __resetTrackingRefreshRegistryForTests();
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    if (callCount === 1) {
      throw new Error("boom -- erreur synchrone simulée (ex. mauvais état interne du routeur)");
    }
    return undefined;
  };

  const { container, root } = renderBoth({ enabled: true, intervalMs: 5000 });
  try {
    await flush(20);

    // Ne doit PAS faire remonter l'exception jusqu'au test -- le
    // `try`/`catch` À L'INTÉRIEUR du callback de `startTransition`
    // (voir TrackingAutoRefresh.tsx) l'avale avant qu'elle ne puisse
    // s'échapper.
    assert.doesNotThrow(() => {
      clickManualLink(container);
    }, "un clic déclenchant un router.refresh() qui lance de façon synchrone ne doit jamais faire remonter l'exception jusqu'à l'appelant");

    assert.equal(callCount, 1, "le premier appel a bien eu lieu (et a lancé)");

    // Second déclenchement immédiat (même tick) : ignoré, comme tout
    // déclenchement pendant qu'un cycle est encore en cours -- MÊME
    // quand ce cycle va se terminer par une exception.
    clickManualLink(container);
    assert.equal(callCount, 1, "un déclenchement immédiat pendant le cycle qui vient de lancer est ignoré, pas empilé");

    // Le mécanisme doit se rétablir : un déclenchement SUIVANT, une
    // fois le cycle refermé, doit réussir normalement -- jamais de
    // verrou bloqué indéfiniment après une exception synchrone.
    //
    // `callCount >= 1` est déjà vrai à cet instant (le premier appel a
    // eu lieu ci-dessus) -- un `waitFor` sur cette seule condition
    // reviendrait donc IMMÉDIATEMENT, sans laisser à l'effet
    // `isPending -> busyRef.current = false` (TrackingAutoRefresh.tsx)
    // la moindre chance de s'exécuter, et ferait à tort ressembler un
    // troisième clic ENCORE prématuré (donc légitimement ignoré) à un
    // verrou resté bloqué. Un court délai RÉEL, laissant le cycle
    // `isPending` du premier clic se refermer authentiquement (il se
    // referme en quelques millisecondes au contrat `void`, voir
    // [V1]), est ce qui rend ce test significatif.
    await flush(50);
    clickManualLink(container);
    await waitFor(() => callCount === 2, "un déclenchement après une exception synchrone doit réussir -- le mécanisme n'est pas resté bloqué");
  } finally {
    root.unmount();
    container.remove();
  }
});

// ====================================================================
// [E] Cycle de vie de coalescence -- double de test à résolution
//     CONTRÔLÉE (hérité de Round 1). AUCUN de ces tests ne referme,
//     à lui seul, BLOCKER A (voir section [V] ci-dessus pour la
//     preuve au contrat void littéral) -- ils vérifient que le cycle
//     de garde, une fois observé à travers un `isPending` dont la
//     résolution est entièrement pilotée par le test, se comporte
//     comme attendu sur toute sa durée (et pas seulement à l'instant
//     de l'appel synchrone à `refresh()`).
// ====================================================================

test("[E1] un clic manuel PENDANT un rafraîchissement déclenché par le FOCUS (en attente) est ignoré -- jamais empilé", async () => {
  __resetTrackingRefreshRegistryForTests();
  let callCount = 0;
  const deferred = createDeferred<void>();
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return deferred.promise;
  };

  const { container, root } = renderBoth({ enabled: true, intervalMs: 5000 });
  try {
    await flush(20);

    window.dispatchEvent(new window.Event("focus"));
    await waitFor(() => callCount === 1, "le focus doit déclencher un premier rafraîchissement");

    clickManualLink(container);
    await flush(40);
    assert.equal(callCount, 1, "le clic manuel pendant un rafraîchissement de focus en attente est ignoré");

    deferred.resolve();
    await flush(20);

    clickManualLink(container);
    await waitFor(() => callCount === 2, "un clic manuel APRÈS résolution doit déclencher normalement");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[E2] un tic de minuteur PENDANT un rafraîchissement MANUEL (en attente) est ignoré -- jamais empilé", async () => {
  __resetTrackingRefreshRegistryForTests();
  let callCount = 0;
  const deferred = createDeferred<void>();
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return deferred.promise;
  };

  const { container, root } = renderBoth({ enabled: true, intervalMs: 30 });
  try {
    await flush(20);

    clickManualLink(container);
    await waitFor(() => callCount === 1, "le clic manuel doit déclencher un premier rafraîchissement");

    // Laisse largement le temps à au moins deux tics du minuteur
    // (30ms) de se produire pendant que le rafraîchissement manuel
    // reste en attente -- aucun ne doit s'empiler.
    await flush(90);
    assert.equal(callCount, 1, "aucun tic de minuteur ne s'empile pendant un rafraîchissement manuel en attente");

    deferred.resolve();
    await waitFor(() => callCount === 2, "le prochain tic APRÈS résolution doit déclencher normalement", 3000, 10);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[E3] un focus PENDANT un rafraîchissement de MINUTEUR (en attente) est ignoré -- jamais empilé", async () => {
  __resetTrackingRefreshRegistryForTests();
  let callCount = 0;
  const deferred = createDeferred<void>();
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return deferred.promise;
  };

  const { container, root } = renderBoth({ enabled: true, intervalMs: 5000 });
  try {
    await flush(20);

    window.dispatchEvent(new window.Event("focus"));
    await waitFor(() => callCount === 1, "premier focus");

    window.dispatchEvent(new window.Event("focus"));
    clickManualLink(container);
    await flush(40);
    assert.equal(callCount, 1, "un second focus ET un clic manuel pendant un rafraîchissement en attente sont TOUS deux ignorés");

    deferred.resolve();
    await flush(20);
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[E4] le verrou se relâche après un ÉCHEC réseau (promesse rejetée), pas seulement après un succès", async () => {
  __resetTrackingRefreshRegistryForTests();
  let callCount = 0;
  const deferred = createDeferred<void>();
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return deferred.promise;
  };

  const { container, root } = renderBoth({ enabled: true, intervalMs: 5000 });
  try {
    await flush(20);

    clickManualLink(container);
    await waitFor(() => callCount === 1, "premier clic manuel");

    // Second déclenchement (focus) pendant que le premier reste en
    // attente : ignoré, comme attendu.
    window.dispatchEvent(new window.Event("focus"));
    await flush(30);
    assert.equal(callCount, 1, "précondition : toujours un seul appel avant l'échec");

    // Le rafraîchissement en attente ÉCHOUE (réseau, timeout, 5xx...).
    deferred.reject(new Error("network error (simulated)"));
    await flush(20);

    // Le verrou doit être relâché malgré l'échec -- un déclenchement
    // SUIVANT doit fonctionner normalement, pas rester bloqué
    // indéfiniment.
    window.dispatchEvent(new window.Event("focus"));
    await waitFor(() => callCount === 2, "un déclenchement après un échec réseau doit réussir -- le verrou n'est pas resté bloqué");
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------
// [F] BLOCKER A (complément) — repli sans JavaScript intact.
// --------------------------------------------------------------

test("[F] TrackingManualRefreshLink rend un <a href> valide (repli sans JavaScript, mandat §19) avec le libellé accessible attendu", async () => {
  __resetTrackingRefreshRegistryForTests();
  const { container, root } = renderBoth({ enabled: false });
  try {
    await flush(20);
    const anchor = container.querySelector("a")!;
    assert.equal(anchor.getAttribute("href"), CLEAN_HREF, "href identique au chemin propre fourni -- une navigation SANS JS fonctionnerait");
    assert.equal(anchor.getAttribute("aria-label"), REFRESH_LABEL);
    assert.equal(anchor.textContent?.includes(REFRESH_LABEL), true, "libellé visible, pas seulement le symbole ⟳ seul (mandat §24)");
  } finally {
    root.unmount();
    container.remove();
  }
});

// --------------------------------------------------------------
// [V7] BLOCKER A (relevé par l'audit) — focus pendant onglet caché.
// --------------------------------------------------------------

test("[V7] un retour de focus PENDANT que l'onglet est marqué caché ne déclenche AUCUNE requête réseau", async () => {
  __resetTrackingRefreshRegistryForTests();
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return undefined;
  };
  Object.defineProperty(window.document, "visibilityState", { value: "hidden", configurable: true });

  const { container, root } = renderBoth({ enabled: true, intervalMs: 5000 });
  try {
    await flush(20);

    window.dispatchEvent(new window.Event("focus"));
    await flush(40);
    assert.equal(callCount, 0, "un focus pendant que l'onglet est caché ne doit déclencher aucun rafraîchissement");

    Object.defineProperty(window.document, "visibilityState", { value: "visible", configurable: true });
    window.dispatchEvent(new window.Event("focus"));
    await waitFor(() => callCount === 1, "le focus redevient opérant dès que l'onglet redevient visible");
  } finally {
    Object.defineProperty(window.document, "visibilityState", { value: "visible", configurable: true });
    root.unmount();
    container.remove();
  }
});

// ====================================================================
// [T] ROUND 4 (issue #11, Ravel relayant Château Margaux -- régression
//     repli manuel en STATUT DE COMMANDE terminal) -- scénarios
//     OBLIGATOIRES T1-T7 du document de remédiation Round 4.
//
//     `app/track/[orderId]/page.tsx` calcule `enabled={!terminal}` sur
//     `<TrackingAutoRefresh>`, où `terminal = isTerminalStatus(tracking.
//     orderStatus)` est VRAI pour EXACTEMENT les trois statuts
//     `completed`/`rejected`/`cancelled` (lib/tracking/status.ts) -- les
//     trois se traduisent donc, au niveau de CE composant, par
//     EXACTEMENT le même `enabled={false}` : aucune notion de statut de
//     commande n'existe à l'intérieur de `TrackingAutoRefresh`/
//     `TrackingManualRefreshLink` eux-mêmes (voir leurs commentaires de
//     tête respectifs). T1/T2/T3 exercent donc, chacun explicitement
//     nommé et tracé au document de remédiation, le MÊME comportement
//     `enabled={false}` -- refaire descendre un vrai statut de commande
//     jusqu'à ce niveau nécessiterait de reconstruire l'intégralité de
//     la chaîne de mocks du chemin de succès de page.tsx (getOrderTracking
//     + contexte client + overrides de texte + options de retrait), une
//     expansion que ce round exclut explicitement ("Fix this minimally").
//     Rien ici ne remplace [H1]/[H6] (volet PAGE, fichier séparé), qui
//     vérifient déjà QUELLES branches montent quels composants.
// ====================================================================

test("[T1] statut de commande TERMINAL (completed) : lien manuel présent, clic NE PAS empêcher la navigation par défaut, aucun rafraîchissement déclenché", async () => {
  __resetTrackingRefreshRegistryForTests();
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return undefined;
  };

  // `enabled={false}` == exactement ce que page.tsx passe à
  // `TrackingAutoRefresh` quand `tracking.orderStatus === "completed"`.
  const { container, root } = renderBoth({ enabled: false });
  try {
    await flush(20);
    const anchor = container.querySelector("a")!;
    assert.ok(anchor, "le lien de rafraîchissement manuel doit rester rendu en statut terminal");
    assert.equal(anchor.getAttribute("href"), CLEAN_HREF, "le href réel doit rester intact -- c'est lui qui doit porter la navigation");

    const prevented = clickManualLink(container);
    assert.equal(prevented, false, "aucun déclencheur canonique enregistré en statut terminal -- preventDefault() ne doit PAS être appelé, pour laisser la navigation normale suivre le href réel");
    await flush(30);
    assert.equal(callCount, 0, "aucun rafraîchissement ne doit être déclenché -- aucun déclencheur n'est enregistré en statut terminal");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[T2] statut de commande TERMINAL (rejected) : même comportement attendu que T1", async () => {
  __resetTrackingRefreshRegistryForTests();
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return undefined;
  };

  const { container, root } = renderBoth({ enabled: false });
  try {
    await flush(20);
    const prevented = clickManualLink(container);
    assert.equal(prevented, false, "rejected -- comme completed, aucun déclencheur enregistré -- preventDefault() ne doit PAS être appelé");
    await flush(30);
    assert.equal(callCount, 0, "rejected -- aucun rafraîchissement déclenché");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[T3] statut de commande TERMINAL (cancelled) : même comportement attendu que T1/T2", async () => {
  __resetTrackingRefreshRegistryForTests();
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return undefined;
  };

  const { container, root } = renderBoth({ enabled: false });
  try {
    await flush(20);
    const prevented = clickManualLink(container);
    assert.equal(prevented, false, "cancelled -- comme completed/rejected, aucun déclencheur enregistré -- preventDefault() ne doit PAS être appelé");
    await flush(30);
    assert.equal(callCount, 0, "cancelled -- aucun rafraîchissement déclenché");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[T4] statut ACTIF : clic manuel intercepté, navigation par défaut empêchée, rafraîchissement canonique déclenché exactement une fois", async () => {
  __resetTrackingRefreshRegistryForTests();
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return undefined;
  };

  const { container, root } = renderBoth({ enabled: true, intervalMs: 5000 });
  try {
    await flush(20);
    await waitForMountReady(() => callCount);

    const before = callCount;
    const prevented = clickManualLink(container);
    assert.equal(prevented, true, "statut actif -- un déclencheur canonique EST enregistré -- preventDefault() DOIT être appelé");
    await waitFor(() => callCount === before + 1, "le rafraîchissement canonique doit être déclenché exactement une fois");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[T5] ERREUR SERVEUR TRANSITOIRE (AutoRefresh de récupération lente enregistré) : clic manuel intercepté, rafraîchissement canonique déclenché exactement une fois, jamais de navigation normale", async () => {
  __resetTrackingRefreshRegistryForTests();
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return undefined;
  };

  // `intervalMs: 20_000` reproduit la cadence de récupération LENTE de
  // la branche d'erreur transitoire de page.tsx
  // (TRACKING_ERROR_RECOVERY_INTERVAL_MS) -- ce composant lui-même ne
  // distingue pas "actif" d'"erreur transitoire" (les deux sont
  // `enabled={true}`, seule la cadence diffère) ; le câblage page-level
  // réel de cette branche est déjà vérifié indépendamment par
  // [H2]-[H4] (fichier -page.dom.test.ts).
  const { container, root } = renderBoth({ enabled: true, intervalMs: 20_000 });
  try {
    await flush(20);
    const anchorHrefBefore = container.querySelector("a")!.getAttribute("href");

    const prevented = clickManualLink(container);
    assert.equal(prevented, true, "un déclencheur canonique EST enregistré (récupération lente) -- preventDefault() DOIT être appelé, jamais de repli sur la navigation normale");
    await waitFor(() => callCount === 1, "le rafraîchissement canonique doit être déclenché exactement une fois");
    assert.equal(container.querySelector("a")!.getAttribute("href"), anchorHrefBefore, "le href réel reste intact -- il n'a simplement pas été suivi, le composant a pris le relais");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[T6] contrat SANS JavaScript préservé (statut terminal) : href réel, libellé visible, aria-label -- une navigation normale fonctionnerait", async () => {
  // Complète [F] ci-dessus (déjà vérifié en `enabled: false`, jamais
  // affaibli par ce round) -- ici comme scénario EXPLICITEMENT tracé
  // au document de remédiation Round 4 (T6).
  __resetTrackingRefreshRegistryForTests();
  const { container, root } = renderBoth({ enabled: false });
  try {
    await flush(20);
    const anchor = container.querySelector("a")!;
    assert.equal(anchor.getAttribute("href"), CLEAN_HREF, "href réel intact");
    assert.equal(anchor.getAttribute("aria-label"), REFRESH_LABEL, "aria-label intact");
    assert.equal(anchor.textContent?.includes(REFRESH_LABEL), true, "libellé visible intact, pas seulement le symbole ⟳");
  } finally {
    root.unmount();
    container.remove();
  }
});

test("[T7] NON-RÉGRESSION : le scénario actif même-tick (rafale focus+manuel, contrat void littéral) reste vert après le correctif Round 4", async () => {
  // Ne remplace ni n'affaiblit [V1]-[V7]/[E1]-[E4] ci-dessus (tous
  // INCHANGÉS par ce round) -- répète explicitement l'un d'eux, nommé
  // et tracé au document de remédiation Round 4 (T7 : "at least one
  // existing active-state same-tick / in-flight scenario must remain
  // green").
  __resetTrackingRefreshRegistryForTests();
  let callCount = 0;
  (globalThis as any).__mockRouterRefresh = () => {
    callCount++;
    return undefined;
  };

  const { container, root } = renderBoth({ enabled: true, intervalMs: 5000 });
  try {
    await flush(20);
    const baseline = await waitForMountReady(() => callCount);

    window.dispatchEvent(new window.Event("focus"));
    clickManualLink(container);
    assert.equal(callCount, baseline + 1, "focus + clic manuel synchrones -- toujours un seul appel après le correctif Round 4");

    await flush(30);
    assert.equal(callCount, baseline + 1, "toujours un seul appel après un court délai");
  } finally {
    root.unmount();
    container.remove();
  }
});

after(async () => {
  await new Promise((r) => setTimeout(r, 50));
  window.close();
  await esbuild.stop();
  // ROUND 2 (re-audit Margaux, comment `5885210667`) : un `unref()`
  // AVEUGLE de TOUTE poignée active masquerait une vraie fuite créée
  // par ce harnais (ex. un `setInterval` de TrackingAutoRefresh mal
  // nettoyé) exactement aussi silencieusement qu'il masque la
  // poignée `MessagePort` bénigne du planificateur de React (créée
  // paresseusement dès que `useTransition`/`startTransition` effectue
  // un vrai travail sous Node/JSDOM, sans rapport avec ce fichier).
  // On ne relâche donc QUE les poignées dont le CONSTRUCTEUR est
  // reconnu comme provenant de ce mécanisme connu et inoffensif --
  // toute autre poignée active reste NON relâchée, pour que ce
  // fichier de test continue de bloquer le processus (donc de
  // signaler le problème) si un futur changement introduit une vraie
  // fuite ailleurs.
  for (const h of (process as any)._getActiveHandles?.() ?? []) {
    const ctorName = h?.constructor?.name;
    if (ctorName === "MessagePort" && typeof h.unref === "function") {
      h.unref();
    }
  }
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  delete (globalThis as any).navigator;
  delete (globalThis as any).HTMLElement;
  delete (globalThis as any).Event;
  delete (globalThis as any).MouseEvent;
  delete (globalThis as any).requestAnimationFrame;
  delete (globalThis as any).cancelAnimationFrame;
  delete (globalThis as any).__mockRouterRefresh;
});
