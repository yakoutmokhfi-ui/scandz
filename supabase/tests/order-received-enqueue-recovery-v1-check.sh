#!/usr/bin/env bash
# ============================================================
# Scanym — P0 — ORDER-RECEIVED ENQUEUE REGRESSION RECOVERY v1
# Harnais SQL RÉEL (PostgreSQL réel, aucune simulation).
#
# Baseline gelée : main d38b0fa1d57363419ee7ad8b23ea7fe4d6e7788c
#                  tree 0d6c5676d63256e688ee10f95eeca842da40bc48
#
# Prouve, sur la MÊME chaîne de migrations réelle :
#   [RED]   baseline   -> commande créée, 0 ligne outbox (régression)
#   [GREEN] candidat   -> commande créée, EXACTEMENT 1 ligne outbox
#   idempotence, rollback de transaction, survie du déclencheur à une
#   redéfinition ultérieure de create_order, create_order inchangée,
#   et rollback du lot.
#
# Aucun e-mail, aucun appel fournisseur : le déclencheur n'insère
# qu'une ligne outbox.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/order-received-enqueue-recovery-v1-check.sh"
# ============================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$SUPABASE_DIR/.." && pwd)"
LOT_SQL_V11="$SUPABASE_DIR/DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql"
LOT_SQL_V12="$SUPABASE_DIR/DRAFT-lot-seller-legal-profile-cgv-engine-v1-2.sql"
LOT_SQL_V13="$SUPABASE_DIR/DRAFT-lot-seller-legal-profile-cgv-engine-v1-3.sql"
LOT_SQL_V14="$SUPABASE_DIR/DRAFT-lot-seller-legal-profile-cgv-engine-v1-4.sql"
LOT_SQL_V21="$SUPABASE_DIR/DRAFT-lot-seller-legal-profile-cgv-engine-v2-1.sql"
LOT_SQL_V22="$SUPABASE_DIR/DRAFT-lot-seller-legal-profile-cgv-engine-v2-2.sql"
LOT_SQL_V24="$SUPABASE_DIR/DRAFT-lot-seller-legal-profile-cgv-engine-v2-4.sql"
LOT_SQL_V25="$SUPABASE_DIR/DRAFT-lot-seller-legal-profile-cgv-engine-v2-5.sql"
LOT_SQL="$LOT_SQL_V25"
ROLLBACK_SQL="$SUPABASE_DIR/DRAFT-lot-seller-legal-profile-cgv-engine-v1-2-rollback.sql"
ROLLBACK_SQL_V21="$SUPABASE_DIR/DRAFT-lot-seller-legal-profile-cgv-engine-v2-1-rollback.sql"
ROLLBACK_SQL_V22="$SUPABASE_DIR/DRAFT-lot-seller-legal-profile-cgv-engine-v2-2-rollback.sql"
# v2.4 -- deliberately NO ROLLBACK_SQL_V24 addendum: unlike v2.2's own
# _resolve_applicable_cgv_template(uuid) change (a genuinely NEW
# signature, unknown to the v1.2 rollback's DROP FUNCTION statement),
# v2.4's resolve_cgv_publication_context change keeps the EXACT SAME
# INPUT signature (p_restaurant_id uuid) as v2.2's version -- only its
# RETURN columns differ, and DROP FUNCTION resolves by input argument
# types only, never by return type. The EXISTING v1.2 rollback's
# `drop function if exists public.resolve_cgv_publication_context
# (uuid);` statement therefore drops v2.4's version just as cleanly as
# v2.2's -- verified empirically below, in [ROLLBACK], no new gap.
RENDER_HELPER="$SCRIPT_DIR/seller-legal-profile-cgv-engine-v2-6-render-helper.mjs"
# Écrit sous /tmp (jamais sous le dépôt lui-même) : l'utilisateur
# système postgres qui exécute ce harnais (sudo -n -u postgres) n'a pas
# nécessairement de droit d'écriture dans l'arborescence du dépôt (elle
# peut appartenir à un autre utilisateur/repo-owner) -- exactement le
# même choix déjà fait pour tous les autres fichiers temporaires de ce
# harnais (/tmp/scanym-cgvenginev11-*, /tmp/lock-holder-*). Un nom fixe
# (sans suffixe $$) est utilisé délibérément ICI, contrairement à ces
# fichiers scratch : cet aperçu EST un livrable (mandat, item 6/9), pas
# une donnée intermédiaire jetable -- il doit être retrouvable après la
# fin du run pour être copié dans le paquet final.
AU_LAIT_CRU_PREVIEW_FILE="/tmp/au-lait-cru-cgv-preview.html"
DB="scanym_cgvenginev26_$$"

