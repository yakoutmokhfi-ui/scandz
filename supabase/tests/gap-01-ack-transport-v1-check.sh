#!/usr/bin/env bash
# ============================================================
# Scanym — GAP-01 — ACKNOWLEDGEMENT TRANSPORT v1 — harnais SQL RÉEL
# (PostgreSQL réel, base jetable, aucune simulation).
#
# Même idiome que supabase/tests/delivery-country-scope-v1-check.sh
# (bootstrap, chaîne minimale, émulation des rôles et de auth.uid()).
# Chaîne reprise jusqu'à ONLINE WITHDRAWAL v1/v1.1 + cgv_template v6,
# puis ce lot (GAP-01) est appliqué et vérifié, puis son ROLLBACK.
#
# Usage depuis la racine du dépôt :
#   su postgres -c "bash supabase/tests/gap-01-ack-transport-v1-check.sh"
# ============================================================
set -uo pipefail

SUPABASE_DIR="${SUPABASE_DIR:-supabase}"
DRAFT_SQL="$SUPABASE_DIR/DRAFT-lot-gap-01-ack-transport-v1.sql"
ROLLBACK_SQL="$SUPABASE_DIR/DRAFT-lot-gap-01-ack-transport-v1-ROLLBACK.sql"
DB="scanym_gap01_$$"

PASS_COUNT=0
FAIL_COUNT=0
FAIL_LOG="/tmp/scanym-gap01-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  rm -f "${FAIL_LOG:-}" /tmp/scanym-gap01-out-$$.txt /tmp/scanym-gap01-err-$$.txt 2>/dev/null || true
}
trap cleanup EXIT

assert_eq() {
  local d="$1" e="$2" a="$3"
  if [ "$e" = "$a" ]; then pass "$d (=$a)"; else fail "$d — attendu '$e', obtenu '$a'"; fi
}
assert_nonzero_rc() {
  local d="$1" rc="$2"
  if [ "$rc" != "0" ]; then pass "$d (rc=$rc, refusé comme attendu)"; else fail "$d — a RÉUSSI alors qu'il devait être refusé"; fi
}
assert_zero_rc() {
  local d="$1" rc="$2" err="$3"
  if [ "$rc" = "0" ]; then pass "$d"; else fail "$d — rc=$rc : $err"; fi
}

sql() { psql -X -A -q -t -d "$DB" -c "$1"; }
sql_rc() {
  psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-gap01-out-$$.txt 2>/tmp/scanym-gap01-err-$$.txt
  echo $?
}
last_err() { cat /tmp/scanym-gap01-err-$$.txt 2>/dev/null; }
last_out() { cat /tmp/scanym-gap01-out-$$.txt 2>/dev/null; }

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

# Chaîne reprise verbatim de supabase/tests/delivery-country-scope-v1-check.sh
# (harnais le plus récent connu couvrant CGV ENGINE jusqu'à v2-5), à
# laquelle on ajoute la chaîne ONLINE WITHDRAWAL (v1 + v1.1 + gabarit v6).
MINIMAL_CHAIN="schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql"
REST_CHAIN="migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v76-storage-origin-config.sql migration-v71-hardening.sql migration-v72-hardening.sql migration-v73-hardening.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql migration-v82-lot2a-sale-modes.sql migration-v83-lot2a4-privilege-hardening.sql migration-v84-lot2b1-delivery-info-rpc.sql DRAFT-lot-fulfillment-routing-model.sql DRAFT-lot-fulfillment-routing-lot-b-rpc.sql DRAFT-lot-server-delivery-fulfillment-pricing.sql DRAFT-lot-payment-p3b6-checkout-billing-context.sql DRAFT-lot-customer-order-tracking-foundation.sql DRAFT-lot-catalogue-fiscal-product-measurements-v1.sql DRAFT-lot-receipt-invoice-tax-detail-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1.sql DRAFT-lot-catalogue-subcategories-backoffice-v1-1-remediation.sql DRAFT-lot-payment-p1-foundation.sql DRAFT-lot-merchant-delivery-pricing.sql DRAFT-lot-orders-service-role-select-hardening.sql"
CGV_AFTER_N1A_CHAIN="DRAFT-lot-seller-legal-profile-cgv-engine-v1-2.sql DRAFT-lot-seller-legal-profile-cgv-engine-v1-3.sql DRAFT-lot-seller-legal-profile-cgv-engine-v1-4.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-1.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-2.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-4.sql DRAFT-lot-seller-legal-profile-cgv-engine-v2-5.sql"
TRACKING_TAIL="DRAFT-lot-tracking-final-fiscal-summary-v1-1.sql DRAFT-lot-customer-tracking-capability-v3-1.sql DRAFT-lot-customer-contact-live-tracking-v1.sql"
WITHDRAWAL_CHAIN="DRAFT-lot-online-withdrawal-foundation-v1.sql DRAFT-lot-online-withdrawal-v1-1-cgv-mixed-regime.sql DRAFT-lot-online-withdrawal-cgv-template-v6.sql"

