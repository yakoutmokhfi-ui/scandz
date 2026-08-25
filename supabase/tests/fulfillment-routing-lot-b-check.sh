#!/usr/bin/env bash
# ============================================================
# Scanym — FULFILLMENT ROUTING LOT B — Harnais PostgreSQL jetable
# (supabase/DRAFT-lot-fulfillment-routing-lot-b-rpc.sql).
#
# MIS À JOUR EN LOT B.1 (audit Work, findings FRB-B-01/HIGH et
# FRB-B-02/MEDIUM) :
#   - resolve_delivery_fulfillment prend désormais 4 arguments
#     (p_total_count ajouté) et retourne TOUJOURS exactement 1 ligne
#     portant eligible/block/missing/matched_prefix -- min_items est
#     désormais réellement appliqué (FRB-B-01), et un code postal
#     invalide/absent refuse même le fallback (FRB-B-01, alignement
#     avec le contrat frontend déjà correct sur ce point).
#   - Nouvelle section "FIXTURE COMMUNE" : rejoue
#     tests/fixtures/fulfillment-routing-cases.json (LA fixture
#     canonique, également consommée par
#     tests/v97-fulfillment-routing-lot-b1-determinism.test.ts côté
#     TypeScript) via supabase/tests/generate-fulfillment-lot-b1-
#     fixture-checks.mjs — preuve auditable que SQL et frontend
#     appliquent le même contrat cas par cas (FRB-B-02), pas deux
#     suites indépendantes qui se ressemblent seulement.
#
# Couvre (mission Lot B + Lot B.1) :
#   - RPC additive get_restaurant_public_delivery_fulfillments :
#     projection minimale, jamais provider/config, invariant double
#     enabled (règle ET mode parent), filtrage établissement actif,
#     ACL (anon/authenticated EXECUTE=true, public=false).
#   - Résolveur interne resolve_delivery_fulfillment : algorithme
#     déterministe corrigé (non-fallback trié par display_order,
#     fallback, min_items réellement appliqué, contrat postal
#     invalide/absent aligné avec le frontend), invariant double
#     enabled, ACL (REVOQUÉ de tout accès direct — public/anon/
#     authenticated=false).
#   - Déterminisme SQL/frontend prouvé cas par cas (fixture commune).
#   - Additivité stricte : aucune table modifiée, aucune donnée
#     tenant insérée par le DRAFT lui-même, exactement 2 nouvelles
#     routines publiques ajoutées.
#   - Anti-double-application (préflight SCANYM_SCHEMA_DRIFT).
#
# Baseline : chaîne réelle complète jusqu'à LOT A (même patron que
# fulfillment-routing-lot-a-check.sh) + application du DRAFT Lot B
# (version corrigée Lot B.1) en fin de chaîne. AUCUNE exécution contre
# Supabase Production.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/fulfillment-routing-lot-b-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DRAFT_A_SQL="$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-model.sql"
DRAFT_B_SQL="$SUPABASE_DIR/DRAFT-lot-fulfillment-routing-lot-b-rpc.sql"
DB="scanym_frb_check_$$"

PASS_COUNT=0
FAIL_COUNT=0

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
FAIL_LOG="/tmp/scanym-frb-fails-$$.log"
: > "$FAIL_LOG"
fail() {
  FAIL_COUNT=$((FAIL_COUNT+1))
  printf '%s\n' "$*" >> "$FAIL_LOG"
  log "FAIL: $*"
}

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  rm -f "${FAIL_LOG:-}" 2>/dev/null || true
}
trap cleanup EXIT

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}

assert_rc() {
  local desc="$1" expected_rc="$2" actual_rc="$3"
  if [ "$expected_rc" = "$actual_rc" ]; then pass "$desc (rc=$actual_rc)"; else fail "$desc — attendu rc=$expected_rc, obtenu rc=$actual_rc"; fi
}

sql() { psql -X -A -q -t -d "$DB" -c "$1"; }
sql_as() {
  local role="$1" query="$2"
  PGOPTIONS="-c role=$role" psql -X -A -q -t -d "$DB" -c "$query"
}

# ------------------------------------------------------------------
# Baseline : identique au patron déjà audité
# (fulfillment-routing-lot-a-check.sh) — chaîne réelle jusqu'à LOT A,
# 3 tenants réels seedés et actifs.
# ------------------------------------------------------------------
log "Construction baseline $DB..."
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

