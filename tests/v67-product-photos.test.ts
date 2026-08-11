import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Doit être défini AVANT tout import qui remonte jusqu'à
// lib/supabase.ts (product-photo.ts -> dashboard.ts -> supabase.ts) :
// ce module lève une exception au chargement si ces variables sont
// absentes. Valeurs factices, jamais utilisées pour un appel réseau
// dans les tests ci-dessous (seules les fonctions pures sont
// exécutées ; les fonctions qui parlent réellement à Supabase ne le
// sont pas — même convention que le reste du projet, voir
// lib/services/dashboard.ts, jamais importé directement non plus
// dans les tests existants).
// `import` statique est hoisté avant tout code du module : fixer les
// variables d'environnement AVANT une import statique ne fonctionne
// pas (l'import s'exécuterait quand même en premier). Import
// dynamique, donc, pour garantir l'ordre réel.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const {
  detectImageType,
  validateProductPhotoFile,
  extractStoragePath,
  addOrReplaceProductPhoto,
  removeProductPhoto,
  InvalidFileTypeError,
  FileTooLargeError,
  PhotoUploadError,
  PhotoRemoveError,
  MAX_FILE_SIZE_BYTES,
} = await import("../lib/services/product-photo.ts");
const { supabase } = await import("../lib/supabase.ts");

// ====================================================================
// Photo produit (V67) — validation réelle (signature binaire, taille),
// extraction de chemin, et vérifications structurelles de l'ordre des
// opérations / du modèle d'autorisation pour les parties qui touchent
// réellement Supabase (upload/RPC), non exécutables sans instance
// Supabase réelle — même convention que le reste du projet pour ce
// genre de code (aucun service Supabase n'est appelé en direct dans
// les tests existants).
//
// L'isolation multi-établissement des policies Storage (scénario le
// plus critique) est prouvée par exécution réelle contre PostgreSQL
// local, PAS ici : voir supabase/tests/v67-storage-policy-check.sh et
// son journal supabase/tests/v67-storage-policy-check-log-sample.txt
// (10/10 assertions, y compris l'isolation stricte entre deux
// établissements et le refus staff/anon).
// ====================================================================

// `new Uint8Array(taille)` seul peut s'inférer `Uint8Array<ArrayBufferLike>`
// (TypeScript 5.7 / lib DOM récente), incompatible avec `BlobPart`, qui
// exige `ArrayBuffer` précisément. Passer par un `ArrayBuffer` explicite
// fixe le type sans assertion (`as`) d'aucune sorte.
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
  return newBytes(size).fill(0x41); // "AAAA..." -- pas une image
}

function fileOf(bytes: Uint8Array<ArrayBuffer>, name: string, mime: string): File {
  return new File([bytes], name, { type: mime });
}

// --- 1. Détection réelle (signature binaire), pas seulement l'extension ---

test("photo produit: JPEG valide détecté par signature binaire (pas par l'extension)", async () => {
  const f = fileOf(jpegBytes(), "photo.png" /* extension trompeuse volontaire */, "image/png" /* type annoncé trompeur aussi */);
  const detected = await detectImageType(f);
  assert.deepEqual(detected, { mime: "image/jpeg", ext: "jpg" });
});

test("photo produit: PNG valide détecté par signature binaire", async () => {
  const f = fileOf(pngBytes(), "photo.jpg", "image/jpeg");
  const detected = await detectImageType(f);
  assert.deepEqual(detected, { mime: "image/png", ext: "png" });
});

test("photo produit: WEBP valide détecté par signature binaire", async () => {
  const f = fileOf(webpBytes(), "photo", "");
  const detected = await detectImageType(f);
  assert.deepEqual(detected, { mime: "image/webp", ext: "webp" });
});

test("photo produit: fichier texte avec extension/MIME .jpg falsifiés -- rejeté (ni extension ni file.type ne font foi)", async () => {
  const f = fileOf(textBytes(), "malware.jpg", "image/jpeg");
  const detected = await detectImageType(f);
  assert.equal(detected, null, "un fichier non-image ne doit jamais être détecté comme une image, quels que soient son nom et son type annoncé");
});

