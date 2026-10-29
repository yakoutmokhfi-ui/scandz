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

-- PRÉ-VOL — état prédécesseur EXACT, échec fermé AVANT toute écriture.
-- Le lot remplace la fonction ENTIÈRE et le CHECK : toute valeur différente de
-- l'état attendu (ex. une borne d'e-mail à 80 au lieu de 160) serait écrasée
-- sans trace. On vérifie donc : (1) une seule surcharge ; (2) corps EXACT
-- (comparé sans blancs ni casse) = THEME & CONTENT SETTINGS v1 ; (3) langage,
-- volatilité, search_path et droits d'exécution inchangés ; (4) CHECK de table
-- EXACT = MCC v1 (<= 500). On ne « rétablit » jamais une valeur attendue.
do $$
declare
  v_def   text;
  v_body  text;
  v_check text;
begin
  if to_regprocedure('public.communication_text_max_length(text)') is null
     or to_regclass('public.merchant_communication_text') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: lots MCC / THEME & CONTENT SETTINGS absents. Annulé.';
  end if;

  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'communication_text_max_length') <> 1 then
    raise exception 'SCANYM_SCHEMA_DRIFT: communication_text_max_length doit exister en UNE seule surcharge. Annulé.';
  end if;

  select pg_get_functiondef('public.communication_text_max_length(text)'::regprocedure) into v_def;
  if v_def like '%order_help_body%' then
    raise exception 'SCANYM_ALREADY_APPLIED: communication_text_max_length() traite déjà order_help_body. Annulé.';
  end if;

  select pg_catalog.regexp_replace(pg_catalog.lower(p.prosrc), '\s+', '', 'g')
    into v_body
  from pg_proc p
  where p.oid = 'public.communication_text_max_length(text)'::regprocedure;
  if v_body is distinct from
     'selectcasewhenp_text_key=''email_confirmation_subject''then160whenp_text_key=''order_help_button_label''then60whenp_text_key=''order_help_title''then120else500end' then
    raise exception 'SCANYM_SCHEMA_DRIFT: le corps de communication_text_max_length() n''est pas EXACTEMENT celui de THEME & CONTENT SETTINGS v1 (une borne hors périmètre a dérivé) -- le remplacer l''écraserait. Annulé, rien n''est modifié.';
  end if;

  if not exists (
    select 1 from pg_proc p
    where p.oid = 'public.communication_text_max_length(text)'::regprocedure
      and p.prolang = (select oid from pg_language where lanname = 'sql')
      and p.provolatile = 'i'
      and not p.prosecdef
      and p.proconfig = array['search_path=""']
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: attributs de communication_text_max_length() (langage, volatilité, search_path) inattendus. Annulé, rien n''est modifié.';
  end if;

  if has_function_privilege('anon', 'public.communication_text_max_length(text)', 'execute')
     or has_function_privilege('authenticated', 'public.communication_text_max_length(text)', 'execute')
     or has_function_privilege('service_role', 'public.communication_text_max_length(text)', 'execute') then
    raise exception 'SCANYM_SCHEMA_DRIFT: droits d''exécution de communication_text_max_length() inattendus. Annulé, rien n''est modifié.';
  end if;

  select pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.replace(pg_get_constraintdef(c.oid), 'pg_catalog.', '')), '[^a-z0-9_<=>]', '', 'g')
    into v_check
  from pg_constraint c
  where c.conrelid = 'public.merchant_communication_text'::regclass
    and c.conname = 'merchant_communication_text_body_length';
  if v_check is distinct from 'checkbodyisnullorlengthbtrimbody<=500' then
    raise exception 'SCANYM_SCHEMA_DRIFT: le CHECK merchant_communication_text_body_length n''est pas EXACTEMENT « body is null or length(btrim(body)) <= 500 ». Annulé, rien n''est modifié.';
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
