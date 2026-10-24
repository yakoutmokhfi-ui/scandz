#!/usr/bin/env bash
# PAYMENT P4-A ORDER PAYMENT REQUIRED — contrôle comportemental sur un
# Postgres LOCAL (jamais la base hébergée).
#
# Fixture MINIMALE et déclarée comme telle : seules les colonnes et
# contraintes que le lot lit ou modifie sont reproduites (orders :
# id/public_token/restaurant_id/status/total/payment_status + la CHECK
# nommée orders_payment_status_check de PAYMENT P1 ; payment_provider_configs :
# restaurant_id/provider_code/is_enabled/configuration_status). Les rôles
# anon/authenticated/service_role sont créés s'ils n'existent pas.
#
# Usage : PGHOST=/tmp PGPORT=54329 PGUSER=postgres bash supabase/tests/payment-p4a-order-payment-required-check.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOT="$ROOT/supabase/DRAFT-lot-payment-p4a-order-payment-required.sql"
ROLLBACK="$ROOT/supabase/DRAFT-lot-payment-p4a-order-payment-required-rollback.sql"
DB="scanym_p4a_$$"
PASS=0; FAIL=0

q() { psql -X -v ON_ERROR_STOP=1 -qAt -d "$DB" "$@"; }
expect() { # expect <label> <expected> <actual>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "ok   - $1"; else FAIL=$((FAIL+1)); echo "FAIL - $1 (attendu [$2], obtenu [$3])"; fi
}
expect_error() { # expect_error <label> <sqlfile-or-cmd> <substring>
  local out
  if out=$(psql -X -v ON_ERROR_STOP=1 -qAt -d "$DB" -f "$2" 2>&1); then
    FAIL=$((FAIL+1)); echo "FAIL - $1 (aucune erreur, attendu : $3)"
  elif echo "$out" | grep -q "$3"; then PASS=$((PASS+1)); echo "ok   - $1"
  else FAIL=$((FAIL+1)); echo "FAIL - $1 (erreur inattendue : $out)"; fi
}

createdb "$DB"
trap 'dropdb --if-exists "$DB" >/dev/null 2>&1 || true' EXIT

q <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
create table public.restaurants (id uuid primary key);
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id),
  public_token uuid not null default gen_random_uuid(),
  status text not null default 'new' check (status in ('new','accepted','preparing','ready','completed','rejected','cancelled')),
  total numeric not null default 0,
  payment_status text not null default 'not_required'
    constraint orders_payment_status_check check (payment_status in ('not_required','pending','paid','failed','cancelled'))
);
create table public.payment_provider_configs (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id),
  provider_code text not null,
  is_enabled boolean not null default false,
  configuration_status text not null default 'not_configured',
  unique (restaurant_id, provider_code)
);
insert into public.restaurants values ('aaaaaaaa-0000-4000-8000-000000000001'), ('aaaaaaaa-0000-4000-8000-000000000002');
-- R1 : config activée + vérifiée ; R2 : config activée mais seulement configured.
insert into public.payment_provider_configs (restaurant_id, provider_code, is_enabled, configuration_status) values
  ('aaaaaaaa-0000-4000-8000-000000000001','monetico',true,'verified'),
  ('aaaaaaaa-0000-4000-8000-000000000002','monetico',true,'configured');
SQL

echo "== application du lot"
q -f "$LOT" >/dev/null
expect "fonction créée" "1" "$(q -c "select count(*) from pg_proc where proname='require_order_payment'")"
expect "CHECK contient required" "t" "$(q -c "select pg_get_constraintdef(oid) ilike '%''required''%' from pg_constraint where conname='orders_payment_status_check'")"
expect "double application refusée" "" "$(psql -X -qAt -d "$DB" -f "$LOT" 2>&1 | grep -c 'déjà appliqué' | sed 's/^1$//')"
expect "anon sans EXECUTE" "f" "$(q -c "select has_function_privilege('anon','public.require_order_payment(uuid,uuid,text)','execute')")"
expect "authenticated sans EXECUTE" "f" "$(q -c "select has_function_privilege('authenticated','public.require_order_payment(uuid,uuid,text)','execute')")"
expect "service_role avec EXECUTE" "t" "$(q -c "select has_function_privilege('service_role','public.require_order_payment(uuid,uuid,text)','execute')")"

