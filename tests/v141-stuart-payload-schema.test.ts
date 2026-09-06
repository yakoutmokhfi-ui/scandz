import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const typesModule = await import("../lib/server/delivery-providers/stuart/types.ts");
type StuartCreateJobPayload = import("../lib/server/delivery-providers/stuart/types.ts").StuartCreateJobPayload;
type StuartPackageType = import("../lib/server/delivery-providers/stuart/types.ts").StuartPackageType;

// ====================================================================
// DELIVERY STREAM C — STUART FOUNDATION / SANDBOX v1.1 (ferme
// STUART-V1-PAYLOAD-SCHEMA-01). Preuve directe de la structure EXACTE
// de la charge utile Create Job, en particulier l'emplacement correct
// de `pickup_at` (job.pickup_at, JAMAIS dans une entrée pickup
// individuelle) et le typage fermé de `package_type`.
// ====================================================================

test("STUART-V1-PAYLOAD-SCHEMA-01 : le module exporte bien les types attendus (garde-fou -- si l'import échoue, tout le reste du fichier est sans objet)", () => {
  assert.ok(typesModule !== undefined);
});

test("STUART-V1-PAYLOAD-SCHEMA-01 : job.pickup_at existe au NIVEAU RACINE du job -- preuve par construction + sérialisation JSON exacte", () => {
  const payload: StuartCreateJobPayload = {
    job: {
      pickup_at: "2026-09-05T14:30:00+02:00",
      pickups: [
        {
          address: "46 Boulevard Barbès, 75018 Paris",
          contact: { firstname: "Martin", lastname: "Pont", phone: "+33698348756", company: "Au Lait Cru" },
        },
      ],
      dropoffs: [
        {
          address: "156 rue de Charonne, 75011 Paris",
          contact: { firstname: "Alex", lastname: "Durand", phone: "+33634981209" },
          client_reference: "A1B2C3D4E5",
          package_type: "small",
          partner_data: { integrator: "scanym" },
        },
      ],
    },
  };

  const serialized = JSON.parse(JSON.stringify(payload));
  assert.equal(serialized.job.pickup_at, "2026-09-05T14:30:00+02:00", "job.pickup_at DOIT exister au niveau racine du job");
  assert.equal(serialized.job.pickups[0].pickup_at, undefined, "AUCUNE entrée pickup individuelle ne doit jamais contenir pickup_at (ferme STUART-V1-PAYLOAD-SCHEMA-01 -- ancien emplacement v1 supprimé)");
});

test("STUART-V1-PAYLOAD-SCHEMA-01 : structure JSON sérialisée EXACTE -- correspond littéralement au contrat attendu, aucun champ additionnel inattendu", () => {
  const payload: StuartCreateJobPayload = {
    job: {
      pickup_at: "2026-09-05T14:30:00+02:00",
      pickups: [
        {
          address: "46 Boulevard Barbès, 75018 Paris",
          comment: "Wait outside for an employee to come.",
          contact: { firstname: "Martin", lastname: "Pont", phone: "+33698348756", company: "Au Lait Cru" },
        },
      ],
      dropoffs: [
        {
          address: "156 rue de Charonne, 75011 Paris",
          package_description: "Sandwich order",
          client_reference: "A1B2C3D4E5",
          package_type: "small",
          contact: { firstname: "Alex", lastname: "Durand", phone: "+33634981209" },
          partner_data: { integrator: "scanym" },
        },
      ],
    },
  };

  const expected = {
    job: {
      pickup_at: "2026-09-05T14:30:00+02:00",
      pickups: [
        {
          address: "46 Boulevard Barbès, 75018 Paris",
          comment: "Wait outside for an employee to come.",
          contact: { firstname: "Martin", lastname: "Pont", phone: "+33698348756", company: "Au Lait Cru" },
        },
      ],
      dropoffs: [
        {
          address: "156 rue de Charonne, 75011 Paris",
          package_description: "Sandwich order",
          client_reference: "A1B2C3D4E5",
          package_type: "small",
          contact: { firstname: "Alex", lastname: "Durand", phone: "+33634981209" },
          partner_data: { integrator: "scanym" },
        },
      ],
    },
  };

  assert.deepEqual(JSON.parse(JSON.stringify(payload)), expected, "la charge utile sérialisée doit correspondre EXACTEMENT au contrat attendu");
});

test("STUART-V1-PAYLOAD-SCHEMA-01 : les 5 valeurs package_type prescrites sont toutes acceptées par le système de types (xsmall/small/medium/large/xlarge)", () => {
  const values: StuartPackageType[] = ["xsmall", "small", "medium", "large", "xlarge"];
  for (const v of values) {
    const dropoff: import("../lib/server/delivery-providers/stuart/types.ts").StuartDropoff = {
      address: "test",
      contact: { phone: "+33600000000", firstname: "Test", lastname: "User" },
      client_reference: "TEST000001",
      package_type: v,
    };
    assert.equal(dropoff.package_type, v);
  }
});

test("STUART-V11-PAYLOAD-REQUIREDNESS-01 : package_type est OBLIGATOIRE -- l'OMETTRE est REJETÉ AU NIVEAU COMPILATION, preuve par @ts-expect-error (échec de compilation si le champ redevenait optionnel)", () => {
  // @ts-expect-error -- package_type est désormais un champ OBLIGATOIRE de StuartDropoff (ferme STUART-V11-PAYLOAD-REQUIREDNESS-01) ; si cette ligne compile un jour sans erreur, l'exigibilité a régressé.
  const dropoffMissingPackageType: import("../lib/server/delivery-providers/stuart/types.ts").StuartDropoff = {
    address: "test",
    contact: { phone: "+33600000000", firstname: "Test", lastname: "User" },
    client_reference: "TEST000001",
  };
  // Assertion runtime complémentaire (défense en profondeur, jamais la preuve principale -- la preuve principale est la ligne @ts-expect-error ci-dessus, vérifiée par tsc --noEmit) :
  assert.equal(typeof dropoffMissingPackageType, "object");
});

test("STUART-V1-PAYLOAD-SCHEMA-01 : REJET AU NIVEAU COMPILATION d'une valeur package_type non supportée -- preuve par @ts-expect-error (échec de compilation si le type redevient permissif)", () => {
  // @ts-expect-error -- "gigantic" n'appartient pas à StuartPackageType ; si cette ligne compile un jour sans erreur, le typage fermé a régressé.
  const invalid: StuartPackageType = "gigantic";
  // Assertion runtime complémentaire (défense en profondeur, jamais la preuve principale ici -- la preuve principale est la ligne @ts-expect-error ci-dessus, vérifiée par tsc --noEmit dans la CI de ce lot) :
  assert.equal(typeof invalid, "string");
});
