import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Voir lib/services/product-photo.ts / tests/v67-product-photos.test.ts
// pour la même convention : variables d'environnement fixées AVANT un
// import dynamique (un import statique serait hoisté avant ce code).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const {
  detectImageType,
  validateEstablishmentAssetFile,
  extractStoragePath,
  addOrReplaceEstablishmentAsset,
  removeEstablishmentAsset,
  InvalidFileTypeError,
  FileTooLargeError,
  AssetUploadError,
  AssetRemoveError,
  MAX_FILE_SIZE_BYTES,
} = await import("../lib/services/establishment-assets.ts");
const { supabase } = await import("../lib/supabase.ts");

// ====================================================================
// Identité visuelle établissement (V68) — logo & cover, Supabase
// Storage bucket "establishment-assets" (distinct de "product-photos").
//
// Même limite documentée qu'en V67 : les fonctions qui parlent
// réellement à Supabase (upload/RPC) sont testées par mock (aucun
// appel réseau réel), la validation pure est testée directement.
//
// L'isolation multi-établissement des policies Storage ET
// l'administration cross-établissement par un opérateur Scanym
// (scanym_operators / is_scanym_operator()) sont prouvées par
// exécution réelle contre PostgreSQL local, PAS ici : voir
// supabase/tests/v68-storage-policy-check.sh et son journal
// supabase/tests/v68-storage-policy-check-log-sample.txt.
// ====================================================================

function newBytes(size: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(size));
}

function jpegBytes(size = 100): Uint8Array<ArrayBuffer> {
  const b = newBytes(size);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff;
  return b;
}
function pngBytes(size = 100): Uint8Array<ArrayBuffer> {
  const b = newBytes(size);
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47;
  return b;
}
function webpBytes(size = 100): Uint8Array<ArrayBuffer> {
  const b = newBytes(size);
  b[0] = 0x52; b[1] = 0x49; b[2] = 0x46; b[3] = 0x46;
  b[8] = 0x57; b[9] = 0x45; b[10] = 0x42; b[11] = 0x50;
  return b;
}
function textBytes(size = 100): Uint8Array<ArrayBuffer> {
  return newBytes(size).fill(0x41);
}

function fileOf(bytes: Uint8Array<ArrayBuffer>, name: string, mime: string): File {
  return new File([bytes], name, { type: mime });
}

// --- 1. Détection réelle (signature binaire) ---

test("établissement asset: JPEG valide détecté par signature binaire (pas par l'extension)", async () => {
  const f = fileOf(jpegBytes(), "logo.png", "image/png");
  const detected = await detectImageType(f);
  assert.deepEqual(detected, { mime: "image/jpeg", ext: "jpg" });
});

test("établissement asset: PNG valide détecté par signature binaire", async () => {
  const f = fileOf(pngBytes(), "cover.jpg", "image/jpeg");
  const detected = await detectImageType(f);
  assert.deepEqual(detected, { mime: "image/png", ext: "png" });
});

test("établissement asset: WEBP valide détecté par signature binaire", async () => {
  const f = fileOf(webpBytes(), "cover", "");
  const detected = await detectImageType(f);
  assert.deepEqual(detected, { mime: "image/webp", ext: "webp" });
});

test("établissement asset: fichier non-image avec extension/MIME falsifiés (scénario 6) -- rejeté", async () => {
  const f = fileOf(textBytes(), "malware.png", "image/png");
  const detected = await detectImageType(f);
  assert.equal(detected, null);
});

// --- 2. Validation taille (scénario 5) + type (scénario 6) ---

test("établissement asset: upload valide (PNG, taille normale) accepté", async () => {
  const f = fileOf(pngBytes(1024), "logo.png", "image/png");
  const result = await validateEstablishmentAssetFile(f);
  assert.deepEqual(result, { mime: "image/png", ext: "png" });
});

test("établissement asset (scénario 6): type de fichier non autorisé -- InvalidFileTypeError", async () => {
  const f = fileOf(textBytes(), "document.pdf", "application/pdf");
  await assert.rejects(() => validateEstablishmentAssetFile(f), InvalidFileTypeError);
});

