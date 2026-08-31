/** @type {import('next').NextConfig} */
const nextConfig = {
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
