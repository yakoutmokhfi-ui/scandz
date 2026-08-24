import type { ReactNode } from "react";
import type { RestaurantFull } from "@/lib/types";
import { getSettings } from "@/lib/restaurants-config";
import { useI18n } from "@/lib/i18n-context";
import Ltr from "@/components/Bidi";
import { ClockIcon, PhoneIcon, PinIcon } from "@/components/Icons";

export default function RestaurantInfoCard({
  restaurant,
}: {
  restaurant: RestaurantFull;
}) {
  const { t } = useI18n();
  const { config } = restaurant;
  const phone = getSettings(restaurant.slug).phone;

  const rows = [
    config.address && {
      icon: <PinIcon />,
      label: t("labelAddress"),
      content: <Ltr>{config.address}</Ltr>,
    },
    phone && {
      icon: <PhoneIcon />,
      label: t("labelPhone"),
      content: (
        <a
          href={`tel:${phone.replace(/[\s.]/g, "")}`}
          className="font-medium text-accent-dark-on-bg underline-offset-2 hover:underline"
        >
          <Ltr>{phone}</Ltr>
        </a>
      ),
    },
    config.opening_hours && {
      icon: <ClockIcon />,
      label: t("labelHours"),
      // Horaires purement numériques ("07:00 – 23:00") : on préfixe
      // avec un libellé traduit. Sinon, texte affiché tel quel.
      //
      // Corrige le rendu multiligne (audit dédié) : whitespace-pre-wrap
      // sur le <p> englobant (voir plus bas) préserve les retours à la
      // ligne réellement saisis (ex. Au Lait Cru : un jour/horaire par
      // ligne) -- confirmé que la donnée elle-même (colonne text,
      // aucune contrainte empêchant \n) peut légitimement les
      // contenir. Ciblé uniquement à ce champ : les horaires sont, par
      // nature, souvent exprimés sur plusieurs lignes (un jour ou une
      // période par ligne), contrairement à address/phone (contenu
      // typiquement compact, non concerné par ce correctif).
      content: /[A-Za-zÀ-ÿ]/.test(config.opening_hours) ? (
        <Ltr>{config.opening_hours}</Ltr>
      ) : (
        <>
          {t("openEveryDay")} <Ltr>{config.opening_hours}</Ltr>
        </>
      ),
      preserveLineBreaks: true,
    },
  ].filter(Boolean) as {
    icon: ReactNode;
    label: string;
    content: ReactNode;
    preserveLineBreaks?: boolean;
  }[];

  if (rows.length === 0) return null;

  return (
    <div className="relative z-10 -mt-5 px-4">
      {/* Corrige UIFIX-V3-01 (contre-audit Work, 4e tour) : ce
          conteneur englobe des descendants (text-ink-on-bg-muted,
          text-ink-on-bg, text-accent-dark-on-bg via row.content)
          calculés contre --sc-bg, alors qu'il restait sur un fond littéral figé.
          bg-crema (= var(--sc-bg)) réaligne le fond réellement
          affiché sur la même source. */}
      <div className="divide-y divide-espresso/5 rounded-2xl bg-crema shadow-md">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-3 px-4 py-3">
            {/* Laiton du thème : accent discret, sans aplat */}
            <span aria-hidden className="shrink-0 text-gold">
              {row.icon}
            </span>
            <div className="min-w-0 text-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-on-bg-muted">
                {row.label}
              </p>
              <p className={"text-ink-on-bg" + (row.preserveLineBreaks ? " whitespace-pre-wrap" : "")}>{row.content}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