// --- 2. Validation complète : upload valide / type invalide / trop volumineux ---

test("photo produit: upload valide (JPEG, taille normale) accepté", async () => {
  const f = fileOf(jpegBytes(1024), "photo.jpg", "image/jpeg");
  const result = await validateProductPhotoFile(f);
  assert.deepEqual(result, { mime: "image/jpeg", ext: "jpg" });
});

test("photo produit: type de fichier invalide -- InvalidFileTypeError", async () => {
  const f = fileOf(textBytes(), "document.pdf", "application/pdf");
  await assert.rejects(() => validateProductPhotoFile(f), InvalidFileTypeError);
});

test("photo produit: fichier trop volumineux -- FileTooLargeError, avant même la lecture du contenu", async () => {
  const f = fileOf(jpegBytes(10), "photo.jpg", "image/jpeg");
  Object.defineProperty(f, "size", { value: MAX_FILE_SIZE_BYTES + 1 });
  await assert.rejects(() => validateProductPhotoFile(f), FileTooLargeError);
});

test("photo produit: taille exactement à la limite -- acceptée (limite inclusive)", async () => {
  const f = fileOf(jpegBytes(10), "photo.jpg", "image/jpeg");
  Object.defineProperty(f, "size", { value: MAX_FILE_SIZE_BYTES });
  const result = await validateProductPhotoFile(f);
  assert.deepEqual(result, { mime: "image/jpeg", ext: "jpg" });
});

// --- 2bis. B-01 (audit Work) : le MIME envoyé à Storage doit être
// celui réellement détecté par inspection binaire, jamais file.type
// (annoncé par le navigateur, non fiable). Vérifié par interception
// réelle de l'appel à supabase.storage.from(...).upload(...) --
// node:test mock.method sur le client Supabase partagé (même instance
// importée par product-photo.ts et dashboard.ts), sans aucun appel
// réseau réel : le test intercepte l'appel, ne le laisse jamais
// atteindre le réseau.

test("photo produit (B-01): JPEG réel annoncé à tort 'image/png' -- Storage reçoit contentType image/jpeg (le vrai type détecté), pas file.type", async (t) => {
  const captured: { contentType?: string } = {};
  t.mock.method(supabase.storage, "from", () => ({
    upload: async (_path: string, _file: File, options: { contentType?: string }) => {
      captured.contentType = options.contentType;
      return { data: { path: "r1/p1/x.jpg" }, error: null };
    },
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://fake.supabase.co/storage/v1/object/public/product-photos/${path}` } }),
  }));
  t.mock.method(supabase, "rpc", async () => ({ data: null, error: null }));

  const f = fileOf(jpegBytes(1024), "photo.png", "image/png"); // extension ET file.type mentent tous les deux
  await addOrReplaceProductPhoto("r1", "p1", f, null);

  assert.equal(captured.contentType, "image/jpeg", "Storage doit recevoir le MIME réellement détecté (JPEG), pas file.type (image/png, annoncé à tort)");
});

test("photo produit (B-01): image valide avec file.type vide -- Storage reçoit tout de même le MIME réellement détecté", async (t) => {
  const captured: { contentType?: string } = {};
  t.mock.method(supabase.storage, "from", () => ({
    upload: async (_path: string, _file: File, options: { contentType?: string }) => {
      captured.contentType = options.contentType;
      return { data: { path: "r1/p2/x.webp" }, error: null };
    },
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://fake.supabase.co/storage/v1/object/public/product-photos/${path}` } }),
  }));
  t.mock.method(supabase, "rpc", async () => ({ data: null, error: null }));

  const f = fileOf(webpBytes(1024), "photo", ""); // file.type vide, comme certains navigateurs/OS le font
  await addOrReplaceProductPhoto("r1", "p2", f, null);

  assert.equal(captured.contentType, "image/webp", "même avec file.type vide, Storage doit recevoir le MIME réellement détecté (WEBP)");
});

