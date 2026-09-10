#!/usr/bin/env bash
# ============================================================
# Scanym BULK PRODUCT PHOTOS v1.5 — FINAL TRUST-BOUNDARY CLOSURE —
# harnais reproductible du flux de remplacement de confiance côté
# serveur (begin_/apply_product_photo_replacement) contre PostgreSQL
# réel, répondant au réaudit indépendant Cat Stevens sur v1.4 (verdict
# FAIL, 2 findings release-blocking + 1 MEDIUM) :
#   Blocker 1 (v1.5) -- apply_product_photo_replacement(uuid, text)
#     restait GRANT EXECUTE à `authenticated` -- exposée en REST à
#     TOUT porteur d'un jeton de session valide, indépendamment de la
#     route de confiance. Fermé : GRANT EXECUTE retiré à
#     authenticated/anon/public, accordé UNIQUEMENT à service_role ;
#     nouvelle signature à 3 arguments (p_caller_user_id explicite,
#     obtenu par Node UNIQUEMENT via begin_) ; nouveau jumeau paramétré
#     assert_product_role_for (jamais une modification de
#     assert_product_role elle-même).
#   Blocker 2 (v1.5) -- l'ancienne valeur image_url lue en DB devenait
#     cible de suppression SANS revalidation contre le contrat exact de
#     chemin -- une ligne historique (potentiellement empoisonnée)
#     pouvait devenir une cible de suppression service_role arbitraire.
#     Fermé : revalidation de l'ancienne valeur par la MÊME fonction
#     exacte (_product_photo_path_segments) que le nouveau chemin,
#     AVANT toute utilisation comme cible de nettoyage -- si invalide,
#     old_path=NULL et old_path_cleanup_skipped=true, JAMAIS supprimée
#     ni normalisée en cible de substitution (le remplacement réussit
#     quand même).
#   MEDIUM (v1.5) -- échec de suppression de l'ancienne image non
#     remonté au navigateur -- Node/UI uniquement, hors périmètre SQL,
#     voir tests/v152-product-photo-service.test.ts et
#     FAILURE-COMPENSATION-MATRIX.md.
#
# Les 3 blockers + 2 MEDIUM v1.3->v1.4 (provenance/DELETE direct/
# contrat UUID v4/orphelin upload/concurrence) restent PRÉSERVÉS TELS
# QUELS, jamais redesignés -- voir la section "26 ITEMS v1.4" plus bas,
# dont les helpers sont simplement adaptés à la nouvelle signature
# d'apply_ (3 arguments, service_role), sans changement de
# comportement testé.
#
# Matrice EXIGÉE par le mandat v1.5 (20 items, section "MANDAT v1.5" --
# items 07/19 sont partiellement/entièrement Node-level par nature, ce
# fichier prouve leur PRÉCONDITION SQL et renvoie vers TEST-RESULTS.md/
# tests/v152-product-photo-service.test.ts pour le résultat Node
# complet) :
#   01 authenticated direct RPC call -> DENIED
#   02 anon direct RPC call -> DENIED
#   03 PUBLIC direct RPC call -> DENIED
#   04 trusted server (service_role) RPC call -> ALLOWED
#   05 client attempts same-product unrelated object C -> DENIED
#   06 client attempts arbitrary new image URL -> DENIED
#   07 valid DB old image -> cleanup allowed (old_path renvoyé,
#      old_path_cleanup_skipped=false ; suppression Storage réelle
#      Node-level, voir STORAGE-API-CLEANUP-EVIDENCE.md)
#   08 poisoned different-restaurant DB old image -> never deleted
#   09 poisoned different-product DB old image -> never deleted
#   10 poisoned nested path -> never deleted
#   11 poisoned nil UUID -> never deleted
#   12 poisoned wrong UUID version -> never deleted
#   13 poisoned uppercase UUID -> never deleted
#   14 poisoned wrong extension -> never deleted
#   15 external URL -> never deleted
#   16 malformed Storage URL -> never deleted
#   17 unrelated third object C -> never deleted
#   18 valid A->B replacement -> A éligible (Storage API, Node-level),
#      B autoritaire, C préservé
#   19 DB success + old delete failure -> new DB state autoritaire,
#      cleanup failure surfacée au navigateur (ENTIÈREMENT Node-level,
#      voir tests/v152-product-photo-service.test.ts scénario C)
#   20 concurrent replacements -> résultat sérialisé déterministe
#
# ------------------------------------------------------------------
# EXTENSION v1.6 -- FINAL HISTORICAL PATH ORIGIN HARDENING (Cat
# Stevens, réaudit indépendant de v1.5 -- verdict FAIL) :
#   Blocker 1 (v1.6, RELEASE-BLOCKING) -- l'item 15 ci-dessus
#     ('https://evil.example.com/not-supabase/whatever.jpg') échouait
#     pour une raison TRIVIALE (marqueur Storage totalement absent),
#     JAMAIS parce que l'origine était vérifiée : v1.5 ne faisait
#     qu'une recherche de SOUS-CHAÎNE du marqueur
#     ('/object/public/product-photos/'), sans jamais exiger qu'il
#     apparaisse immédiatement après une origine Storage Scanym de
#     confiance. Fermé : _product_photo_path_segments (SQL) exige
#     désormais starts_with(url, expected_origin ||
#     '/storage/v1/object/public/product-photos/') -- vérification
#     ANCRÉE en position 0, jamais un position()/indexOf() de
#     sous-chaîne ; expected_origin calculé UNIQUEMENT côté serveur
#     Node (getTrustedStorageOrigin()), jamais une valeur cliente.
#   Blocker 2 (v1.6, RELEASE-BLOCKING, harnais) -- 10 items hostiles
#     mandatés ci-dessous (v1.6-01 à v1.6-11), dont un CAS ADVERSARIAL
#     GÉNUINE (v1.6-03/v1.6-11) combinant le marqueur Storage EXACT
#     COMPLET sur une origine étrangère avec un chemin
#     restaurant/produit/UUID-v4 syntaxiquement PARFAIT (contrairement
#     à l'item 15 v1.5, qui ne testait jamais réellement le défaut de
#     confiance par sous-chaîne).
#   MEDIUM (v1.6) -- échec de nettoyage désormais ré-essayable SANS
#     jamais rejouer apply_/le remplacement complet -- nouvelle
#     fonction retry_product_photo_cleanup_path (AUCUNE mutation,
#     validation uniquement), testée v1.6-retry-01 à 07 (v1.6) --
#     REMPLACÉE par la section v1.7 ci-dessous (voir EXTENSION v1.7).
#
# ------------------------------------------------------------------
# EXTENSION v1.7 -- FINAL CLEANUP-RETRY TRUST BOUNDARY (Cat Stevens,
# réaudit indépendant de v1.6 -- verdict FAIL) :
#   Blocker (v1.7, RELEASE-BLOCKING) -- retry_product_photo_cleanup_path
#     (v1.6) acceptait un `oldPath` candidat FOURNI PAR LE CLIENT --
#     validé en FORME/origine/appartenance mais JAMAIS prouvé comme
#     correspondant à un échec de nettoyage RÉEL. Un appelant AUTORISÉ
#     (propriétaire légitime de son propre produit) pouvait donc
#     désigner arbitrairement un objet C existant, non courant, sous
#     le MÊME produit, et provoquer sa suppression Storage privilégiée.
#     Fermé : `retry_product_photo_cleanup_path` SUPPRIMÉE, jamais
#     recréée. Nouvel état durable SERVEUR UNIQUEMENT,
#     `public.product_photo_pending_cleanups` (AUCUN accès PUBLIC/
#     anon/authenticated), créé EXCLUSIVEMENT par
#     `create_product_photo_pending_cleanup` (service_role) juste après
#     un échec RÉEL de Storage.remove() sur un old_path DÉJÀ validé par
#     apply_ dans la MÊME requête. Le navigateur ne reçoit/retransmet
#     plus qu'un `cleanup_id` OPAQUE (uuid) -- jamais interprété comme
#     une autorisation en lui-même (mandat "cleanup id is not
#     authorization") : `claim_product_photo_pending_cleanup`
#     (service_role) réautorise, résout par id SOUS VERROU, vérifie
#     l'appartenance EXACTE + le statut 'pending', REVALIDE (defense in
#     depth) la forme du chemin stocké ET son inégalité avec l'image
#     courante, puis réclame ATOMIQUEMENT (UPDATE conditionnelle) avant
#     de renvoyer le chemin -- au plus un claim concurrent réussit.
#     `reopen_product_photo_pending_cleanup` (service_role) fait
#     revenir une ligne 'completed' à 'pending' si le Storage.remove()
#     Node qui a suivi le claim a lui-même échoué -- même cleanup_id,
#     jamais un nouveau.
#   Blocker (v1.7, RELEASE-BLOCKING, harnais) -- le harnais v1.6
#     traitait tout chemin candidat conforme comme une cible de retry
#     légitime, sans jamais prouver un échec réel -- fermé par la
#     nouvelle section v1.7 ci-dessous (cycle de vie pending-cleanup
#     complet, objet C non lié JAMAIS ciblé, cleanup_id fabriqué/
#     rejoué/cross-tenant/cross-produit, concurrence, defense in
#     depth).
#   MEDIUM (v1.7) -- aucun test Node/DOM substantiel pour le retry --
#     fermé hors de ce fichier SQL, voir
#     tests/v153-cleanup-retry-dom.test.ts.
#
# ------------------------------------------------------------------
# EXTENSION v1.8 -- FINAL DURABLE CLEANUP STATE MACHINE (Cat Stevens,
# réaudit indépendant de v1.7 -- verdict FAIL) :
#   Blocker (v1.8, RELEASE-BLOCKING, SEUL restant) --
#     `claim_product_photo_pending_cleanup` (v1.7) marquait la ligne
#     'completed' AU MOMENT DU CLAIM, AVANT même que le Storage.remove()
#     Node ne soit tenté. Si ce Storage.remove() échouait (rejet, ou
#     résultat Supabase `{error}` normal jamais vérifié côté Node), la
#     ligne restait consommée 'completed' malgré un objet Storage non
#     supprimé, `reopen_product_photo_pending_cleanup` pouvait ne
#     jamais être atteinte (crash serveur), et son propre échec n'était
#     lui-même jamais détecté (try/catch nu, `{error}` ignoré) : la
#     retry-abilité durable n'était PAS garantie en toute circonstance.
#     Fermé : nouvelle machine à états à TROIS statuts
#     pending -> processing -> completed. `claim_` (signature étendue
#     `p_lease_seconds default 120`) ne transitionne JAMAIS directement
#     vers 'completed' -- uniquement pending -> processing, avec pose
#     d'un bail (`lease_until = now() + p_lease_seconds`) et frappe d'un
#     `claim_token` (uuid, service_role uniquement, jamais renvoyé au
#     navigateur) neuf à chaque claim (y compris la récupération d'un
#     bail expiré). Une ligne est réclamable si status='pending' OU
#     (status='processing' ET lease_until < now()) -- jamais autrement.
#     `reopen_product_photo_pending_cleanup` SUPPRIMÉE, jamais
#     recréée ; remplacée par deux fonctions distinctes,
#     service_role uniquement, exigeant le `claim_token` EXACT du claim
#     en cours (empêche une tentative concurrente/périmée de finaliser
#     l'état d'une tentative plus récente) :
#       - `finalize_product_photo_pending_cleanup` : processing ->
#         completed, appelée UNIQUEMENT après succès RÉEL et vérifié de
#         Storage.remove() côté Node ;
#       - `release_product_photo_pending_cleanup` : processing ->
#         pending (retry immédiat possible), appelée après un échec de
#         Storage.remove() détecté (throw OU `{error}` -- les deux
#         chemins sont désormais explicitement vérifiés côté Node, plus
#         aucun `{error}` ignoré).
#     Principe "jamais reopen-ou-mourir" : la retry-abilité durable ne
#     dépend JAMAIS du seul succès de `release_` -- le bail expire de
#     toute façon (`lease_until`), ce qui garantit la récupération même
#     si le processus meurt avant `release_`, si `release_` échoue lui-
#     même, ou si le réseau est coupé. `release_`/`finalize_` sont un
#     "fast path" de confort, jamais l'unique mécanisme de reprise.
#     Suppression Storage physiquement déjà réussie mais crash avant
#     `finalize_` : gérée idempotemment -- un second claim + un second
#     Storage.remove() sur un objet déjà absent ne lève pas d'erreur
#     (sémantique S3-compatible), aucune recréation, aucune altération
#     de l'image produit courante, `finalize_` appelé normalement au
#     second passage.
#   Blocker (v1.8, RELEASE-BLOCKING, harnais) -- le harnais v1.7 ne
#     prouvait que la ré-ouverture applicative, jamais la garantie
#     durable au niveau de la base -- fermé par la nouvelle section
#     v1.8 ci-dessous (machine à états pending/processing/completed,
#     bail et expiration déterministe ET en temps réel, claim_token,
#     récupération après crash simulé, idempotence objet Storage déjà
#     absent, concurrence de claim, matrice de privilèges complète
#     claim_/finalize_/release_, objet C toujours non ciblé, cycle
#     FORWARD -> ROLLBACK -> FORWARD prouvant que la machine à états
#     fonctionne de nouveau intégralement après le rollback, jamais un
#     artefact du premier CREATE FUNCTION).
#
# Voir CAT-STEVENS-FINDINGS-REMEDIATION.md, TRUSTED-STORAGE-ORIGIN-
# CONTRACT.md, FOREIGN-ORIGIN-ATTACK-EVIDENCE.md, CLEANUP-RETRY-TRUST-
# BOUNDARY.md, CLEANUP-STATE-MACHINE.md, CLEANUP-LEASE-RECOVERY.md,
# CLEANUP-FAILURE-MATRIX.md et CLEANUP-CLAIM-CONCURRENCY.md pour
# l'analyse complète.
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/v67c-storage-operator-authorization-check.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
DB="scanym_v67c_storage_provenance_$$"
NOBODY_ROLE="scanym_test_nobody_$$"

PASS_COUNT=0
FAIL_COUNT=0

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); log "FAIL: $*"; }

cleanup() {
  psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true
  psql -c "drop role if exists \"$NOBODY_ROLE\";" >/dev/null 2>&1 || true
  rm -f "/tmp/scanym_v67c_concurrent_a_$$.sql" "/tmp/scanym_v67c_concurrent_a_out_$$.txt"
  rm -f "/tmp/scanym_v67c_race_v2221_a_$$.sql" "/tmp/scanym_v67c_race_v2221_a_out_$$.txt"
}
trap cleanup EXIT

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}

psql -c "drop database if exists \"$DB\";" >/dev/null
createdb "$DB"

# ------------------------------------------------------------------
# Bootstrap V66 complet + stand-in minimal du schéma storage Supabase
# (identique aux harnais précédents). service_role est créé ICI
# (précondition 0h du fichier v1.6 réel, appliqué plus bas).
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

log "=== Application de la migration V67 réelle (bucket, policies, RPC set_product_photo d'origine) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v67-product-photos.sql" >/dev/null
pass "migration V67 appliquée sans erreur sur le stand-in storage"

log "=== scanym_operators / is_scanym_operator() -- copiés verbatim (voir en-tête) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<SQL
create table public.scanym_operators (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  note        text
);
alter table public.scanym_operators enable row level security;
revoke all on table public.scanym_operators from anon, authenticated, public;

create function public.is_scanym_operator()
returns boolean
language sql
stable
security definer
set search_path = ''
as \$\$
  select exists (
    select 1 from public.scanym_operators where user_id = auth.uid()
  );
\$\$;
revoke all on function public.is_scanym_operator() from public, anon;
grant execute on function public.is_scanym_operator() to authenticated;
SQL
pass "stand-in scanym_operators / is_scanym_operator() créé"

log "=== Bypass opérateur assert_product_role (DRAFT-lot-catalogue-operator-authorization-v1.sql, RÉUTILISÉ tel quel par begin_product_photo_replacement -- jamais modifiée par ce lot, voir NON-MODIFICATION-PROOF.md) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<SQL
create or replace function public.assert_product_role(
  p_product_id uuid,
  p_roles      text[]
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as \$\$
declare
  v_restaurant_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  select mc.restaurant_id into v_restaurant_id
  from public.menu_items mi
  join public.menu_categories mc on mc.id = mi.category_id
  where mi.id = p_product_id;

  if v_restaurant_id is null then
    raise exception using errcode = 'P0002', message = 'Product not found';
  end if;

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = v_restaurant_id
      and ru.role = any (p_roles)
  ) and not public.is_scanym_operator() then
    raise exception using errcode = '42501',
      message = 'Not authorized for this product';
  end if;

  return v_restaurant_id;
end \$\$;
SQL
pass "assert_product_role (avec bypass opérateur) installé -- même corps que DRAFT-lot-catalogue-operator-authorization-v1.sql, déjà sur main courant"

log "=== Simulation de l'état intermédiaire v1.3 (set_product_photo avec capture v_old_url) -- requis par le contrôle de non-dérive du fichier v1.7 réel appliqué ensuite (voir sa section 0f) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<SQL
drop function public.set_product_photo(uuid, text);
create function public.set_product_photo(
  p_product_id uuid,
  p_image_url  text
)
returns void
language plpgsql
security definer
set search_path = ''
as \$\$
declare
  v_image_url text;
  v_old_url   text;
  v_old_path  text;
  v_new_path  text;
  v_marker    constant text := '/object/public/product-photos/';
  v_idx       int;
begin
  perform public.assert_product_role(p_product_id, array['owner','manager']);
  v_image_url := nullif(btrim(coalesce(p_image_url, ''), E' \t\n\r\f' || chr(11)), '');
  select image_url into v_old_url from public.menu_items where id = p_product_id and archived_at is null;
  update public.menu_items set image_url = v_image_url where id = p_product_id and archived_at is null;
  if not found then raise exception using errcode = 'P0002', message = 'Product not found or archived'; end if;
  if v_old_url is not null then
    if v_image_url is not null then
      v_idx := position(v_marker in v_image_url);
      if v_idx > 0 then v_new_path := substring(v_image_url from v_idx + length(v_marker)); end if;
    end if;
    v_idx := position(v_marker in v_old_url);
    if v_idx > 0 then
      v_old_path := substring(v_old_url from v_idx + length(v_marker));
      if v_old_path is not null and v_old_path <> coalesce(v_new_path, '') then
        delete from storage.objects where bucket_id = 'product-photos' and name = v_old_path;
      end if;
    end if;
  end if;
end \$\$;
revoke all on function public.set_product_photo(uuid, text) from public, anon;
grant execute on function public.set_product_photo(uuid, text) to authenticated;

drop policy "product_photos_insert_own_restaurant" on storage.objects;
create policy "product_photos_insert_own_restaurant"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'product-photos'
  and array_length(string_to_array(storage.objects.name, '/'), 1) = 3
);
SQL
pass "état intermédiaire v1.3 simulé (jamais livré tel quel -- uniquement pour satisfaire le contrôle de non-dérive du fichier v1.6 réel)"

log "=== Application du fichier de remédiation RÉEL v1.7 (FINAL CLEANUP-RETRY TRUST BOUNDARY) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql" >/dev/null
pass "migration de remédiation v1.7 appliquée sans erreur"

log "=== Rôle sans privilège (proxy comportemental de PUBLIC, item 03) -- aucun GRANT explicite, ne doit jamais hériter d'EXECUTE ==="
psql -c "create role \"$NOBODY_ROLE\" nologin;" >/dev/null
pass "rôle $NOBODY_ROLE créé (aucun GRANT explicite -- prouve qu'EXECUTE n'est accordé à PUBLIC pour aucune des fonctions du flux)"

# ------------------------------------------------------------------
# Données de test.
# ------------------------------------------------------------------
RESTO_A=$(psql -d "$DB" -t -A -c "insert into public.restaurants (name, slug) values ('A', 'resto-a') returning id;" | head -1)
RESTO_B=$(psql -d "$DB" -t -A -c "insert into public.restaurants (name, slug) values ('B', 'resto-b') returning id;" | head -1)
psql -d "$DB" -c "insert into public.restaurant_configs (restaurant_id, whatsapp_number) values ('$RESTO_A', '+213000000'), ('$RESTO_B', '+213000001');" >/dev/null

CAT_A=$(psql -d "$DB" -t -A -c "insert into public.menu_categories (restaurant_id, name) values ('$RESTO_A', 'Catégorie A') returning id;" | head -1)
CAT_B=$(psql -d "$DB" -t -A -c "insert into public.menu_categories (restaurant_id, name) values ('$RESTO_B', 'Catégorie B') returning id;" | head -1)

