import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Issue #188 : 132 photos produit (jusqu'à 1,26 Mo) chargées d'un coup
// pour des vignettes de 112x112 px. Garde-fou : les photos produit
// hors écran sont différées ; le logo (en tête de page) reste immédiat.
const imgTags = (file: string): string[] =>
  readFileSync(file, "utf8").match(/<img\b[\s\S]*?\/>/g) ?? [];

test("[188-LAZY-1] chaque photo produit de la carte est différée et décodée en asynchrone", () => {
  const tags = imgTags("components/MenuItemCard.tsx");
  assert.equal(tags.length, 2);
  for (const t of tags) {
    assert.match(t, /loading="lazy"/);
    assert.match(t, /decoding="async"/);
  }
});

test("[188-LAZY-2] la carte réserve la place (width/height) sans changer le rendu", () => {
  const [inline, standard] = imgTags("components/MenuItemCard.tsx");
  assert.match(inline, /width=\{96\}[\s\S]*height=\{96\}/);
  assert.match(standard, /width=\{112\}[\s\S]*height=\{112\}/);
  assert.match(inline, /h-24 w-24 shrink-0 object-cover/);
  assert.match(standard, /h-28 w-28 shrink-0 object-cover/);
});

test("[188-LAZY-3] photos du modal pâtisserie différées", () => {
  for (const t of imgTags("components/PastryModal.tsx")) {
    assert.match(t, /loading="lazy"/);
  }
});

test("[188-LAZY-4] le logo d'en-tête n'est jamais différé", () => {
  for (const t of imgTags("components/RestaurantHeader.tsx")) {
    assert.doesNotMatch(t, /loading="lazy"/);
  }
});
