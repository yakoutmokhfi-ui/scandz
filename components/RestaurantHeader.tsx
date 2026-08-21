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

  // Cover uploadée par l'établissement (V68, Storage) prioritaire sur
  // le repli /banners/<slug>.jpg statique — absente/`null` pour tout
  // établissement n'ayant pas encore renseigné de cover : le rendu
  // reste alors exactement celui d'avant V68, sans placeholder cassé.
  const coverUrl = config.cover_url ?? null;

  // Corrige V70-06 (décision CTO) : plus aucun lien vers un
  // fournisseur de cartographie n'est fabriqué implicitement depuis
  // latitude/longitude. Ces coordonnées restent des données neutres
  // (elles ne sont simplement plus lues ici) ; seul un maps_url
  // explicitement renseigné par le commerçant produit un CTA externe
  // — absent, aucun CTA n'est affiché plutôt que de retomber sur un
  // lien Google construit à sa place.
  const directionsUrl = config.maps_url ?? null;

  return (
    <header
      className="relative overflow-hidden text-center text-ink-text"
      style={{
        // Photo propre à l'établissement, facultative :
        // /banners/<slug>.jpg. En son absence, le dégradé du thème
        // assure seul le fond — d'où une couleur de repli qui suit
        // l'identité de l'établissement et non celle d'un autre.
        backgroundColor: "var(--sc-ink, #221510)",
        backgroundImage: `linear-gradient(var(--sc-veil-soft, rgba(23,13,9,0.2)), var(--sc-veil-strong, rgba(23,13,9,0.32))), url('${coverUrl ?? `/banners/${banner ?? restaurant.slug}.jpg`}')`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <LanguageSelector active={lang} onChange={onChangeLang} />

      {/* Contenu centré verticalement avec espacements réguliers.
          Corrige V72-02 (contre-audit Work, 3e tour) : le titre et le
          sous-titre reposent désormais sur un panneau ENTIÈREMENT
          OPAQUE (bg-espresso, sans opacité), pas seulement sur une
          ombre portée -- l'ombre seule ne garantissait AUCUN contraste
          déterministe (dépendait de la luminosité de la photo
          téléchargée, jamais calculable à l'avance). Le logo reste
          hors panneau (une image, pas du texte, aucune préoccupation
          de contraste applicable).
          Corrige V73-02 (contre-audit Work, 4e tour) : le message de
          bienvenue et le sous-titre utilisaient text-ink-text/90 et
          text-ink-text/70 -- une opacité Tailwind APPLIQUÉE À UNE
          VALEUR DÉJÀ CALCULÉE (noir ou blanc pur, choisie
          spécifiquement pour un contraste optimal) la fait retomber
          vers la couleur du fond en la mélangeant partiellement avec
          lui, DÉGRADANT la garantie de contraste qu'elle était censée
          fournir -- exactement le même piège que les fonds
          translucides (V72-02), mais côté texte. Texte désormais à
          pleine opacité ; la hiérarchie visuelle (message principal
          vs sous-titre) reste assurée par la taille (text-sm vs
          text-xs), pas par l'opacité. L'ornement décoratif
          (aria-hidden, voir components/Icons.tsx) reste inchangé :
          purement décoratif, hors du champ des exigences de contraste
          de texte WCAG. */}
      <div className="flex min-h-[15rem] flex-col items-center justify-center gap-3 px-4 pb-6 pt-12 sm:min-h-[17rem]">
        {config.logo_url && (
          <img
            src={config.logo_url}
            alt={`Logo ${restaurant.name}`}
            className="h-20 w-20 rounded-full border-2 border-ink-text/60 object-cover shadow-lg"
          />
        )}

        <div className="rounded-2xl bg-espresso px-6 py-4 shadow-lg">
          <h1 className="font-serif text-3xl font-bold italic tracking-wide text-ink-text">
            {restaurant.name}
          </h1>

          <span className="mt-1 inline-block text-ink-text/80">
            <Ornament />
          </span>

          <p className="mt-2 text-sm text-ink-text">
            {t("welcome", { name: restaurant.name })}
          </p>
          <p className="mt-1 text-xs text-ink-text">{t("subtitle")}</p>
        </div>

        {directionsUrl && (
          <a
            href={directionsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-2 rounded-full border border-ink-text/60 bg-espresso px-4 py-2 text-xs font-semibold text-ink-text"
          >
            📍 {t("directions")}
          </a>
        )}
      </div>

      {/* Informations pratiques compactes, au bas du hero : elles
          n'occupent plus un bloc entier avant les catégories. */}
      <RestaurantInfoBar restaurant={restaurant} />
    </header>
  );
}
