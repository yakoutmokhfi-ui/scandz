import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Doit être défini AVANT tout import qui remonte jusqu'à
// lib/supabase.ts (product-photo.ts -> lib/services/auth.ts ->
// supabase.ts) : ce module lève une exception au chargement si ces
// variables sont absentes. Valeurs factices, jamais utilisées pour un
// appel réseau réel dans les tests ci-dessous (global.fetch et
// supabase.auth.getSession sont interceptés — voir plus bas).
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
// Photo produit (V67, remaniée BULK PRODUCT PHOTOS v1.4) — validation
// réelle (signature binaire, taille), extraction de chemin, et
// vérifications structurelles + comportementales du NOUVEAU flux de
// remplacement de confiance côté serveur.
//
// v1.4 (Cat Stevens, réaudit final -- TRUSTED SERVER-SIDE REPLACEMENT
// HARDENING) : lib/services/product-photo.ts ne parle plus JAMAIS
// directement à Supabase Storage ni à une RPC -- il délègue
// intégralement, via fetch(), à la route de confiance
// app/api/dashboard/catalogue/product-photo/route.ts. Les tests
// ci-dessous interceptent donc global.fetch et
// supabase.auth.getSession (jamais supabase.storage/supabase.rpc,
// qui ne sont plus jamais appelés par ce module). Le comportement
// AUTORITAIRE réel du flux serveur (résolution de restaurant_id,
// génération du chemin, upload, écriture DB, nettoyage Storage de
// l'ancienne image) est testé séparément et exhaustivement dans :
//   - tests/v152-product-photo-service.test.ts (Node, mock du client
//     Storage service_role -- scénarios de compensation A/B/C/F) ;
//   - supabase/tests/v67c-storage-operator-authorization-check.sh
//     (PostgreSQL réel -- 26 items du mandat, provenance 3-objets,
//     concurrence, contrat crypto.randomUUID() v4, rollback).
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

/** Mock d'une session active -- même convention que les autres appels réseau réels de ce dépôt (jamais atteints). */
function mockActiveSession(t: { mock: { method: typeof import("node:test").mock.method } }, token = "fake-access-token") {
  t.mock.method(supabase.auth, "getSession", async () => ({
    data: { session: { access_token: token } },
    error: null,
  }));
}

function mockNoSession(t: { mock: { method: typeof import("node:test").mock.method } }) {
  t.mock.method(supabase.auth, "getSession", async () => ({ data: { session: null }, error: null }));
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

// --- 2bis. v1.4 : addOrReplaceProductPhoto/removeProductPhoto délèguent
// intégralement à la route de confiance via fetch() -- jamais un appel
// Storage/RPC direct. Interception de global.fetch + supabase.auth.getSession
// (jamais supabase.storage/supabase.rpc -- confirmé absents, voir §5).

test("photo produit (v1.4): addOrReplaceProductPhoto envoie un POST multipart vers la route de confiance, avec l'en-tête Authorization Bearer du jeton de la session courante", async (t) => {
  mockActiveSession(t, "session-token-abc");
  let captured: { url?: string; method?: string; headers?: Record<string, string>; form?: FormData } = {};
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    captured = { url, method: init.method, headers: init.headers as Record<string, string>, form: init.body as FormData };
    return new Response(JSON.stringify({ outcome: "ok", imageUrl: "https://fake.supabase.co/storage/v1/object/public/product-photos/r1/p1/x.jpg", oldImageCleanup: "removed" }), { status: 200 });
  });

  const f = fileOf(jpegBytes(1024), "photo.jpg", "image/jpeg");
  const result = await addOrReplaceProductPhoto("r1", "p1", f);

  assert.equal(captured.url, "/api/dashboard/catalogue/product-photo");
  assert.equal(captured.method, "POST");
  assert.equal((captured.headers as Record<string, string>).Authorization, "Bearer session-token-abc");
  assert.ok(captured.form instanceof FormData, "le corps doit être un FormData (multipart)");
  assert.equal((captured.form as FormData).get("productId"), "p1");
  assert.equal((captured.form as FormData).get("file"), f);
  assert.equal(result.imageUrl, "https://fake.supabase.co/storage/v1/object/public/product-photos/r1/p1/x.jpg");
  assert.equal(result.oldImageCleanup, "removed", "v1.5 (MEDIUM) : le statut de nettoyage de l'ancienne image doit être remonté par addOrReplaceProductPhoto, plus jamais silencieusement ignoré");
});

test("photo produit (v1.5, MEDIUM): addOrReplaceProductPhoto -- si la route de confiance omet oldImageCleanup dans sa réponse, la valeur par défaut est 'not_applicable' (jamais undefined, jamais une exception)", async (t) => {
  mockActiveSession(t, "session-token-abc");
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ outcome: "ok", imageUrl: "https://fake.supabase.co/storage/v1/object/public/product-photos/r1/p1/x.jpg" }), { status: 200 })
  );

  const f = fileOf(jpegBytes(1024), "photo.jpg", "image/jpeg");
  const result = await addOrReplaceProductPhoto("r1", "p1", f);
  assert.equal(result.oldImageCleanup, "not_applicable");
});

test("photo produit (v1.5, Blocker 2): addOrReplaceProductPhoto propage fidèlement oldImageCleanup='skipped_unsafe_legacy' (référence historique non sûre, jamais masquée en 'removed')", async (t) => {
  mockActiveSession(t, "session-token-abc");
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ outcome: "ok", imageUrl: "https://fake.supabase.co/storage/v1/object/public/product-photos/r1/p1/x.jpg", oldImageCleanup: "skipped_unsafe_legacy" }), { status: 200 })
  );

  const f = fileOf(jpegBytes(1024), "photo.jpg", "image/jpeg");
  const result = await addOrReplaceProductPhoto("r1", "p1", f);
  assert.equal(result.oldImageCleanup, "skipped_unsafe_legacy");
});

test("photo produit (v1.4/v1.5): removeProductPhoto envoie un DELETE JSON vers la route de confiance, avec l'en-tête Authorization Bearer, et remonte désormais oldImageCleanup (v1.5, MEDIUM -- la réponse n'est plus jamais ignorée)", async (t) => {
  mockActiveSession(t, "session-token-xyz");
  let captured: { url?: string; method?: string; headers?: Record<string, string>; body?: string } = {};
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    captured = { url, method: init.method, headers: init.headers as Record<string, string>, body: init.body as string };
    return new Response(JSON.stringify({ outcome: "ok", oldImageCleanup: "removed" }), { status: 200 });
  });

  const result = await removeProductPhoto("p9");

  assert.equal(captured.url, "/api/dashboard/catalogue/product-photo");
  assert.equal(captured.method, "DELETE");
  assert.equal((captured.headers as Record<string, string>).Authorization, "Bearer session-token-xyz");
  assert.deepEqual(JSON.parse(captured.body as string), { productId: "p9" });
  assert.equal(result.oldImageCleanup, "removed");
});

