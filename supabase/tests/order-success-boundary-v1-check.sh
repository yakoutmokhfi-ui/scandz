#!/usr/bin/env bash
# Scanym ORDER SUCCESS BOUNDARY v1 — disposable PostgreSQL harness.
# No network/provider call; synthetic tenants and orders only.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DB="scanym_order_boundary_$$"
PASS=0
FAIL=0
ERR="/tmp/scanym-order-boundary-err-$$.txt"
OUT="/tmp/scanym-order-boundary-out-$$.txt"
CONCURRENT_A="/tmp/scanym-order-boundary-concurrent-a-$$.txt"
CONCURRENT_B="/tmp/scanym-order-boundary-concurrent-b-$$.txt"

RESTO_A='11111111-1111-4111-8111-111111111111'
CAT_A='21111111-1111-4111-8111-111111111111'
ITEM_A='31111111-1111-4111-8111-111111111111'
RESTO_B='12222222-2222-4222-8222-222222222222'
CAT_B='22222222-2222-4222-8222-222222222222'
ITEM_B='32222222-2222-4222-8222-222222222222'

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
pass() { PASS=$((PASS + 1)); log "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); log "FAIL: $1"; }
assert_eq() {
  if [ "$2" = "$3" ]; then pass "$1 (=$3)"; else fail "$1 — expected '$2', got '$3'"; fi
}
assert_ok() {
  if [ "$2" -eq 0 ]; then pass "$1 (rc=0)"; else fail "$1 — rc=$2: $(head -2 "$ERR" | tr '\n' ' ')"; fi
}

cleanup() {
  psql -X -d postgres -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  rm -f "$ERR" "$OUT" "$CONCURRENT_A" "$CONCURRENT_B"
}
trap cleanup EXIT

sql() { psql -X -A -q -t -d "$DB" -v ON_ERROR_STOP=1 -c "$1" 2>"$ERR"; }
sql_value() { sql "$1" | tail -1 | tr -d ' '; }
as_role() {
  local role="$1" statement="$2"
  PGOPTIONS="-c role=$role" psql -X -A -q -t -d "$DB" -v ON_ERROR_STOP=1 \
    -c "$statement" >"$OUT" 2>"$ERR"
}

build_bootstrap() {
  psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create schema if not exists auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;
create extension if not exists pgcrypto;
create publication supabase_realtime;
do $$ begin
  if not exists (select from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
alter role service_role bypassrls;
alter role anon nobypassrls;
alter role authenticated nobypassrls;
create schema if not exists storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/'); $$;
SQL
}

MINIMAL_CHAIN="schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql"
REST_CHAIN="migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v76-storage-origin-config.sql migration-v71-hardening.sql migration-v72-hardening.sql migration-v73-hardening.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql migration-v82-lot2a-sale-modes.sql migration-v83-lot2a4-privilege-hardening.sql migration-v84-lot2b1-delivery-info-rpc.sql DRAFT-lot-fulfillment-routing-model.sql DRAFT-lot-fulfillment-routing-lot-b-rpc.sql DRAFT-lot-server-delivery-fulfillment-pricing.sql DRAFT-lot-payment-p3b6-checkout-billing-context.sql DRAFT-lot-customer-order-tracking-foundation.sql DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql DRAFT-lot-receipt-invoice-tax-detail-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1-1-remediation.sql DRAFT-lot-payment-p1-foundation.sql DRAFT-lot-merchant-delivery-pricing.sql DRAFT-lot-orders-service-role-select-hardening.sql"
CGV_AFTER_N1A_CHAIN="DRAFT-lot-seller-legal-profile-cgv-engine-v1-2.sql DRAFT-lot-seller-legal-profile-cgv-engine-v1-3.sql DRAFT-lot-seller-legal-profile-cgv-engine-v1-4.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-1.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-2.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-4.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-5.sql"

apply_file() {
  psql -X -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$1" >/dev/null 2>"$ERR"
}

build_chain() {
  local f
  build_bootstrap || return 1
  for f in $MINIMAL_CHAIN; do
    apply_file "$f" || { log "chain failed: $f"; return 1; }
    psql -X -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  done
  for f in $REST_CHAIN; do apply_file "$f" || { log "chain failed: $f"; return 1; }; done
  # The repository's current N1-A artifact requires the eight-argument
  # create_order introduced by CGV v1.1. Apply that proven prerequisite,
  # then N1-A, then the later CGV replacements that remove the direct enqueue.
  apply_file "DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql" || return 1
  apply_file "DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql" || return 1
  for f in $CGV_AFTER_N1A_CHAIN; do apply_file "$f" || { log "chain failed: $f"; return 1; }; done
  psql -X -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  apply_file "DRAFT-lot-order-received-enqueue-recovery-v1.sql" || return 1
}

seed_fixture() {
  psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<SQL
insert into public.restaurants (id, slug, name, is_active, status, country) values
  ('$RESTO_A','boundary-a','Boundary A',true,'active','FR'),
  ('$RESTO_B','boundary-b','Boundary B',true,'active','FR');
insert into public.restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number) values
  ('$RESTO_A','EUR',1,'+33600000001'), ('$RESTO_B','EUR',1,'+33600000002');
insert into public.menu_categories (id, restaurant_id, name, display_order, is_active) values
  ('$CAT_A','$RESTO_A','A',1,true), ('$CAT_B','$RESTO_B','B',1,true);
insert into public.menu_items (id, category_id, name, price, is_available, tax_rate) values
  ('$ITEM_A','$CAT_A','Item A',10.00,true,5.5), ('$ITEM_B','$CAT_B','Item B',11.00,true,5.5);
insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled) values
  ('$RESTO_A','pickup',true), ('$RESTO_B','pickup',true);
insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled, config) values
  ('$RESTO_A','delivery',true,'{"delivery_zone_prefixes":["75"],"delivery_min_items":0}'::jsonb);
