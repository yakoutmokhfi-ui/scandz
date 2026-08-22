import { useI18n } from "@/lib/i18n-context";
import { resolveTranslatedField } from "@/lib/translation-resolver";
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
  const { t, sourceLanguage } = useI18n();
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

  // LOT 1A — nom affiché personnalisable, jamais traduit (décision
  // CIO). NULL = repli sur restaurants.name, rendu V79 inchangé.
  const displayName = config.display_name ?? restaurant.name;

  // LOT 1A — texte de présentation en langue source uniquement dans
  // ce sous-lot (traductions : Sous-lot B, pas encore livré) --
  // remplace le sous-titre générique SEULEMENT si renseigné, jamais
  // supprimé sinon : établissement sans personnalisation -> rendu
  // V79 strictement inchangé.
  const introText = resolveTranslatedField(
    config.intro_text,
    config.intro_text_hash,
    config.translations,
    lang,
    sourceLanguage,
    "intro_text"
  );

  // LOT 1A — message temporaire/actualité, affiché uniquement si
  // ACTIF et non vide : la bascule et le contenu sont indépendants
  // (jamais supprimé/recréé, juste désactivé).
  const announcementText = resolveTranslatedField(
    config.announcement_text,
    config.announcement_text_hash,
    config.translations,
    lang,
    sourceLanguage,
    "announcement_text"
  );
  const showAnnouncement = Boolean(config.announcement_active && announcementText);

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
      <LanguageSelector active={lang} onChange={onChangeLang} languages={restaurant.activeLanguages} />

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
            alt={`Logo ${displayName}`}
            className="h-20 w-20 rounded-full border-2 border-ink-text/60 object-cover shadow-lg"
          />
        )}

        <div className="rounded-2xl bg-espresso px-6 py-4 shadow-lg">
          <h1 className="font-serif text-3xl font-bold italic tracking-wide text-ink-text">
            {displayName}
          </h1>

          <span className="mt-1 inline-block text-ink-text/80">
            <Ornament />
          </span>

          <p className="mt-2 text-sm text-ink-text">
            {t("welcome", { name: displayName })}
          </p>
          <p className="mt-1 text-xs text-ink-text whitespace-pre-line">
            {introText ?? t("subtitle")}
          </p>
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

        {/* LOT 1A — message temporaire/actualité : affiché uniquement
            si actif ET non vide, jamais si l'un des deux manque.
            Panneau opaque, même discipline de contraste déterministe
            que le reste du header (V72-02) -- pas de dépendance à la
            photo de fond. */}
        {showAnnouncement && (
          <p className="mt-2 max-w-xs rounded-xl bg-espresso px-4 py-2 text-xs text-ink-text whitespace-pre-line">
            {announcementText}
          </p>
        )}
      </div>

      {/* Informations pratiques compactes, au bas du hero : elles
          n'occupent plus un bloc entier avant les catégories. */}
      <RestaurantInfoBar restaurant={restaurant} />

      {/* LOT 1A — réseaux sociaux : seules les icônes des réseaux
          réellement renseignés s'affichent, jamais une icône morte.
          URLs déjà validées serveur (HTTPS strict, domaine exact) par
          update_restaurant_social_links -- ce composant ne fait
          qu'afficher, aucune validation supplémentaire nécessaire ici. */}
      {(config.instagram_url || config.tiktok_url || config.facebook_url) && (
        <div className="flex items-center justify-center gap-4 pb-4">
          {config.instagram_url && (
            <a
              href={config.instagram_url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Instagram"
              className="text-ink-text"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                <rect x="3" y="3" width="18" height="18" rx="5" />
                <circle cx="12" cy="12" r="4" />
                <circle cx="17.5" cy="6.5" r="0.8" fill="currentColor" stroke="none" />
              </svg>
            </a>
          )}
          {config.tiktok_url && (
            <a
              href={config.tiktok_url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="TikTok"
              className="text-ink-text"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M16.5 3c.4 2.2 1.9 3.7 4 3.9v2.6c-1.4 0-2.7-.4-3.9-1.2v6.4c0 3.2-2.3 5.3-5.2 5.3-2.9 0-5.2-2.1-5.2-4.8 0-2.7 2.3-4.8 5.2-4.8.4 0 .8 0 1.2.1v2.7a2.6 2.6 0 0 0-1.2-.3c-1.4 0-2.5 1-2.5 2.3s1.1 2.3 2.5 2.3c1.5 0 2.6-1.1 2.6-2.6V3h2.5z" />
              </svg>
            </a>
          )}
          {config.facebook_url && (
            <a
              href={config.facebook_url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Facebook"
              className="text-ink-text"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M13.5 21v-8h2.7l.4-3.2h-3.1V7.7c0-.9.3-1.5 1.6-1.5h1.7V3.3C16.5 3.2 15.5 3 14.4 3c-2.4 0-4 1.5-4 4.2v2.6H7.7v3.2h2.7v8h3.1z" />
              </svg>
            </a>
          )}
        </div>
      )}
    </header>
  );
}
