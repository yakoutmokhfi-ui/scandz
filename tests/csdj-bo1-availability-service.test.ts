import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// CSDJ-BO-1 — TEST D'INTÉGRATION DU SERVICE DE LECTURE.
//
// Le client Supabase est remplacé par un double qui ENREGISTRE les
// appels et rend des réponses scriptées : on vérifie donc le contrat
// réel passé au serveur (nom de la fonction, noms des paramètres) et le
// mapping réel des colonnes, sans réseau et sans base.
//
// Ce qui est vérifié ici et nulle part ailleurs :
//  - les deux conventions de nommage des agrégats (camelCase pour les
//    lectures marchandes, snake_case pour les offres publiques) ;
//  - la DÉGRADATION de la lecture v1.2 quand la PR #146 n'est pas
//    appliquée : absence = statut, jamais exception ;
//  - le repli de statut « absent » quand la lecture publique ne rend
//    aucune ligne -- jamais une disponibilité supposée.
// ====================================================================

const REPO_ROOT = process.cwd();

type RpcCall = { fn: string; params: unknown };

const MOCK_SUPABASE = `
export const supabase = {
  async rpc(fn, params) {
    (globalThis).__rpcCalls.push({ fn, params });
    ((globalThis).__allCalls ??= []).push({ fn, params });
    const script = (globalThis).__rpcScript[fn];
    if (!script) throw new Error("appel RPC non scripté : " + fn);
    return script;
  },
};
`;

const mocks: Record<string, string> = { "@/lib/supabase": MOCK_SUPABASE };

const mockPlugin: esbuild.Plugin = {
  name: "scanym-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (mocks[args.path]) return { path: args.path, namespace: "mock" };
      if (args.path.startsWith("@/")) {
        const rel = args.path.slice(2);
        const base = path.join(REPO_ROOT, rel);
        const candidate = ["", ".tsx", ".ts"]
          .map((ext) => base + ext)
          .find((p) => existsSync(p));
        return { path: candidate ?? base };
      }
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
      contents: mocks[args.path],
      loader: "ts",
    }));
  },
};

const buildResult = await esbuild.build({
  stdin: {
    contents: `export * from "@/lib/services/availability";`,
    resolveDir: REPO_ROOT,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  target: "es2022",
  plugins: [mockPlugin],
});
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-svc-"));
const tmpFile = path.join(tmpDir, "availability.mjs");
writeFileSync(tmpFile, buildResult.outputFiles[0].text);
const service = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

function script(table: Record<string, { data?: unknown; error?: unknown }>) {
  (globalThis as any).__rpcCalls = [] as RpcCall[];
  (globalThis as any).__rpcScript = table;
}

function calls(): RpcCall[] {
  return (globalThis as any).__rpcCalls as RpcCall[];
}

// --------------------------------------------------------------------
// Lecture marchande du socle appliqué
// --------------------------------------------------------------------

test("[BO1-SVC-1] la lecture marchande appelle la bonne fonction avec le bon paramètre, et mappe les 15 colonnes", async () => {
  script({
    get_merchant_fulfillment_schedules: {
      data: [
        {
          mode_code: "pickup",
          fulfillment_rule_id: null,
          timezone: "Europe/Paris",
          enabled: true,
          date_selection_mode: "customer_selectable",
          slot_selection_mode: "fixed_slots",
          // Les smallint/numeric peuvent arriver en chaîne selon le
          // transport : le service doit les contraindre en nombre.
          time_granularity_minutes: "30",
          lead_time_minutes: "45",
          min_lead_days: "2",
          cutoff_time: "12:00:00",
          cutoff_offset_days: "1",
          booking_horizon_days: "14",
          windows: [{ weekday: 2, startsAt: "11:00", endsAt: "14:00" }],
          slots: [{ weekday: 2, slotKey: "matin", startsAt: "09:00", endsAt: "12:00" }],
          closures: [{ closedOn: "2026-12-25", label: "Noël" }],
        },
      ],
      error: null,
    },
  });

  const rows = await service.getMerchantFulfillmentSchedules("r-1");

  assert.deepEqual(calls(), [
    { fn: "get_merchant_fulfillment_schedules", params: { p_restaurant_id: "r-1" } },
  ]);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.modeCode, "pickup");
  assert.equal(row.fulfillmentRuleId, null);
  assert.equal(row.enabled, true);
  assert.equal(row.timeGranularityMinutes, 30);
  assert.equal(row.leadTimeMinutes, 45);
  assert.equal(row.minLeadDays, 2);
  assert.equal(row.cutoffOffsetDays, 1);
  assert.equal(row.bookingHorizonDays, 14);
  assert.equal(row.cutoffTime, "12:00:00");
  // Les agrégats marchands arrivent DÉJÀ en camelCase : repris tels
  // quels, sans second renommage.
  assert.deepEqual(row.windows, [{ weekday: 2, startsAt: "11:00", endsAt: "14:00" }]);
  assert.deepEqual(row.slots, [
    { weekday: 2, slotKey: "matin", startsAt: "09:00", endsAt: "12:00" },
  ]);
  assert.deepEqual(row.closures, [{ closedOn: "2026-12-25", label: "Noël" }]);
});

