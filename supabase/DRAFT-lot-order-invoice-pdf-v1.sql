-- DRAFT: NOT APPLIED. French VAT-registered merchants / EUR / paid online orders.
-- Independent observer: no trigger on orders, no write to payments, catalogue or order state.
begin;
do $$ declare t text; c record; begin
  foreach t in array array['orders','restaurants','order_items','order_invoice_request','receipt_settings','merchant_legal_profile','merchant_notification_profile','payment_transactions','order_delivery_tax_allocations'] loop
    if to_regclass('public.'||t) is null then raise exception 'SCANYM_INVOICE_PREREQUISITE: %',t; end if;
  end loop;
  if to_regclass('public.invoice_pdf_documents') is not null or to_regclass('public.invoice_pdf_settings') is not null
    or to_regclass('public.invoice_pdf_deliveries') is not null or to_regclass('public.invoice_pdf_blocked') is not null or to_regclass('public.invoice_pdf_manifest') is not null then
    raise exception 'SCANYM_INVOICE_ALREADY_INSTALLED'; end if;
  if not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='has_role_in') then
    raise exception 'SCANYM_INVOICE_PREREQUISITE: has_role_in'; end if;
  -- Fail on missing/incompatible critical columns before creating anything.
  for c in select * from (values
    ('orders','id','uuid'),('orders','restaurant_id','uuid'),('orders','current_payment_transaction_id','uuid'),
    ('orders','payment_status','text'),('orders','created_at','timestamp with time zone'),
    ('orders','subtotal','numeric'),('orders','total','numeric'),
    ('order_invoice_request','order_id','uuid'),('order_invoice_request','created_at','timestamp with time zone'),
    ('order_items','tax_rate_snapshot','numeric'),('order_items','quantity','integer'),
    ('payment_transactions','paid_at','timestamp with time zone'),('payment_transactions','amount','numeric')
  ) as v(tbl,col,typ) loop
    if not exists(select 1 from pg_attribute a where a.attrelid=to_regclass('public.'||c.tbl) and a.attname=c.col
      and not a.attisdropped and a.atttypid=c.typ::regtype) then raise exception 'SCANYM_INVOICE_PREREQUISITE: %.%',c.tbl,c.col; end if;
  end loop;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.proname in ('invoice_pdf_source','invoice_pdf_issue','invoice_pdf_store','invoice_pdf_claim_delivery','invoice_pdf_finish_delivery','invoice_pdf_candidates','invoice_pdf_block','invoice_pdf_fingerprint','invoice_pdf_guard_document','invoice_pdf_activation_boundary')) then
    raise exception 'SCANYM_INVOICE_SCHEMA_DRIFT'; end if;
end $$;

create table public.invoice_pdf_settings (
  restaurant_id uuid primary key references public.restaurants(id) on delete restrict,
  series text not null unique check(series ~ '^[A-Z0-9]{2,12}$'),
  enabled boolean not null default false,
  activated_at timestamptz not null default clock_timestamp(),
  next_number bigint not null default 1 check(next_number between 1 and 999999999999),
  -- Reviewed seller-specific legal footer, never guessed by Scanym.
  legal_footer text check(length(btrim(legal_footer)) between 1 and 2000),
  check(not enabled or legal_footer is not null)
);
create table public.invoice_pdf_documents (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete restrict,
  order_id uuid not null unique references public.orders(id) on delete restrict,
  invoice_number text not null,
  sequence_number bigint not null,
  issued_at timestamptz not null default clock_timestamp(),
  source jsonb not null check(jsonb_typeof(source)='object'),
  pdf_base64 text check(length(pdf_base64) between 8 and 2666668),
  pdf_md5 text,
  unique(restaurant_id,sequence_number), unique(restaurant_id,invoice_number),
  check((pdf_base64 is null)=(pdf_md5 is null)),
  check(pdf_md5 is null or pdf_md5=md5(pdf_base64))
);
create table public.invoice_pdf_deliveries (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoice_pdf_documents(id) on delete restrict,
  request_id uuid not null,
  claim_token uuid not null default gen_random_uuid(),
  state text not null default 'sending' check(state in ('sending','accepted','failed')),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique(invoice_id,request_id),
  check((state='sending')=(completed_at is null))
);
create table public.invoice_pdf_blocked (
  order_id uuid primary key references public.orders(id) on delete restrict,
  source_hash text not null,
  last_blocked_at timestamptz not null default clock_timestamp()
);
alter table public.invoice_pdf_blocked enable row level security;
revoke all on public.invoice_pdf_blocked from public,anon,authenticated;
grant select,insert,update on public.invoice_pdf_blocked to service_role;
create index invoice_pdf_documents_restaurant on public.invoice_pdf_documents(restaurant_id);
create index invoice_pdf_deliveries_invoice on public.invoice_pdf_deliveries(invoice_id,created_at desc);

