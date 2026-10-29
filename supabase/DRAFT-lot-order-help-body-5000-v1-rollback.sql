-- ORDER HELP BODY 5000 v1 — ROLLBACK (DEVELOPMENT ONLY).
-- Refusé s'il existe un order_help_body de plus de 500 caractères (le raccourcir
-- ou le supprimer d'abord : aucune donnée n'est tronquée automatiquement).
begin;

do $$
begin
  if exists (
    select 1 from public.merchant_communication_text
    where text_key = 'order_help_body' and pg_catalog.length(pg_catalog.btrim(body)) > 500
  ) then
    raise exception 'SCANYM_ROLLBACK_REFUSED: un order_help_body dépasse 500 caractères -- à raccourcir avant retour arrière.';
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
    else 500
  end
$$;

comment on function public.communication_text_max_length(text) is
  'MERCHANT CUSTOMER COMMUNICATIONS v1 + THEME & CONTENT SETTINGS v1 — longueur maximale par emplacement : 160 sujet d''e-mail, 60 libellé du bouton d''aide, 120 titre de la fenêtre d''aide, 500 ailleurs. Miroir de COMMUNICATION_SUBJECT_MAX_LENGTH / COMMUNICATION_ORDER_HELP_*_MAX_LENGTH / COMMUNICATION_TEXT_MAX_LENGTH.';

alter table public.merchant_communication_text drop constraint merchant_communication_text_body_length;
alter table public.merchant_communication_text add constraint merchant_communication_text_body_length
  check (body is null or pg_catalog.length(pg_catalog.btrim(body)) <= 500);

commit;
