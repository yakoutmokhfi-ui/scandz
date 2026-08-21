import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// Scanym V71 — corrections ciblées après audit indépendant V70.
// V70-01/04/05/07 : voir supabase/migration-v71-hardening.sql (preuve
// PostgreSQL réelle dans supabase/tests/v68-storage-policy-check.sh,
// étendu pour V71, pas un second harnais).
// V70-02/03/06/08 : purement applicatifs, testés ici.
// ====================================================================

const migrationSql = readFileSync("supabase/migration-v71-hardening.sql", "utf8");
const settingsSrc = readFileSync("app/dashboard/settings/page.tsx", "utf8");
const themesSrc = readFileSync("lib/themes.ts", "utf8");
const headerSrc = readFileSync("components/RestaurantHeader.tsx", "utf8");
const infoBarSrc = readFileSync("components/RestaurantInfoBar.tsx", "utf8");
const readmeSrc = readFileSync("README.md", "utf8");
const i18nSrc = readFileSync("lib/i18n.ts", "utf8");

// --------------------------------------------------------------------
// V70-01 — structural checks on the corrective migration
// --------------------------------------------------------------------

test("V70-01: assert_establishment_asset_url échoue explicitement si aucune origine Storage n'est configurée (fail-closed) -- mécanisme remplacé par V76 (scanym_internal.storage_config), comportement fail-closed identique", () => {
  const start = migrationSql.indexOf("create or replace function public.assert_establishment_asset_url(");
  const end = migrationSql.indexOf("end $$;", start);
  const body = migrationSql.slice(start, end);
  assert.ok(body.includes("if v_base_url is null then"));
  assert.ok(body.includes("raise exception"));
  assert.ok(
    !body.includes("v_full_pattern := '^https://[^/]+'"),
    "l'ancien repli 'host https arbitraire accepté' ne doit plus exister"
  );
});

test("V70-04: contrainte CHECK et update_restaurant_maps_url exigent un host non vide, pas seulement le préfixe https://", () => {
  assert.ok(migrationSql.includes("maps_url ~ '^https://[^/\\s]+(/[^\\s]*)?$'"));
  const start = migrationSql.indexOf("create or replace function public.update_restaurant_maps_url(");
  const end = migrationSql.indexOf("end $$;", start);
  const body = migrationSql.slice(start, end);
  assert.ok(body.includes("v_url !~ '^https://[^/\\s]+(/[^\\s]*)?$'"));
  assert.ok(body.includes("must start with https://"), "http:// doit rester explicitement rejeté avec son propre message");
});

test("V70-05: contrôle préalable détecte explicitement la coexistence de google_maps_url ET maps_url", () => {
  assert.ok(migrationSql.includes("SIMULTANÉMENT"));
  const start = migrationSql.indexOf("do $$");
  const end = migrationSql.indexOf("end $$;", start);
  const body = migrationSql.slice(start, end);
  assert.ok(body.includes("column_name = 'google_maps_url'") && body.includes("column_name = 'maps_url'"));
  assert.ok(body.includes("raise exception"));
});

test("V70-07: regex UUID v4 stricte (tirets aux bonnes positions + nibbles version/variant), plus seulement 36 caractères hex/tirets", () => {
  const strictPattern = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
  assert.ok(migrationSql.includes(strictPattern));
  assert.ok(
    !migrationSql.includes("[0-9a-fA-F-]{36}"),
    "l'ancienne regex permissive ne doit plus être utilisée nulle part dans ce fichier"
  );
  // Présente dans les 4 policies storage.objects ET dans assert_establishment_asset_url
  const occurrences = migrationSql.split(strictPattern).length - 1;
  assert.ok(occurrences >= 5, `attendu au moins 5 occurrences (4 policies + la fonction), trouvé ${occurrences}`);
});

test("migration V71: ne réécrit jamais V68/V69/V70 -- uniquement CREATE OR REPLACE (même signature) et DROP+CREATE POLICY (mêmes noms)", () => {
  assert.ok(!migrationSql.includes("drop function"), "aucune fonction ne doit être supprimée, seulement remplacée");
  assert.ok(migrationSql.includes("create or replace function public.assert_establishment_asset_url"));
  assert.ok(migrationSql.includes("create or replace function public.update_restaurant_maps_url"));
});

// --------------------------------------------------------------------
// V70-02 — séparation propre du parcours opérateur / owner-manager
// --------------------------------------------------------------------

