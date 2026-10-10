import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  THEME_TOKEN_KEYS,
  THEME_SURFACES,
  THEME_TOKEN_MIN_CONTRAST,
  canonicalThemeTokens,
  isThemeTokenKey,
  sanitizeThemeTokens,
  themeSurfaceStyle,
  themedAttribute,
  themedSurfaces,
  validateThemeTokens,
} from "../lib/theme-tokens.ts";
import { contrastRatio } from "../lib/color-contrast.ts";
import {
  COMMUNICATION_TEXT_KEYS,
  COMMUNICATION_TEXT_SPEC,
  COMMUNICATION_TEXT_MAX_LENGTH,
  COMMUNICATION_SUBJECT_MAX_LENGTH,
  COMMUNICATION_ORDER_HELP_LABEL_MAX_LENGTH,
  COMMUNICATION_ORDER_HELP_TITLE_MAX_LENGTH,
  PUBLIC_COMMUNICATION_TEXT_KEYS,
  normalizeCommunicationText,
  overridesFromPublicProjection,
} from "../lib/communications/text-keys.ts";
import { resolveCommunicationText } from "../lib/communications/resolve.ts";

// ============================================================
// THEME & CONTENT SETTINGS v1 — preuves de la logique PURE, du miroir
// SQL et du contrat CSS. Les preuves de RENDU sont dans
// theme-content-settings-v1.dom.test.ts ; celles du schéma exécuté dans
// supabase/tests/theme-content-settings-v1-check.sh.
// ============================================================

const WHITE = "#FFFFFF";
const BLACK = "#000000";
const ACCENT_DARK = "#8A5322";

// ---------------------------------------------------------------- catalogue

test("[TOK-1] catalogue FERMÉ : 7 jetons, 3 paires fond/texte + 1 bordure, aucun doublon", () => {
  assert.equal(THEME_TOKEN_KEYS.length, 7);
  assert.equal(new Set(THEME_TOKEN_KEYS).size, 7);
  assert.deepEqual(
    THEME_SURFACES.map((s) => s.surface),
    ["info-panel", "popup", "delivery-card"]
  );
  const paired = THEME_SURFACES.flatMap((s) => [s.bg, s.text]);
  assert.equal(new Set(paired).size, 6);
  assert.deepEqual([...THEME_TOKEN_KEYS].filter((k) => !paired.includes(k)), ["surface_border"]);
  assert.equal(THEME_TOKEN_MIN_CONTRAST, 4.5);
});

