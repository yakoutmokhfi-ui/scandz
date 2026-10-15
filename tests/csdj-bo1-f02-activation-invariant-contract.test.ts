import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// lib/supabase.ts jette au chargement sans ces variables.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

import { CSDJ_BO1_WRITE_CONTRACT } from "../lib/availability-editor.ts";

// ====================================================================
// CSDJ-BO-1 — REMÉDIATION F-02 : POSTURE STRUCTURELLE de l'invariant d'activation.
// Ne remplace PAS le banc PostgreSQL
// (supabase/tests/csdj-bo1-f02-activation-invariant-check.sh) : il épingle, sans base,
// ce qu'un relecteur doit voir d'un coup d'œil dans les fichiers livrés.
// ====================================================================

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const strip = (s: string) => s.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const SQL = read("supabase/DRAFT-lot-csdj-bo1-f02-activation-invariant-v1.sql");
const CODE = strip(SQL);
const RB = strip(read("supabase/DRAFT-lot-csdj-bo1-f02-activation-invariant-v1-rollback.sql"));
const DOC = read("docs/scheduling/csdj-bo1-f02-activation-invariant.md");

test("[F02-1] le contrat d'écriture est OUVERT côté page depuis #154 (le lot F-02 est installé)", () => {
  assert.equal(CSDJ_BO1_WRITE_CONTRACT.available, true);
});

test("[F02-2] le lot ne crée que ses 2 fonctions et ses 4 déclencheurs de contrainte différés", () => {
  const creates = CODE.match(/^create (or replace )?(function|constraint trigger) [^\n(]+/gim) ?? [];
  assert.equal(creates.length, 6);
  assert.equal((CODE.match(/^create constraint trigger csdjbo1_f02_activation_invariant\b/gim) ?? []).length, 4);
  assert.equal((CODE.match(/deferrable initially deferred/gi) ?? []).length, 4);
  assert.equal((CODE.match(/for each row/gi) ?? []).length, 4);
});

test("[F02-3] aucun ALTER / DROP / DELETE / TRUNCATE / GRANT : le lot ne touche aucun objet audité", () => {
  assert.doesNotMatch(CODE, /^\s*(alter |drop |delete |truncate |grant )/im);
  assert.doesNotMatch(CODE, /create (or replace )?function public\.(mutate_merchant_fulfillment_schedule|save_fulfillment_configuration|create_order)/i);
});

test("[F02-4] fonctions SECURITY DEFINER, search_path vide, fermées à tous les rôles applicatifs", () => {
  assert.equal((CODE.match(/^security definer$/gim) ?? []).length, 2);
  assert.equal((CODE.match(/set search_path = ''/gi) ?? []).length, 2);
  for (const fn of ["csdjbo1_f02_scope_blockers(uuid,text,uuid)", "csdjbo1_f02_enforce()"]) {
    assert.match(CODE, new RegExp(`revoke all on function public\\.${fn.replace(/[()]/g, "\\$&")} from public, anon, authenticated, service_role`, "i"));
  }
});

test("[F02-5] même verrou de tenant que les mutateurs et la RPC (graine 1104), même code de refus (23514)", () => {
  assert.match(CODE, /pg_advisory_xact_lock\(\s*pg_catalog\.hashtextextended\(v_rid\[i\]::text,\s*1104\)\s*\)/);
  assert.match(CODE, /CSDJBO1_INCOMPLETE_CONFIGURATION/);
  assert.match(CODE, /errcode = '23514'/);
});

test("[F02-6] le retour arrière ne supprime que les objets du lot", () => {
  assert.equal((RB.match(/^drop trigger /gim) ?? []).length >= 1, true);
  assert.equal((RB.match(/^drop function /gim) ?? []).length >= 1, true);
  assert.doesNotMatch(RB, /mutate_merchant_fulfillment_schedule\s*\(\s*uuid[^)]*\)\s*cascade/i);
  for (const tag of ["[NOT_APPLICABLE]", "[DEPENDENT]", "[CALLER]", "[CRON_JOB]"]) assert.ok(RB.includes(tag), `${tag} manquant`);
});

test("[F02-7] le document de remédiation dit ce qu'il fait ET ses limites", () => {
  for (const needle of ["F-02", "csdjbo1_f02_activation_invariant", "CSDJBO1_INCOMPLETE_CONFIGURATION", "delete_schedule", "TRUNCATE", "f02_require_clean", "CSDJ_BO1_WRITE_CONTRACT.available", "Retour arrière", "Limites"]) {
    assert.ok(DOC.includes(needle), `le document ne mentionne pas « ${needle} »`);
  }
});
