#!/usr/bin/env bash
# ============================================================
# Scanym LOT D — Harnais d'intégration PostgreSQL, reproductible
#
# VERSION FINALE après 2 tours d'audit Work.
#
# 1er tour (B-01 à B-05) : restaurant historique reste 'active' ;
# link_pending_owner réellement idempotent ; membership existant
# devient réellement owner ; droits DML révoqués y compris PUBLIC ;
# allowlist pays/devises.
#
# 2e tour : le test d'héritage de rôle était dans le mauvais sens
# (testait qu'un rôle QUI HÉRITE de authenticated n'obtient rien de
# plus, au lieu de tester qu'authenticated HÉRITANT d'un rôle
# dangereux est détecté) — corrigé ci-dessous, sens exact demandé :
#   create role test_writer;
#   grant insert on public.restaurants to test_writer;
#   grant test_writer to authenticated;
# La migration doit alors ÉCHOUER EXPLICITEMENT (pas se corriger
# elle-même en révoquant un rôle parent inconnu). Cycle de vie public
# appliqué à create_order ET à la lecture RLS directe, pas seulement
# au filtre TypeScript. Tous les scénarios sont désormais séparés
# individuellement (pas d'assertion générique agrégée), comme exigé.
#
# Même patron que supabase/tests/v66-integration-test.sh : base
# éphémère, chaîne réelle rejouée, assertions explicites, échec au
# premier problème, nettoyage garanti (trap EXIT).
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/lotd-integration-test.sh"
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"

PASS_COUNT=0
FAIL_COUNT=0
DB="scanym_lotd_ci_$$"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); log "FAIL: $*"; }

cleanup() { psql -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true; }
trap cleanup EXIT

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}
assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -q "$needle"; then pass "$desc"; else fail "$desc — motif '$needle' introuvable"; fi
}

