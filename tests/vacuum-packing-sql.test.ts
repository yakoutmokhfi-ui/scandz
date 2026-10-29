import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

/**
 * OPTION « MISE SOUS VIDE » -- preuves SQL sur un vrai PostgreSQL (PGlite).
 *
 * `tests/fixtures/create-order-hosted-5ed0f3e2.sql` est la définition RÉELLE de
 * `public.create_order` lue en base hébergée (pg_get_functiondef, md5
 * 5ed0f3e2eee78df7c3f9cd9c27cd3036) -- vérifiée ci-dessous octet pour octet. Le lot
 * est exécuté dessus ; rien n'est appliqué à une base hébergée.
 */

const PREDECESSOR_MD5 = "5ed0f3e2eee78df7c3f9cd9c27cd3036";
const sql = (name: string) => readFileSync(`supabase/${name}`, "utf8").replaceAll("\r\n", "\n");
const FIXTURE = readFileSync("tests/fixtures/create-order-hosted-5ed0f3e2.sql", "utf8");
const LOT = () => sql("DRAFT-lot-vacuum-packing-option-v1.sql");
const ROLLBACK = () => sql("DRAFT-lot-vacuum-packing-option-v1-rollback.sql");
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const SIG = "public.create_order(text,text,jsonb,integer,jsonb,text,text,boolean)";

const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const TENANT = uuid(1), OTHER_TENANT = uuid(2);
const OWNER = uuid(11), MANAGER = uuid(12), STAFF = uuid(13), STRANGER = uuid(14), OPERATOR = uuid(15);
const CAT_CHEESE = uuid(101), CAT_DELI = uuid(102), CAT_DRINKS = uuid(103);
const ITEM_CHEESE = uuid(201), ITEM_DELI = uuid(202), ITEM_DRINK = uuid(203);

