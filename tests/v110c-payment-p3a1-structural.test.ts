import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { scanModuleReferences } from "./helpers/module-reference-scanner.ts";

// ====================================================================
// Scanym — PAYMENT P3-A1 — SERVER PAYMENT INFRASTRUCTURE.
// Invariants ARCHITECTURAUX (mandat §19/§20/§29-§34/§40) : ce lot doit
// rester un ajout pur -- une nouvelle couche serveur non branchée
// nulle part -- sans toucher au checkout client, au tableau de bord
// paiement, sans nouveau point de terminaison public, sans SQL, et
// sans encoder la moindre logique spécifique à un prestataire.
//
// Patron déjà établi par ce dépôt pour ce type d'invariant
// (tests/cart-and-price.test.ts, tests/v98-b5-structured-address-
// foundation.test.ts) : parcours récursif + expressions régulières
// ciblées, jamais un simple grep du mot lui-même (une mention en
// commentaire d'architecture NE DOIT PAS faire échouer le test --
// mandat §33/§34, "may appear only in comments... describing future
// use").
// ====================================================================

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const APP_AND_COMPONENT_FILES = [...walk("app"), ...walk("components")].filter((f) =>
  /\.tsx?$/.test(f)
);
const LIB_SERVER_FILES = walk("lib/server").filter((f) => /\.ts$/.test(f));

// --------------------------------------------------------------
// §7/§39 : garde-fou "server-only" présent sur CHAQUE fichier de la
// couche serveur de confiance -- une invariante simple à vérifier
// plutôt qu'un cas particulier par fichier.
// --------------------------------------------------------------

