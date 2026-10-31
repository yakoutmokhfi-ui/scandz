import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ====================================================================
// ISSUE #172 / T180-03 — PREUVE DE CONCURRENCE RÉELLE (multi-connexions)
// de la porte d'envoi ORDER_RECEIVED, sur un VRAI PostgreSQL.
//
// POURQUOI CE FICHIER : PGlite est à connexion unique. Les tests
// `172-RACE-*` de tests/v172-order-received-payment-gate.test.ts sont donc
// SÉQUENTIELS : ils ne démontrent aucune attente de verrou ni aucune
// visibilité entre transactions. Ici, chaque session est un PROCESSUS `psql`
// distinct (connexion distincte, transaction distincte). L'attente d'un
// verrou est PROUVÉE par pg_stat_activity.wait_event_type = 'Lock' lu depuis
// une troisième connexion, AVANT de libérer le verrou.
//
// EXÉCUTION -- ce test exige un PostgreSQL réel et N'EST PAS exécuté par
// défaut : sans la variable d'environnement ci-dessous, chaque test est
// explicitement SAUTÉ (SKIP) avec la raison, et aucune concurrence n'est alors
// démontrée. Il ne se connecte qu'à ce que l'on lui désigne.
//
//   SCANYM_TEST_PG_ADMIN_URL  URL d'un PostgreSQL JETABLE de test, rôle
//                             pouvant créer des bases et des rôles, ex.
//                             postgresql://postgres@127.0.0.1:55432/postgres
//   SCANYM_TEST_PSQL          (optionnel) chemin du binaire psql ; défaut `psql`
//
// SÉCURITÉ : exige un hôte de boucle locale (127.0.0.1, ::1 ou localhost) --
// refuse tout autre hôte. Chaque scénario crée sa propre base
// `scanym_t180_*` (données 100 % synthétiques) et la supprime à la fin. Les
// rôles `anon`, `authenticated` et `service_role` sont créés s'ils n'existent
// pas (clones de test des rôles Supabase).
//
// MODÉLISATION : le passage à `required` est exécuté comme le fait la vraie
// require_order_payment (P4-A) : SELECT … FOR UPDATE sur la commande puis
// UPDATE payment_status = 'required'. La décision « sans paiement » et la
// réclamation sont les VRAIES fonctions SQL du lot (finalize_order_payment_
// mode_none, claim_pending_notifications), appliquées sur le prédécesseur N1-A
// extrait du dépôt. Aucun e-mail, aucun réseau hors de la boucle locale.
// ====================================================================

const ADMIN_URL = process.env.SCANYM_TEST_PG_ADMIN_URL;
const PSQL = process.env.SCANYM_TEST_PSQL || "psql";

function loopbackOnly(url: string): void {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error(`SCANYM_TEST_PG_ADMIN_URL doit désigner la boucle locale (reçu : ${host})`);
  }
}

const SKIP_REASON = ADMIN_URL
  ? false
  : "SCANYM_TEST_PG_ADMIN_URL absent : la preuve de concurrence RÉELLE (multi-connexions) n'est PAS exécutée ici -- aucune concurrence n'est démontrée par ce fichier dans cet environnement";