sql() { psql -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
sql_t() { psql -d "$DB" -t -A -v ON_ERROR_STOP=1 "$@" | tail -n1; }
extract_uuid() { grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1; }

log "=== 1. Base éphémère $DB ==="
createdb "$DB"

log "=== 2. Stubs auth + storage ==="
sql >/dev/null <<'SQL'
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

log "=== 3. Chaîne réelle jusqu'à V67b, avec de VRAIES données historiques (Illico Presto + Le Sirocco) ==="
for f in schema.sql migration-orders.sql migration-orders-lang.sql \
         migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql \
         migration-translations.sql migration-v39-settings.sql \
         migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql \
         migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql \
         migration-v66-categories-descriptions.sql; do
  sql -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null 2>&1
done
sql -f "$SUPABASE_DIR/migration-v67-product-photos.sql" >/dev/null
sql -f "$SUPABASE_DIR/migration-v67b-category-description-product-order.sql" >/dev/null
sql -f "$SUPABASE_DIR/seed-illico-v2.sql" >/dev/null
sql -f "$SUPABASE_DIR/seed-sirocco-demo.sql" >/dev/null
pass "chaîne V65..V67b appliquée sans erreur, données historiques réelles chargées (Illico Presto + Le Sirocco)"

log "=== 4. SCÉNARIO D'HÉRITAGE DANGEREUX (sens correct) : authenticated hérite d'INSERT sur restaurants via un rôle parent ==="
sql -c "create role test_writer;" >/dev/null
sql -c "grant insert on public.restaurants to test_writer;" >/dev/null
sql -c "grant test_writer to authenticated;" >/dev/null

INHERITED_BEFORE=$(sql_t -c "select has_table_privilege('authenticated', 'public.restaurants', 'INSERT');")
assert_eq "authenticated a bien un droit INSERT effectif via héritage, AVANT toute tentative de migration" "t" "$INHERITED_BEFORE"

log "=== 5. La migration Lot D DOIT échouer explicitement face à ce droit hérité (jamais de correction automatique) ==="
set +e
MIGRATION_OUTPUT=$(sql -f "$SUPABASE_DIR/migration-lotd-establishment-creation.sql" 2>&1)
MIGRATION_EXIT=$?
set -e
assert_eq "la migration échoue (code de sortie non nul) face au droit hérité" "1" "$([ "$MIGRATION_EXIT" -ne 0 ] && echo 1 || echo 0)"
assert_contains "message explicite identifiant le rôle parent comme cause" "$MIGRATION_OUTPUT" "SCANYM_SCHEMA_DRIFT"
assert_contains "le message mentionne authenticated et le droit INSERT" "$MIGRATION_OUTPUT" "authenticated dispose encore du droit INSERT"

STATUS_COL_ABSENT=$(sql_t -c "select count(*) from information_schema.columns where table_name='restaurants' and column_name='status';")
assert_eq "AUCUNE modification appliquée après l'échec (rollback complet, colonne status absente)" "0" "$STATUS_COL_ABSENT"

log "=== 6. Nettoyage du rôle de test (jamais une correction automatique par la migration elle-même) ==="
sql -c "revoke test_writer from authenticated;" >/dev/null
sql -c "revoke insert on public.restaurants from test_writer;" >/dev/null
sql -c "drop role test_writer;" >/dev/null
INHERITED_AFTER_CLEANUP=$(sql_t -c "select has_table_privilege('authenticated', 'public.restaurants', 'INSERT');")
assert_eq "après nettoyage manuel du rôle de test, le droit hérité a disparu" "f" "$INHERITED_AFTER_CLEANUP"
pass "rôle de test entièrement nettoyé"

log "=== 7. Application RÉELLE de migration-lotd-establishment-creation.sql (chemin normal, sans dérive) ==="
sql -f "$SUPABASE_DIR/migration-lotd-establishment-creation.sql"
pass "migration Lot D appliquée sans erreur"

log "=== 8. RÉGRESSION HISTORIQUE : Illico Presto reste active et accessible publiquement ==="
ILLICO_STATUS=$(sql_t -c "select status from public.restaurants where slug='illico-presto';")
assert_eq "Illico Presto : status = active" "active" "$ILLICO_STATUS"
ILLICO_PUBLIC=$(sql_t -c "set role anon; select count(*) from public.restaurants where slug='illico-presto';")
assert_eq "Illico Presto : lisible publiquement (rôle anon)" "1" "$ILLICO_PUBLIC"

log "=== 9. RÉGRESSION HISTORIQUE : Le Sirocco reste active et accessible publiquement ==="
SIROCCO_STATUS=$(sql_t -c "select status from public.restaurants where slug='le-sirocco';")
assert_eq "Le Sirocco : status = active" "active" "$SIROCCO_STATUS"
SIROCCO_PUBLIC=$(sql_t -c "set role anon; select count(*) from public.restaurants where slug='le-sirocco';")
assert_eq "Le Sirocco : lisible publiquement (rôle anon)" "1" "$SIROCCO_PUBLIC"

log "=== 10. Préparation : un opérateur + un utilisateur par rôle (staff/manager/owner) ==="
sql >/dev/null <<'SQL'
insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'operateur@scanym.internal');
insert into public.scanym_operators (user_id) values ('11111111-1111-1111-1111-111111111111');
insert into auth.users (id, email) values ('44444444-4444-4444-4444-444444444444', 'staff@test.com');
insert into auth.users (id, email) values ('55555555-5555-5555-5555-555555555555', 'manager@test.com');
insert into auth.users (id, email) values ('66666666-6666-6666-6666-666666666666', 'owner@test.com');
SQL
REF_RID=$(sql -c "set test.uid = '11111111-1111-1111-1111-111111111111'; select * from public.create_establishment('Référence','ref-slug','FR','Lyon','cheese_shop',null,null,'+33600000099','fr',array['fr'],'EUR',null,'ref@test.com',null);" | extract_uuid)
sql -c "insert into public.restaurant_users (user_id, restaurant_id, role) values ('44444444-4444-4444-4444-444444444444', '$REF_RID'::uuid, 'staff');" >/dev/null
sql -c "insert into public.restaurant_users (user_id, restaurant_id, role) values ('55555555-5555-5555-5555-555555555555', '$REF_RID'::uuid, 'manager');" >/dev/null
sql -c "insert into public.restaurant_users (user_id, restaurant_id, role) values ('66666666-6666-6666-6666-666666666666', '$REF_RID'::uuid, 'owner');" >/dev/null
pass "un établissement de référence + un utilisateur par rôle préparés"

log "=== 11. AUTORISATION : anon (non authentifié) refusé pour create_establishment ==="
OUT=$(sql -c "select * from public.create_establishment('X','x-anon','FR','Lyon','cheese_shop',null,null,'+33600000001','fr',array['fr'],'EUR',null,'x@y.fr',null);" 2>&1 || true)
assert_contains "anon (non authentifié) refusé" "$OUT" "Authentication required"

log "=== 12. AUTORISATION : staff refusé pour create_establishment ==="
OUT=$(sql -c "set test.uid = '44444444-4444-4444-4444-444444444444'; select * from public.create_establishment('X','x-staff','FR','Lyon','cheese_shop',null,null,'+33600000002','fr',array['fr'],'EUR',null,'x@y.fr',null);" 2>&1 || true)
assert_contains "staff refusé" "$OUT" "Not authorized"

log "=== 13. AUTORISATION : manager refusé pour create_establishment ==="
OUT=$(sql -c "set test.uid = '55555555-5555-5555-5555-555555555555'; select * from public.create_establishment('X','x-manager','FR','Lyon','cheese_shop',null,null,'+33600000003','fr',array['fr'],'EUR',null,'x@y.fr',null);" 2>&1 || true)
assert_contains "manager refusé" "$OUT" "Not authorized"