PASS=0
FAIL=0
FAIL_LOG="/tmp/scanym-cgvenginev11-fails-$$.log"
: > "$FAIL_LOG"

log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS=$((PASS+1)); log "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); printf '%s\n' "$1" >> "$FAIL_LOG"; log "FAIL: $1"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop role if exists cgv_probe_public;" >/dev/null 2>&1 || true
  rm -f "$FAIL_LOG" /tmp/scanym-cgvenginev11-*-$$.txt /tmp/scanym-cgvenginev11-*-$$.json 2>/dev/null || true
}
trap cleanup EXIT

sql() { psql -X -A -q -t -d "$DB" -c "$1" 2>/tmp/scanym-cgvenginev11-err-$$.txt; }
sql_rc() { psql -X -A -q -t -d "$DB" -c "$1" >/tmp/scanym-cgvenginev11-out-$$.txt 2>/tmp/scanym-cgvenginev11-err-$$.txt; echo $?; }
sql_err() { cat /tmp/scanym-cgvenginev11-err-$$.txt 2>/dev/null; }
sql_out() { cat /tmp/scanym-cgvenginev11-out-$$.txt 2>/dev/null; }

as_authenticated_rc() {
  PGOPTIONS="-c role=authenticated" psql -X -A -q -t -d "$DB" \
    -c "do \$do\$ begin perform set_config('test.uid','$1', false); end \$do\$;" \
    -c "$2" \
    >/tmp/scanym-cgvenginev11-out-$$.txt 2>/tmp/scanym-cgvenginev11-err-$$.txt
  echo $?
}
as_anon_rc() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" \
    -c "$1" \
    >/tmp/scanym-cgvenginev11-out-$$.txt 2>/tmp/scanym-cgvenginev11-err-$$.txt
  echo $?
}
# NOUVEAU v1.1 (Blocker 1) — service_role est désormais le SEUL rôle
# EXECUTE sur persist_merchant_cgv_version ; ce helper (même patron
# PGOPTIONS que as_authenticated_rc/as_anon_rc ci-dessus) permet de
# prouver le chemin de confiance légitime ET, séparément, d'utiliser le
# même privilège pour la preuve de contournement (Direct RPC Bypass
# teste précisément qu'AUCUN AUTRE rôle ne peut faire ceci).
as_service_role_rc() {
  PGOPTIONS="-c role=service_role" psql -X -A -q -t -d "$DB" \
    -c "$1" \
    >/tmp/scanym-cgvenginev11-out-$$.txt 2>/tmp/scanym-cgvenginev11-err-$$.txt
  echo $?
}

# NOUVEAU v1.2 (Blocker 1, CGV-V11-PUBLISH-CONTEXT-RACE-01) — resout
# template_id + context_fingerprint + acting_user_id EN UN SEUL appel
# as-user à resolve_cgv_publication_context (les 3 valeurs concaténées
# par '|', aucun des 3 ne contenant jamais ce caractère). $1 = uid de
# l'appelant, $2 = restaurant_id. Après un appel réussi (rc=0), lire
# les 3 valeurs via resolve_split (qui parse sql_out()).
resolve_for_persist_rc() {
  as_authenticated_rc "$1" \
    "select template_id || '|' || context_fingerprint || '|' || acting_user_id from public.resolve_cgv_publication_context('$2');"
}
RESOLVED_TID=""
RESOLVED_FP=""
RESOLVED_UID=""
resolve_split() {
  local raw
  raw="$(sql_out)"
  RESOLVED_TID="${raw%%|*}"
  raw="${raw#*|}"
  RESOLVED_FP="${raw%%|*}"
  RESOLVED_UID="${raw#*|}"
}