alter table public.invoice_pdf_settings enable row level security;
alter table public.invoice_pdf_documents enable row level security;
alter table public.invoice_pdf_deliveries enable row level security;
revoke all on public.invoice_pdf_settings, public.invoice_pdf_documents, public.invoice_pdf_deliveries from public,anon,authenticated;
-- All browser access uses a verified session + has_role_in; PDF/PII are never public.
grant select,insert,update on public.invoice_pdf_settings, public.invoice_pdf_documents, public.invoice_pdf_deliveries to service_role;

create function public.invoice_pdf_source(p_order_id uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $fn$
 select jsonb_build_object(
  'order',jsonb_build_object(
    'id',o.id,'restaurant_id',o.restaurant_id,'order_number',o.order_number,
    'payment_status',o.payment_status,'service_mode',o.service_mode,'created_at',o.created_at,
    'currency',o.currency,'subtotal',o.subtotal,'total',o.total,
    'tax_settings_snapshot_prices_include_tax',o.tax_settings_snapshot_prices_include_tax,
    'tax_settings_snapshot_default_tax_rate',o.tax_settings_snapshot_default_tax_rate,
    'tax_settings_snapshot_tax_label',o.tax_settings_snapshot_tax_label,
    'tax_settings_snapshot_show_tax_summary',o.tax_settings_snapshot_show_tax_summary,
    'order_items',(select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'item_name',i.item_name,'option_name',i.option_name,
      'quantity',i.quantity,'unit_price',i.unit_price,'line_total',i.line_total,'tax_rate_snapshot',i.tax_rate_snapshot) order by i.id),'[]'::jsonb) from public.order_items i where i.order_id=o.id),
    'order_delivery_tax_allocations',(select coalesce(jsonb_agg(jsonb_build_object('tax_rate_snapshot',a.tax_rate_snapshot,
      'delivery_fee_gross_share',a.delivery_fee_gross_share,'delivery_fee_net_share',a.delivery_fee_net_share,'delivery_fee_tax_amount',a.delivery_fee_tax_amount) order by a.tax_rate_snapshot),'[]'::jsonb) from public.order_delivery_tax_allocations a where a.order_id=o.id)),
  'seller',jsonb_build_object('name',coalesce(nullif(l.legal_entity_name,''),nullif(rs.legal_name,'')),
    'address',coalesce(nullif(rs.legal_address,''),concat_ws(', ',l.address_line1,l.address_line2,l.postal_code,l.city,l.governing_country)),
    'registration',coalesce(nullif(l.siret,''),nullif(l.siren,''),nullif(rs.registration_number,'')),
    'vat',coalesce(nullif(l.vat_number,''),nullif(rs.tax_identifier,'')),
    'email',rs.email,'country',upper(r.country),'legalForm',l.legal_form),
  'buyer',jsonb_build_object('name',case when b.invoice_type='company' then b.company_legal_name else coalesce(nullif(b.contact_name,''),o.customer_name) end,
    'address',concat_ws(', ',b.address_line_1,b.address_line_2,b.postal_code,b.city,b.country),
    'email',coalesce(nullif(b.contact_email,''),o.customer_email),'vat',b.vat_number,'registration',b.siren,'company',b.invoice_type='company'),
  'payment',jsonb_build_object('paidAt',pt.paid_at,'method',pt.provider_code),
  'footer',s.legal_footer,
  'sender',jsonb_build_object('email',np.sender_email,'name',np.sender_name,'replyTo',np.reply_to))
 from public.orders o
 join public.invoice_pdf_settings s on s.restaurant_id=o.restaurant_id and s.enabled
 join public.restaurants r on r.id=o.restaurant_id
 join public.order_invoice_request b on b.order_id=o.id
 join public.receipt_settings rs on rs.restaurant_id=o.restaurant_id
 left join public.merchant_legal_profile l on l.restaurant_id=o.restaurant_id
 join public.merchant_notification_profile np on np.restaurant_id=o.restaurant_id and np.email_enabled
 join public.payment_transactions pt on pt.id=o.current_payment_transaction_id and pt.order_id=o.id and pt.restaurant_id=o.restaurant_id
   and pt.status='paid' and pt.amount=o.total and pt.currency=o.currency and pt.paid_at is not null
 where o.id=p_order_id and o.payment_status='paid' and o.status not in ('cancelled','rejected')
   and o.created_at>=s.activated_at and b.created_at>=s.activated_at
