import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// Scanym — CLAUDE NOUGARO — OPERATOR BACKOFFICE — SAFE CATALOGUE
// RESET v1 — preuve STRUCTURELLE (lecture de texte, même patron que
// tests/v110c-payment-p3a1-structural.test.ts et
// tests/v111h-payment-p3a2-structural.test.ts) des propriétés de
// sécurité absolues du mandat, directement sur le fichier SQL publié
// (supabase/DRAFT-lot-operator-catalogue-reset-v1.sql).
//
// La preuve COMPORTEMENTALE (exécution réelle contre PostgreSQL) de
// ces mêmes propriétés est apportée séparément par
// supabase/tests/operator-catalogue-reset-v1-check.sh (56/56
// assertions vertes, base jetable locale, jamais Production) -- ce
// fichier-ci prouve en plus que le texte SOURCE publié ne contient
// AUCUN chemin alternatif dangereux qu'un test comportemental
// pourrait ne pas avoir exercé (ex. un DELETE FROM menu_items caché
// dans une branche jamais atteinte par le harnais).
// ====================================================================

const SQL_PATH = new URL("../supabase/DRAFT-lot-operator-catalogue-reset-v1.sql", import.meta.url);
const sql = readFileSync(SQL_PATH, "utf8");
const sqlLower = sql.toLowerCase();

// v1.2 — le fichier ROLLBACK est désormais une pièce de sécurité à
// part entière (rollback CONDITIONNEL, fail-fast, atomique) et non
// plus un simple miroir du fichier principal : il est lu une fois ici
// et prouvé par sa propre série de tests (section v1.2 plus bas).
const ROLLBACK_PATH = new URL(
  "../supabase/DRAFT-lot-operator-catalogue-reset-v1-ROLLBACK.sql",
  import.meta.url
);
const rollback = readFileSync(ROLLBACK_PATH, "utf8");
const rollbackLower = rollback.toLowerCase();

/**
 * Retire les lignes de COMMENTAIRE SQL (lignes dont le premier
 * caractère non blanc est `--`) pour ne raisonner que sur les
 * instructions EXÉCUTABLES.
 *
 * Nécessaire pour les preuves d'ORDRE : l'en-tête du rollback décrit
 * en prose, et délibérément (exigence de documentation du mandat
 * §6), les DROP FUNCTION / DROP TABLE / DROP COLUMN que le fichier
 * exécute plus bas. Un scan de texte brut confondrait cette
 * documentation avec les instructions elles-mêmes et conclurait à
 * tort qu'une mutation précède les contrôles préalables.
 *
 * Seules les lignes ENTIÈREMENT commentées sont retirées : jamais un
 * `--` en milieu de ligne, qui pourrait appartenir à un littéral
 * chaîne et dont le retrait corromprait l'instruction.
 */
function stripFullLineSqlComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

const rollbackExecLower = stripFullLineSqlComments(rollbackLower);

test("[SAFETY] les DEUX corps de fonction (preview_catalogue_reset, reset_merchant_catalogue) ne contiennent JAMAIS 'delete from menu_items' / 'delete from public.menu_items' en tant qu'INSTRUCTION SQL (aucune suppression physique de produit, sous aucune forme)", () => {
  // Scope volontairement réduit aux DEUX CORPS DE FONCTION (jusqu'au
  // premier "revoke all on function", avant le bloc de
  // vérification post-application) -- ce dernier contient
  // LÉGITIMEMENT la chaîne littérale "delete from menu_items" comme
  // MOTIF DE RECHERCHE à l'intérieur d'un `ilike '%...%'` (le garde-fou
  // lui-même, section 5 du fichier), jamais une instruction SQL
  // exécutable -- un scan naïf sur le fichier entier ferait un faux
  // positif sur ce garde-fou qui PROUVE justement l'absence du motif
  // dans le corps des fonctions.
  const bodiesMatch = sql.match(/create or replace function public\.preview_catalogue_reset[\s\S]*?(?=revoke all on function)/);
  assert.ok(bodiesMatch, "corps des deux fonctions introuvable");
  const bodies = bodiesMatch![0].toLowerCase();
  assert.equal(bodies.includes("delete from menu_items"), false);
  assert.equal(bodies.includes("delete from public.menu_items"), false);
});

