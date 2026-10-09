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
    <div className="mt-3 space-y-3">{children}</div>
    <button type="button" autoFocus onClick={onDismiss} className="mt-5 min-h-11 w-full rounded-xl bg-caramel px-4 py-2.5 font-bold text-caramel-ink">{t("close")}</button>
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

/** Public facts only: never render provider, fulfillment_code, or raw config. */
export function DeliveryConditionsButton({ rules, currency }: { rules: PublicDeliveryFulfillmentRule[]; currency: string }) {
  const { t, lang, sourceLanguage } = useI18n();
  const [open, setOpen] = useState(false);
  if (!rules.length) return null;
  return <div className="mx-4 mt-3">
    <button type="button" onClick={() => setOpen(true)} className="min-h-11 w-full rounded-xl border border-espresso/15 bg-espresso/5 px-4 py-2.5 text-start text-sm font-semibold text-ink-on-bg">{t("deliveryConditionsTitle")}</button>
    <DeliveryDialog open={open} title={t("deliveryConditionsTitle")} marker="conditions" onDismiss={() => setOpen(false)}>
      {[...rules].sort((a, b) => a.displayOrder - b.displayOrder).map((rule) => {
        const base = computeDeliveryFee({ ...rule, discountEnabled: false }, 0);
        const notice = tCustomerNoticeText(rule, lang, sourceLanguage);
        // STOREFRONT UX POLISH v1 -- une ligne principale « zone — tarif »
        // puis UNE ligne courte de conditions ; mêmes faits publics,
        // même calcul (computeDeliveryFee), jamais provider/fulfillment_code.
        const area = rule.isFallback ? t("deliveryAreaOther") : t("deliveryAreaZones", { zones: rule.zonePrefixes.join(", ") });
        const conditions = [
          rule.pricingMode === "free_above_threshold" && rule.freeThreshold != null
            ? t("deliveryRuleFreeFrom", { threshold: formatPrice(rule.freeThreshold, currency) }) : null,
          rule.minItems != null && rule.minItems > 0 ? t("deliveryRuleMinItems", { count: rule.minItems }) : null,
          discountText(t, rule, currency),
        ].filter((x): x is string => !!x);
        return <section key={rule.displayOrder} data-delivery-rule-card data-sc-surface="delivery-card" className="space-y-1 rounded-xl border border-espresso/10 px-3 py-2.5">
          <h3 className="font-semibold">{base === undefined ? area : `${area} — ${formatPrice(base, currency)}`}</h3>
          {base === undefined && <p className="text-sm">{t("deliveryPriceUnavailable")}</p>}
          {conditions.length > 0 && <p data-delivery-rule-conditions className="text-sm">{conditions.join(" · ")}</p>}
          {notice && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-on-bg-muted">{notice}</p>}
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
  const discount = discountText(t, policy, currency, status.eligible && applied);
  useEffect(() => {
    if (!key) { setOpen(false); return; }
    if (last.current === key) return;
    // Let a completed postal input settle; changing its result cancels this timer.
    setOpen(false);
    const timer = setTimeout(() => { last.current = key; setOpen(true); }, 350);
    return () => clearTimeout(timer);
  }, [key]);
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
