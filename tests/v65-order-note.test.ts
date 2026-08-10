import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  normalizeOrderNote,
  orderNotePayload,
  ORDER_NOTE_MAX_LENGTH,
} from "../lib/order-note.ts";
import { buildCreateOrderPayload } from "../lib/services/order-payload.ts";
import { buildWhatsAppUrl, type CartLine, type OrderContext } from "../lib/whatsapp.ts";
import {
  isOrderNoteTooLongError,
  ORDER_NOTE_TOO_LONG_CODE,
} from "../lib/services/order-error.ts";

// ====================================================================
// Sous-lot A (V65) — note générale de commande.
//
// Ne dépend jamais de lib/supabase.ts (qui lève une exception sans
// variables d'environnement) : lib/order-note.ts et
// lib/services/order-payload.ts sont des fonctions pures, importées
// directement. C'est délibéré (voir corrections demandées) pour que
// `npm test` reste exécutable sans configuration Supabase.
// ====================================================================

// --- 1. Normalisation et comptage ----------------------------------

test("note: chaîne vide -> isEmpty, valide, longueur 0", () => {
  const s = normalizeOrderNote("");
  assert.equal(s.isEmpty, true);
  assert.equal(s.isValid, true);
  assert.equal(s.length, 0);
});

test("note: null/undefined traités comme vides", () => {
  assert.equal(normalizeOrderNote(null).isEmpty, true);
  assert.equal(normalizeOrderNote(undefined).isEmpty, true);
});

test("note: espaces début/fin retirés (trim)", () => {
  const s = normalizeOrderNote("   sans lactose   ");
  assert.equal(s.value, "sans lactose");
  assert.equal(s.length, "sans lactose".length);
});

test("note: uniquement des espaces -> vide après trim", () => {
  const s = normalizeOrderNote("    ");
  assert.equal(s.isEmpty, true);
  assert.equal(s.value, "");
});

// --- 1bis. Trim explicite : tests COMPORTEMENTAUX JavaScript -------
//
// String.prototype.trim() (JS) et trim() (PostgreSQL) ne retirent PAS
// le même ensemble de caractères (vérifié, pas supposé) :
//   - JS "\u00A0x\u00A0".trim() retire l'espace insécable U+00A0.
//   - PostgreSQL trim() sans argument ne retire QUE l'espace ASCII
//     (U+0020) ; tabulations et sauts de ligne y restent.
// lib/order-note.ts n'utilise donc ni l'un ni l'autre nativement : un
// jeu de 6 caractères explicite est appliqué (voir EDGE_WHITESPACE,
// qui utilise \v — échappement JS valide pour U+000B).
//
// Le SQL couvre le même jeu conceptuel via
// btrim(..., E' \t\n\r\f' || chr(11)) — PAS E'...\v', qui produirait
// la lettre "v" et non U+000B en PostgreSQL (voir le commentaire en
// tête de lib/order-note.ts et de la migration). Les tests
// ci-dessous ne portent QUE sur le comportement JavaScript ; le
// comportement SQL réel est vérifié séparément par contrôle manuel
// sur PostgreSQL (voir plus bas "migration V65" et le bloc
// "0bis. CONTRÔLE MANUEL" dans supabase/migration-v65-order-note.sql).

test("note: tabulation en bordure retirée", () => {
  const s = normalizeOrderNote("\tsans lactose\t");
  assert.equal(s.value, "sans lactose");
});

test("note: saut de ligne (LF) en bordure retiré", () => {
  const s = normalizeOrderNote("\nsans lactose\n");
  assert.equal(s.value, "sans lactose");
});

test("note: retour chariot (CR) en bordure retiré", () => {
  const s = normalizeOrderNote("\rsans lactose\r");
  assert.equal(s.value, "sans lactose");
});

test("note: saut de page (FF) et tabulation verticale (VT) en bordure retirés", () => {
  const s = normalizeOrderNote("\fsans lactose\v");
  assert.equal(s.value, "sans lactose");
});

test("note: combinaison espace/tab/CRLF en bordure, retirée en un seul passage", () => {
  const s = normalizeOrderNote("  \t\r\nMerci de sonner\t \r\n  ");
  assert.equal(s.value, "Merci de sonner");
});

