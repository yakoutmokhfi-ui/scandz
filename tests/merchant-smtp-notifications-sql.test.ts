import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync("supabase/DRAFT-lot-merchant-smtp-notifications-v1.sql", "utf8");
const rollback = readFileSync("supabase/DRAFT-lot-merchant-smtp-notifications-v1-rollback.sql", "utf8");

async function db() {
  const pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role;
    grant usage on schema public to anon, authenticated, service_role;
    create table public.restaurants(id uuid primary key);
    create table public.merchant_notification_profile(
      restaurant_id uuid primary key, email_enabled boolean not null default false,
      sender_name text, sender_email text, reply_to text
    );
    create table public.notification_outbox(
      id uuid primary key default gen_random_uuid(), restaurant_id uuid not null,
      order_id uuid not null, notification_type text not null, recipient_email text,
      locale text not null default 'fr', payload_snapshot jsonb not null default '{}',
      status text not null default 'pending', next_attempt_at timestamptz,
      attempt_count integer not null default 0, claim_token uuid, claimed_at timestamptz,
      claim_expires_at timestamptz, created_at timestamptz not null default now()
    );
    create function public.touch_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at = now(); return new; end $$;
    create function public.notification_send_gate_open(uuid,text) returns boolean
      language sql stable as $$ select true $$;
    create function public.claim_pending_notifications(p_batch_size integer default 10, p_lease_seconds integer default 60)
    returns table(outbox_id uuid, restaurant_id uuid, order_id uuid, notification_type text,
      recipient_email text, locale text, payload_snapshot jsonb, attempt_count integer,
      claim_token uuid, sender_name text, sender_email text, reply_to text)
    language plpgsql security definer set search_path = '' as $$
    begin
      return query with eligible as (
        select o.id from public.notification_outbox o
        where o.status in ('pending','failed_retryable') and public.notification_send_gate_open(o.order_id,o.notification_type)
        order by o.created_at,o.id limit greatest(1,least(coalesce(p_batch_size,10),100)) for update skip locked
      ), claimed as (
        update public.notification_outbox o set status='processing', claim_token=gen_random_uuid(),
          claimed_at=now(), claim_expires_at=now()+make_interval(secs=>greatest(1,least(coalesce(p_lease_seconds,60),3600)))
        from eligible where o.id=eligible.id returning o.id,o.restaurant_id,o.order_id,o.notification_type,
          o.recipient_email,o.locale,o.payload_snapshot,o.attempt_count,o.claim_token
      ) select c.id,c.restaurant_id,c.order_id,c.notification_type,c.recipient_email,c.locale,
        c.payload_snapshot,c.attempt_count,c.claim_token,p.sender_name,p.sender_email,p.reply_to
        from claimed c left join public.merchant_notification_profile p on p.restaurant_id=c.restaurant_id;
    end $$;
  `);
  return pg;
}

test("migration creates a private tenant SMTP vault and only claims rows with an enabled provider", async () => {
  const pg = await db();
  await pg.exec(migration);
  const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const c = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await pg.query("insert into public.restaurants(id) values ($1),($2),($3)", [a, b, c]);
  await pg.query("insert into public.merchant_email_provider_config(restaurant_id,host,port,username,enabled,secret_ciphertext,secret_iv,secret_auth_tag) values ($1,'smtp.ionos.fr',465,'a@example.com',true,'cipher','iv','tag')", [a]);
  await pg.query("insert into public.merchant_email_provider_config(restaurant_id,host,port,username,enabled,secret_ciphertext,secret_iv,secret_auth_tag) values ($1,'smtp.ionos.fr',465,'c@example.com',true,'cipher','iv','tag')", [c]);
  await pg.query("insert into public.merchant_notification_profile(restaurant_id,email_enabled,sender_name,sender_email) values ($1,true,'A','a@example.com')", [a]);
  await pg.query("insert into public.merchant_notification_profile(restaurant_id,email_enabled,sender_name,sender_email) values ($1,false,'C','c@example.com')", [c]);
  await pg.query("insert into public.notification_outbox(restaurant_id,order_id,notification_type,recipient_email) values ($1,gen_random_uuid(),'order_received','a@client.test'),($2,gen_random_uuid(),'order_received','b@client.test'),($3,gen_random_uuid(),'order_received','c@client.test')", [a, b, c]);
  const claimed = await pg.query<{ restaurant_id: string }>("select restaurant_id from public.claim_pending_notifications(10,60)");
  assert.deepEqual(claimed.rows.map((row) => row.restaurant_id), [a]);
  const untouched = await pg.query<{ status: string; attempt_count: number }>("select status,attempt_count from public.notification_outbox where restaurant_id=$1", [b]);
  assert.deepEqual(untouched.rows[0], { status: "pending", attempt_count: 0 });
  const disabled = await pg.query<{ status: string; attempt_count: number }>("select status,attempt_count from public.notification_outbox where restaurant_id=$1", [c]);
  assert.deepEqual(disabled.rows[0], { status: "pending", attempt_count: 0 });
  assert.equal((await pg.query("select * from public.merchant_email_provider_config")).rows.length, 2);
});

test("migration denies direct browser access to SMTP ciphertext and double application", async () => {
  const pg = await db(); await pg.exec(migration);
  const grants = await pg.query<{ anon: boolean; auth: boolean; service: boolean }>(`
    select has_table_privilege('anon','public.merchant_email_provider_config','select') anon,
           has_table_privilege('authenticated','public.merchant_email_provider_config','select') auth,
           has_table_privilege('service_role','public.merchant_email_provider_config','select') service`);
  assert.deepEqual(grants.rows[0], { anon: false, auth: false, service: true });
  await assert.rejects(() => pg.exec(migration), /SCANYM_SCHEMA_DRIFT/);
});

test("rollback refuses to discard saved credentials and restores previous claim when empty", async () => {
  const pg = await db(); await pg.exec(migration);
  const before = (await pg.query<{ def: string }>("select pg_get_functiondef('public.claim_pending_notifications(integer,integer)'::regprocedure) def")).rows[0]!.def;
  await pg.query("insert into public.restaurants(id) values (gen_random_uuid()) returning id");
  const restaurant = (await pg.query<{ id: string }>("select id from public.restaurants limit 1")).rows[0]!.id;
  await pg.query("insert into public.merchant_email_provider_config(restaurant_id,host,port,username) values ($1,'smtp.ionos.fr',465,'a@example.com')", [restaurant]);
  await assert.rejects(() => pg.exec(rollback), /SCANYM_ROLLBACK_DATA_LOSS/);
  await pg.exec("rollback");
  await pg.query("delete from public.merchant_email_provider_config");
  await pg.exec(rollback);
  const after = (await pg.query<{ def: string }>("select pg_get_functiondef('public.claim_pending_notifications(integer,integer)'::regprocedure) def")).rows[0]!.def;
  assert.match(before, /notification_send_gate_open/);
  assert.doesNotMatch(after, /merchant_email_provider_config/);
  const relation = await pg.query<{ table_name: string | null }>("select to_regclass('public.merchant_email_provider_config')::text as table_name");
  assert.equal(relation.rows[0]!.table_name, null);
});
