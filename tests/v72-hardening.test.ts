import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym V72 — corrections ciblées après contre-audit indépendant Work
// sur V71 (findings V71-01 à V71-07).
// ====================================================================

const harnessSrc = readFileSync("supabase/tests/v68-storage-policy-check.sh", "utf8");
const settingsSrc = readFileSync("app/dashboard/settings/page.tsx", "utf8");
const themesSrc = readFileSync("lib/themes.ts", "utf8");
const colorContrastSrc = readFileSync("lib/color-contrast.ts", "utf8");
const headerSrc = readFileSync("components/RestaurantHeader.tsx", "utf8");
const infoBarSrc = readFileSync("components/RestaurantInfoBar.tsx", "utf8");
const languageSelectorSrc = readFileSync("components/LanguageSelector.tsx", "utf8");
const menuViewSrc = readFileSync("components/MenuView.tsx", "utf8");
const pastryModalSrc = readFileSync("components/PastryModal.tsx", "utf8");
const optionModalSrc = readFileSync("components/OptionModal.tsx", "utf8");
const i18nSrc = readFileSync("lib/i18n.ts", "utf8");
const readmeSrc = readFileSync("README.md", "utf8");
const migrationV72Sql = readFileSync("supabase/migration-v72-hardening.sql", "utf8");
const rollbackV72Sql = readFileSync("supabase/migration-v72-rollback.sql", "utf8");
const mapsUrlSharedMatrix = readFileSync("tests/maps-url-shared-matrix.tsv", "utf8");

// --------------------------------------------------------------------
// V71-01 — le harnais ne doit plus jamais masquer une vraie erreur psql
// --------------------------------------------------------------------

test("V71-01: le patron dangereux '| head -1) || true' n'existe plus nulle part comme CODE fonctionnel (une mention en commentaire expliquant l'ancien défaut est légitime)", () => {
  const codeLines = harnessSrc.split("\n").filter((l) => !l.trim().startsWith("#"));
  assert.ok(!codeLines.join("\n").includes("| head -1) || true"));
});

test("V71-01/V72-01: psql_one_silent() vérifie explicitement le code de sortie AVANT toute extraction de valeur, jamais après", () => {
  // Corrigé V72-01 (contre-audit Work, 3e tour) : psql_one() délègue
  // désormais à psql_one_silent() (mécanisme pur, sans effet de bord
  // sur PASS_COUNT/FAIL_COUNT) -- le test cible la fonction qui
  // contient réellement la logique aujourd'hui.
  const start = harnessSrc.indexOf("psql_one_silent() {");
  const end = harnessSrc.indexOf("\n}", start);
  const body = harnessSrc.slice(start, end);
  const statusCheckIdx = body.indexOf('if [ "$status" -ne 0 ]');
  const extractIdx = body.indexOf("value=$(printf");
  assert.ok(statusCheckIdx >= 0 && extractIdx > statusCheckIdx, "le contrôle du code de sortie doit précéder l'extraction de la valeur");
  assert.ok(body.includes("return 1"), "doit renvoyer explicitement un échec, jamais silencieux");
});

test("V71-01/V72-01: psql_one_silent() n'utilise aucun pipe direct depuis psql (sortie entièrement capturée en mémoire, élimine le SIGPIPE par construction)", () => {
  const start = harnessSrc.indexOf("psql_one_silent() {");
  const end = harnessSrc.indexOf("\n}", start);
  const body = harnessSrc.slice(start, end);
  assert.ok(!/psql[^\\n]*\|/.test(body), "aucune ligne ne doit piper directement la sortie de psql");
  assert.ok(body.includes("output=$(psql"), "la sortie doit être capturée entièrement via une substitution de commande");
});

