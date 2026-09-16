import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// Scanym — CATALOGUE — COLLECTIONS / TAGS FOUNDATION v1.
//
// Deux natures de preuve, jamais mélangées :
//   - logique TS PURE de résolution des tags (tag-resolution.ts) ;
//   - propriétés STRUCTURELLES du SQL publié, c'est-à-dire ce qu'une
//     exécution ne peut pas prouver : l'absence de chemin alternatif
//     dangereux dans le texte source.
//
// La preuve COMPORTEMENTALE (autorisation marchand/opérateur réelle,
// isolation tenant réelle, idempotence réelle, rollback réel) est
// apportée par supabase/tests/catalogue-collections-tags-v1-check.sh
// contre un PostgreSQL réel jetable -- jamais dupliquée ici.
// ====================================================================

const { resolveTagsForRow, countTagsToCreate } = await import(
  "../lib/catalogue-import/tag-resolution.ts"
);

const SQL = readFileSync(
  new URL("../supabase/DRAFT-lot-catalogue-collections-tags-foundation-v1.sql", import.meta.url),
  "utf8"
);
const SQL_LOWER = SQL.toLowerCase();
const ROLLBACK = readFileSync(
  new URL("../supabase/DRAFT-lot-catalogue-collections-tags-foundation-v1-ROLLBACK.sql", import.meta.url),
  "utf8"
);

/** Retire les lignes ENTIÈREMENT commentées : les preuves d'ORDRE et
 *  d'ABSENCE doivent porter sur les INSTRUCTIONS, jamais sur l'en-tête
 *  qui décrit délibérément en prose ce que le fichier fait. */
function execOnly(sql: string): string {
  return sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .toLowerCase();
}
const SQL_EXEC = execOnly(SQL);
const ROLLBACK_EXEC = execOnly(ROLLBACK);

// ------------------------------------------------------------------
// Résolution TS pure
// ------------------------------------------------------------------

test("[TAGS] un tag inconnu résout WOULD_CREATE ; un tag connu résout EXISTING avec son id", () => {
  const existing = [{ id: "t1", name: "Bio" }];
  assert.deepEqual(resolveTagsForRow(existing, ["Bio"]), [
    { state: "EXISTING", displayName: "Bio", existingId: "t1" },
  ]);
  assert.deepEqual(resolveTagsForRow(existing, ["Truffe"]), [
    { state: "WOULD_CREATE", displayName: "Truffe" },
  ]);
});

test("[TAGS] la correspondance est insensible à la casse et aux espaces de BORDURE -- règle identique à normalizedKey et à l'index unique partiel", () => {
  const existing = [{ id: "t1", name: "Bio" }];
  for (const variant of ["bio", "BIO", "  Bio  ", "\tbio\n"]) {
    assert.deepEqual(
      resolveTagsForRow(existing, [variant]),
      [{ state: "EXISTING", displayName: "Bio", existingId: "t1" }],
      `variante « ${variant} » aurait dû correspondre`
    );
  }
});

test("[TAGS] le nom AFFICHÉ d'un tag EXISTING est celui de la BASE, jamais la casse du fichier (la base fait foi)", () => {
  const existing = [{ id: "t1", name: "Bio" }];
  const [r] = resolveTagsForRow(existing, ["BIO"]);
  assert.equal(r.displayName, "Bio");
});

test("[TAGS] les accents ne sont JAMAIS dépouillés -- « Café » et « Cafe » restent deux tags distincts, exactement comme en base", () => {
  const existing = [{ id: "t1", name: "Cafe" }];
  assert.deepEqual(resolveTagsForRow(existing, ["Café"]), [
    { state: "WOULD_CREATE", displayName: "Café" },
  ]);
});

test("[TAGS] déduplication insensible à la casse À L'INTÉRIEUR d'une ligne, ordre de première apparition conservé", () => {
  const out = resolveTagsForRow([], ["Bio", "bio", "  BIO  ", "Truffe"]);
  assert.deepEqual(out, [
    { state: "WOULD_CREATE", displayName: "Bio" },
    { state: "WOULD_CREATE", displayName: "Truffe" },
  ]);
});