test("note: espace insécable (NBSP, U+00A0) en bordure — VOLONTAIREMENT PAS retiré", () => {
  // Choix explicite : le jeu de caractères retiré est restreint et
  // identique des deux côtés (voir commentaire ci-dessus). NBSP n'en
  // fait pas partie ; il doit être traité comme un caractère de
  // contenu ordinaire, pas comme un espace de bordure.
  const s = normalizeOrderNote("\u00A0Merci\u00A0");
  assert.equal(s.value, "\u00A0Merci\u00A0");
  assert.equal(s.isEmpty, false);
});

test("note: tabulation interne (pas en bordure) conservée telle quelle", () => {
  const s = normalizeOrderNote("Table\tn°4 côté fenêtre");
  assert.equal(s.value, "Table\tn°4 côté fenêtre");
});

test("note: retour à la ligne interne conservé (note multi-lignes)", () => {
  const s = normalizeOrderNote("Sans oignon\nBien cuit");
  assert.equal(s.value, "Sans oignon\nBien cuit");
  assert.equal(s.length, "Sans oignon\nBien cuit".length);
});

test("note: tabulation verticale réelle (U+000B) en bordure retirée (JS)", () => {
  // \v en JavaScript EST un échappement reconnu pour U+000B (contrairement
  // à PostgreSQL E'\v', voir les tests de migration plus bas). Ce test
  // vaut uniquement pour le côté JS.
  const s = normalizeOrderNote("\vsans lactose\v");
  assert.equal(s.value, "sans lactose");
});

test("note: 'végétarien' reste intact, y compris avec espaces en bordure", () => {
  const s = normalizeOrderNote("  végétarien  ");
  assert.equal(s.value, "végétarien");
});

test("note: 'bravo' reste intact", () => {
  const s = normalizeOrderNote("bravo");
  assert.equal(s.value, "bravo");
});

test("note: 'v' seul reste intact, n'est jamais vidé", () => {
  const s = normalizeOrderNote("v");
  assert.equal(s.value, "v");
  assert.equal(s.isEmpty, false);
});

test("note: texte français accentué compté correctement", () => {
  const text = "Pas de café, merci — allergie légère aux noisettes";
  const s = normalizeOrderNote(text);
  assert.equal(s.length, Array.from(text).length);
  assert.equal(s.isValid, true);
});

test("note: texte arabe compté correctement", () => {
  const text = "الرجاء عدم إضافة الفستق، حساسية لدى الطفل";
  const s = normalizeOrderNote(text);
  assert.equal(s.length, Array.from(text).length);
  assert.equal(s.isValid, true);
});

test("note: emoji simple compté comme 1 caractère (pas 2 comme .length JS)", () => {
  const s = normalizeOrderNote("🎂");
  assert.equal(s.length, 1);
  assert.equal("🎂".length, 2, "témoin : .length JS brut donne bien 2 pour ce emoji");
});

test("note: plusieurs emojis comptés un par un", () => {
  const s = normalizeOrderNote("🎂🎉🍰🥳");
  assert.equal(s.length, 4);
});

test("note: exactement 500 caractères -> valide", () => {
  const text = "a".repeat(ORDER_NOTE_MAX_LENGTH);
  const s = normalizeOrderNote(text);
  assert.equal(s.length, 500);
  assert.equal(s.isValid, true);
});

test("note: 501 caractères -> invalide", () => {
  const text = "a".repeat(ORDER_NOTE_MAX_LENGTH + 1);
  const s = normalizeOrderNote(text);
  assert.equal(s.length, 501);
  assert.equal(s.isValid, false);
});

test("note: 500 emojis -> valide, 501 emojis -> invalide", () => {
  const at500 = normalizeOrderNote("🎂".repeat(500));
  const at501 = normalizeOrderNote("🎂".repeat(501));
  assert.equal(at500.length, 500);
  assert.equal(at500.isValid, true);
  assert.equal(at501.length, 501);
  assert.equal(at501.isValid, false);
});

test("orderNotePayload: vide -> null, jamais chaîne vide envoyée", () => {
  assert.equal(orderNotePayload(""), null);
  assert.equal(orderNotePayload("   "), null);
  assert.equal(orderNotePayload(null), null);
  assert.equal(orderNotePayload(undefined), null);
});

test("orderNotePayload: ne tronque jamais, même au-delà de 500", () => {
  const long = "a".repeat(600);
  assert.equal(orderNotePayload(long), long);
  assert.equal(orderNotePayload(long)!.length, 600);
});

