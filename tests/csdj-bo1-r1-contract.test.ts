import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

import {
  type AvailabilityDraft,
  buildSaveFulfillmentConfigurationPayload,
  canFallBackToDraft,
  draftAsInactive,
  issuesBlockingDraft,
  saveErrorKey,
  serverRefusalCode,
  validateDraft,
} from "../lib/availability-payload.ts";
import {
  FakeFulfillmentWriteBackend,
  type FakeTenantState,
  auLaitCruPickupFixture,
} from "./helpers/fake-fulfillment-write-backend.ts";
import { DICTS } from "../lib/i18n.ts";

// ====================================================================
// CSDJ-BO-1 — REMÉDIATION CONTRACTUELLE R1 : les preuves demandées au
// §7 du mandat, qui ne tiennent dans aucune suite existante.
//
//   - v1 et v1.2 se distinguent EXACTEMENT par leur charge ;
//   - les bornes de liste du contrat sont refusées avant l'envoi ;
//   - le code métier d'un refus est le préfixe avant le premier « : » ;
//   - rien de technique n'atteint jamais une phrase affichée ;
//   - une nouvelle règle de livraison reçoit SES réglages sans toucher
//     Stuart, Chronofresh, le retrait Au Lait Cru, ni un autre marchand ;
//   - deux jetons, comparés par égalité exacte de chaîne.
// ====================================================================

const TOKEN_AT = "2026-10-14T00:00:00.123456Z";
const TOKEN_REV = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const STUART_RULE = "11111111-1111-1111-1111-111111111111";
const CHRONOFRESH_RULE = "33333333-3333-3333-3333-333333333333";
const NEW_LOCAL_RULE = "22222222-2222-2222-2222-222222222222";

