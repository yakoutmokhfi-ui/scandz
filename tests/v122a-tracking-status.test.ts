import { test } from "node:test";
import assert from "node:assert/strict";

// ====================================================================
// Scanym — CUSTOMER TRACKING EXPERIENCE v2 — lib/tracking/status.ts.
//
// Couvre mandat §15 (les 7 statuts canoniques, rien de plus),
// §16/§17/§31 (les CINQ modes de service réellement publiés doivent
// TOUS recevoir un comportement explicite -- ferme CTE-V1-SERVICE-
// MODE-01, blocage de publication v1 : "v1 incorrectly handled only
// pickup/table/delivery. Do NOT classify click_collect/room_service as
// unknown/future.") et §18 (frise à partir des seuls horodatages
// réels).
// ====================================================================

const {
  CANONICAL_ORDER_STATUSES,
  isCanonicalOrderStatus,
  NORMAL_PROGRESSION,
  EXCEPTION_STATUSES,
  isExceptionStatus,
  normalProgressionIndex,
  statusLabelKey,
  statusLabelKeyForServiceMode,
  isTerminalStatus,
  buildTimeline,
} = await import("../lib/tracking/status.ts");

test("CANONICAL_ORDER_STATUSES: exactement les 7 valeurs attendues, dans cet ordre", () => {
  assert.deepEqual(CANONICAL_ORDER_STATUSES, [
    "new",
    "accepted",
    "preparing",
    "ready",
    "completed",
    "rejected",
    "cancelled",
  ]);
});

test("isCanonicalOrderStatus: accepte les 7 valeurs, rejette payment_status/Monetico/valeurs arbitraires", () => {
  for (const s of CANONICAL_ORDER_STATUSES) assert.equal(isCanonicalOrderStatus(s), true);
  for (const bad of ["served", "payment_status", "monetico_ok", "", null, undefined, 42]) {
    assert.equal(isCanonicalOrderStatus(bad), false);
  }
});

test("NORMAL_PROGRESSION: 5 étapes, rejected/cancelled n'y figurent JAMAIS", () => {
  assert.deepEqual(NORMAL_PROGRESSION, ["new", "accepted", "preparing", "ready", "completed"]);
  assert.equal((NORMAL_PROGRESSION as readonly string[]).includes("rejected"), false);
  assert.equal((NORMAL_PROGRESSION as readonly string[]).includes("cancelled"), false);
});

test("isExceptionStatus: uniquement rejected/cancelled", () => {
  assert.equal(isExceptionStatus("rejected"), true);
  assert.equal(isExceptionStatus("cancelled"), true);
  for (const s of NORMAL_PROGRESSION) assert.equal(isExceptionStatus(s), false);
  assert.deepEqual(EXCEPTION_STATUSES, ["rejected", "cancelled"]);
});

test("normalProgressionIndex: position correcte, -1 pour une exception", () => {
  assert.equal(normalProgressionIndex("new"), 0);
  assert.equal(normalProgressionIndex("accepted"), 1);
  assert.equal(normalProgressionIndex("preparing"), 2);
  assert.equal(normalProgressionIndex("ready"), 3);
  assert.equal(normalProgressionIndex("completed"), 4);
  assert.equal(normalProgressionIndex("rejected"), -1);
  assert.equal(normalProgressionIndex("cancelled"), -1);
});

test("statusLabelKey: clé i18n générique trackingStatus_<status> pour les 7 statuts", () => {
  for (const s of CANONICAL_ORDER_STATUSES) {
    assert.equal(statusLabelKey(s), `trackingStatus_${s}`);
  }
});

test("isTerminalStatus: completed/rejected/cancelled uniquement", () => {
  assert.equal(isTerminalStatus("completed"), true);
  assert.equal(isTerminalStatus("rejected"), true);
  assert.equal(isTerminalStatus("cancelled"), true);
  for (const s of ["new", "accepted", "preparing", "ready"] as const) {
    assert.equal(isTerminalStatus(s), false);
  }
});

// --------------------------------------------------------------
// Mandat §31 : test DIRECT pour CHACUN des CINQ modes de service
// publiés -- jamais uniquement le repli "unknown/future".
// --------------------------------------------------------------

test("statusLabelKeyForServiceMode: table -- 'ready' adapté pour le service à table (mandat §17)", () => {
  assert.equal(statusLabelKeyForServiceMode("ready", "table"), "trackingStatus_ready_table");
});

test("statusLabelKeyForServiceMode: pickup -- 'ready' signifie prêt pour le retrait (mandat §17)", () => {
  assert.equal(statusLabelKeyForServiceMode("ready", "pickup"), "trackingStatus_ready_pickup");
});

test("statusLabelKeyForServiceMode: click_collect -- MÊME sémantique de retrait que pickup, jamais classé 'unknown/future' (ferme CTE-V1-SERVICE-MODE-01)", () => {
  assert.equal(statusLabelKeyForServiceMode("ready", "click_collect"), "trackingStatus_ready_pickup");
});

test("statusLabelKeyForServiceMode: room_service -- 'ready' signifie prêt pour la chambre, jamais classé 'unknown/future' (ferme CTE-V1-SERVICE-MODE-01)", () => {
  assert.equal(
    statusLabelKeyForServiceMode("ready", "room_service"),
    "trackingStatus_ready_room_service"
  );
});

test("statusLabelKeyForServiceMode: delivery -- 'ready' n'implique JAMAIS de position/ETA coursier (mandat §17)", () => {
  assert.equal(statusLabelKeyForServiceMode("ready", "delivery"), "trackingStatus_ready_delivery");
});

