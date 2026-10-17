# PR #157 — remédiation de l'audit « CAT TURING FAIL » (F-01, F-02, F-03)

> **Statut : DRAFT. Pas de merge, pas de déploiement, pas de SQL hébergé, aucune donnée touchée.**
> Candidat audité : `b060ebad92bba672785da141c1c9227f468f172f` (immuable, non réécrit).
> La remédiation est livrée en **commits enfants** de ce candidat. Base : `main` = `97e0ddc033cf2943feee26402066940e47c2f037`.

## F-01 — « Relire depuis le serveur » n'efface plus une saisie

**Cause.** `refreshFromServer` ne vérifiait `dirty` qu'au départ. Pendant l'attente des deux lectures
de listes, le commerçant pouvait éditer ou changer de portée ; la réponse tardive relançait alors la
lecture autoritaire, qui **remplaçait le brouillon**.

**Correctif** (`app/dashboard/availability/page.tsx`). La réponse est liée à des générations et n'est
appliquée que si, **à son arrivée**, rien n'a bougé :

- `refreshSeqRef` : une relecture plus récente, ou un changement de portée (`selectScope`), invalide la précédente ;
- `requestSeqRef` (restaurant) inchangé ;
- la portée sélectionnée est la même ;
- le brouillon est **le même objet** qu'au départ (la moindre édition, un enregistrement ou une résolution de conflit en fait un autre).

Sinon la réponse est **abandonnée en entier** : ni listes, ni brouillon, ni jeton touchés, aucun
enregistrement. Le commerçant le voit (`[data-reload-abandoned]`, `avReloadAbandoned`).
L'édition n'est pas suspendue. Une seule relecture peut être en vol : le bouton est inactif
et dit « Relecture en cours… ».

## F-02 — l'exemple du serveur est lié à la version de la configuration

**Cause.** L'exemple n'était lié qu'à la portée. Après un enregistrement, un rechargement ou une
résolution STALE, l'ancien exemple restait affiché comme venant de la configuration enregistrée.

**Correctif.** `snapshotGen` est un compteur incrémenté à **chaque** pose d'un snapshot (lecture
autoritaire, enregistrement, `takeServerVersion`, `rebaseOnServer`, remise à zéro). Un exemple porte la
génération qu'il avait **au moment de la demande** (`previewGen`) :

- `previewInScope` exige maintenant portée **et** génération identiques ;
- un exemple d'une génération révolue passe à `data-server-example="stale"` : la date n'est plus affichée,
  une note dit « Cet exemple ne correspond plus à la configuration enregistrée… » (aussi au §6) ;
- une réponse en vol à travers un changement de version est présentée « périmée », jamais « actuelle » ;
- des modifications non enregistrées sont dites **absentes** de l'exemple (`[data-server-example-dirty]`).

Aucune date n'est calculée dans le navigateur ; l'exemple n'est ni effacé en silence ni recalculé.

## F-03 — vrai test négatif du verrou d'écriture, `UX156-10c` renforcé

- `tests/csdj-bo1-availability-write-lock.test.ts` (nouveau, 6 tests). Le service est **exécuté** avec le drapeau
  réel forcé à `available=false` **dans le bundle seulement** (la valeur du dépôt reste `true`, `[BO1-LOCK-6]`),
  un **espion sur le transport** :
  - `[BO1-LOCK-1]` refus `AvailabilityWriteUnavailableError` **et** 0 RPC (d'écriture et de lecture) ;
  - `[BO1-LOCK-2]` contrôle positif : drapeau réel, la même requête atteint le transport (1 `save_fulfillment_configuration`) ;
  - `[BO1-LOCK-3]` **preuve de mutation** : le `throw` retiré en mémoire, drapeau `false` → le service écrit (donc LOCK-1 serait rouge) ;
  - `[BO1-LOCK-4/5]` rôles : `false` → fermé pour tous (propriétaire compris) avec la raison « contrat », employé/absent/opérateur → « rôle » ; `true` → seuls propriétaire et responsable.
- `[BO1-SVC-16]` reste un simple complément structurel, **dit comme tel** (il ne prouve plus rien à lui seul).
- `[UX156-10c]` : deux portées réelles, lecture autoritaire de la livraison **retenue**, retour sur « Retrait », réponse libérée :
  le brouillon, le résumé enregistré et l'état annoncé du retrait sont inchangés. Preuve de mutation faite :
  les trois gardes `seq !== tokenSeqRef.current` neutralisées → `[UX156-10c]` rouge (puis restaurées).

## Preuves

| Scénario | Candidat audité b060eba | Remédiation |
|---|---|---|
| R1 (J+5 pendant la relecture, réponse tardive) | **ROUGE** | VERT — la saisie survit, rien n'est enregistré |
| R2 (bascule de portée + J+7, réponse tardive de « Retrait ») | **ROUGE** | VERT |
| R3 (exemple, désactivation, enregistrement) | **ROUGE** | VERT — exemple « périmé » |
| R3b (calcul en vol → changement de version), R3c (STALE), R3d, R1c | **ROUGE** | VERT |
| R1b (relecture sans saisie, contrôle positif) | VERT | VERT |

Journaux : `evidence/csdj-bo1-merchant-ux-156/remediation-157/red-on-b060eba.log` (1 ok / 7 not ok, pour les raisons visées)
et `green-on-remediation.log` (42/42 : remédiation 8, verrou 6, UX-156 28).

Les R1/R2/R3 sont des tests de **non-régression par préservation** (la saisie / l'exemple honnête doivent survivre), pas des
« reproductions de défaut ».

## Vérifications

- `tsc --noEmit` : 0 erreur. `next build` (variables Supabase factices) : OK.
- 28/28 tests UX-156 inchangés dans leur contrat (10c renforcé), 4 langues, RTL, mobile et clavier couverts par les tests existants.
- `npm test` complet, **seul** (pas de chevauchement avec `next build`) : 5 672 tests, 15 échecs.
  Comparaison **par identité de test** : ensemble identique aux 15 échecs de b060eba, **0 nouvel échec** ; ces 15 ⊂ les 27 de `main`
  (listes dans `npm-test-failures-*.txt`). Ils préexistent à cette PR (tests épinglés sur d'autres sujets ou sur Windows) ; non traités ici.
- Aucun fichier de `supabase/`, `lib/availability-payload.ts`, `lib/services/availability.ts` modifié.

## Non vérifié — INCONCLUSIF

- Un `get_fulfillment_configuration` **authentifié réel en Preview** n'a pas été exécuté : aucun environnement autorisé n'est disponible
  dans cette session. Je ne déclare donc aucun E2E. Les scénarios ci-dessus sont des tests DOM (JSDOM) avec doubles de services, promesses contrôlées.

## Risque résiduel

- La garde F-01 abandonne la relecture si le brouillon change ; un commerçant qui édite pendant une relecture doit la relancer (c'est dit à l'écran).
- Le suivi de génération est local au navigateur : un autre onglet qui enregistre n'invalide pas l'exemple d'un onglet inactif (le serveur reste la source ; l'enregistrement reste protégé par STALE).

## Suite

Contre-audit indépendant demandé avant tout GO (aucun merge, aucun déploiement).
