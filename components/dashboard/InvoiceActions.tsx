"use client";
import { useEffect, useRef, useState } from "react";
import { translate, type Lang } from "@/lib/i18n";

type Status = {
  generated: boolean;
  invoiceNumber?: string;
  recipient?: string;
  issuedAt?: string;
  lastDelivery?: {
    state: string;
    created_at: string;
    completed_at: string | null;
  } | null;
};

/** Parent keys by restaurant + order; reset/abort here too for standalone consumers. */
function InvoiceControls({ orderId, lang }: { orderId: string; lang: Lang }) {
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState<Status | null>(null),
    [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null),
    requestId = useRef<string | null>(null),
    running = useRef(false),
    generation = useRef(0);
  const t = (key: string) => translate(lang, key);
  const base = `/api/dashboard/invoices?orderId=${encodeURIComponent(orderId)}`;
  async function auth() {
    const { getSession } = await import("@/lib/services/auth");
    const session = await getSession();
    if (!session) throw Error();
    return { Authorization: `Bearer ${session.access_token}` };
  }
  async function readStatus(
    headers: { Authorization: string },
    signal: AbortSignal,
  ): Promise<Status> {
    const r = await fetch(base + "&view=status", {
      headers,
      signal,
      cache: "no-store",
    });
    if (!r.ok) throw Error();
    return r.json();
  }
  useEffect(() => {
    const epoch = ++generation.current,
      abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    running.current = false;
    requestId.current = null;
    setBusy(false);
    setStatus(null);
    setMessage("");
    void (async () => {
      try {
        const h = await auth(),
          s = await readStatus(h, abort.signal);
        if (!abort.signal.aborted && generation.current === epoch) setStatus(s);
      } catch {
        if (!abort.signal.aborted && generation.current === epoch)
          setMessage(t("invPdfUnavailable"));
      }
    })();
    return () => {
      abort.abort();
      controller.current?.abort();
    };
    // Read-only status is tied to order identity; language changes do not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);
  async function act(action: "generate" | "print" | "send") {
    if (running.current || !status) return;
    if (
      action === "send" &&
      (!status.generated ||
        !status.recipient ||
        !window.confirm(
          t("invPdfSendConfirm").replace("{email}", status.recipient),
        ))
    )
      return;
    running.current = true;
    const epoch = generation.current;
    const popup =
      action === "print" ? window.open("about:blank", "_blank") : null;
    if (popup) popup.opener = null;
    const abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    setBusy(true);
    setMessage("");
    try {
      const h = await auth();
      if (abort.signal.aborted) return;
      if (action === "send") {
        requestId.current ??= crypto.randomUUID();
        const r = await fetch("/api/dashboard/invoices", {
          method: "POST",
          headers: { ...h, "Content-Type": "application/json" },
          body: JSON.stringify({
            orderId,
            action: "send",
            requestId: requestId.current,
          }),
          signal: abort.signal,
        });
        const result = await r.json();
        if (abort.signal.aborted || generation.current !== epoch) return;
        const key =
          result.outcome === "accepted"
            ? "invPdfAccepted"
            : result.outcome === "failed"
              ? "invPdfFailed"
              : "invPdfUnconfirmed";
        setMessage(t(key));
        // Preserve the key after ambiguous results, including already_claimed.
        if (result.outcome === "accepted" || result.outcome === "failed")
          requestId.current = null;
        const s = await readStatus(h, abort.signal);
        if (!abort.signal.aborted && generation.current === epoch) setStatus(s);
        return;
      }
      const response =
        action === "generate" && !status.generated
          ? await fetch("/api/dashboard/invoices", {
              method: "POST",
              headers: { ...h, "Content-Type": "application/json" },
              body: JSON.stringify({ orderId, action: "prepare" }),
              signal: abort.signal,
            })
          : await fetch(base, {
              headers: h,
              cache: "no-store",
              signal: abort.signal,
            });
      if (
        !response.ok ||
        !response.headers.get("content-type")?.startsWith("application/pdf")
      )
        throw Error();
      const blob = await response.blob();
      if (abort.signal.aborted || generation.current !== epoch) return;
      const url = URL.createObjectURL(blob);
      if (popup) popup.location.replace(url);
      else {
        const a = document.createElement("a");
        a.href = url;
        a.download =
          response.headers
            .get("content-disposition")
            ?.match(/filename="(FAC-[A-Z0-9-]+\.pdf)"/)?.[1] ?? "facture.pdf";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
      const s = await readStatus(h, abort.signal);
      if (!abort.signal.aborted && generation.current === epoch) {
        setStatus(s);
        setMessage(t("invPdfGenerated"));
      }
    } catch {
      popup?.close();
      if (!abort.signal.aborted && generation.current === epoch)
        setMessage(t("invPdfUnavailable"));
    } finally {
      if (generation.current === epoch) {
        running.current = false;
        if (!abort.signal.aborted) setBusy(false);
      }
    }
  }
  const last = status?.lastDelivery;
  return (
    <div className="mt-3 border-t border-stone-200 pt-3">
      <p className="mb-2 text-sm font-semibold">{t("invPdfTitle")}</p>
      {status?.generated && (
        <p className="mb-2 text-sm">
          {t("invPdfGenerated")} · {status.invoiceNumber}
        </p>
      )}
      {status?.recipient && (
        <p className="mb-2 break-all text-sm">
          {t("invPdfRecipient")} : {status.recipient}
        </p>
      )}
      {last && (
        <p className="mb-2 text-sm">
          {t(
            last.state === "accepted"
              ? "invPdfAccepted"
              : last.state === "failed"
                ? "invPdfFailed"
                : "invPdfUnconfirmed",
          )}{" "}
          ·{" "}
          {new Intl.DateTimeFormat(
            lang === "ar"
              ? "ar"
              : lang === "nl"
                ? "nl-NL"
                : lang === "en"
                  ? "en-GB"
                  : "fr-FR",
            { dateStyle: "short", timeStyle: "short" },
          ).format(new Date(last.completed_at ?? last.created_at))}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {(["generate", "send", "print"] as const).map((a) => (
          <button
            key={a}
            type="button"
            disabled={
              busy || !status || (a !== "generate" && !status.generated)
            }
            onClick={() => void act(a)}
            className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 disabled:opacity-50"
          >
            {t(
              a === "generate"
                ? status?.generated
                  ? "invPdfDownload"
                  : "invPdfGenerate"
                : a === "send"
                  ? "invPdfSend"
                  : "invPdfPrint",
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

export default function InvoiceActions(props: { orderId: string; lang: Lang }) {
  return <InvoiceControls key={props.orderId} {...props} />;
}
