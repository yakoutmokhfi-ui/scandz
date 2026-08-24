import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Import dynamique obligatoire (patron déjà établi,
// tests/v67-product-photos.test.ts) : les variables d'environnement
// doivent être définies AVANT que lib/supabase.ts ne soit chargé, et
// un import statique serait hoisté avant ce code.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { supabase } = await import("../lib/supabase.ts");
const {
  getPublicSaleModes,
  getPublicFieldRequirements,
  getPublicDeliveryInfo,
  groupFieldRequirements,
  validateCustomerData,
  __resetCatalogCacheForTests,
} = await import("../lib/sale-modes-public.ts");

// ====================================================================
// Scanym LOT 2B.1 — types + lib/sale-modes-public.ts + nouvelle RPC
// get_restaurant_public_delivery_info. Aucun consommateur métier
// (MenuView, CartPanel, FulfillmentSelector, lib/delivery.ts,
// Dashboard, restaurants-config.ts) n'est modifié dans ce sous-lot --
// vérifié explicitement ci-dessous.
// ====================================================================

const v84Sql = readFileSync("supabase/migration-v84-lot2b1-delivery-info-rpc.sql", "utf8");
const harnessSrc = readFileSync("supabase/tests/v84-lot2b1-check.sh", "utf8");

test("LOT 2B.1: aucun fichier consommateur métier n'a été modifié dans ce sous-lot (mis à jour LOT 2B.2 : lib/delivery.ts, puis LOT 2B.3 : MenuView.tsx, ont depuis légitimement commencé à consommer lib/sale-modes-public.ts/sale-modes-types.ts, exclus de cette liste)", () => {
  const untouchedFiles = [
    "components/CartPanel.tsx",
    "components/FulfillmentSelector.tsx",
  ];
  for (const f of untouchedFiles) {
    const src = readFileSync(f, "utf8");
    assert.ok(!src.includes("sale-modes-public"), `${f} ne doit pas encore consommer lib/sale-modes-public.ts`);
    assert.ok(!src.includes("sale-modes-types"), `${f} ne doit pas encore consommer lib/sale-modes-types.ts`);
  }
});

test("LOT 2B.1: restaurants-config.ts n'a subi aucune modification", () => {
  const src = readFileSync("lib/restaurants-config.ts", "utf8");
  assert.ok(src.includes("allowedServiceModes"));
  assert.ok(src.includes("DETTE TECHNIQUE ASSUMÉE"));
});

test("LOT 2B.1: aucune page Dashboard sale-modes n'a été créée dans ce sous-lot", () => {
  let exists = true;
  try {
    readFileSync("app/dashboard/sale-modes/page.tsx", "utf8");
  } catch {
    exists = false;
  }
  assert.equal(exists, false);
});

test("LOT 2B.1: les types déclarés sont exactement ceux de la spécification, aucun type restaurant-spécifique", () => {
  const src = readFileSync("lib/sale-modes-types.ts", "utf8");
  for (const t of ["SaleMode", "SaleModeFieldRequirement", "RequirementType", "CustomerData", "PublicDeliveryInfo"]) {
    assert.ok(src.includes(`export interface ${t}`) || src.includes(`export type ${t}`), `type ${t} manquant`);
  }
  assert.ok(!/illico|sanaa|sirocco/i.test(src));
});

test("LOT 2B.1: oneOfGroup est typé comme une chaîne ouverte, jamais une union de noms figés", () => {
  const src = readFileSync("lib/sale-modes-types.ts", "utf8");
  const oneOfGroupLine = src.split("\n").find((l) => l.trim().startsWith("oneOfGroup:"));
  assert.ok(oneOfGroupLine?.includes("string | null"), "la déclaration réelle (pas un commentaire) doit être string | null");
  assert.ok(!oneOfGroupLine?.includes('"contact"'));
});

test("LOT 2B.1: getPublicSaleModes enrichit mode_code avec label/category depuis sale_mode_catalog", async (t) => {
  __resetCatalogCacheForTests();
  t.mock.method(supabase, "from", () => ({
    select: async () => ({
      data: [
        { code: "pickup", label: "Retrait", category: "pickup" },
        { code: "delivery", label: "Livraison", category: "delivery" },
      ],
      error: null,
    }),
  }));
  t.mock.method(supabase, "rpc", async (name: string) => {
    assert.equal(name, "get_restaurant_public_sale_modes");
    return {
      data: [
        {
          mode_code: "pickup",
          customer_text: "Retrait sous 2h",
          pricing_mode: "free",
          fixed_fee: null,
          free_threshold: null,
          delay_value: 120,
          delay_unit: "minutes",
        },
      ],
      error: null,
    };
  });

  const modes = await getPublicSaleModes("r1");
  assert.equal(modes.length, 1);
  assert.equal(modes[0].code, "pickup");
  assert.equal(modes[0].label, "Retrait");
  assert.equal(modes[0].category, "pickup");
  assert.equal(modes[0].customerText, "Retrait sous 2h");
  __resetCatalogCacheForTests();
});

test("LOT 2B.1: getPublicSaleModes retombe sur le code brut si le catalogue ne connaît pas ce mode_code", async (t) => {
  __resetCatalogCacheForTests();
  t.mock.method(supabase, "from", () => ({
    select: async () => ({ data: [], error: null }),
  }));
  t.mock.method(supabase, "rpc", async () => ({
    data: [{ mode_code: "futur_mode_inconnu", customer_text: null, pricing_mode: "free", fixed_fee: null, free_threshold: null, delay_value: null, delay_unit: null }],
    error: null,
  }));

  const modes = await getPublicSaleModes("r1");
  assert.equal(modes[0].label, "futur_mode_inconnu");
  __resetCatalogCacheForTests();
});

test("LOT 2B.1: getPublicSaleModes retourne un tableau vide si la RPC ne retourne aucune ligne", async (t) => {
  __resetCatalogCacheForTests();
  t.mock.method(supabase, "from", () => ({ select: async () => ({ data: [], error: null }) }));
  t.mock.method(supabase, "rpc", async () => ({ data: [], error: null }));
  const modes = await getPublicSaleModes("r1");
  assert.deepEqual(modes, []);
  __resetCatalogCacheForTests();
});

test("LOT 2B.1: getPublicFieldRequirements transmet field/requirement/oneOfGroup fidèlement", async (t) => {
  t.mock.method(supabase, "rpc", async (name: string, args: Record<string, unknown>) => {
    assert.equal(name, "get_restaurant_public_field_requirements");
    assert.deepEqual(args, { p_restaurant_id: "r1", p_mode_code: "pickup" });
    return {
      data: [
        { field: "customer_name", requirement: "required", one_of_group: null },
        { field: "notes", requirement: "optional", one_of_group: null },
      ],
      error: null,
    };
  });
  const reqs = await getPublicFieldRequirements("r1", "pickup");
  assert.equal(reqs.length, 2);
  assert.equal(reqs[0].requirement, "required");
  assert.equal(reqs[1].requirement, "optional");
  assert.equal(reqs[0].oneOfGroup, null);
});

test("LOT 2B.1: getPublicFieldRequirements retourne un tableau vide si le mode n'est pas activé", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: [], error: null }));
  const reqs = await getPublicFieldRequirements("r1", "delivery");
  assert.deepEqual(reqs, []);
});

