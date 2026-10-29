import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "i172-synthetic-service-role-key-DO-NOT-USE";
process.env.SCANYM_PUBLIC_ORIGIN ??= "https://app.scanym.example";
process.env.PAYMENT_RETURN_RELAY_KEY_V1 ??=
  "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4";
process.env.PAYMENT_RETURN_RELAY_ACTIVE_KEY_VERSION ??= "1";

// ====================================================================
// ISSUE #172 — PARCOURS CLIENT « retour après paiement → suivi réutilisable
// → rétractation », de bout en bout sur le SQL RÉEL (PGlite).
//
// Symptôme remonté par Yakout (parcours réel) : après le paiement, le client
// ne retrouve plus l'écran de suivi, donc plus l'option de rétractation qui
// s'y trouve. Cause établie par [172-CAP-1] : le lien legacy
// `/track/<id>#<public_token>` n'est échangeable qu'UNE FOIS.
//
// Ce fichier relie les maillons que les autres tests couvrent séparément :
//   1. la VRAIE page de retour (resolvePaymentReturnStatus) émet, par la VRAIE
//      fonction SQL `issue_order_return_tracking_capability`, le lien `#c1.…` ;
//   2. ce fragment est lu par le VRAI parseTrackingFragment ;
//   3. la capacité obtenue ouvre, à volonté et depuis plusieurs navigateurs,
//      les lignes rétractables (`get_withdrawal_options_by_capability`, la
//      VRAIE fonction extraite du lot ONLINE WITHDRAWAL v1) -- qui alimentent
//      le panneau de rétractation de la page de suivi. (La lecture du suivi
//      par capacité est couverte par [172-CAP-2] ; ici get_order_tracking est
//      un simple prérequis vide.)
//   4. le contrôle négatif : le lien legacy, lui, ne marche qu'une fois.
//
// LIMITES (déclarées, non masquées) : pas de navigateur ni de cookie de
// session ici (rendu du panneau couvert par online-withdrawal-tracking-v1-dom
// .test.ts) ; schéma de commande minimal et synthétique ; aucune base
// hébergée, aucun paiement, e-mail ou réseau réel.
// ====================================================================

const sql = (name: string) => readFileSync(`supabase/${name}`, "utf8").replaceAll("\r\n", "\n");
const V31 = "DRAFT-lot-customer-tracking-capability-v3-1.sql";
const RETURN_LOT = "DRAFT-lot-return-tracking-capability-v1.sql";
const WITHDRAWAL = sql("DRAFT-lot-online-withdrawal-foundation-v1.sql");
const OPTIONS_FN = WITHDRAWAL.match(/create function public\.get_withdrawal_options_by_capability\([\s\S]*?\n\$\$;/)![0];

const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
const { createReturnRelayToken } = await import("../lib/server/payment-return-relay.ts");
const { resolvePaymentReturnStatus } = await import("../app/checkout/return/shared.ts");
const { parseTrackingFragment } = await import("../lib/tracking/link.ts");

function forbidNetwork(t: any) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("NETWORK_FORBIDDEN_IN_172_TESTS");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
}

