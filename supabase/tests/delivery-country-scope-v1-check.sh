#!/usr/bin/env bash
# ============================================================
# Scanym — DELIVERY COUNTRY SCOPE v1 — harnais SQL RÉEL
# (PostgreSQL réel, base jetable, aucune simulation).
#
# Même idiome que supabase/tests/orders-service-role-select-hardening-check.sh
# (bootstrap, chaîne minimale, émulation des rôles et de auth.uid()).
#
# Usage depuis la racine du dépôt :
#   su postgres -c "bash supabase/tests/delivery-country-scope-v1-check.sh"
# ============================================================
set -uo pipefail

SUPABASE_DIR="${SUPABASE_DIR:-supabase}"
DRAFT_SQL="$SUPABASE_DIR/DRAFT-lot-delivery-country-scope-v1.sql"
ROLLBACK_SQL="$SUPABASE_DIR/DRAFT-lot-delivery-country-scope-v1-ROLLBACK.sql"
DB="scanym_dcs_$$"

PASS_COUNT=0
FAIL_COUNT=0
FAIL_LOG="/tmp/scanym-dcs-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  rm -f "${FAIL_LOG:-}" /tmp/scanym-dcs-out-$$.txt /tmp/scanym-dcs-err-$$.txt 2>/dev/null || true
}
trap cleanup EXIT

assert_eq() {
  local d="$1" e="$2" a="$3"
  if [ "$e" = "$a" ]; then pass "$d (=$a)"; else fail "$d — attendu '$e', obtenu '$a'"; fi
}
assert_contains() {
  local d="$1" n="$2" h="$3"
  if printf '%s' "$h" | grep -qi -- "$n"; then pass "$d"; else fail "$d — '$n' absent de : $h"; fi
}
assert_nonzero_rc() {
  local d="$1" rc="$2"
  if [ "$rc" != "0" ]; then pass "$d (rc=$rc, refusé comme attendu)"; else fail "$d — a RÉUSSI alors qu'il devait être refusé"; fi
}

sql() { psql -X -A -q -t -d "$DB" -c "$1"; }
sql_rc() {
  psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-dcs-out-$$.txt 2>/tmp/scanym-dcs-err-$$.txt
  echo $?
}
as_user() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$1'; $2" 2>&1
}
as_user_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" -c "set local test.uid = '$1'; $2" \
    >/tmp/scanym-dcs-out-$$.txt 2>/tmp/scanym-dcs-err-$$.txt
  echo $?
}
as_anon() { PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" 2>&1; }
as_anon_rc() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" \
    >/tmp/scanym-dcs-out-$$.txt 2>/tmp/scanym-dcs-err-$$.txt
  echo $?
}
last_err() { cat /tmp/scanym-dcs-err-$$.txt 2>/dev/null; }
last_out() { cat /tmp/scanym-dcs-out-$$.txt 2>/dev/null; }

