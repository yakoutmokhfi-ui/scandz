import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 — chemin MARCHAND (dashboard)
// des surcharges de texte de suivi.
//
// L'autorité d'autorisation est SQL (set_merchant_tracking_status_text,
// SECURITY DEFINER, owner/manager -- prouvée par
// tests/cfte-v1-sql-structural.test.ts et par le harnais SQL). Ce
// fichier prouve le CONTRAT CLIENT autour d'elle :
//   - l'écriture passe EXCLUSIVEMENT par la RPC (jamais un insert/update
//     direct de table, que la RLS refuserait de toute façon) ;
//   - un statut non canonique est refusé AVANT tout appel réseau ;
//   - une valeur vidée est bien transmise comme un EFFACEMENT ;
//   - la lecture assainit par l'unique autorité partagée.
// ====================================================================

const { supabase } = await import("../lib/supabase.ts");
const {
  getMerchantTrackingStatusText,
  setMerchantTrackingStatusText,
  setAllMerchantTrackingStatusText,
} = await import("../lib/services/tracking-status-text.ts");
const { CANONICAL_ORDER_STATUSES } = await import("../lib/tracking/status.ts");
const { MERCHANT_STATUS_TEXT_MAX_LENGTH } = await import("../lib/tracking/status-text.ts");

const RESTAURANT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/** Faux `from(...).select(...).eq(...)` minimal, thenable comme postgrest. */
function installSelect(t: any, rows: unknown, error: unknown = null) {
  const seen: { table?: string; columns?: string; filter?: [string, string] } = {};
  t.mock.method(supabase, "from", (table: string) => {
    seen.table = table;
    return {
      select(columns: string) {
        seen.columns = columns;
        return {
          eq(column: string, value: string) {
            seen.filter = [column, value];
            return Promise.resolve({ data: rows, error });
          },
        };
      },
    };
  });
  return seen;
}

function installRpc(t: any, error: unknown = null) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  t.mock.method(supabase, "rpc", async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return { data: null, error };
  });
  return calls;
}

// --------------------------------------------------------------------
// 1. Lecture tenant.
// --------------------------------------------------------------------

test("1a. la lecture interroge la table tenant, filtrée sur le restaurant, et assainit le résultat", async (t) => {
  const seen = installSelect(t, [
    { status: "preparing", body: "  Texte utile.  " },
    { status: "ready", body: "   " },
    { status: "out_for_delivery", body: "jamais affiché" },
    { status: "accepted", body: "x".repeat(MERCHANT_STATUS_TEXT_MAX_LENGTH + 1) },
  ]);

  const overrides = await getMerchantTrackingStatusText(RESTAURANT_ID);

  assert.equal(seen.table, "merchant_tracking_status_text");
  assert.deepEqual(seen.filter, ["restaurant_id", RESTAURANT_ID]);
  // Seule la surcharge réellement affichable survit.
  assert.deepEqual(Object.keys(overrides), ["preparing"]);
  assert.equal(overrides.preparing, "Texte utile.");
});

test("1b. aucun établissement configuré -> objet vide, jamais une exception", async (t) => {
  installSelect(t, []);
  assert.deepEqual(await getMerchantTrackingStatusText(RESTAURANT_ID), {});
});

test("1c. une erreur de lecture est propagée explicitement (jamais confondue avec « aucune surcharge »)", async (t) => {
  installSelect(t, null, { message: "permission denied" });
  await assert.rejects(() => getMerchantTrackingStatusText(RESTAURANT_ID), /permission denied/);
});

// --------------------------------------------------------------------
// 2. Écriture : RPC uniquement.
// --------------------------------------------------------------------

test("2a. l'écriture passe par set_merchant_tracking_status_text, jamais par la table", async (t) => {
  const fromCalls: string[] = [];
  t.mock.method(supabase, "from", (table: string) => {
    fromCalls.push(table);
    throw new Error("écriture directe de table interdite");
  });
  const calls = installRpc(t);

  await setMerchantTrackingStatusText(RESTAURANT_ID, "ready", "Votre commande vous attend.");

  assert.deepEqual(fromCalls, [], "aucune écriture directe de table");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "set_merchant_tracking_status_text");
  assert.deepEqual(calls[0].args, {
    p_restaurant_id: RESTAURANT_ID,
    p_status: "ready",
    p_body: "Votre commande vous attend.",
  });
});

