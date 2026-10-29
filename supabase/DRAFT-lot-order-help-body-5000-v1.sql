-- =============================================================================
-- Scanym — ORDER HELP BODY 5000 v1
-- DEVELOPMENT ONLY — candidat additif ; JAMAIS appliqué à la Production ni à une
-- base hébergée sans GO distinct.
--
-- Décision (Yakout, 29/10/2026) : le texte « Comment passer commande »
-- (order_help_body) accepte 5000 caractères au lieu de 500. Les autres
-- emplacements gardent leurs bornes (160 sujet d'e-mail, 60 libellé du bouton
-- d'aide, 120 titre, 500 ailleurs).
--
-- Deux bornes SQL à lever, rien d'autre :
--   1. communication_text_max_length('order_help_body') : 500 -> 5000 (borne PAR
--      emplacement, appliquée par le RPC d'écriture) ;
--   2. CHECK merchant_communication_text_body_length (borne GÉNÉRALE de la
--      table, défense en profondeur) : 500 -> 5000. La borne par emplacement
--      reste donc ce qui limite les autres textes à 500.
-- Aucune donnée n'est modifiée. Contrepartie TypeScript :
-- COMMUNICATION_ORDER_HELP_BODY_MAX_LENGTH (lib/communications/text-keys.ts).
--
-- Ordre : à appliquer AVANT (ou avec) le déploiement du code TypeScript ; sinon
-- un texte de 501 à 5000 caractères est accepté par l'écran mais refusé par la
-- base à l'enregistrement.
-- =============================================================================

begin;

do $$
declare
  v_def text;
begin
  if to_regprocedure('public.communication_text_max_length(text)') is null
     or to_regclass('public.merchant_communication_text') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: lots MCC / THEME & CONTENT SETTINGS absents. Annulé.';
  end if;

  select pg_get_functiondef('public.communication_text_max_length(text)'::regprocedure) into v_def;
  if v_def like '%order_help_body%' then
    raise exception 'SCANYM_ALREADY_APPLIED: communication_text_max_length() traite déjà order_help_body. Annulé.';
  end if;
  if v_def not like '%order_help_button_label%60%' or v_def not like '%order_help_title%120%' or v_def not like '%else 500%' then
    raise exception 'SCANYM_SCHEMA_DRIFT: communication_text_max_length() n''est pas la version THEME & CONTENT SETTINGS v1 attendue -- la remplacer perdrait un ajout inconnu. Annulé.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.merchant_communication_text'::regclass
      and conname = 'merchant_communication_text_body_length'
      and pg_get_constraintdef(oid) like '%<= 500%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: contrainte merchant_communication_text_body_length (<= 500) introuvable. Annulé.';
  end if;
end $$;

create or replace function public.communication_text_max_length(p_text_key text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when p_text_key = 'email_confirmation_subject' then 160
    when p_text_key = 'order_help_button_label' then 60
    when p_text_key = 'order_help_title' then 120
    when p_text_key = 'order_help_body' then 5000
    else 500
  end
$$;

comment on function public.communication_text_max_length(text) is
  'MERCHANT CUSTOMER COMMUNICATIONS v1 + THEME & CONTENT SETTINGS v1 + ORDER HELP BODY 5000 v1 — longueur maximale par emplacement : 160 sujet d''e-mail, 60 libellé du bouton d''aide, 120 titre de la fenêtre d''aide, 5000 corps de l''aide à la commande, 500 ailleurs. Miroir de COMMUNICATION_SUBJECT_MAX_LENGTH / COMMUNICATION_ORDER_HELP_*_MAX_LENGTH / COMMUNICATION_TEXT_MAX_LENGTH.';

alter table public.merchant_communication_text drop constraint merchant_communication_text_body_length;
alter table public.merchant_communication_text add constraint merchant_communication_text_body_length
  check (body is null or pg_catalog.length(pg_catalog.btrim(body)) <= 5000);

do $$
begin
  if public.communication_text_max_length('order_help_body') <> 5000
     or public.communication_text_max_length('order_help_button_label') <> 60
     or public.communication_text_max_length('order_help_title') <> 120
     or public.communication_text_max_length('email_confirmation_subject') <> 160
     or public.communication_text_max_length('checkout_info') <> 500
     or public.communication_text_max_length('billing_profile_explanation') <> 500 then
    raise exception 'SCANYM_POSTCHECK: bornes de communication_text_max_length() inattendues.';
  end if;
end $$;

commit;