test("LOT 2B.1: getPublicDeliveryInfo retourne null si aucune ligne n'est retournée", async (t) => {
  t.mock.method(supabase, "rpc", async (name: string) => {
    assert.equal(name, "get_restaurant_public_delivery_info");
    return { data: [], error: null };
  });
  const info = await getPublicDeliveryInfo("r1");
  assert.equal(info, null);
});

test("LOT 2B.1: getPublicDeliveryInfo mappe correctement un résultat avec zonePrefixes vide", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({
    data: [{ delivery_zone_prefixes: [], delivery_min_items: 0, delivery_area_label: null }],
    error: null,
  }));
  const info = await getPublicDeliveryInfo("r1");
  assert.deepEqual(info, { zonePrefixes: [], minItems: 0, areaLabel: null });
});

test("LOT 2B.1: les erreurs Supabase sont propagées comme des exceptions explicites", async (t) => {
  t.mock.method(supabase, "rpc", async () => ({ data: null, error: { message: "boom" } }));
  await assert.rejects(() => getPublicFieldRequirements("r1", "pickup"), /boom/);
  await assert.rejects(() => getPublicDeliveryInfo("r1"), /boom/);
});

test("LOT 2B.1: groupFieldRequirements sépare required/optional et groupe les one_of avec DEUX groupes différents", () => {
  const requirements = [
    { field: "customer_name", requirement: "required" as const, oneOfGroup: null },
    { field: "phone", requirement: "one_of" as const, oneOfGroup: "contact" },
    { field: "email", requirement: "one_of" as const, oneOfGroup: "contact" },
    { field: "room_number", requirement: "one_of" as const, oneOfGroup: "reachability" },
  ];
  const { required, optional, oneOfGroups } = groupFieldRequirements(requirements);
  assert.equal(required.length, 1);
  assert.equal(optional.length, 0);
  assert.equal(oneOfGroups.size, 2);
  assert.deepEqual(oneOfGroups.get("contact")?.map((f) => f.field), ["phone", "email"]);
  assert.deepEqual(oneOfGroups.get("reachability")?.map((f) => f.field), ["room_number"]);
});

