# CSDJ-BO-1 — Remédiation F-02 : invariant d'activation (DRAFT)

> **Statut : DRAFT — NON APPLIQUÉ.** Aucun SQL hébergé, aucun déploiement, aucune
> fusion avant : re-audit en lecture seule de Cat Greco (#150) **puis** GO séparé
> CIO/CTO. `CSDJ_BO1_WRITE_CONTRACT.available` **reste `false`** pour ce lot.
>
> Mandat : DIRAC → BOULEZ, remédiation **F-02** (audit #150, verdict FAIL),
> commentaire CTO sur la PR #151. Parent : `de4600567bcd2be3e3faf7f3bfd44ee7e69a5e2c`
> (non réécrit ; ce lot est un commit enfant).

## 1. Résumé

**F-02 (HIGH, bloquant).** `mutate_merchant_fulfillment_schedule` (v1) et
`mutate_merchant_fulfillment_schedule_v12` restent exécutables par `authenticated`.
Un propriétaire pouvait, par eux, activer une portée (`enabled: true`,
`fixed_slots`) **sans aucun créneau ni jour de préparation**. La RPC
`save_fulfillment_configuration` refuse cette configuration (étape 11) ;
le mutateur historique ne la refusait pas. « L'interface n'appelle que la nouvelle
fonction » n'est pas une frontière de sécurité.

**Fermeture livrée.** Un **invariant porté par les tables**, pas par les appelants :
quatre déclencheurs de contrainte **différés** (`csdjbo1_f02_activation_invariant`),
évalués **au COMMIT sur l'état final**, refusent toute transaction qui laisserait
une portée **active** incomplète, avec le même code que la RPC :
`CSDJBO1_INCOMPLETE_CONFIGURATION` (SQLSTATE `23514`,
`detail = 'blockers=… source=invariant'`). Le refus annule **la transaction entière**
(aucune mutation partielle). Aucune fonction existante, aucune table, aucune donnée
n'est modifiée.

## 2. Inventaire des appelants et des `GRANT`/`EXECUTE`

Recherche exhaustive sur l'arbre du parent `de46005` (hors `node_modules`) :

| Catégorie | Constat |
|---|---|
| Frontend / serveur / jobs sur `main` | **Aucun appel.** Seule mention : le commentaire de `lib/services/availability.ts:63-64`. |
| Interface BO du lot Nougaro (R1) | Non publiée sur GitHub ; selon le contrat elle n'appelle que `save_fulfillment_configuration` / `get_fulfillment_configuration`. Un garde-fou de test (`tests/csdj-bo1-availability-contract.test.ts`) interdit tout `rpc("mutate_merchant_fulfillment_schedule…")` dans `availability.ts`. |
| RPC / routines | Les mutateurs ne sont appelés par aucune autre routine publique du dépôt. Le socle v1 les cite dans ses auto-contrôles (liste de fonctions attendues) et son retour arrière. |
| Tâches `pg_cron` | Aucune dans le dépôt. Le retour arrière du lot BO1 les cherche déjà (`[CRON_JOB]`) ; celui de ce lot aussi. |
| Tests / preuves | Socle v1 (`checkout-scheduling-foundation-v1-check.sh`), harnais BO1, `tests/csdj1-sql-structural.test.ts`, contrats et matrice de dépendances (docs). |
| `GRANT` | Socle v1 : `revoke all … from public, anon; grant execute … to authenticated` (l. 1579-1580). v1.2 : `revoke all … from public, anon, service_role; grant execute … to authenticated` (l. 1688-1690). Ce lot ne modifie aucun de ces `GRANT`/`REVOKE` (prouvé en [F1] : `EXECUTE` inchangé pour `authenticated` et `anon`). |
| Clients PostgREST **externes** | **Inconnus** : un `GRANT` à `authenticated` rend ces fonctions appelables par tout JWT valide ; on ne peut pas prouver qu'aucun client ne les appelle. |

Seule porte de **suppression** d'une portée : l'action `delete_schedule` du
mutateur v1. Elle prend le même verrou de tenant (graine 1104).

## 3. Décision : invariant sur les tables, pas révocation

**Pourquoi pas `REVOKE EXECUTE` aveugle.**

1. Révoquer le mutateur v1 supprimerait aussi `delete_schedule`, qui n'a pas d'autre
   porte : un commerçant ne pourrait plus supprimer une portée.
2. Une révocation **sélective** exigerait d'abord (a) une RPC de suppression dédiée,
   (b) la migration de tous les appelants — dont les clients externes **inconnus** —,
   (c) la modification de fonctions auditées (v1, v1.2), hors périmètre de la
   remédiation et exposant à un nouvel audit complet de CSDJ-1/v1.2.
3. Une révocation ne protège pas des autres écrivains (`service_role`, SQL direct
   d'un rôle propriétaire, une future fonction). Un invariant sur les tables, si.

**Ce que l'invariant garantit** : quel que soit l'écrivain (mutateur v1, mutateur
v1.2, nouvelle RPC, `service_role`, SQL direct), aucune transaction ne peut
**valider** une portée active incomplète.

**Ce qu'il préserve** : permissions, RLS, SECURITY DEFINER et verrou de tenant des
fonctions existantes ; `delete_schedule` (supprimer n'est jamais une activation) ;
brouillons (`enabled = false`), y compris incomplets ; désactivation ;
compatibilité CSDJ-1 / v1.2 / CSDJ-3 (aucun objet existant modifié).

**Option future, non incluse** : une fois une RPC de suppression livrée et tous les
appelants migrés, révoquer sélectivement `EXECUTE` sur les mutateurs historiques.
L'invariant reste alors comme défense en profondeur.

## 4. Fonctionnement

Le fichier `supabase/DRAFT-lot-csdj-bo1-f02-activation-invariant-v1.sql` crée :

- `public.csdjbo1_f02_scope_blockers(uuid, text, uuid) → text[]` : calcule, pour
  une portée, la liste ordonnée des bloqueurs (`offer_missing`, `granularity_missing`,
  `preparation_missing`, `capacity_incomplete`, `capacity_needs_date`), `NULL` si la
  portée n'existe pas. Mêmes conditions que `publishBlockersOf` et que l'étape 11 de
  `save_fulfillment_configuration` (préparation exigée **seulement** en v1.2 ;
  offre exigée sauf `informational_only`).
- `public.csdjbo1_f02_enforce() → trigger` : pour chaque portée touchée (nouvelle
  **et** ancienne si la ligne change de portée, ou en cas de `DELETE`), prend
  `pg_advisory_xact_lock(hashtextextended(restaurant_id::text, 1104))` — le **même**
  verrou que les mutateurs et la RPC —, ignore une portée absente ou en brouillon,
  sinon lève `CSDJBO1_INCOMPLETE_CONFIGURATION`.
- Quatre déclencheurs de contrainte `csdjbo1_f02_activation_invariant`, `DEFERRABLE
  INITIALLY DEFERRED`, `FOR EACH ROW` :
  `AFTER INSERT OR UPDATE` sur `restaurant_fulfillment_schedule` ;
  `AFTER UPDATE OR DELETE` sur `restaurant_fulfillment_schedule_window`,
  `restaurant_fulfillment_schedule_slot` et `restaurant_fulfillment_prep_day`.
- `REVOKE ALL` sur les deux fonctions pour `public`, `anon`, `authenticated`,
  `service_role` : les fonctions ne sont pas appelables, seuls les déclencheurs
  s'exécutent.

**Pourquoi différés, au COMMIT.** Un mutateur legitime écrit en plusieurs
instructions (portée, puis créneaux, puis jours de préparation) : l'état
intermédiaire est incomplet par construction. Seul l'état **final** compte. Le
verrou de tenant est pris **au contrôle** : un écrivain qui ne le prenait pas
(SQL direct) est sérialisé derrière un mutateur qui le tient, puis relit l'état
validé des autres (chaque instruction `READ COMMITTED` voit un instantané neuf) —
pas de « write skew » entre deux retraits concurrents.

## 5. Matrice de comportement

| Opération | Avant le lot | Avec le lot |
|---|---|---|
| Mutateur v1/v1.2, `enabled:true` + `fixed_slots`, sans créneau ni préparation | **Accepté** (F-02) | **Refusé** `CSDJBO1_INCOMPLETE_CONFIGURATION`, 23514, rien n'est écrit |
| Idem, propriétaire ou gérant | Accepté | Refusé |
| Mutateur, brouillon (`enabled:false`) incomplet | Accepté | Accepté |
| Mutateur, portée complète (créneaux + préparation v1.2) | Accepté | Accepté, résultat identique |
| `replace_slots` / `replace_prep_days` qui vide une portée active | Accepté | Refusé (état final incomplet) |
| `replace_slots` qui remplace 2 créneaux par 1 | Accepté | Accepté |
| `delete_schedule` d'une portée active | Accepté | **Accepté** (cascade) |
| `delete_schedule` d'une portée absente | OK (idempotent) | OK (inchangé) |
| Désactivation d'une portée active incomplète héritée | Accepté | Accepté |
| `save_fulfillment_configuration` | Contrat BO1 | Inchangé (mêmes verdicts) |
| Autre restaurant (tenant) | Isolé | Isolé (verrou et contrôle par restaurant) |
| Rôle non autorisé (staff, autre tenant) | Refus d'autorisation historique | Inchangé (l'autorisation précède toute écriture) |

## 6. Données héritées : recensement en lecture seule

Le lot **ne corrige pas** les portées actives déjà incomplètes : il les signale
(`RAISE WARNING 'SCANYM_CSDJBO1_F02 [LEGACY_VIOLATIONS=n]'`) et les laisse en l'état.
Elles n'empêchent pas l'application ; elles seront refusées si on les **réécrit**
sans les compléter. Pour **exiger** un état propre avant d'appliquer :

```sql
select set_config('scanym.csdjbo1.f02_require_clean', 'on', false);
-- puis exécuter le lot : il s'arrête avec [DIRTY] si une portée active est incomplète
```

Recensement (lecture seule, à exécuter avant toute application hébergée) :

```sql
select s.restaurant_id, s.mode_code, s.rule_key,
       public.csdjbo1_f02_scope_blockers(s.restaurant_id, s.mode_code, s.rule_key) as blockers
from public.restaurant_fulfillment_schedule s
where s.enabled;   -- après application du lot ; avant, voir le recensement intégré du §A du lot
```

## 7. Ordre d'application et prérequis

Prérequis : CSDJ-1 (socle) et v1.2 en place (le lot le vérifie : pré-vol §A, et
refuse `[NOT_APPLICABLE]` sinon). **Indépendant du lot BO1** : il s'applique avec ou
sans `save_fulfillment_configuration` (preuve [F8] du harnais). Ordre recommandé :
lot BO1, puis ce lot. Aucun SQL hébergé sans GO CIO/CTO.

## 8. Retour arrière

`supabase/DRAFT-lot-csdj-bo1-f02-activation-invariant-v1-rollback.sql` supprime les
quatre déclencheurs puis les deux fonctions. Gardes : `[NOT_APPLICABLE]` (rien ou
lot partiel), `[DEPENDENT]` (un objet dépend des fonctions), `[CALLER]` (une routine
les cite), `[CRON_JOB]` (une tâche `pg_cron` les cite). Post-contrôles par empreintes
(fonctions, structure, données inchangées).

**Le retour arrière rouvre F-02** : après lui, un mutateur historique peut de nouveau
activer une portée incomplète. À n'utiliser qu'avec la décision CTO correspondante.

## 9. Preuves

Harnais PostgreSQL 16 réel : `supabase/tests/csdj-bo1-f02-activation-invariant-check.sh`
(grappe jetable `SCANYM_DISPOSABLE_CLUSTER=1`, sources v1.2 épinglées par
`SCANYM_V12_SOURCE_DIR`). Il prouve notamment :

- **Rouge/vert** : sans le lot, le contournement de Cat Greco réussit ; avec le lot,
  refus atomique pour propriétaire et gérant, v1 et v1.2 (aucune mutation) ;
- matrice historique complète, `delete_schedule` préservé, refus d'autorisation et
  isolation inter-tenant inchangés ;
- SQL direct, transactions multi-instructions, sémantique différée, tentatives de
  contournement par rôle (`SET ROLE`, `SET CONSTRAINTS`) refusées ;
- **différentiel** sur une grille de 576 configurations : la RPC et l'invariant
  rendent le **même verdict et les mêmes bloqueurs** ;
- concurrence réelle (sessions parallèles, `pg_locks`) : l'écrivain sans verrou
  attend le verrou de tenant au contrôle ; pas de « write skew » ;
- non-régression jumelée (bases avec/sans le lot) : mêmes réponses, mêmes données,
  même résolveur ;
- pré-vol, données sales, indépendance, retour arrière ;
- **mutants** : chaque affaiblissement du lot (contrôle retiré, ancienne portée non
  contrôlée, verrou retiré ou autre graine, SQLSTATE changé, déclencheur non
  différé…) est détecté par au moins une sonde.

Les journaux, empreintes (`SHA256SUMS`, `BLOB-SHAS`), le diff exact contre le parent
et l'identité d'arbre sont dans `docs/scheduling/evidence/csdj-bo1-f02-activation-invariant/`.
Le harnais BO1 d'origine est rejoué **inchangé** (non-régression).

## 10. Limites et risques résiduels

1. **Portées héritées** : actives et incomplètes, elles sont signalées, **non
   corrigées**. Décision CTO : les compléter ou les repasser en brouillon.
2. **Privilèges propriétaire / superutilisateur** : `TRUNCATE`,
   `session_replication_role = replica`, `ALTER TABLE … DISABLE TRIGGER` et
   `DROP TRIGGER` contournent tout déclencheur. Ils sont réservés au propriétaire
   des tables et au superutilisateur — jamais à `authenticated`, `anon` ni
   `service_role` (prouvé par les tentatives de contournement). Hors modèle de
   menace applicatif, mais à connaître.
3. **Hypothèse `READ COMMITTED`** (isolation par défaut de Supabase) pour la
   preuve d'absence de « write skew ». Sous `SERIALIZABLE`, un échec de
   sérialisation (40001) reste un refus sûr.
4. **Interblocage rare possible** entre deux transactions qui prennent les verrous
   de tenant dans un ordre différent (multi-portées). PostgreSQL le détecte et annule
   l'une des deux (jamais d'état incohérent).
5. **Bloqueurs `granularity_missing` / `capacity_*`** : inatteignables depuis
   l'état stocké, car les `CHECK` de table (`rfs_granularity_required`,
   `rfs_capacity_complete`, `rfs_capacity_needs_date`) les refusent d'abord. Ils sont
   conservés par parité avec `publishBlockersOf` (défense en profondeur).
6. **Révocation sélective** des mutateurs : non faite (cf. §3). Reste une étape
   optionnelle ultérieure, avec RPC de suppression dédiée.
7. **F-01** (interface) et **F-03** (instabilité de test) : hors périmètre de ce lot.

## 11. Réconciliation avec la PR #151

Le contrat BO1 (§9, limite 1) déclare les mutateurs historiques « appelables et
capables d'activer une portée incomplète — décision requise ». Ce lot **tranche
techniquement** cette limite sans modifier le contrat parent (blob inchangé) :
l'activation incomplète est désormais refusée au niveau des tables pour **tous** les
écrivains. La limite 2 (suppression) est inchangée : `delete_schedule` reste la porte
de suppression. Les 545 preuves du lot BO1 sont rejouées sans changement.

## 12. Impact

- Interface : **aucun** (le drapeau `CSDJ_BO1_WRITE_CONTRACT.available` reste `false`).
- Moteur de disponibilité, `create_order`, v1.2, CSDJ-3 : **aucune modification**.
- Données : **aucune** modification à l'application.
- Coût d'exécution : un contrôle par portée touchée, à la fin de la transaction.
- Au Lait Cru : aucune règle ALC devient défaut global.
