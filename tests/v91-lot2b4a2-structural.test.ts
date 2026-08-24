import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// ====================================================================
// LOT 2B.4a.2 -- DYNAMIC CUSTOMER FORM RUNTIME SWITCH -- invariants
// structurels :
//   1. le formulaire actif (MenuView.tsx, FulfillmentSelector.tsx,
//      CartPanel.tsx) A RÉELLEMENT basculé vers les exigences
//      génériques (usePublicFieldRequirements, LOT 2B.4a.1) -- plus
//      aucune lecture de settings.requiredCustomerFields (legacy,
//      restaurants-config.ts) par le formulaire actif ;
//   2. le cas spécial "delivery_address" (1 champ backend, 3
//      sous-champs UI) et le rendu one_of sont bien présents ;
//   3. les fichiers dont la compatibilité devait être "soigneusement
//      vérifiée" (section 7 de la mission) -- lib/whatsapp.ts,
//      lib/services/order-payload.ts, lib/delivery.ts -- restent
//      BYTE-IDENTIQUES à la baseline (aucune modification, contrat
//      backend create_order/WhatsApp inchangé) ;
//   4. aucun fichier hors périmètre (SQL, cycle de vie de commande
//      avancé, Dashboard) n'apparaît dans le diff réel -- vérifié par
//      git, jamais une simple relecture du patch.
// ====================================================================

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\/.*$/gm, "");
}

const menuViewSrc = readFileSync("components/MenuView.tsx", "utf8");
const menuViewCodeOnly = stripComments(menuViewSrc);
const fulfillmentSrc = readFileSync("components/FulfillmentSelector.tsx", "utf8");
const fulfillmentCodeOnly = stripComments(fulfillmentSrc);
const cartPanelSrc = readFileSync("components/CartPanel.tsx", "utf8");

/**
 * AU LAIT CRU (sale modes) -- correction : ce helper renvoyait
 * initialement le diff de l'ARBRE DE TRAVAIL COURANT (git diff HEAD +
 * fichiers non suivis), une notion qui n'a de sens QUE pendant la
 * fenêtre de revue de LOT 2B.4a.2 lui-même (avant son merge). Une fois
 * ce lot fusionné (commit acd9393, voir git log), ce diff ambiant ne
 * représente plus DU TOUT les changements de LOT 2B.4a.2 -- il capture
 * n'importe quel travail EN COURS dans un lot ultérieur, quel qu'il
 * soit. Concrètement : le test "aucun fichier hors périmètre" ci-
 * dessous a échoué à tort dès que ce lot (AU LAIT CRU) a introduit son
 * propre fichier supabase/ légitime (préparation SQL explicitement
 * autorisée par sa mission), alors que LOT 2B.4a.2 n'a évidemment rien
 * à voir avec ce fichier.
 *
 * Correction : ancrer le diff sur la PLAGE HISTORIQUE IMMUABLE du
 * commit réel de LOT 2B.4a.2 (acd9393, son parent 70d6991 -- "Merge
 * LOT 2B.4a.1 v2 customer requirements foundation") plutôt que sur
 * l'arbre de travail courant. Résultat identique aujourd'hui (mêmes 9
 * fichiers), mais désormais VRAI POUR TOUJOURS, y compris pour tout
 * lot ultérieur qui ajoute légitimement ses propres fichiers.
 */
function changedFiles(): string[] {
  const LOT_2B4A2_PARENT = "70d69914cd232d018162ddbf2668876a178e879a";
  const LOT_2B4A2_COMMIT = "acd939345c392831e308c12b48e3b96c8b4d16ea";
  return execFileSync(
    "git",
    ["diff", "--name-only", LOT_2B4A2_PARENT, LOT_2B4A2_COMMIT],
    { encoding: "utf8" }
  )
    .split("\n")
    .filter(Boolean);
}

test("LOT 2B.4a.2: MenuView.tsx consomme réellement usePublicFieldRequirements/canAttemptSubmit, plus un simple import mort", () => {
  assert.ok(menuViewSrc.includes('from "@/lib/use-public-field-requirements"'));
  assert.ok(menuViewCodeOnly.includes("usePublicFieldRequirements(restaurant.id"));
  assert.ok(menuViewCodeOnly.includes("canAttemptSubmit("));
});

test("LOT 2B.4a.2: MenuView.tsx ne lit plus JAMAIS settings.requiredCustomerFields (bascule réelle, plus une fondation dormante)", () => {
  assert.ok(!menuViewCodeOnly.includes("requiredCustomerFields"));
});

test("LOT 2B.4a.2: MenuView.tsx utilise validateCustomerData/buildFieldRequirementDisplayItems (LOT 2B.1/2B.4a.1), aucune réimplémentation de la validation générique", () => {
  assert.ok(menuViewCodeOnly.includes("validateCustomerData("));
  assert.ok(menuViewCodeOnly.includes("buildFieldRequirementDisplayItems("));
});

