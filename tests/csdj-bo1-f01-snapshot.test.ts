import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

import {
  type AvailabilityDraft,
  buildSaveFulfillmentConfigurationPayload,
  diffDrafts,
  draftFromAuthoritativeSnapshot,
  draftFromServer,
  isDraftDirty,
  rebaseDraft,
} from "../lib/availability-payload.ts";
import {
  FakeFulfillmentWriteBackend,
  auLaitCruPickupFixture,
} from "./helpers/fake-fulfillment-write-backend.ts";
import { DICTS } from "../lib/i18n.ts";

// ====================================================================
// CSDJ-BO-1 — REMÉDIATION F-01 (audit Cat Greco, #150) : LE SNAPSHOT
// AUTORITAIRE EST INDIVISIBLE.
//
//     { configuration, updatedAt, revision }
//
// Les jetons de concurrence ne valent que pour la configuration qui les
// a produits. Ce fichier tient les propriétés pures de cette règle ; les
// scénarios joués sur l'écran (F01-A interleaving, F01-B STALE puis
// second clic, changement de portée, réponses en désordre, isolation
// multi-établissements) sont dans csdj-bo1-editor-save.dom.test.ts.
// ====================================================================

const REPO_ROOT = process.cwd();

function snapshotOf(backend: FakeFulfillmentWriteBackend, id = "r1", mode = "pickup", rule: string | null = null) {
  const configuration = backend.readConfiguration(id, mode, rule)!;
  return {
    tokens: {
      updatedAt: configuration.updatedAt as string,
      revision: configuration.revision as string,
    },
    configuration,
  };
}

const row = (backend: FakeFulfillmentWriteBackend) => backend.tenant("r1").schedules[0];

test("[BO1-F01-1] le brouillon, sa référence ET les deux jetons sortent d'UNE seule réponse autoritaire", () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  const snapshot = snapshotOf(backend);
  const draft = draftFromAuthoritativeSnapshot(snapshot);

  assert.equal(draft.expectedUpdatedAt, "2026-10-14T00:00:00.123456Z", "microseconde, chaîne verbatim");
  assert.equal(draft.expectedRevision, "a1b2c3d4e5f60718293a4b5c6d7e8f90");
  assert.equal(draft.cutoffTime, "16:00");
  assert.equal(draft.cutoffOffsetDays, "1");
  assert.equal(draft.method, "v1");
  assert.equal(draft.slots.length, 10);
  assert.equal(draft.closures[0].label, "Noël");
  // Le brouillon issu du snapshot, renvoyé sans modification, est le
  // même état que le serveur : aucune différence, aucune dérive.
  assert.equal(isDraftDirty(draft, draftFromAuthoritativeSnapshot(snapshot)), false);
  // Et la charge d'écriture de ce brouillon porte les jetons de CE snapshot.
  const payload = buildSaveFulfillmentConfigurationPayload(draft);
  assert.equal(payload.expectedUpdatedAt, snapshot.tokens.updatedAt);
  assert.equal(payload.expectedRevision, snapshot.tokens.revision);
});

test("[BO1-F01-2] le contenu vient du SNAPSHOT, jamais des listes : A (listes) + B (autorité) donne B", () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  // 1. Les lectures de listes rendent A.
  const listsA = row(backend);
  const fromLists = draftFromServer({
    modeCode: "pickup",
    fulfillmentRuleId: null,
    schedule: JSON.parse(JSON.stringify(listsA)),
    updatedAt: null,
    revision: null,
  });
  // 2. Un tiers produit B.
  row(backend).cutoffTime = "18:00:00";
  row(backend).minLeadDays = 3;
  row(backend).updatedAt = "2026-10-14T08:30:00.999999Z";
  row(backend).revision = "ffffffffffffffffffffffffffffffff";
  // 3. L'autorité rend B.
  const fromAuthority = draftFromAuthoritativeSnapshot(snapshotOf(backend));

  assert.equal(fromLists.cutoffTime, "16:00", "les listes disent A");
  assert.equal(fromAuthority.cutoffTime, "18:00", "l'autorité dit B");
  assert.equal(fromAuthority.minLeadDays, "3");
  assert.equal(fromAuthority.expectedRevision, "ffffffffffffffffffffffffffffffff");
  // Le défaut démontré par l'audit : coller les jetons de B sur le contenu
  // de A. Ce montage-là doit être IMPOSSIBLE à produire par les fonctions
  // du lot : la seule source de jetons est le snapshot, qui porte aussi
  // son contenu.
  const forged: AvailabilityDraft = {
    ...fromLists,
    expectedUpdatedAt: fromAuthority.expectedUpdatedAt,
    expectedRevision: fromAuthority.expectedRevision,
  };
  // Le serveur de référence l'accepterait -- c'est le trou -- ...
  const naive = new FakeFulfillmentWriteBackend();
  naive.setTenant("r1", auLaitCruPickupFixture());
  row(naive).cutoffTime = "18:00:00";
  row(naive).minLeadDays = 3;
  row(naive).updatedAt = "2026-10-14T08:30:00.999999Z";
  row(naive).revision = "ffffffffffffffffffffffffffffffff";
  naive.save("r1", buildSaveFulfillmentConfigurationPayload(forged));
  assert.equal(row(naive).cutoffTime, "16:00:00", "… et B serait ÉCRASÉ par A : voilà le défaut");
  assert.equal(row(naive).minLeadDays, 1, "(y compris le délai du tiers, ramené de 3 à la valeur de A)");
  // ... tandis que le brouillon issu du snapshot ne peut pas le faire.
  const safe = new FakeFulfillmentWriteBackend();
  safe.setTenant("r1", auLaitCruPickupFixture());
  row(safe).cutoffTime = "18:00:00";
  row(safe).minLeadDays = 3;
  row(safe).updatedAt = "2026-10-14T08:30:00.999999Z";
  row(safe).revision = "ffffffffffffffffffffffffffffffff";
  safe.save("r1", buildSaveFulfillmentConfigurationPayload(fromAuthority));
  assert.equal(row(safe).cutoffTime, "18:00:00", "B est conservé");
  assert.equal(row(safe).minLeadDays, 3);
});

