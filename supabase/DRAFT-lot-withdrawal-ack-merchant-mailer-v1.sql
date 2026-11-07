-- =============================================================================
-- Scanym — ACCUSÉ DE RÉTRACTATION PAR LA MESSAGERIE DU COMMERÇANT (v1)
-- DRAFT ONLY — DO NOT APPLY TO PRODUCTION WITHOUT CIO GO + AUDIT.
-- =============================================================================
--
-- POURQUOI. Aujourd'hui l'accusé de réception d'une demande de rétractation
-- (art. L221-21 / D.221-5) dépend d'UN canal SMTP unique de la plateforme
-- (SMTP_*, retractation@scanym.com ; GAP-01). Quand il est indisponible,
-- `_scanym_has_operational_durable_ack_channel()` vaut false et CHAQUE demande
-- est enregistrée `unavailable_no_channel` : rien ne sera jamais envoyé. Ce lot
-- permet d'utiliser, pour chaque établissement, la messagerie que son
-- propriétaire a déjà configurée dans l'onglet E-mails (coffre
-- `merchant_email_provider_config` + identité `merchant_notification_profile`).
--
-- CE QUE LE LOT FAIT (et seulement cela) :
--   A. Pré-vols : prédécesseurs attendus présents ; double application refusée.
--   B. Interrupteur OPÉRATEUR `scanym_ack_merchant_mailer_activation`
--      (singleton, FERMÉ par défaut). Tant qu'il est fermé, le comportement
--      est STRICTEMENT celui d'avant ce lot. Ce lot ne l'ouvre jamais.
--   C. Deux colonnes de preuve sur `withdrawal_requests` : l'expéditeur
--      réellement utilisé et le canal (`platform_smtp` / `merchant_smtp`).
--   D. `_scanym_merchant_ack_channel_ready(restaurant_id)` : la messagerie DE
--      CET établissement est-elle prête (coffre activé avec secret + profil
--      d'envoi activé avec nom et adresse d'expéditeur) ?
--   E. Déclencheur BEFORE INSERT : une demande créée `unavailable_no_channel`
--      devient `pending` UNIQUEMENT si l'interrupteur est ouvert ET si la
--      messagerie de son établissement est prête. `submit_withdrawal_request_
--      by_capability` n'est PAS réécrite (aucun risque de dérive de sa
--      définition) ; le déclencheur ne touche que ce statut à l'insertion.
--   F. `claim_withdrawal_acknowledgement_send_v2` / `record_withdrawal_
--      acknowledgement_result_v2` (service_role UNIQUEMENT) : revendication
--      atomique de `pending` SEULEMENT (un `sending` n'est jamais repris : SMTP
--      n'est pas idempotent), identité d'expéditeur de l'établissement, et
--      enregistrement conditionnel à `sending` + canal marchand.
--
-- CE QUE LE LOT NE FAIT PAS :
--   * il n'ouvre pas l'interrupteur, n'envoie aucun e-mail, ne réécrit aucune
--     demande existante (aucun backfill, aucun renvoi automatique) ;
--   * il ne modifie PAS `_scanym_has_operational_durable_ack_channel()` : la
--     garde de publication des CGV garde exactement son comportement (vérifié
--     en fin de lot) ;
--   * il ne modifie aucune CGV : voir docs/withdrawal-ack-merchant-mailer-v1.md
--     (la clause v7 annonce l'expéditeur retractation@scanym.com).
--
-- ORDRE D'EXÉCUTION. (1) ce lot ; (2) déploiement du code ; (3) PLUS TARD,
-- séparément et sur GO explicite : ouverture de l'interrupteur (voir la fin de
-- ce fichier, commentée). Le code détecte l'absence de ce lot (RPC inconnue)
-- et reste alors sur le canal historique.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- A. PRÉ-VOLS
-- -----------------------------------------------------------------------------
do $$
declare
  v_missing text[] := '{}';
  v_name text;
begin
  foreach v_name in array array[
    'withdrawal_requests', 'scanym_ack_transport_health',
    'merchant_email_provider_config', 'merchant_notification_profile',
    'merchant_legal_profile', 'merchant_cgv_profile', 'restaurants'
  ] loop
    if to_regclass('public.' || v_name) is null then
      v_missing := v_missing || ('table ' || v_name);
    end if;
  end loop;

  if to_regprocedure('public.claim_withdrawal_acknowledgement_send(uuid,integer)') is null then
    v_missing := v_missing || 'fonction claim_withdrawal_acknowledgement_send(uuid,integer)';
  end if;
  if to_regprocedure('public.record_withdrawal_acknowledgement_result(uuid,boolean,text,text,text,text,text)') is null then
    v_missing := v_missing || 'fonction record_withdrawal_acknowledgement_result(...)';
  end if;
  if to_regprocedure('public._scanym_has_operational_durable_ack_channel()') is null then
    v_missing := v_missing || 'fonction _scanym_has_operational_durable_ack_channel()';
  end if;

  if array_length(v_missing, 1) is not null then
    raise exception 'SCANYM_PREDECESSOR_MISSING: prérequis absents (%): appliquer d''abord GAP-01 (ack transport + e-mail marchand obligatoire) et SMTP marchand v1.', array_to_string(v_missing, ', ');
  end if;

  -- Colonnes attendues de withdrawal_requests (GAP-01) et du coffre / profil.
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'withdrawal_requests'
        and column_name in ('acknowledgement_status', 'acknowledgement_cc', 'acknowledgement_message_id',
                            'acknowledgement_content_version', 'acknowledgement_attempted_at',
                            'acknowledgement_claimed_at', 'acknowledgement_send_attempts',
                            'acknowledgement_last_error', 'acknowledgement_sent_at')) <> 9 then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes d''accusé de withdrawal_requests incomplètes (GAP-01 attendu).';
  end if;
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'merchant_email_provider_config'
        and column_name in ('restaurant_id', 'enabled', 'secret_ciphertext', 'secret_iv', 'secret_auth_tag')) <> 5
     or (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'merchant_notification_profile'
        and column_name in ('restaurant_id', 'email_enabled', 'sender_name', 'sender_email', 'reply_to')) <> 5 then
    raise exception 'SCANYM_SCHEMA_DRIFT: coffre SMTP marchand ou profil de notification non conforme.';
  end if;

  -- Le statut `sending` doit exister (GAP-01).
  if not exists (
    select 1 from pg_catalog.pg_constraint con
    join pg_catalog.pg_class cls on cls.oid = con.conrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = cls.relnamespace
    where nsp.nspname = 'public' and cls.relname = 'withdrawal_requests' and con.contype = 'c'
      and pg_catalog.pg_get_constraintdef(con.oid) like '%''sending''%'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: le vocabulaire de statut d''accusé ne contient pas ''sending'' (GAP-01 attendu).';
  end if;

  -- Double application refusée.
  if to_regclass('public.scanym_ack_merchant_mailer_activation') is not null
     or to_regprocedure('public.claim_withdrawal_acknowledgement_send_v2(uuid)') is not null
     or exists (select 1 from pg_catalog.pg_trigger where tgname = 'trg_withdrawal_ack_pending_merchant_mailer') then
    raise exception 'SCANYM_SCHEMA_DRIFT: ce lot est déjà appliqué (objet existant) -- double application refusée.';
  end if;
end $$;

-- Valeur de la garde de publication des CGV AVANT ce lot (comparée en fin de lot).
create temporary table _scanym_ack_mm_guard_before on commit drop as
  select public._scanym_has_operational_durable_ack_channel() as v;

-- -----------------------------------------------------------------------------
-- B. INTERRUPTEUR OPÉRATEUR — singleton, FERMÉ par défaut
-- -----------------------------------------------------------------------------
create table public.scanym_ack_merchant_mailer_activation (
  id         integer primary key default 1 check (id = 1),
  enabled    boolean not null default false,
  updated_at timestamptz not null default now(),
  note       text
);

comment on table public.scanym_ack_merchant_mailer_activation is
  'Interrupteur OPÉRATEUR (ligne singleton id=1) : quand enabled=true, l''accusé de réception d''une rétractation est envoyé par la messagerie configurée par le commerçant de la demande ; sinon (défaut) canal SMTP historique de la plateforme, inchangé. Ouverture = décision de mise en production séparée (CGV annonçant l''expéditeur à revoir d''abord). Aucune policy : écriture par SQL opérateur uniquement.';

alter table public.scanym_ack_merchant_mailer_activation enable row level security;
revoke all privileges on table public.scanym_ack_merchant_mailer_activation from public;
revoke all privileges on table public.scanym_ack_merchant_mailer_activation from anon;
revoke all privileges on table public.scanym_ack_merchant_mailer_activation from authenticated;
revoke all privileges on table public.scanym_ack_merchant_mailer_activation from service_role;

insert into public.scanym_ack_merchant_mailer_activation (id, enabled) values (1, false);

create function public.scanym_ack_merchant_mailer_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select a.enabled from public.scanym_ack_merchant_mailer_activation a where a.id = 1),
    false
  );
