// ====================================================================
// CSDJ-BO-1 — INTÉGRATION Nougaro (frontend) + Boulez (backend) : pilote de COMPATIBILITÉ.
//
// Appelé par supabase/tests/csdj-bo1-integration-compat-check.sh (grappe PostgreSQL jetable).
// Il exécute le VRAI code de l'éditeur (lib/availability-payload.ts : brouillon, jetons,
// validation, charge d'écriture, rebase, lecture des refus) contre les VRAIES RPC
// save_fulfillment_configuration / get_fulfillment_configuration (+ invariant F-02), appelées
// comme un client réel (rôle `authenticated`, utilisateur du JWT).
//
// Sortie : une ligne par preuve, « OK|<nom> » ou « KO|<nom>|<détail> ».
// ====================================================================
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

import {
  buildSaveFulfillmentConfigurationPayload,
  diffDrafts,
  draftFromAuthoritativeSnapshot,
  isDraftDirty,
  issuesBlockingDraft,
  rebaseDraft,
  saveErrorKey,
  serverRefusalCode,
  validateDraft,
  type AvailabilityDraft,
} from "../../lib/availability-payload.ts";

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`variable ${k} absente`);
  return v;
};
const DB = env("IC_DB");
const RID_A = env("IC_RID_A");
const RID_B = env("IC_RID_B");
const OWNER_A = env("IC_OWNER_A");
const OWNER_B = env("IC_OWNER_B");
const RULE_A = env("IC_RULE_A");
const readJson = (k: string) => JSON.parse(readFileSync(env(k), "utf8")) as Record<string, unknown>;

type Res = { ok: true; json: Record<string, unknown> | null } | { ok: false; message: string; detail: string };

function psql(sql: string, vars: Record<string, string> = {}): string {
  const args = ["-X", "-A", "-q", "-t", "-v", "ON_ERROR_STOP=1"];
  for (const [k, v] of Object.entries(vars)) args.push("-v", `${k}=${v}`);
  args.push("-d", DB);
  return execFileSync("psql", args, {
    input: sql,
    encoding: "utf8",
    env: { ...process.env, PGOPTIONS: "-c lc_messages=C -c role=authenticated" },
    stdio: ["pipe", "pipe", "pipe"],
  });
}
/** Le message d'une erreur PostgREST est le texte de l'exception : on reproduit cette forme. */
function call(sql: string, vars: Record<string, string> = {}): Res {
  try {
    const out = psql(sql, vars).trim().split("\n").pop() ?? "";
    return { ok: true, json: out === "" || out === "NULL" ? null : (JSON.parse(out) as Record<string, unknown>) };
  } catch (e) {
    const err = (e as { stderr?: string }).stderr ?? String(e);
    const message = (err.match(/ERROR:  (.*)/)?.[1] ?? err).trim();
    const detail = (err.match(/DETAIL:  (.*)/)?.[1] ?? "").trim();
    return { ok: false, message, detail };
  }
}
const save = (uid: string, rid: string, payload: Record<string, unknown>): Res =>
  call(`set test.uid = '${uid}';\nselect public.save_fulfillment_configuration('${rid}'::uuid, :'p'::jsonb);`, {
    p: JSON.stringify(payload),
  });
const get = (uid: string, rid: string, mode: string, rule: string | null): Res =>
  call(
    `set test.uid = '${uid}';\nselect coalesce(public.get_fulfillment_configuration('${rid}'::uuid, '${mode}', ${
      rule ? `'${rule}'::uuid` : "null"
    })::text, 'NULL');`
  );
