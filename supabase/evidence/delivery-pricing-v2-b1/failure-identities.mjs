// DELIVERY PRICING v2 — B1 — normalisation des identités d'échec d'un log
// `npm test` (TAP du runner node:test), brut ou .gz.
//
// Usage : node failure-identities.mjs <log|log.gz>
// Sortie : une ligne par échec, triée : "tests/<fichier>:<ligne> | <nom du test>".
// Seuls les échecs porteurs d'une `location` sont retenus (les en-têtes de
// fichier « not ok N - tests/x.test.ts » d'un fichier qui échoue au
// chargement portent aussi une location : ils sont gardés, une fois).
// Les préfixes de chemin propres à la machine sont retirés (tout ce qui
// précède « tests/ »), et les fins de ligne CRLF sont normalisées.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const path = process.argv[2];
if (!path) {
  console.error("usage: node failure-identities.mjs <log|log.gz>");
  process.exit(2);
}
const raw = readFileSync(path);
const text = (path.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8").replace(/\r\n/g, "\n");
const lines = text.split("\n");

const ids = new Set();
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\s*not ok \d+ - (.*)$/);
  if (!m) continue;
  for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
    const loc = lines[j].match(/^\s*location: '(?:.*[\\/])?(tests[\\/][^']*?):(\d+):\d+'$/);
    if (loc) {
      ids.add(`${loc[1].replace(/\\/g, "/")}:${loc[2]} | ${m[1].trim()}`);
      break;
    }
    if (/^\s*(not ok|ok) \d+ - /.test(lines[j])) break;
  }
}
for (const id of [...ids].sort()) console.log(id);