build_common_bootstrap() {
  psql -d "$1" >/dev/null <<'SQL'
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

# ------------------------------------------------------------------
# CHAÎNE PRÉDÉCESSEUR — reprise VERBATIM de
# supabase/tests/customer-followup-tracking-email-v1-check.sh, qui est
# le harnais du lot ayant publié la définition courante de create_order.
# Toute approximation de chaîne produirait des preuves sans valeur ;
# le harnais refuse donc de démarrer si un seul maillon manque.
# ------------------------------------------------------------------
MINIMAL_CHAIN="schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql"
REST_CHAIN="migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v76-storage-origin-config.sql migration-v71-hardening.sql migration-v72-hardening.sql migration-v73-hardening.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql migration-v82-lot2a-sale-modes.sql migration-v83-lot2a4-privilege-hardening.sql migration-v84-lot2b1-delivery-info-rpc.sql DRAFT-lot-fulfillment-routing-model.sql DRAFT-lot-fulfillment-routing-lot-b-rpc.sql DRAFT-lot-server-delivery-fulfillment-pricing.sql DRAFT-lot-payment-p3b6-checkout-billing-context.sql DRAFT-lot-customer-order-tracking-foundation.sql DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql DRAFT-lot-receipt-invoice-tax-detail-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1-1-remediation.sql DRAFT-lot-payment-p1-foundation.sql DRAFT-lot-merchant-delivery-pricing.sql DRAFT-lot-orders-service-role-select-hardening.sql"
CGV_AFTER_N1A_CHAIN="DRAFT-lot-seller-legal-profile-cgv-engine-v1-2.sql DRAFT-lot-seller-legal-profile-cgv-engine-v1-3.sql DRAFT-lot-seller-legal-profile-cgv-engine-v1-4.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-1.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-2.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-4.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-5.sql"
TRACKING_TAIL="DRAFT-lot-tracking-final-fiscal-summary-v1-1.sql DRAFT-lot-customer-tracking-capability-v3-1.sql DRAFT-lot-customer-contact-live-tracking-v1.sql"

ERR="/tmp/scanym-dcs-chain-$$.err"
apply_file() { psql -X -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$1" >/dev/null 2>"$ERR"; }
fatal() { echo "FATAL: $*"; exit 1; }

for f in $MINIMAL_CHAIN $REST_CHAIN DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql \
         DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql $CGV_AFTER_N1A_CHAIN \
         DRAFT-lot-order-received-enqueue-recovery-v1.sql \
         migration-20260919000000-order-success-boundary-v1.sql $TRACKING_TAIL \
         DRAFT-lot-customer-followup-tracking-email-v1.sql; do
  [ -f "$SUPABASE_DIR/$f" ] || fatal "maillon de chaîne absent : supabase/$f"
done

# ============================================================
log "=== [0] Baseline ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
build_common_bootstrap "$DB"

for f in $MINIMAL_CHAIN; do
  apply_file "$f" || fatal "chaîne, $f : $(head -3 "$ERR" | tr '\n' ' ')"
  psql -X -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
done
for f in $REST_CHAIN; do
  apply_file "$f" || fatal "chaîne, $f : $(head -3 "$ERR" | tr '\n' ' ')"
done
apply_file "DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql" || fatal "CGV v1.1 : $(head -3 "$ERR" | tr '\n' ' ')"
apply_file "DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql" || fatal "N1-A : $(head -3 "$ERR" | tr '\n' ' ')"
for f in $CGV_AFTER_N1A_CHAIN; do
  apply_file "$f" || fatal "chaîne CGV, $f : $(head -3 "$ERR" | tr '\n' ' ')"
done
psql -X -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
apply_file "DRAFT-lot-order-received-enqueue-recovery-v1.sql" || fatal "reprise d'enfilement : $(head -3 "$ERR" | tr '\n' ' ')"
apply_file "migration-20260919000000-order-success-boundary-v1.sql" || fatal "ORDER SUCCESS BOUNDARY v1 : $(head -3 "$ERR" | tr '\n' ' ')"

# order_invoice_request : talon d'EXISTENCE (même talon que le harnais
# CFTE). Ce lot n'en lit jamais le contenu.
psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<'SQL' || fatal "talon order_invoice_request"
create table public.order_invoice_request (
  order_id uuid primary key references public.orders(id) on delete cascade
);
alter table public.order_invoice_request enable row level security;
revoke all on table public.order_invoice_request from public, anon, authenticated;
SQL
for f in $TRACKING_TAIL; do
  apply_file "$f" || fatal "chaîne de suivi, $f : $(head -3 "$ERR" | tr '\n' ' ')"
done
apply_file "DRAFT-lot-customer-followup-tracking-email-v1.sql" || fatal "CFTE v1 : $(head -3 "$ERR" | tr '\n' ' ')"
log "chaîne prédécesseur appliquée."

HAS_CREATE_ORDER="$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_order';")"
assert_eq "0a. baseline : create_order présente" "1" "$HAS_CREATE_ORDER"
BE_BEFORE="$(sql "select count(*) from public.scanym_supported_countries where code='BE';")"
assert_eq "0b. baseline : BE ABSENT du référentiel (constat du mandat)" "0" "$BE_BEFORE"
TNMA_BEFORE="$(sql "select count(*) from public.scanym_supported_countries where code in ('TN','MA');")"
assert_eq "0c. baseline : TN et MA présents" "2" "$TNMA_BEFORE"
L3_BEFORE="$(sql "select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='resolve_delivery_fulfillment';")"

# ============================================================
log "=== [1] Application du lot ==="
if psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/tmp/scanym-dcs-out-$$.txt 2>&1; then
  pass "1a. le lot s'applique intégralement (contrôles post-application passés)"
else
  fail "1a. échec : $(tail -5 /tmp/scanym-dcs-out-$$.txt)"
fi

# ============================================================
log "=== [2] L1 — modèle de capacité ==="
assert_eq "2a. BE est entré dans le référentiel plateforme (Q10)" "1" \
  "$(sql "select count(*) from public.scanym_supported_countries where code='BE';")"
assert_eq "2b. TN et MA sont CONSERVÉS (Q11 : ne rien retirer)" "2" \
  "$(sql "select count(*) from public.scanym_supported_countries where code in ('TN','MA');")"
assert_eq "2c. TN, MA et DZ NE SONT PAS livrables" "0" \
  "$(sql "select count(*) from public.scanym_country_delivery_capability where country_code in ('TN','MA','DZ') and delivery_capable;")"
assert_eq "2d. FR et BE sont livrables" "2" \
  "$(sql "select count(*) from public.scanym_country_delivery_capability where country_code in ('FR','BE') and delivery_capable;")"
assert_eq "2e. FR : 5 chiffres, fournisseur BAN/IGN" "^[0-9]{5}\$|ban_ign" \
  "$(sql "select postal_code_pattern || '|' || address_provider from public.scanym_country_delivery_capability where country_code='FR';")"
assert_eq "2f. BE : 4 chiffres, AUCUN fournisseur inventé (manual)" "^[0-9]{4}\$|manual" \
  "$(sql "select postal_code_pattern || '|' || address_provider from public.scanym_country_delivery_capability where country_code='BE';")"
assert_eq "2g. BE : ordre d'adresse « rue puis numéro » (bpost)" "street_first" \
  "$(sql "select address_line_order from public.scanym_country_delivery_capability where country_code='BE';")"
RC_CAPABLE_NO_RULES="$(sql_rc "insert into public.scanym_country_delivery_capability (country_code, delivery_capable) values ('MA', true);")"
assert_nonzero_rc "2h. un pays livrable SANS règles de validation est refusé par contrainte" "$RC_CAPABLE_NO_RULES"

# ============================================================
log "=== FIXTURES ==="
OP_UID="70000000-0000-0000-0000-0000000000aa"
OWNER_ALC="70000000-0000-0000-0000-0000000000b1"
OWNER_BE="70000000-0000-0000-0000-0000000000b2"

psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into auth.users (id, email) values
  ('$OP_UID','operator@dcs.test'), ('$OWNER_ALC','owner@aulaitcru.test'), ('$OWNER_BE','owner@be.test');
insert into public.scanym_operators (user_id, note) values ('$OP_UID','harnais DCS v1');
insert into public.restaurants (name, slug, status, is_active, country) values
  ('Au lait cru','au-lait-cru-dcs','active', true, 'FR'),
  ('Fromagerie Bruxelloise','fixture-be-dcs','active', true, 'BE');
SQL
RID_ALC="$(sql "select id from public.restaurants where slug='au-lait-cru-dcs';")"
RID_BE="$(sql "select id from public.restaurants where slug='fixture-be-dcs';")"

assert_eq "F1. un établissement BE peut EXISTER (FK restaurants.country -> BE)" "BE" \
  "$(sql "select country from public.restaurants where id='$RID_BE';")"

psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into public.restaurant_users (restaurant_id, user_id, role) values
  ('$RID_ALC','$OWNER_ALC','owner'), ('$RID_BE','$OWNER_BE','owner');
insert into public.restaurant_configs (restaurant_id, whatsapp_number, currency, next_order_number)
  values ('$RID_ALC','+33600000000','EUR',1), ('$RID_BE','+32470000000','EUR',1);
insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled, config) values
  ('$RID_ALC','delivery', true, '{}'::jsonb), ('$RID_ALC','pickup', true, '{}'::jsonb),
  ('$RID_BE','delivery', true, '{}'::jsonb);
