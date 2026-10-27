import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWhatsAppUrl } from "../lib/whatsapp.ts";

// Issue #170 -- ligne « jour et créneau » du message transmis au commerçant.
// Valeurs = celles de p_customer.schedule ; rien n'est déduit ni complété.

const restaurant: any = { name: "Test", config: { currency: "EUR", whatsapp_number: "+33600000000", source_language: "fr" } };
const ctx: any = {
  mode: "delivery", zoneLabel: "Paris",
  customer: { name: "Yakout", phone: "0612345678", email: "", street: "10 rue de Rivoli", postalCode: "75001", city: "Paris" },
};
const totals = { subtotal: 3.5, deliveryFee: 0, total: 3.5 };
const text = (schedule?: any, lang: any = "fr") =>
  decodeURIComponent(new URL(buildWhatsAppUrl(restaurant, [], ctx, totals, lang, 42, null, schedule)).searchParams.get("text") ?? "");

test("[170-W1] sans schedule : message STRICTEMENT inchangé (absent, null, undefined identiques)", () => {
  assert.equal(text(null), text(undefined));
  assert.equal(text(null), text());
  assert.ok(!text(null).includes("📅"));
});

test("[170-W2] créneau fixe : jour (en lettres, fuseau UTC) + heures du serveur", () => {
  const t = text({ date: "2026-10-30", slot_key: "a", starts_at: "11:00", ends_at: "14:00" });
  assert.ok(t.includes("📅 Jour et créneau choisis par le client : vendredi 30 octobre 2026 · 11:00–14:00"), t);
});

test("[170-W3] date seule (aucun horaire) : jour sans heures inventées", () => {
  const t = text({ date: "2026-10-30", slot_key: null, starts_at: null, ends_at: null });
  assert.ok(t.includes("vendredi 30 octobre 2026"), t);
  assert.ok(!t.includes("·") && !t.includes("–"), t);
});

test("[170-W4] date impossible ou mal formée : aucune ligne, jamais normalisée en une autre date", () => {
  for (const date of ["2026-02-31", "2026-13-01", "30/10/2026", "", "2026-10-30T10:00:00Z", "2026-1-3"]) {
    assert.ok(!text({ date, slot_key: null, starts_at: null, ends_at: null }).includes("📅"), `date ${JSON.stringify(date)}`);
  }
});

test("[170-W5] heure incomplète : jamais d'horaire à moitié affiché", () => {
  const t = text({ date: "2026-10-30", slot_key: "a", starts_at: "11:00", ends_at: null });
  assert.ok(t.includes("vendredi 30 octobre 2026") && !t.includes("11:00"), t);
});

test("[170-W6] EN et AR : libellé traduit, valeurs inchangées", () => {
  const s = { date: "2026-10-30", slot_key: "a", starts_at: "11:00", ends_at: "14:00" };
  assert.ok(text(s, "en").includes("Day and slot chosen by the customer"));
  assert.ok(text(s, "ar").includes("11:00–14:00"));
});

test("[170-W7] la ligne s'insère sans modifier le reste du message : message avec schedule = message sans, plus UNE ligne", () => {
  const s = { date: "2026-10-30", slot_key: "a", starts_at: "11:00", ends_at: "14:00" };
  const without = text(null).split("\n");
  const withLine = text(s).split("\n");
  assert.equal(withLine.length, without.length + 1);
  assert.deepEqual(withLine.filter((l) => !l.includes("📅")), without);
});
