#!/usr/bin/env bash
# ============================================================
# Scanym — AU LAIT CRU — CASE 1A / ALC-SM-04 — Harnais reproductible :
# durcissement fail-closed du SQL draft Click & Collect Only
# (supabase/DRAFT-aulaitcru-sale-modes-config.sql).
#
# Corrige ALC-SM-04 (audit Work, HIGH) : le script n'était pas
# suffisamment fail-closed pour garantir CLICK & COLLECT ONLY --
# tenant absent (NOTICE au lieu d'échouer), slug dupliqué (boucle sur
# plusieurs tenants), delivery préexistant (laissé inchangé), et
# aucun test SQL ne couvrait ces scénarios. Ce harnais couvre les 5
# scénarios exigés par l'audit (section 5 de la mission ALC-SM-04) :
#   A. tenant absent          -> exception, rollback, aucune mutation
#   B. slug dupliqué          -> exception, rollback, aucun tenant modifié
#   C. delivery préexistant actif -> nettoyé (pickup actif, table/delivery absents)
#   D. réexécution             -> idempotent (même état final, aucune duplication)
#   E. autre tenant (témoin)   -> aucune modification
# Plus les assertions post-condition (section 6 de la mission).
#
# Baseline : LOT 2B.1 (chaîne réelle complète, même patron que
# supabase/tests/v84-lot2b1-check.sh) -- restaurant_sale_modes et
# restaurant_sale_mode_field_requirements existent depuis LOT 2A.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/alc-sm-04-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_SQL="$SUPABASE_DIR/DRAFT-aulaitcru-sale-modes-config.sql"

PASS_COUNT=0
FAIL_COUNT=0

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
FAIL_LOG="/tmp/scanym-alcsm04-fails-$$.log"
: > "$FAIL_LOG"
fail() {
  FAIL_COUNT=$((FAIL_COUNT+1))
  printf '%s\n' "$*" >> "$FAIL_LOG"
  log "FAIL: $*"
}

ALL_DBS=()
cleanup() {
  for db in "${ALL_DBS[@]:-}"; do
    [ -n "$db" ] && psql -c "drop database if exists \"$db\";" >/dev/null 2>&1 || true
  done
  rm -f "${FAIL_LOG:-}" 2>/dev/null || true
}
trap cleanup EXIT

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}

# ------------------------------------------------------------------
# Construction de la baseline réelle (identique au patron déjà audité
# de supabase/tests/v84-lot2b1-check.sh : chaîne complète jusqu'à
# LOT 2B.1, avec les 3 établissements réels + seeds).
# ------------------------------------------------------------------
build_baseline() {
  local target_db="$1"
  ALL_DBS+=("$target_db")
  psql -c "drop database if exists \"$target_db\";" >/dev/null 2>&1 || true
  createdb "$target_db"
  psql -d "$target_db" >/dev/null <<'SQL'
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
create schema if not exists storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/'); $$;
SQL
  for f in schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql; do
    psql -d "$target_db" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
    psql -d "$target_db" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
  done
  for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql; do
    psql -d "$target_db" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  done
  psql -d "$target_db" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-illico-v2.sql" >/dev/null 2>&1
  psql -d "$target_db" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-sanaa.sql" >/dev/null 2>&1
  psql -d "$target_db" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-sirocco-demo.sql" >/dev/null 2>&1
  psql -d "$target_db" -c "update restaurants set status='active';" >/dev/null 2>&1
  psql -d "$target_db" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" >/dev/null
  psql -d "$target_db" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v83-lot2a4-privilege-hardening.sql" >/dev/null
  psql -d "$target_db" -c "alter default privileges in schema public grant execute on functions to service_role;" >/dev/null
  psql -d "$target_db" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v84-lot2b1-delivery-info-rpc.sql" >/dev/null
}

seed_au_lait_cru() {
  local target_db="$1"
  psql -d "$target_db" -c "
    insert into restaurants (id, name, slug, is_active, status)
    values ('a1000000-0000-0000-0000-000000000001', 'Au Lait Cru', 'au-lait-cru', true, 'active');
    insert into restaurant_configs (restaurant_id, currency, whatsapp_number)
    values ('a1000000-0000-0000-0000-000000000001', 'EUR', '+33600000001');
  " >/dev/null
}

