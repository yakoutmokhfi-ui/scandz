import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";

/**
 * DELIVERY PRICING v2 — B1 — ORDER DELIVERY FULFILLMENT SNAPSHOT v1 —
 * preuves STRUCTURELLES sur le texte de migration (contrat Debussy,
 * CONTRACT_SHA256 aac856732ff48aef5b69bcf6c65fb91a88754e95756587512ed0b453e28ec517).
 *
 * Le comportement réel (B1-T-01..16, B1-X-01..18, B1-T-21/23/24) est
 * éprouvé sur PostgreSQL réel par
 * supabase/tests/delivery-pricing-v2-b1-order-snapshot-v1-check.sh.
 * Ce fichier fige ce qui se lit dans le texte :
 *
 *   1. DELTA UNIQUE ET ANCRÉ (§7) : le corps de create_order de la
 *      migration est EXACTEMENT celui de
 *      DRAFT-lot-product-service-modes-v1.sql (définition constatée en
 *      Production, G-1) plus le seul bloc §7.2, inséré après l'update
 *      public.orders et avant le return query. Le rollback restaure ce
 *      corps SANS le bloc, octet pour octet.
 *   2. INTERDITS du contrat : aucun backfill (§11.2), aucune FK vers la
 *      configuration (D-B1-3), aucun CHECK énuméré (§6.2), aucun CHECK
 *      iff matched_prefix/is_fallback (§8.4), resolve_delivery_fulfillment
 *      et purge_old_customer_data non redéfinis.
 *   3. PRIVILÈGES (§12) : revoke all nomme service_role ; seul grant =
 *      select à authenticated.
 *   4. ATOMICITÉ (§11.1) : préflight, DDL, post-contrôles dans une seule
 *      transaction ; commit est la dernière instruction.
 *   5. NON-RÉGRESSION DES CONSOMMATEURS : B1-T-20 (CreatedOrder
 *      inchangé), B1-T-22 (colonnes de getDashboardOrders inchangées),
 *      aucune surface applicative ne lit l'instantané (§12.1).
 */

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const forwardSql = read("supabase/DRAFT-lot-delivery-pricing-v2-b1-order-snapshot-v1.sql");
const rollbackSql = read("supabase/DRAFT-lot-delivery-pricing-v2-b1-order-snapshot-v1-ROLLBACK.sql");
const liveSql = read("supabase/DRAFT-lot-product-service-modes-v1.sql");

const FN_START = "create or replace function public.create_order(";
const FN_END = "\nend $$;\n";

/** Instruction create or replace function public.create_order(...) complète. */
function extractCreateOrder(sql: string): string {
  const start = sql.indexOf(FN_START);
  assert.ok(start > -1, "définition de create_order introuvable");
  assert.equal(sql.indexOf(FN_START, start + 1), -1, "plus d'une définition de create_order dans le fichier");
  const end = sql.indexOf(FN_END, start);
  assert.ok(end > start, "fin de la définition de create_order introuvable");
  return sql.slice(start, end + FN_END.length);
}

const ANCHOR = "      provider_code = v_provider_code\n  where id = v_order_id;\n";
const DELTA_START = "\n  -- B1 — INSTANTANÉ IMMUABLE DE LA DÉCISION DE LIVRAISON.\n";
const DELTA_END = "      v_resolved.customer_text\n    );\n  end if;\n";

const liveFn = extractCreateOrder(liveSql);
const forwardFn = extractCreateOrder(forwardSql);
const rollbackFn = extractCreateOrder(rollbackSql);

function splitDelta(fn: string): { before: string; delta: string; after: string } {
  const a = fn.indexOf(ANCHOR);
  assert.ok(a > -1, "ancre update public.orders introuvable");
  const deltaAt = a + ANCHOR.length;
  assert.equal(fn.slice(deltaAt, deltaAt + DELTA_START.length), DELTA_START, "le bloc B1 ne suit pas immédiatement l'ancre");
  const z = fn.indexOf(DELTA_END, deltaAt);
  assert.ok(z > deltaAt, "fin du bloc B1 introuvable");
  const end = z + DELTA_END.length;
  return { before: fn.slice(0, deltaAt), delta: fn.slice(deltaAt, end), after: fn.slice(end) };
}

/** Instructions SQL exécutables, sans commentaires ni lignes vides (hors corps $$). */
function codeOutsideFunctions(sql: string): string {
  return sql
    .replace(/\$\$[\s\S]*?\$\$/g, "$$…$$")
    .split("\n")
    .filter((l) => !l.trim().startsWith("--") && l.trim() !== "")
    .join("\n");
}