for f in schema.sql migration-orders.sql migration-orders-lang.sql migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql migration-translations.sql migration-v39-settings.sql migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql migration-v66-categories-descriptions.sql; do
  psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
done
for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v80-lot1a-identity-social-languages.sql migration-v81-lot1b-translations.sql; do
  psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
done
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-illico-v2.sql" >/dev/null 2>&1
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-sanaa.sql" >/dev/null 2>&1
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/seed-sirocco-demo.sql" >/dev/null 2>&1
psql -d "$DB" -c "update restaurants set status='active';" >/dev/null 2>&1
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v82-lot2a-sale-modes.sql" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v83-lot2a4-privilege-hardening.sql" >/dev/null
psql -d "$DB" -c "alter default privileges in schema public grant execute on functions to service_role;" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v84-lot2b1-delivery-info-rpc.sql" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_A_SQL" >/dev/null

# ------------------------------------------------------------------
# Empreinte AVANT application du DRAFT B (preuve additivité).
# ------------------------------------------------------------------
BEFORE_TABLES=$(sql "select string_agg(tablename || ':' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', schemaname, tablename), false, true, '')))[1]::text, '|' order by tablename) from pg_tables where schemaname='public';")
BEFORE_ROUTINES=$(sql "select string_agg(proname, ',' order by proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public';")

log "Application du DRAFT fulfillment routing Lot B..."
DRAFT_RC=0
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_B_SQL" >/tmp/scanym-frb-draft-apply-$$.log 2>&1 || DRAFT_RC=$?
assert_rc "DRAFT Lot B s'applique sans erreur sur baseline propre (LOT A déjà installé)" 0 "$DRAFT_RC"
if [ "$DRAFT_RC" != "0" ]; then
  cat /tmp/scanym-frb-draft-apply-$$.log
fi
rm -f /tmp/scanym-frb-draft-apply-$$.log

# ------------------------------------------------------------------
# Réexécution : le préflight doit bloquer une double application.
# ------------------------------------------------------------------
REAPPLY_RC=0
REAPPLY_OUT=$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$DRAFT_B_SQL" 2>&1) || REAPPLY_RC=$?
assert_rc "réexécution du DRAFT B échoue proprement (préflight anti-double-application)" 1 "$([ "$REAPPLY_RC" != "0" ] && echo 1 || echo 0)"
if echo "$REAPPLY_OUT" | grep -q "SCANYM_SCHEMA_DRIFT"; then
  pass "réexécution : message d'erreur explicite SCANYM_SCHEMA_DRIFT"
else
  fail "réexécution : message d'erreur explicite absent — sortie: $REAPPLY_OUT"
fi

# Reprérequis manquant : sur une base SANS LOT A, le DRAFT B doit
# refuser de s'appliquer (preuve que le garde-fou prérequis fonctionne
# réellement, pas seulement documenté).
NODEP_DB="scanym_frb_nodep_$$"
psql -c "drop database if exists \"$NODEP_DB\";" >/dev/null 2>&1 || true
createdb "$NODEP_DB"
psql -d "$NODEP_DB" -c "create extension if not exists pgcrypto;" >/dev/null
NODEP_RC=0
NODEP_OUT=$(psql -d "$NODEP_DB" -v ON_ERROR_STOP=1 -f "$DRAFT_B_SQL" 2>&1) || NODEP_RC=$?
assert_rc "DRAFT B refuse de s'appliquer sans LOT A (prérequis manquant)" 1 "$([ "$NODEP_RC" != "0" ] && echo 1 || echo 0)"
if echo "$NODEP_OUT" | grep -q "SCANYM_SCHEMA_DRIFT"; then
  pass "prérequis manquant : message d'erreur explicite SCANYM_SCHEMA_DRIFT"
else
  fail "prérequis manquant : message d'erreur explicite absent — sortie: $NODEP_OUT"
fi
psql -c "drop database if exists \"$NODEP_DB\";" >/dev/null 2>&1 || true

# ==================================================================
# SCHEMA — les deux nouvelles routines existent avec la bonne forme
# ==================================================================
assert_eq "resolve_delivery_fulfillment existe" "t" "$(sql "select exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='resolve_delivery_fulfillment');")"
assert_eq "get_restaurant_public_delivery_fulfillments existe" "t" "$(sql "select exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_restaurant_public_delivery_fulfillments');")"

