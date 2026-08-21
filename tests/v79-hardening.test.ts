import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym V79 — correction finale ciblée après contre-audit Work sur
// V78 (finding unique : le contrôle anti-dérive V70 complet arrivait
// trop tard, dans migration-v71-hardening.sql, alors que
// migration-v76-storage-origin-config.sql est la PREMIÈRE migration
// réellement exécutée depuis l'état production actuel).
// ====================================================================

const v76Sql = readFileSync("supabase/migration-v76-storage-origin-config.sql", "utf8");
const v71Sql = readFileSync("supabase/migration-v71-hardening.sql", "utf8");
const harnessSrc = readFileSync("supabase/tests/v68-storage-policy-check.sh", "utf8");

function extractPreflightBlock(sql: string): string {
  const start = sql.indexOf("do $$");
  const end = sql.indexOf("end $$;", start);
  return sql.slice(start, end);
}

test("V78-01: migration-v76-storage-origin-config.sql contient désormais le contrôle structurel COMPLET (signature, overload, type de retour, volatilité, SECURITY DEFINER, search_path, propriétaire, marqueur V70) -- pas seulement une vérification d'existence par nom", () => {
  const block = extractPreflightBlock(v76Sql);
  assert.ok(block.includes("pg_get_function_identity_arguments(v_oid) != 'p_restaurant_id uuid, p_kind text, p_url text'"), "signature exacte");
  assert.ok(block.includes("if v_count > 1 then"), "absence de surcharge");
  assert.ok(block.includes("prorettype::regtype::text"), "type de retour");
  assert.ok(block.includes("provolatile"), "volatilité");
  assert.ok(block.includes("prosecdef"), "SECURITY DEFINER");
  assert.ok(block.includes("pg_get_userbyid(proowner)"), "propriétaire");
  assert.ok(block.includes("'search_path=\"\"' = any(proconfig)"), "search_path");
  assert.ok(block.includes("pg_get_functiondef(v_oid)") && block.includes("current_setting\\(''app\\.storage_public_base_url''"), "marqueur caractéristique V70");
  assert.ok(!/md5\(|sha256\(|digest\(/i.test(block), "aucun hash du corps SQL formaté");
});

test("V78-01: ce contrôle structurel complet précède TOUTE création de schéma/fonction/table dans migration-v76-storage-origin-config.sql", () => {
  const driftCheckEnd = v76Sql.indexOf("end $$;", v76Sql.indexOf("do $$"));
  const createSchemaIdx = v76Sql.indexOf("create schema scanym_internal;");
  const createFunctionIdx = v76Sql.indexOf("create or replace function scanym_internal");
  const createTableIdx = v76Sql.indexOf("create table scanym_internal.storage_config");
  assert.ok(driftCheckEnd > 0 && createSchemaIdx > driftCheckEnd, "CREATE SCHEMA doit venir APRÈS le contrôle structurel complet");
  assert.ok(createFunctionIdx > driftCheckEnd, "CREATE FUNCTION doit venir APRÈS le contrôle structurel complet");
  assert.ok(createTableIdx > driftCheckEnd, "CREATE TABLE doit venir APRÈS le contrôle structurel complet");
});

test("V78-01: le contrôle de migration-v71-hardening.sql reste en place comme défense en profondeur (jamais retiré)", () => {
  const block = extractPreflightBlock(v71Sql);
  assert.ok(block.includes("pg_get_function_identity_arguments(v_oid) != 'p_restaurant_id uuid, p_kind text, p_url text'"));
  assert.ok(block.includes("prorettype::regtype::text"));
  assert.ok(block.includes("prosecdef"));
});

test("V78-01: les 7 scénarios de dérive exigés sont testés RÉELLEMENT contre migration-v76-storage-origin-config.sql elle-même dans le harnais PostgreSQL (pas seulement contre V71)", () => {
  const requiredScenarios = [
    "mauvaise signature (arité différente)",
    "overload (deuxième fonction du même nom)",
    "mauvais type de retour (boolean au lieu de void)",
    "non SECURITY DEFINER",
    "mauvais search_path (absent)",
    "mauvaise volatilité (volatile au lieu de stable)",
    "corps V70 dérivé (marqueur caractéristique absent)",
  ];
  const v78Section = harnessSrc.slice(
    harnessSrc.indexOf("V78-01 : 7 scénarios de dérive V70"),
    harnessSrc.indexOf("V76/1 : reproduction de l'échec ALTER DATABASE")
  );
  for (const s of requiredScenarios) {
    assert.ok(v78Section.includes(s), `scénario manquant dans la section V78-01 du harnais : ${s}`);
  }
  // Chaque scénario doit vérifier explicitement l'ABSENCE de
  // scanym_internal après l'échec, pas seulement la levée de
  // l'exception.
  assert.ok(v78Section.includes("scanym_internal absent (rien créé)"));
  assert.ok(v78Section.includes("select count(*) from pg_namespace where nspname='scanym_internal'"));
});

test("V78-01: la section V78-01 du harnais s'exécute AVANT la section V76 (application réelle de la migration) -- ordre correct dans le fichier lui-même", () => {
  const v78Pos = harnessSrc.indexOf("V78-01 : 7 scénarios de dérive V70");
  const v76ApplyPos = harnessSrc.indexOf("V76/1 : reproduction de l'échec ALTER DATABASE");
  assert.ok(v78Pos >= 0 && v76ApplyPos > v78Pos);
});

test("Non-régression: aucun autre comportement V78 déjà validé n'est modifié -- les messages d'erreur référencent bien 'migration V76', pas 'migration V71', dans ce nouveau bloc", () => {
  const block = extractPreflightBlock(v76Sql);
  assert.ok(block.includes("migration V76 annulée"));
  assert.ok(!block.includes("migration V71 annulée"), "les messages d'erreur de CE fichier doivent référencer V76, pas V71");
});
