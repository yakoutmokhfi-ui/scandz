import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

// ====================================================================
// Scanym — CUSTOMER TRACKING EXPERIENCE v2 — invariants ARCHITECTURAUX
// propres à ce lot (en complément des invariants généraux déjà mis à
// jour dans tests/v110c-payment-p3a1-structural.test.ts et
// tests/v111h-payment-p3a2-structural.test.ts, qui couvrent déjà
// l'allowlist d'import lib/server/* et le compte total de fichiers SQL).
//
// Réécrit ENTIÈREMENT depuis la version v1 (tests/v117j-*, remplacée --
// voir /tmp/old-v117j-reference.test.ts conservé comme seule référence
// de style, jamais rejoué tel quel) pour refléter le périmètre RÉDUIT
// et le token-transport RECONÇU de v2 :
//   - mandat §4/§26 : email/outbox de notification EXCLU de ce lot --
//     AUCUN fichier de cette famille ne doit exister nulle part dans
//     le dépôt (regression guard, pas seulement "absent du lot") ;
//   - mandat §6 : régression -- l'ancienne route FORBIDDEN
//     app/track/[orderId]/[token] (jeton en segment de chemin) ne doit
//     JAMAIS réapparaître ;
//   - mandat §29 : ZÉRO nouveau SQL -- aucun fichier .sql propre à ce
//     lot, décompte total inchangé ;
//   - mandat §28/§31 : indépendance paiement (aucune référence
//     payment_status/Monetico dans le token-transport/UI/service de
//     suivi v2) ;
//   - mandat §10 : garde "server-only" sur lib/server/tracking-*.ts ;
//   - mandat de conception : lib/tracking/* reste une couche PURE.
// ====================================================================

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const TRACKING_LOT_FILES = [
  ...walk("lib/tracking"),
  "lib/server/tracking-service.ts",
  "lib/server/tracking-errors.ts",
  "lib/server/tracking-session.ts",
  "components/TrackingAutoRefresh.tsx",
  "components/TrackingEntryGate.tsx",
  "app/track/[orderId]/page.tsx",
  "app/api/track/exchange/route.ts",
].filter((f) => existsSync(f));

test("archi: la liste des fichiers de ce lot n'est pas vide (garde-fou anti-faux-négatif)", () => {
  assert.ok(TRACKING_LOT_FILES.length >= 8, `attendu au moins 8 fichiers, trouvé ${TRACKING_LOT_FILES.length}`);
});

// --------------------------------------------------------------
// mandat §4/§26 : EMAIL/OUTBOX EXCLU -- REGRESSION GUARD GLOBAL.
// --------------------------------------------------------------

test("archi: AUCUN fichier de la famille email/notification-outbox de v1 n'existe nulle part dans le dépôt (mandat §4/§26, exclusion stricte)", () => {
  const forbiddenPaths = [
    "lib/server/notification-errors.ts",
    "lib/server/notification-outbox.ts",
    "lib/server/notifications",
    "lib/tracking/email-template.ts",
    "lib/tracking/notification-events.ts",
    "supabase/DRAFT-lot-customer-tracking-email-notification-foundation.sql",
    "supabase/tests/customer-tracking-email-notification-foundation-check.sh",
  ];
  const present = forbiddenPaths.filter((p) => existsSync(p));
  assert.deepEqual(present, [], `fichier(s) email/outbox EXCLU(S) de v2 pourtant présent(s) : ${present.join(", ")}`);
});

