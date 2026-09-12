-- ============================================================
-- Scanym — CLAUDE MONET
-- CATALOGUE VAT COMPLETENESS GUARD v1 -> v1.1
-- PHASE 1 — SQL FOUNDATION
--
-- CTO/CIO SQL GO. Baseline autorisé : main
-- 5649aeaf162136de05e65c66335e0bc4899ad59e (tree
-- e72cde6f5182a9a9ffced90d893eefd21e4db6b3), vérifié inchangé au
-- moment de l'écriture de ce fichier.
--
-- HISTORIQUE — v1 (jamais installée) introduisait
-- update_product/set_product_availability avec un
-- `exception when check_violation then raise exception
-- 'SCANYM_TAX_RATE_REQUIRED_FOR_AVAILABILITY' ...` INCONDITIONNEL.
-- Audit indépendant Cat Stevens (v1.1, BLOQUANT, BLOCKER COUNT 1) :
-- menu_items porte AU MOINS 5 contraintes CHECK réelles
-- (menu_items_description_length_chk, menu_items_short_description_
-- length_chk, menu_items_tax_rate_range_chk,
-- menu_items_unit_weight_grams_chk,
-- menu_items_availability_requires_tax_rate_chk) -- un
-- `exception when check_violation` inconditionnel capture les 5,
-- N'IMPORTE LAQUELLE des 4 autres serait donc INCORRECTEMENT
-- traduite en SCANYM_TAX_RATE_REQUIRED_FOR_AVAILABILITY, un message
-- trompeur. v1.1 CORRIGE ce point PRÉCIS : le corps des 2 fonctions
-- est réécrit SUR PLACE (même convention que OB-4 v1.1 -> v1.2,
-- "correctif de blocage, PAS une réécriture" -- tout le reste de ce
-- fichier -- préflight, contrainte, create_product -- reste À
-- L'IDENTIQUE, ligne pour ligne, non reproduit ci-dessous par souci
-- de clarté du diff). SEUL changement : le gestionnaire
-- `exception when check_violation` de update_product et
-- set_product_availability récupère désormais le VRAI nom de la
-- contrainte violée (`get stacked diagnostics ... = constraint_name`)
-- et ne traduit QUE si ce nom est EXACTEMENT
-- menu_items_availability_requires_tax_rate_chk -- toute autre
-- violation CHECK est RE-LEVÉE TELLE QUELLE (`raise;`, sémantique
-- Postgres d'origine préservée à l'identique, EXACTEMENT le
-- comportement d'avant l'existence de ce lot pour ces 4 autres
-- contraintes). Invariant métier, prédicat de la contrainte, logique
-- de préflight, comportement create_product/import/UI :
-- STRICTEMENT INCHANGÉS.
--
-- INVARIANT MÉTIER (Phase 0 + Targeted Closure + Final Design
-- Closure, tous acceptés) :
--   IF menu_items.is_available = true THEN menu_items.tax_rate IS NOT NULL
--   (0 reste valide ; NULL n'est permis QUE pour un produit indisponible)
--
-- RÈGLES EXPLICITES (CTO) :
--   - AUCUN taux de TVA par défaut n'est jamais inventé.
--   - AUCUNE substitution silencieuse.
--   - AUCUNE désactivation silencieuse d'un produit existant.
--   - LOT C (compute_delivery_fee_tax_allocation, order_items.
--     tax_rate_snapshot) n'est PAS touché par ce fichier -- domaine
--     entièrement différent (order_items, pas menu_items), déjà
--     vérifié en Phase 0.
--
-- PÉRIMÈTRE AUTORISÉ, strictement :
--   1. Préflight Production fail-closed (lecture seule) AVANT toute
--      contrainte -- même patron EXACT que SCANYM_PRODUCT_UNIQUENESS_
--      PREFLIGHT_FAILED (OB-4 v1.2, DRAFT-lot-catalogue-import-
--      commit-idempotency-v1-1.sql).
--   2. Une contrainte CHECK unique sur public.menu_items, seule
--      autorité de l'invariant (mandat "Final Design Closure" §E) --
--      NOT VALID puis VALIDATE CONSTRAINT DANS LA MÊME transaction/
--      fichier (jamais un état NOT VALID durable, mandat explicite
--      §G).
--   3. create_product -- CREATE OR REPLACE, signature INCHANGÉE.
--      SEUL changement : is_available n'est plus laissé au défaut de
--      colonne (true) -- calculé explicitement à l'INSERT à partir de
--      la présence de p_tax_rate, pour que la ligne insérée SATISFASSE
--      TOUJOURS l'invariant PAR CONSTRUCTION (la création avec TVA
--      absente doit RÉUSSIR, produit indisponible -- Layer A, jamais
--      un rejet).
--   4. update_product -- CREATE OR REPLACE, signature INCHANGÉE.
--      SEUL changement : l'UPDATE est enveloppé dans un bloc begin/
--      exception qui traduit une violation RÉELLE de la contrainte
--      CHECK (23514, check_violation -- jamais un code inventé, même
--      discipline exacte que create_product/unique_violation) en une
--      erreur applicative stable SCANYM_TAX_RATE_REQUIRED_FOR_
--      AVAILABILITY -- SEULEMENT quand le nom de la contrainte
--      RÉELLEMENT violée (GET STACKED DIAGNOSTICS ... =
--      CONSTRAINT_NAME, v1.1, audit Cat Stevens) est EXACTEMENT
--      menu_items_availability_requires_tax_rate_chk ; toute autre
--      contrainte CHECK sur menu_items (description/short_description/
--      tax_rate range/unit_weight_grams, actuelle ou future) est
--      RE-LEVÉE TELLE QUELLE (`raise;`), sémantique Postgres d'origine
--      intacte. Le prédicat métier lui-même N'EST PAS dupliqué ici :
--      la contrainte de la section 2 est la seule autorité (un produit
--      disponible dont on efface la TVA est ainsi REJETÉ, jamais
--      silencieusement désactivé -- exactement le comportement requis).
--   5. set_product_availability -- CREATE OR REPLACE, signature
--      INCHANGÉE. Même patron EXACT que update_product ci-dessus,
--      MÊME routage spécifique par nom de contrainte (v1.1) : seul
--      l'UPDATE est enveloppé, aucun prédicat métier dupliqué.
--      Bascule vers disponible (true) d'un produit sans TVA -> rejetée
--      par la même contrainte, même message. Bascule vers indisponible
--      (false) -> toujours autorisée quel que soit tax_rate (la
--      contrainte ne restreint jamais ce sens).
--
-- Aucune autre modification n'est autorisée par ce fichier : AUCUNE
-- modification de compute_delivery_fee_tax_allocation, create_order,
-- Stuart, Monetico, paiement, facture, reçu, ni d'aucun autre RPC.
-- ============================================================

