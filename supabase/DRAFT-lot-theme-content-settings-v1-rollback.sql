-- ============================================================
-- Scanym — THEME & CONTENT SETTINGS v1 — ROLLBACK
-- (DRAFT — NOT APPLIED IN PRODUCTION — AUCUNE EXÉCUTION HÉBERGÉE)
--
-- Annule exactement, et SEULEMENT, ce qu'ajoute
-- supabase/DRAFT-lot-theme-content-settings-v1.sql.
--
-- CE QUE CE RETOUR FAIT :
--   1. supprime le RPC update_restaurant_theme_tokens, le CHECK et la
--      colonne restaurant_configs.theme_tokens, puis les quatre fonctions
--      du validateur ;
--   2. REMET les trois fonctions de catalogue MCC dans leur état MCC v1
--      EXACT (14 emplacements, 11 publics, bornes 160/500), après avoir
--      vérifié qu'aucune ligne de merchant_communication_text ne porte
--      l'un des 3 emplacements ajoutés -- sinon il REFUSE.
--
-- CE QUE CE RETOUR NE FAIT PAS :
--   - ne touche à aucune autre colonne de restaurant_configs, à aucune
--     autre ligne de merchant_communication_text, à aucune commande ;
--   - ne redéfinit ni set_merchant_communication_text, ni
--     get_restaurant_public_communication_texts, ni le CHECK de clé.
--
-- PERTE DE DONNÉES ASSUMÉE ET EXPLICITE : les jetons de couleur de
-- surface disparaissent avec la colonne. C'est le comportement VOULU d'un
-- retour sur un lot de configuration : l'absence de configuration est
-- l'état d'avant, et il est fonctionnellement complet (les surfaces
-- retombent sur le thème). Le code applicatif déployé avec ce lot lit
-- theme_tokens dans une requête DÉDIÉE qui échoue localement -- la page
-- Réglages désactive alors la section sans faire échouer le reste.
--
-- ATOMICITÉ : UNE seule transaction, pré-vol et post-vol DEDANS,
-- `commit;` en dernière instruction exécutable.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 0. PRÉ-VOL.
-- ------------------------------------------------------------
do $$
declare
  v_rows bigint;
begin
  if to_regclass('public.merchant_communication_text') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: merchant_communication_text absente -- rollback annulé.';
  end if;
  if to_regprocedure('public.update_restaurant_theme_tokens(uuid,jsonb)') is null
     or to_regprocedure('public.theme_tokens_valid(jsonb)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: THEME & CONTENT SETTINGS v1 n''est pas appliqué -- rollback annulé.';
  end if;

  -- Restaurer le catalogue à 14 emplacements laisserait des lignes
  -- orphelines que le CHECK de clé refuserait désormais d'insérer : un
  -- rollback qui laisse des données invalides est pire qu'un rollback
  -- refusé d'emblée. On DIT pourquoi, avec le compte exact.
  select count(*) into v_rows
  from public.merchant_communication_text
  where text_key in ('order_help_button_label', 'order_help_title', 'order_help_body');

  if v_rows > 0 then
    raise exception 'SCANYM_ROLLBACK_BLOCKED: % ligne(s) de merchant_communication_text portent un emplacement ajouté par ce lot (order_help_*). Les supprimer (ou les exporter) AVANT le rollback -- ce script ne détruit jamais ces textes en silence.', v_rows;
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. Catalogue MCC — retour à l'état MCC v1 EXACT (mêmes corps que
--    DRAFT-lot-merchant-customer-communications-v1.sql, section A).
-- ------------------------------------------------------------
create or replace function public.communication_text_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'checkout_info',
    'pickup_explanation',
    'delivery_local_explanation',
    'delivery_carrier_explanation',
    'slot_warning',
    'sanitary_warning',
    'order_success_title',
    'order_success_body',
    'confirmation_pickup',
    'confirmation_delivery_local',
    'confirmation_delivery_carrier',
    'email_confirmation_subject',
    'email_confirmation_body',
    'confirmation_withdrawal_request'
  ]::text[]
