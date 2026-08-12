/**
 * Placeholder produit sans photo (V67b).
 *
 * Un seul composant SVG statique et réutilisable — jamais un fichier
 * uploadé par produit, jamais une URL factice écrite dans
 * `menu_items.image_url` (qui doit rester `null` tant qu'aucune vraie
 * photo n'existe : c'est ce qui permet à MenuItemCard de savoir qu'il
 * faut afficher ce placeholder plutôt qu'une image). Glyphe neutre
 * (image de paysage générique), pas un objet spécifique à la
 * restauration : reste pertinent pour un café, une fromagerie, ou un
 * futur type de commerce. Aucune image générée par IA.
 */
export default function ProductPhotoPlaceholder({
  className = "",
}: {
  className?: string;
}) {
  return (
    <div
      role="img"
      aria-hidden="true"
      className={`flex items-center justify-center bg-espresso/5 text-espresso/20 ${className}`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="h-1/3 w-1/3"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
    </div>
  );
}