// --- 2. Construction de la charge RPC (fonction pure) --------------

const menuItem = { id: "item-1", name: "Tiramisu", price: 450 } as never;
const optionItem = { id: "opt-1", name: "Pistache", price: 0 } as never;

const lines: CartLine[] = [
  { item: menuItem, quantity: 2, option: optionItem, optionKind: "flavor" },
];

test("payload: note absente/vide -> p_note = null", () => {
  const ctx: OrderContext = { mode: "table", tableNumber: 4 };
  const payload = buildCreateOrderPayload({
    slug: "le-sirocco",
    context: ctx,
    lines,
    lang: "fr",
  });
  assert.equal(payload.p_note, null);
});

test("payload: note renseignée -> transmise normalisée (trim, non tronquée)", () => {
  const ctx: OrderContext = { mode: "table", tableNumber: 4 };
  const payload = buildCreateOrderPayload({
    slug: "le-sirocco",
    context: ctx,
    lines,
    lang: "fr",
    note: "  Merci de sonner à l'interphone  ",
  });
  assert.equal(payload.p_note, "Merci de sonner à l'interphone");
});

test("payload: la signature RPC reste p_slug/p_service_mode/p_items/p_table_number/p_customer/p_note/p_language", () => {
  const ctx: OrderContext = { mode: "table", tableNumber: 4 };
  const payload = buildCreateOrderPayload({
    slug: "le-sirocco",
    context: ctx,
    lines,
    lang: "fr",
    note: "test",
  });
  assert.deepEqual(Object.keys(payload).sort(), [
    "p_customer",
    "p_items",
    "p_language",
    "p_note",
    "p_service_mode",
    "p_slug",
    "p_table_number",
  ]);
});

test("payload: table -> aucun prix/total dans p_items (uniquement id, quantité, option)", () => {
  const ctx: OrderContext = { mode: "table", tableNumber: 4 };
  const payload = buildCreateOrderPayload({
    slug: "le-sirocco",
    context: ctx,
    lines,
    lang: "fr",
  });
  for (const item of payload.p_items) {
    assert.deepEqual(Object.keys(item).sort(), [
      "menu_item_id",
      "option_item_id",
      "quantity",
    ]);
  }
});

// --- 3. Message WhatsApp --------------------------------------------

const restaurant = {
  slug: "le-sirocco",
  name: "Le Sirocco",
  config: { currency: "DZD", whatsapp_number: "+213550000000" },
} as never;

test("whatsapp: sans note -> pas de ligne 'waNote' dans le message", () => {
  const ctx: OrderContext = { mode: "table", tableNumber: 4 };
  const url = buildWhatsAppUrl(restaurant, lines, ctx, "fr", 12, "");
  const message = decodeURIComponent(url.split("text=")[1]);
  assert.ok(!message.includes("Note"), "aucune mention de note attendue quand la note est vide");
});

test("whatsapp: note vide (espaces uniquement) -> pas de ligne note (normalisée)", () => {
  const ctx: OrderContext = { mode: "table", tableNumber: 4 };
  const url = buildWhatsAppUrl(restaurant, lines, ctx, "fr", 12, "     ");
  const message = decodeURIComponent(url.split("text=")[1]);
  assert.ok(!message.includes("Note"));
});

test("whatsapp: avec note -> la note apparaît dans le message", () => {
  const ctx: OrderContext = { mode: "table", tableNumber: 4 };
  const url = buildWhatsAppUrl(
    restaurant,
    lines,
    ctx,
    "fr",
    12,
    "Merci de sonner à l'interphone"
  );
  const message = decodeURIComponent(url.split("text=")[1]);
  assert.ok(message.includes("Merci de sonner à l'interphone"));
});

test("whatsapp: note toujours restituée après le corps de commande, avant le total", () => {
  const ctx: OrderContext = { mode: "table", tableNumber: 4 };
  const url = buildWhatsAppUrl(restaurant, lines, ctx, "fr", 12, "Allergie noisette");
  const message = decodeURIComponent(url.split("text=")[1]);
  const noteIdx = message.indexOf("Allergie noisette");
  const totalIdx = message.indexOf("Total");
  assert.ok(noteIdx > 0);
  assert.ok(totalIdx > noteIdx, "le total doit venir après la note dans le message");
});

// --- 4. Dictionnaires FR/EN/AR --------------------------------------

