// ISSUE #159 — URL publique courte d'un commerçant.
//
// `https://shop.scanym.com/au-lait-cru` sert la page commerçant qui vit
// historiquement sur `/r/au-lait-cru` (app/r/[slug]). Mécanisme retenu :
// une RÉÉCRITURE (rewrite) Next.js, et non une redirection ni une route
// dynamique racine `app/[slug]` :
//   - `/r/au-lait-cru` continue d'être servi tel quel (HTTP 200, aucune
//     redirection) : les liens réellement utilisés dans l'application
//     (bouton « Voir le menu » du dashboard, écran de création et cockpit
//     opérateur, tous bâtis sur `/r/{slug}` pour TOUS les marchands) et les
//     sondes CI/E2E existantes sur d'autres branches en dépendent. Aucun QR
//     code n'a été créé : ce n'est PAS la raison de la conservation ;
//   - l'URL affichée dans la barre d'adresse reste `/au-lait-cru` ;
//   - la chaîne de requête (`?lang=…`, `?utm_…`) est transmise telle
//     quelle à la destination (comportement natif des rewrites) ;
//   - AUCUN motif générique : une entrée = un chemin exact, un slug
//     explicitement listé ci-dessous. Une route racine `[slug]` (catch-all)
//     masquerait `/dashboard`, `/api`, `/checkout`, `/track`, `/legal`,
//     `/admin`, les assets statiques, etc. — ce que le mandat interdit ;
//   - rewrite « afterFiles » (tableau simple) : un fichier réel de `public/`
//     ou une page `app/` de même chemin garde la priorité ; la règle ne
//     peut donc jamais intercepter une route existante.
// Le slug lui-même est résolu par `getRestaurantBySlug` dans le handler
// existant : un slug sans commerçant actif y donne le 404 habituel
// (app/r/[slug]/not-found.tsx). Aucune donnée ni configuration commerçant
// n'est touchée. Ajouter un alias = ajouter UNE entrée ici (+ le test).
export const PUBLIC_SLUG_ALIASES = Object.freeze(["au-lait-cru"]);

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return PUBLIC_SLUG_ALIASES.map((slug) => ({
      source: `/${slug}`,
      destination: `/r/${slug}`,
    }));
  },

  // CUSTOMER TRACKING EXPERIENCE v2 — mandat §21 : la page de suivi
  // client (/track/[orderId]) affiche du contenu PRIVÉ par possession
  // de session -- elle ne doit jamais être indexée, jamais mise en
  // cache (CDN/navigateur), et ne doit jamais transmettre de Referer
  // lors d'une navigation sortante éventuelle.
  //
  // Appliqué ici (next.config.mjs), et non dans un `middleware.ts` :
  // ce dépôt ne contient AUCUN middleware (vérifié par inspection --
  // voir CURRENT-TRACKING-STATE-REPORT.txt), et une règle de headers
  // STATIQUE par motif de chemin, déjà nativement supportée par
  // Next.js, est strictement suffisante ici.
  //
  // `export const metadata.robots` (app/track/[orderId]/page.tsx)
  // fournit déjà le noindex au niveau HTML (balise <meta
  // name="robots">) -- `X-Robots-Tag` ci-dessous en est le double AU
  // NIVEAU EN-TÊTE HTTP (ceinture et bretelles).
  async headers() {
    return [
      {
        source: "/track/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
      // Mandat §21, "Preserve or improve" : le point de terminaison
      // d'échange (app/api/track/exchange/route.ts) transporte le
      // SEUL appel réseau explicite portant `public_token` (dans son
      // corps POST, jamais son URL) -- il reçoit la même discipline
      // no-store/no-referrer que la page elle-même, en profondeur,
      // même si une API JSON n'est de toute façon jamais indexée par
      // un robot (X-Robots-Tag omis ici, sans objet pour une réponse
      // JSON non-HTML).
      {
        source: "/api/track/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
