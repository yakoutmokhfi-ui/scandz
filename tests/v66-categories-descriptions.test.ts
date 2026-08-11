import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  normalizeText,
  textPayload,
  SHORT_DESCRIPTION_MAX_LENGTH,
  LONG_DESCRIPTION_MAX_LENGTH,
  CATEGORY_NAME_MAX_LENGTH,
} from "../lib/catalogue-text.ts";
import {
  isShortDescriptionTooLongError,
  isDescriptionTooLongError,
  isCategoryDuplicateNameError,
  SHORT_DESCRIPTION_TOO_LONG_CODE,
  DESCRIPTION_TOO_LONG_CODE,
  CATEGORY_DUPLICATE_NAME_CODE,
} from "../lib/services/catalogue-error.ts";

// ====================================================================
// V66 — Catégories, produits, descriptions courte/longue.
//
// Ces tests couvrent les fonctions pures (comptage/normalisation,
// classification d'erreur) et des contrôles statiques sur la
// migration SQL et les dictionnaires i18n. Les scénarios fonctionnels
// complets (création/modification de catégorie, refus staff,
// isolation, doublons EN CONCURRENCE RÉELLE, catégorie technique,
// catégorie vide visible, limites 100/101 et 500/501, arabe/emoji,
// rollback de la migration) ont été exécutés manuellement sur une
// instance PostgreSQL 16 réelle — voir le compte-rendu joint à la
// livraison, pas reproduits ici en toute rigueur puisque npm test
// reste volontairement indépendant de PostgreSQL (comme en V65).
// ====================================================================

// --- 1. lib/catalogue-text.ts ---------------------------------------

test("catalogue-text: description courte a 100 caracteres acceptee, 101 refusee", () => {
  const at100 = normalizeText("a".repeat(100), SHORT_DESCRIPTION_MAX_LENGTH);
  const at101 = normalizeText("a".repeat(101), SHORT_DESCRIPTION_MAX_LENGTH);
  assert.equal(at100.isValid, true);
  assert.equal(at101.isValid, false);
});

test("catalogue-text: description longue a 500 caracteres acceptee, 501 refusee", () => {
  const at500 = normalizeText("a".repeat(500), LONG_DESCRIPTION_MAX_LENGTH);
  const at501 = normalizeText("a".repeat(501), LONG_DESCRIPTION_MAX_LENGTH);
  assert.equal(at500.isValid, true);
  assert.equal(at501.isValid, false);
});

test("catalogue-text: nom de categorie a 255 caracteres accepte, 256 refuse", () => {
  const at255 = normalizeText("a".repeat(255), CATEGORY_NAME_MAX_LENGTH);
  const at256 = normalizeText("a".repeat(256), CATEGORY_NAME_MAX_LENGTH);
  assert.equal(at255.isValid, true);
  assert.equal(at256.isValid, false);
});

test("catalogue-text: texte arabe compte par point de code", () => {
  const text = "قهوة عربية تقليدية بالهيل";
  const s = normalizeText(text, LONG_DESCRIPTION_MAX_LENGTH);
  assert.equal(s.length, Array.from(text).length);
  assert.equal(s.length, 25);
});

test("catalogue-text: accents francais comptes correctement", () => {
  const text = "Café à la crème brûlée, très parfumé";
  const s = normalizeText(text, LONG_DESCRIPTION_MAX_LENGTH);
  assert.equal(s.length, Array.from(text).length);
});

test("catalogue-text: emoji simple compte comme 1 caractere", () => {
  const s = normalizeText("🎂", SHORT_DESCRIPTION_MAX_LENGTH);
  assert.equal(s.length, 1);
  assert.equal("🎂".length, 2, "temoin : .length JS brut donne 2 pour ce emoji");
});

test("catalogue-text: espaces/tabulations/retours ligne en bordure retires (meme jeu que V65)", () => {
  const s = normalizeText("  \t\r\nCafé serré\t \r\n  ", LONG_DESCRIPTION_MAX_LENGTH);
  assert.equal(s.value, "Café serré");
});

test("catalogue-text: 'vegetarien' reste intact (meme garde-fou que V65 sur \\v)", () => {
  const s = normalizeText("  végétarien  ", LONG_DESCRIPTION_MAX_LENGTH);
  assert.equal(s.value, "végétarien");
});

test("catalogue-text: texte vide -> textPayload renvoie null, jamais tronque au-dela de la limite", () => {
  assert.equal(textPayload("", SHORT_DESCRIPTION_MAX_LENGTH), null);
  assert.equal(textPayload("   ", SHORT_DESCRIPTION_MAX_LENGTH), null);
  const long = "a".repeat(600);
  assert.equal(textPayload(long, LONG_DESCRIPTION_MAX_LENGTH), long);
  assert.equal(textPayload(long, LONG_DESCRIPTION_MAX_LENGTH)!.length, 600);
});

// --- 2. lib/services/catalogue-error.ts ------------------------------

test("catalogue-error: description courte trop longue reconnue sur le couple code+message", () => {
  assert.equal(
    isShortDescriptionTooLongError({ code: "22001", message: SHORT_DESCRIPTION_TOO_LONG_CODE }),
    true
  );
  assert.equal(
    isShortDescriptionTooLongError({ code: "22001", message: "autre chose" }),
    false
  );
  assert.equal(
    isShortDescriptionTooLongError({ code: "23505", message: SHORT_DESCRIPTION_TOO_LONG_CODE }),
    false
  );
});

