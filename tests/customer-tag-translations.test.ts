import { test } from "node:test";
import assert from "node:assert/strict";
import { translatedTagLabel } from "../lib/customer-tag-translations.ts";

test("tag labels use the stable ID, with source-language and missing-translation fallback", () => {
  const translations = { "tag-1": { en: "Truffle", ar: "كمأة" }, "tag-2": { en: "Organic" } };
  assert.equal(translatedTagLabel("tag-1", "Truffe", "en", "fr", translations), "Truffle");
  assert.equal(translatedTagLabel("tag-1", "Truffe", "ar", "fr", translations), "كمأة");
  assert.equal(translatedTagLabel("tag-1", "Truffe", "fr", "fr", translations), "Truffe");
  assert.equal(translatedTagLabel("tag-1", "Truffe", "nl", "fr", translations), "Truffe");
  assert.equal(translatedTagLabel("other", "Truffe", "en", "fr", translations), "Truffe");
});