function draft(over: Partial<AvailabilityDraft> = {}): AvailabilityDraft {
  return {
    modeCode: "pickup",
    fulfillmentRuleId: null,
    method: "v1",
    expectedUpdatedAt: TOKEN_AT,
    expectedRevision: TOKEN_REV,
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
    slots: [{ rowId: "s1", weekday: 2, slotKey: "midi", startsAt: "11:00", endsAt: "14:00" }],
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

/** Établissement avec retrait Au Lait Cru + deux livraisons tierces. */
function merchantWithThirdPartyDeliveries(): FakeTenantState {
  const base = auLaitCruPickupFixture();
  const pickup = base.schedules[0];
  const delivery = (ruleId: string, cutoff: string, revision: string) => ({
    ...pickup,
    modeCode: "delivery",
    fulfillmentRuleId: ruleId,
    cutoffTime: cutoff,
    cutoffOffsetDays: 0,
    slotSelectionMode: "fixed_slots",
    slots: [{ weekday: 1, slotKey: "livraison", startsAt: "08:00", endsAt: "12:00" }],
    closures: [],
    updatedAt: "2026-10-13T10:00:00.654321Z",
    revision,
  });
  return {
    ...base,
    rules: [STUART_RULE, CHRONOFRESH_RULE, NEW_LOCAL_RULE],
    schedules: [
      pickup,
      delivery(STUART_RULE, "10:00:00", "5700000000000000000000000000aaaa"),
      delivery(CHRONOFRESH_RULE, "09:30:00", "c4000000000000000000000000000bbb"),
    ],
  };
}

// --------------------------------------------------------------------
// v1 / v1.2 : deux formes de charge, aucune zone grise
// --------------------------------------------------------------------

test("[BO1-R1-1] charge v1 : jetons, listes explicites, décalage borné, et AUCUNE des trois sections v1.2", () => {
  const payload = buildSaveFulfillmentConfigurationPayload(draft());
  assert.deepEqual(Object.keys(payload).sort(), [
    "closures",
    "enabled",
    "expectedRevision",
    "expectedUpdatedAt",
    "fulfillmentRuleId",
    "method",
    "modeCode",
    "policy",
    "slots",
    "windows",
  ]);
  assert.equal(payload.expectedUpdatedAt, TOKEN_AT, "jeton 1 inchangé, microsecondes comprises");
  assert.equal(payload.expectedRevision, TOKEN_REV);
  const policy = payload.policy as Record<string, unknown>;
  assert.deepEqual(Object.keys(policy).sort(), [
    "bookingHorizonDays",
    "cutoffOffsetDays",
    "cutoffTime",
    "dateSelectionMode",
    "leadTimeMinutes",
    "minLeadDays",
    "slotSelectionMode",
    "timeGranularityMinutes",
    "timezone",
  ]);
  assert.equal(policy.cutoffOffsetDays, 1);
  // Listes vides : EXPLICITES, jamais omises.
  const empty = buildSaveFulfillmentConfigurationPayload(draft({ slots: [], closures: [], windows: [] }));
  assert.deepEqual([empty.windows, empty.slots, empty.closures], [[], [], []]);
});

test("[BO1-R1-2] charge v1.2 : les trois sections, et le décalage d'heure limite ABSENT quoi que dise le brouillon", () => {
  const payload = buildSaveFulfillmentConfigurationPayload(
    draft({ method: "v1.2", cutoffOffsetDays: "5", preparationWeekdays: [2, 3] })
  );
  for (const section of ["preparation", "holidays", "capacity"]) {
    assert.ok(section in payload, `v1.2 exige ${section}`);
  }
  assert.ok(
    !("cutoffOffsetDays" in (payload.policy as Record<string, unknown>)),
    "v1.2 : le décalage est absent (ou 0), jamais 5"
  );
  // Et à l'inverse la charge v1 n'a jamais ces sections, même si le
  // brouillon en porte les restes.
  const v1 = buildSaveFulfillmentConfigurationPayload(
    draft({ preparationWeekdays: [2], capacityEnabled: true, capacityMaxOrders: "4" })
  );
  for (const section of ["preparation", "holidays", "capacity"]) {
    assert.ok(!(section in v1), `v1 interdit ${section}`);
  }
});

test("[BO1-R1-3] le serveur de référence refuse les deux sens de la méthode et le décalage v1 hors 0..30", () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  const before = backend.snapshot("r1");
  const v1 = buildSaveFulfillmentConfigurationPayload(draft());
  const v12 = buildSaveFulfillmentConfigurationPayload(draft({ method: "v1.2", preparationWeekdays: [2] }));

  assert.throws(
    () => backend.save("r1", { ...v1, capacity: { enabled: false, maxOrders: null } }),
    /CSDJBO1_METHOD_MISMATCH/
  );
  const { holidays: _h, ...v12WithoutHolidays } = v12;
  assert.throws(() => backend.save("r1", v12WithoutHolidays), /CSDJBO1_METHOD_MISMATCH/);
  for (const offset of [-1, 31]) {
    assert.throws(
      () => backend.save("r1", { ...v1, policy: { ...(v1.policy as object), cutoffOffsetDays: offset } }),
      /CSDJ1_INVALID_POLICY/,
      `décalage ${offset}`
    );
  }
  assert.throws(
    () => backend.save("r1", { ...v12, policy: { ...(v12.policy as object), cutoffOffsetDays: 2 } }),
    /CSDJ12_CUTOFF_OFFSET_REMOVED/
  );
  assert.equal(backend.snapshot("r1"), before, "aucun de ces refus n'a rien écrit");
});

test("[BO1-R1-4] bornes du contrat : 100 fenêtres, 200 créneaux, 731 fermetures — refusées avant l'envoi", () => {
  const windows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      rowId: `w${i}`,
      weekday: i % 7,
      startsAt: `${String(Math.floor(i / 7) % 24).padStart(2, "0")}:00`,
      endsAt: `${String(Math.floor(i / 7) % 24).padStart(2, "0")}:30`,
    }));
  const slots = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      rowId: `s${i}`,
      weekday: i % 7,
      slotKey: `k${i}`,
      startsAt: "09:00",
      endsAt: "10:00",
    }));
  const closures = (n: number) =>
    Array.from({ length: n }, (_, i) => {
      const day = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      return { rowId: `c${i}`, closedOn: day, label: "" };
    });
  const codesOf = (d: AvailabilityDraft) => validateDraft(d).map((i) => i.code);

  assert.ok(!codesOf(draft({ windows: windows(100) })).includes("too_many_windows"));
  assert.ok(codesOf(draft({ windows: windows(101) })).includes("too_many_windows"));
  assert.ok(!codesOf(draft({ slots: slots(200) })).includes("too_many_slots"));
  assert.ok(codesOf(draft({ slots: slots(201) })).includes("too_many_slots"));
  assert.ok(!codesOf(draft({ closures: closures(731) })).includes("too_many_closures"));
  assert.ok(codesOf(draft({ closures: closures(732) })).includes("too_many_closures"));

  // Le serveur de référence tient les mêmes bornes, par leur nom.
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  const payload = buildSaveFulfillmentConfigurationPayload(draft({ slots: slots(201) }));
  assert.throws(() => backend.save("r1", payload), /CSDJ1_TOO_MANY_SLOTS/);
});

