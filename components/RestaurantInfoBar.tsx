import type { ReactNode } from "react";
import type { RestaurantFull } from "@/lib/types";
import { getSettings } from "@/lib/restaurants-config";
import { useI18n } from "@/lib/i18n-context";
import Ltr from "@/components/Bidi";
import { ClockIcon, PhoneIcon, PinIcon } from "@/components/Icons";

/**
 * Bandeau compact d'informations, intégré au bas de la bannière.
 *
 * Remplace le bloc blanc vertical, qui occupait une hauteur
 * importante avant les catégories. Fond sombre translucide avec
 * flou : la photo reste visible dessous.
 *
 * Toutes les valeurs proviennent des données de l'établissement —
 * aucune adresse, aucun numéro et aucun horaire n'est codé en dur.
 */
export default function RestaurantInfoBar({
  restaurant,
}: {
  restaurant: RestaurantFull;
}) {
  const { t } = useI18n();
  const { config } = restaurant;
  const phone = getSettings(restaurant.slug).phone;

  // Lien Maps construit depuis les coordonnées enregistrées. Absentes,
  // l'adresse s'affiche sans lien plutôt que de pointer vers rien.
  const mapsUrl =
    config.latitude !== null && config.longitude !== null
      ? `https://www.google.com/maps/search/?api=1&query=${config.latitude},${config.longitude}`
      : null;

  const hours = config.opening_hours;
  const hoursContent = hours
    ? /[A-Za-zÀ-ÿ]/.test(hours)
      ? <Ltr>{hours}</Ltr>
      : <>{t("openEveryDay")} <Ltr>{hours}</Ltr></>
    : null;

  const cells: {
    key: string;
    icon: ReactNode;
    label: string;
    content: ReactNode;
    href?: string;
    aria?: string;
    wide?: boolean;
  }[] = [];

  if (config.address) {
    cells.push({
      key: "address",
      icon: <PinIcon />,
      label: t("labelAddress"),
      content: <Ltr>{config.address}</Ltr>,
      href: mapsUrl ?? undefined,
      aria: mapsUrl ? t("ariaOpenMaps", { name: restaurant.name }) : undefined,
      // L'adresse est la valeur la plus longue : elle occupe la
      // première ligne entière sur mobile.
      wide: true,
    });
  }
  if (phone) {
    cells.push({
      key: "phone",
      icon: <PhoneIcon />,
      label: t("labelPhone"),
      content: <Ltr>{phone}</Ltr>,
      href: `tel:${phone.replace(/[\s.]/g, "")}`,
      aria: t("ariaCallRestaurant", { name: restaurant.name }),
    });
  }
  if (hoursContent) {
    cells.push({
      key: "hours",
      icon: <ClockIcon />,
      label: t("labelHours"),
      content: hoursContent,
    });
  }

  if (cells.length === 0) return null;

  return (
    <div className="px-4 pb-5">
      <div className="rounded-xl border border-gold/25 bg-espresso/55 p-1 backdrop-blur-sm">
        {/* Mobile : l'adresse sur toute la largeur, téléphone et
            horaires côte à côte. Tablette et ordinateur : trois
            colonnes égales. */}
        <div className="grid grid-cols-2 gap-px sm:grid-cols-3">
          {cells.map((cell) => {
            const inner = (
              <>
                <span aria-hidden className="mt-0.5 shrink-0 text-gold">
                  {cell.icon}
                </span>
                <span className="min-w-0">
                  <span className="block text-[0.6rem] font-semibold uppercase tracking-wider text-gold/80">
                    {cell.label}
                  </span>
                  <span className="block truncate text-xs text-crema sm:whitespace-normal">
                    {cell.content}
                  </span>
                </span>
              </>
            );

            const classes =
              "flex items-start gap-2 px-3 py-2 text-left " +
              (cell.wide ? "col-span-2 sm:col-span-1 " : "");

            return cell.href ? (
              <a
                key={cell.key}
                href={cell.href}
                target={cell.href.startsWith("http") ? "_blank" : undefined}
                rel={cell.href.startsWith("http") ? "noopener noreferrer" : undefined}
                aria-label={cell.aria}
                className={classes + "rounded-lg hover:bg-espresso/40"}
              >
                {inner}
              </a>
            ) : (
              <span key={cell.key} className={classes}>
                {inner}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
