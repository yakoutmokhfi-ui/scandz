import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// ====================================================================
// Scanym — issue #210 : transition « échange réussi -> rendu autorisé ».
//
// GARDE STRUCTURELLE (bon marché, sans navigateur) de la cause établie en
// vrai navigateur : un `history.replaceState` suivi de `router.refresh()`
// dans le même tick fait ANNULER le rafraîchissement par le routeur Next.js
// (`net::ERR_ABORTED`), et la coquille d'entrée reste affichée. Cette garde
// n'est PAS la preuve du correctif -- elle empêche seulement de réintroduire
// la séquence. La preuve de comportement est
// tests/browser/tracking-no-manual-refresh-210.mjs (vrai Chromium).
// ====================================================================

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Retire commentaires bloc et ligne pour ne juger que le code exécutable. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("#210 : la porte d'entrée navigue UNE fois vers le chemin propre (router.replace), sans router.refresh() ni history.replaceState", () => {
  const gate = code(read("components/TrackingEntryGate.tsx"));
  assert.match(gate, /router\.replace\(buildCleanTrackingPath\(orderId\)\)/);
  assert.equal(/router\.refresh\s*\(/.test(gate), false, "router.refresh() banni dans la porte d'entrée");
  assert.equal(/history\.(replaceState|pushState)\s*\(/.test(gate), false, "history.replaceState/pushState banni dans la porte d'entrée");
  assert.equal(/location\.(hash|href|assign|replace)\b/.test(gate.replace(/window\.location\.hash/g, "")), false, "aucune autre navigation manuelle");
});

test("#210 : le fragment reste retiré de l'URL par TrackingFragmentScrubber, monté sur toute la page de suivi", () => {
  const page = read("app/track/[orderId]/page.tsx");
  assert.match(page, /<TrackingFragmentScrubber\s*\/>/);
  const scrubber = code(read("components/TrackingFragmentScrubber.tsx"));
  assert.match(scrubber, /window\.history\.replaceState\(null,\s*"",\s*window\.location\.pathname \+ window\.location\.search\)/);
});

test("#210 : le rafraîchissement automatique (5 s, focus, onglet caché, mono-vol, arrêt terminal) est conservé", () => {
  const auto = code(read("components/TrackingAutoRefresh.tsx"));
  assert.match(auto, /intervalMs = 5_000/);
  assert.match(auto, /document\.visibilityState === "hidden"/);
  assert.match(auto, /addEventListener\("focus"/);
  assert.match(auto, /busyRef/);
  const page = read("app/track/[orderId]/page.tsx");
  assert.match(page, /<TrackingAutoRefresh enabled=\{!terminal\} \/>/);
});