// --------------------------------------------------------------------
// Refus : code métier = préfixe, aucune fuite technique
// --------------------------------------------------------------------

test("[BO1-R1-5] le code métier est le préfixe avant le premier « : », rien d'autre", () => {
  const cases: Array<[string, string | null]> = [
    ["CSDJBO1_STALE_CONFIGURATION: la portée a changé", "CSDJBO1_STALE_CONFIGURATION"],
    ["CSDJBO1_INCOMPLETE_CONFIGURATION", "CSDJBO1_INCOMPLETE_CONFIGURATION"],
    ["SCANYM_CSDJBO1_POSTCHECK: invariant violé: détail interne", "SCANYM_CSDJBO1_POSTCHECK"],
    ["CSDJ1_FORBIDDEN:rôle requis", "CSDJ1_FORBIDDEN"],
    ['relation "public.restaurant_fulfillment_schedule" does not exist', null],
    ["new row violates check constraint: SQLSTATE 23514", null],
    ["", null],
    ["csdj1_forbidden: minuscules", null],
  ];
  for (const [message, expected] of cases) {
    assert.equal(serverRefusalCode(new Error(message)), expected, message);
  }
  assert.equal(serverRefusalCode(undefined), null);
  assert.equal(serverRefusalCode({}), null);
});

test("[BO1-R1-6] SCANYM_CSDJBO1_POSTCHECK : message générique, sans le moindre détail technique, dans les quatre langues", () => {
  const key = saveErrorKey(
    new Error("SCANYM_CSDJBO1_POSTCHECK: invariant windows_without_slots SQLSTATE P0001 DETAIL: x HINT: y")
  );
  assert.equal(key, "avSavePostcheck");
  for (const lang of ["fr", "en", "ar", "nl"] as const) {
    const text = (DICTS[lang] as Record<string, string>)[key];
    assert.ok(text && text.trim().length > 10, `${lang} : phrase manquante`);
    assert.ok(!/SCANYM|CSDJ|POSTCHECK|SQLSTATE|DETAIL|HINT|invariant/i.test(text), `${lang} : « ${text} »`);
  }
});

test("[BO1-R1-7] aucune phrase de refus, dans aucune langue, ne contient SQLSTATE, DETAIL, HINT, un code ou un nom de table", () => {
  const messages = [
    "CSDJBO1_STALE_CONFIGURATION: x",
    "CSDJBO1_INCOMPLETE_CONFIGURATION: offer_missing",
    "CSDJBO1_METHOD_MISMATCH: x",
    "SCANYM_CSDJBO1_POSTCHECK: x",
    "CSDJ1_FORBIDDEN: x",
    "CSDJ1_UNKNOWN_MODE: x",
    "CSDJ1_TOO_MANY_WINDOWS: x",
    "CSDJ1_TOO_MANY_SLOTS: x",
    "CSDJ1_TOO_MANY_CLOSURES: x",
    "CSDJ12_INVALID_CAPACITY: x",
    'duplicate key value violates unique constraint "idx" SQLSTATE 23505 DETAIL: Key (id)=(1) HINT: z',
  ];
  for (const message of messages) {
    const key = saveErrorKey(new Error(message));
    for (const lang of ["fr", "en", "ar", "nl"] as const) {
      const text = (DICTS[lang] as Record<string, string>)[key];
      assert.ok(text, `${lang}/${key}`);
      assert.ok(
        !/SQLSTATE|DETAIL|HINT|CSDJ|SCANYM|public\.|restaurant_fulfillment|[0-9a-f]{8}-[0-9a-f]{4}/.test(text),
        `${lang}/${key} : « ${text} »`
      );
    }
  }
});

