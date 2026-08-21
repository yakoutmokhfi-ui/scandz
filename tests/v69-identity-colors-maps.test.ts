import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const {
  isValidHexColor,
  relativeLuminance,
  contrastRatio,
  readableTextColor,
  darken,
} = await import("../lib/color-contrast.ts");
const { isValidMapsUrl, normalizeMapsUrl, MAPS_URL_MAX_LENGTH } = await import(
  "../lib/maps-url.ts"
);
const { themeStyle, THEMES } = await import("../lib/themes.ts");
const { supabase } = await import("../lib/supabase.ts");

// ====================================================================
// Scanym V69 — couleurs personnalisées, lien de localisation/itinéraire
// (renommé maps_url en V70, F-02), durcissement logo/cover. Complète
// (sans les réécrire) les lots V67/V68 déjà
// livrés : lib/services/product-photo.ts et
// lib/services/establishment-assets.ts ne sont pas modifiés par ce
// lot, donc pas re-testés ici (voir tests/v67-product-photos.test.ts
// et tests/v68-establishment-assets.test.ts, toujours 100% verts).
//
// L'isolation Storage réelle (restriction du 2e segment de chemin, la
// validation du chemin d'URL dans set_restaurant_logo/_cover, et les
// deux nouvelles RPC couleurs/maps) est prouvée par exécution réelle
// contre PostgreSQL, PAS ici : voir
// supabase/tests/v68-storage-policy-check.sh (étendu en V69, pas un
// second harnais) et son journal
// supabase/tests/v68-storage-policy-check-log-sample.txt (65/65 PASS).
// ====================================================================

// --- 1. Couleurs : validation stricte #RRGGBB ---

test("couleur: #RRGGBB valide accepté (majuscules et minuscules)", () => {
  assert.equal(isValidHexColor("#5C3A21"), true);
  assert.equal(isValidHexColor("#f3e6d0"), true);
  assert.equal(isValidHexColor("#000000"), true);
  assert.equal(isValidHexColor("#FFFFFF"), true);
});

test("couleur: formats invalides refusés (forme courte, nom CSS, rgb(), sans #, extra caractères)", () => {
  assert.equal(isValidHexColor("#FFF"), false, "forme courte #RGB refusée");
  assert.equal(isValidHexColor("red"), false, "nom CSS refusé");
  assert.equal(isValidHexColor("rgb(255,0,0)"), false, "rgb() refusé");
  assert.equal(isValidHexColor("5C3A21"), false, "sans # refusé");
  assert.equal(isValidHexColor("#5C3A21FF"), false, "8 chiffres (alpha) refusé");
  assert.equal(isValidHexColor("#GGGGGG"), false, "caractères non hexadécimaux refusés");
  assert.equal(isValidHexColor(""), false, "chaîne vide refusée (la nullabilité se gère en amont, pas via cette fonction)");
});

// --- 2. Contraste WCAG : calcul déterministe, documenté ---

test("contraste: luminance relative -- blanc = 1, noir = 0", () => {
  assert.ok(Math.abs(relativeLuminance("#ffffff") - 1) < 1e-9);
  assert.equal(relativeLuminance("#000000"), 0);
});

test("contraste: ratio de contraste blanc/noir = 21 (maximum WCAG)", () => {
  assert.ok(Math.abs(contrastRatio("#ffffff", "#000000") - 21) < 1e-6);
});

test("contraste: fond sombre -- texte clair (blanc)", () => {
  assert.equal(readableTextColor("#221510"), "#ffffff");
  assert.equal(readableTextColor("#000000"), "#ffffff");
});

test("contraste: fond clair -- texte foncé (noir), y compris l'exemple du brief (#F3E6D0)", () => {
  assert.equal(readableTextColor("#F3E6D0"), "#000000");
  assert.equal(readableTextColor("#ffffff"), "#000000");
});

test("contraste: les 5 thèmes Scanym existants restent en texte blanc (aucune régression visuelle sans couleur personnalisée)", () => {
  for (const [name, theme] of Object.entries(THEMES)) {
    assert.equal(
      readableTextColor(theme.accent),
      "#ffffff",
      `le thème "${name}" doit garder du texte blanc sur son accent (comportement text-white en dur avant V69)`
    );
  }
});

