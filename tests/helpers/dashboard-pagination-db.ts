import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

export const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
export const TENANT_A = uuid(900001), TENANT_B = uuid(900002);
export const MERCHANT = uuid(900003), OPERATOR = uuid(900004);
export const readSql = (name: string) => readFileSync(`supabase/${name}`, "utf8").replaceAll("\r\n", "\n");

/** Minimal local fixture; authority function, merchant policy and BOTH operator
 * endpoints below are executed from repository SQL, not authorization mocks.
 * No hosted Supabase project, keys, environment files or remote data are used. */
export async function makePaginationDb() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth, public to anon, authenticated, service_role;
    create table public.restaurant_users (user_id uuid, restaurant_id uuid);
    create table public.scanym_operators (user_id uuid);
    create table public.orders (
      id uuid primary key, restaurant_id uuid not null, order_number bigint not null,
      status text not null, service_mode text not null default 'pickup',
      created_at timestamptz not null, updated_at timestamptz not null default now(),
      total numeric not null default 10, currency text not null default 'EUR',
      customer_name text default 'PRIVATE', customer_phone text default 'PRIVATE',
      customer_email text default 'PRIVATE', delivery_address text default 'PRIVATE',
      customer_note text default 'PRIVATE', public_token uuid default gen_random_uuid()
    );
    create table public.order_items (id uuid primary key, order_id uuid references public.orders, quantity integer);
    create table public.order_invoice_request (order_id uuid references public.orders, contact_email text);
    alter table public.orders enable row level security;
    alter table public.restaurant_users enable row level security;
    create policy own_membership on public.restaurant_users for select to authenticated using (user_id = auth.uid());
    grant select on public.orders, public.restaurant_users to authenticated;
    insert into public.restaurant_users values ('${MERCHANT}', '${TENANT_A}');
    insert into public.scanym_operators values ('${OPERATOR}');
  `);
  const authority = readSql("migration-lotd-establishment-creation.sql")
    .match(/create function public\.is_scanym_operator\(\)[\s\S]*?grant execute on function public\.is_scanym_operator\(\) to authenticated;/)![0];
  const policy = readSql("migration-v29-merchant-dashboard.sql")
    .match(/create policy "merchant reads restaurant orders"[\s\S]*?\n\);/)![0];
  await db.exec(authority);
  await db.exec(policy);
  await db.exec(readSql("DRAFT-lot-orders-operator-read-v1.sql"));
  await db.exec(readSql("DRAFT-dashboard-active-orders-pagination-v1.sql"));
  return db;
}

export async function seed(db: PGlite, count: number, tenant = TENANT_A) {
  await db.query(`insert into public.orders(id,restaurant_id,order_number,status,created_at)
    select ('00000000-0000-0000-0000-' || lpad(i::text,12,'0'))::uuid, $1::uuid, i, 'new',
      '2026-10-01T12:00:00.123456Z'::timestamptz
    from generate_series(1,$2::integer) i`, [tenant, count]);
}