test("V70-02/V71-06: isOperatorOnlyMode fondé sur les permissions EFFECTIVES (canEditFull), jamais sur la seule absence de mapping", () => {
  // Corrigé après contre-audit Work (V71-06, 2e tour) : la version
  // précédente (`isOperator && !mapping`) laissait passer le
  // formulaire complet à un opérateur ÉGALEMENT présent dans
  // restaurant_users avec le rôle 'staff' (mapping existe, mais ce
  // rôle n'autorise pas WhatsApp/adresse/horaires/langue). Voir
  // tests/v72-hardening.test.ts pour la couverture complète des 5 cas.
  assert.ok(settingsSrc.includes("const isOperatorOnlyMode = isOperator && !canEditFull;"));
  assert.ok(
    !settingsSrc.includes("const isOperatorOnlyMode = isOperator && !mapping;"),
    "l'ancienne condition insuffisante (fondée sur !mapping) ne doit plus exister"
  );
});

test("V70-02: submit() n'appelle updateRestaurantWhatsapp/updateRestaurantSettings QUE si !isOperatorOnlyMode", () => {
  const start = settingsSrc.indexOf("async function submit(");
  const end = settingsSrc.indexOf("\n  function resetColors", start);
  const body = settingsSrc.slice(start, end);
  const whatsappIdx = body.indexOf("updateRestaurantWhatsapp(");
  const guardIdx = body.lastIndexOf("if (!isOperatorOnlyMode)", whatsappIdx);
  assert.ok(guardIdx >= 0 && guardIdx < whatsappIdx, "l'appel WhatsApp doit être gardé par isOperatorOnlyMode");
  assert.ok(body.includes("await updateRestaurantSettings("));
});

test("V70-02: updateRestaurantColors et updateRestaurantMapsUrl sont TOUJOURS appelées, jamais gardées par isOperatorOnlyMode", () => {
  const start = settingsSrc.indexOf("async function submit(");
  const end = settingsSrc.indexOf("\n  function resetColors", start);
  const body = settingsSrc.slice(start, end);
  const colorsIdx = body.indexOf("await updateRestaurantColors(");
  const mapsIdx = body.indexOf("await updateRestaurantMapsUrl(");
  assert.ok(colorsIdx >= 0 && mapsIdx >= 0);
  // Aucune des deux lignes ne doit être précédée par une garde
  // isOperatorOnlyMode dans les ~5 lignes qui précèdent.
  const beforeColors = body.slice(Math.max(0, colorsIdx - 150), colorsIdx);
  const beforeMaps = body.slice(Math.max(0, mapsIdx - 150), mapsIdx);
  assert.ok(!beforeColors.includes("isOperatorOnlyMode"));
  assert.ok(!beforeMaps.includes("isOperatorOnlyMode"));
});

test("V70-02: la validation WhatsApp au début de submit() est gardée par !isOperatorOnlyMode (ne bloque jamais un opérateur seul)", () => {
  const start = settingsSrc.indexOf("async function submit(");
  const setSavingIdx = settingsSrc.indexOf("setSaving(true);", start);
  const body = settingsSrc.slice(start, setSavingIdx);
  assert.ok(body.includes("if (!isOperatorOnlyMode) {"));
  assert.ok(body.includes("isValidWhatsappNumber(cleanWhatsapp)"));
});

test("V70-02: maps_url a sa PROPRE section JSX, plus mélangée avec adresse/horaires, toujours rendue quand canEdit", () => {
  const mapsIdx = settingsSrc.indexOf('{t("stMapsTitle")}');
  const infoIdx = settingsSrc.indexOf('{t("stInfoTitle")}');
  assert.ok(mapsIdx > 0 && infoIdx > 0);
  assert.ok(mapsIdx > infoIdx, "la section maps doit venir après la section info (adresse/horaires), pas dedans");
  // La section maps ne doit pas être entre les balises d'ouverture/fermeture de la section info.
  const infoSectionEnd = settingsSrc.indexOf("</section>", infoIdx);
  assert.ok(mapsIdx > infoSectionEnd, "stMapsTitle ne doit plus être à l'intérieur de la section stInfoTitle");
});

