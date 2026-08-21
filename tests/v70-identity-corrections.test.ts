import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { isValidMapsUrl } = await import("../lib/maps-url.ts");
const { supabase } = await import("../lib/supabase.ts");

// ====================================================================
// Scanym V70 — corrections ciblées F-01 (Super Admin complet), F-02
// (localisation provider-neutral), F-04 (hardening host/origin
// logo/cover), + fichiers Storage orphelins. Complète (sans les
// réécrire) les migrations V68/V69 déjà livrées : la preuve RLS/RPC
// réelle est apportée par l'extension de
// supabase/tests/v68-storage-policy-check.sh (pas un second harnais),
// pas ici.
// ====================================================================

// --- F-02 : HTTPS strictement obligatoire (déjà couvert en détail
// dans tests/v69-identity-colors-maps.test.ts, revérifié ici au
// niveau de la migration SQL) ---

test("F-02: isValidMapsUrl refuse http://, accepte https:// (aucune restriction de domaine)", () => {
  assert.equal(isValidMapsUrl("https://example.com/x"), true);
  assert.equal(isValidMapsUrl("http://example.com/x"), false);
});

// --- Migration V70 : renommage sûr, hardening host, réutilisation F-01 ---

test("migration V70: renommage google_maps_url -> maps_url idempotent (RENAME si présente, ADD sinon), aucune perte de donnée (pas de DROP COLUMN)", () => {
  const source = readFileSync("supabase/migration-v70-identity-corrections.sql", "utf8");
  assert.ok(source.includes("alter table public.restaurant_configs rename column google_maps_url to maps_url;"));
  assert.ok(source.includes("alter table public.restaurant_configs add column maps_url text;"));
  assert.ok(!/drop column/i.test(source), "aucune colonne ne doit être supprimée par ce correctif");
});

test("migration V70: contrainte CHECK sur maps_url exige HTTPS strictement (http:// refusé, corrige F-02)", () => {
  const source = readFileSync("supabase/migration-v70-identity-corrections.sql", "utf8");
  assert.ok(source.includes("maps_url ~ '^https://'"));
  assert.ok(!source.includes("maps_url ~ '^https?://'"), "l'ancienne règle permissive (http OU https) ne doit plus être utilisée");
});

test("migration V70 (F-01): update_restaurant_colors/update_restaurant_maps_url réutilisent assert_restaurant_asset_role -- plus de logique owner/manager dupliquée, opérateur Scanym désormais autorisé", () => {
  const source = readFileSync("supabase/migration-v70-identity-corrections.sql", "utf8");
  const colorsFn = source.slice(
    source.indexOf("create or replace function public.update_restaurant_colors"),
    source.indexOf("revoke all on function public.update_restaurant_colors")
  );
  const mapsFn = source.slice(
    source.indexOf("create or replace function public.update_restaurant_maps_url"),
    source.indexOf("revoke all on function public.update_restaurant_maps_url")
  );
  for (const fn of [colorsFn, mapsFn]) {
    assert.ok(fn.includes("assert_restaurant_asset_role(p_restaurant_id)"), "doit réutiliser assert_restaurant_asset_role, pas un contrôle owner/manager dupliqué");
    assert.ok(!fn.includes("role = any (array['owner', 'manager'])"), "l'ancien contrôle inline (V69) doit avoir disparu, remplacé par la fonction partagée");
  }
});

test("migration V70 (F-04): assert_establishment_asset_url valide le chemin ET, si configuré, le host via current_setting('app.storage_public_base_url')", () => {
  const source = readFileSync("supabase/migration-v70-identity-corrections.sql", "utf8");
  const fn = source.slice(
    source.indexOf("create function public.assert_establishment_asset_url"),
    source.indexOf("revoke all on function public.assert_establishment_asset_url")
  );
  assert.ok(fn.includes("current_setting('app.storage_public_base_url', true)"));
  assert.ok(fn.includes("/storage/v1/object/public/establishment-assets/"));
  assert.ok(fn.includes("[0-9a-fA-F-]{36}"));
  assert.ok(!/https:\/\/[a-zA-Z0-9.-]+\.supabase\.co/.test(fn), "aucun domaine de production en dur -- doit rester configurable par environnement");
});