test("photo produit (v1.4): aucune session active -- PhotoUploadError immédiate, AUCUN appel réseau (jamais de fetch() sans jeton)", async (t) => {
  mockNoSession(t);
  let fetchCalled = false;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalled = true;
    throw new Error("fetch ne doit jamais être appelé sans session active");
  });

  const f = fileOf(jpegBytes(1024), "photo.jpg", "image/jpeg");
  await assert.rejects(() => addOrReplaceProductPhoto("r1", "p1", f), PhotoUploadError);
  assert.equal(fetchCalled, false, "aucun appel réseau ne doit être tenté sans jeton d'accès");
});

test("photo produit (v1.4): aucune session active -- removeProductPhoto échoue en PhotoRemoveError, AUCUN appel réseau", async (t) => {
  mockNoSession(t);
  let fetchCalled = false;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalled = true;
    throw new Error("fetch ne doit jamais être appelé sans session active");
  });

  await assert.rejects(() => removeProductPhoto("p1"), PhotoRemoveError);
  assert.equal(fetchCalled, false);
});

// --- 2ter. M-01 (audit Work, préservé v1.4) : les échecs de la route de
// confiance lors de l'ajout/remplacement ou de la suppression doivent
// être typés (PhotoUploadError/PhotoRemoveError), jamais une Error
// générique qui laisserait fuiter un message technique brut jusqu'à
// l'UI. Le détail technique (statut HTTP, corps JSON de la route)
// reste accessible via `.cause`, pour le debug/log, sans être le
// message affiché à l'utilisateur.

test("photo produit (M-01, v1.4): route de confiance refuse (403) -- PhotoUploadError, message PRINCIPAL générique, détail technique dans .cause", async (t) => {
  mockActiveSession(t);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ outcome: "denied" }), { status: 403 }));

  const f = fileOf(jpegBytes(1024), "photo.jpg", "image/jpeg");
  await assert.rejects(
    () => addOrReplaceProductPhoto("r1", "p3", f),
    (e: unknown) => {
      assert.ok(e instanceof PhotoUploadError, "doit être une PhotoUploadError typée");
      assert.equal((e as Error).message, "Photo upload failed", "le message PRINCIPAL doit toujours être générique, jamais construit à partir de la réponse de la route");
      assert.ok((e as Error).cause !== undefined, "le détail (corps JSON / statut) doit rester disponible via .cause, pour le debug/log");
      return true;
    }
  );
});

test("photo produit (M-01, v1.4): échec réseau (fetch rejette) lors d'un ajout -- PhotoUploadError également, pas seulement une réponse HTTP non-ok", async (t) => {
  mockActiveSession(t);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network error (simulated)");
  });

  const f = fileOf(pngBytes(1024), "photo.png", "image/png");
  await assert.rejects(() => addOrReplaceProductPhoto("r1", "p4", f), PhotoUploadError);
});

