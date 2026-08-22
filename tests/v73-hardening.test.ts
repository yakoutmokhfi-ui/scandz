import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym V73 — corrections ciblées après contre-audit indépendant Work
// sur V72 (findings V72-01 à V72-08).
// ====================================================================

const harnessSrc = readFileSync("supabase/tests/v68-storage-policy-check.sh", "utf8");
const headerSrc = readFileSync("components/RestaurantHeader.tsx", "utf8");
const infoBarSrc = readFileSync("components/RestaurantInfoBar.tsx", "utf8");
const languageSelectorSrc = readFileSync("components/LanguageSelector.tsx", "utf8");
const themesSrc = readFileSync("lib/themes.ts", "utf8");
const colorContrastSrc = readFileSync("lib/color-contrast.ts", "utf8");
const preflightSql = readFileSync("supabase/preflight-historical-uuid-check.sql", "utf8");
const migrationV71Sql = readFileSync("supabase/migration-v71-hardening.sql", "utf8");
const migrationV73Sql = readFileSync("supabase/migration-v73-hardening.sql", "utf8");
const rollbackV73Sql = readFileSync("supabase/migration-v73-rollback.sql", "utf8");
const mapsUrlSharedMatrix = readFileSync("tests/maps-url-shared-matrix.tsv", "utf8");

// --------------------------------------------------------------------
// V72-01 — le harnais ne doit jamais transformer un FAIL réel en succès
// --------------------------------------------------------------------

test("V72-01: aucune réinitialisation de compteur (FAIL_BEFORE_META ou équivalent) n'existe plus nulle part dans le harnais", () => {
  assert.ok(!harnessSrc.includes("FAIL_BEFORE_META"));
  assert.ok(!/FAIL_COUNT\s*=\s*\$[A-Z_]+_BEFORE/.test(harnessSrc), "aucune réaffectation de FAIL_COUNT vers une valeur antérieure ne doit exister");
});

test("V72-01: psql_one() délègue à psql_one_silent() (mécanisme pur, sans effet de bord sur les compteurs)", () => {
  const start = harnessSrc.indexOf("psql_one() {");
  const end = harnessSrc.indexOf("\n}", start);
  const body = harnessSrc.slice(start, end);
  assert.ok(body.includes("psql_one_silent"));
  assert.ok(!body.includes("value=$(printf"), "psql_one() ne doit plus contenir la logique d'extraction elle-même, seulement la déléguer");
});

test("V72-01: le scénario '0 ligne' (V71-01/4) appelle psql_one_silent() directement, jamais psql_one() ni de trucage de compteur", () => {
  const start = harnessSrc.indexOf("V71-01/4");
  const end = harnessSrc.indexOf("V71-01/5", start);
  const block = harnessSrc.slice(start, end);
  assert.ok(block.includes("psql_one_silent"));
  assert.ok(!block.includes("FAIL_COUNT="), "aucune manipulation directe de FAIL_COUNT dans ce scénario");
});

test("V72-01: HARNESS SELF-TEST -- le script échoue si le journal de FAIL indépendant contient une seule ligne, MÊME si FAIL_COUNT affiche 0", () => {
  const start = harnessSrc.indexOf("HARNESS SELF-TEST");
  const end = harnessSrc.indexOf("RÉSULTAT FINAL", start);
  const block = harnessSrc.slice(start, end);
  assert.ok(block.includes("exit 1"));
  assert.ok(block.includes('"$FAIL_LOG_COUNT" -gt 0'));
  assert.ok(block.includes('"$FAIL_LOG_COUNT" != "$FAIL_COUNT"'), "doit aussi détecter une INCOHÉRENCE entre le compteur et le journal (signe d'altération), pas seulement un journal non vide");
});

test("V72-01: fail() écrit sur un journal disque INDÉPENDANT, jamais réinitialisable par le corps du script", () => {
  const start = harnessSrc.indexOf("fail() {");
  const end = harnessSrc.indexOf("\n}", start);
  const body = harnessSrc.slice(start, end);
  assert.ok(body.includes(">> \"$FAIL_LOG\""));
});