async function makeDb(fixture: string = FIXTURE) {
  const db = new PGlite();
  // La définition hébergée référence des tables/types hors périmètre de ce test
  // (restaurants%rowtype, moteur de créneaux...) : on désactive la validation de corps
  // à la CRÉATION uniquement. Le bloc vacuum, lui, est exécuté pour de vrai plus bas.
  await db.exec(`
    set check_function_bodies = off;
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth, public to anon, authenticated, service_role;
    create table public.restaurant_users (user_id uuid, restaurant_id uuid, role text);
    create table public.scanym_operators (user_id uuid);
    create table public.menu_categories (id uuid primary key, restaurant_id uuid not null, name text not null);
    create table public.menu_items (id uuid primary key, category_id uuid not null references public.menu_categories(id), name text not null);
    create table public.orders (id uuid primary key, payment_status text not null default 'not_required');
    create table public.order_items (id serial primary key, order_id uuid not null references public.orders(id), menu_item_id uuid not null);
    insert into public.menu_categories values
      ('${CAT_CHEESE}','${TENANT}','Fromages'), ('${CAT_DELI}','${TENANT}','Charcuterie'), ('${CAT_DRINKS}','${TENANT}','Boissons');
    insert into public.menu_items values
      ('${ITEM_CHEESE}','${CAT_CHEESE}','Comté'), ('${ITEM_DELI}','${CAT_DELI}','Jambon'), ('${ITEM_DRINK}','${CAT_DRINKS}','Cidre');
    insert into public.restaurant_users values
      ('${OWNER}','${TENANT}','owner'), ('${MANAGER}','${TENANT}','manager'), ('${STAFF}','${TENANT}','staff');
    insert into public.scanym_operators values ('${OPERATOR}');
  `);
  const lotd = sql("migration-lotd-establishment-creation.sql")
    .match(/create function public\.is_scanym_operator\(\)[\s\S]*?grant execute on function public\.is_scanym_operator\(\) to authenticated;/)![0];
  await db.exec(lotd);
  const acl = sql("DRAFT-lot-catalogue-operator-authorization-v1.sql")
    .match(/create or replace function public\.assert_category_role\([\s\S]*?\nend \$\$;/)![0];
  await db.exec(acl);
  await db.exec(fixture);
  // ACL hébergée réelle : postgres + anon + authenticated (pas PUBLIC).
  await db.exec(`revoke all on function ${SIG} from public; grant execute on function ${SIG} to anon, authenticated;`);
  return db;
}

const defOf = async (db: PGlite, s = SIG) =>
  (await db.query<{ d: string }>(`select pg_get_functiondef(to_regprocedure('${s}')) as d`)).rows[0].d;

async function as(db: PGlite, user: string | null, fn: (q: (s: string, p?: unknown[]) => Promise<any>) => Promise<void>, role = "authenticated") {
  await db.transaction(async (tx) => {
    await tx.query(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [user ?? ""]);
    await fn((s, p) => tx.query(s, p));
  });
}

test("[VP-SQL-0] la fixture est la définition hébergée réelle, octet pour octet", () => {
  assert.equal(md5(FIXTURE), PREDECESSOR_MD5);
  assert.equal(FIXTURE.length, 33587);
});

test("[VP-SQL-1] le lot s'applique sur la définition réelle : UN bloc ancré après CSDJ-3, le reste inchangé", async () => {
  const db = await makeDb();
  assert.equal(md5(await defOf(db)), PREDECESSOR_MD5, "le prédécesseur chargé est bien l'audité");
  await db.exec(LOT());
  const patched = await defOf(db);
  assert.notEqual(md5(patched), PREDECESSOR_MD5);

  const begins = patched.split("-- VACUUM-PACKING BEGIN").length - 1;
  const ends = patched.split("-- VACUUM-PACKING END").length - 1;
  assert.deepEqual([begins, ends], [1, 1]);
  assert.ok(patched.indexOf("-- CSDJ-3 END") < patched.indexOf("-- VACUUM-PACKING BEGIN"), "après le bloc créneau");
  assert.ok(patched.indexOf("-- VACUUM-PACKING END") < patched.indexOf("return query select v_order_id"), "avant le return final");

  // Retirer le bloc redonne EXACTEMENT la définition hébergée : rien d'autre n'a bougé.
  const b = patched.indexOf("\n  -- VACUUM-PACKING BEGIN");
  const eMarker = "  -- VACUUM-PACKING END\n";
  const e = patched.indexOf(eMarker) + eMarker.length;
  assert.equal(md5(patched.slice(0, b) + patched.slice(e)), PREDECESSOR_MD5);

  const attrs = await db.query<{ secdef: boolean; cfg: string[]; acl: string }>(`
    select p.prosecdef as secdef, p.proconfig as cfg,
      (select string_agg(a.grantee::regrole::text||':'||a.privilege_type, ',' order by a.grantee::regrole::text)
         from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) as acl
    from pg_proc p where p.oid = to_regprocedure('${SIG}')`);
  assert.equal(attrs.rows[0].secdef, true);
  assert.deepEqual(attrs.rows[0].cfg, ['search_path=""']);
  assert.equal(attrs.rows[0].acl, "anon:EXECUTE,authenticated:EXECUTE,postgres:EXECUTE", "droits de create_order inchangés");
  const one = await db.query<{ n: string }>(`select count(*)::text as n from pg_proc where proname='create_order' and pronamespace='public'::regnamespace`);
  assert.equal(one.rows[0].n, "1", "aucune surcharge créée");
  const flags = await db.query<{ n: string }>("select count(*)::text as n from public.menu_categories where vacuum_packable");
  assert.equal(flags.rows[0].n, "0", "le lot n'active AUCUNE catégorie");
});

test("[VP-SQL-2] double application refusée ; prédécesseur modifié, ancre absente ou dupliquée : lot annulé, rien n'est changé", async () => {
  const db = await makeDb();
  await db.exec(LOT());
  await assert.rejects(db.exec(LOT()), /double application/);
  await db.exec("rollback");

  for (const [label, mutate, pattern] of [
    ["un caractère modifié", (f: string) => f.replace("Commande vide", "Commande vidE"), /SCANYM_PREDECESSOR_DRIFT/],
    ["ancre absente", (f: string) => f.replace("-- CSDJ-3 END", "-- CSDJ-3 FIN"), /SCANYM_PREDECESSOR_DRIFT/],
    ["ancre dupliquée", (f: string) => f.replace("  return query select", "  -- CSDJ-3 END\n  return query select"), /SCANYM_PREDECESSOR_DRIFT/],
  ] as const) {
    const bad = await makeDb(mutate(FIXTURE));
    await assert.rejects(bad.exec(LOT()), pattern, label);
    await bad.exec("rollback");
    const cols = await bad.query<{ n: string }>(`select count(*)::text as n from information_schema.columns where table_schema='public' and column_name in ('vacuum_packable','vacuum_packing_requested')`);
    assert.equal(cols.rows[0].n, "0", `${label} : aucune colonne créée`);
    assert.doesNotMatch(await defOf(bad), /VACUUM-PACKING/, `${label} : create_order intact`);
  }
});

/** Extrait le bloc inséré dans create_order et l'enveloppe dans une fonction de test. */
async function withBlock(db: PGlite) {
  const patched = await defOf(db);
  const start = patched.indexOf("  declare\n    v_vp_raw");
  const endMarker = "  end;\n  -- VACUUM-PACKING END";
  const end = patched.indexOf(endMarker) + "  end;".length;
  assert.ok(start > 0 && end > start, "bloc retrouvé dans create_order");
  const block = patched.slice(start, end);
  await db.exec(`create function public.t_vp(p_customer jsonb, v_order_id uuid) returns void language plpgsql as $t$\n${block}\n$t$;`);
}

async function newOrder(db: PGlite, n: number, items: string[]) {
  await db.query("insert into public.orders(id) values ($1::uuid)", [uuid(1000 + n)]);
  for (const item of items) await db.query("insert into public.order_items(order_id, menu_item_id) values ($1::uuid,$2::uuid)", [uuid(1000 + n), item]);
  return uuid(1000 + n);
}
const flagOf = async (db: PGlite, id: string) =>
  (await db.query<{ f: boolean }>("select vacuum_packing_requested as f from public.orders where id=$1::uuid", [id])).rows[0].f;

test("[VP-SQL-3] le bloc : décoché/absent/null/false => faux ; coché + article éligible => vrai ; sans article éligible => refus typé", async () => {
  const db = await makeDb();
  await db.exec(LOT());
  await withBlock(db);
  await db.query("select public.set_category_vacuum_packable($1::uuid,true)", [CAT_CHEESE]).catch(() => null);
  await db.exec(`update public.menu_categories set vacuum_packable = true where id in ('${CAT_CHEESE}','${CAT_DELI}')`);

  let n = 0;
  for (const [label, customer] of [
    ["clé absente", {}],
    ["null", { vacuum_packing: null }],
    ["false", { vacuum_packing: false }],
  ] as const) {
    const id = await newOrder(db, ++n, [ITEM_CHEESE]);
    await db.query("select public.t_vp($1::jsonb,$2::uuid)", [JSON.stringify(customer), id]);
    assert.equal(await flagOf(db, id), false, `${label} : non demandé`);
  }

  const cheese = await newOrder(db, ++n, [ITEM_CHEESE]);
  await db.query("select public.t_vp($1::jsonb,$2::uuid)", [JSON.stringify({ vacuum_packing: true }), cheese]);
  assert.equal(await flagOf(db, cheese), true, "fromage + coché => demandé");

  const deli = await newOrder(db, ++n, [ITEM_DELI]);
  await db.query("select public.t_vp($1::jsonb,$2::uuid)", [JSON.stringify({ vacuum_packing: true }), deli]);
  assert.equal(await flagOf(db, deli), true, "charcuterie + coché => demandé");

  const mixed = await newOrder(db, ++n, [ITEM_CHEESE, ITEM_DRINK]);
  await db.query("select public.t_vp($1::jsonb,$2::uuid)", [JSON.stringify({ vacuum_packing: true }), mixed]);
  assert.equal(await flagOf(db, mixed), true, "panier mixte : le choix est retenu pour la commande");

  const drinksOnly = await newOrder(db, ++n, [ITEM_DRINK]);
  await assert.rejects(
    db.query("select public.t_vp($1::jsonb,$2::uuid)", [JSON.stringify({ vacuum_packing: true }), drinksOnly]),
    /SCANYM_VACUUM_PACKING_NOT_APPLICABLE/,
  );
  assert.equal(await flagOf(db, drinksOnly), false, "refus : rien n'est écrit");

  for (const bad of ['"true"', "1", "0", '{"a":1}', "[]"]) {
    const id = await newOrder(db, ++n, [ITEM_CHEESE]);
    await assert.rejects(
      db.query("select public.t_vp($1::jsonb,$2::uuid)", [`{"vacuum_packing": ${bad}}`, id]),
      /SCANYM_VACUUM_PACKING_MALFORMED/,
      `valeur non booléenne ${bad}`,
    );
    assert.equal(await flagOf(db, id), false);
  }
});

test("[VP-SQL-4] le choix survit à toutes les transitions de paiement (aucune écriture du paiement ne le touche)", async () => {
  const db = await makeDb();
  await db.exec(LOT());
  await withBlock(db);
  await db.exec(`update public.menu_categories set vacuum_packable = true where id = '${CAT_CHEESE}'`);
  const id = await newOrder(db, 50, [ITEM_CHEESE]);
  await db.query("select public.t_vp($1::jsonb,$2::uuid)", [JSON.stringify({ vacuum_packing: true }), id]);
  for (const state of ["required", "pending", "failed", "pending", "paid", "cancelled"]) {
    await db.query("update public.orders set payment_status=$2 where id=$1::uuid", [id, state]);
    assert.equal(await flagOf(db, id), true, `après payment_status=${state}`);
  }
});

test("[VP-SQL-5] set_category_vacuum_packable : propriétaire/gérant/opérateur oui ; staff, étranger, anonyme, rôle anon non", async () => {
  const db = await makeDb();
  await db.exec(LOT());
  const read = async () => (await db.query<{ f: boolean }>("select vacuum_packable as f from public.menu_categories where id=$1::uuid", [CAT_CHEESE])).rows[0].f;

  for (const user of [OWNER, MANAGER, OPERATOR]) {
    await as(db, user, async (q) => { await q("select public.set_category_vacuum_packable($1::uuid,true)", [CAT_CHEESE]); });
    assert.equal(await read(), true, `${user} active`);
    await as(db, user, async (q) => { await q("select public.set_category_vacuum_packable($1::uuid,false)", [CAT_CHEESE]); });
    assert.equal(await read(), false, `${user} désactive`);
  }
  for (const user of [STAFF, STRANGER]) {
    await assert.rejects(
      as(db, user, async (q) => { await q("select public.set_category_vacuum_packable($1::uuid,true)", [CAT_CHEESE]); }),
      /Not authorized for this category/,
    );
  }
  await assert.rejects(
    as(db, null, async (q) => { await q("select public.set_category_vacuum_packable($1::uuid,true)", [CAT_CHEESE]); }),
    /Authentication required/,
  );
  await assert.rejects(
    as(db, OWNER, async (q) => { await q("select public.set_category_vacuum_packable($1::uuid,null)", [CAT_CHEESE]); }),
    /vacuum_packable is required/,
  );
  await assert.rejects(
    as(db, OWNER, async (q) => { await q("select public.set_category_vacuum_packable($1::uuid,true)", [uuid(999)]); }),
    /Category not found/,
  );
  await assert.rejects(
    as(db, OWNER, async (q) => { await q("select public.set_category_vacuum_packable($1::uuid,true)", [CAT_CHEESE]); }, "anon"),
    /permission denied/,
  );
  assert.equal(await read(), false, "aucun refus n'a écrit");
});

test("[VP-SQL-6] rollback : restaure l'empreinte EXACTE du prédécesseur, retire fonction et colonnes ; refuse de perdre des données", async () => {
  const db = await makeDb();
  await db.exec(LOT());
  await db.exec(ROLLBACK());
  assert.equal(md5(await defOf(db)), PREDECESSOR_MD5, "create_order de nouveau octet pour octet l'audité");
  const left = await db.query<{ n: string }>(`select count(*)::text as n from information_schema.columns where table_schema='public' and column_name in ('vacuum_packable','vacuum_packing_requested')`);
  assert.equal(left.rows[0].n, "0");
  assert.equal((await db.query<{ r: string | null }>("select to_regprocedure('public.set_category_vacuum_packable(uuid,boolean)')::text as r")).rows[0].r, null);
  await assert.rejects(db.exec(ROLLBACK()), /rien à annuler/);
  await db.exec("rollback");

  // Données présentes : retour arrière refusé, tout reste en place.
  const keep = await makeDb();
  await keep.exec(LOT());
  await keep.exec(`update public.menu_categories set vacuum_packable = true where id = '${CAT_CHEESE}'`);
  await assert.rejects(keep.exec(ROLLBACK()), /SCANYM_ROLLBACK_DATA_LOSS/);
  await keep.exec("rollback");
  assert.match(await defOf(keep), /VACUUM-PACKING BEGIN/);

  const keep2 = await makeDb();
  await keep2.exec(LOT());
  await keep2.exec("insert into public.orders(id, vacuum_packing_requested) values ('" + uuid(77) + "', true)");
  await assert.rejects(keep2.exec(ROLLBACK()), /SCANYM_ROLLBACK_DATA_LOSS/);
  await keep2.exec("rollback");
  const still = await keep2.query<{ n: string }>("select count(*)::text as n from public.orders where vacuum_packing_requested");
  assert.equal(still.rows[0].n, "1");
});

test("[VP-SQL-7] rien d'autre que create_order n'écrit le choix : ni paiement, ni notification, ni Monetico", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSyncSafe(dir)) {
      const p = `${dir}/${f}`;
      if (isDir(p)) walk(p);
      else if (/\.(ts|tsx|sql)$/.test(f) && readFileSync(p, "utf8").includes("vacuum_packing_requested")) offenders.push(p);
    }
  };
  for (const d of ["lib/server", "app/api", "supabase"]) walk(d);
  const allowed = [
    "supabase/DRAFT-lot-vacuum-packing-option-v1.sql",
    "supabase/DRAFT-lot-vacuum-packing-option-v1-rollback.sql",
  ];
  assert.deepEqual(offenders.filter((p) => !allowed.includes(p)), [], "aucun autre fichier serveur/SQL ne référence la colonne");
});

import { readdirSync, statSync } from "node:fs";
function readdirSyncSafe(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }
function isDir(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }
