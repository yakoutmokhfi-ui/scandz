"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n-context";

/**
 * Issue #188 (suite) -- photo produit agrandie au clic, en QUALITÉ D'ORIGINE.
 *
 * La carte n'affiche qu'une miniature légère (lazy, 512 px) ; cette fenêtre
 * charge l'image ORIGINALE, uniquement à l'ouverture : la page reste rapide
 * et le client voit la texture réelle du produit.
 *
 * Accessibilité : role="dialog" + aria-modal nommé par le produit, focus sur
 * le bouton de fermeture, Tab retenu dans la fenêtre, Échap / clic sur le
 * fond / bouton de fermeture (44 px) ferment ; le défilement de la page est
 * bloqué puis rétabli. Aucune action de commande n'est possible ici.
 */
export default function PhotoLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const rootOverflow = root.style.overflow;
    const bodyOverflow = body.style.overflow;
    root.style.overflow = "hidden";
    body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === "Tab") {
        e.preventDefault();
        closeRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      root.style.overflow = rootOverflow;
      body.style.overflow = bodyOverflow;
    };
  }, []);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      data-photo-lightbox=""
      className="fixed inset-0 z-[60] flex items-center justify-center bg-espresso/90 p-4"
      onClick={() => onCloseRef.current()}
    >
      <button
        ref={closeRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onCloseRef.current();
        }}
        aria-label={t("close")}
        className="absolute end-3 top-3 flex h-11 w-11 items-center justify-center rounded-full bg-white text-2xl font-bold leading-none text-stone-900 shadow"
      >
        <span aria-hidden="true">×</span>
      </button>
      {failed ? (
        <p data-photo-lightbox-error="" className="rounded-lg bg-white px-4 py-3 text-sm text-stone-900">
          {t("photoUnavailable")}
        </p>
      ) : (
        <img
          src={src}
          alt={alt}
          decoding="async"
          onError={() => setFailed(true)}
          onClick={(e) => e.stopPropagation()}
          className="max-h-[85dvh] max-w-full rounded-xl object-contain"
        />
      )}
    </div>,
    document.body
  );
}