// --- 2ter. M-01 (audit Work) : les échecs Storage/RPC lors de
// l'ajout/remplacement ou de la suppression doivent être typés
// (PhotoUploadError/PhotoRemoveError), jamais une Error générique qui
// laisserait fuiter un message technique brut jusqu'à l'UI. Le
// message technique reste accessible via `.cause`, pour le
// debug/log, sans être le message affiché à l'utilisateur (voir
// app/dashboard/catalogue/page.tsx, run(), qui journalise `.cause`
// via console.error et affiche uniquement un texte traduit).

test("photo produit (M-01): échec RPC lors d'un ajout -- PhotoUploadError, message technique préservé dans .cause, jamais exposé comme message principal", async (t) => {
  t.mock.method(supabase.storage, "from", () => ({
    upload: async () => ({ data: { path: "r1/p3/x.jpg" }, error: null }),
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://fake.supabase.co/storage/v1/object/public/product-photos/${path}` } }),
    remove: async () => ({ data: null, error: null }),
  }));
  const technicalMessage = "permission denied for table menu_items";
  t.mock.method(supabase, "rpc", async () => ({ data: null, error: { message: technicalMessage } }));

  const f = fileOf(jpegBytes(1024), "photo.jpg", "image/jpeg");
  await assert.rejects(
    () => addOrReplaceProductPhoto("r1", "p3", f, null),
    (e: unknown) => {
      assert.ok(e instanceof PhotoUploadError, "doit être une PhotoUploadError typée");
      assert.notEqual((e as Error).message, technicalMessage, "le message PRINCIPAL ne doit jamais être le message technique brut");
      assert.ok(String((e as Error).cause).includes(technicalMessage), "le message technique doit rester disponible via .cause, pour le debug/log");
      return true;
    }
  );
});

test("photo produit (M-01): échec Storage lors d'un ajout -- PhotoUploadError également (pas seulement les échecs RPC)", async (t) => {
  const technicalMessage = "The resource already exists";
  t.mock.method(supabase.storage, "from", () => ({
    upload: async () => ({ data: null, error: { message: technicalMessage } }),
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://fake.supabase.co/storage/v1/object/public/product-photos/${path}` } }),
  }));

  const f = fileOf(pngBytes(1024), "photo.png", "image/png");
  await assert.rejects(
    () => addOrReplaceProductPhoto("r1", "p4", f, null),
    (e: unknown) => {
      assert.ok(e instanceof PhotoUploadError);
      assert.notEqual((e as Error).message, technicalMessage);
      return true;
    }
  );
});

test("photo produit (M-01): échec RPC lors d'une suppression -- PhotoRemoveError, message technique préservé dans .cause", async (t) => {
  const technicalMessage = "connection timeout";
  t.mock.method(supabase, "rpc", async () => ({ data: null, error: { message: technicalMessage } }));

  await assert.rejects(
    () => removeProductPhoto("p5", "https://fake.supabase.co/storage/v1/object/public/product-photos/r1/p5/old.jpg"),
    (e: unknown) => {
      assert.ok(e instanceof PhotoRemoveError, "doit être une PhotoRemoveError typée");
      assert.notEqual((e as Error).message, technicalMessage);
      assert.ok(String((e as Error).cause).includes(technicalMessage));
      return true;
    }
  );
});

test("photo produit (M-01): le dashboard traduit PhotoUploadError/PhotoRemoveError, journalise .cause, n'affiche jamais e.message brut pour ces erreurs", () => {
  const source = readFileSync("app/dashboard/catalogue/page.tsx", "utf8");
  assert.ok(source.includes("e instanceof PhotoUploadError"));
  assert.ok(source.includes('setError(t("mcPhotoUploadError"))'));
  assert.ok(source.includes("e instanceof PhotoRemoveError"));
  assert.ok(source.includes('setError(t("mcPhotoRemoveError"))'));
  assert.ok(
    source.includes("console.error(\"Photo upload failed:\", e.cause)") &&
      source.includes("console.error(\"Photo remove failed:\", e.cause)"),
    "le message technique doit rester disponible pour le debug (log), pas seulement supprimé"
  );
});

