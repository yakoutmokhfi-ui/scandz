import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

// ====================================================================
// SCANYM CHECKOUT — EMAIL VALIDATION v1.1 (Claude Monet).
// Ferme Catimini EMAIL-V1-OB1-HARNESS-01 (MEDIUM) -- proof that the
// ONE narrow allowlist entry added to
// tests/ob1-non-modification-proof.test.ts (the exact path
// "supabase/tests/checkout-invoice-request-email-validation-v1-check.sh")
// does NOT broaden that harness's protection in any way: an
// UNRELATED, SYNTHETIC, never-before-seen supabase/ file still trips
// the exact same OB-1 non-modification guard.
//
// Deliberately runs the REAL, UNMODIFIED harness test
// (tests/ob1-non-modification-proof.test.ts) as a subprocess against
// a genuinely modified working tree (a synthetic file is written,
// the harness is executed, the synthetic file is deleted in a
// `finally` -- no duplicated/reimplemented allowlist logic here, so
// this proof can never drift out of sync with the real mechanism).
// The synthetic file never touches disk outside this test's own
// try/finally, is never committed, and this test itself matches the
// pre-existing `/^tests\/ob1-.*\.test\.ts$/` allow-pattern, so it
// needs no allowlist entry of its own.
// ====================================================================

const REPO_ROOT = process.cwd();
const SYNTHETIC_FILE = path.join(
  REPO_ROOT,
  "supabase",
  "UNRELATED-SYNTHETIC-ob1-harness-narrowness-check-DO-NOT-KEEP.sql"
);
const SYNTHETIC_REL_PATH = "supabase/UNRELATED-SYNTHETIC-ob1-harness-narrowness-check-DO-NOT-KEEP.sql";