test("LOT 2B.1: groupFieldRequirements fonctionne avec un groupe au nom totalement inédit", () => {
  const requirements = [
    { field: "carrier_pigeon_id", requirement: "one_of" as const, oneOfGroup: "avian_delivery_proof_of_concept" },
  ];
  const { oneOfGroups } = groupFieldRequirements(requirements);
  assert.ok(oneOfGroups.has("avian_delivery_proof_of_concept"));
});

test("LOT 2B.1: validateCustomerData détecte les required manquants et les groupes one_of non satisfaits, pour deux groupes distincts", () => {
  const requirements = [
    { field: "customer_name", requirement: "required" as const, oneOfGroup: null },
    { field: "phone", requirement: "one_of" as const, oneOfGroup: "contact" },
    { field: "email", requirement: "one_of" as const, oneOfGroup: "contact" },
    { field: "room_number", requirement: "one_of" as const, oneOfGroup: "reachability" },
  ];

  const emptyResult = validateCustomerData(requirements, {});
  assert.deepEqual(emptyResult.missingRequired, ["customer_name"]);
  assert.deepEqual(emptyResult.unsatisfiedGroups.sort(), ["contact", "reachability"]);

  const partialResult = validateCustomerData(requirements, { customer_name: "Sam", phone: "0600000000" });
  assert.deepEqual(partialResult.missingRequired, []);
  assert.deepEqual(partialResult.unsatisfiedGroups, ["reachability"]);

  const fullResult = validateCustomerData(requirements, { customer_name: "Sam", phone: "0600000000", room_number: "305" });
  assert.deepEqual(fullResult.missingRequired, []);
  assert.deepEqual(fullResult.unsatisfiedGroups, []);
});

test("LOT 2B.1: validateCustomerData traite un champ non renseigné et une chaîne uniquement composée d'espaces comme manquants", () => {
  const requirements = [{ field: "customer_name", requirement: "required" as const, oneOfGroup: null }];
  assert.deepEqual(validateCustomerData(requirements, {}).missingRequired, ["customer_name"]);
  assert.deepEqual(validateCustomerData(requirements, { customer_name: "   " }).missingRequired, ["customer_name"]);
  assert.deepEqual(validateCustomerData(requirements, { customer_name: "Sam" }).missingRequired, []);
});

test("LOT 2B.1: get_restaurant_public_delivery_info n'a AUCUN helper interne", () => {
  const fnCount = (v84Sql.match(/^create function/gm) || []).length;
  assert.equal(fnCount, 1);
  assert.ok(v84Sql.includes("language sql"));
  assert.ok(!v84Sql.includes("language plpgsql"));
});

