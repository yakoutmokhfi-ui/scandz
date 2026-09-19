/**
 * CUSTOMER TAGS DISPLAY (LOT 01) -- pilules des tags PUBLIÉS d'un
 * produit sur la carte client (ex. « Bio », « Truffe »).
 *
 * Lecture seule : aucune interaction, aucun filtre. Rien n'est rendu
 * pour un produit sans tag -- la carte reste alors strictement
 * identique au rendu historique.
 *
 * Accessibilité : une liste (<ul>/<li>) nommée par produit, donc
 * annoncée comme « liste, N éléments » par les lecteurs d'écran.
 * `dir="auto"` : un libellé marchand garde son propre sens d'écriture
 * quelle que soit la langue de l'interface. Mobile-first : les pilules
 * passent à la ligne (flex-wrap), jamais de défilement horizontal.
 * Couleurs : bg-crema + text-accent-dark-on-bg, la même paire calculée
 * que le prix de la carte (contraste garanti, sans opacité Tailwind).
 */
import { dedupeTagLabels } from "@/lib/customer-product-tags";

export default function ProductTags({
  tags,
  label,
}: {
  tags?: string[] | null;
  /** Nom accessible de la liste (lib/i18n.ts: productTagsAria). */
  label: string;
}) {
  const labels = dedupeTagLabels(tags ?? []);
  if (labels.length === 0) {
    return null;
  }

  return (
    <ul aria-label={label} data-product-tags="true" className="mt-1 flex flex-wrap gap-1">
      {labels.map((tag) => (
        <li
          key={tag}
          dir="auto"
          className="whitespace-nowrap rounded-full border border-current bg-crema px-2 py-0.5 text-xs font-semibold text-accent-dark-on-bg"
        >
          {tag}
        </li>
      ))}
    </ul>
  );
}
