#!/usr/bin/env bash
# ============================================================
# Scanym — STUART LOT C v1.3 — DELIVERY FEE VAT ALLOCATION
# FOUNDATION v1 — Harnais reproductible pour
# supabase/DRAFT-lot-delivery-fee-vat-allocation-foundation-v1.sql.
#
# RÉVISÉ v1.2 (CTO pre-control, 3 blockers) : les scénarios [8]/[9]
# v1.1 (qui affirmaient qu'une donnée fiscale incomplète produisait
# ZÉRO ligne SANS bloquer create_order) sont désormais FAUX par
# construction -- LOT-C-12-01 exige que la TRANSACTION échoue
# entièrement. Inversés ci-dessous + 9 tests limites obligatoires
# (0.01€/résidu négatif, LOT-C-12-02).
#
# RÉVISÉ v1.3 (CIO/CTO Décision 2, scope review) : la précondition
# prices_include_tax=true, ajoutée À TORT en v1.2 (bloquait tout
# marchand HT pour toute commande à livraison payante -- régression
# d'une capacité checkout préexistante), est RETIRÉE. Le scénario
# [ht-fail-closed] v1.2 est donc REMPLACÉ par [matrix-10]/[matrix-10b]/
# [matrix-11] ci-dessous, qui prouvent le contraire : un marchand HT
# RÉUSSIT désormais sa commande à livraison payante, avec une
# ventilation TVA persistée correctement (la base line_total reste
# TOUJOURS le montant TTC réellement facturé, indépendant du réglage
# d'affichage prices_include_tax). RID_HT (receipt_settings
# prices_include_tax=false) reste dans les fixtures précisément pour ce
# test positif.
#
# PostgreSQL communautaire vanilla, même patron que tous les harnais
# précédents. Chaîne : même chaîne que
# delivery-financial-persistence-foundation-v1-check.sh (LOT C v1),
# + DRAFT-lot-delivery-financial-persistence-foundation-v1.sql (LOT C
# v1, prérequis structurel : orders.provider_cost, non lu par ce lot
# mais appliqué dans le même candidat) + ce lot.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/delivery-fee-vat-allocation-foundation-v1-check.sh"
# ============================================================

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
LOT_C_V1_SQL="$SUPABASE_DIR/DRAFT-lot-delivery-financial-persistence-foundation-v1.sql"
LOT_C_V11_SQL="$SUPABASE_DIR/DRAFT-lot-delivery-fee-vat-allocation-foundation-v1.sql"
DB="scanym_lotc11_check_$$"

PASS_COUNT=0
FAIL_COUNT=0
STRUCT_COUNT=0
BEHAV_COUNT=0
FAIL_LOG="/tmp/scanym-lotc11-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }
struct() { STRUCT_COUNT=$((STRUCT_COUNT+1)); pass "$@"; }
behav() { BEHAV_COUNT=$((BEHAV_COUNT+1)); pass "$@"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  rm -f "${FAIL_LOG:-}" 2>/dev/null || true
}
trap cleanup EXIT

sql() { psql -X -A -q -t -d "$DB" -c "$1"; }
as_anon() { PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c "$1" 2>&1; }
as_authenticated() {
  local uid="$1" query="$2"
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$\$ begin perform set_config('test.uid', '$uid', false); end \$\$; $query" 2>&1
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then struct "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_behav_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then behav "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_behav_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then behav "$desc"; else fail "$desc — attendu de contenir '$needle', obtenu: $haystack"; fi
}
# LOT-C-12-01 (v1.2) : exécute plusieurs instructions DANS UNE SEULE
# TRANSACTION (begin ... rollback), et vérifie que l'erreur
# SCANYM_DELIVERY_TAX_ALLOCATION est bien levée -- preuve que la
# TRANSACTION ENTIÈRE échoue (jamais un simple "zéro ligne" silencieux,
# comportement v1.1 révolu). Le rollback explicite garantit qu'aucune
# ligne orders/order_items de ce scénario ne persiste, quel que soit le
# comportement réel du moteur en cas d'erreur non catchée.
tx_fail() {
  local desc="$1" sql_body="$2"
  local out
  out="$(psql -X -A -q -t -d "$DB" 2>&1 <<SQL
begin;
$sql_body
rollback;
SQL
)"
  if printf '%s' "$out" | grep -q "SCANYM_DELIVERY_TAX_ALLOCATION"; then
    behav "$desc"
  else
    fail "$desc — attendu échec SCANYM_DELIVERY_TAX_ALLOCATION (transaction entière), obtenu: $out"
  fi
}
# Contrôle négatif : la même transaction doit RÉUSSIR (aucune exception)
# -- utilisé pour prouver qu'un scénario voisin, légitime, n'est PAS
# rejeté à tort par le durcissement fail-closed.
tx_ok() {
  local desc="$1" sql_body="$2"
  local out
  out="$(psql -X -A -q -t -d "$DB" -v ON_ERROR_STOP=1 2>&1 <<SQL
begin;
$sql_body
commit;
SQL
)"
  if [ $? -eq 0 ] && ! printf '%s' "$out" | grep -qi "error\|ERROR"; then
    behav "$desc"
  else
    fail "$desc — attendu succès sans erreur, obtenu: $out"
  fi
}

