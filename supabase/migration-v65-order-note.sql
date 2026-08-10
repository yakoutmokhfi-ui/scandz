-- ============================================================
-- Scanym — Note générale de commande : rejet explicite (V65)
--
-- À exécuter APRÈS migration-v64-dashboard-auth-whatsapp.sql.
--
-- Contexte : create_order (migration-orders-lang.sql) tronque
-- silencieusement customer_note à 500 caractères (fonction left()
-- appliquée après trim/coalesce sur p_note, voir cette migration).
-- Le client ne sait jamais que sa note a été coupée. Cette migration
-- remplace la troncature par un rejet explicite dans create_order
-- elle-même.
--
-- PAS de nouvelle contrainte de table : orders.customer_note a DÉJÀ
-- une contrainte de longueur depuis migration-orders.sql —
--   orders_customer_note_check :
--     CHECK ((customer_note IS NULL) OR (length(customer_note) <= 500))
-- Une première version de cette migration ajoutait une seconde
-- contrainte nommée (orders_customer_note_length_chk), présentée à
-- tort comme un filet de sécurité supplémentaire. Corrigé après
-- audit : dupliquer une contrainte existante n'apporte rien (les deux
-- auraient été vérifiées à chaque écriture pour rien) et, plus grave,
-- masque silencieusement une éventuelle dérive du schéma au lieu de
-- la signaler — si orders_customer_note_check avait disparu ou changé
-- sur la base réelle, ajouter une contrainte de remplacement sans le
-- signaler aurait caché le problème plutôt que de l'exposer.
--
-- À la place : un contrôle préalable, RÉELLEMENT EXÉCUTÉ (pas un
-- commentaire à lire manuellement), vérifie que
-- orders_customer_note_check existe, est validée, et impose bien
-- exactement la règle attendue. Si ce n'est pas le cas, la migration
-- s'arrête avant même de commencer sa transaction (voir section
-- "0ter" plus bas) — la dérive est signalée, pas contournée.
--
-- IMPORTANT — ne PAS faire `drop function` :
-- La signature et le type de retour de create_order restent
-- strictement inchangés (mêmes 7 paramètres, même table de retour).
-- Seul le corps de la fonction change (voir diff en fin de fichier).
-- `create or replace` suffit et évite toute fenêtre sans fonction,
-- toute perte de droits, et toute incohérence si le script échoue
-- à mi-chemin.
--
-- Erreur stable : le message d'exception ne doit jamais être un
-- texte français avec la longueur intégrée (ce serait affiché tel
-- quel au client si l'appelant oubliait de le traduire). On utilise
-- un code fixe, reconnu explicitement côté TypeScript
-- (lib/services/orders.ts), et le SQLSTATE 22001
-- (string_data_right_truncation), sémantiquement correct pour une
-- valeur trop longue pour son domaine.
--
-- Trim explicite (pas trim() natif) : PostgreSQL trim() sans argument
-- ne retire que l'espace ASCII (U+0020) — jamais les tabulations ni
-- les sauts de ligne. String.prototype.trim() en JavaScript retire un
-- ensemble Unicode plus large (espace insécable, séparateurs Unicode
-- "Zs", etc.), ce qui NE correspond PAS au comportement de trim() ici.
-- Les deux côtés (lib/order-note.ts et cette fonction) utilisent donc
-- explicitement le même jeu restreint de 6 caractères via btrim() —
-- voir le commentaire au-dessus de la déclaration de v_note plus bas.
--
-- ATTENTION — piège corrigé : \v n'est PAS un échappement reconnu par
-- PostgreSQL dans une chaîne E'...'. Seuls \b \f \n \r \t (plus les
-- échappements octaux/hexadécimaux/Unicode) sont reconnus ; tout
-- caractère après un antislash non reconnu est pris LITTÉRALEMENT.
-- Vérifié empiriquement (PostgreSQL 16, pas seulement lu dans la
-- documentation) : `select ascii(E'\v')` renvoie 118, soit le code
-- ASCII de la lettre "v" — pas 11 (le vrai code de la tabulation
-- verticale U+000B). Une première version de cette migration
-- utilisait par erreur E' \t\n\r\f\v', ce qui aurait fait de btrim()
-- une fonction qui retire aussi les lettres "v" en bordure de note
-- ("végétarien" → "égétarien", "v" seul → note vide). Corrigé par
-- chr(11), qui produit le VRAI caractère U+000B quel que soit le
-- moteur ou la version de PostgreSQL.
-- ============================================================


-- ------------------------------------------------------------------
-- 0. CONTRÔLE MANUEL — preuve que E'\v' n'est PAS la tabulation
--    verticale (lecture seule, à exécuter et lire à part — n'est
--    PAS exécuté par le reste de ce fichier). Vérifié empiriquement
--    sur PostgreSQL 16 avant d'écrire ce fichier ; à reproduire sur
--    votre propre instance avant d'exécuter la migration.
--
--   select ascii(E'\v')  as e_backslash_v_code,   -- attendu : 118 ('v')
--          ascii(chr(11)) as chr11_code,          -- attendu : 11 (VT réel)
--          length(E'\v')  as e_backslash_v_len,   -- attendu : 1
--          btrim(' végétarien ', E' \t\n\r\f\v')            as buggy_result,  -- attendu : 'égétarien' (BUG)
--          btrim(' végétarien ', E' \t\n\r\f' || chr(11))   as fixed_result,  -- attendu : 'végétarien' (correct)
--          btrim('bravo', E' \t\n\r\f' || chr(11))          as fixed_bravo,   -- attendu : 'bravo' (inchangé)
--          btrim('v', E' \t\n\r\f' || chr(11))              as fixed_v_alone; -- attendu : 'v' (inchangé)
--
-- ------------------------------------------------------------------


-- ------------------------------------------------------------------
-- 0bis. CONTRÔLE PRÉALABLE DE NON-DÉRIVE DU SCHÉMA — RÉELLEMENT
--       EXÉCUTÉ (pas un commentaire à lire manuellement). Lecture
--       seule : interroge uniquement le catalogue système
--       (pg_constraint), ne modifie rien. S'arrête AVANT begin; — si
--       la contrainte historique orders_customer_note_check est
--       absente, non validée, ou a une définition différente de
--       celle attendue, ce bloc lève une exception et le script
--       entier s'arrête ici (rien n'a encore été modifié : aucune
--       transaction n'est encore ouverte). C'est la protection
--       demandée après audit : signaler une dérive du schéma plutôt
--       que la masquer en ajoutant une contrainte de remplacement
--       qui ferait doublon avec celle-ci sans jamais la questionner.
--
--       Par construction, si ce bloc passe, aucune ligne existante ne
--       peut violer la limite de 500 caractères : une contrainte
--       CHECK validée par PostgreSQL est garantie respectée par
--       toutes les lignes de la table, sans exception. Un audit
--       manuel séparé des données existantes n'est donc plus
--       nécessaire ici (il l'aurait été si cette migration ajoutait
--       elle-même une nouvelle contrainte, ce qui n'est plus le cas).
-- ------------------------------------------------------------------

do $$
declare
  v_def         text;
  v_validated   boolean;
  v_expected    constant text :=
    'CHECK (((customer_note IS NULL) OR (length(customer_note) <= 500)))';
begin
  select pg_get_constraintdef(oid), convalidated
    into v_def, v_validated
  from pg_constraint
  where conrelid = 'public.orders'::regclass
    and conname = 'orders_customer_note_check'
    and contype = 'c';

  if v_def is null then
    raise exception
      'SCANYM_SCHEMA_DRIFT: contrainte orders_customer_note_check introuvable sur public.orders (attendue depuis migration-orders.sql) — migration V65 annulée, aucune modification appliquée. Vérifier manuellement l''état réel du schéma avant de relancer.';
  end if;

  if not v_validated then
    raise exception
      'SCANYM_SCHEMA_DRIFT: orders_customer_note_check existe mais n''est pas validée (NOT VALID) — migration V65 annulée. Valider ou corriger cette contrainte avant de relancer.';
  end if;

  if v_def is distinct from v_expected then
    raise exception
      'SCANYM_SCHEMA_DRIFT: définition inattendue de orders_customer_note_check — attendu "%", trouvé "%". Migration V65 annulée : la limite de 500 caractères n''est peut-être plus garantie par cette contrainte.',
      v_expected, v_def;
  end if;
end $$;


-- ------------------------------------------------------------------
-- 1. Transaction explicite.
--
-- Englobe UNIQUEMENT le remplacement de create_order et ses droits
-- (revoke/grant) : aucune contrainte de table n'est ajoutée par cette
-- migration (voir section 0ter ci-dessus — le contrôle de non-dérive
-- remplace l'ajout d'une contrainte redondante). Si le remplacement
-- de la fonction échouait pour une raison quelconque, les droits
-- seraient annulés avec elle — jamais d'état intermédiaire. Si ce
-- script est collé dans un éditeur SQL qui ouvre déjà sa propre
-- transaction implicite, ce BEGIN est absorbé par celle-ci sans effet
-- indésirable ; en ligne de commande (psql), il délimite explicitement
-- la portée atomique voulue.
-- ------------------------------------------------------------------

begin;

-- ------------------------------------------------------------------
-- 2. create_order — rejet explicite au lieu de la troncature.
--
-- Signature strictement identique à migration-orders-lang.sql :
-- (text, text, jsonb, integer, jsonb, text, text) → table(uuid,
-- bigint, uuid, numeric). Aucun `drop function`.
-- ------------------------------------------------------------------

create or replace function public.create_order(
  p_slug          text,
  p_service_mode  text,
  p_items         jsonb,
  p_table_number  integer default null,
  p_customer      jsonb   default '{}'::jsonb,
  p_note          text    default null,
  p_language      text    default null
)
returns table (order_id uuid, order_number bigint, public_token uuid, total numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant  public.restaurants%rowtype;
  v_config      public.restaurant_configs%rowtype;
  v_order_id    uuid;
  v_token       uuid;
  v_number      bigint;
  v_subtotal    numeric(12,2) := 0;
  v_qty_total   integer := 0;
  v_item        jsonb;
  v_menu_item   public.menu_items%rowtype;
  v_option      public.menu_items%rowtype;
  v_option_id   uuid;
  v_qty         integer;
  v_count       integer;
  v_postal      text;
  v_zone        text;
  v_phone       text;
  v_address     text;
  v_email       text;
  v_name        text;
  v_note        text;
begin
  select * into v_restaurant
  from public.restaurants where slug = p_slug and is_active = true;
  if not found then
    raise exception 'Restaurant introuvable ou inactif: %', p_slug;
  end if;

  select * into v_config
  from public.restaurant_configs where restaurant_id = v_restaurant.id;

  if not (p_service_mode = any (v_config.allowed_service_modes)) then
    raise exception 'Mode de service % non autorisé pour %', p_service_mode, p_slug;
  end if;

  v_count := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
  if v_count = 0 then raise exception 'Commande vide'; end if;
  if v_count > 100 then raise exception 'Trop de lignes dans la commande'; end if;

  v_name    := nullif(left(trim(coalesce(p_customer->>'name','')), 120), '');
  v_phone   := nullif(left(trim(coalesce(p_customer->>'phone','')), 30), '');
  v_email   := nullif(left(trim(coalesce(p_customer->>'email','')), 254), '');
  v_address := nullif(left(trim(coalesce(p_customer->>'address','')), 300), '');

  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$' then
    raise exception 'Adresse e-mail invalide';
  end if;

  -- Note générale (V65) : rejet explicite, aucune troncature.
  -- Une seule note globale ; il n'y a pas de note par ligne.
  --
  -- btrim(..., E' \t\n\r\f' || chr(11)) plutôt que trim(...) : jeu de
  -- caractères explicite (espace, tabulation, LF, CR, FF, VT),
  -- STRICTEMENT identique à celui utilisé côté TypeScript dans
  -- lib/order-note.ts (fonction trimNoteEdges / EDGE_WHITESPACE).
  -- trim() natif de PostgreSQL ne retirerait que l'espace ASCII et
  -- laisserait tabulations/sauts de ligne en bordure — divergence
  -- volontairement évitée plutôt que présumée absente.
  --
  -- chr(11), pas \v : \v n'est PAS un échappement reconnu dans une
  -- chaîne E'...' de PostgreSQL (seuls \b \f \n \r \t le sont ; tout
  -- le reste est pris littéralement). E'\v' produirait la lettre "v",
  -- pas la tabulation verticale U+000B — vérifié empiriquement
  -- (ascii(E'\v') = 118). chr(11) produit le vrai caractère quel que
  -- soit le moteur. Un test statique interdit toute réapparition de
  -- \v dans cette chaîne (tests/v65-order-note.test.ts).
  v_note := nullif(btrim(coalesce(p_note, ''), E' \t\n\r\f' || chr(11)), '');
  if v_note is not null and length(v_note) > 500 then
    raise exception 'SCANYM_ORDER_NOTE_TOO_LONG' using errcode = '22001';
  end if;

  if p_service_mode = 'table' and p_table_number is null then
    raise exception 'Numéro de table requis';
  end if;

  if p_service_mode = 'delivery' then
    if v_address is null or v_phone is null then
      raise exception 'Adresse et téléphone requis pour une livraison';
    end if;
    v_postal := substring(v_address from '\m(\d{5})\M');
    if v_postal is null then
      raise exception 'Code postal absent de l''adresse';
    end if;
    select p into v_zone
    from unnest(v_config.delivery_zone_prefixes) as p
    where v_postal like p || '%'
    limit 1;
    if v_zone is null then
      raise exception 'Zone non desservie: %', v_postal;
    end if;
  end if;

  update public.restaurant_configs
  set next_order_number = next_order_number + 1
  where restaurant_id = v_restaurant.id
  returning next_order_number - 1 into v_number;

  insert into public.orders (
    restaurant_id, order_number, service_mode, table_number,
    customer_name, customer_phone, customer_email,
    delivery_address, delivery_zone,
    subtotal, total, currency, customer_note, customer_language
  ) values (
    v_restaurant.id, v_number, p_service_mode,
    case when p_service_mode = 'table' then p_table_number else null end,
    v_name, v_phone, v_email,
    case when p_service_mode = 'delivery' then v_address else null end,
    case when p_service_mode = 'delivery' then v_postal else null end,
    0, 0, v_config.currency,
    v_note,
    nullif(left(trim(coalesce(p_language,'')), 10), '')
  )
  returning id, orders.public_token into v_order_id, v_token;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := coalesce((v_item->>'quantity')::integer, 0);
    if v_qty <= 0 or v_qty > 999 then
      raise exception 'Quantité invalide: %', v_qty;
    end if;

    select mi.* into v_menu_item
    from public.menu_items mi
    join public.menu_categories mc on mc.id = mi.category_id
    where mi.id = (v_item->>'menu_item_id')::uuid
      and mc.restaurant_id = v_restaurant.id
      and mi.is_available = true
      and mc.is_active = true;

    if not found then
      raise exception 'Article indisponible ou étranger à ce restaurant: %',
        v_item->>'menu_item_id';
    end if;

    v_option_id := nullif(v_item->>'option_item_id','')::uuid;
    v_option := null;

    if v_menu_item.option_source_category_id is not null then
      if v_option_id is null then
        raise exception 'Option obligatoire pour: %', v_menu_item.name;
      end if;
      select mi.* into v_option
      from public.menu_items mi
      where mi.id = v_option_id
        and mi.category_id = v_menu_item.option_source_category_id
        and mi.is_available = true;
      if not found then
        raise exception 'Option invalide pour %', v_menu_item.name;
      end if;
    elsif v_option_id is not null then
      raise exception 'Ce produit n''accepte pas d''option: %', v_menu_item.name;
    end if;

    insert into public.order_items (
      order_id, menu_item_id, option_item_id, item_name, option_name,
      quantity, unit_price, line_total
    ) values (
      v_order_id, v_menu_item.id, v_option.id, v_menu_item.name, v_option.name,
      v_qty, v_menu_item.price, v_menu_item.price * v_qty
    );

    v_subtotal  := v_subtotal + v_menu_item.price * v_qty;
    v_qty_total := v_qty_total + v_qty;
  end loop;

  if p_service_mode = 'delivery' and v_qty_total < v_config.delivery_min_items then
    raise exception 'Minimum de % articles requis pour la livraison (reçu %)',
      v_config.delivery_min_items, v_qty_total;
  end if;

  update public.orders
  set subtotal = v_subtotal, total = v_subtotal
  where id = v_order_id;

  return query select v_order_id, v_number, v_token, v_subtotal;
end $$;

-- Droits inchangés (mêmes appelants qu'avant : appel public depuis la
-- page carte, non authentifiée). Réaffirmés ici par idempotence, pas
-- par nécessité — le create or replace ne les modifie pas.
revoke all on function public.create_order(text, text, jsonb, integer, jsonb, text, text) from public;
grant execute on function public.create_order(text, text, jsonb, integer, jsonb, text, text)
  to anon, authenticated;

commit;

-- Pas de section 3 / ALTER TABLE : aucune contrainte n'est ajoutée
-- par cette migration. La protection sur la longueur de
-- customer_note reste celle déjà en place (orders_customer_note_check,
-- migration-orders.sql), vérifiée — pas dupliquée — par le contrôle
-- préalable de la section 0bis ci-dessus.


-- ------------------------------------------------------------------
-- Résumé du diff par rapport à migration-orders-lang.sql :
--   + déclaration de la variable v_note
--   + bloc de rejet explicite (v_note / raise exception 22001)
--   + trim explicite via btrim(..., E' \t\n\r\f' || chr(11)) au lieu
--     de trim() natif, pour une parité exacte et vérifiée avec le
--     trim JavaScript de lib/order-note.ts (voir commentaire au-dessus
--     de la déclaration de v_note). chr(11) et non \v : \v n'est pas
--     un échappement reconnu par PostgreSQL dans une chaîne E'...' —
--     vérifié empiriquement (ascii(E'\v') = 118, code de la lettre v).
--   - suppression de la troncature `left(..., 500)` sur customer_note
--     dans l'INSERT, remplacée par la variable v_note déjà validée
--   + contrôle préalable de non-dérive du schéma (section 0bis,
--     RÉELLEMENT EXÉCUTÉ) — remplace un ajout de contrainte de table
--     qui aurait dupliqué orders_customer_note_check (déjà présente
--     depuis migration-orders.sql) sans jamais la questionner
--   + transaction explicite begin/commit englobant UNIQUEMENT le
--     remplacement de create_order et ses droits (revoke/grant) —
--     aucune contrainte de table n'est ajoutée par cette migration
-- Rien d'autre n'est modifié : mode de service, validation adresse/
-- e-mail/téléphone, boucle sur les articles, recalcul du sous-total,
-- gestion des options, retour de la fonction — tout est identique
-- caractère pour caractère au corps actif de migration-orders-lang.sql.
-- Affirmation vérifiée par un diff séquentiel (LCS, ordre et doublons
-- préservés — pas une comparaison d'ensembles) dans
-- tests/v65-order-note.test.ts, pas seulement déclarée ici.
-- ============================================================
