import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

import { buildCreateOrderPayload } from "../lib/services/order-payload.ts";
import type { CartLine, OrderContext } from "../lib/whatsapp.ts";
import { EMPTY_CUSTOMER, type CustomerInfo } from "../lib/customer.ts";

// ====================================================================
// SADFP-01 (CORRECTION v2, mission §2/§4) — CODE POSTAL STRUCTURÉ
// COMME SEULE SOURCE DE ROUTAGE.
//
// Ce fichier prouve, côté FRONTEND (buildCreateOrderPayload), que
// `p_customer.postalCode` provient EXCLUSIVEMENT de
// `context.customer.postalCode` (champ structuré), jamais dérivé de
// `address`/`formatAddress`/une regex -- même contrat que côté serveur
// (supabase/DRAFT-lot-server-delivery-fulfillment-pricing.sql,
// create_order, branche "nouveau moteur").
//
// Les preuves COMPORTEMENTALES bout-en-bout (routage réel via
// create_order/resolve_delivery_fulfillment contre un Postgres
// jetable, Cas A/B/D "adresse trompeuse/multiple/invalide mais
// postalCode structuré gagne toujours") vivent séparément dans
// supabase/tests/server-delivery-fulfillment-pricing-check.sh
// (section "SADFP-01"), jamais dupliquées ici -- même séparation déjà
// établie par le projet entre preuve statique/unitaire et preuve
// d'intégration SQL.
// ====================================================================

const menuItem = { id: "item-1", name: "Tiramisu", price: 450 } as never;
const lines: CartLine[] = [{ item: menuItem, quantity: 2 }];

function deliveryContext(customer: Partial<CustomerInfo>): OrderContext {
  return {
    mode: "delivery",
    zoneLabel: "Paris",
    customer: { ...EMPTY_CUSTOMER, ...customer },
  };
}

test("SADFP-01 (Cas A/D, frontend) : p_customer.postalCode = code postal STRUCTURÉ, indépendamment d'une adresse trompeuse (numéro à 5 chiffres non lié dans le texte libre)", () => {
  const ctx = deliveryContext({
    street: "Bâtiment 75001",
    postalCode: "13001",
    city: "Marseille",
    phone: "0600000000",
    email: "a@example.com",
    name: "A",
  });
  const payload = buildCreateOrderPayload({ slug: "sanaa-cookies", context: ctx, lines, lang: "fr" });
  assert.equal(
    (payload.p_customer as { postalCode?: string | null }).postalCode,
    "13001",
    "le postalCode structuré doit être transmis tel quel, jamais réconcilié/aligné sur l'adresse"
  );
});

test("SADFP-01 (Cas B, frontend) : p_customer.postalCode reste le code structuré même si l'adresse contient PLUSIEURS nombres à 5 chiffres", () => {
  const ctx = deliveryContext({
    street: "92100 puis 75001, ambigu",
    postalCode: "75001",
    city: "Paris",
    phone: "0600000001",
    email: "b@example.com",
    name: "B",
  });
  const payload = buildCreateOrderPayload({ slug: "sanaa-cookies", context: ctx, lines, lang: "fr" });
  assert.equal((payload.p_customer as { postalCode?: string | null }).postalCode, "75001");
});

test("SADFP-01 (Cas C, frontend) : postalCode structuré vide/absent -> p_customer.postalCode = null (jamais une chaîne vide, jamais de repli sur l'adresse)", () => {
  const ctx = deliveryContext({
    street: "rue sans code postal",
    postalCode: "",
    city: "?",
    phone: "0600000002",
    email: "c@example.com",
    name: "C",
  });
  const payload = buildCreateOrderPayload({ slug: "sanaa-cookies", context: ctx, lines, lang: "fr" });
  assert.equal((payload.p_customer as { postalCode?: string | null }).postalCode, null);
});

test("SADFP-01 (frontend) : postalCode structuré est trim() avant transmission (espaces jamais transmis tels quels)", () => {
  const ctx = deliveryContext({
    street: "1 rue Test",
    postalCode: "  75001  ",
    city: "Paris",
    phone: "0600000003",
    email: "d@example.com",
    name: "D",
  });
  const payload = buildCreateOrderPayload({ slug: "sanaa-cookies", context: ctx, lines, lang: "fr" });
  assert.equal((payload.p_customer as { postalCode?: string | null }).postalCode, "75001");
});

test("SADFP-01 (frontend) : mode pickup/table -> p_customer.postalCode toujours null (jamais transmis hors livraison)", () => {
  const pickupCtx: OrderContext = {
    mode: "pickup",
    customer: { ...EMPTY_CUSTOMER, name: "P", phone: "0600000004", email: "p@example.com" },
  };
  const payload = buildCreateOrderPayload({ slug: "sanaa-cookies", context: pickupCtx, lines, lang: "fr" });
  assert.equal((payload.p_customer as { postalCode?: string | null }).postalCode, null);

  const tableCtx: OrderContext = { mode: "table", tableNumber: 4 };
  const tablePayload = buildCreateOrderPayload({ slug: "le-sirocco", context: tableCtx, lines, lang: "fr" });
  assert.equal(
    "postalCode" in (tablePayload.p_customer as Record<string, unknown>),
    false,
    "en mode table, p_customer est un objet vide -- aucune clé postalCode du tout"
  );
});

test("SADFP-01 (Cas E, parité frontend/serveur) : le postalCode transmis par le frontend est EXACTEMENT celui de la fixture partagée de résolution (tests/fixtures/fulfillment-routing-cases.json), jamais une valeur re-dérivée", () => {
  const fixture = JSON.parse(
    readFileSync("tests/fixtures/fulfillment-routing-cases.json", "utf8")
  ) as { cases: Array<{ id: string; postalCode: string | null }> };

  const withPostal = fixture.cases.find((c) => typeof c.postalCode === "string" && c.postalCode.length > 0);
  assert.ok(withPostal, "la fixture doit contenir au moins un cas avec un postalCode non vide");

  const ctx = deliveryContext({
    street: "adresse quelconque, sans rapport",
    postalCode: withPostal!.postalCode as string,
    city: "Test",
    phone: "0600000005",
    email: "e@example.com",
    name: "E",
  });
  const payload = buildCreateOrderPayload({ slug: "sanaa-cookies", context: ctx, lines, lang: "fr" });
  assert.equal(
    (payload.p_customer as { postalCode?: string | null }).postalCode,
    withPostal!.postalCode,
    "le frontend doit transmettre EXACTEMENT la même valeur structurée que celle consommée par le résolveur serveur pour ce même cas"
  );
});