insert into public.merchant_notification_profile
  (restaurant_id,email_enabled,sender_name,sender_email,reply_to,default_locale) values
  ('$RESTO_A',true,'Boundary A','sender-a@example.test','reply-a@example.test','fr'),
  ('$RESTO_B',true,'Boundary B','sender-b@example.test','reply-b@example.test','fr');
insert into public.merchant_cgv_profile
  (restaurant_id,withdrawal_regime,preparation_time_min,preparation_time_max,
   preparation_time_unit,presentation_variant,status,profile_version,cold_chain_applicable)
values
  ('$RESTO_A','EXEMPT_PERISHABLE',10,20,'MINUTES','FORMAL','CGV_ACTIVE',1,true);
insert into public.merchant_cgv_version
  (restaurant_id,template_id,template_version,merchant_profile_version,locale,
   presentation_variant,rendered_content,content_hash,status)
select '$RESTO_A',t.id,t.version,1,'fr','FORMAL','<p>Synthetic accepted terms</p>',
       encode(digest('synthetic accepted terms','sha256'),'hex'),'ACTIVE'
from public.cgv_template t
where t.jurisdiction_country='FR' and t.status='PUBLISHED' and t.is_default
order by t.version desc limit 1;
SQL
}

place_order() {
  local slug="$1" item="$2" email="$3"
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -v ON_ERROR_STOP=1 -c \
    "select order_id from public.create_order('$slug','pickup','[{\"menu_item_id\":\"$item\",\"quantity\":1,\"option_item_id\":null}]'::jsonb,null,'{\"name\":\"Synthetic Client\",\"phone\":\"0600000000\",\"email\":\"$email\"}'::jsonb,null,'fr',true);" \
    2>"$ERR" | tail -1 | tr -d ' '
}