# ------------------------------------------------------------
# 0. Construction de la chaîne.
# ------------------------------------------------------------
log "=== [0] Construction chaîne $DB ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"

psql -d "$DB" >/dev/null <<'SQL'
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

apply() { psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$1" >/dev/null; }

for f in schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql; do
  apply "$f" || { fail "chaîne minimale interrompue à $f"; exit 1; }
  psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
done
for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql migration-v82-lot2a-sale-modes.sql migration-v83-lot2a4-privilege-hardening.sql migration-v84-lot2b1-delivery-info-rpc.sql DRAFT-lot-fulfillment-routing-model.sql DRAFT-lot-fulfillment-routing-lot-b-rpc.sql DRAFT-lot-server-delivery-fulfillment-pricing.sql DRAFT-lot-payment-p1-foundation.sql; do
  apply "$f" || { fail "chaîne interrompue à $f"; exit 1; }
done

psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), secret text not null, name text, description text, key_id uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create function vault.create_secret(new_secret text, new_name text, new_description text, new_key_id uuid default null) returns uuid language plpgsql as $fn$
declare v_id uuid; begin insert into vault.secrets (secret, name, description, key_id) values (new_secret, new_name, new_description, new_key_id) returning id into v_id; return v_id; end; $fn$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null) returns void language plpgsql as $fn$
begin update vault.secrets set secret=coalesce(new_secret,secret), name=coalesce(new_name,name), description=coalesce(new_description,description), key_id=coalesce(new_key_id,key_id), updated_at=now() where id=secret_id; end; $fn$;
create view vault.decrypted_secrets as select id, secret as decrypted_secret, name, description, key_id, created_at, updated_at from vault.secrets;
SQL

for f in DRAFT-lot-payment-p2a-secure-config.sql DRAFT-lot-payment-p2b-a-safe-merchant-read.sql DRAFT-lot-payment-p3a0-secure-credential-read.sql DRAFT-lot-payment-p3b0-correlation-status-read.sql DRAFT-lot-payment-p3b1-runtime-provider-enablement-read.sql DRAFT-lot-payment-p3b6-checkout-billing-context.sql DRAFT-lot-merchant-legal-tax-profile-v1.sql DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql DRAFT-lot-receipt-invoice-tax-detail-v1.sql DRAFT-lot-customer-order-tracking-foundation.sql DRAFT-lot-orders-service-role-select-hardening.sql; do
  apply "$f" || { fail "chaîne interrompue à $f"; exit 1; }
done
struct "chaîne complète appliquée jusqu'à ORDERS SERVICE_ROLE SELECT HARDENING (inclus)"

if psql -d "$DB" -v ON_ERROR_STOP=1 -f "$LOT_C_V1_SQL" >/dev/null 2>/tmp/scanym-lotc11-v1-err-$$.log; then
  struct "LOT C v1 (delivery-financial-persistence-foundation) appliqué sans erreur"
else
  fail "échec application LOT C v1: $(cat /tmp/scanym-lotc11-v1-err-$$.log)"
fi
rm -f /tmp/scanym-lotc11-v1-err-$$.log

