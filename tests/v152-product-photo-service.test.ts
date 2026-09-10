import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// BULK PRODUCT PHOTOS v1.4/v1.5 — lib/server/product-photo-service.ts.
//
// Ferme, au niveau de l'ORCHESTRATION Node (jamais SQL -- voir
// supabase/tests/v67c-storage-operator-authorization-check.sh pour la
// preuve PostgreSQL réelle des blockers, du verrouillage concurrent,
// et de l'absence de DELETE storage.objects), les 3 blockers + 2
// MEDIUM du réaudit Cat Stevens sur v1.3, PUIS (v1.5) les 2 blockers +
// 1 MEDIUM du réaudit suivant sur v1.4 :
//   - ordre EXACT des opérations (begin_ -> validation -> chemin ->
//     upload -> apply_ -> nettoyage ancienne image) ;
//   - AUCUNE valeur "ancienne image" transmise par ce module au
//     serveur SQL -- old_path est TOUJOURS une valeur RENVOYÉE par
//     apply_, jamais construite ici ;
//   - v1.5 (Blocker 1) : begin_ est appelée EN AS-USER (le seul appel
//     de ce flux qui l'est encore), apply_ est appelée EN SERVICE_ROLE
//     UNIQUEMENT -- avec p_caller_user_id transmis explicitement,
//     obtenu de begin_, jamais recalculé ni fait confiance autrement ;
//   - v1.5 (Blocker 2) : old_path_cleanup_skipped=true (SQL a jugé la
//     référence historique non sûre) se traduit en
//     oldImageCleanup='skipped_unsafe_legacy', .remove() JAMAIS
//     appelé pour ce cas ;
//   - compensation explicite scénarios A (upload échoue), B (apply_
//     échoue après upload), C (nettoyage de l'ancienne image échoue
//     après succès DB), D (rien à nettoyer), E (ancienne référence non
//     sûre, nettoyage sauté).
//
// Patron déjà établi par ce dépôt (tests/v112-payment-p3b0-
// service.test.ts) : `t.mock.method(client, "storage"/"rpc", ...)`
// sur le CLIENT RÉEL construit par getServiceRoleSupabaseClient()
// (singleton partagé) -- désormais utilisé pour DEUX surfaces
// distinctes de ce même client réel (`storage` ET, depuis v1.5,
// `rpc`). `asUserSupabaseClientFactory.create()` construit un client
// NEUF à CHAQUE appel (jamais un singleton) -- mocké via
// `t.mock.method(asUserSupabaseClientFactory, "create", ...)`, un
// objet littéral exporté PAR lib/server/supabase-as-user.ts pour
// cette seule raison (un export de fonction nommée ne peut pas être
// intercepté par t.mock.method sur un espace de nommage ESM -- vérifié
// empiriquement avant d'introduire ce patron, voir le commentaire de
// asUserSupabaseClientFactory). Depuis v1.5, ce client AS-USER n'est
// plus mocké que pour begin_product_photo_replacement -- un test qui
// verrait ce mock recevoir un appel "apply_product_photo_replacement"
// signalerait une régression du Blocker 1 v1.5 (voir le test dédié
// ci-dessous).
//
// v1.7 (Cat Stevens, SEUL blocker de v1.6 -- TRUST BOUNDARY, "cleanup
// retry accepte un oldPath fourni par le client") : `admin.rpc` mocke
// désormais aussi `create_product_photo_pending_cleanup` (appelée par
// cleanupOldImage UNIQUEMENT lorsque Storage .remove() échoue -- voir
// section 6 ci-dessous, scénario C) et (section 10, RÉÉCRITE en v1.8)
// `claim_/finalize_/release_product_photo_pending_cleanup` -- REMPLACE
// retry_product_photo_cleanup_path, SUPPRIMÉE. Les résultats
// replaceProductPhoto/removeProductPhoto exposent désormais
// `cleanupId` (identifiant OPAQUE, uuid) au lieu de `oldPath` -- ce
// module ne fait plus jamais transiter de chemin Storage au-delà de
// l'appel apply_ lui-même.
//
// v1.8 (Cat Stevens, SEUL blocker de v1.7 -- "claim marks completed
// before storage delete") : `claim_product_photo_pending_cleanup`
// renvoie désormais `{ old_path, claim_token }` (au lieu d'un simple
// old_path) et transitionne UNIQUEMENT vers 'processing' -- JAMAIS
// 'completed'. `reopen_product_photo_pending_cleanup` (v1.7) est
// REMPLACÉE par deux fonctions distinctes, chacune exigeant le
// `claim_token` exact : `finalize_product_photo_pending_cleanup`
// (succès Storage -- processing -> completed) et
// `release_product_photo_pending_cleanup` (échec Storage -- processing
// -> pending, retry immédiat). Les tests de la section 10 prouvent que
// CHAQUE appel RPC de ce cycle vérifie EXPLICITEMENT les deux formes
// d'échec Supabase (exception JS ET `{ error }` normal, jamais l'une
// sans l'autre) SANS jamais rendre le résultat surfacé au navigateur
// dépendant du succès de finalize_/release_ elles-mêmes -- la
// récupération durable repose sur le bail (lease) posé par claim_,
// prouvé côté PostgreSQL uniquement (voir
// supabase/tests/v67c-storage-operator-authorization-check.sh).
// ====================================================================

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "v152-synthetic-service-role-key-DO-NOT-USE";

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const admin = getServiceRoleSupabaseClient();
const { asUserSupabaseClientFactory } = await import("../lib/server/supabase-as-user.ts");
const {
  replaceProductPhoto,
  removeProductPhoto,
  retryOldImageCleanup,
  ProductPhotoServerError,
} = await import("../lib/server/product-photo-service.ts");

const UUID_V4_FILENAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/;

function jpegFile(name = "photo.jpg"): File {
  const bytes = new Uint8Array(new ArrayBuffer(64));
  bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff;
  return new File([bytes], name, { type: "image/jpeg" });
}

function textFile(name = "malware.jpg"): File {
  const bytes = new Uint8Array(new ArrayBuffer(64)).fill(0x41);
  return new File([bytes], name, { type: "image/jpeg" });
}

