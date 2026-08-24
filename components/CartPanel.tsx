"use client";

import type { RestaurantFull } from "@/lib/types";
import { formatPrice, type CartLine } from "@/lib/whatsapp";
import type { RestaurantSettings } from "@/lib/restaurants-config";
import type { DeliveryStatus } from "@/lib/delivery";
import type { CustomerInfo } from "@/lib/customer";
import type { FieldRequirementDisplayItem } from "@/lib/sale-modes-public";
import QuantityControl from "@/components/QuantityControl";
import TableSelector from "@/components/TableSelector";
import { useI18n } from "@/lib/i18n-context";
import Ltr from "@/components/Bidi";
import { tName } from "@/lib/menu-i18n";
import FulfillmentSelector from "@/components/FulfillmentSelector";
import type { ServiceMode } from "@/lib/restaurants-config";
import { normalizeOrderNote, ORDER_NOTE_MAX_LENGTH } from "@/lib/order-note";

interface CartEntry extends CartLine {
  key: string;
}

export default function CartPanel({
  restaurant,
  settings,
  lines,
  totalCount,
  totalPrice,
  tableNumber,
  serviceMode,
  deliveryStatus,
  displayItems,
  fieldRequirementsReady,
  customer,
  customerErrors,
  showErrors,
  note,
  canSubmit,
  isSubmitting,
  submitError,
  onChangeQuantity,
  onSelectTable,
  onSelectFulfillment,
  onChangeCustomer,
  onChangeNote,
  onSendOrder,
  onClose,
}: {
  restaurant: RestaurantFull;
  settings: RestaurantSettings;
  lines: CartEntry[];
  totalCount: number;
  totalPrice: number;
  tableNumber: number | null;
  serviceMode: ServiceMode | null;
  deliveryStatus: DeliveryStatus;
  /** LOT 2B.4a.2 : exigences génériques dynamiques (plus un
   *  (keyof CustomerInfo)[] figé lu depuis settings.requiredCustomerFields). */
  displayItems: FieldRequirementDisplayItem[];
  /** Fail-closed (section 11) : false tant que les exigences ne sont
   *  pas réellement résolues (loading/error) -- transmis tel quel à
   *  FulfillmentSelector, jamais réinterprété ici. */
  fieldRequirementsReady: boolean;
  customer: CustomerInfo;
  customerErrors: Partial<Record<keyof CustomerInfo, string>>;
  showErrors: boolean;
  /** Note générale de commande (V65), unique, facultative — pas de note par ligne. */
  note: string;
  canSubmit: boolean;
  isSubmitting: boolean;
  submitError: string | null;
  onChangeQuantity: (key: string, delta: number) => void;
  onSelectTable: (table: number) => void;
  onSelectFulfillment: (t: ServiceMode) => void;
  onChangeCustomer: (patch: Partial<CustomerInfo>) => void;
  onChangeNote: (value: string) => void;
  onSendOrder: () => void;
  onClose: () => void;
}) {
  const { t, lang, sourceLanguage } = useI18n();
  const { currency, max_tables } = restaurant.config;

  // Compteur et validation alignés sur le comptage serveur (voir
  // lib/order-note.ts) : ni note.length ni maxLength natif seuls, pour
  // rester cohérent avec des emojis / caractères arabes.
  const noteState = normalizeOrderNote(note);

  const missing = !serviceMode
    ? t("missingFulfillment")
    : serviceMode === "table"
      ? t("missingTable")
      : t("missingCustomer");

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-x-hidden bg-espresso/50">
      <div className="flex h-[100dvh] w-full min-w-0 max-w-full flex-col overflow-x-hidden bg-crema sm:h-auto sm:max-h-[90dvh] sm:max-w-lg sm:rounded-t-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-espresso/10 px-4 py-3">
          <h2 className="text-lg font-bold">{t("cartTitle")}</h2>
          <button
            onClick={onClose}
            aria-label={t("ariaCloseCart")}
            className="rounded-full px-3 py-1 text-sm font-medium text-ink-on-bg-muted"
          >
            {t("close")} ✕
          </button>
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-3 pb-6">
          {lines.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-on-bg-muted">
              {t("cartEmpty")}
            </p>
          ) : (
            <ul className="space-y-3">
              {lines.map(({ key, item, quantity, option, optionKind }) => (
                <li
                  key={key}
                  // Corrige UIFIX-V2-01 (contre-audit Work, 3e tour) :
                  // ce conteneur englobe des DESCENDANTS dont le texte
                  // (text-ink-on-bg-muted, text-accent-dark-on-bg) est
                  // calculé contre --sc-bg, alors que le conteneur
                  // lui-même restait sur un fond littéral figé --
                  // exactement le même défaut structurel que
                  // UIFIX-01, mais en relation parent/descendant
                  // plutôt que sur un seul élément. bg-crema
                  // (= var(--sc-bg)) réaligne le fond réellement
                  // affiché sur la même source que ces textes.
                  className="flex min-w-0 items-center justify-between gap-2 overflow-hidden rounded-xl bg-crema p-3"
                >
                  <div className="min-w-0">
                    <p className="font-semibold leading-snug">
                      {tName(item, lang, sourceLanguage)}
                    </p>
                    {option && (
                      <p className="text-xs text-ink-on-bg-muted">
                        {t(optionKind === "flavor" ? "optFlavor" : "optPastry")} :{" "}
                        {tName(option, lang, sourceLanguage)}
                      </p>
                    )}
                    <p className="mt-0.5 text-sm text-accent-dark-on-bg">
                      <Ltr>{formatPrice(item.price * quantity, currency)}</Ltr>
                    </p>
                  </div>
                  <div className="shrink-0">
                    <QuantityControl
                      quantity={quantity}
                      onChange={(delta) => onChangeQuantity(key, delta)}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {lines.length > 0 && (
            <>
              {serviceMode === "table" && (
                <TableSelector
                  maxTables={max_tables}
                  selected={tableNumber}
                  onSelect={onSelectTable}
                />
              )}

              {(serviceMode === "pickup" || serviceMode === "delivery") && (
                <FulfillmentSelector
                  settings={settings}
                  status={deliveryStatus}
                  type={serviceMode}
                  customer={customer}
                  errors={customerErrors}
                  showErrors={showErrors}
                  displayItems={displayItems}
                  fieldRequirementsReady={fieldRequirementsReady}
                  onChangeCustomer={onChangeCustomer}
                  onSelectFulfillment={onSelectFulfillment}
                />
              )}

              <div className="mt-4">
                <label
                  htmlFor="order-note"
                  className="text-xs font-semibold uppercase tracking-wide text-ink-on-bg-muted"
                >
                  {t("noteLabel")}
                </label>
                <textarea
                  id="order-note"
                  rows={2}
                  value={note}
                  onChange={(e) => onChangeNote(e.target.value)}
                  placeholder={t("notePlaceholder")}
                  aria-invalid={!noteState.isValid || undefined}
                  className={
                    "mt-1.5 w-full resize-none rounded-xl border bg-white p-3 text-sm text-stone-900 placeholder:text-stone-500 " +
                    (noteState.isValid
                      ? "border-espresso/10"
                      : "border-amber-500 bg-amber-50")
                  }
                />
                <p
                  className={
                    "mt-1 text-right text-xs " +
                    (noteState.isValid ? "text-ink-on-bg-muted" : "font-semibold text-amber-700")
                  }
                >
                  {t("noteCounter", {
                    count: noteState.length,
                    max: ORDER_NOTE_MAX_LENGTH,
                  })}
                </p>
              </div>
            </>
          )}
        </div>

        {lines.length > 0 && (
          <div className="min-w-0 max-w-full shrink-0 overflow-x-hidden border-t border-espresso/10 bg-crema px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgba(0,0,0,0.06)]">
            {settings.allowedServiceModes.length > 1 && (
              <div className="mb-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-on-bg-muted">
                  {t("howToReceive")}
                </p>
                <div className="mt-2 flex gap-2">
                  {settings.allowedServiceModes.map((mode) => {
                    const selected = serviceMode === mode;
                    const deliveryIncomplete =
                      mode === "delivery" && selected && !deliveryStatus.eligible;
                    const hint =
                      deliveryStatus.block === "out-of-zone"
                        ? t("deliveryOutOfZoneShort")
                        : deliveryStatus.block === "below-min"
                          ? t("deliveryMinimumShort")
                          : t("deliveryCompleteAddressShort");

                    return (
                      <button
                        key={mode}
                        onClick={() => onSelectFulfillment(mode)}
                        aria-pressed={selected}
                        aria-invalid={deliveryIncomplete || undefined}
                        className={
                          "min-w-0 flex-1 rounded-xl border px-2 py-2.5 text-sm font-semibold " +
                          (deliveryIncomplete
                            ? "border-amber-500 bg-amber-50 text-amber-900"
                            : selected
                              ? "border-caramel bg-caramel text-caramel-ink"
                              // Corrige UIFIX-01 : même défaut que
                              // CategoryNav -- bg-crema (= var(--sc-bg))
                              // réaligne fond et texte sur la même
                              // source de contraste.
                              : "border-transparent bg-crema text-ink-on-bg shadow-sm")
                        }
                      >
                        <span className="block">
                          {t(mode === "table" ? "modeTable" : mode)}
                        </span>
                        {deliveryIncomplete && (
                          <span className="mt-0.5 block truncate text-[0.65rem] font-medium">
                            {hint}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="mb-3 flex items-center justify-between font-bold">
              <span>{t("total")}</span>
              <span>
                <Ltr>{formatPrice(totalPrice, currency)}</Ltr>
              </span>
            </div>
            {submitError && (
              <p className="mb-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
                {submitError}
              </p>
            )}

            {canSubmit && noteState.isValid ? (
              <>
                <p className="mb-2 text-center text-sm text-ink-on-bg-muted">
                  {t("whatsappNotice")}
                </p>
                <button
                  onClick={onSendOrder}
                  disabled={isSubmitting}
                  aria-busy={isSubmitting}
                  className={
                    "block w-full rounded-xl py-3.5 text-center font-bold text-white " +
                    (isSubmitting
                      ? "cursor-wait bg-[#25D366]/60"
                      : "bg-[#25D366]")
                  }
                >
                  {isSubmitting ? t("sending") : t("sendOrder")}
                </button>
              </>
            ) : (
              <p className="break-words rounded-xl bg-espresso/5 px-3 py-3.5 text-center text-sm font-medium text-ink-on-bg-muted">
                {!noteState.isValid ? t("noteTooLong") : missing}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
