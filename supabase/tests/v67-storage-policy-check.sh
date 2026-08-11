#!/usr/bin/env bash
# ============================================================
# Scanym V67 — Harnais reproductible des policies storage.objects
# (photo produit), preuve d'isolation multi-établissement.
#
# PostgreSQL ne fournit pas nativement le schéma "storage" de
# Supabase (extension propriétaire de la plateforme, absente d'une
# instance Postgres locale). Ce harnais crée un STAND-IN minimal —
# storage.buckets, storage.objects (mêmes colonnes pertinentes :
# bucket_id, name, owner), storage.foldername() (même comportement :
# découpe le chemin sur "/", renvoie tous les segments sauf le
# dernier) — puis applique le fichier de migration RÉEL
# (migration-v67-product-photos.sql) tel quel par-dessus une base V66
# complète. Les policies testées ici sont donc EXACTEMENT celles
# livrées, pas une réécriture séparée pour les besoins du test.
#
# Preuve recherchée : un owner/manager du restaurant A peut écrire
# uniquement sous {restaurant_A_id}/..., jamais sous
# {restaurant_B_id}/... ; staff ne peut jamais écrire ; anon ne peut
# jamais écrire.
#
# COMPLÉTÉ après audit Work (M-02) : le harnais précédent ne prouvait
# INSERT/DELETE que par échantillon (un seul rôle testé par
# opération), sans jamais tester SELECT ni UPDATE explicitement, et
# sans vérifier la cohérence du design "bucket public" au niveau SQL.
# Couvre désormais, en plus de l'existant : SELECT autorisé/refusé
# (own restaurant / autre restaurant / anon), UPDATE autorisé/refusé
# (own restaurant / autre restaurant, avec preuve que la ligne refusée
# reste inchangée), et la conformité du flag "public" du bucket.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/v67-storage-policy-check.sh"
#
# Le script s'arrête immédiatement (set -euo pipefail) sur toute
# erreur d'exécution réelle (SQL invalide, migration en échec) ; les
# ASSERTIONS, elles, s'accumulent jusqu'à la fin pour donner un
# diagnostic complet en un seul run (même convention que les autres
# harnais du dépôt, ex. v66-integration-test-negative.sh) — le code de
# sortie final reflète sans ambiguïté un échec (exit 1) dès qu'une
# seule assertion a échoué. Aucun secret, aucun accès
# Supabase/production. Base éphémère supprimée en fin d'exécution,
# quel que soit le chemin de sortie (trap EXIT).
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DB="scanym_v67_storage_$$"

PASS_COUNT=0
FAIL_COUNT=0

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); log "FAIL: $*"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
}
trap cleanup EXIT

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}

psql -c "drop database if exists \"$DB\";" >/dev/null
createdb "$DB"

# ------------------------------------------------------------------
# Bootstrap V66 complet (mêmes migrations, même ordre que les autres
# harnais du dépôt) + stand-in minimal du schéma storage Supabase.
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

-- Stand-in minimal du schéma storage Supabase (voir en-tête).
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
-- Même comportement que la fonction réelle : découpe le chemin sur
-- "/", renvoie tous les segments sauf le dernier (le nom de fichier).
create or replace function storage.foldername(name text)
returns text[] language sql immutable as \$\$
  select (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1]
