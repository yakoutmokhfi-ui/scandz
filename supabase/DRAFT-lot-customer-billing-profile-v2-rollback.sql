-- ============================================================
-- Scanym — CUSTOMER BILLING PROFILE v2 — ROLLBACK (DRAFT)
--
-- DRAFT ONLY. DO NOT APPLY TO HOSTED SUPABASE.
--
-- Remet EXACTEMENT l'état d'avant DRAFT-lot-customer-billing-profile-v2.sql :
--   - `set_order_invoice_request` dans sa forme 12 arguments
--     (fondation + EMAIL VALIDATION DELTA v1), corps repris À
--     L'IDENTIQUE du fichier de delta ;
--   - `get_order_invoice_request` sans la colonne `siren` ;
--   - les catalogues d'emplacements de texte DU MAIN COURANT,
--     c'est-à-dire MCC v1 + THEME & CONTENT SETTINGS v1 (17 / 14),
--     privés du seul emplacement possédé par ce lot ;
--   - la colonne `order_invoice_request.siren` supprimée.
--
-- AVERTISSEMENT DONNÉES : supprimer la colonne `siren` DÉTRUIT les
-- identifiants SIREN que des clients auraient saisis. Ce sont des
-- données saisies par le client sur une facture demandée : les
-- EXPORTER avant exécution si la moindre ligne non nulle existe. Le
-- garde ci-dessous REFUSE le rollback dans ce cas plutôt que de
-- détruire silencieusement -- il faut une décision explicite.
--
-- GARDE ANTI-DÉRIVE : si l'une des deux RPC a été modifiée APRÈS ce
-- lot par un autre travail non revu, ce fichier refuse de s'exécuter
-- plutôt que d'écraser cette modification.
--
-- ------------------------------------------------------------
-- v2.1 — CORRECTION D'AUDIT CBP-02 (HIGH) : SÛRETÉ TRANSACTIONNELLE
-- ------------------------------------------------------------
-- La v2 plaçait les gardes AVANT `begin;`, dans une transaction
-- implicite distincte de celle qui détruit. Deux défauts réels :
--
--   1. TOCTOU. La garde pouvait constater « aucun SIREN », une autre
--      transaction écrire un SIREN juste après, et le `drop column`
--      le détruire ensuite -- la garde ne protégeait rien pendant la
--      fenêtre qui compte.
--   2. CONTINUATION. Un exécuteur SQL sans `ON_ERROR_STOP` (psql par
--      défaut, un outil de migration, un copier-coller) poursuit
--      après une instruction en échec : la garde échouait, et le
--      `begin;` suivant ouvrait une transaction PROPRE dans laquelle
--      la destruction s'exécutait quand même.
--
-- Corrigé par la STRUCTURE du fichier, jamais par une consigne
-- d'exécution :
--
--   * `begin;` est désormais la PREMIÈRE instruction ;
--   * un VERROU est pris sur les deux tables concernées AVANT toute
--      garde (voir la justification du niveau de verrou ci-dessous) ;
--   * les gardes s'exécutent DANS cette même transaction ;
--   * une garde qui lève abandonne la transaction : toutes les
--      instructions suivantes -- y compris le `drop column` --
--      échouent alors avec « current transaction is aborted », et le
--      `commit;` final se comporte en ROLLBACK. La destruction est
--      donc INATTEIGNABLE, que l'exécuteur s'arrête ou non ;
--   * `commit;` reste la dernière instruction exécutable du fichier.
--
-- NIVEAU DE VERROU — `SHARE`, et pourquoi c'est le plus étroit qui
-- garantisse réellement la fenêtre : `INSERT`/`UPDATE`/`DELETE`
-- prennent `ROW EXCLUSIVE`, qui est en conflit avec `SHARE`. Prendre
-- `SHARE` fait donc deux choses : il ATTEND la fin des écrivains déjà
-- en vol (la garde voit donc leur résultat définitif) et il BLOQUE
-- tout nouvel écrivain jusqu'à la fin de cette transaction -- donc
-- jusqu'après la destruction. Un niveau plus faible ne suffirait pas :
-- `ACCESS SHARE` et `ROW SHARE` n'entrent pas en conflit avec
-- `ROW EXCLUSIVE` et laisseraient passer précisément l'écriture à
-- empêcher (verrou « ornemental »). Un niveau plus fort
-- (`ACCESS EXCLUSIVE`) bloquerait en plus les simples lectures, sans
-- rien garantir de plus pour ce risque-ci. Le `alter table ... drop
-- column` final élève de lui-même le verrou à `ACCESS EXCLUSIVE` ;
-- si deux exécutions concurrentes de ce rollback se croisaient,
-- l'élévation peut produire un interblocage -- PostgreSQL en abandonne
-- une, ce qui reste un échec FERMÉ, jamais une destruction partielle.
-- ============================================================

