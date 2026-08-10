/**
 * Résolveur d'alias pour les tests.
 *
 * Next.js résout "@/..." via tsconfig ; Node ne le fait pas. Ce hook
 * traduit l'alias en chemin de fichier, sans dépendance externe et
 * sans modifier le code de production.
 */
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const base = path.join(root, specifier.slice(2));
    const candidate = existsSync(base) ? base : `${base}.ts`;
    return nextResolve(pathToFileURL(candidate).href, context);
  }
  return nextResolve(specifier, context);
}