SQL

# L3 — TERRITOIRE COMMERCIAL AU LAIT CRU : métropole + Corse.
# Préfixes vérifiés le 2026-09-25 sur geo.api.gouv.fr (API officielle de
# l'État) : départements métropolitains 01..19, 2A/2B (codes postaux
# 20xxx), 21..95 ; outre-mer 971, 972, 973, 974, 976 -> EXCLUS ;
# 98xxx -> zéro commune française (Monaco) -> EXCLU.
PREFIXES="$(python3 - <<'PY'
m = [f"{i:02d}" for i in range(1, 96)]   # 01..95, "20" = Corse
print("{" + ",".join(f'"{p}"' for p in m) + "}")
PY
)"
psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into public.restaurant_sale_mode_fulfillments
  (restaurant_id, mode_code, fulfillment_code, provider, enabled, display_order,
   zone_prefixes, pricing_mode, fixed_fee, min_items, customer_text)
values
  ('$RID_ALC','delivery','local_delivery','internal', true, 1,
   '$PREFIXES'::text[], 'fixed', 4.90, null, 'Livraison France métropolitaine + Corse'),
  ('$RID_BE','delivery','local_delivery','internal', true, 1,
   '{"1","2","3","4","5","6","7","8","9"}'::text[], 'fixed', 4.90, null, 'Livraison Belgique');
SQL
assert_eq "F2. L3 Au Lait Cru : 95 préfixes métropolitains configurés" "95" \
  "$(sql "select array_length(zone_prefixes,1) from public.restaurant_sale_mode_fulfillments where restaurant_id='$RID_ALC';")"

# ============================================================
log "=== [3] L2 — administration OPÉRATEUR UNIQUEMENT (Q13) ==="
RC_OWNER_SET="$(as_user_rc "$OWNER_ALC" "select public.set_restaurant_delivery_countries('$RID_ALC', array['FR']);")"
assert_nonzero_rc "3a. le PROPRIÉTAIRE ne peut PAS activer un pays de livraison" "$RC_OWNER_SET"
assert_contains "3b. le refus dit « Scanym operator required »" "Scanym operator required" "$(last_err)"

RC_ANON_SET="$(as_anon_rc "select public.set_restaurant_delivery_countries('$RID_ALC', array['FR']);")"
assert_nonzero_rc "3c. anon ne peut pas activer un pays" "$RC_ANON_SET"

OP_SET="$(as_user "$OP_UID" "select public.set_restaurant_delivery_countries('$RID_ALC', array['FR']);")"
assert_eq "3d. l'OPÉRATEUR configure Au Lait Cru en FR only" "1" "$OP_SET"
assert_eq "3e. L2 Au Lait Cru = {FR}" "FR" \
  "$(sql "select string_agg(country_code, ',' order by country_code) from public.restaurant_delivery_countries where restaurant_id='$RID_ALC';")"