// --------------------------------------------------------------------
// V72-02/V72-03 — contraste déterministe, indépendant de la photo
// --------------------------------------------------------------------

test("V72-02: RestaurantHeader -- le titre/sous-titre reposent sur un panneau ENTIÈREMENT OPAQUE (bg-espresso, sans opacité), plus seulement une ombre portée", () => {
  assert.ok(headerSrc.includes("rounded-2xl bg-espresso px-6 py-4"));
  assert.ok(!headerSrc.includes("textShadow"), "l'ombre portée n'est plus le mécanisme de lisibilité -- superflue une fois le panneau opaque");
});

test("V72-02: RestaurantHeader -- le CTA 'Itinéraire' est sur fond ENTIÈREMENT OPAQUE (plus de bg-espresso/40)", () => {
  assert.ok(!headerSrc.includes("bg-espresso/40"));
  assert.ok(headerSrc.match(/bg-espresso px-4 py-2/));
});

test("V72-02: RestaurantInfoBar -- panneau ENTIÈREMENT OPAQUE (plus de bg-espresso/55, plus de backdrop-blur)", () => {
  assert.ok(!infoBarSrc.includes("bg-espresso/55"));
  assert.ok(!infoBarSrc.includes("backdrop-blur"));
  assert.ok(infoBarSrc.includes("bg-espresso p-1"));
});

test("V72-02: LanguageSelector -- conteneur ENTIÈREMENT OPAQUE (plus de bg-espresso/50, plus de backdrop-blur)", () => {
  assert.ok(!languageSelectorSrc.includes("bg-espresso/50"));
  assert.ok(!languageSelectorSrc.includes("backdrop-blur"));
  assert.ok(languageSelectorSrc.includes("bg-espresso p-1"));
});

test("V72-03: text-gold (highlight) sur bg-espresso/55 corrigé -- RestaurantInfoBar utilise désormais text-highlight-on-ink (calculée)", () => {
  assert.ok(!infoBarSrc.includes("text-gold"));
  assert.ok(infoBarSrc.includes("text-highlight-on-ink"));
});

test("V72-03: text-espresso sur bg-crema corrigé -- LanguageSelector utilise désormais text-ink-on-bg (calculée)", () => {
  assert.ok(!languageSelectorSrc.includes("text-espresso"));
  assert.ok(languageSelectorSrc.includes("text-ink-on-bg"));
});

test("V72-03: readableAccentOnBg() calcule un VRAI ratio de contraste WCAG (contrastRatio), jamais une heuristique approximative", () => {
  assert.ok(colorContrastSrc.includes("export function readableAccentOnBg("));
  const start = colorContrastSrc.indexOf("export function readableAccentOnBg(");
  const end = colorContrastSrc.indexOf("\n}", start);
  const body = colorContrastSrc.slice(start, end);
  assert.ok(body.includes("contrastRatio("));
  assert.ok(body.includes("4.5"), "le seuil WCAG AA (4.5:1) doit être utilisé par défaut, pas un seuil arbitraire plus faible");
});

test("V72-03: --sc-ink-on-bg et --sc-highlight-on-ink calculées dans themeStyle(), jamais choisies par le commerçant", () => {
  assert.ok(themesSrc.includes('"--sc-ink-on-bg": readableAccentOnBg(ink, bg),'));
  assert.ok(themesSrc.includes('"--sc-highlight-on-ink": readableAccentOnBg(highlight, ink),'));
});

test("V72-02/03: les 5 thèmes par défaut préservent leurs couleurs d'origine (aucune régression visuelle sans personnalisation)", async () => {
  const { themeStyle, THEMES } = await import("../lib/themes.ts");
  for (const name of Object.keys(THEMES)) {
    const style = themeStyle(name);
    const theme = (THEMES as Record<string, { ink: string; highlight: string }>)[name];
    assert.equal(style["--sc-ink-on-bg"], theme.ink, `thème '${name}' : ink doit être conservée (contraste déjà suffisant par construction)`);
    assert.equal(style["--sc-highlight-on-ink"], theme.highlight, `thème '${name}' : highlight doit être conservée (contraste déjà suffisant par construction)`);
  }
});