test("[BO1-SVC-2] une portée minimale ne produit ni NaN, ni undefined, ni liste absente", async () => {
  script({
    get_merchant_fulfillment_schedules: {
      data: [
        {
          mode_code: "click_collect",
          fulfillment_rule_id: "11111111-1111-1111-1111-111111111111",
          timezone: "Europe/Paris",
          enabled: false,
          date_selection_mode: "informational_only",
          slot_selection_mode: "none",
          time_granularity_minutes: null,
          lead_time_minutes: null,
          min_lead_days: null,
          cutoff_time: null,
          cutoff_offset_days: null,
          booking_horizon_days: null,
          windows: null,
          slots: null,
          closures: null,
        },
      ],
      error: null,
    },
  });

  const [row] = await service.getMerchantFulfillmentSchedules("r-1");
  assert.equal(row.timeGranularityMinutes, null);
  assert.equal(row.cutoffTime, null);
  assert.equal(row.leadTimeMinutes, 0);
  assert.equal(row.minLeadDays, 0);
  assert.equal(row.cutoffOffsetDays, 0);
  assert.equal(row.bookingHorizonDays, 0);
  assert.deepEqual(row.windows, []);
  assert.deepEqual(row.slots, []);
  assert.deepEqual(row.closures, []);
  assert.equal(row.fulfillmentRuleId, "11111111-1111-1111-1111-111111111111");
});

test("[BO1-SVC-3] un refus de la lecture marchande remonte : c'est la page qui le traduit en phrase sûre", async () => {
  script({
    get_merchant_fulfillment_schedules: {
      data: null,
      error: { message: "CSDJ1_FORBIDDEN: accès refusé à cet établissement." },
    },
  });
  await assert.rejects(
    () => service.getMerchantFulfillmentSchedules("r-1"),
    /CSDJ1_FORBIDDEN/,
    "le service ne doit pas avaler le refus : la page le mappe sur avForbidden"
  );
});

// --------------------------------------------------------------------
// Lecture v1.2 — livrée, NON appliquée : l'absence est un statut
// --------------------------------------------------------------------

test("[BO1-SVC-4] PR #146 non appliquée : la lecture v1.2 rend « absent » et ne jette JAMAIS", async () => {
  for (const error of [
    { code: "PGRST202", message: "Could not find the function public.get_merchant_fulfillment_schedules_v12(p_restaurant_id)" },
    { code: "42883", message: "function public.get_merchant_fulfillment_schedules_v12(uuid) does not exist" },
    { code: null, message: "Could not find the function in the schema cache" },
  ]) {
    script({ get_merchant_fulfillment_schedules_v12: { data: null, error } });
    const result = await service.getMerchantFulfillmentSchedulesV12("r-1");
    assert.deepEqual(
      result,
      { status: "absent" },
      `l'absence de la fonction (${error.code ?? "sans code"}) doit être un statut, pas une exception`
    );
  }
});

