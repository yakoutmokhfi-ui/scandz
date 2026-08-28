-- ============================================================
-- Scanym — PAYMENT P3-A0 — SECURE SERVER PAYMENT CREDENTIAL READ
-- CAPABILITY — v1 (DRAFT — NON APPLIQUÉ EN PRODUCTION)
--
-- OBJET : ce lot existe parce que l'inspection d'architecture de
-- PAYMENT P3-A a prouvé que la fondation P2A (DRAFT-lot-payment-p2a-
-- secure-config.sql) est INTÉGRALEMENT EN ÉCRITURE SEULE --
-- set_payment_provider_credentials / clear_payment_provider_credentials
-- écrivent un secret dans Supabase Vault mais AUCUN chemin, nulle
-- part dans le schéma publié, ne permet jamais à du code serveur de
-- confiance de relire ce secret déchiffré. Sans cette capacité,
-- AUCUN adaptateur de paiement serveur (Monetico ou tout autre
-- prestataire futur) ne peut jamais charger le credential dont il a
-- besoin pour signer une requête ou vérifier un callback -- ce lot
-- ferme UNIQUEMENT ce manque précis, rien de plus.
--
-- N'IMPLÉMENTE AUCUNE signature Monetico, AUCUN adaptateur, AUCUN
-- appel réseau prestataire. N'ACTIVE AUCUN tenant, AUCUN checkout
-- client, AUCUN back-office marchand. C'est un mini-lot SQL isolé,
-- au même titre que PAYMENT P2B-A l'a été pour la lecture marchande
-- sûre -- ici pour la lecture serveur de confiance.
--
-- PRÉREQUIS (déjà publiés, tous INCHANGÉS et NON ROUVERTS par ce
-- lot) : PAYMENT P1 FOUNDATION (payment_provider_configs,
-- payment_transactions, initiate_payment_attempt,
-- confirm_payment_attempt) et PAYMENT P2A SECURE CONFIGURATION
-- FOUNDATION (credentials_ref, configuration_status, Supabase Vault,
-- set_payment_provider_credentials, clear_payment_provider_credentials).
--
-- PATRON DE SÉCURITÉ PRÉSERVÉ (mandat section 2) : ce lot n'accorde
-- AUCUN accès direct à vault.secrets / vault.decrypted_secrets pour
-- quelque rôle applicatif que ce soit -- le seul chemin reste
-- application serveur -> RPC SECURITY DEFINER -> Vault, exactement
-- comme les deux RPC d'écriture de P2A. Ce lot ajoute le chemin de
-- LECTURE symétrique, avec la même discipline.
--
-- PROPRIÉTAIRE DE FONCTION (mandat section 4) : comme pour tous les
-- lots précédents (P1, P2A, P2B-A), AUCUNE clause OWNER TO explicite
-- n'est posée ici -- la fonction hérite de la propriété du rôle
-- exécutant cette migration au déploiement (le rôle de migration
-- Supabase de confiance, identique au patron déjà établi). C'est ce
-- propriétaire, PAS l'appelant, dont les privilèges s'appliquent
-- (SECURITY DEFINER) -- documenté explicitement ici car demandé par
-- le mandat, mais ne change AUCUNE convention existante.
--
-- SECRET RETOURNÉ INTENTIONNELLEMENT (mandat section 15) : cette
-- fonction retourne DÉLIBÉRÉMENT le matériel secret déchiffré. Ceci
-- n'est acceptable QUE parce que : (a) EXECUTE est restreint à
-- service_role SEUL (jamais anon/authenticated/PUBLIC) ; (b) elle
-- n'existe que pour servir un futur adaptateur prestataire serveur de
-- confiance (PAYMENT P3-A, pas encore implémenté) ; (c) elle n'est
-- JAMAIS appelable depuis un client navigateur -- le client Supabase
-- actuel du projet (lib/supabase.ts) n'utilise QUE la clé anon,
-- incapable d'exécuter cette fonction ; (d) PAYMENT P3-A introduira
-- séparément la frontière client service_role serveur-seul
-- nécessaire pour même pouvoir appeler cette fonction depuis du code
-- applicatif -- ce mini-lot pose uniquement la capacité base de
-- données, pas encore son point d'appel applicatif.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. PRÉREQUIS SCHÉMA (défensif) + garde anti double-application +
-- garde d'architecture Vault (même identité exacte que P2A --
-- réutilise le même contrôle, ce lot ne redéfinit rien).
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'payment_provider_configs'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.payment_provider_configs introuvable -- prérequis PAYMENT P1 FOUNDATION manquant, migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payment_provider_configs'
      and column_name in ('credentials_ref','configuration_status')
    having count(*) = 2
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: colonnes credentials_ref/configuration_status introuvables sur public.payment_provider_configs -- prérequis PAYMENT P2A SECURE CONFIG FOUNDATION manquant, migration annulée.';
  end if;

  -- Garde anti double-application.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_payment_provider_credential'
  ) then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.get_payment_provider_credential existe déjà -- PAYMENT P3-A0 déjà appliqué, migration annulée (double application refusée).';
  end if;

  -- GARDE D'ARCHITECTURE VAULT (identique à P2A section 1 --
  -- create_secret/update_secret ne sont pas utilisées par ce lot,
  -- mais vault.decrypted_secrets EST utilisée ici : la garde vérifie
  -- donc directement la présence de ce chemin de lecture précis,
  -- schéma + vue, plutôt que de dupliquer la vérification d'identité
  -- des fonctions d'écriture qui n'est pas pertinente ici).
  if to_regnamespace('vault') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: schéma `vault` (Supabase Vault) introuvable -- architecture de stockage sécurisé indisponible sur ce projet, migration annulée.';
  end if;

  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: vue vault.decrypted_secrets introuvable -- architecture de stockage sécurisé indisponible, migration annulée.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. get_payment_provider_credential — LECTURE SERVEUR DE CONFIANCE,
