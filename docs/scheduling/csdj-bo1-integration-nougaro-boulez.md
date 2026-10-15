# CSDJ-BO-1 — Intégration finale Nougaro (frontend) + Boulez (backend) — PR #153

> **Statut : HOLD / DRAFT — PAS DE PRODUCTION.** Aucun merge, aucun SQL hébergé,
> aucun déploiement. `CSDJ_BO1_WRITE_CONTRACT.available` **reste `false`**.
> Mandat : DIRAC → BOULEZ, « INTÉGRATION FINALE CSDJ-BO-1 — GO CIO ».

## 1. Identités (SHA complets)

| Objet | SHA |
|---|---|
| Base `main` de la PR #153 | `323911edcc3b0fbc25230f1262ea1fbfd5524b1d` |
| Backend Boulez #151 | `de4600567bcd2be3e3faf7f3bfd44ee7e69a5e2c` |
| Backend Boulez #152 (F-02) — head de départ de l'intégration | `6e35e8f1684dafe37c8d54077bc65c6e02cf9b81` |
| Frontend Nougaro (commit) | `10739eb62e4183c255d6032b2d970ca8f57601fa` |
| Frontend Nougaro (arbre) | `313053dae9d97ea413d43a63c57deb5ab8e262b7` |
| Frontend Nougaro (parent = candidat R1) | `e419f468127c79eceaafcc90e576501b105c9bd4` |
| Dernier commit Nougaro déjà dans `main` | `b5487e47133327349144a98628800270b5665fef` |
| Commit d'intégration A (delta Nougaro exact) | voir le rapport de la PR (SHA complet) |
| Commit d'intégration B (colle, test de compatibilité, preuves) | voir le rapport de la PR (SHA complet) |

Les commits audités (#151, #152, Nougaro) ne sont **pas réécrits** : l'intégration
ajoute deux commits enfants sur le head de #152.

## 2. Provenance du paquet Nougaro

- `scanym_release_handoff_2.zip` : `nougaro-package.zip` et `publish_nougaro.sh`
  conformes à `SHA256SUMS` (471f805e… / 319f9f9d…).
- `nougaro-package.zip` : les 23 fichiers conformes à `sha256.txt` (dont le bundle
  `2c0b4415…`).
- Bundle Git : `git bundle verify` dans un dépôt VIDE → « complete history » ;
  `10739eb6…` (arbre `313053da…`, parent `e419f468…`) et `origin/main` du bundle
  `03441a5e…` (ancêtre de `main` actuel). `git fsck --full` propre.
- `publish_nougaro.sh` a été **lu, pas exécuté** (il suppose un poste authentifié) ;
  sa méthode (delta `b5487e47…` → `10739eb6…` appliqué par `git apply`) a été
  reproduite à l'identique.

## 3. Composition

`main` (323911e) contient déjà l'onglet « Mise à disposition » en lecture seule
jusqu'à `b5487e4` (contrôle : les fichiers concernés sont identiques entre `main`
et `b5487e4`). Le delta à intégrer est donc `b5487e4` → `10739eb6` : éditeur
fonctionnel (R1), F-01 (snapshot autoritaire indivisible, conflit, rebase) et F-03
(attente par quiescence). **21 fichiers**, +7 501 / −188 lignes.