interface FakeAsUserClient {
  rpc: (name: string, args: unknown) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

/** Mock du SEUL appel AS-USER restant depuis v1.5 : begin_product_photo_replacement. */
function mockAsUserClient(t: { mock: { method: typeof import("node:test").mock.method } }, client: FakeAsUserClient) {
  t.mock.method(asUserSupabaseClientFactory, "create", () => client);
}

/** Raccourci pour un begin_ nominal réussi -- restaurant_id + caller_user_id résolus. */
function beginOk(restaurantId = "r1", callerUserId = "u1"): FakeAsUserClient {
  return {
    rpc: async (name: string) => {
      assert.equal(name, "begin_product_photo_replacement", "seul begin_ doit être appelé sur le client AS-USER depuis v1.5 (Blocker 1)");
      return { data: [{ restaurant_id: restaurantId, caller_user_id: callerUserId }], error: null };
    },
  };
}

/**
 * NOUVEAU v2.2 -- même contrat que beginOk, mais renseigne
 * `current_image_url` (déjà lu par begin_ depuis v1.6, requis par le
 * mécanisme de rejeu/conflit v2.2, voir section 11 ci-dessous).
 */
function beginOkWithImage(
  currentImageUrl: string | null,
  restaurantId = "r1",
  callerUserId = "u1"
): FakeAsUserClient {
  return {
    rpc: async (name: string) => {
      assert.equal(name, "begin_product_photo_replacement");
      return {
        data: [{ restaurant_id: restaurantId, caller_user_id: callerUserId, current_image_url: currentImageUrl }],
        error: null,
      };
    },
  };
}

/** Mock d'admin.rpc (apply_product_photo_replacement, SERVICE_ROLE UNIQUEMENT depuis v1.5). */
function mockAdminRpc(
  t: { mock: { method: typeof import("node:test").mock.method } },
  handler: (name: string, args: unknown) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>
) {
  t.mock.method(admin, "rpc", handler);
}

function mockStorage(
  t: { mock: { method: typeof import("node:test").mock.method } },
  opts: {
    uploadError?: { message: string } | null;
    removeError?: { message: string } | null;
    // NOUVEAU v2.2 -- `uploadOpts` (3e argument réel de .upload(), ex.
    // { contentType, upsert }) est désormais transmis au callback, en
    // plus du chemin -- requis pour vérifier `upsert: true` UNIQUEMENT
    // pour une opération Bulk (voir section 11 ci-dessous). Rétro-
    // compatible : tout callback existant qui n'utilise que le 1er
    // paramètre continue de fonctionner à l'identique.
    onUpload?: (path: string, uploadOpts?: { contentType?: string; upsert?: boolean }) => void;
    onRemove?: (paths: string[]) => void;
  } = {}
) {
  t.mock.method(admin.storage, "from", (bucket: string) => ({
    upload: async (path: string, _bytes: unknown, uploadOpts?: { contentType?: string; upsert?: boolean }) => {
      opts.onUpload?.(path, uploadOpts);
      if (opts.uploadError) return { data: null, error: opts.uploadError };
      return { data: { path }, error: null };
    },
    getPublicUrl: (path: string) => ({
      data: { publicUrl: `https://fake.supabase.co/storage/v1/object/public/${bucket}/${path}` },
    }),
    remove: async (paths: string[]) => {
      opts.onRemove?.(paths);
      if (opts.removeError) return { data: null, error: opts.removeError };
      return { data: paths.map((p) => ({ name: p })), error: null };
    },
  }));
}

// --- 1. Chemin d'exécution nominal : ordre exact, chemin généré
// serveur, contrat crypto.randomUUID() v4, nettoyage de l'ancienne
// image APRÈS succès DB. apply_ appelée EN SERVICE_ROLE (v1.5).

test("replaceProductPhoto (nominal): begin_ (AS-USER) -> upload -> apply_ (SERVICE_ROLE) -> remove(old_path), dans cet ordre exact ; chemin généré respecte EXACTEMENT {restaurant}/{product}/{uuid-v4}.{ext}", async (t) => {
  const calls: string[] = [];
  let applyArgs: unknown;

  mockAsUserClient(t, {
    rpc: async (name) => {
      assert.equal(name, "begin_product_photo_replacement");
      calls.push("asUser.rpc:begin_product_photo_replacement");
      return { data: [{ restaurant_id: "r1", caller_user_id: "u1" }], error: null };
    },
  });

  let uploadedPath = "";
  mockStorage(t, {
    onUpload: (path) => { calls.push("storage:upload"); uploadedPath = path; },
    onRemove: () => { calls.push("storage:remove"); },
  });

  mockAdminRpc(t, async (name, args) => {
    assert.equal(name, "apply_product_photo_replacement");
    calls.push("admin.rpc:apply_product_photo_replacement");
    applyArgs = args;
    return {
      data: [{
        old_path: "r1/p1/old-legit.jpg",
        image_url: "https://fake.supabase.co/storage/v1/object/public/product-photos/r1/p1/new.jpg",
        old_path_cleanup_skipped: false,
      }],
      error: null,
    };
  });

  const result = await replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile() });

  assert.deepEqual(
    calls,
    ["asUser.rpc:begin_product_photo_replacement", "storage:upload", "admin.rpc:apply_product_photo_replacement", "storage:remove"],
    "ordre EXACT requis par le mandat -- apply_ doit passer par admin (service_role), jamais asUser"
  );

  assert.equal(uploadedPath.startsWith("r1/p1/"), true, "le chemin doit commencer par restaurant_id/product_id, résolus côté serveur");
  const filename = uploadedPath.split("/")[2];
  assert.match(filename, UUID_V4_FILENAME_RE, "le nom de fichier généré doit respecter EXACTEMENT le contrat crypto.randomUUID() v4 + extension autorisée");

  assert.deepEqual(
    applyArgs,
    {
      p_caller_user_id: "u1",
      p_product_id: "p1",
      p_new_image_url: `https://fake.supabase.co/storage/v1/object/public/product-photos/${uploadedPath}`,
      // NOUVEAU v1.6 (Blocker 1) -- calculée UNIQUEMENT côté serveur via
      // getTrustedStorageOrigin() (NEXT_PUBLIC_SUPABASE_URL, fixée en
      // tête de ce fichier), JAMAIS une valeur cliente.
      p_expected_origin: "https://placeholder.supabase.co",
    },
    "apply_ doit recevoir p_caller_user_id EXACTEMENT tel que résolu par begin_ (v1.5, Blocker 1) -- jamais recalculé, jamais une valeur cliente ; p_expected_origin EXACTEMENT l'origine serveur de confiance (v1.6, Blocker 1) -- signature à 4 paramètres, INCHANGÉE depuis v1.6 (v2.2 ferme LOST HTTP RESPONSE entièrement côté Node, voir section 11 ci-dessous, AUCUN paramètre SQL supplémentaire)"
  );

  assert.equal(result.oldImageCleanup, "removed");
  assert.equal(result.imageUrl, "https://fake.supabase.co/storage/v1/object/public/product-photos/r1/p1/new.jpg");
});

test("replaceProductPhoto: begin_product_photo_replacement est appelée avec EXACTEMENT p_product_id, rien d'autre -- aucune valeur \"ancienne image\" ni \"restaurant\" n'est jamais transmise par ce module (Cat Stevens Blocker 1 v1.4)", async (t) => {
  let beginArgs: unknown;
  mockAsUserClient(t, {
    rpc: async (name, args) => {
      beginArgs = args;
      return { data: [{ restaurant_id: "r1", caller_user_id: "u1" }], error: null };
    },
  });
  mockStorage(t);
  mockAdminRpc(t, async () => ({
    data: [{ old_path: null, image_url: "https://x/storage/v1/object/public/product-photos/r1/p1/n.jpg", old_path_cleanup_skipped: false }],
    error: null,
  }));

  await replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile() });
  assert.deepEqual(beginArgs, { p_product_id: "p1" });
});

test("replaceProductPhoto: apply_ n'est JAMAIS appelée sur le client AS-USER -- SEULEMENT sur le client SERVICE_ROLE (Cat Stevens Blocker 1 v1.5 : plus jamais exposée en REST à authenticated)", async (t) => {
  mockAsUserClient(t, beginOk());
  mockStorage(t);
  let adminRpcCalled = false;
  mockAdminRpc(t, async (name) => {
    assert.equal(name, "apply_product_photo_replacement");
    adminRpcCalled = true;
    return { data: [{ old_path: null, image_url: "https://x/storage/v1/object/public/product-photos/r1/p1/n.jpg", old_path_cleanup_skipped: false }], error: null };
  });

  await replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile() });
  assert.equal(adminRpcCalled, true, "apply_ doit être appelée via le client service_role (admin.rpc)");
  // Le mock AS-USER de beginOk() lève lui-même une assertion s'il
  // recevait autre chose que begin_product_photo_replacement -- si ce
  // test passe, aucun appel apply_ n'a atteint le client AS-USER.
});

// --- 2. Autorisation : begin_ échoue -> AUCUN upload, AUCUN apply_.

test("replaceProductPhoto: begin_ refuse (42501, forbidden) -- ProductPhotoServerError('forbidden'), AUCUN upload tenté", async (t) => {
  let uploadCalled = false;
  mockAsUserClient(t, { rpc: async () => ({ data: null, error: { code: "42501", message: "Not authorized for this product" } }) });
  mockStorage(t, { onUpload: () => { uploadCalled = true; } });

  await assert.rejects(
    () => replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile() }),
    (e: unknown) => {
      assert.ok(e instanceof ProductPhotoServerError);
      assert.equal((e as InstanceType<typeof ProductPhotoServerError>).reason, "forbidden");
      return true;
    }
  );
  assert.equal(uploadCalled, false, "aucun upload ne doit être tenté avant une autorisation réussie");
});

test("replaceProductPhoto: begin_ -- produit introuvable/archivé (P0002) -- reason 'not_found'", async (t) => {
  mockAsUserClient(t, { rpc: async () => ({ data: null, error: { code: "P0002", message: "Product not found or archived" } }) });
  mockStorage(t);
  await assert.rejects(
    () => replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile() }),
    (e: unknown) => (e as InstanceType<typeof ProductPhotoServerError>).reason === "not_found"
  );
});