test("migration V70: set_restaurant_logo/set_restaurant_cover réutilisent assert_establishment_asset_url (plus de regex dupliquée en ligne)", () => {
  const source = readFileSync("supabase/migration-v70-identity-corrections.sql", "utf8");
  const logoFn = source.slice(source.indexOf("create or replace function public.set_restaurant_logo"), source.indexOf("revoke all on function public.set_restaurant_logo"));
  const coverFn = source.slice(source.indexOf("create or replace function public.set_restaurant_cover"), source.indexOf("revoke all on function public.set_restaurant_cover"));
  assert.ok(logoFn.includes("assert_establishment_asset_url(p_restaurant_id, 'logo', v_url)"));
  assert.ok(coverFn.includes("assert_establishment_asset_url(p_restaurant_id, 'cover', v_url)"));
  assert.ok(!/\^https\?:\/\/\[\^\/\]\+\/storage/.test(logoFn + coverFn), "l'ancienne regex dupliquée (V69) ne doit plus apparaître inline dans ces 2 fonctions");
});

test("migration V70 (F-01): 2 nouvelles policies SELECT opérateur, même patron que 'lecture membre restaurants/configs' (lotd)", () => {
  const source = readFileSync("supabase/migration-v70-identity-corrections.sql", "utf8");
  assert.ok(source.includes('create policy "lecture operateur restaurants"'));
  assert.ok(source.includes('create policy "lecture operateur configs"'));
  const block = source.slice(source.indexOf('create policy "lecture operateur restaurants"'), source.indexOf("commit;"));
  const operatorChecks = (block.match(/using \(public\.is_scanym_operator\(\)\)/g) || []).length;
  assert.equal(operatorChecks, 2);
});

