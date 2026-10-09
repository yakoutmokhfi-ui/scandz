import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { orderHasWithdrawalEligibleLine } from "@/lib/server/withdrawal-eligibility-service";

/**
 * Scanym — MERCHANT CUSTOMER COMMUNICATIONS v1 — ÉLIGIBILITÉ À LA
 * RÉTRACTATION D'UNE COMMANDE (lecture seule).
 *
 * Adaptateur HTTP fin, sans logique de confiance propre -- même patron
 * exact que app/api/checkout/invoice-request/route.ts : la preuve de
 * possession (order_id + public_token) est vérifiée par la RPC SQL
 * `order_has_withdrawal_eligible_line` (SECURITY DEFINER, service_role
 * UNIQUEMENT), jamais dupliquée ici.
 *
 * POURQUOI UNE ROUTE ET PAS UN APPEL ANON DIRECT : l'éligibilité par
 * ligne est une classification OPÉRATIONNELLE INTERNE du commerçant.
 * lib/services/restaurant.ts la retire déjà explicitement de la carte
 * publique pour cette raison. Elle ne doit donc pas devenir interrogeable
 * par `anon` : seul un AGRÉGAT booléen, pour UNE commande dont l'appelant
 * prouve la possession, traverse cette frontière.
 *
 * Appelée par le navigateur APRÈS la création de commande -- jamais
 * avant, jamais à la place. Aucune écriture, aucun déclenchement de
 * paiement, de transporteur ou d'e-mail.
 *
 * FERMÉE AU REPOS : toute anomalie répond `{ eligible: false }`, jamais
 * une erreur exploitable pour sonder l'existence d'une commande. Le
 * client n'affiche alors aucun appel à l'action.
 */
export const runtime = "nodejs";

interface WithdrawalEligibilityBody {
  orderId?: unknown;
  publicToken?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function notEligible(): NextResponse {
  return NextResponse.json({ eligible: false }, { status: 200 });
}

export async function POST(request: NextRequest) {
  let body: WithdrawalEligibilityBody;
  try {
    body = (await request.json()) as WithdrawalEligibilityBody;
  } catch {
    return notEligible();
  }

  if (!isNonEmptyString(body.orderId) || !isNonEmptyString(body.publicToken)) {
    return notEligible();
  }

  try {
    const eligible = await orderHasWithdrawalEligibleLine({
      orderId: body.orderId,
      publicToken: body.publicToken,
    });
    return NextResponse.json({ eligible }, { status: 200 });
  } catch {
    return notEligible();
  }
}