$$;

comment on function public.scanym_ack_merchant_mailer_enabled() is
  'L''accusé de rétractation passe-t-il par la messagerie du commerçant ? Lit l''interrupteur opérateur (fermé par défaut). service_role uniquement.';

revoke all on function public.scanym_ack_merchant_mailer_enabled() from public, anon, authenticated;
grant execute on function public.scanym_ack_merchant_mailer_enabled() to service_role;

-- -----------------------------------------------------------------------------
-- C. PREUVE D'ENVOI — expéditeur et canal réellement utilisés
-- -----------------------------------------------------------------------------
alter table public.withdrawal_requests
  add column acknowledgement_sender    text,
  add column acknowledgement_transport text;

alter table public.withdrawal_requests
  add constraint withdrawal_requests_ack_transport_check
  check (acknowledgement_transport is null or acknowledgement_transport in ('platform_smtp', 'merchant_smtp'));

comment on column public.withdrawal_requests.acknowledgement_sender is
  'Adresse d''expéditeur (From) réellement utilisée pour l''accusé : preuve d''audit, écrite par record_withdrawal_acknowledgement_result_v2. NULL si aucun envoi tenté.';
comment on column public.withdrawal_requests.acknowledgement_transport is
  'Canal utilisé : merchant_smtp (messagerie configurée par le commerçant), posé à la revendication par claim_withdrawal_acknowledgement_send_v2. NULL = canal historique (SMTP de la plateforme), qui n''écrit pas cette colonne. platform_smtp est admis par la contrainte mais n''est écrit par aucun code de ce lot.';