test("contraste: darken() assombrit chaque canal, jamais sous 0", () => {
  assert.equal(darken("#A3651F", 0), "#a3651f");
  const darker = darken("#A3651F", 0.15);
  assert.notEqual(darker, "#a3651f");
  assert.ok(darker.length === 7 && darker.startsWith("#"));
  assert.equal(darken("#000000", 0.5), "#000000", "un canal déjà à 0 ne devient jamais négatif");
});

// --- 3. themeStyle() : surcharges de couleur, fallback strict ---

test("themeStyle: sans surcharge -- variables identiques à avant V69 (aucun argument overrides)", () => {
  const vars = themeStyle("cafe");
  assert.equal(vars["--sc-accent"], THEMES.cafe.accent);
  assert.equal(vars["--sc-ink"], THEMES.cafe.ink);
  assert.equal(vars["--sc-highlight"], THEMES.cafe.highlight);
  assert.equal(vars["--sc-accent-dark"], THEMES.cafe.accentDark);
});

test("themeStyle: overrides avec les 3 valeurs null -- strictement identique au thème statique (fallback obligatoire)", () => {
  const withNulls = themeStyle("cafe", { primary: null, secondary: null, accent: null });
  const withoutOverrides = themeStyle("cafe");
  assert.deepEqual(withNulls, withoutOverrides);
});

test("themeStyle: primary_color surcharge --sc-accent ET --sc-accent-text (calculée, jamais fournie par le commerçant)", () => {
  const vars = themeStyle("cafe", { primary: "#F3E6D0" });
  assert.equal(vars["--sc-accent"], "#F3E6D0");
  assert.equal(vars["--sc-accent-text"], "#000000", "un fond clair doit produire du texte noir, calculé automatiquement");
});

test("themeStyle: secondary_color surcharge --sc-ink (et donc le voile de bannière dérivé de ink)", () => {
  const vars = themeStyle("cafe", { secondary: "#123456" });
  assert.equal(vars["--sc-ink"], "#123456");
});

test("themeStyle: accent_color surcharge --sc-highlight, sans toucher --sc-accent", () => {
  const vars = themeStyle("cafe", { accent: "#C99A48" });
  assert.equal(vars["--sc-highlight"], "#C99A48");
  assert.equal(vars["--sc-accent"], THEMES.cafe.accent);
});

// --- 4. Lien de localisation/itinéraire : validation HTTPS stricte
// (F-02, corrigée en V70 -- http:// est désormais REFUSÉ, provider-
// neutral : aucune restriction à un domaine Google précis) ---

test("maps url (F-02): https valide accepté, y compris un raccourcisseur (maps.app.goo.gl) et un domaine non-Google", () => {
  assert.equal(isValidMapsUrl("https://maps.app.goo.gl/abc123"), true);
  assert.equal(isValidMapsUrl("https://example.com/itineraire"), true, "aucune restriction à un domaine Google précis");
});

test("maps url (F-02): http:// REFUSÉ (https strictement obligatoire)", () => {
  assert.equal(isValidMapsUrl("http://maps.google.com/?q=1,2"), false);
  assert.equal(isValidMapsUrl("http://example.com/x"), false);
});

test("maps url: schéma non https refusé (javascript:, data:, ftp:)", () => {
  assert.equal(isValidMapsUrl("javascript:alert(1)"), false);
  assert.equal(isValidMapsUrl("data:text/html,<script>alert(1)</script>"), false);
  assert.equal(isValidMapsUrl("ftp://example.com/x"), false);
});

test("maps url: chaîne non-URL refusée, chaîne vide refusée", () => {
  assert.equal(isValidMapsUrl("pas une url"), false);
  assert.equal(isValidMapsUrl(""), false);
  assert.equal(isValidMapsUrl("   "), false);
});

test("maps url: longueur excessive refusée", () => {
  const tooLong = "https://example.com/" + "a".repeat(MAPS_URL_MAX_LENGTH);
  assert.equal(isValidMapsUrl(tooLong), false);
});

test("maps url: normalizeMapsUrl ne fait que trim (aucune réécriture silencieuse du lien fourni)", () => {
  assert.equal(normalizeMapsUrl("  https://maps.app.goo.gl/abc  "), "https://maps.app.goo.gl/abc");
});

// --- 5. Services dashboard.ts : nouvelles RPC, aucune écriture directe ---