log "=== 14. AUTORISATION : owner refusé pour create_establishment (pas opérateur Scanym) ==="
OUT=$(sql -c "set test.uid = '66666666-6666-6666-6666-666666666666'; select * from public.create_establishment('X','x-owner','FR','Lyon','cheese_shop',null,null,'+33600000004','fr',array['fr'],'EUR',null,'x@y.fr',null);" 2>&1 || true)
assert_contains "owner refusé" "$OUT" "Not authorized"

log "=== 15. AUTORISATION : opérateur Scanym accepté pour create_establishment ==="
NEW_RID=$(sql -c "set test.uid = '11111111-1111-1111-1111-111111111111'; select * from public.create_establishment('Au Lait Cru','au-lait-cru','FR','Lyon','cheese_shop','12 rue des Fromages','+33612345678','+33612345678','fr',array['fr'],'EUR','9h-19h','proprietaire@aulaitcru.fr','Fromages');" | extract_uuid)
if [ -n "$NEW_RID" ]; then pass "opérateur Scanym accepté, établissement créé"; else fail "l'opérateur aurait dû pouvoir créer un établissement"; fi
CREATED_BY=$(sql_t -c "select created_by from public.restaurants where id='$NEW_RID'::uuid;")
assert_eq "created_by tracé (auditabilité)" "11111111-1111-1111-1111-111111111111" "$CREATED_BY"
CAT_COUNT=$(sql_t -c "select count(*) from public.menu_categories where restaurant_id='$NEW_RID'::uuid;")
assert_eq "catégorie initiale créée" "1" "$CAT_COUNT"

log "=== 16. RATTACHEMENT : aucun membership préalable -> owner créé ==="
sql -c "insert into auth.users (id, email) values ('77777777-7777-7777-7777-777777777777', 'proprietaire@aulaitcru.fr');" >/dev/null
RU_BEFORE=$(sql_t -c "select count(*) from public.restaurant_users where restaurant_id='$NEW_RID'::uuid and user_id='77777777-7777-7777-7777-777777777777';")
assert_eq "aucun membership avant rattachement" "0" "$RU_BEFORE"
sql -c "set test.uid = '11111111-1111-1111-1111-111111111111'; select public.link_pending_owner('$NEW_RID'::uuid);" >/dev/null
ROLE_NO_PRIOR=$(sql_t -c "select role from public.restaurant_users where restaurant_id='$NEW_RID'::uuid and user_id='77777777-7777-7777-7777-777777777777';")
assert_eq "owner créé (aucun membership préalable)" "owner" "$ROLE_NO_PRIOR"
STATUS_AFTER_LINK=$(sql_t -c "select status from public.restaurants where id='$NEW_RID'::uuid;")
assert_eq "statut passé à active" "active" "$STATUS_AFTER_LINK"

log "=== 17. RATTACHEMENT : staff PRÉALABLE sur le même établissement -> devient owner ==="
RID2=$(sql -c "set test.uid = '11111111-1111-1111-1111-111111111111'; select * from public.create_establishment('Etab Staff','etab-staff','FR','Lyon','bakery',null,null,'+33600000010','fr',array['fr'],'EUR',null,'staffowner@test.com',null);" | extract_uuid)
sql -c "insert into auth.users (id, email) values ('88888888-8888-8888-8888-888888888888', 'staffowner@test.com'); insert into public.restaurant_users (user_id, restaurant_id, role) values ('88888888-8888-8888-8888-888888888888', '$RID2'::uuid, 'staff');" >/dev/null
sql -c "set test.uid = '11111111-1111-1111-1111-111111111111'; select public.link_pending_owner('$RID2'::uuid);" >/dev/null
ROLE_WAS_STAFF=$(sql_t -c "select role from public.restaurant_users where restaurant_id='$RID2'::uuid and user_id='88888888-8888-8888-8888-888888888888';")
assert_eq "staff préalable devient réellement owner" "owner" "$ROLE_WAS_STAFF"

log "=== 18. RATTACHEMENT : manager PRÉALABLE sur le même établissement -> devient owner ==="
RID3=$(sql -c "set test.uid = '11111111-1111-1111-1111-111111111111'; select * from public.create_establishment('Etab Manager','etab-manager','FR','Lyon','bakery',null,null,'+33600000011','fr',array['fr'],'EUR',null,'managerowner@test.com',null);" | extract_uuid)
sql -c "insert into auth.users (id, email) values ('99999999-9999-9999-9999-999999999998', 'managerowner@test.com'); insert into public.restaurant_users (user_id, restaurant_id, role) values ('99999999-9999-9999-9999-999999999998', '$RID3'::uuid, 'manager');" >/dev/null
sql -c "set test.uid = '11111111-1111-1111-1111-111111111111'; select public.link_pending_owner('$RID3'::uuid);" >/dev/null
ROLE_WAS_MANAGER=$(sql_t -c "select role from public.restaurant_users where restaurant_id='$RID3'::uuid and user_id='99999999-9999-9999-9999-999999999998';")
assert_eq "manager préalable devient réellement owner" "owner" "$ROLE_WAS_MANAGER"

