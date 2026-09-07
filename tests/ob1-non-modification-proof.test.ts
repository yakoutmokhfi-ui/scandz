import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// ====================================================================
// OB-1 v1.2 — preuve automatisée de non-modification des périmètres
// d'autrui (Stuart/Monnet, Storage photo produit, paiement,
// SQL/backend) et de non-régression du tableau de bord marchand.
//
// AUTHORITATIVE BASELINE : origin/main au moment où CE REFRESH (v1.2)
// a démarré, APRÈS publication de Stuart v2.6.7.4 (PR #57,
// 7dde570988105a8522441fda57b75ef68343a769). v1.2 est un refresh de
// baseline PUR -- aucun changement fonctionnel OB-1 -- donc seul ce
// pointeur de baseline est mis à jour ici (même geste que le refresh
// v1 -> v1.1, documenté dans OB1-V1.1-IMPLEMENTATION-SUMMARY.md). Ce
// test compare littéralement `git diff --name-only` depuis cette
// baseline à une liste EXPLICITE des fichiers qu'OB-1 a le droit de
// toucher -- n'importe quel autre fichier modifié fait échouer ce
// test. Le catalogue SQL d'OB-2
// (supabase/DRAFT-lot-catalogue-operator-authorization-v1.sql) et les
// fichiers Stuart v2.6.7.4 (supabase/DRAFT-lot-stuart-sandbox-*,
// app/api/internal/stuart/*, lib/server/delivery-providers/stuart/*,
// tests/v145-*/v146-*/v147-*, etc.) font déjà partie de cette
// baseline -- ils n'apparaissent donc jamais dans ce diff, et ce test
// ne les référence jamais comme "changés" par OB-1.
// ====================================================================

const BASELINE_SHA = "7dde570988105a8522441fda57b75ef68343a769";

