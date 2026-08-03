"use client";

import { useI18n } from "@/lib/i18n-context";
import { tName } from "@/lib/menu-i18n";
import type { MenuItem } from "@/lib/types";

/**
 * Goûts affichés directement sur la carte produit, chacun avec son
 * compteur. Adapté aux cartes très courtes : le client compose sa
 * commande sans ouvrir de fenêtre.
 */
export default function InlineOptions({
  choices,
  counts,
  onChange,
}: {
  choices: MenuItem[];
  counts: Record<string, number>;
  onChange: (choice: MenuItem, delta: number) => void;
}) {
  const { t, lang } = useI18n();

  return (
    <div className="mt-3 border-t border-espresso/10 pt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-caramel-dark">
        {t("ourFlavors")}
      </p>

      <ul className="mt-2 space-y-1.5">
        {choices.map((choice) => {
          const n = counts[choice.name] ?? 0;
          return (
            <li
              key={choice.id}
              className={
                "flex items-center justify-between gap-3 rounded-xl px-3 py-1.5 " +
                (n > 0 ? "bg-crema ring-1 ring-caramel/40" : "bg-crema/60")
              }
            >
              <span className="min-w-0 text-sm font-medium leading-snug">
                {tName(choice, lang)}
              </span>

              <div className="flex shrink-0 items-center gap-2.5">
                <button
                  onClick={() => onChange(choice, -1)}
                  disabled={n === 0}
                  aria-label={t("ariaRemoveOne", { name: tName(choice, lang) })}
                  className={
                    "h-7 w-7 rounded-full text-sm font-bold shadow-sm " +
                    (n === 0 ? "bg-white text-espresso/25" : "bg-white")
                  }
                >
                  −
                </button>
                <span
                  className={
                    "min-w-4 text-center text-sm font-bold " +
                    (n === 0 ? "text-espresso/30" : "text-espresso")
                  }
                >
                  {n}
                </span>
                <button
                  onClick={() => onChange(choice, 1)}
                  aria-label={t("ariaAddOne", { name: tName(choice, lang) })}
                  className="h-7 w-7 rounded-full bg-caramel text-sm font-bold text-white"
                >
                  +
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
