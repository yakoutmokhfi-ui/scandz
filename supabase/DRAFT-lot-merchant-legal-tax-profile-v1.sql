-- ============================================================
-- Scanym — MERCHANT LEGAL & TAX PROFILE v1.1
-- WORK AUDIT REMEDIATION -- TARGETED FIX ONLY
-- DEVELOPMENT ONLY -- ce fichier ne doit être exécuté qu'après
-- validation Work/CIO, jamais directement sur Production par ce lot.
--
-- Baseline requis : c99bb22da3634bc7dae0d906fd5481b2b73898e3
-- (main, incluant Stuart Sandbox Integration v2.5 -- Stuart n'est ni
-- lu ni modifié par ce lot).
--
-- ------------------------------------------------------------
-- HISTORIQUE (mandat v1.1)
-- ------------------------------------------------------------
-- v1 (jamais poussée, jamais mergée, jamais appliquée à Production,
-- package SHA-256 921a0362f024e28fab7289bf77bd24b7be7daa4d0459e7b9eb2
-- 0bbd35e5c83a4) a été REJETÉE par l'audit Work indépendant :
--   FAIL — MERCHANT LEGAL & TAX PROFILE v1
-- Constats bloquants (HIGH) :
--   MLTP-V1-OPERATOR-READ-WRITE-01 -- un opérateur Scanym autorisé
--     pouvait ÉCRIRE receipt_settings (update_receipt_settings accepte
--     owner/manager OU opérateur) mais ne pouvait pas forcément LIRE
--     la même ligne : la policy RLS SELECT existante (V29) n'autorise
--     que les membres de restaurant_users, jamais is_scanym_operator().
--     Un opérateur sans rattachement restaurant_users pouvait donc
--     charger un formulaire vide/par défaut puis écraser un profil
--     déjà rempli. CORRIGÉ ci-dessous (section 4) : nouvelle RPC de
--     lecture dédiée, get_receipt_settings, avec la MÊME logique
--     d'autorisation élargie (membre restaurant_users -- tout rôle,
--     comme la policy RLS existante -- OU opérateur Scanym) que
--     l'écriture attend en pratique pour l'opérateur, SANS élargir la
--     policy RLS directe elle-même (mandat : "Do NOT broaden direct
--     SELECT RLS unnecessarily if a dedicated RPC is safer").
--   MLTP-V1-DASHBOARD-STALE-WRITE-01 -- app/dashboard/settings/page.tsx
--     n'avait aucune garde de séquence/appartenance pour la section
--     légale/fiscale : une réponse hors-ordre (bascule de restaurant
--     pendant un chargement en vol) pouvait laisser les champs de
--     l'ANCIEN restaurant visibles, voire enregistrables, pendant que
--     `restaurantId` pointait déjà vers un NOUVEAU restaurant.
--     CORRIGÉ dans app/dashboard/settings/page.tsx (jamais dans ce
--     fichier SQL) -- voir DASHBOARD-STALE-STATE-DESIGN.md du package
--     d'audit v1.1 pour le détail complet (séquence monotone par
--     restaurant, état ready/pas-ready dédié au profil légal/fiscal,
--     garde stricte avant tout appel à updateReceiptSettings).
--   MLTP-V1-HISTORICAL-TAX-01 -- lib/receipt.ts calculait TOUJOURS la
--     décomposition HT/TVA/TTC depuis les réglages COURANTS
--     (receipt_settings.default_tax_rate/prices_include_tax), jamais
--     figés par commande -- rendre ces réglages éditables (v1) rendait
--     ce défaut latent réellement exploitable : réimprimer une
--     ancienne commande après un changement de taux affichait une
--     décomposition fiscale FAUSSE. CORRIGÉ ci-dessous (section 5,
--     "ORDER TAX SETTINGS SNAPSHOT") + dans lib/receipt.ts -- voir
--     HISTORICAL-TAX-STRATEGY.md du package d'audit v1.1 pour
--     l'analyse complète de l'option retenue (A, déclencheur, jamais
--     une modification de create_order) et son repli explicite pour
--     les commandes antérieures à ce lot (option B, total seul, aucune
--     décomposition fabriquée).
-- Constats non-bloquants (LOW) :
--   MLTP-V1-BOOLEAN-NULL-01 -- update_receipt_settings acceptait NULL
--     pour prices_include_tax/show_tax_summary et les remplaçait
--     silencieusement par un défaut (true/false) via COALESCE --
--     aucune erreur, aucune trace, un appelant direct (hors UI, qui
--     n'envoie jamais NULL pour ces deux champs) pouvait donc altérer
--     silencieusement un réglage explicite. CORRIGÉ ci-dessous
--     (section 3) : NULL est désormais explicitement REJETÉ pour ces
--     deux champs (mandat, option "préférée").
--   MLTP-V1-TEST-COVERAGE-01 -- CORRIGÉ par l'ajout de tests
--     comportementaux réels (harnais SQL étendu ci-dessous référencé,
--     tests/lot-merchant-legal-tax-profile-v1.test.ts étendu,
--     app/dashboard/settings/page.tsx désormais couvert par un test
--     DOM réel prouvant la garde anti-réponse-hors-ordre) -- aucune
--     assertion affaiblie par `|| true` n'existait ni n'est introduite.
--
-- v1.1 corrige EXCLUSIVEMENT ces cinq constats. Le reste de
-- l'architecture v1 (receipt_settings comme modèle canonique,
-- assert_receipt_settings_role pour l'écriture, UPSERT, exclusion de
-- paper_width_mm, validation serveur des champs texte/e-mail/taux) est
-- INCHANGÉ et repris VERBATIM.
-- ------------------------------------------------------------
--
-- ANALYSE PRÉALABLE (reconnaissance SCANYM — REUSE-FIRST CODE
-- RECONNAISSANCE, feature 5) : public.receipt_settings existe déjà
-- depuis V29 avec EXACTEMENT les champs requis par ce mandat
-- (business_name, legal_name, legal_address, phone, tax_identifier,
-- registration_number, tax_label, default_tax_rate,
-- prices_include_tax, footer_text, show_tax_summary), déjà lue par
-- lib/receipt.ts pour l'impression du ticket marchand. Le SEUL gap
-- identifié : cette table est effectivement EN LECTURE SEULE pour le
-- marchand -- RLS n'accorde que SELECT à authenticated (V29 lignes
-- 249-251), aucune RPC d'écriture n'existe nulle part dans
-- supabase/*.sql (recherche exhaustive), et migration-lotd-
-- establishment-creation.sql (create_establishment, postérieur à V29)
-- n'insère JAMAIS de ligne receipt_settings pour les nouveaux
-- établissements -- un commerçant onboardé après V29 n'a donc
-- aujourd'hui AUCUNE ligne du tout, et aucun moyen d'en créer une.
--
-- CONCEPTION MINIMALE RETENUE (v1, inchangée) :
--   - Une seule colonne ADDITIVE, NULLABLE : receipt_settings.email
--     (le seul champ du mandat absent de la table V29). Aucun autre
--     champ ajouté ("Do not add fields that are not needed for this
--     lot") -- paper_width_mm (réglage imprimante, pas légal/fiscal)
--     reste hors périmètre de ce lot, ni lu ni modifié par la
--     nouvelle RPC ci-dessous, sa valeur/valeur par défaut existante
--     est intégralement préservée.
--   - assert_receipt_settings_role(uuid) -- même patron EXACT que
--     assert_restaurant_asset_role (migration-v68-establishment-
--     assets.sql) : owner/manager du restaurant_users du restaurant
--     ciblé, OU opérateur Scanym (is_scanym_operator(), F-01 Super
--     Admin, même précédent que Dashboard Settings). Aucun contrôle
--     réinventé. RÉSERVÉ À L'ÉCRITURE (voir section 4 ci-dessous pour
--     la lecture, volontairement plus large -- v1.1).
--   - update_receipt_settings(...) -- SECURITY DEFINER, search_path
--     figé, UPSERT (insert ... on conflict (restaurant_id) do update)
--     plutôt qu'un simple UPDATE : un simple UPDATE ne créerait
--     silencieusement AUCUNE ligne pour un établissement post-V29 sans
--     ligne receipt_settings existante (0 ligne affectée, échec
--     silencieux) -- l'UPSERT est le minimum nécessaire pour que
--     "merchant may update" fonctionne réellement pour TOUS les
--     établissements, historiques ET nouveaux, pas seulement ceux
--     backfillés par le insert one-shot de V29. paper_width_mm est
--     volontairement ABSENT de la liste de colonnes insert/update :
--     une ligne nouvellement créée par cet UPSERT reçoit donc le
--     DEFAULT existant de la colonne (58), une ligne existante garde
--     sa valeur actuelle intacte -- dans les deux cas, cette RPC ne
--     touche jamais ce réglage.
--
-- CE QUE CE LOT NE FAIT PAS (mandat v1, sections TAX RATE SAFETY / NO
-- PROFESSIONAL CUSTOMER BILLING YET -- toujours vrai en v1.1) :
--   - Ne rend PAS menu_items.tax_rate autoritaire pour un quelconque
--     calcul. Ne modifie NI ne relit lib/receipt.ts pour son calcul
--     HT/TVA/TTC EN DEHORS de la correction historique strictement
--     scopée ci-dessous (section 5) -- toujours le taux plat
--     receipt_settings.default_tax_rate (désormais figé PAR COMMANDE
--     via l'instantané, jamais menu_items.tax_rate). Ne réconcilie pas
--     taux plat vs taux par produit (lot séparé, futur, toujours
--     documenté comme gap dans DRAFT-lot-receipt-invoice-tax-detail-
--     v1.sql). Ne modifie ni order_items, ni le montant d'aucune
--     commande (subtotal/total/delivery_fee), ni aucun montant de
--     paiement. Ne modifie PAS create_order (signature, corps ou
--     contrat de retour) -- voir section 5 pour le mécanisme retenu
--     (déclencheur BEFORE INSERT, jamais une modification de la
--     fonction elle-même).
--   - N'implémente PAS l'étape "Besoin d'une facture professionnelle ?"
--     du client (aucun champ société/TVA/adresse de facturation
--     CLIENT, aucune RPC order_billing_context touchée). Ce lot ne
--     concerne QUE le profil légal/fiscal du MARCHAND lui-même
--     (receipt_settings), jamais celui du client -- les deux identités
--     restent strictement distinctes.
--   - Aucune génération de PDF, aucune numérotation de facture légale.
--   - Aucune modification de Stuart, Monetico, du runtime de paiement,
--     du checkout client, du pricing de commande, de la livraison, du
--     tracking, de l'import catalogue, des tags/collections, ou de
--     l'analytics.
--
-- COUNTRY-AWARE DESIGN (mandat) : la donnée stockée reste
-- volontairement GÉNÉRIQUE (tax_identifier, registration_number) --
-- aucune colonne "scheme"/"siret_or_bce" n'est ajoutée ici, aucun
-- moteur de juridiction. Le mapping pays -> intitulé de champ
-- (SIREN/SIRET pour FR, BCE pour BE, générique sinon) est une pure
-- fonction TypeScript, lib/merchant-legal-tax-labels.ts (voir ce
-- fichier), qui lit restaurants.country (Lot D, déjà existant, déjà
-- FK'd contre scanym_supported_countries) -- aucune nouvelle colonne
-- SQL nécessaire pour cette fonctionnalité.
-- ============================================================

begin;

-- ------------------------------------------------------------------
-- 0. CONTRÔLE PRÉALABLE DE NON-DÉRIVE DU SCHÉMA — réellement exécuté,
--    jamais un commentaire décoratif.
-- ------------------------------------------------------------------
do $$
begin
  -- 0a. La table doit déjà exister (V29), ce lot ne la crée jamais.
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'receipt_settings'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: public.receipt_settings introuvable -- chaîne de migrations incomplète (V29 non appliquée ?), MERCHANT LEGAL & TAX PROFILE v1.1 annulé.';
  end if;

  -- 0b. La colonne email ne doit pas déjà exister (pas de doublon).
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'receipt_settings' and column_name = 'email'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: receipt_settings.email existe déjà -- MERCHANT LEGAL & TAX PROFILE v1.1 déjà appliqué ou conflit, annulé.';
  end if;

  -- 0c. Les nouvelles RPC ne doivent pas déjà exister.
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'assert_receipt_settings_role', 'update_receipt_settings',
        'assert_receipt_settings_read_access', 'get_receipt_settings',
        'snapshot_receipt_tax_settings'
      )
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: au moins une fonction MERCHANT LEGAL & TAX PROFILE v1/v1.1 existe déjà -- déjà appliqué ou conflit, annulé.';
  end if;

  -- 0d. Prérequis Lot D (is_scanym_operator, restaurants.country) :
  --     assert_receipt_settings_role/assert_receipt_settings_read_access
  --     en dépendent directement (même patron que
  --     assert_restaurant_asset_role).
  if to_regprocedure('public.is_scanym_operator()') is null then
    raise exception
      'SCANYM_SCHEMA_DRIFT: public.is_scanym_operator() introuvable -- migration-lotd-establishment-creation.sql non appliquée, MERCHANT LEGAL & TAX PROFILE v1.1 annulé.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurants' and column_name = 'country'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: restaurants.country introuvable -- migration-lotd-establishment-creation.sql non appliquée, MERCHANT LEGAL & TAX PROFILE v1.1 annulé.';
  end if;

  -- 0e. v1.1 -- garde anti-double-application pour l'instantané fiscal
  --     de commande (section 5) : aucune des 4 nouvelles colonnes ne
  --     doit déjà exister sur orders, et public.orders doit déjà
  --     exister (migration-orders.sql).
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'orders'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: public.orders introuvable -- migration-orders.sql non appliquée, MERCHANT LEGAL & TAX PROFILE v1.1 annulé.';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in (
        'tax_settings_snapshot_default_tax_rate',
        'tax_settings_snapshot_prices_include_tax',
        'tax_settings_snapshot_tax_label',
        'tax_settings_snapshot_show_tax_summary'
      )
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: au moins une colonne d''instantané fiscal existe déjà sur orders -- MERCHANT LEGAL & TAX PROFILE v1.1 déjà appliqué ou conflit, annulé.';
  end if;
end $$;

-- ------------------------------------------------------------------
-- 1. receipt_settings.email — colonne ADDITIVE, NULLABLE. Seul champ
--    du mandat absent de la table V29 (v1, inchangé).
-- ------------------------------------------------------------------
alter table public.receipt_settings
  add column if not exists email text;

comment on column public.receipt_settings.email is
  'Adresse e-mail de contact légal/fiscal du marchand (profil receipt_settings). '
  'Ajoutée par MERCHANT LEGAL & TAX PROFILE v1 -- absente de V29. '
  'Non affichée sur le ticket imprimé (lib/receipt.ts) tant qu''un besoin explicite '
  'et des tests dédiés ne le justifient pas (mandat, section RECEIPT INTEGRATION).';

-- ------------------------------------------------------------------
-- 2. assert_receipt_settings_role -- ÉCRITURE UNIQUEMENT (v1,
--    inchangé) -- même patron EXACT que assert_restaurant_asset_role
--    (migration-v68-establishment-assets.sql) : owner/manager du
--    restaurant ciblé, OU opérateur Scanym. Aucun contrôle réinventé.
--    "revoke all ... from public" sans grant à authenticated :
--    utilitaire interne, jamais un point d'entrée RPC direct (appelé
--    uniquement depuis update_receipt_settings, SECURITY DEFINER donc
--    exécuté avec les privilèges du propriétaire de la fonction).
-- ------------------------------------------------------------------
create function public.assert_receipt_settings_role(p_restaurant_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  if exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = p_restaurant_id
      and ru.role = any (array['owner','manager'])
  ) then
    return;
  end if;

  if public.is_scanym_operator() then
    return;
  end if;

  raise exception using errcode = '42501',
    message = 'Not authorized for this restaurant';
end $$;

revoke all on function public.assert_receipt_settings_role(uuid) from public;

-- ------------------------------------------------------------------
-- 2b. assert_receipt_settings_read_access -- v1.1, NOUVEAU. Ferme
--     MLTP-V1-OPERATOR-READ-WRITE-01. LECTURE UNIQUEMENT -- délibéré-
--     ment PLUS LARGE que assert_receipt_settings_role (écriture) :
--     autorise TOUT membre de restaurant_users (owner/manager/staff --
--     exactement la policy RLS SELECT existante depuis V29, jamais
--     élargie ici, voir section 4) OU un opérateur Scanym (le rôle
--     manquant côté lecture avant v1.1). Utilitaire interne, jamais un
--     point d'entrée RPC direct.
--
--     Pourquoi la lecture reste plus large que l'écriture (mandat :
--     "Align read and write capabilities safely") : lib/receipt.ts
--     (impression du ticket, app/dashboard/page.tsx) lit déjà
--     receipt_settings pour N'IMPORTE QUEL membre du restaurant, y
--     compris staff -- restreindre la lecture à owner/manager/
--     opérateur seuls régresserait l'impression de ticket pour tout
--     employé staff, une fonctionnalité de CE lot ne doit jamais
--     casser. Élargir SEULEMENT l'écriture (déjà fait en v1) sans
--     élargir la lecture en conséquence est exactement le défaut
--     MLTP-V1-OPERATOR-READ-WRITE-01 -- cette fonction aligne les deux
--     sur le MÊME ensemble d'appelants autorisés à consulter le profil
--     (tout membre OU opérateur), tandis que l'ÉCRITURE reste
--     strictement limitée à owner/manager/opérateur (assert_receipt_
--     settings_role, section 2, inchangée) -- un staff peut lire, ne
--     peut toujours pas écrire.
-- ------------------------------------------------------------------
create function public.assert_receipt_settings_read_access(p_restaurant_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  if exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = p_restaurant_id
  ) then
    return;
  end if;

  if public.is_scanym_operator() then
    return;
  end if;

  raise exception using errcode = '42501',
    message = 'Not authorized for this restaurant';
end $$;

revoke all on function public.assert_receipt_settings_read_access(uuid) from public;

-- ------------------------------------------------------------------
-- 3. update_receipt_settings -- écriture complète du profil
--    légal/fiscal marchand, réservée owner/manager ou opérateur
--    Scanym (via assert_receipt_settings_role ci-dessus). UPSERT
--    (jamais un simple UPDATE) : un établissement créé après V29 n'a
--    aujourd'hui AUCUNE ligne receipt_settings (create_establishment,
--    Lot D, n'en insère jamais) -- un UPDATE seul échouerait
--    silencieusement (0 ligne affectée) pour tout établissement
--    onboardé depuis. paper_width_mm N'APPARAÎT JAMAIS dans la liste
--    de colonnes ci-dessous (ni insert ni update) : une ligne
--    nouvellement créée reçoit son DEFAULT existant (58), une ligne
--    déjà présente garde sa valeur strictement inchangée.
--
--    Chaîne vide ("") normalisée en NULL pour chaque champ texte
--    optionnel, même convention que le reste du dépôt. tax_label
--    reste NOT NULL (contrainte de table V29 inchangée) : une valeur
--    vide/blanche est rejetée explicitement plutôt que de tenter
--    d'insérer NULL dans une colonne NOT NULL.
--
--    v1.1 -- ferme MLTP-V1-BOOLEAN-NULL-01 : p_prices_include_tax et
--    p_show_tax_summary sont désormais des réglages booléens EXPLICITES
--    obligatoires -- NULL est REJETÉ (option "préférée" du mandat),
--    jamais silencieusement remplacé par un défaut via COALESCE (v1
--    faisait `coalesce(p_prices_include_tax, true)` /
--    `coalesce(p_show_tax_summary, false)` -- supprimé). Un appelant
--    UI légitime (app/dashboard/settings/page.tsx) envoie TOUJOURS un
--    booléen concret pour ces deux champs (état de case à cocher, ne
--    peut structurellement pas être NULL côté TypeScript) -- ce
--    changement ne modifie donc AUCUN comportement observable pour
--    l'UI existante, il ferme uniquement la voie silencieuse pour un
--    appelant RPC direct hors UI.
-- ------------------------------------------------------------------
create function public.update_receipt_settings(
  p_restaurant_id       uuid,
  p_business_name       text,
  p_legal_name          text,
  p_legal_address       text,
  p_phone               text,
  p_email               text,
  p_tax_identifier      text,
  p_registration_number text,
  p_tax_label           text,
  p_default_tax_rate    numeric,
  p_prices_include_tax  boolean,
  p_footer_text         text,
  p_show_tax_summary    boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business_name       text;
  v_legal_name          text;
  v_legal_address       text;
  v_phone               text;
  v_email               text;
  v_tax_identifier      text;
  v_registration_number text;
  v_tax_label           text;
  v_footer_text         text;
begin
  perform public.assert_receipt_settings_role(p_restaurant_id);

  v_business_name       := nullif(btrim(coalesce(p_business_name, '')), '');
  v_legal_name          := nullif(btrim(coalesce(p_legal_name, '')), '');
  v_legal_address       := nullif(btrim(coalesce(p_legal_address, '')), '');
  v_phone               := nullif(btrim(coalesce(p_phone, '')), '');
  v_email               := nullif(btrim(coalesce(p_email, '')), '');
  v_tax_identifier      := nullif(btrim(coalesce(p_tax_identifier, '')), '');
  v_registration_number := nullif(btrim(coalesce(p_registration_number, '')), '');
  v_tax_label           := nullif(btrim(coalesce(p_tax_label, '')), '');
  v_footer_text         := nullif(btrim(coalesce(p_footer_text, '')), '');

  if v_tax_label is null then
    raise exception using errcode = '22023', message = 'Tax label is required';
  end if;

  if length(coalesce(v_business_name, '')) > 255
     or length(coalesce(v_legal_name, '')) > 255
     or length(coalesce(v_tax_label, '')) > 40
  then
    raise exception using errcode = '22023', message = 'Field too long';
  end if;
  if length(coalesce(v_legal_address, '')) > 500
     or length(coalesce(v_footer_text, '')) > 1000
  then
    raise exception using errcode = '22023', message = 'Field too long';
  end if;
  if length(coalesce(v_phone, '')) > 50
     or length(coalesce(v_tax_identifier, '')) > 100
     or length(coalesce(v_registration_number, '')) > 100
  then
    raise exception using errcode = '22023', message = 'Field too long';
  end if;
  if v_email is not null then
    if length(v_email) > 255 then
      raise exception using errcode = '22023', message = 'Field too long';
    end if;
    if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      raise exception using errcode = '22023', message = 'Invalid email';
    end if;
  end if;

  if p_default_tax_rate is null or p_default_tax_rate < 0 or p_default_tax_rate > 100 then
    raise exception using errcode = '22023', message = 'Invalid tax rate';
  end if;

  -- v1.1 -- MLTP-V1-BOOLEAN-NULL-01 : rejet explicite de NULL, jamais
  -- de défaut silencieux (voir en-tête de section pour le contexte).
  if p_prices_include_tax is null then
    raise exception using errcode = '22023', message = 'prices_include_tax is required (must be true or false, not null)';
  end if;
  if p_show_tax_summary is null then
    raise exception using errcode = '22023', message = 'show_tax_summary is required (must be true or false, not null)';
  end if;

  insert into public.receipt_settings (
    restaurant_id, business_name, legal_name, legal_address, phone, email,
    tax_identifier, registration_number, tax_label, default_tax_rate,
    prices_include_tax, footer_text, show_tax_summary
  ) values (
    p_restaurant_id, v_business_name, v_legal_name, v_legal_address, v_phone, v_email,
    v_tax_identifier, v_registration_number, v_tax_label, p_default_tax_rate,
    p_prices_include_tax, v_footer_text, p_show_tax_summary
  )
  on conflict (restaurant_id) do update set
    business_name        = excluded.business_name,
    legal_name            = excluded.legal_name,
    legal_address         = excluded.legal_address,
    phone                 = excluded.phone,
    email                 = excluded.email,
    tax_identifier        = excluded.tax_identifier,
    registration_number   = excluded.registration_number,
    tax_label             = excluded.tax_label,
    default_tax_rate      = excluded.default_tax_rate,
    prices_include_tax    = excluded.prices_include_tax,
    footer_text           = excluded.footer_text,
    show_tax_summary      = excluded.show_tax_summary,
    updated_at            = now();
end $$;

revoke all on function public.update_receipt_settings(
  uuid, text, text, text, text, text, text, text, text, numeric, boolean, text, boolean
) from public, anon;
grant execute on function public.update_receipt_settings(
  uuid, text, text, text, text, text, text, text, text, numeric, boolean, text, boolean
) to authenticated;

-- ------------------------------------------------------------------
-- 4. get_receipt_settings -- v1.1, NOUVEAU. Ferme
--    MLTP-V1-OPERATOR-READ-WRITE-01. RPC de LECTURE dédiée,
--    SECURITY DEFINER, search_path figé, symétrique de
--    update_receipt_settings au sens où elle couvre le MÊME besoin
--    (lire son propre profil, ou celui d'un établissement administré
--    en tant qu'opérateur) que l'écriture couvrait déjà seule depuis
--    v1.
--
--    Contrat explicite (mandat) :
--      - retourne UNIQUEMENT la ligne du restaurant CIBLÉ (jamais
--        d'autre restaurant -- p_restaurant_id est le seul filtre,
--        aucun paramètre ne permet d'en lire un autre) ;
--      - inclut restaurants.country (nécessaire à l'intitulé de champ
--        présenté, lib/merchant-legal-tax-labels.ts) ;
--      - distingue clairement "aucune ligne" de "erreur" : un appelant
--        AUTORISÉ mais pour un restaurant SANS ligne receipt_settings
--        (onboardé après V29) reçoit un ENSEMBLE VIDE (0 ligne, AUCUNE
--        exception) -- alors qu'un appelant NON autorisé reçoit une
--        EXCEPTION (42501/28000). Côté client (supabase-js), ceci se
--        traduit en { data: [], error: null } (aucune ligne, PAS une
--        erreur) vs { data: null, error: {...} } (échec réel) -- une
--        distinction déjà exploitable par lib/services/dashboard.ts
--        SANS aucun champ de statut supplémentaire à inventer ;
--      - RETURNS TABLE (jamais SELECT *) : la forme exacte est
--        explicite et stable, indépendante de l'ordre des colonnes de
--        receipt_settings.
-- ------------------------------------------------------------------
create function public.get_receipt_settings(p_restaurant_id uuid)
returns table (
  business_name       text,
  legal_name          text,
  legal_address       text,
  phone               text,
  email               text,
  tax_identifier      text,
  registration_number text,
  tax_label           text,
  default_tax_rate    numeric,
  prices_include_tax  boolean,
  footer_text         text,
  show_tax_summary    boolean,
  paper_width_mm      integer,
  restaurant_country  text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_receipt_settings_read_access(p_restaurant_id);

  return query
  select
    rs.business_name, rs.legal_name, rs.legal_address, rs.phone, rs.email,
    rs.tax_identifier, rs.registration_number, rs.tax_label, rs.default_tax_rate,
    rs.prices_include_tax, rs.footer_text, rs.show_tax_summary, rs.paper_width_mm,
    r.country
  from public.receipt_settings rs
  join public.restaurants r on r.id = rs.restaurant_id
  where rs.restaurant_id = p_restaurant_id;
end $$;

revoke all on function public.get_receipt_settings(uuid) from public, anon;
grant execute on function public.get_receipt_settings(uuid) to authenticated;

-- ------------------------------------------------------------------
-- 5. ORDER TAX SETTINGS SNAPSHOT -- v1.1, NOUVEAU. Ferme
--    MLTP-V1-HISTORICAL-TAX-01.
--
--    STRATÉGIE RETENUE (voir HISTORICAL-TAX-STRATEGY.md du package
--    d'audit v1.1 pour l'analyse complète) : OPTION A (instantané
--    immuable) rendue possible SANS "broad redesign" et SANS toucher
--    à create_order, via un DÉCLENCHEUR BEFORE INSERT sur
--    public.orders -- jamais une modification du corps, de la
--    signature ou du contrat de retour de create_order (mandat :
--    "Must preserve... unless a compelling reason exists" -- aucune
--    raison ici, le déclencheur suffit et est structurellement plus
--    sûr qu'une modification de create_order lui-même).
--
--    Pourquoi PAS une réutilisation de order_items.tax_rate_snapshot
--    (DRAFT-lot-receipt-invoice-tax-detail-v1.sql, déjà présent dans
--    ce dépôt, inspecté indépendamment avant d'écarter sa réutilisation
--    -- mandat : "independently inspect it before reuse... Do not
--    blindly apply an old DRAFT") : ce fichier documente lui-même,
--    explicitement, qu'il snapshote UNIQUEMENT menu_items.tax_rate par
--    LIGNE de commande, en PURE MÉTADONNÉE ("ce lot NE calcule JAMAIS
--    de montant de taxe... la sémantique d'inclusion de taxe n'est pas
--    explicite dans le modèle actuel -- ARCHITECTURE GAP"). La
--    décomposition HT/TVA/TTC affichée par lib/receipt.ts (le sujet
--    RÉEL de MLTP-V1-HISTORICAL-TAX-01) ne lit PAS menu_items.tax_rate
--    -- elle lit le taux PLAT par restaurant, receipt_settings.
--    default_tax_rate, ainsi que prices_include_tax/tax_label/
--    show_tax_summary, qu'AUCUNE colonne existante (order_items ou
--    orders) ne snapshote nulle part dans ce dépôt avant v1.1.
--    Réutiliser tax_rate_snapshot ne fermerait donc PAS ce constat --
--    ce lot introduit son propre instantané, ciblé EXACTEMENT sur les
--    4 champs receipt_settings que lib/receipt.ts utilise pour ce
--    calcul, sans dupliquer ni contredire le travail existant de
--    RECEIPT / INVOICE TAX DETAIL v1.1 (non appliqué par ce fichier,
--    hors périmètre de ce lot).
--
--    4 colonnes ADDITIVES, NULLABLES sur orders (jamais order_items,
--    jamais menu_items) :
--      - tax_settings_snapshot_default_tax_rate  numeric(5,2)
--      - tax_settings_snapshot_prices_include_tax boolean
--      - tax_settings_snapshot_tax_label          text
--      - tax_settings_snapshot_show_tax_summary   boolean
--    NULL = commande antérieure à ce lot (ALTER TABLE ADD COLUMN sans
--    DEFAULT) OU restaurant sans AUCUNE ligne receipt_settings au
--    moment de la commande -- dans les deux cas, "LEGACY ORDER --
--    FISCAL SNAPSHOT UNAVAILABLE" (même convention que
--    weight_is_approximate_snapshot dans RECEIPT / INVOICE TAX DETAIL
--    v1.1), jamais une valeur fabriquée. lib/receipt.ts (modifié
--    séparément, hors de ce fichier SQL) traite ce cas en SUPPRIMANT
--    la décomposition HT/TVA/TTC et en n'affichant QUE le total
--    autoritaire de la commande (option B du mandat, repli explicite
--    et documenté -- "This fallback is acceptable for safety because
--    it prevents false retroactive tax figures").
--
--    Aucune colonne n'affecte jamais subtotal/total/delivery_fee/
--    currency -- ce sont des colonnes fiscales/d'affichage PURES,
--    jamais lues par un calcul de montant financier.
--
--    Le déclencheur (snapshot_receipt_tax_settings) s'exécute pour
--    TOUT INSERT sur orders, quel que soit le chemin d'insertion
--    (create_order aujourd'hui, ou tout futur chemin) -- SECURITY
--    DEFINER + search_path figé pour lire receipt_settings de façon
--    fiable indépendamment du rôle appelant (create_order est
--    exécutable par `anon` -- un client peut commander sans compte --
--    donc ce déclencheur ne peut PAS dépendre de auth.uid()).
--    N'accepte aucune entrée utilisateur au-delà de NEW.restaurant_id,
--    déjà validé par la contrainte FK de la table elle-même.
-- ------------------------------------------------------------------
alter table public.orders
  add column tax_settings_snapshot_default_tax_rate  numeric(5,2),
  add column tax_settings_snapshot_prices_include_tax boolean,
  add column tax_settings_snapshot_tax_label          text,
  add column tax_settings_snapshot_show_tax_summary    boolean;

comment on column public.orders.tax_settings_snapshot_default_tax_rate is
  'MERCHANT LEGAL & TAX PROFILE v1.1 -- copie FIGÉE de receipt_settings.default_tax_rate au moment de l''INSERT (déclencheur BEFORE INSERT, jamais relue ensuite). NULL = commande antérieure à ce lot, ou restaurant sans aucune ligne receipt_settings à cet instant ("LEGACY ORDER -- FISCAL SNAPSHOT UNAVAILABLE"). Ferme MLTP-V1-HISTORICAL-TAX-01 -- lib/receipt.ts n''utilise JAMAIS receipt_settings.default_tax_rate COURANT pour reconstruire la décomposition HT/TVA/TTC d''une commande déjà passée.';
comment on column public.orders.tax_settings_snapshot_prices_include_tax is
  'MERCHANT LEGAL & TAX PROFILE v1.1 -- copie FIGÉE de receipt_settings.prices_include_tax au moment de l''INSERT. NULL = pas d''instantané disponible (voir tax_settings_snapshot_default_tax_rate) -- sert aussi de marqueur de complétude de l''instantané.';
comment on column public.orders.tax_settings_snapshot_tax_label is
  'MERCHANT LEGAL & TAX PROFILE v1.1 -- copie FIGÉE de receipt_settings.tax_label au moment de l''INSERT (ex. "TVA"), pour que le libellé affiché à côté du taux figé reste cohérent avec CE taux, même si le marchand renomme son libellé de taxe ensuite. NULL = pas d''instantané disponible.';
comment on column public.orders.tax_settings_snapshot_show_tax_summary is
  'MERCHANT LEGAL & TAX PROFILE v1.1 -- copie FIGÉE de receipt_settings.show_tax_summary au moment de l''INSERT. NULL = pas d''instantané disponible -- dans ce cas, lib/receipt.ts n''affiche JAMAIS de décomposition HT/TVA/TTC (repli sûr, total seul).';

create function public.snapshot_receipt_tax_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select rs.default_tax_rate, rs.prices_include_tax, rs.tax_label, rs.show_tax_summary
  into
    new.tax_settings_snapshot_default_tax_rate,
    new.tax_settings_snapshot_prices_include_tax,
    new.tax_settings_snapshot_tax_label,
    new.tax_settings_snapshot_show_tax_summary
  from public.receipt_settings rs
  where rs.restaurant_id = new.restaurant_id;

  return new;
end $$;

drop trigger if exists trg_snapshot_receipt_tax_settings on public.orders;
create trigger trg_snapshot_receipt_tax_settings
  before insert on public.orders
  for each row execute function public.snapshot_receipt_tax_settings();

revoke all on function public.snapshot_receipt_tax_settings() from public, anon, authenticated;

-- ------------------------------------------------------------------
-- 6. CONTRÔLE POST-COMMIT — réellement exécuté.
-- ------------------------------------------------------------------
do $$
declare
  v_count integer;
begin
  -- Droits : jamais anon/public en EXECUTE sur les RPC d'écriture/
  -- lecture, jamais anon en écriture directe sur receipt_settings.
  if has_function_privilege('anon', 'public.update_receipt_settings(uuid, text, text, text, text, text, text, text, text, numeric, boolean, text, boolean)', 'EXECUTE')
  then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: anon a EXECUTE sur update_receipt_settings, jamais attendu.';
  end if;

  if not has_function_privilege('authenticated', 'public.update_receipt_settings(uuid, text, text, text, text, text, text, text, text, numeric, boolean, text, boolean)', 'EXECUTE')
  then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated n''a pas EXECUTE sur update_receipt_settings.';
  end if;

  if has_function_privilege('anon', 'public.get_receipt_settings(uuid)', 'EXECUTE')
  then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: anon a EXECUTE sur get_receipt_settings, jamais attendu.';
  end if;

  if not has_function_privilege('authenticated', 'public.get_receipt_settings(uuid)', 'EXECUTE')
  then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: authenticated n''a pas EXECUTE sur get_receipt_settings.';
  end if;

  if has_table_privilege('anon', 'public.receipt_settings', 'INSERT')
     or has_table_privilege('anon', 'public.receipt_settings', 'UPDATE')
     or has_table_privilege('anon', 'public.receipt_settings', 'DELETE')
     or has_table_privilege('authenticated', 'public.receipt_settings', 'INSERT')
     or has_table_privilege('authenticated', 'public.receipt_settings', 'UPDATE')
     or has_table_privilege('authenticated', 'public.receipt_settings', 'DELETE')
  then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: receipt_settings a un droit d''écriture direct pour anon/authenticated, jamais attendu (écriture exclusivement via RPC).';
  end if;

  -- RLS toujours active sur receipt_settings (jamais élargie/désactivée
  -- par v1.1 -- voir section 2b : la lecture élargie passe par une RPC
  -- dédiée, jamais par la policy RLS elle-même).
  select count(*) into v_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'receipt_settings' and c.relrowsecurity = true;
  if v_count <> 1 then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: RLS non active sur receipt_settings.';
  end if;

  -- La colonne email existe bien, nullable.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'receipt_settings'
      and column_name = 'email' and is_nullable = 'YES'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: receipt_settings.email absente ou non-nullable.';
  end if;

  -- v1.1 -- les 4 colonnes d'instantané fiscal existent, nullables, et
  -- n'affectent jamais subtotal/total/delivery_fee/currency (colonnes
  -- non touchées par cette migration -- vérifié par leur simple
  -- absence de la liste ci-dessous, jamais altérées).
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name = 'tax_settings_snapshot_default_tax_rate' and is_nullable = 'YES'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name = 'tax_settings_snapshot_prices_include_tax' and is_nullable = 'YES'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name = 'tax_settings_snapshot_tax_label' and is_nullable = 'YES'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name = 'tax_settings_snapshot_show_tax_summary' and is_nullable = 'YES'
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: au moins une colonne d''instantané fiscal absente ou non-nullable sur orders.';
  end if;

  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'orders'
      and t.tgname = 'trg_snapshot_receipt_tax_settings' and not t.tgisinternal
  ) then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: déclencheur trg_snapshot_receipt_tax_settings absent sur orders.';
  end if;

  -- v1.1 -- create_order n'a JAMAIS été touché par ce fichier (aucun
  -- CREATE OR REPLACE FUNCTION public.create_order ci-dessus) --
  -- vérifié positivement : sa signature actuelle (quelle qu'elle soit)
  -- doit toujours exister, inchangée par construction (ce fichier ne
  -- contient aucune instruction qui pourrait la modifier).
  if to_regprocedure('public.create_order(text, text, jsonb, integer, jsonb, text, text)') is null
     and to_regprocedure('public.create_order(text, text, jsonb, integer, jsonb, text)') is null
  then
    raise exception 'SCANYM_POST_COMMIT_CHECK_FAILED: aucune signature connue de create_order n''existe après cette migration -- régression inattendue.';
  end if;
end $$;

commit;

-- ============================================================
-- Résumé des changements par rapport au baseline c99bb22d :
--   + receipt_settings.email (nullable, additive -- v1).
--   + RPC assert_receipt_settings_role (écriture, v1) / RPC
--     assert_receipt_settings_read_access (lecture, v1.1, ferme
--     MLTP-V1-OPERATOR-READ-WRITE-01) -- utilitaires internes.
--   + RPC update_receipt_settings (SECURITY DEFINER, search_path
--     figé, UPSERT sur restaurant_id, v1 ; v1.1 : NULL désormais
--     rejeté pour prices_include_tax/show_tax_summary, ferme
--     MLTP-V1-BOOLEAN-NULL-01).
--   + RPC get_receipt_settings (SECURITY DEFINER, search_path figé,
--     v1.1, NOUVEAU -- ferme MLTP-V1-OPERATOR-READ-WRITE-01).
--   + orders.tax_settings_snapshot_default_tax_rate/
--     _prices_include_tax/_tax_label/_show_tax_summary (nullables,
--     additives, v1.1) + déclencheur BEFORE INSERT
--     snapshot_receipt_tax_settings -- ferme MLTP-V1-HISTORICAL-TAX-01.
--     AUCUNE modification de create_order (signature/corps/contrat de
--     retour), AUCUNE modification de order_items/menu_items, AUCUNE
--     modification de subtotal/total/delivery_fee/currency.
--   Aucune colonne supprimée/renommée. paper_width_mm intégralement
--   préservé (jamais lu ni écrit par aucune RPC de ce lot). Aucune
--   modification de payment_*/Stuart/Monetico/tracking/menu_categories/
--   menu_items/subcategories/sale_modes/delivery/fulfillment.
-- ============================================================
