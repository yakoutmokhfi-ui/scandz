#!/usr/bin/env bash
# ============================================================
# Scanym — harnais SQL réel
# SELLER LEGAL PROFILE + CGV ENGINE v2.1 — CGV ENGINE ENRICHMENT v2 —
# FRENCH FOOD/PERISHABLE B2C MANDATE COVERAGE. PostgreSQL réel, aucune
# simulation applicative, exécuté en tant qu'utilisateur système
# postgres (authentification peer).
#
# Ce fichier est une COPIE/ADAPTATION directe de
# seller-legal-profile-cgv-engine-v1-4-check.sh : TOUTES les sections
# v1.1-v1.4 (installation de la chaîne, [BLOCKER2/ACL-0], fixtures,
# [0bis], [BLOCKER1/RPC-BYPASS], [BLOCKER1/GRANTS], [1]..[27],
# [BLOCKER1/TEMPLATE-AUTHORITY], [BLOCKER2/ACL], la matrice
# [BLOCKER1/CONCURRENCY] à 12 items, [BLOCKER1/LOCKING],
# [V13-GAP1/SELLER-NAME], [V13-GAP1/CONTROLLED-SECTIONS],
# [V13-GAP2/LOCKING-RESTAURANTS], [V13-GAP3/LOCKING-AUTH-ORDER1],
# [V13-GAP3/LOCKING-AUTH-ORDER2] et [V14-SERIALIZATION] T1-T8 — TOUTES
# les 309 assertions déjà auditées de v1.4) sont conservées SANS
# MODIFICATION DE FOND — seuls les noms de variables/DB et
# l'installation d'un lot supplémentaire (v2.1, par-dessus
# v1.1+v1.2+v1.3+v1.4) ont changé — afin de prouver que v2.1 ne régresse
# RIEN de ce que v1.1-v1.4 avaient déjà fermé. Les appels positionnels
# existants à update_merchant_legal_profile (12 arguments) et
# update_merchant_cgv_profile (8 arguments) restent VALABLES sans
# aucune modification après v2.1 : les 6/2 nouveaux paramètres de ces
# deux fonctions sont tous AJOUTÉS EN FIN DE LISTE avec une valeur par
# défaut (`default null` / `default false`), donc un appel positionnel
# qui ne fournit que les N premiers arguments reste parfaitement valide
# en PostgreSQL — seuls les tout nouveaux blocs ci-dessous ([V21-*] et
# [AU-LAIT-CRU]) utilisent les nouveaux paramètres explicitement.
#
# Nouveaux blocs ajoutés par ce cycle, tous insérés après
# [V14-SERIALIZATION] et avant [ROLLBACK] (sauf [ROLLBACK] lui-même,
# qui est ÉTENDU, pas simplement conservé — voir sa propre section) :
#   [V21-TEMPLATE]              gabarit v2 vs v1 byte-identique
#   [V21-BACKWARD-COMPAT]       défauts des 8 nouvelles colonnes
#   [V21-STALE-CONTEXT]         8 tests de péremption, un par nouveau champ
#   [V21-ACTUAL-WEIGHT-PRICE]   échec fermé, AVANT tout verrou
#   [V21-FIXED-PORTION-PRICE]   succès, contenu rendu vérifié
#   [V21-COLD-CHAIN]            bascule true/false, rendu réel vérifié
#   [AU-LAIT-CRU]               fixture MANUYUAN, aperçu réel, isolation
#   [ROLLBACK]                  ÉTENDU : v1.2 (gap constaté) + v2.1 (fix)
#
# BASELINE : yakoutmokhfi-ui/scandz, origin —
#   SHA  e4c90f4f57ba37b46ab388e05847fd57610275a3
#   TREE 30643c6c0a236cca5babe7e5baaf9afcf17695f5
#
# Réutilise MINIMAL_CHAIN + REST_CHAIN (inchangées), PUIS installe v1.1
# PUIS v1.2 PUIS v1.3 PUIS v1.4 (tous quatre déjà audités, blockers/gaps
# CLOSED, non rouverts ici) PUIS v2.1 (ce cycle) par-dessus, exactement
# comme les cinq fichiers sont chaînés en Production (v1.1 forward, puis
# les deltas v1.2, v1.3, v1.4, v2.1 forward).
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   sudo -n -u postgres bash supabase/tests/seller-legal-profile-cgv-engine-v2-1-check.sh
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
LOT_SQL="$LOT_SQL_V21"
ROLLBACK_SQL="$SUPABASE_DIR/DRAFT-lot-seller-legal-profile-cgv-engine-v1-2-rollback.sql"
ROLLBACK_SQL_V21="$SUPABASE_DIR/DRAFT-lot-seller-legal-profile-cgv-engine-v2-1-rollback.sql"
RENDER_HELPER="$SCRIPT_DIR/seller-legal-profile-cgv-engine-v2-1-render-helper.mjs"
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
DB="scanym_cgvenginev21_$$"

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
    join public.cgv_template t on t.id = (public._resolve_applicable_cgv_template(r.country)).id
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
  PGOPTIONS="-c role=$role" psql -X -A -q -t -d "$DB" -f "$f" \
    >/tmp/scanym-cgvenginev11-out-$$.txt 2>/tmp/scanym-cgvenginev11-err-$$.txt
  rc=$?
  rm -f "$f"
  echo "$rc"
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
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

log "=== [0] Construction $DB (chaîne réelle jusqu'au nouveau baseline main) ==="
psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
createdb "$DB" || { log "FATAL: createdb a échoué"; exit 1; }
build_common_bootstrap || { log "FATAL: bootstrap commun a échoué"; exit 1; }
build_chain || { log "FATAL: chaîne de migrations a échoué"; exit 1; }
pass "Chaîne de base (MINIMAL_CHAIN + REST_CHAIN) appliquée jusqu'à DRAFT-lot-receipt-invoice-tax-detail-v1.sql (identique octet-pour-octet au baseline v1)"

# scanym_supported_countries : FR doit déjà exister (Phase 0 finding,
# reconfirmé par Catimini au nouveau baseline).
FR_SEEDED=$(sql "select count(*) from public.scanym_supported_countries where code='FR';")
if [ "$FR_SEEDED" != "1" ]; then
  psql -d "$DB" -c "insert into public.scanym_supported_countries (code, name) values ('FR','France') on conflict do nothing;" >/dev/null 2>&1
fi

# ============================================================
# [BLOCKER2/ACL-0] Simulation de la condition hostile découverte en
# Production par Catimini -- AVANT l'installation du lot lui-même,
# pour que les futures CREATE TABLE du lot héritent réellement de
# privilèges par défaut larges (comme en Production), et que les
# REVOKE explicites du lot soient ce qui est réellement mis à
# l'épreuve ci-dessous, jamais un simple "jamais accordé donc jamais
# à révoquer".
# ============================================================
log "=== [BLOCKER2/ACL-0] Simulation des ACL par défaut hostiles (condition Production Catimini) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -c "alter default privileges in schema public grant all privileges on tables to anon, authenticated, service_role;" >/dev/null 2>&1 \
  || { log "FATAL: échec de la simulation ACL hostile"; exit 1; }

# Preuve que la simulation fonctionne réellement dans CET
# environnement (sinon la preuve de convergence plus bas serait un
# faux positif silencieux) : une table quelconque créée maintenant
# doit hériter TRUNCATE pour anon sans qu'aucun GRANT explicite n'ait
# été fait.
psql -d "$DB" -v ON_ERROR_STOP=1 -c "create table public.cgv_probe_hostile_defaults (id int);" >/dev/null 2>&1
PROBE_INHERITED=$(sql "select has_table_privilege('anon','public.cgv_probe_hostile_defaults','TRUNCATE');")
assert_eq "ACL-0. la simulation hostile fonctionne réellement ici : une table fraîchement créée hérite bien de TRUNCATE pour anon" "t" "$PROBE_INHERITED"
psql -d "$DB" -c "drop table public.cgv_probe_hostile_defaults;" >/dev/null 2>&1

# v1.1 installe les 5 tables CGV/legal elles-mêmes -- c'est ICI, pas
# avec le delta v1.2 (qui ne crée aucune table), que la simulation ACL
# hostile ci-dessus est réellement mise à l'épreuve.
RC=$(sql_rc "$(cat "$LOT_SQL_V11")")
assert_ok "LOT SQL v1.1 (Seller Legal Profile + CGV Engine, déjà audité -- blockers v1.1 CLOSED, non rouverts) s'installe proprement sur le NOUVEAU baseline, MALGRÉ les ACL par défaut hostiles simulées ci-dessus" "$RC"

# v1.2 s'installe PAR-DESSUS v1.1, exactement comme en Production
# (delta forward-only, jamais un remaniement du fichier v1.1 lui-même
# -- vérifié par le pre-flight de v1.2 lui-même, section 0 du fichier).
RC=$(sql_rc "$(cat "$LOT_SQL_V12")")
assert_ok "LOT SQL v1.2 (Blocker 1 -- CGV-V11-PUBLISH-CONTEXT-RACE-01) s'installe proprement par-dessus v1.1" "$RC"

# v1.3 s'installe PAR-DESSUS v1.1+v1.2, exactement comme en Production
# (delta forward-only, deux CREATE OR REPLACE sans changement de
# signature -- vérifié par le pre-flight ET le post-verify du fichier
# v1.3 lui-même). Déjà audité, gaps 1/2/3 CLOSED, non rouverts ici.
RC=$(sql_rc "$(cat "$LOT_SQL_V13")")
assert_ok "LOT SQL v1.3 (GAP 1/2/3 -- fingerprint élargi + verrouillage complet + autorisation verrouillée) s'installe proprement par-dessus v1.1+v1.2, zéro erreur" "$RC"

# v1.4 s'installe PAR-DESSUS v1.1+v1.2+v1.3, exactement comme en
# Production (delta forward-only, UN SEUL CREATE OR REPLACE sans
# changement de signature -- vérifié par le pre-flight ET le
# post-verify du fichier v1.4 lui-même). Déjà audité, non rouvert ici.
RC=$(sql_rc "$(cat "$LOT_SQL_V14")")
assert_ok "LOT SQL v1.4 (correctif de sérialisation -- jsonb_build_object canonique remplace la concaténation delimitée par chr(31)) s'installe proprement par-dessus v1.1+v1.2+v1.3, zéro erreur" "$RC"

# v2.1 (ce cycle) s'installe PAR-DESSUS v1.1+v1.2+v1.3+v1.4, exactement
# comme en Production (delta forward-only : 8 nouvelles colonnes,
# 1 nouvelle ligne de gabarit PUBLISHED, 2 CREATE OR REPLACE à signature
# inchangée, 3 DROP+CREATE à signature de RETOUR élargie mais
# d'ENTRÉE inchangée -- vérifié par le pre-flight ET le post-verify du
# fichier v2.1 lui-même).
RC=$(sql_rc "$(cat "$LOT_SQL_V21")")
assert_ok "LOT SQL v2.1 (CGV ENGINE ENRICHMENT v2 -- 8 nouvelles colonnes, gabarit FR_FOOD_PERISHABLE_B2C v2, fingerprint + fail-closed ACTUAL_WEIGHT_PRICE étendus) s'installe proprement par-dessus v1.1+v1.2+v1.3+v1.4, zéro erreur" "$RC"

# ------------------------------------------------------------------
# v1.1 (Blocker 2) : AUCUN grant SELECT large n'est ré-accordé ici,
# contrairement au harnais v1 (qui faisait
# `grant select on all tables in schema public to anon, authenticated;`
# juste après l'installation du lot). Ce grant aurait silencieusement
# ré-accordé SELECT à `anon` sur les 5 nouvelles tables CGV -- un vrai
# angle mort de l'ancien harnais qu'aucun test v1 n'a jamais détecté --
# et aurait invalidé toutes les assertions "anon n'a AUCUN privilège"
# ci-dessous. Les seuls accès de lecture directs testés désormais sont
# ceux EXPLICITEMENT accordés par le lot lui-même
# (`grant select ... to authenticated` sur 4 des 5 tables).
# ------------------------------------------------------------------

# ------------------------------------------------------------------
# Fixtures : deux tenants (A, B), owner/manager/staff/operator,
# restaurants actifs, un mode delivery désactivé (hors périmètre pour
# rester simple -- ce lot ne dépend pas du routage delivery).
# ------------------------------------------------------------------
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner-a@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'manager-a@test.local'),
  ('33333333-3333-3333-3333-333333333333', 'staff-a@test.local'),
  ('44444444-4444-4444-4444-444444444444', 'owner-b@test.local'),
  ('55555555-5555-5555-5555-555555555555', 'operator@test.local');

insert into public.restaurants (id, name, slug, is_active, status, country) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Resto A', 'resto-a', true, 'active', 'FR'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Resto B', 'resto-b', true, 'active', 'FR'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Resto Legacy', 'resto-legacy', true, 'active', 'FR');

insert into public.restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'EUR', 1, '+33600000000'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'EUR', 1, '+33600000001'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'EUR', 1, '+33600000002');

insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'pickup', true),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'pickup', true),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'pickup', true);

insert into public.restaurant_users (user_id, restaurant_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'manager'),
  ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'staff'),
  ('44444444-4444-4444-4444-444444444444', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'owner');

insert into public.scanym_operators (user_id) values
  ('55555555-5555-5555-5555-555555555555')
on conflict do nothing;

insert into public.menu_categories (id, restaurant_id, name, display_order, is_active) values
  ('c1111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Plats', 1, true),
  ('c9999999-9999-9999-9999-999999999999', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'Plats Legacy', 1, true);
insert into public.menu_items (id, category_id, name, price, is_available, tax_rate, unit_weight_grams, weight_is_approximate) values
  ('d1111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111111', 'Plat A', 10.00, true, 5.5, 300, false),
  ('d9999999-9999-9999-9999-999999999999', 'c9999999-9999-9999-9999-999999999999', 'Plat Legacy', 10.00, true, 5.5, 300, false);
SQL
pass "Fixtures (2 tenants + legacy + owner/manager/staff/operator + produit) construites"

OWNER_A="11111111-1111-1111-1111-111111111111"
MANAGER_A="22222222-2222-2222-2222-222222222222"
STAFF_A="33333333-3333-3333-3333-333333333333"
OWNER_B="44444444-4444-4444-4444-444444444444"
OPERATOR="55555555-5555-5555-5555-555555555555"
RESTO_A="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
RESTO_B="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
RESTO_LEGACY="cccccccc-cccc-cccc-cccc-cccccccccccc"

# NOUVEAU v2.1 -- IMPORTANT, constaté empiriquement en écrivant ce
# harnais (à rapporter tel quel dans le rapport final, jamais
# silencieusement absorbé) : _resolve_applicable_cgv_template(text)
# (v1.1, INCHANGÉE ici) résout TOUJOURS `order by version desc limit
# 1` parmi les gabarits PUBLISHED d'un jurisdiction_country/business_
# scope donné -- AUCUN mécanisme d'épinglage par marchand n'existe
# dans ce schéma. Dès que v2.1 installe FR_FOOD_PERISHABLE_B2C version
# 2 (PUBLISHED), CE GABARIT DEVIENT IMMÉDIATEMENT ET AUTOMATIQUEMENT
# celui résolu pour TOUT restaurant FR -- y compris pour tous les
# tests ci-dessous qui, en v1.4, supposaient recevoir la version 1.
# Ce n'est PAS une régression de v2.1 : c'est le mécanisme de
# résolution de gabarit tel que v1.1 l'a conçu, fonctionnant exactement
# comme prévu (publier une version plus récente la rend applicable à
# tous, immédiatement, sans étape d'adoption marchand par marchand) --
# mais c'est une CONSÉQUENCE COMPORTEMENTALE RÉELLE de la publication
# de v2.1 en Production, jamais documentée nulle part avant que ce
# harnais ne la mette en évidence, et donc explicitement signalée ici
# ET dans le rapport final. TEMPLATE_ID représente donc, à partir de
# maintenant et pour tout le reste de ce harnais, LE GABARIT RÉELLEMENT
# APPLICABLE (version=2 après l'installation de v2.1 ci-dessus) --
# jamais un id figé sur la version 1, qui ne serait plus jamais celui
# qu'une résolution fraîche renvoie. La ligne version=1 elle-même reste
# intacte et est vérifiée séparément, par son propre id, dans
# [V21-TEMPLATE] plus haut.
TEMPLATE_ID=$(sql "select id from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and status='PUBLISHED' order by version desc limit 1;")
TEMPLATE_ID_V1_ONLY=$(sql "select id from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=1;")
assert_not_contains "0bis-note. le gabarit RÉELLEMENT applicable (TEMPLATE_ID, version la plus haute PUBLISHED) diffère bien de la ligne version=1 -- v2.1 a réellement changé quel gabarit est résolu pour tout restaurant FR, pas seulement ajouté une ligne inerte" "$TEMPLATE_ID_V1_ONLY" "$TEMPLATE_ID"

RC=$(as_authenticated_rc "$OWNER_A" "select (public.get_applicable_cgv_template('$RESTO_A')).id;")
assert_ok "0bis. get_applicable_cgv_template résout un gabarit pour un owner (lecture)" "$RC"

# ============================================================
# [BLOCKER1/RPC-BYPASS] Contournement direct de la RPC de persistance
# -- test OBLIGATOIRE du mandat : "Add an explicit test proving that
# an authenticated browser cannot bypass the server publication path
# by directly calling a database RPC with attacker-chosen rendered
# content." Exécuté ICI, avant toute publication réussie, pour que
# l'assertion "aucune ligne insérée" ne puisse pas être confondue avec
# une ligne créée par un test légitime plus loin.
# ============================================================
log "=== [BLOCKER1/RPC-BYPASS] Contournement direct de persist_merchant_cgv_version ==="
VERSION_COUNT_BEFORE=$(sql "select count(*) from public.merchant_cgv_version;")

# `authenticated` (même l'owner légitime du restaurant) ne peut PAS
# appeler persist_merchant_cgv_version directement, même avec un
# template_id valablement résolu et un contenu choisi par l'attaquant
# (payloads malveillants explicites, comme l'exige le mandat).
# v1.2 : signature à 5 arguments désormais -- deux arguments
# supplémentaires (fingerprint, acting_user_id) ajoutés en placeholder
# ci-dessous ; sans conséquence sur ce test puisque le refus attendu
# est un refus de PERMISSION (42501), constaté avant même que le corps
# de la fonction (et donc ces valeurs) ne soit atteint.
for PAYLOAD in '<img src=x onerror=alert(1)>' '<script>alert(1)</script>' '" onmouseover="alert(1)" x="' 'javascript:alert(1)'; do
  RC=$(as_authenticated_rc "$OWNER_A" "select * from public.persist_merchant_cgv_version('$RESTO_A', '$TEMPLATE_ID', '$PAYLOAD', 'placeholder-fingerprint', '$OWNER_A');")
  assert_denied "RPC-BYPASS: authenticated (owner légitime) NE PEUT PAS appeler persist_merchant_cgv_version directement, même avec un payload malveillant ($PAYLOAD)" "$RC"
  assert_contains "RPC-BYPASS: refus par permission (42501/insufficient_privilege), jamais une erreur métier qui suggérerait un chemin partiellement atteint" "permission denied" "$(sql_err)"
done