test("établissement asset (scénario 5): fichier > 5 Mo -- FileTooLargeError", async () => {
  const f = fileOf(jpegBytes(10), "logo.jpg", "image/jpeg");
  Object.defineProperty(f, "size", { value: MAX_FILE_SIZE_BYTES + 1 });
  await assert.rejects(() => validateEstablishmentAssetFile(f), FileTooLargeError);
});

test("établissement asset: taille exactement à la limite -- acceptée (limite inclusive)", async () => {
  const f = fileOf(jpegBytes(10), "logo.jpg", "image/jpeg");
  Object.defineProperty(f, "size", { value: MAX_FILE_SIZE_BYTES });
  const result = await validateEstablishmentAssetFile(f);
  assert.deepEqual(result, { mime: "image/jpeg", ext: "jpg" });
});

// --- 3. Chemin de stockage : {restaurant_id}/{logo|cover}/{fichier} ---

test("établissement asset: le chemin de stockage inclut le segment 'logo' ou 'cover' (portée établissement, pas produit)", async (t) => {
  const captured: { path?: string } = {};
  t.mock.method(supabase.storage, "from", () => ({
    upload: async (path: string) => {
      captured.path = path;
      return { data: { path }, error: null };
    },
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://fake.supabase.co/storage/v1/object/public/establishment-assets/${path}` } }),
  }));
  t.mock.method(supabase, "rpc", async () => ({ data: null, error: null }));

  const f = fileOf(jpegBytes(1024), "logo.jpg", "image/jpeg");
  await addOrReplaceEstablishmentAsset("r1", "logo", f, null);

  assert.ok(captured.path?.startsWith("r1/logo/"), `le chemin doit commencer par "r1/logo/", reçu: ${captured.path}`);
});

test("établissement asset: deux uploads successifs du même fichier produisent des chemins DIFFÉRENTS (nom généré, jamais file.name)", () => {
  const source = readFileSync("lib/services/establishment-assets.ts", "utf8");
  assert.ok(source.includes("crypto.randomUUID()"));
  assert.ok(!/file\.name/.test(source), "file.name ne doit jamais entrer dans le chemin de stockage");
});

// --- 4. RPC dédiée par type d'asset (scénarios 7/8) ---

test("établissement asset (scénario 7): addOrReplaceEstablishmentAsset('logo', ...) appelle setRestaurantLogo (RPC set_restaurant_logo), pas setRestaurantCover", async (t) => {
  const rpcCalls: { name: string; params: unknown }[] = [];
  t.mock.method(supabase.storage, "from", () => ({
    upload: async (path: string) => ({ data: { path }, error: null }),
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://fake.supabase.co/storage/v1/object/public/establishment-assets/${path}` } }),
  }));
  t.mock.method(supabase, "rpc", async (name: string, params: unknown) => {
    rpcCalls.push({ name, params });
    return { data: null, error: null };
  });

  const f = fileOf(jpegBytes(1024), "logo.jpg", "image/jpeg");
  const newUrl = await addOrReplaceEstablishmentAsset("r1", "logo", f, null);

  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, "set_restaurant_logo");
  assert.deepEqual(rpcCalls[0].params, { p_restaurant_id: "r1", p_url: newUrl });
});

test("établissement asset (scénario 8): addOrReplaceEstablishmentAsset('cover', ...) appelle setRestaurantCover (RPC set_restaurant_cover)", async (t) => {
  const rpcCalls: { name: string; params: unknown }[] = [];
  t.mock.method(supabase.storage, "from", () => ({
    upload: async (path: string) => ({ data: { path }, error: null }),
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://fake.supabase.co/storage/v1/object/public/establishment-assets/${path}` } }),
  }));
  t.mock.method(supabase, "rpc", async (name: string, params: unknown) => {
    rpcCalls.push({ name, params });
    return { data: null, error: null };
  });

  const f = fileOf(pngBytes(1024), "cover.png", "image/png");
  const newUrl = await addOrReplaceEstablishmentAsset("r1", "cover", f, null);

  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, "set_restaurant_cover");
  assert.deepEqual(rpcCalls[0].params, { p_restaurant_id: "r1", p_url: newUrl });
});

