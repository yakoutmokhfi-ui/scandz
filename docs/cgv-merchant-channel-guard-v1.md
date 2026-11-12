# Publication CGV : disponibilité du canal de rétractation par établissement

## Incident constaté le 11 novembre 2026

Sur main `d194dc31fd6eb6958a24ef1d6c7c4f9b1db7504d`, la résolution du contexte de publication d’Au Lait Cru, exécutée sous le rôle authenticated avec les claims SQL de son propriétaire, lève `WITHDRAWAL_RUNTIME_NOT_READY`. La transaction de diagnostic est annulée, sans publication. Le régime enregistré est MIXED. Les primitives et le canal marchand sont disponibles, son interrupteur est ouvert et son test SMTP enregistré ; le canal plateforme est indisponible.

La PR #221 a volontairement conservé la garde de publication historique, qui ne considère que le canal plateforme. La PR #226 ne la change pas. Le déploiement #226 était réussi techniquement, mais ne rend donc pas ce parcours utilisable avec cette configuration. La doc de #221 mentionnait cette dépendance ; elle aurait dû être relevée avant la mise en service de #226.

## Correctif DRAFT

`DRAFT-lot-cgv-merchant-channel-guard-v1.sql` ajoute une fonction privée prenant l’établissement et remplace uniquement la condition exécutable dans les deux frontières historiques `resolve_cgv_publication_context` et `persist_merchant_cgv_version`.

Disponibilité = établissement existant + primitives + disponibilité du seul canal sélectionné par l’interrupteur. Fermé : canal plateforme. Ouvert : canal marchand de cet établissement, sans repli vers la plateforme. La branche marchand exige :

- interrupteur marchand ouvert ;
- fonction de disponibilité de #221 positive pour cet établissement (coffre, identité et e-mails activés) ;
- test SMTP enregistré et aucune classe d’erreur fournisseur ;
- contact légal de copie et expéditeur normalisés comme dans le worker et validés par les mêmes règles d’adresse (caractères interdits, blancs ECMAScript, longueur UTF-16 ≤254).

Le canal de A ne valide jamais celui de B. Aucun interrupteur n’est modifié ; aucun secret n’est lu/déchiffré ; aucun message n’est envoyé. La fonction globale historique reste inchangée pour ses autres consommateurs. Les gardes d’autorisation, complétude, modèle, empreinte, contenu et historique sont conservées.

Ce contrôle constate la configuration et le résultat enregistré d’un test ; il ne garantit pas la livraison future d’un e-mail. Une nouvelle erreur fournisseur ferme la branche marchand ; un test réussi peut être nécessaire pour rétablir la publication.

## Installation et rollback

Le lot refuse si les deux prédécesseurs n’ont pas exactement les corps inspectés, leur mode SECURITY DEFINER, leur propriétaire postgres, le search_path vide et leurs ACL attendues. Il refuse les nouveaux objets déjà présents. Aucun texte CGV, profil, commande, demande historique ou configuration d’envoi n’est modifié.

Le manifeste privé conserve les définitions originales et les catalogues après patch, dont les appartenances effectives issues de pg_publication_tables (publication explicite, toutes les tables ou tables d’un schéma). Le rollback refuse la dérive des trois fonctions, du manifeste, des colonnes/contraintes/défauts/index/commentaires/politiques/triggers et des dépendances, y compris statistiques, séquence rattachée et publication. Les références visibles de routines tierces bloquent aussi. DROP RESTRICT uniquement. Ne pas exécuter pendant des écritures CGV ni une DDL concurrente. Les références dynamiques doivent être inventoriées par l’opérateur ; un administrateur pouvant falsifier à la fois manifeste et objets est hors de ce modèle.

Aucune application hébergée n’est incluse dans ce développement. Audit indépendant, vérification fraîche du schéma et GO SQL requis avant application. Ce lot SQL n’a pas besoin d’un nouveau déploiement applicatif.

## Textes légaux

Ce correctif ne révise aucun texte ni document utilisateur et ne vaut pas validation juridique. La doc de #221 relève que certains modèles annoncent `retractation@scanym.com`, alors que le canal marchand utilise l’identité du commerçant. Vérifier les clauses du document réellement choisi avant sa publication ; ne pas republier automatiquement des CGV réelles comme test.

## Rejeu

```sh
node --experimental-strip-types --import ./tests/register.mjs --test tests/cgv-merchant-channel-guard.test.ts tests/cgv-word-draft-sql.test.ts tests/cgv-word-draft.test.ts
npx tsc --noEmit
```