const sql = (name: string) => readFileSync(`supabase/${name}`, "utf8").replaceAll("\r\n", "\n");
const N1A = sql("DRAFT-lot-n1a-customer-email-notification-foundation-v1.sql");
const LOT = sql("DRAFT-lot-order-received-payment-gate-v1.sql");
const N1A_TABLE = N1A.match(/create table public\.notification_outbox \([\s\S]*?\n\);/)![0];
const N1A_CLAIM = N1A.match(/create function public\.claim_pending_notifications\([\s\S]*?end \$\$;/)![0];

const workDir = mkdtempSync(path.join(tmpdir(), "scanym-t180-"));
const databases: string[] = [];
const sessions: Psql[] = [];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function urlFor(db: string): string {
  const u = new URL(ADMIN_URL!);
  u.pathname = `/${db}`;
  return u.toString();
}

/** Une session = un processus psql = une connexion = une transaction distincte. */
class Psql {
  private buf = "";
  private seq = 0;
  private proc: ChildProcessWithoutNullStreams;
  private waiters: Array<() => void> = [];

  constructor(url: string) {
    this.proc = spawn(PSQL, ["-X", "-q", "-A", "-t", "-F", "|", url], { stdio: ["pipe", "pipe", "pipe"] });
    const onData = (d: Buffer) => {
      this.buf += d.toString("utf8").replaceAll("\r", "");
      for (const w of this.waiters.splice(0)) w();
    };
    this.proc.stdout.on("data", onData);
    this.proc.stderr.on("data", onData);
    sessions.push(this);
  }

  /** Envoie une commande ; se résout à sa fin (marqueur) avec la sortie (stdout + stderr). Une commande bloquée sur un verrou ne se résout qu'au déblocage. */
  run(command: string): Promise<string> {
    const marker = `__END_${++this.seq}__`;
    this.buf = "";
    this.proc.stdin.write(`${command}\n\\echo ${marker}\n`);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`délai dépassé (commande bloquée ?) : ${command.slice(0, 80)}`)), 15000);
      const check = () => {
        if (this.buf.includes(marker)) {
          clearTimeout(timer);
          // stdout et stderr sont deux flux : laisser le temps au message d'erreur d'arriver.
          setTimeout(() => resolve(this.buf.replace(marker, "").trim()), 40);
        } else {
          this.waiters.push(check);
        }
      };
      check();
    });
  }

  async pid(): Promise<number> {
    return Number((await this.run("select pg_backend_pid();")).split("\n")[0]);
  }

  close(): void {
    try { this.proc.stdin.write("\\q\n"); this.proc.stdin.end(); } catch { /* déjà fermé */ }
    this.proc.kill();
  }
}

/** Attend, depuis une AUTRE connexion, que le backend `pid` soit réellement bloqué sur un verrou. */
async function waitUntilLockWaiting(observer: Psql, pid: number): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const out = await observer.run(`select wait_event_type || ':' || wait_event from pg_stat_activity where pid = ${pid} and wait_event_type = 'Lock';`);
    if (out.startsWith("Lock:")) return out;
    await sleep(50);
  }
  throw new Error(`le backend ${pid} n'a jamais attendu de verrou`);
}