test("établissement: getRestaurantSettings/RestaurantSettingsRow exposent les 4 nouveaux champs (F-02: maps_url, pas google_maps_url)", () => {
  const source = readFileSync("lib/services/dashboard.ts", "utf8");
  assert.ok(/primary_color:\s*string \| null;/.test(source));
  assert.ok(/secondary_color:\s*string \| null;/.test(source));
  assert.ok(/accent_color:\s*string \| null;/.test(source));
  assert.ok(/maps_url:\s*string \| null;/.test(source));
  assert.ok(
    source.includes("primary_color, secondary_color, accent_color, maps_url"),
    "le select() de getRestaurantSettings doit inclure les 4 nouvelles colonnes"
  );
  assert.ok(!source.includes("google_maps_url"), "F-02: le nom de colonne provider-neutral (maps_url) doit avoir remplacé google_maps_url dans le code applicatif");
});

test("établissement: updateRestaurantColors/updateRestaurantMapsUrl appellent leur RPC dédiée, jamais d'écriture directe sur restaurant_configs", async (t) => {
  const rpcCalls: { name: string; params: unknown }[] = [];
  t.mock.method(supabase, "rpc", async (name: string, params: unknown) => {
    rpcCalls.push({ name, params });
    return { data: null, error: null };
  });
  const { updateRestaurantColors, updateRestaurantMapsUrl } = await import(
    "../lib/services/dashboard.ts"
  );

  await updateRestaurantColors("r1", "#5C3A21", null, "#C99A48");
  await updateRestaurantMapsUrl("r1", "https://maps.app.goo.gl/x");

  assert.equal(rpcCalls.length, 2);
  assert.equal(rpcCalls[0].name, "update_restaurant_colors");
  assert.deepEqual(rpcCalls[0].params, {
    p_restaurant_id: "r1",
    p_primary_color: "#5C3A21",
    p_secondary_color: null,
    p_accent_color: "#C99A48",
  });
  assert.equal(rpcCalls[1].name, "update_restaurant_maps_url");
  assert.deepEqual(rpcCalls[1].params, { p_restaurant_id: "r1", p_maps_url: "https://maps.app.goo.gl/x" });

  const source = readFileSync("lib/services/dashboard.ts", "utf8");
  const fns = source.slice(source.indexOf("export async function updateRestaurantColors"));
  assert.ok(!/\.from\("restaurant_configs"\)\.update/.test(fns), "aucune écriture directe sur restaurant_configs -- doit passer par la RPC");
});

// --- 6. lib/types.ts : champs additifs, logo_url non touchée ---

test("types: RestaurantConfig expose les 4 nouveaux champs en optionnel/nullable, logo_url reste non-optionnelle", () => {
  const source = readFileSync("lib/types.ts", "utf8");
  assert.ok(/primary_color\?:\s*string \| null;/.test(source));
  assert.ok(/secondary_color\?:\s*string \| null;/.test(source));
  assert.ok(/accent_color\?:\s*string \| null;/.test(source));
  assert.ok(/maps_url\?:\s*string \| null;/.test(source), "F-02: maps_url (provider-neutral), pas google_maps_url");
  assert.ok(/logo_url:\s*string \| null;/.test(source), "logo_url doit rester non-optionnelle, non modifiée");
});

// --- 7. Composants publics : text-caramel-ink partout où bg-caramel est utilisé ---