# ------------------------------------------------------------
# 1. Application du lot sous test.
# ------------------------------------------------------------
log "=== [1] Application du lot v1.1 ==="
if psql -d "$DB" -v ON_ERROR_STOP=1 -f "$LOT_C_V11_SQL" >/dev/null 2>/tmp/scanym-lotc11-err-$$.log; then
  struct "lot v1.1 appliqué sans erreur"
else
  fail "échec d'application du lot v1.1: $(cat /tmp/scanym-lotc11-err-$$.log)"
fi
rm -f /tmp/scanym-lotc11-err-$$.log

# ------------------------------------------------------------
# 2. Structure.
# ------------------------------------------------------------
log "=== [2] Structure ==="
assert_eq "table order_delivery_tax_allocations existe" "order_delivery_tax_allocations" "$(sql "select table_name from information_schema.tables where table_name='order_delivery_tax_allocations';")"
assert_eq "PK composite (order_id, tax_rate_snapshot)" "order_id|tax_rate_snapshot" "$(sql "select string_agg(a.attname, '|' order by k.ordinality) from pg_constraint c join unnest(c.conkey) with ordinality k(attnum, ordinality) on true join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum where c.conrelid='order_delivery_tax_allocations'::regclass and c.contype='p';")"
assert_eq "trigger trg_compute_delivery_fee_tax_allocation existe" "trg_compute_delivery_fee_tax_allocation" "$(sql "select tgname from pg_trigger where tgname='trg_compute_delivery_fee_tax_allocation';")"
assert_eq "anon ne peut pas SELECT (grant révoqué)" "" "$(sql "select grantee from information_schema.role_table_grants where table_name='order_delivery_tax_allocations' and grantee='anon';")"
assert_eq "authenticated peut SELECT (RLS-scopé)" "authenticated" "$(sql "select grantee from information_schema.role_table_grants where table_name='order_delivery_tax_allocations' and grantee='authenticated' and privilege_type='SELECT';")"

# ------------------------------------------------------------
# 3. Fixtures.
# ------------------------------------------------------------
log "=== Fixtures ==="
OWNER_A="90000000-0000-0000-0000-000000000001"
OWNER_B="90000000-0000-0000-0000-000000000002"
psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into auth.users (id, email) values ('$OWNER_A', 'owner-a@lotc11.test'), ('$OWNER_B', 'owner-b@lotc11.test');
insert into restaurants (name, slug, status) values ('LOT C11 A', 'lotc11-a', 'active'), ('LOT C11 B', 'lotc11-b', 'active'), ('LOT C11 HT', 'lotc11-ht', 'active');
SQL
RID_A="$(sql "select id from restaurants where slug='lotc11-a';")"
RID_B="$(sql "select id from restaurants where slug='lotc11-b';")"
RID_HT="$(sql "select id from restaurants where slug='lotc11-ht';")"
psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into restaurant_users (restaurant_id, user_id, role) values ('$RID_A','$OWNER_A','owner'), ('$RID_B','$OWNER_B','owner');" >/dev/null
# RID_A/RID_B configurés TTC (prices_include_tax=true) pour que les
# scénarios de ventilation "normaux" (single-rate/mixed-rate/résidu)
# utilisent un instantané fiscal non-NULL (sans ligne receipt_settings
# explicite, le déclencheur BEFORE INSERT `snapshot_receipt_tax_settings`
# laisse l'instantané NULL, ce qui reste indépendamment couvert par
# [matrix-1]/[matrix-2], non lié à prices_include_tax). RID_HT configuré
# HT (prices_include_tax=false) EXPRÈS -- depuis v1.3 (CIO/CTO Décision
# 2), ce réglage n'est PLUS une condition de fermeture : voir
# [matrix-10]/[matrix-10b]/[matrix-11] plus bas, qui prouvent qu'un
# marchand HT réussit désormais sa commande à livraison payante.
psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into receipt_settings (restaurant_id, prices_include_tax, show_tax_summary, tax_label, default_tax_rate)
values ('$RID_A', true, true, 'TVA', 20.00), ('$RID_B', true, true, 'TVA', 20.00);
insert into receipt_settings (restaurant_id, prices_include_tax, show_tax_summary, tax_label, default_tax_rate)
values ('$RID_HT', false, true, 'TVA', 20.00);
SQL