test("[BO1-F01-3] snapshot v1.2 : les trois sections viennent du snapshot, et le décalage v1 n'existe pas", () => {
  const backend = new FakeFulfillmentWriteBackend();
  const fixture = auLaitCruPickupFixture();
  fixture.v12 = [
    {
      modeCode: "pickup",
      fulfillmentRuleId: null,
      scheduleMethodVersion: "v1.2",
      holidayCalendarId: "cal-1",
      preparationOnHolidays: "closed",
      availabilityOnHolidays: "open",
      capacityEnabled: true,
      capacityMaxOrders: 12,
      preparationWeekdays: [4, 2, 3],
      preparationClosures: [{ closedOn: "2026-11-01", label: null }],
    },
  ];
  backend.setTenant("r1", fixture);
  const draft = draftFromAuthoritativeSnapshot(snapshotOf(backend));
  assert.equal(draft.method, "v1.2");
  assert.deepEqual(draft.preparationWeekdays, [2, 3, 4]);
  assert.equal(draft.holidayCalendarId, "cal-1");
  assert.equal(draft.preparationOnHolidays, "closed");
  assert.equal(draft.capacityEnabled, true);
  assert.equal(draft.capacityMaxOrders, "12");
  assert.equal(draft.preparationClosures[0].label, "");
  const payload = buildSaveFulfillmentConfigurationPayload(draft);
  assert.ok(!("cutoffOffsetDays" in (payload.policy as Record<string, unknown>)));
});

test("[BO1-F01-4] un snapshot mal formé est refusé par son nom, jamais complété par un défaut", () => {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  const good = snapshotOf(backend);
  const cases: Array<[string, Parameters<typeof draftFromAuthoritativeSnapshot>[0]]> = [
    ["policy absente", { ...good, configuration: { ...good.configuration, policy: undefined } }],
    ["liste absente", { ...good, configuration: { ...good.configuration, slots: undefined } }],
    ["méthode inconnue", { ...good, configuration: { ...good.configuration, method: "v9" } }],
    ["mode absent", { ...good, configuration: { ...good.configuration, modeCode: undefined } }],
    [
      "v1.2 sans ses sections",
      { ...good, configuration: { ...good.configuration, method: "v1.2" } },
    ],
    ["jetons absents", { ...good, tokens: undefined as unknown as typeof good.tokens }],
  ];
  for (const [label, input] of cases) {
    assert.throws(
      () => draftFromAuthoritativeSnapshot(input),
      /CSDJBO1_UNEXPECTED_CONFIGURATION_SHAPE/,
      label
    );
  }
});

// --------------------------------------------------------------------
// Conflit : divergences et rebase
// --------------------------------------------------------------------

function trio() {
  const backend = new FakeFulfillmentWriteBackend();
  backend.setTenant("r1", auLaitCruPickupFixture());
  const base = draftFromAuthoritativeSnapshot(snapshotOf(backend));
  const mine: AvailabilityDraft = { ...base, cutoffTime: "19:00", bookingHorizonDays: "21" };
  row(backend).cutoffTime = "18:00:00";
  row(backend).minLeadDays = 3;
  row(backend).updatedAt = "2026-10-14T08:30:00.999999Z";
  row(backend).revision = "ffffffffffffffffffffffffffffffff";
  row(backend).slots = [
    ...row(backend).slots,
    { weekday: 1, slotKey: "ajout", startsAt: "09:00", endsAt: "10:00" },
  ];
  const theirs = draftFromAuthoritativeSnapshot(snapshotOf(backend));
  return { base, mine, theirs };
}

