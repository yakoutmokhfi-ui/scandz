import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// Scanym — ORDERS OPERATOR READ v1 — tests structurels.
//
// Preuve statique sur le texte SOURCE du lot (le comportement RÉEL en
// base est prouvé par supabase/tests/orders-operator-read-v1-check.sh,
// le comportement de la page par
// tests/restaurant-context-critical-regression-gate-orders.dom.test.ts).
// ====================================================================

// Fins de ligne normalisées : sur un checkout Windows (core.autocrlf),
// les délimiteurs "\n}\n" ci-dessous ne seraient sinon jamais trouvés.
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const SQL = read("supabase/DRAFT-lot-orders-operator-read-v1.sql");
const ROLLBACK = read("supabase/DRAFT-lot-orders-operator-read-v1-rollback.sql");
const SERVICE = read("lib/services/dashboard.ts");
const PAGE = read("app/dashboard/page.tsx");
const LIST = read("components/dashboard/OperatorOrderList.tsx");

const stripSqlComments = (s: string) => s.replace(/--[^\n]*/g, "");
const SQL_CODE = stripSqlComments(SQL).toLowerCase();

function functionBody(): string {
  const start = SQL_CODE.indexOf("create function public.get_operator_restaurant_orders(");
  assert.ok(start >= 0, "la fonction opérateur doit être créée");
  const end = SQL_CODE.indexOf("$$;", start);
  return SQL_CODE.slice(start, end);
}

const APPROVED_COLUMNS = [
  "id",
  "order_number",
  "status",
  "service_mode",
  "created_at",
  "updated_at",
  "total",
  "currency",
  "item_count",
  "has_invoice_request",
];

const CUSTOMER_FIELDS = [
  "customer_name",
  "customer_phone",
  "customer_email",
  "delivery_address",
  "delivery_zone",
  "customer_note",
  "public_token",
  "table_number",
  "contact_email",
  "contact_name",
  "company_legal_name",
  "address_line_1",
];

