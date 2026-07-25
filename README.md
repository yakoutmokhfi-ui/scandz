# ScanDZ

Menu numérique par QR Code pour restaurants. Premier client pilote :
Illico Presto Coffee (Oran).

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
   - `supabase/seed-temp.sql` (données temporaires `[TEMP]`, à
     remplacer par le menu réel avant production)

3. Copier `.env.example` en `.env.local` et remplir avec l'URL et la
   clé « anon public » du projet Supabase (Settings → API).

4. Lancer :

   ```bash
   npm run dev
   ```

5. Ouvrir http://localhost:3000/r/illico-presto

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
