# Preuves navigateur (hors `npm test`)

`npm test` ne lance que `tests/*.test.ts` (node:test + jsdom). Les scripts de ce dossier pilotent un
**vrai Chromium** (Playwright) contre un build de production de l'application, branché sur un
**faux Supabase local** (`stub-supabase.mjs`, RPC de suivi uniquement). Données 100 % synthétiques :
aucune base, commande, paiement ou e-mail réels.

## `tracking-no-manual-refresh-210.mjs` (issue #210)

Prouve que le suivi s'affiche dès l'ouverture du lien (sans « Actualiser »), puis suit les
changements de statut : première ouverture (lien e-mail), réouverture, page ouverte, retour de
focus / d'onglet, autre appareil, session absente, retour arrière, lien legacy one-shot, panne puis
reprise, état terminal (arrêt du polling), deux commandes, capacité expirée / invalide. Il vérifie
aussi qu'aucune capacité n'apparaît dans une URL, un en-tête, la console ou le stockage JS.

Pourquoi un vrai navigateur : un routeur `next/navigation` mocké compte des `router.refresh()` mais
ne voit pas que le vrai routeur Next.js **annule** un `refresh()` lancé juste après un
`history.replaceState` (`net::ERR_ABORTED`).

```bash
# 1. build + démarrage de l'application, branchée sur le faux Supabase (port 54399)
export NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54399 NEXT_PUBLIC_SUPABASE_ANON_KEY=synthetic \
       SUPABASE_SERVICE_ROLE_KEY=synthetic TRACKING_SESSION_SECRET=$(openssl rand -hex 32)
npm run build && npx next start -p 3100 -H 127.0.0.1 &

# 2. le script démarre lui-même le faux Supabase
APP_URL=http://127.0.0.1:3100 npm run test:browser:tracking
```

Prérequis : Playwright + Chromium résolvables (`PLAYWRIGHT_RESOLVE_FROM=<dossier>` si installés ailleurs).
`ONLY=A,E,K` limite aux scénarios dont l'identifiant (premier mot) est listé.
