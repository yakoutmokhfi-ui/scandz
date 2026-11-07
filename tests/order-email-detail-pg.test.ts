import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPsqlRunner, parseLocalPgUrl } from "./helpers/pg-local-guard.ts";

// ====================================================================
// ISSUE #211 — LOT SQL « ORDER EMAIL DETAIL v1 » SUR UN VRAI POSTGRESQL (psql réel, cluster local jetable).
//
// Ce que ce fichier PROUVE :
//   S.  (sans PostgreSQL) structure du lot et du rollback : empreintes épinglées = empreintes des corps embarqués,
//       aucun objet de porte/époque/bail/claim touché, aucune suppression, ordre de persistance de create_order.
//   P.  ordre de persistance RÉEL : orders -> order_items -> planning dans UNE transaction ; le déclencheur différé
//       de #205 (DDL réel extrait du lot) voit donc les lignes ET le planning ; la reprise #205 aussi.
//   N.  snapshot : lignes/options/quantités/prix HISTORIQUES (produit renommé/repricé/supprimé après coup), montants,
//       jour/créneau persistés (fenêtre, heure libre, jour seul, table), jamais la clé interne de créneau.
//   L.  locale nl conservée (et contrôle négatif : le prédécesseur la perdait) ; compatibilité ascendante exacte.
//   F.  pré-vol : refus AVANT toute écriture (ON_ERROR_STOP=1 et =0) pour chaque dérive ; double application refusée.
//   R.  rollback : restaure l'état d'avant OCTET POUR OCTET, refuse toute dérive et toute ligne nl, ne supprime rien.
//
// Opt-in : sans SCANYM_TEST_PG_ADMIN_URL les tests PG sont SAUTÉS avec leur raison. Boucle locale uniquement ; bases
// `scanym_t211_*` jetables ; données 100 % synthétiques ; aucun hébergé.
//   SCANYM_TEST_PG_ADMIN_URL  ex. postgresql://postgres@127.0.0.1:55432/postgres
// ====================================================================

const ADMIN_URL = process.env.SCANYM_TEST_PG_ADMIN_URL;
const PSQL = process.env.SCANYM_TEST_PSQL || "psql";
const SKIP: string | false = ADMIN_URL
  ? false
  : "SCANYM_TEST_PG_ADMIN_URL absent : la preuve sur PostgreSQL RÉEL n'est PAS rejouée ici";

const sql = (name: string) => readFileSync(`supabase/${name}`, "utf8").replaceAll("\r\n", "\n");
const N1A = sql("DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql");
const MCC = sql("DRAFT-lot-merchant-customer-communications-v1.sql");
const T205 = sql("DRAFT-lot-order-received-enqueue-recovery-v1.sql");
const REC = sql("DRAFT-lot-order-email-recovery-worker-v1.sql");
const LOT = sql("DRAFT-lot-order-email-detail-v1.sql");
const RB = sql("DRAFT-lot-order-email-detail-v1-rollback.sql");
const HOSTED_CREATE_ORDER = sql("../tests/fixtures/create-order-hosted-5ed0f3e2.sql");