OP_SET_BE="$(as_user "$OP_UID" "select public.set_restaurant_delivery_countries('$RID_BE', array['BE']);")"
assert_eq "3f. l'opérateur configure la fixture plateforme en BE" "1" "$OP_SET_BE"

RC_NOT_CAPABLE="$(as_user_rc "$OP_UID" "select public.set_restaurant_delivery_countries('$RID_ALC', array['FR','MA']);")"
assert_nonzero_rc "3g. activer un pays NON livrable (MA) est refusé" "$RC_NOT_CAPABLE"
assert_contains "3h. le refus porte SCANYM_DELIVERY_COUNTRY_NOT_CAPABLE" "SCANYM_DELIVERY_COUNTRY_NOT_CAPABLE" "$(last_err)"
assert_eq "3i. après refus, L2 d'Au Lait Cru est INCHANGÉE (aucune mutation partielle)" "FR" \
  "$(sql "select string_agg(country_code, ',' order by country_code) from public.restaurant_delivery_countries where restaurant_id='$RID_ALC';")"

RC_UNKNOWN="$(as_user_rc "$OP_UID" "select public.set_restaurant_delivery_countries('$RID_ALC', array['ZZ']);")"
assert_nonzero_rc "3j. un code pays inconnu est refusé" "$RC_UNKNOWN"

RC_DIRECT_WRITE="$(as_user_rc "$OP_UID" "insert into public.restaurant_delivery_countries (restaurant_id, country_code) values ('$RID_ALC','BE');")"
assert_nonzero_rc "3k. écriture DIRECTE sur L2 impossible, même pour l'opérateur" "$RC_DIRECT_WRITE"

# ============================================================
log "=== [4] Q14 — capacité transfrontalière préservée ==="
OP_CROSS="$(as_user "$OP_UID" "select public.set_restaurant_delivery_countries('$RID_ALC', array['FR','BE']);")"
assert_eq "4a. un marchand FRANÇAIS peut être configuré FR+BE (capacité architecturale)" "2" "$OP_CROSS"
OP_BACK="$(as_user "$OP_UID" "select public.set_restaurant_delivery_countries('$RID_ALC', array['FR']);")"
assert_eq "4b. ... et ramené à FR only — BE N'EST PAS activé pour Au Lait Cru" "1" "$OP_BACK"

# ============================================================
log "=== [5] Lecture publique ==="
PUB="$(as_anon "select country_code || '|' || address_provider || '|' || postal_code_pattern from public.get_restaurant_public_delivery_countries('$RID_ALC');")"
assert_eq "5a. le parcours client anonyme lit FR + son fournisseur + son format" "FR|ban_ign|^[0-9]{5}\$" "$PUB"
PUB_BE="$(as_anon "select country_code || '|' || address_provider from public.get_restaurant_public_delivery_countries('$RID_BE');")"
assert_eq "5b. la fixture BE annonce « manual » — aucun fournisseur belge inventé" "BE|manual" "$PUB_BE"
assert_eq "5c. aucun pays pour un établissement non configuré" "0" \
  "$(as_anon "select count(*) from public.get_restaurant_public_delivery_countries('99999999-9999-9999-9999-999999999999');")"

# ============================================================
log "=== [6] create_order — AU LAIT CRU (FR only) ==="
ITEMS_ALC="$(sql "insert into public.menu_categories (restaurant_id, name, display_order) values ('$RID_ALC','Fromages',1) returning id;")"
PROD_ALC="$(sql "insert into public.menu_items (category_id, name, price, is_available, display_order) values ('$ITEMS_ALC','Comte',10.00,true,1) returning id;")"

order_alc() {
  # $1 = JSON p_customer
  as_anon_rc "select * from public.create_order('au-lait-cru-dcs','delivery', '[{\"menu_item_id\":\"$PROD_ALC\",\"quantity\":1}]'::jsonb, null, '$1'::jsonb, null, 'fr', false);"
}

CUST_PARIS='{"first_name":"Victor","last_name":"Hugo","name":"Victor Hugo","phone":"0612345678","email":"victor.hugo@example.test","address":"12 rue Ordener, 75018 Paris","postalCode":"75018","street":"12 rue Ordener","city":"Paris","country":"FR"}'
RC_OK="$(order_alc "$CUST_PARIS")"
assert_eq "6a. commande PARIS (FR, 75018) acceptée" "0" "$RC_OK"
assert_eq "6b. le pays est PERSISTÉ dans order_delivery_address" "FR" \
  "$(sql "select oda.country from public.order_delivery_address oda join public.orders o on o.id = oda.order_id where o.restaurant_id = '$RID_ALC' order by o.created_at desc limit 1;")"

CUST_CORSE='{"first_name":"Victor","last_name":"Hugo","name":"Victor Hugo","phone":"0612345678","email":"victor.hugo@example.test","address":"1 cours Napoleon, 20000 Ajaccio","postalCode":"20000","street":"1 cours Napoleon","city":"Ajaccio","country":"FR"}'
RC_CORSE="$(order_alc "$CUST_CORSE")"
assert_eq "6c. CORSE (20000 Ajaccio) reste ÉLIGIBLE — vérifié dept 2A sur geo.api.gouv.fr" "0" "$RC_CORSE"