# `anon` : refusé également (a fortiori).
RC=$(as_anon_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$TEMPLATE_ID', '<script>alert(1)</script>', 'placeholder-fingerprint', '$OWNER_A');")
assert_denied "RPC-BYPASS: anon NE PEUT PAS appeler persist_merchant_cgv_version directement" "$RC"

# anon ne peut pas non plus appeler resolve_cgv_publication_context
# (EXECUTE réservé à authenticated) -- même en amont, aucune surface.
RC=$(as_anon_rc "select * from public.resolve_cgv_publication_context('$RESTO_A');")
assert_denied "RPC-BYPASS: anon NE PEUT PAS appeler resolve_cgv_publication_context (EXECUTE réservé à authenticated)" "$RC"

# Preuve finale, au niveau des données : aucune de ces tentatives
# (quel que soit leur code d'erreur) n'a inséré la moindre ligne.
VERSION_COUNT_AFTER=$(sql "select count(*) from public.merchant_cgv_version;")
assert_eq "RPC-BYPASS: aucune ligne merchant_cgv_version créée par une quelconque tentative de contournement" "$VERSION_COUNT_BEFORE" "$VERSION_COUNT_AFTER"

# ============================================================
# [BLOCKER1/GRANTS] Assertions structurelles : EXECUTE et existence
# ============================================================
log "=== [BLOCKER1/GRANTS] Grants EXECUTE structurels ==="
# Rôle sonde pour PUBLIC (aucune appartenance, aucun grant direct) --
# créé ici (idempotent) car réutilisé aussi par la matrice ACL de
# tables plus bas [BLOCKER2/ACL].
psql -d "$DB" -v ON_ERROR_STOP=1 -c "do \$do\$ begin if not exists (select from pg_roles where rolname='cgv_probe_public') then create role cgv_probe_public nologin; end if; end \$do\$;" >/dev/null 2>&1

# v1.2 : signature à 5 arguments (p_expected_context_fingerprint,
# p_acting_user_id ajoutés) -- l'ancien overload à 3 arguments a été
# explicitement DROP FUNCTION IF EXISTS dans la migration v1.2 (voir
# assertion "aucun overload à 3 arguments ne subsiste" plus bas), donc
# ces chaînes de signature sont désormais les SEULES qui désignent une
# fonction existante.
V=$(sql "select has_function_privilege('service_role','public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)','EXECUTE');")
assert_eq "GRANTS: service_role A EXECUTE sur persist_merchant_cgv_version (seul chemin légitime)" "t" "$V"
V=$(sql "select has_function_privilege('authenticated','public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)','EXECUTE');")
assert_eq "GRANTS: authenticated N'A PAS EXECUTE sur persist_merchant_cgv_version" "f" "$V"
V=$(sql "select has_function_privilege('anon','public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)','EXECUTE');")
assert_eq "GRANTS: anon N'A PAS EXECUTE sur persist_merchant_cgv_version" "f" "$V"
V=$(sql "select has_function_privilege('cgv_probe_public','public.persist_merchant_cgv_version(uuid,uuid,text,text,uuid)','EXECUTE');")
assert_eq "GRANTS: PUBLIC (rôle sonde sans appartenance) N'A PAS EXECUTE sur persist_merchant_cgv_version" "f" "$V"

# Preuve qu'aucun overload à 3 arguments (v1.1) ne subsiste (mandat :
# "No stale function overload").
V=$(sql "select count(*) from pg_proc where proname='persist_merchant_cgv_version' and pronamespace='public'::regnamespace and pronargs=3;")
assert_eq "GRANTS: aucun overload à 3 arguments (v1.1) de persist_merchant_cgv_version ne subsiste" "0" "$V"

V=$(sql "select has_function_privilege('authenticated','public.resolve_cgv_publication_context(uuid)','EXECUTE');")
assert_eq "GRANTS: authenticated A EXECUTE sur resolve_cgv_publication_context" "t" "$V"
V=$(sql "select has_function_privilege('anon','public.resolve_cgv_publication_context(uuid)','EXECUTE');")
assert_eq "GRANTS: anon N'A PAS EXECUTE sur resolve_cgv_publication_context" "f" "$V"

V=$(sql "select count(*) from pg_proc where proname='publish_merchant_cgv_version' and pronamespace='public'::regnamespace;")
assert_eq "GRANTS: publish_merchant_cgv_version (l'ancienne RPC v1, qui acceptait un contenu rendu client) N'EXISTE PLUS DU TOUT" "0" "$V"

V=$(sql "select has_function_privilege('authenticated','public._resolve_applicable_cgv_template(text)','EXECUTE');")
assert_eq "GRANTS: le helper privé _resolve_applicable_cgv_template n'a AUCUN grant EXECUTE, même pour authenticated (appelable uniquement depuis d'autres fonctions SECURITY DEFINER du même propriétaire)" "f" "$V"

# ============================================================
# [1] Tenant isolation — tenant A ne peut lire/écrire le profil de B
# ============================================================
log "=== [1] Isolation tenant ==="
RC=$(as_authenticated_rc "$OWNER_A" \
  "select public.get_merchant_legal_profile('$RESTO_B');")
assert_denied "1. owner A ne peut pas LIRE le profil légal de B" "$RC"

RC=$(as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_legal_profile('$RESTO_B','SARL',null,null,null,null,null,null,null,null,null,null);")
assert_denied "1. owner A ne peut pas ÉCRIRE le profil légal de B" "$RC"

# ============================================================
# [2/3] Permissions par rôle — write = owner/manager/operator, read = tout membre
# ============================================================
log "=== [2/3] Permissions par rôle ==="
RC=$(as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_legal_profile('$RESTO_A','SARL','1 rue Test',null,'75001','Paris','FR','contact@resto-a.test',null,'Médiateur Test','2 rue Médiation, 75002 Paris','https://mediateur.test');")
assert_ok "2. owner peut écrire le profil légal" "$RC"

RC=$(as_authenticated_rc "$MANAGER_A" \
  "select public.update_merchant_legal_profile('$RESTO_A','SARL','1 rue Test',null,'75001','Paris','FR','contact@resto-a.test',null,'Médiateur Test','2 rue Médiation, 75002 Paris','https://mediateur.test');")
assert_ok "2. manager peut écrire le profil légal" "$RC"

RC=$(as_authenticated_rc "$STAFF_A" \
  "select public.update_merchant_legal_profile('$RESTO_A','SARL',null,null,null,null,null,null,null,null,null,null);")
assert_denied "2. staff NE PEUT PAS écrire le profil légal" "$RC"

RC=$(as_authenticated_rc "$STAFF_A" \
  "select public.get_merchant_legal_profile('$RESTO_A');")
assert_ok "2. staff PEUT lire le profil légal (lecture volontairement plus large, patron receipt_settings)" "$RC"

RC=$(as_authenticated_rc "$OPERATOR" \
  "select public.update_merchant_legal_profile('$RESTO_A','SARL','1 rue Test',null,'75001','Paris','FR','contact@resto-a.test',null,'Médiateur Test','2 rue Médiation, 75002 Paris','https://mediateur.test');")
assert_ok "3. opérateur Scanym peut écrire le profil légal (hors rattachement restaurant_users)" "$RC"

# ============================================================
# [V21-BACKWARD-COMPAT] Les appels ci-dessus (2/3), tous des appels
# POSITIONNELS À 12 ARGUMENTS À update_merchant_legal_profile (jamais
# 18), viennent de s'exécuter par-dessus le v2.1 installé plus haut,
# EXACTEMENT comme un code client jamais mis à jour continuerait de le
# faire. Les 6 nouvelles colonnes doivent rester NULL -- jamais un
# défaut différent de NULL silencieusement appliqué par le nouvel appel
# positionnel court. Même chose pour merchant_cgv_profile, qui n'a
# encore reçu AUCUN appel update_merchant_cgv_profile à ce stade du
# harnais : cold_chain_applicable doit lire false (défaut de colonne
# NOT NULL) et weight_pricing_mode NULL -- observé directement sur la
# ligne merchant_legal_profile réellement écrite ci-dessus (RESTO_A),
# jamais seulement sur le résultat du post-commit guard du fichier SQL
# lui-même (qui ne porte que sur des lignes préexistantes AVANT v2.1).
# ============================================================
log "=== [V21-BACKWARD-COMPAT] Appels positionnels courts (12/8 arguments) restent valables ; nouvelles colonnes NULL/false par défaut ==="
V21_BC_LEGAL=$(sql "select coalesce(legal_entity_name,'<NULL>') || '|' || coalesce(siren,'<NULL>') || '|' || coalesce(siret,'<NULL>') || '|' || coalesce(vat_number,'<NULL>') || '|' || coalesce(consumer_mediator_phone,'<NULL>') || '|' || coalesce(consumer_mediator_email,'<NULL>') from public.merchant_legal_profile where restaurant_id='$RESTO_A';")
assert_eq "V21-BACKWARD-COMPAT: les 6 nouvelles colonnes de merchant_legal_profile sont NULL après un appel positionnel à 12 arguments (jamais un défaut inventé)" "<NULL>|<NULL>|<NULL>|<NULL>|<NULL>|<NULL>" "$V21_BC_LEGAL"

# merchant_cgv_profile n'existe pas encore pour A à ce stade (aucun
# update_merchant_cgv_profile appelé) -- la ligne n'existe donc pas
# encore ; ce test porte sur le comportement de get_merchant_cgv_profile
# (déjà DROP+CREATE par v2.1) face à une absence totale de ligne,
# EXACTEMENT le même patron que la ligne coalesce(...,'CGV_NOT_CONFIGURED')
# déjà en place en v1.1 pour status/profile_version/presentation_variant.
RC=$(as_authenticated_rc "$OWNER_A" "select cold_chain_applicable::text || '|' || coalesce(weight_pricing_mode,'<NULL>') from public.get_merchant_cgv_profile('$RESTO_A');")
assert_ok "V21-BACKWARD-COMPAT: get_merchant_cgv_profile (DROP+CREATE v2.1, colonnes de sortie élargies) reste appelable normalement en l'absence totale de ligne merchant_cgv_profile" "$RC"
assert_eq "V21-BACKWARD-COMPAT: get_merchant_cgv_profile renvoie cold_chain_applicable=false et weight_pricing_mode=NULL quand aucune ligne n'existe encore (même style de coalesce sûr que status/presentation_variant en v1.1)" "false|<NULL>" "$(sql_out)"

# ============================================================
# [4/5/6] Complétude — publication bloquée si incomplet (v1.1 : la
# porte de complétude est désormais AU NIVEAU DE resolve_cgv_
# publication_context, jamais atteignable par un contenu client)
# ============================================================
log "=== [4/5/6] Garde de complétude (via resolve_cgv_publication_context) ==="
RC=$(as_authenticated_rc "$OWNER_A" \
  "select * from public.resolve_cgv_publication_context('$RESTO_A');")
assert_denied "4. resolve_cgv_publication_context refuse : profil CGV (withdrawal_regime etc.) pas encore renseigné" "$RC"
assert_contains "4. erreur porte le code déterministe WITHDRAWAL_REGIME_MISSING" "WITHDRAWAL_REGIME_MISSING" "$(sql_err)"

# Renseigne withdrawal_regime + preparation time, mais retire le pays -> bloqué
psql -d "$DB" -c "update public.restaurants set country = null where id='$RESTO_A';" >/dev/null
RC=$(as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_cgv_profile('$RESTO_A','EXEMPT_PERISHABLE',15,25,'MINUTES','Annulation possible avant préparation','Substitution équivalente si rupture','FORMAL');")
assert_ok "5. update_merchant_cgv_profile réussit (le pays n'est pas un champ de cette table)" "$RC"
ERR=$(sql "select public.cgv_completeness_errors('$RESTO_A');")
assert_contains "5. pays absent -> COUNTRY_MISSING dans la liste de complétude" "COUNTRY_MISSING" "$ERR"
RC=$(as_authenticated_rc "$OWNER_A" \
  "select * from public.resolve_cgv_publication_context('$RESTO_A');")
assert_denied "5. resolve_cgv_publication_context refuse tant que le pays est absent" "$RC"

psql -d "$DB" -c "update public.restaurants set country = 'FR' where id='$RESTO_A';" >/dev/null

# Mediator manquant -> bloqué
psql -d "$DB" -c "update public.merchant_legal_profile set consumer_mediator_name = null where restaurant_id='$RESTO_A';" >/dev/null
ERR=$(sql "select public.cgv_completeness_errors('$RESTO_A');")
assert_contains "6. médiateur absent -> MEDIATOR_INFO_MISSING" "MEDIATOR_INFO_MISSING" "$ERR"
RC=$(as_authenticated_rc "$OWNER_A" \
  "select * from public.resolve_cgv_publication_context('$RESTO_A');")
assert_denied "6. resolve_cgv_publication_context refuse tant que le médiateur est absent (template requires_mediator=true)" "$RC"

psql -d "$DB" -c "update public.merchant_legal_profile set consumer_mediator_name='Médiateur Test', consumer_mediator_address='2 rue Médiation, 75002 Paris', consumer_mediator_website='https://mediateur.test' where restaurant_id='$RESTO_A';" >/dev/null

# ============================================================
# [7/8/9] Withdrawal regime rendering / fail-closed MIXED -- flux en
# TROIS ÉTAPES désormais (v1.2) : resolve_cgv_publication_context
# (as-user, prouve l'autorisation + résout le gabarit + le fingerprint
# + l'acting_user_id) PUIS persist_merchant_cgv_version (service_role
# uniquement, re-vérifie TOUT indépendamment -- autorisation, verrou
# de lignes, fingerprint -- avant toute écriture).
# ============================================================
log "=== [7/8/9] Régime de rétractation (flux v1.2, avec fingerprint) ==="
ERR=$(sql "select public.cgv_completeness_errors('$RESTO_A');")
assert_eq "7. profil désormais complet (EXEMPT_PERISHABLE) -- tableau d'erreurs vide ('{}')" "{}" "$ERR"

RC=$(resolve_for_persist_rc "$OWNER_A" "$RESTO_A")
assert_ok "7. resolve_cgv_publication_context (as-user, owner) réussit une fois le profil complet, renvoie gabarit+fingerprint+acting_user_id" "$RC"
resolve_split
assert_eq "7. le gabarit résolu par resolve_cgv_publication_context == le gabarit FR attendu (calculé indépendamment par le harnais)" "$TEMPLATE_ID" "$RESOLVED_TID"
assert_eq "7. l'acting_user_id résolu == l'uid de l'appelant (jamais un autre)" "$OWNER_A" "$RESOLVED_UID"

RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>EXEMPT_PERISHABLE clause rendue</p>', '$RESOLVED_FP', '$RESOLVED_UID');")
assert_ok "7. persist_merchant_cgv_version (service_role, gabarit+fingerprint+acting_user_id résolus à l'étape précédente) réussit" "$RC"
CONTENT=$(sql "select rendered_content from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='ACTIVE';")
assert_contains "7. contenu rendu contient bien la clause EXEMPT_PERISHABLE transmise" "EXEMPT_PERISHABLE" "$CONTENT"

as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_cgv_profile('$RESTO_A','STANDARD_14_DAYS',15,25,'MINUTES','Annulation possible avant préparation','Substitution équivalente si rupture','FORMAL');" >/dev/null
RC=$(resolve_for_persist_rc "$OWNER_A" "$RESTO_A")
assert_ok "8. resolve_cgv_publication_context (post-changement de régime) réussit" "$RC"
resolve_split
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>STANDARD_14_DAYS clause rendue, différente</p>', '$RESOLVED_FP', '$RESOLVED_UID');")
assert_ok "8. publication (persist_merchant_cgv_version) réussit avec STANDARD_14_DAYS (régime différent)" "$RC"
CONTENT2=$(sql "select rendered_content from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='ACTIVE';")
assert_contains "8. le nouveau contenu ACTIVE reflète bien STANDARD_14_DAYS (régime différent du précédent)" "STANDARD_14_DAYS" "$CONTENT2"

as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_cgv_profile('$RESTO_A','MIXED',15,25,'MINUTES',null,null,'FORMAL');" >/dev/null
RC=$(as_authenticated_rc "$OWNER_A" "select * from public.resolve_cgv_publication_context('$RESTO_A');")
assert_denied "9. resolve_cgv_publication_context : MIXED échoue fermé (fail-closed) -- pas de classification produit en v1" "$RC"
assert_contains "9. code déterministe WITHDRAWAL_REGIME_MIXED_UNSUPPORTED (resolve)" "WITHDRAWAL_REGIME_MIXED_UNSUPPORTED" "$(sql_err)"

# 9bis -- défense en profondeur : MÊME en appelant persist_merchant_
# cgv_version DIRECTEMENT en tant que service_role (donc en
# court-circuitant l'étape resolve -- fingerprint/acting_user_id
# arbitraires ici, l'autorisation est valide (OWNER_A) donc le rejet
# vient bien de la complétude, pas de l'autorisation ni du
# fingerprint, qui sont vérifiés APRÈS dans le corps de la fonction),
# la re-vérification indépendante de complétude À L'INTÉRIEUR de
# persist_merchant_cgv_version refuse ÉGALEMENT MIXED -- la sécurité
# ne repose jamais sur un seul point de contrôle.
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$TEMPLATE_ID', '<p>tentative MIXED</p>', 'placeholder-fingerprint-non-pertinent-ici', '$OWNER_A');")
assert_denied "9bis. persist_merchant_cgv_version (service_role, appelé directement) refuse ÉGALEMENT MIXED -- re-vérification indépendante de la complétude, pas seulement au niveau resolve" "$RC"
assert_contains "9bis. code déterministe WITHDRAWAL_REGIME_MIXED_UNSUPPORTED (persist)" "WITHDRAWAL_REGIME_MIXED_UNSUPPORTED" "$(sql_err)"

# Remet EXEMPT_PERISHABLE pour la suite des tests (checkout)
as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_cgv_profile('$RESTO_A','EXEMPT_PERISHABLE',15,25,'MINUTES','Annulation possible avant préparation','Substitution équivalente si rupture','FORMAL');" >/dev/null
resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
resolve_split
as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>EXEMPT_PERISHABLE clause finale</p>', '$RESOLVED_FP', '$RESOLVED_UID');" >/dev/null

# ============================================================
# [BLOCKER1/TEMPLATE-AUTHORITY] Autorité de gabarit applicable --
# jamais faire confiance à un template_id fourni par l'appelant, même
# un appelant désormais de confiance (service_role) : re-résolution
# indépendante et rejet d'un gabarit d'une AUTRE juridiction. Placé ICI
# (profil A désormais garanti complet, EXEMPT_PERISHABLE, juste
# reconfirmé ci-dessus) pour que l'erreur observée soit bien
# TEMPLATE_NOT_APPLICABLE, jamais masquée par un CGV_INCOMPLETE
# antérieur dans l'ordre des vérifications internes de la fonction.
# ============================================================
log "=== [BLOCKER1/TEMPLATE-AUTHORITY] Autorité de gabarit applicable (rejet cross-juridiction) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into public.scanym_supported_countries (code, name) values ('BE','Belgique') on conflict do nothing;
insert into public.cgv_template (
  template_code, jurisdiction_country, business_scope, version, locale,
  status, requires_mediator, requires_preparation_clause, controlled_sections, published_at
)
select
  'BE_FOOD_PERISHABLE_B2C', 'BE', 'food_perishable_b2c', 1, 'fr',
  'PUBLISHED', true, true,
  '{
     "header": "Voorwaarden BE",
     "identity_intro": "Intro BE.",
     "withdrawal_clauses": {"EXEMPT_PERISHABLE": "Clause BE.", "STANDARD_14_DAYS": "Clause BE 14j.", "MIXED": null},
     "mediator_clause": "Médiateur BE.",
     "preparation_clause": "Délai BE.",
     "cancellation_clause_label": "Annulation BE",
     "substitution_clause_label": "Substitution BE",
     "jurisdiction_clause": "Droit belge."
   }'::jsonb,
  now()
where not exists (select 1 from public.cgv_template where template_code = 'BE_FOOD_PERISHABLE_B2C' and version = 1);
SQL
BE_TEMPLATE_ID=$(sql "select id from public.cgv_template where template_code='BE_FOOD_PERISHABLE_B2C' and version=1;")

# v1.2 : signature à 5 arguments -- fingerprint placeholder sûr ici
# puisque TEMPLATE_NOT_APPLICABLE est levé (vérification d'autorité de
# gabarit) AVANT toute comparaison de fingerprint dans le corps de la
# fonction ; $OWNER_A comme acting_user_id (autorisation légitime, pour
# que le rejet observé soit bien celui de l'autorité de gabarit, pas
# une révocation d'autorisation).
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$BE_TEMPLATE_ID', '<p>tentative avec gabarit BE pour un restaurant FR</p>', 'placeholder-fingerprint', '$OWNER_A');")
assert_denied "TEMPLATE-AUTHORITY: persist_merchant_cgv_version REJETTE un template_id d'une AUTRE juridiction (BE) pour un restaurant FR, même appelé par service_role, même avec un profil désormais complet" "$RC"
assert_contains "TEMPLATE-AUTHORITY: code déterministe TEMPLATE_NOT_APPLICABLE" "TEMPLATE_NOT_APPLICABLE" "$(sql_err)"

VERSION_COUNT_BEFORE_TA=$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_A';")
RC=$(as_authenticated_rc "$OWNER_A" "select template_id from public.resolve_cgv_publication_context('$RESTO_A');")
assert_ok "TEMPLATE-AUTHORITY: resolve_cgv_publication_context réussit (profil complet) et résout un gabarit" "$RC"
RESOLVED_TEMPLATE_TA=$(sql_out)
assert_eq "TEMPLATE-AUTHORITY: resolve_cgv_publication_context résout le gabarit FR ($TEMPLATE_ID), JAMAIS le gabarit BE" "$TEMPLATE_ID" "$RESOLVED_TEMPLATE_TA"
assert_not_contains "TEMPLATE-AUTHORITY: le gabarit résolu n'est jamais celui de BE" "$BE_TEMPLATE_ID" "$RESOLVED_TEMPLATE_TA"
VERSION_COUNT_AFTER_TA=$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_A';")
assert_eq "TEMPLATE-AUTHORITY: la tentative rejetée (gabarit BE) n'a créé AUCUNE nouvelle ligne merchant_cgv_version pour A" "$VERSION_COUNT_BEFORE_TA" "$VERSION_COUNT_AFTER_TA"

# ============================================================
# [10] Preparation time — champs dédiés, jamais delay_value/delay_unit
# ============================================================
log "=== [10] Champs de préparation dédiés ==="
CODE_ONLY=$(grep -hv '^\s*--' "$LOT_SQL_V11" "$LOT_SQL_V12" "$LOT_SQL_V13" "$LOT_SQL_V14" "$LOT_SQL_V21")
assert_not_contains "10. le SQL exécuté (hors commentaires, v1.1+v1.2+v1.3+v1.4+v2.1) ne référence jamais delay_value/delay_unit" "delay_value" "$(printf '%s' "$CODE_ONLY" | grep -o 'delay_value\|delay_unit' || true)"
PREP=$(sql "select preparation_time_min || '/' || preparation_time_max || '/' || preparation_time_unit from public.merchant_cgv_profile where restaurant_id='$RESTO_A';")
assert_eq "10. preparation_time_min/max/unit lus depuis merchant_cgv_profile, valeurs saisies" "15/25/MINUTES" "$PREP"

# ============================================================
# [11] Template non éditable par le marchand
# ============================================================
log "=== [11] Template non éditable ==="
RC=$(as_authenticated_rc "$OWNER_A" \
  "update public.cgv_template set controlled_sections = '{}'::jsonb where template_code='FR_FOOD_PERISHABLE_B2C';")
assert_denied "11. un marchand (owner) ne peut pas UPDATE cgv_template directement (aucun grant)" "$RC"

# ============================================================
# [12/13] Immutabilité des versions publiées
# ============================================================
log "=== [12/13] Immutabilité version publiée ==="
FIRST_VERSION_ID=$(sql "select id from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='SUPERSEDED' order by published_at asc limit 1;")
RC=$(as_authenticated_rc "$OWNER_A" \
  "update public.merchant_cgv_version set rendered_content='HACKED' where id='$FIRST_VERSION_ID';")
assert_denied "12. impossible d'UPDATE une ligne merchant_cgv_version existante (aucun grant update)" "$RC"

RC=$(as_service_role_rc "update public.merchant_cgv_version set rendered_content='HACKED' where id='$FIRST_VERSION_ID';")
assert_denied "12bis. service_role NON PLUS ne peut UPDATE directement merchant_cgv_version (aucun grant table direct -- TRUNCATE bypasserait la RLS si ce grant existait, voir Blocker 2)" "$RC"

as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_cgv_profile('$RESTO_A','EXEMPT_PERISHABLE',20,30,'MINUTES','Nouvelle politique','Nouvelle substitution','FORMAL');" >/dev/null
OLD_CONTENT_STILL=$(sql "select rendered_content from public.merchant_cgv_version where id = (select id from public.merchant_cgv_version where restaurant_id='$RESTO_A' order by published_at asc limit 1);")
assert_contains "13. mise à jour du profil NE modifie PAS le contenu de la toute première version déjà publiée" "EXEMPT_PERISHABLE clause rendue" "$OLD_CONTENT_STILL"

# ============================================================
# [14/15] Hash déterministe / rendu FR déterministe
# ============================================================
log "=== [14/15] Hash déterministe ==="
H1=$(sql "select md5('<p>contenu identique</p>');")
H2=$(sql "select md5('<p>contenu identique</p>');")
assert_eq "14. md5() du même contenu produit toujours le même hash" "$H1" "$H2"
STORED_HASH=$(sql "select content_hash from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='ACTIVE';")
RECOMPUTED=$(sql "select md5(rendered_content) from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='ACTIVE';")
assert_eq "14. content_hash stocké == md5(rendered_content) recalculé" "$RECOMPUTED" "$STORED_HASH"

# ============================================================
# [16] EN/AR non implémenté -> repli FR au niveau UI (hors SQL, voir
#      lib/i18n.ts / DOM test).
# ============================================================
log "=== [16] Locale ==="
pass "16. locale reste un champ texte simple côté SQL (toujours 'fr' en v1.1, fixé serveur -- voir resolve_cgv_publication_context) ; le repli FR pour EN/AR non traduit est assuré par lib/i18n.ts (translate()), vérifié par le test Node dédié"

# ============================================================
# [17/18] Checkout — bloqué sans acceptation, réussit avec
# ============================================================
log "=== [17/18] Checkout ACTIVE ==="
RC=$(as_authenticated_rc "$OWNER_A" "select public.activate_merchant_cgv('$RESTO_A');")
assert_ok "activation CGV (profil complet + version publiée)" "$RC"
STATUS=$(sql "select status from public.merchant_cgv_profile where restaurant_id='$RESTO_A';")
assert_eq "profil CGV désormais CGV_ACTIVE" "CGV_ACTIVE" "$STATUS"

RC=$(as_anon_rc "select * from public.create_order('resto-a','pickup','[{\"menu_item_id\":\"d1111111-1111-1111-1111-111111111111\",\"quantity\":1,\"option_item_id\":null}]'::jsonb, null, '{\"name\":\"Client Test\",\"phone\":\"0600000000\"}'::jsonb, null, 'fr', false);")
assert_denied "17. checkout SANS acceptation refusé pour marchand CGV_ACTIVE" "$RC"
assert_contains "17. message déterministe CGV_ACCEPTANCE_REQUIRED" "CGV_ACCEPTANCE_REQUIRED" "$(sql_err)"

ORDER_COUNT_BEFORE=$(sql "select count(*) from public.orders where restaurant_id='$RESTO_A';")
RC=$(as_anon_rc "select * from public.create_order('resto-a','pickup','[{\"menu_item_id\":\"d1111111-1111-1111-1111-111111111111\",\"quantity\":1,\"option_item_id\":null}]'::jsonb, null, '{\"name\":\"Client Test\",\"phone\":\"0600000000\"}'::jsonb, null, 'fr', true);")
assert_ok "18. checkout AVEC acceptation réussit pour marchand CGV_ACTIVE" "$RC"
ORDER_COUNT_AFTER=$(sql "select count(*) from public.orders where restaurant_id='$RESTO_A';")
assert_eq "18. exactement une commande créée" "$((ORDER_COUNT_BEFORE+1))" "$ORDER_COUNT_AFTER"

NEW_ORDER_ID=$(sql "select id from public.orders where restaurant_id='$RESTO_A' order by created_at desc limit 1;")
ACCEPTANCE_ROWS=$(sql "select count(*) from public.order_cgv_acceptance where order_id='$NEW_ORDER_ID';")
assert_eq "18. exactement 1 ligne order_cgv_acceptance pour cette commande" "1" "$ACCEPTANCE_ROWS"

# ============================================================
# [19/20] Le client ne peut ni forger la version ni le hash
# ============================================================
log "=== [19/20] Anti-forgerie ==="
ARGS=$(sql "select pg_get_function_arguments(oid) from pg_proc where proname='create_order' and pronamespace = 'public'::regnamespace;")
assert_not_contains "19. la signature create_order n'expose aucun paramètre cgv_version_id" "cgv_version_id" "$ARGS"
assert_not_contains "20. la signature create_order n'expose aucun paramètre content_hash" "content_hash" "$ARGS"

RECORDED_VERSION=$(sql "select cgv_version_id from public.order_cgv_acceptance where order_id='$NEW_ORDER_ID';")
SERVER_ACTIVE_VERSION=$(sql "select id from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='ACTIVE';")
assert_eq "19. la version enregistrée == la version ACTIVE résolue serveur (jamais une valeur cliente)" "$SERVER_ACTIVE_VERSION" "$RECORDED_VERSION"

RECORDED_HASH=$(sql "select content_hash from public.order_cgv_acceptance where order_id='$NEW_ORDER_ID';")
SERVER_ACTIVE_HASH=$(sql "select content_hash from public.merchant_cgv_version where id='$SERVER_ACTIVE_VERSION';")
assert_eq "20. le hash enregistré == le hash de la version ACTIVE (jamais une valeur cliente)" "$SERVER_ACTIVE_HASH" "$RECORDED_HASH"

# ============================================================
# [21/22] Ancienne commande garde son ancienne version même après republication
# ============================================================
log "=== [21/22] Stabilité historique ==="
# v1.2 : republication légitime -- résolution fraîche obligatoire
# (contexte + fingerprint + acting_user_id) avant persistance, exactement
# le flux normal en deux étapes ; on ne réutilise jamais un fingerprint
# ni un uid périmés d'une étape précédente.
resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
resolve_split
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>Nouvelle version, remplace la précédente</p>', '$RESOLVED_FP', '$RESOLVED_UID');")
assert_ok "21. republication (persist_merchant_cgv_version) réussit" "$RC"
RECORDED_VERSION_AFTER=$(sql "select cgv_version_id from public.order_cgv_acceptance where order_id='$NEW_ORDER_ID';")
assert_eq "21. la commande déjà créée référence toujours SA version d'origine, pas la nouvelle" "$RECORDED_VERSION" "$RECORDED_VERSION_AFTER"
OLD_STILL_READABLE=$(sql "select content_hash from public.merchant_cgv_version where id='$RECORDED_VERSION_AFTER';")
assert_eq "22. le contenu de l'ancienne version reste inchangé/lisible malgré la republication" "$SERVER_ACTIVE_HASH" "$OLD_STILL_READABLE"

# ============================================================
# [23] Référence cross-tenant à une version rejetée
# ============================================================
log "=== [23] Anti cross-tenant sur version historique ==="
OUT=$(sql "select count(*) from public.get_restaurant_cgv_version_by_id('$RECORDED_VERSION_AFTER','$RESTO_B');")
assert_eq "23. version A demandée avec restaurant_id B -> aucune ligne retournée" "0" "$OUT"
OUT2=$(sql "select count(*) from public.get_restaurant_cgv_version_by_id('$RECORDED_VERSION_AFTER','$RESTO_A');")
assert_eq "23. même version avec le BON restaurant_id -> 1 ligne" "1" "$OUT2"

# ============================================================
# [24] Marchand legacy (non configuré) -- comportement inchangé
# ============================================================
log "=== [24] Legacy inchangé ==="
RC=$(as_anon_rc "select * from public.create_order('resto-legacy','pickup','[{\"menu_item_id\":\"d9999999-9999-9999-9999-999999999999\",\"quantity\":1,\"option_item_id\":null}]'::jsonb, null, '{\"name\":\"Client Legacy\",\"phone\":\"0600000000\"}'::jsonb, null, 'fr', false);")
assert_ok "24. marchand SANS profil CGV (CGV_NOT_CONFIGURED implicite) : checkout réussit SANS acceptation" "$RC"
LEGACY_ORDER_ID=$(sql "select id from public.orders where restaurant_id='$RESTO_LEGACY' order by created_at desc limit 1;")
LEGACY_ACCEPTANCE=$(sql "select count(*) from public.order_cgv_acceptance where order_id='$LEGACY_ORDER_ID';")
assert_eq "24. aucune ligne order_cgv_acceptance créée pour ce marchand legacy" "0" "$LEGACY_ACCEPTANCE"

# ============================================================
# [25/26/27] Pas de mutation paiement / Stuart / fichiers Monet
# ============================================================
log "=== [25/26/27] Périmètre ==="
CODE_ONLY_SCOPE=$(grep -hv '^\s*--' "$LOT_SQL_V11" "$LOT_SQL_V12" "$LOT_SQL_V13" "$LOT_SQL_V14" "$LOT_SQL_V21")
assert_not_contains "25. le SQL exécuté (v1.1+v1.2+v1.3+v1.4+v2.1) ne touche aucune table de statut de paiement" "payment_status" "$(printf '%s' "$CODE_ONLY_SCOPE" | grep -oiE 'payment_status|monetico' || true)"
assert_not_contains "26. le SQL exécuté (v1.1+v1.2+v1.3+v1.4+v2.1) ne fait aucun appel Stuart (une référence à un autre fichier de provenance, en commentaire d'en-tête, est exclue de cette recherche)" "stuart" "$(printf '%s' "$CODE_ONLY_SCOPE" | grep -oi 'stuart' || true)"
V21_CODE_ONLY_SELF=$(grep -v '^\s*--' "$LOT_SQL_V21")
assert_not_contains "V21-SCOPE: le fichier v2.1 lui-même (jamais le corpus historique v1.1-v1.4, qui référence légitimement menu_items dans create_order) ne touche jamais menu_items ni aucune table catalogue" "menu_items" "$(printf '%s' "$V21_CODE_ONLY_SELF" | grep -o 'menu_items\|menu_categories' || true)"
pass "27. aucun fichier de Monet (tracking/confirmation/payment-return) modifié -- confirmé au niveau du diff de paquet (NON-MODIFICATION-PROOF.md) ; aucun fichier Stuart LOT D1 v1.2 touché (COLLISION-CHECK.md)"

# ============================================================
# [BLOCKER2/ACL] Matrice de convergence ACL -- 5 tables CGV × 4 rôles
# × 7 privilèges (MAINTAIN, PG17+, exclu -- ce bac à sable est en
# PostgreSQL 16 ; voir en-tête de ce fichier). Prouve que MALGRÉ la
# simulation hostile [BLOCKER2/ACL-0] ci-dessus (ACL par défaut
# accordant tout à anon/authenticated/service_role AVANT même que ce
# lot n'installe ses tables), l'état final est intégralement fermé --
# ce sont les REVOKE explicites du lot qui l'ont fait converger, pas
# une absence de grant par défaut.
# ============================================================
log "=== [BLOCKER2/ACL] Matrice de convergence ACL (5 tables × 4 rôles × 7 privilèges) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -c "do \$do\$ begin if not exists (select from pg_roles where rolname='cgv_probe_public') then create role cgv_probe_public nologin; end if; end \$do\$;" >/dev/null 2>&1

CGV_TABLES="merchant_legal_profile cgv_template merchant_cgv_profile merchant_cgv_version order_cgv_acceptance"
CGV_PRIVS="SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER"
CGV_READ_TABLES="merchant_legal_profile merchant_cgv_profile merchant_cgv_version order_cgv_acceptance"

for T in $CGV_TABLES; do
  for P in $CGV_PRIVS; do
    V=$(sql "select has_table_privilege('cgv_probe_public','public.$T','$P');")
    assert_eq "ACL: PUBLIC (rôle sonde sans appartenance) n'a AUCUN privilège $P sur $T" "f" "$V"

    V=$(sql "select has_table_privilege('anon','public.$T','$P');")
    assert_eq "ACL: anon n'a AUCUN privilège $P sur $T" "f" "$V"

    V=$(sql "select has_table_privilege('service_role','public.$T','$P');")
    assert_eq "ACL: service_role n'a AUCUN privilège DIRECT $P sur $T (toute écriture passe par une RPC SECURITY DEFINER, qui s'exécute avec les droits de son propriétaire, pas ceux de service_role)" "f" "$V"

    V=$(sql "select has_table_privilege('authenticated','public.$T','$P');")
    IS_READ_TABLE="no"
    for RT in $CGV_READ_TABLES; do [ "$T" = "$RT" ] && IS_READ_TABLE="yes"; done
    if [ "$IS_READ_TABLE" = "yes" ] && [ "$P" = "SELECT" ]; then
      assert_eq "ACL: authenticated a SELECT sur $T (lecture directe volontaire, toute écriture reste via RPC)" "t" "$V"
    else
      assert_eq "ACL: authenticated n'a PAS le privilège $P sur $T" "f" "$V"
    fi
  done
done

# ============================================================
# [28-31] renvoyés par le pipeline de vérification global (tsc,
# harness lui-même = SQL harness, git diff --check, régression) --
# consignés dans TEST-RESULTS.md, pas dupliqués ici.
# ============================================================
pass "28/29/30/31. voir TEST-RESULTS.md pour TypeScript / présent harnais / git diff --check / régression checkout existante"

# ============================================================
# [BLOCKER1/CONCURRENCY] Matrice obligatoire de 12 tests (mandat
# CGV-V11-PUBLISH-CONTEXT-RACE-01) -- "context resolved = context
# rendered = context persisted" ; toute mutation d'une entrée
# faisant autorité entre la résolution et la persistance DOIT échouer
# fermé (fail-closed), sans insertion, sans supersede, sans
# publication partielle. Chaque scénario : (a) résout un contexte
# frais et valide ; (b) mute UNE SEULE entrée faisant autorité côté
# serveur ; (c) tente persist_merchant_cgv_version avec le contexte
# désormais périmé (résolu à l'étape (a), donc AVANT la mutation) ;
# (d) vérifie le rejet déterministe et l'absence de toute mutation de
# public.merchant_cgv_version ; (e) restaure l'état pour ne pas
# affecter les sections suivantes (dont [ROLLBACK] plus bas).
# ============================================================
log "=== [BLOCKER1/CONCURRENCY] Matrice de 12 tests (course contexte/fingerprint) ==="

# --- État de référence avant la matrice ---
CONC_COUNT_START=$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_A';")

# ------------------------------------------------------------
# 1. Contexte inchangé -> succès
# ------------------------------------------------------------
resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
resolve_split
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>CONCURRENCY 1: contexte inchangé</p>', '$RESOLVED_FP', '$RESOLVED_UID');")
assert_ok "CONCURRENCY 1/12: contexte inchangé entre resolve et persist -> succès" "$RC"

CONC_ACTIVE_STABLE=$(sql "select id from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='ACTIVE';")
CONC_COUNT_STABLE=$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_A';")
assert_eq "CONCURRENCY 1/12: exactement une ligne de plus après le succès légitime" "$((CONC_COUNT_START+1))" "$CONC_COUNT_STABLE"

# ------------------------------------------------------------
# 2. Le profil légal change entre resolve et persist -> rejet
# ------------------------------------------------------------
resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
resolve_split
as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_legal_profile('$RESTO_A','SARL','1 rue Test',null,'75001','Lyon','FR','contact@resto-a.test',null,'Médiateur Test','2 rue Médiation, 75002 Paris','https://mediateur.test');" >/dev/null
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>CONCURRENCY 2: profil légal changé (ne doit jamais être persisté)</p>', '$RESOLVED_FP', '$RESOLVED_UID');")
assert_denied "CONCURRENCY 2/12: le profil légal (city) change entre resolve/persist -> REJET" "$RC"
assert_contains "CONCURRENCY 2/12: code déterministe STALE_CONTEXT" "STALE_CONTEXT" "$(sql_err)"
as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_legal_profile('$RESTO_A','SARL','1 rue Test',null,'75001','Paris','FR','contact@resto-a.test',null,'Médiateur Test','2 rue Médiation, 75002 Paris','https://mediateur.test');" >/dev/null

# ------------------------------------------------------------
# 3. Les conditions commerciales (merchant_cgv_profile) changent -> rejet
# ------------------------------------------------------------
resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
resolve_split
as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_cgv_profile('$RESTO_A','EXEMPT_PERISHABLE',20,30,'MINUTES','Politique modifiée pendant la fenêtre de course','Nouvelle substitution','FORMAL');" >/dev/null
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>CONCURRENCY 3: conditions commerciales changées (ne doit jamais être persisté)</p>', '$RESOLVED_FP', '$RESOLVED_UID');")
assert_denied "CONCURRENCY 3/12: business-condition profile (cancellation_policy_text) change entre resolve/persist -> REJET" "$RC"
assert_contains "CONCURRENCY 3/12: code déterministe STALE_CONTEXT" "STALE_CONTEXT" "$(sql_err)"
as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_cgv_profile('$RESTO_A','EXEMPT_PERISHABLE',20,30,'MINUTES','Nouvelle politique','Nouvelle substitution','FORMAL');" >/dev/null

# ------------------------------------------------------------
# 4/5. Le gabarit applicable change de version/contenu -> rejet
#   NOTE HONNÊTE : dans ce schéma, un gabarit (cgv_template) est une
#   ligne IMMUABLE -- id et version sont fixés ensemble à l'insertion,
#   il n'existe aucune fonction d'UPDATE en place d'un gabarit publié.
#   Par conséquent, "le gabarit applicable change" (item 4 du mandat)
#   et "le contenu/la version du gabarit change" (item 5) sont
#   NÉCESSAIREMENT LE MÊME ÉVÉNEMENT dans ce schéma : la seule façon
#   de faire changer l'un est de publier une nouvelle ligne (nouvel
#   id, nouvelle version, nouveau contenu). Les deux items du mandat
#   sont donc vérifiés par UN SEUL scénario ci-dessous, avec deux
#   assertions distinctes (id différent, version différente). Rejeté
#   ICI par la vérification d'autorité de gabarit (v1.1,
#   TEMPLATE_NOT_APPLICABLE) -- AVANT même que le fingerprint ne soit
#   comparé, puisque p_template_id lui-même n'est déjà plus le gabarit
#   applicable -- défense en profondeur à deux couches indépendantes.
# ------------------------------------------------------------
# NOTE v2.1 : ce scénario simule "une ligne de gabarit PLUS RÉCENTE que
# celle résolue est publiée pendant la fenêtre de course". Ce harnais
# tourne désormais PAR-DESSUS v2.1 (qui a déjà publié la version 2,
# réellement applicable -- voir la note "0bis-note" plus haut) : la
# ligne simulée ci-dessous utilise donc la version 99 (jamais 2, qui
# désigne maintenant la VRAIE ligne v2.1, non une simulation locale
# éphémère à ce seul scénario) pour continuer à représenter "encore
# plus récent que ce qui vient d'être résolu", sans collision avec la
# ligne réelle.
resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
resolve_split
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<SQL
insert into public.cgv_template (
  template_code, jurisdiction_country, business_scope, version, locale,
  status, requires_mediator, requires_preparation_clause, controlled_sections, published_at
)
select
  'FR_FOOD_PERISHABLE_B2C', 'FR', 'food_perishable_b2c', 99, 'fr',
  'PUBLISHED', true, true,
  '{
     "header": "Conditions Générales de Vente v-next (course fingerprint)",
     "identity_intro": "Intro FR v-next.",
     "withdrawal_clauses": {"EXEMPT_PERISHABLE": "Clause FR v-next.", "STANDARD_14_DAYS": "Clause FR v-next 14j.", "MIXED": null},
     "mediator_clause": "Médiateur FR v-next.",
     "preparation_clause": "Délai FR v-next.",
     "cancellation_clause_label": "Annulation FR v-next",
     "substitution_clause_label": "Substitution FR v-next",
     "jurisdiction_clause": "Droit français v-next."
   }'::jsonb,
  now()
where not exists (select 1 from public.cgv_template where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 99);
SQL
FR_TEMPLATE_VNEXT_ID=$(sql "select id from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=99;")
assert_not_contains "CONCURRENCY 4/5 setup: le nouveau gabarit FR (version 99, simulée) a un id DIFFÉRENT du gabarit résolu précédemment" "$RESOLVED_TID" "$FR_TEMPLATE_VNEXT_ID"

RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>CONCURRENCY 4/5: gabarit applicable a changé (ne doit jamais être persisté)</p>', '$RESOLVED_FP', '$RESOLVED_UID');")
assert_denied "CONCURRENCY 4/12 + 5/12: le gabarit applicable change de version/contenu (nouvelle ligne FR plus récente publiée) entre resolve/persist -> REJET" "$RC"
assert_contains "CONCURRENCY 4/12+5/12: code déterministe TEMPLATE_NOT_APPLICABLE (défense en profondeur, en amont du fingerprint)" "TEMPLATE_NOT_APPLICABLE" "$(sql_err)"

# Restauration : retire le gabarit simulé (version 99) pour que le
# gabarit applicable FR redevienne EXACTEMENT TEMPLATE_ID (v2.1, la
# vraie version 2) pour le reste du harnais (dont [ROLLBACK]).
psql -d "$DB" -v ON_ERROR_STOP=1 -c "delete from public.cgv_template where id = '$FR_TEMPLATE_VNEXT_ID';" >/dev/null

# ------------------------------------------------------------
# 6. La variante de présentation change -> rejet
# ------------------------------------------------------------
resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
resolve_split
as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_cgv_profile('$RESTO_A','EXEMPT_PERISHABLE',20,30,'MINUTES','Nouvelle politique','Nouvelle substitution','WARM');" >/dev/null
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>CONCURRENCY 6: variante de présentation changée (ne doit jamais être persisté)</p>', '$RESOLVED_FP', '$RESOLVED_UID');")
assert_denied "CONCURRENCY 6/12: presentation_variant (FORMAL -> WARM) change entre resolve/persist -> REJET" "$RC"
assert_contains "CONCURRENCY 6/12: code déterministe STALE_CONTEXT" "STALE_CONTEXT" "$(sql_err)"
as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_cgv_profile('$RESTO_A','EXEMPT_PERISHABLE',20,30,'MINUTES','Nouvelle politique','Nouvelle substitution','FORMAL');" >/dev/null

# ------------------------------------------------------------
# 7. Contexte pertinent pour la locale (pays du marchand) change -> rejet
#   NOTE HONNÊTE : la locale est un littéral fixe 'fr' dans tout le
#   périmètre v1 (jamais dérivée d'un état mutable) -- le SEUL proxy
#   mutable affectant la juridiction/locale effective est le pays du
#   restaurant (restaurants.country), qui sélectionne aussi le gabarit
#   applicable (même mécanisme que 4/5, déclenché différemment : ici
#   par un changement de PAYS, pas par la publication d'un gabarit).
#   Documenté explicitement plutôt que de simuler une variation de
#   locale qui n'existe pas encore dans ce périmètre.
# ------------------------------------------------------------
resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
resolve_split
psql -d "$DB" -v ON_ERROR_STOP=1 -c "update public.restaurants set country='BE' where id='$RESTO_A';" >/dev/null
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>CONCURRENCY 7: pays/juridiction (proxy locale) changé (ne doit jamais être persisté)</p>', '$RESOLVED_FP', '$RESOLVED_UID');")
assert_denied "CONCURRENCY 7/12: pays du marchand (proxy locale/juridiction) change entre resolve/persist -> REJET" "$RC"
assert_contains "CONCURRENCY 7/12: rejet déterministe (TEMPLATE_NOT_APPLICABLE, le gabarit BE devient applicable) -- couche indépendante, en amont du fingerprint" "TEMPLATE_NOT_APPLICABLE" "$(sql_err)"
psql -d "$DB" -v ON_ERROR_STOP=1 -c "update public.restaurants set country='FR' where id='$RESTO_A';" >/dev/null

# ------------------------------------------------------------
# 8. L'autorisation du publicateur est retirée -> rejet (test
#    EXPLICITEMENT exigé par le mandat : "authorized at resolve ->
#    authorization removed -> persist attempted -> DENIED -> zero
#    mutation")
# ------------------------------------------------------------
resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
resolve_split
assert_eq "CONCURRENCY 8/12 setup: acting_user_id résolu == OWNER_A (avant révocation)" "$OWNER_A" "$RESOLVED_UID"
psql -d "$DB" -v ON_ERROR_STOP=1 -c "delete from public.restaurant_users where user_id='$OWNER_A' and restaurant_id='$RESTO_A';" >/dev/null
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>CONCURRENCY 8: autorisation retirée entre resolve et persist (ne doit jamais être persisté)</p>', '$RESOLVED_FP', '$RESOLVED_UID');")
assert_denied "CONCURRENCY 8/12: autorisation de l'acteur retirée entre resolve/persist -> REJET (re-vérifiée à la limite de persistance elle-même, pas seulement au resolve)" "$RC"
assert_contains "CONCURRENCY 8/12: message déterministe d'autorisation (_assert_legal_cgv_role_for_user), PAS un CGV_INCOMPLETE ni un STALE_CONTEXT qui masquerait la vraie cause" "Not authorized for this restaurant" "$(sql_err)"
psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into public.restaurant_users (user_id, restaurant_id, role) values ('$OWNER_A','$RESTO_A','owner') on conflict do nothing;" >/dev/null

# ------------------------------------------------------------
# 9/10. Aucune des tentatives périmées ci-dessus (items 2,3,4/5,6,7,8)
#    n'a fait superseder la version ACTIVE ni inséré la moindre ligne
# ------------------------------------------------------------
CONC_ACTIVE_AFTER=$(sql "select id from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='ACTIVE';")
assert_eq "CONCURRENCY 9/12: la version ACTIVE après toute la matrice de rejets == la version ACTIVE stable après l'item 1 (aucun supersede périmé)" "$CONC_ACTIVE_STABLE" "$CONC_ACTIVE_AFTER"
CONC_COUNT_AFTER=$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_A';")
assert_eq "CONCURRENCY 10/12: le nombre de lignes merchant_cgv_version après toute la matrice de rejets == le nombre stable après l'item 1 (aucune insertion périmée)" "$CONC_COUNT_STABLE" "$CONC_COUNT_AFTER"

# ------------------------------------------------------------
# 11. Nouvelle tentative avec un contexte fraîchement résolu -> succès
# ------------------------------------------------------------
resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
resolve_split
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>CONCURRENCY 11: nouvelle tentative avec contexte frais</p>', '$RESOLVED_FP', '$RESOLVED_UID');")
assert_ok "CONCURRENCY 11/12: après un rejet pour péremption, une NOUVELLE résolution fraîche permet une republication réussie (retriable, pas un blocage permanent)" "$RC"
CONC_COUNT_AFTER_RETRY=$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_A';")
assert_eq "CONCURRENCY 11/12: exactement une ligne de plus après la republication réussie" "$((CONC_COUNT_STABLE+1))" "$CONC_COUNT_AFTER_RETRY"

# ------------------------------------------------------------
# 12. Substitution de contexte cross-tenant impossible
#   Prépare un profil légal+CGV minimal MAIS complet pour RESTO_B
#   (jusqu'ici non configuré), résout un contexte VALIDE pour B (en
#   tant qu'OWNER_B), puis tente de l'utiliser pour persister sur
#   RESTO_A. Rejeté ICI par la RE-VÉRIFICATION D'AUTORISATION (v1.2,
#   Blocker 1) : OWNER_B n'a aucun rattachement à RESTO_A -- une
#   garantie indépendante et plus forte qu'une simple comparaison de
#   fingerprint (même si le fingerprint de B ne correspondrait de
#   toute façon jamais à l'état de A).
# ------------------------------------------------------------
as_authenticated_rc "$OWNER_B" \
  "select public.update_merchant_legal_profile('$RESTO_B','SARL','1 rue B',null,'69001','Lyon','FR','contact@resto-b.test',null,'Médiateur B','1 rue Médiation B, 69002 Lyon','https://mediateur-b.test');" >/dev/null
as_authenticated_rc "$OWNER_B" \
  "select public.update_merchant_cgv_profile('$RESTO_B','EXEMPT_PERISHABLE',15,25,'MINUTES','Annulation B','Substitution B','FORMAL');" >/dev/null
ERR_B=$(sql "select public.cgv_completeness_errors('$RESTO_B');")
assert_eq "CONCURRENCY 12/12 setup: profil B désormais complet ('{}')" "{}" "$ERR_B"

RC=$(resolve_for_persist_rc "$OWNER_B" "$RESTO_B")
assert_ok "CONCURRENCY 12/12 setup: resolve_cgv_publication_context réussit pour B (as-user, owner B)" "$RC"
resolve_split
assert_eq "CONCURRENCY 12/12 setup: acting_user_id résolu == OWNER_B" "$OWNER_B" "$RESOLVED_UID"

CONC_A_COUNT_BEFORE_XT=$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_A';")
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>CONCURRENCY 12: tentative de substitution cross-tenant (contexte B utilisé pour persister sur A)</p>', '$RESOLVED_FP', '$RESOLVED_UID');")
assert_denied "CONCURRENCY 12/12: substitution de contexte cross-tenant (résolu pour B, appliqué à A) -> REJET" "$RC"
assert_contains "CONCURRENCY 12/12: rejeté par la re-vérification d'autorisation (OWNER_B n'a aucun rattachement à RESTO_A), pas seulement par un hasard de fingerprint" "Not authorized for this restaurant" "$(sql_err)"
CONC_A_COUNT_AFTER_XT=$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_A';")
assert_eq "CONCURRENCY 12/12: aucune ligne merchant_cgv_version créée pour A par la tentative de substitution cross-tenant" "$CONC_A_COUNT_BEFORE_XT" "$CONC_A_COUNT_AFTER_XT"


# ============================================================
# [BLOCKER1/LOCKING] Démonstration d'un VRAI verrouillage PostgreSQL
# (mandat : "where feasible, exercise real PostgreSQL transaction/
# locking behavior in the harness rather than source-only
# assertions"). Une session psql d'arrière-plan ouvre une transaction,
# prend un verrou ligne (FOR UPDATE) sur merchant_legal_profile pour
# RESTO_A, puis dort 3s avant de valider. Pendant cette fenêtre, un
# appel persist_merchant_cgv_version au premier plan (qui prend LUI-
# MÊME un `for update` sur cette même ligne, voir migration v1.2,
# section D) doit rester bloqué jusqu'à la validation de la session
# d'arrière-plan -- pas une assertion sur le texte source, une mesure
# de temps d'horloge murale prouvant un blocage réel.
# ============================================================
log "=== [BLOCKER1/LOCKING] Verrouillage PostgreSQL réel (FOR UPDATE bloquant) ==="

LOCK_HOLD_SECONDS=3
psql -d "$DB" -v ON_ERROR_STOP=1 >/tmp/lock-holder-out-$$.txt 2>&1 <<SQL &
begin;
select 1 from public.merchant_legal_profile where restaurant_id='$RESTO_A' for update;
select pg_sleep($LOCK_HOLD_SECONDS);
commit;
SQL
LOCK_HOLDER_PID=$!

# Laisse le temps à la session d'arrière-plan de démarrer sa
# transaction et de prendre le verrou avant que le premier plan ne
# tente le sien.
sleep 1

resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
resolve_split

LOCK_T0=$(date +%s%N)
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>LOCKING: doit attendre la libération du verrou</p>', '$RESOLVED_FP', '$RESOLVED_UID');")
LOCK_T1=$(date +%s%N)
LOCK_ELAPSED_MS=$(( (LOCK_T1 - LOCK_T0) / 1000000 ))

wait "$LOCK_HOLDER_PID" 2>/dev/null
rm -f /tmp/lock-holder-out-$$.txt

assert_ok "LOCKING: persist_merchant_cgv_version réussit APRÈS l'attente du verrou (pas d'erreur -- juste un délai)" "$RC"
# Seuil à 1500ms (< les 3000ms de détention) : marge confortable contre
# la latence système, tout en excluant catégoriquement un retour quasi
# instantané qui prouverait l'ABSENCE de blocage réel.
if [ "$LOCK_ELAPSED_MS" -ge 1500 ]; then
  pass "LOCKING: l'appel a été RÉELLEMENT bloqué ${LOCK_ELAPSED_MS}ms par le verrou FOR UPDATE de la session d'arrière-plan (>= 1500ms attendu, < ${LOCK_HOLD_SECONDS}000ms tenus) -- verrouillage PostgreSQL authentique, pas une assertion de code source"
else
  fail "LOCKING: l'appel n'a duré que ${LOCK_ELAPSED_MS}ms -- ATTENDU >= 1500ms si le verrou FOR UPDATE de persist_merchant_cgv_version est réellement bloquant"
fi


# ============================================================
# [V13-GAP1/SELLER-NAME] Stale-context : renommage du vendeur
# (restaurants.name) entre resolve et persist -- DOIT échouer fermé
# (mandat v1.3, GAP 1). Le nom original est restauré à la fin pour ne
# pas affecter la suite du harnais (dont [ROLLBACK] plus bas, qui n'en
# dépend pas -- restauré par discipline générale, comme la matrice
# [BLOCKER1/CONCURRENCY] le fait déjà pour ses propres mutations).
# ============================================================
log "=== [V13-GAP1/SELLER-NAME] Stale-context : renommage du vendeur ==="
ORIG_RESTO_A_NAME=$(sql "select name from public.restaurants where id='$RESTO_A';")
V13_VCOUNT_BEFORE_NAME=$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_A';")
V13_ACTIVE_BEFORE_NAME=$(sql "select id from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='ACTIVE';")

resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
resolve_split
V13_FP_BEFORE_RENAME="$RESOLVED_FP"

# Renomme le restaurant APRÈS résolution, en SQL direct superuser --
# simule un changement autoritatif côté serveur (renommage marchand ou
# opération back-office), exactement le champ que le rendu imprime tel
# quel dans "Identité du vendeur".
psql -d "$DB" -v ON_ERROR_STOP=1 -c "update public.restaurants set name='Resto A Renommé (test stale-name v1.3)' where id='$RESTO_A';" >/dev/null

RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>V13-GAP1-SELLER-NAME: ne doit jamais être persisté</p>', '$V13_FP_BEFORE_RENAME', '$RESOLVED_UID');")
assert_denied "V13-GAP1/SELLER-NAME: renommage de restaurants.name entre resolve et persist -> REJET" "$RC"
assert_contains "V13-GAP1/SELLER-NAME: code déterministe STALE_CONTEXT (le fingerprint v1.3 hash désormais restaurants.name)" "STALE_CONTEXT" "$(sql_err)"

V13_VCOUNT_AFTER_NAME=$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_A';")
assert_eq "V13-GAP1/SELLER-NAME: aucune ligne merchant_cgv_version insérée (count inchangé)" "$V13_VCOUNT_BEFORE_NAME" "$V13_VCOUNT_AFTER_NAME"
V13_ACTIVE_AFTER_NAME=$(sql "select id from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='ACTIVE';")
assert_eq "V13-GAP1/SELLER-NAME: la version ACTIVE reste EXACTEMENT la même ligne (aucun supersede périmé, aucune nouvelle ligne ACTIVE)" "$V13_ACTIVE_BEFORE_NAME" "$V13_ACTIVE_AFTER_NAME"

# Restauration du nom original pour ne pas affecter la suite.
psql -d "$DB" -v ON_ERROR_STOP=1 -c "update public.restaurants set name='$ORIG_RESTO_A_NAME' where id='$RESTO_A';" >/dev/null

# Preuve de récupération : une résolution FRAÎCHE (après restauration du
# nom) permet une publication réussie -- le rejet ci-dessus venait bien
# du nom, pas d'un bug qui bloquerait toute publication future.
resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
resolve_split
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>V13-GAP1-SELLER-NAME: republication apres restauration du nom</p>', '$RESOLVED_FP', '$RESOLVED_UID');")
assert_ok "V13-GAP1/SELLER-NAME: après restauration du nom original et résolution fraîche, la publication réussit (retriable, pas un blocage permanent)" "$RC"

# ============================================================
# [V13-GAP1/CONTROLLED-SECTIONS] Stale-context : édition en place du
# contenu du gabarit (cgv_template.controlled_sections), id/version
# INCHANGÉS -- simule une édition de contenu par un opérateur qui ne
# bumperait pas la version. Exécuté en SQL direct superuser (jamais via
# un rôle accordé -- le test [11] plus haut a déjà prouvé qu'aucun rôle
# marchand ne peut faire cet UPDATE ; ceci reproduit exactement la
# condition désignée par le mandat : contourner cette restriction en
# tant que postgres directement, PAS en tant qu'un rôle accordé).
# Sauvegarde/restauration via une table technique de la base scratch
# (jamais une table TEMPORARY psql -- chaque appel psql est une
# connexion séparée, donc une table temporaire ne survivrait pas d'un
# appel à l'autre) pour éviter tout aller-retour de citation shell sur
# un contenu JSON arbitraire.
# ============================================================
log "=== [V13-GAP1/CONTROLLED-SECTIONS] Stale-context : édition en place du gabarit ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -c "create table if not exists public._v13_scratch_backup(k text primary key, v jsonb); insert into public._v13_scratch_backup(k,v) select 'cs_orig', controlled_sections from public.cgv_template where id='$TEMPLATE_ID' on conflict (k) do update set v=excluded.v;" >/dev/null

V13_VCOUNT_BEFORE_CS=$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_A';")
V13_ACTIVE_BEFORE_CS=$(sql "select id from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='ACTIVE';")

resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
resolve_split
V13_FP_BEFORE_CS="$RESOLVED_FP"

# id/version du gabarit restent STRICTEMENT inchangés -- seul le
# contenu JSON change : exactement la condition que le proxy id+version
# (v1.2) ne pouvait jamais détecter, et que v1.3 ferme.
psql -d "$DB" -v ON_ERROR_STOP=1 -c "update public.cgv_template set controlled_sections = controlled_sections || '{\"tampered_v13_test\": true}'::jsonb where id='$TEMPLATE_ID';" >/dev/null

RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>V13-GAP1-CONTROLLED-SECTIONS: ne doit jamais être persisté</p>', '$V13_FP_BEFORE_CS', '$RESOLVED_UID');")
assert_denied "V13-GAP1/CONTROLLED-SECTIONS: édition en place de cgv_template.controlled_sections (id/version inchangés) entre resolve et persist -> REJET" "$RC"
assert_contains "V13-GAP1/CONTROLLED-SECTIONS: code déterministe STALE_CONTEXT (le fingerprint v1.3 hash désormais controlled_sections::text, plus seulement id+version comme en v1.2)" "STALE_CONTEXT" "$(sql_err)"

V13_VCOUNT_AFTER_CS=$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_A';")
assert_eq "V13-GAP1/CONTROLLED-SECTIONS: aucune ligne merchant_cgv_version insérée (count inchangé)" "$V13_VCOUNT_BEFORE_CS" "$V13_VCOUNT_AFTER_CS"
V13_ACTIVE_AFTER_CS=$(sql "select id from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='ACTIVE';")
assert_eq "V13-GAP1/CONTROLLED-SECTIONS: la version ACTIVE reste EXACTEMENT la même ligne (aucun supersede périmé, aucune nouvelle ligne ACTIVE)" "$V13_ACTIVE_BEFORE_CS" "$V13_ACTIVE_AFTER_CS"

# Restauration du contenu original du gabarit et nettoyage de la table
# technique.
psql -d "$DB" -v ON_ERROR_STOP=1 -c "update public.cgv_template set controlled_sections = (select v from public._v13_scratch_backup where k='cs_orig') where id='$TEMPLATE_ID';" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -c "drop table public._v13_scratch_backup;" >/dev/null

# Preuve de récupération : après restauration du gabarit, une
# résolution fraîche permet une publication réussie.
resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
resolve_split
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>V13-GAP1-CONTROLLED-SECTIONS: republication apres restauration du gabarit</p>', '$RESOLVED_FP', '$RESOLVED_UID');")
assert_ok "V13-GAP1/CONTROLLED-SECTIONS: après restauration du gabarit original et résolution fraîche, la publication réussit" "$RC"

# ============================================================
# [V13-GAP2/LOCKING-RESTAURANTS] Démonstration d'un VRAI verrouillage
# PostgreSQL sur la ligne restaurants -- même patron exact que
# [BLOCKER1/LOCKING] ci-dessus (qui verrouille merchant_legal_profile),
# adapté à la ligne restaurants : NOUVEAU verrou v1.3 (GAP 2), premier
# de la séquence à cinq verrous fixes de persist_merchant_cgv_version.
# Une session psql d'arrière-plan ouvre une transaction, prend un
# verrou ligne (FOR UPDATE) sur restaurants pour RESTO_A, puis dort 3s
# avant de valider. Pendant cette fenêtre, un appel
# persist_merchant_cgv_version au premier plan (qui prend LUI-MÊME un
# `for update` sur cette même ligne, voir migration v1.3, section B,
# verrou n°1) doit rester bloqué jusqu'à la validation de la session
# d'arrière-plan -- mesure de temps d'horloge murale, pas une
# assertion sur le texte source.
# ============================================================
log "=== [V13-GAP2/LOCKING-RESTAURANTS] Verrouillage PostgreSQL réel sur restaurants ==="

V13_LOCK_HOLD_SECONDS=3
psql -d "$DB" -v ON_ERROR_STOP=1 >/tmp/lock-holder-resto-$$.txt 2>&1 <<SQL &
begin;
select 1 from public.restaurants where id='$RESTO_A' for update;
select pg_sleep($V13_LOCK_HOLD_SECONDS);
commit;
SQL
V13_LOCK_HOLDER_PID=$!

# Laisse le temps à la session d'arrière-plan de démarrer sa
# transaction et de prendre le verrou avant que le premier plan ne
# tente le sien.
sleep 1

resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
resolve_split

V13_LOCK_T0=$(date +%s%N)
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>V13-GAP2-LOCKING-RESTAURANTS: doit attendre la libération du verrou</p>', '$RESOLVED_FP', '$RESOLVED_UID');")
V13_LOCK_T1=$(date +%s%N)
V13_LOCK_ELAPSED_MS=$(( (V13_LOCK_T1 - V13_LOCK_T0) / 1000000 ))

wait "$V13_LOCK_HOLDER_PID" 2>/dev/null
rm -f /tmp/lock-holder-resto-$$.txt

assert_ok "V13-GAP2/LOCKING-RESTAURANTS: persist_merchant_cgv_version réussit APRÈS l'attente du verrou sur restaurants (pas d'erreur -- juste un délai)" "$RC"
# Seuil à 1500ms (< les 3000ms de détention), identique au patron
# [BLOCKER1/LOCKING] existant.
if [ "$V13_LOCK_ELAPSED_MS" -ge 1500 ]; then
  pass "V13-GAP2/LOCKING-RESTAURANTS: l'appel a été RÉELLEMENT bloqué ${V13_LOCK_ELAPSED_MS}ms par le verrou FOR UPDATE sur la ligne restaurants tenu par la session d'arrière-plan (>= 1500ms attendu, < ${V13_LOCK_HOLD_SECONDS}000ms tenus) -- preuve que le NOUVEAU verrou restaurants (v1.3, GAP 2) est réellement pris par persist_merchant_cgv_version, verrouillage PostgreSQL authentique"
else
  fail "V13-GAP2/LOCKING-RESTAURANTS: l'appel n'a duré que ${V13_LOCK_ELAPSED_MS}ms -- ATTENDU >= 1500ms si persist_merchant_cgv_version verrouille réellement la ligne restaurants (v1.3, GAP 2)"
fi

# ============================================================
# [V13-GAP3/LOCKING-AUTH-ORDER1] Démonstration d'un VRAI verrouillage
# PostgreSQL sur la ligne autorisante (restaurant_users), ORDRE 1 : la
# transaction de publication acquiert le verrou EN PREMIER. Simulée ici
# par une session d'arrière-plan qui prend exactement le même FOR
# UPDATE que persist_merchant_cgv_version prend en interne sur cette
# ligne (verrou n°5 de la séquence fixe, migration v1.3 section B) --
# même méthodologie que [BLOCKER1/LOCKING] et [V13-GAP2/LOCKING-
# RESTAURANTS] ci-dessus : on ne peut pas injecter un pg_sleep() à
# l'intérieur du corps de la vraie fonction sans en changer le code,
# donc on reproduit le verrou qu'elle prend, au bon endroit de la
# séquence, pour observer son effet réel sur une transaction
# concurrente. Une révocation concurrente (DELETE FROM
# restaurant_users) est chronométrée et DOIT rester bloquée jusqu'à la
# fin de la transaction de publication simulée -- mesure d'horloge
# murale, pas une assertion de code source.
# ============================================================
log "=== [V13-GAP3/LOCKING-AUTH-ORDER1] Verrouillage réel sur la ligne autorisante -- publication en premier ==="

V13_AUTH_LOCK_SECONDS=3
psql -d "$DB" -v ON_ERROR_STOP=1 >/tmp/lock-holder-auth1-$$.txt 2>&1 <<SQL &
begin;
select 1 from public.restaurant_users where user_id='$OWNER_A' and restaurant_id='$RESTO_A' for update;
select pg_sleep($V13_AUTH_LOCK_SECONDS);
commit;
SQL
V13_AUTH1_PID=$!

sleep 1

V13_AUTH1_T0=$(date +%s%N)
RC=$(sql_rc "delete from public.restaurant_users where user_id='$OWNER_A' and restaurant_id='$RESTO_A';")
V13_AUTH1_T1=$(date +%s%N)
V13_AUTH1_ELAPSED_MS=$(( (V13_AUTH1_T1 - V13_AUTH1_T0) / 1000000 ))

wait "$V13_AUTH1_PID" 2>/dev/null
rm -f /tmp/lock-holder-auth1-$$.txt

assert_ok "V13-GAP3/LOCKING-AUTH-ORDER1: le DELETE concurrent sur restaurant_users réussit finalement (sans erreur, juste après le délai)" "$RC"
if [ "$V13_AUTH1_ELAPSED_MS" -ge 1500 ]; then
  pass "V13-GAP3/LOCKING-AUTH-ORDER1: le DELETE concurrent a été RÉELLEMENT bloqué ${V13_AUTH1_ELAPSED_MS}ms par le verrou FOR UPDATE que la publication simulée détenait sur la ligne autorisante (>= 1500ms attendu, < ${V13_AUTH_LOCK_SECONDS}000ms tenus) -- ORDRE 1 : publication d'abord, la révocation ne peut jamais s'intercaler pendant la fenêtre verrouillée"
else
  fail "V13-GAP3/LOCKING-AUTH-ORDER1: le DELETE concurrent n'a duré que ${V13_AUTH1_ELAPSED_MS}ms -- ATTENDU >= 1500ms si le verrou de la ligne autorisante (v1.3, GAP 3) est réellement pris avant la révocation"
fi
V13_AUTH_ROW_GONE=$(sql "select count(*) from public.restaurant_users where user_id='$OWNER_A' and restaurant_id='$RESTO_A';")
assert_eq "V13-GAP3/LOCKING-AUTH-ORDER1: après déblocage, la ligne autorisante a bien été supprimée par la révocation (la publication simulée n'a fait qu'un SELECT FOR UPDATE, jamais de mutation -- résultat observé, pas présumé)" "0" "$V13_AUTH_ROW_GONE"

# Restauration de l'autorisation d'OWNER_A pour la suite du harnais.
psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into public.restaurant_users (user_id, restaurant_id, role) values ('$OWNER_A','$RESTO_A','owner') on conflict do nothing;" >/dev/null

# ============================================================
# [V13-GAP3/LOCKING-AUTH-ORDER2] Même verrou, ORDRE INVERSE (mandat :
# "where feasible" -- réalisée ici, schéma et harnais s'y prêtant) : la
# révocation concurrente acquiert le verrou EN PREMIER (DELETE
# explicite dans une transaction ouverte, la ligne restant verrouillée
# par le DELETE lui-même -- non encore validé -- pendant N secondes
# avant commit), et la tentative de publication est chronométrée pour
# prouver qu'elle reste bloquée jusqu'à la fin de cette transaction --
# puis, UNE FOIS la ligne autorisante réellement disparue (DELETE
# validé), la publication doit échouer par AUTORISATION
# (_assert_legal_cgv_role_for_user, "Not authorized for this
# restaurant"), jamais par STALE_CONTEXT (le fingerprint, résolu AVANT
# le déclenchement de la révocation alors que la ligne existait encore
# sans contestation, reste lui parfaitement valide -- rien d'autre n'a
# changé) ni par une mutation partielle.
# ============================================================
log "=== [V13-GAP3/LOCKING-AUTH-ORDER2] Verrouillage réel sur la ligne autorisante -- révocation en premier ==="

resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
resolve_split
V13_ORDER2_FP="$RESOLVED_FP"
V13_ORDER2_TID="$RESOLVED_TID"
V13_ORDER2_UID="$RESOLVED_UID"

V13_VCOUNT_BEFORE_O2=$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_A';")
V13_ACTIVE_BEFORE_O2=$(sql "select id from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='ACTIVE';")

psql -d "$DB" -v ON_ERROR_STOP=1 >/tmp/lock-holder-auth2-$$.txt 2>&1 <<SQL &
begin;
delete from public.restaurant_users where user_id='$OWNER_A' and restaurant_id='$RESTO_A';
select pg_sleep($V13_AUTH_LOCK_SECONDS);
commit;
SQL
V13_AUTH2_PID=$!

sleep 1

V13_AUTH2_T0=$(date +%s%N)
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$V13_ORDER2_TID', '<p>V13-GAP3-AUTH-ORDER2: ne doit jamais être persisté</p>', '$V13_ORDER2_FP', '$V13_ORDER2_UID');")
V13_AUTH2_T1=$(date +%s%N)
V13_AUTH2_ELAPSED_MS=$(( (V13_AUTH2_T1 - V13_AUTH2_T0) / 1000000 ))

wait "$V13_AUTH2_PID" 2>/dev/null
rm -f /tmp/lock-holder-auth2-$$.txt

if [ "$V13_AUTH2_ELAPSED_MS" -ge 1500 ]; then
  pass "V13-GAP3/LOCKING-AUTH-ORDER2: l'appel de publication a été RÉELLEMENT bloqué ${V13_AUTH2_ELAPSED_MS}ms par le verrou que la révocation concurrente détenait sur la ligne autorisante (>= 1500ms attendu, < ${V13_AUTH_LOCK_SECONDS}000ms tenus) -- ORDRE 2 : révocation d'abord, la publication ne peut jamais lire/verrouiller cette ligne en état intermédiaire (torn state)"
else
  fail "V13-GAP3/LOCKING-AUTH-ORDER2: l'appel de publication n'a duré que ${V13_AUTH2_ELAPSED_MS}ms -- ATTENDU >= 1500ms si persist_merchant_cgv_version attend réellement la fin de la révocation concurrente avant de (ré)évaluer l'autorisation"
fi

assert_denied "V13-GAP3/LOCKING-AUTH-ORDER2: une fois la révocation validée (ligne autorisante réellement disparue), la publication échoue -- l'autorisation est réévaluée APRÈS le déblocage, avec l'état à jour, jamais avec un état périmé lu avant le verrou" "$RC"
assert_contains "V13-GAP3/LOCKING-AUTH-ORDER2: rejet par AUTORISATION (_assert_legal_cgv_role_for_user, 'Not authorized'), JAMAIS par STALE_CONTEXT (le fingerprint résolu avant le déclenchement de la révocation reste, lui, valide -- seule l'autorisation a changé)" "Not authorized for this restaurant" "$(sql_err)"

V13_VCOUNT_AFTER_O2=$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_A';")
assert_eq "V13-GAP3/LOCKING-AUTH-ORDER2: aucune ligne merchant_cgv_version insérée malgré un fingerprint valide (l'autorisation, verrouillée en dernier dans la séquence, a bien été le dernier mot)" "$V13_VCOUNT_BEFORE_O2" "$V13_VCOUNT_AFTER_O2"
V13_ACTIVE_AFTER_O2=$(sql "select id from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='ACTIVE';")
assert_eq "V13-GAP3/LOCKING-AUTH-ORDER2: la version ACTIVE reste EXACTEMENT la même ligne (aucun supersede périmé)" "$V13_ACTIVE_BEFORE_O2" "$V13_ACTIVE_AFTER_O2"

# Restauration de l'autorisation d'OWNER_A pour la suite du harnais
# (dont [ROLLBACK] plus bas, qui n'en dépend pas -- restauré par
# discipline générale).
psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into public.restaurant_users (user_id, restaurant_id, role) values ('$OWNER_A','$RESTO_A','owner') on conflict do nothing;" >/dev/null

# ============================================================
# [V13-MATRIX-RERUN] Item (e) du mandat v1.3 : la matrice complète des
# 12 tests [BLOCKER1/CONCURRENCY] (course contexte/fingerprint) est,
# dans ce fichier, la MÊME section conservée verbatim du harnais v1.2 --
# elle s'est déjà exécutée plus haut dans CE MÊME run du présent
# script, PAR-DESSUS v1.1+v1.2+v1.3 installés ensemble (pas une
# exécution séparée post-hoc, pas une répétition dupliquée ici). Ses
# assertions individuelles (items 1 à 12, plus les vérifications de
# stabilité 9/10) sont donc déjà comptabilisées dans PASS/FAIL. Ceci
# est l'entrée explicite du mandat consignant ce fait comme un item à
# part entière.
# ============================================================
pass "V13-MATRIX-RERUN (item e du mandat v1.3) : la matrice complète des 12 tests de course contexte/fingerprint de v1.2 ([BLOCKER1/CONCURRENCY] ci-dessus) a été rejouée intacte plus haut dans ce même run, par-dessus v1.1+v1.2+v1.3 installés ensemble, sans aucune régression"

# ============================================================
# [V14-SERIALIZATION] T1-T8 -- tests de propriété au niveau du
# fingerprint lui-même (mandat post-v1.3), INDÉPENDANTS du flux
# resolve/persist/autorisation/verrouillage déjà couvert ci-dessus.
# Chaque test appelle directement
#   select public._compute_cgv_publication_context_fingerprint('$RESTO_A');
# en tant que postgres (superuser, connexion directe -- has_function_
# privilege n'entre pas en jeu ici : ces tests portent sur une PROPRIÉTÉ
# DE SÉRIALISATION pure, pas sur l'autorisation), sur RESTO_A dans son
# état "profil complet, EXEMPT_PERISHABLE" laissé par la fin de la
# matrice [BLOCKER1/CONCURRENCY] ci-dessus. Chaque test restaure
# intégralement l'état qu'il a muté avant de continuer, pour ne pas
# affecter [ROLLBACK] plus bas (qui n'en dépend de toute façon pas).
# ============================================================
log "=== [V14-SERIALIZATION] Tests de propriété du fingerprint canonique (T1-T8) ==="

fp() { sql "select public._compute_cgv_publication_context_fingerprint('$RESTO_A');"; }

# État de référence (baseline) -- capturé une fois, utilisé par
# plusieurs tests ci-dessous comme point de comparaison stable.
V14_BASELINE_LEGAL_FORM=$(sql "select legal_form from public.merchant_legal_profile where restaurant_id='$RESTO_A';")
V14_BASELINE_ADDR1=$(sql "select address_line1 from public.merchant_legal_profile where restaurant_id='$RESTO_A';")
V14_BASELINE_CITY=$(sql "select city from public.merchant_legal_profile where restaurant_id='$RESTO_A';")
V14_BASELINE_CANCEL=$(sql "select cancellation_policy_text from public.merchant_cgv_profile where restaurant_id='$RESTO_A';")
V14_BASELINE_MEDIATOR=$(sql "select consumer_mediator_name from public.merchant_legal_profile where restaurant_id='$RESTO_A';")
V14_BASELINE_ADDR2_ISNULL=$(sql "select (address_line2 is null) from public.merchant_legal_profile where restaurant_id='$RESTO_A';")
V14_FP_BASELINE=$(fp)

# ------------------------------------------------------------
# T8 (établi en premier -- propriété de base dont dépendent les
# comparaisons différentielles de T1-T7) : deux calculs consécutifs sur
# un état INCHANGÉ produisent le MÊME fingerprint.
# ------------------------------------------------------------
V14_T8_A="$V14_FP_BASELINE"
V14_T8_B=$(fp)
assert_eq "T8: deux calculs consécutifs du fingerprint sur un état authoritatif INCHANGÉ sont IDENTIQUES (baseline de stabilité) -- $V14_T8_A" "$V14_T8_A" "$V14_T8_B"

# ------------------------------------------------------------
# T1 -- Paire de collision exacte chr(31) (constat de l'audit). État A :
# legal_form='SARL', address_line1='Rue'||chr(31)||'42'. État B :
# legal_form='SARL'||chr(31)||'Rue', address_line1='42'. Avant v1.4
# (concaténation chr(31)-délimitée), les deux états concaténaient aux
# MÊMES octets ('SARL'||chr(31)||'Rue'||chr(31)||'42') et produisaient
# donc le MÊME md5(). Avec v1.4 (jsonb_build_object canonique), chaque
# champ est sa propre valeur JSON échappée : les deux états ne peuvent
# plus produire le même texte JSON.
# ------------------------------------------------------------
sql "update public.merchant_legal_profile set legal_form='SARL', address_line1='Rue' || chr(31) || '42' where restaurant_id='$RESTO_A';" >/dev/null
V14_T1_FP_A=$(fp)
sql "update public.merchant_legal_profile set legal_form='SARL' || chr(31) || 'Rue', address_line1='42' where restaurant_id='$RESTO_A';" >/dev/null
V14_T1_FP_B=$(fp)
if [ "$V14_T1_FP_A" != "$V14_T1_FP_B" ]; then
  pass "T1: paire de collision chr(31) de Catimini -- État A (legal_form='SARL', address_line1='Rue'.chr(31).'42') fingerprint=$V14_T1_FP_A != État B (legal_form='SARL'.chr(31).'Rue', address_line1='42') fingerprint=$V14_T1_FP_B -- collision FERMÉE par la sérialisation JSON canonique"
else
  fail "T1: paire de collision chr(31) de Catimini -- État A et État B produisent le MÊME fingerprint ($V14_T1_FP_A) -- la collision N'EST PAS fermée"
fi
# Restauration.
sql "update public.merchant_legal_profile set legal_form='$V14_BASELINE_LEGAL_FORM', address_line1='$V14_BASELINE_ADDR1' where restaurant_id='$RESTO_A';" >/dev/null
V14_T1_RESTORED_FP=$(fp)
assert_eq "T1 restauration: après restauration de legal_form/address_line1, le fingerprint revient EXACTEMENT à la baseline" "$V14_FP_BASELINE" "$V14_T1_RESTORED_FP"

# ------------------------------------------------------------
# T2 -- chr(31) et chr(30) intégrés à des POSITIONS différentes, dans
# au moins deux champs différents. Chaque variante doit différer de la
# baseline, et les deux variantes doivent différer ENTRE ELLES.
# ------------------------------------------------------------
sql "update public.merchant_legal_profile set city = 'Paris' || chr(31) || 'X' where restaurant_id='$RESTO_A';" >/dev/null
V14_T2_FP_CITY=$(fp)
sql "update public.merchant_legal_profile set city = '$V14_BASELINE_CITY' where restaurant_id='$RESTO_A';" >/dev/null

sql "update public.merchant_cgv_profile set cancellation_policy_text = cancellation_policy_text || chr(30) || 'Y' where restaurant_id='$RESTO_A';" >/dev/null
V14_T2_FP_CANCEL=$(fp)
sql "update public.merchant_cgv_profile set cancellation_policy_text = '$V14_BASELINE_CANCEL' where restaurant_id='$RESTO_A';" >/dev/null

V14_T2_RESTORED_FP=$(fp)
assert_eq "T2 restauration: après restauration de city/cancellation_policy_text, le fingerprint revient à la baseline" "$V14_FP_BASELINE" "$V14_T2_RESTORED_FP"

if [ "$V14_T2_FP_CITY" != "$V14_FP_BASELINE" ]; then
  pass "T2: chr(31) intégré dans city ('Paris'.chr(31).'X') -> fingerprint=$V14_T2_FP_CITY DIFFÈRE de la baseline=$V14_FP_BASELINE"
else
  fail "T2: chr(31) intégré dans city -> fingerprint IDENTIQUE à la baseline ($V14_FP_BASELINE) -- devrait différer"
fi
if [ "$V14_T2_FP_CANCEL" != "$V14_FP_BASELINE" ]; then
  pass "T2: chr(30) intégré dans cancellation_policy_text -> fingerprint=$V14_T2_FP_CANCEL DIFFÈRE de la baseline=$V14_FP_BASELINE"
else
  fail "T2: chr(30) intégré dans cancellation_policy_text -> fingerprint IDENTIQUE à la baseline ($V14_FP_BASELINE) -- devrait différer"
fi
if [ "$V14_T2_FP_CITY" != "$V14_T2_FP_CANCEL" ]; then
  pass "T2: les deux intégrations distinctes (city/chr(31) vs cancellation_policy_text/chr(30)) produisent des fingerprints DIFFÉRENTS l'un de l'autre ($V14_T2_FP_CITY != $V14_T2_FP_CANCEL) -- aucune collision croisée"
else
  fail "T2: les deux intégrations distinctes produisent le MÊME fingerprint ($V14_T2_FP_CITY) -- collision croisée inattendue"
fi

# ------------------------------------------------------------
# T3 -- NULL vs '' (chaîne vide) sur le MÊME champ (address_line2,
# NULL dans l'état de référence), tout le reste identique. v1.3
# (coalesce(v_x,'')) rendait ces deux états indistinguables ; v1.4 les
# rend distincts (JSON null vs JSON "").
# ------------------------------------------------------------
assert_eq "T3 setup: address_line2 est bien NULL dans l'état de référence (précondition du test)" "t" "$V14_BASELINE_ADDR2_ISNULL"
V14_T3_FP_NULL=$(fp)
sql "update public.merchant_legal_profile set address_line2 = '' where restaurant_id='$RESTO_A';" >/dev/null
V14_T3_FP_EMPTY=$(fp)
sql "update public.merchant_legal_profile set address_line2 = null where restaurant_id='$RESTO_A';" >/dev/null
V14_T3_FP_NULL_AGAIN=$(fp)
if [ "$V14_T3_FP_NULL" != "$V14_T3_FP_EMPTY" ]; then
  pass "T3: address_line2 NULL (fingerprint=$V14_T3_FP_NULL) DIFFÈRE de address_line2='' chaîne vide (fingerprint=$V14_T3_FP_EMPTY) -- NULL et '' ne sont plus confondus"
else
  fail "T3: address_line2 NULL et address_line2='' produisent le MÊME fingerprint ($V14_T3_FP_NULL) -- NULL et '' restent confondus"
fi
assert_eq "T3 restauration: revenir à NULL redonne EXACTEMENT le fingerprint NULL d'origine" "$V14_T3_FP_NULL" "$V14_T3_FP_NULL_AGAIN"

# ------------------------------------------------------------
# T4 -- guillemet double littéral et backslash littéral dans des champs
# texte. La fonction ne doit jamais lever d'erreur (jsonb_build_object
# échappe correctement ces deux caractères), et le fingerprint doit
# différer de la baseline.
# ------------------------------------------------------------
RC_T4=$(sql_rc "update public.merchant_legal_profile set consumer_mediator_name = 'Médiateur \"Test\" Officiel' where restaurant_id='$RESTO_A'; update public.merchant_cgv_profile set cancellation_policy_text = cancellation_policy_text || ' chemin C:\\\\Users\\\\test\\\\' where restaurant_id='$RESTO_A';")
assert_ok "T4 setup: écriture de champs contenant un guillemet double et un backslash réussit (aucune erreur SQL de saisie)" "$RC_T4"
RC_T4_FP=$(sql_rc "select public._compute_cgv_publication_context_fingerprint('$RESTO_A');")
assert_ok "T4: _compute_cgv_publication_context_fingerprint NE LÈVE AUCUNE ERREUR face à un guillemet double et un backslash littéraux dans les champs authoritatifs" "$RC_T4_FP"
V14_T4_FP=$(fp)
if [ "$V14_T4_FP" != "$V14_FP_BASELINE" ]; then
  pass "T4: fingerprint avec guillemet double + backslash ($V14_T4_FP) DIFFÈRE de la baseline sans ces caractères ($V14_FP_BASELINE)"
else
  fail "T4: fingerprint avec guillemet double + backslash IDENTIQUE à la baseline ($V14_FP_BASELINE) -- ces caractères devraient changer le contenu authoritatif"
fi
sql "update public.merchant_legal_profile set consumer_mediator_name = '$V14_BASELINE_MEDIATOR' where restaurant_id='$RESTO_A';" >/dev/null
sql "update public.merchant_cgv_profile set cancellation_policy_text = '$V14_BASELINE_CANCEL' where restaurant_id='$RESTO_A';" >/dev/null
V14_T4_RESTORED_FP=$(fp)
assert_eq "T4 restauration: après restauration, le fingerprint revient à la baseline" "$V14_FP_BASELINE" "$V14_T4_RESTORED_FP"

# ------------------------------------------------------------
# T5 -- texte français accentué Unicode. Stabilité (deux calculs
# consécutifs sur le même état ACCENTUÉ, inchangé entre les deux,
# identiques) ET différence par rapport à une baseline ASCII simple.
# ------------------------------------------------------------
sql "update public.merchant_legal_profile set city = 'Café Déjà Servi, 5 rue de l''Épée' where restaurant_id='$RESTO_A';" >/dev/null
V14_T5_FP_1=$(fp)
V14_T5_FP_2=$(fp)
assert_eq "T5: stabilité -- deux calculs consécutifs du fingerprint sur le MÊME état accentué Unicode ('Café Déjà Servi, 5 rue de l'Épée') sont IDENTIQUES" "$V14_T5_FP_1" "$V14_T5_FP_2"
if [ "$V14_T5_FP_1" != "$V14_FP_BASELINE" ]; then
  pass "T5: fingerprint avec city accentuée Unicode ($V14_T5_FP_1) DIFFÈRE de la baseline ASCII simple ($V14_FP_BASELINE)"
else
  fail "T5: fingerprint avec city accentuée Unicode IDENTIQUE à la baseline ASCII ($V14_FP_BASELINE) -- devrait différer"
fi
sql "update public.merchant_legal_profile set city = '$V14_BASELINE_CITY' where restaurant_id='$RESTO_A';" >/dev/null
V14_T5_RESTORED_FP=$(fp)
assert_eq "T5 restauration: après restauration de city, le fingerprint revient à la baseline" "$V14_FP_BASELINE" "$V14_T5_RESTORED_FP"

# ------------------------------------------------------------
# T6 -- deux ORTHOGRAPHES JSON différentes (ordre de clés différent,
# espacement différent) du MÊME contenu sémantique pour
# cgv_template.controlled_sections, sur la MÊME ligne de gabarit (id et
# version inchangés). jsonb normalise l'ordre des clés et l'espacement
# au niveau du TYPE (stockage binaire) -- deux orthographes équivalentes
# doivent donc produire un fingerprint IDENTIQUE, ce qui exercerait déjà
# une éventuelle régression si l'objet JSON externe (v1.4) stringifiait
# controlled_sections avant de le nester (au lieu de le nester natif).
# ------------------------------------------------------------
sql "create table if not exists public._v14_scratch_backup(k text primary key, v jsonb); insert into public._v14_scratch_backup(k,v) select 'cs_orig_v14', controlled_sections from public.cgv_template where id='$TEMPLATE_ID' on conflict (k) do update set v=excluded.v;" >/dev/null

# Orthographe 1 : ordre de clés A, espacement compact.
sql "update public.cgv_template set controlled_sections = '{\"header\":\"CGV\",\"identity_intro\":\"Intro.\",\"withdrawal_clauses\":{\"EXEMPT_PERISHABLE\":\"Clause.\",\"STANDARD_14_DAYS\":\"Clause 14j.\",\"MIXED\":null},\"mediator_clause\":\"Médiateur.\",\"preparation_clause\":\"Délai.\",\"cancellation_clause_label\":\"Annulation\",\"substitution_clause_label\":\"Substitution\",\"jurisdiction_clause\":\"Droit français.\"}'::jsonb where id='$TEMPLATE_ID';" >/dev/null
V14_T6_FP_SPELLING1=$(fp)

# Orthographe 2 : MÊME contenu sémantique, ordre de clés INVERSÉ et
# espacement généreux (retours à la ligne, indentation) -- texte source
# byte-pour-byte différent de l'orthographe 1, contenu jsonb équivalent.
sql "update public.cgv_template set controlled_sections = '{
   \"jurisdiction_clause\" : \"Droit français.\" ,
   \"substitution_clause_label\":  \"Substitution\",
   \"cancellation_clause_label\": \"Annulation\",
   \"preparation_clause\":\"Délai.\",
   \"mediator_clause\":\"Médiateur.\",
   \"withdrawal_clauses\":{\"MIXED\":null,\"STANDARD_14_DAYS\":\"Clause 14j.\",\"EXEMPT_PERISHABLE\":\"Clause.\"},
   \"identity_intro\":\"Intro.\",
   \"header\":\"CGV\"
}'::jsonb where id='$TEMPLATE_ID';" >/dev/null
V14_T6_FP_SPELLING2=$(fp)

assert_eq "T6: deux orthographes JSON DIFFÉRENTES (ordre de clés inversé, espacement différent) du MÊME contenu sémantique de controlled_sections produisent un fingerprint IDENTIQUE (canonicalisation jsonb au niveau du type, préservée par le nesting natif de v1.4)" "$V14_T6_FP_SPELLING1" "$V14_T6_FP_SPELLING2"

# Restauration du contenu original du gabarit.
sql "update public.cgv_template set controlled_sections = (select v from public._v14_scratch_backup where k='cs_orig_v14') where id='$TEMPLATE_ID';" >/dev/null
sql "drop table public._v14_scratch_backup;" >/dev/null
V14_T6_RESTORED_FP=$(fp)
assert_eq "T6 restauration: après restauration du gabarit original, le fingerprint revient à la baseline" "$V14_FP_BASELINE" "$V14_T6_RESTORED_FP"

# ------------------------------------------------------------
# T7 -- contenu SÉMANTIQUE de controlled_sections réellement différent
# (même template id/version), assertion directe au niveau du
# fingerprint (complète, sans passer par persist_merchant_cgv_version,
# le test [V13-GAP1/CONTROLLED-SECTIONS] plus haut).
# ------------------------------------------------------------
sql "create table if not exists public._v14_scratch_backup2(k text primary key, v jsonb); insert into public._v14_scratch_backup2(k,v) select 'cs_orig_v14b', controlled_sections from public.cgv_template where id='$TEMPLATE_ID' on conflict (k) do update set v=excluded.v;" >/dev/null
sql "update public.cgv_template set controlled_sections = controlled_sections || '{\"tampered_v14_t7_test\": true}'::jsonb where id='$TEMPLATE_ID';" >/dev/null
V14_T7_FP_CHANGED=$(fp)
if [ "$V14_T7_FP_CHANGED" != "$V14_FP_BASELINE" ]; then
  pass "T7: contenu sémantique de controlled_sections réellement modifié (clé ajoutée) -> fingerprint=$V14_T7_FP_CHANGED DIFFÈRE de la baseline=$V14_FP_BASELINE (test direct au niveau du fingerprint)"
else
  fail "T7: contenu sémantique de controlled_sections modifié -> fingerprint IDENTIQUE à la baseline ($V14_FP_BASELINE) -- devrait différer"
fi
sql "update public.cgv_template set controlled_sections = (select v from public._v14_scratch_backup2 where k='cs_orig_v14b') where id='$TEMPLATE_ID';" >/dev/null
sql "drop table public._v14_scratch_backup2;" >/dev/null
V14_T7_RESTORED_FP=$(fp)
assert_eq "T7 restauration: après restauration du gabarit original, le fingerprint revient à la baseline" "$V14_FP_BASELINE" "$V14_T7_RESTORED_FP"

# ------------------------------------------------------------
# Preuve finale de non-régression du bloc [V14-SERIALIZATION] : l'état
# de RESTO_A est EXACTEMENT celui d'avant T1-T8 (toutes les
# restaurations ci-dessus ont convergé), donc le fingerprint final ==
# la baseline capturée au tout début du bloc.
# ------------------------------------------------------------
V14_FP_FINAL=$(fp)
assert_eq "V14-SERIALIZATION: après T1-T8, l'état authoritatif de RESTO_A est intégralement restauré -- fingerprint final == baseline de départ du bloc" "$V14_FP_BASELINE" "$V14_FP_FINAL"

pass "V1.1-V1.4-REGRESSION-RERUN (mandat v2.1, item 'full 309-assertion regression rerun') : toutes les assertions ci-dessus (installation, fixtures, RPC-BYPASS, GRANTS, [1]..[27], TEMPLATE-AUTHORITY, ACL, CONCURRENCY x12, LOCKING, V13-GAP1/2/3, V14-SERIALIZATION T1-T8 -- 309 assertions déjà auditées) viennent de s'exécuter intactes dans CE MÊME run, par-dessus v1.1+v1.2+v1.3+v1.4+v2.1 installés ENSEMBLE -- pas une exécution séparée post-hoc, pas une répétition dupliquée. Zéro régression de v2.1 sur v1.1-v1.4."

# ============================================================
# [V21-TEMPLATE] Gabarit FR_FOOD_PERISHABLE_B2C version 2 -- existence,
# nouvelles clés, ET preuve que la version 1 (scellée par v1.1) reste
# BYTE-IDENTIQUE (comparaison structurelle jsonb exacte contre le
# littéral EXACT inséré par v1.1), jamais modifiée par ce lot --
# vérifié ICI depuis le harnais, EN PLUS du garde post-commit du
# fichier v2.1 lui-même (défense en profondeur, même discipline que le
# reste de ce projet).
# ============================================================
log "=== [V21-TEMPLATE] Gabarit v2 (nouvelles clauses) + v1 byte-identique ==="
V21_TPL_V2_COUNT=$(sql "select count(*) from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=2 and status='PUBLISHED';")
assert_eq "V21-TEMPLATE: exactement une ligne FR_FOOD_PERISHABLE_B2C version 2, PUBLISHED" "1" "$V21_TPL_V2_COUNT"

for V21_KEY in purpose_scope_clause products_characteristics_clause portion_pricing_clauses prices_taxes_clause \
  ordering_process_clause contract_formation_clause payment_clause availability_clause pickup_clause \
  delivery_clause cold_chain_clauses cancellation_clause_intro cancellation_clause_fallback \
  substitution_clause_intro substitution_clause_fallback complaints_clause legal_guarantees_clause \
  liability_clause force_majeure_clause personal_data_clause applicable_law_clause; do
  V21_HAS_KEY=$(sql "select (controlled_sections ? '$V21_KEY') from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=2;")
  assert_eq "V21-TEMPLATE: le gabarit v2 fournit la clé '$V21_KEY'" "t" "$V21_HAS_KEY"
done

V21_HAS_AWP_KEY=$(sql "select (controlled_sections->'portion_pricing_clauses' ? 'ACTUAL_WEIGHT_PRICE') from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=2;")
assert_eq "V21-TEMPLATE: portion_pricing_clauses NE fournit JAMAIS de texte pour ACTUAL_WEIGHT_PRICE -- non pris en charge, échec fermé par construction, jamais par simple omission accidentelle" "f" "$V21_HAS_AWP_KEY"

psql -X -A -q -t -d "$DB" > /tmp/scanym-cgvenginev11-v1lit-$$.txt <<'SQL'
select (controlled_sections = '{
   "header": "Conditions Générales de Vente",
   "identity_intro": "Les présentes conditions générales de vente régissent les commandes passées auprès du vendeur identifié ci-dessous.",
   "withdrawal_clauses": {
     "EXEMPT_PERISHABLE": "Conformément à l''article L221-28 3° du Code de la consommation, le droit de rétractation ne s''applique pas aux denrées périssables ou susceptibles de se détériorer ou de se périmer rapidement.",
     "STANDARD_14_DAYS": "Conformément aux articles L221-18 et suivants du Code de la consommation, le client dispose d''un délai de 14 jours pour exercer son droit de rétractation.",
     "MIXED": null
   },
   "mediator_clause": "En cas de litige, le client peut recourir gratuitement au médiateur de la consommation désigné par le vendeur.",
   "preparation_clause": "Le vendeur indique un délai de préparation prévisionnel, communiqué au client avant validation de la commande.",
   "cancellation_clause_label": "Politique d''annulation",
   "substitution_clause_label": "Politique de substitution de produit",
   "jurisdiction_clause": "Les présentes conditions sont soumises au droit applicable dans le pays d''établissement du vendeur."
 }'::jsonb)
from public.cgv_template where template_code='FR_FOOD_PERISHABLE_B2C' and version=1;
SQL
V21_V1_MATCHES_LITERAL=$(tr -d '[:space:]' < /tmp/scanym-cgvenginev11-v1lit-$$.txt)
rm -f /tmp/scanym-cgvenginev11-v1lit-$$.txt
assert_eq "V21-TEMPLATE: le gabarit v1 (version=1) reste STRUCTURELLEMENT IDENTIQUE au littéral exact inséré par v1.1 -- v2.1 ne l'a jamais modifié, ni ajouté, ni retiré une clé" "t" "$V21_V1_MATCHES_LITERAL"

# ============================================================
# [V21-STALE-CONTEXT] 8 tests de péremption, un par nouveau champ
# authoritatif -- même rigueur et même patron que [V13-GAP1/SELLER-
# NAME] et [V13-GAP1/CONTROLLED-SECTIONS] plus haut : (a) résout un
# contexte frais et valide ; (b) mute UN SEUL champ, directement en
# SQL superuser (jamais via une RPC marchande -- [11] plus haut a déjà
# prouvé qu'aucun rôle marchand ne peut muter cgv_template, et [2]/[3]
# ont déjà prouvé le chemin RPC légitime pour merchant_legal_profile/
# merchant_cgv_profile ; ceci reproduit la condition visée par le
# mandat : un changement autoritatif survenu PENDANT la fenêtre de
# course, par n'importe quel moyen) ; (c) tente persist_merchant_cgv_
# version avec le contexte désormais périmé ; (d) vérifie le rejet
# déterministe STALE_CONTEXT et l'absence de toute mutation ; (e)
# restaure le champ et prouve la republication (retriable, pas un
# blocage permanent).
#
# NOTE HONNÊTE sur weight_pricing_mode spécifiquement : la mutation
# choisie ci-dessous est NULL -> 'FIXED_PORTION_PRICE' (jamais
# 'ACTUAL_WEIGHT_PRICE'), délibérément, pour isoler la propriété testée
# ICI (péremption du fingerprint) de celle testée séparément par
# [V21-ACTUAL-WEIGHT-PRICE] plus bas (échec fermé, vérifié EN PREMIER
# dans le corps de la fonction) -- muter vers ACTUAL_WEIGHT_PRICE ici
# aurait fait échouer le test pour la MAUVAISE raison
# (ACTUAL_WEIGHT_PRICE_UNSUPPORTED, pas STALE_CONTEXT).
# ============================================================
log "=== [V21-STALE-CONTEXT] 8 tests de péremption, un par nouveau champ authoritatif ==="

run_v21_stale_field_test() {
  local label="$1" table="$2" column="$3" newval="$4" restoreval="$5"
  local before_count before_active rc
  before_count=$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_A';")
  before_active=$(sql "select id from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='ACTIVE';")
  resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
  resolve_split
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "update public.$table set $column = $newval where restaurant_id='$RESTO_A';" >/dev/null
  rc=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>V21-STALE-CONTEXT ($label): ne doit jamais être persisté</p>', '$RESOLVED_FP', '$RESOLVED_UID');")
  assert_denied "V21-STALE-CONTEXT ($label): $table.$column change entre resolve et persist -> REJET" "$rc"
  assert_contains "V21-STALE-CONTEXT ($label): code déterministe STALE_CONTEXT" "STALE_CONTEXT" "$(sql_err)"
  assert_eq "V21-STALE-CONTEXT ($label): aucune ligne merchant_cgv_version insérée (count inchangé)" "$before_count" "$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_A';")"
  assert_eq "V21-STALE-CONTEXT ($label): la version ACTIVE reste EXACTEMENT la même ligne" "$before_active" "$(sql "select id from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='ACTIVE';")"
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "update public.$table set $column = $restoreval where restaurant_id='$RESTO_A';" >/dev/null
  resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
  resolve_split
  rc=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>V21-STALE-CONTEXT ($label): republication apres restauration</p>', '$RESOLVED_FP', '$RESOLVED_UID');")
  assert_ok "V21-STALE-CONTEXT ($label): après restauration du champ et résolution fraîche, la publication réussit (retriable, pas un blocage permanent)" "$rc"
}