# NOUVEAU v2.1 -- rend le CGV RÉEL (lib/legal/render.ts, `renderCgv()`,
# le même chemin que l'aperçu consultatif du tableau de bord,
# app/dashboard/legal-cgv/page.tsx buildPreview()) pour un restaurant
# donné, à partir de DONNÉES RÉELLES lues dans la base scratch (jamais
# une paraphrase du gabarit tapée à la main dans ce fichier shell). La
# requête SQL ci-dessous construit directement l'objet JSON attendu par
# renderCgv() (RenderCgvInput), avec le même mapping snake_case ->
# camelCase que buildPreview() lui-même -- un seul endroit fait ce
# mapping. $1 = restaurant_id. Écrit le HTML rendu dans le fichier
# indiqué par $2 ; utilise stdout pour capturer le HTML séparément de
# stderr (avertissements Node) via la redirection psql -> node ci-
# dessous. Renvoie le code de sortie du helper Node (0 = rendu réussi,
# 3 = ActualWeightPriceUnsupportedError, 2 = JSON invalide, 1 = autre
# erreur de rendu) dans RENDER_RC ; le HTML (si rc=0) est à la fois
# écrit dans $2 et disponible via RENDER_OUT.
RENDER_RC=0
RENDER_OUT=""
render_via_node() {
  local restaurant_id="$1" out_file="$2"
  local payload_file="/tmp/scanym-cgvenginev11-render-payload-$$.json"
  local err_file="/tmp/scanym-cgvenginev11-render-err-$$.txt"
  psql -X -A -q -t -d "$DB" -v ON_ERROR_STOP=1 -c "
    select jsonb_build_object(
      'sellerName', r.name,
      'template', t.controlled_sections,
      'legal', jsonb_build_object(
        'legalForm', l.legal_form, 'addressLine1', l.address_line1, 'addressLine2', l.address_line2,
        'postalCode', l.postal_code, 'city', l.city, 'governingCountry', l.governing_country,
        'customerServiceEmail', l.customer_service_email, 'customerServicePhone', l.customer_service_phone,
        'mediatorName', l.consumer_mediator_name, 'mediatorAddress', l.consumer_mediator_address,
        'mediatorWebsite', l.consumer_mediator_website,
        'legalEntityName', l.legal_entity_name, 'siren', l.siren, 'siret', l.siret, 'vatNumber', l.vat_number,
        'mediatorPhone', l.consumer_mediator_phone, 'mediatorEmail', l.consumer_mediator_email
      ),
      'business', jsonb_build_object(
        'withdrawalRegime', c.withdrawal_regime, 'preparationTimeMin', c.preparation_time_min,
        'preparationTimeMax', c.preparation_time_max, 'preparationTimeUnit', c.preparation_time_unit,
        'cancellationPolicyText', c.cancellation_policy_text, 'substitutionPolicyText', c.substitution_policy_text,
        'coldChainApplicable', c.cold_chain_applicable, 'weightPricingMode', c.weight_pricing_mode
      ),
      'locale', 'fr',
      'presentationVariant', coalesce(c.presentation_variant, 'FORMAL')
    )
    from public.restaurants r
    join public.merchant_legal_profile l on l.restaurant_id = r.id
    join public.merchant_cgv_profile c on c.restaurant_id = r.id
    join public.cgv_template t on t.id = (public._resolve_applicable_cgv_template(r.id)).id
    where r.id = '$restaurant_id';
  " > "$payload_file" 2>"$err_file"
  if [ ! -s "$payload_file" ]; then
    log "FATAL render_via_node: la requête de construction du payload JSON n'a rien produit pour $restaurant_id ($(cat "$err_file" 2>/dev/null))"
    RENDER_RC=99
    RENDER_OUT=""
    rm -f "$payload_file" "$err_file"
    return
  fi
  RENDER_OUT="$(node --experimental-strip-types "$RENDER_HELPER" < "$payload_file" 2>"$err_file")"
  RENDER_RC=$?
  if [ -n "$out_file" ] && [ "$RENDER_RC" -eq 0 ]; then
    printf '%s' "$RENDER_OUT" > "$out_file"
  fi
  rm -f "$payload_file" "$err_file"
}

