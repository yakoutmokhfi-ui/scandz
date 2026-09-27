-- =============================================================================
-- Scanym — GAP-01 — ACKNOWLEDGEMENT TRANSPORT + MERCHANT CC + BACKOFFICE
-- NOTIFICATION (v1).
--
-- Ce lot livre le TRANSPORT réel de l'accusé de réception de
-- rétractation (art. L221-21 / D.221-5), qui manquait depuis ONLINE
-- WITHDRAWAL v1/v1.1/v1.2 (voir `_scanym_has_operational_durable_ack_
-- channel()`, qui renvoyait `false` en dur, EXPLICITEMENT, par
-- construction — v1.2, correction d'audit OW-V11-ACK-GUARD-01).
--
-- CE LOT NE CHANGE RIEN à :
--   * la détermination de l'ÉLIGIBILITÉ par ligne
--     (`menu_items.withdrawal_eligible`,
--     `order_items.withdrawal_eligible_at_order_time`, la garde
--     fail-closed dans `get_withdrawal_options_by_capability` et
--     `submit_withdrawal_request_by_capability`) ;
--   * le régime marchand (`merchant_cgv_profile.withdrawal_regime`,
--     EXEMPT_PERISHABLE / STANDARD_14_DAYS / MIXED), toujours choisi
--     explicitement par le marchand, sans valeur par défaut ;
--   * le moteur CGV / la sélection de gabarit par
--     `jurisdiction_country`.
-- Ces trois mécanismes existent déjà et gouvernent déjà, correctement,
-- QUI voit l'écran de rétractation et QUELS produits y apparaissent
-- (voir le commentaire d'investigation dans le rapport de lot posté
-- sur l'issue #11 — code de référence exact cité, aucune ré-
-- implémentation ici). GAP-01 ajoute uniquement l'ENVOI de l'accusé,
-- sa copie au marchand, la notification backoffice, et le contrôle de
-- disponibilité RÉEL de ce transport.
--
-- A. `scanym_ack_transport_health` — configuration/état de santé du
--    transport SMTP, opérateur uniquement.
-- B. Redéfinition de `_scanym_has_operational_durable_ack_channel()` —
--    lit désormais `last_check_ok`, fail-closed par défaut (une ligne
--    absente, ou `configured = false`, ou un check jamais exécuté ->
--    false). La seule présence de variables d'environnement ne suffit
--    JAMAIS à faire basculer cette garde : voir le commentaire de la
--    fonction ci-dessous pour le raisonnement complet.
-- C. Preuve d'envoi — colonnes ajoutées à `withdrawal_requests`
--    (destinataires To/CC, message id, version de contenu, horodatage
--    de tentative), plus les valeurs `sending`/`failed` du statut.
-- D. Deux RPC serveur (service_role UNIQUEMENT, jamais anon/
--    authenticated) : `claim_withdrawal_acknowledgement_send` (jeton
--    de traitement atomique, ré-attribuable après expiration — c'est
--    ce qui rend le renvoi idempotent : deux tentatives concurrentes
--    ou un rejeu après crash ne peuvent jamais produire un second
--    envoi tant qu'une tentative n'a pas expiré) et
--    `record_withdrawal_acknowledgement_result` (persistance du
--    résultat réel, succès ou échec).
-- E. Notification backoffice — lecture seule, RLS, marchand + membres
--    de son établissement (même patron que `merchant_legal_profile`),
--    jamais d'écriture cliente sur `withdrawal_requests`.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- A. SANTÉ DU TRANSPORT SMTP — ligne singleton, opérateur uniquement.
-- -----------------------------------------------------------------------------
-- `configured` reflète UNIQUEMENT si les cinq variables d'environnement
-- SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD/SMTP_FROM sont présentes
-- CÔTÉ SERVEUR au moment du dernier check (jamais leur valeur : cette
-- table ne stocke aucun secret). `last_check_ok` est la SEULE colonne
-- que lit la garde de publication (section B) : `configured = true`
-- sans `last_check_ok = true` ne débloque RIEN. Un mot de passe erroné,
-- un port fermé par un pare-feu ou un hôte injoignable laisseraient
-- `configured = true` mais `last_check_ok = false` — c'est précisément
-- le cas que cette séparation existe pour capturer : un déploiement
-- "qui a l'air configuré" mais qui échouerait silencieusement à
-- transmettre CHAQUE accusé de réception légal.
create table if not exists public.scanym_ack_transport_health (
  id              integer primary key default 1 check (id = 1),
  configured      boolean not null default false,
  last_check_at   timestamptz,
  last_check_ok   boolean not null default false,
  last_check_error text,
  checked_by      uuid,
  updated_at      timestamptz not null default now()
);

comment on table public.scanym_ack_transport_health is
  'GAP-01 — état RÉEL, mesuré, du transport SMTP d''accusé de réception de rétractation. Ligne singleton (id=1), écrite exclusivement par la route admin de test de connectivité (service_role). `configured=true` seul ne prouve rien : seul `last_check_ok=true`, issu d''un test de connexion SMTP réellement exécuté, autorise `_scanym_has_operational_durable_ack_channel()` à renvoyer true. Jamais de secret stocké ici.';

alter table public.scanym_ack_transport_health enable row level security;

-- Convergence explicite (même discipline que merchant_legal_profile /
-- cgv_template) : révoque de TOUS les rôles avant de ne rien
-- regrant — accès exclusivement via les fonctions SECURITY DEFINER
-- ci-dessous et le client service_role (qui contourne RLS par
-- construction Supabase, mais reste sans privilège de table direct
-- ici par défense en profondeur).
revoke all privileges on table public.scanym_ack_transport_health from public;
revoke all privileges on table public.scanym_ack_transport_health from anon;
revoke all privileges on table public.scanym_ack_transport_health from authenticated;
revoke all privileges on table public.scanym_ack_transport_health from service_role;
-- Aucune policy : default-deny pour anon/authenticated. Le client
-- service_role (route admin de health-check) contourne RLS.

insert into public.scanym_ack_transport_health (id, configured, last_check_ok)
values (1, false, false)
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- B. GARDE — redéfinition de `_scanym_has_operational_durable_ack_channel()`
-- -----------------------------------------------------------------------------
-- v1.2 (ONLINE WITHDRAWAL) la définissait `select false;`, `immutable`,
-- explicitement fail-closed tant qu'aucun lot autorisé ne livrait de
-- transport réel. Ce lot EST ce lot autorisé (GAP-01, CIO DECISION —
-- GAP-01 design direction). La fonction passe donc de `immutable` à
-- `stable` (elle lit désormais une table) et lit `last_check_ok`
-- plutôt que de renvoyer un littéral.
--
-- FAIL-CLOSED PRÉSERVÉ, à l'identique de l'intention de la v1.2 : la
-- garde ne teste PAS la présence d'un objet de schéma (table, ligne,
-- variable d'environnement) — elle teste un RÉSULTAT DE CHECK. Sans
-- ligne (`not found`), ou `last_check_ok` NULL/false, ou un check
-- jamais exécuté depuis le déploiement de ce lot : `false`. Un
-- opérateur qui ajoute SMTP_HOST/…/SMTP_FROM dans Vercel sans jamais
-- déclencher le test de connectivité admin ne fait donc PAS basculer
-- cette garde — exactement le contournement par présence d'objet que
-- l'audit OW-V11-ACK-GUARD-01 avait corrigé, ici appliqué à la
-- présence d'une variable d'environnement plutôt qu'à celle d'une
-- table.
create or replace function public._scanym_has_operational_durable_ack_channel()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select h.last_check_ok from public.scanym_ack_transport_health h where h.id = 1),
    false
  );
