import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ====================================================================
// Scanym — PAYMENT P3-A2 — MONETICO SERVER ADAPTER v1.
// Invariants architecturaux (mandat §26/§41/§42/§43) : l'adaptateur
// Monetico reste une couche serveur pure, non branchée au checkout
// client ni au tableau de bord, sans nouvelle route publique, sans SQL.
// Patron identique à tests/v110c-payment-p3a1-structural.test.ts.
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
const MONETICO_IMPORT_PATTERN = /from\s+["']@\/lib\/server\/payment-providers[^"']*["']/;

test("archi: aucun composant \"use client\" n'importe lib/server/payment-providers/*", () => {
  const offenders: string[] = [];
  for (const file of APP_AND_COMPONENT_FILES) {
    const src = readFileSync(file, "utf8");
    if (/^["']use client["'];?/m.test(src) && MONETICO_IMPORT_PATTERN.test(src)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], `composant client important l'adaptateur Monetico : ${offenders.join(", ")}`);
});

test("archi: AUCUN fichier sous app/ ou components/ n'importe lib/server/payment-providers/* (client ou serveur -- ce lot n'est branché nulle part)", () => {
  const offenders: string[] = [];
  for (const file of APP_AND_COMPONENT_FILES) {
    const src = readFileSync(file, "utf8");
    if (MONETICO_IMPORT_PATTERN.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `import inattendu de l'adaptateur Monetico : ${offenders.join(", ")}`);
});

test("archi: le tableau de bord paiement (P2B-B, app/dashboard/payment/page.tsx) n'importe jamais l'adaptateur Monetico -- reste lecture seule (mandat §5)", () => {
  const src = readFileSync("app/dashboard/payment/page.tsx", "utf8");
  assert.ok(!MONETICO_IMPORT_PATTERN.test(src));
  // Le libellé d'affichage préexistant `monetico: "Monetico"` (une
  // simple correspondance code -> nom lisible, mandat §11 de P2B-B)
  // reste légitime et ne doit pas faire échouer ce test -- seule
  // l'IMPORTATION du module d'adaptateur est interdite ici.
});

test("archi: aucun fichier sous lib/services/ (couche service PUBLIQUE) n'importe l'adaptateur Monetico", () => {
  const offenders: string[] = [];
  for (const file of walk("lib/services").filter((f) => /\.tsx?$/.test(f))) {
    const src = readFileSync(file, "utf8");
    if (MONETICO_IMPORT_PATTERN.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `lib/services/* importe l'adaptateur Monetico : ${offenders.join(", ")}`);
});

test("archi: chaque fichier sous lib/server/payment-providers/ (y compris monetico/) importe \"server-only\" en tête", () => {
  const files = walk("lib/server/payment-providers").filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 10, "au moins 10 fichiers .ts attendus");
  const offenders: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    if (!/^import\s+"server-only";/m.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `garde "server-only" manquant : ${offenders.join(", ")}`);
});

test("archi: le registre de prestataires ne contient QUE 'monetico' -- aucune implémentation substitutive Mercanet/Stripe/autre (mandat §34)", async () => {
  const { paymentProviders } = await import("../lib/server/payment-providers/registry.ts");
  assert.deepEqual(Object.keys(paymentProviders), ["monetico"]);
});

// Cible l'APPEL/l'USAGE réel, jamais la simple MENTION entre
// backticks dans un commentaire d'architecture -- ce fichier référence
// déjà légitimement ces noms pour expliquer ce qu'il NE fait PAS
// (même patron de correction que tests/v110c, cf. son historique).
function containsRealUsage(src: string, name: string): boolean {
  const pattern = new RegExp(`(?<!\`)${name}(?!\`)\\s*\\(`, "g");
  return pattern.test(src);
}

test("archi: callback.ts ne mentionne jamais confirmPaymentAttempt/orders/payment_transactions -- ne mute jamais d'état directement (mandat §21)", () => {
  const src = readFileSync("lib/server/payment-providers/monetico/callback.ts", "utf8");
  assert.ok(!containsRealUsage(src, "confirmPaymentAttempt"));
  assert.ok(!/\.from\(\s*["']orders["']/.test(src));
  assert.ok(!/\.from\(\s*["']payment_transactions["']/.test(src));
});

test("archi: aucun accès direct à Vault depuis l'adaptateur Monetico (mandat §27 -- passe exclusivement par getPaymentProviderCredential)", () => {
  const files = walk("lib/server/payment-providers/monetico").filter((f) => f.endsWith(".ts"));
  const offenders: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    // "vault.decrypted_secrets"/"vault.secrets" ne sont interdits que
    // comme accès réel (précédés de `.` d'un objet de requête, jamais
    // comme mention entre backticks dans un commentaire).
    const realVaultAccess = /(?<!`)vault\.(decrypted_secrets|secrets)(?!`)/.test(src);
    const realServiceRoleClientUsage = containsRealUsage(src, "getServiceRoleSupabaseClient");
    if (realVaultAccess || realServiceRoleClientUsage) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], `accès direct inattendu détecté : ${offenders.join(", ")}`);
});

test("archi: aucun app/api/ n'existe (aucune route publique ajoutée par ce lot, mandat §32)", () => {
  let apiDirExists = false;
  try {
    apiDirExists = statSync("app/api").isDirectory();
  } catch {
    apiDirExists = false;
  }
  assert.equal(apiDirExists, false, "app/api/ ne devrait pas exister à l'issue de PAYMENT P3-A2");
});

test("archi: aucun bouton/route de paiement client ajouté (mandat §4/§42) -- aucune mention de l'adaptateur Monetico dans le panier/checkout/WhatsApp", () => {
  const candidateDirs = ["app", "components"].filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
  const checkoutLikeFiles = candidateDirs
    .flatMap((d) => walk(d))
    .filter((f) => /\.(tsx?|jsx?)$/.test(f))
    .filter((f) => /cart|checkout|whatsapp|order-submit/i.test(f));
  const offenders: string[] = [];
  for (const file of checkoutLikeFiles) {
    const src = readFileSync(file, "utf8");
    if (MONETICO_IMPORT_PATTERN.test(src) || /buildMoneticoPaymentRequest|verifyMoneticoCallback/.test(src)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], `fichier de flux client fait référence à l'adaptateur Monetico : ${offenders.join(", ")}`);
});

// MISE À JOUR PAYMENT P3-B0 : le compte 63 vérifiait "aucun SQL ajouté
// PAR P3-A2" (un lot bibliothèque pur) -- toujours vrai, mais PAYMENT
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
// total de 67 à 68. Ce test reste un test de RÉGRESSION P3-A2 : il
// continue de vérifier qu'AUCUN fichier nommé "p3a2" n'existe, et que
// le compte total n'a plus bougé DEPUIS les ajouts attendus de
// P3-B0/P3-B1/ORDERS SERVICE_ROLE SELECT HARDENING v1/P3-B2/P3-B3.
test("archi: aucun fichier SQL ajouté par P3-A2 (nombre inchangé depuis PAYMENT P3-B0/P3-B1/ORDERS ACL HARDENING/P3-B2/P3-B3, aucun nom contenant p3a2)", () => {
  const sqlFiles = readdirSync("supabase").filter((f) => f.endsWith(".sql"));
  assert.equal(sqlFiles.length, 68, `nombre de fichiers .sql sous supabase/ inattendu (${sqlFiles.length}) -- 63 (avant P3-B0) + 1 (PAYMENT P3-B0) + 1 (PAYMENT P3-B1) + 1 (ORDERS SERVICE_ROLE SELECT HARDENING v1) + 1 (PAYMENT P3-B2) + 1 (PAYMENT P3-B3) attendu`);
  const p3a2Named = sqlFiles.filter((f) => /p3a2/i.test(f));
  assert.deepEqual(p3a2Named, []);
});

test("archi: aucune dépendance de cryptographie tierce ajoutée -- mac.ts n'importe que node:crypto", () => {
  const src = readFileSync("lib/server/payment-providers/monetico/mac.ts", "utf8");
  const importLines = src.split("\n").filter((l) => l.trim().startsWith("import"));
  for (const line of importLines) {
    if (
      line.includes("node:crypto") ||
      line.includes("payment-providers/monetico/canonicalization") ||
      line.includes("payment-providers/monetico/errors") ||
      line.includes("server-only")
    ) {
      continue;
    }
    assert.fail(`import inattendu dans mac.ts : ${line.trim()}`);
  }
});