-- -----------------------------------------------------------------------------
-- D. MESSAGERIE PRÊTE POUR CET ÉTABLISSEMENT ?
-- -----------------------------------------------------------------------------
-- Vérifie ce que la base PEUT vérifier : coffre activé avec secret complet, profil
-- d'envoi activé avec nom et adresse d'expéditeur. Elle ne peut pas vérifier que le
-- secret se déchiffre ni que le serveur SMTP répond : le code l'enregistre alors
-- `failed` avec une classe d'erreur, jamais `sent`.
create function public._scanym_merchant_ack_channel_ready(p_restaurant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.merchant_email_provider_config c
    join public.merchant_notification_profile p on p.restaurant_id = c.restaurant_id
    where c.restaurant_id = p_restaurant_id
      and c.enabled
      and c.secret_ciphertext is not null and c.secret_iv is not null and c.secret_auth_tag is not null
      and p.email_enabled
      and p.sender_name is not null and pg_catalog.btrim(p.sender_name) <> ''
      and p.sender_email is not null and pg_catalog.btrim(p.sender_email) <> ''
  );
$$;

comment on function public._scanym_merchant_ack_channel_ready(uuid) is
  'La messagerie configurée par CET établissement est-elle prête (coffre activé + secret complet + profil d''envoi activé avec expéditeur) ? Utilisée par le déclencheur d''insertion de withdrawal_requests. Interne : aucun rôle client.';

revoke all on function public._scanym_merchant_ack_channel_ready(uuid) from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- E. DÉCLENCHEUR — statut honnête à la création
-- -----------------------------------------------------------------------------
-- submit_withdrawal_request_by_capability pose `pending` si le canal de la
-- plateforme est opérationnel, sinon `unavailable_no_channel`. Ce déclencheur ne
-- change QUE ce second cas, et seulement si un envoi sera réellement tenté par la
-- messagerie du commerçant (interrupteur ouvert ET messagerie prête). Dans tous les
-- autres cas le statut reste `unavailable_no_channel`, ce qui est vrai.
create function public._scanym_ack_pending_when_merchant_mailer_ready()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.acknowledgement_status = 'unavailable_no_channel'
     and public.scanym_ack_merchant_mailer_enabled()
     and public._scanym_merchant_ack_channel_ready(new.restaurant_id) then
    new.acknowledgement_status := 'pending';
  end if;
  return new;
end;
$$;

revoke all on function public._scanym_ack_pending_when_merchant_mailer_ready() from public, anon, authenticated, service_role;

create trigger trg_withdrawal_ack_pending_merchant_mailer
  before insert on public.withdrawal_requests
  for each row
  execute function public._scanym_ack_pending_when_merchant_mailer_ready();

