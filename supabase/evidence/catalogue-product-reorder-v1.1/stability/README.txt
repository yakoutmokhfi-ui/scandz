CATALOGUE PRODUCT REORDER v1.1 -- STABILITÉ DE LA SUITE COMPLÈTE
================================================================

La comparaison de référence du paquet (README §6, failure-delta.json)
porte sur deux exécutions consécutives de la suite complète :

  base      412dbb5   4 778 tests   4 768 PASS   10 FAIL
  candidat  46bc04f   4 913 tests   4 903 PASS   10 FAIL   -> mêmes 10 identités

Après le scellement, la suite a été relancée sur la tête de branche
(arbre identique au candidat, hors supabase/evidence/) pour contrôle.
Ces exécutions supplémentaires ont fait apparaître des échecs
INTERMITTENTS de tests DOM préexistants, sans rapport avec ce lot. Ils
sont consignés ici plutôt que passés sous silence.

  exécution          tests   FAIL   en plus des 10 identités de la base
  -----------------  ------  -----  -------------------------------------------------
  base, run 1         4 778   10    --
  candidat 46bc04f    4 913   10    --
  tête, run 1         4 913   11    [E4] le verrou se relâche après un ÉCHEC réseau…
                                      (tests/tracking-freshness-v1-audit-remediation.dom.test.ts)
  tête, run 2         4 913   11    écran backoffice : affiche référence de commande…
                                      (tests/gap-01-withdrawal-requests-backoffice.dom.test.ts)
  BASE, run 2         4 778   12    écran backoffice : affiche référence de commande…
                                      (tests/gap-01-withdrawal-requests-backoffice.dom.test.ts)
                                    ADMIN CATALOGUE IMPORT ENTRY POINT : le lien 'Importer un catalogue'…
                                      (tests/v155-admin-catalogue-import-entry-point.dom.test.ts)

Dans les cinq exécutions, les 10 identités de la base sont présentes et
aucun test de ce lot n'échoue. Les échecs en plus :

  - sont des tests DOM à temporisation (« attendre 20 ms puis lire le
    DOM », « attendre au plus 3 s ») ;
  - sont dans des fichiers que la branche ne modifie pas (diff vide
    depuis 412dbb5), et ne testent aucun fichier modifié par ce lot ;
  - changent d'une exécution à l'autre ;
  - apparaissent AUSSI sur la base inchangée (base, run 2 : deux échecs
    intermittents, dont celui de « tête, run 2 »).

Mesure en isolement, base et tête ALTERNÉES sur la même machine, même
instant (node --experimental-strip-types --import ./tests/register.mjs
--test <fichier>) :

  tests/gap-01-withdrawal-requests-backoffice.dom.test.ts
      30 exécutions sur la base 412dbb5     : 13 en échec
      30 exécutions sur la tête de branche  : 12 en échec
  tests/tracking-freshness-v1-audit-remediation.dom.test.ts
      15 exécutions sur la base             :  0 en échec
      15 exécutions sur la tête de branche  :  0 en échec

Le test « gap-01 » échoue donc de façon intermittente, au même rythme,
avec ou sans ce lot. Le test « tracking-freshness [E4] » n'a échoué
qu'une fois, dans une exécution complète.

CONSÉQUENCE POUR UNE CONTRE-EXÉCUTION : une suite complète peut montrer
un ou deux échecs de plus que les 10 identités de la base, dans ces
fichiers ou dans un autre test DOM à temporisation. Ce n'est pas une
régression de ce lot si (1) le fichier n'est pas modifié par la branche
et (2) le test passe ou échoue de la même façon sur la base. Les trois
fichiers de test du lot (135 tests) n'ont échoué dans aucune exécution.

Fichiers :
  head-run-1.tap.gz, head-run-2.tap.gz, base-run-2.tap.gz
  *-failures-sorted.txt   identités d'échec de chacune de ces exécutions