test("B1 — §7 delta unique : corps live + bloc §7.2, octet pour octet", () => {
  const { before, delta, after } = splitDelta(forwardFn);
  assert.equal(before + after, liveFn, "hors bloc §7.2, create_order doit être la définition live à l'octet près");
  assert.ok(after.startsWith("\n  return query select v_order_id"), "le bloc B1 doit précéder immédiatement le return query final");
  assert.equal((forwardFn.match(/insert into public\.order_delivery_fulfillment_snapshot/g) ?? []).length, 1);
  assert.match(delta, /^\s*if v_fulfillment_rule_id is not null then$/m, "garde exacte du §7.2");
  assert.match(delta, /using errcode = '22023'/);
  assert.match(delta, /SCANYM_DELIVERY_SNAPSHOT_INCONSISTENT/);
  // B1-I-06 : alimentation EXCLUSIVE par v_resolved, aucune relecture.
  assert.doesNotMatch(delta, /\bfrom\s+public\./i, "le bloc B1 ne doit relire aucune table");
  assert.doesNotMatch(delta, /\bselect\b/i, "le bloc B1 ne doit contenir aucun select (insert ... values uniquement)");
  for (const col of ["is_fallback", "matched_prefix", "pricing_mode", "fixed_fee", "free_threshold", "customer_text"]) {
    assert.ok(delta.includes(`v_resolved.${col},`) || delta.includes(`v_resolved.${col}\n`), `valeur ${col} issue de v_resolved`);
  }
});

test("B1 — rollback : restaure la définition live SANS le bloc, et rien d'autre", () => {
  assert.equal(rollbackFn, liveFn);
  assert.doesNotMatch(rollbackFn, /order_delivery_fulfillment_snapshot/);
  assert.match(rollbackSql, /^drop table public\.order_delivery_fulfillment_snapshot;$/m);
  assert.ok(
    rollbackSql.indexOf(FN_START) < rollbackSql.indexOf("drop table public.order_delivery_fulfillment_snapshot;"),
    "create_order doit cesser de référencer la table avant son drop"
  );
  assert.equal((rollbackSql.match(/p\.proname = 'create_order'/g) ?? []).length, 2, "count(*) = 1 avant ET après");
});

test("B1 — arité et table de retour de create_order inchangées", () => {
  const header = (fn: string) => fn.slice(0, fn.indexOf("as $$"));
  assert.equal(header(forwardFn), header(liveFn));
  assert.match(forwardFn, /p_cgv_accepted  boolean default false\n\)/);
  assert.match(
    forwardFn,
    /returns table \(order_id uuid, order_number bigint, public_token uuid, subtotal numeric, delivery_fee numeric, total numeric\)/
  );
  assert.doesNotMatch(forwardSql, /drop function/i, "aucun drop de fonction");
  assert.doesNotMatch(codeOutsideFunctions(forwardSql), /grant execute|revoke all on function/i, "aucun grant de fonction à reposer");
});

test("B1 — préflight P-1..P-7 et post-contrôles P-8 présents, fail-closed", () => {
  for (const p of ["P-1", "P-2", "P-3", "P-4", "P-5", "P-6", "P-7", "P-8"]) {
    assert.ok(forwardSql.includes(`[${p}]`), `contrôle ${p} absent`);
  }
  assert.match(forwardSql, /p\.proname = 'create_order';\n  if v_count <> 1 then/);
  assert.ok(forwardSql.includes("to_regprocedure('public.create_order(text, text, jsonb, integer, jsonb, text, text, boolean)')"));
  assert.ok(forwardSql.includes("to_regprocedure('public.resolve_delivery_fulfillment(uuid, text, text, integer, numeric)')"));
  assert.ok(forwardSql.indexOf("[P-7]") < forwardSql.indexOf("create table public.order_delivery_fulfillment_snapshot (\n  order_id"));
  assert.ok(forwardSql.indexOf(FN_START) < forwardSql.indexOf("[P-8]"));
});

test("B1 — atomicité : une seule transaction, commit en dernière instruction", () => {
  for (const sql of [forwardSql, rollbackSql]) {
    const code = codeOutsideFunctions(sql).split("\n").map((l) => l.trim());
    assert.equal(code[0], "begin;");
    assert.equal(code[code.length - 1], "commit;");
    assert.equal(code.filter((l) => l === "begin;").length, 1);
    assert.equal(code.filter((l) => l === "commit;").length, 1);
  }
});

