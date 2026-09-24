import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  bulkValidationConfirmationQuestion,
  bulkValidationResultMessage,
  isSourceChangedError,
  runBulkValidation,
  selectBulkValidationCandidates,
  BULK_VALIDATION_CONCURRENCY,
  BULK_VALIDATION_EXPLANATION,
} from "../lib/translations-management/bulk-validation.ts";
import type { TranslationRow } from "../lib/translations-management/rows.ts";
import { resolveTranslatedField, getTranslationStatus } from "../lib/translation-resolver.ts";

// ====================================================================
// Scanym — TRANSLATIONS BULK VALIDATION v1 — SÉLECTION ET EXÉCUTION
//
// Ce fichier prouve le PÉRIMÈTRE (mandat §2) et la POLITIQUE
// D'EXÉCUTION (§6) sur le module pur. Ce qui relève de l'écran réel
// (confirmation avant mutation, arguments transmis à la RPC, import
// confirmé = validé) est prouvé dans le DOM :
// tests/translations-bulk-validation-v1.dom.test.ts
// ====================================================================

const SRC = "h-source-actuel";
const OLD = "h-source-precedent";

function row(over: Partial<TranslationRow> = {}): TranslationRow {
  return {
    entityType: "item",
    entityId: "p-1",
    entityLabel: "Produit 1",
    field: "name",
    fieldLabel: "Nom",
    sourceText: "Tomme de brebis",
    sourceHash: SRC,
    translations: null,
    isAvailable: true,
    price: 10,
    tagIds: [],
    categoryId: "c-1",
    categoryName: "Fromages",
    subcategoryId: null,
    subcategoryName: null,
    ...over,
  };
}

/** Traduction « à relire » écrite contre le hash indiqué. */
function toReview(lang: string, value: string, hash: string | null) {
  return {
    [lang]: {
      name: value,
      name_status: "to_review",
      ...(hash === null ? {} : { name_source_hash: hash }),
    },
  } as never;
}

function validated(lang: string, value: string, hash: string) {
  return {
    [lang]: { name: value, name_status: "validated", name_source_hash: hash },
  } as never;
}

const keys = (rows: ReturnType<typeof selectBulkValidationCandidates>["candidates"]) =>
  rows.map((c) => `${c.entityType}:${c.entityId}:${c.field}`);

// --------------------------------------------------------------------
// 3 — le cas nominal
// --------------------------------------------------------------------
test("3 — valide les traductions À RELIRE et à jour de la langue courante", () => {
  const rows = [
    row({ entityId: "p-1", translations: toReview("en", "Sheep tomme", SRC) }),
    row({ entityId: "p-2", translations: toReview("en", "Goat cheese", SRC) }),
  ];
  const selection = selectBulkValidationCandidates(rows, "en", "fr");
  assert.deepEqual(keys(selection.candidates), ["item:p-1:name", "item:p-2:name"]);
  assert.equal(selection.skippedStale, 0);
  // La valeur réécrite est EXACTEMENT celle déjà stockée : la
  // validation en masse ne fabrique aucun contenu.
  assert.equal(selection.candidates[0].value, "Sheep tomme");
  // Le hash transmis est le hash source ACTUEL -- la précondition de
  // concurrence, pas un hash recalculé côté client.
  assert.equal(selection.candidates[0].sourceHash, SRC);
});

// --------------------------------------------------------------------
// 4 / 5 / 6 — ce qui ne doit JAMAIS être validé
// --------------------------------------------------------------------
test("4 — une traduction DÉJÀ VALIDÉE n'est jamais réécrite", () => {
  const rows = [row({ translations: validated("en", "Sheep tomme", SRC) })];
  const selection = selectBulkValidationCandidates(rows, "en", "fr");
  assert.deepEqual(selection.candidates, []);
  assert.equal(selection.skippedStale, 0, "une ligne validée n'est pas « ignorée », elle est hors périmètre");
  assert.equal(getTranslationStatus(SRC, rows[0].translations, "en", "name"), "validated");
});

test("5 — une traduction PÉRIMÉE (validée, source changée) n'est jamais revalidée", () => {
  const rows = [row({ translations: validated("en", "Sheep tomme", OLD) })];
  assert.equal(getTranslationStatus(SRC, rows[0].translations, "en", "name"), "stale");
  const selection = selectBulkValidationCandidates(rows, "en", "fr");
  assert.deepEqual(selection.candidates, []);
  assert.equal(
    selection.skippedStale,
    0,
    "une ligne PÉRIMÉE est hors périmètre dès le statut : elle n'est même pas examinée, " +
      "donc jamais comptée parmi les lignes « à relire » ignorées"
  );
});