// --- 5. Échecs typés (scénario 9 : un échec n'écrase jamais l'ancienne URL) ---

test("établissement asset (scénario 9): échec RPC lors d'un remplacement -- AssetUploadError, le nouvel upload est nettoyé (rollback), l'ancienne URL reste inchangée côté appelant", async (t) => {
  const removed: string[] = [];
  t.mock.method(supabase.storage, "from", () => ({
    upload: async (path: string) => ({ data: { path }, error: null }),
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://fake.supabase.co/storage/v1/object/public/establishment-assets/${path}` } }),
    remove: async (paths: string[]) => {
      removed.push(...paths);
      return { data: null, error: null };
    },
  }));
  const technicalMessage = "permission denied for table restaurant_configs";
  t.mock.method(supabase, "rpc", async () => ({ data: null, error: { message: technicalMessage } }));

  const previousUrl = "https://fake.supabase.co/storage/v1/object/public/establishment-assets/r1/logo/old.jpg";
  const f = fileOf(jpegBytes(1024), "logo.jpg", "image/jpeg");
  await assert.rejects(
    () => addOrReplaceEstablishmentAsset("r1", "logo", f, previousUrl),
    (e: unknown) => {
      assert.ok(e instanceof AssetUploadError);
      assert.notEqual((e as Error).message, technicalMessage, "le message principal ne doit jamais être le message technique brut");
      assert.ok(String((e as Error).cause).includes(technicalMessage));
      return true;
    }
  );
  assert.ok(
    removed.some((p) => p.startsWith("r1/logo/") && p !== "r1/logo/old.jpg"),
    "le fichier tout juste uploadé doit être nettoyé (rollback) en cas d'échec RPC"
  );
  assert.ok(!removed.includes("r1/logo/old.jpg"), "l'ancien fichier ne doit JAMAIS être supprimé quand le nouvel upload échoue");
});

test("établissement asset (scénario 9): échec Storage lors d'un ajout -- AssetUploadError également", async (t) => {
  const technicalMessage = "The resource already exists";
  t.mock.method(supabase.storage, "from", () => ({
    upload: async () => ({ data: null, error: { message: technicalMessage } }),
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://fake.supabase.co/storage/v1/object/public/establishment-assets/${path}` } }),
  }));

  const f = fileOf(pngBytes(1024), "cover.png", "image/png");
  await assert.rejects(
    () => addOrReplaceEstablishmentAsset("r1", "cover", f, null),
    (e: unknown) => {
      assert.ok(e instanceof AssetUploadError);
      assert.notEqual((e as Error).message, technicalMessage);
      return true;
    }
  );
});

test("établissement asset (scénario 10): removeEstablishmentAsset -- échec RPC -- AssetRemoveError, message technique préservé dans .cause", async (t) => {
  const technicalMessage = "connection timeout";
  t.mock.method(supabase, "rpc", async () => ({ data: null, error: { message: technicalMessage } }));

  await assert.rejects(
    () => removeEstablishmentAsset("r1", "cover", "https://fake.supabase.co/storage/v1/object/public/establishment-assets/r1/cover/old.jpg"),
    (e: unknown) => {
      assert.ok(e instanceof AssetRemoveError);
      assert.notEqual((e as Error).message, technicalMessage);
      assert.ok(String((e as Error).cause).includes(technicalMessage));
      return true;
    }
  );
});