echo "== comportement"
O1=$(q -c "insert into public.orders (restaurant_id,total) values ('aaaaaaaa-0000-4000-8000-000000000001', 12.5) returning id||'|'||public_token")
ID1=${O1%%|*}; TK1=${O1##*|}
expect "mauvais jeton -> ensemble vide" "" "$(q -c "select * from public.require_order_payment('$ID1', gen_random_uuid(), 'monetico')")"
expect "arguments NULL -> ensemble vide" "" "$(q -c "select * from public.require_order_payment(null, null, 'monetico')")"
expect "commande inconnue -> ensemble vide" "" "$(q -c "select * from public.require_order_payment(gen_random_uuid(), '$TK1', 'monetico')")"
expect "config vérifiée + new + total>0 -> required/changed" "required|true" "$(q -c "select payment_status||'|'||changed from public.require_order_payment('$ID1','$TK1','monetico')")"
expect "persisté en base" "required" "$(q -c "select payment_status from public.orders where id='$ID1'")"
expect "idempotent (rappel) -> required/unchanged" "required|false" "$(q -c "select payment_status||'|'||changed from public.require_order_payment('$ID1','$TK1','monetico')")"

O2=$(q -c "insert into public.orders (restaurant_id,total) values ('aaaaaaaa-0000-4000-8000-000000000002', 12.5) returning id||'|'||public_token")
ID2=${O2%%|*}; TK2=${O2##*|}
expect "config seulement configured -> inchangé" "not_required|false" "$(q -c "select payment_status||'|'||changed from public.require_order_payment('$ID2','$TK2','monetico')")"

O3=$(q -c "insert into public.orders (restaurant_id,total,status) values ('aaaaaaaa-0000-4000-8000-000000000001', 12.5, 'accepted') returning id||'|'||public_token")
ID3=${O3%%|*}; TK3=${O3##*|}
expect "commande déjà acceptée -> inchangé" "not_required|false" "$(q -c "select payment_status||'|'||changed from public.require_order_payment('$ID3','$TK3','monetico')")"

O4=$(q -c "insert into public.orders (restaurant_id,total) values ('aaaaaaaa-0000-4000-8000-000000000001', 0) returning id||'|'||public_token")
ID4=${O4%%|*}; TK4=${O4##*|}
expect "total 0 -> inchangé" "not_required|false" "$(q -c "select payment_status||'|'||changed from public.require_order_payment('$ID4','$TK4','monetico')")"

O5=$(q -c "insert into public.orders (restaurant_id,total) values ('aaaaaaaa-0000-4000-8000-000000000001', 9) returning id||'|'||public_token")
ID5=${O5%%|*}; TK5=${O5##*|}
expect "autre prestataire (sans config) -> inchangé" "not_required|false" "$(q -c "select payment_status||'|'||changed from public.require_order_payment('$ID5','$TK5','autre')")"
expect "provider_code invalide -> erreur 22023" "22023" "$(psql -X -qAt -d "$DB" -c "select * from public.require_order_payment('$ID5','$TK5','bad code!')" 2>&1 | grep -o '22023\|invalide' | head -1 | sed 's/invalide/22023/')"

O6=$(q -c "insert into public.orders (restaurant_id,total,payment_status) values ('aaaaaaaa-0000-4000-8000-000000000001', 9, 'paid') returning id||'|'||public_token")
ID6=${O6%%|*}; TK6=${O6##*|}
expect "déjà paid -> renvoyé tel quel, inchangé" "paid|false" "$(q -c "select payment_status||'|'||changed from public.require_order_payment('$ID6','$TK6','monetico')")"
expect "config désactivée -> inchangé" "not_required|false" "$(q -c "update public.payment_provider_configs set is_enabled=false where restaurant_id='aaaaaaaa-0000-4000-8000-000000000001'; select payment_status||'|'||changed from public.require_order_payment('$ID5','$TK5','monetico')")"

echo "== rollback"
expect "rollback refusé tant qu'une commande est required" "1" "$(psql -X -qAt -d "$DB" -f "$ROLLBACK" 2>&1 | grep -c 'SCANYM_ROLLBACK_REFUSED')"
q -c "update public.orders set payment_status='not_required' where id='$ID1'" >/dev/null
q -f "$ROLLBACK" >/dev/null
expect "fonction retirée" "0" "$(q -c "select count(*) from pg_proc where proname='require_order_payment'")"
expect "CHECK restaurée sans required" "f" "$(q -c "select pg_get_constraintdef(oid) ilike '%''required''%' from pg_constraint where conname='orders_payment_status_check'")"
expect "ré-application possible après rollback" "1" "$(q -f "$LOT" >/dev/null 2>&1; q -c "select count(*) from pg_proc where proname='require_order_payment'")"

echo "== résultat : $PASS ok, $FAIL échec(s)"
[ "$FAIL" -eq 0 ]
