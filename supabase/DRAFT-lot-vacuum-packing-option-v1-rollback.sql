-- ============================================================================
-- ROLLBACK -- OPTION « MISE SOUS VIDE » v1  (DRAFT, NON APPLIQUÉ)
--
-- Restaure create_order à l'EMPREINTE EXACTE du prédécesseur audité
-- (md5 5ed0f3e2eee78df7c3f9cd9c27cd3036), supprime set_category_vacuum_packable
-- et les deux colonnes additives.
--
-- REFUSE de supprimer des données : si une commande porte
-- vacuum_packing_requested = true, ou si une catégorie est vacuum_packable, le
-- retour arrière est annulé (SCANYM_ROLLBACK_DATA_LOSS). Exporter d'abord ces
-- lignes, puis décider explicitement.
--
-- Une seule transaction : un échec à n'importe quelle étape laisse la base intacte.
-- ============================================================================

begin;

do $rb$
declare
  c_sig       constant text := 'public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)';
  c_md5       constant text := '5ed0f3e2eee78df7c3f9cd9c27cd3036';
  c_begin     constant text := E'\n  -- VACUUM-PACKING BEGIN';
  c_end       constant text := E'  -- VACUUM-PACKING END\n';
  v_def       text;
  v_b         integer;
  v_e         integer;
  v_new       text;
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'orders' and column_name = 'vacuum_packing_requested')
     or not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'menu_categories' and column_name = 'vacuum_packable') then
    raise exception 'SCANYM_NOTHING_TO_ROLLBACK: rien à annuler (colonnes vacuum absentes).';
  end if;

  if exists (select 1 from public.orders where vacuum_packing_requested)
     or exists (select 1 from public.menu_categories where vacuum_packable) then
    raise exception 'SCANYM_ROLLBACK_DATA_LOSS: des commandes ou des catégories portent un choix vacuum -- exporter ces lignes puis décider explicitement. Retour arrière annulé.';
  end if;

  v_def := pg_get_functiondef(to_regprocedure(c_sig));
  v_b := position(c_begin in v_def);
  v_e := position(c_end in v_def);
  if v_b = 0 or v_e = 0 or v_e < v_b
     or (length(v_def) - length(replace(v_def, '-- VACUUM-PACKING BEGIN', ''))) / length('-- VACUUM-PACKING BEGIN') <> 1 then
    raise exception 'SCANYM_ROLLBACK_DRIFT: bloc VACUUM-PACKING introuvable ou dupliqué dans create_order -- retour arrière annulé.';
  end if;

  v_new := substr(v_def, 1, v_b - 1) || substr(v_def, v_e + length(c_end));

  execute v_new;

  if md5(pg_get_functiondef(to_regprocedure(c_sig))) <> c_md5 then
    raise exception 'SCANYM_ROLLBACK_DRIFT: create_order restauré ne correspond pas au prédécesseur audité (md5 %) -- retour arrière annulé.',
      md5(pg_get_functiondef(to_regprocedure(c_sig)));
  end if;
end
$rb$;

drop function public.set_category_vacuum_packable(uuid, boolean);
alter table public.orders drop column vacuum_packing_requested;
alter table public.menu_categories drop column vacuum_packable;

commit;
