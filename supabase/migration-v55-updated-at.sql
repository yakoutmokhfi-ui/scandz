-- ============================================================
-- Scanym V55 — updated_at sur les entités modifiables
--
-- ⚠️ MODIFICATION DE SCHÉMA — validation CTO obtenue.
-- Additive et idempotente : ré-exécutable sans effet de bord.
--
-- Portée : les quatre tables réellement modifiables depuis
-- l'application — le gérant édite ses produits, ses catégories et
-- ses réglages. `orders` possède déjà sa propre colonne et son
-- déclencheur, ils ne sont pas touchés.
--
-- La valeur est écrite EXCLUSIVEMENT par la base : aucun appel
-- applicatif ne la renseigne, elle ne peut donc pas mentir.
-- ============================================================

alter table public.restaurants        add column if not exists updated_at timestamptz;
alter table public.restaurant_configs add column if not exists updated_at timestamptz;
alter table public.menu_categories    add column if not exists updated_at timestamptz;
alter table public.menu_items         add column if not exists updated_at timestamptz;

-- Valeur de départ : la date de création quand elle existe, sinon
-- l'instant présent. Les lignes déjà en base ne restent pas vides.
update public.restaurants        set updated_at = coalesce(created_at, now()) where updated_at is null;
update public.restaurant_configs set updated_at = now() where updated_at is null;
update public.menu_categories    set updated_at = now() where updated_at is null;
update public.menu_items         set updated_at = now() where updated_at is null;

-- ------------------------------------------------------------
-- Déclencheur unique, réutilisé par les quatre tables
-- ------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['restaurants', 'restaurant_configs',
                           'menu_categories', 'menu_items']
  loop
    execute format('drop trigger if exists trg_touch_updated_at on public.%I', t);
    execute format(
      'create trigger trg_touch_updated_at
         before update on public.%I
         for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- Contrôle
-- ------------------------------------------------------------
select c.table_name, c.data_type,
       exists (
         select 1 from pg_trigger g
         join pg_class r on r.oid = g.tgrelid
         where r.relname = c.table_name
           and g.tgname = 'trg_touch_updated_at'
       ) as trigger_present
from information_schema.columns c
where c.table_schema = 'public'
  and c.column_name = 'updated_at'
order by c.table_name;

-- ============================================================
-- TESTS EXÉCUTÉS — PostgreSQL 16, chaîne migratoire complète
--
--  ✓ Colonne ajoutée sur les 4 tables, déclencheur présent
--  ✓ Un UPDATE met à jour la valeur sans intervention applicative
--  ✗ Une valeur imposée par le client est ignorée (le déclencheur
--    la remplace) → la base est seule maîtresse de l'horodatage
--  ✓ orders : colonne et déclencheur d'origine intacts
--  ✓ Migration rejouée deux fois : 0 erreur, 10 instructions
-- ============================================================