# NOUVEAU v2.1 -- persiste un contenu potentiellement long/complexe (le
# VRAI rendu HTML produit par render_via_node() ci-dessus, jamais un
# simple littéral court comme le reste de ce harnais) SANS jamais faire
# retraverser ce contenu par l'expansion de variable bash (aucun risque
# lié à un caractère '$', une apostrophe ou un guillemet qu'il pourrait
# contenir) : le contenu est écrit tel quel dans un fichier SQL
# temporaire via `printf '%s'` (zéro interprétation bash sur son
# propre contenu), puis exécuté avec `psql -f` -- psql lui-même
# n'interprète que ses PROPRES variables (syntaxe `:nom`, jamais `$`),
# donc aucune substitution inattendue ne peut se produire côté psql non
# plus. $1=restaurant_id $2=template_id $3=contenu rendu $4=fingerprint
# $5=acting_user_id $6=rôle PGOPTIONS (par défaut service_role).
persist_rendered_content_rc() {
  local restaurant_id="$1" template_id="$2" content="$3" fingerprint="$4" acting_uid="$5" role="${6:-service_role}"
  local content_escaped f rc
  content_escaped=$(printf '%s' "$content" | sed "s/'/''/g")
  f="/tmp/scanym-cgvenginev11-persistsql-$$.sql"
  {
    printf "select * from public.persist_merchant_cgv_version('%s', '%s', '" "$restaurant_id" "$template_id"
    printf '%s' "$content_escaped"
    printf "', '%s', '%s');\n" "$fingerprint" "$acting_uid"
  } > "$f"
  # CGV ENGINE v2.2 -- CORRECTIF DE L'OUTIL DE TEST (hérité, latent
  # depuis v2.1) : sans `-v ON_ERROR_STOP=1`, `psql -f` retourne le code
  # de sortie 0 même quand la SEULE instruction du script échoue avec
  # une erreur SQL (vérifié empiriquement : un script `-f` à une seule
  # instruction en échec, sans ON_ERROR_STOP, sort avec rc=0 -- contrai-
  # rement à `psql -c`, qui sort avec rc=1 dans le même cas). v2.1
  # n'utilisait cette fonction QUE pour le chemin de succès (round-trip
  # render->persist), donc ce bug n'avait jamais eu l'occasion de se
  # manifester. Le test v2.2 [V22-STALE-CONTEXT-PIN] est le premier à
  # attendre un REFUS via cette fonction, et l'a exposé : sans ce
  # correctif, `assert_denied` recevait rc=0 (succès) même quand
  # persist_merchant_cgv_version levait bel et bien STALE_CONTEXT.
  PGOPTIONS="-c role=$role" psql -X -A -q -t -v ON_ERROR_STOP=1 -d "$DB" -f "$f" \
    >/tmp/scanym-cgvenginev11-out-$$.txt 2>/tmp/scanym-cgvenginev11-err-$$.txt
  rc=$?
  rm -f "$f"
  echo "$rc"
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
# NOUVEAU v2.4 -- l'inverse d'assert_eq : prouve une DIVERGENCE
# (utilisé pour prouver que la réassignation is_default a bien eu lieu
# -- "n'est plus la version 1", pas seulement "est la version 4").
assert_not_eq() {
  local desc="$1" unexpected="$2" actual="$3"
  if [ "$unexpected" != "$actual" ]; then pass "$desc (=$actual, != $unexpected)"; else fail "$desc — attendu une valeur DIFFÉRENTE de '$unexpected', obtenu la même valeur"; fi
}
assert_ok() {
  if [ "$2" -eq 0 ]; then pass "$1 (rc=0)"; else fail "$1 — attendu rc=0, obtenu rc=$2 : $(sql_err)"; fi
}
assert_denied() {
  if [ "$2" -ne 0 ]; then pass "$1 (rc=$2, refusé comme attendu)"; else fail "$1 — attendu un refus (rc!=0), obtenu rc=0"; fi
}
assert_contains() {
  if printf '%s' "$3" | grep -qF "$2"; then pass "$1"; else fail "$1 — '$2' absent de : $3"; fi
}
assert_not_contains() {
  if printf '%s' "$3" | grep -qF "$2"; then fail "$1 — '$2' présent (ne devrait pas l'être) : $3"; else pass "$1"; fi
}

build_common_bootstrap() {
  psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
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

build_chain() {
  for f in $MINIMAL_CHAIN; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1 || { log "FATAL: échec application $f"; return 1; }
    psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  done
  for f in $REST_CHAIN; do
    psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1 || { log "FATAL: échec application $f"; return 1; }
  done
  return 0
}

DB="scanym_p0_recovery_$$"
N1A="$SUPABASE_DIR/DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql"
LOT="$SUPABASE_DIR/DRAFT-lot-order-received-enqueue-recovery-v1.sql"
LOT_RB="$SUPABASE_DIR/DRAFT-lot-order-received-enqueue-recovery-v1-rollback.sql"

RESTO='11111111-1111-1111-1111-111111111111'
CAT='22222222-2222-2222-2222-222222222222'
ITEM='33333333-3333-3333-3333-333333333333'

seed_fixture() {
  psql -d "$DB" -q >/dev/null 2>&1 <<SQL
insert into public.restaurants (id, slug, name, is_active, status, country)
  values ('$RESTO','p0','P0 Resto', true, 'active','FR');
insert into public.restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number)
  values ('$RESTO','EUR',1,'+33600000000');
insert into public.menu_categories (id, restaurant_id, name, display_order, is_active)
  values ('$CAT','$RESTO','Cat',1,true);
insert into public.menu_items (id, category_id, name, price, is_available, tax_rate)
  values ('$ITEM','$CAT','Item',10.00,true,5.5);
insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled)
  values ('$RESTO','pickup', true);
SQL
}

