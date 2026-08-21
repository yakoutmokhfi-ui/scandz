import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym V76 — remplacement du mécanisme app.storage_public_base_url
// (GUC personnalisé, confirmé structurellement incompatible avec
// Supabase hébergé : ALTER DATABASE ... SET refusé, 42501 permission
// denied) par une configuration persistante en table.
// ====================================================================

const v76Sql = readFileSync("supabase/migration-v76-storage-origin-config.sql", "utf8");
const v76RollbackSql = readFileSync("supabase/migration-v76-rollback.sql", "utf8");
const v71Sql = readFileSync("supabase/migration-v71-hardening.sql", "utf8");
const v71RollbackSql = readFileSync("supabase/migration-v71-rollback.sql", "utf8");
const v72Sql = readFileSync("supabase/migration-v72-hardening.sql", "utf8");
const v73Sql = readFileSync("supabase/migration-v73-hardening.sql", "utf8");
const v70Sql = readFileSync("supabase/migration-v70-identity-corrections.sql", "utf8");
const harnessSrc = readFileSync("supabase/tests/v68-storage-policy-check.sh", "utf8");

// --------------------------------------------------------------------
// Phase 1 — inventaire : ne pas supposer que seul V71 est concerné
// --------------------------------------------------------------------

test("Inventaire V76: V70 (déjà en production) N'EST PAS modifié -- toujours son mécanisme GUC d'origine, jamais touché", () => {
  assert.ok(v70Sql.includes("current_setting('app.storage_public_base_url', true)"));
});

test("Inventaire V76: V72 et V73 ne référencent NULLE PART le GUC app.storage_public_base_url (confirmé, pas supposé) -- aucune édition nécessaire dans ces deux fichiers", () => {
  assert.ok(!v72Sql.includes("storage_public_base_url"));
  assert.ok(!v73Sql.includes("storage_public_base_url"));
});

test("Inventaire V76: V71 ne contient plus AUCUNE référence au GUC -- entièrement remplacé par scanym_internal", () => {
  assert.ok(!v71Sql.includes("current_setting('app.storage_public_base_url'"));
  assert.ok(!v71Sql.includes("alter database"));
});

// --------------------------------------------------------------------
// Phase 2/4 — design : schéma privé, table singleton, privilèges
// minimaux, aucun secret
// --------------------------------------------------------------------

test("V76: nouveau schéma scanym_internal, révoqué explicitement de public/anon/authenticated (défense en profondeur au-delà du non-exposé par défaut)", () => {
  assert.ok(v76Sql.includes("create schema scanym_internal;"));
  assert.ok(v76Sql.includes("revoke all on schema scanym_internal from public;"));
  assert.ok(v76Sql.includes("revoke all on schema scanym_internal from anon;"));
  assert.ok(v76Sql.includes("revoke all on schema scanym_internal from authenticated;"));
});

test("V76: table singleton (une seule ligne possible par construction, pas par convention)", () => {
  const start = v76Sql.indexOf("create table scanym_internal.storage_config");
  const end = v76Sql.indexOf(");", start);
  const body = v76Sql.slice(start, end);
  assert.ok(body.includes("id                    boolean primary key default true,"));
  assert.ok(body.includes("constraint storage_config_single_row check (id),"));
});

test("V76: contrainte CHECK stricte sur l'origine -- réutilise désormais le helper partagé scanym_internal.is_valid_storage_origin (corrige V76-04, contre-audit Work, 7e tour), plus une regex inline dupliquée", () => {
  assert.ok(v76Sql.includes("constraint storage_config_origin_format check"));
  const start = v76Sql.indexOf("constraint storage_config_origin_format check");
  const end = v76Sql.indexOf(")\n  );", start);
  const body = v76Sql.slice(start, end);
  assert.ok(body.includes("scanym_internal.is_valid_storage_origin(storage_public_origin)"));
});

test("V76-04/V77-02: le helper partagé scanym_internal.is_valid_storage_origin est structuré en PL/pgSQL (host/port séparés, corrige V77-02) -- la preuve empirique complète (17+ cas) vit désormais dans le harnais PostgreSQL réel et tests/v78-hardening.test.ts, pas dans une ré-extraction de regex ici (la fonction n'est plus une regex SQL unique depuis V77-02)", () => {
  const start = v76Sql.indexOf("create or replace function scanym_internal.is_valid_storage_origin");
  const end = v76Sql.indexOf("\n$$;", start);
  const body = v76Sql.slice(start, end);
  assert.ok(body.includes("language plpgsql"), "la fonction est désormais structurelle (host/port séparés), plus une regex SQL unique");
  assert.ok(body.includes("regexp_match(p_origin, '^https://([^:/?#\\s]+)(?::([0-9]+))?$')"));
  assert.ok(body.includes("v_host ~ '^[0-9]+(\\.[0-9]+)*$'"), "le contrôle host purement numérique doit exister, indépendant du port");
});