test("photo produit (M-01, v1.4): route de confiance refuse (404) lors d'une suppression -- PhotoRemoveError, message technique préservé dans .cause", async (t) => {
  mockActiveSession(t);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ outcome: "denied" }), { status: 404 }));

  await assert.rejects(
    () => removeProductPhoto("p5"),
    (e: unknown) => {
      assert.ok(e instanceof PhotoRemoveError, "doit être une PhotoRemoveError typée");
      assert.notEqual((e as Error).message, "denied");
      assert.ok((e as Error).cause !== undefined);
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

// --- 3. Extraction de chemin (module partagé lib/product-photo-contract.ts) ---

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

// --- 4. Nom de fichier -- généré CÔTÉ SERVEUR depuis v1.4 (jamais côté
// client, jamais dérivé de l'entrée utilisateur) ---

test("photo produit (v1.4): la génération de nom de fichier (crypto.randomUUID()) vit désormais dans lib/product-photo-contract.ts, appelée SEULEMENT par lib/server/product-photo-service.ts -- jamais par lib/services/product-photo.ts (navigateur)", () => {
  const contract = readFileSync("lib/product-photo-contract.ts", "utf8");
  const server = readFileSync("lib/server/product-photo-service.ts", "utf8");
  const client = readFileSync("lib/services/product-photo.ts", "utf8");

  assert.ok(contract.includes("crypto.randomUUID()"), "randomFileName doit rester basé sur crypto.randomUUID()");
  assert.ok(server.includes("randomFileName"), "le service serveur doit générer le nom de fichier");
  assert.ok(
    !client.includes("crypto.randomUUID()") && !client.includes("randomFileName") && !client.includes("objectPath("),
    "le module navigateur ne doit plus jamais générer de nom de fichier ni construire de chemin Storage -- entièrement délégué au serveur (Cat Stevens Blocker 1/3)"
  );
  assert.ok(
    !/file\.name/.test(client),
    "le nom de fichier fourni par l'utilisateur (file.name) ne doit jamais entrer dans un chemin de stockage, ni côté client ni ailleurs dans ce module"
  );
});

// --- 5. lib/services/product-photo.ts ne parle plus JAMAIS directement
// à Supabase Storage ni à une RPC pour ce flux (Cat Stevens, réaudit
// final v1.4) -- entièrement délégué à la route de confiance serveur.

test("photo produit (v1.4): lib/services/product-photo.ts n'importe plus @/lib/supabase, n'appelle plus .storage. ni .rpc( -- tout passe par fetch() vers la route de confiance", () => {
  const source = readFileSync("lib/services/product-photo.ts", "utf8");
  assert.ok(!source.includes('from "@/lib/supabase"'), "aucun import du client Supabase navigateur -- ce module ne parle plus à Supabase directement");
  assert.ok(!/\.storage\s*\.\s*from\(/.test(source), "aucun appel Storage direct");
  assert.ok(!/\.rpc\(/.test(source), "aucun appel RPC direct");
  assert.ok(source.includes('fetch(PHOTO_ROUTE'), "doit déléguer via fetch() vers la route de confiance");
  assert.ok(source.includes('"/api/dashboard/catalogue/product-photo"'), "la route de confiance ciblée doit être exactement app/api/dashboard/catalogue/product-photo/route.ts");
});

test("photo produit (v1.4): addOrReplaceProductPhoto/removeProductPhoto ne transmettent plus jamais de valeur \"ancienne image\" au serveur (Cat Stevens Blocker 1 -- \"no client-controlled previous image path\")", () => {
  const source = readFileSync("lib/services/product-photo.ts", "utf8");
  assert.ok(!source.includes("previousImageUrl"), "aucun paramètre previousImageUrl");
  assert.ok(!source.includes("currentImageUrl"), "aucun paramètre currentImageUrl");
  assert.ok(!source.includes("oldPath") || !/form\.set\(.*old/i.test(source), "aucun champ de formulaire ne doit transmettre un \"ancien chemin\" choisi par le client");
});

test("photo produit: aucune fonction de suppression Storage côté client ne subsiste dans ce module (deleteStorageFileBestEffort n'a jamais été réintroduite)", () => {
  const source = readFileSync("lib/services/product-photo.ts", "utf8");
  assert.ok(!source.includes("deleteStorageFileBestEffort"));
  assert.ok(!/\.remove\(/.test(source), "ce module ne doit jamais appeler .remove() -- tout nettoyage Storage est désormais exclusivement serveur (lib/server/product-photo-service.ts)");
});

// --- 6. Absence de régression : dashboard.ts expose bien image_url ;
// setProductPhoto SUPPRIMÉE (v1.4, Cat Stevens Blocker 1 -- signature
// structurellement incompatible avec le modèle de confiance retenu).

test("photo produit: CatalogueProduct expose image_url, getMerchantCatalogue le propage", () => {
  const source = readFileSync("lib/services/dashboard.ts", "utf8");
  assert.ok(/image_url:\s*string \| null;/.test(source), "CatalogueProduct doit exposer image_url");
  assert.ok(source.includes("image_url: r.image_url"), "la ligne mappée doit reprendre image_url de la RPC");
});

test("photo produit (v1.4): setProductPhoto n'existe plus dans lib/services/dashboard.ts -- la RPC set_product_photo elle-même est supprimée (Cat Stevens Blocker 1)", () => {
  const source = readFileSync("lib/services/dashboard.ts", "utf8");
  assert.ok(!/export async function setProductPhoto/.test(source), "setProductPhoto ne doit plus être exportée par dashboard.ts");
  assert.ok(!source.includes('"set_product_photo"'), "dashboard.ts ne doit plus jamais référencer la RPC set_product_photo");
});

test("photo produit (v1.4): lib/services/product-photo.ts n'importe plus lib/services/dashboard.ts (l'ancien couplage RPC a disparu avec set_product_photo)", () => {
  const source = readFileSync("lib/services/product-photo.ts", "utf8");
  assert.ok(!source.includes('from "@/lib/services/dashboard"'));
});

// --- 7. Migration SQL publiée V67 (migration-v67-product-photos.sql,
// JAMAIS modifiée par ce lot -- non-régression) : rôle, isolation,
// chemin, RPC d'origine.

test("migration V67 (publiée, inchangée): set_product_photo (état d'origine) réutilise assert_product_role(owner/manager), jamais staff", () => {
  const source = readFileSync("supabase/migration-v67-product-photos.sql", "utf8");
  const fn = source.slice(
    source.indexOf("create function public.set_product_photo"),
    source.indexOf("revoke all on function public.set_product_photo")
  );
  assert.ok(fn.includes("assert_product_role(p_product_id, array['owner','manager'])"));
  assert.ok(!fn.includes("'staff'"), "set_product_photo ne doit jamais autoriser staff");
});

test("migration V67 (publiée, inchangée): policies storage.objects vérifient explicitement le format UUID du segment restaurant_id (pas d'injection de chemin via un segment arbitraire)", () => {
  const source = readFileSync("supabase/migration-v67-product-photos.sql", "utf8");
  const occurrences = (source.match(/\^\[0-9a-fA-F-\]\{36\}\$/g) || []).length;
  assert.ok(occurrences >= 4, "chaque policy (select/insert/update/delete) doit valider le format UUID du 1er segment de chemin");
});

test("migration V67 (publiée, inchangée): écriture (insert/update/delete) réservée owner/manager, jamais staff, dans les 4 policies storage.objects", () => {
  const source = readFileSync("supabase/migration-v67-product-photos.sql", "utf8");
  const policiesBlock = source.slice(
    source.indexOf('create policy "product_photos_select_own_restaurant"'),
    source.indexOf("-- 2c. set_product_photo")
  );
  const roleChecks = (policiesBlock.match(/role = any \(array\['owner','manager'\]\)/g) || []).length;
  assert.equal(roleChecks, 5, "les 4 policies (select/insert/update/delete) doivent toutes vérifier owner/manager (update : using + with check)");
  assert.ok(!policiesBlock.includes("'staff'"), "aucune policy storage.objects ne doit autoriser staff");
});

test("migration V67 (publiée, inchangée): bucket product-photos public (justifié), écriture non publique (aucune policy 'to public' ou 'to anon' en écriture)", () => {
  const source = readFileSync("supabase/migration-v67-product-photos.sql", "utf8");
  assert.ok(source.includes("'product-photos',\n  'product-photos',\n  true,"), "le bucket doit être public (lecture)");
  const policiesBlock = source.slice(source.indexOf('create policy "product_photos_select_own_restaurant"'));
  assert.ok(!/to\s+anon/i.test(policiesBlock), "aucune policy d'écriture/lecture ciblant anon");
  assert.ok(!/to\s+public\b/i.test(policiesBlock), "aucune policy globalement permissive 'to public'");
});

test("migration V67 (publiée, inchangée): get_merchant_catalogue expose image_url (drop + recréation, comme en V66 pour un changement de type de retour)", () => {
  const source = readFileSync("supabase/migration-v67-product-photos.sql", "utf8");
  assert.ok(source.includes("drop function if exists public.get_merchant_catalogue(uuid, boolean);"));
  assert.ok(/image_url\s+text\s*\n\)/.test(source), "image_url doit être ajouté à la RETURNS TABLE");
  assert.ok(source.includes("mi.image_url\n  from public.menu_categories"), "image_url doit être sélectionné dans le corps de la fonction");
});

test("migration V67 (publiée, inchangée): aucune clé service_role, aucun secret dans le fichier de migration", () => {
  const source = readFileSync("supabase/migration-v67-product-photos.sql", "utf8");
  assert.ok(!/service_role/.test(source), "aucune référence à service_role dans la migration V67");
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(source), "aucun JWT en dur");
});

// --- 7bis. Migration v1.4/v1.5 (DRAFT du lot Bulk) : begin_/apply_,
// jamais de DELETE storage.objects, forme exacte de chemin, contrat
// UUID v4 (v1.4) ; apply_ service_role-uniquement, revalidation de
// l'ancien chemin lu en DB (v1.5, Blockers 1 et 2 -- voir aussi le
// harnais PostgreSQL réel supabase/tests/v67c-storage-operator-
// authorization-check.sh pour le comportement bout-en-bout).

test("migration v1.4 (DRAFT Bulk): set_product_photo(uuid, text) est bien SUPPRIMÉE, remplacée par begin_/apply_product_photo_replacement", () => {
  const source = readFileSync("supabase/DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql", "utf8");
  assert.ok(source.includes("drop function public.set_product_photo(uuid, text);"));
  assert.ok(source.includes("create function public.begin_product_photo_replacement("));
  assert.ok(source.includes("create function public.apply_product_photo_replacement("));
});

test("migration v1.4 (DRAFT Bulk): apply_product_photo_replacement ne contient AUCUN DELETE FROM storage.objects (Cat Stevens Blocker 2 -- suppression physique déléguée à l'API Storage réelle, côté Node)", () => {
  const source = readFileSync("supabase/DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql", "utf8");
  const fn = source.slice(
    source.indexOf("create function public.apply_product_photo_replacement("),
    source.indexOf("revoke all on function public.apply_product_photo_replacement")
  );
  assert.ok(!/delete\s+from\s+storage\.objects/i.test(fn), "apply_product_photo_replacement ne doit jamais supprimer directement une ligne storage.objects");
  assert.ok(fn.includes("for update"), "la capture de l'ancienne image doit être verrouillée (MEDIUM 2, concurrence)");
  assert.ok(fn.includes("return query select v_old_path, v_new_image_url"), "doit renvoyer old_path comme DONNÉE, jamais l'avoir supprimé lui-même");
});

test("migration v1.4 (DRAFT Bulk): apply_product_photo_replacement valide EXACTEMENT le contrat crypto.randomUUID() v4 (Cat Stevens Blocker 3)", () => {
  const source = readFileSync("supabase/DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql", "utf8");
  assert.ok(
    source.includes(String.raw`'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$'`),
    "la regex doit encoder EXACTEMENT le contrat crypto.randomUUID() v4 : minuscules, version 4, variante RFC4122 (8/9/a/b)"
  );
});

test("migration v1.6 (DRAFT Bulk, Cat Stevens Blocker 1): _product_photo_path_segments vérifie l'origine par ANCRAGE (starts_with), JAMAIS une recherche de sous-chaîne (position()/indexOf()), avant de déléguer la FORME (segments/UUID v4) à _product_photo_relative_path_shape -- factorisée, réutilisée pour le NOUVEAU et l'ANCIEN chemin", () => {
  const source = readFileSync("supabase/DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql", "utf8");
  const fn = source.slice(
    source.indexOf("create function public._product_photo_path_segments("),
    source.indexOf("revoke all on function public._product_photo_path_segments")
  );
  assert.ok(fn.includes("p_expected_origin"), "un paramètre p_expected_origin OBLIGATOIRE doit exister (Blocker 1 v1.6)");
  assert.ok(
    fn.includes("starts_with(p_image_url, v_expected_prefix)"),
    "l'origine doit être vérifiée par ANCRAGE en position 0 (starts_with), jamais une recherche de sous-chaîne"
  );
  assert.ok(
    !/position\(|strpos\(/.test(fn),
    "AUCUNE recherche de sous-chaîne (position()/strpos()) ne doit subsister -- c'était exactement le Blocker 1 v1.6"
  );
  assert.ok(
    fn.includes("public._product_photo_relative_path_shape(p_restaurant_id, p_product_id, v_path)"),
    "la validation de FORME (segments/UUID v4) doit être déléguée à _product_photo_relative_path_shape, jamais dupliquée ici"
  );
  assert.ok(!/from storage\.objects/.test(fn), "_product_photo_path_segments doit rester une fonction PURE -- aucun accès table, notamment aucune vérification d'existence physique (orthogonal, laissé à l'appelant)");
  assert.ok(fn.includes("\nimmutable\n"), "doit être déclarée IMMUTABLE -- fonction pure, aucun accès table");
});

test("migration v1.6 (DRAFT Bulk): _product_photo_relative_path_shape croise EXACTEMENT restaurant_id/product_id résolus côté serveur contre les segments d'un chemin déjà RELATIF -- jamais une valeur transmise par le client acceptée telle quelle (factorisée, réutilisée par _product_photo_path_segments ET, depuis v1.7, create_/claim_product_photo_pending_cleanup -- retry_product_photo_cleanup_path, v1.6, a été SUPPRIMÉE)", () => {
  const source = readFileSync("supabase/DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql", "utf8");
  const fn = source.slice(
    source.indexOf("create function public._product_photo_relative_path_shape("),
    source.indexOf("revoke all on function public._product_photo_relative_path_shape")
  );
  assert.ok(fn.includes("v_segments[1] <> p_restaurant_id::text"), "le segment 1 doit être comparé au restaurant_id RÉSOLU côté serveur");
  assert.ok(fn.includes("v_segments[2] <> p_product_id::text"), "le segment 2 doit être comparé au product_id");
  assert.ok(!/from storage\.objects/.test(fn), "_product_photo_relative_path_shape doit rester une fonction PURE -- aucun accès table");
  assert.ok(fn.includes("\nimmutable\n"), "doit être déclarée IMMUTABLE -- fonction pure, aucun accès table");
});

test("migration v1.5 (DRAFT Bulk): apply_product_photo_replacement vérifie l'existence PHYSIQUE du nouvel objet avant toute confiance, et revalide CHACUN des deux chemins (nouveau ET ancien lu en DB) via _product_photo_path_segments -- jamais une seule fois", () => {
  const source = readFileSync("supabase/DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql", "utf8");
  const fn = source.slice(
    source.indexOf("create function public.apply_product_photo_replacement("),
    source.indexOf("revoke all on function public.apply_product_photo_replacement")
  );
  assert.ok(
    fn.includes("from storage.objects") && fn.includes("bucket_id = 'product-photos' and name = v_new_path"),
    "l'existence PHYSIQUE du nouvel objet doit être vérifiée avant toute confiance"
  );
  const pathSegmentCalls = (fn.match(/public\._product_photo_path_segments\(/g) || []).length;
  assert.equal(pathSegmentCalls, 2, "le NOUVEAU chemin ET l'ANCIEN chemin (lu en DB) doivent CHACUN être revalidés par la même fonction exacte (Cat Stevens Blocker 2 v1.5)");
});

test("migration v1.5/v1.6/v2.2.1 (DRAFT Bulk, Cat Stevens Blocker 1 v1.5): apply_product_photo_replacement n'a PLUS AUCUN GRANT EXECUTE à authenticated/anon/public -- service_role UNIQUEMENT (CLIENT DIRECT RPC EXECUTE: DENIED) -- signature v2.2.1 à 5 arguments (p_expected_origin ajouté en v1.6, p_is_retry ajouté en v2.2.1, additif/défaut false)", () => {
  const source = readFileSync("supabase/DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql", "utf8");
  assert.ok(
    source.includes("revoke all on function public.apply_product_photo_replacement(uuid, uuid, text, text, boolean) from public, anon, authenticated;"),
    "EXECUTE doit être explicitement révoqué à public/anon/authenticated"
  );
  assert.ok(
    source.includes("grant execute on function public.apply_product_photo_replacement(uuid, uuid, text, text, boolean) to service_role;"),
    "EXECUTE doit être accordé UNIQUEMENT à service_role"
  );
  assert.ok(
    !/grant execute on function public\.apply_product_photo_replacement\([^)]*\)\s+to\s+authenticated/.test(source),
    "aucun GRANT EXECUTE à authenticated ne doit subsister pour apply_ -- c'était exactement le Blocker 1 v1.5"
  );
});

test("migration v1.5/v1.6 (DRAFT Bulk, Cat Stevens Blocker 1 v1.5): begin_product_photo_replacement reste la SEULE fonction AS-USER authentifiée du flux -- lecture seule, aucune mutation, table de retour étendue de caller_user_id (= auth.uid(), jamais une valeur transmise par le client) puis (v1.6, MEDIUM cleanup retry) de current_image_url", () => {
  const source = readFileSync("supabase/DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql", "utf8");
  assert.ok(source.includes("returns table(restaurant_id uuid, caller_user_id uuid, current_image_url text)"), "begin_ doit renvoyer caller_user_id ET (v1.6) current_image_url en plus de restaurant_id");
  assert.ok(source.includes("return query select v_restaurant_id, auth.uid(), v_current_image_url;"), "caller_user_id doit être EXACTEMENT auth.uid(), jamais une valeur transmise par le client ; current_image_url doit être une lecture fraîche de menu_items.image_url");
  assert.ok(source.includes("grant execute on function public.begin_product_photo_replacement(uuid) to authenticated;"), "begin_ reste accessible à authenticated -- lecture seule, sans risque (Blocker 1 v1.5 ne concerne QUE apply_)");
});

test("migration v1.5 (DRAFT Bulk, Cat Stevens Blocker 1): apply_ ne lit plus jamais auth.uid() -- l'identité de l'appelant est un paramètre explicite (p_caller_user_id), obtenu UNIQUEMENT via begin_ (aucune session utilisateur active en service_role)", () => {
  const source = readFileSync("supabase/DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql", "utf8");
  const fn = source.slice(
    source.indexOf("create function public.apply_product_photo_replacement("),
    source.indexOf("revoke all on function public.apply_product_photo_replacement")
  );
  // Retire les lignes de commentaire SQL ("--") avant de vérifier
  // l'absence d'un appel réel à auth.uid() -- le corps de la fonction
  // MENTIONNE délibérément "auth.uid()" en prose dans son commentaire
  // explicatif (pourquoi ce n'est plus un signal de confiance ici),
  // ce qui n'est pas un appel exécutable et ne doit pas faire échouer
  // cette vérification.
  const fnCode = fn.replace(/--.*$/gm, "");
  assert.ok(!fnCode.includes("auth.uid()"), "apply_ ne doit plus jamais APPELER auth.uid() dans son code exécutable");
  assert.ok(fn.includes("p_caller_user_id"), "l'identité doit être reçue en paramètre explicite");
  assert.ok(fn.includes("public.assert_product_role_for(p_caller_user_id, p_product_id, array['owner','manager'])"), "apply_ doit revalider via le jumeau paramétré, avec l'identité transmise en paramètre");
});

test("migration v1.5 (DRAFT Bulk, Cat Stevens Blocker 2): l'ANCIENNE valeur lue en DB (v_old_url) est revalidée par _product_photo_path_segments AVANT d'être renvoyée comme cible de nettoyage -- si invalide, old_path=NULL et old_path_cleanup_skipped=true, JAMAIS supprimée ni normalisée en cible de substitution", () => {
  const source = readFileSync("supabase/DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql", "utf8");
  const fn = source.slice(
    source.indexOf("create function public.apply_product_photo_replacement("),
    source.indexOf("revoke all on function public.apply_product_photo_replacement")
  );
  assert.ok(
    fn.includes("v_old_path := public._product_photo_path_segments(v_restaurant_id, p_product_id, v_old_url, p_expected_origin);"),
    "l'ancienne valeur DB doit être revalidée par la MÊME fonction exacte que le nouveau chemin, avec l'origine ANCRÉE (v1.6, p_expected_origin)"
  );
  assert.ok(fn.includes("if v_old_path is null then"), "une ancienne valeur qui échoue la validation doit être détectée explicitement");
  assert.ok(fn.includes("v_old_path_skipped := true;"), "le nettoyage doit être marqué SAUTÉ, jamais tenté, jamais normalisé en cible de substitution");
  assert.ok(
    fn.includes("returns table(old_path text, image_url text, old_path_cleanup_skipped boolean, already_applied boolean)"),
    "old_path_cleanup_skipped doit être une colonne de retour EXPLICITE -- jamais un état implicite ou déduit côté Node ; already_applied (v2.2.1) est une colonne de retour additive supplémentaire, toujours false pour ce chemin (premier Apply)"
  );
});

test("migration v1.4 (DRAFT Bulk): les 4 policies storage.objects sont TOUTES using(false)/with check(false) pour authenticated (aucun accès client direct ne subsiste, y compris INSERT)", () => {
  const source = readFileSync("supabase/DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql", "utf8");
  const policiesBlock = source.slice(source.lastIndexOf('drop policy "product_photos_select_own_restaurant"'));
  const usingFalse = (policiesBlock.match(/using \(false\)/g) || []).length;
  const checkFalse = (policiesBlock.match(/with check \(false\)/g) || []).length;
  assert.equal(usingFalse, 3, "select/update/delete doivent chacune porter using(false)");
  assert.equal(checkFalse, 2, "insert et update doivent chacune porter with check(false)");
});

test("migration v1.5/v1.6/v1.7/v1.8 (DRAFT Bulk): begin_ revalide via assert_product_role, ET (v1.5) apply_, ET (v1.7/v1.8 -- REMPLACE retry_product_photo_cleanup_path, v1.6, SUPPRIMÉE) create_/claim_/finalize_/release_product_photo_pending_cleanup revalident CHACUNE DE NOUVEAU et INDÉPENDAMMENT via le jumeau paramétré assert_product_role_for -- jamais staff, jamais un droit hérité sans revalidation (apply_/create_/claim_/finalize_/release_ n'utilisent JAMAIS assert_product_role elle-même, auth.uid() n'y étant plus un signal de confiance)", () => {
  const source = readFileSync("supabase/DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql", "utf8");
  const beginOccurrences = (source.match(/(?<!_for)\bassert_product_role\(p_product_id, array\['owner','manager'\]\)/g) || []).length;
  assert.equal(beginOccurrences, 1, "begin_ doit revalider via assert_product_role -- exactement une fois");
  const applyOccurrences = (source.match(/assert_product_role_for\(p_caller_user_id, p_product_id, array\['owner','manager'\]\)/g) || []).length;
  assert.equal(applyOccurrences, 5, "apply_, create_, claim_, finalize_ ET release_product_photo_pending_cleanup (v1.8) doivent CHACUNE revalider INDÉPENDAMMENT via le jumeau paramétré assert_product_role_for -- exactement cinq fois au total, jamais un droit hérité de begin_");
  assert.ok(!source.includes("'staff'"), "aucune des revalidations ne doit jamais autoriser staff");
});

test("migration v1.5 (DRAFT Bulk): public.assert_product_role elle-même n'est JAMAIS modifiée par ce fichier -- assert_product_role_for est un JUMEAU nouveau, jamais une réécriture de la fonction partagée réutilisée par de nombreux autres lots", () => {
  const source = readFileSync("supabase/DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql", "utf8");
  assert.ok(!/create (or replace )?function public\.assert_product_role\(/.test(source), "aucune (re)création de assert_product_role elle-même");
  assert.ok(!/drop function public\.assert_product_role\(/.test(source), "aucun DROP de assert_product_role elle-même");
  assert.ok(source.includes("create function public.assert_product_role_for("), "assert_product_role_for doit être une fonction NOUVELLE, distincte");
});

test("migration v1.8 ROLLBACK (DRAFT Bulk): restaure le corps EXACT V67 d'origine de set_product_photo (aucune capture, aucune validation de chemin), DROP la TABLE + les HUIT fonctions v1.4/v1.5/v1.6/v1.7/v1.8 (avec la signature v1.8 à CINQ arguments pour claim_ -- reopen_product_photo_pending_cleanup, v1.7, N'EST PAS dans cette liste, ce fichier v1.8 ne l'ayant jamais recréée), et les 4 policies publiées V67", () => {
  const source = readFileSync("supabase/DRAFT-lot-bulk-product-photos-storage-authorization-v1-ROLLBACK.sql", "utf8");
  assert.ok(source.includes("drop function public.begin_product_photo_replacement(uuid);"));
  assert.ok(
    source.includes("drop function public.apply_product_photo_replacement(uuid, uuid, text, text, boolean);"),
    "v2.2.1 : la signature à 5 arguments (p_expected_origin ajouté en v1.6, p_is_retry ajouté en v2.2.1) doit être celle droppée -- jamais une ancienne signature à 4, 3 ou 2 arguments"
  );
  assert.ok(source.includes("drop function public.assert_product_role_for(uuid, uuid, text[]);"), "le rollback doit aussi DROP le jumeau paramétré, nouveau en v1.5");
  assert.ok(
    source.includes("drop function public._product_photo_path_segments(uuid, uuid, text, text);"),
    "le rollback doit aussi DROP la fonction de validation d'origine+chemin factorisée, signature v1.6 à 4 arguments"
  );
  assert.ok(source.includes("drop function public._product_photo_relative_path_shape(uuid, uuid, text);"), "le rollback doit aussi DROP la nouvelle fonction de FORME relative, nouvelle en v1.6");
  assert.ok(
    !source.includes("drop function public.retry_product_photo_cleanup_path"),
    "v1.6 -- retry_product_photo_cleanup_path est SUPPRIMÉE, jamais recréée par aucun fichier forward depuis v1.7 : le rollback n'a AUCUNE raison de la DROP (une mention EN PROSE, dans les commentaires d'en-tête expliquant ce non-changement, reste attendue et légitime)"
  );
  assert.ok(
    !source.includes("drop function public.reopen_product_photo_pending_cleanup"),
    "v1.8 -- reopen_product_photo_pending_cleanup (v1.7) est REMPLACÉE par finalize_/release_, jamais recréée par le fichier forward v1.8 : le rollback n'a AUCUNE raison de la DROP"
  );
  assert.ok(source.includes("drop function public.create_product_photo_pending_cleanup(uuid, uuid, text, text);"), "le rollback doit DROP create_product_photo_pending_cleanup");
  assert.ok(
    source.includes("drop function public.claim_product_photo_pending_cleanup(uuid, uuid, uuid, text, integer);"),
    "NOUVEAU v1.8 -- le rollback doit DROP claim_product_photo_pending_cleanup avec la signature v1.8 EXACTE à CINQ arguments (p_lease_seconds ajouté) -- jamais l'ancienne signature v1.7 à 4 arguments, jamais un paramètre de chemin (CLIENT CLEANUP PATH PARAMETER: NONE)"
  );
  assert.ok(source.includes("drop function public.finalize_product_photo_pending_cleanup(uuid, uuid, uuid, uuid);"), "NOUVEAU v1.8 -- le rollback doit DROP finalize_product_photo_pending_cleanup");
  assert.ok(source.includes("drop function public.release_product_photo_pending_cleanup(uuid, uuid, uuid, uuid);"), "NOUVEAU v1.8 -- le rollback doit DROP release_product_photo_pending_cleanup");
  assert.ok(source.includes("drop table public.product_photo_pending_cleanups;"), "le rollback doit DROP la TABLE d'état durable elle-même (colonnes étendues v1.8 incluses)");
  assert.ok(source.includes("create function public.set_product_photo("));
  assert.ok(!source.includes("v_old_url"), "le rollback doit restaurer le corps V67 D'ORIGINE, sans aucune capture de provenance");
  assert.ok(!/using \(false\)/.test(source), "le rollback doit restaurer les policies V67 D'ORIGINE, jamais using(false)");
});

// --- NOUVEAU v1.7/v1.8 (Cat Stevens, SEUL blocker restant à chaque
// réaudit) : create_/claim_/finalize_/release_product_photo_pending_cleanup
// + la table d'état durable product_photo_pending_cleanups -- machine
// à états pending/processing/completed avec bail à expiration
// automatique et claim_token (v1.8).

test("migration v1.7 (DRAFT Bulk): retry_product_photo_cleanup_path (v1.6) est SUPPRIMÉE ET JAMAIS recréée -- le blocker fermé était PRÉCISÉMENT qu'elle acceptait un oldPath fourni par le client", () => {
  const source = readFileSync("supabase/DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql", "utf8");
  assert.ok(
    !source.includes("create function public.retry_product_photo_cleanup_path("),
    "retry_product_photo_cleanup_path ne doit JAMAIS être (re)créée par le fichier forward v1.7"
  );
});

test("migration v1.7/v1.8 (DRAFT Bulk): product_photo_pending_cleanups -- RLS activée SANS AUCUNE policy (deny-by-default), REVOKE ALL puis GRANT SELECT/INSERT/UPDATE (JAMAIS DELETE) à service_role UNIQUEMENT, contrainte CHECK status EXACTEMENT pending/processing/completed (v1.8), colonnes claim_token/lease_until/attempt_count présentes (v1.8)", () => {
  const source = readFileSync("supabase/DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql", "utf8");
  assert.ok(source.includes("create table public.product_photo_pending_cleanups"), "la table d'état durable doit être créée");
  assert.ok(source.includes("alter table public.product_photo_pending_cleanups enable row level security;"), "RLS doit être activée -- deny-by-default même sans policy explicite");
  assert.ok(!/create policy[^;]*product_photo_pending_cleanups/i.test(source), "AUCUNE policy ne doit exister sur cette table -- RLS activée SANS policy == refus total pour tout rôle soumis à RLS");
  assert.ok(
    source.includes("revoke all on public.product_photo_pending_cleanups from public, anon, authenticated;"),
    "CLIENT DIRECT MUTATION: DENIED -- REVOKE ALL explicite requis"
  );
  assert.ok(
    source.includes("grant select, insert, update on public.product_photo_pending_cleanups to service_role;"),
    "service_role doit obtenir EXACTEMENT select/insert/update -- JAMAIS delete (lignes complétées conservées comme piste d'audit)"
  );
  assert.ok(
    !/grant[^;]*delete[^;]*product_photo_pending_cleanups/i.test(source) && !/grant[^;]*product_photo_pending_cleanups[^;]*delete/i.test(source),
    "AUCUN GRANT DELETE ne doit jamais exister sur cette table -- CE QUI N'EST PAS FAIT : aucun DELETE n'est jamais exécuté"
  );
  assert.ok(
    /check\s*\(status in \('pending', 'processing', 'completed'\)\)/.test(source),
    "NOUVEAU v1.8 -- la contrainte CHECK doit EXACTEMENT autoriser pending/processing/completed -- l'ancien statut à 2 valeurs (v1.7) permettait à claim_ de marquer completed AVANT la suppression Storage réelle"
  );
  assert.ok(/claim_token\s+uuid,/.test(source), "NOUVEAU v1.8 -- colonne claim_token requise (SERVEUR UNIQUEMENT, jamais transmise au navigateur)");
  assert.ok(/lease_until\s+timestamptz,/.test(source), "NOUVEAU v1.8 -- colonne lease_until requise (bail à expiration automatique -- garantit qu'une ligne PROCESSING ne reste jamais bloquée indéfiniment)");
  assert.ok(/attempt_count\s+integer not null default 0,/.test(source), "NOUVEAU v1.8 -- colonne attempt_count requise (traçabilité, jamais utilisée pour bloquer un retry)");
});

test("migration v1.7 (DRAFT Bulk): create_product_photo_pending_cleanup revalide la FORME du old_path DÈS la création (défense en profondeur), service_role UNIQUEMENT", () => {
  const source = readFileSync("supabase/DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql", "utf8");
  const fn = source.slice(
    source.indexOf("create function public.create_product_photo_pending_cleanup("),
    source.indexOf("revoke all on function public.create_product_photo_pending_cleanup")
  );
  assert.ok(fn.includes("public._product_photo_relative_path_shape("), "create_ doit revalider la FORME du old_path via la fonction pure partagée, jamais une validation dupliquée");
  assert.ok(fn.includes("insert into public.product_photo_pending_cleanups"), "create_ doit INSÉRER une ligne PENDING -- seule voie légitime de création");
  assert.ok(
    source.includes("revoke all on function public.create_product_photo_pending_cleanup(uuid, uuid, text, text) from public, anon, authenticated;") &&
      source.includes("grant execute on function public.create_product_photo_pending_cleanup(uuid, uuid, text, text) to service_role;"),
    "create_ doit être service_role UNIQUEMENT -- CLIENT CAN CREATE PENDING CLEANUP: NO"
  );
});

test("migration v1.8 (DRAFT Bulk): claim_product_photo_pending_cleanup -- signature EXACTE à CINQ arguments (p_lease_seconds ajouté, default 120), N'ACCEPTE AUCUN PARAMÈTRE DE CHEMIN, revalide le old_path STOCKÉ (défense en profondeur), réclamation ATOMIQUE vers PROCESSING UNIQUEMENT (JAMAIS directement completed -- SEUL blocker de v1.7 fermé ici)", () => {
  const source = readFileSync("supabase/DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql", "utf8");
  assert.ok(
    /create function public\.claim_product_photo_pending_cleanup\(\s*p_caller_user_id\s+uuid,\s*p_product_id\s+uuid,\s*p_cleanup_id\s+uuid,\s*p_expected_origin\s+text,\s*p_lease_seconds\s+integer\s+default\s+120\s*\)/.test(source),
    "signature EXACTE requise -- AUCUN paramètre oldPath/oldImageUrl/cleanupPath/chemin Storage (CLIENT CLEANUP PATH PARAMETER: NONE), p_lease_seconds AJOUTÉ en v1.8 avec un défaut de 120 secondes"
  );
  const fn = source.slice(
    source.indexOf("create function public.claim_product_photo_pending_cleanup("),
    source.indexOf("revoke all on function public.claim_product_photo_pending_cleanup")
  );
  assert.ok(fn.includes("for update"), "la ligne réclamée doit être verrouillée (sérialisation sous concurrence, item 19 du mandat)");
  assert.ok(
    fn.includes("public._product_photo_relative_path_shape("),
    "claim_ doit REVALIDER la forme du old_path STOCKÉ au moment même de la réclamation -- jamais une confiance perpétuelle envers la validation faite à la création"
  );
  assert.ok(
    !/set\s+status\s*=\s*'completed'/i.test(fn),
    "SOLE BLOCKER v1.8 -- claim_ NE DOIT JAMAIS transitionner directement vers 'completed' -- c'est EXACTEMENT le défaut identifié par Cat Stevens dans v1.7 (COMPLETED marqué AVANT que Storage.remove() ait réellement réussi)"
  );
  assert.ok(
    /update public\.product_photo_pending_cleanups\s+set\s+status\s*=\s*'processing'/i.test(fn),
    "la réclamation doit transitionner vers 'processing', jamais un autre statut"
  );
  assert.ok(
    /where\s+id\s*=\s*p_cleanup_id[\s\S]*status\s*=\s*'pending'[\s\S]*or[\s\S]*status\s*=\s*'processing'[\s\S]*lease_until\s*<\s*now\(\)/i.test(fn),
    "la réclamation doit être conditionnée sur (status='pending' OU (status='processing' ET bail expiré)) -- au plus une réclamation effective, même sous concurrence, ET récupération garantie après expiration du bail"
  );
  assert.ok(/claim_token\s*=\s*v_new_token/.test(fn), "claim_ doit émettre un NOUVEAU claim_token à chaque réclamation réussie (y compris une récupération de bail expiré)");
  assert.ok(/lease_until\s*=\s*now\(\)\s*\+\s*make_interval\(secs\s*=>\s*p_lease_seconds\)/.test(fn), "claim_ doit poser un bail borné (lease_until) à chaque réclamation réussie -- garantit la récupération automatique, JAMAIS un blocage permanent en PROCESSING");
  assert.ok(
    /v_row\.status\s*=\s*'completed'/.test(fn),
    "une ligne 'completed' ne doit JAMAIS être réclamable (mandat item 11 -- completed cleanup retry: no second effective delete)"
  );
  assert.ok(
    source.includes("revoke all on function public.claim_product_photo_pending_cleanup(uuid, uuid, uuid, text, integer) from public, anon, authenticated;") &&
      source.includes("grant execute on function public.claim_product_photo_pending_cleanup(uuid, uuid, uuid, text, integer) to service_role;"),
    "claim_ doit être service_role UNIQUEMENT"
  );
});

test("migration v1.8 (DRAFT Bulk): finalize_product_photo_pending_cleanup transitionne UNIQUEMENT PROCESSING -> COMPLETED (garde WHERE status='processing' AND claim_token EXACT), jamais un nouveau cleanup_id, service_role UNIQUEMENT -- SEULE fonction de ce lot qui atteint 'completed'", () => {
  const source = readFileSync("supabase/DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql", "utf8");
  const fn = source.slice(
    source.indexOf("create function public.finalize_product_photo_pending_cleanup("),
    source.indexOf("revoke all on function public.finalize_product_photo_pending_cleanup")
  );
  assert.ok(
    /where\s+id\s*=\s*p_cleanup_id[\s\S]*status\s*=\s*'processing'[\s\S]*claim_token\s*=\s*p_claim_token/i.test(fn),
    "finalize_ doit être gardée par status='processing' ET claim_token EXACT -- une finalisation tardive (claim_token périmé) ne doit jamais écraser un claim plus récent"
  );
  assert.ok(/set\s+status\s*=\s*'completed'/i.test(fn), "finalize_ doit transitionner vers 'completed' -- c'est la SEULE fonction du lot qui le fait");
  assert.ok(!/old_path\s*=/.test(fn), "finalize_ ne doit JAMAIS modifier old_path -- le même cleanup_id ne doit jamais devenir retargetable vers un autre chemin");
  assert.ok(
    source.includes("revoke all on function public.finalize_product_photo_pending_cleanup(uuid, uuid, uuid, uuid) from public, anon, authenticated;") &&
      source.includes("grant execute on function public.finalize_product_photo_pending_cleanup(uuid, uuid, uuid, uuid) to service_role;"),
    "finalize_ doit être service_role UNIQUEMENT"
  );
});

test("migration v1.8 (DRAFT Bulk): release_product_photo_pending_cleanup transitionne UNIQUEMENT PROCESSING -> PENDING (garde WHERE status='processing' AND claim_token EXACT), efface claim_token/claimed_at/lease_until, service_role UNIQUEMENT -- raccourci de confort NON-BLOQUANT (la récupération durable repose sur l'expiration du bail, jamais sur le seul succès de cet appel)", () => {
  const source = readFileSync("supabase/DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql", "utf8");
  const fn = source.slice(
    source.indexOf("create function public.release_product_photo_pending_cleanup("),
    source.indexOf("revoke all on function public.release_product_photo_pending_cleanup")
  );
  assert.ok(
    /where\s+id\s*=\s*p_cleanup_id[\s\S]*status\s*=\s*'processing'[\s\S]*claim_token\s*=\s*p_claim_token/i.test(fn),
    "release_ doit être gardée par status='processing' ET claim_token EXACT -- une libération tardive (claim_token périmé) ne doit jamais écraser un claim plus récent"
  );
  assert.ok(/set\s+status\s*=\s*'pending'/i.test(fn), "release_ doit transitionner vers 'pending' -- retry immédiat possible sans attendre l'expiration du bail");
  assert.ok(/claim_token\s*=\s*null/i.test(fn), "release_ doit effacer claim_token -- l'ancien jeton ne doit plus autoriser aucune finalisation/libération ultérieure");
  assert.ok(!/old_path\s*=/.test(fn), "release_ ne doit JAMAIS modifier old_path -- le même cleanup_id ne doit jamais devenir retargetable vers un autre chemin");
  assert.ok(
    source.includes("revoke all on function public.release_product_photo_pending_cleanup(uuid, uuid, uuid, uuid) from public, anon, authenticated;") &&
      source.includes("grant execute on function public.release_product_photo_pending_cleanup(uuid, uuid, uuid, uuid) to service_role;"),
    "release_ doit être service_role UNIQUEMENT"
  );
});

test("migration v1.8 (DRAFT Bulk): reopen_product_photo_pending_cleanup (v1.7) est SUPPRIMÉE, jamais recréée -- REMPLACÉE par finalize_/release_ (sa sémantique 'completed' -> 'pending' n'a plus de sens depuis que claim_ ne transitionne plus jamais vers 'completed' elle-même)", () => {
  const source = readFileSync("supabase/DRAFT-lot-bulk-product-photos-storage-authorization-v1.sql", "utf8");
  assert.ok(
    !source.includes("create function public.reopen_product_photo_pending_cleanup("),
    "reopen_product_photo_pending_cleanup ne doit JAMAIS être (re)créée par le fichier forward v1.8"
  );
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

test("catalogue dashboard: ProductPhotoField (product_id existant) reste réservé à l'édition — la création utilise un mécanisme distinct (V67b)", () => {
  const source = readFileSync("app/dashboard/catalogue/page.tsx", "utf8");
  const createBlock = source.slice(
    source.indexOf("creatingIn === cat.category_id"),
    source.indexOf("cat.products.length === 0")
  );
  assert.ok(
    !createBlock.includes("<ProductPhotoField"),
    "ProductPhotoField (product_id existant requis) ne doit pas être utilisé dans le bloc de création"
  );
});