test("replaceProductPhoto: begin_ -- non authentifié (28000) -- reason 'auth'", async (t) => {
  mockAsUserClient(t, { rpc: async () => ({ data: null, error: { code: "28000", message: "Authentication required" } }) });
  mockStorage(t);
  await assert.rejects(
    () => replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile() }),
    (e: unknown) => (e as InstanceType<typeof ProductPhotoServerError>).reason === "auth"
  );
});

test("replaceProductPhoto: begin_ renvoie une ligne sans caller_user_id (donnée corrompue/inattendue) -- reason 'unavailable', AUCUN upload tenté", async (t) => {
  let uploadCalled = false;
  mockAsUserClient(t, { rpc: async () => ({ data: [{ restaurant_id: "r1" }], error: null }) });
  mockStorage(t, { onUpload: () => { uploadCalled = true; } });

  await assert.rejects(
    () => replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile() }),
    (e: unknown) => (e as InstanceType<typeof ProductPhotoServerError>).reason === "unavailable"
  );
  assert.equal(uploadCalled, false);
});

// --- 3. Validation de fichier -- AUTORITAIRE, APRÈS begin_ (défense en
// profondeur : l'autorisation est toujours vérifiée en premier).

test("replaceProductPhoto: fichier invalide (octets réels, pas l'extension) -- reason 'invalid_file', AUCUN upload tenté", async (t) => {
  let uploadCalled = false;
  mockAsUserClient(t, beginOk());
  mockStorage(t, { onUpload: () => { uploadCalled = true; } });

  await assert.rejects(
    () => replaceProductPhoto({ accessToken: "tok", productId: "p1", file: textFile() }),
    (e: unknown) => (e as InstanceType<typeof ProductPhotoServerError>).reason === "invalid_file"
  );
  assert.equal(uploadCalled, false);
});

// --- 4. Scénario A : upload échoue -- DB inchangée, rien à nettoyer.

test("replaceProductPhoto (scénario A): upload échoue -- reason 'unavailable', apply_ JAMAIS appelée, aucune compensation nécessaire", async (t) => {
  let applyCalled = false;
  mockAsUserClient(t, beginOk());
  mockStorage(t, { uploadError: { message: "network error (simulated)" } });
  mockAdminRpc(t, async () => {
    applyCalled = true;
    return { data: [{ old_path: null, image_url: null, old_path_cleanup_skipped: false }], error: null };
  });

  await assert.rejects(
    () => replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile() }),
    (e: unknown) => (e as InstanceType<typeof ProductPhotoServerError>).reason === "unavailable"
  );
  assert.equal(applyCalled, false, "scénario A : la DB ne doit jamais être touchée si l'upload lui-même a échoué");
});

// --- 5. Scénario B : upload réussit, apply_ échoue -- le nouvel upload
// orphelin est nettoyé ici, best-effort.

test("replaceProductPhoto (scénario B): upload réussit puis apply_ échoue -- le NOUVEL upload orphelin est supprimé (compensation), l'erreur d'origine (apply_) est celle remontée", async (t) => {
  let uploadedPath = "";
  const removedPaths: string[][] = [];
  mockAsUserClient(t, beginOk());
  mockStorage(t, {
    onUpload: (path) => { uploadedPath = path; },
    onRemove: (paths) => { removedPaths.push(paths); },
  });
  mockAdminRpc(t, async () => ({ data: null, error: { code: "P0002", message: "Product not found or archived" } }));

  await assert.rejects(
    () => replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile() }),
    (e: unknown) => (e as InstanceType<typeof ProductPhotoServerError>).reason === "not_found"
  );

  assert.equal(removedPaths.length, 1, "le nouvel upload orphelin doit être nettoyé, best-effort, exactement une fois");
  assert.deepEqual(removedPaths[0], [uploadedPath], "SEUL le fichier qui vient d'être uploadé (jamais un autre chemin) est nettoyé ici");
});

test("replaceProductPhoto (scénario B, échec de compensation): même si le nettoyage best-effort de l'upload orphelin échoue, l'erreur remontée reste celle d'apply_ (jamais masquée par l'échec de compensation)", async (t) => {
  mockAsUserClient(t, beginOk());
  mockStorage(t, { removeError: { message: "compensation cleanup also failed (simulated)" } });
  mockAdminRpc(t, async () => ({ data: null, error: { code: "42501", message: "Not authorized for this product" } }));

  await assert.rejects(
    () => replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile() }),
    (e: unknown) => (e as InstanceType<typeof ProductPhotoServerError>).reason === "forbidden"
  );
});

// --- 6. Scénario C : apply_ réussit, suppression de l'ancienne image
// échoue -- la nouvelle valeur DB reste AUTORITAIRE, échec surfacé.

test("replaceProductPhoto (scénario C): apply_ réussit mais la suppression Storage de l'ancienne image échoue -- résultat SUCCÈS (nouvelle valeur DB autoritaire), oldImageCleanup='failed', AUCUN rollback ; NOUVEAU v1.7 : une AUTORITÉ DE NETTOYAGE DURABLE (cleanup_id) est créée EXCLUSIVEMENT à partir du old_path DÉJÀ validé par apply_", async (t) => {
  mockAsUserClient(t, beginOk());
  mockStorage(t, { removeError: { message: "storage transient failure (simulated)" } });
  let createArgs: unknown;
  mockAdminRpc(t, async (name, args) => {
    if (name === "apply_product_photo_replacement") {
      return {
        data: [{
          old_path: "r1/p1/old.jpg",
          image_url: "https://fake.supabase.co/storage/v1/object/public/product-photos/r1/p1/new.jpg",
          old_path_cleanup_skipped: false,
        }],
        error: null,
      };
    }
    assert.equal(name, "create_product_photo_pending_cleanup", "NOUVEAU v1.7 -- seul create_ doit être appelé après un échec de Storage .remove(), jamais une autre RPC");
    createArgs = args;
    return { data: "cleanup-uuid-123", error: null };
  });

  const result = await replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile() });
  assert.equal(result.oldImageCleanup, "failed");
  assert.equal(result.imageUrl, "https://fake.supabase.co/storage/v1/object/public/product-photos/r1/p1/new.jpg", "la nouvelle valeur DB doit rester AUTORITAIRE, jamais annulée à cause d'un échec de nettoyage de l'ancienne image");
  assert.equal(result.cleanupId, "cleanup-uuid-123", "NOUVEAU v1.7 -- le cleanup_id renvoyé par create_ (SERVICE_ROLE), JAMAIS un chemin, doit être propagé tel quel jusqu'au résultat");
  assert.deepEqual(
    createArgs,
    {
      p_caller_user_id: "u1",
      p_product_id: "p1",
      p_old_path: "r1/p1/old.jpg",
      p_expected_origin: "https://placeholder.supabase.co",
    },
    "create_ doit recevoir EXACTEMENT le old_path déjà renvoyé par apply_ (jamais une valeur reconstruite ici, jamais une valeur cliente) et p_caller_user_id résolu par begin_"
  );
});

test("replaceProductPhoto (scénario C, échec de création de l'autorité de nettoyage): create_product_photo_pending_cleanup échoue elle-même -- oldImageCleanup reste 'failed', cleanupId=null (dégradation seulement -- jamais un état incohérent)", async (t) => {
  mockAsUserClient(t, beginOk());
  mockStorage(t, { removeError: { message: "storage transient failure (simulated)" } });
  mockAdminRpc(t, async (name) => {
    if (name === "apply_product_photo_replacement") {
      return {
        data: [{ old_path: "r1/p1/old.jpg", image_url: "https://fake.supabase.co/storage/v1/object/public/product-photos/r1/p1/new.jpg", old_path_cleanup_skipped: false }],
        error: null,
      };
    }
    return { data: null, error: { code: "58000", message: "simulated create_ failure" } };
  });

  const result = await replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile() });
  assert.equal(result.oldImageCleanup, "failed");
  assert.equal(result.cleanupId, null, "un cleanup_id ne doit JAMAIS être inventé si sa création côté SQL a elle-même échoué");
});

// --- 7. Scénario D : rien à nettoyer (première photo du produit).

