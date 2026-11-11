# CGV importées depuis Word

## Parcours marchand

1. Télécharger le Word depuis les réglages CGV Scanym.
2. Modifier les paragraphes en conservant les repères, les titres et l’ordre des rubriques. Le bloc de garanties du modèle doit rester inchangé. Un tableau, commentaire ou changement suivi non accepté reste refusé par le lecteur existant.
3. Importer, relire les différences, cliquer **Enregistrer le Word comme brouillon**.
4. Vérifier le nouvel aperçu, puis **Publier**. **Activer** reste nécessaire si les CGV n’étaient pas actives. Conformément au comportement existant, publier pour un établissement déjà actif remplace immédiatement la version courante.

L’import seul ne publie rien. Tant qu’il est en attente (y compris après un échec), publication et activation sont bloquées. **Abandonner cet import non enregistré** revient au dernier brouillon enregistré, ou au rendu du modèle en l’absence de brouillon. Le brouillon enregistré est retrouvé au rechargement.

## Contrat et limites

- Texte uniquement : les styles Word et liens actifs ne sont pas importés. Les URL restent du texte. Tout contenu est échappé lors du rendu HTML, y compris le titre et le préambule.
- Tous les chapitres, leurs titres et leur ordre sont obligatoires dans ce lot. Les modifications de structure restent visibles dans la comparaison W1, mais ne peuvent pas être enregistrées pour publication.
- Le bloc réglementaire du modèle est conservé byte pour byte en HTML, après comparaison des paragraphes Word. Ce contrôle technique n’est pas une validation juridique des autres clauses.
- Le serveur recalcule le SHA-256 du rendu de référence présenté avant la relecture. Un changement de réglages entre relecture et enregistrement bloque l’opération. Des champs modifiés mais non enregistrés dans le formulaire peuvent donc imposer d’enregistrer les réglages puis de réimporter.
- Le brouillon porte l’empreinte du contexte serveur. Un changement ultérieur de profil, de modèle ou de présentation impose un nouvel export/import. Le serveur vérifie à nouveau le JSON, le propriétaire du contexte et l’empreinte avant publication.
- Un brouillon est une nouvelle ligne immuable. Publication reçoit seulement son identifiant ; elle ne reçoit ni HTML, ni modèle, ni acteur, ni empreinte du navigateur.
- Les accès RPC réutilisent `assert_legal_cgv_role` (owner/manager/opérateur). Aucun accès direct aux deux tables pour anon/authenticated/service_role ; RLS activée sans politique permissive. JSON provenant d’un appel direct à la RPC est également revalidé avant publication.
- `persist_merchant_cgv_version` est inchangée : mêmes verrous, vérification finale d’autorisation et d’empreinte, contrôles de contenu, nouvelle version et historique. Aucune ancienne commande ni contenu historique n’est réécrit.
- Un chargement de brouillon en échec donne une erreur propre au Word : les formulaires de réglages restent éditables, mais enregistrement du Word, publication et activation restent bloqués jusqu’à une lecture réussie. Il ne simule pas l’absence de brouillon. La lecture autorisée sans brouillon ne demande pas de profil publiable ; un brouillon existant avec un profil incomplet est présenté comme périmé, sans aperçu.
- Téléversement borné à 2 Mio, même sans Content-Length ; limites ZIP du lecteur existant ; texte total 300 000 caractères, paragraphe 40 000 caractères.
- Le contenu des CGV et les documents des utilisateurs ne sont pas inclus dans Git ni les fixtures.

## Mise en service

**Aucune application SQL hébergée ni publication de CGV autorisée par ce développement.**

Après audit indépendant et GO de mise en service :

1. Vérifier l’identité de main et du candidat, puis les dépendances et droits réels en lecture seule. Le lot attend le moteur CGV existant, les tables de profils, rôles, modèles et versions. Les fonctions historiques ne sont pas remplacées.
2. Appliquer `supabase/DRAFT-lot-cgv-word-draft-v1.sql` dans sa transaction. Ne pas déployer le code avant ce lot : son chargement exige la nouvelle RPC.
3. Déployer le code ; contrôler avec une session de test autorisée l’import, l’enregistrement, le rechargement, l’aperçu puis la publication d’une version synthétique dans un environnement de test adapté. Ne pas publier silencieusement les CGV réelles du marchand.
4. Contrôler le document public, le cache et la conservation d’une version historique après publication expressément autorisée.

Aucun worker ni e-mail n’est concerné.

## Retour arrière

- Revenir d’abord au code précédent et arrêter les écritures CGV / modifications de schéma pendant l’opération.
- Si des brouillons ont été enregistrés, conserver le lot SQL et ses données. Le code précédent les ignore. Le rollback SQL refuse toute ligne, même non publiée : aucune suppression de contenu marchand.
- Sur un lot encore vide, `DRAFT-lot-cgv-word-draft-v1-rollback.sql` compare le catalogue à l’installation : corps et attributs des fonctions, signatures/ACL/propriétaires/commentaires, colonnes, contraintes, index, politiques, déclencheurs et schéma du manifeste. Les dépendances entrantes/sortantes et commentaires de colonnes sont également comparés pour les deux tables ; statistiques étendues, séquences rattachées et appartenance aux publications sont ainsi contrôlées avant tout DROP. Toute dérive bloque avant suppression.
- Les DROP sont RESTRICT, sans CASCADE. Les références visibles aux objets du lot dans les corps de routines tierces sont également recherchées et bloquent le rollback. Un nom reconstruit dynamiquement ne peut pas être découvert par cette analyse statique : inventorier les consommateurs avant tout retrait. Comme pour les autres lots, un administrateur concurrent pourrait modifier un objet après le contrôle : interdire toute DDL concurrente pendant le rollback.
- Le manifeste est privé et détenu par le propriétaire du lot. Il ne protège pas contre un administrateur qui falsifierait volontairement le manifeste et les objets ensemble.
- Le rollback n’altère aucune version publiée. Revenir à un ancien texte exige une nouvelle publication explicitement autorisée.

