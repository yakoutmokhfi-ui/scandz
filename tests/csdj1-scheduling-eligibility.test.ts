import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  type ScheduleInput,
  resolveScheduleEligibility,
  resolveWallTime,
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
    // Mardi 23:50. Une limite à minuit la veille exclurait MERCREDI ;
    // sans limite du tout, mercredi reste ouvert -- c'est là que se voit
    // la différence entre « aucune limite » et « limite à minuit ».
    nowIso: "2026-10-13T23:50:00+02:00",
  }).dates.map((d) => d.date);
  // Horizon de 7 jours depuis le 13 : borne haute le 20 inclus, et seuls
  // mardi (2) et mercredi (3) portent une fenêtre.
  // Mardi 13 disparaît pour une autre raison, et c'est voulu : sa seule
  // fenêtre commence à 11:00, donc AVANT l'instant courant
  // (CSDJ-V1-OFFER-START-INSTANT-01). Une offre passée n'est pas une
  // offre.
  assert.deepEqual(dates, ["2026-10-14", "2026-10-20"]);
});

test("[ELIG-9] le fuseau vient de la CONFIGURATION, jamais de la machine", () => {
  // Même instant, trois fuseaux : trois dates civiles différentes chez
  // le commerçant. Si le calcul lisait le fuseau du processus, les trois
  // résultats seraient identiques.
  //
  // `minLeadDays: 1` isole volontairement la propriété mesurée : la
  // première date est alors « le lendemain du jour du COMMERÇANT », et
  // le filtre d'instant ne peut pas s'en mêler, puisque le plancher de
  // cette date est postérieur à l'instant courant.
  const nowIso = "2026-10-13T23:30:00+00:00";
  const everyDay = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    startsAt: "09:00",
    endsAt: "18:00",
  }));
  const firstFor = (timezone: string) =>
    resolveScheduleEligibility({
      config: { ...BASE_CONFIG, timezone, minLeadDays: 1 },
      windows: everyDay,
      slots: [],
      closures: [],
      nowIso,
    }).firstEligibleDate;

  // À 23:30 UTC le 13 : il est déjà le 14 à Paris (UTC+2) et le 14 à
  // midi passé à Auckland (UTC+13), mais encore le 13 à Los Angeles.
  assert.equal(firstFor("Europe/Paris"), "2026-10-15");
  assert.equal(firstFor("Pacific/Auckland"), "2026-10-15");
  assert.equal(firstFor("America/Los_Angeles"), "2026-10-14");
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

// ====================================================================
// CSDJ1-AUD-02 — classification des heures murales
// ====================================================================

test("[AUD02-1] une heure murale INEXISTANTE est classée comme telle", () => {
  // Europe/Paris, 29 mars 2026 : 02:00 -> 03:00 n'a pas eu lieu.
  // Les six heures exigées par l'auditeur, bornes comprises.
  assert.equal(resolveWallTime(2026, 3, 29, 119, "Europe/Paris").status, "valid_unique");
  for (const minutes of [120, 130, 150, 179]) {
    const r = resolveWallTime(2026, 3, 29, minutes, "Europe/Paris");
    assert.equal(r.status, "nonexistent", `${minutes} min devrait être inexistante`);
    assert.equal(r.epochMs, null, "une heure inexistante ne rend AUCUN instant");
  }
  assert.equal(resolveWallTime(2026, 3, 29, 180, "Europe/Paris").status, "valid_unique");
});

test("[AUD02-2] une heure murale AMBIGUË est classée comme telle", () => {
  // Europe/Paris, 25 octobre 2026 : 02:00 -> 03:00 a eu lieu deux fois.
  assert.equal(resolveWallTime(2026, 10, 25, 119, "Europe/Paris").status, "valid_unique");
  for (const minutes of [120, 150, 179]) {
    const r = resolveWallTime(2026, 10, 25, minutes, "Europe/Paris");
    assert.equal(r.status, "ambiguous");
    assert.equal(r.epochMs, null, "une heure ambiguë ne rend AUCUN instant");
  }
  assert.equal(resolveWallTime(2026, 10, 25, 180, "Europe/Paris").status, "valid_unique");
});

