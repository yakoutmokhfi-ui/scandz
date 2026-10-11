import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { COMMUNICATION_TEXT_KEYS, PUBLIC_COMMUNICATION_TEXT_KEYS } = await import(
  "../lib/communications/text-keys.ts"
);
const { THEME_TOKEN_KEYS } = await import("../lib/theme-tokens.ts");

// ====================================================================
// Scanym — CUSTOMER BILLING PROFILE v2.1 — RECOMPOSITION SUR MAIN
//
// La facturation a été auditée (PASS) sur une base où THEME & CONTENT
// SETTINGS v1 et CATALOGUE PRODUCT REORDER v1.1 n'existaient pas
// encore. Ces trois lots se croisent en UN point : le catalogue FERMÉ
// d'emplacements de texte marchand de MERCHANT CUSTOMER
// COMMUNICATIONS v1. Ce fichier verrouille l'INTERACTION, c'est-à-dire
// ce qu'aucun des trois lots ne vérifie seul.
//
// La PREUVE DE COMPORTEMENT (application réelle des trois lots sur un
// cluster PostgreSQL jetable, écritures croisées, rollbacks) est faite
// par supabase/tests/customer-billing-profile-v2-theme-integration-check.sh
// (scénarios [I-1] à [I-10]). Ici : les invariants STRUCTURELS, qui
// tournent dans la suite de tests ordinaire.
// ====================================================================

const repoRoot = process.cwd();
const read = (...parts: string[]) => readFileSync(path.join(repoRoot, ...parts), "utf8");

const BILLING_SQL = read("supabase", "DRAFT-lot-customer-billing-profile-v2.sql");
const BILLING_ROLLBACK = read("supabase", "DRAFT-lot-customer-billing-profile-v2-rollback.sql");
const THEME_SQL = read("supabase", "DRAFT-lot-theme-content-settings-v1.sql");
const REORDER_SQL = read("supabase", "DRAFT-lot-catalogue-product-reorder-v1.sql");
const INTEGRATION_HARNESS = read(
  "supabase",
  "tests",
  "customer-billing-profile-v2-theme-integration-check.sh"
);

/** SQL réellement EXÉCUTÉ : les commentaires `--` sont retirés. Les
 *  fichiers de ce dépôt DOCUMENTENT leurs interdits en toutes lettres ;
 *  chercher un mot interdit dans le texte brut échouerait précisément
 *  parce que la garantie est écrite. */
const executable = (source: string) =>
  source
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i < 0 ? line : line.slice(0, i);
    })
    .join("\n");

