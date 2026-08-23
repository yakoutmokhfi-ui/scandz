"use client";

import { useState } from "react";
import type { MenuItem } from "@/lib/types";
import { formatPrice } from "@/lib/whatsapp";
import QuantityControl from "@/components/QuantityControl";
import InlineOptions from "@/components/InlineOptions";
import Ltr from "@/components/Bidi";
import ProductInfoButton from "@/components/ProductInfoButton";
import ProductPhotoPlaceholder from "@/components/ProductPhotoPlaceholder";
import { useI18n } from "@/lib/i18n-context";
import { tName, tDescription, tShortDescription } from "@/lib/menu-i18n";

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
  variant = "classic",
}: {
  item: MenuItem;
  currency: string;
  quantity: number;
  requiresChoice: boolean;
  /** Goûts affichés sur la carte (mode "inline") */
  inlineChoices?: MenuItem[];
  inlineCounts?: Record<string, number>;
  onAdd: () => void;
  onRemove: () => void;
  onChangeChoice?: (choice: MenuItem, delta: number) => void;
  variant?: "classic" | "editorial";
}) {
  const { t, lang, sourceLanguage } = useI18n();
  // Photo cassée (URL présente mais 404/erreur réseau, V67) : jamais
  // affichée, jamais de bloc vide à sa place — la carte revient au
  // rendu "sans photo" dès le premier échec de chargement.
  const [photoFailed, setPhotoFailed] = useState(false);
  const hasPhoto = Boolean(item.image_url) && !photoFailed;
  const isInline = Boolean(inlineChoices && onChangeChoice);
  // Corrige UIFIX-V3-01 (contre-audit Work, 4e tour) : cette carte
  // englobe des descendants dont le texte (text-ink-on-bg-muted,
  // text-accent-dark-on-bg, text-ink-on-bg) est calculé contre
  // --sc-bg, alors que la carte elle-même restait sur un fond littéral figé --
  // même défaut structurel que UIFIX-01/UIFIX-V2-01. bg-crema
  // (= var(--sc-bg)) réaligne le fond réellement affiché sur la même
  // source. Utilisée dans le parcours principal pour chaque produit.
  const cardClasses =
    variant === "editorial"
      ? "rounded-lg border border-gold/20 bg-crema p-3 shadow-sm shadow-espresso/5"
      : "rounded-2xl bg-crema p-3 shadow-md shadow-espresso/5";
  const imageRadius = variant === "editorial" ? "rounded-md" : "rounded-xl";

  if (isInline) {
    return (
      <article className={cardClasses}>
        <div className="flex gap-3">
          {hasPhoto ? (
            <img
              src={item.image_url!}
              alt={item.name}
              onError={() => setPhotoFailed(true)}
              className={`h-24 w-24 shrink-0 object-cover ${imageRadius}`}
            />
          ) : (
            <ProductPhotoPlaceholder
              className={`h-24 w-24 shrink-0 ${imageRadius}`}
            />
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-start gap-1.5">
              <h3 className="min-w-0 font-semibold leading-snug">
                {tName(item, lang, sourceLanguage)}
              </h3>
              {tDescription(item, lang, sourceLanguage) && (
                <ProductInfoButton
                  description={tDescription(item, lang, sourceLanguage)!}
                  triggerLabel={t("moreInfoAbout", { name: tName(item, lang, sourceLanguage) })}
                  closeLabel={t("close")}
                />
              )}
            </div>
            {tShortDescription(item, lang, sourceLanguage) && (
              <p className="mt-0.5 text-sm text-ink-on-bg-muted">
                {tShortDescription(item, lang, sourceLanguage)}
              </p>
            )}
            <div className="mt-auto flex items-baseline justify-between gap-2 pt-2">
              <span className="font-bold text-accent-dark-on-bg">
                <Ltr>{formatPrice(item.price, currency)}</Ltr>
              </span>
              {quantity > 0 && (
                <span className="text-sm font-semibold text-ink-on-bg">
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
    <article className={`flex gap-3 ${cardClasses}`}>
      {hasPhoto ? (
        <img
          src={item.image_url!}
          alt={item.name}
          onError={() => setPhotoFailed(true)}
          className={`h-28 w-28 shrink-0 object-cover ${imageRadius}`}
        />
      ) : (
        <ProductPhotoPlaceholder className={`h-28 w-28 shrink-0 ${imageRadius}`} />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start gap-1.5">
          <h3 className="min-w-0 font-semibold leading-snug">
            {tName(item, lang, sourceLanguage)}
          </h3>
          {tDescription(item, lang, sourceLanguage) && (
            <ProductInfoButton
              description={tDescription(item, lang, sourceLanguage)!}
              triggerLabel={t("moreInfoAbout", { name: tName(item, lang, sourceLanguage) })}
              closeLabel={t("close")}
            />
          )}
        </div>
        {tShortDescription(item, lang, sourceLanguage) && (
          <p className="mt-0.5 line-clamp-2 text-sm text-ink-on-bg-muted">
            {tShortDescription(item, lang, sourceLanguage)}
          </p>
        )}

        <div className="mt-auto pt-2">
          <div className="flex items-end justify-between gap-2">
            <span className="font-bold text-accent-dark-on-bg">
              <Ltr>{formatPrice(item.price, currency)}</Ltr>
            </span>

            {requiresChoice ? (
              /*
               * Produit à options : la carte reflète le panier, jamais
               * un état local. À zéro on propose "Ajouter", qui ouvre
               * la fenêtre de choix ; rien n'entre au panier avant
               * confirmation. Au-delà, le compteur agit sur le panier
               * et le retrait de la dernière unité ramène au bouton.
               */
              quantity === 0 ? (
                <button
                  onClick={onAdd}
                  className="rounded-full bg-caramel px-4 py-1.5 text-sm font-semibold text-caramel-ink active:bg-caramel-dark"
                >
                  {t("add")}
                </button>
              ) : (
                <div className="flex items-center gap-3 rounded-full bg-crema px-2 py-1">
                  <button
                    onClick={onRemove}
                    aria-label={t("ariaDecrease")}
                    className="h-7 w-7 rounded-full bg-white font-bold text-stone-900 shadow-sm"
                  >
                    −
                  </button>
                  <span className="min-w-4 text-center font-semibold">
                    {quantity}
                  </span>
                  <button
                    onClick={onAdd}
                    aria-label={t("ariaIncrease")}
                    className="h-7 w-7 rounded-full bg-caramel font-bold text-caramel-ink"
                  >
                    +
                  </button>
                </div>
              )
            ) : (
              <QuantityControl
                quantity={quantity}
                onChange={(delta) => (delta > 0 ? onAdd() : onRemove())}
              />
            )}
          </div>

          {requiresChoice && quantity > 0 && (
            <p className="mt-2 text-right text-xs font-semibold text-accent-dark-on-bg">
              {t("alreadyInCart", { n: quantity })}
            </p>
          )}
        </div>
      </div>
    </article>
  );
}
