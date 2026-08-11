#!/usr/bin/env bash
# ============================================================
# Scanym V66 — Scénarios positifs/négatifs du contrôle préalable,
# reproductibles
#
# Écrit après le 3e audit indépendant, qui a relevé que les quatre
# scénarios annoncés dans le rapport (état A, état B, absence de
# SELECT, index préexistant) n'étaient PAS présents dans le harnais
# versionné — seule une exécution manuelle, non rejouable, en avait
# été faite. Corrigé : chaque scénario a ici sa propre base éphémère,
# avec une assertion explicite sur le résultat attendu (succès ou
# échec) ET une preuve que l'état (signatures RPC) est resté celui
# d'avant la tentative après un échec — pas seulement que la commande
# a renvoyé une erreur.
#
# CORRECTION SA3-M02 (audit Work, 11 août 2026), deux points :
#
# 1. Terminologie. La version précédente appelait ces 5 scénarios
#    « 5 scénarios négatifs », alors que 2 d'entre eux (état A, état
#    B) sont des scénarios POSITIFS : la migration doit y RÉUSSIR.
#    Corrigé : les scénarios sont désormais explicitement regroupés en
#    2 SCÉNARIOS POSITIFS (succès attendu) et 6 SCÉNARIOS NÉGATIFS
#    (échec attendu), numérotés séparément (P1/P2, N1..N6) plutôt que
#    comptés ensemble sous un seul intitulé trompeur.
#
# 2. Nettoyage. La version précédente ne suivait qu'une seule base
#    "courante" (CURRENT_DB) et ne nettoyait, via le trap EXIT, que
#    la dernière base créée : les bases des scénarios précédents
#    restaient en base après un run complet. Corrigé : chaque base
#    créée est ajoutée à un tableau CREATED_DBS ; cleanup_all() les
#    supprime TOUTES, appelée à la fois explicitement en fin de script
#    (assertion dédiée : aucune base du run ne subsiste) et via trap
#    EXIT comme filet de sécurité en cas d'échec du script lui-même
#    (set -e, interruption...). cleanup_all() est idempotente, donc
#    son double appel (fin normale + trap) est sans danger.
#
# CORRECTION supplémentaire après un second passage de l'audit Work
# (même date), deux points :
#
# 3. Rôle cluster-global non nettoyé. Le scénario de privilège hérité
#    (N5 ci-dessous) crée un rôle PostgreSQL — `scanym_v66_role_tiers`
#    — qui, contrairement aux bases de données, N'EST PAS local à une
#    base : les rôles vivent au niveau du CLUSTER. La version
#    précédente ne le supprimait jamais : après un run, le rôle et
#    l'appartenance `anon` à ce rôle restaient en place indéfiniment,
#    même si les bases éphémères qui l'utilisaient avaient bien été
#    supprimées. Corrigé : cleanup_all() révoque désormais aussi
#    l'appartenance (`revoke scanym_v66_role_tiers from anon`) PUIS
#    supprime le rôle (`drop role if exists`) — dans cet ordre, et
#    après la suppression des bases (un rôle ne peut être supprimé
#    tant qu'il détient des privilèges sur des objets encore existants
#    ; supprimer d'abord les bases élimine ces privilèges avec elles).
#    Vérification post-run dédiée : aucune base scanym_v66%, aucun
#    rôle scanym_v66_role_tiers, aucune appartenance résiduelle.
#
# 4. Preuve ACL au niveau catalogue, pas seulement sémantique
#    transactionnelle. Les scénarios N2-N5 précédents prouvaient que
#    la migration échoue et que la SIGNATURE de create_product reste
#    inchangée après l'échec — mais aucun ne capturait l'ACL réelle de
#    menu_categories AVANT la tentative puis APRÈS l'échec pour
#    prouver, au niveau du catalogue système, que le REVOKE de la
#    section 2a (qui a réellement modifié le catalogue à l'intérieur
#    de la transaction avant que 2a-bis ne la fasse échouer) a bien
#    été défait par le ROLLBACK — un raisonnement qui reposait jusqu'ici
#    sur la confiance dans la sémantique transactionnelle de
#    PostgreSQL, pas sur une mesure directe. Nouveau scénario N6 :
#    combine l'état A (droits directs REFERENCES/TRIGGER/TRUNCATE sur
#    anon/authenticated, que le REVOKE modifie réellement) avec un
#    privilège hérité (que 2a-bis détecte et fait échouer APRÈS le
#    REVOKE). L'ACL exacte de menu_categories (via
#    information_schema.role_table_grants) est capturée avant la
#    tentative et reCapturée après l'échec : assertion d'égalité
#    stricte, pas seulement "la commande a renvoyé une erreur".
#
# Ajoute aussi les scénarios découverts par le 3e audit lui-même
# (GRANT INSERT ... TO PUBLIC, SA3-B01 ; collision de nom d'index sur
# une AUTRE table, SA3-M01) et, après l'audit Work du 11 août 2026 :
# GRANT TRUNCATE ... TO PUBLIC (exemple explicitement exigé par
# SA3-B01) et un privilège TRUNCATE accordé via un RÔLE HÉRITÉ (ni
# PUBLIC ni un grant direct à anon/authenticated).
#
# Usage : depuis la racine du dépôt (contenant supabase/) :
#   su postgres -c "bash supabase/tests/v66-integration-test-negative.sh"
#
# Aucun secret, aucun accès Supabase/production. Chaque base éphémère
# ET chaque rôle cluster-global créés par ce run sont supprimés à la
# fin, y compris en cas d'échec du script lui-même (trap EXIT).
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"

