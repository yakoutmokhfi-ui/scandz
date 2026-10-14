-- ============================================================================
-- MONETICO PAYMENT SIMULATOR v1.2 — TEST-PROJECT AUTHORITY v1
-- (MSIM-SEC-01 / MSIM-AUTH-03 / MSIM-SIDE-04 remediation, audit Cat Turing)
--
-- *** À APPLIQUER UNIQUEMENT SUR LE PROJET SUPABASE DE TEST DÉDIÉ AU
-- *** SIMULATEUR. JAMAIS SUR LA PRODUCTION. CE SCRIPT REFUSE DE S'APPLIQUER
-- *** SI LE PROJET PORTE LA MOINDRE TRACE D'EXPLOITATION RÉELLE (§0).
--
-- PRINCIPE (ferme SEC-01 « exclusion contournable par configuration
-- concordante ») : l'autorité qui distingue le projet de test du projet
-- de production N'EST PLUS une variable d'environnement mais un OBJET DE
-- LA BASE ELLE-MÊME, créé par ce lot sur le seul projet de test :
--   - la table singleton `simulator_authority` (ref du projet, secret
--     d'autorité, TPE synthétiques autorisés) ;
--   - la RPC `get_simulator_authority()`.
-- Sur le projet de production, cette fonction N'EXISTE PAS : tout appel
-- échoue, la porte du simulateur est fermée, quelles que soient les
-- variables d'environnement -- aucune combinaison de variables
-- « concordantes » ne peut créer une fonction SQL dans une base.
-- En outre, `get_simulator_authority()` RE-VÉRIFIE À CHAQUE APPEL qu'aucun
-- marchand `live` n'existe dans la base (§2) : même appliqué par erreur
-- sur une base réelle, le lot se neutralise dès qu'un marchand live est
-- présent.
--
-- AUTH-03 : table `simulator_decision_tokens` + RPC `issue_…`/`consume_…`.
-- La consommation est un UPDATE unique sur la ligne (clé primaire nonce)
-- conditionné par `consumed_at is null` : PostgreSQL sérialise les
-- écritures concurrentes sur une même ligne, UN SEUL appelant obtient la
-- ligne, les autres reçoivent 0 ligne -> rejet déterministe. L'état est
-- durable : un redémarrage de processus ou une autre instance Vercel voit
-- la même ligne consommée.
--
-- SIDE-04 : §4 RÉVOQUE, sur le projet de test, l'exécution des RPC
-- d'allocation/d'envoi Stuart au rôle service_role. Le projet de test du
-- simulateur est un projet PAIEMENT : aucune ligne `stuart_delivery_jobs`
-- ne peut y être créée, par aucun chemin TS, sans modifier le pipeline de
-- production (qui, lui, reste strictement inchangé).
--
-- AUCUN GRANT direct de table : accès par RPC SECURITY DEFINER uniquement
-- (même discipline que PAYMENT P1).
-- ============================================================================

-- §0 -- GARDES D'APPLICATION (fail-closed)
do $$
declare
  v_ref text;
  v_live integer;
begin
  -- 0.a L'opérateur DOIT déclarer explicitement la ref du projet cible
  --     dans la session SQL avant d'appliquer :
  --       set app.simulator_project_ref = '<ref du projet de test>';
  v_ref := nullif(btrim(current_setting('app.simulator_project_ref', true)), '');
  if v_ref is null or v_ref !~ '^[a-z0-9]{10,40}$' then
    raise exception 'SCANYM_SIMULATOR_AUTHORITY: app.simulator_project_ref absent ou invalide -- déclarer explicitement la ref du PROJET DE TEST (set app.simulator_project_ref = ''...'') avant application. Migration annulée.';
  end if;

  -- 0.b Schéma attendu présent.
  if to_regclass('public.payment_provider_configs') is null
     or to_regclass('public.payment_transactions') is null
     or to_regclass('public.orders') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: tables paiement absentes -- ce lot présuppose PAYMENT P1. Migration annulée.';
  end if;

  -- 0.c EXCLUSION PRODUCTION ancrée dans les DONNÉES : un projet de test
  --     dédié n'a AUCUN marchand en mode live.
  select count(*) into v_live from public.payment_provider_configs where mode = 'live';
  if v_live > 0 then
    raise exception 'SCANYM_SIMULATOR_AUTHORITY: % configuration(s) prestataire en mode LIVE détectée(s) -- cette base N''EST PAS un projet de test dédié. Migration REFUSÉE.', v_live;
  end if;

  -- 0.d Double application refusée.
  if to_regclass('public.simulator_authority') is not null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.simulator_authority existe déjà -- migration déjà appliquée, double application refusée.';
  end if;
end $$;

-- §1 -- AUTORITÉ (singleton)
create table public.simulator_authority (
  singleton        boolean primary key default true check (singleton),
  project_ref      text not null check (project_ref ~ '^[a-z0-9]{10,40}$'),
  authority_secret text not null check (length(authority_secret) >= 64),
  allowed_tpes     text[] not null check (cardinality(allowed_tpes) between 1 and 50),
  created_at       timestamptz not null default now()
);
comment on table public.simulator_authority is
  'MONETICO SIMULATOR v1.2 — autorité de confiance du PROJET DE TEST DÉDIÉ. N''existe JAMAIS en production. Lecture exclusivement via get_simulator_authority(). Aucun grant direct.';
revoke all on table public.simulator_authority from anon, authenticated, service_role, public;

insert into public.simulator_authority (project_ref, authority_secret, allowed_tpes)
values (
  current_setting('app.simulator_project_ref'),
  -- 64 hex (2 x UUID v4, PostgreSQL core -- aucune extension requise)
  replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  -- TPE SYNTHÉTIQUES par défaut (7 alphanumériques). À restreindre/étendre
  -- par un opérateur via SQL sur le projet de test uniquement.
  array['1234567', '7654321']
);

-- §2 -- LECTURE DE L'AUTORITÉ (re-vérifie l'absence de marchand live)
create or replace function public.get_simulator_authority()
returns table (project_ref text, authority_secret text, allowed_tpes text[])
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_live integer;
begin
  select count(*) into v_live from public.payment_provider_configs c where c.mode = 'live';
  if v_live > 0 then
    raise exception 'SCANYM_SIMULATOR_AUTHORITY: marchand(s) LIVE présent(s) -- cette base n''est pas un projet de test dédié, autorité révoquée' using errcode = '42501';
  end if;
  return query select a.project_ref, a.authority_secret, a.allowed_tpes from public.simulator_authority a;
  if not found then
    raise exception 'SCANYM_SIMULATOR_AUTHORITY: autorité absente' using errcode = 'P0002';
  end if;