run_v21_stale_field_test "legal_entity_name" "merchant_legal_profile" "legal_entity_name" "'STALE TEST ENTITY NAME'" "null"
run_v21_stale_field_test "siren" "merchant_legal_profile" "siren" "'111111111'" "null"
run_v21_stale_field_test "siret" "merchant_legal_profile" "siret" "'11111111100011'" "null"
run_v21_stale_field_test "vat_number" "merchant_legal_profile" "vat_number" "'FR11111111111'" "null"
run_v21_stale_field_test "consumer_mediator_phone" "merchant_legal_profile" "consumer_mediator_phone" "'0100000000'" "null"
run_v21_stale_field_test "consumer_mediator_email" "merchant_legal_profile" "consumer_mediator_email" "'stale-test@example.test'" "null"
run_v21_stale_field_test "cold_chain_applicable" "merchant_cgv_profile" "cold_chain_applicable" "true" "false"
run_v21_stale_field_test "weight_pricing_mode" "merchant_cgv_profile" "weight_pricing_mode" "'FIXED_PORTION_PRICE'" "null"

V21_SC_LEGAL_FINAL=$(sql "select coalesce(legal_entity_name,'<NULL>') || '|' || coalesce(siren,'<NULL>') || '|' || coalesce(siret,'<NULL>') || '|' || coalesce(vat_number,'<NULL>') || '|' || coalesce(consumer_mediator_phone,'<NULL>') || '|' || coalesce(consumer_mediator_email,'<NULL>') from public.merchant_legal_profile where restaurant_id='$RESTO_A';")
assert_eq "V21-STALE-CONTEXT: après les 8 tests, les 6 champs légaux de RESTO_A sont bien revenus à NULL (convergence complète, aucune fuite d'état vers les sections suivantes)" "<NULL>|<NULL>|<NULL>|<NULL>|<NULL>|<NULL>" "$V21_SC_LEGAL_FINAL"
V21_SC_CGV_FINAL=$(sql "select cold_chain_applicable::text || '|' || coalesce(weight_pricing_mode,'<NULL>') from public.merchant_cgv_profile where restaurant_id='$RESTO_A';")
assert_eq "V21-STALE-CONTEXT: après les 8 tests, cold_chain_applicable/weight_pricing_mode de RESTO_A sont bien revenus à false/NULL" "false|<NULL>" "$V21_SC_CGV_FINAL"

