# LOT 2A.4 — Rollback : absence délibérée

## Décision

**Aucun script de rollback exécutable n'est fourni pour LOT 2A.4.**

## Justification

LOT 2A.4 est un correctif de durcissement de sécurité pur : il ne fait
que **retirer** des privilèges excessifs (`TRUNCATE`, `REFERENCES`,
`TRIGGER`) qui n'auraient jamais dû être accordés à `PUBLIC`/`anon`/
`authenticated` sur les 5 tables créées par LOT 2A.

Un rollback classique de ce correctif consisterait à **réaccorder**
ces privilèges dangereux — c'est-à-dire réintroduire délibérément la
faille de sécurité (`SEC-2A3-01`) que ce lot corrige. Ce n'est jamais
une opération légitime, quelle que soit la circonstance :

- il n'existe aucun scénario métier où `authenticated` ou `anon`
  aurait besoin de `TRUNCATE`/`REFERENCES`/`TRIGGER` sur ces tables ;
- ces privilèges n'ont jamais été intentionnels (confirmé : un
  `CREATE TABLE` + `GRANT SELECT` ordinaire, testé empiriquement dans
  un environnement PostgreSQL propre, n'accorde jamais ces trois
  privilèges par défaut) ;
- aucun test, aucun flux applicatif audité (`create_order`,
  projections publiques, Dashboard) ne dépend de leur présence.

## Ce qu'il faut faire en cas de besoin réel de « défaire » ce lot

Si un jour une raison métier réelle et documentée justifiait qu'un de
ces trois privilèges soit à nouveau nécessaire pour un rôle
applicatif (scénario non anticipé à ce jour), la démarche correcte
est :

1. documenter précisément le besoin métier ;
2. accorder **uniquement** le privilège strictement nécessaire, au
   rôle strictement nécessaire, via un nouveau correctif SQL explicite
   et audité (jamais un `GRANT ALL`) ;
3. ne jamais simplement « annuler » LOT 2A.4 dans son ensemble.

## Non-régression garantie autrement

L'absence de rollback exécutable ne réduit aucune garantie de
non-régression : LOT 2A.4 ne modifie ni données, ni policies RLS, ni
fonctions métier, ni configuration applicative — uniquement des
`REVOKE`/`GRANT SELECT` sur 5 tables. Le harnais dédié
(`supabase/tests/v82a4-privilege-check.sh`) prouve empiriquement
l'absence de régression fonctionnelle après application, et la
migration elle-même est idempotente (rejouable sans erreur), ce qui
couvre le besoin de "réappliquer" en cas de doute — jamais celui de
"défaire".