log "=== 19. RATTACHEMENT : owner PRÉALABLE sur le même établissement -> reste owner, sans doublon ==="
RID4=$(sql -c "set test.uid = '11111111-1111-1111-1111-111111111111'; select * from public.create_establishment('Etab Owner','etab-owner','FR','Lyon','bakery',null,null,'+33600000012','fr',array['fr'],'EUR',null,'alreadyowner@test.com',null);" | extract_uuid)
sql -c "insert into auth.users (id, email) values ('99999999-9999-9999-9999-999999999997', 'alreadyowner@test.com'); insert into public.restaurant_users (user_id, restaurant_id, role) values ('99999999-9999-9999-9999-999999999997', '$RID4'::uuid, 'owner');" >/dev/null
sql -c "set test.uid = '11111111-1111-1111-1111-111111111111'; select public.link_pending_owner('$RID4'::uuid);" >/dev/null
ROLE_WAS_OWNER=$(sql_t -c "select role from public.restaurant_users where restaurant_id='$RID4'::uuid and user_id='99999999-9999-9999-9999-999999999997';")
assert_eq "owner préalable reste owner" "owner" "$ROLE_WAS_OWNER"
RU_COUNT_NO_DUP=$(sql_t -c "select count(*) from public.restaurant_users where restaurant_id='$RID4'::uuid and user_id='99999999-9999-9999-9999-999999999997';")
assert_eq "aucun doublon (exactement 1 ligne)" "1" "$RU_COUNT_NO_DUP"

log "=== 20. RATTACHEMENT : VRAI second appel après succès -> même état, aucune erreur (B-02) ==="
LINKED_SECOND=$(sql_t -c "set test.uid = '11111111-1111-1111-1111-111111111111'; select linked from public.link_pending_owner('$NEW_RID'::uuid);")
assert_eq "second appel après succès renvoie linked=true" "t" "$LINKED_SECOND"
RU_COUNT_STILL_1=$(sql_t -c "select count(*) from public.restaurant_users where restaurant_id='$NEW_RID'::uuid and user_id='77777777-7777-7777-7777-777777777777';")
assert_eq "toujours exactement 1 ligne après le second appel" "1" "$RU_COUNT_STILL_1"

log "=== 21. RATTACHEMENT : membership sur un AUTRE établissement conservé (aucune fuite) ==="
sql -c "insert into public.restaurant_users (user_id, restaurant_id, role) values ('77777777-7777-7777-7777-777777777777', '$REF_RID'::uuid, 'manager');" >/dev/null
ROLE_OTHER_AFTER=$(sql_t -c "select role from public.restaurant_users where restaurant_id='$REF_RID'::uuid and user_id='77777777-7777-7777-7777-777777777777';")
assert_eq "rôle sur l'établissement de référence inchangé (manager, pas owner)" "manager" "$ROLE_OTHER_AFTER"

log "=== 22. CYCLE DE VIE : onboarding -> lecture publique refusée ==="
RID_LC=$(sql -c "set test.uid = '11111111-1111-1111-1111-111111111111'; select * from public.create_establishment('Cycle Vie','cycle-vie','FR','Lyon','restaurant',null,null,'+33600000020','fr',array['fr'],'EUR',null,'cyclevie@test.com',null);" | extract_uuid)
ONBOARDING_READ=$(sql_t -c "set role anon; select count(*) from public.restaurants where id='$RID_LC'::uuid;")
assert_eq "onboarding : lecture publique refusée" "0" "$ONBOARDING_READ"

log "=== 23. CYCLE DE VIE : onboarding -> create_order refusé ==="
OUT=$(sql -c "select public.create_order('cycle-vie', 'table', '[]'::jsonb, 1, '{}'::jsonb, null);" 2>&1 || true)
assert_contains "onboarding : create_order refusé" "$OUT" "introuvable ou inactif"

log "=== 24. CYCLE DE VIE : active -> lecture publique autorisée ==="
sql -c "insert into auth.users (id, email) values ('99999999-9999-9999-9999-999999999996', 'cyclevie@test.com'); insert into public.restaurant_users (user_id, restaurant_id, role) values ('99999999-9999-9999-9999-999999999996', '$RID_LC'::uuid, 'owner');" >/dev/null
sql -c "set test.uid = '11111111-1111-1111-1111-111111111111'; select public.link_pending_owner('$RID_LC'::uuid);" >/dev/null
ACTIVE_READ=$(sql_t -c "set role anon; select count(*) from public.restaurants where id='$RID_LC'::uuid;")
assert_eq "active : lecture publique autorisée après rattachement" "1" "$ACTIVE_READ"

log "=== 25. CYCLE DE VIE : active -> create_order autorisé (passe le contrôle restaurant) ==="
OUT=$(sql -c "select public.create_order('cycle-vie', 'table', '[]'::jsonb, 1, '{}'::jsonb, null);" 2>&1 || true)
assert_contains "active : create_order dépasse le contrôle restaurant (échoue plus loin, sur commande vide)" "$OUT" "Commande vide"