CUST_DOM='{"first_name":"Victor","last_name":"Hugo","name":"Victor Hugo","phone":"0612345678","email":"victor.hugo@example.test","address":"1 rue Victor Hugo, 97200 Fort-de-France","postalCode":"97200","street":"1 rue Victor Hugo","city":"Fort-de-France","country":"FR"}'
RC_DOM="$(order_alc "$CUST_DOM")"
assert_nonzero_rc "6d. OUTRE-MER (97200) REFUSÉ — pays FR valide, territoire non servi" "$RC_DOM"
assert_contains "6e. ... et refusé par la bonne décision : OUT_OF_DELIVERY_ZONE" "SCANYM_OUT_OF_DELIVERY_ZONE" "$(last_err)"

CUST_FORGED='{"first_name":"Victor","last_name":"Hugo","name":"Victor Hugo","phone":"0612345678","email":"victor.hugo@example.test","address":"Rue de la Loi 16, 1000 Bruxelles","postalCode":"1000","street":"Rue de la Loi 16","city":"Bruxelles","country":"BE"}'
RC_FORGED="$(order_alc "$CUST_FORGED")"
assert_nonzero_rc "6f. charge utile FORGÉE country=BE REFUSÉE côté serveur" "$RC_FORGED"
assert_contains "6g. ... avec SCANYM_DELIVERY_COUNTRY_NOT_ALLOWED" "SCANYM_DELIVERY_COUNTRY_NOT_ALLOWED" "$(last_err)"

CUST_BADPOSTAL='{"first_name":"Victor","last_name":"Hugo","name":"Victor Hugo","phone":"0612345678","email":"victor.hugo@example.test","address":"1 rue Test, 1000 Paris","postalCode":"1000","street":"1 rue Test","city":"Paris","country":"FR"}'
RC_BADPOSTAL="$(order_alc "$CUST_BADPOSTAL")"
assert_nonzero_rc "6h. code postal à 4 chiffres en FR REFUSÉ" "$RC_BADPOSTAL"
assert_contains "6i. ... avec SCANYM_POSTAL_CODE_INVALID (et non « hors zone »)" "SCANYM_POSTAL_CODE_INVALID" "$(last_err)"

# LES TROIS ERREURS SONT BIEN DISTINCTES
BAD_ERR="$(last_err)"
if printf '%s' "$BAD_ERR" | grep -q "SCANYM_OUT_OF_DELIVERY_ZONE"; then
  fail "6j. un code postal MAL FORMÉ ne doit pas être rapporté comme « hors zone »"
else
  pass "6j. format invalide et hors-zone sont deux erreurs DISTINCTES"
fi

CUST_LEGACY='{"first_name":"Victor","last_name":"Hugo","name":"Victor Hugo","phone":"0612345678","email":"victor.hugo@example.test","address":"12 rue Ordener, 75018 Paris","postalCode":"75018","street":"12 rue Ordener","city":"Paris"}'
RC_LEGACY="$(order_alc "$CUST_LEGACY")"
assert_eq "6k. COMPATIBILITÉ : charge utile SANS pays acceptée (1 seul pays autorisé)" "0" "$RC_LEGACY"
assert_eq "6l. ... et le pays est résolu à FR, pas laissé vide" "FR" \
  "$(sql "select oda.country from public.order_delivery_address oda join public.orders o on o.id = oda.order_id where o.restaurant_id = '$RID_ALC' order by o.created_at desc limit 1;")"

# ============================================================
log "=== [7] create_order — FIXTURE PLATEFORME BE ==="
CAT_BE="$(sql "insert into public.menu_categories (restaurant_id, name, display_order) values ('$RID_BE','Fromages',1) returning id;")"
PROD_BE="$(sql "insert into public.menu_items (category_id, name, price, is_available, display_order) values ('$CAT_BE','Gouda',10.00,true,1) returning id;")"

order_be() {
  as_anon_rc "select * from public.create_order('fixture-be-dcs','delivery', '[{\"menu_item_id\":\"$PROD_BE\",\"quantity\":1}]'::jsonb, null, '$1'::jsonb, null, 'fr', false);"
}

CUST_BXL='{"first_name":"Victor","last_name":"Hugo","name":"Victor Hugo","phone":"0470123456","email":"victor.hugo@example.test","address":"Rue de la Loi 16, 1000 Bruxelles","postalCode":"1000","street":"Rue de la Loi 16","city":"Bruxelles","country":"BE"}'
RC_BE_OK="$(order_be "$CUST_BXL")"
assert_eq "7a. commande BELGE (1000 Bruxelles, 4 chiffres) ACCEPTÉE" "0" "$RC_BE_OK"
assert_eq "7b. le pays BE est PERSISTÉ" "BE" \
  "$(sql "select oda.country from public.order_delivery_address oda join public.orders o on o.id = oda.order_id where o.restaurant_id = '$RID_BE' order by o.created_at desc limit 1;")"

