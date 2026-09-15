import type { ReactNode } from "react";
import type { RestaurantFull } from "@/lib/types";
import { getSettings } from "@/lib/restaurants-config";
import { useI18n } from "@/lib/i18n-context";
import Ltr from "@/components/Bidi";
import { ClockIcon, PhoneIcon, PinIcon } from "@/components/Icons";

/**
 * Bandeau d'informations, intégré au bas de la bannière. Fond sombre
 * opaque : la photo reste visible dessous, la lisibilité ne dépend
 * jamais de sa luminosité (voir V72-02 plus bas).
 *
 * Toutes les valeurs proviennent des données de l'établissement —
 * aucune adresse, aucun numéro et aucun horaire n'est codé en dur.
 *
 * CUSTOMER INFO CARD / ADDRESS-HOURS REMEDIATION v1.1 — remplace
 * l'ancienne grille responsive (Adresse/Téléphone/Horaires côte à côte
 * dès `sm`, jusqu'à 3-4 colonnes) par un empilement VERTICAL PLEINE
 * LARGEUR, identique sur mobile, tablette ET ordinateur (mandat,
 * littéral : "Do not switch back to a two-column layout on larger
 * screens"). Adresse en premier, Horaires DIRECTEMENT en dessous
 * (mandat : "Address first. Opening hours directly below.") — le
 * téléphone (non mentionné par le mandat, mais dont la disparition
 * romprait une fonctionnalité existante) est conservé, affiché APRÈS
 * les horaires plutôt qu'entre adresse et horaires, pour respecter cet
 * ordre littéral sans supprimer aucune donnée affichée. Chaque champ
 * occupe systématiquement 100% de la largeur de la carte — plus de
 * `truncate` sur l'adresse (elle peut désormais s'enrouler
 * naturellement, mandat §6), plus de grille CSS ni de `col-span`.
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
    /** Réservé aux horaires : les retours à la ligne réellement saisis
     *  (possibles depuis le passage à un <textarea> côté Dashboard)
     *  doivent être préservés visuellement. */
    multiline?: boolean;
  }[] = [];

  // CUSTOMER INFO CARD / ADDRESS-HOURS REMEDIATION v1.1 -- ordre de
  // construction volontairement Adresse PUIS Horaires PUIS Téléphone
  // (jamais Adresse/Téléphone/Horaires comme avant ce lot), pour que
  // les Horaires apparaissent TOUJOURS directement sous l'Adresse dans
  // le DOM, quels que soient les champs présents ou absents pour cet
  // établissement (mandat, littéral : "Address first. Opening hours
  // directly below.").
  if (config.address) {
    cells.push({
      key: "address",
      icon: <PinIcon />,
      label: t("labelAddress"),
      content: <Ltr>{config.address}</Ltr>,
      href: mapsUrl ?? undefined,
      aria: mapsUrl ? t("ariaOpenMaps", { name: restaurant.name }) : undefined,
    });
  }
  if (hoursContent) {
    cells.push({
      key: "hours",
      icon: <ClockIcon />,
      label: t("labelHours"),
      content: hoursContent,
      multiline: true,
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

  if (cells.length === 0) return null;

  return (
    <div className="px-4 pb-5">
      {/* Corrige V72-02 (contre-audit Work, 3e tour) : fond ENTIÈREMENT
          OPAQUE (plus de "/55"), positionné sur la photo de bannière.
          La lisibilité ne doit pas dépendre de la luminosité de la
          photo téléchargée — voir LanguageSelector.tsx pour le même
          raisonnement. */}
      <div className="rounded-xl border border-gold/25 bg-espresso p-1">
        {/* CUSTOMER INFO CARD / ADDRESS-HOURS REMEDIATION v1.1 --
            empilement vertical `flex flex-col` (jamais une grille CSS
            à colonnes) : chaque champ occupe systématiquement 100% de
            la largeur de la carte, sur mobile, tablette ET ordinateur
            -- aucune classe `sm:`/`md:`/`lg:` ne réintroduit de
            disposition en colonnes (mandat, littéral : "Do not switch
            back to a two-column layout on larger screens"). Corrige
            V73-02 (contre-audit Work, 4e tour) : le libellé
            (ADRESSE/HORAIRES/TÉLÉPHONE) utilise text-highlight-on-ink
            en pleine opacité (jamais une opacité sur une valeur déjà
            calculée, même raisonnement que RestaurantHeader.tsx).
            Icône aria-hidden inchangée (décorative, hors champ WCAG). */}
        <div className="flex flex-col divide-y divide-gold/10">
          {cells.map((cell) => {
            const inner = (
              <>
                <span aria-hidden className="mt-0.5 shrink-0 text-highlight-on-ink">
                  {cell.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[0.6rem] font-semibold uppercase tracking-wider text-highlight-on-ink">
                    {cell.label}
                  </span>
                  <span
                    className={
                      "block text-xs text-ink-text " +
                      // Remédiation §6 : l'adresse (et le téléphone)
                      // s'enroulent naturellement sur toute la largeur
                      // désormais disponible -- plus de `truncate`
                      // (qui coupait le texte avec "…" dans l'ancienne
                      // colonne étroite). Les horaires conservent leur
                      // préservation des retours à la ligne saisis.
                      (cell.multiline ? "whitespace-pre-wrap" : "whitespace-normal")
                    }
                  >
                    {cell.content}
                  </span>
                </span>
              </>
            );

            // Pleine largeur systématique : un simple `flex` par ligne,
            // jamais de `col-span`/`grid-cols` à aucun palier.
            const classes = "flex w-full items-start gap-2 px-3 py-2.5 text-left";

            return cell.href ? (
              <a
                key={cell.key}
                href={cell.href}
                target={cell.href.startsWith("http") ? "_blank" : undefined}
                rel={cell.href.startsWith("http") ? "noopener noreferrer" : undefined}
                aria-label={cell.aria}
                className={classes + " rounded-lg hover:bg-black/10"}
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
