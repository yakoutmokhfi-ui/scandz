-- ============================================================
-- Scanym — PAYMENT STREAM B — CURRENCY PREFLIGHT FIX v1.1
-- (ferme STREAM-B-CURRENCY-PREFLIGHT-01).
--
-- DÉFAUT CORRIGÉ : la devise autoritaire n'était connue/validée
-- qu'APRÈS initiate_payment_attempt sur le chemin FRAIS -- une
-- commande non-EUR pouvait donc déjà créer une tentative de paiement
-- 'pending' avant le rejet.
--
-- CORRECTIF MINIMAL : get_order_payment_context (PAYMENT P3-B2,
-- publié) déclare EXPLICITEMENT dans son propre commentaire ne
-- "jamais" retourner `currency` -- une exclusion délibérée et
-- documentée (minimisation des données). L'étendre violerait son
-- propre contrat publié et testé. Ce fichier crée donc une NOUVELLE
-- fonction, STRICTEMENT MINIMALE (currency uniquement), reproduisant
-- EXACTEMENT le même modèle de sécurité possession-scoped
-- (order_id + public_token, SECURITY DEFINER, search_path vide,
-- service_role UNIQUEMENT, aucune fuite observable entre jeton
-- incorrect et commande inexistante) -- jamais un nouvel élargissement
-- de get_order_payment_context lui-même.
-- ============================================================

begin;

do $$
begin
  if to_regclass('public.orders') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: table public.orders absente' using errcode = '55000';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'currency'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonne orders.currency absente' using errcode = '55000';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'public_token'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonne orders.public_token absente' using errcode = '55000';
  end if;
end $$;

create or replace function public.get_order_currency_preflight(
  p_order_id uuid,
  p_public_token uuid
)
returns table (
  currency text
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.currency
  from public.orders o
  where o.id = p_order_id
    and o.public_token = p_public_token;
$$;

comment on function public.get_order_currency_preflight(uuid, uuid) is
  'SECURITY DEFINER, service_role UNIQUEMENT (EXECUTE only) -- PAYMENT STREAM B (ferme STREAM-B-CURRENCY-PREFLIGHT-01). Lecture possession-scoped (order_id + public_token, MÊME modèle exact que get_order_payment_context/get_order_active_payment_attempt) retournant UNIQUEMENT currency -- AUCUN autre champ (jamais total, jamais restaurant_id, jamais provider_reference). Destinée EXCLUSIVEMENT à un contrôle de compatibilité devise/prestataire AVANT tout appel à initiate_payment_attempt sur le chemin FRAIS du runtime de checkout Monetico -- jamais un remplacement de get_order_payment_context (PAYMENT P3-B2, INCHANGÉ, qui continue de ne jamais exposer currency par son propre choix documenté de minimisation des données). Instruction SQL pure sans branche : toute paire incorrecte (mauvais jeton, mauvaise commande, arguments NULL) produit un ensemble de résultats vide, de façon identique dans tous les cas -- aucune fuite d''information observable. Lecture PURE, aucune capacité de mutation.';

revoke all on function public.get_order_currency_preflight(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_order_currency_preflight(uuid, uuid) to service_role;

do $$
declare
  v_prosecdef boolean;
  v_proconfig text[];
begin
  select p.prosecdef, p.proconfig into v_prosecdef, v_proconfig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_order_currency_preflight'
    and pg_get_function_identity_arguments(p.oid) = 'p_order_id uuid, p_public_token uuid';

  if v_prosecdef is distinct from true or v_proconfig is null or not ('search_path=""' = any (v_proconfig)) then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- SECURITY DEFINER/search_path get_order_currency_preflight non préservé' using errcode = '55000';
  end if;
  if has_function_privilege('anon', 'public.get_order_currency_preflight(uuid,uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.get_order_currency_preflight(uuid,uuid)', 'execute')
     or has_function_privilege('public', 'public.get_order_currency_preflight(uuid,uuid)', 'execute') then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- élargissement ACL accidentel sur get_order_currency_preflight' using errcode = '55000';
  end if;
  if not has_function_privilege('service_role', 'public.get_order_currency_preflight(uuid,uuid)', 'execute') then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- service_role a perdu EXECUTE sur get_order_currency_preflight' using errcode = '55000';
  end if;

  -- Non-régression explicite : get_order_payment_context (PAYMENT
  -- P3-B2, publié) reste INCHANGÉ -- toujours EXACTEMENT 2 colonnes
  -- de sortie (restaurant_id, payment_status), jamais élargi pour
  -- inclure currency par ce lot.
  if (
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_order_payment_context'
      and pg_get_function_result(p.oid) = 'TABLE(restaurant_id uuid, payment_status text)'
  ) <> 1 then
    raise exception 'SCANYM_SCHEMA_DRIFT: postcheck -- get_order_payment_context a été modifié par erreur (signature de retour attendue inchangée)' using errcode = '55000';
  end if;
end $$;

commit;