CUST_BE_FR_POSTAL='{"first_name":"Victor","last_name":"Hugo","name":"Victor Hugo","phone":"0470123456","email":"victor.hugo@example.test","address":"12 rue Ordener, 75018 Paris","postalCode":"75018","street":"12 rue Ordener","city":"Paris","country":"BE"}'
RC_BE_FR="$(order_be "$CUST_BE_FR_POSTAL")"
assert_nonzero_rc "7c. code postal à 5 chiffres en BE REFUSÉ (format belge = 4)" "$RC_BE_FR"
assert_contains "7d. ... avec SCANYM_POSTAL_CODE_INVALID" "SCANYM_POSTAL_CODE_INVALID" "$(last_err)"

CUST_BE_FORGED='{"first_name":"Victor","last_name":"Hugo","name":"Victor Hugo","phone":"0612345678","email":"victor.hugo@example.test","address":"12 rue Ordener, 75018 Paris","postalCode":"75018","street":"12 rue Ordener","city":"Paris","country":"FR"}'
RC_BE_FORGED="$(order_be "$CUST_BE_FORGED")"
assert_nonzero_rc "7e. charge utile FR sur un marchand BE-only refusée (symétrie)" "$RC_BE_FORGED"
assert_contains "7f. ... avec SCANYM_DELIVERY_COUNTRY_NOT_ALLOWED" "SCANYM_DELIVERY_COUNTRY_NOT_ALLOWED" "$(last_err)"

# ============================================================
log "=== [8] Fail-closed : aucun pays configuré ==="
psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into public.restaurants (name, slug, status, is_active, country) values ('Sans pays','sans-pays-dcs','active', true, 'FR');
SQL
RID_NONE="$(sql "select id from public.restaurants where slug='sans-pays-dcs';")"
psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into public.restaurant_configs (restaurant_id, whatsapp_number, currency, next_order_number) values ('$RID_NONE','+33600000000','EUR',1);
insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled, config) values ('$RID_NONE','delivery', true, '{}'::jsonb);
insert into public.restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, enabled, display_order, zone_prefixes, pricing_mode, fixed_fee, customer_text)
  values ('$RID_NONE','delivery','local_delivery','internal', true, 1, '{"75"}'::text[], 'fixed', 4.90, 'Livraison');
SQL
CAT_N="$(sql "insert into public.menu_categories (restaurant_id, name, display_order) values ('$RID_NONE','C',1) returning id;")"
PROD_N="$(sql "insert into public.menu_items (category_id, name, price, is_available, display_order) values ('$CAT_N','P',10.00,true,1) returning id;")"
RC_NONE="$(as_anon_rc "select * from public.create_order('sans-pays-dcs','delivery', '[{\"menu_item_id\":\"$PROD_N\",\"quantity\":1}]'::jsonb, null, '$CUST_PARIS'::jsonb, null, 'fr', false);")"
assert_nonzero_rc "8a. aucun pays configuré => livraison REFUSÉE (fail-closed)" "$RC_NONE"
assert_contains "8b. ... avec SCANYM_DELIVERY_COUNTRY_NOT_ALLOWED" "SCANYM_DELIVERY_COUNTRY_NOT_ALLOWED" "$(last_err)"

log "=== [8bis] Plusieurs pays + charge utile sans pays => refus ==="
as_user "$OP_UID" "select public.set_restaurant_delivery_countries('$RID_NONE', array['FR','BE']);" >/dev/null
RC_AMBIG="$(as_anon_rc "select * from public.create_order('sans-pays-dcs','delivery', '[{\"menu_item_id\":\"$PROD_N\",\"quantity\":1}]'::jsonb, null, '$CUST_LEGACY'::jsonb, null, 'fr', false);")"
assert_nonzero_rc "8c. 2 pays autorisés + pays absent => refus (on ne devine jamais)" "$RC_AMBIG"
assert_contains "8d. ... avec SCANYM_DELIVERY_COUNTRY_REQUIRED" "SCANYM_DELIVERY_COUNTRY_REQUIRED" "$(last_err)"

# ============================================================
# v1.1 — DCS-LEGACY-BE-01 : sans règle de fulfillment ACTIVE, create_order
# empruntait le chemin historique (extraction FR à cinq chiffres dans le
# texte libre de l'adresse + delivery_zone_prefixes), quel que soit le
# pays résolu. Ce chemin est désormais réservé à FR.
log "=== [8ter] DCS-LEGACY-BE-01 : chemin postal historique réservé à FR ==="
psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
update public.restaurant_sale_mode_fulfillments set enabled = false where restaurant_id in ('$RID_BE','$RID_NONE');
update public.restaurant_sale_modes set config = '{"delivery_zone_prefixes":["1","7"]}'::jsonb
  where restaurant_id in ('$RID_BE','$RID_NONE') and mode_code = 'delivery';
SQL
assert_eq "L0. fixture BE : AUCUNE règle de fulfillment active" "0" \
  "$(sql "select count(*) from public.restaurant_sale_mode_fulfillments where restaurant_id='$RID_BE' and enabled;")"
BE_ORDERS_BEFORE="$(sql "select count(*) from public.orders where restaurant_id='$RID_BE';")"
BE_NEXT_BEFORE="$(sql "select next_order_number from public.restaurant_configs where restaurant_id='$RID_BE';")"

