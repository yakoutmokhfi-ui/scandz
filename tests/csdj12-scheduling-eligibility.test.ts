import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CHECKOUT_UNFULFILLABLE_REASONS_V12,
  type ScheduleInputV12,
  resolveScheduleEligibilityV12,
} from "../lib/scheduling/eligibility-v12.ts";

/**
 * Scanym — CSDJ v1.2 (calendriers, heure limite, capacité)
 * Miroir TypeScript : les cas de la FIXTURE PARTAGÉE.
 *
 * Chaque cas de tests/fixtures/checkout-scheduling-v12-cases.json est joué
 * ici ET contre `public.resolve_fulfillment_schedule_v12` par
 * supabase/tests/checkout-scheduling-v12-check.sh. Les attendus ont été
 * produits par un oracle Python indépendant (et les cas sensibles ont une
 * réponse dérivée à la main) : aucune des deux implémentations livrées
 * n'est juge de sa propre sortie.
 */

interface FixtureCase {
  readonly id: string;
  readonly note: string;
  readonly config: (ScheduleInputV12["config"] & object) | null;
  readonly nowIso: string;
  readonly windows: ScheduleInputV12["windows"];
  readonly slots: ScheduleInputV12["slots"];
  readonly closures: ScheduleInputV12["closures"];
  readonly prepWeekdays: ScheduleInputV12["prepWeekdays"];
  readonly prepClosures: ScheduleInputV12["prepClosures"];
  readonly holidayDays: ScheduleInputV12["holidayDays"];
  readonly occupied: ScheduleInputV12["occupied"];
  readonly sqlConstraintRefusal: boolean;
  readonly expected: {
    readonly status: string;
    readonly reason: string | null;
    readonly firstEligibleDate: string | null;
    readonly dates: ReadonlyArray<{
      readonly date: string;
      readonly offers: ReadonlyArray<{
        readonly slotKey: string | null;
        readonly startsAt: string;
        readonly endsAt: string;
      }>;
    }>;
  };
}

const fixture = JSON.parse(
  readFileSync("tests/fixtures/checkout-scheduling-v12-cases.json", "utf8")
) as { cases: FixtureCase[] };

test("[V12-FIXTURE-0] la fixture couvre les familles de cas exigées par le mandat", () => {
  const ids = fixture.cases.map((c) => c.id);
  for (const needed of [
    "v12-tue-before-cutoff-1s",
    "v12-tue-exact-cutoff",
    "v12-sat-exact-cutoff",
    "v12-sun-morning",
    "v12-mon-exact-cutoff",
    "v12-fri-after-cutoff",
    "v12-avail-closure-on-target",
    "v12-prep-closure-today",
    "v12-holiday-prep-closed",
    "v12-holiday-avail-closed",
    "v12-holiday-prep-only-not-avail",
    "v12-prep-calendar-missing",
    "v12-cutoff-gap-paris",
    "v12-cutoff-overlap-paris",
    "v12-cap-date-full",
    "v12-cap-slot-full",
    "v12-cap-exhausted",
    "v12-cap-off-ignores-occupancy",
  ]) {
    assert.ok(ids.includes(needed), `cas de fixture manquant : ${needed}`);
  }
  assert.ok(fixture.cases.length >= 50);
});

for (const c of fixture.cases) {
  // Un cas `sqlConstraintRefusal` est refusé par une contrainte de la table
  // en SQL : il n'existe pas en base, il est donc sans objet ici.
  if (c.sqlConstraintRefusal) continue;
  test(`[V12-FIXTURE] ${c.id} — ${c.note.split(".")[0]}`, () => {
    const got = resolveScheduleEligibilityV12({
      config: c.config,
      windows: c.windows,
      slots: c.slots,
      closures: c.closures,
      prepWeekdays: c.prepWeekdays,
      prepClosures: c.prepClosures,
      holidayDays: c.holidayDays,
      occupied: c.occupied,
      nowIso: c.nowIso,
    });
    assert.equal(got.status, c.expected.status, "statut");
    assert.equal(got.reason, c.expected.reason, "motif");
    assert.equal(got.firstEligibleDate, c.expected.firstEligibleDate, "première date");
    assert.deepEqual(
      got.dates.map((d) => d.date),
      c.expected.dates.map((d) => d.date),
      "liste exacte des dates éligibles"
    );
    assert.deepEqual(
      got.dates.map((d) => d.offers),
      c.expected.dates.map((d) => d.offers),
      "offres de chaque date"
    );
  });
}