test("archi: aucun module de ce lot ne référence notification_outbox / EmailAdapter / MockEmailAdapter (mandat §4, ni en code ni en commentaire d'implémentation active)", () => {
  const pattern = /notification_outbox|EmailAdapter|MockEmailAdapter/;
  const offenders: string[] = [];
  for (const file of TRACKING_LOT_FILES) {
    const src = readFileSync(file, "utf8");
    if (pattern.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `référence email/outbox trouvée : ${offenders.join(", ")}`);
});

// --------------------------------------------------------------
// mandat §6 : RÉGRESSION -- l'ancienne route token-en-chemin v1.
// --------------------------------------------------------------

test("archi: la route v1 FORBIDDEN app/track/[orderId]/[token] (jeton en segment de chemin, mandat §6) n'existe plus -- garde de non-régression", () => {
  assert.equal(
    existsSync("app/track/[orderId]/[token]"),
    false,
    "cette route insécurisée doit rester définitivement absente"
  );
  assert.ok(
    existsSync("app/track/[orderId]/page.tsx"),
    "la route v2 à segment unique doit exister à la place"
  );
});

test("archi: aucun fichier de ce lot ne construit/documente une URL au format v1 <order_id>/<token> ou ?token= (mandat §6/§20)", () => {
  const offenders: string[] = [];
  for (const file of TRACKING_LOT_FILES) {
    const src = readFileSync(file, "utf8");
    // Cible une construction de chemin réelle, jamais une simple
    // mention en prose d'architecture (ce fichier même en contient
    // plusieurs, légitimement, pour documenter l'interdiction).
    if (/`\/track\/\$\{[^}]+\}\/\$\{[^}]+\}`|\?token=\$\{/.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `construction d'URL au format v1 FORBIDDEN trouvée : ${offenders.join(", ")}`);
});

// --------------------------------------------------------------
// mandat §29 : ZÉRO nouveau SQL.
// --------------------------------------------------------------

test("archi: ce lot (CUSTOMER TRACKING EXPERIENCE v2) n'ajoute AUCUN fichier .sql (mandat §29, 'prefer ZERO new SQL') -- décompte total sous supabase/ = 72 (comme v110c/v111h) + 1 (CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1, lot ULTÉRIEUR et SANS RAPPORT avec ce lot v2 -- seule cette ligne de base a changé, aucune ligne de ce lot v2 n'a bougé)", () => {
  const sqlFiles = readdirSync("supabase").filter((f) => f.endsWith(".sql"));
  assert.equal(
    sqlFiles.length,
    73,
    `nombre de fichiers .sql sous supabase/ inattendu (${sqlFiles.length}) -- CUSTOMER TRACKING EXPERIENCE v2 n'ajoute délibérément aucun fichier SQL ; le seul delta légitime attendu vient d'un lot ultérieur (CATALOGUE FISCAL & PRODUCT MEASUREMENTS v1)`
  );
  const trackingV2Sql = sqlFiles.filter((f) => /tracking.*v2|v2.*tracking/i.test(f));
  assert.deepEqual(trackingV2Sql, [], `fichier SQL propre à v2 trouvé alors qu'aucun n'est attendu : ${trackingV2Sql.join(", ")}`);
});

test("archi: aucun module de ce lot ne référence une table de session de suivi (mandat §29, 'do not silently create a tracking session table')", () => {
  const pattern = /tracking_sessions?\s*\(|create\s+table.*tracking.*session/i;
  const offenders: string[] = [];
  for (const file of TRACKING_LOT_FILES) {
    const src = readFileSync(file, "utf8");
    if (pattern.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `référence à une table de session trouvée : ${offenders.join(", ")}`);
});

// --------------------------------------------------------------
// mandat §28/§31 : INDÉPENDANCE PAIEMENT.
// --------------------------------------------------------------

test("archi: le token-transport/UI/service de suivi v2 ne référence JAMAIS payment_status/Monetico (mandat §28/§31)", () => {
  const offenders: string[] = [];
  for (const file of TRACKING_LOT_FILES) {
    const src = readFileSync(file, "utf8");
    if (/payment_status|monetico/i.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `référence paiement trouvée dans le lot v2 : ${offenders.join(", ")}`);
});

// --------------------------------------------------------------
// mandat §19 : AUCUNE route API hors le seul point de terminaison
// d'échange attendu (déjà vérifié par v110c/v111h via l'allowlist
// app/api/, reconfirmé ici de façon ciblée pour ce lot précis).
// --------------------------------------------------------------

test("archi: app/api/ ne contient QUE le point de terminaison d'échange de ce lot (mandat §19, aucun autre endpoint public ajouté)", () => {
  if (!existsSync("app/api")) return; // absence totale reste acceptable
  const apiFiles = walk("app/api").filter((f) => /\.tsx?$/.test(f));
  assert.deepEqual(apiFiles, ["app/api/track/exchange/route.ts"], `app/api/ contient des fichiers inattendus : ${apiFiles.join(", ")}`);
});

// --------------------------------------------------------------
// garde "server-only" -- déjà vérifiée pour tout lib/server/ par
// v110c (parcours récursif générique), reconfirmée ici de façon
// CIBLÉE sur les seuls fichiers server-only propres à ce lot.
// --------------------------------------------------------------

test("archi: chaque fichier lib/server/tracking-*.ts de ce lot importe \"server-only\" en tête", () => {
  const files = [
    "lib/server/tracking-service.ts",
    "lib/server/tracking-errors.ts",
    "lib/server/tracking-session.ts",
  ].filter((f) => existsSync(f));
  assert.equal(files.length, 3, `attendu exactement 3 fichiers lib/server/tracking-*.ts, trouvé ${files.length}`);
  const offenders: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    if (!/^import\s+"server-only";/m.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `garde "server-only" manquant : ${offenders.join(", ")}`);
});

test("archi: lib/tracking/* reste une couche PURE -- aucun fichier n'importe lib/supabase, lib/server/*, ou \"server-only\" (testable sans réseau/DOM)", () => {
  const files = walk("lib/tracking").filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 3, `attendu au moins 3 fichiers sous lib/tracking/, trouvé ${files.length}`);
  const offenders: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    if (/@\/lib\/supabase["']|@\/lib\/server\/|^import\s+"server-only";/m.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `lib/tracking/* n'est plus une couche pure : ${offenders.join(", ")}`);
});

// --------------------------------------------------------------
// mandat §10 : .env.example documente le secret de session (v2),
// jamais l'ancienne variable e-mail-only exclue (v1).
// --------------------------------------------------------------

test("archi: .env.example documente TRACKING_SESSION_SECRET (v2, serveur uniquement, vide/non commis) sans réintroduire NEXT_PUBLIC_SITE_URL (v1, email-only, exclu)", () => {
  const src = readFileSync(".env.example", "utf8");
  assert.match(src, /^TRACKING_SESSION_SECRET=\s*$/m, ".env.example doit documenter TRACKING_SESSION_SECRET, sans valeur de secret associée");
  assert.equal(/^NEXT_PUBLIC_SITE_URL=/m.test(src), false, "NEXT_PUBLIC_SITE_URL était email-only (v1) -- ne doit pas être réintroduite par v2");
});

// --------------------------------------------------------------
// mandat §5/§15 : autorité de suivi/statuts inchangés (non-régression
// structurelle -- complémentaire des preuves comportementales de
// tests/v122a-tracking-status.test.ts et tests/v122d-tracking-service.test.ts).
// --------------------------------------------------------------

test("archi: lib/server/tracking-service.ts appelle EXCLUSIVEMENT la RPC publiée get_order_tracking(uuid,uuid) -- aucune autorité order-number/email/merchant-slug introduite (mandat §5)", () => {
  const src = readFileSync("lib/server/tracking-service.ts", "utf8");
  assert.match(src, /supabase\.rpc\(\s*["']get_order_tracking["']/, "l'appel RPC get_order_tracking doit rester présent tel quel");
  assert.equal(/order_number\s*[:=].*(lookup|authority|where)/i.test(src), false);
  assert.equal(/merchant[_-]?slug/i.test(src), false, "aucune autorité par slug marchand ne doit être introduite");
});

test("archi: lib/tracking/status.ts n'expose QUE les 7 statuts canoniques released (mandat §15) -- aucun statut paiement/livreur/callback introduit dans le CODE réel", () => {
  // Le fichier documente DÉLIBÉRÉMENT, en commentaire, qu'il n'invente
  // PAS `delivery_status` (mandat §7) -- une correspondance brute sur
  // la source complète serait donc un FAUX positif sur sa propre
  // documentation d'intention. Cible le code réel uniquement, même
  // technique que tests/v90-lot2b4a1-structural.test.ts (stripComments).
  const src = readFileSync("lib/tracking/status.ts", "utf8");
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.equal(/payment_status|delivery_status|callback_status|driver_status|monetico/i.test(codeOnly), false);
});