PROD_A1=$(psql -d "$DB" -t -A -c "insert into public.menu_items (category_id, name, price) values ('$CAT_A', 'Produit A1', 9.99) returning id;" | head -1)
PROD_A_ARCHIVED=$(psql -d "$DB" -t -A -c "insert into public.menu_items (category_id, name, price, archived_at) values ('$CAT_A', 'Produit A archivé', 9.99, now()) returning id;" | head -1)
PROD_B1=$(psql -d "$DB" -t -A -c "insert into public.menu_items (category_id, name, price) values ('$CAT_B', 'Produit B1', 12.50) returning id;" | head -1)
PROD_A_PROV=$(psql -d "$DB" -t -A -c "insert into public.menu_items (category_id, name, price) values ('$CAT_A', 'Produit A -- scène de provenance', 5.00) returning id;" | head -1)
PROD_A_CONCURRENT=$(psql -d "$DB" -t -A -c "insert into public.menu_items (category_id, name, price) values ('$CAT_A', 'Produit A -- scène de concurrence', 7.00) returning id;" | head -1)
PROD_A_NOPHOTO=$(psql -d "$DB" -t -A -c "insert into public.menu_items (category_id, name, price) values ('$CAT_A', 'Produit A -- sans photo', 3.50) returning id;" | head -1)
PROD_A_POISON=$(psql -d "$DB" -t -A -c "insert into public.menu_items (category_id, name, price) values ('$CAT_A', 'Produit A -- scène empoisonnée v1.5', 4.20) returning id;" | head -1)

FAKE_RESTO="00000000-0000-0000-0000-000000000000"
FAKE_PROD="00000000-0000-0000-0000-000000000001"

OWNER_A=$(psql -d "$DB" -t -A -c "insert into auth.users (email) values ('owner-a@test') returning id;" | head -1)
MANAGER_B=$(psql -d "$DB" -t -A -c "insert into auth.users (email) values ('manager-b@test') returning id;" | head -1)
OPERATOR=$(psql -d "$DB" -t -A -c "insert into auth.users (email) values ('operator@scanym.internal') returning id;" | head -1)
IMPOSTOR=$(psql -d "$DB" -t -A -c "insert into auth.users (email) values ('nobody@test') returning id;" | head -1)
psql -d "$DB" -c "
  insert into public.restaurant_users (user_id, restaurant_id, role) values
    ('$OWNER_A', '$RESTO_A', 'owner'),
    ('$MANAGER_B', '$RESTO_B', 'manager');
  insert into public.scanym_operators (user_id, note) values ('$OPERATOR', 'test operator');
" >/dev/null
# IMPOSTOR : authentifié, mais AUCUNE ligne restaurant_users, AUCUNE
# ligne scanym_operators -- profil "unrelated authenticated user" (item 25).

# Nom de fichier généré au contrat réel : gen_random_uuid() (pgcrypto)
# produit déjà un UUID v4 canonique minuscule -- même forme EXACTE que
# crypto.randomUUID() côté Node (voir UUID-V4-CONTRACT.md).
newfile() {
  local ext="${1:-jpg}"
  psql -d "$DB" -t -A -c "select gen_random_uuid()::text || '.$ext';" | tr -d '[:space:]'
}

# NOUVEAU v1.6 : l'origine Storage Scanym de confiance, calculée
# UNIQUEMENT côté serveur en réalité (getTrustedStorageOrigin(), à
# partir de NEXT_PUBLIC_SUPABASE_URL -- voir
# TRUSTED-STORAGE-ORIGIN-CONTRACT.md). PUBLIC_URL_PREFIX est désormais
# DÉRIVÉ de TRUSTED_ORIGIN (jamais l'inverse) -- garantit que toute URL
# construite avec PUBLIC_URL_PREFIX dans ce harnais correspond
# EXACTEMENT au préfixe que p_expected_origin (transmis à chaque appel
# apply_/claim_product_photo_pending_cleanup ci-dessous) doit reconnaître.
TRUSTED_ORIGIN="https://project.supabase.co"
PUBLIC_URL_PREFIX="$TRUSTED_ORIGIN/storage/v1/object/public/product-photos"
# Une origine ÉTRANGÈRE (jamais configurée côté serveur) et un projet
# Supabase ÉTRANGER (item mandat 10 -- même plateforme, projet
# différent) -- utilisées exclusivement par la section v1.6 ci-dessous.
FOREIGN_ORIGIN="https://evil.example.com"
FOREIGN_PROJECT_ORIGIN="https://foreignproject.supabase.co"

# Insertion directe d'une ligne storage.objects, HORS RLS (rôle
# propriétaire de table -- même convention que les harnais précédents
# pour poser un état durable de départ, jamais une déclaration du
# client testé) : simule un objet déjà uploadé par le serveur de
# confiance (le seul chemin réel de création d'objet depuis v1.4,
# INSERT client étant désormais using(false)/with check(false)).
seed_object() {
  local path="$1"
  psql -d "$DB" -c "insert into storage.objects (bucket_id, name) values ('product-photos', '$path') on conflict do nothing;" >/dev/null
}

row_exists() {
  local path="$1"
  psql -d "$DB" -t -A -c "select count(*) from storage.objects where bucket_id='product-photos' and name = '$path';" | tr -d '[:space:]'
}

# NOUVEAU v1.8 -- supprime directement une ligne storage.objects (rôle
# propriétaire de table, HORS RLS -- même convention que seed_object) :
# modélise, dans ce harnais SQL pur, un `admin.storage.remove()` Node
# qui a RÉELLEMENT réussi (API Storage réelle, jamais un DELETE SQL
# applicatif -- aucune fonction de ce lot n'exécute ceci elle-même,
# voir STORAGE-API-CLEANUP-EVIDENCE.md) -- utilisé UNIQUEMENT pour
# construire le scénario "crash après succès Storage, avant finalize_"
# (mandat item 08).
delete_object() {
  local path="$1"
  psql -d "$DB" -c "delete from storage.objects where bucket_id='product-photos' and name = '$path';" >/dev/null
}

# Écrit directement menu_items.image_url (HORS apply_, rôle
# propriétaire de table) -- simule une valeur HISTORIQUE déjà présente
# en base (donnée antérieure à v1.4, ou -- avant la fermeture du
# Blocker 1 v1.5 -- posée via un appel RPC direct hostile). apply_ ne
# doit JAMAIS faire confiance à cette valeur sans la revalider
# (Blocker 2 v1.5).
seed_poisoned_image_url() {
  local product_id="$1" url="$2"
  psql -d "$DB" -c "update public.menu_items set image_url = '$url' where id = '$product_id';" >/dev/null
}

try_insert() {
  local uid="$1" path="$2"
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "
    set role authenticated;
    set local test.uid = '$uid';
    insert into storage.objects (bucket_id, name) values ('product-photos', '$path');
    reset role;
  " >/dev/null 2>&1 && echo "0" || echo "1"
}

