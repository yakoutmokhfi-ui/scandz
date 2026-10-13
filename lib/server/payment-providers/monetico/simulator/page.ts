import "server-only";
import type { VerifiedInboundRequest } from "@/lib/server/payment-providers/monetico/simulator/inbound";
import { listScenarios } from "@/lib/server/payment-providers/monetico/simulator/scenarios";
import { SIMULATOR_DECIDE_PATH } from "@/lib/server/payment-providers/monetico/simulator/policy";

/**
 * MONETICO PAYMENT SIMULATOR v1 — SIMULATED HOSTED PAYMENT PAGE (HTML).
 *
 * Pure rendering. Displays ONLY what the real Monetico page would show
 * the customer (merchant, amount, reference) plus the operator scenario
 * selector. NEVER renders the MAC, the security key, the TPE secret
 * material, nor any Vault reference. All interpolated values are
 * HTML-escaped.
 */

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface RenderHostedPageInput {
  verified: VerifiedInboundRequest;
  binding: string;
  merchantLabel: string;
}

export function renderHostedPage(input: RenderHostedPageInput): string {
  const { verified, binding, merchantLabel } = input;
  const options = listScenarios()
    .map(
      (s) =>
        `<option value="${escapeHtml(s.id)}">${escapeHtml(s.label)} — ${escapeHtml(s.id)}</option>`
    )
    .join("");
  const descriptions = listScenarios()
    .map(
      (s) =>
        `<li><code>${escapeHtml(s.id)}</code> — ${escapeHtml(s.description)}<br><small>Attendu : ${escapeHtml(
          s.expected
        )}</small></li>`
    )
    .join("");

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>SCANYM — Simulateur Monetico (non-production)</title>
<style>
body{font-family:system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#222}
.banner{background:#b00020;color:#fff;padding:.75rem 1rem;border-radius:6px;font-weight:600}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem}dt{font-weight:600}
fieldset{margin-top:1.5rem;border:1px solid #ccc;border-radius:6px;padding:1rem}
label{display:block;margin:.5rem 0 .25rem}select,input{width:100%;padding:.5rem;font-size:1rem}
button{margin-top:1rem;padding:.6rem 1.2rem;font-size:1rem;cursor:pointer}
details{margin-top:1.5rem}li{margin:.4rem 0}
</style></head><body>
<div class="banner">SIMULATEUR DE PAIEMENT — ENVIRONNEMENT NON PRODUCTION — AUCUN PAIEMENT RÉEL</div>
<h1>Paiement simulé</h1>
<p>Cette page tient le rôle de la page de paiement hébergée Monetico. La requête du marchand a été <strong>vérifiée</strong> (TPE, société, format, signature) exactement comme le ferait le TPE réel.</p>
<dl>
<dt>Marchand</dt><dd>${escapeHtml(merchantLabel)}</dd>
<dt>TPE</dt><dd>${escapeHtml(verified.tpe)}</dd>
<dt>Référence</dt><dd><code>${escapeHtml(verified.reference)}</code></dd>
<dt>Montant</dt><dd>${escapeHtml(verified.amount)} ${escapeHtml(verified.currency)}</dd>
<dt>Date</dt><dd>${escapeHtml(verified.date)}</dd>
<dt>Langue</dt><dd>${escapeHtml(verified.language)}</dd>
</dl>
<form method="post" action="${escapeHtml(SIMULATOR_DECIDE_PATH)}">
<fieldset><legend>Issue du paiement (opérateur)</legend>
<input type="hidden" name="reference" value="${escapeHtml(verified.reference)}">
<input type="hidden" name="url_retour_ok" value="${escapeHtml(verified.urlRetourOk)}">
<input type="hidden" name="url_retour_err" value="${escapeHtml(verified.urlRetourErr)}">
<input type="hidden" name="binding" value="${escapeHtml(binding)}">
<label for="scenario">Scénario</label>
<select id="scenario" name="scenario" required>${options}</select>
<label for="operatorSecret">Secret opérateur du simulateur</label>
<input id="operatorSecret" name="operatorSecret" type="password" autocomplete="off" required>
<button type="submit">Appliquer le scénario</button>
</fieldset></form>
<details><summary>Description des scénarios</summary><ul>${descriptions}</ul></details>
</body></html>`;
}

export function renderRejectionPage(reason: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Simulateur Monetico — requête refusée</title></head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:2rem auto"><h1>Requête de paiement refusée</h1>
<p>Le simulateur a refusé la requête du marchand : <code>${escapeHtml(reason)}</code>.</p>
<p>C'est le comportement attendu du TPE réel pour une requête mal formée ou mal signée.</p></body></html>`;
}