$fn$;

create function public.invoice_pdf_issue(p_order_id uuid,p_expected_source jsonb) returns public.invoice_pdf_documents
language plpgsql security definer set search_path=pg_catalog,public as $fn$
declare d public.invoice_pdf_documents; src jsonb; rid uuid; seq bigint; prefix text; at_time timestamptz;
begin
  -- One logical invoice/order, even when both Vercel projects call concurrently.
  perform pg_advisory_xact_lock(hashtextextended(p_order_id::text,230001));
  select * into d from public.invoice_pdf_documents where order_id=p_order_id;
  if found then return d; end if;
  select restaurant_id into strict rid from public.orders where id=p_order_id;
  -- Serial transactional counter: a rolled-back issuance consumes no number.
  perform 1 from public.invoice_pdf_settings where restaurant_id=rid for update;
  src:=public.invoice_pdf_source(p_order_id);
  if src is null or src is distinct from p_expected_source then raise exception 'SCANYM_INVOICE_SOURCE_CHANGED'; end if;
  select next_number,series into strict seq,prefix from public.invoice_pdf_settings where restaurant_id=rid and enabled;
  at_time:=clock_timestamp();
  insert into public.invoice_pdf_documents(restaurant_id,order_id,invoice_number,sequence_number,issued_at,source)
    values(rid,p_order_id,'FAC-'||prefix||'-'||to_char(at_time at time zone 'Europe/Paris','YYYY')||'-'||lpad(seq::text,greatest(6,length(seq::text)),'0'),seq,at_time,src) returning * into d;
  update public.invoice_pdf_settings set next_number=next_number+1 where restaurant_id=rid;
  return d;
end $fn$;

create function public.invoice_pdf_store(p_invoice_id uuid,p_pdf_base64 text) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $fn$
begin
  if length(p_pdf_base64) not between 8 and 2666668 or p_pdf_base64 !~ '^[A-Za-z0-9+/]+={0,2}$'
    or convert_from(substring(decode(p_pdf_base64,'base64') from 1 for 5),'UTF8')<>'%PDF-' then
    raise exception 'SCANYM_INVOICE_PDF_INVALID'; end if;
  -- First successful renderer wins. Thereafter the bytes never change.
  update public.invoice_pdf_documents set pdf_base64=p_pdf_base64,pdf_md5=md5(p_pdf_base64)
    where id=p_invoice_id and pdf_base64 is null;
  return exists(select 1 from public.invoice_pdf_documents where id=p_invoice_id and pdf_base64 is not null);
end $fn$;