test("migration V70: n'ajoute, ne modifie ni ne supprime aucune policy product_photos_* ni establishment_assets_* (isolation stricte, hors périmètre de ce correctif)", () => {
  const source = readFileSync("supabase/migration-v70-identity-corrections.sql", "utf8");
  const withoutComments = source.replace(/--.*$/gm, "");
  assert.ok(!/product_photos_/.test(withoutComments));
  assert.ok(!/create policy "establishment_assets_/.test(withoutComments));
  assert.ok(!/drop policy "establishment_assets_/.test(withoutComments));
});

test("migration V70: ne modifie ni restaurant_users ni scanym_operators (F-01 étend l'usage d'une fonction déjà existante, ne touche pas au modèle)", () => {
  const source = readFileSync("supabase/migration-v70-identity-corrections.sql", "utf8");
  assert.ok(!/alter table public\.restaurant_users/i.test(source));
  assert.ok(!/alter table public\.scanym_operators/i.test(source));
  assert.ok(!/create table[^;]*scanym_operators/i.test(source));
});

test("migration V70: aucune clé service_role, aucun secret, aucune donnée client en dur", () => {
  const source = readFileSync("supabase/migration-v70-identity-corrections.sql", "utf8");
  assert.ok(!/service_role/.test(source));
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(source));
  assert.ok(!/au lait cru/i.test(source));
});

// --- F-01 : Super Admin réutilise les mêmes services (Dashboard Settings) ---

test("F-01: SettingsPage détecte l'opérateur via isScanymOperator (réutilisé de lib/services/establishments.ts, pas dupliqué)", () => {
  const source = readFileSync("app/dashboard/settings/page.tsx", "utf8");
  assert.ok(source.includes('import { isScanymOperator, getEstablishmentSummary } from "@/lib/services/establishments";'));
  assert.ok(source.includes("isScanymOperator()"));
});

test("F-01: canEdit inclut isOperator -- un opérateur peut modifier même sans rôle owner/manager dans restaurant_users", () => {
  const source = readFileSync("app/dashboard/settings/page.tsx", "utf8");
  // Corrigé V71-06 (contre-audit Work, 2e tour) : canEditFull remplace
  // l'ancien appel direct à canEditProducts(mapping?.role) -- même
  // logique effective (owner/manager uniquement), mais nommée
  // explicitement pour être réutilisée aussi par isOperatorOnlyMode
  // (voir tests/v72-hardening.test.ts).
  assert.ok(source.includes('const canEditFull = mapping?.role === "owner" || mapping?.role === "manager";'));
  assert.ok(source.includes("const canEdit = isOperator || canEditFull;"));
});

test("F-01: un opérateur consultant un établissement hors de ses rattachements (?r=<id>, pas dans mappings) charge quand même cet établissement", () => {
  const source = readFileSync("app/dashboard/settings/page.tsx", "utf8");
  const fn = source.slice(source.indexOf("useEffect(() => {\n    (async () => {"), source.indexOf("[router]);"));
  assert.ok(fn.includes("if (wanted && !match && opFlag)"));
  assert.ok(fn.includes("setRestaurantId(wanted)"));
  assert.ok(fn.includes("getEstablishmentSummary(wanted)"), "réutilise le même service que app/admin/establishments/new pour afficher le nom");
});

test("F-01: la page de création d'établissement (Super Admin) propose un lien direct vers Dashboard Settings pour le nouvel établissement", () => {
  const source = readFileSync("app/admin/establishments/new/page.tsx", "utf8");
  assert.ok(source.includes("`/dashboard/settings?r=${result.restaurantId}`"));
});

// --- lib/types.ts / dashboard.ts déjà revérifiés dans
// tests/v69-identity-colors-maps.test.ts (mis à jour pour maps_url) ---

// --- Fichiers Storage orphelins : le client Supabase ne lève jamais
// d'exception pour un échec Storage (retourne {data,error}) -- le
// try/catch seul ne détectait rien de significatif. Corrigé pour
// inspecter explicitement `error` et le journaliser. ---

test("orphelins: deleteStorageFileBestEffort inspecte explicitement l'erreur renvoyée par .remove() (pas seulement un try/catch qui ne catchait jamais rien de significatif)", () => {
  const source = readFileSync("lib/services/establishment-assets.ts", "utf8");
  const fn = source.slice(
    source.indexOf("async function deleteStorageFileBestEffort"),
    source.indexOf("async function deleteStorageFileBestEffort") + 1200
  );
  assert.ok(fn.includes("const { error } = await supabase.storage.from(BUCKET).remove([path]);"));
  assert.ok(fn.includes("if (error)"));
  assert.ok(fn.includes("console.error"), "un échec de nettoyage (fichier potentiellement orphelin) doit rester observable, jamais totalement silencieux");
});

test("orphelins: le nettoyage reste best-effort -- une erreur de suppression ne doit jamais être re-lancée (le flux utilisateur ne doit jamais être bloqué par un fichier orphelin)", async (t) => {
  t.mock.method(supabase.storage, "from", () => ({
    remove: async () => ({ data: null, error: { message: "simulated storage failure" } }),
  }));
  const { removeEstablishmentAsset } = await import("../lib/services/establishment-assets.ts");
  t.mock.method(supabase, "rpc", async () => ({ data: null, error: null }));

  // Ne doit jamais rejeter, même si le nettoyage Storage échoue :
  await removeEstablishmentAsset(
    "r1",
    "logo",
    "https://fake.supabase.co/storage/v1/object/public/establishment-assets/r1/logo/old.jpg"
  );
});

// --- i18n : symétrie fr/en/ar pour les libellés provider-neutral ---

test("i18n: le libellé du champ localisation n'est plus 'Google Maps' (F-02), présent en fr/en/ar", () => {
  const source = readFileSync("lib/i18n.ts", "utf8");
  assert.ok(source.includes('stMapsTitle: "Lien de localisation / itinéraire",'));
  assert.ok(source.includes('stMapsTitle: "Location / directions link",'));
  assert.ok(!/stMapsTitle: "Google Maps link"/.test(source));
  assert.ok(!/stMapsTitle: "Lien Google Maps"/.test(source));
});

test("i18n: le message d'erreur de validation reflète HTTPS uniquement (fr/en/ar)", () => {
  const source = readFileSync("lib/i18n.ts", "utf8");
  const count = (source.match(/stMapsInvalid: ".*https:\/\/\)"/g) || []).length;
  assert.equal(count, 3, "les 3 langues doivent mentionner https:// uniquement, plus http://");
});