assert_eq "resolve_delivery_fulfillment : 4 arguments (p_restaurant_id uuid, p_mode_code text, p_postal_code text, p_total_count integer) -- LOT B.1, FRB-B-01 : p_total_count ajouté pour appliquer réellement min_items" "p_restaurant_id uuid, p_mode_code text, p_postal_code text, p_total_count integer" "$(sql "select pg_get_function_identity_arguments(oid) from pg_proc where proname='resolve_delivery_fulfillment';")"
assert_eq "resolve_delivery_fulfillment : retourne bien les colonnes eligible/block/missing/matched_prefix (contrat corrigé LOT B.1)" "TABLE(eligible boolean, fulfillment_code text, provider text, matched_prefix text, zone_prefixes text[], is_fallback boolean, min_items integer, customer_text text, display_order integer, block text, missing integer)" "$(sql "select pg_get_function_result(oid) from pg_proc where proname='resolve_delivery_fulfillment';")"
assert_eq "get_restaurant_public_delivery_fulfillments : 1 argument (p_restaurant_id uuid)" "p_restaurant_id uuid" "$(sql "select pg_get_function_identity_arguments(oid) from pg_proc where proname='get_restaurant_public_delivery_fulfillments';")"

assert_eq "resolve_delivery_fulfillment est SECURITY DEFINER" "t" "$(sql "select prosecdef from pg_proc where proname='resolve_delivery_fulfillment';")"
assert_eq "get_restaurant_public_delivery_fulfillments est SECURITY DEFINER" "t" "$(sql "select prosecdef from pg_proc where proname='get_restaurant_public_delivery_fulfillments';")"

assert_eq "resolve_delivery_fulfillment a search_path figé à ''" "t" "$(sql "select proconfig::text like '%search_path=%' from pg_proc where proname='resolve_delivery_fulfillment';")"
assert_eq "get_restaurant_public_delivery_fulfillments a search_path figé à ''" "t" "$(sql "select proconfig::text like '%search_path=%' from pg_proc where proname='get_restaurant_public_delivery_fulfillments';")"

assert_eq "get_restaurant_public_delivery_fulfillments ne référence jamais provider ni config dans sa définition (recherche brute)" "f" "$(sql "select (pg_get_functiondef(oid) ilike '%provider%' or pg_get_functiondef(oid) ilike '%.config%') from pg_proc where proname='get_restaurant_public_delivery_fulfillments';")"

# ==================================================================
# Tenants + données de test (jamais insérées par le DRAFT lui-même —
# uniquement par ce harnais, dans une base jetable)
# ==================================================================
ILLICO_ID=$(sql "select id from restaurants where slug='illico-presto';")
SANAA_ID=$(sql "select id from restaurants where slug='sanaa-cookies';")
SIROCCO_ID=$(sql "select id from restaurants where slug='le-sirocco';")

assert_eq "prérequis : sanaa a bien restaurant_sale_modes(delivery, enabled=true)" "t" "$(sql "select enabled from restaurant_sale_modes where restaurant_id='$SANAA_ID' and mode_code='delivery';")"
assert_eq "prérequis : le-sirocco n'a PAS de mode delivery (tenant table-only, pour le scénario 'mode parent absent')" "f" "$(sql "select exists(select 1 from restaurant_sale_modes where restaurant_id='$SIROCCO_ID' and mode_code='delivery');")"

# Sanaa : 2 règles non-fallback ordonnées + 1 fallback -- même forme
# que la configuration cible Au Lait Cru documentée en §12 du rapport
# de conception (jamais les valeurs Au Lait Cru elles-mêmes, tenant
# générique de test uniquement).
sql "insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, zone_prefixes, is_fallback, min_items, customer_text, display_order) values
  ('$SANAA_ID','delivery','local_delivery_75','internal', array['75'], false, 5, 'Livraison locale le jour même', 0),
  ('$SANAA_ID','delivery','local_delivery_92','internal', array['92','93'], false, 8, null, 1),
  ('$SANAA_ID','delivery','wide_shipping','other_external', array[]::text[], true, 10, 'Expédition sous 48h', 2);
" >/dev/null

# ==================================================================
# RÉSOLVEUR INTERNE — algorithme (§4/§9, contrat corrigé LOT B.1),
# appelé directement (connexion propriétaire) — même méthode que
# effective_sale_mode_field_requirements avant d'avoir un appelant
# réel. Signature à 4 arguments désormais (p_total_count ajouté,
# FRB-B-01) ; retourne TOUJOURS exactement 1 ligne (eligible/block/
# missing portent la décision).
# ==================================================================

