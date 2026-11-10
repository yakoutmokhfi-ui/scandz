"use client";
import { useEffect, useRef, useState } from "react";
import { translate, type Lang } from "@/lib/i18n";

export default function InvoiceActions({
  orderId,
  lang,
}: {
  orderId: string;
  lang: Lang;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null);
  const resendId = useRef<string | null>(null);
  const running = useRef(false);
  const t = (key: string) => translate(lang, key);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  async function act(action: "download" | "print" | "resend") {
    if (running.current) return;
    if (action === "resend" && !window.confirm(t("invPdfResendConfirm")))
      return;
    running.current = true;
    // Open synchronously on the click, before the async request (popup blockers).
    const popup =
      action === "print" ? window.open("about:blank", "_blank") : null;
    if (popup) popup.opener = null;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setMessage("");
    try {
      const { supabase } = await import("@/lib/supabase");
      const { data } = await supabase.auth.getSession();
      if (!data.session) throw new Error();
      const auth = { Authorization: `Bearer ${data.session.access_token}` };
      let response: Response;
      if (action === "resend") {
        // Preserve this key after an uncertain HTTP result, so retry cannot submit twice.
        resendId.current ??= crypto.randomUUID();
        response = await fetch("/api/dashboard/invoices", {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({
            orderId,
            action: "resend",
            requestId: resendId.current,
          }),
          signal: abort.signal,
        });
        const result = await response.json();
        if (abort.signal.aborted) return;
        if (!result.outcome) throw new Error();
        setMessage(
          t(
            result.outcome === "accepted"
              ? "invPdfAccepted"
              : "invPdfUnconfirmed",
          ),
        );
        if (result.outcome) resendId.current = null; // another confirmed click is a new manual request
        return;
      }
      response = await fetch(
        `/api/dashboard/invoices?orderId=${encodeURIComponent(orderId)}`,
        { headers: auth, cache: "no-store", signal: abort.signal },
      );
      if (response.status === 404)
        response = await fetch("/api/dashboard/invoices", {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({ orderId, action: "prepare" }),
          signal: abort.signal,
        });
      if (
        !response.ok ||
        !response.headers.get("content-type")?.startsWith("application/pdf")
      )
        throw new Error();
      const filename =
        response.headers
          .get("content-disposition")
          ?.match(/filename="(FAC-[A-Z0-9-]+\.pdf)"/)?.[1] ??
        `facture-${orderId}.pdf`;
      const blob = await response.blob();
      if (abort.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      if (action === "print" && popup) {
        popup.location.replace(url);
      } else {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      // The browser's PDF viewer provides the print dialog; never silent printing.
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    } catch {
      popup?.close();
      if (!abort.signal.aborted) setMessage(t("invPdfUnavailable"));
    } finally {
      running.current = false;
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  return (
    <div className="mt-3 border-t border-stone-200 pt-3">
      <p className="mb-2 text-sm font-semibold">{t("invPdfTitle")}</p>
      <div className="flex flex-wrap gap-2">
        {(["download", "print", "resend"] as const).map((a) => (
          <button
            key={a}
            type="button"
            disabled={busy}
            onClick={() => void act(a)}
            className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 disabled:opacity-50"
          >
            {t(
              a === "download"
                ? "invPdfDownload"
                : a === "print"
                  ? "invPdfPrint"
                  : "invPdfResend",
            )}
          </button>
        ))}
      </div>
      {message && (
        <p role="status" className="mt-2 text-sm">
          {message}
        </p>
      )}
    </div>
  );
}
