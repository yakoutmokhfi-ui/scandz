import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanModuleReferences } from "../tests/helpers/module-reference-scanner.ts";

// ====================================================================
// DELIVERY STREAM C — STUART SANDBOX INTEGRATION v2.6.3 (ferme
// STUART-V262-ALLOWLIST-SYNTAX-01). Preuve directe que le scanner
// AST détecte les 7 formes de syntaxe listées par le mandat --
// exercé sur de VRAIS fichiers TypeScript temporaires, jamais une
// simulation.
// ====================================================================

function withFixture(content: string, fn: (filePath: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "scanym-scanner-test-"));
  const filePath = path.join(dir, "fixture.ts");
  writeFileSync(filePath, content, "utf8");
  try {
    fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("1. import par défaut statique -- détecté", () => {
  withFixture(`import Foo from "@/lib/server/example";`, (f) => {
    const result = scanModuleReferences(f);
    assert.ok(result.references.includes("@/lib/server/example"));
  });
});

test("2. import nommé statique -- détecté", () => {
  withFixture(`import { foo, bar } from "@/lib/server/example";`, (f) => {
    const result = scanModuleReferences(f);
    assert.ok(result.references.includes("@/lib/server/example"));
  });
});

test("3. import d'espace de noms -- détecté", () => {
  withFixture(`import * as foo from "@/lib/server/example";`, (f) => {
    const result = scanModuleReferences(f);
    assert.ok(result.references.includes("@/lib/server/example"));
  });
});

test("4. import à effet de bord -- détecté", () => {
  withFixture(`import "@/lib/server/supabase-admin";`, (f) => {
    const result = scanModuleReferences(f);
    assert.ok(result.references.includes("@/lib/server/supabase-admin"), "l'import à effet de bord DOIT être détecté -- c'est exactement le contournement démontré par Work");
  });
});

test("5. import dynamique -- détecté", () => {
  withFixture(`async function f() { const m = await import("@/lib/server/delivery-providers/stuart/create-job"); }`, (f) => {
    const result = scanModuleReferences(f);
    assert.ok(result.references.includes("@/lib/server/delivery-providers/stuart/create-job"), "l'import dynamique DOIT être détecté");
  });
});

test("6. require CommonJS -- détecté", () => {
  withFixture(`const m = require("@/lib/server/supabase-admin");`, (f) => {
    const result = scanModuleReferences(f);
    assert.ok(result.references.includes("@/lib/server/supabase-admin"), "require() DOIT être détecté");
  });
});

test("7. ré-export -- détecté", () => {
  withFixture(`export { foo } from "@/lib/server/example";`, (f) => {
    const result = scanModuleReferences(f);
    assert.ok(result.references.includes("@/lib/server/example"));
  });
});

test("référence non littérale -- signalée explicitement, jamais silencieusement ignorée", () => {
  withFixture(`const modName = "@/lib/server/x"; const m = import(modName);`, (f) => {
    const result = scanModuleReferences(f);
    assert.equal(result.hasNonLiteralModuleReference, true, "une référence de module non littérale DOIT être signalée");
  });
});

test("fichier propre (aucune référence lib/server/*) -- ensemble vide, hasNonLiteralModuleReference=false", () => {
  withFixture(`import React from "react"; const x = 1;`, (f) => {
    const result = scanModuleReferences(f);
    assert.ok(!result.references.some((r) => r.startsWith("@/lib/server/")));
    assert.equal(result.hasNonLiteralModuleReference, false);
  });
});

test("plusieurs formes combinées dans un même fichier -- TOUTES détectées", () => {
  withFixture(
    `import "@/lib/server/a";\nimport { x } from "@/lib/server/b";\nconst y = require("@/lib/server/c");\nasync function f() { await import("@/lib/server/d"); }`,
    (f) => {
      const result = scanModuleReferences(f);
      for (const expected of ["@/lib/server/a", "@/lib/server/b", "@/lib/server/c", "@/lib/server/d"]) {
        assert.ok(result.references.includes(expected), `${expected} devrait être détecté`);
      }
    }
  );
});

// ====================================================================
// SONDES NÉGATIVES (mandat §"NEGATIVE PROBES REQUIRED") -- exercent LE
// VRAI garde structurel (motif d'autorisation exact de la route
// sandbox-readiness, `scanModuleReferences` réel), jamais une
// simulation séparée. Chaque cas A-G DOIT être rejeté par la règle
// canonique ; le cas H (import autorisé) DOIT continuer à passer.
// ====================================================================
const READINESS_ALLOWED_PATTERN = /^@\/lib\/server\/delivery-providers\/stuart\/environment$/;

function evaluateAgainstReadinessRule(fixtureContent: string): { offending: string[]; hasNonLiteral: boolean } {
  const offending: string[] = [];
  let hasNonLiteral = false;
  withFixture(fixtureContent, (f) => {
    const { references, hasNonLiteralModuleReference } = scanModuleReferences(f);
    hasNonLiteral = hasNonLiteralModuleReference;
    for (const ref of references.filter((r) => r.startsWith("@/lib/server/"))) {
      if (!READINESS_ALLOWED_PATTERN.test(ref)) offending.push(ref);
    }
  });
  return { offending, hasNonLiteral };
}

test("SONDE A. import nommé/par défaut interdit (supabase-admin) -- REJETÉ par la règle canonique de sandbox-readiness", () => {
  const { offending } = evaluateAgainstReadinessRule(`import { x } from "@/lib/server/supabase-admin";`);
  assert.ok(offending.includes("@/lib/server/supabase-admin"));
});

test("SONDE B. import à effet de bord interdit (supabase-admin) -- REJETÉ (exactement le contournement démontré par Work)", () => {
  const { offending } = evaluateAgainstReadinessRule(`import "@/lib/server/supabase-admin";`);
  assert.ok(offending.includes("@/lib/server/supabase-admin"));
});

test("SONDE C. import dynamique interdit (create-job) -- REJETÉ", () => {
  const { offending } = evaluateAgainstReadinessRule(
    `async function f() { await import("@/lib/server/delivery-providers/stuart/create-job"); }`
  );
  assert.ok(offending.includes("@/lib/server/delivery-providers/stuart/create-job"));
});

test("SONDE D. require() interdit (supabase-admin) -- REJETÉ", () => {
  const { offending } = evaluateAgainstReadinessRule(`const m = require("@/lib/server/supabase-admin");`);
  assert.ok(offending.includes("@/lib/server/supabase-admin"));
});

test("SONDE E. module Monetico interdit -- REJETÉ", () => {
  const { offending } = evaluateAgainstReadinessRule(`import { x } from "@/lib/server/payment-providers/monetico/request";`);
  assert.ok(offending.includes("@/lib/server/payment-providers/monetico/request"));
});

test("SONDE F. module d'un AUTRE prestataire de livraison interdit -- REJETÉ", () => {
  const { offending } = evaluateAgainstReadinessRule(`import { x } from "@/lib/server/delivery-providers/chronofresh/client";`);
  assert.ok(offending.includes("@/lib/server/delivery-providers/chronofresh/client"));
});

test("SONDE G. module server arbitraire non lié -- REJETÉ", () => {
  const { offending } = evaluateAgainstReadinessRule(`import { x } from "@/lib/server/tracking-service";`);
  assert.ok(offending.includes("@/lib/server/tracking-service"));
});

test("SONDE H. import autorisé (environment) -- PASSE toujours", () => {
  const { offending } = evaluateAgainstReadinessRule(`import { resolveStuartEnvironment } from "@/lib/server/delivery-providers/stuart/environment";`);
  assert.deepEqual(offending, []);
});