Les fixtures contiennent les définitions de fonctions et types de colonnes du catalogue hébergé inspecté, sans données métier. Les tests emploient ces deux vraies définitions historiques et la vraie condition de disponibilité #221 ; les autres fonctions historiques de résolution/complétude/empreinte et le contrôle d’autorisation sont des doublures explicites sur données synthétiques. Ce n’est pas la chaîne CGV complète ni une session Supabase réelle.

Périmètre d’audit prioritaire : reproduire l’ancien blocage, succès pour un établissement réellement prêt, refus pour un autre, interrupteur fermé, primitives absentes, test absent/erreur fournisseur, copie absente/invalide, droits et contenu conservés ; pré-vol refusant la dérive et rollback sans mutation réelle. Rejouer sur PostgreSQL natif et vérifier la session PostgREST avant avis de mise en service.

Résultats historiques du premier candidat d9fc9c5 : 76/76 tests ciblés (26 nouveaux + 22 SQL Word + 28 services Word), aucun ignoré ; TypeScript exit 0. Pas de build relancé : aucun code applicatif ni dépendance modifié. Pas de suite complète, navigateur réel, PostgreSQL natif, session PostgREST ni envoi réel exécutés pour ce correctif. Six mutations sur les gardes (interrupteur, primitives, test SMTP, erreur fournisseur, copie, refus de rollback) sont détectées. Sources restaurées avant le rejeu final.


## Remédiation de l’audit d9fc9c5 (R2)

- Adresses : corpus différentiel testé contre le vrai `isSafeSmtpAddress` du worker pour l’expéditeur et la copie, après la même normalisation. Couvre les séparateurs et caractères interdits, tous les caractères ASCII représentables (hors NUL interdit en texte PostgreSQL), blancs Unicode, astral et bornes UTF-16. La matrice des huit combinaisons interrupteur/plateforme/marchand suit le dispatcher : aucun secours plateforme lorsque le marchand est sélectionné.
- Publications : les deux formes manquantes (`FOR ALL TABLES`, `FOR TABLES IN SCHEMA public`) sont testées en plus de l’appartenance explicite ; refus avant mutation.
- Oracle : helper indépendant `tests/helpers/cgv-channel-catalog-snapshot.ts`, avec pg_attribute, contraintes/défauts, index, routines, dépendances, commentaires, politiques, triggers, statistiques, séquences et publications. Une modification persistée de la cible de statistiques d’une colonne, suivie de l’erreur attendue, est détectée. Le même contrôle négatif rejoué avec l’ancien helper échoue (la modification n’était pas vue).
- Contrôles rouges : les nouvelles reproductions d’adresses, du canal sélectionné et des deux publications échouent sur les SQL audités. L’ancien helper rate la mutation de colonne ; le nouveau la détecte.
- Le rapport HTML/zip Windows de l’auditeur n’est pas disponible dans cette session ; les scénarios sont reconstruits à partir du verdict fourni.

### Blocage préexistant du formulaire v7

Le champ historique `withdrawal_model_form_text` contient « à compléter » comme instruction au client. La garde de contenu de `persist_merchant_cgv_version` le rejette comme placeholder, avant et après ce correctif ; un test permanent documente ce comportement. Cette garde n’est pas désactivée ici. Une correction dédiée doit distinguer ce formulaire standard d’un vrai champ marchand incomplet : suivi dans https://github.com/yakoutmokhfi-ui/scandz/issues/228.

La version 1 du Word préparé pour Au Lait Cru, `CGV_Au_Lait_Cru_relecture_Scanym.docx`, a été relue intégralement : la phrase « à compléter » et les autres marqueurs littéraux recherchés ne figurent pas dans le texte extrait. Le document n’a été ni modifié, ni ajouté à Git, ni publié. Cela ne prouve pas le succès de sa publication réelle ni l’absence de tout autre blocage.

Les résultats R2 exacts et limites sont consignés dans le commentaire de livraison de la PR. Aucun SQL hébergé appliqué, aucun e-mail réel, merge ou déploiement effectué pendant R2.

Rejeu R2 final : **143/143 tests ciblés**, aucun ignoré (42 sur la garde, 22 SQL Word, 28 services Word, 51 voisins du mailer marchand). Corpus différentiel : 142 adresses × 2 champs, matrice de sélection : 8 combinaisons. **5/5 mutations R2 détectées** (regex d’adresse, repli plateforme, deux publications, attributs du catalogue, limite UTF-16). TypeScript exit 0. Pas de build, aucun code applicatif modifié ; limites PostgreSQL natif/PostgREST inchangées.