-- ------------------------------------------------------------------
-- 1. PRÉFLIGHT FAIL-CLOSED (lecture seule) — AVANT toute contrainte.
--    Compte les lignes ACTIVES actuellement DISPONIBLES sans taux de
--    TVA renseigné (violeraient l'invariant si la contrainte était
--    ajoutée telle quelle). AUCUNE écriture : SELECT/COUNT
--    uniquement — jamais un UPDATE/backfill/désactivation, quel que
--    soit le résultat.
-- ------------------------------------------------------------------
do $$
declare
  v_violation_count integer;
begin
  select count(*) into v_violation_count
  from public.menu_items
  where is_available = true and tax_rate is null;

  if v_violation_count > 0 then
    raise exception 'SCANYM_VAT_COMPLETENESS_PREFLIGHT_FAILED: % produit(s) actuellement disponible(s) sans taux de TVA renseigné -- remédiation de données catalogue requise AVANT installation de cette migration. Aucune ligne n''a été modifiée par cette vérification, aucun taux n''a été inventé, aucun produit n''a été désactivé.', v_violation_count
      using errcode = 'P0001';
  end if;
end $$;

-- ------------------------------------------------------------------
-- 2. CONTRAINTE CHECK -- autorité UNIQUE de l'invariant. NOT VALID
--    (n'impose aucun scan bloquant immédiat) puis VALIDATE CONSTRAINT
--    tout de suite après (le préflight ci-dessus vient de confirmer
--    zéro violation existante -- jamais un état NOT VALID comme état
--    final, mandat explicite).
-- ------------------------------------------------------------------
alter table public.menu_items
  add constraint menu_items_availability_requires_tax_rate_chk
    check (is_available = false or tax_rate is not null) not valid;

alter table public.menu_items
  validate constraint menu_items_availability_requires_tax_rate_chk;

comment on constraint menu_items_availability_requires_tax_rate_chk on public.menu_items is
  'CATALOGUE VAT COMPLETENESS GUARD v1 -- invariant unique : is_available=true implique tax_rate renseigné (0 valide, NULL interdit uniquement pour un produit disponible). Seule autorité de cette règle -- create_product/update_product/set_product_availability ne la dupliquent jamais : ils traduisent seulement sa violation (check_violation, SQLSTATE réel 23514) en message applicatif stable, ou la satisfont par construction (create_product).';

-- ------------------------------------------------------------------
-- 3. create_product -- CREATE OR REPLACE (signature INCHANGÉE,
--    préserve l'OID et les GRANT existants -- aucun nouveau GRANT/
--    REVOKE requis par ce fichier). Corps repris À L'IDENTIQUE de
--    DRAFT-lot-catalogue-import-commit-idempotency-v1-1.sql (baseline
--    actuel, vérifié par traçage de date de commit) -- SEUL
--    changement : la colonne is_available est désormais explicite
--    dans l'INSERT, calculée `(p_tax_rate is not null)` au lieu
--    d'être laissée au défaut de colonne (true). Si p_tax_rate est
--    renseigné et valide : is_available = true, comportement PAR
--    DÉFAUT strictement inchangé. Si p_tax_rate est NULL : la
--    création RÉUSSIT (Layer A, jamais un rejet) et le produit est
--    inséré is_available = false -- satisfait l'invariant de la
--    section 2 PAR CONSTRUCTION, sans jamais déclencher la contrainte.
-- ------------------------------------------------------------------
create or replace function public.create_product(
  p_category_id             uuid,
  p_name                    text,
  p_description             text,
  p_price                   numeric,
  p_short_description       text default null,
  p_tax_rate                numeric default null,
  p_unit_weight_grams       integer default null,
  p_weight_is_approximate   boolean default false,
  p_subcategory_id          uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant_id uuid;
  v_order integer;
  v_id uuid;
  v_name text;
  v_description text;
  v_short_description text;
  v_subcategory_category_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  select mc.restaurant_id into v_restaurant_id
  from public.menu_categories mc where mc.id = p_category_id;

  if v_restaurant_id is null then
    raise exception using errcode = 'P0002', message = 'Category not found';
  end if;

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = v_restaurant_id
      and ru.role = any (array['owner','manager'])
  ) and not public.is_scanym_operator() then
    raise exception using errcode = '42501',
      message = 'Not authorized for this category';
  end if;

  v_name := btrim(coalesce(p_name, ''), E' \t\n\r\f' || chr(11));
  if v_name = '' then
    raise exception using errcode = '22023', message = 'Name is required';
  end if;
  if length(v_name) > 255 then
    raise exception using errcode = '22023', message = 'Name too long';
  end if;

  if p_price is null or p_price < 0 or p_price > 9999999 then
    raise exception using errcode = '22023', message = 'Invalid price';
  end if;

  v_description := nullif(btrim(coalesce(p_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_description is not null and length(v_description) > 500 then
    raise exception using errcode = '22001', message = 'SCANYM_DESCRIPTION_TOO_LONG';
  end if;

  v_short_description := nullif(btrim(coalesce(p_short_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_short_description is not null and length(v_short_description) > 100 then
    raise exception using errcode = '22001', message = 'SCANYM_SHORT_DESCRIPTION_TOO_LONG';
  end if;

  if p_tax_rate is not null and (p_tax_rate < 0 or p_tax_rate > 100) then
    raise exception using errcode = '22001', message = 'SCANYM_INVALID_TAX_RATE';
  end if;
  if p_unit_weight_grams is not null and p_unit_weight_grams <= 0 then
    raise exception using errcode = '22001', message = 'SCANYM_INVALID_WEIGHT_VALUE';
  end if;
  if p_weight_is_approximate is null then
    p_weight_is_approximate := false;
  end if;

  if p_subcategory_id is not null then
    select ms.category_id into v_subcategory_category_id
    from public.menu_subcategories ms where ms.id = p_subcategory_id;

    if v_subcategory_category_id is null then
      raise exception using errcode = 'P0002', message = 'Subcategory not found';
    end if;
    if v_subcategory_category_id is distinct from p_category_id then
      raise exception 'SCANYM_SUBCATEGORY_CATEGORY_MISMATCH' using errcode = '22023';
    end if;
  end if;

  select coalesce(max(mi.display_order), 0) + 1 into v_order
  from public.menu_items mi where mi.category_id = p_category_id;

  begin
    insert into public.menu_items (
      category_id, name, description, short_description, price, display_order,
      tax_rate, unit_weight_grams, weight_is_approximate, subcategory_id,
      is_available
    )
    values (
      p_category_id, v_name, v_description, v_short_description, round(p_price, 2), v_order,
      p_tax_rate, p_unit_weight_grams, p_weight_is_approximate, p_subcategory_id,
      (p_tax_rate is not null)
    )
    returning id into v_id;
  exception when unique_violation then
    raise exception 'SCANYM_PRODUCT_DUPLICATE_NAME' using errcode = '23505';
  end;

  return v_id;
end $$;

-- ------------------------------------------------------------------
-- 4. update_product -- CREATE OR REPLACE (signature INCHANGÉE,
--    préserve l'OID et les GRANT existants -- aucun nouveau GRANT/
--    REVOKE requis). Corps repris À L'IDENTIQUE de DRAFT-lot-
--    catalogue-subcategories-backoffice-v1.sql (baseline actuel,
--    vérifié par traçage de date de commit) -- SEUL changement :
--    l'UPDATE est enveloppé dans un begin/exception qui traduit une
--    violation RÉELLE de la contrainte (23514) en message applicatif
--    stable, sans jamais dupliquer le prédicat métier lui-même (la
--    contrainte de la section 2 tranche seule : is_available N'EST
--    PAS touché par cette fonction, donc une ligne actuellement
--    disponible dont p_tax_rate efface la TVA est rejetée par la
--    contrainte -- comportement REQUIS, jamais une désactivation
--    silencieuse ; une ligne actuellement indisponible reste libre de
--    passer sa TVA à NULL, la contrainte ne s'y oppose pas).
-- ------------------------------------------------------------------
create or replace function public.update_product(
  p_product_id              uuid,
  p_name                    text,
  p_description             text,
  p_price                   numeric,
  p_short_description       text default null,
  p_tax_rate                numeric default null,
  p_unit_weight_grams       integer default null,
  p_weight_is_approximate   boolean default false,
  p_subcategory_id          uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_description text;
  v_short_description text;
  v_category_id uuid;
  v_subcategory_category_id uuid;
  -- CATALOGUE VAT COMPLETENESS GUARD v1.1 -- nom RÉEL de la contrainte
  -- violée, récupéré via GET STACKED DIAGNOSTICS dans le gestionnaire
  -- ci-dessous (audit Cat Stevens, BLOCKER v1.1).
  v_violated_constraint text;
begin
  perform public.assert_product_role(p_product_id, array['owner','manager']);

  select mi.category_id into v_category_id
  from public.menu_items mi where mi.id = p_product_id;

  v_name := btrim(coalesce(p_name, ''), E' \t\n\r\f' || chr(11));
  if v_name = '' then
    raise exception using errcode = '22023', message = 'Name is required';
  end if;
  if length(v_name) > 255 then
    raise exception using errcode = '22023', message = 'Name too long';
  end if;

  v_description := nullif(btrim(coalesce(p_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_description is not null and length(v_description) > 500 then
    raise exception using errcode = '22001', message = 'SCANYM_DESCRIPTION_TOO_LONG';
  end if;

  v_short_description := nullif(btrim(coalesce(p_short_description, ''), E' \t\n\r\f' || chr(11)), '');
  if v_short_description is not null and length(v_short_description) > 100 then
    raise exception using errcode = '22001', message = 'SCANYM_SHORT_DESCRIPTION_TOO_LONG';
  end if;

  if p_price is null or p_price < 0 or p_price > 9999999 then
    raise exception using errcode = '22023', message = 'Invalid price';
  end if;

  if p_tax_rate is not null and (p_tax_rate < 0 or p_tax_rate > 100) then
    raise exception using errcode = '22001', message = 'SCANYM_INVALID_TAX_RATE';
  end if;
  if p_unit_weight_grams is not null and p_unit_weight_grams <= 0 then
    raise exception using errcode = '22001', message = 'SCANYM_INVALID_WEIGHT_VALUE';
  end if;
  if p_weight_is_approximate is null then
    p_weight_is_approximate := false;
  end if;

  if p_subcategory_id is not null then
    select ms.category_id into v_subcategory_category_id
    from public.menu_subcategories ms where ms.id = p_subcategory_id;

    if v_subcategory_category_id is null then
      raise exception using errcode = 'P0002', message = 'Subcategory not found';
    end if;
    if v_subcategory_category_id is distinct from v_category_id then
      raise exception 'SCANYM_SUBCATEGORY_CATEGORY_MISMATCH' using errcode = '22023';
    end if;
  end if;

  begin
    update public.menu_items
    set name                     = v_name,
        description               = v_description,
        price                     = round(p_price, 2),
        short_description         = v_short_description,
        tax_rate                  = p_tax_rate,
        unit_weight_grams         = p_unit_weight_grams,
        weight_is_approximate     = p_weight_is_approximate,
        subcategory_id            = p_subcategory_id
    where id = p_product_id and archived_at is null;
  exception when check_violation then
    -- CATALOGUE VAT COMPLETENESS GUARD v1.1 (audit Cat Stevens,
    -- BLOCKER) -- ne traduire QUE la violation de
    -- menu_items_availability_requires_tax_rate_chk. Toute AUTRE
    -- contrainte CHECK sur menu_items (description/short_description/
    -- tax_rate range/unit_weight_grams, ou une future contrainte
    -- encore inconnue) est RE-LEVÉE TELLE QUELLE (`raise;`) --
    -- sémantique Postgres d'origine intacte, jamais mal étiquetée.
    get stacked diagnostics v_violated_constraint = constraint_name;
    if v_violated_constraint = 'menu_items_availability_requires_tax_rate_chk' then
      raise exception 'SCANYM_TAX_RATE_REQUIRED_FOR_AVAILABILITY' using errcode = '23514';
    end if;
    raise;
  end;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Product not found or archived';
  end if;
end $$;

-- ------------------------------------------------------------------
-- 5. set_product_availability -- CREATE OR REPLACE (signature
--    INCHANGÉE, préserve l'OID et les GRANT existants). Corps repris
--    À L'IDENTIQUE de supabase/migration-v31-catalogue.sql (jamais
--    redéfini depuis 2026-08-10, vérifié) -- SEUL changement : l'UPDATE
--    est enveloppé dans le même begin/exception que update_product
--    ci-dessus. p_is_available = true sur un produit sans TVA -> rejeté
--    par la contrainte, même message stable. p_is_available = false ->
--    toujours autorisé quel que soit tax_rate (la contrainte ne
--    restreint jamais ce sens : is_available = false satisfait
--    toujours la clause gauche du OR).
-- ------------------------------------------------------------------
create or replace function public.set_product_availability(
  p_product_id   uuid,
  p_is_available boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- CATALOGUE VAT COMPLETENESS GUARD v1.1 -- même mécanisme EXACT que
  -- update_product ci-dessus (audit Cat Stevens, BLOCKER v1.1).
  v_violated_constraint text;
begin
  perform public.assert_product_role(
    p_product_id, array['owner','manager','staff']
  );

  begin
    update public.menu_items
    set is_available = coalesce(p_is_available, true)
    where id = p_product_id and archived_at is null;
  exception when check_violation then
    get stacked diagnostics v_violated_constraint = constraint_name;
    if v_violated_constraint = 'menu_items_availability_requires_tax_rate_chk' then
      raise exception 'SCANYM_TAX_RATE_REQUIRED_FOR_AVAILABILITY' using errcode = '23514';
    end if;
    raise;
  end;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Product not found or archived';
  end if;
end $$;

-- ------------------------------------------------------------------
-- 6. Droits -- AUCUN changement. Les 3 fonctions ci-dessus conservent
--    exactement les mêmes GRANT (CREATE OR REPLACE préserve l'OID de
--    chaque fonction, signature inchangée) ; aucune nouvelle
--    fonction, aucun nouveau GRANT/REVOKE requis par ce fichier.
-- ------------------------------------------------------------------

-- ============================================================
-- IDEMPOTENCE DE CE FICHIER
--
-- "add constraint ... not valid" échouerait sur une ré-exécution
-- (la contrainte existerait déjà) -- ce fichier est un DRAFT, jamais
-- installé automatiquement plus d'une fois (même convention que tous
-- les fichiers DRAFT-lot-*.sql de ce dépôt : réécrit sur place si
-- correction nécessaire avant installation, jamais ré-exécuté tel
-- quel après installation). "create or replace function" est
-- ré-exécutable sans erreur.
-- ============================================================