end;
$$;
comment on function public.get_simulator_authority() is
  'MONETICO SIMULATOR v1.2 — SECURITY DEFINER, service_role UNIQUEMENT. Absente en production par construction. Échoue (42501) dès qu''un marchand live existe.';
revoke all on function public.get_simulator_authority() from public, anon, authenticated;
grant execute on function public.get_simulator_authority() to service_role;

-- §3 -- JETONS DE DÉCISION À USAGE UNIQUE (AUTH-03)
create table public.simulator_decision_tokens (
  nonce            text primary key check (nonce ~ '^[0-9a-f]{32}$'),
  restaurant_id    uuid not null,
  order_id         uuid not null,
  transaction_id   uuid not null,
  provider_reference text not null check (length(provider_reference) between 1 and 100),
  url_retour_ok    text not null check (length(url_retour_ok) <= 2048),
  url_retour_err   text not null check (length(url_retour_err) <= 2048),
  issued_at        timestamptz not null default now(),
  expires_at       timestamptz not null,
  consumed_at      timestamptz,
  check (expires_at > issued_at),
  check (expires_at <= issued_at + interval '15 minutes')
);
create index idx_simulator_decision_tokens_expires on public.simulator_decision_tokens(expires_at);
comment on table public.simulator_decision_tokens is
  'MONETICO SIMULATOR v1.2 — jetons de décision opérateur : liés (marchand, commande, tentative/transaction, référence, URLs de retour), expiration serveur, consommation atomique unique. Aucun grant direct.';
revoke all on table public.simulator_decision_tokens from anon, authenticated, service_role, public;

