"use client";

import { useI18n } from "@/lib/i18n-context";

export default function QuantityControl({
  quantity,
  onChange,
}: {
  quantity: number;
  onChange: (delta: number) => void;
}) {
  const { t } = useI18n();

  if (quantity === 0) {
    return (
      <button
        onClick={() => onChange(1)}
        className="rounded-full bg-caramel px-4 py-1.5 text-sm font-semibold text-white active:bg-caramel-dark"
      >
        {t("add")}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-full bg-crema px-2 py-1">
      <button
        onClick={() => onChange(-1)}
        aria-label={t("ariaDecrease")}
        className="h-7 w-7 rounded-full bg-white font-bold shadow-sm"
      >
        −
      </button>
      <span className="min-w-4 text-center font-semibold">{quantity}</span>
      <button
        onClick={() => onChange(1)}
        aria-label={t("ariaIncrease")}
        className="h-7 w-7 rounded-full bg-caramel font-bold text-white"
      >
        +
      </button>
    </div>
  );
}