for f in $MINIMAL_CHAIN $REST_CHAIN DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql \
         DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql $CGV_AFTER_N1A_CHAIN \
         DRAFT-lot-order-received-enqueue-recovery-v1.sql \
         migration-20260919000000-order-success-boundary-v1.sql $TRACKING_TAIL \
         DRAFT-lot-customer-followup-tracking-email-v1.sql $WITHDRAWAL_CHAIN; do
  [ -f "$SUPABASE_DIR/$f" ] || { echo "FATAL: maillon de chaîne absent : $SUPABASE_DIR/$f"; exit 1; }
done
[ -f "$DRAFT_SQL" ] || { echo "FATAL: $DRAFT_SQL absent"; exit 1; }
[ -f "$ROLLBACK_SQL" ] || { echo "FATAL: $ROLLBACK_SQL absent"; exit 1; }

ERR="/tmp/scanym-gap01-chain-$$.err"
apply_file() { psql -X -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$1" >/dev/null 2>"$ERR"; }
fatal() { echo "FATAL: $*"; exit 1; }

log "=== [0] Baseline + chaîne prédécesseur ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB"
build_common_bootstrap "$DB"

for f in $MINIMAL_CHAIN; do
  apply_file "$f" || fatal "chaîne, $f : $(head -5 "$ERR" | tr '\n' ' ')"
  psql -X -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
done
for f in $REST_CHAIN; do
  apply_file "$f" || fatal "chaîne, $f : $(head -5 "$ERR" | tr '\n' ' ')"
done
apply_file "DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql" || fatal "CGV v1.1 : $(head -5 "$ERR" | tr '\n' ' ')"
apply_file "DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql" || fatal "N1-A : $(head -5 "$ERR" | tr '\n' ' ')"
for f in $CGV_AFTER_N1A_CHAIN; do
  apply_file "$f" || fatal "chaîne CGV, $f : $(head -5 "$ERR" | tr '\n' ' ')"
done
psql -X -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
apply_file "DRAFT-lot-order-received-enqueue-recovery-v1.sql" || fatal "reprise d'enfilement : $(head -5 "$ERR" | tr '\n' ' ')"
apply_file "migration-20260919000000-order-success-boundary-v1.sql" || fatal "ORDER SUCCESS BOUNDARY v1 : $(head -5 "$ERR" | tr '\n' ' ')"

# order_invoice_request : talon d'EXISTENCE (même talon que les harnais
# CFTE / delivery-country-scope-v1). Ce lot n'en lit jamais le contenu.
psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<'SQL' || fatal "talon order_invoice_request"
create table public.order_invoice_request (
  order_id uuid primary key references public.orders(id) on delete cascade
);
alter table public.order_invoice_request enable row level security;
revoke all on table public.order_invoice_request from public, anon, authenticated;
SQL

for f in $TRACKING_TAIL; do
  apply_file "$f" || fatal "chaîne tracking, $f : $(head -5 "$ERR" | tr '\n' ' ')"
done
apply_file "DRAFT-lot-customer-followup-tracking-email-v1.sql" || fatal "customer-followup-tracking-email-v1 : $(head -5 "$ERR" | tr '\n' ' ')"
for f in $WITHDRAWAL_CHAIN; do
  apply_file "$f" || fatal "chaîne ONLINE WITHDRAWAL, $f : $(head -5 "$ERR" | tr '\n' ' ')"
done
pass "Chaîne prédécesseur appliquée jusqu'à ONLINE WITHDRAWAL / cgv_template v6"

log "=== [1] Application de GAP-01 (idempotence : deux applications) ==="
apply_file "DRAFT-lot-gap-01-ack-transport-v1.sql" || fatal "GAP-01 (1ère application) : $(head -20 "$ERR")"
pass "GAP-01 appliqué (1ère fois)"

log "=== [2] Garde fail-closed par défaut ==="
assert_eq "guard renvoie false juste après migration (aucun health-check exécuté)" "f" "$(sql "select public._scanym_has_operational_durable_ack_channel();")"

log "=== [3] La seule présence déclarée 'configured=true' ne débloque rien ==="
sql "update public.scanym_ack_transport_health set configured = true, last_check_at = now() where id = 1;" >/dev/null
assert_eq "configured=true seul (last_check_ok toujours false) -> guard reste false" "f" "$(sql "select public._scanym_has_operational_durable_ack_channel();")"

log "=== [4] Health-check positif fait basculer la garde ==="
sql "update public.scanym_ack_transport_health set last_check_ok = true, last_check_at = now() where id = 1;" >/dev/null
assert_eq "last_check_ok=true -> guard true" "t" "$(sql "select public._scanym_has_operational_durable_ack_channel();")"

log "=== [5] Un health-check négatif reverrouille (pas de rémanence) ==="
sql "update public.scanym_ack_transport_health set last_check_ok = false, last_check_error = 'ECONNREFUSED' where id = 1;" >/dev/null
assert_eq "last_check_ok=false -> guard false à nouveau" "f" "$(sql "select public._scanym_has_operational_durable_ack_channel();")"
sql "update public.scanym_ack_transport_health set last_check_ok = true, last_check_error = null where id = 1;" >/dev/null

log "=== [6] Helper privé toujours inaccessible aux rôles clients ==="
assert_eq "anon ne peut pas exécuter la garde" "f" "$(sql "select has_function_privilege('anon', 'public._scanym_has_operational_durable_ack_channel()', 'EXECUTE');")"
assert_eq "authenticated ne peut pas exécuter la garde" "f" "$(sql "select has_function_privilege('authenticated', 'public._scanym_has_operational_durable_ack_channel()', 'EXECUTE');")"

log "=== [7] RPC service_role interdites à anon/authenticated ==="
assert_eq "anon: claim interdit" "f" "$(sql "select has_function_privilege('anon', 'public.claim_withdrawal_acknowledgement_send(uuid,integer)', 'EXECUTE');")"
assert_eq "authenticated: claim interdit" "f" "$(sql "select has_function_privilege('authenticated', 'public.claim_withdrawal_acknowledgement_send(uuid,integer)', 'EXECUTE');")"
assert_eq "anon: record_result interdit" "f" "$(sql "select has_function_privilege('anon', 'public.record_withdrawal_acknowledgement_result(uuid,boolean,text,text,text,text,text)', 'EXECUTE');")"
assert_eq "service_role: claim autorisé" "t" "$(sql "select has_function_privilege('service_role', 'public.claim_withdrawal_acknowledgement_send(uuid,integer)', 'EXECUTE');")"

log "=== [8] Scénario bout-en-bout : commande + demande de rétractation + claim/send idempotent ==="
WR_ID=""
RESTAURANT_ID=$(sql "insert into public.restaurants (name, slug) values ('Le Gap Un', 'le-gap-un') returning id;")
[ -n "$RESTAURANT_ID" ] || fatal "création restaurant impossible : $(sql "select 1;")"
sql "insert into public.merchant_legal_profile (restaurant_id, customer_service_email) values ('$RESTAURANT_ID', 'contact@le-gap-un.example');" >/dev/null
sql "insert into public.merchant_cgv_profile (restaurant_id, withdrawal_regime) values ('$RESTAURANT_ID', 'STANDARD_14_DAYS');" >/dev/null 2>"$ERR" || log "note: merchant_cgv_profile seed ignorée ($(head -1 "$ERR"))"

CATEGORY_ID=$(sql "insert into public.menu_categories (restaurant_id, name) values ('$RESTAURANT_ID', 'Plats') returning id;" 2>"$ERR")
if [ -z "$CATEGORY_ID" ]; then
  fail "seed catégorie impossible : $(head -3 "$ERR")"
else
  ITEM_ID=$(sql "insert into public.menu_items (category_id, name, price, withdrawal_eligible) values ('$CATEGORY_ID', 'Plateau réutilisable', 12.5, true) returning id;" 2>"$ERR")
  if [ -z "$ITEM_ID" ]; then
    fail "seed produit impossible : $(head -3 "$ERR")"
  else
    ORDER_ID=$(sql "insert into public.orders (restaurant_id, status, service_mode, subtotal, total, currency, order_number) values ('$RESTAURANT_ID', 'new', 'pickup', 25, 25, 'EUR', 1) returning id;" 2>"$ERR")
    if [ -z "$ORDER_ID" ]; then
      fail "seed commande impossible : $(head -3 "$ERR")"
    else
      OI_ID=$(sql "insert into public.order_items (order_id, menu_item_id, item_name, quantity, unit_price, line_total) values ('$ORDER_ID', '$ITEM_ID', 'Plateau réutilisable', 2, 12.5, 25) returning id;" 2>"$ERR")
      if [ -z "$OI_ID" ]; then
        fail "seed ligne de commande impossible : $(head -3 "$ERR")"
      else
        assert_eq "instantané d'éligibilité de la ligne = true" "t" "$(sql "select withdrawal_eligible_at_order_time from public.order_items where id = '$OI_ID';")"

        CAP_ROW=$(psql -X -A -q -t -d "$DB" -c "insert into public.order_tracking_capabilities (order_id, kind, secret_hash, claimed_at, expires_at) values ('$ORDER_ID', 'email', sha256(convert_to('a2b2c2d2e2f2a2b2c2d2e2f2a2b2c2d2e2f2a2b2c2d2e2f2a2b2c2d2e2f2a2b2', 'UTF8')), now(), now() + interval '30 days') returning id;" 2>"$ERR")
        if [ -z "$CAP_ROW" ]; then
          fail "seed capacité de suivi impossible : $(head -3 "$ERR")"
        else
          WR_ID=$(psql -X -A -q -t -d "$DB" -c "select withdrawal_request_id from public.submit_withdrawal_request_by_capability('$ORDER_ID'::uuid, '$CAP_ROW'::uuid, 'a2b2c2d2e2f2a2b2c2d2e2f2a2b2c2d2e2f2a2b2c2d2e2f2a2b2c2d2e2f2a2b2'::text, 'Jean', 'Dupont', 'email', 'jean.dupont@example.com', jsonb_build_array(jsonb_build_object('order_item_id', '$OI_ID', 'quantity', 1)), gen_random_uuid());" 2>"$ERR")
          if [ -z "$WR_ID" ]; then
            fail "submit_withdrawal_request_by_capability a échoué : $(head -5 "$ERR")"
          else
            pass "déclaration de rétractation enregistrée ($WR_ID)"
            assert_eq "statut initial = pending (guard=true à cet instant)" "pending" "$(sql "select acknowledgement_status from public.withdrawal_requests where id = '$WR_ID';")"

            CLAIM_RC=$(sql_rc "select (public.claim_withdrawal_acknowledgement_send('$WR_ID', 120)).id;")
            assert_zero_rc "premier claim réussit" "$CLAIM_RC" "$(last_err)"
            assert_eq "statut après claim = sending" "sending" "$(sql "select acknowledgement_status from public.withdrawal_requests where id = '$WR_ID';")"

            SECOND_CLAIM=$(sql "select (public.claim_withdrawal_acknowledgement_send('$WR_ID', 120)).id;")
            assert_eq "second claim concurrent (fenêtre fraîche) ne renvoie AUCUNE ligne -- idempotence" "" "$SECOND_CLAIM"

            sql "select public.record_withdrawal_acknowledgement_result('$WR_ID', true, 'jean.dupont@example.com', 'contact@le-gap-un.example', '<msgid-1@ssl0.ovh.net>', 'v1', null);" >/dev/null 2>"$ERR"
            assert_eq "statut après envoi réussi = sent" "sent" "$(sql "select acknowledgement_status from public.withdrawal_requests where id = '$WR_ID';")"
            assert_eq "message id persisté" "<msgid-1@ssl0.ovh.net>" "$(sql "select acknowledgement_message_id from public.withdrawal_requests where id = '$WR_ID';")"
            assert_eq "CC persisté = contact marchand" "contact@le-gap-un.example" "$(sql "select acknowledgement_cc from public.withdrawal_requests where id = '$WR_ID';")"

            THIRD_CLAIM=$(sql "select (public.claim_withdrawal_acknowledgement_send('$WR_ID', 120)).id;")
            assert_eq "claim après 'sent' ne renvoie plus rien -- pas de renvoi automatique" "" "$THIRD_CLAIM"

            log "=== [9] Backoffice marchand : lecture RLS ==="
            USER_ID=$(sql "insert into auth.users (email) values ('owner@le-gap-un.example') returning id;")
            sql "insert into public.restaurant_users (restaurant_id, user_id, role) values ('$RESTAURANT_ID', '$USER_ID', 'owner');" >/dev/null 2>"$ERR" || log "note: restaurant_users seed ($(head -1 "$ERR"))"

            OWN_READ=$(psql -X -A -q -t -d "$DB" -c "set role authenticated; set local test.uid = '$USER_ID'; select count(*) from public.withdrawal_requests where id = '$WR_ID';" 2>"$ERR")
            assert_eq "le propriétaire du restaurant voit sa demande de rétractation" "1" "$OWN_READ"

            OTHER_ID=$(sql "insert into auth.users (email) values ('stranger@example.com') returning id;")
            OTHER_READ=$(psql -X -A -q -t -d "$DB" -c "set role authenticated; set local test.uid = '$OTHER_ID'; select count(*) from public.withdrawal_requests where id = '$WR_ID';" 2>"$ERR")
            assert_eq "un utilisateur non membre ne voit RIEN (RLS)" "0" "$OTHER_READ"

            ANON_RC=$(psql -X -A -q -t -d "$DB" -c "set role anon; select count(*) from public.withdrawal_requests;" >/tmp/scanym-gap01-out-$$.txt 2>"$ERR"; echo $?)
            ANON_OUT=$(cat /tmp/scanym-gap01-out-$$.txt)
            if [ "$ANON_RC" != "0" ] || [ "$ANON_OUT" = "0" ]; then
              pass "anon ne peut rien lire dans withdrawal_requests"
            else
              fail "anon a pu lire withdrawal_requests (rc=$ANON_RC, out=$ANON_OUT)"
            fi
          fi
        fi
      fi
    fi
  fi
fi

log "=== [9b] CGV template v7 ==="
apply_file "DRAFT-lot-gap-01-cgv-template-v7.sql"
RCV7=$?
assert_zero_rc "CGV template v7 appliqué sans erreur" "$RCV7" "$(cat "$ERR")"
assert_eq "v7 cite retractation@scanym.com" "t" "$(sql "select (controlled_sections->>'withdrawal_acknowledgement_clause') like '%retractation@scanym.com%' from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=7;")"
assert_eq "v7 distingue accusé et instructions de retour" "t" "$(sql "select (controlled_sections->>'withdrawal_acknowledgement_clause') like '%ne constitue pas les modalités pratiques de retour%' from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=7;")"
assert_eq "v7 est désormais is_default" "t" "$(sql "select is_default from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=7;")"
assert_eq "v6 n'est plus is_default mais reste PUBLISHED" "PUBLISHED" "$(sql "select status from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=6 and is_default=false;")"
assert_eq "withdrawal_clauses inchangées entre v6 et v7" "t" "$(sql "select (select controlled_sections->'withdrawal_clauses' from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=6) = (select controlled_sections->'withdrawal_clauses' from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=7);")"
apply_file "DRAFT-lot-gap-01-cgv-template-v7.sql"
RCV7B=$?
assert_nonzero_rc "ré-application de v7 refusée (SCANYM_ALREADY_APPLIED, pas d'écrasement silencieux)" "$RCV7B"

log "=== [10] Idempotence de la migration (seconde application) ==="
apply_file "DRAFT-lot-gap-01-ack-transport-v1.sql"
RC2=$?
assert_zero_rc "GAP-01 ré-appliqué sans erreur (colonnes/contraintes déjà présentes)" "$RC2" "$(cat "$ERR")"

log "=== [11] Rollback ==="
apply_file "DRAFT-lot-gap-01-ack-transport-v1-ROLLBACK.sql"
RC3=$?
assert_zero_rc "ROLLBACK appliqué sans erreur" "$RC3" "$(cat "$ERR")"
assert_eq "après rollback : scanym_ack_transport_health n'existe plus" "" "$(sql "select to_regclass('public.scanym_ack_transport_health')::text;")"
assert_eq "après rollback : la garde est de nouveau false en dur" "f" "$(sql "select public._scanym_has_operational_durable_ack_channel();")"
assert_eq "après rollback : la déclaration de rétractation N'A PAS été supprimée" "1" "$(sql "select count(*) from public.withdrawal_requests where id = '$WR_ID';" 2>/dev/null || echo 0)"

echo
echo "============================================================"
echo "GAP-01 ack-transport-v1 — RÉSULTAT : $PASS_COUNT PASS / $FAIL_COUNT FAIL"
echo "============================================================"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "Échecs :"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
