#!/usr/bin/env node
/**
 * MONETICO PAYMENT SIMULATOR v1.2 — EXACT-IDENTITY TEST FAILURE COMPARISON.
 *
 * Runs `npm test` (TAP) in two checkouts and compares failures by
 * IDENTITY (test file : line + test name), never by count. Prints a
 * JSON report + a human summary:
 *   - onlyInBaseline  : failures the candidate FIXED
 *   - onlyInCandidate : failures the candidate INTRODUCED  (must be empty)
 *   - common          : pre-existing failures, identical on both
 *
 * Usage:
 *   node scripts/simulator-audit/compare-test-failures.mjs <baselineDir> <candidateDir> [outJson]
 * Each dir must already have node_modules (e.g. `npm ci`).
 *
 * Reads TAP from the harness's own output, so the result is independent
 * of the machine's locale/OS as long as both runs happen on the SAME
 * machine (which is the only meaningful comparison -- Cat Turing's
 * Windows run showed 89 failures on BOTH trees: parity, not regression).
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [baselineDir, candidateDir, outJson] = process.argv.slice(2);
if (!baselineDir || !candidateDir) {
  console.error("usage: compare-test-failures.mjs <baselineDir> <candidateDir> [outJson]");
  process.exit(2);
}

function runSuite(dir) {
  const res = spawnSync("npm", ["test", "--silent"], { cwd: resolve(dir), encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, CI: "1" } });
  const out = (res.stdout ?? "") + "\n" + (res.stderr ?? "");
  return parseTap(out);
}

/** Collect `not ok` entries with their YAML `location:` (file:line:col) when present. */
function parseTap(out) {
  const lines = out.split(/\r?\n/);
  const failures = [];
  let totals = { tests: 0, pass: 0, fail: 0 };
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*not ok \d+ - (.*)$/.exec(lines[i]);
    if (m) {
      let location = null;
      for (let j = i + 1; j < Math.min(i + 40, lines.length); j++) {
        const loc = /^\s*location: '(.+)'/.exec(lines[j]);
        if (loc) { location = loc[1]; break; }
        if (/^\s*\.\.\.\s*$/.test(lines[j])) break;
      }
      // Identity = relative test FILE (machine path and line numbers stripped --
      // a line shifts whenever the file is edited, the test is the same) + name.
      const rel = location ? location.replace(/^.*?[\\/](tests[\\/])/, "$1").replace(/\\/g, "/").replace(/:\d+(:\d+)?$/, "") : "?";
      failures.push({ id: `${rel} :: ${m[1]}`, name: m[1], location: rel });
    }
    const t = /^# (tests|pass|fail) (\d+)/.exec(lines[i]);
    if (t) totals[t[1]] = Number(t[2]);
  }
  // Nested subtests produce duplicates of the parent file entry; dedupe by id.
  const seen = new Set();
  return { totals, failures: failures.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true))) };
}

console.error(`[1/2] running baseline in ${baselineDir} …`);
const baseline = runSuite(baselineDir);
console.error(`[2/2] running candidate in ${candidateDir} …`);
const candidate = runSuite(candidateDir);

const b = new Set(baseline.failures.map((f) => f.id));
const c = new Set(candidate.failures.map((f) => f.id));
const report = {
  baseline: { dir: baselineDir, totals: baseline.totals, failureCount: b.size },
  candidate: { dir: candidateDir, totals: candidate.totals, failureCount: c.size },
  onlyInBaseline: [...b].filter((x) => !c.has(x)).sort(),
  onlyInCandidate: [...c].filter((x) => !b.has(x)).sort(),
  common: [...b].filter((x) => c.has(x)).sort(),
  verdict: null,
};
report.verdict = report.onlyInCandidate.length === 0 ? "PARITY_OR_BETTER" : "REGRESSION";

if (outJson) writeFileSync(outJson, JSON.stringify(report, null, 2));
console.log(`baseline : ${JSON.stringify(baseline.totals)} (${b.size} distinct failures)`);
console.log(`candidate: ${JSON.stringify(candidate.totals)} (${c.size} distinct failures)`);
console.log(`common            : ${report.common.length}`);
console.log(`only in baseline  : ${report.onlyInBaseline.length}${report.onlyInBaseline.map((x) => "\n   - " + x).join("")}`);
console.log(`only in candidate : ${report.onlyInCandidate.length}${report.onlyInCandidate.map((x) => "\n   + " + x).join("")}`);
console.log(`VERDICT: ${report.verdict}`);
process.exit(report.verdict === "REGRESSION" ? 1 : 0);