test("établissement asset (scénario 10): removeEstablishmentAsset('logo', ...) appelle set_restaurant_logo avec p_url: null (reset explicite)", async (t) => {
  const rpcCalls: { name: string; params: unknown }[] = [];
  t.mock.method(supabase, "rpc", async (name: string, params: unknown) => {
    rpcCalls.push({ name, params });
    return { data: null, error: null };
  });
  t.mock.method(supabase.storage, "from", () => ({
    remove: async () => ({ data: null, error: null }),
  }));

  await removeEstablishmentAsset("r1", "logo", "https://fake.supabase.co/storage/v1/object/public/establishment-assets/r1/logo/old.jpg");

  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, "set_restaurant_logo");
  assert.deepEqual(rpcCalls[0].params, { p_restaurant_id: "r1", p_url: null });
});

// --- 6. Extraction de chemin ---

test("établissement asset: extractStoragePath -- URL publique du bucket establishment-assets, chemin extrait correctement", () => {
  const url = "https://xxxx.supabase.co/storage/v1/object/public/establishment-assets/r1/cover/abc123.jpg";
  assert.equal(extractStoragePath(url), "r1/cover/abc123.jpg");
});

test("établissement asset: extractStoragePath -- null si aucune URL, ou hors du bucket establishment-assets", () => {
  assert.equal(extractStoragePath(null), null);
  assert.equal(extractStoragePath("https://xxxx.supabase.co/storage/v1/object/public/product-photos/r1/p1/x.jpg"), null);
});

// --- 7. Ordre des opérations (structurel, même limite qu'en V67) ---

test("établissement asset: remplacement -- upload AVANT la RPC, rollback du nouvel upload si la RPC échoue, ancien fichier nettoyé SEULEMENT après succès", () => {
  const source = readFileSync("lib/services/establishment-assets.ts", "utf8");
  const fn = source.slice(
    source.indexOf("export async function addOrReplaceEstablishmentAsset"),
    source.indexOf("export async function removeEstablishmentAsset")
  );
  const uploadIdx = fn.indexOf(".upload(");
  const persistIdx = fn.indexOf("persistAssetUrl(restaurantId, kind, newUrl)");
  const rollbackIdx = fn.indexOf("deleteStorageFileBestEffort(newUrl)");
  const oldCleanupIdx = fn.indexOf("deleteStorageFileBestEffort(previousUrl)");

  assert.ok(uploadIdx >= 0 && persistIdx > uploadIdx, "l'upload doit précéder l'appel RPC");
  assert.ok(fn.includes("try {") && fn.includes("} catch (e) {"));
  assert.ok(rollbackIdx > persistIdx, "en cas d'échec RPC, le nouvel upload doit être nettoyé (rollback)");
  assert.ok(oldCleanupIdx > persistIdx, "l'ANCIEN fichier n'est nettoyé qu'après le succès de la RPC");
});

test("établissement asset: suppression -- RPC (DB) AVANT la suppression Storage, jamais l'inverse", () => {
  const source = readFileSync("lib/services/establishment-assets.ts", "utf8");
  const fn = source.slice(source.indexOf("export async function removeEstablishmentAsset"));
  const rpcIdx = fn.indexOf("persistAssetUrl(restaurantId, kind, null)");
  const storageDeleteIdx = fn.indexOf("deleteStorageFileBestEffort(currentUrl)");
  assert.ok(rpcIdx >= 0 && storageDeleteIdx > rpcIdx);
});

// --- 8. Absence de régression : dashboard.ts expose logo_url/cover_url + les 2 RPC ---

test("établissement: getRestaurantSettings/RestaurantSettingsRow exposent logo_url et cover_url", () => {
  const source = readFileSync("lib/services/dashboard.ts", "utf8");
  assert.ok(/logo_url:\s*string \| null;/.test(source));
  assert.ok(/cover_url:\s*string \| null;/.test(source));
  assert.ok(source.includes("logo_url, cover_url"), "le select() de getRestaurantSettings doit inclure logo_url et cover_url");
});

