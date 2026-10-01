"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { PublicDeliveryFulfillmentRule } from "@/lib/sale-modes-types";
import type { DeliveryStatus } from "@/lib/delivery";
import { computeDeliveryFee } from "@/lib/delivery";
import { useI18n } from "@/lib/i18n-context";
import { tCustomerNoticeText } from "@/lib/menu-i18n";
import { formatPrice } from "@/lib/whatsapp";
import type { DeliveryDiscountPolicy } from "@/lib/delivery-discount";

function DeliveryDialog({ open, title, onDismiss, children, marker }: {
  open: boolean; title: string; onDismiss: () => void; children: ReactNode; marker: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { t } = useI18n();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      try { dialog.showModal(); } catch { dialog.setAttribute("open", ""); }
    } else if (!open && dialog.open) {
      try { dialog.close(); } catch { dialog.removeAttribute("open"); }
    }
  }, [open]);
  return <dialog ref={ref} aria-labelledby={titleId} data-delivery-dialog={marker}
    onClose={onDismiss} onCancel={onDismiss}
    onClick={(e) => { if (e.target === ref.current) onDismiss(); }}
    className="m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-espresso/10 bg-crema p-5 text-ink-on-bg shadow-xl backdrop:bg-espresso/40">
    <h2 id={titleId} className="text-xl font-bold">{title}</h2>
    <div className="mt-4 space-y-4">{children}</div>
    <button type="button" autoFocus onClick={onDismiss} className="mt-5 min-h-11 w-full rounded-xl bg-caramel px-4 py-2.5 font-bold text-caramel-ink">{t("close")}</button>
  </dialog>;
}

function DiscountCondition({ policy, currency, applied = false }: { policy: DeliveryDiscountPolicy; currency: string; applied?: boolean }) {
  const { t } = useI18n();
  if (!policy.discountEnabled || policy.discountThreshold == null || policy.discountPercentage == null) return null;
  return <p className="text-sm leading-relaxed">{t(applied ? "deliveryDiscountApplied" : "deliveryDiscountCondition", {
    percentage: policy.discountPercentage, threshold: formatPrice(policy.discountThreshold, currency),
  })}</p>;
}

/** Public facts only: never render provider, fulfillment_code, or raw config. */
export function DeliveryConditionsButton({ rules, currency }: { rules: PublicDeliveryFulfillmentRule[]; currency: string }) {
  const { t, lang, sourceLanguage } = useI18n();
  const [open, setOpen] = useState(false);
  if (!rules.length) return null;
  return <div className="mx-4 mt-4">
    <button type="button" onClick={() => setOpen(true)} className="min-h-11 w-full rounded-xl border border-espresso/15 bg-espresso/5 px-4 py-3 text-start text-sm font-semibold text-ink-on-bg">{t("deliveryConditionsTitle")}</button>
    <DeliveryDialog open={open} title={t("deliveryConditionsTitle")} marker="conditions" onDismiss={() => setOpen(false)}>
      {[...rules].sort((a, b) => a.displayOrder - b.displayOrder).map((rule, index) => {
        const base = computeDeliveryFee({ ...rule, discountEnabled: false }, 0);
        const notice = tCustomerNoticeText(rule, lang, sourceLanguage);
        return <section key={rule.displayOrder} className="space-y-2 rounded-xl border border-espresso/10 p-3">
          <h3 className="font-semibold">{t("deliveryRuleNumber", { number: index + 1 })}</h3>
          <p className="text-sm">{rule.isFallback ? t("deliveryFallbackArea") : t("deliveryPostcodeArea", { zones: rule.zonePrefixes.join(", ") })}</p>
          <p className="font-semibold">{base === undefined ? t("deliveryPriceUnavailable") : t("deliveryBaseFee", { fee: formatPrice(base, currency) })}</p>
          {rule.pricingMode === "free_above_threshold" && rule.freeThreshold != null && <p className="text-sm">{t("deliveryFreeThreshold", { threshold: formatPrice(rule.freeThreshold, currency) })}</p>}
          {rule.minItems != null && rule.minItems > 0 && <p className="text-sm">{t("deliveryMinimumItems", { count: rule.minItems })}</p>}
          <DiscountCondition policy={rule} currency={currency} />
          {notice && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{notice}</p>}
        </section>;
      })}
    </DeliveryDialog>
  </div>;
}

/** One popup per meaningful resolved result, not per React render or keystroke. */
export function DeliveryPostcodeResult({ active, contextKey, postcode, status, subtotal, currency }: {
  active: boolean; contextKey: string; postcode: string; status: DeliveryStatus; subtotal: number; currency: string;
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
  useEffect(() => {
    if (!key) { setOpen(false); return; }
    if (last.current === key) return;
    // Let a completed postal input settle; changing its result cancels this timer.
    setOpen(false);
    const timer = setTimeout(() => { last.current = key; setOpen(true); }, 350);
    return () => clearTimeout(timer);
  }, [key]);
  return <DeliveryDialog open={open && active} title={t("deliveryPostcodeResultTitle", { postcode: postcode.trim() })} marker="postcode" onDismiss={() => setOpen(false)}>
    <p className="font-semibold">{t(status.eligible ? "deliveryResultEligible" : "deliveryResultUnavailable")}</p>
    {status.eligible && <p className="text-lg font-bold">{status.pricingUnavailable
      ? t("deliveryPriceUnavailable") : t("deliveryEffectiveFee", { fee: formatPrice(status.deliveryFee ?? 0, currency) })}</p>}
    {status.block === "below-min" && <p>{t("deliveryMissingItems", { count: status.missing ?? 0 })}</p>}
    {policy && <DiscountCondition policy={policy} currency={currency} applied={status.eligible && applied} />}
    {notice && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{notice}</p>}
  </DeliveryDialog>;
}
