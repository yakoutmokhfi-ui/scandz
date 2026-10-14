# CSDJ v1.2 — ordre de déploiement / retour et garde-fous (CSDJ12-DEPLOY-01 / CSDJ12-RB-02 / RB02-RACE-02 / RB02-CALLER-01)

Ce document ne modifie PAS le contrat canonique v3.1 (blob `5d17f05a…`).

## Ordre

| Sens | Ordre |
|---|---|
| Déploiement | CSDJ-1 → **v1.2** → CSDJ-3 |
| Retour | CSDJ-3 (son propre retour) → **v1.2** → CSDJ-1 |

Le retour v1.2 REFUSE (`SCANYM_ROLLBACK_REFUSED`, 55000, avant toute modification) si :

- `[CSDJ3_INSTALLED]` : la table `public.order_fulfillment_schedule_snapshot` (marqueur du contrat §9) existe ;
- `[CREATE_ORDER_FINGERPRINT]` : `create_order(text,text,jsonb,integer,jsonb,text,text,boolean)` n'a pas exactement une surcharge, ou son corps (md5, fins de ligne normalisées en LF) ≠ `c327445751333e7908d60e6d7f838eb5` (prédécesseur pré-CSDJ-3, contrat §12.2) ;
- `[ISOLATION]` / verrou partagé avec l'installation de CSDJ-3 : voir « Exclusion mutuelle » ci-dessous (pris AVANT tous les contrôles de cette liste) ;
- `[ENGINE_SURFACE]` : un des 15 objets du moteur ou une des 5 tables est introuvable (aucune exclusion fiable possible) ;
- `[ENGINE_DEPENDENT]` / `[ENGINE_CALLER]` / `[CRON_JOB]` : un consommateur du moteur existe dans N'IMPORTE QUEL schéma non système (voir « Découverte des consommateurs ») ;
- `[REVIEW_TOKEN]` : jeton de revue absent ou périmé (voir « Politique pour ce que le texte ne peut pas prouver »).

Raison : supprimer les fonctions du moteur alors que le `create_order` CSDJ-3 les appelle fait échouer toute commande à l'exécution (plpgsql ne suit pas les dépendances).

## Aller : exécutant et état exact

L'aller doit être exécuté par `postgres` (`SCANYM_DEPLOY_IDENTITY`, 42501, sinon). Pré-vol : les 10 prédécesseurs sont comparés à l'état épinglé (propriétaire, SECURITY DEFINER/INVOKER, volatilité, `proconfig` complet, type de retour, corps, ACL `grantee/grantor:EXECUTE[*]` y compris PUBLIC, privilèges effectifs anon/authenticated/service_role). Post-vol : mêmes contrôles sur les 9 prédécesseurs inchangés, `resolve_fulfillment_schedule_v1` et les 14 fonctions créées, avant `COMMIT`. Toute dérive → `SCANYM_SCHEMA_DRIFT` / `SCANYM_POSTFLIGHT` et annulation complète.

## Vérification PROD en LECTURE SEULE avant d'appliquer

```sql
select p.oid::regprocedure::text as sig, pg_get_userbyid(p.proowner) as owner, p.prosecdef, p.provolatile,
       p.proconfig, md5(replace(p.prosrc, chr(13)||chr(10), chr(10))) as body_md5,
       pg_get_function_result(p.oid) as result, p.proacl
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in (
  'resolve_fulfillment_schedule','get_checkout_fulfillment_schedule','mutate_merchant_fulfillment_schedule',
  'checkout_wall_time_instant','checkout_wall_time_status','checkout_date_selection_modes',
  'checkout_slot_selection_modes','has_role_in','is_member_of','is_scanym_operator','create_order')
order by 1;
select * from pg_default_acl;  -- les ACL par défaut influencent les fonctions créées par l'aller
select current_user;           -- doit être postgres
```

Les épingles sont dérivées de l'historique du dépôt : elles doivent être confrontées à cette requête avant l'application ; en cas d'écart, corriger l'épingle (revue) plutôt que d'affaiblir la garde.

## Exclusion mutuelle avec l'installation de CSDJ-3 (CSDJ12-RB02-RACE-02)

Le retour prend, comme PREMIÈRE instruction utile (après avoir exigé READ COMMITTED, avant l'applicabilité et avant toute lecture de dépendance), le verrou consultatif transactionnel :

```sql
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scanym.csdj3.order-persistence.v1', 0));
```

Il est libéré au COMMIT ou au ROLLBACK (aussi à la fin brutale de la session) : jamais de verrou orphelin. Sous REPEATABLE READ le retour refuse (`[ISOLATION]`) : l'instantané daterait d'avant l'attente du verrou.

### Dépendance d'interface avec CSDJ-3 (à confirmer avec Debussy — AUCUNE modification de CSDJ-3 ici)

Cette expression est celle du mandat Dirac → Boulez. Elle est **NON VÉRIFIÉE contre le candidat CSDJ-3 `34cad9e`** : ce commit n'est présent ni dans le dépôt, ni sur le remote, ni accessible par l'API depuis l'environnement de cette remédiation. Tant qu'elle n'est pas relue contre le fichier réel, l'exclusion mutuelle n'est pas démontrée contre CSDJ-3 lui-même, seulement contre un installateur qui suit ce protocole.

Protocole que l'installation de CSDJ-3 doit suivre (c'est ce que reproduit le stand-in du harnais, sections [20]) :