-- ------------------------------------------------------------
-- 0. TRANSACTION UNIQUE — ouverte AVANT toute garde (CBP-02).
--    Tout ce qui suit, gardes comprises, vit dans cette transaction.
-- ------------------------------------------------------------
begin;

-- Verrou pris AVANT la garde, relâché seulement au commit : aucune
-- écriture de SIREN ne peut se glisser entre le constat et la
-- destruction (voir la justification du niveau SHARE en en-tête).
-- `order_invoice_request` d'abord, `merchant_communication_text`
-- ensuite : ordre FIXE, pour ne pas créer d'interblocage avec une
-- autre exécution de ce même fichier.
lock table public.order_invoice_request in share mode;
lock table public.merchant_communication_text in share mode;

do $$
declare
  v_siren_rows bigint;
begin
  if to_regclass('public.order_invoice_request') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.order_invoice_request absente -- rien à annuler.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_invoice_request' and column_name = 'siren'
  ) then
    raise exception 'SCANYM_NOTHING_TO_ROLL_BACK: order_invoice_request.siren est déjà absente.';
  end if;

  -- Données saisies par des clients : jamais détruites sans décision.
  select count(*) into v_siren_rows
  from public.order_invoice_request
  where siren is not null;

  if v_siren_rows > 0 then
    raise exception 'SCANYM_ROLLBACK_BLOCKED: % demande(s) de facture portent un SIREN saisi par le client ; supprimer la colonne les détruirait. Exporter ces valeurs et décider explicitement avant de rejouer ce rollback.', v_siren_rows;
  end if;

  -- La forme attendue doit être CELLE DE CE LOT (13 arguments) : sinon
  -- un travail ultérieur non revu est en place.
  if to_regprocedure('public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text,text)') is null then
    raise exception 'SCANYM_ROLLBACK_DRIFT_GUARD: set_order_invoice_request n''est pas dans la forme 13 arguments de CUSTOMER BILLING PROFILE v2 -- révision manuelle requise.';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_order_invoice_request'
      and p.prosrc like '%p_siren dépasse 14 caractères%'
      and p.prosrc like '%p_contact_email invalide%'
  ) then
    raise exception 'SCANYM_ROLLBACK_DRIFT_GUARD: le corps de set_order_invoice_request ne correspond pas à l''état connu de ce lot -- une modification ultérieure non revue peut exister, révision manuelle requise.';
  end if;
  -- v2.1 (RECOMPOSITION) -- garde de CONTENU, non d'effectif : l'état
  -- d'entrée doit être exactement « catalogue du main courant +
  -- l'emplacement possédé par ce lot ». Un emplacement inconnu ajouté
  -- depuis par un autre lot, ou un emplacement de Theme disparu, fait
  -- échouer cette garde AVANT toute destruction -- alors qu'un simple
  -- compte juste laisserait la restauration l'effacer en silence.
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
    raise exception 'SCANYM_ROLLBACK_DRIFT_GUARD: communication_text_keys() ne porte pas l''état attendu (catalogue du main courant + billing_profile_explanation) -- restaurer effacerait un emplacement inconnu, révision manuelle requise. État lu : %', public.communication_text_keys();
  end if;
  -- Les bornes propres à Theme doivent être intactes : ce fichier les
  -- laisse en place, et refuse de s'exécuter sur un schéma où elles
  -- auraient changé (il remettrait alors un catalogue incohérent).
  if public.communication_text_max_length('order_help_button_label') <> 60
     or public.communication_text_max_length('order_help_title') <> 120
     or public.communication_text_max_length('email_confirmation_subject') <> 160 then
    raise exception 'SCANYM_ROLLBACK_DRIFT_GUARD: communication_text_max_length() ne porte pas les bornes de THEME & CONTENT SETTINGS v1 -- révision manuelle requise.';
  end if;

  -- Un emplacement billing_profile_explanation RENSEIGNÉ par un
  -- commerçant deviendrait invalide au regard du catalogue restauré :
  -- la contrainte de table le refuserait. On le signale plutôt que de
  -- laisser la restauration échouer à mi-chemin.
  if exists (
    select 1 from public.merchant_communication_text
    where text_key = 'billing_profile_explanation'
  ) then
    raise exception 'SCANYM_ROLLBACK_BLOCKED: au moins un commerçant a configuré le texte billing_profile_explanation ; retirer cet emplacement du catalogue invaliderait cette ligne. La supprimer explicitement avant de rejouer ce rollback.';
  end if;

  -- OBJETS HORS PÉRIMÈTRE : on NOTE leur présence maintenant, pour
  -- pouvoir vérifier plus bas qu'elle n'a pas changé. Noter plutôt
  -- qu'EXIGER : ce rollback ne doit pas devenir dépendant de
  -- l'installation d'un autre lot (CATALOGUE PRODUCT REORDER v1.1
  -- peut légitimement ne pas être là), il doit seulement prouver
  -- qu'il n'a rien emporté de ce qui était là.
  create temp table _scanym_cbp_v2_pre_state on commit drop as
  select
    to_regprocedure('public.move_product_order(uuid,text,jsonb)') is not null as had_move_product_order,
    to_regprocedure('public.update_restaurant_theme_tokens(uuid,jsonb)') is not null as had_theme_tokens_rpc,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'restaurant_configs' and column_name = 'theme_tokens'
    ) as had_theme_tokens_column,
    (select count(*) from public.merchant_communication_text where text_key like 'order_help%') as theme_text_rows;

