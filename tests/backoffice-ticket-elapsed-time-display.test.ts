import { test } from "node:test";
import assert from "node:assert/strict";
import { formatElapsedMinutesFr } from "../lib/format-elapsed-time.ts";

// ====================================================================
// SCANYM BACKOFFICE — TICKET AGE / ELAPSED TIME DISPLAY FIX (v1).
// Vérifie EXACTEMENT les chaînes affichées pour chaque cas limite
// exigé par le mandat -- aucun arrondi, aucune dépendance de fuseau
// horaire (fonction purement arithmétique sur un entier de minutes,
// jamais sur une horloge murale).
// ====================================================================

test("0 min -- cas limite bas", () => {
  assert.equal(formatElapsedMinutesFr(0), "0 min");
});

test("8 min -- valeur autonome, JAMAIS de zéro-padding", () => {
  assert.equal(formatElapsedMinutesFr(8), "8 min");
});

test("59 min -- juste avant le passage à l'heure", () => {
  assert.equal(formatElapsedMinutesFr(59), "59 min");
});

test("60 min -- passage exact à 1 heure, minutes zéro-paddées", () => {
  assert.equal(formatElapsedMinutesFr(60), "1h 00min");
});

test("61 min -- juste après le passage à l'heure", () => {
  assert.equal(formatElapsedMinutesFr(61), "1h 01min");
});

test("1285 min -- exemple exact du mandat", () => {
  assert.equal(formatElapsedMinutesFr(1285), "21h 25min");
});

test("1439 min -- juste avant le passage au jour (23h 59min)", () => {
  assert.equal(formatElapsedMinutesFr(1439), "23h 59min");
});

test("1440 min -- passage exact à 1 jour, AUCUN préfixe '0j' résiduel, mais '1j 0h 00min' attendu", () => {
  assert.equal(formatElapsedMinutesFr(1440), "1j 0h 00min");
});

test("15559 min -- exemple exact du mandat", () => {
  assert.equal(formatElapsedMinutesFr(15559), "10j 19h 19min");
});

test("16958 min -- exemple exact du mandat", () => {
  assert.equal(formatElapsedMinutesFr(16958), "11j 18h 38min");
});

// ====================================================================
// Cas limites additionnels (au-delà du minimum exigé, pour robustesse)
// ====================================================================

test("303 min -- exemple de contrat de format (5h 03min)", () => {
  assert.equal(formatElapsedMinutesFr(303), "5h 03min");
});

test("4620 min -- exemple de contrat de format (3j 5h 00min)", () => {
  assert.equal(formatElapsedMinutesFr(4620), "3j 5h 00min");
});

test("1h 10min -- exemple de contrat de format explicite du mandat", () => {
  assert.equal(formatElapsedMinutesFr(70), "1h 10min");
});

test("valeur négative -- clampée à 0 (jamais un âge négatif affiché, jamais une exception)", () => {
  assert.equal(formatElapsedMinutesFr(-5), "0 min");
});

test("valeur non entière -- tronquée (Math.floor), jamais arrondie vers le haut", () => {
  // 59.9 minutes ne doit jamais devenir "60 min" ni "1h 00min" -- la
  // durée écoulée réelle est encore < 60 minutes entières.
  assert.equal(formatElapsedMinutesFr(59.9), "59 min");
});

test("NaN (created_at invalide/manquant en amont) -- affiche le repli établi du produit, JAMAIS 'NaNh NaNmin', JAMAIS une durée fictive", () => {
  assert.doesNotThrow(() => formatElapsedMinutesFr(NaN));
  const result = formatElapsedMinutesFr(NaN);
  assert.equal(result, "—");
  assert.ok(!result.includes("NaN"), "aucun rendu littéral 'NaN' ne doit jamais apparaître");
});

test("Infinity -- affiche le repli établi du produit, JAMAIS 'Infinityh Infinitymin'", () => {
  assert.doesNotThrow(() => formatElapsedMinutesFr(Infinity));
  const result = formatElapsedMinutesFr(Infinity);
  assert.equal(result, "—");
  assert.ok(!result.includes("Infinity"), "aucun rendu littéral 'Infinity' ne doit jamais apparaître");
});

test("-Infinity -- affiche le repli établi du produit, jamais une durée négative rendue littéralement", () => {
  assert.doesNotThrow(() => formatElapsedMinutesFr(-Infinity));
  const result = formatElapsedMinutesFr(-Infinity);
  assert.equal(result, "—");
  assert.ok(!result.includes("Infinity"), "aucun rendu littéral 'Infinity' ne doit jamais apparaître");
});

test("aucun arrondi -- 89 minutes ne devient jamais 90 ni 1h30, reste dans la fenêtre <60min tant que < 60 exactement (contrôle négatif)", () => {
  // 89 est déjà >= 60, donc ce test vérifie plutôt qu'aucun
  // arrondi vers l'heure pleine ne se produit près de la frontière.
  assert.equal(formatElapsedMinutesFr(89), "1h 29min");
  assert.notEqual(formatElapsedMinutesFr(89), "1h 30min");
});

test("multi-jours avec minutes non nulles -- aucun arrondi du reste de minutes", () => {
  // 2 jours, 3 heures, 47 minutes = 2*1440 + 3*60 + 47 = 3107
  assert.equal(formatElapsedMinutesFr(3107), "2j 3h 47min");
});

// ====================================================================
// Preuve d'indépendance vis-à-vis du fuseau horaire / de l'horloge
// murale : la fonction opère UNIQUEMENT sur un entier de minutes déjà
// calculé -- jamais sur Date.now() ni new Date() en interne. Un
// simple test de type/signature suffit à le confirmer structurellement.
// ====================================================================

test("indépendance horloge murale -- la fonction n'accède jamais à Date.now()/new Date() en interne (preuve structurelle)", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync("lib/format-elapsed-time.ts", "utf8");
  assert.ok(!source.includes("Date.now()"), "le formateur ne doit jamais lire l'horloge lui-même -- il reçoit une durée déjà calculée");
  assert.ok(!source.includes("new Date("), "le formateur ne doit jamais construire de Date -- purement arithmétique sur des minutes");
});