test("5bis — PIÈGE : « à relire » dont la SOURCE A CHANGÉ est écartée et comptée", () => {
  // `getTranslationStatus` renvoie `to_review` SANS regarder le hash
  // dès que le statut stocké n'est pas `validated`. Valider cette
  // ligne en réécrivant le hash ACTUEL la rendrait PUBLIQUE alors
  // qu'elle traduit un texte qui n'existe plus.
  const rows = [row({ translations: toReview("en", "Traduction d'un ancien texte", OLD) })];
  assert.equal(
    getTranslationStatus(SRC, rows[0].translations, "en", "name"),
    "to_review",
    "le statut affiché est bien « à relire » -- c'est ce qui rend le piège réel"
  );
  const selection = selectBulkValidationCandidates(rows, "en", "fr");
  assert.deepEqual(selection.candidates, [], "elle ne doit PAS être validée");
  assert.equal(selection.skippedStale, 1, "elle doit être COMPTÉE, jamais ignorée en silence");
});

test("5ter — une ligne sans hash source exploitable est écartée (précondition impossible)", () => {
  const sansHashStocke = row({ translations: toReview("en", "X", null) });
  const sansHashSource = row({ sourceHash: null, translations: toReview("en", "X", SRC) });
  assert.equal(selectBulkValidationCandidates([sansHashStocke], "en", "fr").skippedStale, 1);
  assert.equal(selectBulkValidationCandidates([sansHashSource], "en", "fr").skippedStale, 1);
  assert.equal(selectBulkValidationCandidates([sansHashStocke, sansHashSource], "en", "fr").candidates.length, 0);
});

test("6 — une traduction MANQUANTE n'est jamais inventée ni validée", () => {
  const aucune = row({ translations: null });
  const vide = row({ translations: { en: { name: "", name_status: "to_review" } } as never });
  assert.equal(getTranslationStatus(SRC, aucune.translations, "en", "name"), "missing");
  const selection = selectBulkValidationCandidates([aucune, vide], "en", "fr");
  assert.deepEqual(selection.candidates, []);
  assert.equal(selection.skippedStale, 0, "une ligne manquante n'est pas « périmée » : elle est hors périmètre");
});

// --------------------------------------------------------------------
// 8 — isolation de langue
// --------------------------------------------------------------------
test("8 — une traduction d'une AUTRE langue n'est jamais touchée", () => {
  const rows = [
    row({
      entityId: "p-1",
      translations: {
        en: { name: "Sheep tomme", name_status: "to_review", name_source_hash: SRC },
        ar: { name: "توم الغنم", name_status: "to_review", name_source_hash: SRC },
      } as never,
    }),
  ];
  const en = selectBulkValidationCandidates(rows, "en", "fr");
  const ar = selectBulkValidationCandidates(rows, "ar", "fr");
  assert.equal(en.candidates.length, 1);
  assert.equal(en.candidates[0].value, "Sheep tomme", "la sélection « en » ne lit QUE l'entrée en");
  assert.equal(ar.candidates[0].value, "توم الغنم");
  // Et une langue sans aucune entrée ne produit rien.
  assert.deepEqual(selectBulkValidationCandidates(rows, "es", "fr").candidates, []);
});

test("8bis — écrire dans la LANGUE SOURCE est impossible : sélection vide", () => {
  const rows = [row({ translations: toReview("fr", "n'importe quoi", SRC) })];
  assert.deepEqual(selectBulkValidationCandidates(rows, "fr", "fr").candidates, []);
  assert.deepEqual(selectBulkValidationCandidates(rows, "", "fr").candidates, []);
});

test("périmètre — un couple (type, champ) non traduisible est écarté", () => {
  const rows = [
    row({ entityType: "subcategory", field: "description", translations: toReview("en", "X", SRC) }),
    row({ entityType: "item", field: "price" as never, translations: toReview("en", "X", SRC) }),
  ];
  assert.deepEqual(selectBulkValidationCandidates(rows, "en", "fr").candidates, []);
});

