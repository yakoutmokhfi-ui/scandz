import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { productPhotoThumbnailUrl } from "../lib/product-photo-thumbnail.ts";

const ORIGINAL =
  "https://abc.supabase.co/storage/v1/object/public/product-photos/est/0b1c2d3e-aaaa-4bbb-8ccc-1234567890ab.jpg";

test("[188-THUMB-1] désactivé : l'URL d'origine est renvoyée telle quelle", () => {
  assert.equal(productPhotoThumbnailUrl(ORIGINAL, 256, false), ORIGINAL);
});

test("[188-THUMB-2] activé : endpoint render/image, largeur 256, qualité 70, original intact", () => {
  const u = productPhotoThumbnailUrl(ORIGINAL, 256, true);
  assert.equal(
    u,
    "https://abc.supabase.co/storage/v1/render/image/public/product-photos/est/0b1c2d3e-aaaa-4bbb-8ccc-1234567890ab.jpg?width=256&quality=70&resize=cover"
  );
  assert.ok(ORIGINAL.includes("/object/public/"), "l'URL d'origine n'est pas modifiée");
});

test("[188-THUMB-3] URL hors stockage Supabase ou déjà paramétrée : inchangée", () => {
  for (const u of ["/banners/x.jpg", "https://cdn.example.com/a.jpg", ORIGINAL + "?v=2"]) {
    assert.equal(productPhotoThumbnailUrl(u, 256, true), u);
  }
});

test("[188-THUMB-4] aperçu large demandé en 480 px", () => {
  assert.match(productPhotoThumbnailUrl(ORIGINAL, 480, true), /width=480/);
});

test("[188-THUMB-5] la carte retombe sur l'original avant de masquer la photo", () => {
  const src = readFileSync("components/MenuItemCard.tsx", "utf8");
  assert.match(src, /setUseOriginal\(true\)/);
  assert.match(src, /else setPhotoFailed\(true\)/);
  assert.equal((src.match(/onError=\{onPhotoError\}/g) ?? []).length, 2);
});
