import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * MONETICO PAYMENT SIMULATOR v1.2 — REAL PostgreSQL HARNESS (PGlite) for
 * DRAFT-lot-monetico-simulator-test-authority-v1.sql.
 *
 * Builds the MINIMAL schema the draft depends on (restaurants, orders,
 * payment_provider_configs, payment_transactions with the columns the
 * draft reads, plus the Stuart allocation RPC signatures so the §4
 * revocation has something to act on), then applies the draft exactly as
 * an operator would (with `app.simulator_project_ref` set). Used by
 * tests/v165-* and by the multi-process token server.
 */

export const readSql = (name: string) => readFileSync(`supabase/${name}`, "utf8").replaceAll("\r\n", "\n");
export const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

export const RESTO_A = uuid(1);
export const RESTO_B = uuid(2);
export const ORDER_A1 = uuid(11);
export const ORDER_B1 = uuid(12);
export const TXN_A1 = uuid(21);
export const TXN_B1 = uuid(22);
export const TEST_PROJECT_REF = "simtestproj00001";

const BASE_SCHEMA = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create table public.restaurants (id uuid primary key);
create table public.orders (
  id uuid primary key,
  restaurant_id uuid not null references public.restaurants(id),
  payment_status text not null default 'not_required',
  current_payment_transaction_id uuid
);
create table public.payment_provider_configs (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id),
  provider_code text not null,
  mode text not null default 'test' check (mode in ('test','live')),
  is_enabled boolean not null default false
);
create table public.payment_transactions (
  id uuid primary key,
  restaurant_id uuid not null,
  order_id uuid not null references public.orders(id),
  provider_code text not null,
  provider_reference text not null,
  status text not null check (status in ('pending','paid','failed','cancelled')),
  amount numeric(12,2) not null,
  currency text not null,
  unique (provider_code, provider_reference)
);
-- Stuart RPC signatures (bodies irrelevant) so §4 revocation is exercised.
create function public.allocate_stuart_delivery_job(p_order_id uuid, p_restaurant_id uuid, p_environment text, p_candidate_reference text)
returns table (id uuid) language sql security definer as $$ select gen_random_uuid() $$;
create function public.mark_stuart_delivery_job_send_started(p_id uuid, p_order_id uuid, p_restaurant_id uuid)
returns void language sql security definer as $$ select null::void $$;
create function public.confirm_stuart_delivery_job_created(p_id uuid, p_order_id uuid, p_restaurant_id uuid, p_stuart_job_id text)
returns void language sql security definer as $$ select null::void $$;
create function public.mark_stuart_delivery_job_ambiguous(p_id uuid, p_order_id uuid, p_restaurant_id uuid)
returns void language sql security definer as $$ select null::void $$;
create function public.mark_stuart_delivery_job_terminal_failure(p_id uuid, p_order_id uuid, p_restaurant_id uuid)
returns void language sql security definer as $$ select null::void $$;
revoke all on function public.allocate_stuart_delivery_job(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.allocate_stuart_delivery_job(uuid, uuid, text, text) to service_role;
grant execute on function public.mark_stuart_delivery_job_send_started(uuid, uuid, uuid) to service_role;
grant execute on function public.confirm_stuart_delivery_job_created(uuid, uuid, uuid, text) to service_role;
grant execute on function public.mark_stuart_delivery_job_ambiguous(uuid, uuid, uuid) to service_role;
grant execute on function public.mark_stuart_delivery_job_terminal_failure(uuid, uuid, uuid) to service_role;
`;

const SEED = `
insert into public.restaurants (id) values ('${RESTO_A}'), ('${RESTO_B}');
insert into public.payment_provider_configs (restaurant_id, provider_code, mode, is_enabled)
  values ('${RESTO_A}', 'monetico', 'test', true), ('${RESTO_B}', 'monetico', 'test', true);
insert into public.orders (id, restaurant_id, payment_status) values ('${ORDER_A1}', '${RESTO_A}', 'pending'), ('${ORDER_B1}', '${RESTO_B}', 'pending');
insert into public.payment_transactions (id, restaurant_id, order_id, provider_code, provider_reference, status, amount, currency) values
  ('${TXN_A1}', '${RESTO_A}', '${ORDER_A1}', 'monetico', 'refA1xxxxxxx', 'pending', 25.00, 'EUR'),
  ('${TXN_B1}', '${RESTO_B}', '${ORDER_B1}', 'monetico', 'refB1xxxxxxx', 'pending', 40.00, 'EUR');
update public.orders set current_payment_transaction_id = '${TXN_A1}' where id = '${ORDER_A1}';
update public.orders set current_payment_transaction_id = '${TXN_B1}' where id = '${ORDER_B1}';
`;

export interface AuthorityDbOptions {
  /** Insert a LIVE merchant before applying the draft (must be refused). */
  withLiveMerchant?: boolean;
  /** Skip `set app.simulator_project_ref` (must be refused). */
  withoutProjectRef?: boolean;
  /** Do not apply the draft at all (models the PRODUCTION project). */
  skipDraft?: boolean;
}

export async function createAuthorityDb(options: AuthorityDbOptions = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(BASE_SCHEMA);
  await db.exec(SEED);
  if (options.withLiveMerchant) {
    await db.exec(`insert into public.payment_provider_configs (restaurant_id, provider_code, mode, is_enabled) values ('${RESTO_B}', 'other', 'live', true);`);
  }
  if (!options.skipDraft) {
    if (!options.withoutProjectRef) await db.exec(`set app.simulator_project_ref = '${TEST_PROJECT_REF}';`);
    await db.exec(readSql("DRAFT-lot-monetico-simulator-test-authority-v1.sql"));
  }
  return db;
}

export async function applyRollback(db: PGlite): Promise<void> {
  await db.exec(readSql("DRAFT-lot-monetico-simulator-test-authority-v1-rollback.sql"));
}

/** PostgREST-like rpc() over PGlite: `{data, error}` with the SQLSTATE in `error.code`. */
export async function pgliteRpc(db: PGlite, name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: null | { code: string; message: string } }> {
  const keys = Object.keys(args);
  const sql = `select * from public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
  try {
    const res = await db.query(sql, keys.map((k) => args[k]));
    return { data: res.rows, error: null };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { data: null, error: { code: e.code ?? "XX000", message: e.message ?? String(err) } };
  }
}