create or replace function public.issue_simulator_decision_token(
  p_nonce text,
  p_provider_code text,
  p_provider_reference text,
  p_url_retour_ok text,
  p_url_retour_err text,
  p_ttl_seconds integer default 600
)
returns table (nonce text, transaction_id uuid, order_id uuid, restaurant_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_txn public.payment_transactions%rowtype;
  v_ttl integer;
begin
  if p_nonce is null or p_nonce !~ '^[0-9a-f]{32}$' then
    raise exception 'SCANYM_SIMULATOR_TOKEN: nonce invalide' using errcode = '22023';
  end if;
  v_ttl := least(greatest(coalesce(p_ttl_seconds, 600), 30), 900);
  select * into v_txn from public.payment_transactions t
    where t.provider_code = btrim(coalesce(p_provider_code, ''))
      and t.provider_reference = btrim(coalesce(p_provider_reference, ''));
  if not found then
    raise exception 'SCANYM_SIMULATOR_TOKEN: tentative introuvable' using errcode = 'P0002';
  end if;
  if v_txn.status <> 'pending' then
    raise exception 'SCANYM_SIMULATOR_TOKEN: tentative non pending (%)', v_txn.status using errcode = '42501';
  end if;
  insert into public.simulator_decision_tokens
    (nonce, restaurant_id, order_id, transaction_id, provider_reference, url_retour_ok, url_retour_err, expires_at)
  values
    (p_nonce, v_txn.restaurant_id, v_txn.order_id, v_txn.id, v_txn.provider_reference, p_url_retour_ok, p_url_retour_err, now() + make_interval(secs => v_ttl));
  return query select p_nonce, v_txn.id, v_txn.order_id, v_txn.restaurant_id, now() + make_interval(secs => v_ttl);
end;
$$;
revoke all on function public.issue_simulator_decision_token(text, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.issue_simulator_decision_token(text, text, text, text, text, integer) to service_role;

-- Consommation ATOMIQUE. Retourne exactement une ligne en cas de succès ;
-- lève sinon avec un code distinct :
--   P0002 inconnu · 42501 déjà consommé · 22023 expiré · 23514 liaison divergente
create or replace function public.consume_simulator_decision_token(
  p_nonce text,
  p_provider_reference text,
  p_url_retour_ok text,
  p_url_retour_err text
)
returns table (nonce text, transaction_id uuid, order_id uuid, restaurant_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.simulator_decision_tokens%rowtype;
begin
  -- Verrou de ligne : les appelants concurrents sont sérialisés ICI ; le
  -- second lit la ligne DÉJÀ consommée par le premier.
  select * into v_row from public.simulator_decision_tokens t where t.nonce = p_nonce for update;
  if not found then
    raise exception 'SCANYM_SIMULATOR_TOKEN: jeton inconnu' using errcode = 'P0002';
  end if;
  if v_row.consumed_at is not null then
    raise exception 'SCANYM_SIMULATOR_TOKEN: jeton déjà consommé' using errcode = '42501';
  end if;
  if v_row.expires_at <= now() then
    raise exception 'SCANYM_SIMULATOR_TOKEN: jeton expiré' using errcode = '22023';
  end if;
  if v_row.provider_reference is distinct from p_provider_reference
     or v_row.url_retour_ok is distinct from p_url_retour_ok
     or v_row.url_retour_err is distinct from p_url_retour_err then
    raise exception 'SCANYM_SIMULATOR_TOKEN: liaison divergente' using errcode = '23514';
  end if;
  update public.simulator_decision_tokens t set consumed_at = now() where t.nonce = p_nonce and t.consumed_at is null;
  if not found then
    raise exception 'SCANYM_SIMULATOR_TOKEN: jeton déjà consommé' using errcode = '42501';
  end if;
  return query select v_row.nonce, v_row.transaction_id, v_row.order_id, v_row.restaurant_id;
end;
$$;
revoke all on function public.consume_simulator_decision_token(text, text, text, text) from public, anon, authenticated;
grant execute on function public.consume_simulator_decision_token(text, text, text, text) to service_role;

-- §4 -- SIDE-04 : LE PROJET DE TEST DU SIMULATEUR NE PEUT PAS ALLOUER DE
-- LIVRAISON. Révocation (si les fonctions existent sur ce projet) de
-- l'exécution des RPC d'allocation/d'envoi Stuart au rôle applicatif.
-- Le pipeline TS de production est INCHANGÉ : sur ce projet, son appel
-- d'allocation reçoit 42501, l'erreur est absorbée par le hook (best-effort,
-- D1 v1.1) et le paiement reste appliqué -- AUCUNE ligne stuart_delivery_jobs.
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'allocate_stuart_delivery_job',
        'mark_stuart_delivery_job_send_started',
        'confirm_stuart_delivery_job_created',
        'mark_stuart_delivery_job_ambiguous',
        'mark_stuart_delivery_job_terminal_failure'
      )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated, service_role', f.sig);
  end loop;
end $$;
