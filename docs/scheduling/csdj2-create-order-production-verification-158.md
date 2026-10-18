# CSDJ-2 / #158 — Vérifier `create_order` en Production (lecture seule) et le valider en environnement isolé

Statut : **PROCÉDURE — AUCUNE ÉTAPE N'A ÉTÉ EXÉCUTÉE PAR BOULEZ.** Le format réel de `p_customer.schedule` en Production
reste **non vérifié** (INCONCLUSIF) tant que les sorties ci-dessous ne sont pas jointes à l'issue #158.
Boulez n'a aucun accès hébergé et le mandat l'interdit : rien n'est déduit ici, tout est à lire.

## 1. Pourquoi (P1 de l'audit)

L'issue #158 rapporte que `create_order` de Production lève `P0001 SCANYM_SCHEDULE_REQUIRED`. Or :

- **aucun SQL ni TypeScript de `main` (avant la PR #160) ne contient `SCANYM_SCHEDULE_`** ;
- le contrat CSDJ v1.2 (PR #146, §12.3) rapporte que le `md5(prosrc)` de `create_order` en Production valait
  `c327445751333e7908d60e6d7f838eb5`, c'est-à-dire **la tête du dépôt (corps B5), qui ne contient aucun bloc `schedule`**.

Les deux faits ne peuvent pas être vrais en même temps pour la même base : soit Production a changé depuis cette lecture
(un bloc `schedule` y a été appliqué hors dépôt), soit l'erreur ne vient pas du corps de `create_order` (autre surcharge,
trigger, fonction appelée), soit l'incident n'a pas touché cette base. Le client livré par la PR #160 suit le contrat
v1.2 §5.1 ; **seule la définition réellement en Production dit si ce contrat est celui qui est appliqué.**

## 2. Règles de sûreté

1. Production : **uniquement des `SELECT` sur le catalogue**, dans une transaction `READ ONLY`, terminée par `ROLLBACK`.
2. **Jamais** d'appel à `create_order` sur une base hébergée, même « pour voir » : cela créerait une commande.
3. Aucune donnée marchand ni client ne quitte la base : les requêtes ci-dessous ne lisent que des définitions, des
   droits et des empreintes. Ne joindre aucune clé, aucun mot de passe, aucune URL de connexion.
4. La validation (§5) se fait **uniquement** sur une base jetable, avec des données synthétiques.
5. Qui exécute : un porteur d'accès Production (DIRAC / CTO). Qui contre-audite : Cat Turing.

## 3. Partie A — Lecture seule en Production

Session SQL (éditeur SQL du fournisseur ou `psql`), à enregistrer intégralement (sortie brute + date + identité de la base,
**sans** secret) :

```sql
begin read only;
select current_setting('transaction_read_only') as read_only;   -- attendu : on
```

**A1 — Surcharges, empreintes, attributs, droits** (même requête que le contrat §12.4, étendue à tous les noms utiles) :

```sql
select p.oid::regprocedure::text                                          as fn,
       md5(p.prosrc)                                                      as prosrc_raw,
       md5(replace(p.prosrc, chr(13)||chr(10), chr(10)))                  as prosrc_lf,
       md5(replace(pg_get_functiondef(p.oid), chr(13)||chr(10), chr(10))) as def_lf,
       p.prosecdef, p.proconfig, p.proacl::text, pg_get_userbyid(p.proowner) as owner
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_order','get_checkout_fulfillment_schedule')
order by 1;
```

**A2 — D'où vient l'erreur ?** (toutes fonctions, tous schémas non système — ne suppose pas que c'est `create_order`) :

```sql
select p.oid::regprocedure::text                         as fn,
       pg_get_userbyid(p.proowner)                       as owner,
       md5(replace(p.prosrc, chr(13)||chr(10), chr(10))) as prosrc_lf,
       (select count(*) from regexp_matches(p.prosrc, 'SCANYM_SCHEDULE_[A-Z_]+', 'g')) as occurrences
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname not in ('pg_catalog','information_schema')
  and p.prosrc like '%SCANYM_SCHEDULE_%'
order by 1;
```

**A3 — Lignes de `create_order` qui traitent le calendrier** (numéro de ligne + texte, pour lire le format réel) :

```sql
select x.n, x.line
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral regexp_split_to_table(p.prosrc, E'\n') with ordinality as x(line, n)
where n.nspname = 'public' and p.proname = 'create_order'
  and x.line ~* 'schedule|fulfillment_date|slot_key|starts_at|ends_at|selected_time|SCANYM_SCHEDULE'
order by p.oid::text, x.n;
```

**A4 — Définition complète**, pour archivage et empreinte hors ligne (sortie vers un fichier ; elle ne contient aucun secret) :

```sql
select p.oid::regprocedure::text as fn, pg_get_functiondef(p.oid) as def
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'create_order';
```
Puis, hors base : `sha256sum create_order.def.sql` et `md5sum` joints à l'issue.

**A5 — Fonctions du moteur, droits, objets associés** (existence et ACL uniquement) :

```sql
select p.oid::regprocedure::text as fn, p.prosecdef, p.proacl::text
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('resolve_fulfillment_schedule','validate_fulfillment_selection',
                    'reserve_fulfillment_capacity','release_fulfillment_capacity',
                    'checkout_schedule_statuses')
order by 1;

select to_regclass('public.order_fulfillment_schedule_snapshot') as snapshot_table;

select t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) as def
from pg_trigger t
where t.tgrelid = 'public.orders'::regclass and not t.tgisinternal
order by 1;
```

**A6 — Historique des migrations appliquées**, si la table existe (métadonnées seulement) :

```sql
select to_regclass('supabase_migrations.schema_migrations') as migrations_table;
-- si non nul :
select version, name from supabase_migrations.schema_migrations order by version desc limit 40;
```

```sql
rollback;
```

### Lecture des résultats (aucune hypothèse)

| Constat | Conclusion | Suite |
|---|---|---|
| A1 : `create_order` `prosrc_lf` = `c327445751333e7908d60e6d7f838eb5` **et** A2 vide | Cette base n'a pas de bloc `schedule` : l'erreur de l'incident **ne vient pas d'elle**. | Identifier la base réellement touchée (journaux de l'incident : projet / alias), refaire A1–A6 dessus. |
| A2 liste `create_order` | L'erreur vient de son corps. | A3 + A4 : relever le format (§4), comparer à la PR #160. |
| A2 liste une autre fonction (surcharge, wrapper, fonction appelée) | Le contrôle est ailleurs. | Relever son appelant ; refaire A3/A4 sur elle. |
| A2 liste un trigger sur `orders` (A5) | Le contrôle est dans un trigger. | Idem. |
| A1 : `create_order` différent de `c3274457…` mais A2 vide | Production a divergé du dépôt sans bloc `schedule` : la cause de l'incident est autre. | Remonter à DIRAC ; ne pas coder avant. |
| A1 : plusieurs surcharges | `supabase.rpc("create_order", {…8 clés…})` résout par noms d'arguments. | Vérifier laquelle est appelée (arité 8 attendue, §4.2 du contrat). |

## 4. Partie B — Ce qu'il faut relever dans la définition (A3 / A4)

À remplir, ligne de la définition à l'appui. Tout écart avec la colonne « implémenté par la PR #160 » se corrige **dans
`toSchedulePayload()` (`lib/checkout-schedule/model.ts`) uniquement**, pas ailleurs.

| # | Point à relever | Implémenté par la PR #160 (contrat v1.2) | Relevé en Production (ligne) |
|---|---|---|---|
| B1 | Nom de la clé dans `p_customer` | `schedule` | |
| B2 | Clés autorisées de l'objet | `date`, `slot_key`, `starts_at`, `ends_at` — rien d'autre | |
| B3 | Format de `date` | `YYYY-MM-DD` strict, jamais un horodatage | |
| B4 | Format de `starts_at` / `ends_at` | `HH:MM` strict (00–23 / 00–59), heure murale du commerçant | |
| B5 | `fixed_slots` | `slot_key` = créneau ; `starts_at`/`ends_at` = début/fin du créneau (écho) | |
| B6 | `time_within_window` | `slot_key` null ; `starts_at` = heure choisie ; `ends_at` = fin de fenêtre (écho) | |
| B7 | Date seule / `derived_earliest` | `slot_key`, `starts_at`, `ends_at` = null | |
| B8 | Clé absente ou `null` | « rien envoyé » (déclenche `REQUIRED` si une date est exigée) | |
| B9 | Mode `table` | jamais de `schedule` | |
| B10 | Codes d'erreur et SQLSTATE | `P0001`, message = code (`SCANYM_SCHEDULE_{REQUIRED,MALFORMED,UNFULFILLABLE,NOT_SELECTABLE,DATE_NOT_ELIGIBLE,SLOT_INVALID,TIME_INVALID,SLOT_FULL,NOT_OFFERED}`) | |
| B11 | Fuseau / « maintenant » | horloge du serveur, fuseau du commerçant ; le client n'envoie aucune heure courante | |

Charges **produites par le code de la PR** (exemples exacts, verrouillés par un test pour ne pas dériver de ce document) :

| Politique | `p_customer.schedule` |
|---|---|
| `fixed_slots` | `{"date":"2026-10-20","slot_key":"afternoon","starts_at":"14:00","ends_at":"18:00"}` |
| date seule / `derived_earliest` | `{"date":"2026-10-22","slot_key":null,"starts_at":null,"ends_at":null}` |
| `time_within_window` | `{"date":"2026-10-20","slot_key":null,"starts_at":"09:30","ends_at":"10:30"}` |

## 5. Partie C — Validation sur une base jetable

**Jamais sur une base hébergée.** Objectif : exécuter la **vraie** définition de Production (A4) contre les charges de la PR,
sans toucher à aucune donnée réelle.

1. **Base jetable PostgreSQL 16** (conteneur local ou instance Supabase locale) :
   `docker run --rm -e POSTGRES_PASSWORD=<mot de passe jetable> -p 54329:5432 postgres:16`.
2. **Schéma** — au choix, de la plus à la moins sûre :
   a. rejouer la chaîne de migrations du dépôt (celle du contrat §12.2 : PSM/VAT → B1 → B234 → B5 → CSDJ-1 → v1.2),
      **puis** remplacer `create_order` par la définition A4 reçue de Production, verbatim ;
   b. si DIRAC l'autorise, restaurer un export **schéma seul** (`pg_dump --schema-only --no-owner`) — jamais les données.
   Vérifier ensuite que `md5(replace(prosrc, CRLF, LF))` de la base jetable égale celui de la Partie A.
3. **Données synthétiques uniquement** : un établissement fictif actif, un mode `pickup` activé, un article, et une
   planification `customer_selectable` en `fixed_slots` (matin 09:00–12:00, après-midi 14:00–18:00), créés par les
   fonctions du dépôt ou par `insert` directs sur la base jetable. Aucun identifiant ni texte d'un vrai commerçant.
4. **Dates réelles du lecteur, pas inventées** : appeler d'abord `get_checkout_fulfillment_schedule(<établissement>, 'pickup')`
   sur la base jetable et utiliser les dates et créneaux **qu'il renvoie** (`D` = première date éligible).
5. **Exécuter chaque cas dans sa transaction, sous le rôle public, avec `ROLLBACK`** :

```sql
begin;
set local role anon;
do $$
declare v_state text; v_msg text;
begin
  begin
    perform * from public.create_order(
      'slug-fictif', 'pickup',
      '[{"menu_item_id":"<uuid article>","quantity":1,"option_item_id":null}]'::jsonb,
      null,
      jsonb_build_object('name','Test','phone','0612345678',
        'schedule', '<CHARGE DU CAS>'::jsonb),     -- omettre la clé pour M2
      null, 'fr', false);
    raise notice 'Mx => OK';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise notice 'Mx => % / %', sqlstate, v_msg;
  end;
end $$;
rollback;
```

### Matrice de validation

« Attendu » = ce que le contrat v1.2 prédit. **Ce n'est pas une preuve** : la colonne « Observé » est à remplir à partir de
la base jetable ; en cas d'écart, la définition de Production fait foi et seul `toSchedulePayload()` change.

| # | Cas | Charge `schedule` | Attendu (contrat) | Observé |
|---|---|---|---|---|
| M1 | Créneau offert par le lecteur | charge `fixed_slots` du §4 avec les valeurs du lecteur | commande acceptée | |
| M2 | Clé `schedule` absente (**incident #158**) | — | `P0001 SCANYM_SCHEDULE_REQUIRED` | |
| M3 | `schedule: null` | `null` | `P0001 SCANYM_SCHEDULE_REQUIRED` | |
| M4 | Date seule alors que `fixed_slots` | `{"date":D,"slot_key":null,"starts_at":null,"ends_at":null}` | refus typé (relever lequel) | |
| M5 | Date non offerte | `date` = D + 1 an | `SCANYM_SCHEDULE_DATE_NOT_ELIGIBLE` | |
| M6 | Créneau inconnu | `slot_key` = `"inconnu"` | `SCANYM_SCHEDULE_SLOT_INVALID` | |
| M7 | Écho différent | `starts_at` = `"14:01"` pour le créneau 14:00 | `SCANYM_SCHEDULE_SLOT_INVALID` | |
| M8 | Clé en trop | `{…, "x": 1}` | `SCANYM_SCHEDULE_MALFORMED` | |
| M9 | Heure non stricte | `starts_at` = `"14:00:00"` | refus typé (relever lequel) | |
| M10 | Mode `table` avec `schedule` | charge M1, `p_service_mode` = `table` | relever le comportement (ignoré ou refusé) | |
| M11 | Établissement **sans** calendrier, sans `schedule` | — | commande acceptée (non-régression des autres marchands) | |
| M12 | `time_within_window` / `derived_earliest`, si configurés | charges du §4 | commande acceptée | |

## 6. Rapprochement avec les erreurs du 15 octobre (lecture seule — à remplir par DIRAC / CTO)

L'incident rapporte **4 réponses HTTP 400, `P0001`, `SCANYM_SCHEDULE_REQUIRED`, le 15 octobre**. Les sorties A1–A6 ne prouvent
rien tant qu'elles ne sont pas rapprochées de ces quatre événements : une définition correcte sur la **mauvaise base** ne dit rien
de la base touchée. Ce rapprochement ne demande **aucune écriture, aucun appel à `create_order`, aucune donnée client**.

**R1 — Relever les 4 événements dans les journaux du fournisseur (consultation seule).** Pour chacun, ne noter que :
horodatage UTC, hôte / identifiant du projet qui a reçu la requête, chemin (`/rest/v1/rpc/create_order` attendu), statut (400),
code et message d'erreur (`P0001` / `SCANYM_SCHEDULE_REQUIRED`), et **les noms des clés** du corps (jamais les valeurs :
ni nom, ni téléphone, ni adresse). Question à trancher pour chaque événement : `p_customer` portait-il une clé `schedule` ?

**R2 — Identifier la base réellement touchée.** Comparer l'hôte / l'identifiant relevé en R1 à celui de la base interrogée pour
A1–A6 (même projet, même environnement). Relever séparément l'hôte configuré dans l'hébergement du client déployé (le nom de la
variable `NEXT_PUBLIC_SUPABASE_URL` et la partie hôte seulement, sans clé). Trois bases peuvent exister (Production, Preview,
disponible localement) : A1–A6 doivent avoir été lus sur celle de R1.

**R3 — Identifier le client qui a émis la requête.** Relever la révision déployée au moment des 4 événements (identifiant de
déploiement et SHA). Avant la PR #160, `main` n'envoie jamais `schedule` : un `REQUIRED` est donc le comportement attendu d'une
définition qui exige la date, et **non** la preuve d'un défaut du serveur. La PR #160 n'est pas déployée.

**R4 — Rapprocher.** Remplir ce tableau avec les sorties, sans interprétation :

| # | Fait relevé | Source | Valeur observée | Valeur attendue si le contrat v1.2 §5.1 s'applique |
|---|---|---|---|---|
| 1 | Base qui a reçu les 4 requêtes (R1) | journaux | | identique à celle de R2 |
| 2 | Base lue pour A1–A6 | session SQL | | identique à la ligne 1 |
| 3 | `prosrc_lf` de `create_order` (A1) | A1 | | différent de `c327445751333e7908d60e6d7f838eb5` (sinon pas de bloc `schedule`) |
| 4 | Fonctions contenant `SCANYM_SCHEDULE_` (A2) | A2 | | `create_order` (ou l'appelée citée en A2) |
| 5 | Codes présents dans le corps (A3/A4) | A3/A4 | | les 9 codes du contrat, mêmes classes |
| 6 | Existence et droits de `get_checkout_fulfillment_schedule` (A1) | A1 | | présente, exécutable par le rôle du client (`anon`) |
| 7 | Une seule surcharge de `create_order` à 8 arguments (A1) | A1 | | oui |
| 8 | Clé `schedule` dans les 4 corps (R1) | journaux | | absente (client de `main`) |
| 9 | Révision du client au moment des événements (R3) | hébergement | | antérieure à la PR #160 |

**R5 — Lire le résultat (aucune conclusion hors de ce tableau).**

| Constat | Conclusion permise | Suite |
|---|---|---|
| Lignes 1 = 2, ligne 4 vide pour `create_order`, ligne 3 = `c3274457…` | La base touchée n'a pas de bloc `schedule` : **l'incident ne vient pas de cette définition**. | Chercher l'autre fonction / trigger (A2, A5) ou une autre base. P1 **non clos**. |
| Lignes 1 ≠ 2 | A1–A6 ont été lus sur la mauvaise base. | Refaire A1–A6 sur la base de la ligne 1. P1 **non clos**. |
| Ligne 4 = `create_order`, ligne 5 conforme, ligne 8 « absente » | Le serveur applique bien le contrat v1.2 et le client de `main` ne l'envoyait pas : cohérent avec l'incident. | Poursuivre la matrice M1–M12 (§5). |
| Ligne 5 non conforme (code, classe ou format) | Le serveur n'applique pas le contrat que la PR #160 suppose. | Ne pas fusionner ; corriger `toSchedulePayload()` après lecture de A3/A4, retester, refaire M1–M12. |
| Ligne 6 : `get_checkout_fulfillment_schedule` absente ou non exécutable par le client | **Avec la PR #160, le retrait et la livraison avec code postal ne pourraient plus être envoyés** (l'erreur de lecture ferme l'envoi, par conception). | Décision CIO / DIRAC avant tout déploiement : déployer le lecteur d'abord, ou ne pas déployer le client. |
| Ligne 8 : `schedule` présent dans un des 4 corps | Un autre client ou une version non prévue envoie déjà `schedule`. | Relever son format et le comparer à `toSchedulePayload()` avant toute conclusion. |

Tant que ce tableau n'est pas rempli **et** que la matrice M1–M12 n'a pas été observée sur base jetable, le P1 reste
**INCONCLUSIF**. Boulez ne remplit aucune cellule : il n'a accès ni aux journaux ni à la base hébergée.

## 7. Critères de sortie

- **P1 levé** si : A1–A6 joints, §6 (rapprochement R1–R5) rempli, §4 rempli avec les lignes de la définition, M1–M12 observés sur base jetable et
  conformes — ou, en cas d'écart, `toSchedulePayload()` corrigé, retesté (`tests/csdj2-checkout-schedule-158.test.ts`) et
  la matrice refaite.
- **Reste INCONCLUSIF** tant que l'une de ces sorties manque. Un Preview authentifié ou une transaction réelle
  ne remplacent pas cette procédure (et sont interdits sans GO CIO).
- Rien dans cette procédure n'active le retrait en Production ni ne modifie une donnée hébergée.