R1=$(sql "select fulfillment_code, provider, is_fallback, min_items, eligible, block from public.resolve_delivery_fulfillment('$SANAA_ID','delivery','75001',5);")
assert_eq "code postal 75001, quantité 5 (>= min 5) -- résout la règle 75 (non-fallback, display_order=0), eligible=true" "local_delivery_75|internal|f|5|t|" "$R1"

R1B=$(sql "select fulfillment_code, eligible, block, missing from public.resolve_delivery_fulfillment('$SANAA_ID','delivery','75001',2);")
assert_eq "code postal 75001, quantité 2 (< min 5) -- FRB-B-01 : min_items EST DÉSORMAIS RÉELLEMENT APPLIQUÉ -- eligible=false, block=below-min, missing=3, mais la règle reste identifiée" "local_delivery_75|f|below-min|3" "$R1B"

R2=$(sql "select fulfillment_code, provider, is_fallback, min_items, eligible from public.resolve_delivery_fulfillment('$SANAA_ID','delivery','92100',8);")
assert_eq "code postal 92100, quantité 8 (>= min 8) -- résout la règle 92/93 (non-fallback, display_order=1), eligible=true" "local_delivery_92|internal|f|8|t" "$R2"

R3=$(sql "select fulfillment_code, provider, is_fallback, min_items, eligible from public.resolve_delivery_fulfillment('$SANAA_ID','delivery','13001',10);")
assert_eq "code postal 13001 (aucune zone non-fallback), quantité 10 (>= min fallback 10) -- résout le fallback (wide_shipping), eligible=true" "wide_shipping|other_external|t|10|t" "$R3"

assert_eq "resolve_delivery_fulfillment retourne bien customer_text de la règle résolue (75)" "Livraison locale le jour même" "$(sql "select customer_text from public.resolve_delivery_fulfillment('$SANAA_ID','delivery','75001',5);")"
assert_eq "resolve_delivery_fulfillment retourne customer_text NULL si la règle résolue n'en a pas (92)" "" "$(sql "select coalesce(customer_text,'') from public.resolve_delivery_fulfillment('$SANAA_ID','delivery','92100',8);")"

assert_eq "mode parent (delivery) NON activé pour ce tenant -- TOUJOURS exactement 1 ligne (contrat corrigé LOT B.1), eligible=false, fulfillment_code NULL, block=out-of-zone" "|f|out-of-zone" "$(sql "update restaurant_sale_modes set enabled=false where restaurant_id='$SANAA_ID' and mode_code='delivery'; select coalesce(fulfillment_code,''), eligible, block from public.resolve_delivery_fulfillment('$SANAA_ID','delivery','75001',5);")"
sql "update restaurant_sale_modes set enabled=true where restaurant_id='$SANAA_ID' and mode_code='delivery';" >/dev/null

assert_eq "règle désactivée (enabled=false) individuellement -- exclue de la résolution -- aucune autre règle non-fallback ne matche '75001' (92/93 seulement), retombe correctement sur le fallback" "wide_shipping" "$(sql "update restaurant_sale_mode_fulfillments set enabled=false where restaurant_id='$SANAA_ID' and fulfillment_code='local_delivery_75'; select fulfillment_code from public.resolve_delivery_fulfillment('$SANAA_ID','delivery','75001',10);" | tail -1)"
assert_eq "règle désactivée (enabled=false) -- preuve complémentaire : avec une AUTRE règle non-fallback qui matche aussi (92), c'est bien elle qui prend le relais, jamais la désactivée" "local_delivery_92" "$(sql "select fulfillment_code from public.resolve_delivery_fulfillment('$SANAA_ID','delivery','92100',8);")"
sql "update restaurant_sale_mode_fulfillments set enabled=true where restaurant_id='$SANAA_ID' and fulfillment_code='local_delivery_75';" >/dev/null

assert_eq "mode parent absent (aucune ligne restaurant_sale_modes pour ce mode) -- TOUJOURS 1 ligne, eligible=false, jamais une exception" "f|out-of-zone" "$(sql "select eligible, block from public.resolve_delivery_fulfillment('$SIROCCO_ID','delivery','75001',5);")"

assert_eq "tenant sans aucune règle de fulfillment -- TOUJOURS 1 ligne, eligible=false (même si le mode parent existe et est activé)" "f|out-of-zone" "$(sql "select eligible, block from public.resolve_delivery_fulfillment('$ILLICO_ID','pickup','75001',5);")"