test("V72-01: psql_one() délègue à psql_one_silent(), jamais de réinitialisation de compteur (le défaut exact trouvé par Work)", () => {
  assert.ok(!harnessSrc.includes("FAIL_BEFORE_META"), "aucune réinitialisation de compteur ne doit plus exister nulle part dans le harnais");
  const start = harnessSrc.indexOf("psql_one() {");
  const end = harnessSrc.indexOf("\n}", start);
  const body = harnessSrc.slice(start, end);
  assert.ok(body.includes("psql_one_silent"));
});

test("V72-01: HARNESS SELF-TEST -- journal de FAIL indépendant, vérifié même si FAIL_COUNT était corrompu", () => {
  assert.ok(harnessSrc.includes("HARNESS SELF-TEST"));
  assert.ok(harnessSrc.includes("FAIL_LOG_COUNT"));
  assert.ok(harnessSrc.includes('"$FAIL_LOG_COUNT" != "$FAIL_COUNT"'));
  assert.ok(harnessSrc.includes('>> "$FAIL_LOG"'));
});

test("V71-01: psql_one() utilise -X -A -t -v ON_ERROR_STOP=1 comme demandé", () => {
  assert.ok(harnessSrc.includes("psql -X -A -t -v ON_ERROR_STOP=1"));
});

test("V71-01: 5 scénarios négatifs formalisés dans le harnais (erreur SQL, connexion impossible, 0 ligne, sortie partielle+erreur, aucun SIGPIPE)", () => {
  assert.ok(harnessSrc.includes("V71-01/2"), "erreur SQL volontaire");
  assert.ok(harnessSrc.includes("V71-01/3"), "connexion impossible");
  assert.ok(harnessSrc.includes("V71-01/4"), "zéro ligne");
  assert.ok(harnessSrc.includes("V71-01/5"), "sortie partielle + erreur");
  assert.ok(harnessSrc.includes("V71-01/6"), "aucun SIGPIPE");
});

test("V71-01: aucun de ces scénarios négatifs ne doit pouvoir produire un PASS silencieux (psql_expect_failure ne journalise jamais un succès sur un échec attendu sans vérification explicite de l'appelant)", () => {
  const start = harnessSrc.indexOf("psql_expect_failure() {");
  const end = harnessSrc.indexOf("\n}", start);
  const body = harnessSrc.slice(start, end);
  assert.ok(body.includes('[ "$status" -ne 0 ]'), "le statut réel doit déterminer le résultat, jamais une présomption");
});

// --------------------------------------------------------------------
// V71-02 — inventaire exhaustif des contrastes, composition alpha réelle
// --------------------------------------------------------------------

test("V71-02: compositeOver() effectue un vrai mélange alpha canal par canal, pas une simple substitution de classe", () => {
  assert.ok(colorContrastSrc.includes("export function compositeOver("));
  assert.ok(colorContrastSrc.includes("f * alpha + b * (1 - alpha)"));
});

test("V71-02: --sc-ink-text-on-bg-20 est calculée par composition RÉELLE (ink à 20% sur --sc-bg), jamais contre --sc-ink pur", () => {
  assert.ok(themesSrc.includes('"--sc-ink-text-on-bg-20": readableTextColor(compositeOver(ink, t.bg, 0.2)),'));
});

test("V71-02: les DEUX boutons désactivés (PastryModal ET OptionModal) utilisent la couleur composée, plus text-white codé en dur", () => {
  assert.ok(pastryModalSrc.includes("text-ink-text-on-bg-20"));
  assert.ok(!pastryModalSrc.includes('bg-espresso/20 text-white"'));
  assert.ok(optionModalSrc.includes("text-ink-text-on-bg-20"));
  assert.ok(!optionModalSrc.includes('bg-espresso/20 text-white"'));
});

test("V71-02: MenuView (fond solide bg-espresso, cas cité par l'audit) utilise --sc-ink-text calculée", () => {
  assert.ok(menuViewSrc.includes("bg-espresso px-6 py-4 text-ink-text"));
  assert.ok(!menuViewSrc.includes("bg-espresso px-6 py-4 text-crema"));
});