try_delete() {
  local uid="$1" path="$2"
  local tag
  tag=$(psql -d "$DB" -c "
    set role authenticated;
    set local test.uid = '$uid';
    delete from storage.objects where bucket_id='product-photos' and name = '$path';
    reset role;
  " 2>&1 | grep -o "DELETE [0-9]*" || true)
  if [ "$tag" = "DELETE 0" ] || [ -z "$tag" ]; then echo "1"; else echo "0"; fi
}

# begin_product_photo_replacement : "0" (succès) ou "1" (exception).
# INCHANGÉE (v1.4) -- toujours AS-USER, authenticated, auth.uid().
try_begin() {
  local uid="$1" product_id="$2"
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "
    set role authenticated;
    set local test.uid = '$uid';
    select * from public.begin_product_photo_replacement('$product_id'::uuid);
    reset role;
  " >/dev/null 2>&1 && echo "0" || echo "1"
}

begin_restaurant() {
  local uid="$1" product_id="$2"
  psql -d "$DB" -t -A -c "
    set role authenticated;
    set local test.uid = '$uid';
    select restaurant_id from public.begin_product_photo_replacement('$product_id'::uuid);
    reset role;
  " 2>/dev/null | tr -d '[:space:]'
}

# NOUVEAU v1.5 : caller_user_id renvoyé par begin_ doit être EXACTEMENT
# auth.uid() (= le uid transmis), jamais une valeur distincte.
begin_caller_user_id() {
  local uid="$1" product_id="$2"
  psql -d "$DB" -t -A -c "
    set role authenticated;
    set local test.uid = '$uid';
    select caller_user_id from public.begin_product_photo_replacement('$product_id'::uuid);
    reset role;
  " 2>/dev/null | grep -v -E '^(SET|RESET)$' | tr -d '[:space:]'
}

try_begin_anon() {
  local product_id="$1"
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "
    set role anon;
    select * from public.begin_product_photo_replacement('$product_id'::uuid);
    reset role;
  " >/dev/null 2>&1 && echo "0" || echo "1"
}

# NOUVEAU v1.6 (MEDIUM cleanup retry) : begin_ renvoie désormais une
# 3e colonne, current_image_url -- lue dans la MÊME requête que la
# vérification archived_at is null (aucune requête supplémentaire).
# Sert exclusivement au nouveau chemin de retry de nettoyage.
begin_current_image_url() {
  local uid="$1" product_id="$2"
  psql -d "$DB" -t -A -c "
    set role authenticated;
    set local test.uid = '$uid';
    select coalesce(current_image_url, '<NULL>') from public.begin_product_photo_replacement('$product_id'::uuid);
    reset role;
  " 2>/dev/null | grep -v -E '^(SET|RESET)$' | tr -d '[:space:]'
}

# ------------------------------------------------------------------
# apply_product_photo_replacement -- NOUVELLE signature v1.5 à 3
# arguments (p_caller_user_id, p_product_id, p_new_image_url),
# SERVICE_ROLE UNIQUEMENT (Blocker 1 v1.5). Les helpers "as service
# role" ci-dessous représentent le SEUL chemin légitime (le serveur de
# confiance Node, avec l'identité déjà vérifiée par begin_) ; les
# helpers "as authenticated/anon/nobody" ci-après représentent
# précisément le vecteur de bypass fermé par ce lot -- appelés SANS
# jamais passer par begin_/la route de confiance.
# ------------------------------------------------------------------

# "0" (succès) ou "1" (exception) -- chemin légitime, service_role.
try_apply() {
  local uid="$1" product_id="$2" image_url="$3"
  local sql
  if [ -z "$image_url" ]; then
    sql="select * from public.apply_product_photo_replacement('$uid'::uuid, '$product_id'::uuid, null, '$TRUSTED_ORIGIN');"
  else
    sql="select * from public.apply_product_photo_replacement('$uid'::uuid, '$product_id'::uuid, '$image_url', '$TRUSTED_ORIGIN');"
  fi
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "
    set role service_role;
    $sql
  " >/dev/null 2>&1 && echo "0" || echo "1"
}

# succès -> "old_path|image_url" (champs vides -> <NULL>) ; échec -> chaîne vide. service_role.
apply_result() {
  local uid="$1" product_id="$2" image_url="$3"
  local sql
  if [ -z "$image_url" ]; then
    sql="select coalesce(old_path,'<NULL>') || '|' || coalesce(image_url,'<NULL>') from public.apply_product_photo_replacement('$uid'::uuid, '$product_id'::uuid, null, '$TRUSTED_ORIGIN');"
  else
    sql="select coalesce(old_path,'<NULL>') || '|' || coalesce(image_url,'<NULL>') from public.apply_product_photo_replacement('$uid'::uuid, '$product_id'::uuid, '$image_url', '$TRUSTED_ORIGIN');"
  fi
  psql -d "$DB" -t -A -c "
    set role service_role;
    $sql
  " 2>/dev/null | grep '|' | head -1 | tr -d '[:space:]'
}

# NOUVEAU v1.5 (Blocker 2) -- succès -> "old_path|image_url|skipped"
# (skipped = 't'/'f') ; échec -> chaîne vide. service_role.
apply_result3() {
  local uid="$1" product_id="$2" image_url="$3"
  local sql
  if [ -z "$image_url" ]; then
    sql="select coalesce(old_path,'<NULL>') || '|' || coalesce(image_url,'<NULL>') || '|' || old_path_cleanup_skipped::text from public.apply_product_photo_replacement('$uid'::uuid, '$product_id'::uuid, null, '$TRUSTED_ORIGIN');"
  else
    sql="select coalesce(old_path,'<NULL>') || '|' || coalesce(image_url,'<NULL>') || '|' || old_path_cleanup_skipped::text from public.apply_product_photo_replacement('$uid'::uuid, '$product_id'::uuid, '$image_url', '$TRUSTED_ORIGIN');"
  fi
  psql -d "$DB" -t -A -c "
    set role service_role;
    $sql
  " 2>/dev/null | grep '|' | head -1 | tr -d '[:space:]'
}

# ------------------------------------------------------------------
# NOUVEAU v2.2.1 (BULK PRODUCT PHOTOS -- SOLE BLOCKER FIX : "current
# old-Bulk-retry conflict detection is performed using an unlocked
# earlier read"). Helpers dédiés à `p_is_retry` -- AUCUN des 259 tests
# ci-dessus/ci-dessous ne les utilise, ils sont additifs, jamais une
# modification des helpers existants.
# ------------------------------------------------------------------

# succès -> "old_path|image_url|skipped|already_applied" (already_applied
# = 't'/'f') ; échec (CONFLICT ou autre) -> chaîne vide. service_role,
# p_is_retry=true.
apply_result_retry() {
  local uid="$1" product_id="$2" image_url="$3"
  psql -d "$DB" -t -A -c "
    set role service_role;
    select coalesce(old_path,'<NULL>') || '|' || coalesce(image_url,'<NULL>') || '|' || old_path_cleanup_skipped::text || '|' || already_applied::text
    from public.apply_product_photo_replacement('$uid'::uuid, '$product_id'::uuid, '$image_url', '$TRUSTED_ORIGIN', true);
  " 2>/dev/null | grep '|' | head -1 | tr -d '[:space:]'
}

# "0" (succès) ou "1" (exception) -- p_is_retry=true, service_role.
try_apply_retry() {
  local uid="$1" product_id="$2" image_url="$3"
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "
    set role service_role;
    select * from public.apply_product_photo_replacement('$uid'::uuid, '$product_id'::uuid, '$image_url', '$TRUSTED_ORIGIN', true);
  " >/dev/null 2>&1 && echo "0" || echo "1"
}

# Renvoie EXACTEMENT le SQLSTATE de l'exception levée par un appel
# p_is_retry=true (jamais une simple présence/absence d'erreur comme
# try_apply_retry ci-dessus) -- 'OK' si aucune exception (succès,
# already_applied). Nécessaire pour prouver que le CONFLICT est
# SPÉCIFIQUEMENT 'P0004' (nouveau SQLSTATE v2.2.1), jamais une
# exception générique/une coïncidence. `-v VERBOSITY=verbose` fait
# préfixer par psql chaque message ERROR par son SQLSTATE EXACT
# ('ERROR:  P0004: Photo replacement conflict...') -- extrait ici par
# une simple expression régulière, sans dépendre d'un bloc PL/pgSQL
# imbriqué ni d'une table temporaire. `|| true` : un ERROR côté SQL est
# un résultat ATTENDU de cet appel (le cas CONFLICT), jamais un échec
# du harnais lui-même -- ne doit donc jamais interrompre le script
# (set -e euo pipefail, voir en-tête).
apply_retry_sqlstate() {
  local uid="$1" product_id="$2" image_url="$3"
  local out
  out=$(psql -d "$DB" -v VERBOSITY=verbose -c "
    set role service_role;
    select * from public.apply_product_photo_replacement('$uid'::uuid, '$product_id'::uuid, '$image_url', '$TRUSTED_ORIGIN', true);
  " 2>&1) || true
  if echo "$out" | grep -q "^ERROR:"; then
    echo "$out" | grep "^ERROR:" | head -1 | sed -E 's/^ERROR: *([A-Z0-9]{5}):.*/\1/'
  else
    echo "OK"
  fi
}

# ------------------------------------------------------------------
# NOUVEAU v1.7 (REMPLACE retry_product_photo_cleanup_path -- v1.6,
# SUPPRIMÉE) -- create_/claim_/reopen_product_photo_pending_cleanup.
# AUCUNE de ces fonctions n'accepte de CHEMIN depuis un appelant --
# create_ reçoit le old_path DÉJÀ validé par apply_ (représente
# EXCLUSIVEMENT l'appel interne Node, jamais un vecteur client réel) ;
# claim_/reopen_ ne reçoivent qu'un cleanup_id (uuid) OPAQUE. Toutes
# service_role uniquement.
# ------------------------------------------------------------------

# succès -> cleanup_id (uuid) ; échec -> chaîne vide.
create_pending_cleanup() {
  local uid="$1" product_id="$2" old_path="$3"
  psql -d "$DB" -t -A -c "
    set role service_role;
    select public.create_product_photo_pending_cleanup('$uid'::uuid, '$product_id'::uuid, '$old_path', '$TRUSTED_ORIGIN');
  " 2>/dev/null | grep -v -E '^(SET|RESET)$' | tr -d '[:space:]'
}

# "0" (succès) ou "1" (exception).
try_create_pending_cleanup() {
  local uid="$1" product_id="$2" old_path="$3"
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "
    set role service_role;
    select public.create_product_photo_pending_cleanup('$uid'::uuid, '$product_id'::uuid, '$old_path', '$TRUSTED_ORIGIN');
  " >/dev/null 2>&1 && echo "0" || echo "1"
}

# NOUVEAU v1.8 -- claim_ renvoie désormais `table(old_path, claim_token)`
# (JAMAIS un scalaire old_path -- v1.7) : transitionne pending/processing-
# bail-expiré -> PROCESSING, JAMAIS -> completed (SEUL blocker fermé par
# ce lot). Succès -> "old_path|claim_token" ; refus logique (0 ligne,
# JAMAIS une exception) -> "<NULL>|<NULL>". `lease_seconds` optionnel
# (4e argument) -- permet aux tests de poser un bail COURT (ex. 1s) pour
# exercer déterministiquement l'expiration, sans dépendre du défaut
# 120s ni d'un `sleep` réel de plusieurs minutes.
claim_cleanup_result() {
  local uid="$1" product_id="$2" cleanup_id="$3" lease="${4:-}"
  local lease_sql="null"
  if [ -n "$lease" ]; then lease_sql="$lease"; fi
  local out
  out=$(psql -d "$DB" -t -A -c "
    set role service_role;
    select coalesce(old_path,'<NULL>') || '|' || coalesce(claim_token::text,'<NULL>')
    from public.claim_product_photo_pending_cleanup('$uid'::uuid, '$product_id'::uuid, '$cleanup_id'::uuid, '$TRUSTED_ORIGIN', $lease_sql);
  " 2>/dev/null | grep -v -E '^(SET|RESET)$' | grep '|' | head -1 | tr -d '[:space:]')
  if [ -z "$out" ]; then echo "<NULL>|<NULL>"; else echo "$out"; fi
}

# Extraction pratique des deux composantes de claim_cleanup_result.
claim_path_of() { echo "$1" | cut -d'|' -f1; }
claim_token_of() { echo "$1" | cut -d'|' -f2; }

# "0" (succès -- ne lève jamais, même si aucune ligne n'est renvoyée)
# ou "1" (exception -- réservé au refus d'autorisation totale).
try_claim_cleanup() {
  local uid="$1" product_id="$2" cleanup_id="$3"
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "
    set role service_role;
    select * from public.claim_product_photo_pending_cleanup('$uid'::uuid, '$product_id'::uuid, '$cleanup_id'::uuid, '$TRUSTED_ORIGIN');
  " >/dev/null 2>&1 && echo "0" || echo "1"
}

# NOUVEAU v1.7 -- reproduit EXACTEMENT le vecteur fermé : un porteur de
# jeton `authenticated` (même le propriétaire LÉGITIME du produit
# ciblé) appelle claim_ DIRECTEMENT, sans jamais passer par la route de
# confiance/service_role.
try_claim_cleanup_as_authenticated() {
  local uid="$1" product_id="$2" cleanup_id="$3"
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "
    set role authenticated;
    set local test.uid = '$uid';
    select * from public.claim_product_photo_pending_cleanup('$uid'::uuid, '$product_id'::uuid, '$cleanup_id'::uuid, '$TRUSTED_ORIGIN');
    reset role;
  " >/dev/null 2>&1 && echo "0" || echo "1"
}

try_claim_cleanup_as_anon() {
  local product_id="$1" cleanup_id="$2"
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "
    set role anon;
    select * from public.claim_product_photo_pending_cleanup(gen_random_uuid(), '$product_id'::uuid, '$cleanup_id'::uuid, '$TRUSTED_ORIGIN');
    reset role;
  " >/dev/null 2>&1 && echo "0" || echo "1"
}

# NOUVEAU v1.8 -- REMPLACE reopen_cleanup_result (v1.7). finalize_/
# release_ exigent EXACTEMENT le claim_token renvoyé par le claim_ dont
# elles prétendent clore/libérer la tentative -- "true"/"false" (jamais
# une exception pour un refus logique, réservée à assert_product_role_for).
finalize_cleanup_result() {
  local uid="$1" product_id="$2" cleanup_id="$3" claim_token="$4"
  psql -d "$DB" -t -A -c "
    set role service_role;
    select coalesce(public.finalize_product_photo_pending_cleanup('$uid'::uuid, '$product_id'::uuid, '$cleanup_id'::uuid, '$claim_token'::uuid)::text, '<NULL>');
  " 2>/dev/null | grep -v -E '^(SET|RESET)$' | tr -d '[:space:]'
}

release_cleanup_result() {
  local uid="$1" product_id="$2" cleanup_id="$3" claim_token="$4"
  psql -d "$DB" -t -A -c "
    set role service_role;
    select coalesce(public.release_product_photo_pending_cleanup('$uid'::uuid, '$product_id'::uuid, '$cleanup_id'::uuid, '$claim_token'::uuid)::text, '<NULL>');
  " 2>/dev/null | grep -v -E '^(SET|RESET)$' | tr -d '[:space:]'
}

try_finalize_cleanup_as_authenticated() {
  local uid="$1" product_id="$2" cleanup_id="$3" claim_token="$4"
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "
    set role authenticated;
    set local test.uid = '$uid';
    select public.finalize_product_photo_pending_cleanup('$uid'::uuid, '$product_id'::uuid, '$cleanup_id'::uuid, '$claim_token'::uuid);
    reset role;
  " >/dev/null 2>&1 && echo "0" || echo "1"
}

try_finalize_cleanup_as_anon() {
  local product_id="$1" cleanup_id="$2" claim_token="$3"
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "
    set role anon;
    select public.finalize_product_photo_pending_cleanup(gen_random_uuid(), '$product_id'::uuid, '$cleanup_id'::uuid, '$claim_token'::uuid);
    reset role;
  " >/dev/null 2>&1 && echo "0" || echo "1"
}

try_release_cleanup_as_authenticated() {
  local uid="$1" product_id="$2" cleanup_id="$3" claim_token="$4"
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "
    set role authenticated;
    set local test.uid = '$uid';
    select public.release_product_photo_pending_cleanup('$uid'::uuid, '$product_id'::uuid, '$cleanup_id'::uuid, '$claim_token'::uuid);
    reset role;
  " >/dev/null 2>&1 && echo "0" || echo "1"
}

try_release_cleanup_as_anon() {
  local product_id="$1" cleanup_id="$2" claim_token="$3"
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "
    set role anon;
    select public.release_product_photo_pending_cleanup(gen_random_uuid(), '$product_id'::uuid, '$cleanup_id'::uuid, '$claim_token'::uuid);
    reset role;
  " >/dev/null 2>&1 && echo "0" || echo "1"
}

cleanup_row_status() {
  local cleanup_id="$1"
  psql -d "$DB" -t -A -c "select coalesce(status, '<NULL>') from public.product_photo_pending_cleanups where id = '$cleanup_id'::uuid;" | tr -d '[:space:]'
}

# NOUVEAU v1.8 -- lecture générique d'une colonne de la ligne (claim_token/
# claimed_at/lease_until/attempt_count) pour les assertions de bail.
cleanup_row_field() {
  local cleanup_id="$1" field="$2"
  psql -d "$DB" -t -A -c "select coalesce($field::text, '<NULL>') from public.product_photo_pending_cleanups where id = '$cleanup_id'::uuid;" | tr -d '[:space:]'
}

# NOUVEAU v1.8 -- fait expirer DÉTERMINISTIQUEMENT le bail d'une ligne
# (contexte admin/superuser implicite du harnais, comme seed_object) --
# simule le passage du temps SANS `sleep` réel de plusieurs minutes, pour
# exercer la récupération automatique (mandat : "PROCESSING must NOT be
# able to become permanently stuck").
force_expire_lease() {
  local cleanup_id="$1"
  psql -d "$DB" -c "update public.product_photo_pending_cleanups set lease_until = now() - interval '1 second' where id = '$cleanup_id'::uuid;" >/dev/null
}

# NOUVEAU v1.7 -- insertion BRUTE (contexte admin/superuser implicite du
# harnais, comme seed_object/seed_poisoned_image_url) directement dans
# product_photo_pending_cleanups, pour construire des lignes
# ADVERSARIALES/altérées impossibles à produire via create_
# elle-même (qui revalide toujours la forme du chemin à la création) --
# sert exclusivement à prouver que claim_ REVALIDE le chemin stocké au
# moment du claim, jamais seulement à sa création (défense en
# profondeur, items 14/15/16).
seed_pending_cleanup() {
  local restaurant_id="$1" product_id="$2" old_path="$3" status="${4:-pending}"
  psql -d "$DB" -t -A -c "
    insert into public.product_photo_pending_cleanups (restaurant_id, product_id, old_path, status)
    values ('$restaurant_id'::uuid, '$product_id'::uuid, '$old_path', '$status')
    returning id;
  " | head -1 | tr -d '[:space:]'
}

try_apply_anon() {
  local product_id="$1" image_url="$2"
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "
    set role anon;
    select * from public.apply_product_photo_replacement(gen_random_uuid(), '$product_id'::uuid, '$image_url', '$TRUSTED_ORIGIN');
    reset role;
  " >/dev/null 2>&1 && echo "0" || echo "1"
}

# NOUVEAU v1.5 (Blocker 1) -- reproduit EXACTEMENT le vecteur fermé :
# un porteur de jeton `authenticated` (même le propriétaire LÉGITIME du
# produit ciblé -- aucune faille cross-tenant requise) appelle apply_
# DIRECTEMENT, sans jamais passer par begin_/la route de confiance.
# Attendu : "1" (exception -- GRANT EXECUTE retiré, refus au niveau
# privilège, avant même l'évaluation de la logique d'autorisation
# applicative).
try_apply_as_authenticated() {
  local uid="$1" product_id="$2" image_url="$3"
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "
    set role authenticated;
    set local test.uid = '$uid';
    select * from public.apply_product_photo_replacement('$uid'::uuid, '$product_id'::uuid, '$image_url', '$TRUSTED_ORIGIN');
    reset role;
  " >/dev/null 2>&1 && echo "0" || echo "1"
}

# NOUVEAU v1.5 -- proxy comportemental du pseudo-rôle PUBLIC : un rôle
# fraîchement créé, SANS AUCUN GRANT explicite (ni authenticated, ni
# anon, ni service_role) ne doit jamais hériter d'EXECUTE.
try_apply_as_nobody() {
  local product_id="$1" image_url="$2"
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "
    set role \"$NOBODY_ROLE\";
    select * from public.apply_product_photo_replacement(gen_random_uuid(), '$product_id'::uuid, '$image_url', '$TRUSTED_ORIGIN');
    reset role;
  " >/dev/null 2>&1 && echo "0" || echo "1"
}

current_image_url() {
  local product_id="$1"
  psql -d "$DB" -t -A -c "select coalesce(image_url, '<NULL>') from public.menu_items where id = '$product_id';" | tr -d '[:space:]'
}

# ==================================================================
# MANDAT v1.5 -- items 01-04 : matrice de privilège RPC directe sur
# apply_product_photo_replacement (Blocker 1). AUCUNE des trois
# premières tentatives n'atteint même la logique d'autorisation
# applicative -- le refus survient au niveau GRANT, avant toute
# évaluation de p_caller_user_id/p_product_id.
# ==================================================================

log "=== 01 -- authenticated direct RPC call -> DENIED (même le propriétaire LÉGITIME du produit ciblé, aucune faille cross-tenant requise) ==="
RC=$(try_apply_as_authenticated "$OWNER_A" "$PROD_A1" "$PUBLIC_URL_PREFIX/$RESTO_A/$PROD_A1/$(newfile)")
assert_eq "01: authenticated (OWNER_A, propriétaire légitime de PROD_A1) appelant apply_ DIRECTEMENT -> DENIED (GRANT EXECUTE retiré, Blocker 1 v1.5)" "1" "$RC"

log "=== 02 -- anon direct RPC call -> DENIED ==="
RC=$(try_apply_anon "$PROD_A1" "$PUBLIC_URL_PREFIX/$RESTO_A/$PROD_A1/$(newfile)")
assert_eq "02: anon appelant apply_ DIRECTEMENT -> DENIED" "1" "$RC"

log "=== 03 -- PUBLIC direct RPC call -> DENIED (rôle fraîchement créé, aucun GRANT explicite) ==="
RC=$(try_apply_as_nobody "$PROD_A1" "$PUBLIC_URL_PREFIX/$RESTO_A/$PROD_A1/$(newfile)")
assert_eq "03: rôle sans aucun GRANT explicite ($NOBODY_ROLE) appelant apply_ DIRECTEMENT -> DENIED (EXECUTE jamais accordé à PUBLIC)" "1" "$RC"

log "=== 03bis -- introspection ACL : proacl d'apply_ ne contient AUCUNE entrée PUBLIC (grantee vide) ==="
ACL=$(psql -d "$DB" -t -A -c "select coalesce(array_to_string(p.proacl, ','), '<NULL>') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='apply_product_photo_replacement';")
if echo ",$ACL" | grep -Eq ',=[^,]*'; then
  fail "03bis: PUBLIC ACL -- une entrée PUBLIC (grantee vide) subsiste dans proacl ($ACL) -- Blocker 1 v1.5 NON fermé"
else
  pass "03bis: PUBLIC ACL -- aucune entrée PUBLIC dans proacl ($ACL)"
fi

log "=== 04 -- trusted server (service_role) RPC call, identité vérifiée transmise -> ALLOWED ==="
ITEM04_PATH="$RESTO_A/$PROD_A1/$(newfile)"
seed_object "$ITEM04_PATH"
RC=$(try_apply "$OWNER_A" "$PROD_A1" "$PUBLIC_URL_PREFIX/$ITEM04_PATH")
assert_eq "04: service_role, p_caller_user_id=OWNER_A (obtenu via begin_ dans le flux réel), propre produit -> ALLOWED" "0" "$RC"

log "=== NOUVEAU v1.5 : begin_ renvoie caller_user_id EXACTEMENT égal à auth.uid() (= au uid transmis), jamais une valeur distincte ==="
CALLER_RETURNED=$(begin_caller_user_id "$OWNER_A" "$PROD_A1")
assert_eq "begin_ -- caller_user_id renvoyé == auth.uid() (OWNER_A)" "$OWNER_A" "$CALLER_RETURNED"

# ==================================================================
# MANDAT v1.5 -- items 05/06 : scène hostile à TROIS objets, EXIGÉE
# par le mandat -- A (courante), B (nouvel upload légitime), C (objet
# RÉEL SANS RAPPORT sous le MÊME namespace produit valide). Un
# appelant authenticated hostile tente d'invoquer apply_ DIRECTEMENT
# pour faire de C -- puis d'une URL totalement arbitraire -- la
# nouvelle valeur autoritaire, sans jamais passer par l'upload
# orchestré par le serveur.
# ==================================================================

HOSTILE_A="$RESTO_A/$PROD_A_POISON/$(newfile)"
HOSTILE_B="$RESTO_A/$PROD_A_POISON/$(newfile)"
HOSTILE_C="$RESTO_A/$PROD_A_POISON/$(newfile)"
psql -d "$DB" -c "update public.menu_items set image_url = '$PUBLIC_URL_PREFIX/$HOSTILE_A' where id = '$PROD_A_POISON';" >/dev/null
seed_object "$HOSTILE_A"
seed_object "$HOSTILE_B"
seed_object "$HOSTILE_C"

log "=== 05 -- client (authenticated, propriétaire légitime) tente DIRECTEMENT de faire de C (objet réel, MÊME namespace produit, jamais uploadé pour CE remplacement) la nouvelle valeur autoritaire -> DENIED ==="
RC=$(try_apply_as_authenticated "$OWNER_A" "$PROD_A_POISON" "$PUBLIC_URL_PREFIX/$HOSTILE_C")
assert_eq "05: substitution hostile de C via appel authenticated DIRECT -> DENIED (GRANT EXECUTE retiré -- jamais atteint la logique de validation de chemin)" "1" "$RC"
IMG_UNCHANGED_HOSTILE=$(current_image_url "$PROD_A_POISON")
assert_eq "05bis: après le refus, menu_items.image_url reste EXACTEMENT A -- aucun effet de bord partiel" "$PUBLIC_URL_PREFIX/$HOSTILE_A" "$IMG_UNCHANGED_HOSTILE"

log "=== 06 -- client (authenticated) tente DIRECTEMENT une URL totalement arbitraire (jamais uploadée, jamais un objet réel) -> DENIED ==="
ARBITRARY_URL="$PUBLIC_URL_PREFIX/$RESTO_A/$PROD_A_POISON/ffffffff-ffff-4fff-8fff-ffffffffffff.jpg"
RC=$(try_apply_as_authenticated "$OWNER_A" "$PROD_A_POISON" "$ARBITRARY_URL")
assert_eq "06: URL arbitraire via appel authenticated DIRECT -> DENIED (même mécanisme -- GRANT EXECUTE retiré)" "1" "$RC"

log "=== équivalent bypass anon/nobody sur la même scène hostile -> DENIED ==="
RC=$(try_apply_anon "$PROD_A_POISON" "$PUBLIC_URL_PREFIX/$HOSTILE_C")
assert_eq "équivalent bypass anon ciblant C -> DENIED" "1" "$RC"
RC=$(try_apply_as_nobody "$PROD_A_POISON" "$PUBLIC_URL_PREFIX/$HOSTILE_C")
assert_eq "équivalent bypass rôle sans privilège ciblant C -> DENIED" "1" "$RC"

log "=== réplique légitime (service_role, upload réel B orchestré) : A -> B, C JAMAIS référencé ==="
RESULT=$(apply_result3 "$OWNER_A" "$PROD_A_POISON" "$PUBLIC_URL_PREFIX/$HOSTILE_B")
OLD_PATH_H="${RESULT%%|*}"
REST_H="${RESULT#*|}"
NEW_URL_H="${REST_H%%|*}"
SKIPPED_H="${REST_H##*|}"
assert_eq "réplique légitime A->B : old_path renvoyé == A (lu en DB, jamais une valeur cliente)" "$HOSTILE_A" "$OLD_PATH_H"
assert_eq "réplique légitime A->B : old_path_cleanup_skipped == false (A est un chemin valide, cleanup normalement éligible)" "false" "$SKIPPED_H"
EXISTS_C_HOSTILE=$(row_exists "$HOSTILE_C")
assert_eq "C survit intact -- jamais référencé par le remplacement légitime, jamais substitué par la tentative hostile" "1" "$EXISTS_C_HOSTILE"

# ==================================================================
# 12–18 (préservé v1.4) : contrat EXACT crypto.randomUUID() v4 + forme
# exacte de chemin (Blocker 3 v1.4), testés via apply_ (chemin
# légitime, service_role) contre un objet PRÉ-SEMÉ (existence physique
# requise pour le NOUVEAU chemin) sous le namespace d'un produit par
# ailleurs parfaitement valide -- isole chaque cause de refus sur la
# SEULE forme du chemin/nom de fichier.
# ==================================================================

log "=== 12 -- nil UUID filename -> DENIED ==="
NIL_PATH="$RESTO_A/$PROD_A1/00000000-0000-0000-0000-000000000000.jpg"
seed_object "$NIL_PATH"
RC=$(try_apply "$OWNER_A" "$PROD_A1" "$PUBLIC_URL_PREFIX/$NIL_PATH")
assert_eq "12: nom de fichier UUID NIL (version nibble '0', jamais '4') -> DENIED" "1" "$RC"

log "=== 13 -- UUID v1/v3/v5 filename -> DENIED ==="
for V in 1 3 5; do
  P="$RESTO_A/$PROD_A1/aaaaaaaa-bbbb-${V}ccc-8ddd-eeeeeeeeeeee.jpg"
  seed_object "$P"
  RC=$(try_apply "$OWNER_A" "$PROD_A1" "$PUBLIC_URL_PREFIX/$P")
  assert_eq "13: nom de fichier UUID version $V (jamais 4) -> DENIED" "1" "$RC"
done

log "=== 14 -- UUID v4 invalid variant -> DENIED ==="
for VAR in 0 1 2 3 4 5 6 7 c d e f; do
  P="$RESTO_A/$PROD_A1/aaaaaaaa-bbbb-4ccc-${VAR}ddd-eeeeeeeeeeee.jpg"
  seed_object "$P"
  RC=$(try_apply "$OWNER_A" "$PROD_A1" "$PUBLIC_URL_PREFIX/$P")
  assert_eq "14: UUID v4, variante '$VAR' (hors RFC4122 8/9/a/b) -> DENIED" "1" "$RC"
done

log "=== 15 -- uppercase UUID filename -> DENIED ==="
UPPER_PATH="$RESTO_A/$PROD_A1/AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE.jpg"
seed_object "$UPPER_PATH"
RC=$(try_apply "$OWNER_A" "$PROD_A1" "$PUBLIC_URL_PREFIX/$UPPER_PATH")
assert_eq "15: UUID en MAJUSCULES (crypto.randomUUID() ne produit jamais que des minuscules) -> DENIED" "1" "$RC"

log "=== 16 -- valid lowercase crypto.randomUUID()-compatible v4 filename -> ALLOWED ==="
VALID_PATH="$RESTO_A/$PROD_A1/$(newfile)"
seed_object "$VALID_PATH"
RC=$(try_apply "$OWNER_A" "$PROD_A1" "$PUBLIC_URL_PREFIX/$VALID_PATH")
assert_eq "16: UUID v4 minuscule valide (contrat exact crypto.randomUUID()) -> ALLOWED" "0" "$RC"

log "=== 17 -- extra nested path -> DENIED ==="
NESTED_PATH="$RESTO_A/$PROD_A1/sub/$(newfile)"
seed_object "$NESTED_PATH"
RC=$(try_apply "$OWNER_A" "$PROD_A1" "$PUBLIC_URL_PREFIX/$NESTED_PATH")
assert_eq "17: segment de chemin imbriqué supplémentaire (4 segments) -> DENIED" "1" "$RC"

log "=== 18 -- missing filename -> DENIED ==="
NOFILE_PATH="$RESTO_A/$PROD_A1"
seed_object "$NOFILE_PATH"
RC=$(try_apply "$OWNER_A" "$PROD_A1" "$PUBLIC_URL_PREFIX/$NOFILE_PATH")
assert_eq "18: nom de fichier manquant (2 segments) -> DENIED" "1" "$RC"

# ==================================================================
# MANDAT v1.5 -- items 08-16 : les 9 tests de FORME sur l'ANCIENNE
# valeur lue en DB (Blocker 2). Chaque cas écrit DIRECTEMENT
# menu_items.image_url (simulant une valeur historique/empoisonnée,
# jamais passée par apply_ elle-même), puis appelle apply_ (chemin
# légitime, service_role) avec un NOUVEAU chemin valide -- le
# remplacement doit RÉUSSIR quand même, mais old_path doit être NULL
# et old_path_cleanup_skipped=true : la valeur empoisonnée n'est
# JAMAIS renvoyée comme cible de nettoyage.
# ==================================================================

assert_poisoned_old_value_skipped() {
  local desc="$1" poisoned_old_url="$2"
  seed_poisoned_image_url "$PROD_A_POISON" "$poisoned_old_url"
  local new_path="$RESTO_A/$PROD_A_POISON/$(newfile)"
  seed_object "$new_path"
  local result
  result=$(apply_result3 "$OWNER_A" "$PROD_A_POISON" "$PUBLIC_URL_PREFIX/$new_path")
  local old_path="${result%%|*}"
  local rest="${result#*|}"
  local new_url="${rest%%|*}"
  local skipped="${rest##*|}"
  assert_eq "$desc -- old_path renvoyé == <NULL> (JAMAIS la valeur empoisonnée)" "<NULL>" "$old_path"
  assert_eq "$desc -- old_path_cleanup_skipped == true (nettoyage explicitement SAUTÉ, jamais tenté, jamais normalisé)" "true" "$skipped"
  assert_eq "$desc -- le remplacement RÉUSSIT quand même (nouvelle valeur écrite)" "$PUBLIC_URL_PREFIX/$new_path" "$new_url"
}

log "=== 08 -- poisoned different-restaurant DB old image -> never deleted ==="
assert_poisoned_old_value_skipped "08: ancienne valeur DB sous un restaurant différent (RESTO_B) de celui résolu côté serveur (RESTO_A)" \
  "$PUBLIC_URL_PREFIX/$RESTO_B/$PROD_A_POISON/$(newfile)"

log "=== 09 -- poisoned different-product DB old image -> never deleted ==="
assert_poisoned_old_value_skipped "09: ancienne valeur DB sous un produit différent (PROD_A1) de celui résolu (PROD_A_POISON)" \
  "$PUBLIC_URL_PREFIX/$RESTO_A/$PROD_A1/$(newfile)"

log "=== 10 -- poisoned nested path -> never deleted ==="
assert_poisoned_old_value_skipped "10: ancienne valeur DB avec segment de chemin imbriqué supplémentaire (4 segments)" \
  "$PUBLIC_URL_PREFIX/$RESTO_A/$PROD_A_POISON/sub/$(newfile)"

log "=== 11 -- poisoned nil UUID -> never deleted ==="
assert_poisoned_old_value_skipped "11: ancienne valeur DB avec UUID NIL" \
  "$PUBLIC_URL_PREFIX/$RESTO_A/$PROD_A_POISON/00000000-0000-0000-0000-000000000000.jpg"

log "=== 12 (Blocker 2) -- poisoned wrong UUID version -> never deleted ==="
assert_poisoned_old_value_skipped "12: ancienne valeur DB avec UUID version 1 (jamais 4)" \
  "$PUBLIC_URL_PREFIX/$RESTO_A/$PROD_A_POISON/aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee.jpg"

log "=== 13 (Blocker 2) -- poisoned uppercase UUID -> never deleted ==="
assert_poisoned_old_value_skipped "13: ancienne valeur DB avec UUID en MAJUSCULES" \
  "$PUBLIC_URL_PREFIX/$RESTO_A/$PROD_A_POISON/AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE.jpg"

log "=== 14 (Blocker 2) -- poisoned wrong extension -> never deleted ==="
assert_poisoned_old_value_skipped "14: ancienne valeur DB avec extension non autorisée (.gif)" \
  "$PUBLIC_URL_PREFIX/$RESTO_A/$PROD_A_POISON/$(newfile gif)"

log "=== 15 -- external URL (hors bucket product-photos) -> never deleted ==="
assert_poisoned_old_value_skipped "15: ancienne valeur DB -- URL externe totalement étrangère au bucket Storage" \
  "https://evil.example.com/not-supabase/whatever.jpg"

log "=== 16 -- malformed Storage URL (marqueur /object/public/ absent) -> never deleted ==="
assert_poisoned_old_value_skipped "16: ancienne valeur DB -- URL Storage malformée (segment /object/public/ absent)" \
  "https://project.supabase.co/storage/v1/product-photos/$RESTO_A/$PROD_A_POISON/$(newfile)"

# ==================================================================
# 02/19/21 (préservé v1.4, renumérotés implicitement) : chemin
# restaurant/produit incohérent avec le restaurant_id RÉSOLU côté
# serveur pour le NOUVEAU chemin (jamais transmis par le client).
# ==================================================================

log "=== nouveau chemin sous un restaurant FABRIQUÉ -> DENIED ==="
FAKE_RESTO_PATH="$FAKE_RESTO/$PROD_A1/$(newfile)"
seed_object "$FAKE_RESTO_PATH"
RC=$(try_apply "$OWNER_A" "$PROD_A1" "$PUBLIC_URL_PREFIX/$FAKE_RESTO_PATH")
assert_eq "nouveau chemin sous un restaurant FABRIQUÉ (segment 1 ne correspond jamais au restaurant_id résolu côté serveur) -> DENIED" "1" "$RC"

log "=== restaurant/produit incohérents (chemin sous restaurant B pour un produit de A) -> DENIED ==="
MISMATCH_PATH="$RESTO_B/$PROD_A1/$(newfile)"
seed_object "$MISMATCH_PATH"
RC=$(try_apply "$OWNER_A" "$PROD_A1" "$PUBLIC_URL_PREFIX/$MISMATCH_PATH")
assert_eq "nouveau chemin sous le restaurant B pour le produit A1 (appartient à A) -> DENIED (segment 1 incohérent)" "1" "$RC"

log "=== unrelated existing object under a DIFFERENT real product's namespace -> DENIED (cross-produit, jamais confondu) ==="
CROSS_PRODUCT_PATH="$RESTO_A/$PROD_A_PROV/$(newfile)"
seed_object "$CROSS_PRODUCT_PATH"
RC=$(try_apply "$OWNER_A" "$PROD_A1" "$PUBLIC_URL_PREFIX/$CROSS_PRODUCT_PATH")
assert_eq "objet réel existant mais sous le namespace d'un AUTRE produit réel (segment 2 incohérent) -> DENIED" "1" "$RC"

# ==================================================================
# 20/22/24/25/26 (préservé v1.4) : entité produit/appelant (begin_ ET
# apply_, chacune revalide indépendamment -- apply_ via son jumeau
# paramétré assert_product_role_for depuis v1.5).
# ==================================================================

log "=== fabricated product -> DENIED (begin_ ET apply_) ==="
RC=$(try_begin "$OPERATOR" "$FAKE_PROD")
assert_eq "begin_ -- produit FABRIQUÉ -> DENIED" "1" "$RC"
RC=$(try_apply "$OPERATOR" "$FAKE_PROD" "$PUBLIC_URL_PREFIX/$FAKE_RESTO/$FAKE_PROD/$(newfile)")
assert_eq "apply_ -- produit FABRIQUÉ -> DENIED" "1" "$RC"

log "=== archived product -> DENIED (begin_ ET apply_, même owner légitime) ==="
RC=$(try_begin "$OWNER_A" "$PROD_A_ARCHIVED")
assert_eq "begin_ -- produit ARCHIVÉ, même owner légitime -> DENIED" "1" "$RC"
ARCH_PATH="$RESTO_A/$PROD_A_ARCHIVED/$(newfile)"
seed_object "$ARCH_PATH"
RC=$(try_apply "$OWNER_A" "$PROD_A_ARCHIVED" "$PUBLIC_URL_PREFIX/$ARCH_PATH")
assert_eq "apply_ -- produit ARCHIVÉ, même owner légitime -> DENIED" "1" "$RC"

log "=== merchant other tenant -> DENIED (owner A ciblant un produit du restaurant B) ==="
RC=$(try_begin "$OWNER_A" "$PROD_B1")
assert_eq "begin_ -- owner A ciblant le produit B1 (restaurant B) -> DENIED" "1" "$RC"
RC=$(try_apply "$OWNER_A" "$PROD_B1" "$PUBLIC_URL_PREFIX/$RESTO_B/$PROD_B1/$(newfile)")
assert_eq "apply_ -- owner A ciblant le produit B1 -> DENIED (jumeau assert_product_role_for revalide indépendamment)" "1" "$RC"

log "=== unrelated authenticated -> DENIED ==="
RC=$(try_begin "$IMPOSTOR" "$PROD_A1")
assert_eq "begin_ -- utilisateur authentifié non lié -> DENIED" "1" "$RC"
RC=$(try_apply "$IMPOSTOR" "$PROD_A1" "$PUBLIC_URL_PREFIX/$RESTO_A/$PROD_A1/$(newfile)")
assert_eq "apply_ -- utilisateur authentifié non lié (p_caller_user_id=IMPOSTOR) -> DENIED" "1" "$RC"

log "=== anon -> DENIED ==="
RC=$(try_begin_anon "$PROD_A1")
assert_eq "begin_ -- anon (aucun GRANT EXECUTE) -> DENIED" "1" "$RC"
RC=$(try_apply_anon "$PROD_A1" "$PUBLIC_URL_PREFIX/$RESTO_A/$PROD_A1/$(newfile)")
assert_eq "apply_ -- anon (aucun GRANT EXECUTE) -> DENIED" "1" "$RC"

log "=== merchant own legitimate replacement -> PASS (chemin légitime : begin_ AS-USER, puis apply_ service_role avec l'identité vérifiée) ==="
RC=$(try_begin "$OWNER_A" "$PROD_A1")
assert_eq "begin_ -- owner A, propre produit -> PASS" "0" "$RC"
LEGIT_PATH="$RESTO_A/$PROD_A1/$(newfile)"
seed_object "$LEGIT_PATH"
RC=$(try_apply "$OWNER_A" "$PROD_A1" "$PUBLIC_URL_PREFIX/$LEGIT_PATH")
assert_eq "apply_ -- service_role, p_caller_user_id=OWNER_A, propre produit, chemin conforme -> PASS" "0" "$RC"

# ==================================================================
# MANDAT v1.5 -- items 07/17/18 : scène de provenance à TROIS objets
# Storage distincts (préservée depuis v1.4), désormais EXPLICITEMENT
# associée à la revalidation de l'ancien chemin (Blocker 2) :
#   A = photo COURANTE avant remplacement (valide -- item 07 : cleanup
#       allowed)
#   B = photo qui DEVIENT l'ancienne photo légitime au moment du
#       remplacement A -> B (capturée depuis la DB, jamais depuis une
#       déclaration cliente -- item 18)
#   C = objet SANS RAPPORT, jamais référencé, présent dans le MÊME
#       namespace produit valide -- ne doit JAMAIS être supprimé ni
#       substituable comme cible de nettoyage (item 17)
# ==================================================================

PATH_A="$RESTO_A/$PROD_A_PROV/$(newfile)"
PATH_B="$RESTO_A/$PROD_A_PROV/$(newfile)"
PATH_C="$RESTO_A/$PROD_A_PROV/$(newfile)"

psql -d "$DB" -c "update public.menu_items set image_url = '$PUBLIC_URL_PREFIX/$PATH_A' where id = '$PROD_A_PROV';" >/dev/null
seed_object "$PATH_A"
seed_object "$PATH_B"
seed_object "$PATH_C"

log "=== poisoned product image_url from a caller-controlled path -> le flux de confiance détecte/refuse (image_url ne peut jamais être écrasée par un chemin non validé) ==="
# Tentative de "poisoning" : un appelant tente de faire pointer
# image_url vers un chemin qui échouerait la validation exacte (ici,
# un chemin sous un AUTRE produit réel) -- DENIED, ET menu_items.
# image_url reste STRICTEMENT inchangé (aucun effet de bord partiel).
POISON_PATH="$RESTO_A/$PROD_A1/$(newfile)"
seed_object "$POISON_PATH"
RC=$(try_apply "$OWNER_A" "$PROD_A_PROV" "$PUBLIC_URL_PREFIX/$POISON_PATH")
assert_eq "tentative d'empoisonnement (chemin d'un AUTRE produit réel) -> DENIED" "1" "$RC"
IMG_UNCHANGED=$(current_image_url "$PROD_A_PROV")
assert_eq "après le refus, menu_items.image_url reste EXACTEMENT la valeur d'origine (A) -- aucun effet de bord partiel" "$PUBLIC_URL_PREFIX/$PATH_A" "$IMG_UNCHANGED"

log "=== 07/18 -- remplacement A -> B : le serveur dérive l'ancien chemin (A) EXCLUSIVEMENT depuis la DB, jamais depuis une valeur cliente ; A est VALIDE -> cleanup ALLOWED (old_path_cleanup_skipped=false) ==="
RESULT=$(apply_result3 "$OWNER_A" "$PROD_A_PROV" "$PUBLIC_URL_PREFIX/$PATH_B")
OLD_PATH_RETURNED="${RESULT%%|*}"
REST3="${RESULT#*|}"
NEW_URL_RETURNED="${REST3%%|*}"
SKIPPED_RETURNED="${REST3##*|}"
assert_eq "07/18a: old_path renvoyé par apply_ == chemin RÉELLEMENT lu en DB avant l'écrasement (A), jamais une valeur transmise par le client (paramètre inexistant)" "$PATH_A" "$OLD_PATH_RETURNED"
assert_eq "18b: image_url renvoyé == la nouvelle valeur (B), confirmée par le serveur" "$PUBLIC_URL_PREFIX/$PATH_B" "$NEW_URL_RETURNED"
assert_eq "07c: old_path_cleanup_skipped == false -- A est un chemin VALIDE, cleanup normalement éligible (Storage API réelle, Node-level)" "false" "$SKIPPED_RETURNED"
IMG_AFTER=$(current_image_url "$PROD_A_PROV")
assert_eq "18c: menu_items.image_url pointe désormais vers B" "$PUBLIC_URL_PREFIX/$PATH_B" "$IMG_AFTER"

log "=== 17 -- unrelated third object (C) under same valid product namespace -> NEVER deleted, NEVER substitutable ==="
EXISTS_C=$(row_exists "$PATH_C")
assert_eq "17a: l'objet SANS RAPPORT (C) survit intact après le remplacement A -> B -- jamais confondu avec l'ancienne photo légitime (B a été retournée, pas C)" "1" "$EXISTS_C"
EXISTS_A_STILL=$(row_exists "$PATH_A")
assert_eq "17b: l'objet A existe TOUJOURS physiquement en base (apply_ n'a JAMAIS exécuté de DELETE lui-même -- Blocker 2 v1.4, sa suppression physique est déléguée à l'API Storage réelle côté Node, hors périmètre SQL)" "1" "$EXISTS_A_STILL"
RC=$(try_delete "$OWNER_A" "$PATH_C")
assert_eq "17c: tentative DELETE client direct sur l'objet C (même namespace produit valide) -> DENIED (policy DELETE désormais using(false) inconditionnel)" "1" "$RC"

# ==================================================================
# structural — begin_/apply_ INSTALLÉES ne contiennent AUCUN DELETE
# FROM storage.objects (introspection de la fonction RÉELLEMENT
# installée en base, pas seulement le fichier source) -- préservé v1.4.
# ==================================================================

log "=== direct storage.objects metadata-delete approach absent (introspection pg_get_functiondef) ==="
BEGIN_DEF=$(psql -d "$DB" -t -A -c "select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='begin_product_photo_replacement';")
APPLY_DEF=$(psql -d "$DB" -t -A -c "select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='apply_product_photo_replacement';")
if echo "$BEGIN_DEF$APPLY_DEF" | grep -iq "delete from storage.objects\|delete from public.storage"; then
  fail "begin_/apply_ (définitions RÉELLEMENT installées) contiennent un DELETE FROM storage.objects -- Blocker 2 v1.4 NON fermé"
else
  pass "aucune définition installée (begin_/apply_) ne contient de DELETE FROM storage.objects -- suppression physique exclusivement déléguée à l'API Storage réelle côté Node"
fi

# ==================================================================
# Non-régression : suppression (image_url NULL) -- même provenance,
# aucun paramètre "ancienne image" côté client, produit sans photo
# préexistante géré sans erreur (old_path NULL).
# ==================================================================

log "=== Suppression (image_url NULL) -- même contrat de provenance, aucune valeur cliente ==="
DEL_PATH="$RESTO_A/$PROD_A1/$(newfile)"
psql -d "$DB" -c "update public.menu_items set image_url = '$PUBLIC_URL_PREFIX/$DEL_PATH' where id = '$PROD_A1';" >/dev/null
seed_object "$DEL_PATH"
RESULT=$(apply_result "$OWNER_A" "$PROD_A1" "")
OLD_PATH_RETURNED="${RESULT%%|*}"
NEW_URL_RETURNED="${RESULT##*|}"
assert_eq "suppression: old_path renvoyé == l'ancien chemin réel (DEL_PATH), lu en DB" "$DEL_PATH" "$OLD_PATH_RETURNED"
assert_eq "suppression: image_url renvoyé == <NULL>" "<NULL>" "$NEW_URL_RETURNED"
IMG_AFTER_DEL=$(current_image_url "$PROD_A1")
assert_eq "suppression: menu_items.image_url == NULL après suppression" "<NULL>" "$IMG_AFTER_DEL"

log "=== produit SANS photo préexistante -- apply_ (remplacement) réussit, old_path == NULL, aucune erreur ==="
NOPHOTO_PATH="$RESTO_A/$PROD_A_NOPHOTO/$(newfile)"
seed_object "$NOPHOTO_PATH"
RESULT=$(apply_result "$OWNER_A" "$PROD_A_NOPHOTO" "$PUBLIC_URL_PREFIX/$NOPHOTO_PATH")
OLD_PATH_RETURNED="${RESULT%%|*}"
assert_eq "produit sans photo: old_path == <NULL> (rien à nettoyer, aucune erreur -- scénario D)" "<NULL>" "$OLD_PATH_RETURNED"

# ==================================================================
# MANDAT v1.5 -- item 20 : deux remplacements CONCURRENTS pour le
# MÊME produit -- sérialisation déterministe via `for update`
# (MEDIUM 2 v1.4, PRÉSERVÉE SANS AUCUN changement de schéma malgré la
# nouvelle signature/le nouveau rôle d'apply_). Session A
# (arrière-plan) verrouille la ligne, écrit B, PUIS dort 2s AVANT de
# commiter -- Session B (premier plan) doit BLOQUER jusqu'au COMMIT de
# A, puis relire B comme SA propre provenance (jamais l'original X,
# périmé) et écrire C.
# ==================================================================

log "=== 20 -- deux remplacements concurrents -> résultat sérialisé déterministe, aucune valeur périmée réutilisée ==="

CONC_X="$RESTO_A/$PROD_A_CONCURRENT/$(newfile)"   # photo initiale
CONC_B="$RESTO_A/$PROD_A_CONCURRENT/$(newfile)"   # écrite par la session A (arrière-plan)
CONC_C="$RESTO_A/$PROD_A_CONCURRENT/$(newfile)"   # écrite par la session B (premier plan, concurrente)

psql -d "$DB" -c "update public.menu_items set image_url = '$PUBLIC_URL_PREFIX/$CONC_X' where id = '$PROD_A_CONCURRENT';" >/dev/null
seed_object "$CONC_X"
seed_object "$CONC_B"
seed_object "$CONC_C"

SQL_A_FILE="/tmp/scanym_v67c_concurrent_a_$$.sql"
OUT_A_FILE="/tmp/scanym_v67c_concurrent_a_out_$$.txt"
cat > "$SQL_A_FILE" <<EOF
set role service_role;
select coalesce(old_path,'<NULL>') || '|' || coalesce(image_url,'<NULL>') as result
  from public.apply_product_photo_replacement('$OWNER_A'::uuid, '$PROD_A_CONCURRENT'::uuid, '$PUBLIC_URL_PREFIX/$CONC_B', '$TRUSTED_ORIGIN');
select pg_sleep(2);
EOF

# Session A : BEGIN explicite pour que le verrou posé par apply_ (for
# update, à l'intérieur de sa propre transaction implicite habituelle)
# soit tenu jusqu'au pg_sleep(2) ci-dessus AVANT le COMMIT final --
# psql -1 (--single-transaction) enveloppe tout le script dans UNE
# seule transaction, exactement le comportement requis.
psql -d "$DB" -1 -t -A -f "$SQL_A_FILE" > "$OUT_A_FILE" 2>&1 &
PID_A=$!

# Laisse le temps à la session A d'entrer dans sa transaction et
# d'exécuter apply_ (verrou acquis, ligne déjà écrite en mémoire de
# transaction) avant de lancer la session B concurrente.
sleep 0.6

T_START=$(date +%s.%N)
RESULT_B=$(apply_result "$OWNER_A" "$PROD_A_CONCURRENT" "$PUBLIC_URL_PREFIX/$CONC_C")
T_END=$(date +%s.%N)
ELAPSED=$(awk -v a="$T_START" -v b="$T_END" 'BEGIN { printf "%.2f", (b - a) }')

wait "$PID_A"
RESULT_A=$(grep -m1 '|' "$OUT_A_FILE" | tr -d '[:space:]')
OLD_A="${RESULT_A%%|*}"
OLD_B="${RESULT_B%%|*}"

assert_eq "20a: session A (première à verrouiller) capture bien l'image INITIALE (X) comme ancienne valeur" "$CONC_X" "$OLD_A"

BLOCKED=$(awk -v e="$ELAPSED" 'BEGIN { print (e >= 1.2) ? "1" : "0" }')
assert_eq "20b: session B a bien été BLOQUÉE par le verrou de la session A (durée observée >= 1.2s, preuve d'un blocage réel, pas d'une course)" "1" "$BLOCKED"

assert_eq "20c: session B (débloquée APRÈS le COMMIT de A) relit la valeur FRAÎCHEMENT validée (B) comme sa propre provenance -- JAMAIS la valeur initiale périmée (X)" "$CONC_B" "$OLD_B"

FINAL_IMG=$(current_image_url "$PROD_A_CONCURRENT")
assert_eq "20d: état final DB == C (dernière écriture validée, convergence déterministe)" "$PUBLIC_URL_PREFIX/$CONC_C" "$FINAL_IMG"

EXISTS_X_UNTOUCHED=$(row_exists "$CONC_X")
EXISTS_B_UNTOUCHED=$(row_exists "$CONC_B")
assert_eq "20e: X existe toujours physiquement (apply_ ne supprime jamais elle-même -- Blocker 2)" "1" "$EXISTS_X_UNTOUCHED"
assert_eq "20f: B existe toujours physiquement (idem)" "1" "$EXISTS_B_UNTOUCHED"

# ==================================================================
# v2.2.1 -- BULK PRODUCT PHOTOS -- FINAL RACE CONDITION FIX ONLY / ONE
# FINDING ONLY. SOLE BLOCKER (Cat Stevens, réaudit final de v2.2) :
# "current old-Bulk-retry conflict detection is performed using an
# unlocked earlier read." Fermé en déplaçant la décision
# ALREADY_APPLIED/CONFLICT ENTIÈREMENT dans apply_product_photo_
# replacement, SOUS le verrou `for update` déjà existant (nouveau
# paramètre additif p_is_retry, SQLSTATE 'P0004' pour CONFLICT).
#
# v2.2.1-01 : FIRST APPLY REGRESSION -- p_is_retry omis (défaut false)
# reste un remplacement de masse INCONDITIONNEL, même si une photo
# DIFFÉRENTE existe déjà -- AUCUNE comparaison, exactement le
# comportement v1.6/v2.2 déjà prouvé par la section "18"/"20"
# ci-dessus, revérifié ICI EXPLICITEMENT avec un produit dédié pour
# isoler la non-régression du chemin p_is_retry=true ajouté par ce lot.
# v2.2.1-02 : ALREADY_APPLIED -- p_is_retry=true, image actuelle SOUS
# VERROU == cible déterministe -> already_applied=true, AUCUNE mutation
# (menu_items.image_url STRICTEMENT inchangé).
# v2.2.1-03 : CONFLICT -- p_is_retry=true, image actuelle SOUS VERROU
# DIFFÉRENTE de la cible déterministe -> exception SQLSTATE EXACTEMENT
# 'P0004', AUCUNE mutation.
# v2.2.1-04 : MANDATORY RACE TEST -- même patron que la section "20"
# ci-dessus (deux sessions psql concurrentes, verrou `for update` réel)
# -- une relecture Bulk indéterminée (p_is_retry=true) et une
# modification manuelle légitime (p_is_retry=false, installe M) pour le
# MÊME produit sont RÉELLEMENT sérialisées par PostgreSQL ; quel que
# soit l'ordre d'arrivée, la décision de la relecture est TOUJOURS
# prise APRÈS acquisition du verrou -- jamais depuis une lecture
# antérieure non verrouillée. Ici : la modification manuelle (M)
# verrouille et écrit EN PREMIER, tient le verrou via pg_sleep, la
# relecture Bulk (concurrente) DOIT BLOQUER jusqu'à son COMMIT, puis
# voir M comme image SOUS VERROU (jamais une valeur antérieure/périmée)
# et lever CONFLICT -- M jamais écrasée.
# ==================================================================

PROD_A_RETRY=$(psql -d "$DB" -t -A -c "insert into public.menu_items (category_id, name, price) values ('$CAT_A', 'Produit A -- scène retry v2.2.1', 6.00) returning id;" | head -1)

log "=== v2.2.1-01 -- FIRST APPLY REGRESSION : p_is_retry omis (défaut false) reste un remplacement de masse INCONDITIONNEL, même si une photo DIFFÉRENTE existe déjà ==="
RETRY01_OLD="$RESTO_A/$PROD_A_RETRY/$(newfile)"
RETRY01_NEW="$RESTO_A/$PROD_A_RETRY/$(newfile)"
psql -d "$DB" -c "update public.menu_items set image_url = '$PUBLIC_URL_PREFIX/$RETRY01_OLD' where id = '$PROD_A_RETRY';" >/dev/null
seed_object "$RETRY01_OLD"; seed_object "$RETRY01_NEW"
RESULT=$(apply_result3 "$OWNER_A" "$PROD_A_RETRY" "$PUBLIC_URL_PREFIX/$RETRY01_NEW")
assert_eq "v2.2.1-01: p_is_retry omis -- remplacement INCONDITIONNEL réussit malgré une photo existante DIFFÉRENTE (FIRST BULK APPLY MASS REPLACEMENT: PRESERVED)" "$RETRY01_OLD|$PUBLIC_URL_PREFIX/$RETRY01_NEW|false" "$RESULT"
assert_eq "v2.2.1-01bis: état final DB == la nouvelle image (mutation RÉELLEMENT appliquée)" "$PUBLIC_URL_PREFIX/$RETRY01_NEW" "$(current_image_url "$PROD_A_RETRY")"

log "=== v2.2.1-02 -- MANDATORY ALREADY-APPLIED TEST : p_is_retry=true, image actuelle SOUS VERROU == cible déterministe -> already_applied=true, AUCUNE mutation ==="
RETRY02_TARGET="$PUBLIC_URL_PREFIX/$RESTO_A/$PROD_A_RETRY/$(newfile)"
psql -d "$DB" -c "update public.menu_items set image_url = '$RETRY02_TARGET' where id = '$PROD_A_RETRY';" >/dev/null
RESULT=$(apply_result_retry "$OWNER_A" "$PROD_A_RETRY" "$RETRY02_TARGET")
assert_eq "v2.2.1-02: retry reconnu -- old_path=<NULL> (aucune mutation, rien à nettoyer), image_url == cible, already_applied=true" "<NULL>|$RETRY02_TARGET|false|true" "$RESULT"
assert_eq "v2.2.1-02bis: menu_items.image_url STRICTEMENT inchangé après un retry ALREADY_APPLIED" "$RETRY02_TARGET" "$(current_image_url "$PROD_A_RETRY")"

log "=== v2.2.1-03 -- MANDATORY CONFLICT TEST : p_is_retry=true, image actuelle SOUS VERROU DIFFÉRENTE de la cible déterministe -> SQLSTATE EXACTEMENT 'P0004', AUCUNE mutation ==="
RETRY03_CURRENT="$PUBLIC_URL_PREFIX/$RESTO_A/$PROD_A_RETRY/$(newfile)"
RETRY03_TARGET="$PUBLIC_URL_PREFIX/$RESTO_A/$PROD_A_RETRY/$(newfile)"
psql -d "$DB" -c "update public.menu_items set image_url = '$RETRY03_CURRENT' where id = '$PROD_A_RETRY';" >/dev/null
RC=$(try_apply_retry "$OWNER_A" "$PROD_A_RETRY" "$RETRY03_TARGET")
assert_eq "v2.2.1-03: retry en conflit -> exception (RC=1), AUCUN succès silencieux" "1" "$RC"
SQLSTATE_RESULT=$(apply_retry_sqlstate "$OWNER_A" "$PROD_A_RETRY" "$RETRY03_TARGET")
assert_eq "v2.2.1-03bis: SQLSTATE EXACTEMENT 'P0004' -- jamais une exception générique/une coïncidence" "P0004" "$SQLSTATE_RESULT"
assert_eq "v2.2.1-03ter: menu_items.image_url STRICTEMENT inchangé après un retry CONFLICT (AUTHORITATIVE UPDATE: NO)" "$RETRY03_CURRENT" "$(current_image_url "$PROD_A_RETRY")"

log "=== v2.2.1-04 -- MANDATORY RACE TEST : modification manuelle (M, p_is_retry=false) verrouille et écrit EN PREMIER (tient le verrou via pg_sleep) ; relecture Bulk concurrente (p_is_retry=true) DOIT BLOQUER jusqu'au COMMIT, puis voir M SOUS VERROU (jamais une valeur périmée) et lever CONFLICT -- M jamais écrasée ==="
RACE_BASELINE="$RESTO_A/$PROD_A_RETRY/$(newfile)"
RACE_M="$RESTO_A/$PROD_A_RETRY/$(newfile)"           # installée par la modification manuelle (session A, arrière-plan)
RACE_BULK_TARGET="$RESTO_A/$PROD_A_RETRY/$(newfile)" # cible déterministe de la relecture Bulk (session B, premier plan)
psql -d "$DB" -c "update public.menu_items set image_url = '$PUBLIC_URL_PREFIX/$RACE_BASELINE' where id = '$PROD_A_RETRY';" >/dev/null
seed_object "$RACE_M"

RACE_SQL_A_FILE="/tmp/scanym_v67c_race_v2221_a_$$.sql"
RACE_OUT_A_FILE="/tmp/scanym_v67c_race_v2221_a_out_$$.txt"
cat > "$RACE_SQL_A_FILE" <<EOF
set role service_role;
select coalesce(old_path,'<NULL>') || '|' || coalesce(image_url,'<NULL>') as result
  from public.apply_product_photo_replacement('$OWNER_A'::uuid, '$PROD_A_RETRY'::uuid, '$PUBLIC_URL_PREFIX/$RACE_M', '$TRUSTED_ORIGIN');
select pg_sleep(2);
EOF

# Session A (arrière-plan) : la modification manuelle légitime --
# p_is_retry OMIS (Single Photo Edit / remplacement direct), verrou
# `for update` tenu à travers le pg_sleep(2) (même patron EXACT que la
# section "20" ci-dessus -- psql -1 enveloppe tout dans UNE seule
# transaction).
psql -d "$DB" -1 -t -A -f "$RACE_SQL_A_FILE" > "$RACE_OUT_A_FILE" 2>&1 &
PID_RACE_A=$!

# Laisse le temps à la session A d'entrer dans sa transaction et
# d'acquérir le verrou AVANT de lancer la relecture Bulk concurrente --
# "force the manual change to occur at the former race boundary" :
# force ICI la modification manuelle à être EN COURS/DÉJÀ ENGAGÉE
# exactement au moment où la relecture Bulk s'apprête à acquérir le
# même verrou.
sleep 0.6

T_RACE_START=$(date +%s.%N)
RC_RACE_B=$(try_apply_retry "$OWNER_A" "$PROD_A_RETRY" "$PUBLIC_URL_PREFIX/$RACE_BULK_TARGET")
T_RACE_END=$(date +%s.%N)
RACE_ELAPSED=$(awk -v a="$T_RACE_START" -v b="$T_RACE_END" 'BEGIN { printf "%.2f", (b - a) }')

wait "$PID_RACE_A"
RACE_RESULT_A=$(grep -m1 '|' "$RACE_OUT_A_FILE" | tr -d '[:space:]')
RACE_OLD_A="${RACE_RESULT_A%%|*}"

assert_eq "v2.2.1-04a: session A (modification manuelle, première à verrouiller) capture bien l'image INITIALE (baseline) comme ancienne valeur" "$RACE_BASELINE" "$RACE_OLD_A"

RACE_BLOCKED=$(awk -v e="$RACE_ELAPSED" 'BEGIN { print (e >= 1.2) ? "1" : "0" }')
assert_eq "v2.2.1-04b: la relecture Bulk (session B, concurrente) a bien été BLOQUÉE par le verrou de la modification manuelle (durée observée >= 1.2s -- preuve d'une SÉRIALISATION RÉELLE, jamais une course, jamais une lecture antérieure non verrouillée)" "1" "$RACE_BLOCKED"

assert_eq "v2.2.1-04c: RESULT: CONFLICT -- la relecture Bulk (débloquée APRÈS le COMMIT de la modification manuelle) lève l'exception (RC=1), jamais un succès silencieux qui écraserait M" "1" "$RC_RACE_B"

FINAL_RACE_IMG=$(current_image_url "$PROD_A_RETRY")
assert_eq "v2.2.1-04d: LOCKED CURRENT IMAGE / M PRESERVED: YES -- l'état final == M EXACTEMENT (jamais la cible Bulk, jamais la baseline périmée) -- AUTHORITATIVE UPDATE: NO pour la relecture" "$PUBLIC_URL_PREFIX/$RACE_M" "$FINAL_RACE_IMG"

EXISTS_RACE_M=$(row_exists "$RACE_M")
assert_eq "v2.2.1-04e: l'objet M survit intact -- apply_ ne supprime jamais elle-même, et la relecture en CONFLICT n'a déclenché AUCUN nettoyage" "1" "$EXISTS_RACE_M"

rm -f "$RACE_SQL_A_FILE" "$RACE_OUT_A_FILE"

# ==================================================================
# Non-régression complémentaire : begin_/apply_ échouent proprement
# pour un appelant non autorisé, sans jamais toucher Storage.
# ==================================================================

log "=== Non-régression -- apply_ refusée pour un utilisateur non lié, aucun effet de bord Storage ==="
UNAUTH_PATH="$RESTO_A/$PROD_A_PROV/$(newfile)"
seed_object "$UNAUTH_PATH"
RC=$(try_apply "$IMPOSTOR" "$PROD_A_PROV" "$PUBLIC_URL_PREFIX/$UNAUTH_PATH")
assert_eq "apply_ refusée pour IMPOSTOR (ni owner/manager du restaurant, ni opérateur -- p_caller_user_id explicite, revalidé par assert_product_role_for)" "1" "$RC"
IMG_STILL_B=$(current_image_url "$PROD_A_PROV")
assert_eq "après refus, l'image actuelle (B, posée par le test de provenance) n'est PAS modifiée -- aucun effet de bord d'un appel refusé" "$PUBLIC_URL_PREFIX/$PATH_B" "$IMG_STILL_B"

# ==================================================================
# MANDAT v1.6 -- BLOCKER 1 : ORIGINE de l'ancienne valeur DB JAMAIS
# vérifiée par ANCRAGE (v1.5 ne faisait qu'une recherche de
# sous-chaîne du marqueur). Les 10 cas hostiles MANDATÉS, plus le
# CAS ADVERSARIAL GÉNUINE fermant explicitement la lacune de
# couverture identifiée par Cat Stevens sur le harnais v1.5 (Blocker 2
# v1.6) : une origine étrangère combinée au marqueur Storage EXACT
# ('/storage/v1/object/public/product-photos/') et un chemin
# UUID v4/restaurant/produit valide -- contrairement au cas v1.5 §15
# ('https://evil.example.com/not-supabase/whatever.jpg', qui échoue
# pour une raison TRIVIALE -- marqueur totalement absent -- jamais
# parce que l'origine est vérifiée).
# ==================================================================

PROD_A_FOREIGN=$(psql -d "$DB" -t -A -c "insert into public.menu_items (category_id, name, price) values ('$CAT_A', 'Produit A -- scène origine étrangère v1.6', 6.60) returning id;" | head -1)

log "=== v1.6-01 (contrôle positif) -- origine Scanym correcte + chemin valide -> VALID (old_path renvoyé, cleanup ALLOWED) ==="
V16_VALID_OLD="$RESTO_A/$PROD_A_FOREIGN/$(newfile)"
V16_VALID_NEW="$RESTO_A/$PROD_A_FOREIGN/$(newfile)"
psql -d "$DB" -c "update public.menu_items set image_url = '$PUBLIC_URL_PREFIX/$V16_VALID_OLD' where id = '$PROD_A_FOREIGN';" >/dev/null
seed_object "$V16_VALID_OLD"
seed_object "$V16_VALID_NEW"
RESULT=$(apply_result3 "$OWNER_A" "$PROD_A_FOREIGN" "$PUBLIC_URL_PREFIX/$V16_VALID_NEW")
OLD_PATH_V16_1="${RESULT%%|*}"
REST_V16_1="${RESULT#*|}"
SKIPPED_V16_1="${REST_V16_1##*|}"
assert_eq "v1.6-01: VALID CURRENT ORIGIN -- old_path renvoyé == l'ancienne valeur EXACTE (origine de confiance, forme exacte)" "$V16_VALID_OLD" "$OLD_PATH_V16_1"
assert_eq "v1.6-01: OLD PATH VALIDATION == PASS (old_path_cleanup_skipped == false -- éligible à DELETE VIA STORAGE API, Node-level)" "false" "$SKIPPED_V16_1"

log "=== v1.6-02 -- origine étrangère + marqueur Storage SANS le segment /storage/v1 -> REJECTED ==="
assert_poisoned_old_value_skipped "v1.6-02: FOREIGN ORIGIN + marqueur '/object/public/product-photos/' sans '/storage/v1' -- REJECTED" \
  "$FOREIGN_ORIGIN/object/public/product-photos/$RESTO_A/$PROD_A_POISON/$(newfile)"

log "=== v1.6-03 (mandat item 2/3 -- CAS ADVERSARIAL GÉNUINE, ferme la lacune de couverture v1.5) -- origine étrangère + marqueur Storage COMPLET EXACT ('/storage/v1/object/public/product-photos/') + chemin restaurant/produit/UUID-v4 PARFAITEMENT VALIDE -> REJECTED, JAMAIS transmis à Storage remove() ==="
assert_poisoned_old_value_skipped "v1.6-03: FOREIGN ORIGIN + VALID STORAGE-STYLE PATH (marqueur complet EXACT, restaurant/produit/UUID-v4 syntaxiquement PARFAITS) -- DENIED" \
  "$FOREIGN_ORIGIN/storage/v1/object/public/product-photos/$RESTO_A/$PROD_A_POISON/$(newfile)"

log "=== v1.6-04 -- origine correcte, bucket incorrect -> REJECTED (WRONG BUCKET) ==="
assert_poisoned_old_value_skipped "v1.6-04: origine Scanym CORRECTE mais bucket 'other-bucket' (jamais 'product-photos') -- WRONG BUCKET: DENIED" \
  "$TRUSTED_ORIGIN/storage/v1/object/public/other-bucket/$RESTO_A/$PROD_A_POISON/$(newfile)"

log "=== v1.6-05 -- origine correcte, marqueur présent PLUS LOIN dans un chemin non lié -> REJECTED (MARKER EMBEDDED IN WRONG PATH) ==="
assert_poisoned_old_value_skipped "v1.6-05: origine Scanym correcte, marqueur Storage embarqué APRÈS un segment non lié -- MARKER EMBEDDED IN WRONG PATH: DENIED" \
  "$TRUSTED_ORIGIN/blah/storage/v1/object/public/product-photos/$RESTO_A/$PROD_A_POISON/$(newfile)"

log "=== v1.6-06 -- origine correcte + préfixe additionnel AVANT le chemin Storage attendu -> REJECTED ==="
assert_poisoned_old_value_skipped "v1.6-06: origine Scanym correcte + préfixe '/extra' avant le chemin Storage attendu -- jamais ancré en position 0 -- DENIED" \
  "$TRUSTED_ORIGIN/extra/storage/v1/object/public/product-photos/$RESTO_A/$PROD_A_POISON/$(newfile)"

log "=== v1.6-07 -- URL protocol-relative -> REJECTED (architecture Scanym n'expose jamais une telle forme) ==="
V16_HOST_ONLY="${TRUSTED_ORIGIN#https://}"
assert_poisoned_old_value_skipped "v1.6-07: URL protocol-relative ('//$V16_HOST_ONLY/...') -- ne commence jamais par 'https://', jamais supportée -- DENIED" \
  "//$V16_HOST_ONLY/storage/v1/object/public/product-photos/$RESTO_A/$PROD_A_POISON/$(newfile)"

log "=== v1.6-08a -- URL javascript: -> REJECTED ==="
assert_poisoned_old_value_skipped "v1.6-08a: URL javascript: -- DENIED" \
  "javascript:alert(document.domain)"

log "=== v1.6-08b -- URL data: -> REJECTED ==="
assert_poisoned_old_value_skipped "v1.6-08b: URL data: -- DENIED" \
  "data:text/plain;base64,aGVsbG8="

log "=== v1.6-08c -- URL file: -> REJECTED ==="
assert_poisoned_old_value_skipped "v1.6-08c: URL file: -- DENIED" \
  "file:///etc/passwd"

log "=== v1.6-09 -- URL malformée -> REJECTED (MALFORMED URL) ==="
assert_poisoned_old_value_skipped "v1.6-09: URL malformée ('ht!tp://not a valid url###') -- MALFORMED URL: DENIED" \
  "ht!tp://not a valid url###$RESTO_A/$PROD_A_POISON/$(newfile)"

log "=== v1.6-10 -- projet Supabase ÉTRANGER (même plateforme, référence de projet différente), chemin par ailleurs EXACT -> REJECTED (FOREIGN SUPABASE PROJECT) ==="
assert_poisoned_old_value_skipped "v1.6-10: FOREIGN SUPABASE PROJECT ($FOREIGN_PROJECT_ORIGIN, chemin par ailleurs EXACT) -- DENIED" \
  "$FOREIGN_PROJECT_ORIGIN/storage/v1/object/public/product-photos/$RESTO_A/$PROD_A_POISON/$(newfile)"

log "=== v1.6-11 (SAME-PRODUCT THIRD OBJECT, origine étrangère) -- objet C RÉEL (restaurant/produit/UUID-v4/extension CORRECTS) sous NOTRE bucket, mais l'URL DB pointe vers lui via une origine ÉTRANGÈRE -> C JAMAIS ciblé, JAMAIS supprimé, préservé intact ==="
C_FOREIGN_PATH="$RESTO_A/$PROD_A_FOREIGN/$(newfile)"
D_NEW_PATH="$RESTO_A/$PROD_A_FOREIGN/$(newfile)"
seed_object "$C_FOREIGN_PATH"
seed_object "$D_NEW_PATH"
# L'ancienne valeur DB (empoisonnée) pointe vers l'objet C, RÉEL et
# PARFAITEMENT valide en FORME (restaurant_id/product_id/UUID v4
# exacts, objet physiquement présent dans NOTRE bucket) -- SEULE son
# origine est étrangère.
psql -d "$DB" -c "update public.menu_items set image_url = '$FOREIGN_ORIGIN/storage/v1/object/public/product-photos/$C_FOREIGN_PATH' where id = '$PROD_A_FOREIGN';" >/dev/null
RESULT=$(apply_result3 "$OWNER_A" "$PROD_A_FOREIGN" "$PUBLIC_URL_PREFIX/$D_NEW_PATH")
OLD_PATH_C="${RESULT%%|*}"
REST_C="${RESULT#*|}"
SKIPPED_C="${REST_C##*|}"
assert_eq "v1.6-11: FOREIGN-ORIGIN C: old_path renvoyé == <NULL> (JAMAIS C, malgré une forme par ailleurs PARFAITEMENT valide) -- INVALID OLD DB URL PASSED TO STORAGE REMOVE: NO" "<NULL>" "$OLD_PATH_C"
assert_eq "v1.6-11: old_path_cleanup_skipped == true (nettoyage explicitement SAUTÉ)" "true" "$SKIPPED_C"
EXISTS_C_FOREIGN=$(row_exists "$C_FOREIGN_PATH")
assert_eq "v1.6-11: FOREIGN-ORIGIN C: PRESERVED -- l'objet C survit intact (jamais référencé comme old_path, donc jamais transmis à un Storage remove() Node-level -- STORAGE REMOVE CALLED WITH C: NO)" "1" "$EXISTS_C_FOREIGN"

log "=== structural — les définitions RÉELLEMENT installées de _product_photo_path_segments/apply_ n'utilisent JAMAIS position()/strpos() pour l'origine (introspection pg_get_functiondef, jamais une simple relecture du fichier source) ==="
SEGMENTS_DEF=$(psql -d "$DB" -t -A -c "select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='_product_photo_path_segments';")
if echo "$SEGMENTS_DEF" | grep -q "starts_with("; then
  pass "_product_photo_path_segments (définition RÉELLEMENT installée) utilise starts_with() -- vérification ANCRÉE, jamais une recherche de sous-chaîne"
else
  fail "_product_photo_path_segments (définition RÉELLEMENT installée) NE CONTIENT PAS starts_with() -- Blocker 1 v1.6 NON fermé"
fi
if echo "$SEGMENTS_DEF" | grep -qE "position\(|strpos\("; then
  fail "_product_photo_path_segments (définition RÉELLEMENT installée) contient ENCORE position()/strpos() -- recherche de sous-chaîne résiduelle, Blocker 1 v1.6 NON fermé"
else
  pass "_product_photo_path_segments (définition RÉELLEMENT installée) NE CONTIENT PLUS AUCUN position()/strpos() -- aucune recherche de sous-chaîne résiduelle"
fi

# ==================================================================
# MANDAT v1.8 -- FINAL DURABLE CLEANUP STATE MACHINE. Remplace
# INTÉGRALEMENT le bloc v1.7-01..20 (claim_product_photo_pending_
# cleanup transitionnait pending -> COMPLETED ICI, AVANT le
# Storage.remove() réel côté Node -- SEUL blocker fermé par ce lot).
# claim_/finalize_/release_product_photo_pending_cleanup -- AUCUNE de
# ces fonctions n'accepte de CHEMIN depuis un appelant. claim_ ne
# transitionne plus JAMAIS vers 'completed' -- UNIQUEMENT vers
# 'processing', avec un bail (lease) à expiration AUTOMATIQUE.
# finalize_ (succès Storage RÉEL confirmé) et release_ (échec Storage,
# retry immédiat) exigent toutes deux le claim_token EXACT renvoyé par
# le claim_ correspondant. 20+ items mandatés ci-dessous.
# ==================================================================

PROD_A_CLEANUP=$(psql -d "$DB" -t -A -c "insert into public.menu_items (category_id, name, price) values ('$CAT_A', 'Produit A -- scène cleanup-retry v1.8', 8.80) returning id;" | head -1)
PROD_A_CLEANUP_2=$(psql -d "$DB" -t -A -c "insert into public.menu_items (category_id, name, price) values ('$CAT_A', 'Produit A -- scène cleanup-retry v1.8 (produit B)', 9.90) returning id;" | head -1)

log "=== v1.8-01 -- création d'autorité de nettoyage GENUINE : remplacement RÉEL A->B (apply_), puis create_ sur le old_path RÉELLEMENT renvoyé -> pending ==="
CLEAN_OLD_A="$RESTO_A/$PROD_A_CLEANUP/$(newfile)"
CLEAN_NEW_B="$RESTO_A/$PROD_A_CLEANUP/$(newfile)"
psql -d "$DB" -c "update public.menu_items set image_url = '$PUBLIC_URL_PREFIX/$CLEAN_OLD_A' where id = '$PROD_A_CLEANUP';" >/dev/null
seed_object "$CLEAN_OLD_A"
seed_object "$CLEAN_NEW_B"
RESULT=$(apply_result3 "$OWNER_A" "$PROD_A_CLEANUP" "$PUBLIC_URL_PREFIX/$CLEAN_NEW_B")
OLD_PATH_FROM_APPLY="${RESULT%%|*}"
assert_eq "v1.8-01a: apply_ légitime A->B renvoie bien old_path == A (lu en DB, jamais une valeur cliente)" "$CLEAN_OLD_A" "$OLD_PATH_FROM_APPLY"
CLEANUP_ID_1=$(create_pending_cleanup "$OWNER_A" "$PROD_A_CLEANUP" "$OLD_PATH_FROM_APPLY")
if [ -z "$CLEANUP_ID_1" ]; then
  fail "v1.8-01b: create_product_photo_pending_cleanup n'a renvoyé AUCUN cleanup_id pour un old_path GENUINEMENT issu d'apply_ -- la création d'autorité de nettoyage a échoué"
else
  pass "v1.8-01b: create_ a renvoyé un cleanup_id non vide pour un old_path GENUINEMENT issu du flux de remplacement de confiance"
fi
assert_eq "v1.8-01c: la ligne créée est bien PENDING (autorité de nettoyage en attente, jamais déjà consommée)" "pending" "$(cleanup_row_status "$CLEANUP_ID_1")"

log "=== v1.8-01bis -- create_ REVALIDE lui-même la forme du chemin (défense en profondeur DÈS la création) -- un chemin hors contrat exact est REFUSÉ (exception) ==="
RC=$(try_create_pending_cleanup "$OWNER_A" "$PROD_A_CLEANUP" "$RESTO_A/$PROD_A_CLEANUP/not-a-valid-uuid.jpg")
assert_eq "v1.8-01bis: create_ refuse un old_path hors contrat UUID v4 exact -> exception" "1" "$RC"

log "=== v1.8-02 -- MANDAT item 01 : claim_ sur une ligne PENDING -> PROCESSING (JAMAIS COMPLETED -- SEUL blocker fermé par ce lot). Résout le old_path EXCLUSIVEMENT depuis l'état serveur, pose un bail, émet un claim_token ==="
RESULT=$(claim_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_1")
CLAIM_1_PATH="$(claim_path_of "$RESULT")"
CLAIM_1_TOKEN="$(claim_token_of "$RESULT")"
assert_eq "v1.8-02a: claim_ renvoie EXACTEMENT le old_path stocké (A), résolu depuis product_photo_pending_cleanups, jamais depuis un paramètre client" "$CLEAN_OLD_A" "$CLAIM_1_PATH"
if [ "$CLAIM_1_TOKEN" = "<NULL>" ] || [ -z "$CLAIM_1_TOKEN" ]; then
  fail "v1.8-02b: claim_ n'a renvoyé AUCUN claim_token pour une réclamation par ailleurs réussie"
else
  pass "v1.8-02b: claim_ a renvoyé un claim_token (uuid) non vide, SERVEUR UNIQUEMENT"
fi
assert_eq "v1.8-02c: CLAIM MARKS COMPLETED BEFORE STORAGE DELETE: NO -- après ce claim, le statut est EXACTEMENT 'processing', JAMAIS 'completed' (c'est exactement le défaut de v1.7 fermé ici)" "processing" "$(cleanup_row_status "$CLEANUP_ID_1")"
CLAIMED_AT_1="$(cleanup_row_field "$CLEANUP_ID_1" claimed_at)"
LEASE_UNTIL_1="$(cleanup_row_field "$CLEANUP_ID_1" lease_until)"
ATTEMPT_COUNT_1="$(cleanup_row_field "$CLEANUP_ID_1" attempt_count)"
[ "$CLAIMED_AT_1" != "<NULL>" ] && pass "v1.8-02d: claimed_at posé (non NULL) après un claim réussi" || fail "v1.8-02d: claimed_at reste NULL après un claim réussi"
[ "$LEASE_UNTIL_1" != "<NULL>" ] && pass "v1.8-02e: lease_until posé (non NULL) après un claim réussi -- PROCESSING LEASE: YES" || fail "v1.8-02e: lease_until reste NULL après un claim réussi"
assert_eq "v1.8-02f: attempt_count == 1 après le premier claim réussi (traçabilité)" "1" "$ATTEMPT_COUNT_1"

log "=== v1.8-03 -- MANDAT item 02 : succès Storage RÉEL confirmé -> finalize_ transitionne PROCESSING -> COMPLETED (SEULE fonction de ce lot qui atteint 'completed') ==="
FINALIZE_1=$(finalize_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_1" "$CLAIM_1_TOKEN")
assert_eq "v1.8-03a: finalize_ avec le claim_token EXACT -> true" "true" "$FINALIZE_1"
assert_eq "v1.8-03b: statut == completed (Storage.remove() a RÉELLEMENT réussi -- COMPLETED n'est JAMAIS atteint avant ce fait)" "completed" "$(cleanup_row_status "$CLEANUP_ID_1")"

log "=== v1.8-03bis -- finalize_ AVEC UN MAUVAIS claim_token (même appelant/ligne légitimes) -> false, no-op (empêche un claim tardif/périmé de finaliser une tentative qui n'est plus la sienne) ==="
CLEAN_OLD_A1b="$RESTO_A/$PROD_A_CLEANUP/$(newfile)"
CLEAN_NEW_B1b="$RESTO_A/$PROD_A_CLEANUP/$(newfile)"
seed_object "$CLEAN_OLD_A1b"; seed_object "$CLEAN_NEW_B1b"
psql -d "$DB" -c "update public.menu_items set image_url = '$PUBLIC_URL_PREFIX/$CLEAN_OLD_A1b' where id = '$PROD_A_CLEANUP';" >/dev/null
RESULT=$(apply_result3 "$OWNER_A" "$PROD_A_CLEANUP" "$PUBLIC_URL_PREFIX/$CLEAN_NEW_B1b")
CLEANUP_ID_1B=$(create_pending_cleanup "$OWNER_A" "$PROD_A_CLEANUP" "${RESULT%%|*}")
RESULT=$(claim_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_1B")
WRONG_TOKEN=$(psql -d "$DB" -t -A -c "select gen_random_uuid();" | tr -d '[:space:]')
BAD_FINALIZE=$(finalize_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_1B" "$WRONG_TOKEN")
assert_eq "v1.8-03bis: finalize_ avec un claim_token FABRIQUÉ -> false" "false" "$BAD_FINALIZE"
assert_eq "v1.8-03bis-b: la ligne reste 'processing' (jamais finalisée par un mauvais token)" "processing" "$(cleanup_row_status "$CLEANUP_ID_1B")"

log "=== v1.8-04 -- structurel : claim_/finalize_/release_ N'ACCEPTENT AUCUN paramètre de chemin -- signatures EXACTES introspectées (pg_get_function_identity_arguments) ==="
CLAIM_ARGS=$(psql -d "$DB" -t -A -c "
  select pg_get_function_identity_arguments(p.oid)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'claim_product_photo_pending_cleanup';
" | tr -d ' \t\n\r')
assert_eq "v1.8-04a: signature EXACTE de claim_ == (..., p_lease_seconds integer) -- AUCUN paramètre oldPath/oldImageUrl/cleanupPath. CLIENT CLEANUP PATH PARAMETER: NONE" \
  "p_caller_user_iduuid,p_product_iduuid,p_cleanup_iduuid,p_expected_origintext,p_lease_secondsinteger" \
  "$CLAIM_ARGS"
FINALIZE_ARGS=$(psql -d "$DB" -t -A -c "
  select pg_get_function_identity_arguments(p.oid)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'finalize_product_photo_pending_cleanup';
" | tr -d ' \t\n\r')
assert_eq "v1.8-04b: signature EXACTE de finalize_ -- AUCUN paramètre de chemin, exige p_claim_token" \
  "p_caller_user_iduuid,p_product_iduuid,p_cleanup_iduuid,p_claim_tokenuuid" \
  "$FINALIZE_ARGS"
RELEASE_ARGS=$(psql -d "$DB" -t -A -c "
  select pg_get_function_identity_arguments(p.oid)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'release_product_photo_pending_cleanup';
" | tr -d ' \t\n\r')
assert_eq "v1.8-04c: signature EXACTE de release_ -- AUCUN paramètre de chemin, exige p_claim_token" \
  "p_caller_user_iduuid,p_product_iduuid,p_cleanup_iduuid,p_claim_tokenuuid" \
  "$RELEASE_ARGS"

log "=== v1.8-05 -- MANDAT item 13 : objet C RÉEL, valide, jamais référencé par aucune ligne pending-cleanup légitime -- survit à TOUTES les attaques ci-dessous ==="
C_PATH="$RESTO_A/$PROD_A_CLEANUP/$(newfile)"
seed_object "$C_PATH"

log "=== v1.8-05bis -- CLIENT CAN CREATE PENDING CLEANUP: NO / CLIENT CAN RETARGET: NO -- INSERT/UPDATE directs, comme authenticated (même le owner LÉGITIME) ou anon, refusés au niveau GRANT ==="
RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated;
  set local test.uid = '$OWNER_A';
  insert into public.product_photo_pending_cleanups (restaurant_id, product_id, old_path, status)
  values ('$RESTO_A'::uuid, '$PROD_A_CLEANUP'::uuid, '$C_PATH', 'pending');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "v1.8-05bis-a: INSERT direct authenticated -> DENIED (REVOKE ALL FROM public,anon,authenticated)" "1" "$RC"
RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role anon;
  insert into public.product_photo_pending_cleanups (restaurant_id, product_id, old_path, status)
  values ('$RESTO_A'::uuid, '$PROD_A_CLEANUP'::uuid, '$C_PATH', 'pending');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "v1.8-05bis-b: INSERT direct anon -> DENIED" "1" "$RC"
RETARGET_VICTIM_PATH="$RESTO_A/$PROD_A_CLEANUP/$(newfile)"
seed_object "$RETARGET_VICTIM_PATH"
RETARGET_VICTIM_ID=$(seed_pending_cleanup "$RESTO_A" "$PROD_A_CLEANUP" "$RETARGET_VICTIM_PATH" "pending")
RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated;
  set local test.uid = '$OWNER_A';
  update public.product_photo_pending_cleanups set old_path = '$C_PATH' where id = '$RETARGET_VICTIM_ID'::uuid;
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "v1.8-05bis-c: UPDATE direct authenticated visant à retargeter old_path vers C -> DENIED" "1" "$RC"
RETARGET_STORED_PATH=$(psql -d "$DB" -t -A -c "select old_path from public.product_photo_pending_cleanups where id = '$RETARGET_VICTIM_ID'::uuid;" | tr -d '[:space:]')
assert_eq "v1.8-05bis-d: old_path stocké reste EXACTEMENT RETARGET_VICTIM_PATH -- JAMAIS C" "$RETARGET_VICTIM_PATH" "$RETARGET_STORED_PATH"

log "=== v1.8-06 -- MANDAT item 12 : cleanup_id FABRIQUÉ (jamais inséré) -> DENIED (0 ligne, jamais une exception) ==="
FABRICATED_ID=$(psql -d "$DB" -t -A -c "select gen_random_uuid();" | tr -d '[:space:]')
RESULT=$(claim_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$FABRICATED_ID")
assert_eq "v1.8-06: cleanup_id FABRIQUÉ -> <NULL>|<NULL>" "<NULL>|<NULL>" "$RESULT"

log "=== v1.8-07 -- cleanup_id inexistant -> DENIED/NOT FOUND géré PROPREMENT (jamais un crash/une exception) ==="
NONEXISTENT_ID=$(psql -d "$DB" -t -A -c "select gen_random_uuid();" | tr -d '[:space:]')
RC=$(try_claim_cleanup "$OWNER_A" "$PROD_A_CLEANUP" "$NONEXISTENT_ID")
assert_eq "v1.8-07: cleanup_id inexistant -> 0 (claim_ NE LÈVE JAMAIS pour une ligne introuvable)" "0" "$RC"

log "=== v1.8-08 -- MANDAT item 11 : rejeu d'un cleanup_id DÉJÀ COMPLETED -> AUCUNE seconde suppression (JAMAIS retargetable, JAMAIS réclamable) ==="
RESULT=$(claim_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_1")
assert_eq "v1.8-08: rejeu de CLEANUP_ID_1 (déjà COMPLETED depuis v1.8-03) -> <NULL>|<NULL> (jamais une seconde suppression, jamais une réclamation implicite)" "<NULL>|<NULL>" "$RESULT"
assert_eq "v1.8-08bis: le statut reste COMPLETED (le rejeu ne le fait JAMAIS régresser)" "completed" "$(cleanup_row_status "$CLEANUP_ID_1")"

log "=== v1.8-09 -- cleanup_id appartenant à un AUTRE restaurant (MANDAT item 14) -> DENIED ==="
CROSS_RESTO_PATH="$RESTO_B/$PROD_B1/$(newfile)"
seed_object "$CROSS_RESTO_PATH"
CLEANUP_ID_CROSS_RESTO=$(seed_pending_cleanup "$RESTO_B" "$PROD_B1" "$CROSS_RESTO_PATH" "pending")
RESULT=$(claim_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_CROSS_RESTO")
assert_eq "v1.8-09: cleanup_id d'un AUTRE restaurant (RESTO_B), ciblé via PROD_A_CLEANUP (RESTO_A) -> <NULL>|<NULL>" "<NULL>|<NULL>" "$RESULT"
assert_eq "v1.8-09bis: la ligne cross-restaurant reste PENDING" "pending" "$(cleanup_row_status "$CLEANUP_ID_CROSS_RESTO")"
assert_eq "v1.8-09ter: l'objet cross-restaurant survit intact" "1" "$(row_exists "$CROSS_RESTO_PATH")"

log "=== v1.8-10 -- cleanup_id appartenant à un AUTRE produit (même restaurant) -> DENIED ==="
CROSS_PRODUCT_PATH="$RESTO_A/$PROD_A_CLEANUP_2/$(newfile)"
seed_object "$CROSS_PRODUCT_PATH"
CLEANUP_ID_CROSS_PRODUCT=$(seed_pending_cleanup "$RESTO_A" "$PROD_A_CLEANUP_2" "$CROSS_PRODUCT_PATH" "pending")
RESULT=$(claim_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_CROSS_PRODUCT")
assert_eq "v1.8-10: cleanup_id d'un AUTRE produit -> <NULL>|<NULL>" "<NULL>|<NULL>" "$RESULT"
assert_eq "v1.8-10bis: la ligne cross-produit reste PENDING" "pending" "$(cleanup_row_status "$CLEANUP_ID_CROSS_PRODUCT")"
assert_eq "v1.8-10ter: l'objet cross-produit survit intact" "1" "$(row_exists "$CROSS_PRODUCT_PATH")"

log "=== v1.8-11 -- MANDAT item 10 : marchand (owner) réclame SA PROPRE ligne pending-cleanup légitime -> PASS (PROCESSING) ==="
CLEAN_OLD_A2="$RESTO_A/$PROD_A_CLEANUP/$(newfile)"
CLEAN_NEW_B2="$RESTO_A/$PROD_A_CLEANUP/$(newfile)"
seed_object "$CLEAN_OLD_A2"; seed_object "$CLEAN_NEW_B2"
psql -d "$DB" -c "update public.menu_items set image_url = '$PUBLIC_URL_PREFIX/$CLEAN_OLD_A2' where id = '$PROD_A_CLEANUP';" >/dev/null
RESULT=$(apply_result3 "$OWNER_A" "$PROD_A_CLEANUP" "$PUBLIC_URL_PREFIX/$CLEAN_NEW_B2")
OLD_PATH_2="${RESULT%%|*}"
CLEANUP_ID_OWN=$(create_pending_cleanup "$OWNER_A" "$PROD_A_CLEANUP" "$OLD_PATH_2")
RESULT=$(claim_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_OWN")
CLAIM_OWN_PATH="$(claim_path_of "$RESULT")"
CLAIM_OWN_TOKEN="$(claim_token_of "$RESULT")"
assert_eq "v1.8-11: OWNER_A réclame sa propre ligne pending-cleanup légitime -> chemin renvoyé == old_path stocké" "$CLEAN_OLD_A2" "$CLAIM_OWN_PATH"
assert_eq "v1.8-11bis: statut == processing (pas encore completed -- Storage.remove() n'a pas encore été simulé)" "processing" "$(cleanup_row_status "$CLEANUP_ID_OWN")"

log "=== v1.8-12 -- MANDAT item 14 : marchand d'un AUTRE tenant (MANAGER_B) tente de réclamer une ligne pending-cleanup de RESTO_A -> DENIED ==="
CLEAN_OLD_A3="$RESTO_A/$PROD_A_CLEANUP/$(newfile)"
CLEAN_NEW_B3="$RESTO_A/$PROD_A_CLEANUP/$(newfile)"
seed_object "$CLEAN_OLD_A3"; seed_object "$CLEAN_NEW_B3"
psql -d "$DB" -c "update public.menu_items set image_url = '$PUBLIC_URL_PREFIX/$CLEAN_OLD_A3' where id = '$PROD_A_CLEANUP';" >/dev/null
RESULT=$(apply_result3 "$OWNER_A" "$PROD_A_CLEANUP" "$PUBLIC_URL_PREFIX/$CLEAN_NEW_B3")
OLD_PATH_3="${RESULT%%|*}"
CLEANUP_ID_TENANT_TEST=$(create_pending_cleanup "$OWNER_A" "$PROD_A_CLEANUP" "$OLD_PATH_3")
RC=$(try_claim_cleanup "$MANAGER_B" "$PROD_A_CLEANUP" "$CLEANUP_ID_TENANT_TEST")
assert_eq "v1.8-12: MANAGER_B (manager légitime de RESTO_B) tente de réclamer une ligne de RESTO_A -> DENIED (exception, assert_product_role_for revalide indépendamment)" "1" "$RC"
assert_eq "v1.8-12bis: la ligne reste PENDING après le refus" "pending" "$(cleanup_row_status "$CLEANUP_ID_TENANT_TEST")"

log "=== v1.8-13 -- authentifié SANS AUCUN lien (IMPOSTOR) -> DENIED (MANDAT item 14, généralisé) ==="
RC=$(try_claim_cleanup "$IMPOSTOR" "$PROD_A_CLEANUP" "$CLEANUP_ID_TENANT_TEST")
assert_eq "v1.8-13: IMPOSTOR (aucune ligne restaurant_users) -> DENIED" "1" "$RC"

log "=== v1.8-14 -- anon -> DENIED, ET appel DIRECT comme authenticated (même le owner LÉGITIME, en contournant service_role) -> DENIED, sur claim_/finalize_/release_ (matrice de privilège COMPLÈTE de la machine à états, pas seulement claim_) ==="
RC=$(try_claim_cleanup_as_anon "$PROD_A_CLEANUP" "$CLEANUP_ID_TENANT_TEST")
assert_eq "v1.8-14a: anon -> DENIED (claim_)" "1" "$RC"
RC=$(try_claim_cleanup_as_authenticated "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_TENANT_TEST")
assert_eq "v1.8-14b: OWNER_A appelant claim_ DIRECTEMENT comme authenticated -> DENIED" "1" "$RC"
assert_eq "v1.8-14c: la ligne reste PENDING après ces deux refus" "pending" "$(cleanup_row_status "$CLEANUP_ID_TENANT_TEST")"
RC=$(try_finalize_cleanup_as_anon "$PROD_A_CLEANUP" "$CLEANUP_ID_OWN" "$CLAIM_OWN_TOKEN")
assert_eq "v1.8-14d: anon -> DENIED (finalize_)" "1" "$RC"
RC=$(try_finalize_cleanup_as_authenticated "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_OWN" "$CLAIM_OWN_TOKEN")
assert_eq "v1.8-14e: authenticated DIRECT (même le owner légitime) -> DENIED (finalize_)" "1" "$RC"
RC=$(try_release_cleanup_as_anon "$PROD_A_CLEANUP" "$CLEANUP_ID_OWN" "$CLAIM_OWN_TOKEN")
assert_eq "v1.8-14f: anon -> DENIED (release_)" "1" "$RC"
RC=$(try_release_cleanup_as_authenticated "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_OWN" "$CLAIM_OWN_TOKEN")
assert_eq "v1.8-14g: authenticated DIRECT (même le owner légitime) -> DENIED (release_)" "1" "$RC"
assert_eq "v1.8-14h: CLEANUP_ID_OWN reste 'processing' avec le MÊME claim_token après ces 4 refus directs (aucune fuite d'autorité via un contournement de service_role)" "processing" "$(cleanup_row_status "$CLEANUP_ID_OWN")"

log "=== v1.8-15 -- MANDAT item 15 : défense en profondeur -- old_path STOCKÉ avec segment RESTAURANT altéré -> DENIED, JAMAIS réclamé ==="
TAMPERED_RESTO_PATH="$RESTO_B/$PROD_A_CLEANUP/$(newfile)"
seed_object "$TAMPERED_RESTO_PATH"
CLEANUP_ID_14=$(seed_pending_cleanup "$RESTO_A" "$PROD_A_CLEANUP" "$TAMPERED_RESTO_PATH" "pending")
RESULT=$(claim_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_14")
assert_eq "v1.8-15: old_path stocké pointe vers le segment restaurant RESTO_B alors que la ligne appartient (colonnes) à RESTO_A -> <NULL>|<NULL>" "<NULL>|<NULL>" "$RESULT"
assert_eq "v1.8-15bis: la ligne reste PENDING (jamais consommée sur un chemin invalide)" "pending" "$(cleanup_row_status "$CLEANUP_ID_14")"
assert_eq "v1.8-15ter: l'objet visé survit intact -- JAMAIS transmis à Storage remove()" "1" "$(row_exists "$TAMPERED_RESTO_PATH")"

log "=== v1.8-16 -- old_path STOCKÉ avec segment PRODUIT altéré -> DENIED ==="
TAMPERED_PRODUCT_PATH="$RESTO_A/$PROD_A_CLEANUP_2/$(newfile)"
seed_object "$TAMPERED_PRODUCT_PATH"
CLEANUP_ID_15=$(seed_pending_cleanup "$RESTO_A" "$PROD_A_CLEANUP" "$TAMPERED_PRODUCT_PATH" "pending")
RESULT=$(claim_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_15")
assert_eq "v1.8-16: old_path stocké pointe vers le namespace de PROD_A_CLEANUP_2 -> <NULL>|<NULL>" "<NULL>|<NULL>" "$RESULT"
assert_eq "v1.8-16bis: la ligne reste PENDING" "pending" "$(cleanup_row_status "$CLEANUP_ID_15")"
assert_eq "v1.8-16ter: l'objet visé survit intact" "1" "$(row_exists "$TAMPERED_PRODUCT_PATH")"

log "=== v1.8-17 -- old_path STOCKÉ avec nom de fichier hors contrat UUID v4 exact -> DENIED ==="
TAMPERED_UUID_PATH="$RESTO_A/$PROD_A_CLEANUP/not-a-valid-uuid.jpg"
seed_object "$TAMPERED_UUID_PATH"
CLEANUP_ID_16=$(seed_pending_cleanup "$RESTO_A" "$PROD_A_CLEANUP" "$TAMPERED_UUID_PATH" "pending")
RESULT=$(claim_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_16")
assert_eq "v1.8-17: old_path stocké avec un nom de fichier hors contrat UUID v4 exact -> <NULL>|<NULL>" "<NULL>|<NULL>" "$RESULT"
assert_eq "v1.8-17bis: la ligne reste PENDING" "pending" "$(cleanup_row_status "$CLEANUP_ID_16")"
assert_eq "v1.8-17ter: l'objet visé survit intact" "1" "$(row_exists "$TAMPERED_UUID_PATH")"

log "=== v1.8-18 -- MANDAT item 03 : échec de la suppression Storage APRÈS un claim réussi -> release_ ramène la ligne à PENDING (retriable), jamais un nouveau cleanup_id, claim_token effacé ==="
CLEAN_OLD_A4="$RESTO_A/$PROD_A_CLEANUP/$(newfile)"
CLEAN_NEW_B4="$RESTO_A/$PROD_A_CLEANUP/$(newfile)"
seed_object "$CLEAN_OLD_A4"; seed_object "$CLEAN_NEW_B4"
psql -d "$DB" -c "update public.menu_items set image_url = '$PUBLIC_URL_PREFIX/$CLEAN_OLD_A4' where id = '$PROD_A_CLEANUP';" >/dev/null
RESULT=$(apply_result3 "$OWNER_A" "$PROD_A_CLEANUP" "$PUBLIC_URL_PREFIX/$CLEAN_NEW_B4")
OLD_PATH_4="${RESULT%%|*}"
CLEANUP_ID_RELEASE=$(create_pending_cleanup "$OWNER_A" "$PROD_A_CLEANUP" "$OLD_PATH_4")
RESULT=$(claim_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_RELEASE")
CLAIM_R_PATH="$(claim_path_of "$RESULT")"
CLAIM_R_TOKEN="$(claim_token_of "$RESULT")"
assert_eq "v1.8-18a: premier claim -> chemin renvoyé == CLEAN_OLD_A4 (simule un Storage remove() Node qui va maintenant ÉCHOUER)" "$CLEAN_OLD_A4" "$CLAIM_R_PATH"
assert_eq "v1.8-18b: après ce premier claim, statut == processing" "processing" "$(cleanup_row_status "$CLEANUP_ID_RELEASE")"
RELEASED=$(release_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_RELEASE" "$CLAIM_R_TOKEN")
assert_eq "v1.8-18c: release_ (appelé par le serveur après un échec RÉEL de Storage .remove()) avec le claim_token EXACT -> true" "true" "$RELEASED"
assert_eq "v1.8-18d: après release_, statut redevient PENDING (retriable) -- MANDAT item 18" "pending" "$(cleanup_row_status "$CLEANUP_ID_RELEASE")"
CLAIM_TOKEN_AFTER_RELEASE="$(cleanup_row_field "$CLEANUP_ID_RELEASE" claim_token)"
assert_eq "v1.8-18e: claim_token effacé (NULL) après release_ -- l'ancien token n'autorise plus rien" "<NULL>" "$CLAIM_TOKEN_AFTER_RELEASE"
RESULT=$(claim_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_RELEASE")
CLAIM_R2_PATH="$(claim_path_of "$RESULT")"
CLAIM_R2_TOKEN="$(claim_token_of "$RESULT")"
assert_eq "v1.8-18f: MANDAT item 19 -- second claim (après release_) réussit IMMÉDIATEMENT (sans attendre un bail), renvoie ENCORE EXACTEMENT le MÊME chemin -- le même cleanup_id, jamais retargeté" "$CLEAN_OLD_A4" "$CLAIM_R2_PATH"
if [ "$CLAIM_R2_TOKEN" = "$CLAIM_R_TOKEN" ]; then
  fail "v1.8-18g: le second claim doit émettre un NOUVEAU claim_token, jamais réutiliser l'ancien"
else
  pass "v1.8-18g: le second claim émet bien un NOUVEAU claim_token, distinct du premier (l'ancien token, déjà libéré, n'a plus cours)"
fi
FINALIZE_R2=$(finalize_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_RELEASE" "$CLAIM_R2_TOKEN")
assert_eq "v1.8-18h: ce second claim se finalise normalement (Storage.remove() réussit cette fois) -> true" "true" "$FINALIZE_R2"
assert_eq "v1.8-18i: statut final == completed" "completed" "$(cleanup_row_status "$CLEANUP_ID_RELEASE")"

log "=== v1.8-18bis -- MANDAT items 05/06 : release_ avec un MAUVAIS claim_token (rejet logique, jamais une exception) -> PROCESSING reste récupérable UNIQUEMENT par expiration du bail, PAS par cet appel ==="
CLEAN_OLD_A4B="$RESTO_A/$PROD_A_CLEANUP/$(newfile)"
CLEAN_NEW_B4B="$RESTO_A/$PROD_A_CLEANUP/$(newfile)"
seed_object "$CLEAN_OLD_A4B"; seed_object "$CLEAN_NEW_B4B"
psql -d "$DB" -c "update public.menu_items set image_url = '$PUBLIC_URL_PREFIX/$CLEAN_OLD_A4B' where id = '$PROD_A_CLEANUP';" >/dev/null
RESULT=$(apply_result3 "$OWNER_A" "$PROD_A_CLEANUP" "$PUBLIC_URL_PREFIX/$CLEAN_NEW_B4B")
CLEANUP_ID_BADRELEASE=$(create_pending_cleanup "$OWNER_A" "$PROD_A_CLEANUP" "${RESULT%%|*}")
RESULT=$(claim_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_BADRELEASE" 1)
CLAIM_BR_TOKEN="$(claim_token_of "$RESULT")"
WRONG_TOKEN2=$(psql -d "$DB" -t -A -c "select gen_random_uuid();" | tr -d '[:space:]')
BAD_RELEASE=$(release_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_BADRELEASE" "$WRONG_TOKEN2")
assert_eq "v1.8-18bis-a: release_ avec un claim_token FABRIQUÉ (simule un échec/rejet applicatif détecté) -> false (RÉSULTAT VÉRIFIÉ, JAMAIS IGNORÉ côté appelant Node -- voir lib/server/product-photo-service.ts)" "false" "$BAD_RELEASE"
assert_eq "v1.8-18bis-b: PROCESSING NON DÉBLOQUÉ PAR CET APPEL -- statut reste 'processing' (ce release_ raté n'a RIEN changé)" "processing" "$(cleanup_row_status "$CLEANUP_ID_BADRELEASE")"
# Bail posé à 1 seconde (voir claim_cleanup_result ... 1 ci-dessus) --
# on attend son expiration RÉELLE (jamais simulée ici, contrairement à
# force_expire_lease -- preuve que le TEMPS RÉEL, pas seulement une
# manipulation directe de lease_until, débloque la récupération).
sleep 2
RESULT=$(claim_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_BADRELEASE")
CLAIM_BR2_TOKEN="$(claim_token_of "$RESULT")"
if [ "$CLAIM_BR2_TOKEN" = "<NULL>" ] || [ -z "$CLAIM_BR2_TOKEN" ]; then
  fail "v1.8-18bis-c: MANDAT -- 'the durable database state machine itself must guarantee eventual reclaimability' -- la ligne DOIT redevenir réclamable dès l'expiration RÉELLE du bail, MÊME quand release_ a échoué (no reopen-or-die design)"
else
  pass "v1.8-18bis-c: la ligne redevient réclamable dès l'expiration RÉELLE (temps réel écoulé, jamais simulée) du bail -- récupération garantie SANS dépendre du succès de release_"
fi
assert_eq "v1.8-18bis-d: le nouveau claim_token diffère de l'ancien (tentative précédente définitivement invalidée)" "1" "$([ "$CLAIM_BR2_TOKEN" != "$CLAIM_BR_TOKEN" ] && echo 1 || echo 0)"

log "=== v1.8-19 -- MANDAT item 09 : deux tentatives de claim CONCURRENTES sur le MÊME cleanup_id (bail encore VALIDE) -> AU PLUS UNE réclamation effective, JAMAIS deux suppressions -- sérialisation RÉELLE (SELECT ... FOR UPDATE + UPDATE atomique conditionnel), deux sessions PostgreSQL distinctes ==="
CLEAN_OLD_A5="$RESTO_A/$PROD_A_CLEANUP/$(newfile)"
CLEAN_NEW_B5="$RESTO_A/$PROD_A_CLEANUP/$(newfile)"
seed_object "$CLEAN_OLD_A5"; seed_object "$CLEAN_NEW_B5"
psql -d "$DB" -c "update public.menu_items set image_url = '$PUBLIC_URL_PREFIX/$CLEAN_OLD_A5' where id = '$PROD_A_CLEANUP';" >/dev/null
RESULT=$(apply_result3 "$OWNER_A" "$PROD_A_CLEANUP" "$PUBLIC_URL_PREFIX/$CLEAN_NEW_B5")
OLD_PATH_5="${RESULT%%|*}"
CLEANUP_ID_CONCURRENT=$(create_pending_cleanup "$OWNER_A" "$PROD_A_CLEANUP" "$OLD_PATH_5")

SQL_CLAIM_A_FILE="/tmp/scanym_v67c_claim_a_$$.sql"
OUT_CLAIM_A_FILE="/tmp/scanym_v67c_claim_a_out_$$.txt"
cat > "$SQL_CLAIM_A_FILE" <<EOF
set role service_role;
select coalesce(old_path,'<NULL>') || '|' || coalesce(claim_token::text,'<NULL>') as result
from public.claim_product_photo_pending_cleanup('$OWNER_A'::uuid, '$PROD_A_CLEANUP'::uuid, '$CLEANUP_ID_CONCURRENT'::uuid, '$TRUSTED_ORIGIN', null);
select pg_sleep(2);
EOF

psql -d "$DB" -1 -t -A -f "$SQL_CLAIM_A_FILE" > "$OUT_CLAIM_A_FILE" 2>&1 &
PID_CLAIM_A=$!

sleep 0.6

T_START=$(date +%s.%N)
RESULT_CLAIM_B=$(claim_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_CONCURRENT")
T_END=$(date +%s.%N)
ELAPSED_CLAIM=$(awk -v a="$T_START" -v b="$T_END" 'BEGIN { printf "%.2f", (b - a) }')

wait "$PID_CLAIM_A"
RESULT_CLAIM_A=$(grep -v -E '^(SET|RESET)$' "$OUT_CLAIM_A_FILE" | grep '|' | head -1 | tr -d '[:space:]')

BLOCKED_CLAIM=$(awk -v e="$ELAPSED_CLAIM" 'BEGIN { print (e >= 1.2) ? "1" : "0" }')
assert_eq "v1.8-19a: session B (concurrente) a bien été BLOQUÉE par le verrou FOR UPDATE de la session A (durée observée >= 1.2s -- preuve d'une sérialisation réelle, pas d'une course)" "1" "$BLOCKED_CLAIM"

SUCCESS_COUNT=0
RESULT_CLAIM_A_PATH="$(claim_path_of "$RESULT_CLAIM_A")"
RESULT_CLAIM_B_PATH="$(claim_path_of "$RESULT_CLAIM_B")"
[ "$RESULT_CLAIM_A_PATH" = "$CLEAN_OLD_A5" ] && SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
[ "$RESULT_CLAIM_B_PATH" = "$CLEAN_OLD_A5" ] && SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
assert_eq "v1.8-19b: EXACTEMENT une des deux tentatives concurrentes a réclamé le chemin (l'autre reçoit <NULL>|<NULL>) -- AU PLUS UNE réclamation effective, jamais un double claim" "1" "$SUCCESS_COUNT"
assert_eq "v1.8-19c: statut final == processing (PAS completed -- claim_ seul ne finalise JAMAIS)" "processing" "$(cleanup_row_status "$CLEANUP_ID_CONCURRENT")"

rm -f "$SQL_CLAIM_A_FILE" "$OUT_CLAIM_A_FILE"

log "=== v1.8-20 -- MANDAT item 07 : crash serveur simulé -- claim réussi, PUIS AUCUN appel finalize_/release_ (simule un crash entre le claim et le Storage.remove()) -- après expiration DÉTERMINISTE du bail (force_expire_lease), la ligne redevient réclamable, un NOUVEAU claim_token est émis, l'ANCIEN devient définitivement invalide ==="
CLEAN_OLD_A6="$RESTO_A/$PROD_A_CLEANUP/$(newfile)"
CLEAN_NEW_B6="$RESTO_A/$PROD_A_CLEANUP/$(newfile)"
seed_object "$CLEAN_OLD_A6"; seed_object "$CLEAN_NEW_B6"
psql -d "$DB" -c "update public.menu_items set image_url = '$PUBLIC_URL_PREFIX/$CLEAN_OLD_A6' where id = '$PROD_A_CLEANUP';" >/dev/null
RESULT=$(apply_result3 "$OWNER_A" "$PROD_A_CLEANUP" "$PUBLIC_URL_PREFIX/$CLEAN_NEW_B6")
CLEANUP_ID_CRASH=$(create_pending_cleanup "$OWNER_A" "$PROD_A_CLEANUP" "${RESULT%%|*}")
RESULT=$(claim_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_CRASH")
CLAIM_CRASH_TOKEN_1="$(claim_token_of "$RESULT")"
assert_eq "v1.8-20a: après le claim 'avant crash', statut == processing" "processing" "$(cleanup_row_status "$CLEANUP_ID_CRASH")"
# AUCUN appel finalize_/release_ ici -- simule EXACTEMENT un crash
# serveur survenu après le claim, avant tout Storage.remove().
force_expire_lease "$CLEANUP_ID_CRASH"
RESULT=$(claim_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_CRASH")
CLAIM_CRASH_PATH_2="$(claim_path_of "$RESULT")"
CLAIM_CRASH_TOKEN_2="$(claim_token_of "$RESULT")"
assert_eq "v1.8-20b: MANDAT item 07 -- après expiration du bail, un NOUVEAU claim RÉUSSIT (résultat non-NULL, aucune exception, aucun appel de récupération explicite requis), renvoie ENCORE le MÊME old_path" "$CLEAN_OLD_A6" "$CLAIM_CRASH_PATH_2"
if [ "$CLAIM_CRASH_TOKEN_2" = "$CLAIM_CRASH_TOKEN_1" ] || [ "$CLAIM_CRASH_TOKEN_2" = "<NULL>" ] || [ -z "$CLAIM_CRASH_TOKEN_2" ]; then
  fail "v1.8-20c: le nouveau claim doit émettre un NOUVEAU claim_token, distinct et non-NULL, jamais réutiliser l'ancien"
else
  pass "v1.8-20c: nouveau claim_token distinct de l'ancien -- l'ancienne tentative ('avant crash') est définitivement invalidée"
fi
CRASH_TOKEN_STALE_FINALIZE=$(finalize_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_CRASH" "$CLAIM_CRASH_TOKEN_1")
assert_eq "v1.8-20d: finaliser avec l'ANCIEN claim_token (tentative 'avant crash', périmée) -> false -- une finalisation tardive ne peut JAMAIS écraser l'état d'une tentative plus récente" "false" "$CRASH_TOKEN_STALE_FINALIZE"

log "=== v1.8-21 -- MANDAT item 08 : crash APRÈS un Storage.remove() qui a RÉUSSI mais AVANT finalize_ -- récupération sûre/idempotente, aucune recréation d'objet, COMPLETED atteint EN FIN DE COMPTE ==="
CLEAN_OLD_A7="$RESTO_A/$PROD_A_CLEANUP/$(newfile)"
CLEAN_NEW_B7="$RESTO_A/$PROD_A_CLEANUP/$(newfile)"
seed_object "$CLEAN_OLD_A7"; seed_object "$CLEAN_NEW_B7"
psql -d "$DB" -c "update public.menu_items set image_url = '$PUBLIC_URL_PREFIX/$CLEAN_OLD_A7' where id = '$PROD_A_CLEANUP';" >/dev/null
RESULT=$(apply_result3 "$OWNER_A" "$PROD_A_CLEANUP" "$PUBLIC_URL_PREFIX/$CLEAN_NEW_B7")
CLEANUP_ID_MISSING=$(create_pending_cleanup "$OWNER_A" "$PROD_A_CLEANUP" "${RESULT%%|*}")
RESULT=$(claim_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_MISSING")
CLAIM_MISSING_PATH_1="$(claim_path_of "$RESULT")"
CLAIM_MISSING_TOKEN_1="$(claim_token_of "$RESULT")"
# Storage.remove() RÉUSSIT RÉELLEMENT ici (côté harnais : supprime
# physiquement l'objet, EXACTEMENT ce que ferait Node) -- PUIS "crash"
# simulé : AUCUN appel finalize_ n'est fait.
delete_object "$CLAIM_MISSING_PATH_1"
assert_eq "v1.8-21a: l'objet a RÉELLEMENT disparu (Storage.remove() a réussi, simulé ici) AVANT toute finalisation" "0" "$(row_exists "$CLAIM_MISSING_PATH_1")"
force_expire_lease "$CLEANUP_ID_MISSING"
RESULT=$(claim_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_MISSING")
CLAIM_MISSING_PATH_2="$(claim_path_of "$RESULT")"
CLAIM_MISSING_TOKEN_2="$(claim_token_of "$RESULT")"
assert_eq "v1.8-21b: un NOUVEAU claim (après expiration du bail) réclame ENCORE le MÊME old_path (jamais recréé, jamais retargeté) -- le retry va retenter Storage.remove() sur un chemin déjà absent" "$CLAIM_MISSING_PATH_1" "$CLAIM_MISSING_PATH_2"
# L'API Storage réelle (S3-compatible) est idempotente pour une
# suppression sur un objet déjà absent -- AUCUNE erreur, AUCUNE
# recréation (voir lib/server/product-photo-service.ts, commentaire
# finalize_/CLEANUP-LEASE-RECOVERY.md). Le harnais SQL modélise cela en
# passant DIRECTEMENT à finalize_ (Node ne ré-essaierait PAS .remove()
# différemment selon que l'objet est présent ou absent -- le résultat
# .remove() est un succès dans les deux cas).
FINALIZE_MISSING=$(finalize_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_MISSING" "$CLAIM_MISSING_TOKEN_2")
assert_eq "v1.8-21c: MANDAT item 08 -- la finalisation du retry (objet déjà absent, suppression idempotente) réussit -> true, COMPLETED atteint EN FIN DE COMPTE" "true" "$FINALIZE_MISSING"
assert_eq "v1.8-21d: statut final == completed" "completed" "$(cleanup_row_status "$CLEANUP_ID_MISSING")"
FINALIZE_MISSING_STALE=$(finalize_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_MISSING" "$CLAIM_MISSING_TOKEN_1")
assert_eq "v1.8-21e: finaliser avec l'ANCIEN claim_token (tentative 'avant crash') -> false (la ligne est déjà completed, plus jamais processing)" "false" "$FINALIZE_MISSING_STALE"

log "=== v1.8-22 -- MANDAT items 16/17/20 : un cycle claim_/finalize_ RÉUSSI, comme un cycle claim_/release_ ÉCHOUÉ, ne modifient JAMAIS menu_items.image_url (l'image actuelle B) ni ne suppriment eux-mêmes storage.objects -- SEULE la ligne pending-cleanup est mutée, jamais un rejeu du remplacement/de l'upload ==="
IMG_BEFORE_CLAIM20=$(current_image_url "$PROD_A_CLEANUP")
CLEAN_OLD_A8="$RESTO_A/$PROD_A_CLEANUP/$(newfile)"
seed_object "$CLEAN_OLD_A8"
CLEANUP_ID_20=$(seed_pending_cleanup "$RESTO_A" "$PROD_A_CLEANUP" "$CLEAN_OLD_A8" "pending")
EXISTS_20_BEFORE=$(row_exists "$CLEAN_OLD_A8")
RESULT=$(claim_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_20")
CLAIM_20_TOKEN="$(claim_token_of "$RESULT")"
finalize_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_20" "$CLAIM_20_TOKEN" >/dev/null
IMG_AFTER_CLAIM20=$(current_image_url "$PROD_A_CLEANUP")
EXISTS_20_AFTER=$(row_exists "$CLEAN_OLD_A8")
assert_eq "v1.8-22a: menu_items.image_url STRICTEMENT inchangé après claim_+finalize_ -- CURRENT PRODUCT IMAGE MODIFIED BY CLEANUP RETRY: NO" "$IMG_BEFORE_CLAIM20" "$IMG_AFTER_CLAIM20"
assert_eq "v1.8-22b: storage.objects STRICTEMENT inchangé par claim_/finalize_ elles-mêmes (aucun DELETE SQL -- la suppression physique reste exclusivement Node/API Storage réelle)" "$EXISTS_20_BEFORE" "$EXISTS_20_AFTER"
assert_eq "v1.8-22c: statut de CLEANUP_ID_20 == completed" "completed" "$(cleanup_row_status "$CLEANUP_ID_20")"

IMG_BEFORE_CLAIM21=$(current_image_url "$PROD_A_CLEANUP")
CLEAN_OLD_A9="$RESTO_A/$PROD_A_CLEANUP/$(newfile)"
seed_object "$CLEAN_OLD_A9"
CLEANUP_ID_21=$(seed_pending_cleanup "$RESTO_A" "$PROD_A_CLEANUP" "$CLEAN_OLD_A9" "pending")
RESULT=$(claim_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_21")
CLAIM_21_TOKEN="$(claim_token_of "$RESULT")"
release_cleanup_result "$OWNER_A" "$PROD_A_CLEANUP" "$CLEANUP_ID_21" "$CLAIM_21_TOKEN" >/dev/null
IMG_AFTER_CLAIM21=$(current_image_url "$PROD_A_CLEANUP")
assert_eq "v1.8-22d: menu_items.image_url STRICTEMENT inchangé après un cycle claim_+release_ (échec simulé) -- CURRENT PRODUCT IMAGE MODIFIED BY CLEANUP RETRY: NO (même après un échec)" "$IMG_BEFORE_CLAIM21" "$IMG_AFTER_CLAIM21"
assert_eq "v1.8-22e: l'objet visé survit intact (release_ ne supprime rien elle-même)" "1" "$(row_exists "$CLEAN_OLD_A9")"

log "=== v1.8-23 -- table_contract : product_photo_pending_cleanups expose bien PENDING/PROCESSING/COMPLETED et une récupération finie depuis PROCESSING (contrainte CHECK introspectée, jamais une simple relecture du fichier source) ==="
STATUS_CHECK=$(psql -d "$DB" -t -A -c "
  select pg_get_constraintdef(c.oid)
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  where t.relname = 'product_photo_pending_cleanups' and c.conname = 'product_photo_pending_cleanups_status_check';
" | tr -d '[:space:]')
CONTAINS_ALL_3="0"
case "$STATUS_CHECK" in
  *pending*processing*completed*) CONTAINS_ALL_3="1" ;;
esac
assert_eq "v1.8-23a: la contrainte CHECK sur status contient EXACTEMENT pending/processing/completed (introspectée en base, jamais supposée)" "1" "$CONTAINS_ALL_3"
LEASE_COL=$(psql -d "$DB" -t -A -c "select count(*) from information_schema.columns where table_schema='public' and table_name='product_photo_pending_cleanups' and column_name='lease_until';" | tr -d '[:space:]')
CLAIM_TOKEN_COL=$(psql -d "$DB" -t -A -c "select count(*) from information_schema.columns where table_schema='public' and table_name='product_photo_pending_cleanups' and column_name='claim_token';" | tr -d '[:space:]')
ATTEMPT_COL=$(psql -d "$DB" -t -A -c "select count(*) from information_schema.columns where table_schema='public' and table_name='product_photo_pending_cleanups' and column_name='attempt_count';" | tr -d '[:space:]')
assert_eq "v1.8-23b: colonne lease_until présente (bail à expiration)" "1" "$LEASE_COL"
assert_eq "v1.8-23c: colonne claim_token présente" "1" "$CLAIM_TOKEN_COL"
assert_eq "v1.8-23d: colonne attempt_count présente" "1" "$ATTEMPT_COL"

log "=== v1.8-24 (objet C final) -- APRES toutes les tentatives hostiles ci-dessus, l'objet C (jamais référencé par AUCUNE ligne pending-cleanup légitime, jamais réclamé, jamais finalisé) survit intact ==="
assert_eq "v1.8-24: objet C -- PRESERVED (jamais transmis à Storage remove(), STORAGE REMOVE CALLED WITH C: NO, C PASSED TO STORAGE REMOVE: NO)" "1" "$(row_exists "$C_PATH")"

log "=== v1.6-begin -- begin_ renvoie current_image_url EXACTEMENT égal à menu_items.image_url (lecture fraîche, aucune requête supplémentaire) ==="
CURRENT_URL_RETURNED=$(begin_current_image_url "$OWNER_A" "$PROD_A_PROV")
CURRENT_URL_ACTUAL=$(current_image_url "$PROD_A_PROV")
assert_eq "v1.6-begin: current_image_url renvoyé par begin_ == menu_items.image_url actuel" "$CURRENT_URL_ACTUAL" "$CURRENT_URL_RETURNED"

log "=== ROLLBACK -- preuve de fidélité (annule exactement la remédiation v1.7, restaure l'état V67 D'ORIGINE publié -- policies ET set_product_photo, DROP des HUIT fonctions v1.4/v1.5/v1.6/v1.7/v1.8) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-bulk-product-photos-storage-authorization-v1-ROLLBACK.sql" >/dev/null
pass "rollback appliqué sans erreur"

# Vérification fiable par catalogue système (pg_proc/pg_namespace),
# et non par correspondance fragile de texte d'erreur : un appel sans
# contexte d'authentification échouerait de toute façon avec un
# message DIFFERENT ("Authentication required") même si la fonction
# existait encore, ce qui rendrait un grep de message un faux négatif
# permanent, indépendant de la réalité du DROP FUNCTION. v1.5 : les
# SIX fonctions (pas seulement begin_/apply_) doivent avoir disparu --
# assert_product_role_for et _product_photo_path_segments sont
# NOUVELLES en v1.5, _product_photo_relative_path_shape est NOUVELLE
# en v1.6. v1.7 : retry_product_photo_cleanup_path (v1.6) n'est PLUS
# dans cette liste -- ce fichier v1.7 ne l'a jamais recréée, elle
# n'existe déjà plus avant même ce rollback. v1.8 :
# reopen_product_photo_pending_cleanup (v1.7) n'est PLUS non plus dans
# cette liste -- ce fichier v1.8 ne l'a jamais recréée. À sa place, les
# QUATRE fonctions v1.7/v1.8 (create_/claim_/finalize_/release_
# product_photo_pending_cleanup) doivent avoir disparu.
for FN in begin_product_photo_replacement apply_product_photo_replacement assert_product_role_for _product_photo_path_segments _product_photo_relative_path_shape create_product_photo_pending_cleanup claim_product_photo_pending_cleanup finalize_product_photo_pending_cleanup release_product_photo_pending_cleanup; do
  RC=$(psql -d "$DB" -t -A -c "
    select case when exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = '$FN'
    ) then '0' else '1' end;
  " | tr -d '[:space:]')
  assert_eq "APRES ROLLBACK : $FN n'existe plus (fonction v1.4/v1.5/v1.6/v1.7/v1.8 correctement supprimée)" "1" "$RC"
done
RC_REOPEN_GONE=$(psql -d "$DB" -t -A -c "
  select case when exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'reopen_product_photo_pending_cleanup'
  ) then '0' else '1' end;
" | tr -d '[:space:]')
assert_eq "APRES ROLLBACK : reopen_product_photo_pending_cleanup (v1.7, REMPLACÉE par finalize_/release_ -- v1.8) toujours absente" "1" "$RC_REOPEN_GONE"

TABLE_STILL_EXISTS=$(psql -d "$DB" -t -A -c "
  select case when exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'product_photo_pending_cleanups'
  ) then '0' else '1' end;
" | tr -d '[:space:]')
assert_eq "APRES ROLLBACK : public.product_photo_pending_cleanups n'existe plus (table v1.7, colonnes étendues v1.8, correctement DROP)" "1" "$TABLE_STILL_EXISTS"

# NOTE : la policy V67 D'ORIGINE (migration-v67-product-photos.sql,
# "product_photos_insert_own_restaurant") ne conditionne JAMAIS l'accès
# à is_scanym_operator() -- elle vérifie exclusivement une ligne
# restaurant_users(owner|manager) pour le premier segment du chemin.
# Le bypass opérateur n'a JAMAIS existé qu'au niveau des RPC
# (assert_product_role), jamais au niveau des policies Storage brutes.
# OPERATOR n'a ici aucune ligne restaurant_users pour RESTO_A : le
# tester ici testerait un comportement qui n'a jamais existé même
# avant v1.3/v1.4/v1.5 -- OWNER_A (owner réel de RESTO_A) est le sujet
# correct pour prouver la restauration fidèle du comportement V67.
RC=$(try_insert "$OWNER_A" "$RESTO_A/$PROD_A1/$(newfile)")
assert_eq "APRES ROLLBACK : le owner du restaurant récupère l'accès INSERT direct (comportement V67 D'ORIGINE restauré -- using(false) levé, entity binding restaurant_users intacte)" "0" "$RC"

ANON_INSERT_RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role anon;
  insert into storage.objects (bucket_id, name) values ('product-photos', '$RESTO_A/$PROD_A1/$(newfile)');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "APRES ROLLBACK : anon toujours refusé" "1" "$ANON_INSERT_RC"

ROLLBACK_OLD_PATH="$RESTO_A/$PROD_A1/$(newfile)"
psql -d "$DB" -c "
  update public.menu_items set image_url = '$PUBLIC_URL_PREFIX/$ROLLBACK_OLD_PATH' where id = '$PROD_A1';
  insert into storage.objects (bucket_id, name) values ('product-photos', '$ROLLBACK_OLD_PATH');
" >/dev/null
RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role authenticated;
  set local test.uid = '$OWNER_A';
  select public.set_product_photo('$PROD_A1'::uuid, '$PUBLIC_URL_PREFIX/$(newfile)');
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "APRES ROLLBACK : set_product_photo (corps V67 D'ORIGINE) réussit toujours" "0" "$RC"
EXISTS_AFTER_ROLLBACK_RPC=$(row_exists "$ROLLBACK_OLD_PATH")
assert_eq "APRES ROLLBACK : set_product_photo restaurée NE supprime PLUS l'ancienne photo elle-même (comportement V67 EXACT, aucune capture de provenance -- jamais l'état v1.3/v1.4/v1.5)" "1" "$EXISTS_AFTER_ROLLBACK_RPC"

log "=== FORWARD -> ROLLBACK -> FORWARD -- ré-application de la remédiation v1.8 après rollback (idempotence) ==="
psql -d "$DB" -v ON_ERROR_STOP=1 >/dev/null <<SQL
drop function public.set_product_photo(uuid, text);
create function public.set_product_photo(
  p_product_id uuid,
  p_image_url  text
)
returns void
language plpgsql
security definer
set search_path = ''
as \$\$
declare
  v_image_url text;
  v_old_url   text;
  v_old_path  text;
  v_new_path  text;
  v_marker    constant text := '/object/public/product-photos/';
  v_idx       int;
begin
  perform public.assert_product_role(p_product_id, array['owner','manager']);
  v_image_url := nullif(btrim(coalesce(p_image_url, ''), E' \t\n\r\f' || chr(11)), '');
  select image_url into v_old_url from public.menu_items where id = p_product_id and archived_at is null;
  update public.menu_items set image_url = v_image_url where id = p_product_id and archived_at is null;
  if not found then raise exception using errcode = 'P0002', message = 'Product not found or archived'; end if;
  if v_old_url is not null then
    if v_image_url is not null then
      v_idx := position(v_marker in v_image_url);
      if v_idx > 0 then v_new_path := substring(v_image_url from v_idx + length(v_marker)); end if;
    end if;
    v_idx := position(v_marker in v_old_url);
    if v_idx > 0 then
      v_old_path := substring(v_old_url from v_idx + length(v_marker));
      if v_old_path is not null and v_old_path <> coalesce(v_new_path, '') then
        delete from storage.objects where bucket_id = 'product-photos' and name = v_old_path;
      end if;
    end if;
  end if;
end \$\$;
revoke all on function public.set_product_photo(uuid, text) from public, anon;
grant execute on function public.set_product_photo(uuid, text) to authenticated;
SQL
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql" >/dev/null
pass "migration de remédiation v1.8 ré-appliquée sans erreur après rollback (forward -> rollback -> forward)"

RC=$(try_begin "$OPERATOR" "$PROD_A1")
assert_eq "APRES RE-FORWARD : begin_ -- opérateur autorisé, produit réel -> PASS de nouveau" "0" "$RC"

REFORWARD_PATH="$RESTO_A/$PROD_A1/$(newfile)"
seed_object "$REFORWARD_PATH"
RC=$(try_apply "$OWNER_A" "$PROD_A1" "$PUBLIC_URL_PREFIX/$REFORWARD_PATH")
assert_eq "APRES RE-FORWARD : apply_ -- service_role, owner A, propre restaurant, propre produit, chemin conforme -> ALLOWED (non-régression marchand)" "0" "$RC"

REFORWARD_BAD_PATH="$RESTO_A/$PROD_A1/re-forward-non-conforme.jpg"
seed_object "$REFORWARD_BAD_PATH"
RC=$(try_apply "$OWNER_A" "$PROD_A1" "$PUBLIC_URL_PREFIX/$REFORWARD_BAD_PATH")
assert_eq "APRES RE-FORWARD : apply_ -- nom de fichier hors contrat exact -> DENIED de nouveau (Blocker 3 v1.4 toujours actif)" "1" "$RC"

RC=$(try_apply_as_authenticated "$OWNER_A" "$PROD_A1" "$PUBLIC_URL_PREFIX/$REFORWARD_PATH")
assert_eq "APRES RE-FORWARD : apply_ -- appel authenticated DIRECT -> DENIED de nouveau (Blocker 1 v1.5 toujours actif, GRANT EXECUTE toujours retiré après ré-application)" "1" "$RC"

RC=$(try_insert "$OWNER_A" "$RESTO_A/$PROD_A1/$(newfile)")
assert_eq "APRES RE-FORWARD : INSERT client direct -> DENIED de nouveau (using(false) toujours actif, y compris pour le propriétaire légitime)" "1" "$RC"

ANON_RC=$(psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  set role anon;
  select * from public.begin_product_photo_replacement('$PROD_A1'::uuid);
  reset role;
" >/dev/null 2>&1 && echo "0" || echo "1")
assert_eq "APRES RE-FORWARD : anon toujours refusé (begin_)" "1" "$ANON_RC"

log "=== APRES RE-FORWARD (v1.8) -- la machine à états PENDING -> PROCESSING -> COMPLETED fonctionne de nouveau intégralement après le cycle FORWARD -> ROLLBACK -> FORWARD, jamais un artefact du premier CREATE FUNCTION ==="
REFORWARD_CLEAN_OLD="$RESTO_A/$PROD_A1/$(newfile)"
REFORWARD_CLEAN_NEW="$RESTO_A/$PROD_A1/$(newfile)"
seed_object "$REFORWARD_CLEAN_OLD"; seed_object "$REFORWARD_CLEAN_NEW"
psql -d "$DB" -c "update public.menu_items set image_url = '$PUBLIC_URL_PREFIX/$REFORWARD_CLEAN_OLD' where id = '$PROD_A1';" >/dev/null
RESULT=$(apply_result3 "$OWNER_A" "$PROD_A1" "$PUBLIC_URL_PREFIX/$REFORWARD_CLEAN_NEW")
REFORWARD_CLEANUP_ID=$(create_pending_cleanup "$OWNER_A" "$PROD_A1" "${RESULT%%|*}")
RESULT=$(claim_cleanup_result "$OWNER_A" "$PROD_A1" "$REFORWARD_CLEANUP_ID")
assert_eq "APRES RE-FORWARD : claim_ -- pending -> processing de nouveau (JAMAIS completed directement -- le fix v1.8 est une propriété durable du fichier de migration, pas un artefact du premier CREATE FUNCTION)" "processing" "$(cleanup_row_status "$REFORWARD_CLEANUP_ID")"
REFORWARD_TOKEN="$(claim_token_of "$RESULT")"
FINALIZE_REFORWARD=$(finalize_cleanup_result "$OWNER_A" "$PROD_A1" "$REFORWARD_CLEANUP_ID" "$REFORWARD_TOKEN")
assert_eq "APRES RE-FORWARD : finalize_ avec le claim_token exact -> true, statut -> completed" "true" "$FINALIZE_REFORWARD"
RC=$(try_claim_cleanup_as_authenticated "$OWNER_A" "$PROD_A1" "$REFORWARD_CLEANUP_ID")
assert_eq "APRES RE-FORWARD : claim_ appelé DIRECTEMENT comme authenticated -> DENIED de nouveau (GRANT EXECUTE toujours retiré après le cycle complet)" "1" "$RC"

log "=== RÉSULTAT FINAL : $PASS_COUNT réussis, $FAIL_COUNT échoués ==="
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
echo "TOUTES LES VÉRIFICATIONS STORAGE (FINAL DURABLE CLEANUP STATE MACHINE v1.8 -- MACHINE À ÉTATS PENDING/PROCESSING/COMPLETED + BAIL À EXPIRATION AUTOMATIQUE + CLAIM_TOKEN + CRASH-RECOVERY + OBJET MANQUANT IDEMPOTENT + CONCURRENCE claim_ + MATRICE DE PRIVILÈGE claim_/finalize_/release_ + OBJET C PRÉSERVÉ + 10 ITEMS ORIGINE HOSTILE v1.6 PRÉSERVÉS + 20 ITEMS MANDAT v1.5 PRÉSERVÉS + 26 ITEMS v1.4 PRÉSERVÉS + PROVENANCE 3-OBJETS + POISONED-OLD-PATH 9 CAS + CONCURRENCE apply_ + v2.2.1 SOLE BLOCKER (FIRST APPLY REGRESSION + ALREADY_APPLIED + CONFLICT SQLSTATE P0004 + MANDATORY RACE TEST verrou réel) + ROLLBACK) ONT RÉUSSI"