test("carte publique: aucun composant ne mélange bg-caramel avec text-white (contraste toujours calculé, jamais du blanc en dur sur un fond personnalisable)", () => {
  const files = [
    "components/TableSelector.tsx",
    "components/MenuItemCard.tsx",
    "components/QuantityControl.tsx",
    "components/CategoryNav.tsx",
    "components/InlineOptions.tsx",
    "components/OptionModal.tsx",
    "components/OrderConfirmation.tsx",
    "components/CartPanel.tsx",
    "components/PastryModal.tsx",
  ];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.ok(source.includes("bg-caramel"), `${file}: attendu au moins une occurrence de bg-caramel (sinon ce test ne vérifie rien)`);
    assert.ok(!/bg-caramel[^"]*text-white/.test(source), `${file}: bg-caramel ne doit jamais être directement suivi de text-white dans la même classe`);
  }
});

test("tailwind.config.ts: caramel-ink mappé sur --sc-accent-text, repli blanc (aucune régression sans couleur personnalisée)", () => {
  const source = readFileSync("tailwind.config.ts", "utf8");
  assert.ok(source.includes('"caramel-ink": "var(--sc-accent-text, #ffffff)"'));
});

// --- 8. Migration V69 : structure, non-régression, sécurité ---

test("migration V69: colonnes additives nullable avec contrainte CHECK, aucune colonne existante modifiée", () => {
  const source = readFileSync("supabase/migration-v69-identity-colors-maps-hardening.sql", "utf8");
  assert.ok(source.includes("add column if not exists primary_color text"));
  assert.ok(source.includes("add column if not exists secondary_color text"));
  assert.ok(source.includes("add column if not exists accent_color text"));
  assert.ok(source.includes("add column if not exists google_maps_url text"));
  assert.ok(!/drop column/i.test(source));
  assert.ok(!/rename column/i.test(source));
  assert.ok(!/alter table public\.scanym_operators/i.test(source), "scanym_operators non modifiée");
  assert.ok(!/alter table public\.restaurant_users/i.test(source), "restaurant_users non modifiée");
});

test("migration V69: contraintes CHECK #RRGGBB pour les 3 couleurs, http(s) pour google_maps_url", () => {
  const source = readFileSync("supabase/migration-v69-identity-colors-maps-hardening.sql", "utf8");
  const hexChecks = (source.match(/~ '\^#\[0-9A-Fa-f\]\{6\}\$'/g) || []).length;
  assert.ok(hexChecks >= 3, "au moins 3 contraintes CHECK au format #RRGGBB (primary/secondary/accent)");
  assert.ok(source.includes("google_maps_url ~ '^https?://'"));
});

test("migration V69: update_restaurant_colors / update_restaurant_maps_url réservées owner/manager, jamais staff, PAS étendues à is_scanym_operator", () => {
  const source = readFileSync("supabase/migration-v69-identity-colors-maps-hardening.sql", "utf8");
  const colorsFn = source.slice(
    source.indexOf("create function public.update_restaurant_colors"),
    source.indexOf("revoke all on function public.update_restaurant_colors")
  );
  const mapsFn = source.slice(
    source.indexOf("create function public.update_restaurant_maps_url"),
    source.indexOf("revoke all on function public.update_restaurant_maps_url")
  );
  for (const fn of [colorsFn, mapsFn]) {
    assert.ok(fn.includes("role = any (array['owner', 'manager'])"));
    assert.ok(!fn.includes("'staff'"));
    assert.ok(!fn.includes("is_scanym_operator"), "les réglages cosmétiques ne doivent pas être ouverts aux opérateurs Scanym (hors périmètre de ce lot)");
  }
});

test("migration V69: set_restaurant_logo/set_restaurant_cover restent CREATE OR REPLACE avec la MÊME signature (uuid, text) -- aucune rupture pour le code appelant existant", () => {
  const source = readFileSync("supabase/migration-v69-identity-colors-maps-hardening.sql", "utf8");
  assert.ok(source.includes("create or replace function public.set_restaurant_logo(\n  p_restaurant_id uuid,\n  p_url           text\n)"));
  assert.ok(source.includes("create or replace function public.set_restaurant_cover(\n  p_restaurant_id uuid,\n  p_url           text\n)"));
});

test("migration V69: set_restaurant_logo/set_restaurant_cover réutilisent assert_restaurant_asset_role (V68, inchangée), ajoutent une validation de chemin ancrée ^...$", () => {
  const source = readFileSync("supabase/migration-v69-identity-colors-maps-hardening.sql", "utf8");
  const logoFn = source.slice(source.indexOf("create or replace function public.set_restaurant_logo"), source.indexOf("revoke all on function public.set_restaurant_logo"));
  const coverFn = source.slice(source.indexOf("create or replace function public.set_restaurant_cover"), source.indexOf("revoke all on function public.set_restaurant_cover"));
  assert.ok(logoFn.includes("assert_restaurant_asset_role(p_restaurant_id)"));
  assert.ok(coverFn.includes("assert_restaurant_asset_role(p_restaurant_id)"));
  assert.ok(logoFn.includes("/logo/[0-9a-fA-F-]{36}"));
  assert.ok(coverFn.includes("/cover/[0-9a-fA-F-]{36}"));
  assert.ok(logoFn.includes("^https?://[^/]+/storage/v1/object/public/establishment-assets/"));
  assert.ok(logoFn.trim().length > 0 && /\\\.\(jpg\|png\|webp\)\$/.test(logoFn), "le motif doit être ancré en fin de chaîne ($), pas une simple recherche de sous-chaîne");
});

test("migration V69: les 4 policies establishment_assets_* sont DROP puis CREATE (mêmes noms qu'en V68), 2e segment de chemin restreint à {logo,cover}", () => {
  const source = readFileSync("supabase/migration-v69-identity-colors-maps-hardening.sql", "utf8");
  for (const name of ["select", "insert", "update", "delete"]) {
    assert.ok(source.includes(`drop policy "establishment_assets_${name}_authorized" on storage.objects;`));
    assert.ok(source.includes(`create policy "establishment_assets_${name}_authorized"`));
  }
  const segmentRestrictions = (source.match(/\(storage\.foldername\(name\)\)\[2\] in \('logo', 'cover'\)/g) || []).length;
  assert.equal(segmentRestrictions, 5, "select/insert/delete (1 chacune) + update (using + with check) = 5");
});

test("migration V69: les policies conservent TOUS les contrôles V68 (format UUID, owner/manager, opérateur Scanym), rien assoupli", () => {
  const source = readFileSync("supabase/migration-v69-identity-colors-maps-hardening.sql", "utf8");
  const policiesBlock = source.slice(
    source.indexOf('create policy "establishment_assets_select_authorized"'),
    source.indexOf("commit;")
  );
  const uuidChecks = (policiesBlock.match(/\^\[0-9a-fA-F-\]\{36\}\$/g) || []).length;
  const operatorChecks = (policiesBlock.match(/public\.is_scanym_operator\(\)/g) || []).length;
  const roleChecks = (policiesBlock.match(/role = any \(array\['owner','manager'\]\)/g) || []).length;
  // 5, pas 4 : select/insert/delete (1 chacune) + update (using ET
  // with check) = 3 + 2 = 5, même schéma que V68.
  assert.equal(uuidChecks, 5);
  assert.equal(operatorChecks, 5);
  assert.equal(roleChecks, 5);
  assert.ok(!policiesBlock.includes("'staff'"));
  assert.ok(!/to\s+anon/i.test(policiesBlock));
});

test("migration V69: aucune policy product_photos_* touchée (isolation stricte des deux buckets, inchangée)", () => {
  const source = readFileSync("supabase/migration-v69-identity-colors-maps-hardening.sql", "utf8");
  assert.ok(!/product_photos_/.test(source.replace(/--.*$/gm, "")));
});

test("migration V69: aucune clé service_role, aucun secret, aucune donnée client en dur", () => {
  const source = readFileSync("supabase/migration-v69-identity-colors-maps-hardening.sql", "utf8");
  assert.ok(!/service_role/.test(source));
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(source));
  assert.ok(!/au lait cru/i.test(source));
});