place_delivery_order() {
  local email="$1"
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -v ON_ERROR_STOP=1 -c \
    "select order_id from public.create_order('boundary-a','delivery','[{\"menu_item_id\":\"$ITEM_A\",\"quantity\":1,\"option_item_id\":null}]'::jsonb,null,'{\"name\":\"Synthetic Delivery\",\"phone\":\"0600000000\",\"email\":\"$email\",\"address\":\"12 rue Synthetic, 75001 Paris\",\"postalCode\":\"75001\"}'::jsonb,null,'fr',true);" \
    2>"$ERR" | tail -1 | tr -d ' '
}

install_enqueue_failure() {
  sql "create or replace function public.test_reject_notification_outbox() returns trigger language plpgsql set search_path='' as \$\$ begin raise exception 'SYNTHETIC_OUTBOX_UNAVAILABLE'; end \$\$; create trigger test_reject_notification_outbox_trg before insert on public.notification_outbox for each row execute function public.test_reject_notification_outbox();" >/dev/null
}

remove_enqueue_failure() {
  sql "drop trigger if exists test_reject_notification_outbox_trg on public.notification_outbox; drop function if exists public.test_reject_notification_outbox();" >/dev/null
}

log "=== disposable database ==="
psql -X -d postgres -c "drop database if exists \"$DB\";" >/dev/null 2>&1
createdb "$DB" || { log "FATAL: createdb"; exit 1; }
build_chain || { log "FATAL: migration chain: $(head -3 "$ERR")"; exit 1; }
seed_fixture || { log "FATAL: fixture"; exit 1; }
LEGACY_OID="$(place_order boundary-a "$ITEM_A" pre-migration@example.test)"
assert_eq "pre-migration fixture order exists" "36" "${#LEGACY_OID}"
apply_file "migration-20260919000000-order-success-boundary-v1.sql" || { log "FATAL: candidate migration: $(head -3 "$ERR")"; exit 1; }
pass "authorized repository migration chain and forward candidate applied"
assert_eq "pre-existing order was not assigned invented historical intent" "1" "$(sql_value "select count(*) from public.orders where id='$LEGACY_OID' and order_received_notification_intent_at is null")"

log "=== CASE 1 — normal ==="
OID_NORMAL="$(place_order boundary-a "$ITEM_A" normal@example.test)"
assert_eq "normal create_order returns an order id" "36" "${#OID_NORMAL}"
assert_eq "normal order exists" "1" "$(sql_value "select count(*) from public.orders where id='$OID_NORMAL'")"
assert_eq "normal order has one durable intent" "1" "$(sql_value "select count(*) from public.orders where id='$OID_NORMAL' and order_received_notification_intent_at is not null")"
assert_eq "normal create_order performs no synchronous outbox write" "0" "$(sql_value "select count(*) from public.notification_outbox where order_id='$OID_NORMAL'")"
as_role service_role "select * from public.recover_missing_order_received_notifications('$RESTO_A',100);"
assert_eq "normal post-commit recovery creates exactly one outbox row" "1" "$(sql_value "select count(*) from public.notification_outbox where order_id='$OID_NORMAL' and notification_type='order_received'")"