test("périmètre — une même cible n'est jamais écrite deux fois", () => {
  const duplicated = [
    row({ translations: toReview("en", "A", SRC) }),
    row({ translations: toReview("en", "A", SRC) }),
  ];
  assert.equal(selectBulkValidationCandidates(duplicated, "en", "fr").candidates.length, 1);
});

// --------------------------------------------------------------------
// 3 — texte de confirmation (mandat §3)
// --------------------------------------------------------------------
test("3/UX — la question de confirmation porte le compte EXACT et la langue", () => {
  assert.equal(bulkValidationConfirmationQuestion(328, "Anglais"), "Valider 328 traductions en anglais ?");
  assert.equal(bulkValidationConfirmationQuestion(1, "Anglais"), "Valider 1 traduction en anglais ?");
  assert.equal(
    BULK_VALIDATION_EXPLANATION,
    "Seules les traductions à relire et toujours à jour seront validées."
  );
});

test("3/UX — le compte rendu porte les TROIS nombres exigés", () => {
  const message = bulkValidationResultMessage(
    { validated: 312, failed: 2, staleRejectedByServer: 2 },
    16
  );
  assert.equal(message.includes("312 traduction(s) validée(s)"), true, message);
  assert.equal(message.includes("16 ignorée(s)"), true, message);
  assert.equal(message.includes("2 échec(s)"), true, message);
  assert.equal(message.includes("refusée(s) par le serveur"), true, message);
});

// --------------------------------------------------------------------
// Exécution : échecs comptés, jamais masqués
// --------------------------------------------------------------------
test("exécution — chaque échec est compté, le refus serveur est distingué", async () => {
  const items = ["ok-1", "boom", "stale", "ok-2"];
  const outcome = await runBulkValidation(items, async (item) => {
    if (item === "boom") throw new Error("réseau indisponible");
    if (item === "stale") {
      throw new Error(
        "SCANYM_TRANSLATION_SOURCE_CHANGED: le texte source a changé -- traduction non enregistrée."
      );
    }
  });
  assert.deepEqual(outcome, { validated: 2, failed: 2, staleRejectedByServer: 1 });
  assert.equal(isSourceChangedError(new Error("x")), false);
});

test("exécution — un échec n'interrompt JAMAIS le lot", async () => {
  const attempted: number[] = [];
  const outcome = await runBulkValidation([1, 2, 3, 4, 5], async (n) => {
    attempted.push(n);
    if (n <= 3) throw new Error("échec");
  }, { concurrency: 1 });
  assert.deepEqual(attempted, [1, 2, 3, 4, 5], "les lignes suivantes sont quand même tentées");
  assert.equal(outcome.validated, 2);
});

// --------------------------------------------------------------------
// 12 — 300+ lignes SANS blocage de l'interface (mandat §6)
// --------------------------------------------------------------------
test("12 — 320 traductions : concurrence BORNÉE et boucle d'événements jamais bloquée", async () => {
  const candidates = Array.from({ length: 320 }, (_, i) => i);

  let inFlight = 0;
  let maxInFlight = 0;
  let written = 0;

  // Un « tic » de macro-tâche : c'est EXACTEMENT ce qu'un navigateur
  // doit pouvoir exécuter entre deux écritures pour repeindre l'écran
  // et traiter un clic. Sans reprise de main explicite, 320 promesses
  // déjà résolues se videraient d'un trait dans la file de MICRO-tâches
  // et ce compteur resterait à 0.
  let ticks = 0;
  let ticking = true;
  const tick = () => {
    if (!ticking) return;
    ticks += 1;
    setTimeout(tick, 0);
  };
  setTimeout(tick, 0);

  const progress: Array<[number, number]> = [];
  const outcome = await runBulkValidation(
    candidates,
    async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      written += 1;
      inFlight -= 1;
    },
    { onProgress: (done, total) => progress.push([done, total]) }
  );
  ticking = false;

  assert.equal(outcome.validated, 320);
  assert.equal(written, 320);
  assert.equal(
    maxInFlight,
    BULK_VALIDATION_CONCURRENCY,
    "les écritures sont parallélisées MAIS bornées : jamais 320 requêtes d'un coup"
  );
  assert.ok(
    ticks > 0,
    `la boucle d'événements doit reprendre la main PENDANT le traitement (tics observés : ${ticks}) ` +
      "-- sans reprise de main explicite ce compteur vaut 0, les 320 écritures se vidant d'un trait " +
      "dans la file de micro-tâches"
  );
  assert.equal(progress.length, 320, "la progression est rapportée pour CHAQUE ligne");
  assert.deepEqual(progress[progress.length - 1], [320, 320]);
  assert.deepEqual(
    progress.map(([done]) => done),
    candidates.map((_, i) => i + 1),
    "la progression est monotone et ne saute aucune ligne"
  );
});