# Crée une VRAIE commande via la RPC réelle, en tant que rôle anon (le
# chemin client réel). Renvoie l'order_id.
place_order() {
  PGOPTIONS="-c role=anon" psql -X -A -q -t -d "$DB" -c \
    "select order_id from public.create_order('p0','pickup','[{\"menu_item_id\":\"$ITEM\",\"quantity\":1,\"option_item_id\":null}]'::jsonb, null, '{\"name\":\"Client P0\",\"phone\":\"0600000000\",\"email\":\"p0@etys-it.local\"}'::jsonb, null, 'fr', true);" \
    2>/tmp/p0-err-$$.txt | tail -1 | tr -d ' '
}
outbox_count() { sql "select count(*) from public.notification_outbox where order_id='$1';" | tail -1 | tr -d ' '; }

# Extrait UNIQUEMENT la définition `create or replace function
# public.create_order(...) ... end $$;` d'un fichier de lot, et l'applique
# seule. Nécessaire parce que les deux lots concernés portent une garde
# anti-double-application qui refuse de rejouer le FICHIER entier : sans
# cette extraction, le scénario "un futur lot redéfinit create_order" ne
# serait jamais réellement simulé (il échouerait avant d'avoir redéfini
# quoi que ce soit, et le test passerait pour de mauvaises raisons).
apply_create_order_from() {
  local file="$1" tmp="/tmp/p0-co-$$.sql"
  awk '/^create or replace function public\.create_order\(/{f=1} f{print} f&&/^end \$\$;$/{exit}' "$file" > "$tmp"
  psql -X -A -q -t -d "$DB" -v ON_ERROR_STOP=1 -f "$tmp" >/dev/null 2>/tmp/p0-err-$$.txt
  local rc=$?
  rm -f "$tmp"
  echo $rc
}

