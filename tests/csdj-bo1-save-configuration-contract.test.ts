import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// lib/supabase.ts jette au chargement sans ces variables.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

import { CSDJ_BO1_WRITE_CONTRACT } from "../lib/availability-editor.ts";

// ====================================================================
// CSDJ-BO-1 (#148) — POSTURE STRUCTURELLE de save_fulfillment_configuration.
//
// Ces tests ne remplacent PAS le banc PostgreSQL
// (supabase/tests/csdj-bo1-save-configuration-check.sh) : ils épinglent, sans
// base, ce qu'un relecteur doit voir d'un coup d'œil dans les fichiers livrés
// et que la page ne doit pas devancer.
// ====================================================================

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const SQL = read("supabase/DRAFT-lot-csdj-bo1-save-fulfillment-configuration-v1.sql");
/** Le SQL sans ses commentaires de ligne (les contrôles portent sur le code, pas sur la prose). */
const CODE = SQL.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const RB = read("supabase/DRAFT-lot-csdj-bo1-save-fulfillment-configuration-v1-rollback.sql");
const DOC = read("docs/scheduling/csdj-bo1-save-fulfillment-configuration-contract.md");

/** Corps de la fonction `name` : du `create function` au `$tag;` fermant. */
function bodyOf(name: string): string {
  const start = SQL.indexOf(`create function public.${name}(`);
  assert.ok(start >= 0, `create function public.${name} introuvable`);
  const dollar = SQL.indexOf("as $", start);
  const tag = SQL.slice(dollar + 3, SQL.indexOf("$", dollar + 4) + 1);
  const end = SQL.indexOf(`${tag};`, SQL.indexOf(tag, dollar + 3 + tag.length));
  assert.ok(end > start, `fin de ${name} introuvable`);
  return SQL.slice(start, end);
}

test("[BO1-RPC-1] les contrats d'écriture restent FERMÉS côté page tant que l'audit et le GO manquent", () => {
  assert.equal(CSDJ_BO1_WRITE_CONTRACT.available, false);
  assert.equal(CSDJ_BO1_WRITE_CONTRACT.requestedContract, "save_fulfillment_configuration");
});

test("[BO1-RPC-2] aucun code applicatif n'appelle la RPC (pas de SQL navigateur, pas d'écriture câblée)", () => {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(path.join(ROOT, dir))) {
      const rel = path.join(dir, e);
      if (e === "node_modules" || e === ".next" || e === ".git") continue;
      const st = statSync(path.join(ROOT, rel));
      if (st.isDirectory()) walk(rel);
      else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e) && readFileSync(path.join(ROOT, rel), "utf8").match(/\.rpc\(\s*["'`](save|get)_fulfillment_configuration/)) {
        hits.push(rel);
      }
    }
  };
  for (const d of ["app", "components", "lib"]) walk(d);
  // INTÉGRATION (#153) : l'éditeur Nougaro appelle désormais la RPC, mais par UN SEUL point d'entrée -- le service
  // lib/services/availability.ts -- et JAMAIS depuis une page ou un composant. L'invariant d'origine (pas d'appel
  // câblé hors du verrou) est conservé par [BO1-RPC-2b] : l'écriture reste derrière CSDJ_BO1_WRITE_CONTRACT.available.
  assert.deepEqual(hits, ["lib/services/availability.ts"]);
});

