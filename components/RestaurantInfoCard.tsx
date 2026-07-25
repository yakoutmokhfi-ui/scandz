import type { ReactNode } from "react";
import type { RestaurantFull } from "@/lib/types";
import { DEMO_PHONE } from "@/lib/demo";

export default function RestaurantInfoCard({
  restaurant,
}: {
  restaurant: RestaurantFull;
}) {
  const { config } = restaurant;

  const rows = [
    config.address && {
      icon: "📍",
      label: "Adresse",
      content: <span>{config.address}</span>,
    },
    {
      icon: "📞",
      label: "Téléphone",
      content: (
        <a
          href={`tel:${DEMO_PHONE.replace(/\s/g, "")}`}
          className="font-medium text-caramel-dark underline-offset-2 hover:underline"
        >
          {DEMO_PHONE}
        </a>
      ),
    },
    config.opening_hours && {
      icon: "🕒",
      label: "Horaires",
      content: <span>{config.opening_hours}</span>,
    },
  ].filter(Boolean) as { icon: string; label: string; content: ReactNode }[];

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