test("[BO1-F01-5] les divergences sont nommées champ par champ, avec leur origine", () => {
  const { base, mine, theirs } = trio();
  const origins = Object.fromEntries(diffDrafts(base, mine, theirs).map((d) => [d.field, d.origin]));
  assert.deepEqual(origins, {
    cutoffTime: "both",
    bookingHorizonDays: "mine",
    minLeadDays: "theirs",
    slots: "theirs",
  });
  // Rien ne diverge entre deux versions identiques, jetons mis à part.
  assert.deepEqual(diffDrafts(base, base, { ...base, expectedRevision: "0".repeat(32) }), []);
});

test("[BO1-F01-6] le rebase garde MES changements, laisse survivre ceux du tiers, et prend les jetons du serveur", () => {
  const { base, mine, theirs } = trio();
  const next = rebaseDraft(base, mine, theirs);
  assert.equal(next.cutoffTime, "19:00", "mon choix explicite (même en conflit)");
  assert.equal(next.bookingHorizonDays, "21", "mon changement");
  assert.equal(next.minLeadDays, "3", "le changement du tiers survit");
  assert.equal(next.slots.length, 11, "la liste que je n'ai pas touchée vient du serveur");
  assert.equal(next.expectedUpdatedAt, "2026-10-14T08:30:00.999999Z", "jetons du serveur, microseconde comprise");
  assert.equal(next.expectedRevision, "ffffffffffffffffffffffffffffffff");
  // Ni `mine` ni `theirs` ne sont modifiés : rien n'est partagé par référence.
  assert.equal(mine.expectedRevision, "a1b2c3d4e5f60718293a4b5c6d7e8f90");
  next.slots[0].slotKey = "mutation";
  assert.notEqual(theirs.slots[0].slotKey, "mutation");
});

test("[BO1-F01-7] sans aucune modification de ma part, le rebase est exactement la version du serveur", () => {
  const { base, theirs } = trio();
  const next = rebaseDraft(base, { ...base }, theirs);
  assert.equal(isDraftDirty(next, theirs), false);
  assert.equal(next.expectedRevision, theirs.expectedRevision);
});

// --------------------------------------------------------------------
// Garde structurelle : plus aucun collage de jetons dans la page
// --------------------------------------------------------------------

test("[BO1-F01-8] la page n'a plus d'état « jetons » à part, ni d'injection de jetons à l'enregistrement", () => {
  const page = readFileSync(path.join(REPO_ROOT, "app", "dashboard", "availability", "page.tsx"), "utf8");
  const code = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/tokensInScope|setTokens|tokenScopeKey/.test(code), "aucun état de jetons séparé du brouillon");
  assert.ok(
    !/expectedUpdatedAt\s*:/.test(code) && !/expectedRevision\s*:/.test(code),
    "la page n'écrit jamais un jeton : il arrive avec le snapshot"
  );
  // Les listes servent au repli en LECTURE SEULE uniquement : tout
  // `draftFromServer(` de la page passe `updatedAt: null` et `revision: null`.
  const calls = [...code.matchAll(/draftFromServer\(\{[\s\S]*?\}\)/g)].map((m) => m[0]);
  assert.ok(calls.length >= 1);
  for (const call of calls) {
    assert.ok(/updatedAt:\s*null/.test(call) && /revision:\s*null/.test(call), call);
  }
  // L'enregistrement n'est ouvert qu'à un snapshot autoritaire, sans conflit.
  assert.ok(/snapshotAuthoritative/.test(code) && /conflictInScope === null/.test(code));
  // Et il n'existe toujours qu'UN appel d'écriture.
  assert.equal((code.match(/saveFulfillmentConfiguration\(/g) ?? []).length, 1);
});

test("[BO1-F01-9] le texte de la relecture ne promet plus qu'un second clic suffit, dans les quatre langues", () => {
  for (const lang of ["fr", "en", "ar", "nl"] as const) {
    const dict = DICTS[lang] as Record<string, string>;
    for (const key of [
      "avSaveStaleReloaded", "avConflictTitle", "avConflictIntro", "avConflictKeepMine",
      "avConflictTakeServer", "avConflictUnreadable", "avConflictRetry", "avConflictRebasedNote",
      "avConflictBlocksSave", "avSaveNeedsAuthority", "avConflictColMine", "avConflictColServer",
      "avConflictOriginMine", "avConflictOriginTheirs", "avConflictOriginBoth",
      "avConflictFieldWindows", "avConflictFieldSlots", "avConflictFieldClosures",
      "avConflictFieldPrepClosures", "avConflictValueOn", "avConflictValueOff",
      "avConflictValueEmpty", "avConflictListCount", "avConflictNoDifference", "avConflictKeepMineHint",
    ]) {
      assert.ok(dict[key] && dict[key].trim().length > 1, `${lang}/${key} manque`);
      assert.ok(!/SQLSTATE|CSDJ|public\./.test(dict[key]), `${lang}/${key} : rien de technique`);
    }
  }
  const fr = DICTS.fr as Record<string, string>;
  assert.ok(!/enregistrez à nouveau/i.test(fr.avSaveStaleReloaded), "l'ancien texte invitait à rejouer sans résoudre");
});
