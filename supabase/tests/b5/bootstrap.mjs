// Replay the repository's B1 predecessor chain in an isolated PostgreSQL/WASM
// instance. No remote connection, production schema dump, or mocked pricing.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

export const sqlRoot = new URL('../../', import.meta.url);
export const readSql = name => readFileSync(new URL(name, sqlRoot), 'utf8').replace(/\r\n/g, '\n');
export const coSig = 'public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)';
export const resSig = 'public.resolve_delivery_fulfillment(uuid,text,text,integer,numeric)';
export const b1File = 'DRAFT-lot-delivery-pricing-v2-b1-order-snapshot-v1.sql';
export const migrationFile = 'DRAFT-lot-delivery-pricing-v2-b5.sql';
export const rollbackFile = 'DRAFT-lot-delivery-pricing-v2-b5-ROLLBACK.sql';

export async function makeBaseline() {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    const b1 = readSql('tests/delivery-pricing-v2-b1-order-snapshot-v1-check.sh');
    const bootstrap = b1.match(/build_common_bootstrap\(\) \{[\s\S]*?<<'SQL'\n([\s\S]*?)\nSQL\n\}/)[1];
    await db.exec(bootstrap);
    const chain = name => b1.match(new RegExp('^' + name + '="([^"]+)"', 'm'))[1].split(' ');
    const apply = async name => {
      try { await db.exec(readSql(name)); }
      catch (e) { throw new Error(`Baseline migration ${name}: ${e.message}`, { cause: e }); }
    };
    for (const name of chain('MINIMAL_CHAIN')) {
      await apply(name);
      await db.exec('grant select on all tables in schema public to anon, authenticated');
    }
    for (const name of chain('REST_CHAIN')) await apply(name);
    await apply('DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql');
    await apply('DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql');
    for (const name of chain('CGV_AFTER_N1A_CHAIN')) await apply(name);
    await db.exec('grant select on all tables in schema public to anon, authenticated');
    await apply('DRAFT-lot-order-received-enqueue-recovery-v1.sql');
    await apply('migration-20260919000000-order-success-boundary-v1.sql');
    await db.exec(`create table public.order_invoice_request (
      order_id uuid primary key references public.orders(id) on delete cascade);
      alter table public.order_invoice_request enable row level security;
      revoke all on table public.order_invoice_request from public, anon, authenticated;`);
    for (const name of chain('TRACKING_TAIL')) await apply(name);
    for (const name of [
      'DRAFT-lot-customer-followup-tracking-email-v1.sql',
      'DRAFT-lot-online-withdrawal-foundation-v1.sql',
      'DRAFT-lot-online-withdrawal-v1-1-cgv-mixed-regime.sql',
      'DRAFT-lot-delivery-country-scope-v1.sql',
      'DRAFT-lot-product-service-modes-v1.sql', b1File,
    ]) await apply(name);
    await db.exec('grant usage on schema public,auth to anon,authenticated,service_role');
    await apply('DRAFT-lot-delivery-pricing-operator-authorization-v1.sql');
    await apply('DRAFT-lot-delivery-delay-customer-notice-v1.sql');
    const translations = readSql('DRAFT-lot-translations-management-v2.sql');
    await db.exec(translations.match(/alter table public\.restaurant_sale_mode_fulfillments\s+add column translations[\s\S]*?;/i)[0]);
    await db.exec('drop function public.get_restaurant_public_delivery_fulfillments(uuid)');
    await db.exec(translations.match(/create function public\.get_restaurant_public_delivery_fulfillments\([\s\S]*?\$\$;/)[0]);
    await db.exec('revoke all on function public.get_restaurant_public_delivery_fulfillments(uuid) from public,anon,authenticated,service_role; grant execute on function public.get_restaurant_public_delivery_fulfillments(uuid) to anon,authenticated');
    await apply('DRAFT-lot-delivery-pricing-v2-b234.sql');
    return db;
  } catch (e) { await db.close(); throw e; }
}
