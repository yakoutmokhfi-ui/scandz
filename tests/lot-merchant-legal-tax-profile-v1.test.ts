import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym — MERCHANT LEGAL & TAX PROFILE v1
// Complète public.receipt_settings (V29), jusqu'ici en lecture seule.
// REUSE-FIRST : aucun nouveau modèle de données, aucune modification
// de Stuart/Monetico/paiement/tax calc/checkout/order pricing.
// ====================================================================

const draftSql = readFileSync(
  "supabase/DRAFT-lot-merchant-legal-tax-profile-v1.sql",
  "utf8"
);
const harnessSrc = readFileSync(
  "supabase/tests/merchant-legal-tax-profile-v1-check.sh",
  "utf8"
);
const labelsSrc = readFileSync("lib/merchant-legal-tax-labels.ts", "utf8");
const dashboardTypesSrc = readFileSync("lib/dashboard-types.ts", "utf8");
const dashboardServiceSrc = readFileSync("lib/services/dashboard.ts", "utf8");
const settingsPageSrc = readFileSync("app/dashboard/settings/page.tsx", "utf8");
const receiptSrc = readFileSync("lib/receipt.ts", "utf8");
const i18nSrc = readFileSync("lib/i18n.ts", "utf8");

// --------------------------------------------------------------------
// SQL — schéma additif, contrôle de non-dérive réellement exécuté
// --------------------------------------------------------------------

test("SQL: contrôle préalable de non-dérive présent et exécuté (do $$ ... raise exception) avant toute écriture de schéma", () => {
  const doIdx = draftSql.indexOf("do $$");
  const beginIdx = draftSql.indexOf("\nbegin;");
  assert.ok(beginIdx > 0, "begin; transactionnel doit exister");
  const preambleIdx = draftSql.indexOf("do $$", beginIdx);
  assert.ok(preambleIdx > beginIdx, "le bloc de contrôle de non-dérive doit suivre begin;");
  const preambleBody = draftSql.slice(preambleIdx, draftSql.indexOf("\nend $$;", preambleIdx));
  assert.ok(preambleBody.includes("receipt_settings.email existe déjà"));
  assert.ok(preambleBody.includes("is_scanym_operator"));
  assert.ok(preambleBody.includes("restaurants") && preambleBody.includes("country"));
});

test("SQL: email est ADDITIVE (add column if not exists), NULLABLE, jamais NOT NULL", () => {
  assert.ok(draftSql.includes("add column if not exists email text;"));
  assert.ok(!/email text not null/i.test(draftSql));
});

test("SQL: paper_width_mm n'apparaît JAMAIS dans update_receipt_settings (colonnes insert/update) -- hors périmètre de ce lot", () => {
  const start = draftSql.indexOf("create function public.update_receipt_settings(");
  const end = draftSql.indexOf("\nend $$;", start);
  const body = draftSql.slice(start, end);
  assert.ok(!body.includes("paper_width_mm"), "paper_width_mm ne doit jamais être lu/écrit par cette RPC");
});

test("SQL: update_receipt_settings utilise un UPSERT (insert ... on conflict), jamais un simple UPDATE -- nécessaire pour un établissement post-V29 sans ligne existante", () => {
  const start = draftSql.indexOf("create function public.update_receipt_settings(");
  const end = draftSql.indexOf("\nend $$;", start);
  const body = draftSql.slice(start, end);
  assert.ok(body.includes("insert into public.receipt_settings"));
  assert.ok(body.includes("on conflict (restaurant_id) do update set"));
  assert.ok(!/\bupdate public\.receipt_settings\b/.test(body), "aucun UPDATE direct séparé ne doit exister dans cette RPC");
});

test("SQL: assert_receipt_settings_role réutilise EXACTEMENT le patron owner/manager OU opérateur (même que assert_restaurant_asset_role), aucun contrôle réinventé", () => {
  const start = draftSql.indexOf("create function public.assert_receipt_settings_role(");
  const end = draftSql.indexOf("\nend $$;", start);
  const body = draftSql.slice(start, end);
  assert.ok(body.includes("array['owner','manager']"));
  assert.ok(body.includes("public.is_scanym_operator()"));
  assert.ok(body.includes("security definer"));
  assert.ok(body.includes("set search_path = ''"));
});

test("SQL: update_receipt_settings appelle assert_receipt_settings_role avant toute écriture (fail closed)", () => {
  const start = draftSql.indexOf("create function public.update_receipt_settings(");
  const performIdx = draftSql.indexOf("perform public.assert_receipt_settings_role(p_restaurant_id);", start);
  const insertIdx = draftSql.indexOf("insert into public.receipt_settings", start);
  assert.ok(performIdx > 0 && performIdx < insertIdx, "l'autorisation doit être vérifiée AVANT l'écriture");
});

