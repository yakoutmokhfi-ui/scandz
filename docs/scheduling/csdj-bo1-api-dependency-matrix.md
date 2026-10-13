# CSDJ-BO-1 — MATRICE EXACTE DES DÉPENDANCES D'API

Chaque contrôle de l'onglet « Mise à disposition », la fonction serveur
qui le porte, sa signature **exacte**, son accord de droits, et son état
de livraison. Rien n'est supposé : les signatures sont relevées dans le
SQL, pas dans une documentation.

**Sources, et elles sont deux** :

- `supabase/DRAFT-lot-checkout-scheduling-foundation-v1.sql` sur `main`
  après PR #145 (`03441a5`) — **APPLIQUÉ** à Supabase PROD.
- `supabase/DRAFT-lot-checkout-scheduling-calendars-capacity-v1-2.sql`
  sur `feature/csdj-v1.2-scheduling-engine` (PR #146, tête `afbee37`) —
  **LIVRÉ, NON APPLIQUÉ** : branche ouverte, non fusionnée, migration
  non passée. Lue, jamais modifiée par ce lot.

**Trois états, et jamais deux** :

| Marque | Sens |
|---|---|
| ● APPLIQUÉ | la fonction existe en PROD et répond aujourd'hui |
| ◐ LIVRÉ, NON APPLIQUÉ | écrite et testée dans la PR #146 ; **absente** du serveur tant que la migration n'est pas passée |
| ○ MANQUANT | aucune fonction ne porte ce besoin ; un contrat est demandé (voir `csdj-bo1-write-contract-request.md`) |

---

## 1. Lectures — ce dont la page dépend pour s'afficher

| # | Fonction (signature exacte) | Droits | État | Utilisée par | Si absente / en échec |
|---|---|---|---|---|---|
| L1 | `public.get_merchant_fulfillment_schedules(p_restaurant_id uuid)` → table de **15 colonnes** : `mode_code text, fulfillment_rule_id uuid, timezone text, enabled boolean, date_selection_mode text, slot_selection_mode text, time_granularity_minutes smallint, lead_time_minutes integer, min_lead_days smallint, cutoff_time time, cutoff_offset_days smallint, booking_horizon_days smallint, windows jsonb, slots jsonb, closures jsonb` | `execute` à `authenticated` ; corps : `auth.uid()` non nul **et** (`is_member_of()` **ou** `is_scanym_operator()`) | ● APPLIQUÉ | §1 portées, bandeau de portée, §2 délais, §3 dates et créneaux, §4 fermetures client | **Dépendance dure.** La page affiche un message sûr (`avLoadFailed`, ou `avAuthRequired` / `avForbidden` selon le refus nommé) et aucune donnée. Jamais de SQLSTATE, de nom de fonction ni d'identifiant affiché. |
| L2 | `public.get_merchant_fulfillment_schedules_v12(p_restaurant_id uuid)` → table de **10 colonnes** : `mode_code text, fulfillment_rule_id uuid, schedule_method_version text, holiday_calendar_id uuid, preparation_on_holidays text, availability_on_holidays text, capacity_enabled boolean, capacity_max_orders integer, preparation_weekdays jsonb, preparation_closures jsonb` | `execute` à `authenticated` ; corps : `auth.uid()` non nul **et** (`is_member_of()` **ou** `is_scanym_operator()`) | ◐ LIVRÉ, NON APPLIQUÉ | §2 jours de préparation, §4 fermetures d'atelier et politiques fériées, §5 capacité, badge de méthode | **Dépendance molle, et c'est l'état normal aujourd'hui.** `PGRST202` / `42883` est traduit en statut `absent` : la page reste entière, les contrôles v1.2 s'affichent en lecture avec la mention « livré, pas encore actif sur ce serveur » (`avV12NotDeployed`). Un refus de rôle donne `forbidden`, tout autre échec `error` (`avV12ReadFailed`). **Jamais annoncés comme opérationnels.** |
| L3 | `public.get_checkout_fulfillment_schedule(p_restaurant_id uuid, p_mode_code text, p_postal_code text default null, p_total_count integer default 0, p_subtotal numeric default null)` → table de **19 colonnes** dont `schedule_status text, unfulfillable_reason text, schedule_timezone text, date_selection_mode text, slot_selection_mode text, time_granularity_minutes smallint, first_eligible_date date, eligible_dates date[], offers jsonb` | `execute` à `anon` **et** `authenticated` (lecture publique sûre) | ● APPLIQUÉ | §6 aperçu serveur | Message sûr `avPreviewFailed`, aucun réglage touché. L'aperçu est la seule partie de la page qui appelle le serveur à la demande. |
| L4 | Contexte, et ce ne sont pas tous des RPC : lecture de table `restaurant_users` avec `restaurants(id, name, slug)` (service `getMerchantRestaurants`, RLS) ; RPC `public.is_scanym_operator()` ; RPC `public.get_establishment_summary(p_restaurant_id uuid)` ; lecture de table `restaurant_configs` pour `staff_receipt_language` (service `getRestaurantSettings`, RLS) | inchangés | ● APPLIQUÉ | contexte d'établissement, rôle, langue d'affichage | Aucune nouvelle dépendance : ce sont exactement les quatre sources déjà utilisées par les autres onglets. La langue est un appel « best effort » : son échec replie sur le français et ne bloque jamais l'affichage des règles. |

### Notes de lecture qui ont changé le dessin

- **L1 et L2 sont deux lectures, pas une.** L2 ne remplace pas L1 : elle
  ne rend que les extensions. La page fait donc **deux** appels en
  parallèle et les commite **ensemble** (une seule garde de provenance),
  pour qu'il n'existe aucun rendu où les extensions d'une portée
  s'affichent à côté de la politique d'une autre.
- **Les agrégats n'ont pas la même convention de nommage.** L1 et L2
  rendent du **camelCase** dans leurs JSONB (`{weekday, startsAt,
  endsAt}`, `{closedOn, label}`) ; L3 rend ses offres en **snake_case**
  (`{slot_key, starts_at, ends_at}`), regroupées par date. Les deux
  conventions sont reprises telles quelles, sans renommage.
- **L3 n'a aucun paramètre de règle de livraison.** Vérifié dans le SQL
  appliqué : la zone est dérivée du **code postal** via
  `resolve_delivery_fulfillment`. Prévisualiser par code postal n'est
  donc pas un pis-aller, c'est le seul chemin fidèle au client — et
  c'est aussi pourquoi aucune prévisualisation ciblant une règle n'est
  demandée.
- **L3 n'accepte aucune heure de l'appelant** : l'aperçu est calculé à
  l'horloge du serveur, et la page ne peut pas mentir sur « maintenant ».

---

## 2. Écritures — ce dont la page dépendra, et qui n'est pas disponible

| # | Besoin | Ce qui existe | État pour CSDJ-BO-1 | Conséquence dans le code |
|---|---|---|---|---|
| W1 | Enregistrer une portée **entière** en une transaction (politique + listes + préparation + fériés + capacité + activation) | rien | ○ MANQUANT — contrat demandé : `public.save_fulfillment_configuration(p_restaurant_id uuid, p_payload jsonb) returns jsonb` | `CSDJ_BO1_WRITE_CONTRACT.available === false`. **Aucun site d'appel d'écriture n'existe** dans `app/dashboard/availability/page.tsx` ni dans `lib/services/availability.ts` ; tout contrôle d'écriture et d'activation est `disabled` avec sa raison écrite. |
| W2 | Écritures par action, telles qu'elles existent | `public.mutate_merchant_fulfillment_schedule(p_restaurant_id uuid, p_action text, p_payload jsonb) returns void` — 5 actions : `save_schedule`, `delete_schedule`, `replace_windows`, `replace_slots`, `replace_closures` ; `execute` à `authenticated`, corps `has_role_in(restaurant, ['owner','manager'])` ; verrou consultatif de tenant (graine 1104) ; 12 refus nommés | ● APPLIQUÉ mais **DÉLIBÉRÉMENT NON UTILISÉ** | Refusé comme garantie d'enregistrement par le CTO : jusqu'à six appels, chacun atomique, aucune atomicité entre eux. Les trois fenêtres de défaillance sont nommées au §1.2 de la demande de contrat. |
| W3 | Écritures v1.2 par action | `public.mutate_merchant_fulfillment_schedule_v12(p_restaurant_id uuid, p_action text, p_payload jsonb) returns void` — 3 actions : `save_schedule_v12`, `replace_prep_days`, `replace_prep_closures` ; mêmes droits, même verrou (graine 1104) ; 20 refus nommés | ◐ LIVRÉ, NON APPLIQUÉ et **NON UTILISÉ** | Idem W2, plus : la fonction n'existe pas encore sur le serveur. |
| W4 | Supprimer une portée | action `delete_schedule` de W2 | ● APPLIQUÉ mais **NON OFFERT** | Décision R2 point 7 : la désactivation, jamais la suppression. Aucun bouton de suppression n'est rendu ; l'action reste dans le contrat serveur, sans chemin d'accès depuis l'interface. |

### Pièges d'écriture relevés dans le code, à ne pas reproduire quand W1 arrivera

1. **L'action v1 de politique casse une portée v1.2.** `save_schedule`
   n'écrit pas `schedule_method_version`, mais réécrit
   `cutoff_offset_days` (défaut **1**) ; sur une portée v1.2 la
   contrainte `rfs_v12_no_cutoff_offset` la rejette. Une portée en
   méthode v1.2 doit donc être écrite par la porte v1.2 — jamais par le
   formulaire v1. La page ne montre d'ailleurs le champ de décalage
   qu'en méthode v1.
2. **Aucune dérogation opérateur sur l'écriture.** `has_role_in(…,
   ['owner','manager'])` ne consulte pas `is_scanym_operator()` —
   contrairement à l'onglet « Tarifs de livraison », où l'opérateur peut
   écrire. Copier son `canEdit = isOperator || …` promettrait ici une
   écriture que le serveur refuse : `canWriteFulfillmentSchedules`
   ignore donc volontairement `isOperator`, et l'opérateur voit un
   bandeau de lecture qui le dit (`avOperatorReadOnly`).
3. **Le zéro UUID est une sentinelle interne** (`rule_key`), refusée
   comme identifiant de règle : `CSDJ1_RESERVED_RULE_ID`. La page ne
   l'émet jamais — une portée de mode porte `fulfillmentRuleId: null`.
4. **731 fermetures d'atelier au plus** par portée
   (`CSDJ12_TOO_MANY_CLOSURES`), soit deux ans.

---

## 3. Ce que la page n'appelle pas, et n'appellera pas

| Fonction | Droits | Pourquoi elle est hors d'atteinte |
|---|---|---|
| `public.resolve_fulfillment_schedule(uuid, text, uuid, timestamptz)` | **révoquée de tous les rôles applicatifs** | Autorité interne d'éligibilité. La page passe par la lecture publique L3, comme un client. |
| `public.resolve_fulfillment_schedule_v12(uuid, text, uuid, timestamptz, boolean)` | révoquée (PR #146) | idem. |
| `public.fulfillment_capacity_used(uuid, text, uuid, date, text)` | révoquée (PR #146) | **Le compteur de remplissage n'est accordé à aucun rôle applicatif.** Cette page ne peut donc afficher ni « 8/12 » ni « complet », et le dit explicitement (`avCapacityNoMerchantCounts`). Un tableau de bord de remplissage serait un ajout de contrat, pas un réglage d'interface. |
| `public.reserve_fulfillment_capacity(uuid, uuid, text, uuid, date, text, timestamptz)` | révoquée (PR #146) | Seule autorité transactionnelle de capacité, appelée **dans** la transaction de création de commande. Hors périmètre d'un back-office. |
| `public.release_fulfillment_capacity(uuid)` | révoquée (PR #146) | Existe, n'est branchée nulle part : la politique de libération sur échec de paiement est une décision CIO ouverte. |
| `lib/scheduling/eligibility.ts` (TypeScript) | — | Oracle de **test**, pas une autorité : son import depuis `app/` ou `components/` fait échouer `tests/csdj1-sql-structural.test.ts` (`[NO-CLIENT-AUTHORITY-1]`). Aucune éligibilité n'est calculée côté client. |

---

## 4. Résumé exécutif de la dépendance

- **La page fonctionne aujourd'hui** en lecture et en aperçu, sur le
  seul socle **appliqué** (L1, L3, L4).
- **Les contrôles v1.2** (préparation, fériés, capacité) dépendent de
  **L2**, qui est absente du serveur : ils sont affichés en lecture,
  marqués livrés-non-appliqués, et n'affirment rien d'opérationnel.
- **L'enregistrement dépend de W1, qui n'existe pas.** Il n'est ni
  simulé, ni approximé par une séquence d'appels : il est absent, et la
  page le dit à l'endroit où le commerçant le cherche.