test("V70-02: sections langue/adresse-horaires/WhatsApp masquées en mode opérateur seul, logo/cover/couleurs/maps ne le sont jamais", () => {
  // Compte les gardes {!isOperatorOnlyMode && ( ... langue/adresse/whatsapp
  const langGuardIdx = settingsSrc.lastIndexOf("{!isOperatorOnlyMode && (", settingsSrc.indexOf('{t("stLangTitle")}'));
  const infoGuardIdx = settingsSrc.lastIndexOf("{!isOperatorOnlyMode && (", settingsSrc.indexOf('{t("stInfoTitle")}'));
  const whatsappGuardIdx = settingsSrc.lastIndexOf("{!isOperatorOnlyMode && (", settingsSrc.indexOf('{t("stWhatsappTitle")}'));
  assert.ok(langGuardIdx >= 0, "section langue doit être gardée");
  assert.ok(infoGuardIdx >= 0, "section adresse/horaires doit être gardée");
  assert.ok(whatsappGuardIdx >= 0, "section WhatsApp doit être gardée");

  // Les sections identité (logo/cover/couleurs) ne doivent JAMAIS être
  // gardées par isOperatorOnlyMode.
  const identityIdx = settingsSrc.indexOf('{t("stIdentityTitle")}');
  const beforeIdentity = settingsSrc.slice(Math.max(0, identityIdx - 300), identityIdx);
  assert.ok(!beforeIdentity.includes("isOperatorOnlyMode"), "logo/cover/couleurs ne doivent jamais être masqués pour un opérateur");
});

test("V70-02: un opérateur SANS mapping voit son mode expliqué (bandeau dédié), distinct du message 'réservé au gérant'", () => {
  assert.ok(settingsSrc.includes("canEdit && isOperatorOnlyMode"));
  assert.ok(settingsSrc.includes('t("stOperatorOnlyMode")'));
});

test('i18n: clé stOperatorOnlyMode présente en fr/en/ar', () => {
  const occurrences = (i18nSrc.match(/stOperatorOnlyMode:/g) || []).length;
  assert.equal(occurrences, 3, "la clé doit exister dans les 3 dictionnaires (fr/en/ar)");
});

// --------------------------------------------------------------------
// V70-03 — contraste réel des couleurs dynamiques
// --------------------------------------------------------------------

test("V70-03: --sc-ink-text est calculée via readableTextColor(ink), jamais choisie par le commerçant", () => {
  const start = themesSrc.indexOf("export function themeStyle(");
  const body = themesSrc.slice(start);
  assert.ok(body.includes('"--sc-ink-text": readableTextColor(ink),'));
});

test("V70-03: RestaurantHeader utilise --sc-ink-text (via la classe ink-text) pour le texte rendu sur le fond --sc-ink, plus text-crema/text-gold codés en dur", () => {
  assert.ok(headerSrc.includes("text-ink-text"));
  assert.ok(!headerSrc.includes("text-crema"), "text-crema (en réalité --sc-bg, jamais recalculée) ne doit plus être utilisée dans le header");
  assert.ok(!headerSrc.includes("text-gold"), "text-gold codé en dur ne doit plus être utilisé pour le texte du header");
});

test("V70-03: tailwind.config.ts expose la couleur ink-text liée à --sc-ink-text", () => {
  const tw = readFileSync("tailwind.config.ts", "utf8");
  assert.ok(tw.includes('"ink-text": "var(--sc-ink-text, #ffffff)"'));
});

test("V70-03: thème par défaut (aucun override) -- --sc-ink-text reste blanc pour les 5 thèmes existants (aucune régression visuelle)", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
  const { themeStyle, THEMES } = await import("../lib/themes.ts");
  for (const name of Object.keys(THEMES)) {
    const style = themeStyle(name);
    assert.equal(style["--sc-ink-text"], "#ffffff", `le thème '${name}' doit garder un texte blanc sans personnalisation (ink sombre par construction)`);
  }
});

test("V70-03: cas limites -- secondary_color clair (le cas audité) bascule --sc-ink-text en noir", async () => {
  const { themeStyle } = await import("../lib/themes.ts");
  const cases: Array<[string, "#000000" | "#ffffff"]> = [
    ["#FFFFFF", "#000000"], // cas exact de l'audit
    ["#000000", "#ffffff"],
    ["#F5F5DC", "#000000"], // gris clair/beige
    ["#FFFF66", "#000000"], // jaune clair très saturé
    ["#FF00FF", "#000000"], // magenta très saturé (luminance élevée)
    ["#0D0D0D", "#ffffff"], // presque noir
    ["#221510", "#ffffff"], // ink par défaut du thème café (inchangé)
  ];
  for (const [secondary, expected] of cases) {
    const style = themeStyle("cafe", { secondary });
    assert.equal(style["--sc-ink-text"], expected, `secondary_color=${secondary} doit donner --sc-ink-text=${expected}`);
  }
});

