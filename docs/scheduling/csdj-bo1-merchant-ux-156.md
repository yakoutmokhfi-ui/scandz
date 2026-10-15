# CSDJ-BO-1 — Refonte UX commerçant « Mise à disposition » — issue #156

> **Statut : DRAFT — pas de merge, pas de déploiement, pas de SQL hébergé.**
> Mandat : DIRAC → NOUGARO (« REFONTE UX COMMERÇANT »), pris en charge ici à la demande du CIO.
> Périmètre : **frontend, libellés et tests uniquement**. Aucun changement de RPC, de RLS, de
> données, de CSDJ-1 / v1.2 / CSDJ-3, ni des règles Au Lait Cru, ni du mode de calcul.

Base : `main` = `97e0ddc033cf2943feee26402066940e47c2f037` (PR #153 puis #154 fusionnées,
`CSDJ_BO1_WRITE_CONTRACT.available = true`).

## 1. Diagnostic (de bout en bout, depuis le code)

Les trois captures du CIO ne sont pas dans l'issue : le diagnostic ci-dessous vient de la
lecture du code de `main` et de sa reproduction par des tests, pas de la production.
Chaque cause est **prouvée par un test** (colonne « Preuve »).

| # | Constat | Cause trouvée | Preuve |
|---|---|---|---|
| 1 | Bannière « Enregistrement indisponible : le contrat d'écriture n'est pas encore approuvé » et raison « Inactif… contrat » alors que BO1/F-02 sont installés | **Pas un cache, pas un retard de déploiement.** La bannière était rendue **sans condition** (`page.tsx`, bloc `data-write-contract`) et la phrase « Inactif : l'enregistrement attend le contrat… » sous la case d'activation l'était aussi : `writeDisabledKey` retombait sur la clé « contrat » dès que le rôle n'était pas en cause, **même quand l'écriture était activée**. #154 a basculé le drapeau, mais aucun rendu ne le lisait. | `[UX156-1]`, `[UX156-1b]`, `[BO1-SAVE-0]` |
| 2 | Résumé « Il choisit sa date et un créneau nommé » vs sélecteur « J'impose la première date disponible » | Deux sources différentes sur le même écran : le résumé (tableau des portées) venait de la **lecture « liste »** ; le sélecteur vient de la **lecture autoritaire** `get_fulfillment_configuration` (le brouillon). Elles divergent dans trois cas réels : (a) modification **non enregistrée** du sélecteur (le résumé ne bouge pas, rien ne l'indique) ; (b) les deux lectures du serveur se contredisent (écriture d'un tiers entre elles) ; (c) la lecture autoritaire échoue : la page repasse **silencieusement** sur les valeurs de la liste. De plus, tant que le brouillon n'existait pas, les sélecteurs affichaient des **valeurs par défaut** (« aucune date », « pas d'heure ») comme si elles étaient vraies. Je ne peux pas dire lequel des cas (a)–(c) est celui de la capture sans elle ; les trois sont couverts et rendus visibles. | `[UX156-2]`, `[2b]`, `[2c]`, `[2d]`, `[2e]`, `[2f]` |
| 3 | Interface trop technique | Le code brut du mode, le fuseau, « méthode v1 / v1.2 », le décalage d'heure limite, les 4 étapes de l'algorithme étaient en tête de parcours. | `[UX156-3]`, `[UX156-4]` |
| 4 | « Aucun jour de préparation enregistré » en v1 | Le champ « jours de préparation » est un réglage **v1.2** ; en v1 la page demandait quand même un champ que le serveur n'a pas, et le montrait comme un manque. | `[UX156-4]`, `[BO1-DOM-5]` |
| 9 | Aperçu | Il n'était pas dit que ce n'est pas une commande simulée, ni que le checkout « retrait » n'est pas relié (CSDJ-2). | `[UX156-9]` |

## 2. Ce qui change à l'écran

Sections dans l'ordre demandé par le mandat :

1. **Mode de remise** — noms humains (« Retrait en boutique », « Livraison »), explication de ce qui est
   modifiable et pourquoi les autres modes/zones n'apparaissent pas ; le code brut (`pickup`), le fuseau et la
   méthode passent dans un volet « Détails techniques » replié.
2. **Jours et horaires proposés au client** — précédé d'un récapitulatif hebdomadaire lisible
   (Au Lait Cru : mardi–samedi 11:00–14:00 et 16:00–20:00, dimanche et lundi « Fermé »), calculé à partir du
   brouillon, sans réécrire aucune plage.
3. **Préparation et délai minimum** — phrases « en clair » tirées des réglages saisis (« J + 1 », heure
   limite 16:00, décalage, horizon 14 jours), **exemple daté calculé par le serveur** (bouton « Calculer un
   exemple » → première date et créneaux de ce jour-là, `get_checkout_fulfillment_schedule`), explication de
   l'algorithme repliée. Le décalage d'heure limite (v1) et le temps de préparation en minutes sont dans les
   **options avancées**.
4. **Fermetures exceptionnelles** — fermetures client (toutes méthodes) ; fermetures d'atelier et jours fériés
   (**v1.2 uniquement**) ne sont plus montrés en v1.
5. **Capacités (méthode v1.2 uniquement)** — en v1 : un volet replié qui dit pourquoi.
6. **Vérifier avec le serveur avant d'enregistrer** — avertissement explicite : « Cet aperçu n'est pas une
   commande simulée… le parcours de commande « retrait » n'est pas encore relié à ces règles (CSDJ-2) ».

États visibles (un seul, par ordre de gravité) : lecture seule · contrat indisponible · lecture en cours ·
conflit · version du serveur non lue · enregistrement · erreur · modifié non enregistré · enregistré ·
aucune modification (`data-editor-status`, région `status`).

Un résumé « Ce que verront vos clients » est dérivé **du même brouillon que le formulaire** ; la version
enregistrée reste nommée à part, et une modification en cours est annoncée « Modifié, non enregistré — les
clients voient encore la version enregistrée ». Si la liste et la configuration du serveur se contredisent,
la page l'écrit, ne tranche pas, et propose « Relire depuis le serveur » (refusé tant qu'il y a des
modifications non enregistrées : rien ne s'efface en silence).

## 3. Ce qui n'a PAS changé (vérifié)

- Un seul appel transactionnel `save_fulfillment_configuration`, snapshot indivisible (configuration +
  `updatedAt` + `revision`), résolution explicite des conflits STALE, isolation locataire, rôle
  propriétaire/responsable, contrôle F-02 : aucun de ces fichiers n'est touché
  (`lib/availability-payload.ts`, `lib/services/availability.ts`, `supabase/` : 0 ligne modifiée).
- Aucune valeur métier n'est modifiée en silence : choisir « J'impose la première date » **ne réécrit pas** le
  mode de créneaux ; l'incohérence est dite par la validation existante ([UX156-2]).
- Aucun calcul de date dans le navigateur ([UX156-5] : aucune date AAAA-MM-JJ dans les phrases en clair).
- Les règles Au Lait Cru ne sont pas réécrites : le récapitulatif est en lecture ([UX156-7]).

## 4. Fichiers

| Fichier | Nature |
|---|---|
| `app/dashboard/availability/page.tsx` | rendu : bannière conditionnelle, résumé du brouillon, états, v1 sans options v1.2, exemple serveur, réordonnancement des sections |
| `lib/availability-ux.ts` (nouveau) | aides d'affichage **pures** : nom de mode, phrase client, état, résumé hebdomadaire |
| `lib/i18n.ts` | 40 clés nouvelles + 6 titres reformulés en FR / EN / AR / NL ; 1 clé retirée (`avPrepOnlyV12`, plus lue) |
| `tests/csdj-bo1-merchant-ux-156.dom.test.ts` (nouveau) | 28 tests |
| `tests/csdj-bo1-availability.dom.test.ts`, `…-a11y.dom.test.ts`, `…-editor-save.dom.test.ts` | assertions sur la bannière / la raison « contrat » remises d'aplomb (commit « tests ») |
| `tests/csdj-bo1-availability-contract`, `-editor-payload`, `-availability-service`, `-f02-activation-invariant-contract`, `-save-configuration-contract`, `storefront-order-help-wording-…` | **à relire par le CTO** : 8 tests épinglaient encore `available = false` après #154 (rouges sur `main` avant cette PR) ; alignés sur l'état livré, le verrou du service restant vérifié (`[BO1-RPC-2b]`, `[BO1-ED-1]`, `[BO1-SVC-16]`) — commit « tests » séparé, révocable sans toucher au reste |

## 5. Libellés proposés (FR ; EN/AR/NL dans `lib/i18n.ts`)

| Avant | Après |
|---|---|
| `pickup` | Retrait en boutique |
| Modes de retrait et de livraison | Mode de remise |
| Préparation et délais | Préparation et délai minimum |
| Dates et créneaux proposés | Jours et horaires proposés au client |
| Fermetures et jours fériés | Fermetures exceptionnelles |
| Capacités | Capacités (méthode v1.2 uniquement) |
| Prévisualisation des disponibilités | Vérifier avec le serveur avant d'enregistrer |
| (rien) | Ce que verront vos clients · Version enregistrée · Modifié, non enregistré |

## 6. Vérifications

Voir le corps de la PR pour les résultats chiffrés (`tsc`, `next build`, tests CSDJ-BO-1, comparaison
`npm test` **par identité de test** avec `main`).

## 7. Portes avant toute mise en service

1. **Pas de merge** sans GO CIO ; re-audit indépendant possible (Cat Greco, #150).
2. Aucune migration, aucune RPC, aucune donnée : la PR peut être revue et déployée comme un simple changement
   d'interface, sans prérequis SQL.
3. Le checkout « retrait » exige toujours CSDJ-2 : cette PR le **dit** à l'écran, elle ne le répare pas.
4. Les captures du CIO manquent à l'issue : si le cas (a)/(b)/(c) du constat 2 est autre chose (par exemple
   une donnée réelle incohérente en base), le correctif d'affichage le rend visible mais ne change pas la donnée.
