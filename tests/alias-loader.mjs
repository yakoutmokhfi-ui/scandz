/**
 * Résolveur d'alias pour les tests.
 *
 * Next.js résout "@/..." via tsconfig ; Node ne le fait pas. Ce hook
 * traduit l'alias en chemin de fichier, sans dépendance externe et
 * sans modifier le code de production.
 *
 * PAYMENT P3-A1 (mandat §7/§39) : redirige aussi le spécificateur nu
 * "server-only" vers un stub TEST-ONLY (tests/server-only-stub.mjs).
 * Sous le vrai build Next.js, ce paquet résout correctement via la
 * condition d'export "react-server" (voir le stub pour le détail
 * complet) ; `node --test` brut n'applique jamais cette condition, et
 * l'appliquer globalement (`--conditions=react-server`) a été essayé
 * puis rejeté : cela casse la résolution de react/react-dom pour les
 * tests `.dom.test.ts` existants (26 régressions observées lors de
 * l'essai). Cette redirection reste strictement scopée au
 * spécificateur littéral "server-only" -- aucun autre module n'est
 * affecté, et ce hook n'est jamais chargé par `next build`/`next dev`.
 *
 * CUSTOMER TRACKING EXPERIENCE v2 (mandat §30, tests ciblés sur
 * app/api/track/exchange/route.ts) : redirige AUSSI le spécificateur
 * nu "next/server" vers le fichier concret node_modules/next/
 * server.js. `next` ne déclare aucune carte "exports" dans son
 * package.json -- la résolution ESM stricte de Node ne complète donc
 * jamais l'extension pour un spécificateur nu de ce type (constaté
 * empiriquement : `Cannot find module '.../next/server'`), alors que
 * Next.js lui-même résout ce chemin sans ambiguïté au build/à
 * l'exécution. Cette redirection reste, comme "server-only" ci-dessus,
 * strictement scopée au spécificateur littéral "next/server" --
 * INCHANGÉE par le lot ci-dessous, qui ne fait qu'étendre la même idée
 * à d'autres sous-chemins "next/*" jamais couverts par ce cas exact.
 *
 * PAYMENT P3-B MONETICO CHECKOUT RUNTIME v3/v4.1 (tests de routes
 * HTTP RECONCILIÉS avec CUSTOMER TRACKING EXPERIENCE v2.1 sur ce même
 * fichier -- ferme le chevauchement identifié par le rapport de
 * réconciliation de baseline) : AJOUT d'un repli GÉNÉRIQUE, scopé
 * STRICTEMENT aux spécificateurs commençant par "next/" ET NON DÉJÀ
 * couverts par le cas exact "next/server" ci-dessus (ex. tout futur
 * sous-chemin "next/..." qu'un nouveau test viendrait à importer).
 * Next.js ne déclare aucune carte "exports" dans son package.json --
 * ses sous-chemins résolvent normalement via la résolution CJS
 * historique (que `next build`/webpack reproduisent), mais PAS via la
 * résolution ESM stricte de Node (`node --test`), qui exige une
 * extension explicite pour un spécificateur sans carte "exports". Le
 * CODE DE PRODUCTION (routes app/api/.../route.ts) continue
 * d'importer "next/..." SANS extension -- la convention standard de
 * tout projet Next.js, jamais modifiée pour satisfaire ce harnais --
 * ce repli existe UNIQUEMENT pour que ce même code compile aussi sous
 * `node --test`. Le cas exact "next/server" ci-dessus reste consulté
 * EN PREMIER et n'est jamais atteint par cette branche générique
 * (comportement byte-identique pour "next/server" à celui déjà publié
 * et testé par CUSTOMER TRACKING EXPERIENCE v2.1).
 */
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return nextResolve(pathToFileURL(path.join(root, "tests/server-only-stub.mjs")).href, context);
  }
  if (specifier === "next/server") {
    return nextResolve(pathToFileURL(path.join(root, "node_modules/next/server.js")).href, context);
  }
  if (specifier.startsWith("@/")) {
    const base = path.join(root, specifier.slice(2));
    const candidate = existsSync(base) ? base : `${base}.ts`;
    return nextResolve(pathToFileURL(candidate).href, context);
  }
  if (specifier.startsWith("next/") && !specifier.endsWith(".js")) {
    try {
      return await nextResolve(specifier, context);
    } catch (err) {
      if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
      return nextResolve(`${specifier}.js`, context);
    }
  }
  return nextResolve(specifier, context);
}
