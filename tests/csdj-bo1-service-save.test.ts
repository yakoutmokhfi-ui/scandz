import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// CSDJ-BO-1 — F-01 : LE SERVICE D'ÉCRITURE REND UN SNAPSHOT INDIVISIBLE.
//
// Le drapeau réel reste faux (vérifié ailleurs). Ici, et ici seulement
// pour ce fichier, `@/lib/availability-editor` est doublé avec
// `available: true` pour atteindre le corps de `saveFulfillmentConfiguration`
// et prouver qu'il rend { configuration, jetons } d'UNE SEULE réponse —
// jamais les jetons d'un appel et le contenu d'un autre.
// ====================================================================

const REPO_ROOT = process.cwd();

const MOCK_SUPABASE = `
export const supabase = {
  async rpc(fn, params) {
    (globalThis).__rpcCalls.push({ fn, params });
    const step = (globalThis).__rpcScript[fn];
    if (!step) throw new Error("appel RPC non scripté : " + fn);
    return typeof step === "function" ? step(params) : step;
  },
};
`;
const MOCK_EDITOR = `
export const CSDJ_BO1_WRITE_CONTRACT = {
  available: true,
  reason: "CSDJ_BO1_WRITE_CONTRACT_SIMULATED",
  requestedContract: "save_fulfillment_configuration",
};
`;
const mocks: Record<string, string> = {
  "@/lib/supabase": MOCK_SUPABASE,
  "@/lib/availability-editor": MOCK_EDITOR,
};

const mockPlugin: esbuild.Plugin = {
  name: "scanym-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (mocks[args.path]) return { path: args.path, namespace: "mock" };
      if (args.path.startsWith("@/")) {
        const base = path.join(REPO_ROOT, args.path.slice(2));
        const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p));
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

const built = await esbuild.build({
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
const tmpDir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-svc-save-"));
const tmpFile = path.join(tmpDir, "availability.mjs");
writeFileSync(tmpFile, built.outputFiles[0].text);
const service = await import(pathToFileURL(tmpFile).href);
rmSync(tmpDir, { recursive: true, force: true });

type Call = { fn: string; params: Record<string, unknown> };
const calls = () => (globalThis as any).__rpcCalls as Call[];
function script(table: Record<string, unknown>) {
  (globalThis as any).__rpcCalls = [];
  (globalThis as any).__rpcScript = table;
}

const UPDATED_AT = "2026-10-14T08:30:00.123457Z";
const REVISION = "0123456789abcdef0123456789abcdef";
const CONFIG = {
  updatedAt: UPDATED_AT,
  revision: REVISION,
  modeCode: "pickup",
  fulfillmentRuleId: null,
  method: "v1",
  enabled: true,
  policy: { timezone: "Europe/Paris" },
  windows: [],
  slots: [],
  closures: [],
};
const LISTS = {
  get_merchant_fulfillment_schedules: { data: [], error: null },
  get_merchant_fulfillment_schedules_v12: { data: [], error: null },
};

test("[BO1-F01-SVC-1] l'écriture rend le snapshot de la RÉPONSE : configuration et jetons de la même version, microseconde verbatim", async () => {
  script({ ...LISTS, save_fulfillment_configuration: { data: CONFIG, error: null } });
  const result = await service.saveFulfillmentConfiguration("r-1", { modeCode: "pickup" });

  assert.strictEqual(result.authoritative.tokens.updatedAt, UPDATED_AT);
  assert.strictEqual(result.authoritative.tokens.revision, REVISION);
  assert.strictEqual(result.authoritative.configuration, CONFIG, "le contenu est celui de la même réponse");
  assert.deepEqual(result.tokens, result.authoritative.tokens);
  // Une seule écriture, et AUCUNE relecture autoritaire superflue.
  assert.deepEqual(
    calls().map((c) => c.fn).filter((fn) => fn.startsWith("save_") || fn.startsWith("get_fulfillment")),
    ["save_fulfillment_configuration"]
  );
});

test("[BO1-F01-SVC-2] réponse d'écriture sans configuration : UNE relecture autoritaire, dont la réponse ENTIÈRE est prise", async () => {
  script({
    ...LISTS,
    save_fulfillment_configuration: { data: { updatedAt: UPDATED_AT, revision: REVISION }, error: null },
    get_fulfillment_configuration: { data: CONFIG, error: null },
  });
  const result = await service.saveFulfillmentConfiguration("r-1", {
    modeCode: "pickup",
    fulfillmentRuleId: null,
  });
  assert.strictEqual(result.authoritative.configuration, CONFIG);
  assert.strictEqual(result.authoritative.tokens.revision, REVISION);
  const rereads = calls().filter((c) => c.fn === "get_fulfillment_configuration");
  assert.equal(rereads.length, 1);
  assert.deepEqual(rereads[0].params, {
    p_restaurant_id: "r-1",
    p_mode_code: "pickup",
    p_fulfillment_rule_id: null,
  });
});

test("[BO1-F01-SVC-3] écriture acceptée mais configuration introuvable à la relecture : refus nommé, jamais un snapshot inventé", async () => {
  script({
    ...LISTS,
    save_fulfillment_configuration: { data: null, error: null },
    get_fulfillment_configuration: { data: null, error: null },
  });
  await assert.rejects(
    () => service.saveFulfillmentConfiguration("r-1", { modeCode: "pickup" }),
    /CSDJBO1_UNEXPECTED_CONFIGURATION_SHAPE/
  );
});

test("[BO1-F01-SVC-4] un refus de concurrence traverse tel quel, et aucun jeton n'est lu dans une erreur", async () => {
  script({
    ...LISTS,
    save_fulfillment_configuration: {
      data: null,
      error: { message: "CSDJBO1_STALE_CONFIGURATION: la portée a changé" },
    },
  });
  await assert.rejects(
    () => service.saveFulfillmentConfiguration("r-1", { modeCode: "pickup" }),
    /^Error: CSDJBO1_STALE_CONFIGURATION/
  );
  assert.equal(calls().filter((c) => c.fn.startsWith("get_fulfillment")).length, 0);
});

after(async () => {
  await esbuild.stop();
});
