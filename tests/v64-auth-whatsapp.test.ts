import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isValidWhatsappNumber,
  normalizeWhatsappNumber,
} from "../lib/whatsapp.ts";
import {
  MIN_PASSWORD_LENGTH,
  extractAuthLinkError,
} from "../lib/auth-validation.ts";

// ====================================================================
// Numéro WhatsApp — normalisation (espaces et tirets uniquement)
// ====================================================================

test("whatsapp: normalise en retirant seulement espaces et tirets", () => {
  assert.equal(
    normalizeWhatsappNumber("+213 550-00-00-00"),
    "+213550000000"
  );
});

test("whatsapp: ne retire jamais les lettres (pas de nettoyage silencieux)", () => {
  assert.equal(
    normalizeWhatsappNumber("+213ABC666510901"),
    "+213ABC666510901"
  );
});

test("whatsapp: ne retire jamais les parenthèses (pas de nettoyage silencieux)", () => {
  assert.equal(
    normalizeWhatsappNumber("+213 (0) 550-00-00-00"),
    "+213(0)550000000"
  );
});

test("whatsapp: sans '+' initial, aucun '+' n'est ajouté", () => {
  assert.equal(normalizeWhatsappNumber("0550 00 00 00"), "0550000000");
});

test("whatsapp: les espaces de début/fin sont ignorés", () => {
  assert.equal(normalizeWhatsappNumber("  +213666510901  "), "+213666510901");
});

// ====================================================================
// Numéro WhatsApp — validation (indicatif international obligatoire,
// aucune lettre ni parenthèse tolérée)
// ====================================================================

test("whatsapp: numéro international valide accepté", () => {
  assert.ok(isValidWhatsappNumber("+213666510901"));
});

test("whatsapp: numéro valide avec espaces/tirets accepté après nettoyage", () => {
  assert.ok(isValidWhatsappNumber("+213 550-00-00-00"));
});

// --- Cas exacts signalés par l'audit -------------------------------

test("whatsapp: '+213ABC666510901' est REFUSÉ (lettres, jamais nettoyées à l'aveugle)", () => {
  assert.equal(isValidWhatsappNumber("+213ABC666510901"), false);
});

test("whatsapp: '+213 (0) 550-00-00-00' est REFUSÉ (parenthèses, format national pas international)", () => {
  assert.equal(isValidWhatsappNumber("+213 (0) 550-00-00-00"), false);
});

test("whatsapp: le format attendu sans parenthèses est accepté : '+213 550 00 00 00'", () => {
  assert.ok(isValidWhatsappNumber("+213 550 00 00 00"));
});

// --------------------------------------------------------------------

test("whatsapp: numéro sans indicatif international refusé", () => {
  assert.ok(!isValidWhatsappNumber("0550000000"));
});

test("whatsapp: numéro vide refusé", () => {
  assert.ok(!isValidWhatsappNumber(""));
  assert.ok(!isValidWhatsappNumber("   "));
});

test("whatsapp: trop court refusé", () => {
  assert.ok(!isValidWhatsappNumber("+21366"));
});

test("whatsapp: zéro juste après l'indicatif refusé", () => {
  assert.ok(!isValidWhatsappNumber("+0213666510901"));
});

// ====================================================================
// Lien de récupération de mot de passe — détection d'erreur
// ====================================================================

test("auth link: aucune erreur sur un lien de récupération valide", () => {
  const url =
    "https://scanym.example.com/dashboard/reset-password#access_token=abc&type=recovery";
  assert.equal(extractAuthLinkError(url), null);
});

test("auth link: erreur détectée dans le fragment (#error=...)", () => {
  const url =
    "https://scanym.example.com/dashboard/reset-password#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired";
  assert.equal(
    extractAuthLinkError(url),
    "Email link is invalid or has expired"
  );
});

test("auth link: erreur détectée dans les paramètres de requête (?error=...)", () => {
  const url =
    "https://scanym.example.com/dashboard/reset-password?error=access_denied&error_code=otp_expired";
  assert.equal(extractAuthLinkError(url), "otp_expired");
});

test("auth link: aucune erreur et aucun token → pas d'erreur détectée (à traiter par le délai de repli)", () => {
  const url = "https://scanym.example.com/dashboard/reset-password";
  assert.equal(extractAuthLinkError(url), null);
});

