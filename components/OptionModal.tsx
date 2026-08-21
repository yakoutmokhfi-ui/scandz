"use client";

import { useMemo, useState } from "react";
import type { MenuItem } from "@/lib/types";
import { formatPrice } from "@/lib/whatsapp";
import { useI18n } from "@/lib/i18n-context";
import { tName } from "@/lib/menu-i18n";
import Ltr from "@/components/Bidi";

/**
 * Fenêtre de choix en deux temps :
 *   1. le client fixe la quantité totale ;
 *   2. il la répartit entre les goûts proposés.
 * La confirmation n'est possible que lorsque la répartition est
 * complète, ce qui évite toute commande ambiguë pour le commerçant.
 */
export default function OptionModal({
  title,
  choices,
  item,
  currency,
  presets,
  initialQuantity = 1,
  onConfirm,
  onClose,
}: {
  title: string;
  choices: MenuItem[];
  item: MenuItem;
  currency: string;
  presets?: number[];
  initialQuantity?: number;
  onConfirm: (distribution: { choice: MenuItem; quantity: number }[]) => void;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const [total, setTotal] = useState(Math.max(1, initialQuantity));
  const [counts, setCounts] = useState<Record<string, number>>({});

  const assigned = useMemo(
    () => Object.values(counts).reduce((s, n) => s + n, 0),
    [counts]
  );
  const remaining = total - assigned;
  const complete = remaining === 0 && assigned > 0;

  /** Réduit la répartition si le client baisse le total. */
  function setTotalSafe(next: number) {
    const value = Math.min(99, Math.max(1, next));
    setTotal(value);
    setCounts((prev) => {
      let excess = Object.values(prev).reduce((s, n) => s + n, 0) - value;
      if (excess <= 0) return prev;
      const out = { ...prev };
      for (const id of Object.keys(out).reverse()) {
        const take = Math.min(out[id], excess);
        out[id] -= take;
        excess -= take;
        if (out[id] === 0) delete out[id];
        if (excess === 0) break;
      }
      return out;
    });
  }

  function bump(id: string, delta: number) {
    setCounts((prev) => {
      const current = prev[id] ?? 0;
      const next = current + delta;
      if (next <= 0) {
        const out = { ...prev };
        delete out[id];
        return out;
      }
      if (delta > 0 && remaining <= 0) return prev; // total atteint
      return { ...prev, [id]: next };
    });
  }

  function confirm() {
    const distribution = choices
      .filter((c) => (counts[c.id] ?? 0) > 0)
      .map((c) => ({ choice: c, quantity: counts[c.id] }));
    if (distribution.length > 0) onConfirm(distribution);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-espresso/50">
      <div className="flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-2xl bg-crema">
        <div className="flex items-center justify-between border-b border-espresso/10 px-4 py-3">
          <h2 className="text-lg font-bold">{title}</h2>
          <button
            onClick={onClose}
            aria-label={t("close")}
            className="rounded-full px-3 py-1 text-sm font-medium text-ink-on-bg-muted"
          >
            {t("close")} ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {/* Étape 1 — quantité totale */}
          <h3 className="font-semibold">
            {t("howMany")}
          </h3>

          {presets && presets.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {presets.map((n) => (
                <button
                  key={n}
                  onClick={() => setTotalSafe(n)}
                  aria-pressed={total === n}
                  className={
                    "rounded-full px-4 py-2 text-sm font-semibold " +
                    (total === n
                      ? "bg-caramel text-caramel-ink"
                      : "bg-white text-ink-on-bg shadow-sm")
                  }
                >
                  {n}
                </button>
              ))}
            </div>
          )}

          <div className="mt-3 flex items-center justify-between rounded-xl bg-white p-3">
            <div className="flex items-center gap-4">
              <button
                onClick={() => setTotalSafe(total - 1)}
                aria-label={t("ariaDecrease")}
                className="h-9 w-9 rounded-full bg-crema text-lg font-bold"
              >
                −
              </button>
              <span className="min-w-8 text-center text-lg font-bold">{total}</span>
              <button
                onClick={() => setTotalSafe(total + 1)}
                aria-label={t("ariaIncrease")}
                className="h-9 w-9 rounded-full bg-caramel text-lg font-bold text-caramel-ink"
              >
                +
              </button>
            </div>
            <span className="font-bold text-accent-dark-on-bg">
              <Ltr>{formatPrice(item.price * total, currency)}</Ltr>
            </span>
          </div>

          {/* Étape 2 — répartition */}
          <div className="mt-6 flex items-baseline justify-between">
            <h3 className="font-semibold">{t("distribute")}</h3>
            <span
              className={
                "text-sm font-semibold " +
                (complete ? "text-green-700" : "text-accent-dark-on-bg")
              }
            >
              {complete
                ? t("distributionDone")
                : remaining > 0
                  ? t("toDistribute", { n: remaining })
                  : t("tooMany", { n: -remaining })}
            </span>
          </div>

          <ul className="mt-3 space-y-2">
            {choices.map((choice) => {
              const n = counts[choice.id] ?? 0;
              return (
                <li
                  key={choice.id}
                  className={
                    "flex items-center justify-between gap-3 rounded-xl p-3 " +
                    (n > 0 ? "bg-white ring-1 ring-caramel/40" : "bg-white")
                  }
                >
                  <span className="min-w-0 text-sm font-semibold leading-snug">
                    {tName(choice, lang)}
                  </span>
                  <div className="flex items-center gap-3 rounded-full bg-crema px-2 py-1">
                    <button
                      onClick={() => bump(choice.id, -1)}
                      disabled={n === 0}
                      aria-label={t("ariaRemoveOne", { name: tName(choice, lang) })}
                      className={
                        "h-7 w-7 rounded-full font-bold shadow-sm " +
                        (n === 0 ? "bg-white text-espresso/30" : "bg-white")
                      }
                    >
                      −
                    </button>
                    <span className="min-w-5 text-center font-semibold">{n}</span>
                    <button
                      onClick={() => bump(choice.id, 1)}
                      disabled={remaining <= 0}
                      aria-label={t("ariaAddOne", { name: tName(choice, lang) })}
                      className={
                        "h-7 w-7 rounded-full font-bold text-caramel-ink " +
                        (remaining <= 0 ? "bg-caramel/30" : "bg-caramel")
                      }
                    >
                      +
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="border-t border-espresso/10 px-4 py-4">
          <button
            onClick={confirm}
            disabled={!complete}
            className={
              "w-full rounded-xl py-3.5 text-center font-bold " +
              (complete
                ? "bg-caramel text-caramel-ink"
                : "cursor-not-allowed bg-espresso/20 text-ink-text-on-bg-20")
            }
          >
            {complete
              ? `${t("addTotal", {
                  n: total,
                  name: tName(item, lang),
                })} — ${formatPrice(item.price * total, currency)}`
              : remaining > 0
                ? t("distributeRemaining", { n: remaining })
                : t("removeExcess")}
          </button>
        </div>
      </div>
    </div>
  );
}