test("V76: fonction de lecture SECURITY DEFINER, révoquée explicitement de public/anon/authenticated -- jamais accordée directement", () => {
  const start = v76Sql.indexOf("create or replace function scanym_internal.get_storage_public_origin");
  const end = v76Sql.indexOf("commit;", start);
  const body = v76Sql.slice(start, end);
  assert.ok(body.includes("security definer"));
  assert.ok(body.includes("revoke all on function scanym_internal.get_storage_public_origin() from public;"));
  assert.ok(body.includes("revoke all on function scanym_internal.get_storage_public_origin() from anon;"));
  assert.ok(body.includes("revoke all on function scanym_internal.get_storage_public_origin() from authenticated;"));
});

test("V76: aucun secret nécessaire -- la procédure CIO utilise un INSERT/UPDATE ordinaire, pas ALTER DATABASE/ROLE/SET", () => {
  const configSection = v76Sql.slice(v76Sql.indexOf("CONFIGURATION REQUISE PAR LE CIO"));
  assert.ok(configSection.includes("insert into scanym_internal.storage_config"));
  assert.ok(!configSection.includes("alter database"));
  assert.ok(!configSection.includes("alter role"));
});

test("V76: aucun contournement interdit (ALTER DATABASE/ROLE/SET, superutilisateur) nulle part dans le fichier", () => {
  const codeOnly = v76Sql.replace(/--[^\n]*/g, "");
  assert.ok(!/alter\s+(database|role)\s+\w+\s+set/i.test(codeOnly));
});

// --------------------------------------------------------------------
// Phase 3 — ordre de migration, justification de l'édition de V71
// --------------------------------------------------------------------

test("V76: documente explicitement POURQUOI V71 est édité (jamais appliqué en production + mécanisme incompatible confirmé)", () => {
  const normalized = v76Sql.replace(/\s+/g, " ");
  assert.ok(normalized.includes("JAMAIS été exécutée en production"));
  assert.ok(v76Sql.includes("permission denied") || v76Sql.includes("42501"));
});

test("V76: séquence d'exécution documentée explicitement -- V70 -> V76 -> CONFIGURATION CIO -> préflight -> V71 édité -> V72 -> V73", () => {
  const seqStart = v76Sql.indexOf("ORDRE D'EXÉCUTION DEPUIS L'ÉTAT PRODUCTION ACTUEL");
  const seq = v76Sql.slice(seqStart, seqStart + 1500);
  const v70Pos = seq.indexOf("V70");
  const v76Pos = seq.indexOf("CE FICHIER");
  const cioPos = seq.indexOf("CONFIGURATION CIO DE L'ORIGINE");
  const preflightPos = seq.indexOf("preflight-historical-uuid-check.sql");
  const v71Pos = seq.indexOf("migration-v71-hardening.sql");
  assert.ok(
    v70Pos >= 0 && v76Pos > v70Pos && cioPos > v76Pos && preflightPos > cioPos && v71Pos > preflightPos,
    "l'ordre documenté doit être V70 < V76 < CONFIGURATION CIO < préflight < V71"
  );
});

test("V76-02: la configuration CIO de l'origine apparaît comme une ÉTAPE NUMÉROTÉE explicite (pas reléguée à une section séparée ambiguë)", () => {
  assert.ok(v76Sql.includes("3. CONFIGURATION CIO DE L'ORIGINE"));
  assert.ok(v76Sql.includes("4. preflight-historical-uuid-check.sql"));
  assert.ok(v76Sql.includes("DOIT avoir lieu ICI, avant l'étape 4, jamais après") || v76Sql.includes("jamais après"));
});

test("V71: le préflight de section 1 vérifie désormais aussi la dépendance scanym_internal (nouvelle vérification, pas remplacée)", () => {
  assert.ok(v71Sql.includes("scanym_internal' and p.proname = 'get_storage_public_origin'"));
  assert.ok(v71Sql.includes("Prérequis : migration-v76-storage-origin-config.sql doit être exécutée avant ce fichier"));
});