test("[TAGS] valeurs vides ou entièrement blanches ignorées", () => {
  assert.deepEqual(resolveTagsForRow([], ["", "   ", "\t"]), []);
});

test("[TAGS] countTagsToCreate déduplique ENTRE lignes -- vingt produits « Bio » ne créent qu'un seul tag", () => {
  const byRow = new Map<number, ReturnType<typeof resolveTagsForRow>>();
  for (let i = 2; i <= 21; i++) byRow.set(i, resolveTagsForRow([], ["Bio"]));
  byRow.set(22, resolveTagsForRow([], ["Truffe"]));
  assert.equal(countTagsToCreate(byRow), 2);
});

test("[TAGS] aucun état AMBIGUOUS n'est produisible : l'index unique partiel interdit deux tags ACTIFS de même clé", () => {
  const existing = [
    { id: "t1", name: "Bio" },
    { id: "t2", name: "bio" },
  ];
  const [r] = resolveTagsForRow(existing, ["Bio"]);
  assert.equal(r.state, "EXISTING");
  assert.equal(r.existingId, "t1", "premier gagnant, déterministe");
});

// ------------------------------------------------------------------
// Propriétés structurelles du SQL
// ------------------------------------------------------------------

test("[SQL/§1] visible_on_customer_menu vaut false par DÉFAUT -- importer un tag ne publie jamais une collection", () => {
  assert.match(SQL_EXEC, /visible_on_customer_menu\s+boolean\s+not null\s+default\s+false/);
  // add_product_tags ne doit JAMAIS écrire cette colonne.
  const fn = SQL_EXEC.slice(
    SQL_EXEC.indexOf("function public.add_product_tags"),
    SQL_EXEC.indexOf("function public.update_tag_collection_settings")
  );
  assert.equal(fn.includes("visible_on_customer_menu"), false);
});

test("[SQL/§2] menu_tags.restaurant_id est NOT NULL -- aucun tag global partagé entre établissements", () => {
  assert.match(SQL_EXEC, /restaurant_id\s+uuid\s+not null\s+references public\.restaurants\(id\) on delete cascade/);
});

test("[SQL/§3] l'autorisation accepte le MARCHAND (owner/manager) ET l'opérateur -- jamais opérateur seul", () => {
  const fn = SQL_EXEC.slice(
    SQL_EXEC.indexOf("function public.assert_tag_admin"),
    SQL_EXEC.indexOf("function public.create_tag")
  );
  assert.ok(fn.includes("restaurant_users"), "le chemin marchand doit exister");
  assert.ok(fn.includes("'owner'") && fn.includes("'manager'"));
  assert.ok(fn.includes("is_scanym_operator()"), "le bypass opérateur doit exister");
});

test("[SQL/§4] get_merchant_catalogue n'est NI redéfinie NI étendue par ce lot (aucune multiplication produit × tag)", () => {
  assert.equal(SQL_EXEC.includes("create or replace function public.get_merchant_catalogue"), false);
  assert.equal(SQL_EXEC.includes("create function public.get_merchant_catalogue"), false);
  assert.equal(SQL_EXEC.includes("drop function if exists public.get_merchant_catalogue"), false);
});

test("[SQL/§4] le contrat de lecture client AGRÈGE les produits (uuid[]) -- une ligne par collection, jamais par produit", () => {
  const fn = SQL_EXEC.slice(SQL_EXEC.indexOf("function public.get_restaurant_collections"));
  assert.ok(fn.includes("menu_item_ids uuid[]"));
  assert.ok(fn.includes("array_agg"));
  assert.ok(fn.includes("group by"));
});

test("[SQL/§4] le contrat client n'expose QUE les collections publiées d'un établissement publié, produits archivés/indisponibles exclus", () => {
  const fn = SQL_EXEC.slice(SQL_EXEC.indexOf("function public.get_restaurant_collections"));
  assert.ok(fn.includes("t.visible_on_customer_menu = true"));
  assert.ok(fn.includes("t.is_active = true"));
  assert.ok(fn.includes("r.is_active = true"));
  assert.ok(fn.includes("r.status = 'active'"));
  assert.ok(fn.includes("mi.archived_at is null"));
  assert.ok(fn.includes("mi.is_available = true"));
});