# Empreinte complète (mode + requirements) d'un tenant -- utilisée
# pour prouver "aucune modification" par comparaison stricte
# avant/après (scénarios A, B, E).
tenant_fingerprint() {
  local target_db="$1" restaurant_id="$2"
  psql -X -A -t -d "$target_db" -c "
    select coalesce(string_agg(distinct x, '|' order by x), '') from (
      select 'MODE:' || mode_code || ',' || enabled || ',' || display_order || ',' || provider as x
      from restaurant_sale_modes where restaurant_id = '$restaurant_id'
      union all
      select 'REQ:' || mode_code || ',' || field || ',' || requirement || ',' || coalesce(one_of_group,'') as x
      from restaurant_sale_mode_field_requirements where restaurant_id = '$restaurant_id'
    ) t;
  "
}

TOTAL_ROWS_FINGERPRINT() {
  local target_db="$1"
  psql -X -A -t -d "$target_db" -c "
    select (select count(*) from restaurant_sale_modes)::text || '/' ||
           (select count(*) from restaurant_sale_mode_field_requirements)::text;
  "
}

# ==================================================================
# A. TENANT ABSENT -> exception, rollback, aucune mutation
# ==================================================================
log "=== A. Tenant absent : le script DOIT échouer (RAISE EXCEPTION), jamais un simple NOTICE ==="
DB_A="scanym_alcsm04_absent_$$"
build_baseline "$DB_A"
# Volontairement PAS de seed_au_lait_cru ici -- tenant absent.

BEFORE_TOTALS_A=$(TOTAL_ROWS_FINGERPRINT "$DB_A")

RC=0
psql -d "$DB_A" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/tmp/alcsm04_a_out_$$.txt 2>/tmp/alcsm04_a_err_$$.txt || RC=$?
assert_eq "A. tenant absent : le script échoue (code de sortie non-zéro)" "1" "$([ "$RC" -ne 0 ] && echo 1 || echo 0)"
EXC_A=$(grep -c "SCANYM_ALC_TENANT_NOT_FOUND" /tmp/alcsm04_a_err_$$.txt || true)
assert_eq "A. l'exception explicite SCANYM_ALC_TENANT_NOT_FOUND est levée (jamais un simple RAISE NOTICE)" "1" "$EXC_A"
NOTICE_ONLY_A=$(grep -c "^NOTICE" /tmp/alcsm04_a_err_$$.txt || true)
# Une exception peut être précédée d'un contexte, mais ne doit jamais
# se substituer à un simple NOTICE terminant sans erreur -- déjà
# couvert par l'assertion du code de sortie ci-dessus ; ce contrôle
# supplémentaire vérifie qu'aucune trace de l'ancien comportement
# ("NOTICE ... sans effet") ne subsiste.
OLD_BEHAVIOR_A=$(cat /tmp/alcsm04_a_err_$$.txt /tmp/alcsm04_a_out_$$.txt 2>/dev/null | grep -c "script sans effet" || true)
assert_eq "A. aucune trace de l'ancien comportement 'NOTICE ... script sans effet'" "0" "$OLD_BEHAVIOR_A"
rm -f /tmp/alcsm04_a_out_$$.txt /tmp/alcsm04_a_err_$$.txt

AFTER_TOTALS_A=$(TOTAL_ROWS_FINGERPRINT "$DB_A")
assert_eq "A. aucune mutation nulle part (total restaurant_sale_modes/requirements inchangé)" "$BEFORE_TOTALS_A" "$AFTER_TOTALS_A"

# ==================================================================
# B. SLUG DUPLIQUÉ -> exception, rollback, aucun tenant modifié
#
# NOTE : restaurants.slug porte une contrainte UNIQUE en production
# (schema.sql) -- un doublon LITTÉRAL est donc normalement impossible
# au niveau base. Ce scénario prouve la défense EN PROFONDEUR du
# script lui-même (il ne doit jamais supposer l'unicité garantie
# ailleurs) : la contrainte est levée TEMPORAIREMENT, UNIQUEMENT dans
# cette base de test jetable, jamais en Production, pour démontrer que
# le script refuse quand même une résolution ambiguë.
# ==================================================================
log "=== B. Slug dupliqué : le script DOIT échouer (résolution ambiguë), jamais modifier tous les tenants correspondants ==="
DB_B="scanym_alcsm04_dup_$$"
build_baseline "$DB_B"
seed_au_lait_cru "$DB_B"

SLUG_CONSTRAINT=$(psql -X -A -t -d "$DB_B" -c "select conname from pg_constraint where conrelid = 'public.restaurants'::regclass and contype = 'u' limit 1;")
psql -d "$DB_B" -c "alter table public.restaurants drop constraint \"$SLUG_CONSTRAINT\";" >/dev/null