log "=== 26. CYCLE DE VIE : suspended -> lecture publique refusée ==="
sql -c "update public.restaurants set status='suspended' where id='$RID_LC'::uuid;" >/dev/null
SUSPENDED_READ=$(sql_t -c "set role anon; select count(*) from public.restaurants where id='$RID_LC'::uuid;")
assert_eq "suspended : lecture publique refusée" "0" "$SUSPENDED_READ"

log "=== 27. CYCLE DE VIE : suspended -> create_order refusé ==="
OUT=$(sql -c "select public.create_order('cycle-vie', 'table', '[]'::jsonb, 1, '{}'::jsonb, null);" 2>&1 || true)
assert_contains "suspended : create_order refusé" "$OUT" "introuvable ou inactif"

log "=== 28. CYCLE DE VIE : inactive -> lecture publique refusée ==="
sql -c "update public.restaurants set status='inactive' where id='$RID_LC'::uuid;" >/dev/null
INACTIVE_READ=$(sql_t -c "set role anon; select count(*) from public.restaurants where id='$RID_LC'::uuid;")
assert_eq "inactive : lecture publique refusée" "0" "$INACTIVE_READ"

log "=== 29. CYCLE DE VIE : inactive -> create_order refusé ==="
OUT=$(sql -c "select public.create_order('cycle-vie', 'table', '[]'::jsonb, 1, '{}'::jsonb, null);" 2>&1 || true)
assert_contains "inactive : create_order refusé" "$OUT" "introuvable ou inactif"

log "=== 30. CYCLE DE VIE : le propriétaire voit TOUJOURS son établissement au tableau de bord, quel que soit le statut ==="
DASHBOARD_READ=$(sql_t -c "set role authenticated; set test.uid = '99999999-9999-9999-9999-999999999996'; select count(*) from public.restaurants where id='$RID_LC'::uuid;")
assert_eq "propriétaire voit son établissement inactive (tableau de bord préservé)" "1" "$DASHBOARD_READ"

log "=== 31. CYCLE DE VIE : un tiers non membre ne voit PAS l'établissement inactive ==="
STRANGER_READ=$(sql_t -c "set role authenticated; set test.uid = '44444444-4444-4444-4444-444444444444'; select count(*) from public.restaurants where id='$RID_LC'::uuid;")
assert_eq "tiers non membre : lecture refusée" "0" "$STRANGER_READ"

# ============================================================
# TABLES ENFANT (restaurant_configs, menu_categories, menu_items) —
# corrige le 3e tour d'audit Work : sécuriser restaurants seule ne
# protège pas ces tables. Réutilise RID_LC (déjà cyclé onboarding ->
# active -> suspended -> inactive ci-dessus), avec une catégorie et
# un produit insérés directement pour pouvoir tester menu_items.
# ============================================================
log "=== 40. Préparation : catégorie + produit pour RID_LC (tables enfant) ==="
sql -c "insert into public.menu_categories (id, restaurant_id, name, display_order, is_active) values ('aaaaaaaa-0000-0000-0000-000000000001', '$RID_LC'::uuid, 'Cat Test', 1, true);" >/dev/null
sql -c "insert into public.menu_items (category_id, name, price, is_available) values ('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'Item Test', 5.0, true);" >/dev/null
pass "catégorie + produit insérés pour RID_LC (actuellement status=inactive à ce stade)"

child_tables_anon() {
  local rid="$1"
  local cfg cat item
  cfg=$(sql_t -c "set role anon; select count(*) from public.restaurant_configs where restaurant_id='$rid'::uuid;")
  cat=$(sql_t -c "set role anon; select count(*) from public.menu_categories where restaurant_id='$rid'::uuid;")
  item=$(sql_t -c "set role anon; select count(*) from public.menu_items mi join public.menu_categories mc on mc.id=mi.category_id where mc.restaurant_id='$rid'::uuid;")
  echo "$cfg/$cat/$item"
}
child_tables_member() {
  local rid="$1" uid="$2"
  local cfg cat item
  cfg=$(sql_t -c "set role authenticated; set test.uid = '$uid'; select count(*) from public.restaurant_configs where restaurant_id='$rid'::uuid;")
  cat=$(sql_t -c "set role authenticated; set test.uid = '$uid'; select count(*) from public.menu_categories where restaurant_id='$rid'::uuid;")
  item=$(sql_t -c "set role authenticated; set test.uid = '$uid'; select count(*) from public.menu_items mi join public.menu_categories mc on mc.id=mi.category_id where mc.restaurant_id='$rid'::uuid;")
  echo "$cfg/$cat/$item"
}

log "=== 41. TABLES ENFANT : inactive (état courant de RID_LC) -> anon 0/0/0 ==="
assert_eq "inactive : configs/categories/items refusés à anon" "0/0/0" "$(child_tables_anon "$RID_LC")"