test("[SQL/§6] dépublier une collection ne SUPPRIME rien : la RPC de configuration ne contient aucun DELETE", () => {
  const fn = SQL_EXEC.slice(
    SQL_EXEC.indexOf("function public.update_tag_collection_settings"),
    SQL_EXEC.indexOf("function public.get_restaurant_tags")
  );
  assert.equal(fn.includes("delete"), false);
  assert.equal(fn.includes("menu_item_tags"), false, "ne touche jamais les associations produit");
  assert.equal(fn.includes("menu_items"), false);
  assert.equal(fn.includes("menu_categories"), false);
});

test("[SQL/§7] aucun DDL/DML sur menu_items/menu_categories/menu_subcategories -- les tags ne sont jamais un 3e niveau de hiérarchie", () => {
  // Portée réduite aux SECTIONS APPLICATIVES, avant le bloc de
  // vérification post-application : ce dernier contient LÉGITIMEMENT
  // ces mêmes motifs comme CHAÎNES DE RECHERCHE dans un `ilike` (le
  // garde-fou qui prouve justement leur absence) -- un scan naïf du
  // fichier entier ferait un faux positif sur le garde-fou lui-même.
  const applicative = SQL_EXEC.slice(0, SQL_EXEC.indexOf("scanym_post_commit_check_failed"));
  for (const t of ["menu_items", "menu_categories", "menu_subcategories"]) {
    assert.equal(applicative.includes(`alter table public.${t}`), false, `alter interdit sur ${t}`);
    assert.equal(applicative.includes(`drop table public.${t}`), false);
    assert.equal(applicative.includes(`update public.${t}`), false);
    assert.equal(applicative.includes(`delete from public.${t}`), false);
  }
});

test("[SQL/§8] l'idempotence est STRUCTURELLE : clé primaire composite + on conflict do nothing", () => {
  assert.match(SQL_EXEC, /primary key \(menu_item_id, tag_id\)/);
  assert.ok(SQL_EXEC.includes("on conflict (menu_item_id, tag_id) do nothing"));
  assert.match(SQL_EXEC, /create unique index idx_menu_tags_unique_active_key[\s\S]*?where is_active = true/);
});

test("[SQL/§8] add_product_tags est STRICTEMENT ADDITIVE -- aucun DELETE d'association", () => {
  const fn = SQL_EXEC.slice(
    SQL_EXEC.indexOf("function public.add_product_tags"),
    SQL_EXEC.indexOf("function public.update_tag_collection_settings")
  );
  assert.equal(fn.includes("delete from"), false);
});

test("[SQL/§9] RLS activée sur les 2 tables et aucun droit direct laissé à anon/authenticated", () => {
  assert.ok(SQL_EXEC.includes("alter table public.menu_tags enable row level security"));
  assert.ok(SQL_EXEC.includes("alter table public.menu_item_tags enable row level security"));
  assert.ok(SQL_EXEC.includes("revoke all on table public.menu_tags from public, anon, authenticated"));
  assert.ok(SQL_EXEC.includes("revoke all on table public.menu_item_tags from public, anon, authenticated"));
});

test("[SQL/§9] toutes les RPC du lot sont SECURITY DEFINER avec search_path explicite", () => {
  const names = [
    "assert_tag_admin",
    "create_tag",
    "add_product_tags",
    "update_tag_collection_settings",
    "get_restaurant_tags",
    "get_restaurant_collections",
  ];
  for (const n of names) {
    const i = SQL_EXEC.indexOf(`function public.${n}`);
    assert.ok(i > 0, `${n} introuvable`);
    const body = SQL_EXEC.slice(i, i + 4000);
    assert.ok(body.includes("security definer"), `${n} doit être SECURITY DEFINER`);
    assert.ok(body.includes("set search_path = ''"), `${n} doit fixer search_path`);
  }
});

