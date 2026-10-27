import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const ov = await import("../lib/storefront-photo-overlay.ts");
const { themeStyle } = await import("../lib/themes.ts");
const { translate } = await import("../lib/i18n.ts");

// ====================================================================
// STOREFRONT PHOTO OVERLAY CONFIGURATION v1 — logique pure et garde-fous
// structurels. Le rendu réel du header est dans
// storefront-photo-overlay-v1.dom.test.ts ; la page Réglages dans la
// série PO de settings-save-reliability-v1.dom.test.ts ; le SQL dans
// supabase/tests/storefront-photo-overlay-v1-check.sh.
// ====================================================================

/** Chaîne EXACTE produite par RestaurantHeader AVANT ce lot (main 615f275). */
const LEGACY_LAYER =
  "linear-gradient(var(--sc-veil-soft, rgba(23,13,9,0.2)), var(--sc-veil-strong, rgba(23,13,9,0.32)))";

test("OVL-1 jeu fermé: exactement none | light | standard", () => {
  assert.deepEqual([...ov.STOREFRONT_PHOTO_OVERLAY_VALUES], ["none", "light", "standard"]);
  for (const v of ["none", "light", "standard"]) assert.equal(ov.isStorefrontPhotoOverlay(v), true);
  for (const v of ["", " none", "None", "NONE", "dark", "standard ", null, undefined, 0, 1, {}, [], "constructor", "__proto__"]) {
    assert.equal(ov.isStorefrontPhotoOverlay(v), false, String(v));
  }
});

test("OVL-2 rétrocompatibilité: toute valeur absente/inconnue/corrompue retombe sur 'standard' (rendu historique)", () => {
  assert.equal(ov.LEGACY_STOREFRONT_PHOTO_OVERLAY, "standard");
  for (const v of [undefined, null, "", " none", "None", "dark", 0, 1, true, {}, [], "constructor", "__proto__", "toString"]) {
    assert.equal(ov.normalizeStorefrontPhotoOverlay(v), "standard", String(v));
  }
  for (const v of ["none", "light", "standard"]) assert.equal(ov.normalizeStorefrontPhotoOverlay(v), v);
});

test("OVL-3 'standard' est la chaîne HISTORIQUE, octet pour octet (et indépendante de la teinte passée)", () => {
  assert.equal(ov.photoOverlayLayer("standard"), LEGACY_LAYER);
  assert.equal(ov.photoOverlayLayer("standard", "#12243D"), LEGACY_LAYER);
  assert.equal(
    ov.headerBackgroundImage("standard", "/banners/x.jpg"),
    `${LEGACY_LAYER}, url('/banners/x.jpg')`
  );
});

test("OVL-4 'none' ne pose AUCUN dégradé: la photo seule", () => {
  assert.equal(ov.photoOverlayLayer("none"), null);
  assert.equal(ov.photoOverlayLayerResolved("none"), null);
  assert.equal(ov.headerBackgroundImage("none", "/banners/x.jpg"), "url('/banners/x.jpg')");
  assert.ok(!ov.headerBackgroundImage("none", "https://cdn.example/c.jpg", "#000000").includes("gradient"));
});

test("OVL-5 'light' est un voile de même teinte, strictement plus léger que 'standard'", () => {
  const layer = ov.photoOverlayLayer("light", "#12243D")!;
  assert.equal(layer, "linear-gradient(rgba(18, 36, 61, 0.08), rgba(18, 36, 61, 0.13))");
  const [lt, lb] = ov.PHOTO_OVERLAY_ALPHA.light;
  const [st, sb] = ov.PHOTO_OVERLAY_ALPHA.standard;
  assert.ok(lt < st && lb < sb && lt > 0 && lb > 0, "léger: >0 et < standard, en haut comme en bas");
  assert.ok(lt <= lb && st <= sb, "dégradé croissant de haut en bas, comme l'historique");
});

test("OVL-6 teinte invalide ou absente: repli sur la teinte historique rgba(23,13,9,…) — jamais de CSS injecté", () => {
  const fallback = "linear-gradient(rgba(23, 13, 9, 0.08), rgba(23, 13, 9, 0.13))";
  for (const bad of [undefined, null, "", "red", "#FFF", "#GGGGGG", "#123456;background:url(x)", "rgb(0,0,0)", "url(x)"]) {
    assert.equal(ov.photoOverlayLayer("light", bad as string | null | undefined), fallback, String(bad));
  }
});

test("OVL-7 l'alpha 'standard' du module reste égal à celui du thème (anti-dérive avec lib/themes.ts)", () => {
  const vars = themeStyle("cafe", undefined);
  const [st, sb] = ov.PHOTO_OVERLAY_ALPHA.standard;
  assert.match(vars["--sc-veil-soft"], new RegExp(`, ${st}\\)$`));
  assert.match(vars["--sc-veil-strong"], new RegExp(`, ${sb}\\)$`));
  // L'aperçu du back-office (valeurs explicites) reproduit la même intensité.
  const resolved = ov.photoOverlayLayerResolved("standard", "#221510")!;
  assert.equal(resolved, `linear-gradient(rgba(34, 21, 16, ${st}), rgba(34, 21, 16, ${sb}))`);
});

test("OVL-8 thème inchangé: aucune variable de thème n'est ajoutée ni retirée par ce lot", () => {
  const keys = Object.keys(themeStyle("cafe", undefined));
  assert.ok(keys.includes("--sc-veil-soft") && keys.includes("--sc-veil-strong"));
  assert.ok(!keys.some((k) => /overlay/i.test(k)), "aucune nouvelle variable liée au voile");
});

