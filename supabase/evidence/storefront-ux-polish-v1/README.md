# STOREFRONT UX POLISH v1 — preuves

Micro-lot **présentation uniquement** (GO CIO/Noether). Base `main` `9a49be06e20c0eebdd4f445ad54062677f4f3ca5`.

Garanties du lot :
- aucun SQL, aucune RPC ;
- aucun changement du resolver, de `computeDeliveryFee`, de la formule B5, du checkout ou des snapshots ;
- aucune Production, aucune PREPROD, aucun merge.

## Changements visuels

| Zone | Avant | Après |
|---|---|---|
| Hero (`RestaurantHeader`) | `min-h-[15rem] sm:min-h-[17rem] gap-3 pt-12 pb-6` ; CTA itinéraire et annonce en `mt-2` | `min-h-[12.5rem] sm:min-h-[15rem] gap-2.5 pt-11 pb-4` ; `mt-2` retirés (le `gap` suffit) |
| Carte infos (`RestaurantInfoBar`) | `pb-5` | `pb-4` |
| Ligne réseaux sociaux | `gap-4 pb-4`, glyphes 20 px monochromes | `gap-2 pb-3`, emplacements 40 × 40 |
| Bouton livraison | `mt-4`, `py-3` | `mt-3`, `py-2.5` (`min-h-11` conservé) |
| Collections (tags) | wrapper `mt-6`, rendu même sans collection | wrapper `mt-3`, rendu **seulement** s'il existe des collections |
| Catégories | wrapper `mt-3` ; classique `py-3`, boutons `py-3` | wrapper `mt-1` (avec collections) ou `mt-3` (sans) ; `py-2`, boutons `py-2 min-h-11` |
| 1re section | `mt-7` | `mt-5` |

Mesures (`metrics.json`, Chromium, fixture type Au Lait Cru, 390 px et 1280 px) : la 1re carte produit remonte de **881 → 811 px (−70)**.

## Icônes sociales

- **Instagram** : SVG local (`components/SocialBrandIcons.tsx`).
  - Carré arrondi au dégradé radial de marque `#FEDA75 → #FA7E1E → #D62976 → #962FBF → #4F5BD5`, objectif blanc.
  - `id` de dégradé unique par instance (`useId`).
- **TikTok** : note blanche doublée des échos `#25F4EE` (cyan) et `#FE2C55` (rouge), rendu « fond sombre ».
- **Liens Instagram et TikTok** :
  - `href`, `target="_blank"`, `rel="noopener noreferrer"` et `aria-label` inchangés ;
  - SVG `aria-hidden` ;
  - cible 40 × 40 ;
  - anneau `focus-visible` ;
  - rendus uniquement si l'URL existe.
- Aucun SDK, aucun script, aucune ressource distante.
- **Facebook** inchangé : même lien, même classe, même glyphe. Il est seulement posé dans un emplacement de même largeur pour aligner la ligne.

## Cartouche livraison (`components/DeliveryConditions.tsx`)

**Dialogue « Modes et tarifs de livraison »**, par règle :

| Élément | Contenu |
|---|---|
| Ligne principale | `Codes postaux 75, 92 — 6,90 €`, ou `Autres codes postaux — 18,90 €` pour le repli |
| Ligne courte unique de conditions | `Offerte dès 150,00 € · Min. 3 articles · −50 % dès 100,00 €` |
| Notice marchand | conservée |

- Supprimés : « Zone de livraison N », « Codes postaux / préfixes : », « Tarif de base : » et les phrases longues.
- Le tarif reste calculé par `computeDeliveryFee(…, discountEnabled: false)`, comme avant.

**Dialogue « Livraison — 75013 »** :
- `Disponible — 3,45 €` remplace « Livraison disponible » + « Frais de livraison : 3,45 € » ;
- remise courte, uniquement si la politique publique est activée ;
- notice conservée ;
- tarif indisponible → texte d'indisponibilité, **jamais 0 €** ;
- parcours historique sans frais public → « Livraison disponible » seul, aucun montant inventé.

Ni prestataire ni `fulfillment_code` ne sont rendus. Sept nouvelles clés courtes ont été ajoutées en fr/en/ar ; les clés existantes sont inchangées.

## Tests

- `tests/storefront-ux-polish-v1.dom.test.ts` : 11/11. Sur `main`, les 11 échouent (le test discrimine bien).
- 42 fichiers storefront / menu / livraison existants + ce test : 727/727.
- `rm -f tsconfig.tsbuildinfo && npx tsc --noEmit` : 0.
- Suite complète (`npm test -- --test-concurrency=1`, Linux, Node 22, historique git complet) :
  - base : 4506 tests / 10 échecs ;
  - candidat : 4517 tests / 10 échecs ;
  - identités **identiques** (`suite-*.failures.txt`, normalisées par `supabase/evidence/delivery-pricing-v2-b1/failure-identities.mjs`).
  - La ligne v149 « Scénario 16 » est à 575 des deux côtés.

## Limites

- Les captures utilisent une fixture représentative, pas les données Production d'Au Lait Cru. La bannière est un aplat, faute de photo.
- Le harnais de capture (Playwright, RPC publiques simulées) est resté hors dépôt.
- RTL : la ligne « zone — tarif » est une simple chaîne ; elle n'a pas été capturée en arabe.
