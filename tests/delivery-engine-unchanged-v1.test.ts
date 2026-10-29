// DELIVERY PUBLIC TEXT & RULE MANAGEMENT v1 -- "no pricing-engine change" proof.
// The pricing engine, the postcode eligibility / country scope / minimum-item logic, the checkout
// delivery fee path, the order snapshot and create_order authority live in these files. Their
// SHA-256 are pinned to the authoritative base 79653919e1b34abaa31855f8c22c70e8dac47cb9: this lot
// must not touch them. (The SQL side is proven by tests/delivery-rule-delete-v1-sql.test.ts, which
// compares pg_get_functiondef of resolve_delivery_fulfillment, create_order, the public
// projection, the tester and the pricing RPCs before/after the delete migration.)
// A deliberate future change to one of them must update this pin in its own reviewed commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const PINNED: Record<string, string> = {
  "lib/delivery.ts": "c3bdc4a323e3903729b0c604f9790f325f1e2824f70d05a1f648b5a43a7dd542",
  "lib/delivery-discount.ts": "f639ed105d1deeb39d36f716d29a3c4bac3cc61a387cc5ff881801527d001094",
  "lib/delivery-pricing-policy.ts": "03e8040324e70ef16a05bc811a1f7df1addad637b93477db9583b1985d305ae2",
  "lib/delivery-pricing-policy-errors.ts": "d81d6d0d8d93778bf0530978d3f0afae6ac341e628584cb240064ba272cd89ca",
  "lib/delivery-customer-notice.ts": "79fcefb0fac1235fea1bfa9f343816d64990bffdf9a7e69245807e930119d244",
  "lib/delivery-country.ts": "b9477a5e11d2d6015e8753250a665077648b15f9dfd7bc08febaea93e58e2585",
  "lib/delivery-zone-validation.ts": "6c13498c77bca85d6183deeae7ad8d62670b7da9bbd4ef9f7641025e43a957d2",
  "lib/sale-modes-public.ts": "34bec4a68c5b4b6e538cc78ba2dc053d8954a99a3d54051710a407766eb4749f",
  "lib/sale-modes-types.ts": "239edb1b6d797e499ebb2db91bf4e430a70b4fb017c033b38aad24c5c15d78e0",
  "lib/menu-i18n.ts": "e150fe5e7d6f955296683064804318f7600fc150a06cbc2f48834ab1487a0b2e",
  // RE-ÉPINGLAGE DÉLIBÉRÉ, dans son propre commit (CSDJ-2, issue #158) :
  // CartPanel reçoit deux props optionnelles (`scheduleSection`,
  // `scheduleHint`) pour afficher le choix de date/créneau du retrait et
  // l'indication « choisissez une date ». AUCUNE ligne du moteur de tarifs,
  // de l'éligibilité par code postal, du périmètre pays, du minimum
  // d'articles ni des frais n'est touchée : voir le diff de ce commit.
  // Ancien SHA-256 : 97f7cf27009753ff8e8822a9cabfd7ed52104a026fbf75fdd11724028800cc62
  // RE-ÉPINGLAGE DÉLIBÉRÉ, dans son propre commit (PAYMENT P4-A) :
  // CartPanel reçoit trois props optionnelles (`paymentError`,
  // `isRetryingPayment`, `onRetryPayment`) pour remplacer le bouton d'envoi
  // par une reprise CIBLÉE du paiement quand la commande existe déjà.
  // AUCUNE ligne du moteur de tarifs, de l'éligibilité par code postal, du
  // périmètre pays, du minimum d'articles ni des frais n'est touchée : voir
  // le diff de ce commit.
  // Ancien SHA-256 : 8696fc3b3b4dcef840f7b07e4abfb61d06300cd5680157db84e980b61ebb33e1
  // UX LOT 2026-10 (demande Emmanuel) -- re-pin : CartPanel gagne le
  // masquage du champ note (restaurant_configs.order_note_enabled =
  // false) et, audit Maxwell P2, l'ignorance de la validation de note
  // quand le champ est désactivé. (La case de confirmation d'âge du
  // commit 34cc977 a été retirée : décision de périmètre 27/10/2026.)
  // Moteur de tarifs / éligibilité / périmètre pays / minimum / frais :
  // AUCUNE ligne touchée (voir le diff du commit).
  // SHA-256 précédent : d0061d421a1eb48920f480f3220fc656a62640b4051b7e1040a14f6002ac198b
  // Issue #155 -- re-pin : visibilité CIBLÉE du message « {mode}
  // indisponible avec ce panier » (masqué quand un autre mode est choisi,
  // réaffiché à la tentative) ; bouton bloqué en aria-disabled. Règles de
  // livraison, tarifs, éligibilité, périmètre pays : AUCUNE ligne touchée.
  // SHA-256 précédent : 2c2b47a6456eef5bcd27cafb87b3570589137b18e5307c47ee697967beea0939
  // #181 -- RÉCAPITULATIF AVANT PAIEMENT (re-pin DIVULGUÉ) : CartPanel gagne une étape
  // « récapitulatif » entre le bouton d'envoi et onSendOrder (articles, mode, adresse,
  // créneau, note ; confirmation désactivée sans CGV ; bloc de saisie masqué, jamais
  // démonté). Règles de livraison, tarifs, éligibilité, périmètre pays : AUCUNE ligne touchée.
  // SHA-256 précédent : 1775879094580b640c2296327a609d15389b9338e35e8dd9e775ac967d0f9914
  // Issue #183 -- RE-PIN DIVULGUÉ : CartPanel n'ouvre plus la fenêtre « Délai et
  // informations de livraison » après le choix du créneau (décision produit) :
  // retrait de l'import, de l'état/garde de confirmation, de confirmTimingNotice et
  // du rendu de DeliveryTimingNoticeDialog ; `requestOrderSubmission` va droit à
  // openReviewOrSend. Règles de livraison, tarifs, éligibilité, périmètre pays,
  // minimum, frais : AUCUNE ligne touchée.
  // SHA-256 précédent : dd4bb3cc471c1bedd6a76d8c743cb36e3fcf66212a7e033ae185332debf81a15
  "components/CartPanel.tsx": "3ba335456b2f11ba9c8f65309ec6cd06e92a64b3a297666fe1984d47dc4b8796",
  "supabase/DRAFT-lot-delivery-pricing-v2-b1-order-snapshot-v1.sql": "b2cd875fe3be9eb3d415899179b3b2cb46901ea6770cfbed66b506bf30b54803",
  "supabase/DRAFT-lot-delivery-pricing-v2-b234.sql": "53cca852afd14563b1beeb6583bf22db9ab92a1f3d4bb1ec7efaf162fcde3664",
  "supabase/DRAFT-lot-delivery-pricing-v2-b5.sql": "dfd9292699b7e102bfcc35838c6d2b6180df5ef42f4c05764246253cb5aeaf2b",
  "supabase/DRAFT-lot-delivery-country-scope-v1.sql": "cb49c754c1542c63c08d5305adfe3987722c237250ff42a93d5c4f92a2000a7c"
};

for (const [file, sha] of Object.entries(PINNED)) {
  test(`unchanged since base 79653919: ${file}`, () => {
    assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), sha);
  });
}

test("DeliveryPostcodeResult (availability, real fee, discount applied, missing items, matched rule text) is byte-identical to base", () => {
  const src = readFileSync("components/DeliveryConditions.tsx", "utf8");
  const slice = src.slice(src.indexOf("/** One popup per meaningful resolved result"));
  assert.equal(createHash("sha256").update(slice).digest("hex"), "ef6a193f34c1a81cd31fba02fb92f4726ef63da2efd809f01ae0c68679a0decb");
});