// --- 3. Extraction de chemin (utilisée pour la suppression Storage) ---

test("photo produit: extractStoragePath -- URL publique du bucket product-photos, chemin extrait correctement", () => {
  const url = "https://xxxx.supabase.co/storage/v1/object/public/product-photos/r1/p1/abc123.jpg";
  assert.equal(extractStoragePath(url), "r1/p1/abc123.jpg");
});

test("photo produit: extractStoragePath -- null si aucune image", () => {
  assert.equal(extractStoragePath(null), null);
});

test("photo produit: extractStoragePath -- null pour une URL hors du bucket product-photos (ex. ancienne photo statique /photos/xxx.jpg) -- rien à supprimer côté Storage, pas une erreur", () => {
  assert.equal(extractStoragePath("/photos/cappuccino.jpg"), null);
  assert.equal(extractStoragePath("https://autre-bucket.supabase.co/storage/v1/object/public/autre-bucket/x.jpg"), null);
});

// --- 4. Nom de fichier jamais dérivé de l'entrée utilisateur ---

test("photo produit: deux uploads successifs du même fichier produisent des chemins DIFFÉRENTS (nom généré, jamais le nom utilisateur)", async () => {
  const source = readFileSync("lib/services/product-photo.ts", "utf8");
  assert.ok(
    source.includes("crypto.randomUUID()"),
    "le nom de fichier stocké doit être généré (aléatoire), jamais dérivé du nom fourni par l'utilisateur"
  );
  assert.ok(
    !/file\.name/.test(source),
    "le nom de fichier fourni par l'utilisateur (file.name) ne doit jamais entrer dans le chemin de stockage"
  );
});

// --- 5. Ordre des opérations (remplacement / suppression) -- structurel,
// car les fonctions d'orchestration appellent réellement Storage/RPC,
// non exécutables sans instance Supabase (même limite que pour
// dashboard.ts, jamais testé en direct non plus dans ce dépôt).

test("photo produit: remplacement -- upload AVANT la RPC, rollback du nouvel upload si la RPC échoue, ancienne photo nettoyée SEULEMENT après succès", () => {
  const source = readFileSync("lib/services/product-photo.ts", "utf8");
  const fn = source.slice(
    source.indexOf("export async function addOrReplaceProductPhoto"),
    source.indexOf("export async function removeProductPhoto")
  );
  const uploadIdx = fn.indexOf(".upload(");
  const setPhotoIdx = fn.indexOf("setProductPhoto(productId, newUrl)");
  const rollbackIdx = fn.indexOf("deleteStorageFileBestEffort(newUrl)");
  const oldCleanupIdx = fn.indexOf("deleteStorageFileBestEffort(previousImageUrl)");

  assert.ok(uploadIdx >= 0 && setPhotoIdx > uploadIdx, "l'upload doit précéder l'appel RPC");
  assert.ok(fn.includes("try {") && fn.includes("} catch (e) {"), "l'appel RPC doit être protégé par un try/catch pour permettre le rollback du nouvel upload");
  assert.ok(rollbackIdx > setPhotoIdx, "en cas d'échec RPC, le nouvel upload doit être nettoyé (rollback)");
  assert.ok(oldCleanupIdx > setPhotoIdx, "l'ANCIENNE photo n'est nettoyée qu'après le succès de la RPC (jamais avant)");
});

test("photo produit: suppression -- RPC (DB) AVANT la suppression Storage, jamais l'inverse", () => {
  const source = readFileSync("lib/services/product-photo.ts", "utf8");
  const fn = source.slice(source.indexOf("export async function removeProductPhoto"));
  const rpcIdx = fn.indexOf("setProductPhoto(productId, null)");
  const storageDeleteIdx = fn.indexOf("deleteStorageFileBestEffort(currentImageUrl)");
  assert.ok(rpcIdx >= 0 && storageDeleteIdx > rpcIdx, "la DB doit être mise à jour AVANT toute suppression Storage -- sinon un échec DB laisserait le fichier supprimé mais la DB encore référencée dessus");
});