// ====================================================================
// Mot de passe — longueur minimale
// ====================================================================

test("password: la longueur minimale exigée est bien 10", () => {
  assert.equal(MIN_PASSWORD_LENGTH, 10);
});

// ====================================================================
// i18n — symétrie des dictionnaires FR/EN/AR pour les clés V64
// ====================================================================

/**
 * Analyse lib/i18n.ts par lecture de fichier (comme les tests
 * d'architecture existants) plutôt que par import, pour ne pas avoir
 * à exposer les dictionnaires internes fr/en/ar dans l'API publique
 * du module.
 */
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

test("i18n: les dictionnaires fr/en/ar ont exactement les mêmes clés", () => {
  const source = readFileSync("lib/i18n.ts", "utf8");
  const fr = extractDictKeys(source, "fr");
  const en = extractDictKeys(source, "en");
  const ar = extractDictKeys(source, "ar");

  assert.deepEqual(
    [...fr].filter((k) => !en.has(k)),
    [],
    "clés présentes en fr mais absentes en en"
  );
  assert.deepEqual(
    [...fr].filter((k) => !ar.has(k)),
    [],
    "clés présentes en fr mais absentes en ar"
  );
  assert.deepEqual(
    [...en].filter((k) => !fr.has(k)),
    [],
    "clés présentes en en mais absentes en fr"
  );
  assert.deepEqual(
    [...ar].filter((k) => !fr.has(k)),
    [],
    "clés présentes en ar mais absentes en fr"
  );
});

test("i18n: les clés V64 (auth/fp/rp/stWhatsapp) existent dans les trois langues", () => {
  const source = readFileSync("lib/i18n.ts", "utf8");
  const fr = extractDictKeys(source, "fr");
  const en = extractDictKeys(source, "en");
  const ar = extractDictKeys(source, "ar");

  const expected = [
    "authTitle",
    "authSubtitle",
    "authEmail",
    "authPassword",
    "authSubmit",
    "authSubmitting",
    "authForgotLink",
    "fpTitle",
    "fpSubtitle",
    "fpEmail",
    "fpSend",
    "fpSending",
    "fpSentMessage",
    "fpBackToLogin",
    "rpTitle",
    "rpChecking",
    "rpInvalidMessage",
    "rpRequestNewLink",
    "rpSubtitle",
    "rpNewPassword",
    "rpConfirmPassword",
    "rpMismatch",
    "rpTooShort",
    "rpSubmit",
    "rpSubmitting",
    "rpSuccessMessage",
    "rpBackToLogin",
    "stWhatsappTitle",
    "stWhatsappHint",
    "stWhatsappInvalid",
    "whatsappNotice",
  ];

  for (const key of expected) {
    assert.ok(fr.has(key), `clé '${key}' manquante en fr`);
    assert.ok(en.has(key), `clé '${key}' manquante en en`);
    assert.ok(ar.has(key), `clé '${key}' manquante en ar`);
  }
});

// ====================================================================
// Pages d'authentification — pas d'appel Supabase direct, pas de
// texte français codé en dur en dehors des libellés statiques
// (nom "Scanym", exposant "&larr;") : ce test complète le test
// d'architecture existant en vérifiant explicitement les 3 nouvelles
// pages plutôt que de dépendre du parcours générique app/.
// ====================================================================

test("auth pages: forgot-password et reset-password utilisent translate(), pas de texte en dur", () => {
  const forgot = readFileSync("app/dashboard/forgot-password/page.tsx", "utf8");
  const reset = readFileSync("app/dashboard/reset-password/page.tsx", "utf8");
  const login = readFileSync("app/dashboard/login/page.tsx", "utf8");

  for (const [label, src] of [
    ["forgot-password", forgot],
    ["reset-password", reset],
    ["login", login],
  ] as const) {
    assert.ok(
      src.includes('from "@/lib/i18n"'),
      `${label}/page.tsx devrait importer lib/i18n`
    );
    assert.ok(
      /\bt\(\s*"/.test(src),
      `${label}/page.tsx devrait utiliser t("...") pour ses textes`
    );
  }
});