psql -d "$DB_B" -c "
  insert into restaurants (id, name, slug, is_active, status)
  values ('a1000000-0000-0000-0000-000000000002', 'Au Lait Cru (doublon)', 'au-lait-cru', true, 'active');
  insert into restaurant_configs (restaurant_id, currency, whatsapp_number)
  values ('a1000000-0000-0000-0000-000000000002', 'EUR', '+33600000002');
" >/dev/null

BEFORE_FP_B1=$(tenant_fingerprint "$DB_B" "a1000000-0000-0000-0000-000000000001")
BEFORE_FP_B2=$(tenant_fingerprint "$DB_B" "a1000000-0000-0000-0000-000000000002")

RC=0
psql -d "$DB_B" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/tmp/alcsm04_b_out_$$.txt 2>/tmp/alcsm04_b_err_$$.txt || RC=$?
assert_eq "B. slug dupliqué : le script échoue (code de sortie non-zéro)" "1" "$([ "$RC" -ne 0 ] && echo 1 || echo 0)"
EXC_B=$(grep -c "SCANYM_ALC_TENANT_AMBIGUOUS" /tmp/alcsm04_b_err_$$.txt || true)
assert_eq "B. l'exception explicite SCANYM_ALC_TENANT_AMBIGUOUS est levée" "1" "$EXC_B"
COUNT_MENTIONED_B=$(grep -c "2 restaurants trouvés" /tmp/alcsm04_b_err_$$.txt || true)
assert_eq "B. le message d'exception mentionne le nombre réel de tenants trouvés (2)" "1" "$COUNT_MENTIONED_B"
rm -f /tmp/alcsm04_b_out_$$.txt /tmp/alcsm04_b_err_$$.txt

AFTER_FP_B1=$(tenant_fingerprint "$DB_B" "a1000000-0000-0000-0000-000000000001")
AFTER_FP_B2=$(tenant_fingerprint "$DB_B" "a1000000-0000-0000-0000-000000000002")
assert_eq "B. aucun des deux tenants au slug dupliqué n'a été modifié (le premier)" "$BEFORE_FP_B1" "$AFTER_FP_B1"
assert_eq "B. aucun des deux tenants au slug dupliqué n'a été modifié (le second)" "$BEFORE_FP_B2" "$AFTER_FP_B2"
assert_eq "B. aucune boucle n'a modifié TOUS les tenants correspondants (aucune ligne 'pickup' créée pour le premier)" "" "$(psql -X -A -t -d "$DB_B" -c "select mode_code from restaurant_sale_modes where restaurant_id='a1000000-0000-0000-0000-000000000001' and mode_code='pickup';")"
assert_eq "B. aucune boucle n'a modifié TOUS les tenants correspondants (aucune ligne 'pickup' créée pour le second)" "" "$(psql -X -A -t -d "$DB_B" -c "select mode_code from restaurant_sale_modes where restaurant_id='a1000000-0000-0000-0000-000000000002' and mode_code='pickup';")"

# ==================================================================
# C. DELIVERY PRÉEXISTANT ACTIF -> nettoyé (pickup actif, table/delivery absents)
# Avant : pickup ABSENT, table PRÉSENT, delivery ACTIF.
# ==================================================================
log "=== C. delivery préexistant actif : doit être retiré (pickup actif, table/delivery absents après) ==="
DB_MAIN="scanym_alcsm04_main_$$"
build_baseline "$DB_MAIN"
seed_au_lait_cru "$DB_MAIN"
AU_LAIT_CRU_ID="a1000000-0000-0000-0000-000000000001"

# Tenant témoin (E) construit dès maintenant, dans la MÊME base que le
# scénario C/D -- illico-presto (seed réel) sert de témoin naturel :
# déjà configuré par migration-v82 (table+pickup), jamais touché par
# ce script (slug différent).
ILLICO_ID=$(psql -X -A -t -d "$DB_MAIN" -c "select id from restaurants where slug='illico-presto';")

# État "avant" exigé par l'audit : pickup absent, table présent, delivery actif.
psql -d "$DB_MAIN" -c "
  insert into restaurant_sale_modes (restaurant_id, mode_code, enabled, display_order, provider)
  values ('$AU_LAIT_CRU_ID', 'table', true, 1, 'internal')
  on conflict (restaurant_id, mode_code) do nothing;
  insert into restaurant_sale_modes (restaurant_id, mode_code, enabled, display_order, provider, config)
  values ('$AU_LAIT_CRU_ID', 'delivery', true, 2, 'internal', jsonb_build_object('delivery_zone_prefixes', array['75'], 'delivery_min_items', 5, 'delivery_area_label', 'Paris'))
  on conflict (restaurant_id, mode_code) do nothing;