RC_L1="$(order_be "$CUST_BXL")"
L1_ERR="$(last_err)"
assert_nonzero_rc "L1. BE sans règle active : commande 1000 Bruxelles REFUSÉE" "$RC_L1"
assert_contains "L2. ... avec SCANYM_DELIVERY_COUNTRY_NOT_ALLOWED (chemin historique réservé à FR)" "chemin postal historique reserve a FR" "$L1_ERR"
if printf '%s' "$L1_ERR" | grep -q -e "Code postal absent" -e "SCANYM_OUT_OF_DELIVERY_ZONE" -e "SCANYM_POSTAL_CODE_INVALID"; then
  fail "L3. BE ne doit JAMAIS atteindre l'extraction postale FR — erreur obtenue : $L1_ERR"
else
  pass "L3. BE n'atteint pas l'extraction postale FR (ni « Code postal absent », ni hors-zone, ni format)"
fi

CUST_BE_5DIGITS='{"first_name":"Victor","last_name":"Hugo","name":"Victor Hugo","phone":"0470123456","email":"victor.hugo@example.test","address":"Chaussee de Wavre 12345, 1050 Ixelles","postalCode":"1050","street":"Chaussee de Wavre 12345","city":"Ixelles","country":"BE"}'
RC_L4="$(order_be "$CUST_BE_5DIGITS")"
L4_ERR="$(last_err)"
assert_nonzero_rc "L4. BE sans règle active, adresse contenant un nombre à 5 chiffres : REFUSÉE" "$RC_L4"
assert_contains "L5. ... avec SCANYM_DELIVERY_COUNTRY_NOT_ALLOWED" "SCANYM_DELIVERY_COUNTRY_NOT_ALLOWED" "$L4_ERR"
if printf '%s' "$L4_ERR" | grep -q "12345"; then
  fail "L6. le nombre à 5 chiffres a été extrait comme code postal FR : $L4_ERR"
else
  pass "L6. aucun « code postal » à 5 chiffres extrait du texte libre belge"
fi

CUST_BE_NOCOUNTRY='{"first_name":"Victor","last_name":"Hugo","name":"Victor Hugo","phone":"0470123456","email":"victor.hugo@example.test","address":"Rue de la Loi 16, 1000 Bruxelles","postalCode":"1000","street":"Rue de la Loi 16","city":"Bruxelles"}'
RC_L7="$(order_be "$CUST_BE_NOCOUNTRY")"
assert_nonzero_rc "L7. BE-only sans règle active, charge utile SANS pays (résolu BE) : REFUSÉE" "$RC_L7"
assert_contains "L8. ... avec SCANYM_DELIVERY_COUNTRY_NOT_ALLOWED" "chemin postal historique reserve a FR" "$(last_err)"

assert_eq "L9. aucune commande BE écrite par les refus (aucune mutation)" "$BE_ORDERS_BEFORE" \
  "$(sql "select count(*) from public.orders where restaurant_id='$RID_BE';")"
assert_eq "L10. numérotation BE inchangée par les refus" "$BE_NEXT_BEFORE" \
  "$(sql "select next_order_number from public.restaurant_configs where restaurant_id='$RID_BE';")"

RC_L11="$(as_anon_rc "select * from public.create_order('sans-pays-dcs','delivery', '[{\"menu_item_id\":\"$PROD_N\",\"quantity\":1}]'::jsonb, null, '$CUST_BXL'::jsonb, null, 'fr', false);")"
assert_nonzero_rc "L11. marchand FR configuré FR+BE, sans règle active, pays BE : REFUSÉ" "$RC_L11"
assert_contains "L12. ... avec SCANYM_DELIVERY_COUNTRY_NOT_ALLOWED" "chemin postal historique reserve a FR" "$(last_err)"