test("12ter — la reprise de main est PÉRIODIQUE, pas une seule fois en fin de lot", async () => {
  // Mesure DÉTERMINISTE de la politique : la reprise de main est
  // injectée, donc comptée exactement -- indépendamment de la façon
  // dont Node regroupe ses minuteries.
  const yields: number[] = [];
  let done = 0;
  await runBulkValidation(
    Array.from({ length: 320 }, (_, i) => i),
    async () => {
      done += 1;
    },
    {
      yieldEvery: 20,
      yieldToEventLoop: async () => {
        yields.push(done);
      },
    }
  );
  assert.equal(yields.length, 16, "320 écritures / 20 = 16 reprises de main");
  // Écarts EXACTEMENT réguliers (les points observés sont décalés de
  // la concurrence en vol, mais l'espacement, lui, est le contrat).
  const gaps = yields.slice(1).map((v, i) => v - yields[i]);
  assert.deepEqual(
    gaps.slice(0, -1),
    Array.from({ length: 14 }, () => 20),
    `écarts observés : ${gaps.join(",")}`
  );
  assert.ok(gaps[gaps.length - 1] <= 20, "la dernière reprise tombe en fin de lot (vidange des ouvriers)");
  assert.ok(yields[0] <= 20 + BULK_VALIDATION_CONCURRENCY, `première reprise trop tardive : ${yields[0]}`);
  assert.ok(yields[yields.length - 1] >= 300, "les reprises couvrent bien tout le lot, pas seulement la fin");
});

test("12bis — la concurrence reste bornée même avec des écritures LENTES", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  await runBulkValidation(
    Array.from({ length: 50 }, (_, i) => i),
    async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
    },
    { concurrency: 3 }
  );
  assert.equal(maxInFlight, 3);
});

// --------------------------------------------------------------------
// 11 — le résolveur PUBLIC n'est pas modifié (mandat §4)
// --------------------------------------------------------------------
test("11 — lib/translation-resolver.ts est INCHANGÉ (empreinte de la base de référence)", () => {
  const file = path.join(process.cwd(), "lib/translation-resolver.ts");
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
  assert.equal(
    digest,
    "28e52ed19ca2dc23ae5221e59d742d6c472788793bd2de4516a640335fe43da1",
    "le résolveur public est hors périmètre de ce lot : toute modification doit faire échouer ce test"
  );
});

test("11bis — le CONTRAT public est intact : validé ET hash concordant, sinon repli sur la source", () => {
  const src = "Tomme de brebis";
  const ok = { en: { name: "Sheep tomme", name_status: "validated", name_source_hash: SRC } };
  const badHash = { en: { name: "Sheep tomme", name_status: "validated", name_source_hash: OLD } };
  const notValidated = { en: { name: "Sheep tomme", name_status: "to_review", name_source_hash: SRC } };

  assert.equal(resolveTranslatedField(src, SRC, ok, "en" as never, "fr" as never, "name"), "Sheep tomme");
  assert.equal(
    resolveTranslatedField(src, SRC, badHash, "en" as never, "fr" as never, "name"),
    src,
    "hash discordant -> repli sur la source, jamais la traduction"
  );
  assert.equal(
    resolveTranslatedField(src, SRC, notValidated, "en" as never, "fr" as never, "name"),
    src,
    "non validée -> repli sur la source"
  );
  // Et la ligne que la validation en masse REFUSE resterait, si elle
  // était validée de force, une traduction publiée à tort : c'est la
  // raison d'être du contrôle de fraîcheur côté sélection.
  assert.equal(
    resolveTranslatedField(src, SRC, { en: { name: "Ancien texte traduit", name_status: "validated", name_source_hash: SRC } }, "en" as never, "fr" as never, "name"),
    "Ancien texte traduit",
    "preuve du risque : validée + hash réécrit = publiée, d'où le refus en amont"
  );
});
