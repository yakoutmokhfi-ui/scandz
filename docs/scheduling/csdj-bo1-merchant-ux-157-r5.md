# CSDJ-BO-1 — Remédiation R5 de R4-SCOPE-STALE (PR #157)

Développeur : Boulez. Mandat : Dirac → Boulez. Contre-audit à venir : Cat Turing.
PR #157 maintenue **DRAFT**. Aucun merge, déploiement, SQL hébergé ni changement de données.

## 1. Défaut et cause (confirmée dans le code)

Reproduction de Turing : pickup en cours de sauvegarde, passage à `delivery::rule-test` (lecture autoritaire retenue), refus `CSDJBO1_STALE_CONFIGURATION` de pickup, puis réponse valide de delivery → l'écran reste `loading`, sans délai.

Chaîne causale dans `app/dashboard/availability/page.tsx` (HEAD R4 `f84d6c1`) :

1. `selectScope` n'incrémente pas `requestSeqRef` (identité du commerçant, inchangée à raison).
2. La branche d'erreur de `saveConfiguration` ne vérifie que `requestSeqRef`, donc le STALE d'une ancienne portée continue.
3. Elle appelle `loadServerVersion(pickup)`, qui incrémente `tokenSeqRef` (compteur de lecture autoritaire du snapshot) et la génération globale.
4. L'effet de lecture de delivery compare `seq !== tokenSeqRef.current` au retour de sa réponse, sort sans installer de brouillon : `loading` définitif.

Même mécanisme, deuxième effet trouvé en analysant la même classe de défaut : le **succès** tardif d'une sauvegarde pickup pendant que delivery est affiché déclenchait `setReloadNonce`, donc une relecture de delivery qui réinitialisait son brouillon. Corrigé dans le même geste.

## 2. Correction

Une identité de portée pour chaque opération asynchrone :

- `scopeEpochRef` : compteur incrémenté de façon synchrone par `selectScope` lors d'un vrai changement de portée.
- `saveConfiguration` capture `intendedScope` et `epochAtStart` ; `stillInScope()` = même rang ET portée sélectionnée toujours `intendedScope`.
- Réponse **succès** hors portée : les listes sont mises à jour, rien d'autre (ni brouillon, ni jetons, ni génération, ni relecture forcée). Au retour sur la portée enregistrée, la lecture autoritaire repart de zéro.
- Réponse **refus** hors portée (STALE ou autre) : aucun message, aucune offre de brouillon, aucun conflit, aucune relecture.
- `loadServerVersion` refuse en outre de relire une portée qui n'est plus la portée sélectionnée.

Conservé tel quel : `requestSeqRef`, `tokenSeqRef`, `refreshSeqRef`, génération de snapshot, verrou d'écriture fermé (0 RPC), jetons, rôles. Le traitement du STALE d'une portée **toujours active** est inchangé (test dédié).

Fichiers modifiés : `app/dashboard/availability/page.tsx` (+45/−3). Aucun SQL, aucun `lib/services/availability.ts`, aucun `lib/availability-payload.ts`.

## 3. Preuves

Sous `evidence/csdj-bo1-merchant-ux-157-r5/` :

| Contrôle | Résultat | Fichier |
|---|---|---|
| RED sur HEAD R4 `f84d6c1` | 9 rouges / 11 (`lead` = `null` au lieu de `9`) | `red-on-r4-head-f84d6c1.log` |
| GREEN sur le candidat | 11 / 11 | `green-r5-only.log` |
| Rejeu R3, R4, R5, remédiation, verrou d'écriture, éditeur, 156 | 95 / 95 | `targeted-replay-…log` |
| TypeScript (`tsc --noEmit`) | aucune erreur | (sortie vide) |
| `next build` | succès, avec URL et clé Supabase factices (sans elles : échec d'environnement préexistant sur `/api/track/exchange`) | `next-build.txt` |
| `npm test` complet, R4 → R5 | 5689 → 5700 tests (+11), 19 échecs → 19 échecs | `npm-test-*.txt` |

Commandes :

```sh
node --experimental-strip-types --import ./tests/register.mjs --test tests/csdj-bo1-merchant-ux-157-r5.dom.test.ts
npm test
NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder npm run build
```

Comparaison par identité de test (une exécution de chaque côté) : échecs **identiques** (`npm-test-failures-diff.txt` ne contient aucune différence), **aucun test disparu**, 11 nouveaux tests (`npm-test-new-tests-r5.txt`). Les 19 échecs sont antérieurs : aucun nouveau, aucun disparu, aucun masqué. Instabilité : non évaluée au-delà d'une exécution par côté (limite ci-dessous).

## 4. Scénarios de concurrence testés

| Test | Rouge sur R4 |
|---|---|
| `R5-SCOPE-STALE` reproduction de Turing | oui |
| `R5-ORDRE-delivery-puis-STALE`, `R5-ORDRE-STALE-puis-delivery` | oui |
| `R5-SYMETRIQUE` delivery → pickup | oui |
| `R5-REPETE` pickup → delivery → pickup → delivery | oui |
| `R5-ALLER-RETOUR` pickup → delivery → pickup, lecture neuve en vol | oui |
| `R5-ERREUR-AUTRE` refus non-STALE tardif d'une portée abandonnée | oui |
| `R5-SUCCES-AUTRE-PORTEE` (deux ordres) | oui |
| `R5-STALE-PORTEE-ACTIVE` STALE de la portée active préservé | non (garde) |
| `R5-ISOLATION` aucune écriture, autre commerçant et autre portée intacts | non (garde) |

Les deux « non » sont des gardes de non-régression qui doivent rester vertes avant et après.

## 5. Limites restantes

- Environnement : jsdom, vrai composant, services et réponses réseau simulés et contrôlés. Pas de navigateur réel, pas de RPC Preview authentifié.
- Une seule exécution de la suite complète de chaque côté : l'instabilité des tests préexistants n'est pas réévaluée ici.
- Pendant qu'une sauvegarde est en vol, `saving` reste partagé entre portées d'un même commerçant : l'éditeur de l'autre portée est verrouillé jusqu'à la réponse (comportement R4 conservé, non modifié).
- Aller-retour A → B → A pendant une sauvegarde réussie : la lecture neuve de A peut précéder le commit ; la sauvegarde suivante recevrait alors un STALE géré par le chemin existant (échec fermé), sans perte silencieuse.

Aucun résultat ne vaut autorisation de merge ou de déploiement.