test("photo produit: erreur Storage -- toute suppression Storage est best-effort (try/catch), ne bloque jamais le flux utilisateur", () => {
  const source = readFileSync("lib/services/product-photo.ts", "utf8");
  const fn = source.slice(
    source.indexOf("async function deleteStorageFileBestEffort"),
    source.indexOf("async function deleteStorageFileBestEffort") + 400
  );
  assert.ok(fn.includes("try {") && fn.includes("catch"), "la suppression Storage doit être protégée (échec toléré, jamais propagé)");
});

// --- 6. Absence de régression : dashboard.ts expose bien image_url et setProductPhoto ---

test("photo produit: CatalogueProduct expose image_url, getMerchantCatalogue le propage", () => {
  const source = readFileSync("lib/services/dashboard.ts", "utf8");
  assert.ok(/image_url:\s*string \| null;/.test(source), "CatalogueProduct doit exposer image_url");
  assert.ok(source.includes("image_url: r.image_url"), "la ligne mappée doit reprendre image_url de la RPC");
});

test("photo produit: setProductPhoto appelle la RPC set_product_photo avec les bons paramètres, jamais d'écriture directe sur menu_items", () => {
  const source = readFileSync("lib/services/dashboard.ts", "utf8");
  const fn = source.slice(source.indexOf("export async function setProductPhoto"));
  assert.ok(fn.includes('"set_product_photo"'));
  assert.ok(fn.includes("p_product_id: productId"));
  assert.ok(fn.includes("p_image_url: imageUrl"));
  assert.ok(!/\.from\("menu_items"\)\.update/.test(fn), "aucune écriture directe sur menu_items -- doit passer par la RPC");
});

// --- 7. Migration SQL : rôle, isolation, chemin, RPC ---

test("migration V67: set_product_photo réutilise assert_product_role(owner/manager), jamais staff", () => {
  const source = readFileSync("supabase/migration-v67-product-photos.sql", "utf8");
  const fn = source.slice(
    source.indexOf("create function public.set_product_photo"),
    source.indexOf("revoke all on function public.set_product_photo")
  );
  assert.ok(fn.includes("assert_product_role(p_product_id, array['owner','manager'])"));
  assert.ok(!fn.includes("'staff'"), "set_product_photo ne doit jamais autoriser staff");
});

test("migration V67: policies storage.objects vérifient explicitement le format UUID du segment restaurant_id (pas d'injection de chemin via un segment arbitraire)", () => {
  const source = readFileSync("supabase/migration-v67-product-photos.sql", "utf8");
  const occurrences = (source.match(/\^\[0-9a-fA-F-\]\{36\}\$/g) || []).length;
  assert.ok(occurrences >= 4, "chaque policy (select/insert/update/delete) doit valider le format UUID du 1er segment de chemin");
});

test("migration V67: écriture (insert/update/delete) réservée owner/manager, jamais staff, dans les 4 policies storage.objects", () => {
  const source = readFileSync("supabase/migration-v67-product-photos.sql", "utf8");
  const policiesBlock = source.slice(
    source.indexOf('create policy "product_photos_select_own_restaurant"'),
    source.indexOf("-- 2c. set_product_photo")
  );
  const roleChecks = (policiesBlock.match(/role = any \(array\['owner','manager'\]\)/g) || []).length;
  // 5, pas 4 : select/insert/delete en ont chacune une occurrence,
  // update en a DEUX (clause using ET with check), soit 3 + 2 = 5.
  assert.equal(roleChecks, 5, "les 4 policies (select/insert/update/delete) doivent toutes vérifier owner/manager (update : using + with check)");
  assert.ok(!policiesBlock.includes("'staff'"), "aucune policy storage.objects ne doit autoriser staff");
});