test("[AUD02-3] un fuseau sans transition n'a ni heure inexistante ni ambiguë", () => {
  for (const tz of ["UTC", "Pacific/Kiritimati"]) {
    for (const date of [
      [2026, 3, 29],
      [2026, 10, 25],
      [2026, 4, 5],
      [2026, 10, 4],
    ] as const) {
      for (const minutes of [0, 105, 120, 150, 180, 1439]) {
        assert.equal(
          resolveWallTime(date[0], date[1], date[2], minutes, tz).status,
          "valid_unique",
          `${tz} ${date.join("-")} ${minutes}`
        );
      }
    }
  }
});

test("[AUD02-4] un fuseau à décalage NÉGATIF suit la même politique", () => {
  // America/New_York : saut le 8 mars 2026, recul le 1er novembre.
  assert.equal(
    resolveWallTime(2026, 3, 8, 150, "America/New_York").status,
    "nonexistent"
  );
  assert.equal(
    resolveWallTime(2026, 11, 1, 90, "America/New_York").status,
    "ambiguous"
  );
  assert.equal(resolveWallTime(2026, 3, 8, 60, "America/New_York").status, "valid_unique");
  assert.equal(resolveWallTime(2026, 11, 1, 210, "America/New_York").status, "valid_unique");
});

test("[AUD02-7] UNE TRANSITION NE FAIT PAS TOUJOURS UNE HEURE — Lord Howe", () => {
  // CSDJ-V1-TRANSITION-SAFE-CLASSIFY-01. Australia/Lord_Howe recule de
  // TRENTE minutes le 5 avril 2026 : 01:30-01:59 est vécu deux fois.
  // La détection par « plus ou moins une heure » de la première
  // remédiation manquait entièrement ce cas, puisque ni 00:45 ni 02:45
  // ne rendent 01:45.
  const lh = "Australia/Lord_Howe";
  assert.equal(resolveWallTime(2026, 4, 5, 60, lh).status, "valid_unique", "01:00");
  assert.equal(resolveWallTime(2026, 4, 5, 85, lh).status, "valid_unique", "01:25");
  for (const [minutes, label] of [
    [90, "01:30"],
    [105, "01:45 — la reproduction de l'auditeur"],
    [119, "01:59"],
  ] as const) {
    const r = resolveWallTime(2026, 4, 5, minutes, lh);
    assert.equal(r.status, "ambiguous", `${label} doit être ambiguë`);
    assert.equal(r.epochMs, null);
  }
  assert.equal(resolveWallTime(2026, 4, 5, 120, lh).status, "valid_unique", "02:00");

  // Et dans l'autre sens : le 4 octobre 2026, Lord Howe AVANCE de
  // trente minutes, donc 02:00-02:29 n'existe pas.
  assert.equal(resolveWallTime(2026, 10, 4, 119, lh).status, "valid_unique", "01:59");
  for (const minutes of [120, 130, 149]) {
    assert.equal(
      resolveWallTime(2026, 10, 4, minutes, lh).status,
      "nonexistent",
      `${minutes} min devrait être inexistante`
    );
  }
  assert.equal(resolveWallTime(2026, 10, 4, 150, lh).status, "valid_unique", "02:30");

  // Un dimanche ordinaire : rien n'est refusé.
  for (const minutes of [90, 105, 120, 150]) {
    assert.equal(resolveWallTime(2026, 5, 3, minutes, lh).status, "valid_unique");
  }
});

