import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// lib/supabase.ts jette au chargement sans ces variables : même
// amorçage que les autres suites qui importent un service.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

import {
  CSDJ_BO1_WRITE_CONTRACT,
  DATE_MODE_CUSTOMER,
  DATE_MODE_DERIVED,
  DATE_MODE_INFORMATIONAL,
  SLOT_MODE_FIXED_SLOTS,
  SLOT_MODE_FREE_TIME,
  SLOT_MODE_NONE,
  WEEKDAY_DISPLAY_ORDER,
  canReadFulfillmentSchedules,
  canWriteFulfillmentSchedules,
  capacityBucketKindOf,
  publishBlockerKey,
  publishBlockersOf,
  readErrorKey,
  scheduleMethodOf,
  scheduleStatusKey,
  scopeKeyOf,
  scopeStateOf,
  unfulfillableReasonKey,
  weekdayLabelKey,
  writeControlsState,
} from "../lib/availability-editor.ts";
import type {
  MerchantFulfillmentSchedule,
  MerchantFulfillmentV12Extension,
} from "../lib/dashboard-types.ts";
import { DICTS } from "../lib/i18n.ts";

// ====================================================================
// CSDJ-BO-1 — CONTRAT DU LOT, VÉRIFIÉ PAR LE CODE.
//
// Ce fichier tient trois promesses faites au CTO, et il échoue si
// l'une d'elles est rompue par une modification future :
//
//  1. UNE SEULE ÉCRITURE, TRANSACTIONNELLE, ET VERROUILLÉE. Le lot
//     contient exactement un site d'appel d'écriture --
//     `save_fulfillment_configuration`, la configuration ENTIÈRE en un
//     appel -- jamais une séquence de mutations, et ce chemin refuse
//     sans réseau tant que `CSDJ_BO1_WRITE_CONTRACT.available` est
//     faux. C'est ce qui rend une configuration incomplète et un
//     contournement du parcours de commande impossibles depuis cette
//     page. (Mandat d'origine : aucune écriture du tout ; élargi par
//     l'issue #149, voir la note devant [BO1-NOWRITE-2].)
//  2. AUCUNE AUTORITÉ CLIENTE. Aucune éligibilité n'est calculée côté
//     client (CSDJ-V1-REFERENCE-NOT-AUTHORITY-01).
//  3. AUCUNE PROMESSE NON TENUE. Les helpers purs disent exactement ce
//     que le serveur fait, y compris là où l'interface serait tentée
//     d'être plus permissive que lui (écriture opérateur, seau de
//     capacité en heure libre).
// ====================================================================

const REPO_ROOT = process.cwd();
const PAGE = path.join(REPO_ROOT, "app", "dashboard", "availability", "page.tsx");
const SERVICE = path.join(REPO_ROOT, "lib", "services", "availability.ts");
const EDITOR = path.join(REPO_ROOT, "lib", "availability-editor.ts");
const NAV = path.join(REPO_ROOT, "components", "dashboard", "DashboardNav.tsx");

const pageSrc = readFileSync(PAGE, "utf8");
const serviceSrc = readFileSync(SERVICE, "utf8");
const editorSrc = readFileSync(EDITOR, "utf8");
const navSrc = readFileSync(NAV, "utf8");

// --------------------------------------------------------------------
// 1. Aucune écriture, nulle part
// --------------------------------------------------------------------

test("[BO1-NOWRITE-1] la page n'appelle jamais Supabase directement : tout passe par le service", () => {
  assert.ok(
    !pageSrc.includes("supabase.rpc"),
    "la page ne doit jamais appeler supabase.rpc (patron déjà imposé à delivery-pricing)"
  );
  assert.ok(
    !pageSrc.includes('from "@/lib/supabase"'),
    "la page ne doit pas importer le client Supabase"
  );
});

