import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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

test("archi: AUCUN fichier sous app/ ou components/ n'importe lib/server/* (ni client ni serveur -- ce lot n'est branché nulle part)", () => {
  const offenders: string[] = [];
  for (const file of APP_AND_COMPONENT_FILES) {
    const src = readFileSync(file, "utf8");
    if (SERVER_IMPORT_PATTERN.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `import inattendu de lib/server/* : ${offenders.join(", ")}`);
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
// read.sql), portant le compte total à 65. Ce test reste un test de
// RÉGRESSION P3-A1 : il continue de vérifier qu'AUCUN fichier nommé
// "p3a1" n'existe, et que le compte total n'a plus bougé DEPUIS les
// ajouts attendus de P3-B0 et P3-B1.
test("archi: aucun fichier SQL ajouté par P3-A1 (nombre inchangé depuis PAYMENT P3-B0/P3-B1, aucun nom contenant p3a1)", () => {
  const sqlFiles = readdirSync("supabase").filter((f) => f.endsWith(".sql"));
  assert.equal(sqlFiles.length, 65, `nombre de fichiers .sql sous supabase/ inattendu (${sqlFiles.length}) -- 63 (avant P3-B0) + 1 (PAYMENT P3-B0) + 1 (PAYMENT P3-B1, lot SQL explicite) attendu`);
  const p3a1Named = sqlFiles.filter((f) => /p3a1/i.test(f));
  assert.deepEqual(p3a1Named, []);
});

// --------------------------------------------------------------
// §29/§40 : aucune route API publique ajoutée par ce lot.
// --------------------------------------------------------------

test("archi: aucun app/api/ n'existe (ce lot établit l'infrastructure serveur, pas un point de terminaison public)", () => {
  let apiDirExists = false;
  try {
    apiDirExists = statSync("app/api").isDirectory();
  } catch {
    apiDirExists = false;
  }
  assert.equal(apiDirExists, false, "app/api/ ne devrait pas exister à l'issue de PAYMENT P3-A1");
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
