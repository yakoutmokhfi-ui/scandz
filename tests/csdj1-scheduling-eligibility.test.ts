import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  type ScheduleInput,
  resolveScheduleEligibility,
} from "../lib/scheduling/eligibility.ts";

/**
 * Scanym — CHECKOUT SCHEDULING FOUNDATION v1 (CSDJ-1)
 * Éligibilité : les cas de la FIXTURE PARTAGÉE.
 *
 * Chaque cas de tests/fixtures/checkout-scheduling-cases.json est joué
 * ici, et le MÊME cas est joué contre `public.resolve_fulfillment_schedule`
 * par supabase/tests/checkout-scheduling-foundation-v1-check.sh. Les
 * attendus de la fixture ont été produits par une troisième
 * implémentation indépendante : aucune des deux implémentations livrées
 * n'est juge de sa propre sortie.
 *
 * Les tests hors fixture, en fin de fichier, portent sur ce qu'une
 * fixture ne sait pas exprimer : les refus, et les propriétés de
 * pureté.
 */

interface FixtureCase {
  readonly id: string;
  readonly note: string;
  readonly config: ScheduleInput["config"];
  readonly nowIso: string;
  readonly windows: ScheduleInput["windows"];
  readonly slots: ScheduleInput["slots"];
  readonly closures: ScheduleInput["closures"];
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
  readFileSync("tests/fixtures/checkout-scheduling-cases.json", "utf8")
) as { cases: FixtureCase[] };

test("[FIXTURE-0] la fixture couvre les familles de cas exigées par le mandat", () => {
  const ids = fixture.cases.map((c) => c.id);
  // Si l'un de ces cas disparaissait, la preuve correspondante
  // disparaîtrait avec lui, sans qu'aucun test ne devienne rouge.
  for (const needed of [
    "absent-no-row",
    "absent-disabled",
    "pickup-first-eligible-before-cutoff",
    "pickup-cutoff-boundary-one-second-before",
    "pickup-cutoff-boundary-exact",
    "pickup-weekly-closed-days",
    "pickup-exceptional-closure",
    "local-fixed-slots-no-same-day",
    "carrier-informational-only",
    "carrier-derived-earliest",
    "unfulfillable-no-offer",
    "unfulfillable-all-closed",
    "unfulfillable-horizon-exhausted",
    "unfulfillable-granularity-missing",
    "tz-autumn-dst-boundary",
    "tz-spring-dst-boundary",
    "tz-far-east-of-utc",
    "tz-west-of-utc",
  ]) {
    assert.ok(ids.includes(needed), `cas de fixture manquant : ${needed}`);
  }
  assert.ok(fixture.cases.length >= 20);
});

