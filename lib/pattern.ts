/**
 * Motifs géométriques de fond, inspirés du zellige maghrébin.
 *
 * Tracés en SVG plutôt qu'en image : environ 0,5 ko, nets sur tout
 * écran, et colorés par les variables du thème. Ils ne sont jamais
 * posés derrière du texte — uniquement en fond de bannière et de
 * page, sous les cartes.
 */
export type PatternName = "girih" | "zellige" | "diamond" | "none";

function toUrl(svg: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** Étoile à huit branches, motif zellige classique. */
export function zelligeUrl(color: string, opacity = 0.09): string {
  return toUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 60 60">` +
      `<g fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="1.2">` +
      `<path d="M30 2 L58 30 L30 58 L2 30 Z"/>` +
      `<path d="M30 14 L46 30 L30 46 L14 30 Z"/>` +
      `<path d="M0 0 L14 14 M60 0 L46 14 M0 60 L14 46 M60 60 L46 46"/>` +
      `<circle cx="30" cy="30" r="4"/>` +
      `</g></svg>`
  );
}


/**
 * Entrelacs à huit branches, motif girih maghrébin.
 *
 * Étoiles à chaque nœud d'un maillage carré, reliées par des
 * segments continus : le tracé se raccorde d'une tuile à l'autre
 * sans rupture visible.
 */
export function girihUrl(color: string, opacity = 0.1): string {
  return toUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80">` +
      `<g fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="1.4">` +
      `<path d="M25.6 0.0 L10.9 4.5 L18.1 18.1 L4.5 10.9 L0.0 25.6 L-4.5 10.9 L-18.1 18.1 L-10.9 4.5 L-25.6 0.0 L-10.9 -4.5 L-18.1 -18.1 L-4.5 -10.9 L-0.0 -25.6 L4.5 -10.9 L18.1 -18.1 L10.9 -4.5 Z M105.6 0.0 L90.9 4.5 L98.1 18.1 L84.5 10.9 L80.0 25.6 L75.5 10.9 L61.9 18.1 L69.1 4.5 L54.4 0.0 L69.1 -4.5 L61.9 -18.1 L75.5 -10.9 L80.0 -25.6 L84.5 -10.9 L98.1 -18.1 L90.9 -4.5 Z M25.6 80.0 L10.9 84.5 L18.1 98.1 L4.5 90.9 L0.0 105.6 L-4.5 90.9 L-18.1 98.1 L-10.9 84.5 L-25.6 80.0 L-10.9 75.5 L-18.1 61.9 L-4.5 69.1 L-0.0 54.4 L4.5 69.1 L18.1 61.9 L10.9 75.5 Z M105.6 80.0 L90.9 84.5 L98.1 98.1 L84.5 90.9 L80.0 105.6 L75.5 90.9 L61.9 98.1 L69.1 84.5 L54.4 80.0 L69.1 75.5 L61.9 61.9 L75.5 69.1 L80.0 54.4 L84.5 69.1 L98.1 61.9 L90.9 75.5 Z M65.6 40.0 L50.9 44.5 L58.1 58.1 L44.5 50.9 L40.0 65.6 L35.5 50.9 L21.9 58.1 L29.1 44.5 L14.4 40.0 L29.1 35.5 L21.9 21.9 L35.5 29.1 L40.0 14.4 L44.5 29.1 L58.1 21.9 L50.9 35.5 Z"/>` +
      `<path d="M18.1 18.1 L21.9 21.9 M61.9 18.1 L58.1 21.9 M18.1 61.9 L21.9 58.1 M61.9 61.9 L58.1 58.1 M25.6 0.0 L54.4 0.0 M25.6 80.0 L54.4 80.0 M0.0 25.6 L0.0 54.4 M80.0 25.6 L80.0 54.4"/>` +
      `</g></svg>`
  );
}

/** Variante plus sobre : losanges espacés. */
export function diamondUrl(color: string, opacity = 0.07): string {
  return toUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">` +
      `<g fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="1">` +
      `<path d="M20 6 L34 20 L20 34 L6 20 Z"/>` +
      `</g></svg>`
  );
}

export function patternUrl(
  name: PatternName | undefined,
  color: string,
  opacity?: number
): string | undefined {
  if (name === "girih") return girihUrl(color, opacity);
  if (name === "zellige") return zelligeUrl(color, opacity);
  if (name === "diamond") return diamondUrl(color, opacity);
  return undefined;
}