function runOb1HarnessAllowingFailure(): { status: number | null; output: string } {
  // Node fixe NODE_TEST_CONTEXT=child-v8 dans l'environnement de CE
  // PROCESSUS parce que ce fichier lui-même tourne sous `node --test`
  // -- sans le retirer explicitement ici, le sous-processus hériterait
  // de cette variable et le runner de test Node la détecterait comme
  // un appel récursif, SAUTANT silencieusement l'exécution réelle
  // (exit 0 factice, ne prouvant RIEN). Retiré ICI UNIQUEMENT, pour ce
  // sous-processus de vérification -- jamais propagé ni modifié dans
  // l'environnement réel de ce fichier de test lui-même.
  const { NODE_TEST_CONTEXT, ...childEnv } = process.env;
  try {
    const output = execFileSync(
      "node",
      [
        "--experimental-strip-types",
        "--import",
        "./tests/register.mjs",
        "--test",
        "tests/ob1-non-modification-proof.test.ts",
      ],
      { cwd: REPO_ROOT, encoding: "utf8", env: childEnv }
    );
    return { status: 0, output };
  } catch (err: any) {
    // execFileSync throws on non-zero exit -- expected here, the
    // point of this test is that the harness REJECTS the synthetic
    // file, i.e. exits non-zero.
    return { status: typeof err.status === "number" ? err.status : 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

test("EMAIL-V1-OB1-HARNESS-01 (negative control): an unrelated synthetic supabase/ file still trips the real, unmodified OB-1 non-modification guard -- the new allowlist entry is exact, never a broad exemption", () => {
  assert.ok(!existsSync(SYNTHETIC_FILE), "précondition : le fichier synthétique ne doit pas déjà exister avant ce test");
  writeFileSync(
    SYNTHETIC_FILE,
    "-- fichier synthétique, jamais un vrai lot -- existe UNIQUEMENT pendant l'exécution de ce test, supprimé dans le bloc finally.\nselect 1;\n"
  );
  try {
    // `git diff --name-only <SHA>` (le mécanisme exact utilisé par
    // changedFiles() dans le harnais réel) n'affiche JAMAIS un fichier
    // non suivi ("untracked") sans un "intent-to-add" préalable
    // (`git add -N`) -- comportement Git standard, vérifié
    // empiriquement ici. C'est exactement ainsi que Catimini a
    // constaté la régression (EMAIL-V1-OB1-HARNESS-01) sur le nouveau
    // fichier de ce lot avant son ajout à l'allowlist -- cette sonde
    // reproduit donc la MÊME méthodologie (staging intent-to-add)
    // plutôt qu'une invocation nue qui manquerait le fichier
    // synthétique pour la même raison.
    execFileSync("git", ["add", "-A", "-N", "."], { cwd: REPO_ROOT });
    const { status, output } = runOb1HarnessAllowingFailure();
    assert.notEqual(status, 0, "le harnais OB-1 RÉEL, INCHANGÉ, doit toujours échouer (exit != 0) en présence d'un fichier supabase/ synthétique non autorisé");
    assert.ok(
      output.includes(SYNTHETIC_REL_PATH),
      `la sortie du harnais doit nommer explicitement le fichier synthétique comme hors périmètre -- obtenu : ${output.slice(0, 4000)}`
    );
  } finally {
    // Nettoyage garanti, même si les assertions ci-dessus échouent --
    // ce fichier ne doit JAMAIS survivre à ce test, ni apparaître dans
    // git status une fois ce test terminé, et l'index redevient
    // exactement ce qu'il était avant (le staging intent-to-add
    // ci-dessus n'écrit aucun contenu, mais `git reset` l'annule quand
    // même pour laisser l'index parfaitement inchangé).
    if (existsSync(SYNTHETIC_FILE)) unlinkSync(SYNTHETIC_FILE);
    execFileSync("git", ["reset"], { cwd: REPO_ROOT });
  }
  assert.ok(!existsSync(SYNTHETIC_FILE), "postcondition : le fichier synthétique doit avoir été supprimé");
});

/**
 * Retire les commentaires `//` et `/* ... *\/` avant toute recherche
 * de motif "large" ci-dessous -- SANS cela, la PROSE EXPLICATIVE
 * elle-même (qui documente en toutes lettres, dans un commentaire, le
 * motif qu'on s'est justement engagé à NE JAMAIS introduire, ex.
 * "no blanket supabase/tests/**") déclencherait un faux-positif
 * contre elle-même. Patron déjà établi dans ce dépôt
 * (tests/fulfillment-choice-popup-component.dom.test.ts).
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("EMAIL-V1-OB1-HARNESS-01 (positive control): the one legitimate new file is present, verbatim, in the OB-1 allowlist source -- exact string, never a pattern", () => {
  // Lit le fichier de travail RÉEL (jamais HEAD -- aucun commit n'est
  // jamais créé par ce lot, donc HEAD ne contient pas encore ce
  // correctif).
  const workingTreeSrc = readFileSync(path.join(REPO_ROOT, "tests/ob1-non-modification-proof.test.ts"), "utf8");
  assert.ok(
    workingTreeSrc.includes('"supabase/tests/checkout-invoice-request-email-validation-v1-check.sh"'),
    "l'entrée EXACTE (chaîne littérale, jamais un motif) doit être présente dans l'allowlist"
  );
  // Garde-fou de non-régression, recherché dans le CODE UNIQUEMENT
  // (commentaires retirés) -- jamais dans la prose explicative qui
  // documente ce qu'on s'est engagé à ne jamais faire.
  const codeOnly = stripComments(workingTreeSrc);
  assert.ok(!/supabase\/tests\/\*\*/.test(codeOnly), "aucun motif large 'supabase/tests/**' ne doit jamais être introduit dans le CODE");
  assert.ok(!/LATER_APPROVED_UNRELATED_LOT_FILES[\s\S]{0,2000}\/\^supabase\\\/tests\\\//.test(codeOnly), "aucun motif regex large sur supabase/tests/ ne doit jamais être ajouté à l'allowlist elle-même");
});
