import { NextRequest, NextResponse } from "next/server";
import { asUserSupabaseClientFactory } from "@/lib/server/supabase-as-user";
import {
  findInvoice,
  invoiceBytes,
  invoicePdfEnabled,
  prepareInvoice,
  sendInvoice,
} from "@/lib/server/invoices/service";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";
import { validateInvoiceSource } from "@/lib/server/invoices/model";
import { isPlausibleUuid } from "@/lib/tracking/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
function error(status: number, code: string) {
  return NextResponse.json({ code }, { status, headers });
}

/** A caller-supplied restaurant id never authorizes access. Auth + membership
 * of the stored order are verified before the privileged archive is touched. */
async function authorize(
  request: NextRequest,
  orderId: string,
  sending = false,
) {
  const h = request.headers.get("authorization") ?? "";
  if (!h.startsWith("Bearer ") || !isPlausibleUuid(orderId)) return null;
  const token = h.slice(7);
  const userClient = asUserSupabaseClientFactory.create(token);
  const { data: auth, error: authError } = await userClient.auth.getUser(token);
  if (authError || !auth.user) return null;
  const { data: order, error: orderError } = await userClient
    .from("orders")
    .select("id,restaurant_id")
    .eq("id", orderId)
    .maybeSingle();
  if (orderError || !order) return null;
  const { data: allowed, error: roleError } = await userClient.rpc(
    "has_role_in",
    {
      p_restaurant_id: order.restaurant_id,
      p_roles: sending ? ["owner", "manager"] : ["owner", "manager", "staff"],
    },
  );
  return !roleError && allowed === true ? order : null;
}
function pdfResponse(d: NonNullable<Awaited<ReturnType<typeof findInvoice>>>) {
  const bytes = invoiceBytes(d);
  return new Response(new Uint8Array(bytes), {
    headers: {
      ...headers,
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${d.invoice_number}.pdf"`,
    },
  });
}
export async function GET(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get("orderId") ?? "";
    const order = await authorize(request, id);
    if (!order) return error(403, "INVOICE_FORBIDDEN");
    const d = await findInvoice(id);
    if (d && d.restaurant_id !== order.restaurant_id)
      return error(403, "INVOICE_FORBIDDEN");
    if (request.nextUrl.searchParams.get("view") === "status") {
      if (!d || !d.pdf_base64)
        return NextResponse.json({ generated: false }, { headers });
      invoiceBytes(d);
      const { source } = validateInvoiceSource(d.source);
      const last = await getServiceRoleSupabaseClient()
        .from("invoice_pdf_deliveries")
        .select("state,created_at,completed_at")
        .eq("invoice_id", d.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (last.error) return error(503, "INVOICE_UNAVAILABLE");
      return NextResponse.json(
        {
          generated: true,
          invoiceNumber: d.invoice_number,
          issuedAt: d.issued_at,
          recipient: source.buyer.email,
          lastDelivery: last.data,
        },
        { headers },
      );
    }
    if (!d || !d.pdf_base64) return error(404, "INVOICE_NOT_READY");
    if (d.restaurant_id !== order.restaurant_id)
      return error(403, "INVOICE_FORBIDDEN");
    return pdfResponse(d);
  } catch {
    return error(503, "INVOICE_UNAVAILABLE");
  }
}
export async function POST(request: NextRequest) {
  try {
    if (!invoicePdfEnabled()) return error(503, "INVOICE_DISABLED");
    // Small JSON only: no caller-provided PDF, recipient, seller, price or number.
    const raw = await request.text();
    if (raw.length > 1024) return error(400, "INVOICE_INVALID_REQUEST");
    const body = JSON.parse(raw);
    if (
      !body ||
      !isPlausibleUuid(body.orderId) ||
      !["prepare", "send", "resend"].includes(body.action) ||
      (body.action !== "prepare" && !isPlausibleUuid(body.requestId))
    )
      return error(400, "INVOICE_INVALID_REQUEST");
    const order = await authorize(
      request,
      body.orderId,
      body.action !== "prepare",
    );
    if (!order) return error(403, "INVOICE_FORBIDDEN");
    // Sending never creates a numbered document: the merchant must generate/review first.
    const d =
      body.action === "prepare"
        ? await prepareInvoice(order.id)
        : await findInvoice(order.id);
    if (!d || !d.pdf_base64) return error(409, "INVOICE_NOT_READY");
    if (d.restaurant_id !== order.restaurant_id)
      return error(403, "INVOICE_FORBIDDEN");
    if (body.action === "prepare") return pdfResponse(d);
    const outcome = await sendInvoice(d, body.requestId);
    return NextResponse.json(
      { outcome },
      {
        status: ["accepted", "already_claimed"].includes(outcome) ? 200 : 409,
        headers,
      },
    );
  } catch {
    return error(409, "INVOICE_NOT_READY");
  }
}
