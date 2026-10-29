"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { PublicDeliveryFulfillmentRule } from "@/lib/sale-modes-types";
import type { DeliveryStatus } from "@/lib/delivery";
import { useI18n } from "@/lib/i18n-context";
import { tCustomerNoticeText } from "@/lib/menu-i18n";
import { formatPrice } from "@/lib/whatsapp";
import type { DeliveryDiscountPolicy } from "@/lib/delivery-discount";

function DeliveryDialog({ open, title, onDismiss, children, marker }: {
  open: boolean; title: string; onDismiss: () => void; children: ReactNode; marker: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const { t } = useI18n();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      try { dialog.showModal(); } catch { dialog.setAttribute("open", ""); }
      // UX LOT 2026-10 (PR #166, retour de vérification en production) :
      // ce dialogue est le VRAI « Comment passer commande ? » de la
      // vitrine (deliveryConditionsTitle). Le bouton « Fermer », en bas,
      // portait `autoFocus` : showModal() lui donnait le focus et le
      // faisait défiler dans la vue -- avec plusieurs règles de livraison
      // (contenu > 85dvh) la fenêtre s'ouvrait EN BAS, titre et début du
      // texte hors écran. Désormais : défilement remis au début, focus
      // sur le TITRE (focusable par programme seulement) sans défilement.
      // Mesuré en Chromium réel (scripts/ux-real-browser-check.mjs).
      dialog.scrollTop = 0;
      titleRef.current?.focus({ preventScroll: true });
    } else if (!open && dialog.open) {
      try { dialog.close(); } catch { dialog.removeAttribute("open"); }
    }
  }, [open]);
  return <dialog ref={ref} aria-labelledby={titleId} data-delivery-dialog={marker}
    onClose={onDismiss} onCancel={onDismiss}
    onClick={(e) => { if (e.target === ref.current) onDismiss(); }}
    className="m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-espresso/10 bg-crema p-5 text-ink-on-bg shadow-xl backdrop:bg-espresso/40">
    <h2 id={titleId} ref={titleRef} tabIndex={-1} data-delivery-dialog-title className="text-xl font-bold outline-none">{title}</h2>
    <div className="mt-3 space-y-3">{children}</div>
    <button type="button" data-delivery-dialog-close onClick={onDismiss} className="mt-5 min-h-11 w-full rounded-xl bg-caramel px-4 py-2.5 font-bold text-caramel-ink">{t("close")}</button>
  </dialog>;
}

/** STOREFRONT UX POLISH v1 -- courte mention de remise, uniquement
 *  lorsque la politique publique est réellement activée (mêmes faits B5,
 *  aucun recalcul). */
function discountText(t: (key: string, vars?: Record<string, string | number>) => string,
  policy: DeliveryDiscountPolicy | null | undefined, currency: string, applied = false): string | null {
  if (!policy?.discountEnabled || policy.discountThreshold == null || policy.discountPercentage == null) return null;
  return t(applied ? "deliveryDiscountAppliedShort" : "deliveryDiscountShort", {
    percentage: policy.discountPercentage, threshold: formatPrice(policy.discountThreshold, currency),
  });
}

/**
 * DELIVERY PUBLIC TEXT v1 -- the "Comment passer commande" popup (relabelled by
 * STOREFRONT ORDER HELP WORDING v1; same button, same dialog, same i18n key
 * `deliveryConditionsTitle`) shows ONLY the
 * merchant-configured customer text of each rule (resolved with the existing translation
 * contract). It never renders zone prefixes, postcodes, base fee, pricing mode, thresholds,
 * minimum items, discount parameters, provider, fulfillment_code, order or any other metadata:
 * those facts stay in the data (the engine and the postcode result use them) but are not
 * presented here. A rule with a blank text stays active and usable by the engine; it simply
 * contributes nothing to this popup. When no rule has a text, the button itself is hidden so
 * the customer never opens an empty popup.
 */