test("2b. un statut NON canonique est refusé AVANT tout appel réseau", async (t) => {
  const calls = installRpc(t);
  await assert.rejects(
    () =>
      setMerchantTrackingStatusText(
        RESTAURANT_ID,
        "out_for_delivery" as never,
        "Votre commande est en route"
      ),
    /SCANYM_UNKNOWN_ORDER_STATUS/
  );
  assert.deepEqual(calls, [], "aucun appel réseau pour un statut inexistant");
});

test("2c. une valeur vidée est transmise telle quelle -- le SQL l'interprète comme un EFFACEMENT", async (t) => {
  const calls = installRpc(t);
  await setMerchantTrackingStatusText(RESTAURANT_ID, "preparing", "   ");
  assert.equal(calls[0].args.p_body, "   ");
});

test("2d. l'enregistrement global couvre EXACTEMENT les 7 statuts canoniques, dans l'ordre", async (t) => {
  const calls = installRpc(t);
  await setAllMerchantTrackingStatusText(RESTAURANT_ID, { ready: "Prête !" });

  assert.deepEqual(
    calls.map((c) => c.args.p_status),
    [...CANONICAL_ORDER_STATUSES]
  );
  // Un statut non fourni est envoyé VIDE -> effacement -> repli base.
  const ready = calls.find((c) => c.args.p_status === "ready")!;
  assert.equal(ready.args.p_body, "Prête !");
  for (const c of calls) {
    if (c.args.p_status !== "ready") assert.equal(c.args.p_body, "");
  }
});

test("2e. un refus serveur interrompt la séquence (jamais un enregistrement partiel silencieux)", async (t) => {
  let n = 0;
  t.mock.method(supabase, "rpc", async () => {
    n += 1;
    return n === 1 ? { data: null, error: null } : { data: null, error: { message: "Forbidden" } };
  });
  await assert.rejects(
    () => setAllMerchantTrackingStatusText(RESTAURANT_ID, {}),
    /Forbidden/
  );
  assert.equal(n, 2, "la séquence doit s'arrêter au premier refus");
});

// --------------------------------------------------------------------
// 3. Câblage du dashboard (preuve secondaire ; l'autorité reste SQL).
// --------------------------------------------------------------------

test("3. la page Réglages écrit par la RPC, dans le bloc owner/manager, et dérive sa grille des 7 statuts canoniques", () => {
  const src = readFileSync("app/dashboard/settings/page.tsx", "utf8");

  assert.ok(src.includes("setAllMerchantTrackingStatusText(restaurantId, statusTexts)"));
  assert.ok(src.includes("getMerchantTrackingStatusText(id)"));
  // Aucune liste de statuts recopiée : la grille itère l'autorité.
  assert.ok(src.includes("CANONICAL_ORDER_STATUSES.map((status)"));
  assert.equal(
    /"(new|accepted|preparing|ready|completed|rejected|cancelled)"\s*,\s*"(new|accepted|preparing|ready)/.test(src),
    false,
    "aucune liste de statuts codée en dur dans la page"
  );
  // La section n'est jamais rendue en mode opérateur seul, et les
  // champs sont désactivés sans droit d'édition.
  const sectionStart = src.indexOf('data-settings-tracking-status-text=""');
  assert.ok(sectionStart > -1, "section de configuration absente");
  const guard = src.lastIndexOf("{!isOperatorOnlyMode && (", sectionStart);
  assert.ok(guard > -1 && guard < sectionStart, "la section doit être gardée par !isOperatorOnlyMode");
  assert.ok(
    src.slice(sectionStart, sectionStart + 2000).includes("disabled={!canEdit}"),
    "les champs doivent être désactivés sans droit d'édition"
  );
});