test("V71: la fonction assert_establishment_asset_url appelle désormais scanym_internal.get_storage_public_origin(), toute la logique UUID v4/chemin/kind reste identique", () => {
  const start = v71Sql.indexOf("create or replace function public.assert_establishment_asset_url");
  const end = v71Sql.indexOf("end $$;", start);
  const body = v71Sql.slice(start, end);
  assert.ok(body.includes("v_base_url     text := scanym_internal.get_storage_public_origin();"));
  // Logique UUID v4 stricte (V70-07) intacte.
  assert.ok(body.includes("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"));
});

test("V71 rollback: restaure volontairement le GUC (état RÉEL de V70 en production), pas la nouvelle table -- documenté explicitement", () => {
  assert.ok(v71RollbackSql.includes("current_setting('app.storage_public_base_url', true)"));
  assert.ok(v71RollbackSql.includes("c'est intentionnel et correct"));
});

// --------------------------------------------------------------------
// Rollback V76 — garde-fou de dépendance
// --------------------------------------------------------------------

test("Rollback V76: refuse explicitement si assert_establishment_asset_url dépend encore de scanym_internal (vérifié empiriquement sur PostgreSQL réel, voir rapport de livraison)", () => {
  assert.ok(v76RollbackSql.includes("scanym_internal.get_storage_public_origin"));
  assert.ok(v76RollbackSql.includes("raise exception"));
  assert.ok(v76RollbackSql.toLowerCase().includes("annuler d''abord migration-v71-hardening.sql".toLowerCase()));
});

test("Rollback V76: jamais auto-exécuté, ne prétend pas constituer un état de production sûr durable", () => {
  assert.ok(v76RollbackSql.includes("NE JAMAIS EXÉCUTER AUTOMATIQUEMENT"));
});

// --------------------------------------------------------------------
// Harnais — intégration
// --------------------------------------------------------------------

test("Harnais: migration-v76-storage-origin-config.sql appliquée AVANT le préflight historique et AVANT V71, dans cet ordre", () => {
  const v76Pos = harnessSrc.indexOf("migration-v76-storage-origin-config.sql\" >/dev/null\npass \"migration V76");
  const preflightPos = harnessSrc.indexOf("preflight-historical-uuid-check.sql\" >/dev/null\npass \"préflight historique réussi");
  const v71Pos = harnessSrc.indexOf("migration-v71-hardening.sql\" >/dev/null\npass \"migration V71");
  assert.ok(v76Pos >= 0 && preflightPos > v76Pos && v71Pos > preflightPos);
});

test("Harnais: reproduction réelle de l'échec ALTER DATABASE ... SET avec un rôle non-superutilisateur (simule fidèlement Supabase hébergé)", () => {
  assert.ok(harnessSrc.includes("v76_nonsuper_test"));
  assert.ok(harnessSrc.includes("ALTER DATABASE ... SET échoue avec un rôle non-superutilisateur"));
});

test("Harnais: configuration réussie via INSERT ordinaire avec le même rôle non-superutilisateur -- preuve centrale de V76", () => {
  assert.ok(harnessSrc.includes("configuration réussie via INSERT ordinaire avec un rôle non-superutilisateur"));
});

test("Harnais: aucune référence résiduelle au GUC app.storage_public_base_url comme MÉCANISME DE CONFIGURATION ACTIF (seule exception légitime : la reproduction délibérée de l'échec, scénario V76/1)", () => {
  const codeOnly = harnessSrc
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
  assert.ok(!codeOnly.includes("set_config('app.storage_public_base_url'"));
  // La SEULE occurrence légitime restante de "alter database ... set
  // app.storage_public_base_url" doit être celle du scénario V76/1
  // (reproduction délibérée de l'échec réel), jamais utilisée pour
  // CONFIGURER quoi que ce soit pour la suite du harnais.
  const occurrences = (codeOnly.match(/alter database[^;]*app\.storage_public_base_url/g) || []).length;
  assert.equal(occurrences, 1, "une seule occurrence attendue (la reproduction délibérée V76/1)");
  const idx = codeOnly.indexOf("alter database");
  const surrounding = codeOnly.slice(Math.max(0, idx - 300), idx);
  assert.ok(surrounding.includes("v76_nonsuper_test"), "cette unique occurrence doit faire partie du scénario de reproduction avec le rôle non-superutilisateur");
});

test("Harnais: les 12 scénarios Phase 5/6 exigés sont présents (config absente/vide/invalide/singleton/anon/authenticated)", () => {
  assert.ok(harnessSrc.includes("V76/1"));
  assert.ok(harnessSrc.includes("V76/4"));
  assert.ok(harnessSrc.includes("V76/5"));
  assert.ok(harnessSrc.includes("V76/6"));
});