// --------------------------------------------------------------------
// Brouillon confirmé : ce qui reste refusé même sans activation
// --------------------------------------------------------------------

test("[BO1-R1-8] repli brouillon : proposable pour une offre manquante, JAMAIS pour une capacité sans maximum, sans date, ou une grille incohérente", () => {
  assert.equal(canFallBackToDraft(draft({ slots: [] })), true, "offre manquante : proposable");
  assert.equal(draftAsInactive(draft()).enabled, false);
  // Les jetons survivent au passage en brouillon : c'est la MÊME portée.
  assert.equal(draftAsInactive(draft()).expectedUpdatedAt, TOKEN_AT);
  assert.equal(draftAsInactive(draft()).expectedRevision, TOKEN_REV);

  const stillRefused: Array<[string, AvailabilityDraft]> = [
    ["capacité sans maximum", draft({ method: "v1.2", preparationWeekdays: [2], capacityEnabled: true, capacityMaxOrders: "" })],
    [
      "capacité sans date",
      draft({
        method: "v1.2",
        preparationWeekdays: [2],
        capacityEnabled: true,
        capacityMaxOrders: "5",
        dateSelectionMode: "informational_only",
        slotSelectionMode: "none",
        slots: [],
      }),
    ],
    [
      "grille horaire incohérente",
      draft({
        slotSelectionMode: "time_within_window",
        timeGranularityMinutes: "1000",
        slots: [],
        windows: [{ rowId: "w1", weekday: 2, startsAt: "11:00", endsAt: "14:00" }],
      }),
    ],
  ];
  for (const [label, d] of stillRefused) {
    assert.ok(issuesBlockingDraft(d).length > 0, `${label} : doit rester bloquant en brouillon`);
    assert.equal(canFallBackToDraft(d), false, `${label} : aucun repli proposé`);
  }
});

test("[BO1-R1-9] le serveur de référence enregistre le brouillon incomplet, et refuse encore la capacité sans maximum", () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  const incomplete = draft({ slots: [] });

  assert.throws(
    () => backend.save("r1", buildSaveFulfillmentConfigurationPayload(incomplete)),
    /CSDJBO1_INCOMPLETE_CONFIGURATION/
  );
  const accepted = backend.save(
    "r1",
    buildSaveFulfillmentConfigurationPayload(draftAsInactive(incomplete))
  );
  assert.equal(accepted.enabled, false, "enregistré comme brouillon");

  const capacity = draft({
    method: "v1.2",
    preparationWeekdays: [2],
    capacityEnabled: true,
    capacityMaxOrders: "",
    enabled: false,
    expectedUpdatedAt: accepted.updatedAt as string,
    expectedRevision: accepted.revision as string,
  });
  assert.throws(
    () => backend.save("r1", buildSaveFulfillmentConfigurationPayload(capacity)),
    /CSDJ12_INVALID_CAPACITY/,
    "même en brouillon"
  );
});

// --------------------------------------------------------------------
// Jetons : égalité exacte de chaîne, deux jetons
// --------------------------------------------------------------------