test("[SQL/§9] add_product_tags re-dérive le tenant depuis le PRODUIT ciblé, jamais depuis un paramètre client", () => {
  const fn = SQL_EXEC.slice(
    SQL_EXEC.indexOf("function public.add_product_tags"),
    SQL_EXEC.indexOf("function public.update_tag_collection_settings")
  );
  assert.ok(fn.includes("from public.menu_items mi"));
  assert.ok(fn.includes("join public.menu_categories mc on mc.id = mi.category_id"));
  assert.ok(fn.includes("perform public.assert_tag_admin(v_restaurant_id)"));
  // Aucun restaurant_id en paramètre de cette RPC.
  assert.equal(fn.slice(0, fn.indexOf("as $$")).includes("p_restaurant_id"), false);
});

test("[SQL] normalized_key est une colonne GÉNÉRÉE STOCKÉE -- impossible à désynchroniser du nom", () => {
  assert.match(SQL_EXEC, /normalized_key\s+text generated always as \(/);
  assert.ok(SQL_EXEC.includes("stored"));
  // Règle strictement identique à normalizedKey (TS).
  assert.ok(SQL_EXEC.includes("lower(btrim(name, e' \\t\\n\\r\\f' || chr(11)))"));
});

test("[SQL] un bloc de vérification post-application existe (échec = ROLLBACK automatique)", () => {
  assert.ok(SQL.includes("SCANYM_POST_COMMIT_CHECK_FAILED"));
});

test("[SQL] le fichier documente qu'il n'a PAS été exécuté sur Production", () => {
  assert.ok(SQL.includes("N'A PAS ÉTÉ EXÉCUTÉ sur Production"));
});

test("[ROLLBACK] retire les 2 tables et les 6 RPC, et ne touche AUCUNE table préexistante", () => {
  assert.ok(ROLLBACK_EXEC.includes("drop table if exists public.menu_item_tags"));
  assert.ok(ROLLBACK_EXEC.includes("drop table if exists public.menu_tags"));
  for (const n of [
    "create_tag",
    "add_product_tags",
    "update_tag_collection_settings",
    "get_restaurant_tags",
    "get_restaurant_collections",
    "assert_tag_admin",
  ]) {
    assert.ok(ROLLBACK_EXEC.includes(`drop function if exists public.${n}`), `${n} doit être supprimée`);
  }
  for (const t of ["menu_items", "menu_categories", "menu_subcategories", "orders", "order_items", "restaurants"]) {
    assert.equal(ROLLBACK_EXEC.includes(`drop table if exists public.${t}`), false);
    assert.equal(ROLLBACK_EXEC.includes(`delete from public.${t}`), false);
    assert.equal(ROLLBACK_EXEC.includes(`update public.${t}`), false);
  }
});

test("[ROLLBACK] atomique : transaction explicite, contrôle de dérive À L'INTÉRIEUR, avant tout DROP", () => {
  const begin = ROLLBACK_EXEC.indexOf("\nbegin;");
  const drift = ROLLBACK_EXEC.indexOf("scanym_rollback_drift");
  const firstDrop = ROLLBACK_EXEC.indexOf("drop function");
  const commit = ROLLBACK_EXEC.lastIndexOf("\ncommit;");
  assert.ok(begin >= 0 && commit > begin);
  assert.ok(drift > begin, "le contrôle doit être DANS la transaction (indépendance à ON_ERROR_STOP)");
  assert.ok(drift < firstDrop, "le contrôle doit précéder toute suppression");
  assert.ok(ROLLBACK.includes("SCANYM_ROLLBACK_INCOMPLETE"));
});

test("[ROLLBACK] l'en-tête documente EXACTEMENT la perte de données qu'il provoque (tags, associations, visibilité)", () => {
  const head = ROLLBACK.slice(0, ROLLBACK.indexOf("\nbegin;"));
  assert.ok(/DROP TABLE/.test(head));
  assert.ok(/PERDUES/i.test(head));
  assert.ok(/associations produit\/tag/i.test(head));
});
