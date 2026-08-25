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

  // Corrige V70-06 (décision CTO) : plus de lien Maps fabriqué depuis
  // les coordonnées. latitude/longitude restent des données neutres
  // (simplement non lues ici) ; seul un maps_url explicitement
  // renseigné par le commerçant rend l'adresse cliquable. Absent,
  // l'adresse s'affiche en texte seul plutôt que de pointer vers un
  // lien Google construit à sa place.
  const mapsUrl = config.maps_url ?? null;

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
    /** Corrige BUG UI 1 (fiche publique, zone Horaires trop étroite) :
     *  réservé aux horaires. Sur mobile (grid-cols-2), donne aux
     *  horaires la même largeur pleine ligne que `wide` (adresse),
     *  au lieu de partager la moitié de la ligne avec le téléphone.
     *  À partir de sm (grid-cols-4, voir plus bas), les horaires
     *  occupent 2 colonnes sur 4 (la moitié de la largeur totale) au
     *  lieu d'1 sur 3 auparavant -- adresse et téléphone conservent
     *  chacun 1 colonne, sans changement de comportement pour eux au-
     *  delà du nombre total de colonnes de la grille (3 -> 4, pour que
     *  1+1+2 remplisse exactement la ligne sans espace résiduel). Ne
     *  modifie ni le multiline existant, ni les données, ni
     *  adresse/téléphone. */
    wideDesktop?: boolean;
    /** Corrige UI MULTILINE FIX v2 (root cause réelle confirmée en
     *  Production -- RestaurantInfoBar est l'UNIQUE composant public
     *  réellement affiché pour ce bandeau, RestaurantInfoCard n'étant
     *  importé nulle part dans l'arbre de rendu réel). Réservé aux
     *  horaires : les retours à la ligne réellement saisis (désormais
     *  possibles depuis le passage à un <textarea> côté Dashboard)
     *  doivent être préservés visuellement. Adresse/téléphone
     *  restent volontairement compacts (truncate), leur contenu est
     *  par nature court et mono-ligne. */
    multiline?: boolean;
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
      multiline: true,
      // Corrige BUG UI 1 : voir le commentaire de doc sur le champ
      // `wideDesktop` ci-dessus pour le raisonnement complet.
      wideDesktop: true,
    });
  }

  if (cells.length === 0) return null;

  return (
    <div className="px-4 pb-5">
      {/* Corrige V72-02 (contre-audit Work, 3e tour) : fond ENTIÈREMENT
          OPAQUE (plus de "/55"), positionné sur la photo de bannière.
          La lisibilité ne doit pas dépendre de la luminosité de la
          photo téléchargée -- voir LanguageSelector.tsx pour le même
          raisonnement. */}
      <div className="rounded-xl border border-gold/25 bg-espresso p-1">
        {/* Mobile : l'adresse sur toute la largeur, téléphone et
            horaires côte à côte. Tablette et ordinateur : trois
            colonnes égales.
            Corrige V73-02 (contre-audit Work, 4e tour) : le libellé
            (ADRESSE/TÉLÉPHONE/HORAIRES) utilisait
            text-highlight-on-ink/80 -- une opacité sur une valeur déjà
            calculée en dégrade la garantie (même raisonnement que
            RestaurantHeader.tsx). Icône aria-hidden inchangée
            (décorative, hors champ WCAG). */}
        <div className="grid grid-cols-2 gap-px sm:grid-cols-4">
          {cells.map((cell) => {
            const inner = (
              <>
                <span aria-hidden className="mt-0.5 shrink-0 text-highlight-on-ink">
                  {cell.icon}
                </span>
                <span className="min-w-0">
                  <span className="block text-[0.6rem] font-semibold uppercase tracking-wider text-highlight-on-ink">
                    {cell.label}
                  </span>
                  <span
                    className={
                      "block text-xs text-ink-text " +
                      (cell.multiline ? "whitespace-pre-wrap" : "truncate sm:whitespace-normal")
                    }
                  >
                    {cell.content}
                  </span>
                </span>
              </>
            );

            // Corrige BUG UI 1 : `wideDesktop` (horaires) obtient toute la
            // largeur sur mobile (comme `wide`/adresse) ET 2 colonnes sur
            // 4 à partir de sm (au lieu d'1 sur 3 auparavant) -- adresse
            // (`wide` seul) ne change pas de comportement : pleine largeur
            // sur mobile, puis retour à 1 colonne à partir de sm.
            const classes =
              "flex items-start gap-2 px-3 py-2 text-left " +
              (cell.wideDesktop
                ? "col-span-2 sm:col-span-2 "
                : cell.wide
                  ? "col-span-2 sm:col-span-1 "
                  : "");

            return cell.href ? (
              <a
                key={cell.key}
                href={cell.href}
                target={cell.href.startsWith("http") ? "_blank" : undefined}
                rel={cell.href.startsWith("http") ? "noopener noreferrer" : undefined}
                aria-label={cell.aria}
                className={classes + "rounded-lg hover:bg-black/10"}
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
