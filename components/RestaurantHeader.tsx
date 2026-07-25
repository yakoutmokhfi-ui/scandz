import type { RestaurantFull } from "@/lib/types";
import LanguageSelector from "@/components/LanguageSelector";

export default function RestaurantHeader({
  restaurant,
}: {
  restaurant: RestaurantFull;
}) {
  const { config } = restaurant;

  const mapsUrl =
    config.latitude !== null && config.longitude !== null
      ? `https://www.google.com/maps/search/?api=1&query=${config.latitude},${config.longitude}`
      : null;

  return (
    <header
      className="relative overflow-hidden text-center text-crema"
      style={{
        // La photo /banner.jpg (dossier public) est optionnelle :
        // si elle est absente, le dégradé assure seul le fond.
        backgroundImage:
          "linear-gradient(rgba(23,13,9,0.55), rgba(23,13,9,0.8)), url('/banner.jpg')",
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <LanguageSelector />

      {/* Contenu centré verticalement avec espacements réguliers */}
      <div className="flex min-h-[21rem] flex-col items-center justify-center gap-3 px-4 py-12">
        {config.logo_url && (
          <img
            src={config.logo_url}
            alt={`Logo ${restaurant.name}`}
            className="h-20 w-20 rounded-full border-2 border-gold/60 object-cover shadow-lg"
          />
        )}

        <div>
          <h1 className="font-serif text-3xl font-bold italic tracking-wide">
            {restaurant.name.replace(" Coffee", "")}
          </h1>
          <p className="mt-1 text-[0.7rem] font-semibold uppercase tracking-[0.45em] text-gold">
            Coffee
          </p>
        </div>

        <div className="h-px w-16 bg-gold/60" />

        <div>
          <p className="text-sm text-crema/90">
            Bienvenue chez {restaurant.name}
          </p>
          <p className="mt-1 text-xs text-crema/70">
            Choisissez vos produits et passez votre commande
          </p>
        </div>

        {mapsUrl && (
          <a
            href={mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-2 rounded-full border border-gold/60 bg-espresso/40 px-4 py-2 text-xs font-semibold text-gold"
          >
            📍 Voir sur Google Maps
          </a>
        )}
      </div>
    </header>
  );
}
