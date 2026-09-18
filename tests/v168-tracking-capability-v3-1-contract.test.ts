import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

// ====================================================================
// Scanym — CUSTOMER TRACKING v3.1 — contrat de sécurité STATIQUE.
//
// Complète la preuve COMPORTEMENTALE PostgreSQL réelle
// (supabase/tests/customer-tracking-capability-v3-1-check.sh) et les
// tests unitaires du service/de la route/de la session
// (tests/v122d, v122e, v122f) par des invariants de SOURCE :
//   - lecture à 3 arguments, prédicat lié à la commande, aucune
//     variante non liée ;
//   - échange legacy one-shot : verrou de la commande, réservation sans
//     secret réutilisée/créée, claim unique, aucun rejeu émetteur ;
//   - aucune dérive de create_order / get_order_tracking ;
//   - public_token confiné au corps POST de l'échange.
// ====================================================================

const SQL_PATH = "supabase/DRAFT-lot-customer-tracking-capability-v3-1.sql";
const ROLLBACK_PATH = "supabase/DRAFT-lot-customer-tracking-capability-v3-1-rollback.sql";

function stripSqlComments(src: string): string {
  return src.replace(/--.*$/gm, "");
}

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create function public.${name}(`);
  assert.ok(start >= 0, `create function public.${name} introuvable`);
  const bodyStart = sql.indexOf("as $$", start);
  const bodyEnd = sql.indexOf("$$;", bodyStart + 5);
  assert.ok(bodyStart > 0 && bodyEnd > bodyStart, `corps de ${name} introuvable`);
  return sql.slice(start, bodyEnd);
}

const sqlRaw = readFileSync(SQL_PATH, "utf8");
const sql = stripSqlComments(sqlRaw);

test("v3.1 SQL : les fichiers migration + rollback existent", () => {
  assert.ok(existsSync(SQL_PATH));
  assert.ok(existsSync(ROLLBACK_PATH));
});

test("v3.1 SQL : lecture = get_order_tracking_by_capability(p_order_id uuid, p_capability_id uuid, p_secret text), UNE seule définition", () => {
  const defs = sql.match(/create (or replace )?function public\.get_order_tracking_by_capability\s*\(/g) ?? [];
  assert.equal(defs.length, 1);
  assert.match(
    sql,
    /create function public\.get_order_tracking_by_capability\(\s*p_order_id uuid,\s*p_capability_id uuid,\s*p_secret text\s*\)/
  );
});

test("v3.1 SQL : le prédicat de lecture LIE la capacité à la commande demandée et vérifie le hash du secret", () => {
  const body = functionBody(sql, "get_order_tracking_by_capability");
  assert.match(body, /c\.id = p_capability_id/);
  assert.match(body, /c\.order_id = p_order_id/);
  assert.match(body, /o\.id = p_order_id/);
  assert.match(body, /c\.secret_hash is not null/);
  assert.match(body, /c\.secret_hash = pg_catalog\.sha256\(pg_catalog\.convert_to\(p_secret, 'UTF8'\)\)/);
  assert.match(body, /security definer/);
  assert.match(body, /set search_path = ''/);
  assert.match(body, /\bstable\b/);
  assert.equal(/\b(insert|update|delete)\b/i.test(body.split("as $$")[1]!), false, "la lecture ne doit jamais écrire");
});

test("v3.1 SQL : la lecture retourne bound_order_id EN PREMIER puis exactement les 13 colonnes de get_order_tracking", () => {
  const body = functionBody(sql, "get_order_tracking_by_capability");
  const returns = body.match(/returns table \(([\s\S]*?)\)\s*language/)![1]!;
  const cols = returns.split(",").map((c) => c.trim().split(/\s+/)[0]);
  assert.deepEqual(cols, [
    "bound_order_id",
    "order_status",
    "service_mode",
    "order_number",
    "created_at",
    "accepted_at",
    "preparing_at",
    "ready_at",
    "completed_at",
    "rejected_at",
    "cancelled_at",
    "order_total",
    "order_currency",
    "invoice_requested",
  ]);
  assert.equal(/payment|customer_|delivery_address|restaurant_id|public_token|secret_hash/.test(returns), false);
});

test("v3.1 SQL : AUCUNE variante de lecture non liée (capability_id + secret sans order_id) n'est définie", () => {
  const fnDefs = [...sql.matchAll(/create (?:or replace )?function public\.([a-z_]+)\(([^)]*)\)/g)];
  for (const [, name, args] of fnDefs) {
    const hasCap = /p_capability_id/.test(args!);
    if (hasCap) {
      assert.match(args!, /p_order_id uuid/, `${name} accepte une capacité sans p_order_id`);
    }
  }
  assert.deepEqual(
    fnDefs.map((m) => m[1]).sort(),
    ["get_order_tracking_by_capability", "issue_order_email_tracking_capability", "upgrade_legacy_tracking_capability"]
  );
});

test("v3.1 SQL : upgrade_legacy_tracking_capability(p_order_id uuid, p_public_token uuid) -- verrou de commande, réservation, claim unique, aucune réémission", () => {
  assert.match(
    sql,
    /create function public\.upgrade_legacy_tracking_capability\(\s*p_order_id uuid,\s*p_public_token uuid\s*\)/
  );
  const body = functionBody(sql, "upgrade_legacy_tracking_capability");
  // Preuve legacy + verrou de la ligne commande AVANT toute lecture de capacité.
  const lockIdx = body.search(/o\.public_token = p_public_token\s*for update;/);
  const capReadIdx = body.indexOf("from public.order_tracking_capabilities c");
  assert.ok(lockIdx > 0, "la ligne orders doit être verrouillée FOR UPDATE avec la preuve legacy");
  assert.ok(capReadIdx > lockIdx, "le verrou commande doit précéder la lecture de capacité");
  // Réutilise la réservation existante, sinon la crée SANS secret.
  // Seule la capacité LEGACY compte : une capacité e-mail n'est jamais
  // prise pour un claim (ni ne le bloque).
  assert.match(body, /where c\.order_id = v_order_id\s*and c\.kind = 'legacy_upgrade'\s*for update;/);
  assert.match(body, /insert into public\.order_tracking_capabilities \(order_id, kind\)\s*values \(v_order_id, 'legacy_upgrade'\)/);
  // Rejeu : déjà réclamée -> retour vide AVANT toute génération de secret.
  const replayIdx = body.search(/if v_secret_hash is not null then\s*return;/);
  const mintIdx = body.indexOf("gen_random_uuid()");
  assert.ok(replayIdx > 0 && mintIdx > replayIdx, "le rejeu doit sortir avant toute génération de secret");
  // Claim unique : seule une réservation encore sans secret peut être réclamée.
  assert.match(body, /where id = v_cap_id\s*and kind = 'legacy_upgrade'\s*and secret_hash is null;/);
  assert.match(body, /if not found then\s*return;/);
  // Aucune rotation : aucune mise à jour de secret_hash sans garde "is null".
  const updates = body.match(/update public\.order_tracking_capabilities[\s\S]*?;/g) ?? [];
  assert.equal(updates.length, 1, "une seule mise à jour (le claim) est autorisée");
  assert.match(updates[0]!, /secret_hash is null/);
  assert.equal(/delete\s+from/i.test(body), false, "aucune suppression/réémission");
  assert.match(body, /security definer/);
  assert.match(body, /set search_path = ''/);
});

test("v3.1 SQL : table privée -- une capacité LEGACY par commande, claim atomique, aucun secret en clair stocké, aucun accès API direct", () => {
  assert.match(
    sql,
    /create unique index order_tracking_capabilities_one_legacy_per_order\s*on public\.order_tracking_capabilities \(order_id\)\s*where kind = 'legacy_upgrade';/
  );
  assert.match(sql, /check \(kind in \('legacy_upgrade', 'email'\)\)/);
  // Une capacité e-mail est toujours née réclamée ET bornée ; la legacy
  // n'expire jamais côté SQL.
  assert.match(
    sql,
    /\(kind = 'email' and secret_hash is not null and expires_at is not null\)\s*or \(kind = 'legacy_upgrade' and expires_at is null\)/
  );
  assert.match(sql, /check \(\(secret_hash is null\) = \(claimed_at is null\)\)/);
  assert.match(sql, /octet_length\(secret_hash\) = 32/);
  assert.match(sql, /alter table public\.order_tracking_capabilities enable row level security;/);
  assert.match(sql, /revoke all on table public\.order_tracking_capabilities from public, anon, authenticated, service_role;/);
  const table = sql.match(/create table public\.order_tracking_capabilities \(([\s\S]*?)\n\);/)![1]!;
  assert.equal(/\bsecret\s+text\b/.test(table), false, "le secret ne doit jamais être stocké en clair");
  assert.equal(/grant\s+[a-z, ]+\s+on\s+table\s+public\.order_tracking_capabilities/i.test(sql), false);
});

test("v3.1 SQL : grants EXECUTE anon+authenticated uniquement, PUBLIC révoqué, post-vérification ACL présente", () => {
  for (const sig of [
    "public.get_order_tracking_by_capability(uuid, uuid, text)",
    "public.upgrade_legacy_tracking_capability(uuid, uuid)",
  ]) {
    assert.ok(sql.includes(`revoke all on function ${sig} from public;`), `revoke manquant pour ${sig}`);
    assert.ok(sql.includes(`grant execute on function ${sig} to anon, authenticated;`), `grant manquant pour ${sig}`);
  }
  assert.match(sql, /has_function_privilege\('public', 'public\.get_order_tracking_by_capability/);
});

test("v3.1 SQL : issue_order_email_tracking_capability -- service_role UNIQUEMENT, née réclamée, hash seul, expiration 30 j, plafond, verrou commande", () => {
  const sig = "public.issue_order_email_tracking_capability(uuid)";
  assert.ok(sql.includes(`revoke all on function ${sig} from public, anon, authenticated;`));
  assert.ok(sql.includes(`grant execute on function ${sig} to service_role;`));
  assert.equal(new RegExp(`grant execute on function ${sig.replace(/[().]/g, "\\$&")} to [^;]*(anon|authenticated)`).test(sql), false);
  assert.match(sql, /has_function_privilege\('anon', 'public\.issue_order_email_tracking_capability\(uuid\)', 'execute'\)/);

  const body = functionBody(sql, "issue_order_email_tracking_capability");
  assert.match(body, /create function public\.issue_order_email_tracking_capability\(\s*p_order_id uuid\s*\)/);
  assert.match(body, /where o\.id = p_order_id\s*for update;/);
  assert.match(body, /c\.kind = 'email'/);
  assert.match(body, /if v_count >= 16 then\s*return;/);
  assert.match(body, /'email',\s*pg_catalog\.sha256\(pg_catalog\.convert_to\(v_secret, 'UTF8'\)\),\s*pg_catalog\.now\(\),\s*pg_catalog\.now\(\) \+ interval '30 days'/);
  // Jamais de mise à jour/suppression d'une capacité existante : aucune
  // rotation d'un lien déjà envoyé.
  // (le seul "update" admis est le verrou `for update` de la commande)
  assert.equal(/\b(update|delete)\b/i.test(body.split("as $$")[1]!.replace(/for update;/g, "")), false);
  assert.match(body, /security definer/);
  assert.match(body, /set search_path = ''/);
});

test("v3.1 SQL : la lecture refuse une capacité e-mail EXPIRÉE (borne SQL autoritaire)", () => {
  const body = functionBody(sql, "get_order_tracking_by_capability");
  assert.match(body, /and \(c\.expires_at is null or c\.expires_at > pg_catalog\.now\(\)\)/);
});

test("v3.1 SQL : AUCUNE dérive de create_order / get_order_tracking / mark_whatsapp_opened / update_order_status (jamais créées, remplacées, supprimées ni re-grantées)", () => {
  for (const fn of ["create_order", "get_order_tracking", "mark_whatsapp_opened", "update_order_status"]) {
    const re = new RegExp(`(create|drop|alter)\\s+(or\\s+replace\\s+)?function\\s+(if\\s+exists\\s+)?public\\.${fn}\\s*\\(`, "i");
    assert.equal(re.test(sql), false, `${fn} ne doit pas être modifiée`);
    const grantRe = new RegExp(`(grant|revoke)[^;]*function\\s+public\\.${fn}\\s*\\(`, "i");
    assert.equal(grantRe.test(sql), false, `les droits de ${fn} ne doivent pas être modifiés`);
  }
  assert.equal(/alter\s+table\s+public\.orders/i.test(sql), false, "public.orders ne doit pas être modifiée");
  assert.match(sql, /^begin;/m);
  assert.match(sql, /^commit;/m);
});

test("v3.1 SQL rollback : supprime exactement les objets v3.1, rien d'autre", () => {
  const rb = stripSqlComments(readFileSync(ROLLBACK_PATH, "utf8"));
  const drops = [...rb.matchAll(/drop (function|table) ([^;]+);/g)].map((m) => `${m[1]} ${m[2]!.trim()}`);
  assert.deepEqual(drops, [
    "function public.issue_order_email_tracking_capability(uuid)",
    "function public.upgrade_legacy_tracking_capability(uuid, uuid)",
    "function public.get_order_tracking_by_capability(uuid, uuid, text)",
    "table public.order_tracking_capabilities",
  ]);
  assert.equal(/get_order_tracking\(|create_order/.test(rb), false);
});

// --------------------------------------------------------------------
// Confinement applicatif du public_token legacy.
// --------------------------------------------------------------------

test("v3.1 app : la session de suivi ne porte plus jamais public_token (cookie = capacité liée à la commande)", () => {
  const src = readFileSync("lib/server/tracking-session.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.equal(/publicToken|public_token/.test(code), false);
  assert.match(code, /capabilityId/);
});

test("v3.1 app : la page de suivi ne lit jamais public_token et ne lit le suivi que par capacité", () => {
  const src = readFileSync("app/track/[orderId]/page.tsx", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/gm, "");
  assert.equal(/publicToken|public_token/.test(code), false);
  assert.match(code, /capabilityId: session\.capabilityId/);
});

test("v3.1 app : la route d'échange lit public_token UNIQUEMENT depuis le corps JSON POST, et n'exporte que POST", () => {
  const src = readFileSync("app/api/track/exchange/route.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.match(code, /body\.publicToken/);
  assert.match(code, /body\.capabilityId/);
  assert.match(code, /body\.secret/);
  assert.equal(/searchParams|nextUrl|request\.url|cookies\.get/.test(code), false, "le matériel de possession ne doit jamais être lu depuis l'URL/la query/un cookie");
  // v3.1 : seuls des en-têtes de TRANSPORT (garde CSRF) sont lus.
  const headerNames = [...code.matchAll(/headers\.get\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(headerNames, ["content-type", "host", "origin", "sec-fetch-site"]);
  assert.equal(/headers\.get\(\s*[^"]/.test(code), false, "aucune lecture d'en-tête dynamique");
  const exported = [...code.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(exported, ["POST"]);
  assert.equal(/console\./.test(code), false, "aucune journalisation dans la route");
  // La capacité n'est jamais renvoyée dans le corps de réponse.
  assert.match(code, /NextResponse\.json\(\{ ok: true \}\)/);
});

test("v3.1 app : le service n'appelle jamais la lecture legacy get_order_tracking(p_order_id, p_public_token)", () => {
  const src = readFileSync("lib/server/tracking-service.ts", "utf8");
  assert.equal(/rpc\(\s*["']get_order_tracking["']/.test(src), false);
  // p_public_token n'apparaît que dans l'appel d'échange one-shot.
  const occurrences = src.match(/p_public_token:/g) ?? [];
  assert.equal(occurrences.length, 1);
  const upgradeIdx = src.indexOf('supabase.rpc("upgrade_legacy_tracking_capability"');
  const tokenIdx = src.indexOf("p_public_token:");
  assert.ok(upgradeIdx > 0 && tokenIdx > upgradeIdx && tokenIdx - upgradeIdx < 200);
});
