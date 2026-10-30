import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { coverThumbnailUrl } from "../lib/product-photo-thumbnail.ts";

const COVER =
  "https://abc.supabase.co/storage/v1/object/public/establishment-assets/r1/cover/c.jpg";

test("[188-COVER-1] désactivé (défaut) : URL inchangée", () => {
  assert.equal(coverThumbnailUrl(COVER, false), COVER);
});

test("[188-COVER-2] activé : largeur 1200, qualité 75, proportions conservées (contain, sans height)", () => {
  const u = coverThumbnailUrl(COVER, true);
  assert.equal(
    u,
    "https://abc.supabase.co/storage/v1/render/image/public/establishment-assets/r1/cover/c.jpg?width=1200&quality=75&resize=contain"
  );
  assert.doesNotMatch(u, /height=/);
});

test("[188-COVER-3] URL hors stockage ou déjà paramétrée : inchangée", () => {
  for (const u of ["/banners/x.jpg", "https://cdn.example.com/a.jpg", COVER + "?v=2"]) {
    assert.equal(coverThumbnailUrl(u, true), u);
  }
});

test("[188-COVER-4] l'en-tête n'applique la vignette qu'à la cover uploadée, pas au repli /banners", () => {
  const src = readFileSync("components/RestaurantHeader.tsx", "utf8");
  assert.match(src, /coverUrl \? coverThumbnailUrl\(coverUrl\) : `\/banners\//);
});