test("[SAFETY] le fichier SQL publié ne contient JAMAIS 'truncate' (aucun vidage de table en masse)", () => {
  assert.equal(sqlLower.includes("truncate"), false);
});

test("[SAFETY] le fichier SQL publié ne contient JAMAIS 'drop table public.menu_items/menu_categories/menu_subcategories/orders/order_items'", () => {
  for (const table of ["menu_items", "menu_categories", "menu_subcategories", "orders", "order_items", "restaurants"]) {
    assert.equal(sqlLower.includes(`drop table public.${table}`), false, `drop table ${table} ne doit jamais apparaître`);
    assert.equal(sqlLower.includes(`drop table if exists public.${table}`), false, `drop table if exists ${table} ne doit jamais apparaître`);
  }
});

test("preview_catalogue_reset et reset_merchant_catalogue exigent TOUTES DEUX is_scanym_operator() (operator-only, mandat §8/§9)", () => {
  const previewMatch = sql.match(/create or replace function public\.preview_catalogue_reset[\s\S]*?(?=create or replace function|$)/);
  const resetMatch = sql.match(/create or replace function public\.reset_merchant_catalogue[\s\S]*?(?=create or replace function|revoke all on function)/);
  assert.ok(previewMatch, "preview_catalogue_reset introuvable dans le fichier");
  assert.ok(resetMatch, "reset_merchant_catalogue introuvable dans le fichier");
  assert.ok(previewMatch![0].includes("is_scanym_operator()"), "preview_catalogue_reset doit appeler is_scanym_operator()");
  assert.ok(resetMatch![0].includes("is_scanym_operator()"), "reset_merchant_catalogue doit appeler is_scanym_operator()");
});

test("reset_merchant_catalogue n'a AUCUN repli owner/manager (jamais 'restaurant_users' dans son corps -- operator-only strict, contrairement à create_category/archive_product)", () => {
  const resetMatch = sql.match(/create or replace function public\.reset_merchant_catalogue[\s\S]*?(?=revoke all on function)/);
  assert.ok(resetMatch);
  assert.equal(resetMatch![0].toLowerCase().includes("restaurant_users"), false);
});

test("preview_catalogue_reset n'a AUCUN repli owner/manager (jamais 'restaurant_users' dans son corps -- operator-only strict)", () => {
  const previewMatch = sql.match(/create or replace function public\.preview_catalogue_reset[\s\S]*?(?=create or replace function public\.reset_merchant_catalogue)/);
  assert.ok(previewMatch);
  assert.equal(previewMatch![0].toLowerCase().includes("restaurant_users"), false);
});

test("chaque étape de mutation dans reset_merchant_catalogue est scopée par restaurant_id (isolation tenant absolue, mandat §9)", () => {
  const resetMatch = sql.match(/create or replace function public\.reset_merchant_catalogue[\s\S]*?(?=revoke all on function)/);
  assert.ok(resetMatch);
  const body = resetMatch![0];
  const updateMenuItems = body.match(/update public\.menu_items[\s\S]*?;/);
  const deleteSubcats = body.match(/delete from public\.menu_subcategories[\s\S]*?;/);
  const deleteCats = body.match(/delete from public\.menu_categories[\s\S]*?;/);
  assert.ok(updateMenuItems, "UPDATE menu_items introuvable");
  assert.ok(deleteSubcats, "DELETE menu_subcategories introuvable");
  assert.ok(deleteCats, "DELETE menu_categories introuvable");
  assert.ok(updateMenuItems![0].includes("p_restaurant_id"), "UPDATE menu_items doit référencer p_restaurant_id");
  assert.ok(deleteSubcats![0].includes("p_restaurant_id"), "DELETE menu_subcategories doit référencer p_restaurant_id");
  assert.ok(deleteCats![0].includes("p_restaurant_id"), "DELETE menu_categories doit référencer p_restaurant_id");
});

