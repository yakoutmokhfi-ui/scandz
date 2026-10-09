import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * Scanym — CATALOGUE PRODUCT REORDER v1 — TEST HELPER (jamais du code
 * de production).
 *
 * Base PostgreSQL LOCALE (PGlite, en mémoire) sur laquelle le DRAFT SQL
 * du lot est exécuté TEL QUEL, contrôle de dérive et contrôle
 * post-application compris. Aucune base hébergée, aucune clé, aucun
 * fichier d'environnement.
 *
 * Le schéma ci-dessous est le MINIMUM dont dépend le lot (mêmes noms,
 * mêmes types, mêmes contraintes que le schéma du dépôt pour ces
 * colonnes). Les fonctions préexistantes, elles, ne sont PAS réécrites
 * ici : elles sont extraites du SQL du dépôt et exécutées telles
 * quelles --
 *   is_scanym_operator()  : migration-lotd-establishment-creation.sql
 *   assert_product_role() : DRAFT-lot-catalogue-operator-authorization-v1.sql (OB-2)
 *   set_product_order()   : migration-v67b-category-description-product-order.sql
 *
 * La chaîne de migrations COMPLÈTE (et la vraie concurrence, avec
 * plusieurs sessions) est rejouée sur PostgreSQL réel par
 * supabase/tests/catalogue-product-reorder-v1-check.sh ; ce helper sert
 * la suite `npm test`, où une seule connexion existe.
 */

export const readSql = (name: string) => readFileSync(`supabase/${name}`, "utf8").replaceAll("\r\n", "\n");

export const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

export const TENANT_A = uuid(100001);
export const TENANT_B = uuid(100002);
export const OWNER_A = uuid(200001);
export const MANAGER_A = uuid(200002);
export const STAFF_A = uuid(200003);
export const OWNER_B = uuid(200004);
export const OPERATOR = uuid(200005);
export const STRANGER = uuid(200006);

export const CAT_FROMAGES = uuid(300001);
export const CAT_BOISSONS = uuid(300002);
export const CAT_B = uuid(300003);
export const SUB_CHEVRES = uuid(400001);
export const SUB_BREBIS = uuid(400002);

/** Produits du jeu d'essai, par nom (unique). */
export const P = {
  comte: uuid(500001),
  beaufort: uuid(500002),
  abondance: uuid(500003),
  zeste: uuid(500011),
  eclat: uuid(500012),
  banon: uuid(500013),
  crottin: uuid(500014),
  ancien: uuid(500015),
  ossau: uuid(500021),
  roquefort: uuid(500022),
  eau: uuid(500031),
  jus: uuid(500032),
  cidre: uuid(500033),
  bUn: uuid(500041),
  bDeux: uuid(500042),
  bTrois: uuid(500043),
} as const;

export const LOT_SQL = "DRAFT-lot-catalogue-product-reorder-v1.sql";
export const ROLLBACK_SQL = "DRAFT-lot-catalogue-product-reorder-v1-ROLLBACK.sql";

function extract(file: string, pattern: RegExp): string {
  const match = readSql(file).match(pattern);
  if (!match) throw new Error(`fonction introuvable dans supabase/${file} : ${pattern}`);
  return match[0];
}