log "=== 42. TABLES ENFANT : inactive -> tiers non membre 0/0/0 ==="
assert_eq "inactive : configs/categories/items refusés au tiers non membre" "0/0/0" "$(child_tables_member "$RID_LC" '44444444-4444-4444-4444-444444444444')"

log "=== 43. TABLES ENFANT : inactive -> membre (propriétaire) lecture autorisée sur les 3 tables ==="
assert_eq "inactive : configs/categories/items lisibles par le propriétaire" "1/1/1" "$(child_tables_member "$RID_LC" '99999999-9999-9999-9999-999999999996')"

log "=== 44. TABLES ENFANT : suspended -> anon 0/0/0, membre 1/1/1 ==="
sql -c "update public.restaurants set status='suspended' where id='$RID_LC'::uuid;" >/dev/null
assert_eq "suspended : configs/categories/items refusés à anon" "0/0/0" "$(child_tables_anon "$RID_LC")"
assert_eq "suspended : configs/categories/items lisibles par le propriétaire" "1/1/1" "$(child_tables_member "$RID_LC" '99999999-9999-9999-9999-999999999996')"

log "=== 45. TABLES ENFANT : onboarding -> anon 0/0/0, membre 1/1/1 ==="
sql -c "update public.restaurants set status='onboarding' where id='$RID_LC'::uuid;" >/dev/null
assert_eq "onboarding : configs/categories/items refusés à anon" "0/0/0" "$(child_tables_anon "$RID_LC")"
assert_eq "onboarding : configs/categories/items lisibles par le propriétaire" "1/1/1" "$(child_tables_member "$RID_LC" '99999999-9999-9999-9999-999999999996')"

log "=== 46. TABLES ENFANT : active -> anon 1/1/1 (rétabli), membre 1/1/1 ==="
sql -c "update public.restaurants set status='active' where id='$RID_LC'::uuid;" >/dev/null
assert_eq "active : configs/categories/items lisibles par anon" "1/1/1" "$(child_tables_anon "$RID_LC")"
assert_eq "active : configs/categories/items lisibles par le propriétaire" "1/1/1" "$(child_tables_member "$RID_LC" '99999999-9999-9999-9999-999999999996')"

log "=== 47. RÉGRESSION : Illico Presto (active, historique réel) -> configs/categories/items lisibles par anon ==="
ILLICO_RID=$(sql_t -c "select id from public.restaurants where slug='illico-presto';")
ILLICO_CHILD=$(child_tables_anon "$ILLICO_RID")
assert_contains "Illico Presto : configs lisible (au moins 1)" "$ILLICO_CHILD" "^1/"
CFG_I=$(echo "$ILLICO_CHILD" | cut -d/ -f1)
CAT_I=$(echo "$ILLICO_CHILD" | cut -d/ -f2)
ITEM_I=$(echo "$ILLICO_CHILD" | cut -d/ -f3)
assert_eq "Illico Presto : restaurant_configs lisible par anon" "1" "$CFG_I"
if [ "$CAT_I" -gt 0 ]; then pass "Illico Presto : menu_categories lisibles par anon ($CAT_I)"; else fail "Illico Presto : catégories devraient être lisibles"; fi
if [ "$ITEM_I" -gt 0 ]; then pass "Illico Presto : menu_items lisibles par anon ($ITEM_I)"; else fail "Illico Presto : produits devraient être lisibles"; fi

log "=== 48. RÉGRESSION : Le Sirocco (active, historique réel) -> configs/categories/items lisibles par anon ==="
SIROCCO_RID=$(sql_t -c "select id from public.restaurants where slug='le-sirocco';")
SIROCCO_CHILD=$(child_tables_anon "$SIROCCO_RID")
CFG_S=$(echo "$SIROCCO_CHILD" | cut -d/ -f1)
assert_eq "Le Sirocco : restaurant_configs lisible par anon" "1" "$CFG_S"

log "=== 49. RÉGRESSION : getRestaurantSettings (lecture directe réelle) fonctionne pour un établissement non-active ==="
sql -c "update public.restaurants set status='suspended' where id='$RID_LC'::uuid;" >/dev/null
SETTINGS_READ=$(sql_t -c "set role authenticated; set test.uid = '99999999-9999-9999-9999-999999999996'; select currency from public.restaurant_configs where restaurant_id='$RID_LC'::uuid;")
assert_eq "getRestaurantSettings simulé : currency lisible pour établissement suspended" "EUR" "$SETTINGS_READ"
sql -c "update public.restaurants set status='active' where id='$RID_LC'::uuid;" >/dev/null

log "=== 50. B-05 : pays fictif ZZ refusé ==="
OUT=$(sql -c "set test.uid = '11111111-1111-1111-1111-111111111111'; select * from public.create_establishment('T','t-zz','ZZ','Lyon','cheese_shop',null,null,'+33600000030','fr',array['fr'],'EUR',null,'x@y.fr',null);" 2>&1 || true)
assert_contains "pays fictif ZZ refusé" "$OUT" "SCANYM_INVALID_COUNTRY"