test("l'archivage de produits utilise EXACTEMENT le même geste que archive_product (archived_at = now(), is_available = false) -- jamais un autre état inventé", () => {
  assert.ok(sqlLower.includes("archived_at = now(), is_available = false"));
});

test("aucune suppression physique de catégorie/sous-catégorie n'est INCONDITIONNELLE -- chaque DELETE porte une clause NOT EXISTS sur menu_items", () => {
  const deleteSubcatsMatch = sql.match(/delete from public\.menu_subcategories[\s\S]*?;/);
  const deleteCatsMatch = sql.match(/delete from public\.menu_categories[\s\S]*?;/);
  assert.ok(deleteSubcatsMatch![0].toLowerCase().includes("not exists"));
  assert.ok(deleteCatsMatch![0].toLowerCase().includes("not exists"));
  assert.ok(deleteSubcatsMatch![0].toLowerCase().includes("menu_items"));
  assert.ok(deleteCatsMatch![0].toLowerCase().includes("menu_items"));
});

test("la table d'audit catalogue_reset_audit_log a RLS activée et AUCUN grant direct à anon/authenticated", () => {
  assert.ok(sqlLower.includes("alter table public.catalogue_reset_audit_log enable row level security"));
  assert.ok(sqlLower.includes("revoke all on table public.catalogue_reset_audit_log from anon, authenticated, public"));
});

test("l'écriture d'audit se fait dans la MÊME transaction implicite que la mutation (un seul INSERT, à l'intérieur du corps de reset_merchant_catalogue)", () => {
  const resetMatch = sql.match(/create or replace function public\.reset_merchant_catalogue[\s\S]*?(?=revoke all on function)/);
  assert.ok(resetMatch![0].includes("insert into public.catalogue_reset_audit_log"));
});

test("les deux RPC sont security definer avec search_path vide (même patron que toutes les RPC catalogue existantes)", () => {
  const previewMatch = sql.match(/create or replace function public\.preview_catalogue_reset[\s\S]*?as \$\$/);
  const resetMatch = sql.match(/create or replace function public\.reset_merchant_catalogue[\s\S]*?as \$\$/);
  for (const m of [previewMatch, resetMatch]) {
    assert.ok(m);
    assert.ok(m![0].includes("security definer"));
    assert.ok(m![0].includes("set search_path = ''"));
  }
});

test("preview_catalogue_reset est déclarée 'stable' (pas 'volatile') -- cohérent avec son contrat LECTURE SEULE", () => {
  const previewMatch = sql.match(/create or replace function public\.preview_catalogue_reset[\s\S]*?as \$\$/);
  assert.ok(previewMatch![0].includes("stable"));
});

test("preview_catalogue_reset ne contient AUCUNE instruction de mutation (INSERT/UPDATE/DELETE) -- répétable sans effet de bord", () => {
  const previewMatch = sql.match(/create or replace function public\.preview_catalogue_reset[\s\S]*?(?=create or replace function public\.reset_merchant_catalogue)/);
  const body = previewMatch![0].toLowerCase();
  assert.equal(/\binsert into\b/.test(body), false);
  assert.equal(/\bupdate public\./.test(body), false);
  assert.equal(/\bdelete from\b/.test(body), false);
});

test("les GRANT execute sont ciblés (authenticated seulement, jamais anon/public) pour les deux RPC (v1.1 : reset_merchant_catalogue(uuid, text))", () => {
  assert.ok(sqlLower.includes("grant execute on function public.preview_catalogue_reset(uuid) to authenticated"));
  assert.ok(sqlLower.includes("grant execute on function public.reset_merchant_catalogue(uuid, text) to authenticated"));
  assert.ok(sqlLower.includes("revoke all on function public.preview_catalogue_reset(uuid) from public, anon"));
  assert.ok(sqlLower.includes("revoke all on function public.reset_merchant_catalogue(uuid, text) from public, anon"));
});

