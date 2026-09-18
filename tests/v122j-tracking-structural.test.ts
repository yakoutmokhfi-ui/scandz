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

test("archi: AUCUN fichier de la famille email/notification-outbox de v1 n'existe nulle part dans le dépôt (mandat §4/§26, exclusion stricte, périmètre v2 uniquement)", () => {
  // MISE À JOUR N1-A (Claude Monet) : cette garde protégeait contre une
  // réintroduction NON AUTORISÉE d'e-mail/outbox DANS LE PÉRIMÈTRE DE
  // CE LOT (CUSTOMER TRACKING EXPERIENCE v2, mandat §4/§26 -- "hors de
  // portée pour v2", jamais "interdit pour toujours dans le dépôt").
  // `lib/server/notifications/` est désormais le livrable EXPLICITEMENT
  // AUTORISÉ d'un mandat SÉPARÉ et ULTÉRIEUR -- N1-A, CUSTOMER EMAIL
  // NOTIFICATION FOUNDATION + ORDER RECEIVED (voir supabase/DRAFT-lot-
  // n1a-customer-email-notification-foundation-v1.sql et
  // tests/v1-n1a-*.test.ts) -- retiré de cette liste en conséquence.
  // Les AUTRES chemins (noms EXACTS d'une conception v1 jamais
  // retenue, distincts de ceux réellement livrés par N1-A) restent
  // interdits : cette garde continue de protéger contre LEUR
  // réapparition spécifique.
  const forbiddenPaths = [
    "lib/server/notification-errors.ts",
    "lib/server/notification-outbox.ts",
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

// RECONSTRUCTION v1.2 (nouveau baseline main
// 49664132ad55f96a06a063a90f91e0e111fafe78) : PAYMENT STREAM B
// MONETICO FINALIZATION v1.1 est désormais fusionné et porte déjà le
// compte à 78 (mesuré directement sur ce nouveau baseline, avant tout
// fichier Catalogue, aucune ligne de CE lot v2 n'a bougé) ; CATALOGUE /
// SUBCATEGORIES BACKOFFICE v1 (lot ULTÉRIEUR et SANS RAPPORT avec
// CUSTOMER TRACKING EXPERIENCE v2) ajoute SON PROPRE unique fichier
// SQL top-level (DRAFT-lot-catalogue-subcategories-backoffice-v1.sql),
// portant le compte à 79 ; CATALOGUE / SUBCATEGORIES BACKOFFICE v1.1
// -- REMÉDIATION (même Stream A) ajoute SON PROPRE unique fichier SQL
// top-level, portant le compte à 80 ; DELIVERY STREAM C -- STUART
// SANDBOX INTEGRATION v2 (lot ULTÉRIEUR et SANS RAPPORT avec CUSTOMER
// TRACKING EXPERIENCE v2) ajoute SON PROPRE unique fichier SQL
// top-level (DRAFT-lot-stuart-sandbox-integration-v2.sql), portant le
// compte total à 81 -- mesuré directement, aucune ligne de CE lot v2
// (tracking) n'a bougé. MERCHANT LEGAL & TAX PROFILE v1 (lot
// ULTÉRIEUR et SANS RAPPORT avec CUSTOMER TRACKING EXPERIENCE v2)
// ajoute à son tour SON PROPRE unique fichier SQL top-level
// (DRAFT-lot-merchant-legal-tax-profile-v1.sql), portant le compte
// total à 82 -- mesuré directement, aucune ligne de CE lot v2
// (tracking) n'a bougé non plus. DELIVERY STREAM C -- STUART SANDBOX
// INTEGRATION v2.6.1 (également lot ULTÉRIEUR et SANS RAPPORT) ajoute
// à son tour SON PROPRE unique fichier SQL de désignation synthétique,
// portant le compte total à 83. OPERATOR BACKOFFICE OB-2 (CATALOGUE
// RPC OPERATOR AUTHORIZATION v1, également lot ULTÉRIEUR et SANS
// RAPPORT) ajoute à son tour SON PROPRE unique fichier SQL top-level,
// portant le compte total à 84 -- mesuré directement, aucune ligne de
// CE lot v2 (tracking) n'a bougé.
//
// REFRESH OB-4 v1.2 (onto current main post-Bulk v2.2.1) -- depuis, 6
// lots ULTÉRIEURS et SANS RAPPORT avec CUSTOMER TRACKING EXPERIENCE v2
// ont ajouté 10 nouveaux fichiers SQL top-level (aucun n'est un
// fichier "tracking v2") : CUSTOMER CHECKOUT -- CLIENT / COMPANY
// INVOICE REQUEST v1.1 (+1, compte 85), INVOICE REQUEST FOUNDATION v1
// + ROLLBACK (+2, compte 87), INVOICE REQUEST PRODUCTION ACL
// REMEDIATION v1 (+1, compte 88), CHECKOUT EMAIL VALIDATION v1.1 DELTA
// + ROLLBACK (+2, compte 90), PAYMENT OPERATOR AUTHORIZATION v1 +
// ROLLBACK (+2, compte 92), BULK PRODUCT PHOTOS v2.2.1 + ROLLBACK (+2,
// stream désormais CLOS, compte 94) -- mesuré directement, aucune
// ligne de CE lot v2 (tracking) n'a bougé. OPERATOR BACKOFFICE OB-4 --
// CATALOGUE IMPORT COMMIT / IDEMPOTENCY (également lot ULTÉRIEUR et
// SANS RAPPORT) ajoute à son tour SON PROPRE unique fichier SQL
// top-level (DRAFT-lot-catalogue-import-commit-idempotency-v1-1.sql),
// portant le compte total à 95 -- mesuré directement, aucune ligne de
// CE lot v2 (tracking) n'a bougé. LOT A-0 -- MERCHANT STUART
// CREDENTIAL FOUNDATION v1 (également lot ULTÉRIEUR et SANS RAPPORT --
// domaine credential de LIVRAISON, séparé de payment_provider_configs)
// ajoute à son tour SON PROPRE unique fichier SQL top-level
// (DRAFT-lot-stuart-merchant-credential-foundation-v1.sql), portant le
// compte total à 96 -- mesuré directement, aucune ligne de CE lot v2
// (tracking) n'a bougé.
// MISE À JOUR N1-A (Claude Monet) : ce compte-instantané (96) était
// DÉJÀ dérivé de ce lot v2 AVANT ce cycle -- de nombreux lots ULTÉRIEURS
// et SANS RAPPORT avec v2 (dont, entre autres, CUSTOMER CONFIRMATION +
// TRACKING FINAL v1.1 et SELLER LEGAL PROFILE / CGV ENGINE v1.4,
// fusionnés sur main après le dernier rafraîchissement de cette garde)
// ont continué d'ajouter des fichiers .sql top-level SANS que cette
// assertion ne soit tenue à jour à chaque fois -- un échec PRÉ-EXISTANT
// à ce lot, déjà documenté comme tel dans le paquet précédent
// (scanym_customer_confirmation_tracking_final_v1_1_refresh.zip,
// TEST-RESULTS.md, "1 known pre-existing failure"). N1-A (CUSTOMER
// EMAIL NOTIFICATION FOUNDATION + ORDER RECEIVED) ajoute à son tour
// SES DEUX PROPRES fichiers SQL top-level (DRAFT-lot-n1a-customer-
// email-notification-foundation-v1.sql + -rollback.sql) -- aucune
// ligne de CE lot v2 (tracking) n'a bougé pour autant. Le compte est
// donc corrigé une fois ici à sa valeur RÉELLE mesurée directement
// (114), plutôt que de laisser cette garde continuer de dériver comme
// un échec permanent non examiné.
// MISE À JOUR OPERATOR BACKOFFICE — SAFE CATALOGUE RESET v1 (Claude
// Nougaro) : même mécanique exactement -- ce lot RESET, entièrement
// SANS RAPPORT avec CUSTOMER TRACKING EXPERIENCE v2, ajoute à son tour
// SES DEUX PROPRES fichiers SQL top-level (DRAFT-lot-operator-
// catalogue-reset-v1.sql + -ROLLBACK.sql), portant le compte total à
// 116 -- mesuré directement, aucune ligne de CE lot v2 (tracking) n'a
// bougé pour autant.
// MISE À JOUR CGV ENGINE v2.6.1 (Claude Debussy) -- MAINTENANCE DE TEST
// STRUCTUREL, clôture de la constatation d'audit CGV-V26-FULL-SUITE-01.
//
// Constat : l'assertion de décompte EXACT ci-dessous a dérivé DIX fois
// (85, 87, 88, 90, 92, 94, 95, 96, 114, 116), et CHAQUE fois à cause
// d'un lot ULTÉRIEUR et SANS RAPPORT avec CUSTOMER TRACKING EXPERIENCE
// v2, jamais à cause d'une ligne de CE lot. Elle ne mesure donc PAS ce
// que le mandat §29 lui demande de protéger : elle mesure l'activité SQL
// de TOUT le dépôt. C'est l'assertion NOMMÉE (trackingV2Sql) juste en
// dessous qui exprime réellement l'intention « ce lot n'ajoute aucun
// fichier SQL », et elle, elle est exacte et stable depuis l'origine.
//
// Remédiation MINIMALE (aucun élargissement) : le décompte exact devient
// un PLANCHER (>=), figé à l'inventaire autorisé de la baseline
// a81ce3988da48f6d79246bee46dbdc1cd951230a (= 116 fichiers .sql
// top-level). Ce plancher conserve la seule chose qu'un décompte protège
// réellement -- la DISPARITION accidentelle de fichiers SQL -- tout en
// restant insensible aux ajouts LÉGITIMES de lots sans rapport (ici les
// 6 fichiers du stream SELLER LEGAL PROFILE / CGV ENGINE v2.1/v2.2/
// v2.4/v2.5, portant le total réel à 122). L'assertion nommée reste
// inchangée et demeure la garde de fond de ce test.
//
// Limite assumée et documentée : un plancher ne détecte pas un
// remplacement net (N suppressions compensées par N ajouts). C'est un
// arbitrage délibéré contre une assertion qui a produit dix faux échecs
// et zéro vrai positif en dix rafraîchissements.
const SQL_INVENTORY_FLOOR_BASELINE_A81CE39 = 116;

test("archi: ce lot (CUSTOMER TRACKING EXPERIENCE v2) n'ajoute AUCUN fichier .sql (mandat §29, 'prefer ZERO new SQL') -- garde nommée + plancher d'inventaire >= 116 (baseline a81ce39), insensible aux ajouts légitimes de lots sans rapport", () => {
  const sqlFiles = readdirSync("supabase").filter((f) => f.endsWith(".sql"));
  assert.ok(
    sqlFiles.length >= SQL_INVENTORY_FLOOR_BASELINE_A81CE39,
    `inventaire SQL top-level EN BAISSE sous supabase/ : ${sqlFiles.length} fichier(s) trouvé(s) pour un plancher autorisé de ${SQL_INVENTORY_FLOOR_BASELINE_A81CE39} (baseline a81ce3988da48f6d79246bee46dbdc1cd951230a) -- une DISPARITION de fichier SQL est un incident structurel ; les AJOUTS de lots sans rapport avec CUSTOMER TRACKING EXPERIENCE v2 sont eux légitimes et n'ont pas à faire échouer cette garde`
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
// mandat §19 : ce lot lui-même n'ajoute QUE le point de terminaison
// d'échange -- PAS une interdiction absolue de tout le reste
// d'app/api/ (RECONCILIÉ avec PAYMENT P3-B MONETICO CHECKOUT RUNTIME
// v3/v4, qui y ajoute légitimement 3 routes Monetico distinctes). La
// liste FERMÉE et EXHAUSTIVE des routes attendues pour TOUT le dépôt
// vit désormais dans tests/v110c-payment-p3a1-structural.test.ts
// (seule source de vérité pour cette liste, jamais dupliquée ici).
// --------------------------------------------------------------

test("archi: app/api/track/exchange/route.ts (point de terminaison d'échange de ce lot) existe, et aucune AUTRE route sous app/api/track/ n'a été ajoutée par ce lot (mandat §19 -- la liste fermée et exhaustive de TOUT app/api/, Monetico inclus, est vérifiée par tests/v110c-payment-p3a1-structural.test.ts)", () => {
  assert.ok(existsSync("app/api/track/exchange/route.ts"), "app/api/track/exchange/route.ts devrait exister");
  const trackApiFiles = existsSync("app/api/track") ? walk("app/api/track").filter((f) => /\.tsx?$/.test(f)) : [];
  assert.deepEqual(
    trackApiFiles,
    ["app/api/track/exchange/route.ts"],
    `app/api/track/ contient des fichiers inattendus : ${trackApiFiles.join(", ")}`
  );
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

test("archi: lib/server/tracking-service.ts appelle EXCLUSIVEMENT les RPC v3.1 get_order_tracking_by_capability (lecture liée) et upgrade_legacy_tracking_capability (échange one-shot) -- aucune autorité order-number/email/merchant-slug introduite (mandat §5)", () => {
  const src = readFileSync("lib/server/tracking-service.ts", "utf8");
  const rpcNames = [...src.matchAll(/supabase\.rpc\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]).sort();
  assert.deepEqual(rpcNames, ["get_order_tracking_by_capability", "upgrade_legacy_tracking_capability"]);
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