-- -----------------------------------------------------------------------------
-- F. REVENDICATION ET ENREGISTREMENT (service_role uniquement)
-- -----------------------------------------------------------------------------
-- Atomicité de v1 pour `pending`, mais SANS reprise d'un `sending` périmé : un `sending`
-- n'est JAMAIS revendiqué à nouveau. Raison : SMTP n'est pas idempotent (une clé stable ne
-- déduplique rien) ; si le message a été accepté mais que le résultat n'a pas pu être écrit
-- (ou si le processus a disparu pendant l'envoi), une seconde revendication enverrait un
-- DOUBLON. L'issue ambiguë reste visible (`sending`) et est traitée par un humain
-- (docs/withdrawal-ack-merchant-mailer-v1.md). Contrepartie assumée : une demande dont le
-- processus meurt AVANT l'envoi reste aussi `sending` (jamais envoyée automatiquement).
-- En plus de v1 : (i) ne revendique RIEN tant que l'interrupteur est fermé ; (ii) pose le
-- canal ; (iii) renvoie l'identité d'expéditeur DE L'ÉTABLISSEMENT DE LA DEMANDE (jointure
-- sur le restaurant_id de la ligne revendiquée -- jamais un paramètre de l'appelant).
-- Une demande `failed`, `sent`, `sending` ou `unavailable_no_channel` n'est JAMAIS revendiquée.
create function public.claim_withdrawal_acknowledgement_send_v2(
  p_withdrawal_request_id uuid
)
returns table (
  id                        uuid,
  restaurant_id             uuid,
  order_id                  uuid,
  acknowledgement_address   text,
  customer_first_name       text,
  customer_last_name        text,
  declaration_snapshot      jsonb,
  merchant_name             text,
  merchant_contact_email    text,
  merchant_contact_phone    text,
  merchant_withdrawal_regime text,
  profile_email_enabled     boolean,
  sender_name               text,
  sender_email              text,
  reply_to                  text
)
language sql
security definer
set search_path = ''
as $$
  with claimed as (
    update public.withdrawal_requests wr
    set acknowledgement_status = 'sending',
        acknowledgement_transport = 'merchant_smtp',
        acknowledgement_claimed_at = now(),
        acknowledgement_send_attempts = wr.acknowledgement_send_attempts + 1
    where wr.id = p_withdrawal_request_id
      and public.scanym_ack_merchant_mailer_enabled()
      and wr.acknowledgement_status = 'pending'
    returning wr.*
  )
  select
    c.id, c.restaurant_id, c.order_id, c.acknowledgement_address,
    c.customer_first_name, c.customer_last_name, c.declaration_snapshot,
    r.name, mlp.customer_service_email, mlp.customer_service_phone,
    mcp.withdrawal_regime,
    coalesce(np.email_enabled, false), np.sender_name, np.sender_email, np.reply_to
  from claimed c
  left join public.restaurants r on r.id = c.restaurant_id
  left join public.merchant_legal_profile mlp on mlp.restaurant_id = c.restaurant_id
  left join public.merchant_cgv_profile mcp on mcp.restaurant_id = c.restaurant_id
  left join public.merchant_notification_profile np on np.restaurant_id = c.restaurant_id;
$$;

comment on function public.claim_withdrawal_acknowledgement_send_v2(uuid) is
  'Revendication atomique de l''envoi d''un accusé par la messagerie du commerçant : ne renvoie une ligne QUE si l''interrupteur opérateur est ouvert ET la demande est pending. Un sending n''est JAMAIS repris (SMTP non idempotent : risque de doublon). Renvoie l''identité d''expéditeur et le contact de l''établissement de la demande. service_role uniquement.';

revoke all on function public.claim_withdrawal_acknowledgement_send_v2(uuid) from public, anon, authenticated;
grant execute on function public.claim_withdrawal_acknowledgement_send_v2(uuid) to service_role;

-- Enregistrement du résultat RÉEL. Conditionnel à `sending` (une revendication perdue
-- ou un résultat tardif ne peut pas écraser un état final) ; renvoie false dans ce cas.
-- La copie n'est enregistrée que si l'envoi a réussi (le back-office ne doit jamais
-- afficher « copie envoyée » pour un échec) ; l'erreur est bornée à une classe
-- normalisée (MAJUSCULES/chiffres/_), tout autre texte devient UNKNOWN_PROVIDER_ERROR.
create function public.record_withdrawal_acknowledgement_result_v2(
  p_withdrawal_request_id uuid,
  p_ok                    boolean,
  p_to                    text,
  p_cc                    text,
  p_message_id            text,
  p_content_version       text,
  p_error                 text,
  p_sender                text,
  p_transport             text
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with updated as (
    update public.withdrawal_requests wr
    set acknowledgement_status = case when p_ok then 'sent' else 'failed' end,
        acknowledgement_sent_at = case when p_ok then now() else wr.acknowledgement_sent_at end,
        acknowledgement_cc = case when p_ok then pg_catalog.left(p_cc, 320) else wr.acknowledgement_cc end,
        acknowledgement_message_id = case when p_ok then pg_catalog.left(p_message_id, 500) else wr.acknowledgement_message_id end,
        acknowledgement_content_version = coalesce(pg_catalog.left(p_content_version, 100), wr.acknowledgement_content_version),
        acknowledgement_attempted_at = now(),
        acknowledgement_last_error = case
          when p_ok then null
          when p_error ~ '^[A-Z][A-Z0-9_]{0,79}$' then p_error
          else 'UNKNOWN_PROVIDER_ERROR'
        end,
        acknowledgement_sender = pg_catalog.left(p_sender, 320),
        acknowledgement_transport = p_transport
    where wr.id = p_withdrawal_request_id
      and wr.acknowledgement_status = 'sending'
      -- Seule une ligne revendiquée PAR CE CANAL (claim v2) peut être finalisée par v2 : jamais
      -- un `sending` posé par le canal historique.
      and wr.acknowledgement_transport = 'merchant_smtp'
      and p_transport = 'merchant_smtp'
    returning 1
  )
  select exists (select 1 from updated);
$$;

comment on function public.record_withdrawal_acknowledgement_result_v2(uuid, boolean, text, text, text, text, text, text, text) is
  'Persiste le résultat RÉEL d''une tentative d''accusé (sent / failed) avec l''expéditeur et le canal utilisés. Conditionnel à acknowledgement_status = sending ET acknowledgement_transport = merchant_smtp ; false sinon. Copie enregistrée seulement en cas de succès ; erreur réduite à une classe normalisée. service_role uniquement.';

revoke all on function public.record_withdrawal_acknowledgement_result_v2(uuid, boolean, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_withdrawal_acknowledgement_result_v2(uuid, boolean, text, text, text, text, text, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- G. VÉRIFICATIONS POST-COMMIT (même transaction)
-- -----------------------------------------------------------------------------
do $$
begin
  if (select enabled from public.scanym_ack_merchant_mailer_activation where id = 1) is distinct from false then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: l''interrupteur doit rester FERMÉ après ce lot.';
  end if;
  if public.scanym_ack_merchant_mailer_enabled() then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: scanym_ack_merchant_mailer_enabled() doit valoir false.';
  end if;
  if (select v from _scanym_ack_mm_guard_before) is distinct from public._scanym_has_operational_durable_ack_channel() then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: la garde de publication des CGV a changé de valeur -- ce lot ne doit pas la modifier.';
  end if;
  if has_function_privilege('anon', 'public.claim_withdrawal_acknowledgement_send_v2(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.claim_withdrawal_acknowledgement_send_v2(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.record_withdrawal_acknowledgement_result_v2(uuid,boolean,text,text,text,text,text,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.record_withdrawal_acknowledgement_result_v2(uuid,boolean,text,text,text,text,text,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.scanym_ack_merchant_mailer_enabled()', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: fonction du canal marchand exposée à un rôle client.';
  end if;
  if not has_function_privilege('service_role', 'public.claim_withdrawal_acknowledgement_send_v2(uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.record_withdrawal_acknowledgement_result_v2(uuid,boolean,text,text,text,text,text,text,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.scanym_ack_merchant_mailer_enabled()', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: service_role ne peut pas exécuter une fonction du canal marchand.';
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger where tgname = 'trg_withdrawal_ack_pending_merchant_mailer' and tgenabled = 'O') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: déclencheur absent ou désactivé.';
  end if;
end $$;

commit;

-- =============================================================================
-- OUVERTURE DE L'INTERRUPTEUR — NE PAS EXÉCUTER AVEC CE LOT.
-- Décision séparée (GO explicite du CIO), après : (1) déploiement du code ;
-- (2) revue juridique du texte des CGV (la clause v7 annonce l'expéditeur
-- retractation@scanym.com) ; (3) contrôle par établissement avec
-- supabase/DRAFT-diagnostic-withdrawal-ack-backlog-v1-READONLY.sql ;
-- (4) test de connexion SMTP réussi dans l'onglet E-mails de l'établissement.
--
--   update public.scanym_ack_merchant_mailer_activation
--      set enabled = true, updated_at = now(), note = '<décision, date, auteur>'
--    where id = 1;
--
-- Fermeture immédiate (sans rollback du lot) :
--   update public.scanym_ack_merchant_mailer_activation set enabled = false, updated_at = now() where id = 1;
-- =============================================================================
