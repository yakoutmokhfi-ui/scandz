# V64 — Réglages Supabase requis pour le mot de passe oublié

Ce document liste les réglages à vérifier/configurer manuellement dans
le tableau de bord Supabase (Authentication → URL Configuration) avant
d'activer le flux « mot de passe oublié » du dashboard commerçant en
production. Aucune de ces actions n'est automatisée : ce fichier est
une checklist, pas un script.

## 1. Site URL

`Authentication → URL Configuration → Site URL` doit pointer vers le
domaine de production du dashboard commerçant, par exemple :

```
https://<domaine-de-production>
```

C'est la base utilisée par Supabase pour certains liens générés côté
serveur si `redirectTo` n'est pas fourni. Dans notre cas `redirectTo`
est toujours fourni explicitement par `requestPasswordReset()`
(`lib/services/auth.ts`), mais Supabase exige que ce `redirectTo` soit
présent dans la liste blanche ci-dessous.

## 2. Redirect URLs — liste blanche obligatoire

`Authentication → URL Configuration → Redirect URLs` doit inclure,
pour chaque environnement utilisé :

```
https://<domaine-de-production>/dashboard/reset-password
https://<domaine-de-staging>/dashboard/reset-password      (si applicable)
http://localhost:3000/dashboard/reset-password             (développement local)
```

L'URL exacte utilisée par le code est :

```
${window.location.origin}/dashboard/reset-password
```

(voir `requestPasswordReset()` dans `lib/services/auth.ts`). Si l'URL
appelée n'est pas dans cette liste, Supabase refuse la redirection et
renvoie une erreur — le lien envoyé par e-mail redirigera alors vers
une page d'erreur Supabase plutôt que vers le dashboard.

## 3. Durée de validité du lien de récupération

Le lien envoyé par `resetPasswordForEmail` a une durée de validité
limitée, configurable dans `Authentication → Email Templates` /
`Authentication → Providers → Email` selon la version du tableau de
bord Supabase utilisée. Vérifier que cette durée correspond à l'usage
réel (un commerçant qui ouvre sa boîte mail avec retard ne doit pas
systématiquement tomber sur un lien expiré). Aucune valeur n'est
imposée par ce document : à définir avec le produit.

## 4. Modèle d'e-mail (optionnel mais recommandé)

`Authentication → Email Templates → Reset Password` peut être
personnalisé pour porter la marque Scanym plutôt que le modèle
générique Supabase. Non bloquant pour le fonctionnement.

## 5. Vérification manuelle avant mise en production

Checklist à dérouler une fois les réglages ci-dessus effectués, sur un
compte de test dédié (jamais un compte commerçant réel) :

1. Demander une réinitialisation depuis `/dashboard/forgot-password`.
2. Ouvrir le lien reçu par e-mail : il doit arriver sur
   `/dashboard/reset-password` avec le formulaire de nouveau mot de
   passe visible (pas le message « lien invalide »).
3. Définir un nouveau mot de passe (≥ 10 caractères) : la page doit
   confirmer puis rediriger vers `/dashboard/login`.
4. Se reconnecter avec le nouveau mot de passe : doit fonctionner.
5. Réutiliser le même lien une seconde fois : doit afficher le message
   de lien invalide/expiré, pas le formulaire.
6. Attendre l'expiration du lien (ou en générer un dont la durée de
   vie est dépassée) : doit afficher le même message de lien invalide.
7. Se connecter normalement puis naviguer directement vers
   `/dashboard/reset-password` sans passer par un lien de
   récupération : doit afficher le message de lien invalide, pas le
   formulaire de nouveau mot de passe (c'est le point corrigé en V64 :
   une session ordinaire ne doit jamais suffire).

Ce fichier ne remplace pas un test réel : les points 9 et 10 du retour
d'audit V64 demandaient explicitement cette documentation en attendant
l'exécution de ces vérifications sur l'environnement réel.