log "=== CASE 2 / CASE 7 — enqueue infrastructure failure ==="
install_enqueue_failure
OID_FAILED="$(place_order boundary-a "$ITEM_A" failed-enqueue@example.test)"
assert_eq "enqueue failure does not escape create_order" "36" "${#OID_FAILED}"
assert_eq "failed-enqueue order remains committed" "1" "$(sql_value "select count(*) from public.orders where id='$OID_FAILED'")"
assert_eq "failed-enqueue order item remains committed" "1" "$(sql_value "select count(*) from public.order_items where order_id='$OID_FAILED'")"
assert_eq "failed-enqueue tracking token remains available" "1" "$(sql_value "select count(*) from public.orders where id='$OID_FAILED' and public_token is not null")"
assert_eq "failed-enqueue CGV acceptance remains committed" "1" "$(sql_value "select count(*) from public.order_cgv_acceptance where order_id='$OID_FAILED' and restaurant_id='$RESTO_A'")"
assert_eq "failed-enqueue fulfillment selection remains committed" "pickup" "$(sql_value "select service_mode from public.orders where id='$OID_FAILED'")"
assert_eq "outbox row is absent under injected failure" "0" "$(sql_value "select count(*) from public.notification_outbox where order_id='$OID_FAILED'")"
assert_eq "missing intent is durably observable" "1" "$(sql_value "select public.count_missing_order_received_notifications('$RESTO_A')")"
as_role service_role "select * from public.recover_missing_order_received_notifications('$RESTO_A',100);"
assert_eq "unavailable outbox yields a closed retry_required outcome" "$OID_FAILED|retry_required" "$(tr -d ' ' < "$OUT" | tail -1)"
assert_eq "failed recovery leaves durable intent observable" "1" "$(sql_value "select public.count_missing_order_received_notifications('$RESTO_A')")"
OID_DELIVERY="$(place_delivery_order delivery-failure@example.test)"
assert_eq "delivery order succeeds while notification outbox is unavailable" "36" "${#OID_DELIVERY}"
assert_eq "delivery address remains authoritative and committed" "12 rue Synthetic, 75001 Paris" "$(sql "select formatted_address from public.order_delivery_address where order_id='$OID_DELIVERY';" | tail -1)"
assert_eq "delivery zone remains committed" "75001" "$(sql_value "select delivery_zone from public.orders where id='$OID_DELIVERY'")"
remove_enqueue_failure

log "=== CASE 3 / CASE 4 — recovery and duplicate recovery ==="
as_role service_role "select * from public.recover_missing_order_received_notifications('$RESTO_A',100);"
RC=$?
assert_ok "service-role recovery succeeds" "$RC"
assert_eq "recovery reports the failed pickup order" "1" "$(tr -d ' ' < "$OUT" | grep -c "^$OID_FAILED|recovered$")"
assert_eq "recovery reports the failed delivery order" "1" "$(tr -d ' ' < "$OUT" | grep -c "^$OID_DELIVERY|recovered$")"
assert_eq "recovery creates exactly one logical outbox row" "1" "$(sql_value "select count(*) from public.notification_outbox where order_id='$OID_FAILED' and notification_type='order_received'")"
assert_eq "delivery recovery creates exactly one logical outbox row" "1" "$(sql_value "select count(*) from public.notification_outbox where order_id='$OID_DELIVERY' and notification_type='order_received'")"
as_role service_role "select * from public.recover_missing_order_received_notifications('$RESTO_A',100);"
assert_eq "duplicate recovery returns no candidate" "0" "$(wc -l < "$OUT" | tr -d ' ')"
assert_eq "duplicate recovery creates no duplicate" "1" "$(sql_value "select count(*) from public.notification_outbox where order_id='$OID_FAILED'")"