/** Les littéraux d'un `array[...]` d'une fonction de catalogue. */
function sqlCatalog(source: string, functionName: string): string[] {
  const exec = executable(source);
  const start = exec.search(
    new RegExp(`create (?:or replace )?function public\\.${functionName}\\(\\)`)
  );
  assert.ok(start > 0, `${functionName}() doit être déclarée`);
  const body = exec.slice(start, exec.indexOf("$$;", start));
  const open = body.indexOf("array[");
  const close = body.indexOf("]", open);
  return [...body.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const THEME_KEYS = ["order_help_button_label", "order_help_title", "order_help_body"] as const;
const BILLING_KEYS = ["billing_profile_explanation"] as const;

// ==================================================================
// 1. MCC — PROPRIÉTÉ DES EMPLACEMENTS (le point de croisement)
// ==================================================================

test("[INT-MCC-1] le catalogue TypeScript porte les emplacements des TROIS lots", () => {
  for (const key of [...THEME_KEYS, ...BILLING_KEYS]) {
    assert.ok(COMMUNICATION_TEXT_KEYS.includes(key), `${key} absent du catalogue`);
  }
  // Aucun doublon : deux lots ne peuvent pas revendiquer la même clé.
  assert.equal(new Set(COMMUNICATION_TEXT_KEYS).size, COMMUNICATION_TEXT_KEYS.length);
  // Les emplacements de Theme ET celui de la facturation sont publics
  // (tous s'affichent dans le parcours client anonyme).
  for (const key of [...THEME_KEYS, ...BILLING_KEYS]) {
    assert.ok(PUBLIC_COMMUNICATION_TEXT_KEYS.includes(key), `${key} doit sortir publiquement`);
  }
});

test("[INT-MCC-2] le SQL de facturation RECONDUIT le catalogue de Theme et n'ajoute que le sien", () => {
  const theme = sqlCatalog(THEME_SQL, "communication_text_keys");
  const billing = sqlCatalog(BILLING_SQL, "communication_text_keys");
  // « entrée + ma clé », exactement : ni perte, ni réordonnancement.
  assert.deepEqual(billing, [...theme, ...BILLING_KEYS]);
  const themePublic = sqlCatalog(THEME_SQL, "public_communication_text_keys");
  const billingPublic = sqlCatalog(BILLING_SQL, "public_communication_text_keys");
  assert.deepEqual(billingPublic, [...themePublic, ...BILLING_KEYS]);
  // …et le miroir avec TypeScript tient.
  assert.deepEqual(billing, [...COMMUNICATION_TEXT_KEYS]);
  assert.deepEqual(billingPublic, [...PUBLIC_COMMUNICATION_TEXT_KEYS]);
});

test("[INT-MCC-3] le ROLLBACK de facturation restaure le catalogue de Theme, pas l'état pré-Theme", () => {
  const restored = sqlCatalog(BILLING_ROLLBACK, "communication_text_keys");
  assert.deepEqual(restored, sqlCatalog(THEME_SQL, "communication_text_keys"));
  assert.deepEqual(
    sqlCatalog(BILLING_ROLLBACK, "public_communication_text_keys"),
    sqlCatalog(THEME_SQL, "public_communication_text_keys")
  );
  for (const key of THEME_KEYS) {
    assert.ok(restored.includes(key), `${key} (Theme) doit survivre au rollback de facturation`);
  }
  for (const key of BILLING_KEYS) {
    assert.ok(!restored.includes(key), `${key} doit être retiré par son propre rollback`);
  }
});

test("[INT-MCC-4] aucune garde ne repose sur un EFFECTIF figé du catalogue", () => {
  // C'est l'erreur d'intégration que ce lot vient de corriger : un
  // « <> 14 » devient faux au premier lot légitime suivant, et un
  // effectif juste ne prouverait pas que la liste réécrite contient
  // l'existant.
  for (const [name, source] of [
    ["aller", BILLING_SQL],
    ["rollback", BILLING_ROLLBACK],
  ] as const) {
    const code = executable(source);
    assert.ok(
      !/cardinality\(public\.communication_text_keys\(\)\)\s*\)?\s*<>\s*\d+/.test(code),
      `${name} : garde par effectif sur communication_text_keys()`
    );
    assert.ok(
      !/cardinality\(public\.public_communication_text_keys\(\)\)\s*\)?\s*<>\s*\d+/.test(code),
      `${name} : garde par effectif sur public_communication_text_keys()`
    );
    // …remplacées par des égalités de CONTENU.
    assert.match(code, /public\.communication_text_keys\(\) <> array\[/);
  }
});

// ==================================================================
// 2. THEME — RIEN DE CE QUI EST À THEME N'EST TOUCHÉ
// ==================================================================

test("[INT-THEME-1] le lot de facturation n'ÉCRIT aucun objet de Theme", () => {
  const code = executable(BILLING_SQL) + "\n" + executable(BILLING_ROLLBACK);
  // Aucune DDL, aucune écriture sur les objets de Theme.
  for (const forbidden of [
    /alter\s+table[^;]*restaurant_configs/i,
    /drop\s+(table|column|function)[^;]*theme/i,
    /create (?:or replace )?function public\.update_restaurant_theme_tokens/i,
    /create (?:or replace )?function public\.theme_token_keys/i,
    /create (?:or replace )?function public\.communication_text_max_length/i,
    /update\s+public\.restaurant_configs/i,
  ]) {
    assert.ok(!forbidden.test(code), `le lot ne doit pas toucher : ${forbidden}`);
  }
});

test("[INT-THEME-2] …mais il VÉRIFIE les bornes de Theme, avant et après", () => {
  // Les trois emplacements order_help_* sont remis dans la liste par
  // ce lot ; les y remettre sans leurs bornes (60 / 120) les ferait
  // retomber à 500. Le fichier le contrôle donc en base, des deux
  // côtés de son application.
  const code = executable(BILLING_SQL);
  const occurrences = code.match(/communication_text_max_length\('order_help_button_label'\)/g) ?? [];
  assert.ok(occurrences.length >= 2, "borne du libellé vérifiée en pré-vol ET en postcheck");
  assert.match(code, /communication_text_max_length\('order_help_title'\) <> 120/);
  assert.match(code, /SCANYM_SCHEMA_DRIFT: communication_text_max_length\(\) ne porte pas les bornes/);
  assert.match(code, /SCANYM_POSTCHECK_FAILED: les bornes de longueur par emplacement ont changé/);
});

test("[INT-THEME-3] les 7 jetons de thème et leur RPC restent l'autorité de Theme", () => {
  assert.equal(THEME_TOKEN_KEYS.length, 7);
  // Le code applicatif de facturation ne lit ni n'écrit les jetons.
  for (const file of [
    ["lib", "invoice-request.ts"],
    ["components", "InvoiceRequestFields.tsx"],
    ["lib", "server", "invoice-request-service.ts"],
    ["lib", "services", "invoice-request.ts"],
    ["app", "api", "checkout", "invoice-request", "route.ts"],
  ] as const) {
    const source = read(...file);
    assert.ok(!/theme_tokens|updateRestaurantThemeTokens|THEME_TOKEN_KEYS/.test(source), file.join("/"));
  }
});

// ==================================================================
// 3. PRODUCT REORDER — AUCUN RECOUVREMENT
// ==================================================================

test("[INT-REORDER-1] le lot de facturation ne touche NI la RPC NI l'ordre d'affichage", () => {
  const code = executable(BILLING_SQL) + "\n" + executable(BILLING_ROLLBACK);
  for (const forbidden of [
    /create (?:or replace )?function public\.move_product_order/i,
    /drop\s+function[^;]*move_product_order/i,
    /update\s+public\.menu_items/i,
    /alter\s+table[^;]*menu_items/i,
    /display_order\s*=/i,
  ]) {
    assert.ok(!forbidden.test(code), `recouvrement avec Product Reorder : ${forbidden}`);
  }
  // …et réciproquement : Product Reorder ne touche pas la facturation.
  const reorder = executable(REORDER_SQL);
  assert.ok(!/order_invoice_request|billing_profile_explanation|siren/i.test(reorder));
});

test("[INT-REORDER-2] le rollback de facturation PROUVE la non-régression hors périmètre", () => {
  const code = executable(BILLING_ROLLBACK);
  // Prise de notes de l'état AVANT, dans la même transaction…
  assert.match(code, /create temp table _scanym_cbp_v2_pre_state on commit drop/);
  assert.match(code, /had_move_product_order/);
  assert.match(code, /had_theme_tokens_rpc/);
  assert.match(code, /had_theme_tokens_column/);
  assert.match(code, /theme_text_rows/);
  // …puis comparaison, pas EXIGENCE : ce rollback ne doit pas devenir
  // dépendant de l'installation d'un autre lot.
  assert.match(code, /if \(select had_move_product_order from _scanym_cbp_v2_pre_state\)\s*\n?\s*and to_regprocedure/);
  assert.match(code, /SCANYM_ROLLBACK_CHECK_FAILED: move_product_order \(CATALOGUE PRODUCT REORDER v1\.1\) a disparu/);
  assert.match(code, /SCANYM_ROLLBACK_CHECK_FAILED: des textes order_help_\* de THEME & CONTENT SETTINGS v1 ont été emportés/);
});

// ==================================================================
// 4. ORDRE D'INSTALLATION — DOCUMENTÉ, PAS SYMÉTRIQUE
// ==================================================================

test("[INT-ORDER-1] l'ordre requis est DOCUMENTÉ et IMPOSÉ par le pré-vol", () => {
  // Le mandat : « Where installation order is not supposed to be
  // arbitrary, document the required order instead of inventing
  // symmetry. » Ici l'ordre n'est pas arbitraire -- la facturation
  // reconduit le catalogue de Theme, elle ne peut donc pas s'appliquer
  // avant lui -- et le pré-vol le FAIT RESPECTER.
  const code = executable(BILLING_SQL);
  assert.match(code, /SCANYM_SCHEMA_DRIFT: communication_text_keys\(\) ne porte pas le catalogue attendu/);
  for (const key of THEME_KEYS) {
    assert.ok(
      new RegExp(`'${key}'`).test(code.slice(0, code.indexOf("begin;"))),
      `${key} doit figurer dans la garde de pré-vol (état d'entrée attendu)`
    );
  }
  // L'en-tête dit explicitement de quel état courant ce lot part.
  assert.match(BILLING_SQL, /RECOMPOSITION SUR LE MAIN COURANT \(THEME & CONTENT SETTINGS/);
});

test("[INT-ORDER-2] le harnais d'intégration couvre les dix scénarios du mandat", () => {
  for (const scenario of [
    "[I-1]",
    "[I-2]",
    "[I-3]",
    "[I-4]",
    "[I-5]",
    "[I-6]",
    "[I-7]",
    "[I-8]",
    "[I-9]",
    "[I-10]",
  ]) {
    assert.ok(INTEGRATION_HARNESS.includes(scenario), `scénario ${scenario} absent du harnais`);
  }
  // Il applique les lots dans l'ORDRE RÉEL du main, sur un cluster
  // JETABLE créé par lui-même, et jamais sur une cible héritée.
  assert.match(INTEGRATION_HARNESS, /SCANYM_DISPOSABLE_CLUSTER/);
  assert.match(INTEGRATION_HARNESS, /DRAFT-lot-theme-content-settings-v1\.sql/);
  assert.match(INTEGRATION_HARNESS, /DRAFT-lot-catalogue-product-reorder-v1\.sql/);
  assert.match(INTEGRATION_HARNESS, /DRAFT-lot-customer-billing-profile-v2\.sql/);
  // Et il PROUVE le sens unique de l'ordre plutôt que de le supposer.
  assert.match(INTEGRATION_HARNESS, /facturation AVANT Theme : ÉCHEC FERMÉ/);
});

// ==================================================================
// 5. FIDÉLITÉ À LA FACTURATION AUDITÉE (CBP-01 / CBP-02)
// ==================================================================

test("[INT-FIDELITY-1] CBP-01 : la composition typée de l'audit est intacte", () => {
  const lib = read("lib", "invoice-request.ts");
  const fn = lib.slice(
    lib.indexOf("export function composeBillingContactName"),
    lib.indexOf("export function deriveInvoiceAddressFromCustomer")
  );
  assert.match(fn, /if \(info\.invoiceType === "company"\)/);
  const companyBranch = fn.slice(fn.indexOf('if (info.invoiceType === "company")'), fn.indexOf("const own ="));
  assert.ok(!/firstName|lastName|fallback/.test(companyBranch));
});

test("[INT-FIDELITY-2] CBP-02 : la structure transactionnelle de l'audit est intacte", () => {
  const statements = BILLING_ROLLBACK.split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("--"));
  assert.equal(statements[0], "begin;");
  assert.equal(statements[statements.length - 1], "commit;");
  const locks = statements.filter((l) => /^lock table /.test(l));
  assert.equal(locks.length, 2);
  for (const lock of locks) assert.match(lock, /in share mode;$/);
  const firstGuard = statements.findIndex((l) => l.startsWith("do $$"));
  for (const lock of locks) assert.ok(statements.indexOf(lock) < firstGuard);
});