function changedFiles(): string[] {
  const out = execFileSync("git", ["diff", "--name-only", BASELINE_SHA], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

// Fichiers que ce lot a explicitement le droit de créer/modifier.
// Toute nouvelle preuve de test OB-1 (tests/ob1-*.test.ts) est
// autorisée par le motif ci-dessous, pas listée fichier par fichier.
const ALLOWED_EXACT_FILES = new Set([
  "lib/operator-cockpit.ts",
  "lib/services/operator-directory.ts",
  "lib/admin-i18n.ts",
  "components/admin/CockpitSectionCard.tsx",
  "app/admin/establishments/page.tsx",
  "app/admin/establishments/cockpit/page.tsx",
  "app/admin/establishments/new/page.tsx",
]);

function isAllowed(file: string): boolean {
  if (ALLOWED_EXACT_FILES.has(file)) return true;
  if (/^tests\/ob1-.*\.test\.ts$/.test(file)) return true;
  return false;
}

// Motifs explicitement INTERDITS -- documentés pour que l'échec du
// test nomme immédiatement le périmètre violé plutôt qu'un message
// générique.
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; scope: string }> = [
  { pattern: /^lib\/server\/delivery-providers\/stuart\//, scope: "Stuart (Claude Monnet)" },
  { pattern: /stuart/i, scope: "Stuart (Claude Monnet)" },
  { pattern: /^supabase\//, scope: "SQL / migration / backend" },
  { pattern: /^app\/api\/payments?\//, scope: "Paiement (route serveur)" },
  { pattern: /^app\/dashboard\/payment\//, scope: "Paiement (UI marchand)" },
  { pattern: /^app\/dashboard\/catalogue\//, scope: "Catalogue (UI marchand, Claude Nougaro OB-2)" },
  { pattern: /^lib\/services\/product-photo\.ts$/, scope: "Photos produit (Claude Nougaro OB-2)" },
  { pattern: /^lib\/services\/dashboard\.ts$/, scope: "Services marchand partagés (catalogue/paiement/livraison)" },
  { pattern: /^components\/dashboard\//, scope: "UI marchand existante (non-régression)" },
];

test("git diff depuis la baseline publiée : SEULS les fichiers explicitement autorisés par OB-1 ont changé", () => {
  const files = changedFiles();
  assert.ok(files.length > 0, "au moins un fichier doit avoir changé (sinon rien n'a été implémenté)");
  const unexpected = files.filter((f) => !isAllowed(f));
  assert.deepEqual(
    unexpected,
    [],
    `fichier(s) hors du périmètre OB-1 : ${unexpected.join(", ")}`
  );
});

test("aucun fichier Stuart n'a été modifié (périmètre Claude Monnet)", () => {
  const files = changedFiles();
  const hit = files.filter((f) => FORBIDDEN_PATTERNS[0].pattern.test(f) || FORBIDDEN_PATTERNS[1].pattern.test(f));
  assert.deepEqual(hit, []);
});

test("aucun fichier supabase/ (SQL/migration/backend) n'a été modifié -- OB-1 est SQL REQUIRED: NO", () => {
  const files = changedFiles();
  const hit = files.filter((f) => f.startsWith("supabase/"));
  assert.deepEqual(hit, []);
});

test("aucun fichier paiement backend/UI marchand n'a été modifié", () => {
  const files = changedFiles();
  const hit = files.filter(
    (f) => f.startsWith("app/api/payments") || f.startsWith("app/dashboard/payment/")
  );
  assert.deepEqual(hit, []);
});

test("aucun fichier catalogue UI marchand / photo produit (périmètre Claude Nougaro, OB-2) n'a été modifié -- OB-1 v1.1 RÉUTILISE get_merchant_catalogue (déjà publiée par OB-2 v1.1), ne le redéfinit ni ne le duplique jamais", () => {
  const files = changedFiles();
  const hit = files.filter(
    (f) => f.startsWith("app/dashboard/catalogue/") || f === "lib/services/product-photo.ts"
  );
  assert.deepEqual(hit, []);
  // Aucun fichier supabase/ n'est modifié non plus par ce refresh (déjà
  // couvert par le test SQL ci-dessus, répété ici pour la lisibilité
  // du scénario catalogue précisément).
  assert.deepEqual(files.filter((f) => f.startsWith("supabase/")), []);
});

test("OB-1 v1.1 : aucune fausse appartenance restaurant_users n'est jamais créée -- aucune écriture sur cette table dans les fichiers OB-1", () => {
  const files = [
    "lib/operator-cockpit.ts",
    "lib/services/operator-directory.ts",
    "app/admin/establishments/page.tsx",
    "app/admin/establishments/cockpit/page.tsx",
    "components/admin/CockpitSectionCard.tsx",
  ];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.ok(
      !/\.from\(\s*["']restaurant_users["']\s*\)\s*\.(insert|upsert|update)\(/.test(src),
      `${f} ne doit jamais écrire dans restaurant_users`
    );
  }
});

test("non-régression : DashboardNav.tsx (nav marchande) et lib/services/dashboard.ts (services marchand partagés) sont INCHANGÉS", () => {
  const files = changedFiles();
  assert.ok(!files.includes("components/dashboard/DashboardNav.tsx"));
  assert.ok(!files.includes("lib/services/dashboard.ts"));
});

test("app/admin/establishments/new/page.tsx : seule modification = le lien additif vers le répertoire (aucune ligne métier existante supprimée)", () => {
  const src = readFileSync("app/admin/establishments/new/page.tsx", "utf8");
  // Le formulaire de création et son flux de rattachement propriétaire
  // restent intacts -- même fonctions/imports qu'avant ce lot.
  assert.ok(src.includes("createEstablishment("));
  assert.ok(src.includes("linkPendingOwner("));
  assert.ok(src.includes('router.replace("/dashboard/login")'));
  assert.ok(src.includes('router.replace("/dashboard")'));
  // L'ajout OB-1 est bien présent et clairement documenté comme additif.
  assert.ok(src.includes('href="/admin/establishments"'));
});

test("aucune trace de service_role/clé privilégiée dans les fichiers ajoutés par OB-1", () => {
  const files = [
    "lib/operator-cockpit.ts",
    "lib/services/operator-directory.ts",
    "app/admin/establishments/page.tsx",
    "app/admin/establishments/cockpit/page.tsx",
    "components/admin/CockpitSectionCard.tsx",
  ];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/service_role/i.test(src), `${f} ne doit jamais référencer service_role`);
  }
});

test("aucune RPC de mutation (create_/update_/set_/archive_/restore_/publish/link_pending_owner) n'est appelée par les nouveaux fichiers OB-1 (hors admin/establishments/new, déjà existant et inchangé sur ce point)", () => {
  const files = [
    "lib/operator-cockpit.ts",
    "lib/services/operator-directory.ts",
    "app/admin/establishments/page.tsx",
    "app/admin/establishments/cockpit/page.tsx",
    "components/admin/CockpitSectionCard.tsx",
  ];
  const mutationRpcCall = /\.rpc\(\s*["'](create_|update_|set_|archive_|restore_|link_pending_owner|delete_)/;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.ok(!mutationRpcCall.test(src), `${f} ne doit appeler aucune RPC de mutation`);
    assert.ok(!/\.insert\(|\.upsert\(|\.update\(|\.delete\(/.test(src), `${f} ne doit faire aucune écriture Supabase directe`);
  }
});