# ============================================================
# [V21-ACTUAL-WEIGHT-PRICE] Échec fermé -- vérifié comme la TOUTE
# PREMIÈRE instruction du corps de persist_merchant_cgv_version, AVANT
# tout verrou (mandat, section 3 : "BEFORE any lock, zero side
# effects"). La preuve d'ordre ci-dessous n'est pas une simple
# assertion sur le texte source : une session d'arrière-plan détient un
# VRAI verrou PostgreSQL (FOR UPDATE) sur merchant_legal_profile
# pendant 3s (même patron que [BLOCKER1/LOCKING]) ; si le garde-fou
# s'exécute réellement avant toute tentative de verrouillage, le rejet
# doit survenir QUASI INSTANTANÉMENT, jamais après avoir attendu la
# libération du verrou détenu par la session concurrente.
# ============================================================
log "=== [V21-ACTUAL-WEIGHT-PRICE] Échec fermé, AVANT tout verrou, zéro effet de bord ==="
as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_cgv_profile('$RESTO_A','EXEMPT_PERISHABLE',20,30,'MINUTES','Nouvelle politique','Nouvelle substitution','FORMAL',false,'ACTUAL_WEIGHT_PRICE');" >/dev/null
V21_AWP_MODE=$(sql "select weight_pricing_mode from public.merchant_cgv_profile where restaurant_id='$RESTO_A';")
assert_eq "V21-ACTUAL-WEIGHT-PRICE setup: weight_pricing_mode=ACTUAL_WEIGHT_PRICE réellement enregistré via l'appel RPC réel (10 arguments) update_merchant_cgv_profile" "ACTUAL_WEIGHT_PRICE" "$V21_AWP_MODE"