test("[AUD02-8] la classification n'encode AUCUNE durée de transition", () => {
  // Preuve structurelle : le module ne doit contenir aucune constante
  // d'une heure servant à détecter une transition. La seule durée
  // admise est l'ÉCHANTILLONNAGE, qui ne décide de rien.
  const src = readFileSync("lib/scheduling/eligibility.ts", "utf8");
  const executable = src
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
  assert.ok(
    !executable.includes("3_600_000") && !executable.includes("3600000"),
    "aucune constante d'une heure ne doit subsister dans la décision"
  );
  assert.ok(
    executable.includes("OFFSET_PROBES_MS"),
    "la classification doit passer par l'échantillonnage des décalages"
  );
});

test("[AUD02-9] occurrence TOUT-OU-RIEN : début, fin et grille", () => {
  // CSDJ-V1-OCCURRENCE-ALL-OR-NOTHING-01, les quatre fenêtres de
  // l'auditeur, le 29 mars 2026 à Paris.
  const windowCase = (startsAt: string, endsAt: string) =>
    resolveScheduleEligibility({
      config: {
        ...BASE_CONFIG,
        slotSelectionMode: "time_within_window",
        timeGranularityMinutes: 15,
        bookingHorizonDays: 2,
        cutoffTime: null,
      },
      windows: [{ weekday: 0, startsAt, endsAt }],
      slots: [],
      closures: [],
      nowIso: "2026-03-28T00:30:00+01:00",
    });

  // Début valide, FIN inexistante : la première remédiation l'exposait.
  assert.equal(windowCase("01:30", "02:30").status, "unfulfillable");
  // Début ET fin dans le trou.
  assert.equal(windowCase("02:00", "03:00").status, "unfulfillable");
  // Bornes valides, mais la GRILLE traverse le trou.
  assert.equal(windowCase("01:30", "03:30").status, "unfulfillable");
  // Entièrement après la bascule : valide -- la politique ne sur-refuse pas.
  const after = windowCase("03:00", "04:00");
  assert.equal(after.status, "dates_available");
  assert.deepEqual(after.dates[0]!.offers, [
    { slotKey: null, startsAt: "03:00", endsAt: "04:00" },
  ]);
  // Entièrement avant : valide.
  assert.equal(windowCase("00:30", "01:30").status, "dates_available");
});

test("[AUD02-10] le refus porte sur l'OCCURRENCE, jamais sur la configuration", () => {
  // La même fenêtre, une semaine après la bascule : elle redevient
  // valide. Sinon un commerçant perdrait une fenêtre toute l'année à
  // cause d'un seul dimanche.
  const cfg = {
    ...BASE_CONFIG,
    slotSelectionMode: "time_within_window" as const,
    timeGranularityMinutes: 15,
    bookingHorizonDays: 2,
    cutoffTime: null,
  };
  const windows = [{ weekday: 0, startsAt: "01:30", endsAt: "02:30" }];
  const onTransition = resolveScheduleEligibility({
    config: cfg,
    windows,
    slots: [],
    closures: [],
    nowIso: "2026-03-28T00:30:00+01:00",
  });
  const weekAfter = resolveScheduleEligibility({
    config: cfg,
    windows,
    slots: [],
    closures: [],
    nowIso: "2026-04-04T00:30:00+02:00",
  });
  assert.equal(onTransition.status, "unfulfillable");
  assert.equal(weekAfter.status, "dates_available");
  assert.deepEqual(weekAfter.dates[0]!.offers, [
    { slotKey: null, startsAt: "01:30", endsAt: "02:30" },
  ]);
});