/** Code exécutable seul (commentaires retirés) — comme le garde [NO-HARDCODE] existant. */
function executable(file: string): string {
  return readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}

test("OVL-9 configuration GÉNÉRIQUE: aucun nom de marchand dans le code exécutable des fichiers du lot", () => {
  for (const f of [
    "lib/storefront-photo-overlay.ts",
    "components/RestaurantHeader.tsx",
    "components/dashboard/PhotoOverlayField.tsx",
    "app/dashboard/settings/page.tsx",
    "lib/services/dashboard.ts",
  ]) {
    assert.ok(!/au[-_ ]?lait[-_ ]?cru/i.test(executable(f)), `${f} ne doit nommer aucun marchand`);
  }
  assert.ok(!/photo[-_]?overlay/i.test(executable("lib/themes.ts")), "le thème n'est pas touché");
});

test("OVL-10 libellés: les trois valeurs FR exactes du mandat, et des traductions distinctes en en/ar", () => {
  const expectedFr: Record<string, string> = {
    stPhotoOverlay_none: "Aucun assombrissement",
    stPhotoOverlay_light: "Assombrissement léger",
    stPhotoOverlay_standard: "Assombrissement standard",
  };
  for (const [key, fr] of Object.entries(expectedFr)) {
    assert.equal(translate("fr", key), fr);
    for (const lang of ["en", "ar"] as const) {
      const v = translate(lang, key);
      assert.ok(v && v !== key && v !== fr, `${key} traduit en ${lang}`);
    }
  }
  for (const key of ["stPhotoOverlayTitle", "stPhotoOverlayHint", "stPhotoOverlayPreview", "stPhotoOverlayPreviewNote", "stPhotoOverlayUnavailable", "stPhotoOverlaySaveError"]) {
    for (const lang of ["fr", "en", "ar"] as const) {
      const v = translate(lang, key);
      assert.ok(v && v !== key, `${key} (${lang})`);
    }
  }
});

test("OVL-11 SQL: colonne additive, existants = standard, défaut des nouveaux = none, jeu fermé, RPC protégé", () => {
  const sql = readFileSync("supabase/DRAFT-lot-storefront-photo-overlay-v1.sql", "utf8");
  const code = sql.replace(/^\s*--.*$/gm, "");
  assert.ok(/add column storefront_photo_overlay text not null default 'standard'/i.test(code), "existants -> standard");
  assert.ok(/alter column storefront_photo_overlay set default 'none'/i.test(code), "nouveaux -> none");
  assert.ok(/check \(storefront_photo_overlay in \('none', 'light', 'standard'\)\)/i.test(code));
  assert.ok(/perform public\.assert_restaurant_asset_role\(p_restaurant_id\)/.test(code), "même autorité que les autres réglages");
  assert.ok(/revoke all on function public\.update_restaurant_photo_overlay\(uuid, text\) from public, anon/.test(code));
  assert.ok(/grant execute on function public\.update_restaurant_photo_overlay\(uuid, text\) to authenticated/.test(code));
  assert.ok(/set search_path = ''/.test(code), "security definer + search_path vide");
  assert.ok(!/drop\s+(table|column)/i.test(code), "additif: rien n'est supprimé");
  assert.ok(!/au-lait-cru/i.test(code), "le lot ne nomme aucun marchand");
  assert.equal((code.match(/update public\.restaurant_configs/g) ?? []).length, 1, "une seule écriture: celle du RPC");
  assert.ok(/update public\.restaurant_configs\s+set storefront_photo_overlay = p_overlay\s+where restaurant_id = p_restaurant_id/.test(code), "elle ne touche que la colonne du lot, pour le restaurant demandé");
  assert.ok(/begin;[\s\S]*commit;\s*$/i.test(code.trim()), "une seule transaction");
});

test("OVL-12 SQL: la donnée Au Lait Cru est un script SÉPARÉ, une seule ligne, gardé; le lot et le rollback ne la portent pas", () => {
  const data = readFileSync("supabase/DRAFT-data-storefront-photo-overlay-au-lait-cru.sql", "utf8");
  assert.ok(/r\.slug = 'au-lait-cru'/.test(data) && /v_count <> 1/.test(data), "ciblage par slug + garde 1 ligne");
  assert.ok(/set storefront_photo_overlay = 'none'/.test(data));
  for (const f of ["supabase/DRAFT-lot-storefront-photo-overlay-v1.sql", "supabase/DRAFT-lot-storefront-photo-overlay-v1-rollback.sql"]) {
    assert.ok(!/au-lait-cru/i.test(readFileSync(f, "utf8").replace(/^\s*--.*$/gm, "")), `${f} ne nomme aucun marchand dans son code`);
  }
});

test("OVL-13 le rendu public lit le réglage via la lecture existante restaurant_configs(*) — aucune nouvelle requête, aucun SELECT à colonne nommée ajouté", () => {
  const svc = readFileSync("lib/services/restaurant.ts", "utf8");
  assert.ok(/restaurant_configs \( \* \)/.test(svc));
  assert.ok(!svc.includes("storefront_photo_overlay"), "la lecture publique reste générique (colonne absente tolérée)");
  const dash = readFileSync("lib/services/dashboard.ts", "utf8");
  const settingsSelect = dash.match(/"staff_receipt_language, address[^"]*"/)?.[0] ?? "";
  assert.ok(settingsSelect.length > 0 && !settingsSelect.includes("storefront_photo_overlay"), "le SELECT principal des Réglages n'est pas modifié: une colonne absente ne casse pas la page");
});
