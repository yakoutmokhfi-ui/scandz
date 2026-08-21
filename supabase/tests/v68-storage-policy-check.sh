#!/usr/bin/env bash
# ============================================================
# Scanym V68/V69 — Harnais reproductible des policies storage.objects
# (identité visuelle établissement : logo & cover), preuve
# d'isolation multi-établissement ET d'administration cross-
# établissement par un opérateur Scanym.
#
# ÉTENDU en V69 (couleurs, lien Maps, durcissement logo/cover) : même
# fichier, pas de second harnais — la migration V69 réelle est
# appliquée juste après V68, et de nouvelles sections d'assertions
# couvrent le durcissement (2e segment de chemin restreint à
# logo/cover, validation du chemin d'URL dans set_restaurant_logo/
# _cover) et les 2 nouvelles RPC (update_restaurant_colors,
# update_restaurant_maps_url). Toutes les assertions V68 restent
# inchangées et continuent de s'exécuter contre l'état FINAL (V68+V69)
# des policies, preuve qu'elles ne régressent pas après durcissement.
#
# Même stand-in du schéma storage Supabase qu'en V67 (voir
# supabase/tests/v67-storage-policy-check.sh pour la justification
# détaillée), appliqué ici par-dessus une base incluant RÉELLEMENT
# le Lot D création d'établissement déjà en production
# (migration-lotd-establishment-creation.sql, qui fournit
# scanym_operators et is_scanym_operator()) puis les migrations V68 et
# V69 RÉELLES telles quelles. Les policies/RPC testées ici sont donc
# EXACTEMENT celles livrées.
#
# Scénarios requis couverts ici (numérotation des briefs Lot D) :
#   1. owner du restaurant A upload dans A/logo/... et A/cover/...
#   2. owner A NE PEUT PAS upload dans B/...
#   3. un opérateur Scanym (scanym_operators) administre A ET B
#   4. anon NE PEUT PAS écrire
#   5/6. limite de taille / types MIME autorisés — configuration du
#      bucket (appliquée par le moteur Storage Supabase, hors
#      portée d'un stand-in SQL local) : vérifiée ici au niveau
#      storage.buckets, et au niveau applicatif dans
#      tests/v68-establishment-assets.test.ts (validateEstablishmentAssetFile).
#   7/8. set_restaurant_logo / set_restaurant_cover mettent à jour
#      la bonne colonne, réservé owner/manager (ou opérateur)
#   10. p_url = null réinitialise la colonne à NULL
#   + staff refusé (comme V67), + SELECT/UPDATE/DELETE (méthodologie
#   M-02 déjà établie en V67), + non-régression : aucune policy
#   product_photos_* touchée.
#   V69 — section 8 (restriction du 2e segment de chemin), section 7
#   (validation du chemin d'URL dans les 2 RPC logo/cover), sections
#   1/2/4 (couleurs et lien Maps).
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/v68-storage-policy-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DB="scanym_v68_storage_$$"