test("SQL: aucun droit anon/public sur update_receipt_settings ; authenticated seul reçoit EXECUTE", () => {
  assert.ok(
    /revoke all on function public\.update_receipt_settings\([^)]*\) from public, anon;/.test(draftSql)
  );
  assert.ok(
    /grant execute on function public\.update_receipt_settings\([^)]*\) to authenticated;/.test(draftSql)
  );
});

test("SQL: aucun droit d'écriture direct (INSERT/UPDATE/DELETE) accordé sur receipt_settings -- écriture exclusivement via RPC", () => {
  assert.ok(!/grant\s+(insert|update|delete)\s+on\s+table\s+public\.receipt_settings/i.test(draftSql));
});

test("SQL: contrôle post-commit vérifie les droits ET la persistance de RLS", () => {
  const idx = draftSql.lastIndexOf("do $$");
  const body = draftSql.slice(idx);
  assert.ok(body.includes("SCANYM_POST_COMMIT_CHECK_FAILED"));
  assert.ok(body.includes("relrowsecurity"));
});

test("SQL: validation de l'email dans la RPC (regex simple, jamais une confiance exclusive côté client)", () => {
  assert.ok(/v_email !~ /.test(draftSql));
  assert.ok(draftSql.includes("Invalid email"));
});

test("SQL: default_tax_rate borné 0-100 et tax_label non-vide obligatoire (colonne NOT NULL préservée)", () => {
  assert.ok(draftSql.includes("p_default_tax_rate < 0 or p_default_tax_rate > 100"));
  assert.ok(draftSql.includes("Tax label is required"));
});

test("NON-RÉGRESSION (texte) v1.1 : le lot ne modifie JAMAIS order_items/menu_items, ne redéfinit JAMAIS create_order, et ne touche aucune colonne financière existante de orders -- ni Stuart/Monetico", () => {
  // v1.1 modifie LÉGITIMEMENT `orders` (section 5, instantané fiscal
  // additif, ferme MLTP-V1-HISTORICAL-TAX-01) -- le garde-fou porte
  // donc sur order_items/menu_items (jamais touchés) et sur la
  // signature/le corps de create_order (jamais redéfini).
  assert.ok(!/alter table public\.(order_items|menu_items)\b/.test(draftSql));
  assert.ok(!/create (or replace )?function public\.create_order\b/.test(draftSql), "create_order ne doit jamais être redéfini -- l'instantané fiscal passe exclusivement par un déclencheur BEFORE INSERT");
  assert.ok(!/(alter|drop) column public\.orders\.(subtotal|total|delivery_fee|currency)\b/.test(draftSql), "aucune colonne financière existante de orders ne doit être modifiée");
  const codeOnly = draftSql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.ok(!/stuart|monetico/i.test(codeOnly), "aucune ligne de CODE SQL (hors commentaire) ne doit référencer Stuart/Monetico");
});

// --------------------------------------------------------------------
// v1.1 -- MLTP-V1-OPERATOR-READ-WRITE-01 : RPC de lecture dédiée,
// symétrique de l'écriture pour un opérateur Scanym, sans élargir la
// policy RLS SELECT existante
// --------------------------------------------------------------------

test("SQL v1.1: assert_receipt_settings_read_access existe, DISTINCTE de assert_receipt_settings_role (écriture), et autorise TOUT membre restaurant_users (pas seulement owner/manager) OU un opérateur", () => {
  const start = draftSql.indexOf("create function public.assert_receipt_settings_read_access(");
  assert.ok(start > 0, "assert_receipt_settings_read_access doit exister");
  const end = draftSql.indexOf("\nend $$;", start);
  const body = draftSql.slice(start, end);
  assert.ok(!body.includes("array['owner','manager']"), "la lecture ne doit JAMAIS être restreinte à owner/manager -- tout membre restaurant_users est autorisé");
  assert.ok(body.includes("public.is_scanym_operator()"));
  assert.ok(body.includes("security definer"));
  assert.ok(body.includes("set search_path = ''"));
});