test("[TOK-2] AUCUN doublon avec le thème existant : aucun jeton ne recouvre une couleur déjà configurable", () => {
  const existing = ["primary_color", "secondary_color", "accent_color", "bg_color", "primary", "secondary", "accent", "bg"];
  for (const key of THEME_TOKEN_KEYS) {
    assert.ok(!existing.includes(key), `${key} recouvre une couleur existante`);
  }
  const source = readFileSync("lib/theme-tokens.ts", "utf8");
  assert.ok(!/from\s+["']@\/lib\/themes["']/.test(source), "le module ne dépend pas de themes.ts (pas de second thème)");
});

test("[TOK-3] isThemeTokenKey n'accepte que le catalogue", () => {
  for (const k of THEME_TOKEN_KEYS) assert.equal(isThemeTokenKey(k), true);
  for (const k of ["css", "bg_color", "", "__proto__", "constructor", null, undefined, 3]) {
    assert.equal(isThemeTokenKey(k), false);
  }
});

// ------------------------------------------------- défaut : aucune config

test("[DEF-1] aucune configuration => aucun jeton, aucun attribut, aucune variable (rendu historique)", () => {
  for (const raw of [null, undefined, {}, [], "", 0, "x", () => 1, new Date()]) {
    assert.deepEqual(sanitizeThemeTokens(raw), {});
  }
  assert.deepEqual(validateThemeTokens(null), { ok: true, tokens: {} });
  assert.deepEqual(validateThemeTokens(undefined), { ok: true, tokens: {} });
  assert.deepEqual(validateThemeTokens({}), { ok: true, tokens: {} });
  assert.equal(themedAttribute({}), undefined);
  assert.deepEqual(themeSurfaceStyle({}, ACCENT_DARK), {});
  assert.deepEqual(themedSurfaces({}), []);
});

test("[DEF-2] une bordure seule configure la bordure, pas une surface", () => {
  const tokens = sanitizeThemeTokens({ surface_border: "#d4af37" });
  assert.deepEqual(tokens, { surface_border: "#D4AF37" });
  assert.equal(themedAttribute(tokens), "border");
  assert.deepEqual(themeSurfaceStyle(tokens, ACCENT_DARK), { "--sc-surface-border": "#D4AF37" });
});

// ------------------------------------------------- jeton appliqué à la bonne surface

test("[APPLY-1] chaque paire n'alimente QUE ses propres variables", () => {
  const only = (bg: string, text: string, expectedSurface: string, expectedPrefix: string, muted: boolean) => {
    const tokens = sanitizeThemeTokens({ [bg]: WHITE, [text]: BLACK });
    assert.equal(themedAttribute(tokens), expectedSurface);
    const style = themeSurfaceStyle(tokens, ACCENT_DARK);
    assert.deepEqual(Object.keys(style).sort(), [
      `${expectedPrefix}-bg`, `${expectedPrefix}-link`, `${expectedPrefix}-text`, ...(muted ? [`${expectedPrefix}-text-muted`] : []),
    ].sort());
    assert.equal(style[`${expectedPrefix}-bg`], WHITE);
    assert.equal(style[`${expectedPrefix}-text`], BLACK);
  };
  only("info_panel_bg", "info_panel_text", "info-panel", "--sc-info-panel", false); // surface « encre » : pas de texte secondaire
  only("popup_bg", "popup_text", "popup", "--sc-popup", true);
  only("delivery_card_bg", "delivery_card_text", "delivery-card", "--sc-delivery-card", true);
});

test("[APPLY-2] texte secondaire et lien sont DÉRIVÉS et lisibles contre le fond de la surface (jamais contre le fond de page)", () => {
  // Fond de page sombre / accent-dark clair, surface BLANCHE : un lien
  // calculé pour le fond de page serait quasi blanc sur blanc.
  for (const accentDark of ["#C6A15B", "#F2D9A0", "#8A5322", "#FFFFFF", "#000000"]) {
    const style = themeSurfaceStyle({ popup_bg: WHITE, popup_text: BLACK }, accentDark);
    assert.ok(contrastRatio(style["--sc-popup-link"], WHITE) >= 4.5, `lien ${accentDark} -> ${style["--sc-popup-link"]}`);
    assert.ok(contrastRatio(style["--sc-popup-text-muted"], WHITE) >= 4.5, "texte secondaire lisible");
  }
  // Surface sombre : mêmes garanties.
  const dark = themeSurfaceStyle({ info_panel_bg: "#111111", info_panel_text: "#F5F5F5" }, ACCENT_DARK);
  assert.ok(contrastRatio(dark["--sc-info-panel-link"], "#111111") >= 4.5);
  assert.equal(dark["--sc-info-panel-text-muted"], undefined, "le panneau n'affiche aucun texte secondaire");
  // Le panneau adresse/horaires affiche ses libellés en laiton (--sc-highlight) :
  // le lien/laiton est dérivé du HIGHLIGHT (3e paramètre), pas de l'accent foncé.
  for (const highlight of ["#C6A15B", "#FFFFFF", "#000000", "#2E4A1F"]) {
    for (const bg of ["#FFFFFF", "#000000", "#C6A15B"]) {
      const out = themeSurfaceStyle({ info_panel_bg: bg, info_panel_text: bg === "#FFFFFF" ? BLACK : WHITE }, "#336699", highlight);
      assert.ok(contrastRatio(out["--sc-info-panel-link"], bg) >= 4.5, `laiton ${highlight} sur ${bg} -> ${out["--sc-info-panel-link"]}`);
    }
  }
});

test("[APPLY-3] toute valeur de variable produite est un hexadécimal #RRGGBB (jamais d'expression)", () => {
  const style = themeSurfaceStyle(
    sanitizeThemeTokens({
      info_panel_bg: "#fff", info_panel_text: "#000", // invalides : écartés
      popup_bg: "#123456", popup_text: "#FFFFFF",
      delivery_card_bg: "#FFFFFF", delivery_card_text: "#222222",
      surface_border: "#abcdef",
    }),
    "#336699"
  );
  assert.ok(Object.keys(style).length > 0);
  for (const [name, value] of Object.entries(style)) {
    assert.match(name, /^--sc-[a-z-]+$/);
    assert.match(value, /^#[0-9A-F]{6}$/i, `${name}=${value}`);
  }
});

// ------------------------------------------------- couleur invalide rejetée

test("[VAL-1] couleurs invalides REJETÉES (écriture) — format strict #RRGGBB", () => {
  const bad = [
    "red", "#FFF", "#FFFFFFF", "#GGGGGG", "FFFFFF", "rgb(0,0,0)", "hsl(0,0%,0%)", "var(--x)",
    "url(javascript:alert(1))", "expression(alert(1))", "#000000;}</style><script>", " #FFFFFF", "#FFFFFF ",
    "#FFFFFF\n", "javascript:alert(1)", "transparent", "inherit", "#00000G", "＃FFFFFF",
  ];
  for (const value of bad) {
    const v = validateThemeTokens({ surface_border: value });
    assert.equal(v.ok, false, `accepté à tort : ${JSON.stringify(value)}`);
    if (!v.ok) assert.deepEqual(v.errors, [{ key: "surface_border", code: "INVALID_COLOR" }]);
  }
  for (const value of [12, true, {}, [], ["#FFFFFF"]]) {
    const v = validateThemeTokens({ surface_border: value });
    assert.equal(v.ok, false);
  }
});

test("[VAL-2] clé inconnue REJETÉE ; « __proto__ » (JSON.parse) aussi ; l'entrée n'est pas modifiée", () => {
  const frozen = Object.freeze({ css: "#000000" });
  const v = validateThemeTokens(frozen);
  assert.equal(v.ok, false);
  if (!v.ok) assert.deepEqual(v.errors, [{ key: "css", code: "UNKNOWN_KEY" }]);
  const parsed = JSON.parse('{"__proto__":{"popup_bg":"#FFFFFF"},"popup_bg":"#FFFFFF","popup_text":"#000000"}');
  const w = validateThemeTokens(parsed);
  assert.equal(w.ok, false);
  assert.equal(({} as any).popup_bg, undefined, "aucune pollution de prototype");
  assert.deepEqual(frozen, { css: "#000000" });
});

test("[VAL-3] paire incomplète REJETÉE, sur la clé manquante", () => {
  const a = validateThemeTokens({ popup_bg: WHITE });
  assert.deepEqual(a.ok === false && a.errors, [{ key: "popup_text", code: "PAIR_INCOMPLETE" }]);
  const b = validateThemeTokens({ delivery_card_text: BLACK });
  assert.deepEqual(b.ok === false && b.errors, [{ key: "delivery_card_bg", code: "PAIR_INCOMPLETE" }]);
});

test("[VAL-4] contraste : seuil 4,5 appliqué à la frontière exacte (#767676 accepté, #777777 refusé sur blanc)", () => {
  assert.ok(contrastRatio("#767676", WHITE) >= 4.5);
  assert.ok(contrastRatio("#777777", WHITE) < 4.5);
  assert.equal(validateThemeTokens({ popup_bg: WHITE, popup_text: "#767676" }).ok, true);
  const low = validateThemeTokens({ popup_bg: WHITE, popup_text: "#777777" });
  assert.deepEqual(low.ok === false && low.errors, [{ key: "popup_text", code: "LOW_CONTRAST" }]);
  // Symétrie : l'ordre fond/texte n'importe pas pour le ratio.
  assert.equal(validateThemeTokens({ popup_bg: "#777777", popup_text: WHITE }).ok, false);
  assert.equal(validateThemeTokens({ popup_bg: BLACK, popup_text: BLACK }).ok, false);
});

test("[VAL-5] minuscules acceptées à la saisie et NORMALISÉES en majuscules ; plusieurs erreurs rapportées ensemble", () => {
  const ok = validateThemeTokens({ popup_bg: "#ffffff", popup_text: "#000000", surface_border: "#abcdef" });
  assert.deepEqual(ok.ok && ok.tokens, { popup_bg: WHITE, popup_text: BLACK, surface_border: "#ABCDEF" });
  const many = validateThemeTokens({ css: "x", surface_border: "red", popup_bg: WHITE });
  assert.equal(many.ok, false);
  if (!many.ok) assert.deepEqual(many.errors.map((e) => e.code).sort(), ["INVALID_COLOR", "PAIR_INCOMPLETE", "UNKNOWN_KEY"]);
});

// ------------------------------------------------- vide / reset

test("[RST-1] valeur vide ou null = clé ABSENTE ; tout vider = aucune configuration", () => {
  const v = validateThemeTokens({
    info_panel_bg: "", info_panel_text: null, popup_bg: "", popup_text: "", delivery_card_bg: null, delivery_card_text: "", surface_border: "",
  });
  assert.deepEqual(v, { ok: true, tokens: {} });
  assert.equal(canonicalThemeTokens({}), canonicalThemeTokens((v.ok && v.tokens) || {}));
  // Vider UN SEUL côté d'une paire reste une erreur (pas une réinitialisation silencieuse de la moitié).
  const half = validateThemeTokens({ popup_bg: WHITE, popup_text: "" });
  assert.equal(half.ok, false);
});

test("[RST-2] forme canonique : indépendante de l'ordre des clés, sensible à la valeur", () => {
  const a = canonicalThemeTokens({ popup_text: BLACK, popup_bg: WHITE });
  const b = canonicalThemeTokens({ popup_bg: WHITE, popup_text: BLACK });
  assert.equal(a, b);
  assert.notEqual(a, canonicalThemeTokens({ popup_bg: WHITE, popup_text: "#111111" }));
  assert.notEqual(a, canonicalThemeTokens({}));
});

// ------------------------------------------------- lecture publique tolérante

test("[SAN-1] la lecture publique écarte une paire invalide EN ENTIER et garde les autres surfaces", () => {
  const tokens = sanitizeThemeTokens({
    info_panel_bg: WHITE, info_panel_text: "#EEEEEE",       // contraste insuffisant -> écartée
    popup_bg: WHITE, popup_text: BLACK,                      // valide
    delivery_card_bg: "javascript:alert(1)", delivery_card_text: BLACK, // invalide -> écartée
    surface_border: "#D4AF37",
    css: "body{display:none}",                               // inconnue -> ignorée
  });
  assert.deepEqual(tokens, { popup_bg: WHITE, popup_text: BLACK, surface_border: "#D4AF37" });
  assert.equal(themedAttribute(tokens), "popup border");
});

test("[SAN-2] uniquement des propriétés PROPRES d'un objet simple (pas de chaîne de prototypes)", () => {
  const inherited = Object.create({ popup_bg: WHITE, popup_text: BLACK });
  assert.deepEqual(sanitizeThemeTokens(inherited), {});
  const own = Object.assign(Object.create(null), { popup_bg: WHITE, popup_text: BLACK });
  assert.deepEqual(sanitizeThemeTokens(own), { popup_bg: WHITE, popup_text: BLACK });
});

test("[SAN-3] aucune valeur hostile ne traverse jusqu'aux variables (fuzz déterministe)", () => {
  const alphabet = ["#", "0", "F", "a", "g", ";", "}", "<", ">", "(", ")", "'", "\"", "\\", "/", "*", " ", "\n", "u", "r", "l", ":", "@", "!"];
  let seed = 42;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
  for (let i = 0; i < 3000; i++) {
    const len = 1 + (rnd() % 14);
    let s = "";
    for (let j = 0; j < len; j++) s += alphabet[rnd() % alphabet.length];
    const raw = { popup_bg: s, popup_text: s, surface_border: s, info_panel_bg: s, delivery_card_text: s };
    const style = themeSurfaceStyle(sanitizeThemeTokens(raw), ACCENT_DARK);
    for (const value of Object.values(style)) {
      assert.match(value, /^#[0-9A-F]{6}$/i, `fuite : ${JSON.stringify(s)} -> ${value}`);
    }
  }
});

// ------------------------------------------------- contrat CSS

const css = readFileSync("app/globals.css", "utf8");
const themeBlock = css.slice(css.lastIndexOf("/*", css.indexOf("THEME & CONTENT SETTINGS v1")));

test("[CSS-1] chaque règle de surface est GARDÉE par data-sc-themed et ne lit que les variables produites par themeSurfaceStyle", () => {
  for (const { surface, bg, text, cssPrefix } of THEME_SURFACES) {
    const selector = `[data-sc-themed~="${surface}"] [data-sc-surface="${surface}"]`;
    const start = themeBlock.indexOf(selector + " {");
    assert.ok(start >= 0, `règle absente : ${selector}`);
    const body = themeBlock.slice(start, themeBlock.indexOf("}", start));
    const used = [...body.matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1]);
    const produced = Object.keys(themeSurfaceStyle({ [bg]: WHITE, [text]: BLACK }, ACCENT_DARK));
    for (const name of used) assert.ok(produced.includes(name), `${name} lu mais jamais produit (${surface})`);
    for (const name of produced) assert.ok(used.includes(name), `${name} produit mais jamais lu (${surface})`);
    assert.ok(name_startsWith(used, cssPrefix));
  }
});
function name_startsWith(used: string[], prefix: string) {
  return used.every((n) => n.startsWith(prefix));
}

test("[CSS-2] aucune règle du lot n'est non gardée (rendu historique inchangé sans configuration)", () => {
  const noComments = themeBlock.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...noComments.matchAll(/(^|\n)([^\n{}][^{}]*)\{/g)].map((m) => m[2].trim()).filter(Boolean);
  assert.ok(rules.length >= 5);
  for (const sel of rules) {
    for (const part of sel.split(",")) {
      assert.match(part.trim(), /^\[data-sc-themed~="(info-panel|popup|delivery-card|border)"\] \[data-sc-surface/, `non gardé : ${part}`);
    }
  }
});

test("[CSS-3] les règles ne contiennent ni !important, ni url(), ni @import, ni expression()", () => {
  assert.ok(!/!important|url\(|@import|expression\(/i.test(themeBlock));
});

// ------------------------------------------------- miroir SQL

const sql = readFileSync("supabase/DRAFT-lot-theme-content-settings-v1.sql", "utf8");
const rollback = readFileSync("supabase/DRAFT-lot-theme-content-settings-v1-rollback.sql", "utf8");
const mccSql = readFileSync("supabase/DRAFT-lot-merchant-customer-communications-v1.sql", "utf8");

function sqlArray(source: string, fn: string): string[] {
  const m = source.match(new RegExp(`function public\\.${fn}\\(\\)[\\s\\S]*?select array\\[([\\s\\S]*?)\\]::text\\[\\]`));
  assert.ok(m, `fonction ${fn} introuvable`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

test("[MIR-1] theme_token_keys() est le MIROIR EXACT de THEME_TOKEN_KEYS", () => {
  assert.deepEqual(sqlArray(sql, "theme_token_keys"), [...THEME_TOKEN_KEYS]);
});

test("[MIR-2] le catalogue MCC étendu (aller) est le MIROIR EXACT des listes TypeScript", () => {
  assert.deepEqual(sqlArray(sql, "communication_text_keys"), [...COMMUNICATION_TEXT_KEYS]);
  assert.deepEqual(sqlArray(sql, "public_communication_text_keys"), [...PUBLIC_COMMUNICATION_TEXT_KEYS]);
  assert.equal(COMMUNICATION_TEXT_KEYS.length, 17);
  assert.equal(PUBLIC_COMMUNICATION_TEXT_KEYS.length, 14);
});

test("[MIR-3] le rollback restaure EXACTEMENT les listes de MCC v1", () => {
  assert.deepEqual(sqlArray(rollback, "communication_text_keys"), sqlArray(mccSql, "communication_text_keys"));
  assert.deepEqual(sqlArray(rollback, "public_communication_text_keys"), sqlArray(mccSql, "public_communication_text_keys"));
  assert.equal(sqlArray(rollback, "communication_text_keys").length, 14);
  // Les 14 d'origine sont exactement le catalogue étendu privé des 3 nouveaux emplacements.
  assert.deepEqual(
    sqlArray(mccSql, "communication_text_keys"),
    COMMUNICATION_TEXT_KEYS.filter((k) => !k.startsWith("order_help_"))
  );
});

test("[MIR-4] bornes SQL = bornes TypeScript (libellé, titre, corps, sujet)", () => {
  const fn = sql.match(/function public\.communication_text_max_length[\s\S]*?\$\$([\s\S]*?)\$\$/)![1];
  assert.ok(fn.includes(`when p_text_key = 'email_confirmation_subject' then ${COMMUNICATION_SUBJECT_MAX_LENGTH}`));
  assert.ok(fn.includes(`when p_text_key = 'order_help_button_label' then ${COMMUNICATION_ORDER_HELP_LABEL_MAX_LENGTH}`));
  assert.ok(fn.includes(`when p_text_key = 'order_help_title' then ${COMMUNICATION_ORDER_HELP_TITLE_MAX_LENGTH}`));
  assert.ok(fn.includes(`else ${COMMUNICATION_TEXT_MAX_LENGTH}`));
  for (const key of COMMUNICATION_TEXT_KEYS) {
    const expected =
      key === "email_confirmation_subject" ? COMMUNICATION_SUBJECT_MAX_LENGTH
      : key === "order_help_button_label" ? COMMUNICATION_ORDER_HELP_LABEL_MAX_LENGTH
      : key === "order_help_title" ? COMMUNICATION_ORDER_HELP_TITLE_MAX_LENGTH
      : COMMUNICATION_TEXT_MAX_LENGTH;
    assert.equal(COMMUNICATION_TEXT_SPEC[key].maxLength, expected, key);
  }
});

test("[MIR-5] le seuil de contraste et la grammaire de couleur SQL sont ceux de TypeScript", () => {
  assert.equal([...sql.matchAll(/< 4\.5/g)].length >= 2, true, "seuil 4,5 dans le validateur (CHECK) ET dans le RPC");
  assert.ok(sql.includes("'^#[0-9A-F]{6}$'") && sql.includes("'^#[0-9A-Fa-f]{6}$'"));
  assert.equal(THEME_TOKEN_MIN_CONTRAST, 4.5);
});

test("[SQL-1] le DRAFT est strictement additif et ne rouvre aucune surface sensible", () => {
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.ok(!/create\s+table/i.test(code), "aucune nouvelle table");
  assert.ok(!/create\s+policy|alter\s+table[^;]*enable\s+row/i.test(code), "aucune policy/RLS nouvelle");
  assert.ok(!/grant\s+[^;]*on\s+(table\s+)?public\.restaurant_configs/i.test(code), "aucun GRANT sur restaurant_configs");
  assert.ok(!/\bdrop\b|\bdelete\b|\btruncate\b/i.test(code.replace(/drop\s+table\s+public\.zz/gi, "")), "aucune suppression de donnée");
  assert.ok(!/public\.(orders?\b|order_\w+|delivery_\w+|cgv\w*|payment\w*|invoice\w*|seller\w*|create_order\w*)/i.test(code), "aucune autre surface touchée");
  assert.ok(/^begin;$/m.test(code) && /commit;\s*$/.test(code.trim()));
  assert.ok(sql.includes("DRAFT — NOT APPLIED IN PRODUCTION"));
  assert.ok(rollback.includes("DRAFT — NOT APPLIED IN PRODUCTION"));
});

test("[SQL-2] le RPC est gardé par l'autorité existante et fermé à anon", () => {
  assert.ok(sql.includes("perform public.assert_restaurant_asset_role(p_restaurant_id);"));
  assert.ok(sql.includes("revoke all on function public.update_restaurant_theme_tokens(uuid, jsonb) from public, anon;"));
  assert.ok(sql.includes("grant execute on function public.update_restaurant_theme_tokens(uuid, jsonb) to authenticated;"));
  assert.ok(/security definer\s+set search_path = ''/.test(sql.slice(sql.indexOf("function public.update_restaurant_theme_tokens"))));
  for (const fn of ["theme_token_keys()", "theme_token_luminance(text)", "theme_token_contrast(text, text)", "theme_tokens_valid(jsonb)"]) {
    assert.ok(sql.includes(`revoke all on function public.${fn} from public, anon, authenticated, service_role;`), fn);
  }
});

test("[SQL-3] les RPC/CHECK MCC ne sont PAS redéfinis (seulement les 3 fonctions de catalogue)", () => {
  const replaced = [...sql.matchAll(/create or replace function public\.([a-z_]+)/g)].map((m) => m[1]);
  assert.deepEqual(replaced, ["communication_text_keys", "public_communication_text_keys", "communication_text_max_length"]);
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  // Le pré-vol LIT le CHECK de clé (lecture seule) ; rien ne le modifie.
  assert.ok(!/alter\s+table[^;]*merchant_communication_text/i.test(code));
  assert.ok(!/function\s+public\.(set_merchant_communication_text|get_restaurant_public_communication_texts)/i.test(code));
});

// ------------------------------------------------- MCC : textes d'aide à la commande

test("[MCC-1] catalogue étendu : 3 emplacements d'aide, publics, SANS texte plateforme par défaut", () => {
  assert.equal(COMMUNICATION_TEXT_KEYS.length, 17);
  assert.equal(new Set(COMMUNICATION_TEXT_KEYS).size, 17);
  for (const key of ["order_help_button_label", "order_help_title", "order_help_body"] as const) {
    assert.ok(COMMUNICATION_TEXT_KEYS.includes(key));
    assert.equal(COMMUNICATION_TEXT_SPEC[key].publicProjection, true);
    assert.equal(COMMUNICATION_TEXT_SPEC[key].defaultI18nKey, null, "aucun texte codé en dur");
    assert.ok(PUBLIC_COMMUNICATION_TEXT_KEYS.includes(key));
  }
  assert.equal(COMMUNICATION_TEXT_SPEC.order_help_button_label.maxLength, 60);
  assert.equal(COMMUNICATION_TEXT_SPEC.order_help_title.maxLength, 120);
  assert.equal(COMMUNICATION_TEXT_SPEC.order_help_body.maxLength, 500);
});

test("[MCC-2] sans surcharge => `absent` (le bouton n'existe pas) ; avec surcharge => texte du commerçant", () => {
  const t = (k: string) => k;
  for (const key of ["order_help_button_label", "order_help_title", "order_help_body"] as const) {
    assert.deepEqual(resolveCommunicationText(key, undefined, t), { key, text: null, source: "absent" });
    assert.deepEqual(resolveCommunicationText(key, {}, t), { key, text: null, source: "absent" });
    assert.deepEqual(resolveCommunicationText(key, { [key]: "   " }, t), { key, text: null, source: "absent" });
  }
  assert.equal(resolveCommunicationText("order_help_button_label", { order_help_button_label: "  Comment commander ?  " }, t).text, "Comment commander ?");
});

test("[MCC-3] un libellé/titre trop long est traité comme ABSENT (jamais tronqué ni cassant la mise en page)", () => {
  assert.equal(normalizeCommunicationText("order_help_button_label", "x".repeat(60)), "x".repeat(60));
  assert.equal(normalizeCommunicationText("order_help_button_label", "x".repeat(61)), undefined);
  assert.equal(normalizeCommunicationText("order_help_title", "x".repeat(120)), "x".repeat(120));
  assert.equal(normalizeCommunicationText("order_help_title", "x".repeat(121)), undefined);
  assert.equal(normalizeCommunicationText("order_help_body", "x".repeat(500)), "x".repeat(500));
  assert.equal(normalizeCommunicationText("order_help_body", "x".repeat(501)), undefined);
});

test("[MCC-4] la projection publique n'expose que des emplacements publics ; un gabarit d'e-mail reste exclu", () => {
  const safe = overridesFromPublicProjection([
    { text_key: "order_help_button_label", body: "Aide" },
    { text_key: "order_help_body", body: "Corps" },
    { text_key: "email_confirmation_body", body: "SECRET" },
    { text_key: "order_help_pirate", body: "x" },
  ]);
  assert.deepEqual(safe, { order_help_button_label: "Aide", order_help_body: "Corps" });
});
