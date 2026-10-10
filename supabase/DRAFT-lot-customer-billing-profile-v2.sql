-- ============================================================
-- Scanym — CUSTOMER BILLING PROFILE v2 (DRAFT — NOT APPLIED)
--
-- DRAFT ONLY. DO NOT APPLY TO HOSTED SUPABASE.
-- Aucune application en préproduction ni en production sans GO CIO
-- explicite.
--
-- CE QUE CE LOT FAIT, ET RIEN D'AUTRE
--
--   1. `order_invoice_request.siren` — UNE colonne NULLABLE. Le dépôt
--      ne porte aujourd'hui AUCUN SIREN côté client (seul
--      `merchant_legal_profile.siren`, qui est le SIREN DU VENDEUR,
--      existe -- un concept distinct, jamais réutilisé ici).
--   2. `set_order_invoice_request` / `get_order_invoice_request` —
--      UN paramètre optionnel en FIN de signature, UNE colonne de plus
--      au retour. Aucune autre règle touchée.
--   3. `communication_text_keys()` / `public_communication_text_keys()`
--      — UN emplacement de texte marchand de plus,
--      `billing_profile_explanation`, dans le catalogue FERMÉ existant
--      de MERCHANT CUSTOMER COMMUNICATIONS v1.
--
-- v2.1 — RECOMPOSITION SUR LE MAIN COURANT (THEME & CONTENT SETTINGS
-- v1 + CATALOGUE PRODUCT REORDER v1.1). Le catalogue d'emplacements a
-- légitimement grandi entre-temps : THEME & CONTENT SETTINGS v1 y a
-- ajouté order_help_button_label / order_help_title / order_help_body
-- et porte leurs bornes propres (60 / 120) dans
-- `communication_text_max_length()`. Ce fichier reconduit donc ces
-- trois emplacements À L'IDENTIQUE et n'ajoute QUE le sien : la seule
-- chose que ce lot POSSÈDE dans le catalogue est
-- `billing_profile_explanation`. Les gardes et les postchecks portent
-- désormais sur cette PROPRIÉTÉ (égalité de contenu « entrée + ma
-- clé »), et non plus sur un effectif figé qui daterait au premier lot
-- suivant. `communication_text_max_length()` n'est PAS redéfinie ici :
-- elle appartient à Theme, et un postcheck le prouve en base.
-- Aucun objet de CATALOGUE PRODUCT REORDER v1.1 (`move_product_order`,
-- `products.display_order`) n'est touché : aucun recouvrement.
--
-- CE QUE CE LOT NE FAIT PAS
--
--   - aucune nouvelle table, aucun nouveau mécanisme de demande de
--     facture (la fondation existante est RÉUTILISÉE telle quelle) ;
--   - aucun champ SIRET, nulle part -- et aucune dérivation de SIRET
--     depuis un SIREN, ni de TVA depuis un SIREN : les trois
--     identifiants sont indépendants et saisis par le client seul ;
--   - aucun appel à un registre d'entreprises, aucune « correction »
--     automatique d'un identifiant saisi : la valeur du client prévaut
--     toujours, telle quelle (seul le blanc de bordure est retiré,
--     comme pour tous les autres champs de cette RPC depuis v1.1) ;
--   - aucune validation d'autorité fiscale, aucune règle par pays ;
--   - aucune génération de facture, aucun PDF, aucune numérotation ;
--   - aucune modification de RLS, de policy, de GRANT, de
--     `create_order`, du paiement, de la livraison, des CGV ;
--   - aucun backfill : une commande existante reste valide, son SIREN
--     vaut NULL, ce qui signifie « non renseigné » et jamais « vide ».
--
-- POURQUOI DROP + CREATE SUR LES DEUX RPC
--
-- Ajouter un paramètre (même optionnel) CHANGE la signature, et
-- ajouter une colonne au RETURNS TABLE change le type de retour :
-- `create or replace` est alors refusé par PostgreSQL. Le fichier
-- supprime donc explicitement l'ANCIENNE signature (12 arguments pour
-- l'écriture) puis recrée la nouvelle, et REPOSE immédiatement les
-- privilèges -- un DROP les emporte. Les postchecks ci-dessous
-- vérifient qu'aucun privilège n'a été perdu ni élargi, et qu'aucune
-- surcharge résiduelle ne subsiste (deux signatures coexistantes
-- seraient une ambiguïté d'appel, donc un risque réel).
-- ============================================================

-- ------------------------------------------------------------
-- A. PRÉ-VOL — hors transaction. Prérequis réels et
--    anti-double-application. Aucune supposition.
-- ------------------------------------------------------------
do $$
begin
  -- Fondation CUSTOMER CHECKOUT — INVOICE REQUEST.
  if to_regclass('public.order_invoice_request') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.order_invoice_request absente -- DRAFT-lot-invoice-request-foundation-v1.sql doit être appliqué avant, annulé.';
  end if;
  if to_regprocedure('public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: set_order_invoice_request (forme 12 arguments) introuvable -- une autre version est en place, annulé.';
  end if;
  if to_regprocedure('public.get_order_invoice_request(uuid,uuid)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: get_order_invoice_request introuvable, annulé.';
  end if;

  -- La forme ACTUELLE de l'écriture doit porter la validation de
  -- format d'e-mail (EMAIL VALIDATION DELTA v1) : sans elle, une
  -- version ANTÉRIEURE est en place et ce fichier l'écraserait en
  -- perdant cette règle au passage.
  if not exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_order_invoice_request'
      and p.prosrc like '%p_contact_email invalide%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: set_order_invoice_request ne porte pas la validation de format d''e-mail (EMAIL VALIDATION DELTA v1) -- appliquer ce delta avant, annulé.';
  end if;

  -- MERCHANT CUSTOMER COMMUNICATIONS v1, ÉTENDU par THEME & CONTENT
  -- SETTINGS v1 : ce lot ajoute UN emplacement de plus, le sien.
  if to_regprocedure('public.communication_text_keys()') is null
     or to_regprocedure('public.public_communication_text_keys()') is null
     or to_regprocedure('public.communication_text_max_length(text)') is null
     or to_regprocedure('public.get_restaurant_public_communication_texts(uuid)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: catalogue MERCHANT CUSTOMER COMMUNICATIONS v1 introuvable -- annulé.';
  end if;

  -- v2.1 (RECOMPOSITION) -- la garde ne porte PLUS sur un EFFECTIF
  -- (« 14 emplacements ») mais sur le CONTENU attendu. Deux raisons,
  -- et la seconde est la vraie :
  --
  --   a) le catalogue a légitimement grandi depuis que ce lot a été
  --      écrit (THEME & CONTENT SETTINGS v1 y a ajouté les trois
  --      emplacements order_help_*), donc un effectif figé daterait ;
  --   b) ce fichier RÉÉCRIT la liste complète. Un effectif juste ne
  --      prouverait pas que la liste réécrite CONTIENT l'existant :
  --      si un lot inconnu avait remplacé un emplacement par un autre,
  --      le compte serait bon et l'emplacement inconnu serait EFFACÉ
  --      sans bruit. L'égalité de contenu, elle, l'interdit.
  --
  -- Invariant de PROPRIÉTÉ : l'état d'entrée doit être EXACTEMENT la
  -- nouvelle liste PRIVÉE de l'emplacement que ce lot possède.
  if public.communication_text_keys() <> array[
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
  ]::text[] then
    raise exception 'SCANYM_SCHEMA_DRIFT: communication_text_keys() ne porte pas le catalogue attendu (MCC v1 + THEME & CONTENT SETTINGS v1) -- réécrire la liste effacerait un emplacement inconnu, annulé. État lu : %', public.communication_text_keys();
  end if;
  if public.public_communication_text_keys() <> array[
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
  ]::text[] then
    raise exception 'SCANYM_SCHEMA_DRIFT: public_communication_text_keys() ne porte pas la projection publique attendue -- annulé. État lu : %', public.public_communication_text_keys();
  end if;

  -- Les bornes propres à THEME & CONTENT SETTINGS v1 doivent être en
  -- place : ce fichier remet les trois emplacements order_help_* dans
  -- le catalogue, et les y remettre sans leurs bornes (60 / 120) les
  -- ferait silencieusement retomber à 500 -- une régression de Theme
  -- causée par un lot de facturation.
  if public.communication_text_max_length('order_help_button_label') <> 60
     or public.communication_text_max_length('order_help_title') <> 120
     or public.communication_text_max_length('order_help_body') <> 500
     or public.communication_text_max_length('email_confirmation_subject') <> 160 then
    raise exception 'SCANYM_SCHEMA_DRIFT: communication_text_max_length() ne porte pas les bornes de THEME & CONTENT SETTINGS v1 -- annulé.';
  end if;

  -- Anti-double-application.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_invoice_request' and column_name = 'siren'
  ) then
    raise exception 'SCANYM_ALREADY_APPLIED: order_invoice_request.siren existe déjà -- CUSTOMER BILLING PROFILE v2 annulé.';
  end if;
  if 'billing_profile_explanation' = any(public.communication_text_keys()) then
    raise exception 'SCANYM_ALREADY_APPLIED: l''emplacement billing_profile_explanation existe déjà -- annulé.';
  end if;

  -- Aucun SIRET nulle part : ce lot n'en introduit pas, et il refuse
  -- de s'appliquer sur un schéma où un lot non revu en aurait glissé
  -- un sur cette table (garde de principe produit, pas de confort).
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_invoice_request' and column_name like '%siret%'
  ) then
    raise exception 'SCANYM_UNEXPECTED_STATE: une colonne SIRET existe sur order_invoice_request -- le produit n''en demande aucune, annulé.';
  end if;