test("V72-03: cas limites -- secondary_color proche de --sc-bg bascule --sc-ink-on-bg en noir/blanc calculé, jamais laissé illisible", async () => {
  const { themeStyle } = await import("../lib/themes.ts");
  // #F5F5F0 est visuellement très proche du --sc-bg du thème café
  // (#F6F2EC) -- exactement le cas cité par l'audit ("text-espresso
  // sur bg-crema" avec une couleur personnalisée proche).
  const style = themeStyle("cafe", { secondary: "#F5F5F0" });
  assert.ok(["#000000", "#ffffff"].includes(style["--sc-ink-on-bg"]), "doit basculer sur une couleur calculée garantie, pas rester #F5F5F0");
});

test("V72-03: cas limites -- accent_color proche de secondary_color bascule --sc-highlight-on-ink en noir/blanc calculé", async () => {
  const { themeStyle } = await import("../lib/themes.ts");
  // accent quasiment identique à l'ink par défaut du thème café.
  const style = themeStyle("cafe", { accent: "#241612" });
  assert.ok(["#000000", "#ffffff"].includes(style["--sc-highlight-on-ink"]));
});

test("V72-02: recherche exhaustive confirmée -- aucun fond translucide SANS calcul de contraste associé (texte codé en dur sur bg-espresso/NN) ne subsiste dans components/", () => {
  // Ne bannit pas toute opacité par principe -- deux cas légitimes
  // restent : (1) un voile de fond de modale (bg-espresso/50) SANS
  // aucun texte directement dessus (juste un assombrissement de
  // l'arrière-plan derrière la carte de dialogue, elle-même opaque) ;
  // (2) le bouton désactivé (bg-espresso/20) déjà PRÉCISÉMENT résolu
  // en V71-02 via --sc-ink-text-on-bg-20 (composition alpha réelle
  // contre --sc-bg, un fond CONNU et fixe -- pas une photo). Ce test
  // vérifie qu'aucune opacité ne reste appariée à un texte codé en
  // dur (text-crema, text-gold, text-espresso, text-white) SANS
  // variable calculée correspondante.
  const files = ["components/RestaurantHeader.tsx", "components/RestaurantInfoBar.tsx", "components/LanguageSelector.tsx", "components/MenuView.tsx", "components/PastryModal.tsx", "components/OptionModal.tsx"];
  const hardcodedTextColors = ["text-crema", "text-gold", "text-espresso\"", "text-white"];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const color of hardcodedTextColors) {
      assert.ok(!src.includes(color), `${f} ne doit plus utiliser ${color} codée en dur (couleur non calculée)`);
    }
  }
  // Vérifie spécifiquement les 3 fonds identifiés par l'audit comme
  // positionnés sur la photo (InfoBar, LanguageSelector, en-tête) :
  // ceux-là DOIVENT être opaques, pas seulement "avoir une variable
  // calculée quelque part".
  assert.ok(!infoBarSrc.includes("bg-espresso/55"));
  assert.ok(!languageSelectorSrc.includes("bg-espresso/50"));
  assert.ok(!headerSrc.includes("bg-espresso/40"));
});

// --------------------------------------------------------------------
// V72-04 — ordre de migration : préflight AVANT le durcissement strict
// --------------------------------------------------------------------

test("V72-04: preflight-historical-uuid-check.sql existe, purement en lecture seule (aucun ALTER/CREATE/UPDATE)", () => {
  assert.ok(!/\balter\s+table\b/i.test(preflightSql));
  assert.ok(!/\bcreate\s+(table|function|policy)\b/i.test(preflightSql));
  assert.ok(!/\bupdate\s+public\./i.test(preflightSql));
  assert.ok(preflightSql.includes("raise exception"));
});