// --------------------------------------------------------------------
// MANDAT SUCCÉDÉ, DOCUMENTÉ ICI MÊME (issue #149).
//
// Les trois tests qui suivent affirmaient « AUCUNE écriture, nulle
// part » : c'était exact pour la phase précédente, où la page n'avait
// littéralement aucun chemin d'écriture. L'issue #149 demande l'inverse
// et le demande explicitement -- « sauvegarde atomique via
// `save_fulfillment_configuration` SEULEMENT, no multi-RPC save » --
// tout en INTERDISANT de basculer le drapeau avant la RPC de Boulez.
//
// La promesse faite au CTO ne disparaît donc pas, elle se déplace, et
// elle devient plus précise : ce qui est interdit n'est plus « écrire »
// mais « écrire par autre chose qu'UN SEUL appel transactionnel », et
// « écrire alors que le contrat n'est pas livré ». C'est ce que les
// trois tests vérifient maintenant, dans l'ordre : l'unique RPC
// d'écriture, l'unique export d'écriture, et l'inventaire exact des RPC
// appelées. Le verrou lui-même (aucun réseau tant que
// `available` est faux) est tenu par [BO1-NOWRITE-5] ici et par
// [BO1-ED-1]/[BO1-ED-2] dans tests/csdj-bo1-editor-payload.test.ts.
// --------------------------------------------------------------------