end $$;

begin;

-- ------------------------------------------------------------
-- B. COLONNE SIREN — optionnelle, bornée en LONGUEUR seulement.
--
-- Pourquoi 14 et non 9 : le SIREN français compte 9 chiffres, mais
-- cette colonne accueille l'identifiant que LE CLIENT saisit, y
-- compris avec les espaces de lisibilité qu'il peut y mettre
-- (« 123 456 789 »). Imposer 9 caractères bruts reviendrait à
-- « corriger » sa saisie -- précisément ce que le produit interdit.
-- La borne est donc une borne de STOCKAGE, jamais un format : aucune
-- vérification de chiffres, aucune clé de Luhn, aucune complétion.
-- ------------------------------------------------------------
alter table public.order_invoice_request
  add column siren text
    check (siren is null or length(siren) between 1 and 14);

comment on column public.order_invoice_request.siren is
  'CUSTOMER BILLING PROFILE v2 — identifiant SIREN tel que SAISI PAR LE CLIENT. OPTIONNEL en toutes circonstances, y compris pour une facture société (décision produit explicite). Validation de LONGUEUR uniquement : aucun contrôle de format, aucune clé de contrôle, aucune complétion, aucun appel à un registre d''entreprises, et JAMAIS une dérivation vers un SIRET ou un numéro de TVA (ces trois identifiants sont indépendants). NULL = non renseigné, jamais une chaîne vide. Distinct de merchant_legal_profile.siren, qui est le SIREN DU VENDEUR.';

