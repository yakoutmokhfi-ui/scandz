// In-memory PostgreSQL (PGlite), no credentials, network or remote database.
// Replay the predecessor chain already pinned by B1, then the actual B1 SQL.
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
export const sqlFile = name => fs.readFileSync(`supabase/${name}`, 'utf8').replaceAll('\r\n','\n');
export async function makeDeliveryDb() {
  const db = new PGlite({ extensions: { pgcrypto } });
  const harness=sqlFile('tests/delivery-pricing-v2-b1-order-snapshot-v1-check.sh');
  const bootstrap=harness.match(/build_common_bootstrap\(\) \{[\s\S]*?<<'SQL'\n([\s\S]*?)\nSQL/)[1];
  await db.exec(bootstrap);
  await db.exec('grant usage on schema public,auth to anon,authenticated,service_role;');
  const chain=name=>harness.match(new RegExp('^'+name+'="([^"]+)"','m'))[1].split(' ');
  const apply=async name=>{try {await db.exec(sqlFile(name));} catch(e){throw new Error(`${name}: ${e.message}`,{cause:e});}};
  for(const f of chain('MINIMAL_CHAIN')) { await apply(f); await db.exec('grant select on all tables in schema public to anon,authenticated;'); }
  for(const f of chain('REST_CHAIN')) await apply(f);
  await apply('DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql');
  await apply('DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql');
  for(const f of chain('CGV_AFTER_N1A_CHAIN')) await apply(f);
  await db.exec('grant select on all tables in schema public to anon,authenticated;');
  await apply('DRAFT-lot-order-received-enqueue-recovery-v1.sql');
  await apply('migration-20260919000000-order-success-boundary-v1.sql');
  await db.exec('create table public.order_invoice_request(order_id uuid primary key references public.orders(id) on delete cascade); alter table public.order_invoice_request enable row level security; revoke all on public.order_invoice_request from public,anon,authenticated;');
  for(const f of chain('TRACKING_TAIL')) await apply(f);
  for(const f of ['DRAFT-lot-customer-followup-tracking-email-v1.sql','DRAFT-lot-online-withdrawal-foundation-v1.sql',
    'DRAFT-lot-online-withdrawal-v1-1-cgv-mixed-regime.sql','DRAFT-lot-delivery-country-scope-v1.sql',
    'DRAFT-lot-product-service-modes-v1.sql','DRAFT-lot-delivery-pricing-v2-b1-order-snapshot-v1.sql',
    'DRAFT-lot-delivery-pricing-operator-authorization-v1.sql','DRAFT-lot-delivery-delay-customer-notice-v1.sql']) await apply(f);
  // Only the delivery translation DDL is needed; the full translation migration
  // has unrelated catalogue-reset prerequisites. Execute the exact source DDL.
  const tr=sqlFile('DRAFT-lot-translations-management-v2.sql');
  await db.exec(tr.match(/alter table public\.restaurant_sale_mode_fulfillments\s+add column translations[\s\S]*?;/i)[0]);
  return db;
}