PASS_COUNT=0
FAIL_COUNT=0

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
FAIL_LOG="/tmp/scanym-harness-fails-$$.log"
: > "$FAIL_LOG"
fail() {
  FAIL_COUNT=$((FAIL_COUNT+1))
  # Corrige V72-01 (contre-audit Work, 3e tour) : trace INDÉPENDANTE
  # de FAIL_COUNT, écrite sur disque -- même si FAIL_COUNT était un
  # jour manipulé/réinitialisé par erreur (exactement le défaut
  # trouvé par Work), ce fichier reste la preuve tamper-resistant
  # vérifiée en toute fin de script (section HARNESS SELF-TEST),
  # indépendamment de ce que rapporte le compteur.
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

# Corrige V71-01 (contre-audit Work, 2e tour) : l'ancien patron
# `VAR=$(psql ... | head -1) || true` neutralisait `set -e` pour
# TOUTE défaillance psql -- erreur SQL réelle, connexion impossible,
# pas seulement le SIGPIPE qu'il visait à couvrir. Ce remplacement :
#   1. capture la sortie COMPLÈTE (stdout+stderr) et le VRAI code de
#      sortie de psql -- jamais celui de `head`, qui aurait toujours
#      masqué l'échec réel de psql lui-même ;
#   2. échoue explicitement si ce code n'est pas 0, journalise la
#      sortie complète pour diagnostic ;
#   3. échoue explicitement si aucune valeur exploitable n'a été
#      produite (0 ligne) ;
#   4. n'extrait la première ligne qu'APRÈS avoir validé les deux
#      points précédents -- jamais avant, donc jamais de valeur
#      "plausible" en présence d'une erreur réelle.
# Élimine aussi le SIGPIPE PAR CONSTRUCTION : aucun pipe direct depuis
# le processus psql (la sortie est entièrement capturée en mémoire
# avant tout traitement), contrairement au risque latent de
# `psql ... | head -1`.
# -X : ignore .psqlrc (déterminisme). -A -t : sortie brute sans
# alignement/en-têtes, comme demandé.
psql_one() {
  local desc="$1"; shift
  if psql_one_silent "$@"; then
    return 0
  fi
  if [ "$PSQL_ONE_LAST_STATUS" -ne 0 ]; then
    fail "$desc -- psql a échoué (code $PSQL_ONE_LAST_STATUS) : $(printf '%s' "$PSQL_ONE_LAST_OUTPUT" | tr '\n' ' ')"
  else
    fail "$desc -- psql n'a produit AUCUNE valeur exploitable (0 ligne)"
  fi
  return 1
}

# Corrige V72-01 (contre-audit Work, 3e tour) : mécanisme PUR, sans
# aucun effet de bord sur PASS_COUNT/FAIL_COUNT -- psql_one() (ci-dessus)
# délègue à cette fonction pour son usage NORMAL dans le reste du
# harnais (où un échec DOIT être journalisé via fail()), tandis que
# les scénarios qui prouvent volontairement qu'un échec est détecté
# (V71-01/4 ci-dessous) l'appellent DIRECTEMENT, sans jamais passer
# par fail() ni par une réinitialisation de compteur -- élimine
# structurellement le défaut trouvé par Work (un FAIL réel qui
# disparaissait ensuite du compteur final).
psql_one_silent() {
  local output status value
  output=$(psql -X -A -t -v ON_ERROR_STOP=1 "$@" 2>&1)
  status=$?
  PSQL_ONE_LAST_OUTPUT="$output"
  PSQL_ONE_LAST_STATUS="$status"
  if [ "$status" -ne 0 ]; then
    PSQL_ONE_VALUE=""
    return 1
  fi
  value=$(printf '%s\n' "$output" | sed -n '1p')
  if [ -z "$value" ]; then
    PSQL_ONE_VALUE=""
    return 1
  fi
  PSQL_ONE_VALUE="$value"
  return 0
}

psql -c "drop database if exists \"$DB\";" >/dev/null
createdb "$DB"

# ------------------------------------------------------------------
# Bootstrap : chaîne réelle de migrations jusqu'au Lot D création
# d'établissement (déjà en production), + stand-in storage.
# ------------------------------------------------------------------
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<SQL
create schema if not exists auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as \$\$
  select nullif(current_setting('test.uid', true), '')::uuid
\$\$;
create extension if not exists pgcrypto;
create publication supabase_realtime;
do \$\$ begin
  if not exists (select from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end \$\$;

create schema storage;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text not null,
  owner uuid
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text)
returns text[] language sql immutable as \$\$
  select (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1]
\$\$;
grant usage on schema storage to anon, authenticated;
grant all on storage.buckets, storage.objects to anon, authenticated;
SQL

for f in schema.sql migration-orders.sql migration-orders-lang.sql \
         migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql \
         migration-translations.sql migration-v39-settings.sql \
         migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql \
         migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql; do
  psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null
done
psql -d "$DB" -c "grant select, references, trigger, truncate on all tables in schema public to anon, authenticated;" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v66-categories-descriptions.sql" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v67-product-photos.sql" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v67b-category-description-product-order.sql" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-lotd-establishment-creation.sql" >/dev/null
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-lotd-rls-reference-tables-fix.sql" >/dev/null
pass "chaîne de migrations réelle appliquée jusqu'au Lot D création d'établissement (déjà en production)"

log "=== Application de la migration V68 réelle (bucket, policies, RPC) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v68-establishment-assets.sql" >/dev/null
pass "migration V68 appliquée sans erreur sur le stand-in storage"

log "=== Application de la migration V69 réelle (couleurs, lien Maps, durcissement logo/cover) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v69-identity-colors-maps-hardening.sql" >/dev/null
pass "migration V69 appliquée sans erreur sur le stand-in storage"

log "=== Application de la migration V70 réelle (F-01/F-02/F-04 : Super Admin, maps_url, hardening host) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v70-identity-corrections.sql" >/dev/null
pass "migration V70 appliquée sans erreur sur le stand-in storage"

# ============================================================
# V78-01 (contre-audit Work, 9e tour) : migration-v76-storage-origin-config.sql
# est la PREMIÈRE migration réellement exécutée depuis l'état
# production actuel (V70 installée, rien après) -- le contrôle
# structurel complet de l'état V70 doit donc s'y trouver EN PREMIER,
# avant toute création de schéma/fonction/table, pas seulement dans
# migration-v71-hardening.sql (trop tard : V76 aurait déjà créé
# scanym_internal sur un état V70 dérivé). 7 scénarios de dérive
# simulés sur une base séparée dédiée, chacun doit : (1) lever
# SCANYM_SCHEMA_DRIFT, (2) NE RIEN CRÉER -- scanym_internal absent
# après l'échec, pas seulement "la migration s'arrête quelque part".
# ============================================================
log "=== V78-01 : 7 scénarios de dérive V70, chacun testé AVANT toute création par migration-v76-storage-origin-config.sql ==="
DB_V76_DRIFT="scanym_v79_drift_$$"
psql -c "drop database if exists \"$DB_V76_DRIFT\";" >/dev/null 2>&1 || true
createdb "$DB_V76_DRIFT"
psql -d "$DB_V76_DRIFT" >/dev/null <<'SQL'
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
  psql -d "$DB_V76_DRIFT" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  psql -d "$DB_V76_DRIFT" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
done
for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql; do
  psql -d "$DB_V76_DRIFT" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
done

test_v76_drift_scenario() {
  local desc="$1" sql_mutation="$2"
  psql -d "$DB_V76_DRIFT" -c "drop function if exists public.assert_establishment_asset_url(uuid,text,text); drop function if exists public.assert_establishment_asset_url(uuid,text,text,text); drop function if exists public.assert_establishment_asset_url(uuid,text);" >/dev/null 2>&1
  psql -d "$DB_V76_DRIFT" -c "$sql_mutation" >/dev/null 2>&1
  local out
  out=$(psql -v ON_ERROR_STOP=1 -d "$DB_V76_DRIFT" -f "$SUPABASE_DIR/migration-v76-storage-origin-config.sql" 2>&1 || true)
  if echo "$out" | grep -q "SCANYM_SCHEMA_DRIFT"; then
    local schema_exists
    schema_exists=$(psql -X -A -t -d "$DB_V76_DRIFT" -c "select count(*) from pg_namespace where nspname='scanym_internal';")
    if [ "$schema_exists" = "0" ]; then
      pass "V78-01: $desc -- SCANYM_SCHEMA_DRIFT levé par migration-v76-storage-origin-config.sql ET scanym_internal absent (rien créé)"
    else
      fail "V78-01: $desc -- SCANYM_SCHEMA_DRIFT levé MAIS scanym_internal existe quand même (création partielle non voulue)"
    fi
  else
    fail "V78-01: $desc -- migration-v76-storage-origin-config.sql aurait dû lever SCANYM_SCHEMA_DRIFT"
  fi
}

test_v76_drift_scenario "mauvaise signature (arité différente)" "
  create function public.assert_establishment_asset_url(p_restaurant_id uuid, p_kind text)
  returns void language plpgsql stable security definer set search_path = ''
  as \$f\$ begin perform current_setting('app.storage_public_base_url', true); return; end; \$f\$;
"
test_v76_drift_scenario "overload (deuxième fonction du même nom)" "
  create function public.assert_establishment_asset_url(p_restaurant_id uuid, p_kind text, p_url text)
  returns void language plpgsql stable security definer set search_path = ''
  as \$f\$ begin perform current_setting('app.storage_public_base_url', true); return; end; \$f\$;
  create function public.assert_establishment_asset_url(p_restaurant_id uuid, p_kind text, p_url text, p_extra text)
  returns void language plpgsql stable security definer set search_path = ''
  as \$f\$ begin return; end; \$f\$;
"
test_v76_drift_scenario "mauvais type de retour (boolean au lieu de void)" "
  create function public.assert_establishment_asset_url(p_restaurant_id uuid, p_kind text, p_url text)
  returns boolean language plpgsql stable security definer set search_path = ''
  as \$f\$ begin perform current_setting('app.storage_public_base_url', true); return true; end; \$f\$;
"
test_v76_drift_scenario "non SECURITY DEFINER" "
  create function public.assert_establishment_asset_url(p_restaurant_id uuid, p_kind text, p_url text)
  returns void language plpgsql stable set search_path = ''
  as \$f\$ begin perform current_setting('app.storage_public_base_url', true); return; end; \$f\$;
"
test_v76_drift_scenario "mauvais search_path (absent)" "
  create function public.assert_establishment_asset_url(p_restaurant_id uuid, p_kind text, p_url text)
  returns void language plpgsql stable security definer
  as \$f\$ begin perform current_setting('app.storage_public_base_url', true); return; end; \$f\$;
"
test_v76_drift_scenario "mauvaise volatilité (volatile au lieu de stable)" "
  create function public.assert_establishment_asset_url(p_restaurant_id uuid, p_kind text, p_url text)
  returns void language plpgsql security definer set search_path = ''
  as \$f\$ begin perform current_setting('app.storage_public_base_url', true); return; end; \$f\$;
"
test_v76_drift_scenario "corps V70 dérivé (marqueur caractéristique absent)" "
  create function public.assert_establishment_asset_url(p_restaurant_id uuid, p_kind text, p_url text)
  returns void language plpgsql stable security definer set search_path = ''
  as \$f\$ begin return; end; \$f\$;
"

psql -c "drop database if exists \"$DB_V76_DRIFT\";" >/dev/null 2>&1 || true

# Corrige V76 (contre-audit Work, 6e tour) : remplace le mécanisme GUC
# (app.storage_public_base_url), confirmé structurellement incompatible
# avec Supabase hébergé (ALTER DATABASE ... SET refusé, 42501 permission
# denied -- reproduit ci-dessous avec un rôle non-superutilisateur, EXACTEMENT
# comme le rôle postgres réel sur Supabase hébergé), par une table de
# configuration ordinaire. S'exécute ICI, entre V70 et le préflight --
# migration-v71-hardening.sql en dépend désormais.
log "=== V76/1 : reproduction de l'échec ALTER DATABASE ... SET avec un rôle non-superutilisateur (simule fidèlement Supabase hébergé) ==="
psql -d "$DB" -c "do \$\$ begin if not exists (select from pg_roles where rolname='v76_nonsuper_test') then create role v76_nonsuper_test nologin; end if; end \$\$;" >/dev/null
RC=$(psql -v ON_ERROR_STOP=1 -d "$DB" -c "
  set role v76_nonsuper_test;
  alter database \"$DB\" set app.storage_public_base_url = 'https://test.supabase.co';
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "V76: ALTER DATABASE ... SET échoue avec un rôle non-superutilisateur (reproduit le comportement réel Supabase hébergé)" "1" "$RC"

log "=== V76/2 : application de migration-v76-storage-origin-config.sql ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v76-storage-origin-config.sql" >/dev/null
pass "migration V76 appliquée sans erreur sur le stand-in storage"

log "=== V76/3 : configuration de la valeur via INSERT ordinaire, avec le rôle NON-SUPERUTILISATEUR -- preuve centrale de V76 ==="
psql -d "$DB" -c "grant usage on schema scanym_internal to v76_nonsuper_test; grant select, insert, update, delete on scanym_internal.storage_config to v76_nonsuper_test; grant execute on function scanym_internal.is_valid_storage_origin(text) to v76_nonsuper_test;" >/dev/null
RC=$(psql -v ON_ERROR_STOP=1 -d "$DB" -c "
  set role v76_nonsuper_test;
  insert into scanym_internal.storage_config (id, storage_public_origin)
  values (true, 'https://ctqfpszwunfomrbxgigu.supabase.co')
  on conflict (id) do update set storage_public_origin = excluded.storage_public_origin, updated_at = now();
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "V76: configuration réussie via INSERT ordinaire avec un rôle non-superutilisateur (là où ALTER DATABASE échoue)" "0" "$RC"

log "=== V76/4 : origine invalide/vide -> REFUS par la contrainte CHECK ==="
RC=$(psql -d "$DB" -c "update scanym_internal.storage_config set storage_public_origin = 'not-a-valid-origin' where id = true;" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "V76: origine invalide refusée par la contrainte CHECK" "1" "$RC"
RC=$(psql -d "$DB" -c "update scanym_internal.storage_config set storage_public_origin = '' where id = true;" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "V76: origine vide refusée par la contrainte CHECK" "1" "$RC"

log "=== V76/5 : singleton -- une seconde ligne est refusée ==="
RC=$(psql -d "$DB" -c "insert into scanym_internal.storage_config (id, storage_public_origin) values (false, 'https://autre.supabase.co');" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "V76: une seconde ligne (id=false) refusée par la contrainte singleton" "1" "$RC"

log "=== V76/6 : anon/authenticated ne peuvent ni lire ni écrire la config, ni exécuter le helper ==="
for role in anon authenticated; do
  for priv in SELECT INSERT UPDATE DELETE; do
    CAN=$(psql -X -A -t -d "$DB" -c "select has_table_privilege('$role', 'scanym_internal.storage_config', '$priv');")
    assert_eq "V76: $role ne peut PAS $priv sur scanym_internal.storage_config" "f" "$CAN"
  done
  CAN_EXEC=$(psql -X -A -t -d "$DB" -c "select has_function_privilege('$role', 'scanym_internal.get_storage_public_origin()', 'EXECUTE');")
  assert_eq "V76: $role ne peut PAS exécuter get_storage_public_origin()" "f" "$CAN_EXEC"
done

# Corrige V72-04 (contre-audit Work, 3e tour) : le préflight des
# données historiques s'exécute désormais AU BON ENDROIT dans la
# séquence -- AVANT migration-v71-hardening.sql, pas après. Sur ce
# stand-in propre, il doit réussir silencieusement (aucune anomalie).
log "=== Préflight historique (preflight-historical-uuid-check.sql) -- doit s'exécuter ICI, avant V71, corrige V72-04 ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/preflight-historical-uuid-check.sql" >/dev/null
pass "préflight historique réussi (aucune donnée non conforme) -- positionné AVANT V71, comme l'exige V72-04"

log "=== Application de la migration V71 réelle -- ÉDITÉE par V76 (V70-01/04/05/07 : host fail-closed via scanym_internal, maps_url structurel, double colonne, UUID v4 strict) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v71-hardening.sql" >/dev/null
pass "migration V71 (éditée V76) appliquée sans erreur sur le stand-in storage"

log "=== Application de la migration V72 réelle (V71-03 : grammaire HTTPS commune stricte ; V71-07 : préflight données historiques) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v72-hardening.sql" >/dev/null
pass "migration V72 appliquée sans erreur sur le stand-in storage (aucune donnée historique non conforme sur ce stand-in propre)"

log "=== Application de la migration V73 réelle (V72-05 : chemin Storage complet ; V72-06 : chaîne brute maps_url ; V72-07 : port borné) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v73-hardening.sql" >/dev/null
pass "migration V73 appliquée sans erreur sur le stand-in storage"

# Non-régression explicite : les 4 policies product_photos_* de V67
# doivent toujours exister, inchangées, après V68/V69/V70.
PP_POLICIES=$(psql -d "$DB" -t -A -c "select count(*) from pg_policies where schemaname='storage' and tablename='objects' and policyname like 'product_photos_%';")
assert_eq "les 4 policies product_photos_* (V67) existent toujours, non modifiées par V68/V69/V70" "4" "$PP_POLICIES"

# F-02 : la colonne doit maintenant être maps_url, google_maps_url ne
# doit plus exister (renommage réel, pas une simple coexistence).
COL_OLD=$(psql -d "$DB" -t -A -c "select count(*) from information_schema.columns where table_schema='public' and table_name='restaurant_configs' and column_name='google_maps_url';")
assert_eq "F-02: google_maps_url n'existe plus après V70 (renommage réel)" "0" "$COL_OLD"
COL_NEW=$(psql -d "$DB" -t -A -c "select count(*) from information_schema.columns where table_schema='public' and table_name='restaurant_configs' and column_name='maps_url';")
assert_eq "F-02: maps_url existe après V70" "1" "$COL_NEW"

# ------------------------------------------------------------------
# Données de test : 2 restaurants, owner+staff sur A, manager sur B,
# + 1 utilisateur enregistré comme opérateur Scanym (scanym_operators),
# SANS aucun rôle restaurant_users (administrateur pur, portée globale).
# ------------------------------------------------------------------
psql_one "création restaurant A" -d "$DB" -c "insert into public.restaurants (name, slug) values ('A', 'v68-resto-a') returning id;"
RESTO_A="$PSQL_ONE_VALUE"
psql_one "création restaurant B" -d "$DB" -c "insert into public.restaurants (name, slug) values ('B', 'v68-resto-b') returning id;"
RESTO_B="$PSQL_ONE_VALUE"
psql -d "$DB" -c "insert into public.restaurant_configs (restaurant_id, whatsapp_number) values ('$RESTO_A', '+213000000'), ('$RESTO_B', '+213000001');" >/dev/null

psql_one "création utilisateur owner A" -d "$DB" -c "insert into auth.users (email) values ('v68-owner-a@test') returning id;"
OWNER_A="$PSQL_ONE_VALUE"
psql_one "création utilisateur staff A" -d "$DB" -c "insert into auth.users (email) values ('v68-staff-a@test') returning id;"
STAFF_A="$PSQL_ONE_VALUE"
psql_one "création utilisateur manager B" -d "$DB" -c "insert into auth.users (email) values ('v68-manager-b@test') returning id;"
MANAGER_B="$PSQL_ONE_VALUE"
psql_one "création utilisateur opérateur" -d "$DB" -c "insert into auth.users (email) values ('v68-operator@scanym.internal') returning id;"
OPERATOR="$PSQL_ONE_VALUE"
psql -d "$DB" -c "
  insert into public.restaurant_users (user_id, restaurant_id, role) values
    ('$OWNER_A', '$RESTO_A', 'owner'),
    ('$STAFF_A', '$RESTO_A', 'staff'),
    ('$MANAGER_B', '$RESTO_B', 'manager');
  insert into public.scanym_operators (user_id) values ('$OPERATOR');
" >/dev/null

# ============================================================
# NOTE (V76, 6e tour) : les anciens tests "V70-01 : GUC absent/vide/
# malformé" ont été RETIRÉS d'ici -- la fonction ne lit plus AUCUN GUC
# depuis l'édition V76 de migration-v71-hardening.sql. L'ÉQUIVALENT
# exact de ces trois scénarios (config absente/vide/invalide) est
# désormais testé plus haut dans ce même fichier, section "V76/4"
# et dans le contrôle initial avant toute configuration de la table
# scanym_internal.storage_config -- voir plus haut, AVANT le préflight
# historique. Ne pas les dupliquer ici.
#
# La table est déjà configurée (V76/3, plus haut) avec la valeur RÉELLE
# de production à titre de preuve. Pour la suite de CE harnais, mise à
# jour vers "https://fake.supabase.co" -- l'hôte de test utilisé par
# tous les scénarios V68/V69 existants depuis l'origine de ce projet.
# Une simple UPDATE, privilège ordinaire, aucun besoin de superutilisateur
# (contrairement à l'ancien ALTER DATABASE ... SET).
# ============================================================
VALID_FILE_UUID=$(psql -d "$DB" -t -A -c "select gen_random_uuid();")
psql -d "$DB" -c "update scanym_internal.storage_config set storage_public_origin = 'https://fake.supabase.co', updated_at = now() where id = true;" >/dev/null
pass "scanym_internal.storage_config mis à jour pour la suite de ce harnais (https://fake.supabase.co) via UPDATE ordinaire, comme le ferait le CIO en production"

try_insert() {
  local uid="$1" path="$2"
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "
    set role authenticated;
    set local test.uid = '$uid';
    insert into storage.objects (bucket_id, name) values ('establishment-assets', '$path');
    reset role;
  " >/dev/null 2>&1 && echo "0" || echo "1"
}

try_insert_anon() {
  local path="$1"
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "
    set role anon;
    insert into storage.objects (bucket_id, name) values ('establishment-assets', '$path');
    reset role;
  " >/dev/null 2>&1 && echo "0" || echo "1"
}

log "=== Scénario 1 : owner écrit sous son propre établissement (logo ET cover) ==="
RC=$(try_insert "$OWNER_A" "$RESTO_A/logo/aaaaaaaa-1111-4111-8111-111111111111.jpg")
assert_eq "scénario 1a: owner A écrit dans A/logo/... (succès)" "0" "$RC"
RC=$(try_insert "$OWNER_A" "$RESTO_A/cover/aaaaaaaa-1111-4111-8111-111111111111.jpg")
assert_eq "scénario 1b: owner A écrit dans A/cover/... (succès)" "0" "$RC"

log "=== Scénario 2 : owner A NE PEUT PAS écrire chez B ==="
RC=$(try_insert "$OWNER_A" "$RESTO_B/logo/x.jpg")
assert_eq "scénario 2: owner A NE PEUT PAS écrire dans B/logo/... (refus)" "1" "$RC"

RC=$(try_insert "$MANAGER_B" "$RESTO_B/cover/bbbbbbbb-2222-4222-8222-222222222222.jpg")
assert_eq "manager B écrit sous son propre établissement B (succès)" "0" "$RC"
RC=$(try_insert "$MANAGER_B" "$RESTO_A/cover/x.jpg")
assert_eq "manager B NE PEUT PAS écrire chez A (refus)" "1" "$RC"

log "=== Scénario 3 : un opérateur Scanym administre A ET B (aucun rôle restaurant_users requis) ==="
RC=$(try_insert "$OPERATOR" "$RESTO_A/logo/cccccccc-3333-4333-8333-333333333333.jpg")
assert_eq "scénario 3a: opérateur Scanym écrit chez A (succès, sans être owner/manager de A)" "0" "$RC"
RC=$(try_insert "$OPERATOR" "$RESTO_B/cover/dddddddd-4444-4444-8444-444444444444.jpg")
assert_eq "scénario 3b: opérateur Scanym écrit chez B (succès, sans être owner/manager de B)" "0" "$RC"

log "=== Restriction de rôle : staff refusé ==="
RC=$(try_insert "$STAFF_A" "$RESTO_A/logo/staff.jpg")
assert_eq "staff A NE PEUT PAS écrire (owner/manager/opérateur seulement)" "1" "$RC"

log "=== Scénario 4 : accès anonyme ==="
RC=$(try_insert_anon "$RESTO_A/logo/anon.jpg")
assert_eq "scénario 4: anon NE PEUT PAS écrire" "1" "$RC"

log "=== SELECT ==="
SEEN=$(psql -d "$DB" -t -A -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select count(*) from storage.objects where bucket_id='establishment-assets' and name = '$RESTO_A/logo/aaaaaaaa-1111-4111-8111-111111111111.jpg';
  reset role;
" | grep -E '^[0-9]+$')
assert_eq "SELECT autorisé : owner A voit un fichier de son propre établissement A" "1" "$SEEN"

SEEN=$(psql -d "$DB" -t -A -c "
  set role authenticated; set local test.uid = '$MANAGER_B';
  select count(*) from storage.objects where bucket_id='establishment-assets' and name = '$RESTO_A/logo/aaaaaaaa-1111-4111-8111-111111111111.jpg';
  reset role;
" | grep -E '^[0-9]+$')
assert_eq "SELECT refusé : manager B ne voit AUCUNE ligne d'un fichier de l'établissement A" "0" "$SEEN"

SEEN=$(psql -d "$DB" -t -A -c "
  set role authenticated; set local test.uid = '$OPERATOR';
  select count(*) from storage.objects where bucket_id='establishment-assets' and name = '$RESTO_A/logo/aaaaaaaa-1111-4111-8111-111111111111.jpg';
  reset role;
" | grep -E '^[0-9]+$')
assert_eq "SELECT autorisé : l'opérateur Scanym voit un fichier de N'IMPORTE QUEL établissement" "1" "$SEEN"

SEEN=$(psql -d "$DB" -t -A -c "
  set role anon;
  select count(*) from storage.objects where bucket_id='establishment-assets' and name = '$RESTO_A/logo/aaaaaaaa-1111-4111-8111-111111111111.jpg';
" | grep -E '^[0-9]+$')
assert_eq "SELECT refusé : anon ne voit AUCUNE ligne via SQL (lecture publique via l'URL HTTP dédiée uniquement)" "0" "$SEEN"

log "=== UPDATE ==="
TAG=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  update storage.objects set owner = '$OWNER_A' where bucket_id='establishment-assets' and name = '$RESTO_A/logo/aaaaaaaa-1111-4111-8111-111111111111.jpg';
  reset role;
" 2>&1 | grep -o "UPDATE [0-9]*")
assert_eq "UPDATE autorisé : owner A modifie un fichier de son propre établissement A (1 ligne)" "UPDATE 1" "$TAG"

TAG=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$MANAGER_B';
  update storage.objects set owner = '$MANAGER_B' where bucket_id='establishment-assets' and name = '$RESTO_A/logo/aaaaaaaa-1111-4111-8111-111111111111.jpg';
  reset role;
" 2>&1 | grep -o "UPDATE [0-9]*")
assert_eq "UPDATE refusé : manager B ne peut pas modifier un fichier de l'établissement A (0 ligne)" "UPDATE 0" "$TAG"
OWNER_UNCHANGED=$(psql -d "$DB" -t -A -c "select owner from storage.objects where name = '$RESTO_A/logo/aaaaaaaa-1111-4111-8111-111111111111.jpg';")
assert_eq "le fichier de l'établissement A n'a pas été modifié par la tentative refusée" "$OWNER_A" "$OWNER_UNCHANGED"

log "=== DELETE ==="
psql -d "$DB" -c "insert into storage.objects (bucket_id, name) values ('establishment-assets', '$RESTO_A/cover/99999999-7777-4777-8777-777777777777.jpg');" >/dev/null
TAG=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$MANAGER_B';
  delete from storage.objects where bucket_id='establishment-assets' and name = '$RESTO_A/cover/99999999-7777-4777-8777-777777777777.jpg';
  reset role;
" 2>&1 | grep -o "DELETE [0-9]*")
assert_eq "manager B NE PEUT PAS supprimer un fichier de l'établissement A (0 ligne)" "DELETE 0" "$TAG"
DELETED=$(psql -d "$DB" -t -A -c "select count(*) from storage.objects where name = '$RESTO_A/cover/99999999-7777-4777-8777-777777777777.jpg';")
assert_eq "le fichier de l'établissement A est toujours là après la tentative refusée" "1" "$DELETED"

TAG=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OPERATOR';
  delete from storage.objects where bucket_id='establishment-assets' and name = '$RESTO_A/cover/99999999-7777-4777-8777-777777777777.jpg';
  reset role;
" 2>&1 | grep -o "DELETE [0-9]*")
assert_eq "l'opérateur Scanym PEUT supprimer un fichier de N'IMPORTE QUEL établissement (1 ligne)" "DELETE 1" "$TAG"

log "=== Configuration du bucket (scénarios 5/6 — limite Storage, hors portée RLS) ==="
IS_PUBLIC=$(psql -d "$DB" -t -A -c "select public from storage.buckets where id = 'establishment-assets';")
assert_eq "le bucket establishment-assets est public (lecture via l'URL publique, sans policy SQL)" "t" "$IS_PUBLIC"
LIMIT=$(psql -d "$DB" -t -A -c "select file_size_limit from storage.buckets where id = 'establishment-assets';")
assert_eq "scénario 5: file_size_limit = 5 Mo (5242880 octets)" "5242880" "$LIMIT"
MIMES=$(psql -d "$DB" -t -A -c "select allowed_mime_types::text from storage.buckets where id = 'establishment-assets';")
assert_eq "scénario 6: allowed_mime_types = jpeg/png/webp uniquement" "{image/jpeg,image/png,image/webp}" "$MIMES"

log "=== RPC set_restaurant_logo / set_restaurant_cover (scénarios 7/8/10) ==="
# URLs conformes au chemin exigé par le durcissement V69 (section 7) :
# .../storage/v1/object/public/establishment-assets/{restaurant_id}/{logo|cover}/{uuid}.{ext}
LOGO_URL_A="https://fake.supabase.co/storage/v1/object/public/establishment-assets/$RESTO_A/logo/11111111-1111-4111-8111-111111111111.jpg"
COVER_URL_A="https://fake.supabase.co/storage/v1/object/public/establishment-assets/$RESTO_A/cover/22222222-2222-4222-8222-222222222222.jpg"
COVER_URL_B="https://fake.supabase.co/storage/v1/object/public/establishment-assets/$RESTO_B/cover/33333333-3333-4333-8333-333333333333.jpg"

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_logo('$RESTO_A', '$LOGO_URL_A');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "scénario 7: owner A peut appeler set_restaurant_logo pour son établissement, chemin conforme (succès)" "0" "$RC"
LOGO=$(psql -d "$DB" -t -A -c "select logo_url from public.restaurant_configs where restaurant_id = '$RESTO_A';")
assert_eq "scénario 7: logo_url mis à jour en base après succès de la RPC" "$LOGO_URL_A" "$LOGO"

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_cover('$RESTO_A', '$COVER_URL_A');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "scénario 8: owner A peut appeler set_restaurant_cover pour son établissement, chemin conforme (succès)" "0" "$RC"
COVER=$(psql -d "$DB" -t -A -c "select cover_url from public.restaurant_configs where restaurant_id = '$RESTO_A';")
assert_eq "scénario 8: cover_url mis à jour en base après succès de la RPC" "$COVER_URL_A" "$COVER"

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$MANAGER_B';
  select public.set_restaurant_logo('$RESTO_A', 'https://fake/hacked.jpg');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "manager B NE PEUT PAS appeler set_restaurant_logo pour l'établissement A (refus)" "1" "$RC"
LOGO_UNCHANGED=$(psql -d "$DB" -t -A -c "select logo_url from public.restaurant_configs where restaurant_id = '$RESTO_A';")
assert_eq "logo_url de l'établissement A inchangé après la tentative refusée" "$LOGO_URL_A" "$LOGO_UNCHANGED"

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OPERATOR';
  select public.set_restaurant_cover('$RESTO_B', '$COVER_URL_B');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "scénario 3 (RPC): l'opérateur Scanym peut appeler set_restaurant_cover pour N'IMPORTE QUEL établissement (B, succès)" "0" "$RC"

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$STAFF_A';
  select public.set_restaurant_logo('$RESTO_A', 'https://fake/staff.jpg');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "staff A NE PEUT PAS appeler set_restaurant_logo (réservé owner/manager/opérateur)" "1" "$RC"

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role anon;
  select public.set_restaurant_logo('$RESTO_A', 'https://fake/anon.jpg');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "appel anonyme (rôle anon, aucun EXECUTE accordé) à set_restaurant_logo refusé (permission denied)" "1" "$RC"

log "=== Scénario 10 : p_url = null réinitialise la colonne à NULL ==="
psql -d "$DB" -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_cover('$RESTO_A', null);
  reset role;
" >/dev/null
COVER_AFTER_DELETE=$(psql -d "$DB" -t -A -c "select coalesce(cover_url, '<NULL>') from public.restaurant_configs where restaurant_id = '$RESTO_A';")
assert_eq "scénario 10: cover_url réinitialisée à NULL après set_restaurant_cover(null)" "<NULL>" "$COVER_AFTER_DELETE"
LOGO_STILL_SET=$(psql -d "$DB" -t -A -c "select coalesce(logo_url, '<NULL>') from public.restaurant_configs where restaurant_id = '$RESTO_A';")
assert_eq "logo_url n'est PAS affectée par la réinitialisation de cover_url (colonnes indépendantes)" "$LOGO_URL_A" "$LOGO_STILL_SET"

log "=== Scénario 13 : établissement préexistant sans cover_url renseignée reste fonctionnel ==="
psql_one "création restaurant C" -d "$DB" -c "insert into public.restaurants (name, slug) values ('C', 'v68-resto-c') returning id;"
RESTO_C="$PSQL_ONE_VALUE"
psql -d "$DB" -c "insert into public.restaurant_configs (restaurant_id, whatsapp_number) values ('$RESTO_C', '+213000002');" >/dev/null
LOGO_C=$(psql -d "$DB" -t -A -c "select coalesce(logo_url, '<NULL>') from public.restaurant_configs where restaurant_id = '$RESTO_C';")
COVER_C=$(psql -d "$DB" -t -A -c "select coalesce(cover_url, '<NULL>') from public.restaurant_configs where restaurant_id = '$RESTO_C';")
assert_eq "établissement C créé après V68 sans logo/cover -- logo_url NULL par défaut (aucune régression)" "<NULL>" "$LOGO_C"
assert_eq "établissement C créé après V68 sans logo/cover -- cover_url NULL par défaut (colonne additive, sans effet de bord)" "<NULL>" "$COVER_C"

log "=== V69 section 8 : restriction du 2e segment de chemin à {logo, cover} ==="
RC=$(try_insert "$OWNER_A" "$RESTO_A/other/x.jpg")
assert_eq "V69: owner A NE PEUT PAS écrire sous {restaurant_id}/other/... (2e segment non autorisé)" "1" "$RC"
RC=$(try_insert "$OWNER_A" "$RESTO_A/menu/x.jpg")
assert_eq "V69: owner A NE PEUT PAS écrire sous {restaurant_id}/menu/... (2e segment non autorisé)" "1" "$RC"
RC=$(try_insert "$OPERATOR" "$RESTO_B/other/x.jpg")
assert_eq "V69: même l'opérateur Scanym NE PEUT PAS écrire sous un 2e segment hors {logo,cover}" "1" "$RC"
RC=$(try_insert "$OWNER_A" "$RESTO_A/logo/eeeeeeee-5555-4555-8555-555555555555.jpg")
assert_eq "V69: {restaurant_id}/logo/... toujours accepté après durcissement (non-régression)" "0" "$RC"
RC=$(try_insert "$OWNER_A" "$RESTO_A/cover/ffffffff-6666-4666-8666-666666666666.jpg")
assert_eq "V69: {restaurant_id}/cover/... toujours accepté après durcissement (non-régression)" "0" "$RC"

log "=== V69 section 7 : validation du chemin d'URL dans set_restaurant_logo/_cover ==="
RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_logo('$RESTO_A', 'https://evil.example.com/image.jpg');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "V69: set_restaurant_logo refuse une URL sans le chemin Storage attendu (aucune structure de chemin correspondante)" "1" "$RC"

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_logo('$RESTO_A', 'https://fake.supabase.co/storage/v1/object/public/establishment-assets/$RESTO_B/logo/11111111-1111-4111-8111-111111111111.jpg');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "V69: set_restaurant_logo refuse une URL dont le restaurant_id du chemin diffère du restaurant appelé (owner A tente de pointer vers B)" "1" "$RC"

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_logo('$RESTO_A', '$COVER_URL_A');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "V69: set_restaurant_logo refuse une URL /cover/ (mauvais type d'asset pour cette RPC)" "1" "$RC"

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_logo('$RESTO_A', 'https://fake.supabase.co/storage/v1/object/public/establishment-assets/$RESTO_A/logo/not-a-uuid.jpg');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "V69: set_restaurant_logo refuse un nom de fichier qui n'est pas un UUID" "1" "$RC"
LOGO_UNCHANGED_AFTER_HARDENING=$(psql -d "$DB" -t -A -c "select logo_url from public.restaurant_configs where restaurant_id = '$RESTO_A';")
assert_eq "V69: logo_url de A inchangé après toutes les tentatives d'URL non conformes ci-dessus" "$LOGO_URL_A" "$LOGO_UNCHANGED_AFTER_HARDENING"

log "=== V69 : update_restaurant_colors ==="
RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.update_restaurant_colors('$RESTO_A', '#5C3A21', '#F3E6D0', '#C99A48');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "couleurs #RRGGBB valides acceptées par owner A (succès)" "0" "$RC"
COLORS=$(psql -d "$DB" -t -A -c "select primary_color || ',' || secondary_color || ',' || accent_color from public.restaurant_configs where restaurant_id = '$RESTO_A';")
assert_eq "les 3 couleurs sont bien persistées en base" "#5C3A21,#F3E6D0,#C99A48" "$COLORS"

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.update_restaurant_colors('$RESTO_A', 'red', null, null);
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "couleur mal formée ('red', pas #RRGGBB) refusée" "1" "$RC"

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.update_restaurant_colors('$RESTO_A', '#FFF', null, null);
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "couleur mal formée (forme courte #FFF, pas #RRGGBB) refusée" "1" "$RC"

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.update_restaurant_colors('$RESTO_A', null, null, null);
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "les 3 couleurs NULL (réinitialisation) acceptées" "0" "$RC"
COLORS_RESET=$(psql -d "$DB" -t -A -c "select coalesce(primary_color,'<NULL>') || ',' || coalesce(secondary_color,'<NULL>') || ',' || coalesce(accent_color,'<NULL>') from public.restaurant_configs where restaurant_id = '$RESTO_A';")
assert_eq "les 3 couleurs sont bien réinitialisées à NULL en base" "<NULL>,<NULL>,<NULL>" "$COLORS_RESET"

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$STAFF_A';
  select public.update_restaurant_colors('$RESTO_A', '#111111', null, null);
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "staff A NE PEUT PAS appeler update_restaurant_colors" "1" "$RC"

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$MANAGER_B';
  select public.update_restaurant_colors('$RESTO_A', '#111111', null, null);
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "manager B NE PEUT PAS appeler update_restaurant_colors pour l'établissement A" "1" "$RC"

log "=== V69/V70 : update_restaurant_maps_url (colonne maps_url après V70, F-02) ==="
RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.update_restaurant_maps_url('$RESTO_A', 'https://maps.app.goo.gl/abc123');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "lien de localisation https valide accepté par owner A (succès)" "0" "$RC"
MAPS_URL_DB=$(psql -d "$DB" -t -A -c "select maps_url from public.restaurant_configs where restaurant_id = '$RESTO_A';")
assert_eq "maps_url mis à jour en base après succès de la RPC" "https://maps.app.goo.gl/abc123" "$MAPS_URL_DB"

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.update_restaurant_maps_url('$RESTO_A', 'javascript:alert(1)');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "lien 'javascript:...' refusé" "1" "$RC"
MAPS_URL_UNCHANGED=$(psql -d "$DB" -t -A -c "select maps_url from public.restaurant_configs where restaurant_id = '$RESTO_A';")
assert_eq "maps_url inchangé après la tentative refusée" "https://maps.app.goo.gl/abc123" "$MAPS_URL_UNCHANGED"

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.update_restaurant_maps_url('$RESTO_A', 'http://maps.app.goo.gl/abc123');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "F-02: lien http:// désormais REFUSÉ (https strictement obligatoire)" "1" "$RC"
MAPS_URL_STILL_UNCHANGED=$(psql -d "$DB" -t -A -c "select maps_url from public.restaurant_configs where restaurant_id = '$RESTO_A';")
assert_eq "maps_url inchangé après la tentative http:// refusée" "https://maps.app.goo.gl/abc123" "$MAPS_URL_STILL_UNCHANGED"

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.update_restaurant_maps_url('$RESTO_A', null);
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "lien de localisation NULL (réinitialisation) accepté" "0" "$RC"
MAPS_URL_AFTER_RESET=$(psql -d "$DB" -t -A -c "select coalesce(maps_url, '<NULL>') from public.restaurant_configs where restaurant_id = '$RESTO_A';")
assert_eq "maps_url réinitialisé à NULL en base" "<NULL>" "$MAPS_URL_AFTER_RESET"

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$STAFF_A';
  select public.update_restaurant_maps_url('$RESTO_A', 'https://maps.app.goo.gl/xyz');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "staff A NE PEUT PAS appeler update_restaurant_maps_url" "1" "$RC"

log "=== F-01 : opérateur Scanym peut appeler update_restaurant_colors ET update_restaurant_maps_url pour N'IMPORTE QUEL établissement ==="
RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OPERATOR';
  select public.update_restaurant_colors('$RESTO_B', '#123456', '#654321', '#ABCDEF');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "F-01: opérateur Scanym peut appeler update_restaurant_colors pour B (succès, sans rôle restaurant_users sur B)" "0" "$RC"
OPERATOR_COLORS=$(psql -d "$DB" -t -A -c "select primary_color from public.restaurant_configs where restaurant_id = '$RESTO_B';")
assert_eq "F-01: couleurs de B mises à jour par l'opérateur" "#123456" "$OPERATOR_COLORS"

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OPERATOR';
  select public.update_restaurant_maps_url('$RESTO_B', 'https://maps.app.goo.gl/operator-b');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "F-01: opérateur Scanym peut appeler update_restaurant_maps_url pour B (succès)" "0" "$RC"

RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$MANAGER_B';
  select public.update_restaurant_maps_url('$RESTO_A', 'https://maps.app.goo.gl/xyz');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "manager B NE PEUT PAS appeler update_restaurant_maps_url pour l'établissement A" "1" "$RC"

log "=== F-01 : lecture opérateur (SELECT restaurant_configs/restaurants), établissement 'onboarding' (pas encore public) ==="
# Les 3 restaurants de test sont créés sans statut explicite ->
# status='onboarding' par défaut (migration-lotd), donc INVISIBLES via
# la policy publique "actifs" : seule une policy membre ou opérateur
# peut les rendre lisibles ici -- preuve propre que ce sont bien les 2
# nouvelles policies "lecture operateur ..." qui opèrent, pas un accès
# public incidental.
RESTO_STATUS=$(psql -d "$DB" -t -A -c "select status from public.restaurants where id = '$RESTO_A';")
assert_eq "précondition : restaurant A est bien 'onboarding' (pas 'active'), donc pas lisible publiquement" "onboarding" "$RESTO_STATUS"

SEEN=$(psql -d "$DB" -t -A -c "
  set role authenticated; set local test.uid = '$OPERATOR';
  select count(*) from public.restaurant_configs where restaurant_id = '$RESTO_A';
  reset role;
" | grep -E '^[0-9]+$')
assert_eq "F-01: opérateur Scanym peut SELECT restaurant_configs de A, bien qu'onboarding et hors restaurant_users" "1" "$SEEN"

SEEN=$(psql -d "$DB" -t -A -c "
  set role authenticated; set local test.uid = '$OPERATOR';
  select count(*) from public.restaurants where id = '$RESTO_A';
  reset role;
" | grep -E '^[0-9]+$')
assert_eq "F-01: opérateur Scanym peut SELECT restaurants (nom/slug) de A" "1" "$SEEN"

SEEN=$(psql -d "$DB" -t -A -c "
  set role authenticated; set local test.uid = '$MANAGER_B';
  select count(*) from public.restaurant_configs where restaurant_id = '$RESTO_A';
  reset role;
" | grep -E '^[0-9]+$')
assert_eq "manager B (non-opérateur) NE VOIT TOUJOURS PAS restaurant_configs de A (aucun élargissement d'accès pour les non-opérateurs)" "0" "$SEEN"

# ============================================================
# EXTENSION V71 (suite) — findings V70-01 (scénarios 4-7 : host
# correct, host malveillant, mauvais restaurant, mauvais type
# d'asset), V70-04, V70-05, V70-07. Réutilise $RESTO_A/$OWNER_A déjà
# créés ; app.storage_public_base_url déjà configuré au niveau base
# (https://fake.supabase.co) plus haut -- les scénarios 1/2/3
# (absent/vide/malformé) ont déjà été exécutés AVANT cette
# configuration, voir plus haut dans ce fichier.
# ============================================================

log "=== V70-01/4 : réglage CORRECT + URL Storage correcte -> PASS ==="
RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_logo('$RESTO_A', 'https://fake.supabase.co/storage/v1/object/public/establishment-assets/$RESTO_A/logo/$VALID_FILE_UUID.jpg');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "V70-01: réglage correct + URL correcte -> succès" "0" "$RC"

log "=== V70-01/5 : MAUVAIS HOST avec un chemin PARFAITEMENT valide -> REFUS (exemple critique de l'audit) ==="
RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_logo('$RESTO_A', 'https://evil.example/storage/v1/object/public/establishment-assets/$RESTO_A/logo/$VALID_FILE_UUID.jpg');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "V70-01: host malveillant avec chemin par ailleurs valide -> échec (exemple critique de l'audit)" "1" "$RC"

log "=== V70-01/6 : bon host + MAUVAIS restaurant_id dans le chemin -> REFUS ==="
RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_logo('$RESTO_A', 'https://fake.supabase.co/storage/v1/object/public/establishment-assets/$RESTO_B/logo/$VALID_FILE_UUID.jpg');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "V70-01: bon host mais restaurant_id d'un AUTRE établissement dans le chemin -> échec" "1" "$RC"

log "=== V70-01/7 : bon host + MAUVAIS type d'asset (cover au lieu de logo) -> REFUS ==="
RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_logo('$RESTO_A', 'https://fake.supabase.co/storage/v1/object/public/establishment-assets/$RESTO_A/cover/$VALID_FILE_UUID.jpg');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "V70-01: bon host, bon restaurant, mais 'cover' passé à set_restaurant_logo -> échec" "1" "$RC"

log "=== V70-07 : UUID de nom de fichier malformé -> REFUS (avec réglage host correct) ==="
declare -A BAD_UUIDS=(
  ["36 tirets"]="------------------------------------"
  ["hex sans tiret"]="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  ["tirets mal placés"]="423ed4e48-e50-4cb6-b9c0-685ce62a8543"
  ["trop court"]="423ed4e4-8e50-4cb6-b9c0-685ce62a854"
  ["trop long"]="423ed4e4-8e50-4cb6-b9c0-685ce62a85433"
)
for desc in "${!BAD_UUIDS[@]}"; do
  bad="${BAD_UUIDS[$desc]}"
  RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
    set role authenticated; set local test.uid = '$OWNER_A';
    select public.set_restaurant_logo('$RESTO_A', 'https://fake.supabase.co/storage/v1/object/public/establishment-assets/$RESTO_A/logo/$bad.jpg');
    reset role;
  " >/dev/null 2>&1 && echo "0" || echo "1")
  assert_eq "V70-07: UUID malformé ($desc) refusé" "1" "$RC"
done

log "=== V70-07 : UUID réel généré (gen_random_uuid) accepté ==="
RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_cover('$RESTO_A', 'https://fake.supabase.co/storage/v1/object/public/establishment-assets/$RESTO_A/cover/$VALID_FILE_UUID.png');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "V70-07: UUID réel (gen_random_uuid) accepté" "0" "$RC"

log "=== V70-04 : maps_url structurellement invalide -> REFUS ==="
declare -A BAD_MAPS=(
  ["host vide"]="https:///chemin"
  ["schéma seul"]="https://"
  ["http"]="http://maps.example.com/x"
  ["javascript"]="javascript:alert(1)"
  ["data"]="data:text/html,x"
)
for desc in "${!BAD_MAPS[@]}"; do
  bad="${BAD_MAPS[$desc]}"
  RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
    set role authenticated; set local test.uid = '$OWNER_A';
    select public.update_restaurant_maps_url('$RESTO_A', '$bad');
  " >/dev/null 2>&1 && echo "0" || echo "1")
  assert_eq "V70-04: maps_url invalide ($desc) refusée" "1" "$RC"
done

log "=== V70-04 : maps_url https structurellement valide -> PASS, NULL toujours accepté ==="
RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.update_restaurant_maps_url('$RESTO_A', 'https://maps.app.goo.gl/valide123');
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "V70-04: maps_url https valide acceptée" "0" "$RC"
RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.update_restaurant_maps_url('$RESTO_A', null);
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "V70-04: maps_url NULL toujours acceptée (retrait)" "0" "$RC"

log "=== V70-05 : double colonne google_maps_url + maps_url -> migration V71 refuse de s'appliquer ==="
DB_DBL="scanym_v71_dbl_$$"
psql -c "drop database if exists \"$DB_DBL\";" >/dev/null 2>&1 || true
createdb "$DB_DBL"
psql -d "$DB_DBL" >/dev/null <<'SQL'
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
  psql -d "$DB_DBL" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  psql -d "$DB_DBL" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
done
psql -d "$DB_DBL" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v67-product-photos.sql" >/dev/null 2>&1
psql -d "$DB_DBL" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v67b-category-description-product-order.sql" >/dev/null 2>&1
psql -d "$DB_DBL" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-lotd-establishment-creation.sql" >/dev/null 2>&1
psql -d "$DB_DBL" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-lotd-rls-reference-tables-fix.sql" >/dev/null 2>&1
psql -d "$DB_DBL" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v68-establishment-assets.sql" >/dev/null 2>&1
psql -d "$DB_DBL" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v69-identity-colors-maps-hardening.sql" >/dev/null 2>&1
psql -d "$DB_DBL" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v70-identity-corrections.sql" >/dev/null 2>&1
# Corrige V76 : migration-v71-hardening.sql (éditée) dépend désormais de
# scanym_internal -- doit être appliquée dans CE sous-chaînage aussi,
# sinon le refus attendu (double colonne) serait masqué par un refus
# différent (dépendance V76 manquante).
psql -d "$DB_DBL" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v76-storage-origin-config.sql" >/dev/null 2>&1
psql -d "$DB_DBL" -c "insert into scanym_internal.storage_config (id, storage_public_origin) values (true, 'https://fake.supabase.co');" >/dev/null 2>&1
psql -d "$DB_DBL" -c "alter table public.restaurant_configs add column google_maps_url text;" >/dev/null 2>&1
DBL_OUT=$(psql -d "$DB_DBL" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v71-hardening.sql" 2>&1 || true)
if echo "$DBL_OUT" | grep -q "SIMULTANÉMENT"; then
  pass "V70-05: migration V71 refuse explicitement l'état double-colonne (google_maps_url + maps_url)"
else
  fail "V70-05: la migration V71 aurait dû refuser explicitement l'état double-colonne"
fi
COL_MAPS_STILL_THERE=$(psql -d "$DB_DBL" -t -A -c "select count(*) from information_schema.columns where table_name='restaurant_configs' and column_name='maps_url';")
assert_eq "V70-05: aucune modification appliquée après le refus (maps_url toujours présente, état inchangé)" "1" "$COL_MAPS_STILL_THERE"
psql -c "drop database if exists \"$DB_DBL\";" >/dev/null 2>&1 || true

# ============================================================
# V71-01 (contre-audit Work, 2e tour) : psql_one() ne doit JAMAIS
# transformer une vraie erreur psql en succès apparent.
#
# psql_expect_failure() : variante SANS appel à fail() en interne --
# contrairement à psql_one(), une défaillance psql ICI est le résultat
# ATTENDU du scénario (on prouve que l'échec est bien détecté), pas un
# problème du harnais lui-même : elle ne doit donc jamais alimenter
# FAIL_COUNT à elle seule. C'est l'appelant qui décide pass/fail selon
# que l'échec attendu a bien eu lieu.
# ============================================================
psql_expect_failure() {
  local output status
  output=$(psql -X -A -t -v ON_ERROR_STOP=1 "$@" 2>&1)
  status=$?
  PSQL_EXPECT_STATUS=$status
  PSQL_EXPECT_OUTPUT="$output"
  [ "$status" -ne 0 ]
}

log "=== V71-01/1 : succès normal -- une valeur réelle est bien extraite ==="
if psql_one "succès normal" -d "$DB" -c "select 42;"; then
  assert_eq "succès normal : valeur correctement extraite" "42" "$PSQL_ONE_VALUE"
else
  fail "succès normal : psql_one aurait dû réussir"
fi

log "=== V71-01/2 : erreur SQL volontaire -- DOIT échouer, jamais un PASS ==="
if psql_expect_failure -d "$DB" -c "select 1/0;"; then
  pass "V71-01: erreur SQL volontaire (division par zéro) correctement détectée comme échec (code=$PSQL_EXPECT_STATUS, jamais masqué par || true)"
else
  fail "V71-01: une erreur SQL volontaire aurait dû être détectée comme échec, pas comme succès"
fi

log "=== V71-01/3 : connexion impossible (base inexistante) -- DOIT échouer ==="
if psql_expect_failure -d "scanym_v71_base_inexistante_$$" -c "select 1;"; then
  pass "V71-01: connexion impossible correctement détectée comme échec (code=$PSQL_EXPECT_STATUS)"
else
  fail "V71-01: une connexion impossible aurait dû être détectée comme échec"
fi

log "=== V71-01/4 : commande retournant ZÉRO ligne -- DOIT échouer (pas de valeur exploitable) ==="
# Corrige V72-01 (contre-audit Work, 3e tour) : appelle
# psql_one_silent() DIRECTEMENT (jamais fail() en interne, jamais de
# réinitialisation de PASS_COUNT/FAIL_COUNT) -- élimine
# structurellement le défaut trouvé par Work (un vrai FAIL apparaissant
# dans le journal puis disparaissant du compteur final).
if psql_one_silent -d "$DB" -c "select id from public.restaurants where slug = 'ce-slug-n-existe-pas-du-tout';"; then
  fail "V71-01: une commande sans ligne retournée aurait dû être détectée comme échec"
else
  pass "V71-01: commande à 0 ligne correctement détectée comme échec (jamais une valeur vide traitée comme un succès)"
fi

log "=== V71-01/5 : sortie partielle SUIVIE d'une erreur -- DOIT échouer malgré la sortie déjà produite ==="
if psql_expect_failure -d "$DB" -c "select 'valeur-plausible'; select 1/0;"; then
  pass "V71-01: sortie partielle plausible + erreur réelle correctement détectée comme échec (code de sortie vérifié AVANT toute extraction de valeur)"
else
  fail "V71-01: une sortie partielle plausible suivie d'une erreur réelle aurait dû être détectée comme échec"
fi

log "=== V71-01/6 : aucun SIGPIPE (psql_one ne pipe jamais directement depuis psql, sortie entièrement capturée en mémoire) ==="
SIGPIPE_OK="OK"
for i in 1 2 3 4 5; do
  if ! psql -X -A -t -v ON_ERROR_STOP=1 -d "$DB" -c "select generate_series(1,200);" >/dev/null 2>&1; then
    SIGPIPE_OK="ECHEC-ITERATION-$i"
    break
  fi
done
assert_eq "V71-01: 5 appels psql répétés sans SIGPIPE" "OK" "$SIGPIPE_OK"

log "=== V71-01/7 : re-confirmation -- l'ancien patron aurait laissé passer ce cas comme un succès, psql_one ne le fait plus ==="
if psql_expect_failure -d "$DB" -c "select 1/0;"; then
  pass "V71-01: re-confirmation -- erreur SQL volontaire toujours correctement détectée après plusieurs appels successifs"
else
  fail "V71-01: re-confirmation -- une erreur SQL volontaire aurait dû être détectée comme échec"
fi

# ============================================================
# V71-03 (contre-audit Work, 2e tour) : rejoue la MÊME matrice
# partagée que côté TypeScript (tests/maps-url-shared-matrix.tsv) --
# preuve de parité PAR CONSTRUCTION, jamais par ressemblance de deux
# regex écrites séparément.
# ============================================================
log "=== V72-06/V72-07 : matrice partagée maps_url rejouée côté SQL (source unique avec tests/v73-hardening.test.ts, grammaire V73 -- espaces/retours ligne périphériques, port borné) ==="
MATRIX_PASS=0
MATRIX_FAIL=0
while IFS= read -r line; do
  case "$line" in
    "#"*|"") continue ;;
  esac
  EXPECTED=$(printf '%s' "$line" | cut -f1)
  DESC=$(printf '%s' "$line" | cut -f2)
  B64=$(printf '%s' "$line" | cut -f3)
  if [ -n "$B64" ]; then
    # Corrige un artefact réel du harnais (pas du SQL/TypeScript) :
    # la substitution de commande bash $(...) supprime TOUJOURS les
    # retours ligne finaux de sa sortie -- un cas comme "retour ligne
    # en fin" (V72-06) verrait sa fin réelle silencieusement tronquée
    # avant même d'atteindre psql, faussant le test sans rapport avec
    # la validation elle-même (déjà prouvée correcte indépendamment
    # via tests/v73-hardening.test.ts et le script Python de
    # vérification manuelle). Sentinelle "X" ajoutée après le
    # décodage, retirée ensuite via une expansion de paramètre : les
    # retours ligne RÉELLEMENT en fin de valeur survivent puisqu'un
    # caractère non-vide les suit désormais lors de la capture.
    VAL=$(printf '%s' "$B64" | base64 -d 2>/dev/null; printf 'X')
    VAL="${VAL%X}"
  else
    VAL=""
  fi
  ESCAPED=$(printf '%s' "$VAL" | sed "s/'/''/g"; printf 'X')
  ESCAPED="${ESCAPED%X}"
  if psql -X -A -t -v ON_ERROR_STOP=1 -d "$DB" -c "
    set role authenticated; set local test.uid = '$OWNER_A';
    select public.update_restaurant_maps_url('$RESTO_A', '$ESCAPED');
  " >/dev/null 2>&1; then
    GOT="1"
  else
    GOT="0"
  fi
  if [ "$GOT" = "$EXPECTED" ]; then
    MATRIX_PASS=$((MATRIX_PASS+1))
  else
    MATRIX_FAIL=$((MATRIX_FAIL+1))
    fail "V71-03 matrice partagée: \"$DESC\" -- attendu accept=$EXPECTED, obtenu accept=$GOT"
  fi
done < "$ROOT/tests/maps-url-shared-matrix.tsv"
assert_eq "V71-03: toutes les lignes de la matrice partagée concordent entre TypeScript et SQL" "0" "$MATRIX_FAIL"
pass "V71-03: $MATRIX_PASS/$((MATRIX_PASS+MATRIX_FAIL)) lignes de la matrice partagée exécutées avec succès côté SQL"

# ============================================================
# V71-07 (contre-audit Work, 2e tour) : contrôle préalable des
# données historiques, sur des bases séparées dédiées (comme pour le
# scénario double-colonne existant).
# ============================================================
log "=== V71-07/1 : restaurants.id historique non conforme au format UUID v4 -> migration V72 refuse de s'appliquer ==="
DB_ANOMALY1="scanym_v72_anomaly1_$$"
psql -c "drop database if exists \"$DB_ANOMALY1\";" >/dev/null 2>&1 || true
createdb "$DB_ANOMALY1"
psql -d "$DB_ANOMALY1" >/dev/null <<'SQL'
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
  psql -d "$DB_ANOMALY1" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  psql -d "$DB_ANOMALY1" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
done
for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v76-storage-origin-config.sql migration-v71-hardening.sql; do
  psql -d "$DB_ANOMALY1" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
done
psql -d "$DB_ANOMALY1" -c "insert into public.restaurants (id, name, slug, is_active, status) values ('11111111-1111-1111-1111-111111111111','Historique','historique-slug',true,'active');" >/dev/null
ANOMALY1_OUT=$(psql -d "$DB_ANOMALY1" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v72-hardening.sql" 2>&1 || true)
if echo "$ANOMALY1_OUT" | grep -q "restaurants.id non conforme"; then
  pass "V71-07: migration V72 refuse explicitement un restaurants.id historique non-v4, message exploitable"
else
  fail "V71-07: migration V72 aurait dû refuser explicitement un restaurants.id historique non-v4"
fi
CONSTRAINT_UNCHANGED=$(psql -d "$DB_ANOMALY1" -t -A -c "select pg_get_constraintdef(oid) from pg_constraint where conname='restaurant_configs_maps_url_format';")
if echo "$CONSTRAINT_UNCHANGED" | grep -q '\[\^/'; then
  pass "V71-07: aucune modification appliquée après le refus (contrainte reste sous forme V71, pas la forme stricte V72)"
else
  fail "V71-07: la contrainte aurait dû rester sous sa forme V71 après le refus de la migration V72"
fi
psql -c "drop database if exists \"$DB_ANOMALY1\";" >/dev/null 2>&1 || true

log "=== V71-07/2 : chemin storage.objects historique non conforme au format attendu -> migration V72 refuse de s'appliquer ==="
DB_ANOMALY2="scanym_v72_anomaly2_$$"
psql -c "drop database if exists \"$DB_ANOMALY2\";" >/dev/null 2>&1 || true
createdb "$DB_ANOMALY2"
psql -d "$DB_ANOMALY2" >/dev/null <<'SQL'
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
  psql -d "$DB_ANOMALY2" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  psql -d "$DB_ANOMALY2" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
done
for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v76-storage-origin-config.sql migration-v71-hardening.sql; do
  psql -d "$DB_ANOMALY2" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
done
psql -d "$DB_ANOMALY2" -c "insert into storage.objects (bucket_id, name) values ('establishment-assets', '22222222-2222-2222-2222-222222222222/logo/nom-de-fichier-pas-uuid-du-tout.jpg');" >/dev/null
ANOMALY2_OUT=$(psql -d "$DB_ANOMALY2" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v72-hardening.sql" 2>&1 || true)
if echo "$ANOMALY2_OUT" | grep -q "establishment-assets ne respectent pas"; then
  pass "V71-07: migration V72 refuse explicitement un chemin storage.objects historique non conforme, message exploitable"
else
  fail "V71-07: migration V72 aurait dû refuser explicitement un chemin storage.objects historique non conforme"
fi
psql -c "drop database if exists \"$DB_ANOMALY2\";" >/dev/null 2>&1 || true

log "=== V71-07/3 : données propres (le cas normal de ce harnais, déjà passées par V72 plus haut) -> continue normalement (déjà confirmé) ==="
pass "V71-07: confirmé plus haut -- migration V72 appliquée sans erreur sur ce stand-in dont les données sont conformes"

# ============================================================
# HARNESS SELF-TEST (V72-01, contre-audit Work, 3e tour) : le script
# ne doit JAMAIS pouvoir annoncer un succès final si un seul FAIL a
# été produit, MÊME si $FAIL_COUNT lui-même a été corrompu (bug futur,
# manipulation accidentelle...). Vérifie le journal INDÉPENDANT
# ($FAIL_LOG, écrit par fail() elle-même, jamais réinitialisable par
# le corps du script) plutôt que de faire confiance au seul compteur.
# ============================================================
# ============================================================
# V72-05 (contre-audit Work, 3e tour) : chemin Storage EXACT, pas
# seulement les segments [1]/[2] pris séparément. Réutilise
# $RESTO_A/$OWNER_A déjà créés, app.storage_public_base_url déjà
# configuré au niveau base (https://fake.supabase.co) plus haut.
# ============================================================
V72_05_FILE_UUID=$(psql -X -A -t -v ON_ERROR_STOP=1 -d "$DB" -c "select gen_random_uuid();")

log "=== V72-05/1 : chemin exact (uuid/logo/uuid.ext) -> ACCEPTÉ ==="
if psql -v ON_ERROR_STOP=1 -d "$DB" -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_logo('$RESTO_A', 'https://fake.supabase.co/storage/v1/object/public/establishment-assets/$RESTO_A/logo/$V72_05_FILE_UUID.jpg');
" >/dev/null 2>&1; then
  pass "V72-05: chemin exact accepté"
else
  fail "V72-05: le chemin exact aurait dû être accepté"
fi

log "=== V72-05/2 : segment intermédiaire (uuid/logo/a/uuid.ext) -> REFUSÉ ==="
if psql -v ON_ERROR_STOP=1 -d "$DB" -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_logo('$RESTO_A', 'https://fake.supabase.co/storage/v1/object/public/establishment-assets/$RESTO_A/logo/a/$V72_05_FILE_UUID.jpg');
" >/dev/null 2>&1; then
  fail "V72-05: un segment intermédiaire aurait dû être refusé"
else
  pass "V72-05: segment intermédiaire refusé"
fi

log "=== V72-05/3 : segment avant le type (uuid/x/logo/uuid.ext) -> REFUSÉ ==="
if psql -v ON_ERROR_STOP=1 -d "$DB" -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_logo('$RESTO_A', 'https://fake.supabase.co/storage/v1/object/public/establishment-assets/$RESTO_A/x/logo/$V72_05_FILE_UUID.jpg');
" >/dev/null 2>&1; then
  fail "V72-05: un segment avant le type aurait dû être refusé"
else
  pass "V72-05: segment avant le type refusé"
fi

log "=== V72-05/4 : double slash (uuid//logo/uuid.ext) -> REFUSÉ ==="
if psql -v ON_ERROR_STOP=1 -d "$DB" -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_logo('$RESTO_A', 'https://fake.supabase.co/storage/v1/object/public/establishment-assets/$RESTO_A//logo/$V72_05_FILE_UUID.jpg');
" >/dev/null 2>&1; then
  fail "V72-05: un double slash aurait dû être refusé"
else
  pass "V72-05: double slash refusé"
fi

log "=== V72-05/5 : chemin sans nom de fichier (uuid/logo/) -> REFUSÉ ==="
if psql -v ON_ERROR_STOP=1 -d "$DB" -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_logo('$RESTO_A', 'https://fake.supabase.co/storage/v1/object/public/establishment-assets/$RESTO_A/logo/');
" >/dev/null 2>&1; then
  fail "V72-05: un chemin sans nom de fichier aurait dû être refusé"
else
  pass "V72-05: chemin sans nom de fichier refusé"
fi

log "=== V72-05/6 : chemin à 5 segments (uuid/logo/a/b/c) -> REFUSÉ ==="
if psql -v ON_ERROR_STOP=1 -d "$DB" -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_logo('$RESTO_A', 'https://fake.supabase.co/storage/v1/object/public/establishment-assets/$RESTO_A/logo/a/b/c');
" >/dev/null 2>&1; then
  fail "V72-05: un chemin à 5 segments aurait dû être refusé"
else
  pass "V72-05: chemin à 5 segments refusé"
fi

log "=== V72-05/7 : cover exact -> ACCEPTÉ ==="
if psql -v ON_ERROR_STOP=1 -d "$DB" -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_cover('$RESTO_A', 'https://fake.supabase.co/storage/v1/object/public/establishment-assets/$RESTO_A/cover/$V72_05_FILE_UUID.jpg');
" >/dev/null 2>&1; then
  pass "V72-05: chemin cover exact accepté"
else
  fail "V72-05: le chemin cover exact aurait dû être accepté"
fi

log "=== V72-05/8 : restaurant_id d'un AUTRE établissement dans le chemin -> REFUSÉ ==="
OTHER_UUID=$(psql -X -A -t -v ON_ERROR_STOP=1 -d "$DB" -c "select gen_random_uuid();")
if psql -v ON_ERROR_STOP=1 -d "$DB" -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_logo('$RESTO_A', 'https://fake.supabase.co/storage/v1/object/public/establishment-assets/$OTHER_UUID/logo/$V72_05_FILE_UUID.jpg');
" >/dev/null 2>&1; then
  fail "V72-05: un restaurant_id d'un autre établissement aurait dû être refusé"
else
  pass "V72-05: restaurant_id d'un autre établissement refusé"
fi

# ============================================================
# V76-01 (contre-audit Work, 7e tour) : fail-closed RÉELLEMENT testé
# au niveau de la RPC finale (set_restaurant_logo/_cover), pas
# seulement via une contrainte SQL ou la présence d'un libellé de
# test. Deux scénarios distincts exigés : table jamais configurée
# (vide dès le départ), et configuration VALIDE puis SUPPRIMÉE.
# ============================================================
V76_01_FILE_UUID=$(psql -X -A -t -v ON_ERROR_STOP=1 -d "$DB" -c "select gen_random_uuid();")

log "=== V76-01/1 : table de configuration VIDÉE (jamais configurée) -> appel RPC RÉEL doit échouer ==="
psql -d "$DB" -c "delete from scanym_internal.storage_config;" >/dev/null
EMPTY_COUNT=$(psql -X -A -t -d "$DB" -c "select count(*) from scanym_internal.storage_config;")
assert_eq "V76-01: précondition -- la table est bien vide (0 ligne réelle, pas une valeur invalide)" "0" "$EMPTY_COUNT"
if psql -v ON_ERROR_STOP=1 -d "$DB" -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_logo('$RESTO_A', 'https://fake.supabase.co/storage/v1/object/public/establishment-assets/$RESTO_A/logo/$V76_01_FILE_UUID.jpg');
" >/dev/null 2>&1; then
  fail "V76-01: l'appel RPC réel aurait dû échouer avec une table de configuration vide"
else
  pass "V76-01: appel RPC réel refusé avec une table de configuration vide (fail-closed réellement démontré, pas seulement une contrainte)"
fi

log "=== V76-01/2 : configuration VALIDE puis SUPPRIMÉE -> l'appel RPC redevient un échec ==="
psql -d "$DB" -c "insert into scanym_internal.storage_config (id, storage_public_origin) values (true, 'https://fake.supabase.co');" >/dev/null
if psql -v ON_ERROR_STOP=1 -d "$DB" -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_logo('$RESTO_A', 'https://fake.supabase.co/storage/v1/object/public/establishment-assets/$RESTO_A/logo/$V76_01_FILE_UUID.jpg');
" >/dev/null 2>&1; then
  pass "V76-01: précondition -- appel RPC réussit bien avec une configuration valide en place"
else
  fail "V76-01: précondition -- l'appel RPC aurait dû réussir avec une configuration valide"
fi
psql -d "$DB" -c "delete from scanym_internal.storage_config;" >/dev/null
if psql -v ON_ERROR_STOP=1 -d "$DB" -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select public.set_restaurant_cover('$RESTO_A', 'https://fake.supabase.co/storage/v1/object/public/establishment-assets/$RESTO_A/cover/$V76_01_FILE_UUID.jpg');
" >/dev/null 2>&1; then
  fail "V76-01: après suppression d'une configuration valide, l'appel RPC aurait dû échouer à nouveau"
else
  pass "V76-01: configuration valide puis supprimée -> l'appel RPC échoue à nouveau (fail-closed maintenu dans le temps, pas seulement à l'installation)"
fi
# Restauration de la configuration pour la suite du harnais.
psql -d "$DB" -c "insert into scanym_internal.storage_config (id, storage_public_origin) values (true, 'https://fake.supabase.co');" >/dev/null
pass "V76-01: configuration restaurée pour la suite du harnais"

# ============================================================
# V76-04 (contre-audit Work, 7e tour) : matrice des 17 cas exigés pour
# scanym_internal.is_valid_storage_origin() -- le MÊME helper que celui
# réutilisé par assert_establishment_asset_url (V71 édité), jamais une
# regex divergente testée séparément.
# ============================================================
log "=== V77-02 : matrice complète host + port (corrige le contournement rapporté par Work) ==="
declare -A HOST_PORT_CASES=(
  ["https://1 seul"]="0|https://1"
  ["https://1:443 (port ne doit PAS excuser un host numérique)"]="0|https://1:443"
  ["https://999.999.999.999 seul"]="0|https://999.999.999.999"
  ["https://999.999.999.999:443 (même piège avec port)"]="0|https://999.999.999.999:443"
  ["https://127.0.0.1 seul"]="0|https://127.0.0.1"
  ["https://127.0.0.1:5432 (même piège avec port)"]="0|https://127.0.0.1:5432"
  ["host DNS valide + port valide (example.com:443)"]="1|https://example.com:443"
  ["host DNS valide + port valide (sub.example.com:8443)"]="1|https://sub.example.com:8443"
  ["valeur réelle de Production toujours acceptée"]="1|https://ctqfpszwunfomrbxgigu.supabase.co"
)
for desc in "${!HOST_PORT_CASES[@]}"; do
  entry="${HOST_PORT_CASES[$desc]}"
  expected="${entry%%|*}"
  url="${entry#*|}"
  GOT=$(psql -X -A -t -d "$DB" -c "select scanym_internal.is_valid_storage_origin('$url');" | grep -q '^t$' && echo "1" || echo "0")
  assert_eq "V77-02: $desc ($url)" "$expected" "$GOT"
done

log "=== V76-04 : matrice complète de validation d'origine (17 cas exigés) ==="
declare -A ORIGIN_CASES=(
  ["origine Production valide"]="1|https://ctqfpszwunfomrbxgigu.supabase.co"
  ["HTTP (schéma refusé)"]="0|http://ctqfpszwunfomrbxgigu.supabase.co"
  ["slash final"]="0|https://ctqfpszwunfomrbxgigu.supabase.co/"
  ["path"]="0|https://ctqfpszwunfomrbxgigu.supabase.co/path"
  ["query"]="0|https://ctqfpszwunfomrbxgigu.supabase.co?x"
  ["fragment"]="0|https://ctqfpszwunfomrbxgigu.supabase.co#x"
  ["host vide"]="0|https://"
  ["port 0"]="0|https://ctqfpszwunfomrbxgigu.supabase.co:0"
  ["port 65536"]="0|https://ctqfpszwunfomrbxgigu.supabase.co:65536"
  ["port 99999"]="0|https://ctqfpszwunfomrbxgigu.supabase.co:99999"
  ["port valide 8443"]="1|https://ctqfpszwunfomrbxgigu.supabase.co:8443"
  ["host numérique nu (https://1)"]="0|https://1"
  ["host façon IP mal formée (999.999.999.999)"]="0|https://999.999.999.999"
  ["host débutant par un chiffre mais non purement numérique"]="1|https://3proxy.example.com"
)
for desc in "${!ORIGIN_CASES[@]}"; do
  entry="${ORIGIN_CASES[$desc]}"
  expected="${entry%%|*}"
  url="${entry#*|}"
  GOT=$(psql -X -A -t -d "$DB" -c "select scanym_internal.is_valid_storage_origin('$url');" | grep -q '^t$' && echo "1" || echo "0")
  assert_eq "V76-04: $desc ($url)" "$expected" "$GOT"
done
# Espace en tête/fin et retour ligne : testés directement (pas de
# piège de troncature ici, valeurs courtes et simples).
GOT=$(psql -X -A -t -d "$DB" -c "select scanym_internal.is_valid_storage_origin(' https://ctqfpszwunfomrbxgigu.supabase.co');" | grep -q '^t$' && echo "1" || echo "0")
assert_eq "V76-04: espace en tête" "0" "$GOT"
GOT=$(psql -X -A -t -d "$DB" -c "select scanym_internal.is_valid_storage_origin('https://ctqfpszwunfomrbxgigu.supabase.co ');" | grep -q '^t$' && echo "1" || echo "0")
assert_eq "V76-04: espace en fin" "0" "$GOT"
GOT=$(psql -X -A -t -d "$DB" -c $'select scanym_internal.is_valid_storage_origin(E\'https://ctqfpszwunfomrbxgigu.supabase.co\\n\');' | grep -q '^t$' && echo "1" || echo "0")
assert_eq "V76-04: retour ligne en fin" "0" "$GOT"

log "=== V76-04 : V71 édité réutilise le MÊME helper (pas une regex divergente) ==="
V71_USES_SHARED_HELPER=$(grep -c "scanym_internal.is_valid_storage_origin(v_base_url)" "$SUPABASE_DIR/migration-v71-hardening.sql")
assert_eq "V76-04: migration-v71-hardening.sql appelle bien le helper partagé" "1" "$V71_USES_SHARED_HELPER"

# ============================================================
# V77-03 (contre-audit Work, 8e tour) : anti-dérive V70 complet --
# 6 scénarios de dérive simulés sur une base séparée dédiée, chacun
# doit bloquer AVANT toute modification par migration-v71-hardening.sql.
# ============================================================
log "=== V77-03 : anti-dérive structurel complet (6 scénarios de dérive de assert_establishment_asset_url) ==="
DB_DRIFT="scanym_v78_drift_$$"
psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true
createdb "$DB_DRIFT"
psql -d "$DB_DRIFT" >/dev/null <<'SQL'
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
  psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  psql -d "$DB_DRIFT" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
done
for f in migration-v67-product-photos.sql migration-v67b-category-description-product-order.sql migration-lotd-establishment-creation.sql migration-lotd-rls-reference-tables-fix.sql migration-v68-establishment-assets.sql migration-v69-identity-colors-maps-hardening.sql migration-v70-identity-corrections.sql migration-v76-storage-origin-config.sql; do
  psql -d "$DB_DRIFT" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
done
psql -d "$DB_DRIFT" -c "insert into scanym_internal.storage_config (id, storage_public_origin) values (true, 'https://fake.supabase.co');" >/dev/null

test_drift_scenario() {
  local desc="$1" sql_mutation="$2"
  psql -d "$DB_DRIFT" -c "drop function if exists public.assert_establishment_asset_url(uuid,text,text); drop function if exists public.assert_establishment_asset_url(uuid,text,text,text);" >/dev/null 2>&1
  psql -d "$DB_DRIFT" -c "$sql_mutation" >/dev/null 2>&1
  if psql -v ON_ERROR_STOP=1 -d "$DB_DRIFT" -f "$SUPABASE_DIR/migration-v71-hardening.sql" >/dev/null 2>&1; then
    fail "V77-03: $desc -- migration V71 aurait dû refuser (dérive non détectée)"
  else
    pass "V77-03: $desc -- migration V71 refuse explicitement (dérive détectée)"
  fi
}

test_drift_scenario "mauvais type de retour (boolean au lieu de void)" "
  create function public.assert_establishment_asset_url(p_restaurant_id uuid, p_kind text, p_url text)
  returns boolean language plpgsql stable security definer set search_path = ''
  as \$f\$ begin perform current_setting('app.storage_public_base_url', true); return true; end; \$f\$;
"
test_drift_scenario "non SECURITY DEFINER" "
  create function public.assert_establishment_asset_url(p_restaurant_id uuid, p_kind text, p_url text)
  returns void language plpgsql stable set search_path = ''
  as \$f\$ begin perform current_setting('app.storage_public_base_url', true); return; end; \$f\$;
"
test_drift_scenario "mauvais search_path (absent)" "
  create function public.assert_establishment_asset_url(p_restaurant_id uuid, p_kind text, p_url text)
  returns void language plpgsql stable security definer
  as \$f\$ begin perform current_setting('app.storage_public_base_url', true); return; end; \$f\$;
"
test_drift_scenario "mauvaise volatilité (volatile au lieu de stable)" "
  create function public.assert_establishment_asset_url(p_restaurant_id uuid, p_kind text, p_url text)
  returns void language plpgsql security definer set search_path = ''
  as \$f\$ begin perform current_setting('app.storage_public_base_url', true); return; end; \$f\$;
"
test_drift_scenario "overload (deuxième fonction du même nom, arité différente)" "
  create function public.assert_establishment_asset_url(p_restaurant_id uuid, p_kind text, p_url text)
  returns void language plpgsql stable security definer set search_path = ''
  as \$f\$ begin perform current_setting('app.storage_public_base_url', true); return; end; \$f\$;
  create function public.assert_establishment_asset_url(p_restaurant_id uuid, p_kind text, p_url text, p_extra text)
  returns void language plpgsql stable security definer set search_path = ''
  as \$f\$ begin return; end; \$f\$;
"
test_drift_scenario "corps V70 dérivé (marqueur caractéristique absent)" "
  create function public.assert_establishment_asset_url(p_restaurant_id uuid, p_kind text, p_url text)
  returns void language plpgsql stable security definer set search_path = ''
  as \$f\$ begin return; end; \$f\$;
"

psql -c "drop database if exists \"$DB_DRIFT\";" >/dev/null 2>&1 || true

FAIL_LOG_COUNT=$(wc -l < "$FAIL_LOG" | tr -d ' ')
if [ "$FAIL_LOG_COUNT" != "$FAIL_COUNT" ]; then
  echo "[$(date '+%H:%M:%S')] HARNESS SELF-TEST ÉCHEC CRITIQUE : FAIL_COUNT ($FAIL_COUNT) ne correspond pas au nombre de lignes du journal indépendant ($FAIL_LOG_COUNT) -- le compteur a potentiellement été altéré. Contenu du journal :"
  cat "$FAIL_LOG"
  exit 1
fi
if [ "$FAIL_LOG_COUNT" -gt 0 ]; then
  echo "[$(date '+%H:%M:%S')] HARNESS SELF-TEST : $FAIL_LOG_COUNT échec(s) réel(s) présent(s) dans le journal indépendant -- le script échoue, quel que soit l'état de FAIL_COUNT."
  cat "$FAIL_LOG"
  rm -f "$FAIL_LOG"
  exit 1
fi
echo "[$(date '+%H:%M:%S')] HARNESS SELF-TEST : journal indépendant vide et concordant avec FAIL_COUNT (0) -- aucun échec masqué possible."
rm -f "$FAIL_LOG"

log "=== RÉSULTAT FINAL : $PASS_COUNT réussis, $FAIL_COUNT échoués ==="
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
echo "TOUTES LES VÉRIFICATIONS D'ISOLATION STORAGE ONT RÉUSSI"