" >/dev/null
PICKUP_ABSENT_BEFORE=$(psql -X -A -t -d "$DB_MAIN" -c "select count(*) from restaurant_sale_modes where restaurant_id='$AU_LAIT_CRU_ID' and mode_code='pickup';")
assert_eq "C. précondition : pickup absent avant exécution" "0" "$PICKUP_ABSENT_BEFORE"
DELIVERY_ACTIVE_BEFORE=$(psql -X -A -t -d "$DB_MAIN" -c "select enabled::text from restaurant_sale_modes where restaurant_id='$AU_LAIT_CRU_ID' and mode_code='delivery';")
assert_eq "C. précondition : delivery actif avant exécution" "true" "$DELIVERY_ACTIVE_BEFORE"

WITNESS_BEFORE=$(tenant_fingerprint "$DB_MAIN" "$ILLICO_ID")

psql -d "$DB_MAIN" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/dev/null
pass "C. script exécuté sans erreur sur l'état 'delivery préexistant actif'"

MODES_AFTER_C=$(psql -X -A -t -d "$DB_MAIN" -c "select string_agg(mode_code, ',' order by mode_code) from restaurant_sale_modes where restaurant_id='$AU_LAIT_CRU_ID';")
assert_eq "C. ensemble de modes EXACT après exécution : pickup seul" "pickup" "$MODES_AFTER_C"
PICKUP_ENABLED_C=$(psql -X -A -t -d "$DB_MAIN" -c "select enabled::text from restaurant_sale_modes where restaurant_id='$AU_LAIT_CRU_ID' and mode_code='pickup';")
assert_eq "C. pickup actif après exécution" "true" "$PICKUP_ENABLED_C"
TABLE_GONE_C=$(psql -X -A -t -d "$DB_MAIN" -c "select count(*) from restaurant_sale_modes where restaurant_id='$AU_LAIT_CRU_ID' and mode_code='table';")
assert_eq "C. table absent après exécution" "0" "$TABLE_GONE_C"
DELIVERY_GONE_C=$(psql -X -A -t -d "$DB_MAIN" -c "select count(*) from restaurant_sale_modes where restaurant_id='$AU_LAIT_CRU_ID' and mode_code='delivery';")
assert_eq "C. delivery ABSENT après exécution (corrige ALC-SM-04 : n'est plus laissé actif)" "0" "$DELIVERY_GONE_C"

# Assertions post-condition (section 6) : requirements pickup exacts,
# aucun requirement parasite (table/delivery).
REQS_C=$(psql -X -A -t -d "$DB_MAIN" -c "select mode_code||'/'||field||'/'||requirement||'/'||coalesce(one_of_group,'-') from restaurant_sale_mode_field_requirements where restaurant_id='$AU_LAIT_CRU_ID' order by mode_code, display_order;")
EXPECTED_REQS_C=$'pickup/customer_name/required/-\npickup/phone/one_of/contact\npickup/email/one_of/contact'
assert_eq "C. requirements pickup EXACTS (name required, phone/email one_of 'contact'), aucun requirement table/delivery parasite" "$EXPECTED_REQS_C" "$REQS_C"

# ==================================================================
# D. RÉEXÉCUTION -> idempotent (même état final, aucune duplication)
# ==================================================================
log "=== D. Réexécution : deuxième passage sans erreur, même état final, aucune duplication ==="
FP_BEFORE_D=$(tenant_fingerprint "$DB_MAIN" "$AU_LAIT_CRU_ID")

psql -d "$DB_MAIN" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/dev/null
pass "D. deuxième exécution du script sans erreur (idempotence)"

FP_AFTER_D=$(tenant_fingerprint "$DB_MAIN" "$AU_LAIT_CRU_ID")
assert_eq "D. état final identique après réexécution (aucune divergence)" "$FP_BEFORE_D" "$FP_AFTER_D"
MODES_COUNT_D=$(psql -X -A -t -d "$DB_MAIN" -c "select count(*) from restaurant_sale_modes where restaurant_id='$AU_LAIT_CRU_ID';")
assert_eq "D. aucune duplication de ligne mode après réexécution (toujours 1 seule ligne)" "1" "$MODES_COUNT_D"
REQS_COUNT_D=$(psql -X -A -t -d "$DB_MAIN" -c "select count(*) from restaurant_sale_mode_field_requirements where restaurant_id='$AU_LAIT_CRU_ID';")
assert_eq "D. aucune duplication de ligne requirement après réexécution (toujours 3 lignes exactement)" "3" "$REQS_COUNT_D"