const N1A_TABLE = N1A.match(/create table public\.notification_outbox \([\s\S]*?\n\);/)![0];
// Prédécesseur RÉEL : la définition posée par MERCHANT CUSTOMER COMMUNICATIONS v1 (fonction + commentaire + droits).
const PRED_FN = MCC.match(
  /create or replace function public\.create_order_received_notification\([\s\S]*?grant execute on function public\.create_order_received_notification\(uuid, uuid\) to service_role;/
)![0];
// Déclencheur différé RÉEL de #205.
const TRG_205 = T205.match(
  /create function public\.tg_orders_enqueue_order_received\(\)[\s\S]*?execute function public\.tg_orders_enqueue_order_received\(\);/
)![0];
// Reprise RÉELLE de #205 (frontière, époque, échecs, fonction de reprise).
const RECOVERY = REC.match(
  /create table public\.order_email_recovery_boundary[\s\S]*?grant execute on function public\.recover_new_order_received_notifications\(integer\) to service_role;/
)![0];

const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const bodyOf = (fnSql: string) => {
  const i = fnSql.indexOf("as $$") + "as $$".length;
  return fnSql.slice(i, fnSql.indexOf("end $$;", i) + "end ".length);
};

// --------------------------------------------------------------------
// S. Structure (sans PostgreSQL)
// --------------------------------------------------------------------

test("[211-S1] empreintes épinglées = empreintes des corps embarqués (lot et rollback), LF et CRLF", () => {
  const newBody = bodyOf(LOT.slice(LOT.indexOf("create or replace function public.create_order_received_notification(")));
  const predBody = bodyOf(PRED_FN);
  const crlf = (s: string) => s.replaceAll("\n", "\r\n");
  for (const [text, label] of [[LOT, "lot"], [RB, "rollback"]] as const) {
    assert.ok(text.includes(`'${md5(newBody)}'`), `${label}: md5 du nouveau corps`);
    assert.ok(text.includes(`'${md5(crlf(newBody))}'`), `${label}: md5 CRLF du nouveau corps`);
    assert.ok(text.includes(`'${md5(predBody)}'`), `${label}: md5 du prédécesseur`);
    assert.ok(text.includes(`'${md5(crlf(predBody))}'`), `${label}: md5 CRLF du prédécesseur`);
  }
  // Le rollback embarque le prédécesseur OCTET POUR OCTET.
  assert.equal(bodyOf(RB.slice(RB.indexOf("create or replace function public.create_order_received_notification("))), predBody);
});

test("[211-S2] le lot ne touche ni porte, ni époque, ni bail, ni claim, ni create_order, ni déclencheur ; il ne supprime rien ; seul droit accordé : service_role", () => {
  for (const [text, label] of [[LOT, "lot"], [RB, "rollback"]] as const) {
    // Hors corps de la fonction d'enfilement (qui, comme son prédécesseur, lit le profil et insère dans la file).
    const noComments = text.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    const outside = noComments.replace(/create or replace function public\.create_order_received_notification\([\s\S]*?end \$\$;/, "");
    assert.ok(outside.length < noComments.length, `${label}: corps retiré`);
    assert.equal(/create (or replace )?function public\.(claim_|notification_send_gate_open|create_order\b|recover_|tg_orders_|capture_order_email)/.test(noComments), false, label);
    assert.equal(/\b(delete from|truncate|drop table|drop function|drop trigger|update public\.|insert into public\.)/i.test(outside), false, `${label}: aucune écriture de données hors fonction`);
    assert.equal(/merchant_notification_profile|default_locale/.test(outside), false, `${label}: le réglage de langue du marchand n'est pas touché`);
    assert.equal(/notification_send_gate|order_email_activation_epoch|order_email_recovery_boundary|lease/i.test(noComments), false, `${label}: portes, époque, frontière, bail intacts`);
    const grants = [...noComments.matchAll(/^\s*grant\b[^;]*;/gim)].map((m) => m[0].trim().replace(/\s+/g, " "));
    assert.deepEqual(grants, ["grant execute on function public.create_order_received_notification(uuid, uuid) to service_role;"], `${label}: seul droit accordé`);
  }
  // Le seul DROP est celui du CHECK de locale (nom lu au catalogue, jamais deviné).
  assert.equal((LOT.match(/drop constraint/g) ?? []).length, 1);
  assert.equal((RB.match(/drop constraint/g) ?? []).length, 1);
});

test("[211-S3] ORDRE DE PERSISTANCE de create_order hébergé : orders -> order_items -> planning -> return ; aucun enfilement dans create_order", () => {
  const iOrders = HOSTED_CREATE_ORDER.indexOf("insert into public.orders (");
  const iItems = HOSTED_CREATE_ORDER.indexOf("insert into public.order_items (");
  const iSched = HOSTED_CREATE_ORDER.indexOf("insert into public.order_fulfillment_schedule_snapshot (");
  const iReturn = HOSTED_CREATE_ORDER.lastIndexOf("return query select v_order_id");
  assert.ok(iOrders > 0 && iOrders < iItems && iItems < iSched && iSched < iReturn, `${iOrders} ${iItems} ${iSched} ${iReturn}`);
  assert.equal(/notification_outbox|create_order_received_notification/.test(HOSTED_CREATE_ORDER), false, "create_order n'enfile rien : c'est le déclencheur différé");
  assert.ok(/deferrable initially deferred/.test(TRG_205), "le déclencheur de #205 est DIFFÉRÉ jusqu'à la fin de la transaction");
  assert.ok(/after insert on public\.orders/.test(TRG_205));
});

// --------------------------------------------------------------------
// Harnais PostgreSQL
// --------------------------------------------------------------------

const workDir = mkdtempSync(path.join(tmpdir(), "scanym-t211-"));
const isolatedHome = mkdtempSync(path.join(tmpdir(), "scanym-t211-home-"));
const runner = createPsqlRunner({ bin: PSQL, baseEnv: process.env, isolatedHome });
const databases: string[] = [];
const ROLES = ["anon", "authenticated", "service_role", "audit_extra"];
const urlFor = (db: string) => { const u = new URL(ADMIN_URL!); u.pathname = `/${db}`; return u.toString(); };

function psqlFile(url: string, name: string, content: string, onErrorStop = true) {
  const file = path.join(workDir, name);
  writeFileSync(file, content);
  const r = runner.run(url, ["-v", `ON_ERROR_STOP=${onErrorStop ? 1 : 0}`, "-f", file]);
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}
function q(url: string, query: string): string {
  const r = runner.run(url, ["-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", query]);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

const FN = "public.create_order_received_notification(uuid, uuid)";

/** Schéma « hébergé » minimal : mêmes tables/colonnes lues par la fonction, DDL réels pour la file, le prédécesseur,
 *  le déclencheur différé et la reprise de #205. Le DDL de order_fulfillment_schedule_snapshot n'est PAS dans le dépôt :
 *  ses colonnes et types sont ceux de l'INSERT de create_order hébergé et de lib/dashboard-types.ts. */
function newDb(opts: { encoding?: "UTF8" | "SQL_ASCII"; extraSql?: string } = {}): string {
  parseLocalPgUrl(ADMIN_URL!);
  const db = `scanym_t211_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = runner.run(ADMIN_URL!, ["-v", "ON_ERROR_STOP=1", "-c", `create database ${db} template template0 encoding '${opts.encoding ?? "UTF8"}' lc_collate 'C' lc_ctype 'C'`]);
  assert.equal(admin.status, 0, admin.stderr);
  databases.push(db);
  const url = urlFor(db);
  const roles = ROLES.map((r) => `do $$ begin create role ${r} nologin; exception when duplicate_object then null; end $$;`).join("\n");
  const setup = psqlFile(url, "setup.sql", `
    ${roles}
    create table public.restaurants (id uuid primary key default gen_random_uuid(), name text not null);
    create table public.menu_items (id uuid primary key default gen_random_uuid(), restaurant_id uuid not null, name text not null, price numeric(12,2) not null, is_available boolean not null default true);
    create table public.orders (
      id uuid primary key default gen_random_uuid(),
      restaurant_id uuid not null references public.restaurants(id),
      order_number bigint not null default 1,
      service_mode text not null default 'pickup',
      customer_email text, customer_language text, delivery_address text,
      subtotal numeric(12,2) not null default 0, delivery_fee numeric(12,2) not null default 0, total numeric(12,2) not null default 0,
      currency text not null default 'EUR', status text not null default 'new',
      public_token uuid not null default gen_random_uuid(),
      created_at timestamptz not null default now(),
      payment_status text not null default 'not_required', payment_mode_final text default 'none',
      order_received_notification_intent_at timestamptz default clock_timestamp()
    );
    create table public.order_items (
      id uuid primary key default gen_random_uuid(),
      order_id uuid not null references public.orders(id) on delete cascade,
      menu_item_id uuid references public.menu_items(id) on delete set null,
      item_name text not null, option_name text,
      quantity integer not null check (quantity > 0),
      unit_price numeric(12,2) not null check (unit_price >= 0), line_total numeric(12,2) not null check (line_total >= 0),
      withdrawal_eligible_at_order_time boolean,
      created_at timestamptz not null default now()
    );
    create table public.order_fulfillment_schedule_snapshot (
      order_id uuid primary key references public.orders(id) on delete cascade,
      restaurant_id uuid not null, mode_code text not null, fulfillment_rule_id uuid,
      scheduled_date date not null, slot_key text,
      selected_time text check (selected_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
      window_starts_at text, window_ends_at text, instant_starts_at timestamptz,
      origin text not null, timezone text not null,
      date_selection_mode text not null, slot_selection_mode text not null, resolved_at timestamptz not null
    );
    create table public.merchant_notification_profile (
      restaurant_id uuid primary key, email_enabled boolean not null default false, sender_name text, sender_email text, reply_to text,
      default_locale text not null default 'fr' check (default_locale in ('fr', 'en', 'ar'))
    );
    create table public.merchant_email_provider_config (restaurant_id uuid primary key, enabled boolean not null default false, secret_ciphertext text);
    create table public.merchant_tracking_status_text (restaurant_id uuid not null, status text not null, body text);
    create table public.merchant_communication_text (restaurant_id uuid not null, text_key text not null, body text);
    create table public.order_invoice_request (order_id uuid primary key);
    create table public.restaurant_contact_stub (restaurant_id uuid primary key, address text, email text, phone text);
    create function public.merchant_communication_contact(p_restaurant_id uuid)
      returns table(contact_address text, contact_email text, contact_phone text) language sql stable
      as $f$ select c.address, c.email, c.phone from public.restaurant_contact_stub c where c.restaurant_id = p_restaurant_id $f$;
    ${N1A_TABLE}
    ${PRED_FN}
    ${RECOVERY}
    ${TRG_205}
    -- Création d'une commande : MÊME ordre que create_order hébergé (orders, order_items, planning), dans UNE transaction.
    create function public.test_create_order(p jsonb) returns uuid language plpgsql as $f$
    declare v_id uuid; v_item jsonb; v_sub numeric := 0; v_fee numeric := coalesce((p->>'delivery_fee')::numeric, 0); v_s jsonb := p->'schedule';
    begin
      insert into public.orders (restaurant_id, service_mode, customer_email, customer_language, delivery_address)
      values ((p->>'restaurant_id')::uuid, coalesce(p->>'service_mode', 'pickup'), p->>'customer_email', p->>'language', p->>'delivery_address')
      returning id into v_id;
      for v_item in select * from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) loop
        insert into public.order_items (order_id, menu_item_id, item_name, option_name, quantity, unit_price, line_total, withdrawal_eligible_at_order_time)
        values (v_id, nullif(v_item->>'menu_item_id', '')::uuid, v_item->>'name', v_item->>'option', (v_item->>'qty')::int, (v_item->>'unit')::numeric,
                (v_item->>'qty')::int * (v_item->>'unit')::numeric, (v_item->>'eligible')::boolean);
        v_sub := v_sub + (v_item->>'qty')::int * (v_item->>'unit')::numeric;
      end loop;
      update public.orders set subtotal = v_sub, delivery_fee = v_fee, total = v_sub + v_fee where id = v_id;
      if v_s is not null then
        insert into public.order_fulfillment_schedule_snapshot (order_id, restaurant_id, mode_code, scheduled_date, slot_key, selected_time,
          window_starts_at, window_ends_at, origin, timezone, date_selection_mode, slot_selection_mode, resolved_at)
        values (v_id, (p->>'restaurant_id')::uuid, coalesce(p->>'service_mode', 'pickup'), (v_s->>'date')::date, v_s->>'slot_key', v_s->>'time',
          v_s->>'start', v_s->>'end', 'customer', coalesce(v_s->>'tz', 'Europe/Paris'), 'customer_choice', coalesce(v_s->>'slot_mode', 'fixed_window'), now());
      end if;
      return v_id;
    end $f$;
    ${opts.extraSql ?? ""}
  `, true);
  assert.equal(setup.status, 0, setup.out);
  return url;
}

function applyLot(url: string) {
  const r = psqlFile(url, "lot.sql", LOT, true);
  assert.equal(r.status, 0, r.out);
}

interface Resto { id: string; }
function addResto(url: string, name = "Au Lait Cru", opts: { address?: string; enabled?: boolean } = {}): Resto {
  const id = q(url, "select gen_random_uuid()");
  const enabled = opts.enabled ?? true;
  const r = psqlFile(url, `resto-${id}.sql`, `
    insert into public.restaurants (id, name) values ('${id}', $$${name}$$);
    insert into public.restaurant_contact_stub values ('${id}', $$${opts.address ?? "12 rue du Marché, 75000 Paris"}$$, 'contact@example.test', '+33100000000');
    insert into public.merchant_notification_profile (restaurant_id, email_enabled, sender_name, sender_email) values ('${id}', ${enabled}, 'Au Lait Cru', 'contact@example.test');
    insert into public.merchant_email_provider_config values ('${id}', ${enabled}, 'ciphertext');
  `, true);
  assert.equal(r.status, 0, r.out);
  return { id };
}

function createOrder(url: string, payload: Record<string, unknown>): string {
  const file = `order-${Math.random().toString(36).slice(2)}.sql`;
  const r = psqlFile(url, file, `select public.test_create_order($json$${JSON.stringify(payload)}$json$::jsonb);`, true);
  assert.equal(r.status, 0, r.out);
  return r.out.split("\n").map((l) => l.trim()).find((l) => /^[0-9a-f-]{36}$/.test(l)) ?? (() => { throw new Error(r.out); })();
}

function outboxSnapshot(url: string, orderId: string): Record<string, unknown> {
  const raw = q(url, `select payload_snapshot::text from public.notification_outbox where order_id = '${orderId}'`);
  assert.notEqual(raw, "", "ligne de file attendue");
  return JSON.parse(raw);
}
const outboxLocale = (url: string, orderId: string) => q(url, `select locale from public.notification_outbox where order_id = '${orderId}'`);

const ITEMS = [
  { name: "Comté 24 mois", option: "Tranche 200 g", qty: 2, unit: 12.5, eligible: true },
  { name: "Lait cru <1L>", option: null, qty: 1, unit: 4.2, eligible: false },
];
const PICKUP = (r: Resto, extra: Record<string, unknown> = {}) => ({
  restaurant_id: r.id, service_mode: "pickup", customer_email: "client@example.test", language: "fr", items: ITEMS,
  schedule: { date: "2026-11-05", start: "16:00", end: "20:00", slot_key: "evening-internal-key" }, ...extra,
});

after(() => {
  if (ADMIN_URL) {
    for (const db of databases) runner.run(ADMIN_URL, ["-v", "ON_ERROR_STOP=0", "-c", `drop database if exists ${db} with (force)`]);
  }
  rmSync(workDir, { recursive: true, force: true });
  rmSync(isolatedHome, { recursive: true, force: true });
});

// --------------------------------------------------------------------
// P / N. Ordre de persistance et contenu du snapshot
// --------------------------------------------------------------------

test("[211-P1] déclencheur différé RÉEL de #205 : le snapshot voit les lignes ET le planning écrits APRÈS la ligne orders, dans la même transaction", { skip: SKIP }, () => {
  const url = newDb();
  applyLot(url);
  const r = addResto(url);
  // Transaction explicite, DANS l'ordre de create_order : orders, puis order_items, puis planning, puis COMMIT.
  const orderId = q(url, "select gen_random_uuid()");
  const res = psqlFile(url, "explicit-tx.sql", `
    begin;
    insert into public.orders (id, restaurant_id, service_mode, customer_email, customer_language, subtotal, total)
      values ('${orderId}', '${r.id}', 'pickup', 'client@example.test', 'fr', 25, 25);
    do $$ begin
      if exists (select 1 from public.notification_outbox where order_id = '${orderId}') then raise exception 'ENQUEUED_TOO_EARLY'; end if;
    end $$;
    insert into public.order_items (order_id, item_name, option_name, quantity, unit_price, line_total, withdrawal_eligible_at_order_time)
      values ('${orderId}', 'Comté 24 mois', 'Tranche 200 g', 2, 12.5, 25, true);
    insert into public.order_fulfillment_schedule_snapshot (order_id, restaurant_id, mode_code, scheduled_date, slot_key, window_starts_at, window_ends_at, origin, timezone, date_selection_mode, slot_selection_mode, resolved_at)
      values ('${orderId}', '${r.id}', 'pickup', '2026-11-05', 'k', '16:00', '20:00', 'customer', 'Europe/Paris', 'customer_choice', 'fixed_window', now());
    commit;
  `, true);
  assert.equal(res.status, 0, res.out);
  const snap = outboxSnapshot(url, orderId) as any;
  assert.equal(snap.items.length, 1, "la ligne écrite après orders est dans le snapshot");
  assert.equal(snap.schedule.scheduled_date, "2026-11-05", "le planning écrit après orders est dans le snapshot");
  assert.equal(snap.order_email_detail_v1, true);
});

test("[211-N1] retrait avec fenêtre : lignes/option/quantités/prix, montants, jour + fenêtre + fuseau ; AUCUNE clé interne de créneau", { skip: SKIP }, () => {
  const url = newDb();
  applyLot(url);
  const r = addResto(url);
  const id = createOrder(url, PICKUP(r));
  const snap = outboxSnapshot(url, id) as any;
  assert.deepEqual(snap.items.map((i: any) => [i.item_name, i.option_name, i.quantity, Number(i.unit_price), Number(i.line_total)]), [
    ["Comté 24 mois", "Tranche 200 g", 2, 12.5, 25],
    ["Lait cru <1L>", null, 1, 4.2, 4.2],
  ]);
  assert.equal(Number(snap.subtotal), 29.2);
  assert.equal(Number(snap.delivery_fee), 0);
  assert.equal(Number(snap.total), 29.2);
  assert.equal(snap.schedule.scheduled_date, "2026-11-05");
  assert.equal(snap.schedule.window_starts_at, "16:00");
  assert.equal(snap.schedule.window_ends_at, "20:00");
  assert.equal(snap.schedule.timezone, "Europe/Paris");
  assert.equal(snap.fulfillment_date, "2026-11-05");
  assert.equal(snap.fulfillment_slot, "16:00–20:00");
  assert.equal(snap.withdrawal_eligible, true);
  assert.equal(snap.merchant_address, "12 rue du Marché, 75000 Paris");
  assert.equal(JSON.stringify(snap).includes("evening-internal-key"), false, "slot_key n'est JAMAIS recopiée");
  assert.equal("slot_key" in snap.schedule, false);
});

test("[211-N2] livraison + heure libre + frais ; jour seul (aucune heure inventée) ; table et planning absent : aucune clé de planning", { skip: SKIP }, () => {
  const url = newDb();
  applyLot(url);
  const r = addResto(url);
  const delivery = outboxSnapshot(url, createOrder(url, PICKUP(r, {
    service_mode: "delivery", delivery_fee: 3.5, delivery_address: "1 avenue Test, 75001 Paris",
    schedule: { date: "2026-11-06", time: "12:30" },
  }))) as any;
  assert.equal(Number(delivery.total), 32.7);
  assert.equal(Number(delivery.delivery_fee), 3.5);
  assert.equal(delivery.fulfillment_slot, "12:30");
  assert.equal(delivery.delivery_address, "1 avenue Test, 75001 Paris");
  assert.equal(delivery.schedule.mode_code, "delivery");

  const dateOnly = outboxSnapshot(url, createOrder(url, PICKUP(r, { schedule: { date: "2026-11-07" } }))) as any;
  assert.equal(dateOnly.schedule.scheduled_date, "2026-11-07");
  assert.equal(dateOnly.schedule.selected_time, null);
  assert.equal(dateOnly.schedule.window_starts_at, null);
  assert.equal(dateOnly.fulfillment_slot, null, "jour seul : pas de créneau inventé");

  const table = outboxSnapshot(url, createOrder(url, PICKUP(r, { service_mode: "table", schedule: undefined }))) as any;
  assert.equal(table.schedule, null);
  assert.equal(table.fulfillment_date, null);
  assert.equal(table.fulfillment_slot, null);
  assert.equal(table.merchant_address, "12 rue du Marché, 75000 Paris");
});

test("[211-N3] valeurs HISTORIQUES : produit renommé, repricé puis supprimé du catalogue APRÈS la commande ; la reprise #205 fige les valeurs d'origine", { skip: SKIP }, () => {
  const url = newDb();
  applyLot(url);
  const r = addResto(url);
  const menuId = q(url, "select gen_random_uuid()");
  assert.equal(psqlFile(url, "menu.sql", `insert into public.menu_items values ('${menuId}', '${r.id}', 'Comté 24 mois', 12.50, true);`).status, 0);
  // Commande créée SANS enfilement (déclencheur désactivé) : exactement le cas que la reprise #205 rattrape plus tard.
  assert.equal(psqlFile(url, "off.sql", "alter table public.orders disable trigger orders_enqueue_order_received_trg;").status, 0);
  const id = createOrder(url, PICKUP(r, { items: [{ name: "Comté 24 mois", option: "Tranche 200 g", qty: 2, unit: 12.5, eligible: true, menu_item_id: menuId }] }));
  assert.equal(q(url, `select count(*) from public.notification_outbox where order_id = '${id}'`), "0");
  // Le catalogue change, puis le produit est supprimé (order_items.menu_item_id passe à NULL).
  assert.equal(psqlFile(url, "mutate.sql", `
    update public.menu_items set name = 'Autre nom', price = 99, is_available = false where id = '${menuId}';
    delete from public.menu_items where id = '${menuId}';
  `).status, 0);
  assert.equal(q(url, `select menu_item_id is null from public.order_items where order_id = '${id}'`), "t");
  const rec = q(url, "select recovered || '/' || failed from public.recover_new_order_received_notifications(25)");
  assert.equal(rec, "1/0", "la reprise #205 enfile la commande");
  const snap = outboxSnapshot(url, id) as any;
  assert.equal(snap.items[0].item_name, "Comté 24 mois");
  assert.equal(Number(snap.items[0].unit_price), 12.5);
  assert.equal(Number(snap.items[0].line_total), 25);
  assert.equal(snap.schedule.scheduled_date, "2026-11-05", "la reprise lit le planning déjà commité");
  assert.equal(JSON.stringify(snap).includes("Autre nom"), false);
});

test("[211-N4] isolation par commerce : deux restaurants, chaque snapshot ne porte que SES lignes ; substitution tenant refusée comme avant", { skip: SKIP }, () => {
  const url = newDb();
  applyLot(url);
  const a = addResto(url, "A", { address: "Adresse A" });
  const b = addResto(url, "B", { address: "Adresse B" });
  const ia = createOrder(url, PICKUP(a, { items: [{ name: "Produit A", qty: 1, unit: 10, eligible: false }], schedule: undefined }));
  const ib = createOrder(url, PICKUP(b, { items: [{ name: "Produit B", qty: 4, unit: 5, eligible: false }], schedule: undefined }));
  const sa = JSON.stringify(outboxSnapshot(url, ia));
  const sb = JSON.stringify(outboxSnapshot(url, ib));
  assert.ok(sa.includes("Produit A") && sa.includes("Adresse A") && !/Produit B|Adresse B/.test(sa));
  assert.ok(sb.includes("Produit B") && sb.includes("Adresse B") && !/Produit A|Adresse A/.test(sb));
  const bad = runner.run(url, ["-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", `select ${FN.replace("(uuid, uuid)", "")}('${ia}', '${b.id}')`]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /SCANYM_NOTIFICATION_TENANT_MISMATCH/);
});

test("[211-N5] idempotence : second appel = aucune nouvelle ligne et snapshot inchangé (ON CONFLICT DO NOTHING)", { skip: SKIP }, () => {
  const url = newDb();
  applyLot(url);
  const r = addResto(url);
  const id = createOrder(url, PICKUP(r));
  const before = q(url, `select payload_snapshot::text from public.notification_outbox where order_id = '${id}'`);
  assert.equal(q(url, `select coalesce(public.create_order_received_notification('${id}', '${r.id}')::text, 'null')`), "null");
  assert.equal(q(url, `select count(*) from public.notification_outbox where order_id = '${id}'`), "1");
  assert.equal(q(url, `select payload_snapshot::text from public.notification_outbox where order_id = '${id}'`), before);
});

// --------------------------------------------------------------------
// L. Locale et compatibilité
// --------------------------------------------------------------------

test("[211-L1] nl conservé de bout en bout ; CONTRÔLE NÉGATIF : le prédécesseur le perdait (nl -> fr) ; valeurs inconnues -> fr", { skip: SKIP }, () => {
  const before = newDb();
  const rb = addResto(before);
  assert.equal(outboxLocale(before, createOrder(before, PICKUP(rb, { language: "nl" }))), "fr", "prédécesseur : nl retombe sur fr");
  const url = newDb();
  applyLot(url);
  const r = addResto(url);
  for (const [lang, expected] of [["nl", "nl"], ["fr", "fr"], ["en", "en"], ["ar", "ar"], ["xx", "fr"], ["nl-NL", "fr"], ["NL", "fr"], [null, "fr"]] as const) {
    assert.equal(outboxLocale(url, createOrder(url, PICKUP(r, { language: lang }))), expected, String(lang));
  }
  // La contrainte accepte nl et refuse toujours le reste.
  const bad = runner.run(url, ["-A", "-t", "-c", `update public.notification_outbox set locale = 'de'`]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /notification_outbox_locale_check/);
});

test("[211-L2] compatibilité ascendante EXACTE : les 17 clés d'avant ont les mêmes valeurs ; seules des clés s'ajoutent (l'ancien code les ignore)", { skip: SKIP }, () => {
  const url = newDb();
  const r = addResto(url);
  const id = createOrder(url, PICKUP(r, { language: "en" }));
  const oldSnap = outboxSnapshot(url, id);
  assert.equal(psqlFile(url, "del.sql", `delete from public.notification_outbox where order_id = '${id}'`).status, 0);
  applyLot(url);
  assert.equal(q(url, `select public.create_order_received_notification('${id}', '${r.id}') is not null`), "t");
  const newSnap = outboxSnapshot(url, id);
  assert.equal(Object.keys(oldSnap).length, 17);
  for (const k of Object.keys(oldSnap)) assert.deepEqual(newSnap[k], oldSnap[k], k);
  const added = Object.keys(newSnap).filter((k) => !(k in oldSnap)).sort();
  assert.deepEqual(added, ["delivery_fee", "fulfillment_date", "fulfillment_slot", "items", "order_email_detail_v1", "schedule", "subtotal"]);
});

// --------------------------------------------------------------------
// F. Pré-vol
// --------------------------------------------------------------------

/** Tout ce qu'un refus ne doit pas toucher. */
function state(url: string): string {
  return q(url, `select concat_ws(E'\\n',
    (select to_jsonb(p)::text from pg_proc p where p.oid = '${FN}'::regprocedure),
    obj_description('${FN}'::regprocedure, 'pg_proc'),
    (select string_agg(pg_get_constraintdef(c.oid), ',' order by c.conname) from pg_constraint c where c.conrelid = 'public.notification_outbox'::regclass),
    (select string_agg(p.proname || ':' || p.proowner::regrole::text || ':' || coalesce(p.proacl::text, '-'), ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
    (select count(*)::text from public.notification_outbox))`);
}

function assertRefused(url: string, script: string, label: string, code: string, message?: RegExp) {
  const before = state(url);
  const stop = psqlFile(url, `${label}-stop.sql`, script, true);
  assert.notEqual(stop.status, 0, `${label}: doit échouer`);
  assert.ok(stop.out.includes(code), `${label}: ${code}\n${stop.out}`);
  if (message) assert.match(stop.out, message, label);
  assert.equal(state(url), before, `${label}: aucune mutation (ON_ERROR_STOP=1)`);
  const go = psqlFile(url, `${label}-go.sql`, script, false);
  assert.ok(go.out.includes(code), `${label} (ON_ERROR_STOP=0): ${code}\n${go.out}`);
  assert.equal(state(url), before, `${label}: aucune mutation (ON_ERROR_STOP=0 : la transaction avortée interdit toute DDL suivante)`);
}

test("[211-F1] pré-vol : prédécesseur dérivé (corps, STRICT, droit en plus, commentaire, surcharge) -> refus AVANT écriture", { skip: SKIP }, () => {
  const mk = (extra: string) => newDb({ extraSql: extra });
  const bodyDrift = mk(`create or replace function public.create_order_received_notification(p_order_id uuid, p_restaurant_id uuid) returns uuid language plpgsql security definer set search_path = '' as $$ begin return null; end $$;
    revoke all on function ${FN} from public, anon, authenticated; grant execute on function ${FN} to service_role;`);
  assertRefused(bodyDrift, LOT, "corps", "SCANYM_PREDECESSOR_DRIFT", /n'est pas celui de MERCHANT CUSTOMER COMMUNICATIONS v1/);
  const strict = mk(`alter function ${FN} strict;`);
  assertRefused(strict, LOT, "strict", "SCANYM_PREDECESSOR_DRIFT", /attributs/);
  const grant = mk(`grant execute on function ${FN} to audit_extra;`);
  assertRefused(grant, LOT, "droit", "SCANYM_PREDECESSOR_DRIFT", /droits/);
  const anon = mk(`grant execute on function ${FN} to anon;`);
  assertRefused(anon, LOT, "anon", "SCANYM_PREDECESSOR_DRIFT");
  const comment = mk(`comment on function ${FN} is 'modifié à la main';`);
  assertRefused(comment, LOT, "commentaire", "SCANYM_PREDECESSOR_DRIFT", /commentaire/);
  const overload = mk(`create function public.create_order_received_notification(p uuid) returns uuid language sql as 'select null::uuid';`);
  assertRefused(overload, LOT, "surcharge", "SCANYM_SCHEMA_DRIFT", /UNE seule surcharge/);
});

test("[211-F2] pré-vol : schéma dérivé (CHECK de locale autre, colonne de planning absente ou de mauvais type, montants non numériques) -> refus AVANT écriture", { skip: SKIP }, () => {
  const check = newDb({ extraSql: "alter table public.notification_outbox drop constraint notification_outbox_locale_check; alter table public.notification_outbox add constraint notification_outbox_locale_check check (locale in ('fr', 'en'));" });
  assertRefused(check, LOT, "check", "SCANYM_SCHEMA_DRIFT", /n'est pas ceux de N1-A/);
  const col = newDb({ extraSql: "alter table public.order_fulfillment_schedule_snapshot rename column timezone to tz;" });
  assertRefused(col, LOT, "colonne", "SCANYM_SCHEMA_DRIFT", /colonnes absentes : order_fulfillment_schedule_snapshot\.timezone/);
  const type = newDb({ extraSql: "alter table public.order_fulfillment_schedule_snapshot drop constraint order_fulfillment_schedule_snapshot_selected_time_check; alter table public.order_fulfillment_schedule_snapshot alter column selected_time type time using selected_time::time;" });
  assertRefused(type, LOT, "type", "SCANYM_SCHEMA_DRIFT", /types inattendus.*selected_time=time/);
  const money = newDb({ extraSql: "alter table public.orders alter column delivery_fee type text using delivery_fee::text;" });
  assertRefused(money, LOT, "montants", "SCANYM_SCHEMA_DRIFT", /montants de orders non numériques/);
  const nolines = newDb({ extraSql: "alter table public.order_items rename column line_total to total_line;" });
  assertRefused(nolines, LOT, "lignes", "SCANYM_SCHEMA_DRIFT", /order_items\.line_total/);
});

test("[211-F3] application nominale puis seconde application : ALREADY_APPLIED, aucune mutation ; état final vérifié par le lot lui-même", { skip: SKIP }, () => {
  const url = newDb();
  applyLot(url);
  assert.equal(q(url, `select md5(prosrc) from pg_proc where oid = '${FN}'::regprocedure`).length, 32);
  assertRefused(url, LOT, "deux-fois", "SCANYM_ALREADY_APPLIED");
  // Droits de l'objet appliqué : propriétaire + service_role EXECUTE, rien pour anon/authenticated/PUBLIC.
  assert.equal(q(url, `select (has_function_privilege('anon', '${FN}', 'execute') or has_function_privilege('authenticated', '${FN}', 'execute') or has_function_privilege('public', '${FN}', 'execute'))::text`), "false");
  assert.equal(q(url, `select has_function_privilege('service_role', '${FN}', 'execute')::text`), "true");
});

/** AUD214-01 : une valeur de locale qui ne diffère de fr/en/ar/nl QUE par un espace (ou une tabulation, un saut de
 *  ligne) n'est PAS la même contrainte. Le CHECK de remplacement est posé tel quel, avec ses littéraux exacts. */
const withCheck = (values: string[]) =>
  `alter table public.notification_outbox drop constraint notification_outbox_locale_check;
   alter table public.notification_outbox add constraint notification_outbox_locale_check check (locale in (${values.join(", ")}));`;

test("[211-F4] AUD214-01 pré-vol : un CHECK de locale dont un littéral ne diffère que par une espace ('f r', ' fr', 'fr ', tab, saut de ligne) est REFUSÉ, contrainte intacte", { skip: SKIP }, () => {
  const variants: Array<[string, string[]]> = [
    ["espace-interne", ["'f r'", "'en'", "'ar'"]],
    ["espace-avant", ["' fr'", "'en'", "'ar'"]],
    ["espace-apres", ["'fr '", "'en'", "'ar'"]],
    ["tabulation", ["E'f\\tr'", "'en'", "'ar'"]],
    ["saut-de-ligne", ["'fr'", "E'e\\nn'", "'ar'"]],
    ["autre-ordre", ["'en'", "'fr'", "'ar'"]],
    ["valeur-en-plus", ["'fr'", "'en'", "'ar'", "'de'"]],
    ["valeur-en-moins", ["'fr'", "'en'"]],
  ];
  for (const [label, values] of variants) {
    const url = newDb({ extraSql: withCheck(values) });
    assertRefused(url, LOT, `locale-${label}`, "SCANYM_SCHEMA_DRIFT", /CHECK de locale n'est pas ceux de N1-A/);
  }
  // Témoin : la forme exacte est acceptée (le refus ci-dessus vient bien du littéral, pas du harnais).
  applyLot(newDb({ extraSql: withCheck(["'fr'", "'en'", "'ar'"]) }));
});

test("[211-F5] AUD214-01 rollback : un CHECK ('f r','en','ar','nl'), ('fr','en','ar','n l'), (' fr',…) est REFUSÉ sans rien modifier ; la forme exacte est acceptée", { skip: SKIP }, () => {
  const variants: Array<[string, string[]]> = [
    ["espace-interne-fr", ["'f r'", "'en'", "'ar'", "'nl'"]],
    ["espace-interne-nl", ["'fr'", "'en'", "'ar'", "'n l'"]],
    ["espace-avant", ["' fr'", "'en'", "'ar'", "'nl'"]],
    ["espace-apres", ["'fr'", "'en'", "'ar'", "'nl '"]],
    ["tabulation", ["'fr'", "'en'", "E'a\\tr'", "'nl'"]],
    ["autre-ordre", ["'nl'", "'fr'", "'en'", "'ar'"]],
    ["sans-nl", ["'fr'", "'en'", "'ar'"]],
  ];
  for (const [label, values] of variants) {
    const url = newDb();
    applyLot(url);
    assert.equal(psqlFile(url, `drift-${label}.sql`, withCheck(values), true).status, 0);
    assertRefused(url, RB, `rb-locale-${label}`, "SCANYM_PREDECESSOR_DRIFT", /CHECK de locale/);
  }
  // Témoin : la forme exacte (posée à la main) est acceptée par le rollback.
  const ok = newDb();
  applyLot(ok);
  assert.equal(psqlFile(ok, "hand-exact.sql", withCheck(["'fr'", "'en'", "'ar'", "'nl'"]), true).status, 0);
  assert.equal(psqlFile(ok, "rb-ok.sql", RB, true).status, 0);
});

// --------------------------------------------------------------------
// R. Rollback
// --------------------------------------------------------------------

const PRED_MD5 = md5(bodyOf(PRED_FN));
const predComment = () => { const m = PRED_FN.match(/comment on function [^\n]*\n\s+'((?:[^']|'')*)';/)!; return m[1]!.replaceAll("''", "'"); };

test("[211-R1] rollback nominal : fonction, commentaire, droits et CHECK d'avant ; AUCUNE ligne supprimée ; ré-application possible", { skip: SKIP }, () => {
  const url = newDb();
  applyLot(url);
  const r = addResto(url);
  const id = createOrder(url, PICKUP(r, { language: "en" }));
  const rows = q(url, "select count(*) from public.notification_outbox");
  const res = psqlFile(url, "rb.sql", RB, true);
  assert.equal(res.status, 0, res.out);
  assert.equal(q(url, `select md5(prosrc) from pg_proc where oid = '${FN}'::regprocedure`), PRED_MD5);
  assert.equal(q(url, `select md5(obj_description('${FN}'::regprocedure, 'pg_proc'))`), md5(predComment()));
  assert.equal(q(url, `select has_function_privilege('anon', '${FN}', 'execute')::text`), "false");
  assert.equal(q(url, `select has_function_privilege('service_role', '${FN}', 'execute')::text`), "true");
  assert.match(q(url, "select pg_get_constraintdef(oid) from pg_constraint where conname = 'notification_outbox_locale_check'"), /ARRAY\['fr'::text, 'en'::text, 'ar'::text\]\)/);
  assert.equal(q(url, "select pg_get_constraintdef(oid) like '%nl%' from pg_constraint where conname = 'notification_outbox_locale_check'"), "f");
  assert.equal(q(url, "select count(*) from public.notification_outbox"), rows, "aucun snapshot supprimé");
  assert.equal((outboxSnapshot(url, id) as any).items.length, 2, "le snapshot déjà figé garde ses clés additives");
  applyLot(url); // aller-retour : le pré-vol accepte à nouveau l'état restauré.
});

test("[211-R2] rollback : refuse s'il existe des lignes nl (aucune décision figée n'est réécrite) ; rien n'est modifié", { skip: SKIP }, () => {
  const url = newDb();
  applyLot(url);
  const r = addResto(url);
  createOrder(url, PICKUP(r, { language: "nl" }));
  assertRefused(url, RB, "nl", "SCANYM_ROLLBACK_REFUSED_NL_ROWS", /1 ligne\(s\)/);
});

test("[211-R3] rollback : toute dérive de la fonction posée (corps, STRICT, droit, commentaire) ou du CHECK -> refus sans rien modifier", { skip: SKIP }, () => {
  const cases: Array<[string, string, string]> = [
    ["corps", `create or replace function public.create_order_received_notification(p_order_id uuid, p_restaurant_id uuid) returns uuid language plpgsql security definer set search_path = '' as $$ begin return null; end $$;
      revoke all on function ${FN} from public, anon, authenticated; grant execute on function ${FN} to service_role;`, "SCANYM_PREDECESSOR_DRIFT"],
    ["strict", `alter function ${FN} strict;`, "SCANYM_PREDECESSOR_DRIFT"],
    ["droit", `grant execute on function ${FN} to audit_extra;`, "SCANYM_PREDECESSOR_DRIFT"],
    ["commentaire", `comment on function ${FN} is 'autre';`, "SCANYM_PREDECESSOR_DRIFT"],
    ["check", "alter table public.notification_outbox drop constraint notification_outbox_locale_check; alter table public.notification_outbox add constraint notification_outbox_locale_check check (locale in ('fr','en','ar','nl','de'));", "SCANYM_PREDECESSOR_DRIFT"],
  ];
  for (const [label, drift, code] of cases) {
    const url = newDb();
    applyLot(url);
    assert.equal(psqlFile(url, `drift-${label}.sql`, drift, true).status, 0);
    assertRefused(url, RB, `rb-${label}`, code);
  }
});

test("[211-R4] rollback sans le lot appliqué : refus net (fonction d'avant, pas de snapshot touché)", { skip: SKIP }, () => {
  const url = newDb();
  assertRefused(url, RB, "non-applique", "SCANYM_PREDECESSOR_DRIFT");
});

// --------------------------------------------------------------------
// E. De bout en bout : snapshot produit par le VRAI SQL (PostgreSQL) -> VRAI worker -> fournisseur intercepté.
//    Aucun e-mail réel : FakeEmailProvider ; fetch interdit ; client.from interdit (aucune lecture de table).
// --------------------------------------------------------------------

test("[211-E1] snapshot PostgreSQL réel -> vrai worker : retrait, livraison+heure, jour seul, table ; fr/en/ar/nl ; HTML ET texte ; aucune lecture de table", { skip: SKIP }, async (t) => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "i211-synthetic-service-role-key-DO-NOT-USE";
  process.env.SCANYM_PUBLIC_ORIGIN ??= "https://app.scanym.example";
  const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
  const { processPendingNotifications } = await import("../lib/server/notifications/notification-worker.ts");
  const { FakeEmailProvider } = await import("../lib/server/notifications/fake-email-provider.ts");
  const client = getServiceRoleSupabaseClient();

  const url = newDb();
  applyLot(url);
  const r = addResto(url);
  const cases = [
    { key: "pickup-fr", payload: PICKUP(r, { language: "fr" }), expect: ["Comté 24 mois", "Tranche 200 g", "16:00–20:00"] },
    { key: "delivery-en", payload: PICKUP(r, { language: "en", service_mode: "delivery", delivery_fee: 3.5, delivery_address: "1 avenue Test, 75001 Paris", schedule: { date: "2026-11-06", time: "12:30" } }), expect: ["Comté 24 mois", "12:30", "Thursday"].slice(0, 2) },
    { key: "dateonly-ar", payload: PICKUP(r, { language: "ar", schedule: { date: "2026-11-07" } }), expect: ["Comté 24 mois"] },
    { key: "table-nl", payload: PICKUP(r, { language: "nl", service_mode: "table", schedule: undefined }), expect: ["Comté 24 mois"] },
  ];
  const ids = cases.map((c) => createOrder(url, c.payload));
  const claimRows = ids.map((id, i) => {
    const snapshot = outboxSnapshot(url, id);
    return {
      outbox_id: q(url, `select id from public.notification_outbox where order_id = '${id}'`),
      restaurant_id: r.id, order_id: id, notification_type: "order_received", recipient_email: "client@example.test",
      locale: outboxLocale(url, id), payload_snapshot: snapshot, attempt_count: 0, claim_token: "44444444-4444-4444-8444-444444444444",
      sender_name: "Au Lait Cru", sender_email: "contact@example.test", reply_to: null, _case: cases[i]!.key,
    };
  });
  assert.deepEqual(claimRows.map((c) => c.locale), ["fr", "en", "ar", "nl"], "les 4 langues traversent la file, nl compris");

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("NETWORK_FORBIDDEN_IN_211_TESTS"); }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  let claimed = false;
  const tables: string[] = [];
  t.mock.method(client, "rpc", async (name: string) => {
    if (name === "claim_new_order_notifications") { if (claimed) return { data: [], error: null }; claimed = true; return { data: claimRows.map(({ _case, ...rest }) => rest), error: null }; }
    if (name === "issue_order_email_tracking_capability") return { data: [{ capability_id: "33333333-3333-4333-8333-333333333333", capability_secret: "ab".repeat(32) }], error: null };
    if (name === "complete_notification_attempt") return { data: null, error: null };
    throw new Error(`RPC inattendue : ${name}`);
  });
  t.mock.method(client, "from", (table: string) => { tables.push(table); throw new Error(`LECTURE_DE_TABLE_INTERDITE:${table}`); });

  const provider = new FakeEmailProvider();
  const result = await processPendingNotifications(provider);
  assert.equal(result.sent, 4);
  assert.deepEqual(tables, []);
  const [pickup, delivery, dateOnly, table] = provider.sent;
  for (const body of [pickup!.text, pickup!.html!]) {
    assert.ok(body.includes("Comté 24 mois") && body.includes("Tranche 200 g"), "ligne + option");
    assert.ok(body.includes("jeudi 5 novembre 2026") && body.includes("16:00–20:00"), "jour + fenêtre persistés");
    assert.equal(body.includes("evening-internal-key"), false, "aucune clé interne de créneau");
  }
  assert.ok(pickup!.html!.includes("Lait cru &lt;1L&gt;") && !pickup!.html!.includes("<1L>"), "échappement HTML");
  assert.ok(pickup!.text.includes("Lait cru <1L>"), "texte brut non échappé");
  for (const body of [delivery!.text, delivery!.html!]) {
    assert.ok(body.includes("Thursday, 5 November 2026".replace("5 November", "6 November").replace("Thursday", "Friday")), body.slice(0, 400));
    assert.ok(body.includes("12:30") && body.includes("1 avenue Test"), "heure libre + adresse de livraison");
  }
  assert.ok(delivery!.text.includes("3.50") || delivery!.text.includes("3,50"), "frais de livraison");
  assert.equal(/\d{2}:\d{2}/.test(dateOnly!.text.replace(/\d{4}-\d{2}-\d{2}/g, "")), false, "jour seul : aucune heure inventée");
  assert.equal(table!.text.includes("2026"), false, "table : aucun jour/créneau");
  assert.ok(table!.text.includes("Comté 24 mois"), "table : le récapitulatif d'articles est quand même présent");
  assert.ok(dateOnly!.html!.includes('dir="rtl"'), "arabe : RTL");
});

test("[211-E2] base NON UTF-8 : le lot ne lève JAMAIS (la création de commande ne doit pas pouvoir échouer) ; trait d'union ASCII de repli, fenêtre intacte", { skip: SKIP }, () => {
  const url = newDb({ encoding: "SQL_ASCII" });
  applyLot(url);
  const r = addResto(url, "Au Lait Cru");
  const id = createOrder(url, PICKUP(r));
  const snap = outboxSnapshot(url, id) as any;
  assert.equal(snap.fulfillment_slot, "16:00-20:00", "repli ASCII, jamais d'exception");
  assert.equal(snap.schedule.window_starts_at, "16:00");
  assert.equal(snap.schedule.window_ends_at, "20:00");
  // Base UTF-8 (comme l'hébergé) : tiret demi-cadratin.
  const utf = newDb();
  applyLot(utf);
  const r2 = addResto(utf);
  assert.equal((outboxSnapshot(utf, createOrder(utf, PICKUP(r2))) as any).fulfillment_slot, "16:00–20:00");
});