assert_eq "FRB-B-01 (CORRIGÉ) : code postal NULL -- refusé IMMÉDIATEMENT, block=no-postal, AUCUNE règle retenue -- même le fallback pourtant présent et éligible ne s'applique PLUS (avant correction : le fallback s'appliquait quand même, divergence avec le frontend)" "|f|no-postal" "$(sql "select coalesce(fulfillment_code,''), eligible, block from public.resolve_delivery_fulfillment('$SANAA_ID','delivery',null,5);")"
assert_eq "FRB-B-01 (CORRIGÉ) : code postal chaîne vide -- même traitement que NULL, block=no-postal, aucune règle retenue" "|f|no-postal" "$(sql "select coalesce(fulfillment_code,''), eligible, block from public.resolve_delivery_fulfillment('$SANAA_ID','delivery','',5);")"
assert_eq "FRB-B-01 (CORRIGÉ) : code postal espaces uniquement -- après trim, vide -- même traitement, block=no-postal" "|f|no-postal" "$(sql "select coalesce(fulfillment_code,''), eligible, block from public.resolve_delivery_fulfillment('$SANAA_ID','delivery','   ',5);")"
assert_eq "moteur GÉNÉRIQUE (aucune validation de format France-specific) : code postal non-standard 'abc' N'EST PAS 'no-postal' -- ne matche simplement aucun préfixe, retombe sur le fallback normalement" "wide_shipping|t|" "$(sql "select fulfillment_code, eligible, coalesce(block,'') from public.resolve_delivery_fulfillment('$SANAA_ID','delivery','abc',10);")"

assert_eq "sans AUCUN fallback configuré -- code postal hors zone -- TOUJOURS 1 ligne, eligible=false, block=out-of-zone (mode non éligible pour cette adresse)" "f|out-of-zone" "$(sql "update restaurant_sale_mode_fulfillments set enabled=false where restaurant_id='$SANAA_ID' and fulfillment_code='wide_shipping'; select eligible, block from public.resolve_delivery_fulfillment('$SANAA_ID','delivery','13001',10);")"
sql "update restaurant_sale_mode_fulfillments set enabled=true where restaurant_id='$SANAA_ID' and fulfillment_code='wide_shipping';" >/dev/null

assert_eq "p_total_count NULL traité défensivement comme 0 (jamais une éligibilité optimiste par accident de logique ternaire SQL) -- refusé, missing=5" "f|below-min|5" "$(sql "select eligible, block, missing from public.resolve_delivery_fulfillment('$SANAA_ID','delivery','75001',null);")"

# Sirocco (table-only par défaut, aucun mode delivery) sert de tenant
# ISOLÉ pour ce scénario -- évite toute interférence avec les 3 lignes
# Sanaa ci-dessus. Le mode delivery est activé ICI, explicitement, par
# CE harnais (jamais par le DRAFT lui-même) -- prérequis de la FK
# composite de LOT A.
sql "insert into restaurant_sale_modes (restaurant_id, mode_code, enabled, display_order) values ('$SIROCCO_ID','delivery',true,9);" >/dev/null
assert_eq "ordre de résolution piloté EXPLICITEMENT par display_order -- pas par la longueur/spécificité du préfixe (75 et 750 chevauchants, la règle en display_order=0 gagne)" "specific_first|750" "$(sql "
  insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, zone_prefixes, display_order) values ('$SIROCCO_ID','delivery','specific_first','internal',array['750'],0), ('$SIROCCO_ID','delivery','generic_second','internal',array['75'],1);
  select fulfillment_code, matched_prefix from public.resolve_delivery_fulfillment('$SIROCCO_ID','delivery','75012',0);
")"
# NOTE : les 2 lignes insérées ci-dessus (specific_first/generic_second)
# restent EN PLACE pour Sirocco -- la section "RPC PUBLIQUE" ci-dessous
# les lit encore (assertion "règles delivery de Sirocco ... bien
# visibles"). Le nettoyage n'intervient qu'après, juste avant la
# section FIXTURE COMMUNE, pour ne pas lui laisser un état parasite.

# ==================================================================
# RPC PUBLIQUE — projection, invariant double enabled, filtrage actif
# ==================================================================

assert_eq "RPC publique -- 3 lignes pour sanaa (les 2 non-fallback + le fallback), ordonnées par display_order" "local_delivery_75,local_delivery_92,wide_shipping" "$(sql "select string_agg(fulfillment_code, ',' order by display_order) from public.get_restaurant_public_delivery_fulfillments('$SANAA_ID');")"

