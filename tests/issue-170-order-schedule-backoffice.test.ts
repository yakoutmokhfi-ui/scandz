import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// ISSUE #170 -- lecture back-office et affichage du créneau figé avec la
// commande (public.order_fulfillment_schedule_snapshot, hébergé).
// ====================================================================

const { formatOrderSchedule, formatOrderScheduleDate, formatOrderScheduleTime, orderScheduleLabelKey } =
  await import("../lib/order-schedule-display.ts");
const { toSchedulePayload } = await import("../lib/checkout-schedule/model.ts");

test("[#170-Q] getDashboardOrders() embarque la relation 1:1 order_fulfillment_schedule_snapshot avec exactement les colonnes affichées (RLS staff hébergée, même client authentifié)", async (t) => {
  const { supabase } = await import("../lib/supabase.ts");
  const { getDashboardOrders } = await import("../lib/services/dashboard.ts");
  let captured: string | null = null;
  const chain: any = {
    select(arg: string) { captured = arg; return chain; },
    eq() { return chain; }, order() { return chain; }, limit() { return chain; }, not() { return chain; }, or() { return chain; },
    then(resolve: (v: { data: unknown[]; error: null }) => void) { resolve({ data: [], error: null }); },
  };
  t.mock.method(supabase, "from", (table: string) => { assert.equal(table, "orders"); return chain; });
  await getDashboardOrders("r1", false);
  const select = captured as unknown as string;
  assert.ok(select, "select() appelé");
  const m = /order_fulfillment_schedule_snapshot\s*\(([^)]*)\)/.exec(select);
  assert.ok(m, "la relation order_fulfillment_schedule_snapshot doit être embarquée");
  const cols = m![1].split(",").map((c) => c.trim()).filter(Boolean).sort();
  assert.deepEqual(cols, ["mode_code", "origin", "scheduled_date", "selected_time", "slot_key", "timezone", "window_ends_at", "window_starts_at"]);
  // Additif : les embeds existants restent.
  for (const e of ["order_items", "order_delivery_tax_allocations", "order_invoice_request"]) assert.ok(select.includes(e), e);
});

test("[#170-F1] date civile : formatée depuis ses composantes (jamais décalée par le fuseau du navigateur), dans chaque langue", () => {
  assert.equal(formatOrderScheduleDate("2026-10-30", "fr"), "ven. 30 oct. 2026");
  assert.match(formatOrderScheduleDate("2026-10-30", "en")!, /30/);
  assert.match(formatOrderScheduleDate("2026-10-30", "en")!, /Oct/);
  assert.ok((formatOrderScheduleDate("2026-10-30", "ar") ?? "").length > 0);
  // Lendemain de fin de mois / année : jamais « 31 » ni « 1er janv. 2027 » par décalage.
  assert.equal(formatOrderScheduleDate("2026-12-31", "fr"), "jeu. 31 déc. 2026");
  assert.equal(formatOrderScheduleDate("2027-01-01", "fr"), "ven. 1 janv. 2027");
});

test("[#170-F2] formes refusées : date malformée ou impossible -> null (rien d'inventé)", () => {
  for (const bad of ["2026-02-31", "2026-13-01", "30/10/2026", "", "2026-10-30T00:00:00Z", "0099-01-01"]) {
    assert.equal(formatOrderScheduleDate(bad, "fr"), null, bad);
  }
  assert.equal(formatOrderSchedule({ mode_code: "pickup", scheduled_date: "2026-02-31", slot_key: null, selected_time: null, window_starts_at: null, window_ends_at: null, timezone: "Europe/Paris", origin: "customer" }, "fr"), null);
  assert.equal(formatOrderSchedule(null, "fr"), null);
  assert.equal(formatOrderSchedule(undefined, "fr"), null);
});

test("[#170-F3] heure : selected_time prime ; sinon fenêtre « HH:MM–HH:MM » ; valeurs hors HH:MM ignorées ; rien -> null", () => {
  assert.equal(formatOrderScheduleTime({ selected_time: "12:30", window_starts_at: "11:00", window_ends_at: "14:00" }), "12:30");
  assert.equal(formatOrderScheduleTime({ selected_time: null, window_starts_at: "16:00", window_ends_at: "20:00" }), "16:00–20:00");
  assert.equal(formatOrderScheduleTime({ selected_time: null, window_starts_at: "16:00", window_ends_at: null }), "16:00");
  assert.equal(formatOrderScheduleTime({ selected_time: null, window_starts_at: null, window_ends_at: null }), null);
  assert.equal(formatOrderScheduleTime({ selected_time: "25:00", window_starts_at: "4pm", window_ends_at: "<b>" }), null);
});

test("[#170-F4] libellé selon le mode : retrait / livraison / autre -- jamais un nom de transporteur", () => {
  assert.equal(orderScheduleLabelKey("pickup"), "dsScheduledPickup");
  assert.equal(orderScheduleLabelKey("delivery"), "dsScheduledDelivery");
  assert.equal(orderScheduleLabelKey("room_service"), "dsScheduledOther");
});

test("[#170-C] contrat checkout -> create_order : pour un créneau fixe choisi, la charge `schedule` porte EXACTEMENT les 4 clés acceptées par le bloc CSDJ-3 hébergé (date, slot_key, starts_at, ends_at), et c'est cette fenêtre qui se retrouve dans le snapshot (window_starts_at/ends_at)", () => {
  // Vue et exigence minimales d'un calendrier retrait « fixed_slots »
  // (même vocabulaire que lib/checkout-schedule/model.ts).
  const view: any = {
    status: "dates_available", timezone: "Europe/Paris", dateSelectionMode: "customer_selectable", slotSelectionMode: "fixed_slots",
    timeGranularityMinutes: null, firstEligibleDate: "2026-10-30", eligibleDates: ["2026-10-30"],
    offers: { "2026-10-30": [{ slotKey: "16-20", startsAt: "16:00", endsAt: "20:00" }] },
  };
  const requirement: any = { kind: "choose", slotMode: "fixed_slots" };
  const selection: any = { date: "2026-10-30", slotKey: "16-20", time: null };
  const payload = toSchedulePayload(view, requirement, selection);
  assert.ok(payload, "une charge doit être produite pour un créneau choisi");
  assert.deepEqual(Object.keys(payload!).sort(), ["date", "ends_at", "slot_key", "starts_at"]);
  assert.deepEqual(payload, { date: "2026-10-30", slot_key: "16-20", starts_at: "16:00", ends_at: "20:00" });
  // Miroir de la ligne hébergée relevée (T5 du bloc CSDJ-3) : mêmes valeurs,
  // reprises de la ligne VALIDATE côté serveur, jamais du navigateur.
  const snapshotAsStored = { mode_code: "pickup", scheduled_date: payload!.date, slot_key: payload!.slot_key, selected_time: null, window_starts_at: payload!.starts_at, window_ends_at: payload!.ends_at, timezone: "Europe/Paris", origin: "customer" as const };
  assert.deepEqual(formatOrderSchedule(snapshotAsStored, "fr"), { dateLabel: "ven. 30 oct. 2026", timeLabel: "16:00–20:00" });
});
