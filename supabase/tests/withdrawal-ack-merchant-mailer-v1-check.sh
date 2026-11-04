#!/usr/bin/env bash
# ============================================================
# Scanym — ACCUSÉ DE RÉTRACTATION PAR LA MESSAGERIE DU COMMERÇANT v1 — harnais SQL RÉEL
# (PostgreSQL réel, base jetable, aucune simulation).
#
# Même idiome que supabase/tests/delivery-country-scope-v1-check.sh
# (bootstrap, chaîne minimale, émulation des rôles et de auth.uid()).
# Chaîne reprise jusqu'à ONLINE WITHDRAWAL v1/v1.1 + cgv_template v6,
# puis ce lot (GAP-01) est appliqué et vérifié, puis son ROLLBACK.
#
# Usage depuis la racine du dépôt :
#   su postgres -c "bash supabase/tests/withdrawal-ack-merchant-mailer-v1-check.sh"
# ============================================================
set -uo pipefail

SUPABASE_DIR="${SUPABASE_DIR:-supabase}"
DRAFT_SQL="$SUPABASE_DIR/DRAFT-lot-withdrawal-ack-merchant-mailer-v1.sql"
ROLLBACK_SQL="$SUPABASE_DIR/DRAFT-lot-withdrawal-ack-merchant-mailer-v1-ROLLBACK.sql"
# GAP-01 remédiation round 1 (issue #11, exécution CIO/RAVEL) — e-mail
# marchand obligatoire pour STANDARD_14_DAYS/MIXED.
MANDATORY_EMAIL_SQL="$SUPABASE_DIR/DRAFT-lot-gap-01-mandatory-merchant-email-v1.sql"
MANDATORY_EMAIL_ROLLBACK_SQL="$SUPABASE_DIR/DRAFT-lot-gap-01-mandatory-merchant-email-v1-ROLLBACK.sql"
DB="scanym_ackmm_$$"

PASS_COUNT=0
FAIL_COUNT=0
FAIL_LOG="/tmp/scanym-ackmm-fails-$$.log"
: > "$FAIL_LOG"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); printf '%s\n' "$*" >> "$FAIL_LOG"; log "FAIL: $*"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  rm -f "${FAIL_LOG:-}" /tmp/scanym-ackmm-out-$$.txt /tmp/scanym-ackmm-err-$$.txt 2>/dev/null || true
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
  psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-ackmm-out-$$.txt 2>/tmp/scanym-ackmm-err-$$.txt
  echo $?
}
last_err() { cat /tmp/scanym-ackmm-err-$$.txt 2>/dev/null; }
last_out() { cat /tmp/scanym-ackmm-out-$$.txt 2>/dev/null; }

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
[ -f "$MANDATORY_EMAIL_SQL" ] || { echo "FATAL: $MANDATORY_EMAIL_SQL absent"; exit 1; }
[ -f "$MANDATORY_EMAIL_ROLLBACK_SQL" ] || { echo "FATAL: $MANDATORY_EMAIL_ROLLBACK_SQL absent"; exit 1; }

ERR="/tmp/scanym-ackmm-chain-$$.err"
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

log "=== [1] Prérequis : GAP-01 (transport + e-mail marchand obligatoire) puis SMTP marchand ==="
apply_file "DRAFT-lot-gap-01-ack-transport-v1.sql" || fatal "GAP-01 : $(head -20 "$ERR")"
apply_file "DRAFT-lot-gap-01-mandatory-merchant-email-v1.sql" || fatal "GAP-01 e-mail marchand obligatoire : $(head -20 "$ERR")"
pass "GAP-01 appliqué"

