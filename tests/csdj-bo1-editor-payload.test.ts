import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

import {
  type AvailabilityDraft,
  buildSaveFulfillmentConfigurationPayload,
  draftChangeCount,
  draftFromServer,
  isDraftDirty,
  issueKey,
  newRowId,
  saveErrorKey,
  validateDraft,
} from "../lib/availability-payload.ts";
import { CSDJ_BO1_WRITE_CONTRACT } from "../lib/availability-editor.ts";
import {
  FakeFulfillmentWriteBackend,
  FakeWriteRefusal,
  auLaitCruPickupFixture,
} from "./helpers/fake-fulfillment-write-backend.ts";
import { DICTS } from "../lib/i18n.ts";

// ====================================================================
// CSDJ-BO-1 — ÉDITEUR FONCTIONNEL (issue #149) : BROUILLON, CHARGE,
// VALIDATION, ET LE CONTRAT D'ÉCRITURE EN UN SEUL APPEL.
//
// Ce fichier tient les propriétés qui ne dépendent d'aucun DOM :
//   - une charge d'écriture est l'état VOULU en entier, jamais un delta ;
//   - la validation locale REPRODUIT les refus du serveur, par leur nom ;
//   - le verrou d'écriture tient, et il ne tient pas par convention :
//     `CSDJ_BO1_WRITE_CONTRACT.available` vaut false, et le service
//     refuse sans réseau ;
//   - le backend simulé est transactionnel : un refus ne laisse RIEN.
// ====================================================================

const REPO_ROOT = process.cwd();

function baseDraft(over: Partial<AvailabilityDraft> = {}): AvailabilityDraft {
  return {
    modeCode: "pickup",
    fulfillmentRuleId: null,
    method: "v1",
    // Remédiation R1 : les DEUX jetons, avec la précision microseconde
    // que le contrat impose de conserver telle quelle.
    expectedUpdatedAt: "2026-10-14T00:00:00.123456Z",
    expectedRevision: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
    enabled: true,
    timezone: "Europe/Paris",
    dateSelectionMode: "customer_selectable",
    slotSelectionMode: "fixed_slots",
    timeGranularityMinutes: "",
    leadTimeMinutes: "0",
    minLeadDays: "1",
    cutoffTime: "16:00",
    cutoffOffsetDays: "1",
    bookingHorizonDays: "14",
    windows: [],
    slots: [
      { rowId: "s1", weekday: 2, slotKey: "midi", startsAt: "11:00", endsAt: "14:00" },
    ],
    closures: [],
    preparationWeekdays: [],
    preparationClosures: [],
    holidayCalendarId: null,
    preparationOnHolidays: "open",
    availabilityOnHolidays: "open",
    capacityEnabled: false,
    capacityMaxOrders: "",
    ...over,
  };
}

const codes = (draft: AvailabilityDraft) => validateDraft(draft).map((i) => i.code).sort();

// --------------------------------------------------------------------
// 1. Le verrou d'écriture
// --------------------------------------------------------------------