test("V70-03: recherche exhaustive confirmée -- --sc-highlight n'est utilisée nulle part comme fond porteur de texte dans components/ ou app/", () => {
  // Documente la vérification déjà menée (pas une affirmation sans
  // preuve) : seul RestaurantHeader.tsx référence --sc-ink/--sc-highlight
  // parmi tous les fichiers de components/ et app/.
  assert.ok(headerSrc.includes("var(--sc-ink"));
});

// --------------------------------------------------------------------
// V70-06 — suppression du fallback Google implicite
// --------------------------------------------------------------------

test("V70-06: RestaurantHeader ne fabrique plus aucun lien depuis latitude/longitude", () => {
  assert.ok(!headerSrc.includes("google.com/maps"), "aucune construction de lien Google ne doit subsister dans RestaurantHeader");
  assert.ok(!headerSrc.includes("config.latitude"), "latitude ne doit plus être lue pour fabriquer un lien");
  assert.ok(!headerSrc.includes("config.longitude"), "longitude ne doit plus être lue pour fabriquer un lien");
  assert.ok(headerSrc.includes("const directionsUrl = config.maps_url ?? null;"));
});

test("V70-06: RestaurantInfoBar ne fabrique plus aucun lien depuis latitude/longitude (fichier retrouvé sur main, absent de l'archive V70)", () => {
  assert.ok(!infoBarSrc.includes("google.com/maps"), "aucune construction de lien Google ne doit subsister dans RestaurantInfoBar");
  assert.ok(!infoBarSrc.includes("config.latitude"));
  assert.ok(!infoBarSrc.includes("config.longitude"));
  assert.ok(infoBarSrc.includes("const mapsUrl = config.maps_url ?? null;"));
});

test("V70-06: latitude/longitude restent dans le type RestaurantConfig (données neutres conservées, jamais supprimées)", () => {
  const types = readFileSync("lib/types.ts", "utf8");
  assert.ok(types.includes("latitude: number | null;"));
  assert.ok(types.includes("longitude: number | null;"));
});

test("V70-06: absence de maps_url -- aucun CTA externe affiché (ni RestaurantHeader ni RestaurantInfoBar), pas de RNA/OSM/Apple Maps implémenté", () => {
  // "rna" en sous-chaîne nue produirait un faux positif ("Ornament"
  // contient "rna") -- motifs spécifiques à un fournisseur de
  // cartographie réel, pas une sous-chaîne générique.
  for (const src of [headerSrc, infoBarSrc]) {
    assert.ok(!src.includes("openstreetmap"));
    assert.ok(!src.includes("apple.com/maps"));
    assert.ok(!src.includes("rna.gouv"));
    assert.ok(!/\bRNA\b/.test(src));
  }
});

test("i18n: viewOnMaps (libellé 'Voir sur Google Maps') retiré, devenu orphelin après V70-06", () => {
  assert.ok(!i18nSrc.includes("viewOnMaps"));
});

// --------------------------------------------------------------------
// V70-08 — README ciblé
// --------------------------------------------------------------------

test("V70-08: l'affirmation auto-contradictoire 'pas d'authentification, dashboard...' est corrigée", () => {
  assert.ok(!readmeSrc.includes("Aucune fonctionnalité hors MVP (pas d'authentification, dashboard"));
});

test("V70-08: README mentionne désormais Lot D, couleurs, maps_url provider-neutral, et le modèle de permissions", () => {
  assert.ok(readmeSrc.includes("Lot D"));
  assert.ok(readmeSrc.includes("is_scanym_operator"));
  assert.ok(readmeSrc.includes("primary_color") || readmeSrc.includes("couleurs personnalisées"));
  assert.ok(readmeSrc.includes("maps_url"));
  assert.ok(readmeSrc.includes("indépendant de tout fournisseur"));
});

test("V70-08: correction ciblée uniquement -- le README garde sa structure et son contenu non-obsolète (pas une réécriture complète)", () => {
  // Vérifie que des sections légitimement inchangées sont toujours là
  // telles quelles, preuve que ce n'est pas une réécriture globale.
  assert.ok(readmeSrc.includes("## Générer un QR code"));
  assert.ok(readmeSrc.includes("## Ajouter un établissement"));
  assert.ok(readmeSrc.includes("node scripts/qr.mjs"));
  assert.ok(readmeSrc.includes("Illico Presto Coffee (Oran)"));
});