test("établissement: setRestaurantLogo/setRestaurantCover appellent leur RPC dédiée, jamais d'écriture directe sur restaurant_configs", () => {
  const source = readFileSync("lib/services/dashboard.ts", "utf8");
  const logoFn = source.slice(source.indexOf("export async function setRestaurantLogo"), source.indexOf("export async function setRestaurantCover"));
  const coverFn = source.slice(source.indexOf("export async function setRestaurantCover"));
  assert.ok(logoFn.includes('"set_restaurant_logo"'));
  assert.ok(coverFn.includes('"set_restaurant_cover"'));
  assert.ok(!/\.from\("restaurant_configs"\)\.update/.test(logoFn + coverFn), "aucune écriture directe sur restaurant_configs -- doit passer par la RPC");
});

// --- 9. Migration SQL : bucket distinct, policies dédiées, opérateur Scanym, rôle ---

test("migration V68: bucket establishment-assets DISTINCT de product-photos, public en lecture", () => {
  const source = readFileSync("supabase/migration-v68-establishment-assets.sql", "utf8");
  assert.ok(source.includes("'establishment-assets',\n  'establishment-assets',\n  true,"));
  assert.ok(!source.includes("bucket_id = 'product-photos'"), "la migration V68 ne doit toucher aucune policy du bucket product-photos");
});

test("migration V68: n'ajoute, ne modifie ni ne supprime aucune policy product_photos_* (isolation stricte des deux périmètres)", () => {
  const source = readFileSync("supabase/migration-v68-establishment-assets.sql", "utf8");
  assert.ok(!/product_photos_/.test(source.replace(/--.*$/gm, "")), "aucune référence active à une policy product_photos_* dans le SQL exécutable");
});

test("migration V68: 4 policies dédiées establishment_assets_*, valident le format UUID du 1er segment de chemin", () => {
  const source = readFileSync("supabase/migration-v68-establishment-assets.sql", "utf8");
  for (const name of ["select", "insert", "update", "delete"]) {
    assert.ok(source.includes(`create policy "establishment_assets_${name}_authorized"`), `policy establishment_assets_${name}_authorized manquante`);
  }
  const occurrences = (source.match(/\^\[0-9a-fA-F-\]\{36\}\$/g) || []).length;
  assert.ok(occurrences >= 4);
});

test("migration V68 (scénario 3): chaque policy autorise soit owner/manager du restaurant du chemin, soit is_scanym_operator() -- administration cross-établissement", () => {
  const source = readFileSync("supabase/migration-v68-establishment-assets.sql", "utf8");
  const policiesBlock = source.slice(
    source.indexOf('create policy "establishment_assets_select_authorized"'),
    source.indexOf("-- 2d. assert_restaurant_asset_role")
  );
  const operatorChecks = (policiesBlock.match(/public\.is_scanym_operator\(\)/g) || []).length;
  const roleChecks = (policiesBlock.match(/role = any \(array\['owner','manager'\]\)/g) || []).length;
  assert.equal(operatorChecks, 5, "select/insert/delete (1 chacune) + update (using + with check) = 5");
  assert.equal(roleChecks, 5);
  assert.ok(!policiesBlock.includes("'staff'"), "aucune policy ne doit autoriser staff");
});

test("migration V68: aucune policy directe créée sur scanym_operators (modèle inchangé, accès exclusivement via is_scanym_operator())", () => {
  const source = readFileSync("supabase/migration-v68-establishment-assets.sql", "utf8");
  assert.ok(!/create policy[^;]*scanym_operators/i.test(source));
  assert.ok(!/create table[^;]*scanym_operators/i.test(source), "scanym_operators ne doit pas être (re)créée par V68");
  assert.ok(!/alter table public\.scanym_operators/i.test(source), "le modèle scanym_operators ne doit pas être modifié par V68");
});

test("migration V68: écriture non publique (aucune policy 'to anon' ou 'to public')", () => {
  const source = readFileSync("supabase/migration-v68-establishment-assets.sql", "utf8");
  const policiesBlock = source.slice(source.indexOf('create policy "establishment_assets_select_authorized"'));
  assert.ok(!/to\s+anon/i.test(policiesBlock));
  assert.ok(!/to\s+public\b/i.test(policiesBlock));
});