build_full_chain() {  # chaîne + n1a + lots CGV, dans l'ORDRE RÉEL de mise sur main
  build_common_bootstrap >/dev/null 2>&1
  build_chain >/dev/null 2>&1 || return 1
  psql -d "$DB" -q -f "$N1A" >/dev/null 2>&1
  for f in "$LOT_SQL_V11" "$LOT_SQL_V12" "$LOT_SQL_V13" "$LOT_SQL_V14" "$LOT_SQL_V21" "$LOT_SQL_V22" "$LOT_SQL_V24" "$LOT_SQL_V25"; do
    psql -d "$DB" -q -f "$f" >/dev/null 2>&1
  done
  psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  return 0
}

log "=== [0] Construction de la chaîne réelle (ordre de mise sur main) ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1
createdb "$DB" || { log "FATAL createdb"; exit 1; }
build_full_chain || { log "FATAL chaîne"; exit 1; }
seed_fixture
pass "Chaîne réelle appliquée (n1a 14/09 PUIS lots CGV 16/09, comme en Production)"

CREATE_ORDER_DEF_BEFORE=$(sql "select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_order' limit 1;" | tail -1 | tr -d ' ')

# ---------------- RED ----------------
log "=== [RED] Preuve de la régression SUR LA BASELINE ==="
OID=$(place_order)
if [ -z "$OID" ]; then fail "RED: create_order a échoué — $(head -2 /tmp/p0-err-$$.txt|tr '\n' ' ')"; else pass "RED: la commande est bien créée (order_id=$OID)"; fi
assert_eq "RED: la commande existe en base" "1" "$(sql "select count(*) from public.orders where id='$OID';" | tail -1 | tr -d ' ')"
assert_eq "RED: 0 ligne outbox — ÉVÉNEMENT PERDU (régression reproduite)" "0" "$(outbox_count "$OID")"
assert_eq "RED: la définition GAGNANTE de create_order ne contient PAS l'enqueue" "f" "$(sql "select pg_get_functiondef(p.oid) like '%create_order_received_notification%' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_order' limit 1;" | tail -1 | tr -d ' ')"

# ---------------- Application du lot ----------------
log "=== [1] Application du lot de remédiation ==="
RC=$(sql_rc "$(cat "$LOT")")
assert_ok "Le lot s'applique proprement (pré-vol + commit + post-vol)" "$RC"
RC=$(sql_rc "$(cat "$LOT")")
assert_denied "Ré-application REFUSÉE (garde anti-double-application)" "$RC"

CREATE_ORDER_DEF_AFTER=$(sql "select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_order' limit 1;" | tail -1 | tr -d ' ')
assert_eq "create_order est INCHANGÉE — empreinte md5 de sa définition identique avant/après" "$CREATE_ORDER_DEF_BEFORE" "$CREATE_ORDER_DEF_AFTER"
assert_eq "create_order ne contient TOUJOURS PAS l'enqueue (le lot n'a pas patché son corps)" "f" "$(sql "select pg_get_functiondef(p.oid) like '%create_order_received_notification%' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_order' limit 1;" | tail -1 | tr -d ' ')"

