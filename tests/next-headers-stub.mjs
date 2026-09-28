// LOT 1 (P0, cookie-path fix) — stub TEST-ONLY pour le paquet
// "next/headers" (uniquement `cookies()`, seule fonction de ce module
// utilisée par du code de production dans ce dépôt à ce jour).
//
// Sous le vrai runtime Next.js, `cookies()` lit le magasin de cookies
// de la requête HTTP en cours via l'AsyncLocalStorage interne que
// Next.js peuple lui-même avant d'invoquer un Server Component ou un
// route handler. `node --test` brut n'exécute JAMAIS ce cycle de
// requête Next.js : appeler `cookies()` tel quel hors de ce contexte
// lève systématiquement `Error: cookies was called outside a request
// scope` (vérifié empiriquement dans ce dépôt) — CE QUI EXPLIQUE
// POURQUOI aucun test direct de app/track/[orderId]/withdrawal/
// route.ts (qui LIT un cookie entrant via cookies().get(...), à la
// différence de app/api/track/exchange/route.ts qui ne fait qu'ÉCRIRE
// via NextResponse.cookies.set(...) sur la réponse qu'il construit
// lui-même) n'existait avant ce lot — c'est la même classe de lacune
// de couverture que le bug de portée de cookie que ce lot corrige.
//
// Ce stub reproduit fidèlement la forme minimale utilisée par le code
// de production (`(await cookies()).get(name)?.value`) : le test
// contrôle le contenu du magasin simulé via `globalThis.__mockCookieStore`
// (un objet `{ [nomDuCookie]: valeur }`, EXACTEMENT ce qu'un
// `SimpleCookieJar` de test — voir tests/v123c-tracking-multiorder-
// cookie-isolation.dom.test.ts pour l'algorithme RFC 6265 §5.1.4 de
// correspondance de chemin déjà établi dans ce dépôt — calculerait
// pour le chemin de requête simulé), jamais une valeur codée en dur
// dans ce stub lui-même.
//
// Ce fichier n'est JAMAIS utilisé par `next build`/`next dev` : le
// hook qui le charge (tests/alias-loader.mjs) n'est enregistré que par
// tests/register.mjs, jamais par le runtime Next.js lui-même — même
// garantie exacte que tests/server-only-stub.mjs.
export async function cookies() {
  const store = globalThis.__mockCookieStore ?? {};
  return {
    get(name) {
      return name in store ? { name, value: store[name] } : undefined;
    },
  };
}