test("migration V68: cover_url additive/nullable, logo_url jamais renommée ni retirée", () => {
  const source = readFileSync("supabase/migration-v68-establishment-assets.sql", "utf8");
  assert.ok(source.includes("add column if not exists cover_url text;"));
  assert.ok(!/drop column/i.test(source));
  assert.ok(!/rename column/i.test(source));
  assert.ok(!/logo_url\s+text/.test(source.replace(/comment on column[\s\S]*?;/g, "")), "logo_url ne doit pas être (re)définie par V68 -- colonne déjà existante, inchangée");
});

test("migration V68: set_restaurant_logo/set_restaurant_cover réutilisent assert_restaurant_asset_role, jamais staff, une seule colonne en dur chacune", () => {
  const source = readFileSync("supabase/migration-v68-establishment-assets.sql", "utf8");
  const logoFn = source.slice(source.indexOf("create function public.set_restaurant_logo"), source.indexOf("revoke all on function public.set_restaurant_logo"));
  const coverFn = source.slice(source.indexOf("create function public.set_restaurant_cover"), source.indexOf("revoke all on function public.set_restaurant_cover"));
  assert.ok(logoFn.includes("assert_restaurant_asset_role(p_restaurant_id)"));
  assert.ok(coverFn.includes("assert_restaurant_asset_role(p_restaurant_id)"));
  assert.ok(logoFn.includes("set logo_url = v_url") && !logoFn.includes("cover_url ="));
  assert.ok(coverFn.includes("set cover_url = v_url") && !coverFn.includes("logo_url ="));
  assert.ok(!logoFn.includes("'staff'") && !coverFn.includes("'staff'"));
});

test("migration V68 (scénario 3): assert_restaurant_asset_role autorise owner/manager du restaurant OU un opérateur Scanym", () => {
  const source = readFileSync("supabase/migration-v68-establishment-assets.sql", "utf8");
  const fn = source.slice(
    source.indexOf("create function public.assert_restaurant_asset_role"),
    source.indexOf("revoke all on function public.assert_restaurant_asset_role")
  );
  assert.ok(fn.includes("role = any (array['owner','manager'])"));
  assert.ok(fn.includes("public.is_scanym_operator()"));
});

test("migration V68 (scénario 4): aucune écriture 'to authenticated' générale sans condition -- pas d'accès anonyme en écriture (grant execute réservé authenticated pour les RPC, jamais anon)", () => {
  const source = readFileSync("supabase/migration-v68-establishment-assets.sql", "utf8");
  assert.ok(!/grant execute[^;]*to anon/i.test(source));
  assert.ok(source.includes("grant execute on function public.set_restaurant_logo(uuid, text) to authenticated;"));
  assert.ok(source.includes("grant execute on function public.set_restaurant_cover(uuid, text) to authenticated;"));
});

test("migration V68: aucune clé service_role, aucun secret dans le fichier de migration", () => {
  const source = readFileSync("supabase/migration-v68-establishment-assets.sql", "utf8");
  assert.ok(!/service_role/.test(source));
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(source));
});

test("migration V68: aucune donnée client (pas de mention 'Au Lait Cru' ni de logique spécifique à un établissement précis)", () => {
  const source = readFileSync("supabase/migration-v68-establishment-assets.sql", "utf8");
  assert.ok(!/au lait cru/i.test(source));
  assert.ok(!/where restaurant_id = '[0-9a-f-]{36}'/i.test(source), "aucun restaurant_id en dur");
});

// --- 10. Public : cover_url utilisée quand présente, repli inchangé sinon (scénarios 11/12/13) ---

test("public menu (scénario 11/12): RestaurantHeader utilise config.cover_url en priorité, repli sur /banners/<slug>.jpg si absente", () => {
  const source = readFileSync("components/RestaurantHeader.tsx", "utf8");
  assert.ok(source.includes("config.cover_url"));
  assert.ok(source.includes("/banners/${banner ?? restaurant.slug}.jpg"), "le repli existant doit rester présent, inchangé, pour scénario 12 (aucune régression)");
});

