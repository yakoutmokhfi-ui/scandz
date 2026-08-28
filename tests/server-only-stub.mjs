// PAYMENT P3-A1 — stub TEST-ONLY pour le paquet npm "server-only".
//
// Sous Next.js, `server-only` résout vers son fichier `empty.js`
// (no-op) quand le bundler applique la condition d'export
// "react-server" (compilation d'un vrai Server Component) ; il résout
// vers son fichier `index.js` (qui lève systématiquement) dans tout
// autre contexte -- c'est là tout le mécanisme de garde.
//
// `node --test` brut n'applique JAMAIS la condition "react-server"
// (voir tests/alias-loader.mjs pour la redirection correspondante) :
// sans ce stub, TOUT fichier sous lib/server/ (qui importe
// délibérément "server-only" en tête, mandat §7) échouerait à
// l'import dans nos tests, alors même que le garde-fou fonctionne
// correctement sous le vrai build Next.js (vérifié séparément par
// `npm run build`, qui compile réellement ces fichiers).
//
// Ce fichier n'est JAMAIS utilisé par `next build`/`next dev` : le
// hook qui le charge (tests/alias-loader.mjs) n'est enregistré que par
// tests/register.mjs, jamais par le runtime Next.js lui-même.
export {};
