# Installation de Scanym V29

## 1. Sauvegarde

Avant toute opération, conserver une copie du projet actuellement publié et exporter la base Supabase.

## 2. Migration Supabase

Dans Supabase SQL Editor, exécuter :

`supabase/migration-v29-merchant-dashboard.sql`

La migration :

- conserve les données existantes ;
- bloque si une valeur de statut incompatible existe ;
- retire l'UPDATE générique sur `orders` ;
- crée la RPC sécurisée `update_order_status` ;
- ajoute la configuration de ticket `receipt_settings` ;
- finalise les RLS commerçant.

Si le script signale une ancienne valeur `served`, ne pas la modifier sans décision fonctionnelle. La migration s'arrête volontairement plutôt que de convertir silencieusement les données.

## 3. Comptes commerçants

Créer les utilisateurs dans Supabase Authentication, puis les rattacher :

```sql
insert into public.restaurant_users (user_id, restaurant_id, role)
values ('AUTH_USER_UUID', 'RESTAURANT_UUID', 'owner')
on conflict do nothing;
```

## 4. Configuration du ticket

Exemple Illico :

```sql
update public.receipt_settings rs
set business_name = 'ILLICO PRESTO COFFEE',
    legal_name = null,
    legal_address = '4 Rue Ferroukhi Mustapha, Oran 31000, Algérie',
    phone = null,
    tax_identifier = null,
    registration_number = null,
    paper_width_mm = 58,
    show_tax_summary = false,
    prices_include_tax = true,
    tax_label = 'TVA',
    default_tax_rate = 0,
    footer_text = 'Merci de votre visite'
from public.restaurants r
where r.id = rs.restaurant_id
  and r.slug = 'illico-presto';
```

La TVA peut être activée plus tard par établissement. Cette V29 produit un ticket de commande configurable ; elle ne prétend pas remplacer un dispositif fiscal certifié lorsqu'un pays l'impose.

## 5. Tests d'isolation

Suivre intégralement :

`supabase/tests/v29-isolation-tests.md`

Le dashboard ne doit être utilisé en production qu'après succès symétrique des comptes Illico et Sanaa.

## 6. Lancement

```bash
npm install
npm run build
npm run dev
```

Pages :

- connexion : `/dashboard/login`
- commandes : `/dashboard`

## 7. Impression

Le bouton `Imprimer` ouvre le dialogue d'impression du navigateur avec une mise en page 58 ou 80 mm. Sur téléphone ou tablette, l'imprimante doit être reconnue par le système ou par une application d'impression compatible.