1. dans sa transaction, PREMIÈRE instruction utile : le même `pg_advisory_xact_lock(hashtextextended('scanym.csdj3.order-persistence.v1', 0))` (même chaîne, même graine `0`, même type de verrou) ;
2. prérequis relus APRÈS le verrou (pas avant) : au minimum `validate_fulfillment_selection(...)` et `reserve_fulfillment_capacity(...)` de v1.2 présents, par signature exacte ; sinon refus (le stand-in lève `SCANYM_CSDJ3_PREREQ`) ;
3. puis installation (table marqueur `order_fulfillment_schedule_snapshot`, `create_order` qui appelle le moteur), validation.

Issues, avec cet installateur et ce retour (preuves : harnais [20], deux sessions PostgreSQL réelles) :

| Qui gagne le verrou | Résultat |
|---|---|
| CSDJ-3 (retenu installé ou avant d'installer) | le retour ATTEND, relit l'état APRÈS le verrou, voit le marqueur, REFUSE `[CSDJ3_INSTALLED]` |
| le retour (pré-vol passé, retenu avant validation) | CSDJ-3 ATTEND ; le retour est validé ; CSDJ-3 relit ses prérequis, ils ont disparu : REFUS |
| CSDJ-3 annule | le retour qui attendait s'applique sur l'état validé |
| le retour est interrompu | le verrou se libère, CSDJ-3 s'installe sur un moteur intact |

Limites : le verrou ne protège que contre un installateur qui le prend ; il n'ordonne pas l'application de v1.2 elle-même. Une attente peut être longue : l'opérateur peut poser `set lock_timeout` avant de lancer le fichier. Si Debussy utilise une autre chaîne, une autre graine ou un autre type de verrou, le retour doit être aligné AVANT tout usage (aucune exclusion sinon).

## Découverte des consommateurs du moteur (CSDJ12-RB02-CALLER-01)

PostgreSQL ne suit pas les dépendances du corps d'une fonction plpgsql ni du SQL dynamique. Le retour combine donc quatre sources et **ne prouve pas** l'absence de consommateur :

| Source | Garde | Ce qu'elle voit | Ce qu'elle ne voit pas |
|---|---|---|---|
| Métadonnées `pg_depend` vers fonctions, tables, types de ligne et colonnes du moteur (tous schémas) | `[ENGINE_DEPENDENT]` | vues, contraintes (clés étrangères), politiques RLS, valeurs par défaut, index, déclencheurs, fonctions SQL `BEGIN ATOMIC` | tout ce qui n'enregistre pas de dépendance |
| Texte de TOUTES les routines des schémas non système (mot entier, insensible à la casse), moteur exclu par OID exact | `[ENGINE_CALLER]` | appels littéraux dans plpgsql / SQL classique, y compris `resolve_fulfillment_schedule_v1` et les colonnes v1.2 | noms recomposés, SQL dynamique ; faux positifs volontaires (mention en commentaire) |
| `cron.job.command` si `pg_cron` est présent | `[CRON_JOB]` | commandes planifiées citant le moteur | commandes indirectes |
| Inventaire explicite `csdj-v1.2-engine-consumers.json` + test du dépôt | (test TypeScript) | consommateurs connus : `create_order` de CSDJ-3 (refusé par `[CSDJ3_INSTALLED]` / `[CREATE_ORDER_FINGERPRINT]`), aucun appel applicatif à ce jour | tout ce qui n'est pas inventorié |

Exclusion du moteur **vérifiée** : les 15 objets du moteur (14 fonctions créées par l'aller + `resolve_fulfillment_schedule_v1`) sont résolus par signature exacte ; l'un d'eux manquant → `[ENGINE_SURFACE]`. L'exclusion se fait par OID : une surcharge de même NOM (autre signature) n'est PAS exemptée.

### Politique pour ce que le texte ne peut pas prouver

Sont traités comme « non démontrables » : SQL dynamique (`execute`, `format`, `quote_*`, `to_regproc*`, `pg_proc`), routines dans un langage autre que SQL / plpgsql, commandes `pg_cron`, clients externes (PostgREST, fonctions edge, webhooks de base de données, autres bases).

Mécanisme d'exclusion vérifié — le **jeton de revue** :

1. Mode revue (aucune modification, finit toujours par une erreur nommée) :
   ```
   psql -v ON_ERROR_STOP=1 -c "set scanym.csdj12_rollback_mode = 'review'" -f DRAFT-...-v1-2-rollback.sql
   ```
   Le retour exécute TOUT son pré-vol (donc refuse s'il trouve un consommateur découvrable), énumère les routines dynamiques / hors SQL-plpgsql (liées au jeton) et imprime `SCANYM_ROLLBACK_REVIEW_ONLY ... jeton = <md5>`.
2. L'opérateur relit cette liste (et quiesce les clients externes : maintenance applicative, webhooks coupés).
3. Application, dans la même session :
   ```
   psql -v ON_ERROR_STOP=1 -c "set scanym.csdj12_rollback_review_token = '<jeton>'" -f DRAFT-...-v1-2-rollback.sql
   ```
   Sans jeton, ou avec un jeton périmé (une routine dynamique ajoutée ou modifiée, une commande `pg_cron` changée depuis la revue) : `[REVIEW_TOKEN]`, rien n'est modifié.

Le jeton n'est PAS une preuve d'absence de consommateur : c'est l'engagement vérifié que l'état relu est l'état appliqué. Résidu démontré par le harnais ([21c]–[21j]) : un consommateur qui recompose le nom du moteur à l'exécution échappe à l'inspection ET à `pg_depend`, est énuméré par la revue, et — si l'opérateur applique malgré tout — échoue ensuite à l'exécution.

Le mode revue est un outil d'opérateur. Dans un pipeline, la valeur du jeton ne doit pas être calculée par le même acteur automatique qui l'applique sans que la liste énumérée ait été relue.