PASS_COUNT=0
FAIL_COUNT=0
declare -a CREATED_DBS=()
declare -a CREATED_ROLES=()

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); log "FAIL: $*"; }

# Supprime TOUTES les bases ET TOUS les rôles cluster-globaux créés
# par ce run — pas seulement la dernière base comme dans la version
# précédente, et pas seulement les bases (les rôles ne sont pas locaux
# à une base). Idempotente : peut être appelée plusieurs fois sans
# erreur (fin normale du script, puis trap EXIT en filet de sécurité).
#
# Ordre important : les bases sont supprimées EN PREMIER. Un rôle qui
# détient encore un privilège sur une table d'une base existante ne
# peut pas être supprimé (DROP ROLE échoue tant que des privilèges lui
# sont accordés quelque part dans le cluster) ; supprimer les bases
# élimine ces privilèges avec elles (DROP DATABASE emporte tous les
# objets et grants qu'elle contenait), rendant le rôle "propre" avant
# sa propre suppression.
cleanup_all() {
  local db role
  for db in "${CREATED_DBS[@]:-}"; do
    [ -n "$db" ] || continue
    psql -c "drop database if exists \"$db\";" >/dev/null 2>&1 || true
  done
  for role in "${CREATED_ROLES[@]:-}"; do
    [ -n "$role" ] || continue
    # Révoque l'appartenance AVANT de supprimer le rôle : un rôle
    # encore membre d'un autre rôle ne bloque pas DROP ROLE en soi,
    # mais on rend l'opération explicite et son échec visible plutôt
    # que de compter sur la cascade implicite de DROP ROLE.
    psql -c "revoke \"$role\" from anon;" >/dev/null 2>&1 || true
    psql -c "drop role if exists \"$role\";" >/dev/null 2>&1 || true
  done
}
trap cleanup_all EXIT

# Enregistre un rôle cluster-global pour nettoyage garanti, sans le
# recréer ni le re-suivre s'il l'est déjà (plusieurs scénarios peuvent
# réutiliser le même nom de rôle).
track_role() {
  local role="$1" r
  for r in "${CREATED_ROLES[@]:-}"; do
    [ "$r" = "$role" ] && return 0
  done
  CREATED_ROLES+=("$role")
}

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -q "$needle"; then pass "$desc"; else fail "$desc — motif '$needle' introuvable"; fi
}
assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$desc (=$actual)"; else fail "$desc — attendu '$expected', obtenu '$actual'"; fi
}

