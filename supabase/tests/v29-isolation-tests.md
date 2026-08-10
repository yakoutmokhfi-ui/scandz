# V29 isolation tests (Illico / Sanaa)

These tests must be run against the target Supabase project after `migration-v29-merchant-dashboard.sql`.
They require two real Auth users and at least one order for each restaurant.

## 1. Prepare the accounts (SQL Editor, service role context)

```sql
select id, slug from public.restaurants where slug in ('illico-presto', 'sanaa-cookies');
select id, email from auth.users where email in ('merchant-illico@example.com', 'merchant-sanaa@example.com');

insert into public.restaurant_users (user_id, restaurant_id, role)
select u.id, r.id, 'owner'
from auth.users u
join public.restaurants r on r.slug = 'illico-presto'
where u.email = 'merchant-illico@example.com'
on conflict do nothing;

insert into public.restaurant_users (user_id, restaurant_id, role)
select u.id, r.id, 'owner'
from auth.users u
join public.restaurants r on r.slug = 'sanaa-cookies'
where u.email = 'merchant-sanaa@example.com'
on conflict do nothing;
```

## 2. Execute the authenticated REST tests

Create `/tmp/v29-test.mjs` locally and replace the URL, anon key and credentials:

```js
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;

async function session(email, password) {
  const client = createClient(url, key);
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

async function assertIsolation(label, client, ownSlug, foreignSlug) {
  const { data: mappings, error: mappingError } = await client
    .from('restaurant_users')
    .select('restaurant_id, restaurants!inner(slug)');
  if (mappingError) throw mappingError;
  if (!mappings.length || mappings.some(x => x.restaurants.slug !== ownSlug)) {
    throw new Error(`${label}: restaurant_users isolation failed`);
  }

  const { data: ownRestaurant } = await client.from('restaurants').select('id').eq('slug', ownSlug).single();
  const { data: foreignRestaurant } = await client.from('restaurants').select('id').eq('slug', foreignSlug).single();

  const { data: ownOrders, error: ownError } = await client.from('orders').select('id,status').eq('restaurant_id', ownRestaurant.id);
  if (ownError) throw ownError;

  const { data: foreignOrders, error: foreignError } = await client.from('orders').select('id,status').eq('restaurant_id', foreignRestaurant.id);
  if (foreignError) throw foreignError;
  if (foreignOrders.length !== 0) throw new Error(`${label}: foreign orders leaked`);

  const { data: allItems, error: itemError } = await client.from('order_items').select('id, order_id, orders!inner(restaurant_id)');
  if (itemError) throw itemError;
  if (allItems.some(x => x.orders.restaurant_id !== ownRestaurant.id)) {
    throw new Error(`${label}: foreign order_items leaked`);
  }

  const ownNew = ownOrders.find(x => x.status === 'new');
  if (ownNew) {
    const { error: validError } = await client.rpc('update_order_status', {
      p_order_id: ownNew.id,
      p_new_status: 'accepted',
    });
    if (validError) throw new Error(`${label}: authorized transition failed: ${validError.message}`);

    const { error: invalidError } = await client.rpc('update_order_status', {
      p_order_id: ownNew.id,
      p_new_status: 'completed',
    });
    if (!invalidError) throw new Error(`${label}: invalid transition unexpectedly succeeded`);
  }

  const service = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: oneForeign } = await service.from('orders').select('id').eq('restaurant_id', foreignRestaurant.id).limit(1).maybeSingle();
  if (oneForeign) {
    const { error: crossError } = await client.rpc('update_order_status', {
      p_order_id: oneForeign.id,
      p_new_status: 'accepted',
    });
    if (!crossError) throw new Error(`${label}: cross-restaurant update unexpectedly succeeded`);
  }

  const { error: directUpdateError } = await client.from('orders').update({ total: 0 }).eq('restaurant_id', ownRestaurant.id);
  if (!directUpdateError) throw new Error(`${label}: generic direct UPDATE unexpectedly succeeded`);

  console.log(`${label}: PASS (${ownOrders.length} own orders, 0 foreign orders)`);
}

const illico = await session('merchant-illico@example.com', process.env.ILLICO_PASSWORD);
const sanaa = await session('merchant-sanaa@example.com', process.env.SANAA_PASSWORD);
await assertIsolation('Account A / Illico', illico, 'illico-presto', 'sanaa-cookies');
await assertIsolation('Account B / Sanaa', sanaa, 'sanaa-cookies', 'illico-presto');
```

Run:

```bash
SUPABASE_URL=... \
SUPABASE_ANON_KEY=... \
SUPABASE_SERVICE_ROLE_KEY=... \
ILLICO_PASSWORD=... \
SANAA_PASSWORD=... \
node /tmp/v29-test.mjs
```

Expected result:

```text
Account A / Illico: PASS (... own orders, 0 foreign orders)
Account B / Sanaa: PASS (... own orders, 0 foreign orders)
```

Do not put the service-role key in browser code, Git or Vercel public environment variables.