-- SEULE, service_role UNIQUEMENT.
--
-- Contrat de retour DÉLIBÉRÉMENT minimal (mandat section 3) :
-- `returns text` contenant UNIQUEMENT le payload secret déchiffré.
-- Ne retourne JAMAIS credentials_ref, l'UUID Vault, l'id de la ligne
-- de config, restaurant_id, ni aucune métadonnée -- l'appelant
-- connaît déjà restaurant_id/provider_code (il les a fournis).
--
-- POLITIQUE D'ÉTAT DE CONFIGURATION (mandat section 7, décision
-- documentée explicitement) : la lecture exige AU MINIMUM
-- configuration_status IN ('configured','verified') -- 'not_configured'
-- est refusé. `is_enabled` N'EST PAS exigé et N'EST PAS lu ici.
-- Raison : is_enabled est l'activation d'exécution (P1, politique de
-- paiement runtime future), DISTINCTE du cycle de vie du credential
-- (P2A). La vérification Sandbox de PAYMENT P3-A doit pouvoir lire et
-- tester un credential fraîchement stocké (configured) AVANT toute
-- activation client -- exiger is_enabled=true ici rendrait
-- structurellement impossible de vérifier un credential avant
-- activation, ce qui est précisément le flux que ce lot doit
-- permettre.
--
-- AUCUNE écriture (mandat section 12) : SELECT uniquement, aucun
-- verrou FOR UPDATE posé (lecture pure, pas de mutation à protéger
-- ici -- si un clear/set concurrent survient entre la lecture de la
-- config et la lecture de Vault, soit l'ancien secret est encore
-- lisible de façon cohérente, soit la référence est devenue
-- orpheline et ce lot échoue alors correctement fermé -- jamais un
-- état incohérent silencieusement retourné).
-- ------------------------------------------------------------
create or replace function public.get_payment_provider_credential(
  p_restaurant_id uuid,
  p_provider_code text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_provider_code text;
  v_config_id uuid;
  v_configuration_status text;
  v_credentials_ref uuid;
  v_secret text;
begin
  if p_restaurant_id is null then
    raise exception 'SCANYM_PAYMENT_CREDENTIAL: p_restaurant_id requis' using errcode = '22004';
  end if;

  -- Normalisation identique au patron P1 (trim seul, AUCUNE mise en
  -- minuscule imposée -- le schéma publié ne définit aucune règle de
  -- casse, mandat section 5).
  v_provider_code := btrim(coalesce(p_provider_code, ''));
  if length(v_provider_code) = 0 then
    raise exception 'SCANYM_PAYMENT_CREDENTIAL: p_provider_code requis (vide après normalisation)' using errcode = '22004';
  end if;

  -- CONFIG LOOKUP (mandat section 6) : exactement une ligne via la
  -- contrainte unique(restaurant_id, provider_code) déjà posée par
  -- P1 -- "plusieurs résultats" est structurellement impossible ici,
  -- pas seulement supposé. Portée STRICTEMENT au couple fourni --
  -- aucune requête ne touche jamais un autre restaurant, donc aucune
  -- fuite possible sur l'existence d'une configuration d'un AUTRE
  -- tenant, quel que soit le message d'erreur choisi ci-dessous.
  select id, configuration_status, credentials_ref
    into v_config_id, v_configuration_status, v_credentials_ref
    from public.payment_provider_configs
    where restaurant_id = p_restaurant_id
      and provider_code = v_provider_code;

  if not found then
    raise exception 'SCANYM_PAYMENT_CREDENTIAL: configuration introuvable pour ce restaurant/provider' using errcode = 'P0002';
  end if;

  -- POLITIQUE D'ÉTAT (mandat section 7) : configured/verified
  -- acceptés, not_configured refusé. is_enabled non exigé, non lu.
  if v_configuration_status not in ('configured', 'verified') then
    raise exception 'SCANYM_PAYMENT_CREDENTIAL: configuration non prête pour la lecture de credential (état actuel non éligible)' using errcode = '42501';
  end if;

  -- Défense en profondeur (mandat section 8) : garanti par la
  -- contrainte CHECK payment_provider_configs_credentials_consistency
  -- de P2A ((configuration_status = 'not_configured') = (credentials_ref
  -- is null)) -- si configuration_status est configured/verified,
  -- credentials_ref est déjà garanti NOT NULL au niveau base. Cette
  -- vérification explicite reste néanmoins posée : elle ne dépend pas
  -- silencieusement d'une contrainte externe pour rester sûre si
  -- cette dernière venait un jour à changer.
  if v_credentials_ref is null then
    raise exception 'SCANYM_PAYMENT_CREDENTIAL: credentials_ref manquant malgré un état de configuration éligible (incohérence, échec fermé)' using errcode = 'P0002';
  end if;

  -- VAULT READ (mandat section 9) : résout UNIQUEMENT cette
  -- credentials_ref précise contre vault.decrypted_secrets -- aucun
  -- balayage par nom, aucune lecture large. vault.secrets.id est clé
  -- primaire : au plus une ligne peut jamais correspondre.
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
    where id = v_credentials_ref;

  -- ORPHELIN (mandat section 10) : credentials_ref existe mais aucun
  -- secret Vault correspondant -- ÉCHEC FERMÉ BRUYANT, jamais un
  -- NULL silencieux qui se ferait passer pour "non configuré".
  -- Même identifiant d'erreur que P2A (SCANYM_CREDENTIAL_REFERENCE_INVALID)
  -- pour la même classe de défaut d'intégrité -- cohérence
  -- volontaire entre les deux lots.
  if not found or v_secret is null then
    raise exception 'SCANYM_CREDENTIAL_REFERENCE_INVALID: credentials_ref % ne correspond à aucun secret Vault existant -- incohérence de configuration, lecture refusée (échec fermé)', v_credentials_ref using errcode = 'P0002';
  end if;

  return v_secret;
end;
$$;

comment on function public.get_payment_provider_credential(uuid, text) is
  'SECURITY DEFINER, service_role UNIQUEMENT (EXECUTE only) -- PAYMENT P3-A0. Lecture serveur de confiance, SEULE, du credential déchiffré (vault.decrypted_secrets) pour un couple restaurant_id/provider_code exact. Retourne UNIQUEMENT le texte secret -- jamais credentials_ref, id, restaurant_id ni métadonnée. Exige configuration_status IN (configured, verified) -- PAS is_enabled (activation runtime distincte, hors périmètre de ce lot). Échec fermé si config absente, état non éligible, credentials_ref absent, ou référence orpheline (secret Vault manquant). Aucune écriture. N''accorde AUCUN accès direct à vault.secrets/vault.decrypted_secrets -- seul chemin de lecture applicatif.';

revoke all on function public.get_payment_provider_credential(uuid, text) from public, anon, authenticated;
grant execute on function public.get_payment_provider_credential(uuid, text) to service_role;

-- ------------------------------------------------------------
-- 3. NON-RÉGRESSION EXPLICITE (mandat section 17) : ce lot n'altère
-- AUCUN grant Vault existant. Redéclaré ici en NO-OP défensif (les
-- deux revoke ci-dessous sont déjà en vigueur depuis P2A section 5 --
-- ce lot ne fait que confirmer qu'il ne les affaiblit pas, il ne les
-- réémet pas différemment). Aucun grant direct nouveau sur
-- vault.secrets / vault.decrypted_secrets n'est ajouté par ce lot,
-- pour quelque rôle que ce soit (mandat section 2/27).
-- ------------------------------------------------------------

commit;