# Construit une base V65 fraîche nommée $1, sans données de test, et
# l'enregistre dans CREATED_DBS pour nettoyage garanti en fin de run.
bootstrap_v65() {
  local db="$1"
  CREATED_DBS+=("$db")
  psql -c "drop database if exists \"$db\";" >/dev/null
  createdb "$db"
  psql -d "$db" -v ON_ERROR_STOP=1 >/dev/null <<SQL
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
SQL
  for f in schema.sql migration-orders.sql migration-orders-lang.sql \
           migration-v29-merchant-dashboard.sql migration-v31-catalogue.sql \
           migration-translations.sql migration-v39-settings.sql \
           migration-v43-catalogue-i18n.sql migration-v55-updated-at.sql \
           migration-v64-dashboard-auth-whatsapp.sql migration-v65-order-note.sql; do
    psql -d "$db" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/$f" >/dev/null 2>&1
  done
}

v65_signature_count() {
  psql -d "$1" -t -A -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_product' and pg_get_function_identity_arguments(p.oid)='p_category_id uuid, p_name text, p_description text, p_price numeric';"
}

# ACL exacte (triée, stable) de menu_categories pour anon/authenticated
# — utilisée par N6 pour prouver, au niveau catalogue et pas seulement
# au niveau signature de fonction, qu'un REVOKE exécuté PUIS annulé
# par un échec ultérieur dans la MÊME transaction ne laisse aucune
# trace.
menu_categories_acl() {
  psql -d "$1" -t -A -c "select string_agg(grantee || ':' || privilege_type, ',' order by grantee, privilege_type) from information_schema.role_table_grants where table_schema='public' and table_name='menu_categories' and grantee in ('anon','authenticated');"
}

# Crée (si nécessaire) un rôle cluster-global tiers portant TRUNCATE
# sur menu_categories, dont $2 devient membre — utilisé pour simuler
# un privilège hérité, ni accordé à PUBLIC ni directement à
# anon/authenticated. Le rôle est enregistré pour nettoyage garanti.
grant_via_inherited_role() {
  local db="$1" member="$2" role="scanym_v66_role_tiers"
  track_role "$role"
  psql -d "$db" -v ON_ERROR_STOP=1 <<SQL >/dev/null
do \$\$ begin
  if not exists (select from pg_roles where rolname = '$role') then
    create role $role nologin;
  end if;
end \$\$;
grant truncate on table public.menu_categories to $role;
grant $role to $member;
SQL
}

# ==================================================================
# SCÉNARIOS POSITIFS — la migration DOIT réussir.
# ==================================================================

# ------------------------------------------------------------------
# P1 : État A (droits historiques réels avant révocation manuelle).
# ------------------------------------------------------------------
log "=== Scénario positif P1/2 : état A (SELECT+REFERENCES+TRIGGER+TRUNCATE) -> succès attendu ==="
DB="scanym_v66_pos_a_$$"
bootstrap_v65 "$DB"
psql -d "$DB" -c "grant select, references, trigger, truncate on all tables in schema public to anon, authenticated;" >/dev/null
OUT=$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v66-categories-descriptions.sql" 2>&1) && RC=0 || RC=$?
assert_eq "P1 état A : migration réussit (code retour)" "0" "$RC"
assert_contains "P1 état A : COMMIT atteint" "$OUT" "COMMIT"

# ------------------------------------------------------------------
# P2 : État B (droits actuels, SELECT seul).
# ------------------------------------------------------------------
log "=== Scénario positif P2/2 : état B (SELECT seul) -> succès attendu ==="
DB="scanym_v66_pos_b_$$"
bootstrap_v65 "$DB"
psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null
OUT=$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v66-categories-descriptions.sql" 2>&1) && RC=0 || RC=$?
assert_eq "P2 état B : migration réussit (code retour)" "0" "$RC"
assert_contains "P2 état B : COMMIT atteint" "$OUT" "COMMIT"

# ==================================================================
# SCÉNARIOS NÉGATIFS — la migration DOIT échouer, et l'état (signature
# V65) doit rester inchangé après l'échec.
# ==================================================================

# ------------------------------------------------------------------
# N1 : aucun droit SELECT du tout.
# ------------------------------------------------------------------
log "=== Scénario négatif N1/6 : aucun droit SELECT -> échec attendu, état inchangé ==="
DB="scanym_v66_neg_noselect_$$"
bootstrap_v65 "$DB"
BEFORE=$(v65_signature_count "$DB")
OUT=$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v66-categories-descriptions.sql" 2>&1) && RC=0 || RC=$?
assert_eq "N1 absence de SELECT : la migration échoue (code retour)" "1" "$([ "$RC" -ne 0 ] && echo 1 || echo 0)"
assert_contains "N1 absence de SELECT : message explicite" "$OUT" "SCANYM_SCHEMA_DRIFT"
assert_contains "N1 absence de SELECT : mentionne SELECT" "$OUT" "SELECT"
AFTER=$(v65_signature_count "$DB")
assert_eq "N1 absence de SELECT : signature V65 inchangée après l'échec" "$BEFORE" "$AFTER"