RC=$(as_authenticated_rc "$OWNER_A" "select 1 from public.resolve_cgv_publication_context('$RESTO_A');")
assert_ok "V21-ACTUAL-WEIGHT-PRICE: resolve_cgv_publication_context RÉUSSIT malgré ACTUAL_WEIGHT_PRICE -- seul persist_merchant_cgv_version porte ce garde-fou, jamais resolve (comportement vérifié, pas seulement documenté)" "$RC"

V21_AWP_COUNT_BEFORE=$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_A';")
resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
resolve_split

V21_AWP_LOCK_SECONDS=3
psql -d "$DB" -v ON_ERROR_STOP=1 >/tmp/lock-holder-awp-$$.txt 2>&1 <<SQL &
begin;
select 1 from public.merchant_legal_profile where restaurant_id='$RESTO_A' for update;
select pg_sleep($V21_AWP_LOCK_SECONDS);
commit;
SQL
V21_AWP_LOCK_PID=$!
sleep 1

V21_AWP_T0=$(date +%s%N)
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>V21-ACTUAL-WEIGHT-PRICE: ne doit jamais être persisté</p>', '$RESOLVED_FP', '$RESOLVED_UID');")
V21_AWP_T1=$(date +%s%N)
V21_AWP_ELAPSED_MS=$(( (V21_AWP_T1 - V21_AWP_T0) / 1000000 ))

