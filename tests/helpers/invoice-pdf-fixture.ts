import type { InvoiceSource } from "../../lib/server/invoices/model.ts";
import type { DashboardOrder } from "../../lib/dashboard-types.ts";
export function invoiceFixture(): InvoiceSource {
  return {
    order: {
      id: "10000000-0000-4000-8000-000000000001",
      restaurant_id: "20000000-0000-4000-8000-000000000001",
      order_number: 124,
      payment_status: "paid",
      currency: "EUR",
      service_mode: "pickup",
      created_at: "2026-11-10T12:00:00Z",
      subtotal: 12,
      total: 12,
      tax_settings_snapshot_prices_include_tax: true,
      tax_settings_snapshot_default_tax_rate: 20,
      tax_settings_snapshot_show_tax_summary: true,
      tax_settings_snapshot_tax_label: "TVA",
      order_items: [
        {
          id: "30000000-0000-4000-8000-000000000001",
          item_name: "Bouteille de vin — Démonstration",
          option_name: null,
          quantity: 1,
          unit_price: 12,
          line_total: 12,
          tax_rate_snapshot: 20,
        },
      ],
      order_delivery_tax_allocations: [],
    } as unknown as DashboardOrder,
    seller: {
      name: "Commerçant de démonstration",
      address: "1 rue Exemple, 75000 Paris, FR",
      registration: "SIRET DEMONSTRATION",
      vat: "FR DEMONSTRATION",
      email: "marchand@example.com",
      country: "FR",
      legalForm: "Société de démonstration",
    },
    buyer: {
      name: "Cliente de démonstration",
      address: "2 rue Exemple, 75000 Paris, FR",
      email: "client@example.com",
      vat: null,
      company: false,
    },
    payment: { paidAt: "2026-11-10T12:05:00Z", method: "monetico" },
    footer:
      "Données entièrement fictives. Document de test, sans valeur comptable.",
    sender: {
      email: "marchand@example.com",
      name: "Commerçant de démonstration",
      replyTo: null,
    },
  };
}
