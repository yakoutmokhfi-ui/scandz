#!/usr/bin/env node
/**
 * One-shot, local Monetico TEST credential provisioner for Scanym.
 *
 * Safety properties:
 * - Node built-ins only; no package install and no .env/file writes.
 * - All prompts are interactive; service-role key and Monetico key are hidden.
 * - HTTPS requests are restricted to the known Scanym Supabase project.
 * - Refuses to overwrite any existing Monetico config.
 * - Calls the existing server-only setter with mode="test" only.
 * - Never prints the credential, request body, or raw server errors.
 * - Does not enable checkout or create a payment/order.
 */

import readline from "node:readline";
import { pathToFileURL } from "node:url";

export const EXPECTED_PROJECT_REF = "ctqfpszwunfomrbxgigu";
export const EXPECTED_RESTAURANT_ID = "e8647a29-4971-4629-a5e8-1f00650adfb4";
export const EXPECTED_SLUG = "au-lait-cru";

export function validateCredential({ tpe, societe, securityKey }) {
  if (typeof tpe !== "string" || !/^[A-Za-z0-9]{7}$/.test(tpe)) {
    throw new Error("INVALID_TPE");
  }
  if (typeof societe !== "string" || societe.length < 1 || societe.length > 64 || !/^[\x20-\x7E]+$/.test(societe)) {
    throw new Error("INVALID_SOCIETE");
  }
  if (typeof securityKey !== "string" || !/^[0-9A-Fa-f]{40}$/.test(securityKey)) {
    throw new Error("INVALID_SECURITY_KEY");
  }
  return { tpe, societe, securityKey: securityKey.toLowerCase() };
}

export function validateSupabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("INVALID_SUPABASE_URL");
  }
  if (url.protocol !== "https:" || url.hostname !== `${EXPECTED_PROJECT_REF}.supabase.co` || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("WRONG_SUPABASE_PROJECT");
  }
  return url.origin;
}

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function hiddenPrompt(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("INTERACTIVE_TTY_REQUIRED");
  }
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let value = "";
    const wasRaw = input.isRaw;
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(wasRaw ?? false);
      input.pause();
    };
    const onData = (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") {
          cleanup();
          process.stdout.write("\nSaisie annulée.\n");
          reject(new Error("CANCELLED"));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= " " && char !== "\u007f") value += char;
      }
    };
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function responseJson(response, code) {
  if (!response.ok) throw new Error(`${code}_HTTP_${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${code}_INVALID_RESPONSE`);
  }
}

export async function provisionTestCredential({ supabaseUrl, serviceRoleKey, credential, fetchImpl = fetch }) {
  const origin = validateSupabaseUrl(supabaseUrl);
  if (typeof serviceRoleKey !== "string" || serviceRoleKey.length < 20) throw new Error("INVALID_SERVICE_KEY");
  const parsed = validateCredential(credential);
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    Accept: "application/json",
  };
  const request = (url, init = {}) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });

  const restaurantResponse = await request(
    `${origin}/rest/v1/restaurants?slug=eq.${EXPECTED_SLUG}&select=id,name,slug`,
    { headers },
  );
  const restaurants = await responseJson(restaurantResponse, "RESTAURANT_LOOKUP");
  if (!Array.isArray(restaurants) || restaurants.length !== 1 ||
      restaurants[0]?.id !== EXPECTED_RESTAURANT_ID || restaurants[0]?.slug !== EXPECTED_SLUG) {
    throw new Error("RESTAURANT_IDENTITY_CHECK_FAILED");
  }

  const configResponse = await request(
    `${origin}/rest/v1/payment_provider_configs?restaurant_id=eq.${EXPECTED_RESTAURANT_ID}&provider_code=eq.monetico&select=provider_code,mode,configuration_status,is_enabled`,
    { headers },
  );
  const configs = await responseJson(configResponse, "CONFIG_LOOKUP");
  if (!Array.isArray(configs)) throw new Error("CONFIG_LOOKUP_INVALID_RESPONSE");
  if (configs.length !== 0) throw new Error("MONETICO_CONFIG_ALREADY_EXISTS");

  const rpcResponse = await request(`${origin}/rest/v1/rpc/set_payment_provider_credentials`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({
      p_restaurant_id: EXPECTED_RESTAURANT_ID,
      p_provider_code: "monetico",
      p_secret: JSON.stringify(parsed),
      p_mode: "test",
    }),
  });
  const result = await responseJson(rpcResponse, "CREDENTIAL_WRITE");
  if (!Array.isArray(result) || result.length !== 1 || result[0]?.mode !== "test" ||
      result[0]?.configuration_status !== "configured" || result[0]?.provider_code !== "monetico") {
    throw new Error("CREDENTIAL_WRITE_UNEXPECTED_RESULT");
  }

  const verifyResponse = await request(
    `${origin}/rest/v1/payment_provider_configs?restaurant_id=eq.${EXPECTED_RESTAURANT_ID}&provider_code=eq.monetico&select=provider_code,mode,configuration_status,is_enabled`,
    { headers },
  );
  const verified = await responseJson(verifyResponse, "CONFIG_VERIFY");
  if (!Array.isArray(verified) || verified.length !== 1 ||
      verified[0]?.provider_code !== "monetico" || verified[0]?.mode !== "test" ||
      verified[0]?.configuration_status !== "configured" || verified[0]?.is_enabled !== false) {
    throw new Error("CONFIG_VERIFY_UNEXPECTED_RESULT");
  }
  return { provider: "monetico", mode: "test", configurationStatus: "configured", enabled: false };
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("INTERACTIVE_TTY_REQUIRED");
  process.stdout.write("Configuration ponctuelle Monetico — ENVIRONNEMENT TEST uniquement.\n");
  process.stdout.write("La clé et le service-role ne seront pas affichés ni enregistrés dans un fichier.\n\n");

  const supabaseUrl = process.env.SUPABASE_URL || await ask("URL Supabase Scanym (Settings → API) : ");
  validateSupabaseUrl(supabaseUrl);
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || await hiddenPrompt("Clé service_role Supabase (saisie masquée) : ");
  const tpe = (await ask("TPE Monetico [35VV71I] : ")) || "35VV71I";
  const societe = (await ask("Code société [aulaitcru — redirection hébergée] : ")) || "aulaitcru";
  const securityKey = await hiddenPrompt("Clé de sécurité Monetico (40 caractères, saisie masquée) : ");
  const credential = validateCredential({ tpe, societe, securityKey });

  process.stdout.write("\nVérification du projet, de l'établissement et de l'absence de configuration existante…\n");
  const result = await provisionTestCredential({ supabaseUrl, serviceRoleKey, credential });
  process.stdout.write(`Terminé : ${result.provider}, mode ${result.mode}, statut ${result.configurationStatus}, activé=${result.enabled}.\n`);
  process.stdout.write("Aucun paiement ni aucune commande n'a été créé. Le checkout reste inactif.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = typeof error?.message === "string" ? error.message : "UNKNOWN_ERROR";
    process.stderr.write(`Configuration interrompue (${code}). Aucune clé n'a été affichée.\n`);
    process.exitCode = 1;
  });
}
