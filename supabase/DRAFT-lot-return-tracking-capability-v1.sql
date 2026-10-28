-- =============================================================================
-- Scanym — RETURN TRACKING CAPABILITY v1 (issue #172, complément)
-- DEVELOPMENT ONLY — candidat additif ; JAMAIS appliqué par ce fichier à la
-- Production ni à une base hébergée sans GO distinct.
--
-- Problème : la page de retour de paiement (app/checkout/return/shared.ts)
-- ne porte qu'un lien legacy /track/<id>#<public_token>, dont l'échange est
-- À USAGE UNIQUE (upgrade_legacy_tracking_capability). Dès que ce jeton a été
-- consommé (suivi déjà ouvert avant le paiement, retour de la banque dans un
-- autre navigateur, cookie perdu), le client reçoit un « lien invalide »
-- générique et ne retrouve plus ni le suivi ni l'écran de rétractation.
--
-- Solution : une capacité RÉUTILISABLE émise côté serveur par la page de
-- retour, du même type que celle des e-mails (même lecture, mêmes garanties :
-- seul sha256(secret) est stocké, expiration bornée).
--
-- Pourquoi un `kind = 'return'` DISTINCT et pas `kind = 'email'` : le plafond
-- de 16 capacités `email` par commande est partagé avec le worker
-- d'e-mails (issue_order_email_tracking_capability). Si la page de retour en
-- consommait à chaque visite, des rechargements répétés épuiseraient ce
-- plafond et l'e-mail de confirmation ne partirait JAMAIS (échec terminal
-- « plafond atteint »). Compteur séparé = les deux ne s'affectent pas.
--
-- Ce lot ne modifie AUCUNE fonction de lecture : get_order_tracking_by_
-- capability & co. valident (commande, identifiant, sha256, expiration) sans
-- filtrer le type -- vérifié par tests/v172-return-tracking-capability.test.ts
-- (SQL réel exécuté). Aucun e-mail, aucun backfill.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 0. PRÉ-VOL.
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.order_tracking_capabilities') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.order_tracking_capabilities est introuvable -- le lot CUSTOMER TRACKING v3.1 doit être appliqué avant. Annulé.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_tracking_capabilities'::regclass
      and conname = 'order_tracking_capabilities_kind'
  ) or not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_tracking_capabilities'::regclass
      and conname = 'order_tracking_capabilities_email_bounded'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: contraintes de type de capacité introuvables. Annulé.';
  end if;

  if to_regprocedure('public.issue_order_return_tracking_capability(uuid)') is not null then
    raise exception 'SCANYM_SCHEMA_DRIFT: issue_order_return_tracking_capability existe déjà -- lot déjà appliqué (double application refusée).';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 1. Nouveau type 'return' : même invariants que 'email' (né réclamé, secret
--    haché, expiration obligatoire).
-- -----------------------------------------------------------------------------
alter table public.order_tracking_capabilities
  drop constraint order_tracking_capabilities_kind;
alter table public.order_tracking_capabilities
  add constraint order_tracking_capabilities_kind
  check (kind in ('legacy_upgrade', 'email', 'return'));

alter table public.order_tracking_capabilities
  drop constraint order_tracking_capabilities_email_bounded;
alter table public.order_tracking_capabilities
  add constraint order_tracking_capabilities_email_bounded
  check (
    (kind in ('email', 'return') and secret_hash is not null and expires_at is not null)
    or (kind = 'legacy_upgrade' and expires_at is null)
  );

-- -----------------------------------------------------------------------------
-- 2. Émission (service_role uniquement), calquée sur
--    issue_order_email_tracking_capability, avec SON PROPRE plafond.
-- -----------------------------------------------------------------------------
create function public.issue_order_return_tracking_capability(
  p_order_id uuid
)
returns table (
  capability_id uuid,
  capability_secret text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_count    int;
  v_cap_id   uuid;
  v_secret   text;
begin
  if p_order_id is null then
    return;
  end if;

  -- Verrou de la ligne commande : sérialise les émissions concurrentes
  -- pour que le plafond tienne.
  select o.id into v_order_id
  from public.orders o
  where o.id = p_order_id
  for update;

  if v_order_id is null then
    return;
  end if;

  -- Plafond PROPRE au type 'return' : n'entame jamais celui des e-mails.
  select pg_catalog.count(*) into v_count
  from public.order_tracking_capabilities c
  where c.order_id = v_order_id
    and c.kind = 'return';

  if v_count >= 16 then
    return;
  end if;

  v_secret := pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
           || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');

  insert into public.order_tracking_capabilities (order_id, kind, secret_hash, claimed_at, expires_at)
  values (
    v_order_id,
    'return',
    pg_catalog.sha256(pg_catalog.convert_to(v_secret, 'UTF8')),
    pg_catalog.now(),
    pg_catalog.now() + interval '30 days'
  )
  returning id into v_cap_id;

  capability_id := v_cap_id;
  capability_secret := v_secret;
  return next;
end;
$$;

comment on function public.issue_order_return_tracking_capability(uuid) is
  'SECURITY DEFINER, service_role UNIQUEMENT -- RETURN TRACKING CAPABILITY v1. Émet l''identifiant de suivi RÉUTILISABLE de la page de retour de paiement : capacité kind=return liée à la commande, née réclamée (seul sha256(secret) stocké), expirant après 30 jours. Plafond de 16 par commande, DISTINCT de celui des e-mails. Commande inexistante, NULL ou plafond atteint : ensemble vide.';

revoke all on function public.issue_order_return_tracking_capability(uuid) from public, anon, authenticated;
grant execute on function public.issue_order_return_tracking_capability(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- 3. POST-VOL.
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.issue_order_return_tracking_capability(uuid)') is null then
    raise exception 'SCANYM_POSTCHECK_FAILED: issue_order_return_tracking_capability est absente.';
  end if;

  if has_function_privilege('public', 'public.issue_order_return_tracking_capability(uuid)', 'execute')
     or has_function_privilege('anon', 'public.issue_order_return_tracking_capability(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.issue_order_return_tracking_capability(uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.issue_order_return_tracking_capability(uuid)', 'execute') then
    raise exception 'SCANYM_POSTCHECK_FAILED: droits d''exécution de issue_order_return_tracking_capability incorrects.';
  end if;

  if (select pg_get_constraintdef(oid) from pg_constraint
      where conrelid = 'public.order_tracking_capabilities'::regclass
        and conname = 'order_tracking_capabilities_kind') not like '%return%' then
    raise exception 'SCANYM_POSTCHECK_FAILED: le type return n''est pas autorisé.';
  end if;
end $$;

commit;