# Pré-vol négatif : sans le coffre SMTP marchand, le lot REFUSE et ne modifie rien.
assert_eq "avant SMTP marchand : le coffre n'existe pas" "" "$(sql "select to_regclass('public.merchant_email_provider_config');")"
psql -X -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/dev/null 2>"$ERR"; RC=$?
assert_nonzero_rc "lot refusé sans coffre SMTP marchand (SCANYM_PREDECESSOR_MISSING)" "$RC"
grep -q "SCANYM_PREDECESSOR_MISSING" "$ERR" && pass "message de refus = SCANYM_PREDECESSOR_MISSING" || fail "message de refus inattendu : $(head -3 "$ERR")"
assert_eq "refus atomique : aucune table de l'interrupteur créée" "" "$(sql "select to_regclass('public.scanym_ack_merchant_mailer_activation');")"

# SMTP marchand : lots réels si la chaîne le permet.
SMTP_REAL=0
if [ -f "$SUPABASE_DIR/DRAFT-lot-order-received-payment-gate-v1.sql" ] && [ -f "$SUPABASE_DIR/DRAFT-lot-merchant-smtp-notifications-v1.sql" ]; then
  if apply_file "DRAFT-lot-order-received-payment-gate-v1.sql" && apply_file "DRAFT-lot-merchant-smtp-notifications-v1.sql"; then SMTP_REAL=1; fi
fi
if [ "$SMTP_REAL" = "1" ]; then
  pass "lots RÉELS appliqués : porte de paiement #180 + SMTP marchand v1"
else
  log "note: chaîne SMTP marchand non applicable ici ($(head -2 "$ERR" | tr '\n' ' ')) -- repli sur des tables équivalentes (colonnes identiques à celles que le lot lit)"
  psql -X -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$ERR" <<'SQL' || fatal "talon coffre : $(head -3 "$ERR")"
create table if not exists public.merchant_email_provider_config (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  host text not null, port integer not null, username text not null, enabled boolean not null default false,
  secret_ciphertext text, secret_iv text, secret_auth_tag text, last_error_class text, last_error_at timestamptz
);
SQL
fi
assert_eq "coffre SMTP marchand présent" "t" "$(sql "select to_regclass('public.merchant_email_provider_config') is not null;")"
assert_eq "profil de notification présent" "t" "$(sql "select to_regclass('public.merchant_notification_profile') is not null;")"

log "=== [2] Deux commerçants isolés : A (messagerie prête), B (profil sans coffre) ==="
RA=$(sql "insert into public.restaurants (name, slug) values ('Commerce A', 'commerce-a') returning id;")
RB=$(sql "insert into public.restaurants (name, slug) values ('Commerce B', 'commerce-b') returning id;")
[ -n "$RA" ] && [ -n "$RB" ] || fatal "création des restaurants impossible"
sql "insert into public.merchant_legal_profile (restaurant_id, customer_service_email, customer_service_phone) values ('$RA', 'contact@commerce-a.example', '+33100000001'), ('$RB', 'contact@commerce-b.example', '+33100000002');" >/dev/null 2>"$ERR" || fatal "profils légaux : $(head -3 "$ERR")"
sql "insert into public.merchant_cgv_profile (restaurant_id, withdrawal_regime) values ('$RA', 'STANDARD_14_DAYS'), ('$RB', 'EXEMPT_PERISHABLE');" >/dev/null 2>"$ERR" || log "note: merchant_cgv_profile seed ($(head -1 "$ERR"))"
sql "insert into public.merchant_notification_profile (restaurant_id, email_enabled, sender_name, sender_email, reply_to) values ('$RA', true, 'Commerce A', 'boutique@commerce-a.example', 'reponse@commerce-a.example'), ('$RB', true, 'Commerce B', 'boutique@commerce-b.example', null);" >/dev/null 2>"$ERR" || fatal "profils de notification : $(head -3 "$ERR")"
sql "insert into public.merchant_email_provider_config (restaurant_id, host, port, username, enabled, secret_ciphertext, secret_iv, secret_auth_tag) values ('$RA', 'smtp.commerce-a.example', 465, 'boutique@commerce-a.example', true, 'c', 'i', 't');" >/dev/null 2>"$ERR" || fatal "coffre A : $(head -3 "$ERR")"