end $$;

-- À partir d'ici, et seulement si AUCUNE garde n'a levé : la
-- restauration. Si une garde a levé, la transaction est déjà
-- abandonnée et chacune des instructions ci-dessous échoue sans rien
-- modifier -- y compris le `drop column` de la section 4.

-- ------------------------------------------------------------
-- 1. ÉCRITURE — retour à la forme 12 arguments (fondation + delta
--    e-mail). Corps repris À L'IDENTIQUE de
--    DRAFT-lot-checkout-invoice-request-email-validation-v1-delta.sql.
-- ------------------------------------------------------------
drop function public.set_order_invoice_request(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text);

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
  p_contact_email      text default null
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

  v_contact_name := nullif(btrim(coalesce(p_contact_name, '')), '');
  if v_contact_name is not null and length(v_contact_name) > 45 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_contact_name dépasse 45 caractères' using errcode = '22001';
  end if;

  v_contact_email := nullif(btrim(coalesce(p_contact_email, '')), '');
  if v_contact_email is not null and length(v_contact_email) > 100 then
    raise exception 'SCANYM_INVOICE_REQUEST: p_contact_email dépasse 100 caractères' using errcode = '22001';
  end if;
  if v_contact_email is not null and v_contact_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$' then
    raise exception 'SCANYM_INVOICE_REQUEST: p_contact_email invalide' using errcode = '22023';
  end if;

  insert into public.order_invoice_request (
    order_id, invoice_type, company_legal_name, vat_number,
    contact_name, contact_email,
    address_line_1, address_line_2, city, postal_code, country,
    updated_at
  ) values (
    p_order_id, v_invoice_type, v_company_legal_name, v_vat_number,
    v_contact_name, v_contact_email,
    v_address_line_1, v_address_line_2, v_city, v_postal_code, v_country,
    now()
  )
  on conflict (order_id) do update set
    invoice_type        = excluded.invoice_type,
    company_legal_name  = excluded.company_legal_name,
    vat_number           = excluded.vat_number,
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

comment on function public.set_order_invoice_request(uuid, uuid, text, text, text, text, text, text, text, text, text, text) is
  'SECURITY DEFINER -- CUSTOMER CHECKOUT INVOICE REQUEST v1.1 (foundation + email validation delta applied). Écrit/met à jour (upsert déterministe) la demande de facture d''une commande, avec preuve de possession anonyme (id + public_token). Échec fermé sur toute entrée invalide/incomplète, y compris désormais le FORMAT de contact_email lorsqu''il est fourni. AUCUN déclenchement de paiement, de Stuart, ou de communication client.';

