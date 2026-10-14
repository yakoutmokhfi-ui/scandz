/**
 * MONETICO PAYMENT SIMULATOR v1.2 — INDEPENDENT CONSUMER PROCESS (TEST ONLY).
 *
 * Runs the v1.2 `consumeDecisionToken` code path (session.ts ->
 * authority.ts -> client.rpc) in a SEPARATE NODE PROCESS, with the
 * Supabase client's `rpc` redirected to the shared PGlite server. Each
 * process is a distinct "Vercel instance": nothing in memory is shared
 * with the others. Prints one JSON line with the outcome.
 *
 * argv: <port> <nonce> <reference> <urlOk> <urlErr> [count]
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./alias-loader.mjs", pathToFileURL("./tests/"));

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://simtestproj00001.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "synthetic.service.role.key.DO-NOT-USE";

const [port, nonce, reference, urlOk, urlErr, countRaw] = process.argv.slice(2);
const count = Number(countRaw ?? 1);

const { getServiceRoleSupabaseClient } = await import("../../lib/server/supabase-admin.ts");
const client = getServiceRoleSupabaseClient();
client.rpc = async (name, args) => {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, { method: "POST", body: JSON.stringify({ name, args }) });
  return res.json();
};

const { consumeDecisionToken } = await import("../../lib/server/payment-providers/monetico/simulator/session.ts");

// `count` simultaneous consumptions from THIS process (in-flight at once).
const results = await Promise.all(
  Array.from({ length: count }, () => consumeDecisionToken({ token: nonce, expected: { reference, urlRetourOk: urlOk, urlRetourErr: urlErr } }))
);
process.stdout.write(JSON.stringify({ pid: process.pid, results }) + "\n");