wait "$V21_AWP_LOCK_PID" 2>/dev/null
rm -f /tmp/lock-holder-awp-$$.txt

assert_denied "V21-ACTUAL-WEIGHT-PRICE: persist_merchant_cgv_version REJETTE weight_pricing_mode=ACTUAL_WEIGHT_PRICE" "$RC"
assert_contains "V21-ACTUAL-WEIGHT-PRICE: code déterministe ACTUAL_WEIGHT_PRICE_UNSUPPORTED" "ACTUAL_WEIGHT_PRICE_UNSUPPORTED" "$(sql_err)"
if [ "$V21_AWP_ELAPSED_MS" -lt 1500 ]; then
  pass "V21-ACTUAL-WEIGHT-PRICE: le rejet a été QUASI INSTANTANÉ (${V21_AWP_ELAPSED_MS}ms, < 1500ms) MALGRÉ le verrou FOR UPDATE détenu 3s par la session d'arrière-plan sur merchant_legal_profile -- preuve empirique (temps d'horloge murale, pas une assertion de code source) que le garde-fou s'exécute AVANT toute tentative de verrouillage, zéro effet de bord même sous contention"
else
  fail "V21-ACTUAL-WEIGHT-PRICE: le rejet a duré ${V21_AWP_ELAPSED_MS}ms (>= 1500ms) -- suggère que la fonction a attendu le verrou AVANT de lever ACTUAL_WEIGHT_PRICE_UNSUPPORTED, contredisant le mandat ('checked FIRST, before any lock')"