revoke all on function public.set_order_invoice_request(uuid, uuid, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.set_order_invoice_request(uuid, uuid, text, text, text, text, text, text, text, text, text, text) to service_role;

-- ------------------------------------------------------------
-- 2. LECTURE — retour à la forme sans `siren`.
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
    select r.invoice_type, r.company_legal_name, r.vat_number,
           r.contact_name, r.contact_email,
           r.address_line_1, r.address_line_2, r.city, r.postal_code, r.country,
           r.updated_at
    from public.order_invoice_request r
    where r.order_id = p_order_id;
end;
$$;

comment on function public.get_order_invoice_request(uuid, uuid) is
  'SECURITY DEFINER, lecture -- même preuve de possession anonyme que set_order_invoice_request. Absence de ligne = "pas de facture demandée", jamais une erreur.';

revoke all on function public.get_order_invoice_request(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_order_invoice_request(uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- 3. CATALOGUES DE TEXTES — retrait du SEUL emplacement possédé par
--    ce lot (`billing_profile_explanation`).
--
-- v2.1 (RECOMPOSITION) — l'état à restaurer est celui du main
-- COURANT, c'est-à-dire MCC v1 + THEME & CONTENT SETTINGS v1 (les
-- trois emplacements order_help_*), et NON l'état pré-Theme. Annuler
-- un lot de facturation ne doit pas désinstaller Theme au passage :
-- un rollback ne retire que ce que son lot a ajouté.
-- `communication_text_max_length()` n'est pas touchée (elle
-- appartient à Theme et ne mentionne pas l'emplacement de ce lot).
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

-- ------------------------------------------------------------
-- 4. COLONNE SIREN — supprimée en dernier (les deux RPC ne la
--    référencent plus à ce stade).
-- ------------------------------------------------------------
alter table public.order_invoice_request drop column siren;

-- ------------------------------------------------------------
-- 5. VÉRIFICATIONS DE ROLLBACK.
-- ------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_invoice_request' and column_name = 'siren'
  ) then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: order_invoice_request.siren subsiste.';
  end if;
  if to_regprocedure('public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text)') is null then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: la forme 12 arguments de set_order_invoice_request n''a pas été restaurée.';
  end if;
  if (select count(*) from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'set_order_invoice_request') <> 1 then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: plusieurs surcharges de set_order_invoice_request subsistent.';
  end if;
  -- v2.1 (RECOMPOSITION) -- l'état d'arrivée est le catalogue du main
  -- courant, Theme COMPRIS, et PRIVÉ du seul emplacement de ce lot.
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
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: le catalogue restauré n''est pas celui du main courant (MCC v1 + THEME & CONTENT SETTINGS v1). État : %', public.communication_text_keys();
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
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: la projection publique restaurée n''est pas celle du main courant. État : %', public.public_communication_text_keys();
  end if;
  -- PROPRIÉTÉ, dans les deux sens : l'emplacement de ce lot est parti,
  -- et AUCUN emplacement de Theme ne l'a suivi.
  if 'billing_profile_explanation' = any(public.communication_text_keys()) then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: billing_profile_explanation subsiste dans le catalogue.';
  end if;
  if not ('order_help_button_label' = any(public.communication_text_keys()))
     or not ('order_help_title' = any(public.communication_text_keys()))
     or not ('order_help_body' = any(public.communication_text_keys()))
     or not ('order_help_body' = any(public.public_communication_text_keys())) then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: un emplacement de THEME & CONTENT SETTINGS v1 a été emporté par le rollback de facturation.';
  end if;
  if public.communication_text_max_length('order_help_button_label') <> 60
     or public.communication_text_max_length('order_help_title') <> 120 then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: les bornes de THEME & CONTENT SETTINGS v1 ont été altérées.';
  end if;
  -- HORS PÉRIMÈTRE : rien de ce qui était là n'a disparu. La
  -- comparaison porte sur l'état NOTÉ en début de transaction, jamais
  -- sur une exigence d'installation (CATALOGUE PRODUCT REORDER v1.1 et
  -- THEME & CONTENT SETTINGS v1 restent facultatifs pour CE fichier).
  if (select had_move_product_order from _scanym_cbp_v2_pre_state)
     and to_regprocedure('public.move_product_order(uuid,text,jsonb)') is null then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: move_product_order (CATALOGUE PRODUCT REORDER v1.1) a disparu -- hors périmètre de ce lot.';
  end if;
  if (select had_theme_tokens_rpc from _scanym_cbp_v2_pre_state)
     and to_regprocedure('public.update_restaurant_theme_tokens(uuid,jsonb)') is null then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: update_restaurant_theme_tokens (THEME & CONTENT SETTINGS v1) a disparu -- hors périmètre de ce lot.';
  end if;
  if (select had_theme_tokens_column from _scanym_cbp_v2_pre_state)
     and not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'restaurant_configs' and column_name = 'theme_tokens'
     ) then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: restaurant_configs.theme_tokens a disparu -- hors périmètre de ce lot.';
  end if;
  if (select theme_text_rows from _scanym_cbp_v2_pre_state) <>
     (select count(*) from public.merchant_communication_text where text_key like 'order_help%') then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: des textes order_help_* de THEME & CONTENT SETTINGS v1 ont été emportés.';
  end if;
  if not has_function_privilege('service_role', 'public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text)', 'execute')
     or not has_function_privilege('service_role', 'public.get_order_invoice_request(uuid,uuid)', 'execute') then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: service_role n''a pas retrouvé EXECUTE sur les RPC de facturation.';
  end if;
  if has_function_privilege('anon', 'public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.set_order_invoice_request(uuid,uuid,text,text,text,text,text,text,text,text,text,text)', 'execute') then
    raise exception 'SCANYM_ROLLBACK_CHECK_FAILED: posture de privilèges élargie par le rollback.';
  end if;
end $$;

commit;