test("SQL : exactement une fonction créée, aucune table, aucune fonction existante remplacée", () => {
  const created = [...SQL_CODE.matchAll(/create (?:or replace )?function public\.(\w+)\s*\(/g)].map((m) => m[1]);
  assert.deepEqual(created, ["get_operator_restaurant_orders"]);
  assert.ok(!SQL_CODE.includes("create or replace function"), "aucun remplacement de fonction existante");
  assert.ok(!/create\s+table/.test(SQL_CODE), "aucune table créée par le lot");
  assert.ok(!SQL.includes("operator_order_read_audit_log"), "journal fonctionnel retiré (décision CIO cycle 4)");
});

test("SQL : forme de retour = liste approuvée exacte, dans l'ordre", () => {
  const body = functionBody();
  const m = body.match(/returns table \(([\s\S]*?)\)\s*language/);
  assert.ok(m, "returns table introuvable");
  const cols = m![1].split(",").map((c) => c.trim().split(/\s+/)[0]);
  assert.deepEqual(cols, APPROVED_COLUMNS);
});

test("SQL : autorité opérateur explicite, jamais la membership marchande", () => {
  const body = functionBody();
  assert.ok(body.includes("if not public.is_scanym_operator() then"));
  assert.ok(!body.includes("is_member_of"), "aucun repli sur is_member_of");
  assert.ok(!body.includes("restaurant_users"), "aucune membership restaurant_users");
  assert.ok(body.includes("security definer"));
  assert.ok(body.includes("set search_path = ''"));
  assert.ok(body.includes("errcode = '28000'"), "anonyme/sans uid refusé");
  assert.ok(body.includes("errcode = '42501'"), "non-opérateur refusé");
});

test("SQL : aucune donnée client dans le code de la fonction, jamais de select *", () => {
  const body = functionBody();
  for (const field of CUSTOMER_FIELDS) {
    assert.ok(!body.includes(field), `champ client interdit dans la RPC opérateur : ${field}`);
  }
  assert.ok(!/select\s*\*/.test(body));
});

test("SQL : fonction en lecture seule, aucune écriture, aucune policy", () => {
  const body = functionBody();
  assert.ok(!/\b(insert\s+into|update\s+public\.|delete\s+from)/.test(body), "la RPC opérateur n'écrit rien");
  assert.ok(!/exception\s+when/.test(body), "aucune exception avalée");
  assert.ok(body.includes("stable"), "la fonction n'écrit rien : stable");
  assert.ok(!SQL_CODE.includes("create policy"), "aucune policy");
});

test("SQL : aucune écriture ni policy ajoutée sur les commandes, GRANT minimal", () => {
  assert.ok(!/(update|delete from|insert into)\s+public\.orders\b/.test(SQL_CODE));
  assert.ok(!/on (table )?public\.(orders|order_items|order_invoice_request)\b/.test(SQL_CODE));
  assert.ok(SQL_CODE.includes("revoke all on function public.get_operator_restaurant_orders(uuid, boolean) from public, anon, service_role;"));
  assert.ok(SQL_CODE.includes("grant execute on function public.get_operator_restaurant_orders(uuid, boolean) to authenticated;"));
  assert.ok(!/grant [^;]* to (anon|public)\b/.test(SQL_CODE));
});

test("SQL : préflight hors transaction, post-check avant commit", () => {
  const firstBegin = SQL_CODE.indexOf("begin;");
  assert.ok(SQL_CODE.indexOf("scanym_schema_drift") < firstBegin);
  assert.ok(SQL_CODE.lastIndexOf("scanym_post_commit_check_failed") < SQL_CODE.lastIndexOf("commit;"));
});

test("Rollback : retire exactement la fonction", () => {
  const code = stripSqlComments(ROLLBACK).toLowerCase();
  assert.ok(code.includes("drop function if exists public.get_operator_restaurant_orders(uuid, boolean);"));
  assert.ok(!ROLLBACK.includes("operator_order_read_audit_log"));
  assert.equal([...code.matchAll(/\bdrop\s+(function|table|policy)/g)].length, 1);
});

test("Service : RPC opérateur dédiée, lecture marchande inchangée", () => {
  const fn = SERVICE.slice(SERVICE.indexOf("export async function getOperatorRestaurantOrders"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(body.includes('supabase.rpc("get_operator_restaurant_orders"'));
  assert.ok(body.includes("if (error) throw new Error(error.message);"));
  assert.ok(!body.includes(".from("), "aucune lecture directe de table");
  const merchant = SERVICE.slice(SERVICE.indexOf("export async function getDashboardOrders"));
  assert.ok(merchant.slice(0, merchant.indexOf("\n}\n")).includes('.from("orders")'), "lecture marchande conservée");
});

test("Page : contexte opérateur => RPC opérateur uniquement, pas de repli, pas d'abonnement", () => {
  const start = PAGE.indexOf("if (isOperatorOrdersView) {");
  assert.ok(start > 0, "branche opérateur attendue dans loadOrders");
  const block = PAGE.slice(start, PAGE.indexOf("\n      }\n", start));
  assert.ok(block.includes("getOperatorRestaurantOrders(requestedRestaurantId, showHistory)"));
  assert.ok(block.includes("return;"), "la branche opérateur se termine sans passer par la lecture marchande");
  assert.ok(!block.includes("getDashboardOrders"));
  assert.ok(PAGE.includes('resolution.source === "operator" ? resolution.restaurantId : null'));
  assert.ok(PAGE.includes("if (isOperatorOrdersView) return undefined;"), "aucun abonnement temps réel en vue opérateur");
});

test("Page : une seule lecture opérateur par chargement (pas d'effet historique en double)", () => {
  const start = PAGE.indexOf("}, [isOperatorOrdersView, showHistory, restaurantId, loadOrders]);");
  assert.ok(start > 0, "effet historique attendu");
  const effect = PAGE.slice(PAGE.lastIndexOf("useEffect(() => {", start), start);
  assert.ok(
    effect.indexOf("if (isOperatorOrdersView) return;") >= 0 &&
      effect.indexOf("if (isOperatorOrdersView) return;") < effect.indexOf("loadOrders(false)"),
    "l'effet historique ne doit pas relire en vue opérateur"
  );
});

test("Liste opérateur : pas de « Aucune commande » tant qu'aucune lecture n'a abouti", () => {
  assert.ok(LIST.includes("!loaded ? null : orders.length === 0 ?"));
  assert.ok(PAGE.includes("loaded={operatorOrdersLoadedForRestaurantId === restaurantId}"));
  assert.ok(PAGE.includes("setOperatorOrdersLoadedForRestaurantId(requestedRestaurantId);"));
  assert.ok(PAGE.includes("setOperatorOrdersLoadedForRestaurantId(null);"));
});

test("Liste opérateur : lecture seule, aucune donnée client", () => {
  for (const forbidden of ["customer_", "delivery_address", "onStatus", "printReceipt", "updateOrderStatus"]) {
    assert.ok(!LIST.includes(forbidden), `interdit dans la vue opérateur : ${forbidden}`);
  }
  assert.ok(LIST.includes('data-operator-orders="read-only"'));
});