log "=== CASE 5 — concurrent recovery ==="
install_enqueue_failure
OID_CONCURRENT="$(place_order boundary-a "$ITEM_A" concurrent@example.test)"
remove_enqueue_failure
(PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -v ON_ERROR_STOP=1 -c "select * from public.recover_missing_order_received_notifications('$RESTO_A',100);" >"$CONCURRENT_A" 2>&1) &
PID_A=$!
(PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" -v ON_ERROR_STOP=1 -c "select * from public.recover_missing_order_received_notifications('$RESTO_A',100);" >"$CONCURRENT_B" 2>&1) &
PID_B=$!
wait "$PID_A"; RC_A=$?
wait "$PID_B"; RC_B=$?
assert_eq "concurrent worker A completes" "0" "$RC_A"
assert_eq "concurrent worker B completes" "0" "$RC_B"
assert_eq "concurrent recovery creates one outbox row" "1" "$(sql_value "select count(*) from public.notification_outbox where order_id='$OID_CONCURRENT'")"
assert_eq "concurrent recovery leaves no missing intent" "0" "$(sql_value "select public.count_missing_order_received_notifications('$RESTO_A')")"

log "=== CASE 6 — tenant isolation ==="
install_enqueue_failure
OID_A="$(place_order boundary-a "$ITEM_A" tenant-a@example.test)"
OID_B="$(place_order boundary-b "$ITEM_B" tenant-b@example.test)"
remove_enqueue_failure
as_role service_role "select * from public.recover_missing_order_received_notifications('$RESTO_A',100);"
assert_eq "tenant A recovery creates tenant A outbox row" "1" "$(sql_value "select count(*) from public.notification_outbox where order_id='$OID_A' and restaurant_id='$RESTO_A'")"
assert_eq "tenant A recovery cannot mutate tenant B intent" "0" "$(sql_value "select count(*) from public.notification_outbox where order_id='$OID_B'")"
assert_eq "tenant B missing intent remains visible only in B count" "1" "$(sql_value "select public.count_missing_order_received_notifications('$RESTO_B')")"
assert_eq "tenant A missing count is clean" "0" "$(sql_value "select public.count_missing_order_received_notifications('$RESTO_A')")"
as_role service_role "select * from public.recover_missing_order_received_notifications('$RESTO_B',100);"
assert_eq "tenant B can be recovered independently" "1" "$(sql_value "select count(*) from public.notification_outbox where order_id='$OID_B' and restaurant_id='$RESTO_B'")"

log "=== CASE 8 — email provider failure after enqueue ==="
OID_EMAIL="$(place_order boundary-a "$ITEM_A" provider-failure@example.test)"
as_role service_role "select * from public.recover_missing_order_received_notifications('$RESTO_A',100);"
CLAIM="$(sql "select outbox_id || '|' || claim_token from public.claim_pending_notifications(100,60) where order_id='$OID_EMAIL';" | tail -1 | tr -d ' ')"
OUTBOX_ID="${CLAIM%%|*}"
CLAIM_TOKEN="${CLAIM#*|}"
sql "select public.complete_notification_attempt('$OUTBOX_ID','$CLAIM_TOKEN',1,'fake-local','retryable_failure',null,'PROVIDER_TEMPORARY_UNAVAILABLE');" >/dev/null
assert_eq "provider failure is recorded on outbox" "failed_retryable" "$(sql_value "select status from public.notification_outbox where id='$OUTBOX_ID'")"
assert_eq "provider failure does not alter order validity" "1" "$(sql_value "select count(*) from public.orders where id='$OID_EMAIL'")"

log "=== security and provenance ==="
assert_eq "anon cannot execute recovery" "f" "$(sql_value "select has_function_privilege('anon','public.recover_missing_order_received_notifications(uuid,integer)','EXECUTE')")"
assert_eq "authenticated cannot execute recovery" "f" "$(sql_value "select has_function_privilege('authenticated','public.recover_missing_order_received_notifications(uuid,integer)','EXECUTE')")"
assert_eq "service_role can execute recovery" "t" "$(sql_value "select has_function_privilege('service_role','public.recover_missing_order_received_notifications(uuid,integer)','EXECUTE')")"
assert_eq "recovery function is SECURITY DEFINER" "t" "$(sql_value "select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='recover_missing_order_received_notifications'")"
assert_eq "recovery search_path is empty" 'search_path=""' "$(sql "select array_to_string(proconfig,',') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='recover_missing_order_received_notifications';" | tail -1)"
assert_eq "only the pre-migration order has a NULL intent marker" "1" "$(sql_value "select count(*) from public.orders where order_received_notification_intent_at is null")"
assert_eq "historical synchronous enqueue trigger is absent" "0" "$(sql_value "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='orders' and t.tgname='orders_enqueue_order_received_trg' and not t.tgisinternal")"

log "=== SUMMARY ==="
log "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
