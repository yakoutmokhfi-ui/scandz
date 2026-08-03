"use client";

import { useI18n } from "@/lib/i18n-context";

export default function TableSelector({
  maxTables,
  selected,
  onSelect,
}: {
  maxTables: number;
  selected: number | null;
  onSelect: (table: number) => void;
}) {
  const { t } = useI18n();
  const tables = Array.from({ length: maxTables }, (_, i) => i + 1);

  return (
    <div className="mt-6">
      <h3 className="font-semibold">{t("yourTable")}</h3>
      <div className="mt-2 grid grid-cols-5 gap-2">
        {tables.map((n) => (
          <button
            key={n}
            onClick={() => onSelect(n)}
            aria-pressed={selected === n}
            className={
              "rounded-lg py-2 text-sm font-semibold " +
              (selected === n
                ? "bg-caramel text-white"
                : "bg-white text-espresso shadow-sm")
            }
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}