test("B1 — interdits du contrat : backfill, FK vers la configuration, CHECK énuméré, CHECK iff", () => {
  const code = codeOutsideFunctions(forwardSql);
  assert.doesNotMatch(forwardSql, /insert\s+into\s+public\.order_delivery_fulfillment_snapshot[^;]*\bselect\b/i, "aucun insert ... select (backfill)");
  assert.doesNotMatch(code, /insert\s+into/i, "aucune écriture hors create_order");
  assert.doesNotMatch(code, /references\s+public\.restaurant_sale_mode_fulfillments/i, "aucune FK vers la configuration (D-B1-3)");
  assert.equal((code.match(/references /g) ?? []).length, 1, "une seule FK : order_id -> orders(id)");
  assert.match(code, /references public\.orders\(id\) on delete cascade/);
  assert.doesNotMatch(code, /pricing_mode\s+in\s*\(/i, "aucun CHECK énuméré sur pricing_mode (§6.2)");
  assert.doesNotMatch(code, /provider\s+in\s*\(/i, "aucun CHECK énuméré sur provider (§6.2)");
  assert.doesNotMatch(code, /check\s*\(\s*\(?\s*matched_prefix is null\s*\)?\s*=\s*is_fallback/i, "aucun CHECK iff (§8.4)");
  assert.doesNotMatch(forwardSql, /function public\.resolve_delivery_fulfillment/i, "résolveur non redéfini");
  assert.doesNotMatch(forwardSql, /function public\.purge_old_customer_data/i, "purge non étendue (G-2)");
  assert.doesNotMatch(code, /alter table public\.orders/i, "orders non modifiée");
  assert.doesNotMatch(code, /create trigger/i, "aucun déclencheur (D-B1-6, Option 2 écartée)");
});

test("B1 — §12 : immuabilité par absence de grant, service_role nommé", () => {
  const code = codeOutsideFunctions(forwardSql);
  assert.match(code, /revoke all on public\.order_delivery_fulfillment_snapshot\n\s+from public, anon, authenticated, service_role;/);
  const grants = code.match(/^\s*grant .*$/gim) ?? [];
  assert.deepEqual(grants.map((g) => g.trim()), ["grant select on public.order_delivery_fulfillment_snapshot to authenticated;"]);
  assert.match(code, /enable row level security/);
  assert.ok(forwardSql.includes("revoke maintain on table public.order_delivery_fulfillment_snapshot"));
});

test("B1-T-20 — CreatedOrder inchangé : subtotal, deliveryFee, total", () => {
  const src = read("lib/services/orders.ts");
  const m = src.match(/export interface CreatedOrder \{([\s\S]*?)\n\}/);
  assert.ok(m, "interface CreatedOrder introuvable");
  const keys = [...m[1].matchAll(/^\s*(\w+)\??:/gm)].map((k) => k[1]);
  assert.deepEqual(keys, ["orderId", "orderNumber", "publicToken", "total", "subtotal", "deliveryFee"]);
});

test("B1-T-22 — getDashboardOrders : liste de colonnes inchangée, aucune requête ajoutée", () => {
  const src = read("lib/services/dashboard.ts");
  const m = src.match(/export async function getDashboardOrders\([\s\S]*?\.select\(\s*`([\s\S]*?)`/);
  assert.ok(m, "select de getDashboardOrders introuvable");
  const columns = m[1].replace(/\s+/g, " ").trim();
  // Empreinte de la liste figée sur la base 497efb9 (avant B1).
  assert.equal(
    createHash("sha256").update(columns).digest("hex"),
    "b374d168a88088b6b84e6c4e9bc3fb7d550a29dfa3ab070fead5771e3bdf6b64",
    `liste de colonnes modifiée : ${columns}`
  );
  assert.doesNotMatch(columns, /order_delivery_fulfillment_snapshot/);
});

test("B1 — §12.1 : aucune surface applicative ne lit l'instantané", () => {
  const hits: string[] = [];
  const walk = (dir: URL) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const child = new URL(`${name}${statSync(new URL(name, dir)).isDirectory() ? "/" : ""}`, dir);
      if (child.pathname.endsWith("/")) walk(child);
      else if (/\.(ts|tsx|js|mjs)$/.test(name) && readFileSync(child, "utf8").includes("order_delivery_fulfillment_snapshot")) {
        hits.push(child.pathname);
      }
    }
  };
  for (const dir of ["app/", "components/", "lib/"]) walk(new URL(`../${dir}`, import.meta.url));
  assert.deepEqual(hits, []);
});