log "=== 51. B-05 : devise fictive ZZZ refusée ==="
OUT=$(sql -c "set test.uid = '11111111-1111-1111-1111-111111111111'; select * from public.create_establishment('T','t-zzz','FR','Lyon','cheese_shop',null,null,'+33600000031','fr',array['fr'],'ZZZ',null,'x@y.fr',null);" 2>&1 || true)
assert_contains "devise fictive ZZZ refusée" "$OUT" "SCANYM_INVALID_CURRENCY"

log "=== 52. B-05 : aucun couplage pays -> devise (Maroc + EUR accepté) ==="
RID_MA=$(sql -c "set test.uid = '11111111-1111-1111-1111-111111111111'; select * from public.create_establishment('Maroc EUR','maroc-eur','MA','Rabat','restaurant',null,null,'+212600000000','fr',array['fr'],'EUR',null,'x@y.fr',null);" | extract_uuid)
if [ -n "$RID_MA" ]; then pass "Maroc + EUR accepté (aucun couplage forcé)"; else fail "Maroc + EUR aurait dû être accepté"; fi

log "=== 53. Doublon de slug refusé ==="
OUT=$(sql -c "set test.uid = '11111111-1111-1111-1111-111111111111'; select * from public.create_establishment('Doublon','au-lait-cru','FR','Lyon','cheese_shop',null,null,'+33612345678','fr',array['fr'],'EUR',null,'x@y.fr',null);" 2>&1 || true)
assert_contains "doublon de slug refusé" "$OUT" "SCANYM_SLUG_TAKEN"

log "=== 54. Création sans catégorie initiale (facultatif) ==="
RID_NOCAT=$(sql -c "set test.uid = '11111111-1111-1111-1111-111111111111'; select * from public.create_establishment('Sans Categorie','sans-categorie','DZ','Oran','restaurant',null,null,'+213550000000','fr',array['fr'],'DZD',null,'sanscat@test.com',null);" | extract_uuid)
CAT_COUNT_NOCAT=$(sql_t -c "select count(*) from public.menu_categories where restaurant_id='$RID_NOCAT'::uuid;")
assert_eq "aucune catégorie créée quand non fournie" "0" "$CAT_COUNT_NOCAT"

log "=== 55. B-04 : droits DML directs (anon/authenticated) sur les tables sensibles ==="
for tbl in "public.restaurants" "public.restaurant_configs" "public.scanym_operators" "public.establishment_owner_invitations"; do
  for role in "anon" "authenticated"; do
    for priv in "INSERT" "UPDATE" "DELETE"; do
      CAN=$(sql_t -c "select has_table_privilege('$role', '$tbl', '$priv');")
      assert_eq "$role ne peut PAS $priv sur $tbl" "f" "$CAN"
    done
  done
done

log "=== 56. B-04 : PUBLIC lui-même n'a aucun droit DML effectif sur restaurants ==="
for priv in "INSERT" "UPDATE" "DELETE"; do
  CAN=$(sql_t -c "select has_table_privilege('public', 'public.restaurants', '$priv');")
  assert_eq "PUBLIC ne peut PAS $priv sur restaurants" "f" "$CAN"
done

log "=== 57. anon ne peut exécuter aucune RPC Lot D ==="
for fn in "is_scanym_operator" "create_establishment" "link_pending_owner" "get_establishment_summary"; do
  CAN=$(sql_t -c "select has_function_privilege('anon', p.oid, 'EXECUTE') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='$fn' limit 1;")
  assert_eq "anon ne peut PAS exécuter $fn" "f" "$CAN"
done

# ============================================================
# CORRECTIF RLS TABLES DE RÉFÉRENCE — migration corrective séparée
# (migration-lotd-rls-reference-tables-fix.sql), post-déploiement
# production. Confirme d'abord le bug AVANT correctif, puis applique
# et revérifie.
# ============================================================
log "=== 58. AVANT correctif : RLS désactivée sur les 2 tables de référence (bug confirmé) ==="
RLS_COUNTRIES_BEFORE=$(sql_t -c "select relrowsecurity from pg_class where relname='scanym_supported_countries';")
assert_eq "scanym_supported_countries : RLS désactivée avant correctif" "f" "$RLS_COUNTRIES_BEFORE"
RLS_CURRENCIES_BEFORE=$(sql_t -c "select relrowsecurity from pg_class where relname='scanym_supported_currencies';")
assert_eq "scanym_supported_currencies : RLS désactivée avant correctif" "f" "$RLS_CURRENCIES_BEFORE"

log "=== 59. Application du correctif migration-lotd-rls-reference-tables-fix.sql ==="
sql -f "$SUPABASE_DIR/migration-lotd-rls-reference-tables-fix.sql"
pass "correctif RLS appliqué sans erreur"

