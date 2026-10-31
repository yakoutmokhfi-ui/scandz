-- MERCHANT SMTP PROVIDER CONFIG v1 (révision R1 -- corrections de l'audit PR #196)
--
-- Coffre SMTP chiffré par établissement + claim des notifications limité aux
-- commerces configurés.
--
-- Prédécesseur ATTENDU, vérifié EXACTEMENT (corps md5, attributs, arguments,
-- colonnes retournées, propriétaire, ACL) : claim_pending_notifications tel que
-- posé par le lot ORDER_RECEIVED PAYMENT GATE v1 (#180). Toute variante =>
-- SCANYM_PREDECESSOR_DRIFT, transaction annulée, rien modifié (même norme que
-- #180 ; A196-03).
--
-- Seules différences du nouveau claim par rapport à celui de #180 : deux
-- jointures (coffre activé avec secret ; opt-in marchand) et le verrou ciblé
-- « for update of o ». Signature, colonnes, bail, droits et attributs inchangés.
--
-- Retour arrière : DRAFT-lot-merchant-smtp-notifications-v1-rollback.sql
-- restaure le claim de #180 OCTET POUR OCTET (même empreinte, même
-- commentaire) : le rollback de #180 reste ensuite possible (A196-02).
-- Ordre de retour arrière : d'abord CE lot, ensuite #180.
begin;

-- -----------------------------------------------------------------------------
-- 0. PRÉ-VOL — existence et double application.
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.merchant_notification_profile') is null
     or to_regclass('public.notification_outbox') is null
     or to_regclass('public.restaurants') is null
     or to_regprocedure('public.touch_updated_at()') is null
     or to_regprocedure('public.notification_send_gate_open(uuid,text)') is null
     or to_regprocedure('public.claim_pending_notifications(integer,integer)') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: email notification foundation/payment gate is missing';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'merchant_notification_profile' and column_name = 'email_enabled'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: merchant_notification_profile.email_enabled is missing';
  end if;
  if to_regclass('public.merchant_email_provider_config') is not null then
    raise exception 'SCANYM_SCHEMA_DRIFT: merchant_email_provider_config already exists';
  end if;
  if (
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'claim_pending_notifications'
  ) <> 1 then
    raise exception 'SCANYM_SCHEMA_DRIFT: claim_pending_notifications doit exister en UNE seule surcharge. Annulé.';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 0b. PRÉ-VOL DU PRÉDÉCESSEUR (A196-03) — refus de toute définition inattendue.
--     Bloc repris du lot #180 (§0b) ; constante = empreinte du claim POSÉ PAR #180.
--     CREATE OR REPLACE écraserait sans discussion une variante (STRICT, droits
--     supplémentaires...) : on refuse, on ne normalise jamais.
-- -----------------------------------------------------------------------------
do $$
declare
  c_expected_body_md5 constant text := '16d75b38372fd5dfd0ca1a4e20dfa3a8';
  c_expected_args     constant text := 'p_batch_size integer DEFAULT 10, p_lease_seconds integer DEFAULT 60';
  c_expected_result   constant text := 'TABLE(outbox_id uuid, restaurant_id uuid, order_id uuid, notification_type text, recipient_email text, locale text, payload_snapshot jsonb, attempt_count integer, claim_token uuid, sender_name text, sender_email text, reply_to text)';
  -- Attributs de pg_proc que CREATE OR REPLACE réécrit (explicitement ou par valeur
  -- par défaut) : un écart est une variante opérationnelle inconnue, jamais normalisée.
  c_expected_attrs constant text := 'kind=f;lang=plpgsql;secdef=t;strict=f;leakproof=f;volatile=v;parallel=u;retset=t;cost=100;rows=1000;support=0;variadic=0;nargs=2;ndefaults=2;config=search_path=""';
  v_oid      oid;
  v_owner    oid;
  v_args     text;
  v_result   text;
  v_md5      text;
  v_attrs    text;
  v_acl      text[];
  v_expected_acl text[];
begin
  select p.oid,
         p.proowner,
         pg_get_function_arguments(p.oid),
         pg_get_function_result(p.oid),
         md5(replace(p.prosrc, E'\r', '')),
         format('kind=%s;lang=%s;secdef=%s;strict=%s;leakproof=%s;volatile=%s;parallel=%s;retset=%s;cost=%s;rows=%s;support=%s;variadic=%s;nargs=%s;ndefaults=%s;config=%s',
                p.prokind, l.lanname, p.prosecdef, p.proisstrict, p.proleakproof, p.provolatile,
                p.proparallel, p.proretset, p.procost, p.prorows, p.prosupport::oid, p.provariadic,
                p.pronargs, p.pronargdefaults, coalesce(array_to_string(p.proconfig, ','), '')),
         (select coalesce(array_agg(e.entry order by e.entry), '{}'::text[])
            from (select format('%s=%s/%s%s',
                                case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end,
                                a.privilege_type, a.grantor::regrole::text,
                                case when a.is_grantable then ' WITH GRANT OPTION' else '' end) as entry
                    from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) e)
    into v_oid, v_owner, v_args, v_result, v_md5, v_attrs, v_acl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname = 'public' and p.proname = 'claim_pending_notifications';

  if v_oid is null then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: claim_pending_notifications est introuvable. Migration annulée, rien modifié.';
  end if;

  if v_md5 is distinct from c_expected_body_md5 then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: le corps de claim_pending_notifications (md5 %) n''est pas celui du lot ORDER_RECEIVED PAYMENT GATE v1 (#180) attendu (md5 %). Migration annulée, rien modifié.', v_md5, c_expected_body_md5;
  end if;

  if v_attrs is distinct from c_expected_attrs
     or v_args is distinct from c_expected_args
     or v_result is distinct from c_expected_result then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: attributs de claim_pending_notifications différents de #180 (SECURITY DEFINER, STRICT, volatilité, LEAKPROOF, PARALLEL, COST/ROWS, langage, search_path, arguments, colonnes retournées). Observé : % ; attendu : %.', v_attrs, c_expected_attrs;
  end if;

  -- Droits (politique explicite) : l'ENSEMBLE COMPLET des bénéficiaires EXECUTE doit
  -- être exactement {propriétaire, service_role}, accordé par le propriétaire, sans
  -- option de transmission, sans PUBLIC ni aucun autre rôle (anon, authenticated ou
  -- tout rôle supplémentaire). Le propriétaire doit être le rôle qui applique ce
  -- script. Aucun droit inconnu n'est révoqué ni accordé silencieusement : refus.
  v_expected_acl := (
    select array_agg(x order by x) from unnest(array[
      format('%s=EXECUTE/%s', v_owner::regrole::text, v_owner::regrole::text),
      format('%s=EXECUTE/%s', to_regrole('service_role')::text, v_owner::regrole::text)
    ]) as x
  );
  if v_owner is distinct from (select r.oid from pg_roles r where r.rolname = current_user)
     or v_acl is distinct from v_expected_acl then
    raise exception 'SCANYM_PREDECESSOR_DRIFT: droits d''exécution de claim_pending_notifications différents de #180 (propriétaire = rôle appliquant le script ET service_role, rien d''autre, sans option de transmission). Observé : propriétaire %, droits % ; attendu : %. Aucun droit n''est modifié ni révoqué silencieusement.', v_owner::regrole::text, v_acl, v_expected_acl;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 1. Coffre SMTP par établissement.
-- -----------------------------------------------------------------------------
create table public.merchant_email_provider_config (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  host text not null check (host = lower(host) and host ~ '^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  port integer not null check (port = 465),
  username text not null check (username ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  enabled boolean not null default false,
  secret_ciphertext text,
  secret_iv text,
  secret_auth_tag text,
  -- État opérationnel (A196-04 / A196-09) : dernière erreur observée (classe
  -- normalisée uniquement, jamais un message brut) et dernier test de connexion.
  last_test_at timestamptz,
  last_error_class text,
  last_error_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint merchant_email_provider_secret_complete check (
    (secret_ciphertext is null and secret_iv is null and secret_auth_tag is null)
    or (secret_ciphertext is not null and secret_iv is not null and secret_auth_tag is not null)
  ),
  constraint merchant_email_provider_enabled_requires_secret check (not enabled or secret_ciphertext is not null),
  constraint merchant_email_provider_last_error_consistent check ((last_error_class is null) = (last_error_at is null)),
  constraint merchant_email_provider_last_error_class_format check (
    last_error_class is null or last_error_class ~ '^[A-Z][A-Z_]{2,59}$'
  )
);

comment on table public.merchant_email_provider_config is
  'Encrypted per-restaurant SMTP settings. Ciphertext is AES-256-GCM encrypted by the application (additional authenticated data bound to the restaurant); no direct merchant table access. SMTP password is never returned to the browser. last_error_class holds a normalized class only.';

alter table public.merchant_email_provider_config enable row level security;
revoke all on public.merchant_email_provider_config from public, anon, authenticated, service_role;
grant select, insert, update on public.merchant_email_provider_config to service_role;

create trigger merchant_email_provider_config_touch_updated_at
before update on public.merchant_email_provider_config
for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 2. claim_pending_notifications — corps de #180 + deux jointures + verrou ciblé.
-- -----------------------------------------------------------------------------
create or replace function public.claim_pending_notifications(
  p_batch_size    integer default 10,
  p_lease_seconds integer default 60
)
returns table (
  outbox_id           uuid,
  restaurant_id       uuid,
  order_id            uuid,
  notification_type   text,
  recipient_email      text,
  locale              text,
  payload_snapshot    jsonb,
  attempt_count       integer,
  claim_token         uuid,
  sender_name         text,
  sender_email        text,
  reply_to            text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch_size integer := greatest(1, least(coalesce(p_batch_size, 10), 100));
  v_lease      integer := greatest(1, least(coalesce(p_lease_seconds, 60), 3600));
begin
  return query
  with eligible as (
    select o.id
    from public.notification_outbox o
    -- MERCHANT SMTP v1 : seuls les commerces avec un coffre SMTP activé ET
    -- l'opt-in e-mail marchand sont éligibles ; les autres lignes restent
    -- 'pending', sans tentative consommée (le filtre précède la limite).
    join public.merchant_email_provider_config ep
      on ep.restaurant_id = o.restaurant_id and ep.enabled and ep.secret_ciphertext is not null
    join public.merchant_notification_profile mp
      on mp.restaurant_id = o.restaurant_id and mp.email_enabled
    where o.status in ('pending', 'failed_retryable')
      and (o.next_attempt_at is null or o.next_attempt_at <= now())
      -- ORDER_RECEIVED PAYMENT GATE v1 : seul ajout par rapport à N1-A.
      and public.notification_send_gate_open(o.order_id, o.notification_type)
    order by o.created_at, o.id
    limit v_batch_size
    for update of o skip locked
  ),
  claimed as (
    update public.notification_outbox o
    set status = 'processing',
        claim_token = gen_random_uuid(),
        claimed_at = now(),
        claim_expires_at = now() + make_interval(secs => v_lease)
    from eligible
    where o.id = eligible.id
    returning o.id, o.restaurant_id, o.order_id, o.notification_type,
              o.recipient_email, o.locale, o.payload_snapshot, o.attempt_count, o.claim_token
  )
  select
    c.id, c.restaurant_id, c.order_id, c.notification_type,
    c.recipient_email, c.locale, c.payload_snapshot, c.attempt_count, c.claim_token,
    p.sender_name, p.sender_email, p.reply_to
  from claimed c
  left join public.merchant_notification_profile p on p.restaurant_id = c.restaurant_id
  order by c.id;
end $$;

comment on function public.claim_pending_notifications(integer, integer) is
  'N1-A + ORDER_RECEIVED PAYMENT GATE v1 + MERCHANT SMTP v1 — réclame un lot de notifications éligibles (FOR UPDATE OF o SKIP LOCKED + bail). Éligible seulement si la porte de paiement est ouverte ET si le commerce a un coffre SMTP activé avec secret ET l''opt-in e-mail marchand. Sans fournisseur, la ligne reste en attente : aucune réclamation, aucune tentative consommée.';

revoke all on function public.claim_pending_notifications(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_pending_notifications(integer, integer) to service_role;

-- -----------------------------------------------------------------------------
-- 3. POST-CONTRÔLE — état final exact.
-- -----------------------------------------------------------------------------
do $$
declare
  c_smtp_body_md5 constant text := 'cf3cfb8055dab9cc93e3ce5b8563a46a';
  v_owner oid;
  v_acl   text[];
begin
  if has_table_privilege('anon', 'public.merchant_email_provider_config', 'SELECT')
     or has_table_privilege('authenticated', 'public.merchant_email_provider_config', 'SELECT')
     or has_table_privilege('service_role', 'public.merchant_email_provider_config', 'DELETE') then
    raise exception 'SCANYM_POSTCHECK_FAILED: unexpected access to merchant SMTP credentials';
  end if;
  if not has_table_privilege('service_role', 'public.merchant_email_provider_config', 'SELECT')
     or not has_table_privilege('service_role', 'public.merchant_email_provider_config', 'INSERT')
     or not has_table_privilege('service_role', 'public.merchant_email_provider_config', 'UPDATE') then
    raise exception 'SCANYM_POSTCHECK_FAILED: service_role lacks SMTP configuration access';
  end if;
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.merchant_email_provider_config'::regclass) then
    raise exception 'SCANYM_POSTCHECK_FAILED: SMTP vault RLS is disabled';
  end if;
  if (select md5(replace(p.prosrc, E'\r', '')) from pg_proc p
       where p.oid = 'public.claim_pending_notifications(integer,integer)'::regprocedure) is distinct from c_smtp_body_md5 then
    raise exception 'SCANYM_POSTCHECK_FAILED: claim_pending_notifications is not the expected SMTP claim (body fingerprint)';
  end if;
  select p.proowner,
         (select coalesce(array_agg(e.entry order by e.entry), '{}'::text[])
            from (select format('%s=%s/%s%s',
                                case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end,
                                a.privilege_type, a.grantor::regrole::text,
                                case when a.is_grantable then ' WITH GRANT OPTION' else '' end) as entry
                    from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) e)
    into v_owner, v_acl
  from pg_proc p where p.oid = 'public.claim_pending_notifications(integer,integer)'::regprocedure;
  if v_acl is distinct from (select array_agg(x order by x) from unnest(array[
       format('%s=EXECUTE/%s', v_owner::regrole::text, v_owner::regrole::text),
       format('%s=EXECUTE/%s', to_regrole('service_role')::text, v_owner::regrole::text)]) as x) then
    raise exception 'SCANYM_POSTCHECK_FAILED: notification claim privileges changed unexpectedly (%)', v_acl;
  end if;
end $$;

commit;