# ------------------------------------------------------------------
# N2 (SA3-B01) : GRANT INSERT ... TO PUBLIC — la migration DOIT
# échouer même si les grants directs à anon/authenticated semblent
# conformes ({SELECT} seul).
# ------------------------------------------------------------------
log "=== Scénario négatif N2/6 (SA3-B01) : INSERT accordé à PUBLIC -> échec attendu, état inchangé ==="
DB="scanym_v66_neg_public_insert_$$"
bootstrap_v65 "$DB"
psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null
psql -d "$DB" -c "grant insert on table public.menu_categories to public;" >/dev/null
DIRECT_GRANTS=$(psql -d "$DB" -t -A -c "select string_agg(distinct privilege_type,',') from information_schema.role_table_grants where table_schema='public' and table_name='menu_categories' and grantee in ('anon','authenticated');")
assert_eq "N2 grants directs semblent conformes (SELECT seul)" "SELECT" "$DIRECT_GRANTS"
BEFORE=$(v65_signature_count "$DB")
OUT=$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v66-categories-descriptions.sql" 2>&1) && RC=0 || RC=$?
assert_eq "N2 PUBLIC INSERT : la migration échoue (code retour)" "1" "$([ "$RC" -ne 0 ] && echo 1 || echo 0)"
assert_contains "N2 PUBLIC INSERT : message explicite" "$OUT" "SCANYM_SCHEMA_DRIFT"
assert_contains "N2 PUBLIC INSERT : mentionne INSERT" "$OUT" "INSERT"
AFTER=$(v65_signature_count "$DB")
assert_eq "N2 PUBLIC INSERT : signature V65 inchangée après l'échec" "$BEFORE" "$AFTER"

# ------------------------------------------------------------------
# N3 (SA3-B01, exemple explicitement exigé par l'audit Work) :
# GRANT TRUNCATE ... TO PUBLIC — la migration DOIT échouer. C'est
# précisément le cas que la version précédente du contrôle laissait
# passer (seuls INSERT/UPDATE/DELETE étaient vérifiés via PUBLIC,
# jamais TRUNCATE/REFERENCES/TRIGGER).
# ------------------------------------------------------------------
log "=== Scénario négatif N3/6 (SA3-B01) : TRUNCATE accordé à PUBLIC -> échec attendu, état inchangé ==="
DB="scanym_v66_neg_public_truncate_$$"
bootstrap_v65 "$DB"
psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null
psql -d "$DB" -c "grant truncate on table public.menu_categories to public;" >/dev/null
DIRECT_GRANTS=$(psql -d "$DB" -t -A -c "select string_agg(distinct privilege_type,',') from information_schema.role_table_grants where table_schema='public' and table_name='menu_categories' and grantee in ('anon','authenticated');")
assert_eq "N3 grants directs semblent conformes (SELECT seul)" "SELECT" "$DIRECT_GRANTS"
BEFORE=$(v65_signature_count "$DB")
OUT=$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v66-categories-descriptions.sql" 2>&1) && RC=0 || RC=$?
assert_eq "N3 PUBLIC TRUNCATE : la migration échoue (code retour)" "1" "$([ "$RC" -ne 0 ] && echo 1 || echo 0)"
assert_contains "N3 PUBLIC TRUNCATE : message explicite" "$OUT" "SCANYM_SCHEMA_DRIFT"
assert_contains "N3 PUBLIC TRUNCATE : mentionne TRUNCATE" "$OUT" "TRUNCATE"
AFTER=$(v65_signature_count "$DB")
assert_eq "N3 PUBLIC TRUNCATE : signature V65 inchangée après l'échec" "$BEFORE" "$AFTER"

# ------------------------------------------------------------------
# N4 (SA3-B01, privilège hérité) : TRUNCATE accordé non pas à PUBLIC
# ni directement à anon, mais à un rôle tiers dont anon est ensuite
# rendu membre (`grant role_tiers to anon`). Ni le contrôle PUBLIC
# (grantee=0) ni les grants directs à anon/authenticated ne
# détecteraient ce cas ; seul has_table_privilege(), qui résout
# l'appartenance aux rôles, le voit — c'est le contrôle post-REVOKE
# (2a-bis) qui doit bloquer ici, PAS le contrôle pré-transaction
# PUBLIC-only.
# ------------------------------------------------------------------
log "=== Scénario négatif N4/6 (SA3-B01) : TRUNCATE via un rôle hérité -> échec attendu, état inchangé ==="
DB="scanym_v66_neg_inherited_$$"
bootstrap_v65 "$DB"
psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null
grant_via_inherited_role "$DB" anon
DIRECT_GRANTS=$(psql -d "$DB" -t -A -c "select string_agg(distinct privilege_type,',') from information_schema.role_table_grants where table_schema='public' and table_name='menu_categories' and grantee in ('anon','authenticated');")
assert_eq "N4 grants directs semblent conformes (SELECT seul)" "SELECT" "$DIRECT_GRANTS"
EFFECTIVE=$(psql -d "$DB" -t -A -c "select has_table_privilege('anon', 'public.menu_categories', 'TRUNCATE');")
assert_eq "N4 TRUNCATE effectif pour anon via le rôle hérité (contrôle indépendant)" "t" "$EFFECTIVE"
BEFORE=$(v65_signature_count "$DB")
OUT=$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v66-categories-descriptions.sql" 2>&1) && RC=0 || RC=$?
assert_eq "N4 privilège hérité : la migration échoue (code retour)" "1" "$([ "$RC" -ne 0 ] && echo 1 || echo 0)"
assert_contains "N4 privilège hérité : message explicite" "$OUT" "SCANYM_SCHEMA_DRIFT"
assert_contains "N4 privilège hérité : mentionne TRUNCATE" "$OUT" "TRUNCATE"
AFTER=$(v65_signature_count "$DB")
assert_eq "N4 privilège hérité : signature V65 inchangée après l'échec" "$BEFORE" "$AFTER"

# ------------------------------------------------------------------
# N5 (SA3-M01) : index homonyme sur une AUTRE table (menu_items, pas
# menu_categories).
# ------------------------------------------------------------------
log "=== Scénario négatif N5/6 (SA3-M01) : index homonyme sur une autre table -> échec attendu, état inchangé ==="
DB="scanym_v66_neg_idx_$$"
bootstrap_v65 "$DB"
psql -d "$DB" -c "grant select on all tables in schema public to anon, authenticated;" >/dev/null
psql -d "$DB" -c "create unique index idx_menu_categories_unique_active_name on public.menu_items(id);" >/dev/null
BEFORE=$(v65_signature_count "$DB")
OUT=$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v66-categories-descriptions.sql" 2>&1) && RC=0 || RC=$?
assert_eq "N5 collision d'index : la migration échoue (code retour)" "1" "$([ "$RC" -ne 0 ] && echo 1 || echo 0)"
assert_contains "N5 collision d'index : message explicite" "$OUT" "SCANYM_SCHEMA_DRIFT"
assert_contains "N5 collision d'index : mentionne idx_menu_categories_unique_active_name" "$OUT" "idx_menu_categories_unique_active_name"
AFTER=$(v65_signature_count "$DB")
assert_eq "N5 collision d'index : signature V65 inchangée après l'échec" "$BEFORE" "$AFTER"