export function DeliveryConditionsButton({ rules }: { rules: PublicDeliveryFulfillmentRule[]; currency?: string }) {
  const { t, lang, sourceLanguage } = useI18n();
  const [open, setOpen] = useState(false);
  const texts = [...rules].sort((a, b) => a.displayOrder - b.displayOrder)
    .map((rule) => ({ key: rule.displayOrder, text: (tCustomerNoticeText(rule, lang, sourceLanguage) ?? "").trim() }))
    .filter((entry) => entry.text !== "");
  if (!texts.length) return null;
  return <div className="mx-4 mt-3">
    <button type="button" onClick={() => setOpen(true)} className="min-h-11 w-full rounded-xl border border-espresso/15 bg-espresso/5 px-4 py-2.5 text-center text-sm font-semibold text-ink-on-bg">{t("deliveryConditionsTitle")}</button>
    <DeliveryDialog open={open} title={t("deliveryConditionsTitle")} marker="conditions" onDismiss={() => setOpen(false)}>
      {texts.map((entry) => <section key={entry.key} data-delivery-rule-card data-sc-surface="delivery-card" className="rounded-xl border border-espresso/10 px-3 py-2.5">
        <p data-delivery-rule-text className="whitespace-pre-wrap break-words text-sm leading-relaxed">{entry.text}</p>
      </section>)}
    </DeliveryDialog>
  </div>;
}

/** One popup per meaningful resolved result, not per React render or keystroke. */
export function DeliveryPostcodeResult({ active, contextKey, postcode, status, subtotal, currency, onOpenChange }: {
  active: boolean; contextKey: string; postcode: string; status: DeliveryStatus; subtotal: number; currency: string;
  /** ISSUE #183 -- état d'ouverture EFFECTIF de la fenêtre (ouverte ET active). */
  onOpenChange?: (open: boolean) => void;
}) {
  const { t, lang, sourceLanguage } = useI18n();
  const [open, setOpen] = useState(false);
  const last = useRef("");
  const notice = tCustomerNoticeText({ customerText: status.customerNotice ?? null,
    customerTextHash: status.customerNoticeHash, translations: status.customerNoticeTranslations }, lang, sourceLanguage);
  const policy = status.discountPolicy;
  const applied = !!policy?.discountEnabled && Math.round(subtotal * 100) / 100 >= (policy.discountThreshold ?? Infinity) && (policy.discountPercentage ?? 0) > 0;
  const key = active ? JSON.stringify([contextKey, postcode.trim(), status.eligible, status.block,
    status.missing, status.deliveryFee, status.pricingUnavailable, notice, policy, applied]) : "";
  const discount = discountText(t, policy, currency, status.eligible && applied);
  useEffect(() => {
    if (!key) { setOpen(false); return; }
    if (last.current === key) return;
    // Let a completed postal input settle; changing its result cancels this timer.
    setOpen(false);
    const timer = setTimeout(() => { last.current = key; setOpen(true); }, 350);
    return () => clearTimeout(timer);
  }, [key]);
  const effectiveOpen = open && active;
  // Layout effect : le parent masque le doublon inline AVANT l'affichage de la fenêtre
  // (showModal est appelé dans un effet passif, après) -- pas d'image où les deux coexistent.
  useLayoutEffect(() => { onOpenChange?.(effectiveOpen); }, [effectiveOpen, onOpenChange]);
  return <DeliveryDialog open={open && active} title={t("deliveryPostcodeResultTitle", { postcode: postcode.trim() })} marker="postcode" onDismiss={() => setOpen(false)}>
    {/* STOREFRONT UX POLISH v1 -- une seule ligne « Disponible — frais »
        (plus de « Livraison disponible » + « Frais de livraison : »). Un
        frais absent n'est JAMAIS affiché comme 0 € : texte d'indisponibilité. */}
    {!status.eligible
      ? <p className="font-semibold">{t("deliveryResultUnavailable")}</p>
      : status.pricingUnavailable
        ? <p className="font-semibold">{t("deliveryResultEligible")}<br />{t("deliveryPriceUnavailable")}</p>
        : status.deliveryFee == null
          // Parcours historique (aucune règle active) : aucun frais public
          // n'est connu ici -- disponibilité seule, aucun montant inventé.
          ? <p className="font-semibold">{t("deliveryResultEligible")}</p>
          : <p className="text-lg font-bold">{t("deliveryAvailableFee", { fee: formatPrice(status.deliveryFee, currency) })}</p>}
    {status.block === "below-min" && <p>{t("deliveryMissingItems", { count: status.missing ?? 0 })}</p>}
    {discount && <p className="text-sm leading-relaxed">{discount}</p>}
    {notice && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{notice}</p>}
  </DeliveryDialog>;
}
