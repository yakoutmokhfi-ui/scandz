// SWCT-AUDIT-01 — SÛRETÉ DES CONTRAINTES SQL (remédiation Planck 2).
//
// Trois cas NÉGATIFS indépendants, rejoués sur la chaîne SQL RÉELLE du
// dépôt dans PGlite. Chacun prouve, par INTROSPECTION du catalogue et
// non par le nom des contraintes :
//   * rejet explicite (message de garde nommé) ;
//   * aucune contrainte supprimée ni affaiblie ;
//   * aucun changement de schéma inattendu (empreinte complète du
//     catalogue, avant/après, octet pour octet) ;
//   * transaction annulée proprement.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeBaseline, readSql } from "../supabase/tests/b5/bootstrap.mjs";

const FORWARD = "DRAFT-lot-delivery-customer-text-1000-v1.sql";
const ROLLBACK = "DRAFT-lot-delivery-customer-text-1000-v1-ROLLBACK.sql";

const BASELINE_DEF = "CHECK (((customer_text IS NULL) OR (length(customer_text) <= 500)))";
const TARGET_DEF = "CHECK (((customer_text IS NULL) OR (length(customer_text) <= 1000)))";

const db = await makeBaseline();
after(async () => db.close());
await db.exec(readSql("DRAFT-lot-delivery-pricing-v2-b5.sql"));
await db.exec(readSql("DRAFT-lot-delivery-rule-delete-v1.sql"));

const RID = "5a fe0000-0000-4000-8000-000000000001".replace(" ", "");
const RULE = "5afe0000-0000-4000-8000-000000000002";
await db.exec(`insert into restaurants(id,name,slug,status,is_active,country)
                 values ('${RID}','Safety A','safe-a','active',true,'FR');
 insert into restaurant_configs(restaurant_id,whatsapp_number,currency,next_order_number)
   values ('${RID}','+33600000000','EUR',1);
 insert into restaurant_sale_modes(restaurant_id,mode_code,enabled,config)
   values ('${RID}','delivery',true,'{}');
 insert into restaurant_sale_mode_fulfillments(id,restaurant_id,mode_code,fulfillment_code,is_fallback,pricing_mode)
   values ('${RULE}','${RID}','delivery','zone-safe',true,'free');`);

/** Empreinte COMPLÈTE des contraintes CHECK des tables concernées :
 *  nom + définition canonique, triées. C'est la mesure « aucun
 *  changement de schéma inattendu », indépendante de tout nom supposé. */
async function constraintFingerprint(): Promise<{ table: string; name: string; def: string }[]> {
  return (
    await db.query<{ table: string; name: string; def: string }>(
      `select c.conrelid::regclass::text "table", c.conname name,
              regexp_replace(pg_get_constraintdef(c.oid), '\\s+', ' ', 'g') def
       from pg_constraint c
       where c.conrelid in (
         'public.restaurant_sale_mode_fulfillments'::regclass,
         'public.order_delivery_fulfillment_snapshot'::regclass,
         'public.restaurant_sale_modes'::regclass)
       order by 1, 2`
    )
  ).rows;
}

/** Définition canonique de l'unique contrainte CHECK mentionnant
 *  customer_text sur une table (null s'il n'y en a pas exactement une). */
async function customerTextChecks(table: string) {
  return (
    await db.query<{ name: string; def: string }>(
      `select c.conname name, regexp_replace(pg_get_constraintdef(c.oid), '\\s+', ' ', 'g') def
       from pg_constraint c
       where c.conrelid = $1::regclass and c.contype = 'c'
         and pg_get_constraintdef(c.oid) like '%customer_text%'
       order by 1`,
      [table]
    )
  ).rows;
}

const fnDef = async () =>
  (
    await db.query<{ def: string }>("select pg_get_functiondef($1::regprocedure) def", [
      "public.update_merchant_delivery_fulfillment_pricing(uuid,text,numeric,numeric,text)",
    ])
  ).rows[0].def;

/** Joue un fichier dont on ATTEND le refus, puis referme la transaction
 *  abandonnée (PGlite garde la connexion ouverte, contrairement à psql
 *  -v ON_ERROR_STOP ou à un runner de migration). */