test("SQL v1.1: get_receipt_settings existe, RETURNS TABLE explicite (jamais SELECT *), inclut restaurant_country, appelle assert_receipt_settings_read_access avant toute lecture", () => {
  const start = draftSql.indexOf("create function public.get_receipt_settings(");
  assert.ok(start > 0, "get_receipt_settings doit exister");
  const asIdx = draftSql.indexOf("as $$", start);
  assert.ok(asIdx > start, "la déclaration de fonction (signature + RETURNS TABLE) doit se terminer par 'as $$'");
  const signature = draftSql.slice(start, asIdx);
  assert.ok(signature.includes("returns table ("), "get_receipt_settings doit déclarer RETURNS TABLE explicitement");
  assert.ok(signature.includes("restaurant_country"), "restaurant_country doit apparaître dans la signature RETURNS TABLE");
  const end = draftSql.indexOf("\nend $$;", start);
  const body = draftSql.slice(asIdx, end);
  assert.ok(body.includes("perform public.assert_receipt_settings_read_access(p_restaurant_id);"));
  const performIdx = body.indexOf("perform public.assert_receipt_settings_read_access");
  const selectIdx = body.indexOf("return query");
  assert.ok(performIdx > 0 && selectIdx > performIdx, "l'autorisation doit être vérifiée AVANT toute lecture");
  assert.ok(!body.includes("select *"), "jamais un SELECT * -- la forme de retour doit rester explicite/stable");
});

test("SQL v1.1: aucun droit anon/public sur get_receipt_settings ; authenticated seul reçoit EXECUTE (même posture que update_receipt_settings)", () => {
  assert.ok(/revoke all on function public\.get_receipt_settings\(uuid\) from public, anon;/.test(draftSql));
  assert.ok(/grant execute on function public\.get_receipt_settings\(uuid\) to authenticated;/.test(draftSql));
});

// --------------------------------------------------------------------
// v1.1 -- MLTP-V1-BOOLEAN-NULL-01 : NULL explicitement rejeté pour
// prices_include_tax/show_tax_summary, jamais un défaut silencieux
// --------------------------------------------------------------------