test("[AUD02-11] une heure limite non univoque écarte la date", () => {
  // On ne devine pas l'instant d'une limite : si l'heure limite tombe
  // elle-même dans un trou ou dans une heure vécue deux fois, la date
  // est écartée.
  const got = resolveScheduleEligibility({
    config: {
      ...BASE_CONFIG,
      slotSelectionMode: "fixed_slots",
      cutoffTime: "02:30",
      cutoffOffsetDays: 1,
      bookingHorizonDays: 2,
    },
    windows: [],
    // Le 30 mars 2026 est un lundi ; son heure limite est le 29 à 02:30,
    // qui n'existe pas à Paris.
    slots: [{ weekday: 1, slotKey: "a", startsAt: "10:00", endsAt: "12:00" }],
    closures: [],
    nowIso: "2026-03-28T00:30:00+01:00",
  });
  assert.equal(got.status, "unfulfillable");
  // `horizon_exhausted` et non `no_offer_in_horizon` : la date est
  // écartée par son HEURE LIMITE, donc avant même d'être comptée comme
  // ouverte. C'est exactement la définition de ce motif -- « le délai,
  // le minimum de jours ou l'heure limite repoussent la première date
  // au-delà de l'horizon ».
  assert.equal(got.reason, "horizon_exhausted");
});

// ====================================================================
// CSDJ1-AUD-01 — l'instant minimal, et rien d'autre
// ====================================================================

test("[AUD01-1] le délai de préparation filtre les OFFRES, pas seulement les dates", () => {
  // Reproduction littérale de l'audit : créneau 09:00-11:00, délai de
  // 120 minutes, il est 15:00.
  const base = {
    ...BASE_CONFIG,
    slotSelectionMode: "fixed_slots" as const,
    leadTimeMinutes: 120,
    bookingHorizonDays: 0,
    cutoffTime: null,
  };
  const slots = [
    { weekday: 2, slotKey: "0900-1100", startsAt: "09:00", endsAt: "11:00" },
  ];
  const got = resolveScheduleEligibility({
    config: base,
    windows: [],
    slots,
    closures: [],
    nowIso: "2026-10-13T15:00:00+02:00",
  });
  assert.equal(got.status, "unfulfillable");
  assert.equal(got.reason, "no_offer_in_horizon");
  assert.equal(got.dates.length, 0);

  // Et le matin, le même créneau est bien proposé : le filtre écarte
  // l'offre passée, il ne supprime pas l'offre.
  const earlier = resolveScheduleEligibility({
    config: base,
    windows: [],
    slots,
    closures: [],
    nowIso: "2026-10-13T06:00:00+02:00",
  });
  assert.equal(earlier.status, "dates_available");
  assert.deepEqual(earlier.dates[0]!.offers.map((o) => o.slotKey), ["0900-1100"]);
});

test("[AUD01-2] la comparaison d'instant est inclusive à la seconde", () => {
  const cfg = {
    ...BASE_CONFIG,
    slotSelectionMode: "fixed_slots" as const,
    bookingHorizonDays: 0,
    cutoffTime: null,
  };
  const slots = [
    { weekday: 2, slotKey: "1000", startsAt: "10:00", endsAt: "12:00" },
  ];
  const at = (nowIso: string) =>
    resolveScheduleEligibility({
      config: cfg,
      windows: [],
      slots,
      closures: [],
      nowIso,
    }).status;
  assert.equal(at("2026-10-13T09:59:59+02:00"), "dates_available");
  assert.equal(at("2026-10-13T10:00:00+02:00"), "dates_available", "PILE = réalisable");
  assert.equal(at("2026-10-13T10:00:01+02:00"), "unfulfillable");
});

test("[AUD01-3] une fenêtre est AVANCÉE sur la grille, jamais inventée", () => {
  const got = resolveScheduleEligibility({
    config: {
      ...BASE_CONFIG,
      slotSelectionMode: "time_within_window",
      timeGranularityMinutes: 15,
      bookingHorizonDays: 0,
      cutoffTime: null,
    },
    windows: [{ weekday: 2, startsAt: "11:00", endsAt: "14:00" }],
    slots: [],
    closures: [],
    nowIso: "2026-10-13T12:07:00+02:00",
  });
  // Grille ancrée sur 11:00 : le premier point utilisable est 12:15,
  // pas 12:07 -- la grille reste celle que le commerçant a décrite.
  assert.deepEqual(got.dates[0]!.offers, [
    { slotKey: null, startsAt: "12:15", endsAt: "14:00" },
  ]);
});