# make_request <restaurant_id> <numéro> <adresse client> -> id de la demande
make_request() {
  local rid="$1" num="$2" addr="$3" cat item ord oi cap
  cat=$(sql "insert into public.menu_categories (restaurant_id, name) values ('$rid', 'Plats-$num') returning id;" 2>"$ERR") || return 1
  item=$(sql "insert into public.menu_items (category_id, name, price, withdrawal_eligible) values ('$cat', 'Plateau-$num', 12.5, true) returning id;" 2>"$ERR") || return 1
  ord=$(sql "insert into public.orders (restaurant_id, status, service_mode, subtotal, total, currency, order_number) values ('$rid', 'new', 'pickup', 25, 25, 'EUR', $num) returning id;" 2>"$ERR") || return 1
  oi=$(sql "insert into public.order_items (order_id, menu_item_id, item_name, quantity, unit_price, line_total) values ('$ord', '$item', 'Plateau', 2, 12.5, 25) returning id;" 2>"$ERR") || return 1
  cap=$(psql -X -A -q -t -d "$DB" -c "insert into public.order_tracking_capabilities (order_id, kind, secret_hash, claimed_at, expires_at) values ('$ord', 'email', sha256(convert_to('a2b2c2d2e2f2a2b2c2d2e2f2a2b2c2d2e2f2a2b2c2d2e2f2a2b2c2d2e2f2a2b2', 'UTF8')), now(), now() + interval '30 days') returning id;" 2>"$ERR") || return 1
  psql -X -A -q -t -d "$DB" -c "select ${RET:-withdrawal_request_id} from public.submit_withdrawal_request_by_capability('$ord'::uuid, '$cap'::uuid, 'a2b2c2d2e2f2a2b2c2d2e2f2a2b2c2d2e2f2a2b2c2d2e2f2a2b2c2d2e2f2a2b2'::text, 'Jean', 'Dupont', 'email', '$addr', jsonb_build_array(jsonb_build_object('order_item_id', '$oi', 'quantity', 1)), gen_random_uuid());" 2>"$ERR"
}
status_of() { sql "select acknowledgement_status from public.withdrawal_requests where id = '$1';"; }

log "=== [3] AVANT le lot : la plateforme est indisponible -> unavailable_no_channel (état réel du terrain) ==="
assert_eq "garde de publication CGV = false (canal plateforme non vérifié)" "f" "$(sql "select public._scanym_has_operational_durable_ack_channel();")"
OLD_A=$(make_request "$RA" 1 "ancien.client.a@example.com") || fatal "demande historique A : $(head -3 "$ERR")"
OLD_B=$(make_request "$RB" 2 "ancien.client.b@example.com") || fatal "demande historique B : $(head -3 "$ERR")"
assert_eq "demande historique A = unavailable_no_channel" "unavailable_no_channel" "$(status_of "$OLD_A")"
assert_eq "demande historique B = unavailable_no_channel" "unavailable_no_channel" "$(status_of "$OLD_B")"

log "=== [4] Application du lot (+ idempotence : double application refusée) ==="
apply_file "DRAFT-lot-withdrawal-ack-merchant-mailer-v1.sql" || fatal "lot (1ère application) : $(head -20 "$ERR")"
pass "lot appliqué"
psql -X -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/dev/null 2>"$ERR"; RC=$?
assert_nonzero_rc "2e application refusée" "$RC"
grep -q "double application" "$ERR" && pass "refus = double application" || fail "refus inattendu : $(head -3 "$ERR")"
assert_eq "interrupteur FERMÉ après le lot" "f" "$(sql "select enabled from public.scanym_ack_merchant_mailer_activation where id = 1;")"
assert_eq "scanym_ack_merchant_mailer_enabled() = false" "f" "$(sql "select public.scanym_ack_merchant_mailer_enabled();")"
assert_eq "garde de publication CGV INCHANGÉE (false)" "f" "$(sql "select public._scanym_has_operational_durable_ack_channel();")"
assert_eq "demandes historiques INCHANGÉES (A)" "unavailable_no_channel" "$(status_of "$OLD_A")"
assert_eq "demandes historiques INCHANGÉES (B)" "unavailable_no_channel" "$(status_of "$OLD_B")"