test("[V12-CATALOGUE] le catalogue de motifs v1.2 est fermé, ordonné, sans doublon", () => {
  assert.deepEqual(CHECKOUT_UNFULFILLABLE_REASONS_V12.slice(5), [
    "preparation_calendar_missing",
    "no_preparation_day_in_horizon",
    "cutoff_unresolvable",
    "capacity_exhausted",
  ]);
  assert.equal(
    new Set(CHECKOUT_UNFULFILLABLE_REASONS_V12).size,
    CHECKOUT_UNFULFILLABLE_REASONS_V12.length
  );
});

test("[V12-PURETÉ] le résolveur ne modifie pas ses entrées et est déterministe", () => {
  const c = fixture.cases.find((x) => x.id === "v12-cap-date-one-left");
  assert.ok(c);
  const input: ScheduleInputV12 = {
    config: c.config,
    windows: c.windows,
    slots: c.slots,
    closures: c.closures,
    prepWeekdays: c.prepWeekdays,
    prepClosures: c.prepClosures,
    holidayDays: c.holidayDays,
    occupied: c.occupied,
    nowIso: c.nowIso,
  };
  const before = JSON.stringify(input);
  const a = resolveScheduleEligibilityV12(input);
  const b = resolveScheduleEligibilityV12(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(a, b);
});

test("[V12-CAPACITÉ] la réponse publique ne porte AUCUN décompte de places", () => {
  for (const c of fixture.cases) {
    if (c.sqlConstraintRefusal) continue;
    const got = resolveScheduleEligibilityV12({
      config: c.config,
      windows: c.windows,
      slots: c.slots,
      closures: c.closures,
      prepWeekdays: c.prepWeekdays,
      prepClosures: c.prepClosures,
      holidayDays: c.holidayDays,
      occupied: c.occupied,
      nowIso: c.nowIso,
    });
    // On inspecte les CLÉS (le motif `capacity_exhausted` est une valeur
    // du catalogue fermé, pas un décompte).
    const keys = new Set<string>();
    JSON.stringify(got, (k, v) => {
      if (k !== "") keys.add(k);
      return v;
    });
    const allowed = new Set([
      "status", "reason", "timezone", "dateSelectionMode", "slotSelectionMode",
      "timeGranularityMinutes", "firstEligibleDate", "dates", "date", "offers",
      "slotKey", "startsAt", "endsAt",
    ]);
    for (const k of keys) {
      // les index de tableau ("0", "1", ...) ne sont pas des champs
      if (/^\d+$/.test(k)) continue;
      assert.ok(allowed.has(k), `${c.id} : champ inattendu « ${k} » dans la réponse publique`);
    }
  }
});

test("[V12-CAPACITÉ] applyCapacity=false ignore l'occupation (mode interne de réservation)", () => {
  const c = fixture.cases.find((x) => x.id === "v12-cap-exhausted");
  assert.ok(c);
  const base: ScheduleInputV12 = {
    config: c.config,
    windows: c.windows,
    slots: c.slots,
    closures: c.closures,
    prepWeekdays: c.prepWeekdays,
    prepClosures: c.prepClosures,
    holidayDays: c.holidayDays,
    occupied: c.occupied,
    nowIso: c.nowIso,
  };
  assert.equal(resolveScheduleEligibilityV12(base).reason, "capacity_exhausted");
  assert.notEqual(
    resolveScheduleEligibilityV12({ ...base, applyCapacity: false }).reason,
    "capacity_exhausted"
  );
});