create function public.invoice_pdf_claim_delivery(p_invoice_id uuid,p_request_id uuid) returns public.invoice_pdf_deliveries
language plpgsql security definer set search_path=pg_catalog,public as $fn$
declare d public.invoice_pdf_deliveries;
begin
  -- Stable auto id = invoice id. Manual resends use their own HTTP idempotency key.
  perform 1 from public.invoice_pdf_documents where id=p_invoice_id for update;
  if exists(select 1 from public.invoice_pdf_deliveries where invoice_id=p_invoice_id and request_id=p_request_id) then return null; end if;
  if p_request_id<>p_invoice_id and exists(select 1 from public.invoice_pdf_deliveries
    where invoice_id=p_invoice_id and created_at>clock_timestamp()-interval '60 seconds') then
    raise exception 'SCANYM_INVOICE_RATE_LIMITED'; end if;
  if not exists(select 1 from public.invoice_pdf_documents i join public.invoice_pdf_settings s on s.restaurant_id=i.restaurant_id
    and s.enabled join public.merchant_notification_profile np on np.restaurant_id=i.restaurant_id and np.email_enabled
    where i.id=p_invoice_id and i.pdf_base64 is not null) then raise exception 'SCANYM_INVOICE_DISABLED'; end if;
  insert into public.invoice_pdf_deliveries(invoice_id,request_id) values(p_invoice_id,p_request_id)
    on conflict(invoice_id,request_id) do nothing returning * into d;
  return d; -- null on duplicate: NEVER reclaim a possibly accepted SMTP submission.
end $fn$;

create function public.invoice_pdf_finish_delivery(p_id uuid,p_claim_token uuid,p_state text) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $fn$
begin
  if p_state not in ('accepted','failed') then raise exception 'SCANYM_INVOICE_STATE_INVALID'; end if;
  update public.invoice_pdf_deliveries set state=p_state,completed_at=clock_timestamp()
    where id=p_id and claim_token=p_claim_token and state='sending';
  return found;
end $fn$;

create function public.invoice_pdf_candidates() returns table(order_id uuid)
language sql stable security definer set search_path=pg_catalog,public as $fn$
 select o.id from public.orders o join public.invoice_pdf_settings s on s.restaurant_id=o.restaurant_id and s.enabled
 join public.order_invoice_request b on b.order_id=o.id
 left join public.invoice_pdf_documents i on i.order_id=o.id
 where o.payment_status='paid' and o.status not in ('cancelled','rejected') and o.created_at>=s.activated_at and b.created_at>=s.activated_at
 and not exists(select 1 from public.invoice_pdf_deliveries d where d.invoice_id=i.id and d.request_id=i.id)
 and not exists(select 1 from public.invoice_pdf_blocked b where b.order_id=o.id
   and b.source_hash=md5(coalesce(public.invoice_pdf_source(o.id)::text,'null')))
 order by o.created_at,o.id limit 2
$fn$;

-- A corrupt order cannot starve later invoices. Retry automatically only when
-- its source changes; manual preparation can retry the same archived invoice.
create function public.invoice_pdf_block(p_order_id uuid,p_expected_source jsonb) returns void
language plpgsql security definer set search_path=pg_catalog,public as $fn$
begin
 if public.invoice_pdf_source(p_order_id) is distinct from p_expected_source then return; end if;
 insert into public.invoice_pdf_blocked(order_id,source_hash) values(p_order_id,md5(coalesce(p_expected_source::text,'null')))
 on conflict(order_id) do update set source_hash=excluded.source_hash,last_blocked_at=clock_timestamp();