// --- 9. i18n ---

test("V69: toutes les nouvelles clés i18n existent en fr/en/ar et diffèrent entre langues", () => {
  const source = readFileSync("lib/i18n.ts", "utf8");
  const keys = [
    "directions", "stColorsTitle", "stColorsHint", "stPrimaryColor", "stSecondaryColor",
    "stAccentColor", "stColorInvalid", "stColorsReset", "stColorsSaveError",
    "stMapsTitle", "stMapsHint", "stMapsInvalid", "stMapsTest", "stMapsSaveError",
    "stAssetDeleteLogoConfirm", "stAssetDeleteCoverConfirm",
  ];
  for (const key of keys) {
    const count = (source.match(new RegExp(`\\b${key}:`, "g")) || []).length;
    assert.equal(count, 3, `${key} doit être défini exactement 3 fois (fr, en, ar)`);
  }
});

test("V69: les libellés exacts demandés dans le brief sont bien ceux utilisés (fr)", () => {
  const source = readFileSync("lib/i18n.ts", "utf8");
  assert.ok(source.includes('directions: "Itinéraire",'));
  assert.ok(source.includes('stMapsTest: "Tester le lien",'));
  assert.ok(source.includes('stColorsReset: "Réinitialiser les couleurs",'));
  assert.ok(source.includes('stAssetDeleteLogoConfirm: "Supprimer le logo ?",'));
  assert.ok(source.includes('stAssetDeleteCoverConfirm: "Supprimer la photo ?",'));
});

// --- 10. Dashboard : confirmation avant suppression logo/cover ---