mk_order() {
  local rid="$1" num="$2"
  sql "insert into orders (restaurant_id, order_number, service_mode, subtotal, total, currency, delivery_fee) values ('$rid', $num, 'delivery', 0, 0, 'EUR', 0) returning id;"
}
set_fee() { sql "update orders set delivery_fee=$2, total=(subtotal+$2) where id='$1';" >/dev/null; }

# ------------------------------------------------------------
# 4. [1] Single-rate basket : 100% suit ce taux.
# ------------------------------------------------------------
log "=== [4] Single-rate ==="
O1="$(mk_order "$RID_A" 1)"
sql "insert into order_items (order_id, item_name, quantity, unit_price, line_total, tax_rate_snapshot) values ('$O1','Item',1,20,20,20.00);" >/dev/null
set_fee "$O1" 5.00
assert_behav_eq "[1] 100% du frais suit le taux unique" "20.00|5.00" "$(sql "select tax_rate_snapshot||'|'||delivery_fee_gross_share from order_delivery_tax_allocations where order_id='$O1';")"

# ------------------------------------------------------------
# 5. [2][3][4][5][6][7] Mixed-rate 5.5%/20% + réconciliation.
# ------------------------------------------------------------
log "=== [5] Mixed-rate ==="
O2="$(mk_order "$RID_A" 2)"
sql "insert into order_items (order_id, item_name, quantity, unit_price, line_total, tax_rate_snapshot) values
('$O2','A',1,10,10,5.50), ('$O2','B',1,20,20,20.00);" >/dev/null
set_fee "$O2" 5.00
behav "[2] commande mixte 5.5%/20% appliquée sans erreur"
assert_behav_eq "[3] part 5.5% proportionnelle à la base TTC (10/30)" "1.67" "$(sql "select delivery_fee_gross_share from order_delivery_tax_allocations where order_id='$O2' and tax_rate_snapshot=5.50;")"
assert_behav_eq "[3b] part 20% proportionnelle à la base TTC (20/30)" "3.33" "$(sql "select delivery_fee_gross_share from order_delivery_tax_allocations where order_id='$O2' and tax_rate_snapshot=20.00;")"
assert_behav_eq "[4/7] réconciliation exacte au centime : somme des parts = delivery_fee" "5.00|5.00" "$(sql "select sum(delivery_fee_gross_share)||'|'||(select delivery_fee from orders where id='$O2') from order_delivery_tax_allocations where order_id='$O2';")"
assert_behav_eq "[6] gross = net + tax (5.5%)" "t" "$(sql "select (delivery_fee_gross_share = delivery_fee_net_share + delivery_fee_tax_amount) from order_delivery_tax_allocations where order_id='$O2' and tax_rate_snapshot=5.50;")"
assert_behav_eq "[6b] gross = net + tax (20%)" "t" "$(sql "select (delivery_fee_gross_share = delivery_fee_net_share + delivery_fee_tax_amount) from order_delivery_tax_allocations where order_id='$O2' and tax_rate_snapshot=20.00;")"

# ------------------------------------------------------------
# 6. [5][7] Résidu de centime déterministe (3 taux, résidu non nul).
# ------------------------------------------------------------
log "=== [6] Résidu de centime ==="
O3="$(mk_order "$RID_A" 3)"
sql "insert into order_items (order_id, item_name, quantity, unit_price, line_total, tax_rate_snapshot) values
('$O3','A',1,10,10,5.50), ('$O3','B',1,10,10,10.00), ('$O3','C',1,10,10,20.00);" >/dev/null
set_fee "$O3" 1.00
assert_behav_eq "[5] réconciliation exacte malgré arrondi indépendant (0.33+0.33+0.34)" "1.00|1.00" "$(sql "select sum(delivery_fee_gross_share)||'|'||(select delivery_fee from orders where id='$O3') from order_delivery_tax_allocations where order_id='$O3';")"
assert_behav_eq "[5b] résidu appliqué au taux le PLUS ÉLEVÉ (20%), déterministe" "0.34" "$(sql "select delivery_fee_gross_share from order_delivery_tax_allocations where order_id='$O3' and tax_rate_snapshot=20.00;")"
# Re-jouer un scénario identique -> même résultat (stabilité/déterminisme).
O3B="$(mk_order "$RID_A" 4)"
sql "insert into order_items (order_id, item_name, quantity, unit_price, line_total, tax_rate_snapshot) values
('$O3B','A',1,10,10,5.50), ('$O3B','B',1,10,10,10.00), ('$O3B','C',1,10,10,20.00);" >/dev/null
set_fee "$O3B" 1.00
assert_behav_eq "[stable] même scénario -> même résidu appliqué au même taux" "0.34" "$(sql "select delivery_fee_gross_share from order_delivery_tax_allocations where order_id='$O3B' and tax_rate_snapshot=20.00;")"