$$;

comment on function public._scanym_has_operational_durable_ack_channel() is
  'GAP-01 — le canal d''accusé de réception sur support durable est-il RÉELLEMENT opérationnel ? Lit scanym_ack_transport_health.last_check_ok (ligne singleton id=1), écrite UNIQUEMENT par un test de connexion SMTP réel (route admin service_role — jamais par la seule présence de SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD/SMTP_FROM). Absence de ligne, ou last_check_ok NULL/false -> false, fail-closed. Remplace le `select false;` littéral de ONLINE WITHDRAWAL v1.2 : CE lot est le lot autorisé qui livre le transport (CIO DECISION — GAP-01 design direction, issue #11).';

revoke all on function public._scanym_has_operational_durable_ack_channel() from public;

-- -----------------------------------------------------------------------------
-- C. PREUVE D'ENVOI — colonnes ajoutées à withdrawal_requests
-- -----------------------------------------------------------------------------
-- `acknowledgement_address` (existant) est déjà le destinataire À :
-- moyen électronique choisi/confirmé par le consommateur (D.221-5).
-- Ce lot ajoute la copie marchand (CC), l'identifiant de message du
-- prestataire SMTP, la version de contenu (gabarit d'e-mail), et les
-- métadonnées de tentative — la trace d'évidence exigée par la CIO
-- (destinataires, message id, horodatage, statut, version de contenu).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'withdrawal_requests'
      and column_name = 'acknowledgement_cc'
  ) then
    alter table public.withdrawal_requests
      add column acknowledgement_cc            text,
      add column acknowledgement_message_id    text,
      add column acknowledgement_content_version text,
      add column acknowledgement_attempted_at  timestamptz,
      add column acknowledgement_claimed_at    timestamptz,
      add column acknowledgement_send_attempts integer not null default 0;
  end if;