-- ------------------------------------------------------------
-- C. ÉCRITURE — même corps, UN paramètre optionnel de plus en FIN
--    de signature. Chaque ligne existante est reprise À L'IDENTIQUE.
-- ------------------------------------------------------------
drop function public.set_order_invoice_request(uuid, uuid, text, text, text, text, text, text, text, text, text, text);

create function public.set_order_invoice_request(
  p_order_id           uuid,
  p_public_token       uuid,
  p_invoice_type       text,
  p_address_line_1     text,
  p_city               text,
  p_postal_code        text,
  p_country            text,
  p_address_line_2     text default null,
  p_company_legal_name text default null,
  p_vat_number         text default null,
  p_contact_name       text default null,
  p_contact_email      text default null,
  -- CUSTOMER BILLING PROFILE v2 — dernier paramètre, optionnel : un
  -- appelant antérieur à ce lot, qui ne le transmet pas, continue de
  -- fonctionner EXACTEMENT comme avant (SIREN reste NULL).
  p_siren              text default null
)
returns table (
  order_id      uuid,
  invoice_type  text,
  updated_at    timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_order               public.orders%rowtype;
  v_invoice_type        text;
  v_address_line_1      text;
  v_address_line_2      text;
  v_city                text;
  v_postal_code         text;
  v_country             text;
  v_company_legal_name  text;
  v_vat_number          text;
  v_contact_name        text;
  v_contact_email       text;
  v_siren               text;
begin
  if p_order_id is null or p_public_token is null then
    raise exception 'SCANYM_INVOICE_REQUEST: p_order_id/p_public_token requis' using errcode = '22004';
  end if;

  select * into v_order
  from public.orders o
  where o.id = p_order_id and o.public_token = p_public_token;

  if not found then
    raise exception 'SCANYM_INVOICE_REQUEST: commande introuvable pour ce couple id/jeton' using errcode = 'P0002';
  end if;

  v_invoice_type := btrim(coalesce(p_invoice_type, ''));
  if v_invoice_type not in ('individual', 'company') then
    raise exception 'SCANYM_INVOICE_REQUEST: p_invoice_type doit valoir exactement ''individual'' ou ''company''' using errcode = '22023';
  end if;

  v_address_line_1 := nullif(btrim(coalesce(p_address_line_1, '')), '');
  if v_address_line_1 is null then
    raise exception 'SCANYM_INVOICE_REQUEST: p_address_line_1 requis' using errcode = '22004';
  end if;
  if length(v_address_line_1) > 50 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_address_line_1 dépasse 50 caractères -- aucune troncature silencieuse' using errcode = '22001';
  end if;

  v_address_line_2 := nullif(btrim(coalesce(p_address_line_2, '')), '');
  if v_address_line_2 is not null and length(v_address_line_2) > 50 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_address_line_2 dépasse 50 caractères' using errcode = '22001';
  end if;

  v_city := nullif(btrim(coalesce(p_city, '')), '');
  if v_city is null then
    raise exception 'SCANYM_INVOICE_REQUEST: p_city requis' using errcode = '22004';
  end if;
  if length(v_city) > 50 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_city dépasse 50 caractères -- aucune troncature silencieuse' using errcode = '22001';
  end if;

  v_postal_code := nullif(btrim(coalesce(p_postal_code, '')), '');
  if v_postal_code is null then
    raise exception 'SCANYM_INVOICE_REQUEST: p_postal_code requis' using errcode = '22004';
  end if;
  if length(v_postal_code) > 10 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_postal_code dépasse 10 caractères -- aucune troncature silencieuse' using errcode = '22001';
  end if;

  v_country := upper(btrim(coalesce(p_country, '')));
  if v_country !~ '^[A-Z]{2}$' then
    raise exception 'SCANYM_INVOICE_REQUEST: p_country doit être un code ISO 3166-1 alpha-2 (2 lettres)' using errcode = '22023';
  end if;

  v_company_legal_name := nullif(btrim(coalesce(p_company_legal_name, '')), '');
  if v_invoice_type = 'company' and v_company_legal_name is null then
    raise exception 'SCANYM_INVOICE_REQUEST: p_company_legal_name requis lorsque p_invoice_type = ''company''' using errcode = '22004';
  end if;
  if v_company_legal_name is not null and length(v_company_legal_name) > 120 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_company_legal_name dépasse 120 caractères' using errcode = '22001';
  end if;

  v_vat_number := nullif(btrim(coalesce(p_vat_number, '')), '');
  if v_vat_number is not null and length(v_vat_number) > 30 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_vat_number dépasse 30 caractères' using errcode = '22001';
  end if;

  -- CUSTOMER BILLING PROFILE v2 — SIREN. TROIS choses, et trois
  -- seulement : retrait du blanc de bordure (comme tout autre champ
  -- de cette RPC), chaîne vide -> NULL, borne de longueur. AUCUN
  -- contrôle de format, AUCUNE normalisation des espaces internes,
  -- AUCUNE dérivation : la saisie du client prévaut telle quelle, et
  -- un SIREN manquant n'est jamais une erreur -- pas même pour une
  -- facture société.
  v_siren := nullif(btrim(coalesce(p_siren, '')), '');
  if v_siren is not null and length(v_siren) > 14 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_siren dépasse 14 caractères' using errcode = '22001';
  end if;

  v_contact_name := nullif(btrim(coalesce(p_contact_name, '')), '');
  if v_contact_name is not null and length(v_contact_name) > 45 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_contact_name dépasse 45 caractères' using errcode = '22001';
  end if;

  v_contact_email := nullif(btrim(coalesce(p_contact_email, '')), '');
  if v_contact_email is not null and length(v_contact_email) > 100 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_contact_email dépasse 100 caractères' using errcode = '22001';
  end if;
  -- EMAIL VALIDATION DELTA v1 — REPRIS À L'IDENTIQUE (même regex que
  -- create_order, même errcode). contact_email reste OPTIONNEL.
  if v_contact_email is not null and v_contact_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$' then
    raise exception 'SCANYM_INVOICE_REQUEST: p_contact_email invalide' using errcode = '22023';
  end if;

  insert into public.order_invoice_request (
    order_id, invoice_type, company_legal_name, vat_number, siren,
    contact_name, contact_email,
    address_line_1, address_line_2, city, postal_code, country,
    updated_at
  ) values (
    p_order_id, v_invoice_type, v_company_legal_name, v_vat_number, v_siren,
    v_contact_name, v_contact_email,
    v_address_line_1, v_address_line_2, v_city, v_postal_code, v_country,
    now()
  )
  on conflict (order_id) do update set
    invoice_type        = excluded.invoice_type,
    company_legal_name  = excluded.company_legal_name,
    vat_number           = excluded.vat_number,
    siren                = excluded.siren,
    contact_name         = excluded.contact_name,
    contact_email        = excluded.contact_email,
    address_line_1       = excluded.address_line_1,
    address_line_2       = excluded.address_line_2,
    city                 = excluded.city,
    postal_code          = excluded.postal_code,
    country              = excluded.country,
    updated_at           = now();

  return query
    select r.order_id, r.invoice_type, r.updated_at
    from public.order_invoice_request r
    where r.order_id = p_order_id;