test("dashboard settings: une confirmation (window.confirm) est demandée avant toute suppression de logo/cover", () => {
  const source = readFileSync("app/dashboard/settings/page.tsx", "utf8");
  const fn = source.slice(
    source.indexOf("async function handleRemove"),
    source.indexOf("const label = kind ===")
  );
  assert.ok(fn.includes("window.confirm("), "handleRemove doit demander confirmation avant de supprimer");
  assert.ok(fn.includes("if (!window.confirm(deleteConfirmLabel)) return;"), "un refus de confirmation doit annuler la suppression sans appeler removeEstablishmentAsset");
});

test("dashboard settings: le message de confirmation est spécifique au logo et à la photo de couverture (2 messages distincts, pas un texte générique)", () => {
  const source = readFileSync("app/dashboard/settings/page.tsx", "utf8");
  assert.ok(source.includes('kind === "logo" ? t("stAssetDeleteLogoConfirm") : t("stAssetDeleteCoverConfirm")'));
});

// --- 11. Dashboard : validation couleurs/maps avant tout appel réseau, champ vide toujours accepté ---

test("dashboard settings: submit() valide le format des couleurs et du lien Maps AVANT tout appel réseau (mêmes principes que la validation WhatsApp existante)", () => {
  const source = readFileSync("app/dashboard/settings/page.tsx", "utf8");
  const fn = source.slice(source.indexOf("async function submit"), source.indexOf("function resetColors"));
  const whatsappCheckIdx = fn.indexOf("isValidWhatsappNumber(cleanWhatsapp)");
  const colorCheckIdx = fn.indexOf("isValidHexColor(c.trim())");
  // Corrige V73-01 (contre-audit Work, 4e tour) : isValidMapsUrl()
  // doit être appelée sur la valeur BRUTE (`mapsUrl`, l'état du champ
  // tel que saisi), jamais sur une version déjà nettoyée par
  // normalizeMapsUrl() -- l'ancien ordre (normaliser PUIS valider)
  // laissait passer un espace/retour ligne périphérique.
  const mapsCheckIdx = fn.indexOf("isValidMapsUrl(mapsUrl)");
  const mapsCheckOnCleanedIdx = fn.indexOf("isValidMapsUrl(cleanMapsUrl)");
  const firstRpcCallIdx = fn.indexOf("updateRestaurantWhatsapp(");
  assert.ok(whatsappCheckIdx >= 0 && whatsappCheckIdx < firstRpcCallIdx);
  assert.ok(colorCheckIdx >= 0 && colorCheckIdx < firstRpcCallIdx, "la validation des couleurs doit précéder tout appel RPC");
  assert.ok(mapsCheckIdx >= 0 && mapsCheckIdx < firstRpcCallIdx, "la validation du lien Maps doit précéder tout appel RPC, et porter sur la valeur BRUTE (mapsUrl)");
  assert.equal(mapsCheckOnCleanedIdx, -1, "isValidMapsUrl() ne doit plus jamais être appelée sur cleanMapsUrl (valeur déjà nettoyée) dans submit() -- corrige V73-01");
});

test("dashboard settings: resetColors() vide les 3 champs couleur (retour au thème Scanym par défaut, en attente de confirmation par Enregistrer)", () => {
  const source = readFileSync("app/dashboard/settings/page.tsx", "utf8");
  const fn = source.slice(source.indexOf("function resetColors"), source.indexOf("function resetColors") + 200);
  assert.ok(fn.includes('setPrimaryColor("")'));
  assert.ok(fn.includes('setSecondaryColor("")'));
  assert.ok(fn.includes('setAccentColor("")'));
});

test("dashboard settings: ColorField synchronise le color picker HTML et le champ texte #RRGGBB sur le MÊME état (aucune divergence possible)", () => {
  const source = readFileSync("app/dashboard/settings/page.tsx", "utf8");
  const fn = source.slice(source.indexOf("function ColorField"));
  assert.ok(fn.includes('type="color"'));
  assert.ok(fn.includes("onChange={(e) => onChange(e.target.value)}"));
  const onChangeCalls = (fn.match(/onChange\(e\.target\.value\)/g) || []).length;
  assert.equal(onChangeCalls, 2, "le picker ET le champ texte doivent tous les deux appeler le même onChange (état partagé)");
});

test("dashboard settings: ColorField affiche un aperçu (Aa) qui réutilise readableTextColor -- pas une couleur de texte fixe", () => {
  const source = readFileSync("app/dashboard/settings/page.tsx", "utf8");
  const fn = source.slice(source.indexOf("function ColorField"));
  assert.ok(fn.includes("color: readableTextColor(trimmed)"));
});