assert_eq "RPC publique -- ne retourne JAMAIS provider ni config (signature de retour textuelle, aucune trace des deux colonnes internes)" "TABLE(fulfillment_code text, zone_prefixes text[], is_fallback boolean, min_items integer, customer_text text, display_order integer)" "$(sql "select pg_get_function_result(oid) from pg_proc where proname='get_restaurant_public_delivery_fulfillments';")"

assert_eq "RPC publique -- mode delivery désactivé pour ce tenant -- aucune ligne (invariant double enabled, moitié 1)" "0" "$(sql "update restaurant_sale_modes set enabled=false where restaurant_id='$SANAA_ID' and mode_code='delivery'; select count(*) from public.get_restaurant_public_delivery_fulfillments('$SANAA_ID');")"
sql "update restaurant_sale_modes set enabled=true where restaurant_id='$SANAA_ID' and mode_code='delivery';" >/dev/null

assert_eq "RPC publique -- règle individuelle désactivée -- exclue seule, les autres restent visibles (invariant double enabled, moitié 2)" "local_delivery_92,wide_shipping" "$(sql "update restaurant_sale_mode_fulfillments set enabled=false where restaurant_id='$SANAA_ID' and fulfillment_code='local_delivery_75'; select string_agg(fulfillment_code, ',' order by display_order) from public.get_restaurant_public_delivery_fulfillments('$SANAA_ID');")"
sql "update restaurant_sale_mode_fulfillments set enabled=true where restaurant_id='$SANAA_ID' and fulfillment_code='local_delivery_75';" >/dev/null

assert_eq "RPC publique -- établissement suspendu -- aucune ligne, même avec des règles enabled" "0" "$(sql "update restaurants set status='suspended' where id='$SANAA_ID'; select count(*) from public.get_restaurant_public_delivery_fulfillments('$SANAA_ID');")"
sql "update restaurants set status='active' where id='$SANAA_ID';" >/dev/null

assert_eq "RPC publique -- établissement inactif (is_active=false) -- aucune ligne" "0" "$(sql "update restaurants set is_active=false where id='$SANAA_ID'; select count(*) from public.get_restaurant_public_delivery_fulfillments('$SANAA_ID');")"
sql "update restaurants set is_active=true where id='$SANAA_ID';" >/dev/null

sql "insert into restaurant_sale_mode_fulfillments (restaurant_id, mode_code, fulfillment_code, provider, display_order) values ('$ILLICO_ID','pickup','counter_pickup_test','internal',0);" >/dev/null
assert_eq "RPC publique -- filtrée sur mode_code='delivery' -- une règle 'pickup' existante (Illico) n'apparaît jamais ici, même appelée sur ce même tenant" "0" "$(sql "select count(*) from public.get_restaurant_public_delivery_fulfillments('$ILLICO_ID');" )"
assert_eq "RPC publique -- règles delivery de Sirocco (insérées pour le test d'ordre ci-dessus) bien visibles (mode filtré = delivery)" "2" "$(sql "select count(*) from public.get_restaurant_public_delivery_fulfillments('$SIROCCO_ID');")"

sql "delete from restaurant_sale_mode_fulfillments where restaurant_id='$SIROCCO_ID' and mode_code='delivery';" >/dev/null

# ==================================================================
# FIXTURE COMMUNE — preuve de déterminisme SQL/frontend (FRB-B-02).
#
# tests/fixtures/fulfillment-routing-cases.json est LA source de
# vérité unique. generate-fulfillment-lot-b1-fixture-checks.mjs la lit
# et émet le SQL ci-dessous exécuté ; tests/v97-fulfillment-routing-
# lot-b1-determinism.test.ts lit LE MÊME fichier côté npm test. Ce
# n'est donc PAS une resynchronisation manuelle entre deux suites qui
# se ressemblent : c'est la MÊME fixture, rejouée par deux moteurs.
#
# Sirocco (juste réinitialisé ci-dessus) sert de tenant scratch pour
# cette section -- chaque cas nettoie ses propres données avant de
# s'exécuter (voir le générateur), aucune interférence possible avec
# les sections précédentes de ce harnais (RPC publique, résolveur
# direct) qui ont déjà lu tout ce dont elles avaient besoin.
# ==================================================================
FIXTURE_JSON="$ROOT/tests/fixtures/fulfillment-routing-cases.json"
GENERATOR="$SUPABASE_DIR/tests/generate-fulfillment-lot-b1-fixture-checks.mjs"
FIXTURE_SQL="/tmp/scanym-frb1-fixture-checks-$$.sql"