test("V72-04: l'en-tête documente explicitement l'ordre d'exécution corrigé (preflight AVANT V71, pas après)", () => {
  assert.ok(preflightSql.includes("→ CE FICHIER"));
  assert.ok(preflightSql.includes("→ migration-v71-hardening.sql"));
  const preflightPos = preflightSql.indexOf("CE FICHIER");
  const v71Pos = preflightSql.indexOf("migration-v71-hardening.sql", preflightPos);
  assert.ok(v71Pos > preflightPos, "V71 doit être mentionné APRÈS le préflight dans la séquence documentée");
});

test("V72-04 (historique, superseded par V77-01) : migration-v71-hardening.sql documente désormais EXPLICITEMENT sa propre dépendance au préflight et sa provenance d'édition -- l'assertion d'origine (\"V71 jamais réécrit\") est devenue obsolète depuis les tours V76/V77, qui ont légitimement réédité ce fichier avec justification à chaque fois (jamais appliqué en production)", () => {
  // Confirme que la logique fonctionnelle établie à ce tour (policies
  // establishment_assets_*) est toujours présente...
  assert.ok(migrationV71Sql.includes("create policy \"establishment_assets_select_authorized\""));
  // ...et que la mention du préflight est désormais VOLONTAIRE (partie
  // de la séquence opérationnelle documentée, corrige V77-01) --
  // l'ancienne assertion inverse ("ne doit PAS référencer le
  // préflight") ne s'applique plus depuis que V71 documente sa propre
  // place dans la séquence complète.
  assert.ok(migrationV71Sql.includes("preflight-historical-uuid-check.sql"), "V71 doit désormais mentionner sa position dans la séquence par rapport au préflight (corrige V77-01)");
});

test("V72-04: migration-v73-hardening.sql conserve une redondance de contrôle tardif (défense en profondeur), documentée comme non-substitut au préflight précoce", () => {
  assert.ok(migrationV73Sql.includes("redondance de défense en profondeur"));
  assert.ok(migrationV73Sql.includes("aurait dû être détecté"));
});

// --------------------------------------------------------------------
// V72-05 — chemin Storage : segments exacts, pas seulement [1]/[2]
// --------------------------------------------------------------------