end $fn$;
revoke all on function public.invoice_pdf_block(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.invoice_pdf_block(uuid,jsonb) to service_role;

-- Immutable archive, including its frozen billing and seller identity.
create function public.invoice_pdf_guard_document() returns trigger
language plpgsql set search_path=pg_catalog,public as $fn$
begin
  if tg_op='DELETE' then raise exception 'SCANYM_INVOICE_IMMUTABLE'; end if;
  if (to_jsonb(new)-'pdf_base64'-'pdf_md5') is distinct from (to_jsonb(old)-'pdf_base64'-'pdf_md5')
    or old.pdf_base64 is not null then raise exception 'SCANYM_INVOICE_IMMUTABLE'; end if;
  return new;
end $fn$;
create trigger invoice_pdf_archive_guard before update or delete on public.invoice_pdf_documents
for each row execute function public.invoice_pdf_guard_document();
create function public.invoice_pdf_activation_boundary() returns trigger
language plpgsql set search_path=pg_catalog,public as $fn$
begin
  if tg_op='UPDATE' and (new.next_number<old.next_number or (new.series<>old.series and exists(select 1 from public.invoice_pdf_documents where restaurant_id=old.restaurant_id))) then
    raise exception 'SCANYM_INVOICE_SERIES_IMMUTABLE'; end if;
  if new.enabled and (tg_op='INSERT' or not old.enabled) then new.activated_at:=clock_timestamp();
  elsif tg_op='UPDATE' then new.activated_at:=old.activated_at; end if;
  return new;
end $fn$;
create trigger invoice_pdf_activation_guard before insert or update on public.invoice_pdf_settings
for each row execute function public.invoice_pdf_activation_boundary();
revoke all on function public.invoice_pdf_guard_document(), public.invoice_pdf_activation_boundary() from public,anon,authenticated,service_role;

-- Whole-object drift guard for rollback, not just function body hashes.
create table public.invoice_pdf_manifest (singleton boolean primary key default true check(singleton), fingerprint text not null);
alter table public.invoice_pdf_manifest enable row level security;
revoke all on public.invoice_pdf_manifest from public,anon,authenticated,service_role;
create function public.invoice_pdf_fingerprint() returns text
language sql stable security definer set search_path=pg_catalog,public as $fn$
 select md5(jsonb_build_object(
  'functions',(select jsonb_agg(jsonb_build_object('identity',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),
    'owner',p.proowner,'acl',p.proacl,'comment',obj_description(p.oid,'pg_proc')) order by p.oid::regprocedure::text)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
    ('invoice_pdf_source','invoice_pdf_issue','invoice_pdf_store','invoice_pdf_claim_delivery','invoice_pdf_finish_delivery','invoice_pdf_candidates','invoice_pdf_block','invoice_pdf_fingerprint','invoice_pdf_guard_document','invoice_pdf_activation_boundary')),
  'relations',(select jsonb_agg(jsonb_build_object('name',c.relname,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
    'columns',(select jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attacl,pg_get_expr(ad.adbin,ad.adrelid)) order by a.attnum)
      from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
    'constraints',(select jsonb_agg(jsonb_build_array(conname,pg_get_constraintdef(oid)) order by conname) from pg_constraint where conrelid=c.oid),
    'indexes',(select jsonb_agg(pg_get_indexdef(indexrelid) order by indexrelid::regclass::text) from pg_index where indrelid=c.oid),
    'triggers',(select jsonb_agg(pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),
    'policies',(select jsonb_agg(jsonb_build_array(polname,polcmd,polroles,pg_get_expr(polqual,polrelid),pg_get_expr(polwithcheck,polrelid)) order by polname) from pg_policy where polrelid=c.oid)) order by c.relname)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in
      ('invoice_pdf_settings','invoice_pdf_documents','invoice_pdf_deliveries','invoice_pdf_blocked','invoice_pdf_manifest'))
 )::text)
$fn$;

revoke all on function public.invoice_pdf_source(uuid), public.invoice_pdf_issue(uuid,jsonb), public.invoice_pdf_store(uuid,text),
 public.invoice_pdf_claim_delivery(uuid,uuid), public.invoice_pdf_finish_delivery(uuid,uuid,text), public.invoice_pdf_candidates(), public.invoice_pdf_fingerprint() from public,anon,authenticated;
grant execute on function public.invoice_pdf_source(uuid), public.invoice_pdf_issue(uuid,jsonb), public.invoice_pdf_store(uuid,text),
 public.invoice_pdf_claim_delivery(uuid,uuid), public.invoice_pdf_finish_delivery(uuid,uuid,text), public.invoice_pdf_candidates() to service_role;
insert into public.invoice_pdf_manifest(fingerprint) values(public.invoice_pdf_fingerprint());
commit;
