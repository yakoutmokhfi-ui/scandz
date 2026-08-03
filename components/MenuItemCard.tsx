"use client";

import { useState } from "react";
import type { MenuItem } from "@/lib/types";
import { formatPrice } from "@/lib/whatsapp";
import QuantityControl from "@/components/QuantityControl";
import InlineOptions from "@/components/InlineOptions";
import Ltr from "@/components/Bidi";
import { useI18n } from "@/lib/i18n-context";
import { tName, tDescription } from "@/lib/menu-i18n";

/**
 * Carte produit compacte horizontale : photo à gauche, informations à
 * droite, action en bas à droite.
 *
 * Produit sans option : le compteur agit directement sur le panier.
 * Produit à option : un compteur local règle la quantité voulue, puis
 * "Ajouter" ouvre la fenêtre de choix déjà réglée sur cette quantité.
 */
export default function MenuItemCard({
  item,
  currency,
  quantity,
  requiresChoice,
  inlineChoices,
  inlineCounts,
  onAdd,
  onRemove,
  onChangeChoice,
}: {
  item: MenuItem;
  currency: string;
  quantity: number;
  requiresChoice: boolean;
  /** Goûts affichés sur la carte (mode "inline") */
  inlineChoices?: MenuItem[];
  inlineCounts?: Record<string, number>;
  onAdd: (quantity: number) => void;
  onRemove: () => void;
  onChangeChoice?: (choice: MenuItem, delta: number) => void;
}) {
  const { t, lang } = useI18n();
  const isInline = Boolean(inlineChoices && onChangeChoice);
  const [pending, setPending] = useState(1);

  if (isInline) {
    return (
      <article className="rounded-2xl bg-white p-3 shadow-sm">
        <div className="flex gap-3">
          {item.image_url && (
            <img
              src={item.image_url}
              alt={item.name}
              className="h-24 w-24 shrink-0 rounded-xl object-cover"
            />
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <h3 className="font-semibold leading-snug">{tName(item, lang)}</h3>
            {tDescription(item, lang) && (
              <p className="mt-0.5 text-sm text-espresso/60">
                {tDescription(item, lang)}
              </p>
            )}
            <div className="mt-auto flex items-baseline justify-between gap-2 pt-2">
              <span className="font-bold text-caramel-dark">
                <Ltr>{formatPrice(item.price, currency)}</Ltr>
              </span>
              {quantity > 0 && (
                <span className="text-sm font-semibold text-espresso">
                  <Ltr>
                    {quantity} × {formatPrice(item.price * quantity, currency)}
                  </Ltr>
                </span>
              )}
            </div>
          </div>
        </div>

        <InlineOptions
          choices={inlineChoices!}
          counts={inlineCounts ?? {}}
          onChange={onChangeChoice!}
        />
      </article>
    );
  }

  return (
    <article className="flex gap-3 rounded-2xl bg-white p-3 shadow-sm">
      {item.image_url && (
        <img
          src={item.image_url}
          alt={item.name}
          className="h-28 w-28 shrink-0 rounded-xl object-cover"
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <h3 className="font-semibold leading-snug">{tName(item, lang)}</h3>
        {tDescription(item, lang) && (
          <p className="mt-0.5 line-clamp-2 text-sm text-espresso/60">
            {tDescription(item, lang)}
          </p>
        )}

        <div className="mt-auto pt-2">
          <div className="flex items-end justify-between gap-2">
            <span className="font-bold text-caramel-dark">
              <Ltr>{formatPrice(item.price, currency)}</Ltr>
            </span>

            {requiresChoice ? (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 rounded-full bg-crema px-2 py-1">
                  <button
                    onClick={() => setPending((q) => Math.max(1, q - 1))}
                    aria-label={t("ariaDecrease")}
                    className="h-7 w-7 rounded-full bg-white font-bold shadow-sm"
                  >
                    −
                  </button>
                  <span className="min-w-5 text-center font-semibold">
                    {pending}
                  </span>
                  <button
                    onClick={() => setPending((q) => Math.min(99, q + 1))}
                    aria-label={t("ariaIncrease")}
                    className="h-7 w-7 rounded-full bg-caramel font-bold text-white"
                  >
                    +
                  </button>
                </div>
                <button
                  onClick={() => onAdd(pending)}
                  className="rounded-full bg-caramel px-4 py-1.5 text-sm font-semibold text-white active:bg-caramel-dark"
                >
                  {t("add")}
                </button>
              </div>
            ) : (
              <QuantityControl
                quantity={quantity}
                onChange={(delta) => (delta > 0 ? onAdd(1) : onRemove())}
              />
            )}
          </div>

          {requiresChoice && quantity > 0 && (
            <p className="mt-2 text-right text-xs font-semibold text-caramel-dark">
              {t("alreadyInCart", { n: quantity })}
            </p>
          )}
        </div>
      </div>
    </article>
  );
}
