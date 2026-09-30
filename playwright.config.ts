import { defineConfig, devices } from "@playwright/test";

/**
 * SCANYM E2E AUTOMATION FOUNDATION v1 (issue #11, comment `5886339688`,
 * design approved in comments `5894999069` + `5896211327`).
 *
 * Deterministic browser-integration executor, separate from the
 * existing Node/jsdom suite (`tests/*.test.ts`, run via `npm test`) --
 * this config governs ONLY `e2e/*.spec.ts`, never touches or replaces
 * the existing suite, and is invoked by its own script (`npm run
 * test:e2e`) and its own workflow (`.github/workflows/
 * e2e-foundation-v1.yml`), never mixed into the existing
 * `restaurant-context-critical-regression-gate.yml` job.
 *
 * SCOPE v1 (per the approved design) : READ-ONLY scenarios only, no
 * Production mutation, Chromium only (no Firefox/WebKit) unless a
 * concrete future need appears, mobile + desktop viewports.
 *
 * `retries: 0` deliberately -- a flaky scenario must be visible and
 * fixed, never silently masked by a blanket retry (explicit CIO
 * constraint: "no masking failures through blanket retries").
 *
 * `baseURL` is read from `PLAYWRIGHT_BASE_URL`, never hardcoded --
 * lets the same spec files run against different environments (today:
 * the public Production read-only path) without editing test code.
 */
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "https://scanym-sanaa.vercel.app";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,

  // Rapport HTML jamais ouvert automatiquement (environnement CI sans
  // affichage) -- consommé comme artefact, voir le workflow. Le reporter
  // "list" (stdout) est aussi redirigé vers un fichier par le workflow
  // CI (`playwright-run.log`, jamais committé -- voir .gitignore) : c'est
  // ce texte, et non le rapport JSON structuré, qui est repris en cas
  // d'échec pour un commentaire de diagnostic sur la PR, car l'endpoint
  // de logs/artefacts GitHub redirige vers un stockage blob inatteignable
  // depuis l'environnement d'investigation habituel (voir issue #11).
  reporter: [["html", { open: "never", outputFolder: "playwright-report" }], ["list"]],

  use: {
    baseURL,
    // Preuve UNIQUEMENT sur échec -- jamais sur un run vert, pour ne
    // pas gonfler le stockage d'artefacts sans raison (mandat §8 de la
    // conception approuvée).
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    // Ce v1 est strictement en LECTURE SEULE -- aucune action qui
    // pourrait muter des données réelles n'est écrite dans les
    // scénarios eux-mêmes (voir e2e/*.spec.ts), et cette config
    // n'active elle-même aucune capacité d'écriture supplémentaire.
    navigationTimeout: 15_000,
    actionTimeout: 10_000,
  },

  projects: [
    {
      name: "mobile",
      use: {
        ...devices["iPhone 13"], // 390x844, correspond à la preuve visuelle déjà produite pour PR #115
        // Le profil `devices["iPhone 13"]` de Playwright fixe
        // `defaultBrowserType: "webkit"` (émulation Safari mobile
        // réel) -- ce qui, sans cette ligne, fait échouer CE projet
        // précis en CI (`browserType.launch: Executable doesn't
        // exist at .../webkit-.../pw_run.sh`), car le workflow
        // n'installe QUE Chromium (`npx playwright install
        // --with-deps chromium`), conformément au périmètre v1
        // "Chromium only (no Firefox/WebKit) unless a concrete
        // future need appears". On conserve donc le viewport/UA/
        // touch de l'émulation iPhone 13, mais en forçant le moteur
        // Chromium réellement installé.
        browserName: "chromium",
      },
    },
    {
      name: "desktop",
      use: { viewport: { width: 1440, height: 900 } },
    },
  ],
});