# ---------------- GREEN ----------------
log "=== [GREEN] Le même parcours produit désormais l'événement ==="
OID2=$(place_order)
if [ -z "$OID2" ]; then fail "GREEN: create_order a échoué — $(head -2 /tmp/p0-err-$$.txt|tr '\n' ' ')"; else pass "GREEN: la commande est créée normalement (order_id=$OID2)"; fi
assert_eq "GREEN: EXACTEMENT 1 ligne outbox (ni 0, ni 2)" "1" "$(outbox_count "$OID2")"
assert_eq "GREEN: l'événement est bien de type order_received" "order_received" "$(sql "select notification_type from public.notification_outbox where order_id='$OID2';" | tail -1 | tr -d ' ')"
assert_eq "GREEN: la ligne porte le bon restaurant_id (isolation tenant)" "$RESTO" "$(sql "select restaurant_id from public.notification_outbox where order_id='$OID2';" | tail -1 | tr -d ' ')"
assert_eq "GREEN: l'adresse destinataire est bien figée depuis la commande" "p0@etys-it.local" "$(sql "select recipient_email from public.notification_outbox where order_id='$OID2';" | tail -1 | tr -d ' ')"
assert_eq "GREEN: la commande RED antérieure n'est PAS rattrapée (aucun backfill)" "0" "$(outbox_count "$OID")"

# ---------------- Idempotence ----------------
log "=== [IDEM] Une commande => au plus UN événement ==="
RC=$(sql_rc "select public.create_order_received_notification('$OID2','$RESTO');")
assert_ok "Rejeu manuel du helper accepté sans erreur (ON CONFLICT DO NOTHING)" "$RC"
assert_eq "IDEM: toujours EXACTEMENT 1 ligne après rejeu manuel" "1" "$(outbox_count "$OID2")"
assert_eq "IDEM: rejeu manuel renvoie NULL (aucune nouvelle ligne)" "" "$(sql "select public.create_order_received_notification('$OID2','$RESTO');" | tail -1 | tr -d ' ')"

# ---------------- Rollback transactionnel ----------------
log "=== [ROLLBACK TX] Commande annulée => aucun événement ==="
BEFORE_ORDERS=$(sql "select count(*) from public.orders;" | tail -1 | tr -d ' ')
BEFORE_OUTBOX=$(sql "select count(*) from public.notification_outbox;" | tail -1 | tr -d ' ')
psql -X -A -q -t -d "$DB" >/dev/null 2>&1 <<SQL
begin;
select public.create_order('p0','pickup','[{"menu_item_id":"$ITEM","quantity":1,"option_item_id":null}]'::jsonb, null, '{"name":"Rollback","phone":"0600000000","email":"rb@etys-it.local"}'::jsonb, null, 'fr', true);
rollback;
SQL
assert_eq "ROLLBACK TX: aucune commande persistée" "$BEFORE_ORDERS" "$(sql "select count(*) from public.orders;" | tail -1 | tr -d ' ')"
assert_eq "ROLLBACK TX: aucun événement persisté" "$BEFORE_OUTBOX" "$(sql "select count(*) from public.notification_outbox;" | tail -1 | tr -d ' ')"

# ---------------- Survie à une redéfinition de create_order ----------------
log "=== [SURVIE] Le déclencheur résiste à une redéfinition FUTURE de create_order ==="
RC=$(apply_create_order_from "$LOT_SQL_V25")
assert_ok "Redéfinition de create_order par le corps EXACT de CGV v2-5 (simule un futur lot)" "$RC"
assert_eq "SURVIE: create_order redéfinie NE contient PAS l'enqueue (le piège est bien réarmé)" "f" "$(sql "select pg_get_functiondef(p.oid) like '%create_order_received_notification%' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_order' limit 1;" | tail -1 | tr -d ' ')"
OID3=$(place_order)
if [ -z "$OID3" ]; then fail "SURVIE: create_order a échoué — $(head -2 /tmp/p0-err-$$.txt|tr '\n' ' ')"; else pass "SURVIE: commande créée après redéfinition (order_id=$OID3)"; fi
assert_eq "SURVIE: l'événement est TOUJOURS enfilé (1 ligne) — c'est ce qu'un correctif dans le corps de create_order aurait perdu" "1" "$(outbox_count "$OID3")"