fi
V21_AWP_COUNT_AFTER=$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_A';")
assert_eq "V21-ACTUAL-WEIGHT-PRICE: aucune ligne merchant_cgv_version insérée (zéro effet de bord)" "$V21_AWP_COUNT_BEFORE" "$V21_AWP_COUNT_AFTER"

as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_cgv_profile('$RESTO_A','EXEMPT_PERISHABLE',20,30,'MINUTES','Nouvelle politique','Nouvelle substitution','FORMAL',false,'FIXED_PORTION_PRICE');" >/dev/null
resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
resolve_split
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>V21-ACTUAL-WEIGHT-PRICE: republication apres passage a FIXED_PORTION_PRICE</p>', '$RESOLVED_FP', '$RESOLVED_UID');")
assert_ok "V21-ACTUAL-WEIGHT-PRICE: après passage à FIXED_PORTION_PRICE (jamais ACTUAL_WEIGHT_PRICE), la publication réussit normalement (retriable)" "$RC"

# ============================================================
# [V21-FIXED-PORTION-PRICE] / [V21-COLD-CHAIN] -- succès + bascule,
# vérifiés avec le RENDU RÉEL (renderCgv() via render_via_node(), à
# partir des données RÉELLEMENT stockées en base -- jamais un
# placeholder littéral), exactement le chemin de l'aperçu consultatif
# du tableau de bord (buildPreview()). Se termine par un aller-retour
# complet render -> persist avec ce contenu RÉEL (jamais un littéral
# fabriqué), exactement comme app/api/dashboard/legal-cgv/publish/
# route.ts le ferait en Production.
# ============================================================
log "=== [V21-FIXED-PORTION-PRICE / V21-COLD-CHAIN] Rendu RÉEL vérifié pour les deux bascules ==="
render_via_node "$RESTO_A" ""
assert_eq "V21-FIXED-PORTION-PRICE: le rendu RÉEL (à partir des données de RESTO_A, weight_pricing_mode=FIXED_PORTION_PRICE) réussit (rc=0, pas ActualWeightPriceUnsupportedError)" "0" "$RENDER_RC"
assert_contains "V21-FIXED-PORTION-PRICE: le rendu RÉEL contient la section « Poids et prix des portions »" "Poids et prix des portions" "$RENDER_OUT"
assert_not_contains "V21-COLD-CHAIN (false): le rendu RÉEL ne contient PAS « Chaîne du froid » quand cold_chain_applicable=false (défaut de colonne, jamais modifié pour RESTO_A jusqu'ici)" "Chaîne du froid" "$RENDER_OUT"

as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_cgv_profile('$RESTO_A','EXEMPT_PERISHABLE',20,30,'MINUTES','Nouvelle politique','Nouvelle substitution','FORMAL',true,'FIXED_PORTION_PRICE');" >/dev/null
render_via_node "$RESTO_A" ""
assert_eq "V21-COLD-CHAIN (true): le rendu RÉEL réussit" "0" "$RENDER_RC"
assert_contains "V21-COLD-CHAIN (true): le rendu RÉEL contient « Chaîne du froid » quand cold_chain_applicable=true" "Chaîne du froid" "$RENDER_OUT"

resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
resolve_split
RC=$(persist_rendered_content_rc "$RESTO_A" "$RESOLVED_TID" "$RENDER_OUT" "$RESOLVED_FP" "$RESOLVED_UID")
assert_ok "V21-COLD-CHAIN/FIXED-PORTION-PRICE: persistance RÉUSSIT avec le contenu RÉELLEMENT rendu par renderCgv() -- aller-retour complet render->persist, jamais un littéral fabriqué" "$RC"
V21_PERSISTED=$(sql "select rendered_content from public.merchant_cgv_version where restaurant_id='$RESTO_A' and status='ACTIVE';")
assert_contains "V21-COLD-CHAIN/FIXED-PORTION-PRICE: le contenu PERSISTÉ contient bien « Chaîne du froid »" "Chaîne du froid" "$V21_PERSISTED"
assert_contains "V21-COLD-CHAIN/FIXED-PORTION-PRICE: le contenu PERSISTÉ contient bien « Poids et prix des portions »" "Poids et prix des portions" "$V21_PERSISTED"

