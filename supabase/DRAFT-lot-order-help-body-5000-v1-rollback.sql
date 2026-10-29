-- ORDER HELP BODY 5000 v1 — ROLLBACK (DEVELOPMENT ONLY).
-- Refusé s'il existe un order_help_body de plus de 500 caractères (le raccourcir
-- ou le supprimer d'abord : aucune donnée n'est tronquée automatiquement).
begin;

-- PRÉ-VOL : état posé par le lot, vérifié sémantiquement (voir le lot).
do $$
declare
  -- Jetons d'une source SQL : littéral '...' (avec '' échappé) OU texte hors littéral.
  c_pat   constant text := $re$'(?:[^']|'')*'|[^']+$re$;
  v_src   text;
  v_lits  text[];
  v_nums  integer[];
  v_check text;
  v_key   text;
  v_exp   integer;
  v_got   integer;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = 'public.communication_text_max_length(text)'::regprocedure;
  -- (1) Littéraux : EXACTS (casse, espaces et guillemets conservés). Un littéral
  --     en majuscules, avec une espace insérée, ou supplémentaire = dérive.
  select coalesce(pg_catalog.array_agg(t.m[1] order by t.m[1] collate "C"), '{}')
    into v_lits
  from pg_catalog.regexp_matches(v_src, c_pat, 'g') as t(m)
  where t.m[1] like '''%';
  if v_lits is distinct from (select pg_catalog.array_agg(x order by x collate "C") from pg_catalog.unnest(array['''email_confirmation_subject''','''order_help_body''','''order_help_button_label''','''order_help_title''']::text[]) as x) then
    raise exception 'SCANYM_SCHEMA_DRIFT: littéraux de communication_text_max_length() inattendus (%) -- état attendu : ORDER HELP BODY 5000 v1. Annulé, rien n''est modifié.', v_lits;
  end if;

  -- (2) Nombres HORS littéraux : exactement les bornes attendues.
  select coalesce(pg_catalog.array_agg(n.g[1]::integer order by n.g[1]::integer), '{}')
    into v_nums
  from pg_catalog.regexp_matches(v_src, c_pat, 'g') as t(m),
       lateral pg_catalog.regexp_matches(t.m[1], '[0-9]+', 'g') as n(g)
  where t.m[1] not like '''%';
  if v_nums is distinct from array[60,120,160,500,5000]::integer[] then
    raise exception 'SCANYM_SCHEMA_DRIFT: bornes numériques de communication_text_max_length() inattendues (%) -- état attendu : ORDER HELP BODY 5000 v1. Annulé, rien n''est modifié.', v_nums;
  end if;

  -- (3) COMPORTEMENT : valeur retournée pour CHAQUE emplacement du catalogue
  --     et pour une clé inconnue. Tolère la mise en forme, jamais une borne.
  foreach v_key in array (public.communication_text_keys() || array['zz_probe_unknown']::text[]) loop
    v_exp := case v_key
      when 'email_confirmation_subject' then 160
      when 'order_help_button_label' then 60
      when 'order_help_title' then 120
      when 'order_help_body' then 5000
      else 500 end;
    v_got := public.communication_text_max_length(v_key);
    if v_got is distinct from v_exp then
      raise exception 'SCANYM_SCHEMA_DRIFT: communication_text_max_length(%) = % au lieu de % (borne hors périmètre dérivée ?). Annulé, rien n''est modifié.', v_key, v_got, v_exp;
    end if;
  end loop;

  -- (4) Attributs et droits inchangés.
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

  -- (5) CHECK de table : définition ENTIÈRE, seuls blancs, casse et préfixe
  --     pg_catalog sont ignorés (aucun opérateur, signe ni parenthèse effacé).
  select pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.replace(pg_get_constraintdef(c.oid), 'pg_catalog.', '')), '\s+', '', 'g')
    into v_check
  from pg_constraint c
  where c.conrelid = 'public.merchant_communication_text'::regclass
    and c.conname = 'merchant_communication_text_body_length'
    and c.contype = 'c' and c.convalidated;
  if v_check is distinct from 'check(((bodyisnull)or(length(btrim(body))<=5000)))' then
    raise exception 'SCANYM_SCHEMA_DRIFT: CHECK merchant_communication_text_body_length inattendu (%) -- état attendu : ORDER HELP BODY 5000 v1. Annulé, rien n''est modifié.',
      (select pg_get_constraintdef(c.oid) from pg_constraint c
        where c.conrelid = 'public.merchant_communication_text'::regclass and c.conname = 'merchant_communication_text_body_length');
  end if;
end $$;

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