async function expectRejected(sql: string, pattern: RegExp): Promise<string> {
  let message = "";
  try {
    await db.exec(sql);
  } catch (error) {
    message = (error as Error).message;
  } finally {
    await db.exec("rollback").catch(() => {});
  }
  assert.match(message, pattern, "le fichier devait être refusé en nommant sa garde");
  return message;
}

/** Vérifie qu'après un refus la transaction est bien close et la base
 *  utilisable : une lecture ordinaire doit répondre. */
async function assertTransactionClosed() {
  const r = (await db.query<{ ok: number }>("select 1 ok")).rows[0];
  assert.equal(r.ok, 1, "la session doit être utilisable : transaction annulée proprement");
  const inTx = (
    await db.query<{ s: string }>("select current_setting('transaction_isolation') s")
  ).rows[0];
  assert.ok(inTx.s, "lecture possible hors transaction abandonnée");
}

// ====================================================================
// CAS 1 — UNE BORNE EXISTANTE DE 1500.
// L'ancienne reconnaissance (`like '%500%'`) acceptait cette définition
// (« 1500 » contient « 500 ») et l'aurait REMPLACÉE par 1000, donc
// RESSERRÉE en silence sur un schéma plus permissif.
// ====================================================================

test("[SAFE-01] borne existante de 1500 : REFUS explicite, schéma intact", async () => {
  const before = await constraintFingerprint();
  await db.exec(`alter table public.restaurant_sale_mode_fulfillments
                   drop constraint restaurant_sale_mode_fulfillments_customer_text_check,
                   add constraint restaurant_sale_mode_fulfillments_customer_text_check
                   check (customer_text is null or length(customer_text) <= 1500)`);
  const planted = await customerTextChecks("public.restaurant_sale_mode_fulfillments");
  assert.equal(planted.length, 1);
  assert.equal(planted[0].def, "CHECK (((customer_text IS NULL) OR (length(customer_text) <= 1500)))");

  const message = await expectRejected(readSql(FORWARD), /SCANYM_SCHEMA_DRIFT/);
  // Le message NOMME la définition attendue et la définition lue.
  assert.match(message, /1500/, "le refus doit citer la définition réellement lue");
  assert.match(message, /<= 500/, "le refus doit citer la définition de référence attendue");

  // Rien n'a été supprimé ni affaibli : la contrainte plantée est
  // toujours là, à l'identique.
  const after = await customerTextChecks("public.restaurant_sale_mode_fulfillments");
  assert.deepEqual(after, planted, "la contrainte inconnue doit survivre intacte");
  // …et rien d'autre n'a bougé dans le catalogue : seule la ligne que
  // CE TEST a plantée diffère de l'empreinte initiale.
  const fingerprint = await constraintFingerprint();
  assert.equal(fingerprint.length, before.length, "aucune contrainte ajoutée ni retirée");
  const diff = fingerprint.filter((row, i) => JSON.stringify(row) !== JSON.stringify(before[i]));
  assert.equal(diff.length, 1, "une seule différence : celle plantée par le test");
  assert.match(diff[0].def, /1500/);
  // La garde applicative n'a pas été retouchée.
  assert.match(await fnDef(), /customer_text exceeds 500 characters/);
  await assertTransactionClosed();

  // Remise en état pour la suite.
  await db.exec(`alter table public.restaurant_sale_mode_fulfillments
                   drop constraint restaurant_sale_mode_fulfillments_customer_text_check,
                   add constraint restaurant_sale_mode_fulfillments_customer_text_check
                   check (customer_text is null or length(customer_text) <= 500)`);
  assert.deepEqual(await constraintFingerprint(), before, "état de départ restauré");
});

// ====================================================================
// CAS 2 — CHECK COMBINÉ : borne 500 **et** un prédicat de plus.
// L'ancienne reconnaissance l'acceptait et aurait SUPPRIMÉ le second
// prédicat en silence (le remplacement ne réécrit que la longueur).
// ====================================================================