log "=== [5] Interrupteur FERMÉ : comportement d'avant (contrôle négatif) ==="
CLOSED_A=$(make_request "$RA" 3 "client.a1@example.com") || fatal "demande A (fermé) : $(head -3 "$ERR")"
assert_eq "interrupteur fermé : A reste unavailable_no_channel malgré une messagerie prête" "unavailable_no_channel" "$(status_of "$CLOSED_A")"
assert_eq "interrupteur fermé : claim v2 ne revendique rien" "" "$(sql "select id from public.claim_withdrawal_acknowledgement_send_v2('$CLOSED_A', 120);")"
assert_eq "interrupteur fermé : statut toujours unavailable_no_channel" "unavailable_no_channel" "$(status_of "$CLOSED_A")"

log "=== [6] Interrupteur OUVERT (par l'opérateur, dans ce test seulement) ==="
sql "update public.scanym_ack_merchant_mailer_activation set enabled = true where id = 1;" >/dev/null
assert_eq "interrupteur ouvert" "t" "$(sql "select public.scanym_ack_merchant_mailer_enabled();")"
assert_eq "garde de publication CGV TOUJOURS false (le lot ne la touche pas)" "f" "$(sql "select public._scanym_has_operational_durable_ack_channel();")"
NEW_A=$(make_request "$RA" 4 "client.a2@example.com") || fatal "demande A : $(head -3 "$ERR")"
NEW_B=$(make_request "$RB" 5 "client.b1@example.com") || fatal "demande B : $(head -3 "$ERR")"
assert_eq "A (messagerie prête) -> pending" "pending" "$(status_of "$NEW_A")"
RECEIPT_A=$(RET=acknowledgement_status make_request "$RA" 40 "client.a-recu@example.com") || fatal "reçu A : $(head -3 "$ERR")"
assert_eq "le REÇU renvoyé par submit (vu par le client) dit pending, comme la base" "pending" "$RECEIPT_A"
RECEIPT_B=$(RET=acknowledgement_status make_request "$RB" 41 "client.b-recu@example.com") || fatal "reçu B : $(head -3 "$ERR")"
assert_eq "le REÇU de B dit unavailable_no_channel" "unavailable_no_channel" "$RECEIPT_B"
assert_eq "B (profil sans coffre) -> unavailable_no_channel (statut honnête)" "unavailable_no_channel" "$(status_of "$NEW_B")"
assert_eq "demande historique A NON modifiée (aucun backfill)" "unavailable_no_channel" "$(status_of "$OLD_A")"
assert_eq "demande fermée A NON modifiée" "unavailable_no_channel" "$(status_of "$CLOSED_A")"

log "=== [7] Revendication v2 : isolation entre commerçants, aucun renvoi automatique ==="
assert_eq "B : claim v2 ne revendique rien (unavailable_no_channel)" "" "$(sql "select id from public.claim_withdrawal_acknowledgement_send_v2('$NEW_B', 120);")"
assert_eq "historique A : claim v2 ne revendique rien (pas de renvoi automatique)" "" "$(sql "select id from public.claim_withdrawal_acknowledgement_send_v2('$OLD_A', 120);")"
assert_eq "historique B : claim v2 ne revendique rien" "" "$(sql "select id from public.claim_withdrawal_acknowledgement_send_v2('$OLD_B', 120);")"
CLAIM=$(sql "select restaurant_id || '|' || sender_email || '|' || coalesce(reply_to,'') || '|' || merchant_contact_email || '|' || profile_email_enabled || '|' || merchant_withdrawal_regime from public.claim_withdrawal_acknowledgement_send_v2('$NEW_A', 120);")
assert_eq "claim A : identité de A UNIQUEMENT (restaurant, expéditeur, reply-to, copie, régime)" "$RA|boutique@commerce-a.example|reponse@commerce-a.example|contact@commerce-a.example|true|STANDARD_14_DAYS" "$CLAIM"
case "$CLAIM" in *commerce-b*) fail "le claim de A contient une donnée de B : $CLAIM";; *) pass "aucune donnée de B dans le claim de A";; esac
assert_eq "statut après claim = sending" "sending" "$(status_of "$NEW_A")"
assert_eq "canal posé à la revendication = merchant_smtp" "merchant_smtp" "$(sql "select acknowledgement_transport from public.withdrawal_requests where id = '$NEW_A';")"
assert_eq "second claim immédiat (fenêtre fraîche) = rien -- pas de doublon" "" "$(sql "select id from public.claim_withdrawal_acknowledgement_send_v2('$NEW_A', 120);")"

