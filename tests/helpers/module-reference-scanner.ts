import ts from "typescript";
import { readFileSync } from "node:fs";

/**
 * DELIVERY STREAM C — STUART SANDBOX INTEGRATION v2.6.3
 * (ferme STUART-V262-ALLOWLIST-SYNTAX-01, MEDIUM).
 *
 * DÉFAUT CORRIGÉ : l'invariant structurel P3-A1 n'énumérait les
 * imports que via une expression régulière ciblant la forme
 * `from "@/lib/server/..."` -- Work a démontré que cette règle
 * PASSAIT malgré l'ajout d'imports interdits sous forme d'import à
 * effet de bord (`import "module"`), d'import dynamique
 * (`import("module")`), ou de `require("module")`.
 *
 * CORRECTIF : énumération BASÉE SUR L'AST réel du compilateur
 * TypeScript (déjà une dépendance du projet, AUCUNE nouvelle
 * dépendance ajoutée) -- couvre EXHAUSTIVEMENT :
 * 1. import par défaut statique (`import x from "module"`)
 * 2. import nommé statique (`import { x } from "module"`)
 * 3. import d'espace de noms (`import * as x from "module"`)
 * 4. import à effet de bord (`import "module"`)
 * 5. import dynamique (`import("module")`)
 * 6. `require("module")` (CommonJS)
 * 7. ré-export (`export { x } from "module"`, `export * from "module"`)
 *
 * Seuls les spécificateurs de module LITTÉRAUX (chaînes constantes)
 * sont énumérés -- toute référence de module NON LITTÉRALE (construite
 * dynamiquement, ex. `import(someVariable)`) est signalée
 * explicitement via `hasNonLiteralModuleReference: true`, jamais
 * silencieusement ignorée (mandat : "fail closed or explicitly
 * justify"). Le harnais appelant DOIT traiter cette valeur comme un
 * échec si elle est vraie pour un fichier restreint.
 */

export interface ModuleReferenceScanResult {
  /** Tous les spécificateurs de module littéraux trouvés, quelle que
   *  soit la syntaxe d'import/require/export utilisée. */
  references: string[];
  /** true si une référence de module NON littérale a été rencontrée
   *  (ex. `import(expr)` où `expr` n'est pas une chaîne constante) --
   *  le harnais appelant DOIT échouer fermé dans ce cas pour un
   *  fichier restreint, jamais l'ignorer. */
  hasNonLiteralModuleReference: boolean;
}

export function scanModuleReferences(filePath: string): ModuleReferenceScanResult {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  const references: string[] = [];
  let hasNonLiteralModuleReference = false;

  function addIfLiteral(expr: ts.Expression | undefined): void {
    if (!expr) return;
    if (ts.isStringLiteralLike(expr)) {
      references.push(expr.text);
    } else {
      hasNonLiteralModuleReference = true;
    }
  }

  function visit(node: ts.Node): void {
    // 1/2/3/4 -- import ... from "module" (par défaut/nommé/espace de
    // noms/effet de bord partagent tous ImportDeclaration.moduleSpecifier).
    if (ts.isImportDeclaration(node)) {
      addIfLiteral(node.moduleSpecifier);
    }
    // 6 -- ré-export : export { x } from "module" / export * from "module".
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      addIfLiteral(node.moduleSpecifier);
    }
    // 5 -- import dynamique : import("module").
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      addIfLiteral(node.arguments[0]);
    }
    // 6 -- require("module").
    else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      addIfLiteral(node.arguments[0]);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return { references, hasNonLiteralModuleReference };
}