test("[BO1-NOWRITE-2] aucune SÉQUENCE d'écriture n'existe : une seule RPC transactionnelle, et rien d'autre", () => {
  for (const [label, src] of [
    ["page", pageSrc],
    ["service", serviceSrc],
    ["helpers", editorSrc],
  ] as const) {
    // Ce qui est interdit est l'APPEL, pas le nom : la demande de
    // contrat et les commentaires d'architecture doivent pouvoir citer
    // les fonctions refusées.
    assert.ok(
      !/rpc\(\s*["'`]mutate_merchant_fulfillment_schedule/.test(src),
      `${label} : la séquence « suspendre → écrire → réactiver » refusée par le CTO ne doit exister nulle part`
    );
    assert.ok(
      !/rpc\(\s*["'`]reserve_fulfillment_capacity/.test(src),
      `${label} : la réservation de capacité est l'affaire du parcours de commande, jamais du back-office`
    );
  }
  // La page n'écrit toujours PAS elle-même : elle appelle le service.
  assert.ok(
    !/rpc\(\s*["'`]save_fulfillment_configuration/.test(pageSrc),
    "la page ne doit pas appeler la RPC d'écriture directement"
  );
  // Et le service ne l'appelle qu'UNE fois, en un seul endroit.
  assert.equal(
    [...serviceSrc.matchAll(/rpc\(\s*["'`]save_fulfillment_configuration/g)].length,
    1,
    "un seul site d'appel d'écriture dans tout le lot : c'est ce qui rend l'atomicité vérifiable"
  );
});

test("[BO1-NOWRITE-3] le service n'exporte QU'UNE écriture, et c'est le contrat transactionnel demandé", async () => {
  const mod = await import("../lib/services/availability.ts");
  const exported = Object.keys(mod).sort();
  const writeLike = exported.filter((name) =>
    /^(save|mutate|update|delete|replace|activate|enable|disable|promote)/i.test(name)
  );
  assert.deepEqual(
    writeLike,
    ["saveFulfillmentConfiguration"],
    `une seule écriture est permise, et c'est la charge entière ; trouvés : ${writeLike.join(", ")}`
  );
  for (const name of ["getMerchantFulfillmentSchedules", "getMerchantFulfillmentSchedulesV12", "getCheckoutFulfillmentSchedulePreview"]) {
    assert.ok(exported.includes(name), `la lecture ${name} doit être exportée`);
  }
});

test("[BO1-NOWRITE-4] le service enveloppe EXACTEMENT quatre lectures et une écriture, et aucune autre RPC", () => {
  // REMÉDIATION R1 : `get_fulfillment_configuration` rejoint l'inventaire
  // (contrat Boulez §2, lecture AUTORITAIRE porteuse des deux jetons de
  // concurrence). L'invariant de ce test ne change pas de nature -- la
  // liste reste EXHAUSTIVE et close -- et la part qui compte le plus est
  // désormais affirmée séparément : il n'existe qu'UNE écriture.
  const calls = [...serviceSrc.matchAll(/supabase\.rpc\(\s*["'`]([a-z0-9_]+)["'`]/g)].map(
    (m) => m[1]
  );
  assert.deepEqual(
    calls.sort(),
    [
      "get_checkout_fulfillment_schedule",
      "get_fulfillment_configuration",
      "get_merchant_fulfillment_schedules",
      "get_merchant_fulfillment_schedules_v12",
      "save_fulfillment_configuration",
    ],
    "la liste des RPC appelées par le service doit être exactement celle de la matrice de dépendances"
  );
  assert.deepEqual(
    calls.filter((name) => !name.startsWith("get_")),
    ["save_fulfillment_configuration"],
    "une seule RPC qui n'est pas une lecture"
  );
});

test("[BO1-NOWRITE-5] le contrat d'écriture est déclaré disponible (PR #154, SQL installé), et la page le relaie", () => {
  assert.equal(CSDJ_BO1_WRITE_CONTRACT.available, true);
  assert.equal(CSDJ_BO1_WRITE_CONTRACT.reason, "CSDJ_BO1_WRITE_CONTRACT_READY");
  assert.equal(CSDJ_BO1_WRITE_CONTRACT.requestedContract, "save_fulfillment_configuration");
  assert.ok(
    pageSrc.includes("CSDJ_BO1_WRITE_CONTRACT"),
    "la page doit lire l'état du contrat, jamais le réinventer"
  );
  assert.ok(
    pageSrc.includes("csdj-bo1-write-contract-request.md"),
    "la page doit renvoyer au document qui justifie l'inactivité"
  );
});

test("[BO1-NOWRITE-6] la demande de contrat et la matrice de dépendances existent et nomment ce qui est demandé", () => {
  const request = path.join(REPO_ROOT, "docs", "scheduling", "csdj-bo1-write-contract-request.md");
  const matrix = path.join(REPO_ROOT, "docs", "scheduling", "csdj-bo1-api-dependency-matrix.md");
  assert.ok(existsSync(request), "la demande de contrat d'écriture doit être livrée avec le lot");
  assert.ok(existsSync(matrix), "la matrice exacte des dépendances d'API doit être livrée avec le lot");
  const requestSrc = readFileSync(request, "utf8");
  for (const needle of [
    "save_fulfillment_configuration",
    "CSDJBO1_INCOMPLETE_CONFIGURATION",
    "CSDJBO1_STALE_CONFIGURATION",
    "expectedUpdatedAt",
  ]) {
    assert.ok(requestSrc.includes(needle), `la demande doit nommer ${needle}`);
  }
  const matrixSrc = readFileSync(matrix, "utf8");
  for (const needle of [
    "get_merchant_fulfillment_schedules(p_restaurant_id uuid)",
    "get_merchant_fulfillment_schedules_v12(p_restaurant_id uuid)",
    "get_checkout_fulfillment_schedule(p_restaurant_id uuid, p_mode_code text",
    "fulfillment_capacity_used",
  ]) {
    assert.ok(matrixSrc.includes(needle), `la matrice doit porter la signature exacte de ${needle}`);
  }
});

// --------------------------------------------------------------------
// 2. Aucune autorité cliente
// --------------------------------------------------------------------

test("[BO1-AUTHORITY-1] ni la page, ni le service, ni les helpers n'importent l'oracle d'éligibilité", () => {
  for (const [label, src] of [
    ["page", pageSrc],
    ["service", serviceSrc],
    ["helpers", editorSrc],
  ] as const) {
    assert.ok(
      !src.includes("lib/scheduling/eligibility"),
      `${label} : lib/scheduling/eligibility est un oracle de TEST, jamais une autorité (CSDJ-V1-REFERENCE-NOT-AUTHORITY-01)`
    );
  }
});

test("[BO1-AUTHORITY-2] l'aperçu passe par la lecture publique, et n'envoie aucune heure au serveur", () => {
  assert.ok(
    pageSrc.includes("getCheckoutFulfillmentSchedulePreview"),
    "l'aperçu doit appeler la lecture publique sûre"
  );
  assert.ok(
    !/p_now|p_at|clientNow|new Date\(\)\.toISOString\(\)/.test(pageSrc),
    "la page ne doit jamais proposer un « maintenant » au serveur : la lecture publique n'accepte aucune heure"
  );
});

// --------------------------------------------------------------------
// 3. Navigation : non-régression L1B-02 au niveau de la source
// --------------------------------------------------------------------

test("[BO1-NAV-1] le nouvel onglet est exclu du repli générique de « Commandes » (pitfall L1B-02)", () => {
  assert.ok(
    navSrc.includes('pathname?.startsWith("/dashboard/availability")'),
    "la nav doit dériver un état dédié pour la nouvelle route"
  );
  const fallback = navSrc.slice(
    navSrc.indexOf('href={href("/dashboard")}'),
    navSrc.indexOf('href={href("/dashboard/catalogue")}')
  );
  assert.ok(
    fallback.includes("!onAvailability"),
    "sans !onAvailability, « Commandes » se marquerait actif sur la nouvelle route -- c'est exactement L1B-02"
  );
});

// --------------------------------------------------------------------
// 4. Parité des traductions ajoutées par ce lot
// --------------------------------------------------------------------

test("[BO1-I18N-1] chaque clé ajoutée par ce lot existe en français ET en anglais", () => {
  const fr = DICTS.fr as Record<string, string>;
  const en = DICTS.en as Record<string, string>;
  const lotKeys = Object.keys(fr).filter(
    (k) => k.startsWith("av") || k === "dsAvailability" || k.endsWith("Short")
  );
  assert.ok(lotKeys.length > 100, `le lot doit déclarer ses libellés (trouvés : ${lotKeys.length})`);
  const missing = lotKeys.filter((k) => !en[k]);
  assert.deepEqual(missing, [], `clés absentes de l'anglais : ${missing.join(", ")}`);
  const empty = lotKeys.filter((k) => fr[k].trim() === "" || en[k].trim() === "");
  assert.deepEqual(empty, [], `clés vides : ${empty.join(", ")}`);
});

test("[BO1-I18N-2] toute clé utilisée par la page ou les helpers est déclarée en français", () => {
  const fr = DICTS.fr as Record<string, string>;
  const used = new Set<string>();
  for (const src of [pageSrc, editorSrc]) {
    for (const m of src.matchAll(/["'`](av[A-Z][A-Za-z0-9]*)["'`]/g)) used.add(m[1]);
  }
  assert.ok(used.size > 50, `la page doit passer par les traductions (clés vues : ${used.size})`);
  const undeclared = [...used].filter((k) => !fr[k]);
  assert.deepEqual(undeclared, [], `clés utilisées mais non déclarées : ${undeclared.join(", ")}`);
});

// --------------------------------------------------------------------
// 5. Helpers purs : ils disent ce que le serveur fait
// --------------------------------------------------------------------

function schedule(
  over: Partial<MerchantFulfillmentSchedule> = {}
): MerchantFulfillmentSchedule {
  return {
    modeCode: "pickup",
    fulfillmentRuleId: null,
    timezone: "Europe/Paris",
    enabled: true,
    dateSelectionMode: DATE_MODE_CUSTOMER,
    slotSelectionMode: SLOT_MODE_FIXED_SLOTS,
    timeGranularityMinutes: null,
    leadTimeMinutes: 0,
    minLeadDays: 2,
    cutoffTime: "12:00:00",
    cutoffOffsetDays: 0,
    bookingHorizonDays: 14,
    windows: [],
    slots: [{ weekday: 2, slotKey: "matin", startsAt: "09:00", endsAt: "12:00" }],
    closures: [],
    ...over,
  };
}

function extension(
  over: Partial<MerchantFulfillmentV12Extension> = {}
): MerchantFulfillmentV12Extension {
  return {
    modeCode: "pickup",
    fulfillmentRuleId: null,
    scheduleMethodVersion: "v1.2",
    holidayCalendarId: null,
    preparationOnHolidays: "open",
    availabilityOnHolidays: "open",
    capacityEnabled: false,
    capacityMaxOrders: null,
    preparationWeekdays: [1, 2, 3, 4, 5],
    preparationClosures: [],
    ...over,
  };
}

test("[BO1-PURE-1] la clé de portée distingue une portée de mode d'une portée de zone", () => {
  assert.equal(scopeKeyOf("pickup", null), "pickup::mode");
  assert.notEqual(scopeKeyOf("delivery", null), scopeKeyOf("delivery", "11111111-1111-1111-1111-111111111111"));
});

test("[BO1-PURE-2] trois états de portée, et ils ne se confondent pas", () => {
  assert.equal(scopeStateOf(undefined), "unconfigured");
  assert.equal(scopeStateOf(schedule({ enabled: false })), "disabled");
  assert.equal(scopeStateOf(schedule({ enabled: true })), "active");
});

test("[BO1-PURE-3] le seau de capacité se DÉDUIT de la politique : journée entière hors créneaux nommés", () => {
  assert.equal(capacityBucketKindOf(SLOT_MODE_FIXED_SLOTS), "named_slot");
  // C'est le point corrigé en R2 : en heure libre, une limite de 12
  // vaut douze commandes par JOUR, pas douze par demi-heure.
  assert.equal(capacityBucketKindOf(SLOT_MODE_FREE_TIME), "whole_day");
  assert.equal(capacityBucketKindOf(SLOT_MODE_NONE), "whole_day");
  assert.equal(capacityBucketKindOf("mode_futur_inconnu"), "whole_day");
});

test("[BO1-PURE-4] la méthode de planification vient de l'extension lue, jamais d'une supposition", () => {
  assert.equal(scheduleMethodOf(undefined), "v1");
  assert.equal(scheduleMethodOf(extension({ scheduleMethodVersion: "v1" })), "v1");
  assert.equal(scheduleMethodOf(extension()), "v1.2");
});

test("[BO1-PURE-5] ÉCRITURE : propriétaire ou responsable UNIQUEMENT -- aucune dérogation opérateur", () => {
  // Différence volontaire avec « Tarifs de livraison » : l'autorité
  // d'écriture SQL de planification est has_role_in(['owner','manager'])
  // et ne consulte PAS is_scanym_operator(). Promettre l'écriture à un
  // opérateur serait promettre un refus serveur.
  assert.equal(canWriteFulfillmentSchedules({ role: "owner", isOperator: false }), true);
  assert.equal(canWriteFulfillmentSchedules({ role: "manager", isOperator: false }), true);
  assert.equal(canWriteFulfillmentSchedules({ role: "staff", isOperator: false }), false);
  assert.equal(canWriteFulfillmentSchedules({ role: undefined, isOperator: true }), false);
  assert.equal(canWriteFulfillmentSchedules({ role: "staff", isOperator: true }), false);
});

test("[BO1-PURE-6] LECTURE : ouverte à tout membre et à l'opérateur", () => {
  assert.equal(canReadFulfillmentSchedules({ role: "staff", isOperator: false }), true);
  assert.equal(canReadFulfillmentSchedules({ role: undefined, isOperator: true }), true);
  assert.equal(canReadFulfillmentSchedules({ role: undefined, isOperator: false }), false);
});

test("[BO1-PURE-7] les contrôles d'écriture suivent le RÔLE ; le contrat étant disponible (#154), un propriétaire peut écrire", () => {
  const asStaff = writeControlsState({ role: "staff", isOperator: false });
  assert.deepEqual(asStaff, { enabled: false, reason: "role" });
  const asOwner = writeControlsState({ role: "owner", isOperator: false });
  assert.deepEqual(
    asOwner,
    { enabled: true },
    "un propriétaire a le rôle et le contrat est disponible : rien ne le bloque (issue #156, constat 1)"
  );
});

test("[BO1-PURE-8] ce qui empêcherait de publier est nommé, cas par cas", () => {
  assert.deepEqual(publishBlockersOf(undefined, undefined), ["offer_missing"]);
  assert.deepEqual(publishBlockersOf(schedule(), extension({ scheduleMethodVersion: "v1" })), []);

  // Créneaux nommés sans aucun créneau : le client ne verrait rien.
  assert.deepEqual(
    publishBlockersOf(schedule({ slots: [] }), extension({ scheduleMethodVersion: "v1" })),
    ["offer_missing"]
  );
  // Heure libre : la table qui fait autorité est celle des PLAGES.
  assert.deepEqual(
    publishBlockersOf(
      schedule({ slotSelectionMode: SLOT_MODE_FREE_TIME, slots: [], windows: [], timeGranularityMinutes: 30 }),
      extension({ scheduleMethodVersion: "v1" })
    ),
    ["offer_missing"]
  );
  // Heure libre sans pas de grille.
  assert.deepEqual(
    publishBlockersOf(
      schedule({
        slotSelectionMode: SLOT_MODE_FREE_TIME,
        slots: [],
        windows: [{ weekday: 2, startsAt: "11:00", endsAt: "14:00" }],
        timeGranularityMinutes: null,
      }),
      extension({ scheduleMethodVersion: "v1" })
    ),
    ["granularity_missing"]
  );
  // Politique purement informative : aucune offre n'est exigée.
  assert.deepEqual(
    publishBlockersOf(
      schedule({ dateSelectionMode: DATE_MODE_INFORMATIONAL, slots: [], windows: [] }),
      extension({ scheduleMethodVersion: "v1" })
    ),
    []
  );
  // Méthode v1.2 sans jour de préparation : un calendrier vide n'est
  // pas « tous les jours ».
  assert.deepEqual(
    publishBlockersOf(schedule(), extension({ preparationWeekdays: [] })),
    ["preparation_missing"]
  );
  // Capacité active sans maximum, et capacité active en informatif.
  assert.deepEqual(
    publishBlockersOf(schedule(), extension({ capacityEnabled: true, capacityMaxOrders: null })),
    ["capacity_incomplete"]
  );
  assert.deepEqual(
    publishBlockersOf(
      schedule({ dateSelectionMode: DATE_MODE_INFORMATIONAL, slots: [], windows: [] }),
      extension({ capacityEnabled: true, capacityMaxOrders: 10 })
    ),
    ["capacity_needs_date"]
  );
  // Chaque code a sa phrase.
  for (const blocker of [
    "offer_missing",
    "granularity_missing",
    "preparation_missing",
    "capacity_incomplete",
    "capacity_needs_date",
  ] as const) {
    assert.ok(publishBlockerKey(blocker).startsWith("avBlocker"));
  }
});

test("[BO1-PURE-9] le dérivé « première date imposée » n'exige pas moins qu'une date choisie", () => {
  assert.deepEqual(
    publishBlockersOf(
      schedule({ dateSelectionMode: DATE_MODE_DERIVED, slots: [], windows: [] }),
      extension({ scheduleMethodVersion: "v1" })
    ),
    ["offer_missing"],
    "une portée qui impose la première date doit quand même avoir une offre"
  );
});

test("[BO1-PURE-10] catalogues FERMÉS : neuf motifs, cinq statuts, et un repli nommé", () => {
  const reasons = [
    "no_offer_configured",
    "granularity_missing",
    "all_dates_closed",
    "horizon_exhausted",
    "no_offer_in_horizon",
    "preparation_calendar_missing",
    "no_preparation_day_in_horizon",
    "cutoff_unresolvable",
    "capacity_exhausted",
  ];
  const keys = new Set(reasons.map(unfulfillableReasonKey));
  assert.equal(keys.size, reasons.length, "chaque motif doit avoir SA phrase, pas une phrase commune");
  assert.ok(!keys.has("avReasonUnknown"), "aucun motif du catalogue ne doit tomber dans le repli");
  assert.equal(unfulfillableReasonKey(null), "avReasonUnknown");
  assert.equal(unfulfillableReasonKey("motif_futur"), "avReasonUnknown");

  const statuses = [
    "absent",
    "blocked_upstream",
    "informational_only",
    "dates_available",
    "unfulfillable",
  ];
  const statusKeys = new Set(statuses.map(scheduleStatusKey));
  assert.equal(statusKeys.size, statuses.length);
  assert.equal(scheduleStatusKey("statut_futur"), "avStatusUnknown");
});

test("[BO1-PURE-11] 0 = dimanche, et la semaine s'affiche à partir du lundi", () => {
  assert.deepEqual([...WEEKDAY_DISPLAY_ORDER], [1, 2, 3, 4, 5, 6, 0]);
  assert.equal(weekdayLabelKey(0), "avWeekday0");
  assert.equal(weekdayLabelKey(6), "avWeekday6");
  assert.equal(weekdayLabelKey(9), "avWeekdayUnknown");
  const fr = DICTS.fr as Record<string, string>;
  assert.equal(fr[weekdayLabelKey(0)], "Dimanche");
  assert.equal(fr[weekdayLabelKey(1)], "Lundi");
});

test("[BO1-PURE-12] un échec de lecture ne laisse jamais fuir le message serveur", () => {
  assert.equal(readErrorKey(new Error("CSDJ1_AUTH_REQUIRED: session…")), "avAuthRequired");
  assert.equal(readErrorKey(new Error("CSDJ1_FORBIDDEN: accès refusé…")), "avForbidden");
  assert.equal(
    readErrorKey(new Error('relation "public.restaurant_fulfillment_schedule" does not exist')),
    "avLoadFailed"
  );
  const fr = DICTS.fr as Record<string, string>;
  for (const key of ["avAuthRequired", "avForbidden", "avLoadFailed"]) {
    const text = fr[key];
    assert.ok(text && text.length > 10, `${key} doit avoir une phrase lisible`);
    assert.ok(
      !/[0-9a-f]{8}-[0-9a-f]{4}/.test(text) && !/public\.|SQLSTATE|rpc/.test(text),
      `${key} ne doit contenir ni identifiant, ni nom d'objet SQL`
    );
  }
});
