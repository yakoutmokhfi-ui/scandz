-- LOCAL / DRAFT ONLY. Destructive only to B234 objects; no business data writes.
-- Requires the private snapshot captured by the forward migration. No CASCADE.
begin;
drop trigger b234_lock_rules on public.restaurant_sale_mode_fulfillments;
drop trigger b234_check_rules on public.restaurant_sale_mode_fulfillments;
drop trigger b234_lock_modes on public.restaurant_sale_modes;
drop trigger b234_check_modes on public.restaurant_sale_modes;
drop trigger b234_lock_countries on public.restaurant_delivery_countries;
drop trigger b234_check_countries on public.restaurant_delivery_countries;
drop function public.preview_merchant_delivery_rule_save(uuid,uuid,boolean);
drop function public.mutate_merchant_delivery_rule(uuid,text,uuid,jsonb);
drop function public.test_merchant_delivery_postcode(uuid,text,text,numeric,integer);
drop function scanym_internal.lock_delivery_rules();
drop function scanym_internal.check_delivery_rules();
drop function scanym_internal.assert_delivery_zones(uuid);
drop function scanym_internal.delivery_postal_shape(text);
drop function scanym_internal.delivery_zone_blockers(jsonb,jsonb);
drop function public.get_merchant_delivery_fulfillment_pricing(uuid);
do $restore$
declare saved record; acl record; grantee_sql text;
begin
  select * into strict saved from scanym_internal.b234_predecessor;
  perform set_config('b234.schema_created',saved.schema_created::text,true);
  execute saved.definition;
  execute format('alter function public.get_merchant_delivery_fulfillment_pricing(uuid) owner to %I',saved.owner_name);
  execute format('comment on function public.get_merchant_delivery_fulfillment_pricing(uuid) is %L',saved.description);
  -- Remove default privileges (including locally configured default grants).
  for acl in select distinct a.grantee from pg_proc p,
    lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where p.oid='public.get_merchant_delivery_fulfillment_pricing(uuid)'::regprocedure loop
    grantee_sql := case when acl.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(acl.grantee)) end;
    execute 'revoke all on function public.get_merchant_delivery_fulfillment_pricing(uuid) from '||grantee_sql;
  end loop;
  for acl in select * from jsonb_to_recordset(saved.grants) as x(grantee text,grantor text,grantable boolean) loop
    grantee_sql := case when acl.grantee='PUBLIC' then 'PUBLIC' else quote_ident(acl.grantee) end;
    execute format('set local role %I',acl.grantor);
    execute 'grant execute on function public.get_merchant_delivery_fulfillment_pricing(uuid) to '||grantee_sql||case when acl.grantable then ' with grant option' else '' end;
    reset role;
  end loop;
end $restore$;
drop table scanym_internal.b234_predecessor;
-- Remove a schema only when this installation created it, and only if empty.
do $$ begin
  if current_setting('b234.schema_created')::boolean then execute 'drop schema scanym_internal'; end if;
end $$;
commit;
