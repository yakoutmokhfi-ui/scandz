import { useI18n } from "@/lib/i18n-context";
import type { RestaurantFull } from "@/lib/types";
import LanguageSelector from "@/components/LanguageSelector";
import { Ornament } from "@/components/Icons";
import RestaurantInfoBar from "@/components/RestaurantInfoBar";
import type { Lang } from "@/lib/i18n";

export default function RestaurantHeader({
  restaurant,
  lang,
  onChangeLang,
  theme,
  banner,
}: {
  restaurant: RestaurantFull;
  lang: Lang;
  onChangeLang: (lang: Lang) => void;
  theme?: string;
  /** Nom de fichier dans /banners, sinon celui du slug */
  banner?: string;
}) {
  const { t } = useI18n();
  const { config } = restaurant;

  // Le motif n'est plus posé sur la bannière : par-dessus une
  // photo il la salit au lieu de l'habiller. Il reste en fond de
  // page, sous les cartes, où il donne sa texture sans nuire à la
  // lisibilité.

  const mapsUrl =
    config.latitude !== null && config.longitude !== null
      ? `https://www.google.com/maps/search/?api=1&query=${config.latitude},${config.longitude}`
      : null;

  return (
    <header
      className="relative overflow-hidden text-center text-crema"
      style={{
        // Photo propre à l'établissement, facultative :
        // /banners/<slug>.jpg. En son absence, le dégradé du thème
        // assure seul le fond — d'où une couleur de repli qui suit
        // l'identité de l'établissement et non celle d'un autre.
        backgroundColor: "var(--sc-ink, #221510)",
        backgroundImage: `linear-gradient(var(--sc-veil-soft, rgba(23,13,9,0.2)), var(--sc-veil-strong, rgba(23,13,9,0.32))), url('/banners/${banner ?? restaurant.slug}.jpg')`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <LanguageSelector active={lang} onChange={onChangeLang} />

      {/* Contenu centré verticalement avec espacements réguliers */}
      {/* L'ombre portée garde le texte lisible sur les zones claires
          de la photo, sans avoir à assombrir l'ensemble. */}
      <div
        className="flex min-h-[15rem] flex-col items-center justify-center gap-3 px-4 pb-6 pt-12 sm:min-h-[17rem]"
        style={{ textShadow: "0 1px 12px rgba(0,0,0,0.75), 0 1px 3px rgba(0,0,0,0.6)" }}
      >
        {config.logo_url && (
          <img
            src={config.logo_url}
            alt={`Logo ${restaurant.name}`}
            className="h-20 w-20 rounded-full border-2 border-gold/60 object-cover shadow-lg"
          />
        )}

        <h1 className="font-serif text-3xl font-bold italic tracking-wide">
          {restaurant.name}
        </h1>

        <span className="text-gold/80">
          <Ornament />
        </span>

        <div>
          <p className="text-sm text-crema/90">
            {t("welcome", { name: restaurant.name })}
          </p>
          <p className="mt-1 text-xs text-crema/70">{t("subtitle")}</p>
        </div>

        {mapsUrl && (
          <a
            href={mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-2 rounded-full border border-gold/60 bg-espresso/40 px-4 py-2 text-xs font-semibold text-gold"
          >
            📍 {t("viewOnMaps")}
          </a>
        )}
      </div>

      {/* Informations pratiques compactes, au bas du hero : elles
          n'occupent plus un bloc entier avant les catégories. */}
      <RestaurantInfoBar restaurant={restaurant} />
    </header>
  );
}