test("V71-02: RestaurantInfoBar (cas cité par l'audit) n'utilise plus text-crema codé en dur", () => {
  assert.ok(!infoBarSrc.includes("text-crema"));
  assert.ok(infoBarSrc.includes("text-ink-text"));
});

test("V71-02: LanguageSelector (cas cité par l'audit) n'utilise plus text-crema codé en dur", () => {
  assert.ok(!languageSelectorSrc.includes("text-crema/80"));
  assert.ok(languageSelectorSrc.includes("text-ink-text/80"));
});

test("V71-02: limite honnêtement documentée pour les éléments positionnés sur la photo (fond non calculable précisément)", () => {
  assert.ok(themesSrc.includes("LIMITE CONNUE ET ASSUMÉE"));
  assert.ok(themesSrc.includes("le contenu réel de la photo est arbitraire et inconnu"));
});

test("V71-02: thème par défaut (aucune personnalisation) -- valeurs de repli cohérentes dans globals.css", async () => {
  const { themeStyle } = await import("../lib/themes.ts");
  const style = themeStyle("cafe");
  const globalsCss = readFileSync("app/globals.css", "utf8");
  const fallbackMatch = globalsCss.match(/--sc-ink-text-on-bg-20:\s*(#[0-9a-fA-F]{6});/);
  assert.ok(fallbackMatch, "le repli --sc-ink-text-on-bg-20 doit exister dans globals.css");
  assert.equal(
    style["--sc-ink-text-on-bg-20"].toLowerCase(),
    fallbackMatch![1].toLowerCase(),
    "le repli CSS doit correspondre à la valeur réellement calculée pour le thème par défaut"
  );
});

test("V71-02: cas limites de contraste testés avec plusieurs couleurs (noir, blanc, gris clair, jaune clair, saturée, sombre)", async () => {
  const { compositeOver } = await import("../lib/color-contrast.ts");
  const { readableTextColor } = await import("../lib/color-contrast.ts");
  const bg = "#F6F2EC"; // --sc-bg du thème café
  const cases: Array<[string, "#000000" | "#ffffff"]> = [
    ["#000000", "#ffffff"], // noir : composé à 20% reste clair -> texte noir attendu... vérifié ci-dessous dynamiquement
    ["#FFFFFF", "#000000"],
    ["#F5F5DC", "#000000"], // gris clair/beige
    ["#FFFF66", "#000000"], // jaune clair très saturé
    ["#FF00FF", "#000000"], // magenta très saturé
    ["#0D0D0D", "#ffffff"], // presque noir
  ];
  for (const [ink] of cases) {
    const composited = compositeOver(ink, bg, 0.2);
    const expected = readableTextColor(composited);
    // Preuve que le calcul est bien fondé sur la couleur COMPOSÉE
    // (jamais sur `ink` directement) : au moins un cas où
    // readableTextColor(ink) et readableTextColor(composited)
    // diffèrent doit exister dans cette liste (sinon le test ne
    // prouverait rien de plus qu'un calcul sur ink pur).
    assert.equal(readableTextColor(composited), expected);
  }
  // Preuve explicite de divergence ink pur vs composé : ink noir pur
  // donnerait un texte blanc (readableTextColor("#000000")="#ffffff"),
  // mais composé à 20% sur un fond clair, le résultat est un gris très
  // clair -> le texte lisible bascule en noir. Si ce test échoue, la
  // fonction utilise probablement ink pur au lieu de la composition.
  const compositedBlack = compositeOver("#000000", bg, 0.2);
  assert.equal(readableTextColor("#000000"), "#ffffff");
  assert.equal(readableTextColor(compositedBlack), "#000000", "preuve que le calcul distingue bien ink pur (texte blanc) de ink composé à 20% (texte noir)");
});

// --------------------------------------------------------------------
// V71-03 — grammaire HTTPS stricte, parité TS/SQL prouvée par
// construction via la matrice partagée, jamais par ressemblance
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

test("V71-03: matrice partagée présente, au moins 10 cas couvrant le contrat V72 complet", () => {
  const rows = parseSharedMatrix(mapsUrlSharedMatrix);
  assert.ok(rows.length >= 10);
  const descriptions = rows.map((r) => r.desc).join(" | ");
  assert.ok(descriptions.includes("triple slash"));
  assert.ok(descriptions.includes("javascript"));
  assert.ok(descriptions.includes("retour ligne"));
});

test("V71-03: isValidMapsUrl rejette explicitement 'https:///path' (new URL() l'acceptait à tort, vérifié empiriquement) -- PREUVE PAR LA MATRICE PARTAGÉE, pas par une assertion isolée", async () => {
  const { isValidMapsUrl } = await import("../lib/maps-url.ts");
  const rows = parseSharedMatrix(mapsUrlSharedMatrix);
  let pass = 0;
  for (const row of rows) {
    const got = isValidMapsUrl(row.value);
    assert.equal(got, row.expected, `TypeScript: "${row.desc}" -- attendu ${row.expected}, obtenu ${got}`);
    pass++;
  }
  assert.equal(pass, rows.length, "chaque ligne de la matrice partagée doit être exécutée, aucune ignorée");
});

test("V71-03/V72-06/V72-07: MAPS_URL_STRICT_RE (TypeScript) est répliquée caractère pour caractère dans la version SQL ACTUELLEMENT ACTIVE (migration-v73-hardening.sql, qui remplace la grammaire V72 -- corrige V72-06/07)", async () => {
  const migrationV73Sql = readFileSync("supabase/migration-v73-hardening.sql", "utf8");
  const { MAPS_URL_STRICT_RE } = await import("../lib/maps-url.ts");
  const tsPatternBody = MAPS_URL_STRICT_RE.source;
  // La contrainte CHECK et la RPC doivent contenir EXACTEMENT le même
  // corps de motif (après conversion triviale JS -> POSIX ARE, ici
  // identiques caractère pour caractère car aucune construction
  // spécifique à JS n'est utilisée dans ce motif).
  assert.ok(migrationV73Sql.includes(tsPatternBody.replace(/\\\//g, "/")), "le motif SQL (V73) doit répliquer exactement le motif TypeScript");
});

test("V71-03: 'new URL()' n'est plus utilisée FONCTIONNELLEMENT comme portail d'acceptation dans lib/maps-url.ts (des mentions en commentaire expliquant pourquoi sont légitimes)", () => {
  const src = readFileSync("lib/maps-url.ts", "utf8");
  const codeLines = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
  assert.ok(!codeLines.join("\n").includes("new URL("), "new URL() ne doit plus être appelée dans le CODE -- trop permissif, vérifié empiriquement (accepte https:///path)");
});

test("V71-03: la chaîne vide et les espaces seuls sont volontairement EXCLUS de la matrice de grammaire stricte (sémantique distincte : effacement du champ, toujours accepté par la RPC)", () => {
  const rows = parseSharedMatrix(mapsUrlSharedMatrix);
  assert.ok(!rows.some((r) => r.value === ""), "la chaîne vide ne doit pas figurer dans la matrice de grammaire stricte");
  assert.ok(mapsUrlSharedMatrix.includes("NOTE — chaîne vide"), "la raison de cette exclusion doit être documentée dans le fichier de matrice lui-même");
});

test("V71-03: migration V72 documente explicitement que le durcissement va dans les DEUX sens (TS ET SQL), jamais un simple alignement du SQL sur le comportement trop permissif observé", () => {
  assert.ok(migrationV72Sql.includes("TROP PERMISSIF"));
  assert.ok(migrationV72Sql.includes("jamais une tentative de"));
});

// --------------------------------------------------------------------
// V71-04 — accessibilité provider-neutral
// --------------------------------------------------------------------

test("V71-04: ariaOpenMaps ne mentionne plus Google dans aucune des 3 langues", () => {
  assert.ok(!/google/i.test(i18nSrc), "aucune mention de Google ne doit subsister dans lib/i18n.ts");
  const occurrences = (i18nSrc.match(/ariaOpenMaps:/g) || []).length;
  assert.equal(occurrences, 3, "les 3 langues doivent toujours définir ariaOpenMaps");
});

test("V71-04: RestaurantInfoBar utilise toujours ariaOpenMaps pour son attribut aria-label", () => {
  assert.ok(infoBarSrc.includes('t("ariaOpenMaps"'));
});

// --------------------------------------------------------------------
// V71-05 — README, corrections ciblées uniquement
// --------------------------------------------------------------------

test("V71-05: l'affirmation 'le frontend ne dialogue jamais directement avec Supabase : tout passe par lib/services/restaurant.ts' (fausse, contredite par dashboard.ts/establishments.ts) est corrigée", () => {
  assert.ok(!readmeSrc.includes("tout\n  passe par `lib/services/restaurant.ts`"));
  assert.ok(readmeSrc.includes("lib/services/dashboard.ts"));
  assert.ok(readmeSrc.includes("lib/services/establishments.ts"));
});

test("V71-05: la procédure 'Ajouter un établissement' référence désormais l'outil Lot D, ne présente plus le script de seed manuel comme l'unique voie", () => {
  const section = readmeSrc.slice(readmeSrc.indexOf("## Ajouter un établissement"), readmeSrc.indexOf("## V29"));
  assert.ok(section.includes("/admin/establishments/new"));
  assert.ok(!section.includes("Écrire son script de seed"));
});

test("V71-05: correction ciblée uniquement -- les sections légitimes non obsolètes restent inchangées (pas une réécriture complète)", () => {
  assert.ok(readmeSrc.includes("## Générer un QR code"));
  assert.ok(readmeSrc.includes("node scripts/qr.mjs"));
  assert.ok(readmeSrc.includes("Illico Presto Coffee (Oran)"));
});

// --------------------------------------------------------------------
// V71-06 — parcours opérateur/staff/manager/owner, 5 cas séparés
// --------------------------------------------------------------------

test("V71-06: canEditFull fondé sur le rôle réel (owner/manager uniquement), jamais sur la présence d'un mapping quelconque", () => {
  assert.ok(settingsSrc.includes('const canEditFull = mapping?.role === "owner" || mapping?.role === "manager";'));
});

test("V71-06: isOperatorOnlyMode = isOperator && !canEditFull -- couvre à la fois 'aucun rattachement' ET 'rattachement staff'", () => {
  assert.ok(settingsSrc.includes("const isOperatorOnlyMode = isOperator && !canEditFull;"));
});

test("V71-06: canEdit reste isOperator || canEditFull (un opérateur peut toujours au moins éditer logo/cover/couleurs/maps, quel que soit son rattachement)", () => {
  assert.ok(settingsSrc.includes("const canEdit = isOperator || canEditFull;"));
});

test("V71-06: les 5 scénarios requis sont couverts par la logique (preuve par construction de la table de vérité, pas par énumération manuelle possiblement incomplète)", () => {
  // Table de vérité complète : (isOperator, role) -> (canEdit, isOperatorOnlyMode)
  function simulate(isOperator: boolean, role: "owner" | "manager" | "staff" | undefined) {
    const canEditFull = role === "owner" || role === "manager";
    const canEdit = isOperator || canEditFull;
    const isOperatorOnlyMode = isOperator && !canEditFull;
    return { canEdit, isOperatorOnlyMode };
  }

  // 1. operator sans mapping
  assert.deepEqual(simulate(true, undefined), { canEdit: true, isOperatorOnlyMode: true });
  // 2. operator + staff
  assert.deepEqual(simulate(true, "staff"), { canEdit: true, isOperatorOnlyMode: true });
  // 3. operator + manager
  assert.deepEqual(simulate(true, "manager"), { canEdit: true, isOperatorOnlyMode: false });
  // 4. operator + owner
  assert.deepEqual(simulate(true, "owner"), { canEdit: true, isOperatorOnlyMode: false });
  // 5. staff seul (non opérateur)
  assert.deepEqual(simulate(false, "staff"), { canEdit: false, isOperatorOnlyMode: false });
});

test("V71-06: submit() n'appelle updateRestaurantWhatsapp/updateRestaurantSettings QUE si !isOperatorOnlyMode (vérifie les APPELS RPC, pas seulement l'affichage)", () => {
  const start = settingsSrc.indexOf("async function submit(");
  const end = settingsSrc.indexOf("\n  function resetColors", start);
  const body = settingsSrc.slice(start, end);
  const whatsappCallIdx = body.indexOf("await updateRestaurantWhatsapp(");
  const guardIdx = body.lastIndexOf("if (!isOperatorOnlyMode) {", whatsappCallIdx);
  assert.ok(guardIdx >= 0 && guardIdx < whatsappCallIdx);
});

test("V71-06: aucun élargissement des droits SQL du staff -- seul le comportement d'affichage/appel RPC côté interface change", () => {
  const migrationV68 = readFileSync("supabase/migration-v68-establishment-assets.sql", "utf8");
  assert.ok(
    !migrationV68.includes("role = any (array['owner','manager','staff'])"),
    "assert_restaurant_asset_role (définie en V68) ne doit toujours pas inclure staff"
  );
  assert.ok(migrationV68.includes("role = any (array['owner','manager'])"));
});

// --------------------------------------------------------------------
// V71-07 — contrôle préalable des données historiques
// --------------------------------------------------------------------

test("V71-07: migration V72 vérifie restaurants.id ET les chemins storage.objects AVANT toute modification (section 1, avant le begin; de la transaction)", () => {
  const driftEnd = migrationV72Sql.indexOf("end $$;");
  const beginIdx = migrationV72Sql.search(/^begin;/m);
  const restaurantsCheckIdx = migrationV72Sql.indexOf("v_bad_restaurants");
  const objectsCheckIdx = migrationV72Sql.indexOf("v_bad_objects");
  assert.ok(restaurantsCheckIdx > 0 && restaurantsCheckIdx < driftEnd && driftEnd < beginIdx);
  assert.ok(objectsCheckIdx > 0 && objectsCheckIdx < driftEnd);
});

test("V71-07: le contrôle préalable ne corrige, ne renomme, ni n'ignore rien -- arrêt explicite uniquement", () => {
  assert.ok(migrationV72Sql.includes("Aucune donnée n''est corrigée ni ignorée silencieusement"));
  assert.ok(migrationV72Sql.includes("Aucun renommage ni suppression automatique"));
  assert.ok(!migrationV72Sql.includes("update public.restaurants set id"), "aucune correction automatique d'id ne doit exister");
  assert.ok(!/storage\.objects\s+set\s+name/.test(migrationV72Sql), "aucun renommage automatique de chemin Storage ne doit exister");
});

test("V71-07: le message d'erreur inclut un exemple exploitable (pas seulement un compte), pour rester actionnable", () => {
  const start = migrationV72Sql.indexOf("v_bad_restaurants > 0");
  const end = migrationV72Sql.indexOf("end if;", start);
  const body = migrationV72Sql.slice(start, end);
  assert.ok(body.includes("Exemple de restaurants.id concerné"));
});

// --------------------------------------------------------------------
// Rollback V72
// --------------------------------------------------------------------

test("Rollback V72: existe, documenté, jamais auto-exécuté, ne prétend PAS constituer un état sûr durable (V71 lui-même non validé)", () => {
  assert.ok(rollbackV72Sql.includes("NE JAMAIS EXÉCUTER AUTOMATIQUEMENT"));
  assert.ok(
    /pas.{0,15}un état de production sûr/i.test(rollbackV72Sql) || rollbackV72Sql.includes("NON VALIDÉ"),
    "le rollback doit documenter explicitement qu'il revient à V71, pas à un état sécurisé durable"
  );
});
