# Retour arrière opérationnel de la reprise des notifications

Procédure proposée, à vérifier avant mise en service :

1. Désactiver la porte globale d'envoi sur **tous** les projets Vercel qui exécutent le cron, redéployer leurs configurations et attendre la fin des exécutions et des baux existants. Vérifier l'absence de travailleurs actifs.
2. Redéployer le code immédiatement antérieur au correctif, en gardant la porte d'envoi fermée.
3. Conserver les trois tables, les deux fonctions et le déclencheur de suivi des activations ainsi que leurs bornes temporelles. Les deux fonctions de reprise et de prise en charge ne sont plus appelées par le code précédent ; le déclencheur continue de suivre les changements d'activation. Ne pas supprimer les lignes de notification existantes.
4. Avant une nouvelle activation, vérifier les notifications en attente : l'ancien code peut envoyer des notifications historiques. Ne pas rouvrir la porte sans décision sur ces lignes.

Il n'y a pas de suppression d'objets SQL automatique dans cette procédure. Un redéploiement ultérieur du correctif réutilise la même borne ; ne pas rejouer la migration. Toute suppression des objets exige une procédure séparée et une décision sur l'état à conserver.