log "=== [8] Enregistrement v2 : statut fidèle ==="
assert_eq "record v2 avec un canal invalide -> false, rien modifié" "f" "$(sql "select public.record_withdrawal_acknowledgement_result_v2('$NEW_A', true, 'client.a2@example.com', 'contact@commerce-a.example', '<m@x>', 'gap-01-ack-v1', null, 'boutique@commerce-a.example', 'telepathie');")"
assert_eq "toujours sending après un enregistrement refusé" "sending" "$(status_of "$NEW_A")"
assert_eq "record v2 succès -> true" "t" "$(sql "select public.record_withdrawal_acknowledgement_result_v2('$NEW_A', true, 'client.a2@example.com', 'contact@commerce-a.example', '<m@x>', 'gap-01-ack-v1', null, 'boutique@commerce-a.example', 'merchant_smtp');")"
assert_eq "statut = sent" "sent" "$(status_of "$NEW_A")"
assert_eq "copie enregistrée après succès" "contact@commerce-a.example" "$(sql "select acknowledgement_cc from public.withdrawal_requests where id = '$NEW_A';")"
assert_eq "expéditeur réel enregistré (preuve)" "boutique@commerce-a.example" "$(sql "select acknowledgement_sender from public.withdrawal_requests where id = '$NEW_A';")"
assert_eq "enregistrement tardif/doublon sur une ligne déjà sent -> false" "f" "$(sql "select public.record_withdrawal_acknowledgement_result_v2('$NEW_A', false, 'client.a2@example.com', null, null, 'gap-01-ack-v1', 'PROVIDER_TIMEOUT', 'boutique@commerce-a.example', 'merchant_smtp');")"
assert_eq "un résultat tardif n'a pas dégradé sent" "sent" "$(status_of "$NEW_A")"
assert_eq "claim après sent = rien -- pas de renvoi automatique" "" "$(sql "select id from public.claim_withdrawal_acknowledgement_send_v2('$NEW_A', 120);")"

FAIL_A=$(make_request "$RA" 6 "client.a3@example.com") || fatal "demande A (échec) : $(head -3 "$ERR")"
sql "select id from public.claim_withdrawal_acknowledgement_send_v2('$FAIL_A', 120);" >/dev/null
assert_eq "record v2 échec avec texte serveur brut -> true" "t" "$(sql "select public.record_withdrawal_acknowledgement_result_v2('$FAIL_A', false, 'client.a3@example.com', 'contact@commerce-a.example', null, 'gap-01-ack-v1', '535 5.7.8 password=hunter2 rejected', 'boutique@commerce-a.example', 'merchant_smtp');")"
assert_eq "statut = failed" "failed" "$(status_of "$FAIL_A")"
assert_eq "texte serveur NON conservé : classe fermée UNKNOWN_PROVIDER_ERROR" "UNKNOWN_PROVIDER_ERROR" "$(sql "select acknowledgement_last_error from public.withdrawal_requests where id = '$FAIL_A';")"
assert_eq "échec : aucune copie enregistrée (le back-office ne dira pas « copie envoyée »)" "" "$(sql "select coalesce(acknowledgement_cc, '') from public.withdrawal_requests where id = '$FAIL_A';")"
assert_eq "échec : pas de message id" "" "$(sql "select coalesce(acknowledgement_message_id, '') from public.withdrawal_requests where id = '$FAIL_A';")"
assert_eq "failed n'est jamais revendiqué automatiquement" "" "$(sql "select id from public.claim_withdrawal_acknowledgement_send_v2('$FAIL_A', 120);")"
assert_eq "la demande reste enregistrée (ligne présente) malgré l'échec" "1" "$(sql "select count(*) from public.withdrawal_requests where id = '$FAIL_A';")"