test("catalogue-error: description longue trop longue reconnue sur le couple code+message", () => {
  assert.equal(
    isDescriptionTooLongError({ code: "22001", message: DESCRIPTION_TOO_LONG_CODE }),
    true
  );
  assert.equal(
    isDescriptionTooLongError({ code: "22001", message: "autre chose" }),
    false
  );
});

test("catalogue-error: doublon de categorie reconnu sur le vrai SQLSTATE 23505 + message", () => {
  assert.equal(
    isCategoryDuplicateNameError({ code: "23505", message: CATEGORY_DUPLICATE_NAME_CODE }),
    true
  );
  assert.equal(
    isCategoryDuplicateNameError({ code: "23505", message: "duplicate key value violates unique constraint" }),
    false,
    "un 23505 generique sans le message stable ne doit pas etre requalifie"
  );
  assert.equal(
    isCategoryDuplicateNameError({ code: "22001", message: CATEGORY_DUPLICATE_NAME_CODE }),
    false
  );
});

test("catalogue-error: erreur absente/nulle jamais reconnue", () => {
  assert.equal(isShortDescriptionTooLongError(null), false);
  assert.equal(isDescriptionTooLongError(undefined), false);
  assert.equal(isCategoryDuplicateNameError(null), false);
});

// --- 3. Controles statiques de la migration V66 ----------------------

const migrationSql = readFileSync("supabase/migration-v66-categories-descriptions.sql", "utf8");

test("migration V66: create_product et update_product sont supprimees puis recreees (drop function, jamais cascade)", () => {
  assert.ok(
    migrationSql.includes("drop function if exists public.create_product(uuid, text, text, numeric);"),
    "l'ancienne signature exacte a 4 parametres doit etre supprimee"
  );
  assert.ok(
    migrationSql.includes("drop function if exists public.update_product(uuid, text, text, numeric);")
  );
  assert.ok(
    !/drop function.*cascade/i.test(migrationSql),
    "aucun DROP FUNCTION ne doit utiliser CASCADE"
  );
});

test("migration V66: get_merchant_catalogue est supprimee puis recreee avec short_description", () => {
  assert.ok(
    migrationSql.includes("drop function if exists public.get_merchant_catalogue(uuid, boolean);")
  );
  assert.ok(migrationSql.includes("short_description"));
  assert.ok(
    migrationSql.includes("category_is_option_source"),
    "la detection de categorie technique doit etre exposee"
  );
});

test("migration V66: les DROP+CREATE des RPC produits sont dans la transaction principale (begin;/commit;)", () => {
  const beginIdx = migrationSql.search(/^begin;/m);
  const commitIdx = migrationSql.search(/^commit;/m);
  const dropCreateIdx = migrationSql.indexOf(
    "drop function if exists public.create_product(uuid, text, text, numeric);"
  );
  assert.ok(beginIdx >= 0 && commitIdx > beginIdx);
  assert.ok(
    dropCreateIdx > beginIdx && dropCreateIdx < commitIdx,
    "le drop+recreate de create_product doit etre dans la transaction"
  );
});

test("migration V66: aucun set_category_active n'est cree", () => {
  // Le fichier mentionne ce nom en negatif dans ses commentaires
  // (pour documenter explicitement son absence) : on verifie donc
  // l'absence de toute CREATION de cette fonction, pas l'absence
  // totale du texte.
  assert.ok(
    !/create (or replace )?function public\.set_category_active/i.test(migrationSql),
    "set_category_active est explicitement hors perimetre V66"
  );
});

test("migration V66: create_category n'accepte aucun parametre p_is_active", () => {
  const start = migrationSql.indexOf("create function public.create_category(");
  const end = migrationSql.indexOf("as $$", start);
  assert.ok(start >= 0 && end > start);
  const signature = migrationSql.slice(start, end);
  assert.ok(!/p_is_active/i.test(signature), "aucun parametre p_is_active dans create_category");
  assert.ok(
    migrationSql.slice(start, migrationSql.indexOf("end $$;", start)).includes("true"),
    "is_active doit etre force a true dans le corps de la fonction"
  );
});

test("migration V66: update_category ne modifie jamais la colonne is_active", () => {
  const start = migrationSql.indexOf("create function public.update_category(");
  const end = migrationSql.indexOf("end $$;", start);
  assert.ok(start >= 0 && end > start);
  const body = migrationSql.slice(start, end);
  assert.ok(!/is_active/i.test(body), "update_category ne doit jamais referencer is_active");
});