test("[BO1-SVC-5] un refus de rôle et un échec technique sont deux statuts distincts", async () => {
  script({
    get_merchant_fulfillment_schedules_v12: {
      data: null,
      error: { code: "42501", message: "CSDJ12_FORBIDDEN: accès refusé à cet établissement." },
    },
  });
  assert.deepEqual(await service.getMerchantFulfillmentSchedulesV12("r-1"), {
    status: "forbidden",
  });

  script({
    get_merchant_fulfillment_schedules_v12: {
      data: null,
      error: { code: "57014", message: "canceling statement due to statement timeout" },
    },
  });
  assert.deepEqual(await service.getMerchantFulfillmentSchedulesV12("r-1"), { status: "error" });
});

test("[BO1-SVC-6] PR #146 appliquée : les extensions sont mappées, et un jour de semaine aberrant est écarté", async () => {
  script({
    get_merchant_fulfillment_schedules_v12: {
      data: [
        {
          mode_code: "pickup",
          fulfillment_rule_id: null,
          schedule_method_version: "v1.2",
          holiday_calendar_id: null,
          preparation_on_holidays: "open",
          availability_on_holidays: "closed",
          capacity_enabled: true,
          capacity_max_orders: "12",
          // 7 et -1 n'existent pas (0..6) : ils doivent disparaître
          // plutôt que de produire une case de semaine fantôme.
          preparation_weekdays: [1, 2, 7, -1, 5],
          preparation_closures: [{ closedOn: "2026-10-14", label: "Entretien four" }, { closedOn: "2026-12-24", label: null }],
        },
      ],
      error: null,
    },
  });

  const result = await service.getMerchantFulfillmentSchedulesV12("r-1");
  assert.equal(result.status, "available");
  assert.deepEqual(calls(), [
    { fn: "get_merchant_fulfillment_schedules_v12", params: { p_restaurant_id: "r-1" } },
  ]);
  const [row] = result.rows;
  assert.equal(row.scheduleMethodVersion, "v1.2");
  assert.equal(row.availabilityOnHolidays, "closed");
  assert.equal(row.capacityEnabled, true);
  assert.equal(row.capacityMaxOrders, 12);
  assert.deepEqual(row.preparationWeekdays, [1, 2, 5]);
  assert.deepEqual(row.preparationClosures, [
    { closedOn: "2026-10-14", label: "Entretien four" },
    { closedOn: "2026-12-24", label: null },
  ]);
});

// --------------------------------------------------------------------
// Aperçu serveur — lecture publique sûre
// --------------------------------------------------------------------

test("[BO1-SVC-7] l'aperçu envoie les cinq paramètres publics, et AUCUNE heure", async () => {
  script({
    get_checkout_fulfillment_schedule: {
      data: [
        {
          delivery_applicable: true,
          delivery_eligible: true,
          delivery_block: null,
          delivery_customer_text: null,
          schedule_status: "dates_available",
          unfulfillable_reason: null,
          schedule_timezone: "Europe/Paris",
          date_selection_mode: "customer_selectable",
          slot_selection_mode: "fixed_slots",
          time_granularity_minutes: null,
          first_eligible_date: "2026-10-15",
          eligible_dates: ["2026-10-15", "2026-10-16"],
          // La lecture PUBLIQUE rend ses offres en snake_case, groupées
          // par date : reprises telles quelles.
          offers: {
            "2026-10-15": [{ slot_key: "matin", starts_at: "09:00", ends_at: "12:00" }],
            "2026-10-16": [{ slot_key: null, starts_at: "11:00", ends_at: "11:30" }],
          },
        },
      ],
      error: null,
    },
  });

  const preview = await service.getCheckoutFulfillmentSchedulePreview({
    restaurantId: "r-1",
    modeCode: "delivery",
    postalCode: "75011",
    totalCount: 3,
    subtotal: 42,
  });

  assert.deepEqual(calls(), [
    {
      fn: "get_checkout_fulfillment_schedule",
      params: {
        p_restaurant_id: "r-1",
        p_mode_code: "delivery",
        p_postal_code: "75011",
        p_total_count: 3,
        p_subtotal: 42,
      },
    },
  ]);
  const params = calls()[0].params as Record<string, unknown>;
  assert.ok(
    !Object.keys(params).some((k) => /now|time|at$/.test(k)),
    "aucun « maintenant » ne doit être proposé au serveur"
  );
  assert.equal(preview.scheduleStatus, "dates_available");
  assert.equal(preview.firstEligibleDate, "2026-10-15");
  assert.deepEqual(preview.eligibleDates, ["2026-10-15", "2026-10-16"]);
  assert.deepEqual(preview.offers!["2026-10-15"], [
    { slot_key: "matin", starts_at: "09:00", ends_at: "12:00" },
  ]);
});