test("[BO1-RPC-2b] l'unique appel d'écriture est derrière le verrou CSDJ_BO1_WRITE_CONTRACT.available (false)", () => {
  assert.equal(CSDJ_BO1_WRITE_CONTRACT.available, false);
  const svc = read("lib/services/availability.ts");
  const code = svc.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
  const calls = [...code.matchAll(/\.rpc\(\s*["'`]save_fulfillment_configuration/g)];
  assert.equal(calls.length, 1, "exactement un appel d'écriture");
  const guard = code.indexOf("if (!CSDJ_BO1_WRITE_CONTRACT.available)");
  assert.ok(guard >= 0, "le verrou available est vérifié");
  assert.ok(guard < calls[0].index!, "le verrou précède l'appel d'écriture");
  assert.doesNotMatch(code, /\.rpc\(\s*["'`]mutate_merchant_fulfillment_schedule/);
});

test("[BO1-RPC-3] SECURITY DEFINER, search_path vide, sur les trois fonctions", () => {
  for (const f of ["csdjbo1_persisted_configuration", "save_fulfillment_configuration", "get_fulfillment_configuration"]) {
    const b = bodyOf(f);
    assert.match(b, /security definer/i, f);
    assert.match(b, /set search_path = ''/i, f);
  }
});

test("[BO1-RPC-4] ACL : tout révoqué, puis authenticated sur save+get UNIQUEMENT", () => {
  assert.match(SQL, /revoke all on function public\.save_fulfillment_configuration\(uuid,jsonb\) from public, anon, authenticated, service_role;/);
  assert.match(SQL, /revoke all on function public\.get_fulfillment_configuration\(uuid,text,uuid\) from public, anon, authenticated, service_role;/);
  assert.match(SQL, /revoke all on function public\.csdjbo1_persisted_configuration\(uuid,text,uuid\) from public, anon, authenticated, service_role;/);
  const grants = [...SQL.matchAll(/^grant execute on function ([^\n]+?) to ([a-z_, ]+);/gm)].map((m) => `${m[1]}->${m[2]}`);
  assert.deepEqual(grants.sort(), [
    "public.get_fulfillment_configuration(uuid,text,uuid)->authenticated",
    "public.save_fulfillment_configuration(uuid,jsonb)->authenticated",
  ]);
  assert.doesNotMatch(CODE, /^grant [^;]* to [^;]*\b(anon|public|service_role)\b/im);
});

test("[BO1-RPC-5] verrou de tenant graine 1104 : le même que les mutateurs historiques", () => {
  assert.match(bodyOf("save_fulfillment_configuration"), /hashtextextended\(p_restaurant_id::text, 1104\)/);
});

test("[BO1-RPC-6] les trois codes nommés existent dans la RPC et dans le contrat documenté", () => {
  for (const code of ["CSDJBO1_INCOMPLETE_CONFIGURATION", "CSDJBO1_STALE_CONFIGURATION", "CSDJBO1_METHOD_MISMATCH"]) {
    assert.ok(bodyOf("save_fulfillment_configuration").includes(code), `${code} absent de la RPC`);
    assert.ok(DOC.includes(code), `${code} absent du contrat`);
  }
});

test("[BO1-RPC-7] aucun compte de capacité n'est renvoyé et aucune valeur par défaut globale n'est semée", () => {
  const b = bodyOf("csdjbo1_persisted_configuration");
  assert.doesNotMatch(b, /order_fulfillment_capacity_reservation/);
  assert.doesNotMatch(SQL, /\binsert\s+into\s+public\.(public_holiday_calendar|restaurant_fulfillment_schedule)\b[^;]*select\s+[^;]*\bfrom\s+public\.restaurants\b/i);
  assert.doesNotMatch(CODE, /Au Lait Cru/i);
});

test("[BO1-RPC-8] retour arrière : trois fonctions, aucune donnée, gardes nommées", () => {
  assert.equal([...RB.matchAll(/^drop function /gm)].length, 3);
  assert.doesNotMatch(RB, /\b(delete\s+from|truncate|update\s+public\.)/i);
  for (const g of ["NOT_APPLICABLE", "DEPENDENT", "CALLER", "CRON_JOB"]) assert.ok(RB.includes(`[${g}]`), g);
});

test("[BO1-RPC-9] le lot ne réapplique ni CSDJ-1, ni v1.2, ni CSDJ-3", () => {
  assert.doesNotMatch(SQL, /create (or replace )?function public\.(mutate_merchant_fulfillment_schedule|replace_|delete_schedule|get_merchant_fulfillment_schedules)/);
  assert.doesNotMatch(SQL, /create table|alter table|create policy|create trigger/i);
});
