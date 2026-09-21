import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveDeliveryCustomerNotice } from "../lib/delivery-customer-notice.ts";
import type { SaleMode } from "../lib/sale-modes-types.ts";

const pickup: SaleMode = {
  code: "pickup",
  label: "Click & Collect",
  category: "fulfillment",
  customerText: "Retrait disponible sous 2 heures.",
  pricingMode: "free",
  fixedFee: null,
  freeThreshold: null,
  delayValue: null,
  delayUnit: null,
};

const delivery: SaleMode = {
  ...pickup,
  code: "delivery",
  label: "Livraison",
  customerText: "Délai général configuré.",
};

test("Click & Collect affiche exactement le texte configuré sur le mode actif", () => {
  assert.deepEqual(resolveDeliveryCustomerNotice("pickup", [pickup], { eligible: true }), {
    modeCode: "pickup",
    modeLabel: "Click & Collect",
    message: "Retrait disponible sous 2 heures.",
  });
});

test("livraison utilise le texte de la règle effectivement résolue (Stuart/Chronofresh restent modulaires)", () => {
  assert.deepEqual(
    resolveDeliveryCustomerNotice("delivery", [delivery], {
      eligible: true,
      zone: { code: "75", label: "Expédition réfrigérée sous 48 h." },
    }, true),
    {
      modeCode: "delivery",
      modeLabel: "Livraison",
      message: "Expédition réfrigérée sous 48 h.",
    }
  );
});

test("livraison sans texte de règle utilise le texte générique du mode, sans promesse inventée", () => {
  assert.equal(
    resolveDeliveryCustomerNotice("delivery", [delivery], {
      eligible: true,
      zone: { code: "", label: null },
    })?.message,
    "Délai général configuré."
  );
});

test("le libellé de zone legacy n'est jamais pris pour une information de délai", () => {
  assert.equal(
    resolveDeliveryCustomerNotice("delivery", [{ ...delivery, customerText: null }], {
      eligible: true,
      zone: { code: "75", label: "Paris" },
    }),
    null
  );
});

test("message optionnel absent ou blanc : aucun popup, parcours historique conservé", () => {
  assert.equal(
    resolveDeliveryCustomerNotice("pickup", [{ ...pickup, customerText: "  " }], { eligible: true }),
    null
  );
  assert.equal(
    resolveDeliveryCustomerNotice("delivery", [{ ...delivery, customerText: null }], {
      eligible: true,
      zone: { code: "75", label: null },
    }),
    null
  );
});

test("mode table ou mode absent de la configuration publique : aucun message ne fuite", () => {
  assert.equal(resolveDeliveryCustomerNotice("table", [pickup, delivery], { eligible: true }), null);
  assert.equal(resolveDeliveryCustomerNotice("pickup", [delivery], { eligible: true }), null);
});

test("mobile : CategoryNav est en flux normal par défaut et sticky uniquement à partir de sm", () => {
  const source = readFileSync("components/CategoryNav.tsx", "utf8");
  const navClasses = [...source.matchAll(/className="([^"]*sm:sticky[^"]*)"/g)].map((match) => match[1]);
  assert.equal(navClasses.length, 2, "les variantes classic et editorial doivent partager le contrat responsive");
  for (const classes of navClasses) {
    assert.ok(classes.includes("sm:sticky"));
    assert.ok(classes.includes("sm:top-0"));
    assert.equal(classes.split(/\s+/).includes("sticky"), false, "aucun sticky mobile non préfixé");
  }
});

test("navigation transversale P1 inchangée : CollectionNav reste globale au catalogue", () => {
  const menu = readFileSync("components/MenuView.tsx", "utf8");
  const collections = readFileSync("lib/customer-collections.ts", "utf8");
  assert.ok(menu.includes("selectCollectionItems(restaurant.categories, activeCollection)"));
  assert.ok(menu.includes("<CollectionNav"));
  assert.ok(collections.includes("for (const category of categories)"));
  assert.ok(collections.includes("for (const item of category.menu_items)"));
  assert.equal(menu.includes("deriveContextualCategoryTags"), false);
  assert.equal(menu.includes("filterMenuItemGroupsByTag"), false);
});

