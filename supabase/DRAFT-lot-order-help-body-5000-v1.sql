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

-- PRÉ-VOL — état prédécesseur vérifié SÉMANTIQUEMENT, échec fermé AVANT toute
-- écriture. Le lot remplace la fonction ENTIÈRE et le CHECK : toute valeur
-- inattendue (ex. une borne d'e-mail à 80) serait écrasée sans trace. On
-- vérifie donc, sans jamais « rétablir » une valeur attendue :
--   (1) littéraux de la source : EXACTS (casse/espaces conservés) ;
--   (2) nombres hors littéraux : exactement {60,120,160,500} ;
--   (3) comportement : valeur retournée pour chaque emplacement du catalogue
--       et pour une clé inconnue ;
--   (4) langage, volatilité, search_path, droits d'exécution ;
--   (5) CHECK de table : définition entière (seuls blancs/casse/préfixe
--       pg_catalog ignorés ; aucun opérateur ni signe effacé).
-- La mise en forme du texte (blancs, retours à la ligne, casse des mots-clés)
-- n'est PAS une dérive ; une borne ou un littéral différent l'est.
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
  if to_regprocedure('public.communication_text_max_length(text)') is null
     or to_regclass('public.merchant_communication_text') is null
     or to_regprocedure('public.communication_text_keys()') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: lots MCC / THEME & CONTENT SETTINGS absents. Annulé.';
  end if;

  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'communication_text_max_length') <> 1 then
    raise exception 'SCANYM_SCHEMA_DRIFT: communication_text_max_length doit exister en UNE seule surcharge. Annulé.';
  end if;

  select p.prosrc into v_src from pg_proc p where p.oid = 'public.communication_text_max_length(text)'::regprocedure;
  if v_src like '%order_help_body%' then
    raise exception 'SCANYM_ALREADY_APPLIED: communication_text_max_length() traite déjà order_help_body. Annulé.';
  end if;
  -- (1) Littéraux : EXACTS (casse, espaces et guillemets conservés). Un littéral
  --     en majuscules, avec une espace insérée, ou supplémentaire = dérive.
  select coalesce(pg_catalog.array_agg(t.m[1] order by t.m[1] collate "C"), '{}')
    into v_lits
  from pg_catalog.regexp_matches(v_src, c_pat, 'g') as t(m)
  where t.m[1] like '''%';
  if v_lits is distinct from (select pg_catalog.array_agg(x order by x collate "C") from pg_catalog.unnest(array['''email_confirmation_subject''','''order_help_button_label''','''order_help_title''']::text[]) as x) then
    raise exception 'SCANYM_SCHEMA_DRIFT: littéraux de communication_text_max_length() inattendus (%) -- état attendu : THEME & CONTENT SETTINGS v1. Annulé, rien n''est modifié.', v_lits;
  end if;

  -- (2) Nombres HORS littéraux : exactement les bornes attendues.
  select coalesce(pg_catalog.array_agg(n.g[1]::integer order by n.g[1]::integer), '{}')
    into v_nums
  from pg_catalog.regexp_matches(v_src, c_pat, 'g') as t(m),
       lateral pg_catalog.regexp_matches(t.m[1], '[0-9]+', 'g') as n(g)
  where t.m[1] not like '''%';
  if v_nums is distinct from array[60,120,160,500]::integer[] then
    raise exception 'SCANYM_SCHEMA_DRIFT: bornes numériques de communication_text_max_length() inattendues (%) -- état attendu : THEME & CONTENT SETTINGS v1. Annulé, rien n''est modifié.', v_nums;
  end if;

  -- (3) COMPORTEMENT : valeur retournée pour CHAQUE emplacement du catalogue
  --     et pour une clé inconnue. Tolère la mise en forme, jamais une borne.
  foreach v_key in array (public.communication_text_keys() || array['zz_probe_unknown']::text[]) loop
    v_exp := case v_key
      when 'email_confirmation_subject' then 160
      when 'order_help_button_label' then 60
      when 'order_help_title' then 120
      when 'order_help_body' then 500
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
  if v_check is distinct from 'check(((bodyisnull)or(length(btrim(body))<=500)))' then
    raise exception 'SCANYM_SCHEMA_DRIFT: CHECK merchant_communication_text_body_length inattendu (%) -- état attendu : THEME & CONTENT SETTINGS v1. Annulé, rien n''est modifié.',
      (select pg_get_constraintdef(c.oid) from pg_constraint c
        where c.conrelid = 'public.merchant_communication_text'::regclass and c.conname = 'merchant_communication_text_body_length');
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