test("replaceProductPhoto (scénario D): apply_ renvoie old_path=null, old_path_cleanup_skipped=false (première photo du produit) -- oldImageCleanup='not_applicable', .remove() JAMAIS appelé", async (t) => {
  let removeCalled = false;
  mockAsUserClient(t, beginOk());
  mockStorage(t, { onRemove: () => { removeCalled = true; } });
  mockAdminRpc(t, async () => ({
    data: [{ old_path: null, image_url: "https://fake.supabase.co/storage/v1/object/public/product-photos/r1/p1/new.jpg", old_path_cleanup_skipped: false }],
    error: null,
  }));

  const result = await replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile() });
  assert.equal(result.oldImageCleanup, "not_applicable");
  assert.equal(removeCalled, false);
});

// --- 7b. Scénario E (NOUVEAU v1.5, Blocker 2) : ancienne référence DB
// jugée non sûre par SQL -- old_path_cleanup_skipped=true -- JAMAIS
// transmise à .remove(), résultat SUCCÈS quand même.

test("replaceProductPhoto (scénario E, v1.5 Blocker 2): apply_ renvoie old_path_cleanup_skipped=true (référence historique non sûre) -- oldImageCleanup='skipped_unsafe_legacy', .remove() JAMAIS appelé, remplacement quand même SUCCÈS", async (t) => {
  let removeCalled = false;
  mockAsUserClient(t, beginOk());
  mockStorage(t, { onRemove: () => { removeCalled = true; } });
  mockAdminRpc(t, async () => ({
    data: [{
      old_path: null,
      image_url: "https://fake.supabase.co/storage/v1/object/public/product-photos/r1/p1/new.jpg",
      old_path_cleanup_skipped: true,
    }],
    error: null,
  }));

  const result = await replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile() });
  assert.equal(result.oldImageCleanup, "skipped_unsafe_legacy");
  assert.equal(removeCalled, false, "une référence jugée non sûre par SQL ne doit JAMAIS être transmise à Storage .remove()");
  assert.equal(result.imageUrl, "https://fake.supabase.co/storage/v1/object/public/product-photos/r1/p1/new.jpg", "le remplacement lui-même reste un succès -- seul le nettoyage de la référence non sûre est sauté");
});

// --- 8. removeProductPhoto -- même contrat de provenance/compensation.
// Depuis v1.5, begin_ est OBLIGATOIRE (seul moyen d'obtenir
// caller_user_id -- apply_ n'accepte plus d'appel AS-USER).

test("removeProductPhoto (nominal): begin_ (AS-USER) -> apply_(caller_user_id, productId, null) (SERVICE_ROLE) -> supprime old_path via l'API Storage réelle", async (t) => {
  let applyArgs: unknown;
  let removedPaths: string[] = [];
  mockAsUserClient(t, beginOk("r1", "u1"));
  mockStorage(t, { onRemove: (paths) => { removedPaths = paths; } });
  mockAdminRpc(t, async (name, args) => {
    assert.equal(name, "apply_product_photo_replacement");
    applyArgs = args;
    return { data: [{ old_path: "r1/p1/old.jpg", image_url: null, old_path_cleanup_skipped: false }], error: null };
  });

  const result = await removeProductPhoto({ accessToken: "tok", productId: "p1" });
  assert.deepEqual(applyArgs, {
    p_caller_user_id: "u1",
    p_product_id: "p1",
    p_new_image_url: null,
    p_expected_origin: "https://placeholder.supabase.co",
  });
  assert.deepEqual(removedPaths, ["r1/p1/old.jpg"]);
  assert.equal(result.oldImageCleanup, "removed");
});

test("removeProductPhoto: begin_ refuse -- ProductPhotoServerError, apply_ JAMAIS appelée (v1.5 : begin_ est désormais un préalable obligatoire, pas seulement pour replaceProductPhoto)", async (t) => {
  let applyCalled = false;
  mockAsUserClient(t, { rpc: async () => ({ data: null, error: { code: "42501", message: "Not authorized for this product" } }) });
  mockAdminRpc(t, async () => {
    applyCalled = true;
    return { data: [{ old_path: null, image_url: null, old_path_cleanup_skipped: false }], error: null };
  });

  await assert.rejects(
    () => removeProductPhoto({ accessToken: "tok", productId: "p1" }),
    (e: unknown) => (e as InstanceType<typeof ProductPhotoServerError>).reason === "forbidden"
  );
  assert.equal(applyCalled, false);
});

test("removeProductPhoto: produit sans photo (old_path=null) -- oldImageCleanup='not_applicable', .remove() jamais appelé", async (t) => {
  let removeCalled = false;
  mockAsUserClient(t, beginOk());
  mockStorage(t, { onRemove: () => { removeCalled = true; } });
  mockAdminRpc(t, async () => ({ data: [{ old_path: null, image_url: null, old_path_cleanup_skipped: false }], error: null }));

  const result = await removeProductPhoto({ accessToken: "tok", productId: "p1" });
  assert.equal(result.oldImageCleanup, "not_applicable");
  assert.equal(removeCalled, false);
});

test("removeProductPhoto (v1.5 Blocker 2): old_path_cleanup_skipped=true -- oldImageCleanup='skipped_unsafe_legacy', .remove() jamais appelé", async (t) => {
  let removeCalled = false;
  mockAsUserClient(t, beginOk());
  mockStorage(t, { onRemove: () => { removeCalled = true; } });
  mockAdminRpc(t, async () => ({ data: [{ old_path: null, image_url: null, old_path_cleanup_skipped: true }], error: null }));

  const result = await removeProductPhoto({ accessToken: "tok", productId: "p1" });
  assert.equal(result.oldImageCleanup, "skipped_unsafe_legacy");
  assert.equal(removeCalled, false);
});

test("removeProductPhoto: apply_ refuse (cross-tenant/inexistant, P0002) -- ProductPhotoServerError('not_found'), aucune suppression Storage tentée", async (t) => {
  let removeCalled = false;
  mockAsUserClient(t, beginOk());
  mockStorage(t, { onRemove: () => { removeCalled = true; } });
  mockAdminRpc(t, async () => ({ data: null, error: { code: "P0002", message: "Product not found or archived" } }));

  await assert.rejects(
    () => removeProductPhoto({ accessToken: "tok", productId: "p1" }),
    (e: unknown) => (e as InstanceType<typeof ProductPhotoServerError>).reason === "not_found"
  );
  assert.equal(removeCalled, false);
});

// --- 9. Aucune fuite de message technique -- le message PRINCIPAL de
// ProductPhotoServerError est toujours générique, jamais construit à
// partir de l'erreur SQL/Storage brute.

test("ProductPhotoServerError: message principal toujours générique (jamais le message SQL/Storage brut), détail technique disponible via .cause", async (t) => {
  const technicalMessage = "permission denied for table menu_items -- schema internals exposed";
  mockAsUserClient(t, { rpc: async () => ({ data: null, error: { code: "42501", message: technicalMessage } }) });
  mockStorage(t);

  await assert.rejects(
    () => replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile() }),
    (e: unknown) => {
      const err = e as InstanceType<typeof ProductPhotoServerError>;
      assert.notEqual(err.message, technicalMessage);
      assert.ok(JSON.stringify(err.cause).includes(technicalMessage), "le détail technique doit rester accessible via .cause pour le debug/log");
      return true;
    }
  );
});

// --- 10. NOUVEAU v1.7, RÉÉCRITE v1.8 (Cat Stevens, SEUL blocker de v1.7
// restant -- "claim marks completed before storage delete") --
// retryOldImageCleanup : begin_ (AS-USER) -> claim_product_photo_
// pending_cleanup (SERVICE_ROLE, cleanup_id OPAQUE, JAMAIS un chemin,
// transitionne UNIQUEMENT vers 'processing', renvoie { old_path,
// claim_token }) -> Storage .remove() SEULEMENT si une ligne est
// réclamée -> succès : finalize_product_photo_pending_cleanup
// (claim_token EXACT requis) ; échec : release_product_photo_pending_
// cleanup (claim_token EXACT requis). Les DEUX (finalize_/release_)
// sont appelées EN BEST-EFFORT -- leur propre échec (exception JS OU
// `{ error }` Supabase normal, LES DEUX explicitement vérifiés, jamais
// ignorés) ne change JAMAIS le résultat surfacé au navigateur : le bail
// (lease) posé par claim_ garantit la récupération durable
// indépendamment (mandat "no reopen-or-die design"). N'appelle JAMAIS
// apply_product_photo_replacement (BULK RETRY INVARIANT). claim_token
// n'apparaît JAMAIS dans RetryOldImageCleanupResult -- il reste
// entièrement côté serveur (variable locale uniquement).

