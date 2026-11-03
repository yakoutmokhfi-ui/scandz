// Faux Supabase (PostgREST /rest/v1/rpc/*) pour les preuves NAVIGATEUR du suivi de
// commande (issue #210). DONNÉES 100 % SYNTHÉTIQUES, aucun accès réseau externe, aucune
// base réelle. Ne journalise JAMAIS un secret / jeton : uniquement le nom de la RPC,
// l'heure et l'issue. Le serveur Next.js de test pointe dessus via
// NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:<port>.
import http from "node:http";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";

const orders = new Map(); // orderId -> {status, number, createdAt, legacyToken, legacyClaimed, caps: Map(capId -> {secret, expired})}
const calls = []; // {t, rpc, outcome}
let mode = { fail: false, delayMs: 0 };

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
function row(orderId, o) {
  const at = (s) => (o.stamps[s] ? o.stamps[s] : null);
  return {
    bound_order_id: orderId,
    order_status: o.status,
    service_mode: "pickup",
    order_number: o.number,
    created_at: o.createdAt,
    accepted_at: at("accepted"),
    preparing_at: at("preparing"),
    ready_at: at("ready"),
    completed_at: at("completed"),
    rejected_at: at("rejected"),
    cancelled_at: at("cancelled"),
    order_total: 24.5,
    order_currency: "EUR",
    invoice_requested: false,
  };
}

export function startStub(port = Number(process.env.STUB_PORT || 54399)) {
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    // ---------- API de pilotage (test) ----------
    if (url.pathname === "/__ctl/seed" && req.method === "POST") {
      const b = await readBody(req);
      const orderId = b.orderId || randomUUID();
      const o = {
        status: b.status || "new",
        number: b.number || 4242,
        createdAt: new Date().toISOString(),
        stamps: {},
        legacyToken: b.legacyToken || randomUUID(),
        legacyClaimed: false,
        caps: new Map(),
      };
      const capabilityId = b.capabilityId || randomUUID();
      const secret = b.secret || randomBytes(32).toString("hex");
      o.caps.set(capabilityId, { secret, expired: false });
      orders.set(orderId, o);
      return json(res, 200, { orderId, legacyToken: o.legacyToken, capabilityId, secret });
    }
    if (url.pathname === "/__ctl/status" && req.method === "POST") {
      const b = await readBody(req);
      const o = orders.get(b.orderId);
      if (!o) return json(res, 404, { ok: false });
      o.status = b.status;
      o.stamps[b.status] = new Date().toISOString();
      return json(res, 200, { ok: true, status: o.status });
    }
    if (url.pathname === "/__ctl/expire" && req.method === "POST") {
      const b = await readBody(req);
      const o = orders.get(b.orderId);
      const c = o?.caps.get(b.capabilityId);
      if (!c) return json(res, 404, { ok: false });
      c.expired = true;
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/__ctl/mode" && req.method === "POST") {
      mode = { ...mode, ...(await readBody(req)) };
      return json(res, 200, mode);
    }
    if (url.pathname === "/__ctl/calls") {
      const since = Number(url.searchParams.get("since") || 0);
      return json(res, 200, calls.filter((c) => c.t >= since));
    }
    if (url.pathname === "/__ctl/reset-calls" && req.method === "POST") {
      calls.length = 0;
      return json(res, 200, { ok: true });
    }
    // ---------- PostgREST ----------
    const m = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_0-9]+)$/);
    if (!m || req.method !== "POST") return json(res, 404, { message: "not found" });
    const rpc = m[1];
    const b = await readBody(req);
    if (mode.delayMs) await new Promise((r) => setTimeout(r, mode.delayMs));
    const log = (outcome) => calls.push({ t: Date.now(), rpc, outcome });

    if (mode.fail) {
      log("outage");
      return json(res, 503, { code: "PGRST000", message: "synthetic outage" });
    }
    if (rpc === "get_order_tracking_by_capability") {
      const o = orders.get(b.p_order_id);
      const c = o?.caps.get(b.p_capability_id);
      if (!o || !c || c.expired || c.secret !== b.p_secret) {
        log("empty");
        return json(res, 200, []);
      }
      log("row:" + o.status);
      return json(res, 200, [row(b.p_order_id, o)]);
    }
    if (rpc === "upgrade_legacy_tracking_capability") {
      const o = orders.get(b.p_order_id);
      if (!o || o.legacyClaimed || o.legacyToken !== b.p_public_token) {
        log("empty");
        return json(res, 200, []);
      }
      o.legacyClaimed = true;
      const capabilityId = randomUUID();
      const secret = randomBytes(32).toString("hex");
      o.caps.set(capabilityId, { secret, expired: false });
      log("minted");
      return json(res, 200, [{ capability_id: capabilityId, capability_secret: secret }]);
    }
    // contexte client, texte de statut, rétractation : listes vides (échec fermé côté page)
    log("empty");
    return json(res, 200, []);
  } catch {
    return json(res, 500, { message: "stub error" });
  }
});
return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ port, close: () => new Promise((r) => server.close(r)) })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startStub();
  console.log(`stub supabase on :${port}`);
}