FAIL_B=$(make_request "$RA" 7 "client.a4@example.com") || fatal "demande A (code propre) : $(head -3 "$ERR")"
sql "select id from public.claim_withdrawal_acknowledgement_send_v2('$FAIL_B', 120);" >/dev/null
sql "select public.record_withdrawal_acknowledgement_result_v2('$FAIL_B', false, 'client.a4@example.com', null, null, 'gap-01-ack-v1', 'PROVIDER_AUTHENTICATION_FAILED', 'boutique@commerce-a.example', 'merchant_smtp');" >/dev/null
assert_eq "classe normalisée conservée telle quelle" "PROVIDER_AUTHENTICATION_FAILED" "$(sql "select acknowledgement_last_error from public.withdrawal_requests where id = '$FAIL_B';")"

log "=== [9] Reprise d'une revendication périmée (crash) -- seule voie de reprise ==="
STALE=$(make_request "$RA" 8 "client.a5@example.com") || fatal "demande A (périmée) : $(head -3 "$ERR")"
sql "select id from public.claim_withdrawal_acknowledgement_send_v2('$STALE', 120);" >/dev/null
sql "update public.withdrawal_requests set acknowledgement_claimed_at = now() - interval '10 minutes' where id = '$STALE';" >/dev/null
assert_eq "sending périmé -> revendicable à nouveau" "$STALE" "$(sql "select id from public.claim_withdrawal_acknowledgement_send_v2('$STALE', 120);")"
assert_eq "compteur de tentatives = 2" "2" "$(sql "select acknowledgement_send_attempts from public.withdrawal_requests where id = '$STALE';")"

log "=== [10] Privilèges ==="
for fn in "claim_withdrawal_acknowledgement_send_v2(uuid,integer)" "record_withdrawal_acknowledgement_result_v2(uuid,boolean,text,text,text,text,text,text,text)" "scanym_ack_merchant_mailer_enabled()"; do
  assert_eq "anon ne peut pas exécuter $fn" "f" "$(sql "select has_function_privilege('anon', 'public.$fn', 'EXECUTE');")"
  assert_eq "authenticated ne peut pas exécuter $fn" "f" "$(sql "select has_function_privilege('authenticated', 'public.$fn', 'EXECUTE');")"
  assert_eq "service_role peut exécuter $fn" "t" "$(sql "select has_function_privilege('service_role', 'public.$fn', 'EXECUTE');")"
done
for fn in "_scanym_merchant_ack_channel_ready(uuid)" "_scanym_ack_pending_when_merchant_mailer_ready()"; do
  assert_eq "anon/authenticated/service_role ne peuvent pas exécuter $fn" "false|false|false" "$(sql "select has_function_privilege('anon','public.$fn','EXECUTE') || '|' || has_function_privilege('authenticated','public.$fn','EXECUTE') || '|' || has_function_privilege('service_role','public.$fn','EXECUTE');")"
done
assert_eq "service_role n'a AUCUN accès direct à la table de l'interrupteur" "f" "$(sql "select has_table_privilege('service_role', 'public.scanym_ack_merchant_mailer_activation', 'SELECT');")"
assert_eq "authenticated n'a AUCUN accès à la table de l'interrupteur" "f" "$(sql "select has_table_privilege('authenticated', 'public.scanym_ack_merchant_mailer_activation', 'SELECT');")"

