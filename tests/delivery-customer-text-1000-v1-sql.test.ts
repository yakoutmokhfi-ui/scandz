// DELIVERY CUSTOMER TEXT 1000 v1 -- real B1..B5 + DELIVERY RULE DELETE v1
// SQL chain in PGlite, plus the DRAFT forward and rollback migrations.
// Nothing is mocked: the constraints, the writer, the public projection
// RPC, create_order and the order snapshot are the repository's own.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeBaseline, readSql } from "../supabase/tests/b5/bootstrap.mjs";
import { DELIVERY_RULE_CUSTOMER_TEXT_MAX_LENGTH } from "../lib/delivery-rule-editor.ts";

const FORWARD = "DRAFT-lot-delivery-customer-text-1000-v1.sql";
const ROLLBACK = "DRAFT-lot-delivery-customer-text-1000-v1-ROLLBACK.sql";

const db = await makeBaseline();
after(async () => db.close());
await db.exec(readSql("DRAFT-lot-delivery-pricing-v2-b5.sql"));
await db.exec(readSql("DRAFT-lot-delivery-rule-delete-v1.sql"));

const id = (n: number) => `cf100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = id(1);
const owner = id(2);
const category = id(3);
const item = id(4);

await db.exec(`insert into auth.users(id,email) values ('${owner}','ct-owner@example.test');
 insert into restaurants(id,name,slug,status,is_active,country) values ('${A}','Customer Text A','ct-a','active',true,'FR');
 insert into restaurant_users(restaurant_id,user_id,role) values ('${A}','${owner}','owner');
 insert into restaurant_configs(restaurant_id,whatsapp_number,currency,next_order_number) values ('${A}','+33600000000','EUR',1);
 insert into restaurant_sale_modes(restaurant_id,mode_code,enabled,config) values ('${A}','delivery',true,'{}'),('${A}','pickup',true,'{}');
 insert into restaurant_delivery_countries(restaurant_id,country_code) values ('${A}','FR');
 insert into menu_categories(id,restaurant_id,name) values ('${category}','${A}','Fixture');
 insert into menu_items(id,category_id,name,price,tax_rate,is_available) values ('${item}','${category}','Product',20,5.5,true);`);

/** A deterministic text of EXACTLY `n` characters. */
const textOf = (n: number) => "x".repeat(n);
const AT_LIMIT = textOf(1000);
const OVER_LIMIT = textOf(1001);

async function asOwner(sql: string, args: unknown[] = []) {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('test.uid',$1,true)", [owner]);
    await tx.exec("set local role authenticated");
    return tx.query<Record<string, any>>(sql, args);
  });
}

const rulePayload = (customerText: string | null) => ({
  zones: [] as string[],
  fulfillmentCode: "zone-ct",
  provider: "internal",
  enabled: true,
  isFallback: true,
  pricingMode: "fixed",
  fixedFee: 5,
  freeThreshold: null,
  customerText,
  minItems: null,
});

async function saveRule(customerText: string | null, ruleId: string | null = null) {
  return asOwner("select public.mutate_merchant_delivery_rule($1,'save',$2,$3::jsonb) id", [
    A,
    ruleId,
    JSON.stringify(rulePayload(customerText)),
  ]);
}

const constraintDef = async (table: string, name: string) =>
  (
    await db.query<{ d: string | null }>(
      `select pg_get_constraintdef(c.oid) d from pg_constraint c
       where c.conrelid = $1::regclass and c.conname = $2`,
      [table, name]
    )
  ).rows[0]?.d ?? null;

const lengthConstraints = async (table: string) =>
  (
    await db.query<{ conname: string; d: string }>(
      `select c.conname, pg_get_constraintdef(c.oid) d from pg_constraint c
       where c.conrelid = $1::regclass and c.contype='c'
         and pg_get_constraintdef(c.oid) like '%customer_text%length%'`,
      [table]
    )
  ).rows;

const fnDef = async () =>
  (
    await db.query<{ def: string }>(
      "select pg_get_functiondef($1::regprocedure) def",
      ["public.update_merchant_delivery_fulfillment_pricing(uuid,text,numeric,numeric,text)"]
    )
  ).rows[0].def;

/**
 * Joue un fichier de migration dont on ATTEND l'échec, puis referme la
 * transaction abandonnée.
 *
 * Pourquoi c'est nécessaire ici et pas en production : ces fichiers
 * ouvrent `begin;` en première instruction (sûreté transactionnelle) et
 * une garde qui lève laisse donc la SESSION dans une transaction
 * abandonnée. `psql -v ON_ERROR_STOP=1` ou un runner de migration
 * quittent alors le processus ; PGlite, lui, garde la connexion
 * ouverte, et toute requête suivante échouerait avec « current
 * transaction is aborted ». Ce `rollback` explicite ne concerne QUE le
 * banc d'essai -- il ne compense rien, puisque la garde a précisément
 * empêché toute écriture (ce que les assertions qui suivent vérifient).
 */
async function execExpectFail(sql: string, pattern: RegExp): Promise<void> {
  let message = "";
  try {
    await db.exec(sql);
  } catch (error) {
    message = (error as Error).message;
  } finally {
    await db.exec("rollback").catch(() => {});
  }
  assert.match(message, pattern, "le fichier devait échouer, en nommant sa garde");
}

// ====================================================================
// 1. BASELINE -- the state this lot starts from, proven, not assumed.
// ====================================================================

test("[CT-01] baseline : la borne source, le cliché et la garde applicative sont à 500", async () => {
  const src = await lengthConstraints("public.restaurant_sale_mode_fulfillments");
  assert.equal(src.length, 1, "une seule contrainte de longueur sur la colonne source");
  assert.match(src[0].d, /500/);
  assert.match((await constraintDef("public.order_delivery_fulfillment_snapshot", "odfs_customer_text_length"))!, /500/);
  assert.match(await fnDef(), /customer_text exceeds 500 characters/);
});

test("[CT-02] baseline : 501 caractères sont DÉJÀ refusés (la borne est réelle, pas décorative)", async () => {
  await assert.rejects(() => saveRule(textOf(501)), /customer_text|check constraint/i);
});

// ====================================================================
// 2. THE MIGRATION.
// ====================================================================

test("[CT-03] le DRAFT s'applique sur la chaîne réelle, et porte les trois bornes à 1000", async () => {
  await db.exec(readSql(FORWARD));

  const src = await lengthConstraints("public.restaurant_sale_mode_fulfillments");
  assert.equal(src.length, 1, "toujours UNE seule contrainte -- jamais l'ancienne + la nouvelle");
  assert.equal(src[0].conname, "rsmf_customer_text_length");
  assert.match(src[0].d, /1000/);
  assert.doesNotMatch(src[0].d, /500/);

  assert.match((await constraintDef("public.order_delivery_fulfillment_snapshot", "odfs_customer_text_length"))!, /1000/);

  const def = await fnDef();
  assert.match(def, /customer_text exceeds 1000 characters/);
  assert.doesNotMatch(def, /exceeds 500 characters/);
});

test("[CT-04] la retouche chirurgicale n'a rien emporté : SECURITY DEFINER, privilèges, règles tarifaires", async () => {
  const def = await fnDef();
  assert.match(def, /SECURITY DEFINER/i);
  // Les règles voisines du corps sont intactes (échantillon nominatif).
  assert.match(def, /free_threshold is required and must be >= 0/);
  assert.match(def, /42501|SCANYM|authorized|owner/i);
  const acl = (
    await db.query<{ anon: boolean; auth: boolean }>(
      `select has_function_privilege('anon',$1,'execute') anon,
              has_function_privilege('authenticated',$1,'execute') auth`,
      ["public.update_merchant_delivery_fulfillment_pricing(uuid,text,numeric,numeric,text)"]
    )
  ).rows[0];
  assert.equal(acl.anon, false, "anon ne doit jamais exécuter la RPC d'écriture");
  assert.equal(acl.auth, true, "authenticated garde EXECUTE (autorisation jugée dans le corps)");
});

test("[CT-05] anti-double-application : rejouer le DRAFT est REFUSÉ, sans rien changer", async () => {
  await execExpectFail(readSql(FORWARD), /SCANYM_ALREADY_APPLIED/);
  const src = await lengthConstraints("public.restaurant_sale_mode_fulfillments");
  assert.equal(src.length, 1);
  assert.match(src[0].d, /1000/);
});

// ====================================================================
// 3. 1000 CHARACTERS: SAVED, PROJECTED, SNAPSHOTTED. 1001: REJECTED.
// ====================================================================

let ruleId = "";

test("[CT-06] un texte client de 1000 caractères est ENREGISTRÉ par le writer réel", async () => {
  const saved = await saveRule(AT_LIMIT);
  ruleId = saved.rows[0].id;
  assert.ok(ruleId, "la règle doit être créée");
  const row = (
    await db.query<{ len: number; txt: string }>(
      "select length(customer_text) len, customer_text txt from public.restaurant_sale_mode_fulfillments where id=$1",
      [ruleId]
    )
  ).rows[0];
  assert.equal(row.len, 1000, "stocké ENTIER, jamais tronqué");
  assert.equal(row.txt, AT_LIMIT);
});

test("[CT-07] 1001 caractères sont REFUSÉS -- jamais tronqués à 1000", async () => {
  await assert.rejects(() => saveRule(OVER_LIMIT, ruleId), /customer_text|check constraint/i);
  // …et la valeur précédente est intacte : un refus n'écrit rien.
  const len = (
    await db.query<{ len: number }>(
      "select length(customer_text) len from public.restaurant_sale_mode_fulfillments where id=$1",
      [ruleId]
    )
  ).rows[0].len;
  assert.equal(len, 1000);
});

test("[CT-08] la RPC d'écriture historique accepte 1000 et refuse 1001, avec le message à jour", async () => {
  const ok = await asOwner(
    "select public.update_merchant_delivery_fulfillment_pricing($1,'fixed',5,null,$2)",
    [ruleId, AT_LIMIT]
  );
  assert.ok(ok, "1000 caractères acceptés par la garde applicative");
  await assert.rejects(
    () =>
      asOwner("select public.update_merchant_delivery_fulfillment_pricing($1,'fixed',5,null,$2)", [
        ruleId,
        OVER_LIMIT,
      ]),
    /customer_text exceeds 1000 characters/
  );
});

test("[CT-09] la projection PUBLIQUE anonyme renvoie les 1000 caractères, entiers", async () => {
  const rows = await db.transaction(async (tx) => {
    await tx.exec("set local role anon");
    return (
      await tx.query<{ customer_text: string | null }>(
        "select customer_text from public.get_restaurant_public_delivery_fulfillments($1)",
        [A]
      )
    ).rows;
  });
  const texts = rows.map((r) => r.customer_text).filter((t): t is string => t !== null);
  assert.ok(texts.includes(AT_LIMIT), "le texte complet doit sortir par la projection publique");
  assert.equal(texts.find((t) => t.length === 1000)?.length, 1000);
});

test("[CT-10] une commande RÉELLE portant ce texte garde les 1000 caractères dans son CLICHÉ", async () => {
  // Parcours client complet : `create_order` résout la règle, applique
  // le tarif et ÉCRIT le cliché en recopiant `customer_text` de la
  // règle retenue. C'est précisément ce chemin qui aurait échoué si le
  // CHECK du cliché était resté à 500.
  const customer = {
    first_name: "Ada",
    last_name: "Lovelace",
    phone: "0612345678",
    email: "ada@example.test",
    address: "1 rue Test, 75001 Paris",
    postalCode: "75001",
    street: "1 rue Test",
    city: "Paris",
    country: "FR",
  };
  const order = await db.transaction(async (tx) => {
    await tx.exec("set local role anon");
    return (
      await tx.query<{ order_id: string }>(
        `select order_id from public.create_order('ct-a','delivery',$1::jsonb,null,$2::jsonb,null,'fr',false)`,
        [JSON.stringify([{ menu_item_id: item, quantity: 1 }]), JSON.stringify(customer)]
      )
    ).rows[0];
  });
  assert.ok(order?.order_id, "la commande doit être créée");

  const snap = (
    await db.query<{ len: number | null; txt: string | null }>(
      "select length(customer_text) len, customer_text txt from public.order_delivery_fulfillment_snapshot where order_id=$1",
      [order.order_id]
    )
  ).rows[0];
  assert.equal(snap.len, 1000, "le cliché garde le texte ENTIER, jamais tronqué");
  assert.equal(snap.txt, AT_LIMIT);
});

test("[CT-11] le cliché REFUSE 1001 caractères -- la cohérence va dans les deux sens", async () => {
  const rows = (
    await db.query<{ n: number }>("select count(*)::int n from public.order_delivery_fulfillment_snapshot")
  ).rows[0].n;
  assert.ok(rows > 0, "le cliché de CT-10 doit exister pour que ce test ait un sens");
  await assert.rejects(
    () => db.query("update public.order_delivery_fulfillment_snapshot set customer_text = $1", [OVER_LIMIT]),
    /odfs_customer_text_length|customer_text|violates/i
  );
  // …et la valeur reste celle de la commande : un refus n'écrit rien.
  const len = (
    await db.query<{ len: number }>("select max(length(customer_text)) len from public.order_delivery_fulfillment_snapshot")
  ).rows[0].len;
  assert.equal(len, 1000);
});

// ====================================================================
// 4. OUT OF SCOPE: UNTOUCHED.
// ====================================================================

test("[CT-12] le texte générique PAR MODE reste borné à 500 (hors périmètre)", async () => {
  const perMode = await lengthConstraints("public.restaurant_sale_modes");
  assert.equal(perMode.length, 1);
  assert.match(perMode[0].d, /500/);
  assert.doesNotMatch(perMode[0].d, /1000/);
});

/** SQL réellement EXÉCUTÉ : commentaires `--` retirés. Les en-têtes de
 *  ce dépôt NOMMENT ce qu'ils ne touchent pas ; les confondre avec du
 *  code produirait un faux positif. */
const executable = (sql: string) =>
  sql
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i < 0 ? line : line.slice(0, i);
    })
    .join("\n");

test("[CT-13] le writer de règles de B5 / DELETE v1 n'est pas touché par ce lot", async () => {
  const forward = executable(readSql(FORWARD));
  const rollback = executable(readSql(ROLLBACK));
  for (const [name, sql] of [
    ["aller", forward],
    ["rollback", rollback],
  ] as const) {
    assert.doesNotMatch(
      sql,
      /create (or replace )?function public\.mutate_merchant_delivery_rule/,
      `${name} ne doit pas redéfinir le writer de règles`
    );
    assert.doesNotMatch(
      sql,
      /create (or replace )?function public\.create_order/,
      `${name} ne doit pas redéfinir create_order`
    );
    assert.doesNotMatch(sql, /update_merchant_delivery_method_notice/, `${name} : notice par mode hors périmètre`);
  }
  assert.ok(
    (await db.query<{ ok: boolean }>("select to_regprocedure($1) is not null ok", [
      "public.mutate_merchant_delivery_rule(uuid,text,uuid,jsonb)",
    ])).rows[0].ok
  );
});

test("[CT-14] la borne SQL est le MIROIR EXACT de la borne client", async () => {
  assert.equal(DELIVERY_RULE_CUSTOMER_TEXT_MAX_LENGTH, 1000);
  const src = (await lengthConstraints("public.restaurant_sale_mode_fulfillments"))[0].d;
  assert.ok(
    src.includes(String(DELIVERY_RULE_CUSTOMER_TEXT_MAX_LENGTH)),
    "le CHECK doit porter exactement la borne exportée par lib/delivery-rule-editor.ts"
  );
});

// ====================================================================
// 5. ROLLBACK -- fail closed on real merchant data, then clean.
// ====================================================================

test("[CT-15] le rollback REFUSE tant qu'un texte de plus de 500 caractères existe", async () => {
  await execExpectFail(readSql(ROLLBACK), /SCANYM_ROLLBACK_BLOCKED/);
  // Rien n'a bougé : la borne est toujours à 1000, la donnée intacte.
  const src = (await lengthConstraints("public.restaurant_sale_mode_fulfillments"))[0];
  assert.match(src.d, /1000/);
  const len = (
    await db.query<{ len: number }>(
      "select length(customer_text) len from public.restaurant_sale_mode_fulfillments where id=$1",
      [ruleId]
    )
  ).rows[0].len;
  assert.equal(len, 1000);
});

test("[CT-16] après décision explicite, le rollback restaure 500 partout", async () => {
  await db.exec("update public.restaurant_sale_mode_fulfillments set customer_text = 'court' where customer_text is not null");
  await db.exec("delete from public.order_delivery_fulfillment_snapshot where length(customer_text) > 500");
  await db.exec(readSql(ROLLBACK));

  const src = await lengthConstraints("public.restaurant_sale_mode_fulfillments");
  assert.equal(src.length, 1);
  assert.match(src[0].d, /500/);
  assert.doesNotMatch(src[0].d, /1000/);
  assert.match((await constraintDef("public.order_delivery_fulfillment_snapshot", "odfs_customer_text_length"))!, /500/);
  const def = await fnDef();
  assert.match(def, /customer_text exceeds 500 characters/);
  assert.doesNotMatch(def, /exceeds 1000 characters/);
  // …et 501 redevient un refus.
  await assert.rejects(() => saveRule(textOf(501)), /customer_text|check constraint/i);
  // Hors périmètre toujours là.
  assert.ok(
    (await db.query<{ ok: boolean }>("select to_regprocedure($1) is not null ok", [
      "public.mutate_merchant_delivery_rule(uuid,text,uuid,jsonb)",
    ])).rows[0].ok
  );
});

test("[CT-17] rejouer le rollback est refusé (rien à annuler), sans rien changer", async () => {
  await execExpectFail(readSql(ROLLBACK), /SCANYM_ROLLBACK_DRIFT_GUARD|SCANYM_NOTHING_TO_ROLL_BACK/);
  assert.match((await lengthConstraints("public.restaurant_sale_mode_fulfillments"))[0].d, /500/);
});