# ------------------------------------------------------------------
# N6 (audit Work, preuve ACL au niveau catalogue) : état A (droits
# directs REFERENCES/TRIGGER/TRUNCATE sur anon/authenticated — ceux
# que le REVOKE de la section 2a modifie RÉELLEMENT) combiné à un
# privilège hérité (celui que 2a-bis détecte et fait échouer, APRÈS
# que le REVOKE a déjà tourné dans la même transaction). Capture
# l'ACL exacte de menu_categories AVANT la tentative et la reCapture
# APRÈS l'échec : preuve directe, au niveau du catalogue système, que
# le ROLLBACK défait bien le REVOKE — pas une déduction à partir du
# code retour ou de la sémantique transactionnelle supposée.
# ------------------------------------------------------------------
log "=== Scénario négatif N6/6 (preuve ACL avant/après REVOKE annulé) : état A + privilège hérité -> échec attendu, ACL catalogue inchangée ==="
DB="scanym_v66_neg_acl_proof_$$"
bootstrap_v65 "$DB"
psql -d "$DB" -c "grant select, references, trigger, truncate on all tables in schema public to anon, authenticated;" >/dev/null
grant_via_inherited_role "$DB" authenticated
ACL_BEFORE=$(menu_categories_acl "$DB")
assert_contains "N6 état initial : anon a TRUNCATE direct avant la tentative" "$ACL_BEFORE" "anon:TRUNCATE"
assert_contains "N6 état initial : authenticated a TRUNCATE direct avant la tentative" "$ACL_BEFORE" "authenticated:TRUNCATE"
BEFORE=$(v65_signature_count "$DB")
OUT=$(psql -d "$DB" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/migration-v66-categories-descriptions.sql" 2>&1) && RC=0 || RC=$?
assert_eq "N6 preuve ACL : la migration échoue (code retour)" "1" "$([ "$RC" -ne 0 ] && echo 1 || echo 0)"
assert_contains "N6 preuve ACL : message explicite" "$OUT" "SCANYM_SCHEMA_DRIFT"
assert_contains "N6 preuve ACL : mentionne TRUNCATE" "$OUT" "TRUNCATE"
# Preuve indirecte déjà utilisée par N1-N5 : la signature ne bouge pas.
AFTER=$(v65_signature_count "$DB")
assert_eq "N6 preuve ACL : signature V65 inchangée après l'échec" "$BEFORE" "$AFTER"
# Preuve DIRECTE au niveau catalogue, exigée par l'audit Work : l'ACL
# exacte de menu_categories (grantee:privilège, triée) est identique
# avant la tentative et après l'échec — le REVOKE de la section 2a a
# bien tourné dans la transaction (sinon la migration aurait échoué
# dès le contrôle pré-transaction, avant même begin;), et son effet a
# bien été défait par le ROLLBACK consécutif à l'échec de 2a-bis.
ACL_AFTER=$(menu_categories_acl "$DB")
assert_eq "N6 preuve ACL : ACL catalogue de menu_categories strictement identique avant/après l'échec" "$ACL_BEFORE" "$ACL_AFTER"

# ==================================================================
# Nettoyage explicite et vérifié — SA3-M02 (bases ET rôles).
#
# cleanup_all() supprime toutes les bases ET tous les rôles suivis par
# ce run. Appelée ici explicitement (pas seulement via le trap EXIT)
# pour pouvoir vérifier et COMPTER le résultat comme des assertions à
# part entière, avant le message récapitulatif final.
# ==================================================================
log "=== Nettoyage : suppression des ${#CREATED_DBS[@]} bases et ${#CREATED_ROLES[@]} rôle(s) temporaires créés par ce run ==="
cleanup_all

REMAINING_DBS=$(psql -t -A -c "select count(*) from pg_database where datname like 'scanym_v66%';")
assert_eq "Nettoyage : aucune base scanym_v66% ne subsiste" "0" "$REMAINING_DBS"

REMAINING_ROLE=$(psql -t -A -c "select count(*) from pg_roles where rolname = 'scanym_v66_role_tiers';")
assert_eq "Nettoyage : le rôle scanym_v66_role_tiers ne subsiste pas" "0" "$REMAINING_ROLE"

REMAINING_MEMBERSHIP=$(psql -t -A -c "select count(*) from pg_auth_members m join pg_roles r on r.oid = m.roleid where r.rolname = 'scanym_v66_role_tiers';")
assert_eq "Nettoyage : aucune appartenance résiduelle à scanym_v66_role_tiers" "0" "$REMAINING_MEMBERSHIP"

log "=== RÉSULTAT FINAL : $PASS_COUNT réussis, $FAIL_COUNT échoués (2 scénarios positifs, 6 scénarios négatifs, 3 vérifications de nettoyage) ==="
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
echo "TOUS LES SCÉNARIOS (POSITIFS ET NÉGATIFS) ET LE NETTOYAGE (BASES + RÔLES) ONT RÉUSSI"