assert_eq "le générateur de fixture existe" "t" "$([ -f "$GENERATOR" ] && echo t || echo f)"
node "$GENERATOR" "$FIXTURE_JSON" "$SIROCCO_ID" "delivery" > "$FIXTURE_SQL"

FIXTURE_CASE_COUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$FIXTURE_JSON','utf8')).cases.length)")
log "Fixture commune : $FIXTURE_CASE_COUNT cas générés depuis $FIXTURE_JSON"

FIXTURE_OUT=$(psql -X -A -q -t -d "$DB" -f "$FIXTURE_SQL")
FIXTURE_LINE_COUNT=$(echo "$FIXTURE_OUT" | grep -c '|' || true)
assert_eq "le script généré produit exactement 1 ligne de résultat par cas de la fixture ($FIXTURE_CASE_COUNT attendues)" "$FIXTURE_CASE_COUNT" "$FIXTURE_LINE_COUNT"

# Délimiteur '|', caractère UNIQUE -- IFS bash traite chaque caractère
# comme un séparateur indépendant (pas de délimiteur multi-caractères
# possible), un ancien délimiteur '@@' aurait produit des champs vides
# parasites entre les deux '@'. `actual` récupère tout le reste de la
# ligne (le JSON peut légitimement contenir des ':'/','), jamais
# retronqué.
while IFS='|' read -r case_id passed actual; do
  [ -z "$case_id" ] && continue
  if [ "$passed" = "t" ]; then
    pass "FIXTURE[$case_id]: SQL produit exactement le résultat attendu (identique au contrat frontend)"
  else
    fail "FIXTURE[$case_id]: SQL diverge du résultat attendu -- obtenu $actual"
  fi
done <<< "$FIXTURE_OUT"

rm -f "$FIXTURE_SQL"
sql "delete from restaurant_sale_mode_fulfillments where restaurant_id='$SIROCCO_ID' and mode_code='delivery'; update restaurant_sale_modes set enabled=true where restaurant_id='$SIROCCO_ID' and mode_code='delivery';" >/dev/null

# ==================================================================
# ACL — matrice complète pour les DEUX nouvelles routines
# ==================================================================

assert_eq "has_function_privilege(anon, resolve_delivery_fulfillment, EXECUTE) = false" "f" "$(sql "select has_function_privilege('anon', 'public.resolve_delivery_fulfillment(uuid,text,text,integer)', 'EXECUTE');")"
assert_eq "has_function_privilege(authenticated, resolve_delivery_fulfillment, EXECUTE) = false" "f" "$(sql "select has_function_privilege('authenticated', 'public.resolve_delivery_fulfillment(uuid,text,text,integer)', 'EXECUTE');")"
assert_eq "has_function_privilege(public, resolve_delivery_fulfillment, EXECUTE) = false" "f" "$(sql "select has_function_privilege('public', 'public.resolve_delivery_fulfillment(uuid,text,text,integer)', 'EXECUTE');")"

assert_eq "has_function_privilege(anon, get_restaurant_public_delivery_fulfillments, EXECUTE) = true" "t" "$(sql "select has_function_privilege('anon', 'public.get_restaurant_public_delivery_fulfillments(uuid)', 'EXECUTE');")"
assert_eq "has_function_privilege(authenticated, get_restaurant_public_delivery_fulfillments, EXECUTE) = true" "t" "$(sql "select has_function_privilege('authenticated', 'public.get_restaurant_public_delivery_fulfillments(uuid)', 'EXECUTE');")"
assert_eq "has_function_privilege(public, get_restaurant_public_delivery_fulfillments, EXECUTE) = false" "f" "$(sql "select has_function_privilege('public', 'public.get_restaurant_public_delivery_fulfillments(uuid)', 'EXECUTE');")"

# Preuve RÉELLE (pas seulement le bit ACL) : anon ne peut pas appeler
# le résolveur interne directement -- même patron que le harnais LOT
# 2A (BYPASS_ANON).
BYPASS_ANON=$(PGOPTIONS='-c role=anon' psql -d "$DB" -c "select * from public.resolve_delivery_fulfillment('$SANAA_ID','delivery','75001',5);" 2>&1 | grep -c "permission denied" || true)
assert_eq "anon ne peut pas appeler directement resolve_delivery_fulfillment (permission denied réelle)" "1" "$BYPASS_ANON"