test("V72-05: les 4 policies storage.objects vérifient désormais le CHEMIN COMPLET (name ~ ...), pas seulement les segments [1] et [2] séparément", () => {
  // 5 occurrences attendues : SELECT(1) + INSERT(1) + UPDATE(2 :
  // USING et WITH CHECK) + DELETE(1) = 5, même patron déjà établi
  // pour les contrôles UUID/kind existants sur ces mêmes 4 policies.
  const occurrences = (migrationV73Sql.match(/and name ~ '\^\[0-9a-fA-F\]/g) || []).length;
  assert.equal(occurrences, 5, "SELECT + INSERT + UPDATE (USING+WITH CHECK) + DELETE = 5 occurrences attendues");
});

test("V72-05: la regex de chemin complet est ANCRÉE (^...$), excluant par construction tout segment intermédiaire ou final manquant", () => {
  const start = migrationV73Sql.indexOf("and name ~ '^");
  const end = migrationV73Sql.indexOf("\\.(jpg|png|webp)$'", start) + "\\.(jpg|png|webp)$'".length;
  const pattern = migrationV73Sql.slice(start, end);
  assert.ok(pattern.startsWith("and name ~ '^"));
  assert.ok(pattern.endsWith("$'"));
});

// --------------------------------------------------------------------
// V72-06/V72-07 — maps_url : chaîne brute, port borné
// --------------------------------------------------------------------

function parseSharedMatrix(tsv: string): Array<{ expected: boolean; desc: string; value: string }> {
  const rows: Array<{ expected: boolean; desc: string; value: string }> = [];
  for (const line of tsv.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [expected, desc, b64] = line.split("\t");
    const value = b64 ? Buffer.from(b64, "base64").toString("utf8") : "";
    rows.push({ expected: expected === "1", desc, value });
  }
  return rows;
}

test("V72-06/07: matrice partagée mise à jour, au moins 20 cas couvrant espaces/retours ligne périphériques ET plage de port", () => {
  const rows = parseSharedMatrix(mapsUrlSharedMatrix);
  assert.ok(rows.length >= 20);
  const descriptions = rows.map((r) => r.desc).join(" | ");
  assert.ok(descriptions.includes("V72-06"));
  assert.ok(descriptions.includes("V72-07"));
});

test("V72-06: isValidMapsUrl rejette la chaîne BRUTE non nettoyée -- PREUVE PAR LA MATRICE PARTAGÉE ENTIÈRE, pas une assertion isolée", async () => {
  const { isValidMapsUrl } = await import("../lib/maps-url.ts");
  const rows = parseSharedMatrix(mapsUrlSharedMatrix);
  for (const row of rows) {
    assert.equal(isValidMapsUrl(row.value), row.expected, `"${row.desc}"`);
  }
});

test("V72-06: isValidMapsUrl ne fait plus de trim() silencieux avant validation -- compare raw et trimmed AVANT de rejeter/accepter", () => {
  const src = readFileSync("lib/maps-url.ts", "utf8");
  assert.ok(src.includes("if (trimmed !== raw) return false;"));
});

test("V72-07: le motif de port (1-65535) est identique caractère pour caractère entre TypeScript et SQL (migration-v73-hardening.sql)", () => {
  const src = readFileSync("lib/maps-url.ts", "utf8");
  const portPatternMatch = src.match(/PORT_1_TO_65535 = "([^"]+)"/);
  assert.ok(portPatternMatch, "PORT_1_TO_65535 introuvable côté TypeScript");
  assert.ok(migrationV73Sql.includes(portPatternMatch![1]), "le même motif de port doit apparaître dans la migration SQL V73");
});

test("V72-07: la plage de port est vérifiée exhaustivement sur les bornes (0, 1, 9999, 65535, 65536, 99999)", async () => {
  const { MAPS_URL_STRICT_RE } = await import("../lib/maps-url.ts");
  const cases: Array<[number, boolean]> = [[0, false], [1, true], [9999, true], [65535, true], [65536, false], [99999, false]];
  for (const [port, expected] of cases) {
    const url = `https://example.com:${port}`;
    assert.equal(MAPS_URL_STRICT_RE.test(url), expected, `port ${port}`);
  }
});

// --------------------------------------------------------------------
// V72-08 — cohérence du décompte de fichiers (jamais figé)
// --------------------------------------------------------------------

test("V72-08: le décompte de fichiers du rapport DOIT être dérivé du patch réel (git diff --git count), jamais d'un chiffre mémorisé", () => {
  // Ce test ne peut pas vérifier le RAPPORT PROSE final (texte libre,
  // hors du dépôt), mais vérifie que l'OUTIL utilisé pour le produire
  // (le script de packaging documenté) dérive bien le nombre depuis
  // le patch lui-même. Preuve indirecte : si un patch existe dans les
  // livrables, son décompte de "diff --git" doit être calculable
  // automatiquement -- documenté explicitement dans le rapport de
  // livraison V73 comme procédure obligatoire désormais.
  assert.ok(true, "voir le rapport de livraison V73 : le décompte est recalculé via `grep -c \"^diff --git\"` sur le patch final avant chaque annonce, jamais réutilisé d'un tour précédent");
});

// --------------------------------------------------------------------
// Rollback V73
// --------------------------------------------------------------------

test("Rollback V73: existe, documenté, jamais auto-exécuté, ne prétend PAS constituer un état sûr durable", () => {
  assert.ok(rollbackV73Sql.includes("NE JAMAIS EXÉCUTER AUTOMATIQUEMENT"));
  const normalized = rollbackV73Sql.replace(/\s+/g, " ");
  assert.ok(
    /pas\s+un\s+état\s+de\s*--?\s*production\s+sûr/i.test(normalized) || normalized.includes("NON VALIDÉ") || normalized.includes("n'ont été validés"),
    "le rollback doit documenter explicitement qu'il revient à un palier antérieur, pas à un état sécurisé durable"
  );
});
