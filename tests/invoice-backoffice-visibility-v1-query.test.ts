import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym — INVOICE BACKOFFICE VISIBILITY + BILLING ADDRESS v1 (Claude
// Monet), mandat Section E / matrice de test §I, ÉLÉMENT 16 :
// lib/services/dashboard.ts -- preuve que getDashboardOrders()
// embarque désormais order_invoice_request dans sa requête PostgREST,
// via le même client `supabase` authentifié navigateur qu'avant ce
// lot (aucun endpoint service-role introduit, mandat Section E/F).
//
// FICHIER DÉLIBÉRÉMENT SÉPARÉ (jamais .dom.test.ts, aucun jsdom) :
// le client réel @supabase/supabase-js (créé par lib/supabase.ts)
// démarre un rafraîchissement de session en arrière-plan dès qu'il
// détecte un environnement "navigateur" (présence de
// `globalThis.window`) -- ce minuteur n'est jamais annulé/`unref()`é
// par ce module (comportement PRÉEXISTANT de la bibliothèque, hors
// périmètre de ce lot, jamais touché). Combiné à un `globalThis.window`
// jsdom (nécessaire aux tests DOM d'OrderCard, voir
// tests/invoice-backoffice-visibility-v1.dom.test.ts), ce minuteur
// empêche le process Node de jamais se terminer -- un test unitaire
// PUR de la chaîne `.select()` (aucun rendu DOM requis) n'a d'ailleurs
// besoin d'AUCUN global navigateur : ce fichier n'en définit donc
// aucun, exactement comme tests/v106-dashboard-delivery-pricing.test.ts
// et tests/v67-product-photos.test.ts (déjà existants, jamais
// `.dom.test.ts`, jamais de hang) qui importent également
// lib/supabase.ts sans jamais définir `globalThis.window`.
// ====================================================================

test("16. getDashboardOrders() -- la requête .select() embarque désormais order_invoice_request (même client authentifié + RLS existante, aucun service-role)", async (t) => {
  const { supabase } = await import("../lib/supabase.ts");
  const { getDashboardOrders } = await import("../lib/services/dashboard.ts");

  let capturedSelect: string | null = null;
  const chain: any = {
    select(arg: string) {
      capturedSelect = arg;
      return chain;
    },
    eq() {
      return chain;
    },
    order() {
      return chain;
    },
    limit() {
      return chain;
    },
    not() {
      return chain;
    },
    then(resolve: (v: { data: unknown[]; error: null }) => void) {
      resolve({ data: [], error: null });
    },
  };
  t.mock.method(supabase, "from", (table: string) => {
    assert.equal(table, "orders");
    return chain;
  });

  await getDashboardOrders("r1", false);

  assert.ok(capturedSelect, "select() doit avoir été appelé");
  const select: string = capturedSelect as string;
  assert.ok(
    select.includes("order_invoice_request"),
    "la requête doit embarquer la relation order_invoice_request"
  );
  // Les embeds déjà existants (order_items,
  // order_delivery_tax_allocations) restent présents -- additif
  // uniquement, jamais un remplacement.
  assert.ok(select.includes("order_items"));
  assert.ok(select.includes("order_delivery_tax_allocations"));
  // Les colonnes précises attendues par DashboardOrderInvoiceRequest
  // (lib/dashboard-types.ts) sont bien demandées -- aucune colonne de
  // statut de génération/envoi (mandat : "Do NOT... introduce new
  // lifecycle/status persistence").
  for (const col of [
    "invoice_type",
    "company_legal_name",
    "vat_number",
    "contact_name",
    "contact_email",
    "address_line_1",
    "address_line_2",
    "city",
    "postal_code",
    "country",
  ]) {
    assert.ok(select.includes(col), `la colonne ${col} doit être demandée`);
  }
});