test("archi: chaque fichier sous lib/server/ importe \"server-only\" en tête", () => {
  assert.ok(LIB_SERVER_FILES.length >= 3, "lib/server/ devrait contenir au moins les 3 fichiers de ce lot");
  const offenders: string[] = [];
  for (const file of LIB_SERVER_FILES) {
    const src = readFileSync(file, "utf8");
    if (!/^import\s+"server-only";/m.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `garde "server-only" manquant : ${offenders.join(", ")}`);
});

// --------------------------------------------------------------
// §19 : couche serveur non importée depuis un composant client, le
// tableau de bord, le code client public, ou lib/supabase.ts.
// --------------------------------------------------------------

const SERVER_IMPORT_PATTERN = /from\s+["']@\/lib\/server\/[^"']+["']/;

test("archi: aucun composant \"use client\" n'importe lib/server/*", () => {
  const offenders: string[] = [];
  for (const file of APP_AND_COMPONENT_FILES) {
    const src = readFileSync(file, "utf8");
    if (/^["']use client["'];?/m.test(src) && SERVER_IMPORT_PATTERN.test(src)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], `composant client important lib/server/* : ${offenders.join(", ")}`);
});

// MISE À JOUR CUSTOMER TRACKING EXPERIENCE v2.1 + PAYMENT P3-B
// MONETICO CHECKOUT RUNTIME v3/v4/v4.1 (RECONCILIÉS -- baseline
// a2f93da3851f48200dd839aeef9dc299538a2a7b, voir
// REPORTS/BASELINE-RECONCILIATION-REPORT-v4.1.txt) : ce test
// vérifiait à l'origine (PAYMENT P3-A1) que ce lot n'était "branché
// nulle part". DEUX lots publics distincts l'ont depuis
// délibérément branché : CUSTOMER TRACKING EXPERIENCE v2.1 (mandat
// §3/§8, page de suivi + point d'échange de session) ET PAYMENT
// P3-B MONETICO CHECKOUT RUNTIME v3/v4 (checkout/callback/worker de
// reprise + relais de retour). La liste des fichiers app/
// autorisés à importer lib/server/* est désormais EXPLICITE et
// FERMÉE (mission §32 de PAYMENT P3-A2 levée UNIQUEMENT pour CES
// fichiers précis) : les 2 fichiers de suivi client restent
// SCOPÉS à leurs seuls modules tracking-* dédiés (jamais un module
// de paiement) ; les 4 fichiers Monetico peuvent importer n'importe
// quel module lib/server/* (patron déjà établi, PAYMENT P3-B v3/v4).
// Tout AUTRE fichier sous app/ ou components/ reste soumis à
// l'invariant strict d'origine.
const TRACKING_ALLOWED_SERVER_IMPORTERS: Record<string, RegExp> = {
  "app/track/[orderId]/page.tsx": /^@\/lib\/server\/tracking-(service|errors|session)$/,
  "app/api/track/exchange/route.ts": /^@\/lib\/server\/tracking-(service|errors|session)$/,
};
// CORRECTIF v2.6.1 (STUART-V26-P3A1-ALLOWLIST-01, MEDIUM) : le
// déclencheur Stuart était auparavant ajouté à
// MONETICO_ALLOWED_SERVER_IMPORTERS (SANS RESTRICTION de module) --
// contournait l'invariant structurel pour TOUT import lib/server/*.
// Retiré de cette liste, remplacé par une règle DÉDIÉE et SCOPÉE,
// même mécanisme exact que TRACKING_ALLOWED_SERVER_IMPORTERS
// ci-dessus : SEULS les 3 modules Stuart explicitement requis par la
// route sont autorisés -- toute autre valeur (Monetico, un autre
// prestataire de livraison, un module server arbitraire) est REJETÉE.
const STUART_ALLOWED_SERVER_IMPORTERS: Record<string, RegExp> = {
  "app/api/internal/stuart/sandbox-trigger/route.ts":
    /^@\/lib\/server\/delivery-providers\/stuart\/(environment|create-job|allocation)$/,
  // DELIVERY STREAM C -- STUART SANDBOX INTEGRATION v2.6.2 (lot
  // ULTÉRIEUR et SANS RAPPORT avec PAYMENT P3-A1) : sonde de
  // préparation runtime EN LECTURE SEULE -- n'importe QUE le
  // résolveur d'environnement, jamais create-job/allocation (aucune
  // orchestration, aucun accès DB depuis cette route).
  "app/api/internal/stuart/sandbox-readiness/route.ts":
    /^@\/lib\/server\/delivery-providers\/stuart\/environment$/,
};
const MONETICO_ALLOWED_SERVER_IMPORTERS = new Set([
  "app/api/payments/monetico/checkout/route.ts",
  "app/api/payments/monetico/callback/route.ts",
  "app/api/internal/payments/monetico/recover/route.ts",
  "app/checkout/return/shared.ts",
]);
test("archi: AUCUN fichier sous app/ ou components/ n'importe lib/server/*, SAUF les 2 points d'entrée de suivi client (CUSTOMER TRACKING EXPERIENCE v2.1, scopés à leurs modules tracking-*), les 4 fichiers PAYMENT P3-B MONETICO CHECKOUT RUNTIME v3/v4 (sans restriction de module), et les routes Stuart scopées (DELIVERY STREAM C) -- énumération BASÉE SUR L'AST du compilateur TypeScript (ferme STUART-V262-ALLOWLIST-SYNTAX-01 : détecte imports par défaut/nommés/espace de noms/effet de bord/dynamiques, require(), et ré-exports -- jamais seulement la forme régulière 'from \"...\"')", () => {
  const offenders: string[] = [];
  for (const file of APP_AND_COMPONENT_FILES) {
    if (MONETICO_ALLOWED_SERVER_IMPORTERS.has(file)) {
      continue;
    }
    const { references, hasNonLiteralModuleReference } = scanModuleReferences(file);
    const serverReferences = references.filter((r) => r.startsWith("@/lib/server/"));

    const allowedPattern = TRACKING_ALLOWED_SERVER_IMPORTERS[file] ?? STUART_ALLOWED_SERVER_IMPORTERS[file];
    if (!allowedPattern) {
      // Fichier NON allowlisté : AUCUNE référence lib/server/* n'est
      // tolérée, littérale OU non littérale (fail-closed explicite).
      if (serverReferences.length > 0) offenders.push(`${file} -> ${serverReferences.join(", ")}`);
      if (hasNonLiteralModuleReference) offenders.push(`${file} -> [référence de module NON LITTÉRALE détectée, fail-closed]`);
      continue;
    }
    // Fichier allowlisté (suivi client OU route Stuart) : chaque
    // référence RÉELLE de lib/server/* -- quelle que soit sa syntaxe
    // (import statique, effet de bord, dynamique, require) -- doit
    // correspondre au motif autorisé pour CE fichier précis.
    if (hasNonLiteralModuleReference) offenders.push(`${file} -> [référence de module NON LITTÉRALE détectée, fail-closed]`);
    for (const imported of serverReferences) {
      if (!allowedPattern.test(imported)) offenders.push(`${file} -> ${imported}`);
    }
  }
  assert.deepEqual(offenders, [], `import inattendu de lib/server/* : ${offenders.join(", ")}`);
});

test("archi: les 4 fichiers Monetico autorisés à importer lib/server/* existent TOUJOURS et importent RÉELLEMENT lib/server/* (la liste ci-dessus ne fige jamais un fichier disparu/renommé sans le remarquer)", () => {
  for (const file of MONETICO_ALLOWED_SERVER_IMPORTERS) {
    assert.ok(existsSync(file), `fichier attendu absent : ${file}`);
    const src = readFileSync(file, "utf8");
    assert.ok(SERVER_IMPORT_PATTERN.test(src), `${file} n'importe plus lib/server/* -- entrée obsolète`);
  }
});

test("archi: lib/supabase.ts (client anon, orienté navigateur) n'importe jamais lib/server/*", () => {
  const src = readFileSync("lib/supabase.ts", "utf8");
  assert.ok(!SERVER_IMPORT_PATTERN.test(src));
  assert.ok(!/service_role|SERVICE_ROLE/.test(src));
});

test("archi: aucun fichier sous lib/services/ (couche service PUBLIQUE existante) n'importe lib/server/*", () => {
  const offenders: string[] = [];
  for (const file of walk("lib/services").filter((f) => /\.tsx?$/.test(f))) {
    const src = readFileSync(file, "utf8");
    if (SERVER_IMPORT_PATTERN.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `lib/services/* importe lib/server/* : ${offenders.join(", ")}`);
});

// --------------------------------------------------------------
// §20 : aucune variable NEXT_PUBLIC_ portant sur la clé service_role,
// nulle part dans le dépôt.
// --------------------------------------------------------------

test("archi: aucune variable NEXT_PUBLIC_*SERVICE_ROLE* nulle part dans le code/config source", () => {
  const scanDirs = ["app", "components", "lib", "tests", "supabase"];
  const files = scanDirs.flatMap((d) => walk(d)).filter((f) => /\.(ts|tsx|mjs|json|example|sql|sh)$/.test(f));
  const pattern = /NEXT_PUBLIC_[A-Z0-9_]*SERVICE_ROLE/;
  const offenders: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    if (pattern.test(src)) offenders.push(file);
  }
  // .env.example et package.json/package-lock.json à la racine, hors
  // scanDirs -- vérifiés séparément ci-dessous par sécurité.
  for (const rootFile of [".env.example", "package.json"]) {
    if (pattern.test(readFileSync(rootFile, "utf8"))) offenders.push(rootFile);
  }
  assert.deepEqual(offenders, [], `variable NEXT_PUBLIC_*SERVICE_ROLE* trouvée : ${offenders.join(", ")}`);
});

test("archi: .env.example documente SUPABASE_SERVICE_ROLE_KEY (nom seul, jamais une valeur plausible de secret)", () => {
  const src = readFileSync(".env.example", "utf8");
  assert.ok(/^SUPABASE_SERVICE_ROLE_KEY=\s*$/m.test(src), "SUPABASE_SERVICE_ROLE_KEY= (vide) attendu dans .env.example");
  assert.ok(!/SUPABASE_SERVICE_ROLE_KEY=\S/.test(src), ".env.example ne doit jamais contenir de valeur après le signe égal");
});

// --------------------------------------------------------------
// §32/§40 : aucun SQL ajouté par ce lot.
// --------------------------------------------------------------

// MISE À JOUR PAYMENT P3-B0 : le compte 63 vérifiait "aucun SQL ajouté
// PAR P3-A1" (un lot bibliothèque pur) -- toujours vrai, mais PAYMENT
// P3-B0 (lot suivant, mandat séparé et explicite, "SQL CAPABILITY LOT")
// a depuis ajouté EXACTEMENT un fichier SQL
// (DRAFT-lot-payment-p3b0-correlation-status-read.sql), portant le
// compte total à 64.
// MISE À JOUR PAYMENT P3-B1 : PAYMENT P3-B (checkout runtime) s'est
// arrêté avec STOP — PAYMENT P3-B RUNTIME PROVIDER CONFIG CAPABILITY
// REQUIRED ; PAYMENT P3-B1 (lot suivant, mandat séparé et explicite,
// "SQL CAPABILITY LOT") a depuis ajouté EXACTEMENT un fichier SQL
// supplémentaire (DRAFT-lot-payment-p3b1-runtime-provider-enablement-
// read.sql), portant le compte total à 65.
// MISE À JOUR ORDERS SERVICE_ROLE SELECT HARDENING v1 : un constat
// Production séparé (ACL de public.orders, indépendant de PAYMENT
// P3-B2, qui reste STOPPÉ et non publié) a nécessité un lot de
// durcissement SQL dédié, qui a ajouté EXACTEMENT un fichier SQL
// supplémentaire au niveau racine de supabase/ (DRAFT-lot-orders-
// service-role-select-hardening.sql), portant le compte total à 66.
// (Le fichier de fixture de test qui accompagne ce lot,
// supabase/tests/fixtures/p3b2-candidate-order-payment-context-read.sql,
// vit sous un sous-répertoire de supabase/tests/ -- readdirSync("supabase")
// n'étant pas récursif, il n'est pas compté ici.)
// MISE À JOUR PAYMENT P3-B2 : le lot de lecture de contexte de paiement
// ajoute désormais son unique fichier SQL au-dessus de ce baseline
// durci, portant le compte total de 66 à 67.
// MISE À JOUR PAYMENT P3-B3 : le lot de reprise/lecture de tentative de
// paiement active ajoute son unique fichier SQL, portant le compte
// total de 67 à 68.
// MISE À JOUR PAYMENT P3-B4 : le lot de lecture du mode d'environnement
// runtime (capacité sœur de PAYMENT P3-B1, ferme PAY-P3B-V2-06) ajoute
// son unique fichier SQL, portant le compte total de 68 à 69.
// MISE À JOUR CUSTOMER ORDER TRACKING FOUNDATION v3 (reconstruction sur
// main courant après P3-B4) : ce lot ajoute son unique fichier SQL
// top-level (DRAFT-lot-customer-order-tracking-foundation.sql), portant
// le compte total de 69 à 70.
// MISE À JOUR PAYMENT P3-B5 v2 (reconstruction sur main courant après
// CUSTOMER ORDER TRACKING FOUNDATION v3 -- l'ancien baseline dbd7db3
// n'est plus l'intégration valide, voir BASELINE LOCK du mandat P3-B5
// v2) : ce lot ajoute SON PROPRE unique fichier SQL top-level
// (DRAFT-lot-payment-p3b5-durable-provider-callback-inbox.sql), portant
// le compte total de 70 à 71. Le compte n'est PAS recalculé en
// rejouant aveuglément l'ancien delta "69 -> 70" de l'ancien baseline :
// il est mesuré directement depuis le nouveau baseline réel (70, déjà
// CUSTOMER ORDER TRACKING FOUNDATION v3 incluse) + 1. Ce test reste un
// test de RÉGRESSION P3-A1 : il continue de vérifier qu'AUCUN fichier
// nommé "p3a1" n'existe, et que le compte total n'a plus bougé DEPUIS
// les ajouts attendus de P3-B0/P3-B1/ORDERS SERVICE_ROLE SELECT
// HARDENING v1/P3-B2/P3-B3/P3-B4/CUSTOMER ORDER TRACKING FOUNDATION v3/
// PAYMENT P3-B5.
// MISE À JOUR PAYMENT P3-B6 (CHECKOUT BILLING CONTEXT v1) : ce lot
// ajoute SON PROPRE unique fichier SQL top-level (DRAFT-lot-payment-
// p3b6-checkout-billing-context.sql), portant le compte total de 71 à
// 72 -- mesuré directement (pas rejoué depuis un ancien delta).
// MISE À JOUR CATALOGUE / SUBCATEGORIES BACKOFFICE v1 (Stream A,
// lot SANS RAPPORT avec P3-A1/paiement) : ce lot ajoute SON PROPRE
// unique fichier SQL top-level (DRAFT-lot-catalogue-subcategories-
// backoffice-v1.sql), portant le compte total de 77 à 78 -- mesuré
// directement.
test("archi: aucun fichier SQL ajouté par P3-A1 (nombre inchangé depuis PAYMENT P3-B0/P3-B1/ORDERS ACL HARDENING/P3-B2/P3-B3/P3-B4/CUSTOMER ORDER TRACKING FOUNDATION v3/PAYMENT P3-B5/PAYMENT P3-B6/PAYMENT STREAM B CURRENCY PREFLIGHT FIX v1.1/CATALOGUE SUBCATEGORIES BACKOFFICE v1/CATALOGUE SUBCATEGORIES BACKOFFICE v1.1, aucun nom contenant p3a1)", () => {
  const sqlFiles = readdirSync("supabase").filter((f) => f.endsWith(".sql"));
  // RECONSTRUCTION v1.2 (nouveau baseline main
  // 49664132ad55f96a06a063a90f91e0e111fafe78) : PAYMENT STREAM B
  // MONETICO FINALIZATION v1.1 est désormais fusionné et porte déjà le
  // compte à 78 (mesuré directement sur ce nouveau baseline, avant
  // tout fichier Catalogue) ; CATALOGUE / SUBCATEGORIES BACKOFFICE v1
  // ajoute SON PROPRE unique fichier SQL top-level par-dessus, portant
  // le compte à 79 ; CATALOGUE / SUBCATEGORIES BACKOFFICE v1.1 --
  // REMÉDIATION (même Stream A, également déjà installée en
  // Production) ajoute SON PROPRE unique fichier SQL top-level,
  // portant le compte total à 80 -- mesuré directement.
  // MERCHANT LEGAL & TAX PROFILE v1 (Stream A, sans rapport avec le
  // paiement) ajoute SON PROPRE unique fichier SQL top-level
  // (DRAFT-lot-merchant-legal-tax-profile-v1.sql), portant le compte
  // total à 82 -- mesuré directement. DELIVERY STREAM C -- STUART
  // SANDBOX INTEGRATION v2.6.1 (sans rapport avec le paiement) ajoute
  // SON PROPRE unique fichier SQL de désignation synthétique, portant
  // le compte total à 83. OPERATOR BACKOFFICE OB-2 (CATALOGUE RPC
  // OPERATOR AUTHORIZATION v1, également sans rapport avec le
  // paiement) ajoute à son tour SON PROPRE unique fichier SQL
  // top-level (DRAFT-lot-catalogue-operator-authorization-v1.sql),
  // portant le compte total à 84 -- mesuré directement.
  assert.equal(sqlFiles.length, 84, `nombre de fichiers .sql sous supabase/ inattendu (${sqlFiles.length}) -- 78 (nouveau baseline main, PAYMENT STREAM B MONETICO FINALIZATION v1.1 déjà fusionné, mesuré directement) + 1 (CATALOGUE / SUBCATEGORIES BACKOFFICE v1 -- Stream A, sans rapport avec le paiement) + 1 (CATALOGUE / SUBCATEGORIES BACKOFFICE v1.1 -- remédiation d'audit Stream A, également sans rapport avec le paiement) + 1 (DELIVERY STREAM C -- STUART SANDBOX INTEGRATION v2, également sans rapport avec le paiement) + 1 (MERCHANT LEGAL & TAX PROFILE v1 -- Stream A, également sans rapport avec le paiement) + 1 (DELIVERY STREAM C -- STUART SANDBOX INTEGRATION v2.6.1, désignation synthétique, également sans rapport avec le paiement) + 1 (OPERATOR BACKOFFICE OB-2 -- CATALOGUE RPC OPERATOR AUTHORIZATION v1, également sans rapport avec le paiement) attendu`);
  const p3a1Named = sqlFiles.filter((f) => /p3a1/i.test(f));
  assert.deepEqual(p3a1Named, []);
});

// --------------------------------------------------------------
// §29/§40 : aucune route API publique ajoutée par ce lot.
// --------------------------------------------------------------

// MISE À JOUR CUSTOMER TRACKING EXPERIENCE v2.1 + PAYMENT P3-B
// MONETICO CHECKOUT RUNTIME v3/v4 (RECONCILIÉS) : ce test reste un
// test de RÉGRESSION P3-A1 (PAYMENT P3-A1 lui-même n'a ajouté aucune
// route) -- PAS une interdiction absolue et permanente d'app/api/
// pour tout le dépôt. Deux lots distincts l'ont depuis légitimement
// peuplé (voir la liste fermée ci-dessous) ; toute route NON prévue
// par L'UN OU L'AUTRE reste détectée.
test("archi: app/api/ contient EXACTEMENT les routes de CUSTOMER TRACKING EXPERIENCE v2.1 + PAYMENT P3-B MONETICO CHECKOUT RUNTIME v3/v4 -- aucune autre route ajoutée par PAYMENT P3-A1", () => {
  let apiDirExists = false;
  try {
    apiDirExists = statSync("app/api").isDirectory();
  } catch {
    apiDirExists = false;
  }
  assert.equal(apiDirExists, true, "app/api/ devrait exister depuis CUSTOMER TRACKING EXPERIENCE v2.1 et PAYMENT P3-B MONETICO CHECKOUT RUNTIME v3");
  const routeFiles = walk("app/api")
    .filter((f) => /route\.tsx?$/.test(f))
    .sort();
  // Liste fermée -- 1 route de suivi client (CUSTOMER TRACKING
  // EXPERIENCE v2.1) + 3 routes Monetico (PAYMENT P3-B MONETICO
  // CHECKOUT RUNTIME v3/v4, dont le worker de reprise, ferme
  // P3B-V3-ACK-RECOVERY-01 -- jamais activé/programmé par ce lot,
  // voir le commentaire de fichier de la route elle-même et
  // REPORTS/FINAL-REPORT-v4.1.md, section GOVERNANCE) + 2 routes
  // DELIVERY STREAM C -- STUART SANDBOX INTEGRATION v2.6/v2.6.2 (lots
  // ULTÉRIEURS et SANS RAPPORT avec PAYMENT P3-A1 : déclencheur
  // d'exécution Sandbox contrôlée + sonde de préparation runtime en
  // lecture seule, chacun authentifié par un secret dédié DISTINCT).
  assert.deepEqual(routeFiles, [
    "app/api/internal/payments/monetico/recover/route.ts",
    "app/api/internal/stuart/sandbox-readiness/route.ts",
    "app/api/internal/stuart/sandbox-trigger/route.ts",
    "app/api/payments/monetico/callback/route.ts",
    "app/api/payments/monetico/checkout/route.ts",
    "app/api/track/exchange/route.ts",
  ]);

  const exchangeRouteSrc = readFileSync("app/api/track/exchange/route.ts", "utf8");
  assert.equal(
    /payment|monetico|p3[-_]?[ab]\d/i.test(exchangeRouteSrc),
    false,
    "app/api/track/exchange/route.ts ne doit référencer aucun concept de paiement"
  );
});

// --------------------------------------------------------------
// §30/§31 : aucune modification du checkout client ni du tableau de
// bord paiement -- vérifié en creux : ces zones ne référencent
// toujours pas la couche serveur de paiement (déjà couvert ci-dessus
// par le scan app/+components/ complet), et ce lot ne les mentionne
// jamais lui-même.
// --------------------------------------------------------------

test("archi: le module dashboard payment existant (P2B-B) reste read-only, jamais d'APPEL RPC d'écriture ajouté par P3-A1", () => {
  // Cible l'APPEL réel (`.rpc("set_payment_provider_credentials"`),
  // jamais la simple mention -- ce fichier référence déjà
  // légitimement ces deux noms dans un commentaire d'architecture
  // expliquant pourquoi ils sont HORS périmètre (voir P2B-B, section
  // "Dashboard Payment Module v1" du fichier lui-même) ; ce commentaire
  // préexistant ne doit pas faire échouer ce test.
  const src = readFileSync("lib/services/dashboard.ts", "utf8");
  assert.ok(!/\.rpc\(\s*["']set_payment_provider_credentials["']/.test(src));
  assert.ok(!/\.rpc\(\s*["']clear_payment_provider_credentials["']/.test(src));
});

// --------------------------------------------------------------
// §33/§34 : aucune implémentation spécifique à un prestataire. On
// cible des SIGNATURES TECHNIQUES concrètes (calcul de MAC, endpoint
// spécifique, parsing de callback), jamais le simple mot "Monetico"/
// "Mercanet" qui peut légitimement apparaître dans un commentaire
// d'architecture décrivant ce qui N'EST PAS fait ici (mandat §33 :
// "may appear only in comments... describing future use").
// --------------------------------------------------------------

const PROVIDER_IMPLEMENTATION_PATTERNS = [
  { pattern: /HMAC-SHA1|hmac-sha1/i, label: "HMAC-SHA1" },
  { pattern: /paiement\.cgi/i, label: "paiement.cgi" },
  { pattern: /\bTPE\s*[:=]/i, label: "TPE=" },
  { pattern: /calculerMAC|computeMac|buildMacString/i, label: "fonction de calcul de MAC" },
  { pattern: /mercanet[-.]?(bnpparibas|paiement)/i, label: "endpoint Mercanet" },
  { pattern: /societe\s*[:=]|société\s*[:=]/i, label: "champ société=" },
];

// MISE À JOUR PAYMENT P3-A2 : ce test datait de PAYMENT P3-A1, dont le
// mandat interdisait explicitement toute implémentation Monetico/
// Mercanet dans `lib/server/*` -- l'invariant vérifié ici. PAYMENT
// P3-A2 (lot suivant, mandat séparé et explicite) AJOUTE
// délibérément un adaptateur Monetico réel, mais UNIQUEMENT sous
// `lib/server/payment-providers/monetico/` -- un sous-dossier dédié,
// nouveau, absent au moment où ce test a été écrit. L'invariant
// ORIGINAL reste donc vérifié tel quel pour tout le RESTE de
// `lib/server/*` (notamment payment-service.ts/supabase-admin.ts/
// payment-errors.ts, qui doivent rester génériques pour toujours,
// même après P3-A2) ; seul ce nouveau sous-dossier, dont l'existence
// et le contenu sont le mandat explicite de P3-A2, est exclu ici. Voir
// tests/v111h-payment-p3a2-structural.test.ts pour l'invariant
// complémentaire et positif : la logique Monetico ne vit JAMAIS
// ailleurs QUE dans ce sous-dossier (aucun import depuis app/
// components/lib/services/lib/supabase.ts).
test("archi: lib/server/* (hors adaptateurs de prestataire dédiés) ne contient AUCUNE implémentation Monetico/Mercanet (signatures techniques concrètes)", () => {
  const offenders: string[] = [];
  for (const file of LIB_SERVER_FILES) {
    if (file.startsWith("lib/server/payment-providers/")) continue;
    const src = readFileSync(file, "utf8");
    for (const { pattern, label } of PROVIDER_IMPLEMENTATION_PATTERNS) {
      if (pattern.test(src)) offenders.push(`${file} → ${label}`);
    }
  }
  assert.deepEqual(offenders, [], `implémentation spécifique à un prestataire détectée : ${offenders.join(", ")}`);
});