for (const c of fixture.cases) {
  test(`[FIXTURE] ${c.id} — ${c.note.split(".")[0]}`, () => {
    const got = resolveScheduleEligibility({
      config: c.config,
      windows: c.windows,
      slots: c.slots,
      closures: c.closures,
      nowIso: c.nowIso,
    });
    assert.equal(got.status, c.expected.status, "statut");
    assert.equal(got.reason, c.expected.reason, "motif");
    assert.equal(
      got.firstEligibleDate,
      c.expected.firstEligibleDate,
      "première date éligible"
    );
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

// ====================================================================
// Propriétés que la fixture n'exprime pas
// ====================================================================

const PICKUP_WINDOWS = [
  { weekday: 2, startsAt: "11:00", endsAt: "14:00" },
  { weekday: 3, startsAt: "11:00", endsAt: "14:00" },
];

const BASE_CONFIG = {
  timezone: "Europe/Paris",
  enabled: true,
  dateSelectionMode: "customer_selectable" as const,
  slotSelectionMode: "none" as const,
  timeGranularityMinutes: null,
  leadTimeMinutes: 0,
  minLeadDays: 0,
  cutoffTime: null,
  cutoffOffsetDays: 1,
  bookingHorizonDays: 7,
};

test("[ELIG-1] jamais de date de repli : un refus n'expose aucune date", () => {
  // CSDJ-V1-UNFULFILLABLE-EXPLICIT-01. C'est la propriété la plus
  // importante du lot : un échec silencieux produirait une PROMESSE
  // faite au client au nom du commerçant.
  for (const input of [
    { ...BASE_CONFIG, bookingHorizonDays: 1 as const, minLeadDays: 300 },
    { ...BASE_CONFIG, slotSelectionMode: "time_within_window" as const },
  ]) {
    const got = resolveScheduleEligibility({
      config: input,
      windows: PICKUP_WINDOWS,
      slots: [],
      closures: [],
      nowIso: "2026-10-13T09:00:00+02:00",
    });
    assert.equal(got.status, "unfulfillable");
    assert.notEqual(got.reason, null, "un refus porte toujours un motif");
    assert.equal(got.firstEligibleDate, null);
    assert.equal(got.dates.length, 0);
  }
});

test("[ELIG-2] absence et désactivation donnent exactement le même objet", () => {
  // Sinon, activer puis désactiver laisserait une trace de comportement.
  const absent = resolveScheduleEligibility({
    config: null,
    windows: PICKUP_WINDOWS,
    slots: [],
    closures: [],
    nowIso: "2026-10-13T09:00:00+02:00",
  });
  const disabled = resolveScheduleEligibility({
    config: { ...BASE_CONFIG, enabled: false },
    windows: PICKUP_WINDOWS,
    slots: [],
    closures: [],
    nowIso: "2026-10-13T09:00:00+02:00",
  });
  assert.deepEqual(disabled, absent);
  assert.equal(absent.status, "absent");
  assert.equal(absent.timezone, null, "une absence ne révèle même pas le fuseau");
});

test("[ELIG-3] CSDJ-V1-SINGLE-OFFER-AUTHORITY-01 : une seule table fait foi", () => {
  const slots = [
    { weekday: 2, slotKey: "11-14", startsAt: "11:00", endsAt: "14:00" },
    { weekday: 3, slotKey: "11-14", startsAt: "11:00", endsAt: "14:00" },
  ];
  // `fixed_slots` IGNORE les fenêtres : des fenêtres contradictoires ne
  // changent rien.
  const withSlots = resolveScheduleEligibility({
    config: { ...BASE_CONFIG, slotSelectionMode: "fixed_slots" },
    windows: [{ weekday: 0, startsAt: "08:00", endsAt: "09:00" }],
    slots,
    closures: [],
    nowIso: "2026-10-13T09:00:00+02:00",
  });
  assert.deepEqual(
    withSlots.dates.map((d) => d.date),
    ["2026-10-13", "2026-10-14", "2026-10-20"]
  );
  for (const d of withSlots.dates) {
    for (const o of d.offers) assert.equal(o.slotKey, "11-14");
  }
  // Et symétriquement : `none` lit les FENÊTRES et ignore les créneaux.
  const withWindows = resolveScheduleEligibility({
    config: BASE_CONFIG,
    windows: PICKUP_WINDOWS,
    slots: [{ weekday: 0, slotKey: "dim", startsAt: "08:00", endsAt: "09:00" }],
    closures: [],
    nowIso: "2026-10-13T09:00:00+02:00",
  });
  for (const d of withWindows.dates) {
    for (const o of d.offers) assert.equal(o.slotKey, null);
  }
  assert.ok(
    withWindows.dates.every((d) => d.date !== "2026-10-18"),
    "le dimanche n'est ouvert par aucune fenêtre : le créneau du dimanche est ignoré"
  );
});

test("[ELIG-4] une politique incohérente est refusée, jamais interprétée", () => {
  const got = resolveScheduleEligibility({
    config: {
      ...BASE_CONFIG,
      dateSelectionMode: "derived_earliest",
      slotSelectionMode: "fixed_slots",
    },
    windows: [],
    slots: [{ weekday: 2, slotKey: "a", startsAt: "11:00", endsAt: "12:00" }],
    closures: [],
    nowIso: "2026-10-13T09:00:00+02:00",
  });
  assert.equal(got.status, "unfulfillable");
  assert.equal(got.reason, "no_offer_configured");
  assert.equal(got.firstEligibleDate, null);
});

test("[ELIG-5] fonction PURE : même entrée, même sortie, aucune horloge lue", () => {
  const input = {
    config: BASE_CONFIG,
    windows: PICKUP_WINDOWS,
    slots: [],
    closures: [],
    nowIso: "2026-10-13T09:00:00+02:00",
  };
  const a = resolveScheduleEligibility(input);
  const b = resolveScheduleEligibility(input);
  assert.deepEqual(b, a);
  // Et l'instant est bien celui FOURNI, pas celui de la machine : le
  // même calcul une seconde plus tard donne le même résultat.
  assert.equal(a.firstEligibleDate, "2026-10-13");
});

test("[ELIG-6] un instant illisible est une erreur, jamais un résultat vide", () => {
  // Confondre « je ne sais pas quand on est » avec « rien n'est
  // éligible » rendrait un défaut indiscernable d'un refus légitime.
  assert.throws(
    () =>
      resolveScheduleEligibility({
        config: BASE_CONFIG,
        windows: PICKUP_WINDOWS,
        slots: [],
        closures: [],
        nowIso: "pas une date",
      }),
    /CSDJ1_INVALID_NOW/
  );
});

test("[ELIG-7] l'heure limite est STRICTE à la seconde", () => {
  const cfg = { ...BASE_CONFIG, cutoffTime: "16:00", cutoffOffsetDays: 1 };
  const at = (nowIso: string) =>
    resolveScheduleEligibility({
      config: cfg,
      windows: PICKUP_WINDOWS,
      slots: [],
      closures: [],
      nowIso,
    }).dates.map((d) => d.date);

  // Mercredi 14 est ouvert (weekday 3) ; son heure limite est mardi 16:00.
  assert.ok(at("2026-10-13T15:59:59+02:00").includes("2026-10-14"));
  assert.ok(!at("2026-10-13T16:00:00+02:00").includes("2026-10-14"));
  assert.ok(!at("2026-10-13T16:00:01+02:00").includes("2026-10-14"));
});

test("[ELIG-8] cutoffTime null signifie AUCUNE limite, et non minuit", () => {
  const dates = resolveScheduleEligibility({
    config: { ...BASE_CONFIG, cutoffTime: null },
    windows: PICKUP_WINDOWS,
    slots: [],
    closures: [],
    // Mardi 23:50 : avec une limite à minuit, mardi serait encore
    // ouvert ; sans limite du tout, il l'est aussi -- la distinction se
    // voit sur MERCREDI, qu'une limite à minuit la veille exclurait.
    nowIso: "2026-10-13T23:50:00+02:00",
  }).dates.map((d) => d.date);
  // Horizon de 7 jours depuis le 13 : la borne haute est le 20 inclus,
  // et seuls mardi (2) et mercredi (3) portent une fenêtre.
  assert.deepEqual(dates, ["2026-10-13", "2026-10-14", "2026-10-20"]);
});

test("[ELIG-9] le fuseau vient de la CONFIGURATION, jamais de la machine", () => {
  // Deux portées, même instant, deux fuseaux : deux dates civiles
  // différentes. Si le calcul lisait le fuseau du processus, les deux
  // résultats seraient identiques.
  const nowIso = "2026-10-13T23:30:00+00:00";
  const paris = resolveScheduleEligibility({
    config: { ...BASE_CONFIG, timezone: "Europe/Paris" },
    windows: PICKUP_WINDOWS,
    slots: [],
    closures: [],
    nowIso,
  });
  const auckland = resolveScheduleEligibility({
    config: { ...BASE_CONFIG, timezone: "Pacific/Auckland" },
    windows: PICKUP_WINDOWS,
    slots: [],
    closures: [],
    nowIso,
  });
  // À 23:30 UTC le 13, il est déjà le 14 à Paris (UTC+2) et le 14 à
  // Auckland (UTC+13) -- mais Auckland est plus loin dans la journée.
  assert.equal(paris.firstEligibleDate, "2026-10-14");
  assert.equal(auckland.firstEligibleDate, "2026-10-14");
  // La preuve que le fuseau est bien lu : un fuseau à l'ouest donne
  // encore le 13.
  const la = resolveScheduleEligibility({
    config: { ...BASE_CONFIG, timezone: "America/Los_Angeles" },
    windows: PICKUP_WINDOWS,
    slots: [],
    closures: [],
    nowIso,
  });
  assert.equal(la.firstEligibleDate, "2026-10-13");
});

test("[ELIG-10] la granularité n'est rendue que là où elle a un sens", () => {
  const withWindow = resolveScheduleEligibility({
    config: {
      ...BASE_CONFIG,
      slotSelectionMode: "time_within_window",
      timeGranularityMinutes: 15,
    },
    windows: PICKUP_WINDOWS,
    slots: [],
    closures: [],
    nowIso: "2026-10-13T09:00:00+02:00",
  });
  assert.equal(withWindow.timeGranularityMinutes, 15);

  // En `fixed_slots`, une granularité résiduelle ne doit pas fuir : elle
  // ferait croire à une grille d'horaires qui n'existe pas.
  const withSlots = resolveScheduleEligibility({
    config: {
      ...BASE_CONFIG,
      slotSelectionMode: "fixed_slots",
      timeGranularityMinutes: 15,
    },
    windows: [],
    slots: [{ weekday: 2, slotKey: "a", startsAt: "11:00", endsAt: "12:00" }],
    closures: [],
    nowIso: "2026-10-13T09:00:00+02:00",
  });
  assert.equal(withSlots.timeGranularityMinutes, null);
});

test("[ELIG-11] derived_earliest rend UNE date, jamais une liste", () => {
  const got = resolveScheduleEligibility({
    config: { ...BASE_CONFIG, dateSelectionMode: "derived_earliest" },
    windows: PICKUP_WINDOWS,
    slots: [],
    closures: [],
    nowIso: "2026-10-13T09:00:00+02:00",
  });
  assert.equal(got.status, "dates_available");
  assert.equal(got.dates.length, 1);
  assert.equal(got.firstEligibleDate, "2026-10-13");
});

test("[ELIG-12] informational_only ne dérive AUCUNE date", () => {
  // Mandat §F, littéral : « Do NOT invent J+2 or J+3 ». Des fenêtres
  // parfaitement ouvertes ne doivent pas suffire à produire une date
  // quand la politique dit que le commerçant ne s'engage pas.
  const got = resolveScheduleEligibility({
    config: { ...BASE_CONFIG, dateSelectionMode: "informational_only" },
    windows: PICKUP_WINDOWS,
    slots: [],
    closures: [],
    nowIso: "2026-10-13T09:00:00+02:00",
  });
  assert.equal(got.status, "informational_only");
  assert.equal(got.firstEligibleDate, null);
  assert.equal(got.dates.length, 0);
  assert.equal(got.reason, null, "ce n'est pas un refus");
});

test("[ELIG-13] une fermeture ne décale pas l'horizon, elle retire un jour", () => {
  const open = resolveScheduleEligibility({
    config: BASE_CONFIG,
    windows: PICKUP_WINDOWS,
    slots: [],
    closures: [],
    nowIso: "2026-10-13T09:00:00+02:00",
  }).dates.map((d) => d.date);
  const closed = resolveScheduleEligibility({
    config: BASE_CONFIG,
    windows: PICKUP_WINDOWS,
    slots: [],
    closures: [{ closedOn: "2026-10-14" }],
    nowIso: "2026-10-13T09:00:00+02:00",
  }).dates.map((d) => d.date);
  assert.deepEqual(
    closed,
    open.filter((d) => d !== "2026-10-14"),
    "exactement un jour en moins, et aucun jour gagné au-delà de l'horizon"
  );
});