function applyFile(dbUrl: string, name: string, content: string): void {
  const file = path.join(workDir, name);
  writeFileSync(file, content);
  const r = spawnSync(PSQL, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", file, dbUrl], { encoding: "utf8" });
  assert.equal(r.status, 0, `${name} : ${r.stderr}`);
}

interface Scenario {
  url: string;
  orderId: string;
  token: string;
  outboxId: string;
  open: () => Psql;
}

async function newScenario(): Promise<Scenario> {
  loopbackOnly(ADMIN_URL!);
  const db = `scanym_t180_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  databases.push(db);
  const admin = spawnSync(PSQL, ["-X", "-q", "-v", "ON_ERROR_STOP=1", ADMIN_URL!, "-c", `create database ${db}`], { encoding: "utf8" });
  assert.equal(admin.status, 0, admin.stderr);
  const url = urlFor(db);

  applyFile(url, "schema.sql", `
    do $$ begin
      create role anon nologin; exception when duplicate_object then null; end $$;
    do $$ begin
      create role authenticated nologin; exception when duplicate_object then null; end $$;
    do $$ begin
      create role service_role nologin; exception when duplicate_object then null; end $$;
    create table public.restaurants (id uuid primary key default gen_random_uuid());
    create table public.orders (
      id uuid primary key default gen_random_uuid(),
      restaurant_id uuid not null,
      public_token uuid not null default gen_random_uuid(),
      payment_status text not null default 'not_required',
      created_at timestamptz not null default now()
    );
    create table public.merchant_notification_profile (
      restaurant_id uuid primary key, sender_name text, sender_email text, reply_to text
    );
    ${N1A_TABLE}
    ${N1A_CLAIM}
    revoke all on function public.claim_pending_notifications(integer, integer) from public, anon, authenticated;
    grant execute on function public.claim_pending_notifications(integer, integer) to service_role;
  `);
  applyFile(url, "lot.sql", LOT);

  const setup = new Psql(url);
  const rest = (await setup.run("insert into public.restaurants default values returning id;")).split("\n")[0]!;
  await setup.run(`insert into public.merchant_notification_profile values ('${rest}'::uuid, 'Au Lait Cru', 'contact@example.test', null);`);
  const orderRow = (await setup.run(`insert into public.orders (restaurant_id) values ('${rest}'::uuid) returning id || '|' || public_token;`)).split("\n")[0]!;
  const [orderId, token] = orderRow.split("|") as [string, string];
  const outboxId = (await setup.run(
    `insert into public.notification_outbox (restaurant_id, order_id, notification_type, recipient_email, locale, payload_snapshot, status)
       values ('${rest}'::uuid, '${orderId}'::uuid, 'order_received', 'client@example.test', 'fr', '{}'::jsonb, 'pending') returning id;`)).split("\n")[0]!;
  setup.close();
  return { url, orderId, token, outboxId, open: () => new Psql(url) };
}

const FLIP_TO_REQUIRED = (id: string) =>
  `select id from public.orders where id = '${id}'::uuid for update;\n` +
  `update public.orders set payment_status = 'required' where id = '${id}'::uuid and payment_status = 'not_required';`;
const FINALIZE = (s: Scenario) => `select payment_status || '|' || coalesce(payment_mode_final, 'NULL') from public.finalize_order_payment_mode_none('${s.orderId}'::uuid, '${s.token}'::uuid);`;
const CLAIM = "select outbox_id from public.claim_pending_notifications(10, 60);";
const STATE = (s: Scenario) => `select payment_status || '|' || coalesce(payment_mode_final, 'NULL') from public.orders where id = '${s.orderId}'::uuid;`;
const OUTBOX = (s: Scenario) => `select status || '|' || attempt_count from public.notification_outbox where id = '${s.outboxId}'::uuid;`;
const lines = (out: string) => out.split("\n").map((l) => l.trim()).filter((l) => l !== "");

test("[172-PGRACE-A] required GAGNE (verrou tenu, non validé) : finalize ATTEND réellement, une réclamation concurrente ne voit rien (0), puis finalize voit required/online ; aucun e-mail", { skip: SKIP_REASON }, async () => {
  const s = await newScenario();
  const [holder, waiter, observer] = [s.open(), s.open(), s.open()];
  const waiterPid = await waiter.pid();

  await holder.run("begin;");
  await holder.run(FLIP_TO_REQUIRED(s.orderId));              // verrou de ligne tenu, required NON validé
  const pending = waiter.run(FINALIZE(s));                      // se bloque
  const waitEvent = await waitUntilLockWaiting(observer, waiterPid);
  assert.match(waitEvent, /^Lock:/, "finalize est réellement bloqué sur un verrou");

  // Connexion distincte, transaction distincte : l'état non validé est invisible et la porte est fermée.
  assert.deepEqual(lines(await observer.run(CLAIM)), [], "claim concurrent : 0 ligne pendant que required n'est pas validé");
  assert.deepEqual(lines(await observer.run(STATE(s))), ["not_required|NULL"], "l'état validé est inchangé pour les autres transactions");

  await holder.run("commit;");
  assert.deepEqual(lines(await pending), ["required|online"], "finalize reprend et voit required/online");
  assert.deepEqual(lines(await observer.run(CLAIM)), [], "aucun e-mail réclamé");
  assert.deepEqual(lines(await observer.run(OUTBOX(s))), ["pending|0"], "la notification reste récupérable, aucune tentative consommée");
});

test("[172-PGRACE-B] finalize GAGNE (verrou tenu, non validé) : le passage à required ATTEND réellement, puis est REFUSÉ (SCANYM_PAYMENT_MODE_FINAL) ; la réclamation légitime part UNE seule fois", { skip: SKIP_REASON }, async () => {
  const s = await newScenario();
  const [holder, waiter, observer] = [s.open(), s.open(), s.open()];
  const waiterPid = await waiter.pid();

  await holder.run("begin;");
  assert.deepEqual(lines(await holder.run(FINALIZE(s))), ["not_required|none"]);   // décision posée, NON validée
  const pending = waiter.run(`begin;\n${FLIP_TO_REQUIRED(s.orderId)}`);              // se bloque sur le verrou de ligne
  await waitUntilLockWaiting(observer, waiterPid);

  assert.deepEqual(lines(await observer.run(CLAIM)), [], "décision non validée : porte encore fermée pour les autres transactions");

  await holder.run("commit;");
  const flipOut = await pending;
  assert.match(flipOut, /SCANYM_PAYMENT_MODE_FINAL/, "le passage à required est refusé une fois le mode final");
  await waiter.run("rollback;");
  assert.deepEqual(lines(await observer.run(STATE(s))), ["not_required|none"]);

  const claimed = lines(await observer.run(CLAIM));
  assert.deepEqual(claimed, [s.outboxId], "exactement une réclamation légitime");
  assert.deepEqual(lines(await observer.run(CLAIM)), [], "pas de second envoi");
});

test("[172-PGRACE-C] required tenu puis ROLLBACK : finalize attend, puis décide « sans paiement » ; la réclamation part ensuite", { skip: SKIP_REASON }, async () => {
  const s = await newScenario();
  const [holder, waiter, observer] = [s.open(), s.open(), s.open()];
  const waiterPid = await waiter.pid();

  await holder.run("begin;");
  await holder.run(FLIP_TO_REQUIRED(s.orderId));
  const pending = waiter.run(FINALIZE(s));
  await waitUntilLockWaiting(observer, waiterPid);
  await holder.run("rollback;");
  assert.deepEqual(lines(await pending), ["not_required|none"]);
  assert.deepEqual(lines(await observer.run(CLAIM)), [s.outboxId]);
});

test("[172-PGRACE-D] finalize tenu puis ROLLBACK : le passage à required attend, puis RÉUSSIT (mode online) ; aucun e-mail", { skip: SKIP_REASON }, async () => {
  const s = await newScenario();
  const [holder, waiter, observer] = [s.open(), s.open(), s.open()];
  const waiterPid = await waiter.pid();

  await holder.run("begin;");
  assert.deepEqual(lines(await holder.run(FINALIZE(s))), ["not_required|none"]);
  const pending = waiter.run(FLIP_TO_REQUIRED(s.orderId));
  await waitUntilLockWaiting(observer, waiterPid);
  await holder.run("rollback;");
  await pending;
  assert.deepEqual(lines(await observer.run(STATE(s))), ["required|online"]);
  assert.deepEqual(lines(await observer.run(CLAIM)), []);
  assert.deepEqual(lines(await observer.run(OUTBOX(s))), ["pending|0"]);
});

test("[172-PGRACE-E] deux workers concurrents : un claim tenu (non validé), le second ne ATTEND pas (SKIP LOCKED) et ne réclame rien ; une seule réclamation au total", { skip: SKIP_REASON }, async () => {
  const s = await newScenario();
  const [w1, w2, admin] = [s.open(), s.open(), s.open()];
  assert.deepEqual(lines(await admin.run(FINALIZE(s))), ["not_required|none"]);

  await w1.run("begin;");
  assert.deepEqual(lines(await w1.run(CLAIM)), [s.outboxId], "le premier worker réclame la ligne (transaction ouverte)");
  assert.deepEqual(lines(await w2.run(CLAIM)), [], "le second worker saute la ligne verrouillée au lieu d'attendre");
  await w1.run("commit;");
  assert.deepEqual(lines(await w2.run(CLAIM)), [], "ligne déjà 'processing' : jamais réclamée deux fois");
  assert.deepEqual(lines(await admin.run(OUTBOX(s))), ["processing|0"]);
});

after(async () => {
  for (const s of sessions) s.close();
  await sleep(200);
  if (ADMIN_URL && databases.length > 0) {
    for (const db of databases) {
      spawnSync(PSQL, ["-X", "-q", ADMIN_URL, "-c", `drop database if exists ${db} with (force)`], { encoding: "utf8" });
    }
  }
  rmSync(workDir, { recursive: true, force: true });
});