test("[BO1-R1-10] les DEUX jetons sont comparés : horodatage tronqué, ou empreinte différente, ou jeton manquant = STALE", () => {
  const variants: Array<[string, Partial<AvailabilityDraft>]> = [
    ["horodatage tronqué à la milliseconde", { expectedUpdatedAt: "2026-10-14T00:00:00.123Z" }],
    ["horodatage passé par Date", { expectedUpdatedAt: new Date(TOKEN_AT).toISOString() }],
    ["empreinte différente", { expectedRevision: "ffffffffffffffffffffffffffffffff" }],
    ["empreinte manquante", { expectedRevision: null }],
    ["horodatage manquant", { expectedUpdatedAt: null }],
  ];
  for (const [label, over] of variants) {
    const backend = new FakeFulfillmentWriteBackend();
    backend.setTenant("r1", auLaitCruPickupFixture());
    const before = backend.snapshot("r1");
    assert.throws(
      () => backend.save("r1", buildSaveFulfillmentConfigurationPayload(draft(over))),
      /CSDJBO1_STALE_CONFIGURATION/,
      label
    );
    assert.equal(backend.snapshot("r1"), before, `${label} : rien écrit`);
  }
  // Et la version exacte passe.
  const ok = new FakeFulfillmentWriteBackend();
  ok.setTenant("r1", auLaitCruPickupFixture());
  const saved = ok.save("r1", buildSaveFulfillmentConfigurationPayload(draft()));
  assert.notEqual(saved.updatedAt, TOKEN_AT);
  assert.notEqual(saved.revision, TOKEN_REV);
  assert.match(String(saved.updatedAt), /\.\d{6}Z$/, "six chiffres de fraction conservés");
  assert.match(String(saved.revision), /^[0-9a-f]{32}$/);
});

// --------------------------------------------------------------------
// Isolation multi-marchands et nouvelle règle de livraison
// --------------------------------------------------------------------

test("[BO1-R1-11] la lecture autoritaire est strictement par (marchand, mode, règle) : un autre marchand, une autre règle ou un autre mode rendent null", () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", merchantWithThirdPartyDeliveries());
  backend.setTenant("r2", { ...auLaitCruPickupFixture(), schedules: [], rules: [] });

  const pickup = backend.readConfiguration("r1", "pickup", null)!;
  assert.equal(pickup.revision, TOKEN_REV);
  assert.equal(pickup.updatedAt, TOKEN_AT);
  const stuart = backend.readConfiguration("r1", "delivery", STUART_RULE)!;
  const chrono = backend.readConfiguration("r1", "delivery", CHRONOFRESH_RULE)!;
  assert.notEqual(stuart.revision, chrono.revision);
  assert.equal((stuart.policy as Record<string, unknown>).cutoffTime, "10:00:00");
  assert.equal((chrono.policy as Record<string, unknown>).cutoffTime, "09:30:00");

  assert.equal(backend.readConfiguration("r2", "pickup", null), null, "r2 : aucune configuration héritée de r1");
  assert.equal(backend.readConfiguration("r1", "delivery", NEW_LOCAL_RULE), null, "règle encore vierge");
  assert.equal(backend.readConfiguration("r1", "delivery", null), null, "le mode seul n'est pas une règle");
  assert.equal(backend.readConfiguration("r1", "click_collect", null), null);
});