$$;

comment on function public.communication_text_keys() is
  'MERCHANT CUSTOMER COMMUNICATIONS v1 — catalogue FERMÉ des 14 emplacements de texte customer-facing configurables. Miroir exact de COMMUNICATION_TEXT_KEYS (lib/communications/text-keys.ts). Aucun GRANT applicatif : autorité interne, appelée par le CHECK et par les RPC de ce lot.';

create or replace function public.public_communication_text_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'checkout_info',
    'pickup_explanation',
    'delivery_local_explanation',
    'delivery_carrier_explanation',
    'slot_warning',
    'sanitary_warning',
    'order_success_title',
    'order_success_body',
    'confirmation_pickup',
    'confirmation_delivery_local',
    'confirmation_delivery_carrier'
  ]::text[]
$$;

comment on function public.public_communication_text_keys() is
  'MERCHANT CUSTOMER COMMUNICATIONS v1 — les 11 emplacements exposés à la projection publique anonyme. Miroir exact de PUBLIC_COMMUNICATION_TEXT_KEYS. Les 3 gabarits d''e-mail (email_confirmation_subject/body, confirmation_withdrawal_request) en sont volontairement exclus.';

create or replace function public.communication_text_max_length(p_text_key text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when p_text_key = 'email_confirmation_subject' then 160 else 500 end
$$;

comment on function public.communication_text_max_length(text) is
  'MERCHANT CUSTOMER COMMUNICATIONS v1 — longueur maximale par emplacement : 160 pour un sujet d''e-mail (au-delà, le client de messagerie tronque lui-même), 500 ailleurs (aligné sur restaurant_sale_modes.customer_text). Miroir de COMMUNICATION_SUBJECT_MAX_LENGTH / COMMUNICATION_TEXT_MAX_LENGTH.';

-- ------------------------------------------------------------
-- 2. Jetons de surface — dans l'ordre inverse de la création.
-- ------------------------------------------------------------
drop function public.update_restaurant_theme_tokens(uuid, jsonb);

alter table public.restaurant_configs
  drop constraint restaurant_configs_theme_tokens_valid;

alter table public.restaurant_configs
  drop column theme_tokens;

drop function public.theme_tokens_valid(jsonb);
drop function public.theme_token_contrast(text, text);
drop function public.theme_token_luminance(text);
drop function public.theme_token_keys();

-- ------------------------------------------------------------
-- 3. POST-VOL.
-- ------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'restaurant_configs'
      and a.attname = 'theme_tokens' and not a.attisdropped
  ) then
    raise exception 'SCANYM_POSTCHECK: restaurant_configs.theme_tokens subsiste.';
  end if;
  if to_regprocedure('public.update_restaurant_theme_tokens(uuid,jsonb)') is not null
     or to_regprocedure('public.theme_tokens_valid(jsonb)') is not null
     or to_regprocedure('public.theme_token_contrast(text,text)') is not null
     or to_regprocedure('public.theme_token_luminance(text)') is not null
     or to_regprocedure('public.theme_token_keys()') is not null then
    raise exception 'SCANYM_POSTCHECK: une fonction du lot subsiste.';
  end if;
  if pg_catalog.cardinality(public.communication_text_keys()) <> 14
     or pg_catalog.cardinality(public.public_communication_text_keys()) <> 11
     or public.communication_text_max_length('order_help_title') <> 500
     or public.communication_text_max_length('email_confirmation_subject') <> 160 then
    raise exception 'SCANYM_POSTCHECK: le catalogue MCC n''est pas revenu à son état MCC v1.';
  end if;
  if has_function_privilege('anon', 'public.communication_text_keys()'::regprocedure, 'execute')
     or has_function_privilege('authenticated', 'public.communication_text_keys()'::regprocedure, 'execute') then
    raise exception 'SCANYM_POSTCHECK: communication_text_keys() est exécutable par un rôle applicatif.';
  end if;
end $$;

commit;