function extractDictKeys(source: string, name: string): Set<string> {
  const start = source.indexOf(`const ${name}: Dict = {`);
  assert.ok(start >= 0, `dictionnaire '${name}' introuvable dans lib/i18n.ts`);
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
  const keys = [...body.matchAll(/^\s*([A-Za-z0-9_]+):/gm)].map((m) => m[1]);
  return new Set(keys);
}

const NOTE_KEYS = ["noteLabel", "notePlaceholder", "noteCounter", "noteTooLong", "waNote"];

test("i18n: les clés de la note générale existent dans les 3 langues", () => {
  const source = readFileSync("lib/i18n.ts", "utf8");
  const fr = extractDictKeys(source, "fr");
  const en = extractDictKeys(source, "en");
  const ar = extractDictKeys(source, "ar");
  for (const key of NOTE_KEYS) {
    assert.ok(fr.has(key), `clé '${key}' absente du dictionnaire fr`);
    assert.ok(en.has(key), `clé '${key}' absente du dictionnaire en`);
    assert.ok(ar.has(key), `clé '${key}' absente du dictionnaire ar`);
  }
});

test("i18n: whatsappNotice n'a pas été modifié par le sous-lot A", () => {
  // La V64 respecte déjà l'exigence de ne jamais prétendre que la
  // commande est envoyée avant validation dans WhatsApp — le sous-lot A
  // ne doit pas y toucher.
  const source = readFileSync("lib/i18n.ts", "utf8");
  const occurrences = [...source.matchAll(/whatsappNotice:\s*"([^"]*)"/g)].map((m) => m[1]);
  assert.equal(occurrences.length, 3, "whatsappNotice doit apparaître exactement 3 fois (fr/en/ar)");
});

// --- 5. Vérifications statiques de la migration ---------------------

test("migration V65: utilise create or replace, jamais drop function sur create_order", () => {
  const sql = readFileSync("supabase/migration-v65-order-note.sql", "utf8");
  assert.ok(
    /create or replace function public\.create_order/.test(sql),
    "la migration doit utiliser create or replace function"
  );
  assert.ok(
    !/drop function.*create_order/i.test(sql),
    "la migration ne doit jamais supprimer create_order"
  );
});

/**
 * Diff séquentiel (LCS — plus longue sous-séquence commune), pas une
 * comparaison d'ensembles : préserve l'ordre des lignes et distingue
 * les lignes dupliquées (ex. plusieurs "end if;" à des endroits
 * différents ne sont jamais confondues entre elles). C'est la
 * correction demandée après l'audit : un Set aurait pu, par exemple,
 * masquer l'ajout d'un "end if;" déjà présent ailleurs dans le corps.
 */
function lcsDiff(
  a: string[],
  b: string[]
): { type: "equal" | "remove" | "add"; line: string }[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: { type: "equal" | "remove" | "add"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "remove", line: a[i] });
      i++;
    } else {
      ops.push({ type: "add", line: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "remove", line: a[i] });
    i++;
  }
  while (j < m) {
    ops.push({ type: "add", line: b[j] });
    j++;
  }
  return ops;
}

