-- =============================================================================
-- SCANYM — ONLINE WITHDRAWAL / RETRACTATION FOUNDATION v1 — ROLLBACK
-- DRAFT ONLY.
-- =============================================================================
-- Annule les primitives ajoutées par
-- DRAFT-lot-online-withdrawal-foundation-v1.sql et REMET la garde CGV
-- dans son état v2.5 (`false` en dur) : sans runtime, la publication
-- CGV d'un marchand STANDARD_14_DAYS doit redevenir fail-closed.
--
-- AVERTISSEMENT DONNÉES : ce rollback SUPPRIME les déclarations de
-- rétractation enregistrées (withdrawal_requests / _items). Ce sont des
-- déclarations juridiques du consommateur : les EXPORTER avant
-- exécution si la moindre demande réelle existe. Le rollback ne doit
-- donc jamais être joué en Production sans décision explicite.
-- =============================================================================

begin;

-- 1. Catalogue marchand -- retour à la signature SUBCATEGORIES v1.
--    (Les corps sont ceux de DRAFT-lot-catalogue-subcategories-backoffice-v1.sql :
--     rejouer ce fichier après ce rollback est le chemin recommandé,
--     plutôt que de dupliquer 300 lignes de corps ici.)
drop function if exists public.create_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid, boolean);
drop function if exists public.update_product(uuid, text, text, numeric, text, numeric, integer, boolean, uuid, boolean);
drop function if exists public.get_merchant_catalogue(uuid, boolean);

-- 2. RPC client de rétractation.
drop function if exists public.submit_withdrawal_request_by_capability(uuid, uuid, text, text, text, text, text, jsonb, uuid);
drop function if exists public.get_withdrawal_options_by_capability(uuid, uuid, text);

-- 3. Tables de déclaration.
drop table if exists public.withdrawal_request_items;
drop table if exists public.withdrawal_requests;

-- 4. Instantané de ligne + déclencheur.
drop trigger if exists trg_order_items_snapshot_withdrawal_eligibility on public.order_items;
drop function if exists public.snapshot_order_item_withdrawal_eligibility();
alter table public.order_items drop column if exists withdrawal_eligible_at_order_time;

-- 5. Attribut produit.
alter table public.menu_items drop column if exists withdrawal_eligible;

-- 6. Helpers.
drop function if exists public._scanym_has_operational_durable_ack_channel();

-- 7. Garde CGV -- retour EXACT à l'état v2.5.
create or replace function public._scanym_has_online_withdrawal_runtime()
returns boolean
language sql
immutable
as $$
  select false;
$$;
revoke all on function public._scanym_has_online_withdrawal_runtime() from public;

do $$
begin
  if public._scanym_has_online_withdrawal_runtime() then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: la garde CGV doit redevenir false après rollback.';
  end if;
  if to_regclass('public.withdrawal_requests') is not null then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: withdrawal_requests subsiste.';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_items' and column_name = 'withdrawal_eligible'
  ) then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: menu_items.withdrawal_eligible subsiste.';
  end if;
end $$;

commit;

-- APRÈS CE ROLLBACK : rejouer
-- supabase/DRAFT-lot-catalogue-subcategories-backoffice-v1.sql
-- (sections create_product / update_product / get_merchant_catalogue)
-- pour restaurer les RPC catalogue dans leur forme antérieure.