// --------------------------------------------------------------------
// v1.1 -- STRONG CONFIRMATION SERVEUR (remédiation CTO).
// --------------------------------------------------------------------

test("[v1.1] reset_merchant_catalogue a EXACTEMENT 2 paramètres : p_restaurant_id uuid, p_confirmation_phrase text (aucune ancienne signature à 1 argument ne doit subsister)", () => {
  assert.ok(sql.includes("p_restaurant_id uuid,\n  p_confirmation_phrase text"));
  assert.ok(sql.includes("drop function if exists public.reset_merchant_catalogue(uuid);"));
});

test("[v1.1] la phrase attendue est dérivée EXCLUSIVEMENT depuis restaurants.name (jamais depuis une valeur fournie par le client)", () => {
  const resetMatch = sql.match(/create or replace function public\.reset_merchant_catalogue[\s\S]*?(?=revoke all on function)/);
  assert.ok(resetMatch);
  const body = resetMatch![0];
  assert.ok(body.includes("select r.name into v_restaurant_name"));
  assert.ok(body.includes("v_expected_phrase := 'RESET ' || btrim(v_restaurant_name"));
});

test("[v1.1] la comparaison de confirmation est EXACTE et littérale -- AUCUNE fonction de changement de casse (upper/lower/ilike) n'est appliquée à la phrase ou au nom du marchand", () => {
  const resetMatch = sql.match(/create or replace function public\.reset_merchant_catalogue[\s\S]*?(?=revoke all on function)/);
  const body = resetMatch![0].toLowerCase();
  // Seule normalisation autorisée : btrim() (espaces de bordure). Ni
  // upper(), ni lower(), ni ilike ne doivent jamais apparaître dans le
  // corps de cette fonction (mandat v1.1 "Prefer exact literal
  // confirmation").
  assert.equal(/\bupper\s*\(/.test(body), false, "upper() ne doit jamais apparaître -- comparaison EXACTE requise");
  assert.equal(/\blower\s*\(/.test(body), false, "lower() ne doit jamais apparaître -- comparaison EXACTE requise");
  assert.equal(/\bilike\b/.test(body), false, "ilike ne doit jamais apparaître -- comparaison EXACTE requise");
});

test("[v1.1] une confirmation refusée ne produit JAMAIS result='completed'/'no_op' -- retourne 'rejected_confirmation' et s'arrête avant toute mutation (return; avant les étapes d'archivage/suppression)", () => {
  const resetMatch = sql.match(/create or replace function public\.reset_merchant_catalogue[\s\S]*?(?=revoke all on function)/);
  const body = resetMatch![0];
  assert.ok(body.includes("if not v_confirmation_ok then"));
  assert.ok(/if not v_confirmation_ok then[\s\S]*?'rejected_confirmation'::text;\s*\n\s*return;\s*\n\s*end if;/.test(body));
});

test("[v1.1] une tentative de confirmation refusée écrit quand même un événement d'audit dédié ('rejected_confirmation'), jamais silencieuse (traçabilité d'un bypass UI direct)", () => {
  const resetMatch = sql.match(/create or replace function public\.reset_merchant_catalogue[\s\S]*?(?=revoke all on function)/);
  const body = resetMatch![0];
  const rejectedBranch = body.match(/if not v_confirmation_ok then[\s\S]*?end if;/);
  assert.ok(rejectedBranch, "branche de rejet de confirmation introuvable");
  assert.ok(rejectedBranch![0].includes("insert into public.catalogue_reset_audit_log"));
});

test("[v1.1] catalogue_reset_audit_log.result accepte désormais 'rejected_confirmation' en plus de 'completed'/'no_op'", () => {
  assert.ok(sql.includes("check (result in ('completed', 'no_op', 'rejected_confirmation'))"));
});

test("[v1.1] les catégories/sous-catégories RETENUES sont DÉSACTIVÉES (is_active = false) par reset_merchant_catalogue -- jamais supprimées, jamais une mutation inconditionnelle sans scope restaurant", () => {
  const resetMatch = sql.match(/create or replace function public\.reset_merchant_catalogue[\s\S]*?(?=revoke all on function)/);
  assert.ok(resetMatch);
  const body = resetMatch![0];
  const updateCats = body.match(/update public\.menu_categories mc\s*\n\s*set is_active = false[\s\S]*?;/);
  const updateSubcats = body.match(/update public\.menu_subcategories ms\s*\n\s*set is_active = false[\s\S]*?;/);
  assert.ok(updateCats, "UPDATE menu_categories SET is_active = false introuvable");
  assert.ok(updateSubcats, "UPDATE menu_subcategories SET is_active = false introuvable");
  assert.ok(updateCats![0].includes("p_restaurant_id"), "la désactivation de catégories doit être scopée par p_restaurant_id");
});

test("[v1.1] l'idempotency (result='no_op') tient compte de la désactivation, pas seulement de l'archivage/suppression (sinon un catalogue déjà archivé manuellement, jamais encore reseté, serait faussement rapporté 'no_op')", () => {
  const resetMatch = sql.match(/create or replace function public\.reset_merchant_catalogue[\s\S]*?(?=revoke all on function)/);
  const body = resetMatch![0];
  assert.ok(
    /if v_products_archived = 0[\s\S]*?and v_subcategories_deactivated = 0 and v_categories_deactivated = 0 then/.test(body)
  );
});

test("[v1.1] menu_subcategories.is_active existe (colonne additive, symétrique de menu_categories.is_active) et son index unique est reconstruit en index PARTIEL (WHERE is_active = true), même patron que idx_menu_categories_unique_active_name", () => {
  assert.ok(sql.includes("add column if not exists is_active boolean not null default true"));
  assert.ok(sql.includes("drop index if exists public.idx_menu_subcategories_unique_name"));
  assert.ok(/create unique index idx_menu_subcategories_unique_name[\s\S]*?where is_active = true;/.test(sql));
});

test("[v1.1] get_merchant_catalogue(uuid, boolean) est étendue de façon ADDITIVE avec category_is_active/subcategory_is_active (nécessaire à lib/catalogue-import/resolution.ts)", () => {
  assert.ok(sql.includes("drop function if exists public.get_merchant_catalogue(uuid, boolean)"));
  const gmcMatch = sql.match(/create function public\.get_merchant_catalogue[\s\S]*?(?=revoke all on function)/);
  assert.ok(gmcMatch, "get_merchant_catalogue introuvable");
  assert.ok(gmcMatch![0].includes("category_is_active"));
  assert.ok(gmcMatch![0].includes("subcategory_is_active"));
  // Préserve le bypass opérateur d'OB-2 v1.1 -- une régression vers la
  // version antérieure (subcategories-backoffice-v1, restaurant_users
  // seul) a été détectée et corrigée via le harnais réel (section
  // [N]) pendant le développement de ce lot.
  assert.ok(gmcMatch![0].includes("not public.is_scanym_operator()"));
});

test("[v1.1] le bloc de vérification post-application interdit explicitement toute signature reset_merchant_catalogue(uuid) à 1 argument", () => {
  assert.ok(sqlLower.includes("pronargs = 1"));
  assert.ok(sqlLower.includes("pronargs = 2"));
});

test("un bloc de vérification post-application existe (échec = ROLLBACK automatique, jamais une application partielle silencieuse)", () => {
  assert.ok(sqlLower.includes("scanym_post_commit_check_failed"));
});

test("le fichier documente explicitement qu'il n'a PAS été exécuté sur Production par ce lot", () => {
  assert.ok(sql.includes("N'A PAS ÉTÉ EXÉCUTÉ sur Production"));
});

test("un fichier ROLLBACK correspondant existe et ne DROP que les objets additifs de ce lot (aucune TABLE préexistante jamais supprimée)", () => {
  assert.ok(rollbackLower.includes("drop function if exists public.reset_merchant_catalogue"));
  assert.ok(rollbackLower.includes("drop function if exists public.preview_catalogue_reset"));
  assert.ok(rollbackLower.includes("drop table if exists public.catalogue_reset_audit_log"));
  for (const table of ["menu_items", "menu_categories", "menu_subcategories", "orders", "order_items", "restaurants"]) {
    assert.equal(rollbackLower.includes(`drop table if exists public.${table}`), false);
    assert.equal(rollbackLower.includes(`drop table public.${table}`), false);
  }
});

// ====================================================================
// v1.2 — ROLLBACK SAFETY (remédiation ciblée CTO).
//
// La preuve COMPORTEMENTALE (le rollback refuse réellement, en base
// PostgreSQL réelle, avant toute mutation, puis s'exécute
// intégralement après réconciliation) est apportée par
// supabase/tests/operator-catalogue-reset-v1-check.sh, section
// [v1.2 RB] -- jamais dupliquée ici. Les tests ci-dessous prouvent ce
// qu'une exécution ne peut PAS prouver : qu'aucun chemin alternatif
// dangereux n'existe dans le TEXTE publié (ex. un DELETE de données
// marchandes dans une branche que le harnais n'atteindrait pas), et
// que l'ORDRE des instructions garantit structurellement
// « contrôles avant toute mutation ».
// ====================================================================

test("[v1.2] le rollback ne contient AUCUN DELETE/UPDATE/TRUNCATE de données marchandes — il ne supprime, ne fusionne, ne renomme et ne re-pointe jamais une ligne de catalogue ou d'historique", () => {
  // Sur les INSTRUCTIONS seules : l'en-tête documente légitimement
  // (mandat §6) ce que le fichier ne fait PAS, en nommant ces mêmes
  // mots-clés.
  for (const tbl of ["menu_items", "menu_subcategories", "menu_categories", "orders", "order_items", "restaurants"]) {
    for (const stmt of ["delete from", "truncate", "update"]) {
      assert.equal(
        rollbackExecLower.includes(`${stmt} public.${tbl}`),
        false,
        `instruction interdite trouvée dans le rollback : ${stmt} public.${tbl}`
      );
      assert.equal(
        rollbackExecLower.includes(`${stmt} ${tbl}`),
        false,
        `instruction interdite trouvée dans le rollback : ${stmt} ${tbl}`
      );
    }
  }
});

test("[v1.2] le rollback porte la sentinelle SCANYM_ROLLBACK_BLOCKED, refus explicite exigé par le mandat quand la réconciliation manuelle est requise", () => {
  assert.ok(rollback.includes("SCANYM_ROLLBACK_BLOCKED"));
  assert.ok(
    rollback.includes(
      "duplicate active/inactive subcategory names created under reset v1.1 semantics require manual reconciliation."
    ),
    "le libellé exact demandé par le mandat doit apparaître tel quel"
  );
});

test("[v1.2] ATOMICITÉ — les 3 contrôles préalables précèdent STRICTEMENT toute mutation : aucun DROP FUNCTION / DROP TABLE / DROP COLUMN / DROP INDEX / CREATE INDEX n'apparaît avant le dernier contrôle", () => {
  // Position du dernier contrôle préalable (0c) : la dernière
  // occurrence de SCANYM_ROLLBACK_BLOCKED, qui clôt la section 0.
  // Raisonnement sur les INSTRUCTIONS seules (commentaires retirés).
  const lastPrecheck = rollbackExecLower.lastIndexOf("scanym_rollback_blocked");
  assert.ok(lastPrecheck > 0, "aucun contrôle préalable trouvé");

  const head = rollbackExecLower.slice(0, lastPrecheck);
  for (const mutation of [
    "drop function",
    "drop table",
    "drop policy",
    "drop index",
    "create unique index",
    "drop column",
    "create function",
  ]) {
    assert.equal(
      head.includes(mutation),
      false,
      `mutation '${mutation}' présente AVANT la fin des contrôles préalables — l'atomicité du mandat §5 n'est pas garantie`
    );
  }
});

test("[v1.2] ATOMICITÉ — la totalité du rollback s'exécute dans UNE transaction explicite, et les contrôles préalables sont À L'INTÉRIEUR (protection indépendante de ON_ERROR_STOP côté client)", () => {
  const begin = rollbackLower.indexOf("\nbegin;");
  const commit = rollbackLower.lastIndexOf("\ncommit;");
  const firstPrecheck = rollbackLower.indexOf("scanym_rollback_drift");
  const lastPrecheck = rollbackLower.lastIndexOf("scanym_rollback_blocked");

  assert.ok(begin > 0, "aucun begin; explicite");
  assert.ok(commit > begin, "aucun commit; explicite après le begin;");
  assert.ok(
    firstPrecheck > begin,
    "le premier contrôle préalable doit être APRÈS begin; (sinon un échec ne serait pas couvert par la transaction)"
  );
  assert.ok(lastPrecheck < commit, "les contrôles préalables doivent être avant le commit;");
});

test("[v1.2] le rollback vérifie, APRÈS coup et dans la même transaction, qu'il est COMPLET (jamais partiel) — un échec de ce contrôle final annule tout", () => {
  assert.ok(rollback.includes("SCANYM_ROLLBACK_INCOMPLETE"));
  // Le contrôle final doit être après la dernière mutation (drop column).
  const dropColumn = rollbackLower.lastIndexOf("drop column if exists is_active");
  const finalCheck = rollbackLower.lastIndexOf("scanym_rollback_incomplete");
  assert.ok(dropColumn > 0 && finalCheck > dropColumn);
});

test("[v1.2] le rollback restaure get_merchant_catalogue AVEC le bypass is_scanym_operator() d'OB-2 v1.1, et se le prouve à lui-même (garde anti-régression : restaurer une définition antérieure retirerait silencieusement l'accès opérateur)", () => {
  assert.ok(rollbackLower.includes("not public.is_scanym_operator()"));
  assert.ok(rollback.includes("a perdu le bypass is_scanym_operator()"));
});

test("[v1.2] DOCUMENTATION — l'en-tête du rollback décrit EXACTEMENT son comportement réel : il annonce le DROP COLUMN qu'il contient et ne prétend plus être purement additif", () => {
  const rollbackHead = rollback.slice(0, rollbackLower.indexOf("\nbegin;"));
  // Le DROP COLUMN existe réellement dans le fichier...
  assert.ok(rollbackLower.includes("drop column if exists is_active"));
  // ...et l'en-tête l'annonce explicitement.
  assert.ok(
    /DROP COLUMN/.test(rollbackHead),
    "l'en-tête doit nommer explicitement le DROP COLUMN que le fichier exécute"
  );
  // La formulation contradictoire de v1.1 ("jamais un DROP TABLE/DROP
  // COLUMN") ne doit plus exister nulle part dans le fichier.
  assert.equal(
    rollbackLower.includes("jamais un drop table/drop column"),
    false,
    "la formulation contradictoire de v1.1 subsiste dans le rollback"
  );
  // L'en-tête doit aussi documenter la perte des lignes d'audit, qui
  // n'est PAS neutre.
  assert.ok(/perdues/i.test(rollbackHead) && /audit/i.test(rollbackHead));
});

test("[v1.2] DOCUMENTATION — l'en-tête documente le recours exact en cas de blocage, et affirme que le script ne réconcilie jamais de lui-même", () => {
  const rollbackHead = rollback.slice(0, rollbackLower.indexOf("\nbegin;"));
  assert.ok(/RECOURS EXACT/i.test(rollbackHead));
  for (const forbidden of ["renomme", "fusionne", "re-pointe", "supprime"]) {
    assert.ok(
      new RegExp(forbidden, "i").test(rollbackHead),
      `l'en-tête doit expliciter que le script ne ${forbidden} jamais de données marchandes de lui-même`
    );
  }
});

test("Scope guard — aucune mention de Stuart/paiement/Monetico/CGV/email dans le fichier SQL de ce lot", () => {
  for (const needle of ["stuart", "monetico", "payment_transaction", "cgv", "notification_outbox"]) {
    assert.equal(sqlLower.includes(needle), false, `mention interdite trouvée : ${needle}`);
  }
});
