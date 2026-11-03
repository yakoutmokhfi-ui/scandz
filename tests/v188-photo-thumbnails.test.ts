import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  productPhotoThumbnailUrl,
  THUMBNAIL_WIDTH_CARD,
  THUMBNAIL_WIDTH_WIDE,
  THUMBNAIL_QUALITY,
} from "../lib/product-photo-thumbnail.ts";

const ORIGINAL =
  "https://abc.supabase.co/storage/v1/object/public/product-photos/est/0b1c2d3e-aaaa-4bbb-8ccc-1234567890ab.jpg";

test("[188-THUMB-1] désactivé : l'URL d'origine est renvoyée telle quelle", () => {
  assert.equal(productPhotoThumbnailUrl(ORIGINAL, 256, false), ORIGINAL);
});

test("[188-THUMB-2] activé : endpoint render/image, carré 512x512 (jamais width seul), qualité 85, original intact", () => {
  const u = productPhotoThumbnailUrl(ORIGINAL, THUMBNAIL_WIDTH_CARD, true);
  assert.equal(
    u,
    "https://abc.supabase.co/storage/v1/render/image/public/product-photos/est/0b1c2d3e-aaaa-4bbb-8ccc-1234567890ab.jpg?width=512&height=512&quality=85&resize=cover"
  );
  assert.equal(productPhotoThumbnailUrl(ORIGINAL, undefined, true), u, "la carte utilise la largeur par défaut");
  assert.ok(ORIGINAL.includes("/object/public/"), "l'URL d'origine n'est pas modifiée");
});

test("[188-THUMB-3] URL hors stockage Supabase ou déjà paramétrée : inchangée", () => {
  for (const u of ["/banners/x.jpg", "https://cdn.example.com/a.jpg", ORIGINAL + "?v=2"]) {
    assert.equal(productPhotoThumbnailUrl(u, 256, true), u);
  }
});

test("[188-THUMB-4] bandeau large demandé en carré 768 px", () => {
  assert.equal(THUMBNAIL_WIDTH_WIDE, 768);
  assert.match(productPhotoThumbnailUrl(ORIGINAL, THUMBNAIL_WIDTH_WIDE, true), /width=768&height=768/);
});

test("[188-THUMB-7] netteté : qualité 85 et largeur carte 512 (retour du commerçant : 256/70 trop flou)", () => {
  assert.equal(THUMBNAIL_QUALITY, 85);
  assert.equal(THUMBNAIL_WIDTH_CARD, 512);
  assert.ok(THUMBNAIL_WIDTH_CARD >= 112 * 4, "couvre un affichage 112 px à x4");
});

test("[188-THUMB-5] la carte retombe sur l'original avant de masquer la photo", () => {
  const src = readFileSync("components/MenuItemCard.tsx", "utf8");
  assert.match(src, /setUseOriginal\(true\)/);
  assert.match(src, /else setPhotoFailed\(true\)/);
  assert.equal((src.match(/onError=\{onPhotoError\}/g) ?? []).length, 2);
});

test("[188-THUMB-6] la hauteur est toujours précisée (anti-lamelle)", () => {
  for (const w of [128, 256, 384, 512, 768]) {
    const u = productPhotoThumbnailUrl(ORIGINAL, w, true);
    assert.match(u, new RegExp(`width=${w}&height=${w}&`));
  }
});
