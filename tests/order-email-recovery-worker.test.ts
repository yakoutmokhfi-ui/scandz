import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

test("migration refuses a missing payment decision column before changing the schema", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table public.orders (id uuid primary key, restaurant_id uuid, order_received_notification_intent_at timestamptz, customer_email text, payment_status text);
      create function public.create_order_received_notification(uuid,uuid) returns uuid language sql as 'select $1';
      create function public.notification_send_gate_open(uuid,text) returns boolean language sql as 'select true';`);
    const sql = readFileSync(new URL("../supabase/DRAFT-lot-order-email-recovery-worker-v1.sql", import.meta.url), "utf8");
    await assert.rejects(db.exec(sql), /payment_mode_final/i);
    await db.exec("rollback");
    const result = await db.query<{ boundary: string | null }>("select to_regclass('public.order_email_recovery_boundary')::text as boundary");
    assert.equal(result.rows[0]?.boundary, null);
  } finally { await db.close(); }
});

test("recovery only enqueues new, eligible orders once and preserves the historic backlog", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.orders (id uuid primary key, restaurant_id uuid not null,
        order_received_notification_intent_at timestamptz, customer_email text,
        payment_status text, payment_mode_final text);
      create table public.merchant_notification_profile (restaurant_id uuid primary key, email_enabled boolean, sender_name text, sender_email text, reply_to text);
      create table public.merchant_email_provider_config (restaurant_id uuid primary key, enabled boolean, secret_ciphertext text);
      create table public.notification_outbox (order_id uuid, restaurant_id uuid, notification_type text, id uuid default gen_random_uuid(),
        status text default 'pending', created_at timestamptz default now(), next_attempt_at timestamptz,
        claimed_at timestamptz, claim_token uuid, claim_expires_at timestamptz, recipient_email text,
        locale text, payload_snapshot jsonb, attempt_count integer default 0,
        unique (order_id, restaurant_id, notification_type));
      create function public.notification_send_gate_open(uuid,text) returns boolean language sql as 'select true';
      insert into public.merchant_notification_profile (restaurant_id,email_enabled) values ('00000000-0000-0000-0000-000000000001',true);
      create function public.create_order_received_notification(uuid,uuid) returns uuid language plpgsql as $f$
      begin
        insert into public.notification_outbox (order_id,restaurant_id,notification_type) values ($1,$2,'order_received') on conflict do nothing;
        return $1;
      end $f$;
    `);
    await db.exec(readFileSync(new URL("../supabase/DRAFT-lot-order-email-recovery-worker-v1.sql", import.meta.url), "utf8"));
    await db.exec(`
      insert into public.merchant_notification_profile (restaurant_id,email_enabled) values ('00000000-0000-0000-0000-000000000002',false);
      insert into public.merchant_email_provider_config values ('00000000-0000-0000-0000-000000000001',true,'cipher'), ('00000000-0000-0000-0000-000000000002',true,'cipher');
      insert into public.orders values
        ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',now()-interval '1 day','old@example.test','paid','online'),
        ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001',now()+interval '1 second','new@example.test','paid','online'),
        ('10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001',now()+interval '1 second','new@example.test','not_required','none'),
        ('10000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001',now()+interval '1 second','new@example.test','pending','online'),
        ('10000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000002',now()+interval '1 second','new@example.test','paid','online');
    `);
    const first = await db.query<{ recovered: number; failed: number }>("select * from public.recover_new_order_received_notifications(25)");
    assert.deepEqual(first.rows, [{ recovered: 2, failed: 0 }]);
    const again = await db.query<{ recovered: number; failed: number }>("select * from public.recover_new_order_received_notifications(25)");
    assert.deepEqual(again.rows, [{ recovered: 0, failed: 0 }]);
    const count = await db.query<{ count: number }>("select count(*)::int as count from public.notification_outbox");
    assert.equal(count.rows[0]?.count, 2);
    await db.exec("update public.orders set payment_status='paid' where id='10000000-0000-0000-0000-000000000004'");
    const later = await db.query<{ recovered: number; failed: number }>("select * from public.recover_new_order_received_notifications(25)");
    assert.deepEqual(later.rows, [{ recovered: 1, failed: 0 }], "payment after initial creation becomes eligible");
    const grants = await db.query<{ anon: boolean; authenticated: boolean; service: boolean }>(`select
      has_function_privilege('anon','public.recover_new_order_received_notifications(integer)','execute') as anon,
      has_function_privilege('authenticated','public.recover_new_order_received_notifications(integer)','execute') as authenticated,
      has_function_privilege('service_role','public.recover_new_order_received_notifications(integer)','execute') as service`);
    assert.deepEqual(grants.rows, [{ anon: false, authenticated: false, service: true }]);
    // An already queued historical confirmation must remain pending and must
    // never be returned to the SMTP worker; current confirmations still claim.
    await db.exec(`insert into public.notification_outbox (order_id,restaurant_id,notification_type)
      values ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','order_received')`);
    const claims = await db.query<{ order_id: string }>("select order_id from public.claim_new_order_notifications(25,60)");
    assert.equal(claims.rows.length, 3);
    assert.equal(claims.rows.some(x => x.order_id === '10000000-0000-0000-0000-000000000001'), false);
    const old = await db.query<{ status: string }>("select status from public.notification_outbox where order_id='10000000-0000-0000-0000-000000000001'");
    assert.equal(old.rows[0]?.status, 'pending');
    // A merchant enabling emails later must not replay their earlier orders.
    await db.exec(`update public.orders set order_received_notification_intent_at=
      (select starts_at + interval '1 microsecond' from public.order_email_recovery_boundary)
      where id='10000000-0000-0000-0000-000000000005';
      update public.merchant_notification_profile set email_enabled=true
      where restaurant_id='00000000-0000-0000-0000-000000000002';`);
    const activationOrdering = await db.query<{ valid: boolean }>(`select
      o.order_received_notification_intent_at >= b.starts_at and o.order_received_notification_intent_at < e.starts_at as valid
      from public.orders o join public.order_email_activation_epoch e on e.restaurant_id=o.restaurant_id
      cross join public.order_email_recovery_boundary b where o.id='10000000-0000-0000-0000-000000000005'`);
    assert.equal(activationOrdering.rows[0]?.valid, true, 'order is after migration but before merchant activation');
    const enableRecovery = await db.query<{ recovered: number; failed: number }>("select * from public.recover_new_order_received_notifications(25)");
    assert.deepEqual(enableRecovery.rows, [{ recovered: 0, failed: 0 }]);
    await db.exec(`insert into public.orders values
      ('10000000-0000-0000-0000-000000000008','00000000-0000-0000-0000-000000000002',clock_timestamp()+interval '1 second','new@example.test','paid','online')`);
    const afterEnable = await db.query<{ recovered: number; failed: number }>("select * from public.recover_new_order_received_notifications(25)");
    assert.deepEqual(afterEnable.rows, [{ recovered: 1, failed: 0 }]);
    await db.exec(`update public.orders set order_received_notification_intent_at=
      (select starts_at + interval '1 microsecond' from public.order_email_recovery_boundary)
      where id='10000000-0000-0000-0000-000000000008';
      update public.merchant_notification_profile set email_enabled=false
      where restaurant_id='00000000-0000-0000-0000-000000000002';
      update public.merchant_notification_profile set email_enabled=true
      where restaurant_id='00000000-0000-0000-0000-000000000002';`);
    const afterReactivate = await db.query<{ order_id: string }>("select order_id from public.claim_new_order_notifications(25,60)");
    assert.equal(afterReactivate.rows.some(x => x.order_id === '10000000-0000-0000-0000-000000000008'), false,
      'a notification created before reactivation must not be claimed');
    await db.exec(`
      create or replace function public.create_order_received_notification(uuid,uuid) returns uuid language plpgsql as $f$
      begin
        if $1 = '10000000-0000-0000-0000-000000000006' then raise exception 'fake failure'; end if;
        insert into public.notification_outbox (order_id,restaurant_id,notification_type) values ($1,$2,'order_received') on conflict do nothing;
        return $1;
      end $f$;
      insert into public.orders values
        ('10000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000001',now()+interval '1 second','x@example.test','paid','online'),
        ('10000000-0000-0000-0000-000000000007','00000000-0000-0000-0000-000000000001',now()+interval '1 second','y@example.test','paid','online');
    `);
    const failure = await db.query<{ recovered: number; failed: number }>("select * from public.recover_new_order_received_notifications(1)");
    assert.deepEqual(failure.rows, [{ recovered: 0, failed: 1 }]);
    const progress = await db.query<{ recovered: number; failed: number }>("select * from public.recover_new_order_received_notifications(1)");
    assert.deepEqual(progress.rows, [{ recovered: 1, failed: 0 }], "one failing order must not starve later orders");
    await assert.rejects(db.exec("set role authenticated; select * from public.recover_new_order_received_notifications(25)"), /permission denied/i);
  } finally { await db.close(); }
});