end $$;

comment on column public.withdrawal_requests.acknowledgement_cc is
  'GAP-01 — adresse en copie (CC) de l''accusé de réception envoyé au consommateur : le contact/service-client configuré du marchand (merchant_legal_profile.customer_service_email), résolu et figé au moment de l''envoi. NULL tant qu''aucun envoi n''a été tenté ou si le marchand n''a configuré aucun contact.';
comment on column public.withdrawal_requests.acknowledgement_message_id is
  'GAP-01 — identifiant de message renvoyé par le serveur SMTP (réponse à la commande DATA) lors d''un envoi réussi. Preuve d''évidence d''audit, jamais généré côté client.';
comment on column public.withdrawal_requests.acknowledgement_content_version is
  'GAP-01 — version du gabarit de contenu d''accusé de réception effectivement envoyé (lib/server/ack-mailer.ts, ACK_EMAIL_CONTENT_VERSION), pour reconstituer exactement le texte envoyé à une date donnée même après une future révision du gabarit.';
comment on column public.withdrawal_requests.acknowledgement_claimed_at is
  'GAP-01 — horodatage de la dernière prise en charge d''envoi (claim_withdrawal_acknowledgement_send). Permet la ré-attribution après expiration (crash du worker en cours d''envoi) sans double-envoi tant que la fenêtre n''est pas expirée.';