test("le popup reste une confirmation UX avant createOrder, jamais une frontière transactionnelle", () => {
  const cart = readFileSync("components/CartPanel.tsx", "utf8");
  const dialog = readFileSync("components/DeliveryTimingNoticeDialog.tsx", "utf8");
  assert.ok(cart.includes("requestOrderSubmission"));
  assert.ok(cart.includes("await onSendOrder()"));
  assert.ok(cart.includes("timingNoticeGuardRef.current"));
  assert.equal(dialog.includes("createOrder"), false);
  assert.equal(dialog.includes("supabase"), false);
});

test("le champ de notes existant reste présent et le popup l'explique sans garantie", () => {
  const cart = readFileSync("components/CartPanel.tsx", "utf8");
  const i18n = readFileSync("lib/i18n.ts", "utf8");
  assert.ok(cart.includes('id="order-note"'));
  assert.ok(cart.includes('t("noteLabel")'));
  assert.ok(i18n.includes("Le commerçant vous confirmera ce qui est possible."));
});

test("configuration : réutilise customer_text, sans nouvelle table ni colonne", () => {
  const sql = readFileSync("supabase/DRAFT-lot-delivery-delay-customer-notice-v1.sql", "utf8");
  const executable = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  assert.equal(/create\s+table|alter\s+table|add\s+column/i.test(executable), false);
  assert.ok(executable.includes("set customer_text = v_clean_text"));
  assert.ok(executable.includes("and rsm.enabled"));
  assert.ok(executable.includes("and enabled;"));
});

test("configuration : lecture et écriture sont authentifiées, tenant-safe et sans accès anon", () => {
  const sql = readFileSync("supabase/DRAFT-lot-delivery-delay-customer-notice-v1.sql", "utf8");
  assert.ok(sql.includes("public.is_member_of(p_restaurant_id)"));
  assert.ok(sql.includes("public.has_role_in(p_restaurant_id, array['owner', 'manager'])"));
  assert.ok(sql.includes("public.is_scanym_operator()"));
  assert.ok(sql.includes("security definer\nset search_path = ''"));
  assert.ok(sql.includes("from public, anon"));
  assert.ok(sql.includes("to authenticated"));
});

test("configuration : aucune donnée provider ou config interne n'est projetée au marchand", () => {
  const sql = readFileSync("supabase/DRAFT-lot-delivery-delay-customer-notice-v1.sql", "utf8");
  const returnBlock = sql.slice(sql.indexOf("returns table"), sql.indexOf(")\nlanguage plpgsql"));
  assert.match(returnBlock, /mode_code text[\s\S]*mode_label text[\s\S]*customer_text text/);
  assert.doesNotMatch(returnBlock, /provider|config|restaurant_id|fulfillment_code/);
});

test("service marchand mappe explicitement les RPC et leurs seuls champs publics", () => {
  const service = readFileSync("lib/services/dashboard.ts", "utf8");
  assert.ok(service.includes('supabase.rpc("get_merchant_delivery_method_notices"'));
  assert.ok(service.includes('supabase.rpc("update_merchant_delivery_method_notice"'));
  assert.ok(service.includes("modeCode: row.mode_code"));
  assert.ok(service.includes("modeLabel: row.mode_label"));
  assert.ok(service.includes("customerText: row.customer_text"));
});

test("rollback dédié supprime uniquement les deux RPC additives", () => {
  const rollback = readFileSync(
    "supabase/DRAFT-lot-delivery-delay-customer-notice-v1-rollback.sql",
    "utf8"
  );
  assert.equal((rollback.match(/drop function if exists/g) ?? []).length, 2);
  assert.equal(/delete\s+from|update\s+public\.|drop\s+table/i.test(rollback), false);
});

test("clés client et marchand présentes dans les trois dictionnaires", () => {
  const i18n = readFileSync("lib/i18n.ts", "utf8");
  for (const key of [
    "deliveryTimingNoticeTitle",
    "deliveryTimingNoticeNotesHint",
    "deliveryTimingNoticeBack",
    "deliveryTimingNoticeConfirm",
    "dpNoticeSectionTitle",
    "dpNoticeSectionHint",
    "dpNoticePlaceholder",
  ]) {
    assert.equal(i18n.split(`${key}:`).length - 1, 3, `${key} doit exister en fr/en/ar`);
  }
});