const wipe = (rid: string) =>
  execFileSync("psql", ["-X", "-q", "-t", "-d", DB], {
    input: `delete from public.restaurant_fulfillment_schedule where restaurant_id='${rid}';`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

let ko = 0;
const out = (line: string) => process.stdout.write(`${line}\n`);
const ok = (name: string) => out(`OK|${name}`);
const fail = (name: string, detail: string) => {
  ko += 1;
  out(`KO|${name}|${detail.replace(/\n/g, " ").slice(0, 300)}`);
};
const check = (name: string, cond: boolean, detail = "") => (cond ? ok(name) : fail(name, detail));
/** Forme canonique : clés triées récursivement (l'ordre des clés JSON n'a aucun sens), listes dans l'ordre. */
const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
      : v;
/** Premiers chemins qui diffèrent (pour un diagnostic lisible). */
const diffPaths = (a: unknown, b: unknown, path = "$", acc: string[] = []): string[] => {
  if (acc.length >= 4) return acc;
  const ca = canon(a), cb = canon(b);
  if (JSON.stringify(ca) === JSON.stringify(cb)) return acc;
  if (ca && cb && typeof ca === "object" && typeof cb === "object") {
    const ka = new Set([...Object.keys(ca as object), ...Object.keys(cb as object)]);
    for (const k of ka) diffPaths((ca as Record<string, unknown>)[k], (cb as Record<string, unknown>)[k], `${path}.${k}`, acc);
    return acc;
  }
  acc.push(`${path}: obtenu ${JSON.stringify(ca)} / attendu ${JSON.stringify(cb)}`);
  return acc;
};
const eq = (name: string, a: unknown, b: unknown) =>
  JSON.stringify(canon(a)) === JSON.stringify(canon(b)) ? ok(name) : fail(name, diffPaths(a, b).join(" ; "));

/** Comme la page : la réponse serveur EST le snapshot { configuration, jetons }. */
function snapshotOf(json: Record<string, unknown>) {
  return {
    tokens: { updatedAt: String(json.updatedAt), revision: String(json.revision) },
    configuration: json,
  };
}
const draftOf = (json: Record<string, unknown>): AvailabilityDraft => draftFromAuthoritativeSnapshot(snapshotOf(json));
/**
 * Forme comparable d'une charge : sans jetons, sans `displayOrder` (l'éditeur renumérote 0..n-1 globalement ; l'ordre des
 * lignes, lui, est comparé), sans `policy.cutoffOffsetDays` en v1.2 (l'éditeur ne l'envoie pas, le serveur l'accepte
 * absent -- cf. I2 -- comme à 0).
 */
const stripTokens = (p: Record<string, unknown>) => {
  const { expectedUpdatedAt, expectedRevision, ...rest } = p;
  void expectedUpdatedAt;
  void expectedRevision;
  const noOrder = (rows: unknown) =>
    Array.isArray(rows) ? rows.map((r) => { const { displayOrder, ...x } = r as Record<string, unknown>; void displayOrder; return x; }) : rows;
  const policy = { ...(rest.policy as Record<string, unknown>) };
  if (rest.method === "v1.2") delete policy.cutoffOffsetDays;
  return { ...rest, policy, windows: noOrder(rest.windows), slots: noOrder(rest.slots) };
};
const orderOk = (rows: unknown) => Array.isArray(rows) && rows.every((r, i) => (r as { displayOrder?: number }).displayOrder === i);

// -------------------------------------------------------------------
// I1 — aller-retour : RPC → snapshot → brouillon → charge  ≡  charge d'origine
// -------------------------------------------------------------------
wipe(RID_A);
wipe(RID_B);
const PA = readJson("IC_PA"); // Au Lait Cru : v1.2, 10 créneaux, retrait
const PAR = readJson("IC_PAR"); // même configuration, portée = règle de livraison
const PV1 = readJson("IC_PV1"); // v1 : fenêtres + fermetures

const r1 = save(OWNER_A, RID_A, PA);
if (!r1.ok || !r1.json) {
  fail("I1 enregistrement initial par la RPC de Boulez", r1.ok ? "réponse vide" : r1.message);
  process.exit(1);
}
ok("I1 enregistrement initial (charge Boulez) accepté");
const R1 = r1.json;
const d1 = draftOf(R1);
const rebuilt = buildSaveFulfillmentConfigurationPayload(d1);
eq("I1 la charge reconstruite par l'éditeur ≡ la charge envoyée (hors jetons)", stripTokens(rebuilt), stripTokens(PA));
eq("I1 les jetons du brouillon sont ceux du serveur, verbatim", [rebuilt.expectedUpdatedAt, rebuilt.expectedRevision], [R1.updatedAt, R1.revision]);
check("I1 displayOrder de l'éditeur : 0..n-1, accepté par le serveur", orderOk(rebuilt.slots), JSON.stringify(rebuilt.slots));
check("I1 updatedAt à la microseconde, tel que rendu", /\.\d{6}Z$/.test(String(rebuilt.expectedUpdatedAt)), String(rebuilt.expectedUpdatedAt));
const g1 = get(OWNER_A, RID_A, "pickup", null);
check("I1 la lecture autoritaire rend le même snapshot que l'écriture", g1.ok && JSON.stringify(g1.json) === JSON.stringify(R1), g1.ok ? "différent" : g1.message);

// -------------------------------------------------------------------
// I2 — modification via l'éditeur, avec les jetons du snapshot : acceptée, nouveaux jetons
// -------------------------------------------------------------------
const d2 = { ...d1, cutoffTime: "15:30" };
check("I2 la validation locale accepte le brouillon modifié", validateDraft(d2).length === 0, JSON.stringify(validateDraft(d2)));
const r2 = save(OWNER_A, RID_A, buildSaveFulfillmentConfigurationPayload(d2));
check("I2 la RPC accepte la charge de l'éditeur", r2.ok, r2.ok ? "" : r2.message);
const R2 = r2.ok && r2.json ? r2.json : R1;
check("I2 nouveaux jetons différents des précédents", R2.revision !== R1.revision && R2.updatedAt !== R1.updatedAt);
eq("I2 la réponse porte la modification", (R2.policy as Record<string, unknown>).cutoffTime, "15:30");
check("I2 brouillon repris depuis la réponse = non modifié (pas de fausse alerte)", !isDraftDirty(draftOf(R2), draftOf(R2)));

// -------------------------------------------------------------------
// I3 — F-01 : un tiers a écrit entre-temps ; l'ancienne charge est refusée (STALE), rien n'est écrasé
// -------------------------------------------------------------------
const stalePayload = buildSaveFulfillmentConfigurationPayload({ ...d1, cutoffTime: "14:00" }); // jetons de R1 (périmés)
const r3 = save(OWNER_A, RID_A, stalePayload);
check("I3 STALE : la RPC refuse la charge aux jetons périmés", !r3.ok, "acceptée !");
if (!r3.ok) {
  eq("I3 le préfixe du message est le code métier lu par l'éditeur", serverRefusalCode(new Error(r3.message)), "CSDJBO1_STALE_CONFIGURATION");
  eq("I3 la clé i18n est celle du conflit (pas le repli générique)", saveErrorKey(new Error(r3.message)), "avSaveStale");
}
const afterStale = get(OWNER_A, RID_A, "pickup", null);
check("I3 la version du tiers est intacte après le refus", afterStale.ok && JSON.stringify(afterStale.json) === JSON.stringify(R2));

// -------------------------------------------------------------------
// I4 — F-01 : divergence champ par champ, puis REBASE explicite → enregistrement accepté, rien perdu
// -------------------------------------------------------------------
const base = d1; // ce que j'avais lu
const mine = { ...d1, bookingHorizonDays: "21" }; // ma modification
const theirs = draftOf(R2); // la version du tiers (cutoffTime 15:30)
const div = diffDrafts(base, mine, theirs);
eq("I4 divergences nommées (moi : horizon ; tiers : heure limite)", div.map((x) => `${x.field}:${x.origin}`).sort(), ["bookingHorizonDays:mine", "cutoffTime:theirs"]);
const rebased = rebaseDraft(base, mine, theirs);
const r4 = save(OWNER_A, RID_A, buildSaveFulfillmentConfigurationPayload(rebased));
check("I4 le brouillon rebasé (jetons du serveur) est accepté", r4.ok, r4.ok ? "" : r4.message);
if (r4.ok && r4.json) {
  const pol = r4.json.policy as Record<string, unknown>;
  eq("I4 les deux modifications survivent (horizon 21 ET heure limite du tiers)", [pol.bookingHorizonDays, pol.cutoffTime], [21, "15:30"]);
}

// -------------------------------------------------------------------
// I5 — activation incomplète : bloquée localement ET refusée par le serveur avec le code lu par l'éditeur
// -------------------------------------------------------------------
const cur = get(OWNER_A, RID_A, "pickup", null);
const dCur = draftOf(cur.ok && cur.json ? cur.json : R2);
const incomplete = { ...dCur, slots: [], preparationWeekdays: [] as number[] };
const localIssues = validateDraft(incomplete).map((i) => i.code).sort();
check("I5 l'éditeur bloque localement (offre + préparation)", localIssues.includes("offer_missing" as never) && localIssues.includes("preparation_missing" as never), JSON.stringify(localIssues));
const r5 = save(OWNER_A, RID_A, buildSaveFulfillmentConfigurationPayload(incomplete)); // envoyée malgré tout
check("I5 le serveur refuse la même configuration", !r5.ok, "acceptée !");
if (!r5.ok) {
  eq("I5 code lu par l'éditeur", serverRefusalCode(new Error(r5.message)), "CSDJBO1_INCOMPLETE_CONFIGURATION");
  eq("I5 clé i18n 'incomplet'", saveErrorKey(new Error(r5.message)), "avSaveIncomplete");
}
// L'éditeur est PLUS strict que le serveur pour un brouillon v1.2 : il exige toujours un jour de préparation
// (le serveur ne l'exige qu'à l'activation). Plus strict, jamais plus permissif : constaté, pas un défaut.
check("I5 brouillon désactivé : l'éditeur n'ajoute que « préparation » (plus strict que le serveur, jamais plus permissif)", issuesBlockingDraft(incomplete).every((i) => (i.code as string) === "preparation_missing"), JSON.stringify(issuesBlockingDraft(incomplete)));
const r5b = save(OWNER_A, RID_A, buildSaveFulfillmentConfigurationPayload({ ...(incomplete as AvailabilityDraft), ...{ expectedUpdatedAt: String((cur.ok && cur.json ? cur.json : R2).updatedAt), expectedRevision: String((cur.ok && cur.json ? cur.json : R2).revision) }, enabled: false }));
check("I5 repli « enregistrer en brouillon » accepté par le serveur (désactivé, incomplet)", r5b.ok, r5b.ok ? "" : r5b.message);

// -------------------------------------------------------------------
// I6 — méthode v1 : cutoffOffsetDays présent, pas de sections v1.2 ; aller-retour ; METHOD_MISMATCH nommé
// -------------------------------------------------------------------
const r6 = save(OWNER_B, RID_B, PV1);
check("I6 v1 : charge Boulez acceptée", r6.ok, r6.ok ? "" : r6.message);
if (r6.ok && r6.json) {
  const d6 = draftOf(r6.json);
  const p6 = buildSaveFulfillmentConfigurationPayload(d6);
  eq("I6 v1 : charge de l'éditeur ≡ charge d'origine (hors jetons)", stripTokens(p6), stripTokens(PV1));
  check("I6 v1 : pas de section v1.2 envoyée", !("preparation" in p6) && !("holidays" in p6) && !("capacity" in p6));
  const mm = save(OWNER_B, RID_B, { ...p6, method: "v1.2" });
  check("I6 METHOD_MISMATCH : refus serveur", !mm.ok, "accepté !");
  if (!mm.ok) {
    eq("I6 METHOD_MISMATCH : code lu par l'éditeur", serverRefusalCode(new Error(mm.message)), "CSDJBO1_METHOD_MISMATCH");
    eq("I6 METHOD_MISMATCH : clé i18n", saveErrorKey(new Error(mm.message)), "avSaveMethodMismatch");
  }
}

// -------------------------------------------------------------------
// I7 — portée par règle de livraison (fulfillmentRuleId) : aller-retour + isolation d'établissement
// -------------------------------------------------------------------
const PARD = { ...PAR, modeCode: "delivery" };
const r7 = save(OWNER_A, RID_A, PARD);
check("I7 règle de livraison : charge Boulez acceptée", r7.ok, r7.ok ? "" : r7.message);
if (r7.ok && r7.json) {
  const d7 = draftOf(r7.json);
  eq("I7 la règle est portée par le brouillon", d7.fulfillmentRuleId, RULE_A);
  eq("I7 charge de l'éditeur ≡ charge d'origine (hors jetons)", stripTokens(buildSaveFulfillmentConfigurationPayload(d7)), stripTokens(PARD));
  const cross = save(OWNER_B, RID_A, buildSaveFulfillmentConfigurationPayload(d7));
  check("I7 un autre propriétaire ne peut pas écrire dans cet établissement", !cross.ok, "accepté !");
  if (!cross.ok) eq("I7 refus d'autorisation lu par l'éditeur", saveErrorKey(new Error(cross.message)), "avSaveForbidden");
}

// -------------------------------------------------------------------
// I8 — l'éditeur ne laisse pas partir ce que le serveur refuse : grille (méthode × offre × créneaux × fenêtres × préparation)
//      client « bloqué »  ⟺  serveur « pas OK »  ; bloqueurs communs d'activation identiques.
// -------------------------------------------------------------------
wipe(RID_A);
const baseSnap = save(OWNER_A, RID_A, { ...PA, enabled: false });
check("I8 point de départ (brouillon complet)", baseSnap.ok, baseSnap.ok ? "" : baseSnap.message);
let grid = 0;
const mismatches: string[] = [];
if (baseSnap.ok && baseSnap.json) {
  const dBase = draftOf(baseSnap.json);
  for (const method of ["v1", "v1.2"] as const) {
    for (const dateMode of ["customer_selectable", "informational_only"]) {
      for (const slotMode of ["none", "fixed_slots"]) {
        for (const w of [0, 1]) for (const s of [0, 1]) for (const p of [0, 1]) {
          wipe(RID_A);
          const d: AvailabilityDraft = {
            ...dBase,
            method,
            enabled: true,
            expectedUpdatedAt: null,
            expectedRevision: null,
            dateSelectionMode: dateMode,
            slotSelectionMode: slotMode,
            timeGranularityMinutes: "",
            cutoffOffsetDays: method === "v1" ? "1" : "0",
            windows: w ? [{ rowId: "w", weekday: 2, startsAt: "11:00", endsAt: "14:00" } as never] : [],
            slots: s ? [{ rowId: "s", weekday: 2, slotKey: "midi", startsAt: "11:00", endsAt: "14:00" } as never] : [],
            preparationWeekdays: method === "v1.2" && p ? [2] : [],
          };
          // La charge de l'éditeur pour ce cas ; l'éditeur ne l'enverrait pas s'il la bloque.
          const issues = validateDraft(d).map((i) => i.code as string);
          const res = save(OWNER_A, RID_A, buildSaveFulfillmentConfigurationPayload(d));
          grid += 1;
          const key = `${method}/${dateMode}/${slotMode}/w${w}s${s}p${p}`;
          const clientBlocks = issues.length > 0;
          if (res.ok === clientBlocks) mismatches.push(`${key}: client ${clientBlocks ? "bloque" : "laisse passer"} (${issues.join(",")}) ; serveur ${res.ok ? "accepte" : "refuse (" + res.message.slice(0, 60) + ")"}`);
          if (!res.ok && res.detail.includes("blockers=")) {
            const srv = (res.detail.match(/blockers=([a-z_,]+)/)?.[1] ?? "").split(",").filter(Boolean);
            const common = ["offer_missing", "preparation_missing"];
            for (const b of srv.filter((x) => common.includes(x))) if (!issues.includes(b)) mismatches.push(`${key}: bloqueur serveur ${b} non annoncé par l'éditeur (${issues.join(",")})`);
          }
        }
      }
    }
  }
}
check(`I8 grille de ${grid} configurations : l'éditeur bloque exactement ce que le serveur refuse`, mismatches.length === 0, mismatches.slice(0, 4).join(" | "));
out(`I8-GRID|${grid}|${mismatches.length}`);

wipe(RID_A);
wipe(RID_B);
process.exit(ko === 0 ? 0 : 1);