test("public menu (scénario 13): RestaurantConfig.cover_url est optionnel/nullable -- un établissement existant sans cette colonne renseignée reste fonctionnel sans migration de données", () => {
  const source = readFileSync("lib/types.ts", "utf8");
  assert.ok(/cover_url\?:\s*string \| null;/.test(source));
  assert.ok(/logo_url:\s*string \| null;/.test(source), "logo_url doit rester inchangée (toujours présente, non optionnelle)");
});

// --- 11. i18n ---

test("établissement identité: toutes les nouvelles clés i18n existent en fr/en/ar et diffèrent entre langues", () => {
  const source = readFileSync("lib/i18n.ts", "utf8");
  const keys = [
    "stIdentityTitle", "stIdentityHint", "stLogoTitle", "stLogoNone", "stLogoChange",
    "stCoverTitle", "stCoverNone", "stCoverChange", "stAssetPreviewAlt", "stAssetSaving",
    "stAssetRemove", "stAssetInvalidType", "stAssetTooLarge", "stAssetUploadError", "stAssetRemoveError",
  ];
  for (const key of keys) {
    const count = (source.match(new RegExp(`\\b${key}:`, "g")) || []).length;
    assert.equal(count, 3, `${key} doit être défini exactement 3 fois (fr, en, ar)`);
  }
});

// --- 12. UI dashboard : preview avant sauvegarde, suppression conditionnée, anti double-soumission ---

test("dashboard settings: AssetField affiche un aperçu local (URL.createObjectURL) et exige une confirmation explicite (mcSave) avant tout upload réel", () => {
  const source = readFileSync("app/dashboard/settings/page.tsx", "utf8");
  const fieldFn = source.slice(source.indexOf("function AssetField"));
  assert.ok(fieldFn.includes("URL.createObjectURL(file)"), "un aperçu local doit être créé avant tout appel réseau");
  assert.ok(fieldFn.includes("confirmUpload"), "l'upload réel doit être déclenché par une action de confirmation distincte");
  assert.ok(fieldFn.includes('accept="image/jpeg,image/png,image/webp"'));
});

test("dashboard settings: le champ fichier et les boutons sont désactivés pendant l'upload (anti double-soumission)", () => {
  const source = readFileSync("app/dashboard/settings/page.tsx", "utf8");
  const fieldFn = source.slice(source.indexOf("function AssetField"));
  assert.ok(fieldFn.includes("disabled={disabled || busy}"));
  assert.ok(/e\.target\.value = ""/.test(fieldFn));
});

test("dashboard settings: le bouton Supprimer n'apparaît que si un asset existe déjà (currentUrl)", () => {
  const source = readFileSync("app/dashboard/settings/page.tsx", "utf8");
  const fieldFn = source.slice(source.indexOf("function AssetField"));
  assert.ok(/\{currentUrl && \(/.test(fieldFn));
});

test("dashboard settings: les boutons internes à AssetField sont type=\"button\" (jamais 'submit', pour ne pas déclencher accidentellement le formulaire Paramètres englobant)", () => {
  const source = readFileSync("app/dashboard/settings/page.tsx", "utf8");
  const fieldFn = source.slice(source.indexOf("function AssetField"));
  const buttonBlocks = fieldFn.match(/<button[\s\S]*?>/g) || [];
  assert.ok(buttonBlocks.length >= 3, "au moins Supprimer, Enregistrer, Annuler");
  for (const block of buttonBlocks) {
    assert.ok(block.includes('type="button"'), `bouton sans type="button" explicite dans AssetField: ${block}`);
  }
});

test("dashboard settings: SettingsPage charge et transmet logo_url/cover_url à AssetField", () => {
  const source = readFileSync("app/dashboard/settings/page.tsx", "utf8");
  assert.ok(source.includes("setLogoUrl(s.logo_url ?? null)"));
  assert.ok(source.includes("setCoverUrl(s.cover_url ?? null)"));
  assert.ok(source.includes('kind="logo"'));
  assert.ok(source.includes('kind="cover"'));
});
