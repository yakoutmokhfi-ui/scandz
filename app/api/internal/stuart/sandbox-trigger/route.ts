import "server-only";
import { timingSafeEqual, createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { resolveStuartEnvironment } from "@/lib/server/delivery-providers/stuart/environment";
import {
  createStuartSandboxJobForOrder,
  StuartProductionForbiddenError,
  StuartCreateJobAmbiguousError,
  StuartCreateJobBlockedByAmbiguityError,
  StuartCreateJobTerminalFailureError,
  StuartAllocationCollisionExhaustedError,
} from "@/lib/server/delivery-providers/stuart/create-job";
import { verifyStuartSandboxSyntheticOrder } from "@/lib/server/delivery-providers/stuart/allocation";

/**
 * DELIVERY STREAM C — STUART SANDBOX INTEGRATION v2.6.1
 * DÉCLENCHEUR D'EXÉCUTION SANDBOX CONTRÔLÉE -- remédiation de 3
 * findings Work (STUART-V26-SYNTHETIC-GUARD-01 HIGH,
 * STUART-V26-P3A1-ALLOWLIST-01 MEDIUM,
 * STUART-V26-PICKUP-CONTACT-01 MEDIUM).
 *
 * IMPORTS -- EXACTEMENT ceux approuvés par la règle structurelle
 * dédiée (STUART-V26-P3A1-ALLOWLIST-01, voir
 * tests/v110c-payment-p3a1-structural.test.ts) :
 * `@/lib/server/delivery-providers/stuart/environment`,
 * `@/lib/server/delivery-providers/stuart/create-job`,
 * `@/lib/server/delivery-providers/stuart/allocation` -- JAMAIS un
 * module Monetico, JAMAIS un autre prestataire de livraison, JAMAIS
 * un module server arbitraire.
 *
 * SYNTHETIC GUARD (v2.6.1, nouveau) : avant TOUTE allocation/
 * orchestration, `verifyStuartSandboxSyntheticOrder()` vérifie
 * ATOMIQUEMENT côté SQL la désignation persistante (jamais
 * contrôlable par cette requête HTTP), l'absence de PII client
 * réelle, et l'absence de corrélation Stuart incompatible -- en plus
 * (jamais à la place) de la correspondance stricte aux variables
 * d'environnement `STUART_SANDBOX_TEST_ORDER_ID`/
 * `STUART_SANDBOX_TEST_RESTAURANT_ID` (défense en profondeur : un
 * couple orderId/restaurantId correct dans Vercel SEUL ne suffit
 * plus, la désignation SQL persistante est ÉGALEMENT requise).
 *
 * CONTACT SAFETY (v2.6.1) : AUCUNE identité/numéro réel de marchand
 * ou de client -- toutes les valeurs de contact (nom, société,
 * téléphone) sont des constantes SYNTHÉTIQUES explicitement libellées
 * "SandboxSynthetic"/"SCANYM-TEST", jamais l'identité réelle du
 * marchand pilote/client. Seule l'ADRESSE DE RUE de retrait reste réelle
 * (couverture géographique Paris, mandat : "MAY remain only if needed
 * for geographic coverage testing and only if the rest of the
 * contact is synthetic") -- documenté explicitement ci-dessous.
 */
export const runtime = "nodejs";

const SECRET_HEADER = "x-stuart-sandbox-trigger-secret";
const EXPECTED_SANDBOX_BASE_URL = "https://api.sandbox.stuart.com";

/**
 * PII synthétique attendue sur la commande de test -- comparée
 * STRICTEMENT côté SQL (`verify_stuart_sandbox_synthetic_order`).
 * CORRECTIF v2.6.4 (STUART-V26-SYNTHETIC-GUARD-01, réouvert) :
 * inventaire COMPLET des 6 champs identifiants réellement persistés
 * par `orders` (confirmés par `purge_old_customer_data()`, l'autorité
 * RGPD existante du système -- jamais une supposition de nom de
 * champ). `expectedCustomerEmail`/`expectedDeliveryZone`/
 * `expectedCustomerNote` sont volontairement NULL -- la commande de
 * test synthétique n'a pas besoin de les renseigner, et NULL est une
 * valeur explicitement acceptée par la vérification SQL (comparaison
 * `IS NOT DISTINCT FROM`, jamais un contournement).
 *
 * CORRECTIF v2.6.4 (STUART-V26-PICKUP-CONTACT-01, réouvert) : les
 * numéros DEVINÉS ARBITRAIREMENT (v2.6.1) N'ÉTAIENT PAS des
 * valeurs officiellement garanties sûres -- simples suppositions.
 * Remplacés par le préfixe mobile FICTIF `06 39 98 XX XX`,
 * OFFICIELLEMENT RÉSERVÉ par l'ARCEP (régulateur français des
 * télécommunications) pour les œuvres audiovisuelles -- Décision
 * n° 2018-0881 du 24 juillet 2018, article 2.5.12 : "il est précisé
 * que ces numéros ne pourront ni appeler ou être utilisés comme
 * identifiant d'appelant, ni être appelés." Cette garantie est
 * RÉGLEMENTAIRE (loi française, opposable à TOUS les opérateurs
 * téléphoniques français) -- structurellement PLUS FORTE qu'une
 * simple convention Stuart, puisqu'elle rend le numéro
 * STRUCTURELLEMENT INJOIGNABLE, quel que soit l'opérateur ou le
 * canal (voix, SMS). Source officielle :
 * https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000037262971
 * (Décision Arcep n° 2018-0881, article 2.5.12).
 */
const EXPECTED_SYNTHETIC_CUSTOMER_PHONE = "+33639980001";
const EXPECTED_SYNTHETIC_CUSTOMER_NAME = "Scanym SandboxSynthetic";
const EXPECTED_SYNTHETIC_CUSTOMER_EMAIL = null;
/**
 * CORRECTIF v2.6.7 (STUART-V264-REAL-DROPOFF-ADDRESS-01,
 * STUART-V265-DROPOFF-AUTHORIZATION-EVIDENCE-01, HIGH -- FERMÉS) :
 * le CIO a fourni EXPLICITEMENT deux adresses DISTINCTES,
 * explicitement autorisées pour le test Stuart Sandbox contrôlé :
 * - retrait : adresse de l'établissement pilote (boutique) ;
 * - dépôt : adresse explicitement contrôlée et autorisée par le CIO
 *   pour un test technique Stuart Sandbox, distincte du retrait.
 * Les deux adresses sont situées dans le 18e arrondissement de
 * Paris. Cette autorisation est STRICTEMENT limitée au test Sandbox
 * technique, aux identités synthétiques, et aux numéros de téléphone
 * réservés ARCEP -- AUCUNE commande cliente réelle, AUCUN job Stuart
 * Production. Voir DROPOFF-AUTHORIZATION-EVIDENCE.md pour le détail
 * complet. AUCUNE approbation officielle Stuart n'est revendiquée --
 * seule l'autorisation CIO/Scanym est affirmée.
 */
const EXPECTED_SYNTHETIC_DELIVERY_ADDRESS = "2 Place Constantin Pecqueur, 75018 Paris, France";
/**
 * CORRECTIF v2.6.6 (STUART-V265-ROUTE-SQL-ZONE-CONTRACT-01, HIGH),
 * revérifié en v2.6.7 pour la nouvelle adresse de dépôt CIO : `null`
 * serait INCORRECT -- `create_order()` (dernière définition
 * effective au baseline authoritative, RECEIPT / INVOICE TAX DETAIL
 * v1.1) dérive TOUJOURS un code postal non-NULL pour une commande en
 * mode delivery (`raise exception 'Code postal absent de l'adresse'`
 * si aucun n'est trouvé -- jamais silencieusement NULL). Pour
 * l'adresse "2 Place Constantin Pecqueur, 75018 Paris, France", le
 * moteur "ancien" (utilisé en l'absence de
 * `restaurant_sale_mode_fulfillments`) extrait le code postal par
 * expression régulière directement depuis le texte de l'adresse
 * (`substring(v_address from '\\m(\\d{5})\\M')`) -- soit
 * EXACTEMENT "75018", vérifié par un VRAI appel create_order() contre
 * PostgreSQL (jamais deviné). Cette même valeur est persistée à
 * l'identique dans `orders.delivery_zone` ET
 * `order_delivery_address.postal_code`.
 */
const EXPECTED_SYNTHETIC_DELIVERY_ZONE = "75018";
const EXPECTED_SYNTHETIC_CUSTOMER_NOTE = null;

/**
 * Fixtures Sandbox FIGÉES côté serveur -- jamais acceptées depuis la
 * requête (mandat "must not permit arbitrary Stuart payload
 * submission").
 *
 * CORRECTIF v2.6.4 : contacts pickup ET dropoff utilisent désormais
 * EXCLUSIVEMENT le préfixe mobile fictif officiel ARCEP `06 39 98`
 * (voir constante ci-dessus pour la preuve/source complète) --
 * DEUX numéros DISTINCTS au sein du MÊME bloc réservé (10 000
 * numéros disponibles, `06 39 98 00 00` à `06 39 98 99 99`), jamais
 * un numéro deviné arbitrairement.
 *
 * CORRECTIF v2.6.7 : pickup et dropoff sont désormais DEUX adresses
 * DISTINCTES, toutes deux explicitement autorisées par le CIO
 * (voir DROPOFF-AUTHORIZATION-EVIDENCE.md) -- aucun nom de personne
 * privée n'apparaît, identité/société/téléphone entièrement
 * synthétiques.
 */
const SANDBOX_TEST_FIXTURE = {
  pickup: {
    address: "114 Rue Ordener, 75018 Paris, France",
    contact: {
      phone: "+33639980000",
      firstname: "Scanym",
      lastname: "SandboxSynthetic",
      company: "SCANYM-TEST-PICKUP",
    },
  },
  dropoff: {
    address: EXPECTED_SYNTHETIC_DELIVERY_ADDRESS,
    contact: {
      phone: EXPECTED_SYNTHETIC_CUSTOMER_PHONE,
      firstname: "Scanym",
      lastname: "SandboxSynthetic",
    },
    packageType: "small" as const,
    packageDescription: "SCANYM SANDBOX TEST -- SYNTHETIC, NO REAL DELIVERY",
  },
  partnerData: { integrator: "scanym" },
};

/**
 * CORRECTIF v2.6.3 (STUART-V262-AUTH-TIMING-LENGTH-01, LOW) --
 * même correctif exact que la sonde de préparation runtime : empreinte
 * SHA-256 à longueur fixe AVANT toute comparaison, plus aucun retour
 * anticipé basé sur la longueur brute de la valeur fournie par
 * l'appelant.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * CORRECTIF v2.6.5 (STUART-V262-AUTH-TIMING-LENGTH-01, LOW, réouvert) :
 * l'ancienne version retournait `false` immédiatement pour un
 * en-tête ABSENT ou PRÉSENT-MAIS-VIDE, AVANT tout appel à la
 * comparaison cryptographique -- cette branche dépendait d'une
 * valeur ENTIÈREMENT CONTRÔLÉE PAR L'APPELANT (l'en-tête HTTP lui-même).
 * Corrigé : la valeur fournie par l'appelant est normalisée en chaîne
 * vide si absente (`?? ""`) puis passe TOUJOURS par l'empreinte
 * SHA-256 à longueur fixe et `timingSafeEqual`, quelle que soit sa
 * valeur (absente, vide, courte, longue, de longueur égale, ou
 * correcte). SEULE la vérification du secret CONFIGURÉ CÔTÉ SERVEUR
 * (jamais une valeur contrôlée par l'appelant) peut encore échouer
 * fermé avant la comparaison -- ce n'est pas un canal auxiliaire
 * exploitable par un appelant externe.
 */
function isAuthorized(request: NextRequest): boolean {
  const configured = process.env.STUART_SANDBOX_TRIGGER_SECRET;
  if (typeof configured !== "string" || configured.length === 0) return false;
  const provided = request.headers.get(SECRET_HEADER) ?? "";
  return timingSafeStringEqual(provided, configured);
}

function isConfiguredTestOrder(orderId: string, restaurantId: string): boolean {
  const allowedOrderId = process.env.STUART_SANDBOX_TEST_ORDER_ID;
  const allowedRestaurantId = process.env.STUART_SANDBOX_TEST_RESTAURANT_ID;
  if (typeof allowedOrderId !== "string" || allowedOrderId.length === 0) return false;
  if (typeof allowedRestaurantId !== "string" || allowedRestaurantId.length === 0) return false;
  return orderId === allowedOrderId && restaurantId === allowedRestaurantId;
}

interface TriggerRequestBody {
  orderId?: unknown;
  restaurantId?: unknown;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ outcome: "unavailable" }, { status: 503 });
  }

  let environment: string;
  let baseUrl: string;
  try {
    ({ environment, baseUrl } = resolveStuartEnvironment());
  } catch {
    return NextResponse.json({ outcome: "environment_unavailable" }, { status: 503 });
  }
  if (environment !== "sandbox") {
    return NextResponse.json({ outcome: "production_forbidden" }, { status: 403 });
  }
  if (baseUrl !== EXPECTED_SANDBOX_BASE_URL) {
    return NextResponse.json({ outcome: "unexpected_base_url" }, { status: 503 });
  }

  let body: TriggerRequestBody;
  try {
    body = (await request.json()) as TriggerRequestBody;
  } catch {
    return NextResponse.json({ outcome: "invalid_request_body" }, { status: 400 });
  }
  const orderId = body.orderId;
  const restaurantId = body.restaurantId;
  if (typeof orderId !== "string" || orderId.length === 0 || typeof restaurantId !== "string" || restaurantId.length === 0) {
    return NextResponse.json({ outcome: "invalid_request_body" }, { status: 400 });
  }

  // DÉFENSE EN PROFONDEUR (couche 1) : couple orderId/restaurantId
  // DOIT correspondre exactement à la configuration Vercel.
  if (!isConfiguredTestOrder(orderId, restaurantId)) {
    return NextResponse.json({ outcome: "not_a_synthetic_test_order" }, { status: 403 });
  }

  // CORRECTIF v2.6.1 (STUART-V26-SYNTHETIC-GUARD-01, couche 2,
  // INDÉPENDANTE) : désignation persistante SQL + absence de PII
  // réelle + absence de corrélation incompatible -- jamais une simple
  // variable d'environnement seule (mandat §7, littéral : "cannot
  // satisfy the invariant only because someone misconfigured Vercel
  // environment variables").
  let isSynthetic: boolean;
  try {
    isSynthetic = await verifyStuartSandboxSyntheticOrder({
      orderId,
      restaurantId,
      expectedCustomerPhone: EXPECTED_SYNTHETIC_CUSTOMER_PHONE,
      expectedCustomerName: EXPECTED_SYNTHETIC_CUSTOMER_NAME,
      expectedCustomerEmail: EXPECTED_SYNTHETIC_CUSTOMER_EMAIL,
      expectedDeliveryAddress: EXPECTED_SYNTHETIC_DELIVERY_ADDRESS,
      expectedDeliveryZone: EXPECTED_SYNTHETIC_DELIVERY_ZONE,
      expectedCustomerNote: EXPECTED_SYNTHETIC_CUSTOMER_NOTE,
    });
  } catch {
    return NextResponse.json({ outcome: "synthetic_guard_unavailable" }, { status: 503 });
  }
  if (!isSynthetic) {
    return NextResponse.json({ outcome: "not_a_synthetic_test_order" }, { status: 403 });
  }

  try {
    const result = await createStuartSandboxJobForOrder({
      orderId,
      restaurantId,
      pickup: SANDBOX_TEST_FIXTURE.pickup,
      dropoff: SANDBOX_TEST_FIXTURE.dropoff,
      partnerData: SANDBOX_TEST_FIXTURE.partnerData,
    });
    return NextResponse.json(
      { outcome: "ok", sendState: result.sendState, hasStuartJobId: result.stuartJobId !== null },
      { status: 200 }
    );
  } catch (err) {
    if (err instanceof StuartProductionForbiddenError) {
      return NextResponse.json({ outcome: "production_forbidden" }, { status: 403 });
    }
    if (err instanceof StuartCreateJobBlockedByAmbiguityError) {
      return NextResponse.json({ outcome: "blocked_by_prior_ambiguity" }, { status: 409 });
    }
    if (err instanceof StuartCreateJobAmbiguousError) {
      return NextResponse.json({ outcome: "send_ambiguous" }, { status: 502 });
    }
    if (err instanceof StuartCreateJobTerminalFailureError) {
      return NextResponse.json({ outcome: "terminal_failure" }, { status: 502 });
    }
    if (err instanceof StuartAllocationCollisionExhaustedError) {
      return NextResponse.json({ outcome: "allocation_collision_exhausted" }, { status: 502 });
    }
    return NextResponse.json({ outcome: "unavailable" }, { status: 502 });
  }
}
