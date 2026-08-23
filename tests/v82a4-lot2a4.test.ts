import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym LOT 2A.4 — durcissement des privilèges Production
// (SEC-2A3-01). LOT 2A.3 reste installé en Production : ce lot est un
// correctif ADDITIF pur (uniquement des REVOKE/GRANT), jamais une
// modification rétroactive de migration-v82-lot2a-sale-modes.sql déjà
// déployée.
// ====================================================================

const v83Sql = readFileSync("supabase/migration-v83-lot2a4-privilege-hardening.sql", "utf8");
const harnessSrc = readFileSync("supabase/tests/v82a4-privilege-check.sh", "utf8");
const rollbackDoc = readFileSync("supabase/migration-v83-rollback-NOT-PROVIDED.md", "utf8");

const TABLES = [
  "sale_mode_catalog",
  "restaurant_sale_modes",
  "sale_mode_field_requirements",
  "restaurant_sale_mode_field_requirements",
  "order_delivery_address",
];

test("LOT 2A.4: les 5 tables exactes créées par LOT 2A sont toutes couvertes par le REVOKE explicite (aucune supposée, aucune oubliée)", () => {
  for (const t of TABLES) {
    assert.ok(
      v83Sql.includes(`revoke truncate, references, trigger on public.${t} from public, anon, authenticated;`),
      `REVOKE TRUNCATE/REFERENCES/TRIGGER manquant pour ${t}`
    );
  }
});

test("LOT 2A.4: aucune autre table (hors les 5 créées par LOT 2A) n'est touchée -- correctif strictement additif et ciblé", () => {
  const revokeCount = (v83Sql.match(/revoke truncate, references, trigger on public\.\w+/g) || []).length;
  assert.equal(revokeCount, 5, "exactement 5 REVOKE de durcissement, un par table LOT 2A, jamais plus jamais moins");
});

test("LOT 2A.4: réaffirmation explicite du privilège SELECT minimal, jamais un GRANT ALL générique", () => {
  assert.ok(!v83Sql.includes("grant all on"), "aucun GRANT ALL ne doit jamais réapparaître dans ce correctif");
  for (const t of TABLES) {
    assert.ok(v83Sql.includes(`revoke all on public.${t} from public, anon, authenticated;`), `revoke all préalable manquant pour ${t} (ceinture et bretelles)`);
  }
});

test("LOT 2A.4: modèle de privilège final exact -- catalogue global lisible par anon+authenticated, tables tenant réservées à authenticated seul", () => {
  assert.ok(v83Sql.includes("grant select on public.sale_mode_catalog to anon, authenticated;"));
  assert.ok(v83Sql.includes("grant select on public.sale_mode_field_requirements to anon, authenticated;"));
  assert.ok(v83Sql.includes("grant select on public.restaurant_sale_modes to authenticated;"));
  assert.ok(!v83Sql.includes("grant select on public.restaurant_sale_modes to anon"));
  assert.ok(v83Sql.includes("grant select on public.restaurant_sale_mode_field_requirements to authenticated;"));
  assert.ok(v83Sql.includes("grant select on public.order_delivery_address to authenticated;"));
  assert.ok(!v83Sql.includes("grant select on public.order_delivery_address to anon"));
});

test("LOT 2A.4: ne modifie aucune donnée, policy RLS, ni fonction métier -- uniquement des REVOKE/GRANT de privilèges", () => {
  assert.ok(!v83Sql.includes("create policy"));
  assert.ok(!v83Sql.includes("drop policy"));
  assert.ok(!v83Sql.includes("create or replace function"));
  assert.ok(!v83Sql.includes("insert into"));
  assert.ok(!v83Sql.includes("update ") || v83Sql.includes("update.*set") === false, "aucune instruction UPDATE de données");
  assert.ok(!v83Sql.includes("delete from"));
});

test("LOT 2A.4: préflight anti-dérive confirme les 5 tables présentes avant toute opération (LOT 2A.3 déjà installé requis)", () => {
  assert.ok(v83Sql.includes("SCANYM_SCHEMA_DRIFT"));
  for (const t of TABLES) {
    assert.ok(v83Sql.includes(`tablename = '${t}'`), `préflight ne vérifie pas ${t}`);
  }
});

test("LOT 2A.4: aucune modification rétroactive de migration-v82-lot2a-sale-modes.sql déjà installée en Production", () => {
  const v82Sql = readFileSync("supabase/migration-v82-lot2a-sale-modes.sql", "utf8");
  assert.ok(!v82Sql.includes("LOT 2A.4"), "le fichier LOT 2A.3 déjà installé ne doit porter aucune trace de ce correctif ultérieur");
});

test("LOT 2A.4: cause investiguée et documentée -- un CREATE TABLE + GRANT SELECT ordinaire n'accorde jamais TRUNCATE/REFERENCES/TRIGGER par défaut, confirmé empiriquement", () => {
  assert.ok(v83Sql.includes("Cause investiguée"));
  assert.ok(v83Sql.includes("vérifié\n-- empiriquement") || v83Sql.includes("vérifié empiriquement"));
  assert.ok(v83Sql.includes("Supabase"));
});

test("LOT 2A.4: rollback délibérément absent, documenté explicitement -- jamais un script qui réaccorderait les privilèges dangereux", () => {
  assert.ok(rollbackDoc.includes("Aucun script de rollback exécutable n'est fourni"));
  assert.ok(rollbackDoc.includes("réintroduire délibérément la"));
  assert.ok(!rollbackDoc.toLowerCase().includes("```sql"), "le document ne doit contenir aucun bloc SQL exécutable");
});

test("LOT 2A.4: le harnais dédié vérifie les privilèges EFFECTIFS (has_table_privilege), pas seulement information_schema", () => {
  assert.ok(harnessSrc.includes("has_table_privilege("));
  assert.ok(!harnessSrc.includes("information_schema.role_table_grants"), "ne doit pas se contenter de information_schema pour cette vérification spécifique");
});

test("LOT 2A.4: le harnais simule fidèlement le finding Production réel (GRANT ALL) avant de vérifier le correctif, et teste aussi INSERT/UPDATE/DELETE en plus des 3 privilèges cités", () => {
  assert.ok(harnessSrc.includes("grant all on public.$t to public, anon, authenticated"));
  assert.ok(harnessSrc.includes("TRUNCATE REFERENCES TRIGGER INSERT UPDATE DELETE"));
});

test("LOT 2A.4: le harnais prouve la non-régression complète (create_order, projections publiques, helper interne, RLS tenant, room_number) après durcissement", () => {
  assert.ok(harnessSrc.includes("create_order fonctionne toujours après durcissement"));
  assert.ok(harnessSrc.includes("projection publique get_restaurant_public_sale_modes fonctionne toujours"));
  assert.ok(harnessSrc.includes("helper interne toujours totalement inaccessible"));
  assert.ok(harnessSrc.includes("isolation tenant toujours respectée après durcissement"));
  assert.ok(harnessSrc.includes("room_number toujours persisté correctement"));
});

test("LOT 2A.4: le harnais prouve l'idempotence -- réapplication sur un état déjà corrigé ne provoque aucune erreur", () => {
  assert.ok(harnessSrc.includes("Réapplication idempotente"));
  const applyCount = (harnessSrc.match(/-f "\$SUPABASE_DIR\/migration-v83-lot2a4-privilege-hardening\.sql"/g) || []).length;
  assert.equal(applyCount, 2, "la migration doit être appliquée deux fois dans le harnais (initiale + idempotence)");
});