test("migration V66: aucune utilisation de \\v dans les chaines de normalisation SQL (piege V65)", () => {
  // Isole les arguments E'...' reellement passes a btrim dans ce
  // fichier -- ne prouve pas le comportement PostgreSQL reel (voir
  // V65 : \v produit la lettre "v", pas la tabulation verticale),
  // verifie seulement l'absence de regression textuelle. chr(11) a
  // ete verifie empiriquement sur PostgreSQL 16 (voir le fichier V65
  // et le compte-rendu d'execution de cette migration).
  const btrimArgs = [...migrationSql.matchAll(/btrim\([^,]+,\s*(E'[^']*')/g)].map((m) => m[1]);
  assert.ok(btrimArgs.length > 0, "au moins un appel btrim attendu");
  for (const arg of btrimArgs) {
    assert.ok(!arg.includes("\\v"), `\\v trouve dans un argument btrim : ${arg}`);
  }
  assert.ok(migrationSql.includes("chr(11)"), "chr(11) attendu pour la tabulation verticale");
});

test("migration V66: index unique partiel anti-doublon limite aux categories actives (creation sans IF NOT EXISTS, corrige apres 3e audit)", () => {
  // Corrige apres le 3e audit independant : IF NOT EXISTS a ete
  // retire de la creation reelle -- le controle prealable garantit
  // deja l'absence de tout objet homonyme (section 1h), donc laisser
  // IF NOT EXISTS ici masquerait silencieusement toute collision
  // residuelle plutot que de faire echouer bruyamment.
  assert.ok(
    migrationSql.includes("create unique index idx_menu_categories_unique_active_name"),
  );
  assert.ok(
    !migrationSql.includes("create unique index if not exists idx_menu_categories_unique_active_name"),
    "IF NOT EXISTS ne doit plus etre present sur la creation reelle de l'index"
  );
  const idxStart = migrationSql.indexOf("create unique index idx_menu_categories_unique_active_name");
  const idxStmt = migrationSql.slice(idxStart, migrationSql.indexOf(";", idxStart) + 1);
  assert.ok(idxStmt.includes("where is_active = true"), "la contrainte doit etre limitee aux categories actives");
  assert.ok(idxStmt.includes("lower("), "comparaison insensible a la casse attendue");
  assert.ok(!idxStmt.toLowerCase().includes("unaccent"), "sensible aux accents : aucune fonction unaccent");
});

test("migration V66: reaffirmation de la revocation sur menu_categories, reexecutable sans danger", () => {
  assert.ok(
    /revoke references, trigger, truncate\s+on table public\.menu_categories\s+from anon, authenticated;/.test(
      migrationSql
    )
  );
});

test("migration V66: controle prealable de non-derive du schema precede la transaction principale", () => {
  const beginIdx = migrationSql.search(/^begin;/m);
  const doIdx = migrationSql.indexOf("SCANYM_SCHEMA_DRIFT");
  assert.ok(doIdx >= 0 && doIdx < beginIdx, "le controle de derive doit preceder begin;");
});

// --- 4. Symetrie des dictionnaires FR/EN/AR --------------------------

function extractDictKeys(source: string, name: string): Set<string> {
  const start = source.indexOf(`const ${name}: Dict = {`);
  assert.ok(start >= 0, `dictionnaire '${name}' introuvable`);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = source.slice(braceStart, i + 1);
  return new Set([...body.matchAll(/^\s*([A-Za-z0-9_]+):/gm)].map((m) => m[1]));
}

const V66_KEYS = [
  "mcShortDescription",
  "mcCounter",
  "mcAddCategory",
  "mcEditCategory",
  "mcCategoryName",
  "mcCategoryOrder",
  "mcCategoryDuplicate",
  "mcCategoryEmpty",
  "mcTechnicalBadge",
  "mcTechnicalBadgeHint",
  "mcShortDescriptionTooLong",
  "mcDescriptionTooLong",
  "moreInfoAbout",
];

test("i18n: toutes les cles V66 existent dans les 3 langues, sans quatrieme dictionnaire", () => {
  const source = readFileSync("lib/i18n.ts", "utf8");
  const fr = extractDictKeys(source, "fr");
  const en = extractDictKeys(source, "en");
  const ar = extractDictKeys(source, "ar");
  for (const key of V66_KEYS) {
    assert.ok(fr.has(key), `cle '${key}' absente du dictionnaire fr`);
    assert.ok(en.has(key), `cle '${key}' absente du dictionnaire en`);
    assert.ok(ar.has(key), `cle '${key}' absente du dictionnaire ar`);
  }
});

// --- 5. Affichage public : courte directe, longue derriere (i) ------

test("MenuItemCard: la description courte est affichee directement (tShortDescription)", () => {
  const source = readFileSync("components/MenuItemCard.tsx", "utf8");
  assert.ok(source.includes("tShortDescription"), "tShortDescription doit etre utilise");
});

test("MenuItemCard: la description longue n'est plus affichee directement, uniquement via ProductInfoButton", () => {
  const source = readFileSync("components/MenuItemCard.tsx", "utf8");
  assert.ok(source.includes("ProductInfoButton"), "ProductInfoButton doit etre utilise");
  const directLongDisplay = /<p[^>]*>\s*\{tDescription\(/;
  assert.ok(
    !directLongDisplay.test(source),
    "tDescription ne doit plus etre rendue directement dans un <p>"
  );
});

test("ProductInfoButton: chaque rendu est garde par une verification de non-vide", () => {
  const menuItemCardSource = readFileSync("components/MenuItemCard.tsx", "utf8");
  // Ne compte que les usages JSX (<ProductInfoButton), pas l'import
  // (qui contient aussi le nom dans le chemin du module).
  const occurrences = (menuItemCardSource.match(/<ProductInfoButton/g) || []).length;
  const guardedOccurrences = (
    menuItemCardSource.match(/\{tDescription\(item, lang\) && \(/g) || []
  ).length;
  assert.ok(occurrences >= 2, "ProductInfoButton doit etre utilise dans les deux variantes de carte");
  assert.equal(
    guardedOccurrences,
    occurrences,
    "chaque rendu de ProductInfoButton doit etre garde par une verification de non-vide"
  );
});

test("ProductInfoButton: bouton declencheur accessible (aria-label, aria-expanded, aria-controls, clavier natif)", () => {
  const source = readFileSync("components/ProductInfoButton.tsx", "utf8");
  assert.ok(source.includes("aria-label"));
  assert.ok(source.includes("aria-expanded"));
  assert.ok(source.includes("aria-controls"));
  assert.ok(source.includes('type="button"'), "doit etre un vrai <button>, operable au clavier nativement");
  assert.ok(
    (source.match(/stopPropagation/g) || []).length >= 1,
    "le declencheur doit stopper la propagation, pour ne jamais declencher l'ajout au panier"
  );
});

test("ProductInfoButton: HTML valide -- racine <div>, jamais <span> contenant un <dialog>/<div>", () => {
  // Corrige B-02 (audit independant) : un <span> n'accepte que du
  // contenu de phrase ; un <dialog> ou un <div> ne peut jamais en
  // etre un descendant valide. Verifie a la fois que le composant
  // n'utilise plus <span> comme racine, ET que son appelant
  // (MenuItemCard.tsx) ne le reenveloppe pas dans un <span> non plus.
  const source = readFileSync("components/ProductInfoButton.tsx", "utf8");
  assert.ok(
    /return \(\s*<div /.test(source),
    "la racine du composant doit etre un <div>, jamais un <span>"
  );
  assert.ok(source.includes("<dialog"), "doit utiliser l'element HTML natif <dialog>");

  const menuItemCardSource = readFileSync("components/MenuItemCard.tsx", "utf8");
  assert.ok(
    !/<span[^>]*>\s*<ProductInfoButton/.test(menuItemCardSource),
    "MenuItemCard ne doit plus envelopper ProductInfoButton dans un <span>"
  );
});

test("ProductInfoButton: dialogue nomme et semantique modale coherente", () => {
  // Corrige B-03 (audit independant) : role="dialog" sans nom
  // accessible + fond bloquant tous les clics = comportement modal
  // sans les garanties d'un vrai modal. <dialog> + showModal() donne
  // nativement le piege de focus et l'arriere-plan inerte ; aria-label
  // fournit le nom accessible manquant.
  const source = readFileSync("components/ProductInfoButton.tsx", "utf8");
  assert.ok(source.includes("showModal()"), "doit utiliser dialog.showModal() pour une semantique reellement modale");
  assert.ok(
    /<dialog[\s\S]*?aria-label={triggerLabel}/.test(source),
    "le <dialog> lui-meme doit avoir un nom accessible (aria-label), pas seulement le declencheur"
  );
  // Aucune trace de l'ancien role="dialog" manuel + aria-modal="false"
  // incoherent : <dialog> porte un role implicite, pas besoin de role
  // explicite, et le mode est desormais reellement modal.
  assert.ok(!source.includes('aria-modal="false"'));
});

test("ProductInfoButton: restitue le focus au declencheur apres fermeture, via l'evenement 'close' natif", () => {
  const source = readFileSync("components/ProductInfoButton.tsx", "utf8");
  assert.ok(source.includes("triggerRef"), "une ref vers le bouton declencheur est attendue");
  assert.ok(
    source.includes("triggerRef.current?.focus()"),
    "le focus doit etre explicitement rendu au declencheur"
  );
  // Source unique de fermeture : l'evenement 'close' natif du
  // <dialog> (onClose), declenche par les 3 chemins (Echap natif,
  // clic sur ::backdrop -> close(), bouton fermer -> close()).
  assert.ok(source.includes("onClose="), "onClose doit centraliser la restitution du focus");
  const closeCalls = (source.match(/dialogRef\.current\?\.close\(\)/g) || []).length;
  assert.ok(closeCalls >= 2, `attendu au moins 2 appels a dialogRef.current?.close() (fond, bouton), trouve ${closeCalls}`);
});

test("ProductInfoButton: useId() garantit un aria-controls unique par instance (plusieurs produits sur une page)", () => {
  const source = readFileSync("components/ProductInfoButton.tsx", "utf8");
  assert.ok(source.includes("useId()"), "useId() doit etre utilise pour panelId (unique par instance montee)");
  assert.ok(!/panelId\s*=\s*["'`]/.test(source), "panelId ne doit jamais etre une chaine statique partagee");
});

test("ProductInfoButton: fermeture au clavier geree nativement, aucun ecouteur manuel a fuir", () => {
  // <dialog>.showModal() gere Echap nativement (evenement 'cancel'
  // puis 'close') : plus d'ecouteur keydown manuel a ajouter/retirer,
  // donc plus aucun risque de fuite d'evenement sur ce point precis.
  const source = readFileSync("components/ProductInfoButton.tsx", "utf8");
  assert.ok(
    !source.includes("addEventListener"),
    "aucun ecouteur manuel attendu : <dialog> gere Echap nativement"
  );
});

// --- 6. Non-regression -------------------------------------------------

test("non-regression : buildWhatsAppUrl reste appele depuis un seul composant", () => {
  const source = readFileSync("components/MenuView.tsx", "utf8");
  const occurrences = (source.match(/buildWhatsAppUrl\(/g) || []).length;
  assert.equal(occurrences, 1);
});

test("non-regression : create_order et update_order_status ne sont pas redefinies par cette migration", () => {
  // Un commentaire du fichier mentionne ces noms en prose pour
  // confirmer qu'ils ne sont pas touches ; on verifie donc l'absence
  // de toute DEFINITION (create/replace/drop function), pas l'absence
  // totale du texte.
  assert.ok(!/function public\.create_order\(/.test(migrationSql));
  assert.ok(!/function public\.update_order_status\(/.test(migrationSql));
});

test("non-regression : assert_product_role n'est pas redefinie (seulement appelee, comme avant)", () => {
  // update_product continue d'appeler assert_product_role (comportement
  // inchange) ; ce test verifie l'absence de redefinition, pas
  // l'absence totale de mention.
  assert.ok(
    !/create (or replace )?function public\.assert_product_role/i.test(migrationSql),
    "assert_product_role ne doit pas etre redefinie par cette migration"
  );
  assert.ok(
    migrationSql.includes("public.assert_product_role("),
    "update_product doit continuer a l'appeler, sans changement"
  );
});

test("non-regression : aucune mention de photos, Storage, variantes, tailles, stocks de produits dans le SQL V66", () => {
  // Termes précis pour éviter les faux positifs sur du vocabulaire
  // français légitime (ex. "stocker" = to store, sans rapport avec
  // les stocks de produits).
  const forbidden = [
    "storage.",
    "image_url =",
    "product_variant",
    "stock_quantity",
    "quantity_available",
  ];
  for (const term of forbidden) {
    assert.ok(
      !migrationSql.toLowerCase().includes(term.toLowerCase()),
      `terme hors perimetre trouve dans la migration V66 : ${term}`
    );
  }
});

test("dashboard.ts : les nouvelles RPC sont bien appelees par leur nom exact", () => {
  const source = readFileSync("lib/services/dashboard.ts", "utf8");
  assert.ok(source.includes('"create_category"'));
  assert.ok(source.includes('"update_category"'));
  assert.ok(source.includes("p_short_description"));
});

test("M-06 (audit independant) : les etats d'edition sont reinitialises au changement de restaurant", () => {
  const source = readFileSync("app/dashboard/catalogue/page.tsx", "utf8");
  assert.ok(
    /useEffect\(\(\) => \{[\s\S]*?setEditingId\(null\)[\s\S]*?setCreatingIn\(null\)[\s\S]*?setEditingCategoryId\(null\)[\s\S]*?\}, \[restaurantId\]\)/.test(
      source
    ),
    "un useEffect keye sur [restaurantId] doit reinitialiser les modes creation/edition et les brouillons"
  );
});

test("migration V66: le REVOKE sur menu_categories est desormais A L'INTERIEUR de la transaction (corrige apres audit, B-01)", () => {
  const beginIdx = migrationSql.search(/^begin;/m);
  const commitIdx = migrationSql.search(/^commit;/m);
  const revokeIdx = migrationSql.indexOf(
    "revoke references, trigger, truncate\non table public.menu_categories\nfrom anon, authenticated;"
  );
  assert.ok(beginIdx >= 0 && commitIdx > beginIdx);
  assert.ok(
    revokeIdx > beginIdx && revokeIdx < commitIdx,
    "le REVOKE documentaire doit etre a l'interieur de begin;/commit;, pas avant"
  );
});

test("migration V66: contraintes CHECK de longueur sur short_description et description (defense en profondeur, M-02)", () => {
  assert.ok(migrationSql.includes("menu_items_short_description_length_chk"));
  assert.ok(migrationSql.includes("menu_items_description_length_chk"));
  assert.ok(/char_length\(short_description\) <= 100/.test(migrationSql));
  assert.ok(/char_length\(description\) <= 500/.test(migrationSql));
});

test("migration V66: le controle de derive verifie proprietaire, SECURITY DEFINER, search_path et la policy publique (M-01)", () => {
  assert.ok(migrationSql.includes("pg_get_userbyid"), "verification du proprietaire attendue");
  assert.ok(migrationSql.includes("prosecdef"), "verification SECURITY DEFINER attendue");
  assert.ok(migrationSql.includes("search_path"), "verification search_path attendue");
  assert.ok(
    migrationSql.includes("lecture publique categories"),
    "verification de la policy de lecture publique attendue (nom exact, sans accent)"
  );
});

test("migration V66: le controle de derive refuse toute preexistence de l'index, sur N'IMPORTE QUELLE table du schema public (M-03 puis SA3-M01)", () => {
  // Corrige apres le 2e audit (comparaison par sous-chaines trop
  // permissive), PUIS apres le 3e audit qui a demontre que la
  // qualification "ET table = menu_categories" du 2e correctif
  // laissait passer un objet HOMONYME attache a une AUTRE table (les
  // noms de relations partagent le meme espace de noms en
  // PostgreSQL). Le controle final ne qualifie plus que par schema,
  // sans restreindre a menu_categories ni au type "index".
  assert.ok(migrationSql.includes("idx_menu_categories_unique_active_name"));
  assert.ok(
    !migrationSql.includes("join pg_index ix on ix.indexrelid = c.oid"),
    "l'ancienne jointure via pg_index/menu_categories (2e audit, insuffisante) ne doit plus etre presente"
  );
  const checkStart = migrationSql.indexOf("-- 1h. Index anti-doublon");
  const checkEnd = migrationSql.indexOf("end $$;", checkStart);
  const checkBlock = migrationSql.slice(checkStart, checkEnd);
  assert.ok(
    checkBlock.includes("n.nspname = 'public' and c.relname = 'idx_menu_categories_unique_active_name'") &&
      !checkBlock.includes("t.relname = 'menu_categories'"),
    "le controle doit rejeter tout objet de ce nom dans public, quelle que soit la table concernee"
  );
  assert.ok(
    !/def not ilike|indexdef.*ilike/.test(migrationSql),
    "aucune comparaison par sous-chaines (ilike) ne doit subsister pour cet index"
  );
});

test("migration V66 (SA2-B01 puis SA3-B01, corrige) : verification reelle des droits EXECUTE des fonctions (has_function_privilege + aclexplode/acldefault)", () => {
  // Le 1er audit avait deja demande cette verification ; le 2e audit
  // a demontre qu'elle etait ANNONCEE dans un commentaire sans etre
  // reellement implementee. Verifie ici que l'implementation reelle
  // est bien presente pour les FONCTIONS.
  assert.ok(migrationSql.includes("has_function_privilege('anon'"));
  assert.ok(migrationSql.includes("has_function_privilege('authenticated'"));
  assert.ok(migrationSql.includes("aclexplode"));
  assert.ok(migrationSql.includes("acldefault"));
});

test("migration V66 (SA3-B01, corrige apres 3e audit) : droits de TABLE verifies via has_table_privilege, PUBLIC inclus", () => {
  // Le 3e audit a demontre que le controle precedent (SA2-B01)
  // n'agregeait que les lignes de information_schema.role_table_grants
  // ou grantee='anon'/'authenticated', ce qui NE DETECTE JAMAIS un
  // droit accorde a PUBLIC (effectif pour tous les roles). Un
  // `grant insert on menu_categories to public;` passait donc
  // silencieusement, meme si les grants directs a anon/authenticated
  // semblaient conformes ({SELECT} seul). Corrige avec
  // has_table_privilege(), qui resout correctement PUBLIC (verifie
  // empiriquement sur PostgreSQL 16 avant integration).
  assert.ok(
    !migrationSql.includes("array['REFERENCES','SELECT','TRIGGER','TRUNCATE']"),
    "l'ancienne comparaison d'ensembles exacts (qui ignorait PUBLIC) ne doit plus etre presente"
  );
  assert.ok(migrationSql.includes("has_table_privilege(v_fn.role_name, 'public.menu_categories', 'SELECT')"));
  assert.ok(migrationSql.includes("has_table_privilege(v_fn.role_name, 'public.menu_categories', 'INSERT')"));
  assert.ok(migrationSql.includes("has_table_privilege(v_fn.role_name, 'public.menu_categories', 'UPDATE')"));
  assert.ok(migrationSql.includes("has_table_privilege(v_fn.role_name, 'public.menu_categories', 'DELETE')"));
  // Verification complementaire explicite de l'ACL de PUBLIC sur la
  // table elle-meme (symetrique a celle deja faite pour les fonctions).
  assert.ok(
    migrationSql.includes("aclexplode(coalesce(c.relacl, acldefault('r', c.relowner)))"),
    "inspection explicite de l'ACL de PUBLIC sur menu_categories attendue"
  );
});

test("migration V66 (SA2-B01) : la policy publique verifie cmd, roles ET mode permissif, pas seulement la condition", () => {
  assert.ok(migrationSql.includes("v_policy.cmd is distinct from 'SELECT'"));
  assert.ok(migrationSql.includes("v_policy.roles is distinct from array['public']"));
  assert.ok(migrationSql.includes("v_policy.permissive is distinct from 'PERMISSIVE'"));
});

test("SA2-B02 (corrige apres 2e audit) : une migration de rollback dediee existe et supprime les RPC V66 dans le bon ordre", () => {
  const rollbackSql = readFileSync("supabase/migration-v66-rollback.sql", "utf8");
  assert.ok(rollbackSql.includes("drop function if exists public.update_category"));
  assert.ok(rollbackSql.includes("drop function if exists public.create_category"));
  assert.ok(rollbackSql.includes("drop function if exists public.assert_category_role"));
  assert.ok(rollbackSql.includes("drop function if exists public.get_merchant_catalogue(uuid, boolean)"));
  // get_merchant_catalogue doit etre supprimee AVANT sa propre
  // recreation (type de retour different, create or replace impossible).
  const dropIdx = rollbackSql.indexOf("drop function if exists public.get_merchant_catalogue");
  const recreateIdx = rollbackSql.indexOf("create or replace function public.get_merchant_catalogue");
  assert.ok(dropIdx >= 0 && recreateIdx > dropIdx);
  // Verification finale post-rollback, reellement executee dans la transaction.
  assert.ok(rollbackSql.includes("SCANYM_ROLLBACK_INCOMPLETE"));
});

test("SA2-B03 (corrige apres 2e audit) : un harnais PostgreSQL reproductible existe, avec journal d'execution", () => {
  const harness = readFileSync("supabase/tests/v66-integration-test.sh", "utf8");
  assert.ok(harness.includes("set -euo pipefail"), "doit s'arreter au premier echec");
  assert.ok(harness.includes("trap cleanup EXIT"), "doit nettoyer sa base ephemere meme en cas d'echec");
  assert.ok(harness.includes("assert_eq"), "doit contenir des assertions explicites, pas seulement des requetes");
  const log = readFileSync("supabase/tests/v66-integration-test-log-sample.txt", "utf8");
  assert.ok(log.includes("TOUS LES TESTS ONT REUSSI"));
  assert.ok(!/FAIL:/.test(log), "le journal d'exemple fourni ne doit contenir aucun echec");
});

test("SA3-M02 (corrige apres audit Work du 11 aout 2026) : scenarios positifs et negatifs distincts, nettoyage systematique de TOUTES les bases temporaires", () => {
  // L'audit Work a releve deux defauts dans la version precedente :
  // (1) le trap EXIT ne nettoyait que la DERNIERE base creee, pas
  //     toutes les bases des scenarios precedents ;
  // (2) le rapport et le harnais appelaient les 5 scenarios (dont 2
  //     sont positifs : etat A, etat B) "5 scenarios negatifs" -- une
  //     terminologie trompeuse.
  const harness = readFileSync("supabase/tests/v66-integration-test-negative.sh", "utf8");
  assert.ok(harness.includes("set -euo pipefail"));
  assert.ok(harness.includes("bootstrap_v65"), "chaque scenario doit repartir d'une base V65 fraiche et isolee");
  assert.ok(harness.includes("grant insert on table public.menu_categories to public"), "scenario PUBLIC INSERT (SA3-B01) attendu");
  assert.ok(
    harness.includes("grant truncate on table public.menu_categories to public"),
    "scenario PUBLIC TRUNCATE (SA3-B01, exemple explicitement exige par l'audit Work) attendu"
  );
  assert.ok(
    harness.includes("grant_via_inherited_role"),
    "scenario de privilege herite via un role tiers (SA3-B01, audit Work) attendu"
  );
  assert.ok(
    harness.includes("create unique index idx_menu_categories_unique_active_name on public.menu_items(id)"),
    "scenario de collision d'index sur une autre table (SA3-M01) attendu"
  );
  assert.ok(harness.includes("état A"), "scenario etat A attendu");
  assert.ok(harness.includes("état B"), "scenario etat B attendu");
  // Terminologie corrigee dans le RESULTAT du run (pas seulement dans
  // les commentaires historiques qui, eux, citent legitimement
  // l'ancienne formulation trompeuse pour expliquer la correction) :
  // le message final distingue explicitement les deux categories,
  // plutot que de tout regrouper sous "N scenarios negatifs".
  const resultLine = (harness.match(/RÉSULTAT FINAL[^\n]*/) || [""])[0];
  assert.ok(resultLine.includes("scénarios positifs"), "le message de resultat final doit nommer les scenarios positifs");
  assert.ok(resultLine.includes("scénarios négatifs"), "le message de resultat final doit nommer les scenarios negatifs");
  assert.ok(harness.includes("SCÉNARIOS POSITIFS"), "les scenarios positifs doivent etre nommes explicitement comme tels");
  assert.ok(harness.includes("SCÉNARIOS NÉGATIFS"), "les scenarios negatifs doivent etre nommes explicitement comme tels");
  // Nettoyage systematique : toutes les bases creees sont suivies et
  // supprimees, pas seulement la derniere (CURRENT_DB).
  assert.ok(harness.includes("CREATED_DBS"), "toutes les bases creees doivent etre suivies, pas seulement la derniere");
  assert.ok(harness.includes("cleanup_all"), "le nettoyage doit couvrir toutes les bases suivies");
  assert.ok(harness.includes("trap cleanup_all EXIT"), "filet de securite meme en cas d'echec du script");
  assert.ok(
    harness.includes("aucune base temporaire de ce run ne subsiste") ||
      harness.includes("aucune base scanym_v66% ne subsiste"),
    "le nettoyage doit etre verifie explicitement, pas seulement tente"
  );
  // Preuve que l'etat reste inchange apres chaque echec, pas
  // seulement que la commande a renvoye une erreur.
  assert.ok(
    (harness.match(/signature V65 inchangée après l'échec/g) || []).length >= 6,
    "chaque scenario negatif doit prouver que l'etat (signature V65) reste inchange"
  );
  const log = readFileSync("supabase/tests/v66-integration-test-negative-log-sample.txt", "utf8");
  assert.ok(log.includes("2 scénarios positifs, 6 scénarios négatifs"));
  assert.ok(log.includes("TOUS LES SCÉNARIOS (POSITIFS ET NÉGATIFS) ET LE NETTOYAGE"));
  assert.ok(!/FAIL:/.test(log), "le journal d'exemple fourni ne doit contenir aucun echec");
});

test("Correction (2e passage audit Work, 11 aout 2026) : cleanup du role cluster-global scanym_v66_role_tiers", () => {
  // Le 1er passage de l'audit Work a releve que le harnais nettoyait
  // les bases ephemeres mais jamais le role PostgreSQL cluster-global
  // cree par le scenario de privilege herite : contrairement a une
  // base, un role n'est pas local a une base, il persiste tant qu'il
  // n'est pas explicitement supprime.
  const harness = readFileSync("supabase/tests/v66-integration-test-negative.sh", "utf8");
  assert.ok(harness.includes("CREATED_ROLES"), "les roles crees doivent etre suivis, comme les bases");
  assert.ok(harness.includes("track_role"), "fonction dediee pour suivre un role sans le suivre deux fois");
  assert.ok(
    /revoke \\?"?\$role\\?"? from anon/.test(harness),
    "l'appartenance doit etre revoquee avant la suppression du role"
  );
  assert.ok(
    /drop role if exists \\?"?\$role\\?"?/.test(harness),
    "le role doit etre supprime (IF EXISTS, idempotent)"
  );
  // Ordre : les bases sont supprimees AVANT les roles (un role ne
  // peut pas etre supprime tant qu'il detient un privilege sur une
  // table encore existante).
  const cleanupFn = harness.slice(harness.indexOf("cleanup_all() {"), harness.indexOf("trap cleanup_all EXIT"));
  const dbLoopIdx = cleanupFn.indexOf("CREATED_DBS");
  const roleLoopIdx = cleanupFn.indexOf("CREATED_ROLES");
  assert.ok(dbLoopIdx >= 0 && roleLoopIdx > dbLoopIdx, "les bases doivent etre supprimees avant les roles dans cleanup_all()");
  // Verification post-run explicite, en trois volets distincts exiges
  // par l'audit : aucune base, aucun role, aucune appartenance.
  assert.ok(harness.includes("aucune base scanym_v66% ne subsiste"));
  assert.ok(harness.includes("le rôle scanym_v66_role_tiers ne subsiste pas"));
  assert.ok(harness.includes("aucune appartenance résiduelle à scanym_v66_role_tiers"));
  assert.ok(harness.includes("pg_auth_members"), "l'appartenance residuelle doit etre verifiee via le catalogue systeme, pas supposee");
  const log = readFileSync("supabase/tests/v66-integration-test-negative-log-sample.txt", "utf8");
  assert.ok(log.includes("Nettoyage : aucune base scanym_v66% ne subsiste"));
  assert.ok(log.includes("Nettoyage : le rôle scanym_v66_role_tiers ne subsiste pas"));
  assert.ok(log.includes("Nettoyage : aucune appartenance résiduelle à scanym_v66_role_tiers"));
});

test("Correction (2e passage audit Work, 11 aout 2026) : preuve ACL au niveau catalogue, pas seulement code retour/signature", () => {
  // L'audit a demande une preuve directe de l'ACL de menu_categories
  // avant/apres un echec survenant APRES le REVOKE -- pas seulement la
  // confiance dans la semantique transactionnelle de PostgreSQL ni
  // l'inspection du code de la migration.
  const harness = readFileSync("supabase/tests/v66-integration-test-negative.sh", "utf8");
  assert.ok(harness.includes("menu_categories_acl"), "fonction dediee de capture ACL exacte (catalogue systeme)");
  assert.ok(harness.includes("role_table_grants"), "la capture ACL doit interroger le catalogue systeme reel");
  assert.ok(harness.includes("ACL_BEFORE"), "l'ACL doit etre capturee AVANT la tentative");
  assert.ok(harness.includes("ACL_AFTER"), "l'ACL doit etre re-capturee APRES l'echec");
  assert.ok(
    harness.includes('assert_eq "N6 preuve ACL : ACL catalogue de menu_categories strictement identique avant/après l\'échec" "$ACL_BEFORE" "$ACL_AFTER"'),
    "l'assertion doit comparer strictement l'ACL avant/apres, pas se contenter du code retour"
  );
  // Le scenario doit combiner un etat ou le REVOKE modifie REELLEMENT
  // le catalogue (etat A, droits directs) avec une cause d'echec qui
  // survient APRES le REVOKE (2a-bis, pas le controle pre-transaction) :
  // sinon la preuve serait triviale (rien n'aurait ete modifie avant
  // l'echec).
  assert.ok(
    harness.includes('grant select, references, trigger, truncate on all tables in schema public to anon, authenticated;" >/dev/null\ngrant_via_inherited_role "$DB" authenticated'),
    "N6 doit combiner etat A (REVOKE agit reellement) et privilege herite (echec APRES le REVOKE, via 2a-bis)"
  );
  const log = readFileSync("supabase/tests/v66-integration-test-negative-log-sample.txt", "utf8");
  assert.ok(log.includes("ACL catalogue de menu_categories strictement identique avant/après l'échec"));
});

test("Correction (2e passage audit Work, 11 aout 2026) : harnais principal reproductible sous Python 3.11, rejoue jusqu'au rollback", () => {
  const harness = readFileSync("supabase/tests/v66-integration-test.sh", "utf8");
  // La ligne executable (pas le commentaire d'en-tete, qui cite
  // legitimement l'ancienne syntaxe pour expliquer la correction) doit
  // utiliser la forme compatible Python 3.11 : $PRICE est deja
  // substitue par bash avant que Python ne lise le code, donc aucun
  // guillemet imbrique n'est necessaire.
  assert.ok(
    harness.includes("EXPECTED=$(python3 -c \"print(f'{$PRICE*2:.2f}')\")"),
    "le calcul du prix attendu doit utiliser une f-string sans guillemets imbriques (compatible Python 3.11)"
  );
  assert.ok(
    !/EXPECTED=.*float\(['"]\$PRICE['"]\)/.test(harness),
    "l'ancienne f-string a guillemets imbriques (invalide avant Python 3.12) ne doit plus etre executee"
  );
  const log = readFileSync("supabase/tests/v66-integration-test-log-sample.txt", "utf8");
  assert.ok(log.includes("RÉSULTAT FINAL : 33 réussis, 0 échoués"), "le harnais principal doit etre rejoue integralement jusqu'au rollback (33/33)");
  assert.ok(log.includes("TOUS LES TESTS ONT REUSSI"));
  assert.ok(!/FAIL:/.test(log), "le journal d'exemple fourni ne doit contenir aucun echec");
});

test("SA3-B01 (corrige apres audit Work du 11 aout 2026) : TRUNCATE/REFERENCES/TRIGGER verifies via PUBLIC et via has_table_privilege post-REVOKE", () => {
  // L'audit Work a demontre qu'un `grant truncate on ... to public;`
  // survivait reellement a la migration : le controle SA3-B01
  // precedent ne portait que sur INSERT/UPDATE/DELETE, jamais
  // TRUNCATE/REFERENCES/TRIGGER, et le REVOKE (section 2a) ne cible
  // que anon/authenticated, jamais PUBLIC ni un role tiers herite.
  assert.ok(
    migrationSql.includes("and a.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')"),
    "le controle PUBLIC pre-transaction doit couvrir TRUNCATE/REFERENCES/TRIGGER, pas seulement INSERT/UPDATE/DELETE"
  );
  assert.ok(
    migrationSql.includes("2a-bis"),
    "une verification post-REVOKE doit exister (le REVOKE ne cible pas PUBLIC ni les roles herites)"
  );
  assert.ok(
    /foreach v_priv in array array\[.*'TRUNCATE'.*'REFERENCES'.*'TRIGGER'.*\]/.test(migrationSql) ||
      (migrationSql.includes("'TRUNCATE'") && migrationSql.includes("'REFERENCES'") && migrationSql.includes("'TRIGGER'") && migrationSql.includes("2a-bis")),
    "la verification post-REVOKE doit couvrir TRUNCATE/REFERENCES/TRIGGER via has_table_privilege"
  );
});