BYPASS_AUTH=$(psql -d "$DB" -c "set role authenticated; select * from public.resolve_delivery_fulfillment('$SANAA_ID','delivery','75001',5);" 2>&1 | grep -c "permission denied" || true)
assert_eq "authenticated ne peut pas appeler directement resolve_delivery_fulfillment (permission denied réelle)" "1" "$BYPASS_AUTH"

# Preuve RÉELLE que la RPC publique, elle, fonctionne pour anon.
ANON_RPC_COUNT=$(sql_as anon "select count(*) from public.get_restaurant_public_delivery_fulfillments('$SANAA_ID');")
assert_eq "anon peut réellement appeler get_restaurant_public_delivery_fulfillments et obtenir les lignes attendues" "3" "$ANON_RPC_COUNT"

# ==================================================================
# ADDITIVITÉ STRICTE (preuve, pas seulement documentée)
# ==================================================================

BEFORE_TABLES_COMPARABLE=$(echo "$BEFORE_TABLES" | tr '|' '\n' | grep -v '^restaurant_sale_mode_fulfillments:' | grep -v '^restaurant_sale_modes:' | paste -sd'|' -)
AFTER_TABLES_COMPARABLE=$(sql "select string_agg(tablename || ':' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', schemaname, tablename), false, true, '')))[1]::text, '|' order by tablename) from pg_tables where schemaname='public' and tablename not in ('restaurant_sale_mode_fulfillments','restaurant_sale_modes');")
# restaurant_sale_mode_fulfillments (données de test insérées par CE
# harnais, jamais par le DRAFT) ET restaurant_sale_modes (une ligne
# delivery ajoutée pour Sirocco, par CE harnais, pour satisfaire la FK
# composite du scénario de chevauchement de préfixes ci-dessus) sont
# les deux SEULES tables que ce harnais lui-même mute -- exclues ici
# à raison, pas pour masquer une régression. Le fichier DRAFT B
# lui-même ne contient aucun INSERT/UPDATE (preuve textuelle séparée
# plus bas) : c'est le harnais de test, jamais le DRAFT, qui insère
# ces données de fixture.
assert_eq "aucune AUTRE table préexistante n'a de cardinalité modifiée par le DRAFT B lui-même" "$BEFORE_TABLES_COMPARABLE" "$AFTER_TABLES_COMPARABLE"

AFTER_ROUTINES=$(sql "select string_agg(proname, ',' order by proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public';")
NEW_ROUTINES=$(comm -13 <(echo "$BEFORE_ROUTINES" | tr ',' '\n' | sort) <(echo "$AFTER_ROUTINES" | tr ',' '\n' | sort) | paste -sd, -)
assert_eq "ce lot ajoute EXACTEMENT 2 routines publiques (resolve_delivery_fulfillment, get_restaurant_public_delivery_fulfillments), aucune autre" "get_restaurant_public_delivery_fulfillments,resolve_delivery_fulfillment" "$NEW_ROUTINES"

assert_eq "aucune table n'a été ajoutée ni supprimée par le DRAFT B (même jeu de tables avant/après)" "t" "$(sql "select (select count(*) from pg_tables where schemaname='public') = (select count(*) from pg_tables where schemaname='public');")"

assert_eq "le DRAFT B ne contient AUCUNE instruction INSERT INTO (aucune donnée tenant)" "0" "$(grep -ci '^\s*insert into' "$DRAFT_B_SQL" || true)"

assert_eq "le DRAFT B ne modifie AUCUNE des colonnes/contraintes de restaurant_sale_mode_fulfillments (aucun ALTER TABLE)" "0" "$(grep -ci 'alter table.*restaurant_sale_mode_fulfillments' "$DRAFT_B_SQL" || true)"

assert_eq "le DRAFT B ne référence jamais Stuart/Chronofresh par un appel réseau (aucune extension http/net, aucune URL)" "0" "$(grep -ciE 'http_post|http_get|pg_net|https?://' "$DRAFT_B_SQL" || true)"

echo "----------------------------------------------------------"
log "PASS=$PASS_COUNT FAIL=$FAIL_COUNT"
if [ "$FAIL_COUNT" -eq 0 ]; then
  log "TOUS LES TESTS PASSENT ($PASS_COUNT/$PASS_COUNT)"
  exit 0
else
  log "ÉCHECS ($FAIL_COUNT) :"
  cat "$FAIL_LOG"
  exit 1
fi