log "=== 60. APRÈS correctif : relrowsecurity = true sur les 2 tables ==="
RLS_COUNTRIES_AFTER=$(sql_t -c "select relrowsecurity from pg_class where relname='scanym_supported_countries';")
assert_eq "scanym_supported_countries : RLS activée après correctif" "t" "$RLS_COUNTRIES_AFTER"
RLS_CURRENCIES_AFTER=$(sql_t -c "select relrowsecurity from pg_class where relname='scanym_supported_currencies';")
assert_eq "scanym_supported_currencies : RLS activée après correctif" "t" "$RLS_CURRENCIES_AFTER"

log "=== 61. authenticated peut lire les 4 pays et les 5 devises ==="
COUNTRIES_COUNT=$(sql_t -c "set role authenticated; select count(*) from public.scanym_supported_countries;")
assert_eq "authenticated lit les 4 pays supportés" "4" "$COUNTRIES_COUNT"
CURRENCIES_COUNT=$(sql_t -c "set role authenticated; select count(*) from public.scanym_supported_currencies;")
assert_eq "authenticated lit les 5 devises supportées" "5" "$CURRENCIES_COUNT"

log "=== 62. anon ne peut lire aucune des deux tables ==="
set +e
ANON_COUNTRIES=$(sql -c "set role anon; select count(*) from public.scanym_supported_countries;" 2>&1)
set -e
assert_contains "anon refusé sur scanym_supported_countries" "$ANON_COUNTRIES" "permission denied"
set +e
ANON_CURRENCIES=$(sql -c "set role anon; select count(*) from public.scanym_supported_currencies;" 2>&1)
set -e
assert_contains "anon refusé sur scanym_supported_currencies" "$ANON_CURRENCIES" "permission denied"

log "=== 63. Aucun droit d'écriture (anon/authenticated/PUBLIC) sur les 2 tables ==="
for tbl in "public.scanym_supported_countries" "public.scanym_supported_currencies"; do
  for role in "anon" "authenticated" "public"; do
    for priv in "INSERT" "UPDATE" "DELETE"; do
      CAN=$(sql_t -c "select has_table_privilege('$role', '$tbl', '$priv');")
      assert_eq "$role ne peut PAS $priv sur $tbl" "f" "$CAN"
    done
  done
done

log "=== 64. create_establishment (SECURITY DEFINER) continue de valider pays/devise sous RLS ==="
RID_RLS=$(sql -c "set test.uid = '11111111-1111-1111-1111-111111111111'; select * from public.create_establishment('Test RLS','test-rls','FR','Lyon','cheese_shop',null,null,'+33612345699','fr',array['fr'],'EUR',null,'x@y.fr',null);" | extract_uuid)
if [ -n "$RID_RLS" ]; then pass "create_establishment réussit toujours avec un pays/devise valides, sous RLS"; else fail "create_establishment aurait dû réussir"; fi
OUT=$(sql -c "set test.uid = '11111111-1111-1111-1111-111111111111'; select * from public.create_establishment('Test RLS 2','test-rls-2','ZZ','Lyon','cheese_shop',null,null,'+33612345698','fr',array['fr'],'EUR',null,'x@y.fr',null);" 2>&1 || true)
assert_contains "create_establishment rejette toujours un pays fictif, sous RLS" "$OUT" "SCANYM_INVALID_COUNTRY"

log "=== 65. Aucun autre objet Lot D modifié (RLS des autres tables inchangée) ==="
for tbl in "scanym_operators" "establishment_owner_invitations" "restaurants" "restaurant_configs" "menu_categories" "menu_items"; do
  RLS_OTHER=$(sql_t -c "select relrowsecurity from pg_class where relname='$tbl';")
  assert_eq "$tbl : RLS toujours activée (inchangé par ce correctif)" "t" "$RLS_OTHER"
done

log "=== 66. Rollback testé : retire la policy et désactive RLS proprement ==="
sql -f "$SUPABASE_DIR/migration-lotd-rls-reference-tables-fix-rollback.sql"
RLS_AFTER_ROLLBACK=$(sql_t -c "select relrowsecurity from pg_class where relname='scanym_supported_countries';")
assert_eq "rollback : RLS désactivée à nouveau" "f" "$RLS_AFTER_ROLLBACK"

log "=== 67. Réapplication après rollback réussit, double application (sans rollback) est bloquée ==="
sql -f "$SUPABASE_DIR/migration-lotd-rls-reference-tables-fix.sql" >/dev/null
pass "réapplication après rollback réussie"
set +e
DOUBLE_APPLY=$(sql -f "$SUPABASE_DIR/migration-lotd-rls-reference-tables-fix.sql" 2>&1)
DOUBLE_APPLY_EXIT=$?
set -e
assert_eq "double application (sans rollback) bloquée" "1" "$([ "$DOUBLE_APPLY_EXIT" -ne 0 ] && echo 1 || echo 0)"
assert_contains "message explicite sur la double application" "$DOUBLE_APPLY" "SCANYM_SCHEMA_DRIFT"

log "=== RÉSULTAT FINAL : $PASS_COUNT réussis, $FAIL_COUNT échoués ==="
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
echo "TOUS LES TESTS LOT D ONT REUSSI"