assert_eq "L13. structure : la garde pays précède l'extraction à 5 chiffres dans create_order" "t" \
  "$(sql "select position('chemin postal historique reserve a FR' in p.prosrc) between 1 and position('substring(v_address from' in p.prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_order';")"

# FR : le chemin historique reste STRICTEMENT inchangé.
psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
update public.restaurant_sale_mode_fulfillments set enabled = false where restaurant_id = '$RID_ALC';
update public.restaurant_sale_modes set config = '{"delivery_zone_prefixes":["75"]}'::jsonb
  where restaurant_id = '$RID_ALC' and mode_code = 'delivery';
SQL
RC_L14="$(order_alc "$CUST_PARIS")"
assert_eq "L14. FR sans règle active : 75018 Paris ACCEPTÉE par le chemin historique" "0" "$RC_L14"
assert_eq "L15. ... zone = code extrait du texte (75018), frais 0, pays FR (comportement historique)" "75018|0.00|FR" \
  "$(sql "select o.delivery_zone || '|' || o.delivery_fee || '|' || oda.country from public.orders o join public.order_delivery_address oda on oda.order_id = o.id where o.restaurant_id = '$RID_ALC' order by o.created_at desc, o.order_number desc limit 1;")"
RC_L16="$(order_alc "$CUST_LEGACY")"
assert_eq "L16. FR sans règle active, charge utile SANS pays : ACCEPTÉE (inchangé)" "0" "$RC_L16"
RC_L17="$(order_alc "$CUST_DOM")"
assert_nonzero_rc "L17. FR sans règle active, 97200 hors préfixes historiques : REFUSÉE" "$RC_L17"
assert_contains "L18. ... avec SCANYM_OUT_OF_DELIVERY_ZONE (inchangé)" "SCANYM_OUT_OF_DELIVERY_ZONE: Zone non desservie: 97200" "$(last_err)"
CUST_FR_NOPOSTAL='{"first_name":"Victor","last_name":"Hugo","name":"Victor Hugo","phone":"0612345678","email":"victor.hugo@example.test","address":"12 rue Ordener Paris","postalCode":"75018","street":"12 rue Ordener","city":"Paris","country":"FR"}'
RC_L19="$(order_alc "$CUST_FR_NOPOSTAL")"
assert_nonzero_rc "L19. FR sans règle active, adresse sans 5 chiffres : REFUSÉE (inchangé)" "$RC_L19"
assert_contains "L20. ... avec « Code postal absent de l'adresse » (message historique)" "Code postal absent de l'adresse" "$(last_err)"

# Restauration des fixtures pour la suite du harnais.
psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
update public.restaurant_sale_mode_fulfillments set enabled = true where restaurant_id in ('$RID_ALC','$RID_BE','$RID_NONE');
update public.restaurant_sale_modes set config = '{}'::jsonb
  where restaurant_id in ('$RID_ALC','$RID_BE','$RID_NONE') and mode_code = 'delivery';
SQL

# ============================================================
log "=== [9] Non-régression : L3 et les autres modes intacts ==="
L3_AFTER="$(sql "select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='resolve_delivery_fulfillment';")"
assert_eq "9a. resolve_delivery_fulfillment est BIT POUR BIT identique" "$L3_BEFORE" "$L3_AFTER"

RC_PICKUP="$(as_anon_rc "select * from public.create_order('au-lait-cru-dcs','pickup', '[{\"menu_item_id\":\"$PROD_ALC\",\"quantity\":1}]'::jsonb, null, '{\"first_name\":\"Victor\",\"last_name\":\"Hugo\",\"name\":\"Victor Hugo\",\"phone\":\"0612345678\",\"email\":\"victor.hugo@example.test\"}'::jsonb, null, 'fr', false);")"
assert_eq "9b. le mode PICKUP n'est pas affecté (aucun contrôle de pays)" "0" "$RC_PICKUP"

# ============================================================
log "=== [10] Rollback ==="
if psql -d "$DB" -v ON_ERROR_STOP=1 -v scanym_allow_be_establishments=yes -f "$ROLLBACK_SQL" >/tmp/scanym-dcs-out-$$.txt 2>&1; then
  pass "10a. le rollback s'exécute intégralement"
else
  fail "10a. rollback en échec : $(tail -5 /tmp/scanym-dcs-out-$$.txt)"
fi
assert_eq "10b. les tables du lot sont supprimées" "0" \
  "$(sql "select count(*) from information_schema.tables where table_schema='public' and table_name in ('restaurant_delivery_countries','scanym_country_delivery_capability');")"
assert_eq "10c. BE reste dans le référentiel (FK restaurants.country préservée)" "1" \
  "$(sql "select count(*) from public.scanym_supported_countries where code='BE';")"
assert_eq "10d. create_order restaurée : plus aucune sentinelle du lot" "0" \
  "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_order' and p.prosrc like '%SCANYM_DELIVERY_COUNTRY_NOT_ALLOWED%';")"
RC_AFTER_RB="$(as_anon_rc "select * from public.create_order('au-lait-cru-dcs','delivery', '[{\"menu_item_id\":\"$PROD_ALC\",\"quantity\":1}]'::jsonb, null, '$CUST_PARIS'::jsonb, null, 'fr', false);")"
assert_eq "10e. après rollback, une commande FR passe comme avant le lot" "0" "$RC_AFTER_RB"
assert_eq "10f. L3 toujours intacte après rollback" "$L3_BEFORE" \
  "$(sql "select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='resolve_delivery_fulfillment';")"

RC_RB_TWICE="$(psql -d "$DB" -v ON_ERROR_STOP=1 -v scanym_allow_be_establishments=yes -f "$ROLLBACK_SQL" >/tmp/scanym-dcs-out-$$.txt 2>&1; echo $?)"
assert_nonzero_rc "10g. relancer le rollback est refusé (fail-closed)" "$RC_RB_TWICE"
assert_contains "10h. ... avec SCANYM_ROLLBACK_DRIFT" "SCANYM_ROLLBACK_DRIFT" "$(cat /tmp/scanym-dcs-out-$$.txt)"

# ============================================================
log "=== RÉSUMÉ : PASS=$PASS_COUNT FAIL=$FAIL_COUNT ==="
if [ "$FAIL_COUNT" -ne 0 ]; then echo "--- échecs ---"; cat "$FAIL_LOG"; exit 1; fi
exit 0