test("retryOldImageCleanup (nominal): begin_ -> claim_ (cleanup_id OPAQUE, JAMAIS un chemin) -> remove(chemin réclamé) -> finalize_ (claim_token EXACT) -> 'removed'", async (t) => {
  const calls: string[] = [];
  let claimArgs: unknown;
  let finalizeArgs: unknown;
  mockAsUserClient(t, {
    rpc: async (name) => {
      assert.equal(name, "begin_product_photo_replacement");
      calls.push("asUser.rpc:begin_product_photo_replacement");
      return { data: [{ restaurant_id: "r1", caller_user_id: "u1" }], error: null };
    },
  });
  let removedPaths: string[] = [];
  mockStorage(t, { onRemove: (paths) => { calls.push("storage:remove"); removedPaths = paths; } });
  mockAdminRpc(t, async (name, args) => {
    calls.push(`admin.rpc:${name}`);
    if (name === "claim_product_photo_pending_cleanup") {
      claimArgs = args;
      return { data: [{ old_path: "r1/p1/old.jpg", claim_token: "token-abc-123" }], error: null };
    }
    assert.equal(name, "finalize_product_photo_pending_cleanup", "retryOldImageCleanup ne doit JAMAIS appeler apply_product_photo_replacement (BULK RETRY INVARIANT)");
    finalizeArgs = args;
    return { data: true, error: null };
  });

  const result = await retryOldImageCleanup({ accessToken: "tok", productId: "p1", cleanupId: "cleanup-uuid-123" });

  assert.deepEqual(
    calls,
    [
      "asUser.rpc:begin_product_photo_replacement",
      "admin.rpc:claim_product_photo_pending_cleanup",
      "storage:remove",
      "admin.rpc:finalize_product_photo_pending_cleanup",
    ],
    "ordre EXACT -- réautorisation, PUIS réclamation SEULE (aucune mutation menu_items), PUIS SEULEMENT ALORS Storage .remove(), PUIS SEULEMENT APRÈS SUCCÈS finalize_ (JAMAIS avant -- SOLE BLOCKER v1.8 fermé)"
  );
  assert.deepEqual(
    claimArgs,
    { p_caller_user_id: "u1", p_product_id: "p1", p_cleanup_id: "cleanup-uuid-123", p_expected_origin: "https://placeholder.supabase.co" },
    "claim_ ne reçoit JAMAIS de chemin -- cleanupId n'est qu'une clé de recherche opaque, transmise TELLE QUELLE"
  );
  assert.deepEqual(removedPaths, ["r1/p1/old.jpg"], "SEUL le chemin RÉCLAMÉ côté SQL (jamais input.cleanupId lui-même) est transmis à Storage .remove()");
  assert.deepEqual(
    finalizeArgs,
    { p_caller_user_id: "u1", p_product_id: "p1", p_cleanup_id: "cleanup-uuid-123", p_claim_token: "token-abc-123" },
    "finalize_ doit recevoir EXACTEMENT le claim_token renvoyé par claim_ -- jamais reconstruit, jamais omis"
  );
  assert.equal(result.oldImageCleanup, "removed");
  assert.deepEqual(Object.keys(result), ["oldImageCleanup"], "claim_token ne doit JAMAIS apparaître dans RetryOldImageCleanupResult -- reste entièrement côté serveur");
});

test("retryOldImageCleanup: claim_ ne réclame RIEN (data=[] -- cleanup_id fabriqué/inexistant/déjà completed/processing avec bail encore valide/autre tenant-produit/chemin stocké invalide) -- 'skipped_unsafe_legacy', Storage .remove() JAMAIS appelé, finalize_/release_ JAMAIS appelées", async (t) => {
  let removeCalled = false;
  let secondRpcCalled = false;
  mockAsUserClient(t, beginOk());
  mockStorage(t, { onRemove: () => { removeCalled = true; } });
  mockAdminRpc(t, async (name) => {
    if (name === "claim_product_photo_pending_cleanup") {
      return { data: [], error: null };
    }
    secondRpcCalled = true;
    return { data: null, error: null };
  });

  const result = await retryOldImageCleanup({ accessToken: "tok", productId: "p1", cleanupId: "fabricated-or-consumed" });
  assert.equal(result.oldImageCleanup, "skipped_unsafe_legacy");
  assert.equal(removeCalled, false, "un cleanup_id qui ne réclame RIEN ne doit JAMAIS déclencher de Storage .remove()");
  assert.equal(secondRpcCalled, false, "ni finalize_ ni release_ ne doivent être appelées si RIEN n'a été réclamé");
});

test("retryOldImageCleanup: Storage .remove() échoue APRÈS une réclamation réussie -- 'failed', release_product_photo_pending_cleanup appelée EN BEST-EFFORT avec le MÊME cleanup_id ET le claim_token EXACT (jamais un nouveau cleanup_id, jamais un retargetage) -- MANDAT items 03/18", async (t) => {
  const rpcCalls: string[] = [];
  let releaseArgs: unknown;
  mockAsUserClient(t, beginOk());
  mockStorage(t, { removeError: { message: "storage transient failure (simulated)" } });
  mockAdminRpc(t, async (name, args) => {
    rpcCalls.push(name);
    if (name === "claim_product_photo_pending_cleanup") {
      return { data: [{ old_path: "r1/p1/old.jpg", claim_token: "token-xyz-789" }], error: null };
    }
    assert.equal(name, "release_product_photo_pending_cleanup");
    releaseArgs = args;
    return { data: true, error: null };
  });

  const result = await retryOldImageCleanup({ accessToken: "tok", productId: "p1", cleanupId: "cleanup-uuid-123" });
  assert.equal(result.oldImageCleanup, "failed");
  assert.deepEqual(rpcCalls, ["claim_product_photo_pending_cleanup", "release_product_photo_pending_cleanup"]);
  assert.deepEqual(
    releaseArgs,
    { p_caller_user_id: "u1", p_product_id: "p1", p_cleanup_id: "cleanup-uuid-123", p_claim_token: "token-xyz-789" },
    "release_ doit recevoir EXACTEMENT le MÊME cleanup_id ET le claim_token EXACT renvoyé par claim_ -- jamais un nouveau, jamais un retargetage vers un autre chemin"
  );
});

test("retryOldImageCleanup: finalize_ LÈVE une exception (échec transport/réseau) après un Storage .remove() qui a RÉUSSI -- le résultat surfacé reste 'removed' (NON-BLOQUANT PAR CONCEPTION -- Storage a réellement réussi, le bail garantit la finalisation éventuelle), jamais une exception non gérée qui masquerait le résultat", async (t) => {
  mockAsUserClient(t, beginOk());
  mockStorage(t);
  mockAdminRpc(t, async (name) => {
    if (name === "claim_product_photo_pending_cleanup") {
      return { data: [{ old_path: "r1/p1/old.jpg", claim_token: "token-throw" }], error: null };
    }
    assert.equal(name, "finalize_product_photo_pending_cleanup");
    throw new Error("simulated network failure during finalize_");
  });

  const result = await retryOldImageCleanup({ accessToken: "tok", productId: "p1", cleanupId: "cleanup-uuid-123" });
  assert.equal(result.oldImageCleanup, "removed", "un échec de finalize_ (exception JS, VÉRIFIÉE via try/catch, jamais ignorée) ne doit JAMAIS changer le résultat -- Storage.remove() a réellement réussi");
});

