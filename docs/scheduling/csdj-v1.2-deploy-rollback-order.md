# CSDJ v1.2 — ordre de déploiement / retour et garde-fous (remédiation CSDJ12-DEPLOY-01 / CSDJ12-RB-02)

Ce document ne modifie PAS le contrat canonique v3.1 (blob `5d17f05a…`).

## Ordre

| Sens | Ordre |
|---|---|
| Déploiement | CSDJ-1 → **v1.2** → CSDJ-3 |
| Retour | CSDJ-3 (son propre retour) → **v1.2** → CSDJ-1 |

Le retour v1.2 REFUSE (`SCANYM_ROLLBACK_REFUSED`, 55000, avant toute modification) si :

- `[CSDJ3_INSTALLED]` : la table `public.order_fulfillment_schedule_snapshot` (marqueur du contrat §9) existe ;
- `[CREATE_ORDER_FINGERPRINT]` : `create_order(text,text,jsonb,integer,jsonb,text,text,boolean)` n'a pas exactement une surcharge, ou son corps (md5, fins de ligne normalisées en LF) ≠ `c327445751333e7908d60e6d7f838eb5` (prédécesseur pré-CSDJ-3, contrat §12.2) ;
- `[ENGINE_CALLER]` : une fonction `public` hors moteur cite une fonction ou la table de réservation du moteur.

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
