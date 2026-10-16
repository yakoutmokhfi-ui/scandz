import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// CSDJ-BO-1 — VERROU D'ÉCRITURE DU SERVICE : TEST NÉGATIF EFFECTIF
// (remédiation PR #157, F-03).
//
// Le commit « tests » de #157 avait remplacé le refus effectif de
// `[BO1-SVC-16]` par un prédicat sur le TEXTE de la source (« le `if`
// précède `.rpc` ») : un test qui passe même si le `throw` disparaît.
//
// Ici le refus est EXÉCUTÉ, avec le drapeau réel forcé à `available =
// false` dans le bundle (la valeur du dépôt reste `true`, rien n'est
// modifié sur disque), et un ESPION sur le transport :
//   - `saveFulfillmentConfiguration` doit REJETER avec
//     `AvailabilityWriteUnavailableError` ET le compteur de RPC
//     d'écriture doit valoir 0 (et même le compteur de tout appel) ;
//   - CONTRÔLE POSITIF : avec le drapeau réel (`true`), la même requête
//     atteint bien le transport (1 appel `save_fulfillment_configuration`)
//     -- l'espion voit donc ce qu'il doit voir ;
//   - PREUVE DE MUTATION : le même service, `throw` retiré (en mémoire),
//     drapeau `false`, appelle la RPC d'écriture -- le test négatif est
//     donc capable d'échouer. Sans cette preuve il ne prouverait rien.
// ====================================================================

const REPO_ROOT = process.cwd();

type RpcCall = { fn: string; params: unknown };

const GUARD = `if (!CSDJ_BO1_WRITE_CONTRACT.available) {
    throw new AvailabilityWriteUnavailableError();
  }`;
const FLAG_TRUE = "available: true,";
const FLAG_FALSE = "available: false,";
const REASON_READY = 'reason: "CSDJ_BO1_WRITE_CONTRACT_READY",';
const REASON_PENDING = 'reason: "CSDJ_BO1_WRITE_CONTRACT_PENDING",';

interface Variant {
  /** Forcer le drapeau du contrat d'écriture à `false` dans le bundle. */
  flagAvailable: boolean;
  /** Retirer le `throw` de garde du service (mutation, en mémoire). */
  stripGuard: boolean;
}

