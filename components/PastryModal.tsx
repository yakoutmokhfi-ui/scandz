"use client";

import { useState } from "react";
import type { MenuItem } from "@/lib/types";

export default function PastryModal({
  pastries,
  onConfirm,
  onClose,
}: {
  pastries: MenuItem[];
  onConfirm: (pastry: MenuItem) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<MenuItem | null>(null);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-espresso/50">
      <div className="flex max-h-[85dvh] w-full max-w-lg flex-col rounded-t-2xl bg-crema">
        <div className="flex items-center justify-between border-b border-espresso/10 px-4 py-3">
          <h2 className="text-lg font-bold">Choisissez votre pâtisserie</h2>
          <button
            onClick={onClose}
            aria-label="Fermer"
            className="rounded-full px-3 py-1 text-sm font-medium text-ink-on-bg-muted"
          >
            Fermer ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="grid grid-cols-2 gap-3">
            {pastries.map((pastry) => {
              const isSelected = selected?.id === pastry.id;
              return (
                <button
                  key={pastry.id}
                  onClick={() => setSelected(pastry)}
                  aria-pressed={isSelected}
                  className={
                    "overflow-hidden rounded-xl bg-white text-left text-stone-900 shadow-sm " +
                    (isSelected ? "ring-2 ring-caramel" : "")
                  }
                >
                  {pastry.image_url && (
                    <img
                      src={pastry.image_url}
                      alt={pastry.name}
                      className="h-24 w-full object-cover"
                    />
                  )}
                  <div className="flex items-center justify-between gap-2 p-3">
                    <span className="text-sm font-semibold leading-snug">
                      {pastry.name}
                    </span>
                    {isSelected && <span className="text-stone-900">✓</span>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="border-t border-espresso/10 px-4 py-4">
          <button
            onClick={() => selected && onConfirm(selected)}
            disabled={!selected}
            className={
              "w-full rounded-xl py-3.5 text-center font-bold " +
              (selected
                ? "bg-caramel text-caramel-ink"
                : "cursor-not-allowed bg-espresso/20 text-ink-text-on-bg-20")
            }
          >
            {selected
              ? `Confirmer : ${selected.name}`
              : "Sélectionnez une pâtisserie"}
          </button>
        </div>
      </div>
    </div>
  );
}
