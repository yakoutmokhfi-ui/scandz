import assert from "node:assert/strict";

interface CatalogClient { query(sql: string): Promise<{ rows: unknown[] }> }
/** Test oracle, independent of the install/rollback manifest implementation.
 * Reads real catalogs and persisted rows before/after the attempted rollback.
 * Never trusts the stored manifest as evidence that the catalog is unchanged. */
export async function readCgvChannelActualState(db: CatalogClient): Promise<Record<string, unknown>> {
  const state: Record<string, unknown> = {};
  const relations = "select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'";
  const routines = "select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','auth')";
  const queries: Record<string,string> = {
    relations: `select to_jsonb(c)-'reltuples'-'relpages'-'relallvisible'-'relallfrozen'-'relfrozenxid'-'relminmxid' as object from pg_class c where c.oid in (${relations}) order by c.oid`,
    attributes: `select to_jsonb(a) as object from pg_attribute a where a.attrelid in (${relations}) order by a.attrelid,a.attnum`,
    defaults: `select to_jsonb(d) as object, pg_get_expr(d.adbin,d.adrelid) as expression from pg_attrdef d where d.adrelid in (${relations}) order by d.oid`,
    constraints: `select to_jsonb(c) as object, pg_get_constraintdef(c.oid) as definition from pg_constraint c where c.conrelid in (${relations}) or c.confrelid in (${relations}) order by c.oid`,
    indexes: `select to_jsonb(i) as object from pg_index i where i.indrelid in (${relations}) order by i.indexrelid`,
    routines: `select to_jsonb(p) as object from pg_proc p where p.oid in (${routines}) order by p.oid`,
    dependencies: `select to_jsonb(d) as object from pg_depend d where (d.classid='pg_class'::regclass and d.objid in (${relations})) or (d.refclassid='pg_class'::regclass and d.refobjid in (${relations})) or (d.classid='pg_proc'::regclass and d.objid in (${routines})) or (d.refclassid='pg_proc'::regclass and d.refobjid in (${routines})) order by d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype`,
    sharedDependencies: `select to_jsonb(d) as object from pg_shdepend d where (d.classid='pg_class'::regclass and d.objid in (${relations})) or (d.classid='pg_proc'::regclass and d.objid in (${routines})) order by d.dbid,d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.deptype`,
    descriptions: "select to_jsonb(d) as object from pg_description d order by d.classoid,d.objoid,d.objsubid",
    securityLabels: "select to_jsonb(s) as object from pg_seclabel s order by s.classoid,s.objoid,s.objsubid,s.provider",
    policies: `select to_jsonb(p) as object from pg_policy p where p.polrelid in (${relations}) order by p.oid`,
    triggers: `select to_jsonb(t) as object from pg_trigger t where t.tgrelid in (${relations}) order by t.oid`,
    statistics: "select to_jsonb(s) as object from pg_statistic_ext s join pg_namespace n on n.oid=s.stxnamespace where n.nspname='public' order by s.oid",
    sequences: `select to_jsonb(s) as object from pg_sequence s where s.seqrelid in (${relations}) order by s.seqrelid`,
    publications: "select to_jsonb(p) as object from pg_publication p order by p.oid",
    publicationRelations: "select to_jsonb(p) as object from pg_publication_rel p order by p.oid",
    publicationSchemas: "select to_jsonb(p) as object from pg_publication_namespace p order by p.oid",
  };
  for (const [key,sql] of Object.entries(queries)) state[key]=(await db.query(sql)).rows;
  const present = await db.query("select to_regclass('public.cgv_merchant_channel_guard_manifest') as manifest");
  if ((present.rows[0] as {manifest: unknown})?.manifest) state.manifestRows = (await db.query("select * from public.cgv_merchant_channel_guard_manifest order by id")).rows;
  return state;
}
export async function assertCgvChannelActualStateUnchanged(db: CatalogClient, before: Record<string,unknown>) {
  const after=await readCgvChannelActualState(db);
  for(const key of Object.keys(before)) assert.deepEqual(after[key],before[key],`Rollback mutated actual catalog/data: ${key}`);
}