test("[SAFE-02] CHECK combiné (500 + prédicat supplémentaire) : REFUS, prédicat préservé", async () => {
  const before = await constraintFingerprint();
  await db.exec(`alter table public.restaurant_sale_mode_fulfillments
                   drop constraint restaurant_sale_mode_fulfillments_customer_text_check,
                   add constraint restaurant_sale_mode_fulfillments_customer_text_check
                   check (customer_text is null
                          or (length(customer_text) <= 500 and customer_text !~ '<script'))`);
  const planted = await customerTextChecks("public.restaurant_sale_mode_fulfillments");
  assert.equal(planted.length, 1);
  assert.match(planted[0].def, /script/, "le prédicat supplémentaire est bien en place");
  assert.match(planted[0].def, /<= 500/, "la borne 500 y figure aussi (c'est le piège)");

  const message = await expectRejected(readSql(FORWARD), /SCANYM_SCHEMA_DRIFT/);
  assert.match(message, /script/, "le refus doit citer la définition combinée réellement lue");

  // LE PRÉDICAT SUPPLÉMENTAIRE EST TOUJOURS LÀ, et la contrainte n'a
  // pas été remplacée.
  const after = await customerTextChecks("public.restaurant_sale_mode_fulfillments");
  assert.deepEqual(after, planted, "la contrainte combinée doit survivre, prédicat compris");
  // Et il est toujours OPPOSABLE : une valeur qu'il interdit est encore
  // refusée (preuve de comportement, pas seulement de catalogue).
  await assert.rejects(
    () =>
      db.query("update public.restaurant_sale_mode_fulfillments set customer_text = $1 where id = $2", [
        "<script>alert(1)</script>",
        RULE,
      ]),
    /customer_text_check|violates/i,
    "le prédicat supplémentaire doit toujours refuser ce qu'il refusait"
  );
  assert.equal((await constraintFingerprint()).length, before.length, "aucune contrainte ajoutée ni retirée");
  assert.match(await fnDef(), /customer_text exceeds 500 characters/);
  await assertTransactionClosed();

  await db.exec(`alter table public.restaurant_sale_mode_fulfillments
                   drop constraint restaurant_sale_mode_fulfillments_customer_text_check,
                   add constraint restaurant_sale_mode_fulfillments_customer_text_check
                   check (customer_text is null or length(customer_text) <= 500)`);
  assert.deepEqual(await constraintFingerprint(), before, "état de départ restauré");
});

// ====================================================================
// CAS 3 — LE CHECK DU CLICHÉ MODIFIÉ APRÈS MIGRATION, AVANT ROLLBACK.
// Le rollback doit constater l'état intermédiaire inattendu et S'ARRÊTER
// avant de toucher quoi que ce soit.
// ====================================================================

test("[SAFE-03] cliché modifié entre migration et rollback : REFUS du rollback, schéma intact", async () => {
  // On applique d'abord le lot pour de vrai.
  await db.exec(readSql(FORWARD));
  const applied = await constraintFingerprint();
  assert.equal((await customerTextChecks("public.restaurant_sale_mode_fulfillments"))[0].def, TARGET_DEF);
  assert.equal((await customerTextChecks("public.order_delivery_fulfillment_snapshot"))[0].def, TARGET_DEF);

  // …puis un tiers modifie le CHECK du cliché (ici : 2000).
  await db.exec(`alter table public.order_delivery_fulfillment_snapshot
                   drop constraint odfs_customer_text_length,
                   add constraint odfs_customer_text_length
                   check (customer_text is null or length(customer_text) <= 2000)`);
  const tampered = await constraintFingerprint();

  const message = await expectRejected(readSql(ROLLBACK), /SCANYM_ROLLBACK_DRIFT_GUARD/);
  assert.match(message, /2000/, "le refus doit citer la définition intermédiaire lue");
  assert.match(message, /<= 1000/, "le refus doit citer la définition attendue");

  // RIEN n'a bougé : ni la contrainte source (toujours à 1000), ni le
  // cliché modifié, ni la garde applicative.
  assert.deepEqual(await constraintFingerprint(), tampered, "schéma strictement inchangé par le refus");
  assert.equal((await customerTextChecks("public.restaurant_sale_mode_fulfillments"))[0].def, TARGET_DEF);
  assert.match(await fnDef(), /customer_text exceeds 1000 characters/);
  await assertTransactionClosed();

  // Une fois l'état intermédiaire corrigé, le rollback redevient
  // possible : la garde protège, elle ne bloque pas définitivement.
  await db.exec(`alter table public.order_delivery_fulfillment_snapshot
                   drop constraint odfs_customer_text_length,
                   add constraint odfs_customer_text_length
                   check (customer_text is null or length(customer_text) <= 1000)`);
  assert.deepEqual(await constraintFingerprint(), applied, "état d'après-migration rétabli");
  await db.exec(readSql(ROLLBACK));
  assert.equal((await customerTextChecks("public.restaurant_sale_mode_fulfillments"))[0].def, BASELINE_DEF);
  assert.equal((await customerTextChecks("public.order_delivery_fulfillment_snapshot"))[0].def, BASELINE_DEF);
  assert.match(await fnDef(), /customer_text exceeds 500 characters/);
});