# ------------------------------------------------------------
# 6bis. LOT-C-12-02 -- édge case EXACT du CTO pre-control :
# delivery_fee=0.01, deux groupes de base identique. Reproduit AVANT
# correctif (confirmé produire une TVA négative avec le patron v1.1),
# vérifié ICI après correctif : aucune valeur négative, réconciliation
# exacte, gross=net+tax pour chaque ligne, comportement déterministe.
# Couvre les 9 MANDATORY EDGE TESTS du mandat v1.2 (résidu négatif,
# destinataire à TVA initialement nulle, non-négativité, réconciliation
# exacte, stabilité).
# ------------------------------------------------------------
log "=== [6bis] Édge case CTO 0.01€ / 2 groupes égaux (LOT-C-12-02) ==="
O_EDGE="$(mk_order "$RID_A" 9)"
sql "insert into order_items (order_id, item_name, quantity, unit_price, line_total, tax_rate_snapshot) values
('$O_EDGE','A',1,10,10,20.00), ('$O_EDGE','B',1,10,10,5.50);" >/dev/null
set_fee "$O_EDGE" 0.01
assert_behav_eq "[edge-1] résidu négatif : taux 20% (destinataire, TVA initialement nulle avant résidu) -> gross=0.00 (jamais négatif)" "0.00" "$(sql "select delivery_fee_gross_share from order_delivery_tax_allocations where order_id='$O_EDGE' and tax_rate_snapshot=20.00;")"
assert_behav_eq "[edge-2] taux 20% -> net=0.00 (jamais négatif)" "0.00" "$(sql "select delivery_fee_net_share from order_delivery_tax_allocations where order_id='$O_EDGE' and tax_rate_snapshot=20.00;")"
assert_behav_eq "[edge-3] taux 20% -> tax=0.00 (JAMAIS -0.01, bug v1.1 corrigé)" "0.00" "$(sql "select delivery_fee_tax_amount from order_delivery_tax_allocations where order_id='$O_EDGE' and tax_rate_snapshot=20.00;")"
assert_behav_eq "[edge-4] taux 5.5% (non-destinataire) -> gross=0.01, net=0.01, tax=0.00" "0.01|0.01|0.00" "$(sql "select delivery_fee_gross_share||'|'||delivery_fee_net_share||'|'||delivery_fee_tax_amount from order_delivery_tax_allocations where order_id='$O_EDGE' and tax_rate_snapshot=5.50;")"
assert_behav_eq "[edge-5] réconciliation exacte malgré résidu négatif : somme=0.01" "0.01" "$(sql "select sum(delivery_fee_gross_share) from order_delivery_tax_allocations where order_id='$O_EDGE';")"
assert_behav_eq "[edge-6] gross=net+tax pour les 2 lignes (invariant après résidu recalculé, pas patché)" "true|true" "$(sql "select string_agg((delivery_fee_gross_share = delivery_fee_net_share + delivery_fee_tax_amount)::text, '|' order by tax_rate_snapshot) from order_delivery_tax_allocations where order_id='$O_EDGE';")"
assert_behav_eq "[edge-7] aucune valeur négative sur aucune ligne (gross/net/tax >= 0)" "0" "$(sql "select count(*) from order_delivery_tax_allocations where order_id='$O_EDGE' and (delivery_fee_gross_share<0 or delivery_fee_net_share<0 or delivery_fee_tax_amount<0);")"
O_EDGE_B="$(mk_order "$RID_A" 10)"
sql "insert into order_items (order_id, item_name, quantity, unit_price, line_total, tax_rate_snapshot) values
('$O_EDGE_B','A',1,10,10,20.00), ('$O_EDGE_B','B',1,10,10,5.50);" >/dev/null
set_fee "$O_EDGE_B" 0.01
assert_behav_eq "[edge-8/déterministe] même scénario 0.01€ -> résultat identique (taux 20%)" "$(sql "select tax_rate_snapshot||'|'||delivery_fee_gross_share||'|'||delivery_fee_net_share||'|'||delivery_fee_tax_amount from order_delivery_tax_allocations where order_id='$O_EDGE' and tax_rate_snapshot=20.00;")" "$(sql "select tax_rate_snapshot||'|'||delivery_fee_gross_share||'|'||delivery_fee_net_share||'|'||delivery_fee_tax_amount from order_delivery_tax_allocations where order_id='$O_EDGE_B' and tax_rate_snapshot=20.00;")"
assert_behav_eq "[edge-9/déterministe] même scénario 0.01€ -> résultat identique (taux 5.5%)" "$(sql "select tax_rate_snapshot||'|'||delivery_fee_gross_share||'|'||delivery_fee_net_share||'|'||delivery_fee_tax_amount from order_delivery_tax_allocations where order_id='$O_EDGE' and tax_rate_snapshot=5.50;")" "$(sql "select tax_rate_snapshot||'|'||delivery_fee_gross_share||'|'||delivery_fee_net_share||'|'||delivery_fee_tax_amount from order_delivery_tax_allocations where order_id='$O_EDGE_B' and tax_rate_snapshot=5.50;")"

# ------------------------------------------------------------
# 7. LOT-C-12-01 (v1.2) -- fermeture fail-closed RÉELLE : donnée
# fiscale incomplète pour delivery_fee>0 fait désormais ÉCHOUER TOUTE
# LA TRANSACTION create_order (jamais un simple "zéro ligne" silencieux
# -- comportement v1.1 révolu, RÉVOLU CI-DESSOUS PAR L'INVERSION DES
# ANCIENS SCÉNARIOS [8]/[9]).
# ------------------------------------------------------------
log "=== [7] Fermeture fail-closed RÉELLE (LOT-C-12-01) ==="
tx_fail "[8/9-inversé] tax_rate_snapshot manquant + delivery_fee>0 -> LA TRANSACTION ÉCHOUE ENTIÈREMENT (jamais un zéro-ligne silencieux)" "
insert into orders (id, restaurant_id, order_number, service_mode, subtotal, total, currency, delivery_fee) values ('a0000000-0000-0000-0000-000000000001','$RID_A',5001,'delivery',20,20,'EUR',0);
insert into order_items (order_id, item_name, quantity, unit_price, line_total, tax_rate_snapshot) values ('a0000000-0000-0000-0000-000000000001','Item',1,20,20,NULL);
update orders set delivery_fee=5.00, total=25.00 where id='a0000000-0000-0000-0000-000000000001';
"
assert_behav_eq "[8/9-inversé] aucune commande partiellement fiscalisée ne persiste (rollback confirmé)" "0" "$(sql "select count(*) from orders where order_number=5001;")"

tx_fail "[matrix-1] delivery_fee>0 + tax_rate_snapshot manquant -> échec (TEST MATRIX #1)" "
insert into orders (id, restaurant_id, order_number, service_mode, subtotal, total, currency, delivery_fee) values ('a0000000-0000-0000-0000-000000000002','$RID_A',5002,'delivery',10,10,'EUR',0);
insert into order_items (order_id, item_name, quantity, unit_price, line_total, tax_rate_snapshot) values ('a0000000-0000-0000-0000-000000000002','Item',1,10,10,NULL);
update orders set delivery_fee=1.00, total=11.00 where id='a0000000-0000-0000-0000-000000000002';
"

tx_fail "[matrix-2] delivery_fee>0 + aucune ligne order_items -> échec (base d'allocation inutilisable, TEST MATRIX #2)" "
insert into orders (id, restaurant_id, order_number, service_mode, subtotal, total, currency, delivery_fee) values ('a0000000-0000-0000-0000-000000000003','$RID_A',5003,'delivery',0,0,'EUR',0);
update orders set delivery_fee=1.50, total=1.50 where id='a0000000-0000-0000-0000-000000000003';
"

# ------------------------------------------------------------
# LOT C v1.3 -- CIO/CTO Décision 2 (scope review) : la précondition
# prices_include_tax=true a été RETIRÉE du déclencheur -- un marchand
# HT ne doit PLUS jamais voir échouer create_order pour une commande à
# livraison payante (régression v1.2 corrigée). TEST MATRIX #10/#11.
# ------------------------------------------------------------
O_HT="$(mk_order "$RID_HT" 5004)"
sql "insert into order_items (order_id, item_name, quantity, unit_price, line_total, tax_rate_snapshot) values ('$O_HT','Item',1,10,10,20.00);" >/dev/null
set_fee "$O_HT" 1.00
assert_behav_eq "[matrix-10] marchand HT (prices_include_tax=false) + delivery_fee>0 -> create_order RÉUSSIT désormais (régression v1.2 corrigée)" "1.00" "$(sql "select delivery_fee from orders where id='$O_HT';")"
assert_behav_eq "[matrix-10b] marchand HT -> ventilation TVA livraison PERSISTÉE correctement malgré prices_include_tax=false (la base line_total reste TTC réel, indépendant de ce réglage d'affichage)" "20.00|1.00|0.83|0.17" "$(sql "select tax_rate_snapshot||'|'||delivery_fee_gross_share||'|'||delivery_fee_net_share||'|'||delivery_fee_tax_amount from order_delivery_tax_allocations where order_id='$O_HT';")"
assert_behav_eq "[matrix-11] prices_include_tax=false reste une configuration persistée valide sur receipt_settings (non altérée par ce lot)" "f" "$(sql "select prices_include_tax from receipt_settings where restaurant_id='$RID_HT';")"

tx_ok "[matrix-3] livraison GRATUITE + donnée fiscale incomplète -> reste VALIDE, aucune ventilation nécessaire (TEST MATRIX #3, distinct de delivery_fee>0)" "
insert into orders (id, restaurant_id, order_number, service_mode, subtotal, total, currency, delivery_fee) values ('a0000000-0000-0000-0000-000000000005','$RID_A',5005,'delivery',10,10,'EUR',0);
insert into order_items (order_id, item_name, quantity, unit_price, line_total, tax_rate_snapshot) values ('a0000000-0000-0000-0000-000000000005','Item',1,10,10,NULL);
update orders set delivery_fee=0.00, total=10.00 where id='a0000000-0000-0000-0000-000000000005';
"
assert_behav_eq "[matrix-3b] livraison gratuite + donnée incomplète : commande persistée, zéro ligne de ventilation (pas une fermeture fiscale)" "1|0" "$(sql "select (select count(*) from orders where order_number=5005)||'|'||(select count(*) from order_delivery_tax_allocations a join orders o on o.id=a.order_id where o.order_number=5005);")"

# ------------------------------------------------------------
# 8. [10][11] Livraison gratuite / provider_cost non-zéro sans effet.
# ------------------------------------------------------------
log "=== [8] Livraison gratuite ==="
O5="$(mk_order "$RID_A" 6)"
sql "insert into order_items (order_id, item_name, quantity, unit_price, line_total, tax_rate_snapshot) values ('$O5','Item',1,20,20,20.00);" >/dev/null
set_fee "$O5" 0.00
assert_behav_eq "[10] delivery_fee=0 -> zéro ligne de TVA livraison" "0" "$(sql "select count(*) from order_delivery_tax_allocations where order_id='$O5';")"

O6="$(mk_order "$RID_A" 7)"
sql "insert into order_items (order_id, item_name, quantity, unit_price, line_total, tax_rate_snapshot) values ('$O6','Item',1,20,20,20.00);" >/dev/null
sql "select set_order_delivery_provider_financials('$O6', 8.40, 8.40, 'EUR');" >/dev/null
set_fee "$O6" 0.00
assert_behav_eq "[11] provider_cost non nul (8.40) + livraison client gratuite -> TVA client toujours nulle" "0" "$(sql "select count(*) from order_delivery_tax_allocations where order_id='$O6';")"
assert_behav_eq "[11b] provider_cost bien persisté malgré delivery_fee=0 (indépendance confirmée)" "8.40" "$(sql "select provider_cost from orders where id='$O6';")"