test("migration V65: comparaison SÉQUENTIELLE (LCS, ordre et doublons préservés) du corps de create_order", () => {
  // Contrôle plus fort que la version précédente (qui utilisait un
  // Set et pouvait donc rater un déplacement de logique ou masquer un
  // ajout par une ligne dupliquée déjà présente ailleurs — c'était le
  // cas exact de "end if;", commun à plusieurs blocs "if" du corps).
  // Ici, chaque opération (equal/remove/add) est positionnée dans la
  // séquence réelle, exactement comme un `diff` classique.
  const extractBody = (src: string) => {
    const start = src.indexOf("as $$");
    const end = src.indexOf("end $$;", start);
    assert.ok(start >= 0 && end > start, "corps de fonction introuvable");
    return src.slice(start, end);
  };
  const codeLines = (body: string) =>
    body
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => {
        const s = l.trim();
        return s.length > 0 && !s.startsWith("--");
      });

  const oldSrc = readFileSync("supabase/migration-orders-lang.sql", "utf8");
  const newSrc = readFileSync("supabase/migration-v65-order-note.sql", "utf8");
  const oldLines = codeLines(extractBody(oldSrc));
  const newLines = codeLines(extractBody(newSrc));

  const ops = lcsDiff(oldLines, newLines);
  const removedSequence = ops.filter((o) => o.type === "remove").map((o) => o.line);
  const addedSequence = ops.filter((o) => o.type === "add").map((o) => o.line);

  // Séquence exacte attendue, DANS L'ORDRE où le diff les rencontre
  // (vérifié en exécutant le même algorithme en dehors du test avant
  // d'écrire cette liste — pas une supposition).
  const EXPECTED_REMOVED_SEQUENCE = [
    "    nullif(left(trim(coalesce(p_note,'')), 500), ''),",
  ];
  const EXPECTED_ADDED_SEQUENCE = [
    "  v_note        text;",
    "  v_note := nullif(btrim(coalesce(p_note, ''), E' \\t\\n\\r\\f' || chr(11)), '');",
    "  if v_note is not null and length(v_note) > 500 then",
    "    raise exception 'SCANYM_ORDER_NOTE_TOO_LONG' using errcode = '22001';",
    "  end if;",
    "    v_note,",
  ];

  assert.deepEqual(
    removedSequence,
    EXPECTED_REMOVED_SEQUENCE,
    `séquence de lignes supprimées inattendue : ${JSON.stringify(removedSequence)}`
  );
  assert.deepEqual(
    addedSequence,
    EXPECTED_ADDED_SEQUENCE,
    `séquence de lignes ajoutées inattendue : ${JSON.stringify(addedSequence)}`
  );

  // Les 5 lignes du bloc de rejet (déclaration exclue, qui est dans un
  // autre hunk / la section declare) doivent être contiguës dans le
  // flux d'opérations : aucune ligne "equal" ou "remove" imbriquée au
  // milieu. Garantit que le bloc n'est pas éclaté ou déplacé ailleurs
  // dans le corps de la fonction.
  const blockStart = ops.findIndex(
    (o) => o.type === "add" && o.line === "  v_note := nullif(btrim(coalesce(p_note, ''), E' \\t\\n\\r\\f' || chr(11)), '');"
  );
  const blockEnd = ops.findIndex((o) => o.type === "add" && o.line === "  end if;");
  assert.ok(blockStart >= 0 && blockEnd > blockStart);
  for (let k = blockStart; k <= blockEnd; k++) {
    assert.equal(ops[k].type, "add", `ligne non contiguë au bloc de rejet à l'index ${k}: ${JSON.stringify(ops[k])}`);
  }
});

test("migration V65: contient le rejet explicite (pas de troncature left())", () => {
  const sql = readFileSync("supabase/migration-v65-order-note.sql", "utf8");
  assert.ok(sql.includes("SCANYM_ORDER_NOTE_TOO_LONG"), "code d'erreur stable attendu");
  assert.ok(sql.includes("errcode = '22001'"), "SQLSTATE 22001 attendu");
  assert.ok(
    !sql.includes("left(trim(coalesce(p_note"),
    "l'ancienne troncature left(...) sur p_note ne doit plus être présente"
  );
});