// ====================================================================
// CAS 4 (complémentaire) — contrainte SUPPLÉMENTAIRE sur la colonne.
// Deux CHECK coexistants : l'un d'eux serait ignoré par une
// reconnaissance qui prend « la première trouvée ».
// ====================================================================

test("[SAFE-04] une contrainte CHECK supplémentaire sur la colonne : REFUS, les deux survivent", async () => {
  const before = await constraintFingerprint();
  await db.exec(`alter table public.restaurant_sale_mode_fulfillments
                   add constraint rsmf_customer_text_no_tabs
                   check (customer_text is null or customer_text !~ E'\\t')`);
  const planted = await customerTextChecks("public.restaurant_sale_mode_fulfillments");
  assert.equal(planted.length, 2, "deux contraintes portent désormais sur la colonne");

  const message = await expectRejected(readSql(FORWARD), /SCANYM_SCHEMA_DRIFT/);
  assert.match(message, /2 contrainte/, "le refus doit dire combien de contraintes ont été vues");

  assert.deepEqual(
    await customerTextChecks("public.restaurant_sale_mode_fulfillments"),
    planted,
    "les DEUX contraintes survivent intactes"
  );
  await assertTransactionClosed();

  await db.exec("alter table public.restaurant_sale_mode_fulfillments drop constraint rsmf_customer_text_no_tabs");
  assert.deepEqual(await constraintFingerprint(), before, "état de départ restauré");
});

// ====================================================================
// CAS 5 — LE CHEMIN NOMINAL RESTE VERT (non-régression de la garde).
// ====================================================================

test("[SAFE-05] sur la définition de référence exacte, la migration s'applique toujours", async () => {
  const before = await customerTextChecks("public.restaurant_sale_mode_fulfillments");
  assert.equal(before[0].def, BASELINE_DEF, "on repart bien de la référence");
  await db.exec(readSql(FORWARD));
  assert.equal((await customerTextChecks("public.restaurant_sale_mode_fulfillments"))[0].def, TARGET_DEF);
  assert.equal((await customerTextChecks("public.order_delivery_fulfillment_snapshot"))[0].def, TARGET_DEF);
  // Bornes 1000 / 1001 — le comportement protégé par ce lot.
  await db.query("update public.restaurant_sale_mode_fulfillments set customer_text = $1 where id = $2", ["y".repeat(1000), RULE]);
  assert.equal(
    (await db.query<{ n: number }>("select length(customer_text) n from public.restaurant_sale_mode_fulfillments where id=$1", [RULE])).rows[0].n,
    1000
  );
  await assert.rejects(
    () => db.query("update public.restaurant_sale_mode_fulfillments set customer_text = $1 where id = $2", ["y".repeat(1001), RULE]),
    /customer_text|violates/i
  );
  // Et le texte PAR MODE est toujours à sa définition de référence.
  assert.equal((await customerTextChecks("public.restaurant_sale_modes"))[0].def, BASELINE_DEF);
});
