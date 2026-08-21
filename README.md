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

- Le frontend ne dialogue jamais directement avec Supabase depuis un
  composant : chaque surface a son propre service dédié qui
  centralise ces appels (`lib/services/restaurant.ts` pour la carte
  publique — `getRestaurantBySlug` ; `lib/services/dashboard.ts`,
  `lib/services/establishments.ts` et
  `lib/services/establishment-assets.ts` pour le tableau de bord
  commerçant, la création d'établissement et l'identité visuelle).
- Server Components par défaut, `"use client"` uniquement si
  nécessaire (état du panier).
- Aucune modification du schéma de base de données sans validation
  de Yakout et revue du CTO.
- Hors MVP client (paiement, OCR, IA, statistiques) : le tableau de
  bord commerçant (authentification, réglages, photos, identité
  visuelle) et l'outil interne de création d'établissement existent
  bel et bien depuis V29 et le Lot D — voir les sections dédiées
  ci-dessous.


## Générer un QR code

```bash
node scripts/qr.mjs https://votre-domaine/r/le-slug
```

Produit un PNG 2000 px et un SVG vectoriel dans `qr/`. Toujours tester le
scan avec deux téléphones différents avant impression.

## Ajouter un établissement

Depuis le Lot D, la création de l'établissement lui-même (identité,
compte propriétaire, catégorie initiale) passe par l'outil interne
`/admin/establishments/new` (voir section « Lot D » ci-dessus), pas
par un script de seed manuel. Les étapes ci-dessous restent
nécessaires pour les réglages spécifiques au mode de service que Lot D
ne couvre pas (zones livrées, produits à options) :

1. Compléter ses réglages de service dans `lib/restaurants-config.ts` :
   mode de service (table ou retrait/livraison), téléphone, zones
   livrées, produits à options.
2. Déposer ses visuels statiques restants si besoin : `public/banners/<slug>.jpg`
   (logo/cover passent désormais par Supabase Storage, voir section
   « Storage » ci-dessous).
3. Déployer, tester sur téléphone, puis générer le QR code.

> L'étape 1 impose encore un déploiement pour chaque nouveau client.
> C'est une dette assumée : l'évolution proposée est de faire passer
> ces réglages en base (voir l'en-tête de `lib/restaurants-config.ts`).

## V29 - Espace commerçant

1. Run `supabase/migration-v29-merchant-dashboard.sql` in the Supabase SQL Editor.
2. Create merchant users in Supabase Authentication.
3. Link each Auth user to a restaurant in `public.restaurant_users`.
4. Run the isolation procedure in `supabase/tests/v29-isolation-tests.md`.
5. Open `/dashboard/login`.

The dashboard reads orders through RLS and changes status only through
`public.update_order_status`. Receipt printing is available on every order and
uses the per-restaurant `public.receipt_settings` profile (58 or 80 mm).

## Lot D — Création interne d'établissement

Outil interne réservé aux opérateurs Scanym (`scanym_operators` /
`is_scanym_operator()`, table alimentée manuellement par le CTO) :
`/admin/establishments/new`. Crée un établissement en statut
`onboarding`, avec une invitation propriétaire explicite (jamais de
compte Supabase Auth ni de mot de passe créés automatiquement — voir
`supabase/migration-lotd-establishment-creation.sql`). Le rattachement
réel a lieu une fois le compte du propriétaire créé manuellement par
le CTO, via `link_pending_owner`. Ne remplace pas l'étape 3 ci-dessus
pour les réglages spécifiques au mode de service
(`lib/restaurants-config.ts`), qui reste hors du périmètre de cet
outil.

## Storage — photos & identité visuelle

Deux buckets Supabase Storage distincts, chacun avec ses propres
policies `storage.objects` — jamais partagées entre les deux :

| Bucket | Portée | Chemin | Policies | Migration |
|---|---|---|---|---|
| `product-photos` | Une photo par produit du catalogue | `{restaurant_id}/{product_id}/{fichier}` | `product_photos_select\|insert\|update\|delete_own_restaurant` — owner/manager du restaurant propriétaire du produit | `supabase/migration-v67-product-photos.sql` |
| `establishment-assets` | Logo et cover de l'établissement (portée globale, pas par produit) | `{restaurant_id}/{logo\|cover}/{fichier}` | `establishment_assets_select\|insert\|update\|delete_authorized` — owner/manager du restaurant, **ou** tout opérateur Scanym (`scanym_operators` / `is_scanym_operator()`), pour n'importe quel établissement | `supabase/migration-v68-establishment-assets.sql` |

Les deux buckets sont publics en lecture (menu public consulté sans
authentification, via QR code) ; l'écriture, elle, n'est jamais
publique — réservée par policy au(x) rôle(s) ci-dessus, jamais à
`anon`. Le nom de fichier stocké n'est jamais dérivé de l'entrée
utilisateur (`crypto.randomUUID()` côté client), ce qui élimine tout
risque de traversée de chemin, de collision, et tout souci de cache
lors d'un remplacement.

`restaurant_configs` porte deux colonnes distinctes pour l'identité
visuelle, toutes deux nullables :
- `logo_url` — logo/identité de l'établissement (colonne du schéma
  canonique, inchangée depuis l'origine du projet) ;
- `cover_url` — photo de couverture de la carte publique (V68,
  additive). `NULL` = aucun établissement n'est affecté ; le rendu
  public replie alors sur la bannière statique `/banners/<slug>.jpg`
  existante (`components/RestaurantHeader.tsx`), sans régression.

Écriture exclusivement via RPC dédiées (jamais d'update direct côté
client) : `set_product_photo` pour les photos produit,
`set_restaurant_logo` / `set_restaurant_cover` pour l'identité
d'établissement — voir `lib/services/product-photo.ts` et
`lib/services/establishment-assets.ts`.

`restaurant_configs` porte aussi trois couleurs personnalisées
(`primary_color`/`secondary_color`/`accent_color`, format `#RRGGBB`
strict, V69) et un lien de localisation externe (`maps_url`, HTTPS
uniquement, V69/V70) — écriture via `update_restaurant_colors` /
`update_restaurant_maps_url`. `maps_url` est volontairement
indépendant de tout fournisseur (pas seulement Google) : absent,
aucun lien n'est fabriqué automatiquement depuis
latitude/longitude — ces coordonnées restent des données neutres,
et la carte publique n'affiche simplement pas de bouton
« Itinéraire » (voir `components/RestaurantHeader.tsx` et
`components/RestaurantInfoBar.tsx`).