log "=== [11] Canal plateforme sain : le déclencheur n'intervient pas (contrôle négatif) ==="
sql "update public.scanym_ack_transport_health set last_check_ok = true where id = 1;" >/dev/null
PLAT=$(make_request "$RB" 9 "client.b2@example.com") || fatal "demande B (plateforme saine) : $(head -3 "$ERR")"
assert_eq "plateforme saine : pending (statut posé par submit, inchangé par le déclencheur)" "pending" "$(status_of "$PLAT")"
sql "update public.scanym_ack_transport_health set last_check_ok = false where id = 1;" >/dev/null

log "=== [12] ROLLBACK : garde-fous puis retrait ==="
psql -X -d "$DB" -v ON_ERROR_STOP=1 -f "$ROLLBACK_SQL" >/dev/null 2>"$ERR"; RC=$?
assert_nonzero_rc "rollback refusé tant que l'interrupteur est OUVERT" "$RC"
grep -q "SCANYM_ROLLBACK_REFUSED" "$ERR" && pass "refus = SCANYM_ROLLBACK_REFUSED" || fail "refus inattendu : $(head -3 "$ERR")"
sql "update public.scanym_ack_merchant_mailer_activation set enabled = false where id = 1;" >/dev/null
psql -X -d "$DB" -v ON_ERROR_STOP=1 -f "$ROLLBACK_SQL" >/dev/null 2>"$ERR"; RC=$?
assert_nonzero_rc "rollback refusé tant que des preuves d'envoi existent" "$RC"
grep -q "SCANYM_ROLLBACK_DATA_LOSS" "$ERR" && pass "refus = SCANYM_ROLLBACK_DATA_LOSS" || fail "refus inattendu : $(head -3 "$ERR")"
BEFORE_COUNT=$(sql "select count(*) from public.withdrawal_requests;")
sql "update public.withdrawal_requests set acknowledgement_sender = null, acknowledgement_transport = null;" >/dev/null
apply_file "DRAFT-lot-withdrawal-ack-merchant-mailer-v1-ROLLBACK.sql" || fail "rollback : $(head -10 "$ERR")"
assert_eq "rollback : table de l'interrupteur supprimée" "" "$(sql "select to_regclass('public.scanym_ack_merchant_mailer_activation');")"
assert_eq "rollback : claim v2 supprimée" "" "$(sql "select to_regprocedure('public.claim_withdrawal_acknowledgement_send_v2(uuid,integer)');")"
assert_eq "rollback : déclencheur supprimé" "0" "$(sql "select count(*) from pg_trigger where tgname = 'trg_withdrawal_ack_pending_merchant_mailer';")"
assert_eq "rollback : colonnes de preuve supprimées" "0" "$(sql "select count(*) from information_schema.columns where table_name = 'withdrawal_requests' and column_name in ('acknowledgement_sender','acknowledgement_transport');")"
assert_eq "rollback : aucune demande supprimée" "$BEFORE_COUNT" "$(sql "select count(*) from public.withdrawal_requests;")"
assert_eq "rollback : GAP-01 intact (claim v1 présente)" "t" "$(sql "select to_regprocedure('public.claim_withdrawal_acknowledgement_send(uuid,integer)') is not null;")"
assert_eq "rollback : garde CGV inchangée" "f" "$(sql "select public._scanym_has_operational_durable_ack_channel();")"
apply_file "DRAFT-lot-withdrawal-ack-merchant-mailer-v1.sql" && pass "ré-application après rollback" || fail "ré-application : $(head -10 "$ERR")"

echo
log "=== BILAN : $PASS_COUNT PASS, $FAIL_COUNT FAIL ==="
if [ "$FAIL_COUNT" -gt 0 ]; then cat "$FAIL_LOG"; exit 1; fi
exit 0