- **Aucun recouvrement** avec les 29 fichiers de #151/#152 (backend) : `git apply
  --check` propre, aucun conflit.
- **Commit A** = ce delta, appliqué mécaniquement. Preuve d'identité : pour les
  **28** chemins frontend de l'arbre Nougaro (par rapport à `03441a5e`), le blob de
  l'intégration est **octet pour octet** celui de `10739eb6`.
- **Commit B** = colle d'intégration (§4), test de compatibilité réel (§5), cette
  note et le dossier de preuves.
- F-01 et F-03 sont donc présents tels qu'audités : aucune ligne du frontend n'a été
  réécrite par Boulez.

## 4. Seul point de friction : un test de Boulez

`tests/csdj-bo1-save-configuration-contract.test.ts` `[BO1-RPC-2]` (lot #151)
interdisait **tout** appel applicatif à `save_/get_fulfillment_configuration`
(l'interface n'existait pas). L'éditeur Nougaro les appelle légitimement, derrière le
verrou. Seul ce test est adapté, sans affaiblir l'invariant :

- `[BO1-RPC-2]` : le seul fichier applicatif qui appelle les RPC est
  `lib/services/availability.ts` (jamais une page ni un composant) ;
- `[BO1-RPC-2b]` (nouveau) : cet unique appel d'écriture est **précédé** de
  `if (!CSDJ_BO1_WRITE_CONTRACT.available)`, le drapeau vaut `false`, et aucun appel à
  `mutate_merchant_fulfillment_schedule*` n'existe.

Aucun autre fichier de Boulez, aucun contrat métier, aucune règle Au Lait Cru n'est
modifié. Le contrat BO1 (blob `726ba9e8…`) est inchangé.

## 5. Compatibilité éditeur ↔ RPC (code réel, base réelle)

Harnais `supabase/tests/csdj-bo1-integration-compat-check.sh` + pilote
`csdj-bo1-integration-compat-driver.ts` : grappe PostgreSQL 16 **jetable**, moteur
v1.2 épinglé + lot BO1 + invariant F-02 appliqués ; le **vrai** code de
`lib/availability-payload.ts` produit les charges, les RPC répondent comme à un
client réel (`authenticated`, JWT simulé).

| Preuve | Résultat |
|---|---|
| Signatures : `save(p_restaurant_id, p_payload)`, `get(p_restaurant_id, p_mode_code, p_fulfillment_rule_id)` | concordent avec l'appel du service |
| Aller-retour RPC → snapshot → brouillon → charge | ≡ charge d'origine (v1.2, v1, règle de livraison) |
| Jetons `updatedAt` / `revision` | verbatim, **microseconde** conservée |
| Enregistrement d'une modification avec les jetons du snapshot | accepté ; nouveaux jetons |
| F-01 : jetons périmés (un tiers a écrit) | refus `CSDJBO1_STALE_CONFIGURATION`, version du tiers intacte, clé i18n `avSaveStale` |
| F-01 : divergence champ par champ puis rebase confirmé | les deux modifications survivent côté serveur |
| Activation incomplète | bloquée localement **et** refusée par le serveur (`CSDJBO1_INCOMPLETE_CONFIGURATION`, invariant F-02 inclus) ; repli brouillon accepté |
| `CSDJBO1_METHOD_MISMATCH`, refus d'autorisation d'un autre propriétaire | codes lus et traduits en clés i18n dédiées |
| Grille 64 configurations (méthode × offre × créneaux × fenêtres × préparation) | l'éditeur bloque **exactement** ce que le serveur refuse ; bloqueurs communs identiques |

Écarts constatés (documentés, sans conséquence sur la sécurité) :

1. L'éditeur renumérote `displayOrder` de 0 à n-1 sur l'ensemble de la liste, alors
   que les exemples de Boulez numérotent par jour : le serveur accepte les deux, l'ordre
   des lignes est identique.
2. En v1.2 l'éditeur n'envoie pas `policy.cutoffOffsetDays` ; le serveur l'accepte
   absent ou à `0`.
3. L'éditeur est **plus strict** que le serveur pour un brouillon v1.2 : il exige
   toujours un jour de préparation (le serveur ne l'exige qu'à l'activation). Plus
   strict, jamais plus permissif.

## 6. Vérifications et régressions

Voir `docs/scheduling/evidence/csdj-bo1-integration-nougaro-boulez/` : journaux
TypeScript (`tsc --noEmit` : 0 erreur), `next build` (succès), tests CSDJ-BO-1, harnais
PostgreSQL (F-02, BO1 inchangé, compatibilité) sur les deux pins v1.2, et comparaison
**par identité de test** des échecs de `npm test` avec la base.

## 7. Ce que cette PR ne fait pas — portes avant toute mise en service

Inchangé par rapport au corps de la PR #153 :

1. **Pas de merge.** Re-audit indépendant (Cat Greco, #150) de la composition, puis GO
   séparé CIO/CTO.
2. **SQL hébergé** : prévol production en LECTURE SEULE (objets existants, portées
   actives incomplètes, `scanym.csdjbo1.f02_require_clean=on`), sauvegarde et plan de
   retour arrière, puis **#151 puis #152** dans cet ordre. Le retour arrière de #152
   rouvre F-02.
3. **Le drapeau reste `false`** tant que le SQL n'est pas installé : activer
   l'interface avant le SQL serait fautif (`save_fulfillment_configuration` est absente
   de production).
4. Le checkout « retrait » exige encore CSDJ-2 : BO1 ne répare pas cet écart.
5. Résiduels propres à l'intégration : le `[C] FOCUS CLAVIER` du catalogue et d'autres
   tests DOM à durée fixe restent instables sous charge (hors périmètre, non modifiés) ;
   le backend de référence de l'interface (`fake-fulfillment-write-backend`) simule le
   contrat — c'est le harnais de compatibilité ci-dessus qui le confronte au vrai SQL.