end;
$$;

comment on function public.set_order_invoice_request(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text) is
  'SECURITY DEFINER -- CUSTOMER BILLING PROFILE v2 (fondation + delta e-mail + SIREN). Écrit/met à jour (upsert déterministe) le profil de facturation d''une commande, avec preuve de possession anonyme (id + public_token). Échec fermé sur toute entrée invalide. SIREN et numéro de TVA sont OPTIONNELS, validés en LONGUEUR seulement : aucun contrôle de format, aucune dérivation (jamais de SIRET depuis un SIREN, jamais de TVA depuis un SIREN), aucun appel de registre, aucune correction de la saisie du client. AUCUN déclenchement de paiement, de livraison, ni de communication client.';

-- Les privilèges sont REPOSÉS immédiatement : un DROP les a emportés.
-- Posture IDENTIQUE à l'avant-lot, jamais élargie.
revoke all on function public.set_order_invoice_request(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.set_order_invoice_request(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text) to service_role;

-- ------------------------------------------------------------
-- D. LECTURE — même corps, UNE colonne de plus au retour.
-- ------------------------------------------------------------
drop function public.get_order_invoice_request(uuid, uuid);

create function public.get_order_invoice_request(
  p_order_id      uuid,
  p_public_token  uuid
)
returns table (
  invoice_type         text,
  company_legal_name   text,
  vat_number           text,
  siren                text,
  contact_name         text,
  contact_email        text,
  address_line_1       text,
  address_line_2       text,
  city                 text,
  postal_code          text,
  country              text,
  updated_at           timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_order_id is null or p_public_token is null then
    raise exception 'SCANYM_INVOICE_REQUEST: p_order_id/p_public_token requis' using errcode = '22004';
  end if;

  if not exists (
    select 1 from public.orders o
    where o.id = p_order_id and o.public_token = p_public_token
  ) then
    raise exception 'SCANYM_INVOICE_REQUEST: commande introuvable pour ce couple id/jeton' using errcode = 'P0002';
  end if;

  return query
    select r.invoice_type, r.company_legal_name, r.vat_number, r.siren,
           r.contact_name, r.contact_email,
           r.address_line_1, r.address_line_2, r.city, r.postal_code, r.country,
           r.updated_at
    from public.order_invoice_request r
    where r.order_id = p_order_id;
end;
$$;

comment on function public.get_order_invoice_request(uuid, uuid) is
  'SECURITY DEFINER, lecture -- même preuve de possession anonyme que set_order_invoice_request. Absence de ligne = "pas de facture demandée", jamais une erreur. CUSTOMER BILLING PROFILE v2 : expose en plus le SIREN tel que saisi par le client (NULL = non renseigné).';

revoke all on function public.get_order_invoice_request(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_order_invoice_request(uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- E. TEXTE MARCHAND — UN emplacement de plus dans le catalogue
--    FERMÉ (18e sur le schéma courant : MCC v1 + THEME & CONTENT
--    SETTINGS v1 + celui-ci).
--
-- §6 du mandat : « Any explanatory/help text specific to a merchant
-- must be merchant-configurable. Do NOT hardcode Au Lait Cru wording.
-- Do NOT build a generic CMS. » Le mécanisme existe déjà (MERCHANT
-- CUSTOMER COMMUNICATIONS v1) : un catalogue FERMÉ d'emplacements, du
-- texte BRUT borné, écriture RPC-only, lecture publique filtrée. On y
-- ajoute UN emplacement, on n'invente ni table, ni RPC, ni CMS.
--
-- Aucun défaut plateforme n'est associé à cet emplacement : tant
-- qu'aucun commerçant ne le renseigne, le checkout affiche
-- EXACTEMENT ce qu'il affiche aujourd'hui -- compatibilité arrière
-- stricte, et aucun texte inventé.
-- ------------------------------------------------------------
create or replace function public.communication_text_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    -- THEME & CONTENT SETTINGS v1 — repris À L'IDENTIQUE, même ordre.
    -- Ce lot ne possède PAS ces trois emplacements : il les reconduit.
    'order_help_button_label',
    'order_help_title',
    'order_help_body',
    -- MERCHANT CUSTOMER COMMUNICATIONS v1 — repris À L'IDENTIQUE.
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
    'confirmation_withdrawal_request',
    -- CUSTOMER BILLING PROFILE v2 — le SEUL emplacement que ce lot
    -- possède, et donc le seul qu'il ajoute ou retire.
    'billing_profile_explanation'
  ]::text[]
$$;

comment on function public.communication_text_keys() is
  'MERCHANT CUSTOMER COMMUNICATIONS v1 + THEME & CONTENT SETTINGS v1 + CUSTOMER BILLING PROFILE v2 — catalogue FERMÉ des 18 emplacements de texte customer-facing configurables. Miroir exact de COMMUNICATION_TEXT_KEYS (lib/communications/text-keys.ts). CUSTOMER BILLING PROFILE v2 n''ajoute QUE billing_profile_explanation, sans défaut plateforme : absent = rien affiché, jamais un texte vide.';

create or replace function public.public_communication_text_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    -- THEME & CONTENT SETTINGS v1 — repris À L'IDENTIQUE.
    'order_help_button_label',
    'order_help_title',
    'order_help_body',
    -- MERCHANT CUSTOMER COMMUNICATIONS v1 — repris À L'IDENTIQUE.
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
    -- CUSTOMER BILLING PROFILE v2 — emplacement affiché DANS le
    -- checkout : il doit donc sortir par la projection publique
    -- anonyme, exactement comme checkout_info.
    'billing_profile_explanation'
  ]::text[]
$$;

comment on function public.public_communication_text_keys() is
  'MERCHANT CUSTOMER COMMUNICATIONS v1 + THEME & CONTENT SETTINGS v1 + CUSTOMER BILLING PROFILE v2 — les 15 emplacements exposés à la projection publique anonyme. Miroir exact de PUBLIC_COMMUNICATION_TEXT_KEYS. Les 3 gabarits d''e-mail en restent volontairement exclus.';

-- ------------------------------------------------------------
-- F. POSTCHECKS — exécutés PAR cette migration, avant commit.
--    Jamais seulement documentés.
-- ------------------------------------------------------------
do $$
begin
  -- 1. Colonne SIREN : présente, NULLABLE, sans valeur par défaut
  --    (donc aucune commande existante n'est modifiée).
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_invoice_request'
      and column_name = 'siren' and is_nullable = 'YES' and column_default is null
  ) then
    raise exception 'SCANYM_POSTCHECK_FAILED: order_invoice_request.siren absente, NOT NULL, ou pourvue d''un défaut.';
  end if;

  -- 2. Aucun SIRET introduit, nulle part sur cette table.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_invoice_request' and column_name like '%siret%'
  ) then
    raise exception 'SCANYM_POSTCHECK_FAILED: une colonne SIRET est apparue -- le produit n''en demande aucune.';
  end if;

  -- 3. Une seule signature d'écriture : la nouvelle. Deux surcharges
  --    coexistantes seraient une ambiguïté d'appel réelle.
  if (select count(*) from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'set_order_invoice_request') <> 1 then
    raise exception 'SCANYM_POSTCHECK_FAILED: set_order_invoice_request existe en plusieurs surcharges.';
  end if;
  if to_regprocedure('public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text,text)') is null then
    raise exception 'SCANYM_POSTCHECK_FAILED: la nouvelle signature (13 arguments) de set_order_invoice_request est absente.';
  end if;
  if (select count(*) from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'get_order_invoice_request') <> 1 then
    raise exception 'SCANYM_POSTCHECK_FAILED: get_order_invoice_request existe en plusieurs surcharges.';
  end if;

  -- 4. La règle d'e-mail du delta est TOUJOURS là (elle n'a pas été
  --    perdue par la recréation de la fonction).
  if not exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_order_invoice_request'
      and p.prosrc like '%p_contact_email invalide%'
  ) then
    raise exception 'SCANYM_POSTCHECK_FAILED: la validation de format d''e-mail a disparu de set_order_invoice_request.';
  end if;

  -- 5. Aucune inférence : la fonction ne doit mentionner NI SIRET, NI
  --    une quelconque dérivation d''identifiant.
  if exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_order_invoice_request'
      and (p.prosrc ilike '%siret%' or p.prosrc ilike '%luhn%')
  ) then
    raise exception 'SCANYM_POSTCHECK_FAILED: set_order_invoice_request mentionne un SIRET ou une clé de contrôle -- aucune inférence n''est autorisée.';
  end if;

  -- 6. Posture de sécurité : STRICTEMENT celle d'avant le lot.
  if has_table_privilege('anon', 'public.order_invoice_request', 'select')
     or has_table_privilege('authenticated', 'public.order_invoice_request', 'insert')
     or has_table_privilege('service_role', 'public.order_invoice_request', 'insert') then
    raise exception 'SCANYM_SECURITY_DRIFT: privilège de table inattendu sur order_invoice_request.';
  end if;
  if has_function_privilege('anon', 'public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text,text)', 'execute')
     or has_function_privilege('anon', 'public.get_order_invoice_request(uuid,uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.get_order_invoice_request(uuid,uuid)', 'execute') then
    raise exception 'SCANYM_SECURITY_DRIFT: une RPC de facturation est devenue exécutable par anon/authenticated.';
  end if;
  if not has_function_privilege('service_role', 'public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text,text)', 'execute')
     or not has_function_privilege('service_role', 'public.get_order_invoice_request(uuid,uuid)', 'execute') then
    raise exception 'SCANYM_REGRESSION: service_role a perdu EXECUTE sur une RPC de facturation après le DROP/CREATE.';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.order_invoice_request'::regclass) then
    raise exception 'SCANYM_SECURITY_DRIFT: RLS désactivée sur order_invoice_request.';
  end if;
  if not exists (
    select 1 from pg_policies
    where tablename = 'order_invoice_request' and policyname = 'order_invoice_request_select_staff'
  ) then
    raise exception 'SCANYM_SECURITY_DRIFT: la policy order_invoice_request_select_staff a disparu.';
  end if;

  -- 7. Catalogue de textes : l'état d'entrée + le seul emplacement
  --    possédé par ce lot (18 / 15 sur le schéma courant), et le
  --    nouvel emplacement effectivement accepté par la contrainte de
  --    la table (donc réellement configurable).
  -- v2.1 (RECOMPOSITION) -- PROPRIÉTÉ, et non effectif : le catalogue
  -- d'arrivée doit être exactement l'état d'entrée PLUS le seul
  -- emplacement que ce lot possède. Un emplacement de THEME & CONTENT
  -- SETTINGS v1 disparu ferait donc échouer ce postcheck, et la
  -- transaction entière serait annulée.
  if public.communication_text_keys() <> array[
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
    'confirmation_withdrawal_request',
    'billing_profile_explanation'
  ]::text[] then
    raise exception 'SCANYM_POSTCHECK_FAILED: communication_text_keys() n''est pas l''état d''entrée + billing_profile_explanation. État : %', public.communication_text_keys();
  end if;
  -- Les trois emplacements de THEME & CONTENT SETTINGS v1 sont
  -- nommément VÉRIFIÉS présents : aucune clé de Theme ne peut avoir
  -- été perdue par la réécriture de la liste.
  if not ('order_help_button_label' = any(public.communication_text_keys()))
     or not ('order_help_title' = any(public.communication_text_keys()))
     or not ('order_help_body' = any(public.communication_text_keys())) then
    raise exception 'SCANYM_POSTCHECK_FAILED: un emplacement de THEME & CONTENT SETTINGS v1 a disparu du catalogue.';
  end if;
  -- …et leurs bornes propres n'ont pas bougé : ce lot ne redéfinit pas
  -- communication_text_max_length(), ce postcheck le PROUVE en base.
  if public.communication_text_max_length('order_help_button_label') <> 60
     or public.communication_text_max_length('order_help_title') <> 120
     or public.communication_text_max_length('order_help_body') <> 500
     or public.communication_text_max_length('email_confirmation_subject') <> 160
     or public.communication_text_max_length('billing_profile_explanation') <> 500 then
    raise exception 'SCANYM_POSTCHECK_FAILED: les bornes de longueur par emplacement ont changé.';
  end if;
  if public.public_communication_text_keys() <> array[
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
    'billing_profile_explanation'
  ]::text[] then
    raise exception 'SCANYM_POSTCHECK_FAILED: public_communication_text_keys() n''est pas la projection d''entrée + billing_profile_explanation. État : %', public.public_communication_text_keys();
  end if;
  -- Les 3 gabarits d'e-mail restent hors projection publique.
  if 'email_confirmation_subject' = any(public.public_communication_text_keys())
     or 'email_confirmation_body' = any(public.public_communication_text_keys())
     or 'confirmation_withdrawal_request' = any(public.public_communication_text_keys()) then
    raise exception 'SCANYM_SECURITY_DRIFT: un gabarit d''e-mail est devenu public.';
  end if;
end $$;

commit;

-- ============================================================
-- APRÈS CE FICHIER : aucune commande existante n'a changé. Les
-- commandes antérieures gardent siren = NULL (« non renseigné »), et
-- un commerçant qui ne configure pas billing_profile_explanation voit
-- le checkout EXACTEMENT comme avant.
-- ============================================================
