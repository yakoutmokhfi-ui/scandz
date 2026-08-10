# Scanym

Menu numérique par QR Code pour cafés et restaurants.

Établissements en service :

| Slug | Établissement | Mode de service | Devise |
|---|---|---|---|
| `illico-presto` | Illico Presto Coffee (Oran) | commande à table | DZD |
| `sanaa-cookies` | Sanaa Cookies & Fondant (Île-de-France) | retrait / livraison 92-95 | EUR |

Le client scanne un QR Code, consulte le menu, compose son panier,
choisit sa table et envoie sa commande via WhatsApp. Rien d'autre
dans le MVP (voir docs/VISION.md).

## Stack

Next.js (App Router) · React · Tailwind CSS · Supabase (PostgreSQL)

## Démarrage local

1. Installer les dépendances :

   ```bash
   npm install
   ```

2. Créer le projet Supabase puis, dans le SQL Editor, exécuter dans
   l'ordre :
   - `supabase/schema.sql` (schéma canonique — ne pas modifier sans
     validation)
   - `supabase/seed-illico-v2.sql` puis `update-photos.sql` et
     `update-infos.sql` (Illico Presto)
   - `supabase/seed-sanaa.sql` (Sanaa Cookies & Fondant)

3. Copier `.env.example` en `.env.local` et remplir avec l'URL et la
   clé « anon public » du projet Supabase (Settings → API).

4. Lancer :

   ```bash
   npm run dev
   ```

5. Ouvrir http://localhost:3000/r/illico-presto
   ou http://localhost:3000/r/sanaa-cookies

## Déploiement (pilote)

1. Pousser ce dépôt sur GitHub.
2. Sur Vercel : Add New Project → importer le dépôt → renseigner les
   deux variables d'environnement de `.env.example` → Deploy.
3. Tester l'URL temporaire `https://<projet>.vercel.app/r/illico-presto`
   sur téléphone, y compris l'envoi WhatsApp.
4. Seulement après validation complète : connecter le sous-domaine
   OVH dans Vercel (Settings → Domains) puis générer et imprimer le
   QR Code définitif.

## Règles de développement

- Le frontend ne dialogue jamais directement avec Supabase : tout
  passe par `lib/services/restaurant.ts` (`getRestaurantBySlug`).
- Server Components par défaut, `"use client"` uniquement si
  nécessaire (état du panier).
- Aucune modification du schéma de base de données sans validation
  de Yakout et revue du CTO.
- Aucune fonctionnalité hors MVP (pas d'authentification, dashboard,
  paiement, OCR, IA, statistiques, thèmes).


## Générer un QR code

```bash
node scripts/qr.mjs https://votre-domaine/r/le-slug
```

Produit un PNG 2000 px et un SVG vectoriel dans `qr/`. Toujours tester le
scan avec deux téléphones différents avant impression.

## Ajouter un établissement

1. Écrire son script de seed dans `supabase/` (partir de `seed-sanaa.sql`).
2. Déposer ses visuels : `public/banners/<slug>.jpg` et
   `public/photos/<slug>/…`.
3. Déclarer ses réglages dans `lib/restaurants-config.ts` : mode de service
   (table ou retrait/livraison), téléphone, zones livrées, produits à
   options.
4. Déployer, tester sur téléphone, puis générer le QR code.

> Le point 3 impose un déploiement pour chaque nouveau client. C'est une
> dette assumée du MVP : l'évolution proposée est de faire passer ces
> réglages en base (voir l'en-tête de `lib/restaurants-config.ts`).

## V29 - Espace commerçant

1. Run `supabase/migration-v29-merchant-dashboard.sql` in the Supabase SQL Editor.
2. Create merchant users in Supabase Authentication.
3. Link each Auth user to a restaurant in `public.restaurant_users`.
4. Run the isolation procedure in `supabase/tests/v29-isolation-tests.md`.
5. Open `/dashboard/login`.

The dashboard reads orders through RLS and changes status only through
`public.update_order_status`. Receipt printing is available on every order and
uses the per-restaurant `public.receipt_settings` profile (58 or 80 mm).
