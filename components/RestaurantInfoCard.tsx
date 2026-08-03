import type { ReactNode } from "react";
import type { RestaurantFull } from "@/lib/types";
import { getSettings } from "@/lib/restaurants-config";
import { useI18n } from "@/lib/i18n-context";
import Ltr from "@/components/Bidi";

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
      icon: "📍",
      label: t("labelAddress"),
      content: <Ltr>{config.address}</Ltr>,
    },
    phone && {
      icon: "📞",
      label: t("labelPhone"),
      content: (
        <a
          href={`tel:${phone.replace(/[\s.]/g, "")}`}
          className="font-medium text-caramel-dark underline-offset-2 hover:underline"
        >
          <Ltr>{phone}</Ltr>
        </a>
      ),
    },
    config.opening_hours && {
      icon: "🕒",
      label: t("labelHours"),
      // Horaires purement numériques ("07:00 – 23:00") : on préfixe
      // avec un libellé traduit. Sinon, texte affiché tel quel.
      content: /[A-Za-zÀ-ÿ]/.test(config.opening_hours) ? (
        <Ltr>{config.opening_hours}</Ltr>
      ) : (
        <>
          {t("openEveryDay")} <Ltr>{config.opening_hours}</Ltr>
        </>
      ),
    },
  ].filter(Boolean) as { icon: string; label: string; content: ReactNode }[];

  if (rows.length === 0) return null;

  return (
    <div className="relative z-10 -mt-5 px-4">
      <div className="divide-y divide-espresso/5 rounded-2xl bg-white shadow-md">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-3 px-4 py-3">
            <span aria-hidden className="text-lg">
              {row.icon}
            </span>
            <div className="min-w-0 text-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-espresso/50">
                {row.label}
              </p>
              <p className="text-espresso/85">{row.content}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
