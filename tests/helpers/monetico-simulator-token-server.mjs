/**
 * MONETICO PAYMENT SIMULATOR v1.2 — SHARED TOKEN DATABASE SERVER (TEST ONLY).
 *
 * Hosts ONE real PostgreSQL (PGlite) with the authority draft applied and
 * exposes its RPCs over HTTP so that SEVERAL INDEPENDENT NODE PROCESSES
 * (tests/helpers/monetico-simulator-token-client.mjs) can race on the
 * same `consume_simulator_decision_token` row -- the multi-instance /
 * restart proof demanded by MSIM-AUTH-03. The server is the database; it
 * does not interpret anything.
 *
 * Usage: node tests/helpers/monetico-simulator-token-server.mjs
 *        -> prints `READY <port>` on stdout.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const RESTO = "00000000-0000-0000-0000-000000000001";
const ORDER = "00000000-0000-0000-0000-000000000011";
const TXN = "00000000-0000-0000-0000-000000000021";

const db = new PGlite();
await db.exec(`
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create table public.restaurants (id uuid primary key);
create table public.orders (id uuid primary key, restaurant_id uuid not null, payment_status text not null default 'pending', current_payment_transaction_id uuid);
create table public.payment_provider_configs (id uuid primary key default gen_random_uuid(), restaurant_id uuid not null, provider_code text not null, mode text not null default 'test' check (mode in ('test','live')), is_enabled boolean not null default false);
create table public.payment_transactions (id uuid primary key, restaurant_id uuid not null, order_id uuid not null, provider_code text not null, provider_reference text not null, status text not null, amount numeric(12,2) not null, currency text not null, unique (provider_code, provider_reference));
insert into public.restaurants (id) values ('${RESTO}');
insert into public.payment_provider_configs (restaurant_id, provider_code, mode, is_enabled) values ('${RESTO}', 'monetico', 'test', true);
insert into public.orders (id, restaurant_id) values ('${ORDER}', '${RESTO}');
insert into public.payment_transactions (id, restaurant_id, order_id, provider_code, provider_reference, status, amount, currency) values ('${TXN}', '${RESTO}', '${ORDER}', 'monetico', 'refMPxxxxxxx', 'pending', 25.00, 'EUR');
set app.simulator_project_ref = 'simtestproj00001';
`);
await db.exec(readFileSync("supabase/DRAFT-lot-monetico-simulator-test-authority-v1.sql", "utf8"));

const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const { name, args } = JSON.parse(body || "{}");
  const keys = Object.keys(args ?? {});
  const sql = `select * from public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
  try {
    const out = await db.query(sql, keys.map((k) => args[k]));
    res.end(JSON.stringify({ data: out.rows, error: null }));
  } catch (err) {
    res.end(JSON.stringify({ data: null, error: { code: err.code ?? "XX000", message: err.message } }));
  }
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`READY ${server.address().port}\n`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