# ---------------- Double chemin d'enqueue ----------------
log "=== [DOUBLE CHEMIN] Déclencheur + enqueue direct restauré => toujours 1 seul événement ==="
RC=$(apply_create_order_from "$N1A")
assert_ok "Restauration du corps N1-A de create_order (appel direct rétabli, EN PLUS du déclencheur)" "$RC"
assert_eq "Les DEUX chemins sont désormais actifs (create_order contient l'enqueue)" "t" "$(sql "select pg_get_functiondef(p.oid) like '%create_order_received_notification%' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_order' limit 1;" | tail -1 | tr -d ' ')"
OID4=$(place_order)
if [ -z "$OID4" ]; then fail "DOUBLE: create_order a échoué — $(head -2 /tmp/p0-err-$$.txt|tr '\n' ' ')"; else pass "DOUBLE: commande créée (order_id=$OID4)"; fi
assert_eq "DOUBLE CHEMIN: EXACTEMENT 1 événement malgré deux chemins d'enqueue — aucun e-mail en double possible" "1" "$(outbox_count "$OID4")"

# ---------------- Hygiène SQL ----------------
log "=== [HYGIÈNE] Droits, sécurité, forme du déclencheur ==="
assert_eq "La fonction de déclenchement est SECURITY DEFINER" "t" "$(sql "select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='tg_orders_enqueue_order_received';" | tail -1 | tr -d ' ')"
assert_eq "search_path explicitement vide" 'search_path=""' "$(sql "select coalesce(array_to_string(proconfig,','),'') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='tg_orders_enqueue_order_received';" | tail -1)"
assert_eq "anon ne peut PAS exécuter directement la fonction de déclenchement" "f" "$(sql "select has_function_privilege('anon','public.tg_orders_enqueue_order_received()','EXECUTE');" | tail -1 | tr -d ' ')"
assert_eq "authenticated ne peut PAS l'exécuter directement" "f" "$(sql "select has_function_privilege('authenticated','public.tg_orders_enqueue_order_received()','EXECUTE');" | tail -1 | tr -d ' ')"
assert_eq "service_role ne peut PAS l'exécuter directement" "f" "$(sql "select has_function_privilege('service_role','public.tg_orders_enqueue_order_received()','EXECUTE');" | tail -1 | tr -d ' ')"
assert_eq "Le déclencheur est DEFERRABLE" "t" "$(sql "select tgdeferrable from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='orders' and t.tgname='orders_enqueue_order_received_trg';" | tail -1 | tr -d ' ')"
assert_eq "Le déclencheur est INITIALLY DEFERRED" "t" "$(sql "select tginitdeferred from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='orders' and t.tgname='orders_enqueue_order_received_trg';" | tail -1 | tr -d ' ')"
assert_eq "Le déclencheur est bien un déclencheur de CONTRAINTE" "t" "$(sql "select tgconstraint <> 0 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='orders' and t.tgname='orders_enqueue_order_received_trg';" | tail -1 | tr -d ' ')"
assert_eq "Un SEUL déclencheur de ce nom sur public.orders (aucun doublon)" "1" "$(sql "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='orders' and t.tgname='orders_enqueue_order_received_trg';" | tail -1 | tr -d ' ')"

# ---------------- Rollback du lot ----------------
log "=== [ROLLBACK LOT] ==="
RC=$(sql_rc "$(cat "$LOT_RB")")
assert_ok "Le rollback s'applique proprement" "$RC"
assert_eq "ROLLBACK: le déclencheur n'existe plus" "0" "$(sql "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='orders' and t.tgname='orders_enqueue_order_received_trg';" | tail -1 | tr -d ' ')"
assert_eq "ROLLBACK: la fonction de déclenchement n'existe plus" "0" "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='tg_orders_enqueue_order_received';" | tail -1 | tr -d ' ')"
assert_eq "ROLLBACK: les lignes outbox déjà enfilées sont CONSERVÉES (aucune suppression d'événements réels)" "1" "$(outbox_count "$OID2")"
assert_eq "ROLLBACK: create_order intacte" "1" "$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_order';" | tail -1 | tr -d ' ')"

log "=== RÉSUMÉ ==="
log "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then echo "--- ÉCHECS ---"; cat "$FAIL_LOG"; exit 1; fi
exit 0