async function bundle(entry: string, variant: Variant, id: string) {
  const callsKey = `__lock_calls_${id}`;
  (globalThis as any)[callsKey] = [] as RpcCall[];
  const mock = `
export const supabase = {
  async rpc(fn, params) {
    (globalThis)[${JSON.stringify(callsKey)}].push({ fn, params });
    return { data: null, error: { message: "transport espion : arrêt" } };
  },
};
`;
  const plugin: esbuild.Plugin = {
    name: "lock-mocks",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === "@/lib/supabase") return { path: args.path, namespace: "mock" };
        if (args.path.startsWith("@/")) {
          const base = path.join(REPO_ROOT, args.path.slice(2));
          const candidate = ["", ".tsx", ".ts"].map((ext) => base + ext).find((p) => existsSync(p));
          return { path: candidate ?? base };
        }
        return undefined;
      });
      build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: mock, loader: "ts" }));
      build.onLoad({ filter: /lib[\\/]availability-editor\.ts$/ }, (args) => {
        let source = readFileSync(args.path, "utf8");
        if (!variant.flagAvailable) {
          assert.equal(source.split(FLAG_TRUE).length - 1, 1, "le drapeau réel doit apparaître une fois");
          assert.equal(source.split(REASON_READY).length - 1, 1, "la raison réelle doit apparaître une fois");
          source = source.replace(FLAG_TRUE, FLAG_FALSE).replace(REASON_READY, REASON_PENDING);
        }
        return { contents: source, loader: "ts" };
      });
      build.onLoad({ filter: /lib[\\/]services[\\/]availability\.ts$/ }, (args) => {
        let source = readFileSync(args.path, "utf8");
        if (variant.stripGuard) {
          assert.equal(source.split(GUARD).length - 1, 1, "la garde doit apparaître une fois");
          source = source.replace(GUARD, "");
        }
        return { contents: source, loader: "ts" };
      });
    },
  };
  const result = await esbuild.build({
    stdin: { contents: entry, resolveDir: REPO_ROOT, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
    plugins: [plugin],
  });
  const dir = mkdtempSync(path.join(REPO_ROOT, "tests", "tmp-lock-"));
  const file = path.join(dir, "bundle.mjs");
  writeFileSync(file, result.outputFiles[0].text);
  try {
    const mod = await import(pathToFileURL(file).href);
    return { mod, calls: () => (globalThis as any)[callsKey] as RpcCall[] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SERVICE_ENTRY = `export * from "@/lib/services/availability";`;
const EDITOR_ENTRY = `export * from "@/lib/availability-editor";`;

const PAYLOAD = {
  modeCode: "pickup",
  fulfillmentRuleId: null,
  method: "v1",
  enabled: true,
};

const isWrite = (call: RpcCall) => /^save_|^mutate_|^reserve_|^release_/.test(call.fn);

test("[BO1-LOCK-1] drapeau d'écriture à false : la sauvegarde est REFUSÉE et AUCUN appel n'atteint le transport", async () => {
  const { mod, calls } = await bundle(SERVICE_ENTRY, { flagAvailable: false, stripGuard: false }, "neg");
  await assert.rejects(
    () => mod.saveFulfillmentConfiguration("r-1", PAYLOAD),
    (error: unknown) => {
      assert.ok(error instanceof mod.AvailabilityWriteUnavailableError, "mauvaise erreur de refus");
      assert.equal((error as Error).message, "CSDJ_BO1_WRITE_CONTRACT_PENDING");
      assert.equal((error as { reason?: string }).reason, "CSDJ_BO1_WRITE_CONTRACT_PENDING");
      return true;
    }
  );
  assert.equal(calls().filter(isWrite).length, 0, "compteur de RPC d'écriture");
  assert.deepEqual(calls(), [], "ni écriture, ni lecture : le refus précède le réseau");
});

test("[BO1-LOCK-2] contrôle positif : drapeau réel (true), la même requête atteint le transport (1 RPC d'écriture)", async () => {
  const { mod, calls } = await bundle(SERVICE_ENTRY, { flagAvailable: true, stripGuard: false }, "pos");
  await assert.rejects(
    () => mod.saveFulfillmentConfiguration("r-1", PAYLOAD),
    (error: unknown) => {
      assert.ok(!(error instanceof mod.AvailabilityWriteUnavailableError), "le refus ne doit pas s'appliquer");
      return true;
    }
  );
  const writes = calls().filter(isWrite);
  assert.equal(writes.length, 1, "l'espion voit l'appel d'écriture");
  assert.equal(writes[0].fn, "save_fulfillment_configuration");
});

test("[BO1-LOCK-3] preuve de mutation : sans le `throw`, drapeau à false, le service ÉCRIT -- le test négatif sait donc échouer", async () => {
  const { mod, calls } = await bundle(SERVICE_ENTRY, { flagAvailable: false, stripGuard: true }, "mut");
  let refused = false;
  try {
    await mod.saveFulfillmentConfiguration("r-1", PAYLOAD);
  } catch (error) {
    refused = error instanceof mod.AvailabilityWriteUnavailableError;
  }
  assert.equal(refused, false, "la mutation ne doit plus produire le refus");
  assert.equal(calls().filter(isWrite).length, 1, "la RPC d'écriture est atteinte : [BO1-LOCK-1] serait ROUGE");
});

test("[BO1-LOCK-4] drapeau à false : les contrôles d'écriture sont fermés pour TOUS les rôles, avec la raison « contrat » (propriétaire compris)", async () => {
  const { mod } = await bundle(EDITOR_ENTRY, { flagAvailable: false, stripGuard: false }, "ed-off");
  assert.deepEqual(mod.writeControlsState({ role: "owner", isOperator: false }), {
    enabled: false,
    reason: "write-contract",
  });
  assert.deepEqual(mod.writeControlsState({ role: "manager", isOperator: false }), {
    enabled: false,
    reason: "write-contract",
  });
  // Le rôle reste jugé EN PREMIER : un employé n'est jamais dit « contrat ».
  assert.deepEqual(mod.writeControlsState({ role: "staff", isOperator: false }), {
    enabled: false,
    reason: "role",
  });
  assert.deepEqual(mod.writeControlsState({ role: undefined, isOperator: true }), {
    enabled: false,
    reason: "role",
  });
});

test("[BO1-LOCK-5] drapeau réel (true) : seuls propriétaire et responsable écrivent ; employé, rôle absent et opérateur sont refusés", async () => {
  const { mod } = await bundle(EDITOR_ENTRY, { flagAvailable: true, stripGuard: false }, "ed-on");
  assert.deepEqual(mod.writeControlsState({ role: "owner", isOperator: false }), { enabled: true });
  assert.deepEqual(mod.writeControlsState({ role: "manager", isOperator: false }), { enabled: true });
  for (const role of ["staff", "viewer", "", undefined]) {
    assert.deepEqual(mod.writeControlsState({ role, isOperator: false }), {
      enabled: false,
      reason: "role",
    });
  }
  assert.deepEqual(mod.writeControlsState({ role: undefined, isOperator: true }), {
    enabled: false,
    reason: "role",
  });
});

test("[BO1-LOCK-6] la valeur du dépôt n'a pas été modifiée par ces tests (available = true)", () => {
  const source = readFileSync(path.join(REPO_ROOT, "lib", "availability-editor.ts"), "utf8");
  assert.equal(source.split(FLAG_TRUE).length - 1, 1);
  assert.equal(source.includes(FLAG_FALSE), false);
});

after(async () => {
  await esbuild.stop();
});