test("LOT 2B.4a.2: FulfillmentSelector.tsx n'accepte plus requiredFields: (keyof CustomerInfo)[] -- rendu piloté par displayItems (FieldRequirementDisplayItem[])", () => {
  assert.ok(!fulfillmentSrc.includes("requiredFields: (keyof CustomerInfo)[]"));
  assert.ok(fulfillmentSrc.includes("displayItems: FieldRequirementDisplayItem[]"));
  assert.ok(fulfillmentSrc.includes('from "@/lib/sale-modes-public"'));
});

test("LOT 2B.4a.2: FulfillmentSelector.tsx ne contient plus aucun need(\"...\") codé en dur par nom de champ CustomerInfo", () => {
  // L'ancien mécanisme testait littéralement `need("name")`,
  // `need("street")`, etc. -- absence totale de ce patron dans le
  // CODE RÉEL (commentaires exclus : ce fichier documente
  // volontairement l'ancien patron par son nom, à des fins
  // explicatives), preuve structurelle complémentaire des tests
  // comportementaux (voir tests/v91-lot2b4a2-dynamic-form.dom.test.ts).
  assert.ok(!/\bneed\(\s*["']/.test(fulfillmentCodeOnly));
});

test("LOT 2B.4a.2: cas spécial delivery_address (1 champ backend, 3 sous-champs UI) explicitement présent dans le rendu", () => {
  assert.ok(fulfillmentSrc.includes("renderDeliveryAddress"));
  assert.ok(fulfillmentSrc.includes('"delivery_address"'));
  // Les 3 sous-champs UI restent bien street/postalCode/city --
  // jamais fusionnés ni renommés.
  assert.ok(fulfillmentSrc.includes('id="street"'));
  assert.ok(fulfillmentSrc.includes('id="postalCode"'));
  assert.ok(fulfillmentSrc.includes('id="city"'));
});

test("LOT 2B.4a.2: rendu générique des groupes one_of, sans nom de groupe codé en dur (ex. \"contact\" n'apparaît nulle part)", () => {
  assert.ok(fulfillmentSrc.includes("renderOneOfGroup"));
  assert.ok(fulfillmentSrc.includes("fieldOneOfRequired"));
  // Recherché dans le CODE réel uniquement (commentaires exclus : ce
  // fichier mentionne volontairement "contact" en commentaire, à
  // titre d'exemple de ce qui ne doit PAS être codé en dur).
  assert.ok(!fulfillmentCodeOnly.toLowerCase().includes('"contact"'));
});

test("LOT 2B.4a.2: CartPanel.tsx transmet displayItems/fieldRequirementsReady à FulfillmentSelector, plus requiredFields", () => {
  assert.ok(!cartPanelSrc.includes("requiredFields"));
  assert.ok(cartPanelSrc.includes("displayItems={displayItems}"));
  assert.ok(cartPanelSrc.includes("fieldRequirementsReady={fieldRequirementsReady}"));
});

test("LOT 2B.4a.2: compatibilité WhatsApp / création de commande -- lib/whatsapp.ts, lib/services/order-payload.ts, lib/delivery.ts restent BYTE-IDENTIQUES à la baseline (section 7 de la mission)", () => {
  const files = changedFiles();
  for (const untouched of [
    "lib/whatsapp.ts",
    "lib/services/order-payload.ts",
    "lib/delivery.ts",
    "lib/restaurants-config.ts",
  ]) {
    assert.ok(
      !files.includes(untouched),
      `${untouched} ne devrait PAS apparaître dans le diff -- le contrat OrderContext/CustomerInfo est préservé intégralement par MenuView.tsx (traduction locale vers CustomerData), aucune modification requise ici`
    );
  }
});

test("LOT 2B.4a.2: aucun fichier hors périmètre (SQL/RPC, cycle de vie de commande avancé, Dashboard) n'apparaît dans le diff réel", () => {
  const files = changedFiles();

  const sqlChanges = files.filter((f) => f.startsWith("supabase/"));
  assert.deepEqual(sqlChanges, [], "aucun fichier supabase/ ne doit apparaître dans le diff -- LOT 2B.4a.2 n'implique aucun changement SQL/RPC/RLS");

  const OUT_OF_SCOPE = [
    "lib/services/orders.ts",
    "lib/dashboard-types.ts",
    "lib/dashboard-nav.ts",
    "lib/services/dashboard.ts",
    "lib/receipt.ts",
  ];
  for (const forbidden of OUT_OF_SCOPE) {
    assert.ok(
      !files.includes(forbidden),
      `${forbidden} apparaît dans le diff -- hors périmètre de LOT 2B.4a.2 (section "absolument hors scope" de la mission)`
    );
  }
});

test("LOT 2B.4a.2: les fichiers attendus de ce lot sont bien versionnés (preuve positive)", () => {
  const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

  const expectedTouched = [
    "components/MenuView.tsx",
    "components/FulfillmentSelector.tsx",
    "components/CartPanel.tsx",
    "lib/customer.ts",
    "lib/i18n.ts",
  ];
  for (const f of expectedTouched) {
    assert.ok(trackedFiles.includes(f), `${f} devrait être versionné (livré) par ce lot`);
  }
});