test("[BO1-SVC-8] paramètres optionnels omis : null et 0 sont envoyés explicitement, jamais undefined", async () => {
  script({
    get_checkout_fulfillment_schedule: { data: [{ schedule_status: "absent" }], error: null },
  });
  await service.getCheckoutFulfillmentSchedulePreview({
    restaurantId: "r-1",
    modeCode: "pickup",
  });
  assert.deepEqual(calls()[0].params, {
    p_restaurant_id: "r-1",
    p_mode_code: "pickup",
    p_postal_code: null,
    p_total_count: 0,
    p_subtotal: null,
  });
});

test("[BO1-SVC-9] aucune ligne rendue : repli sur le statut « absent », jamais sur une disponibilité", async () => {
  for (const data of [[], null, undefined]) {
    script({ get_checkout_fulfillment_schedule: { data, error: null } });
    const preview = await service.getCheckoutFulfillmentSchedulePreview({
      restaurantId: "r-1",
      modeCode: "pickup",
    });
    assert.equal(preview.scheduleStatus, "absent");
    assert.equal(preview.firstEligibleDate, null);
    assert.deepEqual(preview.eligibleDates, []);
    assert.equal(preview.offers, null);
    assert.equal(preview.deliveryApplicable, false);
    assert.equal(preview.deliveryEligible, false);
  }
});

test("[BO1-SVC-10] un motif d'infaisabilité traverse tel quel : la page ne doit pas le deviner", async () => {
  script({
    get_checkout_fulfillment_schedule: {
      data: {
        schedule_status: "unfulfillable",
        unfulfillable_reason: "preparation_calendar_missing",
        eligible_dates: null,
        offers: null,
      },
      error: null,
    },
  });
  const preview = await service.getCheckoutFulfillmentSchedulePreview({
    restaurantId: "r-1",
    modeCode: "pickup",
  });
  assert.equal(preview.scheduleStatus, "unfulfillable");
  assert.equal(preview.unfulfillableReason, "preparation_calendar_missing");
});

// --------------------------------------------------------------------
// REMÉDIATION R1 — lecture AUTORITAIRE d'une portée (contrat §2)
// --------------------------------------------------------------------

test("[BO1-SVC-12] la lecture autoritaire envoie les trois paramètres du contrat et rend les deux jetons TELS QUE REÇUS", async () => {
  const updatedAt = "2026-10-14T08:30:00.123456Z";
  const revision = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
  script({
    get_fulfillment_configuration: {
      data: { updatedAt, revision, modeCode: "pickup", fulfillmentRuleId: null, enabled: true },
      error: null,
    },
  });

  const read = await service.getFulfillmentConfiguration("r-1", "pickup", null);

  assert.deepEqual(calls(), [
    {
      fn: "get_fulfillment_configuration",
      params: { p_restaurant_id: "r-1", p_mode_code: "pickup", p_fulfillment_rule_id: null },
    },
  ]);
  // Chaîne identique octet pour octet : six chiffres de fraction, le
  // « Z » final, aucune reconstruction par `Date`.
  assert.strictEqual(read.tokens.updatedAt, updatedAt);
  assert.strictEqual(read.tokens.revision, revision);
  assert.equal(typeof read.tokens.updatedAt, "string");
  assert.equal(read.configuration.modeCode, "pickup");
});