test("[BO1-R1-12] une NOUVELLE livraison locale reçoit ses propres règles sans toucher Stuart, Chronofresh, le retrait, ni un autre marchand", () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", merchantWithThirdPartyDeliveries());
  backend.setTenant("r2", merchantWithThirdPartyDeliveries());
  const bytes = (restaurant: string, mode: string, rule: string | null) =>
    JSON.stringify(backend.readConfiguration(restaurant, mode, rule));
  const watched: Array<[string, string, string | null]> = [
    ["r1", "pickup", null],
    ["r1", "delivery", STUART_RULE],
    ["r1", "delivery", CHRONOFRESH_RULE],
    ["r2", "pickup", null],
    ["r2", "delivery", STUART_RULE],
    ["r2", "delivery", NEW_LOCAL_RULE],
  ];
  const before = watched.map(([r, m, f]) => bytes(r, m, f));

  // Création : portée absente, donc AUCUN jeton.
  const created = backend.save(
    "r1",
    buildSaveFulfillmentConfigurationPayload(
      draft({
        modeCode: "delivery",
        fulfillmentRuleId: NEW_LOCAL_RULE,
        expectedUpdatedAt: null,
        expectedRevision: null,
        cutoffTime: "07:00",
        cutoffOffsetDays: "0",
        slots: [{ rowId: "n1", weekday: 4, slotKey: "matin_local", startsAt: "09:00", endsAt: "11:00" }],
      })
    )
  );
  assert.equal(created.fulfillmentRuleId, NEW_LOCAL_RULE);
  assert.match(String(created.updatedAt), /\.\d{6}Z$/);
  assert.match(String(created.revision), /^[0-9a-f]{32}$/);
  assert.equal((created.policy as Record<string, unknown>).cutoffTime, "07:00:00");

  const after = watched.map(([r, m, f]) => bytes(r, m, f));
  // Tout est identique SAUF la portée r2/NEW_LOCAL_RULE, qui est celle
  // de l'AUTRE marchand : elle doit aussi rester null.
  assert.deepEqual(after, before, "aucune autre portée n'a bougé d'un octet");
  assert.equal(backend.readConfiguration("r2", "delivery", NEW_LOCAL_RULE), null);

  // La nouvelle portée se relit avec les jetons de sa création, et une
  // seconde sauvegarde qui les porte est acceptée.
  const reread = backend.readConfiguration("r1", "delivery", NEW_LOCAL_RULE)!;
  assert.equal(reread.updatedAt, created.updatedAt);
  assert.equal(reread.revision, created.revision);
  const second = backend.save(
    "r1",
    buildSaveFulfillmentConfigurationPayload(
      draft({
        modeCode: "delivery",
        fulfillmentRuleId: NEW_LOCAL_RULE,
        expectedUpdatedAt: reread.updatedAt as string,
        expectedRevision: reread.revision as string,
        cutoffTime: "07:30",
        cutoffOffsetDays: "0",
        slots: [{ rowId: "n1", weekday: 4, slotKey: "matin_local", startsAt: "09:00", endsAt: "11:00" }],
      })
    )
  );
  assert.notEqual(second.revision, created.revision);
  assert.deepEqual(
    watched.slice(0, 3).map(([r, m, f]) => bytes(r, m, f)),
    before.slice(0, 3),
    "Stuart, Chronofresh et le retrait sont toujours intacts"
  );
});

test("[BO1-R1-13] une règle d'un autre marchand, ou jamais déclarée, est refusée : la portée ne s'invente pas", () => {
  const backend = new FakeFulfillmentWriteBackend();
  const r1 = merchantWithThirdPartyDeliveries();
  backend.setTenant("r1", r1);
  backend.setTenant("r2", { ...merchantWithThirdPartyDeliveries(), rules: [] });
  const before = [backend.snapshot("r1"), backend.snapshot("r2")];
  const payload = buildSaveFulfillmentConfigurationPayload(
    draft({
      modeCode: "delivery",
      fulfillmentRuleId: NEW_LOCAL_RULE,
      expectedUpdatedAt: null,
      expectedRevision: null,
    })
  );
  // r2 ne déclare pas la règle : refus, rien n'est créé chez lui.
  assert.throws(() => backend.save("r2", payload), /CSDJ1_FOREIGN_RULE/);
  assert.deepEqual([backend.snapshot("r1"), backend.snapshot("r2")], before);
});

test("[BO1-R1-14] aucune règle d'Au Lait Cru ne devient un défaut global : un marchand vierge ne lit rien", () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("alc", auLaitCruPickupFixture());
  backend.setTenant("neuf", { ...auLaitCruPickupFixture(), schedules: [] });
  assert.ok(backend.readConfiguration("alc", "pickup", null));
  assert.equal(backend.readConfiguration("neuf", "pickup", null), null);
  // Et la fixture elle-même ne fait des dimanche/lundi fermés qu'un FAIT
  // de ce marchand : le brouillon par défaut d'un autre n'en hérite pas.
  const alc = backend.readConfiguration("alc", "pickup", null)!;
  const days = new Set((alc.slots as Array<{ weekday: number }>).map((s) => s.weekday));
  assert.deepEqual([...days].sort(), [2, 3, 4, 5, 6]);
});