test("retryOldImageCleanup: finalize_ renvoie un `{ error }` Supabase NORMAL (jamais une exception) après un Storage .remove() qui a RÉUSSI -- le résultat surfacé reste 'removed', l'erreur est VÉRIFIÉE (destructurée) mais délibérément non fatale", async (t) => {
  mockAsUserClient(t, beginOk());
  mockStorage(t);
  let finalizeErrorSeen = false;
  mockAdminRpc(t, async (name) => {
    if (name === "claim_product_photo_pending_cleanup") {
      return { data: [{ old_path: "r1/p1/old.jpg", claim_token: "token-error-result" }], error: null };
    }
    assert.equal(name, "finalize_product_photo_pending_cleanup");
    finalizeErrorSeen = true;
    return { data: null, error: { code: "58000", message: "simulated finalize_ {error} result -- ligne déjà reréclamée par un claim plus récent après expiration du bail" } };
  });

  const result = await retryOldImageCleanup({ accessToken: "tok", productId: "p1", cleanupId: "cleanup-uuid-123" });
  assert.equal(finalizeErrorSeen, true, "finalize_ doit bien avoir été appelée (le mock l'a vue)");
  assert.equal(result.oldImageCleanup, "removed", "un `{ error }` Supabase normal renvoyé par finalize_ (JAMAIS ignoré, contrairement au v1.7 catch{} nu) ne doit JAMAIS changer le résultat -- Storage.remove() a réellement réussi, non fatal par conception");
});

test("retryOldImageCleanup: release_ LÈVE une exception (échec transport/réseau) après un échec de Storage .remove() -- le résultat surfacé reste 'failed' (NON-BLOQUANT PAR CONCEPTION -- le bail garantit la récupération durable indépendamment de cet appel)", async (t) => {
  mockAsUserClient(t, beginOk());
  mockStorage(t, { removeError: { message: "storage transient failure (simulated)" } });
  mockAdminRpc(t, async (name) => {
    if (name === "claim_product_photo_pending_cleanup") {
      return { data: [{ old_path: "r1/p1/old.jpg", claim_token: "token-throw-release" }], error: null };
    }
    assert.equal(name, "release_product_photo_pending_cleanup");
    throw new Error("simulated network failure during release_");
  });

  const result = await retryOldImageCleanup({ accessToken: "tok", productId: "p1", cleanupId: "cleanup-uuid-123" });
  assert.equal(result.oldImageCleanup, "failed", "un échec de release_ (exception JS, VÉRIFIÉE via try/catch, jamais ignorée) ne doit JAMAIS masquer l'échec réel de Storage .remove() -- le bail garantit la récupération durable indépendamment (jamais 'reopen-or-die')");
});

test("retryOldImageCleanup: release_ renvoie un `{ error }` Supabase NORMAL (jamais une exception) après un échec de Storage .remove() -- le résultat surfacé reste 'failed', l'erreur est VÉRIFIÉE (destructurée) mais délibérément non fatale (mandat items 05/06)", async (t) => {
  mockAsUserClient(t, beginOk());
  mockStorage(t, { removeError: { message: "storage transient failure (simulated)" } });
  let releaseErrorSeen = false;
  mockAdminRpc(t, async (name) => {
    if (name === "claim_product_photo_pending_cleanup") {
      return { data: [{ old_path: "r1/p1/old.jpg", claim_token: "token-error-release" }], error: null };
    }
    assert.equal(name, "release_product_photo_pending_cleanup");
    releaseErrorSeen = true;
    return { data: null, error: { code: "58000", message: "simulated release_ {error} result -- claim_token périmé" } };
  });

  const result = await retryOldImageCleanup({ accessToken: "tok", productId: "p1", cleanupId: "cleanup-uuid-123" });
  assert.equal(releaseErrorSeen, true, "release_ doit bien avoir été appelée (le mock l'a vue)");
  assert.equal(result.oldImageCleanup, "failed", "un `{ error }` Supabase normal renvoyé par release_ (JAMAIS ignoré, contrairement au v1.7 catch{} nu) ne doit JAMAIS être escaladé -- la ligne PROCESSING reste récupérable UNIQUEMENT par expiration du bail, propriété durable au niveau SQL, jamais dépendante du succès de cet appel Node");
});

test("retryOldImageCleanup: begin_ refuse -- ProductPhotoServerError, claim_ JAMAIS appelée (réautorisation complète requise avant toute réclamation, comme pour un remplacement)", async (t) => {
  let claimCalled = false;
  mockAsUserClient(t, { rpc: async () => ({ data: null, error: { code: "42501", message: "Not authorized for this product" } }) });
  mockAdminRpc(t, async () => {
    claimCalled = true;
    return { data: [{ old_path: "r1/p1/old.jpg", claim_token: "token-unreachable" }], error: null };
  });

  await assert.rejects(
    () => retryOldImageCleanup({ accessToken: "tok", productId: "p1", cleanupId: "cleanup-uuid-123" }),
    (e: unknown) => (e as InstanceType<typeof ProductPhotoServerError>).reason === "forbidden"
  );
  assert.equal(claimCalled, false);
});

test("retryOldImageCleanup: JAMAIS un appel à apply_product_photo_replacement, quel que soit le résultat -- BULK RETRY INVARIANT vérifié explicitement", async (t) => {
  mockAsUserClient(t, beginOk());
  mockStorage(t);
  mockAdminRpc(t, async (name) => {
    assert.notEqual(name, "apply_product_photo_replacement", "retryOldImageCleanup ne doit JAMAIS rejouer le remplacement complet");
    if (name === "claim_product_photo_pending_cleanup") {
      return { data: [{ old_path: "r1/p1/old.jpg", claim_token: "token-invariant" }], error: null };
    }
    return { data: true, error: null };
  });

  await retryOldImageCleanup({ accessToken: "tok", productId: "p1", cleanupId: "cleanup-uuid-123" });
});


// --- 11. NOUVEAU v2.2 -- LOST HTTP RESPONSE / SUCCESSFUL REPLAY (BULK
// PRODUCT PHOTOS FINAL SIMPLIFICATION, décision CIO), RÉÉCRITE v2.2.1
// (Cat Stevens, réaudit final de v2.2 -- SOLE BLOCKER : "current
// old-Bulk-retry conflict detection is performed using an unlocked
// earlier read"). ANNULE ET REMPLACE le mécanisme de décision v2.2
// (comparaison Node, AVANT tout verrou, de `current_image_url` lue par
// begin_) :
//   - `batchId` (fourni) dérive, combiné à restaurant_id/product_id
//     RÉSOLUS CÔTÉ SERVEUR par begin_, un chemin/une image
//     DÉTERMINISTE (jamais transmis par le client) -- IDENTIQUE pour
//     un premier Apply et pour un retry ;
//   - `isRetry` FAUX (premier Apply, Bulk ou Single Photo Edit) --
//     remplacement DE MASSE inconditionnel, AUCUNE comparaison, ZÉRO
//     changement de comportement depuis v2.2 (apply_ appelée avec
//     `p_is_retry` OMIS, signature à 4 arguments STRICTEMENT
//     inchangée, voir section 1) ;
//   - `isRetry` VRAI -- ZÉRO upload : ce module appelle DIRECTEMENT
//     apply_product_photo_replacement (`p_is_retry: true`), qui
//     verrouille la ligne PUIS SEULEMENT ALORS compare l'image
//     actuellement autoritaire à la cible déterministe transmise --
//     modèle strictement BINAIRE : ALREADY_APPLIED
//     (`already_applied: true`, succès, ZÉRO mutation) ou CONFLICT
//     (SQLSTATE 'P0004', ZÉRO mutation), jamais un troisième cas
//     "continue sous incertitude" (le cas B de l'ancien modèle v2.2
//     A/B/C est RETIRÉ -- une relecture ne "continue" plus jamais).
// Les mocks `admin.rpc` de cette section simulent fidèlement ce
// comportement SOUS VERROU (état "image actuellement autoritaire" tenu
// en mémoire par test, jamais une simple substitution de réponse) --
// la preuve du verrouillage RÉEL (deux sessions PostgreSQL concurrentes)
// reste exclusivement du ressort de
// supabase/tests/v67c-storage-operator-authorization-check.sh (voir ce
// fichier, section MANDATORY RACE TEST). Scénarios mandatés couverts
// explicitement ici : LOST RESPONSE (retry après succès réel non reçu
// -> ALREADY_APPLIED), LATER-CHANGE (retry après qu'un AUTRE
// changement légitime a eu lieu -> CONFLICT, jamais écrasé), et FIRST
// APPLY REGRESSION (le premier Apply reste un remplacement de masse
// inconditionnel, jamais accidentellement soumis à la sémantique
// conservatrice du retry).

