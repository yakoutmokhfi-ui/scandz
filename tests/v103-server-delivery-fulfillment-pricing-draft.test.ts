import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// SERVER-AUTHORITATIVE DELIVERY FULFILLMENT & PRICING FOUNDATION —
// preuve STATIQUE (assertions de contenu texte sur le fichier DRAFT
// lui-même) que le nouveau DRAFT SQL respecte les garde-fous de la
// mission : aucune activation tenant, DRAFT-only (jamais exécuté
// contre Production dans ce lot), discipline REVOKE-avant-GRANT,
// aucun appel réseau Stuart/Chronofresh, vocabulaire de tarification
// volontairement restreint (pas de 'external_quote').
//
// Même patron que tests/v96-fulfillment-routing-lot-b.test.ts (preuve
// statique du DRAFT Lot B). La preuve COMPORTEMENTALE (application
// réelle contre un Postgres jetable, résolution/calcul de frais,
// bridge legacy/nouveau moteur, ACL réelles) vit séparément dans
// supabase/tests/server-delivery-fulfillment-pricing-check.sh --
// jamais dupliquée ici, même séparation déjà établie par le projet.
// ====================================================================

const draftSql = readFileSync(
  "supabase/DRAFT-lot-server-delivery-fulfillment-pricing.sql",
  "utf8"
);

const executableSql = draftSql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

test("DRAFT prix serveur: avertissement 'NE JAMAIS EXÉCUTER SUR SUPABASE PRODUCTION' présent", () => {
  assert.ok(draftSql.includes("NE JAMAIS EXÉCUTER SUR SUPABASE PRODUCTION"));
});

test("DRAFT prix serveur: AUCUNE activation tenant -- aucun INSERT INTO restaurant_sale_mode_fulfillments / restaurant_sale_modes (les seuls INSERT INTO du fichier appartiennent au corps légitime de create_order -- orders/order_items/order_delivery_address, jamais une donnée de configuration tenant)", () => {
  assert.ok(
    !/insert\s+into\s+(public\.)?restaurant_sale_mode_fulfillments/i.test(executableSql),
    "aucune règle de fulfillment (Au Lait Cru, Sanaa ou autre) ne doit être insérée par ce DRAFT"
  );
  assert.ok(
    !/insert\s+into\s+(public\.)?restaurant_sale_modes\b/i.test(executableSql),
    "aucune ligne de configuration de mode ne doit être insérée par ce DRAFT"
  );
});