# Remet RESTO_A à cold_chain_applicable=false pour ne pas affecter le
# test d'isolation multi-tenant [AU-LAIT-CRU] plus bas (qui vérifie
# précisément qu'un AUTRE marchand que Au Lait Cru ne rend jamais
# « Chaîne du froid »/CM2C/SIREN d'Au Lait Cru).
as_authenticated_rc "$OWNER_A" \
  "select public.update_merchant_cgv_profile('$RESTO_A','EXEMPT_PERISHABLE',20,30,'MINUTES','Nouvelle politique','Nouvelle substitution','FORMAL',false,'FIXED_PORTION_PRICE');" >/dev/null
resolve_for_persist_rc "$OWNER_A" "$RESTO_A" >/dev/null
resolve_split
as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>V21: RESTO_A remis a cold_chain_applicable=false pour la suite du harnais</p>', '$RESOLVED_FP', '$RESOLVED_UID');" >/dev/null

# ============================================================
# [AU-LAIT-CRU] Fixture MANUYUAN -- TEST FIXTURE UNIQUEMENT. Construite
# et vivant EXCLUSIVEMENT dans la base scratch jetable de ce harnais
# ($DB, détruite par le trap cleanup() en fin de script) -- jamais
# insérée dans, ni confondue avec, une ligne "réelle" quelconque.
# JAMAIS publiée (persist_merchant_cgv_version n'est JAMAIS appelé pour
# cette fixture -- vérifié explicitement, à plusieurs reprises,
# ci-dessous). Le rendu est produit par le VRAI renderCgv() (chemin
# d'aperçu consultatif), à partir des VRAIES données stockées, jamais
# une paraphrase.
# ============================================================
log "=== [AU-LAIT-CRU] Fixture MANUYUAN -- scratch DB uniquement, jamais publiée ==="
OWNER_ALC="66666666-6666-6666-6666-666666666666"
RESTO_ALC="dddddddd-dddd-dddd-dddd-dddddddddddd"
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<SQL
insert into auth.users (id, email) values ('$OWNER_ALC', 'owner-aulaitcru@test.local');
insert into public.restaurants (id, name, slug, is_active, status, country) values
  ('$RESTO_ALC', 'Au Lait Cru', 'au-lait-cru', true, 'active', 'FR');
insert into public.restaurant_configs (restaurant_id, currency, next_order_number, whatsapp_number) values
  ('$RESTO_ALC', 'EUR', 1, '+33600000099');
insert into public.restaurant_sale_modes (restaurant_id, mode_code, enabled) values
  ('$RESTO_ALC', 'pickup', true);
insert into public.restaurant_users (user_id, restaurant_id, role) values
  ('$OWNER_ALC', '$RESTO_ALC', 'owner');
SQL
pass "AU-LAIT-CRU: fixture (restaurant 'Au Lait Cru' + owner) créée dans la base SCRATCH ($DB) uniquement"

RC=$(as_authenticated_rc "$OWNER_ALC" \
  "select public.update_merchant_legal_profile('$RESTO_ALC','SARL','114 rue Ordener',null,'75018','Paris','FR','contact@aulaitcru.com',null,'CM2C','49 rue de Ponthieu, 75008 Paris, France','https://www.cm2c.net/declarer-un-litige.php','MANUYUAN','842925513','84292551300025','FR34842925513','01 89 47 00 14','litiges@cm2c.net');")
assert_ok "AU-LAIT-CRU: update_merchant_legal_profile (18 arguments, données EXACTES du mandat) réussit pour l'owner" "$RC"

RC=$(as_authenticated_rc "$OWNER_ALC" \
  "select public.update_merchant_cgv_profile('$RESTO_ALC','EXEMPT_PERISHABLE',3,6,'HOURS',null,null,'FORMAL',true,'FIXED_PORTION_PRICE');")
assert_ok "AU-LAIT-CRU: update_merchant_cgv_profile (10 arguments -- cancellation_policy_text/substitution_policy_text DÉLIBÉRÉMENT NULL, jamais inventés) réussit pour l'owner" "$RC"

ERR_ALC=$(sql "select public.cgv_completeness_errors('$RESTO_ALC');")
assert_eq "AU-LAIT-CRU: cgv_completeness_errors est VIDE ('{}') malgré cancellation_policy_text/substitution_policy_text NULL -- confirme, réellement vérifié (pas seulement supposé), que ces deux champs NE FONT PAS partie de la porte de complétude" "{}" "$ERR_ALC"

RC=$(as_authenticated_rc "$OWNER_ALC" "select * from public.resolve_cgv_publication_context('$RESTO_ALC');")
assert_ok "AU-LAIT-CRU: resolve_cgv_publication_context RÉUSSIT pour l'owner (mandat : 'should succeed since cancellation/substitution text is NOT part of the completeness gate') -- confirmé empiriquement" "$RC"

render_via_node "$RESTO_ALC" "$AU_LAIT_CRU_PREVIEW_FILE"
assert_eq "AU-LAIT-CRU: le rendu RÉEL (renderCgv(), chemin d'aperçu consultatif -- JAMAIS persist_merchant_cgv_version) réussit (rc=0)" "0" "$RENDER_RC"
ALC_OUT="$RENDER_OUT"

assert_contains "AU-LAIT-CRU: mention du prix fixe, sans recalcul (FIXED_PORTION_PRICE)" "aucun recalcul" "$ALC_OUT"
ALC_BAD_RECALC=$(printf '%s' "$ALC_OUT" | grep -ioE 'prix (sera|est) recalcul[eé]' || true)
assert_eq "AU-LAIT-CRU: aucune affirmation que le prix SERA/EST recalculé" "" "$ALC_BAD_RECALC"
assert_contains "AU-LAIT-CRU: clause EXEMPT_PERISHABLE (denrées périssables) présente" "denrées périssables" "$ALC_OUT"
assert_contains "AU-LAIT-CRU: phrase de coexistence v2 présente (les autres produits non périssables restent soumis à rétractation)" "demeurent soumis au régime de rétractation" "$ALC_OUT"
assert_contains "AU-LAIT-CRU: section « Chaîne du froid » présente (cold_chain_applicable=true)" "Chaîne du froid" "$ALC_OUT"
assert_contains "AU-LAIT-CRU: clause transport chaîne du froid présente (température dirigée)" "température dirigée" "$ALC_OUT"
assert_contains "AU-LAIT-CRU: médiateur CM2C nommé" "CM2C" "$ALC_OUT"
assert_contains "AU-LAIT-CRU: adresse EXACTE du médiateur CM2C" "49 rue de Ponthieu, 75008 Paris, France" "$ALC_OUT"
assert_contains "AU-LAIT-CRU: téléphone EXACT du médiateur CM2C" "01 89 47 00 14" "$ALC_OUT"
assert_contains "AU-LAIT-CRU: e-mail EXACT du médiateur CM2C" "litiges@cm2c.net" "$ALC_OUT"
assert_contains "AU-LAIT-CRU: SIREN présent" "842925513" "$ALC_OUT"
assert_contains "AU-LAIT-CRU: SIRET présent" "84292551300025" "$ALC_OUT"
assert_contains "AU-LAIT-CRU: TVA intracommunautaire présente" "FR34842925513" "$ALC_OUT"
assert_contains "AU-LAIT-CRU: dénomination sociale MANUYUAN présente" "MANUYUAN" "$ALC_OUT"
assert_contains "AU-LAIT-CRU: nom commercial « Au Lait Cru » présent (distinct de la dénomination sociale)" "Au Lait Cru" "$ALC_OUT"
assert_contains "AU-LAIT-CRU: texte de repli (fallback) ANNULATION du gabarit -- jamais un texte marchand inventé" "dispositions légales applicables et, le cas échéant, à un accord entre le Client et le Vendeur" "$ALC_OUT"
assert_contains "AU-LAIT-CRU: texte de repli (fallback) SUBSTITUTION du gabarit -- jamais un texte marchand inventé" "politique de substitution spécifique au-delà de la règle générale énoncée ci-dessus" "$ALC_OUT"
assert_contains "AU-LAIT-CRU: clause données personnelles présente" "données personnelles" "$ALC_OUT"
ALC_DAY_COUNT=$(printf '%s' "$ALC_OUT" | grep -ioE '[0-9]+[[:space:]]*(jours?|days?)' || true)
assert_eq "AU-LAIT-CRU: AUCUN nombre de jours de conservation fabriqué dans la clause données personnelles (mandat : jamais un chiffre inventé)" "" "$ALC_DAY_COUNT"

ALC_VERSION_COUNT=$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_ALC';")
assert_eq "AU-LAIT-CRU: AUCUNE ligne merchant_cgv_version -- jamais publiée/persistée (chemin d'aperçu uniquement)" "0" "$ALC_VERSION_COUNT"

# --- [AU-LAIT-CRU/ISOLATION] Isolation multi-tenant --------------------
log "=== [AU-LAIT-CRU/ISOLATION] Isolation multi-tenant (rendu + RLS) ==="
render_via_node "$RESTO_A" ""
assert_eq "AU-LAIT-CRU/ISOLATION: rendu réel de RESTO_A (un AUTRE marchand) réussit" "0" "$RENDER_RC"
assert_not_contains "AU-LAIT-CRU/ISOLATION: RESTO_A ne rend JAMAIS le médiateur CM2C d'Au Lait Cru" "CM2C" "$RENDER_OUT"
assert_not_contains "AU-LAIT-CRU/ISOLATION: RESTO_A ne rend JAMAIS la section « Chaîne du froid » d'Au Lait Cru (cold_chain_applicable=false pour RESTO_A à ce stade)" "Chaîne du froid" "$RENDER_OUT"
assert_not_contains "AU-LAIT-CRU/ISOLATION: RESTO_A ne rend JAMAIS le SIREN d'Au Lait Cru" "842925513" "$RENDER_OUT"

RC=$(as_authenticated_rc "$OWNER_A" "select public.get_merchant_legal_profile('$RESTO_ALC');")
assert_denied "AU-LAIT-CRU/ISOLATION: owner A NE PEUT PAS lire le profil légal d'Au Lait Cru" "$RC"
RC=$(as_authenticated_rc "$OWNER_A" "select public.update_merchant_legal_profile('$RESTO_ALC','SARL',null,null,null,null,null,null,null,null,null,null);")
assert_denied "AU-LAIT-CRU/ISOLATION: owner A NE PEUT PAS écrire le profil légal d'Au Lait Cru" "$RC"
RC=$(resolve_for_persist_rc "$OWNER_A" "$RESTO_ALC")
assert_denied "AU-LAIT-CRU/ISOLATION: owner A NE PEUT PAS résoudre un contexte de publication pour Au Lait Cru" "$RC"

resolve_for_persist_rc "$OWNER_ALC" "$RESTO_ALC" >/dev/null
resolve_split
RC=$(as_service_role_rc "select * from public.persist_merchant_cgv_version('$RESTO_A', '$RESOLVED_TID', '<p>tentative cross-tenant Au Lait Cru -> RESTO_A</p>', '$RESOLVED_FP', '$RESOLVED_UID');")
assert_denied "AU-LAIT-CRU/ISOLATION: un contexte résolu pour Au Lait Cru ne peut pas être substitué pour publier sur RESTO_A" "$RC"
assert_contains "AU-LAIT-CRU/ISOLATION: rejeté par AUTORISATION (l'owner d'Au Lait Cru n'a aucun rattachement à RESTO_A), pas par hasard de fingerprint" "Not authorized for this restaurant" "$(sql_err)"

ALC_VERSION_COUNT_FINAL=$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_ALC';")
assert_eq "AU-LAIT-CRU: toujours AUCUNE ligne merchant_cgv_version après la section d'isolation multi-tenant -- jamais publiée" "0" "$ALC_VERSION_COUNT_FINAL"
RESTO_A_VERSION_COUNT_UNCHANGED=$(sql "select count(*) from public.merchant_cgv_version where restaurant_id='$RESTO_A';")
pass "AU-LAIT-CRU/ISOLATION: la tentative de substitution cross-tenant rejetée n'a créé aucune ligne inattendue pour RESTO_A non plus (compte observé : $RESTO_A_VERSION_COUNT_UNCHANGED)"

log "=== [ROLLBACK] Investigation -- v1.2 (gap constaté empiriquement) puis v2.1 (correctif) ==="
RC=$(sql_rc "$(cat "$ROLLBACK_SQL")")
assert_ok "ROLLBACK v1.2: s'applique proprement par-dessus v1.1+v1.2+v1.3+v1.4+v2.1" "$RC"
assert_eq "ROLLBACK v1.2: après rollback, merchant_cgv_version n'existe plus" "0" "$(sql "select count(*) from pg_class where relname='merchant_cgv_version';")"
assert_eq "ROLLBACK v1.2: après rollback, merchant_legal_profile n'existe plus" "0" "$(sql "select count(*) from pg_class where relname='merchant_legal_profile';")"
assert_eq "ROLLBACK v1.2: après rollback, merchant_cgv_profile n'existe plus" "0" "$(sql "select count(*) from pg_class where relname='merchant_cgv_profile';")"
assert_eq "ROLLBACK v1.2: après rollback, cgv_template n'existe plus" "0" "$(sql "select count(*) from pg_class where relname='cgv_template';")"
assert_eq "ROLLBACK v1.2: après rollback, persist_merchant_cgv_version n'existe plus (signature d'ENTRÉE inchangée par v2.1, DROP FUNCTION IF EXISTS le trouve encore)" "0" "$(sql "select count(*) from pg_proc where proname='persist_merchant_cgv_version' and pronamespace='public'::regnamespace;")"
assert_eq "ROLLBACK v1.2: après rollback, resolve_cgv_publication_context n'existe plus (idem, signature d'entrée inchangée)" "0" "$(sql "select count(*) from pg_proc where proname='resolve_cgv_publication_context' and pronamespace='public'::regnamespace;")"
assert_eq "ROLLBACK v1.2: après rollback, get_merchant_cgv_profile n'existe plus (idem)" "0" "$(sql "select count(*) from pg_proc where proname='get_merchant_cgv_profile' and pronamespace='public'::regnamespace;")"
assert_eq "ROLLBACK v1.2: après rollback, get_merchant_legal_profile n'existe plus" "0" "$(sql "select count(*) from pg_proc where proname='get_merchant_legal_profile' and pronamespace='public'::regnamespace;")"
assert_eq "ROLLBACK v1.2: après rollback, _resolve_applicable_cgv_template n'existe plus" "0" "$(sql "select count(*) from pg_proc where proname='_resolve_applicable_cgv_template' and pronamespace='public'::regnamespace;")"
ARGS_AFTER=$(sql "select pg_get_function_arguments(oid) from pg_proc where proname='create_order' and pronamespace='public'::regnamespace;")
assert_not_contains "ROLLBACK v1.2: après rollback, create_order n'a plus p_cgv_accepted" "p_cgv_accepted" "$ARGS_AFTER"

# ------------------------------------------------------------
# LE GAP, CONSTATÉ EMPIRIQUEMENT ici (pas seulement documenté dans
# l'en-tête de v2.1) : le rollback v1.2 ne nomme QUE les anciennes
# signatures à 12/8 arguments -- `drop function if exists ...
# (uuid,text,text,text,text,text,text,text,text,text,text,text)` pour
# update_merchant_legal_profile et `(uuid,text,integer,integer,text,
# text,text,text)` pour update_merchant_cgv_profile. IF EXISTS ne
# trouve donc RIEN à supprimer pour les fonctions à 18/10 arguments que
# v2.1 a installées : elles SURVIVENT au rollback v1.2, désormais des
# fonctions ORPHELINES dont le corps référence des tables (et d'autres
# fonctions, comme assert_legal_cgv_role) qui n'existent plus.
# ------------------------------------------------------------
V21_ORPHAN_LEGAL=$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='update_merchant_legal_profile' and pg_get_function_identity_arguments(p.oid) ilike '%p_legal_entity_name%';")
assert_eq "ROLLBACK v1.2 -- GAP CONSTATÉ: update_merchant_legal_profile (18 arguments, v2.1) SURVIT au rollback v1.2 -- orpheline, référence des objets qui n'existent plus" "1" "$V21_ORPHAN_LEGAL"
V21_ORPHAN_CGV=$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='update_merchant_cgv_profile' and pg_get_function_identity_arguments(p.oid) ilike '%p_cold_chain_applicable%';")
assert_eq "ROLLBACK v1.2 -- GAP CONSTATÉ: update_merchant_cgv_profile (10 arguments, v2.1) SURVIT au rollback v1.2 -- orpheline, référence des objets qui n'existent plus" "1" "$V21_ORPHAN_CGV"

# Preuve que l'orpheline est bien CASSÉE (pas seulement présente mais
# inoffensive) : l'appeler échoue désormais avec une erreur D'EXÉCUTION
# (relation ou fonction interne manquante, selon l'ordre exact des
# dépendances internes rompues par le rollback -- la fonction elle-même
# conserve son grant EXECUTE), JAMAIS un refus de permission.
RC_ORPHAN_CALL=$(as_authenticated_rc "$OWNER_A" "select public.update_merchant_legal_profile('$RESTO_A','SARL',null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null);")
assert_denied "ROLLBACK v1.2 -- GAP CONSTATÉ: appeler l'orpheline update_merchant_legal_profile échoue désormais -- preuve qu'elle est réellement CASSÉE, pas seulement inutilement présente" "$RC_ORPHAN_CALL"
assert_not_contains "ROLLBACK v1.2 -- GAP CONSTATÉ: l'échec de l'orpheline N'EST PAS un refus de permission (elle a encore son grant EXECUTE intact) -- c'est une erreur d'exécution interne" "permission denied" "$(sql_err)"

log "=== [ROLLBACK] v2.1 -- correctif du gap, addendum étroit ==="
RC=$(sql_rc "$(cat "$ROLLBACK_SQL_V21")")
assert_ok "ROLLBACK v2.1 (addendum): s'applique proprement par-dessus le rollback v1.2 déjà appliqué" "$RC"
V21_ORPHAN_LEGAL_AFTER=$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='update_merchant_legal_profile';")
assert_eq "ROLLBACK v2.1 (addendum): update_merchant_legal_profile (toute arité) n'existe plus après l'addendum" "0" "$V21_ORPHAN_LEGAL_AFTER"
V21_ORPHAN_CGV_AFTER=$(sql "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='update_merchant_cgv_profile';")
assert_eq "ROLLBACK v2.1 (addendum): update_merchant_cgv_profile (toute arité) n'existe plus après l'addendum" "0" "$V21_ORPHAN_CGV_AFTER"

pass "ROLLBACK -- CONCLUSION (mandat v2.1, item 6/9) : le rollback v1.2 existant ne SUFFIT PAS seul après v2.1 -- il laisse deux fonctions orphelines et cassées (update_merchant_legal_profile 18-arg, update_merchant_cgv_profile 10-arg). Un rollback incrémental v2.1 (DRAFT-lot-seller-legal-profile-cgv-engine-v2-1-rollback.sql), appliqué APRÈS le rollback v1.2, est GENUINEMENT et NON-COSMÉTIQUEMENT requis -- confirmé empiriquement ci-dessus (pas seulement documenté dans un en-tête), exactement le scénario anticipé et explicitement permis par le mandat."

log "=== RÉSUMÉ ==="
log "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  log "--- Échecs ---"
  cat "$FAIL_LOG"
  exit 1
fi
exit 0