async function makeDb(applyReturnLot = true) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    grant usage on schema public to anon, authenticated, service_role;
    create table public.orders (
      id uuid primary key default gen_random_uuid(),
      public_token uuid not null default gen_random_uuid(),
      total numeric not null default 10, currency text not null default 'EUR',
      status text not null default 'new', service_mode text not null default 'pickup',
      order_number bigint not null default 1,
      created_at timestamptz not null default now(),
      accepted_at timestamptz, preparing_at timestamptz, ready_at timestamptz,
      completed_at timestamptz, rejected_at timestamptz, cancelled_at timestamptz
    );
    create table public.order_invoice_request (order_id uuid);
    create function public.get_order_tracking(p_order_id uuid, p_public_token uuid)
    returns table (a text, b text, c text, d text, e text, f text, g text, h text, i text, j text, k text, l text, m text)
    language sql as $$ select null::text, null::text, null::text, null::text, null::text, null::text,
      null::text, null::text, null::text, null::text, null::text, null::text, null::text where false $$;
  `);
  await db.exec(sql(V31));
  if (applyReturnLot) await db.exec(sql(RETURN_LOT));
  // Tables minimales dont dépend la VRAIE fonction de lecture des lignes rétractables.
  await db.exec(`
    create table public.order_items (
      id uuid primary key default gen_random_uuid(),
      order_id uuid not null references public.orders(id),
      item_name text not null,
      option_name text,
      quantity integer not null,
      withdrawal_eligible_at_order_time boolean
    );
    create table public.withdrawal_requests (id uuid primary key default gen_random_uuid(), status text not null default 'recorded');
    create table public.withdrawal_request_items (
      id uuid primary key default gen_random_uuid(),
      withdrawal_request_id uuid not null references public.withdrawal_requests(id),
      order_item_id uuid not null references public.order_items(id),
      quantity integer not null
    );
  `);
  await db.exec(OPTIONS_FN);
  await db.exec(`revoke all on function public.get_withdrawal_options_by_capability(uuid, uuid, text) from public;
                 grant execute on function public.get_withdrawal_options_by_capability(uuid, uuid, text) to anon, authenticated;`);
  return db;
}

async function newOrder(db: PGlite, lines: Array<{ name: string; qty: number; eligible: boolean | null }>) {
  const o = await db.query<{ id: string; public_token: string }>("insert into public.orders default values returning id, public_token");
  const orderId = o.rows[0]!.id;
  for (const l of lines) {
    await db.query(
      "insert into public.order_items (order_id, item_name, quantity, withdrawal_eligible_at_order_time) values ($1::uuid, $2, $3, $4)",
      [orderId, l.name, l.qty, l.eligible]
    );
  }
  return { orderId, publicToken: o.rows[0]!.public_token };
}

/** Faux serveur Supabase : statut de paiement simulé ; émission de capacité = VRAIE fonction SQL (PGlite). */
function installRpc(t: any, db: PGlite, paymentStatus: string) {
  const calls: string[] = [];
  t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
    calls.push(name);
    if (name === "get_order_payment_status_snapshot") {
      return {
        data: [{ payment_status: paymentStatus, provider_code: "monetico", has_observed_refusal: false, last_refusal_at: null }],
        error: null,
      };
    }
    if (name === "issue_order_return_tracking_capability") {
      try {
        const r = await db.query("select * from public.issue_order_return_tracking_capability($1::uuid)", [args.p_order_id]);
        return { data: r.rows, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    }
    throw new Error(`RPC inattendue : ${name}`);
  });
  return calls;
}

const relayFor = (orderId: string, publicToken: string) => createReturnRelayToken({ orderId, publicToken, ttlSeconds: 600 });
type WithdrawalOption = {
  bound_order_id: string;
  order_number: number;
  order_item_id: string;
  item_name: string;
  option_name: string | null;
  ordered_quantity: number;
  already_requested: number;
  remaining_quantity: number;
};
const options = async (db: PGlite, orderId: string, capId: string, secret: string) =>
  (await db.query<WithdrawalOption>("select * from public.get_withdrawal_options_by_capability($1::uuid, $2::uuid, $3)", [orderId, capId, secret])).rows;

async function followReturnLink(db: PGlite, orderId: string, publicToken: string) {
  const status = await resolvePaymentReturnStatus({ orderId, token: relayFor(orderId, publicToken) });
  assert.notEqual(status.kind, "unavailable");
  const trackingPath = (status as { trackingPath: string }).trackingPath;
  const [pathname, fragment] = trackingPath.split("#") as [string, string];
  assert.equal(pathname, `/track/${orderId}`);
  const parsed = parseTrackingFragment(fragment);
  assert.notEqual(parsed, null, "le fragment du lien de retour est reconnu par le parseur du suivi");
  return { status, trackingPath, fragment: parsed! };
}

test("[172-JOURNEY-1] retour après paiement : lien réutilisable -> lignes rétractables accessibles à volonté (plusieurs navigateurs), même si le lien legacy a déjà été consommé", async (t) => {
  forbidNetwork(t);
  const db = await makeDb();
  const { orderId, publicToken } = await newOrder(db, [
    { name: "Fromage affiné", qty: 2, eligible: true },
    { name: "Plateau à emporter", qty: 1, eligible: false },
    { name: "Ligne historique", qty: 1, eligible: null },
  ]);
  installRpc(t, db, "paid");

  // Avant le paiement : le client avait déjà ouvert le suivi avec le lien legacy (usage unique).
  const legacy1 = (await db.query("select * from public.upgrade_legacy_tracking_capability($1::uuid, $2::uuid)", [orderId, publicToken])).rows;
  assert.equal(legacy1.length, 1, "premier échange legacy : accepté");

  // Retour de la banque.
  const { status, fragment, trackingPath } = await followReturnLink(db, orderId, publicToken);
  assert.equal(status.kind, "paid");
  assert.equal(trackingPath.includes(publicToken), false, "le jeton legacy n'est plus exposé");
  assert.equal(fragment.kind, "capability");
  const { capabilityId, secret } = fragment as { kind: "capability"; capabilityId: string; secret: string };

  // Cause du symptôme (contrôle négatif) : le lien legacy ne marche plus.
  const legacy2 = (await db.query("select * from public.upgrade_legacy_tracking_capability($1::uuid, $2::uuid)", [orderId, publicToken])).rows;
  assert.equal(legacy2.length, 0, "second échange legacy : refusé -- c'est le « lien invalide » vécu par le client");

  // Le lien de retour, lui, ouvre la rétractation, plusieurs fois (autre navigateur, rechargement, autre appareil).
  for (let browser = 1; browser <= 3; browser++) {
    const opts = await options(db, orderId, capabilityId, secret);
    assert.equal(opts.length, 1, `navigateur ${browser} : exactement la ligne éligible est proposée`);
    assert.equal(opts[0].item_name, "Fromage affiné");
    assert.equal(opts[0].remaining_quantity, 2);
    assert.equal(opts[0].bound_order_id, orderId);
  }
});

test("[172-JOURNEY-2] commande NON éligible : aucune ligne rétractable -> pas de panneau (jamais proposé à tort) ; ligne déjà entièrement déclarée : plus proposée", async (t) => {
  forbidNetwork(t);
  const db = await makeDb();
  const none = await newOrder(db, [{ name: "Boisson", qty: 1, eligible: false }, { name: "Historique", qty: 1, eligible: null }]);
  installRpc(t, db, "paid");
  const a = await followReturnLink(db, none.orderId, none.publicToken);
  assert.equal(a.fragment.kind, "capability", "précondition : lien réutilisable émis");
  const capA = a.fragment as { capabilityId: string; secret: string };
  assert.deepEqual(await options(db, none.orderId, capA.capabilityId, capA.secret), [], "aucune ligne éligible : rien à proposer");

  const eligible = await newOrder(db, [{ name: "Fromage", qty: 1, eligible: true }]);
  const b = await followReturnLink(db, eligible.orderId, eligible.publicToken);
  const capB = b.fragment as { capabilityId: string; secret: string };
  assert.equal((await options(db, eligible.orderId, capB.capabilityId, capB.secret)).length, 1);
  const wr = await db.query<{ id: string }>("insert into public.withdrawal_requests default values returning id");
  const item = await db.query<{ id: string }>("select id from public.order_items where order_id = $1::uuid", [eligible.orderId]);
  await db.query("insert into public.withdrawal_request_items (withdrawal_request_id, order_item_id, quantity) values ($1::uuid, $2::uuid, 1)", [wr.rows[0]!.id, item.rows[0]!.id]);
  assert.deepEqual(await options(db, eligible.orderId, capB.capabilityId, capB.secret), [], "déjà déclarée en totalité : plus proposée");
});

test("[172-JOURNEY-3] la capacité d'une AUTRE commande n'ouvre ni le suivi ni la rétractation (liaison commande + secret)", async (t) => {
  forbidNetwork(t);
  const db = await makeDb();
  const one = await newOrder(db, [{ name: "A", qty: 1, eligible: true }]);
  const two = await newOrder(db, [{ name: "B", qty: 1, eligible: true }]);
  installRpc(t, db, "paid");
  const link = await followReturnLink(db, one.orderId, one.publicToken);
  assert.equal(link.fragment.kind, "capability", "précondition : lien réutilisable émis");
  const f = link.fragment as { capabilityId: string; secret: string };
  assert.equal((await options(db, one.orderId, f.capabilityId, f.secret)).length, 1, "contrôle positif : la capacité ouvre SA commande");
  assert.deepEqual(await options(db, two.orderId, f.capabilityId, f.secret), [], "autre commande");
  assert.deepEqual(await options(db, one.orderId, f.capabilityId, "00".repeat(32)), [], "mauvais secret");
});

test("[172-JOURNEY-4] statuts du retour : pending / required / not_required portent le lien réutilisable ; refus ou annulation : lien legacy, jamais de capacité réutilisable", async (t) => {
  forbidNetwork(t);
  for (const paymentStatus of ["pending", "required", "not_required"]) {
    const db = await makeDb();
    const o = await newOrder(db, [{ name: "A", qty: 1, eligible: true }]);
    const calls = installRpc(t, db, paymentStatus);
    const r = await followReturnLink(db, o.orderId, o.publicToken);
    assert.equal(r.fragment.kind, "capability", `${paymentStatus} : lien réutilisable`);
    assert.ok(calls.includes("issue_order_return_tracking_capability"));
    t.mock.restoreAll();
  }
  for (const paymentStatus of ["failed", "cancelled"]) {
    const db = await makeDb();
    const o = await newOrder(db, [{ name: "A", qty: 1, eligible: true }]);
    const calls = installRpc(t, db, paymentStatus);
    const r = await followReturnLink(db, o.orderId, o.publicToken);
    assert.equal(r.status.kind, "failed_or_cancelled");
    assert.equal(r.fragment.kind, "legacy", `${paymentStatus} : lien legacy`);
    assert.equal(calls.includes("issue_order_return_tracking_capability"), false, `${paymentStatus} : aucune capacité émise`);
    t.mock.restoreAll();
  }
});

test("[172-JOURNEY-5] DÉPENDANCE DE DÉPLOIEMENT : tant que le lot SQL « return » n'est pas appliqué, la page de retour retombe sur le lien legacy (à usage unique) -- le correctif du symptôme n'est effectif qu'après application du SQL", async (t) => {
  forbidNetwork(t);
  const db = await makeDb(false); // lot return NON appliqué
  const o = await newOrder(db, [{ name: "A", qty: 1, eligible: true }]);
  installRpc(t, db, "paid");
  const r = await followReturnLink(db, o.orderId, o.publicToken);
  assert.equal(r.status.kind, "paid");
  assert.equal(r.fragment.kind, "legacy", "repli legacy : comportement d'avant, symptôme non corrigé sans le SQL");
  assert.ok(r.trackingPath.endsWith(`#${o.publicToken}`));
});