test("[BO1-ED-1] le contrat d'écriture est déclaré disponible depuis #154, et le service garde son verrou avant tout appel réseau", () => {
  // Issue #149 : « Ne jamais simplement basculer le flag avant qu'une
  // RPC transactionnelle Boulez existe et que les tests soient passés. »
  // Le SQL est installé et le flag a été basculé par #154 ; le VERROU,
  // lui, reste dans le service (voir [BO1-RPC-2b]).
  assert.equal(CSDJ_BO1_WRITE_CONTRACT.available, true);
  assert.equal(CSDJ_BO1_WRITE_CONTRACT.reason, "CSDJ_BO1_WRITE_CONTRACT_READY");
  const svc = readFileSync(path.join(REPO_ROOT, "lib", "services", "availability.ts"), "utf8");
  const guard = svc.indexOf("if (!CSDJ_BO1_WRITE_CONTRACT.available)");
  const call = svc.search(/\.rpc\(\s*["'`]save_fulfillment_configuration/);
  assert.ok(guard >= 0 && call > guard, "le verrou précède l'appel d'écriture");
});

test("[BO1-ED-2] une seule RPC d'écriture existe dans le lot, et c'est celle du contrat", () => {
  const service = readFileSync(path.join(REPO_ROOT, "lib", "services", "availability.ts"), "utf8");
  const page = readFileSync(
    path.join(REPO_ROOT, "app", "dashboard", "availability", "page.tsx"),
    "utf8"
  );
  const calls = [...service.matchAll(/supabase\.rpc\(\s*["'`]([a-z0-9_]+)["'`]/g)].map((m) => m[1]);
  // REMÉDIATION R1 : la lecture AUTORITAIRE `get_fulfillment_configuration`
  // s'ajoute à l'inventaire (contrat Boulez §2) -- c'est elle qui porte
  // les deux jetons de concurrence. L'invariant tenu ici n'a pas changé :
  // il n'existe toujours qu'UNE écriture.
  assert.deepEqual(
    calls.sort(),
    [
      "get_checkout_fulfillment_schedule",
      "get_fulfillment_configuration",
      "get_merchant_fulfillment_schedules",
      "get_merchant_fulfillment_schedules_v12",
      "save_fulfillment_configuration",
    ],
    "exactement quatre lectures et UNE écriture"
  );
  assert.equal(
    calls.filter((name) => name.startsWith("save_") || name.startsWith("mutate_")).length,
    1,
    "une seule écriture, quoi qu'il arrive au reste de l'inventaire"
  );
  // « no multi-RPC save » : les six actions par étapes ne sont appelées
  // nulle part, ni dans le service, ni dans la page.
  for (const [label, src] of [
    ["service", service],
    ["page", page],
  ] as const) {
    assert.ok(
      !/rpc\(\s*["'`]mutate_merchant_fulfillment_schedule/.test(src),
      `${label} : la sauvegarde par étapes reste interdite`
    );
  }
  assert.ok(!page.includes("supabase.rpc"), "la page ne parle jamais à Supabase directement");
});

// --------------------------------------------------------------------
// 2. Brouillon et charge
// --------------------------------------------------------------------

test("[BO1-ED-3] le brouillon part de ce que le serveur a rendu, sans rien inventer", () => {
  const empty = draftFromServer({ modeCode: "pickup", fulfillmentRuleId: null });
  assert.equal(empty.enabled, false, "une portée neuve n'est jamais active d'office");
  assert.equal(empty.dateSelectionMode, "informational_only");
  assert.equal(empty.slotSelectionMode, "none");
  assert.equal(empty.bookingHorizonDays, "14", "défaut du serveur, pas une valeur inventée");
  assert.equal(empty.cutoffTime, "", "aucune heure limite supposée");
  assert.deepEqual(empty.windows, []);
  assert.equal(empty.expectedUpdatedAt, null, "création : aucune version à épingler");
});

test("[BO1-ED-4] la charge porte l'état VOULU en entier, jamais un delta", () => {
  const draft = baseDraft();
  const payload = buildSaveFulfillmentConfigurationPayload(draft) as Record<string, unknown>;
  assert.equal(payload.modeCode, "pickup");
  assert.equal(payload.fulfillmentRuleId, null);
  assert.equal(payload.method, "v1");
  assert.equal(payload.enabled, true);
  // Les DEUX jetons, recopiés TELS QUELS -- la microseconde comprise.
  assert.equal(payload.expectedUpdatedAt, "2026-10-14T00:00:00.123456Z");
  assert.equal(payload.expectedRevision, "a1b2c3d4e5f60718293a4b5c6d7e8f90");
  assert.ok(
    Object.prototype.hasOwnProperty.call(payload, "expectedUpdatedAt") &&
      Object.prototype.hasOwnProperty.call(payload, "expectedRevision"),
    "les deux clés sont TOUJOURS présentes, « null » compris"
  );
  assert.equal(
    (payload.policy as Record<string, unknown>).cutoffOffsetDays,
    1,
    "en v1, le décalage est fourni et borné de 0 à 30"
  );
  const policy = payload.policy as Record<string, unknown>;
  assert.equal(policy.cutoffTime, "16:00");
  assert.equal(policy.minLeadDays, 1);
  assert.equal(policy.timeGranularityMinutes, null, "pas de grille hors « heure libre »");
  assert.deepEqual(payload.windows, [], "une liste vide est ENVOYÉE, pas omise");
  assert.deepEqual(payload.slots, [
    { weekday: 2, slotKey: "midi", startsAt: "11:00", endsAt: "14:00", displayOrder: 0 },
  ]);
  // Les identités locales de ligne ne traversent jamais.
  assert.ok(!JSON.stringify(payload).includes("rowId"));
  // Une charge v1 ne porte AUCUNE section v1.2 : le serveur la
  // refuserait (CSDJBO1_METHOD_MISMATCH).
  assert.equal(payload.preparation, undefined);
  assert.equal(payload.holidays, undefined);
  assert.equal(payload.capacity, undefined);
});

test("[BO1-ED-5] une charge v1.2 porte ses trois sections, et le décalage d'heure limite y vaut 0", () => {
  const draft = baseDraft({
    method: "v1.2",
    cutoffOffsetDays: "0",
    preparationWeekdays: [1, 2, 3],
    preparationClosures: [{ rowId: "p1", closedOn: "2026-10-14", label: "Entretien four" }],
    capacityEnabled: true,
    capacityMaxOrders: "12",
    holidayCalendarId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    availabilityOnHolidays: "closed",
  });
  const payload = buildSaveFulfillmentConfigurationPayload(draft) as Record<string, unknown>;
  // REMÉDIATION R1 : le contrat de Boulez impose `cutoffOffsetDays`
  // « absent ou égal à 0 » en v1.2. Ce lot l'OMET : la v1.2 déplace
  // l'origine au prochain jour de préparation au lieu de décaler en
  // jours, donc le champ n'a pas de valeur neutre à envoyer, et un 0
  // envoyé laisserait croire à un réglage qui n'existe pas. L'assertion
  // précédente (« vaut 0 ») est donc remplacée, pas supprimée.
  assert.ok(
    !Object.prototype.hasOwnProperty.call(payload.policy, "cutoffOffsetDays"),
    "en v1.2, le décalage d'heure limite est ABSENT de la politique"
  );
  assert.deepEqual((payload.preparation as Record<string, unknown>).weekdays, [1, 2, 3]);
  assert.deepEqual((payload.preparation as Record<string, unknown>).closures, [
    { closedOn: "2026-10-14", label: "Entretien four" },
  ]);
  assert.deepEqual(payload.holidays, {
    calendarId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    preparationOnHolidays: "open",
    availabilityOnHolidays: "closed",
  });
  assert.deepEqual(payload.capacity, { enabled: true, maxOrders: 12 });
});

test("[BO1-ED-6] un champ vidé devient null, jamais 0 ni chaîne vide", () => {
  const payload = buildSaveFulfillmentConfigurationPayload(
    baseDraft({ cutoffTime: "   ", capacityEnabled: false, capacityMaxOrders: "9" })
  ) as Record<string, unknown>;
  assert.equal((payload.policy as Record<string, unknown>).cutoffTime, null);
  const withCapacity = buildSaveFulfillmentConfigurationPayload(
    baseDraft({ method: "v1.2", cutoffOffsetDays: "0", capacityEnabled: false, capacityMaxOrders: "9" })
  ) as Record<string, unknown>;
  assert.deepEqual(
    withCapacity.capacity,
    { enabled: false, maxOrders: null },
    "une limite éteinte n'envoie pas son ancien maximum"
  );
});

test("[BO1-ED-7] « modifié » se déduit de la comparaison, et l'ordre des lignes n'en fait pas partie", () => {
  const baseline = baseDraft();
  assert.equal(isDraftDirty(baseline, baseline), false);
  assert.equal(draftChangeCount(baseline, baseline), 0);

  const reordered = baseDraft({
    slots: [
      { rowId: newRowId("slot"), weekday: 2, slotKey: "midi", startsAt: "11:00", endsAt: "14:00" },
    ],
  });
  assert.equal(
    isDraftDirty(reordered, baseline),
    false,
    "une identité de ligne régénérée n'est pas une modification"
  );

  const changed = baseDraft({ cutoffTime: "17:00" });
  assert.equal(isDraftDirty(changed, baseline), true);
  assert.equal(draftChangeCount(changed, baseline), 1);

  const twoChanges = baseDraft({ cutoffTime: "17:00", minLeadDays: "2" });
  assert.equal(draftChangeCount(twoChanges, baseline), 2);
});

// --------------------------------------------------------------------
// 3. Validation : les refus du serveur, reproduits par leur nom
// --------------------------------------------------------------------

test("[BO1-ED-8] un brouillon conforme ne produit aucun refus", () => {
  assert.deepEqual(codes(baseDraft()), []);
});

test("[BO1-ED-9] chaque refus du serveur a son miroir local, nommé", () => {
  assert.deepEqual(codes(baseDraft({ timezone: "  " })), ["timezone_missing"]);
  assert.deepEqual(
    codes(baseDraft({ dateSelectionMode: "derived_earliest" })),
    ["policy_incoherent"],
    "choisir une heure exige que le client choisisse la date"
  );
  assert.deepEqual(codes(baseDraft({ cutoffTime: "16:00:30" })), ["cutoff_invalid"]);
  assert.deepEqual(codes(baseDraft({ cutoffTime: "24:00" })), ["cutoff_invalid"]);
  assert.deepEqual(codes(baseDraft({ minLeadDays: "400" })), ["lead_days_range"]);
  assert.deepEqual(codes(baseDraft({ minLeadDays: "" })), ["lead_days_range"]);
  assert.deepEqual(codes(baseDraft({ bookingHorizonDays: "-1" })), ["horizon_range"]);
  assert.deepEqual(codes(baseDraft({ leadTimeMinutes: "abc" })), ["lead_minutes_range"]);
  assert.deepEqual(
    codes(baseDraft({ method: "v1.2", cutoffOffsetDays: "1", preparationWeekdays: [2] })),
    ["cutoff_offset_removed"]
  );
  assert.deepEqual(
    codes(baseDraft({ method: "v1.2", cutoffOffsetDays: "0", preparationWeekdays: [] })),
    ["preparation_missing"]
  );
  assert.deepEqual(
    codes(baseDraft({ availabilityOnHolidays: "closed" })),
    ["holiday_policy_needs_calendar"]
  );
  assert.deepEqual(
    codes(
      baseDraft({
        method: "v1.2",
        cutoffOffsetDays: "0",
        preparationWeekdays: [2],
        capacityEnabled: true,
        capacityMaxOrders: "0",
      })
    ),
    ["capacity_invalid"]
  );
  assert.deepEqual(
    codes(
      baseDraft({
        method: "v1.2",
        cutoffOffsetDays: "0",
        preparationWeekdays: [2],
        dateSelectionMode: "informational_only",
        slotSelectionMode: "none",
        capacityEnabled: true,
        capacityMaxOrders: "5",
      })
    ),
    ["capacity_needs_date"]
  );
});

test("[BO1-ED-10] l'offre : bornes, chevauchement, clés de créneau et doublons", () => {
  assert.deepEqual(
    codes(baseDraft({ slots: [{ rowId: "s", weekday: 2, slotKey: "midi", startsAt: "14:00", endsAt: "11:00" }] })),
    ["slot_order"]
  );
  assert.deepEqual(
    codes(baseDraft({ slots: [{ rowId: "s", weekday: 2, slotKey: "Midi Pile", startsAt: "11:00", endsAt: "14:00" }] })),
    ["slot_key_invalid"]
  );
  assert.deepEqual(
    codes(
      baseDraft({
        slots: [
          { rowId: "a", weekday: 2, slotKey: "midi", startsAt: "11:00", endsAt: "14:00" },
          { rowId: "b", weekday: 2, slotKey: "midi", startsAt: "16:00", endsAt: "20:00" },
        ],
      })
    ),
    ["slot_duplicate"]
  );
  // Plages : la non-superposition est vérifiée par jour, comme le serveur.
  const overlapping = baseDraft({
    slotSelectionMode: "time_within_window",
    timeGranularityMinutes: "30",
    slots: [],
    windows: [
      { rowId: "w1", weekday: 2, startsAt: "11:00", endsAt: "15:00" },
      { rowId: "w2", weekday: 2, startsAt: "14:00", endsAt: "19:00" },
    ],
  });
  assert.deepEqual(codes(overlapping), ["window_overlap"]);
  // Le même chevauchement sur deux jours DIFFÉRENTS est licite.
  const differentDays = baseDraft({
    slotSelectionMode: "time_within_window",
    timeGranularityMinutes: "30",
    slots: [],
    windows: [
      { rowId: "w1", weekday: 2, startsAt: "11:00", endsAt: "15:00" },
      { rowId: "w2", weekday: 3, startsAt: "14:00", endsAt: "19:00" },
    ],
  });
  assert.deepEqual(codes(differentDays), []);
});

test("[BO1-ED-11] activer une portée sans offre est refusé AVANT l'envoi, comme le serveur le refuserait", () => {
  assert.deepEqual(codes(baseDraft({ enabled: true, slots: [] })), ["offer_missing"]);
  // Désactivée, la même configuration est acceptable : une portée
  // éteinte rend au client le parcours d'avant, ce n'est pas une erreur.
  assert.deepEqual(codes(baseDraft({ enabled: false, slots: [] })), []);
  // En politique purement informative, aucune offre n'est exigée.
  assert.deepEqual(
    codes(
      baseDraft({
        enabled: true,
        slots: [],
        dateSelectionMode: "informational_only",
        slotSelectionMode: "none",
      })
    ),
    []
  );
});

test("[BO1-ED-12] fermetures : date valide, pas de doublon, motif borné, 731 au plus", () => {
  assert.deepEqual(
    codes(baseDraft({ closures: [{ rowId: "c", closedOn: "", label: "" }] })),
    ["closure_date_invalid"]
  );
  assert.deepEqual(
    codes(
      baseDraft({
        closures: [
          { rowId: "c1", closedOn: "2026-12-25", label: "Noël" },
          { rowId: "c2", closedOn: "2026-12-25", label: "Noël bis" },
        ],
      })
    ),
    ["closure_duplicate"]
  );
  assert.deepEqual(
    codes(baseDraft({ closures: [{ rowId: "c", closedOn: "2026-12-25", label: "x".repeat(121) }] })),
    ["closure_label_too_long"]
  );
  const many = Array.from({ length: 732 }, (_, i) => ({
    rowId: `c${i}`,
    closedOn: new Date(Date.UTC(2027, 0, 1 + i)).toISOString().slice(0, 10),
    label: "",
  }));
  assert.ok(codes(baseDraft({ closures: many })).includes("too_many_closures"));
});

test("[BO1-ED-13] chaque code de refus a sa phrase, dans les quatre langues du mandat", () => {
  const allCodes = [
    "timezone_missing", "policy_incoherent", "policy_unknown", "granularity_missing",
    "granularity_range", "lead_days_range", "lead_minutes_range", "horizon_range",
    "cutoff_invalid", "cutoff_offset_removed", "window_order", "window_overlap",
    "window_weekday", "slot_order", "slot_key_invalid", "slot_duplicate",
    "closure_date_invalid", "closure_duplicate", "closure_label_too_long",
    "too_many_closures", "preparation_missing", "preparation_weekday_invalid",
    "holiday_policy_needs_calendar", "capacity_invalid", "capacity_needs_date",
    "offer_missing", "too_many_windows", "too_many_slots",
  ] as const;
  for (const lang of ["fr", "en", "ar", "nl"] as const) {
    const dict = DICTS[lang] as Record<string, string>;
    for (const code of allCodes) {
      const key = issueKey(code);
      assert.ok(
        dict[key] && dict[key].trim().length > 5,
        `${lang} : la phrase de ${code} (${key}) manque`
      );
    }
  }
});

test("[BO1-ED-14] un refus serveur devient une phrase sûre, jamais un code brut", () => {
  const fr = DICTS.fr as Record<string, string>;
  const cases: Array<[string, string]> = [
    ["CSDJBO1_INCOMPLETE_CONFIGURATION: offer_missing", "avSaveIncomplete"],
    ["CSDJBO1_STALE_CONFIGURATION: la portée a changé", "avSaveStale"],
    ["CSDJBO1_METHOD_MISMATCH: sections v1.2", "avSaveMethodMismatch"],
    ["CSDJ1_FORBIDDEN: rôle requis", "avSaveForbidden"],
    ["CSDJ1_UNKNOWN_MODE: hors catalogue", "avSaveUnknownMode"],
    ["CSDJ1_WINDOW_OVERLAP: jour 2", "avIssueWindowOverlap"],
    ["CSDJ12_INVALID_CAPACITY: maximum requis", "avIssueCapacityInvalid"],
    ['relation "public.restaurant_fulfillment_schedule" does not exist', "avSaveFailed"],
  ];
  for (const [message, expected] of cases) {
    assert.equal(saveErrorKey(new Error(message)), expected, message);
    const text = fr[expected];
    assert.ok(text && text.length > 10);
    assert.ok(
      !/CSDJ|SQLSTATE|public\.|[0-9a-f]{8}-[0-9a-f]{4}/.test(text),
      `${expected} ne doit rien révéler : « ${text} »`
    );
  }
});

// --------------------------------------------------------------------
// 4. Le backend simulé est transactionnel
// --------------------------------------------------------------------

test("[BO1-ED-15] la fixture « Au Lait Cru » est celle de l'issue, et elle n'est pas globale", () => {
  const fixture = auLaitCruPickupFixture();
  const pickup = fixture.schedules[0];
  assert.equal(pickup.modeCode, "pickup");
  assert.equal(pickup.slotSelectionMode, "fixed_slots", "retrait par CRÉNEAU, jamais heure précise");
  assert.equal(pickup.cutoffTime, "16:00:00");
  assert.equal(pickup.cutoffOffsetDays, 1, "heure limite 16 h la VEILLE");
  // Mardi (2) à samedi (6), 11–14 et 16–20 ; dimanche (0) et lundi (1)
  // sans aucun créneau, donc fermés.
  const days = [...new Set(pickup.slots.map((s) => s.weekday))].sort();
  assert.deepEqual(days, [2, 3, 4, 5, 6]);
  for (const weekday of days) {
    const ranges = pickup.slots
      .filter((s) => s.weekday === weekday)
      .map((s) => `${s.startsAt}-${s.endsAt}`)
      .sort();
    assert.deepEqual(ranges, ["11:00-14:00", "16:00-20:00"], `jour ${weekday}`);
  }
  assert.equal(pickup.slots.filter((s) => s.weekday === 0 || s.weekday === 1).length, 0);
  // Les autres modes restent indépendants : la fixture ne les configure pas.
  assert.deepEqual(fixture.schedules.map((s) => s.modeCode), ["pickup"]);
});

test("[BO1-ED-16] le backend simulé écrit tout ou rien : un refus ne laisse RIEN", () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  const before = backend.snapshot("r1");

  // Activation d'une portée sans offre : refus nommé.
  assert.throws(
    () =>
      backend.save("r1", {
        modeCode: "pickup",
        fulfillmentRuleId: null,
        method: "v1",
        enabled: true,
        // REMÉDIATION R1 : les DEUX jetons, et une politique COMPLÈTE --
        // le backend de référence exige désormais chaque champ
        // obligatoire du contrat plutôt que de combler les manques par
        // un défaut inventé. La charge de ce test est donc complétée ;
        // ce qui est éprouvé reste le refus d'activation sans offre.
        expectedUpdatedAt: "2026-10-14T00:00:00.123456Z",
        expectedRevision: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
        policy: {
          timezone: "Europe/Paris",
          dateSelectionMode: "customer_selectable",
          slotSelectionMode: "fixed_slots",
          timeGranularityMinutes: null,
          leadTimeMinutes: 0,
          minLeadDays: 1,
          cutoffTime: "16:00",
          bookingHorizonDays: 14,
          cutoffOffsetDays: 1,
        },
        windows: [],
        slots: [],
        closures: [],
      }),
    (error: unknown) => {
      assert.ok(error instanceof FakeWriteRefusal);
      assert.match((error as Error).message, /CSDJBO1_INCOMPLETE_CONFIGURATION/);
      return true;
    }
  );
  assert.equal(backend.snapshot("r1"), before, "un refus ne doit rien avoir écrit");
});

test("[BO1-ED-17] édition concurrente : REFUSÉE, jamais écrasée", () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  const draft = baseDraft({
    cutoffTime: "17:00",
    expectedUpdatedAt: "2026-10-14T00:00:00.123456Z",
  });

  // Premier enregistrement : accepté, l'horodatage change.
  backend.save("r1", buildSaveFulfillmentConfigurationPayload(draft));
  const after = backend.snapshot("r1");

  // Deuxième enregistrement avec l'ANCIEN horodatage : refusé.
  assert.throws(
    () => backend.save("r1", buildSaveFulfillmentConfigurationPayload(draft)),
    /CSDJBO1_STALE_CONFIGURATION/
  );
  assert.equal(backend.snapshot("r1"), after, "l'état du premier enregistrement est intact");
});

test("[BO1-ED-18] isolation locataire : écrire chez l'un ne touche jamais l'autre", () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  backend.setTenant("r2", auLaitCruPickupFixture());
  const r2Before = backend.snapshot("r2");

  backend.save(
    "r1",
    buildSaveFulfillmentConfigurationPayload(
      baseDraft({ cutoffTime: "18:30", expectedUpdatedAt: "2026-10-14T00:00:00.123456Z" })
    )
  );

  assert.equal(backend.snapshot("r2"), r2Before, "r2 ne doit pas avoir bougé d'un octet");
  assert.notEqual(backend.snapshot("r1"), r2Before, "r1, lui, a bien changé");
});

test("[BO1-ED-19] rôle staff : refusé par le serveur simulé, comme par l'autorité SQL", () => {
  const backend = new FakeFulfillmentWriteBackend();
  const state = auLaitCruPickupFixture();
  state.role = "staff";
  backend.setTenant("r1", state);
  const before = backend.snapshot("r1");
  assert.throws(
    () =>
      backend.save(
        "r1",
        buildSaveFulfillmentConfigurationPayload(
          baseDraft({ expectedUpdatedAt: "2026-10-14T00:00:00.123456Z" })
        )
      ),
    /CSDJ1_FORBIDDEN/
  );
  assert.equal(backend.snapshot("r1"), before);
});

test("[BO1-ED-20] un enregistrement accepté remplace INTÉGRALEMENT les listes", () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  // On retire tous les créneaux du samedi et on ajoute une fermeture.
  const fixture = auLaitCruPickupFixture().schedules[0];
  const draft = baseDraft({
    expectedUpdatedAt: "2026-10-14T00:00:00.123456Z",
    slots: fixture.slots
      .filter((s) => s.weekday !== 6)
      .map((s, index) => ({ rowId: `s${index}`, ...s })),
    closures: [{ rowId: "c1", closedOn: "2026-11-01", label: "Toussaint" }],
  });
  backend.save("r1", buildSaveFulfillmentConfigurationPayload(draft));

  const row = (backend.readSchedules("r1")[0] as Record<string, unknown>);
  const slots = row.slots as Array<{ weekday: number }>;
  assert.equal(slots.some((s) => s.weekday === 6), false, "le samedi a bien disparu");
  assert.equal(slots.length, 8, "quatre jours × deux créneaux");
  assert.deepEqual(row.closures, [{ closedOn: "2026-11-01", label: "Toussaint" }]);
});