test("migration V65: le trim de la note est explicite (btrim), pas trim() natif", () => {
  const sql = readFileSync("supabase/migration-v65-order-note.sql", "utf8");
  assert.ok(
    sql.includes("btrim(coalesce(p_note, ''), E' \\t\\n\\r\\f' || chr(11))"),
    "v_note doit utiliser btrim avec chr(11), pas trim() natif"
  );
  assert.ok(
    !/v_note\s*:=\s*nullif\(trim\(/.test(sql),
    "v_note ne doit jamais utiliser trim() natif (ambigu vs JavaScript)"
  );
});

test("migration V65: utilise chr(11) pour la tabulation verticale, jamais E'\\v'", () => {
  // NE PROUVE PAS le comportement PostgreSQL réel — vérifie uniquement
  // le texte source. La preuve d'exécution réelle est empirique et
  // documentée séparément (voir le bloc "0bis. CONTRÔLE MANUEL" dans
  // la migration, exécuté sur une instance PostgreSQL 16 réelle avant
  // livraison ; ascii(E'\v') y renvoie 118, code de la lettre "v", et
  // non 11). Ce test statique garantit seulement qu'aucune régression
  // textuelle ne réintroduit \v dans la chaîne de normalisation.
  const sql = readFileSync("supabase/migration-v65-order-note.sql", "utf8");

  // La ligne active de normalisation doit contenir chr(11).
  const normalizationLine = sql
    .split("\n")
    .find((l) => l.trim().startsWith("v_note := nullif(btrim("));
  assert.ok(normalizationLine, "ligne de normalisation de v_note introuvable");
  assert.ok(
    normalizationLine!.includes("chr(11)"),
    "la ligne de normalisation doit utiliser chr(11) pour la tabulation verticale"
  );

  // La chaîne E'...' passée à btrim pour v_note ne doit plus jamais
  // contenir \v : on isole strictement cette chaîne (pas l'ensemble du
  // fichier, où \v peut légitimement apparaître dans un commentaire
  // qui en parle).
  const btrimArgMatch = normalizationLine!.match(/btrim\(coalesce\(p_note, ''\), (E'[^']*')/);
  assert.ok(btrimArgMatch, "argument E'...' de btrim introuvable sur la ligne de normalisation");
  assert.ok(
    !btrimArgMatch![1].includes("\\v"),
    `la chaîne E'...' de normalisation ne doit jamais contenir \\v (trouvé : ${btrimArgMatch![1]})`
  );
});

test("migration V65: aucune contrainte de table n'est ajoutée (pas d'ALTER TABLE ADD CONSTRAINT)", () => {
  // Corrigé après audit : une première version ajoutait
  // orders_customer_note_length_chk, une contrainte réellement
  // redondante avec orders_customer_note_check (déjà présente depuis
  // migration-orders.sql) qui aurait masqué une dérive du schéma au
  // lieu de la signaler. Remplacé par un contrôle préalable qui
  // VÉRIFIE la contrainte existante plutôt que d'en ajouter une autre.
  const sql = readFileSync("supabase/migration-v65-order-note.sql", "utf8");
  assert.ok(
    !/add constraint/i.test(sql),
    "cette migration ne doit ajouter aucune contrainte de table"
  );
  assert.ok(
    !/add constraint orders_customer_note_length_chk/i.test(sql),
    "l'ancienne contrainte redondante ne doit plus être ajoutée (mention narrative dans un commentaire d'historique est acceptable)"
  );
});

test("migration V65: transaction explicite begin/commit englobant UNIQUEMENT create_order et ses droits", () => {
  const sql = readFileSync("supabase/migration-v65-order-note.sql", "utf8");
  const beginIdx = sql.search(/^begin;/m);
  const commitIdx = sql.search(/^commit;/m);
  const functionIdx = sql.indexOf("create or replace function public.create_order");
  const grantIdx = sql.indexOf("grant execute on function public.create_order");

  assert.ok(beginIdx >= 0, "aucun begin; explicite trouvé");
  assert.ok(commitIdx >= 0, "aucun commit; explicite trouvé");
  assert.ok(beginIdx < functionIdx, "begin; doit précéder le remplacement de create_order");
  assert.ok(functionIdx < grantIdx, "create_order doit être remplacée avant le grant");
  assert.ok(grantIdx < commitIdx, "commit; doit venir après le grant");

  // Rien entre begin; et commit; ne doit toucher une autre table que
  // via create_order elle-même (aucun ALTER TABLE dans la transaction).
  const transactionBody = sql.slice(beginIdx, commitIdx);
  assert.ok(
    !/alter table/i.test(transactionBody),
    "la transaction ne doit contenir aucun ALTER TABLE"
  );
});

test("migration V65: contrôle préalable de non-dérive du schéma, RÉELLEMENT exécuté avant begin;", () => {
  // Contrairement au bloc "0. CONTRÔLE MANUEL" (\v, commenté,
  // volontairement non exécuté), ce contrôle-ci DOIT être un bloc SQL
  // actif : c'est lui qui protège contre une dérive du schéma en
  // arrêtant tout le script si orders_customer_note_check a disparu,
  // n'est pas validée, ou a changé de définition.
  const sql = readFileSync("supabase/migration-v65-order-note.sql", "utf8");
  const beginIdx = sql.search(/^begin;/m);
  const doBlockIdx = sql.indexOf("do $$");

  assert.ok(doBlockIdx >= 0 && doBlockIdx < beginIdx, "le bloc DO de contrôle doit précéder begin;");
  assert.ok(sql.includes("SCANYM_SCHEMA_DRIFT"), "code d'erreur de dérive de schéma attendu");
  assert.ok(
    sql.includes("conname = 'orders_customer_note_check'"),
    "le contrôle doit interroger la contrainte historique par son nom exact"
  );
  assert.ok(sql.includes("convalidated"), "le contrôle doit vérifier que la contrainte est validée");
  assert.ok(
    sql.includes("pg_get_constraintdef(oid)"),
    "le contrôle doit comparer la définition réelle de la contrainte, pas seulement son existence"
  );

  // Le bloc doit être exécutable (pas commenté) : au moins une ligne
  // du bloc DO ne commence pas par "--".
  const doBlockEnd = sql.indexOf("end $$;", doBlockIdx);
  const doBlock = sql.slice(doBlockIdx, doBlockEnd);
  const activeLines = doBlock.split("\n").filter((l) => l.trim().length > 0 && !l.trim().startsWith("--"));
  assert.ok(activeLines.length > 5, "le bloc de contrôle doit contenir du SQL réellement exécutable");
});

// --- 6. Erreur serveur reconnue par le service TypeScript -----------

// --- 6. Classification de l'erreur "note trop longue" (comportementale) ---
//
// lib/services/order-error.ts est un module pur (aucun import de
// lib/supabase.ts) : ces tests appellent réellement
// isOrderNoteTooLongError, ce ne sont plus des vérifications
// textuelles du fichier source.

test("classification erreur: code 22001 + message SCANYM_ORDER_NOTE_TOO_LONG -> reconnu", () => {
  assert.equal(
    isOrderNoteTooLongError({ code: "22001", message: ORDER_NOTE_TOO_LONG_CODE }),
    true
  );
});

test("classification erreur: code 22001 + AUTRE message -> reste une erreur générique", () => {
  // Cas exact signalé après audit : une autre colonne trop longue
  // pour son domaine peut partager le SQLSTATE 22001 sans avoir aucun
  // rapport avec la note de commande.
  assert.equal(
    isOrderNoteTooLongError({ code: "22001", message: "value too long for type character varying(30)" }),
    false
  );
});

test("classification erreur: message SCANYM_ORDER_NOTE_TOO_LONG + AUTRE code -> non reconnu", () => {
  // Le couple doit correspondre ; un message qui ressemblerait par
  // coïncidence au marqueur, mais porté par un code différent, ne
  // doit pas être requalifié.
  assert.equal(
    isOrderNoteTooLongError({ code: "23514", message: ORDER_NOTE_TOO_LONG_CODE }),
    false
  );
});

test("classification erreur: erreur absente/nulle -> non reconnue", () => {
  assert.equal(isOrderNoteTooLongError(null), false);
  assert.equal(isOrderNoteTooLongError(undefined), false);
});

test("classification erreur: erreur générique sans rapport -> non reconnue", () => {
  assert.equal(
    isOrderNoteTooLongError({ code: "23505", message: "duplicate key value" }),
    false
  );
});

test("orders service: utilise la classification stricte importée d'order-error.ts (pas un || sur le seul code)", () => {
  // Contrôle statique complémentaire (texte source, pas exécution) :
  // garantit que orders.ts appelle bien isOrderNoteTooLongError et
  // n'a pas réintroduit une condition `error.code === "22001"` isolée
  // par un `||` (la régression trouvée lors de l'audit précédent).
  const source = readFileSync("lib/services/orders.ts", "utf8");
  assert.ok(source.includes("isOrderNoteTooLongError"), "doit utiliser la classification pure");
  assert.ok(
    !/error\.message === ORDER_NOTE_TOO_LONG_CODE \|\| error\.code === "22001"/.test(source) &&
      !/error\.code === "22001" \|\| error\.message === ORDER_NOTE_TOO_LONG_CODE/.test(source),
    "ne doit plus jamais accepter code OU message isolément via ||"
  );
});

// --- 7. Non-régression : le recalcul serveur du prix reste hors de portée du client ---

test("payload: le prix/total n'est jamais construit ni transmis côté client", () => {
  const ctx: OrderContext = { mode: "table", tableNumber: 4 };
  const payload = buildCreateOrderPayload({
    slug: "le-sirocco",
    context: ctx,
    lines,
    lang: "fr",
    note: "note",
  });
  const serialized = JSON.stringify(payload);
  // Le panier de test utilise le prix 450 : s'il apparaissait dans la
  // charge, ce serait un signe que le total est calculé côté client
  // au lieu d'être recalculé en base par create_order.
  assert.ok(!serialized.includes("450"), "aucun prix ne doit être présent dans la charge RPC");
});