test("[BO1-SVC-13] une portée sans configuration rend null — jamais une erreur, jamais une configuration inventée", async () => {
  script({ get_fulfillment_configuration: { data: null, error: null } });
  const read = await service.getFulfillmentConfiguration(
    "r-1",
    "delivery",
    "22222222-2222-2222-2222-222222222222"
  );
  assert.equal(read, null);
  assert.deepEqual(calls()[0].params, {
    p_restaurant_id: "r-1",
    p_mode_code: "delivery",
    p_fulfillment_rule_id: "22222222-2222-2222-2222-222222222222",
  });
});

test("[BO1-SVC-14] une réponse malformée est refusée par son nom, au lieu d'être devinée", async () => {
  const good = { updatedAt: "2026-10-14T08:30:00.123456Z", revision: "a1b2c3d4e5f60718293a4b5c6d7e8f90" };
  const bad: Array<[string, unknown]> = [
    ["tableau", [good]],
    ["chaîne", "oops"],
    ["updatedAt absent", { revision: good.revision }],
    ["updatedAt non chaîne", { ...good, updatedAt: 1760430600123 }],
    ["revision absente", { updatedAt: good.updatedAt }],
    ["revision trop courte", { ...good, revision: "abc123" }],
    ["revision hors hexadécimal", { ...good, revision: "z".repeat(32) }],
    ["revision en majuscules", { ...good, revision: good.revision.toUpperCase() }],
  ];
  for (const [label, data] of bad) {
    script({ get_fulfillment_configuration: { data, error: null } });
    await assert.rejects(
      () => service.getFulfillmentConfiguration("r-1", "pickup", null),
      (error: unknown) => {
        assert.ok(error instanceof service.FulfillmentConfigurationShapeError, label);
        assert.match((error as Error).message, /^CSDJBO1_UNEXPECTED_CONFIGURATION_SHAPE/, label);
        return true;
      },
      label
    );
  }
});

test("[BO1-SVC-15] un refus de la lecture autoritaire remonte tel quel, pour que la page le traduise", async () => {
  script({
    get_fulfillment_configuration: {
      data: null,
      error: { message: "CSDJ1_FORBIDDEN: rôle owner ou manager requis" },
    },
  });
  await assert.rejects(
    () => service.getFulfillmentConfiguration("r-1", "pickup", null),
    /CSDJ1_FORBIDDEN/
  );
});

test("[BO1-SVC-16] le verrou d'écriture du service précède l'appel réseau (le drapeau est vrai depuis #154)", () => {
  // Le drapeau réel vaut `true` depuis #154 : l'ancien test, qui jouait un
  // refus local, ne peut plus s'exécuter sans écrire. L'invariant qui
  // compte -- le verrou est LU avant tout appel -- est vérifié sur la
  // source, comme dans [BO1-RPC-2b].
  const src = readFileSync(path.join(process.cwd(), "lib", "services", "availability.ts"), "utf8");
  const guard = src.indexOf("if (!CSDJ_BO1_WRITE_CONTRACT.available)");
  const call = src.search(/\.rpc\(\s*["'`]save_fulfillment_configuration/);
  assert.ok(guard >= 0 && call > guard);
});

test("[BO1-SVC-11] le service n'a appelé, sur toute cette suite, AUCUNE fonction d'écriture", () => {
  // Garde de synthèse : même si un futur appel d'écriture passait les
  // tests structurels, il apparaîtrait ici.
  const everyCall = [...((globalThis as any).__allCalls ?? [])] as RpcCall[];
  assert.ok(
    everyCall.length >= 10,
    `la garde doit porter sur des appels réellement observés (vus : ${everyCall.length})`
  );
  for (const call of everyCall) {
    assert.ok(
      !/^mutate_|^save_|^reserve_|^release_/.test(call.fn),
      `appel d'écriture détecté : ${call.fn}`
    );
  }
});

after(async () => {
  await esbuild.stop();
});
