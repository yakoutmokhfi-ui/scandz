-- =====================================================================
-- DELIVERY CUSTOMER TEXT 1000 v1 — PRÉ-VOL PRODUCTION, LECTURE SEULE
--
-- À JOUER AVANT toute application de
-- supabase/DRAFT-lot-delivery-customer-text-1000-v1.sql sur Supabase
-- PROD, par un opérateur disposant d'un accès en LECTURE.
--
-- CE FICHIER N'ÉCRIT RIEN. Aucun ALTER, aucun CREATE, aucun DROP,
-- aucun INSERT/UPDATE/DELETE, aucune fonction redéfinie. Il ouvre une
-- transaction en LECTURE SEULE et la referme par ROLLBACK : même une
-- erreur d'exploitation ne peut rien modifier.
--
-- RÈGLE D'EXPLOITATION : si la moindre ligne de la sortie porte
-- « DIFFÈRE », la migration NE DOIT PAS être appliquée. Le schéma réel
-- ne correspond alors pas aux préconditions exactes du lot, et le
-- fichier aller refuserait de toute façon de s'appliquer (il compare
-- les mêmes définitions) -- mais on le constate ici, à froid, sans
-- ouvrir de transaction d'écriture en production.
--
-- Usage :
--   psql "<URL DE CONNEXION PROD EN LECTURE>" -X -f \
--     supabase/tests/delivery-customer-text-1000-v1-PROD-PREFLIGHT-readonly.sql
-- =====================================================================

begin read only;

\echo '=== 1. DÉFINITIONS CANONIQUES ATTENDUES (références du lot) ==='
\echo 'source  : CHECK (((customer_text IS NULL) OR (length(customer_text) <= 500)))'
\echo 'cliché  : CHECK (((customer_text IS NULL) OR (length(customer_text) <= 500)))'
\echo 'par mode: CHECK (((customer_text IS NULL) OR (length(customer_text) <= 500)))  [hors périmètre, doit rester tel quel]'
\echo ''

\echo '=== 2. CONTRAINTES CHECK RÉELLES SUR customer_text ==='
select
  c.conrelid::regclass::text                                         as "table",
  c.conname                                                          as "contrainte",
  regexp_replace(pg_get_constraintdef(c.oid), '\s+', ' ', 'g')       as "définition réelle",
  case
    when regexp_replace(pg_get_constraintdef(c.oid), '\s+', ' ', 'g')
         = 'CHECK (((customer_text IS NULL) OR (length(customer_text) <= 500)))'
      then 'CONFORME'
    else 'DIFFÈRE -- NE PAS APPLIQUER'
  end                                                                as "verdict"
from pg_catalog.pg_constraint c
where c.contype = 'c'
  and c.conrelid in (
    'public.restaurant_sale_mode_fulfillments'::regclass,
    'public.order_delivery_fulfillment_snapshot'::regclass,
    'public.restaurant_sale_modes'::regclass)
  and pg_get_constraintdef(c.oid) like '%customer_text%'
order by 1, 2;

\echo ''
\echo '=== 3. NOMBRE DE CONTRAINTES PAR TABLE (une seule attendue par table) ==='
select
  t.rel::regclass::text as "table",
  count(c.oid)          as "contraintes CHECK sur customer_text",
  case when count(c.oid) = 1 then 'CONFORME' else 'DIFFÈRE -- NE PAS APPLIQUER' end as "verdict"
from (values
        ('public.restaurant_sale_mode_fulfillments'::regclass),
        ('public.order_delivery_fulfillment_snapshot'::regclass),
        ('public.restaurant_sale_modes'::regclass)) as t(rel)
left join pg_catalog.pg_constraint c
  on c.conrelid = t.rel and c.contype = 'c'
 and pg_get_constraintdef(c.oid) like '%customer_text%'
group by t.rel
order by 1;

\echo ''
\echo '=== 4. GARDE APPLICATIVE DE LA RPC D''ÉCRITURE ==='
select
  'update_merchant_delivery_fulfillment_pricing' as "fonction",
  case
    when pg_get_functiondef(p.oid) like '%customer_text exceeds 500 characters%'
         and pg_get_functiondef(p.oid) not like '%exceeds 1000 characters%'
      then 'CONFORME (garde à 500, lot non encore appliqué)'
    when pg_get_functiondef(p.oid) like '%customer_text exceeds 1000 characters%'
      then 'DÉJÀ APPLIQUÉ -- la migration refuserait (SCANYM_ALREADY_APPLIED)'
    else 'DIFFÈRE -- NE PAS APPLIQUER'
  end                                            as "verdict",
  p.prosecdef                                    as "security definer",
  has_function_privilege('anon', p.oid, 'execute')          as "anon peut exécuter (doit être false)",
  has_function_privilege('authenticated', p.oid, 'execute') as "authenticated peut exécuter (doit être true)"
from pg_catalog.pg_proc p
where p.oid = to_regprocedure(
  'public.update_merchant_delivery_fulfillment_pricing(uuid,text,numeric,numeric,text)');

\echo ''
\echo '=== 5. PRÉSENCE DES OBJETS HORS PÉRIMÈTRE (doivent exister, non modifiés) ==='
select 'mutate_merchant_delivery_rule(uuid,text,uuid,jsonb)' as "objet",
       to_regprocedure('public.mutate_merchant_delivery_rule(uuid,text,uuid,jsonb)') is not null as "présent"
union all
select 'create_order(text,text,jsonb,integer,jsonb,text,text,boolean)',
       to_regprocedure('public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)') is not null
union all
select 'update_merchant_delivery_method_notice(uuid,text,text)',
       to_regprocedure('public.update_merchant_delivery_method_notice(uuid,text,text)') is not null;

\echo ''
\echo '=== 6. DONNÉES — longueurs réelles (information, aucune écriture) ==='
select 'restaurant_sale_mode_fulfillments' as "table",
       count(*)                            as "lignes avec texte",
       coalesce(max(length(customer_text)), 0) as "longueur max",
       count(*) filter (where length(customer_text) > 500) as "déjà > 500 (doit être 0)"
from public.restaurant_sale_mode_fulfillments where customer_text is not null
union all
select 'order_delivery_fulfillment_snapshot',
       count(*), coalesce(max(length(customer_text)), 0),
       count(*) filter (where length(customer_text) > 500)
from public.order_delivery_fulfillment_snapshot where customer_text is not null;

\echo ''
\echo '=== 7. CONTEXTE (pour la trace d''audit) ==='
select current_database() as "base", current_user as "rôle",
       version()          as "version postgresql",
       now()              as "horodatage";

rollback;

\echo ''
\echo '=== RÈGLE : une seule ligne « DIFFÈRE » => ARRÊT, ne pas appliquer la migration. ==='