\$\$;
-- Sur la vraie plateforme Supabase, anon/authenticated ont déjà
-- USAGE sur le schéma storage par défaut ; ce stand-in local doit le
-- répliquer explicitement (sinon "permission denied for schema
-- storage" masquerait complètement le test des policies RLS).
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

log "=== Application de la migration V67 réelle (bucket, policies, RPC) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v67-product-photos.sql" >/dev/null
pass "migration V67 appliquée sans erreur sur le stand-in storage"

# ------------------------------------------------------------------
# Données de test : 2 restaurants, 1 owner/staff sur A, 1 manager sur B.
# ------------------------------------------------------------------
RESTO_A=$(psql -d "$DB" -t -A -c "insert into public.restaurants (name, slug) values ('A', 'resto-a') returning id;" | head -1)
RESTO_B=$(psql -d "$DB" -t -A -c "insert into public.restaurants (name, slug) values ('B', 'resto-b') returning id;" | head -1)
psql -d "$DB" -c "insert into public.restaurant_configs (restaurant_id, whatsapp_number) values ('$RESTO_A', '+213000000'), ('$RESTO_B', '+213000001');" >/dev/null

OWNER_A=$(psql -d "$DB" -t -A -c "insert into auth.users (email) values ('owner-a@test') returning id;" | head -1)
STAFF_A=$(psql -d "$DB" -t -A -c "insert into auth.users (email) values ('staff-a@test') returning id;" | head -1)
MANAGER_B=$(psql -d "$DB" -t -A -c "insert into auth.users (email) values ('manager-b@test') returning id;" | head -1)
psql -d "$DB" -c "
  insert into public.restaurant_users (user_id, restaurant_id, role) values
    ('$OWNER_A', '$RESTO_A', 'owner'),
    ('$STAFF_A', '$RESTO_A', 'staff'),
    ('$MANAGER_B', '$RESTO_B', 'manager');
" >/dev/null

try_insert() {
  local uid="$1" path="$2"
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "
    set role authenticated;
    set local test.uid = '$uid';
    insert into storage.objects (bucket_id, name) values ('product-photos', '$path');
    reset role;
  " >/dev/null 2>&1 && echo "0" || echo "1"
}

try_insert_anon() {
  local path="$1"
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "
    set role anon;
    insert into storage.objects (bucket_id, name) values ('product-photos', '$path');
    reset role;
  " >/dev/null 2>&1 && echo "0" || echo "1"
}

log "=== Isolation multi-établissement (le point critique) ==="
RC=$(try_insert "$OWNER_A" "$RESTO_A/prod1/photo.jpg")
assert_eq "owner A écrit sous son propre restaurant A (succès)" "0" "$RC"

RC=$(try_insert "$OWNER_A" "$RESTO_B/prod1/photo.jpg")
assert_eq "owner A NE PEUT PAS écrire sous le restaurant B (refus)" "1" "$RC"

RC=$(try_insert "$MANAGER_B" "$RESTO_B/prod9/photo.jpg")
assert_eq "manager B écrit sous son propre restaurant B (succès)" "0" "$RC"

RC=$(try_insert "$MANAGER_B" "$RESTO_A/prod1/photo.jpg")
assert_eq "manager B NE PEUT PAS écrire sous le restaurant A (refus)" "1" "$RC"

log "=== Restriction de rôle ==="
RC=$(try_insert "$STAFF_A" "$RESTO_A/prod1/photo2.jpg")
assert_eq "staff A NE PEUT PAS écrire (owner/manager seulement)" "1" "$RC"

log "=== Accès anonyme ==="
RC=$(try_insert_anon "$RESTO_A/prod1/photo3.jpg")
assert_eq "anon NE PEUT PAS écrire" "1" "$RC"

# ------------------------------------------------------------------
# SELECT — complété après audit Work (M-02). Même méthodologie que
# pour DELETE/UPDATE : RLS filtre silencieusement (0 ligne visible),
# ce n'est jamais une erreur SQL, donc on compte les lignes vues, pas
# le code de sortie.
# ------------------------------------------------------------------
log "=== SELECT (M-02) ==="
# NOTE méthodologique (comme pour DELETE/UPDATE plus haut) : psql -t -A
# n'omet pas les tags de complétion des commandes SET/RESET dans cette
# version — seule la ligne purement numérique nous intéresse.
SEEN=$(psql -d "$DB" -t -A -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  select count(*) from storage.objects where bucket_id='product-photos' and name = '$RESTO_A/prod1/photo.jpg';
  reset role;
" | grep -E '^[0-9]+$')
assert_eq "SELECT autorisé : owner A voit un fichier de son propre restaurant A" "1" "$SEEN"

SEEN=$(psql -d "$DB" -t -A -c "
  set role authenticated; set local test.uid = '$MANAGER_B';
  select count(*) from storage.objects where bucket_id='product-photos' and name = '$RESTO_A/prod1/photo.jpg';
  reset role;
" | grep -E '^[0-9]+$')
assert_eq "SELECT refusé : manager B ne voit AUCUNE ligne d'un fichier du restaurant A" "0" "$SEEN"

SEEN=$(psql -d "$DB" -t -A -c "
  set role anon;
  select count(*) from storage.objects where bucket_id='product-photos' and name = '$RESTO_A/prod1/photo.jpg';
" | grep -E '^[0-9]+$')
assert_eq "SELECT refusé : anon ne voit AUCUNE ligne via SQL (le bucket public sert les fichiers via l'API HTTP dédiée, jamais via une policy SQL permissive pour anon)" "0" "$SEEN"

# ------------------------------------------------------------------
# UPDATE — complété après audit Work (M-02), n'était testé qu'au
# travers de DELETE jusqu'ici.
# ------------------------------------------------------------------
log "=== UPDATE (M-02) ==="
TAG=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  update storage.objects set owner = '$OWNER_A' where bucket_id='product-photos' and name = '$RESTO_A/prod1/photo.jpg';
  reset role;
" 2>&1 | grep -o "UPDATE [0-9]*")
assert_eq "UPDATE autorisé : owner A modifie un fichier de son propre restaurant A (1 ligne affectée)" "UPDATE 1" "$TAG"

TAG=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$MANAGER_B';
  update storage.objects set owner = '$MANAGER_B' where bucket_id='product-photos' and name = '$RESTO_A/prod1/photo.jpg';
  reset role;
" 2>&1 | grep -o "UPDATE [0-9]*")
assert_eq "UPDATE refusé : manager B ne peut pas modifier un fichier du restaurant A (0 ligne affectée)" "UPDATE 0" "$TAG"
OWNER_UNCHANGED=$(psql -d "$DB" -t -A -c "select owner from storage.objects where name = '$RESTO_A/prod1/photo.jpg';")
assert_eq "le fichier du restaurant A n'a pas été modifié par la tentative refusée" "$OWNER_A" "$OWNER_UNCHANGED"

# ------------------------------------------------------------------
# Lecture publique — conformité au design retenu (M-02). Le bucket
# est public : les fichiers sont servis via la route HTTP dédiée
# Supabase (/storage/v1/object/public/...), qui court-circuite
# entièrement RLS — un mécanisme de la plateforme, pas une policy SQL,
# donc non reproductible tel quel dans ce stand-in local. Ce qui EST
# vérifiable ici : (1) le bucket est bien marqué public (condition
# nécessaire à ce mécanisme), et (2) aucune policy SQL ne rend
# storage.objects lisible par anon (déjà prouvé ci-dessus) — la
# lecture publique ne repose donc QUE sur la route HTTP dédiée au
# bucket public, jamais sur un accès SQL/PostgREST ouvert à anon, qui
# aurait été une surface bien plus large qu'un simple accès aux URL
# d'images.
# ------------------------------------------------------------------
log "=== Lecture publique du bucket (M-02) ==="
IS_PUBLIC=$(psql -d "$DB" -t -A -c "select public from storage.buckets where id = 'product-photos';")
assert_eq "le bucket product-photos est public (condition du design retenu : lecture via l'URL publique, sans policy SQL)" "t" "$IS_PUBLIC"

log "=== Update / delete suivent la même règle (échantillon) ==="
# NOTE méthodologique : contrairement à INSERT (où un WITH CHECK
# refusé lève une vraie erreur SQL), un DELETE/UPDATE bloqué par RLS
# ne lève PAS d'erreur — la clause USING filtre silencieusement les
# lignes visibles, et "DELETE 0" est un succès du point de vue du
# code de sortie psql. La preuve pertinente est donc le nombre de
# lignes réellement affectées (capturé via le tag de commande), pas
# le code de sortie.
psql -d "$DB" -c "insert into storage.objects (bucket_id, name) values ('product-photos', '$RESTO_A/prod2/existing.jpg');" >/dev/null
TAG=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$MANAGER_B';
  delete from storage.objects where bucket_id='product-photos' and name = '$RESTO_A/prod2/existing.jpg';
  reset role;
" 2>&1 | grep -o "DELETE [0-9]*")
assert_eq "manager B NE PEUT PAS supprimer un fichier du restaurant A (0 ligne affectée)" "DELETE 0" "$TAG"
DELETED=$(psql -d "$DB" -t -A -c "select count(*) from storage.objects where name = '$RESTO_A/prod2/existing.jpg';")
assert_eq "le fichier du restaurant A est toujours là après la tentative refusée" "1" "$DELETED"

TAG=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated; set local test.uid = '$OWNER_A';
  delete from storage.objects where bucket_id='product-photos' and name = '$RESTO_A/prod2/existing.jpg';
  reset role;
" 2>&1 | grep -o "DELETE [0-9]*")
assert_eq "owner A PEUT supprimer un fichier de son propre restaurant (1 ligne affectée)" "DELETE 1" "$TAG"

log "=== RÉSULTAT FINAL : $PASS_COUNT réussis, $FAIL_COUNT échoués ==="
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
echo "TOUTES LES VÉRIFICATIONS D'ISOLATION STORAGE ONT RÉUSSI"