/** Schéma minimal + fonctions du dépôt, SANS le lot. */
export async function makeBaselineDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth, public to anon, authenticated, service_role;

    create table public.restaurants (
      id uuid primary key, name varchar(255) not null,
      is_active boolean not null default true, status text not null default 'active'
    );
    create table public.restaurant_users (
      user_id uuid not null, restaurant_id uuid not null references public.restaurants(id),
      role text not null default 'staff'
    );
    create table public.scanym_operators (user_id uuid primary key);
    create table public.menu_categories (
      id uuid primary key, restaurant_id uuid not null references public.restaurants(id),
      name varchar(255) not null, display_order integer not null default 0,
      is_active boolean not null default true
    );
    create table public.menu_subcategories (
      id uuid primary key, category_id uuid not null references public.menu_categories(id),
      name text not null, display_order integer not null default 0
    );
    create table public.menu_items (
      id uuid primary key default gen_random_uuid(),
      category_id uuid not null references public.menu_categories(id),
      subcategory_id uuid references public.menu_subcategories(id),
      name varchar(255) not null, price numeric(10,2) not null default 1,
      display_order integer not null default 0,
      is_available boolean not null default true,
      archived_at timestamptz
    );
    -- Lecture publique, aucune policy d'écriture : toute écriture passe
    -- par une RPC SECURITY DEFINER (même posture que le dépôt).
    alter table public.menu_items enable row level security;
    create policy "lecture publique items" on public.menu_items for select using (true);
    grant select on public.restaurants, public.menu_categories, public.menu_subcategories, public.menu_items
      to anon, authenticated;
  `);
  await db.exec(
    extract(
      "migration-lotd-establishment-creation.sql",
      /create function public\.is_scanym_operator\(\)[\s\S]*?grant execute on function public\.is_scanym_operator\(\) to authenticated;/
    )
  );
  await db.exec(
    extract(
      "DRAFT-lot-catalogue-operator-authorization-v1.sql",
      /create or replace function public\.assert_product_role\([\s\S]*?\nend \$\$;/
    )
  );
  await db.exec(
    extract(
      "migration-v67b-category-description-product-order.sql",
      /create function public\.set_product_order\([\s\S]*?grant execute on function public\.set_product_order\(uuid, integer\) to authenticated;/
    )
  );
  return db;
}

/** Jeu d'essai, remis à neuf avant chaque test. */
export async function seed(db: PGlite): Promise<void> {
  await db.exec(`
    truncate public.menu_items, public.menu_subcategories, public.menu_categories,
             public.restaurant_users, public.scanym_operators, public.restaurants cascade;

    insert into public.restaurants (id, name) values
      ('${TENANT_A}', 'Au lait cru'), ('${TENANT_B}', 'Hotel Royal');
    insert into public.restaurant_users (user_id, restaurant_id, role) values
      ('${OWNER_A}', '${TENANT_A}', 'owner'), ('${MANAGER_A}', '${TENANT_A}', 'manager'),
      ('${STAFF_A}', '${TENANT_A}', 'staff'), ('${OWNER_B}', '${TENANT_B}', 'owner');
    insert into public.scanym_operators (user_id) values ('${OPERATOR}');

    insert into public.menu_categories (id, restaurant_id, name, display_order) values
      ('${CAT_FROMAGES}', '${TENANT_A}', 'Fromages', 1),
      ('${CAT_BOISSONS}', '${TENANT_A}', 'Boissons', 2),
      ('${CAT_B}', '${TENANT_B}', 'Carte', 1);
    insert into public.menu_subcategories (id, category_id, name, display_order) values
      ('${SUB_CHEVRES}', '${CAT_FROMAGES}', 'Chèvres', 1),
      ('${SUB_BREBIS}', '${CAT_FROMAGES}', 'Brebis', 2);

    insert into public.menu_items (id, category_id, subcategory_id, name, display_order, is_available, archived_at) values
      -- Fromages, produits directs : valeurs denses ; Abondance indisponible.
      ('${P.comte}',     '${CAT_FROMAGES}', null, 'Comté',     1, true,  null),
      ('${P.beaufort}',  '${CAT_FROMAGES}', null, 'Beaufort',  2, true,  null),
      ('${P.abondance}', '${CAT_FROMAGES}', null, 'Abondance', 3, false, null),
      -- Chèvres : catalogue historique, quatre ex æquo à 0 + un archivé.
      ('${P.zeste}',   '${CAT_FROMAGES}', '${SUB_CHEVRES}', 'Zeste de chèvre', 0, true,  null),
      ('${P.eclat}',   '${CAT_FROMAGES}', '${SUB_CHEVRES}', 'éclat cendré',    0, true,  null),
      ('${P.banon}',   '${CAT_FROMAGES}', '${SUB_CHEVRES}', 'Banon',           0, true,  null),
      ('${P.crottin}', '${CAT_FROMAGES}', '${SUB_CHEVRES}', 'crottin',         0, true,  null),
      ('${P.ancien}',  '${CAT_FROMAGES}', '${SUB_CHEVRES}', 'Ancien chèvre',   0, false, now()),
      -- Brebis : valeurs distinctes non denses.
      ('${P.ossau}',     '${CAT_FROMAGES}', '${SUB_BREBIS}', 'Ossau',     4, true, null),
      ('${P.roquefort}', '${CAT_FROMAGES}', '${SUB_BREBIS}', 'Roquefort', 9, true, null),
      -- Boissons, produits directs : valeurs distinctes non denses.
      ('${P.eau}',   '${CAT_BOISSONS}', null, 'Eau',    5, true, null),
      ('${P.jus}',   '${CAT_BOISSONS}', null, 'Jus',    9, true, null),
      ('${P.cidre}', '${CAT_BOISSONS}', null, 'Cidre', 14, true, null),
      -- Établissement B : historique, jamais réordonné.
      ('${P.bTrois}', '${CAT_B}', null, 'B-Trois', 0, true, null),
      ('${P.bUn}',    '${CAT_B}', null, 'B-Un',    0, true, null),
      ('${P.bDeux}',  '${CAT_B}', null, 'B-Deux',  0, true, null);
  `);
}

export interface ItemRow {
  id: string;
  category_id: string;
  subcategory_id: string | null;
  name: string;
  display_order: number;
  is_available: boolean;
  archived_at: string | null;
}

/** Lignes d'un périmètre (non archivées), lues en superutilisateur,
 *  dans un ordre d'arrivée volontairement NON significatif. */
export async function scopeRows(db: PGlite, categoryId: string, subcategoryId: string | null): Promise<ItemRow[]> {
  const result = await db.query<ItemRow>(
    `select id, category_id, subcategory_id, name::text as name, display_order, is_available, archived_at::text as archived_at
     from public.menu_items
     where category_id = $1 and subcategory_id is not distinct from $2 and archived_at is null
     order by id desc`,
    [categoryId, subcategoryId]
  );
  return result.rows;
}

/** « nom=valeur|… » d'un périmètre, par valeur stockée puis nom. */
export async function scopeState(db: PGlite, categoryId: string, subcategoryId: string | null): Promise<string> {
  const rows = await scopeRows(db, categoryId, subcategoryId);
  return rows
    .sort((a, b) => a.display_order - b.display_order || (a.name < b.name ? -1 : 1))
    .map((r) => `${r.name}=${r.display_order}`)
    .join("|");
}

/** Empreinte (id, display_order) de TOUS les produits. */
export async function orderFingerprint(db: PGlite, where = "true"): Promise<string> {
  const r = await db.query<{ fp: string }>(
    `select count(*)::text || ':' || coalesce(md5(string_agg(id::text || '=' || display_order, ',' order by id)), 'empty') as fp
     from public.menu_items where ${where}`
  );
  return r.rows[0].fp;
}

/** Empreinte de tout SAUF l'ordre : taxonomie, disponibilité, prix, nom, archivage. */
export async function nonOrderFingerprint(db: PGlite): Promise<string> {
  const r = await db.query<{ fp: string }>(
    `select md5(string_agg((to_jsonb(mi) - 'display_order')::text, ',' order by mi.id)) as fp from public.menu_items mi`
  );
  return r.rows[0].fp;
}
