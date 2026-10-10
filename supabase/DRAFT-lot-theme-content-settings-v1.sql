-- ============================================================
-- Scanym — THEME & CONTENT SETTINGS v1
-- (DRAFT — NOT APPLIED IN PRODUCTION — AUCUNE EXÉCUTION HÉBERGÉE)
--
-- Parent : main 412dbb53c5f180983860852b79425209c04b9c42
-- Rollback : DRAFT-lot-theme-content-settings-v1-rollback.sql
-- PRÉREQUIS : MERCHANT CUSTOMER COMMUNICATIONS v1 appliqué
--             (DRAFT-lot-merchant-customer-communications-v1.sql).
--
-- CE QUE CE LOT AJOUTE (et rien d'autre) :
--
-- A. UNE colonne : restaurant_configs.theme_tokens (jsonb, NULL par
--    défaut). Aucune nouvelle table : les couleurs de thème vivent déjà
--    sur restaurant_configs (primary/secondary/accent/bg_color) ; les
--    jetons de surface s'y rangent à côté, sous la même RLS, avec la même
--    lecture publique (`restaurant_configs ( * )`) et la même isolation
--    par restaurant_id. NULL = « aucune configuration » = rendu inchangé.
--
-- B. UN validateur fermé, miroir EXACT de lib/theme-tokens.ts :
--    theme_token_keys() (7 clés), theme_token_luminance()/
--    theme_token_contrast() (formule WCAG de lib/color-contrast.ts) et
--    theme_tokens_valid(jsonb). Le validateur est aussi un CHECK de
--    colonne : même un appel service_role direct ne peut pas stocker un
--    jeton hors catalogue, non-#RRGGBB, en paire incomplète, ou sous
--    4,5:1 de contraste.
--
-- C. UN RPC d'écriture : update_restaurant_theme_tokens(uuid, jsonb).
--    Même autorité que update_restaurant_bg_color / _colors :
--    assert_restaurant_asset_role (owner/manager du restaurant OU
--    opérateur Scanym). Normalise (majuscules, valeurs vides retirées),
--    `{}`/NULL => colonne remise à NULL (réinitialisation).
--
-- D. EXTENSION du catalogue FERMÉ MCC de 14 à 17 emplacements
--    (order_help_button_label, order_help_title, order_help_body), par
--    `create or replace` de TROIS fonctions de catalogue seulement :
--    communication_text_keys(), public_communication_text_keys(),
--    communication_text_max_length(text). Le CHECK de
--    merchant_communication_text, set_merchant_communication_text et
--    get_restaurant_public_communication_texts les appellent déjà : ils
--    n'ont besoin d'AUCUNE modification (ni redéfinition, ni nouveau
--    GRANT). `create or replace` conserve les ACL existantes (aucune,
--    voir MCC).
--
-- CE QUE CE LOT NE FAIT PAS :
--   - aucune nouvelle table, aucune nouvelle policy RLS, aucun GRANT sur
--     restaurant_configs, aucun changement de create_order, du checkout,
--     des CGV, de la tarification de livraison, de la facturation ;
--   - ne touche à aucune donnée existante : les lignes
--     merchant_communication_text et restaurant_configs sont intactes ;
--   - ne stocke ni CSS, ni HTML, ni URL, ni script : uniquement des
--     couleurs #RRGGBB dans un jeu de clés fermé.
--
-- LIMITE ASSUMÉE : theme_token_contrast() reproduit la formule WCAG en
-- double précision, comme le TypeScript. Deux implémentations de pow()
-- peuvent différer d'un ulp ; un couple de couleurs à moins de 1e-12 du
-- seuil 4,5 pourrait donc être accepté côté navigateur et refusé ici. Le
-- SQL fait foi ; l'effet est un message d'erreur à l'enregistrement,
-- jamais un rendu illisible.
--
-- ATOMICITÉ : UNE seule transaction, pré-vol et post-vol DEDANS,
-- `commit;` en dernière instruction exécutable.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 0. PRÉ-VOL ANTI-DÉRIVE.
-- ------------------------------------------------------------
do $$
declare
  v_def text;
begin
  if to_regclass('public.restaurant_configs') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurant_configs absente -- annulé.';
  end if;

  -- LOT 1A (bg_color) doit être présent : ce lot se range à côté des
  -- couleurs existantes et en suppose le modèle.
  if not exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'restaurant_configs'
      and a.attname = 'bg_color' and not a.attisdropped
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: restaurant_configs.bg_color absente -- LOT 1A doit être appliqué avant. Annulé.';
  end if;

  if to_regprocedure('public.assert_restaurant_asset_role(uuid)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: assert_restaurant_asset_role(uuid) absente -- annulé.';
  end if;

  -- Anti-double-application.
  if exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'restaurant_configs'
      and a.attname = 'theme_tokens' and not a.attisdropped
  )
  or to_regprocedure('public.theme_token_keys()') is not null
  or to_regprocedure('public.theme_token_luminance(text)') is not null
  or to_regprocedure('public.theme_token_contrast(text,text)') is not null
  or to_regprocedure('public.theme_tokens_valid(jsonb)') is not null
  or to_regprocedure('public.update_restaurant_theme_tokens(uuid,jsonb)') is not null then
    raise exception 'SCANYM_ALREADY_APPLIED: THEME & CONTENT SETTINGS v1 déjà (partiellement) appliqué -- annulé.';
  end if;

  -- MCC v1 doit être présent ET dans son état exact : ce lot REMPLACE
  -- trois fonctions de catalogue ; sur une version inconnue, le
  -- remplacement perdrait silencieusement ce qu'elle aurait ajouté.
  if to_regclass('public.merchant_communication_text') is null
     or to_regprocedure('public.communication_text_keys()') is null
     or to_regprocedure('public.public_communication_text_keys()') is null
     or to_regprocedure('public.communication_text_max_length(text)') is null
     or to_regprocedure('public.set_merchant_communication_text(uuid,text,text)') is null
     or to_regprocedure('public.get_restaurant_public_communication_texts(uuid)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: MERCHANT CUSTOMER COMMUNICATIONS v1 absent ou incomplet -- à appliquer avant ce lot. Annulé.';
  end if;

  if pg_catalog.cardinality(public.communication_text_keys()) <> 14
     or pg_catalog.cardinality(public.public_communication_text_keys()) <> 11 then
    raise exception 'SCANYM_SCHEMA_DRIFT: catalogue MCC attendu à 14/11 emplacements, trouvé %/% -- annulé.',
      pg_catalog.cardinality(public.communication_text_keys()),
      pg_catalog.cardinality(public.public_communication_text_keys());
  end if;

  if 'order_help_body' = any(public.communication_text_keys()) then
    raise exception 'SCANYM_ALREADY_APPLIED: le catalogue MCC porte déjà order_help_body -- annulé.';
  end if;

  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'communication_text_max_length';
  if v_def not like '%when p_text_key = ''email_confirmation_subject'' then 160 else 500 end%' then
    raise exception 'SCANYM_SCHEMA_DRIFT: communication_text_max_length() n''est pas la version MCC v1 attendue -- la remplacer perdrait un ajout inconnu. Annulé.';
  end if;

  -- Le CHECK de clé et les deux RPC DOIVENT s'appuyer sur les fonctions de
  -- catalogue : c'est ce qui rend ce lot capable d'étendre le catalogue
  -- SANS les redéfinir. Une version qui aurait recopié la liste en dur
  -- ne verrait pas les 3 nouveaux emplacements.
  if not exists (
    select 1 from pg_constraint
    where conname = 'merchant_communication_text_key_check'
      and conrelid = 'public.merchant_communication_text'::regclass
      and pg_get_constraintdef(oid) like '%communication_text_keys()%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: merchant_communication_text_key_check ne s''appuie pas sur communication_text_keys() -- annulé.';
  end if;
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'set_merchant_communication_text';
  if v_def not like '%public.communication_text_keys()%' or v_def not like '%public.communication_text_max_length(p_text_key)%' then
    raise exception 'SCANYM_SCHEMA_DRIFT: set_merchant_communication_text ne s''appuie pas sur les fonctions de catalogue -- annulé.';
  end if;
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_restaurant_public_communication_texts';
  if v_def not like '%public.public_communication_text_keys()%' then
    raise exception 'SCANYM_SCHEMA_DRIFT: get_restaurant_public_communication_texts ne s''appuie pas sur public_communication_text_keys() -- annulé.';
  end if;
end $$;

-- ------------------------------------------------------------
-- A. VALIDATEUR FERMÉ — miroir EXACT de lib/theme-tokens.ts.
-- ------------------------------------------------------------
create function public.theme_token_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'info_panel_bg',
    'info_panel_text',
    'popup_bg',
    'popup_text',
    'delivery_card_bg',
    'delivery_card_text',
    'surface_border'
  ]::text[]
$$;

comment on function public.theme_token_keys() is
  'THEME & CONTENT SETTINGS v1 — catalogue FERMÉ des 7 jetons de surface. Miroir exact de THEME_TOKEN_KEYS (lib/theme-tokens.ts). Aucun GRANT applicatif : autorité interne appelée par le CHECK et le RPC de ce lot.';

revoke all on function public.theme_token_keys() from public, anon, authenticated, service_role;

-- Luminance relative WCAG d'une couleur #RRGGBB -- MÊME formule que
-- relativeLuminance (lib/color-contrast.ts), en double précision.
create function public.theme_token_luminance(p_hex text)
returns double precision
language plpgsql
immutable
set search_path = ''
as $$
declare
  c double precision[3];
  i integer;
begin
  for i in 1..3 loop
    c[i] := (('x' || pg_catalog.substr(p_hex, 2 * i, 2))::bit(8)::integer)::double precision / 255.0;
    c[i] := case
      when c[i] <= 0.03928 then c[i] / 12.92
      else pg_catalog.power((c[i] + 0.055) / 1.055, 2.4)
    end;
  end loop;
  return 0.2126 * c[1] + 0.7152 * c[2] + 0.0722 * c[3];
end $$;

comment on function public.theme_token_luminance(text) is
  'THEME & CONTENT SETTINGS v1 — luminance relative WCAG d''une couleur #RRGGBB. Miroir de relativeLuminance (lib/color-contrast.ts).';

revoke all on function public.theme_token_luminance(text) from public, anon, authenticated, service_role;

create function public.theme_token_contrast(p_a text, p_b text)
returns double precision
language sql
immutable
set search_path = ''
as $$
  select (greatest(public.theme_token_luminance(p_a), public.theme_token_luminance(p_b)) + 0.05)
       / (least(public.theme_token_luminance(p_a), public.theme_token_luminance(p_b)) + 0.05)
$$;

comment on function public.theme_token_contrast(text, text) is
  'THEME & CONTENT SETTINGS v1 — ratio de contraste WCAG (1 à 21). Miroir de contrastRatio (lib/color-contrast.ts).';

revoke all on function public.theme_token_contrast(text, text) from public, anon, authenticated, service_role;

-- Forme STOCKÉE (canonique) : objet ; clés dans le catalogue ; valeurs
-- chaîne #RRGGBB en MAJUSCULES ; chaque fond avec son texte ; contraste
-- fond/texte >= 4,5. NULL est valide (« aucune configuration »).
create function public.theme_tokens_valid(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  k     text;
  v     jsonb;
  pairs text[] := array['info_panel_bg', 'info_panel_text', 'popup_bg', 'popup_text', 'delivery_card_bg', 'delivery_card_text'];
  i     integer;
begin
  if p is null then
    return true;
  end if;
  if pg_catalog.jsonb_typeof(p) <> 'object' then
    return false;
  end if;

  for k, v in select e.key, e.value from pg_catalog.jsonb_each(p) e loop
    if not (k = any(public.theme_token_keys())) then
      return false;
    end if;
    if pg_catalog.jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^#[0-9A-F]{6}$' then
      return false;
    end if;
  end loop;

  for i in 0..2 loop
    if (p ? pairs[2 * i + 1]) <> (p ? pairs[2 * i + 2]) then
      return false;
    end if;
    if p ? pairs[2 * i + 1]
       and public.theme_token_contrast(p ->> pairs[2 * i + 1], p ->> pairs[2 * i + 2]) < 4.5 then
      return false;
    end if;
  end loop;

  return true;
end $$;

comment on function public.theme_tokens_valid(jsonb) is
  'THEME & CONTENT SETTINGS v1 — validateur de la forme STOCKÉE des jetons de surface. Miroir de validateThemeTokens (lib/theme-tokens.ts) sur une entrée déjà normalisée.';

revoke all on function public.theme_tokens_valid(jsonb) from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- B. LA COLONNE (additive, NULL par défaut) + son CHECK.
-- ------------------------------------------------------------
alter table public.restaurant_configs
  add column theme_tokens jsonb;

alter table public.restaurant_configs
  add constraint restaurant_configs_theme_tokens_valid
  check (public.theme_tokens_valid(theme_tokens));

comment on column public.restaurant_configs.theme_tokens is
  'THEME & CONTENT SETTINGS v1 — jetons de couleur des surfaces d''information de la vitrine (jeu fermé de 7 clés, #RRGGBB, paires fond/texte à contraste >= 4,5). NULL = aucune configuration, rendu inchangé. Écriture exclusivement via update_restaurant_theme_tokens.';

-- ------------------------------------------------------------
-- C. RPC D'ÉCRITURE — normalise puis valide, jamais l'inverse.
-- ------------------------------------------------------------
create function public.update_restaurant_theme_tokens(
  p_restaurant_id uuid,
  p_tokens        jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  k          text;
  v          jsonb;
  v_text     text;
  v_norm     jsonb := '{}'::jsonb;
  pairs      text[] := array['info_panel_bg', 'info_panel_text', 'popup_bg', 'popup_text', 'delivery_card_bg', 'delivery_card_text'];
  i          integer;
begin
  -- Même autorité que update_restaurant_bg_color / update_restaurant_colors.
  perform public.assert_restaurant_asset_role(p_restaurant_id);

  if p_tokens is not null and pg_catalog.jsonb_typeof(p_tokens) <> 'object' then
    raise exception using errcode = '22023', message = 'SCANYM_THEME_TOKENS_INVALID: NOT_AN_OBJECT';
  end if;

  if p_tokens is not null then
    for k, v in select e.key, e.value from pg_catalog.jsonb_each(p_tokens) e loop
      if not (k = any(public.theme_token_keys())) then
        raise exception using errcode = '22023', message = 'SCANYM_THEME_TOKENS_INVALID: UNKNOWN_KEY';
      end if;
      -- null JSON ou chaîne vide => clé retirée (réinitialisation).
      if pg_catalog.jsonb_typeof(v) = 'null' then
        continue;
      end if;
      if pg_catalog.jsonb_typeof(v) <> 'string' then
        raise exception using errcode = '22023', message = 'SCANYM_THEME_TOKENS_INVALID: INVALID_COLOR ' || k;
      end if;
      v_text := v #>> '{}';
      if v_text = '' then
        continue;
      end if;
      if v_text !~ '^#[0-9A-Fa-f]{6}$' then
        raise exception using errcode = '22023', message = 'SCANYM_THEME_TOKENS_INVALID: INVALID_COLOR ' || k;
      end if;
      v_norm := v_norm || pg_catalog.jsonb_build_object(k, pg_catalog.upper(v_text));
    end loop;

    for i in 0..2 loop
      if (v_norm ? pairs[2 * i + 1]) <> (v_norm ? pairs[2 * i + 2]) then
        raise exception using errcode = '22023', message = 'SCANYM_THEME_TOKENS_INVALID: PAIR_INCOMPLETE ' || pairs[2 * i + 1] || '/' || pairs[2 * i + 2];
      end if;
      if v_norm ? pairs[2 * i + 1]
         and public.theme_token_contrast(v_norm ->> pairs[2 * i + 1], v_norm ->> pairs[2 * i + 2]) < 4.5 then
        raise exception using errcode = '22023', message = 'SCANYM_THEME_TOKENS_INVALID: LOW_CONTRAST ' || pairs[2 * i + 2];
      end if;
    end loop;
  end if;

  update public.restaurant_configs
  set theme_tokens = case when v_norm = '{}'::jsonb then null else v_norm end
  where restaurant_id = p_restaurant_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Restaurant not found';
  end if;
end $$;

comment on function public.update_restaurant_theme_tokens(uuid, jsonb) is
  'THEME & CONTENT SETTINGS v1 — SEULE voie d''écriture de restaurant_configs.theme_tokens. owner/manager du restaurant ou opérateur Scanym (assert_restaurant_asset_role). Normalise (majuscules, valeurs vides retirées), refuse clé inconnue / non-#RRGGBB / paire incomplète / contraste < 4,5 (22023). {} ou NULL remet la colonne à NULL. N''écrit que le restaurant ciblé.';

revoke all on function public.update_restaurant_theme_tokens(uuid, jsonb) from public, anon;
grant execute on function public.update_restaurant_theme_tokens(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------
-- D. CATALOGUE MCC ÉTENDU 14 -> 17 (3 fonctions remplacées, rien d'autre).
--    Même ordre que COMMUNICATION_TEXT_KEYS (lib/communications/text-keys.ts) :
--    les 3 emplacements d'aide à la commande EN TÊTE.
-- ------------------------------------------------------------
create or replace function public.communication_text_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'order_help_button_label',
    'order_help_title',
    'order_help_body',
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
  'MERCHANT CUSTOMER COMMUNICATIONS v1 + THEME & CONTENT SETTINGS v1 — catalogue FERMÉ des 17 emplacements de texte customer-facing configurables. Miroir exact de COMMUNICATION_TEXT_KEYS (lib/communications/text-keys.ts). Aucun GRANT applicatif : autorité interne, appelée par le CHECK et par les RPC de MCC.';

create or replace function public.public_communication_text_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'order_help_button_label',
    'order_help_title',
    'order_help_body',
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
  'MERCHANT CUSTOMER COMMUNICATIONS v1 + THEME & CONTENT SETTINGS v1 — les 14 emplacements exposés à la projection publique anonyme. Miroir exact de PUBLIC_COMMUNICATION_TEXT_KEYS. Les 3 gabarits d''e-mail en sont volontairement exclus.';

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

-- ------------------------------------------------------------
-- E. POST-VOL — dans la transaction, avant le commit.
-- ------------------------------------------------------------
do $$
declare
  v_def text;
  v_fn  text;
begin
  -- Colonne.
  if not exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'restaurant_configs'
      and a.attname = 'theme_tokens' and not a.attisdropped
      and a.atttypid = 'jsonb'::regtype and not a.attnotnull
  ) then
    raise exception 'SCANYM_POSTCHECK: restaurant_configs.theme_tokens (jsonb, nullable) absente.';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'restaurant_configs_theme_tokens_valid'
      and conrelid = 'public.restaurant_configs'::regclass and contype = 'c'
  ) then
    raise exception 'SCANYM_POSTCHECK: CHECK restaurant_configs_theme_tokens_valid absent.';
  end if;

  -- Aucune ligne existante n'a été touchée : toutes à NULL.
  if exists (select 1 from public.restaurant_configs where theme_tokens is not null) then
    raise exception 'SCANYM_POSTCHECK: une ligne restaurant_configs porte theme_tokens alors que le lot n''écrit aucune donnée.';
  end if;

  -- Comportement du validateur (exécuté, pas seulement déclaré).
  if not public.theme_tokens_valid(null)
     or not public.theme_tokens_valid('{}'::jsonb)
     or not public.theme_tokens_valid('{"popup_bg":"#FFFFFF","popup_text":"#000000"}'::jsonb)
     or not public.theme_tokens_valid('{"surface_border":"#808080"}'::jsonb) then
    raise exception 'SCANYM_POSTCHECK: theme_tokens_valid refuse une configuration légitime.';
  end if;
  if public.theme_tokens_valid('{"popup_bg":"#FFFFFF"}'::jsonb)
     or public.theme_tokens_valid('{"popup_bg":"#FFFFFF","popup_text":"#EEEEEE"}'::jsonb)
     or public.theme_tokens_valid('{"popup_bg":"#FFFFFF","popup_text":"#000"}'::jsonb)
     or public.theme_tokens_valid('{"popup_bg":"#ffffff","popup_text":"#000000"}'::jsonb)
     or public.theme_tokens_valid('{"popup_bg":"#FFFFFF","popup_text":"#000000","css":"#000000"}'::jsonb)
     or public.theme_tokens_valid('{"popup_bg":"url(x)","popup_text":"#000000"}'::jsonb)
     or public.theme_tokens_valid('{"surface_border":"red"}'::jsonb)
     or public.theme_tokens_valid('{"surface_border":null}'::jsonb)
     or public.theme_tokens_valid('[]'::jsonb)
     or public.theme_tokens_valid('"#FFFFFF"'::jsonb) then
    raise exception 'SCANYM_POSTCHECK: theme_tokens_valid accepte une configuration illégitime.';
  end if;

  -- Contraste : noir/blanc = 21:1, identique = 1:1.
  if abs(public.theme_token_contrast('#000000', '#FFFFFF') - 21.0) > 1e-9
     or abs(public.theme_token_contrast('#336699', '#336699') - 1.0) > 1e-9 then
    raise exception 'SCANYM_POSTCHECK: theme_token_contrast ne reproduit pas la formule WCAG.';
  end if;

  -- Catalogue MCC étendu : 17 / 14, sous-ensemble public, gabarits d'e-mail exclus.
  if pg_catalog.cardinality(public.communication_text_keys()) <> 17 then
    raise exception 'SCANYM_POSTCHECK: communication_text_keys() doit porter 17 emplacements.';
  end if;
  if pg_catalog.cardinality(public.public_communication_text_keys()) <> 14 then
    raise exception 'SCANYM_POSTCHECK: public_communication_text_keys() doit porter 14 emplacements.';
  end if;
  if exists (
    select 1 from pg_catalog.unnest(public.public_communication_text_keys()) as k
    where not (k = any(public.communication_text_keys()))
  ) then
    raise exception 'SCANYM_POSTCHECK: public_communication_text_keys() n''est pas un sous-ensemble du catalogue.';
  end if;
  if 'email_confirmation_subject' = any(public.public_communication_text_keys())
     or 'email_confirmation_body' = any(public.public_communication_text_keys())
     or 'confirmation_withdrawal_request' = any(public.public_communication_text_keys()) then
    raise exception 'SCANYM_POSTCHECK: un gabarit d''e-mail est exposé publiquement.';
  end if;
  if pg_catalog.cardinality(array(select distinct k from pg_catalog.unnest(public.communication_text_keys()) as k)) <> 17 then
    raise exception 'SCANYM_POSTCHECK: communication_text_keys() porte un doublon.';
  end if;
  if public.communication_text_max_length('order_help_button_label') <> 60
     or public.communication_text_max_length('order_help_title') <> 120
     or public.communication_text_max_length('order_help_body') <> 500
     or public.communication_text_max_length('email_confirmation_subject') <> 160
     or public.communication_text_max_length('checkout_info') <> 500 then
    raise exception 'SCANYM_POSTCHECK: communication_text_max_length() ne porte pas les bornes attendues.';
  end if;

  -- Les trois fonctions MCC remplacées n'ont gagné AUCUN privilège, et les
  -- quatre fonctions du lot n'en ont aucun pour les rôles applicatifs.
  foreach v_fn in array array[
    'public.communication_text_keys()',
    'public.public_communication_text_keys()',
    'public.communication_text_max_length(text)',
    'public.theme_token_keys()',
    'public.theme_token_luminance(text)',
    'public.theme_token_contrast(text,text)',
    'public.theme_tokens_valid(jsonb)'
  ] loop
    if has_function_privilege('anon', v_fn::regprocedure, 'execute')
       or has_function_privilege('authenticated', v_fn::regprocedure, 'execute')
       or has_function_privilege('service_role', v_fn::regprocedure, 'execute') then
      raise exception 'SCANYM_POSTCHECK: % est exécutable par un rôle applicatif.', v_fn;
    end if;
  end loop;

  -- RPC d'écriture : SECURITY DEFINER, search_path figé, jamais anon.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p where p.oid = 'public.update_restaurant_theme_tokens(uuid,jsonb)'::regprocedure;
  if not (select p.prosecdef from pg_proc p where p.oid = 'public.update_restaurant_theme_tokens(uuid,jsonb)'::regprocedure)
     or v_def not like '%search_path%'
     or v_def not like '%assert_restaurant_asset_role(p_restaurant_id)%' then
    raise exception 'SCANYM_POSTCHECK: update_restaurant_theme_tokens doit être SECURITY DEFINER, search_path figé, gardée par assert_restaurant_asset_role.';
  end if;
  if has_function_privilege('anon', 'public.update_restaurant_theme_tokens(uuid,jsonb)'::regprocedure, 'execute')
     or not has_function_privilege('authenticated', 'public.update_restaurant_theme_tokens(uuid,jsonb)'::regprocedure, 'execute') then
    raise exception 'SCANYM_POSTCHECK: update_restaurant_theme_tokens doit être exécutable par authenticated seulement.';
  end if;

  -- Aucune écriture directe ouverte sur la colonne : l'unique voie est le RPC.
  if has_column_privilege('anon', 'public.restaurant_configs', 'theme_tokens', 'update')
     or has_column_privilege('authenticated', 'public.restaurant_configs', 'theme_tokens', 'update')
     or has_column_privilege('anon', 'public.restaurant_configs', 'theme_tokens', 'insert')
     or has_column_privilege('authenticated', 'public.restaurant_configs', 'theme_tokens', 'insert') then
    raise exception 'SCANYM_POSTCHECK: theme_tokens est inscriptible directement par un rôle applicatif.';
  end if;

  -- Les RPC MCC n'ont pas été redéfinies : toujours adossées aux catalogues.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'set_merchant_communication_text';
  if v_def not like '%public.communication_text_keys()%' then
    raise exception 'SCANYM_POSTCHECK: set_merchant_communication_text ne s''appuie plus sur le catalogue.';
  end if;
end $$;

commit;