/**
 * NOUVEAU v2.2.1 -- simule, côté Node, le comportement SOUS VERROU de
 * apply_product_photo_replacement pour UN SEUL produit : maintient
 * l'image "actuellement autoritaire" en mémoire (état local au test,
 * jamais partagé), reproduit EXACTEMENT le modèle binaire pour
 * `p_is_retry=true` (already_applied si `current === p_new_image_url`,
 * sinon exception SQLSTATE 'P0004') et le remplacement inconditionnel
 * pour `p_is_retry` omis/false -- un VRAI modèle d'état, pas une simple
 * réponse fixe, pour que ces tests exercent la même logique de décision
 * que le SQL réel.
 */
function mockApplyStateful(
  t: { mock: { method: typeof import("node:test").mock.method } },
  initialImage: string | null,
  onCall?: (args: { p_new_image_url: string | null; p_is_retry?: boolean }) => void
): { setCurrent: (v: string | null) => void; getCurrent: () => string | null } {
  let current = initialImage;
  mockAdminRpc(t, async (name, args) => {
    assert.equal(name, "apply_product_photo_replacement");
    const a = args as { p_new_image_url: string | null; p_is_retry?: boolean };
    onCall?.(a);
    if (a.p_is_retry) {
      if (current === a.p_new_image_url) {
        return {
          data: [{ old_path: null, image_url: current, old_path_cleanup_skipped: false, already_applied: true }],
          error: null,
        };
      }
      return { data: null, error: { code: "P0004", message: "Photo replacement conflict" } };
    }
    const old = current;
    current = a.p_new_image_url;
    return {
      data: [{ old_path: old ? "r1/p1/old-legit.jpg" : null, image_url: current, old_path_cleanup_skipped: false, already_applied: false }],
      error: null,
    };
  });
  return { setCurrent: (v: string | null) => { current = v; }, getCurrent: () => current };
}

test("replaceProductPhoto: batchId absent (Single Photo Edit) -- chemin ALÉATOIRE, upsert:false, comportement byte pour byte inchangé", async (t) => {
  let uploadedPath = "";
  let uploadOpts: { upsert?: boolean } | undefined;
  mockAsUserClient(t, beginOk());
  mockStorage(t, {
    onUpload: (path, opts) => { uploadedPath = path; uploadOpts = opts; },
  });
  mockApplyStateful(t, null);

  const result = await replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile() });
  const filename = uploadedPath.split("/")[2];
  assert.match(filename, UUID_V4_FILENAME_RE, "chemin ALÉATOIRE (crypto.randomUUID()), forme inchangée");
  assert.equal(uploadOpts?.upsert, false, "Single Photo Edit garde upsert:false, INCHANGÉ");
  assert.equal(result.alreadyApplied, false);
});

test("replaceProductPhoto: FIRST APPLY REGRESSION -- batchId fourni, isRetry:false (première tentative) -- remplace TOUJOURS, même si le produit a déjà une photo DIFFÉRENTE -- AUCUN conflit, AUCUNE comparaison, remplacement de masse INCONDITIONNEL préservé", async (t) => {
  let uploadCalled = false;
  let uploadOpts: { upsert?: boolean } | undefined;
  mockAsUserClient(t, beginOk());
  mockStorage(t, { onUpload: (_path, opts) => { uploadCalled = true; uploadOpts = opts; } });
  mockApplyStateful(t, "https://x/storage/v1/object/public/product-photos/r1/p1/some-other-existing-photo.jpg");

  const result = await replaceProductPhoto({
    accessToken: "tok",
    productId: "p1",
    file: jpegFile(),
    batchId: "batch-1",
    isRetry: false,
  });
  assert.equal(uploadCalled, true, "mandat : 'FIRST BULK APPLY... no expected-image compare-and-set required' -- la première tentative remplace toujours");
  assert.equal(uploadOpts?.upsert, true, "chemin déterministe (Bulk) -> upsert:true");
  assert.equal(result.alreadyApplied, false);
});

test("replaceProductPhoto: batchId fourni -- chemin/image DÉTERMINISTE, même (restaurant, produit, batchId) produit TOUJOURS le même chemin (deux premiers Apply successifs, isRetry:false)", async (t) => {
  const uploadedPaths: string[] = [];
  // Deux appels ISRETRY:FALSE successifs (jamais un retry) -- isole
  // ICI la seule propriété testée : le déterminisme du chemin,
  // indépendamment de la décision ALREADY_APPLIED/CONFLICT (couverte
  // par ses propres tests ci-dessous).
  mockAsUserClient(t, beginOk());
  mockStorage(t, { onUpload: (path) => { uploadedPaths.push(path); } });
  mockApplyStateful(t, null);

  await replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile(), batchId: "batch-determinism", isRetry: false });
  await replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile(), batchId: "batch-determinism", isRetry: false });

  assert.equal(uploadedPaths.length, 2);
  assert.equal(uploadedPaths[0], uploadedPaths[1], "mandat : 'Same: batchId + product must resolve to the same logical image identity/path'");
  const filename = uploadedPaths[0].split("/")[2];
  assert.match(filename, UUID_V4_FILENAME_RE, "le nom dérivé reste de la FORME crypto.randomUUID() v4 -- compatibilité avec la validation SQL existante, INCHANGÉE");
});

test("replaceProductPhoto: batchId fourni -- deux PRODUITS différents dans le MÊME lot -> chemins déterministes DIFFÉRENTS (CROSS-PRODUCT KEY ISSUE)", async (t) => {
  const uploadedPaths: string[] = [];
  mockStorage(t, { onUpload: (path) => { uploadedPaths.push(path); } });
  mockAdminRpc(t, async () => ({
    data: [{ old_path: null, image_url: "https://x/storage/v1/object/public/product-photos/r1/whatever.jpg", old_path_cleanup_skipped: false }],
    error: null,
  }));

  mockAsUserClient(t, beginOkWithImage(null, "r1", "u1"));
  await replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile(), batchId: "batch-shared" });
  mockAsUserClient(t, beginOkWithImage(null, "r1", "u1"));
  await replaceProductPhoto({ accessToken: "tok", productId: "p2", file: jpegFile(), batchId: "batch-shared" });

  assert.equal(uploadedPaths.length, 2);
  assert.notEqual(
    uploadedPaths[0],
    uploadedPaths[1],
    "mandat : 'reuse of the same batchId for another product naturally creates a different server-derived operation identity' -- restaurant_id/product_id sont RÉSOLUS CÔTÉ SERVEUR, jamais transmis par le client, donc structurellement impossibles à falsifier depuis batchId seul"
  );
});

test("replaceProductPhoto: RETRY reconnu (image actuelle, SOUS VERROU, == cible déterministe de CETTE opération) -- ALREADY_APPLIED, ZÉRO upload, apply_ appelée EXACTEMENT UNE FOIS pour la décision (p_is_retry:true), JAMAIS une seconde fois", async (t) => {
  let uploadCount = 0;
  let applyCallCount = 0;
  mockAsUserClient(t, beginOk());
  mockStorage(t, { onUpload: () => { uploadCount += 1; } });
  const state = mockApplyStateful(t, null, () => { applyCallCount += 1; });

  const firstResult = await replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile(), batchId: "batch-replay", isRetry: false });
  assert.equal(uploadCount, 1);
  assert.equal(applyCallCount, 1);
  assert.equal(state.getCurrent(), firstResult.imageUrl, "le premier Apply a réellement commité côté SQL simulé");

  // Retry -- MÊME batchId, MÊME produit -> MÊME cible déterministe ;
  // le premier appel a RÉELLEMENT commité, réponse HTTP simplement
  // perdue avant d'atteindre le navigateur.
  const retryResult = await replaceProductPhoto({
    accessToken: "tok",
    productId: "p1",
    file: jpegFile(),
    batchId: "batch-replay",
    isRetry: true,
  });

  assert.equal(uploadCount, 1, "SECOND UPLOAD: NO -- aucun nouvel upload sur le retry");
  assert.equal(applyCallCount, 2, "la RPC est rappelée UNE fois pour la décision de retry elle-même (p_is_retry:true) -- mais SANS mutation, voir already_applied ci-dessous");
  assert.equal(retryResult.alreadyApplied, true, "RESULT: ALREADY_APPLIED / SUCCESS");
  assert.equal(retryResult.imageUrl, firstResult.imageUrl, "CURRENT PHOTO: unchanged -- même URL autoritaire que le premier appel");
  assert.equal(retryResult.oldImageCleanup, "not_applicable");
  assert.equal(retryResult.cleanupId, null);
});