test("[AUD01-4] une fenêtre dont la grille sort entièrement disparaît", () => {
  const got = resolveScheduleEligibility({
    config: {
      ...BASE_CONFIG,
      slotSelectionMode: "time_within_window",
      timeGranularityMinutes: 15,
      bookingHorizonDays: 0,
      cutoffTime: null,
    },
    windows: [{ weekday: 2, startsAt: "11:00", endsAt: "14:00" }],
    slots: [],
    closures: [],
    nowIso: "2026-10-13T13:50:00+02:00",
  });
  // Le dernier point de grille strictement inférieur à 14:00 est 13:45,
  // déjà passé : plus rien n'est utilisable.
  assert.equal(got.status, "unfulfillable");
  assert.equal(got.reason, "no_offer_in_horizon");
});

test("[AUD01-5] les trois motifs d'infaisabilité restent distincts", () => {
  const windows = [{ weekday: 2, startsAt: "11:00", endsAt: "14:00" }];
  const reason = (cfg: Partial<typeof BASE_CONFIG>, closures: string[] = []) =>
    resolveScheduleEligibility({
      config: { ...BASE_CONFIG, cutoffTime: null, ...cfg },
      windows,
      slots: [],
      closures: closures.map((closedOn) => ({ closedOn })),
      nowIso: "2026-10-13T20:00:00+02:00",
    }).reason;

  // Des dates ouvertes, mais plus aucune offre réalisable.
  assert.equal(reason({ bookingHorizonDays: 0 }), "no_offer_in_horizon");
  // Toutes les dates de l'horizon sont fermées.
  assert.equal(reason({ bookingHorizonDays: 0 }, ["2026-10-13"]), "all_dates_closed");
  // La première date POSSIBLE est au-delà de l'horizon.
  assert.equal(reason({ minLeadDays: 30, bookingHorizonDays: 7 }), "horizon_exhausted");
});

// ====================================================================
// CSDJ1-AUD-04 — précision à la minute
// ====================================================================

test("[AUD04-1] une offre sous-minute est ÉCARTÉE, jamais tronquée", () => {
  const got = resolveScheduleEligibility({
    config: {
      ...BASE_CONFIG,
      slotSelectionMode: "fixed_slots",
      bookingHorizonDays: 0,
      cutoffTime: null,
    },
    windows: [],
    slots: [
      { weekday: 2, slotKey: "zero", startsAt: "09:00:01", endsAt: "09:00:59" },
      { weekday: 2, slotKey: "franche", startsAt: "10:00", endsAt: "12:00" },
    ],
    closures: [],
    nowIso: "2026-10-13T06:00:00+02:00",
  });
  // Tronquer aurait produit « 09:00-09:00 », une offre de durée nulle
  // affichée comme disponible : exactement le défaut CSDJ1-AUD-04.
  assert.deepEqual(got.dates[0]!.offers.map((o) => o.slotKey), ["franche"]);
});

test("[AUD04-2] toute heure publiée est en HH:MM, jamais en HH:MM:SS", () => {
  const got = resolveScheduleEligibility({
    config: {
      ...BASE_CONFIG,
      slotSelectionMode: "fixed_slots",
      bookingHorizonDays: 1,
      cutoffTime: null,
    },
    windows: [],
    slots: [{ weekday: 2, slotKey: "a", startsAt: "09:00:00", endsAt: "11:00:00" }],
    closures: [],
    nowIso: "2026-10-13T06:00:00+02:00",
  });
  for (const d of got.dates) {
    for (const o of d.offers) {
      assert.match(o.startsAt, /^\d{2}:\d{2}$/);
      assert.match(o.endsAt, /^\d{2}:\d{2}$/);
    }
  }
});