test("DRAFT prix serveur: vocabulaire pricing_mode PAR RÈGLE volontairement restreint à ('free','fixed','free_above_threshold') -- jamais 'external_quote' comme valeur de contrainte (aucune intégration API dans ce lot)", () => {
  const checkLine = executableSql
    .split("\n")
    .find((l) => /check\s*\(pricing_mode\s+in\s*\(/i.test(l));
  assert.ok(checkLine, "la contrainte CHECK sur pricing_mode doit exister");
  assert.match(checkLine!, /'free'\s*,\s*'fixed'\s*,\s*'free_above_threshold'/);
  assert.ok(
    !/check\s*\(pricing_mode\s+in\s*\([^)]*external_quote/i.test(executableSql),
    "la contrainte CHECK sur pricing_mode ne doit jamais admettre 'external_quote' comme valeur -- le mot peut légitimement apparaître dans un commentaire/documentation de colonne expliquant qu'il est volontairement EXCLU (voir le commentaire on column ci-dessus), jamais comme valeur admise par une contrainte"
  );
});

test("DRAFT prix serveur: contrainte combo tarification interdit fixed_fee/free_threshold négatifs et les combinaisons incohérentes avec pricing_mode", () => {
  assert.match(executableSql, /check\s*\(fixed_fee\s+is\s+null\s+or\s+fixed_fee\s*>=\s*0\)/i);
  assert.match(executableSql, /check\s*\(free_threshold\s+is\s+null\s+or\s+free_threshold\s*>=\s*0\)/i);
  assert.match(executableSql, /pricing_mode\s*=\s*'free'\s+and\s+fixed_fee\s+is\s+null\s+and\s+free_threshold\s+is\s+null/i);
  assert.match(executableSql, /pricing_mode\s*=\s*'fixed'\s+and\s+fixed_fee\s+is\s+not\s+null\s+and\s+free_threshold\s+is\s+null/i);
  assert.match(executableSql, /pricing_mode\s*=\s*'free_above_threshold'\s+and\s+fixed_fee\s+is\s+not\s+null\s+and\s+free_threshold\s+is\s+not\s+null/i);
});

test("DRAFT prix serveur: orders gagne un CHECK d'invariant total = subtotal + delivery_fee (réutilise la discipline DB-level, jamais seulement une validation applicative)", () => {
  assert.match(executableSql, /orders_total_equals_subtotal_plus_delivery_fee/);
  assert.match(executableSql, /check\s*\(total\s*=\s*subtotal\s*\+\s*delivery_fee\)/i);
});

test("DRAFT prix serveur: orders.delivery_fee ne peut jamais être négatif (CHECK >= 0)", () => {
  assert.match(executableSql, /delivery_fee\s+numeric\(12,\s*2\)\s+not\s+null\s+default\s+0/i);
  assert.match(executableSql, /check\s*\(delivery_fee\s*>=\s*0\)/i);
});

test("DRAFT prix serveur: orders.fulfillment_rule_id référence restaurant_sale_mode_fulfillments avec ON DELETE SET NULL (une suppression future de règle ne doit jamais bloquer ni effacer une commande historique)", () => {
  assert.match(
    executableSql,
    /fulfillment_rule_id\s+uuid\s+references\s+(public\.)?restaurant_sale_mode_fulfillments\s*\(\s*id\s*\)\s+on\s+delete\s+set\s+null/i
  );
});

test("DRAFT prix serveur: aucun appel réseau Stuart/Chronofresh (aucune URL, aucune extension http/pg_net) -- le nom des prestataires n'apparaît QUE dans des commentaires (lignes '--' ou chaînes de documentation COMMENT ON), jamais comme valeur codée en dur dans un CHECK/INSERT/comparaison de logique métier", () => {
  assert.ok(!/https?:\/\//i.test(draftSql));
  assert.ok(!/pg_net|http_post|http_get/i.test(draftSql));
  // Filtre en plus les chaînes de documentation `comment on ... is '...';`
  // (SQL exécutable au sens strict, mais dont le contenu textuel est de
  // la documentation, pas de la logique) -- seule une occurrence dans
  // une comparaison/contrainte/valeur réelle serait un problème.
  const withoutDocComments = executableSql.replace(/comment\s+on\s+[\s\S]*?;/gi, "");
  assert.ok(
    !/stuart|chronofresh/i.test(withoutDocComments),
    "aucune ligne de logique SQL réelle (hors commentaires '--' et documentation COMMENT ON) ne doit référencer ces prestataires en dur"
  );
});

test("DRAFT prix serveur: resolve_delivery_fulfillment reste révoqué de public/anon/authenticated (aucun GRANT EXECUTE ne doit jamais exister pour le résolveur interne)", () => {
  const revokeIdx = draftSql.indexOf("revoke all on function public.resolve_delivery_fulfillment");
  assert.ok(revokeIdx > 0, "le REVOKE doit exister pour la nouvelle signature à 5 arguments");
  assert.ok(
    !draftSql.includes("grant execute on function public.resolve_delivery_fulfillment"),
    "aucun GRANT ne doit jamais exister pour le résolveur interne"
  );
});

test("DRAFT prix serveur: get_restaurant_public_delivery_fulfillments révoque AVANT d'accorder EXECUTE (ordre textuel réel, pas seulement documenté)", () => {
  const revokeIdx = draftSql.indexOf("revoke all on function public.get_restaurant_public_delivery_fulfillments");
  const grantIdx = draftSql.indexOf("grant execute on function public.get_restaurant_public_delivery_fulfillments");
  assert.ok(revokeIdx > 0 && grantIdx > revokeIdx, "REVOKE doit précéder GRANT dans le texte réel du fichier");
});

test("DRAFT prix serveur: get_restaurant_public_delivery_fulfillments n'expose JAMAIS provider (ni la colonne, ni la table de retour)", () => {
  const fnStart = draftSql.indexOf("create function public.get_restaurant_public_delivery_fulfillments");
  const fnEnd = draftSql.indexOf("$$;", fnStart);
  const body = draftSql.slice(fnStart, fnEnd);
  assert.ok(!/\bprovider\b/i.test(body), "le corps de la RPC publique ne doit jamais mentionner provider");
});

test("DRAFT prix serveur: create_order révoque AVANT d'accorder EXECUTE (signature de sortie changée, DROP+CREATE requis, jamais un simple CREATE OR REPLACE incompatible)", () => {
  const revokeIdx = draftSql.indexOf("revoke all on function public.create_order(text, text, jsonb, integer, jsonb, text, text)");
  const grantIdx = draftSql.indexOf("grant execute on function public.create_order(text, text, jsonb, integer, jsonb, text, text)");
  assert.ok(revokeIdx > 0 && grantIdx > revokeIdx, "REVOKE doit précéder GRANT pour create_order");
});

test("DRAFT prix serveur: create_order n'est jamais élargi en entrée -- la signature d'entrée documentée reste EXACTEMENT 7 paramètres, dans cet ordre (p_slug, p_service_mode, p_items, p_table_number, p_customer, p_note, p_language), aucun paramètre fee/provider/fulfillment ajouté", () => {
  const fnStart = executableSql.indexOf("create or replace function public.create_order(");
  assert.ok(fnStart >= 0, "create_order doit être défini via CREATE OR REPLACE (signature de retour changée, DROP+CREATE requis)");
  const parenStart = fnStart + "create or replace function public.create_order(".length;
  const parenEnd = executableSql.indexOf(")\nreturns table", parenStart);
  assert.ok(parenEnd > parenStart, "la liste de paramètres doit se terminer juste avant 'returns table'");
  const paramList = executableSql.slice(parenStart, parenEnd);
  const paramNames = [...paramList.matchAll(/^\s*(p_\w+)\s+\w+/gm)].map((m) => m[1]);
  assert.deepEqual(
    paramNames,
    ["p_slug", "p_service_mode", "p_items", "p_table_number", "p_customer", "p_note", "p_language"],
    "aucun paramètre supplémentaire (fee/provider/fulfillment_code) ne doit jamais être ajouté à l'entrée de create_order -- le client ne doit structurellement rien pouvoir forcer"
  );
});

test("DRAFT prix serveur: préflight anti-dérive (SCANYM_SCHEMA_DRIFT) présent -- empêche une double application accidentelle et exige explicitement LOT A/B au préalable", () => {
  assert.ok(draftSql.includes("SCANYM_SCHEMA_DRIFT"));
  assert.ok(/prérequis LOT A manquant/i.test(draftSql));
  assert.ok(/prérequis LOT B manquant/i.test(draftSql));
});

// ====================================================================
// SADFP-01 (CORRECTION v2, mission §2/§5) — le code postal STRUCTURÉ
// est la SEULE source de routage pour le nouveau moteur ; le calcul du
// pont de migration (v_new_engine) doit précéder textuellement la
// dérivation du code postal (puisque la branche décide la SOURCE).
// ====================================================================

test("DRAFT prix serveur (SADFP-01): create_order lit le code postal STRUCTURÉ p_customer->>'postalCode' pour le nouveau moteur -- jamais un simple 'substring(v_address ...)' non conditionné", () => {
  assert.match(
    executableSql,
    /v_postal\s*:=\s*nullif\(\s*trim\(\s*coalesce\(\s*p_customer\s*->>\s*'postalCode'/i,
    "create_order doit dériver v_postal depuis p_customer->>'postalCode' pour le nouveau moteur"
  );
});

test("DRAFT prix serveur (SADFP-01): le calcul du pont de migration (v_new_engine) précède TEXTUELLEMENT la dérivation du code postal -- la branche doit être connue AVANT de choisir la source", () => {
  const bridgeIdx = executableSql.indexOf("into v_new_engine");
  const structuredPostalIdx = executableSql.indexOf("p_customer->>'postalCode'");
  assert.ok(bridgeIdx > 0, "le calcul du pont (into v_new_engine) doit exister");
  assert.ok(structuredPostalIdx > 0, "la lecture du postalCode structuré doit exister");
  assert.ok(
    bridgeIdx < structuredPostalIdx,
    "v_new_engine doit être calculé avant la lecture de p_customer->>'postalCode', pour que la branche pilote la source du code postal"
  );
});

test("DRAFT prix serveur (SADFP-01): la branche LEGACY (tenant zéro-règle) conserve EXACTEMENT la dérivation regex pré-existante 'substring(v_address from ...)' -- byte-compatible, jamais supprimée", () => {
  assert.match(executableSql, /v_postal\s*:=\s*substring\(v_address from '\\m\(\\d\{5\}\)\\M'\)/);
});

test("DRAFT prix serveur (SADFP-01): aucune dérivation regex du code postal n'existe HORS de la branche legacy -- le nouveau moteur ne retombe jamais, même partiellement, sur une extraction depuis l'adresse", () => {
  const occurrences = [...executableSql.matchAll(/v_postal\s*:=\s*substring\(v_address/gi)];
  assert.equal(
    occurrences.length,
    1,
    "une seule occurrence de la dérivation regex doit exister dans tout le fichier (la branche legacy) -- toute occurrence supplémentaire indiquerait une fuite vers le nouveau moteur"
  );
});