# Troisième passage pour renforcer la preuve d'idempotence (pas
# seulement "1 fois de plus fonctionne", mais un état stable durable).
psql -d "$DB_MAIN" -v ON_ERROR_STOP=1 -f "$DRAFT_SQL" >/dev/null
FP_AFTER_D3=$(tenant_fingerprint "$DB_MAIN" "$AU_LAIT_CRU_ID")
assert_eq "D. état final identique après un TROISIÈME passage (stabilité durable, pas un simple hasard à 2 passages)" "$FP_BEFORE_D" "$FP_AFTER_D3"

# ==================================================================
# E. AUTRE TENANT (témoin) -> aucun mode ou requirement modifié
# ==================================================================
log "=== E. Tenant témoin (illico-presto) : aucune modification malgré les 3 exécutions du script sur Au Lait Cru ==="
WITNESS_AFTER=$(tenant_fingerprint "$DB_MAIN" "$ILLICO_ID")
assert_eq "E. tenant témoin (illico-presto) strictement inchangé (modes ET requirements)" "$WITNESS_BEFORE" "$WITNESS_AFTER"

SANAA_ID=$(psql -X -A -t -d "$DB_MAIN" -c "select id from restaurants where slug='sanaa-cookies';")
SIROCCO_ID=$(psql -X -A -t -d "$DB_MAIN" -c "select id from restaurants where slug='le-sirocco';")
SANAA_MODES_E=$(psql -X -A -t -d "$DB_MAIN" -c "select string_agg(mode_code, ',' order by display_order) from restaurant_sale_modes where restaurant_id='$SANAA_ID';")
assert_eq "E. sanaa-cookies inchangé (pickup+delivery, comportement LOT 2A intact)" "pickup,delivery" "$SANAA_MODES_E"
SIROCCO_MODES_E=$(psql -X -A -t -d "$DB_MAIN" -c "select string_agg(mode_code, ',' order by display_order) from restaurant_sale_modes where restaurant_id='$SIROCCO_ID';")
assert_eq "E. le-sirocco inchangé (table seul, comportement LOT 2A intact)" "table" "$SIROCCO_MODES_E"

# ==================================================================
# 6. ASSERTIONS POST-CONDITION SUPPLÉMENTAIRES (section 6 de la mission)
# ==================================================================
log "=== 6. Assertions post-condition explicites ==="
DISPLAY_ORDER_C=$(psql -X -A -t -d "$DB_MAIN" -c "select display_order from restaurant_sale_modes where restaurant_id='$AU_LAIT_CRU_ID' and mode_code='pickup';")
assert_eq "post-condition : pickup display_order = 1" "1" "$DISPLAY_ORDER_C"
PROVIDER_C=$(psql -X -A -t -d "$DB_MAIN" -c "select provider from restaurant_sale_modes where restaurant_id='$AU_LAIT_CRU_ID' and mode_code='pickup';")
assert_eq "post-condition : pickup provider = 'internal' (aucun provider externe, aucun Stuart/Chronofresh)" "internal" "$PROVIDER_C"
NO_STUART_ANYWHERE=$(psql -X -A -t -d "$DB_MAIN" -c "select count(*) from restaurant_sale_modes where restaurant_id='$AU_LAIT_CRU_ID' and provider != 'internal';")
assert_eq "post-condition : aucune ligne Au Lait Cru avec un provider non-'internal'" "0" "$NO_STUART_ANYWHERE"

# ==================================================================
FAIL_LOG_COUNT=$(wc -l < "$FAIL_LOG" | tr -d ' ')
if [ "$FAIL_LOG_COUNT" != "$FAIL_COUNT" ]; then
  echo "[$(date '+%H:%M:%S')] HARNESS SELF-TEST ÉCHEC CRITIQUE : FAIL_COUNT ($FAIL_COUNT) ne correspond pas au journal indépendant ($FAIL_LOG_COUNT)."
  cat "$FAIL_LOG"
  exit 1
fi
if [ "$FAIL_LOG_COUNT" -gt 0 ]; then
  echo "[$(date '+%H:%M:%S')] HARNESS SELF-TEST : $FAIL_LOG_COUNT échec(s) réel(s) -- le script échoue."
  cat "$FAIL_LOG"
  exit 1
fi
echo "[$(date '+%H:%M:%S')] HARNESS SELF-TEST : journal indépendant vide et concordant avec FAIL_COUNT (0)."

log "=== RÉSULTAT FINAL : $PASS_COUNT réussis, $FAIL_COUNT échoués ==="
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "DES VÉRIFICATIONS ALC-SM-04 ONT ÉCHOUÉ"
  exit 1
fi
echo "TOUTES LES VÉRIFICATIONS ALC-SM-04 ONT RÉUSSI"