## Rejeu pour audit indépendant

Base de développement : main `0ce25a03af8ceac11c483447945f1a73d30072c0`.

```sh
node --experimental-strip-types --import ./tests/register.mjs --test tests/cgv-word-draft.test.ts tests/cgv-word-draft-sql.test.ts tests/cgv-docx-import-restaurant-context-isolation.dom.test.ts tests/cgv-publication-boundary-v1.dom.test.ts tests/restaurant-context-critical-regression-gate-legal-cgv.dom.test.ts tests/cgv-w1-docx-roundtrip.test.ts tests/cgv-w1-1-docx-visible-chapter-numbering.test.ts tests/seller-legal-profile-cgv-engine-v1-1-publish-authority.test.ts tests/seller-legal-profile-cgv-engine-v1-2-publish-context-race.test.ts
npx tsc --noEmit
NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=synthetic-build-key npm run build
```

Les tests SQL utilisent une instance PGlite partagée par fichier, avec schéma recréé entre scénarios (moteur PostgreSQL WASM), avec doublures des dépendances historiques et deux établissements. Ils ne remplacent pas un rejeu de la chaîne complète sur PostgreSQL natif, les vrais rôles Supabase/PostgREST ni des essais sous navigateur réel. Les tests DOM utilisent le vrai composant via jsdom et interceptent le backend ; les tests de service exécutent le vrai lecteur DOCX et le vrai renderer. Suite complète non relancée.

Points prioritaires : droits et isolement entre établissements, publication du brouillon sélectionné sans réécriture historique, dérive entre relecture/enregistrement/publication, refus du JSON malveillant directement inséré par RPC, corps HTML échappé, bloc de garanties inchangé, erreurs de chargement et d’enregistrement, réponses tardives, limites de corps HTTP, rollback après dérive et en présence de données.

## Résultats du développement

- Lot ciblé final : **226/226**, aucun test ignoré, dont 26 tests unitaires/services/HTTP et 17 scénarios PGlite. Les six nouveaux parcours DOM s’ajoutent aux cinq contrôles d’isolation existants.
- TypeScript : exit 0. Build Next de production avec configuration Supabase synthétique : exit 0. Aucun accès à une base distante pendant ces vérifications.
- Cinq mutations détectées : échappement HTML, empreinte du brouillon, hash de la relecture, protection du bloc de garanties et identifiant du brouillon publié. Chaque source a été restaurée avant le rejeu final.
- Vérification ponctuelle hors Git des deux Word fournis : le renderer accepte la structure de l’export et conserve les 25 rubriques et le préambule du Word préparé. Cela ne vérifie pas le modèle actuellement hébergé.
- Incident du harnais avant correction : le lancement groupé avec création/fermeture répétée d’instances PGlite a déclenché un fatal V8 `jit_page_->allocations_.erase(addr) == 1`, après quelques scénarios. Le harnais utilise maintenant une seule instance par fichier et recrée les schémas entre scénarios. Le rejeu groupé final est vert sans exclusion.
- Non exécutés : suite complète, PostgreSQL natif et chaîne CGV complète, PostgREST/Supabase hébergés, navigateur réel. Aucune publication de CGV réelle, aucun SQL hébergé, merge ou déploiement.


## Remédiation de l’audit c32fa408 (R2)

- Profil incomplet : lecture du brouillon distincte de la complétude de publication, et erreur Word isolée des formulaires de profil. Un test DOM couvre l’adresse manquante, l’échec de lecture, l’enregistrement de l’adresse et le rechargement réussi.
- Rollback : manifeste étendu aux descriptions de colonnes, aux dépendances du catalogue et aux appartenances aux publications. Les quatre ajouts tiers cités par l’audit sont refusés avant suppression. Le SQL reste DRAFT, jamais appliqué en environnement hébergé.
- Non-mutation : oracle indépendant dans `tests/helpers/cgv-word-catalog-snapshot.ts`, qui relit les catalogues, les données du lot et le manifeste. Chaque refus après dérive est comparé à l’état réel avant tentative. Un contrôle négatif persiste volontairement un DEFAULT puis lève l’erreur attendue : le manifeste inchangé ne suffit plus à valider le test.
- Les nouveaux cas de profil et les quatre ajouts tiers ont été exécutés rouges sur le code audité avant correction. Le contrôle négatif de l’oracle détecte le DEFAULT persistant.
- Limite de ce rejeu : PostgreSQL natif 17.11 a été préparé localement, mais son démarrage est refusé par l’environnement (`could not create Unix socket: Operation not permitted`). Aucun contrôle natif n’est donc revendiqué. Les scénarios SQL exécutés ici utilisent PGlite, les scénarios UI jsdom, sans session PostgREST ni navigateur réel. L’auditeur doit rejouer ses reproductions natives et Chrome sur le nouveau candidat.

Rejeu R2 final : **234/234 tests ciblés**, aucun ignoré, sur les neuf fichiers ci-dessus (28 tests unitaires/services/HTTP et 22 scénarios SQL). TypeScript et build Next : exit 0. Main et tête distante inchangés avant publication : `0ce25a03` et `c32fa408`. Aucun navigateur réel ou contrôle natif exécuté dans ce rejeu.