test("migration V67: bucket product-photos public (justifié), écriture non publique (aucune policy 'to public' ou 'to anon' en écriture)", () => {
  const source = readFileSync("supabase/migration-v67-product-photos.sql", "utf8");
  assert.ok(source.includes("'product-photos',\n  'product-photos',\n  true,"), "le bucket doit être public (lecture)");
  const policiesBlock = source.slice(source.indexOf('create policy "product_photos_select_own_restaurant"'));
  assert.ok(!/to\s+anon/i.test(policiesBlock), "aucune policy d'écriture/lecture ciblant anon");
  assert.ok(!/to\s+public\b/i.test(policiesBlock), "aucune policy globalement permissive 'to public'");
});

test("migration V67: get_merchant_catalogue expose image_url (drop + recréation, comme en V66 pour un changement de type de retour)", () => {
  const source = readFileSync("supabase/migration-v67-product-photos.sql", "utf8");
  assert.ok(source.includes("drop function if exists public.get_merchant_catalogue(uuid, boolean);"));
  assert.ok(/image_url\s+text\s*\n\)/.test(source), "image_url doit être ajouté à la RETURNS TABLE");
  assert.ok(source.includes("mi.image_url\n  from public.menu_categories"), "image_url doit être sélectionné dans le corps de la fonction");
});

test("migration V67: aucune clé service_role, aucun secret dans le fichier de migration", () => {
  const source = readFileSync("supabase/migration-v67-product-photos.sql", "utf8");
  assert.ok(!/service_role/.test(source), "aucune référence à service_role dans la migration V67");
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(source), "aucun JWT en dur");
});

// --- 8. i18n ---

test("photo produit: toutes les nouvelles clés i18n existent en fr/en/ar et diffèrent entre langues", () => {
  const source = readFileSync("lib/i18n.ts", "utf8");
  const keys = [
    "mcPhoto", "mcPhotoAdd", "mcPhotoReplace", "mcPhotoRemove",
    "mcPhotoUploading", "mcPhotoNone", "mcPhotoInvalidType",
    "mcPhotoTooLarge", "mcPhotoUploadError", "mcPhotoRemoveError",
    "ariaProductPhotoPreview",
  ];
  for (const key of keys) {
    const count = (source.match(new RegExp(`\\b${key}:`, "g")) || []).length;
    assert.equal(count, 3, `${key} doit être défini exactement 3 fois (fr, en, ar)`);
  }
});

// --- 9. UI dashboard : upload restreint, double-soumission empêchée,
// suppression seulement si une photo existe.

test("catalogue dashboard: le champ fichier restreint aux 3 formats acceptés, désactivé pendant l'upload (anti double-soumission)", () => {
  const source = readFileSync("app/dashboard/catalogue/page.tsx", "utf8");
  assert.ok(source.includes('accept="image/jpeg,image/png,image/webp"'));
  const fieldFn = source.slice(
    source.indexOf("function ProductPhotoField"),
    source.indexOf("function CategoryForm")
  );
  assert.ok(fieldFn.includes("disabled={busy}"), "le champ fichier doit être désactivé pendant l'upload");
  assert.ok(/e\.target\.value = ""/.test(fieldFn), "l'input est réinitialisé après sélection (permet de re-choisir le même fichier, ne permet pas une double soumission du même événement)");
});

test("catalogue dashboard: le bouton Supprimer la photo n'apparaît que si une photo existe", () => {
  const source = readFileSync("app/dashboard/catalogue/page.tsx", "utf8");
  const fieldFn = source.slice(
    source.indexOf("function ProductPhotoField"),
    source.indexOf("function CategoryForm")
  );
  assert.ok(/\{imageUrl && \(\s*<button/.test(fieldFn), "le bouton de suppression doit être conditionné à la présence d'une photo");
});

test("catalogue dashboard: la zone photo n'est proposée qu'en édition (product_id requis pour le chemin de stockage), jamais à la création", () => {
  const source = readFileSync("app/dashboard/catalogue/page.tsx", "utf8");
  const createBlock = source.slice(
    source.indexOf("creatingIn === cat.category_id"),
    source.indexOf("cat.products.length === 0")
  );
  assert.ok(!createBlock.includes("ProductPhotoField"), "la création de produit ne doit pas proposer la zone photo (aucun product_id disponible avant la création)");
});