test("LOT 2B.1: search_path explicite et sécurisé, REVOKE avant GRANT", () => {
  const start = v84Sql.indexOf("create function public.get_restaurant_public_delivery_info");
  const end = v84Sql.indexOf("$$;", start);
  const body = v84Sql.slice(start, end);
  assert.ok(body.includes("set search_path = ''"));
  const revokeIdx = v84Sql.indexOf("revoke all on function public.get_restaurant_public_delivery_info");
  const grantIdx = v84Sql.indexOf("grant execute on function public.get_restaurant_public_delivery_info");
  assert.ok(revokeIdx > 0 && grantIdx > revokeIdx);
});

test("LOT 2B.1: EXECUTE accordé uniquement à anon et authenticated", () => {
  assert.ok(v84Sql.includes("revoke all on function public.get_restaurant_public_delivery_info(uuid) from public;"));
  assert.ok(v84Sql.includes("revoke all on function public.get_restaurant_public_delivery_info(uuid) from anon, authenticated, service_role;"));
  assert.ok(v84Sql.includes("grant execute on function public.get_restaurant_public_delivery_info(uuid) to anon, authenticated;"));
  assert.ok(!v84Sql.includes("to service_role"));
});

test("LOT 2B.1: conversion JSONB -> text[] réutilise exactement le patron déjà audité dans create_order", () => {
  const createOrderSql = readFileSync("supabase/migration-v82-lot2a-sale-modes.sql", "utf8");
  assert.ok(createOrderSql.includes("jsonb_array_elements_text(coalesce(rsm.config->'delivery_zone_prefixes', '[]'::jsonb))"));
  assert.ok(v84Sql.includes("jsonb_array_elements_text(coalesce(rsm.config->'delivery_zone_prefixes', '[]'::jsonb))"));
});

test("LOT 2B.1: les 4 conditions de filtrage exigées sont toutes présentes", () => {
  const start = v84Sql.indexOf("create function public.get_restaurant_public_delivery_info");
  const body = v84Sql.slice(start, v84Sql.indexOf("$$;", start));
  assert.ok(body.includes("mode_code = 'delivery'"));
  assert.ok(body.includes("rsm.enabled = true"));
  assert.ok(body.includes("r.is_active = true"));
  assert.ok(body.includes("r.status = 'active'"));
});

test("LOT 2B.1: aucune exposition de provider ni de config JSONB brut dans le type retourné", () => {
  const start = v84Sql.indexOf("returns table");
  const end = v84Sql.indexOf(")", start);
  const returnShape = v84Sql.slice(start, end);
  assert.ok(!returnShape.includes("provider"));
  assert.ok(!/config\s+jsonb/.test(returnShape));
});

test("LOT 2B.1: le harnais PostgreSQL dédié couvre les scénarios fonctionnels, les cas limites et les privilèges effectifs", () => {
  const requiredMarkers = [
    "actif + delivery activé -> 3 champs retournés",
    "delivery désactivé -> aucune ligne",
    "delivery absent de restaurant_sale_modes",
    "onboarding + delivery activé -> aucune ligne",
    "suspendu + delivery activé -> aucune ligne",
    "inactif + delivery activé -> aucune ligne",
    "clé delivery_zone_prefixes absente -> tableau vide, jamais NULL",
    "tableau JSON vide -> tableau vide, jamais NULL",
    "config NULL -> tableau vide",
    "anon EXECUTE = true",
    "authenticated EXECUTE = true",
    "service_role EXECUTE = false",
    "PUBLIC EXECUTE = false",
  ];
  for (const m of requiredMarkers) {
    assert.ok(harnessSrc.includes(m), `scénario manquant : ${m}`);
  }
});

test("LOT 2B.1: préflight anti-dérive confirme LOT 2A.4 déjà installé et l'absence de double application", () => {
  assert.ok(v84Sql.includes("SCANYM_SCHEMA_DRIFT"));
  assert.ok(v84Sql.includes("restaurant_sale_modes"));
});