test("statusLabelKeyForServiceMode: les 5 clés produites par les 5 modes réels sont TOUTES distinctes de la clé générique 'trackingStatus_ready' brute (chacune est réellement adaptée, sauf pickup/click_collect qui PARTAGENT la même clé à raison)", () => {
  const genericKey = statusLabelKey("ready");
  for (const mode of ["table", "pickup", "click_collect", "room_service", "delivery"]) {
    assert.notEqual(statusLabelKeyForServiceMode("ready", mode), genericKey);
  }
});

test("statusLabelKeyForServiceMode: mode VRAIMENT futur/inconnu -- repli générique SEULEMENT dans ce cas (mandat §17, 'genuinely unknown future modes')", () => {
  assert.equal(
    statusLabelKeyForServiceMode("ready", "some-future-mode-2027"),
    statusLabelKey("ready")
  );
});

test("statusLabelKeyForServiceMode: pour tout statut AUTRE que 'ready', le libellé générique suffit, quel que soit le mode", () => {
  for (const mode of ["table", "pickup", "click_collect", "room_service", "delivery"]) {
    for (const status of ["new", "accepted", "preparing", "completed", "rejected", "cancelled"] as const) {
      assert.equal(statusLabelKeyForServiceMode(status, mode), statusLabelKey(status));
    }
  }
});

// --------------------------------------------------------------
// buildTimeline (mandat §18 : uniquement des horodatages RÉELS,
// jamais fabriqués).
// --------------------------------------------------------------

const BASE_TIMESTAMPS = {
  created_at: "2026-01-01T10:00:00Z",
  accepted_at: null,
  preparing_at: null,
  ready_at: null,
  completed_at: null,
  rejected_at: null,
  cancelled_at: null,
};

test("buildTimeline: commande neuve -- seule 'new' atteinte et courante", () => {
  const timeline = buildTimeline("new", BASE_TIMESTAMPS);
  assert.equal(timeline.length, 5);
  assert.equal(timeline[0]!.status, "new");
  assert.equal(timeline[0]!.reached, true);
  assert.equal(timeline[0]!.isCurrent, true);
  for (const step of timeline.slice(1)) {
    assert.equal(step.reached, false);
    assert.equal(step.isCurrent, false);
    assert.equal(step.timestamp, null);
  }
});

test("buildTimeline: commande 'ready' -- 4 étapes atteintes, 'ready' courante, 'completed' non atteinte", () => {
  const timeline = buildTimeline("ready", {
    ...BASE_TIMESTAMPS,
    accepted_at: "2026-01-01T10:05:00Z",
    preparing_at: "2026-01-01T10:10:00Z",
    ready_at: "2026-01-01T10:20:00Z",
  });
  const byStatus = Object.fromEntries(timeline.map((s) => [s.status, s]));
  assert.equal(byStatus.new!.reached, true);
  assert.equal(byStatus.accepted!.reached, true);
  assert.equal(byStatus.preparing!.reached, true);
  assert.equal(byStatus.ready!.reached, true);
  assert.equal(byStatus.ready!.isCurrent, true);
  assert.equal(byStatus.completed!.reached, false);
  assert.equal(byStatus.completed!.isCurrent, false);
});

test("buildTimeline: commande 'cancelled' après acceptation partielle -- étapes réellement atteintes restent affichées, AUCUNE étape normale n'est jamais 'isCurrent'", () => {
  const timeline = buildTimeline("cancelled", {
    ...BASE_TIMESTAMPS,
    accepted_at: "2026-01-01T10:05:00Z",
    cancelled_at: "2026-01-01T10:06:00Z",
  });
  const byStatus = Object.fromEntries(timeline.map((s) => [s.status, s]));
  assert.equal(byStatus.new!.reached, true);
  assert.equal(byStatus.accepted!.reached, true);
  assert.equal(byStatus.preparing!.reached, false);
  for (const step of timeline) assert.equal(step.isCurrent, false);
});

test("buildTimeline: commande 'rejected' avant toute acceptation -- seule 'new' atteinte", () => {
  const timeline = buildTimeline("rejected", {
    ...BASE_TIMESTAMPS,
    rejected_at: "2026-01-01T10:01:00Z",
  });
  const byStatus = Object.fromEntries(timeline.map((s) => [s.status, s]));
  assert.equal(byStatus.new!.reached, true);
  assert.equal(byStatus.accepted!.reached, false);
  for (const step of timeline) assert.equal(step.isCurrent, false);
});

test("buildTimeline: chaque étape porte EXACTEMENT l'horodatage source correspondant, jamais une valeur fabriquée", () => {
  const ts = {
    ...BASE_TIMESTAMPS,
    accepted_at: "2026-01-01T10:05:00Z",
    preparing_at: "2026-01-01T10:10:00Z",
    ready_at: "2026-01-01T10:20:00Z",
    completed_at: "2026-01-01T10:30:00Z",
  };
  const timeline = buildTimeline("completed", ts);
  const byStatus = Object.fromEntries(timeline.map((s) => [s.status, s]));
  assert.equal(byStatus.new!.timestamp, ts.created_at);
  assert.equal(byStatus.accepted!.timestamp, ts.accepted_at);
  assert.equal(byStatus.preparing!.timestamp, ts.preparing_at);
  assert.equal(byStatus.ready!.timestamp, ts.ready_at);
  assert.equal(byStatus.completed!.timestamp, ts.completed_at);
});