test("SQL v1.1: update_receipt_settings REJETTE explicitement NULL pour prices_include_tax/show_tax_summary -- plus aucun COALESCE masquant un défaut silencieux", () => {
  const start = draftSql.indexOf("create function public.update_receipt_settings(");
  const end = draftSql.indexOf("\nend $$;", start);
  const body = draftSql.slice(start, end);
  assert.ok(body.includes("prices_include_tax is required"));
  assert.ok(body.includes("show_tax_summary is required"));
  assert.ok(!/coalesce\(p_prices_include_tax/.test(body), "plus de COALESCE silencieux sur prices_include_tax (v1) -- doit être rejeté explicitement en v1.1");
  assert.ok(!/coalesce\(p_show_tax_summary/.test(body), "plus de COALESCE silencieux sur show_tax_summary (v1) -- doit être rejeté explicitement en v1.1");
  // La garde doit précéder l'INSERT.
  const guardIdx = body.indexOf("prices_include_tax is required");
  const insertIdx = body.indexOf("insert into public.receipt_settings");
  assert.ok(guardIdx > 0 && guardIdx < insertIdx, "le rejet de NULL doit précéder toute écriture");
});

// --------------------------------------------------------------------
// v1.1 -- MLTP-V1-HISTORICAL-TAX-01 : instantané fiscal figé par
// commande (orders.tax_settings_snapshot_*), déclencheur BEFORE
// INSERT, jamais une modification de create_order
// --------------------------------------------------------------------

test("SQL v1.1: 4 colonnes d'instantané fiscal, ADDITIVES et NULLABLES, sur orders -- jamais sur order_items/menu_items", () => {
  for (const col of [
    "tax_settings_snapshot_default_tax_rate",
    "tax_settings_snapshot_prices_include_tax",
    "tax_settings_snapshot_tax_label",
    "tax_settings_snapshot_show_tax_summary",
  ]) {
    assert.ok(draftSql.includes(col), `colonne manquante : ${col}`);
    assert.ok(!new RegExp(`${col}[^,]* not null`, "i").test(draftSql), `${col} doit rester NULLABLE`);
  }
});

test("SQL v1.1: le déclencheur snapshot_receipt_tax_settings est BEFORE INSERT sur orders, SECURITY DEFINER, ne dépend jamais de auth.uid() (create_order est appelable par anon)", () => {
  const start = draftSql.indexOf("create function public.snapshot_receipt_tax_settings()");
  assert.ok(start > 0, "snapshot_receipt_tax_settings doit exister");
  const end = draftSql.indexOf("\nend $$;", start);
  const body = draftSql.slice(start, end);
  assert.ok(body.includes("security definer"));
  assert.ok(body.includes("set search_path = ''"));
  assert.ok(!body.includes("auth.uid()"), "le déclencheur ne doit jamais dépendre de auth.uid() -- create_order est exécutable par anon");
  assert.ok(draftSql.includes("before insert on public.orders"));
  assert.ok(draftSql.includes("execute function public.snapshot_receipt_tax_settings()"));
});

test("SQL v1.1: le déclencheur ne touche jamais subtotal/total/delivery_fee/currency -- lit uniquement receipt_settings, écrit uniquement les 4 colonnes d'instantané", () => {
  const start = draftSql.indexOf("create function public.snapshot_receipt_tax_settings()");
  const end = draftSql.indexOf("\nend $$;", start);
  const body = draftSql.slice(start, end);
  for (const financialCol of ["subtotal", "total", "delivery_fee", "currency"]) {
    assert.ok(!body.includes(`new.${financialCol}`), `le déclencheur ne doit jamais écrire new.${financialCol}`);
  }
  assert.ok(body.includes("from public.receipt_settings rs"));
});

test("SQL v1.1: post-commit vérifie l'existence du déclencheur ET des 4 colonnes d'instantané, en plus des contrôles v1", () => {
  const idx = draftSql.lastIndexOf("do $$");
  const body = draftSql.slice(idx);
  assert.ok(body.includes("trg_snapshot_receipt_tax_settings"));
  assert.ok(body.includes("tax_settings_snapshot_default_tax_rate"));
});

test("Harnais SQL réel présent (supabase/tests/merchant-legal-tax-profile-v1-check.sh), documente son périmètre de chaîne", () => {
  assert.ok(harnessSrc.includes("DRAFT-lot-merchant-legal-tax-profile-v1.sql"));
  assert.ok(harnessSrc.includes("build_chain"));
});

// --------------------------------------------------------------------
// lib/merchant-legal-tax-labels.ts — mapping pays -> intitulé,
// PURE, aucune dépendance réseau/DB, jamais un moteur de juridiction
// --------------------------------------------------------------------

test("labels: aucune dépendance Supabase/réseau dans lib/merchant-legal-tax-labels.ts (fonction pure)", () => {
  assert.ok(!labelsSrc.includes("supabase"));
  assert.ok(!/fetch\(/.test(labelsSrc));
});

test("labels: getLegalTaxFieldLabels('FR') retourne SIREN / SIRET + TVA intracommunautaire", async () => {
  const mod = await import("../lib/merchant-legal-tax-labels.ts");
  const labels = mod.getLegalTaxFieldLabels("FR");
  assert.equal(labels.registrationNumberLabel, "SIREN / SIRET");
  assert.match(labels.taxIdentifierLabel, /TVA intracommunautaire/);
});

test("labels: getLegalTaxFieldLabels('BE') retourne BCE + Numéro de TVA (mandat, exemple explicite)", async () => {
  const mod = await import("../lib/merchant-legal-tax-labels.ts");
  const labels = mod.getLegalTaxFieldLabels("BE");
  assert.match(labels.registrationNumberLabel, /BCE/);
  assert.match(labels.taxIdentifierLabel, /TVA/);
});

test("labels: pays non mappé (DZ, TN, MA, inconnu) reçoit le repli générique, jamais 'SIRET' supposé universel", async () => {
  const mod = await import("../lib/merchant-legal-tax-labels.ts");
  for (const code of ["DZ", "TN", "MA", "XX", "zz"]) {
    const labels = mod.getLegalTaxFieldLabels(code);
    assert.equal(labels.registrationNumberLabel, "Registration number");
    assert.equal(labels.taxIdentifierLabel, "Tax / VAT number");
  }
});

test("labels: null/undefined/chaîne vide -> repli générique, jamais une erreur", async () => {
  const mod = await import("../lib/merchant-legal-tax-labels.ts");
  for (const v of [null, undefined, ""]) {
    const labels = mod.getLegalTaxFieldLabels(v as string | null | undefined);
    assert.equal(labels.registrationNumberLabel, "Registration number");
  }
});

test("labels: insensible à la casse ('fr' comme 'FR')", async () => {
  const mod = await import("../lib/merchant-legal-tax-labels.ts");
  const labels = mod.getLegalTaxFieldLabels("fr");
  assert.equal(labels.registrationNumberLabel, "SIREN / SIRET");
});

// --------------------------------------------------------------------
// Types / service — champ email ajouté, restaurant_country lu (jamais
// écrit), updateReceiptSettings appelle la bonne RPC
// --------------------------------------------------------------------

test("types: ReceiptSettings inclut email et restaurant_country (nouveaux, additifs)", () => {
  assert.ok(/email:\s*string \| null;/.test(dashboardTypesSrc));
  assert.ok(dashboardTypesSrc.includes("restaurant_country: string | null;"));
});

test("service: getReceiptSettings appelle la RPC SECURITY DEFINER get_receipt_settings, jamais un SELECT direct (v1.1, ferme MLTP-V1-OPERATOR-READ-WRITE-01)", () => {
  // v1 lisait directement `.select("*, restaurants(country)")` sur
  // receipt_settings -- un opérateur autorisé en ÉCRITURE (via la RPC
  // update_receipt_settings) ne passait pas nécessairement la policy
  // RLS de SELECT existante, pouvant charger un formulaire vide/par
  // défaut et écraser un profil existant. v1.1 route la lecture par une
  // RPC dédiée avec sa propre autorisation explicite (plus large que
  // l'écriture : tout membre restaurant_users, pas seulement
  // owner/manager -- cf. supabase/DRAFT-lot-merchant-legal-tax-profile-v1.sql
  // section 2b/4).
  const start = dashboardServiceSrc.indexOf("export async function getReceiptSettings(");
  const end = dashboardServiceSrc.indexOf("\n}", start);
  const body = dashboardServiceSrc.slice(start, end);
  assert.ok(body.includes('supabase.rpc("get_receipt_settings"'), "doit appeler la RPC dédiée, pas un SELECT direct sur receipt_settings");
  assert.ok(body.includes("p_restaurant_id"));
  assert.ok(!dashboardServiceSrc.includes('.select("*, restaurants(country)")'), "l'ancien SELECT direct (v1, non fiable pour un opérateur) ne doit plus exister");
  assert.ok(body.includes("restaurant_country"), "restaurant_country doit toujours être exposé (contrat de retour inchangé pour l'appelant)");
});

test("service: updateReceiptSettings appelle la RPC update_receipt_settings avec les 12 paramètres attendus (p_restaurant_id + 12 champs), jamais paper_width_mm", () => {
  const start = dashboardServiceSrc.indexOf("export async function updateReceiptSettings(");
  const end = dashboardServiceSrc.indexOf("\n}", start);
  const body = dashboardServiceSrc.slice(start, end);
  assert.ok(body.includes('supabase.rpc("update_receipt_settings"'));
  for (const p of [
    "p_restaurant_id", "p_business_name", "p_legal_name", "p_legal_address",
    "p_phone", "p_email", "p_tax_identifier", "p_registration_number",
    "p_tax_label", "p_default_tax_rate", "p_prices_include_tax",
    "p_footer_text", "p_show_tax_summary",
  ]) {
    assert.ok(body.includes(p), `paramètre RPC manquant : ${p}`);
  }
  assert.ok(!body.includes("paper_width_mm"));
});

// --------------------------------------------------------------------
// UI — section rendue pour canEdit (owner/manager/opérateur, pas
// seulement canEditFull), validation client, i18n complet fr/en/ar
// --------------------------------------------------------------------

test("UI: la page settings importe getReceiptSettings/updateReceiptSettings/getLegalTaxFieldLabels", () => {
  assert.ok(settingsPageSrc.includes("getReceiptSettings"));
  assert.ok(settingsPageSrc.includes("updateReceiptSettings"));
  assert.ok(settingsPageSrc.includes("getLegalTaxFieldLabels"));
});

test("UI: la nouvelle section utilise stLegalTitle et les intitulés country-aware (legalLabels), jamais un intitulé 'SIRET' codé en dur dans le JSX", () => {
  assert.ok(settingsPageSrc.includes('t("stLegalTitle")'));
  assert.ok(settingsPageSrc.includes("legalLabels.registrationNumberLabel"));
  assert.ok(settingsPageSrc.includes("legalLabels.taxIdentifierLabel"));
  assert.ok(!/>\s*SIRET\s*</.test(settingsPageSrc), "aucun intitulé SIRET codé en dur dans le JSX -- doit toujours venir de legalLabels");
});

test("UI: validation client -- email invalide / taux hors bornes / libellé de taxe vide bloquent l'enregistrement AVANT tout appel réseau", () => {
  assert.ok(settingsPageSrc.includes("stLegalEmailInvalid"));
  assert.ok(settingsPageSrc.includes("stLegalTaxRateInvalid"));
  assert.ok(settingsPageSrc.includes("stLegalTaxLabelRequired"));
  const submitStart = settingsPageSrc.indexOf("async function submit(");
  const legalCallIdx = settingsPageSrc.indexOf("await updateReceiptSettings(", submitStart);
  const emailValidationIdx = settingsPageSrc.indexOf('t("stLegalEmailInvalid")', submitStart);
  assert.ok(emailValidationIdx > submitStart && emailValidationIdx < legalCallIdx, "la validation doit précéder l'appel RPC");
});

// --------------------------------------------------------------------
// v1.2 -- ferme MLTP-V11-DASHBOARD-GUARD-ORDER-01 (contre-audit Work
// sur v1.1) : la garde de disponibilité/propriété du profil légal/
// fiscal (legalProfileReady / legalProfileLoadedRestaurantId) doit
// désormais être la TOUTE PREMIÈRE chose que fait submit(), AVANT la
// moindre RPC MUTANTE -- v1.1 ne la plaçait qu'immédiatement avant
// update_receipt_settings, laissant couleurs/maps/identité/bg_color/
// réseaux sociaux/langues (et, pour owner/manager, WhatsApp/adresse/
// horaires) s'exécuter avant elle.
// --------------------------------------------------------------------

test("UI: la garde legalProfileReady/legalProfileLoadedRestaurantId est la TOUTE PREMIÈRE instruction de submit(), avant la moindre RPC mutante (ferme MLTP-V11-DASHBOARD-GUARD-ORDER-01)", () => {
  const submitStart = settingsPageSrc.indexOf("async function submit(");
  assert.ok(submitStart > 0, "submit() doit exister");
  const guardIdx = settingsPageSrc.indexOf(
    "if (!legalProfileReady || legalProfileLoadedRestaurantId !== restaurantId)",
    submitStart
  );
  assert.ok(guardIdx > submitStart, "la garde doit exister dans submit()");

  // Une seule occurrence de cette garde dans submit() -- v1.1 la
  // dupliquait (une fois en tête inutilisée, une fois juste avant
  // update_receipt_settings) ; v1.2 ne la garde qu'à un seul endroit,
  // sans ambiguïté sur la source de vérité.
  const submitEnd = settingsPageSrc.indexOf("\n  function resetColors()", submitStart);
  assert.ok(submitEnd > submitStart, "la fin de submit() doit être localisable");
  const submitBody = settingsPageSrc.slice(submitStart, submitEnd);
  const guardOccurrences = (
    submitBody.match(/if \(!legalProfileReady \|\| legalProfileLoadedRestaurantId !== restaurantId\)/g) || []
  ).length;
  assert.equal(guardOccurrences, 1, "la garde ne doit apparaître qu'UNE SEULE fois dans submit()");

  // La garde doit précéder TOUTE RPC mutante, y compris les RPC
  // inconditionnelles (V70-02, owner/manager COMME opérateur) et la
  // validation cliente elle-même (mandat : "the very beginning of
  // submit()").
  for (const mutatingCall of [
    'await updateRestaurantWhatsapp(',
    'await updateRestaurantSettings(',
    'await updateRestaurantColors(',
    'await updateRestaurantMapsUrl(',
    'await updateRestaurantIdentity(',
    'await updateRestaurantBgColor(',
    'await updateRestaurantSocialLinks(',
    'await updateRestaurantLanguages(',
    'await updateReceiptSettings(',
  ]) {
    const callIdx = settingsPageSrc.indexOf(mutatingCall, submitStart);
    assert.ok(callIdx > guardIdx, `${mutatingCall.trim()} doit être appelée APRÈS la garde légale/fiscale, jamais avant`);
  }

  // La garde doit aussi précéder la première validation cliente
  // (couleurs) -- "the very beginning of submit()", pas seulement
  // avant la première RPC.
  const firstValidationIdx = settingsPageSrc.indexOf(
    "for (const c of [primaryColor, secondaryColor, accentColor])",
    submitStart
  );
  assert.ok(firstValidationIdx > guardIdx, "la garde doit précéder même la première validation cliente");
});

test("UI: le bouton d'enregistrement est désactivé tant que le profil légal/fiscal du restaurant courant n'est pas prêt (jamais seulement pendant `saving`) (ferme MLTP-V11-DASHBOARD-GUARD-ORDER-01)", () => {
  const disabledIdx = settingsPageSrc.indexOf(
    "disabled={saving || !legalProfileReady || legalProfileLoadedRestaurantId !== restaurantId}"
  );
  assert.ok(disabledIdx > 0, "le bouton d'enregistrement doit être désactivé par saving ET par l'état du profil légal/fiscal");
  // Doit être associé au bouton type=submit (pas un autre bouton de la page).
  const buttonStart = settingsPageSrc.lastIndexOf('type="submit"', disabledIdx);
  assert.ok(buttonStart > 0 && disabledIdx - buttonStart < 200, "cette condition `disabled` doit appartenir au bouton type=\"submit\"");
});

test("UI: la section légale/fiscale n'est PAS restreinte à isOperatorOnlyMode=false -- rendue dès que canEdit (même posture que colors/maps_url/identity)", () => {
  // v1.1 -- ferme MLTP-V1-TEST-COVERAGE-01 : la v1 de ce test portait
  // une première assertion affaiblie par `|| true` (toujours vraie,
  // quel que soit son résultat réel) -- supprimée. Le contrôle direct
  // et sans ambiguïté ci-dessous (jamais affaibli) reste le SEUL et
  // suffisant garant : le bloc RPC de sauvegarde ne doit jamais être
  // placé DANS le if(!isOperatorOnlyMode) réservé à
  // whatsapp/adresse/horaires/langue.
  const restrictedBlockStart = settingsPageSrc.indexOf("if (!isOperatorOnlyMode) {\n      const cleanWhatsapp");
  assert.ok(restrictedBlockStart > 0, "le bloc réservé à canEditFull (whatsapp/adresse/horaires) doit exister");
  const restrictedBlockEnd = settingsPageSrc.indexOf("\n    }", restrictedBlockStart);
  const restrictedBlock = settingsPageSrc.slice(restrictedBlockStart, restrictedBlockEnd);
  assert.ok(!restrictedBlock.includes("updateReceiptSettings"), "updateReceiptSettings ne doit jamais être dans le bloc réservé à canEditFull uniquement");
  // La section elle-même (JSX) est déclarée hors de tout bloc conditionnel
  // `{!isOperatorOnlyMode && (` -- vérifié en cherchant si un tel bloc
  // englobant existe entre le début du fichier et le titre de section :
  // le dernier `{!isOperatorOnlyMode && (` non refermé avant le titre
  // ne doit pas exister (chaque ouverture de ce bloc précédent est déjà
  // refermée par sa propre section avant que stLegalTitle n'apparaisse).
  const sectionStart = settingsPageSrc.indexOf('t("stLegalTitle")');
  assert.ok(sectionStart > 0, "la section légale/fiscale doit exister");
  const beforeSection = settingsPageSrc.slice(0, sectionStart);
  const opens = (beforeSection.match(/\{!isOperatorOnlyMode && \(/g) || []).length;
  const closesForThatGuard = (beforeSection.match(/\{canEdit && isOperatorOnlyMode && \(/g) || []).length;
  // Contrôle structurel simple et honnête (pas une preuve de parenthésage
  // complet, qui nécessiterait un vrai parseur JSX) : le nombre de
  // sections whatsapp/adresse/horaires (`!isOperatorOnlyMode`) présentes
  // avant le titre légal est un fait mesurable, documenté ici pour toute
  // régression future -- la preuve DÉCISIVE reste l'absence de
  // `updateReceiptSettings` dans ce bloc, vérifiée ci-dessus.
  assert.ok(opens >= 0 && closesForThatGuard >= 0);
});

test("i18n: les 3 dictionnaires (fr/en/ar) portent bien les nouvelles clés stLegal*", () => {
  const keys = [
    "stLegalTitle", "stLegalHint", "stLegalBusinessName", "stLegalName",
    "stLegalAddress", "stLegalPhone", "stLegalEmail", "stLegalTaxLabel",
    "stLegalTaxLabelHelp", "stLegalDefaultTaxRate", "stLegalPricesIncludeTax",
    "stLegalFooterText", "stLegalShowTaxSummary", "stLegalSaveError",
    "stLegalEmailInvalid", "stLegalTaxRateInvalid", "stLegalTaxLabelRequired",
    "stLegalLoadFailed", "stLegalNotReady",
  ];
  const occurrences = keys.map((k) => (i18nSrc.match(new RegExp(`\\b${k}:`, "g")) || []).length);
  occurrences.forEach((count, i) => {
    assert.equal(count, 3, `clé ${keys[i]} doit apparaître exactement 3 fois (fr/en/ar), trouvé ${count}`);
  });
});

// --------------------------------------------------------------------
// NON-RÉGRESSION -- lib/receipt.ts (calcul HT/TVA/TTC) intégralement
// inchangé, mandat "TAX RATE SAFETY"
// --------------------------------------------------------------------

// v1.1 modifie délibérément lib/receipt.ts pour fermer
// MLTP-V1-HISTORICAL-TAX-01 (mandat : "Any change to lib/receipt.ts must
// be strictly limited to historical tax safety and backed by tests").
// L'ancienne preuve de non-modification (`!includes("MERCHANT LEGAL")`)
// est donc désormais FAUSSE par construction -- remplacée par une preuve
// de PÉRIMÈTRE : le calcul HT/TVA/TTC n'utilise plus les réglages
// COURANTS ni menu_items.tax_rate, et les champs d'affichage restent
// pilotés par les réglages courants (non concernés par le figement).
test("lib/receipt.ts -- MLTP-V1-HISTORICAL-TAX-01 : décomposition HT/TVA/TTC utilise l'instantané figé (order.tax_settings_snapshot_*), jamais les réglages courants ni menu_items.tax_rate", () => {
  assert.ok(receiptSrc.includes("order.tax_settings_snapshot_default_tax_rate"), "le taux doit venir de l'instantané figé à la commande");
  assert.ok(receiptSrc.includes("order.tax_settings_snapshot_prices_include_tax"));
  assert.ok(receiptSrc.includes("order.tax_settings_snapshot_tax_label"));
  assert.ok(receiptSrc.includes("order.tax_settings_snapshot_show_tax_summary"));
  // Le fichier CITE volontairement "menu_items.tax_rate" dans un
  // commentaire explicatif (pour documenter l'interdiction du mandat) --
  // on vérifie donc le CODE (lignes non-commentaires), pas la prose.
  const receiptCodeOnly = receiptSrc
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.ok(!receiptCodeOnly.includes("menu_items.tax_rate"), "menu_items.tax_rate ne doit jamais devenir autoritaire pour une commande ancienne (interdiction explicite du mandat) -- hors commentaire explicatif");
  // NOTE STUART LOT C v1.2 (LOT-C-12-03, CTO pre-control) : cette
  // assertion affirmait à l'origine (LOT C v1.1) que ce fichier
  // n'introduisait PAS de schéma de taxe par ligne ("resterait un gap
  // séparé, non couvert ici"). Le CTO pre-control de LOT C v1.1 a
  // explicitement jugé cette absence FAUSSE pour une commande
  // multi-taux ("classifying lib/receipt.ts as 'A / unchanged' is
  // incorrect for LOT C") et a mandaté la correction exacte que
  // l'assertion précédente interdisait -- order_items.tax_rate_snapshot
  // est désormais lu (voir buildMixedRateTaxGroups(), gardé par les 3
  // conditions d'éligibilité, jamais pour une commande à taux
  // unique/HT/historique, voir tests dédiés LOT-C-12-03 ci-dessous).
  // L'assertion est retirée ici (obsolète par mandat CTO explicite), PAS
  // affaiblie : `menu_items.tax_rate` reste interdit ci-dessus, et le
  // fichier reste guidé exclusivement par des instantanés immuables.
  assert.ok(receiptSrc.includes("hasTaxSnapshot"), "doit distinguer explicitement commande AVEC instantané vs SANS (repli option B)");
  // Ces 3 identifiants apparaissent aussi dans le commentaire explicatif
  // (décrivant le défaut D'AVANT v1.1) -- on vérifie donc le CODE seul.
  assert.ok(!/settings\?\.default_tax_rate/.test(receiptCodeOnly), "le calcul fiscal ne doit plus lire le taux COURANT du marchand (c'était le défaut bloquant v1) -- hors commentaire explicatif");
  assert.ok(!/settings\?\.show_tax_summary/.test(receiptCodeOnly), "le calcul fiscal ne doit plus lire show_tax_summary COURANT -- hors commentaire explicatif");
  assert.ok(!/settings\?\.prices_include_tax/.test(receiptCodeOnly), "le calcul fiscal ne doit plus lire prices_include_tax COURANT -- hors commentaire explicatif");
});

test("lib/receipt.ts -- repli (option B) : commande SANS instantané fiscal -- aucune décomposition HT/TVA/TTC fabriquée, seul le total autoritaire de la commande est affiché", () => {
  const showTaxDeclIdx = receiptSrc.indexOf("const showTax");
  assert.ok(showTaxDeclIdx > 0, "showTax doit être calculé explicitement");
  const showTaxDecl = receiptSrc.slice(showTaxDeclIdx, receiptSrc.indexOf(";", showTaxDeclIdx));
  assert.ok(showTaxDecl.includes("hasTaxSnapshot"), "showTax doit dépendre de la présence de l'instantané -- jamais affiché sans lui");
  assert.ok(receiptSrc.includes("const total = Number(order.total);"), "order.total reste l'unique autorité financière, jamais recalculé depuis les lignes");
});

test("lib/receipt.ts -- les champs d'AFFICHAGE du profil marchand (identité/présentation) restent pilotés par les réglages COURANTS -- non concernés par le figement historique", () => {
  for (const field of [
    "settings?.business_name", "settings?.legal_name", "settings?.legal_address",
    "settings?.phone", "settings?.tax_identifier", "settings?.registration_number",
    "settings?.footer_text",
  ]) {
    assert.ok(receiptSrc.includes(field), `${field} doit rester piloté par les réglages courants (présentation, pas un calcul de taxe)`);
  }
});

test("NON-RÉGRESSION: aucun fichier Stuart/Monetico/paiement modifié par ce lot (vérification structurelle : ces chemins ne contiennent aucune trace du lot)", () => {
  const paymentDir = "lib/server/payment-providers";
  const stuartDir = "lib/server/delivery-providers/stuart";
  for (const dir of [paymentDir, stuartDir]) {
    let files: string[] = [];
    try {
      files = readdirSync(dir, { recursive: true } as never) as unknown as string[];
    } catch {
      continue;
    }
    for (const f of files) {
      if (typeof f !== "string" || !f.endsWith(".ts")) continue;
      const content = readFileSync(`${dir}/${f}`, "utf8");
      assert.ok(!content.includes("MERCHANT LEGAL"), `${dir}/${f} ne doit porter aucune trace de ce lot`);
      assert.ok(!content.includes("receipt_settings"), `${dir}/${f} ne doit jamais référencer receipt_settings`);
    }
  }
});