# ------------------------------------------------------------
# 9. [12][13] provider_cost / merchant_subsidy absents du calcul TVA.
# ------------------------------------------------------------
log "=== [9] Indépendance provider_cost/subsidy ==="
O7="$(mk_order "$RID_A" 8)"
sql "insert into order_items (order_id, item_name, quantity, unit_price, line_total, tax_rate_snapshot) values ('$O7','Item',1,20,20,20.00);" >/dev/null
set_fee "$O7" 5.00
sql "select set_order_delivery_provider_financials('$O7', 100.00, 95.00, 'EUR');" >/dev/null
assert_behav_eq "[12/13] TVA livraison inchangée quel que soit provider_cost/subsidy (5.00, jamais 100.00/95.00)" "5.00" "$(sql "select delivery_fee_gross_share from order_delivery_tax_allocations where order_id='$O7';")"

# ------------------------------------------------------------
# 10. [14][15] Historique jamais recalculé.
# ------------------------------------------------------------
log "=== [10] Historique immuable ==="
BEFORE="$(sql "select tax_rate_snapshot||'|'||delivery_fee_gross_share from order_delivery_tax_allocations where order_id='$O1';")"
# Change le taux marchand COURANT (receipt_settings) et le taux catalogue COURANT (menu_items) --
# aucun impact sur l'historique déjà écrit (ne relit jamais ces sources).
sql "update receipt_settings set default_tax_rate=99 where restaurant_id='$RID_A';" >/dev/null 2>&1
sql "update menu_items set tax_rate=1 where category_id in (select id from menu_categories where restaurant_id='$RID_A');" >/dev/null 2>&1
AFTER="$(sql "select tax_rate_snapshot||'|'||delivery_fee_gross_share from order_delivery_tax_allocations where order_id='$O1';")"
assert_eq "[14/15] changement de taux marchand/catalogue courant SANS effet sur l'allocation déjà persistée" "$BEFORE" "$AFTER"

# ------------------------------------------------------------
# 11. [16][17][18] Exposition publique/interne.
# ------------------------------------------------------------
log "=== [11] Exposition ==="
OUT_ANON="$(as_anon "select provider_cost, delivery_merchant_subsidy, tax_rate_snapshot from orders o left join order_delivery_tax_allocations a on a.order_id=o.id where o.id='$O7';")"
assert_behav_contains "[16/17] anon ne peut lire ni provider_cost ni la ventilation (permission denied)" "permission denied" "$OUT_ANON"
OUT_MERCHANT_A="$(as_authenticated "$OWNER_A" "select count(*) from order_delivery_tax_allocations a join orders o on o.id=a.order_id where o.restaurant_id='$RID_A';")"
assert_behav_eq "[18] marchand authentifié A lit ses propres lignes internes" "true" "$([ "$OUT_MERCHANT_A" -gt 0 ] 2>/dev/null && echo true || echo false)"
OUT_MERCHANT_B="$(as_authenticated "$OWNER_B" "select count(*) from order_delivery_tax_allocations a join orders o on o.id=a.order_id where o.id='$O7';")"
assert_behav_eq "[cross-tenant] marchand B ne voit pas les lignes du marchand A" "0" "$OUT_MERCHANT_B"

# ------------------------------------------------------------
# 12. [19] Lecture ticket lirait l'instantané (pas de calcul en direct).
# ------------------------------------------------------------
log "=== [12] Lecture snapshot (pas de recalcul) ==="
assert_behav_eq "[19] les lignes persistées sont directement lisibles telles quelles (pas de fonction de recalcul exposée)" "0" "$(sql "select count(*) from pg_proc where proname ilike '%recompute%delivery%tax%' or proname ilike '%recalculate%delivery%tax%';")"

# ------------------------------------------------------------
# 13. [20] TVA produit (order_items) inchangée.
# ------------------------------------------------------------
log "=== [13] Non-régression TVA produit ==="
assert_eq "[20] order_items.tax_rate_snapshot toujours présent et inchangé par ce lot" "20.00" "$(sql "select tax_rate_snapshot from order_items where order_id='$O1' limit 1;")"

# ------------------------------------------------------------
# Bilan.
# ------------------------------------------------------------
log "=== BILAN === PASS=$PASS_COUNT (struct=$STRUCT_COUNT, behav=$BEHAV_COUNT) FAIL=$FAIL_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  log "--- Échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