-- v1.2 (ONLINE WITHDRAWAL) : ('pending', 'unavailable_no_channel', 'sent', 'failed').
-- GAP-01 ajoute l'état transitoire 'sending', posé par le claim
-- atomique (section D) et JAMAIS observable en dehors d'une fenêtre
-- de traitement en cours ou d'un crash récent.
-- IDEMPOTENCE (ré-application de ce fichier) : si la contrainte GAP-01
-- (vocabulaire à CINQ valeurs, dont 'sending') est déjà en place, ne
-- rien faire. Sinon, retrouver PAR SA DÉFINITION la contrainte v1.2
-- d'ONLINE WITHDRAWAL (vocabulaire à QUATRE valeurs) -- jamais par un
-- nom supposé -- et la seule, jamais
-- `withdrawal_requests_ack_sent_requires_timestamp` (contrainte
-- D'ÉGALITÉ distincte, dont la définition mentionne elle aussi
-- `acknowledgement_status` en texte mais n'énumère AUCUNE valeur : le
-- filtre ci-dessous exige la présence des DEUX valeurs de vocabulaire
-- d'origine pour ne cibler que la bonne contrainte).
do $$
declare
  v_conname text;
begin
  if exists (
    select 1
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class cls on cls.oid = con.conrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = cls.relnamespace
    where nsp.nspname = 'public' and cls.relname = 'withdrawal_requests' and con.contype = 'c'
      and con.conname = 'withdrawal_requests_acknowledgement_status_check'
      and pg_catalog.pg_get_constraintdef(con.oid) like '%''sending''%'
  ) then
    return; -- déjà appliqué par une exécution antérieure de ce fichier.
  end if;

  select con.conname into v_conname
  from pg_catalog.pg_constraint con
  join pg_catalog.pg_class cls on cls.oid = con.conrelid
  join pg_catalog.pg_namespace nsp on nsp.oid = cls.relnamespace
  where nsp.nspname = 'public' and cls.relname = 'withdrawal_requests' and con.contype = 'c'
    and pg_catalog.pg_get_constraintdef(con.oid) like '%''pending''%'
    and pg_catalog.pg_get_constraintdef(con.oid) like '%''unavailable_no_channel''%';

  if v_conname is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: contrainte de vocabulaire de withdrawal_requests.acknowledgement_status introuvable -- ONLINE WITHDRAWAL v1 attendu, annulé.';
  end if;

  execute pg_catalog.format('alter table public.withdrawal_requests drop constraint %I', v_conname);
  alter table public.withdrawal_requests
    add constraint withdrawal_requests_acknowledgement_status_check
    check (acknowledgement_status in ('pending', 'unavailable_no_channel', 'sending', 'sent', 'failed'));
end $$;

-- -----------------------------------------------------------------------------
-- D. RPC SERVICE_ROLE — claim atomique + enregistrement du résultat
-- -----------------------------------------------------------------------------
-- `scanym_ack_transport_health` révoque TOUT privilège de table à
-- service_role (section A, discipline de convergence) : le rôle
-- service_role CONTOURNE RLS mais reste soumis aux GRANT/REVOKE
-- ordinaires (deux systèmes distincts en PostgreSQL). Sans cette RPC,
-- un simple `.update()` service_role depuis la route admin de
-- health-check échouerait par défaut de privilège. SECURITY DEFINER
-- (propriétaire de la fonction) contourne ce besoin de grant de
-- table, exactement comme claim_withdrawal_acknowledgement_send ci-
-- dessous pour withdrawal_requests.
create or replace function public.record_ack_transport_health_check(
  p_configured boolean,
  p_ok         boolean,
  p_error      text,
  p_checked_by uuid
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.scanym_ack_transport_health
  set configured = p_configured,
      last_check_at = now(),
      last_check_ok = p_ok,
      last_check_error = p_error,
      checked_by = p_checked_by,
      updated_at = now()
  where id = 1;
$$;

comment on function public.record_ack_transport_health_check(boolean, boolean, text, uuid) is
  'GAP-01 — écrit le résultat RÉEL (jamais un true de confort) d''un test de connexion SMTP effectué par la route admin de health-check (app/api/admin/gap-01-ack-health-check/route.ts). service_role uniquement -- jamais anon/authenticated, jamais appelable directement par un marchand.';

revoke all on function public.record_ack_transport_health_check(boolean, boolean, text, uuid) from public, anon, authenticated;
grant execute on function public.record_ack_transport_health_check(boolean, boolean, text, uuid) to service_role;

-- IDEMPOTENCE : `claim_...` ne fait avancer AUCUNE ligne qui n'est pas
-- 'pending', ni une ligne 'sending' dont la prise en charge est encore
-- fraîche (< p_stale_after_seconds). Deux appels concurrents, ou un
-- rejeu immédiat du même job, ne peuvent donc jamais tous les deux
-- obtenir la ligne : `UPDATE ... WHERE ... RETURNING` est atomique
-- sous MVCC (le second appel voit 0 ligne affectée, jamais une
-- lecture-puis-écriture racée). Un crash APRÈS claim mais AVANT
-- record_result laisse la ligne 'sending' jusqu'à expiration, après
-- quoi elle redevient éligible — jamais bloquée indéfiniment, jamais
-- non plus renvoyée en boucle serrée.
-- Renvoie, EN PLUS de la ligne revendiquée, l'identité/contact
-- marchand (jointure restaurants + merchant_legal_profile) -- dans le
-- MÊME appel SECURITY DEFINER, plutôt que d'exiger une lecture directe
-- ultérieure de ces tables par service_role, qui n'y a AUCUN privilège
-- de table (merchant_legal_profile les révoque tous explicitement,
-- section A de DRAFT-lot-seller-legal-profile-cgv-engine-v1-1.sql) :
-- SECURITY DEFINER contourne ce besoin pour TOUTES les instructions du
-- corps de la fonction, jamais seulement la première.
do $$
begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'withdrawal_ack_claim_result'
  ) then
    create type public.withdrawal_ack_claim_result as (
      id                        uuid,
      restaurant_id             uuid,
      order_id                  uuid,
      acknowledgement_address   text,
      customer_first_name       text,
      customer_last_name        text,
      declaration_snapshot      jsonb,
      merchant_name             text,
      merchant_contact_email    text,
      merchant_contact_phone    text
    );
  end if;
end $$;

create or replace function public.claim_withdrawal_acknowledgement_send(
  p_withdrawal_request_id uuid,
  p_stale_after_seconds    integer default 120
)
returns public.withdrawal_ack_claim_result
language sql
security definer
set search_path = ''
as $$
  with claimed as (
    update public.withdrawal_requests
    set acknowledgement_status = 'sending',
        acknowledgement_claimed_at = now(),
        acknowledgement_send_attempts = acknowledgement_send_attempts + 1
    where id = p_withdrawal_request_id
      and (
        acknowledgement_status = 'pending'
        or (
          acknowledgement_status = 'sending'
          and acknowledgement_claimed_at is not null
          and acknowledgement_claimed_at < now() - make_interval(secs => greatest(p_stale_after_seconds, 1))
        )
      )
    returning *
  )
  select
    c.id, c.restaurant_id, c.order_id, c.acknowledgement_address,
    c.customer_first_name, c.customer_last_name, c.declaration_snapshot,
    r.name, mlp.customer_service_email, mlp.customer_service_phone
  from claimed c
  left join public.restaurants r on r.id = c.restaurant_id
  left join public.merchant_legal_profile mlp on mlp.restaurant_id = c.restaurant_id;
$$;

comment on function public.claim_withdrawal_acknowledgement_send(uuid, integer) is
  'GAP-01 — prise en charge atomique de l''envoi d''un accusé de réception : ne renvoie une ligne QUE si elle était ''pending'', ou ''sending'' depuis plus de p_stale_after_seconds (récupération après crash). Aucune ligne renvoyée -> aucun envoi ne doit être tenté (déjà en cours ailleurs, déjà envoyée, déjà en échec définitif, ou canal indisponible). Renvoie aussi l''identité/contact marchand (nom, e-mail et téléphone de service client de merchant_legal_profile), lus ICI sous SECURITY DEFINER -- service_role n''a par ailleurs aucun privilège de table sur restaurants/merchant_legal_profile. service_role uniquement.';

revoke all on function public.claim_withdrawal_acknowledgement_send(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_withdrawal_acknowledgement_send(uuid, integer) to service_role;

create or replace function public.record_withdrawal_acknowledgement_result(
  p_withdrawal_request_id uuid,
  p_ok                     boolean,
  p_to                     text,
  p_cc                     text,
  p_message_id             text,
  p_content_version        text,
  p_error                  text
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.withdrawal_requests
  set acknowledgement_status = case when p_ok then 'sent' else 'failed' end,
      acknowledgement_sent_at = case when p_ok then now() else acknowledgement_sent_at end,
      acknowledgement_address = coalesce(p_to, acknowledgement_address),
      acknowledgement_cc = coalesce(p_cc, acknowledgement_cc),
      acknowledgement_message_id = case when p_ok then p_message_id else acknowledgement_message_id end,
      acknowledgement_content_version = coalesce(p_content_version, acknowledgement_content_version),
      acknowledgement_attempted_at = now(),
      acknowledgement_last_error = p_error
  where id = p_withdrawal_request_id;
$$;

comment on function public.record_withdrawal_acknowledgement_result(uuid, boolean, text, text, text, text, text) is
  'GAP-01 — persiste le résultat RÉEL (succès ou échec) d''une tentative d''envoi d''accusé de réception, quelle que soit l''issue : écrit toujours une preuve d''évidence (acknowledgement_attempted_at), même en échec. N''écrit acknowledgement_status=''sent'' que si p_ok=true. service_role uniquement — jamais appelée par le client.';

revoke all on function public.record_withdrawal_acknowledgement_result(uuid, boolean, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_withdrawal_acknowledgement_result(uuid, boolean, text, text, text, text, text) to service_role;

-- -----------------------------------------------------------------------------
-- E. NOTIFICATION BACKOFFICE MARCHAND — lecture seule, RLS
-- -----------------------------------------------------------------------------
-- Même patron que "restaurant members read legal profile" sur
-- merchant_legal_profile (DRAFT-lot-seller-legal-profile-cgv-engine-
-- v1-1.sql) : membre de restaurant_users pour CE restaurant, ou
-- opérateur Scanym. `declaration_snapshot` (déjà écrit par
-- submit_withdrawal_request_by_capability) porte déjà tout le
-- contenu nécessaire à l'écran backoffice (numéro de commande,
-- identité/contact client, lignes produits/quantités) — aucune
-- nouvelle dénormalisation n'est nécessaire ici. Ecriture cliente
-- TOUJOURS absente (pas de grant insert/update/delete) : seules les
-- RPC SECURITY DEFINER existantes (submit_withdrawal_request_by_
-- capability) et service_role (sections D ci-dessus) écrivent cette
-- table.
grant select on table public.withdrawal_requests to authenticated;

drop policy if exists "restaurant members read own withdrawal requests" on public.withdrawal_requests;
create policy "restaurant members read own withdrawal requests"
on public.withdrawal_requests
for select
to authenticated
using (
  exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid() and ru.restaurant_id = withdrawal_requests.restaurant_id
  )
  or public.is_scanym_operator()
);

-- -----------------------------------------------------------------------------
-- F. VÉRIFICATIONS POST-COMMIT
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_class where relname = 'scanym_ack_transport_health' and relnamespace = 'public'::regnamespace) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: scanym_ack_transport_health absente.';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.scanym_ack_transport_health'::regclass) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: RLS non activée sur scanym_ack_transport_health.';
  end if;

  -- À la PREMIÈRE application (ligne singleton tout juste semée,
  -- jamais encore vérifiée par un test de connectivité réel), la
  -- garde DOIT rester fail-closed : la seule application de cette
  -- migration ne doit jamais, par elle-même, débloquer la publication
  -- CGV. Vérification conditionnée à l'ABSENCE de tout check
  -- antérieur (last_check_at is null) : une RÉ-application de ce
  -- fichier (idempotence) sur un système où un opérateur a déjà fait
  -- passer un test de connectivité réel ne doit PAS, elle, échouer --
  -- ce serait confondre "vient d'être installé" avec "vient d'être
  -- ré-appliqué".
  if (select h.last_check_at is null from public.scanym_ack_transport_health h where h.id = 1)
     and public._scanym_has_operational_durable_ack_channel() then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: le canal d''accusé se déclare opérationnel immédiatement après la première migration, sans aucun test de connectivité réel -- régression du principe fail-closed.';
  end if;

  if has_function_privilege('anon', 'public.claim_withdrawal_acknowledgement_send(uuid,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.claim_withdrawal_acknowledgement_send(uuid,integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.record_withdrawal_acknowledgement_result(uuid,boolean,text,text,text,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.record_withdrawal_acknowledgement_result(uuid,boolean,text,text,text,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.record_ack_transport_health_check(boolean,boolean,text,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.record_ack_transport_health_check(boolean,boolean,text,uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: RPC service_role de GAP-01 exposées à un rôle client.';
  end if;

  if not has_function_privilege('service_role', 'public.record_ack_transport_health_check(boolean,boolean,text,uuid)', 'EXECUTE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: record_ack_transport_health_check non exécutable par service_role.';
  end if;

  if not has_table_privilege('authenticated', 'public.withdrawal_requests', 'SELECT') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: lecture backoffice de withdrawal_requests non accordée à authenticated.';
  end if;

  if has_table_privilege('authenticated', 'public.withdrawal_requests', 'INSERT')
     or has_table_privilege('authenticated', 'public.withdrawal_requests', 'UPDATE')
     or has_table_privilege('authenticated', 'public.withdrawal_requests', 'DELETE') then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: écriture cliente directe sur withdrawal_requests -- doit rester exclusivement via RPC.';
  end if;
end $$;

commit;

-- =============================================================================
-- AUCUNE DONNÉE LOCATAIRE N'EST MODIFIÉE. La ligne singleton de
-- scanym_ack_transport_health est semée avec last_check_ok=false : la
-- garde de publication CGV reste fail-closed jusqu'à ce qu'un
-- opérateur déclenche explicitement le test de connectivité SMTP réel
-- (route admin, hors périmètre SQL) ET que le CIO donne le GO,
-- conformément à "aucun envoi réel sans audit + GO CIO explicite".
-- =============================================================================