test("replaceProductPhoto: MANDATORY ALREADY-APPLIED TEST -- une relecture indéterminée n'upload JAMAIS avant la décision verrouillée (SECOND UPLOAD: NO, SANS CONDITION)", async (t) => {
  let uploadCount = 0;
  mockAsUserClient(t, beginOk());
  mockStorage(t, { onUpload: () => { uploadCount += 1; } });
  const state = mockApplyStateful(t, null);

  await replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile(), batchId: "batch-no-upload", isRetry: false });
  assert.equal(uploadCount, 1);

  const retryResult = await replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile(), batchId: "batch-no-upload", isRetry: true });
  assert.equal(retryResult.alreadyApplied, true);
  assert.equal(uploadCount, 1, "SECOND UPLOAD: NO -- ZÉRO appel Storage.upload pour TOUTE relecture, y compris ALREADY_APPLIED");
  assert.equal(state.getCurrent(), retryResult.imageUrl, "aucune mutation supplémentaire n'a eu lieu");
});

test("replaceProductPhoto: SCÉNARIO MANDATÉ -- LOST HTTP RESPONSE : upload+apply_ réussissent réellement, la réponse est perdue, le retry aboutit à SUCCÈS sans seconde mutation effective, aucun orphelin (retry court-circuite AVANT tout upload)", async (t) => {
  let applyCallCount = 0;
  let uploadCount = 0;
  const removedPaths: string[][] = [];
  mockAsUserClient(t, beginOk());
  mockStorage(t, {
    onUpload: () => { uploadCount += 1; },
    onRemove: (paths) => { removedPaths.push(paths); },
  });
  mockApplyStateful(t, null, () => { applyCallCount += 1; });

  // Étape 1-3 du scénario mandaté : le batch B installe l'image
  // déterministe du produit P -- réussit réellement côté serveur.
  const firstResult = await replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile(), batchId: "batch-B", isRetry: false });

  // Étape 4-5 : la réponse HTTP est perdue (hors périmètre de ce
  // module -- transport), le navigateur retente B/P avec le MÊME
  // batchId.
  const retryResult = await replaceProductPhoto({
    accessToken: "tok",
    productId: "p1",
    file: jpegFile(),
    batchId: "batch-B",
    isRetry: true,
  });

  assert.equal(uploadCount, 1, "SECOND UPLOAD: NO");
  assert.equal(applyCallCount, 2, "apply_ rappelée pour la décision (p_is_retry:true), ZÉRO mutation supplémentaire");
  assert.equal(retryResult.imageUrl, firstResult.imageUrl, "CURRENT PHOTO: unchanged, le produit garde la photo correctement uploadée");
  assert.equal(retryResult.alreadyApplied, true, "RESULT: ALREADY_APPLIED / SUCCESS");
  // "NEW STORAGE OBJECT: NO" -- aucun nouvel objet Storage n'a été
  // uploadé pour le retry (uploadCount reste à 1, capturé ci-dessus) --
  // le retry court-circuite AVANT tout upload (voir 3bis dans
  // lib/server/product-photo-service.ts), donc aucun orphelin n'existe
  // structurellement pour lui.
  assert.equal(removedPaths.length, 0, "aucun fichier n'a été uploadé par le retry -- rien à nettoyer");
});

test("replaceProductPhoto: MANDATORY RACE TEST (niveau Node -- wiring) -- un changement manuel légitime (image M) survient entre le premier essai et le retry -- CONFLICT, M PRÉSERVÉE, AUCUN upload, AUCUNE mutation ; preuve du VERROUILLAGE RÉEL déléguée à supabase/tests/v67c-storage-operator-authorization-check.sh", async (t) => {
  let applyCallCount = 0;
  let uploadCount = 0;
  mockAsUserClient(t, beginOk());
  mockStorage(t, { onUpload: () => { uploadCount += 1; } });
  const state = mockApplyStateful(t, null, () => { applyCallCount += 1; });

  // Bulk B/P réussit -- réponse ensuite perdue (hors périmètre ici).
  await replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile(), batchId: "batch-later-change", isRetry: false });
  assert.equal(uploadCount, 1);
  assert.equal(applyCallCount, 1);

  // Un changement manuel légitime (Single Photo Edit, ou toute autre
  // opération autorisée) installe M -- simulé ICI en mutant
  // DIRECTEMENT l'état "authoritative" du mock (jamais via un appel
  // replaceProductPhoto, pour isoler la décision de retry elle-même) :
  // l'image actuellement autoritaire N'EST PLUS la cible déterministe
  // de CETTE opération B/P.
  const M = "https://x/storage/v1/object/public/product-photos/r1/p1/manual-edit-M.jpg";
  state.setCurrent(M);

  await assert.rejects(
    () =>
      replaceProductPhoto({
        accessToken: "tok",
        productId: "p1",
        file: jpegFile(),
        batchId: "batch-later-change",
        isRetry: true,
      }),
    (e: unknown) => {
      assert.ok(e instanceof ProductPhotoServerError);
      assert.equal((e as InstanceType<typeof ProductPhotoServerError>).reason, "conflict", "Bulk retry: CONFLICT");
      return true;
    }
  );

  assert.equal(uploadCount, 1, "STORAGE UPLOAD: NO -- le compteur reste à 1 (le premier essai UNIQUEMENT)");
  assert.equal(applyCallCount, 2, "apply_ rappelée pour la décision de retry elle-même (p_is_retry:true), ZÉRO mutation autoritaire (AUTHORITATIVE UPDATE: NO)");
  assert.equal(state.getCurrent(), M, "M PRESERVED: YES -- l'image actuellement autoritaire reste EXACTEMENT M, jamais écrasée par le retry incertain");
});

test("replaceProductPhoto: un SECOND retry (après un premier retry déjà reconnu ALREADY_APPLIED) reste lui aussi ALREADY_APPLIED -- aucune dérive après plusieurs tentatives, ZÉRO upload additionnel à chaque fois", async (t) => {
  let uploadCount = 0;
  let applyCallCount = 0;
  mockAsUserClient(t, beginOk());
  mockStorage(t, { onUpload: () => { uploadCount += 1; } });
  mockApplyStateful(t, null, () => { applyCallCount += 1; });

  const firstResult = await replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile(), batchId: "batch-multi-retry", isRetry: false });

  const retry1 = await replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile(), batchId: "batch-multi-retry", isRetry: true });
  const retry2 = await replaceProductPhoto({ accessToken: "tok", productId: "p1", file: jpegFile(), batchId: "batch-multi-retry", isRetry: true });

  assert.equal(uploadCount, 1);
  assert.equal(applyCallCount, 3, "1 premier Apply + 2 décisions de retry, ZÉRO mutation additionnelle pour les deux retries");
  assert.equal(retry1.alreadyApplied, true);
  assert.equal(retry2.alreadyApplied, true);
  assert.equal(retry1.imageUrl, firstResult.imageUrl);
  assert.equal(retry2.imageUrl, firstResult.imageUrl);
});

test("removeProductPhoto: n'est JAMAIS affectée par batchId -- ne l'accepte même pas (Single Photo Edit reste intégralement byte pour byte inchangé)", async (t) => {
  mockAsUserClient(t, beginOkWithImage("https://x/storage/v1/object/public/product-photos/r1/p1/old.jpg"));
  mockStorage(t);
  let applyArgs: unknown;
  mockAdminRpc(t, async (name, args) => {
    applyArgs = args;
    return { data: [{ old_path: "r1/p1/old.jpg", image_url: null, old_path_cleanup_skipped: false }], error: null };
  });

  await removeProductPhoto({ accessToken: "tok", productId: "p1" });
  assert.ok(applyArgs && !("batchId" in (applyArgs as object)), "removeProductPhoto ne transmet jamais de batchId -- v2.2 hors périmètre pour ce flux");
});
