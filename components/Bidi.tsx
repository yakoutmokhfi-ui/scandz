/**
 * Isole un fragment qui doit toujours se lire de gauche à droite
 * (prix, numéros, adresses latines) à l'intérieur d'une page en
 * écriture droite-à-gauche.
 *
 * Sans cette isolation, l'algorithme bidirectionnel d'Unicode
 * réordonne visuellement les chiffres et la ponctuation :
 * « 350 DA » devient « DA 350 », « +213 41 55 » devient « 55 41 213+ ».
 */
export default function Ltr({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <bdi dir="ltr" className={`inline-block ${className}`}>
      {children}
    </bdi>
  );
}
